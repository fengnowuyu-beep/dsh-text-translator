/**
 * Settings-page test.
 *
 * `lib/client.js` is a module-loader bundle whose browser half is React. This
 * harness supplies a tiny hooks engine (hook slots, one-shot effects, a
 * `useSyncExternalStore` seat), a stubbed `fetch` standing in for the plugin's
 * host routes, and then drives the page's real controls: show/hide the key,
 * fetch the model directory, and run the translation self-test.
 *
 * It is a render-behaviour test, not a browser test: it proves the component
 * mounts without throwing and that each control performs the right host call.
 *
 * Run: node test/settings.test.mjs
 */
import assert from 'node:assert/strict'

// ── minimal DOM / platform stubs ────────────────────────────────────────────
let definition
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout,
  clearTimeout
}
globalThis.document = {
  body: {},
  head: { appendChild: () => {} },
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {}, append() {}, addEventListener() {}, remove() {} }),
  addEventListener() {},
  removeEventListener() {}
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.CSS = { escape: (value) => value }
globalThis.MouseEvent = class { constructor(type, init) { this.type = type; this.init = init } }

// ── tiny hooks engine ───────────────────────────────────────────────────────
/** Persistent hook slots, indexed by call order — exactly how React keys them. */
let slots = []
let cursor = 0
/** Effect indices that already ran (all deps here are `[]`). */
let ranEffects = new Set()
/** Effects queued during the current render. */
let pendingEffects = []
/** Set when a state update asked for another render. */
let dirty = false

/** React stand-in. */
const React = {
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== '')
    // Function components are invoked eagerly, exactly like React would. The
    // only hook-bearing component here is `SettingsSection` itself, which the
    // harness invokes directly so hook order stays under `cursor`.
    if (typeof type === 'function') return type({ ...(props ?? {}), children: flat })
    return { type, props: props ?? {}, children: flat }
  },
  Fragment: 'Fragment',
  useEffect(fn) {
    const index = cursor++
    if (!ranEffects.has(index)) {
      ranEffects.add(index)
      pendingEffects.push(fn)
    }
  },
  useMemo(fn) {
    cursor++
    return fn()
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
      dirty = true
    }]
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const index = cursor++
    if (!(index in slots)) {
      slots[index] = subscribe(() => { dirty = true })
    }
    return getSnapshot()
  }
}
const fakeRequire = (id) => {
  if (id === 'react') return { default: React, ...React }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  throw new Error(`unexpected require("${id}")`)
}

// ── host-route stub ─────────────────────────────────────────────────────────
/** Host state the stub serves. */
const host = {
  enabled: true,
  apiKey: 'sk-live-abcdefghijklmnop',
  apiKeySet: true,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  thinking: 'auto',
  onlyEnglish: true,
  autoExpand: false,
  translateProse: true,
  includeHistory: false,
  cutMode: 'balanced',
  maxSegmentChars: 1800,
  timeoutMs: 45000,
  cachedModels: [],
  translationCount: 7,
  models: ['deepseek-chat', 'my-local-model']
}
/** Every host method the page called, in order. */
const calls = []

/** @returns a fake `Response` whose body carries `ok: true`. */
function respond(payload) {
  return { ok: true, status: 200, json: async () => ({ ok: true, ...payload }) }
}

globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop()
  const body = init?.body ? JSON.parse(init.body) : {}
  calls.push({ method, body })
  switch (method) {
    case 'settings.get':
      return respond({
        settings: {
          pluginVersion: '1.1.0',
          settingsFile: 'C:\\fake\\settings.json',
          translationsFile: 'C:\\fake\\translations.json',
          translationCount: host.translationCount,
          enabled: host.enabled,
          baseUrl: host.baseUrl,
          model: host.model,
          thinking: host.thinking,
          onlyEnglish: host.onlyEnglish,
          autoExpand: host.autoExpand,
          translateProse: host.translateProse,
          includeHistory: host.includeHistory,
          cutMode: host.cutMode,
          maxSegmentChars: host.maxSegmentChars,
          timeoutMs: host.timeoutMs,
          cachedModels: host.cachedModels,
          apiKeySet: host.apiKeySet,
          apiKeyMask: 'sk-liv****************mnop'
        }
      })
    case 'settings.update':
      Object.assign(host, body.settings ?? {})
      if (typeof body.settings?.apiKey === 'string' && body.settings.apiKey !== '') {
        host.apiKey = body.settings.apiKey
        host.apiKeySet = true
      }
      return respond({
        settings: {
          pluginVersion: '1.1.0',
          translationsFile: 'C:\\fake\\translations.json',
          translationCount: host.translationCount,
          enabled: host.enabled,
          baseUrl: host.baseUrl,
          model: host.model,
          thinking: host.thinking,
          onlyEnglish: host.onlyEnglish,
          autoExpand: host.autoExpand === true,
          translateProse: host.translateProse === true,
          includeHistory: host.includeHistory === true,
          cutMode: host.cutMode,
          maxSegmentChars: host.maxSegmentChars,
          timeoutMs: host.timeoutMs,
          cachedModels: host.cachedModels,
          apiKeySet: host.apiKeySet,
          apiKeyMask: 'sk-liv****************mnop'
        }
      })
    case 'settings.reveal':
      return respond({ apiKey: host.apiKey })
    case 'models.list':
      host.cachedModels = host.models
      return respond({ models: host.models })
    case 'translate':
      return respond({ text: `【译】${String(body.text).slice(0, 24)}`, cached: false, skipped: false })
    case 'test':
      return respond({ model: host.model, thinking: host.thinking, reply: 'ok' })
    default:
      return respond({})
  }
}

await import('../lib/client.js')
assert.ok(definition !== undefined, 'the bundle must call __ModuleLoader__.load')

const bundle = definition.factory(fakeRequire)
const { __internals } = bundle
const SettingsSection = __internals?.SettingsSection
assert.equal(typeof SettingsSection, 'function', 'the settings section must be exported for inspectability')

/** Fake engine the page reads status from. */
const engine = {
  subscribe: () => () => {},
  getSnapshot: () => ({ enabled: true, ready: true, rows: 0, pending: 0, lastError: '' }),
  reload: async () => { calls.push({ method: 'engine.reload', body: null }) }
}

/**
 * Keys whose copy carries a placeholder. The identity reader used elsewhere
 * would leave `{count}` unresolved, so those two get their real shape.
 */
const PLACEHOLDERS = {
  storedCount: '{count} translation(s) stored',
  modelListOk: '{count} models available.'
}
/** The page's locale reader: the key itself, or the placeholder-bearing copy. */
const t = (key) => PLACEHOLDERS[key] ?? key

/** Render the section once and run any first-mount effects. */
function render() {
  cursor = 0
  pendingEffects = []
  const tree = SettingsSection({ t, engine })
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) effect()
  return tree
}

/** Let pending promises settle, then re-render if state changed. */
async function settle(tree) {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 12; i++) await Promise.resolve()
  return dirty ? render() : tree
}

/** Flatten a rendered tree to a list of element nodes. */
function nodes(tree, out = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  if (tree === null || typeof tree !== 'object' || !('type' in tree)) return out
  out.push(tree)
  nodes(tree.children, out)
  return out
}

/** Visible text of a node. */
function textOf(tree) {
  if (tree === null || tree === undefined || tree === false) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree === 'object' && 'children' in tree) return textOf(tree.children)
  return ''
}

/** @returns every node whose text equals `label`. */
function byText(tree, label) {
  return nodes(tree).filter(node => textOf(node) === label)
}

/** @returns the button carrying `label`. */
function button(tree, label) {
  const found = nodes(tree).find(node => node.type === 'button' && textOf(node) === label)
  assert.ok(found !== undefined, `expected a button labelled "${label}"`)
  return found
}

// ── checks ──────────────────────────────────────────────────────────────────
const results = []
/** @param name - the check's name. @param fn - the async check body. */
async function test(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\nsettings page render behaviour\n')

/** One mounted page shared by the checks, so state changes accumulate. */
let view = render()
view = await settle(view)

await test('mounts and loads the settings document', () => {
  assert.ok(calls.some(call => call.method === 'settings.get'), 'the page must read settings on mount')
  assert.ok(textOf(view).includes('title'))
  assert.ok(textOf(view).includes('autoExpand'))
  assert.ok(textOf(view).includes('translateProse'), 'the interleaved-text toggle must be on the page')
  assert.ok(textOf(view).includes('translateProseHint'))
  assert.ok(textOf(view).includes('sample'))
  assert.ok(textOf(view).includes('cutMode'), 'the granularity control must be on the page')
  assert.ok(textOf(view).includes('cutModeHint'), 'with the measured cost in its hint')
})

await test('the key field starts masked and the reveal control is present', () => {
  const password = nodes(view).find(node => node.type === 'input' && node.props.type === 'password')
  assert.ok(password !== undefined, 'the API key input must start masked')
  assert.equal(password.props.value, '')
  assert.ok(button(view, 'showKey') !== undefined)
})

await test('show reveals the plaintext through settings.reveal', async () => {
  calls.length = 0
  button(view, 'showKey').props.onClick()
  view = await settle(view)
  assert.ok(calls.some(call => call.method === 'settings.reveal'), 'reveal must ask the host')
  const text = nodes(view).find(node => node.type === 'input' && node.props.type === 'text' && node.props.autoComplete === 'off')
  assert.ok(text !== undefined, 'the key input must switch to plaintext')
  assert.equal(text.props.value, host.apiKey)
  assert.ok(button(view, 'hideKey') !== undefined)
})

await test('hide returns the field to masked and empty', async () => {
  button(view, 'hideKey').props.onClick()
  view = await settle(view)
  const password = nodes(view).find(node => node.type === 'input' && node.props.type === 'password')
  assert.ok(password !== undefined)
  assert.equal(password.props.value, '')
})

await test('the model picker offers the built-in suggestions before any fetch', () => {
  const options = nodes(view).filter(node => node.type === 'option').map(node => node.props.value)
  assert.ok(options.includes('deepseek-chat'))
  assert.ok(options.includes('deepseek-reasoner'))
})

await test('fetch models calls models.list and lists what came back', async () => {
  calls.length = 0
  button(view, 'modelList').props.onClick()
  view = await settle(view)
  assert.ok(calls.some(call => call.method === 'models.list'), 'the control must call models.list')
  const options = nodes(view).filter(node => node.type === 'option').map(node => node.props.value)
  assert.ok(options.includes('my-local-model'), `expected the fetched model in ${JSON.stringify(options)}`)
  assert.ok(textOf(view).includes('models available'), 'the fetch note must render')
})

await test('the model field still accepts a hand-typed id', async () => {
  const input = nodes(view).find(node => node.type === 'input' && node.props.list === 'dsh-rt-models')
  assert.ok(input !== undefined, 'the model text input must remain')
  input.props.onChange({ target: { value: 'my-typed-model' } })
  view = render()
  const after = nodes(view).find(node => node.type === 'input' && node.props.list === 'dsh-rt-models')
  assert.equal(after.props.value, 'my-typed-model')
})

await test('the auto-expand preference reflects the host and can be toggled', async () => {
  const before = nodes(view).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(before.length, 5, 'enable, onlyEnglish, autoExpand, translateProse and includeHistory')
  assert.equal(before.filter(box => box.props.checked === true).length, 3, 'enable, onlyEnglish and translateProse start on')
  const box = before.find(item => item.props.checked === false)
  box.props.onChange({ target: { checked: true } })
  view = render()
  const after = nodes(view).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(after.filter(item => item.props.checked === true).length, 4)
})

await test('the history toggle exists and reports the stored translation count', () => {
  assert.ok(textOf(view).includes('includeHistory'), 'the history opt-in must be on the page')
  assert.ok(textOf(view).includes('includeHistoryHint'))
  assert.ok(textOf(view).includes('7 translation(s) stored'), 'the host count must be shown')
  assert.ok(textOf(view).includes('translations.json'), 'the store path must be shown')
})

await test('the translation self-test runs the real segment pipeline', async () => {
  calls.length = 0
  button(view, 'sampleRun').props.onClick()
  view = await settle(view)
  const translates = calls.filter(call => call.method === 'translate')
  assert.ok(translates.length >= 2, `expected the sample to be segmented, got ${translates.length} call(s)`)
  assert.ok(translates.every(call => typeof call.body.text === 'string' && call.body.text.trim() !== ''))
  assert.ok(textOf(view).includes('sampleOk'), 'the success headline must render')
  assert.ok(textOf(view).includes('【译】'), 'the translated text must render')
})

await test('a failing self-test surfaces the host error instead of throwing', async () => {
  const original = globalThis.fetch
  // Only the translation call fails: the save must still succeed so the page
  // reaches the segment pipeline and reports the provider error from there.
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/translate')) {
      return { ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'provider-502', message: 'boom' } }) }
    }
    return original(url, init)
  }
  button(view, 'sampleRun').props.onClick()
  view = await settle(view)
  globalThis.fetch = original
  assert.ok(textOf(view).includes('sampleFailed'), 'the failure must be reported in the page')
  assert.ok(textOf(view).includes('boom'))
})

await test('a rejected save is reported on its own line', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/settings.update')) {
      return { ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'bad-request', message: 'nope' } }) }
    }
    return original(url, init)
  }
  button(view, 'sampleRun').props.onClick()
  view = await settle(view)
  globalThis.fetch = original
  assert.ok(textOf(view).includes('saveFailed'), 'a save failure must be reported')
  assert.ok(textOf(view).includes('nope'))
})

await test('the engine internals stay exported for the offline test suite', () => {
  assert.equal(typeof __internals?.Translator, 'function')
})

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
