#!/usr/bin/env node
/**
 * test/create-engine-error.mjs —— 写入口起重建的**四种"没起"**各说各的（Bug3）
 * ------------------------------------------------------------------
 * 跑：node test/create-engine-error.mjs
 *
 * 病（2026-10-19 修）：`lib/mods/create.js` 的 `kick()` 先去解构 `{job, present, missing}`、
 * 先判 `if (!job)` 再判引擎闸 —— 而引擎闸拒掉时 `startScripts()` 回的是
 * **`{job:null, engineError, engineMissing, engineMismatched, badPaths}`**（零 spawn）。
 * 于是"引擎被篡改"这一个分支掉进缺脚本分支，`missing` 是**空数组**，
 * 用户看到的是逐字「这个包里没有 」—— 一句没有宾语、也没有修法的话。
 *
 * 本套件钉住四件事（每条都是**真函数、真路由、真子进程**，不 mock）：
 *   ① 引擎拒：`engineError` 先于 `!job` 呈现，回执里有原因与修法，**零 spawn**（树不变 + 无作业记录）；
 *   ② 缺脚本：仍是那句「这个包里没有 X」（X 逐条列全），**不许**冒出空 missing 文案；
 *   ③ 队列忙：仍是「重建排队已满」，且 `busy:true`（不是"起了"）；
 *   ④ 正常：真起作业、真 spawn、链按顺序跑完。
 *   另加 ⑤：空链（`present` 与 `missing` 都为空）也不许拼出「这个包里没有 」。
 *
 * 为什么引擎拒要用**真模板包**（test/_fixture.mjs 的 createFixture）：它逐字节来自
 * `lib/pack-template/`，引擎闸是真核验、真判词；篡改一件（`tools/build-notes.js`）就得到
 * 真的 `engineError`。为什么缺脚本 / 队列忙 / 正常三支要用 `trustedEngine:false` 的桩包：
 * 引擎闸在最前面，缺脚本这一支在**受信包上根本走不到**（链上七件全是引擎件，缺一件先被
 * 引擎闸拦下）；桩包是仓内既有约定（见 test/rebuild-wiring.mjs 的 makePack），
 * 起的是**真的 node 子进程**，不是模拟。
 *
 * 反空转：把 kick() 的 `if (engineError)` 挪回 `if (!job)` 之后 ⇒ ① 必须红；
 *         把空 missing 的守卫拿掉 ⇒ ⑤ 必须红。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import './_pack.mjs'
import * as createMod from '../lib/mods/create.js'
import * as authorMod from '../lib/mods/author.js'
import {
	startRebuild, waitRebuild, listRebuilds, cancelAllRebuilds, MAX_QUEUE,
} from '../lib/rebuild-job.js'
import { createFixture } from './_fixture.mjs'

const createPlugin = createMod.plugin
/** `kick()` 是测试缝（只为了能单独钉"空链"那一支；其余四支都走真路由） */
const kick = createMod.kick
const authorPlugin = authorMod.plugin

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 20000, step = 25) => {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
	return false
}

/** 重建链（与 lib/mods/create.js 的 CIRCLE_CHAIN / LESSON_CHAIN 同一份事实） */
const CIRCLE = ['tools/circle-bands.js', 'tools/build-lessons.js', 'tools/build-starmap.js',
	'tools/build-starmap-svg.js', 'assets/build-glossary.js', 'tools/build-glossary-tree.js', 'tools/build-notes.js']
const LESSON = ['tools/build-lessons.js', 'tools/build-starmap.js']
const RAN = 'ran.txt'

/** 假 hctx：把路由捕获下来（照 test/rebuild-wiring.mjs 的做法）。`trustedEngine` 不传 = 严。 */
function installRoutes(mod, root, { trustedEngine } = {}) {
	const routes = []
	const hctx = {
		paths: { packRoot: root },
		log: { info() {}, warn() {}, error() {} },
		inject: (_deps, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	}
	if (trustedEngine !== undefined) hctx.trustedEngine = trustedEngine
	mod.install(hctx)
	return Object.fromEntries(routes.map((r) => [r.path, r]))
}
const call = async (route, body) => (await route.fetch(new Request('http://127.0.0.1:3090' + route.path, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body ?? {}),
}))).json()

/**
 * 桩包：真写进磁盘的**真脚本**（跑起来会 append 到 ran.txt —— 这就是"真的 spawn 了"的物证）。
 * 只给 circle 色表（建圈取色要用）与指定脚本，别的什么都没有。
 */
function makeStubPack(tag, scripts, { slowMs = 0 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cee-${tag}-`))
	fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
	fs.writeFileSync(path.join(dir, 'assets', 'circle-bands-data.js'),
		'module.exports = { hues: { halo: ["#7ec8ff", "#ff8fb1", "#8fd18f", "#ffd479", "#b39ddb"] }, entries: {'
		+ ' "#7ec8ff": { title: "A" }, "#ff8fb1": { title: "B" }, "#8fd18f": { title: "C" },'
		+ ' "#ffd479": { title: "D" }, "#b39ddb": { title: "E" } } }\n', 'utf8')
	for (const s of scripts) {
		const abs = path.join(dir, s)
		fs.mkdirSync(path.dirname(abs), { recursive: true })
		const sleepPart = slowMs ? `setTimeout(() => {}, ${slowMs});` : ''
		fs.writeFileSync(abs,
			`require('fs').appendFileSync(${JSON.stringify(path.join(dir, RAN).replace(/\\/g, '/'))}, ${JSON.stringify(s + '\n')});${sleepPart}\n`,
			'utf8')
	}
	return dir
}
const ranList = (dir) => {
	const f = path.join(dir, RAN)
	return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
}

/** 整棵树的内容指纹（rel → sha256）—— 用来证明"一个字节都没被生成器动过" */
function snapTree(root) {
	const out = new Map()
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name)
			if (e.isDirectory()) { walk(p); continue }
			out.set(path.relative(root, p).split(path.sep).join('/'),
				crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
		}
	}
	walk(root)
	return out
}
function diffTrees(a, b) {
	const added = [...b.keys()].filter((k) => !a.has(k)).sort()
	const removed = [...a.keys()].filter((k) => !b.has(k)).sort()
	const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort()
	return { added, removed, changed }
}

/** 那句子弹：`这个包里没有  ——`（宾语是空的）。**任何**回执都不许出现它。 */
const EMPTY_MISSING_RE = /这个包里没有\s*(?:——|-{2,}|$)/
const allNotes = []
const keep = (receipt, tag) => {
	if (receipt && typeof receipt.note === 'string') allNotes.push({ tag, note: receipt.note })
	return receipt
}

console.log('\n[create] 起重建的四种"没起"（引擎拒 / 缺脚本 / 队列忙 / 正常）')

/* ══════════ ① 引擎拒：真模板包 + 篡改一件引擎件 ⇒ 零 spawn、原因逐字带出 ══════════ */
{
	const fx = createFixture({ variant: 'multi-domain' })
	try {
		// 篡改一件引擎件（它同时在 CIRCLE_CHAIN 上）：字节与插件模板不一致 ⇒ 引擎闸必拒
		const victim = path.join(fx.root, 'tools', 'build-notes.js')
		fs.appendFileSync(victim, '\n// 2026-10-19 夹具：故意改坏一个字节（引擎闸应拒绝执行）\n', 'utf8')

		const byPath = installRoutes(createPlugin, fx.root)   // 不传 trustedEngine ⇒ 严
		ok(!!byPath['/api/whale/circle'] && !!byPath['/api/whale/point'] && !!byPath['/api/whale/circle/rename']
			&& !!byPath['/api/whale/group/save'] && !!byPath['/api/whale/circle/delete'], '六条写入口都挂上了')

		const jobsForRoot = () => listRebuilds().filter((j) => path.resolve(String(j.root)) === path.resolve(fx.root))
		eq(jobsForRoot().length, 0, '前置：这个包上还没有任何作业记录')

		/** 跑一条写入口，返回它的 rebuild 回执；顺带核"零 spawn"的物证 */
		const ranRoute = async (tag, route, body, allowedWrites) => {
			const before = snapTree(fx.root)
			const jobsBefore = listRebuilds().length
			const r = await call(route, body)
			const after = snapTree(fx.root)
			const d = diffTrees(before, after)
			const got = d.added.concat(d.changed).sort()
			ok(JSON.stringify(got) === JSON.stringify([...allowedWrites].sort()),
				`[${tag}] 只有入口自己写的那几处变了，生成器一件产物都没动（实变：${got.join('、') || '无'}）`)
			eq(listRebuilds().length, jobsBefore, `[${tag}] 作业记录一条都没多（引擎闸拒 ⇒ startScripts 连作业都不建）`)
			const rb = keep(r.rebuild, tag)
			const eng = String(rb?.engineError ?? '')
			ok(eng.length > 0, `[${tag}] 回执带 engineError（引擎拒不是"起了"）`)
			ok(eng.includes('不一致') && eng.includes('build-notes.js'),
				`[${tag}] engineError 逐字说清原因（不一致 + 点名被改坏的那件）：${eng.slice(0, 60)}…`)
			ok(rb && rb.jobId === null && rb.busy !== true, `[${tag}] 没起作业：jobId=null 且不是 busy`)
			ok(rb && typeof rb.note === 'string' && rb.note.includes('引擎') && !EMPTY_MISSING_RE.test(rb.note),
				`[${tag}] note 说的是引擎（不是空宾语那句）：${String(rb?.note).slice(0, 48)}…`)
			ok(/--plan/.test(eng) && /--apply --confirm --plan-digest=/.test(eng),
				`[${tag}] 修法里给了两步（--plan → --apply --confirm --plan-digest）`)
			return r
		}

		await ranRoute('建圈', byPath['/api/whale/circle'], { id: 'chem', name: '化学' }, ['lessons/chem/halo.json'])
		await ranRoute('建点', byPath['/api/whale/point'], { circle: 'math', id: 'geo', name: '几何' }, ['lessons/math/geo/point.json'])
		await ranRoute('改名', byPath['/api/whale/circle/rename'], { id: 'math', name: '数学·改' }, ['lessons/math/halo.json'])
		await ranRoute('建组', byPath['/api/whale/group/save'], { halo: 'math', name: '几何组', points: ['alge'] }, ['lessons/math/halo.json'])
		await ranRoute('删组', byPath['/api/whale/group/delete'], { halo: 'math', id: 'group-1' }, ['lessons/math/halo.json'])

		// 删圈走另一份夹具（它会把目录删掉，别的入口的"树不变"就没法量了）
		const fx2 = createFixture({ variant: 'multi-domain' })
		try {
			fs.appendFileSync(path.join(fx2.root, 'tools', 'build-notes.js'), '\n// 同上一份夹具：改坏一个字节\n', 'utf8')
			const byPath2 = installRoutes(createPlugin, fx2.root)
			const before = snapTree(fx2.root)
			const jobsBefore = listRebuilds().length
			const r = await call(byPath2['/api/whale/circle/delete'], { id: 'math', confirm: true })
			const d = diffTrees(before, snapTree(fx2.root))
			eq(listRebuilds().length, jobsBefore, '[删圈] 作业记录一条都没多')
			ok(d.added.length === 0 && d.changed.length === 0, `[删圈] 除了被删的目录，别处一个字节都没变（新增 ${d.added.length} / 改 ${d.changed.length}）`)
			const rb = keep(r.rebuild, '删圈')
			ok(String(rb?.engineError ?? '').includes('不一致'),
				`[删圈] 引擎拒的原因也带出来了：${String(rb?.engineError).slice(0, 48)}…`)
			ok(rb && rb.jobId === null && !EMPTY_MISSING_RE.test(String(rb?.note)), '[删圈] 没有拼出空宾语那句')
		} finally { fx2.dispose() }
	} finally {
		await cancelAllRebuilds(undefined, 'create-engine-error ① 收尾')
		fx.dispose()
	}
}

/* ══════════ ② 缺脚本：受信包上走不到这一支 ⇒ 桩包 + 文档里的显式旁路 ══════════ */
{
	const P = makeStubPack('none', [])           // 七件重建器一件都没有
	try {
		const byPath = installRoutes(createPlugin, P, { trustedEngine: false })
		const r = await call(byPath['/api/whale/circle'], { id: 'math', name: '数学' })
		const rb = keep(r.rebuild, '缺脚本')
		const note = String(rb?.note ?? '')
		ok(r.ok === true, '缺脚本不影响建圈本身成功' + (r.ok ? '' : '：' + r.error))
		eq(rb?.jobId ?? null, null, '全缺 ⇒ 不起作业（一个进程都不许平白起）')
		eq(rb?.missing ?? null, CIRCLE, '把缺的七条如实列全')
		ok(rb?.engineError === undefined, '这里没有引擎拒（不许把"包里没有"说成"引擎不一致"）')
		ok(note.includes('这个包里没有 ') && note.includes('tools/circle-bands.js'),
			`缺脚本那一句**一字不改**：「这个包里没有 X」（${note.slice(0, 40)}…）`)
		ok(!EMPTY_MISSING_RE.test(note), '这句的宾语不是空的（X 列全了）')
		eq(ranList(P), [], '零 spawn：桩脚本一个都没被跑过（ran.txt 还是空的）')
	} finally {
		fs.rmSync(P, { recursive: true, force: true })
	}
}

/* ══════════ ③ 空链：present 与 missing 都为空 ⇒ 也不许拼出「这个包里没有 」 ══════════ */
{
	const P = makeStubPack('emptychain', [])
	try {
		ok(typeof kick === 'function', 'kick() 作为测试缝可单独调用（空链这一支只有它能直接钉）')
		const rb = typeof kick === 'function'
			? keep(kick(P, [], '圆圈', { trustedEngine: false }), '空链')
			: null
		ok(!!rb, '空链回执拿得到')
		if (rb) {
			eq(rb.jobId, null, '空链 ⇒ 不起作业')
			eq(rb.missing, [], '空链的 missing 是空数组（旧代码正是把它拼成了空宾语）')
			ok(typeof rb.note === 'string' && !EMPTY_MISSING_RE.test(rb.note),
				`空链的文案里没有「这个包里没有 」（实得：${String(rb?.note)}）`)
			ok(/没有可跑|链是空的/.test(String(rb?.note)), '空链说的是"没有可跑的脚本"，与缺脚本分得开')
		}
	} finally {
		fs.rmSync(P, { recursive: true, force: true })
	}
}

/* ══════════ ④ 正常：真起作业、真 spawn、链按顺序跑完 ══════════ */
{
	const P = makeStubPack('normal', CIRCLE)
	try {
		const byPath = installRoutes(createPlugin, P, { trustedEngine: false })
		const t0 = Date.now()
		const r = await call(byPath['/api/whale/circle'], { id: 'math', name: '数学' })
		const elapsed = Date.now() - t0
		const rb = keep(r.rebuild, '正常')
		ok(r.ok === true, '建圈成功' + (r.ok ? '' : '：' + r.error))
		ok(typeof rb?.jobId === 'string' && rb.jobId.length > 0, '正常分支：回执里有 jobId（真起了作业）')
		ok(rb?.busy !== true && rb?.engineError === undefined, '正常分支：既不是 busy 也不是引擎拒')
		eq(rb?.scripts ?? null, CIRCLE, '回执里的 scripts 就是链上七条（顺序即执行顺序）')
		ok(elapsed < 1500, `入口没等脚本跑完（${elapsed}ms 就返回了）`)
		const done = rb?.jobId ? await waitRebuild(rb.jobId) : null
		ok(done && done.done === true, '作业真的跑完了')
		eq(ranList(P), CIRCLE, '七条**按链顺序**各跑了一次（真子进程，不是 mock）')
		eq(done?.rebuild?.ok ?? null, true, '全部退出 0')
	} finally {
		await cancelAllRebuilds(undefined, 'create-engine-error ④ 收尾')
		fs.rmSync(P, { recursive: true, force: true })
	}
}

/* ══════════ ⑤ 队列忙：满队时仍是「重建排队已满」，且零 spawn ══════════ */
{
	const SLOW = 'tools/_slow.js'
	const A = makeStubPack('busy-a', [...CIRCLE, SLOW], { slowMs: 8000 })
	const B = makeStubPack('busy-b', [SLOW], { slowMs: 8000 })
	try {
		// 两个**真在跑**的包占满 MAX_RUNNING 的槽位（桩包不是真包 ⇒ 走文档里的显式旁路）
		const TRUST = { trustedEngine: false }
		const blkA = startRebuild(A, [SLOW], { subject: 'cee-占位-A', ...TRUST })
		const blkB = startRebuild(B, [SLOW], { subject: 'cee-占位-B', ...TRUST })
		ok(await until(() => blkA.current === SLOW && blkB.current === SLOW), '前置：两条占位作业真的在跑')
		ok(await until(() => ranList(A).includes(SLOW)), '前置：占位脚本的物证已落盘（它真的 spawn 过）')

		// A 已在跑 ⇒ 同包的请求只能排队；排满 MAX_QUEUE 条（subject 不同，免得被合并）
		const queued = []
		for (let i = 0; i < MAX_QUEUE; i++) queued.push(startRebuild(A, [SLOW], { subject: `cee-排队-${i}`, ...TRUST }))
		eq(queued.filter((j) => j.state === 'queued').length, MAX_QUEUE, `前置：${MAX_QUEUE} 条在排队`)

		const byPath = installRoutes(createPlugin, A, { trustedEngine: false })
		const r = await call(byPath['/api/whale/circle'], { id: 'chem', name: '化学' })
		const rb = keep(r.rebuild, '队列忙')
		const note = String(rb?.note ?? '')
		ok(r.ok === true, '满队不影响建圈本身成功')
		ok(rb?.busy === true, '队列忙：回执里 busy:true（可判定的字段）')
		ok(typeof rb?.jobId === 'string', '队列忙也给了被拒的那条作业号（页面能查到它被拒）')
		ok(note.includes('重建排队已满') && note.includes(String(MAX_QUEUE)),
			`队列忙说的是「重建排队已满」且带上限：${note.slice(0, 40)}…`)
		ok(rb?.engineError === undefined && Array.isArray(rb?.missing) && rb.missing.length === 0,
			'队列忙不是"引擎拒"也不是"包里没有脚本"')
		// 被拒的那条作业**真的在记录里**（code=busy，不是"起了"；按 id/root 找，不数总数 ——
		// JOBS 有 trim()，数总数会被别的已完成作业回收掉）
		// 被拒的作业**有编号**（回执给的是那条被拒作业的 id，不是"起了"的 id）；
		// 注意不能用"作业表里找 code=busy"当判据 —— JOBS 有 trim()（KEEP=20），
		// 满队时表里全是未完成的排队作业，被拒的那条（done:true）可能刚被裁掉。
		ok(/^rb-\d+$/.test(String(rb?.jobId)), '被拒的作业也有编号（回执给的是那条被拒作业的 id）')
		eq(listRebuilds().filter((j) => j.state === 'running' && path.resolve(String(j.root)) === path.resolve(A)).length, 1,
			'A 上跑着的仍只有那条占位作业（链条一条都没多起）')
		eq(ranList(A), [SLOW], '零 spawn：七条链一件都没跑（ran.txt 里只有那条占位脚本）')
	} finally {
		const rep = await cancelAllRebuilds(undefined, 'create-engine-error ⑤ 收尾')
		ok(rep.ok === true && rep.count >= MAX_QUEUE, `收尾撤掉 ${rep.count} 条在等/在跑的作业（≥ ${MAX_QUEUE}）`)
		fs.rmSync(A, { recursive: true, force: true })
		fs.rmSync(B, { recursive: true, force: true })
	}
}

/* ══════════ ⑦ whale_author：同一处 bug 形状（lib/mods/author.js 的建课回执） ══════════
 * 病：`kicked.job && kicked.job.engineError` —— 引擎闸拒时 `startScripts` 回的是
 * `{job:null, engineError}`，`job` 是 null ⇒ 条件**永远为假**，引擎拒掉进
 * 「这个包里没有 」（missing 空时又是空宾语）。与 create.js 的 kick 是同一个形状。
 * 这里走的是**真工具**（plugin.install 捕获的 whale_author.execute）、真写盘、真模板包。
 */
function installAuthor(root, { trustedEngine } = {}) {
	const tools = []
	const hctx = {
		paths: { packRoot: root },
		log: { info() {}, warn() {}, error() {}, debug() {} },
		registerTool: (t) => tools.push(t),
		inject: () => {},
	}
	if (trustedEngine !== undefined) hctx.trustedEngine = trustedEngine
	authorPlugin.install(hctx)
	return tools[0]
}
/** 建第三课（`spring-boot` 在夹具里带 plan，硬校验才放得过；force 绕的是教学闸不是大纲闸） */
const AUTHOR_ARGS = {
	point: 'spring-boot', number: 3, title: '引擎拒探针', slug: 'engine-probe',
	hintTerm: '示波器', source: { label: 'x', url: 'y' }, commit: true, force: true,
}
/** 只允许"写课源"那一条变更（`lessons/src/**`）—— 别的一律算生成器动过盘 */
const onlySrcWrites = (changed) => changed.every((rel) => rel.startsWith('lessons/src/'))
const jobsOf = (root) => listRebuilds().filter((j) => path.resolve(String(j.root)) === path.resolve(root))

{
	const fx = createFixture({ variant: 'multi-domain' })
	try {
		// 篡改一件引擎件（它同时在 LESSON_CHAIN 上）
		fs.appendFileSync(path.join(fx.root, 'tools', 'build-lessons.js'),
			'\n// 2026-10-19 夹具：故意改坏一个字节（引擎闸应拒绝执行）\n', 'utf8')
		const tool = installAuthor(fx.root)          // 不传 trustedEngine ⇒ 严
		const before = snapTree(fx.root)
		const jobsBefore = jobsOf(fx.root).length
		const r = await tool.execute({ ...AUTHOR_ARGS })
		const d = diffTrees(before, snapTree(fx.root))
		const changed = d.added.concat(d.changed).sort()
		ok(r.ok === true && r.wrote === true, 'author 引擎拒时课**照样写**（写盘语义不变）' + (r.ok ? '' : '：' + r.error))
		ok(changed.length === 1 && onlySrcWrites(changed),
			`author 引擎拒零 spawn：只多了课源文件，生成器一件产物都没动（实变 ${changed.join('、') || '无'}）`)
		const rb = keep(r.rebuild, 'author-引擎拒')
		const eng = String(rb?.engineError ?? '')
		ok(eng.includes('不一致') && eng.includes('build-lessons.js'),
			`author 回执带引擎拒原因（不一致 + 点名那件）：${eng.slice(0, 56)}…`)
		ok(rb?.jobId === null && rb?.busy !== true, 'author 引擎拒：jobId=null 且不是 busy（不静默成"起了"）')
		ok(String(rb?.note ?? '').includes('引擎') && !EMPTY_MISSING_RE.test(String(rb?.note ?? '')),
			`author note 说的是引擎，不是空宾语那句：${String(rb?.note).slice(0, 40)}…`)
		ok(/--plan/.test(eng) && /--apply --confirm --plan-digest=/.test(eng), 'author 回执的修法也给了升级两步')
		eq(jobsOf(fx.root).length, jobsBefore, 'author 引擎拒：作业记录一条都没多')
	} finally { fx.dispose() }
}

{
	const fx = createFixture({ variant: 'multi-domain' })
	try {
		// 缺脚本：把两条重建器删掉（引擎核验会先红 ⇒ 用文档里的夹具旁路，只验"缺脚本"这一支）
		for (const s of LESSON) fs.rmSync(path.join(fx.root, s), { force: true })
		const tool = installAuthor(fx.root, { trustedEngine: false })
		const before = snapTree(fx.root)
		const r = await tool.execute({ ...AUTHOR_ARGS })
		const d = diffTrees(before, snapTree(fx.root))
		const changed = d.added.concat(d.changed).sort()
		ok(r.ok === true && r.wrote === true, 'author 缺脚本时课照样写')
		ok(changed.length === 1 && onlySrcWrites(changed), `author 缺脚本零 spawn：别处一个字节都没动（实变 ${changed.join('、') || '无'}）`)
		const rb = keep(r.rebuild, 'author-缺脚本')
		eq(rb?.missing ?? null, LESSON, 'author 把缺的两条如实列全')
		ok(rb?.jobId === null && rb?.engineError === undefined, 'author 缺脚本不是"引擎拒"也不是"起了"')
		const note = String(rb?.note ?? '')
		ok(note.includes('这个包里没有 ') && note.includes('tools/build-lessons.js'),
			`author 缺脚本那一句**一字不改**：「这个包里没有 X」（${note.slice(0, 40)}…）`)
		ok(!EMPTY_MISSING_RE.test(note), 'author 这句不是空宾语')
	} finally { fx.dispose() }
}

{
	// 正常：真模板包（引擎严）+ 真生成器 —— 断言重建**真跑完**且真写了盘
	const fx = createFixture({ variant: 'multi-domain' })
	try {
		const tool = installAuthor(fx.root)
		const before = snapTree(fx.root)
		const r = await tool.execute({ ...AUTHOR_ARGS })
		const rb = keep(r.rebuild, 'author-正常')
		ok(r.ok === true && r.wrote === true, 'author 正常分支：课写成了' + (r.ok ? '' : '：' + r.error))
		ok(typeof rb?.jobId === 'string' && rb?.busy !== true && rb?.engineError === undefined,
			'author 正常分支：真起了作业（jobId 在、不是 busy、不是引擎拒）')
		const job = rb?.jobId ? await waitRebuild(rb.jobId) : null
		ok(job?.done === true && job?.rebuild?.ok === true, 'author 正常分支：两条重建真跑完且全绿')
		eq((job?.steps ?? []).map((s) => s.script), LESSON, '跑的就是链上那两条（顺序即执行顺序）')
		const after = snapTree(fx.root)
		const d = diffTrees(before, after)
		const changed = d.added.concat(d.changed)
		ok(changed.includes('starmap/content.js'), `生成器真写了盘（starmap/content.js 被重建；实变 ${changed.join('、')}）`)
	} finally { fx.dispose() }
}

{
	// 队列忙：两个真在跑的包占满槽位 + 排满 MAX_QUEUE —— author 回执必须是 busy，链条零 spawn
	const SLOW = 'tools/_slow.js'
	const mkSlow = (dir) => {
		const f = path.join(dir, SLOW)
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f,
			`require('fs').appendFileSync(${JSON.stringify(path.join(dir, RAN).replace(/\\/g, '/'))}, ${JSON.stringify(SLOW + '\n')});`
			+ 'setTimeout(() => {}, 8000);\n', 'utf8')
	}
	const A = createFixture({ variant: 'multi-domain' })
	const B = createFixture({ variant: 'multi-domain' })
	try {
		mkSlow(A.root)
		mkSlow(B.root)
		const blkA = startRebuild(A.root, [SLOW], { subject: 'cee-author-占位-A' })
		const blkB = startRebuild(B.root, [SLOW], { subject: 'cee-author-占位-B' })
		ok(await until(() => blkA.current === SLOW && blkB.current === SLOW), '前置：两条占位作业真的在跑')
		ok(await until(() => ranList(A.root).includes(SLOW)), '前置：占位脚本的物证已落盘')
		const queued = []
		for (let i = 0; i < MAX_QUEUE; i++) queued.push(startRebuild(A.root, [SLOW], { subject: `cee-author-排队-${i}` }))
		eq(queued.filter((j) => j.state === 'queued').length, MAX_QUEUE, `前置：${MAX_QUEUE} 条在排队`)

		const tool = installAuthor(A.root)
		const before = snapTree(A.root)
		const r = await tool.execute({ ...AUTHOR_ARGS })
		const d = diffTrees(before, snapTree(A.root))
		const changed = d.added.concat(d.changed)
		const rb = keep(r.rebuild, 'author-队列忙')
		const note = String(rb?.note ?? '')
		ok(r.ok === true && r.wrote === true, 'author 满队时课照样写')
		ok(rb?.busy === true, 'author 队列忙：回执里 busy:true')
		ok(note.includes('重建排队已满') && note.includes(String(MAX_QUEUE)), `author 队列忙说的是「重建排队已满」：${note.slice(0, 40)}…`)
		ok(rb?.engineError === undefined, 'author 队列忙不是引擎拒')
		ok(changed.every((rel) => rel.startsWith('lessons/src/') || rel === RAN),
			`author 队列忙零 spawn：生成器一件产物都没动（实变 ${changed.join('、') || '无'}）`)
		eq(listRebuilds().filter((j) => j.state === 'running' && path.resolve(String(j.root)) === path.resolve(A.root)).length, 1,
			'A 上跑着的仍只有那条占位作业（课程链条一条都没多起）')
	} finally {
		await cancelAllRebuilds(undefined, 'create-engine-error ⑦ 收尾')
		A.dispose()
		B.dispose()
	}
}

/* ══════════ ⑧ 总账：所有回执里都不许出现空宾语那句 ══════════ */
{
	const bad = allNotes.filter((n) => EMPTY_MISSING_RE.test(n.note))
	eq(bad, [], `全部 ${allNotes.length} 条回执里没有一条拼出「这个包里没有 」（空宾语）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 引擎拒 / 缺脚本 / 队列忙 / 正常 四支各说各的 · 引擎拒零 spawn · 不再有空宾语文案')
