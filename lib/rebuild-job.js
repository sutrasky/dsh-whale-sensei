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
 */
import { spawn } from 'node:child_process'

/** 保留最近多少个作业（防无界增长；被裁掉的是最老的**已完成**作业） */
const KEEP = 20
/** 正在跑 / 最近跑过的作业表 */
const JOBS = new Map()
let seq = 0

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
      child = spawn(process.execPath, [script], { cwd: root })
    } catch (e) {
      resolve({ script, code: -1, tail: String(e && e.message ? e.message : e) })
      return
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ script, code: -1, tail: tailOf(out, String(e && e.message ? e.message : e)) }))
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
 * @param {string} root 课程包根
 * @param {string[]} scripts 按序执行的无参脚本（**顺序有意义**：先归档、再重建产物）
 * @param {{ subject?: string }} [opts]
 * @returns {{id: string, subject: string, scripts: string[], done: boolean, index: number,
 *   steps: object[], rebuild: object|null, warnings: string[], failed: boolean,
 *   startedAt: number, endedAt: number|null, current: string|null}}
 */
export function startRebuild(root, scripts, { subject = '写入' } = {}) {
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
