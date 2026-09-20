/**
 * lib/glossary-io.js — GLOSSARY.md 的 IO 薄壳（读台账 / 对拍 / 落盘）
 * ------------------------------------------------------------------
 * 生成逻辑全在 `lib/glossary.js`（纯）。这里只做三件事：
 *   1. 读术语台账 `assets/glossary-data.js`（CommonJS，用 createRequire；写完要清缓存）
 *   2. 与磁盘上的 `GLOSSARY.md` 对拍（**这是原本完全没有的一道检查**）
 *   3. 原子落盘（照抄 build-glossary.js:23-27 的 writeAtomic 语义：临时文件 + rename）
 *
 * ⚠️ 不重实现 `tools/check-terms.js` 的 14 项检查（页面 ↔ 台账的双向对账它已经做了 ✗）
 *    —— 那部分插件只该"报告/调用"，不该复制一份语义。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildGlossaryMarkdown } from './glossary.js'

const requireCJS = createRequire(import.meta.url)

/** 台账与产物路径 */
export function glossaryFiles(root) {
  return {
    ledger: path.join(root, 'assets', 'glossary-data.js'),
    out: path.join(root, 'GLOSSARY.md'),
  }
}

/** require 术语台账（先清缓存：同一个进程里改了台账再读，必须拿到新的） */
export function loadGlossaryLedger(root) {
  const { ledger } = glossaryFiles(root)
  delete requireCJS.cache[ledger]
  return requireCJS(ledger)
}

/** 台账 → 应当写进 GLOSSARY.md 的全文（纯合成的入口） */
export function expectedGlossaryMarkdown(root) {
  return buildGlossaryMarkdown(loadGlossaryLedger(root))
}

/** 首个差异的位置（行/列 + 两侧长度）—— 报"不一致"必须能落到具体位置 */
export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const line = a.slice(0, i).split('\n').length
  const col = i - (a.lastIndexOf('\n', i - 1) + 1)
  return `第 ${line} 行第 ${col} 列（磁盘 ${a.length} 字符 / 合成 ${b.length} 字符）`
}

/**
 * 对拍：磁盘上的 GLOSSARY.md 是否等于"由当前台账合成"的结果。
 * @returns {{ consistent: boolean, missing: boolean, detail: string, diskChars: number, expectedChars: number }}
 */
export function glossaryDrift(root) {
  const { out } = glossaryFiles(root)
  const expected = expectedGlossaryMarkdown(root)
  let disk = null
  try {
    disk = fs.readFileSync(out, 'utf8')
  } catch {
    return { consistent: false, missing: true, detail: `磁盘上没有 ${path.basename(out)}`, diskChars: 0, expectedChars: expected.length }
  }
  if (disk === expected) {
    return { consistent: true, missing: false, detail: '与台账合成结果逐字节一致', diskChars: disk.length, expectedChars: expected.length }
  }
  return { consistent: false, missing: false, detail: firstDiff(disk, expected), diskChars: disk.length, expectedChars: expected.length }
}

/**
 * 原子落盘：先写 `.tmp-<pid>` 再 rename（搬 build-glossary.js:23-27）。
 * 内容没变就不重写（不白刷 mtime）。
 * @returns {{ path: string, changed: boolean, chars: number }}
 */
export function writeGlossary(root) {
  const { out } = glossaryFiles(root)
  const expected = expectedGlossaryMarkdown(root)
  let prev = null
  try {
    prev = fs.readFileSync(out, 'utf8')
  } catch {
    /* 不存在 → 要写 */
  }
  if (prev === expected) return { path: 'GLOSSARY.md', changed: false, chars: expected.length }
  const tmp = `${out}.tmp-${process.pid}`
  fs.writeFileSync(tmp, expected, 'utf8')
  fs.renameSync(tmp, out)
  return { path: 'GLOSSARY.md', changed: true, chars: expected.length }
}

/** 台账概览（给工具输出用）：条数 / 分类数 / 缺字段的条目 */
export function glossarySummary(ledger) {
  const keys = Object.keys(ledger)
  const cats = new Set()
  const missing = []
  for (const k of keys) {
    const it = ledger[k] || {}
    cats.add(it.category || '未分类')
    const lack = ['label', 'short', 'analogy'].filter((f) => !it[f])
    if (lack.length) missing.push(`${k} 缺 ${lack.join('/')}`)
  }
  return { count: keys.length, categories: cats.size, missing }
}
