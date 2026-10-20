/**
 * lib/glossary.js — 名词台账 → GLOSSARY.md：ESM 适配层（权威实现在 `lib/unify/glossary.cjs`）
 * ------------------------------------------------------------------
 * U 系列（U-SPEC §5）把「术语计算与源码序列化」收为**单一源码**。本文件只做两件事：
 *   ① 桥：`createRequire(import.meta.url)` 拿到 CJS 内核，**具名再导出**（导出面逐字保留：
 *      `slug` / `categorize` / `parseTermKeys` / `termRecordSource` / `upsertTermSource` /
 *      `buildGlossaryMarkdown`，签名/默认值/返回形状都不变）；
 *   ② 说明这个模块为什么存在（下面那段搬运史与判据仍然是它存在的理由）。
 *
 * 搬运史：本文件原来逐字搬运课程包 `assets/build-glossary.js`（166 行）的生成逻辑，
 * 只把 IO 剥掉（原脚本第 29 行的 `require(SRC)` → 改成参数 `ledger` 传进来；
 * 原脚本 162-166 行的写盘与 `console.log` → 由 `lib/glossary-io.js` 负责）。
 * 为什么值得搬：那个脚本**没有 `--check`**，所以 GLOSSARY.md 一旦忘了重建，
 * 没有任何东西会发现它跟台账不一致 ✗（课程包自己的 gate 也抓不到）。搬进插件后
 * 就能"合成 → 与磁盘逐字节对拍"，跟 theme.css 那套一样。
 *
 * **MIRROR-OF（历史）**：包侧曾是 `assets/build-glossary.js` 的第二份实现，对拍落在
 * `test/glossary-verify.mjs`（拿 CLI 当 oracle）。U11 起包侧只是
 * `require('../tools/unify/glossary.cjs')` 的薄包装器 —— 对拍照跑（它判的是行为），
 * 但"两份实现会不会漂"这件事从结构上消失了。
 */
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const core = require_('./unify/glossary.cjs')

/** 生成 GitHub 风格的标题锚点：@GetMapping -> getmapping */
export const slug = core.slug

/**
 * 按**数据顺序**聚合分类。顺序很重要：Markdown 里的目录与分类顺序都取决于它，
 * 乱一点就不是逐字节一致了。
 * @returns {{ categories: string[], byCategory: Map<string, object[]>, entries: object[] }}
 */
export const categorize = core.categorize

/** 顶层映射里已有的键名（按出现顺序） */
export const parseTermKeys = core.parseTermKeys

/** 一条记录的源码块（字段顺序与数据源一致；code 可选） */
export const termRecordSource = core.termRecordSource

/**
 * 在数据源里插入或替换一条记录，返回新源码（纯函数）。
 * @param {string} src 源文件全文
 * @param {string} key 顶层键名（合法标识符）
 * @param {object} record { label, category, official, short, analogy, code?, lesson }
 * @param {{replace?: boolean}} [opts] replace=false 时键已存在就抛错（只追加不覆盖）
 */
export const upsertTermSource = core.upsertTermSource

/**
 * 合成 GLOSSARY.md 全文。
 * 末尾**不带**换行：原脚本是 `L.join('\n')` 直接写盘，最后一项是空串，
 * 所以文件以 `\n` 收尾 —— 这个细节必须一致，否则逐字节对拍会差一个字节。
 *
 * @param {object} ledger glossary-data.js 导出的对象
 * @param {{title?: string}} [opts]
 * @returns {string}
 */
export const buildGlossaryMarkdown = core.buildGlossaryMarkdown
