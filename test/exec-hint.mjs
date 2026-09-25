#!/usr/bin/env node
/**
 * test/exec-hint.mjs —— shell-out 的 EPERM 人话（新1）
 * ------------------------------------------------------------------
 * 跑：node test/exec-hint.mjs
 *
 * 要钉的三件：
 *   ① **纯函数**：EPERM / EACCES / ETIMEDOUT / ENOENT / 被信号 / 正常退出 —— 六种输入各自说什么，
 *      且**正常退出必须一个字都不说**（叫狼来了就是坏判据）。
 *   ② **真跑，不是合成**：`runAsync` 一个**不存在的可执行文件** ⇒ `failed` 必须 resolve 出人话；
 *      `runSync` 同样；而**成功的命令** `hint` 必须是空串。
 *   ③ 三条出路必须在文案里（inherit / 文件通道 / 无沙箱）—— 光说"权限不足"没用，
 *      看的人要知道往哪改。
 *
 * 反空转：把 lib/exec.js 的 EPERM 分支改掉 ⇒ ① 必须红。
 */

import { spawnFailureHint, isPermError, runSync, runAsync } from '../lib/exec.js'

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

console.log('\n[exec] shell-out 的 EPERM 人话')

// ① 纯函数六种输入
{
  const perm = spawnFailureHint({ error: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }) })
  ok(perm.includes('权限/沙箱边界'), 'EPERM：说的是**权限/沙箱边界**，不是"命令没跑"也不是"代码坏了"')
  ok(perm.includes('没起来'), 'EPERM：明说「子进程**没起来**」（而不是含糊的"失败了"）')
  ok(perm.includes('stdio') && perm.includes('inherit') && perm.includes('pick-folder'),
    'EPERM：给了**三条出路**（inherit / 文件通道（点名 pick-folder）/ 无沙箱）—— 看的人知道往哪改')

  const acc = spawnFailureHint({ error: Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
  ok(acc.includes('权限/沙箱边界') && acc.includes('inherit') && acc.includes('EACCES'),
    'EACCES 走**同一条**人话（同一类边界，不是两种解释）—— errno 原样带出来区分')

  const to = spawnFailureHint({ error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) })
  ok(to.includes('超时') && to.includes('ETIMEDOUT'), 'ETIMEDOUT：说的是超时被掐（不是权限）')

  const eno = spawnFailureHint({ error: Object.assign(new Error('e'), { code: 'ENOENT', path: 'C:/nope/x.exe' }) })
  ok(eno.includes('找不到可执行文件') && eno.includes('C:/nope/x.exe'), 'ENOENT：说是**找不到可执行文件**，并把路径带出来')

  const sig = spawnFailureHint({ status: null, signal: 'SIGKILL' })
  ok(sig.includes('SIGKILL'), '被信号掐：说清是被信号（不是它自己退出的）')

  ok(spawnFailureHint({ status: 0, stdout: 'ok' }) === '', '**正常退出一个字都不说**（叫狼来了就是坏判据）')
  ok(spawnFailureHint({}) === '', '没有 error 也没有 signal ⇒ 空串')

  ok(isPermError({ code: 'EPERM' }) && isPermError({ code: 'EACCES' }) && !isPermError({ code: 'ENOENT' }),
    'isPermError：只认 EPERM / EACCES')
}

// ② 真跑：不存在的可执行文件（真 ENOENT，不是合成对象）
{
  const r = runSync('definitely-not-a-real-exe-whale.exe', ['--x'], { encoding: 'utf8' })
  ok(r.status === null && typeof r.hint === 'string' && r.hint.includes('找不到可执行文件'),
    `runSync 真跑不存在的 exe ⇒ status=null 且 hint 是人话（${(r.hint || '').slice(0, 40)}…）`)

  const good = runSync(process.execPath, ['-e', 'process.stdout.write("hi")'], { encoding: 'utf8' })
  ok(good.status === 0 && good.stdout === 'hi' && good.hint === '',
    'runSync 成功时：行为与原生 spawnSync 相同（status/stdout 照旧），hint 是空串')

  const { failed } = runAsync('definitely-not-a-real-exe-whale.exe', [], { stdio: 'ignore' })
  const msg = await failed
  ok(typeof msg === 'string' && msg.includes('找不到可执行文件'),
    `runAsync 真跑不存在的 exe ⇒ failed resolve 出人话（而不是未捕获异常）：${(msg || '').slice(0, 40)}…`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ EPERM/超时/找不到 各说各的人话 · 正常退出不叫狼来了 · runAsync 不再把 error 变成未捕获异常')
