/**
 * lib/exec.js — 所有 shell-out 的**唯一入口**（EPERM 人话 + 收敛）
 * ------------------------------------------------------------------
 * 为什么要有它：本机反复踩同一类坑 —— **受限沙箱下 piped stdio（默认 `stdio:'pipe'` +
 * 捕获输出）spawn 会 EPERM**（命名管道打不开）。可它报出来是 `status = null` / `exit code -1`，
 * 看的人会误判成「命令没跑」或「代码坏了」。9 处 shell-out 各自为政时，这句话得说 9 遍，
 * 而且每处说得都不一样。
 *
 * 判据来源（都是本机实测，不是推演）：
 *   · `SESSION-LESSONS.md:658` —— 沙箱 workspace-write 下 Node 的管道 stdio 会 spawn EPERM
 *   · `SESSION-LESSONS.md:238` —— 改用「argv 传参 + 结果写 JSON 文件 + 主侧读文件」的文件通道
 *   · `lib/pick-folder.js:9`   —— 结果走临时文件，不走管道（本仓已实测）
 *   · `lib/pack-template/tools/build-public.js:383` —— stdio 必须 inherit（EPERM）
 *   · `test/mirror-parity.mjs:110` —— `stdio:'ignore'` 不碰管道，也就没有 EPERM 的坑
 *
 * 三条出路（按代价排序）：
 *   ① `stdio:'inherit'` —— 子进程直接写宿主终端，不经过管道
 *   ② `stdio:'ignore'` + **结果写文件、主侧读文件**（`lib/pick-folder.js` 的现成做法）
 *   ③ 在**没有沙箱**的环境里跑（本机 DSH 默认 danger-full-access 就是这种）
 *
 * ⚠️ 这个模块**只做翻译与收敛，不替调用方决定 stdio**：改 stdio 会改行为（有些地方必须
 *    捕获输出），那是各调用点的判断。它负责的是「失败时把话说清楚」。
 */

import { spawn, spawnSync } from 'node:child_process'

/** 权限/沙箱类的 errno —— 这两类要按「边界」讲，不能按「代码坏了」讲 */
export function isPermError(e) {
  const c = e?.code
  return c === 'EPERM' || c === 'EACCES'
}

/**
 * 把一个 spawn/spawnSync 的失败**翻成人话**。成功（或没有 error）时返回空串。
 *
 * @param {{ status?: number|null, error?: any, signal?: string|null }} r - spawnSync 的返回值，或 { error }
 * @returns {string} 空串 = 没什么好说的（正常退出）；非空 = 该把这句话带出去
 */
export function spawnFailureHint(r) {
  const e = r?.error
  if (!e) {
    if (r?.signal) return `子进程被信号 ${r.signal} 掐掉（不是它自己退出的）。`
    return ''
  }
  if (isPermError(e)) {
    return `子进程**没起来**：${e.code}（权限/沙箱边界）—— 这不是「命令没跑」也不是代码坏了。`
      + '最常见成因：受限沙箱下 Node 用**管道 stdio**（默认 `stdio:\'pipe\'`）捕获子进程输出会被拒（命名管道打不开）。'
      + '出路：① 改 `stdio:\'inherit\'`（子进程直接写终端）② `stdio:\'ignore\'` + **结果写文件再读**'
      + '（见 `lib/pick-folder.js`）③ 在无沙箱环境跑。'
  }
  if (e.code === 'ETIMEDOUT') return '子进程**超时**被掐（ETIMEDOUT）—— 它可能还在跑，也可能卡住了。'
  if (e.code === 'ENOENT') return `**找不到可执行文件**（ENOENT）：${e.path || '(未给出路径)'}`
  return `子进程没起来：${e.code || e.message || e}`
}

/**
 * `spawnSync` 的包装：**行为与原版一致**，只是多带一句 `hint`（失败时的人话）。
 * 不吞错误、不改 status —— 调用方拿到的 `status` / `stdout` / `stderr` 与直接调 spawnSync 相同。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts] 透传给 spawnSync（**stdio 由调用方决定**）
 */
export function runSync(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { ...r, hint: spawnFailureHint(r) }
}

/**
 * `spawn` 的包装：**补上 error 事件**（裸 `spawn` 不监听 `error` 时，EPERM/ENOENT 会变成
 * 未捕获异常把进程带走 —— `lib/cdp.js` 原来就是这样）。
 *
 * 返回 `{ child, failed }`：`failed` 是一个 Promise，子进程**没能起来**时 resolve 成人话，
 * 起来了就一直 pending（调用方照常用 child 的事件）。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
export function runAsync(cmd, args = [], opts = {}) {
  const child = spawn(cmd, args, opts)
  let onError = null
  const failed = new Promise((resolve) => { onError = (e) => resolve(spawnFailureHint({ error: e })) })
  child.once('error', onError)
  return { child, failed }
}
