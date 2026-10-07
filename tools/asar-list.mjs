/** List package directories inside app.asar, optionally filtered. */
import fs from 'node:fs'

const [ARCHIVE, PREFIX, FILTER] = process.argv.slice(2)

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
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  fs.closeSync(fd)
  return { header: JSON.parse(text.slice(0, end)) }
}

const { header } = readHeader(ARCHIVE)
// Walk to the prefix, then list its immediate entries.
let node = header
for (const segment of PREFIX.split('/')) {
  node = node.files?.[segment]
  if (node === undefined) {
    console.error(`no such path: ${segment}`)
    process.exit(1)
  }
}
const names = Object.keys(node.files ?? {})
const filtered = FILTER === undefined ? names : names.filter(name => new RegExp(FILTER).test(name))
console.log(`${filtered.length} of ${names.length} entries:`)
for (const name of filtered.sort()) console.log(`  ${name}`)
