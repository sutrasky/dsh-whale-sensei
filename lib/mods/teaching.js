/**
 * lib/mods/teaching.js — 能力模块：教学参数（`whale_teaching`）
 * ------------------------------------------------------------------
 * 主人的要求（`_board/01-鲸师.md:278-280`）：**学生可以按自己接受到的教学提要求**，
 * agent 据此改进**可以改动的**教学方法 —— 不是通用解，这些方法最终进提示词。
 *
 * 三个动作（照 `01:312` 的「读 / 提议 / 确认写」）：
 *   · `op=read`    —— 看现行参数（生效值 = 档位默认 ⊕ 学生覆盖）、可调集、**锁死集**、自由补充；
 *   · `op=propose` —— 把"多加点注释"这种没法执行的话**翻译成具体取值**，回一份
 *                     「会落盘的那一行」预览（**不写盘**）；
 *   · `op=write`   —— 落盘，**必须 `confirm:true`**（学生点头才写，照偏好台账的规矩）。
 *
 * ⚠️ 唯一校验器在 `lib/teaching-io.js` —— 本文件**只做工具面**（参数解析 / 预览 / 回执），
 *    取值域、锁死集、上限一律走那边，不许在这里再写一份判法。
 * ⚠️ 命名避让（`01:325`）：主题占了 `style` 这个词，教学风格一律用 **teaching**。
 */

import path from 'node:path'
import {
	readTeaching, recordTeaching, resolveParams, validateTeaching,
	TEACHING_PARAMS, TEACHING_DISCIPLINE, FREE_TEXT_MAX, FREE_TEXT_MAX_CHARS,
} from '../teaching-io.js'
import { TIERS } from '../goal-io.js'

/** 参数表 → 人话（工具描述与回执共用一份，别抄两遍） */
function paramsHint() {
	return Object.entries(TEACHING_PARAMS)
		.map(([id, d]) => `${id}（${d.label}：${d.values.join(' / ')}${d.multi ? '，可多选' : ''}）`)
		.join('；')
}

/** 自由补充入参 → 待写项（字符串数组或 {text} 数组都收） */
function toFreeText(raw) {
	if (raw === undefined || raw === null) return []
	const arr = Array.isArray(raw) ? raw : [raw]
	return arr
		.map((x) => (typeof x === 'string' ? { text: x } : (x && typeof x === 'object' ? x : null)))
		.filter(Boolean)
		.map((x) => ({ text: String(x.text ?? ''), source: x.source ?? 'student', confirmed: true }))
}

export const plugin = {
	id: 'teaching',
	version: '0.1.0',
	tools: ['whale_teaching'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_teaching',
			description:
				'教学参数（learning-records/teaching.jsonl）：学生可以按自己接受到的教学提要求，agent 据此改**可调项**。'
				+ `可调集：${paramsHint()}。`
				+ '**锁死集（教学纪律，学生说改也不改）**：' + TEACHING_DISCIPLINE.map((d) => d.label).join(' / ') + '。'
				+ '三个动作：read=看现行参数与可调集；propose=把"多加点注释"这类话翻译成具体取值并回一份预览（**不写盘**）；'
				+ `write=落盘（**必须 confirm:true** —— 学生点头才写）。append-only：换参数 = 追一版新的，不覆盖旧的。`
				+ `自由补充上限 ${FREE_TEXT_MAX} 条 × ${FREE_TEXT_MAX_CHARS} 字，超了**拒写并提示合并**。`,
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', enum: ['read', 'propose', 'write'], default: 'read', description: '操作类型' },
					tier: { type: 'number', description: `按哪一档算默认值，${TIERS.join(' / ')}（不给就用台账现行档，再没有按 1）` },
					params: {
						type: 'object',
						description: `要改的可调项（键 = 参数 id，值 = 取值或取值数组）：${paramsHint()}`,
					},
					freeText: {
						type: 'array',
						items: { type: 'string' },
						description: `自由补充那一小撮（每条 ≤ ${FREE_TEXT_MAX_CHARS} 字，最多 ${FREE_TEXT_MAX} 条）—— 没法枚举的要求写这儿`,
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
						lines.push(`✅ 教学参数已落盘：v${r.v} · tier ${r.tier} → ${v.file}`)
						for (const [id, val] of Object.entries(r.params || {})) {
							lines.push(`   ${id} = ${Array.isArray(val) ? val.join(' + ') : val}`)
						}
						for (const f of r.freeText || []) lines.push(`   （自由补充）${f.text}`)
						if (!Object.keys(r.params || {}).length && !(r.freeText || []).length) lines.push('   （这一版没有任何覆盖 —— 全部落回档位默认）')
					} else {
						const cur = v.current || {}
						lines.push(`⚙️ 教学参数（现行 v${v.version ?? '—'} · tier ${cur.tier}）：`)
						for (const [id, val] of Object.entries(cur.params || {})) {
							const mark = (cur.overridden || []).includes(id) ? '（学生改过）' : '（档位默认）'
							lines.push(`   ${id} = ${Array.isArray(val) ? val.join(' + ') : val} ${mark}`)
						}
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

				const { entries, latest, problems } = readTeaching(abs)
				const tierArg = args.tier === undefined || args.tier === null ? null : Number(args.tier)
				if (tierArg !== null && !TIERS.includes(tierArg)) {
					return { ok: false, error: `tier 必须是 ${TIERS.join(' / ')}（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）` }
				}
				const tier = tierArg ?? (latest && TIERS.includes(latest.tier) ? latest.tier : 1)
				const current = resolveParams(latest ? { ...latest, tier } : { tier })

				if (op === 'read') {
					return {
						ok: true, op: 'read', file: readTeaching(abs).file,
						version: latest ? latest.v : null,
						current,
						freeText: latest?.freeText || [],
						params: TEACHING_PARAMS, discipline: TEACHING_DISCIPLINE,
						problems,
					}
				}

				// ⚠️ **累积合并**：这一版没提的可调项要**沿用之前的覆盖**，否则"只加一条自由补充"
				//    就会把之前调过的参数**静默丢掉**（append-only + 最新一条生效 ⇒ 最新那条是全部真相）。
				//    只累积**学生改过的项**（不是把默认值全写进去）—— 这样 `overridden` 仍然有意义。
				//    `null` = **显式落回档位默认**（取消某项覆盖的唯一出口；不写 null 就沿用）。
				const prevParams = {}
				for (const e of entries) Object.assign(prevParams, e.params || {})
				const nextParams = { ...prevParams }
				for (const [k, val] of Object.entries(args.params || {})) {
					if (val === null) delete nextParams[k]
					else nextParams[k] = val
				}
				const candidate = {
					tier,
					params: nextParams,
					freeText: toFreeText(args.freeText),
					source: 'student',
					reason: args.reason ?? null,
				}
				let normalized
				try {
					normalized = validateTeaching({ ...candidate, v: undefined, replaces: undefined }, { strict: true, where: 'TeachingRecord' })
				} catch (e) {
					return { ok: false, error: e.message }
				}
				const previewLine = JSON.stringify({ ...normalized, v: (latest?.v ?? 0) + 1, replaces: latest?.v ?? null })
				const merged = resolveParams({ tier, params: normalized.params })

				if (op === 'propose') {
					return {
						ok: true, op: 'propose', file: readTeaching(abs).file,
						version: latest ? latest.v : null,
						current: merged, freeText: normalized.freeText,
						previewLine, wouldWrite: normalized,
						problems,
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
