/**
 * lib/mods/catalog.js — 只读数据面：课程包目录
 * ------------------------------------------------------------------
 * 挂一条只读路由：
 *
 *     GET /api/whale/catalog  →  圆圈/知识点/课程的规范 id + 下一课号 + 圆圈建议
 *
 * 只读：不写盘、不改配置。
 * 跨站栅栏与浏览器认证由基座继承（路径挂在 /api 下），本模块不写 CORS。
 */

import path from 'node:path'
import { readPack, nextNumber } from '../pack-model.js'
import { suggestCircle } from '../circle-seeds.js'

const ROUTE_PATH = '/api/whale/catalog'

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

export const plugin = {
	id: 'catalog',
	version: '0.1.0',
	tools: [],

	install(hctx) {
		const route = {
			path: ROUTE_PATH,
			methods: ['GET'],
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'GET') return json(405, { ok: false, error: '只接受 GET' })

				const root = hctx.paths.packRoot
				if (!root) {
					return json(200, {
						ok: false,
						configured: false,
						error: '未配置 packRoot —— 请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加 `- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。',
					})
				}

				const abs = path.resolve(root)

				let pack
				try {
					pack = readPack(abs)
				} catch (e) {
					return json(200, { ok: false, configured: true, error: `读课程包失败：${e?.message ?? e}` })
				}

				// 课号只从 pack.lessons 算（与下面列出来的那批课同源）
				// canCreate = true → 前端才会露出「新建圆圈 / 新建知识点」按钮；
				// 后端 create 模块**必须已装载**（同一个 host 进程重启后才生效）。
				const circles = pack.circles.map((c) => ({
					id: c.id,
					name: c.name,
					// nextFileBase：该圆圈现有知识点 fileBase 的最大值 + 1000；圆圈里还没有知识点 → 0
					nextFileBase: c.points.length > 0
						? Math.max(...c.points.map((p) => p.fileBase || 0)) + 1000
						: 0,
					points: c.points.map((pt) => {
						const ptId = `${c.id}/${pt.id}`
						const nn = nextNumber(pack, c.id, pt.id)
						const lessons = pack.lessons
							.filter((l) => l.circle === c.id && l.point === pt.id)
							.map((l) => ({
								id: `${c.id}/${l.point}/${String(l.number).padStart(4, '0')}`,
								number: l.number,
								title: l.title,
								page: l.page || null,
							}))
						return {
							id: ptId,
							name: pt.name,
							label: pt.label || '',
							fileBase: pt.fileBase,
							nextNumber: nn,
							lessons,
						}
					}),
				}))

				// 查询串 ?topic=... → suggest
				let suggest = null
				try {
					const url = new URL(request.url)
					const topic = url.searchParams.get('topic')
					if (topic) suggest = suggestCircle(topic, pack.circles)
				} catch { /* ignore */ }

				return json(200, { ok: true, configured: true, packRoot: abs, canCreate: true, circles, suggest })
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
					hctx.log?.info?.(`目录路由已挂 ${ROUTE_PATH}（只读）`)
				} catch (e) {
					hctx.log?.error?.(`挂 ${ROUTE_PATH} 失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：目录路由未注册')
		}
	},
}
