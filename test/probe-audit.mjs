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
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { probePath } from '../lib/probe.js'
import { auditPack } from '../lib/audit.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()

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

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ probe 纯函数且判得准；audit 与干净包一致、坏样抓得到')
