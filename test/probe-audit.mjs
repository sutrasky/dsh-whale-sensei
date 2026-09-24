#!/usr/bin/env node
/**
 * test/probe-audit.mjs — T5-a 判据
 * ------------------------------------------------------------------
 * 跑：node test/probe-audit.mjs [课程包根]
 * 判四条：
 *   ① probe 是**纯函数**：同一输入跑两次，结果逐字相同
 *   ② probe 对已知样本给出**正确分类**，且每条判定都带依据
 *   ③ audit 在**干净课程包**上没有发现项（与"闸门全绿"一致）
 *   ④ **证伪**：影子副本里故意造 死链 + id 重复 + 缺产物 → 三类必须被抓到
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readPack } from '../lib/pack.js'
import { probePath } from '../lib/probe.js'
import { auditPack } from '../lib/audit.js'
import { assertLosslessJson } from '../lib/state.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()

// ── 真包守卫：本套所有动手的目录都在 os.tmpdir()；真包整树的内容哈希前后必须一致 ──
//    （跳过 .git/ —— 别人的 git 活动不该让本判据抖动；课程包内容一个字节都不许变）
const treeDigest = (dir) => {
  const h = createHash('sha256')
  const files = []
  ;(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) files.push(p.split(path.sep).join('/'))
    }
  })(dir)
  for (const f of files.sort()) { h.update(f + '\0'); h.update(fs.readFileSync(f)); h.update('\0') }
  return `${h.digest('hex')}:${files.length}`
}
const realBefore = treeDigest(ROOT)

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

console.log(`\n[t5a] 课程包：${ROOT}`)
const pack = readPack(ROOT)

// ① 纯函数
const a = JSON.stringify(probePath(ROOT, 'lessons/programming/spring-boot/0001-spring-boot-hello-world.html', pack))
const b = JSON.stringify(probePath(ROOT, 'lessons/programming/spring-boot/0001-spring-boot-hello-world.html', pack))
ok(a === b, 'probe 是纯函数：同一输入两次结果逐字相同')

// ② 已知分类 + 依据
const CASES = [
  ['lessons/programming/spring-boot/0001-spring-boot-hello-world.html', 'lesson-page'],
  ['lessons/src/programming/spring-boot/0001-spring-boot-hello-world.html', 'lesson-src'],
  ['reference/NOTES.html', 'reference'],
  ['starmap/content.js', 'artifact'],
  ['starmap/index.html', 'artifact'],
  ['starmap/main.js', 'artifact'],
  ['tools/build-lessons.js', 'tool'],
  // ⚠️ 下面两条是**被漏掉的样本**：只认 .js 时它们全落 unknown ✗（本仓库最常用的两个脚本）
  ['tools/gate.mjs', 'tool'],
  ['tools/starmap.test.mjs', 'tool'],
  // ⚠️ 学生工作区以前**没有分类**，code/** 全落 unknown ✗（点流程时现场抓到）
  ['code/_hello-spring-boot/hello-spring-boot/pom.xml', 'student-code'],
  ['code/_hello-spring-boot/EXPECT.json', 'student-code'],
]
let clsOk = 0
for (const [p, want] of CASES) {
  const r = probePath(ROOT, p, pack)
  const good = r.kind === want && Array.isArray(r.evidence) && r.evidence.length > 0
  if (!good) console.log(`       ${p} -> ${r.kind}（期望 ${want}）依据 ${(r.evidence || []).length} 条`)
  if (good) clsOk++
}
ok(clsOk === CASES.length, `已知样本分类正确且都带依据（${clsOk}/${CASES.length}）`)

// ②b 越界闸：包外的文件一个课程包类型都不许判
//     最坏的一种错是"自信地错"—— lib/pack.js 里含 data-lesson-meta 字面量，
//     去掉这道闸它会被判 lesson-src／把握 0.9 ✗
const OUTSIDE = [
  'E:/workplace/dsh-whale-sensei/lib/pack.js', // 绝对路径、含标记字面量的插件源码
  '../dsh-whale-sensei/lib/pack.js', // 同一文件的相对越界写法
]
let gateOk = 0
for (const p of OUTSIDE) {
  const r = probePath(ROOT, p, pack)
  const good = r.kind === 'unknown' && r.confidence === 1.0 && r.evidence.length > 0
  if (!good) console.log(`       ${p} -> ${r.kind}／把握 ${r.confidence}（期望 unknown／1.0）`)
  if (good) gateOk++
}
ok(gateOk === OUTSIDE.length, `包外路径判"越界·不判定"（${gateOk}/${OUTSIDE.length}）`)

// ③ 干净包：audit 无发现
const clean = auditPack(ROOT, pack)
ok(clean.findings.length === 0, `干净包没有发现项${clean.findings.length ? '（实际 ' + clean.findings.length + '：' + clean.findings.map((f) => f.message).join('；') + '）' : ''}`)

// ④ 证伪：影子副本
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-audit-'))
try {
  // 复制课程包（**故意不复制 static.svg** → 应该报"缺产物/静默降级"）
  fs.cpSync(path.join(ROOT, 'lessons'), path.join(tmp, 'lessons'), { recursive: true })
  // 顺带把链接目标也带上，否则"缺 assets"的噪声会淹掉我们真正想验的那几条 ✗
  for (const extra of ['assets', 'starmap', 'reference']) {
    const src = path.join(ROOT, extra)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, extra), { recursive: true })
  }
  for (const f of ['progress.json', 'GLOSSARY.md']) {
    const src = path.join(ROOT, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f))
  }
  // 再**删掉**静态版：这样"缺静态版"才是我们故意造的，而不是"没拷"
  fs.rmSync(path.join(tmp, 'starmap', 'static.svg'), { force: true })
  fs.copyFileSync(path.join(ROOT, 'starmap', 'content.js'), path.join(tmp, 'starmap', 'content.js'))
  // ③ 内容嗅探不许被"提到过标记"骗到：放一个只**提到**标记的普通文件（在包内）
  fs.writeFileSync(
    path.join(tmp, 'notes-mention.md'),
    '课程源文件里有 <script> 开头的东西，正文里也写了 data-lesson-meta 这个词，但它本身不是课程。\n',
    'utf8'
  )

  // ① 给一个产物页塞一条死链
  const page = pack.lessons[0].href
  const abs = path.join(tmp, page)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('</body>', '<a href="./nope-不存在.html">x</a></body>'), 'utf8')
  // ② 造一个课程 id 重复：把同一份源拷成第二个文件名（课号相同 → id 相同）
  const SRC_ROOT = path.join(tmp, 'lessons', 'src')
  // 递归（分层布局后源文件在 lessons/src/<圆圈>/<知识点>/ 下）
  const srcs = (function walk(d, prefix = '') {
    const out = []
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { out.push(...walk(path.join(d, e.name), rel)); continue }
      if (/^\d{4}-.*\.html$/.test(e.name)) out.push(rel)
    }
    return out
  })(SRC_ROOT)
  if (srcs[0]) {
    const from = path.join(SRC_ROOT, srcs[0])
    // 同目录内造重复课号：层级必须一致，否则 build-lessons 会拒「源文件层级混用」
    fs.copyFileSync(from, path.join(path.dirname(from), '0001-dup.html'))
  }

  const badPack = readPack(tmp)
  const r = auditPack(tmp, badPack)
  const blob = JSON.stringify(r.findings)
  ok(r.findings.length > 0, `坏样被抓到（${r.findings.length} 个发现项）`)
  ok(/nope-不存在/.test(blob), '坏样里的**死链**被报出')
  ok(/重复|duplicate|dup/i.test(blob) || /0001/.test(blob), '坏样里的**id 重复**被报出')
  ok(/static\.svg/.test(blob), '坏样里**缺静态版 SVG**被报出')
  ok(
    probePath(tmp, 'notes-mention.md', badPack).kind !== 'lesson-src',
    '只**提到**标记的文件不许被判成课程源（嗅探认标签、不认裸字面量）'
  )
  if (fails.length) { console.log('  坏样发现项明细：'); for (const f of r.findings.slice(0, 10)) console.log(`    [${f.severity}] ${f.id} @ ${f.file || ''} — ${f.message}`) }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 源头收敛：**没有行号的发现项不许带 `line` 键**（键集断言，不是值断言）
//    背景：五处调用（duplicate-id×2 / ghost-progress / missing-artifact /
//    silent-degradation）本来就没有行号；以前 add() 无条件写 line ⇒ `line: undefined`
//    ⇒ 宿主以 "value is not lossless JSON" 拒收**整次调用**（SESSION-LESSONS 204）。
// ⑥ 端到端：**没建星图的空包影副本**上跑 whale_audit 工具 —— 不许抛 / 不许回宿主级错误。
// ⑦ lossless JSON：对返回对象**递归找 undefined**（⚠️ 不用 JSON.stringify 往返 ——
//    它会把 undefined 悄悄丢掉，等于自己销毁证据）；status 路由的返回体同样核一遍。
// ⑧ 反空转：把 add() 临时改回"无条件写 line"（突变体只写 tmpdir）→ 判据必须报出来。
// ══════════════════════════════════════════════════════════════════════════
const NO_LINE = new Set(['duplicate-id', 'ghost-progress', 'missing-artifact', 'silent-degradation'])
const KS5 = ['id', 'severity', 'file', 'message', 'hint'].sort().join(',')
const KS6 = ['id', 'severity', 'file', 'line', 'message', 'hint'].sort().join(',')
const keySet = (f) => Object.keys(f).sort().join(',')
/** 判据本体（⑤与⑧共用同一份纯函数）：没行号的发现项却带了 `line` 键 = 违例 */
const lineKeyViolations = (findings) => findings.filter((f) => NO_LINE.has(f.id) && Object.keys(f).includes('line'))
/** 递归找 `undefined` —— 走 Object.keys（`{line: undefined}` 的键在），不经 stringify */
const findUndefined = (v, p = 'value', out = []) => {
  if (v === undefined) { out.push(p); return out }
  if (v === null || typeof v !== 'object') return out
  if (Array.isArray(v)) { v.forEach((x, i) => findUndefined(x, `${p}[${i}]`, out)); return out }
  for (const k of Object.keys(v)) findUndefined(v[k], `${p}.${k}`, out)
  return out
}

const tmpDirs = []
try {
  // ⑤ 假包（纯函数伪造入参）：五类"没行号"的发现 + 一类"有行号"的（死链）全触发
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-noline-')); tmpDirs.push(fakeRoot)
  fs.writeFileSync(path.join(fakeRoot, 'p.html'), '<html><body><a href="./nope-404.html">x</a></body></html>', 'utf8')
  const fakePack = {
    lessons: [
      { id: 'pt/0001', href: 'p.html' },    // 死链（**有**行号 —— 正向对照）
      { id: 'pt/0001', href: 'gone.html' }, // 课程 id 重复 + 缺产物
    ],
    points: [{ id: 'pt' }, { id: 'pt' }],   // 知识点 id 重复
    learned: ['ghost/0009'],                // 幽灵进度
    // ⚠️ 这个假包**必须有圆圈**：`static.svg` 是**有条件**要的产物（0 个圆圈时生成器
    //    刻意 exit 1，与 `lib/verify.js` ⑤ 同一口径）。不给 circles 的话，
    //    「三件产物缺失都触发」这条断言就只能数到 2 条 —— 那是夹具漏了前提，不是实现漏了。
    //    （0 个圆圈那一侧由下面的 [端到端] 空包 + [反空转] 有圆圈 两条覆盖。）
    circles: [{ id: 'pt', name: '测试圆圈', points: [] }],
  }
  const r5 = auditPack(fakeRoot, fakePack)
  const gotIds = r5.findings.map((f) => f.id)
  for (const want of ['duplicate-id', 'ghost-progress', 'missing-artifact', 'silent-degradation', 'dead-link']) {
    ok(gotIds.includes(want), `[源头] 假包触发到 ${want}（没触发 = 判据没牙）`)
  }
  ok(r5.findings.filter((f) => f.id === 'duplicate-id').length === 2, '[源头] duplicate-id 课/点两处调用都触发')
  ok(r5.findings.filter((f) => f.id === 'silent-degradation').length === 3, '[源头] silent-degradation 三件产物缺失都触发')
  const viol5 = lineKeyViolations(r5.findings)
  ok(viol5.length === 0, `[源头] 没行号的发现项一个都不带 line 键${viol5.length ? '（违例：' + viol5.map((f) => f.id).join('、') + '）' : ''}`)
  ok(
    r5.findings.every((f) => keySet(f) === (NO_LINE.has(f.id) ? KS5 : KS6)),
    '[源头] 键集断言：没行号 = 恰好 5 键、有行号 = 恰好 6 键（键集，不是值）'
  )
  const withLine = r5.findings.filter((f) => 'line' in f)
  ok(
    withLine.length > 0 && withLine.every((f) => f.id === 'dead-link' && typeof f.line === 'number'),
    '[源头] 正向对照：死链那条仍然带数字行号（收敛没把行号一起弄丢）'
  )

  // ⑥ 端到端：没建星图的空包影副本（os.tmpdir()，只有 lessons/，不建 starmap/）
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-emptypack-')); tmpDirs.push(emptyRoot)
  fs.mkdirSync(path.join(emptyRoot, 'lessons'))
  const tools = []
  const mod = await import('../lib/mods/audit.js')
  mod.plugin.install({ paths: { packRoot: emptyRoot, dataDir: emptyRoot }, log: () => {}, registerTool: (d) => tools.push(d) })
  const tool = tools.find((t) => t.name === 'whale_audit')
  let value = null
  let threw = null
  try { value = await tool.execute({ root: emptyRoot }) } catch (e) { threw = e }
  ok(threw === null && value !== null, `[端到端] 空包上 whale_audit 不抛异常${threw ? '（抛了：' + threw.message + '）' : ''}`)
  if (value) {
    ok(!('error' in value), `[端到端] 不回宿主级错误${'error' in value ? '（回了：' + value.error + '）' : ''}`)
    // ⚠️ 这个空包**0 个圆圈** ⇒ `static.svg` **不该**被判"缺产物"：它的唯一产出者
    //    （build-starmap-svg ← build-starmap）对 0 个圆圈**刻意 exit 1**（反空转：不许画假图）。
    //    口径与 `lib/verify.js` ⑤ **同一处**（板子 A–H 的 D 条：新包一建出来就吃 warn 是误报）。
    //    所以这里只有 **2** 条。
    const want = [
      'silent-degradation@reference/NOTES.html',
      'silent-degradation@starmap/content.js',
    ]
    const got = value.findings.map((f) => `${f.id}@${f.file}`).sort()
    ok(got.join(' | ') === want.join(' | '), `[端到端] 如实报出该报的发现项（${got.length} 条：${got.join(' / ')}）`)
    ok(value.ok === true && /2 个发现项/.test(value.summary), `[端到端] 摘要如实（${value.summary}）`)
    ok(!got.includes('silent-degradation@starmap/static.svg'),
      '[端到端] 0 个圆圈时**不**报 static.svg（生成器按规矩不产出的东西，不该反过来说使用者缺产物）')
    ok(Array.isArray(value.warnings), `[端到端] readPack 告警原样带出（${value.warnings.length} 条）`)

    // ⑦a 反空转：**有圆圈**的同款包必须**照旧报** static.svg
    //     —— 证明上一条不是把这条检查整个废掉了（不然就是"修好一个误报、关掉一个真检查"）。
    const oneHalo = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-onehalo-')); tmpDirs.push(oneHalo)
    fs.mkdirSync(path.join(oneHalo, 'lessons', 'math'), { recursive: true })
    fs.writeFileSync(path.join(oneHalo, 'lessons', 'math', 'halo.json'),
      JSON.stringify({ halo: 'math', name: '数学' }, null, 2) + '\n', 'utf8')
    const vOne = await tool.execute({ root: oneHalo })
    const sdOne = (vOne.findings || []).filter((f) => f.id === 'silent-degradation').map((f) => f.file)
    ok(sdOne.includes('starmap/static.svg'),
      `[反空转] 有圆圈时 static.svg 照旧报（${sdOne.join(' / ') || '（一条都没有）'}）`)

    // ⑦ lossless JSON：递归找 undefined（两次返回对象都跑；不用 stringify 往返）
    const und = findUndefined(value, 'whale_audit 返回值')
    ok(und.length === 0, `[lossless] whale_audit 返回值递归找 undefined：0 处${und.length ? '（' + und.slice(0, 4).join('、') + '）' : ''}`)
    let hostErr = null
    try { assertLosslessJson(value, 'value') } catch (e) { hostErr = e.message }
    ok(hostErr === null, `[lossless] 宿主级护栏 assertLosslessJson 收得下${hostErr ? '（拒了：' + hostErr + '）' : ''}`)
    const rendered = tool.output.render({ root: emptyRoot }, value)
    ok(Array.isArray(rendered) && rendered.every((x) => typeof x?.text === 'string'), '[端到端] render 也吃得下空包的结果（一打开就崩不止是 execute）')

    // ⑦b status 路由（也调 auditPack）：返回体在 **stringify 之前**的原对象上找 undefined
    const cap = []
    const statusMod = await import('../lib/mods/status.js')
    statusMod.plugin.install({
      paths: { packRoot: emptyRoot, dataDir: emptyRoot },
      log: () => {},
      registerTool: () => {},
      inject: (_names, cb) => cb({ get: () => ({ fetch: { register: (r) => cap.push(r) } }) }),
    })
    const route = cap.find((r) => r.path === '/api/whale/status')
    ok(!!route, '[lossless] status 路由在册（它也调 auditPack，同样要核）')
    if (route) {
      const seen = []
      const orig = JSON.stringify
      JSON.stringify = (v, ...rest) => { seen.push(v); return orig(v, ...rest) }
      let sErr = null
      try { await route.fetch(new Request('http://127.0.0.1/api/whale/status', { method: 'GET' })) }
      catch (e) { sErr = e } finally { JSON.stringify = orig }
      ok(sErr === null, `[端到端] 空包上 status 路由不抛异常${sErr ? '（抛了：' + sErr.message + '）' : ''}`)
      const body = seen.find((v) => v && typeof v === 'object' && 'ok' in v && 'packRoot' in v)
      ok(!!body, '[lossless] 捕获到 status 返回体（stringify 之前的原对象 —— 不是往返回来的）')
      if (body) {
        const sUnd = findUndefined(body, 'status 返回体')
        ok(sUnd.length === 0, `[lossless] status 返回体递归找 undefined：0 处${sUnd.length ? '（' + sUnd.slice(0, 4).join('、') + '）' : ''}`)
        let sHost = null
        try { assertLosslessJson(body, 'body') } catch (e) { sHost = e.message }
        ok(sHost === null, `[lossless] status 返回体过宿主级护栏${sHost ? '（拒了：' + sHost + '）' : ''}`)
      }
    }
  }

  // ⑧ 反空转：突变体 = 把 add() 改回"无条件写 line"（只写 tmpdir，真源码一个字节没动）
  {
    const src = fs.readFileSync(fileURLToPath(new URL('../lib/audit.js', import.meta.url)), 'utf8')
    const MARK = 'if (line !== undefined) f.line = line'
    ok(src.includes(MARK), '[反空转] 源码里找得到"按需写 line 键"的收敛点（找不到 = 判据要更新，不许静默跳过）')
    if (src.includes(MARK)) {
      const mutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mutant-')); tmpDirs.push(mutDir)
      const mutantPath = path.join(mutDir, 'audit-mutant.mjs')
      fs.writeFileSync(mutantPath, src.split(MARK).join('f.line = line'), 'utf8') // 改回无条件写
      const mutant = await import(pathToFileURL(mutantPath).href)
      const mr = mutant.auditPack(fakeRoot, fakePack) // 同一份纯函数 + 同一份伪造入参
      const mViol = lineKeyViolations(mr.findings)
      ok(mViol.length > 0, `[反空转] 突变体被键集判据报出 ${mViol.length} 处（${[...new Set(mViol.map((f) => f.id))].join('、')}）`)
      const mUnd = findUndefined(mr, 'value')
      ok(mUnd.length > 0, `[反空转] 递归找 undefined 也报出 ${mUnd.length} 处（${mUnd.slice(0, 3).join('、')}）`)
      let mHost = null
      try { assertLosslessJson(mr, 'value') } catch (e) { mHost = e.message }
      ok(!!mHost, `[反空转] 宿主级护栏同样拒收突变体（${mHost ? mHost.slice(0, 70) : '没拒 = 判据空转 ✗'}）`)
    }
  }
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
}

// 真包守卫收口：跑完再哈希一次 —— 一个字节都不许变
const realAfter = treeDigest(ROOT)
ok(
  realBefore === realAfter,
  `真包未被改动：整树内容哈希前后一致（${realBefore.split(':')[1]} 个文件）${realBefore === realAfter ? '' : ` 前 ${realBefore} ≠ 后 ${realAfter}`}`
)

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ probe 纯函数且判得准；audit 与干净包一致、坏样抓得到；line 键源头收敛、空包不崩、lossless、反空转')
