#!/usr/bin/env node
/**
 * mirror-parity.mjs —— **镜像对拍**：课程包侧与插件侧，每一对"同源实现"都要有判据
 * ------------------------------------------------------------------
 * 为什么单独一套：架构上选了**甲方案**（包侧 `tools/` 保持"能脱离插件独立跑"的引擎）。
 * 那意味着同一件事会有**两份实现**（插件侧的搬运版 + 包侧原版），而甲方案唯一能成立的
 * 前提就是：**每一对都有对拍**。没有对拍的两份实现 = 迟早漂移的两份事实。
 *
 * 本套覆盖（其余对拍已在别处，见 lib/pack-model.js 的 --selftest 与 render-parity）：
 *   ① 文本助手：`lib/text.js` ↔ 包侧 `tools/pack-text.js`（同一批输入 → 同一批输出）
 *   ② **两个写入口、同一本台账**：包侧 `tools/ask-server.js` 的 `POST /note`
 *      与插件 `lib/notes-io.js` 的 `appendNote` —— 它们共用 `notes/notes.jsonl` 与 `notes/seq.txt`，
 *      所以记录必须**同形**、编号必须**同一计数器**、锚点必须**同样归一**。
 *      （除了这一套，别处只有"各自静态钉子"；本套是真跑两遍再比。）
 *   ②b **两个写入口、同一本 `questions/pending.jsonl`**（学生答疑台账）：包侧 `POST /ask`
 *      与插件 `lib/ask-io.js` 的 `handleAsk` —— 记录形状 / 序号宽度 / 行尾一漂，
 *      `drain-questions.js` 与 `assets/build-questions.js` 就解析坏账（坏的是真学生答疑数据）。
 *   ③ **内容指纹算法**：`lib/fingerprint.js` ↔ 包侧 `tools/fingerprint.js`（+ 模板逐字副本）——
 *      点亮换钉子的新鲜度判据。两侧一漂 = 永远 `stale-snapshot` = 点亮全废（R13），
 *      所以除了逐案例相等，还自带**反空转**（多文件 / 改字节 / 换行编码 → 指纹必变且两边仍相等）。
 *      ③b 另比 **PROBE_VERSION**（探针版本，快照新鲜度的第一把尺子）：三份逐字同值。
 *   ④ **星图载荷契约**：`lib/pack-scaffold.js`（建包时写的空星图骨架）↔ 包侧 `tools/build-starmap.js`
 *      （星图数据生成器）+ **随包模板副本**（`lib/pack-template/tools/build-starmap.js` 等 4 件）——
 *      同一个 `window.STARMAP_REAL` 契约：键序一致、空包**纯空**（0 圈，不许塞默认圈当地基）、
 *      建第一个圈后重建圈出现在载荷与页面里，且模板副本与包侧原件**同输入 → 逐字节同产出**。
 *   ⑦ **课次锚点（F 条）**：`lib/pack-model.js` ↔ 包侧 `tools/lesson-map.js` 的 `labelAnchorId`，
 *      外加**产物往返一致**（课程页 fragment ↔ NOTES.html 的 id）—— id 不许含空白（HTML 规范），
 *      fragment 必须 percent-encode 过，且 `decode(fragment) === id`。
 *
 * 判据自带**反空转**：两条记录必须真的来自两个不同写入者（text 不同、id 递进），
 * 否则"同形"是白得的。
 *
 * 零副作用：全程在临时副本里跑，真包一个字节都不动。跑：node test/mirror-parity.mjs [课程包根]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripBom, splitLines } from '../lib/text.js'
import { digestTree, PROBE_VERSION } from '../lib/fingerprint.js'
import { appendNote } from '../lib/notes-io.js'
import { plugin as noteRoutePlugin } from '../lib/mods/note.js'   // 只为取插件路由的 HTTP 状态码
import { handleAsk } from '../lib/ask-io.js'
import { writeScaffold } from '../lib/pack-scaffold.js'
import { validatePlan, planFrontier } from '../lib/plan.js'
import { labelAnchorId } from '../lib/pack-model.js'
import { packRoot, PLUGIN } from './_pack.mjs'

const ROOT = packRoot()
const require_ = createRequire(import.meta.url)

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }

console.log(`\n[mirror] 课程包：${ROOT}`)

/* ── ① 文本助手：插件侧 lib/text.js ↔ 包侧 tools/pack-text.js ────────────── */
{
  const packText = require_(path.join(ROOT, 'tools', 'pack-text.js'))
  const cases = [
    ['\uFEFFx', 'startsWith BOM'],
    ['\uFEFFline1\n\uFEFFline2', 'BOM 落在**中间某一行**（PowerShell 追加的典型形态）'],
    ['a\nb\nc', '没有 BOM'],
    ['', '空串'],
  ]
  let same = 0
  for (const [input] of cases) {
    const a = JSON.stringify([stripBom(input), splitLines(input)])
    const b = JSON.stringify([packText.stripBom(input), packText.splitLines(input)])
    if (a === b) same++
    else console.log(`     ✗ 输入 ${JSON.stringify(input)}：插件 ${a} / 包侧 ${b}`)
  }
  ok(same === cases.length, `文本助手两边逐案例一致（${same}/${cases.length}：BOM 在开头 / 在中间某行 / 无 BOM / 空串）`)
  ok(splitLines('\uFEFFline1\n\uFEFFline2').join('|') === 'line1|line2', '逐行剥 BOM 的语义两边都成立（中间那行的 BOM 真的被剥掉）')
}

/* ── ② 两个写入口、同一本台账：真跑两遍再比 ─────────────────────────────── */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const waitUp = async (port, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mirror-'))
let child = null
try {
  // 只拷需要的：tools（两个写入口的包侧实现）/ lessons + code（课次映射表要它）/ notes（台账）
  for (const d of ['tools', 'lessons', 'code', 'notes']) {
    fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true })
  }
  const NOTES_JSONL = path.join(tmp, 'notes', 'notes.jsonl')
  const SEQ = path.join(tmp, 'notes', 'seq.txt')
  const readLines = () => (fs.existsSync(NOTES_JSONL) ? fs.readFileSync(NOTES_JSONL, 'utf8').trim().split('\n').filter(Boolean) : [])

  // 台账置空（真包那份不动）
  fs.writeFileSync(NOTES_JSONL, '', 'utf8')
  fs.writeFileSync(SEQ, '0\n', 'utf8')

  // ── 写入者 A：包侧真服务器（stdio:'ignore' —— 不碰管道，也就没有 EPERM/缓冲的坑）
  const port = await freePort()
  child = spawn(process.execPath, [path.join(tmp, 'tools', 'ask-server.js'), '--port', String(port)], { stdio: 'ignore' })
  const up = await waitUp(port)
  ok(up, `包侧 ask-server 在临时副本里起来了（端口 ${port}）`)
  if (up) {
    const res = await fetch(`http://127.0.0.1:${port}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'MIRROR-PROBE-A（包侧写）', anchor: '第1课' }),   // 故意给**显示名**
    })
    const body = await res.json()
    ok(res.status === 200 && body.ok === true && body.id === '0001', `包侧 POST /note → ${res.status} { id:"${body.id}", seq:${body.seq} }`)
  }

  // ── 写入者 B：插件 appendNote（同一副本、同一台账）
  const r = appendNote({ root: tmp, text: 'MIRROR-PROBE-B（插件写）', anchor: 'spring-boot/0001' })   // 故意给**键**
  ok(r.ok === true && r.id === '0002', `插件 appendNote → { id:"${r.id}", seq:${r.seq} }（接着包侧那条往下排）`)

  const lines = readLines()
  ok(lines.length === 2, `台账里恰好两条（${lines.length}）`)
  if (lines.length === 2) {
    let a = null
    let b = null
    try { a = JSON.parse(lines[0]); b = JSON.parse(lines[1]) } catch { /* 下面会报 */ }
    ok(!!a && !!b, '两条都是合法 JSON')

    if (a && b) {
      // 反空转：必须真的来自两个写入者
      ok(a.text.includes('包侧') && b.text.includes('插件'), `两条确实来自两个不同写入者（${a.text} / ${b.text}）—— 否则"同形"是白得的`)
      // 同形：键集与键序
      const ka = Object.keys(a).join(',')
      const kb = Object.keys(b).join(',')
      ok(ka === kb, `记录**键序**一致（包侧 ${ka} ／ 插件 ${kb}）`)
      ok(ka === 'id,seq,kind,anchor,text', `键序就是约定值（${ka}）`)
      // 都归一成星图课次键（一个给显示名、一个给键，落盘必须同一个）
      ok(a.anchor === 'spring-boot/0001' && b.anchor === 'spring-boot/0001', `锚点都归一成星图课次键（包侧给「第1课」→ ${a.anchor}；插件给键 → ${b.anchor}）`)
      // 同一计数器、4 位同宽
      ok(a.id === '0001' && b.id === '0002' && a.seq === 1 && b.seq === 2, `编号同一计数器、4 位同宽（${a.id}/${a.seq} → ${b.id}/${b.seq}）`)
      // 都不许有时间戳（有时间戳 → --check 的逐字节对拍就废了）
      ok(!('at' in a) && !('at' in b), '两条都不含时间戳字段（确定性）')
    }
  }
  const seqText = fs.readFileSync(SEQ, 'utf8')
  ok(seqText.trim() === '2', `notes/seq.txt 是**一个**计数器、终值 2（实得 ${JSON.stringify(seqText)}）`)

  // ── 超限笔记：两个写入口必须**同判**（同收或同拒 + 同口径的拒法）──────────────
  // 为什么要有这条：包侧 `/note` 一直有 16KB 闸，插件 `notes-io.appendNote` 曾经**一条大小
  // 判断都没有** ⇒ 同一本 notes/notes.jsonl 两个入口一个收一个拒。阈值 / 单位 / 状态码 /
  // 拒法四样都对齐才算同判。样本取中文（一字 3 字节）：8000 字 = 24000 字节超限，**字符数
  // 8000 却没超** ⇒ 单位改回字符数，两侧都会放行、这里就红。
  // 「同收」的那一半就是上面 A、B 两条正常笔记：两侧都收下了 —— 同判 = 同收 + 同拒。
  {
    const OVER = '超'.repeat(8000)
    ok(Buffer.byteLength(OVER, 'utf8') > 16 * 1024 && OVER.length < 16 * 1024,
      '超限样本按**字节**超、按字符没超（夹具自检：单位改回字符数 ⇒ 两侧都会放行）')
    const res = await fetch(`http://127.0.0.1:${port}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: OVER, anchor: '第1课' }),
    })
    const jb = await res.json()

    // 插件侧的**状态码**住在路由层（appendNote 只负责抛）—— 真起插件路由拿它的 HTTP 码来比，
    // 不能拿"抛了"当"413"糊过去。路由是薄壳：走到 catch 就回，不会触发产物重建。
    const cap = []
    noteRoutePlugin.install({
      log: { info: () => {}, warn: () => {}, error: () => {} },
      paths: { packRoot: tmp },
      registerTool: () => {},
      inject: (names, cb) => { if (names.includes('connection')) cb({ get: () => ({ fetch: { register: (r) => cap.push(r) } }) }) },
    })
    const noteFetch = cap[0].fetch
    const pres = await noteFetch(new Request('http://127.0.0.1:3090/api/whale/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: OVER, anchor: '第1课' }),
    }))
    const pbody = await pres.json()

    let threw = ''
    try { appendNote({ root: tmp, text: OVER, anchor: 'spring-boot/0001' }) } catch (e) { threw = e.message }
    ok(res.status === 413 && jb.ok === false, `包侧超限笔记 → 413 + ok:false（实得 ${res.status}）`)
    ok(pres.status === 413 && pbody.ok === false, `插件路由超限笔记 → ${pres.status} + ok:false（实得 ${pres.status}/${pbody.ok}）`)
    ok(res.status === pres.status,
      `两侧**状态码**相同：同一份超限笔记，包侧 ${res.status} ／ 插件路由 ${pres.status}`)
    ok(threw.length > 0, `插件侧 appendNote 当场抛出、不写盘（实得 ${JSON.stringify(threw)}）`)
    ok(jb.error === pbody.error && pbody.error === threw,
      `两侧**同口径的拒法**：文案逐字相同（包侧 ${JSON.stringify(jb.error)} ／ 插件 ${JSON.stringify(pbody.error)}）`)
    ok(readLines().length === 2 && fs.readFileSync(SEQ, 'utf8').trim() === '2',
      `两侧都**写前拒**：台账一条没多、计数器没动（实得 ${readLines().length} 条 / seq ${JSON.stringify(fs.readFileSync(SEQ, 'utf8'))}）`)
  }

  // ── 已知差异登记（照 test/judge-parity.mjs 的 EXEMPT 做法）：**双方实况**一起钉住 ──
  // 这不是漂移，是两层职责本身决定的：包侧测**请求体**字节（传输层守卫，还没解析完就得先把
  // 请求体挡住），插件侧测**正文**字节（内容层守卫）⇒ 16KB 顶端两者约差 35 字节（JSON 外壳开销）。
  // 2026-09-25 裁定**不追平**：抹平要动 `lib/mods/note.js` 的入参形状按 `raw` 判，收益（35 字节
  // 的边界）远小于风险。下面这条样本正好落在那条灰带里，**同时**断言两侧各自的实况 ——
  // 包侧改判正文、或插件改判请求体，哪一边变了这节就红，逼人重新裁定（而不是让它烂成漂移）。
  {
    const EDGE = '边'.repeat(5461)                 // 正文 16383 字节（<16KB）／ 请求体 16413 字节（>16KB）
    const payload = { text: EDGE, anchor: '第1课' }
    ok(Buffer.byteLength(EDGE, 'utf8') < 16 * 1024 && Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16 * 1024,
      '灰带样本夹具自检：正文在 16KB 内、请求体在 16KB 外（这就是那条已知差异）')
    const res = await fetch(`http://127.0.0.1:${port}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const jb = await res.json()
    let r = null
    let threwE = ''
    try { r = appendNote({ root: tmp, text: EDGE, anchor: '第1课' }) } catch (e) { threwE = e.message }
    ok(res.status === 413 && jb.ok === false,
      `包侧实况＝按**请求体**判 → 413（正文没超也拒；实得 ${res.status}）`)
    ok(!!r && r.ok === true && r.id === '0003',
      `插件侧实况＝按**正文**判 → 收下（正文没超；实得 ${r ? r.ok + '/' + r.id : '抛出 ' + threwE}）`)
    ok(readLines().length === 3,
      `两侧判据确实不是同一个量：同一份笔记一边拒一边收（台账 ${readLines().length} 条）—— 两边收敛了就删这一节`)
  }
} finally {
  if (child && !child.killed) { try { child.kill() } catch { /* 已退 */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
}

/* ── ②b 两个写入口、同一本 **questions/pending.jsonl**（学生答疑台账）：真跑两遍再比 ──
 * 与 ② 同一条纪律，对象换成**答疑数据**：包侧 `tools/ask-server.js` 的 `POST /ask`
 * 与插件 `lib/ask-io.js` 的 `handleAsk` 共用 `questions/pending.jsonl` + `questions/seq.txt`。
 * 形状 / 序号宽度 / 行尾一漂，`drain-questions.js` 与 `assets/build-questions.js` 就解析坏账 ——
 * 坏的是**真学生答疑数据**，所以每条判据都必须能被造假触发（不是"能读盘"）：
 *   · 掩掉 id / at / question 的值之后两条记录**逐字节相同**（键序、转义、其余字段全在内）
 *   · 键序就是约定值；id 四位零填充、同一计数器递进；seq.txt 每次写后的**原始字节**钉死
 *   · at 两侧各自验 ISO-8601 UTC 毫秒（值不比 —— 两次写的时刻天然不同）
 *   · question 逐字往返（换行 / 引号 / 反斜杠 / emoji 一个不丢）+ 超长截断宽度两侧一致（4000）
 *   · 行尾 LF、文件以 \n 结尾、零 \r（坏行尾正是"粘连行/半行"坏账的头号来源）
 * 零副作用：全程在临时副本里跑，真包一个字节都不动。 */
{
  const mkBody = (mark, question) => ({
    question: mark + question,
    lesson: 'spring-boot/0001',
    page: 'lessons/programming/spring-boot/0001-spring-boot-hello-world.html',
    title: '第1课',
  })
  const TRICKY = '：为什么 @RestController 能直接返回 JSON？\n第二行 "引号" \\反斜杠 😀 结尾'
  const maskQ = (line) => String(line)
    .replace(/"id":"[^"]*"/, '"id":"<ID>"')
    .replace(/"at":"[^"]*"/, '"at":"<AT>"')
    .replace(/"question":"(?:[^"\\]|\\.)*"/, '"question":"<Q>"')
  const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

  const tmpQ = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mirror-q-'))
  let childQ = null
  try {
    // 只拷需要的：tools（包侧写入口）/ lessons + code（课次映射表要它）
    for (const d of ['tools', 'lessons', 'code']) {
      fs.cpSync(path.join(ROOT, d), path.join(tmpQ, d), { recursive: true })
    }
    const QDIR = path.join(tmpQ, 'questions')
    const PENDING = path.join(QDIR, 'pending.jsonl')
    const SEQ = path.join(QDIR, 'seq.txt')
    fs.mkdirSync(QDIR, { recursive: true })
    fs.writeFileSync(SEQ, '0\n', 'utf8')   // 与 ② 一样：计数器已有初值（不从空文件起步）
    const seqRaw = () => fs.readFileSync(SEQ, 'utf8')

    // ── 写入者 A：包侧真服务器（stdio:'ignore' —— 不碰管道，也就没有 EPERM/缓冲的坑）
    const port = await freePort()
    childQ = spawn(process.execPath, [path.join(tmpQ, 'tools', 'ask-server.js'), '--port', String(port)], { stdio: 'ignore' })
    const upQ = await waitUp(port)
    ok(upQ, `包侧 ask-server 在临时副本里起来了（端口 ${port}）`)
    const postPack = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }
    const rA1 = upQ ? await postPack(mkBody('MIRROR-ASK 包侧写', TRICKY)) : { status: 0, body: {} }
    ok(rA1.status === 200 && rA1.body.ok === true && rA1.body.id === '0001', `包侧 POST /ask → ${rA1.status} { ok:${rA1.body.ok}, id:"${rA1.body.id}" }`)
    ok(seqRaw() === '1', `包侧写完 seq.txt 的**原始字节** = "1"（不补零、不带换行；实得 ${JSON.stringify(seqRaw())}）`)

    // ── 写入者 B：插件 handleAsk（同一副本、同一台账、同一计数器）
    const rB1 = await handleAsk(tmpQ, { raw: JSON.stringify(mkBody('MIRROR-ASK 插件写', TRICKY)) })
    ok(rB1.status === 200 && rB1.body.ok === true && rB1.body.id === '0002',
      `插件 handleAsk → ${rB1.status} { ok:${rB1.body.ok}, id:"${rB1.body.id}" }（接着包侧那条往下排 —— 同一计数器）`)
    ok(seqRaw() === '2', `插件写完 seq.txt 的原始字节 = "2"（实得 ${JSON.stringify(seqRaw())}）`)

    // ── 截断宽度对：同一根 5000 字长问题，两个入口都必须截到 4000
    const LONG = '问'.repeat(5000)
    const rA2 = upQ ? await postPack(mkBody('A2', LONG)) : { status: 0, body: {} }
    const rB2 = await handleAsk(tmpQ, { raw: JSON.stringify(mkBody('B2', LONG)) })
    ok(rA2.body.id === '0003' && rB2.body.id === '0004', `长问题一对接着排号（包侧 ${rA2.body.id} / 插件 ${rB2.body.id}）`)
    ok(seqRaw() === '4', `四条后排到 4（实得 ${JSON.stringify(seqRaw())}）`)

    const raw = fs.readFileSync(PENDING, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    ok(lines.length === 4, `台账里恰好四条（${lines.length}）—— A、B 各两条，写进的是**同一本** pending.jsonl`)
    ok(raw.endsWith('\n') && !raw.includes('\r'), '行尾 = LF、文件以 \\n 结尾、零 \\r')
    const parsed = lines.map((l) => { try { return JSON.parse(l) } catch { return null } })
    ok(parsed.every(Boolean), '四条都是合法 JSON（没有粘连行 / 半行）')

    if (parsed.every(Boolean)) {
      // 反空转：两条必须真的来自两个不同写入者，否则"同形"是白得的
      ok(parsed[0].question.includes('包侧写') && parsed[1].question.includes('插件写'),
        `两条确实来自两个不同写入者（${JSON.stringify(parsed[0].question.slice(0, 12))} / ${JSON.stringify(parsed[1].question.slice(0, 12))}）`)
      // 同形：键集与键序
      const k0 = Object.keys(parsed[0]).join(',')
      const k1 = Object.keys(parsed[1]).join(',')
      ok(k0 === k1, `记录**键序**一致（包侧 ${k0} ／ 插件 ${k1}）`)
      ok(k0 === 'id,at,lesson,page,title,question,status', `键序就是约定值（${k0}）`)
      // 掩掉 id / at / question 的值后逐字节同（键序、转义风格、其余字段值全在内）
      ok(maskQ(lines[0]) === maskQ(lines[1]), '第一对：掩掉 id/at/question 的值后两条记录**逐字节相同**')
      if (maskQ(lines[0]) !== maskQ(lines[1])) {
        console.log('     A: ' + maskQ(lines[0]))
        console.log('     B: ' + maskQ(lines[1]))
      }
      ok(maskQ(lines[2]) === maskQ(lines[3]), '第二对（长问题）：掩码后同样逐字节相同')
      // at：两侧各自验格式（值不比 —— 两次写的时刻天然不同）
      ok(parsed.every((p) => ISO_AT.test(p.at)), `四条 at 全是 ISO-8601 UTC 毫秒（如 ${parsed[0].at}）`)
      // 其余字段同值 + question 逐字往返（转义对称）
      ok(parsed[0].lesson === parsed[1].lesson && parsed[0].page === parsed[1].page && parsed[0].title === parsed[1].title
        && parsed[0].status === parsed[1].status && parsed[1].status === 'pending',
        'lesson/page/title/status 两侧同值（同一份请求体的两个写入口）')
      ok(parsed[0].question === 'MIRROR-ASK 包侧写' + TRICKY && parsed[1].question === 'MIRROR-ASK 插件写' + TRICKY,
        'question 逐字往返：换行 / 引号 / 反斜杠 / emoji 一个不丢')
      ok(parsed[2].question.length === 4000 && parsed[3].question.length === 4000,
        `超长 question 两侧都截到 4000（包侧 ${parsed[2].question.length} / 插件 ${parsed[3].question.length}）`)
      // 编号：同一计数器、4 位同宽
      ok(parsed.map((p) => p.id).join(',') === '0001,0002,0003,0004',
        `编号同一计数器、4 位零填充（${parsed.map((p) => p.id).join(',')}）`)
    }

    // ── 判据①（2026-09-25 裁定）：超长中文问题 → 两侧都拒、都不写账
    // 闸门必须**同口径按字节**：约 18KB 的中文按字符数只有 6000，旧包侧会放行而插件拒 ——
    // 同一个问题两个写入口一个收一个拒，收下的那条就带着别人拒掉的长度落进同一本账。
    const OVER = { question: '很'.repeat(6000) }
    const rA3 = upQ ? await postPack(OVER) : { status: 0, body: {} }
    const rB3 = await handleAsk(tmpQ, { raw: JSON.stringify(OVER) })
    ok(rA3.status >= 400 && rA3.status < 500 && rA3.body.ok === false,
      `超长中文（约 18KB）包侧拒（${rA3.status} ${rA3.body.error || ''}）—— 闸门按**字节**算，与插件同口径`)
    ok(rB3.status === 413 && rB3.body.ok === false, `超长中文插件拒（${rB3.status} ${rB3.body.error || ''}）`)
    ok(fs.readFileSync(PENDING, 'utf8') === raw && seqRaw() === '4',
      '两侧拒收之后：台账与序号**一动不动**（都不写账、不空跳号）')

    // ── 判据②（2026-09-25 裁定）：台账被外部写坏（末尾缺 \n）→ 追加后每行仍可 JSON.parse
    // 直接 append 会把新记录与上一行**粘连成一行坏 JSON**（包侧旧写法就这样），
    // 坏的是真学生答疑数据 —— 所以两侧各自都要先补 \n 再追加（插件 appendPending 同款）。
    // 两侧各打一次**独立的坏台账**：拿掉任何一侧的补换行，它那半边就必红。
    const corruptTail = () => fs.writeFileSync(PENDING, fs.readFileSync(PENDING, 'utf8').replace(/\n$/, ''), 'utf8')
    const parseable = (label, wantLines) => {
      const ls = fs.readFileSync(PENDING, 'utf8').split('\n').filter((l) => l.trim())
      const bad = []
      ls.forEach((l, i) => { try { JSON.parse(l) } catch { bad.push(i + 1) } })
      ok(bad.length === 0 && ls.length === wantLines && fs.readFileSync(PENDING, 'utf8').endsWith('\n'),
        `坏台账（末尾缺 \\n）经${label}追加后 ${ls.length}/${wantLines} 行**全部**可 JSON.parse、文件回到 \\n 结尾（粘连坏行：${bad.length ? '第 ' + bad.join(',') + ' 行' : '无'}）`)
    }
    corruptTail()
    const rA4 = upQ ? await postPack(mkBody('A4', '：缺尾换行后的包侧追加')) : { status: 0, body: {} }
    ok(rA4.body.id === '0005', `坏台账上包侧接着排号（${rA4.body.id}）`)
    parseable('包侧', 5)
    corruptTail()
    const rB4 = await handleAsk(tmpQ, { raw: JSON.stringify(mkBody('B4', '：缺尾换行后的插件追加')) })
    ok(rB4.body.id === '0006', `坏台账上插件接着排号（${rB4.body.id}）`)
    parseable('插件', 6)
    ok(seqRaw() === '6', `坏台账不影响计数器：两条之后 seq.txt 原始字节 = "6"（实得 ${JSON.stringify(seqRaw())}）`)
  } finally {
    if (childQ && !childQ.killed) { try { childQ.kill() } catch { /* 已退 */ } }
    fs.rmSync(tmpQ, { recursive: true, force: true })
  }
}

/* ── ③ 内容指纹：lib/fingerprint.js ↔ 包侧 tools/fingerprint.js（算法逐字同源）── */
{
  const packFp = require_(path.join(ROOT, 'tools', 'fingerprint.js'))
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-fp-'))
  try {
    // fixture：多层目录 + 中文文件名 + CRLF 文件 + 被排除的目录（清单必须两侧一致）
    fs.mkdirSync(path.join(fx, 'src', 'main'), { recursive: true })
    fs.writeFileSync(path.join(fx, 'pom.xml'), '<project/>\n', 'utf8')
    fs.writeFileSync(path.join(fx, 'src', 'main', '甲.java'), 'class A {}\n', 'utf8')
    fs.writeFileSync(path.join(fx, 'src', 'main', 'B.java'), 'class B {}\r\n', 'utf8')
    fs.mkdirSync(path.join(fx, 'target'), { recursive: true })
    fs.writeFileSync(path.join(fx, 'target', '噪音.txt'), '构建产物不进指纹\n', 'utf8')

    const both = () => [digestTree(fx), packFp.digestTree(fx)]
    const [a0, b0] = both()
    ok(a0 === b0, `指纹两边逐字相同（${a0.slice(0, 20)}…）`)
    ok(/^sha256:[0-9a-f]{64}$/.test(a0), '指纹形状 = sha256:<64 位十六进制>')
    ok(digestTree(fx) === a0, '同输入再算一遍：同指纹（确定性）')

    // 排除清单生效：target/ 里的变化不进指纹（与 walkFiles 同一份 SKIP_DIR）
    fs.writeFileSync(path.join(fx, 'target', '又一个.txt'), 'x', 'utf8')
    ok(both().every((x) => x === a0), '排除目录（target/）里的增改不进指纹（清单两侧一致才做得到）')

    // 反空转：多一个文件 / 改一个字节 / 换行编码变化 → 两边指纹**都变且仍相等**
    fs.writeFileSync(path.join(fx, 'src', 'main', 'C.java'), 'class C {}\n', 'utf8')
    const [a1, b1] = both()
    ok(a1 !== a0 && a1 === b1, '反空转①：多一个文件 → 指纹必变，且两边仍相等')
    fs.writeFileSync(path.join(fx, 'src', 'main', 'B.java'), 'class B { }\r\n', 'utf8')
    const [a2, b2] = both()
    ok(a2 !== a1 && a2 === b2, '反空转②：改一个字节 → 指纹必变，且两边仍相等')
    fs.writeFileSync(path.join(fx, 'src', 'main', 'B.java'), 'class B { }\n', 'utf8')
    const [a3, b3] = both()
    ok(a3 !== a2 && a3 === b3, '反空转③：换行编码变化（CRLF→LF）→ 指纹必变，且两边仍相等')

    // BOM 归一（算法里唯一的例外）：BOM 不是内容（bom-tolerance 同一纪律）
    fs.writeFileSync(path.join(fx, 'src', 'main', 'B.java'), '\uFEFFclass B { }\n', 'utf8')
    const [a4, b4] = both()
    ok(a4 === a3 && a4 === b4, 'BOM 归一：带 BOM 与不带 BOM 同指纹（PowerShell 噪音不算内容变化）')

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-fp-empty-'))
    try {
      ok(digestTree(emptyDir) === packFp.digestTree(emptyDir), '空目录边界：两边同指纹')
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(fx, { recursive: true, force: true })
  }
}

/* ── ③b PROBE_VERSION（探针版本）：三份 fingerprint.js 逐字同值 ──────────────
   它是快照新鲜度的**第一把尺子**（插件 gate.js 的 judgeSnapshot / 包侧 ask-server.js 的
   judgeLightup 都先比它、再比 sourceDigest）。三份一漂 = 插件判「探针过期」而包侧判「新鲜」
   （或反过来）—— 同一份快照两个答案，与 ③ 同一条纪律。比**两样**：导出值 + 源码里的
   字面量（值相同 ≠ 写法相同；字面量是设计要求 —— 运行时不许读自身源码来算）。
   ⚠️ 模板副本只比**字面量 + 与包侧逐字节同一份**，不 require 它：它内容是 CJS、却住在插件的
   ESM 包作用域下（package.json type:module），运行期 require 会被当 ESM 加载而炸 ——
   "模板 ≡ 包侧逐字节"这条不变量另有 test/pack-scaffold.mjs 的 FROM_PACK 逐文件核钉住。 */
{
  const packPath = path.join(ROOT, 'tools', 'fingerprint.js')
  const tplPath = path.join(PLUGIN, 'lib', 'pack-template', 'tools', 'fingerprint.js')
  const plugPath = path.join(PLUGIN, 'lib', 'fingerprint.js')
  const packFp = require_(packPath)
  const lit = (p) => {
    const m = /PROBE_VERSION\s*=\s*'([^']*)'/.exec(fs.readFileSync(p, 'utf8'))
    return m ? m[1] : null
  }
  ok(packFp.PROBE_VERSION === PROBE_VERSION, `包侧导出值与插件逐字相同（${packFp.PROBE_VERSION}）`)
  const plugLit = lit(plugPath)
  const packLit = lit(packPath)
  const tplLit = lit(tplPath)
  ok(plugLit === PROBE_VERSION && packLit === PROBE_VERSION && tplLit === PROBE_VERSION,
    `三份源码里的 PROBE_VERSION **字面量**逐字相同（插件 ${plugLit} / 包 ${packLit} / 模板 ${tplLit}）`)
  ok(fs.readFileSync(tplPath, 'utf8') === fs.readFileSync(packPath, 'utf8'),
    '模板副本与包侧 fingerprint.js **逐字节同一份**（PROBE_VERSION 不会只改一边）')
}

/* ── ④ 星图载荷契约：空骨架（lib/pack-scaffold.js）↔ 生成器（包侧 tools/build-starmap.js）
   （+ **随包模板副本**的行为对拍）──────────────────────────────────────────
   两处都在"写出 window.STARMAP_REAL"：建包时的空星图骨架 vs tools/build-starmap.js 的载荷。
   生成器加字段而骨架没跟上 = 空包的星图形状与有内容的包静默漂；模板副本与原件一漂 =
   新包重建出来的星图与课程包不一致。全程在临时包上跑（stdio:'ignore'，不碰管道），
   真包一个字节都不动。 */
{
  const run = (dir) => spawnSync(process.execPath, ['tools/build-starmap.js'], { cwd: dir, stdio: 'ignore' })
  const readPayload = (dir) => {
    const win = {}
    new Function('window', fs.readFileSync(path.join(dir, 'starmap', 'content.js'), 'utf8'))(win)
    return win.STARMAP_REAL
  }
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-star-'))
  try {
    const A = path.join(fx, 'a')   // 随包模板副本（从模板长出来的新包真正会跑的那套）
    const B = path.join(fx, 'b')   // 课程包原件（行为基准）
    fs.mkdirSync(A); fs.mkdirSync(B)
    ok(writeScaffold(A).ok === true && writeScaffold(B).ok === true, '临时建包 ×2（A=模板副本引擎 / B=包侧原件引擎）')

    // ① 建包时就有空星图，而且是**纯空**
    const empty = readPayload(A)
    ok(empty.halos.length === 0 && empty.lessons.length === 0, '空包的星图 = 纯空（0 圈 / 0 课）—— 不许塞默认圈当地基')
    ok(Object.keys(empty).join(',') === 'termTotal,halos,lessons,edges', `空骨架载荷键序 = 生成器载荷（${Object.keys(empty).join(',')}）`)

    // ② 反空转（硬规矩）：0 圈时生成器必须**拒绝**，而不是画个假图
    ok(run(A).status !== 0, '0 圈时 build-starmap.js 必须拒绝生成（exit ≠ 0）—— 空骨架就是为这一刻准备的')

    // B 换上课程包原件（"同源"的判词 = 同输入 → 同产出）
    for (const rel of ['tools/build-starmap.js', 'tools/build-starmap-svg.js', 'tools/galaxy-shapes.cjs', 'starmap/data-layer.js']) {
      fs.copyFileSync(path.join(ROOT, rel), path.join(B, rel))
    }

    // ③ 建第一个圈 → 重建 → 圈出现在星图里（两套引擎逐字节同产出）
    const halo = JSON.stringify({ halo: 'math', name: '数学', color: '#7ec8ff', inside: [], outside: [] }, null, 2) + '\n'
    for (const d of [A, B]) {
      fs.mkdirSync(path.join(d, 'lessons', 'math'), { recursive: true })
      fs.writeFileSync(path.join(d, 'lessons', 'math', 'halo.json'), halo, 'utf8')
    }
    const rA = run(A), rB = run(B)
    ok(rA.status === 0 && rB.status === 0, `建第一个圈后重建：两套引擎都 exit 0（模板 ${rA.status} / 包侧 ${rB.status}）`)
    const genA = readPayload(A)
    ok(genA.halos.length === 1 && genA.halos[0].id === 'math', '圈出现在星图载荷里（halos[0].id = math）')
    ok(fs.readFileSync(path.join(A, 'starmap', 'content.js'), 'utf8') === fs.readFileSync(path.join(B, 'starmap', 'content.js'), 'utf8'),
      'content.js：模板副本与包侧原件**逐字节相同**（同输入同输出）')
    ok(fs.readFileSync(path.join(A, 'starmap', 'static.svg'), 'utf8') === fs.readFileSync(path.join(B, 'starmap', 'static.svg'), 'utf8'),
      'static.svg：两套引擎逐字节相同')
    const pageA = fs.readFileSync(path.join(A, 'starmap', 'index.html'), 'utf8')
    ok(pageA.includes('数学') && !pageA.includes('建第一个圈'), '页面：圈进了静态星图、「建第一个圈」引导随之消失（标记区被真图接管）')
    ok(Object.keys(genA).join(',') === Object.keys(empty).join(','), '生成器载荷键序与空骨架一致（契约没漂）')

    // ④ 反空转：多一个知识点 → 载荷必变，且两套引擎仍逐字节一致
    const point = JSON.stringify({ point: 'algebra', name: '代数', fileBase: 0 }, null, 2) + '\n'
    for (const d of [A, B]) {
      fs.mkdirSync(path.join(d, 'lessons', 'math', 'algebra'), { recursive: true })
      fs.writeFileSync(path.join(d, 'lessons', 'math', 'algebra', 'point.json'), point, 'utf8')
    }
    run(A); run(B)
    ok(readPayload(A).halos[0].points.length === 1, '反空转：多一个知识点 → 载荷多一条（algebra）')
    ok(fs.readFileSync(path.join(A, 'starmap', 'content.js'), 'utf8') === fs.readFileSync(path.join(B, 'starmap', 'content.js'), 'utf8'),
      '增量之后两套引擎仍逐字节相同')

    // ⑤ **从模板长出来的新包也要能画"规划中暗星"**（01:394 的验收：新建知识点 → 星图出现规划中暗星）。
    //    这条同时是 `tools/plan-map.js` 进模板清单的判据。漏了它会怎样：生成器是**硬 require**
    //    `./plan-map.js` —— 缺文件就当场炸（禁静默降级），而不是"跳过暗星继续生成"。
    //    所以"新包永远没有暗星却没人知道"这种状态**不可能悄悄发生**；下面这几条则证明
    //    模板长出来的包**真的画得出**暗星（不是"清单里有文件"就算数）。
    const withPlan = JSON.stringify({
      point: 'algebra', name: '代数', fileBase: 0,
      plan: {
        goal: '把代数式变形成能看出结构的样子',
        nodes: [
          { no: 1, title: '第1课 因式分解', deliverable: '一页四件套手册', criteria: '每步写得出依据',
            why: '不会变形就谈不上化简', sources: [{ label: '教材', url: 'https://example.com/a' }] },
          { no: 2, title: '第2课 配方法', deliverable: '配方例题集', criteria: '能独立配方',
            why: '配方是求极值的唯一入口', sources: [{ label: '教材', url: 'https://example.com/b' }] },
        ],
      },
    }, null, 2) + '\n'
    for (const d of [A, B]) fs.writeFileSync(path.join(d, 'lessons', 'math', 'algebra', 'point.json'), withPlan, 'utf8')
    const rpA = run(A), rpB = run(B)
    ok(rpA.status === 0 && rpB.status === 0, `有地图后重建：两套引擎都 exit 0（模板 ${rpA.status} / 包侧 ${rpB.status}）`)
    const plA = (readPayload(A).halos[0].points[0] || {}).planned
    ok(Array.isArray(plA) && plA.length === 1 && plA[0].no === 1 && /因式分解/.test(plA[0].title || ''),
      `**模板长出来的新包**也有规划中暗星（实得 ${JSON.stringify((plA || []).map((n) => n.no))}，期望 [1] = 一节没建时的前沿）`)
    ok(typeof plA?.[0]?.deliverable === 'string' && typeof plA?.[0]?.criteria === 'string',
      '暗星带着悬停要用的三样（title / deliverable / criteria）')
    ok(fs.readFileSync(path.join(A, 'starmap', 'content.js'), 'utf8') === fs.readFileSync(path.join(B, 'starmap', 'content.js'), 'utf8'),
      '有暗星之后，模板副本与包侧原件仍逐字节同产出')
    // 反空转：把地图删掉 → 暗星必须消失（不是画个假的顶上）
    for (const d of [A, B]) fs.writeFileSync(path.join(d, 'lessons', 'math', 'algebra', 'point.json'), point, 'utf8')
    run(A); run(B)
    ok(((readPayload(A).halos[0].points[0] || {}).planned || []).length === 0,
      '反空转：把地图删掉 → 暗星消失（不猜、不画假的）')
  } finally {
    fs.rmSync(fx, { recursive: true, force: true })
  }
}

/* ── ⑥ 知识点地图（大纲）：插件 lib/plan.js ↔ 包侧 tools/plan-map.js ─────────
   判据矩阵 + **前沿**（"下一颗星星"）逐案例同输入同输出。两侧一漂 = 插件告诉老师
   "下一课开第 N 课"，而星图/课程页的"待开课"占位指的是别的课 —— 同一件事两个答案。 */
{
  const packPlan = require_(path.join(ROOT, 'tools', 'plan-map.js'))
  const SRC = [{ label: 'Spring 官方指南', url: 'https://spring.io/guides/gs/spring-boot/' }]
  const n = (no, extra) => ({ no, title: '第' + no + '课', deliverable: '产物' + no, criteria: '判据' + no, why: '它让终点更近了', sources: SRC, ...extra })

  // 地图：主线 1..4，支线 5 紧跟在 4 之后（「这里正好有支线分叉」）
  const WITH_BRANCH = { goal: '交付一个服务', nodes: [n(1), n(2), n(3), n(4), n(5, { branch: true })] }
  // 地图：没有支线
  const NO_BRANCH = { goal: '交付一个服务', nodes: [n(1), n(2), n(3)] }

  const docCases = [
    ['完整地图', WITH_BRANCH],
    ['没有 plan', undefined],
    ['不是对象', 'x'],
    ['缺 goal', { goal: '', nodes: [n(1)] }],
    ['nodes 空', { goal: 'x', nodes: [] }],
    ['缺 why', { goal: 'x', nodes: [n(1, { why: '' })] }],
    ['no 重复', { goal: 'x', nodes: [n(1), n(1)] }],
    ['no 非正整数', { goal: 'x', nodes: [n(0)] }],
    ['缺 sources', { goal: 'x', nodes: [n(1, { sources: [] })] }],
    ['出处不是 http', { goal: 'x', nodes: [n(1, { sources: [{ label: 'x', url: 'nope' }] })] }],
    ['乱序（应排序）', { goal: 'x', nodes: [n(3), n(1), n(2)] }],
  ]
  let same = 0
  for (const [label, doc] of docCases) {
    const a = JSON.stringify(validatePlan(doc).problems)
    const b = JSON.stringify(packPlan.validatePlan(doc).problems)
    const oa = validatePlan(doc).ok
    const ob = packPlan.validatePlan(doc).ok
    if (a === b && oa === ob) same++
    else console.log(`     ✗ ${label}：插件 ok=${oa} ${a.slice(0, 90)} ／ 包侧 ok=${ob} ${b.slice(0, 90)}`)
  }
  ok(same === docCases.length, `validatePlan：判据矩阵逐案例一致（${same}/${docCases.length}）`)

  // 前沿：同一张地图 + 不同"已建课"进度 → 两颗/一颗/没有了
  const existingCases = [
    ['全没建', []],
    ['建了1', [1]],
    ['建了1到3', [1, 2, 3]],
    ['建了1到4', [1, 2, 3, 4]],
    ['全建完', [1, 2, 3, 4, 5]],
    ['混进地图上没有的号', [1, 2, 3, 4, 9]],
  ]
  let fSame = 0
  const shapes = {}
  for (const [label, ex] of existingCases) {
    const a = planFrontier(WITH_BRANCH, ex)
    const b = packPlan.planFrontier(WITH_BRANCH, ex)
    if (JSON.stringify(a) === JSON.stringify(b)) fSame++
    else console.log(`     ✗ ${label} [${ex}]：插件 ${JSON.stringify(a).slice(0, 110)} ／ 包侧 ${JSON.stringify(b).slice(0, 110)}`)
    shapes[label] = a.stars.map((s) => s.no).join('+') || '（无）'
  }
  ok(fSame === existingCases.length, `planFrontier：前沿逐案例一致（${fSame}/${existingCases.length}）`)
  ok(JSON.stringify(planFrontier(NO_BRANCH, [])) === JSON.stringify(packPlan.planFrontier(NO_BRANCH, [])),
    'planFrontier：没有支线的地图两边也一致')
  ok(JSON.stringify(planFrontier(undefined, [])) === JSON.stringify(packPlan.planFrontier(undefined, [])),
    'planFrontier：地图不可用时两边都 ok:false（不猜）')

  // 反空转：前沿的形状必须真的在变，否则"一致"是白得的
  ok(shapes['全没建'] === '1' && shapes['建了1'] === '2',
    `反空转：已建 0 颗 → 下一颗是 1；已建 [1] → 下一颗是 2（实得 ${shapes['全没建']} / ${shapes['建了1']}）`)
  ok(shapes['建了1到3'] === '4+5',
    `反空转：「这里正好有支线分叉」→ **两颗**（已建 [1,2,3] 时实得 ${shapes['建了1到3']}）—— 这就是 01:205 的"或两颗"`)
  ok(shapes['建了1到4'] === '5', `反空转：主线走完、支线还剩 → 一颗（实得 ${shapes['建了1到4']}）`)
  ok(planFrontier(WITH_BRANCH, [1, 2, 3, 4, 5]).exhausted === true, '反空转：全建完了 → exhausted（如实说"没有下一颗星"）')
  // 已建号不在图上（比如别的点的课号）不许影响前沿
  ok(shapes['混进地图上没有的号'] === shapes['建了1到4'],
    `反空转：塞进地图上没有的课次号（9）→ 前沿与不塞时相同（实得 ${shapes['混进地图上没有的号']} / ${shapes['建了1到4']}）`)
}

/* ── ⑦ 课次锚点（2026-09-24 F 条）：两侧的 labelAnchorId + 产物往返一致 ─────────
 * 为什么归「镜像对拍」：锚点 id 的公式有**两份实现**（包侧 `tools/lesson-map.js` /
 * 插件 `lib/pack-model.js`），产物又分两处生成 —— 课程页的 fragment 来自 build-lessons /
 * render，`reference/NOTES.html` 的 id 来自 build-notes。两侧一漂就是「点封面卡跳不到
 * 笔记小节」这种**静默失效**。
 * 判据是**往返一致**：浏览器按 percent-decode 后拿 fragment 与 id 比对
 * ⇒ `decode(fragment) === id` 必须成立；且 **id 本身不许含空白**（HTML 对 id 的硬限制 ——
 * 只编码 href 不够），fragment 必须真的 percent-encode 过。
 */
export function checkNotesAnchors(notesHtml, pages) {
  const problems = []
  const ids = [...new Set([...String(notesHtml).matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]))]
  for (const id of ids) {
    if (!id || /\s/.test(id)) problems.push(`NOTES.html 的 id「${id}」为空或含空白 —— 非法 HTML id（规范如此，只编码 href 不够）`)
  }
  for (const p of pages) {
    const frags = [...new Set([...String(p.html).matchAll(/NOTES\.html#([^"]*)/g)].map((m) => m[1]))]
    for (const frag of frags) {
      let decoded = null
      try { decoded = decodeURIComponent(frag) } catch { problems.push(`${p.name}: fragment「${frag}」不是合法的 percent-encoding`); continue }
      if (!ids.includes(decoded)) problems.push(`${p.name}: fragment「${frag}」decode 后「${decoded}」在 NOTES.html 里没有对应 id（浏览器就是这么比的）`)
      if (encodeURIComponent(decoded) !== frag) problems.push(`${p.name}: fragment「${frag}」没做 URL 编码（应为「${encodeURIComponent(decoded)}」）`)
    }
  }
  return { ids, problems }
}

{
  const packLessonMap = require_(path.join(ROOT, 'tools', 'lesson-map.js'))
  const anchorCases = ['第1课', 'Vue 第1课', '代数 第1课', '带  多空格\t与制表', '第1课 ', ' no-前导']
  let same = 0
  for (const c of anchorCases) {
    const a = labelAnchorId(c)
    const b = packLessonMap.labelAnchorId(c)
    if (a === b) same++
    else console.log(`     ✗ 输入 ${JSON.stringify(c)}：插件 ${JSON.stringify(a)} / 包侧 ${JSON.stringify(b)}`)
  }
  ok(same === anchorCases.length, `课次锚点公式两边逐案例一致（${same}/${anchorCases.length}：空白→-、多空格/制表/前后缀空白都归一）`)
  ok(anchorCases.every((c) => !/\s/.test(labelAnchorId(c))), '产出的 id 一律不含空白（HTML 规范对 id 的硬限制）')
  ok(decodeURIComponent(encodeURIComponent(labelAnchorId('代数 第1课'))) === labelAnchorId('代数 第1课'),
    '往返一致：fragment percent-encode 再 decode 回到同一个 id')
  let threw = false
  try { labelAnchorId('   ') } catch { threw = true }
  ok(threw, '空白 label → 当场抛错（绝不静默编一个跳不到的锚点）')

  // 产物端：真包只读 —— 课程页的 fragment 与 NOTES.html 的 id 必须对得上
  const notesPath = path.join(ROOT, 'reference', 'NOTES.html')
  const lessonsDir = path.join(ROOT, 'lessons')
  const pages = []
  ;(function walk(d, prefix = '') {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'src') continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { walk(path.join(d, e.name), rel); continue }
      if (/^\d{4}-.*\.html$/.test(e.name)) pages.push({ name: rel, html: fs.readFileSync(path.join(d, e.name), 'utf8') })
    }
  })(lessonsDir)
  const notesHtml = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : ''
  const { ids, problems } = checkNotesAnchors(notesHtml, pages)
  const links = pages.reduce((n, p) => n + (p.html.match(/NOTES\.html#/g) || []).length, 0)
  ok(links > 0 && ids.length > 0, `产物非空转（${pages.length} 个课程页里 ${links} 条笔记页链接 × NOTES.html 里 ${ids.length} 个 id）`)
  ok(problems.length === 0,
    `产物往返一致：每条 NOTES.html#fragment percent-decode 后都落到真实 id，且 id 零空白、fragment 真编码过${problems.length ? '（' + problems.slice(0, 3).join('；') + '）' : ''}`)

  // 反空转①：修法拿掉一半 —— id 换回带空格的旧写法（只编码 href 是不够的）
  const legacy = checkNotesAnchors('<details id="代数 第1课"></details>', [{ name: '旧格式.html', html: 'href="x/NOTES.html#%E4%BB%A3%E6%95%B0%20%E7%AC%AC1%E8%AF%BE"' }])
  ok(legacy.problems.some((p) => /含空白/.test(p)), '反空转①：id 含空格（旧写法）→ 判据红')
  ok(legacy.problems.length === 1 && /含空白/.test(legacy.problems[0]),
    `反空转①b：旧写法**只**被「id 含空白」抓住（往返在旧写法下是成立的）—— 证明只编码 href 过不了关，第二条判据不是摆设（实得 ${legacy.problems.length} 条）`)

  // 反空转②：id 修了、fragment 没跟着换（decode 出来的还是旧 label）
  const half = checkNotesAnchors('<details id="代数-第1课"></details>', [{ name: '只修id.html', html: 'href="x/NOTES.html#%E4%BB%A3%E6%95%B0%20%E7%AC%AC1%E8%AF%BE"' }])
  ok(half.problems.some((p) => /没有对应 id/.test(p)), '反空转②：id 换了 fragment 没换 → 判据红')

  // 反空转③：id / fragment 对得上，但 fragment 压根没做 URL 编码
  const unencoded = checkNotesAnchors('<details id="第1课"></details>', [{ name: '未编码.html', html: 'href="x/NOTES.html#第1课"' }])
  ok(unencoded.problems.some((p) => /没做 URL 编码/.test(p)), '反空转③：fragment 没做 URL 编码 → 判据红')
}

/* ── ⑤ 真包未被改动 ────────────────────────────────────────────────────── */
{
  const real = path.join(ROOT, 'notes', 'notes.jsonl')
  const size = fs.existsSync(real) ? fs.statSync(real).size : -1
  ok(size === 0, `真包的 notes/notes.jsonl 未被本次对拍碰到（${size} B）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 镜像对拍：文本助手一致、两个写入口产出同形记录（共用同一计数器与同一台账）、指纹算法逐案例一致、星图载荷契约一致（含随包模板副本逐字节同产出）、课次锚点往返一致（id 零空白 + fragment 编码）')
