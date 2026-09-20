/**
 * lib/text.js — 读文本时的**本机已知坑位**，收在一处
 * ------------------------------------------------------------------
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
 */

/** 剥掉字符串开头的 BOM（只剥开头；中间出现的 BOM 由逐行调用者各自剥） */
export function stripBom(s) {
  return String(s ?? '').replace(/^\uFEFF/, '')
}

/** 逐行剥 BOM 并切行（空行由调用方决定要不要跳） */
export function splitLines(text) {
  return stripBom(text).split('\n').map(stripBom)
}

/** JSON.parse，但先剥 BOM。抛错时错误信息里点明"可能是 BOM/编码问题" */
export function parseJsonLoose(text, what = 'JSON') {
  try {
    return JSON.parse(stripBom(text))
  } catch (e) {
    throw new Error(`${what} 不是合法 JSON —— ${e.message}（本机常见原因：文件带 BOM 或编码不是 UTF-8）`)
  }
}
