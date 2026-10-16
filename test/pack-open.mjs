/**
 * test/pack-open.mjs — 「课程中心」：确保课程包自己的预览服务在跑
 * ------------------------------------------------------------------
 * 场景 A（2026-09-25 主人定「保留网页版 + 自制快捷方式」）：
 * 侧栏「课程中心」那一行（宿主官方面板行）→ 中间栏那一页 → `POST /api/whale/pack/open` → 宿主确保
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
import { fileURLToPath } from 'node:url'
import { ensurePackServer, packServerUrl, closePackServers, runningPackServers } from '../lib/pack-server.js'
import { plugin as packPlugin } from '../lib/mods/pack.js'

const pass = []
const fails = []
function ok(cond, msg) {
  if (cond) pass.push(msg)
  else fails.push(msg)
  console.log((cond ? '  ok  ' : '  ✗   ') + msg)
}

/**
 * 造一个临时"课程包"。
 *
 * ⚠️ T04-R1（裁定 A）：光有一个手写的 `tools/app-server.js` **不再是一个课程包**了 ——
 * T04 给宿主预览加了「执行前核验受信引擎闭包」（报告 D01）：包里引擎件与插件模板不一致 /
 * 缺件 ⇒ **零 require 地拒**。所以夹具必须**先铺真引擎闭包**（从 `lib/pack-template/` 逐字节拷，
 * 与 `test/_fixture.mjs` 的 layTemplate 同一条规矩）。
 *
 * ⚠️ 而 `app-server.js` **正是受信清单里的一件** ⇒ 不能改它的字节。要"占一个空端口"必须走
 * 它自己留的缝：模板第 31 行是 `Number(process.argv[2] || process.env.PORT || 3091)`。
 * 夹具用 **`process.env.PORT`** 指定端口，并在 require 之前把 `process.argv[2]` 顶掉 ——
 * 因为**整套跑**时子进程带着 `--pack=… --mode=…`，`argv[2]` 会变成 `--pack=…`
 * ⇒ `Number('--pack=…') = NaN` ⇒ 服务落到一个随机端口（那会让判据变成"看运气"）。
 *
 * 三种造法：
 *   · `{}`            —— 真引擎闭包 + 端口走 `process.env.PORT`（argv[2] 被顶掉）；
 *   · `{ requireHook }` —— 真引擎闭包 + 在 app-server 头部插一行（用来验形状错）；
 *   · `{ appServer }`  —— 整份替换 app-server.js（用来验"引擎闸先拒"）。
 */
function tmpPack({ requireHook = null, appServer = undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packopen-'))
  if (appServer === null) return dir          // 空目录（连 app-server 都没有）
  layTemplate(dir)
  const entry = path.join(dir, 'tools', 'app-server.js')
  if (appServer !== undefined) {
    fs.writeFileSync(entry, appServer, 'utf8')
    return dir
  }
  const src = fs.readFileSync(entry, 'utf8')
  if (requireHook) fs.writeFileSync(entry, `${requireHook}\n${src}`, 'utf8')
  return dir
}

/**
 * 用夹具包自己的缝指定端口：模板第 31 行是 `Number(process.argv[2] || process.env.PORT || 3091)`。
 * **整套跑**时子进程带着 `--pack=… --mode=…`，`argv[2]` 是 `--pack=…` ⇒ `Number(...)` = NaN
 * ⇒ 服务落到随机端口（判据会变成"看运气"）。所以调 `ensurePackServer` 之前把 argv[2] 顶掉、
 * 调完还原 —— **不改 app-server.js 的字节**（它是受信清单里的一件，改了引擎闸会正确地拒）。
 */
async function ensurePackServerOnPort(dir, port) {
  const saved = process.argv[2]
  process.argv[2] = ''
  process.env.PORT = String(port)
  try {
    return await ensurePackServer(dir)
  } finally {
    if (saved === undefined) delete process.argv[2]
    else process.argv[2] = saved
    delete process.env.PORT
  }
}

/** 仓内模板：插件**随包发**的那份课程包骨架（引擎件的唯一来源） */
const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'pack-template')

/** 把模板整棵逐字节拷进 `root`（与 `test/_fixture.mjs` 的 layTemplate 同一规矩） */
function layTemplate(root) {
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else {
        const dst = path.join(root, ...r.split('/'))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(path.join(dir, e.name), dst)
      }
    }
  }
  if (!fs.existsSync(TEMPLATE_DIR)) throw new Error(`仓内模板不存在（${TEMPLATE_DIR}）—— 夹具造不出来`)
  walk(TEMPLATE_DIR)
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
  // 夹具：真引擎闭包；端口走夹具自己的缝（见 ensurePackServerOnPort）——
  // ⚠️ 不改 app-server.js 的字节：它是受信清单里的一件，改了引擎闸会（正确地）拒
  const dir = tmpPack()
  {
    const r = await ensurePackServerOnPort(dir, port)
    ok(r.ok === true && r.started === false, `已经有服务在跑 → **复用**，不重复 listen（started=${r.started}）`)
    ok(r.url === `http://127.0.0.1:${port}/starmap/`, `回的是星图地址（${r.url}）`)
    ok(runningPackServers().length === 0, '复用**没有**记进"我起的服务"（不是我们起的，就不该由我们关）')
  }

  await new Promise((r2) => pre.close(r2))
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ── ② 真起一次：起完 /health 真的答，关掉后真的不通 ───────────────── */
{
  const port = await freePort()
  // 夹具：真引擎闭包（模板逐字节）+ 端口走 `process.env.PORT` —— 走**真** app-server，
  // 所以起完 `/health` 真的答 200 这条判据测的是真服务，不是桩。
  const dir = tmpPack()
  {
    const r = await ensurePackServerOnPort(dir, port)
    ok(r.ok === true && r.started === true, `没服务在跑 → 这次**真的起了**（started=${r.started}）`)
    ok(await healthOk(port) === true, '起完之后 `/health` **真的**答 200（不是"以为起了"）')
    ok(runningPackServers().includes(path.resolve(dir)), '记进了"我起的服务"（宿主卸载时能关掉）')

    const r2 = await ensurePackServerOnPort(dir, port)
    ok(r2.ok === true && r2.started === false && r2.port === port, '同一个包再问一次 → 复用自己起的那个（不重复 listen）')

    const closed = closePackServers()
    ok(closed.length === 1 && closed[0] === path.resolve(dir), 'closePackServers 关掉它并回包根')
    ok(await healthOk(port) === false, '关掉之后那个端口**真的**不通了（判据不是"我以为关了"）')
    ok(runningPackServers().length === 0, '关完台账是空的')
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

/* ── ③ 绝不静默降级 ─────────────────────────────────────────────────── */
{
  const noFile = tmpPack({ appServer: null })
  const r1 = await ensurePackServer(noFile)
  ok(r1.ok === false && /tools\/app-server\.js/.test(r1.error || '') && /修法/.test(r1.error || ''),
    '包里没有预览服务 → 带**修法**的 error')
  ok(!r1.url, '失败时**没有** url（不许静默降级成一个打不开的地址）')
  fs.rmSync(noFile, { recursive: true, force: true })

  // ⚠️ T04-R1 的**覆盖边界**（如实写，不假装测过）：下面两条曾经用"手写一个坏 app-server.js"
  //    来触发，但 T04 的引擎闸在 `require` **之前**就核验了 `tools/app-server.js` 的字节 ——
  //    手写的那份与受信清单不一致 ⇒ **闸先拒**（"引擎与插件受信版本不一致"），
  //    于是 handler 判据 / "加载失败"判据在**这个夹具形态下不可达**。
  //    所以这两条改成断言"闸确实拦住了它"（判据仍然非空、且**更强**）：
  //    坏件不再能被执行，连"没导出 handler"这条路都走不到。
  const noHandler = tmpPack({ appServer: 'module.exports = { PORT: 3091, API_PATHS: [] }\n' })
  const r2 = await ensurePackServer(noHandler)
  ok(r2.ok === false && /引擎/.test(r2.error || ''), '手写的坏 app-server.js → **引擎闸先拒**（引擎与受信版本不一致）')
  ok(r2.ok === false && !r2.url, '被闸拒时**没有** url（不许静默降级）')
  fs.rmSync(noHandler, { recursive: true, force: true })

  // require 就炸：同样被闸拦在 require 之前（"加载失败"那条在闸存在时不可达）
  const broken = tmpPack({ appServer: 'throw new Error("故意炸的")\n' })
  const r3 = await ensurePackServer(broken)
  ok(r3.ok === false && /引擎/.test(r3.error || ''), '会抛的 app-server.js → **引擎闸先拒**（根本没 require）')
  fs.rmSync(broken, { recursive: true, force: true })

  const r4 = await ensurePackServer('')
  ok(r4.ok === false && /课程包/.test(r4.error || ''), '没配课程包目录 → 如实报（不 500、不糊）')

  // ⚠️ 端口被**别的**服务占着（探活不答）：不许假装成功
  const port = await freePort()
  const squatter = http.createServer((req, res) => { res.writeHead(404); res.end() })
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r))
  const dir = tmpPack()
  const r5 = await ensurePackServerOnPort(dir, port)
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
