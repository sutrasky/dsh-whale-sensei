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
 * ⚠️ **先探身份再起**（T15 / 报告 A03）：用户可能已经手工 `node tools/app-server.js` 开着 3091 了 ——
 *    那时**什么都不做、直接复用**（`app-server.js` 自己遇到端口占用会 exit 1 并说"可能已经开着了"，
 *    所以不能靠"起一次试试"来判）。
 *    ⚠️ 但**"答了 200"不是身份**：原先这里只看 `GET /health` 的 200，于是任何一个占着 3091 的
 *    东西（别的包的服务、上一版留下的老服务、随便一个桩）都会被当成"这个包的服务"复用 ——
 *    地址栏指向 A、页面却是 B。现在只认**同包 + 同协议 + 同引擎**（`/health` 的身份信封：
 *    `protocol=1` / `packId=sha256(realpath(包根))[:16]` / `engineDigest` 与
 *    `lib/engine.js#verifyEngine(root, trustedManifest()).digest` 同一口径），并且**外部服务**
 *    还要能完成**合法会话接续**（`POST /api/session` 拿到带 capability 的 200）才允许复用：
 *      · 端口有响应但身份不符 → `{ok:false, reason:'port-conflict'}`（**绝不**去杀占用者，
 *        也**不**把旧协议猜成新协议）；错误里带 `netstat` 修法。
 *      · 身份相符但拿不到会话 → `{ok:false, reason:'needs-authorization'}`。
 *      · 复用**不接管**：不写进本模块台账、不随本插件卸载关闭（那是别人的服务）。
 * ⚠️ **绝不静默降级**：包里没有 `tools/app-server.js` / require 失败 / 监听失败 →
 *    返回带**修法**的 error，不糊一个"打不开"了事。
 *
 * ⚠️ **执行前先核验受信引擎**（T04 / 报告 D01，判据落在 `test/audit/T04.mjs`）：
 *    `createRequire(包)(包内 app-server.js)` 执行的是**课程包里可写的那份代码** ——
 *    换掉一个字节，宿主下一次预览就跑别人的代码。所以 require **之前**先拿
 *    **插件自己模板**的受信清单核验这个包的引擎闭包（`lib/engine.js`）：
 *    缺件 / 字节不一致 / 空清单 → **零 require** 地拒绝，并把修法（`tools/upgrade-pack.mjs`）写进 error。
 *    ⚠️ 这是**引擎一致性核验**，不是"任意数据沙箱"：学生自己的课 / 笔记 / 代码不在清单里。
 *
 * 同源好处：页面里的提问 / 笔记 POST 会打到 `/api/whale/*`（插件自己的路由 = 真台账），
 * 而不是 3091 那份旧通道 —— 但那是**浏览器**的事，本模块只负责把服务起起来。
 *
 * ⚠️ **授权（T07 / 报告 D02）**：进程内装进宿主的那份 `handler` 也带授权闸 ——
 *    `tools/app-server.js` 的写 / 私人读口要 `X-Whale-Capability`，而令牌只发给**可信来源**：
 *    「本站自己的来源」（由请求的 `Host` 推，且 Host 必须是本机回环）＋ 显式配置的
 *    `WHALE_TRUSTED_ORIGIN`（逗号分隔）。这里**不**替它放宽任何东西：宿主不假装自己是
 *    可信来源 —— 课程页与它同源，页面自己会去 `POST /api/session` 换 `reader` 令牌。
 *    管理能力（`admin` 作用域）**不在这个服务上**：它只住在 `tools/offline-server.js`。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { trustedManifest, verifyEngine, engineVerdict, buildManifest, digestOfManifest } from './engine.js'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 3091
/** 健康信封的协议版本：**只认 1**（无协议 / 旧协议 = 不是这个包的服务） */
const HEALTH_PROTOCOL = 1

/** 已起的服务：包根 → { server, port }（同一个包只起一次） */
const running = new Map()

/* ── 身份：同包 / 同协议 / 同引擎（T15 / 报告 A03）────────────────────────────
 *
 * 期望值**在宿主这一侧**算（不信端口上那个服务自报的一切）：
 *   · `packId`      = `sha256(realpath(包根)).slice(0,16)` —— **真身路径**，不是 basename
 *     （两台机器上的同名包必须算出不同的身份）
 *   · `engineDigest`= `digestOfManifest(buildManifest(包根).files)` —— 与
 *     `verifyEngine(root, trustedManifest()).digest` **同一口径**（同一份
 *     `tools/engine-policy.cjs`：核验已经过了，所以两边的清单逐字节一致）
 */

/** 包根的**真身**路径（算不出来就回空串：宁可说"没有身份"，也不拿一个猜的值去比） */
function realPathOf(root) {
  try {
    return fs.realpathSync(path.resolve(String(root || '')))
  } catch (e) {
    return ''
  }
}

/** 这个包**应该**有的 packId（空串 = 算不出来） */
function expectedPackId(root) {
  const real = realPathOf(root)
  if (!real) return ''
  return crypto.createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 16)
}

/** 这个包**应该**有的引擎闭包摘要（空串 = 算不出来） */
function expectedEngineDigest(root) {
  try {
    return digestOfManifest(buildManifest(path.resolve(String(root || ''))).files)
  } catch (e) {
    return ''
  }
}

/** 端口上那个东西**为什么**不是这个包的服务（人话，直接进 error） */
function describeMismatch(status, doc, expect) {
  if (!doc || typeof doc !== 'object') return `HTTP ${status}，响应不是 JSON（没有身份信封）`
  if (doc.ok !== true) {
    return `HTTP ${status}，健康响应 ok=${JSON.stringify(doc.ok)}`
      + (doc.identityError ? `（它自己说的：${doc.identityError}）` : '')
  }
  if (doc.protocol !== HEALTH_PROTOCOL) {
    return `协议对不上（它是 ${JSON.stringify(doc.protocol)}，本模块只认 ${HEALTH_PROTOCOL}）`
  }
  if (doc.packId !== expect.packId) {
    return `不是这个包（它的 packId=${JSON.stringify(doc.packId)}，本包是 ${expect.packId}）`
  }
  if (doc.engineDigest !== expect.engineDigest) {
    return `引擎字节不是这一份（它的 engineDigest=${JSON.stringify(doc.engineDigest)}，本包是 ${expect.engineDigest}）`
  }
  return `身份信封对不上（HTTP ${status}）`
}

/**
 * 探**身份**（不是"答没答 200"）：`GET /health` 取 JSON，四个字段全对上才算**同包同协议同引擎**。
 * @param {number} port
 * @param {{packId:string, engineDigest:string}} expect
 * @param {number} [timeoutMs]
 * @returns {Promise<{kind:'match'|'mismatch'|'none', status?:number, why?:string, doc?:object}>}
 *   `none` = 端口上没人应答（走"我们自己起"）；`mismatch` = 有东西在答但身份不符（冲突）
 */
function probeIdentity(port, expect, timeoutMs = 900) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = http.get({ host: HOST, port, path: '/health', timeout: timeoutMs }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => { size += c.length; if (size <= 64 * 1024) chunks.push(c) })
        res.on('end', () => {
          let doc = null
          try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) { doc = null }
          if (doc && typeof doc === 'object' && doc.ok === true
            && doc.protocol === HEALTH_PROTOCOL
            && doc.packId === expect.packId
            && doc.engineDigest === expect.engineDigest) {
            return finish({ kind: 'match', status: res.statusCode, doc })
          }
          finish({ kind: 'mismatch', status: res.statusCode, why: describeMismatch(res.statusCode, doc, expect) })
        })
        res.on('error', () => finish({ kind: 'mismatch', status: res.statusCode, why: '读响应时断了' }))
      })
    } catch (e) {
      finish({ kind: 'none', why: `请求发不出去（${e?.message ?? e}）` })
      return
    }
    req.on('timeout', () => { try { req.destroy() } catch (e) { /* 已断 */ } finish({ kind: 'none', why: '超时没响应' }) })
    req.on('error', (e) => {
      const code = e?.code || ''
      // 连不上 = 端口上没人应答 ⇒ 走"我们自己起"；其它错（对方答了但不是 HTTP 之类）算"有响应但身份不符"
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') {
        return finish({ kind: 'none', why: `${code}（端口上没人应答）` })
      }
      finish({ kind: 'mismatch', why: `响应不是可用的健康信封（${code || e?.message || '读不懂'}）` })
    })
  })
}

/**
 * **合法会话接续**：`POST /api/session`（回环、`Host: 127.0.0.1:<port>`）拿到 200 且带
 * capability / 会话字段 ⇒ 这个外部服务肯按本包的授权模型给我们开一次会话，允许复用。
 * 拿不到（403/401/404/非 JSON/没有令牌）⇒ **不许**复用（`needs-authorization`）。
 * @returns {Promise<{ok:boolean, status?:number, why?:string}>}
 */
function probeSession(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const body = '{}'
    let req
    try {
      req = http.request({
        host: HOST, port, path: '/api/session', method: 'POST', timeout: timeoutMs,
        headers: {
          host: `${HOST}:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let doc = null
          try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) { doc = null }
          const hasCapability = !!doc && typeof doc === 'object' && doc.ok === true
            && typeof doc.token === 'string' && doc.token.length > 0
            && typeof doc.header === 'string' && doc.header.length > 0
          if (res.statusCode === 200 && hasCapability) return finish({ ok: true, status: 200 })
          const why = !doc || typeof doc !== 'object'
            ? '响应不是 JSON'
            : doc.ok === true
              ? '响应里没有 capability / 会话字段'
              : `${doc.code || 'ok:false'}${doc.error ? `：${doc.error}` : ''}`
          finish({ ok: false, status: res.statusCode, why: `HTTP ${res.statusCode}（${why}）` })
        })
        res.on('error', () => finish({ ok: false, why: '读响应时断了' }))
      })
    } catch (e) {
      finish({ ok: false, why: `请求发不出去（${e?.message ?? e}）` })
      return
    }
    req.on('timeout', () => { try { req.destroy() } catch (e) { /* 已断 */ } finish({ ok: false, why: '超时没响应' }) })
    req.on('error', (e) => finish({ ok: false, why: `连不上（${e?.code || e?.message || '错误'}）` }))
    req.end(body)
  })
}

/** 端口被**别人的**东西占着：如实回冲突（netstat 修法；**绝不**去杀占用者） */
function conflictError(port, why) {
  return {
    ok: false,
    reason: 'port-conflict',
    error: `${HOST}:${port} 上已经有东西在答，但它**不是这个课程包的服务**（${why}）—— `
      + `不是同一个包、不是同一个协议、或者引擎字节不是这一份。`
      + `修法：① 换一个端口再开；② 或看看这个端口被谁占着（netstat -ano | findstr :${port}），把它关掉再重试。`
      + `本模块**不会**去杀占用端口的进程。`,
  }
}

/**
 * 复用**外部**（不是本进程起的）服务：身份已经对上了，还差一次合法会话接续。
 * 「复用但不接管」：不写进本模块台账、不随本插件卸载关闭。
 */
async function reuseExternal(port) {
  const sess = await probeSession(port)
  if (sess.ok) return { ok: true, url: packServerUrl(port), port, started: false }
  return {
    ok: false,
    reason: 'needs-authorization',
    error: `${HOST}:${port} 上的服务身份是**这个包**的，但拿不到合法会话（POST /api/session → ${sess.why}）—— `
      + `复用别人的服务必须先能按本包的授权模型开一次会话。`
      + `修法：① 把它关掉再让宿主自己起一份；② 或看看这个端口是谁（netstat -ano | findstr :${port}）。`,
  }
}

/** 星图的地址（给界面用）。`/starmap/` 是 `app-server.js` 自己启动时打的那条。 */
export function packServerUrl(port = DEFAULT_PORT) {
  return `http://${HOST}:${port}/starmap/`
}

/**
 * 确保课程包的预览服务在跑。
 *
 * @param {string} root 课程包根
 * @param {{port?:number, scope?:object}} [opts]
 *   `port` 显式给出时**优先于**包内 `tools/app-server.js` 的 `PORT`（不传就沿用那个值）。
 *   `scope` 插件资源作用域（T13）：退出后不再起服务，起了的随作用域回收。
 * @returns {Promise<{ok: boolean, url?: string, port?: number, started?: boolean,
 *                    reason?: 'port-conflict'|'needs-authorization', error?: string}>}
 *   `started` = 这次**真的起了**（false = 复用了一个已经在跑的）
 *   `reason` 只在两类失败上给：端口被**别的东西**占着（`port-conflict`）、
 *   身份对上了但拿不到合法会话（`needs-authorization`）。
 */
export async function ensurePackServer(root, { port: wantedPort, scope } = {}) {
  if (scope?.disposed) return { ok: false, error: '插件资源作用域已退出，不能启动预览服务' }
  const abs = path.resolve(String(root || ''))
  if (!root) return { ok: false, error: '还没配课程包目录 —— 先在设置里选一个课程包' }

  // 显式端口：只认 1..65535 的整数（别的值当"没给"——不拿一个坏值去 listen）
  const want = Number.isInteger(wantedPort) && wantedPort > 0 && wantedPort < 65536 ? wantedPort : null

  // 同一个包**且端口一致**、服务还在 listening → 复用**自己起的**那一个（仍归原 owner）
  const known = running.get(abs)
  if (known && known.server.listening && (want === null || known.port === want)) {
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

  // ── 执行前核验受信引擎（T04 / D01）：**不通过就零 require 地拒绝** ──────────────
  //    为什么放在这里（`existsSync` 之后、`createRequire` 之前）：这一句下面就是
  //    「把包里的代码 require 进宿主进程」。核验必须在它**前面**，否则代码已经跑过了。
  let verdict
  try {
    verdict = verifyEngine(abs, trustedManifest())
  } catch (e) {
    return {
      ok: false,
      error: `核验这个课程包的引擎时出错（${e?.message ?? e}）—— 拒绝执行包里的代码（宁可打不开，也不跑没核验过的代码）。`,
    }
  }
  if (!verdict.ok) {
    return {
      ok: false,
      engine: { ok: false, digest: verdict.digest, missing: verdict.missing, mismatched: verdict.mismatched },
      error: `${engineVerdict(verdict, '这个包的引擎')} —— 拒绝执行包里的预览服务。`
        + `修法：① 用插件模板显式升级这个包的引擎（node tools/upgrade-pack.mjs --root=<包根> --plan，再 --apply --confirm --plan-digest=<digest>）；`
        + `② 或用「选课程包」重新选一个完整的包。`,
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
  const port = want ?? (Number(mod?.PORT) || DEFAULT_PORT)
  if (typeof mod?.handler !== 'function') {
    return {
      ok: false,
      error: 'tools/app-server.js 没有导出 handler（它的契约是 module.exports = { handler, health, API_PATHS, PORT }）—— '
        + '这个包的服务版本太旧，拷一份新的 tools/ 过来',
    }
  }

  // 本模块**已经**把这个包起在另一个端口上了：不悄悄再起第二个（那会留下没人管的监听）
  if (known && known.server.listening && known.port !== port) {
    return {
      ok: false,
      error: `这个课程包已经由本模块起在 ${HOST}:${known.port} 上了，这次却要求在 ${HOST}:${port} 上再起一个 —— `
        + '一个包同时起两个端口会留下没人管的监听。修法：先 closePackServers() 关掉它，再用新端口起。',
    }
  }

  // ── 探**身份**（T15 / A03）：只看 200 会把别人的服务当成自己的 ────────────────
  const expect = { packId: expectedPackId(abs), engineDigest: expectedEngineDigest(abs) }
  if (!expect.packId || !expect.engineDigest) {
    return {
      ok: false,
      error: `算不出这个课程包的身份（packId=${JSON.stringify(expect.packId)} / engineDigest=${JSON.stringify(expect.engineDigest)}）—— `
        + '没有身份就不能判断端口上那个服务是不是这个包的。修法：用插件模板升级这个包的引擎（node tools/upgrade-pack.mjs --root=<包根>）。',
    }
  }
  const seen = await probeIdentity(port, expect)
  // 身份相符但**不是本进程记录的**（外部服务，可能是用户手工起的）→ 必须完成合法会话接续才复用
  if (seen.kind === 'match') return await reuseExternal(port)
  if (seen.kind === 'mismatch') return conflictError(port, seen.why)

  if (scope?.disposed) return { ok: false, error: '插件资源作用域已退出，不能启动预览服务' }
  const server = http.createServer(mod.handler)
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const record = { server, port, scope, close: null }
  let closing
  record.close = () => {
    if (closing) return closing
    if (running.get(abs) === record) running.delete(abs)
    closing = new Promise((resolve, reject) => {
      server.close(e => e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve())
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections?.()
    })
    return closing
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, HOST, resolve)
    })
  } catch (e) {
    try { server.close() } catch (e2) { /* 没起来 */ }
    // 竞态：刚好有人抢先起了 → 再探一次**身份**（**不是**再探一次裸 200）
    const again = await probeIdentity(port, expect)
    if (again.kind === 'match') return await reuseExternal(port)
    if (again.kind === 'mismatch') return conflictError(port, again.why)
    return {
      ok: false,
      error: `预览服务起不来（${HOST}:${port} —— ${e?.message ?? e}）。`
        + `修法：看看这个端口被谁占了（netstat -ano | findstr :${port}），或手工起一次 node tools/app-server.js 看它报什么`,
    }
  }
  running.set(abs, record)
  scope?.add(record.close)
  if (scope?.disposed) {
    await record.close()
    return { ok: false, error: '插件资源作用域已退出，预览服务已关闭' }
  }
  return { ok: true, url: packServerUrl(port), port, started: true }
}

/** 关掉本模块起的全部服务（宿主卸载 / 测试清理用）；返回被关掉的包根清单 */
export function closePackServers(owner) {
  const closed = []
  for (const [root, v] of running) {
    if (owner !== undefined && v.scope !== owner) continue
    v.close().catch(e => console.error(`关闭预览服务失败：${e?.message ?? e}`))
    closed.push(root)
  }
  return closed
}

/** 当前有几个服务是本模块起的（只读，给判据用） */
export function runningPackServers() {
  return [...running.keys()]
}
