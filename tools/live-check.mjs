/**
 * Live provider check.
 *
 * Mounts the host half in-process against the settings document the running app
 * already wrote, then drives its routes through a local HTTP server. This
 * exercises the real provider with the real key — the same path the settings
 * page's buttons use — without restarting DeepSeek Harness.
 *
 * The API key is read from the document and never printed.
 *
 * Run: node tools/live-check.mjs
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../lib/index.js')

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const settingsFile = join(home, 'text-manager', 'settings.json')

let stored
try {
  stored = JSON.parse(readFileSync(settingsFile, 'utf8'))
} catch (error) {
  console.error(`cannot read ${settingsFile}: ${String(error?.message ?? error)}`)
  process.exit(1)
}

console.log(`settings: ${settingsFile}`)
console.log(`  baseUrl=${stored.baseUrl}  model=${stored.model}  thinking=${stored.thinking}`)
console.log(`  apiKey=${stored.apiKey ? `${stored.apiKey.slice(0, 6)}… (${stored.apiKey.length} chars)` : '(none)'}`)
console.log('')

/** Routes the host half registers. */
const routes = []
apply({
  logger: { info() {}, warn: (message) => console.warn(`  [host warn] ${message}`), error() {} },
  effect: (fn) => { fn(); return () => {} },
  webServer: { register(route) { routes.push(route); return () => {} } }
}, { dshHome: home })

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const route = routes.find(candidate => candidate.kind === 'prefix'
    ? pathname.startsWith(candidate.path)
    : pathname === candidate.path)
  if (route === undefined) {
    response.writeHead(404).end()
    return
  }
  void route.handler(request, response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/text-manager/api`

/** Call one route. */
async function call(method, body) {
  const response = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  return { status: response.status, body: await response.json() }
}

console.log('settings.get')
const current = await call('settings.get')
console.log(`  ${current.status}  version=${current.body.settings?.pluginVersion}  apiKeySet=${current.body.settings?.apiKeySet}`)
console.log(`  autoExpand=${current.body.settings?.autoExpand}  cachedModels=${JSON.stringify(current.body.settings?.cachedModels)}`)

console.log('\nsettings.reveal')
const revealed = await call('settings.reveal')
console.log(`  ${revealed.status}  key returned: ${revealed.body.apiKey === stored.apiKey ? 'matches the document' : 'MISMATCH'}`)

console.log('\nmodels.list  (GET /v1/models against the real endpoint)')
const models = await call('models.list')
if (models.status === 200) {
  console.log(`  ${models.status}  ${models.body.models.length} model(s): ${models.body.models.slice(0, 12).join(', ')}${models.body.models.length > 12 ? ', …' : ''}`)
} else {
  console.log(`  ${models.status}  ${models.body.error?.code}: ${models.body.error?.message}`)
}

console.log('\ntest.translate  (the settings page self-test, against the real provider)')
const probe = await call('test.translate', {
  text: [
    'Let me look at the failing assertion again before I touch the parser.',
    '',
    'The tokenizer drops trailing whitespace, so the expected column index is off by one.'
  ].join('\n')
})
if (probe.status === 200) {
  console.log(`  ${probe.status}  model=${probe.body.model}  thinking=${probe.body.thinking}  apiRoot=${probe.body.apiRoot}  ${probe.body.ms}ms`)
  console.log(`  --- ${JSON.stringify(probe.body.translation.slice(0, 200))}`)
} else {
  console.log(`  ${probe.status}  ${probe.body.error?.code}: ${probe.body.error?.message}`)
}

console.log('\ntranslate  (one real segment through the live route)')
const one = await call('translate', { text: 'The tokenizer drops trailing whitespace.' })
console.log(`  ${one.status}  skipped=${one.body.skipped}  text=${JSON.stringify(String(one.body.text ?? '').slice(0, 120))}`)

// ── the three behaviours this pass added ────────────────────────────────────
console.log('\nnew-vs-history: a lookup-only probe must never spend')
const probeText = `A brand new paragraph seen for the first time at ${new Date().toISOString()}`
const miss = await call('translate', { text: probeText, provider: false })
console.log(`  ${miss.status}  missing=${miss.body.missing}  cached=${miss.body.cached}  (no provider call was made)`)

console.log('\nfixed translations: translate once, then replay for free')
const first = await call('translate', { text: probeText })
console.log(`  first   cached=${first.body.cached}  text=${JSON.stringify(String(first.body.text ?? '').slice(0, 90))}`)
const replay = await call('translate', { text: probeText, provider: false })
console.log(`  replay  cached=${replay.body.cached}  same=${replay.body.text === first.body.text}  (restarting the app takes this path)`)

console.log('\nrefresh: force re-translates and overwrites')
const refreshed = await call('translate', { text: probeText, force: true })
console.log(`  ${refreshed.status}  cached=${refreshed.body.cached}  text=${JSON.stringify(String(refreshed.body.text ?? '').slice(0, 90))}`)

const after = await call('settings.get')
console.log(`\nstore: ${after.body.settings.translationCount} segment(s) in ${after.body.settings.translationsFile}`)
console.log(`settings: includeHistory=${after.body.settings.includeHistory}  autoExpand=${after.body.settings.autoExpand}`)

server.close()

