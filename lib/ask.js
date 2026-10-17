/**
 * ask.js — 课程疑问提交的纯函数层（ESM）
 * ------------------------------------------------------------------
 * 从课程包的 tools/ask-server.js 搬运而来，
 * 只保留提交 + 拉取相关的纯逻辑，不 import fs / path / child_process。
 *
 * 线上契约（页面侧＝课程包的 assets/ask.js）：
 *   请求体：POST /ask，Content-Type: application/json
 *     { question: string, lesson: string, page: string, title: string }
 *   响应体：{ ok: true, id: string } 或 { ok: false, error: string }
 *   状态码：200 成功 / 400 JSON 解析失败或缺必填字段 / 413 请求体超长
 */

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
 * 搬运自 ask-server.js 第 220-228 行 record 的构造。
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
  return {
    id: seq,
    at: ts,
    lesson: String(payload?.lesson || '').slice(0, 60),
    page: String(payload?.page || '').slice(0, 200),
    title: String(payload?.title || '').slice(0, 200),
    question: String(payload?.question || '').slice(0, 4000),
    status: 'pending',
  };
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
  return {
    ok: true,
    value: {
      id,
      answer,
      answerHtml,
      lesson: String(payload.lesson || '').slice(0, 40),
      section: String(payload.section || '').slice(0, 60),
      question: payload.question ? String(payload.question) : '',
    },
  };
}

/** 单引号 JS 字符串字面量（换行转义成字面 \n，保证一个源串占一行） */
function jsStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

/**
 * 生成一个台账字段。单行 → `name: 'x',`；
 * 多行 → 照抄现有风格：`name:` 换行 + 更深缩进 + 每段 `'…\n' +`
 */
function ledgerField(name, text, indent) {
  const parts = String(text).split('\n');
  if (parts.length === 1) return `${indent}${name}: ${jsStr(parts[0])},`;
  const body = parts.map((p, i) => `${indent}  ${jsStr(p)}${i < parts.length - 1 ? ' +' : ','}`);
  return `${indent}${name}:\n${body.join('\n')}`;
}

/**
 * 把一个台账条目序列化成源码块。
 * 字段与顺序照抄 assets/questions-data.js 里现有条目：
 * id / date / lesson / question / status / page / anchor / section / answer / terms / answerHtml
 */
export function serializeLedgerEntry(e, indent = '    ') {
  const lines = [
    `${indent}'${e.id}': {`,
    `${indent}  id: '${e.id}',`,
    `${indent}  date: '${e.date}',`,
    `${indent}  lesson: ${jsStr(e.lesson || '')},`,
    `${indent}  question: ${jsStr(e.question || '')},`,
    `${indent}  status: 'answered',`,
    `${indent}  page: '${e.page || 'reference/NOTES.html'}',`,
    `${indent}  anchor: 'q${e.id}',`,
    `${indent}  section: ${jsStr(e.section || '')},`,
    ledgerField('answer', e.answer, `${indent}  `),
    `${indent}  terms: [],`,
    ledgerField('answerHtml', e.answerHtml, `${indent}  `),
    `${indent}}`,
  ];
  return lines.join('\n');
}

/**
 * 台账**收尾锚点** —— 骨架生成与写入插桩**必须同源**。
 * 写死在两处（一处生成骨架、一处插桩）就是漂移的开始：骨架换了形状，插桩就找不到锚点，
 * 而两边的测试各自都还是绿的。所以这里只有一份，`emptyLedgerSource()` 与
 * `insertLedgerEntry()` 都从它派生 —— 课程包真本 `assets/questions-data.js:41-49` 满足同一契约。
 */
export const LEDGER_ANCHOR = '\n  };\n});'

/** 台账 UMD 闭包 —— 与课程包真本 `assets/questions-data.js:41-47` 逐字节相同 */
const LEDGER_UMD = `(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QUESTIONS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {`

/** 台账里那句占位注释 —— 与课程包真本 `assets/questions-data.js:49` 逐字同一句 */
export const LEDGER_MARKER = '    // 学生真实提出过的疑问按编号登记在这里'

/**
 * 生成一份**空台账**源文件（建包骨架用）。
 * 形状 = 真本去掉头注释与条目：闭包 + `return {` + 占位注释 + 收尾锚点。
 * 头注释**有意不同**（新包是空的、真本是唯一数据源），所以由调用方给。
 *
 * @param {string} headComment - 头注释（含注释块的开头与收尾，末尾带换行）
 */
export function emptyLedgerSource(headComment) {
  return `${headComment}${LEDGER_UMD}\n${LEDGER_MARKER}${LEDGER_ANCHOR}\n`
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
  const anchor = LEDGER_ANCHOR;
  const text = String(src);
  const hits = text.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(`台账结构不认识：收尾锚点出现 ${hits} 次（期望 1 次），不敢改`);
  }
  if (new RegExp(`'${key}'\\s*:`).test(text)) {
    throw new Error(`台账里已经有 '${key}' —— 只追加、不覆盖`);
  }
  const at = text.indexOf(anchor);
  const head = text.slice(0, at);
  // 前一条末尾已经是 `{` 或 `,` 就不用补逗号（空台账的情形）
  const needComma = !/[{,]\s*$/.test(head);
  return `${head}${needComma ? ',' : ''}\n${block}${text.slice(at)}`;
}
