/**
 * Build a standalone gallery of the text-style presets.
 *
 * The CSS comes from the module's own generator (loaded from the shipped bundle),
 * and the sample markup mirrors the settings page, so what this file shows is what
 * the conversation will get. Each pane is one preset combination, scoped by pane id.
 *
 * Run: node tools/make-style-preview.mjs <extracted dsh-client-ui-theme dir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const themeDir = process.argv[2]
if (themeDir === undefined) {
  console.error('usage: node tools/make-style-preview.mjs <extracted dsh-client-ui-theme dir>')
  process.exit(1)
}

// ── load the browser half far enough to reach its style generator ───────────
let definition
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout,
  clearTimeout
}
globalThis.document = {
  body: {},
  head: { append() {} },
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, append() {}, addEventListener() {}, remove() {} }),
  addEventListener() {},
  removeEventListener() {}
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.HTMLElement = class {}
globalThis.CSS = { escape: (value) => value }
globalThis.MouseEvent = class {}
const ReactStub = {
  createElement: () => null,
  useEffect() {},
  useMemo() {},
  useRef: () => ({ current: null }),
  useState: () => [undefined, () => {}],
  useSyncExternalStore: () => undefined
}
await import(pathToFileURL(join(root, 'lib', 'client.js')).href)
const bundle = definition.factory((id) => {
  if (id === 'react') return { default: ReactStub, ...ReactStub }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  throw new Error(`unexpected require("${id}")`)
})
const { textStyleCss, STYLE_TARGETS } = bundle.__internals

// ── theme tokens, harvested from the shipped theme bundle ───────────────────
const theme = readFileSync(join(themeDir, 'lib', 'client.js'), 'utf8')
const BLOCK = /\b(body|html|:root)(\[[^\]]{1,40}\])?\s*\{([^{}]*)\}/g
const DECLARATION = /(--dsw-[a-z0-9-]+)\s*:\s*([^;{}"'\\]+)/g
const light = new Map()
const dark = new Map()
for (const match of theme.matchAll(BLOCK)) {
  const isDark = (match[2] ?? '').includes('dark')
  for (const declaration of match[3].matchAll(DECLARATION)) {
    dark.set(declaration[1], declaration[2].trim())
    if (!isDark) light.set(declaration[1], declaration[2].trim())
  }
}

/** @returns the map with `var()` references resolved one level. */
const resolve = map => Object.fromEntries([...map].map(([name, raw]) => [name, raw.replace(
  /var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/g,
  (whole, reference, fallback) => map.get(reference) ?? (fallback === undefined ? whole : fallback.trim())
)]))
const wanted = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary',
  '--dsw-static-amber-500', '--dsw-static-blue-500',
  '--dsw-radius-sm', '--dsw-radius-lg'
]
const lightOut = resolve(light)
const darkOut = resolve(dark)
const tokens = (map, only) => only.map(name => `  ${name}:${map[name] ?? 'inherit'};`).join('\n')

// ── the sample conversation, the same shape the settings page mocks ─────────
const sample = () => `
      <div data-dsh-tm-mock="user"><strong>我的消息：</strong>把这几段话的样式分开调一下。</div>
      <div data-dsh-tm-mock="reasoning">
        <div class="badge">思维翻译</div>
        <div>让我先确认一下分段顺序的逻辑，再决定要不要改成卡片样式。</div>
      </div>
      <div data-dsh-tm-mock="narration">
        <p style="margin:0">Now let me run the suite and compare both outputs before touching the stylesheet.</p>
      </div>
      <div data-dsh-tm-mock="prose">
        <div class="badge">旁白翻译</div>
        <div>现在把测试跑一遍，然后对照两边的输出。</div>
      </div>
      <div data-dsh-tm-mock="body">
        <h3 style="margin:10px 0 6px">结论</h3>
        <p style="margin:0 0 8px">段落顺序由 <strong data-dsh-tm-mock="emphasis">源序槽位</strong> 保证，见
          <a data-dsh-tm-mock="link" href="#">说明</a> 与 <code data-dsh-tm-mock="inlineCode">joinParts()</code>。</p>
        <blockquote data-dsh-tm-mock="quote">切点不落在未闭合的代码围栏里。</blockquote>
        <ul data-dsh-tm-mock="list" style="margin:0 0 8px;padding-left:20px"><li>第一项</li><li>第二项</li></ul>
        <pre data-dsh-tm-mock="code" style="margin:0 0 8px">const parts = joinParts(state.parts)</pre>
        <div class="tool">
          <div data-dsh-tm-mock="command">运行测试：node test/host.test.mjs</div>
          <pre data-dsh-tm-mock="toolOutput" style="margin:0">37/37 checks passed</pre>
        </div>
      </div>`

/** @returns one pane: a labelled row of the mock with only that pane's rules. */
const pane = (id, label, note, textStyle) => {
  const rules = textStyleCss(textStyle)
    .split('\n')
    .filter(line => line.startsWith('[data-dsh-tm-mock'))
    .map(line => `#${id} ${line}`)
    .join('\n')
  return `
    <section class="pane" id="${id}">
      <h2>${label}</h2>
      <p class="note">${note}</p>
      <div class="frame">
        <style>${rules}</style>
        <div class="mock">${sample()}</div>
      </div>
    </section>`
}

const style = textStyle => ({ enabled: true, live: true, targets: textStyle })

const panes = [
  pane('p0', '原样（模块关闭）', '什么都没改，作为对照。', { enabled: false, live: true, targets: {} }),
  pane('p1', '紧凑', '正文紧凑、旁白小号、代码与工具输出紧凑。', style({
    body: { preset: 'compact', options: {} },
    narration: { preset: 'small', options: {} },
    reasoning: { preset: 'faint', options: {} },
    prose: { preset: 'quiet', options: {} },
    code: { preset: 'compact', options: {} },
    toolOutput: { preset: 'compact', options: {} },
    command: { preset: 'quiet', options: {} }
  })),
  pane('p2', '重点突出', '正文放大、着重用荧光笔、引用带竖线、命令说明用强调色、两种译文都做成卡片。', style({
    body: { preset: 'large', options: {} },
    emphasis: { preset: 'marker', options: {} },
    quote: { preset: 'bar', options: {} },
    link: { preset: 'underline', options: {} },
    heading: { preset: 'accent', options: {} },
    command: { preset: 'accent', options: {} },
    reasoning: { preset: 'card', options: {} },
    prose: { preset: 'card', options: {} }
  })),
  pane('p3', '等宽', '正文与旁白都用等宽字体，代码感更强；旁白配淡底。', style({
    body: { preset: 'default', options: { font: 'mono', size: 13 } },
    narration: { preset: 'default', options: { font: 'mono', size: 12.5, color: 'soft' } },
    reasoning: { preset: 'mono', options: {} },
    prose: { preset: 'mono', options: {} },
    code: { preset: 'card', options: {} },
    toolOutput: { preset: 'card', options: {} },
    command: { preset: 'mono', options: {} },
    inlineCode: { preset: 'plain', options: {} }
  })),
  pane('p4', '淡雅卡片', '正文衬线、每类块都带淡底卡片与圆角，适合长时间阅读。', style({
    body: { preset: 'serif', options: {} },
    narration: { preset: 'card', options: {} },
    reasoning: { preset: 'card', options: {} },
    prose: { preset: 'card', options: {} },
    quote: { preset: 'card', options: {} },
    code: { preset: 'tinted', options: {} },
    toolOutput: { preset: 'card', options: {} },
    user: { preset: 'card', options: {} }
  }))
].join('')

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>文本管理器 · 文字样式预设预览</title>
<style>
.light{
${tokens(lightOut, wanted)}
}
.dark{
${tokens(darkOut, wanted)}
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
header{padding:20px 24px 4px}
h1{font-size:16px;margin:0 0 6px}
header p{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px;padding:18px 24px 32px}
.pane{display:flex;flex-direction:column;gap:6px}
.pane h2{font-size:13px;margin:0}
.pane .note{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.frame{padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}
.mock{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.7}
.mock .badge{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mock .tool{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm)}
</style>
</head>
<body class="light">
<header>
  <h1>文字样式预设画廊</h1>
  <p>每一格都由插件自己的 CSS 生成器渲染，与设置页预览、真实对话用的是同一份规则。主题变量取自安装产物（这里是浅色；深色下 token 会自动切换）。</p>
</header>
<main class="grid">${panes}
</main>
</body>
</html>
`

mkdirSync(join(root, 'preview'), { recursive: true })
const out = join(root, 'preview', 'text-style.html')
writeFileSync(out, page)
console.log(`wrote ${out}`)
console.log(`targets in the catalogue: ${STYLE_TARGETS.length}`)
console.log(`panes: ${panes.split('<section').length - 1}`)
