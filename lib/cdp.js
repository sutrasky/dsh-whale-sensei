/**
 * lib/cdp.js —— 用 CDP 截图（B2）
 *
 * 为什么必须换掉 `--headless=new --screenshot=...`：那个开关**只截首屏** ✗ ——
 * 比视口高的内容直接丢，之前只能靠"把窗口开到 1000x3600"绕，既不准也会把
 * 响应式布局喂成桌面宽度。CDP 的 `Page.captureScreenshot`
 * 可以 `captureBeyondViewport: true` 配 `clip` 拿**整页**，也能给一个小
 * `clip` 拿**局部**。
 *
 * 本机不需要任何新依赖：Node 22+ 自带全局 WebSocket，Node 18+ 自带 fetch。
 * 用 `Target.createTarget` + `attachToTarget(flatten:true)` 走浏览器级 socket，
 * 一个连接里用 sessionId 复用（不额外拉 ws 库）。
 *
 * 判据（`node lib/cdp.js --selftest`，本机真跑浏览器）：
 *   ① 视口截图：PNG 尺寸恰好 = 请求的宽高
 *   ② 整页截图：PNG 高度 **> 视口高度**（--screenshot 做不到这件事）
 *   ③ 局部截图：PNG 尺寸恰好 = clip 的宽高
 *   ④ 三张都不是白屏（字节数下限 + IHDR 尺寸自检）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { runAsync } from './exec.js'
import { fileURLToPath } from 'node:url'

/** 从 PNG 的 IHDR 读宽高（不引图形库） */
export function pngSize(buf) {
  if (!buf || buf.length < 24) throw new Error('不是 PNG：太短')
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('不是 PNG：签名不对')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function waitCdp(port, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('CDP 端口 ' + port + ' 在 ' + timeoutMs + 'ms 内没就绪')
    await new Promise((r) => setTimeout(r, 150))
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let seq = 0
    ws.addEventListener('open', () => {
      resolve({
        send: (method, params = {}, sessionId) => new Promise((res, rej) => {
          const id = ++seq
          pending.set(id, { res, rej })
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
        }),
        close: () => { try { ws.close() } catch { /* 已关 */ } },
      })
    })
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 失败：' + (e?.message || 'unknown'))))
    ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) rej(new Error(m.error.message)); else res(m.result)
      }
    })
  })
}

/**
 * 截一张图。
 * @param {{exe:string,url:string,width?:number,height?:number,budgetMs?:number,
 *          fullPage?:boolean,clip?:{x:number,y:number,width:number,height:number},
 *          profileDir?:string,outPng?:string}} o
 * @returns {Promise<{png:Buffer,size:{width:number,height:number},contentSize:object,closed:boolean}>}
 */
export async function capturePng(o = {}) {
  const { exe, url, width = 1280, height = 900, budgetMs = 2500 } = o
  if (!exe) throw new Error('缺少浏览器可执行文件路径')
  if (!url) throw new Error('缺少 url')
  const profileDir = o.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cdp-'))
  const ownProfile = !o.profileDir
  const port = await freePort()
  // ⚠️ 必须走 runAsync：裸 spawn 不监听 error 时，EPERM/ENOENT 会变成**未捕获异常**把进程带走
  const { child: proc, failed } = runAsync(exe, [
    '--headless=new', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })

  let conn = null
  let closed = false
  try {
    // 子进程没起来就别干等端口：把 failed 的人话直接抛出去（干等到超时再报「连不上」是在骗人）
    const ver = await Promise.race([
      waitCdp(port),
      failed.then((h) => { throw new Error(h || `浏览器没起来：${exe}`) }),
    ])
    conn = await connect(ver.webSocketDebuggerUrl)
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
    await conn.send('Page.enable', {}, sessionId)
    // 先定视口：整页也好、局部也好，布局宽度都由这里决定（别用 --window-size 喂）
    await conn.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
    await conn.send('Page.navigate', { url }, sessionId)
    await new Promise((r) => setTimeout(r, budgetMs))

    const metrics = await conn.send('Page.getLayoutMetrics', {}, sessionId)
    const contentSize = metrics.cssContentSize || metrics.contentSize
    const params = { format: 'png', captureBeyondViewport: true }
    if (o.fullPage === true) {
      params.clip = { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 }
    } else if (o.clip) {
      params.clip = { x: o.clip.x, y: o.clip.y, width: o.clip.width, height: o.clip.height, scale: 1 }
    } else {
      params.clip = { x: 0, y: 0, width, height, scale: 1 }
    }
    const shot = await conn.send('Page.captureScreenshot', params, sessionId)
    const png = Buffer.from(shot.data, 'base64')
    if (o.outPng) fs.writeFileSync(o.outPng, png)
    const size = pngSize(png)
    if (size.width !== Math.ceil(params.clip.width) || size.height !== Math.ceil(params.clip.height)) {
      throw new Error('PNG 尺寸与 clip 不一致：' + JSON.stringify(size) + ' vs ' + JSON.stringify(params.clip))
    }
    try { await conn.send('Browser.close') } catch { /* 关不掉就下面 kill */ }
    closed = true
    return { png, size, contentSize: { width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height) }, closed }
  } finally {
    if (conn) conn.close()
    if (!closed) { try { proc.kill() } catch { /* 已退 */ } }
    if (ownProfile) { try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* 清理失败不致命 */ } }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
  const { findBrowser } = await import('./visual-io.js')
  const exe = findBrowser()
  // 只认第一个**不以 -- 开头**的参数当页面（否则 `--selftest` 会被当成 URL ✗）
  // 没给页面时退回「配置的那个课程包」里的 reference/NOTES.html；
  // **不写死某台机器上的绝对路径**（原实现把它写死成一个 file:// URL，换台机器必崩）。
  const packEnv = (process.env.DSH_WHALE_PACK || '').trim()
  const page = process.argv.slice(2).find((a) => !a.startsWith('--'))
    || (packEnv ? 'file:///' + path.resolve(packEnv).replace(/\\/g, '/') + '/reference/NOTES.html' : '')
  if (!page) {
    console.error('用法：node lib/cdp.js --selftest <页面 URL>')
    console.error('  或：DSH_WHALE_PACK=<课程包根> node lib/cdp.js --selftest   （用包内 reference/NOTES.html）')
    process.exit(2)
  }
  const outDir = path.join(os.tmpdir(), 'whale-cdp-selftest')
  fs.mkdirSync(outDir, { recursive: true })
  const failures = []
  const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

  console.log('浏览器：' + exe)
  console.log('页面　：' + page)

  const viewport = await capturePng({ exe, url: page, width: 1000, height: 600, budgetMs: 2500, outPng: path.join(outDir, 'viewport.png') })
  ok(viewport.size.width === 1000 && viewport.size.height === 600, `视口截图尺寸恰好 1000x600（实得 ${viewport.size.width}x${viewport.size.height}）`)
  ok(viewport.png.length > 5000, '视口截图不像白屏（' + viewport.png.length + ' 字节）')

  const full = await capturePng({ exe, url: page, width: 1000, height: 600, budgetMs: 2500, fullPage: true, outPng: path.join(outDir, 'full.png') })
  ok(full.size.height > 600, `整页截图高度 > 视口高度（${full.size.height} > 600）—— --screenshot 做不到这件事`)
  ok(full.size.height === full.contentSize.height, '整页高度与 getLayoutMetrics 的 contentSize 一致（' + full.contentSize.height + '）')
  ok(full.size.width === 1000, '整页宽度仍是请求的 1000（没被内容撑歪）')

  const crop = await capturePng({ exe, url: page, width: 1000, height: 600, budgetMs: 2500, clip: { x: 40, y: 300, width: 320, height: 180 }, outPng: path.join(outDir, 'crop.png') })
  ok(crop.size.width === 320 && crop.size.height === 180, `局部截图尺寸恰好 320x180（实得 ${crop.size.width}x${crop.size.height}）`)
  ok(crop.png.length > 500, '局部截图不是空图（' + crop.png.length + ' 字节）')

  console.log('\n截图落在：' + outDir)
  console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
  process.exit(failures.length ? 1 : 0)
}
