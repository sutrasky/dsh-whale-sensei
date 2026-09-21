#!/usr/bin/env node
/**
 * test/build-verify.mjs — T3 判据：**用第 1 课的现有内容当回归样本**
 * ------------------------------------------------------------------
 * 跑：node test/build-verify.mjs [课程包根]
 * 判：`verifyPack()` 对**现在这份课程包**判定为"产物一致" ✓，
 *     并且**故意破坏一处**时必须报出那处（带 id/文件/期望 vs 实际）—— 判据自己也要被证伪一次。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { verifyPack } from '../lib/verify.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

console.log(`\n[build] 课程包：${ROOT}`)

const pack = readPack(ROOT)
const r = verifyPack(ROOT, pack)
console.log('  检查项：')
for (const c of r.checks) console.log(`    ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)

ok(r.consistent, `产物与课程包一致${r.consistent ? '' : '：' + r.drift.join('；')}`)
ok(pack.lessons.length > 0, `课程包里有课（${pack.lessons.length} 门）`)

// —— 证伪：拿一份**影子副本**，故意打断一门课的深链，必须被抓到 ——
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-verify-'))
try {
  const l0 = pack.lessons[0]
  const rel = l0.href
  fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'starmap'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'reference'), { recursive: true })
  // 一份"内容被换掉"的产物：标题与深链都对不上
  fs.writeFileSync(path.join(tmp, rel), '<html><head><title>别的课</title></head><body>无深链</body></html>', 'utf8')
  fs.copyFileSync(path.join(ROOT, 'starmap', 'content.js'), path.join(tmp, 'starmap', 'content.js'))
  fs.copyFileSync(path.join(ROOT, 'starmap', 'static.svg'), path.join(tmp, 'starmap', 'static.svg'))
  fs.copyFileSync(path.join(ROOT, 'reference', 'NOTES.html'), path.join(tmp, 'reference', 'NOTES.html'))
  const bad = verifyPack(tmp, pack)
  ok(!bad.consistent, `坏样必须被判不一致（抓到 ${bad.drift.length} 处）`)
  ok(bad.drift.some((d) => d.includes(l0.id) && d.includes('标题')), `坏样里"标题不一致"要指名道姓到 ${l0.id}`)
  ok(bad.drift.some((d) => d.includes(l0.id) && d.includes('深链')), '坏样里"深链缺失"也要被报出')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 产物校验可用，且坏样会被抓出')
