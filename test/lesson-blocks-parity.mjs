#!/usr/bin/env node
/**
 * test/lesson-blocks-parity.mjs —— `lesson-blocks.css` 两个生成器的对拍（#10 缺口②）
 * ------------------------------------------------------------------
 * 跑：node test/lesson-blocks-parity.mjs
 *
 * 为什么要这条：`lesson-blocks.css` 是**唯一会被反向抽取反复重写**的产物，而
 * `test/render-parity.mjs` **显式把它排除**在逐字节对拍外 ⇒ 两个生成器漂了，
 * **没有任何测试会红**。
 *   ① 课程包侧 `tools/build-lessons.js` 的 `emitBlocks()`（`--extract` 时落盘）
 *   ② 插件侧 `lib/render.js` 的 `mergeBlocks()`（`render-inputs.js` 的 planExtract → writePlan）
 *
 * 做法：**真跑**课程包那条路 —— 在影副本里给一个真页面注入一段已知的 `<style>`，
 * 跑 `--extract`（不带 `--no-blocks`），把落盘的 `assets/lesson-blocks.css` 与
 * `mergeBlocks()` 拿**同一份 css** 算出来的结果**逐字节**比。
 *
 * ⚠️ 全程在 `os.tmpdir()` 影副本里跑，真包一个字节都不动（跑完复核哈希）。
 * 反空转：把 mergeBlocks 的输出改一个字节（例如头注释里的规则数）⇒ 必须红。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mergeBlocks } from '../lib/render.js'
import { packRoot } from './_pack.mjs'

const PACK = packRoot()
let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

console.log(`\n[lesson-blocks] 课程包：${PACK}`)

// 夹具：刻意含**同名重复选择器**（只留第一份）与多行规则 —— 那才是合并算法的考点
const FIX_CSS = [
  '.fixture-box { color: var(--dsw-alias-label-primary); }',
  '.fixture-grid {',
  '  display: grid;',
  '  gap: 4px;',
  '}',
  '.fixture-box { color: red; }',
  '',
].join('\n')

const PAGE_REL = 'lessons/math/alge/0001-algebra-basics.html'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-blocks-'))
const LOG = path.join(tmp, '_log.txt')
const snap = (d) => { const out = []; const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(d, p) + ':' + fs.statSync(p).size) } }; walk(d); return out.sort().join('\n') }

try {
  // 只拷跑抽取必需的三棵树
  for (const d of ['tools', 'assets', 'lessons']) fs.cpSync(path.join(PACK, d), path.join(tmp, d), { recursive: true })
  const before = snap(path.join(PACK, 'lessons')) + snap(path.join(PACK, 'assets'))

  // ① 给真页面注入一段已知 <style>（现行产物里没有内联 <style> ⇒ 注入后 styles 恰好是这一份）
  const pageAbs = path.join(tmp, PAGE_REL)
  const page = fs.readFileSync(pageAbs, 'utf8')
  ok(!/<style[\s>]/i.test(page), '前置：这一页本来没有内联 <style>（现行产物的形态）—— 所以注入后 styles 恰好一份')
  fs.writeFileSync(pageAbs, page.replace('</head>', `<style>\n${FIX_CSS}</style>\n</head>`))

  // ② 真跑课程包那条路（输出写文件、不走管道 —— 与课程包侧同一条纪律）
  const fd = fs.openSync(LOG, 'w')
  let ran = false
  try {
    execFileSync(process.execPath, ['tools/build-lessons.js', '--extract', PAGE_REL], { cwd: tmp, stdio: ['ignore', fd, fd] })
    ran = true
  } catch (e) { /* 下面按 ran 判 */ } finally { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  ok(ran, `影副本里跑 \`--extract\`（含样式合并）退出码 0${ran ? '' : ' —— ' + (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').replace(/\s+/g, ' ').slice(0, 200) : '')}`)

  // ③ 两个生成器逐字节比
  const got = fs.readFileSync(path.join(tmp, 'assets', 'lesson-blocks.css'), 'utf8')
  const want = mergeBlocks([{ file: PAGE_REL, css: FIX_CSS }])
  ok(got === want, `课程包 emitBlocks 与插件 mergeBlocks **逐字节相同**（${got.length} 字符 · ${got.split('\n').length} 行）`)
  if (got !== want) {
    const a = got.split('\n'); const b = want.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.log(`       首个差异在第 ${i + 1} 行：\n         课程包: ${JSON.stringify(a[i])}\n         插件  : ${JSON.stringify(b[i])}`); break }
    }
  }
  ok(got.includes('含 2 条规则'), `同名重复选择器只留第一份（.fixture-box 去重后共 2 条规则）—— 合并语义两边一致`)

  // ④ 真包零改动
  const after = snap(path.join(PACK, 'lessons')) + snap(path.join(PACK, 'assets'))
  ok(before === after, '真包零改动（lessons + assets 全树 path:size 前后相同）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ lesson-blocks.css 的两个生成器逐字节一致 · 去重语义一致 · 真包未动')
