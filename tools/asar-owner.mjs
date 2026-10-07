/**
 * Map a raw byte offset inside app.asar to the file that contains it, and print
 * the surrounding text — used to find which shipped file defines a theme token.
 *
 * Run: node tools/asar-owner.mjs <archive> <needle>
 */
import fs from 'node:fs'

const [ARCHIVE, NEEDLE] = process.argv.slice(2)

/** @returns the header table plus the data section base offset. */
function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const size = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(size)
  fs.readSync(fd, headerBuf, 0, size, 8)
  const start = headerBuf.indexOf(0x7b)
  const text = headerBuf.subarray(start).toString('utf8')
  let depth = 0
  let end = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  fs.closeSync(fd)
  return { header: JSON.parse(text.slice(0, end)), base: 8 + size }
}

const { header, base } = readHeader(ARCHIVE)
const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else files.push({ path: p, size: Number(entry.size), offset: Number(entry.offset), unpacked: entry.unpacked })
  }
}
walk(header, '')
console.log(`files in archive: ${files.length}`)

const needle = Buffer.from(NEEDLE)
const fd = fs.openSync(ARCHIVE, 'r')
const size = fs.fstatSync(fd).size
const found = new Map()
const chunk = 8 * 1024 * 1024
let carry = Buffer.alloc(0)
for (let off = 0; off < size && found.size < 12; off += chunk) {
  const len = Math.min(chunk, size - off)
  const buf = Buffer.alloc(len)
  fs.readSync(fd, buf, 0, len, off)
  const hay = Buffer.concat([carry, buf])
  const hayBase = off - carry.length
  let i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) {
    const absolute = hayBase + i
    const owner = files.find(f => !f.unpacked && absolute >= base + f.offset && absolute < base + f.offset + f.size)
    const key = owner?.path ?? '(not in a packed file)'
    if (!found.has(key)) {
      found.set(key, absolute)
      console.log(`\n${key}`)
      console.log(`  at absolute ${absolute}, file offset ${absolute - base - (owner?.offset ?? 0)}`)
      const context = Buffer.alloc(240)
      fs.readSync(fd, context, 0, 240, Math.max(0, absolute - 60))
      console.log(`  context: ${context.toString('utf8').replace(/\n/g, ' ').slice(0, 220)}`)
    }
    i += needle.length
  }
  carry = hay.subarray(Math.max(0, hay.length - needle.length))
}
fs.closeSync(fd)
if (found.size === 0) console.log('needle not found')
