/**
 * lib/unify/text.cjs — 读文本时的**本机已知坑位**：权威实现（唯一一份计算）
 * ==================================================================
 * 为什么住 `lib/unify/`（U-SPEC §5）：文本助手曾经有两份逐字同源的实现 ——
 * 插件 `lib/text.js`（ESM）与课程包 `tools/pack-text.js`（CJS），靠 `test/mirror-parity.mjs`
 * 的 ① 节逐案例对拍钉住。对拍只能**发现**漂移，不能**防止**漂移；U 系列把它收成一份：
 *
 *   · 本文件 = 唯一手工源码（CommonJS；只用内置能力，无 IO / 无时钟 / 无环境依赖 —— 纯函数）；
 *   · `lib/text.js` = ESM 适配层（导出面逐字保留）；
 *   · `lib/pack-template/tools/pack-text.js` = 包侧包装器（纯委托 `./unify/text.cjs`）。
 *
 * 坑本身（这条规矩在本仓被踩过不止一次）：PowerShell 用 `Set-Content` /
 * `Add-Content -Encoding utf8` 写出来的文件**开头会带 BOM**（`EF BB BF`），于是：
 *   · `JSON.parse` 直接抛（"Unexpected token \uFEFF"）
 *   · 逐行解析时那一行被 `catch` 成 null → **静默丢掉一条真数据**（比抛更坏 ✗）
 * 课程包自己的脚本都专门剥它（`tools/drain-questions.js`、`tools/ask-watch.js`），
 * 插件这边也必须剥 —— 现场就因为没剥，让"队列里明明有这条"变成了"找不到这个 id" ✗
 *
 * 用法：`JSON.parse(stripBom(fs.readFileSync(f, 'utf8')))`
 * 逐行解析时**每行都要剥**：PowerShell 的追加会把 BOM 写进中间某一行。
 *
 * 语义基准（逐字取自改前 `lib/text.js`，`audit-evidence/U04/pre-change.json` 有改前实测）：
 *   · `parseJsonLoose` 的第二参是**默认参数**（`what = 'JSON'`），不是 `what || 'JSON'` ——
 *     显式传 `''` / `null` / `0` / `false` / `NaN` 时前缀就是它们的字符串形式。
 *     包侧旧实现用的是 `||`，五个 falsy 取值的前缀因此不同；收成一份时**以宿主语义为准**，
 *     Δ 已登记在 `docs/unify/receipts/U04.json`。
 */
'use strict';

/** 剥掉字符串开头的 BOM（只剥开头；中间出现的 BOM 由逐行调用者各自剥） */
function stripBom(s) {
  return String(s ?? '').replace(/^\uFEFF/, '');
}

/** 逐行剥 BOM 并切行（空行由调用方决定要不要跳） */
function splitLines(text) {
  return stripBom(text).split('\n').map(stripBom);
}

/** JSON.parse，但先剥 BOM。抛错时错误信息里点明"可能是 BOM/编码问题" */
function parseJsonLoose(text, what = 'JSON') {
  try {
    return JSON.parse(stripBom(text));
  } catch (e) {
    throw new Error(`${what} 不是合法 JSON —— ${e.message}（本机常见原因：文件带 BOM 或编码不是 UTF-8）`);
  }
}

module.exports = { stripBom, splitLines, parseJsonLoose };
