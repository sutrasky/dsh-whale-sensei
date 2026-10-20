/**
 * lib/glossary-io.js — GLOSSARY.md 的 IO 薄壳（ESM 适配层；计算在 `lib/unify/glossary.cjs`）
 * ------------------------------------------------------------------
 * 生成逻辑全部在权威内核里（纯）。这里只做三件事：
 *   1. 读术语台账 `assets/glossary-data.js`（CommonJS；**同进程改完再读必须拿到新的**）
 *   2. 与磁盘上的 `GLOSSARY.md` 对拍（**这是原本完全没有的一道检查**）
 *   3. 原子落盘（临时文件 + rename）
 *
 * ⚠️ 读取失败**不许伪装成空词表**：读不动 / 坏账 / 不是记录对象一律**抛**
 *    （`err.status` 是 U03 的五态之一，`err.failure` 是统一失败结构，系统码原样保留）。
 *    只有**合法空集合**（出厂骨架那种）才返回 `{}`。
 *
 * ⚠️ 不重实现 `tools/check-terms.js` 的 14 项检查（页面 ↔ 台账的双向对账它已经做了 ✗）
 *    —— 那部分插件只该"报告/调用"，不该复制一份语义。
 *
 * **MIRROR-OF（历史）**：包侧曾是 `assets/build-glossary.js` 的第二份实现。U11 起两侧
 * 共用 `lib/unify/glossary.cjs` 一份计算 + 一份读取/落盘语义，"会不会漂"从结构上消失。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const requireCJS = createRequire(import.meta.url)
const core = requireCJS('./unify/glossary.cjs')

/** 台账与产物路径 */
export function glossaryFiles(root) {
  return {
    ledger: path.join(root, ...core.GLOSSARY_LEDGER_REL.split('/')),
    out: path.join(root, core.GLOSSARY_OUT_REL),
  }
}

/**
 * require 术语台账（先清缓存：同一个进程里改了台账再读，必须拿到新的）。
 *
 * 五态口径（与 `lib/unify/ledger-read.cjs` 同一套）：
 *   `ok` / `empty` → 返回台账对象（空集合是**合法**的，出厂骨架就是 `{}`）
 *   `missing`      → 抛（`err.status='missing'`、`err.errorCode='ENOENT'`）
 *   `invalid`      → 抛（`err.failure.code='LEDGER_INVALID'`）
 *   `io-error`     → 抛（`err.failure.code='IO_ERROR'` + 系统码原样）
 */
export function loadGlossaryLedger(root) {
  const { ledger } = glossaryFiles(root)
  const result = core.loadLedger({ abs: ledger, fs, requireFrom: requireCJS })
  if (result.status === 'ok' || result.status === 'empty') return result.ledger
  throw core.ledgerLoadError(result)
}

/** 台账 → 应当写进 GLOSSARY.md 的全文（纯合成的入口） */
export function expectedGlossaryMarkdown(root) {
  const title = core.readGlossaryTitle({ configPath: path.join(root, core.LESSON_CONFIG_REL), fs })
  return core.buildGlossaryMarkdown(loadGlossaryLedger(root), { title })
}

/** 首个差异的位置（行/列 + 两侧长度）—— 报"不一致"必须能落到具体位置 */
export const firstDiff = core.firstDiff

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
 * 原子落盘：先写 `.tmp-<pid>` 再 rename（内核 `atomicWrite`，改前两侧各一份的那件事）。
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
  if (prev === expected) return { path: core.GLOSSARY_OUT_REL, changed: false, chars: expected.length }
  core.atomicWrite({ target: out, content: expected, fs })
  return { path: core.GLOSSARY_OUT_REL, changed: true, chars: expected.length }
}

/** 台账概览（给工具输出用）：条数 / 分类数 / 缺字段的条目 */
export const glossarySummary = core.glossarySummary
