/**
 * rebuild-job.mjs — 异步重建器（lib/rebuild-job.js）全部判据
 * ------------------------------------------------------------------
 * 铁律：全程只在 os.tmpdir() 下自己造的临时课程包里跑，**一次都不许写真包**。
 * 这里判的是三件事：
 *   ① 真的不阻塞（起完就返回，脚本还在跑）
 *   ② 顺序 / 失败不中断 / 退出码 / tail 口径与同步版**逐字一致**（单一真源）
 *   ③ 作业表可取、可等、可列
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ⚠️ 必须用**相对说明符**：绝对 Windows 路径（E:\...）在 ESM 里会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME
const {
  startRebuild, getRebuild, listRebuilds, waitRebuild, rebuildNow,
  runScriptAsync, summarize, tailOf, codeOf,
} = await import('../lib/rebuild-job.js')
const { rebuildArtifacts } = await import('../lib/ask-io.js')

let pass = 0
let fail = 0
const ok = (c, m) => { c ? (pass++, console.log('  ok   ' + m)) : (fail++, console.log('  FAIL ' + m + (c === false ? '' : ` (实得 ${JSON.stringify(c)})`))) }
const eq = (a, b, m) => ok(a === b, `${m}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbjob-'))
const write = (name, body) => { const p = path.join(root, name); fs.writeFileSync(p, body, 'utf8'); return name }

console.log('== 夹具 ==')
const OK = write('ok.js', 'process.exit(0)\n')
const FAIL3 = write('fail3.js', 'process.exit(3)\n')
const SLOW = write('slow.js', 'setTimeout(() => {}, 800)\n')
const LINES = write('lines.js', "console.log('l1');console.log('l2');console.log('l3')\n")
const NOEXIST = 'nope-not-here.js'
const ORDER = path.join(root, 'order.txt').replace(/\\/g, '/')
const S1 = write('s1.js', `require('fs').appendFileSync(${JSON.stringify(ORDER)}, '1\\n')\n`)
const S2 = write('s2.js', `require('fs').appendFileSync(${JSON.stringify(ORDER)}, '2\\n')\n`)
const S3 = write('s3.js', `require('fs').appendFileSync(${JSON.stringify(ORDER)}, '3\\n')\n`)
ok(true, '临时课程包建好：' + root)

console.log('== ① 真的不阻塞 ==')
{
	const t0 = Date.now()
	const job = startRebuild(root, [SLOW], { subject: '圆圈' })
	const elapsed = Date.now() - t0
	ok(elapsed < 250, `startRebuild 立刻返回（${elapsed}ms < 250ms，脚本还要跑 800ms）`)
	eq(job.done, false, '刚起来时 done=false（没在等它）')
	eq(job.current, SLOW, 'current 指向正在跑的那条')
	await sleep(120)
	eq(job.done, false, '120ms 后仍未跑完 —— 确实是异步的')
	const done = await waitRebuild(job.id)
	eq(done.done, true, 'waitRebuild 之后 done=true')
	ok(done.endedAt - done.startedAt >= 700, `端到端耗时 >= 800ms（实得 ${done.endedAt - done.startedAt}ms）`)
	eq(done.rebuild.ok, true, '慢脚本退出 0 → rebuild.ok=true')
}

console.log('== ② 顺序有意义 + 失败不中断 ==')
{
	fs.writeFileSync(ORDER, '')
	const job = startRebuild(root, [S1, S2, S3], { subject: '产物' })
	await waitRebuild(job.id)
	eq(fs.readFileSync(ORDER, 'utf8'), '1\n2\n3\n', '三条脚本**按传入顺序**执行')

	fs.writeFileSync(ORDER, '')
	const job2 = startRebuild(root, [S1, FAIL3, S3], { subject: '产物' })
	await waitRebuild(job2.id)
	eq(fs.readFileSync(ORDER, 'utf8'), '1\n3\n', '中间那条失败**不中断**后面的（剩下的产物仍要尽力重建）')
	eq(job2.steps.length, 3, 'steps 仍收满 3 条')
	eq(job2.rebuild.ok, false, '有失败 → rebuild.ok=false')
	eq(JSON.stringify(job2.rebuild.failed), JSON.stringify([FAIL3]), 'failed 点名失败的那条')
}

console.log('== ③ 退出码 / tail 口径 ==')
{
	const r = await runScriptAsync(root, FAIL3)
	eq(r.code, 3, '退出码如实回报（3）')
	const r2 = await runScriptAsync(root, LINES)
	eq(r2.code, 0, '成功脚本退出码 0')
	eq(r2.tail, 'l2 ／ l3', 'tail = 最后两行，用「 ／ 」连接')
	const r3 = await runScriptAsync(root, NOEXIST)
	ok(r3.code !== 0, `起不来的脚本 → 非零（实得 ${r3.code}）`)
	ok(r3.tail.length > 0, '起不来时 tail 里有原因，不是空手而归')
	eq(codeOf(null), -1, 'codeOf(null) = -1（拿不到状态不假装成功）')
	eq(tailOf('a\nb\nc', ''), 'b ／ c', 'tailOf 与 runScript 口径一致')
}

console.log('== ④ 单一真源：异步版与同步版告警**逐字相同** ==')
{
	const scripts = [S1, FAIL3, NOEXIST]
	const async_ = await rebuildNow(root, scripts, { subject: '圆圈' })
	const sync_ = rebuildArtifacts(root, scripts, { subject: '圆圈' })
	eq(JSON.stringify(async_.warnings), JSON.stringify(sync_.warnings), 'warnings 逐字节相同')
	eq(JSON.stringify(async_.rebuild), JSON.stringify(sync_.rebuild), 'rebuild{ok,failed} 逐字节相同')
	eq(async_.steps.length, sync_.steps.length, 'steps 条数相同')
	ok(async_.warnings[0].includes('退出码 3'), '告警里带真实退出码')
	ok(async_.warnings[0].includes('圆圈'), '告警里带人话主语')
	ok(async_.warnings[0].includes('产物的旧的') === false && async_.warnings[0].includes('产物可能是旧的'), '告警措辞与同步版一致')
	eq(JSON.stringify(summarize(async_.steps, '圆圈').warnings), JSON.stringify(async_.warnings), 'summarize 就是那一份实现')
}

console.log('== ⑤ 作业表 ==')
{
	const job = startRebuild(root, [OK], { subject: '台账' })
	eq(getRebuild(job.id)?.id, job.id, 'getRebuild 取得到')
	eq(getRebuild('rb-does-not-exist'), null, '不存在的 id → null（不抛错）')
	const list = listRebuilds()
	ok(list.length > 0, `listRebuilds 非空（${list.length} 条）`)
	ok(list.every((j) => typeof j.id === 'string' && 'done' in j), '每条都有 id 与 done')
	await waitRebuild(job.id)
	eq(getRebuild(job.id).done, true, '跑完后仍可取到（供页面轮询）')
	eq(await waitRebuild('rb-does-not-exist'), null, '等一个不存在的作业 → null')
}

console.log('== ⑥ 边角 ==')
{
	const empty = await rebuildNow(root, [], { subject: '空' })
	eq(empty.steps.length, 0, '空脚本清单不炸')
	eq(empty.rebuild.ok, true, '空清单 = ok（没有失败项）')
	eq(empty.warnings.length, 0, '空清单没有告警')
	// 同一个作业等两次都要能返回（waiters 不许被吞）
	const job = startRebuild(root, [SLOW], { subject: '双等' })
	const [a, b] = await Promise.all([waitRebuild(job.id), waitRebuild(job.id)])
	ok(a && b && a.id === b.id, '同一个作业被两个 waiter 同时等 → 两个都拿到')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
