'use strict'
/**
 * lib/unify/stage.cjs —— 学情三类台账的**共同读取与提交基础**（U10 新建）
 * ==================================================================
 * 它只做三件事，其余一律留给领域适配层（`lib/intake.js` / `lib/goal-io.js` /
 * `lib/teaching-io.js`），因为那三个文件的**导出面、参数、默认值与返回形状逐字不变**：
 *
 *   ① **五态读取**：读台账只有一条路 —— U03 的 `readLedger()`。
 *      `missing / empty / ok / invalid / io-error` 五态原样上抛，`invalid` 与 `io-error`
 *      **不许折成"空态"**（A07 的变异落点就是这一行 `statusOf()`）。
 *      `null` / 数组 / 字符串 / 数字这些"不是记录"的行**不进 entries**（U03 已经这么判），
 *      所以它们永远进不了有效 latest —— 这是 A02 的机器面。
 *
 *   ② **共同提交边界**：写入与**版本分配**都走 U06 的 `planCommit()` / `applyCommit()`
 *      （三闸：有效计划 → 显式确认 → 锁内真实字节摘要；事务仍是既有包锁 + whale-txn/1）。
 *      版本（`v` / `replaces`）只能从**这一次提交边界内读到的字节**算出来：
 *        · 计划阶段算一遍（写前快照）；
 *        · 锁内再算一遍并要求与计划逐字节一致（`applyCommit` 的第三闸）。
 *      计划生成后目标被改 → `PLAN_STALE` 拒绝，**一个字节都不覆盖**；调用方按
 *      `RETRY_CODES` 决定"重读重算再提交"（`appendRecord` 内建有限次重试），
 *      所以并发写不会撞版本、也不会丢更新。
 *      **坏账本上不分配版本**：`assertWritableLedger()` 在 build 里（= 也在锁内）再核一次
 *      五态，`invalid` / `io-error` 一律拒写。
 *
 *   ③ **知识点归并走完整身份**：归并的键只能是 `circle/point` —— 构造走
 *      `identity.pointKey()`、解析走 `identity.parsePointKey()`，**本文件不拼裸字符串**。
 *      历史裸点（只有一段）在"核验不出归属"时**原样当键**（这是既有契约的兼容面，
 *      不是身份别名：`mergeCanonical()` 把这类键登记进 `unverified`）。
 *      严格面（`classifyPoint()` / `verifyIdentities()` / `strictIdentity:true`）**拒绝**：
 *        · 旧形状裸点 → `MIGRATION_REQUIRED`（修法是 U05 的显式迁移，不是猜圆圈）；
 *        · 跨圈同名裸点 → `ID_AMBIGUOUS`（附候选；不猜、不按第一个）；
 *        · 其它非法形状 → `LEDGER_INVALID`。
 *      这三个码都是 U-SPEC §3 的拟新增码，**唯一定义处**是 U03 的 `errors.cjs`（`NEW_CODES`）；
 *      本文件只从那里取（`STAGE_CODES` 的键与值都来自 `NEW_CODES`），**不抄字面量**。
 *
 * ## 纪律（写进实现，不只写在注释里）
 *
 * · **纯 CJS**，只依赖内置 `node:path` / `node:fs` + 同目录 `identity` / `errors` /
 *   `ledger-read` / `commit`；**不 require 迁移模块**（历史解码只归 `migration.cjs`，
 *   运行态不做隐式双读）；
 * · **零时钟**：不读 `Date`、不写时间戳字段（目标台账"绝不写时间字段"是 goal-io 的硬纪律）；
 * · **零随机**：重试不靠随机退避（同步、可复算）；
 * · **不改教学规则**：本文件不认识"档位/取值域/教学纪律"，那些仍在 `teaching-io.js`；
 * · **不碰别的台账**：只读写调用方点名的 `rel`（版本线在内存里算）。
 *
 * ## 变异落点（A07 就在这两处）
 *
 * · `statusOf()` —— 把它改成"读取故障折成 empty"⇒ 五态判据必须红；
 * · `mergeCanonical()` —— 把它改成"按裸点归并"⇒ 跨圈隔离判据必须红。
 */

const path = require('node:path')
const nodeFs = require('node:fs')

const identity = require('./identity.cjs')
const { makeFailure, NEW_CODES } = require('./errors.cjs')
const { readLedger } = require('./ledger-read.cjs')
const { planCommit, applyCommit } = require('./commit.cjs')

/** 三个台账的**唯一登记处**：相对路径、格式、身份槽、版本线种类 */
const STAGE_LEDGERS = Object.freeze({
	intake: Object.freeze({
		kind: 'intake',
		rel: 'learning-records/intake.jsonl',
		format: 'jsonl',
		identityField: 'point',
		versioned: false,
		versionGroup: null,
	}),
	goals: Object.freeze({
		kind: 'goals',
		rel: 'learning-records/goals.jsonl',
		format: 'jsonl',
		identityField: 'point',
		versioned: true,
		versionGroup: 'point',
	}),
	teaching: Object.freeze({
		kind: 'teaching',
		rel: 'learning-records/teaching.jsonl',
		format: 'jsonl',
		identityField: 'circle',
		versioned: true,
		versionGroup: 'circle+kind',
	}),
})

/**
 * 读取故障的状态字面量。
 * ⚠️ **A07 的变异落点之一**：把 `statusOf()` 改成"读取故障折成 empty"，五态判据必须红。
 */
const IO_ERROR_STATUS = 'io-error'

/** 阻断写入的两态（读过了但不许在其上追加 / 算版本） */
const BLOCKING_STATUSES = Object.freeze(['invalid', IO_ERROR_STATUS])

/** 可重试的提交码：计划过期（目标被改）/ 锁忙 —— 都不是"输入非法" */
const RETRY_CODES = Object.freeze({ PLAN_STALE: true, LOCK_BUSY: true })

/**
 * 严格身份面的三个码（全部是 U-SPEC §3 的拟新增码）。
 * U-SPEC §3：拟新增码**只许在 `lib/unify/errors.cjs` 定义一份**。所以这里**不抄字面量**：
 * 键与值都从 U03 的 `NEW_CODES`（唯一码表）取 —— 本文件只是消费方的一张只读别名视图，
 * 码值任何改动只可能发生在 errors.cjs 一处（在别处重写一份字面量 = 漂移源，U03 A04 会红）。
 * `IO_ERROR` 是**既有旧码**（不在 NEW_CODES 里），保持字面量不变。
 */
const STAGE_CODES = Object.freeze({
	[NEW_CODES.MIGRATION_REQUIRED]: NEW_CODES.MIGRATION_REQUIRED,
	[NEW_CODES.ID_AMBIGUOUS]: NEW_CODES.ID_AMBIGUOUS,
	[NEW_CODES.LEDGER_INVALID]: NEW_CODES.LEDGER_INVALID,
	IO_ERROR: 'IO_ERROR',
})

/** 默认重试次数（每次重试都**重读字节重算版本**；同步、无退避） */
const DEFAULT_RETRIES = 8

/* ── 小工具（纯函数 / 无时钟 / 无随机） ────────────────────────────────── */

function isPlainRecord(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function msgOf(e) {
	return e && e.message ? String(e.message) : String(e)
}

function sysCode(e) {
	return e && e.code ? String(e.code) : STAGE_CODES.IO_ERROR
}

/** 带码的输入错误（供 adapter 的 build 抛出；planCommit 会把它变成"写计划失败"） */
function stageError(code, message, extra) {
	const text = String(message)
	const e = new Error(text)
	e.code = code
	e.failure = makeFailure({ kind: 'input', code, error: text, ...(extra || {}) })
	e.__stageRefusal = true
	return e
}

function failureOf(code, error, extra) {
	return makeFailure({ kind: (extra && extra.kind) || 'input', code, error, ...(extra || {}) })
}

/** 一个 kind 的登记（不认识就明确拒，不猜） */
function ledgerOf(kind) {
	const spec = STAGE_LEDGERS[String(kind == null ? '' : kind)]
	if (!spec) {
		throw new TypeError(`stage：不认识的台账种类 ${JSON.stringify(kind)}（只认 ${Object.keys(STAGE_LEDGERS).join(' / ')}）`)
	}
	return spec
}

/** 台账绝对路径（三类共用一条规则：包根 + 登记里的相对路径） */
function ledgerFile(kind, root) {
	const spec = ledgerOf(kind)
	return path.join(path.resolve(String(root == null ? '' : root)), ...spec.rel.split('/'))
}

/** fs 注入的最小校验（与 U06 同一口径：读 + 存在性） */
function fsOf(opts, where) {
	const io = opts && opts.fs ? opts.fs : nodeFs
	if (!io || typeof io !== 'object') throw new TypeError(`${where}：fs 注入必须是对象`)
	if (typeof io.readFileSync !== 'function') throw new TypeError(`${where}：fs 注入至少要提供 readFileSync()`)
	return io
}

/* ── ① 五态读取 ───────────────────────────────────────────────────────── */

/**
 * ⚠️ **A07 变异落点（其一）**：读取故障必须原样是 `io-error`。
 * 折成 `empty`/`missing` 就等于"把读不动伪装成从来没写过台账"，五态判据当场红。
 */
function statusOf(result) {
	return result && result.status === IO_ERROR_STATUS ? IO_ERROR_STATUS : (result ? result.status : 'missing')
}

/**
 * 用**给定文本**走同一套五态读取（不是另一份解析器）：
 * 把 `readLedger` 的 `fs` 换成一个只吐出这段文本的**只读替身**，所以状态/entries/problems
 * 全部由 U03 那一份实现判。锁内复核用的就是它（字节来自 `applyCommit` 的 build 上下文）。
 *
 * @param {string} file 台账路径（只用于报错与 failure.file，不读盘）
 * @param {string} text 台账文本
 * @param {{format?:'jsonl'|'json', validate?:Function}} [opts]
 */
function readLedgerText(file, text, opts = {}) {
	const format = opts.format || 'jsonl'
	const shim = { readFileSync: () => String(text == null ? '' : text) }
	return readLedger(file, { format, validate: opts.validate, fs: shim })
}

/**
 * 读一本台账（五态 + 原文捕获）。
 *
 * @param {string} kind intake / goals / teaching
 * @param {string} root 课程包根
 * @param {{fs?:object, validate?:Function, capture?:boolean}} [opts]
 *   `validate` = 领域记录校验（返回规范记录或抛错）—— 交给 U03；
 *   `capture` = 把**读到的那份文本**一并带出（适配层要在同一份字节上做领域归并，
 *   而不是再读一遍盘 —— 两次读之间台账可能被改）。
 * @returns {{kind:string, file:string, rel:string, spec:object, exists:boolean, status:string,
 *   entries:object[], problems:string[], errorCode?:string, failure?:object,
 *   blocked:boolean, text:string|null}}
 */
function readStageLedger(kind, root, opts = {}) {
	const spec = ledgerOf(kind)
	const file = path.join(path.resolve(String(root == null ? '' : root)), ...spec.rel.split('/'))
	const io = opts && opts.fs ? opts.fs : nodeFs
	const capture = opts.capture === true
	let captured = null
	const readFs = capture && typeof io.readFileSync === 'function'
		? {
			...io,
			readFileSync: (p, enc) => {
				const got = io.readFileSync(p, enc)
				// 与 U03 同口径：BOM 不算坏行（读侧一致；写侧仍按磁盘原字节追加，不动 BOM）
				captured = (Buffer.isBuffer(got) ? got.toString('utf8') : String(got)).replace(/^\uFEFF/, '')
				return got
			},
		}
		: io
	let res
	try {
		res = readLedger(file, { format: spec.format, validate: opts.validate, fs: readFs })
	} catch (e) {
		// readLedger 只在**参数非法**时抛（format 缺失 / fs 缺能力）—— 那是本层的调用错误，不吞
		throw e
	}
	const status = statusOf(res)
	const out = {
		kind: spec.kind,
		file: res.file,
		rel: spec.rel,
		spec,
		exists: res.exists === true,
		status,
		entries: res.entries || [],
		problems: res.problems || [],
		blocked: BLOCKING_STATUSES.includes(status),
		text: capture ? captured : null,
	}
	if (res.errorCode !== undefined) out.errorCode = res.errorCode
	if (res.failure !== undefined) out.failure = res.failure
	return out
}

/**
 * 台账**文本**（改前/锁内）→ 阻断式复核：`invalid` / `io-error` 一律拒（不分配版本、不追加）。
 * @returns {{status:string, entries:object[], problems:string[]}}
 * @throws {Error} 带 `.code` / `.failure` 的 stageError
 */
function assertWritableLedger(beforeText, { file, format = 'jsonl', validate } = {}) {
	const res = readLedgerText(file, beforeText, { format, validate })
	const status = statusOf(res)
	if (BLOCKING_STATUSES.includes(status)) {
		const code = status === 'invalid' ? STAGE_CODES.LEDGER_INVALID : STAGE_CODES.IO_ERROR
		throw stageError(code, `台账不可信（${status}）：${(res.problems || [])[0] || '未给原因'}`
			+ ' —— 不在坏账本上分配版本、不追加记录（先用显式迁移/修复把台账弄干净）', { file })
	}
	return { status, entries: res.entries || [], problems: res.problems || [] }
}

/** 一行行拆（保留行号；空行既不是记录也不是问题）。record 只对"解析成功"的行给值 */
function parseJsonlRows(text) {
	const out = []
	const lines = String(text == null ? '' : text).split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]
		if (!raw.trim()) continue
		try {
			out.push({ line: i + 1, raw, record: JSON.parse(raw), parsed: true })
		} catch (e) {
			out.push({ line: i + 1, raw, record: undefined, parsed: false, error: msgOf(e) })
		}
	}
	return out
}

/* ── ② 领域归并（三类共用；键只能是规范身份） ─────────────────────────── */

/**
 * 按**原始身份槽**给最后一条（`latest` 的既有形状：老调用方读的就是它，一个字都不许改）。
 * `null` / 非对象行**不会**进来（`isPlainRecord` 先挡）。
 */
function latestByRaw(records, field = 'point') {
	const out = {}
	for (const r of Array.isArray(records) ? records : []) {
		if (!isPlainRecord(r)) continue
		const v = r[field]
		if (!v) continue
		out[typeof v === 'string' ? v : String(v)] = r
	}
	return out
}

/**
 * 按**规范身份**归并：`circle/point`。
 *
 * ⚠️ **A07 变异落点（其二）**：把键改成"裸点名"（`raw.split('/').pop()`）⇒ 跨圈同名点会串，
 * 跨圈隔离判据必须红。本函数**不拼裸字符串**：规范键一律 `identity.pointKey(circle,point)` 构造。
 *
 * @param {object[]} records
 * @param {{field?:string, resolveIdentity?:(record:object)=>({circle:string,point:string}|null)}} [opts]
 *   `resolveIdentity` = 领域解析器（intake 用 `resolvePointRef(pack, ref)` 的核验结果）。
 *   给不出规范身份时：记录里的值**本身**若已是 `circle/point` 就用它（经 `parsePointKey` 校验），
 *   否则**原样当键**并登记进 `unverified` —— 这是"没有目录可对照、绝不猜归属"的兼容面。
 * @returns {{byKey:Record<string,object>, unverified:string[], keys:string[]}}
 */
function mergeCanonical(records, opts = {}) {
	const field = opts.field || 'point'
	const resolveIdentity = typeof opts.resolveIdentity === 'function' ? opts.resolveIdentity : null
	const byKey = {}
	const unverified = []
	const order = []
	for (const rec of Array.isArray(records) ? records : []) {
		if (!isPlainRecord(rec)) continue
		const rawValue = rec[field]
		if (!rawValue) continue
		// 既有契约里非字符串的身份槽也会被 `String(...)` 当键（老台账的真实形状），这里照旧兼容
		const raw = typeof rawValue === 'string' ? rawValue : String(rawValue)
		let key = null
		if (resolveIdentity) {
			let id = null
			try { id = resolveIdentity(rec) } catch { id = null }
			if (id && typeof id.circle === 'string' && id.circle && typeof id.point === 'string' && id.point) {
				try { key = identity.pointKey(id.circle, id.point) } catch { key = null }
			}
		}
		if (key === null) {
			const parsed = identity.parsePointKey(raw)
			if (parsed.ok) key = identity.pointKey(parsed.value.circle, parsed.value.point)
			else {
				key = raw
				if (!unverified.includes(raw)) unverified.push(raw)
			}
		}
		if (!Object.prototype.hasOwnProperty.call(byKey, key)) order.push(key)
		byKey[key] = rec
	}
	return { byKey, unverified, keys: order }
}

/**
 * 版本线：按 `keyOf` 分组，返回每组的最大 `v` 与最后一条。
 * goals 的组 = `point`（一条点键一条版本线）；teaching 的组 = `circle` + `kind`。
 *
 * @param {object[]} entries
 * @param {{keyOf:(e:object)=>string|null}} opts
 * @returns {Map<string,{entries:object[], maxV:number, last:object|null}>}
 */
function versionLines(entries, opts = {}) {
	const keyOf = opts.keyOf
	if (typeof keyOf !== 'function') throw new TypeError('versionLines：keyOf 必须是函数')
	const out = new Map()
	for (const e of Array.isArray(entries) ? entries : []) {
		if (!isPlainRecord(e)) continue
		let key = null
		try { key = keyOf(e) } catch { key = null }
		if (key === null || key === undefined) continue
		const id = String(key)
		const line = out.get(id) || { entries: [], maxV: 0, last: null }
		line.entries.push(e)
		if (Number.isSafeInteger(e.v) && e.v >= 1 && e.v > line.maxV) line.maxV = e.v
		line.last = e
		out.set(id, line)
	}
	return out
}

/* ── ③ 严格身份面（拒绝旧形状 / 歧义；修法是 U05 的显式迁移） ──────────── */

/**
 * 课程包的知识点目录（给裸点判歧义用）。接受 `readPack().points`（`{circle,id}`）
 * 或任何 `{circle,point}` / `{circle,id}` / 裸 `"circle/point"` 数组。
 * @returns {{keys:string[], byPoint:Map<string,string[]>, has:(key:string)=>boolean}}
 */
function buildCatalogue(points) {
	const byPoint = new Map()
	const keys = []
	for (const p of Array.isArray(points) ? points : []) {
		let circle = null
		let point = null
		if (typeof p === 'string') {
			const parsed = identity.parsePointKey(p)
			if (!parsed.ok) continue
			circle = parsed.value.circle
			point = parsed.value.point
		} else if (isPlainRecord(p)) {
			circle = typeof p.circle === 'string' ? p.circle : null
			point = typeof p.point === 'string' ? p.point : (typeof p.id === 'string' ? p.id : null)
		}
		if (!circle || !point) continue
		let key
		try { key = identity.pointKey(circle, point) } catch { continue }
		if (!keys.includes(key)) keys.push(key)
		const list = byPoint.get(point) || []
		if (!list.includes(circle)) list.push(circle)
		byPoint.set(point, list)
	}
	keys.sort()
	for (const [name, list] of byPoint) byPoint.set(name, list.slice().sort())
	return { keys, byPoint, has: (key) => keys.includes(key) }
}

function pointFailure(code, reason, error, extra) {
	return {
		ok: false,
		code,
		reason,
		candidates: (extra && extra.candidates) || [],
		error,
		failure: failureOf(code, error, extra),
	}
}

/**
 * 严格分类一个知识点引用。
 *
 * @param {string} ref 只认 `circle/point`
 * @param {{catalogue?:object|null, halo?:string|null}} [opts]
 * @returns {{ok:true, key:string, circle:string, point:string, kind:'canonical'} | {ok:false, code:string, reason:string, candidates:string[], error:string, failure:object}}
 */
function classifyPoint(ref, opts = {}) {
	const catalogue = opts.catalogue || null
	const halo = typeof opts.halo === 'string' && opts.halo.trim() ? opts.halo.trim() : null
	if (typeof ref !== 'string') {
		return pointFailure(STAGE_CODES.LEDGER_INVALID, 'not-string', `知识点身份必须是字符串（实得 ${ref === null ? 'null' : typeof ref}）`)
	}
	if (ref === '' || ref.trim() === '') {
		return pointFailure(STAGE_CODES.LEDGER_INVALID, 'empty', '知识点身份不能是空的（运行态只认 circle/point）')
	}
	if (ref !== ref.trim()) {
		return pointFailure(STAGE_CODES.LEDGER_INVALID, 'untrimmed', `知识点身份两侧不能带空白（${JSON.stringify(ref)}）`)
	}
	const parsed = identity.parsePointKey(ref)
	if (parsed.ok) {
		const { circle, point } = parsed.value
		return { ok: true, key: identity.pointKey(circle, point), circle, point, kind: 'canonical' }
	}
	const segments = ref.split('/')
	if (segments.length === 1) {
		// 旧形状：裸点。**不猜圆圈** —— 唯一修法是 U05 的显式迁移（把它写成 circle/point）。
		const cands = catalogue ? (catalogue.byPoint.get(ref) || []) : []
		if (halo) {
			if (cands.includes(halo)) {
				return { ok: true, key: identity.pointKey(halo, ref), circle: halo, point: ref, kind: 'canonical' }
			}
			return pointFailure(STAGE_CODES.MIGRATION_REQUIRED, 'bare-point', `裸知识点 ${JSON.stringify(ref)} 不属于圆圈 ${JSON.stringify(halo)}`
				+ `（候选：${cands.map((c) => `${c}/${ref}`).join(' / ') || '无'}）—— 旧形状要么给对的圆圈，要么先做显式迁移`, { candidates: cands.map((c) => `${c}/${ref}`) })
		}
		if (cands.length > 1) {
			const candidates = cands.map((c) => `${c}/${ref}`)
			return pointFailure(STAGE_CODES.ID_AMBIGUOUS, 'ambiguous-point',
				`裸知识点 ${JSON.stringify(ref)} 在 ${cands.length} 个圆圈里都有（${candidates.join(' / ')}）`
				+ ' —— 不猜；要么写完整身份，要么显式迁移', { candidates })
		}
		return pointFailure(STAGE_CODES.MIGRATION_REQUIRED, 'bare-point',
			`旧形状裸知识点 ${JSON.stringify(ref)}（运行态只认 circle/point）`
			+ ` —— 用 tools/migrate-pack.mjs 显式迁移，不在运行态猜圆圈`
			+ (cands.length === 1 ? `（目录里它在 ${cands[0]}/${ref}）` : ''),
			{ candidates: cands.map((c) => `${c}/${ref}`) })
	}
	return pointFailure(STAGE_CODES.LEDGER_INVALID, 'unparsable-point',
		`知识点身份不合法：${parsed.failure ? parsed.failure.error : '形状不认识'}（${JSON.stringify(ref)}）`)
}

/**
 * 逐条核验记录的身份槽（**严格面**：只认 canonical）。
 *
 * @param {object[]} records 已经确认是 plain object 的记录
 * @param {{field?:string, catalogue?:object|null, halo?:string|null}} [opts]
 * @returns {{ok:boolean, status:'ok'|'migration-required'|'ambiguous'|'invalid',
 *   accepted:Array<{index:number,key:string,record:object}>, rejected:object[], keys:string[]}}
 */
function verifyIdentities(records, opts = {}) {
	const field = opts.field || 'point'
	const accepted = []
	const rejected = []
	const keys = []
	for (let i = 0; i < (Array.isArray(records) ? records.length : 0); i++) {
		const rec = records[i]
		if (!isPlainRecord(rec)) continue
		const raw = rec[field]
		const got = classifyPoint(raw, { catalogue: opts.catalogue, halo: opts.halo })
		if (got.ok) {
			accepted.push({ index: i, key: got.key, record: rec })
			if (!keys.includes(got.key)) keys.push(got.key)
			continue
		}
		rejected.push({ index: i, ref: typeof raw === 'string' ? raw : null, code: got.code, reason: got.reason, candidates: got.candidates, error: got.error })
	}
	let status = 'ok'
	if (rejected.length) {
		if (rejected.some((r) => r.code === STAGE_CODES.LEDGER_INVALID)) status = 'invalid'
		else if (rejected.some((r) => r.code === STAGE_CODES.ID_AMBIGUOUS)) status = 'ambiguous'
		else status = 'migration-required'
	}
	return { ok: rejected.length === 0, status, accepted, rejected, keys }
}

/* ── ④ 共同提交边界：计划 → 三闸 → 提交（U06） ─────────────────────────── */

/**
 * 造一份"追加一条记录"的提交计划（**零写**；build 会拿锁内真实写前字节再算一遍）。
 *
 * `compute(ctx)` 由适配层给，必须**同步、纯计算、不写盘**：
 *   ctx = { root, fs（只读视图）, files, rel, file, beforeText }
 *   → { content:string, value?:any, operation?:string }；抛错 = 拒绝（一个字节都不写）。
 *
 * @param {string} kind intake / goals / teaching
 * @param {string} root 课程包根
 * @param {Function} compute
 * @param {{fs?:object, operation?:string, strictIdentity?:boolean, identity?:string, catalogue?:object,
 *          halo?:string|null, identityField?:string}} [opts]
 * @returns {{ok:true, plan:object, build:Function, rel:string, file:string, operation:string} |
 *           {ok:false, state:'rejected', code:string, error:string, failure:object,
 *            buildError:string|null, rel:string, file:string}}
 */
function planAppend(kind, root, compute, opts = {}) {
	const spec = ledgerOf(kind)
	const io = fsOf(opts, 'planAppend')
	if (typeof compute !== 'function') throw new TypeError('planAppend：compute 必须是函数（内容只能由它算，不能手填）')
	const rootAbs = path.resolve(String(root == null ? '' : root))
	const file = path.join(rootAbs, ...spec.rel.split('/'))
	const operation = typeof opts.operation === 'string' && opts.operation.trim() ? opts.operation.trim() : `append-${spec.kind}`
	const identityField = opts.identityField || spec.identityField
	let buildFailure = null

	/** 严格面：目标台账里已有的记录也必须是规范身份（旧形状 → 先迁移，不在坏账本上分配版本） */
	const enforceStrictIdentity = (beforeText) => {
		const rows = parseJsonlRows(beforeText).filter((r) => r.parsed).map((r) => r.record).filter((r) => isPlainRecord(r))
		const ver = verifyIdentities(rows, { field: identityField, catalogue: opts.catalogue, halo: opts.halo })
		if (ver.ok) return
		const first = ver.rejected[0]
		throw stageError(first.code, `台账里有 ${ver.rejected.length} 条非规范身份（第一处：${first.error}）`, { file })
	}

	const build = (ctx) => {
		const files = ctx && ctx.files ? ctx.files : {}
		const rels = Object.keys(files)
		if (!rels.length) return { operation, value: null, files: [{ rel: spec.rel, content: '' }] }
		try {
			const beforeText = files[spec.rel] == null ? '' : String(files[spec.rel])
			if (opts.strictIdentity === true) {
				enforceStrictIdentity(beforeText)
			}
			const out = compute({ ...ctx, root: rootAbs, rel: spec.rel, file, beforeText })
			if (!out || typeof out !== 'object') throw stageError(STAGE_CODES.LEDGER_INVALID, 'compute 必须返回 { content }')
			if (typeof out.content !== 'string') throw stageError(STAGE_CODES.LEDGER_INVALID, 'compute.content 必须是字符串')
			// **坏账本上不分配版本**：字段级复核放在 compute 之后（既有"写后回读自检"的措辞先说话），
			// 但仍在同一个提交边界内（= 也在锁内）再核一次五态。
			assertWritableLedger(beforeText, { file, format: spec.format, validate: opts.validate })
			return { operation: typeof out.operation === 'string' && out.operation ? out.operation : operation, value: out.value, files: [{ rel: spec.rel, content: out.content }] }
		} catch (e) {
			if (!buildFailure) buildFailure = e
			throw e
		}
	}

	// 严格面：**这次要写的身份**也先核（在碰任何事务之前拒；旧形状/歧义都到这里就停）
	if (opts.strictIdentity === true && opts.identity !== undefined) {
		const got = classifyPoint(opts.identity, { catalogue: opts.catalogue, halo: opts.halo })
		if (!got.ok) {
			return {
				ok: false, state: 'rejected', code: got.code, error: got.error, failure: got.failure,
				buildError: null, rel: spec.rel, file, refusedBeforeCommit: true,
			}
		}
	}

	const planned = planCommit(rootAbs, build, { fs: io })
	if (!planned.ok) {
		const code = (buildFailure && buildFailure.code) || planned.code
		const error = buildFailure ? msgOf(buildFailure) : planned.error
		const failure = (buildFailure && buildFailure.failure) || planned.failure
		return { ok: false, state: 'rejected', code, error, failure, buildError: buildFailure ? msgOf(buildFailure) : null, rel: spec.rel, file }
	}
	return { ok: true, plan: planned.plan, build, rel: spec.rel, file, operation }
}

/**
 * 按三闸提交（闸①②在前置：计划/确认/回引摘要；闸③在锁内：真实字节摘要 + 锁内重建）。
 * `confirm` 由**受信适配层**给（普通写入不再弹一次 UI —— 同 U06 的口径）。
 */
function applyAppend(kind, root, planned, opts = {}) {
	ledgerOf(kind)
	const io = fsOf(opts, 'applyAppend')
	if (!planned || planned.ok !== true || !planned.plan) {
		throw new TypeError('applyAppend：必须传 planAppend 的成功结果（不接受手写计划）')
	}
	const res = applyCommit(path.resolve(String(root == null ? '' : root)), planned.plan, {
		confirm: opts.confirm === false ? false : true,
		planDigest: opts.planDigest === undefined ? planned.plan.planDigest : opts.planDigest,
		build: planned.build,
		transaction: opts.transaction,
		fs: io,
		ownerToken: opts.ownerToken,
		timeoutMs: opts.timeoutMs,
	})
	return receiptOf(res, planned)
}

/** 提交回执 → 本层的统一回执（不改 state 词、不宣称成功） */
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
		buildError: null,
	}
	// build（= 适配层的领域校验 / 台账状态复核 / 写后自检）抛出的原话要**原样**带回：
	// 上层既有的错误文本契约（例如"写后回读不一致，已回滚：…"）不能变成"build 抛错：…"
	if (!out.ok && typeof out.error === 'string') {
		const PREFIX = 'build 抛错：'
		if (out.error.startsWith(PREFIX)) out.buildError = out.error.slice(PREFIX.length)
	}
	return out
}

/**
 * 追加一条记录：计划 → 提交；`PLAN_STALE` / `LOCK_BUSY` 时**重读字节、重算版本**再提交（有限次）。
 * 版本分配因此始终基于"这一次提交边界内读到的字节"，并发写既不会撞版本也不会丢更新。
 *
 * @param {string} kind
 * @param {string} root
 * @param {Function} compute 见 `planAppend`
 * @param {{fs?:object, transaction?:object, ownerToken?:string, timeoutMs?:number,
 *          retries?:number, ensureParent?:boolean, confirm?:boolean,
 *          strictIdentity?:boolean, identity?:string, catalogue?:object, halo?:string|null,
 *          identityField?:string, operation?:string}} [opts]
 * @returns {object} 统一回执 + `attempts`
 */
function appendRecord(kind, root, compute, opts = {}) {
	const spec = ledgerOf(kind)
	const rootAbs = path.resolve(String(root == null ? '' : root))
	const file = path.join(rootAbs, ...spec.rel.split('/'))
	const retries = Number.isSafeInteger(opts.retries) && opts.retries >= 0 ? opts.retries : DEFAULT_RETRIES
	// 既有行为：三个适配层都先建台账目录再进事务（注入的故障 fs 不参与这一步）
	if (opts.ensureParent !== false) {
		try { nodeFs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* 建不出来就让后面的提交如实失败 */ }
	}
	let attempts = 0
	for (;;) {
		attempts += 1
		const planned = planAppend(kind, rootAbs, compute, opts)
		if (planned.ok !== true) return { ...planned, attempts }
		const receipt = applyAppend(kind, rootAbs, planned, opts)
		if (receipt.ok === true) return { ...receipt, attempts }
		if (!RETRY_CODES[receipt.code] || attempts > retries) return { ...receipt, attempts }
		// 计划过期 / 锁忙：不覆盖别人的字节，重读重算再来一次
	}
}

module.exports = {
	STAGE_LEDGERS,
	STAGE_CODES,
	IO_ERROR_STATUS,
	BLOCKING_STATUSES,
	RETRY_CODES,
	DEFAULT_RETRIES,
	ledgerOf,
	ledgerFile,
	readLedgerText,
	readStageLedger,
	assertWritableLedger,
	parseJsonlRows,
	latestByRaw,
	mergeCanonical,
	versionLines,
	buildCatalogue,
	classifyPoint,
	verifyIdentities,
	stageError,
	planAppend,
	applyAppend,
	appendRecord,
}
