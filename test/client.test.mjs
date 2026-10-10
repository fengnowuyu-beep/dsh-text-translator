/**
 * Browser-half logic test.
 *
 * `lib/client.js` is a module-loader bundle, so this harness stubs
 * `window.__ModuleLoader__.load`, `react`, and the handful of globals the
 * module body touches, then drives the pieces that carry real risk: reading the
 * reasoning string off React's fiber, and the incremental segmentation protocol
 * that decides what gets sent to the translator and when.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict'

/** The captured module definition from the bundle. */
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
  createElement: () => ({ dataset: {}, append() {}, addEventListener() {}, remove() {} }),
  addEventListener() {},
  removeEventListener() {}
}
// `navigator` is a getter-only global on modern Node; the bundle only reads
// `navigator.clipboard?.` inside a click handler, so the real one is fine.
/** Every `observe()` call the engine makes, so its options are assertable. */
const OBSERVATIONS = []
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback
  }

  observe(target, options) {
    OBSERVATIONS.push({ target, options })
  }

  disconnect() {}
}
globalThis.HTMLElement = class HTMLElement {}
globalThis.CSS = { escape: (value) => value }
globalThis.MouseEvent = class MouseEvent {
  constructor(type, init) {
    this.type = type
    this.init = init
  }
}

/** Minimal React stand-in: only identity and hook arity matter here. */
const React = {
  createElement: (...args) => ({ args }),
  useEffect() {},
  useMemo() {},
  useRef() {
    return { current: null }
  },
  useState() {
    return [undefined, () => {}]
  },
  useSyncExternalStore() {
    return undefined
  }
}
/** `require` for the bundle factory. */
const fakeRequire = (id) => {
  if (id === 'react') return { default: React, ...React }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  throw new Error(`unexpected require("${id}")`)
}

// Importing the bundle executes its `__ModuleLoader__.load(...)` call, which
// captures the definition instead of registering it with a real loader.
await import('../lib/client.js')
assert.ok(definition !== undefined, 'the bundle must call __ModuleLoader__.load')

const bundle = definition.factory(fakeRequire)
const internals = bundle.__internals
assert.ok(internals !== undefined, 'bundle must expose __internals')

const { pickCut, findSentenceEnd, readPropsText, readRowText, Translator, Runner, ROW_KINDS, CUT_MODES, cutModeOf, fenceOpenAfter, STYLESHEET, partOfRow, badgeKeyOf, badgeTitleKeyOf, translationOnFor, KNOWN, remember } = internals
/** The companion stylesheet, as shipped. */
const CSS_TEXT = STYLESHEET
/** The reasoning kind, whose props matcher the row-access tests exercise. */
const REASONING_KIND = ROW_KINDS.find(kind => kind.id === 'reasoning')

/**
 * Checks are queued and run in order by {@link runAll}, so a body may be sync
 * or async without the caller having to await each one.
 */
const QUEUE = []
/** One boolean per finished check. */
const results = []
/** @param name - the check's name. @param fn - the check body (sync or async). */
function test(name, fn) {
  QUEUE.push({ name, fn })
}

/** Run every queued check, reporting as each settles. */
async function runAll() {
  for (const { name, fn } of QUEUE) {
    try {
      await fn()
      results.push(true)
      console.log(`  PASS  ${name}`)
    } catch (error) {
      results.push(false)
      console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

console.log(`\nclient half logic (bundle id="${definition.id}")\n`)

// ── fiber reading ───────────────────────────────────────────────────────────
/** Build a fake host element whose fiber chain carries the given props. */
function elementWithFiber(elementProps, hostProps = {}) {
  const hostFiber = { memoizedProps: hostProps, return: { memoizedProps: elementProps, return: null } }
  return {
    ['__reactFiber$t1']: hostFiber,
    getAttribute: () => 'running',
    closest: () => null,
    querySelector: () => null,
    innerText: ''
  }
}

test('readPropsText walks up to the ReasoningRow props', () => {
  const element = elementWithFiber({ text: 'full reasoning text', running: true, usePresentation: () => {} })
  assert.equal(readPropsText(element, REASONING_KIND.matchesProps), 'full reasoning text')
})

test('readPropsText accepts the settled row (running=false)', () => {
  const element = elementWithFiber({ text: 'settled reasoning', running: false, usePresentation: () => {} })
  assert.equal(readPropsText(element, REASONING_KIND.matchesProps), 'settled reasoning')
})

test('readPropsText ignores unrelated text props', () => {
  const element = elementWithFiber({ text: 'answer text', running: 'yes' })
  assert.equal(readPropsText(element, REASONING_KIND.matchesProps), null)
  assert.equal(readPropsText({}, REASONING_KIND.matchesProps), null)
})

test('readRowText falls back to the rendered DOM', () => {
  const summary = { innerText: 'latest paragraph' }
  const element = {
    querySelector: (selector) => (selector.includes('thinkBody') ? null : summary)
  }
  assert.equal(readRowText(element, REASONING_KIND), 'latest paragraph')
})

// ── segmentation ────────────────────────────────────────────────────────────
test('findSentenceEnd returns the cut past the last terminator', () => {
  assert.equal(findSentenceEnd('One. Two. Three'), 'One. Two.'.length)
  assert.equal(findSentenceEnd('没有标点'), 0)
  assert.equal(findSentenceEnd('第一句。第二句。'), '第一句。第二句。'.length)
})

test('findSentenceEnd ignores periods inside words, versions and paths', () => {
  assert.equal(findSentenceEnd('Version 1.2 is released'), 0)
  assert.equal(findSentenceEnd('read lib/client.js now'), 0)
})

test('pickCut waits while streaming inside a paragraph', () => {
  assert.deepEqual(pickCut('a short unfinished thought', true, 1800, false), { cut: 0, sep: '' })
})

test('pickCut takes a completed paragraph while streaming', () => {
  const rest = 'A finished paragraph of reasoning here.\n\nAnd a second one still growing'
  const picked = pickCut(rest, true, 1800, false)
  assert.equal(picked.sep, 'paragraph')
  assert.equal(rest.slice(0, picked.cut), 'A finished paragraph of reasoning here.')
})

test('pickCut flushes everything once the row settles', () => {
  const rest = 'An unfinished sentence with no terminator at all'
  assert.deepEqual(pickCut(rest, false, 1800, false), { cut: rest.length, sep: '' })
})

test('pickCut flushes on the idle timer even while running', () => {
  const rest = 'A stalled stream with no boundary'
  assert.deepEqual(pickCut(rest, true, 1800, true), { cut: rest.length, sep: '' })
})

test('pickCut splits oversized text at a word boundary once the flush is due', () => {
  const rest = `${'word '.repeat(60)}tail`
  // Running *and* forced: the flush is what the cap has to bound.
  const picked = pickCut(rest, true, 100, true)
  assert.ok(picked.cut <= 100)
  assert.ok(picked.cut > 40)
  assert.equal(rest[picked.cut], ' ', 'the split must fall on the separator, not inside a word')
  assert.equal(picked.sep, 'space')
})

// ── the incremental protocol ────────────────────────────────────────────────
/** Build a Translator whose side effects are recorded instead of rendered. */
function harness() {
  const translator = Object.create(Translator.prototype)
  translator.settings = { enabled: true, maxSegmentChars: 1800 }
  translator.dirty = new Set()
  translator.sent = []
  translator.options = []
  translator.renderCount = 0
  translator.scheduled = 0
  translator.render = () => { translator.renderCount += 1 }
  translator.schedule = () => { translator.scheduled += 1 }
  translator.enqueue = (state, part, options) => {
    translator.sent.push({ segment: part.segment, sep: part.sep })
    translator.options.push(options)
  }
  return translator
}

/** Build a fake row state around one fake element. */
function rowState(source, running = true) {
  return {
    kind: REASONING_KIND,
    row: { getAttribute: () => (running ? 'running' : 'ok') },
    source,
    sentUpTo: 0,
    sentSource: '',
    parts: [],
    generation: 0,
    live: false,
    requested: false,
    forceMode: false,
    missing: 0,
    skipped: 0,
    pending: 0,
    status: 'idle',
    error: ''
  }
}

test('pump emits nothing until a boundary appears', () => {
  const translator = harness()
  const state = rowState('A first thought that is still being written')
  translator.pump(state, false)
  assert.equal(translator.sent.length, 0)
  assert.equal(state.sentUpTo, 0)
})

  test('the per-request cap never forces a cut while a row is streaming', () => {
    // Regression: the cap used to be checked before the streaming gates, so a mode
    // that waits for the whole block still shipped 1800-character chunks mid-stream
    // — which looks exactly like the translation streaming again.
    const rest = `${'word '.repeat(60)}tail`
    const picked = pickCut(rest, true, 100, false)
    assert.equal(picked.cut, 0, 'a streaming row waits for its own boundary')
  })

  test('a mode that waits for the block sends nothing while the block streams', () => {
    const translator = harness()
    translator.settings = { enabled: true, cutMode: 'block', maxSegmentChars: 200 }
    const long = 'A sentence that is complete. '.repeat(40)
    const state = rowState(long, true)
    for (let pass = 0; pass < 5; pass += 1) translator.pump(state, false)
    assert.equal(translator.sent.length, 0, 'nothing may leave while the block is still streaming')
  })

  test('the same block goes out in capped requests once it settles', () => {
    const translator = harness()
    translator.settings = { enabled: true, cutMode: 'block', maxSegmentChars: 200 }
    const long = 'A sentence that is complete. '.repeat(40)
    const state = rowState(long, true)
    translator.pump(state, false)
    assert.equal(translator.sent.length, 0)

    state.row = { getAttribute: () => 'ok' }
    for (let pass = 0; pass < 40; pass += 1) translator.pump(state, false)
    assert.ok(translator.sent.length > 1, 'the settled block is split, not sent as one giant request')
    for (const item of translator.sent) {
      assert.ok(item.segment.length <= 200, `over-cap segment of ${item.segment.length} characters`)
    }
  })

test('pump emits each paragraph exactly once as the text streams in', () => {
  const translator = harness()
  const state = rowState('First paragraph is done.\n\nSecond par')

  translator.pump(state, false)
  assert.deepEqual(translator.sent, [{ segment: 'First paragraph is done.', sep: 'paragraph' }])

  state.source = 'First paragraph is done.\n\nSecond paragraph is done.\n\nThird one'
  translator.pump(state, false)
  assert.deepEqual(translator.sent[1], { segment: 'Second paragraph is done.', sep: 'paragraph' })

  // No boundary left in the tail: nothing more until the row settles.
  assert.equal(translator.sent.length, 2)

  state.row = { getAttribute: () => 'ok' }
  translator.pump(state, false)
  assert.equal(translator.sent[2].segment, 'Third one')
  assert.equal(translator.sent[2].sep, '')
})

test('pump consumes the source exactly once, separators aside', () => {
  const translator = harness()
  const state = rowState('Alpha paragraph complete.\n\nBeta paragraph complete.')
  translator.pump(state, false)
  translator.pump(state, false)
  translator.pump(state, true)
  const normalize = (value) => value.replace(/\s+/g, ' ').trim()
  assert.equal(
    normalize(translator.sent.map(item => item.segment).join(' ')),
    normalize(state.source)
  )
  assert.equal(state.sentUpTo, state.source.length, 'the whole source must be consumed')
})

test('pump restarts after the turn is rewritten', () => {
  const translator = harness()
  const state = rowState('Original first paragraph.\n\nOriginal second.')

  translator.pump(state, false)
  assert.equal(translator.sent.length, 1)

  // Regeneration: the text no longer extends what we already sent, and the new
  // text has no usable boundary yet, so offsets restart and nothing is sent.
  state.source = 'Entirely different reasoning output but not finished'
  translator.pump(state, false)
  assert.equal(state.sentUpTo, 0, 'offsets must restart on a rewritten turn')
  assert.equal(state.parts.length, 0)
  assert.equal(translator.sent.length, 1)

  // The first paragraph of the NEW text is what gets sent next.
  state.source = 'Entirely different reasoning output.\n\nMore of it.'
  translator.pump(state, false)
  assert.equal(translator.sent.length, 2)
  assert.equal(translator.sent[1].segment, 'Entirely different reasoning output.')
})

test('pump skips whitespace-only remainders without emitting', () => {
  const translator = harness()
  const state = rowState('Real paragraph.\n\n   \n\n')
  translator.pump(state, false)
  translator.pump(state, true)
  assert.equal(translator.sent.length, 1)
  assert.equal(translator.sent[0].segment, 'Real paragraph.')
})

// ── new-vs-history and the per-row action ───────────────────────────────────
/** A translator shaped for the provider-decision tests. */
function decider(settings = {}) {
  const translator = Object.create(Translator.prototype)
  translator.settings = { enabled: true, includeHistory: false, translateProse: true, maxSegmentChars: 1800, ...settings }
  translator.dirty = new Set()
  translator.rows = new Map()
  translator.lastRunningAt = 0
  translator.render = () => {}
  translator.schedule = () => {}
  translator.expand = () => {}
  translator.enqueue = () => {}
  translator.sent = []
  return translator
}

/** A row element whose streaming state the test controls. */
function fakeElement(state = 'ok') {
  return { getAttribute: (name) => (name === 'data-state' ? state : null), querySelector: () => null, closest: () => null }
}

/** A complete row state a `refresh` pass can walk end to end. */
function fullRowState() {
  return {
    kind: REASONING_KIND,
    row: fakeElement('ok'),
    live: false,
    requested: false,
    source: '',
    sentUpTo: 0,
    sentSource: '',
    parts: [],
    generation: 0,
    missing: 0,
    skipped: 0,
    pending: 0,
    status: 'idle',
    error: '',
    idleTimer: null,
    forceMode: false
  }
}

test('a row seen streaming may reach the provider', () => {
  const translator = decider()
  const state = fullRowState()
  state.row = fakeElement('running')
  state.source = ''
  translator.refresh(state)
  assert.equal(translator.allowsProvider(state), true)
})

test('a historical row may not, until the user asks', () => {
  const translator = decider()
  const historical = { live: false, requested: false }
  assert.equal(translator.allowsProvider(historical), false, 'loaded history must not spend on its own')
  assert.equal(translator.allowsProvider({ live: false, requested: true }), true, 'the button overrides it')
  assert.equal(decider({ includeHistory: true }).allowsProvider(historical), true, 'opt-in history mode')
  assert.equal(decider({ enabled: false }).allowsProvider({ live: true, requested: false }), false)
})

test('refresh marks a row live only while a turn is actually in flight', () => {
  const translator = decider()

  // Nothing has streamed: an old row stays historical.
  translator.lastRunningAt = 0
  const historical = fullRowState()
  historical.row = fakeElement('ok')
  translator.refresh(historical)
  assert.equal(historical.live, false)

  // A streaming row marks itself live and arms the grace window.
  const live = fullRowState()
  live.row = fakeElement('running')
  translator.refresh(live)
  assert.equal(live.live, true)
  assert.ok(translator.lastRunningAt > 0)

  // A sibling that finished before we looked inherits the window...
  const sibling = fullRowState()
  sibling.row = fakeElement('ok')
  translator.refresh(sibling)
  assert.equal(sibling.live, true, 'a turn in flight covers a fast-finishing row')

  // ...but once the window lapses, later rows are history again.
  translator.lastRunningAt = Date.now() - 60_000
  const later = fullRowState()
  later.row = fakeElement('ok')
  translator.refresh(later)
  assert.equal(later.live, false)
})

test('pump asks for a lookup-only pass on a historical row', () => {
  const translator = harness()
  translator.settings = { enabled: true, includeHistory: false, maxSegmentChars: 1800 }
  const state = rowState('First paragraph is done.\n\nSecond par', false)
  translator.pump(state, false)
  assert.equal(translator.options[0].provider, false, 'history is looked up, never paid for')
  assert.equal(translator.options[0].force, false)

  const live = harness()
  live.settings = { enabled: true, includeHistory: false, maxSegmentChars: 1800 }
  const liveState = rowState('First paragraph is done.\n\nSecond par', false)
  liveState.live = true
  live.pump(liveState, false)
  assert.equal(live.options[0].provider, true, 'live reasoning is translated')
})

test('act() resets the row and spends on its next pass', () => {
  const translator = harness()
  translator.settings = { enabled: true, includeHistory: false, maxSegmentChars: 1800 }
  const state = rowState('First paragraph is done.\n\nSecond par', false)
  translator.pump(state, false)
  assert.equal(translator.sent.length, 1)

  translator.act(state, true)
  assert.equal(state.requested, true)
  assert.equal(state.forceMode, true)
  assert.equal(state.sentUpTo, 0)
  assert.equal(state.parts.length, 0)

  translator.pump(state, false)
  assert.equal(translator.options[1].provider, true)
  assert.equal(translator.options[1].force, true, 'a refresh must overwrite the stored translation')
})

// ── the segment resolution path (KNOWN + host outcomes) ─────────────────────
/** Wait for the runner to drain. */
async function drain() {
  for (let i = 0; i < 24; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** A translator whose runner and render are live but whose DOM work is not. */
function resolver(calls) {
  const translator = Object.create(Translator.prototype)
  translator.settings = { enabled: true, includeHistory: false, maxSegmentChars: 1800 }
  translator.runner = new Runner(4)
  translator.publish = () => {}
  translator.render = () => {}
  translator.destroyed = false
  translator.calls = calls
  return translator
}

/** A row state with an empty ordered part list, as `pump` would build it. */
function partState() {
  return { kind: REASONING_KIND, generation: 0, parts: [], missing: 0, skipped: 0, pending: 0, status: 'idle', error: '' }
}

/**
 * Append a part the way `pump` does and hand it to `enqueue`.
 * @returns the part, so the caller can inspect its resolved status.
 */
function enqueueSegment(translator, state, segment, sep, options) {
  const part = { segment, sep, text: '', status: 'pending' }
  state.parts.push(part)
  translator.recount(state)
  translator.enqueue(state, part, options)
  return part
}

test('a lookup-only miss asks the host but never the provider', async () => {
  KNOWN.clear()
  let request = null
  globalThis.fetch = async (url, init) => {
    request = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ ok: true, missing: true }) }
  }
  const translator = resolver([])
  const state = partState()

  enqueueSegment(translator, state, 'never seen before', 'paragraph', { provider: false, force: false })
  await drain()

  assert.equal(request.provider, false, 'the host must be told not to spend')
  assert.equal(state.missing, 1)
  assert.equal(state.parts[0].status, 'missing')
  assert.equal(translator.translatedText(state), '')
  assert.equal(KNOWN.get('never seen before'), null, 'a confirmed miss is remembered as null')
})

test('enqueue replays a locally known translation without any call', async () => {
  KNOWN.clear()
  remember('known segment', '已知译文')
  let fetched = 0
  globalThis.fetch = async () => { fetched += 1; throw new Error('unexpected') }
  const translator = resolver([])
  const state = partState()
  enqueueSegment(translator, state, 'known segment', 'paragraph', { provider: false, force: false })
  assert.equal(fetched, 0)
  assert.equal(state.parts[0].status, 'ready')
  assert.equal(translator.translatedText(state), '已知译文')
})

test('enqueue records a missing segment and resolves it once permitted', async () => {
  KNOWN.clear()
  const translator = resolver([])
  const state = partState()

  // First, a lookup-only pass: the host reports it has nothing.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, missing: true }) })
  enqueueSegment(translator, state, 'a brand new segment', 'paragraph', { provider: false, force: false })
  await drain()
  assert.equal(state.missing, 1)
  assert.equal(translator.translatedText(state), '')

  // Now the user's action: the same segment is fetched and remembered.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.provider, true)
    return { ok: true, status: 200, json: async () => ({ ok: true, text: `【译】${body.text}`, cached: false, skipped: false }) }
  }
  enqueueSegment(translator, state, 'a brand new segment', 'paragraph', { provider: true, force: false })
  await drain()
  // A fresh pass replaces the parts, exactly as `act()` + `pump` would.
  state.parts = []
  translator.recount(state)
  enqueueSegment(translator, state, 'a brand new segment', 'paragraph', { provider: true, force: false })
  await drain()
  assert.equal(state.parts[0].status, 'ready')
  assert.equal(translator.translatedText(state), '【译】a brand new segment')
  assert.equal(KNOWN.get('a brand new segment'), '【译】a brand new segment')
})

test('enqueue honours force so a refresh overwrites the stored text', async () => {
  KNOWN.clear()
  remember('stale segment', '旧译文')
  let seen = null
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ ok: true, text: '新译文', cached: false, skipped: false }) }
  }
  const translator = resolver([])
  const state = partState()
  enqueueSegment(translator, state, 'stale segment', '', { provider: true, force: true })
  await drain()
  assert.equal(seen.force, true)
  assert.equal(translator.translatedText(state), '新译文')
  assert.equal(KNOWN.get('stale segment'), '新译文', 'the local line must follow the refresh')
})

test('parts stay in source order even when they resolve out of order', async () => {
  KNOWN.clear()
  // Latency inverted against source order: the first paragraph is the slowest
  // round trip, the last one is instant. Appending on completion would emit
  // them backwards — which is exactly the "translation is out of order" bug.
  const delays = { '第一段原文': 40, '第二段原文': 20, '第三段原文': 0 }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    await new Promise(resolve => setTimeout(resolve, delays[body.text] ?? 0))
    return { ok: true, status: 200, json: async () => ({ ok: true, text: `译:${body.text}`, cached: false, skipped: false }) }
  }
  const translator = resolver([])
  const state = partState()
  enqueueSegment(translator, state, '第一段原文', 'paragraph', { provider: true, force: true })
  enqueueSegment(translator, state, '第二段原文', 'paragraph', { provider: true, force: true })
  enqueueSegment(translator, state, '第三段原文', '', { provider: true, force: true })

  await drain()
  await new Promise(resolve => setTimeout(resolve, 120))
  await drain()

  assert.deepEqual(state.parts.map(part => part.status), ['ready', 'ready', 'ready'])
  assert.equal(
    translator.translatedText(state),
    '译:第一段原文\n\n译:第二段原文\n\n译:第三段原文',
    'paragraphs must render in source order, not completion order'
  )
})

test('parts wait their turn: a slow first paragraph does not hide the rest', async () => {
  KNOWN.clear()
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    await new Promise(resolve => setTimeout(resolve, body.text.startsWith('slow') ? 60 : 0))
    return { ok: true, status: 200, json: async () => ({ ok: true, text: `译:${body.text}`, cached: false, skipped: false }) }
  }
  const translator = resolver([])
  const state = partState()
  enqueueSegment(translator, state, 'slow first', 'paragraph', { provider: true, force: true })
  enqueueSegment(translator, state, 'fast second', 'paragraph', { provider: true, force: true })
  await drain()

  // The fast one is ready, the slow one is still in flight: the slow slot is
  // simply absent, and it appears in front once it lands.
  assert.deepEqual(state.parts.map(part => part.status), ['pending', 'ready'])
  assert.equal(translator.translatedText(state), '译:fast second')
  assert.equal(state.pending, 1)
  assert.equal(translator.actionOf(state).label, '翻译中…')

  await new Promise(resolve => setTimeout(resolve, 100))
  await drain()
  assert.equal(translator.translatedText(state), '译:slow first\n\n译:fast second')
})

test('translatedText joins ready parts with the separators the source had', () => {
  const translator = resolver([])
  const state = {
    parts: [
      { text: '第一段', sep: 'paragraph', status: 'ready' },
      { text: '第二段', sep: 'space', status: 'ready' },
      { text: '第三段', sep: '', status: 'ready' },
      { text: '', sep: 'paragraph', status: 'skipped' }
    ]
  }
  assert.equal(translator.translatedText(state), '第一段\n\n第二段 第三段')
})

test('the row button fills gaps first and only refreshes a complete row', () => {
  const translator = resolver([])
  const state = partState()

  assert.equal(translator.actionOf(state).label, '翻译')
  assert.equal(translator.actionOf(state).force, false, 'nothing stored: a plain translate')

  // A row the host knows nothing about: translate, still without overwriting.
  state.missing = 2
  assert.equal(translator.actionOf(state).label, '翻译')
  assert.equal(translator.actionOf(state).force, false, 'filling gaps must reuse whatever is stored')

  // Fully translated: the only action that overwrites is the refresh.
  state.missing = 0
  state.parts = [{ text: '已翻译', sep: '', status: 'ready' }]
  assert.equal(translator.actionOf(state).label, '刷新')
  assert.equal(translator.actionOf(state).force, true)

  state.pending = 1
  assert.equal(translator.actionOf(state).label, '翻译中…')
})

test('enqueue marks a host-skipped segment instead of translating it', async () => {
  KNOWN.clear()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, skipped: true }) })
  const translator = resolver([])
  const state = partState()
  enqueueSegment(translator, state, '已经是中文了', '', { provider: true, force: false })
  await drain()
  assert.equal(state.skipped, 1)
  assert.equal(state.parts[0].status, 'skipped')
  assert.equal(translator.translatedText(state), '')
  assert.equal(KNOWN.get('已经是中文了'), '')
})
test('start() watches data-state so a settled row flushes at once', async () => {
  OBSERVATIONS.length = 0
  const translator = Object.create(Translator.prototype)
  translator.rows = new Map()
  translator.dirty = new Set()
  translator.subscribers = new Set()
  translator.settings = { enabled: false }
  translator.destroyed = false
  translator.lastRunningAt = 0
  translator.snapshot = { enabled: false, ready: false, rows: 0, pending: 0, lastError: '' }
  translator.runner = new Runner(1)
  translator.scan = () => {}
  translator.clearAll = () => {}
  translator.publish = () => {}
  const intervals = []
  const originalSetInterval = globalThis.window.setInterval
  globalThis.window.setInterval = (fn, ms) => { intervals.push(ms); return 0 }

  await translator.start()
  globalThis.window.setInterval = originalSetInterval

  assert.equal(OBSERVATIONS.length, 1)
  const { options } = OBSERVATIONS[0]
  assert.equal(options.childList, true)
  assert.equal(options.subtree, true)
  assert.equal(options.characterData, true)
  assert.equal(options.attributes, true, 'attribute changes must be observed')
  assert.deepEqual(options.attributeFilter, ['data-state', 'data-streaming', 'aria-expanded', 'hidden'], 'streaming flags plus the fold controls')
  assert.deepEqual(intervals, [1500], 'the safety scan stays as a backstop')
  translator.stop()
})

test('a characterData record inside a row marks it dirty', () => {
  // Regression: this branch once referenced a selector constant that had been
  // removed, so every streaming text change threw inside the observer callback.
  const translator = Object.create(Translator.prototype)
  const state = { kind: { id: 'reasoning' } }
  const row = { id: 'row', closest: () => null, parentElement: null }
  translator.rows = new Map([[row, state]])
  translator.dirty = new Set()
  translator.activeKinds = () => []
  translator.schedule = () => {}
  translator.onMutations([{ type: 'characterData', target: { nodeType: 3, parentElement: row } }])
  assert.equal(translator.dirty.has(row), true, 'the row must be refreshed')
})

test('a fold above a row marks it dirty so the re-open is immediate', () => {
  const translator = Object.create(Translator.prototype)
  translator.activeKinds = () => []
  translator.schedule = () => {}
  translator.dirty = new Set()

  const row = {
    closest: (selector) => (selector === '[data-chat-turn]' ? { dataset: { chatTurn: '7' } } : null)
  }
  translator.rows = new Map([[row, { kind: { id: 'reasoning' } }]])

  // The step-process group header, which sits above the row, not around it.
  const header = {
    getAttribute: () => null,
    closest: (selector) => (selector === '[data-step-process]' ? {} : { dataset: { chatTurn: '7' } })
  }
  translator.onMutations([{ type: 'attributes', target: header }])
  assert.equal(translator.dirty.has(row), true, 'the group header fold must be seen')

  // The Turn-process fold row, matched by its data attribute.
  translator.dirty.clear()
  const foldRow = {
    getAttribute: (attribute) => (attribute === 'data-turn-process' ? '7' : null),
    closest: () => null
  }
  translator.onMutations([{ type: 'attributes', target: foldRow }])
  assert.equal(translator.dirty.has(row), true, 'the Turn fold row must be seen')

  // A control belonging to a different turn must not disturb this row.
  translator.dirty.clear()
  const otherTurn = {
    getAttribute: (attribute) => (attribute === 'data-turn-process' ? '9' : null),
    closest: () => null
  }
  translator.onMutations([{ type: 'attributes', target: otherTurn }])
  assert.equal(translator.dirty.has(row), false, 'another turn is not this row concern')
})
test('start() is wired: the observer callback drives the dirty set', () => {
  const translator = decider()
  const row = { nodeType: 1, closest: () => row, isConnected: true }
  translator.rows.set(row, { row })
  translator.dirty = new Set()
  translator.schedule = () => {}
  // An attribute record targeting the row itself (what data-state produces).
  translator.onMutations([{ type: 'attributes', target: row, addedNodes: [], removedNodes: [] }])
  assert.ok(translator.dirty.has(row), 'a data-state flip must mark the row dirty')
})

// ── cut granularity and the code-fence guard ───────────────────────────────
test('the granularity modes trade requests for latency', () => {
  const text = `${'A sentence that is complete. '.repeat(6)}And the tail`
  const countAt = (mode) => {
    const translator = harness()
    translator.settings = { enabled: true, cutMode: mode, maxSegmentChars: 1800 }
    const state = rowState(text, true)
    // Stream it in one go; the gates decide how much leaves in this pass.
    for (let index = 0; index < 6; index += 1) translator.pump(state, false)
    return translator.sent.length
  }
  const responsive = countAt('responsive')
  const balanced = countAt('balanced')
  const block = countAt('block')
  assert.ok(responsive > 0, 'responsive ships something immediately')
  assert.ok(balanced < responsive, `balanced (${balanced}) must ship less than responsive (${responsive})`)
  assert.equal(block, 0, 'block mode sends nothing while the row is still running')
  assert.equal(CUT_MODES.block.idleFlush, false, 'and the idle timer must not force it either')
  assert.equal(CUT_MODES.responsive.sentence, 24)
  assert.ok(CUT_MODES.balanced.sentence > CUT_MODES.responsive.sentence)
  assert.equal(CUT_MODES.paragraph.sentence, Number.MAX_SAFE_INTEGER, 'paragraph mode never cuts on a sentence')
})

test('an unknown cut mode falls back to balanced', () => {
  assert.equal(cutModeOf({ cutMode: 'nonsense' }), CUT_MODES.balanced)
  assert.equal(cutModeOf({}), CUT_MODES.balanced)
  assert.equal(cutModeOf({ cutMode: 'block' }), CUT_MODES.block)
})

test('a cut is never allowed to land inside an open code fence', () => {
  // The paragraph break sits inside the fence, so the eager path must not use it.
  const text = 'Before the block.\n\n```js\nconst answer = 42\n```\n\nAfter the block.'
  const eager = CUT_MODES.responsive

  // Without the guard, the paragraph inside the fence is a legal cut.
  const unguarded = pickCut(text, true, 1800, false, eager, true)
  assert.ok(unguarded.cut > 0, 'the guard input is a cut the raw rules accept')

  const guarded = pickCut(text, true, 1800, false, eager, false)
  assert.equal(fenceOpenAfter(text.slice(0, guarded.cut), false), false, 'the emitted prefix must close every fence')
})

test('the guard moves the cut to just before the opening fence', () => {
  const text = 'Intro sentence is done here. ```js\nconst a = 1\n``` more prose'
  const cut = pickCut(text, true, 1800, false, CUT_MODES.responsive, false).cut
  assert.ok(cut > 0)
  assert.equal(fenceOpenAfter(text.slice(0, cut), false), false, 'balanced after the cut')
  assert.ok(!text.slice(0, cut).includes('```'), 'nothing from inside the fence is shipped')
})

test('a flush still makes progress even when the fence never closes', () => {
  const text = '```js\nconst unfinished = true'
  const picked = pickCut(text, false, 1800, true, CUT_MODES.paragraph, false)
  assert.equal(picked.cut, text.length, 'refusing to send would stall the row forever')
})

test('pump tracks the fence state across segments', () => {
  const translator = harness()
  translator.settings = { enabled: true, cutMode: 'balanced', maxSegmentChars: 1800 }
  const state = rowState('First sentence is complete. ```js\nconst a = 1\n```\n\nTail paragraph.', true)
  translator.pump(state, false)
  assert.equal(state.fenceOpen, false, 'after a balanced cut no fence is left open')
  assert.ok(translator.sent.length >= 1)
  for (const item of translator.sent) {
    assert.equal(fenceOpenAfter(item.segment, false), false, `segment left a fence open: ${item.segment}`)
  }
})

// ── the prose kind (the assistant's text between thinking blocks) ──────────
/** The prose kind, whose selector and guard the kind tests exercise. */
const PROSE_KIND = ROW_KINDS.find(kind => kind.id === 'prose')

test('the prose kind is scoped to assistant text and excludes reasoning markdown', () => {
  assert.ok(PROSE_KIND !== undefined, 'a prose kind must exist')
  assert.match(PROSE_KIND.selector, /data-chat-flow-kind="assistant-step"/)
  assert.match(PROSE_KIND.selector, /data-chat-group-part="response"/)
  assert.match(PROSE_KIND.selector, /:not\(\[data-markdown-variant\]\)/, 'compact reasoning markdown must not match')
  assert.equal(PROSE_KIND.requireProps, true, 'identity comes from the React props, not the class token')
  assert.equal(REASONING_KIND.requireProps, undefined, 'reasoning has an exact selector already')
})

test('readPropsText reads MarkdownText props for prose, and rejects reasoning props', () => {
  const prose = elementWithFiber({ text: 'interleaved narration', streaming: false })
  assert.equal(readPropsText(prose, PROSE_KIND.matchesProps), 'interleaved narration')
  const reasoning = elementWithFiber({ text: 'thinking', running: true, usePresentation: () => {} })
  assert.equal(readPropsText(reasoning, PROSE_KIND.matchesProps), null, 'a reasoning row is not prose')
})

test('a freshly adopted row shows nothing until its first verdict', () => {
  // Regression: adopt() renders a placeholder straight away, so on load every
  // response row flashed a 旁白翻译 line under its turn and hid it again once the
  // lookups came back.
  const engine = Object.create(Translator.prototype)
  const fresh = { looked: false, live: false, requested: false }
  assert.equal(engine.awaitsVerdict(fresh), true, 'nothing is known yet, so nothing is shown')
  assert.equal(engine.awaitsVerdict({ ...fresh, live: true }), false,
    'a streaming row shows its progress')
  assert.equal(engine.awaitsVerdict({ ...fresh, requested: true }), false,
    'and a row the reader asked about shows its button')
  assert.equal(engine.awaitsVerdict({ ...fresh, looked: true }), false,
    'once a verdict lands the row speaks for itself')
})

test('recount marks the first verdict once the parts settle', () => {
  const engine = Object.create(Translator.prototype)
  const state = { parts: [], looked: false, status: 'idle', error: '' }
  engine.recount(state)
  assert.equal(state.looked, false, 'no parts yet is not a verdict')
  state.parts.push({ status: 'pending' })
  engine.recount(state)
  assert.equal(state.looked, false, 'a pending part is not a verdict either')
  state.parts[0].status = 'skipped'
  engine.recount(state)
  assert.equal(state.looked, true, 'a settled part is')
  assert.equal(state.skipped, 1)
})

test('a companion is labelled by the part it translates', () => {
  const engine = Object.create(Translator.prototype)
  engine.label = null
  assert.equal(engine.badgeText({ kind: PROSE_KIND, part: 'narration' }), '旁白翻译')
  assert.equal(engine.badgeText({ kind: PROSE_KIND, part: 'answer' }), '正文翻译',
    'the answer translation must not claim to be narration')
  assert.equal(engine.badgeText({ kind: REASONING_KIND, part: 'answer' }), '中文翻译',
    'reasoning is unaffected by the part')
  assert.ok(engine.badgeTitle({ kind: PROSE_KIND, part: 'answer' }).includes('回答正文'))
  // The offline call style — a bare kind — still answers.
  assert.equal(engine.badgeText(PROSE_KIND), '旁白翻译')
  assert.equal(badgeKeyOf({ kind: PROSE_KIND, part: 'answer' }), 'badgeAnswer')
  assert.equal(badgeTitleKeyOf({ kind: REASONING_KIND }), 'badgeReasoningTitle')
})

test('the turn last response part is the answer, per turn', () => {
  const fakeItem = (turn) => ({
    closest: (selector) => (selector === '[data-chat-turn]' ? { getAttribute: () => turn } : null)
  })
  const first = fakeItem('7')
  const second = fakeItem('7')
  const otherTurn = fakeItem('9')
  const original = globalThis.document.querySelectorAll
  globalThis.document.querySelectorAll = (selector) => (selector.includes('data-chat-group-part')
    ? [first, second, otherTurn]
    : [])
  try {
    const rowIn = (item) => ({ closest: () => item })
    assert.equal(partOfRow(rowIn(first)), 'narration')
    assert.equal(partOfRow(rowIn(second)), 'answer')
    assert.equal(partOfRow(rowIn(otherTurn)), 'answer', 'each turn is judged on its own')
    assert.equal(partOfRow({ closest: () => null }), 'narration', 'an unknown row degrades quietly')
  } finally {
    globalThis.document.querySelectorAll = original
  }
})

test('the conversation switch overrides the plugin switch in both directions', () => {
  const on = { enabled: true }
  const off = { enabled: false }
  // follows the plugin switch
  assert.equal(translationOnFor(on, 's1', null), true)
  assert.equal(translationOnFor(off, 's1', null), false)
  // 开启 translates while the plugin is off
  assert.equal(translationOnFor(off, 's1', 'on'), true)
  // 关闭 stays quiet while the plugin is on
  assert.equal(translationOnFor(on, 's1', 'off'), false)
  assert.equal(translationOnFor(on, 's1', 'on'), true)
  assert.equal(translationOnFor(off, 's1', 'off'), false)
  // no conversation known: nothing to override with
  assert.equal(translationOnFor(off, null, 'on'), false)
  assert.equal(translationOnFor(on, null, 'off'), true)
  assert.equal(translationOnFor(null, 's1', null), false, 'before settings load, nothing is on')
})

/**
 * A harness plus the fields the snapshot path touches, for tests that drive the
 * per-conversation switch (which publishes and repaints).
 */
function sessionHarness() {
  const translator = harness()
  translator.subscribers = new Set()
  translator.rows = new Map()
  translator.runner = { size: () => 0 }
  translator.snapshot = null
  return translator
}

test('a switched-off conversation asks for nothing and shows nothing', () => {
  const translator = sessionHarness()
  translator.sessionId = 's1'
  translator.sessionMode = 'off'
  const state = rowState('First paragraph is done.\n\nSecond paragraph is done.')
  translator.pump(state, false)
  assert.equal(translator.sent.length, 0, 'no segment may be queued')
  assert.ok(state.parts.length > 0, 'but the segments are still tracked')
  assert.deepEqual([...new Set(state.parts.map(part => part.status))], ['skipped'],
    'settled as skipped, so nothing is left pending')
  assert.equal(translator.allowsProvider(state), false, 'and the provider is out of reach')
  assert.equal(translator.translationOn(), false)

  translator.sessionMode = 'on'
  assert.equal(translator.translationOn(), true)
  // The harness row is not marked live, so name the reason the provider is allowed.
  state.live = true
  assert.equal(translator.allowsProvider(state), true)
  state.live = false
  state.requested = true
  assert.equal(translator.allowsProvider(state), true, 'a user action may always spend')
})

test('following a switched-off plugin also queues nothing', () => {
  const translator = sessionHarness()
  translator.settings = { enabled: false, maxSegmentChars: 1800 }
  translator.sessionId = 's1'
  translator.sessionMode = null
  const state = rowState('First paragraph is done.\n\nSecond paragraph is done.')
  translator.pump(state, false)
  assert.equal(translator.sent.length, 0)
  assert.equal(translator.translationOn(), false)
})

test('the switch cycles 跟随 → 开启 → 关闭 and paints before the host answers', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const mode = JSON.parse(init.body).mode
    return { ok: true, status: 200, json: async () => ({ ok: true, mode: mode ?? null }) }
  }
  const translator = sessionHarness()
  translator.sessionId = 's1'
  translator.sessionMode = null
  await translator.cycleSessionMode()
  assert.equal(calls[0].body.mode, 'on')
  assert.equal(translator.sessionMode, 'on')
  await translator.cycleSessionMode()
  assert.equal(translator.sessionMode, 'off')
  await translator.cycleSessionMode()
  assert.equal(translator.sessionMode, null, 'and back to following')
  assert.equal(calls[2].body.mode, null)
})

test('a late answer for a conversation the reader left is ignored', async () => {
  let release = null
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'session.get') {
      await new Promise((resolve) => { release = resolve })
      return { ok: true, status: 200, json: async () => ({ ok: true, mode: 'on' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, mode: null }) }
  }
  const translator = sessionHarness()
  translator.sessionId = 's1'
  const pending = translator.loadSessionMode()
  translator.setSession('s2')
  release?.()
  await pending
  assert.equal(translator.sessionMode, null, "s1's switch must not leak into s2")
  assert.equal(translator.sessionId, 's2')
})

test('the two kinds carry different badges and tooltips', () => {
  assert.equal(REASONING_KIND.badgeKey, 'badgeReasoning')
  assert.equal(PROSE_KIND.badgeKey, 'badgeProse')
  assert.notEqual(REASONING_KIND.badgeKey, PROSE_KIND.badgeKey, 'the reader must be able to tell them apart')
  assert.equal(REASONING_KIND.badgeTitleKey, 'badgeReasoningTitle')
  assert.equal(PROSE_KIND.badgeTitleKey, 'badgeProseTitle')

  const engine = Object.create(Translator.prototype)
  engine.label = null
  assert.equal(engine.badgeText(REASONING_KIND), '中文翻译')
  assert.equal(engine.badgeText(PROSE_KIND), '旁白翻译')
  assert.ok(engine.badgeTitle(PROSE_KIND).includes('零散文字'))

  // With a locale resolver injected, the dictionary wins.
  const dict = { badgeProse: 'Narration', badgeProseTitle: 'the text between blocks' }
  engine.label = (key) => dict[key]
  assert.equal(engine.badgeText(PROSE_KIND), 'Narration')
  assert.equal(engine.badgeTitle(PROSE_KIND), 'the text between blocks')
  // An unresolvable key falls back to the built-in label rather than showing a key.
  assert.equal(engine.badgeText(REASONING_KIND), '中文翻译')
})

test('the stylesheet gives the prose translation its own look', () => {
  const block = CSS_TEXT
  assert.ok(block.includes('[data-dsh-tm="block"][data-kind="prose"]'), 'prose blocks must be styleable')
  assert.ok(block.includes('[data-dsh-tm="block"][data-kind="prose"] [data-dsh-tm="badge"]'), 'and so must their badge')
  // Reasoning keeps a solid brand bar on a rounded card; prose swaps that for a
  // dashed tertiary bar with no fill and square corners.
  const prose = /\[data-dsh-tm="block"\]\[data-kind="prose"\]\{([^}]*)\}/.exec(block)
  assert.ok(prose !== null, 'the prose block rule must exist')
  assert.match(prose[1], /border-left:3px dashed var\(--dsw-alias-label-tertiary/, 'a dashed grey bar')
  assert.match(prose[1], /background:transparent/, 'and no card fill')
  assert.match(prose[1], /border-radius:0/, 'and square corners')
  assert.ok(!prose[1].includes('border-l2') && !prose[1].includes('border-l1'),
    'border-l2 is only ~10% black, so it must not carry the distinction')
  const reasoning = /\[data-dsh-tm="block"\]\{([^}]*)\}/.exec(block)
  assert.match(reasoning[1], /border-left:2px solid var\(--dsw-alias-brand-primary/, 'the reasoning bar stays as it was')
  assert.ok(block.includes('[data-dsh-tm="block"][data-kind="prose"][data-empty]'), 'the untranslated state must stay faint')
})

test('readRowText falls back to the element own text for prose', () => {
  const element = { innerText: 'rendered narration', querySelector: () => null }
  assert.equal(readRowText(element, PROSE_KIND), 'rendered narration')
})

test('adopt refuses a prose element whose props are not MarkdownText', () => {
  const translator = decider()
  translator.settings = { enabled: true, translateProse: true }
  translator.render = () => {}
  const foreign = elementWithFiber({ text: 'answer text', running: 'yes' })
  assert.equal(translator.adopt(foreign, PROSE_KIND), null, 'a false positive must never be adopted')
  assert.equal(translator.rows.size, 0)

  const real = elementWithFiber({ text: 'real narration', streaming: true })
  assert.ok(translator.adopt(real, PROSE_KIND) !== null)
  assert.equal(translator.rows.size, 1)
})

test('activeKinds follows the translateProse switch', () => {
  const translator = decider()
  assert.deepEqual(translator.activeKinds().map(kind => kind.id), ['reasoning', 'prose'])
  translator.settings = { enabled: true, translateProse: false }
  assert.deepEqual(translator.activeKinds().map(kind => kind.id), ['reasoning'])
  translator.settings = { enabled: false, translateProse: true }
  assert.deepEqual(translator.activeKinds(), [], 'the master switch wins')
})

test('dropKind removes only that kind rows and their companions', () => {
  const translator = decider()
  const removed = []
  const proseRow = { id: 'prose-row' }
  const reasoningRow = { id: 'reasoning-row' }
  // `companion` lives on the row STATE (it is the companion node the engine
  // created), never on the DOM row it was inserted after.
  translator.rows.set(proseRow, {
    row: proseRow,
    kind: { id: 'prose' },
    generation: 0,
    companion: { remove: () => removed.push('prose') }
  })
  translator.rows.set(reasoningRow, {
    row: reasoningRow,
    kind: { id: 'reasoning' },
    generation: 0,
    companion: { remove: () => removed.push('reasoning') }
  })
  translator.dropKind('prose')
  assert.deepEqual(removed, ['prose'], 'only the prose companion is torn down')
  assert.equal(translator.rows.size, 1)
  assert.equal(translator.rows.get(reasoningRow).kind.id, 'reasoning')
})

test('a row whose every segment is already Chinese stays out of the way', () => {
  const translator = resolver([])
  const state = partState()
  assert.equal(translator.isNoop(state), false, 'a fresh row still shows its button')

  // All skipped: the host said the text is already Chinese.
  state.parts = [{ segment: '中文原文', sep: '', text: '', status: 'skipped' }]
  translator.recount(state)
  assert.equal(state.skipped, 1)
  assert.equal(translator.isNoop(state), true, 'no companion for a Chinese answer')

  // One untranslated segment: the companion (and its button) must come back.
  state.parts.push({ segment: 'english bit', sep: '', text: '', status: 'missing' })
  translator.recount(state)
  assert.equal(translator.isNoop(state), false)

  // A translated segment likewise keeps the companion.
  state.parts = [{ segment: 'english bit', sep: '', text: '译好了', status: 'ready' }]
  translator.recount(state)
  assert.equal(translator.isNoop(state), false)
  assert.equal(translator.translatedText(state), '译好了')
})

// ── auto-expand ─────────────────────────────────────────────────────────────
/** Selector the engine must use for a reasoning row's own disclosure. */
const OWN_SELECTOR = '[data-disclosure-row][aria-expanded="false"]'
/** Selector the engine must use for the collapsed step-process group header. */
const GROUP_SELECTOR = 'button[data-process-activity][aria-expanded="false"]'
/** Selector prefix the engine must use for the Turn-process fold row. */
const TURN_PREFIX = 'button[data-turn-process="3"]'

/** A disclosure control that records its own clicks and tracks its open state. */
function control(name, log, expanded = false) {
  return {
    name,
    expanded,
    getAttribute(attribute) {
      return attribute === 'aria-expanded' ? String(this.expanded) : null
    },
    dispatchEvent() {
      log.push(name)
      this.expanded = !this.expanded
      return true
    }
  }
}

/**
 * Build a fake reasoning row plus the controls above it.
 * @param log - click log shared with the controls.
 * @param selectors - records every selector the engine asked for.
 * @returns the fake row and its controls.
 */
function autoExpandFixture(log, selectors) {
  const own = control('reasoning', log)
  const header = control('group', log)
  const fold = control('turn', log)
  const seat = {
    querySelector: (selector) => {
      selectors.push(selector)
      return selector === GROUP_SELECTOR ? header : null
    }
  }
  const row = {
    querySelector(selector) {
      selectors.push(selector)
      if (selector === OWN_SELECTOR) return own
      return null // thinkBody / summaryText: no rendered text in this fixture
    },
    closest(selector) {
      if (selector === '[data-step-process]') return seat
      if (selector === '[data-chat-turn]') return { dataset: { chatTurn: '3' } }
      return null
    },
    getAttribute: () => 'ok'
  }
  return { row, own, header, fold }
}

/** An engine with a fresh click ledger and no rendering. */
function expander(autoExpand = true) {
  const translator = Object.create(Translator.prototype)
  translator.settings = { autoExpand, maxSegmentChars: 1800 }
  translator.rows = new Map()
  translator.dirty = new Set()
  translator.readerClosed = new WeakSet()
  translator.clickedAt = new WeakMap()
  translator.now = () => Date.now()
  translator.render = () => {}
  translator.schedule = () => {}
  translator.enqueue = () => {}
  return translator
}

test('expand asks for exactly the three documented controls', () => {
  const log = []
  const selectors = []
  const { row, fold } = autoExpandFixture(log, selectors)
  // Matched by prefix: the engine escapes the turn id with `CSS.escape`, which
  // is a no-op for "3" but must stay free to differ.
  document.querySelector = (selector) => {
    selectors.push(selector)
    return selector.startsWith(TURN_PREFIX) ? fold : null
  }
  expander().expand(row)
  assert.deepEqual(log, ['reasoning', 'group', 'turn'], 'innermost disclosure first')
  assert.ok(selectors.includes(OWN_SELECTOR))
  assert.ok(selectors.includes(GROUP_SELECTOR))
  assert.ok(selectors.some(selector => selector.startsWith(TURN_PREFIX)))
})

test('expand re-opens a turn that DSH folded once it finished', () => {
  const log = []
  const selectors = []
  const { row, fold } = autoExpandFixture(log, selectors)
  document.querySelector = () => fold

  // A clock the test drives, so the cooldown is deterministic.
  let clock = 1_000_000
  const engine = expander()
  engine.now = () => clock

  engine.expand(row)
  assert.deepEqual(log, ['reasoning', 'group', 'turn'], 'the streaming turn is opened')

  // React has not committed yet: a scan inside the cooldown must not toggle back.
  engine.expand(row)
  assert.equal(log.length, 3, 'no double toggle while React catches up')

  // The turn closes and DSH folds the whole process again. Some time later the
  // next pass must re-open it — this is the behaviour the reader asked for.
  clock += 5000
  engine.expand(row)
  assert.deepEqual(log, ['reasoning', 'group', 'turn', 'reasoning', 'group', 'turn'], 'a finished turn must not stay folded')
})

test('a control the reader closed by hand is left alone', () => {
  const log = []
  const selectors = []
  const { row, own, fold } = autoExpandFixture(log, selectors)
  document.querySelector = () => fold

  let clock = 1_000_000
  const engine = expander()
  engine.now = () => clock

  // A trusted click on an OPEN control is a request to keep it shut.
  own.expanded = true
  engine.noteReaderToggle({ isTrusted: true, target: { closest: () => own } })
  clock += 5000
  engine.expand(row)
  assert.ok(!log.includes('reasoning'), 'the hand-closed control must stay closed')
  assert.ok(log.includes('group') && log.includes('turn'), 'the others still follow the setting')

  // Clicking a *closed* control is the opposite intent, and clears the record.
  own.expanded = false
  engine.noteReaderToggle({ isTrusted: true, target: { closest: () => own } })
  assert.equal(engine.readerClosed.has(own), false)
})

test('a click this plugin synthesized never counts as reader intent', () => {
  const engine = expander()
  const control = { getAttribute: () => 'true' }
  engine.noteReaderToggle({ isTrusted: false, target: { closest: () => control } })
  assert.equal(engine.readerClosed.has(control), false, 'isTrusted false is our own click')
  engine.noteReaderToggle({ target: { closest: () => control } })
  assert.equal(engine.readerClosed.has(control), false, 'and a missing flag is not intent either')
})

test('a click outside the managed controls is ignored', () => {
  const engine = expander()
  engine.noteReaderToggle({ isTrusted: true, target: { closest: () => null } })
  engine.noteReaderToggle({ isTrusted: true, target: null })
  engine.noteReaderToggle({ isTrusted: true, target: { closest: 'not a function' } })
})

test('re-enabling the option clears both the click and the hand-collapse ledger', () => {
  const engine = expander(false)
  engine.scan = () => {}
  const closed = { getAttribute: () => 'true' }
  engine.readerClosed.add(closed)
  engine.clickedAt.set(closed, 1)

  engine.applySettings({ enabled: true, apiKeySet: true, autoExpand: true })
  assert.equal(engine.readerClosed.has(closed), false, 'a fresh opt-in re-opens everything')
  assert.equal(engine.clickedAt.has(closed), false)
})

test('expand tolerates a control that refuses the click', () => {
  const log = []
  const selectors = []
  const { row, own } = autoExpandFixture(log, selectors)
  own.dispatchEvent = () => { throw new Error('cross-realm event') }
  document.querySelector = () => null
  const engine = expander()
  engine.expand(row)
  // The failure drops the cooldown stamp, so a later pass may retry it.
  assert.equal(engine.clickedAt.has(own), false)
})

test('expand survives a selection failure', () => {
  const selectors = []
  const log = []
  const { row } = autoExpandFixture(log, selectors)
  document.querySelector = () => { throw new Error('bad selector') }
  row.querySelector = () => { throw new Error('bad selector') }
  expander().expand(row) // must not throw
})

/** A row state efresh can walk, wired to the reasoning kind. */
function autoExpandRow(row) {
  return {
    kind: REASONING_KIND,
    row,
    source: '',
    sentUpTo: 0,
    sentSource: '',
    parts: [],
    generation: 0,
    live: false,
    requested: false,
    forceMode: false,
    missing: 0,
    skipped: 0,
    pending: 0,
    status: 'idle',
    error: '',
    idleTimer: null,
    collapsed: false
  }
}

test('refresh only auto-expands while the option is on', () => {
  const log = []
  const selectors = []
  const { row, fold } = autoExpandFixture(log, selectors)
  document.querySelector = () => fold

  const off = expander(false)
  off.refresh(autoExpandRow(row))
  assert.deepEqual(log, [], 'nothing expands while the option is off')

  const on = expander(true)
  on.refresh(autoExpandRow(row))
  assert.deepEqual(log, ['reasoning', 'group', 'turn'])
})

test('applySettings re-arms auto-expand when it is switched on', () => {
  const log = []
  const selectors = []
  const { row, fold } = autoExpandFixture(log, selectors)
  document.querySelector = () => fold
  const engine = expander(false)
  engine.scan = () => {}
  const state = autoExpandRow(row)

  engine.applySettings({ enabled: true, apiKeySet: true, autoExpand: false })
  engine.refresh(state)
  assert.deepEqual(log, [], 'off: nothing opens')

  engine.applySettings({ enabled: true, apiKeySet: true, autoExpand: true })
  engine.refresh(state)
  assert.deepEqual(log, ['reasoning', 'group', 'turn'], 'turning it on opens the mounted rows again')
})

await runAll()

const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
