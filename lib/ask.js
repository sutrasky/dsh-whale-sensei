/**
 * ask.js — 课程疑问提交的纯函数层（ESM）
 * ------------------------------------------------------------------
 * 从课程包的 tools/ask-server.js 搬运而来，
 * 只保留提交 + 拉取相关的纯逻辑；本层**不直接** import fs / path / child_process
 * （唯一新增的依赖是记录构建内核 `./unify/records.cjs`，本层只用到它的纯函数部分）。
 *
 * U14 起**记录形状只有一个出处**：`lib/unify/records.cjs`（记录构建的唯一实现）。
 * 本文件保留既有导出面与参数/默认值/返回形状**逐字不变**，但把三件"记录长什么样"的事
 * 委托给那份内核：
 *   · `serializeRecord()`     → `records.buildAskQueueRecord()`（键序 id,at,lesson,page,title,question,status）
 *   · `serializeLedgerEntry()`→ `records.serializeLedgerEntry()`（台账条目块）
 *   · `insertLedgerEntry()` / `LEDGER_ANCHOR` / `LEDGER_MARKER` / `emptyLedgerSource()`
 *                             → 同源（收尾锚点只有一份，骨架与插桩不会漂）
 * 校验（`parseAskBody` / `validateAnswerBody`）仍留在本层：那是**校验**，不是**记录构建**。
 *
 * 线上契约（页面侧＝课程包的 assets/ask.js）：
 *   请求体：POST /ask，Content-Type: application/json
 *     { question: string, lesson: string, page: string, title: string }
 *   响应体：{ ok: true, id: string } 或 { ok: false, error: string }
 *   状态码：200 成功 / 400 JSON 解析失败或缺必填字段 / 413 请求体超长
 */

import { createRequire } from 'node:module'

/**
 * 记录构建内核（CJS）。用 `createRequire` 读它，与 `ask-io.js` 读 CJS 台账同一手法。
 * ⚠️ 本层仍是**纯函数层**：只做字符串/对象变换，不读盘、不取时钟、不留模块级可变状态。
 */
const requireCJS = createRequire(import.meta.url)
const RECORDS = requireCJS('./unify/records.cjs')

/** 请求体上限，搬运自 ask-server.js 第 42 行 MAX_BODY = 16 * 1024 */
export const ASK_MAX_BYTES = 16 * 1024;

/**
 * 解析并校验疑问提交的请求体。
 * 搬运自 ask-server.js 第 199-216 行（/ask 处理器的 body 解析段）。
 *
 * @param {string} raw - 原始请求体字符串
 * @returns {{ ok: true, value: { question: string, lesson: string, page: string, title: string } }
 *        | { ok: false, status: number, error: string }}
 */
export function parseAskBody(raw) {
  // 搬运自 ask-server.js 第 199-203 行：**先查长度**再解析（超长是 413，且不许写盘）
  // 注意按**字节**算：中文一个字 3 字节，用字符数会把"16KB 以内"判宽 ✗
  if (Buffer.byteLength(String(raw || ''), 'utf8') > ASK_MAX_BYTES) {
    return { ok: false, status: 413, error: '问题太长了，请精简到 16KB 以内' };
  }

  // 搬运自 ask-server.js 第 205-211 行：JSON 解析
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (_e) {
    return { ok: false, status: 400, error: 'JSON 解析失败' };
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, status: 400, code: 'JSON_OBJECT_REQUIRED', error: '请求体必须是 JSON 对象' };
  }
  // 搬运自 ask-server.js 第 213-216 行：必填字段校验
  const question = String(payload.question || '').trim();
  if (!question) {
    return { ok: false, status: 400, error: '疑问内容为空' };
  }

  // 搬运自 ask-server.js 第 222-226 行：字段截取与默认值
  const value = {
    question: question.slice(0, 4000),
    lesson: String(payload.lesson || '').slice(0, 60),
    page: String(payload.page || '').slice(0, 200),
    title: String(payload.title || '').slice(0, 200),
  };

  return { ok: true, value };
}

/**
 * 格式化序号为 4 位零填充字符串。
 * 搬运自 ask-server.js 第 74 行 String(n).padStart(4, '0')。
 *
 * @param {number} n - 序号（正整数）
 * @returns {string} 例如 7 → "0007"
 */
export function formatSeq(n) {
  return String(n).padStart(4, '0');
}

/**
 * 从 seq.txt 内容计算下一个序号。
 * 搬运自 ask-server.js 第 65-75 行 nextId() 的读取 + 递增段。
 * 注意：剥 BOM（\uFEFF），防止 Number('\uFEFF1') 变成 NaN 导致编号重置。
 *
 * @param {string} lastSeqText - seq.txt 的原始内容（可能为空、含 BOM、含空白）
 * @returns {{ next: number, seq: string }} next 为新序号数值，seq 为格式化后的字符串
 */
export function nextSeq(lastSeqText) {
  // 搬运自 ask-server.js 第 70 行：剥 BOM + trim + 转数字，默认 0
  const n = Number((lastSeqText || '').replace(/^\uFEFF/, '').trim()) || 0;
  const next = n + 1;
  return { next, seq: formatSeq(next) };
}

/**
 * 将入队对象序列化为一行 JSON（不含换行符）。
 * 搬运自 ask-server.js 第 230 行 JSON.stringify(record) + '\n'，
 * 但这里不追加换行——由调用方决定分隔符。
 *
 * @param {object} entry - 入队对象（makeEntry 的返回值）
 * @returns {string} 一行 JSON 字符串
 */
export function toQueueLine(entry) {
  return JSON.stringify(entry);
}

/**
 * 构造入队记录（**这是 IO 薄壳与纯层之间那条缝的规范名字**）。
 * 记录形状的唯一实现已收口到 `lib/unify/records.cjs` 的 `buildAskQueueRecord()`。
 * 键序固定为：id, at, lesson, page, title, question, status（与原代码一致）。
 *
 * @param {{ lesson?: string, page?: string, title?: string, question?: string }} payload
 *   parseAskBody 成功时返回的 value
 * @param {string} seq 格式化后的序号（如 "0007"）
 * @param {() => string} [now] 时钟注入，默认 () => new Date().toISOString()
 * @returns {object} 入队记录对象
 */
export function serializeRecord(payload, seq, now) {
  const ts = (now || (() => new Date().toISOString()))();
  // 时间戳只取**一次**：计划与锁内重建必须是同一串，否则提交守卫的摘要对不上（U06 闸三）
  return RECORDS.buildAskQueueRecord(payload, seq, ts);
}

/**
 * 解析 pending.jsonl 全文为对象数组。
 * 空行跳过；JSON 解析失败的行收集到 errors 而非静默吞掉。
 *
 * @param {string} text - pending.jsonl 的完整文本
 * @returns {{ entries: object[], errors: Array<{ line: number, raw: string, error: string }> }}
 */
export function parsePending(text) {
  // ⚠️ 必须剥 BOM：PowerShell 建/追加的文件会带 \uFEFF（本仓库的 drain-questions.js:30 与
  //    ask-watch.js:52-54 都专门剥它）。不剥的话**第一条真问题会被当成坏行**，
  //    于是"队列里找不到这个 id" —— 现场踩过 ✗
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const entries = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '');
    // 搬运自 ask-server.js 第 79 行 filter((l) => l.trim())：跳过空行
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      errors.push({ line: i + 1, raw: line, error: e.message });
    }
  }
  return { entries, errors };
}

/**
 * 生成给工具输出用的极简摘要。
 *
 * @param {object[]} entries - parsePending 返回的 entries 数组
 * @returns {{ count: number, latest: object | null }}
 */
export function summarizePending(entries) {
  return {
    count: entries.length,
    latest: entries.length > 0 ? entries[entries.length - 1] : null,
  };
}

/* ── answer 写回：校验 + 台账条目序列化 + 插入（全纯）────────────────── */

/** 台账里的键固定是四位编号（与课程页解答框 id="qNNNN" 对应，无横线） */
const SEQ_ID_RE = /^\d{4}$/;

/** `date` 的字面形状：`YYYY-MM-DD`（只认这一个写法：`2026-1-2` 拒） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `date` 必须是**真实存在的日历日**：`2024-02-29` 收；`2026-02-30` / `2026-13-01` /
 * `2026-00-10` 拒。
 *
 * 为什么不用 `new Date(y, m-1, d)` 再比字段：两/三位年份会被 `Date` 映射到 1900+year
 * （`Date.UTC(0, 0, 1)` 是 1900 年），等于给 `0000-01-01` 开一条错路。
 * 这里走 ISO 解析 + **逐字回比**：越界的日子会被规范化成下个月，回比当场抓得住。
 */
function isRealDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const dt = new Date(`${v}T00:00:00.000Z`)
  if (Number.isNaN(dt.getTime())) return false
  return dt.toISOString().slice(0, 10) === v
}

/**
 * 校验 answer 请求体。
 * `answerHtml` **必填**：build-notes 筛的是 `status==='answered' && answerHtml` 存在，
 * 只给纯文本的话学生**什么都看不到** —— 宁可直接拒，也不静默写一条无效的 ✗
 */
export function validateAnswerBody(raw) {
  if (Buffer.byteLength(String(raw || ''), 'utf8') > ASK_MAX_BYTES) {
    return { ok: false, status: 413, error: '请求体太长了（上限 16KB）' };
  }
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (_e) {
    return { ok: false, status: 400, error: 'JSON 解析失败' };
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, status: 400, code: 'JSON_OBJECT_REQUIRED', error: '请求体必须是 JSON 对象' };
  }
  const id = String(payload.id || '').trim();
  if (!id) return { ok: false, status: 400, error: '缺少 id' };
  if (!SEQ_ID_RE.test(id)) {
    return { ok: false, status: 400, error: `id 必须是四位编号（如 0004），收到 ${JSON.stringify(id)}` };
  }
  const answer = String(payload.answer || '').trim();
  if (!answer) return { ok: false, status: 400, error: '解答内容为空' };
  const answerHtml = String(payload.answerHtml || '').trim();
  if (!answerHtml) {
    return { ok: false, status: 400, error: '缺少 answerHtml（只给纯文本的话 build-notes 筛不出来，学生看不到）' };
  }
  // ── `date`（T27 用户裁定）：可选；缺省 = null，**绝不用"今天"顶替** ──
  //    给了就必须是真实日历日且**逐字保留**（不归一化、不改写）。
  //    只有"没给这个键"才是 null；显式 `null` / `''` / 数字 / `'today'` / `'2026-1-2'` 都是坏值 → 400 且一字不写。
  let date = null
  if (payload.date !== undefined) {
    if (!isRealDate(payload.date)) {
      return { ok: false, status: 400, error: `date 必须是 YYYY-MM-DD 的真实日期（收到 ${JSON.stringify(payload.date)}）` };
    }
    date = payload.date
  }
  return {
    ok: true,
    value: {
      id,
      answer,
      answerHtml,
      date,
      lesson: String(payload.lesson || '').slice(0, 40),
      section: String(payload.section || '').slice(0, 60),
      question: payload.question ? String(payload.question) : '',
    },
  };
}

/**
 * 把一个台账条目序列化成源码块（形状唯一实现在 `lib/unify/records.cjs`）。
 * 字段与顺序照抄 assets/questions-data.js 里现有条目：
 * id / date / lesson / question / status / page / anchor / section / answer / terms / answerHtml
 *
 * `date`（T27）：`null` 就写**裸 null**（`date: null,`），字符串就逐字写 `date: '…',`。
 * 页面锚点（`qNNNN`）与课程身份（`lesson` 显示名）在两个不同的槽位，绝不混用。
 */
export function serializeLedgerEntry(e, indent = '    ') {
  return RECORDS.serializeLedgerEntry(e, indent);
}

/**
 * 台账**收尾锚点** —— 骨架生成与写入插桩**必须同源**。
 * 唯一实现在 `lib/unify/records.cjs`：本文件只是**导出面**（值逐字节不变）。
 */
export const LEDGER_ANCHOR = RECORDS.LEDGER_ANCHOR

/** 台账里那句占位注释 —— 唯一实现同上（与课程包真本 `assets/questions-data.js:49` 逐字同一句） */
export const LEDGER_MARKER = RECORDS.LEDGER_MARKER

/**
 * 生成一份**空台账**源文件（建包骨架用）。
 * 形状 = 真本去掉头注释与条目：闭包 + `return {` + 占位注释 + 收尾锚点。
 * 头注释**有意不同**（新包是空的、真本是唯一数据源），所以由调用方给。
 *
 * @param {string} headComment - 头注释（含注释块的开头与收尾，末尾带换行）
 */
export function emptyLedgerSource(headComment) {
  return RECORDS.emptyLedgerSource(headComment)
}

/**
 * 把新条目插到台账对象收尾之前（`\n  };\n});` 前）。
 *
 * ⚠️ 两个坑（都踩过）：
 *   1. 原来**最后一条末尾没有逗号**（它是最后一条）—— 在它后面插，必须给它补一个逗号，
 *      否则整份文件 `Unexpected string` 解析不过 ✗
 *   2. 不许用 `String.replace(anchor, block)`：替换串里的 `$&`/`$'` 会被当反向引用，
 *      块里一旦出现 `$` 就会写飞。这里用**切片拼接**。
 *
 * 结构不认识（锚点不是恰好一处）或键已存在 —— 一律**抛错**，不赌 ✗
 */
export function insertLedgerEntry(src, key, block) {
  return RECORDS.insertEntry(src, key, block)
}
