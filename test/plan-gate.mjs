/**
 * plan-gate.mjs —— 知识点地图：格式 / 写口 / **大纲闸**（2026-09-24 F2）
 *
 * 依据 `01:385`："建点入口随点生成地图 + `whale_author` 加**大纲闸** —— 没大纲不许建课（同摸底闸，**禁 force**）"。
 * 依据 `01:83`：每个单元三样齐 —— 可交付物 / 通过判据 / **它让终点更近了什么**（缺第三样的可砍）。
 *
 * 覆盖面：
 *   ① `validatePlan` 判据矩阵（缺 goal / 缺 why / no 重复 / 出处不是 http / 非数组…）
 *   ② `whale_plan` 写口：合法就落盘（**只动 plan 一个键**）、不合法**拒写**、回读自检
 *   ③ **大纲闸**：没地图 → 拒建课，且 **force 也绕不过去**
 *   ④ 有地图 → 放行（后面由别的闸接棒）
 *   ⑤ 自造的小包 + 真包守卫（这一套全程不碰真包）
 *   ⑥ **前沿**（01:205"下一个星星 —— 或两颗"）：下一课教什么 / 至多两颗 / 全建完如实说
 *   ⑦ **课的号按大纲给**：`nextNumber` 有地图时按地图（替代"文件名序 +1"），无答案时才退回最大号 +1
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { validatePlan, planGate, planNode, summarizePlan, planFrontier, summarizeFrontier } from '../lib/plan.js'
import { plugin as planPlugin } from '../lib/mods/plan.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
import { readPack, nextNumber } from '../lib/pack-model.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
function hashTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out.push(r + ':' + sha(fs.readFileSync(path.join(dir, e.name))))
    }
  }
  walk(root, '')
  return out.join('|')
}

const SRC = [{ label: 'Spring 官方指南', url: 'https://spring.io/guides/gs/spring-boot/' }]
const node1 = { no: 1, title: '第1课 起步', deliverable: '一个能跑起来的应用', criteria: '访问 /hello 有响应', why: '终点是交付一个服务，先得有服务', sources: SRC }
const node2 = { no: 2, title: '第2课 分层', deliverable: 'model/service/controller 三层', criteria: '三个包都在', why: '不分层就交不出可维护的服务', sources: SRC }
const GOOD = { goal: '交付一个能上线的 REST 服务', nodes: [node1, node2] }

console.log(`\n[plan-gate] 真包：${ROOT}`)
const realBefore = hashTree(path.join(ROOT, 'lessons'))

// ── ① 判据矩阵 ──
ok(validatePlan(GOOD).ok === true, '完整的地图 → ok')
ok(validatePlan(undefined).problems[0].includes('没有地图'), '没有 plan → 点名「没有地图」')
ok(validatePlan({ goal: '', nodes: [node1] }).problems.some((p) => /缺 goal/.test(p)), '缺 goal → 报出来')
ok(validatePlan({ goal: 'x', nodes: [] }).problems.some((p) => /nodes 必须是非空数组/.test(p)), 'nodes 空 → 报出来')
const noWhy = { goal: 'x', nodes: [{ ...node1, why: '' }] }
ok(validatePlan(noWhy).problems.some((p) => /缺 why/.test(p) && /砍掉/.test(p)),
  '缺 why → 报出来，并说明「应当直接砍掉」（01:83 的第三样）')
const dupNo = { goal: 'x', nodes: [node1, { ...node2, no: 1 }] }
ok(validatePlan(dupNo).problems.some((p) => /no 重复/.test(p)), 'no 重复 → 报出来')
const badNo = { goal: 'x', nodes: [{ ...node1, no: 0 }] }
ok(validatePlan(badNo).problems.some((p) => /no 必须是正整数/.test(p)), 'no 不是正整数 → 报出来')
const noSrc = { goal: 'x', nodes: [{ ...node1, sources: [] }] }
ok(validatePlan(noSrc).problems.some((p) => /缺 sources/.test(p)), '没有出处 → 报出来（C0 寻源必须落盘）')
const badUrl = { goal: 'x', nodes: [{ ...node1, sources: [{ label: 'x', url: 'not-a-url' }] }] }
ok(validatePlan(badUrl).problems.some((p) => /不是 \{label, url/.test(p)), '出处不是 http(s) → 报出来')
const sorted = validatePlan({ goal: 'x', nodes: [node2, node1] })
ok(sorted.ok === true && sorted.nodes[0].no === 1, '节点按 no 排序（顺序不影响合法性）')
ok(planGate(GOOD).ok === true && planGate(undefined).ok === false, 'planGate 就是 validatePlan 的 ok + 修法提示')
ok(/补 `plan`/.test(planGate(undefined).hint), `拒建课时给的是**可执行修法**（${planGate(undefined).hint.slice(0, 24)}…）`)
ok(summarizePlan({ goal: 'x', nodes: [node1, { ...node2, branch: true }] }) === '地图 2 个节点（主线 1 / 支线 1）',
  `摘要把主线/支线分开数（${summarizePlan({ goal: 'x', nodes: [node1, { ...node2, branch: true }] })}）`)
ok(planNode(GOOD, 2).title === '第2课 分层' && planNode(GOOD, 9) === null, 'planNode(no) 取得到、取不到回 null')

// ── ①b 前沿：**下一课教什么**（01:205「显示下一个星星 —— 或两颗（如果这里正好有支线分叉）」）──
{
  const br = { ...node2, no: 3, branch: true, title: '第3课 支线' }
  const WITH_BRANCH = { goal: GOOD.goal, nodes: [node1, node2, br] }
  ok(planFrontier(GOOD, []).next.no === 1, '前沿：一节没建 → 下一课是第 1 课')
  ok(planFrontier(GOOD, [1]).next.no === 2, '前沿：建了第 1 课 → 下一课是第 2 课')
  ok(planFrontier(GOOD, [1, 2]).exhausted === true, '前沿：地图上的课全建完了 → exhausted（如实说"没有下一颗星"）')
  ok(planFrontier(GOOD, [1, 2]).next === null, 'exhausted 时 next 为 null（不硬凑一个号出来）')
  ok(planFrontier(WITH_BRANCH, [1]).stars.map((s) => s.no).join('+') === '2+3',
    '前沿：建了第 1 课 → **两颗**（下一颗主线 2 + 紧随它的支线 3）—— 这就是"这里正好有支线分叉"')
  ok(planFrontier(WITH_BRANCH, [1, 2]).stars.map((s) => s.no).join('+') === '3',
    '前沿：主线走完、只剩支线 → 一颗（支线后面没有别的分了）')
  const mid = { goal: GOOD.goal, nodes: [node1, { ...node2, no: 2 }, { ...br, no: 3 }, { ...br, no: 4, title: '第4课 追支线' }] }
  ok(planFrontier(mid, [1, 2]).stars.map((s) => s.no).join('+') === '3+4',
    '前沿：下一颗主线后面紧跟支线 → **两颗**（这就是"这里正好有支线分叉"）')
  ok(planFrontier(mid, [1, 2]).stars.length <= 2, '前沿**至多两颗**（01:205 只说"或两颗"，没说要铺满）')
  ok(planFrontier(undefined, []).ok === false && planFrontier(GOOD, []).ok === true, '前沿：地图不可用 → ok:false（不猜）')
  ok(/下一课 第1课/.test(summarizeFrontier(planFrontier(GOOD, []))), `前沿摘要给出「下一课 第N课 <主题>」（${summarizeFrontier(planFrontier(GOOD, []))}）`)
  ok(/全建完了/.test(summarizeFrontier(planFrontier(GOOD, [1, 2]))), '前沿摘要：全建完时如实说"全建完了"')
}

// ── ①c 课的**号**按大纲给（01:394 的"③生成课程按大纲定下一课教什么"，替代"文件名序 +1"）──
{
  const packOf = (plan, displays, fileBase) => ({
    points: [{ id: 'pt', circle: 'c', fileBase: fileBase || 0, plan }],
    lessons: displays.map((d) => ({ circle: 'c', point: 'pt', number: (fileBase || 0) + d, displayNumber: d })),
  })
  ok(nextNumber(packOf(GOOD, [1], 0), 'c', 'pt') === 2, '有地图 → 号按大纲给（建了第 1 课 → 2）')
  ok(nextNumber(packOf(GOOD, [1, 5], 0), 'c', 'pt') === 2,
    '乱序建课（1、5）→ 仍按地图给号（地图上第一颗没建的是 2），不按最大号跳到 6')
  ok(nextNumber(packOf(GOOD, [1, 2], 0), 'c', 'pt') === 3,
    '地图上全建完了 → 退回"最大号 + 1"（地图对下一课确实没答案；这一句由 whale_plan 明说，不静默）')
  ok(nextNumber(packOf(undefined, [1, 5], 0), 'c', 'pt') === 6,
    '没地图 → 退回"最大号 + 1"（此时建课会被大纲闸拦下，这个号只影响显示）')
  ok(nextNumber(packOf(GOOD, [1], 1000), 'c', 'pt') === 1002, 'fileBase 折算仍生效（1000 + 第 2 课 = 1002）')
  ok(nextNumber(packOf(GOOD, [], 1000), 'c', 'pt') === 1001, '一节没建 → fileBase + 第 1 课 = 1001')
}

// ── ②③④⑤ 自造一个小包（不碰真包）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'))
try {
  const mk = (circle, point, extra) => {
    const d = path.join(tmp, 'lessons', circle, point)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'point.json'), JSON.stringify({ _: '待补', point, name: point, fileBase: 0, ...extra }, null, 2) + '\n', 'utf8')
  }
  fs.mkdirSync(path.join(tmp, 'lessons', 'prog'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'lessons', 'prog', 'halo.json'), JSON.stringify({ halo: 'prog', name: '编程' }, null, 2) + '\n', 'utf8')
  mk('prog', 'pt1')                                              // 没地图
  mk('prog', 'pt2', { plan: GOOD })                              // 有地图
  fs.writeFileSync(path.join(tmp, 'progress.json'), JSON.stringify({ learned: [] }, null, 2) + '\n', 'utf8')

  const tools = []
  const install = (mod, root) => {
    mod.install({ paths: { packRoot: root }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
    return tools[tools.length - 1]
  }
  const planTool = install(planPlugin, tmp)
  const author = install(authorPlugin, tmp)
  ok(planTool?.name === 'whale_plan' && author?.name === 'whale_author', '两个工具都装得上')

  // ── ② 写口 ──
  const bad = await planTool.execute({ op: 'record', point: 'pt1', goal: 'x', nodes: [{ ...node1, why: '' }], root: tmp })
  ok(bad.ok === false && bad.needsFix === true && bad.problems.some((p) => /缺 why/.test(p)),
    '不合法 → **拒写**（不写半张图进去）')
  const before = fs.readFileSync(path.join(tmp, 'lessons', 'prog', 'pt1', 'point.json'), 'utf8')
  ok(!/plan/.test(before), '拒写之后那个 point.json 里**一个 plan 键都没有**（没写坏）')

  const rec = await planTool.execute({ op: 'record', point: 'pt1', goal: GOOD.goal, nodes: GOOD.nodes, root: tmp })
  ok(rec.ok === true && rec.nodes.length === 2, `合法 → 落盘（${rec.summary}）`)
  const afterDoc = JSON.parse(fs.readFileSync(path.join(tmp, 'lessons', 'prog', 'pt1', 'point.json'), 'utf8'))
  ok(afterDoc._ === '待补' && afterDoc.point === 'pt1' && afterDoc.fileBase === 0,
    '只动 plan 一个键：其余字段**原样保留**（_ / point / fileBase 都没变）')
  const rd = await planTool.execute({ op: 'read', point: 'prog/pt1', root: tmp })
  ok(rd.ok === true && rd.nodes.length === 2 && rd.problems.length === 0, `read 回得来（circle/point 形态也认，${rd.point}）`)
  // read 顺带给出「下一课教什么」——③生成课程照它办，不按文件名序 +1（01:394）
  ok(rd.nextLesson && rd.nextLesson.no === 1 && /下一课 第1课/.test(rd.nextLine || ''),
    `read 顺带给出「下一课 第N课」（${rd.nextLine}）`)
  const rdByBare = await planTool.execute({ op: 'read', point: 'pt2', root: tmp })
  ok(rdByBare.ok === true && rdByBare.nodes.length === 2, '裸 point 名也认')
  const notFound = await planTool.execute({ op: 'read', point: 'nope', root: tmp })
  ok(notFound.ok === false && /找不到这个知识点/.test(notFound.error), '不认识的点 → 如实报，不猜')

  // ── ③ 大纲闸：没地图就拒，而且 **force 也绕不过** ──
  const base = { number: 1, title: '探针课', slug: 'probe', hintTerm: 'x', source: { label: 'x', url: 'https://example.com' }, root: tmp }
  const noPlan = await author.execute({ ...base, point: 'pt1x', commit: true })
  // pt1 现在已经有地图了（上面刚写进去）→ 用 pt3 造一个"没地图"的点
  mk('prog', 'pt3')
  const blocked = await author.execute({ ...base, point: 'pt3', commit: true })
  ok(blocked.ok === false && blocked.needsPlan === true, `没地图 → 拒建课（needsPlan=true）`)
  ok(/没有大纲，拒绝生成新课/.test(blocked.error || ''), `错误文案（${String(blocked.error).slice(0, 40)}…）`)
  ok(!!blocked.hint && /补 `plan`/.test(blocked.hint), '拒的时候**说清补法**（不让学生猜）')
  const forced = await author.execute({ ...base, point: 'pt3', commit: true, force: true })
  ok(forced.ok === false && forced.needsPlan === true, '**force 也绕不过大纲闸**（01:385 明说禁 force 绕）')

  // ── ④ 有地图 → 放行（后面由摸底闸接棒）──
  const passed = await author.execute({ ...base, point: 'pt2', commit: true })
  ok(passed.needsPlan !== true && passed.needsIntake === true,
    `有地图 → 大纲闸放行，接棒的是摸底闸（needsIntake=${passed.needsIntake}）`)
  ok(noPlan.ok === false, '（pt1x 不认识 → 不由大纲闸拦，走写盘分支的报错）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑤ 真包守卫 ──
ok(hashTree(path.join(ROOT, 'lessons')) === realBefore, '真包一字未动（lessons/ 全树哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 知识点地图：判据矩阵 / 写口拒坏图 / 大纲闸（禁 force） / 真包不动')
