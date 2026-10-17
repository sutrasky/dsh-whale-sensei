/**
 * test/audit/T15.mjs — 预览探活必须核对**包身份**（报告 A03 / P1）
 * ------------------------------------------------------------------
 * 病：宿主「进入课程包」原先只探「`GET /health` 答 200 吗」——
 *     任何一个在 3091 上答 200 的东西（别的包的服务、随便一个桩、上一版留下的老服务）
 *     都会被当成"这个包的服务"直接复用：地址栏指向 A，页面却是 B 的内容。
 *     **HTTP 200 只是"有东西在答"，不是身份。**
 *
 * 契约（§3.2 由规划者钉死；本文件逐字判它）：
 *   · 服务侧 `/health` 带**身份信封**：`protocol=1` / `packId=sha256(realpath(包根))[:16]` /
 *     `engineDigest=digestOfManifest(buildManifest(包根).files)`（与宿主
 *     `lib/engine.js#verifyEngine(root, trustedManifest()).digest` **同一口径**）；
 *     三字段有一个算不出来 ⇒ **不许**回 `ok:true` 的假身份（如实 500 + `identityError`）。
 *   · 宿主侧 `ensurePackServer(root,{port,scope})`：先核引擎（**零 require** 地拒）→ 再 require →
 *     探**身份**；只有**同包 + 同协议 + 同引擎**才算命中；命中的**外部**服务还要能完成
 *     **合法会话接续**（`POST /api/session` 拿到带 capability 的 200）才允许复用（`started:false`）；
 *     身份不符 ⇒ `{ok:false, reason:'port-conflict'}`（含 `netstat` 修法，**绝不**杀占用者）；
 *     拿不到会话 ⇒ `{ok:false, reason:'needs-authorization'}`。复用**不接管**（不进本模块台账）。
 *
 * 固定用例 ID 全集（**不许漂移**）：
 *   I01–I05 服务侧：信封三字段 / packId 是真身路径摘要（不是 basename）/ 摘要同口径且稳定 /
 *           反空转（算不出身份不许假 `ok:true`）/ 管理台 `/api/health` 同一口径 + 既有字段不删
 *   R01–R05 宿主侧：外部同包真服务复用（不接管）/ 插件卸载后外部服务仍存活 / 自己起的复用与回收 /
 *           显式 `port` 优先于包内 `PORT` / 身份相符但拿不到会话 ⇒ `needs-authorization`
 *   C01–C05 冲突负例：无关 200 服务 / 404 服务 / 别的包（A 占 B 的端口）/ 旧协议（protocol:2）/
 *           同包但引擎字节不同（packId 相符、engineDigest 是另一个真实引擎闭包的摘要）
 *   O01 产品缝：`POST /api/whale/pack/open` 走的是同一条认身份的路
 *
 * 验收命令：`node test/audit/T15.mjs`（成功 exit0 且 stdout/stderr 只给一行判词；失败 exit1）。
 * 判据不判"好不好看"、不跑 Maven、不起子进程（全部进程内 / 本机回环）。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { ensurePackServer, closePackServers, runningPackServers } from '../../lib/pack-server.js'
import { buildManifest, digestOfManifest } from '../../lib/engine.js'
import { createResourceScope } from '../../lib/resource-scope.js'
import { plugin as packPlugin } from '../../lib/mods/pack.js'

/** 固定用例 ID 全集（漂移即判失败） */
const IDS = [
  'I01', 'I02', 'I03', 'I04', 'I05',
  'R01', 'R02', 'R03', 'R04', 'R05',
  'C01', 'C02', 'C03', 'C04', 'C05',
  'O01',
]

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')
const evidence = path.join(REPO, 'audit-evidence/T15')
fs.mkdirSync(evidence, { recursive: true })
const stamp = `${Date.now()}-${process.pid}`
const base = 'E:/Temp'
fs.mkdirSync(base, { recursive: true })
const fixture = fs.mkdtempSync(path.join(base, 'whale-T15-'))

const records = []
const observed = []
/** 本文件起的全部服务（夹具自己的；**不是** lib/pack-server.js 台账里的那些） */
const servers = []

/* ── 小工具 ─────────────────────────────────────────────────────────── */

const ok = (cond, msg) => { if (!cond) throw new Error(msg) }

/** 一个当前空闲的端口（拿到就放掉） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {})
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/** 本机回环请求（连不上 = `status:0`；不把"没答"当"答了"） */
function request(port, pathname, { method = 'GET', headers = {}, body = null, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const finish = (v) => resolve(v)
    let req
    try {
      req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: timeoutMs }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let doc = null
          try { doc = JSON.parse(text) } catch (e) { doc = null }
          finish({ status: res.statusCode, doc, text })
        })
        res.on('error', () => finish({ status: 0, doc: null, text: '' }))
      })
    } catch (e) {
      finish({ status: 0, doc: null, text: String(e && e.message ? e.message : e) })
      return
    }
    req.on('timeout', () => { try { req.destroy() } catch (e) { /* 已断 */ } finish({ status: 0, doc: null, text: 'timeout' }) })
    req.on('error', () => finish({ status: 0, doc: null, text: '' }))
    req.end(body === null ? undefined : body)
  })
}

const getJson = (port, pathname) => request(port, pathname)

/** 起一个服务并记账（收尾统一关掉） */
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  servers.push(server)
  return server
}

/** 端口上放一个"别人的"服务（负例夹具） */
function startStub(port, handler) {
  return listen(http.createServer(handler), port)
}

const jsonStub = (port, status, body) => startStub(port, (req, res) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
})

/**
 * 端口走夹具自己的缝：包内 `app-server.js` 的 PORT 是
 * `Number(process.argv[2] || process.env.PORT || 3091)` —— 顶掉 argv[2]（本套件跑时它可能是别的参数），
 * 用 `process.env.PORT` 指定端口。**不改 app-server.js 的字节**（它是受信清单里的一件）。
 *
 * ⚠️ 还原必须**原位**做（快照 → 清空 → 按原样填回）：`delete process.argv[2]` 会把 argv 变成
 *    **稀疏数组**，于是别的模块在 require 时那句 `process.argv.slice(2)` 里出现 `undefined` ——
 *    `ask-server.js:94` 的 `args.find((a) => a.startsWith(...))` 当场 TypeError（实测踩到）。
 */
async function withEnvPort(port, fn) {
  const savedArgv = process.argv.slice()
  const savedPort = process.env.PORT
  process.argv[2] = ''
  process.env.PORT = String(port)
  try {
    return await fn()
  } finally {
    process.argv.length = 0
    for (const a of savedArgv) process.argv.push(a)
    if (savedPort === undefined) delete process.env.PORT
    else process.env.PORT = savedPort
  }
}

/** 铺一个"真课程包"：模板整棵逐字节拷（与 pack-open / T04 / T13 同一条规矩） */
function layPack(...segs) {
  const root = path.join(fixture, ...segs)
  fs.mkdirSync(root, { recursive: true })
  fs.cpSync(TEMPLATE, root, { recursive: true })
  return root
}

/** 在**测试进程里**用这个包自己的 `tools/app-server.js` 起一个**真服务**（T15 的"外部服务"夹具） */
async function startExternal(root, port) {
  const mod = await withEnvPort(port, async () => createRequire(import.meta.url)(path.join(root, 'tools', 'app-server.js')))
  return listen(http.createServer(mod.handler), port)
}

/** 宿主**独立重算**的期望身份（与包侧那份实现同一口径：同一份 tools/engine-policy.cjs） */
function expectedIdentity(root) {
  const packId = createHash('sha256').update(fs.realpathSync(root), 'utf8').digest('hex').slice(0, 16)
  const engineDigest = digestOfManifest(buildManifest(root).files)
  return { packId, engineDigest }
}

/* ── 用例驱动（与 T13 同一条纪律：逐条记录，失败不吞）──────────────────── */

async function check(id, fn) {
  try {
    const note = await fn()
    records.push({ id, status: 'pass', note: note === undefined ? null : note })
  } catch (e) {
    records.push({ id, status: 'fail', error: e && e.stack ? e.stack : String(e) })
  }
}

let fatal = null

try {
  /* ── ① 服务侧：身份信封 ───────────────────────────────────────────── */

  await check('I01', async () => {
    const root = layPack('i01')
    const port = await freePort()
    await startExternal(root, port)
    const h = await getJson(port, '/health')
    const expect = expectedIdentity(root)
    ok(h.status === 200, `GET /health 必须 200（实得 ${h.status}）`)
    ok(h.doc && h.doc.ok === true, `健康响应必须是 JSON 且 ok:true（实得 ${JSON.stringify(h.doc)}）`)
    ok(h.doc.protocol === 1, `protocol 必须是整数 1（实得 ${JSON.stringify(h.doc.protocol)}）`)
    ok(h.doc.packId === expect.packId, `packId 必须等于 sha256(realpath(包根))[:16]（实得 ${JSON.stringify(h.doc.packId)} / 期望 ${expect.packId}）`)
    ok(h.doc.engineDigest === expect.engineDigest, `engineDigest 必须与宿主独立重算的一致（实得 ${JSON.stringify(h.doc.engineDigest)} / 期望 ${expect.engineDigest}）`)
    ok(h.doc.port === port, `既有字段 port 仍在且是这个端口（实得 ${JSON.stringify(h.doc.port)} / ${port}）`)
    ok(h.doc.pending !== undefined, '既有字段 pending 仍在（一个都不许删）')
    // `/healthz`（纯文本 liveness，离线端 :825-843 的等待逻辑用它）**保持不变**
    const hz = await getJson(port, '/healthz')
    ok(hz.status === 200 && hz.text === 'ok', `/healthz 仍是纯文本 ok（实得 ${hz.status} / ${JSON.stringify(hz.text)}）`)
    observed.push({ id: 'I01', port, expect, got: h.doc })
    return { port, expect }
  })

  await check('I02', async () => {
    // 两个**同名不同目录**的包：`basename` 口径会撞，真身路径口径不会
    const a = layPack('i02-a', 'pkg')
    const b = layPack('i02-b', 'pkg')
    ok(path.basename(a) === path.basename(b), '夹具前提：两个包的目录名必须一样')
    const pa = await freePort()
    const pb = await freePort()
    await startExternal(a, pa)
    await startExternal(b, pb)
    const da = (await getJson(pa, '/health')).doc
    const db = (await getJson(pb, '/health')).doc
    const ea = expectedIdentity(a)
    const eb = expectedIdentity(b)
    ok(da && da.packId === ea.packId, `第一个包的 packId 按真身路径算（实得 ${JSON.stringify(da && da.packId)} / 期望 ${ea.packId}）`)
    ok(db && db.packId === eb.packId, `第二个包的 packId 按真身路径算（实得 ${JSON.stringify(db && db.packId)} / 期望 ${eb.packId}）`)
    ok(da.packId !== db.packId, `同名不同目录的两个包必须算出**不同**的 packId（实得 ${da.packId} / ${db.packId}）`)
    observed.push({ id: 'I02', a, b, packIdA: da.packId, packIdB: db.packId })
    return { packIdA: da.packId, packIdB: db.packId }
  })

  await check('I03', async () => {
    const root = layPack('i03')
    const port = await freePort()
    await startExternal(root, port)
    const one = (await getJson(port, '/health')).doc
    const two = (await getJson(port, '/health')).doc
    const expect = expectedIdentity(root)
    ok(one.engineDigest === expect.engineDigest, '/health 的 engineDigest 与宿主独立重算（digestOfManifest(buildManifest(root).files)）逐字相等')
    ok(one.engineDigest === two.engineDigest, `两次 /health 必须回同一个摘要（进程内算一次并缓存；实得 ${one.engineDigest} / ${two.engineDigest}）`)
    ok(/^[0-9a-f]{64}$/.test(one.engineDigest), `engineDigest 必须是 64 位十六进制（实得 ${JSON.stringify(one.engineDigest)}）`)
    // 夹具前提（C05 要用）：改**一个引擎字节**，真实摘要必须变
    const tampered = path.join(fixture, 'i03-tampered')
    fs.cpSync(root, tampered, { recursive: true })
    fs.appendFileSync(path.join(tampered, 'tools', 'style-check.js'), '\n// T15 夹具：故意改一个引擎字节\n', 'utf8')
    const other = digestOfManifest(buildManifest(tampered).files)
    ok(other !== one.engineDigest, '夹具前提：改一个引擎字节之后引擎摘要必须变')
    observed.push({ id: 'I03', digest: one.engineDigest, tamperedDigest: other })
    return { digest: one.engineDigest, tamperedDigest: other }
  })

  await check('I04', async () => {
    // 反空转：算不出身份（包里没有 tools/engine-policy.cjs）⇒ **不许**回 ok:true 的假身份
    const root = layPack('i04')
    fs.rmSync(path.join(root, 'tools', 'engine-policy.cjs'), { force: true })
    const port = await freePort()
    await startExternal(root, port)
    const h = await getJson(port, '/health')
    ok(h.status === 500, `算不出引擎身份必须如实 500（实得 ${h.status}）`)
    ok(h.doc && h.doc.ok === false, `不许冒充：ok 必须是 false（实得 ${JSON.stringify(h.doc && h.doc.ok)}）`)
    ok(!(h.doc && h.doc.protocol === 1 && h.doc.packId && h.doc.engineDigest),
      `三字段不许"看着齐"——engineDigest 必须是空（实得 ${JSON.stringify(h.doc)}）`)
    ok(h.doc && typeof h.doc.identityError === 'string' && h.doc.identityError.length > 0, '必须如实说明算不出身份（identityError）')
    observed.push({ id: 'I04', status: h.status, doc: h.doc })
    return { status: h.status }
  })

  await check('I05', async () => {
    // 管理台（offline-server）的 `/api/health` **追加**同样三字段；既有四字段一个都不删
    const install = path.join(fixture, 'i05-install')
    fs.cpSync(TEMPLATE, install, { recursive: true })
    const lib = path.join(fixture, 'i05-lib')
    fs.mkdirSync(lib, { recursive: true })
    const port = await freePort()
    const savedArgv = process.argv
    let mod
    try {
      process.argv = [process.argv[0], path.join(install, 'tools', 'offline-server.js'), `--lib=${lib}`, String(port)]
      mod = createRequire(import.meta.url)(path.join(install, 'tools', 'offline-server.js'))
    } finally {
      process.argv = savedArgv
    }
    ok(typeof mod.handler === 'function', 'offline-server 要导出 handler')
    await listen(http.createServer(mod.handler), port)
    const h = await getJson(port, '/api/health')
    const expect = expectedIdentity(install)
    ok(h.status === 200, `GET /api/health 必须 200（实得 ${h.status}）`)
    ok(h.doc && h.doc.ok === true, `ok 必须 true（实得 ${JSON.stringify(h.doc)}）`)
    ok(h.doc.port === port, `既有字段 port 仍是它监听的端口（实得 ${JSON.stringify(h.doc.port)} / ${port}）`)
    ok(h.doc.dir === path.join(lib, 'library'), `既有字段 dir 仍在（实得 ${JSON.stringify(h.doc.dir)} / ${path.join(lib, 'library')}）`)
    ok(typeof h.doc.lessons === 'number', `既有字段 lessons 仍在（实得 ${JSON.stringify(h.doc.lessons)}）`)
    ok(h.doc.protocol === 1, `protocol 必须是 1（实得 ${JSON.stringify(h.doc.protocol)}）`)
    ok(h.doc.packId === expect.packId, `packId 必须等于 sha256(realpath(安装目录))[:16]（实得 ${JSON.stringify(h.doc.packId)} / 期望 ${expect.packId}）`)
    ok(h.doc.engineDigest === expect.engineDigest, `engineDigest 必须与宿主独立重算一致（实得 ${JSON.stringify(h.doc.engineDigest)} / 期望 ${expect.engineDigest}）`)
    observed.push({ id: 'I05', status: h.status, doc: h.doc, expect })
    return { port, packId: h.doc.packId }
  })

  /* ── ② 宿主侧：复用与所有权 ───────────────────────────────────────── */

  let externalB = null
  let portB = 0
  let rootB = ''

  await check('R01', async () => {
    rootB = layPack('r01-b')
    portB = await freePort()
    const srv = await startExternal(rootB, portB)
    externalB = srv
    const out = await ensurePackServer(rootB, { port: portB })
    ok(out.ok === true, `打开 B 必须成功（实得 ${JSON.stringify(out)}）`)
    ok(out.started === false, `B 的真服务已经在跑 ⇒ 复用（started=${out.started}）`)
    ok(out.port === portB, `回的是 B 的端口（实得 ${out.port} / ${portB}）`)
    ok(out.url === `http://127.0.0.1:${portB}/starmap/`, `回的是星图地址（实得 ${JSON.stringify(out.url)}）`)
    ok(!runningPackServers().includes(path.resolve(rootB)), '复用**不接管**：没记进本模块台账（不是我们起的，就不该由我们关）')
    const h = await getJson(portB, '/health')
    ok(h.status === 200, '端口上那份服务仍在答（复用没有把它换掉）')
    observed.push({ id: 'R01', out, running: runningPackServers() })
    return out
  })

  await check('R02', async () => {
    // 插件卸载（= 资源作用域回收本模块起过的服务）之后，**外部**服务必须仍存活
    const scope = createResourceScope()
    const out = await ensurePackServer(rootB, { port: portB, scope })
    ok(out.ok === true && out.started === false, `作用域内再次复用同一份外部服务（实得 ${JSON.stringify(out)}）`)
    const r = await scope.dispose()
    ok(r.errors.length === 0, `作用域回收不该报错（实得 ${JSON.stringify(r.errors)}）`)
    ok(!runningPackServers().includes(path.resolve(rootB)), '卸载后本模块台账里没有它（我们没接管别人的服务）')
    const h = await getJson(portB, '/health')
    ok(h.status === 200, `插件卸载后外部服务**仍存活**（实得 ${h.status}）`)
    ok(externalB && externalB.listening === true, '夹具自己的那份服务还 listening（不是我们关的）')
    observed.push({ id: 'R02', disposed: r.errors, health: h.status })
    return { health: h.status }
  })

  await check('R03', async () => {
    // 自己起：空端口 → started:true；再问一次 → 复用自己起的；closePackServers 之后端口真的不通
    const root = layPack('r03')
    const port = await freePort()
    const first = await ensurePackServer(root, { port })
    ok(first.ok === true && first.started === true, `端口空的 ⇒ 这次真的起了（实得 ${JSON.stringify(first)}）`)
    ok(first.port === port, `起在我们要求的端口上（实得 ${first.port} / ${port}）`)
    ok(runningPackServers().includes(path.resolve(root)), '记进了"我起的服务"（宿主卸载时能关掉）')
    ok((await getJson(port, '/health')).status === 200, '起完 /health 真的答 200')
    const second = await ensurePackServer(root, { port })
    ok(second.ok === true && second.started === false && second.port === port, `同一个包再问一次 → 复用自己起的那个（实得 ${JSON.stringify(second)}）`)
    const closed = closePackServers()
    ok(closed.includes(path.resolve(root)), `closePackServers 关掉它并回包根（实得 ${JSON.stringify(closed)}）`)
    ok((await getJson(port, '/health')).status === 0, '关掉之后那个端口真的不通了（判据不是"我以为关了"）')
    ok(!runningPackServers().includes(path.resolve(root)), '关完台账里没有它')
    observed.push({ id: 'R03', first, second, closed })
    return { port, closed }
  })

  await check('R04', async () => {
    // 显式 `port` 优先于包内 `PORT`（包内 PORT 指 innerPort，显式给 wantPort）
    const root = layPack('r04')
    const innerPort = await freePort()
    const wantPort = await freePort()
    const out = await withEnvPort(innerPort, () => ensurePackServer(root, { port: wantPort }))
    ok(out.ok === true && out.started === true, `显式端口要能起（实得 ${JSON.stringify(out)}）`)
    ok(out.port === wantPort, `起在**显式给的**端口上（实得 ${out.port} / ${wantPort}）`)
    const h = await getJson(wantPort, '/health')
    ok(h.status === 200 && h.doc && h.doc.packId === expectedIdentity(root).packId, '那个端口上确实是这个包的服务')
    ok((await getJson(innerPort, '/health')).status === 0, '包内 PORT 指的那个端口上**什么都没起**（显式端口真的赢了）')
    closePackServers()
    ok((await getJson(wantPort, '/health')).status === 0, '收尾：关掉了')
    observed.push({ id: 'R04', out, innerPort, wantPort })
    return { out, innerPort, wantPort }
  })

  await check('R05', async () => {
    // 身份相符但**拿不到合法会话** ⇒ 不许复用（needs-authorization）
    const root = layPack('r05')
    const expect = expectedIdentity(root)
    const port = await freePort()
    await startStub(port, (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, port, pending: 0, protocol: 1, packId: expect.packId, engineDigest: expect.engineDigest }))
      }
      if (req.url === '/api/session') {
        res.writeHead(403, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, code: 'ORIGIN_UNTRUSTED', error: '夹具：这个服务不给会话' }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
    const out = await ensurePackServer(root, { port })
    ok(out.ok === false, `拿不到会话不许复用（实得 ${JSON.stringify(out)}）`)
    ok(out.reason === 'needs-authorization', `reason 必须是 needs-authorization（实得 ${JSON.stringify(out.reason)}）`)
    ok(!out.url, '失败时没有 url（不许静默降级成一个打不开/别人的地址）')
    ok(typeof out.error === 'string' && out.error.length > 0, '必须如实说明为什么（error 非空）')
    ok(!runningPackServers().includes(path.resolve(root)), '被拒的服务没有进台账')
    observed.push({ id: 'R05', out })
    return out
  })

  /* ── ③ 冲突负例（不能以 HTTP 200 代替身份）────────────────────────── */

  await check('C01', async () => {
    const root = layPack('c01')
    const port = await freePort()
    // 一个**无关的、答 200 的**服务（旧实现的判据在它面前会放行 —— 这正是 A03 的病）
    await jsonStub(port, 200, { ok: true })
    const out = await ensurePackServer(root, { port })
    ok(out.ok === false, `无关 200 服务占端口 ⇒ 不许复用（实得 ${JSON.stringify(out)}）`)
    ok(out.reason === 'port-conflict', `reason 必须是 port-conflict（实得 ${JSON.stringify(out.reason)}）`)
    ok(!out.url, '失败时没有 url（不许静默降级）')
    ok(/netstat/.test(out.error || ''), `错误里必须给出 netstat 修法（实得 ${JSON.stringify(out.error)}）`)
    ok((await getJson(port, '/health')).status === 200, '**绝不杀占用者**：那个无关服务还活着')
    ok(!runningPackServers().includes(path.resolve(root)), '被拒的包没有进台账')
    observed.push({ id: 'C01', out })
    return out
  })

  await check('C02', async () => {
    const root = layPack('c02')
    const port = await freePort()
    await jsonStub(port, 404, { ok: false, error: 'not found' })
    const out = await ensurePackServer(root, { port })
    ok(out.ok === false && out.reason === 'port-conflict', `404 服务占端口 ⇒ port-conflict（实得 ${JSON.stringify(out)}）`)
    ok(!out.url, '失败时没有 url')
    ok(/netstat/.test(out.error || ''), `错误里必须给出 netstat 修法（实得 ${JSON.stringify(out.error)}）`)
    ok((await getJson(port, '/health')).status === 404, '**绝不杀占用者**：那个 404 服务还活着')
    observed.push({ id: 'C02', out })
    return out
  })

  await check('C03', async () => {
    // A 的真服务占着 B 要用的端口：问 A → 命中 A；问 B → **不许**复用 A
    const rootA = layPack('c03', 'a')
    const rootBB = layPack('c03', 'b')
    const port = await freePort()
    await startExternal(rootA, port)
    const outA = await ensurePackServer(rootA, { port })
    ok(outA.ok === true && outA.started === false && outA.port === port,
      `同一个端口：问 A 命中 A 的服务（复用；实得 ${JSON.stringify(outA)}）`)
    const outB = await ensurePackServer(rootBB, { port })
    ok(outB.ok === false, `同一个端口：问 B **不许**复用 A 的服务（实得 ${JSON.stringify(outB)}）`)
    ok(outB.reason === 'port-conflict', `reason 必须是 port-conflict（实得 ${JSON.stringify(outB.reason)}）`)
    ok(!outB.url, '失败时没有 url（不许把 A 的地址回给 B）')
    observed.push({ id: 'C03', outA, outB, rootA, rootB: rootBB })
    return { outA, outB }
  })

  await check('C04', async () => {
    // 旧协议（protocol:2）⇒ 冲突：**不把旧协议猜成新协议**
    const root = layPack('c04')
    const expect = expectedIdentity(root)
    const port = await freePort()
    await jsonStub(port, 200, { ok: true, port, pending: 0, protocol: 2, packId: expect.packId, engineDigest: expect.engineDigest })
    const out = await ensurePackServer(root, { port })
    ok(out.ok === false && out.reason === 'port-conflict', `旧协议 ⇒ port-conflict（实得 ${JSON.stringify(out)}）`)
    ok(!out.url, '失败时没有 url')
    ok(/netstat/.test(out.error || ''), '错误里必须给出 netstat 修法')
    observed.push({ id: 'C04', out })
    return out
  })

  await check('C05', async () => {
    // packId 相符（= 同一个包），但 **engineDigest 是另一个真实引擎闭包**的摘要 ⇒ 冲突
    const root = layPack('c05')
    const expect = expectedIdentity(root)
    const tampered = path.join(fixture, 'c05-tampered')
    fs.cpSync(root, tampered, { recursive: true })
    fs.appendFileSync(path.join(tampered, 'tools', 'style-check.js'), '\n// T15 夹具：故意改一个引擎字节\n', 'utf8')
    const otherDigest = digestOfManifest(buildManifest(tampered).files)
    ok(otherDigest !== expect.engineDigest, '夹具前提：改一个引擎字节之后摘要必须变')
    const port = await freePort()
    await jsonStub(port, 200, { ok: true, port, pending: 0, protocol: 1, packId: expect.packId, engineDigest: otherDigest })
    const out = await ensurePackServer(root, { port })
    ok(out.ok === false && out.reason === 'port-conflict',
      `同包但引擎字节不同 ⇒ port-conflict（实得 ${JSON.stringify(out)}）`)
    ok(!out.url, '失败时没有 url')
    ok(/engineDigest/.test(out.error || ''), `错误里要点名是引擎字节对不上（实得 ${JSON.stringify(out.error)}）`)
    observed.push({ id: 'C05', out, expect, otherDigest })
    return out
  })

  /* ── ④ 产品缝：POST /api/whale/pack/open ─────────────────────────── */

  await check('O01', async () => {
    const root = layPack('o01')
    const port = await freePort()
    await startExternal(root, port)
    const routes = []
    packPlugin.install({
      paths: { packRoot: root },
      log: { info() {}, warn() {}, error() {} },
      inject: (_n, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
    })
    const open = routes.find((r) => r.path === '/api/whale/pack/open')
    ok(!!open, `挂上了 /api/whale/pack/open（本模块共 ${routes.length} 条）`)
    const res = await open.fetch(new Request('http://127.0.0.1:3090/api/whale/pack/open', { method: 'POST' }))
    const j = await res.json()
    ok(res.status === 200, `路由回 200（实得 ${res.status}）`)
    ok(j.ok === true && j.started === false, `路由复用 B 的真服务（实得 ${JSON.stringify(j)}）`)
    ok(j.url === `http://127.0.0.1:${port}/starmap/`, `回的是 B 的星图地址（实得 ${JSON.stringify(j.url)}）`)
    observed.push({ id: 'O01', j })
    return j
  })
} catch (e) {
  fatal = e && e.stack ? e.stack : String(e)
} finally {
  for (const s of servers) {
    try { await new Promise((r) => s.close(r)) } catch (e) { /* 尽力 */ }
  }
  try { closePackServers() } catch (e) { fatal ??= String(e) }
}

/* ── 判词 ───────────────────────────────────────────────────────────── */

const ids = records.map((r) => r.id)
if (JSON.stringify(ids) !== JSON.stringify(IDS)) fatal ??= `固定用例 ID 全集漂移：期望 ${IDS.join(',')}，实得 ${ids.join(',')}`
const failed = records.filter((r) => r.status === 'fail').length + (fatal ? 1 : 0)
const verdict = failed === 0 ? 'PASS' : 'FAIL'
const out = {
  verdict,
  label: 'T15',
  exitCode: failed ? 1 : 0,
  ids: IDS,
  records,
  observed,
  fatal,
  fixture,
  servers: servers.length,
}
fs.writeFileSync(path.join(evidence, `run-${stamp}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
fs.writeFileSync(path.join(evidence, `cases-${stamp}.txt`), [
  `T15 固定用例 ID：${IDS.join(' ')}`,
  ...records.map((r) => r.status === 'pass'
    ? `ok   ${r.id}${r.note ? `  ${JSON.stringify(r.note)}` : ''}`
    : `FAIL ${r.id}\n${r.error}`),
  ...(fatal ? ['', 'FATAL', fatal] : []),
  '',
].join('\n'), 'utf8')

// 失败留夹具以便诊断；成功才删（删前核绝对路径属于本次夹具）
if (!failed) {
  const abs = path.resolve(fixture)
  if (path.dirname(abs) !== path.resolve(base) || !path.basename(abs).startsWith('whale-T15-')) {
    console.log(`FAIL T15 checks=${records.length} failed=${failed + 1} skipped=0`)
    process.exit(1)
  }
  fs.rmSync(abs, { recursive: true, force: true })
}

console.log(`${verdict} T15 checks=${records.length} failed=${failed} skipped=0`)
process.exit(failed ? 1 : 0)
