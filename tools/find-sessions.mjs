/**
 * One-shot: find Sessions by their stored title, with the recorded cwd and the
 * Workspace that currently owns them. Read-only.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HOME = 'C:\\Users\\Kaede\\.dsh'
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions')
const STORE = join(HOME, 'storages', 'workspace.json')

const wanted = process.argv.slice(2)
const store = JSON.parse(readFileSync(STORE, 'utf8'))
const tables = store.tables.workspaces

/** @returns the workspace record that owns a session id. */
function ownerOf(sessionId) {
  for (const [id, record] of Object.entries(tables)) {
    if (record.sessionIds?.includes(sessionId)) return `${record.title} (${id})`
  }
  return '(ungrouped)'
}

const rows = []
for (const name of readdirSync(CACHE)) {
  if (!name.endsWith('.json')) continue
  const id = name.slice(0, -'.json'.length)
  let doc
  try {
    doc = JSON.parse(readFileSync(join(CACHE, name), 'utf8'))
  } catch {
    continue
  }
  const title = doc?.record?.rows?.title?.val
  if (typeof title !== 'string') continue
  if (wanted.length > 0 && !wanted.some(needle => title.includes(needle))) continue
  rows.push({ id, title, owner: ownerOf(id) })
}

rows.sort((left, right) => left.title.localeCompare(right.title, 'zh'))
for (const row of rows) {
  console.log(`"${row.title}"`)
  console.log(`   ${row.id}`)
  console.log(`   owner: ${row.owner}`)
}

console.log(`\nworkspaces:`)
for (const id of store.global.workspaceIds) {
  const record = tables[id]
  const path = record?.path ?? '(missing)'
  console.log(`   ${String(record?.title ?? id).padEnd(20)} ${record?.sessionIds?.length ?? 0} session(s)  exists=${existsSync(path)}`)
  console.log(`       ${path}`)
}
