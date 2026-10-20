/**
 * lib/mods/goal.js — 能力模块：终点契约（`whale_goal`）
 * ------------------------------------------------------------------
 * **为什么有这个工具（2026-09-24 F1b）**：终点（`learning-records/goals.jsonl`）原来
 * **只有 wizard 那条表单路**能写 —— `goalFromForm()` 只被 `lib/mods/starter.js` 的 `composeAt` 调。
 * 而 v3 要把表单屏删掉、改成「点知识点卡片零填写」；删完就**没有入口**了
 * （`missingRequired` 会直接回 400，或者终点契约悄悄断供）。
 *
 * `goal-io.js` 的 `GOAL_SOURCES` 里**早就声明了 `'agent'`** —— 这个工具就是把那个来源接上：
 * 三段流程的 ②看挑战段问完终点，由 agent 落盘。
 *
 * 复用 `goalFromForm()`（`lib/starter.js`）做「表单形态 → 契约入参」的映射 —— **不另写一份**，
 * 否则又是一处"同一事实两套口径"（本项目最忌讳的东西）。
 *
 * ⚠️ 顺序：**先 `whale_intake op=record`，再 `whale_goal`** —— `recordGoal` 的 `from`
 * 不传时会自动从该 point 最新 intake 的 `start`（起点台阶）拷贝；反了的话 `from` 只能是 null。
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { goalFromForm } from '../starter.js'
import { readGoals, recordGoal, TIERS } from '../goal-io.js'
import { readPack } from '../pack-model.js'
import { resolvePointRef, describePointRef } from '../point-ref.js'

// U16：失败结构取 U03 的唯一实现（不在本模块另造码/字段）。
const requireCJS = createRequire(import.meta.url)
const { makeFailure } = requireCJS('../unify/errors.cjs')

/**
 * 原来那条"裸 id 查包补圆圈"的行为**逐字保留**（append-only 的历史与下游 `latest` 形状都依赖它）：
 * 查到唯一一个就补成 `circle/point`，查不到就原样用（不猜）。
 * @param {string} root
 * @param {string} point
 * @returns {string}
 */
export function resolvePointId(root, point) {
	const s = String(point ?? '').trim()
	if (!s) return ''
	if (s.includes('/')) return s
	try {
		const pack = readPack(path.resolve(root))
		const hit = (pack.points || []).find((p) => p.id === s)
		if (hit && hit.circle) return `${hit.circle}/${hit.id}`
	} catch { /* 包读不动就原样用 */ }
	return s
}

/**
 * 身份**不唯一**时的一条可读告警（U16）：不给调用方悄悄挑一个的机会。
 *
 * 为什么要它：`resolvePointId()` 的 `.find()` 在跨圈同名裸 id 上会取**第一个**候选，
 * 那条路是既有的（`test/intake-id-resolve.mjs` 明确钉着"歧义下不炸、from 拿不到"），
 * 本轮**不改它**（改它等于改旧契约）。但"悄悄写到某个实体上"不能不留痕 ——
 * 所以回执里带 `warning` + `candidates`，让调用方（agent / 界面）看得见并能立即纠正。
 *
 * @param {string} root 课程包根目录
 * @param {string} point 调用方给的原始引用
 * @returns {{code:string, error:string, candidates:string[]}|null} 没有歧义/未知 → null
 */
export function pointIdentityWarning(root, point) {
	const s = String(point ?? '').trim()
	if (!s || !root) return null
	let pack = null
	try { pack = readPack(path.resolve(root)) } catch { return null }
	let ref = null
	try { ref = resolvePointRef({ pack, ref: s }) } catch { return null }
	if (!ref || ref.ok !== false) return null
	return {
		code: ref.code === 'ambiguous' ? 'ID_AMBIGUOUS' : ref.code,
		error: describePointRef(ref),
		candidates: Array.isArray(ref.candidates) ? ref.candidates : [],
	}
}

export const plugin = {
	id: 'goal',
	version: '0.1.0',
	tools: ['whale_goal'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_goal',
			description:
				'终点契约（goals.jsonl）：record=把学生说清的终点落成一版契约（point + goal 原文 + tier + acceptance 必填）；'
				+ 'read=列出各知识点的**现行终点**与台账问题。'
				+ '这是「新开下一课」三段流程里 **②看挑战段**的落盘口：问清「学完要能做出什么 / 学到哪一层 / 验收判据」之后调它。'
				+ '⚠️ 先 whale_intake op=record 再 whale_goal —— 契约里的 from（起点台阶）会自动从最新摸底拷贝。'
				+ 'append-only：换终点 = 追一版新的，不覆盖旧的（v / replaces 由台账算）。绝不写时间戳。',
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', enum: ['record', 'read'], default: 'record', description: '操作类型' },
					point: { type: 'string', description: '知识点 id（`programming/spring-boot` 或裸 `spring-boot`；record 必填）' },
					halo: { type: 'string', description: '圆圈 id（可选）：跨圈同名知识点用它消歧 —— 给了就**只认这个圈**，对不上/未知一律拒写（不猜）' },
					goal: {
						type: 'string',
						description: '「学完要能做出什么」—— **学生原话逐字**，一句话就够（record 必填）。绝不拿摸底的 level/can 回落顶替',
					},
					tier: {
						type: 'number',
						description: `学到哪一层，${TIERS.join(' / ')}（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）—— record 必填`,
					},
					acceptance: {
						type: 'array',
						items: { type: 'string' },
						description: '验收判据，一行一条：写成什么样就算过（record 必填，至少一条）',
					},
					work: { type: 'string', description: '作品放哪（作品仓 / 路径，可选）' },
					reason: { type: 'string', description: '换终点时的理由（可选；append-only 留痕用）' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					const lines = []
					if (v.op === 'record') {
						const r = v.record || {}
						lines.push(`✅ 终点已落盘：${r.point} · v${r.v} · tier ${r.tier}（验收 ${(r.acceptance || []).length} 条）→ ${v.file}`)
						lines.push(`   作品：${r.artifact?.what || '（空）'}`)
						for (const a of r.acceptance || []) lines.push(`   ${a.no}. ${a.deliverable}（${a.auto === false ? '需人工确认' : '机器可判'}）`)
						if (r.from) lines.push(`   起点台阶：tier ${r.from.tier ?? '未定档'}（从最新摸底拷贝）`)
						// U16：身份不唯一时把告警摆在回执里（学生/agent 都能看见并立刻纠正）
						if (v.warning) lines.push(`⚠️ ${v.warning}`)
					} else {
						const pts = Object.keys(v.points || {})
						lines.push(`🎯 终点契约：${pts.length} 个知识点有现行终点（台账 ${v.count} 行）`)
						for (const p of pts) {
							const g = v.points[p]
							lines.push(`· ${p}：v${g.v} · tier ${g.tier} —— ${g.artifact?.what || '（空）'}`)
						}
						if (!pts.length) lines.push('（还没有任何知识点定过终点 —— 这课开之前先问清「学完要能做出什么」）')
						if (v.problems?.length) lines.push(`⚠️ 台账问题：${v.problems.join('；')}`)
					}
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const op = args.op || 'record'
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }

				if (op === 'read') {
					const { entries, latest, problems } = readGoals(path.resolve(root))
					return { ok: true, op: 'read', count: entries.length, points: latest, problems }
				}

				const pointIdRaw = args.point
				// U16：显式给了 `halo`（圆圈）就走**严格解析**（唯一匹配才认；错圈/未知/歧义一律拒写）——
				// 这是跨圈同名知识点"发送目标不同"的工具侧出口；不给 halo 则沿用既有补全口径（见下面的告警）。
				const halo = typeof args.halo === 'string' && args.halo.trim() ? args.halo.trim() : ''
				let pointId = resolvePointId(root, pointIdRaw)
				if (halo) {
					let ref = null
					try { ref = resolvePointRef({ pack: readPack(path.resolve(root)), ref: pointIdRaw, halo }) } catch { ref = null }
					if (ref && ref.ok === false) {
						const code = ref.code === 'ambiguous' ? 'ID_AMBIGUOUS' : ref.code
						const error = `知识点身份认不出来，拒写（不猜是哪一个）：${describePointRef(ref)}`
						return { ok: false, error, failure: makeFailure({ kind: 'input', code, error }), candidates: ref.candidates }
					}
					if (ref && ref.ok === true) pointId = ref.key
				}
				if (!pointId) return { ok: false, error: 'op=record 需要 point（`programming/spring-boot` 或裸 `spring-boot`）' }
				// 身份不唯一时的可读告警（不改既有落盘口径，但绝不静默）
				const identityWarning = halo ? null : pointIdentityWarning(root, pointIdRaw)
				const goal = String(args.goal ?? '').trim()
				if (!goal) return { ok: false, error: 'op=record 需要 goal：「学完要能做出什么」，**学生原话逐字**一句话' }
				const tierRaw = String(args.tier ?? '').trim()
				if (!TIERS.includes(Number(tierRaw))) {
					return { ok: false, error: `op=record 需要 tier ∈ ${TIERS.join(' / ')}（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）` }
				}
				const accRaw = Array.isArray(args.acceptance) ? args.acceptance.join('\n') : String(args.acceptance ?? '')
				if (!accRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length) {
					return { ok: false, error: 'op=record 需要 acceptance：验收判据，一行一条，至少一条' }
				}

				// 映射只有一份：走 goalFromForm（表单形态 → 契约入参），不在这里另写一套
				const input = goalFromForm({ goal, work: args.work ?? '', tier: tierRaw, acceptance: accRaw }, pointId)
				if (!input) return { ok: false, error: `point 认不出归属：${JSON.stringify(args.point)}` }
				input.source = 'agent' // GOAL_SOURCES 里声明过的来源
				if (args.reason) input.reason = String(args.reason).trim()

				const res = recordGoal(path.resolve(root), input)
				if (!res.ok) return { ok: false, error: `终点契约没写成（拒写）：${res.error}` }
				return {
					ok: true, op: 'record', file: res.file, record: res.record, goalSaved: true,
					// 落盘照旧成功（append-only 与既有口径不变），但身份不唯一这件事必须**看得见**
					...(identityWarning ? {
						warning: `知识点身份不唯一：${identityWarning.error} —— 本条按点键「${pointId}」落了盘；要唯一识别请写完整「圆圈/知识点」或给 halo`,
						candidates: identityWarning.candidates,
					} : {}),
				}
			},
		})
	},
}
