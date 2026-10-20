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
import { createRequire } from 'node:module'
import { readPack, packSummary } from '../pack.js'
import { resolvePointRef, describePointRef } from '../point-ref.js'

// U16：失败结构取 U03 的唯一实现（本模块不另造码/字段）。
const requireCJS = createRequire(import.meta.url)
const { makeFailure } = requireCJS('../unify/errors.cjs')

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
					point: { type: 'string', description: '只返回这个知识点（可选）：规范 id `programming/spring-boot` 或裸 `spring-boot`（跨圈同名时只给裸 id 会被明确拒绝，不猜）' },
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
				// ⚠️ U16：`point` 只认**唯一实体**（规范 `circle/point`，或有目录可对照时能唯一补全的裸 id）。
				//    以前是 `lessons.filter(l => l.point === args.point)` —— 裸 id 跨圈同名时，
				//    两个圈的同名知识点会被当成一个，把两边的课混在一张清单里返回（错实体，且看不出来）。
				let scope = null
				if (args.point !== undefined && String(args.point).trim() !== '') {
					let ref = null
					try { ref = resolvePointRef({ pack, ref: args.point, halo: args.circle }) } catch { ref = null }
					if (ref && ref.ok === false) {
						const code = ref.code === 'ambiguous' ? 'ID_AMBIGUOUS'
							: (ref.code === 'missing-ref' ? 'ID_REQUIRED' : ref.code)
						const error = `知识点身份认不出来（不猜是哪一个）：${describePointRef(ref)}`
						return {
							ok: false,
							error,
							failure: makeFailure({ kind: 'input', code, error }),
							candidates: ref.candidates,
						}
					}
					scope = ref
				}
				const circleId = scope && scope.circle ? scope.circle : (args.circle ? String(args.circle).trim() : '')
				let { circles } = pack
				if (circleId) circles = circles.filter((c) => c.id === circleId)
				let lessons = pack.lessons
				// 有规范归属就按两段一起筛（跨圈同名不再互相顶替）；没有就保持既有裸点语义。
				if (scope) lessons = lessons.filter((l) => l.point === scope.bare)
				if (circleId) lessons = lessons.filter((l) => l.circle === circleId)
				const view = { ...pack, circles, lessons }
				return {
					ok: pack.warnings.length === 0,
					root: pack.root,
					// 回执里带上**规范身份**（解析得出来才有）：调用方不必再从 `point` 反解圆圈。
					...(scope && scope.ok !== false ? { pointId: scope.key, circleId: scope.circle, bare: scope.bare } : {}),
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
