/**
 * lib/mods/lessonpack.js — 能力模块：读课程包的三层结构
 * ------------------------------------------------------------------
 * 工具 `whale_lessonpack`：把这个课程包读成机器可读的三层清单
 * （知识圆圈 → 知识点 → 课程）+ 学过的进度 + 一路上的告警。
 *
 * 它是本地基（地基）：后面的 build / audit / author 都吃它的结构。
 * 读取逻辑在 `lib/pack.js`（普通文件，**模块之间不许互相 import**，所以共享逻辑放那儿）。
 */

import path from 'node:path'
import { readPack, packSummary } from '../pack.js'

export const plugin = {
	id: 'lessonpack',
	version: '0.1.0',
	tools: ['whale_lessonpack'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_lessonpack',
			description:
				'读课程包的三层结构（知识圆圈 / 知识点 / 课程）与学习进度，返回机器可读的清单与告警。'
				+ '只读；根目录取 packRoot 配置（工具入参可临时覆盖）。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					circle: { type: 'string', description: '只返回这个知识圆圈（可选）' },
					point: { type: 'string', description: '只返回这个知识点（可选）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行（现场"糊成一坨"）✗
				render: (_args, value) => [{
					type: 'text',
					text: [
						value?.summary || '（没有内容）',
						...(value?.warnings || []).slice(0, 8).map((w) => `⚠️ ${w}`),
					].join('\n'),
				}],
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) {
					// 不猜路径、不静默退回 cwd —— 直接说清怎么配
					return {
						ok: false,
						error: '没有课程包根目录：请先在插件配置里写 packRoot（或给本工具传 root）',
					}
				}
				const pack = readPack(path.resolve(root))
				let { circles } = pack
				if (args.circle) circles = circles.filter((c) => c.id === args.circle)
				let lessons = pack.lessons
				if (args.point) lessons = lessons.filter((l) => l.point === args.point)
				if (args.circle) lessons = lessons.filter((l) => l.circle === args.circle)
				const view = { ...pack, circles, lessons }
				return {
					ok: pack.warnings.length === 0,
					root: pack.root,
					summary: packSummary(view),
					circles: circles.map((c) => ({
						id: c.id, name: c.name, center: c.center, shape: c.shape,
						points: c.points.map((p) => ({ id: p.id, name: p.name, label: p.label, requires: p.requires })),
					})),
					lessons: lessons.map((l) => ({
						id: l.id, circle: l.circle, point: l.point, number: l.number,
						label: l.label, title: l.title, href: l.href,
						learned: l.learned, termCount: l.termCount, flag: l.flag,
					})),
					learned: pack.learned,
					warnings: pack.warnings,
				}
			},
		})
	},
}
