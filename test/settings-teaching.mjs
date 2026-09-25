/**
 * settings-teaching.mjs —— 设置页「教学方式」的**路由面**判据
 * ==================================================================
 * 设置页那两条路由（`lib/mods/teaching.js`）：
 *
 *     GET  /api/whale/teaching           → 现行取值 + 注入原文（设置页渲染用）
 *     POST /api/whale/teaching/request   → 把「圆圈 + 学生原话」拼成给 agent 的正文（**只回文本**）
 *
 * 覆盖面：
 *   ① 两条都挂上了（path / methods），且**只**挂这两条（不偷偷多开通道）；
 *   ② GET 的形状：ok / configured / circles（含课程包里全部圆圈）/ global / locked；
 *   ③ 没配 packRoot → **200 + configured:false + 人话**（不是 503 空白 —— 与 status / catalog 同一立场）；
 *   ④ POST 拼正文：带圆圈、带学生原话；未知圆圈 / 空 / 超长 / 坏 JSON 都**当场拒**（不是静默凑合）；
 *   ⑤ **两条都不写盘**：跑完一圈，课程包（含台账）逐字节未变；
 *   ⑥ 路径覆盖：浏览器半边调的 teaching 路径 == 本模块注册的两条（不许多、不许少）；
 *   ⑦ 禁词表第 4 面（主人 2026-09-25 裁定）：**给 agent 读的两处全范围话术** ——
 *      `whale_teaching` 的工具描述 + 开课协议正文 —— 命中学科数不许恰好是 1。
 *      （这一面原先没人扫，实测里面躺着"多加点注释"这个编程举例，已清。）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { plugin as teachingPlugin } from '../lib/mods/teaching.js'
import { subjectsHit, GLOBAL_CIRCLE, TEACHING_DISCIPLINE, recordTeaching } from '../lib/teaching-io.js'
import { buildStarter } from '../lib/starter.js'
import { packRoot } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const ROOT = packRoot()
const VIEW = '/api/whale/teaching'
const REQUEST = '/api/whale/teaching/request'

let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
function hashTree(root) {
	const out = []
	const walk = (dir, rel) => {
		let es = []
		try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
		es.sort((a, b) => a.name.localeCompare(b.name))
		for (const e of es) {
			const r = rel ? rel + '/' + e.name : e.name
			if (e.isDirectory()) walk(path.join(dir, e.name), r)
			else out.push(r + ':' + sha(fs.readFileSync(path.join(dir, e.name))))
		}
	}
	walk(root, '')
	return out.join('|')
}

/** 装一次模块，收下它注册的路由与工具 */
function install(root) {
	const routes = []
	const tools = []
	teachingPlugin.install({
		paths: { packRoot: root },
		log: { info: () => {}, warn: () => {}, error: () => {} },
		registerTool: (d) => tools.push(d),
		inject: (_names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	})
	return { routes, tools }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-setteach-'))
// 真包基线：判据只在副本上跑，跑完真包必须**逐字节未变**（见 teaching-io.mjs ⑩ 的说明）。
const REAL_LEDGER = path.join(ROOT, 'learning-records', 'teaching.jsonl')
const realBefore = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null
try {
	fs.cpSync(ROOT, tmp, { recursive: true })
	fs.rmSync(path.join(tmp, 'learning-records', 'teaching.jsonl'), { force: true })

	const { routes, tools } = install(tmp)
	const paths = routes.map((r) => r.path).sort()
	const view = routes.find((r) => r.path === VIEW)
	const req = routes.find((r) => r.path === REQUEST)

	// ── ① 路由形状 ──
	{
		ok(paths.join(',') === [VIEW, REQUEST].sort().join(','),
			`只挂这两条路由（实得 ${paths.join(' / ') || '(无)'}）`)
		ok(view?.methods?.join(',') === 'GET', 'GET 那条只收 GET')
		ok(req?.methods?.join(',') === 'POST', 'POST 那条只收 POST')
		ok(view?.requestBody === 'buffered' && req?.requestBody === 'buffered',
			'两条都显式写了 requestBody=buffered（省略会被基座当 streaming —— 宿主侧的老坑）')
		ok(tools.length === 1 && tools[0].name === 'whale_teaching', '工具面仍然是那一个（没顺手多开工具）')
	}

	const get = (route = view, url = 'http://127.0.0.1:3090' + VIEW) => route.fetch(new Request(url))
	const post = (body, url = 'http://127.0.0.1:3090' + REQUEST) => req.fetch(new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	}))

	// ── ② GET 的形状 ──
	{
		const r = await get()
		const d = await r.json()
		ok(r.status === 200 && d.ok === true && d.configured === true, 'GET 回 200 / ok / configured')
		ok(Array.isArray(d.circles) && d.circles.length > 0, `GET 列出了圆圈（${d.circles.length} 个：${d.circles.map((c) => c.circle).join(' / ')}）`)
		ok(d.global?.circle === GLOBAL_CIRCLE, `GET 带全局层（circle='${GLOBAL_CIRCLE}'）`)
		ok(d.global?.items?.length === 3, '全局层三个可调项都在')
		ok(d.locked?.length === TEACHING_DISCIPLINE.length, 'GET 带锁死集（设置页要显示"说改也不改"）')
		ok(typeof d.global?.block === 'string' && d.global.block.includes('教学方式'), 'GET 带注入原文（全局层）')
		ok(Array.isArray(d.problems), 'GET 带 problems（坏行不静默丢）')
		const b = await (await post({})).json()
		ok(b.ok === false, '坏请求（没有 request 字段）被拒')
	}

	// ── ③ 没配 packRoot：200 + 人话 ──
	{
		const bare = install(undefined)
		const r = await bare.routes.find((x) => x.path === VIEW).fetch(new Request('http://127.0.0.1:3090' + VIEW))
		const d = await r.json()
		ok(r.status === 200, '没配 packRoot 时 GET 仍回 200（不是 503 空白）')
		ok(d.ok === false && d.configured === false, '并明确说 configured:false')
		ok(/packRoot/.test(d.error) && /cordis\.patch\.yml/.test(d.error), '错误信息里给出修法（去哪配 packRoot）')
		const r2 = await bare.routes.find((x) => x.path === REQUEST).fetch(new Request('http://127.0.0.1:3090' + REQUEST, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ circle: GLOBAL_CIRCLE, request: '讲慢一点' }),
		}))
		const d2 = await r2.json()
		ok(r2.status === 200 && d2.configured === false, 'POST 同样回 200 + configured:false（说人话）')
	}

	// ── ④ POST：拼正文 + 各类拒 ──
	{
		const circle = (await (await get()).json()).circles[0].circle
		const words = '讲慢一点，多给我画点图'
		const r = await post({ circle, request: words })
		const d = await r.json()
		ok(r.status === 200 && d.ok === true, 'POST 正常请求 → 200 / ok')
		ok(typeof d.text === 'string' && d.text.includes(words), 'POST 回的正文里带**学生原话**')
		ok(d.text.includes(`circle="${circle}"`), 'POST 回的正文里点名了哪一层')
		ok(d.circle === circle && d.chars === d.text.length, 'POST 回了 circle 与 chars（浏览器半边不用自己数）')

		const g = await (await post({ circle: GLOBAL_CIRCLE, request: '讲慢一点' })).json()
		ok(g.ok === true && g.text.includes('全局层'), `全局层（'${GLOBAL_CIRCLE}'）也拼得出正文`)

		const unknown = await post({ circle: 'no-such-circle-zzz', request: '讲慢一点' })
		const ud = await unknown.json()
		ok(unknown.status === 400 && ud.ok === false, '未知圆圈 → 400 拒（不拼一段指向不存在圆圈的话让老师猜）')
		ok(/没有圆圈/.test(ud.error), '拒的时候说清是"没有这个圆圈"')

		const empty = await post({ circle, request: '   ' })
		const ed = await empty.json()
		ok(empty.status === 400 && ed.ok === false, '空要求 → 400 拒')

		const long = await post({ circle, request: '啊'.repeat(301) })
		const ld = await long.json()
		ok(long.status === 400 && ld.ok === false, '超长 → 400 拒')
		ok(/301/.test(ld.error), '拒的时候说出实际字数（不静默截断）')

		const bad = await post('{not json')
		ok(bad.status === 400, '坏 JSON → 400（不是 500 崩）')

		const wrong = await view.fetch(new Request('http://127.0.0.1:3090' + VIEW, { method: 'POST' }))
		ok(wrong.status === 405, 'GET 那条收到 POST → 405')
		const wrong2 = await req.fetch(new Request('http://127.0.0.1:3090' + REQUEST))
		ok(wrong2.status === 405, 'POST 那条收到 GET → 405')
	}

	// ── ⑤ 两条都不写盘 ──
	{
		const before = hashTree(path.join(tmp, 'learning-records'))
		await get()
		await post({ circle: GLOBAL_CIRCLE, request: '讲慢一点' })
		await post({ circle: (await (await get()).json()).circles[0].circle, request: '讲慢一点' })
		ok(hashTree(path.join(tmp, 'learning-records')) === before, '跑完一圈：台账**逐字节未变**（这两条路由是只读 + 只回文本）')
		ok(!fs.existsSync(path.join(tmp, 'learning-records', 'teaching.jsonl')), '也没有偷偷建出 teaching.jsonl')
	}

	// ── ⑥ 路径覆盖：浏览器半边调的 == 本模块注册的 ──
	{
		const client = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
		const used = new Set((client.match(/\/api\/whale\/teaching[\/a-z]*/g) || []).map((s) => s.replace(/\/$/, '')))
		ok(used.size === 2 && used.has(VIEW) && used.has(REQUEST),
			`浏览器半边调的 teaching 路径正好是注册的那两条（实得 ${[...used].join(' / ') || '(无)'}）`)
		// 扫**代码**不扫注释：这个文件的注释里就写着"落盘口只有 recordTeaching 一处"（实测踩过）。
		const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
		ok(!/teaching-io|teaching-apply|recordTeaching/.test(code),
			'浏览器半边**不引台账实现**（不拼话术、不自己校验 —— 都走宿主那两条）')
	}

	// ── ⑦ 禁词表第 4 面：给 agent 读的两处全范围话术 ──
	{
		const desc = String(tools[0]?.description || '')
		const hit = subjectsHit(desc)
		ok(hit.length !== 1, `禁词表 · whale_teaching 工具描述：不是只对一个学科成立（命中 ${hit.length} 个：${hit.join('/') || '无'}）`)
		ok(desc.length > 100, '（反空转）工具描述真的读到了内容，不是空串蒙混')

		const prompt = String(buildStarter(tmp)?.prompt || '')
		const hit2 = subjectsHit(prompt)
		ok(hit2.length !== 1, `禁词表 · 开课协议正文：不是只对一个学科成立（命中 ${hit2.length} 个：${hit2.join('/') || '无'}）`)
		ok(prompt.includes('② 看挑战') && prompt.length > 500, '（反空转）协议正文真的读到了内容')
		ok(prompt.includes('教学方式') && prompt.includes('whale_teaching'), '协议里仍写着 ②e 教学方式那一步（没被清词清掉）')
	}

	// ── ⑧ 渲染级：真的把「教学方式」卡渲一遍，看文本里有没有该有的东西 ──
	//
	// 上面 ①–⑦ 都是"宿主那一半"。这一块拿 `settings-catalog.mjs` 那套 mini-React 桩
	// 把 `StatusPanel` **真渲一次**（无 DOM，只收文本节点）—— 光扫源码不算验证。
	{
		const circle = (await (await get()).json()).circles[0].circle
		recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 1, params: { explainOrder: 'detail-first' }, source: 'student' })
		recordTeaching(tmp, {
			circle, kind: 'values', tier: 1, params: {},
			freeText: [{ text: '多讲点例子', source: 'student', confirmed: true }], source: 'student',
		})
		// 固定做法（`kind=guide`）：学生改不了，但设置页得让他**看得见**
		recordTeaching(tmp, { circle, kind: 'guide', source: 'agent', guide: [
			{ title: '动笔前先看他的产出', lines: ['列源码树，忽略构建产物与编辑器噪音。'] },
		] })
		const payload = (await (await get()).json())

		const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
		const prim = { Modal: function Modal() {}, Button: function Button() {} }
		let cursor = 0
		const slots = []
		const miniR = {
			createElement: (type, p, ...kids) => {
				const flat = kids.flat(Infinity)
				return { type, props: p || {}, children: flat.filter((k) => k != null && k !== false) }
			},
			useState(init) {
				const i = cursor++
				if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
				return [slots[i], () => {}]
			},
			useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
			useEffect() { cursor++ },
		}
		const req2 = (n) => {
			if (n === 'react') return miniR
			if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
			throw new Error('意外 require：' + n)
		}
		const fakeW = { __ModuleLoader__: { load: () => {} }, setTimeout: (fn) => setTimeout(fn, 0), prompt: () => {} }
		let mod = null
		fakeW.__ModuleLoader__.load = (m) => { mod = m }
		new Function('window', 'require', src)(fakeW, req2)
		const regs = []
		mod.factory(req2).apply({
			slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs.push({ spec, comp: c }); return () => {} } },
			effect: (fn) => fn(),
		})
		const Comp = regs.find((r) => r.spec.id === 'whale-sensei')?.comp

		// 槽位是**位置式**的（mini-React 按调用次序分配）：
		//   StatusPanel 0–3（state / tick / pick / useEffect）
		//   CatalogPanel 4–11（catState / catTick / expanded / rename / newCircle / del / notice / useEffect）
		//   TeachingPanel 12–16（state / drafts / sends / collapsed / useEffect）
		// ⚠️ 这个桩对**结构变化**很脆：谁在前面插一个 useState，下面全错位。
		//    所以渲染完有一条 `cursor` 判据兜底（见文末），错位会当场红而不是静默少渲染。
		slots[0] = { phase: 'ok', data: { ok: true, configured: true, sections: [] }, at: null }
		slots[1] = 0
		slots[2] = null
		slots[4] = { phase: 'ok', data: null, error: '（本判据不测目录卡）' }
		slots[5] = 0
		slots[6] = {}
		slots[7] = {}
		slots[8] = { open: false, name: '', id: '', saving: false, error: null }
		slots[9] = null
		slots[10] = null
		slots[12] = { phase: 'ok', data: payload, error: null }
		slots[13] = {}
		slots[14] = {}
		slots[15] = {}

		const texts = []
		const walk = (node) => {
			if (node == null || node === false) return
			if (typeof node === 'string') { texts.push(node); return }
			if (Array.isArray(node)) { node.forEach(walk); return }
			if (typeof node.type === 'function') {
				try { walk(node.type(node.props || {})) } catch { /* 桩求值失败不算红，靠下面的断言兜 */ }
				return
			}
			if (node.children) node.children.forEach(walk)
			if (node.props?.children) {
				const ch = node.props.children
				Array.isArray(ch) ? ch.forEach(walk) : walk(ch)
			}
		}
		walk(Comp({}))
		const all = texts.join(' ')

		ok(typeof Comp === 'function', '拿得到设置节那个组件（whale-sensei）')
		ok(cursor === 17, `渲染消耗 ${cursor} 个 hook 槽位（预期 17 —— 对不上说明面板结构变了，上面的槽位表要跟着更新）`)
		ok(all.includes('教学方式'), '渲染结果里有「教学方式」这一块')
		ok(all.includes('老师下次生成课程时，实际会收到这一段'), '渲染结果里带「注入原文」的说明')
		ok(all.includes(payload.circles[0].name), `渲染结果里有圆圈名（${payload.circles[0].name}）`)
		ok(all.includes('先给细节'), '渲染结果里显示的是**生效值**那句指令（全局层改了 explainOrder）')
		ok(all.includes('继承全局层'), '圆圈那一行标出"继承全局层"（没把全局取值当圆圈特化）')
		ok(all.includes('发给老师'), '渲染结果里有「发给老师」按钮')
		ok(all.includes('多讲点例子'), '渲染结果里带自由补充（如实说它进备课上下文）')
		ok(all.includes('这个圆圈的固定做法'), '渲染结果里有「固定做法」那一段（P2 加的）')
		ok(all.includes('动笔前先看他的产出') && all.includes('列源码树，忽略构建产物与编辑器噪音。'),
			'固定做法的标题与每一行都渲染出来了（学生看得见，但他改不了）')
		ok(all.includes('教学纪律'), '渲染结果里带锁死集那一行')
		ok(all.includes('⚙️ 教学方式'), '渲染结果里带注入块原文（老师真收到的那段）')
		ok(all.includes('这个圆圈还没声明可调项'), '圆圈没声明 spec 时，渲染结果里如实说（不假装能调）')
	}

	// ── ⑨ 作用域守卫：点按钮那条路，渲染桩走不到 ──
	//
	// `tellTeacher()` 只在**点「发给老师」**时才跑（渲染桩不点按钮），所以它用的
	// `readJson` / `pushToComposer` / `copyPrompt` 要是被挪出工厂作用域，
	// **点了才炸、而所有判据全绿** —— 那是最坏的一类漏。这里机械地钉一下。
	{
		const lines = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8').split(/\r?\n/)
		const start = lines.findIndex((l) => /factory:\s*\(require\)/.test(l))
		let end = -1
		for (let i = start + 1; i < lines.length; i++) {
			if (/^\t\},?\s*$/.test(lines[i]) || /^\}\s*;?\s*$/.test(lines[i])) { end = i; break }
		}
		const deps = ['function TeachingPanel', 'function setAt', 'function TeachingRow',
			'function pushToComposer', 'function copyPrompt', 'function btn(', 'var STATE_COLOR', 'function readJson']
		const outside = deps.filter((d) => {
			const i = lines.findIndex((l) => l.includes(d))
			return i <= start || i >= end
		})
		ok(start > 0 && end > start && outside.length === 0,
			`教学卡依赖的东西都在工厂作用域里（跑到外面去的：${outside.join(' / ') || '无'}）`)
	}

	const realAfter = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null
	ok(realAfter === realBefore,
		`真包台账跑完之后与跑之前逐字相同（${realBefore === null ? '两边都没有' : '两边都有，比内容'}）`)
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }
console.log('✅ 两条路由 · 只读不写盘 · 拒得清楚 · 路径覆盖 · 话术面学科中立')
