// Minimal @electron/asar reader: extract selected subtrees to a target dir.
import fs from 'node:fs'
import path from 'node:path'

const [ARCHIVE, PREFIX, OUTDIR] = process.argv.slice(2)
const LOG = path.join(OUTDIR, '..', 'extract.log.txt')
const lines = []
const say = (...a) => lines.push(a.join(' '))

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
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  fs.closeSync(fd)
  return { header: JSON.parse(text.slice(0, end)), base: 8 + size }
}

const { header, base } = readHeader(ARCHIVE)
const all = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else all.push({ path: p, size: Number(entry.size), offset: Number(entry.offset), unpacked: entry.unpacked })
  }
}
walk(header, '')
const selected = all.filter(f => f.path.startsWith(PREFIX + '/'))
const fd = fs.openSync(ARCHIVE, 'r')
let n = 0
for (const f of selected) {
  if (f.unpacked) continue
  const rel = f.path.slice(PREFIX.length + 1)
  const dest = path.join(OUTDIR, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const buf = Buffer.alloc(f.size)
  if (f.size > 0) fs.readSync(fd, buf, 0, f.size, base + f.offset)
  fs.writeFileSync(dest, buf)
  n++
}
fs.closeSync(fd)
say(`extracted ${n} files from ${PREFIX} to ${OUTDIR}`)
fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
