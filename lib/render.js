/**
 * render.js — 课程页渲染的 **ESM 适配层**（权威实现在 `lib/unify/render.cjs`）
 * ==================================================================
 * U 系列（U-SPEC §5）把确定性计算收为**单一源码**：课程页渲染的唯一计算在
 * `lib/unify/render.cjs`（纯 CJS；不读盘、不看时钟、不用随机）。本文件只做三件事：
 *
 *   ① 桥：`createRequire(import.meta.url)` 拿到 CJS 内核；
 *   ② 注入：把宿主侧本来就有的两个能力递给内核 —— `labelAnchorId`（`lib/pack-model.js`
 *      的"唯一实现"，包侧 `tools/lesson-map.js` 是它的受控镜像）与 h2/h3 静态流彩类
 *      （内核不自己造第二份：包侧 `tools/title-classes.js` 是 build-lessons 与 build-notes
 *      **共用**的一小段变换）；
 *   ③ 导出面**逐字保留**：`figureMap / substituteFigures / pageSequence / balancedEl /
 *      indexOfMarkup / elByClass / afterH2 / h2Start / trimBlankLines / buildGlossaryIndex /
 *      parseSource / escapeHtml / nextPlaceholderSpan / renderPage / extractPage /
 *      collectNavTitles / serializeSource / mergeBlocks` —— 参数、默认值、返回形状都不变。
 *
 * 为什么 `renderPage` / `extractPage` 是**包装函数**而不是直接再导出：它们要注入上面那两个
 * 能力，而调用方（`lib/render-inputs.js`）的调用形状必须原样不动（`renderPage(page, all, ctx)`）。
 * 同时 `test/render-parity.mjs` 有一条源码级断言盯着本文件里的 `export function renderPage`
 * （防"搬运时被剥空"），所以这里也必须是真正的函数声明。
 *
 * 本模块照旧**不 import fs / child_process / 环境变量 / cwd**（render-parity 有断言）。
 *
 * glossaryIndex 结构（由 buildGlossaryIndex 返回）：
 *   {
 *     glossary:   <原始 GLOSSARY 对象>,
 *     labelToKey: <{ [label]: key } 反查表>,
 *     termCount:  <名词总数>
 *   }
 *
 * ctx 形状（renderPage 专用）：
 *   { frame, glossaryIndex, labels, noteCounts, qa }
 *   详见 `lib/unify/render.cjs` 的 renderPage 注释（本层只额外补 `shape` 之外的注入能力）。
 */
import { createRequire } from 'node:module'
// 课次锚点 id 的**唯一实现**（插件侧）：课程包侧镜像是 tools/lesson-map.js 的同名函数，
// 两份由 `node lib/pack-model.js --selftest` 对拍钉住（登记表第 4 对）。别在本文件再写一份。
import { labelAnchorId } from './pack-model.js'

const require_ = createRequire(import.meta.url)
const core = require_('./unify/render.cjs')

/* ── h2/h3 静态流彩类（§3，2026-09-21）─────────────────────────────────────
 * 与课程包 `tools/title-classes.js` 的 withStaticTitles() / stripStaticTitles()
 * **逐字同源**（同一段正则在两侧各活一份：那一份是 build-lessons 与 build-notes 共用的
 * 包侧件，不在本卡写集里；两边行为由 U07 的 A02 逐例对拍钉住）。
 * · 只给**没有 class** 的 h2/h3 补；h1 的类写在 _frame.html 里；h4 不上。
 * · 正文里讲 HTML 的代码块是 `&lt;h2&gt;` 转义过的，所以不会被误伤（也不能先 unescape）。
 * · strip 是它的**反向**：只剥恰好等于该类名的那个 class（反向抽取写回源文件时用，
 *   不剥就会凭空多出一个源文件里本来没有的类）。
 */
const STATIC_CLASS = 'rainbow-subtitle'

function withStaticTitles(html) {
  return String(html).replace(/<(h2|h3)(\s[^>]*)?>/g, (whole, tag, attrs) => {
    attrs = attrs || ''
    if (/\bclass\s*=/.test(attrs)) return whole
    return `<${tag}${attrs} class="${STATIC_CLASS}">`
  })
}

function stripStaticTitles(html) {
  const exact = new RegExp(`\\bclass="${STATIC_CLASS}"`)
  const drop = new RegExp(`\\s*\\bclass="${STATIC_CLASS}"`)
  return String(html).replace(/<(h2|h3)(\s[^>]*)?>/g, (whole, tag, attrs) => {
    attrs = attrs || ''
    if (!exact.test(attrs)) return whole
    return `<${tag}${attrs.replace(drop, '')}>`
  })
}

/** 递给内核的两个能力（缺一个内核会抛"缺渲染依赖"，不静默降级） */
const DEPS = Object.freeze({ labelAnchorId, withStaticTitles, stripStaticTitles })

/* ── 纯计算：直接再导出（函数体只有一份，在内核里）────────────────────────── */

export const figureMap = core.figureMap
export const substituteFigures = core.substituteFigures
export const pageSequence = core.pageSequence
export const balancedEl = core.balancedEl
export const indexOfMarkup = core.indexOfMarkup
export const elByClass = core.elByClass
export const afterH2 = core.afterH2
export const h2Start = core.h2Start
export const trimBlankLines = core.trimBlankLines
export const buildGlossaryIndex = core.buildGlossaryIndex
export const parseSource = core.parseSource
export const escapeHtml = core.escapeHtml
export const nextPlaceholderSpan = core.nextPlaceholderSpan
export const collectNavTitles = core.collectNavTitles
export const serializeSource = core.serializeSource
export const mergeBlocks = core.mergeBlocks

/**
 * 渲染一张课程页（签名与改前逐字相同：`renderPage(page, all, ctx)`）。
 * @param {object} page 解析后的页对象
 * @param {object[]} all 同一批页
 * @param {object} ctx 渲染上下文（见文件头）
 * @returns {string}
 */
export function renderPage(page, all, ctx) {
  return core.renderPage(page, all, { ...(ctx || {}), deps: DEPS })
}

/**
 * 反向抽取一张产物页（签名与改前逐字相同：`extractPage(text, file, navTitles, glossaryIndex)`）。
 * @param {string} text 产物页全文
 * @param {string} file 产物页路径
 * @param {Record<string,string>} navTitles 从别的页反查出来的课次短标题
 * @param {object} glossaryIndex buildGlossaryIndex 的返回值
 * @returns {object}
 */
export function extractPage(text, file, navTitles, glossaryIndex) {
  return core.extractPage(text, file, navTitles, glossaryIndex, DEPS)
}
