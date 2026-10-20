'use strict'
/**
 * lib/unify/identity.cjs —— 身份内核（U02）：知识点键与课次键的唯一严格实现
 * ======================================================================
 * 身份只由两部分 / 三部分组成：
 *   知识点键   circle/point
 *   课次键     circle/point/NNNN（课号 1–9999，四位十进制）
 *
 * 本文件是**纯函数模块**：不读盘、不写盘、不取时、不随机、不看环境与进程，
 * 也没有模块级可变状态 —— 同一输入永远同一输出，故可以直接进随包闭包。
 *
 * 与既有导出的关系（U-SPEC §2；过渡期**暂存双实现**）：
 *   · lib/pack-model.js 的 pointKey/lessonKey 是既有公开导出；本模块承接它们的**严格内核**：
 *     合法输入的返回字符串与既有实现**逐字节一致**（`circle/point`、
 *     `circle/point/四位课号`；课号用 padStart(4,'0')）。
 *   · 差别只在**非法输入**：既有实现直接拼（padStart 不做范围校验；任何类型都照拼），
 *     本模块对每个组成部分逐个校验，不合法就抛 IdentityError。
 *     这条差异由 U02 回执锁定；把旧导出委托到本内核**只归 U09**，
 *     收敛前禁止出现第三份同义实现。
 *
 * 解析接口是新增设计（U-SPEC §2）：
 *   parsePointKey(value) → { ok:true, value:{circle,point} } | { ok:false, failure }
 *   parseLessonKey(value) → { ok:true, value:{circle,point,number} } | { ok:false, failure }
 * 运行态**只认**规范形状：裸知识点、把两段点键当课键、显示名（「第1课」「Vue 第1课」）、
 * 空段、路径逃逸、非四位课号、超范围课号一律拒绝 —— 不猜、不回退、不识别历史身份
 * （历史解码只归 lib/unify/migration.cjs，本模块不做任何隐式双读）。
 *
 * failure 形状（本卡锁定，U02 回执登记）：
 *   { kind:'input', reason, field, value, error }
 *   · reason 是本模块**自己的**机器枚举（REASONS），不是全仓错误码表；
 *   · 全仓错误码只归 U03 的 errors.cjs —— 这里**不新增、不复用**任何 code 值，
 *     避免与既有 86 个码值（docs/unify/interfaces.md §5）撞车。
 */

/** 失败原因枚举（本模块私有语义；不外溢成全仓错误码） */
const REASONS = Object.freeze({
  NOT_STRING: 'not-string',
  EMPTY: 'empty',
  WHITESPACE_ONLY: 'whitespace-only',
  UNTRIMMED: 'untrimmed',
  SEPARATOR: 'contains-separator',
  PATH_ESCAPE: 'path-escape',
  DRIVE_LETTER: 'drive-letter',
  CONTROL_CHAR: 'control-char',
  NOT_NUMBER: 'not-number',
  NOT_INTEGER: 'not-integer',
  LESSON_OUT_OF_RANGE: 'lesson-out-of-range',
  LESSON_NOT_DIGITS: 'lesson-not-digits',
  LESSON_WIDTH: 'lesson-width',
  SEGMENT_COUNT: 'segment-count',
})

/** 课号契约：1–9999，四位十进制。上限是**拒绝**线，不是截断/取模的起点。 */
const LESSON_NUMBER_MIN = 1
const LESSON_NUMBER_MAX = 9999
const LESSON_WIDTH = 4

/** 构造期失败：携带冻结的 failure，调用方既能 catch 也能机器判读。 */
class IdentityError extends Error {
  constructor(failure) {
    super(failure.error)
    this.name = 'IdentityError'
    this.failure = failure
  }
}

/** 值的人话形状（拒绝理由里要能看出实得什么，不能只说"错了"） */
function describeValue(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`
  if (typeof value === 'number') return `数字 ${String(value)}`
  return typeof value
}

/** 冻结一条 failure（不可变；解析接口直接把它交给调用方） */
function failureOf(reason, field, value, error) {
  return Object.freeze({ kind: 'input', reason, field, value, error })
}

/** 按 failure 抛错（构造函数的唯一拒绝出口） */
function reject(reason, field, value, error) {
  throw new IdentityError(failureOf(reason, field, value, error))
}

/**
 * 一个组成部分（circle / point）的形状检查。
 * 合法 = 非空、非空白、前后无空白、不含身份分隔符 `/`、不是路径逃逸形状、无控制字符。
 * 不额外收紧字符集：既有合法 id 的结果必须原样保住（见文件头）。
 */
function componentProblem(value) {
  if (typeof value !== 'string') {
    return { reason: REASONS.NOT_STRING, error: `组成部分必须是字符串（实得 ${describeValue(value)}）` }
  }
  if (value === '') return { reason: REASONS.EMPTY, error: '组成部分不能是空串' }
  if (value.trim() === '') return { reason: REASONS.WHITESPACE_ONLY, error: '组成部分不能只有空白' }
  if (value !== value.trim()) return { reason: REASONS.UNTRIMMED, error: '组成部分前后不能带空白' }
  if (value.includes('/')) {
    return { reason: REASONS.SEPARATOR, error: '组成部分不能含 "/" —— 它是身份分隔符' }
  }
  if (/^[A-Za-z]:/.test(value)) {
    return { reason: REASONS.DRIVE_LETTER, error: '组成部分不能是盘符形状' }
  }
  if (value.includes('\\') || value === '.' || value.includes('..')) {
    return { reason: REASONS.PATH_ESCAPE, error: '组成部分不能是路径逃逸形状（反斜杠 / . / ..）' }
  }
  if (/[\u0000-\u001f]/.test(value)) {
    return { reason: REASONS.CONTROL_CHAR, error: '组成部分不能含控制字符' }
  }
  return null
}

/** 校验一个组成部分，不合法就抛（构造函数的公共入口） */
function componentOrThrow(field, value) {
  const problem = componentProblem(value)
  if (problem) reject(problem.reason, field, value, `${field} 不合法：${problem.error}`)
  return value
}

/** 课号的严格校验：只认 number 类型的整数，且必须落在 1–9999 */
function lessonNumberOrThrow(number) {
  if (typeof number !== 'number') {
    reject(REASONS.NOT_NUMBER, 'number', number,
      `课号必须是数字类型（实得 ${describeValue(number)}）；不接受字符串、布尔或 null`)
  }
  if (!Number.isInteger(number)) {
    reject(REASONS.NOT_INTEGER, 'number', number, `课号必须是整数（实得 ${String(number)}）`)
  }
  if (number < LESSON_NUMBER_MIN || number > LESSON_NUMBER_MAX) {
    reject(REASONS.LESSON_OUT_OF_RANGE, 'number', number,
      `课号必须在 ${LESSON_NUMBER_MIN}–${LESSON_NUMBER_MAX} 之间（实得 ${String(number)}）；超范围一律拒绝，不截断、不取模、不自动减 fileBase`)
  }
  return number
}

/** 四位十进制（padStart 只用于合法课号；超范围的号根本到不了这里） */
function padLessonNumber(number) {
  return String(number).padStart(LESSON_WIDTH, '0')
}

/**
 * 知识点的规范 id —— 既有导出的**严格内核**（合法输入逐字节一致）。
 *
 * @param {string} circle 圆圈 id（如 `programming`）
 * @param {string} point  知识点 id（如 `spring-boot`）
 * @returns {string} `programming/spring-boot`
 * @throws {IdentityError} 组成部分不合法
 */
function pointKey(circle, point) {
  const c = componentOrThrow('circle', circle)
  const p = componentOrThrow('point', point)
  return `${c}/${p}`
}

/**
 * 课程的规范 id —— 既有导出的**严格内核**（合法输入逐字节一致）。
 *
 * @param {string} circle 圆圈 id
 * @param {string} point  知识点 id
 * @param {number} number 课号（1–9999 的整数）
 * @returns {string} `programming/spring-boot/0001`
 * @throws {IdentityError} 组成部分或课号不合法
 */
function lessonKey(circle, point, number) {
  const c = componentOrThrow('circle', circle)
  const p = componentOrThrow('point', point)
  const n = lessonNumberOrThrow(number)
  return `${c}/${p}/${padLessonNumber(n)}`
}

/** 键的公共形状检查：类型 / 空 / 空白 / 前后空白 / 段数 */
function splitKey(value, kind) {
  const fail = (reason, field, error) => ({ ok: false, failure: failureOf(reason, field, value, error) })
  if (typeof value !== 'string') {
    return fail(REASONS.NOT_STRING, 'value', `键必须是字符串（实得 ${describeValue(value)}）`)
  }
  if (value === '') return fail(REASONS.EMPTY, 'value', '键不能是空串')
  if (value.trim() === '') return fail(REASONS.WHITESPACE_ONLY, 'value', '键不能只有空白')
  if (value !== value.trim()) return fail(REASONS.UNTRIMMED, 'value', '键前后不能带空白')
  const want = kind === 'lesson' ? 3 : 2
  const segments = value.split('/')
  if (segments.length !== want) {
    const shape = want === 2 ? 'circle/point' : 'circle/point/NNNN'
    return fail(REASONS.SEGMENT_COUNT, 'value',
      `${kind === 'lesson' ? '课次键' : '知识点键'}必须恰好 ${want} 段（${shape}），实得 ${segments.length} 段`)
  }
  return { ok: true, segments }
}

/** 逐个校验组成部分，返回第一条 failure（没有就 null） */
function firstComponentProblem(pairs) {
  for (const pair of pairs) {
    const field = pair[0]
    const raw = pair[1]
    const problem = componentProblem(raw)
    if (problem) return failureOf(problem.reason, field, raw, `${field} 不合法：${problem.error}`)
  }
  return null
}

/** 课号段（字符串）：只认四位十进制，且数值落在 1–9999 */
function lessonNumberSegment(text) {
  if (text === '') return { ok: false, reason: REASONS.EMPTY, error: '课号段不能是空串' }
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, reason: REASONS.LESSON_NOT_DIGITS, error: `课号段只能是十进制数字（实得 ${JSON.stringify(text)}）` }
  }
  if (text.length !== LESSON_WIDTH) {
    return { ok: false, reason: REASONS.LESSON_WIDTH, error: `课号段必须正好 ${LESSON_WIDTH} 位（实得 ${text.length} 位：${text}）` }
  }
  const number = Number(text)
  if (number < LESSON_NUMBER_MIN || number > LESSON_NUMBER_MAX) {
    return {
      ok: false,
      reason: REASONS.LESSON_OUT_OF_RANGE,
      error: `课号必须在 ${LESSON_NUMBER_MIN}–${LESSON_NUMBER_MAX} 之间（实得 ${text}）`,
    }
  }
  return { ok: true, number }
}

/**
 * 解析一个知识点键 —— 只认 `circle/point`。
 *
 * @param {string} value
 * @returns {{ok:true, value:{circle:string, point:string}}|{ok:false, failure:object}}
 */
function parsePointKey(value) {
  const shape = splitKey(value, 'point')
  if (!shape.ok) return shape
  const circle = shape.segments[0]
  const point = shape.segments[1]
  const problem = firstComponentProblem([['circle', circle], ['point', point]])
  if (problem) return { ok: false, failure: problem }
  return { ok: true, value: Object.freeze({ circle, point }) }
}

/**
 * 解析一个课次键 —— 只认 `circle/point/NNNN`。
 *
 * @param {string} value
 * @returns {{ok:true, value:{circle:string, point:string, number:number}}|{ok:false, failure:object}}
 */
function parseLessonKey(value) {
  const shape = splitKey(value, 'lesson')
  if (!shape.ok) return shape
  const circle = shape.segments[0]
  const point = shape.segments[1]
  const numberText = shape.segments[2]
  const problem = firstComponentProblem([['circle', circle], ['point', point]])
  if (problem) return { ok: false, failure: problem }
  const parsed = lessonNumberSegment(numberText)
  if (!parsed.ok) {
    return { ok: false, failure: failureOf(parsed.reason, 'number', numberText, parsed.error) }
  }
  return { ok: true, value: Object.freeze({ circle, point, number: parsed.number }) }
}

module.exports = Object.freeze({
  pointKey,
  lessonKey,
  parsePointKey,
  parseLessonKey,
  IdentityError,
  REASONS,
  LESSON_NUMBER_MIN,
  LESSON_NUMBER_MAX,
  LESSON_WIDTH,
})
