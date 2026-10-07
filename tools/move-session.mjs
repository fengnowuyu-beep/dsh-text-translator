/**
 * Move Sessions into another Workspace.
 *
 * DSH has no "move session" operation: a Session's Workspace is derived from the
 * `cwd` recorded in its own header, and `@deepseek-ai/dsh-session-persistence-jsonl`
 * derives the log path from that same `cwd`. So a move is three consistent
 * changes per Session:
 *
 *   1. rewrite the header frame with the new `cwd` (all other frames untouched),
 *   2. move the Session directory to the new project directory,
 *   3. move the Session ids between Workspace records.
 *
 * It must run with DeepSeek Harness closed — the live writer re-derives the log
 * path from its in-memory header on every append, so a move under a running host
 * would leave the moved copy frozen while events kept landing at the old path.
 *
 * Safety: each new file is written and fully verified before its original is
 * removed, the header frame encoding is compared against the shipped writer's
 * before anything is touched, `--dry-run` performs every check without writing,
 * and a Workspace is never dropped while it still owns a Session or while its
 * directory exists.
 *
 * Usage:
 *   node tools/move-session.mjs --dry-run
 *   node tools/move-session.mjs
 *   node tools/move-session.mjs --session=id1,id2,id3 --cwd=E:\path
 *   node tools/move-session.mjs --workspace-only            # register the Workspace only
 *   node tools/move-session.mjs --drop-workspace=E:\old\path
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
/** @returns the first `--name=value`, or undefined. */
const option = name => args.filter(arg => arg.startsWith(`--${name}=`))[0]?.slice(name.length + 3)
/** @returns every `--name=value` value, in order. */
const options = name => args.filter(arg => arg.startsWith(`--${name}=`)).map(arg => arg.slice(name.length + 3))

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')
const WORKSPACE_STORE = join(HOME, 'storages', 'workspace.json')
const DEFAULT_SESSIONS = [
  'session-c907cee3-d5f5-4d52-a6f4-62d393687790', // DeepSeek思考过程翻译插件 (this one)
  'session-6f61ee46-4646-425b-983e-4cb4c1ab3fc5', // DSH 自用工具库插件需求
  'session-1e3c5b8c-4cac-4efe-9f80-b987db68190a' // dsh对话通知插件
].join(',')
/**
 * Workspaces this migration retires: the plugin directory each one pointed at
 * has moved under the container, so the record is obsolete once its Sessions
 * have been re-homed. Only dropped when it owns no Session and its directory is
 * gone.
 */
const DEFAULT_DROP = ['E:\\Data\\Project\\DeepSeekHarness\\dsh-text-manager']

const SESSION_IDS = (options('session').join(',') || DEFAULT_SESSIONS).split(',').map(id => id.trim()).filter(Boolean)
const NEW_CWD = option('cwd') ?? 'E:\\Data\\Project\\DeepSeekHarness\\DSH-Homemade-Plugins'
const DROP_PATHS = options('drop-workspace').length > 0 ? options('drop-workspace') : DEFAULT_DROP
const DRY = args.includes('--dry-run')
const FORCE = args.includes('--force')
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZIP_ALL = 'workspace-only'

const say = message => console.log(message)
const fail = message => {
  console.error(`\nABORT: ${message}`)
  process.exit(1)
}

// ── the shipped writer's frame encoding, reproduced exactly ─────────────────
/** One checksummed zstd frame, non-segment-single, like `createZstdCompress`. */
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

// ── workspace store helpers ─────────────────────────────────────────────────
/**
 * Ensure the target Workspace exists, and attach the Sessions to it when asked.
 * Membership is kept to exactly one Workspace per Session: the registry fails
 * loud on a Session listed twice.
 * @param store - the parsed workspace store.
 * @param attach - whether to attach the Sessions.
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
      const kept = record.sessionIds.filter(session => !SESSION_IDS.includes(session))
      if (id === targetId) kept.push(...SESSION_IDS.filter(session => !kept.includes(session)))
      if (kept.length !== record.sessionIds.length || id === targetId) record.updatedAt = now
      record.sessionIds = kept
    }
  }
  // The order array and the table must stay in sync (order drift fails loud).
  store.global.workspaceIds = (store.global.workspaceIds ?? []).filter(id => tables[id] !== undefined)
  for (const id of Object.keys(tables)) if (!store.global.workspaceIds.includes(id)) store.global.workspaceIds.push(id)
  return targetId
}

/**
 * Drop Workspaces that are now meaningless. A record is only removed when its
 * directory is gone *and* it owns no Session, so a temporarily unreachable
 * directory can never cost anyone their grouping.
 * @param store - the parsed workspace store.
 * @param paths - the workspace paths to consider.
 * @returns report lines.
 */
function dropWorkspaces(store, paths) {
  const wanted = paths.map(path => path.toLowerCase())
  const notes = []
  const tables = store.tables.workspaces
  for (const [id, record] of Object.entries(tables)) {
    if (!wanted.includes(String(record.path).toLowerCase())) continue
    if ((record.sessionIds ?? []).length > 0) {
      notes.push(`kept        : ${record.title} (${id}) — still owns ${record.sessionIds.length} session(s)`)
      continue
    }
    if (existsSync(record.path)) {
      notes.push(`kept        : ${record.title} (${id}) — its directory still exists`)
      continue
    }
    delete tables[id]
    store.global.workspaceIds = (store.global.workspaceIds ?? []).filter(entry => entry !== id)
    notes.push(`dropped     : workspace ${record.title} (${id}) — directory gone, no sessions`)
  }
  return notes
}

/** Write the workspace store atomically. */
function writeStore(store) {
  const staging = `${WORKSPACE_STORE}.staging`
  writeFileSync(staging, `${JSON.stringify(store, null, 2)}\n`)
  renameSync(staging, WORKSPACE_STORE)
}

// `--workspace-only` registers the Workspace without touching any Session log,
// which is safe to do while the harness runs (the host may rewrite the store
// later; the default mode reconciles it again).
if (args.includes(`--${ZIP_ALL}`)) {
  const store = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  const targetId = ensureWorkspace(store, false)
  const notes = dropWorkspaces(store, DROP_PATHS)
  if (DRY) {
    say(`--dry-run: would register ${NEW_CWD} as workspace ${targetId}`)
    for (const note of notes) say(note)
    process.exit(0)
  }
  writeStore(store)
  say(`registered  : ${store.tables.workspaces[targetId].title} (${targetId})`)
  say(`              path ${store.tables.workspaces[targetId].path}`)
  for (const note of notes) say(note)
  say(`order       : ${store.global.workspaceIds.join(', ')}`)
  process.exit(0)
}

// ── preconditions ───────────────────────────────────────────────────────────
/** @returns true when a DeepSeek Harness process is running. */
function harnessRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
    return /DeepSeek Harness\.exe/i.test(out)
  } catch {
    return false
  }
}

if (!existsSync(SESSIONS)) fail(`no session root at ${SESSIONS}`)
if (harnessRunning() && !DRY && !FORCE) {
  fail([
    'DeepSeek Harness is still running.',
    'The live writer re-derives the log path from its in-memory header, so moving a',
    'Session now would leave the moved copy frozen while new events kept landing at the',
    'old path. Quit DeepSeek Harness completely, then run this again.',
    '(Use --force only if you are certain no writer is active.)'
  ].join('\n'))
}

// ── plan every Session ──────────────────────────────────────────────────────
/** @returns `{ projectDir, sessionDir, logPath }` for one session, or null. */
function locate(sessionId) {
  for (const project of readdirSync(SESSIONS)) {
    const sessionDir = join(SESSIONS, project, encodeSegment(sessionId))
    if (!existsSync(sessionDir)) continue
    for (const name of readdirSync(sessionDir)) {
      if (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')) {
        return { projectDir: join(SESSIONS, project), sessionDir, logPath: join(sessionDir, name) }
      }
    }
  }
  return null
}

const targetProject = join(SESSIONS, projectKey(NEW_CWD))
/** @type {Array<object>} */
const plans = []
for (const sessionId of SESSION_IDS) {
  const found = locate(sessionId)
  if (found === null) fail(`session ${sessionId} not found under ${SESSIONS}`)
  const original = readFileSync(found.logPath)
  const ranges = frameRanges(original)
  const first = ranges[0]
  if (first === undefined) fail(`${sessionId}: the log has no zstd frame`)
  const firstPlain = zstdDecompressSync(original.subarray(first[0], first[1]))
  const header = JSON.parse(firstPlain.toString('utf8'))
  const targetSession = join(targetProject, encodeSegment(sessionId))
  const newLog = Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify({ ...header, cwd: NEW_CWD })}\n`), ZSTD_OPTIONS),
    original.subarray(first[1])
  ])
  const before = inspect(original)
  const rebuilt = inspect(newLog)
  if (rebuilt.frames !== before.frames) fail(`${sessionId}: rebuilt log has ${rebuilt.frames} frames, original has ${before.frames}`)
  if (rebuilt.events !== before.events) fail(`${sessionId}: rebuilt log has ${rebuilt.events} events, original has ${before.events}`)
  if (rebuilt.header.cwd !== NEW_CWD) fail(`${sessionId}: rebuilt header still records ${rebuilt.header.cwd}`)
  if (rebuilt.header.id !== header.id) fail(`${sessionId}: rebuilt header lost the session id`)
  const reencoded = zstdCompressSync(firstPlain, ZSTD_OPTIONS)
  plans.push({
    sessionId,
    found,
    header,
    original,
    newLog,
    first,
    before,
    rebuilt,
    targetSession,
    targetLog: join(targetSession, found.logPath.split(/[\\/]/).pop()),
    formatMatches: reencoded[4] === original[first[0] + 4] && (reencoded[3] & 0x20) === (original[first[0] + 3] & 0x20)
  })
}

const store = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
const tables = store.tables.workspaces
const targetOwner = Object.entries(tables)
  .find(([, record]) => String(record.path).toLowerCase() === NEW_CWD.toLowerCase())

say(`target      : ${NEW_CWD}`)
say(`project dir : ${targetProject}`)
say(`sessions    : ${plans.length}`)
for (const plan of plans) {
  const owner = Object.entries(tables).find(([, record]) => record.sessionIds?.includes(plan.sessionId))
  say(`\n  ${plan.sessionId}`)
  say(`    cwd       : ${plan.header.cwd}`)
  say(`    owner     : ${owner === undefined ? '(ungrouped)' : `${owner[1].title} (${owner[0]})`}`)
  say(`    frames    : ${plan.before.frames} / ${plan.before.events} events`)
  say(`    encoder   : ${plan.formatMatches
    ? `frame format matches the shipped writer (FHD 0x${plan.original[plan.first[0] + 4].toString(16)})`
    : 'frame format differs — decompression is still verified'}`)
  say(`    log       : ${plan.found.logPath}`)
  say(`             -> ${plan.targetLog}`)
  say(`    rebuilt   : ${plan.rebuilt.frames} frames / ${plan.rebuilt.events} events, every line parses`)
}
say(`\nworkspace   : ${targetOwner === undefined ? '(will be created)' : `${targetOwner[1].title} ${targetOwner[0]}`}`)

if (DRY) {
  const preview = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
  ensureWorkspace(preview, true)
  const notes = dropWorkspaces(preview, DROP_PATHS)
  say('\n--dry-run: no file was written.')
  say(`would attach ${SESSION_IDS.join(', ')} to the target workspace`)
  for (const note of notes) say(note)
  process.exit(0)
}

// ── apply: write and verify, then drop the original ─────────────────────────
for (const plan of plans) {
  if (!existsSync(plan.targetSession)) mkdirSync(plan.targetSession, { recursive: true })
  if (!existsSync(plan.targetLog) || !readFileSync(plan.targetLog).equals(plan.newLog)) {
    const staging = `${plan.targetLog}.staging`
    writeFileSync(staging, plan.newLog)
    const fd = openSync(staging, 'r+')
    fsyncSync(fd)
    closeSync(fd)
    renameSync(staging, plan.targetLog)
    try {
      closeSync(openSync(plan.targetSession, 'r'))
    } catch {
      // A directory fsync is best effort on Windows.
    }
  }
  const verified = inspect(readFileSync(plan.targetLog))
  if (verified.frames !== plan.before.frames) fail(`${plan.sessionId}: frame count changed to ${verified.frames}`)
  if (verified.events !== plan.before.events) fail(`${plan.sessionId}: event count changed to ${verified.events}`)
  if (verified.header.cwd !== NEW_CWD) fail(`${plan.sessionId}: the new header still records ${verified.header.cwd}`)
  if (verified.header.id !== plan.sessionId) fail(`${plan.sessionId}: the new header lost the session id`)
  say(`wrote       : ${plan.targetLog}`)
  say(`verified    : ${verified.frames} frames, ${verified.events} events`)

  if (plan.found.sessionDir !== plan.targetSession && existsSync(plan.found.sessionDir)) {
    rmSync(plan.found.sessionDir, { recursive: true, force: true })
    say(`removed     : ${plan.found.sessionDir}`)
    if (existsSync(plan.found.projectDir) && readdirSync(plan.found.projectDir).length === 0
      && plan.found.projectDir !== targetProject) {
      rmSync(plan.found.projectDir, { recursive: true, force: true })
      say(`removed     : ${plan.found.projectDir} (empty project directory)`)
    }
  }
}

// ── reconcile workspace membership ──────────────────────────────────────────
say('')
const targetId = ensureWorkspace(store, true)
for (const note of dropWorkspaces(store, DROP_PATHS)) say(note)
writeStore(store)
say(`updated     : ${WORKSPACE_STORE}`)
for (const id of store.global.workspaceIds) {
  const record = tables[id]
  say(`              ${String(record.title).padEnd(20)} ${record.sessionIds.length} session(s)`)
}

say('\ndone. Start DeepSeek Harness and the Sessions will appear under the new Workspace.')
