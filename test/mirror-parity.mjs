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
 *   ③ **内容指纹算法**：`lib/fingerprint.js` ↔ 包侧 `tools/fingerprint.js`（+ 模板逐字副本）——
 *      点亮换钉子的新鲜度判据。两侧一漂 = 永远 `stale-snapshot` = 点亮全废（R13），
 *      所以除了逐案例相等，还自带**反空转**（多文件 / 改字节 / 换行编码 → 指纹必变且两边仍相等）。
 *   ④ **星图载荷契约**：`lib/pack-scaffold.js`（建包时写的空星图骨架）↔ 包侧 `tools/build-starmap.js`
 *      （星图数据生成器）+ **随包模板副本**（`lib/pack-template/tools/build-starmap.js` 等 4 件）——
 *      同一个 `window.STARMAP_REAL` 契约：键序一致、空包**纯空**（0 圈，不许塞默认圈当地基）、
 *      建第一个圈后重建圈出现在载荷与页面里，且模板副本与包侧原件**同输入 → 逐字节同产出**。
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
import { digestTree } from '../lib/fingerprint.js'
import { appendNote } from '../lib/notes-io.js'
import { writeScaffold } from '../lib/pack-scaffold.js'
import { validatePlan, planFrontier } from '../lib/plan.js'
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
} finally {
  if (child && !child.killed) { try { child.kill() } catch { /* 已退 */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
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

/* ── ⑤ 真包未被改动 ────────────────────────────────────────────────────── */
{
  const real = path.join(ROOT, 'notes', 'notes.jsonl')
  const size = fs.existsSync(real) ? fs.statSync(real).size : -1
  ok(size === 0, `真包的 notes/notes.jsonl 未被本次对拍碰到（${size} B）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 镜像对拍：文本助手一致、两个写入口产出同形记录（共用同一计数器与同一台账）、指纹算法逐案例一致、星图载荷契约一致（含随包模板副本逐字节同产出）')
