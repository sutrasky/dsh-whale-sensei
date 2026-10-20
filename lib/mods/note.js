/**
 * lib/mods/note.js — 能力模块：笔记路由薄壳（A1b 队列①）
 * ------------------------------------------------------------------
 * 只做一件事：在宿主 API 路由下挂一条精确路由 `/api/whale/note`
 *   POST { text, anchor, date? } → lib/notes-io.js 的 `appendNote` → 把它的原话带回去
 *
 * 薄到什么程度：**这一层不许有自己的规矩**。
 *   空文本 / 孤儿锚点 / `date` 形状 / 撞 id / 写后自检回滚 —— 全部由 `appendNote` 说了算，
 *   路由只负责「取三个字段」与「原样回报」。在路由里再判一遍就是又开一套口径
 *   （本项目正在消灭的正是这种两套口径 ✗）。
 *
 * 跨站栅栏与浏览器认证是**继承**来的：基座把 `/api` 挂成 prefix 路由，处理器前面的
 * `requestRejection` 已经挡过不可信 Host/Origin 与未认证请求（依据与行号见 `lib/mods/ask.js`
 * 顶部注释）。所以本模块**不许**自己写 CORS/Origin 判断，也不许放行 `*`。
 *
 * 不开新通道：用的就是现成的 `connection.fetch.register`（与 `/api/whale/ask` 同一个通道）。
 * 写盘唯一入口是 `lib/notes-io.js`；模块之间不许互相 import。
 * `node lib/mods/note.js --selftest` 在临时合成的包上验，不碰真包。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendNote, NOTES_REL } from '../notes-io.js'
import { rebuildArtifacts } from '../ask-io.js'
import { lessonIndex, labelOfAnchor } from '../pack-model.js'

const ROUTE_PATH = '/api/whale/note'

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

/**
 * 只放行这三个字段（白名单，不是黑名单）。
 * `corrupt` 是 `notes-io` 的测试开关 —— 从网络**够不到**它；`id` / `seq` 由计数器说了算，请求说了不算。
 */
function pickFields(o) {
	const out = {}
	if (typeof o.text === 'string') out.text = o.text
	if (typeof o.anchor === 'string') out.anchor = o.anchor
	if (typeof o.date === 'string') out.date = o.date
	return out
}

/** 请求体 → appendNote 入参。非 JSON / 非对象 → 明确报错，不猜、不兜底 */
function readNoteArgs(raw) {
	if (raw === null || raw === undefined) return { status: 400, error: '请求体读取失败' }
	let o
	try { o = JSON.parse(String(raw)) } catch { return { status: 400, error: '请求体不是 JSON' } }
	if (!o || typeof o !== 'object' || Array.isArray(o)) {
		return { status: 400, error: '请求体必须是 JSON 对象 { text, anchor, date? }' }
	}
	return { status: 200, args: pickFields(o) }
}

/**
 * appendNote → HTTP。两种失败要分得开：
 *   · **抛出** = 请求被拒（空文本 / 孤儿锚点 / date 形状 / 撞 id）→ 400，消息一字不改；
 *     例外：**笔记超 16KB** 由 notes-io 的闸带 `httpStatus:413`（与包侧 `/note` 同码）→ 413
 *   · **返回 ok:false** = 写后自检没过并且已经回滚 → 500（是插件侧故障，不是请求的错）
 *
 * 落盘之后**必须重建产物**（与 answer 写入口同一条规矩）：
 * 笔记正文进 `reference/NOTES.html`，而课程页里嵌了「DSH 笔记」卡片的计数（笔记 n）——
 * 一个都不重建，学生那边就看不到刚写的笔记，课程包闸门也会红。
 * 2026-09-21 实测：只投一条笔记，`build-notes --check` 与 `build-lessons --check` 双双判红，
 * 且 NOTES.html 里**找不到**刚写的那条（刷新笔记页是空的）。
 * 重建失败**不改** Http 码：笔记确实落盘了，回非 2xx 会诱导重投（重复一条笔记 ✗）。
 */
function toHttp(root, args, trustedEngine = true) {
	try {
		const r = appendNote({ root, ...args })
		if (!r.ok) return json(500, { ok: false, error: r.error, rolledBack: r.rolledBack === true })
		// T04-R2 裁定甲（hctx 透传）：`trustedEngine` 缺省严，只给"夹具不是真包"的测试调用点用。
		const built = rebuildArtifacts(root, ['tools/build-notes.js', 'tools/build-lessons.js'], { subject: '笔记', trustedEngine })
		return json(200, {
			ok: true,
			id: r.id,
			seq: r.seq,
			hasDate: r.hasDate,
			steps: built.steps,
			rebuild: built.rebuild,
			warnings: built.warnings,
		})
	} catch (e) {
		// 状态码由错误自己带：notes-io 的**超限闸**给 413（与包侧 `/note` 同码），
		// 其余拒写（空文本 / 孤儿锚点 / date 形状 / 撞 id）没带码，照旧 400。
		// 本处只改这一行映射，不动其它行为。
		return json(e?.httpStatus ?? 400, { ok: false, error: e?.message ?? String(e) })
	}
}

export const plugin = {
	id: 'note',
	version: '0.1.0',
	tools: [], // 薄壳不注册工具：这一轮**工具面不变**

	install(hctx) {
		const route = {
			path: ROUTE_PATH,
			methods: ['POST'], // 精确、不重复（assertFetchRoute 会校验）
			requestBody: 'buffered', // 必须显式写：基座按 route.requestBody 决定要不要缓冲请求体
			fetch: async (request) => {
				const root = hctx.paths.packRoot
				if (!root) return json(503, { ok: false, error: '插件没有配置 packRoot，定位不到课程包（不猜 cwd）' })
				if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
				let raw
				try {
					raw = await request.text()
				} catch {
					raw = null
				}
				const p = readNoteArgs(raw)
				if (p.status !== 200) return json(p.status, { ok: false, error: p.error })
				return toHttp(root, p.args, hctx?.trustedEngine !== false)
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
					hctx.log?.info?.(`笔记路由已挂 ${ROUTE_PATH}（跨站栅栏 + 认证由基座继承）`)
				} catch (e) {
					hctx.log?.error?.(`挂 ${ROUTE_PATH} 失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：笔记路由未注册')
		}
	},
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
	const failures = []
	const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

	// 合成一个最小包（不碰真包）：映射表需要 EXPECT 的 id + 源页 + 产物页
	// ⚠️ 页面必须摆在**知识点目录**下（`lessons/pt/0001-a.html`）—— 2026-09-24 起 `byNumber`
	//    的键是 `point/NNNN`，平铺布局会被判成历史归属（programming/spring-boot），
	//    于是和这里声明的 `pt/0001` 对不上、直接报 conflict（这正是那条跨圈串页缺陷的修复）。
	const mk = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-note-route-'))
		fs.mkdirSync(path.join(d, 'lessons', 'src', 'pt'), { recursive: true })
		fs.mkdirSync(path.join(d, 'lessons', 'pt'), { recursive: true })
		fs.mkdirSync(path.join(d, 'code', 'proj'), { recursive: true })
		fs.writeFileSync(path.join(d, 'lessons', 'src', 'pt', '0001-a.html'), '<html></html>')
		fs.writeFileSync(path.join(d, 'lessons', 'pt', '0001-a.html'), '<html></html>')
		fs.writeFileSync(path.join(d, 'code', 'proj', 'EXPECT.json'), JSON.stringify({ lessons: [{ id: 'pt/0001', title: '第1课' }] }))
		return d
	}
	const hash = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString('utf8') : '(无)')
	const frozen = (d) => hash(path.join(d, NOTES_REL)) + '|' + hash(path.join(d, 'notes', 'seq.txt'))

	const captured = []
	const warns = []
	const tools = []
	const KNOWN = ['connection', 'jobs']
	const injected = []
	const mkCtx = (packRoot, withInject = true) => ({
		log: { info: () => {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) },
		paths: { packRoot },
		// T04-R2 裁定甲：这是 `--selftest` 的**合成包**（没有 tools/，不是真包）——
		// 本处显式旁路，只为让"落盘后必跑重建链"那条判据仍能观测到链真的跑了。
		trustedEngine: false,
		registerTool: (d) => tools.push(d),
		inject: withInject
			? (names, cb) => {
				injected.push(names)
				if (names.includes('connection')) cb({ get: () => ({ fetch: { register: (r) => captured.push(r) } }) })
			}
			: undefined,
	})
	const installAt = (packRoot, withInject = true) => {
		captured.length = 0
		plugin.install(mkCtx(packRoot, withInject))
	}
	const post = (body, init = {}) => new Request('http://127.0.0.1:3090/api/whale/note', {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/json' },
		...init,
	})

	const P = mk()

	// ── ① 路由形状（与 /api/whale/ask 同一套硬约束）──
	installAt(P)
	ok(captured.length === 1 && captured[0].path === '/api/whale/note', `挂了 /api/whale/note 这一条（本模块共 ${captured.length} 条）`)
	const route = captured[0]
	ok(typeof route.path === 'string' && route.path.startsWith('/api/'), `路由在 /api 前缀下（${route.path}）—— 基座只挂 /api，别处不会被栅栏罩住`)
	ok(route.path !== '/api', '没有占用基座保留的 /api 本身')
	ok(Array.isArray(route.methods) && route.methods.length > 0 && new Set(route.methods).size === route.methods.length, `methods 非空且不重复（${route.methods.join(',')}）`)
	ok(route.methods.length === 1 && route.methods[0] === 'POST', '只收 POST（拉取笔记不走这条，写入口越小越好）')
	ok(route.requestBody === 'buffered', '显式声明 requestBody=buffered（不写的话基座不缓冲请求体）')
	ok(injected.length === 1 && injected[0].every((n) => KNOWN.includes(n)), `软依赖都是已知服务（实得 ${injected[0]?.join('、')}）`)
	// 回归钉：2026-09-24 裁定正本 = notes/notes.jsonl。课程包侧 7 个读者全读这个路径，
	// 写入口一旦被挪走（A1b 早期就写成过包根），笔记会落进没人读的文件 → 这条当场红
	ok(NOTES_REL.split(path.sep).join('/') === 'notes/notes.jsonl', '写入口落在正本路径 notes/notes.jsonl（build-notes / build-lessons / render-inputs / state-scan / ask-server 都读它）')

	// ── ② 合法 POST 真写盘 ──
	// ⚠️ 2026-10-20：成功夹具用**规范课次键** `programming/pt/0001`。夹具里 `lessons/pt/` 没有
	//    圆圈目录，映射表按 LEGACY_HALO 归到 `programming`；显示名（`第1课`）与两段课键
	//    （`pt/0001`）U09 起是**拒写样本**（见下面 ③ 的最后两条）—— 页面生成器现在烘的就是规范键
	//    （`lib/unify/content.cjs#projectNotes` 的 data-note-lesson），这里钉住同一条口径。
	const h = route.fetch
	const CANON = 'programming/pt/0001'
	const r1 = await h(post(JSON.stringify({ text: '第一条笔记', anchor: CANON })))
	const r1Text = await r1.text()
	let b1 = null
	try { b1 = JSON.parse(r1Text) } catch { b1 = { raw: r1Text } }
	ok(r1.status === 200 && b1.ok === true && b1.id === '0001' && b1.seq === 1,
		`合法 POST → ${r1.status} ${JSON.stringify(b1)}`)
	const lines1 = hash(path.join(P, NOTES_REL))
	ok(lines1.trim().split('\n').length === 1 && /"anchor":"programming\/pt\/0001"/.test(lines1),
		`笔记台账恰好多一行，且 anchor 落盘的是**规范课次键** programming/pt/0001（路由传的就是它，入口只收规范身份）（${NOTES_REL.split(path.sep).join('/')}）—— 实得 ${JSON.stringify(lines1)}`)
	ok(hash(path.join(P, 'notes', 'seq.txt')).trim() === '1', 'notes/seq.txt 由 appendNote 推进到 1（路由自己不碰计数器）')
	ok(!/date/.test(lines1) && b1.hasDate === false, '没给 date 时产物里没有 date 字段（路由不替它默认"今天"）')
	// 端到端那一步：台账存的锚点，渲染侧能不能反推出课次 —— 能，才算真的挂到课上
	// ⚠️ 2026-10-20：**先看文件在不在再解析**。旧自测在第一条 POST 就被拒时仍然
	//    `JSON.parse(hash(...))` → 拿到 `(无)` → 抛 `Unexpected token '('`，
	//    把真正的 400 响应体盖掉了（上一轮审查就是被这个连锁异常误导的）。
	const ledgerText = hash(path.join(P, NOTES_REL))
	const firstRow = ledgerText.trim().split('\n').filter(Boolean)[0]
	let written1 = null
	try { written1 = firstRow ? JSON.parse(firstRow) : null } catch { written1 = null }
	ok(!!written1 && labelOfAnchor(written1.anchor, lessonIndex(P)) === '第1课',
		`路由写进去的那条，渲染侧反推出课次（${written1 ? written1.anchor : `台账不可解析：${JSON.stringify(ledgerText)}`} → 第1课）—— 不是落进一个没人认的锚点`)
	ok(!r1.headers.get('access-control-allow-origin'), '响应里**没有** CORS 允许头（栅栏归基座，路由不放行）')
	// 回归钉（2026-09-21 实测的真缺陷）：笔记落盘后原来**什么都不重建** →
	// `build-notes --check` 与 `build-lessons --check` 双双判红，NOTES.html 里找不到刚写的笔记。
	// 这里钉的是"必跑重建链"，以及"失败必须结构化点名、不许假装成功"（本影子包没有 tools/，必挂）。
	ok(
		Array.isArray(b1.steps) &&
			b1.steps.map((s) => s.script).join('、') === 'tools/build-notes.js、tools/build-lessons.js',
		`落盘后必跑重建链（${(b1.steps || []).map((s) => s.script + '=' + s.code).join(' · ')}）`
	)
	ok(
		typeof b1.rebuild?.ok === 'boolean' && b1.rebuild.ok === ((b1.warnings || []).length === 0),
		`rebuild.ok 与 warnings 一致（ok=${b1.rebuild?.ok} · 点名 ${(b1.rebuild?.failed || []).join('、') || '无'}）`
	)

	// ── ③ 方法/体积之外的第一道门 ──
	const put = await h(new Request('http://127.0.0.1:3090/api/whale/note', { method: 'PUT' }))
	const get = await h(new Request('http://127.0.0.1:3090/api/whale/note', { method: 'GET' }))
	ok(put.status === 405 && get.status === 405, `PUT → ${put.status}、GET → ${get.status}（只接受 POST）`)

	const frozenBeforeBad = frozen(P)
	const bad = [
		['不是 JSON', '这不是 JSON', 400, '不是 JSON'],
		['是数组', '[1,2,3]', 400, '必须是 JSON 对象'],
		['空文本', JSON.stringify({ text: '   ', anchor: CANON }), 400, '缺 text'],
		['缺 anchor', JSON.stringify({ text: '有字没锚' }), 400, '缺 anchor'],
		['孤儿锚点', JSON.stringify({ text: 'x', anchor: 'nope/9999' }), 400, '孤儿锚点'],
		['date 形状不对', JSON.stringify({ text: 'x', anchor: CANON, date: '今天' }), 400, 'YYYY-MM-DD'],
		// 旧写法**继续是拒写样本**（U09 起运行态只认 circle/point/NNNN）：
		// 这两条正是 2026-10-20 独立审查里"原版生成表单发显示名 → 400"的那两种形状。
		['显示名（旧写法）', JSON.stringify({ text: 'x', anchor: '第1课' }), 400, '孤儿锚点'],
		['两段课键（旧写法）', JSON.stringify({ text: 'x', anchor: 'pt/0001' }), 400, '孤儿锚点'],
		['错圈（规范形状但不属于本包）', JSON.stringify({ text: 'x', anchor: 'math/pt/0001' }), 400, '孤儿锚点'],
	]
	let badOk = true
	for (const [name, body, wantStatus, wantErr] of bad) {
		const res = await h(post(body))
		const b = await res.json()
		if (!(res.status === wantStatus && b.ok === false && String(b.error).includes(wantErr))) badOk = false
		ok(res.status === wantStatus && b.ok === false && String(b.error).includes(wantErr), `坏样本「${name}」→ ${res.status} ${b.error}`)
	}
	ok(badOk && frozen(P) === frozenBeforeBad, `${bad.length} 条坏样本之后：台账与 seq **一字未动**（没有半行垃圾、没有空跳号）`)

	// ── ④ 测试开关够不到网上 ──
	installAt(P)
	const src = await captured[0].fetch(post(JSON.stringify({ text: '走私 corrupt', anchor: CANON, corrupt: true })))
	const srcBody = await src.json()
	ok(src.status === 200 && srcBody.ok === true && srcBody.id === '0002', `请求体里的 corrupt:true **过不来**（${src.status} { ok:true, id:"${srcBody.id}" }）—— 白名单只放 text/anchor/date`)
	let hasCorruptField = false
	let sawRollback = false
	try {
		for (const line of fs.readFileSync(path.join(P, NOTES_REL), 'utf8').trim().split('\n')) {
			const o = JSON.parse(line) // 走私成功会写坏一行 → 这里就抛
			if ('corrupt' in o) hasCorruptField = true
		}
	} catch { sawRollback = true }
	const parsedRows = sawRollback ? -1 : hash(path.join(P, NOTES_REL)).trim().split('\n').filter(Boolean).length
	ok(!hasCorruptField && !sawRollback, `落盘的 ${parsedRows} 条都能 JSON.parse，且记录里没有 corrupt 字段`)

	// ── ⑤ 没有 packRoot / 没有 connection 时的行为 ──
	installAt(undefined)
	const noRoot = await captured[0].fetch(post(JSON.stringify({ text: 'x', anchor: CANON })))
	const noRootBody = await noRoot.json()
	ok(noRoot.status === 503 && /packRoot/.test(noRootBody.error || ''), `没配 packRoot → ${noRoot.status} ${noRootBody.error || ''}（明确报错，不猜 cwd）`)

	const before = warns.length
	installAt(P, false)
	ok(captured.length === 0 && warns.length > before && !warns.slice(before).some((w) => w.startsWith('E:')), `宿主没有 connection 能力时只 warn 不抛（${warns.slice(before)[0] || ''}）`)

	// ── ⑥ 薄壳不该动工具面 ──
	ok(tools.length === 0 && Array.isArray(plugin.tools) && plugin.tools.length === 0, '薄壳不注册任何工具（工具面不变；路由要生效仍得重载插件）')

	fs.rmSync(P, { recursive: true, force: true })
	console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
	process.exit(failures.length ? 1 : 0)
}
