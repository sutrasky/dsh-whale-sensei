/**
 * lib/mods/intake.js — 能力模块：学情摸底（`whale_intake`）
 * ------------------------------------------------------------------
 * 工具 `whale_intake`：规划摸底问题、记录学生回答、读取摸底状态。
 * 与 `whale_author` 同形状：五字段齐全（name / description / parameters / output / execute）。
 */

import path from 'node:path'
import { buildQuestions, recordIntake, readIntake, intakeStatus } from '../intake.js'

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
					const result = buildQuestions({ point, topic })
					return { ok: true, op: 'plan', point: point || topic, topic: result.topic, questions: result.questions, research: result.research }
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
