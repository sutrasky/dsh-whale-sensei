/**
 * tools/circle-bands.js —— 圆圈色 → 标题色带（**只读消费者**：包里不做任何颜色数学）
 * ------------------------------------------------------------------
 * 输入：`assets/circle-bands-data.js`（**冻结表**，由 `_title-bands/freeze.mjs` 生成）
 *       + `lessons/<圆圈>/halo.json` 的 `color`
 * 输出：`assets/circle-bands.css` —— 每个圆圈、每种主题两条变量：
 *
 *     --lesson-title-band    大标题：以圈色为锚的渐变（锚色已按该底校准过对比度）
 *     --lesson-rainbow-band  小标题：与圈色最接近的那支词板（静态）
 *
 * 为什么包里没有 ΔE / 对比度 / 校准系数（用户 2026-09-22 裁定「甲」）：
 *   词板数据的家在包外的跨项目归档 `_title-bands/`。包一旦引那个绝对路径，
 *   换机器 / 上 CI 就红（§9 那个病）。所以数学留归档，包只读**结果**；
 *   归档那边用 `node freeze.mjs <包> --check` 与这张表做逐字节对拍。
 *
 * ⚠️ 本文件产出的 CSS **全是裸 rgb()** —— 这是设计如此（它就是色带本身）。
 *   所以它**故意不在** `tools/style-check.js` 的 `CSS_FILES` 清单里：那是"组件 CSS 不许有裸色"
 *   的检查，对一份生成出来的色带表没有意义。别为了"整齐"把它加进去。
 *
 * CLI：
 *   node tools/circle-bands.js            写 assets/circle-bands.css
 *   node tools/circle-bands.js --check    只校验有没有漂移（漂移 → 退出码 1）
 *
 * **MIRROR-OF: tools/circle-bands.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const DATA = path.join(ROOT, 'assets', 'circle-bands-data.js')
const OUT = path.join(ROOT, 'assets', 'circle-bands.css')

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** 读冻结表并做形状自检（缺字段就报，不用"大概能跑"糊过去） */
function loadTable(root) {
  const file = path.join(root, 'assets', 'circle-bands-data.js')
  if (!fs.existsSync(file)) {
    throw new Error(`缺 ${rel(file)} —— 先在 _title-bands/ 里跑：node freeze.mjs <课程包根>`)
  }
  delete require.cache[require.resolve(file)]
  const t = require(file)
  const bad = []
  if (typeof t !== 'object' || t === null) bad.push('整个文件不是对象')
  if (!t || t.version !== 1) bad.push(`version 应为 1（实得 ${t && t.version}）`)
  if (!t || typeof t.threshold !== 'number') bad.push('缺 threshold')
  if (!t || !t.backgrounds || !t.backgrounds.light || !t.backgrounds.dark) bad.push('缺 backgrounds.light/dark')
  if (!t || !t.entries || typeof t.entries !== 'object') bad.push('缺 entries')
  for (const [hex, v] of Object.entries((t && t.entries) || {})) {
    for (const mode of ['light', 'dark']) {
      const m = v && v[mode]
      if (!m) { bad.push(`${hex}.${mode} 缺失`); continue }
      for (const band of ['title', 'subtitle']) {
        if (!m[band] || !Array.isArray(m[band].stops) || m[band].stops.length < 2) bad.push(`${hex}.${mode}.${band}.stops 不是 ≥2 个色停`)
        else if (!m[band].stops.every((s) => Array.isArray(s) && s.length === 3 && s.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))) {
          bad.push(`${hex}.${mode}.${band}.stops 里有不是 0–255 整数的色停`)
        }
      }
      if (m.subtitle && typeof m.subtitle.palette !== 'string') bad.push(`${hex}.${mode}.subtitle 缺 palette 名`)
    }
  }
  if (bad.length) throw new Error(`assets/circle-bands-data.js 形状不对：\n  - ${bad.slice(0, 8).join('\n  - ')}`)
  return t
}

/** 圆圈：id + 显示名 + 身份色（从 lessons/<dir>/halo.json 读；id 取 halo.halo || 目录名） */
function circlesOf(root) {
  const dir = path.join(root, 'lessons')
  const out = []
  if (!fs.existsSync(dir)) throw new Error(`不是课程包：找不到 ${rel(dir)}`)
  for (const d of fs.readdirSync(dir).sort()) {
    if (d === 'src') continue
    const hf = path.join(dir, d, 'halo.json')
    if (!fs.existsSync(hf)) continue
    let j
    try { j = JSON.parse(fs.readFileSync(hf, 'utf8').replace(/^\uFEFF/, '')) } catch (e) {
      throw new Error(`${rel(hf)} 不是合法 JSON：${e.message}`)
    }
    out.push({ id: j.halo || d, dir: d, name: j.name || j.halo || d, color: j.color ? String(j.color).toLowerCase() : null })
  }
  return out
}

/** 一条 band → CSS 渐变值（与 palettes.css 的 `linear-gradient(90deg, …)` 同形） */
const grad = (stops) => 'linear-gradient(90deg, ' + stops.map((s) => `rgb(${s.join(', ')})`).join(', ') + ')'

/**
 * 生成 CSS 文本。
 * @returns {{css:string, circles:Array, missing:Array<{id:string,color:string|null}>}}
 *   missing = 没有 color、或 color 不在冻结表里的圆圈 —— 调用方**必须**把它当失败（见 main）
 */
function build(root) {
  const table = loadTable(root)
  const circles = circlesOf(root)
  const blocks = []
  const missing = []
  for (const c of circles) {
    const entry = c.color ? table.entries[c.color] : null
    if (!entry) { missing.push({ id: c.id, color: c.color }); continue }
    const line = (sel, m) => `${sel}{--lesson-title-band:${grad(m.title.stops)};--lesson-rainbow-band:${grad(m.subtitle.stops)}}`
    blocks.push(line(`[data-circle="${c.id}"]`, entry.light))
    blocks.push(line(`body[data-ds-dark-theme][data-circle="${c.id}"]`, entry.dark))
  }
  const head = [
    '/* 由 tools/circle-bands.js 生成 —— 不要手改。',
    ' * 数据源：assets/circle-bands-data.js（冻结表，来自 _title-bands/freeze.mjs）+ lessons/*/halo.json 的 color。',
    ' * 大标题吃 --lesson-title-band（以圈色为锚）、小标题吃 --lesson-rainbow-band（最接近的词板）。',
    ' * 没有 data-circle 的页面（如笔记页）走 presets/whale-sensei.css 里的全局默认值。 */',
    '',
  ].join('\n')
  return { css: head + (blocks.length ? blocks.join('\n') + '\n' : ''), circles, missing }
}

function main() {
  const check = process.argv.includes('--check')
  let r
  try {
    r = build(ROOT)
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
  if (r.missing.length) {
    console.error(`❌ ${r.missing.length} 个圆圈拿不到标题色带 —— 它们没有 \`color\`，或那个色不在冻结表里：`)
    for (const m of r.missing) console.error(`   · ${m.id}（color=${m.color || '缺'}）`)
    console.error('   修法：① 给 lessons/<圆圈>/halo.json 加 "color": "#rrggbb"（或改成表里已有的色）；')
    console.error('        ② 在 _title-bands/ 里跑 node freeze.mjs <课程包根> 重新冻结；③ 再跑本脚本。')
    process.exit(1)
  }
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null
  if (check) {
    if (cur === r.css) {
      console.log(`✅ ${rel(OUT)} 与冻结表一致（${r.circles.length} 个圆圈 · ${r.circles.length * 2} 条规则）`)
      process.exit(0)
    }
    console.error(`❌ ${rel(OUT)} 与冻结表**不一致**（漂移）：${cur === null ? '文件不存在' : cur.length + ' 字节'} → 应为 ${r.css.length} 字节`)
    console.error('   修法：node tools/circle-bands.js')
    process.exit(1)
  }
  if (cur === r.css) {
    console.log(`[circle-bands] 无变化（${r.circles.length} 个圆圈）`)
    process.exit(0)
  }
  fs.writeFileSync(OUT, r.css, 'utf8')
  console.log(`[circle-bands] ${rel(OUT)} 已写入（${r.circles.length} 个圆圈 · ${r.css.length} 字节）`)
}

module.exports = { build, loadTable, circlesOf, ROOT, OUT }

if (require.main === module) main()
