/**
 * goal-tool.mjs —— `whale_goal`（终点契约的 agent 侧写入口，2026-09-24 F1b）
 *
 * 为什么单开一套：这个工具补的是**一个真空** —— 终点（`goals.jsonl`）原来只有 wizard 那条表单路能写
 * （`goalFromForm` 只被 `lib/mods/starter.js` 调），而 v3 要把表单屏删掉。
 * `GOAL_SOURCES` 里早就声明了 `'agent'`，这个工具就是把那个来源接上。
 *
 * 覆盖面：
 *   ① 装得上 + 空台账 read
 *   ② 必填校验：goal / tier / acceptance 各自缺了就报错（不静默拼过去）
 *   ③ record 合法 → v1 + source=agent + **artifact.what 原文逐字** + acceptance 逐条 auto:false
 *   ④ 裸 point 名能补出圆圈（`spring-boot` → `programming/spring-boot`）
 *   ⑤ append-only：再记一次 → v2 且 replaces=v1（不覆盖）
 *   ⑥ **先 intake 后 goal** ⇒ 契约里的 `from` 自动带上起点台阶
 *   ⑦ 真包一字未动
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { plugin as goalPlugin } from '../lib/mods/goal.js'
import { plugin as intakePlugin } from '../lib/mods/intake.js'
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

console.log(`\n[goal-tool] 课程包：${ROOT}`)
const realBefore = hashTree(path.join(ROOT, 'learning-records'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goal-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  fs.rmSync(path.join(tmp, 'learning-records', 'goals.jsonl'), { force: true })
  const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }
  const tools = []
  const install = (mod) => { mod.install({ paths: { packRoot: tmp }, log: fakeLog, registerTool: (d) => tools.push(d) }); return tools[tools.length - 1] }
  const goal = install(goalPlugin)
  const intake = install(intakePlugin)

  // ── ① 装得上 + 空台账 read ──
  ok(goal?.name === 'whale_goal', 'whale_goal 装得上')
  const empty = await goal.execute({ op: 'read', root: tmp })
  ok(empty.ok === true && empty.count === 0 && Object.keys(empty.points).length === 0, '空台账：read 回 0 行、不炸')

  // ── ② 必填校验 ──
  const noGoal = await goal.execute({ op: 'record', point: 'spring-boot', tier: 3, acceptance: ['能跑'], root: tmp })
  ok(noGoal.ok === false && /goal/.test(noGoal.error), '缺 goal → 拒（' + noGoal.error + '）')
  const badTier = await goal.execute({ op: 'record', point: 'spring-boot', goal: 'x', tier: 9, acceptance: ['能跑'], root: tmp })
  ok(badTier.ok === false && /tier/.test(badTier.error), 'tier 不在 1..4 → 拒（' + badTier.error + '）')
  const noAcc = await goal.execute({ op: 'record', point: 'spring-boot', goal: 'x', tier: 3, acceptance: [], root: tmp })
  ok(noAcc.ok === false && /acceptance/.test(noAcc.error), '缺 acceptance → 拒（' + noAcc.error + '）')
  const noPoint = await goal.execute({ op: 'record', goal: 'x', tier: 3, acceptance: ['能跑'], root: tmp })
  ok(noPoint.ok === false && /point/.test(noPoint.error), '缺 point → 拒（' + noPoint.error + '）')
  ok(!fs.existsSync(path.join(tmp, 'learning-records', 'goals.jsonl')), '四条被拒的都没写盘（拒就是拒，不留半条）')

  // ── ③ record 合法 + ④ 裸 point 名补圆圈 ──
  const rec = await goal.execute({
    op: 'record', point: 'spring-boot',           // 裸名 → 应补成 programming/spring-boot
    goal: '能自己写一个带分层的任务接口',           // 原文逐字
    tier: 3, acceptance: ['GET /api/tasks 能按优先级筛', 'PATCH 能把任务标完成'],
    work: 'code/_hello-spring-boot', root: tmp,
  })
  ok(rec.ok === true && rec.goalSaved === true, 'record 成功')
  ok(rec.record.point === 'spring-boot' && rec.record.pointPath === 'programming/spring-boot',
    '裸 point 名补出了圆圈（' + rec.record.pointPath + '）')
  ok(rec.record.v === 1 && rec.record.replaces === null, '首版 v1、replaces=null')
  ok(rec.record.source === 'agent', '来源记成 agent（GOAL_SOURCES 里声明过的那个）')
  ok(rec.record.artifact.what === '能自己写一个带分层的任务接口', 'artifact.what = goal **原文逐字**（没被动过）')
  ok(rec.record.artifact.where === 'code/_hello-spring-boot', 'artifact.where 收下了作品路径')
  ok(rec.record.acceptance.length === 2 && rec.record.acceptance.every((a) => a.auto === false && a.no > 0),
    '验收逐条成了 {no, deliverable, auto:false, hint}')
  ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(rec.record)), '契约里**没有时间戳**（可对拍）')

  // ── ⑥ 先 intake 后 goal ⇒ from 带上起点台阶 ──
  await intake.execute({ op: 'record', point: 'vue', level: '有基础', prior: '写过 HTML', can: '能改样例', stuck: '响应式', startTier: 2, root: tmp })
  const rec2 = await goal.execute({ op: 'record', point: 'vue', goal: '把接口数据渲染成能点的页面', tier: 2, acceptance: ['三个文件齐'], root: tmp })
  ok(rec2.ok === true && rec2.record.from && rec2.record.from.tier === 2,
    '先 intake 后 goal ⇒ from 自动从最新摸底拷贝了起点台阶（tier ' + rec2.record.from?.tier + '）')

  // ── ⑤ append-only：同一点再记一次 → v2 且 replaces=v1 ──
  const rec3 = await goal.execute({ op: 'record', point: 'spring-boot', goal: '换成：能写一个完整的 CRUD', tier: 4, acceptance: ['四条接口都能跑'], reason: '学生改了终点', root: tmp })
  ok(rec3.ok === true && rec3.record.v === 2 && rec3.record.replaces === 1, '换终点 = 追一版新的（v2 取代 v1），不覆盖')
  ok(rec3.record.reason === '学生改了终点', '换终点的理由留痕了')
  const readBack = await goal.execute({ op: 'read', root: tmp })
  ok(readBack.ok === true && readBack.count === 3, 'read 回 3 行（append-only，旧版还在）')
  ok(readBack.points['spring-boot'].v === 2 && readBack.points['spring-boot'].artifact.what === '换成：能写一个完整的 CRUD',
    'read 的现行终点是**最新那一版**（v2）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑦ 真包一字未动 ──
ok(hashTree(path.join(ROOT, 'learning-records')) === realBefore, '真包一字未动（learning-records/ 全树哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ whale_goal：必填严拒 / 原文逐字 / 裸名补圆圈 / append-only / from 接摸底 / 真包不动')
