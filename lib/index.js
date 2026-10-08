/**
 * dsh-text-manager - host half.
 *
 * Owns everything the browser half must not own:
 *
 *  - the persisted settings document (`<DSH_HOME>/text-manager/settings.json`),
 *  - the DeepSeek (OpenAI-compatible) chat-completions call, including the
 *    translation system prompt, timeouts, an in-memory segment cache and a
 *    small concurrency gate,
 *  - the same-origin JSON route family the browser half posts to.
 *
 * Doing the provider call here instead of in the browser keeps the API key out
 * of page storage and sidesteps CORS entirely.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/text-manager/api'

/** Cordis services required before the routes can mount. */
export const inject = ['webServer']

/** @type {readonly string[]} */
const ROUTE_KEYS = ['settings.get', 'settings.update', 'settings.reveal', 'models.list', 'translate', 'test', 'test.translate']

/** Settings shape and defaults. Anything missing or malformed falls back here. */
const DEFAULT_SETTINGS = Object.freeze({
  /** Master switch for the automatic translation of reasoning blocks. */
  enabled: true,
  /**
   * The conversation-text-style module: its own master switch plus one entry per
   * style target (`{ preset, options }`). Kept opaque here — the browser half owns
   * the catalogue and validates every value against it — so the host only has to
   * prove the shape is safe to persist and hand back.
   */
  textStyle: { enabled: false, live: true, targets: {} },
  /** DeepSeek API key. Empty means "not configured yet". */
  apiKey: '',
  /** OpenAI-compatible base URL; the `/chat/completions` path is appended. */
  baseUrl: 'https://api.deepseek.com',
  /** Translation model id. */
  model: 'deepseek-chat',
  /** 'auto' omits the field, 'on'/'off' send `thinking.type`. */
  thinking: 'auto',
  /** Skip segments that already look Chinese, to avoid pointless spend. */
  onlyEnglish: true,
  /** Open each reasoning disclosure automatically instead of by hand. */
  autoExpand: false,
  /** Also translate the assistant's own interleaved narration. */
  translateProse: true,
  /** Auto-translate reasoning that predates this page load (history). */
  includeHistory: false,
  /** Upper bound for one translated segment, in characters. */
  maxSegmentChars: 1800,
  /** How eagerly a streaming row is cut into requests (see the client half). */
  cutMode: 'balanced',
  /** Per-request timeout in milliseconds. */
  timeoutMs: 45000,
  /** Model ids last reported by the provider's /models endpoint. */
  cachedModels: []
})

/** Upper bound on the remembered model list. */
const MAX_CACHED_MODELS = 500

/** The accepted cut modes; anything else falls back to the default. */
const CUT_MODES = ['responsive', 'balanced', 'paragraph', 'block']

/**
 * Translation system prompt.
 *
 * Deliberately short: it is sent with every request, and at the granularities
 * this plugin can run at that fixed block dominated the input token count.
 * Measured on a real session: ~495 chars (~124 tokens) per request was 86% of
 * all input tokens; this version is ~156 chars (~39 tokens).
 */
const SYSTEM_PROMPT = [
  'Translate to Simplified Chinese.',
  'Output only the translation, with no notes and no surrounding quotes.',
  'Keep Markdown, code, file paths, URLs, numbers and line breaks unchanged.'
].join('\n')

/**
 * Resolve the harness home, matching `@deepseek-ai/dsh-home-paths` precedence:
 * an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. The host
 * process does not inherit `$DSH_HOME` (only tool shells do), so the default
 * has to be correct on its own.
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns the harness home directory.
 */
function dshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns absolute path of the settings document.
 */
function settingsPath(configured) {
  return join(dshHome(configured), 'text-manager', 'settings.json')
}

/**
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns absolute path of the persisted translation store.
 */
function translationsPath(configured) {
  return join(dshHome(configured), 'text-manager', 'translations.json')
}

/** Trim a value to a string, or return the fallback. */
function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Upper bound on the persisted style document (a runaway client must not grow it). */
const MAX_STYLE_BYTES = 24_000

/**
 * Keep the style module's document to a shape the browser half can trust: one
 * flag pair plus per-target `{ preset, options }` where every option is a short
 * primitive. The catalogue itself lives in the browser half, so unknown targets
 * are preserved rather than rejected — a newer client may know more than this
 * host does.
 * @param raw - the value from the settings document.
 * @returns a safe, size-bounded document.
 */
function normalizeTextStyle(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const targets = {}
  const entries = source.targets !== null && typeof source.targets === 'object' ? Object.entries(source.targets) : []
  for (const [key, value] of entries.slice(0, 64)) {
    if (typeof key !== 'string' || key === '' || key.length > 40) continue
    if (value === null || typeof value !== 'object') continue
    const options = {}
    for (const [option, setting] of Object.entries(value.options ?? {}).slice(0, 32)) {
      if (option.length > 24) continue
      if (typeof setting === 'boolean') options[option] = setting
      else if (typeof setting === 'number' && Number.isFinite(setting)) options[option] = setting
      else if (typeof setting === 'string' && setting.length <= 64) options[option] = setting
    }
    targets[key] = { preset: typeof value.preset === 'string' ? value.preset.slice(0, 32) : 'default', options }
  }
  const styles = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.textStyle.enabled,
    live: typeof source.live === 'boolean' ? source.live : DEFAULT_SETTINGS.textStyle.live,
    targets
  }
  return JSON.stringify(styles).length > MAX_STYLE_BYTES ? { ...DEFAULT_SETTINGS.textStyle } : styles
}

/** Coerce a user value into the settings contract. */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const baseUrl = asString(source.baseUrl, DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, '')
  const model = asString(source.model, DEFAULT_SETTINGS.model).trim()
  const thinking = source.thinking === 'on' || source.thinking === 'off' ? source.thinking : 'auto'
  const timeoutMs = Number(source.timeoutMs)
  const maxSegmentChars = Number(source.maxSegmentChars)
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
    textStyle: normalizeTextStyle(source.textStyle),
    apiKey: asString(source.apiKey, '').trim(),
    baseUrl: baseUrl === '' ? DEFAULT_SETTINGS.baseUrl : baseUrl,
    model: model === '' ? DEFAULT_SETTINGS.model : model,
    thinking,
    onlyEnglish: typeof source.onlyEnglish === 'boolean' ? source.onlyEnglish : DEFAULT_SETTINGS.onlyEnglish,
    autoExpand: typeof source.autoExpand === 'boolean' ? source.autoExpand : DEFAULT_SETTINGS.autoExpand,
    translateProse: typeof source.translateProse === 'boolean' ? source.translateProse : DEFAULT_SETTINGS.translateProse,
    includeHistory: typeof source.includeHistory === 'boolean' ? source.includeHistory : DEFAULT_SETTINGS.includeHistory,
    cutMode: CUT_MODES.includes(source.cutMode) ? source.cutMode : DEFAULT_SETTINGS.cutMode,
    maxSegmentChars: Number.isFinite(maxSegmentChars) && maxSegmentChars >= 200 && maxSegmentChars <= 20000
      ? Math.round(maxSegmentChars)
      : DEFAULT_SETTINGS.maxSegmentChars,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 5000 && timeoutMs <= 300000
      ? Math.round(timeoutMs)
      : DEFAULT_SETTINGS.timeoutMs,
    cachedModels: Array.isArray(source.cachedModels)
      ? [...new Set(source.cachedModels.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))]
        .slice(0, MAX_CACHED_MODELS)
      : []
  }
}

/** Read the settings document; a missing or broken file yields the defaults. */
function loadSettings(logger, configuredHome) {
  const file = settingsPath(configuredHome)
  try {
    if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    logger?.warn?.(`text-manager: settings unreadable, using defaults: ${String(error)}`)
    return { ...DEFAULT_SETTINGS }
  }
}

/** Atomically persist the settings document. */
async function saveSettings(next, configuredHome) {
  const file = settingsPath(configuredHome)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** Mask a secret for transport, keeping a recognisable head and tail. */
function maskKey(key) {
  if (key === '') return ''
  if (key.length <= 10) return `${key.slice(0, 2)}${'*'.repeat(Math.max(0, key.length - 2))}`
  return `${key.slice(0, 6)}${'*'.repeat(Math.min(12, key.length - 10))}${key.slice(-4)}`
}

/** Plugin version marker surfaced to the settings page for support. */
const PLUGIN_VERSION = '1.6.1'

/** The client-facing projection: never ships the raw key back to the page. */
function publicSettings(settings, configuredHome, translationCount = 0) {
  return {
    pluginVersion: PLUGIN_VERSION,
    settingsFile: settingsPath(configuredHome),
    translationsFile: translationsPath(configuredHome),
    translationCount,
    enabled: settings.enabled,
    textStyle: settings.textStyle,
    baseUrl: settings.baseUrl,
    model: settings.model,
    thinking: settings.thinking,
    onlyEnglish: settings.onlyEnglish,
    autoExpand: settings.autoExpand,
    translateProse: settings.translateProse,
    includeHistory: settings.includeHistory,
    cutMode: settings.cutMode,
    maxSegmentChars: settings.maxSegmentChars,
    timeoutMs: settings.timeoutMs,
    cachedModels: settings.cachedModels,
    apiKeySet: settings.apiKey !== '',
    apiKeyMask: maskKey(settings.apiKey)
  }
}

/** Loopback-only request fence, mirroring the /api gateway's posture. */
function isTrusted(request) {
  if (typeof request?.socket?.remoteAddress === 'string'
    && !isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(address) {
  const parts = address.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address is loopback (IPv4, IPv6, or IPv4-mapped). */
function isLoopbackAddress(address) {
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names loopback. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Read a JSON body with a hard size cap. */
async function readJsonBody(request, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/** One route-level failure carrying its HTTP status. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/**
 * Durable segment store, one entry per translated segment.
 *
 * The key is the source text alone, deliberately: a translation is a property
 * of the text, so re-opening a conversation — or restarting the harness — hands
 * back the exact text that was produced the first time instead of paying for it
 * again (and instead of getting a subtly different translation). Only an
 * explicit refresh bypasses it.
 */
class TranslationStore {
  constructor(file, logger, limit = 4000) {
    this.file = file
    this.logger = logger
    this.limit = limit
    /** @type {Map<string, { text: string, model: string, at: number }>} */
    this.map = new Map()
    this.timer = null
    this.dirty = false
  }

  /** @param text - one source segment. @returns its stable key. */
  static keyOf(text) {
    return createHash('sha256').update(text).digest('hex')
  }

  /** Read the document; a missing or broken file starts an empty store. */
  load() {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
        if (typeof entry?.k !== 'string' || typeof entry?.t !== 'string') continue
        this.map.set(entry.k, { text: entry.t, model: asString(entry.m), at: Number(entry.a) || 0 })
      }
      this.logger?.info?.(`text-manager: ${this.map.size} stored translation(s)`)
    } catch (error) {
      this.logger?.warn?.(`text-manager: translation store unreadable, starting empty: ${String(error)}`)
    }
  }

  /**
   * @param text - one source segment.
   * @returns the stored translation, or undefined when this segment is new.
   */
  get(text) {
    const key = TranslationStore.keyOf(text)
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    // Re-insert so the cap evicts the genuinely oldest entries.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.text
  }

  /** Remember one translation and schedule the write. */
  set(text, translated, model) {
    const key = TranslationStore.keyOf(text)
    this.map.delete(key)
    this.map.set(key, { text: translated, model, at: Date.now() })
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value)
    this.dirty = true
    this.schedule()
  }

  /** @returns how many segments are remembered. */
  get size() {
    return this.map.size
  }

  /** Coalesce a streaming burst of writes into one atomic file write. */
  schedule() {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 1500)
    this.timer.unref?.()
  }

  /** Write the document atomically. */
  async flush() {
    if (!this.dirty) return
    this.dirty = false
    const entries = [...this.map].map(([k, value]) => ({ k, t: value.text, m: value.model, a: value.at }))
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries })}\n`, 'utf8')
      await rename(temporary, this.file)
    } catch (error) {
      this.logger?.warn?.(`text-manager: could not persist translations: ${String(error)}`)
    }
  }

  /** Stop the pending timer (the caller flushes first). */
  dispose() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

/** Whether a string already reads as mostly Chinese (skip it). */
function looksChinese(text) {
  const letters = text.replace(/[\s\p{P}\p{N}]/gu, '')
  if (letters === '') return true
  const cjk = letters.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)?.length ?? 0
  return cjk / letters.length > 0.35
}

/**
 * Statuses worth retrying. At the granularity this plugin can run at, a long
 * reasoning block emits a request per sentence, so a 429 is a realistic event
 * rather than an exotic one — without this the affected segment simply stays
 * untranslated until the user clicks its button.
 */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/** Base backoff per attempt, in milliseconds (exponential, with jitter). */
const RETRY_BASE_MS = 400
/** How many attempts one call may make in total. */
const RETRY_ATTEMPTS = 3

/** Sleep that honours caller cancellation. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** `Retry-After` in milliseconds, when the provider sent one. */
function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after')
  if (typeof header !== 'string' || header.trim() === '') return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1000))
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.min(10_000, Math.max(0, date - Date.now())) : null
}

/**
 * One provider request with bounded retries.
 *
 * Retries only what can succeed on a second try: a rate limit or a 5xx from the
 * provider, or a transport error. A 4xx (bad key, bad request) fails
 * immediately — retrying it would only waste the user's quota.
 *
 * @param url - the request URL.
 * @param init - the fetch init (its `signal` must be the caller's combined one).
 * @param logger - host logger.
 * @returns the response, after however many attempts it took.
 */
async function providerFetch(url, init, logger) {
  const signal = init.signal
  let lastResponse
  let lastError
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const requested = lastResponse === undefined ? null : retryAfterMs(lastResponse)
      const backoff = requested ?? RETRY_BASE_MS * 3 ** (attempt - 1)
      await sleep(Math.min(10_000, backoff) + Math.random() * 150, signal)
    }
    try {
      const response = await fetch(url, init)
      if (!RETRY_STATUS.has(response.status) || attempt === RETRY_ATTEMPTS - 1) return response
      // Drain the failed body so the connection can be reused, then retry.
      await response.text().catch(() => '')
      lastResponse = response
      logger?.warn?.(`text-manager: provider returned ${response.status}; retrying (attempt ${attempt + 2}/${RETRY_ATTEMPTS})`)
    } catch (error) {
      if (signal?.aborted === true) throw error
      lastError = error
      if (attempt === RETRY_ATTEMPTS - 1) throw error
      logger?.warn?.(`text-manager: ${String(error?.message ?? error)}; retrying (attempt ${attempt + 2}/${RETRY_ATTEMPTS})`)
    }
  }
  if (lastResponse !== undefined) return lastResponse
  throw lastError ?? new Error('provider request failed')
}

/**
 * The OpenAI-compatible API root for one configured base URL: the user may
 * paste a bare host, a `/v1` root, or a full `/chat/completions` endpoint.
 * @param baseUrl - the configured base URL.
 * @returns the API root without a trailing slash.
 */
function apiRootOf(baseUrl) {
  let base = baseUrl.replace(/\/+$/, '')
  base = base.replace(/\/chat\/completions$/, '')
  base = base.replace(/\/models$/, '')
  if (base === '' || /\/v\d+$/.test(base)) return base
  return `${base}/v1`
}

/** @returns the chat-completions endpoint for one base URL. */
function endpointOf(baseUrl) {
  return `${apiRootOf(baseUrl)}/chat/completions`
}

/** @returns the model-directory endpoint for one base URL. */
function modelsEndpointOf(baseUrl) {
  return `${apiRootOf(baseUrl)}/models`
}

/**
 * Call the configured OpenAI-compatible endpoint once.
 * @param settings - normalized settings.
 * @param text - the segment to translate.
 * @param signal - caller cancellation.
 * @returns the translated text.
 */
async function requestTranslation(settings, text, signal, logger) {
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    stream: false
  }
  if (settings.thinking === 'on') body.thinking = { type: 'enabled' }
  else if (settings.thinking === 'off') body.thinking = { type: 'disabled' }

  let response
  try {
    response = await providerFetch(endpointOf(settings.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    }, logger)
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted === true) {
      throw new HttpError(499, 'aborted', 'the translation request was aborted')
    }
    throw new HttpError(502, 'network-error', `could not reach ${settings.baseUrl}: ${String(error?.message ?? error)}`)
  }

  const raw = await response.text()
  let payload
  try {
    payload = raw === '' ? undefined : JSON.parse(raw)
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? raw.slice(0, 400)
    throw new HttpError(response.status === 401 ? 401 : 502, `provider-${response.status}`, `provider rejected the request (HTTP ${response.status}): ${detail}`)
  }

  const message = payload?.choices?.[0]?.message
  const content = typeof message?.content === 'string' ? message.content : ''
  if (content.trim() === '') {
    throw new HttpError(502, 'empty-completion', 'the provider returned no translated text')
  }
  return content.trim()
}

/**
 * Ask the provider which models it serves (`GET /models`).
 *
 * Providers disagree on the envelope, so the ids are picked out of every shape
 * seen in the wild: OpenAI's `{ data: [{ id }] }`, a bare array, and the
 * `{ models: [...] }` / `{ data: ["id"] }` variants.
 *
 * @param settings - normalized settings.
 * @param signal - caller cancellation.
 * @returns the model ids, de-duplicated and sorted.
 */
async function requestModels(settings, signal, logger) {
  let response
  try {
    response = await providerFetch(modelsEndpointOf(settings.baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal
    }, logger)
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted === true) {
      throw new HttpError(499, 'aborted', 'the model request was aborted')
    }
    throw new HttpError(502, 'network-error', `could not reach ${settings.baseUrl}: ${String(error?.message ?? error)}`)
  }

  const raw = await response.text()
  let payload
  try {
    payload = raw === '' ? undefined : JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? raw.slice(0, 300)
    throw new HttpError(
      response.status === 401 ? 401 : 502,
      `provider-${response.status}`,
      `model directory rejected the request (HTTP ${response.status}): ${detail}`
    )
  }

  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.models) ? payload.models
        : []
  const ids = []
  for (const row of rows) {
    const id = typeof row === 'string' ? row : asString(row?.id) || asString(row?.name) || asString(row?.model)
    if (id.trim() !== '') ids.push(id.trim())
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, MAX_CACHED_MODELS)
}

/** Simple FIFO gate keeping concurrent provider calls bounded. */
class Gate {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.waiting = []
  }

  async run(operation) {
    if (this.active >= this.limit) await new Promise(resolve => this.waiting.push(resolve))
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

/**
 * Mount the host half.
 * @param ctx - the Cordis host context (provides `webServer`).
 * @param config - optional plugin config (`dshHome` overrides the harness home).
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const logger = ctx.logger ?? console
  const configuredHome = config?.dshHome
  let settings = loadSettings(logger, configuredHome)
  const store = new TranslationStore(translationsPath(configuredHome), logger)
  store.load()
  const gate = new Gate(3)

  /** Merge a partial patch into the live settings and persist it. */
  const patchSettings = async (patch) => {
    const requested = patch !== null && typeof patch === 'object' ? patch : {}
    const merged = { ...settings }
    // A key field is only replaced when the caller actually sends text; the
    // masked projection never round-trips back into the document.
    if (typeof requested.apiKey === 'string' && requested.apiKey.trim() !== '') merged.apiKey = requested.apiKey.trim()
    if (requested.apiKey === '') merged.apiKey = ''
    for (const field of ['baseUrl', 'model', 'thinking', 'enabled', 'onlyEnglish', 'autoExpand', 'translateProse', 'includeHistory', 'cutMode', 'maxSegmentChars', 'timeoutMs', 'cachedModels', 'textStyle']) {
      if (requested[field] !== undefined) merged[field] = requested[field]
    }
    settings = normalizeSettings(merged)
    await saveSettings(settings, configuredHome)
    return settings
  }

  /** Run one provider call under the configured timeout. */
  const withTimeout = async (signal, operation) => {
    const bounded = AbortSignal.timeout(settings.timeoutMs)
    const combined = signal === undefined ? bounded : AbortSignal.any([signal, bounded])
    return operation(combined)
  }

  /**
   * Translate one segment.
   *
   * The store is consulted first and answers without any provider traffic, so
   * re-opening a conversation (or restarting the harness) replays stored text
   * for free. `force` skips the store and overwrites it — that is exactly what
   * a manual refresh asks for. `provider: false` is the read-only probe the
   * browser half uses to find out what is already known: it never spends.
   *
   * @param text - the segment.
   * @param signal - caller cancellation.
   * @param options - `{ force, provider }`.
   * @returns the translation outcome.
   */
  const translate = async (text, signal, options = {}) => {
    if (!settings.enabled) return { text: '', cached: false, skipped: true }
    if (settings.apiKey === '') throw new HttpError(400, 'no-api-key', 'no DeepSeek API key is configured yet')
    if (settings.onlyEnglish && looksChinese(text)) return { text: '', cached: false, skipped: true }

    if (options.force !== true) {
      const hit = store.get(text)
      if (hit !== undefined) return { text: hit, cached: true, stored: true, skipped: false }
    }
    if (options.provider === false) {
      return { text: '', cached: false, stored: false, skipped: false, missing: true }
    }

    const translated = await gate.run(() => withTimeout(signal, combined => requestTranslation(settings, text, combined, logger)))
    store.set(text, translated, `${settings.model}/${settings.thinking}`)
    return { text: translated, cached: false, stored: true, skipped: false }
  }

  /** Require a configured key and return the current settings. */
  const requireKey = () => {
    if (settings.apiKey === '') throw new HttpError(400, 'no-api-key', 'no DeepSeek API key is configured yet')
    return settings
  }

  /** Dispatch one route method. */
  const dispatch = async (method, payload, signal) => {
    switch (method) {
      case 'settings.get':
        return { settings: publicSettings(settings, configuredHome, store.size) }
      case 'settings.update': {
        const next = await patchSettings(payload?.settings ?? payload)
        return { settings: publicSettings(next, configuredHome, store.size) }
      }
      case 'settings.reveal':
        // Loopback-fenced, and only ever asked for by the settings page's own
        // "show key" control. Everything else in this API keeps the mask.
        return { apiKey: settings.apiKey }
      case 'models.list': {
        requireKey()
        const models = await withTimeout(signal, combined => requestModels(settings, combined, logger))
        settings = normalizeSettings({ ...settings, cachedModels: models })
        await saveSettings(settings, configuredHome)
        return { models }
      }
      case 'translate': {
        const text = asString(payload?.text, '')
        if (text.trim() === '') return { text: '', cached: false, skipped: true }
        const clipped = text.length > settings.maxSegmentChars
          ? text.slice(0, settings.maxSegmentChars)
          : text
        const result = await translate(clipped, signal, {
          force: payload?.force === true,
          provider: payload?.provider !== false
        })
        return { ...result, clipped: text.length > clipped.length }
      }
      case 'test': {
        requireKey()
        const reply = await withTimeout(signal, combined => requestTranslation(settings, 'Reply with the single word: ok', combined, logger))
        return { model: settings.model, thinking: settings.thinking, reply: reply.slice(0, 120) }
      }
      case 'test.translate': {
        requireKey()
        const sample = asString(payload?.text, '').trim()
        if (sample === '') throw new HttpError(400, 'empty-sample', 'no sample text was supplied')
        const started = Date.now()
        // The real translation path, bypassing only the enabled switch and the
        // Chinese skip so the probe always exercises the provider.
        const hit = store.get(sample)
        const translation = hit !== undefined
          ? hit
          : await gate.run(() => withTimeout(signal, combined => requestTranslation(settings, sample, combined, logger)))
        if (hit === undefined) store.set(sample, translation, `${settings.model}/${settings.thinking}`)
        return {
          source: sample,
          translation,
          cached: hit !== undefined,
          ms: Date.now() - started,
          model: settings.model,
          thinking: settings.thinking,
          apiRoot: apiRootOf(settings.baseUrl)
        }
      }
      default:
        throw new HttpError(404, 'not-found', `unknown method "${String(method)}"`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrusted(request)) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined
      if (method === undefined || !ROUTE_KEYS.includes(method)) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${String(method)}"` } })
        return
      }

      const controller = new AbortController()
      const onClose = () => controller.abort()
      response.on('close', onClose)
      try {
        const payload = await readJsonBody(request)
        const data = await dispatch(method, payload, controller.signal)
        if (!response.writableEnded) writeJson(response, 200, { ok: true, ...data })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const code = error instanceof HttpError ? error.code : 'internal-error'
        const message = error instanceof Error ? error.message : String(error)
        if (status >= 500) logger.warn?.(`text-manager: ${method} failed: ${message}`)
        if (!response.writableEnded) writeJson(response, status, { ok: false, error: { code, message } })
      } finally {
        response.off('close', onClose)
      }
    }
  }), 'text-manager: routes')

  // Flush any pending segment write before the fiber goes away.
  ctx.effect(() => () => {
    store.dispose()
    void store.flush()
  }, 'text-manager: translation store')

  logger.info?.(`text-manager: mounted ${ROUTE_PREFIX} (settings: ${settingsPath(configuredHome)}, ${store.size} stored translation(s))`)
}
