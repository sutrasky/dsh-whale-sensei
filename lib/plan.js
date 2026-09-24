/**
 * lib/plan.js — 知识点地图（大纲）的**格式与判据**（2026-09-24 F2）
 * ------------------------------------------------------------------
 * 依据 `01-鲸师.md:83`：一个知识点 = 一串「能力单元」，每个单元必须带三样 ——
 *   **可交付物 / 通过判据 / 「它让终点更近了什么」**（缺第三样的，就是可以在路线里砍掉的）。
 *
 * **落点**：`lessons/<圆圈>/<知识点>/point.json` 的 `plan` 字段。
 *   为什么挂这儿：点级元数据本来就住这个文件（`point.json` 已经有 label / fileBase / requires /
 *   practice），`readPack` 已经在读它 —— 零新 IO 路径，插件侧与包侧工具天然认同一个源。
 *
 * **为什么要有闸**（`01:385`）："建点入口随点生成地图 + `whale_author` 加大纲闸 —— 没大纲不许建课"。
 *   没有地图时"下一课教什么"只能靠**文件名序 +1**，那是**假进度** ——
 *   撞板子自己的硬规矩第 6 条（"假进度比没有进度更伤"）。
 */

/** 地图对象允许的顶层键 */
export const PLAN_KEYS = Object.freeze(['goal', 'nodes'])

/** 每个节点允许的键（`no/title/deliverable/criteria/why` 必填，其余可选） */
export const NODE_KEYS = Object.freeze(['no', 'title', 'deliverable', 'criteria', 'why', 'branch', 'sources'])

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const isHttp = (u) => /^https?:\/\/\S+$/i.test(String(u || '').trim())

/**
 * 校验一张地图。**纯函数**，所以可离线判（工具、闸门、测试共用同一份判据）。
 *
 * @param {unknown} raw `point.json` 的 `plan` 字段
 * @param {string} [where] 报错时点名的位置
 * @returns {{ok: boolean, problems: string[], nodes: object[]}} `nodes` 是归一后的节点（ok 才有意义）
 */
export function validatePlan(raw, where = 'point.json 的 plan') {
  const problems = []
  if (raw === undefined || raw === null) return { ok: false, problems: [`${where}：没有地图`], nodes: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: [`${where}：必须是对象`], nodes: [] }
  }
  const goal = str(raw.goal)
  if (!goal) problems.push(`${where}：缺 goal（这个知识点的终点：学完能交付什么，一句话）`)
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) {
    problems.push(`${where}：nodes 必须是非空数组（地图节点 = 课次；主题先定、内容后生成）`)
    return { ok: false, problems, nodes: [] }
  }

  const seen = new Set()
  const nodes = []
  for (let i = 0; i < raw.nodes.length; i++) {
    const n = raw.nodes[i]
    const at = `${where} 第 ${i + 1} 个节点`
    if (!n || typeof n !== 'object' || Array.isArray(n)) { problems.push(`${at}：必须是对象`); continue }
    const no = n.no
    if (!Number.isSafeInteger(no) || no <= 0) { problems.push(`${at}：no 必须是正整数（课次序号，与 NNNN 对得上）`); continue }
    if (seen.has(no)) { problems.push(`${at}：no 重复（${no}）`); continue }
    seen.add(no)
    const node = { no, title: str(n.title), deliverable: str(n.deliverable), criteria: str(n.criteria), why: str(n.why), branch: n.branch === true, sources: [] }
    if (!node.title) problems.push(`${at}：缺 title（主题先定，哪怕内容还没写）`)
    if (!node.deliverable) problems.push(`${at}：缺 deliverable（可交付物）`)
    if (!node.criteria) problems.push(`${at}：缺 criteria（通过判据）`)
    // ⚠️ `why` 就是 01:83 的第三样 —— **缺它的节点可以在路线里砍掉**，所以它不该进地图
    if (!node.why) problems.push(`${at}：缺 why（它让终点更近了什么）—— 缺这一样的节点应当直接砍掉，别留在图里`)
    const src = Array.isArray(n.sources) ? n.sources : []
    for (const s of src) {
      const label = str(s && s.label)
      const url = str(s && s.url)
      if (!label || !isHttp(url)) { problems.push(`${at}：sources 里有一条不是 {label, url(http/https)}`); continue }
      node.sources.push({ label, url })
    }
    // 出处必须落盘（C0 寻源）：允许写 URL 的**字符串简写**，归一成 {label,url}
    if (!node.sources.length && isHttp(n.source)) node.sources.push({ label: str(n.sourceLabel) || String(n.source).trim(), url: String(n.source).trim() })
    if (!node.sources.length) problems.push(`${at}：缺 sources（官方出处；C0 寻源必须落盘）`)
    nodes.push(node)
  }
  nodes.sort((a, b) => a.no - b.no)
  return { ok: problems.length === 0, problems, nodes }
}

/**
 * 大纲闸的判据：这个知识点的地图能不能拿来建课。
 * **禁 force 绕**（`01:385`）—— 没有地图就是"下一课教什么"根本没定，绕过去只会产出假进度。
 *
 * @param {unknown} raw `point.json` 的 `plan`
 * @param {string} [where]
 * @returns {{ok: boolean, problems: string[], hint: string, nodes: object[], goal: string}}
 */
export function planGate(raw, where = 'point.json 的 plan') {
  const v = validatePlan(raw, where)
  return {
    ok: v.ok,
    problems: v.problems,
    nodes: v.nodes,
    goal: v.ok ? str((raw || {}).goal) : '',
    hint: v.ok
      ? ''
      : '先在 lessons/<圆圈>/<知识点>/point.json 里补 `plan`（goal + nodes[]；每个节点要 '
        + 'title / deliverable / criteria / why / sources 五样）—— 地图是方向标，没有它"下一课教什么"就没定。'
        + '缺 `why`（它让终点更近了什么）的节点应当**直接砍掉**，别留在图里充数。',
  }
}

/** 给人看的一行摘要（工具输出 / 拒建课时用） */
export function summarizePlan(raw) {
  const v = validatePlan(raw)
  if (!v.ok) return `地图不可用（${v.problems.length} 个问题）`
  const main = v.nodes.filter((n) => !n.branch).length
  return `地图 ${v.nodes.length} 个节点（主线 ${main} / 支线 ${v.nodes.length - main}）`
}

/** 地图里第 N 课（`no === n`）的节点；没有 → null（"照大纲排下一课"要用） */
export function planNode(raw, no) {
  const v = validatePlan(raw)
  if (!v.ok) return null
  return v.nodes.find((n) => n.no === Number(no)) || null
}
