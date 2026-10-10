/**
 * Host-half integration test.
 *
 * Runs `lib/index.js` against a fake Cordis context, a real HTTP server that
 * dispatches to the plugin's registered route exactly as `dsh-host-webserver`
 * would, and a mock DeepSeek endpoint. No Harness process and no network are
 * involved, so the route contract, the fence, settings persistence, the
 * provider request shape, caching and error mapping are all exercised here.
 *
 * Run: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../lib/index.js')

/** Collected assertion results. */
const results = []
/** @param name - the check's name. @param fn - the check body. */
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read a request body as text. */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// ── mock DeepSeek endpoint ──────────────────────────────────────────────────
/** Every request the mock provider received. */
const seen = []
let providerMode = 'ok'
/** Which envelope the mock model directory answers in. */
let modelsShape = 'openai'
/** Scripted statuses consumed one per chat request before the canned success. */
const providerScript = []
/** The envelopes `/models` is exercised with. */
const MODEL_SHAPES = ['openai', 'bare', 'ollama', 'ids']
const provider = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://provider.internal')
  if (request.method === 'GET' && url.pathname.endsWith('/models')) {
    seen.push({ url: request.url, headers: request.headers, body: null })
    if (providerMode === 'unauthorized') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }
    const ids = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']
    const envelope = modelsShape === 'openai' ? { object: 'list', data: ids.map(id => ({ id, object: 'model' })) }
      : modelsShape === 'bare' ? ids.map(id => ({ id }))
        : modelsShape === 'ollama' ? { models: ids.map(name => ({ name })) }
          : { data: ids }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(envelope))
    return
  }
  const body = JSON.parse((await readBody(request)) || '{}')
  seen.push({ url: request.url, headers: request.headers, body })
  const scripted = providerScript.shift()
  if (scripted !== undefined) {
    response.writeHead(scripted, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `scripted ${scripted}` } }))
    return
  }
  if (providerMode === 'unauthorized') {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    choices: [{ message: { content: `【译】${String(body.messages.at(-1).content).slice(0, 40)}` } }]
  }))
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
const providerPort = provider.address().port

// ── fake webserver ──────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
/** Routes the plugin registered. */
const routes = []
const context = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    }
  }
}

apply(context, { dshHome: home })

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

/**
 * Call one plugin route method.
 * @param method - route method name.
 * @param body - JSON body.
 * @param options - `{ method, headers }` overrides.
 * @returns the status and parsed payload.
 */
async function call(method, body, options = {}) {
  const response = await fetch(`${base}/${method}`, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.method === 'GET' ? undefined : JSON.stringify(body ?? {})
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

console.log(`\nhost half integration (home=${home}, provider=:${providerPort})\n`)

await test('settings.get returns the defaults without a key', async () => {
  const { status, body } = await call('settings.get')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.settings.apiKeySet, false)
  assert.equal(body.settings.model, 'deepseek-chat')
  assert.equal(body.settings.thinking, 'auto')
  assert.equal(body.settings.settingsFile, join(home, 'text-manager', 'settings.json'))
})

await test('translate refuses without a key', async () => {
  const { status, body } = await call('translate', { text: 'Let me check the build output first.' })
  assert.equal(status, 400)
  assert.equal(body.error.code, 'no-api-key')
})

await test('settings.update stores the key and never echoes it back', async () => {
  const { status, body } = await call('settings.update', {
    settings: { apiKey: 'sk-test-1234567890abcdef', baseUrl: `http://127.0.0.1:${providerPort}` }
  })
  assert.equal(status, 200)
  assert.equal(body.settings.apiKeySet, true)
  assert.match(body.settings.apiKeyMask, /^sk-tes\*+cdef$/)
  assert.equal(body.settings.apiKey, undefined)

  const again = await call('settings.get')
  assert.equal(again.body.settings.apiKeySet, true)
  assert.equal(again.body.settings.apiKey, undefined)

  const document = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.equal(document.apiKey, 'sk-test-1234567890abcdef')
})

await test('translate calls the provider and returns the translation', async () => {
  seen.length = 0
  const { status, body } = await call('translate', { text: 'First paragraph of reasoning.\n\nSecond paragraph.' })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.skipped, false)
  assert.equal(body.cached, false)
  assert.match(body.text, /^【译】/)

  assert.equal(seen.length, 1)
  const request = seen[0]
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer sk-test-1234567890abcdef')
  assert.equal(request.headers['content-type'], 'application/json')
  assert.equal(request.body.model, 'deepseek-chat')
  assert.equal(request.body.stream, false)
  assert.equal(request.body.thinking, undefined, 'thinking must be omitted in auto mode')
  assert.equal(request.body.messages.length, 2)
  assert.equal(request.body.messages[1].content, 'First paragraph of reasoning.\n\nSecond paragraph.')
  assert.match(request.body.messages[0].content, /Simplified Chinese/)
})

await test('identical text is served from the cache', async () => {
  seen.length = 0
  const { body } = await call('translate', { text: 'First paragraph of reasoning.\n\nSecond paragraph.' })
  assert.equal(body.cached, true)
  assert.equal(seen.length, 0)
})

await test('thinking=off sends thinking.type=disabled', async () => {
  await call('settings.update', { settings: { thinking: 'off' } })
  seen.length = 0
  await call('translate', { text: 'A distinct sentence for the thinking-off probe.' })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].body.thinking, { type: 'disabled' })
})

await test('thinking=on sends thinking.type=enabled', async () => {
  await call('settings.update', { settings: { thinking: 'on' } })
  seen.length = 0
  await call('translate', { text: 'A distinct sentence for the thinking-on probe.' })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].body.thinking, { type: 'enabled' })
  await call('settings.update', { settings: { thinking: 'auto' } })
})

await test('onlyEnglish skips Chinese input without calling the provider', async () => {
  seen.length = 0
  const { status, body } = await call('translate', { text: '我先检查一下构建输出，然后再决定下一步怎么做。' })
  assert.equal(status, 200)
  assert.equal(body.skipped, true)
  assert.equal(body.text, '')
  assert.equal(seen.length, 0)
})

await test('onlyEnglish=false translates Chinese input too', async () => {
  await call('settings.update', { settings: { onlyEnglish: false } })
  seen.length = 0
  const { body } = await call('translate', { text: '我先检查一下构建输出。' })
  assert.equal(body.skipped, false)
  assert.equal(seen.length, 1)
  await call('settings.update', { settings: { onlyEnglish: true } })
})

// ── the durable store: lookup-only mode, refresh, persistence ───────────────
await test('a lookup-only pass reports a miss without spending', async () => {
  seen.length = 0
  const { status, body } = await call('translate', { text: 'A historical paragraph nobody has translated.', provider: false })
  assert.equal(status, 200)
  assert.equal(body.missing, true)
  assert.equal(body.text, '')
  assert.equal(seen.length, 0, 'the provider must not be reached')
})

await test('a lookup-only pass replays what the store already has', async () => {
  seen.length = 0
  const first = await call('translate', { text: 'A paragraph that gets stored once.' })
  assert.equal(first.body.cached, false)
  assert.equal(seen.length, 1)

  seen.length = 0
  const replay = await call('translate', { text: 'A paragraph that gets stored once.', provider: false })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.cached, true)
  assert.equal(replay.body.text, first.body.text)
  assert.equal(seen.length, 0, 'a stored segment costs nothing to replay')
})

await test('force overwrites the stored translation', async () => {
  const text = 'A paragraph we will refresh on purpose.'
  const first = await call('translate', { text })
  assert.equal(first.body.cached, false)

  const again = await call('translate', { text })
  assert.equal(again.body.cached, true)

  seen.length = 0
  const forced = await call('translate', { text, force: true })
  assert.equal(seen.length, 1, 'a refresh must reach the provider')
  assert.equal(forced.body.cached, false)
  assert.equal(forced.body.text, first.body.text, 'the mock returns the same canned text')

  const after = await call('translate', { text, provider: false })
  assert.equal(after.body.cached, true)
})

await test('the store survives a restart and is read from disk', async () => {
  const text = 'A paragraph that must outlive the process.'
  await call('translate', { text })

  // The write is debounced; give it its window, then expect the document.
  await new Promise(resolve => setTimeout(resolve, 1800))
  const document = JSON.parse(readFileSync(join(home, 'text-manager', 'translations.json'), 'utf8'))
  assert.equal(document.version, 1)
  assert.ok(document.entries.length >= 1)
  assert.ok(document.entries.every(entry => typeof entry.k === 'string' && typeof entry.t === 'string'))

  // A second mount with the same home loads that document: the segment is
  // answered from disk with no provider traffic at all.
  const fresh = []
  apply({
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => { fn(); return () => {} },
    webServer: { register(route) { fresh.push(route); return () => {} } }
  }, { dshHome: home })
  const restarted = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    void fresh.find(candidate => pathname.startsWith(candidate.path)).handler(request, response)
  })
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve))
  seen.length = 0
  const response = await fetch(`http://127.0.0.1:${restarted.address().port}/text-manager/api/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, provider: false })
  })
  const body = await response.json()
  await new Promise(resolve => restarted.close(resolve))

  assert.equal(body.cached, true, 'a restart must replay, not re-translate')
  assert.equal(seen.length, 0)
})

await test('includeHistory round-trips through the settings document', async () => {
  assert.equal((await call('settings.get')).body.settings.includeHistory, false)
  assert.equal((await call('settings.update', { settings: { includeHistory: true } })).body.settings.includeHistory, true)
  const document = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.equal(document.includeHistory, true)
  await call('settings.update', { settings: { includeHistory: false } })
})

await test('translateProse defaults on and round-trips', async () => {
  assert.equal((await call('settings.get')).body.settings.translateProse, true, 'interleaved text is translated by default')
  assert.equal((await call('settings.update', { settings: { translateProse: false } })).body.settings.translateProse, false)
  const stored = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.equal(stored.translateProse, false)
  await call('settings.update', { settings: { translateProse: true } })
})

await test('settings.get reports how many segments are stored', async () => {
  const { body } = await call('settings.get')
  assert.ok(body.settings.translationCount >= 1)
  assert.ok(body.settings.translationsFile.endsWith('translations.json'))
})

await test('a provider rejection maps to the provider status', async () => {
  providerMode = 'unauthorized'
  const { status, body } = await call('translate', { text: 'A sentence that will meet a 401.' })
  providerMode = 'ok'
  assert.equal(status, 401)
  assert.equal(body.error.code, 'provider-401')
  assert.match(body.error.message, /invalid api key/)
})

// ── retry with backoff ──────────────────────────────────────────────────────
await test('a rate limit is retried and the segment still lands', async () => {
  seen.length = 0
  providerScript.push(429, 429) // two throttles, then the canned success
  const { status, body } = await call('translate', { text: 'A sentence that meets two rate limits.' })
  assert.equal(status, 200, 'the retry must rescue it')
  assert.equal(body.cached, false)
  assert.match(body.text, /^【译】/)
  assert.equal(seen.length, 3, 'two failures plus the successful attempt')
})

await test('a transient 5xx is retried too', async () => {
  seen.length = 0
  providerScript.push(503)
  const { status } = await call('translate', { text: 'A sentence that meets one bad gateway.' })
  assert.equal(status, 200)
  assert.equal(seen.length, 2)
})

await test('a bad key is not retried', async () => {
  seen.length = 0
  providerMode = 'unauthorized'
  const { status } = await call('translate', { text: 'A sentence that must fail fast.' })
  providerMode = 'ok'
  assert.equal(status, 401)
  assert.equal(seen.length, 1, 'retrying a 401 would only waste quota')
})

await test('a persistent failure surfaces after the attempt cap', async () => {
  seen.length = 0
  providerScript.push(500, 500, 500, 500)
  const { status, body } = await call('translate', { text: 'A sentence that never succeeds.' })
  assert.equal(status, 502)
  assert.equal(body.error.code, 'provider-500')
  assert.equal(seen.length, 3, 'the attempt cap bounds the retries')
})

await test('the style document round-trips and is persisted', async () => {
  assert.deepEqual((await call('settings.get')).body.settings.textStyle,
    { enabled: false, live: true, targets: {} }, 'the style module starts off, previewing live')
  const payload = {
    enabled: true,
    live: false,
    targets: { body: { preset: 'large', options: { size: 16 } } }
  }
  const updated = await call('settings.update', { settings: { textStyle: payload } })
  assert.deepEqual(updated.body.settings.textStyle, payload)
  const stored = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.deepEqual(stored.textStyle, payload, 'the style document lands in the settings file')
  assert.equal(updated.body.settings.enabled, true, 'and the translation module is untouched by it')
})

await test('a hostile style document is coerced, never trusted', async () => {
  const updated = await call('settings.update', {
    settings: {
      textStyle: {
        enabled: 'yes',
        live: 1,
        targets: {
          body: {
            preset: 'x'.repeat(200),
            options: { size: 'big', keep: 12, ok: true, drop: { nested: 1 }, long: 'y'.repeat(500) }
          },
          '': { preset: 'default' },
          good: { preset: 'card', options: { radius: 8 } }
        }
      }
    }
  })
  const style = updated.body.settings.textStyle
  assert.equal(style.enabled, false, 'a non-boolean flag falls back to the default')
  assert.equal(style.live, true)
  assert.equal(style.targets.body.preset.length, 32, 'a preset name is clipped')
  assert.deepEqual(style.targets.body.options,
    { size: 'big', keep: 12, ok: true },
    'short primitives survive; a nested object and an over-long string are dropped')
  assert.equal(style.targets[''], undefined, 'an empty target key is dropped')
  assert.deepEqual(style.targets.good, { preset: 'card', options: { radius: 8 } },
    'a well-formed target is kept verbatim')
})

await test('a segment with no prose in it is skipped, not translated', async () => {
  // The tail of a Chinese answer is often just file links. It read as "not
  // Chinese", so it was sent, and the same ASCII came back as the "translation" —
  // which put a pointless block under the answer and cost a request.
  const links = '- [lib/client.js:379](DSH-Homemade-Plugins/dsh-text-manager/lib/client.js:379), '
    + '[test/client.test.mjs](DSH-Homemade-Plugins/dsh-text-manager/test/client.test.mjs), '
    + '[tools/make-style-preview.mjs](DSH-Homemade-Plugins/dsh-text-manager/tools/make-style-preview.mjs)'
  seen.length = 0
  const skipped = await call('translate', { text: links })
  assert.equal(skipped.body.skipped, true, 'paths and links have nothing to translate')
  assert.equal(skipped.body.reason, 'structural')
  assert.equal(seen.length, 0, 'and nothing reaches the provider')

  // A leftover scripted status from the retry tests would turn this into two
  // requests, so the queue is cleared first.
  providerScript.length = 0
  const prose = await call('translate', { text: 'Let me check the build output before I touch the parser.' })
  assert.notEqual(prose.body.skipped, true, 'real prose is still translated')
  assert.match(prose.body.text, /^【译】/)
  assert.equal(seen.length, 1)
})

await test('a short segment is never mistaken for structure', async () => {
  // Below the length threshold the rule stands down: a brief tail like this may
  // still be worth translating.
  providerScript.length = 0
  seen.length = 0
  const { body } = await call('translate', { text: 'Done.' })
  assert.notEqual(body.skipped, true, 'short text is judged only by its language')
  assert.equal(seen.length, 1)
})

await test('a conversation can override the plugin switch in both directions', async () => {
  // The point of the per-conversation switch: 开启 keeps translating while the
  // plugin is off, 关闭 stays quiet while the plugin is on.
  const id = 'session-abc-123'
  assert.equal((await call('session.get', { sessionId: id })).body.mode, null, 'absent means follow')

  await call('session.set', { sessionId: id, mode: 'on' })
  assert.equal((await call('session.get', { sessionId: id })).body.mode, 'on')
  const table = JSON.parse(readFileSync(join(home, 'text-manager', 'sessions.json'), 'utf8'))
  assert.equal(table.sessions[id], 'on', 'the choice is persisted for the next run')

  providerScript.length = 0
  seen.length = 0
  await call('settings.update', { settings: { enabled: false } })
  const skipped = await call('translate', { text: 'Let me check the build output first.', sessionId: 'session-other' })
  assert.equal(skipped.body.skipped, true, 'a conversation that follows an off plugin is skipped')
  assert.equal(seen.length, 0, 'without asking the provider')
  const forced = await call('translate', { text: 'Let me check the build output first.', sessionId: id })
  assert.notEqual(forced.body.skipped, true, 'but the opted-in conversation is translated anyway')
  assert.match(forced.body.text, /^【译】/)
  assert.equal(seen.length, 1)

  await call('settings.update', { settings: { enabled: true } })
  await call('session.set', { sessionId: id, mode: 'off' })
  seen.length = 0
  const muted = await call('translate', { text: 'Let me check the build output before the parser.', sessionId: id })
  assert.equal(muted.body.skipped, true, 'a conversation switched off stays quiet')
  assert.equal(seen.length, 0)
  const fresh = await call('translate', { text: 'Let me check the build output before the parser.', sessionId: 'session-other' })
  assert.notEqual(fresh.body.skipped, true, 'while its neighbours are unaffected')

  await call('session.set', { sessionId: id, mode: null })
  assert.equal((await call('session.get', { sessionId: id })).body.mode, null, 'and it can go back to following')
  const cleared = JSON.parse(readFileSync(join(home, 'text-manager', 'sessions.json'), 'utf8'))
  assert.equal(cleared.sessions[id], undefined)
})

await test('the per-conversation table refuses junk', async () => {
  assert.equal((await call('session.set', { sessionId: 'has spaces', mode: 'on' })).status, 400)
  assert.equal((await call('session.set', { sessionId: 'ok-id', mode: 'maybe' })).status, 400)
  assert.equal((await call('session.set', { mode: 'on' })).status, 400)
  assert.equal((await call('session.get', { sessionId: 'not a session' })).body.mode, null,
    'an unusable id simply follows the plugin switch')
})

await test('cutMode defaults to balanced and round-trips', async () => {
  assert.equal((await call('settings.get')).body.settings.cutMode, 'balanced')
  assert.equal((await call('settings.update', { settings: { cutMode: 'block' } })).body.settings.cutMode, 'block')
  const stored = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.equal(stored.cutMode, 'block')
  // Anything unrecognised falls back rather than breaking the client.
  assert.equal((await call('settings.update', { settings: { cutMode: 'nonsense' } })).body.settings.cutMode, 'balanced')
})

await test('oversized text is clipped to maxSegmentChars', async () => {
  await call('settings.update', { settings: { maxSegmentChars: 200 } })
  seen.length = 0
  const long = 'word '.repeat(400)
  const { body } = await call('translate', { text: long })
  assert.equal(body.clipped, true)
  assert.equal(seen[0].body.messages[1].content.length, 200)
  await call('settings.update', { settings: { maxSegmentChars: 1800 } })
})

await test('enabled=false stops translation', async () => {
  await call('settings.update', { settings: { enabled: false } })
  const { body } = await call('translate', { text: 'This should be skipped entirely.' })
  assert.equal(body.skipped, true)
  await call('settings.update', { settings: { enabled: true } })
})

await test('unknown methods and wrong verbs are refused', async () => {
  assert.equal((await call('nope', {})).status, 404)
  assert.equal((await call('settings.get', undefined, { method: 'GET' })).status, 405)
})

await test('a cross-site browser marker is fenced out', async () => {
  const { status, body } = await call('settings.get', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(status, 403)
  assert.equal(body.error.code, 'forbidden')
})

await test('test probes the provider and reports the reply', async () => {
  const { status, body } = await call('test')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.match(body.reply, /^【译】/)
  assert.equal(body.model, 'deepseek-chat')
})

await test('settings.reveal hands back the stored key', async () => {
  const { status, body } = await call('settings.reveal')
  assert.equal(status, 200)
  assert.equal(body.apiKey, 'sk-test-1234567890abcdef')
})

await test('settings.reveal is still fenced', async () => {
  const { status } = await call('settings.reveal', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(status, 403)
})

await test('models.list understands every envelope and remembers the list', async () => {
  const expected = ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner']
  for (const shape of MODEL_SHAPES) {
    modelsShape = shape
    seen.length = 0
    const { status, body } = await call('models.list')
    assert.equal(status, 200, `shape ${shape}`)
    assert.deepEqual(body.models, expected, `shape ${shape}`)
    assert.equal(seen.length, 1, `shape ${shape}`)
    assert.equal(seen[0].url, '/v1/models', `shape ${shape}`)
    assert.equal(seen[0].headers.authorization, 'Bearer sk-test-1234567890abcdef')
  }
  modelsShape = 'openai'
  const stored = await call('settings.get')
  assert.deepEqual(stored.body.settings.cachedModels, expected)
  const document = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.deepEqual(document.cachedModels, expected)
})

await test('models.list refuses without a key and surfaces a provider rejection', async () => {
  await call('settings.update', { settings: { apiKey: '' } })
  const missing = await call('models.list')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'no-api-key')

  await call('settings.update', { settings: { apiKey: 'sk-test-1234567890abcdef' } })
  providerMode = 'unauthorized'
  const rejected = await call('models.list')
  providerMode = 'ok'
  assert.equal(rejected.status, 401)
  assert.equal(rejected.body.error.code, 'provider-401')
})

await test('test.translate runs the real translation path and reports timing', async () => {
  seen.length = 0
  const sample = 'I should check the failing test before touching the parser.'
  const { status, body } = await call('test.translate', { text: sample })
  assert.equal(status, 200)
  assert.equal(body.source, sample)
  assert.match(body.translation, /^【译】/)
  assert.equal(typeof body.ms, 'number')
  assert.ok(body.ms >= 0)
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.apiRoot, `http://127.0.0.1:${providerPort}/v1`)
  assert.equal(seen.length, 1)
  assert.match(seen[0].body.messages[0].content, /Simplified Chinese/)
})

await test('test.translate requires a sample and a key', async () => {
  assert.equal((await call('test.translate', { text: '   ' })).status, 400)
  await call('settings.update', { settings: { apiKey: '' } })
  const noKey = await call('test.translate', { text: 'hello' })
  assert.equal(noKey.status, 400)
  assert.equal(noKey.body.error.code, 'no-api-key')
  await call('settings.update', { settings: { apiKey: 'sk-test-1234567890abcdef' } })
})

await test('autoExpand round-trips through the settings document', async () => {
  assert.equal((await call('settings.get')).body.settings.autoExpand, false)
  const saved = await call('settings.update', { settings: { autoExpand: true } })
  assert.equal(saved.body.settings.autoExpand, true)
  assert.equal((await call('settings.get')).body.settings.autoExpand, true)
  const document = JSON.parse(readFileSync(join(home, 'text-manager', 'settings.json'), 'utf8'))
  assert.equal(document.autoExpand, true)
  await call('settings.update', { settings: { autoExpand: false } })
})

await test('a base URL already carrying /v1 is not doubled', async () => {
  await call('settings.update', { settings: { baseUrl: `http://127.0.0.1:${providerPort}/v1` } })
  seen.length = 0
  const { body } = await call('translate', { text: 'Checking the version-suffixed base URL.' })
  assert.equal(body.skipped, false)
  assert.equal(seen[0].url, '/v1/chat/completions')
  await call('settings.update', { settings: { baseUrl: `http://127.0.0.1:${providerPort}` } })
})

await test('a non-JSON body is rejected', async () => {
  const response = await fetch(`${base}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json'
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'bad-json')
})

await test('the settings document survives a reload', async () => {
  const fresh = []
  const second = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => { fn(); return () => {} },
    webServer: { register(route) { fresh.push(route); return () => {} }, }
  }
  apply(second, { dshHome: home })
  const reloadServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = fresh.find(candidate => pathname.startsWith(candidate.path))
    void route.handler(request, response)
  })
  await new Promise(resolve => reloadServer.listen(0, '127.0.0.1', resolve))
  const response = await fetch(`http://127.0.0.1:${reloadServer.address().port}/text-manager/api/settings.get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  const body = await response.json()
  assert.equal(body.settings.apiKeySet, true)
  assert.equal(body.settings.baseUrl, `http://127.0.0.1:${providerPort}`)
  await new Promise(resolve => reloadServer.close(resolve))
})

server.close()
provider.close()
rmSync(home, { recursive: true, force: true })

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
