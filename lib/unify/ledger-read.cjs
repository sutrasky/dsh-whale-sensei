'use strict'
/**
 * lib/unify/ledger-read.cjs —— 台账读取的**唯一五态契约**（U03 新建）
 * ==================================================================
 * 做的是"从磁盘读到 `{entries, problems}` 这一步"，以及**把读取结果分成五态**：
 *
 *   | status     | 什么时候                                   | 领域层怎么用                        |
 *   |------------|--------------------------------------------|-------------------------------------|
 *   | `missing`  | **只有真 ENOENT**（文件确实不存在）        | 唯一允许走既有"没有台账"回退        |
 *   | `empty`    | 文件存在，但一条有效记录都没有             | 明确不足（不许回退）                |
 *   | `ok`       | 至少一条有效记录、且没有 problems          | 正常读                              |
 *   | `invalid`  | 有坏行 / 坏 JSON / `null` / 非记录 / 校验不过 | 读不出可信账本 → 阻断              |
 *   | `io-error` | 目录 / 权限 / 其它读取故障                 | 读取故障 → 阻断（**不是**"没台账"） |
 *
 * 这些取值**不是本文件发明的**：`lib/state.js:205` 的
 * `EVIDENCE_STATUSES = ['missing','empty','ok','invalid','io-error']` 与
 * `lib/evidence-io.js` 的 `readEvidence` 已经是这套五态（U01 基线实测），
 * 本文件把它抽成与领域无关的一份，供后续 `lib/unify/*` 统一消费。
 *
 * ## 只做这些，不做这些
 *
 * 做：按**声明的** format（`json` / `jsonl`，缺省不猜、直接拒）解析；
 *     逐条结构校验（记录必须是对象）；调 `validate` 拿规范记录或收下它的结构错误；
 *     坏记录**不进 `entries`**、进 `problems`，且 jsonl 逐行带行号；
 *     原始系统错误码**原样**放在 `errorCode`；失败信息造成 `failure`（errors.cjs 的工厂）。
 *
 * **不做**（这些留归各领域，卡面明写）：
 *   - 不做领域归并：不取"最新一条"、不排版本链、不取证据最高档、不管队列生命周期；
 *   - 不代替提交协议（三闸、摘要、锁、回滚都归 commit 协议那一层）；
 *   - 不猜格式、不把 jsonl 当 json 兜底、不把 `io-error` 折成 `missing`/`empty`；
 *   - 不写盘：只碰一次 `readFileSync`，别的 fs 能力一个都不调用（`fs` 可注入，见下）。
 *
 * ## 失败结构
 *
 * `missing` **不是失败**（领域可以合法地"还没有台账"，回不退由领域决定），所以不给 `failure`；
 * `invalid` → `failure.kind='input'`、`code='LEDGER_INVALID'`（U-SPEC 拟新增码，U01 查重 0 冲突）；
 * `io-error` → `failure.kind='io'`、`code='IO_ERROR'`（既有码值，不改名）+ `errorCode` 原系统码。
 */

const path = require('node:path')
const nodeFs = require('node:fs')
const { makeFailure } = require('./errors.cjs')

/** 五态（顺序即文档顺序，不在集合里的 status 不许出现）。 */
const LEDGER_STATUSES = Object.freeze(['missing', 'empty', 'ok', 'invalid', 'io-error'])

/** 只认这两种声明格式；别的直接拒（**不许猜**）。 */
const LEDGER_FORMATS = Object.freeze(['json', 'jsonl'])

/**
 * 读取故障的状态字面量。
 * ⚠️ 这是 A07 的**变异落点**：把它改成 `'empty'`（"目录/权限读取失败折成空态"），
 *    判据必须红。所以它单独成一个常量，不散落在几处。
 */
const IO_ERROR_STATUS = 'io-error'

/** 既有业务码：读取故障的**业务**码（不新增同义码，也不改这个码的既有语义）。 */
const IO_ERROR_CODE = 'IO_ERROR'

/* ── 纯工具（无 IO、无时钟） ─────────────────────────────────────────── */

function isPlainRecord(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 给错误信息用的值描述：只说形状，不带正文。 */
function describeValue(v) {
	if (v === null) return 'null'
	if (Array.isArray(v)) return 'array'
	if (typeof v === 'string') return `string(${v.length})`
	return typeof v
}

/**
 * `JSON.parse` 报错 → 行号。优先用消息里自带的 `(line N column M)`；
 * 没有再按 `position` 数换行。都没有就返回 `null`（不猜）。
 * @param {string} text
 * @param {string} message
 * @returns {number|null}
 */
function lineOfParseError(text, message) {
	const msg = String(message == null ? '' : message)
	const byLine = /\(line (\d+) column \d+\)/.exec(msg)
	if (byLine) return Number(byLine[1])
	const byPos = /position (\d+)/i.exec(msg)
	if (!byPos) return null
	const pos = Number(byPos[1])
	if (!Number.isSafeInteger(pos) || pos < 0 || pos > text.length) return null
	let line = 1
	for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line += 1
	return line
}

function errMessage(e) {
	return String((e && e.message) || e)
}

/* ── 解析 ───────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} ReadLedgerResult
 * @property {string} file            解析后的绝对路径
 * @property {boolean} exists         路径上有没有东西（真 ENOENT 才是 false）
 * @property {'missing'|'empty'|'ok'|'invalid'|'io-error'} status
 * @property {object[]} entries       只含**有效**记录（坏记录一条都不进）
 * @property {string[]} problems      逐条问题（jsonl 带 `第 N 行`；json 带行号或记录序号）
 * @property {string} [errorCode]     原始系统错误码（`ENOENT` / `EISDIR` / `EACCES` …）
 * @property {object} [failure]       errors.cjs 的 failure（`invalid` / `io-error` 时给）
 */

/**
 * 读一本台账。
 *
 * @param {string} file 台账绝对路径
 * @param {{format: 'json'|'jsonl', validate?: Function, fs?: object}} options
 *   - `format` **必填**，`json` = 整文件一个 JSON 数组；`jsonl` = 一行一条记录。
 *     别的值（含缺省）一律 `TypeError` —— 不猜、不兜底。
 *   - `validate(record, {line, index})` 可选：返回**规范记录**，或用抛结构错误表示"这条不合法"。
 *     抛错 = 该条进 `problems`、**不进** `entries`（不会被静默丢掉，也不会被静默收下）。
 *   - `fs` 可选：只用于**确定性注入**（缺省 `node:fs`）。只会被调用 `readFileSync`。
 * @returns {ReadLedgerResult}
 */
function readLedger(file, options) {
	const opts = options !== null && typeof options === 'object' ? options : {}

	const format = opts.format
	if (!LEDGER_FORMATS.includes(format)) {
		throw new TypeError(
			`readLedger：format 必须显式声明为 ${LEDGER_FORMATS.join(' / ')}（实得 ${describeValue(format)}）—— 不猜格式`,
		)
	}
	const validate = opts.validate
	if (validate !== undefined && validate !== null && typeof validate !== 'function') {
		throw new TypeError(`readLedger：validate 必须是函数或省略（实得 ${describeValue(validate)}）`)
	}
	const io = opts.fs === undefined || opts.fs === null ? nodeFs : opts.fs
	if (!io || typeof io.readFileSync !== 'function') {
		throw new TypeError('readLedger：注入的 fs 必须至少提供 readFileSync()')
	}

	const abs = path.resolve(String(file == null ? '' : file))

	/* ① 读：一次 readFileSync，没有任何写能力 */
	let text
	try {
		text = io.readFileSync(abs, 'utf8')
	} catch (e) {
		const code = String((e && e.code) || IO_ERROR_CODE)
		// ⚠️ **只有真 ENOENT 才算"不存在"**。EISDIR（路径是目录）/ EACCES（读不动）/
		//    EPERM / EMFILE… 一律是**读取故障**，不许伪装成"从没写过台账"。
		if (code === 'ENOENT') {
			return {
				file: abs,
				exists: false,
				status: 'missing',
				entries: [],
				problems: [],
				errorCode: 'ENOENT',
			}
		}
		return ioErrorResult(abs, code, errMessage(e))
	}

	/* ② 剥 BOM（与 lib/evidence-io.js 同口径：BOM 不算坏行） */
	const body = String(text == null ? '' : text).replace(/^\uFEFF/, '')

	const entries = []
	const problems = []
	let firstLine = null

	/**
	 * 记一条问题。`line` 只在**能定位到行**时给（jsonl 的行号、json 整文件解析出错的行）。
	 * @param {number|null} line
	 * @param {string} text
	 */
	const addProblem = (line, textMessage) => {
		if (Number.isInteger(line) && firstLine === null) firstLine = line
		problems.push(textMessage)
	}

	/**
	 * 一条候选记录 → `entries` 或 `problems`（**坏记录绝不进 entries**）。
	 * @param {unknown} record
	 * @param {number|null} line 行号（jsonl）或 null
	 * @param {string} where    问题文本里指代这一条的说法（`第 3 行` / `记录 #2`）
	 * @param {number} index    0 基序号（给 validate 第二参）
	 */
	const accept = (record, line, where, index) => {
		if (!isPlainRecord(record)) {
			addProblem(line, `${where}不是记录（应为对象，实得 ${describeValue(record)}）`)
			return
		}
		if (typeof validate !== 'function') {
			entries.push(record)
			return
		}
		let normal
		try {
			normal = validate(record, { line, index })
		} catch (e) {
			addProblem(line, `${where}不合规：${errMessage(e)}`)
			return
		}
		if (!isPlainRecord(normal)) {
			// 校验器自己没给出规范记录 = 不可信，按坏记录处理（不偷偷退回原始对象）
			addProblem(line, `${where}不合规：校验器没有返回规范记录（实得 ${describeValue(normal)}）`)
			return
		}
		entries.push(normal)
	}

	/* ③ 按**声明**的格式解析（json / jsonl 互不兜底） */
	if (format === 'json') {
		let doc
		try {
			doc = JSON.parse(body)
		} catch (e) {
			const line = lineOfParseError(body, errMessage(e))
			addProblem(line, line === null
				? `整文件不是合法 JSON：${errMessage(e)}`
				: `第 ${line} 行不是 JSON：${errMessage(e)}`)
			return invalidResult(abs, entries, problems, firstLine)
		}
		if (!Array.isArray(doc)) {
			addProblem(null, `整文件不是记录集合（应为数组，实得 ${describeValue(doc)}）`)
			return invalidResult(abs, entries, problems, firstLine)
		}
		for (let i = 0; i < doc.length; i++) accept(doc[i], null, `记录 #${i + 1}`, i)
	} else {
		const lines = body.split(/\r?\n/)
		for (let i = 0; i < lines.length; i++) {
			const lineNo = i + 1
			const raw = lines[i].trim()
			if (!raw) continue // 空行既不是记录也不是问题（与 evidence-io / goal-io 同口径）
			let record
			try {
				record = JSON.parse(raw)
			} catch (e) {
				addProblem(lineNo, `第 ${lineNo} 行不是 JSON：${errMessage(e)}`)
				continue
			}
			accept(record, lineNo, `第 ${lineNo} 行`, i)
		}
	}

	/* ④ 分态 */
	if (problems.length) return invalidResult(abs, entries, problems, firstLine)
	return {
		file: abs,
		exists: true,
		status: entries.length ? 'ok' : 'empty',
		entries,
		problems: [],
	}
}

/**
 * 读取故障的统一出口（`io-error`）：**不是** missing、**不是** empty，
 * 系统错误码原样带出，同时给 `failure` 让上层不必自己拼。
 */
function ioErrorResult(abs, code, message) {
	const text = `台账读不动（${code}）：${message}`
	return {
		file: abs,
		exists: true,
		status: IO_ERROR_STATUS,
		entries: [],
		problems: [text],
		errorCode: code,
		failure: makeFailure({
			kind: 'io',
			code: IO_ERROR_CODE,
			error: text,
			file: abs,
			errorCode: code,
		}),
	}
}

/**
 * 坏账统一出口（`invalid`）：好行照收（不吞），整本账**不可信**由 `status` 说清；
 * `failure.line` 指第一处可定位的坏行（定位不到就不给 `line`）。
 */
function invalidResult(abs, entries, problems, firstLine) {
	const failure = makeFailure({
		kind: 'input',
		code: 'LEDGER_INVALID',
		error: `台账不可信（${problems.length} 处）：${problems[0]}`,
		file: abs,
		line: firstLine === null ? undefined : firstLine,
	})
	return { file: abs, exists: true, status: 'invalid', entries, problems, failure }
}

module.exports = { readLedger, LEDGER_STATUSES, LEDGER_FORMATS, IO_ERROR_STATUS, IO_ERROR_CODE }
