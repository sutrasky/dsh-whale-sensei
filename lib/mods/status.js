/**
 * lib/mods/status.js — 能力模块：状态节（设置页里那张「鲸师」卡片的数据源）
 * ------------------------------------------------------------------
 * 浏览器半边拿不到 Agent 工具，只能走 HTTP。所以这里挂一条**只读**路由：
 *
 *     GET /api/whale/status  →  { ok, configured, packRoot, pack?, hint }
 *
 * ⚠️ **这条路由在没配 packRoot 时也返回 200**（别的路由是 503）—— 这是刻意的：
 *    它存在的意义就是**把"没配 packRoot"当场显示在设置页上**。
 *    回 503 的话卡片只能显示一个错误，反而看不出该怎么修。
 *
 * 只读：不写盘、不改配置、不启动任何东西。判定用的都是已有的数据层入口。
 * 跨站栅栏与浏览器认证由基座继承（路径挂在 /api 下），本模块不写 CORS。
 */

import path from 'node:path'
import { readPack } from '../pack-model.js'

const ROUTE_PATH = '/api/whale/status'

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 把 pack 摘成一屏够用的几个数（**不**把整个 pack 塞进去：那是无损 JSON 与带宽的双重浪费） */
function packBrief(root) {
	try {
		const pack = readPack(root)
		const lit = pack.lessons.filter((l) => l.learned).length
		return {
			ok: true,
			circles: pack.circles.length,
			points: pack.points.length,
			lessons: pack.lessons.length,
			learned: lit,
			warnings: pack.warnings.slice(0, 5),
			summary: `${pack.circles.length} 个圆圈 · ${pack.points.length} 个知识点 · ${pack.lessons.length} 门课程（已点亮 ${lit}）`,
		}
	} catch (e) {
		return { ok: false, error: e?.message ?? String(e) }
	}
}

export const plugin = {
	id: 'status',
	version: '0.1.0',
	tools: [], // 只提供一条只读路由，不动工具面

	install(hctx) {
		const route = {
			path: ROUTE_PATH,
			methods: ['GET'],
			// ⚠️ **必须显式写**，哪怕只收 GET。基座（`dsh-client-connection/lib/index.js:47,74-80`）这样分流：
			//     `bodyMode === 'buffered'` → 正常缓冲请求体；
			//     否则 → `new Request(url, { method, headers, body: Readable.toWeb(req), duplex: 'half' })`
			//   省略这个字段时，方法匹配取到 `undefined`、**掉进 else**，于是给 GET 装了个 body
			//   ⇒ `Request with GET/HEAD method cannot have body` 抛在基座里 ⇒ 回 **400 空体**
			//   ⇒ 浏览器那侧 `.json()` 报 `Unexpected end of JSON input`（**报错指向 JSON，真因在这里**）。
			//   2026-09-24 现场踩到：设置页那张卡"取不到状态"就是这么来的。
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'GET') return json(405, { ok: false, error: '只接受 GET' })
				const root = hctx.paths.packRoot
				if (!root) {
					return json(200, {
						ok: true,
						configured: false,
						packRoot: null,
						hint: '未配置 packRoot —— 所有 /api/whale/* 会返回 503。'
							+ '请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加一段 '
							+ '`- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。详见 README「装」那节。',
					})
				}
				const abs = path.resolve(root)
				return json(200, {
					ok: true,
					configured: true,
					packRoot: abs,
					pack: packBrief(abs),
				})
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
					hctx.log?.info?.(`状态路由已挂 ${ROUTE_PATH}（只读；设置页那张卡靠它）`)
				} catch (e) {
					hctx.log?.error?.(`挂 ${ROUTE_PATH} 失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：状态路由未注册')
		}
	},
}
