/**
 * practice.mjs —— 实践区（`whale_practice` + assets/practice.js）
 *
 * 判据分两层：
 *   A. **数据与漂移**（离线、必跑）：
 *      ① 真包上生成的数据与探针结论一致（第1课 3/3＋1 人工、第2课 0/3＋1 人工）
 *      ② 产出**没有百分比**（口径：只报 k/n）
 *      ③ 产物是合法 JS（能 require 回来）+ 形状对（version/lessons/byFile）
 *      ④ 漂移：改坏 → 报出；write=true → 复原；再写一次不重写
 *      ⑤ 影子副本上跑，**真包一字不动**
 *   B. **真浏览器**（有服务就真跑）：dump DOM，断言实践区**真的渲染出来了**、
 *      并且显示的就是"达成 3 / 共 3"（服务没在跑则**大声跳过**）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { probeState } from '../lib/state-scan.js'
import { PROBE_VERSION } from '../lib/fingerprint.js'
import { buildPracticeData, renderPracticeDataModule } from '../lib/practice.js'
import { probeBase, dumpDom, findBrowser } from '../lib/visual-io.js'
import { plugin as practicePlugin } from '../lib/mods/practice.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
const DATA_REL = 'assets/practice-data.js'
const realBefore = sha(fs.readFileSync(path.join(ROOT, DATA_REL))) + '|' + sha(fs.readFileSync(path.join(ROOT, 'lessons', 'programming', 'spring-boot', '0001-spring-boot-hello-world.html')))
const LIVE_BASE = process.env.WHALE_VISUAL_BASE || 'http://127.0.0.1:3091'

console.log(`\n[practice] 课程包：${ROOT}`)

// ── A. 数据与漂移 ──
const pack = readPack(ROOT)
const { state } = probeState(ROOT, pack)
const data = buildPracticeData({ state, pack })
const text = renderPracticeDataModule(data)

// 4 课 = spring-boot 第1/2课 + vue 第1课 + **alge 第1课**（高数，2026-09-24 补的判据）。
// 2026-09-24 D1：vue 的实践区（只有 EXPECT.json）以前立不成项目 ⇒ 它那份判据永远读不到、
// 这里只有 2 条；修完变成 3 条 —— 这条断言就是那个缺陷的回归判据。
// 2026-09-24 D2-a：键从「课号」改成**课 id**（`spring-boot/0001`）—— 课号跨圈会撞车（见下）
ok(
  data.version === 2 && data.keyScheme === 'lesson-id' && Object.keys(data.lessons).length === 4,
  `四课都有实践数据（${Object.keys(data.lessons).join('、')}）`
)
ok(!!data.lessons['vue/1001'], 'vue 第1课的实践数据出现了（D1 修掉的那条链）')
// 真包上的活体碰撞回归：`spring-boot/0001` 与 `alge/0001` **课号都是 1**，两条必须都在
ok(
  !!data.lessons['spring-boot/0001'] && !!data.lessons['alge/0001'],
  '真包上两个「第1课」（spring-boot 与 alge）并存、没有互相覆盖'
)
const l1 = data.lessons['spring-boot/0001']
const l2 = data.lessons['spring-boot/0002']
// ⚠️ 这几条**不许写死数字**：真包是学生**正在用**的包（2026-09-24 实测：他当天就把第2课做到 2/3，
//    写死"第2课 0/3"当场就红）。判据改成"页面拿到的数 = 探针算的数"—— 这才是这套真正要验的。
const byId = new Map((state.projects || []).flatMap((p) => (p.lessons || []).map((l) => [l.id, l])))
let mismatched = 0
for (const [key, d] of Object.entries(data.lessons)) {
  const l = byId.get(key)
  if (!l || d.summary.achieved !== l.challengeSummary.achieved
    || d.summary.total !== l.challengeSummary.total
    || d.summary.needsReview !== l.challengeSummary.needsReview) mismatched++
}
ok(mismatched === 0, `每一课的 k/n 与探针快照**逐课相等**（不等 ${mismatched} 课）`)
ok(Object.keys(data.lessons).length === byId.size, `实践区课数 = 有判据的课数（${Object.keys(data.lessons).length} / ${byId.size}）`)
ok(
  Object.values(data.lessons).every((d) => (d.challenges || []).every((c) => ['done', 'todo', 'review'].includes(c.state))),
  '逐题状态都在三态集合里（done / todo / review）'
)
const reviewOnes = Object.values(data.lessons).flatMap((d) => (d.challenges || []).filter((c) => c.state === 'review'))
ok(reviewOnes.every((c) => !!c.why), `需人工确认的题都带 why（${reviewOnes.length} 条）`)
ok(
  [...l1.challenges, ...l2.challenges].every((c) => typeof c.deliverable === 'string' && c.deliverable.trim()),
  '**每道挑战都有明确的产出**（deliverable）—— 这是"检查变容易"的前提'
)
ok(/产出/.test(text), '生成的 JS 里带着产出字段（页面拿它显示"产出：…"）')
ok(!/%/.test(text), '数据文件里**没有百分比**（口径：只报 k/n）')
ok(!/[\u{1F300}-\u{1FAFF}]/u.test(text) && !/[✗✓⚠]/.test(text), '数据文件里没有 emoji/装饰符号（UI 层规则）')

// ── 跨圈撞车回归（2026-09-24 D2-a）──
// 键以前是「课号」：`spring-boot/0001` 与 `alge/0001` **都是 `1`** —— 后写的**静默覆盖**前一条，
// 页面按课号查就会串课。造一份最小 state（两个圈各有一门 0001）看两条是否都在。
const mkLesson = (id, achieved, total) => ({
  id,
  title: id,
  challengeSummary: { achieved, total, needsReview: 0 },
  challenges: [{ no: 1, hint: 'h', deliverable: 'd', done: achieved > 0, missing: [] }],
})
const colliding = buildPracticeData({
  state: {
    // 手搓快照照抄真快照的顶层形状（probeVersion 用 import 的常量，不写字面量）
    probeVersion: PROBE_VERSION,
    projects: [
      { dir: 'code/a', expect: { path: 'code/a/EXPECT.json' }, lessons: [mkLesson('spring-boot/0001', 3, 3)] },
      { dir: 'code/b', expect: { path: 'math/alge/EXPECT.json' }, lessons: [mkLesson('alge/0001', 0, 2)] },
    ],
  },
  pack: { lessons: [] },
})
ok(
  Object.keys(colliding.lessons).length === 2 && !!colliding.lessons['spring-boot/0001'] && !!colliding.lessons['alge/0001'],
  `跨圈同名课号**不互相覆盖**（${Object.keys(colliding.lessons).join('、')}）`
)
ok(colliding.lessons['alge/0001'].summary.total === 2, '两条数据的数值各归各（没有串课）')
ok(colliding.lessons['spring-boot/0001'].expect === 'code/a/EXPECT.json', '每条带着**自己项目**的 EXPECT 路径（页面脚注不再写死）')

ok(text === fs.readFileSync(path.join(ROOT, DATA_REL), 'utf8'), '真包磁盘上的 practice-data.js 与现算结果**逐字节相同**（漂移检查绿）')

// 影子副本：坏样 + 落盘 + 幂等
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-practice-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const tools = []
  practicePlugin.install({ paths: { packRoot: tmp }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
  const tool = tools.find((t) => t.name === 'whale_practice')
  const target = path.join(tmp, DATA_REL)

  const clean = await tool.execute({ root: tmp })
  ok(clean.ok === true && /一致/.test(clean.summary), `干净副本：一致（${clean.summary}）`)
  fs.writeFileSync(target, '// 手改坏了\n', 'utf8')
  const dirty = await tool.execute({ root: tmp })
  ok(dirty.ok === false && /漂移/.test(dirty.summary), `改坏之后被报出（${dirty.summary}）`)
  const wrote = await tool.execute({ root: tmp, write: true })
  ok(wrote.ok === true && fs.readFileSync(target, 'utf8') === text, 'write=true 复原成功，且内容与生成结果逐字相同')
  const again = await tool.execute({ root: tmp, write: true })
  ok(/无变化/.test(again.written || ''), `内容没变时不重写（${again.written}）`)
  // 产物是合法 JS：require 回来对形状
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  delete req.cache[target]
  const required = req(target)
  ok(required.version === 2 && required.lessons['spring-boot/0001'].summary.total === 3, '产物是合法 JS，require 回来形状对')
  ok(Object.keys(required.byFile).length >= 1, `byFile 兜底键在（${Object.keys(required.byFile).join('、')}）`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── B. 真浏览器：实践区真的显示出来了吗 ──
const exe = findBrowser()
const probe = exe ? await probeBase(LIVE_BASE, '/lessons/programming/spring-boot/0001-spring-boot-hello-world.html') : { ok: false, why: '找不到浏览器' }
if (!exe || !probe.ok) {
  console.log(`⚠️  跳过真浏览器那一层：${exe ? `${LIVE_BASE} 连不上（${probe.why}）` : '本机找不到 Edge/Chrome'} —— 起了服务再跑就是绿的：node tools/app-server.js`)
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-practice-prof-'))
  try {
    const dom = dumpDom({ exe, url: `${LIVE_BASE}/lessons/programming/spring-boot/0001-spring-boot-hello-world.html`, profileDir: profile, budgetMs: 5000 })
    const html = dom.html || ''
    ok(/id="practice-zone"/.test(html), '页面上有实践区的挂载点')
    ok(/实践区/.test(html) && /达成 3 \/ 共 3/.test(html), '真浏览器里实践区**渲染出来了**，且显示「达成 3 / 共 3」')
    ok(/需人工确认/.test(html), '需人工确认那题也显示在页面上（没被吞掉）')
    const dup = (html.match(/打成 JAR/g) || []).length
    ok(dup === 1, `需人工确认那题的说明**只出现一次**（实得 ${dup}）—— 被重复打印过：why 抄了 hint`)
    ok(!/hidden=""[^>]*id="practice-zone"|id="practice-zone"[^>]*hidden=""/.test(html), '渲染成功后区域不再是隐藏的')
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

ok(
  sha(fs.readFileSync(path.join(ROOT, DATA_REL))) + '|' + sha(fs.readFileSync(path.join(ROOT, 'lessons', 'programming', 'spring-boot', '0001-spring-boot-hello-world.html'))) === realBefore,
  '真包未被改动（practice-data.js + 课程页哈希相同）'
)

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 实践区：数据与探针一致、没有百分比、可判漂移；真浏览器里显示得出来')
