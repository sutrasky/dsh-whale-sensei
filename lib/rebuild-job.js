/**
 * lib/rebuild-job.js — 异步重建器（与 ask-io.js 的 rebuildArtifacts **同语义**，但不阻塞调用方）
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
 * 边界（说清，别当它是调度器）：
 *   作业只活在**当前进程**里，宿主重启即丢；没有持久化、没有跨进程查询。
 *   够用即可 —— 它的用途是"这一次请求别阻塞"，不是"长期任务队列"。
 *
 * ⚠️ **执行前先核验受信引擎**（T04 / 报告 D01，证据行号就是本文件 :75-L96 的 `runAsync`）：
 *   `spawn(process.execPath, [脚本])` 执行的是**课程包里可写的那份代码** —— 换掉一个字节，
 *   宿主下一次重建就跑别人的代码。所以 spawn **之前**两道闸：
 *     ① 每个脚本路径先过**共享路径边界**（T03 的 `tools/path-policy.cjs`，全仓只此一份实现）；
 *     ② 这个包的引擎闭包必须与**插件模板**逐字节一致（`lib/engine.js` 的 `verifyEngine`）。
 *   任一条不过 → **零 spawn**，如实回执（`engineError`），绝不"起了再说"。
 *   ⚠️ 这是**引擎一致性核验**，不是任意数据沙箱：学生自己的课 / 笔记 / 代码不在清单里。
 */
import { runAsync, spawnFailureHint } from './exec.js'
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
/** 正在跑 / 最近跑过的作业表 */
const JOBS = new Map()
let seq = 0

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
function rejectedJob(root, scripts, subject, gate) {
  return {
    id: `rb-${++seq}`,
    root,
    subject,
    scripts: [...scripts],
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
    startedAt: Date.now(),
    endedAt: Date.now(),
    _waiters: [],
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
 * @returns {Promise<{script: string, code: number, tail: string}>} **永不 reject** —— 失败如实回报
 */
export function runScriptAsync(root, script) {
  return new Promise((resolve) => {
    let child
    try {
      // 走 runAsync：它替我们挂上 error 监听（裸 spawn 的 EPERM/ENOENT 会变成未捕获异常），
      // 人话与同步版同源；下面自己的 error 分支照旧收尾。
      child = runAsync(process.execPath, [script], { cwd: root }).child
    } catch (e) {
      // 同步抛（极少）：同样把「没起来」的人话带上 —— 与同步版 runScript 的尾巴口径一致
      const tail = [String(e && e.message ? e.message : e), spawnFailureHint({ error: e })].filter(Boolean).join(' ／ ')
      resolve({ script, code: -1, tail })
      return
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => {
      const tail = [tailOf(out, String(e && e.message ? e.message : e)), spawnFailureHint({ error: e })].filter(Boolean).join(' ／ ')
      resolve({ script, code: -1, tail })
    })
    child.on('close', (status) => resolve({ script, code: codeOf(status), tail: tailOf(out, err) }))
  })
}

/** 裁掉最老的已完成作业，保持表不超过 KEEP */
function trim() {
  if (JOBS.size <= KEEP) return
  const finished = [...JOBS.values()].filter((j) => j.done).sort((a, b) => a.endedAt - b.endedAt)
  while (JOBS.size > KEEP && finished.length) JOBS.delete(finished.shift().id)
}

/**
 * 起一次重建，**立刻返回作业句柄**（不等脚本跑完）。
 *
 * ⚠️ T04：**spawn 之前先过引擎闸**（`verifyEngineForScripts`）—— 不通过就返回一个
 * **已完成、零 spawn** 的作业（`engineError` 带人话修法），绝不起任何进程。
 *
 * @param {string} root 课程包根
 * @param {string[]} scripts 按序执行的无参脚本（**顺序有意义**：先归档、再重建产物）
 * @param {{ subject?: string, trustedEngine?: boolean }} [opts]
 *   `trustedEngine` **缺省 true（严）**；`false` 是 T04-R2 的显式旁路，只给测试夹具用。
 * @returns {{id: string, subject: string, scripts: string[], done: boolean, index: number,
 *   steps: object[], rebuild: object|null, warnings: string[], failed: boolean,
 *   startedAt: number, endedAt: number|null, current: string|null}}
 */
export function startRebuild(root, scripts, { subject = '写入', trustedEngine = true } = {}) {
  // ── 引擎闸：零 spawn 的前置核验（T04 / D01）──────────────────────────────
  const gate = verifyEngineForScripts(root, scripts, { trustedEngine })
  if (!gate.ok) {
    const job = rejectedJob(root, scripts, subject, gate)
    JOBS.set(job.id, job)
    trim()
    return job
  }

  const id = `rb-${++seq}`
  const job = {
    id,
    root,
    subject,
    scripts: [...scripts],
    done: false,
    index: -1,
    current: null,
    steps: [],
    rebuild: null,
    warnings: [],
    failed: false,
    startedAt: Date.now(),
    endedAt: null,
    _waiters: [],
  }
  JOBS.set(id, job)
  ;(async () => {
    for (let i = 0; i < job.scripts.length; i++) {
      job.index = i
      job.current = job.scripts[i]
      const step = await runScriptAsync(root, job.scripts[i])
      job.steps.push(step)
      // 失败不中断：与同步版一致（它也是全跑完再汇总，剩下的产物仍要尽力重建）
    }
    const sum = summarize(job.steps, subject)
    job.rebuild = sum.rebuild
    job.warnings = sum.warnings
    job.failed = !sum.rebuild.ok
    job.done = true
    job.current = null
    job.endedAt = Date.now()
    for (const w of job._waiters.splice(0)) w(job)
    trim()
  })()
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
 *
 * @param {string} root 课程包根
 * @param {string[]} scripts 相对包根的脚本路径（如 `'tools/build-starmap.js'`）
 * @param {{ subject?: string, trustedEngine?: boolean }} [opts]
 *   `trustedEngine` **缺省 true（严）**；`false` 是 T04-R2 的显式旁路，只给测试夹具用。
 * @returns {{job: object|null, present: string[], missing: string[], engineError: string|null}}
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
    return { job: null, present, missing, engineError: gate.error, engineMissing: gate.missing, engineMismatched: gate.mismatched, badPaths: gate.badPaths }
  }

  return { job: present.length ? startRebuild(root, present, opts) : null, present, missing, engineError: null }
}
