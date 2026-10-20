'use strict'
/**
 * lib/unify/commit.cjs —— **共同提交守卫**（U06 新建）
 * ==================================================================
 * 本件只做一件事：把"要写什么"变成**计划**，再把计划**按三闸顺序**提交掉。
 * 它**不**自己拿锁、**不**自己写日志、**不**自己回滚 —— 那是
 * `lib/pack-template/tools/ledger-transaction.cjs`（下称"事务件"）已有的那一套：
 * 包锁 `.whale-write.lock`、`whale-txn/1` 日志、七态、`recoverPack` 离线恢复。
 * 本件是**消费方**，不是第二套事务系统（卡面硬约束）。
 *
 * ## 接口（U-SPEC §3 的设计接口†，本卡落地）
 *
 *   planCommit(root, build, {fs})
 *      → {ok:true, plan:{schema:'whale-commit/1', root, operation, files, planDigest}}
 *      → {ok:false, code, error, failure, plan:null}
 *
 *   applyCommit(root, plan, {confirm, planDigest, build, transaction, fs})
 *      → {ok, state, code?, error?, failure?, rollbackError?, journal?, value?}
 *
 * `build({root, fs, files, plan})` 是**同步**的纯计算函数（与事务件的 build 同一形状）：
 *   · `files` = 每个目标**写前的字节**（`null` = 本来没有；值是 utf8 字符串）
 *   · 返回 `[{rel, content|remove:true}]` 或 `{operation?, value?, files:[...]}`
 *   · **不许写盘**：本件交给它的是一个**只读 fs 视图**，写能力一调就抛
 *     （"build 不写权威目标，字节在暂存重建" —— 卡面原文）。
 *
 * ## 三闸（固定顺序，不许换）
 *
 *   ① 有效计划 / 目标 / 操作   —— 形状、schema、root 一制、rel 在包根内、排序去重、
 *                                 计划自身的 planDigest 与内容相符（被改过就拒）
 *   ↓ 拒绝 = `PLAN_REQUIRED`（kind=input）
 *   ② 显式确认                 —— `confirm:true`（**不是**"看起来像真"）+ 调用方回引
 *                                 的 `planDigest` 必须正好是这份计划
 *   ↓ 拒绝 = `CONFIRM_REQUIRED`（kind=confirmation）/ 回引不符 = `PLAN_STALE`（kind=conflict）
 *   ③ 真实字节摘要（**锁内**）  —— 事务件的 build 回调里：逐个目标读**当前真实字节**，
 *                                 与计划记的写前摘要比；再用同一份写前字节**重建**一遍计划内容，
 *                                 与计划记的输出摘要比。任一处不符 → `PLAN_STALE`（kind=conflict）
 *
 * 闸①②在前置：**一次都不调用事务件**（A02 用注入的计数探针证明调用次数为 0）。
 * 闸③只能在锁内做（事务件持锁后第二次调用 build 时才给真实写前字节），
 * 所以"计划生成后目标被改"只会在这里被拒，且**一个字节都没落位**（事务件的写入全在 build 返回之后）。
 *
 * ## 七态与既有资产
 *
 * `state` ∈ `building / prepared / committed / rejected / busy / rolled-back / recovery-required`
 * —— 与事务件的 `STATES` **同一套词**（A05 逐态断言，不另造）。
 * `committed / rejected / busy / rolled-back / recovery-required` 由事务件回执映射而来；
 * `building / prepared` 是事务进行中的 journal 状态（本件不改它们，只读）。
 * 待恢复（`recovery-required`）时**拒绝普通写入**：先用事务件自己的
 * `assertNoRecoveryRequired()` 在进入事务前挡一次，事务件拿锁后还会再挡一次（同一个守卫、同一份日志）。
 *
 * ## 失败结构
 *
 * `failure` 一律出自 `lib/unify/errors.cjs` 的 `makeFailure()`（U03 交付的唯一工厂）；
 * 事务件产出的失败面由它自己的 `failureFor()` 给（七态归它所有，state→kind 只有一份表）；
 * **码值**归本层 `STATE_CODES`（`LOCK_BUSY` / `RECOVERY_REQUIRED` 这类新码只许落在 `lib/unify/*`）。
 * 旧顶层字段 `error` / `code` 照旧给（兼容）；发布用的 `kind` 不在本件出现。
 *
 * ## 边界（别把本件说大了）
 *
 * · **多文件 rename 不对读者原子可见**：事务件的提交点是"全部落位之后才翻 committed"，
 *   崩溃恢复只有"原状态 / 完整已提交状态"两种合法终态 —— 这只保证**崩溃之后**没有半提交，
 *   不保证并发的读者在落位过程中看到的是一个整体快照。
 * · **显式迁移 / 升级 / 发布不代替用户确认**：那几件事的确认归各自的卡。
 *   本件的 `confirm` 表示"上层受信适配器已经确认了这次写入的意图"，不是让人多点一次的 UI；
 *   普通受信写入（例如登记一条记录）不加重复确认。
 *
 * ## 只依赖
 *
 * `node:path` / `node:fs` / `node:crypto` 三个内置 + 同目录 `./errors.cjs`
 * + 事务件（默认从 `../pack-template/tools/ledger-transaction.cjs` 取，可显式注入）。
 * 没有时钟、没有随机数、没有 `process.env`、没有网络 —— 计划与判据都可复算。
 */

const path = require('node:path')
const nodeFs = require('node:fs')
const crypto = require('node:crypto')
const { makeFailure, FAILURE_KINDS } = require('./errors.cjs')

/** 计划 schema（进 `plan.schema`；改形状必须换串） */
const COMMIT_SCHEMA = 'whale-commit/1'

/** 七态（与事务件的 `STATES` 同一套词；顺序即文档顺序） */
const COMMIT_STATES = Object.freeze([
	'building',
	'prepared',
	'committed',
	'rejected',
	'busy',
	'rolled-back',
	'recovery-required',
])

/** 三闸的固定顺序（判据按它断言"先哪一闸"） */
const COMMIT_GATES = Object.freeze(['plan', 'confirm', 'bytes'])

/** 闸码（全部是 U01 锁定的**既有**码值，不新增同义码） */
const GATE_CODES = Object.freeze({
	plan: 'PLAN_REQUIRED',
	confirm: 'CONFIRM_REQUIRED',
	bytes: 'PLAN_STALE',
})

/**
 * "回滚也失败、等离线恢复"那一态的字面量。单独成一个常量不散落：
 * 它是"必须如实上报、绝不许改口成成功"的那一档（卡面：恢复失败明确 recovery-required）。
 */
const RECOVERY_STATE = 'recovery-required'

/** 计划里 `files` 每条允许出现的键（多一个都算"计划被改过"） */
const FILE_KEYS = Object.freeze(['rel', 'remove', 'digest', 'bytes', 'beforeDigest'])

/**
 * 事务七态 → 统一码值。**码值归本层**（`lib/unify/*` 是 U03/U06 的码表落点），
 * 事务件只给 `kind` 与错误文本 —— 两张表各归各家，谁也不越权编造对方的词。
 * `LOCK_BUSY` / `RECOVERY_REQUIRED` 是 U-SPEC §3 的拟新增码（U03 已在 `errors.cjs` 落地）；
 * `IO_ERROR` / `PLAN_REQUIRED` 是既有码值（不改名）。
 */
const STATE_CODES = Object.freeze({
	busy: 'LOCK_BUSY',
	rejected: 'PLAN_REQUIRED',
	'rolled-back': 'IO_ERROR',
	'recovery-required': 'RECOVERY_REQUIRED',
})

/** 事务件不在时（注入替身）的最小 kind 回退表；真实事务件的 `failureFor()` 优先 */
const STATE_KINDS = Object.freeze({
	busy: 'conflict',
	rejected: 'input',
	'rolled-back': 'io',
	'recovery-required': 'recovery',
})

/** hex64（sha256 的文本形状） */
const HEX64 = /^[0-9a-f]{64}$/

/** build 只读视图里被钉死的**写能力**（调了就抛，不清空也不静默） */
const WRITE_APIS = Object.freeze([
	'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync',
	'mkdirSync', 'copyFileSync', 'cpSync', 'writeFile', 'appendFile', 'createWriteStream',
	'truncateSync', 'chmodSync', 'symlinkSync', 'writeSync',
])

/* ── 小工具（纯计算；无时钟/随机/环境） ───────────────────────────────── */

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 系统错误码原样带出（没有就用既有业务码，不编新码） */
function sysCode(e) {
	return e && e.code ? String(e.code) : 'IO_ERROR'
}

function errMessage(e) {
	return e && e.message ? String(e.message) : String(e)
}

/** 路径是不是落在 root 内（**按分量比**，不做字符串前缀） */
function insideRoot(root, abs) {
	const rel = path.relative(root, abs)
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 内容 → 字节（字符串 / Buffer / TypedArray 都收；别的一律 null） */
function bytesOf(content) {
	if (content === null || content === undefined) return null
	if (typeof content === 'string') return Buffer.from(content, 'utf8')
	if (Buffer.isBuffer(content)) return content
	if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength)
	return null
}

/** rel 是不是一个**包内相对路径**（不接受绝对路径 / 盘符 / 反斜杠 / 空段 / `..`） */
function relProblem(rel) {
	if (typeof rel !== 'string' || rel === '') return '必须是包内相对路径（实得空）'
	if (rel.includes('\\')) return '必须用 `/` 作分隔符（不接受反斜杠）'
	if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return '必须是**相对**路径（不接受绝对路径 / 盘符）'
	const parts = rel.split('/')
	if (parts.some((p) => p === '' || p === '.' || p === '..')) return '不许有空段 / `.` / `..`'
	return null
}

function fsOf(opts, where) {
	const io = opts && opts.fs ? opts.fs : nodeFs
	if (!io || typeof io !== 'object') throw new TypeError(`${where}：fs 注入必须是对象`)
	if (typeof io.readFileSync !== 'function' || typeof io.existsSync !== 'function') {
		throw new TypeError(`${where}：fs 注入至少要提供 readFileSync() 与 existsSync()`)
	}
	return io
}

/** build 的只读 fs 视图：读能力照搬，写能力一律抛（不是"看起来没写"，是"写不了"） */
function readOnlyFs(io) {
	const view = { ...io }
	for (const name of WRITE_APIS) {
		view[name] = () => {
			throw new Error(`build 不许写盘（${name}）：字节只在事务的暂存区重建，权威目标由事务件 rename 落位`)
		}
	}
	return view
}

/** build 返回值规格化（数组形状 / 对象形状；别的当场拒，不猜） */
function normalizeBuildOutput(out) {
	if (Array.isArray(out)) return { ok: true, operation: 'write', files: out, value: undefined }
	if (out && typeof out === 'object' && Array.isArray(out.files)) {
		return {
			ok: true,
			operation: out.operation,
			files: out.files,
			value: 'value' in out ? out.value : undefined,
		}
	}
	return { ok: false, error: 'build 必须返回 [{rel, content|remove}] 或 {operation?, value?, files:[...]}（收到的不是这个形状）' }
}

/**
 * 计划的**规范摘要**：只对身份字段做哈希（rel / remove / 输出摘要 / 字节数 / 写前摘要），
 * 不含时间戳、不含 private 正文。同一计划永远同一摘要。
 */
function planDigestOf(plan) {
	const rows = (Array.isArray(plan && plan.files) ? plan.files : []).map((f) => [
		String(f && f.rel),
		f && f.remove === true,
		f && f.digest === undefined ? null : f.digest,
		f && Number.isSafeInteger(f.bytes) ? f.bytes : null,
		f && f.beforeDigest === undefined ? null : f.beforeDigest,
	])
	return sha256(Buffer.from(JSON.stringify({
		schema: plan && plan.schema,
		root: plan && plan.root,
		operation: plan && plan.operation,
		files: rows,
	}), 'utf8'))
}

/* ── 闸一：计划/目标/操作是否**有效** ─────────────────────────────────── */

/**
 * @returns {{ok:true}|{ok:false, error:string}}
 */
function validatePlan(plan, rootAbs) {
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, error: '计划必须是对象（不是数组 / null）' }
	if (plan.schema !== COMMIT_SCHEMA) {
		return { ok: false, error: `计划 schema 必须是 ${COMMIT_SCHEMA}（实得 ${JSON.stringify(plan.schema)}）—— 不是本协议的计划的不能提交` }
	}
	if (typeof plan.root !== 'string' || path.resolve(plan.root) !== rootAbs) {
		return { ok: false, error: `计划的 root 与本次提交的课程包根不一致（计划 ${JSON.stringify(plan.root)} / 本次 ${rootAbs}）` }
	}
	if (typeof plan.operation !== 'string' || plan.operation.trim() === '') {
		return { ok: false, error: '计划必须有非空的 operation（"这是什么操作"不能靠猜）' }
	}
	if (/[\r\n]/.test(plan.operation) || plan.operation.length > 200) {
		return { ok: false, error: 'operation 必须是单行、≤200 字符' }
	}
	if (!Array.isArray(plan.files)) return { ok: false, error: '计划的 files 必须是数组' }

	let lastRel = null
	for (let i = 0; i < plan.files.length; i++) {
		const f = plan.files[i]
		const where = `计划的第 ${i + 1} 条`
		if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: `${where}不是对象` }
		for (const key of Object.keys(f)) {
			if (!FILE_KEYS.includes(key)) return { ok: false, error: `${where}出现计划里不该有的键 ${JSON.stringify(key)}（计划被改过？）` }
		}
		const bad = relProblem(f.rel)
		if (bad) return { ok: false, error: `${where}的 rel ${bad}：${JSON.stringify(f.rel)}` }
		const abs = path.resolve(rootAbs, f.rel)
		if (!insideRoot(rootAbs, abs)) return { ok: false, error: `${where}的落点跑出包根了：${f.rel}` }
		if (typeof f.remove !== 'boolean') return { ok: false, error: `${where}的 remove 必须是布尔（实得 ${JSON.stringify(f.remove)}）` }
		if (f.remove === true) {
			if (f.digest !== null) return { ok: false, error: `${where}是删除，digest 必须是 null` }
		} else {
			if (typeof f.digest !== 'string' || !HEX64.test(f.digest)) return { ok: false, error: `${where}的 digest 必须是 sha256 的 hex64` }
			if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) return { ok: false, error: `${where}的 bytes 必须是非负整数` }
		}
		if (f.beforeDigest !== null && (typeof f.beforeDigest !== 'string' || !HEX64.test(f.beforeDigest))) {
			return { ok: false, error: `${where}的 beforeDigest 必须是 null 或 sha256 的 hex64` }
		}
		if (lastRel !== null) {
			if (f.rel === lastRel) return { ok: false, error: `计划的 files 必须去重（${f.rel} 出现了两次）` }
			if (f.rel < lastRel) return { ok: false, error: `计划的 files 必须按 rel 升序排列（${lastRel} 之后出现了 ${f.rel}）` }
		}
		lastRel = f.rel
	}
	if (typeof plan.planDigest !== 'string' || !HEX64.test(plan.planDigest)) {
		return { ok: false, error: '计划的 planDigest 必须是 sha256 的 hex64' }
	}
	const want = planDigestOf(plan)
	if (want !== plan.planDigest) {
		return { ok: false, error: '计划自己的 planDigest 与内容不符 —— 计划被改过，或不是 planCommit 产出的' }
	}
	return { ok: true }
}

/* ── 失败回执（两种：前置拒绝 / 事务回执映射） ─────────────────────────── */

function refusal(state, failure, extra = {}) {
	const out = {
		ok: false,
		state,
		code: failure.code,
		error: failure.error,
		failure,
		rollbackError: extra.rollbackError === undefined ? null : extra.rollbackError,
		journal: extra.journal === undefined ? null : extra.journal,
		value: undefined,
	}
	if (extra.txnId !== undefined) out.txnId = extra.txnId
	return out
}

/**
 * 事务件七态 → 失败面。
 * **kind 优先问事务件自己**（它才是七态的拥有者，`failureFor()` 只有一份）；
 * **code 归本层**（`STATE_CODES`，`LOCK_BUSY` / `RECOVERY_REQUIRED` 这类新码只许落在 `lib/unify/*`）。
 */
function failureOfTransaction(txn, res, state) {
	const error = typeof res.error === 'string' && res.error ? res.error : `事务以 ${state} 结束`
	const code = STATE_CODES[state] || GATE_CODES.plan
	let picked = { kind: STATE_KINDS[state] || 'input', code, error }
	try {
		if (typeof txn.failureFor === 'function') {
			const raw = txn.failureFor(res)
			if (raw && typeof raw === 'object' && FAILURE_KINDS.includes(raw.kind)) {
				picked = {
					kind: raw.kind,
					code,
					error: typeof raw.error === 'string' && raw.error ? raw.error : error,
					errorCode: raw.errorCode,
				}
			}
		}
	} catch {
		// 注入的替身没有这条能力 / 形状不合法 → 走 STATE_KINDS 的最小回退（只对替身生效）
	}
	// 过一遍唯一工厂：形状（kind 域 / 非空 code / 非空 error）由 errors.cjs 校验
	return makeFailure(picked)
}

/** 事务件回执 → 本件回执（**不宣称已恢复、不把失败说成成功**） */
function mapTransactionResult(res, stale, txn) {
	if (stale) {
		// 闸三在锁内拒绝：事务件的回执是 "build 抛错 → rejected"，真正的原因在这里
		return refusal('rejected', stale)
	}
	if (!res || typeof res !== 'object') {
		return refusal('rejected', makeFailure({ kind: 'io', code: 'IO_ERROR', error: '事务件没有返回回执' }))
	}
	const state = COMMIT_STATES.includes(String(res.state)) ? String(res.state) : 'rejected'
	if (state === 'committed' && res.ok === true) {
		const out = {
			ok: true,
			state: 'committed',
			code: null,
			error: null,
			failure: null,
			rollbackError: null,
			journal: res.journal === undefined ? null : res.journal,
			value: res.value,
		}
		if (res.txnId !== undefined) out.txnId = res.txnId
		if (Array.isArray(res.files)) out.files = res.files
		if (res.cleanup) out.cleanup = res.cleanup
		return out
	}
	const failure = failureOfTransaction(txn, res, state)
	// 恢复失败 / 待恢复：**如实报 recovery-required**，材料（日志 + 锁）留在盘上。
	// 这一支不许被"拒绝、重试就好"顶替 —— 事务件的下一次普通写仍会被它自己拒绝。
	if (state === RECOVERY_STATE) return recoveryReceipt(res)
	return refusal(state, failure, {
		rollbackError: res.rollbackError === undefined ? null : res.rollbackError,
		journal: res.journal === undefined ? null : res.journal,
		txnId: res.txnId,
	})
}

/**
 * 恢复失败的回执：**明确 recovery-required + 保留材料路径 + 不宣称已恢复**。
 * @param {{error?:string, rollbackError?:string|null, journal?:string, txnId?:string}} res
 */
function recoveryReceipt(res) {
	return refusal('recovery-required', makeFailure({
		kind: 'recovery',
		code: STATE_CODES[RECOVERY_STATE],
		error: typeof res.error === 'string' && res.error
			? res.error
			: '上一次事务回滚失败：日志与锁都保留，离线恢复前不接受普通写入',
	}), {
		rollbackError: res.rollbackError === undefined ? null : res.rollbackError,
		journal: res.journal === undefined ? null : res.journal,
		txnId: res.txnId,
	})
}

/* ── 事务件（默认实现；可显式注入） ───────────────────────────────────── */

function defaultTransaction() {
	return require('../pack-template/tools/ledger-transaction.cjs')
}

function journalDirOf(txn, rootAbs) {
	try {
		if (typeof txn.txnPaths === 'function') return txn.txnPaths(rootAbs).dir
	} catch { /* 注入的替身没有 txnPaths → 走默认落点 */ }
	return path.join(rootAbs, '.whale-txn')
}

/** 磁盘上还留着哪些"待恢复"的日志（问事务件；它才是日志的拥有者） */
function recoveryResidue(txn, io, rootAbs) {
	try {
		if (typeof txn.pendingRecovery === 'function') {
			return (txn.pendingRecovery(io, rootAbs) || []).map((j) => String(j && j.id))
		}
	} catch { /* 读不动就当没有能力 */ }
	return []
}

/* ══════════════════════════════════════════════════════════════════════
 * planCommit —— 造计划（**零写**；build 拿的是只读 fs 视图）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} root 课程包根
 * @param {Function} build 同步纯计算（见文件头契约）
 * @param {{fs?:object}} [opts]
 * @returns {{ok:true, plan:object}|{ok:false, plan:null, code:string, error:string, failure:object}}
 */
function planCommit(root, build, opts = {}) {
	const io = fsOf(opts, 'planCommit')
	if (typeof build !== 'function') throw new TypeError('planCommit：build 必须是函数（计划只能由它算出，不能手填）')

	const rootText = String(root == null ? '' : root).trim()
	const bad = (kind, code, error, extra) => ({ ok: false, plan: null, code, error, failure: makeFailure({ kind, code, error, ...(extra || {}) }) })
	if (!rootText) return bad('input', GATE_CODES.plan, '没有课程包根目录')
	const rootAbs = path.resolve(rootText)

	let st = null
	try {
		st = io.statSync(rootAbs)
	} catch (e) {
		return bad('input', GATE_CODES.plan, `课程包根不可用（${sysCode(e)}）：${rootAbs}`, { file: rootAbs, errorCode: sysCode(e) })
	}
	if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
		return bad('input', GATE_CODES.plan, `课程包根不是目录：${rootAbs}`, { file: rootAbs })
	}

	const roFs = readOnlyFs(io)

	// ① 先要"写哪些落点"（写前字节由本件从磁盘读，不叫 build 猜）
	let declared = null
	try {
		declared = build({ root: rootAbs, fs: roFs, files: {}, plan: null })
	} catch (e) {
		return bad('input', GATE_CODES.plan, `build 抛错：${errMessage(e)}`)
	}
	if (declared && typeof declared.then === 'function') {
		return bad('input', GATE_CODES.plan, 'build 必须同步返回（本协议是同步的；异步写口要自己把结果先算好）')
	}
	const first = normalizeBuildOutput(declared)
	if (!first.ok) return bad('input', GATE_CODES.plan, first.error)

	const op = typeof first.operation === 'string' && first.operation.trim() ? first.operation : 'write'

	// ② 读每个落点的**当前真实字节**（读不到就拒，不拿"读不到"当"本来不存在"）
	const before = {}
	for (const f of first.files) {
		const rel = f && f.rel === undefined ? undefined : String(f.rel)
		const relBad = relProblem(rel)
		if (relBad) return bad('input', GATE_CODES.plan, `写计划的 rel ${relBad}：${JSON.stringify(f && f.rel)}`)
		const abs = path.resolve(rootAbs, rel)
		if (!insideRoot(rootAbs, abs)) return bad('input', GATE_CODES.plan, `写计划的落点跑出包根了：${rel}`)
		let buf = null
		try {
			buf = io.existsSync(abs) ? io.readFileSync(abs) : null
		} catch (e) {
			return bad('io', 'IO_ERROR', `读不到 ${rel} 的当前字节（${sysCode(e)}）—— 拒绝在"读不到"的基础上造计划`, { file: rel, errorCode: sysCode(e) })
		}
		before[rel] = buf
	}

	// ③ 带真实写前字节再算一遍（这才是"将要写出的字节"）
	const beforeUtf8 = {}
	for (const rel of Object.keys(before)) beforeUtf8[rel] = before[rel] === null ? null : Buffer.from(before[rel]).toString('utf8')
	let finalOut = null
	try {
		finalOut = build({ root: rootAbs, fs: roFs, files: beforeUtf8, plan: null })
	} catch (e) {
		return bad('input', GATE_CODES.plan, `build 抛错：${errMessage(e)}`)
	}
	if (finalOut && typeof finalOut.then === 'function') {
		return bad('input', GATE_CODES.plan, 'build 必须同步返回（本协议是同步的）')
	}
	const second = normalizeBuildOutput(finalOut)
	if (!second.ok) return bad('input', GATE_CODES.plan, second.error)

	// ④ 两次给出的文件集必须一致（不确定的 build 不能出计划）
	const relsOf = (files) => [...new Set(files.map((f) => String(f && f.rel)))].sort()
	const relsA = relsOf(first.files)
	const relsB = relsOf(second.files)
	if (relsA.join('\n') !== relsB.join('\n')) {
		return bad('input', GATE_CODES.plan, 'build 两次给出的文件集不一致（不确定的 build 不能生成计划）')
	}

	// ⑤ files **排序去重**（同 rel 只留最后一条），只记内容摘要（不落正文）
	const byRel = new Map()
	for (const f of second.files) byRel.set(String(f && f.rel), f)
	const files = []
	for (const rel of [...byRel.keys()].sort()) {
		const f = byRel.get(rel)
		const remove = f.remove === true
		const content = remove ? null : bytesOf(f.content)
		if (!remove && content === null) {
			return bad('input', GATE_CODES.plan, `写计划 ${rel} 的 content 必须是字符串 / Buffer（实得 ${typeof f.content}）`)
		}
		const b = before[rel]
		files.push({
			rel,
			remove,
			digest: content === null ? null : sha256(content),
			bytes: content === null ? 0 : content.length,
			beforeDigest: b === null || b === undefined ? null : sha256(b),
		})
	}

	const plan = {
		schema: COMMIT_SCHEMA,
		root: rootAbs,
		operation: op,
		files,
		planDigest: '',
	}
	plan.planDigest = planDigestOf(plan)
	return { ok: true, plan }
}

/* ══════════════════════════════════════════════════════════════════════
 * applyCommit —— 三闸 + 提交（闸①②前置零调用；闸③锁内）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} root 课程包根
 * @param {object} plan `planCommit` 给出的计划
 * @param {{confirm?:boolean, planDigest?:string, build:Function, transaction?:object,
 *          fs?:object, ownerToken?:string, timeoutMs?:number}} opts
 * @returns {{ok:boolean, state:string, code?:string|null, error?:string|null, failure?:object|null,
 *            rollbackError?:string|null, journal?:string|null, value?:any}}
 */
function applyCommit(root, plan, opts = {}) {
	const io = fsOf(opts, 'applyCommit')
	const rootText = String(root == null ? '' : root).trim()
	const rootAbs = rootText ? path.resolve(rootText) : ''

	if (typeof opts.build !== 'function') throw new TypeError('applyCommit：build 必须是函数（字节在锁内暂存重建，不接受直接给 content）')
	const txn = opts.transaction === undefined || opts.transaction === null ? defaultTransaction() : opts.transaction
	if (!txn || typeof txn.withPackTransaction !== 'function') {
		throw new TypeError('applyCommit：transaction 必须提供 withPackTransaction()（复用既有包锁与 whale-txn/1 日志）')
	}

	/* ── 闸一：有效计划 / 目标 / 操作 ─────────────────────────────────── */
	if (!rootAbs) return refusal('rejected', makeFailure({ kind: 'input', code: GATE_CODES.plan, error: '没有课程包根目录' }))
	const planCheck = validatePlan(plan, rootAbs)
	if (!planCheck.ok) return refusal('rejected', makeFailure({ kind: 'input', code: GATE_CODES.plan, error: planCheck.error }))

	/* ── 闸二：显式确认（含"你确认的就是这份计划"） ───────────────────── */
	if (opts.confirm !== true) {
		return refusal('rejected', makeFailure({
			kind: 'confirmation',
			code: GATE_CODES.confirm,
			error: '提交会改写课程包文件：必须显式给 confirm:true（普通受信写入由上层适配器确认意图，这里不再弹一次 UI）',
		}))
	}
	if (opts.planDigest !== plan.planDigest) {
		return refusal('rejected', makeFailure({
			kind: 'conflict',
			code: GATE_CODES.bytes,
			error: `调用方给的 planDigest 与这份计划不符（给 ${JSON.stringify(opts.planDigest)} / 计划 ${plan.planDigest}）—— 你确认的不是这份计划`,
		}))
	}

	/* ── 待恢复阻断：用事务件自己的守卫（不另造一套判定） ─────────────── */
	if (typeof txn.assertNoRecoveryRequired === 'function') {
		let pre = null
		try {
			pre = txn.assertNoRecoveryRequired(io, rootAbs)
		} catch { pre = null }
		if (pre && pre.ok === false) {
			return refusal('recovery-required', makeFailure({
				kind: 'recovery',
				code: 'RECOVERY_REQUIRED',
				error: pre.error || '上一次事务回滚失败、日志还留着：拒绝这次普通写（先跑离线恢复）',
			}), { journal: journalDirOf(txn, rootAbs) })
		}
	}

	/* ── 闸三（锁内）+ 提交：全部交给事务件，本件只做复核与映射 ───────── */
	let stale = null
	let buildCalls = 0
	const recordGateFailure = (failure) => {
		stale = stale || failure
		const e = new Error(failure.error)
		e.__commitFailure = failure
		return e
	}

	let res = null
	try {
		res = txn.withPackTransaction(rootAbs, (ctx) => {
			buildCalls += 1
			// 第一次调用：事务件问"写哪些落点"（它按这个读**写前字节**）
			if (buildCalls === 1) {
				return {
					files: plan.files.map((f) => (f.remove ? { rel: f.rel, remove: true } : { rel: f.rel, content: '' })),
					value: undefined,
				}
			}

			// —— 闸三，锁内：当前输入/目标的**真实字节摘要** + 重建后的输出摘要 ——
			const current = {}
			for (const f of plan.files) {
				const abs = path.resolve(rootAbs, f.rel)
				let buf = null
				try {
					buf = io.existsSync(abs) ? io.readFileSync(abs) : null
				} catch (e) {
					throw recordGateFailure(makeFailure({
						kind: 'io', code: 'IO_ERROR', file: f.rel, errorCode: sysCode(e),
						error: `锁内读不到 ${f.rel} 的当前字节（${sysCode(e)}）`,
					}))
				}
				const digest = buf === null ? null : sha256(buf)
				if (digest !== f.beforeDigest) {
					throw recordGateFailure(makeFailure({
						kind: 'conflict', code: GATE_CODES.bytes, file: f.rel,
						error: `${f.rel} 的当前字节与计划不符（写前摘要变了）：目标在计划生成后被改过，旧计划不许覆盖它`,
					}))
				}
				current[f.rel] = buf
			}

			const preUtf8 = {}
			for (const rel of Object.keys(current)) preUtf8[rel] = current[rel] === null ? null : Buffer.from(current[rel]).toString('utf8')

			let out = null
			try {
				out = opts.build({ root: rootAbs, fs: readOnlyFs(io), files: preUtf8, plan })
			} catch (e) {
				if (e && e.__commitFailure) throw e
				throw recordGateFailure(makeFailure({ kind: 'input', code: GATE_CODES.plan, error: `build 抛错：${errMessage(e)}` }))
			}
			if (out && typeof out.then === 'function') {
				throw recordGateFailure(makeFailure({ kind: 'input', code: GATE_CODES.plan, error: 'build 必须同步返回（本协议是同步的）' }))
			}
			const norm = normalizeBuildOutput(out)
			if (!norm.ok) throw recordGateFailure(makeFailure({ kind: 'input', code: GATE_CODES.plan, error: norm.error }))

			const byRel = new Map()
			for (const f of norm.files) byRel.set(String(f && f.rel), f)
			if (byRel.size !== plan.files.length) {
				throw recordGateFailure(makeFailure({
					kind: 'conflict', code: GATE_CODES.bytes,
					error: `锁内重建给出的文件集与计划不一致（计划 ${plan.files.length} 个 / 重建 ${byRel.size} 个）`,
				}))
			}
			const rebuilt = []
			for (const f of plan.files) {
				const got = byRel.get(f.rel)
				if (!got) {
					throw recordGateFailure(makeFailure({ kind: 'conflict', code: GATE_CODES.bytes, file: f.rel, error: `锁内重建的计划缺 ${f.rel}` }))
				}
				const remove = got.remove === true
				const content = remove ? null : bytesOf(got.content)
				if (!remove && content === null) {
					throw recordGateFailure(makeFailure({
						kind: 'input', code: GATE_CODES.plan, file: f.rel,
						error: `锁内重建：${f.rel} 的 content 必须是字符串 / Buffer（实得 ${typeof got.content}）`,
					}))
				}
				const digest = content === null ? null : sha256(content)
				if (remove !== f.remove || digest !== f.digest) {
					throw recordGateFailure(makeFailure({
						kind: 'conflict', code: GATE_CODES.bytes, file: f.rel,
						error: `锁内重建的 ${f.rel} 与计划不一致（输入 / 策略在计划之后被改过）`,
					}))
				}
				rebuilt.push(remove ? { rel: f.rel, remove: true } : { rel: f.rel, content })
			}
			return {
				files: rebuilt,
				value: out && !Array.isArray(out) && 'value' in out ? out.value : undefined,
			}
		}, txnOptions(opts, io))
	} catch (e) {
		// 事务实现**自己抛错**：不宣称成功；磁盘上留着可恢复材料就报 recovery-required
		const residue = recoveryResidue(txn, io, rootAbs)
		const journal = journalDirOf(txn, rootAbs)
		const msg = `事务实现抛错（${sysCode(e)}）：${errMessage(e)}`
		if (stale) return refusal('rejected', stale, { rollbackError: null, journal: null })
		if (residue.length) {
			return refusal('recovery-required', makeFailure({
				kind: 'recovery',
				code: 'RECOVERY_REQUIRED',
				file: journal,
				errorCode: sysCode(e),
				error: `${msg}；磁盘上还留着待恢复材料（${residue.join('、')}），离线恢复前不接受普通写入`,
			}), { rollbackError: msg, journal })
		}
		return refusal('rejected', makeFailure({ kind: 'io', code: 'IO_ERROR', error: msg, errorCode: sysCode(e) }))
	}

	return mapTransactionResult(res, stale, txn)
}

/** 留给事务件的选项（只透传既有名字，不加新语义） */
function txnOptions(opts, io) {
	const out = { fs: io }
	if (opts.ownerToken !== undefined) out.ownerToken = opts.ownerToken
	if (opts.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs
	return out
}

module.exports = {
	COMMIT_SCHEMA,
	COMMIT_STATES,
	COMMIT_GATES,
	GATE_CODES,
	STATE_CODES,
	STATE_KINDS,
	FILE_KEYS,
	RECOVERY_STATE,
	planDigestOf,
	planCommit,
	applyCommit,
}
