#!/usr/bin/env node
/**
 * test/ci.mjs —— **两本账在 CI 里的唯一入口**（§7，2026-09-22）
 * ------------------------------------------------------------------
 * 它就是"CI 该怎么跑"的可执行契约：先**响亮地**查前置（缺什么说什么、说清怎么补），
 * 再跑 `node test/all.mjs`（课程包闸门 + 插件全套），最后打一行判词并以它的退出码收场。
 *
 * 用法：
 *   node test/ci.mjs                 查前置 → 跑两本账
 *   node test/ci.mjs --check-env     只查前置（给 CI 的 setup 步骤用，秒级）
 *
 * 为什么前置要单独查：CI 上最常见的失败不是"代码错"，而是**环境没摆齐**
 * （课程包没整份检出 / 少 `code/`、`demo/`、`_starmap-proto/` / `DSH_WHALE_PACK` 没设）。
 * 那些如果不预先报，就会表现成一堆看不通的套件红，白烧一轮。
 * 详细契约（要哪几个位置、为什么必须串行、哪些坑踩过）见 `_plugin-prep/CI-两本账契约.md`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packRoot, PLUGIN } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const onlyEnv = process.argv.includes('--check-env')

/** 前置清单：[相对包根的路径, 是否必需, 缺了会怎样] */
const PACK_NEEDS = [
	['presets/whale-sensei.css', true, '判据"这像不像课程包"就靠它（见 test/_pack.mjs）'],
	['tools/gate.mjs', true, '课程包闸门的入口'],
	['assets/_frame.html', true, '课程页外壳模板'],
	['_plugin-prep/待改清单.md', true, '闸门的文档索引对账要读它'],
	['code', true, '闸门有检查要读学生工作区'],
	['demo', false, '闸门有检查要读它；缺了会有几条红，不是代码错'],
	['_starmap-proto', false, '同上'],
	['assets/circle-bands-data.js', false, '§11 的圈色冻结表；缺了圈色带检查会红'],
]

const problems = []
const notes = []

let PACK = null
try {
	PACK = packRoot()
} catch (e) {
	problems.push(String(e.message || e).split('\n')[0])
}

if (PACK) {
	for (const [rel, required, why] of PACK_NEEDS) {
		const abs = path.join(PACK, rel)
		if (!fs.existsSync(abs)) (required ? problems : notes).push(`课程包缺 ${rel} —— ${why}`)
	}
	// 课程包必须在 git 下（套件的"真包零改动"判据靠它；没有 git 会静默跳过而非报错）
	if (!fs.existsSync(path.join(PACK, '.git'))) notes.push('课程包不在 git 下：套件里"真包零改动"那几条会比不出结果（不致命，但别指望它守门）')
}

if (!fs.existsSync(path.join(PLUGIN, 'test', 'all.mjs'))) problems.push(`插件缺 test/all.mjs —— CI 要跑的就是它（当前插件根 ${PLUGIN}）`)

// 打印
console.log('=== CI 前置检查（两本账）===')
console.log(`插件根：${PLUGIN}`)
console.log(`课程包：${PACK || '（没找到）'}`)
for (const n of notes) console.log(`  ⚠ ${n}`)
if (problems.length) {
	console.log('')
	for (const p of problems) console.log(`  ❌ ${p}`)
	console.log('\n=== 前置检查：不通过（先补齐上面这些，再跑两本账）===')
	process.exit(2)
}
console.log('  ✅ 必需项齐')
if (onlyEnv) {
	console.log('\n=== 前置检查：通过（--check-env，未跑两本账）===')
	process.exit(0)
}

// 串行跑两本账。**不要在这里并行跑套件** —— tools/preset-switch.test.mjs 直接写课程包本体，
// 两个进程同时对着同一个包跑会互踩出假红（2026-09-22 实测两次）。
// 把解析到的包根**灌进环境变量**再 spawn：all.mjs 把包路径交给每个套件时靠的就是它，
// 少了这一行，CI 上（包不在 ../study）套件会各自去猜路径。
process.env.DSH_WHALE_PACK = PACK
console.log('\n=== 跑两本账（串行；期间不要改课程包里的任何文件）===\n')
const r = spawnSync(process.execPath, [path.join(HERE, 'all.mjs'), PACK], { stdio: 'inherit' })
const code = r.status ?? 1
console.log(`\n=== CI 判词：${code === 0 ? '绿' : '红'}（退出码 ${code}）===`)
process.exit(code)
