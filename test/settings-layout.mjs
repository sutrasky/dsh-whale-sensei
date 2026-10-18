/**
 * settings-layout.mjs —— 设置页**排版**的机械判据（P5）。
 *
 * 与另外三份的分工：
 *   · panel.mjs              —— 坐位/require/令牌/侧栏几何（**格式面**）
 *   · settings-catalog.mjs   —— 三级目录真渲染 + 删除先弹窗（**功能面**）
 *   · settings-teaching.mjs  —— 教学路由面 + 渲染文本（**功能面**）
 *   · **本文件**              —— 三档字号 / 四档圆角 / 折叠原语唯一 / 样式表合规 / 卡完整性 / 分派表完备（**排版面**）
 *
 * 纪律：每条断言都**证伪过**（见文件末尾「反空转」一节 —— 它当场把 SECTION_HOME 改坏再验一次）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { packRoot } from './_pack.mjs'
packRoot()

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PLUGIN = path.join(HERE, '..')
const CLIENT = path.join(PLUGIN, 'lib', 'client.js')
const STATUS = path.join(PLUGIN, 'lib', 'mods', 'status.js')

const src = fs.readFileSync(CLIENT, 'utf8')
const lines = src.split('\n')

let pass = 0
const fails = []
const ok = (cond, msg) => { if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) } }

// ── 设置页切片：从 mod:status_card 到 mod:entry_button 之前 ──────────────
// 为什么切片：开课弹窗（CourseDialog）在同一个文件里，但**不在本次范围**，
// 它的 13px / 6px 圆角是既有代码，不该被本判据判红。
const startAt = lines.findIndex((l) => l.includes('//#region mod:status_card'))
const endAt = lines.findIndex((l) => l.includes('//#region mod:entry_button'))
ok(startAt > 0 && endAt > startAt, `设置页切片定位到了（第 ${startAt + 1}–${endAt} 行）`)
const slice = lines.slice(startAt, endAt).join('\n')

/** 去掉注释行 —— 注释里提到 `'▸'` 是在说"它没了"，不是还在用 */
const codeOnly = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const sliceCode = codeOnly(slice)

const uniq = (arr) => [...new Set(arr)].sort()

// ── ① 字号阶梯：只有 12 / 14 / 16 ────────────────────────────────────────
{
  const js = uniq([...slice.matchAll(/fontSize:\s*'(\d+)px'/g)].map((m) => m[1]))
  const css = uniq([...slice.matchAll(/font-size:(\d+)px/g)].map((m) => m[1]))
  const bad = uniq([...js, ...css]).filter((n) => !['12', '14', '16'].includes(n))
  ok(bad.length === 0, `字号只在三档里（内联 ${js.join('/')} · 样式表 ${css.join('/')}；编外的：${bad.join('/') || '无'}）`)
  ok(!js.includes('11') && !js.includes('13'), '11px 与 13px 在设置页里归零（原来的 30 + 26 处）')
}

// ── ② 圆角：只有 8 / 12 / 14 / 18 ────────────────────────────────────────
{
  const radii = uniq([...slice.matchAll(/borderRadius:\s*'([^']+)'/g)].map((m) => m[1]))
  const bad = radii.filter((r) => !['8px', '12px', '14px', '18px'].includes(r))
  ok(bad.length === 0, `圆角只在四档里（实得 ${radii.join('/')}；编外的：${bad.join('/') || '无'}）`)
}

// ── ③ 折叠原语唯一：四个字符一个都不许留，箭头只有一处画 ──────────────────
{
  const glyphs = [...sliceCode.matchAll(/[▸▾▼▶]/g)].map((m) => m[0])
  ok(glyphs.length === 0, `'▸' '▾' '▼' '▶' 在设置页代码里归零（实得 ${glyphs.length} 个${glyphs.length ? '：' + uniq(glyphs).join('') : ''}）`)
  const chevrons = (src.match(/function Chevron\(/g) || []).length
  ok(chevrons === 1, `全文件只有一处画箭头（function Chevron 出现 ${chevrons} 次）`)
}

// ── ④ 样式表：零裸色值 + 只用三个令牌前缀 + 够用 ────────────────────────
{
  const m = /var PANEL_CSS = \[([\s\S]*?)\]\.join\(''\);/.exec(src)
  ok(!!m, '找得到 PANEL_CSS 常量')
  const css = m ? m[1] : ''
  const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((x) => x[0])
  ok(hex.length === 0, `PANEL_CSS 里没有裸色值${hex.length ? '（' + hex.join('、') + '）' : ''}`)
  const tokens = uniq([...css.matchAll(/var\(--dsw-[a-z0-9-]+\)/g)].map((x) => x[0]))
  ok(tokens.length >= 10, `PANEL_CSS 走宿主语义令牌（用到 ${tokens.length} 种）`)
  const badTok = tokens.filter((t) => !/^var\(--dsw-(alias|static|specific)-/.test(t))
  ok(badTok.length === 0, `令牌前缀全合规（越界的：${badTok.join('、') || '无'}）`)
}

// ── ⑤ 样式表只注入一次 + 非浏览器环境不炸 ───────────────────────────────
{
  ok(/if \(typeof document === 'undefined'\) return;/.test(src), 'ensurePanelStyle 有非浏览器守卫（判据的桩没有 document）')
  ok(/document\.getElementById\(PANEL_STYLE_ID\)/.test(src), '样式表按 id 判重（只注入一次）')
  ok(/try \{\s*\n\s*ensurePanelStyle\(\);/.test(src), 'ensurePanelStyle 单独包 try/catch（绝不许影响坐位注册）')
}

// ── ⑥ 卡完整性：五张卡，每张都有标题 ────────────────────────────────────
{
  const titles = ['概览', '课程目录', '教学方式', '内容体检', '插件信息']
  const missing = titles.filter((t) => !new RegExp(`title: '${t}'`).test(slice))
  ok(missing.length === 0, `五张卡的标题都在（缺：${missing.join('/') || '无'}）`)
  ok(/function Card\(props\)/.test(src), 'Card 原语存在')
  const detailsN = (src.match(/react\.createElement\('details'/g) || []).length
  ok(/className: 'ws-card'/.test(src) && detailsN === 2,
    `折叠只用原生 <details>（共 ${detailsN} 处：① 卡 · ② 组内「固定做法」—— 零 hook 零 state）`)
}

// ── ⑦ 分派表完备：status.js 里出现的每一个标题都要有归属 ─────────────────
/** 从 status.js 抽出所有 `sections.push({ title: 'X'` / `failed('X'` 的标题 */
function titlesInStatus(code) {
  const t = [...code.matchAll(/sections\.push\(\{\s*title:\s*'([^']+)'/g)].map((m) => m[1])
  const f = [...code.matchAll(/failed\(\s*'([^']+)'/g)].map((m) => m[1])
  return uniq([...t, ...f])
}
/** 一张分派表里有哪些键 */
function keysInHome(code) {
  const m = /var SECTION_HOME = \{([\s\S]*?)\n\t\t\};/.exec(code)
  if (!m) return null
  return uniq([...m[1].matchAll(/'([^']+)':\s*'[a-z]+'/g)].map((x) => x[1]))
}
const statusSrc = fs.readFileSync(STATUS, 'utf8')
const allTitles = titlesInStatus(statusSrc)
const homeKeys = keysInHome(src)
{
  ok(allTitles.length >= 6, `status.js 里抽到 ${allTitles.length} 个分区标题（${allTitles.join('/')}）—— 这条判据不是空转`)
  ok(!!homeKeys, '找得到 SECTION_HOME 分派表')
  const uncovered = allTitles.filter((t) => !(homeKeys || []).includes(t))
  ok(uncovered.length === 0, `SECTION_HOME 覆盖了 status.js 的每一个标题（没覆盖的：${uncovered.join('/') || '无'}）`)
  ok(/groups\[SECTION_HOME\[s\.title\] \|\| 'other'\]\.push\(s\)/.test(src),
    '没命中的标题落进 other（并进「插件信息」卡）—— 不静默丢弃')
}

// ── ⑧ 反空转：把分派表改坏，上面那条判据必须当场变红 ─────────────────────
{
  const broken = src.replace("'审计': 'health',", '')
  const brokenKeys = keysInHome(broken)
  const uncovered = allTitles.filter((t) => !(brokenKeys || []).includes(t))
  ok(uncovered.length === 1 && uncovered[0] === '审计',
    `反空转：从 SECTION_HOME 删掉「审计」后，覆盖判据当场报缺（实得 ${JSON.stringify(uncovered)}）`)
  const broken2 = src.replace("|| 'other'", "|| 'zzz'")
  ok(!/groups\[SECTION_HOME\[s\.title\] \|\| 'other'\]/.test(broken2), '反空转：把兜底桶名改掉后，兜底那条判据当场变红')
}

// ── ⑨ 默认开合：**五张卡全收起** + 卡内的组（目录圆圈 / 教学层）也全收起 ────
// 用户 2026-09-26 拍板两次，以最后一条为准：先是「采用 b（五张卡全展开）」，
// 随后改成「五张卡全部改成默认收起」。**卡与卡内的组现在都是收起态**。
{
  const cardsOpen = (slice.match(/open: true,/g) || []).length
  const cardsClosed = (slice.match(/open: false,/g) || []).length
  ok(cardsOpen === 0 && cardsClosed >= 5,
    `五张卡**全部默认收起**（open: true 出现 ${cardsOpen} 次 · open: false ${cardsClosed} 次）`)
  ok(/var isCollapsed = collapsed\[key\] !== false;/.test(src),
    '教学方式的层**默认收起**（`!== false`；写成 `=== true` 就是默认展开 —— 第一版就是这么错的）')
  ok(/var isExpanded = !!expanded\[c\.id\];/.test(src),
    '课程目录的圆圈**默认收起**（`expanded` 初值是空对象）')
  // 反空转：把任意一处改回展开，上面那两条必须当场变红
  const broken = src.replace('var isCollapsed = collapsed[key] !== false;', 'var isCollapsed = collapsed[key] === true;')
  ok(!/var isCollapsed = collapsed\[key\] !== false;/.test(broken),
    '反空转：把教学层的默认改回「展开」后，默认收起那条当场变红')
  const brokenCard = slice.replace("trailing: headText, open: false,", "trailing: headText, open: true,")
  ok((brokenCard.match(/open: true,/g) || []).length === 1,
    '反空转：把概览卡改回展开后，「五张卡全收起」那条当场变红')
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 设置页排版：三档字号 / 四档圆角 / 折叠原语唯一 / 样式表合规 / 五张卡完整 / 分派表完备 / 默认开合正确（且证伪过）')
