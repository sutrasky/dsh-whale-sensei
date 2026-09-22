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
 * ⚠️ POST **不写盘** —— 它只拼一段文本；真正的动作是客户端把这段文本 `setDraft` + `submit`。
 *    所以它也**不需要 packRoot**（拿不到课程包时照样能拼，只是 `entry.tracks` 为空）。
 *    GET 则在没配 `packRoot` 时也回 200 并把修法写在 `hint` 里 —— 与 `/api/whale/status` 同一立场：
 *    这一节存在的意义就是把"没配"当场显示出来，而不是回一个看不出怎么修的错误。
 *
 * 跨站栅栏与浏览器认证是**继承**来的（路径挂在 `/api` 下，基座在前置里已挡过不可信 Host/Origin
 * 与未认证请求，依据见 `lib/mods/ask.js` 顶部注释）。本模块**不许**自己写 CORS，也不许放行 `*`。
 *
 * `node lib/mods/starter.js --selftest` 在临时合成的包上验，不碰真包、不写盘。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStarter, composeRequest, missingRequired } from '../starter.js'

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
 * 必填缺了 → **400 + 缺哪几个字段**（消息里用字段的**中文标签**，因为要给弹窗直接显示）；
 * 其余（可选字段没填）由 `composeRequest` 填「（未填，你来定）」，不拦。
 */
function composeAt(values, circle, point, pointId) {
	const entry = buildStarter(null)
	const missing = missingRequired(entry.form, values)
	if (missing.length) {
		return json(400, { ok: false, missing, error: `还差这几项：${missing.join('、')}` })
	}
	const text = composeRequest(entry.form, values, entry.prompt, circle, point, pointId)
	return json(200, { ok: true, text, length: text.length, fields: entry.form.fields.map((f) => f.id) })
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
				return composeAt(p.values, circle, point, pointId)
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
					hctx.log?.info?.(`开课入口路由已挂 ${ROUTE_PATH}（GET 载荷 / POST 拼装；只读不写盘）`)
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
	ok(Array.isArray(form.fields) && form.fields.length === 5, `弹窗 5 个字段（${(form.fields || []).length}）`)
	const required = (form.fields || []).filter((f) => f.required).map((f) => f.id)
	ok(required.join(',') === 'topic,goal', `必填只有「要学什么 / 学完要能做出什么」（${required.join(',')}）`)
	ok(new Set((form.fields || []).map((f) => f.id)).size === (form.fields || []).length, '字段 id 不重复')
	const placeholders = (form.template || '').match(/\{\{[a-z]+\}\}/g) || []
	ok(placeholders.includes('{{protocol}}'), '模板里带 {{protocol}} 占位（协议全文由宿主拼进去）')
	ok((form.fields || []).every((f) => placeholders.includes(`{{${f.id}}}`)), `每个字段在模板里都有占位（${placeholders.join(' ')}）`)
	ok(/掌握程度/.test(form.intro || '') && /之后|再问/.test(form.intro || ''), `弹窗说明写清"摸底在这条消息之后"（${form.intro}）`)
	const askText = JSON.stringify(form.fields)
	ok(!/掌握程度|学过什么|基础如何/.test(askText), '**弹窗字段里不问摸底**（掌握程度是发出去之后 agent 单独问的那一轮）')
	ok(/whale_intake/.test(gb.entry.prompt || ''), 'protocol 全文里点名 whale_intake（第③步的机械闸门）')
	ok((gb.entry.tracks || []).includes('Vue'), `tracks 从课程包读出来（${(gb.entry.tracks || []).join('、')}）`)

	// ── ③ POST：拼装 ──
	const p1 = await call(route, 'POST', JSON.stringify({ values: { topic: 'Vue 3 组合式 API', goal: '能独立写一个小型前端应用' } }))
	const b1 = await p1.json()
	ok(p1.status === 200 && b1.ok === true, `POST 合法 → ${p1.status} ok=${b1.ok}`)
	ok(b1.text.startsWith('【开课请求】'), `正文以「【开课请求】」开头（${String(b1.text).slice(0, 12)}）`)
	ok(b1.text.includes('Vue 3 组合式 API') && b1.text.includes('能独立写一个小型前端应用'), '学生的回答进了正文')
	ok(b1.text.includes('（未填，你来定）'), '没填的可选字段写成「（未填，你来定）」（不留空让 agent 猜）')
	ok(b1.text.includes('掌握程度') && b1.text.includes('whale_author'), '四步协议被拼在正文里（含第③步与闸门）')
	ok(b1.text.includes('在这条消息之后'), '正文里点明摸底在这条消息之后做')
	ok(!/\{\{[a-z]+\}\}/.test(b1.text), '正文里没有没被替换掉的占位符')

	// ── ④ 必填 / 坏样本 ──
	const p2 = await call(route, 'POST', JSON.stringify({ values: { topic: '   ' } }))
	const b2 = await p2.json()
	ok(p2.status === 400 && b2.ok === false && b2.missing.join(',') === '要学什么,学完要能做出什么', `缺必填 → ${p2.status} ${b2.error}`)
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

	// ── ⑤ 没配 packRoot：GET 照样发载荷并给修法；POST 照样能拼（它只是拼文本） ──
	installAt(undefined)
	const g2 = await captured[0].fetch(new Request(`http://127.0.0.1:3090${ROUTE_PATH}`, { method: 'GET' }))
	const gb2 = await g2.json()
	ok(g2.status === 200 && gb2.configured === false && !!gb2.entry?.form, `没配 packRoot：GET 仍 ${g2.status} 且带 entry（弹窗不消失）`)
	ok(/503/.test(gb2.hint || '') && /cordis\.patch\.yml/.test(gb2.hint || ''), `没配时 hint 说清后果与修法（${String(gb2.hint).slice(0, 24)}…）`)
	const p3 = await captured[0].fetch(new Request(`http://127.0.0.1:3090${ROUTE_PATH}`, {
		method: 'POST',
		body: JSON.stringify({ values: { topic: 'A', goal: 'B' } }),
		headers: { 'content-type': 'application/json' },
	}))
	ok(p3.status === 200 && (await p3.json()).ok === true, '没配 packRoot 也能拼（POST 不依赖课程包）')

	fs.rmSync(P, { recursive: true, force: true })
	console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
	process.exit(failures.length ? 1 : 0)
}
