/**
 * dsh-text-manager — browser half.
 *
 * Two independent jobs:
 *
 *  1. A settings page (`settings.section`) for the DeepSeek endpoint, key,
 *     model and the translation model's thinking mode.
 *  2. The translator itself. DSH renders a reasoning block through the chat
 *     package's `ReasoningRow`, which owns the whole disclosure — there is no
 *     slot for a reasoning row's text, and forking the shipped `assistant-step`
 *     node renderer would mean reimplementing the chat. So the translator
 *     attaches to the committed DOM instead: it finds `[data-variant="think"]`
 *     rows, reads the exact reasoning string off the row's React props (which
 *     carry the full text even while the row is collapsed), translates it in
 *     paragraph-sized increments through the host route, and renders the
 *     Chinese under the original row in a node React does not own.
 *
 * Everything degrades quietly: when the row props cannot be read it falls back
 * to the rendered text, and when a row disappears its companion goes with it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-text-translator',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const React = react.default ?? react
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    //#region host API
    /** Route family mounted by the host half. */
    const ROUTE = '/text-translator/api'

    /**
     * Post one method to the plugin's host route family.
     * @param method - one of settings.get | settings.update | translate | test.
     * @param payload - JSON body.
     * @param signal - optional cancellation.
     * @returns the unwrapped response payload.
     */
    async function callApi(method, payload, signal) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error('无法连接宿主插件路由，请确认插件已随 Harness 启动。')
      }
      let data
      try {
        data = await response.json()
      } catch {
        data = undefined
      }
      if (!response.ok || data?.ok !== true) {
        const failure = new Error(data?.error?.message ?? `HTTP ${response.status}`)
        failure.code = data?.error?.code ?? `http-${response.status}`
        throw failure
      }
      return data
    }
    //#endregion

    //#region styles
    /**
     * Class-name-free selectors keep this stable across chat package rebuilds.
     * Named for what it is, not `CSS`: that identifier is the DOM `CSS`
     * namespace object, which `expand()` needs for `CSS.escape`.
     */
    const STYLESHEET = `
[data-dsh-tm="block"]{box-sizing:border-box;margin:2px 0 8px;padding:8px 12px;border-left:2px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
[data-dsh-tm="head"]{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
[data-dsh-tm="badge"]{flex:none;padding:0 5px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,transparent);letter-spacing:.02em}
[data-dsh-tm="status"]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-dsh-tm="block"][data-status="error"] [data-dsh-tm="status"]{color:var(--dsw-alias-state-error-primary)}
[data-dsh-tm="act"]{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:11px;line-height:16px;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
[data-dsh-tm="act"]:hover{background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary)}
[data-dsh-tm="body"]{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
[data-dsh-tm="body"][hidden]{display:none}
[data-dsh-tm="block"][data-collapsed] [data-dsh-tm="body"]{display:none}
[data-dsh-tm="block"][data-empty]{padding:3px 12px;border-left-color:var(--dsw-alias-border-l2);opacity:.62}
[data-dsh-tm="block"][data-empty] [data-dsh-tm="head"]{margin-bottom:0}
[data-dsh-tm="block"][data-empty]:hover{opacity:1}
[data-dsh-tm="act"][disabled]{opacity:.6;cursor:default}
[data-dsh-tm="block"][data-status="error"] [data-dsh-tm="head"]{color:var(--dsw-alias-state-error-primary)}
[data-dsh-tm="block"][data-kind="prose"]{border-left:3px dashed var(--dsw-alias-label-tertiary,currentColor);border-radius:0;background:transparent;padding-left:10px}
[data-dsh-tm="block"][data-kind="prose"][data-empty]{border-left-color:var(--dsw-alias-border-l2);opacity:.62}
[data-dsh-tm="block"][data-kind="prose"] [data-dsh-tm="badge"]{background:transparent;border:1px dashed var(--dsw-alias-border-l2)}
`
    const STYLE_ID = 'dsh-text-translator/translator.css'

    /** Install the stylesheet once per page. */
    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-text-translator'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = STYLESHEET
      document.head.appendChild(tag)
    }
    //#endregion

    //#region assistant row access
    /**
     * React keeps its fiber on the host node under a versioned own property.
     * @param node - a DOM node React rendered.
     * @returns the fiber, or null.
     */
    function fiberOf(node) {
      if (node === null || typeof node !== 'object') return null
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return node[key]
      }
      return null
    }

    /**
     * Read the full text of a row from its React props.
     *
     * For reasoning, `ReasoningRow` receives the complete text even while
     * collapsed (the collapsed DOM only carries the one-line summary); for prose
     * the `MarkdownText` element receives the source markdown, not the rendered
     * HTML. Both are the authoritative source, so props win over the DOM.
     *
     * @param element - the row root.
     * @param matchesProps - predicate recognising that component's props.
     * @returns the source text, or null when the props cannot be read.
     */
    function readPropsText(element, matchesProps) {
      let fiber = fiberOf(element)
      let depth = 0
      while (fiber !== null && depth < 16) {
        const props = fiber.memoizedProps
        if (props !== null && typeof props === 'object'
          && typeof props.text === 'string'
          && matchesProps(props)) {
          return props.text
        }
        fiber = fiber.return
        depth += 1
      }
      return null
    }

    /** @returns whether the props belong to DSH's chat `ReasoningRow`. */
    function isReasoningProps(props) {
      return typeof props.running === 'boolean' || typeof props.usePresentation === 'function'
    }

    /** @returns whether the props belong to DSH's `MarkdownText`. */
    function isMarkdownProps(props) {
      return typeof props.streaming === 'boolean'
    }

    /**
     * Read the reasoning text from the DOM as a fallback (expanded body, else
     * the collapsed summary line).
     * @param element - the row root.
     * @returns the visible text.
     */
    function readDomText(element) {
      const body = element.querySelector('[class*="thinkBody"]')
      if (body !== null && body.innerText.trim() !== '') return body.innerText
      const summary = element.querySelector('[class*="summaryText"]')
      return summary === null ? '' : summary.innerText
    }

    /**
     * @param element - the row root.
     * @param kind - the row kind (see {@link ROW_KINDS}).
     * @returns the source text for one row, preferring the React props.
     */
    function readRowText(element, kind) {
      const fromProps = readPropsText(element, kind.matchesProps)
      if (typeof fromProps === 'string' && fromProps !== '') return fromProps
      // Prose renders its own text, so the element's own text is the fallback.
      return kind.fallback === 'text' ? element.innerText ?? '' : readDomText(element)
    }

    /**
     * The two kinds of assistant output this plugin translates.
     *
     * `reasoning` is the thinking block. `prose` is the assistant's own text —
     * the short narration it emits between tool calls, which DSH renders as an
     * `assistant-step` flow item carrying `data-chat-group-part="response"`
     * (the same path the final answer takes; a mostly-Chinese answer is skipped
     * by the host and shows nothing). Tool cards, command rows, compaction rows
     * and the system-prompt block are deliberately untouched.
     */
    const ROW_KINDS = [
      {
        id: 'reasoning',
        badgeKey: 'badgeReasoning',
        badgeTitleKey: 'badgeReasoningTitle',
        selector: '[data-variant="think"]',
        matchesProps: isReasoningProps,
        fallback: 'reasoning',
        /** Reasoning rows carry their own streaming flag. */
        isLive: (row) => row.getAttribute('data-state') === 'running'
      },
      {
        id: 'prose',
        badgeKey: 'badgeProse',
        badgeTitleKey: 'badgeProseTitle',
        /**
         * The class token is a guess — CSS Modules append the source name to a
         * per-build hash, so `<hash>_markdown` is the shape but not the literal.
         * `requireProps` below is what actually makes this airtight: an element
         * only counts as prose when its React props are `MarkdownText`'s.
         */
        selector: '[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] div[class*="markdown"]:not([data-markdown-variant])',
        matchesProps: isMarkdownProps,
        fallback: 'text',
        /** Prose inherits streaming from its `AssistantMarkdown` wrapper. */
        isLive: (row) => row.closest('[data-streaming]') !== null,
        /** Identity comes from the props, never from the class name. */
        requireProps: true
      }
    ]

    /** Badge text when no locale resolver was injected (offline tests). */
    const BADGE_FALLBACK = {
      badgeReasoning: '中文翻译',
      badgeAnswer: '正文翻译',
      badgeProse: '旁白翻译',
      badgeReasoningTitle: '思考链的中文翻译',
      badgeAnswerTitle: '回答正文的中文翻译',
      badgeProseTitle: '思考块之间零散文字的中文翻译'
    }

    /**
     * The badge key for a row: the answer's translation reads differently from the
     * narration's, because both arrive on the same response path.
     * @param input - a row kind, or a row state carrying one.
     * @returns a locale key.
     */
    function badgeKeyOf(input) {
      const kind = input.kind ?? input
      return kind.id === 'prose' && input.part === 'answer' ? 'badgeAnswer' : kind.badgeKey
    }

    /**
     * @param input - a row kind, or a row state carrying one.
     * @returns the locale key for that row's tooltip.
     */
    function badgeTitleKeyOf(input) {
      const kind = input.kind ?? input
      return kind.id === 'prose' && input.part === 'answer' ? 'badgeAnswerTitle' : kind.badgeTitleKey
    }

    /**
     * Whether one response row is its turn's answer or one of its narrations.
     *
     * DSH renders both through the same flow item and tells them apart by
     * `answerStep` — the turn's last assistant step. The same fact is readable from
     * the DOM: within one turn, the last response part *is* the answer.
     *
     * @param row - a tracked row element.
     * @returns 'answer' | 'narration'.
     */
    function partOfRow(row) {
      const item = row.closest?.('[data-chat-flow-kind="assistant-step"]')
      if (item === null || item === undefined) return 'narration'
      const turn = item.closest?.('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
      let last = null
      for (const candidate of document.querySelectorAll('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]')) {
        if ((candidate.closest?.('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? '') === turn) last = candidate
      }
      return last === item ? 'answer' : 'narration'
    }

    /** @param id - a kind id. @returns that kind, or undefined. */
    function kindById(id) {
      return ROW_KINDS.find(kind => kind.id === id)
    }
    //#endregion

    //#region segmentation
    /** A segment shorter than this is not worth a provider round trip. */
    const MIN_SEGMENT = 24

    /**
     * How eagerly a streaming row is cut into provider requests.
     *
     * This is the single biggest cost knob: measured on a real 357-block session
     * (784k chars), `responsive` costs 9,147 requests, `balanced` 4,194 (46%),
     * `paragraph` 3,681 (40%) and `block` ~980 (11%).
     *
     *  - `sentence`  minimum pending size before cutting at a sentence end;
     *  - `paragraph` the same for a paragraph break;
     *  - `idleFlush` whether a stalled stream is flushed after {@link IDLE_MS}
     *    (off in `block` mode, where nothing may go out before the row settles).
     */
    const CUT_MODES = {
      responsive: { sentence: MIN_SEGMENT, paragraph: MIN_SEGMENT, idleFlush: true },
      balanced: { sentence: 320, paragraph: MIN_SEGMENT, idleFlush: true },
      paragraph: { sentence: Number.MAX_SAFE_INTEGER, paragraph: MIN_SEGMENT, idleFlush: true },
      block: { sentence: Number.MAX_SAFE_INTEGER, paragraph: Number.MAX_SAFE_INTEGER, idleFlush: false }
    }

    /**
     * @param settings - the plugin settings projection.
     * @returns the gates for the configured mode, defaulting to `balanced`.
     */
    function cutModeOf(settings) {
      return CUT_MODES[settings?.cutMode] ?? CUT_MODES.balanced
    }

    /**
     * Assemble resolved segments back into one block.
     *
     * `sep` describes the separator that *followed* a segment in the source
     * (the segment itself was stripped of it), so it is emitted after that
     * segment and only while another segment follows — the last one has no
     * trailing separator to reproduce.
     *
     * @param parts - `{ text, sep }` in source order.
     * @returns the joined translation.
     */
    function joinParts(parts) {
      let text = ''
      for (const [index, part] of parts.entries()) {
        text += part.text
        if (index === parts.length - 1) break
        text += part.sep === 'paragraph' ? '\n\n' : part.sep === 'space' ? ' ' : ''
      }
      return text
    }

    /** How many ``` markers a piece of text carries. */
    function fenceCount(text) {
      return (text.match(/```/g) ?? []).length
    }
    /**
     * The fence state after consuming `text`.
     * @param text - the consumed text.
     * @param openBefore - whether a fence was already open.
     * @returns true when a fence is still open.
     */
    function fenceOpenAfter(text, openBefore) {
      return fenceCount(text) % 2 === 1 ? !openBefore : openBefore
    }

    /**
     * Move a cut out of an open code fence.
     *
     * A cut inside a fence sends both halves to the model with an unbalanced
     * fence, and the model then mangles the code. Cutting just before the last
     * ``` in the slice leaves an even count, so both halves stay balanced.
     *
     * @param rest - the untranslated remainder.
     * @param cut - the candidate cut.
     * @param openBefore - whether `rest` starts inside an open fence.
     * @returns the safe cut, or 0 when nothing can be sent safely.
     */
    function fenceSafeCut(rest, cut, openBefore) {
      if (cut <= 0) return 0
      if (!fenceOpenAfter(rest.slice(0, cut), openBefore)) return cut
      const lastFence = rest.lastIndexOf('```', cut - 1)
      return lastFence > 0 ? lastFence : 0
    }

    /**
     * Index just past the last sentence terminator, excluding the whitespace
     * that follows it. An ASCII period only counts when whitespace follows, so
     * decimals, versions and `file.ext` names do not split a sentence.
     * @param text - the candidate text.
     * @returns the cut index, or 0 when no terminator qualifies.
     */
    function findSentenceEnd(text) {
      const pattern = /(?:[。！？；：!?…]|\.(?=\s))/g
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) index = match.index + 1
      return index
    }

    /**
     * Choose how much of the untranslated remainder is safe to send now.
     *
     * Paragraph boundaries are preferred, then sentence ends (subject to the
     * configured gate), then — only once the row stopped streaming, the idle
     * timer fired, or the remainder exceeds the per-request cap — whatever is
     * available. The returned `sep` describes the separator that followed the
     * segment in the source so the renderer can rebuild paragraph structure
     * without the provider ever seeing blank lines it might collapse.
     *
     * @param rest - untranslated remainder of the text.
     * @param running - whether the row is still streaming.
     * @param maxChars - hard cap for one request.
     * @param force - flush everything available regardless of boundaries.
     * @param gates - the `{ sentence, paragraph }` gates; defaults to the most
     *   eager mode, which is what the unit tests exercise.
     * @param openBefore - whether `rest` starts inside an open code fence.
     * @returns `{ cut, sep }` where `sep` is 'paragraph' | 'space' | ''.
     */
    function pickCut(rest, running, maxChars, force, gates = CUT_MODES.responsive, openBefore = false) {
      const raw = rawCut(rest, running, maxChars, force, gates)
      if (raw.cut <= 0) return raw
      const cut = fenceSafeCut(rest, raw.cut, openBefore)
      if (cut <= 0) {
        // Nothing safe to send while streaming; when flushing we must make
        // progress, so the whole remainder goes even if it ends mid-fence.
        return force ? { cut: rest.length, sep: '' } : { cut: 0, sep: '' }
      }
      if (cut === raw.cut) return raw
      return { cut, sep: /^\s*\n/.test(rest.slice(cut)) ? 'paragraph' : 'space' }
    }

    /**
     * The boundary decision, before the code-fence guard moves the cut.
     *
     * The per-request cap bounds a *flush*; it must never be the reason a streaming
     * row sends early. Checking it first made every mode ship `maxChars`-sized
     * chunks mid-stream — most visibly in `block` mode, whose whole point is to wait
     * for the block, so it looked like the translation was streaming again. The
     * streaming modes keep their own safety valve: their idle flush passes `force`.
     *
     * @returns `{ cut, sep }`.
     */
    function rawCut(rest, running, maxChars, force, gates) {
      if (rest.length > maxChars && (!running || force)) {
        const window = rest.slice(0, maxChars)
        const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
        const cut = boundary > maxChars * 0.4 ? boundary : maxChars
        return { cut, sep: /^\s*\n/.test(rest.slice(cut)) ? 'paragraph' : 'space' }
      }
      const paragraph = rest.lastIndexOf('\n\n')
      if (paragraph >= gates.paragraph) return { cut: paragraph, sep: 'paragraph' }
      if (!running || force) {
        const sentence = findSentenceEnd(rest)
        if (sentence >= gates.sentence && sentence < rest.length) return { cut: sentence, sep: 'space' }
        return { cut: rest.length, sep: '' }
      }
      const sentence = findSentenceEnd(rest)
      if (sentence >= gates.sentence) return { cut: sentence, sep: 'space' }
      return { cut: 0, sep: '' }
    }
    //#endregion

    /**
     * Whether a conversation should be translated.
     *
     * The per-conversation switch wins in both directions, which is the whole point
     * of it: 开启 keeps translating while the plugin is off, 关闭 stays quiet while
     * the plugin is on. An unknown conversation follows the plugin switch.
     *
     * @param settings - the settings projection.
     * @param sessionId - the conversation, when known.
     * @param mode - 'on', 'off', or null for "follow the plugin switch".
     * @returns true when this conversation may produce translations.
     */
    function translationOnFor(settings, sessionId, mode) {
      if (typeof sessionId === 'string' && sessionId !== '') {
        if (mode === 'on') return true
        if (mode === 'off') return false
      }
      return settings?.enabled === true
    }

    //#region translator engine
    /** One line of the status label shown while a row is being translated. */
    const IDLE_MS = 900
    const MAX_CONCURRENT = 3
    /**
     * Controls a reader can toggle by hand. A trusted click on any of them is
     * their intent; a click this plugin dispatched is not.
     */
    const READER_CONTROLS = '[data-disclosure-row], button[data-process-activity], button[data-turn-process]'
    /** How long to leave a control alone after opening it (React lags a frame). */
    const CLICK_COOLDOWN_MS = 1200
    /**
     * How long after the last observed streaming row a freshly adopted row is
     * still treated as part of the live turn. It only has to cover a turn whose
     * reasoning finished between two animation frames.
     */
    const LIVE_GRACE_MS = 2500

    /**
     * Segment → translation, or `null` when the host confirmed it has none.
     * A local first line so the same paragraph appearing in two rows (or the
     * same row re-read after a re-render) costs nothing.
     * @type {Map<string, string | null>}
     */
    const KNOWN = new Map()
    /** Upper bound on {@link KNOWN}; the host store is the authority. */
    const KNOWN_LIMIT = 4000

    /** Remember one segment outcome locally. */
    function remember(segment, translation) {
      KNOWN.delete(segment)
      KNOWN.set(segment, translation)
      while (KNOWN.size > KNOWN_LIMIT) KNOWN.delete(KNOWN.keys().next().value)
    }

    /** Bounded FIFO runner for provider calls. */
    class Runner {
      constructor(limit) {
        this.limit = limit
        this.active = 0
        this.queue = []
      }

      push(task) {
        this.queue.push(task)
        this.drain()
      }

      drain() {
        while (this.active < this.limit && this.queue.length > 0) {
          const task = this.queue.shift()
          this.active += 1
          task().catch(() => {}).finally(() => {
            this.active -= 1
            this.drain()
          })
        }
      }

      /** @returns the number of queued or running tasks. */
      size() {
        return this.queue.length + this.active
      }
    }

    /** Owns settings, the row table, the DOM observer and the request queue. */
    class Translator {
      constructor() {
        /** @type {null | Record<string, unknown>} */
        this.settings = null
        /** The conversation on screen, reported by the session header control. */
        this.sessionId = null
        /** Its own switch: 'on' | 'off' | null, where null follows the plugin switch. */
        this.sessionMode = null
        /** @type {Map<Element, object>} */
        this.rows = new Map()
        this.runner = new Runner(MAX_CONCURRENT)
        this.observer = null
        this.interval = null
        this.frame = null
        this.dirty = new Set()
        this.subscribers = new Set()
        this.snapshot = { enabled: false, ready: false, rows: 0, pending: 0, lastError: '' }
        this.destroyed = false
        /** Timestamp of the last reasoning row seen streaming. */
        this.lastRunningAt = 0
        /**
         * Controls the reader closed by hand. Weak, so the ledger costs nothing
         * once the chat recycles rows. DSH's own folding is NOT recorded here —
         * it is re-opened on the next pass.
         */
        this.readerClosed = new WeakSet()
        /** Control → when this plugin last opened it, for the cooldown. */
        this.clickedAt = new WeakMap()
        /** Injectable clock, so the cooldown is testable. */
        this.now = () => Date.now()
        /** Optional locale resolver, injected by `apply`. */
        this.label = null
        /** Capture-phase reader-intent listener, removed on stop. */
        this.onReaderClick = (event) => this.noteReaderToggle(event)
      }

      /**
       * The badge text for one kind of translation.
       * @param kind - a row kind.
       * @returns the label to show.
       */
      badgeText(input) {
        const key = badgeKeyOf(input)
        const resolved = this.label === null ? undefined : this.label(key)
        if (typeof resolved === 'string' && resolved !== '' && resolved !== key) return resolved
        return BADGE_FALLBACK[key] ?? ''
      }

      /**
       * The hover explanation for one kind of translation. The badge is short by
       * necessity, so this is what says which block is which.
       * @param kind - a row kind.
       * @returns the tooltip, or undefined when the locale has no entry.
       */
      badgeTitle(input) {
        const key = badgeTitleKeyOf(input)
        const resolved = this.label === null ? undefined : this.label(key)
        if (typeof resolved === 'string' && resolved !== '' && resolved !== key) return resolved
        return BADGE_FALLBACK[key]
      }

      /** @returns the settings snapshot for the settings page. */
      getSnapshot = () => this.snapshot

      /** Subscribe to engine state changes (settings page status line). */
      subscribe = (listener) => {
        this.subscribers.add(listener)
        return () => this.subscribers.delete(listener)
      }

      /** Republish the derived state. */
      publish() {
        const next = {
          enabled: this.settings?.enabled === true,
          sessionId: this.sessionId,
          sessionMode: this.sessionMode,
          // What the reader actually gets, which is what the header shows.
          translating: this.translationOn(),
          ready: this.settings?.enabled === true && this.settings?.apiKeySet === true,
          rows: this.rows.size,
          pending: this.runner.size(),
          lastError: this.lastError ?? ''
        }
        if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
        // The identity must only change when the value does: useSyncExternalStore
        // treats a fresh object on every read as an infinite update.
        this.snapshot = next
        for (const listener of this.subscribers) listener()
      }

      /** @returns the row kinds currently switched on. */
      activeKinds() {
        const settings = this.settings
        if (settings?.enabled !== true) return []
        return ROW_KINDS.filter(kind => kind.id !== 'prose' || settings.translateProse === true)
      }

      /** Mount the observer and load the settings document. */
      async start() {
        // Same reason as the style engine: an effect that re-runs must revive.
        this.destroyed = false
        installStyles()
        this.observer = new MutationObserver((records) => this.onMutations(records))
        // The streaming→settled flips are observed explicitly: they are the
        // signal that lets the last segment flush immediately instead of
        // waiting for the 1.5s safety scan. Reasoning carries `data-state` on
        // the row itself, prose inherits `data-streaming` from its wrapper.
        this.observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['data-state', 'data-streaming', 'aria-expanded', 'hidden']
        })
        this.interval = window.setInterval(() => this.scan(), 1500)
        // Capture phase: reader intent must be read before the chat flips it.
        document.addEventListener('click', this.onReaderClick, true)
        await this.reload()
        this.scan()
      }

      /** Reload the settings document from the host. */
      async reload() {
        try {
          const data = await callApi('settings.get')
          this.applySettings(data.settings)
          // Two independent modules: the style engine takes its own document,
          // whatever the translation switch says.
          void 0
          this.lastError = ''
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.applySettings(null)
        }
        this.publish()
      }

      /** Adopt a settings projection and reconcile the DOM with it. */
      applySettings(settings) {
        const previous = this.settings
        const wasAutoExpanding = this.settings?.autoExpand === true
        this.settings = settings
        // Turning the option on is a fresh instruction: forget past clicks and
        // past hand-collapses so everything currently mounted opens again.
        if (settings?.autoExpand === true && !wasAutoExpanding) {
          this.readerClosed = new WeakSet()
          this.clickedAt = new WeakMap()
        }
        // A different translator (or a different Chinese-skip policy) produces
        // different text: drop the local first-line cache so the next pass asks
        // the host again. The host keeps its own store, so this still costs
        // nothing unless it really changed.
        if (previous !== undefined && previous !== null
          && (previous.model !== settings?.model
            || previous.baseUrl !== settings?.baseUrl
            || previous.thinking !== settings?.thinking
            || previous.onlyEnglish !== settings?.onlyEnglish)) {
          KNOWN.clear()
        }
        if (settings?.enabled !== true || settings?.apiKeySet !== true) {
          this.clearAll()
          return
        }
        // A kind the user just switched off leaves no companion behind.
        const active = new Set(this.activeKinds().map(kind => kind.id))
        for (const kind of ROW_KINDS) {
          if (!active.has(kind.id)) this.dropKind(kind.id)
        }
        this.scan()
      }

      /** Release every observer, timer and companion node. */
      stop() {
        this.destroyed = true
        this.observer?.disconnect()
        this.observer = null
        document.removeEventListener('click', this.onReaderClick, true)
        if (this.interval !== null) window.clearInterval(this.interval)
        this.interval = null
        this.clearAll()
      }

      /** Remove every companion and forget every row. */
      clearAll() {
        for (const state of this.rows.values()) this.destroyRow(state)
        this.rows.clear()
        this.dirty.clear()
        this.publish()
      }

      /**
       * Forget every row of one kind, companion included.
       * @param kindId - the kind to drop.
       */
      dropKind(kindId) {
        for (const [row, state] of [...this.rows]) {
          if (state.kind.id !== kindId) continue
          this.destroyRow(state)
          this.rows.delete(row)
          this.dirty.delete(row)
        }
      }

      /**
       * Handle one observer batch: adopt added rows, drop removed ones, and
       * mark rows whose subtree (or streaming flag) changed.
       * @param records - the mutation records.
       */
      onMutations(records) {
        const kinds = this.activeKinds()
        for (const record of records) {
          if (record.type === 'childList') {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue
              for (const kind of kinds) {
                if (node.matches?.(kind.selector)) this.adopt(node, kind)
                for (const nested of node.querySelectorAll?.(kind.selector) ?? []) this.adopt(nested, kind)
              }
            }
            for (const node of record.removedNodes) {
              if (node.nodeType !== 1) continue
              this.forget(node)
            }
          }
          if (record.type === 'attributes') {
            // A `data-streaming` / `data-state` / fold flip happens on a wrapper
            // or on a control *above* the row, so every affected tracked row has
            // to hear about it.
            for (const [row, state] of this.rows) {
              const contains = typeof record.target.contains === 'function' ? record.target.contains(row) : false
              if (record.target === row || contains) {
                this.dirty.add(row)
                continue
              }
              if (state.kind.id === 'reasoning' && this.foldsFor(row, record.target)) this.dirty.add(row)
            }
            continue
          }
          // A text change inside a tracked row (streaming): walk up to the row.
          let node = record.target.nodeType === 1 ? record.target : record.target.parentElement
          while (node !== null && node !== undefined && !this.rows.has(node)) node = node.parentElement
          if (node !== null && node !== undefined) this.dirty.add(node)
        }
        this.schedule()
      }

      /**
       * Whether a mutated control folds or unfolds one tracked row.
       *
       * The step-process group header and the Turn-process fold row both sit
       * *above* the row rather than containing it, so the containment test in
       * {@link onMutations} never sees them. Catching them here means a turn
       * that DSH folds on completion is re-opened on the same frame batch,
       * instead of leaving the reader looking at a folded process until the next
       * scan tick.
       *
       * @param row - a tracked row.
       * @param target - the mutated element.
       * @returns true when the control governs this row's turn or step group.
       */
      foldsFor(row, target) {
        const getAttribute = target.getAttribute?.bind(target)
        const closest = target.closest?.bind(target)
        if (getAttribute === undefined || closest === undefined) return false
        const turnLabel = getAttribute('data-turn-process')
        if (typeof turnLabel !== 'string' && closest('[data-step-process]') === null) return false
        const rowTurn = row.closest?.('[data-chat-turn]')?.dataset?.chatTurn
        if (typeof rowTurn !== 'string' || rowTurn === '') return false
        if (typeof turnLabel === 'string' && turnLabel !== '') return turnLabel === rowTurn
        return closest('[data-chat-turn]')?.dataset?.chatTurn === rowTurn
      }

      /** Forget a removed subtree and any row inside it. */
      forget(node) {
        if (this.rows.has(node)) {
          this.destroyRow(this.rows.get(node))
          this.rows.delete(node)
          return
        }
        for (const row of this.rows.keys()) {
          if (node.contains(row)) {
            this.destroyRow(this.rows.get(row))
            this.rows.delete(row)
          }
        }
      }

      /** adopt + reconcile + drop detached, batched onto one animation frame. */
      schedule() {
        if (this.frame !== null) return
        this.frame = window.requestAnimationFrame(() => {
          this.frame = null
          this.flushDirty()
        })
      }

      /** Process the dirty set. */
      flushDirty() {
        for (const row of [...this.dirty]) {
          this.dirty.delete(row)
          const state = this.rows.get(row)
          if (state === undefined) continue
          if (!row.isConnected) {
            this.destroyRow(state)
            this.rows.delete(row)
            continue
          }
          this.refresh(state)
        }
      }

      /** Full rescan; the safety net for rows the observer batch missed. */
      scan() {
        if (this.settings?.enabled !== true || this.settings?.apiKeySet !== true) return
        const seen = new Set()
        for (const kind of this.activeKinds()) {
          for (const row of document.querySelectorAll(kind.selector)) {
            seen.add(row)
            this.adopt(row, kind)
            this.dirty.add(row)
          }
        }
        for (const [row, state] of [...this.rows]) {
          if (!seen.has(row) || !row.isConnected) {
            this.destroyRow(state)
            this.rows.delete(row)
          }
        }
        this.schedule()
      }

      /**
       * Register one assistant row.
       * @param row - the row root for `kind`.
       * @param kind - the row kind that matched it.
       * @returns the row state.
       */
      adopt(row, kind) {
        let state = this.rows.get(row)
        if (state !== undefined) return state
        // A kind whose selector can only prefilter (prose) proves itself here:
        // no readable props means this element is not what the kind claims.
        if (kind.requireProps === true && typeof readPropsText(row, kind.matchesProps) !== 'string') return null
        state = {
          row,
          kind,
          companion: null,
          body: null,
          statusText: null,
          toggle: null,
          action: null,
          copy: null,
          source: '',
          sentUpTo: 0,
          sentSource: '',
          /** Whether the consumed prefix ends inside an open code fence. */
          fenceOpen: false,
          /** 'answer' | 'narration' for response rows; see {@link partOfRow}. */
          part: partOfRow(row),
          /**
           * Whether this row has produced its first verdict yet. A freshly adopted
           * row knows nothing, and showing a placeholder for it made a 旁白翻译 line
           * flash under every turn on load; see `awaitsVerdict`.
           */
          looked: false,
          /**
           * One entry per cut segment, always in source order. Each resolution
           * mutates its own entry, so concurrency cannot reorder the output.
           * @type {Array<{ segment: string, sep: string, text: string, status: string }>}
           */
          parts: [],
          status: 'idle',
          error: '',
          collapsed: false,
          idleTimer: null,
          generation: 0,
          /** Whether this row was ever seen streaming, i.e. is genuinely new. */
          live: kind.isLive(row),
          /** Set once the user asks for this row explicitly. */
          requested: false,
          /** One pass may bypass the store entirely (the refresh action). */
          forceMode: false,
          /** Derived counts over {@link parts}; see `recount`. */
          missing: 0,
          skipped: 0,
          pending: 0
        }
        this.rows.set(row, state)
        this.render(state)
        return state
      }

      /** Tear down one row's companion and timers. */
      destroyRow(state) {
        if (state.idleTimer !== null) window.clearTimeout(state.idleTimer)
        state.generation += 1
        state.companion?.remove()
        state.companion = null
      }

      /**
       * Re-read one row, decide whether it may spend provider traffic, and
       * translate whatever became available.
       *
       * This is where "new conversations only" is decided. A row is *live* once
       * it has been seen streaming (or appears within {@link LIVE_GRACE_MS} of
       * another row that was). Everything already finished when the page showed
       * up — loaded history, previous conversations — is not live, so it is only
       * ever looked up: the stored translation is replayed for free, and a
       * segment the host has never seen waits for the row's own translate button.
       *
       * @param state - the row state.
       */
      refresh(state) {
        // Which part of the turn this is decides the badge and, for the style
        // module, which translation style applies.
        state.part = partOfRow(state.row)
        if (this.settings?.autoExpand === true) this.expand(state.row)
        if (state.kind.isLive(state.row)) {
          state.live = true
          this.lastRunningAt = Date.now()
        } else if (state.live !== true && Date.now() - (this.lastRunningAt ?? 0) < LIVE_GRACE_MS) {
          // A turn is in flight; the text just finished before we looked.
          state.live = true
        }
        const source = readRowText(state.row, state.kind)
        if (source !== state.source) {
          state.source = source
          if (state.idleTimer !== null) window.clearTimeout(state.idleTimer)
          state.idleTimer = window.setTimeout(() => {
            state.idleTimer = null
            // `block` mode must not send anything before the row settles.
            this.pump(state, cutModeOf(this.settings).idleFlush)
          }, IDLE_MS)
        }
        this.pump(state, false)
      }

      /**
       * Adopt the conversation the header control belongs to.
       *
       * The header is the only part of the shell that reliably knows which
       * conversation is on screen, and a session-scoped slot hands it the id, so the
       * control reports it here. Without it the plugin can only follow its own switch.
       *
       * @param sessionId - the conversation, or null when there is none.
       */
      setSession(sessionId) {
        const next = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
        if (next === this.sessionId) return
        this.sessionId = next
        // Another conversation's switch must never leak into this one, not even for
        // the moment the lookup takes.
        this.sessionMode = null
        this.publish()
        this.reapplySessionGate()
        if (next !== null) void this.loadSessionMode()
      }

      /** Read this conversation's own switch from the host. */
      async loadSessionMode() {
        const asked = this.sessionId
        if (asked === null) return
        try {
          const data = await callApi('session.get', { sessionId: asked })
          // The reader may have moved on while this was in flight.
          if (this.sessionId !== asked) return
          this.sessionMode = data?.mode === 'on' || data?.mode === 'off' ? data.mode : null
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.sessionMode = null
        }
        this.publish()
        this.reapplySessionGate()
      }

      /**
       * Set this conversation's own switch.
       * @param mode - 'on', 'off', or null for "follow the plugin switch".
       */
      async setSessionMode(mode) {
        const asked = this.sessionId
        if (asked === null) return
        const next = mode === 'on' || mode === 'off' ? mode : null
        // Painted first: the button must answer the click immediately, and the host
        // is authoritative only about what got stored.
        this.sessionMode = next
        this.publish()
        this.reapplySessionGate()
        try {
          const data = await callApi('session.set', { sessionId: asked, mode: next })
          if (this.sessionId !== asked) return
          this.sessionMode = data?.mode === 'on' || data?.mode === 'off' ? data.mode : null
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error)
        }
        this.publish()
        this.reapplySessionGate()
      }

      /** Step one conversation through 跟随 → 开启 → 关闭 → 跟随. */
      cycleSessionMode() {
        const order = { null: 'on', on: 'off', off: null }
        return this.setSessionMode(order[this.sessionMode ?? 'null'] ?? null)
      }

      /** Whether translation is on for the conversation on screen. */
      translationOn() {
        return translationOnFor(this.settings, this.sessionId, this.sessionMode)
      }

      /**
       * Re-evaluate the page after the switch moves.
       *
       * Segments queued while the conversation was off are settled as skipped rather
       * than left pending, and every row repaints, so switching a conversation off
       * stops showing blocks it is no longer allowed to complete.
       */
      reapplySessionGate() {
        const on = this.translationOn()
        for (const state of this.rows.values()) {
          if (!on) {
            for (const part of state.parts) {
              if (part.status === 'pending' || part.status === 'missing') {
                part.status = 'skipped'
                part.text = ''
              }
            }
          }
          this.recount(state)
          this.render(state)
        }
      }

      /**
       * Whether this row may reach the provider.
       *
       * A user action always may; otherwise only reasoning that appeared live
       * (or history when the user opted into translating it).
       *
       * @param state - the row state.
       * @returns true when a provider call is allowed.
       */
      allowsProvider(state) {
        // The conversation's own switch decides in both directions, so it is
        // consulted before the plugin switch is considered at all.
        if (this.translationOn() !== true) return false
        if (state.requested === true) return true
        if (state.live === true) return true
        return this.settings?.includeHistory === true
      }

      /**
       * Re-run one row from the start, now allowed to spend.
       *
       * The host answers every already-stored segment from its own document, so
       * "translate the missing ones" and "translate everything again" are the
       * same pass with one flag.
       *
       * @param state - the row state.
       * @param force - ignore and overwrite stored translations.
       */
      act(state, force) {
        state.requested = true
        state.forceMode = force === true
        state.sentUpTo = 0
        state.sentSource = ''
        state.parts = []
        state.fenceOpen = false
        state.status = 'idle'
        state.error = ''
        state.generation += 1
        this.recount(state)
        this.dirty.add(state.row)
        this.schedule()
      }

      /**
       * Open one disclosure control, unless the reader already closed it.
       *
       * This is deliberately *not* "once ever". DSH folds a finished turn on its
       * own — the step-process group is collapsed and the member disclosures are
       * reset the moment the turn closes — so a ledger that never re-opened
       * anything left the reader staring at a folded process with auto-expand
       * switched on. What must survive is only the reader's own intent, which
       * {@link noteReaderToggle} records from trusted clicks.
       *
       * The cooldown exists because React applies the flip asynchronously: a scan
       * that runs before the attribute updates would otherwise toggle it back.
       *
       * @param element - a `[data-disclosure-row]` / disclosure button.
       */
      clickControl(element) {
        if (element === null || element === undefined) return
        if (this.readerClosed.has(element)) return
        const now = this.now()
        if (now - (this.clickedAt.get(element) ?? 0) < CLICK_COOLDOWN_MS) return
        this.clickedAt.set(element, now)
        const previous = document.activeElement
        try {
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        } catch {
          // A cross-realm or exotic event target must never break translation.
          this.clickedAt.delete(element)
          return
        }
        if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
          previous.focus({ preventScroll: true })
        }
      }

      /**
       * Record the reader's own toggle so auto-expand stops overriding it.
       *
       * Registered in the capture phase, so the reading happens before the chat's
       * own handler flips the state. A click this plugin synthesized has
       * `isTrusted === false` and never counts as reader intent.
       *
       * @param event - the click event.
       */
      noteReaderToggle(event) {
        if (event?.isTrusted !== true) return
        const target = event.target
        if (target === null || typeof target.closest !== 'function') return
        const control = target.closest(READER_CONTROLS)
        if (control === null) return
        // Only a click that *closes* an open control is a request to keep it shut.
        if (control.getAttribute('aria-expanded') === 'false') this.readerClosed.delete(control)
        else this.readerClosed.add(control)
      }

      /**
       * Why {@link expand} exists: DSH renders reasoning inside two folded
       * layers (the Turn-process fold row and the collapsed step-process group)
       * plus the reasoning row's own disclosure. Nothing in the window shows the
       * thinking until all three are open, so auto-expand opens exactly the
       * controls that sit above *this* row and are currently closed.
       *
       * @param row - a tracked reasoning row.
       */
      expand(row) {
        try {
          const own = row.querySelector('[data-disclosure-row][aria-expanded="false"]')
          if (own !== null) this.clickControl(own)

          const seat = row.closest('[data-step-process]')
          if (seat !== null) {
            const header = seat.querySelector('button[data-process-activity][aria-expanded="false"]')
            if (header !== null) this.clickControl(header)
          }

          const turn = row.closest('[data-chat-turn]')?.dataset?.chatTurn
          if (typeof turn === 'string' && turn !== '') {
            const fold = document.querySelector(
              `button[data-turn-process="${CSS.escape(turn)}"][aria-expanded="false"]:not([disabled])`
            )
            if (fold !== null) this.clickControl(fold)
          }
        } catch {
          // Selection failures are non-fatal: translation continues regardless.
        }
      }

      /**
       * Emit every segment that is safe to send right now.
       * @param state - the row state.
       * @param force - flush regardless of boundaries (idle timer fired).
       */
      pump(state, force) {
        if (state.source === '') return
        // A shorter or diverging source means the turn was rewritten
        // (regenerated, edited, replayed): every offset and译文 restarts.
        if (!state.source.startsWith(state.sentSource)) {
          state.sentUpTo = 0
          state.sentSource = ''
          state.parts = []
          state.fenceOpen = false
          state.generation += 1
          this.recount(state)
        }
        const rest = state.source.slice(state.sentUpTo)
        const maxChars = Number.isFinite(this.settings?.maxSegmentChars) ? this.settings.maxSegmentChars : 1800
        const running = state.kind.isLive(state.row)
        const flush = force || !running
        if (rest.trim() === '') {
          state.forceMode = false
          this.render(state)
          return
        }
        const { cut, sep } = pickCut(rest, running, maxChars, flush, cutModeOf(this.settings), state.fenceOpen === true)
        if (cut <= 0) {
          this.render(state)
          return
        }
        const segment = rest.slice(0, cut).replace(/\s+$/, '')
        state.sentUpTo += cut
        // Track the fence state across the consumed text so the next cut knows
        // whether it would land inside an open block.
        state.fenceOpen = fenceOpenAfter(segment, state.fenceOpen === true)
        // The separator is reproduced by the join step, never sent to the model.
        const separator = /^\s*/.exec(state.source.slice(state.sentUpTo))
        if (separator !== null) state.sentUpTo += separator[0].length
        state.sentSource = state.source.slice(0, state.sentUpTo)
        if (segment !== '') {
          // The part is created here, in source order, and only mutated later
          // by its own resolution — so three concurrent requests can finish in
          // any order without scrambling the paragraphs.
          const part = { segment, sep, text: '', status: 'pending' }
          state.parts.push(part)
          if (this.translationOn() !== true) {
            // Switched off for this conversation: settle the part as skipped so
            // nothing shows and nothing is asked for, without spending a request to
            // learn what we already decided.
            part.status = 'skipped'
            part.text = ''
            this.recount(state)
          } else {
            this.recount(state)
            this.enqueue(state, part, {
              provider: this.allowsProvider(state),
              force: state.forceMode
            })
          }
        }
        this.render(state)
        if (state.source.slice(state.sentUpTo).trim() !== '') {
          // More text is already available: keep draining on the next frame.
          this.dirty.add(state.row)
          this.schedule()
        }
      }

      /**
       * Recompute the derived counters from the parts.
       *
       * Every reader (button label, status line, empty check) goes through these
       * three numbers, so they are derived rather than incremented in several
       * places.
       *
       * @param state - the row state.
       */
      recount(state) {
        let missing = 0
        let skipped = 0
        let pending = 0
        for (const part of state.parts) {
          if (part.status === 'missing') missing += 1
          else if (part.status === 'skipped') skipped += 1
          else if (part.status === 'pending') pending += 1
        }
        state.missing = missing
        state.skipped = skipped
        state.pending = pending
        // The first pass has resolved once there is a part and nothing is pending.
        if (state.parts.length > 0 && pending === 0) state.looked = true
        if (pending > 0) state.status = 'translating'
        else if (state.error !== '') state.status = 'error'
        else state.status = 'idle'
      }

      /**
       * Resolve one part.
       *
       * The local {@link KNOWN} table answers first, then the host: without
       * `provider` the host only reports what it already stored, which is how a
       * historical row shows its fixed translation and nothing else.
       *
       * @param state - the owning row state.
       * @param part - the part to resolve, already in source order.
       * @param options - `{ provider, force }`.
       */
      enqueue(state, part, options) {
        const generation = state.generation
        const provider = options?.provider === true
        const force = options?.force === true
        const segment = part.segment

        const known = KNOWN.get(segment)
        if (!force && KNOWN.has(segment)) {
          if (known === null) {
            // Known-untranslated: only a permitted pass may fill it in.
            if (!provider) {
              part.status = 'missing'
              this.recount(state)
              return
            }
          } else if (known === '') {
            // The host skipped it as already Chinese.
            part.status = 'skipped'
            this.recount(state)
            return
          } else {
            part.text = known
            part.status = 'ready'
            this.recount(state)
            return
          }
        }

        this.runner.push(async () => {
          if (this.destroyed || state.generation !== generation) return
          try {
            // The conversation goes with every request: the host resolves the
            // effective switch itself, so a request can never outrun a click.
            const data = await callApi('translate', { text: segment, provider, force, sessionId: this.sessionId })
            if (state.generation !== generation) return
            if (data.skipped === true) {
              part.status = 'skipped'
              remember(segment, '')
            } else if (data.missing === true) {
              part.status = 'missing'
              remember(segment, null)
            } else if (typeof data.text === 'string' && data.text !== '') {
              part.text = data.text
              part.status = 'ready'
              remember(segment, data.text)
            } else {
              part.status = 'skipped'
            }
            state.error = ''
          } catch (error) {
            if (state.generation !== generation) return
            part.status = 'missing'
            state.error = error instanceof Error ? error.message : String(error)
            this.lastError = state.error
          }
          this.recount(state)
          this.render(state)
          this.publish()
        })
      }

      /** @returns the joined translation of one row, in source order. */
      translatedText(state) {
        return joinParts(state.parts.filter(part => part.status === 'ready'))
      }

      /**
       * What this row's own button should do right now.
       *
       * Untranslated segments come first: a pass that fills them replays every
       * stored segment for free, so it is neither a re-translation nor an
       * expense. Only a fully translated row can be refreshed, which is the one
       * action that overwrites the store.
       *
       * @param state - the row state.
       * @returns `{ label, force, title }`.
       */
      actionOf(state) {
        const noun = state.kind.id === 'prose' ? '这段文字' : '这条思考链'
        if (state.pending > 0) return { label: '翻译中…', force: false, title: '' }
        if (state.missing > 0) return { label: '翻译', force: false, title: `翻译${noun}（已保存的段落直接复用）` }
        if (this.translatedText(state) !== '') return { label: '刷新', force: true, title: `重新翻译${noun}，并覆盖已保存的译文` }
        return { label: '翻译', force: false, title: `翻译${noun}` }
      }

      /**
       * Run this row's button action.
       * @param state - the row state.
       */
      runAction(state) {
        this.act(state, this.actionOf(state).force)
      }

      /**
       * Whether this row has nothing to offer and should stay out of the way.
       *
       * A row whose every segment the host called "already Chinese" gets no
       * companion at all — otherwise a Chinese answer or a Chinese reasoning
       * block would grow a pointless `中文翻译 · 原文已是中文 · [翻译]` line under
       * it. Anything still untranslated keeps its companion so the button is
       * reachable.
       *
       * @param state - the row state.
       * @returns true when the companion must be hidden.
       */
      isNoop(state) {
        return this.translatedText(state) === ''
          && state.missing === 0
          && state.pending === 0
          && state.skipped > 0
      }

      /**
       * Whether the companion is still waiting for its first verdict.
       *
       * On load every response row is adopted before anything is known about it, so
       * rendering a placeholder would flash a block under every turn and hide it
       * again as the (free) lookups come back. Nothing is known, so nothing is
       * shown — except where the placeholder *is* the feedback: a row that is still
       * streaming, and a row the reader asked about.
       *
       * @param state - the row state.
       * @returns true when the companion must stay hidden for now.
       */
      awaitsVerdict(state) {
        return state.looked !== true && state.live !== true && state.requested !== true
      }

      /**
       * Create or refresh the companion node under one row.
       *
       * The companion exists for every tracked row, not only for translated
       * ones: a historical row needs somewhere to put its translate button.
       * With nothing to show it collapses to a single header line.
       *
       * @param state - the row state.
       */
      render(state) {
        this.ensureCompanion(state)
        if (state.body === null || state.companion === null) return
        const text = this.translatedText(state)
        const empty = text === ''
        state.body.hidden = empty
        state.body.textContent = empty
          ? (state.status === 'translating' ? '正在翻译…' : '')
          : text
        state.companion.toggleAttribute('data-empty', empty)

        const status = state.status === 'error'
          ? `翻译失败：${state.error}`
          : state.pending > 0
            ? '翻译中…'
            : empty
              ? (state.missing > 0 ? '未翻译' : state.skipped > 0 ? '原文已是中文' : '等待内容…')
              : ''
        state.statusText.textContent = status

        if (state.action !== null) {
          const plan = this.actionOf(state)
          state.action.textContent = plan.label
          state.action.disabled = state.status === 'translating'
          state.action.title = plan.title
        }
        state.companion.dataset.status = state.status
        state.companion.dataset.kind = state.kind.id
        state.companion.toggleAttribute('data-collapsed', state.collapsed)
        state.toggle.hidden = empty
        state.toggle.textContent = state.collapsed ? '展开' : '收起'
        if (state.copy !== null) state.copy.hidden = empty
        // Nothing to show and nothing to ask for: stay out of the way entirely. A
        // conversation switched off shows no blocks at all — the translations stay in
        // the store, so switching it back on brings them straight back.
        state.companion.hidden = this.translationOn() !== true
          || this.isNoop(state)
          || this.awaitsVerdict(state)
      }

      /** Build and place the companion node directly after the row. */
      ensureCompanion(state) {
        if (state.companion !== null) {
          if (state.companion.isConnected && state.companion.previousSibling === state.row) return
          state.companion.remove()
          state.companion = null
        }
        if (state.row.parentNode === null) return

        const companion = document.createElement('div')
        companion.dataset.dshTm = 'block'
        companion.dataset.status = 'idle'
        companion.dataset.kind = state.kind.id
        companion.dataset.dshTmPart = state.part

        const head = document.createElement('div')
        head.dataset.dshTm = 'head'

        const badge = document.createElement('span')
        badge.dataset.dshTm = 'badge'
        badge.textContent = this.badgeText(state)
        badge.title = this.badgeTitle(state) ?? ''

        const status = document.createElement('span')
        status.dataset.dshTm = 'status'

        const action = document.createElement('button')
        action.type = 'button'
        action.dataset.dshTm = 'act'
        action.textContent = '翻译'
        action.addEventListener('click', () => {
          this.runAction(state)
        })

        const copy = document.createElement('button')
        copy.type = 'button'
        copy.dataset.dshTm = 'act'
        copy.title = '复制中文翻译'
        copy.textContent = '复制'
        copy.addEventListener('click', () => {
          const text = this.translatedText(state)
          if (text !== '') void navigator.clipboard?.writeText(text)
        })

        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.dataset.dshTm = 'act'
        toggle.title = '展开或收起中文翻译'
        toggle.textContent = '收起'
        toggle.addEventListener('click', () => {
          state.collapsed = !state.collapsed
          this.render(state)
        })

        const body = document.createElement('div')
        body.dataset.dshTm = 'body'

        head.append(badge, status, action, copy, toggle)
        companion.append(head, body)
        state.row.parentNode.insertBefore(companion, state.row.nextSibling)

        state.companion = companion
        state.body = body
        state.statusText = status
        state.toggle = toggle
        state.action = action
        state.copy = copy
        state.collapsed = false
      }
    }
    //#endregion


    //#region settings page
    /** Dictionary namespace owned by this plugin. */
    const NS = 'text-translator'

    /** Simplified Chinese copy. */
    const zh = {
      nav: '文本翻译',
      title: '文本翻译',
      sessionFollow: '跟随',
      sessionOn: '开启',
      sessionOff: '关闭',
      sessionSwitchLabel: '翻译开关',
      sessionSwitchTitle: '本对话的翻译开关：跟随 = 用插件总开关；开启 = 本对话翻译，即使总开关关闭；关闭 = 本对话不翻译，即使总开关开启。点击在这三种之间切换。',
      description: '两个互相独立的模块：① 把英文思考链和思考之间的零散文字自动翻译成中文；② 自定义对话内各类文字的样式。翻译请求由本机 Host 转发到你配置的 DeepSeek 接口，API Key 只保存在本机。',
      styleLang: 'zh',
      modules: '模块',
      moduleTranslation: '翻译模块',
      moduleTranslationHint: '把英文思考链、以及思考之间的零散文字自动翻译成中文。关闭后不产生任何翻译请求，已显示的译文会一并移除。',
      moduleStyle: '文字样式模块',
      moduleStyleHint: '自定义对话内各类文字的字体、字号、颜色、间距与边框。与翻译模块互不影响：翻译关掉也能用。',
      moduleOff: '本模块已关闭，下面的设置不会生效。',
      apiKey: 'DeepSeek API Key',
      apiKeyHint: '留空表示保持当前值不变；点击「清除」可删除已保存的 Key。',
      apiKeyPlaceholder: 'sk-…',
      apiKeySet: '已保存',
      apiKeyMissing: '未配置',
      showKey: '显示明文',
      hideKey: '隐藏明文',
      revealFailed: '读取明文失败：',
      clear: '清除',
      baseUrl: '接口地址',
      baseUrlHint: 'OpenAI 兼容的根地址，会自动补上 /v1/chat/completions。',
      model: '翻译模型',
      modelHint: '可以从接口拉取模型列表后挑选，也可以直接手动输入模型名。',
      modelList: '获取模型列表',
      modelListFetching: '获取中…',
      modelListOk: '已获取 {count} 个可用模型。',
      modelListEmpty: '接口没有返回任何模型，请手动填写模型名。',
      modelListFailed: '获取模型列表失败：',
      modelListNeedsKey: '请先填写并保存 API Key，再获取模型列表。',
      modelPick: '从列表选择…',
      thinking: '翻译模型的思考模式',
      thinkingHint: '自动为不发送该参数；开启/关闭会发送 thinking.type，可能不被旧接口接受。',
      thinkingAuto: '自动',
      thinkingOn: '开启',
      thinkingOff: '关闭',
      onlyEnglish: '只翻译英文思考',
      onlyEnglishHint: '已经是中文的内容直接跳过；超过 60 字符、又几乎没有成词英文的片段（纯路径 / 链接 / 标识符）也跳过。两者都避免无意义的开销。',
      translateProse: '同时翻译思考之间的零散文字',
      translateProseHint: '模型在工具调用之间会输出一两句说明（英文），它和思考块一样会被增量翻译、落盘、可刷新。已经是中文的段落会跳过并且不显示任何块（最终回答通常就是中文，所以不会多出一块）。关掉本项后只翻译思考块。',
      autoExpand: '自动展开思考链',
      autoExpandHint: '自动点开思考链本身、以及包住它的「工作进行」折叠行，省得每次手动展开。同一处只展开一次：你手动收起后它保持收起；重新打开本选项会再展开一遍当前内容。',
      includeHistory: '连历史思考一起自动翻译',
      includeHistoryHint: '默认关闭：只自动翻译本次打开页面后新产生的思考（正在流式输出的那些）。以前对话里的思考不会自动花钱翻译，但每条思考链旁边都有「翻译」按钮，需要时点一下即可。打开本项会连已加载的历史一起自动翻译。',
      storedCount: '已保存 {count} 条译文',
      storedFile: '译文库',
      sample: '翻译自检',
      sampleHint: '把下面这段英文按真实分段流程发给翻译模型，用来确认整条链路（分段 → 翻译 → 拼接）是否可用。',
      sampleLabel: '测试文本',
      samplePlaceholder: 'Paste an English reasoning paragraph…',
      sampleRun: '测试翻译',
      sampleRunning: '翻译中…',
      sampleOk: '翻译正常（{segments} 段，{ms} ms）',
      sampleFailed: '翻译测试失败：',
      sampleSkipped: '（宿主判定该段已是中文，已跳过）',
      cutMode: '翻译粒度',
      cutModeHint: '实测本会话 357 个内容块（78 万字符）的请求数：跟手 9,147 → 均衡 4,194（46%）→ 只按段落 3,681（40%）→ 思考完再翻约 980（11%）。越小越跟手、越贵；越大越省、中文出现得越晚。',
      cutModeResponsive: '跟手：一句一句出（最贵）',
      cutModeBalanced: '均衡：攒到一小段再出（推荐）',
      cutModeParagraph: '只按段落出',
      cutModeBlock: '思考完再翻：整块一次出（最省）',
      badgeReasoning: '中文翻译',
      badgeAnswer: '正文翻译',
      badgeProse: '旁白翻译',
      badgeReasoningTitle: '思考链的中文翻译',
      badgeAnswerTitle: '回答正文的中文翻译',
      badgeProseTitle: '思考块之间零散文字的中文翻译',
      advanced: '高级',
      maxSegmentChars: '单次翻译上限（字符）',
      maxSegmentCharsHint: '思考内容按段落增量翻译，超过此长度的段落会被切分。',
      timeoutMs: '请求超时（毫秒）',
      timeoutMsHint: '单次翻译请求的最长等待时间。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接正常，模型返回：',
      statusEnabled: '运行中',
      statusDisabled: '未启用',
      statusNoKey: '未配置 API Key',
      stats: '已跟踪 {rows} 个思考块，{pending} 个翻译请求排队中',
      engineError: '宿主路由不可用：',
      hostStale: '宿主端插件还是旧版本，重启 DeepSeek Harness 后即可使用',
      loadFailed: '读取设置失败：',
      saveFailed: '保存失败：',
      testFailed: '测试失败：',
      styleInline: '在对话中立即生效',
      styleInlineHint: '打开后，下面的改动会立刻应用到正在显示的对话；关闭则只影响本页预览（保存后下次打开仍然生效）。',
      stylePreview: '效果预览',
      stylePreviewHint: '这段示例用与真实对话完全相同的 CSS 渲染，改任何一项都会立刻反映在它上面。',
      styleTargets: '可自定义的内容',
      styleTargetsHint: '每一项都自带一组预设；点「调整细节」可以逐项微调。',
      styleCustomize: '调整细节',
      styleCollapse: '收起',
      styleResetTarget: '回到预设',
      styleResetAll: '全部恢复默认',
      styleCustomized: '已自定义',
      styleUnused: '需要翻译模块',
      styleUnusedHint: '翻译模块关闭时这一项没有可作用的对象。',
      styleGroupContent: '主要内容',
      styleGroupEmphasis: '强调与引用',
      styleGroupStructure: '结构',
      styleGroupCode: '代码与命令',
      styleGroupOther: '其他',
      styleBody: '正文',
      styleNarration: '旁白',
      styleReasoning: '思维翻译',
      styleProse: '旁白翻译',
      styleProseAnswer: '正文翻译',
      styleEmphasis: '着重',
      styleQuote: '引用',
      styleLink: '链接',
      styleHeading: '标题',
      styleList: '列表',
      styleInlineCode: '行内代码',
      styleCode: '代码块',
      styleCommand: '命令说明',
      styleToolOutput: '工具输出',
      styleUser: '我的消息',
      knobFont: '字体',
      knobSize: '字号 px',
      knobLineHeight: '行高',
      knobWeight: '字重',
      knobItalic: '斜体',
      knobSpacing: '字距 px',
      knobColor: '文字色',
      knobOpacity: '不透明度',
      knobAlign: '对齐',
      knobPaddingLeft: '左边距 px',
      knobPaddingRight: '右边距 px',
      knobPaddingY: '上下内边距 px',
      knobMarginY: '上下外边距 px',
      knobBackground: '背景',
      knobRadius: '圆角 px',
      knobBorderSides: '边框',
      knobBorderWidth: '边框粗细 px',
      knobBorderStyle: '边框样式',
      knobBorderColor: '边框颜色',
      sideNone: '无边框',
      sideLeft: '左侧竖线',
      sideRight: '右侧',
      sideTop: '上边',
      sideBottom: '下边',
      sideAll: '四周',
      knobUnderline: '下划线',
      knobAuto: '跟随',
      alignLeft: '左对齐',
      alignCenter: '居中',
      alignRight: '右对齐',
      alignJustify: '两端对齐',
      borderSolid: '实线',
      borderDashed: '虚线',
      borderDotted: '点线',
      presetDefault: '默认',
      presetCompact: '紧凑',
      presetRoomy: '宽松',
      presetLarge: '大字',
      presetSerif: '衬线',
      presetQuiet: '弱化',
      presetSmall: '小号',
      presetItalic: '斜体',
      presetCard: '卡片',
      presetFaint: '淡化',
      presetMono: '等宽',
      presetBar: '竖线',
      presetBold: '加粗',
      presetAccent: '强调色',
      presetMarker: '荧光笔',
      presetUnderline: '下划线',
      presetDashed: '虚线',
      presetBrand: '品牌色',
      presetTight: '紧凑',
      presetSoft: '淡底',
      presetPlain: '朴素',
      presetTinted: '淡染',
      presetDim: '变淡',
      stylePreset: '预设',
      styleSampleText: '示例文字',
    }

    /** English copy. */
    const en = {
      nav: 'Text Translator',
      title: 'Text Translator',
      sessionFollow: 'Follow',
      sessionOn: 'On',
      sessionOff: 'Off',
      sessionSwitchLabel: 'Translation switch',
      sessionSwitchTitle: 'Translation for this conversation: Follow = use the plugin switch; On = translate it even when the plugin is off; Off = leave it alone even when the plugin is on. Click to cycle.',
      description: 'Two independent modules: (1) translate English reasoning and the narration between thinking blocks into Chinese, and (2) restyle the text inside the conversation. Requests go through the local Host to the DeepSeek endpoint you configure; the API key never leaves this machine.',
      styleLang: 'en',
      modules: 'Modules',
      moduleTranslation: 'Translation module',
      moduleTranslationHint: 'Translate English reasoning, and the narration between thinking blocks, into Chinese. While off, no translation request is made and any shown translation is removed.',
      moduleStyle: 'Text style module',
      moduleStyleHint: 'Restyle the fonts, sizes, colours, spacing and edges of the text inside the conversation. Independent of the translation module: it works with translation switched off.',
      moduleOff: 'This module is off, so the settings below have no effect.',
      apiKey: 'DeepSeek API key',
      apiKeyHint: 'Leave blank to keep the stored key; use Clear to delete it.',
      apiKeyPlaceholder: 'sk-…',
      apiKeySet: 'stored',
      apiKeyMissing: 'not set',
      showKey: 'Show',
      hideKey: 'Hide',
      revealFailed: 'Could not read the key: ',
      clear: 'Clear',
      baseUrl: 'Endpoint',
      baseUrlHint: 'OpenAI-compatible base; /v1/chat/completions is appended automatically.',
      model: 'Translation model',
      modelHint: 'Fetch the model directory and pick one, or type any model id by hand.',
      modelList: 'Fetch models',
      modelListFetching: 'Fetching…',
      modelListOk: '{count} models available.',
      modelListEmpty: 'The endpoint returned no models; type the model id by hand.',
      modelListFailed: 'Could not fetch models: ',
      modelListNeedsKey: 'Save an API key first, then fetch the model list.',
      modelPick: 'Pick from the list…',
      thinking: 'Thinking mode of the translation model',
      thinkingHint: 'Auto omits the field; On/Off send thinking.type, which older endpoints may reject.',
      thinkingAuto: 'Auto',
      thinkingOn: 'On',
      thinkingOff: 'Off',
      onlyEnglish: 'Only translate English reasoning',
      onlyEnglishHint: 'Skip content that already reads as Chinese, and long segments that are only paths, links or identifiers (no real words).',
      translateProse: 'Also translate the text between thinking blocks',
      translateProseHint: 'The one-liners the model emits between tool calls are translated incrementally like reasoning, stored, and refreshable. Segments that already read as Chinese are skipped and show no block at all (a final answer is usually Chinese, so it gains nothing). Turn this off to translate reasoning only.',
      autoExpand: 'Auto-expand the thinking chain',
      autoExpandHint: 'Opens the reasoning disclosure and the "worked" folds around it, so nothing has to be clicked. Each control is opened once: collapsing it by hand keeps it collapsed, and re-enabling this option expands what is currently mounted again.',
      includeHistory: 'Also auto-translate history',
      includeHistoryHint: 'Off by default: only reasoning produced after this page opened (the streaming ones) is translated automatically. Thinking from earlier conversations never costs anything on its own — every reasoning row keeps a Translate button. Turning this on auto-translates the loaded history too.',
      storedCount: '{count} translation(s) stored',
      storedFile: 'Translation store',
      sample: 'Translation self-test',
      sampleHint: 'Sends the English below through the real pipeline (segment → translate → join) to confirm the whole chain works.',
      sampleLabel: 'Sample text',
      samplePlaceholder: 'Paste an English reasoning paragraph…',
      sampleRun: 'Test translation',
      sampleRunning: 'Translating…',
      sampleOk: 'Translation OK ({segments} segments, {ms} ms)',
      sampleFailed: 'Translation test failed: ',
      sampleSkipped: '(the Host decided this segment is already Chinese and skipped it)',
      cutMode: 'Translation granularity',
      cutModeHint: 'Provider requests measured on this session\'s 357 blocks (784k chars): responsive 9,147 → balanced 4,194 (46%) → paragraph 3,681 (40%) → wait-for-block ~980 (11%). Smaller feels more live and costs more; larger is cheaper and shows Chinese later.',
      cutModeResponsive: 'Responsive: sentence by sentence (most expensive)',
      cutModeBalanced: 'Balanced: a short burst at a time (recommended)',
      cutModeParagraph: 'Paragraph by paragraph',
      cutModeBlock: 'Wait for the block: one pass when it finishes (cheapest)',
      badgeReasoning: 'Chinese',
      badgeAnswer: 'Answer',
      badgeProse: 'Narration',
      badgeReasoningTitle: 'Chinese translation of this reasoning block',
      badgeAnswerTitle: 'Chinese translation of the answer body',
      badgeProseTitle: 'Chinese translation of the text between thinking blocks',
      advanced: 'Advanced',
      maxSegmentChars: 'Segment cap (characters)',
      maxSegmentCharsHint: 'Reasoning is translated incrementally by paragraph; longer paragraphs are split.',
      timeoutMs: 'Request timeout (ms)',
      timeoutMsHint: 'Longest wait for one translation request.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection OK, model replied: ',
      statusEnabled: 'running',
      statusDisabled: 'disabled',
      statusNoKey: 'no API key',
      stats: 'Tracking {rows} reasoning blocks, {pending} queued translation requests',
      engineError: 'Host route unavailable: ',
      hostStale: 'the Host half is still the old build — restart DeepSeek Harness to use this',
      loadFailed: 'Could not read settings: ',
      saveFailed: 'Save failed: ',
      testFailed: 'Test failed: ',
      styleInline: 'Apply to the conversation immediately',
      styleInlineHint: 'While on, every change below lands in the conversation you are looking at; while off they only affect this page (saved settings still apply next time).',
      stylePreview: 'Preview',
      stylePreviewHint: 'This sample is rendered by exactly the CSS the real conversation gets, so every change shows up in it at once.',
      styleTargets: 'What you can restyle',
      styleTargetsHint: 'Each entry ships a set of presets; open Adjust details to fine-tune it.',
      styleCustomize: 'Adjust details',
      styleCollapse: 'Collapse',
      styleResetTarget: 'Use the preset',
      styleResetAll: 'Reset everything',
      styleCustomized: 'customized',
      styleUnused: 'needs the translation module',
      styleUnusedHint: 'With the translation module off there is nothing for this entry to style.',
      styleGroupContent: 'Main content',
      styleGroupEmphasis: 'Emphasis and quotes',
      styleGroupStructure: 'Structure',
      styleGroupCode: 'Code and commands',
      styleGroupOther: 'Other',
      styleBody: 'Answer body',
      styleNarration: 'Narration',
      styleReasoning: 'Reasoning translation',
      styleProse: 'Narration translation',
      styleProseAnswer: 'Answer translation',
      styleEmphasis: 'Emphasis',
      styleQuote: 'Quote',
      styleLink: 'Link',
      styleHeading: 'Heading',
      styleList: 'List',
      styleInlineCode: 'Inline code',
      styleCode: 'Code block',
      styleCommand: 'Command caption',
      styleToolOutput: 'Tool output',
      styleUser: 'My messages',
      knobFont: 'Font',
      knobSize: 'Size px',
      knobLineHeight: 'Line height',
      knobWeight: 'Weight',
      knobItalic: 'Italic',
      knobSpacing: 'Letter spacing px',
      knobColor: 'Text colour',
      knobOpacity: 'Opacity',
      knobAlign: 'Align',
      knobPaddingLeft: 'Left padding px',
      knobPaddingRight: 'Right padding px',
      knobPaddingY: 'Padding top/bottom px',
      knobMarginY: 'Margin top/bottom px',
      knobBackground: 'Background',
      knobRadius: 'Radius px',
      knobBorderSides: 'Border',
      knobBorderWidth: 'Border width px',
      knobBorderStyle: 'Border style',
      knobBorderColor: 'Border colour',
      sideNone: 'No border',
      sideLeft: 'Left bar',
      sideRight: 'Right',
      sideTop: 'Top',
      sideBottom: 'Bottom',
      sideAll: 'All sides',
      knobUnderline: 'Underline',
      knobAuto: 'Inherit',
      alignLeft: 'Left',
      alignCenter: 'Centre',
      alignRight: 'Right',
      alignJustify: 'Justify',
      borderSolid: 'Solid',
      borderDashed: 'Dashed',
      borderDotted: 'Dotted',
      presetDefault: 'Default',
      presetCompact: 'Compact',
      presetRoomy: 'Roomy',
      presetLarge: 'Large',
      presetSerif: 'Serif',
      presetQuiet: 'Quiet',
      presetSmall: 'Small',
      presetItalic: 'Italic',
      presetCard: 'Card',
      presetFaint: 'Faint',
      presetMono: 'Monospace',
      presetBar: 'Bar',
      presetBold: 'Bold',
      presetAccent: 'Accent',
      presetMarker: 'Marker',
      presetUnderline: 'Underline',
      presetDashed: 'Dashed',
      presetBrand: 'Brand',
      presetTight: 'Tight',
      presetSoft: 'Soft fill',
      presetPlain: 'Plain',
      presetTinted: 'Tinted',
      presetDim: 'Dimmed',
      stylePreset: 'preset',
      styleSampleText: 'Sample text',
    }

    /** Shared field styles. */
    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '760px' },
      section: { display: 'flex', flexDirection: 'column', gap: '14px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '6px 10px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        outline: 'none'
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      checkbox: { width: '14px', height: '14px', accentColor: 'var(--dsw-alias-brand-primary)' },
      sessionSwitch: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '26px',
        padding: '0 10px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      sessionSwitchDot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'currentColor',
        opacity: 0.6
      },
      button: {
        appearance: 'none',
        padding: '5px 12px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      primary: {
        appearance: 'none',
        padding: '5px 14px',
        fontSize: '13px',
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      warn: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      mono: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '88px',
        resize: 'vertical',
        padding: '8px 10px',
        fontSize: '12px',
        fontFamily: 'var(--ds-font-family-code, monospace)',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        outline: 'none'
      },
      result: {
        boxSizing: 'border-box',
        width: '100%',
        maxHeight: '220px',
        overflow: 'auto',
        padding: '8px 10px',
        fontSize: '13px',
        lineHeight: '1.7',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      disabled: { opacity: 0.55, cursor: 'default' },
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      groupTitle: {
        fontSize: '12px',
        letterSpacing: '.04em',
        color: 'var(--dsw-alias-label-tertiary)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        paddingBottom: '4px'
      },
      target: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-1)'
      },
      targetHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      targetName: { flex: '1 1 auto', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      badgeCustom: {
        flex: 'none',
        padding: '0 6px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: {
        appearance: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: '64px',
        padding: '4px 8px',
        textAlign: 'left',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      chipActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 0 0 1px var(--dsw-alias-brand-primary) inset'
      },
      chipSample: { display: 'block', fontSize: '12px', lineHeight: '16px', overflow: 'hidden' },
      knobs: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '6px 12px',
        paddingTop: '6px',
        borderTop: '1px dashed var(--dsw-alias-border-l1)'
      },
      knob: { display: 'flex', alignItems: 'center', gap: '6px' },
      knobLabel: { flex: '0 0 92px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      knobRange: { flex: '1 1 auto', minWidth: '60px', accentColor: 'var(--dsw-alias-brand-primary)' },
      knobSelect: {
        flex: '1 1 auto',
        minWidth: '60px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      knobValue: { flex: '0 0 34px', fontSize: '11px', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' },
      clearKnob: {
        appearance: 'none',
        flex: 'none',
        padding: '0 4px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      mockBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px',
        fontSize: '13px',
        lineHeight: '1.7',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      mockTool: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      mockBadge: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }
    }

    /**
     * Render a host failure, flagging the one failure mode the user can fix:
     * a browser half that knows a route the running Host half does not have yet.
     * @param error - the thrown failure.
     * @param t - the page's locale reader.
     * @returns the display text.
     */
    function describeError(error, t) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      return code === 'not-found' ? `${message}（${t('hostStale')}）` : message
    }

    /** One labelled form row. */
    function Field({ label, hint, children }) {
      return h('div', { style: styles.field },
        h('label', { style: styles.label }, label),
        children,
        hint === undefined || hint === '' ? null : h('div', { style: styles.hint }, hint))
    }

    /** Model ids offered before anything has been fetched from the endpoint. */
    const SUGGESTED_MODELS = ['deepseek-chat', 'deepseek-reasoner']

    /** The sample the self-test translates; written to look like real reasoning. */
    const SAMPLE_REASONING = [
      'Let me look at the failing assertion again before I touch the parser.',
      '',
      'The tokenizer drops trailing whitespace, so the expected column index is off by one. I will fix the tokenizer first, then re-run the suite to confirm nothing else regressed.'
    ].join('\n')

    /**
     * Merge the provider's cached model ids with the built-in suggestions.
     * @param cached - ids persisted by the host.
     * @returns a de-duplicated, sorted list that always keeps the defaults.
     */
    function mergeModels(cached) {
      const seen = new Set(SUGGESTED_MODELS)
      for (const id of Array.isArray(cached) ? cached : []) {
        if (typeof id === 'string' && id.trim() !== '') seen.add(id.trim())
      }
      return [...seen]
    }

    /**
     * Run one text through the engine's real segmentation and the host's real
     * translation route, joining the pieces exactly as the live translator does.
     * @param text - the sample to translate.
     * @param maxChars - the configured per-request cap.
     * @param skippedLabel - copy used when the Host skips a segment.
     * @returns `{ segments, text }`.
     */
    async function runSegmentedTranslation(text, maxChars, skippedLabel) {
      const segments = []
      let rest = text
      let guard = 0
      while (rest.trim() !== '' && guard < 200) {
        guard += 1
        const picked = pickCut(rest, false, maxChars, true)
        if (picked.cut <= 0) break
        const segment = rest.slice(0, picked.cut).replace(/\s+$/, '')
        rest = rest.slice(picked.cut).replace(/^\s+/, '')
        if (segment !== '') segments.push({ segment, sep: picked.sep })
      }
      const pieces = []
      for (const part of segments) {
        const data = await callApi('translate', { text: part.segment, force: true })
        const piece = data.skipped === true ? skippedLabel : String(data.text ?? '')
        if (piece === '') continue
        pieces.push({ text: piece, sep: part.sep })
      }
      return { segments: segments.length, text: joinParts(pieces) }
    }

    /**
     * The per-conversation translation switch, rendered in the session header.
     *
     * Three states, because "follow the plugin switch" is a real choice of its own:
     * 开启 and 关闭 override the plugin switch in both directions, which is what lets
     * one conversation keep translating while the plugin is switched off, and stay
     * quiet while it is on.
     */
    function SessionSwitchButton(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const engine = props.engine
      const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      // The header is what tells the engine which conversation is on screen.
      useEffect(() => { engine.setSession(sessionId) }, [sessionId])
      const known = state.sessionId === sessionId
      const mode = known && (state.sessionMode === 'on' || state.sessionMode === 'off') ? state.sessionMode : 'follow'
      const text = mode === 'on' ? t('sessionOn') : mode === 'off' ? t('sessionOff') : t('sessionFollow')
      const color = mode === 'on'
        ? 'var(--dsw-alias-label-primary)'
        : mode === 'off' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)'
      return h('button', {
        type: 'button',
        title: t('sessionSwitchTitle'),
        'data-mode': mode,
        'data-known': known ? 'yes' : 'no',
        style: { ...styles.sessionSwitch, color },
        onClick: () => { void engine.cycleSessionMode() }
      },
      h('span', { style: styles.sessionSwitchDot }),
      h('span', null, text))
    }

    /**
     * The settings page registered into `settings.section`.
     * @param props - `t` comes from the slot's locale seat, `engine` from inject.
     */
    function SettingsSection(props) {      // Defensive: a slot whose locale seat is unavailable must still render
      // rather than take the whole settings panel down with it.
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const engine = props.engine
      const engineState = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
      const [loaded, setLoaded] = useState(false)
      const [draft, setDraft] = useState({
        enabled: true,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        thinking: 'auto',
        onlyEnglish: true,
        autoExpand: false,
        translateProse: true,
        includeHistory: false,
        cutMode: 'balanced',
        maxSegmentChars: 1800,
        timeoutMs: 45000,
      })
      const [apiKeySet, setApiKeySet] = useState(false)
      const [apiKeyMask, setApiKeyMask] = useState('')
      const [apiKeyInput, setApiKeyInput] = useState('')
      /** Plaintext fetched on demand by the "show" control. */
      const [apiKeyPlain, setApiKeyPlain] = useState('')
      const [revealed, setRevealed] = useState(false)
      const [models, setModels] = useState([...SUGGESTED_MODELS])
      const [modelNote, setModelNote] = useState(null)
      /** Version the running host half reported, so a stale host is visible. */
      const [hostVersion, setHostVersion] = useState('')
      /** How many segments the host already has stored. */
      const [storedCount, setStoredCount] = useState(0)
      /** Where the host keeps its translation store. */
      const [storedFile, setStoredFile] = useState('')
      const [sample, setSample] = useState(SAMPLE_REASONING)
      const [sampleResult, setSampleResult] = useState(null)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)
      const clearKeyRef = useRef(false)

      const patch = (fields) => setDraft((current) => ({ ...current, ...fields }))

      /** Patch the style module's own document. */

      // Leaving the page without saving gives the conversation back its saved look
      // rather than keeping a draft the reader can no longer see.
      useEffect(() => () => styleEngine.revert(), [])

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const data = await callApi('settings.get')
            if (cancelled) return
            const s = data.settings
            setDraft({
              enabled: s.enabled,
              baseUrl: s.baseUrl,
              model: s.model,
              thinking: s.thinking,
              onlyEnglish: s.onlyEnglish,
              autoExpand: s.autoExpand === true,
              translateProse: s.translateProse !== false,
              includeHistory: s.includeHistory === true,
              cutMode: typeof s.cutMode === 'string' ? s.cutMode : 'balanced',
              maxSegmentChars: s.maxSegmentChars,
              timeoutMs: s.timeoutMs,
            })
            setApiKeySet(s.apiKeySet)
            setApiKeyMask(s.apiKeyMask)
            setModels(mergeModels(s.cachedModels))
            setHostVersion(typeof s.pluginVersion === 'string' ? s.pluginVersion : '')
            setStoredCount(Number.isFinite(s.translationCount) ? s.translationCount : 0)
            setStoredFile(typeof s.translationsFile === 'string' ? s.translationsFile : '')
            setLoaded(true)
          } catch (error) {
            if (!cancelled) {
              setMessage({ kind: 'bad', text: t('loadFailed') + describeError(error, t) })
              setLoaded(true)
            }
          }
        })()
        return () => { cancelled = true }
      }, [])

      /** Persist the staged values and let the engine adopt them. */
      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const settings = { ...draft }
          if (clearKeyRef.current) settings.apiKey = ''
          else if (apiKeyInput.trim() !== '') settings.apiKey = apiKeyInput.trim()
          const data = await callApi('settings.update', { settings })
          const s = data.settings
          setApiKeySet(s.apiKeySet)
          setApiKeyMask(s.apiKeyMask)
          setApiKeyInput('')
          setApiKeyPlain('')
          setRevealed(false)
          clearKeyRef.current = false
          setMessage({ kind: 'ok', text: t('saved') })
          // The draft is persisted now, so the engine may take the host's copy.
          void 0
          await engine.reload()
          return true
        } catch (error) {
          setMessage({ kind: 'bad', text: t('saveFailed') + describeError(error, t) })
          return false
        } finally {
          setBusy('')
        }
      }

      /** Save first, then ask the host to run one probe request. */
      const test = async () => {
        setBusy('test')
        setMessage(null)
        try {
          await save()
          const data = await callApi('test')
          setMessage({ kind: 'ok', text: t('testOk') + String(data.reply ?? '') })
        } catch (error) {
          setMessage({ kind: 'bad', text: t('testFailed') + describeError(error, t) })
        } finally {
          setBusy('')
        }
      }

      /**
       * Show the stored key in the clear. Only this loopback-fenced route hands
       * the plaintext back, and only for as long as the field stays revealed.
       */
      const toggleReveal = async () => {
        if (revealed) {
          setRevealed(false)
          setApiKeyPlain('')
          setApiKeyInput('')
          return
        }
        if (!apiKeySet) {
          setApiKeyPlain('')
          setRevealed(true)
          return
        }
        try {
          const data = await callApi('settings.reveal')
          setApiKeyPlain(String(data.apiKey ?? ''))
          setApiKeyInput('')
          setRevealed(true)
        } catch (error) {
          setMessage({ kind: 'bad', text: t('revealFailed') + describeError(error, t) })
        }
      }

      /** Fetch the endpoint's model directory and remember it. */
      const fetchModels = async () => {
        setBusy('models')
        setModelNote(null)
        setMessage(null)
        try {
          if (!apiKeySet && apiKeyInput.trim() === '') {
            setModelNote({ kind: 'bad', text: t('modelListNeedsKey') })
            return
          }
          // The route reads the saved key, so stage what is on screen first.
          if (!(await save())) return
          const data = await callApi('models.list')
          const list = mergeModels(data.models)
          setModels(list)
          setModelNote({
            kind: 'ok',
            text: Array.isArray(data.models) && data.models.length === 0
              ? t('modelListEmpty')
              : t('modelListOk').replace('{count}', String(Array.isArray(data.models) ? data.models.length : 0))
          })
          const first = Array.isArray(data.models) ? data.models[0] : undefined
          if (typeof first === 'string' && !mergeModels(data.models).includes(draft.model)) patch({ model: first })
        } catch (error) {
          setModelNote({ kind: 'bad', text: t('modelListFailed') + describeError(error, t) })
        } finally {
          setBusy('')
        }
      }

      /** Run the sample through the real pipeline and show what came back. */
      const testTranslation = async () => {
        setBusy('sample')
        setSampleResult(null)
        setMessage(null)
        try {
          if (!(await save())) return
          const started = Date.now()
          const cap = Number.isFinite(Number(draft.maxSegmentChars)) ? Number(draft.maxSegmentChars) : 1800
          const outcome = await runSegmentedTranslation(sample, cap, t('sampleSkipped'))
          setSampleResult({
            kind: 'ok',
            headline: t('sampleOk')
              .replace('{segments}', String(outcome.segments))
              .replace('{ms}', String(Date.now() - started)),
            text: outcome.text
          })
        } catch (error) {
          setSampleResult({
            kind: 'bad',
            headline: t('sampleFailed') + describeError(error, t),
            text: ''
          })
        } finally {
          setBusy('')
        }
      }

      const statusText = engineState.ready
        ? t('statusEnabled')
        : engineState.enabled ? t('statusNoKey') : t('statusDisabled')
      const statsText = t('stats')
        .replace('{rows}', String(engineState.rows))
        .replace('{pending}', String(engineState.pending))

      return h('div', { style: styles.page },
        h('div', { style: styles.section },
          h('div', { style: styles.label }, t('title')),
          h('div', { style: styles.hint }, t('description')),
          h('div', { style: styles.muted },
            `${hostVersion === '' ? '' : `v${hostVersion} · `}${statusText} · ${statsText}`),
          h('div', { style: styles.muted },
            `${t('storedCount').replace('{count}', String(storedCount))}${storedFile === '' ? '' : ` · ${t('storedFile')}: ${storedFile}`}`)),

        h('div', { style: styles.section },
          h('div', { style: styles.label }, t('modules')),
          h(Field, { label: t('moduleTranslation'), hint: t('moduleTranslationHint') },
            h('div', { style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft.enabled,
                onChange: (event) => patch({ enabled: event.target.checked })
              }),
              draft.enabled ? null : h('span', { style: styles.warn }, t('moduleOff')))),
          h(Field, {
            label: t('apiKey'),
            hint: apiKeySet ? `${t('apiKeySet')}：${apiKeyMask}` : t('apiKeyHint')
          },
          h('div', { style: styles.row },
            h('input', {
              type: revealed ? 'text' : 'password',
              style: styles.input,
              placeholder: apiKeySet ? apiKeyMask : t('apiKeyPlaceholder'),
              value: revealed ? (apiKeyInput !== '' ? apiKeyInput : apiKeyPlain) : apiKeyInput,
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => {
                clearKeyRef.current = false
                setApiKeyInput(event.target.value)
              }
            }),
            h('button', {
              type: 'button',
              style: styles.button,
              title: revealed ? t('hideKey') : t('showKey'),
              onClick: () => { void toggleReveal() }
            }, revealed ? t('hideKey') : t('showKey')),
            h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => {
                clearKeyRef.current = true
                setApiKeyInput('')
                setApiKeyPlain('')
                setRevealed(false)
                setApiKeySet(false)
                setApiKeyMask('')
              }
            }, t('clear')))),
          h(Field, { label: t('baseUrl'), hint: t('baseUrlHint') },
            h('input', {
              type: 'text',
              style: styles.input,
              value: draft.baseUrl,
              spellCheck: false,
              onChange: (event) => patch({ baseUrl: event.target.value })
            })),
          h(Field, { label: t('model'), hint: t('modelHint') },
            h('div', { style: styles.row },
              h('input', {
                type: 'text',
                style: styles.input,
                list: 'dsh-rt-models',
                value: draft.model,
                spellCheck: false,
                placeholder: 'deepseek-chat',
                onChange: (event) => patch({ model: event.target.value })
              }),
              h('button', {
                type: 'button',
                style: { ...styles.button, ...((busy !== '' || !loaded) ? styles.disabled : {}) },
                disabled: busy !== '' || !loaded,
                onClick: () => { void fetchModels() }
              }, busy === 'models' ? t('modelListFetching') : t('modelList'))),
            h('select', {
              style: styles.input,
              value: models.includes(draft.model) ? draft.model : '',
              disabled: !loaded,
              onChange: (event) => {
                if (event.target.value !== '') patch({ model: event.target.value })
              }
            },
            h('option', { value: '' }, t('modelPick')),
            ...models.map(id => h('option', { key: id, value: id }, id))),
            h('datalist', { id: 'dsh-rt-models' },
              ...models.map(id => h('option', { key: id, value: id }))),
            modelNote === null
              ? null
              : h('div', { style: modelNote.kind === 'ok' ? styles.ok : styles.bad }, modelNote.text)),
          h(Field, { label: t('thinking'), hint: t('thinkingHint') },
            h('select', {
              style: styles.input,
              value: draft.thinking,
              onChange: (event) => patch({ thinking: event.target.value })
            },
            h('option', { value: 'auto' }, t('thinkingAuto')),
            h('option', { value: 'on' }, t('thinkingOn')),
            h('option', { value: 'off' }, t('thinkingOff')))),
          h(Field, { label: t('onlyEnglish'), hint: t('onlyEnglishHint') },
            h('div', { style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft.onlyEnglish,
                onChange: (event) => patch({ onlyEnglish: event.target.checked })
              }))),
          h(Field, { label: t('translateProse'), hint: t('translateProseHint') },
            h('div', { style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft.translateProse,
                onChange: (event) => patch({ translateProse: event.target.checked })
              }))),
          h(Field, { label: t('autoExpand'), hint: t('autoExpandHint') },
            h('div', { style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft.autoExpand,
                onChange: (event) => patch({ autoExpand: event.target.checked })
              }))),
          h(Field, { label: t('includeHistory'), hint: t('includeHistoryHint') },
            h('div', { style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft.includeHistory,
                onChange: (event) => patch({ includeHistory: event.target.checked })
              })))),


        h('div', { style: styles.section },
          h('div', { style: styles.label }, t('advanced')),
          h(Field, { label: t('cutMode'), hint: t('cutModeHint') },
            h('select', {
              style: styles.input,
              value: draft.cutMode,
              onChange: (event) => patch({ cutMode: event.target.value })
            },
            h('option', { value: 'responsive' }, t('cutModeResponsive')),
            h('option', { value: 'balanced' }, t('cutModeBalanced')),
            h('option', { value: 'paragraph' }, t('cutModeParagraph')),
            h('option', { value: 'block' }, t('cutModeBlock')))),
          h('div', { style: styles.row },
            h('div', { style: { ...styles.field, flex: '1 1 0' } },
              h('label', { style: styles.label }, t('maxSegmentChars')),
              h('input', {
                type: 'number',
                style: styles.input,
                value: draft.maxSegmentChars,
                min: 200,
                max: 20000,
                onChange: (event) => patch({ maxSegmentChars: Number(event.target.value) })
              })),
            h('div', { style: { ...styles.field, flex: '1 1 0' } },
              h('label', { style: styles.label }, t('timeoutMs')),
              h('input', {
                type: 'number',
                style: styles.input,
                value: draft.timeoutMs,
                min: 5000,
                max: 300000,
                step: 1000,
                onChange: (event) => patch({ timeoutMs: Number(event.target.value) })
              }))),
          h('div', { style: styles.hint }, t('maxSegmentCharsHint'))),

        h('div', { style: styles.section },
          h('div', { style: styles.label }, t('sample')),
          h('div', { style: styles.hint }, t('sampleHint')),
          h('label', { style: styles.label }, t('sampleLabel')),
          h('textarea', {
            style: styles.mono,
            value: sample,
            spellCheck: false,
            placeholder: t('samplePlaceholder'),
            onChange: (event) => setSample(event.target.value)
          }),
          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              style: { ...styles.button, ...((busy !== '' || !loaded) ? styles.disabled : {}) },
              disabled: busy !== '' || !loaded,
              onClick: () => { void testTranslation() }
            }, busy === 'sample' ? t('sampleRunning') : t('sampleRun'))),
          sampleResult === null ? null : h('div', null,
            h('div', { style: sampleResult.kind === 'ok' ? styles.ok : styles.bad }, sampleResult.headline),
            sampleResult.text === ''
              ? null
              : h('div', { style: { ...styles.result, marginTop: '6px' } }, sampleResult.text))),

        h('div', { style: styles.row },
          h('button', {
            type: 'button',
            style: styles.primary,
            disabled: busy !== '' || !loaded,
            onClick: () => { void save() }
          }, busy === 'save' ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy !== '' || !loaded,
            onClick: () => { void test() }
          }, busy === 'test' ? t('testing') : t('test'))),

        message === null ? null : h('div', { style: message.kind === 'ok' ? styles.ok : styles.bad }, message.text),
        engineState.lastError === ''
          ? null
          : h('div', { style: styles.bad }, t('engineError') + engineState.lastError))
    }
    //#endregion

    /** Cordis services this browser half needs. */
    const inject = ['slots', 'locale']

    /**
     * Mount the browser half.
     * @param ctx - the Cordis browser context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'text-translator: dictionaries')

      const engine = new Translator()
      // The badges and tooltips come from the locale dictionary, so the two
      // kinds of translation can read differently.
      engine.label = (key) => t(key)
      ctx.effect(() => {
        void engine.start()
        return () => engine.stop()
      }, 'text-translator: translator')

      // The style module owns its own stylesheet and observer, so it keeps working
      // with the translation module switched off. Its sheet must land *after* the
      // translator's base one: equal-specificity rules go to the later sheet, and
      // that is how orderSides: none removes the bar a translation block ships.
      ctx.effect(() => {
        void 0
        return () => {}
      }, 'text-translator: unused')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'text-manager',
        order: 220,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ engine })
      }, SettingsSection)), 'text-translator: settings page')

      // The per-conversation switch lives where the reader can reach it without
      // opening settings. The header is also the only reliable source of "which
      // conversation is on screen", so this control reports it to the engine.
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'text-manager-session-switch',
        order: 3,
        label: () => t('sessionSwitchLabel'),
        locale: NS,
        inject: () => ({ engine })
      }, SessionSwitchButton)), 'text-translator: session switch')

      // Settings live on the host; pick up changes made in another window.
      ctx.effect(() => {
        const onVisibility = () => { if (document.visibilityState === 'visible') void engine.reload() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, 'text-translator: settings refresh')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    /**
     * Internals exposed for the offline test suite (test/client.test.mjs) and
     * for in-page debugging. The runner ignores unknown exports.
     */
    exports.__internals = {
      pickCut,
      findSentenceEnd,
      fiberOf,
      readPropsText,
      readRowText,
      mergeModels,
      runSegmentedTranslation,
      SettingsSection,
      SessionSwitchButton,
      translationOnFor,
      Translator,
      Runner,
      joinParts,
      ROW_KINDS,
      STYLESHEET,
      partOfRow,
      badgeKeyOf,
      badgeTitleKeyOf,
      CUT_MODES,
      cutModeOf,
      fenceOpenAfter,
      KNOWN,
      remember,
      LIVE_GRACE_MS,
      IDLE_MS
    }
    return module.exports
  }
})
