#!/usr/bin/env node
/**
 * rebuild-wiring.mjs — 三入口接重建（A：建圈 / 建知识点 / 建课程）全部判据
 * ------------------------------------------------------------------
 * 钉住四件事，每一件都是"以前没做、现在必须做"的：
 *
 *   ① **入口自己起重建**，不再只把清单丢给前端当文字看（板子 01-鲸师.md:361-366）
 *   ② **异步**：入口立刻返回，脚本还在跑 —— 建圈实为 6 个 node 进程，
 *      同步跑完学生要干等十几秒（这是 A 那条唯一的硬约束）
 *   ③ **链清单**：建圈 5 条、建知识点/建课程 2 条；两个入口的清单必须一致
 *      （create.js 的 LESSON_CHAIN ↔ author.js 的 LESSON_CHAIN，同一条对拍钉两边）
 *   ④ **缺件如实报**：新包是从模板长出来的，骨架只带一部分生成器 ——
 *      "脚本不在这个包里"与"脚本在、它自己跑挂了"必须分得开；全缺则**不起作业**
 *      （后半条还护着 test/intake.mjs 那 11 处 commit:true：影副本里没有脚本，
 *        所以一次进程都不许起，否则那套测试会被平白拖慢）
 *
 * 铁律：全程 os.tmpdir() 影副本，真包一个字节都不动。
 * 跑：node test/rebuild-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { plugin: createPlugin } = await import('../lib/mods/create.js')
const { plugin: authorPlugin } = await import('../lib/mods/author.js')
const { waitRebuild } = await import('../lib/rebuild-job.js')

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CIRCLE = ['tools/circle-bands.js', 'tools/build-lessons.js', 'tools/build-starmap.js', 'tools/build-starmap-svg.js', 'assets/build-glossary.js', 'tools/build-glossary-tree.js', 'tools/build-notes.js']
const LESSON = ['tools/build-lessons.js', 'tools/build-starmap.js']
const RAN = 'ran.txt'

/** 造一个影副本课程包：色带表（建圈要取色）+ 指定哪些重建脚本存在 */
function makePack(tag, scripts, { slowMs = 0 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rw-${tag}-`))
	fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
	// 色带冻结表：没有它 create 入口会拒色（批6 的硬行为），与本次要验的接线无关，故必须给。
	// ⚠️ 判据是 `!entries[key]` 就跳过（create.js:152）—— 光有 hues.halo 不算，每个色都要在 entries 里有定义
	fs.writeFileSync(path.join(dir, 'assets', 'circle-bands-data.js'),
		'module.exports = { hues: { halo: ["#7ec8ff", "#ff8fb1", "#8fd18f", "#ffd479", "#b39ddb"] }, entries: {'
		+ ' "#7ec8ff": { title: "A" }, "#ff8fb1": { title: "B" }, "#8fd18f": { title: "C" },'
		+ ' "#ffd479": { title: "D" }, "#b39ddb": { title: "E" } } }\n', 'utf8')
	fs.writeFileSync(path.join(dir, RAN), '', 'utf8')
	for (const s of scripts) {
		const abs = path.join(dir, s)
		fs.mkdirSync(path.dirname(abs), { recursive: true })
		const sleepPart = (slowMs && s === 'tools/build-lessons.js') ? `setTimeout(() => {}, ${slowMs});` : ''
		// ⚠️ 这里是**真换行**（'\n' 一个字符）：写成 '\\n' 会让桩脚本落进文件的是字面反斜杠+n，读回来就是一整行
		fs.writeFileSync(abs, `require('fs').appendFileSync(${JSON.stringify(path.join(dir, RAN).replace(/\\/g, '/'))}, ${JSON.stringify(s + '\n')});${sleepPart}\n`, 'utf8')
	}
	return dir
}

/** 假 hctx：把路由捕获下来（照 lib/mods/starter.js --selftest 的做法） */
function installRoutes(mod, root, routes) {
	const hctx = {
		paths: { packRoot: root },
		trustedEngine: false,
		log: { info() {}, warn() {}, error() {} },
		inject: (_deps, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	}
	mod.install(hctx)
	return hctx
}
const call = (route, url, init) => route.fetch(new Request(`http://127.0.0.1:3090${url}`, init))
const ranList = (dir) => fs.readFileSync(path.join(dir, RAN), 'utf8').split('\n').filter(Boolean)

console.log('== ① 建圈：入口自己起重建 ==')
const ALL = makePack('all', CIRCLE, { slowMs: 500 })
const routes = []
installRoutes(createPlugin, ALL, routes)
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]))
ok(!!byPath['/api/whale/circle'], `建圈路由挂上了（共 ${routes.length} 条）`)
ok(!!byPath['/api/whale/rebuild'], '新增查询口 /api/whale/rebuild 也挂上了')

const t0 = Date.now()
const r1 = await (await call(byPath['/api/whale/circle'], '/api/whale/circle', {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ id: 'math', name: '数学' }),
})).json()
const elapsed = Date.now() - t0
ok(r1.ok === true, '建圈成功' + (r1.ok ? '' : '：' + r1.error))
eq(r1.rebuild?.scripts, CIRCLE, '重建链 = 建圈五条（顺序即执行顺序）')
ok(typeof r1.rebuild?.jobId === 'string', '回执里给了作业号（前端据此轮询）')
ok(elapsed < 250, `**入口没等脚本**：${elapsed}ms 就返回了，而 build-lessons 要跑 500ms`)
eq(ranList(ALL).length, 0, '返回时脚本还没跑完（量的是真行为，不是声明）')

console.log('== ② 星图几秒后追上：作业跑完，且顺序正确 ==')
const done = await waitRebuild(r1.rebuild.jobId)
ok(done && done.done === true, '作业跑完了')
eq(ranList(ALL), CIRCLE, '五条**按链顺序**依次跑完')
eq(done.rebuild.ok, true, '全部退出 0 → rebuild.ok = true')
eq(done.warnings, [], '没有告警')

console.log('== ③ 查询口 ==')
const q1 = await (await call(byPath['/api/whale/rebuild'], `/api/whale/rebuild?id=${r1.rebuild.jobId}`)).json()
ok(q1.ok === true && q1.job && q1.job.done === true, '按 id 查得到，且已跑完')
ok(!('root' in q1.job), '作业形状里**没有 root**（本机绝对路径不该出现在响应里）')
// 从链推导，不写死数字：加删脚本（如 2026-09-24 补的 build-glossary-tree）不必再改这条
ok(q1.job.total === CIRCLE.length && q1.job.scripts.length === CIRCLE.length, `总数与清单都在（${CIRCLE.length} 条）`)
const q2 = await (await call(byPath['/api/whale/rebuild'], '/api/whale/rebuild?id=rb-does-not-exist')).json()
ok(q2.ok === true && q2.job === null, '查不到的 id → ok:true + job:null（不是错误状态）')
const q3 = await (await call(byPath['/api/whale/rebuild'], '/api/whale/rebuild')).json()
ok(Array.isArray(q3.jobs) && q3.jobs.length > 0, `不传 id → 列出最近作业（${q3.jobs?.length} 条）`)

console.log('== ④ 建知识点：只跑两条 ==')
const rP = await (await call(byPath['/api/whale/point'], '/api/whale/point', {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ circle: 'math', id: 'algebra', name: '代数' }),
})).json()
ok(rP.ok === true, '建知识点成功' + (rP.ok ? '' : '：' + rP.error))
eq(rP.rebuild?.scripts, LESSON, '重建链 = 两条（课程页 + 星图）')
await waitRebuild(rP.rebuild.jobId)
eq(ranList(ALL).slice(-2), LESSON, '跑的就是那两条')

console.log('== ⑤ 缺件如实报（新包只带一部分生成器）==')
const PART = makePack('part', LESSON)
fs.rmSync(path.join(PART, RAN), { force: true })
fs.writeFileSync(path.join(PART, RAN), '', 'utf8')
const routes2 = []
installRoutes(createPlugin, PART, routes2)
const byPath2 = Object.fromEntries(routes2.map((r) => [r.path, r]))
const r2 = await (await call(byPath2['/api/whale/circle'], '/api/whale/circle', {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ id: 'math', name: '数学' }),
})).json()
ok(r2.ok === true, '缺件不影响建圈本身成功')
eq(r2.rebuild?.scripts, LESSON, '只跑包里真有的两条')
eq(r2.rebuild?.missing, CIRCLE.filter((s) => !LESSON.includes(s)), 'missing 精确列出缺的五条')
ok(typeof r2.rebuild?.note === 'string' && r2.rebuild.note.includes('不在这个包里'), 'note 说清"缺的没跑"，不是静默略过')

console.log('== ⑥ 全缺：不起作业（护着 intake.mjs 那 11 处 commit:true）==')
const NONE = makePack('none', [])
const routes3 = []
installRoutes(createPlugin, NONE, routes3)
const byPath3 = Object.fromEntries(routes3.map((r) => [r.path, r]))
const r3 = await (await call(byPath3['/api/whale/circle'], '/api/whale/circle', {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ id: 'math', name: '数学' }),
})).json()
ok(r3.ok === true, '建圈本身仍成功')
eq(r3.rebuild?.jobId, null, '**不起作业**（一个进程都不许平白起）')
eq(r3.rebuild?.scripts, [], '没有可跑的脚本')
eq(r3.rebuild?.missing, CIRCLE, '把缺的七条如实列全')
ok(/产物不会自己长出来/.test(r3.rebuild?.note || ''), 'note 说清后果，不静默')

console.log('== ⑦ 建课程（whale_author commit:true）两个方向 ==')
const args = { point: 'vue', number: 1, title: '探针课', slug: 'probe', hintTerm: '示波器', source: { label: 'x', url: 'y' }, commit: true, force: true }

// ── 本节前置（T03-R1）：先把 `vue` 点**按产品自己的建点路径**建出来 ──────────
// 为什么必须补这一步：T03 把 `whale_author` 的硬校验全挪到提交前，其中「未知知识点必须拒」
// 是 **force 也绕不过** 的（force 只绕教学闸，不绕路径 / 结构 / 大纲）。而本节的夹具包
// （NONE / ALL）里原先都没有 `vue` 点 —— 所以按新规格它**必拒**，这一节变红是预期的。
// 这里改的是**夹具前提**，一个字都没动断言：`wrote===true` 那几条原样留着。
// 两条口都是产品自己的：① `POST /api/whale/point`（本套件 ④ 节就在用的那个建点口）；
// ② `whale_plan op=record`（建点之后补地图 —— 大纲闸与 author 的大纲闸**同一份判据**，
//    没地图照样拒建课，所以这一步也绕不开，不是为了让断言好过）。
const { plugin: planPlugin } = await import('../lib/mods/plan.js')

/** 在某个夹具包里建出 `math/vue` 点并挂上最小可用地图（= 第⑦节的夹具前提） */
async function plantVue(root, byPath) {
	const rp = await (await call(byPath['/api/whale/point'], '/api/whale/point', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ circle: 'math', id: 'vue', name: 'Vue' }),
	})).json()
	// 建点自己也会起重建作业（这个包里有脚本的话）—— 等它跑完，别和下面 author 的作业搅在一起
	if (rp.rebuild?.jobId) await waitRebuild(rp.rebuild.jobId)
	let planTool = null
	planPlugin.install({
		paths: { packRoot: root },
		trustedEngine: false,
		log: { info() {}, warn() {}, error() {} },
		registerTool: (t) => { planTool = t },
	})
	const vp = await planTool.execute({
		op: 'record',
		point: 'math/vue',
		goal: '把 vue 点建出来并挂上地图（第⑦节的夹具前提，不是判据）',
		nodes: [{
			no: 1,
			title: '探针课',
			deliverable: '一个建得出来的探针课页',
			criteria: 'whale_author commit:true 能落盘',
			why: '它证明「建课程」这条入口的重建接线是通的',
			sources: [{ label: '夹具出处（手写声明）', url: 'https://example.invalid/rebuild-wiring' }],
		}],
	})
	return { rp, vp }
}
await plantVue(NONE, byPath3)
await plantVue(ALL, byPath)

// 工具是通过 hctx.registerTool 注册的 —— 捕获它，然后直接驱动 execute
let captured = null
const hctxB = {
	paths: { packRoot: NONE },
	trustedEngine: false,
	log: { info() {}, warn() {}, error() {} },
	registerTool: (t) => { captured = t },
}
authorPlugin.install(hctxB)
ok(!!captured, 'whale_author 注册到了')
const vNone = await captured.execute(args)
eq(vNone.wrote, true, '基础：课程文件写出了')
eq(vNone.rebuild?.jobId, null, '**无脚本的包里不起作业**（影副本场景：测试不会被拖慢）')
eq(vNone.rebuild?.missing, LESSON, '如实列出缺的两条')

const hctxC = {
	paths: { packRoot: ALL },
	trustedEngine: false,
	log: { info() {}, warn() {}, error() {} },
	registerTool: (t) => { captured = t },
}
authorPlugin.install(hctxC)
const vAll = await captured.execute({ ...args, slug: 'probe2' })
eq(vAll.rebuild?.scripts, LESSON, '有脚本的包里：建课程跑的两条 == 建知识点那两条')
ok(typeof vAll.rebuild?.jobId === 'string', '同样给了作业号')
await waitRebuild(vAll.rebuild.jobId)
eq(ranList(ALL).slice(-2), LESSON, '建课程跑的确实是这两条')

for (const d of [ALL, PART, NONE]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } }
console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
process.exit(fails.length ? 1 : 0)
