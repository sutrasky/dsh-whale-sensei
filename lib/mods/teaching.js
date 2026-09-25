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
 *   · `op=propose` —— 把"多加点注释"这种没法执行的话**翻译成具体取值**，回一份预览（**不写盘**）；
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
import { TIERS } from '../goal-io.js'

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
	version: '0.2.0',
	tools: ['whale_teaching'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_teaching',
			description:
				'教学参数（learning-records/teaching.jsonl，**按圆圈分节**）：学生可以按自己接受到的教学提要求，agent 据此改**可调项**。'
				+ '全局层是**学科中立**的（讲解顺序 / 术语 / 报错）；**每个圆圈有自己独立的教学方法**，'
				+ '由该圆圈的 `kind=spec` 记录声明（可调项 + 取值域 + 每档怎么教的指令句），取值走 `kind=values`。'
				+ '**锁死集（教学纪律，学生说改也不改）**：' + TEACHING_DISCIPLINE.map((d) => d.label).join(' / ') + '。'
				+ '三个动作：read=看某个圆圈的生效参数与可调项；propose=把"多加点注释"这类话翻译成具体取值并回预览（**不写盘**）；'
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
	},
}
