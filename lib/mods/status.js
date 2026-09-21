/**
 * lib/mods/status.js — 能力模块：状态节（设置页里那张「鲸师」卡片的数据源）
 * ------------------------------------------------------------------
 * 浏览器半边拿不到 Agent 工具，只能走 HTTP。所以这里挂一条**只读**路由：
 *
 *     GET /api/whale/status  →  { ok, configured, packRoot, version, sections[], entry }
 *
 * `entry` 是**开课入口**的载荷（`lib/starter.js`）：开课协议全文 + 步骤 + 按钮文案。
 * 输入框左侧那个「开一门新课」按钮点一下就是把它 `setDraft` 进输入框 —— 同一份只读数据
 * 既喂设置页那张卡、也喂入口按钮，客户端里没有第二份协议。
 *
 * ⚠️ **这条路由在没配 packRoot 时也返回 200**（别的路由是 503）—— 这是刻意的：
 *    它存在的意义就是**把"没配 packRoot"当场显示在设置页上**，
 *    回 503 的话卡片只能显示一个错误，反而看不出该怎么修。
 *
 * ⚠️ **必须显式写 `requestBody`**（见下面 route 里的注释）—— 省略它会被基座当 streaming，
 *    给 GET 装 body ⇒ 400 空体 ⇒ 客户端报的是"JSON 解析失败"（2026-09-24 现场踩过）。
 *
 * 设计要点：**"要显示什么"在宿主侧算好**（`sections`），客户端只负责画。
 *   · 事实只有一处来源，客户端里没有第二份推导；
 *   · 于是"卡片里到底有什么"是**可离线判据的**（test/panel.mjs 断言 sections 的形状与数字），
 *     而不是只能靠人眼看一眼。
 *   · 每一块**各自 try/catch**：某一项读不动只让那一行说"读不动"，不许整张卡塌掉。
 *
 * 只读：不写盘、不改配置、不启动任何东西。
 * 跨站栅栏与浏览器认证由基座继承（路径挂在 /api 下），本模块不写 CORS。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPack } from '../pack-model.js'
import { verifyPack } from '../verify.js'
import { auditPack } from '../audit.js'
import { loadGlossaryLedger, glossarySummary } from '../glossary-io.js'
import { probeState } from '../state-scan.js'
import { readNotes } from '../notes-io.js'
import { loadLedger, askPaths } from '../ask-io.js'
import { buildStarter } from '../starter.js'

const ROUTE_PATH = '/api/whale/status'

/** 插件自己的版本号 —— 从 package.json 读，**不硬编码**（硬编码迟早和 tag 脱节） */
function pluginVersion() {
	try {
		const pkg = fileURLToPath(new URL('../../package.json', import.meta.url))
		return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null
	} catch {
		return null
	}
}

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 一行：`{ name, value, state? }`；state 只用来上色（ok / warn / error） */
const row = (name, value, state) => (state ? { name, value, state } : { name, value })

/** 某一块算不出来时，只让这一块说清"读不动"（不让整张卡塌） */
const failed = (title, e) => ({ title, rows: [row('读不动', String(e?.message ?? e), 'error')] })

/**
 * 把"设置页那张卡里显示什么"在宿主侧算好。
 * 每一块独立 try/catch —— 一块坏了不牵连别的块。
 */
function buildSections(root, hctx) {
	const sections = []

	// ① 课程包本体
	let pack = null
	try {
		pack = readPack(root)
		const lit = pack.lessons.filter((l) => l.learned).length
		const rows = [
			row('根目录', root),
			row('概况', `${pack.circles.length} 圆圈 · ${pack.points.length} 知识点 · ${pack.lessons.length} 门课程`),
			row('已点亮', `${lit} / ${pack.lessons.length}`, lit > 0 ? 'ok' : 'warn'),
		]
		if (pack.warnings.length) {
			rows.push(row(`告警 ${pack.warnings.length} 条`, pack.warnings.slice(0, 3).join('；') + (pack.warnings.length > 3 ? ' …' : ''), 'warn'))
		}
		sections.push({ title: '课程包', rows })
	} catch (e) {
		sections.push(failed('课程包', e))
	}

	// ② 产物一致性（verifyPack）—— 与 whale_build 默认那次校验同一份逻辑
	try {
		const v = verifyPack(root, pack)
		const rows = [row('一致性', v.consistent ? '产物与课程包一致' : `${v.drift.length} 处不一致`, v.consistent ? 'ok' : 'error')]
		for (const d of v.drift.slice(0, 3)) rows.push(row('·', d, 'error'))
		sections.push({ title: '产物', rows })
	} catch (e) {
		sections.push(failed('产物', e))
	}

	// ③ 五条审计（auditPack）：死链 / id 重复 / 幽灵进度 / 缺产物 / 静默降级
	try {
		const a = auditPack(root, pack)
		const by = a.findings.reduce((o, f) => { o[f.severity] = (o[f.severity] || 0) + 1; return o }, {})
		const brief = Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' · ')
		const rows = [row('审计', a.findings.length === 0 ? '五条全净' : `${a.findings.length} 条发现${brief ? '（' + brief + '）' : ''}`, a.findings.length === 0 ? 'ok' : 'warn')]
		for (const f of a.findings.slice(0, 3)) rows.push(row(f.severity, `${f.file}：${f.message}`, 'warn'))
		sections.push({ title: '审计', rows })
	} catch (e) {
		sections.push(failed('审计', e))
	}

	// ④ 三本台账：名词 / 答疑 / 笔记
	{
		const rows = []
		try {
			const g = glossarySummary(loadGlossaryLedger(root))
			rows.push(row('名词', `${g.count} 条 · ${g.categories} 类${g.missing.length ? ` · 缺字段 ${g.missing.length}` : ''}`, g.missing.length ? 'warn' : undefined))
		} catch (e) {
			rows.push(row('名词', `读不动：${e?.message ?? e}`, 'error'))
		}
		try {
			const pending = fs.existsSync(askPaths(root).pending)
				? fs.readFileSync(askPaths(root).pending, 'utf8').split('\n').filter((l) => l.trim()).length
				: 0
			rows.push(row('答疑', `待答 ${pending} · 已答 ${Object.keys(loadLedger(root)).length}`, pending > 0 ? 'warn' : undefined))
		} catch (e) {
			rows.push(row('答疑', `读不动：${e?.message ?? e}`, 'error'))
		}
		try {
			rows.push(row('笔记', `${readNotes(root).length} 条`))
		} catch (e) {
			rows.push(row('笔记', `读不动：${e?.message ?? e}`, 'error'))
		}
		sections.push({ title: '台账', rows })
	}

	// ⑤ 学生工作区（probeState 扫 code/）—— 只报"几个项目 / 还缺几项"
	try {
		const { state, warnings } = probeState(root, pack)
		const gaps = state.projects.reduce((n, p) => n + p.lessons.reduce((m, l) => m + (l.missing?.length || 0), 0), 0)
		const rows = [
			row('项目', `${state.projects.length} 个`),
			row('待补缺口', `${gaps} 项`, gaps > 0 ? 'warn' : 'ok'),
		]
		if (warnings.length) rows.push(row('扫描告警', warnings.slice(0, 2).join('；'), 'warn'))
		sections.push({ title: '学生工作区', rows })
	} catch (e) {
		sections.push(failed('学生工作区', e))
	}

	// ⑥ 插件自身（不读课程包也成立的那几项）
	{
		const rows = [row('版本', pluginVersion() ?? '（读不到）')]
		if (hctx.paths?.root) rows.push(row('数据目录', hctx.paths.root))
		rows.push(row('本卡来源', `GET ${ROUTE_PATH}（只读）`))
		sections.push({ title: '插件', rows })
	}

	return sections
}

export const plugin = {
	id: 'status',
	version: '0.1.0',
	tools: [], // 只提供一条只读路由，不动工具面

	install(hctx) {
		const route = {
			path: ROUTE_PATH,
			methods: ['GET'],
			// ⚠️ **必须显式写**，哪怕只收 GET。基座（`dsh-client-connection/lib/index.js:47,74-80`）这样分流：
			//     `bodyMode === 'buffered'` → 正常缓冲请求体；
			//     否则 → `new Request(url, { method, headers, body: Readable.toWeb(req), duplex: 'half' })`
			//   省略这个字段时，方法匹配取到 `undefined`、**掉进 else**，于是给 GET 装了个 body
			//   ⇒ `Request with GET/HEAD method cannot have body` 抛在基座里 ⇒ 回 **400 空体**
			//   ⇒ 浏览器那侧 `.json()` 报 `Unexpected end of JSON input`（**报错指向 JSON，真因在这里**）。
			//   2026-09-24 现场踩到：设置页那张卡"取不到状态"就是这么来的。
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'GET') return json(405, { ok: false, error: '只接受 GET' })
				const root = hctx.paths.packRoot
				if (!root) {
					return json(200, {
						ok: true,
						configured: false,
						packRoot: null,
						version: pluginVersion(),
						// 入口在没配课程包时也发出去（协议本身不依赖课程包）——
						// 半途 503 的那一步由下面这段 hint 说清，别让按钮静默消失。
						entry: buildStarter(null),
						hint: '未配置 packRoot —— 所有 /api/whale/* 会返回 503。'
							+ '请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加一段 '
							+ '`- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。详见 README「装」那节。',
					})
				}
				const abs = path.resolve(root)
				return json(200, {
					ok: true,
					configured: true,
					packRoot: abs,
					version: pluginVersion(),
					sections: buildSections(abs, hctx),
					entry: buildStarter(abs),
				})
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
					hctx.log?.info?.(`状态路由已挂 ${ROUTE_PATH}（只读；设置页那张卡靠它）`)
				} catch (e) {
					hctx.log?.error?.(`挂 ${ROUTE_PATH} 失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：状态路由未注册')
		}
	},
}
