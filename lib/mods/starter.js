/**
 * lib/mods/starter.js — 能力模块：开课入口（弹窗的数据面 + 拼装）
 * ------------------------------------------------------------------
 * 弹窗是浏览器半边（`lib/client.js`，注册在 `shell.overlay` 上）画的，但它**自己不持有任何话术**：
 *
 *   GET  /api/whale/starter            → { ok, configured, packRoot, entry }
 *        `entry` = `lib/starter.js` 的载荷：按钮文案、四步协议全文、**弹窗字段与模板**
 *   POST /api/whale/starter { values } → { ok, text }
 *        把学生填的回答按模板拼成「开课请求」正文（拼装规则也住在 `lib/starter.js`）
 *
 * 为什么两条都在宿主侧：**四步协议只能有一份实现**。浏览器半边只负责收集 `values`
 * 与把返回的文本送进输入框；话术、字段表、必填校验、拼装全在 `lib/starter.js`（纯函数，可对拍）。
 *
 * ⚠️ POST 除了拼文本，还**落终点契约**：把 wizard 收到的作品 / 档位 / 验收判据追加进
 *    `<packRoot>/learning-records/goals.jsonl`（② 契约 §3.2：本路由是**唯一写入者**，
 *    落盘函数 = `lib/goal-io.js` 的 `recordGoal()`，换终点 = append 新版本留痕）。
 *    拿不到课程包（没配 packRoot）或没有归属（没传 pointId）时**只拼文本、不落盘**，
 *    返回体带 `goalSaved:false, goalHint:"终点还没结构化：…"`（B6 回落，不报错）。
 *    GET 则在没配 `packRoot` 时也回 200 并把修法写在 `hint` 里 —— 与 `/api/whale/status` 同一立场：
 *    这一节存在的意义就是把"没配"当场显示出来，而不是回一个看不出怎么修的错误。
 *
 * 跨站栅栏与浏览器认证是**继承**来的（路径挂在 `/api` 下，基座在前置里已挡过不可信 Host/Origin
 * 与未认证请求，依据见 `lib/mods/ask.js` 顶部注释）。本模块**不许**自己写 CORS，也不许放行 `*`。
 *
 * `node lib/mods/starter.js --selftest` 在临时合成的包上验，不碰真包
 * （写盘只发生在影副本里，收尾还会断言真包 goals.jsonl 未被改动）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStarter, composeRequest, missingRequired } from '../starter.js'
import { goalsPath } from '../goal-io.js'

const ROUTE_PATH = '/api/whale/starter'

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

/**
 * 请求体 → `values`。**白名单是"只收字符串"**：数字/对象/数组一律 400，
 * 因为拼出来的是一段给人读的中文，任何非字符串都只会在模板里变成 `[object Object]`。
 */
function readValues(raw) {
	if (raw === null || raw === undefined) return { status: 400, error: '请求体读取失败' }
	let o
	try { o = JSON.parse(String(raw)) } catch { return { status: 400, error: '请求体不是 JSON' } }
	if (!o || typeof o !== 'object' || Array.isArray(o)) {
		return { status: 400, error: '请求体必须是 JSON 对象 { values }' }
	}
	const v = o.values
	if (!v || typeof v !== 'object' || Array.isArray(v)) return { status: 400, error: '缺 values（对象）' }
	const values = {}
	for (const [k, val] of Object.entries(v)) {
		if (typeof val !== 'string') return { status: 400, error: `values.${k} 必须是字符串` }
		values[k] = val
	}
	return { status: 200, values }
}

/**
 * 拼一段「开课请求」正文。
 *
 * 2026-09-24 F1b **行为变更**：这条路**不再写 `goals.jsonl`**。
 *   · 终点（goal / tier / acceptance）原来靠弹窗那 8 个字段收，随这次请求一起落盘；
 *   · 现在弹窗表单屏已删（v3 §1.1「点知识点卡片 = 一键到位」），**终点搬到三段流程的 ②看挑战段**：
 *     由 agent 问出来、经 `whale_goal op=record` 落盘（见 `lib/mods/goal.js`）。
 *   · 所以这里只拼正文；`goalFromForm()` 仍在（只有一份映射），但调用方换成了 `whale_goal`。
 *
 * 必填校验保留着（`missingRequired`）—— 字段表现在是空的，它自然返回空数组；
 * 留着是为了将来真要加回某个字段时不必改这里。
 * `goalSaved:false` + `goalHint` 现在**恒定**返回，如实告诉客户端"终点不在这条路上落"。
 */
function composeAt(values, circle, point, pointId, root) {
	const entry = buildStarter(null)
	const missing = missingRequired(entry.form, values)
	if (missing.length) {
		return json(400, { ok: false, missing, error: `还差这几项：${missing.join('、')}` })
	}
	const text = composeRequest(entry.form, values, entry.prompt, circle, point, pointId)
	return json(200, {
		ok: true,
		text,
		length: text.length,
		fields: entry.form.fields.map((f) => f.id),
		goalSaved: false,
		goalHint: '终点不在这条路上落了（2026-09-24 F1b）：三段流程的 ②看挑战段问出「学完要能做出什么 / 学到哪一层 / 验收判据」之后，由 whale_goal op=record 落 goals.jsonl',
	})
}

export const plugin = {
	id: 'starter',
	version: '0.1.0',
	tools: [], // 只提供路由，不动工具面

	install(hctx) {
		const route = {
			path: ROUTE_PATH,
			// 同一条路径两个方法（宿主按 methods 匹配；拆成两条同路径的路由会撞）
			methods: ['GET', 'POST'],
			// ⚠️ **必须显式写**：基座按这个字段决定要不要缓冲请求体；
			//    省略时方法匹配取到 undefined、掉进 streaming 分支，GET 会被装上 body 而抛（见 status.js 注释）。
			requestBody: 'buffered',
			fetch: async (request) => {
				const method = request.method
				if (method !== 'GET' && method !== 'POST') return json(405, { ok: false, error: '只接受 GET / POST' })

				const root = hctx.paths.packRoot
				const abs = root ? path.resolve(root) : null

				if (method === 'GET') {
					return json(200, {
						ok: true,
						configured: !!abs,
						packRoot: abs,
						entry: buildStarter(abs),
						...(abs ? {} : {
							hint: '未配置 packRoot —— 开课请求仍能拼出来，但 ask / note 会回 503、'
								+ 'catalog / circle / point 回 200 但 ok:false、whale_* 工具会报「没有课程包根目录」。'
								+ '两种配法（都要重启宿主）：① 设环境变量 DSH_WHALE_PACK=<课程包根目录>；'
								+ '② 在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加 '
								+ '`- id: whale-sensei` + `config: { packRoot: … }`。详见 ONBOARDING.md。',
						}),
					})
				}

				let raw
				try { raw = await request.text() } catch { raw = null }
				const p = readValues(raw)
				if (p.status !== 200) return json(p.status, { ok: false, error: p.error })
				// 从请求体读取可选的 circle/point/pointId
				let o
				try { o = JSON.parse(String(raw)) } catch { o = {} }
				const circle = typeof o.circle === 'string' ? o.circle : undefined
				const point = typeof o.point === 'string' ? o.point : undefined
				const pointId = typeof o.pointId === 'string' ? o.pointId : undefined
				return composeAt(p.values, circle, point, pointId, abs)
			},
		}

		if (typeof hctx.inject === 'function') {
			hctx.inject(['connection'], (c) => {
				const conn = c.get('connection')
				if (!conn?.fetch?.register) {
					hctx.log?.warn?.(`connection 服务没有 fetch.register —— ${ROUTE_PATH} 没挂上`)
					return
				}
				try {
					conn.fetch.register(route)
					hctx.log?.info?.(`开课入口路由已挂 ${ROUTE_PATH}（GET 载荷 / POST 拼装；终点不在这条路上落 —— 见 whale_goal）`)
				} catch (e) {
					hctx.log?.error?.(`挂 ${ROUTE_PATH} 失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：开课入口路由未注册')
		}
	},
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
	const failures = []
	const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

	const mk = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-starter-'))
		// ⚠️ `readPack` 认的是**产物层** `lessons/<圆圈>/<知识点>/point.json`（不是 `lessons/src/`）
		fs.mkdirSync(path.join(d, 'lessons', 'programming', 'vue'), { recursive: true })
		fs.writeFileSync(path.join(d, 'lessons', 'programming', 'halo.json'), JSON.stringify({ halo: 'programming', name: '编程' }))
		fs.writeFileSync(path.join(d, 'lessons', 'programming', 'vue', 'point.json'), JSON.stringify({ point: 'vue', name: 'Vue' }))
		fs.mkdirSync(path.join(d, 'code'), { recursive: true })
		return d
	}
	const captured = []
	const warns = []
	const KNOWN = ['connection', 'jobs']
	const injected = []
	const mkCtx = (packRoot, withInject = true) => ({
		log: { info: () => {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) },
		paths: { packRoot },
		registerTool: () => {},
		inject: withInject
			? (names, cb) => {
				injected.push(names)
				if (names.includes('connection')) cb({ get: () => ({ fetch: { register: (r) => captured.push(r) } }) })
			}
			: undefined,
	})
	const installAt = (packRoot, withInject = true) => { captured.length = 0; plugin.install(mkCtx(packRoot, withInject)) }
	const call = (route, method, body) => route.fetch(new Request(`http://127.0.0.1:3090${ROUTE_PATH}`, {
		method,
		...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
	}))

	const P = mk()
	// 真包守卫（R8）：POST 现在会写 goals.jsonl —— 本 selftest 的写盘只许发生在影副本 P 里，
	// 收尾要证明真包的 goals.jsonl **一个字节都没动**。真包找法与 test/_pack.mjs 同一顺序。
	const readFileOrNull = (f) => { try { return fs.readFileSync(f) } catch { return null } }
	const sameBytes = (a, b) => (a === null && b === null) || (!!a && !!b && Buffer.compare(a, b) === 0)
	const realPack = [process.argv[2], process.env.DSH_WHALE_PACK, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'study')]
		.map((c) => String(c ?? '').trim()).filter(Boolean)
		.map((c) => path.resolve(c))
		.find((c) => fs.existsSync(path.join(c, 'presets', 'whale-sensei.css'))) || null
	const realGoalsBefore = realPack ? readFileOrNull(goalsPath(realPack)) : null

	// ── ① 路由形状 ──
	installAt(P)
	ok(captured.length === 1 && captured[0].path === ROUTE_PATH, `挂了 ${ROUTE_PATH} 这一条（本模块共 ${captured.length} 条）`)
	const route = captured[0]
	ok(route.path.startsWith('/api/') && route.path !== '/api', `路由在 /api 前缀下且没占 /api 本身（${route.path}）`)
	ok(Array.isArray(route.methods) && route.methods.join(',') === 'GET,POST', `methods = GET,POST（${route.methods.join(',')}）`)
	ok(new Set(route.methods).size === route.methods.length, 'methods 不重复')
	ok(route.requestBody === 'buffered', '显式声明 requestBody=buffered（不写的话基座不缓冲请求体，GET 会被装 body 抛）')
	ok(injected.length === 1 && injected[0].every((n) => KNOWN.includes(n)), `软依赖都是已知服务（${injected[0]?.join('、')}）`)
	ok(plugin.tools.length === 0, '不动工具面（tools 为空）')

	// ── ② GET：弹窗要的字段与模板 ──
	const g = await call(route, 'GET')
	const gb = await g.json()
	ok(g.status === 200 && gb.ok === true && gb.configured === true, `GET → ${g.status} configured=${gb.configured}`)
	const form = gb.entry?.form || {}
	ok(gb.entry?.label === '新课程', `entry.label 是「新课程」（${gb.entry?.label}）`)
	ok(Array.isArray(form.fields) && form.fields.length === 0, `字段表已删 ⇒ 空数组（${(form.fields || []).length} 个）—— v3 §1.1「点知识点卡片即开课」`)
	const required = (form.fields || []).filter((f) => f.required).map((f) => f.id)
	ok(required.length === 0, `不再有必填字段（${required.length} 个）—— 终点改由 ②看挑战段的 whale_goal 收`)
	ok(new Set((form.fields || []).map((f) => f.id)).size === (form.fields || []).length, '字段 id 不重复')
	const placeholders = (form.template || '').match(/\{\{[a-z]+\}\}/g) || []
	ok(placeholders.includes('{{protocol}}'), '模板里带 {{protocol}} 占位（协议全文由宿主拼进去）')
	ok((form.fields || []).every((f) => placeholders.includes(`{{${f.id}}}`)), `每个字段在模板里都有占位（${placeholders.join(' ')}）`)
	ok(/点知识点卡片即开课/.test(form.intro || '') && /看挑战/.test(form.intro || '') && /生成课程/.test(form.intro || ''), `弹窗说明写清"点卡片即开课 + 三段"（${form.intro}）`)
	const askText = JSON.stringify(form.fields)
	ok(!/掌握程度|学过什么|基础如何/.test(askText), '**弹窗字段里不问摸底**（掌握程度是发出去之后 agent 单独问的那一轮）')
	ok(/whale_intake/.test(gb.entry.prompt || ''), 'protocol 全文里点名 whale_intake（第③步的机械闸门）')
	ok((gb.entry.tracks || []).includes('Vue'), `tracks 从课程包读出来（${(gb.entry.tracks || []).join('、')}）`)

	// ── ③ POST：拼装（2026-09-24 F1b：**这条路不再写 goals.jsonl** —— 终点搬到 ②看挑战段的 whale_goal）──
	const p1 = await call(route, 'POST', JSON.stringify({
		values: {}, circle: '编程', point: 'Vue', pointId: 'programming/vue',
	}))
	const b1 = await p1.json()
	ok(p1.status === 200 && b1.ok === true, `POST 合法 → ${p1.status} ok=${b1.ok}`)
	ok(b1.text.startsWith('【开课请求】'), `正文以「【开课请求】」开头（${String(b1.text).slice(0, 12)}）`)
	ok(b1.text.includes('- 归属：编程 / Vue（programming/vue）'), '归属行在正文里（点卡片时归属已定 ⇒ 原第①步「问我学什么」整步删掉）')
	ok(b1.text.includes('三段') && /① 查资料/.test(b1.text) && /② 看挑战/.test(b1.text) && /③ 生成课程/.test(b1.text),
		'**三段协议**拼进了正文（①查资料 → ②看挑战 → ③生成课程）')
	ok(!/严格按下面四步走/.test(b1.text), '四步协议已不在正文里（改成三段了）')
	ok(/whale_intake/.test(b1.text) && /whale_goal/.test(b1.text) && /whale_author/.test(b1.text),
		'②段点名两个落盘工具与闸门（whale_intake / whale_goal / whale_author）')
	ok(/必须排在 c\) 之后/.test(b1.text), '写清「whale_goal 必须排在 intake 之后」（from 才会带上起点台阶）')
	ok(!/\{\{[a-z]+\}\}/.test(b1.text), '正文里没有没被替换掉的占位符')
	ok(!/（未填，你来定）/.test(b1.text), '字段表已删 ⇒ 正文里不再有「（未填，你来定）」那种行')

	// 终点**不在这条路上落盘**：恒定 goalSaved:false + 指路到 whale_goal
	const goalsFile = goalsPath(P)
	ok(b1.goalSaved === false, 'goalSaved 恒为 false（终点不在这条路上落了）')
	ok(/whale_goal/.test(b1.goalHint || ''), `goalHint 指路到 whale_goal（${String(b1.goalHint).slice(0, 32)}…）`)
	ok(!fs.existsSync(goalsFile), '这条路**一个字节都没写** goals.jsonl')
	await call(route, 'POST', JSON.stringify({ values: {}, pointId: 'programming/vue' }))
	ok(!fs.existsSync(goalsFile), '再 POST 一次也不写（不是"第一次才不写"）')

	// ── ④ 坏样本（**必填已无**：字段表删了 ⇒ 空 values 也能拼，不再有"缺必填 → 400"）──
	const p2 = await call(route, 'POST', JSON.stringify({ values: {} }))
	const b2 = await p2.json()
	ok(p2.status === 200 && b2.ok === true, `字段表已删 ⇒ 空 values 也能拼（${p2.status} ok=${b2.ok}）`)
	const bad = [
		['不是 JSON', '这不是 JSON', 400, '不是 JSON'],
		['是数组', '[1,2]', 400, '必须是 JSON 对象'],
		['缺 values', JSON.stringify({ topic: 'x' }), 400, '缺 values'],
		['values 不是对象', JSON.stringify({ values: 'x' }), 400, '缺 values'],
		['值是数字', JSON.stringify({ values: { topic: 3 } }), 400, '必须是字符串'],
	]
	for (const [name, body, want, wantErr] of bad) {
		const res = await call(route, 'POST', body)
		const b = await res.json()
		ok(res.status === want && b.ok === false && String(b.error).includes(wantErr), `坏样本「${name}」→ ${res.status} ${b.error}`)
	}
	const del = await call(route, 'DELETE')
	ok(del.status === 405, `DELETE → ${del.status}（只接受 GET / POST）`)
	ok(!g.headers.get('access-control-allow-origin'), '响应里没有 CORS 允许头（栅栏归基座）')

	// ── ⑤ 没配 packRoot：GET 照样发载荷并给修法；POST 照样能拼（终点本来就不在这条路上落） ──
	installAt(undefined)
	const g2 = await captured[0].fetch(new Request(`http://127.0.0.1:3090${ROUTE_PATH}`, { method: 'GET' }))
	const gb2 = await g2.json()
	ok(g2.status === 200 && gb2.configured === false && !!gb2.entry?.form, `没配 packRoot：GET 仍 ${g2.status} 且带 entry（弹窗不消失）`)
	ok(/503/.test(gb2.hint || '') && /cordis\.patch\.yml/.test(gb2.hint || ''), `没配时 hint 说清后果与修法（${String(gb2.hint).slice(0, 24)}…）`)
	const p3 = await captured[0].fetch(new Request(`http://127.0.0.1:3090${ROUTE_PATH}`, {
		method: 'POST',
		body: JSON.stringify({ values: { topic: 'A', goal: 'B', tier: '1', acceptance: 'C' }, pointId: 'programming/vue' }),
		headers: { 'content-type': 'application/json' },
	}))
	const b3 = await p3.json()
	ok(p3.status === 200 && b3.ok === true, '没配 packRoot 也能拼（POST 的正文不依赖课程包）')
	ok(b3.goalSaved === false && /whale_goal/.test(b3.goalHint || ''), `没配 packRoot → 不落盘、只指路（${String(b3.goalHint).slice(0, 28)}…）`)

	// ── ⑥ 真包守卫（R8）：写盘只发生在影副本 P，真包 goals.jsonl 逐字节未动 ──
	if (realPack) {
		ok(sameBytes(readFileOrNull(goalsPath(realPack)), realGoalsBefore), `真包 goals.jsonl 未被改动（${realPack}）`)
	} else {
		ok(true, '（本机没找到真包 —— 跳过真包守卫；影副本的落盘路径已单独验过）')
	}

	fs.rmSync(P, { recursive: true, force: true })
	console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
	process.exit(failures.length ? 1 : 0)
}
