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
import { buildStarter, composeRequest, missingRequired, goalFromForm } from '../starter.js'
import { recordGoal, goalsPath } from '../goal-io.js'

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
 * 拼一段「开课请求」正文，**并在同一次请求里把终点契约落进 goals.jsonl**（② 契约 §3.2）。
 * 必填缺了 → **400 + 缺哪几个字段**（消息里用字段的**中文标签**，因为要给弹窗直接显示）；
 * 其余（可选字段没填）由 `composeRequest` 填「（未填，你来定）」，不拦。
 *
 * 落盘三态（B6 / Q10，逐条可测）：
 *   · 没有 pointId（无法归属）或没配 packRoot → **不落盘、不报错**，正文照拼，
 *     `goalSaved:false` + `goalHint:"终点还没结构化：…"`（老客户端行为与今天完全一致）；
 *   · tier / acceptance 的**值**不合法 → **400**（写侧严格：`validateStage()` 拒，不静默拼过去）；
 *   · 其余 → `recordGoal` 追加一版（v / replaces / from 由台账算），`goalSaved:true`。
 */
function composeAt(values, circle, point, pointId, root) {
	const entry = buildStarter(null)
	const missing = missingRequired(entry.form, values)
	if (missing.length) {
		return json(400, { ok: false, missing, error: `还差这几项：${missing.join('、')}` })
	}
	const text = composeRequest(entry.form, values, entry.prompt, circle, point, pointId)
	const base = { ok: true, text, length: text.length, fields: entry.form.fields.map((f) => f.id) }
	const goalInput = goalFromForm(values, pointId)
	if (!goalInput) {
		return json(200, {
			...base,
			goalSaved: false,
			goalHint: '终点还没结构化：这次开课没有知识点归属（pointId）—— 只拼了正文，没写 goals.jsonl',
		})
	}
	if (!root) {
		return json(200, {
			...base,
			goalSaved: false,
			goalHint: '终点还没结构化：没配 packRoot，写不了 goals.jsonl —— 正文照常可用',
		})
	}
	const res = recordGoal(root, goalInput)
	if (!res.ok) {
		return json(400, { ok: false, error: `终点契约没写成（拒写，正文也没给）：${res.error}` })
	}
	return json(200, { ...base, goalSaved: true, goalVersion: res.record.v, goal: res.record })
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
					hctx.log?.info?.(`开课入口路由已挂 ${ROUTE_PATH}（GET 载荷 / POST 拼装 + 终点落盘 goals.jsonl）`)
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
	ok(Array.isArray(form.fields) && form.fields.length === 8, `弹窗 8 个字段（${(form.fields || []).length}）`)
	const required = (form.fields || []).filter((f) => f.required).map((f) => f.id)
	ok(required.join(',') === 'topic,goal,tier,acceptance', `必填 = 要学什么 / 学完要能做出什么 / 学到哪一层 / 验收判据（${required.join(',')}）`)
	ok(new Set((form.fields || []).map((f) => f.id)).size === (form.fields || []).length, '字段 id 不重复')
	const placeholders = (form.template || '').match(/\{\{[a-z]+\}\}/g) || []
	ok(placeholders.includes('{{protocol}}'), '模板里带 {{protocol}} 占位（协议全文由宿主拼进去）')
	ok((form.fields || []).every((f) => placeholders.includes(`{{${f.id}}}`)), `每个字段在模板里都有占位（${placeholders.join(' ')}）`)
	ok(/掌握程度/.test(form.intro || '') && /之后|再问/.test(form.intro || ''), `弹窗说明写清"摸底在这条消息之后"（${form.intro}）`)
	const askText = JSON.stringify(form.fields)
	ok(!/掌握程度|学过什么|基础如何/.test(askText), '**弹窗字段里不问摸底**（掌握程度是发出去之后 agent 单独问的那一轮）')
	ok(/whale_intake/.test(gb.entry.prompt || ''), 'protocol 全文里点名 whale_intake（第③步的机械闸门）')
	ok((gb.entry.tracks || []).includes('Vue'), `tracks 从课程包读出来（${(gb.entry.tracks || []).join('、')}）`)

	// ── ③ POST：拼装 + 终点落盘（R8：写盘只发生在影副本 P）──
	const p1 = await call(route, 'POST', JSON.stringify({
		values: {
			topic: 'Vue 3 组合式 API', goal: '能独立写一个小型前端应用', tier: '3',
			acceptance: '能独立写出一个待办列表页\n能讲清组合式 API 好在哪',
		},
		circle: '编程', point: 'Vue', pointId: 'programming/vue',
	}))
	const b1 = await p1.json()
	ok(p1.status === 200 && b1.ok === true, `POST 合法 → ${p1.status} ok=${b1.ok}`)
	ok(b1.text.startsWith('【开课请求】'), `正文以「【开课请求】」开头（${String(b1.text).slice(0, 12)}）`)
	ok(b1.text.includes('Vue 3 组合式 API') && b1.text.includes('能独立写一个小型前端应用'), '学生的回答进了正文')
	ok(b1.text.includes('（未填，你来定）'), '没填的可选字段写成「（未填，你来定）」（不留空让 agent 猜）')
	ok(b1.text.includes('掌握程度') && b1.text.includes('whale_author'), '四步协议被拼在正文里（含第③步与闸门）')
	ok(b1.text.includes('在这条消息之后'), '正文里点明摸底在这条消息之后做')
	ok(!/\{\{[a-z]+\}\}/.test(b1.text), '正文里没有没被替换掉的占位符')

	// 终点契约落盘（②）：goals.jsonl 出现第 1 版，artifact.what = goal **原文逐字**
	const goalsFile = goalsPath(P)
	const v1Line = fs.readFileSync(goalsFile, 'utf8').trim().split('\n')
	ok(b1.goalSaved === true && b1.goalVersion === 1, `终点落盘：goalSaved=${b1.goalSaved} v=${b1.goalVersion}`)
	ok(v1Line.length === 1, `goals.jsonl 出现第 1 版（${v1Line.length} 行）`)
	const rec1 = JSON.parse(v1Line[0])
	ok(rec1.point === 'vue' && rec1.pointPath === 'programming/vue', `point 取 pointId 最后一段、pointPath 原样（${rec1.point} / ${rec1.pointPath}）`)
	ok(rec1.artifact?.what === '能独立写一个小型前端应用', 'artifact.what = wizard goal 原文逐字（不拿摸底答案回落）')
	ok(rec1.tier === 3 && rec1.source === 'wizard', `tier=3（实得 ${rec1.tier}）source=wizard`)
	ok(Array.isArray(rec1.acceptance) && rec1.acceptance.length === 2 && rec1.acceptance.every((a) => a.auto === false && a.no > 0), '验收判据一行一条（auto:false 形态）')
	ok(!/\d{4}-\d{2}-\d{2}T/.test(fs.readFileSync(goalsFile, 'utf8')), 'goals.jsonl 全篇无 ISO 时间戳（可对拍）')

	// 换终点 = 追加第 2 版；第 1 版逐字节不动；replaces 指向第 1 版（B5 留痕）
	const p1b = await call(route, 'POST', JSON.stringify({
		values: { topic: 'Vue 3 组合式 API', goal: '改成：能部署上线的待办应用', tier: '4', acceptance: '能部署上线' },
		pointId: 'programming/vue',
	}))
	const b1b = await p1b.json()
	const v2Lines = fs.readFileSync(goalsFile, 'utf8').trim().split('\n')
	ok(p1b.status === 200 && b1b.goalSaved === true && b1b.goalVersion === 2, `换终点 → 第 2 版（v=${b1b.goalVersion}）`)
	ok(v2Lines.length === 2, `第 2 版是 append 不是覆盖（${v2Lines.length} 行）`)
	ok(v2Lines[0] === v1Line[0], '第 1 版逐字节不动（append-only 留痕）')
	const rec2 = JSON.parse(v2Lines[1])
	ok(rec2.replaces === 1 && rec2.v === 2 && rec2.artifact?.what === '改成：能部署上线的待办应用', `replaces=${rec2.replaces} 指向第 1 版（v=${rec2.v}）`)

	// 没有归属（没传 pointId）→ 不落盘、不报错，只提示「终点还没结构化」（B6 / Q10）
	const pNoBelong = await call(route, 'POST', JSON.stringify({ values: { topic: 'A', goal: 'B', tier: '1', acceptance: 'C' } }))
	const bNoBelong = await pNoBelong.json()
	ok(pNoBelong.status === 200 && bNoBelong.ok === true && bNoBelong.goalSaved === false, `没归属 → 只拼文本（${pNoBelong.status} goalSaved=${bNoBelong.goalSaved}）`)
	ok(/终点还没结构化/.test(bNoBelong.goalHint || ''), `没归属的提示语（${bNoBelong.goalHint}）`)
	ok(fs.readFileSync(goalsFile, 'utf8').trim().split('\n').length === 2, '没归属 → goals.jsonl 没多行')

	// 坏 tier → 拒写（写侧严格：validateStage 拒，且正文也不给）
	const pBadTier = await call(route, 'POST', JSON.stringify({ values: { topic: 'A', goal: 'B', tier: '三', acceptance: 'C' }, pointId: 'programming/vue' }))
	const bBadTier = await pBadTier.json()
	ok(pBadTier.status === 400 && /tier/.test(bBadTier.error || ''), `坏 tier → ${pBadTier.status} ${bBadTier.error}`)
	ok(fs.readFileSync(goalsFile, 'utf8').trim().split('\n').length === 2, '坏 tier 拒写在 append 之前（台账没多行）')

	// ── ④ 必填 / 坏样本 ──
	const p2 = await call(route, 'POST', JSON.stringify({ values: { topic: '   ' } }))
	const b2 = await p2.json()
	ok(p2.status === 400 && b2.ok === false && b2.missing.join(',') === '要学什么,学完要能做出什么,学到哪一层,验收判据', `缺必填 → ${p2.status} ${b2.error}`)
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

	// ── ⑤ 没配 packRoot：GET 照样发载荷并给修法；POST 照样能拼（但终点落不了盘） ──
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
	ok(b3.goalSaved === false && /终点还没结构化/.test(b3.goalHint || ''), `没配 packRoot → 不落盘、只提示（${b3.goalHint}）`)

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
