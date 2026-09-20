/**
 * visual.mjs —— 视觉检查（`whale_visual`）
 *
 * 判据分两层：
 *   A. **纯层**（离线、必跑）：PNG 头解析、尺寸/字节数判定、DOM 标记判定 —— 每条都配坏样本
 *   B. **真浏览器**（有服务就真跑）：起 Edge/Chrome headless 截一张真图 + 取真 DOM 并断言
 *      —— 服务没在跑时**大声跳过**（打印原因，不算通过也不算失败）；起了服务再跑就是绿的
 *
 * 判据里刻意不含"好不好看"：那部分仍然是人眼的事（见 lib/mods/visual.js 的边界说明）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isPng, pngSize, checkShot, checkFullShot, checkDom } from '../lib/visual.js'
import { findBrowser, probeBase } from '../lib/visual-io.js'
import { plugin as visualPlugin } from '../lib/mods/visual.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const LIVE_BASE = process.env.WHALE_VISUAL_BASE || 'http://127.0.0.1:3091'
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
const realBefore = sha(fs.readFileSync(path.join(ROOT, 'lessons', 'programming', 'spring-boot', '0001-spring-boot-hello-world.html')))

console.log(`\n[visual] 课程包：${ROOT}`)

// ── A. 纯层：PNG 1×1（内嵌 base64，不依赖任何文件） ──
const PNG1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)
ok(isPng(PNG1x1), 'PNG 签名识别正确')
ok(!isPng(Buffer.from('not a png')), '非 PNG 不被当成 PNG')
const dims = pngSize(PNG1x1)
ok(dims && dims.width === 1 && dims.height === 1, `从 IHDR 读出尺寸（${dims?.width}×${dims?.height}）`)
ok(pngSize(Buffer.from('GIF89a....')) === null, '非 PNG 返回 null（不硬解读出来的数字）')

const shotOk = checkShot({ buf: Buffer.concat([PNG1x1, Buffer.alloc(4096)]), w: 1, h: 1, minBytes: 1024 })
ok(shotOk.ok, `尺寸对 + 字节够 → 通过（${shotOk.why}）`)
const wrongSize = checkShot({ buf: PNG1x1, w: 1280, h: 820 })
ok(!wrongSize.ok && /尺寸不对/.test(wrongSize.why), `尺寸不对 → 拦下（${wrongSize.why}）`)
const tooSmall = checkShot({ buf: PNG1x1, w: 1, h: 1, minBytes: 2048 })
ok(!tooSmall.ok && /图太小/.test(tooSmall.why), `像白屏（字节太少）→ 拦下（${tooSmall.why}）`)
const empty = checkShot({ buf: null, w: 1, h: 1 })
ok(!empty.ok && /没有截到/.test(empty.why), '没截到 → 拦下')

// ── A. 纯层：整页判据（B2 新增；这是**整页截图**那件事的判据本身） ──
// 造两张"假整页"：一张宽高都对，一张还停在首屏高度（旧 --screenshot 的毛病）
const PNG1x1H = (() => { // 1×N：改 IHDR 里的高度字段即可，PNG 头之外不必是真图
  const b = Buffer.from(PNG1x1)
  b.writeUInt32BE(1200, 20)
  return Buffer.concat([b, Buffer.alloc(4096)])
})()
const fullOk = checkFullShot({ buf: PNG1x1H, w: 1, viewportH: 600 })
ok(fullOk.ok && /整页/.test(fullOk.why), `整页：高 > 视口高 → 通过（${fullOk.why}）`)
const stillFirstScreen = checkFullShot({ buf: PNG1x1H, w: 1, viewportH: 1200 })
ok(!stillFirstScreen.ok && /首屏/.test(stillFirstScreen.why), `整页：高没超过视口高 → 点名"还是首屏"（${stillFirstScreen.why}）`)
const fullWrongW = checkFullShot({ buf: PNG1x1H, w: 1000, viewportH: 600 })
ok(!fullWrongW.ok && /宽度不对/.test(fullWrongW.why), `整页：宽被内容撑歪 → 拦下（${fullWrongW.why}）`)
ok(!checkFullShot({ buf: null, w: 1, viewportH: 600 }).ok, '整页：没截到 → 拦下')

// ── A. 纯层：工具面真的把新能力露出去了（不依赖服务，永远跑） ──
{
  const tools = []
  visualPlugin.install({ paths: { packRoot: ROOT }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
  const t = tools.find((x) => x.name === 'whale_visual')
  const props = t?.parameters?.properties || {}
  ok(!!props.fullPage, '工具面露出 fullPage（整页截图）')
  ok(!!props.clip, '工具面露出 clip（局部截图）')
  ok(props.fullPage?.type === 'boolean' && props.clip?.type === 'string', `两者类型正确（fullPage=${props.fullPage?.type} / clip=${props.clip?.type}）`)
  ok(Array.isArray(props.kind?.enum) && props.kind.enum.includes('notes'), `kind 的枚举里有 notes（${(props.kind?.enum || []).join('/')}）`)
  ok(/整页/.test(t?.description || ''), '工具描述里写明了整页/局部（不靠猜）')
  // 坏参数必须在**探服务之前**就被拒（否则要先起服务才能验参数校验，等于没验）
  const both = await t.execute({ base: 'http://127.0.0.1:9', kind: 'starmap', root: ROOT, fullPage: true, clip: '0,0,10,10' })
  ok(both.ok === false && /只能给一个/.test(both.error), `fullPage 与 clip 同时给 → 明确拒绝（${String(both.error).slice(0, 30)}…）`)
  const badClip = await t.execute({ base: 'http://127.0.0.1:9', kind: 'starmap', root: ROOT, clip: 'a,b' })
  ok(badClip.ok === false && /x,y,w,h/.test(badClip.error), `clip 形状不对 → 明确拒绝（${String(badClip.error).slice(0, 30)}…）`)
}

// ── A. 纯层：DOM 标记 ──
ok(checkDom('<html><body><canvas id="c"></canvas></body></html>', 'starmap').ok, '星图：有 canvas 就算渲染出来了')
ok(checkDom('<html><body><div id="staticmap"><svg></svg></div></body></html>', 'starmap').ok, '星图：静态降级版（内联 SVG）也算')
ok(!checkDom('<html><body>空</body></html>', 'starmap').ok, '星图：什么都没有 → 判失败（不是"看不清就算过"）')
const lessonOk = checkDom('<html><head><title>第1课</title></head><body data-ask-page="lessons/0001.html"></body></html>', 'lesson')
ok(lessonOk.ok, `课程页：标题 + 答疑挂载点都在 → 通过（${lessonOk.why}）`)
const lessonBad = checkDom('<html><head><title>第1课</title></head><body></body></html>', 'lesson')
ok(!lessonBad.ok && /ask-page/.test(lessonBad.why), `课程页：缺答疑挂载点 → 点名缺哪个（${lessonBad.why}）`)
ok(!checkDom('<html></html>', '魔法').ok, '不认识的 kind 明确报错')

// ── A. 纯层：笔记文档页（kind='notes'，2026-09-24 补的尾巴） ──
const notesGood = checkDom('<html><head><title>DSH 笔记</title></head><body data-notes-page="all"><form data-note-form data-note-lesson="第1课"></form></body></html>', 'notes')
ok(notesGood.ok, `笔记页：自报身份 + 标题 + 表单都在 → 通过（${notesGood.why}）`)
const notesNoForm = checkDom('<html><head><title>DSH 笔记</title></head><body data-notes-page="all"></body></html>', 'notes')
ok(!notesNoForm.ok && /note-form/.test(notesNoForm.why), `笔记页：缺笔记表单 → 点名缺哪个（${notesNoForm.why}）—— 那页就只剩只读文档了`)
ok(!checkDom('<html><body>空</body></html>', 'notes').ok, '笔记页：什么都没有 → 判失败')

// ── A. 纯层：浏览器探测 ──
const exe = findBrowser()
ok(exe === null || fs.existsSync(exe), `findBrowser 要么给一个真实存在的路径、要么明确 null（${exe ? path.basename(exe) : 'null'}）`)

// ── B. 真浏览器（有服务才跑；没服务大声跳过） ──
const probe = await probeBase(LIVE_BASE, '/starmap/')
if (!exe) {
  console.log(`⚠️  跳过真浏览器那一层：本机找不到 Edge/Chrome`)
} else if (!probe.ok) {
  console.log(`⚠️  跳过真浏览器那一层：${LIVE_BASE} 连不上（${probe.why}）—— 起了服务再跑就是绿的：node tools/app-server.js`)
} else {
  const tools = []
  visualPlugin.install({ paths: { packRoot: ROOT }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
  const tool = tools.find((t) => t.name === 'whale_visual')
  const v = await tool.execute({ base: LIVE_BASE, kind: 'starmap', sizes: '560x800', root: ROOT })
  ok(v.ok === true, `真跑一遍：${v.summary}`)
  for (const l of v.lines || []) console.log('     ' + l)
  const png = (v.results || []).find((r) => r.size === '560x800')
  ok(!!png && png.bytes > 2048, `截出来的 PNG 有内容（${png?.bytes} 字节）`)
  ok(fs.existsSync(png.out), `截图落盘，可供人眼看：${png.out}`)
  // B2：整页截图 —— 判据是"高 > 视口高"，这正是旧 `--screenshot` 做不到的那件事
  const full = await tool.execute({ base: LIVE_BASE, kind: 'lesson', sizes: '1000x600', root: ROOT, fullPage: true })
  ok(full.ok === true, `真跑一遍整页（课程页）：${full.summary}`)
  const fr = (full.results || []).find((r) => r.size === '1000x600')
  ok(!!fr && fr.ok && /整页/.test(fr.why), `整页真的比首屏长：${fr?.why}`)
  // kind='notes'：笔记文档页也走一遍（判据含"笔记表单在不在"）
  const nb = await tool.execute({ base: LIVE_BASE, kind: 'notes', sizes: '1280x820', root: ROOT })
  ok(nb.ok === true, `真跑一遍笔记页：${nb.summary}`)
  const nd = (nb.results || []).find((r) => r.size === 'dom')
  ok(!!nd && nd.ok && /notes-page/.test(nd.why), `笔记页 DOM 判据命中（${nd?.why}）`)
  // 服务没在跑时的报错要能指路（对着一个必然连不上的端口试）
  const bad = await tool.execute({ base: 'http://127.0.0.1:9', kind: 'starmap', root: ROOT })
  ok(bad.ok === false && /app-server\.js/.test(bad.error), `服务没在跑 → 明确报错并指路（${String(bad.error).slice(0, 46)}…）`)
}

ok(sha(fs.readFileSync(path.join(ROOT, 'lessons', 'programming', 'spring-boot', '0001-spring-boot-hello-world.html'))) === realBefore, '真包未被改动（课程页哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 视觉检查：纯层判据齐全（含坏样本）；真浏览器那层跑过就是绿的')
