#!/usr/bin/env node
/**
 * test/pack-parity.mjs — T2 的判据：**同输入 → 同输出**
 * ------------------------------------------------------------------
 * 跑：node test/pack-parity.mjs [课程包根]
 * 判：`lib/pack.js` 读出来的课程包，与**现有工具链**（tools/build-starmap.js）产出的
 *     `starmap/content.js` 在**包级字段**上一致：id / point / number / label / title /
 *     href / learned / termCount(+source)。
 *
 * 为什么只比"包级字段"：星图那些派生量（shape / orbit / 坐标 / size / bright）属于星图那条线，
 * 现在还在 `tools/` 里；等 T3 的 `whale_build` 接管时再收进 pack。**这一点是明确缩小的范围，不是漏做**。
 *
 * 差异一律**列清每一处**（照 M2 的硬规矩：不许只回"失败"）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { readPack as readPackFromModel, packSummary as packSummaryFromModel } from '../lib/pack-model.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')

let pass = 0
const fails = []
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`) } else { fails.push(msg); console.log(` FAIL ${msg}`) } }

console.log(`\n[pair] 课程包：${ROOT}`)

// ── ⑩ 实现只有一份（2026-09-24 交接队列②）──────────────────────────────
// 判据用**函数同一性**，不是 grep：`lib/pack.js` 必须只是 `pack-model.js` 的再导出。
// 这条钉的是"不要出现第二条路径解析线"——原先 readPack 与 lessonIndex 各解析一遍。
ok(readPack === readPackFromModel, 'lib/pack.js 与 pack-model.js 的 readPack 是同一个函数（实现只有一份，不是两份+对拍）')
ok(packSummaryFromModel === (await import('../lib/pack.js')).packSummary, 'packSummary 同样只有一份')

const pack = readPack(ROOT)
// 只允许"工具链也会报的"那几类告警（历史平铺、幽灵进度）—— 别的告警一律算失败
const ignorable = /历史平铺|幽灵条目|目录重构/
const realWarn = pack.warnings.filter((w) => !ignorable.test(w))
ok(realWarn.length === 0, `readPack 没有"工具链不会报"的告警${realWarn.length ? '：' + realWarn.join('；') : ''}`)
if (pack.warnings.length) {
  console.log(`  （忽略 ${pack.warnings.length} 条工具链同款告警：${pack.warnings.map((w) => w.slice(0, 18) + '…').join(' / ')}）`)
}

// 现有工具链的产出（它自己会打印一堆日志，这里只读文件）
const contentFile = path.join(ROOT, 'starmap', 'content.js')
if (!fs.existsSync(contentFile)) {
  console.error(`找不到 ${contentFile} —— 先跑 node tools/build-starmap.js`)
  process.exit(2)
}
const window = {}
new Function('window', fs.readFileSync(contentFile, 'utf8'))(window)
const D = window.STARMAP_REAL

// —— 计数 ——
const wantCircles = (D.halos || []).length
const wantPoints = (D.halos || []).reduce((a, h) => a + (h.points || []).length, 0)
const wantLessons = (D.lessons || []).length
ok(pack.circles.length === wantCircles, `圆圈数一致（pack ${pack.circles.length} / 工具链 ${wantCircles}）`)
ok(pack.points.length === wantPoints, `知识点数一致（pack ${pack.points.length} / 工具链 ${wantPoints}）`)
ok(pack.lessons.length === wantLessons, `课程数一致（pack ${pack.lessons.length} / 工具链 ${wantLessons}）`)

// —— 逐课字段对拍 ——
const byId = new Map(pack.lessons.map((l) => [l.id, l]))
const fields = ['point', 'number', 'label', 'title', 'href', 'learned', 'termCount']
const diffs = []
for (const l of D.lessons || []) {
  const mine = byId.get(l.id)
  if (!mine) { diffs.push(`${l.id}：pack 里没有这门课`); continue }
  for (const f of fields) {
    const a = mine[f], b = l[f]
    if (a !== b) diffs.push(`${l.id}.${f}：pack=${JSON.stringify(a)} 工具链=${JSON.stringify(b)}`)
  }
}
ok(diffs.length === 0, `逐课包级字段一致（${(D.lessons || []).length} 门）${diffs.length ? '\n       ' + diffs.join('\n       ') : ''}`)

// —— 进度一致 ——
const wantLearned = (D.lessons || []).filter((l) => l.learned).map((l) => l.id).sort()
ok(JSON.stringify([...pack.learned].sort()) === JSON.stringify(wantLearned),
  `进度表一致（${wantLearned.length} 门已点亮）`)

// —— 反向：pack 里不该有工具链没有的课 ——
const extra = pack.lessons.filter((l) => !(D.lessons || []).some((x) => x.id === l.id)).map((l) => l.id)
ok(extra.length === 0, `pack 没有多出来的课${extra.length ? '：' + extra.join(',') : ''}`)

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 同输入 → 同输出（包级字段）')
