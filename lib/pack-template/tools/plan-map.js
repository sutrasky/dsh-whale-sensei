/**
 * tools/plan-map.js —— 知识点地图（大纲）的**格式与判据**（课程包侧）
 * ------------------------------------------------------------------
 * MIRROR-OF: lib/plan.js
 *
 * 为什么有第二份：架构上选了**甲方案**（包侧 `tools/` 必须能脱离插件独立跑）。
 * 那意味着同一件事有两份实现 —— 甲方案唯一能成立的前提是**每一对都有对拍**。
 * 对拍落点：`test/mirror-parity.mjs`（登记在 `_plugin-prep/同源实现-对拍登记表.md`）。
 * **改这里就必须同步改插件侧的 `lib/plan.js`，否则对拍会红。**
 *
 * 判据依据 `01-鲸师.md:83`：一个知识点 = 一串「能力单元」，每个单元必须带三样 ——
 *   **可交付物 / 通过判据 / 「它让终点更近了什么」**（缺第三样的，就是可以在路线里砍掉的）。
 * 地图落点：`lessons/<圆圈>/<知识点>/point.json` 的 `plan` 字段（点级元数据本来就住那儿）。
 */

'use strict'

/** 地图对象允许的顶层键 */
const PLAN_KEYS = Object.freeze(['goal', 'nodes'])

/** 每个节点允许的键（`no/title/deliverable/criteria/why` 必填，其余可选） */
const NODE_KEYS = Object.freeze(['no', 'title', 'deliverable', 'criteria', 'why', 'branch', 'sources'])

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const isHttp = (u) => /^https?:\/\/\S+$/i.test(String(u || '').trim())

/**
 * 校验一张地图。**纯函数**（工具、闸门、测试共用同一份判据）。
 * @param {unknown} raw `point.json` 的 `plan` 字段
 * @param {string} [where] 报错时点名的位置
 * @returns {{ok: boolean, problems: string[], nodes: object[]}}
 */
function validatePlan(raw, where = 'point.json 的 plan') {
  const problems = []
  if (raw === undefined || raw === null) return { ok: false, problems: [where + '：没有地图'], nodes: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: [where + '：必须是对象'], nodes: [] }
  }
  const goal = str(raw.goal)
  if (!goal) problems.push(where + '：缺 goal（这个知识点的终点：学完能交付什么，一句话）')
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) {
    problems.push(where + '：nodes 必须是非空数组（地图节点 = 课次；主题先定、内容后生成）')
    return { ok: false, problems, nodes: [] }
  }

  const seen = new Set()
  const nodes = []
  for (let i = 0; i < raw.nodes.length; i++) {
    const n = raw.nodes[i]
    const at = where + ' 第 ' + (i + 1) + ' 个节点'
    if (!n || typeof n !== 'object' || Array.isArray(n)) { problems.push(at + '：必须是对象'); continue }
    const no = n.no
    if (!Number.isSafeInteger(no) || no <= 0) { problems.push(at + '：no 必须是正整数（课次序号，与 NNNN 对得上）'); continue }
    if (seen.has(no)) { problems.push(at + '：no 重复（' + no + '）'); continue }
    seen.add(no)
    const node = { no, title: str(n.title), deliverable: str(n.deliverable), criteria: str(n.criteria), why: str(n.why), branch: n.branch === true, sources: [] }
    if (!node.title) problems.push(at + '：缺 title（主题先定，哪怕内容还没写）')
    if (!node.deliverable) problems.push(at + '：缺 deliverable（可交付物）')
    if (!node.criteria) problems.push(at + '：缺 criteria（通过判据）')
    // `why` 就是 01:83 的第三样 —— 缺它的节点可以在路线里砍掉，所以它不该进地图
    if (!node.why) problems.push(at + '：缺 why（它让终点更近了什么）—— 缺这一样的节点应当直接砍掉，别留在图里')
    const src = Array.isArray(n.sources) ? n.sources : []
    for (const s of src) {
      const label = str(s && s.label)
      const url = str(s && s.url)
      if (!label || !isHttp(url)) { problems.push(at + '：sources 里有一条不是 {label, url(http/https)}'); continue }
      node.sources.push({ label, url })
    }
    if (!node.sources.length && isHttp(n.source)) node.sources.push({ label: str(n.sourceLabel) || String(n.source).trim(), url: String(n.source).trim() })
    if (!node.sources.length) problems.push(at + '：缺 sources（官方出处；C0 寻源必须落盘）')
    nodes.push(node)
  }
  nodes.sort((a, b) => a.no - b.no)
  return { ok: problems.length === 0, problems, nodes }
}

/**
 * **地图前沿**：这个知识点"下一颗该点亮的星星"是哪几颗。
 * ------------------------------------------------------------------
 * 依据 `01:205`：「每有一节课在学，就显示下一个星星 —— **或两颗（如果这里正好有支线分叉）**」。
 *
 * 判据（节点已按 `no` 升序）：
 *   · **第一颗** = 按 `no` 序第一个还没有课文件的节点；
 *   · **第二颗** = 紧随其后的那个节点，**且必须标了支线**（`branch: true`）；
 *   · 至多两颗。
 *
 * 地图写法约定：支线节点要摆在**它的分叉点之后**（`no` 序上紧挨着）。
 *
 * @param {unknown} raw `point.json` 的 `plan`
 * @param {Iterable<number>} existingNumbers **已建了课**的课次号（显示号）
 * @returns {{ok: boolean, problems: string[], goal: string, next: object|null, stars: object[],
 *            created: number, missing: number, exhausted: boolean}}
 */
function planFrontier(raw, existingNumbers) {
  const v = validatePlan(raw)
  if (!v.ok) {
    return { ok: false, problems: v.problems, goal: '', next: null, stars: [], created: 0, missing: 0, exhausted: false }
  }
  const has = new Set(Array.from(existingNumbers || []).map(Number))
  const missing = v.nodes.filter((n) => !has.has(n.no))

  const stars = []
  if (missing.length) {
    const first = missing[0]
    stars.push(first)
    const after = v.nodes[v.nodes.indexOf(first) + 1]
    if (after && after.branch && !has.has(after.no)) stars.push(after)
  }
  return {
    ok: true,
    problems: [],
    goal: str(raw.goal),
    next: stars.length ? stars[0] : null,
    stars,
    created: v.nodes.length - missing.length,
    missing: missing.length,
    exhausted: missing.length === 0,
  }
}

/** 给人看的一行摘要 */
function summarizePlan(raw) {
  const v = validatePlan(raw)
  if (!v.ok) return '地图不可用（' + v.problems.length + ' 个问题）'
  const main = v.nodes.filter((n) => !n.branch).length
  return '地图 ' + v.nodes.length + ' 个节点（主线 ' + main + ' / 支线 ' + (v.nodes.length - main) + '）'
}

/** 前沿的一行摘要：没有下一课时如实说"地图上全建完了" */
function summarizeFrontier(frontier) {
  if (!frontier || !frontier.ok) return '地图不可用'
  const stars = frontier.stars
  const created = frontier.created
  const next = frontier.next
  if (frontier.exhausted) return '地图上 ' + created + ' 课全建完了（没有下一颗星）'
  const head = '下一课 第' + next.no + '课 ' + next.title
  const tail = stars.length > 1 ? '｜同波支线 第' + stars[1].no + '课 ' + stars[1].title : ''
  return head + tail + '（已建 ' + created + '／共 ' + (created + frontier.missing) + '）'
}

/** 地图里第 N 课（`no === n`）的节点；没有 → null */
function planNode(raw, no) {
  const v = validatePlan(raw)
  if (!v.ok) return null
  return v.nodes.find((n) => n.no === Number(no)) || null
}

module.exports = {
  PLAN_KEYS, NODE_KEYS,
  validatePlan, planFrontier, summarizePlan, summarizeFrontier, planNode,
}
