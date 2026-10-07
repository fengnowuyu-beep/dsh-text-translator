/**
 * Build a standalone preview of the two translation blocks.
 *
 * The stylesheet comes from the shipped plugin bundle, and the theme token
 * values come from the shipped theme bundle, so the preview shows the real look
 * (both light and dark) rather than an approximation.
 *
 * Run: node tools/make-preview.mjs <extracted dsh-client-ui-theme dir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const themeDir = process.argv[2]
if (themeDir === undefined) {
  console.error('usage: node tools/make-preview.mjs <extracted dsh-client-ui-theme dir>')
  process.exit(1)
}

// The shipped companion stylesheet, so the preview cannot drift from it.
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const stylesheet = /const STYLESHEET = `([\s\S]*?)`\n/.exec(client)?.[1]
if (stylesheet === undefined) {
  console.error('could not read STYLESHEET from lib/client.js')
  process.exit(1)
}

// ── theme tokens, harvested from the shipped theme bundle ───────────────────
// The bundle carries several flat `body{…}` / `body[data-ds-dark-theme]{…}`
// blocks: the static palette first, then the aliases, for each theme. A
// separator cannot be required before the selector — the previous block's `}`
// is consumed by the match — so the pattern only anchors on the word itself.
const theme = readFileSync(join(themeDir, 'lib', 'client.js'), 'utf8')
const BLOCK = /\b(body|html|:root)(\[[^\]]{1,40}\])?\s*\{([^{}]*)\}/g
const DECLARATION = /(--dsw-[a-z0-9-]+)\s*:\s*([^;{}"'\\]+)/g

const light = new Map()
const dark = new Map()
let blocks = 0
for (const match of theme.matchAll(BLOCK)) {
  const isDark = (match[2] ?? '').includes('dark')
  blocks += 1
  for (const declaration of match[3].matchAll(DECLARATION)) {
    const value = declaration[2].trim()
    dark.set(declaration[1], value)
    if (!isDark) light.set(declaration[1], value)
  }
}
console.log(`theme blocks read: ${blocks}, declarations: ${dark.size}`)

/** Resolve `var(--x)` references one level, so the preview needs no indirection. */
const resolve = map => {
  const out = {}
  for (const [name, raw] of map) {
    out[name] = raw.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/g, (whole, reference, fallback) => (
      map.get(reference) ?? (fallback === undefined ? whole : fallback.trim())
    ))
  }
  return out
}

/** The tokens the stylesheet actually reads, plus the ones the mock text uses. */
const wanted = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary', '--dsw-radius-sm', '--dsw-radius-lg',
  '--dsh-content-font-size-secondary', '--dsh-content-font-delta-secondary'
]
// Radius and content-font tokens are theme-independent and live in blocks the
// per-theme scan does not always reach, so they also get a whole-file scan.
const anywhere = new Map()
for (const match of theme.matchAll(DECLARATION)) anywhere.set(match[1], match[2].trim())

const lightResolved = resolve(light)
const darkResolved = resolve(dark)
const anywhereResolved = resolve(anywhere)

const lightOut = {}
const darkOut = {}
for (const name of wanted) {
  const lightValue = lightResolved[name] ?? anywhereResolved[name]
  const darkValue = darkResolved[name] ?? anywhereResolved[name]
  if (lightValue !== undefined) lightOut[name] = lightValue
  if (darkValue !== undefined) darkOut[name] = darkValue
}
const present = wanted.filter(name => lightOut[name] !== undefined)
const missing = wanted.filter(name => lightOut[name] === undefined)
const declarations = map => Object.entries(map).map(([name, value]) => `  ${name}:${value};`).join('\n')
console.log(`tokens resolved: ${present.length}/${wanted.length}`)
if (missing.length > 0) console.log(`  missing: ${missing.join(', ')}`)
console.log(`  brand light/dark: ${lightOut['--dsw-alias-brand-primary']} / ${darkOut['--dsw-alias-brand-primary']}`)
console.log(`  border-l2 light/dark: ${lightOut['--dsw-alias-border-l2']} / ${darkOut['--dsw-alias-border-l2']}`)
for (const name of wanted) {
  if (missing.includes(name)) continue
  console.log(`  ${name.padEnd(38)} ${lightOut[name]}  |  ${darkOut[name]}`)
}

const block = ({ kind, badge, title, status, body, empty }) => `
        <div class="frame">
          <div class="origin">${title}</div>
          <div data-dsh-tm="block" data-kind="${kind}"${empty ? ' data-empty' : ''}>
            <div data-dsh-tm="head">
              <span data-dsh-tm="badge">${badge}</span>
              <span data-dsh-tm="status">${status}</span>
              <button data-dsh-tm="act">${empty ? '翻译' : '刷新'}</button>
              <button data-dsh-tm="act">复制</button>
            </div>
            ${empty ? '' : `<div data-dsh-tm="body">${body}</div>`}
          </div>
        </div>`

const column = (label, darkMode) => `
    <section class="${darkMode ? 'dark' : 'light'}"${darkMode ? ' data-ds-dark-theme' : ''}>
      <h2>${label}</h2>
      <p class="hint">思考块翻译（品牌色竖条 + 卡片底色）</p>
      ${block({ kind: 'reasoning', badge: '中文翻译', status: '已翻译 · 3 段',
        title: 'Let me verify the segment ordering logic before describing it.',
        body: '让我先确认一下分段顺序的逻辑，然后再说明。实测下来，句末切分才是成本主因。' })}
      ${block({ kind: 'reasoning', badge: '中文翻译', status: '未翻译', title: 'Another reasoning block.', body: '', empty: true })}
      <p class="hint" style="margin-top:26px">零散文字翻译（灰竖条 + 虚线顶边 + 无底色）</p>
      ${block({ kind: 'prose', badge: '旁白翻译', status: '已翻译 · 2 段',
        title: 'Now let me run the tests and compare both outputs.',
        body: '现在把测试跑一遍，然后看一下两边的输出是否一致。' })}
      ${block({ kind: 'prose', badge: '旁白翻译', status: '未翻译', title: 'And then I will update the README.', body: '', empty: true })}
    </section>`

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>思考译文 vs 旁白译文 — 样式预览</title>
<style>
/* ── real theme tokens, lifted from @deepseek-ai/dsh-client-ui-theme ─────── */
.light{
${declarations(lightOut)}
}
.dark{
${declarations(darkOut)}
}
*{box-sizing:border-box}
/* preview-only: these two come from the content-scale plugin at runtime */
:root{--dsh-content-font-size-secondary:13px;--dsh-content-font-delta-secondary:0px}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f2f3f5;color:#1b1c1e}
.columns{display:grid;grid-template-columns:1fr 1fr;gap:0;min-height:100vh}
section{padding:22px}
section.light{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1b1c1e)}
section.dark{background:var(--dsw-alias-bg-base,#131417);color:var(--dsw-alias-label-primary,#f2f3f5)}
h2{font-size:14px;font-weight:600;margin:0 0 14px}
.hint{font-size:11px;margin:0 0 6px;color:var(--dsw-alias-label-tertiary,#8b8d93)}
.frame{margin:0 0 16px}
.origin{border-left:2px solid transparent;padding:2px 0 2px 10px;color:var(--dsw-alias-label-secondary,#b9bbc1);font-size:13px}
/* ── the shipped plugin stylesheet, verbatim ───────────────────────────── */
${stylesheet}
</style>
</head>
<body>
<div class="columns">
${column('浅色', false)}
${column('深色', true)}
</div>
</body>
</html>
`

mkdirSync(join(root, 'preview'), { recursive: true })
const out = join(root, 'preview', 'prose-style.html')
writeFileSync(out, page)
console.log(`wrote ${out}`)
