/**
 * Cut-granularity trade-off curve.
 *
 * The live engine cuts at every sentence end once 24 characters have piled up.
 * This script replays real session content through the same decision logic with
 * a larger sentence gate, so the cost of "more responsive" can be compared with
 * the cost of "cheaper" using the session's own text.
 *
 * Run: node tools/measure-granularity.mjs [sessionId]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

// ── the session blocks (same extraction as tools/measure-cost.mjs) ──────────
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionId = process.argv[2] ?? 'session-c907cee3-d5f5-4d52-a6f4-62d393687790'

/** @returns the log path for one session. */
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

/** @returns the whole log as text, decoding every concatenated frame. */
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

/** @returns `{ kind, text }` for every block the plugin translates. */
function collectBlocks() {
  const blocks = []
  for (const line of readLog(file).split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      const kind = block?.type === 'reasoning' ? 'reasoning' : block?.type === 'text' ? 'prose' : null
      if (kind === null) continue
      if (typeof block.text === 'string' && block.text.trim() !== '') blocks.push({ kind, text: block.text })
    }
  }
  return blocks
}

const blocks = collectBlocks()
const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0)
console.log(`blocks: ${blocks.length}   source: ${totalChars} chars\n`)

/** The sentence terminator scan, copied from lib/client.js. */
function findSentenceEnd(text) {
  const pattern = /(?:[。！？；：!?…]|\.(?=\s))/g
  let index = 0
  let match
  while ((match = pattern.exec(text)) !== null) index = match.index + 1
  return index
}

/**
 * `pickCut` with the paragraph gate fixed at 24 and the sentence gate tunable —
 * the only difference from the shipped function.
 * @param rest - the untranslated remainder.
 * @param minSentence - minimum pending size before a sentence cut is allowed.
 * @returns `{ cut, sep }`.
 */
function pickCutTuned(rest, minSentence, maxChars = 1800) {
  if (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const cut = boundary > maxChars * 0.4 ? boundary : maxChars
    return { cut, sep: /^\s*\n/.test(rest.slice(cut)) ? 'paragraph' : 'space' }
  }
  const paragraph = rest.lastIndexOf('\n\n')
  if (paragraph >= 24) return { cut: paragraph, sep: 'paragraph' }
  const sentence = findSentenceEnd(rest)
  if (sentence >= minSentence) return { cut: sentence, sep: 'space' }
  return { cut: 0, sep: '' }
}

/** Replay one block while streaming, at one granularity. */
function simulate(full, minSentence) {
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
    const { cut, sep } = force && minSentence > 24
      ? (rest.length <= 1800 ? { cut: rest.length, sep: '' } : pickCutTuned(rest, minSentence))
      : pickCutTuned(rest, force ? 0 : minSentence)
    if (cut <= 0) return
    const value = rest.slice(0, cut).replace(/\s+$/, '')
    sentUpTo += cut
    const separator = /^\s*/.exec(source.slice(sentUpTo))
    if (separator !== null) sentUpTo += separator[0].length
    sentSource = source.slice(0, sentUpTo)
    if (value !== '') segments.push({ value, sep })
  }

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

/** One row of the curve. */
function curveRow(label, minSentence) {
  const sizes = []
  let requests = 0
  let paragraphs = 0
  let sentences = 0
  for (const block of blocks) {
    const segments = simulate(block.text, minSentence)
    requests += segments.length
    for (const item of segments) {
      sizes.push(item.value.length)
      if (item.sep === 'paragraph') paragraphs += 1
      else if (item.sep === 'space') sentences += 1
    }
  }
  sizes.sort((left, right) => left - right)
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0
  const p75 = sizes[Math.floor(sizes.length * 0.75)] ?? 0
  console.log(
    `${label.padEnd(26)} ${String(requests).padStart(6)} req  ${(totalChars / Math.max(1, requests)).toFixed(0).padStart(5)} chars/req  `
    + `median ${String(median).padStart(4)}  p75 ${String(p75).padStart(4)}  (paragraph ${paragraphs}, sentence ${sentences})`
  )
  return { requests, median, p75 }
}

console.log('sentence-gate   requests  size              distribution')
const rows = [
  ['24 (shipped)', 24],
  ['80', 80],
  ['160', 160],
  ['320', 320],
  ['640', 640],
  ['paragraph only', Number.MAX_SAFE_INTEGER]
]
let baseline = null
for (const [label, gate] of rows) {
  const row = curveRow(label, gate)
  if (baseline === null) baseline = row.requests
  else console.log(`${''.padEnd(26)} ${(100 * row.requests / baseline).toFixed(0).padStart(5)}% of today's requests`)
}

// ── the same content, but with the sentence gate at 320 ────────────────────
console.log('\n── what a larger gate looks like on one real block')
const sample = blocks.reduce((best, block) => (block.text.length > best.text.length ? block : best), blocks[0])
for (const gate of [24, 320]) {
  const segments = simulate(sample.text, gate)
  console.log(`   gate ${String(gate).padStart(3)}: ${String(segments.length).padStart(3)} requests for ${sample.text.length} chars`)
  for (const item of segments.slice(0, 3)) {
    console.log(`            [${String(item.value.length).padStart(4)}] ${JSON.stringify(item.value.slice(0, 96))}`)
  }
  if (segments.length > 3) console.log(`            … ${segments.length - 3} more`)
}

// ── cuts that land inside an open code fence, with real examples ───────────
const fenceExamples = []
let fenceTotal = 0
for (const block of blocks) {
  let open = false
  for (const item of simulate(block.text, 24)) {
    if (open) {
      fenceTotal += 1
      if (fenceExamples.length < 2) fenceExamples.push(item.value)
    }
    const fences = (item.value.match(/```/g) ?? []).length
    if (fences % 2 === 1) open = !open
  }
}
console.log(`\n── cut inside an open code fence (sentence gate 24)`)
console.log(`   occurrences: ${fenceTotal}`)
for (const value of fenceExamples) {
  console.log(`   example: ${JSON.stringify(value.slice(0, 150))}`)
}
const after = blocks.reduce((sum, block) => sum + simulate(block.text, 320).filter(item => item.value.startsWith('```')).length, 0)
console.log(`   with a 320-char gate, how many segments still start with a fence marker: ${after}`)
