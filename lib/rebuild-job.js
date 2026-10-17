/**
 * lib/rebuild-job.js — 异步重建器（有界资源 / 按包 FIFO / 可取消，T16）
 * ------------------------------------------------------------------
 * 为什么另开一台、而不直接复用 rebuildArtifacts：
 *   它是 `spawnSync` 的（ask-io.js:267-269），直接调用会卡住这次 HTTP 响应。
 *   答疑（3 条）与笔记（2 条）那两位调用方串的脚本少，忍得住；
 *   但「建圈」那串是 **5 条清单、实际 6 个 node 进程**（build-lessons 内部还会再拉一次星图），
 *   同步跑完学生要干等十几秒才看到页面 —— 这与「圈立刻可见、星图几秒后追上」直接冲突。
 *
 * 判据（与同步版**逐字一致**，不许漂）：
 *   steps[] = { script, code, tail }；code = 进程退出码，拿不到就是 -1
 *   rebuild = { ok, failed[] }；warnings[] 的措辞见 summarize()
 *
 * ⚠️ 这是一份**同源双实现**（对面是 ask-io.js 的 runScript + rebuildArtifacts）：
 *   ask-io.js 的铁律是「**不 import 其它 lib/*.js**」（见该文件 :11），
 *   所以这里**不能**把 summarize 共享过去 —— 按本仓的规矩，双实现必须配一条对拍：
 *   `test/rebuild-job.mjs` 的 ④ 直接跑同一批脚本，断言两份产出的
 *   warnings / rebuild **逐字节相同**。改任何一边的措辞，那条对拍当场红。
 *   改这里的 tail 口径时，同步改 ask-io.js 的 runScript（两边注释互指）。
 *
 * # T16：作业是**有界**的资源（这一节是 2026-10-17 加的，报告 D07 + A01）
 *
 * 旧实现有三个"无界"的口子，全都在同一个方向上：作业只活在内存里、没人管它有多大、多久、几个：
 *   ① **几个包能同时跑**没有上限 —— 学生连点几下建圈，就是十几棵 node 进程同时在写同一批产物；
 *   ② **输出无上限** —— 一个「无限打印」的包脚本（或一个死循环 dump）能把宿主内存吃光；
 *   ③ **永不退出**的脚本没人掐 —— 那个作业永远 `done:false`，进程也永远留着；
 *      插件卸载时更是**一个进程都不撤**（作业表在模块级，宿主重载只换一张表）。
 *
 * 现在这三条都有界，而且边界是**可判**的（不是"注释里写着"）：
 *   · `MAX_RUNNING = 2` 个**包**同时在跑；每个包一条 **FIFO**（同包不并发，顺序不乱）；
 *   · 全局排队 `MAX_QUEUE = 20`，满了回 `busy`（**零 spawn**，绝不"先排上再说"）；
 *   · 相同**运行请求**（同 owner + 同 root + 同脚本序列 + 同 subject）在**还没开始**时合并成一条；
 *   · stdout / stderr **各自**一个 `maxOutputBytes`（缺省 64KiB）的**环形尾部**，超限置 `truncated:true`；
 *     ⚠️ 截断**不是成功**：退出码照样如实、`rebuild.ok` 照样按退出码判（卡面 outOfScope 明写）；
 *   · `timeoutMs`（缺省 60s，从**开跑**那一刻算）到点先记 `timed-out`，再撤进程树；
 *   · `cancelRebuild(id, reason)` / `cancelAllRebuilds(owner)`：先记 `cancelled`，再撤进程树，
 *     **并等**它真的消失（≤5s）才把作业标成 `done` —— 所以 `await waitRebuild(id)` 之后，
 *     "作业结束"与"它的进程没了"是同一件事（T16 卡面：「卸载后子进程与作业均结束」）。
 *
 * 公开 state（**这一条是接口**，别自己加值）：
 *   `queued → running → succeeded | failed | timed-out | cancelled`；
 *   缺脚本（整条链一个都不在包里）→ `missing-script`（**零 spawn**，且**空链 ≠ 缺脚本**：
 *   `startRebuild(root, [])` 仍然是"成功、steps 空、没有告警"）；
 *   满队回执是 `rejected`（`code:'busy'`，它不是一条跑过的作业）；
 *   引擎闸拒掉的是 `failed`（`code:'engine-blocked'`，带 `engineError`）。
 *   旧字段 `done` / `failed` / `steps` / `warnings` / `rebuild` / `index` / `current` **语义一字不变**。
 *
 * 边界（说清，别当它是调度器）：
 *   作业只活在**当前进程**里，宿主重启即丢；没有持久化、没有跨进程查询。
 *   够用即可 —— 它的用途是"这一次请求别阻塞"，不是"长期任务队列"（卡面 outOfScope）。
 *
 * ⚠️ **执行前先核验受信引擎**（T04 / 报告 D01，证据行号就是本文件 :75-L96 的 `runAsync`）：
 *   `spawn(process.execPath, [脚本])` 执行的是**课程包里可写的那份代码** —— 换掉一个字节，
 *   宿主下一次重建就跑别人的代码。所以 spawn **之前**两道闸：
 *     ① 每个脚本路径先过**共享路径边界**（T03 的 `tools/path-policy.cjs`，全仓只此一份实现）；
 *     ② 这个包的引擎闭包必须与**插件模板**逐字节一致（`lib/engine.js` 的 `verifyEngine`）。
 *   任一条不过 → **零 spawn**，如实回执（`engineError`），绝不"起了再说"。
 *   ⚠️ 这是**引擎一致性核验**，不是任意数据沙箱：学生自己的课 / 笔记 / 代码不在清单里。
 *
 * ⚠️ **只杀自己那棵树**（T16 卡面：「Windows 只终止自己持有的 PID 树」）：
 *   撤作业时用的 pid **只可能来自本次 `spawn` 的返回值**，而且必须先证明"这个句柄还活着"
 *   （`exitCode === null && signalCode === null`）—— Node 持有进程句柄期间，Windows 不会把这个
 *   PID 回收给别人 ⇒ 那一刻这个编号**就是我们那个子进程**。绝不拿别处来的/用户给的编号去 `/T`。
 */
import { runAsync, spawnFailureHint, runSync } from './exec.js'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { trustedManifest, verifyEngine, engineVerdict } from './engine.js'
import { TEMPLATE_DIR } from './pack-scaffold.js'

const requireCJS = createRequire(import.meta.url)
/** 共享路径策略（T03）—— 全仓**只此一份**实现，这里只借用，不重写 */
const pathPolicy = requireCJS(path.join(TEMPLATE_DIR, 'tools', 'path-policy.cjs'))

/** 保留最近多少个作业（防无界增长；被裁掉的是最老的**已完成**作业） */
const KEEP = 20
/** 最多几个**包**同时在跑（T16 卡面：最多 2 包并行） */
export const MAX_RUNNING = 2
/** 全局排队上限（不含正在跑的）—— 满了回 `busy`，**零 spawn**（T16 卡面：全局排队 ≤20） */
export const MAX_QUEUE = 20
/** 作业超时缺省值：从**开跑**那一刻算，不是从入队算（排队不该被算进超时） */
export const DEFAULT_TIMEOUT_MS = 60000
/** stdout / stderr **各自**的环形尾部上限（T16 卡面：各保留 64KiB 尾部） */
export const DEFAULT_MAX_OUTPUT_BYTES = 65536
/** 撤进程树之后，等它真的消失的上限（T16 卡面：5 秒内确认） */
export const TREE_CONFIRM_MS = 5000
/** 公开 state 的全集（含"满队回执"的 rejected 与"整条链都不在包里"的 missing-script） */
export const PUBLIC_STATES = ['queued', 'running', 'succeeded', 'failed', 'timed-out', 'cancelled', 'missing-script', 'rejected']

/** 正在跑 / 排队中 / 最近跑过的作业表（只活在当前进程里） */
const JOBS = new Map()
/** 全局**进队顺序**（谁能跑由 pump() 按"包"判，见 MAX_RUNNING 那段注释） */
const QUEUE = []
/** 正在跑的作业 id（≤ MAX_RUNNING 个**包**） */
const running = new Set()
let seq = 0

/** owner（`opts.scope`）→ 稳定令牌：合并键与 cancelAllRebuilds 都认它 */
const OWNER_KEYS = new WeakMap()
let ownerSeq = 0
/** 已经往某个 scope 上挂过"卸载即撤作业"的（每个 scope 只挂一次） */
const BOUND_SCOPES = new WeakSet()

/**
 * owner 的稳定令牌。
 * 对象用 `WeakMap` 记账（不会拦住 GC）；字符串原样带前缀（也允许直接拿字符串当 owner）。
 * @param {any} owner
 */
function ownerKey(owner) {
  if (owner === undefined || owner === null) return 'none'
  if (typeof owner === 'string' || typeof owner === 'number') return `s:${String(owner)}`
  if (typeof owner === 'object' || typeof owner === 'function') {
    let k = OWNER_KEYS.get(owner)
    if (!k) { k = `o:${++ownerSeq}`; OWNER_KEYS.set(owner, k) }
    return k
  }
  return `x:${String(owner)}`
}

/** `maxOutputBytes` / `timeoutMs` 的归一化（垃圾值一律落回缺省，不静默变成 0） */
function normBytes(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return v === 0 ? 0 : DEFAULT_MAX_OUTPUT_BYTES
  return Math.floor(n)
}
function normTimeout(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.floor(n)
}

/**
 * 脚本路径的**字面**边界 —— 复用 T03 共享策略里那两个"同一套口径"的小工具
 * （`looksAbsolute` / `isInside`），**不另写一份规则**：
 *   绝对路径 / 盘符 / UNC、反斜杠、`..`、空段之外的控制字符 —— 一律拒。
 * @param {string} script
 * @returns {{ok:true, rel:string}|{ok:false, error:string}}
 */
export function checkScriptPath(script) {
  const s = String(script ?? '')
  if (!s) return { ok: false, error: '脚本路径是空的' }
  if (pathPolicy.looksAbsolute(s)) return { ok: false, error: `脚本路径是绝对路径：${JSON.stringify(s)}` }
  if (s.includes('\\')) return { ok: false, error: `脚本路径里有反斜杠（一律用 /）：${JSON.stringify(s)}` }
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, error: '脚本路径里有控制字符（含 NUL）—— 拒绝' }
  if (s.split('/').some((seg) => seg === '..')) return { ok: false, error: `脚本路径带 ..（目录穿越）：${JSON.stringify(s)}` }
  return { ok: true, rel: s }
}

/**
 * 执行前的引擎闸（**只读、零 spawn**）。
 * @param {string} root 课程包根
 * @param {string[]} scripts 准备跑的脚本（相对包根）
 * @param {{trustedEngine?:boolean}} [opts]
 *   `trustedEngine:false` = **显式旁路**（T04-R2 裁定甲）：只给"夹具不是真包"的测试调用点用，
 *   **缺省 true（严）**，生产调用点一个都不许传 false。见 `test/audit/T04.mjs` 的
 *   `T04-BYPASS-static-only-tests`（静态判据：`lib/**` 里除了参数声明与那一行 hctx 透传，
 *   没有任何生产调用点传 false）。
 * @returns {{ok:true}|{ok:false, error:string, missing:string[], mismatched:string[], badPaths:string[]}}
 */
export function verifyEngineForScripts(root, scripts, { trustedEngine = true } = {}) {
  if (trustedEngine === false) return { ok: true }
  const badPaths = []
  for (const s of scripts) {
    const c = checkScriptPath(s)
    if (!c.ok) badPaths.push(c.error)
  }
  if (badPaths.length) {
    return {
      ok: false,
      badPaths,
      missing: [],
      mismatched: [],
      error: `脚本路径越界，拒绝执行：${badPaths.join('；')}`,
    }
  }
  let v
  try {
    v = verifyEngine(root, trustedManifest())
  } catch (e) {
    return {
      ok: false, badPaths: [], missing: [], mismatched: [],
      error: `核验引擎时出错（${e?.message ?? e}）—— 拒绝执行包里的脚本`,
    }
  }
  if (v.ok) return { ok: true }
  return {
    ok: false,
    badPaths: [],
    missing: v.missing,
    mismatched: v.mismatched.map((m) => m.path),
    error: `${engineVerdict(v, '这个包的引擎')} —— 拒绝执行包里的脚本（零 spawn）。`
      + '修法：node tools/upgrade-pack.mjs --root=<包根> --plan，再 --apply --confirm --plan-digest=<digest>',
  }
}

/** 被闸拒掉时的作业形状：与真作业同形（调用方不必分支），但 `steps` 空、零 spawn */
function rejectedJob(root, scripts, subject, gate, opts = {}) {
  const now = Date.now()
  return decorate({
    id: `rb-${++seq}`,
    root,
    subject,
    scripts: [...scripts],
    state: 'failed',
    code: 'engine-blocked',
    done: true,
    index: -1,
    current: null,
    steps: [],
    rebuild: { ok: false, failed: [...scripts] },
    // ⚠️ 这一句与 ask-io.js 的 `engineBlockedWarning` **逐字同源**（`test/rebuild-job.mjs` ④
    //    拿同一批脚本跑两份实现、断言 warnings 逐字节相同）——改这里要同步那里。
    warnings: [`重建没起：${gate.error}`],
    failed: true,
    engineError: gate.error,
    engineMissing: gate.missing,
    engineMismatched: gate.mismatched,
    badPaths: gate.badPaths,
    startedAt: now,
    endedAt: now,
  }, opts)
  job._finished = true
  return job
}

/**
 * 把一条作业补齐成**同形**的内部句柄（新老字段都在一处，别让调用方按分支读）。
 * @param {object} job 已经填好的部分
 * @param {{scope?:any, timeoutMs?:number, maxOutputBytes?:number}} opts
 */
function decorate(job, opts = {}) {
  const out = createTailRing(normBytes(opts.maxOutputBytes))
  const err = createTailRing(normBytes(opts.maxOutputBytes))
  return {
    state: 'queued',
    code: null,
    missing: [],
    truncated: false,
    stdoutTail: '',
    stderrTail: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    tree: null,
    spawned: [],
    merged: 1,
    reason: null,
    ...job,
    owner: opts.scope ?? null,
    ownerKey: ownerKey(opts.scope ?? null),
    timeoutMs: normTimeout(opts.timeoutMs),
    maxOutputBytes: normBytes(opts.maxOutputBytes),
    _out: out,
    _err: err,
    _child: null,
    _timer: null,
    _waiters: [],
    _stopped: false,
    _stopKind: null,
    _treePending: false,
    _finished: false,
    _runnerDone: false,
    _stepTruncated: false,
  }
}

/**
 * 一条**已经结束**的作业（零 spawn 的那些：空链成功 / 缺脚本 / 满队 / owner 已卸载）。
 * 与真作业同形 —— 调用方不必为这些分支另写读法。
 */
function instantJob(root, scripts, subject, opts, { state, code = null, rebuild, warnings, failed, missing = [], reason = null }) {
  const now = Date.now()
  const job = decorate({
    id: `rb-${++seq}`,
    root,
    subject,
    scripts: [...scripts],
    state,
    code,
    done: true,
    index: -1,
    current: null,
    steps: [],
    rebuild,
    warnings: [...warnings],
    failed,
    missing: [...missing],
    reason,
    startedAt: now,
    endedAt: now,
  }, opts)
  job._finished = true
  return job
}

/**
 * 输出尾巴的**环形缓冲**（T16）：只留最后 `limit` 字节，同时记住"一共来过多少字节"。
 * `truncated` = 来过 > 留下的（**不是**"这个作业失败了"——它只是说"这段输出被裁过"）。
 * @param {number} limit 字节上限
 */
function createTailRing(limit) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0))
  const chunks = []
  let kept = 0
  let seen = 0
  return {
    limit: cap,
    /** @param {string|Buffer} chunk */
    push(chunk) {
      const s = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      if (!s) return
      const buf = Buffer.from(s, 'utf8')
      seen += buf.length
      if (cap === 0) { chunks.length = 0; kept = 0; return }
      if (buf.length >= cap) {
        // 单块就超上限：只留它**自己**的尾部（前面的块一定更老，全丢）
        chunks.length = 0
        const t = buf.subarray(buf.length - cap).toString('utf8')
        chunks.push(t)
        kept = Buffer.byteLength(t, 'utf8')
        return
      }
      chunks.push(s)
      kept += buf.length
      while (kept > cap && chunks.length > 1) {
        const first = chunks.shift()
        kept -= Buffer.byteLength(first, 'utf8')
      }
    },
    get value() { return chunks.join('') },
    get bytes() { return kept },
    get total() { return seen },
    get truncated() { return seen > kept },
  }
}

/**
 * 输出尾巴口径 —— 与 ask-io.js 的 runScript **逐字一致**（改这里要同步那里）。
 * @param {string} stdout @param {string} stderr
 */
export function tailOf(stdout, stderr) {
  const out = `${stdout || ''}${stderr || ''}`.trim()
  return out.split('\n').filter(Boolean).slice(-2).join(' ／ ')
}

/**
 * 退出码口径：拿不到状态（被信号杀 / 起不来）一律记 -1，不假装成功。
 * @param {number|null} status
 */
export function codeOf(status) {
  return status === null ? -1 : status
}

/**
 * 把 steps 汇成 rebuild + warnings —— **同步版与异步版共用这一份**。
 * 措辞与 rebuildArtifacts 原本的行内实现逐字相同：
 *   `重建脚本 X 退出码 N —— <subject>已写好，但产物可能是旧的：<tail>`
 * @param {{script: string, code: number, tail: string}[]} steps
 * @param {string} subject 人话主语（如「台账」「笔记」「圆圈」）
 */
export function summarize(steps, subject) {
  const failed = steps.filter((s) => s.code !== 0)
  return {
    rebuild: { ok: failed.length === 0, failed: failed.map((s) => s.script) },
    warnings: failed.map(
      (s) => `重建脚本 ${s.script} 退出码 ${s.code} —— ${subject}已写好，但产物可能是旧的：${s.tail || '（没有输出）'}`
    ),
  }
}

/**
 * 异步跑一条无参脚本（runScript 的异步孪生）。
 * @param {string} root 课程包根（cwd）
 * @param {string} script 脚本路径（相对 root，或绝对路径）
 * @param {{maxOutputBytes?:number, onChunk?:(stream:'stdout'|'stderr', chunk:any)=>void,
 *          onSpawn?:(child:import('node:child_process').ChildProcess)=>void}} [opts]
 *   T16 新增三个**只读**的可选钩子（缺省时行为与旧版逐字相同）：
 *   · `maxOutputBytes`：本条的 stdout/stderr 各自留多少尾部（默认 64KiB）；
 *   · `onChunk`：把同一批字节转给调用方（作业级环形缓冲用，**不再多存一份**）；
 *   · `onSpawn`：子进程一起来就把句柄交出去（作业要记 pid 才能只杀自己那棵树）。
 * @returns {Promise<{script: string, code: number, tail: string, truncated: boolean,
 *   stdoutBytes: number, stderrBytes: number, spawned: boolean}>} **永不 reject** —— 失败如实回报
 */
export function runScriptAsync(root, script, opts = {}) {
  const maxOutputBytes = opts.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : opts.maxOutputBytes
  const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null
  const onSpawn = typeof opts.onSpawn === 'function' ? opts.onSpawn : null
  return new Promise((resolve) => {
    const out = createTailRing(normBytes(maxOutputBytes))
    const err = createTailRing(normBytes(maxOutputBytes))
    let child
    try {
      // 走 runAsync：它替我们挂上 error 监听（裸 spawn 的 EPERM/ENOENT 会变成未捕获异常），
      // 人话与同步版同源；下面自己的 error 分支照旧收尾。
      child = runAsync(process.execPath, [script], { cwd: root }).child
    } catch (e) {
      // 同步抛（极少）：同样把「没起来」的人话带上 —— 与同步版 runScript 的尾巴口径一致
      const tail = [String(e && e.message ? e.message : e), spawnFailureHint({ error: e })].filter(Boolean).join(' ／ ')
      resolve({ script, code: -1, tail, truncated: false, stdoutBytes: 0, stderrBytes: 0, spawned: false })
      return
    }
    const spawned = Number.isInteger(child.pid) && child.pid > 0
    // ⚠️ 句柄**立刻**交出去：作业要拿它记 pid（撤作业时只认这一棵），也要拿它做"这个 pid 还是我那个
    //    子进程"的活证明（见 killTree 的注释）。记账失败不许影响跑。
    if (spawned && onSpawn) { try { onSpawn(child) } catch { /* 记账失败不影响跑 */ } }
    const snap = (code, tail) => ({
      script, code, tail,
      truncated: out.truncated || err.truncated,
      stdoutBytes: out.total, stderrBytes: err.total, spawned,
    })
    child.stdout?.on('data', (d) => { out.push(d); if (onChunk) onChunk('stdout', d) })
    child.stderr?.on('data', (d) => { err.push(d); if (onChunk) onChunk('stderr', d) })
    child.on('error', (e) => {
      const tail = [tailOf(out.value, String(e && e.message ? e.message : e)), spawnFailureHint({ error: e })].filter(Boolean).join(' ／ ')
      resolve(snap(-1, tail))
    })
    child.on('close', (status) => resolve(snap(codeOf(status), tailOf(out.value, err.value))))
  })
}

/** 裁掉最老的已完成作业，保持表不超过 KEEP */
function trim() {
  if (JOBS.size <= KEEP) return
  const finished = [...JOBS.values()].filter((j) => j.done).sort((a, b) => a.endedAt - b.endedAt)
  while (JOBS.size > KEEP && finished.length) JOBS.delete(finished.shift().id)
}

/** 作业表里现在有哪些"包"在跑（pump 的判据：同一个包不并发） */
function runningRoots() {
  const set = new Set()
  for (const id of running) {
    const j = JOBS.get(id)
    if (j) set.add(j.root)
  }
  return set
}

/**
 * 调度一次：在全局队列里挑**第一个"它那个包没人在跑"**的作业起来，直到槽位满。
 *
 * 为什么不是"队列头是谁就起谁"：卡面同时要**每包 FIFO** 与 **≤2 包并行** ——
 * 队列头可能是 A 包的第二条（A 包第一条还在跑），而 B 包的活儿本来可以并行起来。
 * 所以跳过"包被占"的那些，但同一个包内部严格按进队顺序（队列本身是 FIFO 的）。
 */
function pump() {
  while (running.size < MAX_RUNNING) {
    const busy = runningRoots()
    const idx = QUEUE.findIndex((id) => {
      const j = JOBS.get(id)
      return j && !j.done && !j._finished && !j._stopped && !busy.has(j.root)
    })
    if (idx < 0) break
    const [id] = QUEUE.splice(idx, 1)
    startRunning(JOBS.get(id))
  }
}

/** 真开跑一条作业（**同步**把 state/current 立起来，调用方立刻看得到 —— 旧判据依赖这条） */
function startRunning(job) {
  job.state = 'running'
  job.runStartedAt = Date.now()
  job.index = 0
  job.current = job.scripts[0] ?? null
  running.add(job.id)
  const t = normTimeout(job.timeoutMs)
  job._timer = setTimeout(() => onTimeout(job), Math.max(1, t))
  runJob(job).catch((e) => {
    // 兜底：runJob 内部不该抛。真抛了也**不许吞** —— 如实记成失败并收尾（绝不静默留一条假 running）
    job.errorDetail = String(e?.message ?? e)
    job.warnings = [...job.warnings, `重建作业内部异常：${job.errorDetail}`]
    job.failed = true
    if (!job._stopped) { job._stopped = true; job._stopKind = 'error' }
    settle(job)
  })
}

/** 跑完一整条链（失败**不中断**：与同步版一致，剩下的产物仍要尽力重建） */
async function runJob(job) {
  try {
    for (let i = 0; i < job.scripts.length; i++) {
      if (job._stopped || job._finished) break
      job.index = i
      job.current = job.scripts[i]
      let step
      try {
        step = await runScriptAsync(job.root, job.scripts[i], {
          maxOutputBytes: job.maxOutputBytes,
          onChunk: (stream, chunk) => { (stream === 'stderr' ? job._err : job._out).push(chunk) },
          onSpawn: (child) => {
            job._child = child
            job.spawned.push({ pid: child.pid, script: job.scripts[i], at: Date.now() })
          },
        })
      } finally {
        job._child = null
      }
      if (job._finished) return
      job.steps.push(step)
      if (step.truncated) job._stepTruncated = true
      job.stdoutTail = job._out.value
      job.stderrTail = job._err.value
      job.stdoutBytes = job._out.total
      job.stderrBytes = job._err.total
      if (job._stopped) break
    }
  } finally {
    // ⚠️ 这个记号是给"取消/超时那条路"看的：撤树的确认可能**比子进程 close 事件先到**
    //    （taskkill 一杀，内核里就没了，而 Node 还要等 close 事件才 resolve 上面那个 await）。
    //    撤树那条路会**先等这个记号**再收尾，免得"被打断的那一步"没被如实记进 steps。
    job._runnerDone = true
    settle(job)
  }
}

/**
 * 收尾（**幂等**，且"进程树还没确认消失"时**不**收尾）。
 *
 * ⚠️ `done` 的含义在这里被钉死：**作业结束 = 它的进程树也没了**。
 * 取消/超时的作业，state 立刻就是 `cancelled` / `timed-out`（卡面要求"先记"），
 * 但 `done` 要等撤树的确认（≤5s）—— 这样 `await waitRebuild(id)` 之后
 * 「作业结束」与「子进程没了」是同一条事实，而不是两句口头承诺。
 */
function settle(job) {
  if (!job || job._finished) return job
  if (job._treePending) return job
  job._finished = true
  if (job._timer) { clearTimeout(job._timer); job._timer = null }
  const kind = job._stopKind || 'done'
  const sum = summarize(job.steps, job.subject)
  if (kind === 'done') {
    job.rebuild = sum.rebuild
    job.warnings = sum.warnings
    job.failed = !sum.rebuild.ok
    job.state = job.failed ? 'failed' : 'succeeded'
  } else {
    // 取消 / 超时 / 内部异常：**都不是成功**。没轮到的那些脚本也如实列进 failed
    // （它们的产物没被重建 —— 说成 ok 才是假绿）。
    const unrun = job.scripts.slice(job.steps.length)
    job.rebuild = { ok: false, failed: [...new Set([...sum.rebuild.failed, ...unrun])] }
    const okCount = job.steps.filter((s) => s.code === 0).length
    const stuck = job.current ? `，${job.current} 被终止` : ''
    const head = kind === 'timeout'
      ? `重建作业超时（${job.timeoutMs}ms）`
      : kind === 'error'
        ? `重建作业内部异常（${job.errorDetail ?? '未知'}）`
        : `重建作业被取消（${job.cancelReason || '取消'}）`
    job.warnings = [...sum.warnings, `${head}：只完成 ${okCount}/${job.scripts.length} 条${stuck} —— ${job.subject}的产物可能没生成完`]
    job.failed = true
    job.state = kind === 'timeout' ? 'timed-out' : kind === 'error' ? 'failed' : 'cancelled'
  }
  job.done = true
  job.current = null
  job.endedAt = Date.now()
  job.stdoutTail = job._out.value
  job.stderrTail = job._err.value
  job.stdoutBytes = job._out.total
  job.stderrBytes = job._err.total
  job.truncated = job._out.truncated || job._err.truncated || job._stepTruncated === true
  running.delete(job.id)
  for (const w of job._waiters.splice(0)) w(job)
  pump()
  trim()
  return job
}

/**
 * 撤树之后**等 runner 把被打断的那一步记完**，再收尾。
 * 为什么需要它：taskkill 一杀，内核里那个进程立刻没了，而 Node 还要等 close 事件才会
 * resolve `runScriptAsync` —— 撤树的确认常常**先到**。不等的话，`steps` 里就少了
 * "被打断的那一条"，作业看起来像"一条都没跑"（那是不准确的）。等待有上界，绝不无限等。
 */
async function awaitRunner(job, capMs = 1000) {
  const deadline = Date.now() + capMs
  while (!job._runnerDone && !job._finished && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 超时：**先记** `timed-out`（卡面原文），再撤进程树、再收尾 */
function onTimeout(job) {
  if (!job || job.done || job._finished) return
  if (!job._stopped) { job._stopped = true; job._stopKind = 'timeout' }
  if (job._stopKind === 'timeout') job.state = 'timed-out'
  job.timedOut = true
  job.timeoutAt = Date.now()
  job._treePending = true
  killJobTree(job)
    .then((tree) => { job.tree = tree; job._treePending = false; return awaitRunner(job) })
    .then(() => settle(job))
}

/** 这个 pid 现在还活着吗（EPERM = 活着但可能不是我们能碰的，按活着算，别把"没权限"当"没了"） */
function alivePid(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/**
 * 撤掉**本次 spawn 的那一棵**进程树，并**等它真的消失**（≤TREE_CONFIRM_MS）。
 *
 * 为什么可以确信"这个 pid 还是我那个子进程"：`child` 是本次 `spawn` 给的句柄，
 * 只要 `exitCode === null && signalCode === null`，Node 就还持有它的进程句柄 ——
 * Windows 不会把一个"句柄还开着"的进程编号回收给别的进程。所以此刻
 * `taskkill /PID <它> /T /F` 打的**必然**是本次 spawn 的那棵树（含它的后代）。
 * 反过来：句柄已经收了（子进程早就退出了）就**一个 pid 都不去碰** ——
 * 那个编号可能已经属于别人，"顺手杀一下"正是本卡禁止的事。
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {number} [confirmMs]
 */
function killTree(child, confirmMs = TREE_CONFIRM_MS) {
  const pid = child && Number.isInteger(child.pid) ? child.pid : null
  const held = !!child && pid !== null && pid > 0 && child.exitCode === null && child.signalCode === null
  const rec = {
    pid, held, method: null, killError: null, pids: [], gone: null, ms: null,
    aliveLeft: [], raw: '', note: null, taskkillStatus: null, confirmedAt: null,
  }
  return new Promise((resolve) => {
    if (!held) {
      rec.method = 'not-held'
      rec.gone = true
      rec.note = '子进程早就退出了（句柄已收）—— 撤作业时**一个 pid 都不碰**'
      resolve(rec)
      return
    }
    if (process.platform === 'win32') {
      // 只指**我们自己**那棵树：pid 来自本次 spawn，且上面刚证明句柄还活着
      const r = runSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
      rec.method = 'taskkill:/T'
      rec.taskkillStatus = r.status
      rec.raw = String(r.stdout ?? '') + String(r.stderr ?? '')
      // taskkill 自己会报出它终止了哪几个 pid（"The process with PID N ... has been terminated."）
      // ——那是**内核视角**的那棵树，拿它做确认比我们猜更硬。
      // ⚠️ 只认 "process with PID N"：同一行里的 "child process of PID M" 是**父**进程（可能是我们自己），
      //    把它算进来会永远等不到"消失"（本机实测过的坑）。
      const reported = [...rec.raw.matchAll(/process with PID (\d+)/g)].map((m) => Number(m[1]))
      rec.pids = [...new Set([pid, ...reported])].filter((p) => p > 0 && p !== process.pid)
      if (r.error) {
        // taskkill **根本没跑起来**（沙箱 EPERM / 不在 PATH）：至少把直接子进程按住（走句柄）
        rec.killError = r.hint || `taskkill 起不来：${r.error.code ?? r.error}`
        try { child.kill('SIGKILL') } catch (e) { rec.killError += `；child.kill 也没成：${e?.message ?? e}` }
      } else if (r.status !== 0 && /not\s+found|没有找到|找不到/i.test(rec.raw)) {
        // 退出码非零但原因是"这个 pid 已经没了"：那不是失败 —— 子进程在我们撤之前自己退了，
        // 于是我们**什么都没杀**（正是"只杀自己那棵树"该有的样子）。真相由下面的确认循环说了算。
        rec.note = 'taskkill 说这个 pid 已经没了（子进程先自己退了）—— 没杀任何东西'
      }
    } else {
      rec.method = 'SIGKILL'
      try { child.kill('SIGKILL') } catch (e) { rec.killError = String(e?.message ?? e) }
      rec.pids = [pid]
    }
    const t0 = Date.now()
    const tick = () => {
      const left = rec.pids.filter((p) => alivePid(p))
      const elapsed = Date.now() - t0
      if (!left.length) {
        rec.gone = true; rec.ms = elapsed; rec.confirmedAt = Date.now()
        resolve(rec)
        return
      }
      if (elapsed >= confirmMs) {
        // 兜底：直接子进程再按一次（句柄路径），然后**如实报**"没杀干净"
        try { child.kill('SIGKILL') } catch { /* 尽力 */ }
        rec.aliveLeft = rec.pids.filter((p) => alivePid(p))
        rec.gone = rec.aliveLeft.length === 0
        rec.ms = Date.now() - t0
        rec.confirmedAt = rec.gone ? Date.now() : null
        if (!rec.gone) {
          rec.killError = `${rec.killError ? rec.killError + '；' : ''}撤树 ${rec.ms}ms 后仍有进程活着：${rec.aliveLeft.join('、')}（taskkill 退出码 ${rec.taskkillStatus}）`
        }
        resolve(rec)
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** 撤一条在跑作业的树（没在跑就是"没有树要撤"，照样回一个同形的记录） */
function killJobTree(job) {
  return killTree(job._child)
}

/**
 * 取消一个作业（T16 卡面：`cancelRebuild(id, reason)`）。
 *
 * · 在跑 → 先记 `cancelled`，再撤**自己那棵树**，确认消失（≤5s）后 `done`；
 * · 还在排队 → 直接从队列拿掉（**零 spawn**）并收尾；
 * · 已经结束 → **无害**（幂等：不报错、不改它已有的终态）。
 *
 * @param {string} id
 * @param {string} [reason] 进回执（`job.reason` / 告警文案）
 * @returns {{ok:boolean, id:string, state:string|null, reason:string|null, already:boolean,
 *            ended:Promise<{ok:boolean, id:string, state:string|null, treeGone:boolean|null,
 *                          tree?:object, queued?:boolean, error?:string}>}}
 *   ⚠️ `ended` 才是"进程树也确认没了"；同步返回的只是**已经登记取消**这件事。
 */
export function cancelRebuild(id, reason = '取消') {
  const job = JOBS.get(id)
  if (!job) {
    return {
      ok: false, id, state: null, reason: null, already: false,
      ended: Promise.resolve({ ok: false, id, state: null, treeGone: null, error: '没有这个作业（id 不存在）' }),
    }
  }
  if (job.done) {
    const treeGone = job.tree ? job.tree.gone : null
    return {
      ok: true, id, state: job.state, reason: job.cancelReason ?? null, already: true,
      ended: Promise.resolve({ ok: true, id, state: job.state, treeGone, already: true }),
    }
  }
  const reasonText = String(reason || '取消')
  if (!job._stopped) {
    job._stopped = true
    job._stopKind = 'cancel'
    job.cancelReason = reasonText
  } else if (job._stopKind !== 'timeout') {
    job.cancelReason = job.cancelReason ?? reasonText
  }
  const terminal = job._stopKind === 'timeout' ? 'timed-out' : 'cancelled'
  // 还在队列里（没开跑）还是已经在跑：判据是"有没有开跑过"，不是上面刚写下去的 state
  const notStarted = job.runStartedAt === undefined
  job.state = terminal
  job.reason = job.reason ?? reasonText

  if (notStarted) {
    // 还没跑（或还在队列里）：从队列里摘掉，零 spawn
    const i = QUEUE.indexOf(id)
    if (i >= 0) QUEUE.splice(i, 1)
    settle(job)
    return {
      ok: true, id, state: job.state, reason: job.cancelReason ?? null, already: false,
      ended: Promise.resolve({ ok: true, id, state: job.state, treeGone: null, queued: true }),
    }
  }
  // 在跑：撤树 + 等确认 + 等 runner 记完被打断的那一步，然后才收尾（done）
  job._treePending = true
  const ended = killJobTree(job)
    .then((tree) => { job.tree = tree; job._treePending = false; return awaitRunner(job) })
    .then(() => {
      settle(job)
      return { ok: true, id, state: job.state, treeGone: job.tree ? job.tree.gone : null, tree: job.tree, ms: job.tree ? job.tree.ms : null }
    })
  return { ok: true, id, state: job.state, reason: job.cancelReason ?? null, already: false, ended }
}

/**
 * 撤掉某个 owner 的**全部**作业（T16 卡面：`cancelAllRebuilds(owner)`）。
 *
 * 谁用它：`lib/index.js` 把插件作用域挂成 owner —— 宿主重载/卸载时，
 * `resource-scope` 会 await 这里回的 Promise（disposer 返回 thenable 就会被等），
 * 所以「卸载后子进程与作业均结束」不是"卸载时喊一嗓子"，而是**等它真的结束**。
 *
 * @param {any} [owner] 不传（或 null）→ 撤**全部** owner 的
 * @param {string} [reason]
 * @returns {Promise<{ok:true, count:number, cancelled:string[]}>}
 */
export function cancelAllRebuilds(owner, reason = '随插件卸载') {
  const all = arguments.length === 0 || owner === undefined || owner === null
  const key = all ? null : ownerKey(owner)
  const targets = [...JOBS.values()].filter((j) => !j.done && (all || j.ownerKey === key))
  const receipts = targets.map((j) => cancelRebuild(j.id, reason))
  return Promise.all(receipts.map((r) => r.ended)).then(() => ({
    ok: true,
    count: receipts.length,
    cancelled: receipts.map((r) => r.id),
  }))
}

/**
 * owner 的 scope 一旦倒掉 → 撤这个 owner 的作业，并**等**进程树结束。
 * 每个 scope 只挂一次（多次调用不会挂出一串重复 disposer）。
 */
function bindOwnerScope(job) {
  const scope = job.owner
  if (!scope || typeof scope.add !== 'function') return
  if (BOUND_SCOPES.has(scope)) return
  BOUND_SCOPES.add(scope)
  try {
    // disposer 返回 Promise ⇒ resource-scope 会 await 它（resource-scope.js:21-23）
    scope.add(() => cancelAllRebuilds(scope))
  } catch { /* scope 已经倒掉（add 自己会立刻执行 disposer）：下面照跑，作业照样起得来 */ }
}

/**
 * 起一次重建，**立刻返回作业句柄**（不等脚本跑完）。
 *
 * ⚠️ T04：**spawn 之前先过引擎闸**（`verifyEngineForScripts`）—— 不通过就返回一个
 * **已完成、零 spawn** 的作业（`engineError` 带人话修法），绝不起任何进程。
 *
 * T16 的边界（都在这一处判，调用方不必自己数）：
 *   引擎闸 → owner 已卸载 → 缺脚本（整条链）→ 空链 → 相同请求合并 → 满队 busy → 入队。
 *
 * @param {string} root 课程包根
 * @param {string[]} scripts 按序执行的无参脚本（**顺序有意义**：先归档、再重建产物）
 * @param {{ subject?: string, trustedEngine?: boolean, scope?: any,
 *           timeoutMs?: number, maxOutputBytes?: number }} [opts]
 *   `trustedEngine` **缺省 true（严）**；`false` 是 T04-R2 的显式旁路，只给测试夹具用。
 *   `scope` = 这条作业的 **owner**（模块传 `hctx.scope`）：它倒掉时这条作业随之被撤并等结束。
 *   `timeoutMs` / `maxOutputBytes` 缺省 60000 / 65536。
 * @returns {object} 作业句柄（内部形状；对外一律走 create.js 的 `publicJob` 白名单投影）
 */
export function startRebuild(root, scripts, opts = {}) {
  const subject = opts.subject === undefined ? '写入' : opts.subject
  const trustedEngine = opts.trustedEngine === undefined ? true : opts.trustedEngine
  const scope = opts.scope ?? null
  const list = Array.isArray(scripts) ? [...scripts] : []
  const shape = { scope, timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes }

  // ── ① 引擎闸：零 spawn 的前置核验（T04 / D01）──────────────────────────────
  const gate = verifyEngineForScripts(root, list, { trustedEngine })
  if (!gate.ok) {
    const job = rejectedJob(root, list, subject, gate, shape)
    JOBS.set(job.id, job)
    trim()
    return job
  }

  // ── ② 链上哪些脚本**真的在包里**（缺件如实列，绝不静默跳过）──────────────
  const present = []
  const missing = []
  for (const s of list) {
    const c = checkScriptPath(s)
    if (c.ok && fs.existsSync(path.join(root, s))) present.push(s)
    else missing.push(s)
  }

  // ── ③ 缺脚本：整条链一个都不在包里 ⇒ `missing-script`，**零 spawn** ────────
  //    ⚠️ 与「空链」必须分得开：`startRebuild(root, [])` 是**成功**（没有失败项、没有告警），
  //    这里是"你要的东西这个包没有"——两件事，修法完全不同（与 startScripts 的 missing 同一条口径）。
  if (list.length > 0 && present.length === 0) {
    const job = instantJob(root, list, subject, shape, {
      state: 'missing-script',
      code: 'missing-script',
      rebuild: { ok: false, failed: [...list] },
      warnings: [`重建没起：这个包里没有 ${missing.join('、')} —— 产物不会自己长出来`],
      failed: true,
      missing,
      reason: 'missing-script',
    })
    JOBS.set(job.id, job)
    trim()
    return job
  }

  // ── ④ 空链：**成功**（旧语义一字不改：steps=[]、ok=true、warnings=[]）──────
  if (list.length === 0) {
    const job = instantJob(root, [], subject, shape, {
      state: 'succeeded', rebuild: { ok: true, failed: [] }, warnings: [], failed: false, missing,
    })
    JOBS.set(job.id, job)
    trim()
    return job
  }

  // ── ⑤ owner 已经卸载：立刻取消（**零 spawn** —— 卸载之后不该再长出新进程）──
  if (scope && scope.disposed === true) {
    const job = instantJob(root, list, subject, shape, {
      state: 'cancelled',
      code: 'owner-disposed',
      rebuild: { ok: false, failed: [...list] },
      warnings: [`重建没起：这个 owner（插件作用域）已经卸载了 —— ${subject}的产物没重建`],
      failed: true,
      missing,
      reason: 'owner-disposed',
    })
    JOBS.set(job.id, job)
    trim()
    return job
  }

  // ── ⑥ 相同运行请求（未开始）合并成同一条 ───────────────────────────────────
  //    判据里"相同"= 同 owner + 同 root + 同脚本序列 + 同 subject：
  //    owner 不同**不许**合并（否则 A 卸载会把 B 的作业一起撤了）。
  const mergeKey = [ownerKey(scope), path.resolve(String(root ?? '')), String(subject), list.join('\u0000')].join('\u0001')
  if (QUEUE.length) {
    for (const id of QUEUE) {
      const j = JOBS.get(id)
      if (j && !j._finished && !j._stopped && j.mergeKey === mergeKey) {
        j.merged += 1
        return j
      }
    }
  }

  // ── ⑦ 满队：回 `busy`（**零 spawn**）──────────────────────────────────────
  //    只有"这条真会被排进队"时才算满：槽位空着、包也没被占，那就直接跑，不该被队列长度拦下。
  const willStartNow = running.size < MAX_RUNNING && !runningRoots().has(root)
  if (!willStartNow && QUEUE.length >= MAX_QUEUE) {
    const job = instantJob(root, list, subject, shape, {
      state: 'rejected',
      code: 'busy',
      rebuild: { ok: false, failed: [...list] },
      warnings: [`重建没起：重建排队已满（全局最多 ${MAX_QUEUE} 条在等）—— 这条请求被拒，稍后重试；${subject}的产物没重建`],
      failed: true,
      missing,
      reason: 'busy',
    })
    JOBS.set(job.id, job)
    trim()
    return job
  }

  const job = decorate({
    id: `rb-${++seq}`,
    root,
    subject,
    scripts: list,
    state: 'queued',
    done: false,
    index: -1,
    current: null,
    steps: [],
    rebuild: null,
    warnings: [],
    failed: false,
    missing,
    startedAt: Date.now(),
    endedAt: null,
    queuedAt: Date.now(),
    mergeKey,
  }, shape)
  JOBS.set(job.id, job)
  QUEUE.push(job.id)
  bindOwnerScope(job)
  pump()
  return job
}

/** 按 id 取作业（没有就 null；不做抛错，调用方自己决定怎么报） */
export function getRebuild(id) {
  return JOBS.get(id) || null
}

/** 列作业：正在跑的在前面，其余按开始时间倒序 */
export function listRebuilds() {
  return [...JOBS.values()].sort((a, b) => Number(a.done) - Number(b.done) || b.startedAt - a.startedAt)
}

/**
 * 等一个作业跑完（测试与"我就想同步拿结果"的调用方用）。
 * T16 之后它还多一层含义：取消/超时的作业，`done` 之前**进程树也确认没了**
 * （见 settle 的注释）——所以等到它回来，就是"作业与它的子进程都结束了"。
 * @param {string} id @returns {Promise<object|null>} 作业对象；id 不存在则 null
 */
export function waitRebuild(id) {
  const job = JOBS.get(id)
  if (!job) return Promise.resolve(null)
  if (job.done) return Promise.resolve(job)
  return new Promise((resolve) => job._waiters.push(resolve))
}

/**
 * 一次跑完再返回（startRebuild + waitRebuild 的糖）。
 * @returns {Promise<{steps: object[], rebuild: object, warnings: string[]}>}
 */
export async function rebuildNow(root, scripts, opts) {
  const job = startRebuild(root, scripts, opts)
  await waitRebuild(job.id)
  return { steps: job.steps, rebuild: job.rebuild, warnings: job.warnings }
}

/**
 * 起一条**课程包重建链**：只跑包里**真的存在**的脚本，缺的如实列出来（**不许静默跳过**）。
 *
 * 为什么必须先查存在性：新包是**从模板长出来的**（`lib/pack-scaffold.js` 的拷贝清单），
 * 骨架只带一部分生成器 —— `tools/circle-bands.js`、`assets/build-glossary.js`
 * 这些**不在骨架里**。不查就会起一串必失败的进程，页面上只看到"重建失败"，
 * 却看不出是"脚本不在这个包"还是"脚本在、它自己跑挂了"——那是两件事，修法完全不同。
 *
 * 全缺 → **不起作业**（`job: null`），让调用方据 `missing` 说清"这个包还没有重建器"。
 *
 * ⚠️ T04：**引擎闸在最前面**（`verifyEngineForScripts`）。包里的引擎与插件模板不一致 →
 * **零 spawn**、`job: null`、`engineError` 带人话修法 —— 不静默降级成"照跑不误"。
 * ⚠️ T16：满队时 `job` 是一条 `rejected` 作业（`code:'busy'`），**不是** `null` ——
 * 调用方必须把"排队满了"和"包里没有脚本"分开说（`busy` 字段是现成的判据）。
 *
 * @param {string} root 课程包根
 * @param {string[]} scripts 相对包根的脚本路径（如 `'tools/build-starmap.js'`）
 * @param {{ subject?: string, trustedEngine?: boolean, scope?: any,
 *           timeoutMs?: number, maxOutputBytes?: number }} [opts]
 *   `trustedEngine` **缺省 true（严）**；`false` 是 T04-R2 的显式旁路，只给测试夹具用。
 * @returns {{job: object|null, present: string[], missing: string[], engineError: string|null, busy: boolean}}
 */
export function startScripts(root, scripts, opts = {}) {
  const present = []
  const missing = []
  for (const s of scripts) {
    if (fs.existsSync(path.join(root, s))) present.push(s)
    else missing.push(s)
  }

  // 引擎闸：整条链（**不只是包里现存的那几条**）都要先过路径边界与闭包核验
  const gate = verifyEngineForScripts(root, scripts, { trustedEngine: opts.trustedEngine !== false })
  if (!gate.ok) {
    return { job: null, present, missing, engineError: gate.error, engineMissing: gate.missing, engineMismatched: gate.mismatched, badPaths: gate.badPaths, busy: false }
  }

  const job = present.length ? startRebuild(root, present, opts) : null
  return { job, present, missing, engineError: null, busy: !!(job && job.code === 'busy') }
}
