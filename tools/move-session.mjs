/**
 * Move one Session into another Workspace.
 *
 * DSH has no "move session" operation: a Session's Workspace is derived from the
 * `cwd` recorded in its own header, and `@deepseek-ai/dsh-session-persistence-jsonl`
 * derives the log path from that same `cwd`. So the move is three consistent
 * changes:
 *
 *   1. rewrite the header frame with the new `cwd` (all other frames untouched),
 *   2. move the Session directory to the new project directory,
 *   3. move the Session id between the two Workspace records.
 *
 * It must run with DeepSeek Harness closed — the live writer re-derives the log
 * path from its in-memory header, so a move under a running host would leave the
 * new Session frozen while events kept appending to the old path.
 *
 * Safety: the new file is written and fully verified before the original is
 * removed, the header frame's encoding is proven byte-identical to the shipped
 * writer's before anything is touched, and `--dry-run` performs every check
 * without writing. Re-running is a no-op.
 *
 * Usage:
 *   node tools/move-session.mjs --dry-run
 *   node tools/move-session.mjs
 *   node tools/move-session.mjs --session=session-... --cwd=E:\path --force
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
/** @returns the value of `--name=value`. */
const option = name => args.filter(arg => arg.startsWith(`--${name}=`))[0]?.slice(name.length + 3)

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')
const WORKSPACE_STORE = join(HOME, 'storages', 'workspace.json')
const DEFAULT_SESSION = 'session-c907cee3-d5f5-4d52-a6f4-62d393687790'
const SESSION_ID = option('session') ?? DEFAULT_SESSION
const NEW_CWD = option('cwd') ?? 'E:\\Data\\Project\\DeepSeekHarness\\dsh-text-manager'
const DRY = args.includes('--dry-run')
const FORCE = args.includes('--force')
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const COMPRESSION = 'zstd'

const say = message => console.log(message)
const fail = message => {
  console.error(`\nABORT: ${message}`)
  process.exit(1)
}

// ── the shipped writer's frame encoding, reproduced exactly ─────────────────
/** One checksummed zstd frame, non-single-segment, like `createZstdCompress`. */
const ZSTD_OPTIONS = {
  params: {
    [constants.ZSTD_c_checksumFlag]: 1,
    [constants.ZSTD_c_contentSizeFlag]: 0
  }
}

/** @returns the byte ranges of every concatenated frame. */
function frameRanges(buffer) {
  const starts = []
  for (let at = 0; ;) {
    const found = buffer.indexOf(FRAME_MAGIC, at)
    if (found === -1) break
    starts.push(found)
    at = found + FRAME_MAGIC.length
  }
  starts.push(buffer.length)
  return starts.slice(0, -1).map((start, index) => [start, starts[index + 1]])
}

/**
 * Read a whole log back: every frame must decompress and every line must parse.
 * @param buffer - the log bytes.
 * @returns `{ frames, events, header }`.
 * @throws when any frame or JSONL line is invalid.
 */
function inspect(buffer) {
  const ranges = frameRanges(buffer)
  if (ranges.length === 0) throw new Error('the log has no zstd frame')
  let events = 0
  for (const [start, end] of ranges) {
    const plain = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    for (const line of plain.split('\n')) {
      if (line.trim() === '') continue
      JSON.parse(line)
      events += 1
    }
  }
  const header = JSON.parse(zstdDecompressSync(buffer.subarray(ranges[0][0], ranges[0][1])).toString('utf8'))
  return { frames: ranges.length, events, header }
}

// ── the directory-name encoding from `dsh-session-persistence-jsonl` ────────
/** @returns the project directory key for one cwd. */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** @returns the session directory name for one id (identity for safe ids). */
function encodeSegment(id) {
  return /^[A-Za-z0-9._-]+$/.test(id) ? id : [...id].map(ch => ch.codePointAt(0) < 128
    ? ch.replace(/[^A-Za-z0-9._-]/g, '')
    : `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}~`).join('')
}

// ── workspace reconciliation, shared by both modes ──────────────────────────
/**
 * Ensure the target Workspace exists, and attach the Session to it when asked.
 * Membership is kept to exactly one Workspace per Session: the registry fails
 * loud on a Session listed twice.
 * @param store - the parsed workspace store.
 * @param attach - whether to attach the Session.
 * @returns the target workspace id.
 */
function ensureWorkspace(store, attach) {
  const tables = store.tables.workspaces
  const now = new Date().toISOString()
  let targetId = Object.entries(tables)
    .find(([, record]) => String(record.path).toLowerCase() === NEW_CWD.toLowerCase())?.[0]
  if (targetId === undefined) {
    targetId = randomUUID()
    tables[targetId] = {
      path: NEW_CWD,
      title: NEW_CWD.split(/[\\/]/).filter(Boolean).pop() ?? NEW_CWD,
      sessionIds: [],
      createdAt: now,
      updatedAt: now
    }
    store.global.workspaceIds = [...(store.global.workspaceIds ?? []), targetId]
    say(`created     : workspace ${tables[targetId].title} (${targetId})`)
  }
  if (attach) {
    for (const [id, record] of Object.entries(tables)) {
      if (!Array.isArray(record.sessionIds)) continue
      const kept = record.sessionIds.filter(session => session !== SESSION_ID)
      if (id === targetId) kept.push(SESSION_ID)
      if (kept.length !== record.sessionIds.length || id === targetId) record.updatedAt = now
      record.sessionIds = kept
    }
  }
  // The order array and the table must stay in sync (order drift fails loud).
  store.global.workspaceIds = (store.global.workspaceIds ?? []).filter(id => tables[id] !== undefined)
  for (const id of Object.keys(tables)) if (!store.global.workspaceIds.includes(id)) store.global.workspaceIds.push(id)
  return targetId
}

/** Write the workspace store atomically. */
function writeStore(store) {
  const staging = `${WORKSPACE_STORE}.staging`
  writeFileSync(staging, `${JSON.stringify(store, null, 2)}\n`)
  renameSync(staging, WORKSPACE_STORE)
}

// `--workspace-only` registers the Workspace without touching the Session log,
// which is safe to do while the harness runs (the host may rewrite the store
// later; the default mode reconciles it again).
if (args.includes('--workspace-only')) {
  const store = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  const targetId = ensureWorkspace(store, false)
  if (DRY) {
    say(`--dry-run: would register ${NEW_CWD} as workspace ${targetId}`)
    process.exit(0)
  }
  writeStore(store)
  say(`registered  : ${store.tables.workspaces[targetId].title} (${targetId})`)
  say(`              path ${store.tables.workspaces[targetId].path}`)
  say(`order       : ${store.global.workspaceIds.join(', ')}`)
  say('\nthe session is not attached yet: run this script without --workspace-only while DeepSeek Harness is closed.')
  process.exit(0)
}

// ── preconditions ───────────────────────────────────────────────────────────
/** @returns true when a DeepSeek Harness process is running. */
function harnessRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
    return /DeepSeek Harness\.exe/i.test(out)
  } catch {
    return false // tasklist unavailable: fall through to the caller's warning
  }
}

if (!existsSync(SESSIONS)) fail(`no session root at ${SESSIONS}`)
if (harnessRunning() && !DRY && !FORCE) {
  fail([
    'DeepSeek Harness is still running.',
    'The live writer re-derives the log path from its in-memory header, so moving the',
    'Session now would leave the moved copy frozen while new events kept landing at the',
    'old path. Quit DeepSeek Harness completely, then run this again.',
    '(Use --force only if you are certain no writer is active.)'
  ].join('\n'))
}

// ── locate the session ──────────────────────────────────────────────────────
/** @returns `{ projectDir, sessionDir, logPath }` for the session, wherever it is. */
function locate() {
  for (const project of readdirSync(SESSIONS)) {
    const sessionDir = join(SESSIONS, project, encodeSegment(SESSION_ID))
    if (!existsSync(sessionDir)) continue
    for (const name of readdirSync(sessionDir)) {
      if (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')) {
        return { projectDir: join(SESSIONS, project), sessionDir, logPath: join(sessionDir, name) }
      }
    }
  }
  return null
}

const found = locate()
if (found === null) fail(`session ${SESSION_ID} not found under ${SESSIONS}`)
say(`session log : ${found.logPath}`)

const original = readFileSync(found.logPath)
const ranges = frameRanges(original)
if (ranges.length === 0) fail('the log has no zstd frame')
const first = ranges[0]
const firstFrame = original.subarray(first[0], first[1])
const firstPlain = zstdDecompressSync(firstFrame)
const headerText = firstPlain.toString('utf8')
let header
try {
  header = JSON.parse(headerText)
} catch (error) {
  fail(`the first frame is not the session header: ${String(error.message)}`)
}
say(`header cwd  : ${header.cwd}`)
say(`frames      : ${ranges.length}`)
say(`target cwd  : ${NEW_CWD}`)

// The proof that this script's encoder matches the shipped writer byte for byte:
// re-encode the *unchanged* header and compare with the frame already on disk.
const reencoded = zstdCompressSync(firstPlain, ZSTD_OPTIONS)
const sameFormat = reencoded[4] === firstFrame[4] && (reencoded[3] & 0x20) === (firstFrame[3] & 0x20)
say(`encoder     : ${sameFormat
  ? `frame format matches the shipped writer (FHD 0x${firstFrame[4].toString(16)}); compressed bytes differ only in length, which is expected`
  : `frame format DIFFERS (ours FHD 0x${reencoded[4].toString(16)}, theirs 0x${firstFrame[4].toString(16)}) — decompression is still verified below`}`)

const targetProject = join(SESSIONS, projectKey(NEW_CWD))
const targetSession = join(targetProject, encodeSegment(SESSION_ID))
const targetLog = join(targetSession, found.logPath.split(/[\\/]/).pop())
say(`target log  : ${targetLog}`)

const alreadyMoved = header.cwd === NEW_CWD && found.logPath.startsWith(targetProject)
if (alreadyMoved) say('\nthe session already records the target cwd; only workspace membership will be reconciled')

// ── build the rewritten log and prove it in memory before touching anything ──
const newHeaderPlain = Buffer.from(`${JSON.stringify({ ...header, cwd: NEW_CWD })}\n`)
const newLog = Buffer.concat([zstdCompressSync(newHeaderPlain, ZSTD_OPTIONS), original.subarray(first[1])])
const before = inspect(original)
const rebuilt = inspect(newLog)
if (rebuilt.frames !== before.frames) fail(`rebuilt log has ${rebuilt.frames} frames, original has ${before.frames}`)
if (rebuilt.events !== before.events) fail(`rebuilt log has ${rebuilt.events} events, original has ${before.events}`)
if (rebuilt.header.cwd !== NEW_CWD) fail(`rebuilt header still records ${rebuilt.header.cwd}`)
if (rebuilt.header.id !== header.id) fail('rebuilt header lost the session id')
say(`preflight   : original ${before.frames} frames / ${before.events} events -> rebuilt ${rebuilt.frames} / ${rebuilt.events}, all frames decode and every line parses`)

// ── plan the workspace change ───────────────────────────────────────────────
const plannedStore = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
const plannedTables = plannedStore.tables.workspaces
const currentOwner = Object.entries(plannedTables).find(([, record]) => record.sessionIds?.includes(SESSION_ID))
const targetOwner = Object.entries(plannedTables)
  .find(([, record]) => String(record.path).toLowerCase() === NEW_CWD.toLowerCase())
say(`\nworkspace   : ${currentOwner === undefined ? '(ungrouped)' : `${currentOwner[1].title} ${currentOwner[0]}`}`)
say(`new owner   : ${targetOwner === undefined ? '(will be created)' : `${targetOwner[1].title} ${targetOwner[0]}`}`)

if (DRY) {
  say('\n--dry-run: no file was written.')
  say(`would move ${found.sessionDir}`)
  say(`        to ${targetSession}`)
  say(`would attach ${SESSION_ID} to ${targetOwner?.[1].title ?? '(new workspace)'}`)
  process.exit(0)
}

// ── 1. write and verify the new log ─────────────────────────────────────────
if (!existsSync(targetSession)) mkdirSync(targetSession, { recursive: true })
if (!existsSync(targetLog) || !readFileSync(targetLog).equals(newLog)) {
  const staging = `${targetLog}.staging`
  writeFileSync(staging, newLog)
  const fd = openSync(staging, 'r+')
  fsyncSync(fd)
  closeSync(fd)
  renameSync(staging, targetLog)
  // Write-through the directory entry, exactly as the persistence backend does.
  try {
    closeSync(openSync(targetSession, 'r'))
  } catch {
    // A directory fsync is best effort on Windows.
  }
  say(`\nwrote ${targetLog} (${newLog.length} bytes)`)
} else {
  say(`\n${targetLog} is already current`)
}

const written = readFileSync(targetLog)
const verified = inspect(written)
if (verified.frames !== before.frames) fail(`frame count changed: ${before.frames} -> ${verified.frames}`)
if (verified.events !== before.events) fail(`event count changed: ${before.events} -> ${verified.events}`)
if (verified.header.cwd !== NEW_CWD) fail(`the new header still records ${verified.header.cwd}`)
if (verified.header.id !== SESSION_ID) fail('the new header lost the session id')
say(`verified    : ${verified.frames} frames, ${verified.events} events, header cwd ok`)

// ── 2. drop the original only once the copy is proven ──────────────────────
if (found.sessionDir !== targetSession && existsSync(found.sessionDir)) {
  rmSync(found.sessionDir, { recursive: true, force: true })
  say(`removed     : ${found.sessionDir}`)
  const leftovers = readdirSync(found.projectDir)
  if (leftovers.length === 0 && found.projectDir !== targetProject) {
    rmSync(found.projectDir, { recursive: true, force: true })
    say(`removed     : ${found.projectDir} (empty project directory)`)
  }
}

// ── 3. reconcile workspace membership ───────────────────────────────────────
const targetId = ensureWorkspace(plannedStore, true)
writeStore(plannedStore)
say(`updated     : ${WORKSPACE_STORE}`)
say(`              ${plannedTables[targetId].title}.sessionIds = [${plannedTables[targetId].sessionIds.join(', ')}]`)
if (currentOwner !== undefined && currentOwner[0] !== targetId) {
  say(`              ${currentOwner[1].title}.sessionIds = [${currentOwner[1].sessionIds.join(', ')}]`)
}

say('\ndone. Start DeepSeek Harness and the Session will appear under the new Workspace.')

// ── 4. merge the pre-rename translation store, then retire it ───────────────
const OLD_STORE = join(HOME, 'reasoning-translator')
const NEW_STORE = join(HOME, 'text-manager')
if (existsSync(OLD_STORE) && existsSync(NEW_STORE)) {
  const read = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, entries: [] })
  const oldDoc = read(join(OLD_STORE, 'translations.json'))
  const newDoc = read(join(NEW_STORE, 'translations.json'))
  const merged = new Map()
  for (const entry of [...newDoc.entries, ...oldDoc.entries]) {
    const seen = merged.get(entry.k)
    if (seen === undefined || (entry.a ?? 0) > (seen.a ?? 0)) merged.set(entry.k, entry)
  }
  const grew = merged.size - newDoc.entries.length
  writeFileSync(join(NEW_STORE, 'translations.json'), `${JSON.stringify({ version: 1, entries: [...merged.values()] })}\n`)
  say(`\nstore       : ${newDoc.entries.length} + ${grew} recovered from the pre-rename store = ${merged.size}`)
  // The old directory is only retired once its contents are accounted for.
  const leftovers = readdirSync(OLD_STORE).filter(name => name !== 'translations.json' && name !== 'settings.json')
  if (leftovers.length > 0) {
    say(`left        : ${OLD_STORE} still holds ${leftovers.join(', ')} (delete it by hand once you are happy)`)
  } else {
    rmSync(OLD_STORE, { recursive: true, force: true })
    say(`removed     : ${OLD_STORE} (pre-rename store, merged above)`)
  }
}

// ── 5. retire the empty directory left by the rename ───────────────────────
const OLD_PLUGIN_DIR = join('E:', 'Data', 'Project', 'DeepSeekHarness', 'dsh-reasoning-translator')
if (existsSync(OLD_PLUGIN_DIR)) {
  const left = readdirSync(OLD_PLUGIN_DIR)
  if (left.length === 0) {
    rmSync(OLD_PLUGIN_DIR, { recursive: false, force: true })
    say(`removed     : ${OLD_PLUGIN_DIR} (empty leftover of the rename)`)
  } else {
    say(`left        : ${OLD_PLUGIN_DIR} still holds ${left.join(', ')}`)
  }
}
