'use strict'
/**
 * lib/unify/records.cjs —— 答疑 / 笔记 / 调整记录的**唯一**记录构建与共同提交（U14 新建）
 * ====================================================================================
 * 本件回答三个问题，别的都不做：
 *
 *   ① **一条记录长什么样**（键序、字段、上限、日期语义）
 *      答疑队列 / 笔记台账 / 课后调整台账 / 已答台账（`assets/questions-data.js` 的源码条目）
 *      四类记录的形状**只在这里**定义一次。四个宿主适配层
 *      （`lib/ask.js`、`lib/ask-io.js`、`lib/notes-io.js`、`lib/adjust-io.js`）与
 *      包侧 `tools/drain-questions.js` 都委托本件 —— 不保留第二份记录构建。
 *
 *   ② **记录与序号怎么一起提交**（A01 / A02）
 *      一律走 U06 的共同提交守卫：`planCommit()` 造计划（零写）→ `applyCommit()` 三闸提交。
 *      序号与台账是**同一个计划的两次落位**：第二个文件写失败 ⇒ 事务回滚到写前字节，
 *      不会留下「台账写了、seq 没走」或反过来（旧实现分散回滚的正是这个洞）。
 *      本件**不自己拿锁、不自己写日志、不自己回滚** —— 那是 `ledger-transaction.cjs` 的资产。
 *
 *   ③ **哪些记录可以归档 / 哪些账本不许再写**（A05 / A06）
 *      归档只搬**确实已答**的记录（台账里有这条 **且** `status === 'answered'`）；
 *      其余行（未答、没登记、解析不了）**原样留在队列里**，正文与键序一个字节都不重排。
 *      账本读出来是 `invalid` / `io-error` / `recovery-required` 时，普通写入**一律拒**
 *      （U03 五态 + U06 待恢复规则），且在**碰任何事务之前**拒 —— 坏账本上不分配版本。
 *
 * ## 课程身份与页面锚点：严格分开（卡面硬约束）
 *
 *   · 页面锚点（`q0001` 一类）是**页面定位值**，只在 `assets/questions-data.js` 里当
 *     `anchor` 用；它**不是**课程身份，任何课程/课次槽位收到它都必须拒。
 *   · 课程身份只写 `circle/point`（知识点）或 `circle/point/NNNN`（课次），
 *     构造与解析**全部**经 `./identity.cjs`（U02 严格内核）—— 本件不自己拼身份字符串。
 *   · 旧形状（裸知识点 / 两段课键 `point/课号` / 1–5 位课号 / 显示名）在**运行态**一律拒，
 *     只给"用迁移工具"的修法（解码归 `./migration.cjs`，U05；本件不 require 它）。
 *   · 显示名（`第1课`）不是身份；已答台账的 `lesson` 字段**照既有契约仍是显示名**
 *     （U05 的 `BLOCKED_FILES` 明确把 `assets/questions-data.js` 与 `notes/notes.jsonl`
 *     的旧形状阻断到 U17），本件不擅自改它的语义 —— 那是 U17 的活。
 *
 * ## 只依赖
 *
 * `node:path` / `node:fs` 两个内置 + 同目录 `./identity.cjs`、`./errors.cjs`、
 * `./ledger-read.cjs`、`./commit.cjs` + 事务件（默认按**两种随包布局**解析，可显式注入）。
 * 没有时钟（时间戳一律由调用方给：`opts.at` / `now()` 的返回值原样使用）、
 * 没有随机数、没有 `process.env` —— 同一入参永远同一输出。
 */

const path = require('node:path')
const nodeFs = require('node:fs')
const identity = require('./identity.cjs')
const { makeFailure, NEW_CODES } = require('./errors.cjs')
const { readLedger } = require('./ledger-read.cjs')
const { planCommit, applyCommit, COMMIT_STATES } = require('./commit.cjs')

/* ══════════════════════════════════════════════════════════════════════
 * 一、四类记录的落点与序号约定（**唯一**一份表）
 * ══════════════════════════════════════════════════════════════════════ */

/** 记录种类（不在表里的一律 `TypeError` —— 不猜、不兜底） */
const RECORD_KINDS = Object.freeze(['ask', 'note', 'adjust', 'answer'])

/**
 * 每类记录的落点、序号文件与序号字节形状。
 *
 * `seqBytes` 是**既有字节契约**，不是随手选的格式：
 *   · 答疑队列：`questions/seq.txt` 写 `"2"`（不补零、**不带换行**）；
 *   · 笔记：`notes/seq.txt` 写 `"2\n"`（带一个换行）。
 *   两者都已被既有测试逐字节钉住（`test/audit/T11.mjs` 的 `"2"` 断言），改它就是改契约。
 *
 * `format` 只有 `jsonl`（一行一条）与 `js`（`assets/questions-data.js` 的 UMD 源码）两种。
 */
const LEDGERS = Object.freeze({
  ask: Object.freeze({
    kind: 'ask',
    label: '答疑队列',
    rel: 'questions/pending.jsonl',
    seqRel: 'questions/seq.txt',
    format: 'jsonl',
    idWidth: 4,
    seqBytes: (n) => String(n),
    operation: 'append-ask-record',
  }),
  note: Object.freeze({
    kind: 'note',
    label: '笔记台账',
    rel: 'notes/notes.jsonl',
    seqRel: 'notes/seq.txt',
    format: 'jsonl',
    idWidth: 4,
    seqBytes: (n) => `${n}\n`,
    operation: 'append-note-record',
  }),
  adjust: Object.freeze({
    kind: 'adjust',
    label: '课后调整台账',
    rel: 'learning-records/adjustments.jsonl',
    seqRel: null,
    format: 'jsonl',
    idWidth: null,
    seqBytes: null,
    operation: 'append-adjust-record',
  }),
  answer: Object.freeze({
    kind: 'answer',
    label: '已答台账',
    rel: 'assets/questions-data.js',
    seqRel: null,
    format: 'js',
    idWidth: 4,
    seqBytes: null,
    operation: 'append-answer-entry',
  }),
})

/** 归档（drain）的两个落点：待答队列 → 已答归档（同一写集） */
const ARCHIVE = Object.freeze({
  pending: 'questions/pending.jsonl',
  processed: 'questions/processed.jsonl',
})

/** 序号宽度（四位零填充；`formatSeq` 的既有语义） */
const SEQ_WIDTH = 4

/** 幂等表查询（未知 kind 当场抛，不返回 undefined 让上层自己猜） */
function ledgerOf(kind) {
  const key = String(kind == null ? '' : kind)
  const spec = LEDGERS[key]
  if (!spec) throw new TypeError(`records：未知的记录种类 ${JSON.stringify(kind)}（只认 ${RECORD_KINDS.join(' / ')}）`)
  return spec
}

/** 台账绝对路径 */
function ledgerFile(kind, root) {
  return path.join(path.resolve(String(root == null ? '' : root)), ...ledgerOf(kind).rel.split('/'))
}

/** 序号文件绝对路径（没有序号的种类返回 `null`，由调用方判） */
function seqFile(kind, root) {
  const spec = ledgerOf(kind)
  if (!spec.seqRel) return null
  return path.join(path.resolve(String(root == null ? '' : root)), ...spec.seqRel.split('/'))
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、序号：读文本 → 下一个号 → 写回字节
 * ══════════════════════════════════════════════════════════════════════ */

/** 四位零填充（`7 → "0007"`）；与既有 `formatSeq` 逐字同口径 */
function formatId(seq) {
  return String(seq).padStart(SEQ_WIDTH, '0')
}

/**
 * 序号文本 → 计数器。剥 BOM、trim、转数字；空/坏值 = 0（既有口径）。
 * ⚠️ 不把"读不动"折成 0：读不动由 `readSequence()` 判（见下）。
 */
function seqFromText(text) {
  const n = Number(String(text == null ? '' : text).replace(/^\uFEFF/, '').trim()) || 0
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

/** 下一个号（纯函数）：`{seq, id}` */
function nextSeq(text) {
  const seq = seqFromText(text) + 1
  return { seq, id: formatId(seq) }
}

/**
 * 读序号文件（**只读**；不存在 = 0，读取故障 = 抛出）。
 *
 * 为什么"读取故障"要抛：把 `EISDIR` / `EACCES` 当成 `0` 会让下一次写入
 * **从 0001 重新发号**，把已有编号撞掉（A03：读取故障不当空队列）。
 *
 * @param {string} file
 * @param {{fs?:object}} [opts]
 * @returns {{exists:boolean, text:string, seq:number}}
 */
function readSequence(file, opts = {}) {
  const io = fsOf(opts, 'readSequence')
  let text = ''
  let exists = false
  try {
    exists = io.existsSync(file)
    if (exists) text = String(io.readFileSync(file, 'utf8'))
  } catch (e) {
    const code = sysCode(e)
    const err = new Error(`序号文件读不动（${code}）：${file}`)
    err.code = code
    err.errorCode = code
    throw err
  }
  return { exists, text, seq: seqFromText(text) }
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、课程身份 vs 页面锚点
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 页面锚点：`q` + 四位编号。它是**页面定位值**（`reference/NOTES.html` 里的
 * `id="q0004"`），与课程身份毫无关系。`assets/questions-data.js` 的 `anchor` 就取它。
 */
const PAGE_ANCHOR_RE = /^q(\d{4})$/

/** 是不是一个页面锚点（纯判断，不看上下文） */
function isPageAnchor(value) {
  return typeof value === 'string' && PAGE_ANCHOR_RE.test(value)
}

/** 四位编号 → 页面锚点（`'0004' → 'q0004'`）；编号不合规当场拒 */
function pageAnchorOf(id) {
  const key = String(id == null ? '' : id)
  if (!/^\d{4}$/.test(key)) {
    throw new TypeError(`records：页面锚点的编号必须是四位十进制（实得 ${JSON.stringify(id)}）`)
  }
  return `q${key}`
}

/**
 * 解析一个页面锚点（**只解析页面定位值**，绝不产出课程身份）。
 * @returns {{ok:true, anchor:string, id:string}|{ok:false, reason:string, error:string}}
 */
function parsePageAnchor(value) {
  const m = PAGE_ANCHOR_RE.exec(String(value == null ? '' : value))
  if (!m) return { ok: false, reason: 'not-page-anchor', error: `${JSON.stringify(value)} 不是页面锚点（形状 q + 四位编号）` }
  return { ok: true, anchor: m[0], id: m[1] }
}

/** 未归课哨兵（既有显式桶；不是课程身份，也不是页面锚点） */
const UNROUTED_ANCHOR = '未归课'

/** 失败原因（本件私有枚举；不是全仓错误码表） */
const REF_REASONS = Object.freeze({
  NOT_STRING: 'not-string',
  EMPTY: 'empty',
  UNTRIMMED: 'untrimmed',
  PAGE_ANCHOR: 'page-anchor',
  DISPLAY_NAME: 'display-name',
  BARE_POINT: 'bare-point',
  POINT_LESSON: 'point-lesson',
  LESSON_WIDTH: 'lesson-width',
  AMBIGUOUS: 'ambiguous',
  MALFORMED: 'malformed',
  UNKNOWN: 'unknown',
})

/**
 * 本层的拒绝码。
 *
 * ⚠️ 值是**引用** `./errors.cjs` 的 `NEW_CODES`，本件**不再重写一遍码值字面量**：
 *    那三个码的唯一落点是 `lib/unify/errors.cjs`，这里只是给本层的三个"拒绝理由"
 *    起个语义名（INVALID / AMBIGUOUS / MIGRATION），不是第二张码表。
 *    （U14 缺陷修复：原先这里把三个码值各写了一遍字面量 —— 同一码值两处真值来源，
 *    改一处漏一处就漂移；`./errors.cjs` 才是唯一登记处。）
 * 赋出来的**值**与修复前逐字相同：仍是 U01 锁定过的既有/新增码值，不新增同义码。
 */
const REF_CODES = Object.freeze({
  INVALID: NEW_CODES.LEDGER_INVALID,
  AMBIGUOUS: NEW_CODES.ID_AMBIGUOUS,
  MIGRATION: NEW_CODES.MIGRATION_REQUIRED,
})

/** 显示名的字面形状（`第1课` / `Vue 第1课`）；显示文字不是身份 */
const DISPLAY_NAME_RE = /^[^\n]*第\s*\d+\s*课$/

function refFailure(code, reason, error, extra) {
  const candidates = (extra && extra.candidates) || []
  return {
    ok: false,
    code,
    reason,
    candidates,
    error,
    failure: makeFailure({ kind: 'input', code, error }),
  }
}

/**
 * 由课次映射表（`lessonIndex(root)` 那种 `{byKey}` 形状）造一个**只读目录**。
 * 目录只回答两件事：某个点键在哪些圆圈里（歧义判定）、某个课次键存不存在。
 *
 * @param {{byKey?:object}} index
 * @returns {{keys:string[], byPoint:Map<string,string[]>, has:Function}}
 */
function buildCatalogue(index) {
  const byKey = (index && index.byKey) || {}
  const keys = Object.keys(byKey).sort()
  const byPoint = new Map()
  for (const key of keys) {
    const segs = key.split('/')
    if (segs.length !== 3) continue
    const point = segs[1]
    const list = byPoint.get(point) || []
    if (!list.includes(segs[0])) list.push(segs[0])
    byPoint.set(point, list)
  }
  for (const [point, list] of byPoint) byPoint.set(point, list.slice().sort())
  return { keys, byPoint, has: (key) => Object.prototype.hasOwnProperty.call(byKey, key) }
}

/**
 * 严格分类一个**课程引用**（课次槽位用；`lesson` / 课次键）。
 *
 * 只认规范形状：`circle/point/NNNN`（课次）或 `circle/point`（知识点）。
 * 其余一律拒，并给可机器判读的 `code`/`reason`：
 *   · 页面锚点 `q0001`        → `LEDGER_INVALID`（**它不是课程键**，卡面硬约束）
 *   · 显示名 `第1课`          → `MIGRATION_REQUIRED`（显示名不是身份）
 *   · 裸知识点 `vue`          → 多圈 `ID_AMBIGUOUS`（带候选）/ 否则 `MIGRATION_REQUIRED`
 *   · 两段课键 `vue/0001`     → `MIGRATION_REQUIRED`（`point/课号` 缺圆圈）
 *   · 1–3 位 / 5 位课号        → `MIGRATION_REQUIRED`（历史写法）
 *   · 其它                     → `LEDGER_INVALID`
 *
 * @param {string} ref
 * @param {{catalogue?:object|null, halo?:string|null, allowPoint?:boolean}} [opts]
 * @returns {{ok:true, key:string, shape:'lesson'|'point', circle:string, point:string, number?:number}
 *        | {ok:false, code:string, reason:string, candidates:string[], error:string, failure:object}}
 */
function classifyCourseRef(ref, opts = {}) {
  if (typeof ref !== 'string') {
    return refFailure(REF_CODES.INVALID, REF_REASONS.NOT_STRING, `课程引用必须是字符串（实得 ${ref === null ? 'null' : typeof ref}）`)
  }
  if (ref === '' || ref.trim() === '') {
    return refFailure(REF_CODES.INVALID, REF_REASONS.EMPTY, '课程引用不能是空的')
  }
  if (ref !== ref.trim()) {
    return refFailure(REF_CODES.INVALID, REF_REASONS.UNTRIMMED, `课程引用两侧不能带空白（${JSON.stringify(ref)}）`)
  }
  // ① 页面锚点：先拒 —— 它是页面定位值，任何情况下都不是课程键
  if (isPageAnchor(ref)) {
    return refFailure(REF_CODES.INVALID, REF_REASONS.PAGE_ANCHOR,
      `${JSON.stringify(ref)} 是**页面锚点**（reference/NOTES.html 的定位值），不是课程身份：`
      + '课程身份只写 circle/point 或 circle/point/NNNN')
  }
  // ② 规范课次键：命中就原样用（经 identity 严格内核，不自己拼）
  const lesson = identity.parseLessonKey(ref)
  if (lesson.ok) {
    const { circle, point, number } = lesson.value
    return { ok: true, key: identity.lessonKey(circle, point, number), shape: 'lesson', circle, point, number }
  }
  // ③ 规范点键（只有调用方允许点级引用时才收；课次槽位不接受）
  const pointKey = identity.parsePointKey(ref)
  if (pointKey.ok && opts.allowPoint === true) {
    const { circle, point } = pointKey.value
    return { ok: true, key: identity.pointKey(circle, point), shape: 'point', circle, point }
  }
  const catalogue = opts.catalogue || null
  const halo = typeof opts.halo === 'string' && opts.halo.trim() ? opts.halo.trim() : null
  const segs = ref.split('/')

  // ④ 显示名：显示文字不是身份（换算已从运行态删除）
  if (segs.length === 1 && DISPLAY_NAME_RE.test(ref)) {
    return refFailure(REF_CODES.MIGRATION, REF_REASONS.DISPLAY_NAME,
      `${JSON.stringify(ref)} 是**显示名**，不是课程身份（运行态只认 circle/point/NNNN）；旧台账由迁移工具处理`)
  }
  // ⑤ 两段：`point/课号`（缺圆圈）或点键落在课程位
  if (segs.length === 2) {
    const [head, tail] = segs
    if (/^[0-9]+$/.test(tail)) {
      const circles = catalogue && catalogue.byPoint ? (catalogue.byPoint.get(head) || []) : []
      const hits = circles.map((c) => `${c}/${head}/${tail}`)
      if (halo && circles.includes(halo)) {
        // 显式给了圆圈：这是**可判定的**归属（不给就绝不猜）
        return { ok: true, key: identity.lessonKey(halo, head, Number(tail)), shape: 'lesson', circle: halo, point: head, number: Number(tail) }
      }
      if (hits.length > 1) {
        return refFailure(REF_CODES.AMBIGUOUS, REF_REASONS.AMBIGUOUS,
          `两段课键 ${JSON.stringify(ref)} 在 ${hits.length} 个圆圈里都有（${hits.join(' / ')}）—— 归属歧义，不猜`,
          { candidates: hits })
      }
      return refFailure(REF_CODES.MIGRATION, REF_REASONS.POINT_LESSON,
        `${JSON.stringify(ref)} 是**两段课键**（point/课号，缺圆圈）—— 用 tools/migrate-pack.mjs 显式迁移`
        + (hits.length === 1 ? `（目录里它在 ${hits[0]}）` : ''),
        { candidates: hits })
    }
    if (pointKey.ok && opts.allowPoint !== true) {
      return refFailure(REF_CODES.INVALID, REF_REASONS.MALFORMED,
        `${JSON.stringify(ref)} 是**点键**，却落在课次槽位：课次身份是 circle/point/NNNN，点键不能顶替`)
    }
  }
  // ⑥ 三段但课号不合规：点名差在哪
  if (segs.length === 3) {
    const numText = segs[2]
    if (/^[0-9]+$/.test(numText)) {
      if (numText.length !== 4) {
        return refFailure(REF_CODES.MIGRATION, REF_REASONS.LESSON_WIDTH,
          `课号段必须正好四位十进制（实得 ${JSON.stringify(numText)}）；1–5 位的历史写法由迁移工具处理`)
      }
      const n = Number(numText)
      if (n < identity.LESSON_NUMBER_MIN || n > identity.LESSON_NUMBER_MAX) {
        return refFailure(REF_CODES.INVALID, REF_REASONS.LESSON_WIDTH,
          `课号 ${numText} 越界（只认 ${identity.LESSON_NUMBER_MIN}–${identity.LESSON_NUMBER_MAX}，不截断、不取模）`)
      }
    }
    return refFailure(REF_CODES.INVALID, REF_REASONS.MALFORMED, `${JSON.stringify(ref)} 不是规范课次键：${lesson.failure ? lesson.failure.error : '形状不认识'}`)
  }
  // ⑦ 单段：裸知识点（多圈歧义 → 列候选；单圈 → 仍要求写完整身份）
  if (segs.length === 1) {
    const circles = catalogue && catalogue.byPoint ? (catalogue.byPoint.get(ref) || []) : []
    if (halo) {
      if (circles.includes(halo) || !circles.length) {
        return { ok: true, key: identity.pointKey(halo, ref), shape: 'point', circle: halo, point: ref }
      }
      return refFailure(REF_CODES.MIGRATION, REF_REASONS.BARE_POINT,
        `裸知识点 ${JSON.stringify(ref)} 不属于圆圈 ${JSON.stringify(halo)}（候选：${circles.map((c) => `${c}/${ref}`).join(' / ') || '无'}）`,
        { candidates: circles.map((c) => `${c}/${ref}`) })
    }
    if (circles.length > 1) {
      const candidates = circles.map((c) => `${c}/${ref}`)
      return refFailure(REF_CODES.AMBIGUOUS, REF_REASONS.AMBIGUOUS,
        `裸知识点 ${JSON.stringify(ref)} 在 ${circles.length} 个圆圈里都有（${candidates.join(' / ')}）—— 不猜`,
        { candidates })
    }
    return refFailure(REF_CODES.MIGRATION, REF_REASONS.BARE_POINT,
      `旧形状裸知识点 ${JSON.stringify(ref)}（运行态只认 circle/point）—— 用 tools/migrate-pack.mjs 显式迁移`,
      { candidates: circles.map((c) => `${c}/${ref}`) })
  }
  return refFailure(REF_CODES.INVALID, REF_REASONS.MALFORMED, `${JSON.stringify(ref)} 的段数（${segs.length}）不可判定为课程引用`)
}

/**
 * 严格分类一个**笔记锚点**（笔记台账的 `anchor` 槽位）。
 *
 * 笔记锚点比课次槽位多一个合法落点：显式桶 `未归课`（既有语义，保留）。
 * 其余同 `classifyCourseRef`：只认 `circle/point/NNNN`，页面锚点 `q0001` 一律拒。
 *
 * @param {string} ref
 * @param {{catalogue?:object|null}} [opts]
 */
function classifyNoteAnchor(ref, opts = {}) {
  if (ref === UNROUTED_ANCHOR) {
    return { ok: true, key: UNROUTED_ANCHOR, shape: 'unrouted', sentinel: true, circle: null, point: null }
  }
  return classifyCourseRef(ref, { catalogue: opts.catalogue, allowPoint: false })
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、四类记录的**唯一**构建
 * ══════════════════════════════════════════════════════════════════════ */

/** 字数截断（既有上限语义：按**字符**截，不是字节） */
function clipStr(value, max) {
  return String(value == null ? '' : value).slice(0, max)
}

/**
 * 答疑队列记录。键序**逐字**为 `id, at, lesson, page, title, question, status`
 * （包侧 `drain-questions` / `build-questions` 依赖这个顺序）。
 *
 * @param {{lesson?:string, page?:string, title?:string, question?:string}} payload
 * @param {string} seq 格式化后的编号（`"0007"`）
 * @param {string} at ISO 时间戳（**由调用方给**；本件不取时钟）
 */
function buildAskQueueRecord(payload, seq, at) {
  const ts = String(at == null ? '' : at)
  if (!ts) throw new TypeError('records：答疑记录必须由调用方给时间戳（本件不取时钟）')
  const p = payload && typeof payload === 'object' ? payload : {}
  return {
    id: String(seq),
    at: ts,
    lesson: String(p.lesson || '').slice(0, 60),
    page: String(p.page || '').slice(0, 200),
    title: String(p.title || '').slice(0, 200),
    question: String(p.question || '').slice(0, 4000),
    status: 'pending',
  }
}

/**
 * 笔记记录。键序 `id, seq, kind, anchor, text`，`date` **只在调用方显式给时**出现
 * （T27 边界：不许默认"今天"）。
 *
 * @param {{id:string, seq:number, anchorKey:string, text:string, date?:string}} o
 */
function buildNoteRecord(o) {
  const rec = {
    id: String(o.id),
    seq: Number(o.seq),
    kind: '笔记',
    anchor: String(o.anchorKey),
    text: String(o.text == null ? '' : o.text),
  }
  if (o.date !== undefined) rec.date = String(o.date)
  return rec
}

/** 课后调整台账的记录投影（`ts` 刻意**不带出去**：G-9，被对拍的产物不许带时间字段） */
const ADJ_KEYS = Object.freeze(['lesson', 'title', 'adjust', 'lit', 'gaps'])
const STAMP = /\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?/g

/**
 * 一条课后调整记录 → 规范化投影（键序 `lesson, title, adjust, lit, gaps`）。
 * 老行没有 `lit` → `null`（unknown，不打 ✗）；`gaps` 非数组 → 空。
 *
 * @param {object} raw
 * @param {{maxChars?:number}} [opts]
 */
function normalizeAdjustmentRecord(raw, opts = {}) {
  const maxChars = Number.isSafeInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 160
  const r = raw && typeof raw === 'object' ? raw : {}
  const clip = (s) => {
    const t = String(s == null ? '' : s).replace(STAMP, '[…]').replace(/\s+/g, ' ').trim()
    return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t
  }
  return {
    lesson: typeof r.lesson === 'string' ? r.lesson : '',
    title: typeof r.title === 'string' ? r.title : '',
    adjust: clip(r.adjust),
    lit: typeof r.lit === 'boolean' ? r.lit : null,
    gaps: Array.isArray(r.gaps) ? r.gaps.map((g) => clip(g)) : [],
  }
}

/**
 * 已答台账条目（`assets/questions-data.js` 里的一条）。
 *
 * **两个槽位严格分开**：
 *   · `anchor` 是**页面锚点** `qNNNN`（页面定位值，永远不是课程身份）；
 *   · `lesson` 是**课次显示名**（既有契约；U05 的 BLOCKED_FILES 把它阻断到 U17，
 *     本件不擅自把它换成身份键 —— 会打破 NOTES.html 分组与课程页答疑计数）。
 *
 * @param {{id:string, date:string|null, lesson:string, question:string,
 *          page?:string, section:string, answer:string, answerHtml:string}} o
 */
function buildAnswerEntry(o) {
  const id = String(o.id == null ? '' : o.id)
  const anchor = pageAnchorOf(id)
  const parsed = parsePageAnchor(anchor)
  if (!parsed.ok) throw new TypeError(`records：页面锚点不合规（${parsed.error}）`)
  // 页面锚点绝不许出现在身份槽位（这条断言是"严格分开"的机器判据，不是注释）
  if (isPageAnchor(o.lesson)) {
    throw new TypeError(`records：页面锚点 ${JSON.stringify(o.lesson)} 不许当课程键 —— anchor 是页面定位值，lesson 是课次显示名`)
  }
  return {
    id,
    date: o.date === undefined ? null : o.date,
    lesson: clipStr(o.lesson, 40),
    question: String(o.question == null ? '' : o.question),
    status: 'answered',
    page: o.page === undefined ? 'reference/NOTES.html' : String(o.page),
    anchor,
    section: clipStr(o.section, 60),
    answer: String(o.answer == null ? '' : o.answer),
    answerHtml: String(o.answerHtml == null ? '' : o.answerHtml),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、已答台账（JS 源码）的读写：锚点、条目块、插入
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 台账**收尾锚点** —— 骨架生成与写入插桩**必须同源**（单一实现就这一处）。
 */
const LEDGER_ANCHOR = '\n  };\n});'

/** 台账 UMD 闭包（与课程包真本 `assets/questions-data.js:41-47` 逐字节相同） */
const LEDGER_UMD = `(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QUESTIONS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {`

/** 台账里的占位注释（与课程包真本 `assets/questions-data.js:49` 逐字同一句） */
const LEDGER_MARKER = '    // 学生真实提出过的疑问按编号登记在这里'

/**
 * 生成一份**空台账**源文件（建包骨架用）。
 * 头注释**有意由调用方给**（新包是空的、真本是唯一数据源）。
 */
function emptyLedgerSource(headComment) {
  return `${headComment}${LEDGER_UMD}\n${LEDGER_MARKER}${LEDGER_ANCHOR}\n`
}

/** 单引号 JS 字符串字面量（换行转义成字面 \n，保证一个源串占一行） */
function jsStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`
}

/** 生成一个台账字段（单行 → `name: 'x',`；多行 → 照抄既有换行风格） */
function ledgerField(name, text, indent) {
  const parts = String(text).split('\n')
  if (parts.length === 1) return `${indent}${name}: ${jsStr(parts[0])},`
  const body = parts.map((p, i) => `${indent}  ${jsStr(p)}${i < parts.length - 1 ? ' +' : ','}`)
  return `${indent}${name}:\n${body.join('\n')}`
}

/**
 * 把一个台账条目序列化成源码块（字段与顺序照抄既有条目）：
 * id / date / lesson / question / status / page / anchor / section / answer / terms / answerHtml
 *
 * `date`：`null` 就写**裸 null**（`date: null,`），字符串逐字写 `date: '…',`
 * —— 旧实现无条件 `'${e.date}'` 会把 null 序列化成字符串 `'null'`（T27 修的正是这个）。
 */
function serializeLedgerEntry(e, indent = '    ') {
  const dateLine = e.date == null ? `${indent}  date: null,` : `${indent}  date: '${e.date}',`
  const lines = [
    `${indent}'${e.id}': {`,
    `${indent}  id: '${e.id}',`,
    dateLine,
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
  ]
  return lines.join('\n')
}

/**
 * 把新条目插到台账对象收尾之前（`\n  };\n});` 前）。
 *
 * ⚠️ 两个坑（既有实现已踩过，这里保留同一口径）：
 *   1. 最后一条末尾没有逗号 —— 在它后面插必须给它补一个逗号；
 *   2. 不许用 `String.replace(anchor, block)`：替换串里的 `$&`/`$'` 会被当反向引用。
 * 结构不认识（锚点不是恰好一处）或键已存在 —— 一律**抛错**，不赌。
 */
function insertEntry(src, key, block) {
  const anchor = LEDGER_ANCHOR
  const text = String(src)
  const hits = text.split(anchor).length - 1
  if (hits !== 1) {
    throw new Error(`台账结构不认识：收尾锚点出现 ${hits} 次（期望 1 次），不敢改`)
  }
  if (new RegExp(`'${key}'\\s*:`).test(text)) {
    throw new Error(`台账里已经有 '${key}' —— 只追加、不覆盖`)
  }
  const at = text.indexOf(anchor)
  const head = text.slice(0, at)
  const needComma = !/[{,]\s*$/.test(head)
  return `${head}${needComma ? ',' : ''}\n${block}${text.slice(at)}`
}

/** 在**内存里**加载台账源码（UMD 的 `module.exports = factory()` 分支） */
function loadLedgerSource(src, requireFn) {
  const moduleObj = { exports: {} }
  try {
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', String(src))(moduleObj, moduleObj.exports, requireFn)
  } catch (e) {
    throw new Error(`require 失败：${e && e.message ? e.message : String(e)}`)
  }
  return moduleObj.exports
}

/**
 * 读已答台账（五态口径与 jsonl 台账一致）。
 *
 * @param {string} root
 * @param {{fs?:object, require?:Function}} [opts]
 * @returns {{file:string, exists:boolean, status:string, entries:object[], problems:string[],
 *            errorCode?:string, failure?:object, ledger?:object}}
 */
function readAnswerLedger(root, opts = {}) {
  const io = fsOf(opts, 'readAnswerLedger')
  const file = ledgerFile('answer', root)
  let text = null
  try {
    if (!io.existsSync(file)) {
      return { file, exists: false, status: 'missing', entries: [], problems: [] }
    }
    text = String(io.readFileSync(file, 'utf8'))
  } catch (e) {
    const code = sysCode(e)
    const msg = `已答台账读不动（${code}）：${file}`
    return {
      file, exists: true, status: 'io-error', entries: [], problems: [msg], errorCode: code,
      failure: makeFailure({ kind: 'io', code: 'IO_ERROR', error: msg, file, errorCode: code }),
    }
  }
  const requireFn = typeof opts.require === 'function' ? opts.require : require
  let ledger = null
  try {
    ledger = loadLedgerSource(text.replace(/^\uFEFF/, ''), requireFn)
  } catch (e) {
    const msg = `已答台账不可信（${e && e.message ? e.message : String(e)}）`
    return {
      file, exists: true, status: 'invalid', entries: [], problems: [msg],
      failure: makeFailure({ kind: 'input', code: 'LEDGER_INVALID', error: msg, file }),
    }
  }
  if (!ledger || typeof ledger !== 'object') {
    const msg = '已答台账不可信：工厂没有返回对象'
    return { file, exists: true, status: 'invalid', entries: [], problems: [msg], failure: makeFailure({ kind: 'input', code: 'LEDGER_INVALID', error: msg, file }) }
  }
  const entries = Object.keys(ledger).map((k) => ledger[k]).filter((v) => v && typeof v === 'object' && !Array.isArray(v))
  return { file, exists: true, status: entries.length ? 'ok' : 'empty', entries, problems: [], ledger }
}

/**
 * 读**任意**记录台账（五态唯一出口）。
 * jsonl 三类走 U03 的 `readLedger`；已答台账走 `readAnswerLedger`（JS 源码，同一套五态）。
 *
 * @param {'ask'|'note'|'adjust'|'answer'} kind
 * @param {string} root
 * @param {{fs?:object, require?:Function}} [opts]
 */
function readRecordLedger(kind, root, opts = {}) {
  const spec = ledgerOf(kind)
  if (spec.format === 'js') return readAnswerLedger(root, opts)
  return readLedger(ledgerFile(spec.kind, root), { format: 'jsonl', fs: opts.fs })
}

/**
 * 已答台账里**确实已答**的编号集合。
 *
 * "确实已答" = 台账里有这条 **且** `status === 'answered'`。
 * ⚠️ 旧口径是"登记过就算已答"（只要键在台账里就搬走队列）—— 本卡收紧成"状态必须是 answered"
 * （A05），登记了但状态不是 answered 的记录**留在队列里**，不当作处理完。
 *
 * @param {string} root
 * @param {{fs?:object, require?:Function}} [opts]
 * @returns {{ok:boolean, status:string, ids:string[], ordered:string[], problems:string[], failure?:object}}
 */
function answeredIds(root, opts = {}) {
  const read = readRecordLedger('answer', root, opts)
  if (read.status === 'missing' || read.status === 'invalid' || read.status === 'io-error') {
    return { ok: false, status: read.status, ids: [], registered: [], problems: read.problems.slice(), failure: read.failure }
  }
  const registered = read.entries.map((q) => String(q.id))
  const ids = [...new Set(read.entries.filter((q) => q && String(q.status) === 'answered').map((q) => String(q.id)))]
  return { ok: true, status: read.status, ids, registered, problems: [] }
}

/* ══════════════════════════════════════════════════════════════════════
 * 六、共同提交：计划 → 三闸 → 提交（记录与序号同一写集）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 事务件（**默认**按两种随包布局解析；可显式注入）。
 *
 * 为什么不是写死一个相对路径：本件有两个合法落点 ——
 *   · 宿主布局 `<仓>/lib/unify/records.cjs` → `../pack-template/tools/ledger-transaction.cjs`；
 *   · 随包布局 `<包>/tools/unify/records.cjs`（U19 生成）→ `../ledger-transaction.cjs`。
 * 两个候选都是**同一份事务件**（不是第二套事务系统）。
 */
function defaultTransaction() {
  const candidates = ['../pack-template/tools/ledger-transaction.cjs', '../ledger-transaction.cjs']
  let last = null
  for (const rel of candidates) {
    try { return require(rel) } catch (e) { last = e }
  }
  throw new Error(`records：读不到包级事务件（试过 ${candidates.join(' / ')}）：${last && last.message ? last.message : last}`)
}

/** 事务能力包装：计数 + 原样转发（A06 用"事务调用次数为 0"证明拒绝在前置） */
function countingTransaction(txn) {
  const box = {
    calls: 0,
    assertCalls: 0,
    withPackTransaction(root, build, opts) {
      box.calls += 1
      return txn.withPackTransaction(root, build, opts)
    },
    assertNoRecoveryRequired(io, root) {
      box.assertCalls += 1
      return typeof txn.assertNoRecoveryRequired === 'function' ? txn.assertNoRecoveryRequired(io, root) : { ok: true }
    },
  }
  if (typeof txn.failureFor === 'function') box.failureFor = (res) => txn.failureFor(res)
  if (typeof txn.txnPaths === 'function') box.txnPaths = (root) => txn.txnPaths(root)
  if (typeof txn.pendingRecovery === 'function') box.pendingRecovery = (io, root) => txn.pendingRecovery(io, root)
  return box
}

/** 待恢复材料（问事务件；它是日志的拥有者） */
function recoveryResidue(txn, io, rootAbs) {
  try {
    if (typeof txn.pendingRecovery === 'function') {
      return (txn.pendingRecovery(io, rootAbs) || []).map((j) => String(j && j.id))
    }
  } catch { /* 没有能力就当没有材料 */ }
  return []
}

/** 失败回执（与 commit / stage 同一套字段；不改 state 词、不宣称成功） */
function receiptOf(res, planned) {
  const out = {
    ok: res && res.ok === true,
    state: String((res && res.state) || 'rejected'),
    code: res && res.code !== undefined ? res.code : null,
    error: res && res.error !== undefined ? res.error : null,
    failure: res && res.failure !== undefined ? res.failure : null,
    rollbackError: res && res.rollbackError !== undefined ? res.rollbackError : null,
    journal: res && res.journal !== undefined ? res.journal : null,
    txnId: res && res.txnId !== undefined ? res.txnId : null,
    value: res && res.ok === true ? res.value : undefined,
    planDigest: planned && planned.plan ? planned.plan.planDigest : null,
    rel: planned ? planned.rel : null,
    file: planned ? planned.file : null,
    seqRel: planned ? planned.seqRel : null,
    seqFile: planned ? planned.seqFile : null,
    id: planned ? planned.id : null,
    seq: planned ? planned.seq : null,
    buildError: null,
  }
  // build（= 领域自检 / 账本状态复核）抛出的原话要**原样**带回：上层既有错误文本契约不能变形
  if (!out.ok && typeof out.error === 'string') {
    const PREFIX = 'build 抛错：'
    if (out.error.startsWith(PREFIX)) out.buildError = out.error.slice(PREFIX.length)
  }
  return out
}

/** 需要重试的码（计划过期 / 锁忙：不覆盖别人的字节，重读重算再来一次） */
const RETRY_CODES = Object.freeze({ PLAN_STALE: true, LOCK_BUSY: true })
const DEFAULT_RETRIES = 8

/** 记录种类 → 一次追加的「计划」形状 */
function planRecordAppend(kind, root, compute, opts = {}) {
  const spec = ledgerOf(kind)
  const io = fsOf(opts, 'planRecordAppend')
  if (typeof compute !== 'function') throw new TypeError('records：compute 必须是函数（内容只能由它算，不能手填）')
  const rootAbs = path.resolve(String(root == null ? '' : root))
  const file = ledgerFile(spec.kind, rootAbs)
  const seq = spec.seqRel ? seqFile(spec.kind, rootAbs) : null
  const operation = typeof opts.operation === 'string' && opts.operation.trim() ? opts.operation.trim() : spec.operation
  const rels = seq ? [spec.rel, spec.seqRel] : [spec.rel]

  /* ── 前置：坏账本上不许再写（A06；在碰任何事务之前） ─────────────────── */
  const pre = readRecordLedger(spec.kind, rootAbs, { fs: io })
  if (pre.status === 'invalid' || pre.status === 'io-error') {
    return {
      ok: false, state: 'rejected', refusedBeforeCommit: true,
      code: pre.failure ? pre.failure.code : 'LEDGER_INVALID',
      error: pre.failure ? pre.failure.error : `账本不可信（${pre.status}）`,
      failure: pre.failure || null, buildError: null,
      rel: spec.rel, file, seqRel: spec.seqRel, seqFile: seq, id: null, seq: null,
    }
  }
  if (spec.kind === 'answer' && pre.status === 'missing') {
    const msg = `找不到台账 ${file}`
    return {
      ok: false, state: 'rejected', refusedBeforeCommit: true, code: 'IO_ERROR', error: msg,
      failure: makeFailure({ kind: 'io', code: 'IO_ERROR', error: msg, file }),
      buildError: null, rel: spec.rel, file, seqRel: null, seqFile: null, id: null, seq: null,
    }
  }
  // 序号读取故障也要拒（不许把读不动当成 0 重新发号）
  if (seq) {
    try {
      readSequence(seq, { fs: io })
    } catch (e) {
      const code = sysCode(e)
      return {
        ok: false, state: 'rejected', refusedBeforeCommit: true, code: 'IO_ERROR', error: errMessage(e),
        failure: makeFailure({ kind: 'io', code: 'IO_ERROR', error: errMessage(e), file: seq, errorCode: code }),
        buildError: null, rel: spec.rel, file, seqRel: spec.seqRel, seqFile: seq, id: null, seq: null,
      }
    }
  }

  let buildFailure = null
  const build = (ctx) => {
    const files = ctx && ctx.files ? ctx.files : {}
    const has = (r) => Object.prototype.hasOwnProperty.call(files, r)
    if (!rels.every(has)) {
      // 第一次调用：只声明写集（台账 + 序号是**同一个写集**）
      return { operation, value: null, files: rels.map((rel) => ({ rel, content: '' })) }
    }
    const beforeText = files[spec.rel] == null ? '' : String(files[spec.rel])
    const seqText = seq && files[spec.seqRel] != null ? String(files[spec.seqRel]) : ''
    try {
      const out = compute({
        root: rootAbs, fs: ctx.fs, files, plan: ctx.plan,
        rel: spec.rel, file, seqRel: spec.seqRel, seqFile: seq, beforeText, seqText,
      })
      if (!out || typeof out !== 'object') throw new Error('compute 必须返回 { content }')
      if (typeof out.content !== 'string') throw new Error('compute.content 必须是字符串')
      const outFiles = [{ rel: spec.rel, content: out.content }]
      if (spec.seqRel) {
        if (typeof out.seqContent !== 'string') throw new Error('compute.seqContent 必须是字符串（序号与记录同一写集）')
        outFiles.push({ rel: spec.seqRel, content: out.seqContent })
      }
      return {
        operation: typeof out.operation === 'string' && out.operation ? out.operation : operation,
        value: out.value,
        files: outFiles,
      }
    } catch (e) {
      if (!buildFailure) buildFailure = e
      throw e
    }
  }

  const planned = planCommit(rootAbs, build, { fs: io })
  if (!planned.ok) {
    const code = (buildFailure && buildFailure.code) || planned.code
    const error = buildFailure ? errMessage(buildFailure) : planned.error
    const failure = (buildFailure && buildFailure.failure) || planned.failure
    return {
      ok: false, state: 'rejected', code, error, failure,
      buildError: buildFailure ? errMessage(buildFailure) : null,
      buildErrorStatus: buildFailure && Number.isSafeInteger(buildFailure.status) ? buildFailure.status : null,
      selfCheckFailure: !!(buildFailure && buildFailure.selfCheckFailure),
      refusedBeforeCommit: false,
      rel: spec.rel, file, seqRel: spec.seqRel, seqFile: seq, id: null, seq: null,
    }
  }
  return { ok: true, plan: planned.plan, build, rel: spec.rel, file, seqRel: spec.seqRel, seqFile: seq, operation, id: null, seq: null }
}

/** 按三闸提交（`confirm` 由**受信适配层**给：普通写入不弹第二次确认 UI） */
function applyRecordAppend(kind, root, planned, opts = {}) {
  ledgerOf(kind)
  const io = fsOf(opts, 'applyRecordAppend')
  if (!planned || planned.ok !== true || !planned.plan) {
    throw new TypeError('records：必须传 planRecordAppend 的成功结果（不接受手写计划）')
  }
  const extra = commitExtra(opts)
  const res = applyCommit(path.resolve(String(root == null ? '' : root)), planned.plan, {
    confirm: opts.confirm === false ? false : true,
    planDigest: opts.planDigest === undefined ? planned.plan.planDigest : opts.planDigest,
    build: planned.build,
    transaction: commitCapability(opts),
    fs: io,
    ...extra,
  })
  return receiptOf(res, planned)
}

/**
 * 只把**显式且有效**的提交选项往下传（`null`/`undefined` 一律不传 ——
 * 事务件对 `timeoutMs: null` 是明确拒绝的，宿主传 `undefined` 不能变成 null）。
 */
function commitExtra(opts) {
  const o = {}
  if (opts && opts.ownerToken !== undefined && opts.ownerToken !== null) o.ownerToken = String(opts.ownerToken)
  if (opts && Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0) o.timeoutMs = opts.timeoutMs
  return o
}

/**
 * 追加一条记录：坏账本前置拒 → 计划 → 三闸提交；`PLAN_STALE` / `LOCK_BUSY` 时重读重算（有限次）。
 *
 * @param {'ask'|'note'|'adjust'} kind
 * @param {string} root
 * @param {Function} compute 见 `planRecordAppend`
 * @param {{fs?:object, transaction?:object, ownerToken?:string, timeoutMs?:number, retries?:number,
 *          operation?:string, ensureParent?:boolean, confirm?:boolean}} [opts]
 */
function appendRecord(kind, root, compute, opts = {}) {
  const spec = ledgerOf(kind)
  const rootAbs = path.resolve(String(root == null ? '' : root))
  const retries = Number.isSafeInteger(opts.retries) && opts.retries >= 0 ? opts.retries : DEFAULT_RETRIES
  // 既有行为：三个宿主适配层都先建台账目录再进事务（注入的故障 fs 不参与这一步）
  if (opts.ensureParent !== false) {
    try { nodeFs.mkdirSync(path.dirname(ledgerFile(spec.kind, rootAbs)), { recursive: true }) } catch { /* 建不出来就让后面如实失败 */ }
  }
  let attempts = 0
  for (;;) {
    attempts += 1
    const planned = planRecordAppend(kind, rootAbs, compute, opts)
    if (planned.ok !== true) return { ...planned, attempts }
    const receipt = applyRecordAppend(kind, rootAbs, planned, opts)
    if (receipt.ok === true) return { ...receipt, attempts }
    if (!RETRY_CODES[receipt.code] || attempts > retries) return { ...receipt, attempts }
  }
}

/** 记录类提交用的能力（显式注入优先；否则按随包两种布局解析同一份事务件） */
function commitCapability(opts) {
  const given = opts && opts.transaction
  if (given && typeof given.withPackTransaction === 'function') return given
  return defaultTransaction()
}

/* ══════════════════════════════════════════════════════════════════════
 * 七、记录形状的**自检**（写后回读的等价物：对将要提交的字节做）
 * ══════════════════════════════════════════════════════════════════════ */

/** 队列行切分（逐行剥 BOM、跳空行；与既有实现**逐字同口径**） */
function queueLines(text) {
  if (text === null || text === undefined) return []
  return String(text)
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/^\uFEFF/, ''))
    .filter((l) => l.trim())
}

/** 在已有文本后追加一行（没有收尾换行就先补一个） */
function appendLine(beforeText, line) {
  const prefix = beforeText.length > 0 && !beforeText.endsWith('\n') ? `${beforeText}\n` : beforeText
  return `${prefix}${line}\n`
}

/** 自检：最后一行能否解析回来、且与写入的记录逐字段一致 */
function selfCheckJsonl(kind, body, record) {
  const lines = queueLines(body)
  const last = lines[lines.length - 1]
  if (!last) return 're-read 后一条都没有'
  let back = null
  try { back = JSON.parse(last) } catch (e) { return `re-read 的最后一行不是 JSON：${e && e.message ? e.message : e}` }
  if (kind === 'ask') {
    if (JSON.stringify(back) !== JSON.stringify(record)) return '回读字节与写入不一致'
    return null
  }
  if (kind === 'note') {
    if (String(back.id) !== String(record.id) || String(back.text) !== String(record.text) || String(back.anchor) !== String(record.anchor)) {
      return 're-read 的字段与写入不一致'
    }
    if (Object.prototype.hasOwnProperty.call(back, 'date') !== Object.prototype.hasOwnProperty.call(record, 'date')) {
      return 'date 字段存在性与预期不符'
    }
    return null
  }
  if (kind === 'adjust') {
    if (JSON.stringify(back) !== JSON.stringify(record)) return 're-read 的字段与写入不一致'
    return null
  }
  return null
}

/* ══════════════════════════════════════════════════════════════════════
 * 八、四个"追加一条记录"的现成入口（宿主适配层直接委托这些）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 追加一条答疑队列记录（`questions/seq.txt` + `questions/pending.jsonl` 同事务）。
 *
 * @param {string} root
 * @param {{question:string, lesson?:string, page?:string, title?:string}} payload
 * @param {{at:string, fs?:object, transaction?:object, ownerToken?:string, timeoutMs?:number,
 *          retries?:number, lineOf?:Function}} [opts] `at` = 本次写的时间戳（**只取一次**：
 *          计划与锁内重建必须是同一串，否则摘要对不上）
 */
function appendAskRecord(root, payload, opts = {}) {
  const at = String(opts.at == null ? '' : opts.at)
  if (!at) throw new TypeError('records：appendAskRecord 必须给 opts.at（本件不取时钟）')
  const lineOf = typeof opts.lineOf === 'function' ? opts.lineOf : (rec) => JSON.stringify(rec)
  return appendRecord('ask', root, ({ beforeText, seqText }) => {
    const next = nextSeq(seqText)
    const record = buildAskQueueRecord(payload, next.id, at)
    const line = lineOf(record)
    const body = appendLine(beforeText, line)
    const why = selfCheckJsonl('ask', body, record)
    if (why) throw new Error(why)
    return {
      content: body,
      seqContent: ledgerOf('ask').seqBytes(next.seq),
      value: { id: next.id, seq: next.seq, body, record },
    }
  }, opts)
}

/**
 * 追加一条笔记记录（`notes/seq.txt` + `notes/notes.jsonl` 同事务）。
 *
 * @param {string} root
 * @param {{text:string, anchorKey:string, date?:string}} payload `anchorKey` 必须是
 *        调用方**已经解析成身份**的值（显示名 → 身份的换算归写入口，且已从运行态删除）
 * @param {{fs?:object, transaction?:object, ownerToken?:string, timeoutMs?:number, retries?:number,
 *          tamper?:string|null, lineOf?:Function}} [opts] `tamper` 是既有 notes-io 的
 *          自检分支钩子（`corrupt:true`）透传；**生产不传**
 */
function appendNoteRecord(root, payload, opts = {}) {
  const tamper = typeof opts.tamper === 'string' && opts.tamper ? opts.tamper : null
  const lineOf = typeof opts.lineOf === 'function' ? opts.lineOf : (rec) => JSON.stringify(rec)
  return appendRecord('note', root, ({ beforeText, seqText }) => {
    const next = nextSeq(seqText)
    const existing = queueLines(beforeText)
    if (existing.some((l) => {
      try { return String(JSON.parse(l).id) === next.id } catch { return false }
    })) {
      throw new Error(`id ${next.id} 已存在（seq.txt 落后于台账？）：只追加不覆盖`)
    }
    const record = buildNoteRecord({ id: next.id, seq: next.seq, anchorKey: payload.anchorKey, text: payload.text, date: payload.date })
    let line = lineOf(record)
    if (tamper) line += tamper
    const body = appendLine(beforeText, line)
    const why = selfCheckJsonl('note', body, record)
    if (why) {
      const e = new Error(why)
      e.selfCheckFailure = true
      throw e
    }
    return {
      content: body,
      seqContent: ledgerOf('note').seqBytes(next.seq),
      value: { id: next.id, seq: next.seq, body, record, hasDate: payload.date !== undefined },
    }
  }, opts)
}

/**
 * 追加一条课后调整记录（单文件；`learning-records/adjustments.jsonl`）。
 * 写入端在课程包侧（`tools/ask-server.js`），本入口给迁移后的写入与判据用。
 * 形状 = `{ts?, lesson, title, adjust, lit, gaps}`（`ts` 只在 `withTs:true` 且显式给了才写）。
 *
 * @param {string} root
 * @param {{lesson?:string, title?:string, adjust?:string, lit?:boolean|null, gaps?:string[],
 *          ts?:string}} payload 值**原样**写（截断/剥时间戳是**读**投影的事，不是写的事）
 */
function appendAdjustRecord(root, payload, opts = {}) {
  const lineOf = typeof opts.lineOf === 'function' ? opts.lineOf : (rec) => JSON.stringify(rec)
  return appendRecord('adjust', root, ({ beforeText }) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    const record = {}
    if (opts.withTs === true && p.ts !== undefined) record.ts = String(p.ts)
    record.lesson = typeof p.lesson === 'string' ? p.lesson : ''
    record.title = typeof p.title === 'string' ? p.title : ''
    record.adjust = typeof p.adjust === 'string' ? p.adjust : ''
    record.lit = typeof p.lit === 'boolean' ? p.lit : null
    record.gaps = Array.isArray(p.gaps) ? p.gaps.map((g) => String(g)) : []
    const body = appendLine(beforeText, lineOf(record))
    const why = selfCheckJsonl('adjust', body, record)
    if (why) throw new Error(why)
    return { content: body, value: { record } }
  }, opts)
}

/**
 * 追加一条**已答台账条目**（`assets/questions-data.js` 源码手术；单文件）。
 *
 * 自检：新写出的源码必须能被加载、新键恰好一个、旧键一个不少。
 *
 * @param {string} root
 * @param {object} entry 见 `buildAnswerEntry`
 * @param {{fs?:object, transaction?:object, ownerToken?:string, timeoutMs?:number, retries?:number,
 *          require?:Function}} [opts]
 */
function appendAnswerEntry(root, entry, opts = {}) {
  const requireFn = typeof opts.require === 'function' ? opts.require : require
  const key = String(entry && entry.id)
  return appendRecord('answer', root, ({ beforeText, seqRel }) => {
    const src = beforeText === '' ? null : beforeText
    if (src === null) throw new Error(`找不到台账 ${ledgerFile('answer', root)}`)
    let before = null
    try {
      before = loadLedgerSource(src, requireFn)
    } catch (e) {
      throw new Error(`台账 require 失败：${e && e.message ? e.message : e}`)
    }
    if (Object.prototype.hasOwnProperty.call(before, key)) {
      const err = new Error(`台账里已经有 ${key} —— 只追加、不覆盖`)
      err.status = 409
      throw err
    }
    let next = null
    try {
      next = insertEntry(src, key, serializeLedgerEntry(entry))
    } catch (e) {
      const err = new Error(e.message)
      err.status = 409
      throw err
    }
    // 提交前自检：新键在、旧键一个不少、只多一个（与 verifyOrRollback 同口径）
    const check = verifyLedgerSource(next, before, key, requireFn)
    if (!check.ok) {
      const err = new Error(`写入后自检没过（${check.note}）—— 已回滚台账（事务未提交，台账逐字节回到写前）`)
      err.status = 500
      err.selfCheckFailure = true
      throw err
    }
    void seqRel
    return { content: next, value: { selfCheck: check.note, entry } }
  }, { operation: 'POST /answer', ensureParent: false, ...opts })
}

/** 写后自检的**纯**版本（口径与既有 `verifyOrRollback` 判定逐字一致） */
function verifyLedgerSource(src, before, key, requireFn) {
  const after = loadLedgerSource(src, typeof requireFn === 'function' ? requireFn : require)
  const afterKeys = Object.keys(after)
  const beforeKeys = Object.keys(before)
  const added = afterKeys.filter((k) => !beforeKeys.includes(k))
  const lost = beforeKeys.filter((k) => !afterKeys.includes(k))
  if (added.length === 1 && added[0] === key && lost.length === 0) {
    return { ok: true, note: `新增 ${added[0]} · 丢失 无` }
  }
  return { ok: false, note: `新增 ${added.join('、') || '无'} · 丢失 ${lost.join('、') || '无'}` }
}

/* ══════════════════════════════════════════════════════════════════════
 * 九、归档：只搬**确实已答**的记录（pending → processed，同一写集）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把队列文本切成 {drained, kept}（纯函数；正文与键序原样保留，不重排、不重序列化）。
 *
 * @param {string} pendingText
 * @param {Set<string>} answered 确实已答的编号集合
 * @returns {{drained:string[], kept:string[], lines:string[]}}
 */
function splitAnswered(pendingText, answered) {
  const lines = queueLines(pendingText)
  const drained = []
  const kept = []
  for (const line of lines) {
    let rec = null
    try { rec = JSON.parse(line) } catch { kept.push(line); continue }   // 解析不了的一律留下，人工看
    if (rec && typeof rec === 'object' && !Array.isArray(rec) && answered.has(String(rec.id))) drained.push(line)
    else kept.push(line)
  }
  return { drained, kept, lines }
}

/**
 * 归档一次（`questions/pending.jsonl` 与 `questions/processed.jsonl` **同一写集**）。
 *
 * 与旧实现的差别（**收紧**，已登记 Δ）：
 *   · 只搬"台账里有这条 **且** `status === 'answered'`"的记录（旧口径是"登记过就搬"）；
 *   · 队列里没有可归档的行时**零写**（旧实现会原地重写一次 pending）；
 *   · 空队列/无队列文件 → 不碰事务，直接 `committed` + `empty:true`（旧实现空跑一次事务）；
 *   · 台账读不动 / 缺失 / 坏 → **拒**（判不了"哪些已答"就不许归档），不猜、不清空队列。
 *
 * @param {string} root 课程包根
 * @param {{fs?:object, transaction?:object, ownerToken?:string, retryMs?:number,
 *          require?:Function}} [opts]
 * @returns {{drained:number, kept:number, state:string, ok:boolean, error:string|null,
 *            empty:boolean, keptLines:string[], registered:string[], answered:string[],
 *            planDigest?:string|null}}
 */
function archiveAnswered(root, opts = {}) {
  const io = fsOf(opts, 'archiveAnswered')
  const rootAbs = path.resolve(String(root == null ? '' : root))
  const pendingFile = path.join(rootAbs, ...ARCHIVE.pending.split('/'))
  const ownerToken = opts.ownerToken === undefined ? 'records-archive' : String(opts.ownerToken)

  {
    // ① 队列：不存在 / 空 → 没有可归档的，**一个字节都不写**
    let pendingText = ''
    try {
      if (io.existsSync(pendingFile)) pendingText = String(io.readFileSync(pendingFile, 'utf8'))
    } catch (e) {
      return archiveFailure('rejected', 'IO_ERROR', `待答队列读不动（${sysCode(e)}）：${pendingFile}`, [])
    }
    if (!queueLines(pendingText).length) {
      return { drained: 0, kept: 0, state: 'committed', ok: true, error: null, empty: true, keptLines: [], registered: [], answered: [], planDigest: null }
    }

    // ② 已答台账：判不了就不归档（失败关闭；坏账本上一个字节都不动）
    const ans = answeredIds(rootAbs, { fs: io, require: opts.require })
    if (!ans.ok) {
      const code = ans.failure ? ans.failure.code : 'IO_ERROR'
      return archiveFailure('rejected', code, ans.failure ? ans.failure.error : `已答台账不可信（${ans.status}）`, [])
    }
    const answered = new Set(ans.ids)
    const pre = splitAnswered(pendingText, answered)
    if (!pre.drained.length) {
      // 有队列行但一条都没答完 → 队列原样不动（零写）
      return {
        drained: 0, kept: pre.kept.length, state: 'committed', ok: true, error: null,
        empty: false, keptLines: pre.kept, registered: ans.registered.slice(), answered: ans.ids.slice(), planDigest: null,
      }
    }

    // ③ 计划 → 三闸提交（pending 与 processed 同一写集）
    const archiveBuild = ({ files }) => {
      const has = (r) => Object.prototype.hasOwnProperty.call(files || {}, r)
      if (!has(ARCHIVE.pending) || !has(ARCHIVE.processed)) {
        // 第一次调用：只声明写集（两个落点是**同一个写集**）
        return {
          operation: 'drain-questions',
          value: null,
          files: [{ rel: ARCHIVE.pending, content: '' }, { rel: ARCHIVE.processed, content: '' }],
        }
      }
      const pendingBefore = files[ARCHIVE.pending] == null ? '' : String(files[ARCHIVE.pending])
      const processedBefore = files[ARCHIVE.processed] == null ? '' : String(files[ARCHIVE.processed])
      const again = splitAnswered(pendingBefore, answered)
      if (!again.drained.length) {
        throw new Error('队列在计划之后被改过（已无可归档行）—— 本轮不写，请重试')
      }
      return {
        operation: 'drain-questions',
        value: { drained: again.drained, kept: again.kept },
        files: [
          { rel: ARCHIVE.processed, content: `${processedBefore}${again.drained.join('\n')}\n` },
          { rel: ARCHIVE.pending, content: again.kept.length ? `${again.kept.join('\n')}\n` : '' },
        ],
      }
    }
    const planned = planCommit(rootAbs, archiveBuild, { fs: io })
    if (!planned.ok) {
      return archiveFailure('rejected', planned.code, planned.error, pre.kept)
    }
    const res = applyCommit(rootAbs, planned.plan, {
      confirm: true,
      planDigest: planned.plan.planDigest,
      build: archiveBuild,
      transaction: commitCapability(opts),
      fs: io,
      ...commitExtra({ ...opts, ownerToken }),
    })
    const receipt = receiptOf(res, { plan: planned.plan, rel: ARCHIVE.pending, file: pendingFile, seqRel: null, seqFile: null, id: null, seq: null })
    if (receipt.ok) {
      const value = (res && res.value) || {}
      const drained = Array.isArray(value.drained) ? value.drained : []
      const kept = Array.isArray(value.kept) ? value.kept : []
      return {
        drained: drained.length,
        kept: kept.length,
        state: receipt.state,
        ok: true,
        error: null,
        empty: false,
        keptLines: kept,
        registered: ans.registered.slice(),
        answered: ans.ids.slice(),
        planDigest: receipt.planDigest,
      }
    }
    // 锁忙 / 计划过期：**如实回给调用方**，由它决定要不要等（本件不看时钟、不做重试循环）
    return {
      drained: 0, kept: pre.kept.length, state: receipt.state, ok: false, error: receipt.error,
      empty: false, keptLines: pre.kept, registered: ans.registered.slice(), answered: ans.ids.slice(),
      planDigest: receipt.planDigest, code: receipt.code, retryable: retryCodesFor(receipt.code),
    }
  }
}

/** 这两个码表示"现在写不进，忙一会儿该等"（等待策略归调用方：本件不看时钟） */
function retryCodesFor(code) {
  return code === 'LOCK_BUSY' || code === 'PLAN_STALE'
}

function archiveFailure(state, code, error, keptLines) {
  return {
    drained: 0, kept: keptLines.length, state, ok: false, error,
    empty: false, keptLines, registered: [], answered: [],
    code, failure: makeFailure({ kind: state === 'recovery-required' ? 'recovery' : 'io', code: code || 'IO_ERROR', error: error || '归档失败' }),
    planDigest: null,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

function sysCode(e) {
  return e && e.code ? String(e.code) : 'IO_ERROR'
}

function errMessage(e) {
  return e && e.message ? String(e.message) : String(e)
}

function fsOf(opts, where) {
  const io = opts && opts.fs ? opts.fs : nodeFs
  if (!io || typeof io !== 'object') throw new TypeError(`records.${where}：fs 注入必须是对象`)
  if (typeof io.readFileSync !== 'function' || typeof io.existsSync !== 'function') {
    throw new TypeError(`records.${where}：fs 注入至少要提供 readFileSync() 与 existsSync()`)
  }
  return io
}

module.exports = {
  // 落点与序号
  RECORD_KINDS,
  LEDGERS,
  ARCHIVE,
  SEQ_WIDTH,
  ledgerOf,
  ledgerFile,
  seqFile,
  formatId,
  seqFromText,
  nextSeq,
  readSequence,
  // 身份 vs 页面锚点
  PAGE_ANCHOR_RE,
  isPageAnchor,
  pageAnchorOf,
  parsePageAnchor,
  UNROUTED_ANCHOR,
  REF_REASONS,
  REF_CODES,
  buildCatalogue,
  classifyCourseRef,
  classifyNoteAnchor,
  // 记录构建（唯一）
  buildAskQueueRecord,
  buildNoteRecord,
  normalizeAdjustmentRecord,
  buildAnswerEntry,
  LEDGER_ANCHOR,
  LEDGER_MARKER,
  emptyLedgerSource,
  serializeLedgerEntry,
  insertEntry,
  loadLedgerSource,
  verifyLedgerSource,
  // 读取（五态）
  readRecordLedger,
  readAnswerLedger,
  answeredIds,
  // 共同提交
  RETRY_CODES,
  DEFAULT_RETRIES,
  planRecordAppend,
  applyRecordAppend,
  appendRecord,
  countingTransaction,
  recoveryResidue,
  receiptOf,
  // 现成写入口
  appendAskRecord,
  appendNoteRecord,
  appendAdjustRecord,
  appendAnswerEntry,
  // 归档
  queueLines,
  splitAnswered,
  archiveAnswered,
  COMMIT_STATES,
}
