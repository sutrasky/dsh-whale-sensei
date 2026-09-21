/**
 * lib/mods/create.js — 写入口：新建知识圆圈 / 新知识点 / 圆圈改名
 * ------------------------------------------------------------------
 * 挂三条 POST 路由：
 *
 *     POST /api/whale/circle         →  新建圆圈（halo.json）
 *     POST /api/whale/point          →  新建知识点（point.json）
 *     POST /api/whale/circle/rename  →  圆圈改名（外科式替换 halo.json 的 name）
 *
 * 规矩从紧：原子写、拒覆盖、三道闸（packRoot / name / id 合法）。
 * 读不到包一律拒绝，不猜 fileBase。
 * 跨站栅栏与浏览器认证由基座继承（路径挂在 /api 下），本模块不写 CORS。
 */

import fs from 'node:fs'
import path from 'node:path'
import { readPack } from '../pack-model.js'

const CIRCLE_ROUTE = '/api/whale/circle'
const POINT_ROUTE = '/api/whale/point'
const CIRCLE_RENAME_ROUTE = '/api/whale/circle/rename'
const ID_RE = /^[a-z][a-z0-9-]*$/

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

const needsRebuild = [
	'node tools/build-lessons.js',
	'node tools/build-starmap.js',
	'node assets/build-glossary.js',
	'node tools/build-notes.js',
]

function validateId(id) {
	if (!id || !ID_RE.test(id)) return `id 不合法：${JSON.stringify(id)} —— 必须匹配 /^[a-z][a-z0-9-]*$/`
	return null
}

/**
 * 原子写：先写 .tmp 再 rename；失败时清理临时文件。
 * @param {string} target 最终路径
 * @param {string} content 文件内容
 * @returns {{ok: boolean, error?: string}}
 */
function atomicWrite(target, content) {
	const tmp = target + '.tmp-' + process.pid
	try {
		fs.writeFileSync(tmp, content, 'utf8')
		fs.renameSync(tmp, target)
		return { ok: true }
	} catch (e) {
		// 清理临时文件
		try { fs.unlinkSync(tmp) } catch { /* best effort */ }
		return { ok: false, error: `写文件失败：${e?.message ?? e}` }
	}
}

/**
 * 圆圈改名：POST /api/whale/circle/rename
 * 外科式替换 halo.json 里的 "name" 值，其余逐字节保留。
 * 匹配数 ≠ 1 就拒绝（不许盲写、不许 JSON.parse 后整份重排）。
 */
async function handleCircleRename(request, hctx) {
	const root = hctx.paths.packRoot
	if (!root) {
		return json(200, {
			ok: false,
			configured: false,
			error: '未配置 packRoot —— 请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加 `- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。',
		})
	}

	let body
	try { body = await request.json() } catch { return json(400, { ok: false, error: 'body 不是合法 JSON' }) }

	const { id, name } = body || {}
	const idErr = validateId(id)
	if (idErr) return json(200, { ok: false, error: idErr })
	if (!name || !String(name).trim()) return json(200, { ok: false, error: 'name 不能为空' })

	const abs = path.resolve(root)
	const haloPath = path.join(abs, 'lessons', id, 'halo.json')

	// 目标不存在 → 拒绝（不是"顺便新建"）
	if (!fs.existsSync(haloPath)) {
		return json(200, { ok: false, error: `圆圈 "${id}" 不存在（找不到 ${haloPath}），无法改名` })
	}

	// 读原始文件
	let original
	try {
		original = fs.readFileSync(haloPath, 'utf8')
	} catch (e) {
		return json(200, { ok: false, error: `读 halo.json 失败：${e?.message ?? e}` })
	}

	// 外科式替换：只替换顶层 "name" 的值，其余逐字节保留
	// 匹配数 ≠ 1 就拒绝（不许盲写）
	const nameRegex = /^(\s*"name"\s*:\s*)"(?:[^"\\]|\\.)*"/gm
	const matches = [...original.matchAll(nameRegex)]
	if (matches.length !== 1) {
		return json(200, { ok: false, error: `halo.json 里 "name" 字段匹配数 = ${matches.length}（期望 1）—— 拒绝写入，避免误伤` })
	}

	const newName = String(name).trim()
	const match = matches[0]
	const before = original.slice(0, match.index)
	const replacement = match[1] + JSON.stringify(newName)
	const after = original.slice(match.index + match[0].length)
	const updated = before + replacement + after

	// 原子写
	const result = atomicWrite(haloPath, updated)
	if (!result.ok) {
		return json(200, { ok: false, error: result.error })
	}

	return json(200, { ok: true, id, name: newName, path: `lessons/${id}/halo.json` })
}

export const plugin = {
	id: 'create',
	version: '0.1.0',
	tools: [],

	install(hctx) {
		const circleRoute = {
			path: CIRCLE_ROUTE,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })

				const root = hctx.paths.packRoot
				if (!root) {
					return json(200, {
						ok: false,
						configured: false,
						error: '未配置 packRoot —— 请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加 `- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。',
					})
				}

				let body
				try { body = await request.json() } catch { return json(400, { ok: false, error: 'body 不是合法 JSON' }) }

				const { name, id } = body || {}
				if (!name || !String(name).trim()) return json(200, { ok: false, error: 'name 不能为空' })
				const idErr = validateId(id)
				if (idErr) return json(200, { ok: false, error: idErr })

				const abs = path.resolve(root)
				const circleDir = path.join(abs, 'lessons', id)

				// 拒覆盖：目录已存在
				if (fs.existsSync(circleDir)) {
					return json(200, { ok: false, error: `圆圈 ${id} 已存在（目录 ${circleDir}），拒绝覆盖` })
				}

				// 撞已有圆圈（id 虽然目录不存在，但 readPack 里可能有同名）
				let pack
				try {
					pack = readPack(abs)
				} catch (e) {
					return json(200, { ok: false, error: `读不到课程包（${e?.message ?? e}），无法确定 id 占用，拒绝写入` })
				}
				if (pack.circles.some((c) => c.id === id)) {
					return json(200, { ok: false, error: `圆圈 id "${id}" 已被占用` })
				}

				// 原子写 halo.json
				const haloData = {
					_: '…待补…',
					halo: id,
					name: String(name).trim(),
				}
				const haloContent = JSON.stringify(haloData, null, 2) + '\n'
				const haloPath = path.join(circleDir, 'halo.json')

				// 先建目录
				try {
					fs.mkdirSync(circleDir, { recursive: true })
				} catch (e) {
					return json(200, { ok: false, error: `建目录失败：${e?.message ?? e}` })
				}

				const result = atomicWrite(haloPath, haloContent)
				if (!result.ok) {
					// 清理空目录
					try { fs.rmdirSync(circleDir) } catch { /* best effort */ }
					return json(200, { ok: false, error: result.error })
				}

				return json(200, {
					ok: true,
					id,
					path: `lessons/${id}/halo.json`,
					needsRebuild,
					warn: `圆圈 "${name}" 已建，但还没写教学目标 / 圈内 / 圈外（待补）`,
				})
			},
		}

		const pointRoute = {
			path: POINT_ROUTE,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })

				const root = hctx.paths.packRoot
				if (!root) {
					return json(200, {
						ok: false,
						configured: false,
						error: '未配置 packRoot —— 请在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里加 `- id: whale-sensei` + `config: { packRoot: … }`，重启宿主后生效。',
					})
				}

				let body
				try { body = await request.json() } catch { return json(400, { ok: false, error: 'body 不是合法 JSON' }) }

				const { circle, name, id } = body || {}
				if (!name || !String(name).trim()) return json(200, { ok: false, error: 'name 不能为空' })
				const idErr = validateId(circle)
				if (idErr) return json(200, { ok: false, error: `circle ${idErr}` })
				const ptIdErr = validateId(id)
				if (ptIdErr) return json(200, { ok: false, error: `point ${ptIdErr}` })

				const abs = path.resolve(root)
				const circleDir = path.join(abs, 'lessons', circle)
				const haloPath = path.join(circleDir, 'halo.json')

				// 检查圆圈是否存在（必须有 halo.json）
				if (!fs.existsSync(haloPath)) {
					return json(200, { ok: false, error: `圆圈 "${circle}" 不存在（找不到 ${haloPath}）—— 请先建圆圈` })
				}

				const pointDir = path.join(circleDir, id)
				const pointPath = path.join(pointDir, 'point.json')

				// 拒覆盖：目录或文件已存在
				if (fs.existsSync(pointDir)) {
					return json(200, { ok: false, error: `知识点 ${circle}/${id} 已存在（目录 ${pointDir}），拒绝覆盖` })
				}

				// 计算 fileBase：该圆圈现有知识点的最大 fileBase + 1000；没有知识点 → 0
				let pack
				try {
					pack = readPack(abs)
				} catch (e) {
					return json(200, { ok: false, error: `读不到课程包（${e?.message ?? e}），无法确定课号段，拒绝写入` })
				}
				const circlePoints = pack.points.filter((p) => p.circle === circle)
				let fileBase = 0
				if (circlePoints.length > 0) {
					fileBase = Math.max(...circlePoints.map((p) => p.fileBase || 0)) + 1000
				}

				// 原子写 point.json
				const pointData = {
					_: '…待补…',
					point: id,
					name: String(name).trim(),
					fileBase,
				}
				const pointContent = JSON.stringify(pointData, null, 2) + '\n'

				// 先建目录
				try {
					fs.mkdirSync(pointDir, { recursive: true })
				} catch (e) {
					return json(200, { ok: false, error: `建目录失败：${e?.message ?? e}` })
				}

				const result = atomicWrite(pointPath, pointContent)
				if (!result.ok) {
					// 清理空目录
					try { fs.rmdirSync(pointDir) } catch { /* best effort */ }
					return json(200, { ok: false, error: result.error })
				}

				return json(200, {
					ok: true,
					id: `${circle}/${id}`,
					path: `lessons/${circle}/${id}/point.json`,
					needsRebuild,
					warn: null,
				})
			},
		}

		const renameRoute = {
			path: CIRCLE_RENAME_ROUTE,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
				return await handleCircleRename(request, hctx)
			},
		}

		if (typeof hctx.inject === 'function') {
			hctx.inject(['connection'], (c) => {
				const conn = c.get('connection')
				if (!conn?.fetch?.register) {
					hctx.log?.warn?.(`connection 服务没有 fetch.register —— ${CIRCLE_ROUTE} / ${POINT_ROUTE} / ${CIRCLE_RENAME_ROUTE} 没挂上`)
					return
				}
				try {
					conn.fetch.register(circleRoute)
					conn.fetch.register(pointRoute)
					conn.fetch.register(renameRoute)
					hctx.log?.info?.(`写入口路由已挂 ${CIRCLE_ROUTE} + ${POINT_ROUTE} + ${CIRCLE_RENAME_ROUTE}`)
				} catch (e) {
					hctx.log?.error?.(`挂写入口路由失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：写入口路由未注册')
		}
	},
}
