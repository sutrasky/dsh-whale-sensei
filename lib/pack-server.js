/**
 * lib/pack-server.js — 把**课程包自己的**预览服务在**宿主进程内**起起来（场景 A：「进入课程包」）
 * ------------------------------------------------------------------
 * 为什么走这条路（2026-09-25 主人定「保留网页版 + 自制快捷方式」）：
 *   · 「星图是课程包的入口」需要一个**点得进去的 URL**；而 `file://` 走不通 ——
 *     `starmap/index.html:350-353` 用 `s.type = 'module'` 加载 `main.js`，模块脚本在 `origin = null`
 *     下被浏览器按 CORS 拦死（双击只得到**没有渲染器的空底图**）。
 *   · 插件现在用的 `connection.fetch.register` **只支持 `/api` 下的精确路径**
 *     （类型原文：`Absolute path below /api` + `Host registry for **exact** Fetch routes`）
 *     ⇒ **挂不了整棵**（星图页引 `../assets/theme.css`、`./content.js`、`../lessons/…`，只挂单文件相对资源全断）。
 *   · 宿主底层的 `WebServer.register({ kind: 'prefix' })` **能**挂整棵，但它**不经过**
 *     `connection.fetch` 的信任 / 认证策略，而 `/api/whale/*` 是带认证的（实测 `GET /api/whale/gate` → 401）
 *     ⇒ 走那条等于**往宿主上新开一个无认证的本机可读出口**。**不做。**
 *   ⇒ 所以复用**课程包自己的服务**（`tools/app-server.js`）：它本来就是为服务这个包写的，
 *     而且明确留了「被宿主驱动」的缝 —— `:128 if (require.main === module)` 才 `listen`，
 *     `:147 module.exports = { handler, health, API_PATHS, PORT }`。
 *
 * **不带 Node、不起子进程**：宿主自己就跑在 Node 里。**进程内**起的好处是随宿主一起生灭
 * （不留孤儿进程），且**不新增任何 HTTP 面**（不碰认证模型）。
 *
 * ⚠️ **先探活再起**：用户可能已经手工 `node tools/app-server.js` 开着 3091 了 ——
 *    那时**什么都不做、直接复用**（`app-server.js` 自己遇到端口占用会 exit 1 并说"可能已经开着了"，
 *    所以不能靠"起一次试试"来判）。
 * ⚠️ **绝不静默降级**：包里没有 `tools/app-server.js` / require 失败 / 监听失败 →
 *    返回带**修法**的 error，不糊一个"打不开"了事。
 *
 * 同源好处：页面里的提问 / 笔记 POST 会打到 `/api/whale/*`（插件自己的路由 = 真台账），
 * 而不是 3091 那份旧通道 —— 但那是**浏览器**的事，本模块只负责把服务起起来。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 3091

/** 已起的服务：包根 → { server, port }（同一个包只起一次） */
const running = new Map()

/**
 * 探活：`GET /health` 有 200 就算在跑（`app-server.js` 自己提供这条路由）。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probe(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = http.get({ host: HOST, port, path: '/health', timeout: timeoutMs }, (res) => {
        res.resume()
        finish(res.statusCode === 200)
      })
    } catch (e) {
      finish(false)
      return
    }
    req.on('timeout', () => { try { req.destroy() } catch (e) { /* 已断 */ } finish(false) })
    req.on('error', () => finish(false))
  })
}

/** 星图的地址（给界面用）。`/starmap/` 是 `app-server.js` 自己启动时打的那条。 */
export function packServerUrl(port = DEFAULT_PORT) {
  return `http://${HOST}:${port}/starmap/`
}

/**
 * 确保课程包的预览服务在跑。
 *
 * @param {string} root 课程包根
 * @returns {Promise<{ok: boolean, url?: string, port?: number, started?: boolean, error?: string}>}
 *   `started` = 这次**真的起了**（false = 复用了一个已经在跑的）
 */
export async function ensurePackServer(root) {
  const abs = path.resolve(String(root || ''))
  if (!root) return { ok: false, error: '还没配课程包目录 —— 先在设置里选一个课程包' }

  const known = running.get(abs)
  if (known && known.server.listening) {
    return { ok: true, url: packServerUrl(known.port), port: known.port, started: false }
  }

  const entry = path.join(abs, 'tools', 'app-server.js')
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      error: '这个课程包里没有 tools/app-server.js（预览服务）—— 打不开星图。'
        + '修法：① 从新建的课程包拷一份 tools/ 过来；② 或用「选课程包」重新选一个完整的包。',
    }
  }

  let mod
  try {
    mod = createRequire(import.meta.url)(entry)
  } catch (e) {
    return {
      ok: false,
      error: `课程包的预览服务加载失败（${e?.message ?? e}）—— `
        + 'tools/app-server.js 可能不完整，或它依赖的 tools/*.js 缺件（它 require 了 ask-server / lesson-map / pack-text / fingerprint）',
    }
  }
  const port = Number(mod?.PORT) || DEFAULT_PORT
  if (typeof mod?.handler !== 'function') {
    return {
      ok: false,
      error: 'tools/app-server.js 没有导出 handler（它的契约是 module.exports = { handler, health, API_PATHS, PORT }）—— '
        + '这个包的服务版本太旧，拷一份新的 tools/ 过来',
    }
  }

  // 先探活：已经开着了就复用（可能是用户手工起的，也可能是上一次宿主留下的）
  if (await probe(port)) return { ok: true, url: packServerUrl(port), port, started: false }

  const server = http.createServer(mod.handler)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, HOST, resolve)
    })
  } catch (e) {
    try { server.close() } catch (e2) { /* 没起来 */ }
    // 竞态：刚好有人抢先起了 → 再探一次；还不行就如实报（不糊）
    if (await probe(port)) return { ok: true, url: packServerUrl(port), port, started: false }
    return {
      ok: false,
      error: `预览服务起不来（${HOST}:${port} —— ${e?.message ?? e}）。`
        + `修法：看看这个端口被谁占了（netstat -ano | findstr :${port}），或手工起一次 node tools/app-server.js 看它报什么`,
    }
  }
  running.set(abs, { server, port })
  return { ok: true, url: packServerUrl(port), port, started: true }
}

/** 关掉本模块起的全部服务（宿主卸载 / 测试清理用）；返回被关掉的包根清单 */
export function closePackServers() {
  const closed = []
  for (const [root, v] of running) {
    try { v.server.close() } catch (e) { /* 已经关了 */ }
    closed.push(root)
  }
  running.clear()
  return closed
}

/** 当前有几个服务是本模块起的（只读，给判据用） */
export function runningPackServers() {
  return [...running.keys()]
}
