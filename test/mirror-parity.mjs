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
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripBom, splitLines } from '../lib/text.js'
import { appendNote } from '../lib/notes-io.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const ROOT = path.resolve(process.argv[2] || path.join(PLUGIN, '..', 'study'))
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
} finally {
  if (child && !child.killed) { try { child.kill() } catch { /* 已退 */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
}

/* ── ③ 真包未被改动 ────────────────────────────────────────────────────── */
{
  const real = path.join(ROOT, 'notes', 'notes.jsonl')
  const size = fs.existsSync(real) ? fs.statSync(real).size : -1
  ok(size === 0, `真包的 notes/notes.jsonl 未被本次对拍碰到（${size} B）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 镜像对拍：文本助手一致、两个写入口产出同形记录（共用同一计数器与同一台账）')
