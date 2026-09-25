/**
 * lib/mods/teaching.js — 能力模块：教学参数（`whale_teaching`）
 * ------------------------------------------------------------------
 * 主人的要求（`_board/01-鲸师.md:278-280`）：**学生可以按自己接受到的教学提要求**，
 * agent 据此改进**可以改动的**教学方法 —— 不是通用解，这些方法最终进提示词。
 *
 * 2026-09-25 主人裁定：**按圆圈分节** —— 每个圆圈有自己独立的教学方法；
 * 学科特化**只在该圆圈的记录里**（代码里不留学科知识）。
 *
 * 三个动作（照 `01:312` 的「读 / 提议 / 确认写」）：
 *   · `op=read`    —— 看某个圆圈的生效参数（全局 ⊕ 该圆圈）、可调项、**锁死集**、自由补充；
 *   · `op=propose` —— 把"讲慢一点"这种没法直接执行的话**翻译成具体取值**，回一份预览（**不写盘**）；
 *   · `op=write`   —— 落盘，**必须 `confirm:true`**（学生点头才写）。
 *
 * 两种记录（`kind`）：
 *   · `spec`（**圆圈**专用）：声明这个圆圈有哪些可调项、取值域、每个取值的**指令句**、档位默认；
 *   · `values`（默认）：某一层级（全局 `circle:'*'` 或某个圆圈）的**取值**。
 *
 * ⚠️ 唯一校验器在 `lib/teaching-io.js` —— 本文件**只做工具面**（参数解析 / 预览 / 回执）。
 * ⚠️ 命名避让（`01:325`）：主题占了 `style` 这个词，教学风格一律用 **teaching**。
 */

import path from 'node:path'
import {
	readTeaching, recordTeaching, resolveFor, validateTeaching,
	TEACHING_PARAMS, TEACHING_DISCIPLINE, GLOBAL_CIRCLE, KINDS,
	FREE_TEXT_MAX, FREE_TEXT_MAX_CHARS, specFor,
} from '../teaching-io.js'
import { teachingView, requestText } from '../teaching-view.js'
import { readPack } from '../pack-model.js'
import { TIERS } from '../goal-io.js'

/**
 * 设置页那两条路由（**只读 + 发起对话**，两条都**不写盘**）。
 *
 * 为什么放在这个模块里：它们跟 `whale_teaching` 是**同一件事的两个面** ——
 * 工具面给 agent（读 / 提议 / 确认写），路由面给**设置页**（看现状 / 把学生那句话交给 agent）。
 * 落盘口仍然只有 `recordTeaching()` 一个，路由面**不碰**它。
 */
const VIEW_ROUTE = '/api/whale/teaching'
const REQUEST_ROUTE = '/api/whale/teaching/request'

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 没配 packRoot 时的统一答复（与 `/api/whale/catalog`、`/api/whale/status` 同一立场：说人话） */
const noPack = () => json(200, {
	ok: false,
	configured: false,
	error: '未配置 packRoot —— 请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加 `- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。',
})

/** 课程包里的圆圈清单（设置页要**全部**列出来：还没定过教学方式的圆圈，学生正是要对它提要求） */
function packCircles(abs) {
	try {
		return readPack(abs).circles.map((c) => ({ id: c.id, name: c.name || c.id }))
	} catch {
		// 读不动课程包不算"没有圆圈" —— 交给调用方按空清单走，台账里已有的圆圈仍会列出来
		return []
	}
}

/** 可调项清单 → 人话（全局 + 该圆圈；工具描述与回执共用一份） */
function paramsHint(circle, spec) {
	const g = Object.entries(TEACHING_PARAMS)
		.map(([id, d]) => `${id}（${d.label}：${d.values.map((v) => v.id).join(' / ')}）`)
		.join('；')
	const c = (spec || []).map((s) => `${s.id}（${s.label}：${s.values.map((v) => v.id).join(' / ')}）`).join('；')
	return circle === GLOBAL_CIRCLE
		? `全局（学科中立）：${g}`
		: `全局（学科中立）：${g}　｜　圆圈「${circle}」特化：${c || '(该圆圈还没声明 spec —— 先用 kind=spec 声明它有哪些可调项)'}`
}

/** 自由补充入参 → 待写项 */
function toFreeText(raw) {
	if (raw === undefined || raw === null) return []
	const arr = Array.isArray(raw) ? raw : [raw]
	return arr
		.map((x) => (typeof x === 'string' ? { text: x } : (x && typeof x === 'object' ? x : null)))
		.filter(Boolean)
		.map((x) => ({ text: String(x.text ?? ''), source: x.source ?? 'student', confirmed: true }))
}

/** 累积合并：这一版没提的可调项**沿用之前的覆盖**（否则只加一条自由补充就把参数静默丢了） */
function mergeParams(entries, circle, given) {
	const prev = {}
	for (const e of entries) {
		if (!e || e.circle !== circle || (e.kind ?? 'values') !== 'values') continue
		Object.assign(prev, e.params || {})
	}
	const next = { ...prev }
	for (const [k, v] of Object.entries(given || {})) {
		if (v === null) delete next[k]      // null = 显式落回档位默认（取消覆盖的唯一出口）
		else next[k] = v
	}
	return next
}

export const plugin = {
	id: 'teaching',
	version: '0.3.0',
	tools: ['whale_teaching'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_teaching',
			description:
				'教学参数（learning-records/teaching.jsonl，**按圆圈分节**）：学生可以按自己接受到的教学提要求，agent 据此改**可调项**。'
				+ '全局层是**学科中立**的（讲解顺序 / 术语 / 报错）；**每个圆圈有自己独立的教学方法**，'
				+ '由该圆圈的 `kind=spec` 记录声明（可调项 + 取值域 + 每档怎么教的指令句），取值走 `kind=values`。'
				+ '**锁死集（教学纪律，学生说改也不改）**：' + TEACHING_DISCIPLINE.map((d) => d.label).join(' / ') + '。'
				+ '三个动作：read=看某个圆圈的生效参数与可调项；propose=把"讲慢一点"这类话翻译成具体取值并回预览（**不写盘**）；'
				+ `write=落盘（**必须 confirm:true** —— 学生点头才写）。append-only：换一版追一条，不覆盖。`
				+ `自由补充上限 ${FREE_TEXT_MAX} 条 × ${FREE_TEXT_MAX_CHARS} 字，超了**拒写并提示合并**。`,
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', enum: ['read', 'propose', 'write'], default: 'read', description: '操作类型' },
					circle: { type: 'string', description: `圆圈 id（如 programming）；全局层用 '${GLOBAL_CIRCLE}'。默认 '${GLOBAL_CIRCLE}'` },
					kind: { type: 'string', enum: [...KINDS], default: 'values', description: 'spec=声明这个圆圈的可调项；values=写取值' },
					tier: { type: 'number', description: `按哪一档算默认值，${TIERS.join(' / ')}（不给就用台账现行档，再没有按 1）` },
					spec: {
						type: 'array',
						items: { type: 'object' },
						description: 'kind=spec 时必填：该圆圈的可调项 [{ id, label, values:[{ id, directive }], defaultByTier }]',
					},
					params: {
						type: 'object',
						description: '要改的可调项（键 = 参数 id，值 = 取值或取值数组；给 null = 落回档位默认）',
					},
					freeText: {
						type: 'array',
						items: { type: 'string' },
						description: `自由补充那一小撮（每条 ≤ ${FREE_TEXT_MAX_CHARS} 字，最多 ${FREE_TEXT_MAX} 条）`,
					},
					confirm: { type: 'boolean', description: 'write 必填 true：学生点头了才写（没点头一律拒写）' },
					reason: { type: 'string', description: '换参数的理由（可选；append-only 留痕用）' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					const lines = []
					if (v.op === 'write') {
						const r = v.record || {}
						lines.push(`✅ 教学参数已落盘：${r.circle}/${r.kind} · v${r.v} → ${v.file}`)
						if (r.kind === 'spec') {
							for (const s of r.spec || []) lines.push(`   ${s.id}（${s.label}）：${s.values.map((x) => x.id).join(' / ')}`)
						} else {
							for (const [id, val] of Object.entries(r.params || {})) lines.push(`   ${id} = ${Array.isArray(val) ? val.join(' + ') : val}`)
							for (const f of r.freeText || []) lines.push(`   （自由补充）${f.text}`)
						}
					} else {
						const cur = v.current || {}
						lines.push(`⚙️ 教学参数（${v.circle} · tier ${cur.tier} · 现行 v${v.version ?? '—'}）：`)
						for (const [id, val] of Object.entries(cur.params || {})) {
							const mark = (cur.overridden || []).includes(id) ? '（学生改过）' : '（档位默认）'
							lines.push(`   ${id} = ${Array.isArray(val) ? val.join(' + ') : val} ${mark}`)
						}
						if (!Object.keys(cur.params || {}).length) lines.push('   （还没有任何可调项 —— 全局的看代码里的表，圆圈的要先声明 spec）')
						lines.push(`   🔒 锁死（不开放调整）：${TEACHING_DISCIPLINE.map((d) => `${d.label}——${d.why}`).join('；')}`)
						for (const f of v.freeText || []) lines.push(`   （自由补充）${f.text}`)
						if (v.op === 'propose') {
							lines.push('👀 预览（**还没写盘**）：')
							lines.push(`   ${v.previewLine}`)
							lines.push('   学生点头后再调 op=write + confirm:true。')
						}
						if (v.problems?.length) lines.push(`⚠️ 台账问题：${v.problems.join('；')}`)
					}
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const op = args.op || 'read'
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				const circle = String(args.circle ?? GLOBAL_CIRCLE).trim() || GLOBAL_CIRCLE
				const kind = args.kind || 'values'

				const data = readTeaching(abs)
				const spec = specFor(data, circle)
				const resolved = resolveFor(data, circle)
				const tierArg = args.tier === undefined || args.tier === null ? null : Number(args.tier)
				if (tierArg !== null && !TIERS.includes(tierArg)) {
					return { ok: false, error: `tier 必须是 ${TIERS.join(' / ')}（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）` }
				}
				const tier = tierArg ?? resolved.tier

				if (op === 'read') {
					return {
						ok: true, op: 'read', file: data.file, circle,
						version: (circle === GLOBAL_CIRCLE ? data.global.v : (data.circles[circle]?.valuesV ?? 0)) || null,
						current: { ...resolved, tier },
						spec, params: TEACHING_PARAMS, discipline: TEACHING_DISCIPLINE,
						circles: Object.keys(data.circles),
						freeText: (circle === GLOBAL_CIRCLE ? data.global.values : data.circles[circle]?.values)?.freeText || [],
						problems: data.problems,
					}
				}

				// propose / write 共用同一套校验 —— 差别只在"写不写盘"
				const candidate = kind === 'spec'
					? { circle, kind, spec: args.spec ?? null, source: 'agent', reason: args.reason ?? null }
					: {
						circle, kind, tier,
						params: mergeParams(data.entries, circle, args.params),
						freeText: toFreeText(args.freeText),
						source: 'student',
						reason: args.reason ?? null,
					}
				let normalized
				try {
					normalized = validateTeaching({ ...candidate, v: undefined, replaces: undefined }, { strict: true, where: 'TeachingRecord', spec })
				} catch (e) {
					return { ok: false, error: e.message }
				}
				const same = data.entries.filter((e) => e && e.circle === circle && (e.kind ?? 'values') === kind)
				const maxV = same.reduce((n, e) => (Number.isSafeInteger(e.v) && e.v > n ? e.v : n), 0)
				const previewLine = JSON.stringify({ ...normalized, v: maxV + 1, replaces: maxV || null })

				if (op === 'propose') {
					return {
						ok: true, op: 'propose', file: data.file, circle,
						version: maxV || null,
						current: { ...resolved, tier }, spec,
						freeText: normalized.freeText || [],
						previewLine, wouldWrite: normalized,
						problems: data.problems,
					}
				}

				if (args.confirm !== true) {
					return { ok: false, error: 'op=write 需要 confirm:true —— 学生点头了才写（先用 op=propose 给他看预览）' }
				}
				const res = recordTeaching(abs, candidate)
				if (!res.ok) return { ok: false, error: `教学参数没写成（拒写）：${res.error}` }
				return { ok: true, op: 'write', file: res.file, record: res.record, teachingSaved: true }
			},
		})

		registerRoutes(hctx)
	},
}

/**
 * 挂设置页那两条路由。
 *
 * **两条都不写盘**：
 *   · `GET  ${VIEW_ROUTE}`            → 现行取值 + 注入原文（设置页渲染用）；
 *   · `POST ${REQUEST_ROUTE}`         → 把「圆圈 + 学生原话」拼成给 agent 的正文，**只回文本**。
 *
 * 学生点「发给老师」之后：宿主拼的正文被塞进当前会话 → 鲸师读它 → `whale_teaching op=read/propose/write`。
 * 落盘口仍是 `recordTeaching()` 一处（路由面不碰）—— 所以"设置页能改参数"这条路上
 * **没有第二个写口**，也就没有第二套校验。
 */
function registerRoutes(hctx) {
	const viewRoute = {
		path: VIEW_ROUTE,
		methods: ['GET'],
		requestBody: 'buffered',
		fetch: async (request) => {
			if (request.method !== 'GET') return json(405, { ok: false, error: '只接受 GET' })
			const root = hctx.paths.packRoot
			if (!root) return noPack()
			const abs = path.resolve(root)

			let data
			try {
				data = readTeaching(abs)
			} catch (e) {
				return json(200, { ok: false, configured: true, error: `读教学台账失败：${e?.message ?? e}` })
			}
			const view = teachingView(data, { circles: packCircles(abs) })
			return json(200, { ok: true, configured: true, packRoot: abs, ...view })
		},
	}

	const requestRoute = {
		path: REQUEST_ROUTE,
		methods: ['POST'],
		requestBody: 'buffered',
		fetch: async (request) => {
			if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
			const root = hctx.paths.packRoot
			if (!root) return noPack()
			const abs = path.resolve(root)

			let body
			try {
				body = await request.json()
			} catch {
				return json(400, { ok: false, error: '请求体不是 JSON' })
			}
			const circle = String(body?.circle ?? GLOBAL_CIRCLE).trim() || GLOBAL_CIRCLE

			let data
			try {
				data = readTeaching(abs)
			} catch (e) {
				return json(200, { ok: false, configured: true, error: `读教学台账失败：${e?.message ?? e}` })
			}
			const circles = packCircles(abs)
			// 圆圈必须是**真实存在的**（课程包里的，或台账里留着的）—— 拼一段指向不存在圆圈的话，
			// 老师只能去猜，那还不如当场拒掉。全局层 `*` 永远合法。
			const known = new Set([GLOBAL_CIRCLE, ...circles.map((c) => c.id), ...Object.keys(data.circles || {})])
			if (!known.has(circle)) {
				return json(400, { ok: false, error: `课程包里没有圆圈「${circle}」—— 刷新一下设置页再看（可能是刚改过目录）` })
			}

			let text
			try {
				text = requestText({ circle, request: body?.request, view: teachingView(data, { circles }) })
			} catch (e) {
				// 空 / 超长都在这里 —— **不截断**（截断会把学生的意思改掉），把话说清楚让他重说
				return json(400, { ok: false, error: e?.message ?? String(e) })
			}
			return json(200, { ok: true, configured: true, circle, chars: text.length, text })
		},
	}

	if (typeof hctx.inject !== 'function') {
		hctx.log?.warn?.('宿主没有注入能力：教学方式路由未注册')
		return
	}
	hctx.inject(['connection'], (c) => {
		const conn = c.get('connection')
		if (!conn?.fetch?.register) {
			hctx.log?.warn?.(`connection 服务没有 fetch.register —— ${VIEW_ROUTE} / ${REQUEST_ROUTE} 没挂上`)
			return
		}
		for (const route of [viewRoute, requestRoute]) {
			try {
				conn.fetch.register(route)
				hctx.log?.info?.(`教学方式路由已挂 ${route.path}`)
			} catch (e) {
				hctx.log?.error?.(`挂 ${route.path} 失败：${e?.message ?? e}`)
			}
		}
	})
}
