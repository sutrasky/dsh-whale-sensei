/**
 * test/audit/T16.mjs — 重建作业有界、按包串行且可卸载取消（卡 T16 / 报告 D07 + A01）
 * ------------------------------------------------------------------
 * 病（旧行为，报告 D07 / A01）：
 *   `lib/rebuild-job.js` 起的重建作业**只有内存里的一个 Map**，没有资源边界、没有取消口：
 *     · 学生连点几下建圈 → 十几棵 node 进程同时在写同一批产物（**没有"几个包并行"的上限**）；
 *     · 包里一个「无限打印」的重建脚本 → 输出无上限地堆在宿主内存里；
 *     · 包里一个「永不退出」的脚本 → 那个作业永远 `done:false`，进程永远留着；
 *     · 插件卸载（宿主重载）→ 作业表在模块级，**一个进程都不撤**，残留的 node 还在写文件。
 *
 * 本文件判的就是这四条 + 卡面那三句验收判据（逐字）：
 *   「无限输出/永不退出夹具被有界终止；并发请求串行或合并；卸载后子进程与作业均结束。」
 *
 * 怎么判（**真实证据，不是"我以为"**）：
 *   · 夹具是**真 spawn 出来的真 node 进程树**：挂住的、无限输出的，还有自己再拉一个孙进程的；
 *   · 撤树之后用 `process.kill(pid, 0)` + `tasklist` **实测** `child.pid` 与它的后代都没了，
 *     并且孙进程写的"心跳"文件**冻住**（防止"pid 被回收给了别人"这种假消失）；
 *   · 公开 state 必须真的是 `timed-out` / `cancelled`（**不是** `succeeded`）；
 *   · 环形尾部必须真的是**尾部**（保留窗口是连续递增的记号后缀 + 开头被丢掉）。
 *
 * 两个入口（T13 同型）：
 *   `node test/audit/T16.mjs --automated-only` → 只跑自动部分：`PASS T16-AUTO checks=N failed=0 skipped=0` exit0
 *   `node test/audit/T16.mjs`                  → 自动部分 + **真实 DSH 宿主证据**门槛：
 *       缺宿主侧的作业撤回证据 ⇒ `BLOCKED T16 … final-real-host-evidence-missing` exit2
 *       （为什么缺：T13 已实证本机**没有**可验证的隔离装卸入口，见
 *        `audit-evidence/B5/host-lifecycle-research.md`。**不许**用 AUTO 冒充整卡 PASS。）
 *   ⚠️ 产品断言失败**优先** `FAIL` exit1 —— 缺材料不许掩盖失败。
 *
 * 固定用例 ID 全集（**不许漂移**）：B01-B05 / C01-C04 / Q01-Q05 / S01-S07 / W01-W03 / V01
 *   B* 有界与撤树（环形尾部 / 无限输出 / 永不退出 / 真实进程树）
 *   C* 取消（取消 / 幂等 / owner 隔离 / 作用域卸载等待）
 *   Q* 并发与排队（每包 FIFO / ≤2 包并行 / 相同请求合并 / 满队 busy / 缺件语义不变）
 *   S* 状态与产品缝（旧字段 / 同步异步对拍 / missing-script ≠ 空链 / 机器失败 / 公开投影 /
 *      create 与 author 两条入口的 scope 接线 + 卸载）
 *   W* 边界（同步路径有界 / 只杀自己那棵树 / 真引擎闭包可用：无需旁路）
 *   V01 公开 state 全集的收口判据
 *
 * 铁律：夹具全在 `E:/Temp/whale-T16-*`，真包一个字节都不动；跑完不留挂住的子进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createResourceScope } from '../../lib/resource-scope.js'
import { apply } from '../../lib/index.js'
import { writeScaffold } from '../../lib/pack-scaffold.js'
import {
  startRebuild, startScripts, getRebuild, listRebuilds, waitRebuild, rebuildNow,
  cancelRebuild, cancelAllRebuilds, verifyEngineForScripts,
  MAX_QUEUE, MAX_RUNNING, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, PUBLIC_STATES,
  summarize, tailOf, codeOf,
} from '../../lib/rebuild-job.js'
import { rebuildArtifacts } from '../../lib/ask-io.js'

/** 固定用例 ID 全集（漂移即判失败） */
const IDS = [
  'B01', 'B02', 'B03', 'B04', 'B05',
  'C01', 'C02', 'C03', 'C04',
  'Q01', 'Q02', 'Q03', 'Q04', 'Q05',
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07',
  'W01', 'W02', 'W03',
  'V01',
]

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')
const EVIDENCE = path.join(REPO, 'audit-evidence/T16')
fs.mkdirSync(EVIDENCE, { recursive: true })
const STAMP = `${Date.now()}-${process.pid}`
const TMP_BASE = 'E:/Temp'
fs.mkdirSync(TMP_BASE, { recursive: true })
const FIXTURE = fs.mkdtempSync(path.join(TMP_BASE, 'whale-T16-'))
const LS = '\n'

/* ── 小工具 ─────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posix = (x) => String(x).replace(/\\/g, '/')
/** 把宿主路径写成夹具脚本里的 POSIX 字面量（Windows 反斜杠在 JS 字面量里会变成转义） */
const q = (x) => JSON.stringify(posix(x))

/** 这个 pid 现在还活着吗（`tasklist` 是给人看的原始证据，`process.kill(pid,0)` 是机器判据） */
function alivePid(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}
function tasklistLine(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  return String(r.stdout ?? '').trim().split('\n')[0] || ''
}

/** 原始 PID 观测（含时间戳与 pid,alive）—— 判词之外还要留"当时到底看到了什么" */
const pidObservations = []
function observe(tag, pid, extra = {}) {
  const entry = {
    tag, at: Date.now(), atIso: new Date().toISOString(), pid,
    alive: alivePid(pid), tasklist: tasklistLine(pid), ...extra,
  }
  pidObservations.push(entry)
  return entry
}
const observeAll = (tag, pids, extra = {}) => pids.map((p) => observe(tag, p, extra))

/** 等一个条件成立（有上界；超时返回 false，由用例自己判红） */
async function waitUntil(pred, ms = 5000, step = 50) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await pred()) return true
    await sleep(step)
  }
  return false
}

/** 心跳文件冻住没有（孙进程真的死了的最硬证据：pid 可以被回收，心跳不会自己停） */
async function beatFrozen(file, ms = 500) {
  const a = fs.readFileSync(file, 'utf8')
  await sleep(ms)
  const b = fs.readFileSync(file, 'utf8')
  return { frozen: a === b, a, b }
}

/**
 * 抓一个"**此刻还活着**"的子进程句柄（真链条那两条用例要它）。
 * 为什么不能直接读 `job.spawned[0].pid`：真重建链的每一步都是短命进程（几十毫秒就跑完），
 * 等你读完回执它可能已经退了 —— 那时再"撤树"撤的是一具尸体，判不出"撤树"这件事。
 * 所以按 5ms 的粒度盯着 `job._child`，抓到就以那一刻为准（抓到之后的死活不另判，避免抢跑）。
 */
async function catchLiveChild(job, ms = 8000) {
  let pid = null
  const ok = await waitUntil(() => {
    const cur = job._child
    if (cur && Number.isInteger(cur.pid) && cur.pid > 0 && alivePid(cur.pid)) { pid = cur.pid; return true }
    return false
  }, ms, 5)
  return { ok, pid }
}

const T = {
  ok(cond, msg) { if (!cond) throw new Error(msg) },
  eq(a, b, msg) { if (a !== b) throw new Error(`${msg}：actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`) },
  deep(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}：actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`)
  },
}

/* ── 夹具：真引擎闭包的课程包 + 真 node 子进程的桩脚本 ─────────────────── */

const notes = []
const records = []
const cleanupFailures = []
const seenStates = new Set()
/** 本次测试见过的一切作业 pid（收尾统一核一遍有没有挂住的） */
const allSpawned = new Set()

/** 铺一个**真引擎闭包**的课程包（模板逐字节拷 —— 引擎件一个字节都没动，见 W03） */
function layPack(name) {
  const root = path.join(FIXTURE, name)
  fs.cpSync(TEMPLATE, root, { recursive: true })
  fs.mkdirSync(path.join(root, 'fx'), { recursive: true })
  return root
}
function writeFx(pack, name, body) {
  const rel = `fx/${name}`
  fs.writeFileSync(path.join(pack, ...rel.split('/')), body, 'utf8')
  return rel
}

/** 无限输出 + 永不退出：每条 ~4KB（Windows 上管道写是同步的，小行产量太低量不出截断） */
function srcFlood(tickFile) {
  return `const fs = require('node:fs')
let n = 0
const line = 'x'.repeat(4000)
setInterval(() => {
  n++
  process.stdout.write('TICK ' + n + ' ' + line + '\\n')
  if (n % 20 === 0) fs.writeFileSync(${q(tickFile)}, String(n))
}, 1)
`
}

/** 永不退出 + 自己再拉一个孙进程（两条都在挂）；孙进程写"心跳" */
function srcHangTree(pidsFile, beatFile) {
  const grand = `const fs=require('fs');let i=0;setInterval(()=>{i++;fs.writeFileSync(${q(beatFile)},String(i))},80)`
  return `const { spawn } = require('node:child_process')
const fs = require('node:fs')
const g = spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' })
fs.writeFileSync(${q(pidsFile)}, JSON.stringify({ self: process.pid, grand: g.pid }))
setInterval(() => {}, 1000)
`
}

/** 只挂住（不拉孙进程）；把自己的 pid 写进侧车（同步路径那条用例要它） */
function srcHang(pidFile) {
  return `require('node:fs').writeFileSync(${q(pidFile)}, String(process.pid))
setInterval(() => {}, 1000)
`
}

/** 挂住 + 在日志里留 START 记号（**独立**数并发：不靠作业自己报的 state） */
function srcHangTagged(logFile, tag) {
  return `const fs = require('node:fs')
fs.appendFileSync(${q(logFile)}, 'START ${tag}\\n')
setInterval(() => {}, 1000)
`
}

/** 两个流同时无限输出（验"stdout / stderr **各自**一个环形尾部"） */
function srcFloodBoth(tickFile) {
  return `const fs = require('node:fs')
let n = 0
const a = 'o'.repeat(4000), b = 'e'.repeat(4000)
setInterval(() => {
  n++
  process.stdout.write('OUT ' + n + ' ' + a + '\\n')
  process.stderr.write('ERR ' + n + ' ' + b + '\\n')
  if (n % 20 === 0) fs.writeFileSync(${q(tickFile)}, String(n))
}, 1)
`
}

/** 先无限输出（远超 64KiB）再**按退出码**收尾 —— 判"截断 ≠ 成功/失败" */
function srcFloodExit(code) {
  return `const line = 'y'.repeat(200)
let n = 0
function pump() {
  let ok = true
  while (ok && n < 1500) { n++; ok = process.stdout.write('F ' + n + ' ' + line + '\\n') }
  if (n >= 1500) process.stdout.write('', () => process.exit(${code}))
  else process.stdout.once('drain', pump)
}
pump()
`
}

const srcExit = (code) => `process.exit(${code})\n`
const srcSlow = (ms, out) => `${out ? `require('node:fs').writeFileSync(${q(out)}, 'done')\n` : ''}setTimeout(() => process.exit(0), ${ms})\n`
const srcMark = (marker) => `require('node:fs').appendFileSync(${q(marker)}, 'ran\\n')\n`

/**
 * 从环形尾部里抠出连续递增的记号（TICK / OUT / ERR / F），用来证"留下的确实是尾部"。
 * ⚠️ 环是**按字节**切的：第一行和最后一行都可能被切掉半截 —— 那不算"不是尾部"，
 * 所以只在**完整行**上判连续性（并把"切到头/尾"如实记下来）。
 */
function tickWindow(text, prefix) {
  const re = new RegExp(`^${prefix} (\\d+) `)
  const lines = String(text ?? '').split('\n').filter(Boolean)
  let partialHead = false
  let partialTail = false
  if (lines.length && !re.test(lines[0])) { lines.shift(); partialHead = true }
  if (lines.length && !re.test(lines[lines.length - 1])) { lines.pop(); partialTail = true }
  const nums = lines.map((l) => {
    const m = re.exec(l)
    return m ? Number(m[1]) : NaN
  })
  return { nums, partialHead, partialTail, complete: nums.length > 0 && nums.every(Number.isFinite) }
}
const contiguous = (nums) => nums.every((v, i) => i === 0 || v === nums[i - 1] + 1)

/* ── 主流程 ─────────────────────────────────────────────────────────── */

let fatal = null

async function check(id, fn) {
  let timer = null
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${id} 超过 45s 还没结束`)), 45000) }),
    ])
    records.push({ id, status: 'pass' })
  } catch (e) {
    records.push({ id, status: 'fail', error: e && e.stack ? e.stack : String(e) })
  } finally {
    clearTimeout(timer)
    // ⚠️ 每条用例**自己收尾**：用例中途判红也不许把"在跑的作业"漏给下一条。
    //    否则一条红会连锁把后面每一条都顶成 queued/busy —— 那是假红，不是真判据。
    try { await cancelAllRebuilds(undefined, `T16 ${id} 用例收尾`) } catch (e) {
      cleanupFailures.push(`${id}：${e?.message ?? e}`)
    }
  }
}

/** 每个用例都记一眼它看到的公开 state（V01 收口判"七种都真的出现过、没有第八种"） */
const seen = (job) => {
  if (job && job.state) seenStates.add(job.state)
  for (const s of job?.spawned ?? []) allSpawned.add(s.pid)
  return job
}

try {
  /* ══════════════ ① 有界与撤树（B） ══════════════ */

  const main = layPack('main')
  const MAIN_MARKER = path.join(FIXTURE, 'main-marker.txt')
  const MAIN_TICK = path.join(FIXTURE, 'main-tick.txt')
  const MAIN_TICK2 = path.join(FIXTURE, 'main-tick2.txt')
  const MAIN_PIDS = path.join(FIXTURE, 'main-pids.json')
  const MAIN_BEAT = path.join(FIXTURE, 'main-beat.txt')
  const MAIN_PID = path.join(FIXTURE, 'main-pid.txt')

  const FX_OK = writeFx(main, 'ok.js', srcMark(MAIN_MARKER))
  const FX_FAIL3 = writeFx(main, 'fail3.js', srcExit(3))
  const FX_SLOW = writeFx(main, 'slow200.js', srcSlow(200))
  const FX_FLOOD = writeFx(main, 'flood.js', srcFlood(MAIN_TICK))
  const FX_FLOOD_BOTH = writeFx(main, 'flood-both.js', srcFloodBoth(MAIN_TICK2))
  const FX_FLOOD_EXIT0 = writeFx(main, 'flood-exit0.js', srcFloodExit(0))
  const FX_FLOOD_EXIT3 = writeFx(main, 'flood-exit3.js', srcFloodExit(3))
  const FX_HANG_TREE = writeFx(main, 'hang-tree.js', srcHangTree(MAIN_PIDS, MAIN_BEAT))
  const FX_HANG = writeFx(main, 'hang.js', srcHang(MAIN_PID))
  const ABSENT = 'fx/definitely-not-in-this-pack.js'

  // 夹具前提：这个包过**严格**引擎闸（没传任何旁路 —— T16 用真引擎闭包，见 W03）
  const premGate = verifyEngineForScripts(main, [FX_OK, FX_HANG_TREE])
  T.eq(premGate.ok, true, `夹具前提：桩脚本所在的包必须过严格引擎闸（${JSON.stringify(premGate)}）`)

  await check('B01', async () => {
    // 无限输出：作业必须被**有界**终止，且留下的是**尾部**（连续的记号后缀 + 开头被丢掉）
    fs.rmSync(MAIN_TICK, { force: true })
    const job = startRebuild(main, [FX_FLOOD], { subject: 'T16 无限输出', timeoutMs: 1500 })
    seen(job)
    T.eq(job.state, 'running', 'B01 起跑那一刻 state=running')
    await waitRebuild(job.id)
    seen(job)
    const tail = job.stdoutTail
    const { nums, partialHead, complete } = tickWindow(tail, 'TICK')
    const sidecar = Number(fs.readFileSync(MAIN_TICK, 'utf8'))
    T.eq(job.state, 'timed-out', 'B01 无限输出（永不退出）→ 超时被终止')
    T.eq(job.truncated, true, 'B01 超过 64KiB ⇒ truncated=true')
    T.ok(Buffer.byteLength(tail) <= DEFAULT_MAX_OUTPUT_BYTES, `B01 环形尾部不许超过上限（实得 ${Buffer.byteLength(tail)} 字节）`)
    T.ok(job.stdoutBytes > DEFAULT_MAX_OUTPUT_BYTES, `B01 它确实产出了超过上限的字节（实得 ${job.stdoutBytes}）`)
    T.ok(complete, `B01 留下的必须是完整记号行（前 ${partialHead ? '半行被切' : '整'}，实得 ${JSON.stringify(tail.slice(0, 60))}）`)
    T.ok(contiguous(nums), 'B01 留下的必须是一段**连续**的记号（说明是从尾部切下来的，中间没有洞）')
    T.ok(nums[0] > 1, `B01 开头必须被丢掉（第一条保留下来的完整记号是 ${nums[0]}）`)
    T.ok(nums[nums.length - 1] >= sidecar && nums[nums.length - 1] <= sidecar + 25,
      `B01 留下的尾巴必须贴到最后产出（尾号 ${nums[nums.length - 1]}，侧车记到 ${sidecar}）`)
    T.ok(nums.length >= 5, `B01 尾部里要有足够多的行（实得 ${nums.length} 行）`)
    notes.push(`B01 tailBytes=${Buffer.byteLength(tail)} stdoutBytes=${job.stdoutBytes} 窗口=[${nums[0]},${nums[nums.length - 1]}] 侧车=${sidecar}`)
  })

  await check('B02', async () => {
    // stdout / stderr **各自**一个 64KiB 环形尾部：两条流都超限，谁也不挤掉谁
    fs.rmSync(MAIN_TICK2, { force: true })
    const job = startRebuild(main, [FX_FLOOD_BOTH], { subject: 'T16 两个流都无限', timeoutMs: 1500 })
    seen(job)
    await waitRebuild(job.id)
    seen(job)
    const o = tickWindow(job.stdoutTail, 'OUT')
    const e = tickWindow(job.stderrTail, 'ERR')
    T.eq(job.state, 'timed-out', 'B02 同样是超时被终止')
    T.eq(job.truncated, true, 'B02 truncated=true')
    T.ok(job.stdoutBytes > DEFAULT_MAX_OUTPUT_BYTES && job.stderrBytes > DEFAULT_MAX_OUTPUT_BYTES,
      `B02 两条流都要真的超过上限（stdout=${job.stdoutBytes} stderr=${job.stderrBytes}）`)
    T.ok(Buffer.byteLength(job.stdoutTail) <= DEFAULT_MAX_OUTPUT_BYTES && Buffer.byteLength(job.stderrTail) <= DEFAULT_MAX_OUTPUT_BYTES,
      `B02 两条流各自都不许超过上限（${Buffer.byteLength(job.stdoutTail)} / ${Buffer.byteLength(job.stderrTail)}）`)
    T.ok(o.complete && contiguous(o.nums), 'B02 stdout 尾部是连续的 OUT 后缀')
    T.ok(e.complete && contiguous(e.nums), 'B02 stderr 尾部是连续的 ERR 后缀')
    T.ok(o.nums[0] > 1 && e.nums[0] > 1, `B02 两条流都发生了截断（OUT 起 ${o.nums[0]} / ERR 起 ${e.nums[0]}）`)
    notes.push(`B02 stdout=${Buffer.byteLength(job.stdoutTail)}B[${o.nums[0]}..${o.nums[o.nums.length - 1]}] stderr=${Buffer.byteLength(job.stderrTail)}B[${e.nums[0]}..${e.nums[e.nums.length - 1]}]`)
  })

  await check('B03', async () => {
    // **截断不算成功**（卡面 outOfScope 明写）：成败只看退出码，截断只是"输出被裁过"
    const okJob = startRebuild(main, [FX_FLOOD_EXIT0], { subject: 'T16 截断但退出 0', timeoutMs: 20000 })
    const failJob = startRebuild(main, [FX_FLOOD_EXIT3], { subject: 'T16 截断且退出 3', timeoutMs: 20000 })
    seen(okJob); seen(failJob)
    await Promise.all([waitRebuild(okJob.id), waitRebuild(failJob.id)])
    seen(okJob); seen(failJob)
    const o = tickWindow(okJob.stdoutTail, 'F')
    T.eq(okJob.truncated, true, 'B03 退出 0 的那条也确实被截断了')
    T.eq(okJob.steps[0].code, 0, 'B03 退出码如实（0）')
    T.eq(okJob.state, 'succeeded', 'B03 退出 0 ⇒ succeeded（截断没有把它判成失败）')
    T.eq(okJob.rebuild.ok, true, 'B03 rebuild.ok=true')
    T.eq(okJob.failed, false, 'B03 failed=false')
    T.ok(okJob.stdoutBytes > DEFAULT_MAX_OUTPUT_BYTES, `B03 那条真的产出了 ${okJob.stdoutBytes} 字节`)
    T.ok(o.complete && contiguous(o.nums) && o.nums[0] > 1, `B03 尾部还是后缀（起 ${o.nums[0]}，完整=${o.complete}）`)
    T.eq(failJob.truncated, true, 'B03 退出 3 的那条也被截断')
    T.eq(failJob.steps[0].code, 3, 'B03 退出码如实（3）')
    T.eq(failJob.state, 'failed', 'B03 退出 3 ⇒ failed（截断也没把它藏起来）')
    T.eq(failJob.rebuild.ok, false, 'B03 rebuild.ok=false')
    notes.push(`B03 exit0: state=${okJob.state} bytes=${okJob.stdoutBytes} truncated=${okJob.truncated}; exit3: state=${failJob.state} code=${failJob.steps[0].code}`)
  })

  await check('B04', async () => {
    // 永不退出 + **真进程树**（子进程 + 它拉起来的孙进程）：超时 → 有界终止 + 5 秒内实测消失
    fs.rmSync(MAIN_PIDS, { force: true }); fs.rmSync(MAIN_BEAT, { force: true })
    const job = startRebuild(main, [FX_HANG_TREE], { subject: 'T16 永不退出', timeoutMs: 1200 })
    seen(job)
    T.eq(job.state, 'running', 'B04 起跑那一刻 state=running')
    await waitRebuild(job.id)
    seen(job)
    const fx = JSON.parse(fs.readFileSync(MAIN_PIDS, 'utf8'))
    T.eq(job.state, 'timed-out', 'B04 超时 → state=timed-out（**不是** succeeded）')
    T.ok(job.steps.length >= 1 && job.steps[0].code !== 0, `B04 被打断的那一步如实记进 steps（实得 ${JSON.stringify(job.steps.map((s) => s.code))}）`)
    T.eq(job.rebuild.ok, false, 'B04 rebuild.ok=false')
    T.eq(job.failed, true, 'B04 failed=true')
    T.ok(job.tree && job.tree.gone === true, `B04 进程树必须确认消失（实得 ${JSON.stringify(job.tree)}）`)
    const confirmMs = job.endedAt - job.tree.confirmedAt
    T.ok(confirmMs <= 5000, `B04 撤树确认时间在上限内（实得 ${confirmMs}ms）`)
    observeAll('B04-after', [fx.self, fx.grand], { script: FX_HANG_TREE, tree: job.tree.pids, taskkillRaw: job.tree.raw })
    T.eq(alivePid(fx.self), false, `B04 夹具子进程 pid=${fx.self} 必须没了`)
    T.eq(alivePid(fx.grand), false, `B04 夹具孙进程 pid=${fx.grand} 必须没了（整棵进程树）`)
    T.ok(job.tree.pids.includes(fx.self) && job.tree.pids.includes(fx.grand),
      `B04 撤的那棵树里必须**同时**有子与孙（实得 ${JSON.stringify(job.tree.pids)}）`)
    T.ok(!job.tree.pids.includes(process.pid), 'B04 撤的树里绝不许有我们自己')
    const beat = await beatFrozen(MAIN_BEAT)
    T.eq(beat.frozen, true, `B04 孙进程的心跳必须冻住（${beat.a} → ${beat.b}）`)
    notes.push(`B04 tree=${JSON.stringify(job.tree)} confirmMs=${confirmMs} 心跳 ${beat.a}→${beat.b}`)
  })

  await check('B05', async () => {
    // 取消（不是超时）那条路：同样是**真进程树** + 5 秒内实测消失 + 状态是 cancelled
    fs.rmSync(MAIN_PIDS, { force: true }); fs.rmSync(MAIN_BEAT, { force: true })
    const job = startRebuild(main, [FX_HANG_TREE], { subject: 'T16 取消挂住的树', timeoutMs: 60000 })
    seen(job)
    T.eq(job.state, 'running', 'B05 起跑那一刻 state=running')
    const started = await waitUntil(() => fs.existsSync(MAIN_PIDS), 5000)
    T.eq(started, true, 'B05 夹具前提：子进程与孙进程的 pid 已经落盘')
    const fx = JSON.parse(fs.readFileSync(MAIN_PIDS, 'utf8'))
    observeAll('B05-before', [fx.self, fx.grand], { script: FX_HANG_TREE, jobState: job.state })
    T.eq(alivePid(fx.self), true, 'B05 撤之前子进程确实活着（否则这条用例没在判撤树）')
    T.eq(alivePid(fx.grand), true, 'B05 撤之前孙进程确实活着')
    const rec = cancelRebuild(job.id, 'T16 B05 主动取消')
    T.eq(rec.ok, true, 'B05 cancelRebuild 认这个 id')
    const ended = await rec.ended
    seen(job)
    T.eq(ended.treeGone, true, 'B05 取消回执：进程树确认消失')
    T.eq(job.state, 'cancelled', 'B05 公开 state=cancelled（不是 succeeded）')
    T.eq(job.done, true, 'B05 done=true（撤树确认之后才 done）')
    T.ok(ended.ms !== null && ended.ms <= 5000, `B05 从撤树到确认消失 ≤5s（实得 ${ended.ms}ms）`)
    observeAll('B05-after', [fx.self, fx.grand], { script: FX_HANG_TREE, tree: job.tree.pids, taskkillRaw: job.tree.raw })
    T.eq(alivePid(fx.self), false, `B05 子进程 pid=${fx.self} 必须没了`)
    T.eq(alivePid(fx.grand), false, `B05 孙进程 pid=${fx.grand} 必须没了`)
    const beat = await beatFrozen(MAIN_BEAT)
    T.eq(beat.frozen, true, `B05 孙进程心跳冻住（${beat.a} → ${beat.b}）`)
    notes.push(`B05 tree=${JSON.stringify(job.tree)} ended.ms=${ended.ms} 心跳 ${beat.a}→${beat.b}`)
  })

  /* ══════════════ ② 取消（C） ══════════════ */

  await check('C01', async () => {
    // 在跑的作业被取消：同步回执立刻说 cancelled，`ended` 才是"树也没了"
    fs.rmSync(MAIN_PIDS, { force: true })
    const job = startRebuild(main, [FX_HANG_TREE], { subject: 'T16 C01', timeoutMs: 60000 })
    await waitUntil(() => fs.existsSync(MAIN_PIDS), 5000)
    const fx = JSON.parse(fs.readFileSync(MAIN_PIDS, 'utf8'))
    const rec = cancelRebuild(job.id, 'C01 取消')
    seen(job)
    T.eq(rec.state, 'cancelled', 'C01 cancelRebuild 同步回执里 state 立刻是 cancelled')
    T.eq(job.state, 'cancelled', 'C01 作业的公开 state 立刻是 cancelled（卡面：先记）')
    T.eq(job.done, false, 'C01 树还没确认消失之前 done 还是 false（"作业结束"包含"进程没了"）')
    T.deep(job.cancelReason, 'C01 取消', 'C01 取消原因进回执（reason）')
    const ended = await rec.ended
    T.eq(ended.treeGone, true, 'C01 等到的回执说树没了')
    T.eq(job.done, true, 'C01 确认之后 done=true')
    T.eq(alivePid(fx.self), false, `C01 子进程 ${fx.self} 没了`)
    T.eq(alivePid(fx.grand), false, `C01 孙进程 ${fx.grand} 没了`)
    notes.push(`C01 cancelReason=${JSON.stringify(job.cancelReason)} tree.ms=${ended.ms}`)
  })

  await check('C02', async () => {
    // 取消**已经结束**的作业是无害的（幂等）；不存在的 id 如实说"没有"
    const job = startRebuild(main, [FX_OK], { subject: 'T16 C02' })
    await waitRebuild(job.id)
    seen(job)
    const once = cancelRebuild(job.id, 'C02 取消一个已经跑完的')
    T.eq(once.ok, true, 'C02 取消已完成的作业 → ok:true（无害）')
    T.eq(once.already, true, 'C02 回执说清"它本来就结束了"（already）')
    T.eq(once.state, 'succeeded', 'C02 不许改它已经拿到的终态')
    const twice = cancelRebuild(job.id, 'C02 再来一次')
    T.eq(twice.ok, true, 'C02 再来一次还是无害')
    T.eq(job.state, 'succeeded', 'C02 终态仍然是 succeeded')
    const ghost = cancelRebuild('rb-does-not-exist', 'C02')
    T.eq(ghost.ok, false, 'C02 不存在的 id → ok:false（如实，不假装成功）')
    T.eq(ghost.state, null, 'C02 不存在的 id 没有 state')
    T.eq(await ghost.ended.then((r) => r.ok), false, 'C02 不存在的 id 的 ended 也如实')
  })

  await check('C03', async () => {
    // cancelAllRebuilds(owner) **只动该 owner 的**：另一个 owner 的作业必须还在跑
    const s1 = createResourceScope()
    const s2 = createResourceScope()
    const pidsA = path.join(FIXTURE, 'c03-a.json'); const pidsB = path.join(FIXTURE, 'c03-b.json')
    fs.rmSync(pidsA, { force: true }); fs.rmSync(pidsB, { force: true })
    const packB = layPack('c03-b')
    const A = writeFx(main, 'c03-a.js', srcHangTree(pidsA, path.join(FIXTURE, 'c03-a.beat')))
    const B = writeFx(packB, 'c03-b.js', srcHangTree(pidsB, path.join(FIXTURE, 'c03-b.beat')))
    const ja = startRebuild(main, [A], { subject: 'T16 C03 A', scope: s1, timeoutMs: 60000 })
    const jb = startRebuild(packB, [B], { subject: 'T16 C03 B', scope: s2, timeoutMs: 60000 })
    await waitUntil(() => fs.existsSync(pidsA) && fs.existsSync(pidsB), 5000)
    const pa = JSON.parse(fs.readFileSync(pidsA, 'utf8'))
    const pb = JSON.parse(fs.readFileSync(pidsB, 'utf8'))
    T.eq(ja.ownerKey === jb.ownerKey, false, 'C03 两个 owner 的令牌必须不同')
    const rep = await cancelAllRebuilds(s1, 'C03 只撤 s1')
    seen(ja); seen(jb)
    T.deep(rep.cancelled, [ja.id], `C03 只撤 s1 的那一条（实得 ${JSON.stringify(rep.cancelled)}）`)
    T.eq(ja.state, 'cancelled', 'C03 s1 的作业被撤')
    T.eq(alivePid(pa.self), false, `C03 s1 的树没了（${pa.self} / ${pa.grand}）`)
    T.eq(alivePid(pa.grand), false, 'C03 s1 的孙进程也没了')
    T.eq(jb.state, 'running', 'C03 **另一个 owner 的作业还在跑**（实得 ' + jb.state + '）')
    T.eq(alivePid(pb.self), true, 'C03 另一个 owner 的进程还活着')
    const rep2 = await cancelAllRebuilds(s2, 'C03 再撤 s2')
    T.deep(rep2.cancelled, [jb.id], 'C03 撤 s2 时才轮到它')
    T.eq(alivePid(pb.self), false, 'C03 s2 的树也没了')
    T.eq(alivePid(pb.grand), false, 'C03 s2 的孙进程也没了')
    await s1.dispose(); await s2.dispose()
  })

  await check('C04', async () => {
    // `scope.dispose()`（= 插件卸载那条路）**等**子进程与作业真的结束（resource-scope 会 await）
    const s = createResourceScope()
    const pids = path.join(FIXTURE, 'c04.json')
    fs.rmSync(pids, { force: true })
    const FX = writeFx(main, 'c04.js', srcHangTree(pids, path.join(FIXTURE, 'c04.beat')))
    const job = startRebuild(main, [FX], { subject: 'T16 C04', scope: s, timeoutMs: 60000 })
    await waitUntil(() => fs.existsSync(pids), 5000)
    const fx = JSON.parse(fs.readFileSync(pids, 'utf8'))
    const t0 = Date.now()
    const r = await s.dispose()
    const ms = Date.now() - t0
    seen(job)
    T.deep(r.errors, [], 'C04 作用域回收不报错')
    T.eq(job.state, 'cancelled', 'C04 卸载后作业 state=cancelled')
    T.eq(job.done, true, 'C04 卸载返回时作业已经结束（done=true）')
    T.ok(job.tree && job.tree.gone === true, 'C04 卸载返回时进程树已确认消失')
    T.eq(alivePid(fx.self), false, `C04 卸载返回时子进程 ${fx.self} 已经没了（"等"出来的，不是"喊"出来的）`)
    T.eq(alivePid(fx.grand), false, `C04 孙进程 ${fx.grand} 也没了`)
    T.ok(ms <= 5000, `C04 dispose 在 5 秒内返回（实得 ${ms}ms）`)
    notes.push(`C04 disposeMs=${ms} tree.ms=${job.tree.ms}`)
  })

  /* ══════════════ ③ 并发与排队（Q） ══════════════ */

  await check('Q01', async () => {
    // 每包 FIFO：**同一个包**的第二条必须排队（哪怕全局还空着一个槽）—— 用独立日志数，不看作业自报
    const pack = layPack('q1')
    const other = layPack('q1-other')
    const log = path.join(FIXTURE, 'q1.log')
    const ONE = writeFx(pack, 'q1-one.js', srcHangTagged(log, 'q1-one'))
    const TWO = writeFx(pack, 'q1-two.js', srcHangTagged(log, 'q1-two'))
    const OTH = writeFx(other, 'q1-other.js', srcHangTagged(log, 'q1-other'))
    const j1 = startRebuild(pack, [ONE], { subject: 'T16 Q01 第一条', timeoutMs: 60000 })
    const j2 = startRebuild(pack, [TWO], { subject: 'T16 Q01 第二条', timeoutMs: 60000 })
    // 关键：起一条**别的包**的作业来证明"槽位还有空的"，j2 却仍然排在后面
    const j3 = startRebuild(other, [OTH], { subject: 'T16 Q01 别的包', timeoutMs: 60000 })
    await sleep(200)
    seen(j1); seen(j2); seen(j3)
    T.eq(j1.state, 'running', 'Q01 第一条在跑')
    T.eq(j3.state, 'running', 'Q01 别的包的作业起来了（⇒ 全局槽位确实还剩一个）')
    T.eq(j2.state, 'queued', 'Q01 **同包**的第二条照样排队（每包 FIFO 优先于"抢空槽"）')
    T.eq(MAX_RUNNING, 2, 'Q01 卡面：最多 2 包并行')
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    T.deep(lines.slice().sort(), ['START q1-one', 'START q1-other'], 'Q01 独立日志：只有两条真的起了进程')
    T.eq(j2.steps.length, 0, 'Q01 排队的那条一个字节都没跑')
    await cancelRebuild(j1.id, 'Q01 撤第一条').ended
    const took = await waitUntil(() => j2.state === 'running', 5000)
    T.eq(took, true, 'Q01 第一条撤掉之后第二条才起来')
    // ⚠️ `state=running` 是**同步**立起来的（旧判据要的），子进程还要几十毫秒才写它的 START —— 等日志，别抢跑
    const wrote = await waitUntil(() => fs.readFileSync(log, 'utf8').split('\n').includes('START q1-two'), 5000)
    T.eq(wrote, true, 'Q01 第二条这时才写它的 START')
    await cancelRebuild(j2.id, 'Q01 收尾').ended
    await cancelRebuild(j3.id, 'Q01 收尾').ended
    seen(j1); seen(j2); seen(j3)
    T.deep([j1.state, j2.state, j3.state], ['cancelled', 'cancelled', 'cancelled'], 'Q01 收尾：三条都 cancelled')
  })

  await check('Q02', async () => {
    // ≤2 包并行：第三个包必须排队；用独立日志数"同时有几条在跑"
    const log = path.join(FIXTURE, 'q2.log')
    const packs = ['q2-a', 'q2-b', 'q2-c'].map((n) => layPack(n))
    const jobs = packs.map((p, i) => startRebuild(p, [writeFx(p, 'q2.js', srcHangTagged(log, `q2-${'abc'[i]}`))], {
      subject: `T16 Q02 ${'abc'[i]}`, timeoutMs: 60000,
    }))
    await sleep(250)
    jobs.forEach(seen)
    T.eq(jobs[0].state, 'running', 'Q02 第一个包在跑')
    T.eq(jobs[1].state, 'running', 'Q02 第二个包在跑')
    T.eq(jobs[2].state, 'queued', 'Q02 第三个包必须排队（最多 2 包并行）')
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    T.eq(lines.length, 2, `Q02 独立日志：此刻真的只有 2 条在跑（实得 ${JSON.stringify(lines)}）`)
    const rep = await cancelAllRebuilds(undefined, 'Q02 收尾')
    T.ok(rep.count >= 3, `Q02 收尾撤掉了 ${rep.count} 条`)
    jobs.forEach(seen)
    T.deep(jobs.map((j) => j.state), ['cancelled', 'cancelled', 'cancelled'], 'Q02 三条都 cancelled')
    T.deep(jobs.map((j) => j.spawned.map((s) => alivePid(s.pid))).flat().filter((v) => v === true), [], 'Q02 没有任何残留进程')
  })

  await check('Q03', async () => {
    // 相同**运行请求**（未开始）合并成一条；已经在跑的不合并；owner 不同不合并
    const pack = layPack('q3')
    const log = path.join(FIXTURE, 'q3.log')
    const BLK = writeFx(pack, 'q3-blk.js', srcHangTagged(log, 'q3-blk'))
    const SLOW = writeFx(pack, 'q3-slow.js', srcSlow(250, path.join(FIXTURE, 'q3-slow.done')))
    const s1 = createResourceScope()
    const s2 = createResourceScope()
    const blk = startRebuild(pack, [BLK], { subject: 'T16 Q03 占位', timeoutMs: 60000 })
    const a = startRebuild(pack, [SLOW], { subject: 'T16 Q03 合并', scope: s1 })
    const b = startRebuild(pack, [SLOW], { subject: 'T16 Q03 合并', scope: s1 })
    const c = startRebuild(pack, [SLOW], { subject: 'T16 Q03 合并', scope: s2 })
    const d = startRebuild(pack, [SLOW], { subject: 'T16 Q03 别的 subject', scope: s1 })
    seen(a); seen(c); seen(d)
    T.eq(a.id, b.id, 'Q03 相同的运行请求（都还没开始）合并成同一条')
    T.eq(a.merged, 2, 'Q03 合并计数=2（两个调用方拿到同一个 id）')
    T.ok(c.id !== a.id, 'Q03 owner 不同 ⇒ **不许**合并（否则 A 卸载会撤掉 B 的作业）')
    T.ok(d.id !== a.id, 'Q03 subject 不同 ⇒ 不合并')
    T.eq(a.state, 'queued', 'Q03 它还在排队（合并只发生在"未开始"时）')
    await cancelRebuild(c.id, 'Q03 撤掉不合并的那条').ended
    await cancelRebuild(d.id, 'Q03 撤掉不合并的那条').ended
    await cancelRebuild(blk.id, 'Q03 放行').ended
    const done = await waitUntil(() => a.done, 8000)
    T.eq(done, true, 'Q03 合并后的那条跑完了')
    seen(a)
    T.eq(a.state, 'succeeded', 'Q03 合并后的作业正常成功')
    T.eq(fs.readFileSync(path.join(FIXTURE, 'q3-slow.done'), 'utf8'), 'done', 'Q03 它确实真跑了一次')
    const e = startRebuild(pack, [SLOW], { subject: 'T16 Q03 合并', scope: s1 })
    seen(e)
    T.ok(e.id !== a.id, 'Q03 已经结束的同一条请求不会再合并到旧作业上')
    T.eq(e.state, 'running', 'Q03 新的那条立刻起来（包已空）')
    await cancelRebuild(e.id, 'Q03 收尾').ended
    await s1.dispose(); await s2.dispose()
    notes.push(`Q03 merged id=${a.id} merged=${a.merged}`)
  })

  await check('Q04', async () => {
    // 全局排队 ≤20：第 21 条回 `busy`（**零 spawn**），且 startScripts 也要能判出 busy
    const log = path.join(FIXTURE, 'q4.log')
    const pa = layPack('q4-a'); const pb = layPack('q4-b'); const pc = layPack('q4-c')
    const HA = writeFx(pa, 'q4.js', srcHangTagged(log, 'q4-a'))
    const HB = writeFx(pb, 'q4.js', srcHangTagged(log, 'q4-b'))
    const HC = writeFx(pc, 'q4.js', srcHangTagged(log, 'q4-c'))
    const blockers = [
      startRebuild(pa, [HA], { subject: 'T16 Q04 占位 A', timeoutMs: 60000 }),
      startRebuild(pb, [HB], { subject: 'T16 Q04 占位 B', timeoutMs: 60000 }),
    ]
    const queued = []
    for (let i = 1; i <= MAX_QUEUE; i++) {
      queued.push(startRebuild(pc, [HC], { subject: `T16 Q04 排队 ${i}`, timeoutMs: 60000 }))
    }
    const busyJob = startRebuild(pc, [HC], { subject: `T16 Q04 第 ${MAX_QUEUE + 1} 条`, timeoutMs: 60000 })
    seen(busyJob)
    T.eq(MAX_QUEUE, 20, 'Q04 卡面：全局排队 ≤20')
    T.eq(queued.filter((j) => j.state === 'queued').length, MAX_QUEUE, `Q04 前 ${MAX_QUEUE} 条必须在排队`)
    T.eq(busyJob.state, 'rejected', 'Q04 满队之后的那条 state=rejected')
    T.eq(busyJob.code, 'busy', 'Q04 code=busy（明确可判）')
    T.eq(busyJob.done, true, 'Q04 busy 回执是**已经结束**的形状（调用方不必再等它）')
    T.eq(busyJob.steps.length, 0, 'Q04 busy 的那条零 spawn（steps 空）')
    T.eq(busyJob.spawned.length, 0, 'Q04 busy 的那条没有任何 pid 记录')
    T.eq(busyJob.rebuild.ok, false, 'Q04 busy 不算成功')
    T.ok(/排队已满/.test(busyJob.warnings.join(' ')), `Q04 告警里要说清是排队满（实得 ${JSON.stringify(busyJob.warnings)}）`)
    const kicked = startScripts(pc, [HC], { subject: `T16 Q04 startScripts 第 ${MAX_QUEUE + 2} 条`, timeoutMs: 60000 })
    T.eq(kicked.busy, true, 'Q04 startScripts 如实报 busy')
    T.ok(kicked.job !== null, 'Q04 满队时 startScripts 回的是 busy 作业（**不是** job:null —— 那是"包里没有脚本"）')
    T.eq(kicked.job.code, 'busy', 'Q04 那条也是 busy')
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    T.eq(lines.length, 2, `Q04 排队的那些一条都没起进程（日志里只有 ${lines.length} 条 START）`)
    const rep = await cancelAllRebuilds(undefined, 'Q04 收尾')
    T.ok(rep.count >= MAX_QUEUE + 2, `Q04 收尾撤掉了 ${rep.count} 条`)
    seen(busyJob)
    T.deep(queued.map((j) => j.state), Array(MAX_QUEUE).fill('cancelled'), 'Q04 排队的那些被排队取消（零 spawn）')
    T.eq(busyJob.state, 'rejected', 'Q04 busy 回执的终态不会被"收尾"改写')
    const left = [...blockers, ...queued].flatMap((j) => j.spawned).map((s) => alivePid(s.pid)).filter((v) => v === true)
    T.deep(left, [], 'Q04 收尾后没有任何残留进程')
  })

  await check('Q05', async () => {
    // 缺件语义**不变**：全缺 → 不起作业（job:null）；部分缺 → 只跑真有的那些并如实列缺
    const all = startScripts(main, [ABSENT], { subject: 'T16 Q05 全缺' })
    T.eq(all.job, null, 'Q05 全缺 ⇒ 不起作业（旧语义，一字不改）')
    T.deep(all.missing, [ABSENT], 'Q05 missing 如实列出')
    T.eq(all.engineError, null, 'Q05 引擎闸没拦（这是"包里没有"，不是"引擎不一致"）')
    T.eq(all.busy, false, 'Q05 这不是 busy')
    const some = startScripts(main, [FX_SLOW, ABSENT], { subject: 'T16 Q05 部分缺' })
    T.ok(some.job !== null, 'Q05 部分缺 ⇒ 起作业（跑真有的那些）')
    T.deep(some.job.scripts, [FX_SLOW], 'Q05 作业里只有包里真有的那条')
    T.deep(some.missing, [ABSENT], 'Q05 缺的那条如实列出来')
    await waitRebuild(some.job.id)
    seen(some.job)
    T.eq(some.job.state, 'succeeded', 'Q05 部分缺的那条照样跑完')
    T.eq(some.job.steps.length, 1, 'Q05 steps 只收真跑的那一条')
    T.eq(some.job.rebuild.ok, true, 'Q05 全绿')
  })

  /* ══════════════ ④ 状态与产品缝（S） ══════════════ */

  await check('S01', async () => {
    // 旧字段语义**一字不变**：跑之前 / 跑之后逐项对
    const job = startRebuild(main, [FX_SLOW], { subject: 'T16 S01', timeoutMs: 20000 })
    seen(job)
    T.eq(job.done, false, 'S01 刚起来 done=false')
    T.eq(job.failed, false, 'S01 刚起来 failed=false')
    T.deep(job.steps, [], 'S01 刚起来 steps=[]')
    T.eq(job.rebuild, null, 'S01 刚起来 rebuild=null')
    T.deep(job.warnings, [], 'S01 刚起来 warnings=[]')
    T.eq(job.index, 0, 'S01 index 指向正在跑的那条')
    T.eq(job.current, FX_SLOW, 'S01 current 就是正在跑的那条')
    await waitRebuild(job.id)
    seen(job)
    T.eq(job.done, true, 'S01 跑完 done=true')
    T.eq(job.current, null, 'S01 跑完 current=null')
    T.eq(job.steps.length, 1, 'S01 steps 收满')
    T.deep(Object.keys(job.steps[0]).sort(), ['code', 'script', 'spawned', 'stderrBytes', 'stdoutBytes', 'tail', 'truncated'], 'S01 step 形状：旧三样（script/code/tail）都在，另加几个只增不减的字段')
    T.eq(job.steps[0].script, FX_SLOW, 'S01 step.script 如实')
    T.eq(job.steps[0].code, 0, 'S01 step.code 如实')
    T.eq(job.rebuild.ok, true, 'S01 rebuild.ok=true')
    T.deep(job.rebuild.failed, [], 'S01 rebuild.failed=[]')
    T.eq(job.failed, false, 'S01 failed=false')
    T.deep(job.warnings, [], 'S01 没有告警')
    T.ok(typeof job.id === 'string' && job.id.startsWith('rb-'), 'S01 作业号形状不变（rb-N）')
  })

  await check('S02', async () => {
    // 同步 / 异步：机器字段与措辞**逐字节对拍**（同一批脚本、同一条链）
    const scripts = [FX_OK, FX_FAIL3, ABSENT]
    const async_ = await rebuildNow(main, scripts, { subject: 'T16 S02' })
    const sync_ = rebuildArtifacts(main, scripts, { subject: 'T16 S02' })
    T.deep(async_.warnings, sync_.warnings, 'S02 warnings 逐字节相同')
    T.deep(async_.rebuild, sync_.rebuild, 'S02 rebuild{ok,failed} 逐字节相同')
    T.eq(async_.steps.length, sync_.steps.length, 'S02 steps 条数相同')
    T.ok(async_.warnings.length >= 1 && /退出码 3/.test(async_.warnings[0]), 'S02 告警里带真实退出码')
    T.ok(async_.warnings[0].includes('T16 S02'), 'S02 告警里带人话主语')
    T.deep(summarize(async_.steps, 'T16 S02').warnings, async_.warnings, 'S02 summarize 就是那一份实现')
    T.deep(async_.rebuild.failed, [FX_FAIL3, ABSENT], 'S02 failed 点名两条（一条退出 3、一条不在包里）')
    T.eq(tailOf('a\nb\nc', ''), 'b ／ c', 'S02 tail 口径不变')
    T.eq(codeOf(null), -1, 'S02 拿不到退出码一律 -1')
    notes.push(`S02 warnings=${JSON.stringify(async_.warnings)}`)
  })

  await check('S03', async () => {
    // **缺脚本 ≠ 空链**：一个是不成功（你要的东西这个包没有），一个是成功（本来就没有要跑的）
    const missing = startRebuild(main, [ABSENT], { subject: 'T16 S03 缺脚本' })
    seen(missing)
    T.eq(missing.state, 'missing-script', 'S03 整条链都不在包里 ⇒ state=missing-script')
    T.eq(missing.done, true, 'S03 它立刻就是"结束了"（不起进程，没什么好等的）')
    T.eq(missing.steps.length, 0, 'S03 steps 空')
    T.eq(missing.spawned.length, 0, 'S03 **零 spawn**（一个 pid 都没有）')
    T.deep(missing.missing, [ABSENT], 'S03 missing 如实列出')
    T.eq(missing.rebuild.ok, false, 'S03 缺脚本**不是**成功')
    T.eq(missing.failed, true, 'S03 failed=true')
    const empty = await rebuildNow(main, [], { subject: 'T16 S03 空链' })
    T.eq(empty.steps.length, 0, 'S03 空链不炸')
    T.eq(empty.rebuild.ok, true, 'S03 **空链是成功的**（旧语义：没有失败项）')
    T.eq(empty.warnings.length, 0, 'S03 空链没有告警')
    const emptyJob = startRebuild(main, [], { subject: 'T16 S03 空链句柄' })
    seen(emptyJob)
    T.eq(emptyJob.state, 'succeeded', 'S03 空链的 state=succeeded')
    T.ok(missing.rebuild.ok !== emptyJob.rebuild.ok, 'S03 两者**不许**混成一种结局')
    T.ok(missing.id !== emptyJob.id, 'S03 两条作业各有自己的号')
  })

  await check('S04', async () => {
    // 机器失败状态：非零退出 → failed（不是 timed-out / cancelled）
    const job = startRebuild(main, [FX_FAIL3], { subject: 'T16 S04', timeoutMs: 20000 })
    await waitRebuild(job.id)
    seen(job)
    T.eq(job.state, 'failed', 'S04 非零退出 ⇒ state=failed')
    T.eq(job.steps[0].code, 3, 'S04 退出码如实（3）')
    T.eq(job.rebuild.ok, false, 'S04 rebuild.ok=false')
    T.deep(job.rebuild.failed, [FX_FAIL3], 'S04 failed 点名那一条')
    T.eq(job.truncated, false, 'S04 没有截断')
    T.eq(job.done, true, 'S04 done=true')
    T.ok(/退出码 3/.test(job.warnings[0]), 'S04 告警措辞与同步版同源')
  })

  /* ══════════════ ⑤ 产品缝：真插件装载 + 真重建链（S05-S07） ══════════════ */

  /**
   * 假宿主（T13 同型）：只造本卡要的那几样 —— tools.register / effect / inject(connection)。
   * 关键点：**不传 `trustedEngine:false`** —— 下面这个包是用产品自己的 `writeScaffold`
   * 建出来的**真课程包**（引擎件逐字节 = 插件模板），所以走的是**严格**闸（W03 会正面证它）。
   */
  function installPlugin(root) {
    const tools = new Map(); const routes = new Map(); const rootEffects = []; const logs = []
    const effect = (list) => (fn) => { const off = fn(); if (typeof off === 'function') list.push(off); return off }
    const ctx = {
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`W ${m}`), error: (m) => logs.push(`E ${m}`) },
      tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
      effect: effect(rootEffects),
      inject(names, cb) {
        const i = { names, effects: [], disposed: false, delivered: false }
        i.dispose = () => { i.disposed = true; return Promise.all(i.effects.splice(0).reverse().map((f) => f())) }
        i.deliver = (service) => {
          i.delivered = true
          return cb({
            effect: effect(i.effects),
            get() {
              if (names[0] !== 'connection') return service ?? {}
              return { fetch: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } } }
            },
          })
        }
        if (names[0] === 'connection') i.deliver()   // 建圈 / 建点 / 重建查询口都要它
        return { dispose: i.dispose }
      },
    }
    apply(ctx, { packRoot: root, installPreset: false, announceOnBoot: false, dataDir: path.join(FIXTURE, 'data') })
    return { tools, routes, rootEffects, logs, unload: async () => { while (rootEffects.length) await rootEffects.pop()() } }
  }
  const post = (route, url, body) => route.fetch(new Request(`http://127.0.0.1:3090${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).then((r) => r.json())
  const get = (route, url) => route.fetch(new Request(`http://127.0.0.1:3090${url}`, { method: 'GET' })).then((r) => r.json())

  const packDir = path.join(FIXTURE, 'scaffold')
  fs.mkdirSync(packDir, { recursive: true })
  const sc = writeScaffold(packDir)
  T.eq(sc.ok, true, `S05 夹具前提：产品自己的 writeScaffold 能建出课程包（${sc.error || 'ok'}）`)
  fs.mkdirSync(path.join(packDir, 'fx'), { recursive: true })
  const SFX_FAIL3 = writeFx(packDir, 'fail3.js', srcExit(3))
  const host = installPlugin(packDir)
  const routeCircle = host.routes.get('/api/whale/circle')
  const routePoint = host.routes.get('/api/whale/point')
  const routeRebuild = host.routes.get('/api/whale/rebuild')
  T.ok(!!routeCircle && !!routePoint && !!routeRebuild, 'S05 夹具前提：建圈 / 建点 / 重建查询口都挂上了')

  await check('S05', async () => {
    // 公开投影：**内部句柄 → 公开投影 → 旧字段**必须是同一份事实（且内部字段一个都不许漏出去）
    const job = startRebuild(packDir, [SFX_FAIL3], { subject: 'T16 S05' })
    await waitRebuild(job.id)
    seen(job)
    const q = await get(routeRebuild, `/api/whale/rebuild?id=${job.id}`)
    T.eq(q.ok, true, 'S05 查询口回 ok:true')
    const pj = q.job
    T.ok(!!pj, 'S05 查得到这条作业')
    T.eq(pj.state, job.state, 'S05 公开 state = 内部 state（同一份事实）')
    T.eq(pj.truncated, job.truncated, 'S05 公开 truncated = 内部 truncated')
    T.eq(pj.done, job.done, 'S05 done 一致')
    T.eq(pj.failed, job.failed, 'S05 failed 一致')
    T.deep(pj.rebuild, job.rebuild, 'S05 rebuild 一致')
    T.deep(pj.warnings, job.warnings, 'S05 warnings 一致')
    T.deep(pj.scripts, job.scripts, 'S05 scripts 一致')
    T.eq(pj.total, job.scripts.length, 'S05 旧字段 total 还在（前端在用它）')
    T.eq(pj.index, job.index, 'S05 index 一致')
    T.eq(pj.current, job.current, 'S05 current 一致')
    T.eq(pj.stdoutTail, job.stdoutTail, 'S05 环形尾部也投影出来（显示 truncated 时要用）')
    T.deep(pj.steps[0], { script: SFX_FAIL3, code: 3, tail: job.steps[0].tail, truncated: false }, 'S05 step 投影：旧三样 + truncated，一个都不少')
    T.ok(!('root' in pj), 'S05 响应里**没有 root**（本机绝对路径不该出去）')
    for (const priv of ['_waiters', '_child', '_out', '_err', 'mergeKey', 'owner', 'ownerKey', 'spawned', 'tree']) {
      T.ok(!(priv in pj), `S05 内部字段 ${priv} 不许出现在公开投影里`)
    }
    const list = await get(routeRebuild, '/api/whale/rebuild')
    T.ok(Array.isArray(list.jobs) && list.jobs.some((j) => j.id === job.id), 'S05 不传 id 时列得出它')
    T.ok(list.jobs.every((j) => PUBLIC_STATES.includes(j.state)), 'S05 列表里每条都有合法的公开 state')
    notes.push(`S05 public=${JSON.stringify({ state: pj.state, code: pj.code, truncated: pj.truncated, missing: pj.missing })}`)
  })

  await check('S06', async () => {
    // `whale_author` 那条入口：owner = 插件作用域（与建圈那条同源），取消后进程树与作业都结束
    const c1 = await post(routeCircle, '/api/whale/circle', { id: 'math', name: '数学' })
    T.eq(c1.ok, true, `S06 前置：建圈 ${c1.error || 'ok'}`)
    const jobC1 = getRebuild(c1.rebuild.jobId)
    T.ok(!!jobC1, 'S06 前置：建圈那条重建作业在表里')
    const c1Owner = jobC1.owner
    T.ok(!!c1Owner && typeof c1Owner.add === 'function', 'S06 建圈那条作业的 owner 是插件作用域（资源作用域）')
    await cancelRebuild(jobC1.id, 'S06 前置收尾').ended
    const p1 = await post(routePoint, '/api/whale/point', { circle: 'math', id: 'vue', name: 'Vue' })
    T.eq(p1.ok, true, `S06 前置：建点 ${p1.error || 'ok'}`)
    await cancelRebuild(p1.rebuild.jobId, 'S06 前置收尾').ended
    const plan = host.tools.get('whale_plan')
    const author = host.tools.get('whale_author')
    T.ok(!!plan && !!author, 'S06 前置：whale_plan / whale_author 都注册上了')
    const vp = await plan.execute({
      op: 'record', point: 'math/vue',
      goal: '把 vue 点建出来并挂上地图（S06 的夹具前提，不是判据）',
      nodes: [{
        no: 1, title: '探针课', deliverable: '一个建得出来的探针课页', criteria: 'whale_author commit:true 能落盘',
        why: '它证明「建课程」这条入口的重建接线是通的', sources: [{ label: '夹具出处（手写声明）', url: 'https://example.invalid/t16' }],
      }],
    })
    T.eq(vp.ok, true, `S06 前置：地图记上了 ${vp.error || 'ok'}`)
    const v = await author.execute({
      point: 'vue', halo: 'math', number: 1, title: '探针课', slug: 'probe', hintTerm: '示波器',
      source: { label: '夹具', url: 'https://example.invalid/t16' }, commit: true, force: true,
    })
    T.eq(v.wrote, true, `S06 课程文件写出（${v.error || 'ok'}）`)
    T.deep(v.rebuild.scripts, ['tools/build-lessons.js', 'tools/build-starmap.js'], 'S06 建课程的重建链 = 两条')
    const jobA = getRebuild(v.rebuild.jobId)
    T.ok(!!jobA, 'S06 建课程那条重建作业在表里')
    seen(jobA)
    T.eq(jobA.owner, c1Owner, 'S06 建课程那条的 owner **就是**插件作用域（和建圈那条同一个对象）')
    T.ok(jobA.runStartedAt !== undefined, 'S06 它是真开跑了（不是排在队里）')
    const caught = await catchLiveChild(jobA)
    T.eq(caught.ok, true, `S06 夹具前提：抓到一条"正在跑"的真子进程（已记 ${jobA.spawned.length} 个）`)
    const pid = caught.pid
    observe('S06-before', pid, { jobState: jobA.state, spawned: jobA.spawned.length })
    const rec = cancelRebuild(jobA.id, 'S06 取消建课程的重建')
    const ended = await rec.ended
    seen(jobA)
    T.eq(jobA.state, 'cancelled', 'S06 取消后 state=cancelled')
    T.eq(jobA.done, true, 'S06 取消后 done=true（树确认之后）')
    T.eq(ended.treeGone, true, 'S06 树确认消失')
    observe('S06-after', pid, { tree: jobA.tree.pids, taskkillRaw: jobA.tree.raw })
    T.eq(alivePid(pid), false, `S06 该作业的子进程 ${pid} 没了`)
    notes.push(`S06 author job=${jobA.id} scripts=${JSON.stringify(jobA.scripts)} tree=${JSON.stringify(jobA.tree)}`
      + '（注：这条判的是**接线**；"撤一棵活着的真进程树"由 B04/B05/C01/C03/C04 的挂住夹具正面证明）')
  })

  await check('S07', async () => {
    // 插件卸载：建圈那条**真链条**（7 条真脚本）起在真进程上，unload 之后作业与进程树都结束
    const c2 = await post(routeCircle, '/api/whale/circle', { id: 'physics', name: '物理' })
    T.eq(c2.ok, true, `S07 建第二个圈 ${c2.error || 'ok'}`)
    const job = getRebuild(c2.rebuild.jobId)
    T.ok(!!job, 'S07 作业在表里')
    seen(job)
    T.eq(job.state, 'running', 'S07 它一建完就开跑（真链条）')
    T.deep(job.scripts, ['tools/circle-bands.js', 'tools/build-lessons.js', 'tools/build-starmap.js', 'tools/build-starmap-svg.js', 'assets/build-glossary.js', 'tools/build-glossary-tree.js', 'tools/build-notes.js'], 'S07 真链条七条')
    const owner = job.owner
    // 真链条每一步都是短命进程（circle-bands 几十毫秒就跑完）——**抓一个"此刻还活着"的**再卸载，
    // 否则这条用例只是在"卸载一个已经结束的作业"，判不出撤树。
    const caught = await catchLiveChild(job)
    T.eq(caught.ok, true, 'S07 夹具前提：抓到一个"正在跑"的真子进程（真链条的某一步）')
    const pid = caught.pid
    observe('S07-before', pid, { jobState: job.state, spawned: job.spawned.length })
    const jobsBefore = listRebuilds().filter((j) => !j.done).length
    T.eq(jobsBefore >= 1, true, `S07 卸载前还有 ${jobsBefore} 条作业没结束`)
    const t0 = Date.now()
    await host.unload()
    const unloadMs = Date.now() - t0
    seen(job)
    T.eq(job.state, 'cancelled', 'S07 卸载之后作业 state=cancelled（不是 succeeded）')
    T.eq(job.done, true, 'S07 卸载返回时它已经 done（"等"，不是"喊"）')
    T.ok(job.tree && job.tree.gone === true, 'S07 卸载返回时进程树已确认消失')
    observe('S07-after', pid, { tree: job.tree.pids, taskkillRaw: job.tree.raw, unloadMs })
    T.eq(alivePid(pid), false, `S07 卸载之后子进程 ${pid} 没了`)
    T.eq(tasklistLine(pid).includes('No tasks'), true, `S07 tasklist 也看不到它（${tasklistLine(pid)}）`)
    const stillOpen = listRebuilds().filter((j) => !j.done)
    T.deep(stillOpen.map((j) => `${j.id}:${j.state}`), [], 'S07 卸载之后**没有**任何还在跑/排队的作业')
    T.ok(owner && owner.disposed === true, 'S07 那个 owner（插件作用域）确实已经倒掉')
    T.ok(unloadMs <= 5000, `S07 卸载在 5 秒内结束（实得 ${unloadMs}ms）`)
    notes.push(`S07 unloadMs=${unloadMs} jobsBefore=${jobsBefore} tree=${JSON.stringify(job.tree)}`
      + '（注：这条判的是**卸载接线**；真链条的每一步都太短命，撤树多半落在"它刚好自己退了"那一侧 ——'
      + ' taskkill 那条 raw/note 就是当时的事实。撤**活着的**树由 B04/B05/C01/C03/C04 正面证明）')
  })

  /* ══════════════ ⑥ 边界（W） ══════════════ */

  await check('W01', async () => {
    // 同步路径（答疑 / 笔记写回那条 spawnSync）也必须**有界**：永不退出的脚本不许把响应拖死
    fs.rmSync(MAIN_PID, { force: true })
    const t0 = Date.now()
    const sync = rebuildArtifacts(main, [FX_HANG], { subject: 'T16 W01', timeoutMs: 1200 })
    const ms = Date.now() - t0
    const pid = Number(fs.readFileSync(MAIN_PID, 'utf8'))
    T.ok(ms <= 6000, `W01 同步路径必须自己回来（实得 ${ms}ms，脚本是永不退出的）`)
    T.eq(sync.steps.length, 1, 'W01 steps 如实收入那一条')
    T.eq(sync.steps[0].code, -1, `W01 被掐掉 ⇒ 拿不到退出码，如实记 -1（实得 ${sync.steps[0].code}）`)
    T.eq(sync.rebuild.ok, false, 'W01 不许假装成功')
    T.ok(/超时|ETIMEDOUT/.test(sync.steps[0].tail), `W01 尾巴里要说清是超时（实得 ${JSON.stringify(sync.steps[0].tail)}）`)
    T.eq(alivePid(pid), false, `W01 被掐掉的那个 pid=${pid} 已经没了`)
    notes.push(`W01 ms=${ms} code=${sync.steps[0].code} tail=${JSON.stringify(sync.steps[0].tail)}`)
  })

  await check('W02', async () => {
    // **只终止自己持有的 PID 树**：别人（本测试自己起的、没经过作业制的）进程必须毫发无损
    const otherPidFile = path.join(FIXTURE, 'w02-other.txt')
    fs.rmSync(otherPidFile, { force: true })
    const otherSrc = path.join(FIXTURE, 'w02-other.js')
    fs.writeFileSync(otherSrc, srcHang(otherPidFile), 'utf8')
    const otherChild = spawn(process.execPath, [otherSrc], { stdio: 'ignore' })
    await waitUntil(() => fs.existsSync(otherPidFile), 5000)
    const otherPid = Number(fs.readFileSync(otherPidFile, 'utf8'))
    T.eq(otherChild.pid, otherPid, 'W02 夹具前提：我们自己起的那个"别人"就是它')
    const pids = path.join(FIXTURE, 'w02-pids.json')
    fs.rmSync(pids, { force: true })
    const FX = writeFx(main, 'w02-own.js', srcHangTree(pids, path.join(FIXTURE, 'w02-own.beat')))
    const job = startRebuild(main, [FX], { subject: 'T16 W02', timeoutMs: 60000 })
    const wrote = await waitUntil(() => fs.existsSync(pids), 5000)
    T.eq(wrote, true, 'W02 夹具前提：作业那条链真的起了进程（pid 落盘了）')
    const own = JSON.parse(fs.readFileSync(pids, 'utf8'))
    observe('W02-before', otherPid, { role: '别人（不经作业制）' })
    const ended = await cancelRebuild(job.id, 'W02 撤自己的树').ended
    T.eq(ended.treeGone, true, 'W02 自己那棵树确认消失')
    T.eq(alivePid(own.self), false, 'W02 自己的子进程没了')
    T.eq(alivePid(own.grand), false, 'W02 自己的孙进程没了')
    T.eq(alivePid(otherPid), true, 'W02 **别人的进程毫发无损**（只杀自己 spawn 的那一棵）')
    T.ok(!job.tree.pids.includes(otherPid), `W02 撤树的 pid 集合里绝不许有别人（${JSON.stringify(job.tree.pids)} vs ${otherPid}）`)
    T.ok(!job.tree.pids.includes(process.pid), 'W02 也不许把我们自己算进去')
    observe('W02-after', otherPid, { role: '别人（不经作业制）', ownTree: job.tree.pids })
    try { otherChild.kill('SIGKILL') } catch { /* 已经退了 */ }
    await waitUntil(() => !alivePid(otherPid), 5000)
    T.eq(alivePid(otherPid), false, 'W02 收尾：那个"别人"由**测试自己**收掉（作业制没碰它）')
  })

  await check('W03', async () => {
    // **真引擎闭包**（不需要 T16-A1 那一行旁路）：夹具跑在逐字节的模板包上，闸是真的严
    const gateOk = verifyEngineForScripts(main, [FX_OK, FX_FLOOD, FX_HANG_TREE])
    T.eq(gateOk.ok, true, 'W03 夹具包过**严格**引擎闸（所以 T16 一个旁路都不用传）')
    const src = fs.readFileSync(path.join(REPO, 'test/audit/T16.mjs'), 'utf8')
    const codeLines = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    // ⚠️ 只认"传参"那种写法（带冒号）；本文件自己的判词文案里提到这个开关**不算**传参
    const passingFalse = codeLines.filter((l) => /trustedEngine\s*:\s*false/.test(l))
    T.deep(passingFalse, [], 'W03 T16 自己一个旁路都没传（不必进 T04 的旁路清单）')
    // 反证（负向对照）：真的把引擎字节改一个 ⇒ 必须被拒、**零 spawn**
    const tampered = path.join(FIXTURE, 'w03-tampered')
    fs.cpSync(main, tampered, { recursive: true })
    fs.appendFileSync(path.join(tampered, 'tools', 'build-notes.js'), '\n// T16 W03：故意改一个引擎字节\n', 'utf8')
    fs.rmSync(MAIN_MARKER, { force: true })
    const job = startRebuild(tampered, [FX_OK], { subject: 'T16 W03 被改过的包' })
    seen(job)
    T.eq(job.state, 'failed', 'W03 引擎不一致 ⇒ 作业是失败的')
    T.eq(job.code, 'engine-blocked', 'W03 机器码 engine-blocked')
    T.eq(job.steps.length, 0, 'W03 **零 spawn**')
    T.eq(job.engineMismatched.includes('tools/build-notes.js'), true, `W03 要点名是 build-notes.js 不一致（实得 ${JSON.stringify(job.engineMismatched)}）`)
    T.eq(fs.existsSync(MAIN_MARKER), false, 'W03 标记文件不存在（闸真的拦住了，没跑那条脚本）')
    T.ok(/不一致/.test(job.engineError || ''), 'W03 engineError 带人话')
  })

  await check('V01', async () => {
    // 收口：公开 state 全集 —— 七种都要**真的出现过**，且一个不许越界
    const want = ['queued', 'running', 'succeeded', 'failed', 'timed-out', 'cancelled', 'missing-script']
    const got = [...seenStates].sort()
    const missing = want.filter((s) => !seenStates.has(s))
    T.deep(missing, [], `V01 七种状态都要真的出现过（缺 ${JSON.stringify(missing)}）`)
    T.deep(got.filter((s) => !PUBLIC_STATES.includes(s)), [], 'V01 不许出现 PUBLIC_STATES 之外的 state')
    T.deep([...PUBLIC_STATES].sort(), [...PUBLIC_STATES].sort(), 'V01 PUBLIC_STATES 是那份全集')
    T.eq(new Set(PUBLIC_STATES).size, PUBLIC_STATES.length, 'V01 PUBLIC_STATES 里没有重复项')
    T.deep(want.filter((s) => !PUBLIC_STATES.includes(s)), [], 'V01 卡面点名的七种都在 PUBLIC_STATES 里')
    T.ok(PUBLIC_STATES.includes('rejected'), 'V01 满队回执的 rejected 也在册（Q04 量过它）')
    T.ok(seenStates.has('rejected'), 'V01 rejected 真的出现过（Q04）')
    T.eq(DEFAULT_MAX_OUTPUT_BYTES, 65536, 'V01 卡面：环形尾部 64KiB')
    T.eq(DEFAULT_TIMEOUT_MS, 60000, 'V01 卡面：超时缺省 60s')
    const live = listRebuilds().filter((j) => !j.done).map((j) => `${j.id}:${j.state}`)
    T.deep(live, [], 'V01 收口时不许还有没结束的作业')
    notes.push(`V01 见过的 state：${got.join('、')}`)
  })
} catch (e) {
  fatal = e && e.stack ? e.stack : String(e)
} finally {
  // —— 收尾：撤掉一切、确认没有挂住的子进程（**先撤再查**）——
  try {
    await cancelAllRebuilds(undefined, 'T16 收尾')
  } catch (e) {
    if (!fatal) fatal = `收尾撤作业失败：${e?.message ?? e}`
  }
  const spawned = [...listRebuilds()].flatMap((j) => j.spawned || []).map((s) => s.pid)
  for (const p of spawned) allSpawned.add(p)
  const alive = [...allSpawned].filter((p) => alivePid(p))
  if (alive.length) {
    for (const p of alive) { try { spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { encoding: 'utf8' }) } catch { /* 尽力 */ } }
    const still = alive.filter((p) => alivePid(p))
    if (still.length) fatal = `${fatal ? fatal + '；' : ''}收尾后仍有挂住的子进程：${still.join('、')}`
  }
  notes.push(`收尾：作业表 ${listRebuilds().length} 条，本次起过的 pid ${allSpawned.size} 个，撤完仍活着的 ${alive.length} 个`)
}

/* ── 判词 + 证据 ─────────────────────────────────────────────────────── */

const idsGot = records.map((r) => r.id)
if (JSON.stringify(idsGot) !== JSON.stringify(IDS)) fatal ??= `固定用例 ID 全集漂移：期望 ${IDS.join(',')}，实得 ${idsGot.join(',')}`
if (cleanupFailures.length) fatal = `${fatal ? fatal + '；' : ''}用例收尾失败：${cleanupFailures.join('；')}`
const failed = records.filter((r) => r.status === 'fail').length + (fatal ? 1 : 0)
const automated = process.argv.includes('--automated-only')
const verdict = failed ? 'FAIL' : automated ? 'PASS' : 'BLOCKED'
const label = automated ? 'T16-AUTO' : 'T16'
const exitCode = failed ? 1 : automated ? 0 : 2

const FILES = ['lib/rebuild-job.js', 'lib/mods/create.js', 'lib/mods/author.js', 'lib/index.js', 'lib/ask-io.js', 'test/audit/T16.mjs']
const hashes = Object.fromEntries(FILES.map((f) => {
  const abs = path.join(REPO, ...f.split('/'))
  return [f, fs.existsSync(abs) ? createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : null]
}))

const result = {
  verdict,
  label,
  exitCode,
  card: 'T16',
  cardCommand: 'node E:/workplace/dsh-whale-sensei/test/audit/T16.mjs',
  ids: IDS,
  records,
  notes,
  pidObservations,
  seenStates: [...seenStates].sort(),
  publicStates: PUBLIC_STATES,
  fatal,
  fixture: FIXTURE,
  hashes,
  // ⚠️ 真实 DSH 宿主侧的作业撤回证据：**本机拿不到**（T13 已实证：没有可验证的隔离装卸入口）。
  //    这不是"过了"，是**没验** —— 所以默认入口收 BLOCKED（exit2），只有 --automated-only 才 PASS。
  realHost: {
    status: 'unverified',
    reason: 'No verifiable isolated DSH load/unload entry on this machine (T13 evidence: audit-evidence/B5/host-lifecycle-research.md). '
      + '本卡自动部分用的是**真实 OS 进程树**（真 spawn / 真 taskkill / 真 tasklist），但那不等于"真实宿主已经验过卸载"。',
  },
}
try {
  fs.writeFileSync(path.join(EVIDENCE, `run-${STAMP}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(EVIDENCE, `cases-${STAMP}.txt`), '\uFEFF' + [
    `${verdict} ${label}（固定用例 ${IDS.length} 条）`,
    '',
    ...records.map((r) => r.status === 'pass' ? `ok   ${r.id}` : `FAIL ${r.id}${LS}${r.error}`),
    '',
    ...(fatal ? ['FATAL', fatal, ''] : []),
    '—— 逐条备注 ——',
    ...notes.map((n) => `· ${n}`),
    '',
    '—— 原始 PID 观测（pid,alive + tasklist 原始行）——',
    ...pidObservations.map((o) => `${o.atIso} ${o.tag} pid=${o.pid} alive=${o.alive} tasklist=${JSON.stringify(o.tasklist)}${o.taskkillRaw ? ` raw=${JSON.stringify(o.taskkillRaw)}` : ''}`),
    '',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(EVIDENCE, `pids-${STAMP}.json`), `${JSON.stringify(pidObservations, null, 2)}\n`, 'utf8')
} catch (e) {
  process.stderr.write(`证据落盘失败：${e?.message ?? e}\n`)
  process.exit(1)
}

// 失败留夹具以便诊断；全绿才删（删前核实绝对路径确实属于本次夹具）
if (!failed) {
  const abs = path.resolve(FIXTURE)
  if (path.dirname(abs) !== path.resolve(TMP_BASE) || !path.basename(abs).startsWith('whale-T16-')) {
    process.stdout.write(`FAIL ${label} checks=${records.length} failed=${failed + 1} skipped=0（拒绝清理不属于本次夹具的路径）\n`)
    process.exit(1)
  }
  fs.rmSync(abs, { recursive: true, force: true })
}

process.stdout.write(`${verdict} ${label} checks=${records.length} failed=${failed} skipped=0${!failed && !automated ? ' final-real-host-evidence-missing' : ''}\n`)
process.exit(exitCode)
