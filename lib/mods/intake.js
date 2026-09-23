/**
 * lib/mods/intake.js — 能力模块：学情摸底（`whale_intake`）
 * ------------------------------------------------------------------
 * 工具 `whale_intake`：规划摸底问题、记录学生回答、读取摸底状态。
 * 与 `whale_author` 同形状：五字段齐全（name / description / parameters / output / execute）。
 */

import path from 'node:path'
import { buildQuestions, recordIntake, readIntake, intakeStatus } from '../intake.js'
import { intakeToStage } from '../goal-io.js'
import { readPack, describeGaps } from '../pack-model.js'

export const plugin = {
	id: 'intake',
	version: '0.1.0',
	tools: ['whale_intake'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_intake',
			description:
				'学情摸底：plan=生成 5 条摸底问题 + 研究建议；record=把学生回答落盘（point+level 必填）；'
				+ 'read=读取已有摸底记录与缺口。落盘路径：<packRoot>/learning-records/intake.jsonl。',
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', enum: ['plan', 'record', 'read'], default: 'plan', description: '操作类型' },
					point: { type: 'string', description: '知识点 id（如 vue、spring-boot）' },
					topic: { type: 'string', description: '知识点中文名（可选，没有就用 point）' },
					level: { type: 'string', description: '学生自评水平（record 时必填）' },
					background: { type: 'string', description: '学习背景' },
					goal: { type: 'string', description: '学完想达到什么水平' },
					time: { type: 'string', description: '每周能投入多少时间' },
					unknowns: { type: 'string', description: '已知的盲区 / 疑问' },
					prior: { type: 'string', description: '摸底第 1 问的回答原文（以前用过 / 看过什么）' },
					can: { type: 'string', description: '摸底第 2 问的回答原文（现在能独立写出什么、写到哪一步会卡）' },
					stuck: { type: 'string', description: '摸底第 3 问的回答原文（卡在哪一步最痛；痛点 = 教学重点）' },
					startTier: {
						type: 'number',
						description: '起点台阶档位 1..4（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）—— 由你按摸底判定，不是学生自报（Q11）；不给 = null（未结构化）',
					},
					answers: {
						type: 'array',
						items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] },
						description: '问答记录 [{q, a}]',
					},
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					const lines = []
					if (v.op === 'plan') {
						lines.push(`📋 ${v.topic} — 学情摸底问题（${v.questions.length} 条）`)
						// 前置没学完就摆在最前面：这是硬闸，不是补充说明
						if (v.prereq && v.prereq.ok === false) {
							lines.push(`🚧 前置没学完：${v.prereq.why}`)
							lines.push('   先去学上面列出的课；前置补齐之前不会给你生成新课。')
							lines.push('')
						}
						for (let i = 0; i < v.questions.length; i++) {
							const q = v.questions[i]
							lines.push(`${i + 1}. [${q.id}] ${q.q}`)
							lines.push(`   💡 ${q.why}`)
						}
						lines.push('')
						lines.push('🔍 研究建议：')
						for (const r of v.research) lines.push(`· ${r}`)
					} else if (v.op === 'record') {
						lines.push(`✅ 已落盘：${v.entry.point}（${v.entry.level || '未填 level'}）→ ${v.file}`)
						lines.push(`   状态：${v.status.done ? '完整' : '缺 ' + v.status.missing.join('、')}`)
					} else if (v.op === 'read') {
						const pts = Object.keys(v.points || {})
						lines.push(`📚 摸底记录：${pts.length} 个知识点`)
						for (const p of pts) {
							const e = v.points[p]
							lines.push(`· ${p}：${e.level || '未填 level'}${e.goal ? ' → ' + e.goal : ''}`)
							// ③(b) 起点台阶（有才印）：`起点台阶：tier N · 卡点：<stuck>`
							if (e.start) {
								const tier = e.start.tier
								const stuck = (e.start.focus || []).join('、')
								lines.push(`   起点台阶：${tier === null ? '未定档' : 'tier ' + tier}${stuck ? ' · 卡点：' + stuck : ''}`)
							}
						}
						if (v.gaps?.length) {
							lines.push(`⚠️ 缺口：${v.gaps.join('、')}`)
						}
					}
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const op = args.op || 'plan'
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }

				if (op === 'plan') {
					const point = args.point
					const topic = args.topic
					if (!point && !topic) return { ok: false, error: 'op=plan 至少需要 point 或 topic' }
					// 前置体检（2026-09-23 用户裁定）：摸底的第一步就是确认前置学没学过。
					// 课程包读不动就不传 pack —— buildQuestions 会退回原来那 5 条，不猜。
					let pack = null
					const root = args.root || hctx.paths.packRoot
					if (root && point) {
						try { pack = readPack(path.resolve(root)) } catch { pack = null }
					}
					const result = buildQuestions({ point, topic, pack })
					const prereq = result.gaps ? { ...result.gaps, why: describeGaps(result.gaps) } : null
					return {
						ok: true, op: 'plan', point: point || topic, topic: result.topic,
						questions: result.questions, research: result.research,
						...(prereq ? { prereq } : {}),
					}
				}

				if (op === 'record') {
					if (!args.point) return { ok: false, error: 'op=record 需要 point' }
					if (!args.level) return { ok: false, error: 'op=record 需要 level' }
					const entry = {
						point: args.point,
						level: args.level,
						at: new Date().toISOString().slice(0, 10),
					}
					if (args.topic) entry.topic = args.topic
					if (args.background) entry.background = args.background
					if (args.goal) entry.goal = args.goal
					if (args.time) entry.time = args.time
					if (args.unknowns) entry.unknowns = args.unknowns
					// ③(b)：摸底三问原文 + 起点台阶（与 ② 共用 StageSpec / validateStage）
					if (args.prior) entry.prior = args.prior
					if (args.can) entry.can = args.can
					if (args.stuck) entry.stuck = args.stuck
					let start = null
					try {
						// 表单/工具面可能是字符串数字，先归一成数值；坏值原样交给 intakeToStage 报错（拒写）
						const rawTier = args.startTier
						const startTier = typeof rawTier === 'string' && /^[1-4]$/.test(rawTier.trim()) ? Number(rawTier.trim()) : rawTier
						start = intakeToStage({ level: args.level, prior: args.prior, can: args.can, stuck: args.stuck, startTier })
					} catch (e) {
						return { ok: false, error: `起点台阶没写成（拒写整条记录）：${e.message}` }
					}
					// 四者（prior/can/stuck/startTier）都缺 → intakeToStage 返回 null → 不写 start（B6 回落）
					if (start) entry.start = start
					if (args.answers?.length) entry.answers = args.answers
					const res = recordIntake(root, entry)
					if (!res.ok) return { ok: false, error: res.error }
					const status = intakeStatus(root, args.point)
					return { ok: true, op: 'record', file: res.file, entry: res.entry, status }
				}

				if (op === 'read') {
					const { latest, problems } = readIntake(root)
					return { ok: true, op: 'read', points: latest, gaps: problems }
				}

				return { ok: false, error: `未知 op: ${op}` }
			},
		})
	},
}
