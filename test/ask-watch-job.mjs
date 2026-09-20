/**
 * ask-watch-job.mjs —— `whale_ask action=watch`：用宿主原生 job 等新提问
 *
 * 为什么这么设计（静态验过，依据都写在这）：
 *   · 插件**不能**直接调 `agent.followup()`（不公开）
 *   · 但 `ctx.jobs` 是公开服务：`start(spec)` 起一个属于某 owner 的 job
 *     （dsh-jobs-local/lib/index.js:131），`spec.owner` 被控制器服务即可（:279 servesOwner）
 *   · job 的 `hooks.done` 完成 → `settle()` → `onJobDone` → dsh-tool-jobs 叫醒 owner
 *     （dsh-tool-jobs/lib/index.js:200-226，自带 wakeBudget）
 *   · 工具签名是 `execute(args, exec)`，`exec.agent` 每个模型驱动的调用都带
 *     （dsh-tool-todo:170 / dsh-tool-workflow 注释）
 *
 * ⚠️ 本测试用**假 jobs 服务**：能验"我们挂对了 job、什么时候结算、会不会误结算"，
 *    **不能**验"宿主真的因此叫醒了 agent" —— 那一条只能现场验。
 *
 * 判据：
 *   ① watch 起一个 job：owner === exec.agent、kind/label 非空、run() 给出 { done, cancel }
 *   ② 没有新提问时**不许**结算（等 300ms 仍 pending）
 *   ③ 出现更大编号的新提问 → 结算，detail 里点名是哪条
 *   ④ **高水位**：我们自己 drain（队列行数变少/同编号）→ 不许结算（否则自己叫醒自己 ✗）
 *   ⑤ 重复 watch → **复用**已有 job（job 有并发上限，不能另起）
 *   ⑥ unwatch → cancel 被调用、此后新提问不再结算、再 watch 会起新 job
 *   ⑦ 拿不到 exec.agent → 明确报错（不静默）
 *   ⑧ 宿主没有 jobs 服务 → 明确报错并指出可退回 tools/ask-watch.js
 *   ⑨ 真包未被改动
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { plugin as askPlugin } from '../lib/mods/ask.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function race(p, ms) {
  return Promise.race([p.then((v) => ({ settled: true, v })), sleep(ms).then(() => ({ settled: false }))])
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
const realBefore = sha(fs.readFileSync(path.join(ROOT, 'questions', 'pending.jsonl')))

console.log(`\n[watch] 课程包：${ROOT}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-watch-'))
try {
  fs.mkdirSync(path.join(tmp, 'questions'), { recursive: true })
  const PENDING = path.join(tmp, 'questions', 'pending.jsonl')
  const PROCESSED = path.join(tmp, 'questions', 'processed.jsonl')
  fs.writeFileSync(PENDING, JSON.stringify({ id: '0004', lesson: '第2课', question: '已有的一条' }) + '\n', 'utf8')
  fs.writeFileSync(PROCESSED, '', 'utf8')

  const started = []
  const fakeJobs = { start: (spec) => { started.push(spec); return `job-${started.length}` } }
  const tools = []
  const mkHctx = (withJobs) => ({
    paths: { packRoot: tmp },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    registerTool: (d) => tools.push(d),
    inject: (names, cb) => {
      if (names.includes('connection')) cb({ get: () => ({ fetch: { register: () => {} } }) })
      if (names.includes('jobs') && withJobs) cb({ jobs: fakeJobs })
    },
  })
  askPlugin.install(mkHctx(true))
  const tool = tools.find((t) => t.name === 'whale_ask')
  const agent = { id: 'agent-A' }

  // ── ① 起 job ──
  const w1 = await tool.execute({ root: tmp, action: 'watch', intervalMs: 40 }, { agent })
  ok(w1.ok === true && started.length === 1, `watch → 起了 1 个 job（${w1.summary}）`)
  const spec = started[0]
  ok(spec.owner === agent, 'spec.owner 就是调用者自己（叫醒谁靠它）')
  ok(typeof spec.kind === 'string' && spec.kind.length > 0 && typeof spec.label === 'string' && spec.label.length > 0, `kind/label 非空（${spec.kind} / ${spec.label}）`)
  const hooks = spec.run()
  ok(typeof hooks?.done?.then === 'function' && typeof hooks?.cancel === 'function', 'run() 给出 { done, cancel }（宿主契约）')

  // ── ② 没有新提问 → 不许结算 ──
  const idle = await race(hooks.done, 300)
  ok(idle.settled === false, '队列没变化时**不结算**（还在盯）')

  // ── ④ 高水位：我们自己 drain（行数变少）→ 不许结算 ──
  fs.writeFileSync(PENDING, '', 'utf8') // 模拟 drain 把 #0004 归档掉
  fs.appendFileSync(PROCESSED, JSON.stringify({ id: '0004', lesson: '第2课' }) + '\n', 'utf8')
  const drainRace = await race(hooks.done, 250)
  ok(drainRace.settled === false, '我们自己 drain（队列行数变少 / 同编号）**不触发**结算 —— 不然就是自己叫醒自己')

  // ── ⑤ 重复 watch → 复用 ──
  const w2 = await tool.execute({ root: tmp, action: 'watch' }, { agent })
  ok(w2.ok === true && started.length === 1 && /已经在盯着/.test(w2.summary), `重复 watch 复用同一个 job（未再 start：${started.length}）`)

  // ── ③ 新提问 → 结算 ──
  fs.appendFileSync(PENDING, JSON.stringify({ id: '0005', lesson: '第2课', question: '新来的一条提问' }) + '\n', 'utf8')
  const hit = await race(hooks.done, 800)
  ok(hit.settled === true && hit.v.status === 'completed', `新提问 → job 结算（${hit.settled ? hit.v.status : '没结算 ✗'}）`)
  ok(hit.settled && /#0005/.test(hit.v.detail) && /新来的一条提问/.test(hit.v.detail), `结算 detail 点名是哪条（${hit.settled ? hit.v.detail.slice(0, 50) : ''}…）`)

  // 结算后从表里清掉 → 再 watch 应该起新 job
  const w3 = await tool.execute({ root: tmp, action: 'watch' }, { agent })
  ok(started.length === 2, `结算过的监听不会占着位置：再 watch 起新 job（${w3.summary}）`)

  // ── ⑥ unwatch ──
  let cancelled = false
  const spec2 = started[1]
  const hooks2 = spec2.run()
  hooks2.done.then(() => { cancelled = true }) // cancel 会 resolve done（status=cancelled）
  const un = await tool.execute({ root: tmp, action: 'unwatch' }, { agent })
  await sleep(80)
  ok(un.ok === true && /已撤掉/.test(un.summary), `unwatch → ${un.summary}`)
  ok(cancelled === true, 'unwatch 通过 hooks.cancel() 走（done 以 cancelled 结算）')
  fs.appendFileSync(PENDING, JSON.stringify({ id: '0006', question: '撤销之后的新提问' }) + '\n', 'utf8')
  const after = await race(hooks2.done, 250)
  ok(after.settled === true && after.v.status === 'cancelled', '撤销之后的新提问不再被这个监听处理（它已经结算了）')

  // ── ⑦⑧ 两条明确报错 ──
  const noAgent = await tool.execute({ root: tmp, action: 'watch' })
  ok(noAgent.ok === false && /exec\.agent/.test(noAgent.error), `拿不到 exec.agent → 明确报错（${String(noAgent.error).slice(0, 40)}…）`)
  const tools2 = []
  askPlugin.install({ paths: { packRoot: tmp }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools2.push(d), inject: (n, cb) => { if (n.includes('connection')) cb({ get: () => ({ fetch: { register: () => {} } }) }) } })
  const tool2 = tools2.find((t) => t.name === 'whale_ask')
  const noJobs = await tool2.execute({ root: tmp, action: 'watch' }, { agent: { id: 'agent-B' } })
  ok(noJobs.ok === false && /whale_ask action=list/.test(noJobs.error), `没有 jobs 服务 → 明确报错并给出替代（${String(noJobs.error).slice(0, 46)}…）`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

ok(sha(fs.readFileSync(path.join(ROOT, 'questions', 'pending.jsonl'))) === realBefore, '真包未被改动（pending.jsonl 哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 原生监听：owner/契约对、高水位不误触发、复用与撤销都对（"真的叫醒"留给现场验）')
