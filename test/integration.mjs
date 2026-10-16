#!/usr/bin/env node
/**
 * integration.mjs —— **真实课程包入口**（T02 / 报告 F02）
 * ==================================================================
 * F02 的最小修法原话：「固定合成夹具作单测，**真实包另列 opt-in 集成**」。
 *
 * 所以两本账分工是这样的：
 *   - `node test/all.mjs`                  → 单测（默认合成夹具，自包含，不碰活包）
 *   - `node test/integration.mjs --pack=<绝对路径>` → **集成**（跑真包；显式 opt-in）
 *
 * 为什么真包要"另列"而不是当默认：
 *   ① 真包是**学生的工作区**（`code/` 里是真人代码、`learning-records/` 是真人台账），
 *      单测不该以它为前提 —— 换台机器、换个学生，单测就该照样跑得起来；
 *   ② 大量计数 / label 绑在"这个包今天长什么样"上（F02：「大量计数/label 绑定活包」），
 *      把它当默认输入，等于把"今天绿"变成"只有今天绿"。
 *
 * ⚠️ **副作用只在副本上**：本入口自己**不写**真包一个字节；套件里凡是有副作用的
 *    （建圈 / 重建 / 落盘分支）本来就只对 `os.tmpdir()` 下的影副本操作，
 *    真包侧的判据是"相对基线 git status 未变"。
 *
 * 用法：
 *   node test/integration.mjs --pack=<真课程包的绝对路径>
 *   node test/integration.mjs --pack=<绝对路径> --only=challenge-gate,pack-model
 *   DSH_WHALE_PACK=<绝对路径> node test/integration.mjs
 *
 * 退出码：与 `test/all.mjs` 一致（0 绿 / 1 红 / 2 材料缺失）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveTestContext, looksLikePack, PLUGIN } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

/** `--only=a,b`：只跑点名的那几套（透传给 run-all 的 `DSH_WHALE_SUITES`；**不设就全跑**）。 */
function flagValue(args, name) {
  const eq = `--${name}=`
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] ?? '')
    if (a.startsWith(eq)) return a.slice(eq.length)
    if (a === `--${name}` && i + 1 < args.length) return String(args[i + 1])
  }
  return undefined
}

const only = flagValue(argv, 'only')

// ── ① 输入：必须**显式**给一个真课程包（这个入口的存在意义就是"真包 opt-in"）──
let ctx
try {
  ctx = resolveTestContext({ argv, env: process.env })
} catch (e) {
  console.log('=== 集成（真包）===')
  console.log('  ❌ ' + String(e.message || e).split('\n')[0])
  console.log('\n=== 判词：红（输入无效，退出码 1）===')
  process.exit(1)
}
if (!ctx.packRoot) {
  console.log('=== 集成（真包）===')
  console.log('  ❌ 这个入口要**显式**给真课程包：--pack=<绝对路径>（或 DSH_WHALE_PACK=<绝对路径>）')
  console.log('     单测请用 `node test/all.mjs`（默认合成夹具，不依赖活包）。')
  console.log('\n=== 判词：红（材料缺失，退出码 2）===')
  process.exit(2)
}
if (!looksLikePack(ctx.packRoot)) {
  console.log('=== 集成（真包）===')
  console.log('  ❌ 不是课程包（判据：目录下有 presets/whale-sensei.css）：' + ctx.packRoot)
  console.log('\n=== 判词：红（材料缺失，退出码 2）===')
  process.exit(2)
}

const allScript = path.join(HERE, 'all.mjs')
if (!fs.existsSync(allScript)) {
  console.log('=== 集成（真包）===')
  console.log('  ❌ 缺 test/all.mjs（' + allScript + '）')
  process.exit(2)
}

// ── ② 真包集成 = 把**同一本账**跑在真包上（模式显式钉成 real）──
const childArgs = [allScript, `--pack=${ctx.packRoot}`, '--mode=real']
console.log('=== 集成（真包 opt-in）===')
console.log('  课程包：' + ctx.packRoot)
console.log('  模式　：real（显式；单测默认是合成夹具）')
if (only) console.log('  只跑　：' + only)
console.log('  ⚠️ 副作用只在副本上：本入口不写真包；套件里的写盘分支只动 os.tmpdir() 的影副本。')
console.log('')

const r = spawnSync(process.execPath, childArgs, {
  cwd: PLUGIN,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_WHALE_PACK: ctx.packRoot,
    DSH_WHALE_MODE: 'real',
    ...(only ? { DSH_WHALE_SUITES: only } : {}),
  },
})
const code = typeof r.status === 'number' ? r.status : 1
console.log(`\n=== 集成判词：${code === 0 ? '绿' : '红'}（退出码 ${code}）===`)
process.exit(code)
