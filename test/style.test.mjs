/**
 * Text-style module test.
 *
 * The style module has two halves that must agree: the catalogue that decides what
 * can be styled, and the CSS generator that decides how. This harness stubs the
 * module loader plus a small DOM, then drives the pieces that carry real risk —
 * preset/override merging, declaration generation, the preview-vs-chat rule, and
 * the answer/narration tagging that the two content styles depend on.
 *
 * Run: node test/style.test.mjs
 */
import assert from 'node:assert/strict'

/** The captured module definition from the bundle. */
let definition
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setInterval: () => 1,
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
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback }
  observe() {}
  disconnect() {}
}
globalThis.HTMLElement = class HTMLElement {}
globalThis.CSS = { escape: (value) => value }
globalThis.MouseEvent = class MouseEvent {}

/** Minimal React stand-in: only identity and hook arity matter here. */
const React = {
  createElement: (...args) => ({ args }),
  useEffect() {},
  useMemo() {},
  useRef() { return { current: null } },
  useState() { return [undefined, () => {}] },
  useSyncExternalStore() { return undefined }
}
const fakeRequire = (id) => {
  if (id === 'react') return { default: React, ...React }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  throw new Error(`unexpected require("${id}")`)
}

await import('../lib/client.js')
assert.ok(definition !== undefined, 'the bundle must call __ModuleLoader__.load')
const bundle = definition.factory(fakeRequire)
const {
  zh,
  en,
  presetLabelKey,
  STYLE_TARGETS,
  STYLE_COLORS,
  STYLE_FONTS,
  STYLE_KNOBS,
  styleOptions,
  styleDeclarations,
  declarationsToCss,
  textStyleCss,
  tagConversationParts,
  untagConversationParts,
  StyleEngine
} = bundle.__internals

/** Results collector, so one failure does not hide the rest. */
const results = []
const test = (name, body) => {
  try {
    body()
    results.push(true)
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`  FAIL  ${name}`)
    console.log(`        ${String(error.message).split('\n').join('\n        ')}`)
  }
}

/** A fake element that remembers its attributes and its turn. */
function fakeElement({ turn = '1', part } = {}) {
  const attributes = new Map(part === undefined ? [] : [['data-dsh-tm-part', part]])
  return {
    attributes,
    getAttribute: (name) => (name === 'data-chat-turn' ? turn : (attributes.get(name) ?? null)),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    closest: (selector) => (selector === '[data-chat-turn]' ? { getAttribute: () => turn } : null)
  }
}

/** A fake document that answers the two selectors the tagger uses. */
function fakeDocument(items) {
  return {
    querySelectorAll: (selector) => (selector.includes('data-dsh-tm-part')
      ? items.filter(item => item.attributes.has('data-dsh-tm-part'))
      : items)
  }
}

// ── the catalogue ───────────────────────────────────────────────────────────
test('every target is complete and uniquely keyed', () => {
  const keys = STYLE_TARGETS.map(target => target.key)
  assert.equal(new Set(keys).size, keys.length, 'target keys must be unique')
  for (const target of STYLE_TARGETS) {
    assert.ok(target.labelKey.startsWith('style'), `${target.key} needs a label key`)
    assert.ok(typeof target.real === 'string' && target.real !== '', `${target.key} needs a real selector`)
    assert.ok(Object.hasOwn(target.presets, 'default'), `${target.key} needs a default preset`)
    assert.ok(target.props.length > 0, `${target.key} advertises no knobs`)
    assert.ok(target.presets.default !== null && Object.keys(target.presets.default).length === 0,
      `${target.key}: the default preset must mean "emit nothing"`)
    for (const preset of Object.keys(target.presets)) {
      assert.match(preset, /^[a-z][A-Za-z]*$/, `${target.key}/${preset} needs a locale key`)
    }
  }
  assert.ok(STYLE_TARGETS.length >= 12, 'the module should cover every part of a turn')
})

test('every advertised knob exists, and only known options survive a merge', () => {
  for (const target of STYLE_TARGETS) {
    for (const property of target.props) {
      assert.ok(Object.hasOwn(STYLE_KNOBS, property), `${target.key}: no knob descriptor for ${property}`)
    }
    // Every preset may only set options this target actually exposes.
    for (const [preset, options] of Object.entries(target.presets)) {
      for (const property of Object.keys(options)) {
        assert.ok(target.props.includes(property),
          `${target.key}/${preset} sets ${property}, which this target does not expose`)
      }
    }
  }
})

test('every catalogue string has copy in both languages', () => {
  const needed = new Set([
    'nav', 'title', 'description', 'moduleStyle', 'moduleOff',
    'styleInline', 'styleInlineHint', 'stylePreview', 'stylePreviewHint',
    'styleTargets', 'styleTargetsHint', 'styleCustomize', 'styleCollapse',
    'styleResetTarget', 'styleResetAll', 'styleCustomized', 'styleUnusedHint',
    'knobAuto', 'styleSampleText', 'styleLang',
    'alignLeft', 'alignCenter', 'alignRight', 'alignJustify',
    'borderSolid', 'borderDashed', 'borderDotted'
  ])
  const groups = new Set()
  for (const target of STYLE_TARGETS) {
    needed.add(target.labelKey)
    groups.add(`styleGroup${target.group.charAt(0).toUpperCase()}${target.group.slice(1)}`)
    for (const preset of Object.keys(target.presets)) needed.add(presetLabelKey(preset))
    for (const property of target.props) {
      const knob = STYLE_KNOBS[property]
      needed.add(knob.labelKey)
      for (const [, choiceKey] of knob.choices ?? []) needed.add(choiceKey)
    }
  }
  for (const key of groups) needed.add(key)
  const missing = []
  for (const key of needed) {
    if (typeof zh[key] !== 'string' || zh[key] === '') missing.push(`zh:${key}`)
    if (typeof en[key] !== 'string' || en[key] === '') missing.push(`en:${key}`)
  }
  assert.deepEqual(missing, [], `copy missing for: ${missing.join(', ')}`)
})

test('both dictionaries carry exactly the same keys', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'a key in one language but not the other would render as a raw key')
})

test('the palette and font stacks are token-based and labelled', () => {
  for (const [key, colour] of Object.entries(STYLE_COLORS)) {
    assert.ok(typeof colour.css === 'string' && colour.css !== '', `${key} needs a css value`)
    assert.ok(typeof colour.zh === 'string' && typeof colour.en === 'string', `${key} needs both labels`)
    if (colour.css !== 'transparent') {
      assert.ok(colour.css.includes('var(--dsw-'), `${key} should resolve through a theme token`)
    }
  }
  assert.equal(STYLE_FONTS.inherit.css, null, 'inherit must emit nothing')
  assert.ok(STYLE_FONTS.mono.css.includes('--ds-font-family-code'))
})

// ── preset + override merging ───────────────────────────────────────────────
test('a preset supplies the base and the user overrides layer on top', () => {
  const target = STYLE_TARGETS.find(item => item.key === 'body')
  assert.deepEqual(styleOptions(target, undefined), {}, 'no entry means no declarations')
  assert.deepEqual(styleOptions(target, { preset: 'compact' }), { lineHeight: 1.45, size: 13 })
  assert.deepEqual(styleOptions(target, { preset: 'compact', options: { size: 15 } }),
    { lineHeight: 1.45, size: 15 }, 'the override wins')
  assert.deepEqual(styleOptions(target, { preset: 'nonsense' }), {},
    'an unknown preset falls back to the default rather than throwing')
  assert.deepEqual(styleOptions(target, { preset: 'compact', options: { bogus: 1 } }),
    { lineHeight: 1.45, size: 13 }, 'unknown options are ignored')
  assert.deepEqual(styleOptions(target, { preset: 'compact', options: { size: null } }),
    { lineHeight: 1.45 }, 'null removes a preset value')
})

// ── declarations ────────────────────────────────────────────────────────────
test('declarations carry units and only emit what was asked for', () => {
  const target = STYLE_TARGETS.find(item => item.key === 'body')
  assert.deepEqual(styleDeclarations(target, {}), {}, 'the default preset emits nothing')
  assert.deepEqual(styleDeclarations(target, { size: 15, lineHeight: 1.8 }),
    { fontSize: '15px', lineHeight: '1.8' })
  assert.deepEqual(styleDeclarations(target, { color: 'soft' }),
    { color: 'var(--dsw-alias-label-secondary)' })
  assert.equal(styleDeclarations(target, { italic: false }).fontStyle, undefined,
    'italic only appears when asked for')
  assert.equal(styleDeclarations(target, { underline: false }).textDecoration, undefined)
})

test('a border width keeps the meaning the shipped presets rely on', () => {
  const body = STYLE_TARGETS.find(item => item.key === 'body')
  const declarations = styleDeclarations(body, { borderWidth: 3 })
  assert.equal(declarations.borderLeft, '3px solid currentColor', 'a lone width is a left bar')
  assert.equal(declarations.borderRight, 'none')
  assert.equal(declarations.borderTop, 'none')
  assert.equal(declarations.borderBottom, 'none')
})

test('the border switch adds one side, all four, or none at all', () => {
  const body = STYLE_TARGETS.find(item => item.key === 'body')
  assert.equal(styleDeclarations(body, {}).borderLeft, undefined,
    'with no switch and no stroke, no border is declared at all')
  assert.equal(styleDeclarations(body, { borderSides: 'nonsense' }).borderLeft, undefined,
    'an unknown side is ignored rather than clearing everything')

  const all = styleDeclarations(body, { borderSides: 'all', borderWidth: 2, borderStyle: 'dashed', borderColor: 'brand' })
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    assert.equal(all[`border${side}`], '2px dashed var(--dsw-alias-brand-primary)')
  }

  const right = styleDeclarations(body, { borderSides: 'right' })
  assert.equal(right.borderRight, '3px solid currentColor', 'width, style and colour all default')
  assert.equal(right.borderLeft, 'none', 'and every other edge is cleared')
  assert.equal(right.borderTop, 'none')
  assert.equal(right.borderBottom, 'none')

  const none = styleDeclarations(body, { borderSides: 'none' })
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) assert.equal(none[`border${side}`], 'none')
})

test('the two translation styles never overlap', () => {
  const narration = STYLE_TARGETS.find(item => item.key === 'prose')
  const answer = STYLE_TARGETS.find(item => item.key === 'proseAnswer')
  assert.ok(narration !== undefined && answer !== undefined, 'both translation styles must exist')
  assert.ok(narration.real.includes(':not([data-dsh-tm-part="answer"])'),
    'the narration style excludes the answer translation')
  assert.ok(answer.real.includes('[data-dsh-tm-part="answer"]'),
    'and the answer style requires it')
  assert.notEqual(narration.labelKey, answer.labelKey, 'they are labelled differently')
})

test('every target can take a border of its own', () => {
  for (const target of STYLE_TARGETS) {
    for (const property of ['borderSides', 'borderWidth', 'borderStyle', 'borderColor',
      'paddingLeft', 'paddingRight', 'paddingY']) {
      assert.ok(target.props.includes(property), `${target.key} must expose ${property}`)
      assert.ok(Object.hasOwn(STYLE_KNOBS, property), `${property} needs a knob descriptor`)
    }
  }
})

test('the shipped bar and card presets still produce what they promise', () => {
  const quote = STYLE_TARGETS.find(item => item.key === 'quote')
  const bar = styleDeclarations(quote, styleOptions(quote, { preset: 'bar' }))
  assert.equal(bar.borderLeft, '3px solid var(--dsw-alias-brand-primary)')
  assert.equal(bar.borderTop, 'none', 'a bar is not a box')

  const reasoning = STYLE_TARGETS.find(item => item.key === 'reasoning')
  const card = styleDeclarations(reasoning, styleOptions(reasoning, { preset: 'card' }))
  assert.equal(card.borderLeft, '0px solid currentColor', 'the card preset drops the bar')
})

test('the two paddings are independent, which is how text clears a bar', () => {
  const body = STYLE_TARGETS.find(item => item.key === 'body')
  assert.deepEqual(styleDeclarations(body, { paddingLeft: 14 }),
    { paddingLeft: '14px' }, 'only the left side moves')
  assert.deepEqual(styleDeclarations(body, { paddingRight: 6 }), { paddingRight: '6px' })
  assert.deepEqual(styleDeclarations(body, { paddingY: 4 }),
    { paddingTop: '4px', paddingBottom: '4px' })
  const both = styleDeclarations(body, { borderSides: 'left', borderWidth: 3, paddingLeft: 14 })
  assert.equal(both.borderLeft, '3px solid currentColor')
  assert.equal(both.paddingLeft, '14px', 'a bar plus its breathing room')
})

test('declaration maps serialise to kebab-case CSS', () => {
  assert.equal(declarationsToCss({ fontSize: '13px', lineHeight: '1.7' }), 'font-size:13px;line-height:1.7')
  assert.equal(declarationsToCss({}), '')
})

// ── the stylesheet the page and the chat share ──────────────────────────────
test('the disabled module styles the preview but never the conversation', () => {
  const off = textStyleCss({ enabled: false, live: true, targets: { body: { preset: 'large', options: {} } } })
  assert.ok(off.includes('[data-dsh-tm-mock="body"]{font-size:16px'),
    'the preview still explains the choice')
  assert.ok(!off.includes('[data-dsh-tm-part="answer"] div[class*="markdown"]{'),
    'and the conversation is left alone')
})

test('the enabled module styles both, and only the chosen targets', () => {
  const css = textStyleCss({
    enabled: true,
    live: true,
    targets: { body: { preset: 'large', options: {} }, quote: { preset: 'bar', options: {} } }
  })
  assert.ok(css.includes('[data-dsh-tm-mock="body"]{font-size:16px'), 'preview rule')
  assert.ok(css.includes('[data-dsh-tm-part="answer"] div[class*="markdown"]{font-size:16px'), 'chat rule')
  assert.ok(css.includes('[data-dsh-tm-part] div[class*="markdown"] blockquote'),
    'the quote rule keeps its markdown scope')
  assert.ok(!css.includes('[data-dsh-tm-mock="heading"]') || !css.includes('[data-dsh-tm-mock="heading"]{'),
    'targets left at their default emit nothing')
})

test('the module never leaks into other pages or other plugins', () => {
  const css = textStyleCss({ enabled: true, live: true, targets: { body: { preset: 'large', options: {} } } })
  for (const rule of css.split('\n')) {
    if (rule === '' || rule.startsWith('[') === false) continue
    assert.ok(rule.startsWith('[data-dsh-tm-mock]') || rule.startsWith('[data-dsh-tm-mock=') || rule.startsWith('[data-dsh-tm-part')
      || rule.startsWith('[data-chat-flow-kind') || rule.startsWith('[data-dsh-tm=')
      || rule.startsWith('[data-chat-call-id]'),
    `every rule must be scoped by a data attribute, saw: ${rule.slice(0, 60)}`)
  }
})

// ── answer vs narration tagging ─────────────────────────────────────────────
test('the turn last response part is the answer and the rest is narration', () => {
  const first = fakeElement({ turn: '7' })
  const second = fakeElement({ turn: '7' })
  const otherTurn = fakeElement({ turn: '8' })
  const tagged = tagConversationParts(fakeDocument([first, second, otherTurn]))
  assert.equal(tagged, 3)
  assert.equal(first.attributes.get('data-dsh-tm-part'), 'narration', 'an earlier part is narration')
  assert.equal(second.attributes.get('data-dsh-tm-part'), 'answer', 'the last part of the turn is the answer')
  assert.equal(otherTurn.attributes.get('data-dsh-tm-part'), 'answer', 'each turn is judged on its own')
})

test('a part already tagged correctly is left untouched', () => {
  const item = fakeElement({ turn: '3' })
  tagConversationParts(fakeDocument([item]))
  assert.equal(item.attributes.get('data-dsh-tm-part'), 'answer')
  // Re-tagging must not rewrite the attribute: React-owned nodes are only touched
  // when the value actually differs.
  const before = item.attributes.get('data-dsh-tm-part')
  tagConversationParts(fakeDocument([item]))
  assert.equal(item.attributes.get('data-dsh-tm-part'), before)
})

test('untagging removes every tag this module wrote', () => {
  const items = [fakeElement({ turn: '1' }), fakeElement({ turn: '1' })]
  tagConversationParts(fakeDocument(items))
  assert.equal(items.filter(item => item.attributes.has('data-dsh-tm-part')).length, 2)
  untagConversationParts(fakeDocument(items))
  assert.equal(items.filter(item => item.attributes.has('data-dsh-tm-part')).length, 0)
})

// ── the engine ──────────────────────────────────────────────────────────────
test('the engine installs one stylesheet and repaints it on apply', () => {
  const head = { children: [], append(node) { this.children.push(node) } }
  const items = [fakeElement({ turn: '1' }), fakeElement({ turn: '1' })]
  const doc = {
    ...fakeDocument(items),
    head,
    createElement: () => ({ dataset: {}, textContent: '', remove() { this.removed = true } })
  }
  const engine = new StyleEngine()
  engine.start(doc)
  assert.equal(head.children.length, 1, 'exactly one style element')
  engine.apply({ enabled: true, live: true, targets: { body: { preset: 'large', options: {} } } })
  assert.ok(engine.element.textContent.includes('font-size:16px'), 'the sheet carries the CSS')
  assert.equal(items[1].attributes.get('data-dsh-tm-part'), 'answer', 'and the parts are tagged')
  engine.apply({ enabled: false, live: true, targets: {} })
  assert.equal(items.filter(item => item.attributes.has('data-dsh-tm-part')).length, 0,
    'switching the module off clears the tags')
  engine.stop()
  assert.equal(engine.element, null, 'stop releases the sheet')
  assert.equal(engine.observer, null)
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
