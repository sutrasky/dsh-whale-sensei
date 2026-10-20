'use strict'
/**
 * lib/unify/errors.cjs —— U 系列**唯一的失败结构**（U03 新建）
 * ==================================================================
 * 这个文件只做两件事，别的都不做：
 *
 *   ① `failure` 结构：`{kind, code, error, file?, line?, errorCode?}`
 *      `kind` ∈ `input / confirmation / conflict / io / recovery`（U-SPEC §3 的五种失败面）。
 *      `code` 是**业务/系统码值本身**（例：`IO_ERROR` / `LEDGER_INVALID` / `ENOENT`）——
 *      本文件**不翻译、不改写、不新增别名**。
 *      `errorCode` 只放**原始系统错误码**（`ENOENT` / `EISDIR` / `EACCES` …）原样保留，
 *      绝不把 `EACCES` 折成 `IO_ERROR` 把原值丢掉。
 *
 *   ② `makeFailure(...)` 工厂：**只造 failure 对象，不合并、不覆盖任何领域对象**。
 *      - 它把入参的已知字段抄进一个**新对象**，返回；入参本身一个字节都不改。
 *      - 入参里多出来的领域字段（例如领域自己的顶层 `kind` / `code` / `status` / `ok`）
 *        既不读也不写也不带出 —— 领域顶层 `kind`/`code` 归领域自己，失败信息挂在
 *        `failure` 字段里随回执一起返回（调用方写 `{ ...domain, failure: makeFailure(...) }`）。
 *      - 非法 `kind` **明确拒绝**（抛 `TypeError`），不返回半成品对象 —— 这是本卡选定的
 *        拒绝方式（见回执 `errors.factoryRejection`）。`code` / `error` 缺失或空串同样抛，
 *        因为"有失败但没有码/没有话说"的回执等于吞错。
 *
 * 纪律（卡面硬约束）：
 *   - 纯 CJS，**零 require**：没有 IO、没有时钟、没有 `process.env`、没有随机数。
 *     同一入参永远同一输出 —— 判据才可复算。
 *   - 不新增"改名表"/"白名单"：`NEW_CODES` 只是 U-SPEC 拟新增那五个码的**落点**，
 *     不是允许改旧码的许可，也不参与任何改名逻辑（U01 §5.3 查重结论：五项零冲突）。
 *   - 旧码值语义一个都不动：本文件不定义任何既有码的"新含义"。
 */

/**
 * `kind` 的封闭取值域（U-SPEC §3）。顺序即文档顺序，不在集合里的一律拒绝。
 * @type {ReadonlyArray<'input'|'confirmation'|'conflict'|'io'|'recovery'>}
 */
const FAILURE_KINDS = Object.freeze(['input', 'confirmation', 'conflict', 'io', 'recovery'])

/** `failure` 允许出现的键（顺序即生成顺序；`file` / `line` / `errorCode` 可选）。 */
const FAILURE_KEYS = Object.freeze(['kind', 'code', 'error', 'file', 'line', 'errorCode'])

/**
 * U-SPEC §3 拟新增的五个码值 —— 只在这个文件里落地（卡面写集），
 * U01 已在固定基线上查重：形状扫描 0 命中、全仓字面搜索 0 命中，无语义冲突。
 * ⚠️ 这是**新增码**，不是旧码别名；任何旧码（`IO_ERROR` / `PLAN_STALE` / kebab 码族…）
 *    的码值语义都不因它的存在而改变。
 */
const NEW_CODES = Object.freeze({
	ID_AMBIGUOUS: 'ID_AMBIGUOUS',
	MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
	LEDGER_INVALID: 'LEDGER_INVALID',
	LOCK_BUSY: 'LOCK_BUSY',
	RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
})

function fail(message) {
	throw new TypeError(`makeFailure：${message}`)
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 截一段可读的值描述给错误信息用（不 JSON.stringify 整个对象，避免把正文带进日志）。
 * @param {unknown} v
 */
function describe(v) {
	if (v === null) return 'null'
	if (Array.isArray(v)) return 'array'
	if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)
	return typeof v
}

/**
 * 造一个 `failure` 对象。**只造不合并**：不修改入参、不覆盖领域顶层 `kind`/`code`。
 *
 * @param {{kind: string, code: string, error: string,
 *          file?: string, line?: number, errorCode?: string}} input
 * @returns {{kind: string, code: string, error: string,
 *            file?: string, line?: number, errorCode?: string}}
 * @throws {TypeError} `kind` 不在 `FAILURE_KINDS` 里；`code` / `error` 不是非空字符串；
 *                     `file` / `errorCode` 不是非空字符串；`line` 不是正整数。
 */
function makeFailure(input) {
	if (!isPlainObject(input)) fail(`入参必须是对象（实得 ${describe(input)}）`)

	const kind = input.kind
	if (typeof kind !== 'string') fail(`kind 必须是字符串（实得 ${describe(kind)}）`)
	if (!FAILURE_KINDS.includes(kind)) {
		fail(`非法 kind ${JSON.stringify(kind)}（只认 ${FAILURE_KINDS.join(' / ')}）`)
	}

	const code = input.code
	if (typeof code !== 'string' || code.trim() === '') {
		fail(`code 必须是非空字符串（实得 ${describe(code)}）—— 失败不能没有码`)
	}

	const error = input.error
	if (typeof error !== 'string' || error.trim() === '') {
		fail(`error 必须是非空字符串（实得 ${describe(error)}）—— 失败不能没有话说`)
	}

	const out = { kind, code, error }

	if (input.file !== undefined) {
		if (typeof input.file !== 'string' || input.file === '') fail(`file 必须是非空字符串（实得 ${describe(input.file)}）`)
		out.file = input.file
	}
	if (input.line !== undefined) {
		const line = input.line
		if (!Number.isSafeInteger(line) || line < 1) fail(`line 必须是 >=1 的整数（实得 ${describe(line)}）`)
		out.line = line
	}
	if (input.errorCode !== undefined) {
		if (typeof input.errorCode !== 'string' || input.errorCode === '') {
			fail(`errorCode 必须是非空字符串（实得 ${describe(input.errorCode)}）—— 系统码要原样保留`)
		}
		out.errorCode = input.errorCode
	}
	return out
}

/**
 * 是不是一个形状合法的 `failure`（判据侧用；不校验语义、不做领域归并）。
 * 只认 `FAILURE_KEYS` 的子集，且 `kind`/`code`/`error` 必须在场。
 * @param {unknown} v
 * @returns {boolean}
 */
function isFailure(v) {
	if (!isPlainObject(v)) return false
	for (const key of Object.keys(v)) {
		if (!FAILURE_KEYS.includes(key)) return false
	}
	if (!FAILURE_KINDS.includes(v.kind)) return false
	if (typeof v.code !== 'string' || v.code === '') return false
	if (typeof v.error !== 'string' || v.error === '') return false
	if (v.file !== undefined && (typeof v.file !== 'string' || v.file === '')) return false
	if (v.line !== undefined && (!Number.isSafeInteger(v.line) || v.line < 1)) return false
	if (v.errorCode !== undefined && (typeof v.errorCode !== 'string' || v.errorCode === '')) return false
	return true
}

module.exports = { FAILURE_KINDS, FAILURE_KEYS, NEW_CODES, makeFailure, isFailure }
