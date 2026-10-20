/**
 * lib/text.js — 读文本时的**本机已知坑位**：ESM 适配层（权威实现在 `lib/unify/text.cjs`）
 * ------------------------------------------------------------------
 * U 系列（U-SPEC §5）把三类确定性计算收为**单一源码**：文本助手 / 大纲判据 / 内容指纹
 * 的唯一计算都在 `lib/unify/*.cjs` 里。本文件只做两件事：
 *   ① 桥：`createRequire(import.meta.url)` 拿到 CJS 内核，**具名再导出**（导出面逐字保留：
 *      `stripBom` / `splitLines` / `parseJsonLoose`，签名与默认值不变）；
 *   ② 说明为什么需要它（下面这段坑位史仍然是这个模块存在的理由）。
 *
 * 为什么单独一个文件：这条规矩在本仓库被踩过不止一次 ——
 * PowerShell 用 `Set-Content` / `Add-Content -Encoding utf8` 写出来的文件
 * **开头会带 BOM**（`EF BB BF`），于是：
 *   · `JSON.parse` 直接抛（"Unexpected token \uFEFF"）
 *   · 逐行解析时那一行被 `catch` 成 null → **静默丢掉一条真数据**（比抛更坏 ✗）
 * 课程包自己的脚本都专门剥它（`tools/drain-questions.js:30`、`tools/ask-watch.js:52-54`），
 * 插件这边也必须剥 —— 现场就因为没剥，让"队列里明明有这条"变成了"找不到这个 id" ✗
 *
 * 用法：`JSON.parse(stripBom(fs.readFileSync(f, 'utf8')))`
 * 逐行解析时**每行都要剥**：PowerShell 的追加会把 BOM 写进中间某一行。
 *
 * **同源实现（历史）**：包侧曾是 `tools/pack-text.js` 的第二份实现，对拍落在
 * `test/mirror-parity.mjs`。U04 起包侧只是 `require('./unify/text.cjs')` 的薄包装器 ——
 * 对拍仍然在跑（判"两侧行为一致"），但"两份实现会不会漂"这件事从结构上消失了。
 */
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const core = require_('./unify/text.cjs')

/** 剥掉字符串开头的 BOM（只剥开头；中间出现的 BOM 由逐行调用者各自剥） */
export const stripBom = core.stripBom

/** 逐行剥 BOM 并切行（空行由调用方决定要不要跳） */
export const splitLines = core.splitLines

/** JSON.parse，但先剥 BOM。抛错时错误信息里点明"可能是 BOM/编码问题" */
export const parseJsonLoose = core.parseJsonLoose
