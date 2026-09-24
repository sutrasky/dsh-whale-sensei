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
import { goalFromForm } from '../starter.js'
import { readGoals, recordGoal, TIERS } from '../goal-io.js'
import { readPack } from '../pack-model.js'

/** `point` 归一到 `circle/point` 形态：给了裸 id 就查包补圆圈；查不到就原样用（不猜） */
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

				const pointId = resolvePointId(root, args.point)
				if (!pointId) return { ok: false, error: 'op=record 需要 point（`programming/spring-boot` 或裸 `spring-boot`）' }
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
				return { ok: true, op: 'record', file: res.file, record: res.record, goalSaved: true }
			},
		})
	},
}
