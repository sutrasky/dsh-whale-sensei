/**
 * render-parity.mjs —— M2 验收：插件渲染与 CLI 渲染**逐字节相同**
 *
 * 五条判据（缺一条这活就不算成；第 ⑤ 条是 P1-6 定制层契约，见文件末 F 段）：
 *   ① CLI 自检无漂移 —— 证明"磁盘上的页面 == CLI 渲染结果"，这是对拍基准成立的前提
 *   ② 插件 planBuild() == 磁盘产物，逐字节（不是"看起来一样"）
 *   ③ planBuild 是确定的：同一输入两次调用，结果逐字相同
 *   ④ **换一份新输入**：影子副本里改一处源文件 → 分别用 CLI 和插件渲染 → 逐字节相同
 *      （只比"复制出来的现有文件"是自欺欺人：那样测的是"能不能读盘"，不是"会不会渲染"）
 *
 * 判据由主线程制定；红/绿必须能说明问题。
 */
import { makeRunResult, validateRunResult } from './_result.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readPack } from '../lib/pack.js'
import { planBuild, diffPlan, writePlan } from '../lib/render-inputs.js'
import { packRoot } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = packRoot()
let pass = 0
const fails = []
const suiteCases = []
function ok(cond, msg) {
  suiteCases.push({ id: 'render-parity:' + String(suiteCases.length + 1).padStart(3, '0'), status: cond ? 'pass' : 'fail', note: msg })
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
function writeSuiteResult() {
  const result = makeRunResult({ packRoot: ROOT, base: null, cases: suiteCases })
  const valid = validateRunResult(result)
  if (!valid.ok) throw new Error(valid.errors.join('; '))
  if (process.env.DSH_WHALE_RESULT) fs.writeFileSync(process.env.DSH_WHALE_RESULT, JSON.stringify(result, null, 2), 'utf8')
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const line = a.slice(0, i).split('\n').length
  const col = i - (a.lastIndexOf('\n', i - 1) + 1)
  return `第 ${line} 行第 ${col} 列（长度 ${a.length} vs ${b.length}）`
}

console.log(`\n[m2] 课程包：${ROOT}`)
const pack = readPack(ROOT)

// ── ① 对拍基准：磁盘 == CLI 渲染 ──
let cliClean = false
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-lessons.js'), '--check'], { cwd: ROOT, stdio: 'pipe' })
  cliClean = true
} catch (e) { cliClean = false }
ok(cliClean, 'CLI 自检无漂移（磁盘上的页面就是 CLI 渲染的结果）')

// ── ② 插件渲染 == 磁盘 ──
const plan = planBuild(ROOT, pack)
ok(Array.isArray(plan.files) && plan.files.length > 0, `planBuild 产出 ${plan.files.length} 个文件`)
let same = 0
for (const f of plan.files) {
  const abs = path.join(ROOT, f.path)
  if (!fs.existsSync(abs)) { console.log(`     ✗ 磁盘上没有 ${f.path}`); continue }
  const disk = fs.readFileSync(abs, 'utf8')
  if (disk === f.content) same++
  else console.log(`     ✗ ${f.path} 与磁盘不一致：${firstDiff(f.content, disk)}`)
}
ok(same === plan.files.length && plan.files.length > 0, `插件渲染与磁盘产物逐字节相同（${same}/${plan.files.length}）`)

// ── ②b 覆盖面：planBuild 只管课程页，别的产物**一个都不许碰** ──
// 这不是"文档里写了"，而是**行为断言**。插件侧刻意不复制 build-notes / drain / 星图 /
// theme.css 的语义（`lib/mods/build.js:14-15,36-37`、`lib/ask-io.js:281`：这些脚本是 shell-out 调的）。
// 谁哪天顺手把它们也搬进来，这条会红 —— 逼他先来改这里，而不是悄悄多出第二份实现。
{
  const owned = plan.files.map((f) => f.path)
  ok(!owned.includes('reference/NOTES.html'), 'planBuild 不生产 reference/NOTES.html（归 build-notes，插件只 shell-out）')
  ok(!owned.includes('assets/theme.css'), 'planBuild 不生产 assets/theme.css（归 whale_style）')
  ok(!owned.some((p) => p.startsWith('starmap/')), 'planBuild 不生产 starmap/**（归星图构建）')
  ok(owned.length > 0 && owned.every((p) => p.startsWith('lessons/')), `planBuild 只产出 lessons/**（${owned.length} 个文件全在 lessons/ 下）`)
}

// ── ③ 确定性（含：源码里不许有随机/时钟）──
ok(JSON.stringify(planBuild(ROOT, pack)) === JSON.stringify(plan), 'planBuild 是确定的：两次调用结果逐字相同')
const srcText = fs.readFileSync(path.join(HERE, '..', 'lib', 'render.js'), 'utf8')
ok(!/Math\.random|Date\.now|new Date\(|hrtime/.test(srcText), 'render.js 里没有随机数 / 时钟（确定性靠结构保证，不靠运气）')
ok(!/from '(node:)?fs'|require\('(node:)?fs'\)/.test(srcText), 'render.js 是纯函数层：不 import fs')

// ── ④ 新输入对拍（反空转）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-m2-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const srcDir = path.join(tmp, 'lessons', 'src')
  // 递归（分层布局后源文件在 lessons/src/<圆圈>/<知识点>/ 下；平铺时代这里是直接 readdir）
  const srcs = (function walk(d, prefix = '') {
    const out = []
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { out.push(...walk(path.join(d, e.name), rel)); continue }
      if (/^\d{4}-.*\.html$/.test(e.name)) out.push(rel)
    }
    return out
  })(srcDir)
  ok(srcs.length > 0, `影子副本里有 ${srcs.length} 个源文件`)
  const target = srcs[srcs.length - 1]
  const MARK = '<!--M2-PARITY-MARK-->'
  const p = path.join(srcDir, target)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('<!--@body-->', `<!--@body-->\n${MARK}`), 'utf8')

  // CLI 在影子副本里重渲染（它会写盘 —— 写的是影子，不碰真包）
  let cliOk = false
  try {
    execFileSync(process.execPath, [path.join(tmp, 'tools', 'build-lessons.js')], { cwd: tmp, stdio: 'pipe' })
    cliOk = true
  } catch (e) { cliOk = false }
  ok(cliOk, 'CLI 在影子副本里重渲染成功')

  const shadowPlan = planBuild(tmp, readPack(tmp))
  let eq = 0
  for (const f of shadowPlan.files) {
    const abs = path.join(tmp, f.path)
    if (!fs.existsSync(abs)) { console.log(`     ✗ 影子副本上没有 ${f.path}`); continue }
    const disk = fs.readFileSync(abs, 'utf8')
    if (disk === f.content) eq++
    else console.log(`     ✗ 新输入下 ${f.path} 不一致：${firstDiff(f.content, disk)}`)
  }
  ok(eq === shadowPlan.files.length && shadowPlan.files.length > 0, `新输入下逐字节相同（${eq}/${shadowPlan.files.length}）`)

  // 反空转：改了输入，产物必须真的变了，否则上面那条对拍是空的
  const changed = shadowPlan.files.filter((f) => {
    const orig = path.join(ROOT, f.path)
    return fs.existsSync(orig) && fs.readFileSync(orig, 'utf8') !== f.content
  })
  ok(changed.length > 0, `新输入确实产生了不同的产物（${changed.length} 个文件变了 —— 否则对拍是空转）`)

  // ── ⑤ 落盘能力：删掉一个产物 → writePlan 必须按渲染结果把它补回来 ──
  const victim = shadowPlan.files[0].path
  fs.rmSync(path.join(tmp, victim), { force: true })
  const pre = diffPlan(tmp, shadowPlan)
  ok(pre.missing.length === 1, `删掉产物后漂移被报出（缺 ${pre.missing.length} 个：${pre.missing.join(', ')}）`)
  const w = writePlan(tmp, shadowPlan)
  ok(w.written.length === 1 && w.written[0] === victim, `writePlan 只补了缺的那一个（写入 ${w.written.join(', ') || '无'}）`)
  ok(fs.readFileSync(path.join(tmp, victim), 'utf8') === shadowPlan.files[0].content, '补回来的字节与渲染结果逐字相同')
  const post = diffPlan(tmp, shadowPlan)
  ok(post.missing.length === 0 && post.different.length === 0, '补完之后没有残留漂移')
  const again = writePlan(tmp, shadowPlan)
  ok(again.written.length === 0 && again.unchanged.length === shadowPlan.files.length, '内容没变的文件不被重写（不白刷 mtime）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑥ E 条：死代码三个符号（清单渲染函数 / 名词链接 / 它的 slug helper）不许回来 ──
// 为什么这组判据是**源码级**：这三个符号零调用，删与不删产物逐字节不变 —— 只有盯源码才盯得住。
// 三处源一起盯：包侧原件 / 随包模板副本 / 插件侧同源实现（登记表第 1 对）。
// 为什么先剥注释：下面每个符号都得在注释里解释"为什么删"——注释里提到名字不算"回来了"，
// 判据只看**代码**。剥注释这件事本身也有反空转与"别剥多了"的钉子（见下）。
/**
 * 把 JS 的块注释与行注释换成空格（判据只看代码；`http://` 里的 `//` 不算注释开头）。
 * @param {string} src
 * @returns {string}
 */
export function stripJsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
}

/** 三个已删符号 + 它们各自"回来"意味着什么 */
const DEAD_SYMBOLS = [
  ['renderTermList', '名词清单渲染函数还在（两处定义零调用的死代码，笔记卡改版时就该删）'],
  ['termHref', '名词页链接函数又回来了（清单函数删掉后它零调用；真要恢复就先恢复调用方）'],
  ['slug', '名词页锚点的 slug helper 又回来了（它的唯一调用方是上面那个链接函数）'],
]

/**
 * @param {Record<string,string>} sources 文件名 → 源码
 * @returns {string[]} 问题（空 = 全过）
 */
export function checkTermListDead(sources) {
  const problems = []
  for (const [name, raw] of Object.entries(sources)) {
    const src = stripJsComments(raw)
    for (const [sym, why] of DEAD_SYMBOLS) {
      if (new RegExp(`\\b${sym}\\b`).test(src)) problems.push(`${name}: ${why}`)
    }
    if (/\{\{\s*TERM_LIST/.test(src)) {
      problems.push(`${name}: 又出现清单槽位（现行产物禁止正文出现 .term-list）`)
    }
    if (src.includes('../GLOSSARY.md#')) {
      problems.push(`${name}: 又把 ../GLOSSARY.md 写死（分层布局下 lessons/<圈>/<点>/ 会解析到 lessons/<圈>/GLOSSARY.md，不存在；活链接只有外壳的 {{PAGE_UP}}GLOSSARY.md）`)
    }
  }
  return problems
}

{
  const PLUGIN_DIR = path.join(HERE, '..')
  const sources = {
    '包侧 tools/build-lessons.js': fs.readFileSync(path.join(ROOT, 'tools', 'build-lessons.js'), 'utf8'),
    '随包模板副本 lib/pack-template/tools/build-lessons.js': fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'pack-template', 'tools', 'build-lessons.js'), 'utf8'),
    '插件侧 lib/render.js': srcText,
  }
  const probs = checkTermListDead(sources)
  ok(probs.length === 0, `E：三处源里清单渲染函数 / 名词链接 / slug helper 零残留、清单槽位零残留、没有写死的 ../GLOSSARY.md${probs.length ? '（' + probs.join('；') + '）' : ''}`)

  // 剥注释本身：代码留住、注释丢掉；URL 里的 // 不算注释
  ok(stripJsComments('const a = 1 /* renderTermList */\n// termHref\n').trim() === 'const a = 1',
    '剥注释：块注释与行注释都不进判据，代码留着')
  ok(stripJsComments('const u = "http://x/slug"').includes('slug'),
    '剥注释：字符串里的 // 不当注释开头（URL 不会被吃掉后半截）')
  // 剥多了会让上面那条**假绿** —— 钉住"活代码还在"
  ok(/export function renderPage/.test(stripJsComments(sources['插件侧 lib/render.js'])),
    '剥注释：插件侧 render.js 的活代码（renderPage）还在（没被剥多）')
  ok(/function parseSource/.test(stripJsComments(sources['包侧 tools/build-lessons.js'])),
    '剥注释：包侧 build-lessons.js 的活代码（parseSource）还在（没被剥多）')

  // 反空转：把每个已删符号塞回去 → 判据必须报出来，否则上面那条是空转
  const back = checkTermListDead({ '伪造·清单函数回来了': 'export function renderTermList(terms, gi, file) { return "" }' })
  ok(back.some((p) => /清单渲染函数还在/.test(p)), '反空转①：把清单渲染函数塞回去 → 判据红')

  const href = checkTermListDead({ '伪造·链接函数回来了': 'export const termHref = (key, pageUp) => `${pageUp}GLOSSARY.md#${slug(k)}`' })
  ok(href.some((p) => /链接函数又回来/.test(p)), '反空转②：把名词页链接函数塞回去 → 判据红')

  const sg = checkTermListDead({ '伪造·slug 回来了': 'function slug(label) { return String(label) }' })
  ok(sg.some((p) => /slug helper 又回来/.test(p)), '反空转③：把 slug helper 塞回去 → 判据红')

  const hard = checkTermListDead({ '伪造·硬编码回来了': 'const u = `../GLOSSARY.md#${x}`;' })
  ok(hard.some((p) => /写死/.test(p)), '反空转④：把 ../GLOSSARY.md 写死回去 → 判据红')

  // 反空转的对偶：**只在注释里**提到这些名字 → 不许红（证明判据看的是代码，不是文本）
  const onlyComment = checkTermListDead({ '伪造·只在注释里提': '/* 这里曾经有 renderTermList / termHref / slug */\nconst a = 1' })
  ok(onlyComment.length === 0, '反空转⑤：只在注释里提到这三个符号 → 不红（判据看代码，不看注释）')
}

/* ── F：定制层（coach）契约（P1-6）────────────────────────────────────────────
 * 契约：三个**整行**占位符 `<!-- @WHALE:RECAP|NEXT|ASK -->` 必须都在 `_frame.html` 里；
 * 渲染器只在整行处注入定制层内容；**缺占位符即构建报错**（静默留白正是这条契约要堵的洞）。
 * 对拍口径（方案 `_board/03:151` 特意说死的那条）：render-parity 跑的是**注入固定（空）
 * coach fixture 的渲染结果**，不读真包数据 —— 所以"改 coach 数据"与"对拍绿"不冲突。
 */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-coach-'))
  try {
    fs.cpSync(ROOT, tmp, { recursive: true })
    const framePath = path.join(tmp, 'assets', '_frame.html')
    const frameOrig = fs.readFileSync(framePath, 'utf8')

    // F1 · 三个占位符都在，且都是**整行**（独占一行 —— 半行的会被当正文留下，等于没契约）
    for (const slot of ['RECAP', 'NEXT', 'ASK']) {
      ok(
        new RegExp(`^[ \\t]*<!--\\s*@WHALE:${slot}\\s*-->$`, 'm').test(frameOrig),
        `F1 占位符 <!-- @WHALE:${slot} --> 在 _frame.html 里且**独占一行**`
      )
    }

    // F2 · 真包没有 coach 目录 ⇒ 上面 ①② 跑的就是**空 fixture**，不是真包数据
    ok(
      !fs.existsSync(path.join(ROOT, 'learning-records', 'coach')),
      'F2 真包没有 learning-records/coach ⇒ 对拍基准跑的就是空 fixture（不是真包数据）'
    )

    // F3 · 换一份 coach 数据 → 那一段**真的被注入**了
    const coachDir = path.join(tmp, 'learning-records', 'coach', 'spring-boot')
    fs.mkdirSync(coachDir, { recursive: true })
    fs.writeFileSync(
      path.join(coachDir, '0001.jsonl'),
      JSON.stringify({ slot: 'RECAP', html: '<div class="coach-recap" data-fixture="1">定制层来了</div>' }) + '\n',
      'utf8'
    )
    execFileSync(process.execPath, [path.join(tmp, 'tools', 'build-lessons.js')], { cwd: tmp, stdio: 'pipe', timeout: 180_000 })
    const pagePath = path.join(tmp, 'lessons', 'programming', 'spring-boot', '0001-spring-boot-hello-world.html')
    const withCoach = fs.readFileSync(pagePath, 'utf8')
    ok(
      withCoach.includes('data-fixture="1"') && withCoach.includes('定制层来了'),
      'F3 写一份 coach 数据 → 那一页的 RECAP 段**真的被注入**了（在占位符的位置）'
    )
    ok(!withCoach.includes('@WHALE:RECAP'), 'F3 注入后占位符本身**不留痕**（是被替换掉，不是叠一层）')

    // F4 · 反空转：删掉一个占位符 → 构建必须**报错并点名**（不是静默留白）
    fs.writeFileSync(framePath, frameOrig.replace(/^[ \t]*<!--\s*@WHALE:NEXT\s*-->\r?\n?/m, ''), 'utf8')
    let threw = ''
    try {
      execFileSync(process.execPath, [path.join(tmp, 'tools', 'build-lessons.js')], { cwd: tmp, stdio: 'pipe', timeout: 180_000 })
    } catch (e) {
      threw = String(e.stdout || '') + String(e.stderr || '')
    }
    ok(
      /缺整行占位符/.test(threw) && /@WHALE:NEXT/.test(threw),
      `F4 反空转：删掉 <!-- @WHALE:NEXT --> → 构建**报错并点名**（${threw ? '已报错' : '没报错 = 契约空转 ✗'}）`
    )

    // F5 · 真包一字未动（全程只动 mkdtemp 拷贝）
    ok(!fs.existsSync(path.join(ROOT, 'learning-records', 'coach')), 'F5 真包没被写入 coach（只在拷贝上造过）')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

writeSuiteResult()
console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 同样的输入 → 同样的页面（插件与 CLI 逐字节等价）')
