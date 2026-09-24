/**
 * test/pack-open.mjs — 「课程中心」：确保课程包自己的预览服务在跑
 * ------------------------------------------------------------------
 * 场景 A（2026-09-25 主人定「保留网页版 + 自制快捷方式」）：
 * 侧栏第二行「课程中心」→ `POST /api/whale/pack/open` → 宿主确保
 * `tools/app-server.js` 在跑（**先探活**；没起就**在宿主进程内**起）→ 回星图地址。
 *
 * 为什么走这条路（而不是插件自己托管课程包）见 `lib/pack-server.js` 的文件头 ——
 * 一句话：`file://` 打不开交互星图（module 脚本被 CORS 拦），而宿主的两条路由缝一条挂不了整棵、
 * 一条不经过认证。所以复用课程包自己的服务。
 *
 * 这组判据钉住四条**错了会静默**的不变式：
 *   ① **先探活再起**：已经有服务在跑就**复用**（`started:false`），不重复 listen；
 *   ② **真起一次**：`started:true`，起完 `/health` **真的**答 200，关掉后端口**真的**不通；
 *   ③ **绝不静默降级**：缺件 / 没导出 handler / require 就炸 / 端口被**别的**服务占着
 *      → 一律带修法的 `error`，**绝不**回一个打不开的 url；
 *   ④ 同一个包只起一次（再问一次是复用，不是又 listen 一个）。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ensurePackServer, packServerUrl, closePackServers, runningPackServers } from '../lib/pack-server.js'
import { plugin as packPlugin } from '../lib/mods/pack.js'

const pass = []
const fails = []
function ok(cond, msg) {
  if (cond) pass.push(msg)
  else fails.push(msg)
  console.log((cond ? '  ok  ' : '  ✗   ') + msg)
}

/** 造一个临时"课程包"：给了源码就写 `tools/app-server.js`，给 null 就什么都不写 */
function tmpPack(appServerSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packopen-'))
  if (appServerSrc !== null) {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'tools', 'app-server.js'), appServerSrc, 'utf8')
  }
  return dir
}

/** 要一个当前空闲的端口（拿到就立刻放掉，用它当"假装的 3091"） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {})
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/** `GET /health` 答不答 200 */
function healthOk(port) {
  return new Promise((resolve) => {
    let req
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
    } catch (e) { resolve(false); return }
    req.on('timeout', () => { try { req.destroy() } catch (e) { /* 已断 */ } resolve(false) })
    req.on('error', () => resolve(false))
  })
}

console.log('\n[pack-open] 「课程中心」：起/复用课程包自己的预览服务')

/* ── ① 先探活再起：已经有服务在跑 → 复用 ───────────────────────────── */
{
  const port = await freePort()
  const pre = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((r) => pre.listen(port, '127.0.0.1', r))
  const dir = tmpPack(`module.exports = { handler: (req, res) => { res.writeHead(200); res.end('x') }, health: {}, API_PATHS: [], PORT: ${port} }\n`)

  const r = await ensurePackServer(dir)
  ok(r.ok === true && r.started === false, `已经有服务在跑 → **复用**，不重复 listen（started=${r.started}）`)
  ok(r.url === `http://127.0.0.1:${port}/starmap/`, `回的是星图地址（${r.url}）`)
  ok(runningPackServers().length === 0, '复用**没有**记进"我起的服务"（不是我们起的，就不该由我们关）')

  await new Promise((r2) => pre.close(r2))
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ── ② 真起一次：起完 /health 真的答，关掉后真的不通 ───────────────── */
{
  const port = await freePort()
  const dir = tmpPack([
    `module.exports = {`,
    `  PORT: ${port}, API_PATHS: [], health: {},`,
    `  handler: (req, res) => {`,
    `    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }`,
    `    res.writeHead(404); res.end()`,
    `  },`,
    `}`,
    ``,
  ].join('\n'))

  const r = await ensurePackServer(dir)
  ok(r.ok === true && r.started === true, `没服务在跑 → 这次**真的起了**（started=${r.started}）`)
  ok(await healthOk(port) === true, '起完之后 `/health` **真的**答 200（不是"以为起了"）')
  ok(runningPackServers().includes(path.resolve(dir)), '记进了"我起的服务"（宿主卸载时能关掉）')

  const r2 = await ensurePackServer(dir)
  ok(r2.ok === true && r2.started === false && r2.port === port, '同一个包再问一次 → 复用自己起的那个（不重复 listen）')

  const closed = closePackServers()
  ok(closed.length === 1 && closed[0] === path.resolve(dir), 'closePackServers 关掉它并回包根')
  ok(await healthOk(port) === false, '关掉之后那个端口**真的**不通了（判据不是"我以为关了"）')
  ok(runningPackServers().length === 0, '关完台账是空的')

  fs.rmSync(dir, { recursive: true, force: true })
}

/* ── ③ 绝不静默降级 ─────────────────────────────────────────────────── */
{
  const noFile = tmpPack(null)
  const r1 = await ensurePackServer(noFile)
  ok(r1.ok === false && /tools\/app-server\.js/.test(r1.error || '') && /修法/.test(r1.error || ''),
    '包里没有预览服务 → 带**修法**的 error')
  ok(!r1.url, '失败时**没有** url（不许静默降级成一个打不开的地址）')
  fs.rmSync(noFile, { recursive: true, force: true })

  const noHandler = tmpPack('module.exports = { PORT: 3091, API_PATHS: [] }\n')
  const r2 = await ensurePackServer(noHandler)
  ok(r2.ok === false && /handler/.test(r2.error || ''), '没导出 handler → 如实报（并把契约写出来）')
  fs.rmSync(noHandler, { recursive: true, force: true })

  const broken = tmpPack('throw new Error("故意炸的")\n')
  const r3 = await ensurePackServer(broken)
  ok(r3.ok === false && /加载失败/.test(r3.error || ''), 'require 就炸 → 如实报"加载失败"')
  fs.rmSync(broken, { recursive: true, force: true })

  const r4 = await ensurePackServer('')
  ok(r4.ok === false && /课程包/.test(r4.error || ''), '没配课程包目录 → 如实报（不 500、不糊）')

  // ⚠️ 端口被**别的**服务占着（探活不答）：不许假装成功
  const port = await freePort()
  const squatter = http.createServer((req, res) => { res.writeHead(404); res.end() })
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r))
  const dir = tmpPack(`module.exports = { PORT: ${port}, API_PATHS: [], handler: (req, res) => { res.writeHead(200); res.end() } }\n`)
  const r5 = await ensurePackServer(dir)
  ok(r5.ok === false && !r5.url, '端口被**别的**服务占着（/health 不答）→ 如实报错，**不**假装成功')
  ok(/netstat/.test(r5.error || ''), '错误里给出排查修法（netstat 看谁占着）')
  await new Promise((r) => squatter.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ── ④ 地址形状 ─────────────────────────────────────────────────────── */
ok(packServerUrl(3091) === 'http://127.0.0.1:3091/starmap/', `packServerUrl 是 /starmap/（${packServerUrl(3091)}）`)

/* ── ⑤ 路由：POST /api/whale/pack/open ─────────────────────────────── */
{
  const routes = []
  packPlugin.install({
    paths: { packRoot: undefined },
    log: { info() {}, warn() {}, error() {} },
    inject: (_n, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
  })
  const open = routes.find((r) => r.path === '/api/whale/pack/open')
  ok(!!open, `挂上了 /api/whale/pack/open（本模块共 ${routes.length} 条）`)
  ok(open && open.methods.join() === 'POST' && open.requestBody === 'buffered',
    'methods=POST 且**显式声明 requestBody**（省略会被基座当 streaming ⇒ 400 空体）')

  const r405 = await open.fetch(new Request('http://127.0.0.1:3090/api/whale/pack/open', { method: 'GET' }))
  ok(r405.status === 405, `非 POST → 405（${r405.status}）`)

  const rNo = await open.fetch(new Request('http://127.0.0.1:3090/api/whale/pack/open', { method: 'POST' }))
  const jNo = await rNo.json()
  ok(rNo.status === 200 && jNo.ok === false && !!jNo.error,
    '没配课程包 → 200 + `ok:false` + error（与别的路由同一立场：不 500、把话说清）')
  ok(!jNo.url, '没配课程包时**没有** url')
}

/* ── 收尾：不留一个我们起的服务 ─────────────────────────────────────── */
closePackServers()
ok(runningPackServers().length === 0, '整套跑完：没有留下任何由本模块起的服务')

console.log(`\n=== ${pass.length} 通过 / ${fails.length} 失败 ===`)
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
console.log('✅ 课程中心：先探活再起 / 复用不重复 listen / 起完真的答 / 缺件一律如实报')
