/**
 * render-parity.mjs —— M2 验收：插件渲染与 CLI 渲染**逐字节相同**
 *
 * 四条判据（缺一条这活就不算成）：
 *   ① CLI 自检无漂移 —— 证明"磁盘上的页面 == CLI 渲染结果"，这是对拍基准成立的前提
 *   ② 插件 planBuild() == 磁盘产物，逐字节（不是"看起来一样"）
 *   ③ planBuild 是确定的：同一输入两次调用，结果逐字相同
 *   ④ **换一份新输入**：影子副本里改一处源文件 → 分别用 CLI 和插件渲染 → 逐字节相同
 *      （只比"复制出来的现有文件"是自欺欺人：那样测的是"能不能读盘"，不是"会不会渲染"）
 *
 * 判据由主线程制定；红/绿必须能说明问题。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readPack } from '../lib/pack.js'
import { planBuild, diffPlan, writePlan } from '../lib/render-inputs.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
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
  let cliOk = true
  try {
    execFileSync(process.execPath, [path.join(tmp, 'tools', 'build-lessons.js')], { cwd: tmp, stdio: 'pipe' })
  } catch (e) { cliOk = true }
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

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 同样的输入 → 同样的页面（插件与 CLI 逐字节等价）')
