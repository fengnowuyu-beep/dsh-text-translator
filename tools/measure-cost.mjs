/**
 * Cost measurement: replay a real session log through the plugin's own
 * segmentation so the numbers are the plugin's, not an estimate.
 *
 * The v4 session log is a stream of concatenated zstd frames, each carrying one
 * JSONL event. Assistant steps arrive as `assistant/message` with their content
 * blocks (reasoning / text / tool-call) — exactly the units DSH renders as rows
 * and this plugin translates. Every reasoning and text block is fed to the
 * plugin's real `pickCut` twice:
 *
 *   streaming  — the text growing word by word, plus the final flush: what the
 *                live page actually does
 *   settled    — the finished text in one pass: the floor, and what a row that
 *                was already complete when it appeared would cost
 *
 * Run: node tools/measure-cost.mjs [sessionId]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

// The browser half is a module-loader bundle, so stub the loader and React to
// reach the segmentation helpers the live engine uses.
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
  createElement: () => ({ dataset: {}, append() {}, addEventListener() {}, remove() {} })
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.HTMLElement = class {}
globalThis.CSS = { escape: (value) => value }
globalThis.MouseEvent = class {}
const ReactStub = {
  createElement: () => null,
  useEffect() {},
  useMemo() {},
  useRef: () => ({ current: null }),
  useState: () => [undefined, () => {}],
  useSyncExternalStore: () => undefined
}
await import('../lib/client.js')
const client = definition.factory((id) => {
  if (id === 'react') return { default: ReactStub, ...ReactStub }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  throw new Error(`unexpected require("${id}")`)
})
const { pickCut } = client.__internals

// ── read the session log ────────────────────────────────────────────────────
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionId = process.argv[2] ?? 'session-c907cee3-d5f5-4d52-a6f4-62d393687790'

/** @returns the log path for one session, wherever its workspace folder is. */
function sessionLogFile(root, id) {
  for (const workspaceDir of readdirSync(root)) {
    const candidate = join(root, workspaceDir, id)
    try {
      if (!statSync(candidate).isDirectory()) continue
    } catch {
      continue
    }
    const frames = readdirSync(candidate).filter(name => name.endsWith('.zstd'))
    if (frames.length > 0) return join(candidate, frames.sort().at(-1))
  }
  return null
}

/**
 * The log is a series of concatenated zstd frames with no length prefix, and
 * Node's single-frame decoder stops after the first one — so slice at every
 * frame magic and decode each frame on its own.
 * @returns the whole log as text.
 */
function readLog(file) {
  const buffer = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let at = 0; ;) {
    const found = buffer.indexOf(magic, at)
    if (found === -1) break
    offsets.push(found)
    at = found + magic.length
  }
  offsets.push(buffer.length)
  const parts = []
  for (let index = 0; index < offsets.length - 1; index += 1) {
    parts.push(zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1])))
  }
  return Buffer.concat(parts).toString('utf8')
}

const file = sessionLogFile(join(home, 'sessions'), sessionId)
if (file === null) {
  console.error(`no log for ${sessionId}`)
  process.exit(1)
}
const text = readLog(file)
const events = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try {
    events.push(JSON.parse(line))
  } catch {
    // A partial trailing line is expected on a live session.
  }
}
console.log(`session: ${sessionId}`)
console.log(`events: ${events.length}`)

// ── collect the translatable blocks ────────────────────────────────────────
/** `{ kind, text, turn, step, index }` for every block the plugin would take. */
const blocks = []
let steps = 0
for (const event of events) {
  if (event?.type !== 'assistant/message') continue
  const content = event.data?.message?.content
  if (!Array.isArray(content)) continue
  steps += 1
  content.forEach((block, index) => {
    const kind = block?.type === 'reasoning' ? 'reasoning' : block?.type === 'text' ? 'prose' : null
    if (kind === null) return
    const value = typeof block.text === 'string' ? block.text : ''
    if (value.trim() === '') return
    blocks.push({ kind, text: value, turn: event.data?.turn, step: event.data?.step, index })
  })
}
const reasoningBlocks = blocks.filter(block => block.kind === 'reasoning')
const proseBlocks = blocks.filter(block => block.kind === 'prose')
console.log(`assistant steps: ${steps}`)
console.log(`translatable blocks: ${blocks.length}  (reasoning ${reasoningBlocks.length}, prose ${proseBlocks.length})`)
console.log(`total source: ${blocks.reduce((sum, block) => sum + block.text.length, 0)} chars\n`)

// ── the plugin's own segmentation, replayed ─────────────────────────────────
/** One growing row driven exactly like `Translator.pump`. */
function segment(full, streaming) {
  const segments = []
  let source = ''
  let sentUpTo = 0
  let sentSource = ''

  const pump = (force) => {
    if (source === '') return
    if (!source.startsWith(sentSource)) {
      sentUpTo = 0
      sentSource = ''
    }
    const rest = source.slice(sentUpTo)
    if (rest.trim() === '') return
    const { cut, sep } = pickCut(rest, streaming && !force, 1800, force)
    if (cut <= 0) return
    const value = rest.slice(0, cut).replace(/\s+$/, '')
    sentUpTo += cut
    const separator = /^\s*/.exec(source.slice(sentUpTo))
    if (separator !== null) sentUpTo += separator[0].length
    sentSource = source.slice(0, sentUpTo)
    if (value !== '') segments.push({ value, sep, boundary: sep === 'paragraph' ? 'paragraph' : sep === 'space' ? 'sentence' : 'end' })
  }

  if (!streaming) {
    source = full
    pump(true)
    // A settled row drains one paragraph per pass, just like the live loop.
    let guard = 0
    while (sentUpTo < source.length && guard < 500) {
      guard += 1
      const before = sentUpTo
      pump(true)
      if (sentUpTo === before) break
    }
    return segments
  }

  // Streaming: accumulate word by word, then flush the tail like the idle
  // timer / settle does.
  for (const word of full.match(/\S+\s*/g) ?? []) {
    source += word
    pump(false)
  }
  source = full
  pump(true)
  let guard = 0
  while (sentUpTo < source.length && guard < 500) {
    guard += 1
    const before = sentUpTo
    pump(true)
    if (sentUpTo === before) break
  }
  return segments
}

/** Accumulate a report over one block list. */
function collect(list, streaming) {
  const sizes = []
  const boundaries = { paragraph: 0, sentence: 0, end: 0 }
  const perBlock = []
  let chars = 0
  for (const block of list) {
    const segments = segment(block.text, streaming)
    chars += block.text.length
    for (const item of segments) {
      sizes.push(item.value.length)
      boundaries[item.boundary] += 1
    }
    perBlock.push({ ...block, segments: segments.length })
  }
  sizes.sort((left, right) => left - right)
  return { sizes, boundaries, perBlock, chars, requests: sizes.length }
}

const streaming = collect(blocks, true)
const settled = collect(blocks, false)

/** Print one report. */
function report(label, data) {
  const share = (limit) => `${data.sizes.filter(size => size < limit).length} (${(100 * data.sizes.filter(size => size < limit).length / Math.max(1, data.sizes.length)).toFixed(0)}%)`
  console.log(`── ${label}`)
  console.log(`   provider requests:        ${data.requests}`)
  console.log(`   chars per request:        ${(data.chars / Math.max(1, data.requests)).toFixed(0)} (mean source length)`)
  console.log(`   segment size  median/p75: ${data.sizes[Math.floor(data.sizes.length / 2)]} / ${data.sizes[Math.floor(data.sizes.length * 0.75)]} chars`)
  console.log(`   under 40 / under 80:      ${share(40)} / ${share(80)}`)
  console.log(`   cut by: paragraph ${data.boundaries.paragraph}, sentence ${data.boundaries.sentence}, tail ${data.boundaries.end}`)
  console.log(`   requests per block:       ${(data.requests / Math.max(1, data.perBlock.length)).toFixed(2)}`)
}

console.log('')
report('streaming (what the live page does)', streaming)
console.log('')
report('settled floor (finished text in one pass)', settled)

// ── the repeated system prompt ──────────────────────────────────────────────
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const prompt = /const SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\)/.exec(host)?.[1] ?? ''
const promptChars = prompt.replace(/['",\s]/g, '').length
console.log(`\n── the fixed cost per request`)
console.log(`   system prompt:            ~${promptChars} chars (~${Math.round(promptChars / 4)} tokens) sent with EVERY request`)
console.log(`   input from prompts alone: ~${Math.round(promptChars / 4) * streaming.requests} tokens for this session`)
console.log(`   input from segments:      ~${Math.round(streaming.chars / 4)} tokens`)

const worst = [...streaming.perBlock].sort((left, right) => right.segments - left.segments).slice(0, 6)
console.log(`\n── worst blocks by request count (streaming)`)
for (const block of worst) {
  console.log(`   ${block.kind.padEnd(9)} turn ${block.turn} step ${block.step}  ${String(block.text.length).padStart(6)} chars -> ${String(block.segments).padStart(3)} requests  (${(block.text.length / Math.max(1, block.segments)).toFixed(0)} chars/req)`)
}

const longTail = streaming.sizes.filter(size => size < 40).length
console.log(`\n── fragments`)
console.log(`   segments under 40 chars:  ${longTail} (${(100 * longTail / Math.max(1, streaming.sizes.length)).toFixed(0)}% of all requests)`)
console.log(`   those carry:              ${streaming.sizes.filter(size => size < 40).reduce((sum, size) => sum + size, 0)} chars of ${streaming.chars} total`)

// ── what the durable store actually has to pay for ─────────────────────────
/** Every segment value produced across the session, in order. */
const allSegments = []
for (const block of blocks) {
  for (const item of segment(block.text, true)) allSegments.push(item.value)
}
const unique = new Set(allSegments)
const uniqueChars = [...unique].reduce((sum, value) => sum + value.length, 0)
console.log(`\n── deduplication (the store pays once per unique text)`)
console.log(`   segment requests:         ${allSegments.length}`)
console.log(`   unique texts:             ${unique.size} (${(100 * unique.size / Math.max(1, allSegments.length)).toFixed(0)}%)`)
console.log(`   unique chars:             ${uniqueChars} of ${streaming.chars}`)

// ── cuts that land inside an open code fence ───────────────────────────────
let fencesInSource = 0
let segmentsStartingInFence = 0
let fenceChars = 0
for (const block of blocks) {
  const segments = segment(block.text, true)
  let open = false
  let totalFences = 0
  for (const item of segments) {
    if (open) {
      segmentsStartingInFence += 1
      fenceChars += item.value.length
    }
    const fences = (item.value.match(/```/g) ?? []).length
    totalFences += fences
    if (fences % 2 === 1) open = !open
  }
  if (totalFences > 0) fencesInSource += 1
}
console.log(`\n── code fences (a cut inside one leaves both halves unbalanced)`)
console.log(`   blocks containing fences: ${fencesInSource} of ${blocks.length}`)
console.log(`   segments starting inside an open fence: ${segmentsStartingInFence} (${fenceChars} chars)`)
