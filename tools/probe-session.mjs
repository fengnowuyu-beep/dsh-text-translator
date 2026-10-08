/**
 * One-shot diagnostic: print the last few assistant steps of a session, with the
 * block kinds and a short preview of every text/reasoning block. Read-only.
 *
 * Run: node tools/probe-session.mjs [sessionId] [steps]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? 'C:\\Users\\Kaede\\.dsh'
const SESSION_ID = process.argv[2] ?? 'session-c907cee3-d5f5-4d52-a6f4-62d393687790'
const WANT = Number(process.argv[3] ?? 4)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** @returns the session log path, wherever its project directory is. */
function locate() {
  const root = join(HOME, 'sessions')
  for (const project of readdirSync(root)) {
    const dir = join(root, project, SESSION_ID)
    if (!existsSync(dir)) continue
    const frames = readdirSync(dir).filter(name => name.endsWith('.jsonl.zstd'))
    if (frames.length > 0) return join(dir, frames[0])
  }
  return null
}

const file = locate()
if (file === null) {
  console.error(`no log for ${SESSION_ID}`)
  process.exit(1)
}
const buffer = readFileSync(file)
const offsets = []
for (let at = 0; ;) {
  const found = buffer.indexOf(MAGIC, at)
  if (found === -1) break
  offsets.push(found)
  at = found + MAGIC.length
}
offsets.push(buffer.length)

const messages = []
for (let index = 0; index < offsets.length - 1; index += 1) {
  let plain
  try {
    plain = zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1])).toString('utf8')
  } catch {
    continue
  }
  for (const line of plain.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    messages.push({ turn: event.data?.turn, step: event.data?.step, content: event.data?.message?.content ?? [] })
  }
}

console.log(`session: ${SESSION_ID}`)
console.log(`assistant steps: ${messages.length}`)
const tail = messages.slice(-WANT)
for (const message of tail) {
  const blocks = message.content.map(block => block.type ?? block.kind)
  console.log(`\n── turn ${message.turn} step ${message.step}  blocks: [${blocks.join(', ')}]`)
  message.content.forEach((block, index) => {
    const kind = block.type ?? block.kind
    if (kind !== 'text' && kind !== 'reasoning') {
      const name = block.name ?? block.toolName ?? ''
      console.log(`   [${index}] ${kind}${name === '' ? '' : ` ${name}`}`)
      return
    }
    const text = typeof block.text === 'string' ? block.text : ''
    const sample = text.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`   [${index}] ${kind} (${text.length} chars): ${sample}`)
  })
}
