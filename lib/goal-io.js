/**
 * lib/goal-io.js — 终点契约（StageSpec / GoalRecord）纯函数 + 薄 IO 层
 * ------------------------------------------------------------------
 * 施工依据：P0 施工契约 §3.1 / §3.2 / §3.4（批 1）。
 *
 * 台账：<packRoot>/learning-records/goals.jsonl，append-only，一行 = 一版；
 * 同 `point` 的**最后一行 = 现行终点**（读法照 lib/intake.js readIntake().latest 先例）。
 *
 * 三条硬纪律（契约 §1-B2 修正 / B5 / B6）：
 *   ① **绝不写任何时间字段**（不写 at / ts / generatedAt / updatedAt）——
 *      同样的输入必须产出**逐字节相同**的行；版本留痕用 `v` + `replaces` + `reason` + `source` + `from`。
 *   ② 换终点 = **追加新版本，不覆盖**（旧行永久留痕；`v` = 该 point 现有最大 v+1，`replaces` = 被取代的 v）。
 *   ③ 老记录 / 老包缺新字段 → **绝不判「没摸底」、不拦开课**，只提示（回落显示 intake.goal）。
 *
 * 键序钉死（契约 §3.1；判据照 test/mirror-parity.mjs 钉 notes 键序的先例）：
 *   GoalRecord = schema, point, pointPath, v, tier, artifact{what,where}, acceptance[], focus, from, source, replaces, reason
 *   StageSpec  = tier, artifact{what,where}, acceptance[], focus
 *   AcceptanceItem（两种形态二选一）= { no, deliverable, auto, hint } 或 { no, deliverable, checks[{id,kind,value,hint}], hint? }
 *
 * 校验口径（§3.4-4「读侧容错、写侧严格」）：
 *   - `validateStage(x)` 默认**严格**（写侧）：缺必填 / 值不合法 / 多余键 → 抛错。
 *   - `validateStage(x, { strict: false })` = 读侧容错：缺字段当 null / 空，不抛；
 *     但**值**不合法仍抛（由 readGoals 捕获进 problems，不崩、不静默丢）。
 *   - 带 GoalRecord 身份特征的对象（`schema:"whale-goal/1"`，或缺 schema 但带 point/v/source 等
 *     身份键；也可显式 `{ record: true }`）按 **GoalRecord** 校验（point 必填等）；
 *     否则按**裸 StageSpec** 校验 —— ② 的终点顶层与 ③(b) 的 intake.start
 *     **同一个函数生效**（§3.6-3：防「各定一套」）。
 *
 * `acceptance[]` **逐字段对齐 `EXPECT.json` 的 `challenges[]`**（契约 §3.1 / B3，
 * 校验规则照 lib/state.js validateExpect 的 N-9 规则一模一样，kind 集合直接 import STATE_KINDS），
 * 这样它才能被 `lib/state.js` 的判据引擎机械判（judgeChallenges(facts, acceptance)）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { latestIntakeFor } from './intake.js'
import { STATE_KINDS } from './state.js'

/** 包级事务件（T09）：终点台账的读旧账 → 算版本 → 追加 → 自检都在包锁内完成（T10 / C01） */
const requireCJS = createRequire(import.meta.url)
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')
/** 台账在包内的相对路径（事务写集只认包内相对路径） */
const GOALS_REL = 'learning-records/goals.jsonl'

/** 台账 schema 标记（行） / 台阶契约 schema 标记（StageSpec） */
export const GOAL_SCHEMA = 'whale-goal/1'
export const STAGE_SCHEMA = 'whale-stage/1'

/** B4 档位封闭集：1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲 */
export const TIERS = Object.freeze([1, 2, 3, 4])

/** 记录来源封闭集（§3.1 source） */
export const GOAL_SOURCES = Object.freeze(['wizard', 'agent', 'manual'])

/** 键序钉死：StageSpec */
export const STAGE_KEYS = Object.freeze(['tier', 'artifact', 'acceptance', 'focus'])
/** 键序钉死：GoalRecord（§3.1 字段表顺序） */
export const GOAL_KEYS = Object.freeze([
	'schema', 'point', 'pointPath', 'v', 'tier', 'artifact', 'acceptance',
	'focus', 'from', 'source', 'replaces', 'reason',
])

/**
 * 台阶契约常量（schema 形状的单一登记处；校验一律走 validateStage()）。
 * @type {Readonly<{schema: string, goalSchema: string, keys: readonly string[], goalKeys: readonly string[],
 *   artifactKeys: readonly string[], tiers: readonly number[], sources: readonly string[]}>}
 */
export const StageSpec = Object.freeze({
	schema: STAGE_SCHEMA,
	goalSchema: GOAL_SCHEMA,
	keys: STAGE_KEYS,
	goalKeys: GOAL_KEYS,
	artifactKeys: Object.freeze(['what', 'where']),
	tiers: TIERS,
	sources: GOAL_SOURCES,
})

/** 台账绝对路径 */
export function goalsPath(root) {
	return path.join(path.resolve(root), 'learning-records', 'goals.jsonl')
}

/** 事务选项：只把调用方**显式**给的件传下去（生产不传；T10 测试用它注入故障 fs） */
function txnOpts(txn) {
	if (!txn || typeof txn !== 'object') return undefined
	const o = {}
	if (txn.fs) o.fs = txn.fs
	if (txn.ownerToken !== undefined) o.ownerToken = String(txn.ownerToken)
	if (txn.timeoutMs !== undefined) o.timeoutMs = txn.timeoutMs
	return o
}

/** 事务失败的**原回执形状** + 明确 state / rollbackError（不把失败回滚写成成功） */
function txnFailure(file, action, r) {
	const state = r && r.state ? r.state : 'rejected'
	return {
		ok: false,
		file,
		error: `${action}失败（事务 ${state}）：${r && r.error ? r.error : '未知错误'}`,
		state,
		txnId: r && r.txnId ? r.txnId : null,
		rollbackError: r && r.rollbackError ? r.rollbackError : null,
	}
}

/** 解析台账全文（readGoals 与事务内的「写前快照」**同一份**解析口径） */
function parseGoalsText(text, file) {
	const entries = []
	const problems = []
	const lines = String(text == null ? '' : text).split('\n')
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim()
		if (!raw) continue
		let row
		try {
			row = JSON.parse(raw)
		} catch (e) {
			problems.push(`第 ${i + 1} 行解析失败：${e.message}`)
			continue
		}
		try {
			entries.push(validateStage(row, { strict: false, where: `第 ${i + 1} 行` }))
		} catch (e) {
			problems.push(`第 ${i + 1} 行不合规：${e.message}`)
			entries.push(row) // 容错不丢：原文保留，只是不干净
		}
	}
	const latest = {}
	for (const e of entries) {
		if (e.point) latest[e.point] = e
	}
	return { file, entries, latest, problems }
}

/* ── 校验 + 归一化（写侧严格 / 读侧容错） ───────────────────── */

function bad(where, msg) {
	return new Error(`${where}：${msg}`)
}

function checkUnknownKeys(obj, allowed, where) {
	for (const k of Object.keys(obj)) {
		if (!allowed.includes(k)) throw bad(where, `多余键 ${JSON.stringify(k)}（schema 里没有这个字段）`)
	}
}

function normString(v, where, field, { nullable = true, nonEmpty = false } = {}) {
	if (v === undefined || v === null) {
		if (nullable) return null
		throw bad(where, `${field} 缺失`)
	}
	if (typeof v !== 'string') throw bad(where, `${field} 必须是字符串，实得 ${JSON.stringify(v)}`)
	if (v === '' && nullable) return null
	if (nonEmpty && !v.trim()) throw bad(where, `${field} 不能为空`)
	return v
}

function normTier(v, where) {
	if (v === undefined || v === null) return null // null = 未结构化（B6 回落）
	if (!Number.isSafeInteger(v) || !TIERS.includes(v)) {
		throw bad(where, `tier 必须是 1/2/3/4 的整数（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲），实得 ${JSON.stringify(v)}`)
	}
	return v
}

/** AcceptanceItem（两种形态二选一）→ 键序钉死的规范形 */
function normAcceptanceItem(item, where, strict) {
	if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(where, 'acceptance 项必须是对象')
	if (strict) {
		checkUnknownKeys(item, ['no', 'deliverable', 'auto', 'checks', 'hint'], `${where}/acceptance`)
	}
	const { no, deliverable, auto, checks, hint } = item
	// N-9 同一套校验：no 正整数；deliverable 必填非空（每题必须有一句明确产出）
	if (!Number.isSafeInteger(no) || no <= 0) throw bad(where, `acceptance 项缺合法 no（正整数序号），实得 ${JSON.stringify(no)}`)
	if (typeof deliverable !== 'string' || !deliverable.trim()) throw bad(where, `acceptance ${no} 缺 deliverable（一句话写清这题要做成什么）`)
	if (hint !== undefined && hint !== null && typeof hint !== 'string') throw bad(where, `acceptance ${no} 的 hint 必须是字符串`)
	if (auto === false) {
		// 形态 A：机器判不了 → 必须给 hint 说明为什么（N-9），且两种形态二选一（§3.1）
		if (!hint) throw bad(where, `acceptance ${no} 标了 auto:false，必须给 hint 说明为什么机器判不了`)
		if (checks !== undefined && checks !== null) throw bad(where, `acceptance ${no} 两种形态二选一：auto:false 就不能带 checks`)
		return { no, deliverable, auto: false, hint }
	}
	// 形态 B：机械判据（kind ∈ STATE_KINDS，与 EXPECT.json challenges[] 逐字段对齐）
	if (!Array.isArray(checks) || !checks.length) throw bad(where, `acceptance ${no} 的 checks 必须是非空数组（判不了就把 auto 设成 false 并写 hint）`)
	const seen = new Set()
	const outChecks = []
	for (const c of checks) {
		if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad(where, `acceptance ${no} 有 checks 项不是对象`)
		if (strict) checkUnknownKeys(c, ['id', 'kind', 'value', 'hint'], `${where}/acceptance${no}/checks`)
		if (!c.id) throw bad(where, `acceptance ${no} 有 checks 项缺 id`)
		if (seen.has(c.id)) throw bad(where, `acceptance ${no} 的 checks id 重复：${c.id}`)
		seen.add(c.id)
		if (!STATE_KINDS.includes(c.kind)) {
			throw bad(where, `acceptance ${no}/${c.id} 的 kind 不认识：${JSON.stringify(c.kind)}（可用：${STATE_KINDS.join(' / ')}）`)
		}
		if (typeof c.value !== 'string' || !c.value) throw bad(where, `acceptance ${no}/${c.id} 缺 value`)
		if (c.hint !== undefined && c.hint !== null && typeof c.hint !== 'string') throw bad(where, `acceptance ${no}/${c.id} 的 hint 必须是字符串`)
		const out = { id: c.id, kind: c.kind, value: c.value }
		if (typeof c.hint === 'string' && c.hint !== '') out.hint = c.hint
		outChecks.push(out)
	}
	const out = { no, deliverable, checks: outChecks }
	if (typeof hint === 'string' && hint !== '') out.hint = hint
	return out
}

/** acceptance 数组 → 键序钉死；N-9：序号不许重复 */
function normAcceptance(v, where, { strict, record }) {
	if (v === undefined || v === null) v = []
	if (!Array.isArray(v)) throw bad(where, `acceptance 必须是数组，实得 ${JSON.stringify(v)}`)
	if (record && strict && !v.length) throw bad(where, 'acceptance 必须非空（终点至少一条验收判据）')
	const seen = new Set()
	const out = []
	for (const item of v) {
		const norm = normAcceptanceItem(item, where, strict)
		if (seen.has(norm.no)) throw bad(where, `acceptance 序号重复：${norm.no}`)
		seen.add(norm.no)
		out.push(norm)
	}
	return out
}

/** artifact → 键序钉死 { what, where }；未填 where = null */
function normArtifact(v, where, { strict, record }) {
	if (v === undefined || v === null) v = null
	if (v !== null) {
		if (typeof v !== 'object' || Array.isArray(v)) throw bad(where, `artifact 必须是对象，实得 ${JSON.stringify(v)}`)
		if (strict) checkUnknownKeys(v, ['what', 'where'], `${where}/artifact`)
	}
	const what = v ? normString(v.what, `${where}/artifact`, 'what', { nullable: true, nonEmpty: true }) : null
	const whereTo = v ? normString(v.where, `${where}/artifact`, 'where', { nullable: true }) : null
	if (record && strict && (what === null || !what.trim())) throw bad(where, 'artifact.what 缺失（作品一句话，wizard goal 原文逐字）')
	return { what, where: whereTo }
}

/** focus → string[] | null（空数组归一成 null；起点装 stuck，终点通常 null） */
function normFocus(v, where) {
	if (v === undefined || v === null) return null
	if (!Array.isArray(v)) throw bad(where, `focus 必须是数组或 null，实得 ${JSON.stringify(v)}`)
	const out = v.map((f, i) => normString(f, where, `focus[${i}]`, { nullable: false, nonEmpty: true }))
	return out.length ? out : null
}

/**
 * 台阶契约校验 + 归一化（② 终点与 ③(b) 起点台阶**同一套 schema、同一个函数**）。
 *
 * @param {object} x StageSpec，或顶层摊着 tier/artifact/acceptance/focus 的 GoalRecord
 * @param {{ strict?: boolean, record?: boolean }} [opts]
 *   strict 默认 true（写侧严格：缺必填 / 多余键抛错）；false = 读侧容错（缺的当 null/空，不抛）。
 *   record 缺省自动判：带 `schema:"whale-goal/…"` 即按 GoalRecord 校验（point 等必填）。
 * @returns {object} 键序钉死的规范形（record → GOAL_KEYS 顺序；否则 STAGE_KEYS 顺序）
 * @throws {Error} 值不合法（写侧还包括缺必填 / 多余键）
 */
export function validateStage(x, opts = {}) {
	const strict = opts.strict !== false
	const where = opts.where || (opts.record ? 'GoalRecord' : 'StageSpec')
	if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(where, '不是对象')
	const record = opts.record !== undefined
		? !!opts.record
		: (typeof x.schema === 'string'
			? x.schema.startsWith('whale-goal/')
			: ['point', 'pointPath', 'v', 'source', 'replaces'].some((k) => x[k] !== undefined))

	if (record) {
		if (strict) checkUnknownKeys(x, [...GOAL_KEYS, 'pointId'], where) // pointId 是入参糖，落盘前会被消化掉
		if (x.schema !== undefined && x.schema !== GOAL_SCHEMA) throw bad(where, `schema 必须是 ${GOAL_SCHEMA}，实得 ${JSON.stringify(x.schema)}`)
		const point = normString(x.point, where, 'point', { nullable: !strict, nonEmpty: true })
		if (strict && point === null) throw bad(where, 'point 缺失（知识点 id；只有 pointId 时取其最后一段）')
		const pointPath = normString(x.pointPath, where, 'pointPath', { nullable: true })
		let v = x.v ?? null
		if (v !== null && (!Number.isSafeInteger(v) || v < 1)) throw bad(where, `v 必须是 ≥1 的整数，实得 ${JSON.stringify(x.v)}`)
		if (strict && v === null) throw bad(where, 'v 缺失（该 point 现有最大 v+1，首版 1）')
		const tier = normTier(x.tier, where)
		if (strict && tier === null) throw bad(where, 'tier 缺失（终点必须定档位：1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）')
		const artifact = normArtifact(x.artifact, where, { strict, record: true })
		const acceptance = normAcceptance(x.acceptance, where, { strict, record: true })
		const focus = normFocus(x.focus, where)
		let from = x.from ?? null
		if (from !== null) from = validateStage(from, { strict: false, record: false, where: `${where}/from` })
		const source = x.source ?? null
		if (source !== null && !GOAL_SOURCES.includes(source)) {
			throw bad(where, `source 必须是 ${GOAL_SOURCES.join(' / ')}，实得 ${JSON.stringify(x.source)}`)
		}
		if (strict && source === null) throw bad(where, 'source 缺失（wizard / agent / manual）')
		let replaces = x.replaces ?? null
		if (replaces !== null && (!Number.isSafeInteger(replaces) || replaces < 1)) throw bad(where, `replaces 必须是 ≥1 的整数或 null，实得 ${JSON.stringify(x.replaces)}`)
		const reason = normString(x.reason, where, 'reason', { nullable: true })
		return { schema: GOAL_SCHEMA, point, pointPath, v, tier, artifact, acceptance, focus, from, source, replaces, reason }
	}

	// 裸 StageSpec（intake.start / GoalRecord.from）
	if (strict) checkUnknownKeys(x, [...STAGE_KEYS], where)
	return {
		tier: normTier(x.tier, where),
		artifact: normArtifact(x.artifact, where, { strict, record: false }),
		acceptance: normAcceptance(x.acceptance, where, { strict, record: false }),
		focus: normFocus(x.focus, where),
	}
}

/* ── ③(b) 起点台阶：intake → StageSpec（同一 schema） ───────── */

/**
 * 摸底答案 → 起点台阶（StageSpec）。
 * 契约 §4-(b)：`entry.start = intakeToStage({level, prior, can, stuck, startTier})`；
 * **四者（prior/can/stuck/startTier）都缺 → 返回 null**（= 未结构化，B6 回落，不写 start）。
 * 映射：tier = startTier（坏 tier 一律抛错 = 拒写）；artifact.what = can → prior → level 逐级回落；
 * focus = [stuck]（§3.1：起点装 stuck）；acceptance = []（起点没有验收判据）。
 *
 * @returns {object|null} 键序钉死的 StageSpec，或 null
 */
export function intakeToStage({ level, prior, can, stuck, startTier } = {}) {
	const has = (x) => typeof x === 'string' && x.trim() !== ''
	const tierAbsent = startTier === undefined || startTier === null
	if (!has(prior) && !has(can) && !has(stuck) && tierAbsent) return null
	let tier = null
	if (!tierAbsent) {
		if (!Number.isSafeInteger(startTier) || !TIERS.includes(startTier)) {
			throw new Error(`startTier 必须是 1/2/3/4 的整数（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲），实得 ${JSON.stringify(startTier)}`)
		}
		tier = startTier
	}
	const what = has(can) ? can : (has(prior) ? prior : (has(level) ? level : null))
	return validateStage({
		tier,
		artifact: { what, where: null },
		acceptance: [],
		focus: has(stuck) ? [stuck] : null,
	}, { record: false, where: 'intake.start' })
}

/* ── 读：readGoals（文件不存在 = 正常空态） ─────────────────── */

/**
 * 读台账。读法照 lib/intake.js readIntake() 先例：
 * 文件不存在 / 空 = 正常空态（不是错误）；坏行进 problems 不抛、不静默丢；
 * `latest[point]` = 该 point **最后一行 = 现行终点**（B5）。
 * 读侧容错（§3.4-4）：合规行返回键序钉死的规范形；值不合规的行按原文保留 + 记 problems。
 *
 * @param {string} root
 * @returns {{ file: string, entries: object[], latest: Record<string, object>, problems: string[] }}
 */
export function readGoals(root) {
	const file = goalsPath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return { file, entries: [], latest: {}, problems: [] }
	}
	return parseGoalsText(text, file)
}

/* ── 写：recordGoal（append + 回读校验 + 失败逐字节回滚） ───── */

/**
 * 追加一版终点契约（append-only，换终点 = 追加新版本不覆盖，B5）。
 * 写入流程 = recordIntake 同款（lib/intake.js:141-178）：append → 回读校验 → 失败**逐字节回滚**。
 *
 * - `v` / `replaces` 由台账算出（v = 该 point 现有最大 v+1，首版 1；replaces = 被本版取代的 v，首版 null），
 *   调用方不必传；传了必须与台账一致，否则拒写（不静默覆盖）。
 * - `from` 不传时**自动从该 point 最新 intake 的 `start` 拷贝**（§4-(b) 留痕）；没有就 null。
 *   台账里那条摸底的 `point` 写成 catalog 复合 id（`programming/js-basics`）或裸 id（`js-basics`）
 *   都认（与 author / whale_intake 同一套解析）；**歧义 / 未知 ⇒ from = null**（不猜、不抛新错）。
 * - `point` 只有 `pointId`（"programming/spring-boot" 形态）时取其**最后一段**（确定性规则，不猜别的）。
 * - **绝不写任何时间字段**（B2 修正）；键序钉死（GOAL_KEYS 顺序）。
 *
 * @param {string} root
 * @param {object} input GoalRecord 形态（v/replaces 可省；可带 pointId 糖）
 * @param {{fs?:object, ownerToken?:string, timeoutMs?:number}} [txn] 仅供测试注入事务件（生产不传）
 * @returns {{ ok: boolean, file: string, record?: object, error?: string, state?: string }}
 */
export function recordGoal(root, input, txn) {
	const file = goalsPath(root)
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, file, error: '记录必须是对象' }
	}
	// 1) 归属：point / pointId（Q10：无归属不落盘，由调用方提示「终点还没结构化」）
	if (input.schema !== undefined && input.schema !== GOAL_SCHEMA) {
		return { ok: false, file, error: `schema 必须是 ${GOAL_SCHEMA}，实得 ${JSON.stringify(input.schema)}` }
	}
	for (const k of Object.keys(input)) {
		if (![...GOAL_KEYS, 'pointId'].includes(k)) {
			return { ok: false, file, error: `GoalRecord：多余键 ${JSON.stringify(k)}（schema 里没有这个字段，不静默丢）` }
		}
	}
	let point = null
	let pointPath = null
	const pointId = typeof input.pointId === 'string' && input.pointId.trim() ? input.pointId : null
	if (typeof input.point === 'string' && input.point.trim()) {
		point = input.point
		pointPath = typeof input.pointPath === 'string' && input.pointPath.trim() ? input.pointPath : pointId
	} else if (input.point !== undefined && input.point !== null && typeof input.point !== 'string') {
		return { ok: false, file, error: `point 必须是字符串，实得 ${JSON.stringify(input.point)}` }
	} else if (pointId) {
		const segs = pointId.split('/').filter(Boolean)
		point = segs.length ? segs[segs.length - 1] : null
		pointPath = pointId
	}
	if (!point) return { ok: false, file, error: 'point 缺失或为空（只有 pointId 时取其最后一段）' }

	// 2)~5) 读旧账 → 算版本 → 严校验 → 追加 → 回读自检，**全部在同一个包事务内**。
	//        版本（v / replaces）必须与写前快照同一个锁口径算 —— 并发写不会撞版本。
	let buildError = null
	let record = null
	let result
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		result = PACK_TXN.withPackTransaction(path.resolve(root), ({ files }) => {
			try {
				if (!Object.prototype.hasOwnProperty.call(files, GOALS_REL)) {
					return [{ rel: GOALS_REL, content: '' }]
				}
				const beforeText = files[GOALS_REL] == null ? '' : String(files[GOALS_REL])
				const parsedBefore = parseGoalsText(beforeText, file)
				const { entries, latest } = parsedBefore

				// 版本留痕：v = 现有最大 v+1；replaces = 被本版取代的 v（= 原现行终点的 v）
				let maxV = 0
				for (const e of entries) {
					if (e.point === point && Number.isSafeInteger(e.v) && e.v >= 1 && e.v > maxV) maxV = e.v
				}
				const v = maxV + 1
				const prev = latest[point]
				const replaces = prev && Number.isSafeInteger(prev.v) && prev.v >= 1 ? prev.v : null
				if (input.v !== undefined && input.v !== v) {
					throw new Error(`v 由台账算出应为 ${v}（该 point 现有最大 ${maxV}），不接受显式 ${JSON.stringify(input.v)}`)
				}
				if (input.replaces !== undefined && input.replaces !== replaces) {
					throw new Error(`replaces 由台账算出应为 ${JSON.stringify(replaces)}，不接受显式 ${JSON.stringify(input.replaces)}`)
				}

				// from = 定终点时的起点台阶快照（该 point 最新 intake 的 start；§4-(b) 拷进去留痕）
				// 摸底台账的 `point` 可能是 catalog 复合 id（`programming/js-basics`）也可能是裸 id
				// （`js-basics`）—— 与 author / whale_intake **同一套**解析（`latestIntakeFor` → `resolvePointRef`）：
				// 解析得出来才取那条记录；**歧义 / 未知 ⇒ 拿不到就 null**（今天的行为），不猜、不抛新错。
				let from = null
				if (input.from !== undefined) {
					from = input.from
				} else {
					try {
						const { resolved, entry } = latestIntakeFor(root, point)
						from = resolved.ok ? (entry?.start ?? null) : null
					} catch {
						from = null
					}
				}

				// 组装规范形并严格校验（写侧严格：坏样本一个字节都不落盘）
				const rec = validateStage({
					schema: GOAL_SCHEMA,
					point,
					pointPath,
					v,
					tier: input.tier ?? null,
					artifact: input.artifact ?? null,
					acceptance: input.acceptance ?? null,
					focus: input.focus ?? null,
					from,
					source: input.source ?? null,
					replaces,
					reason: input.reason ?? null,
				}, { record: true, strict: true, where: 'GoalRecord' })

				const line = JSON.stringify(rec)
				// 已有记录前缀字节**原样保留**（只追加）
				const body = beforeText + line + '\n'
				// 回读校验：最后一行必须可解析，且与写入逐字节一致
				try {
					const lastLine = body.trim().split('\n').pop()
					const parsed = JSON.parse(lastLine)
					if (JSON.stringify(parsed) !== line) throw new Error('回读字节与写入不一致')
				} catch (e) {
					const err = new Error(`写后回读不一致，已回滚：${e && e.message ? e.message : String(e)}`)
					err.selfCheckFailure = true
					throw err
				}
				record = rec
				return [{ rel: GOALS_REL, content: body }]
			} catch (e) {
				buildError = e
				throw e
			}
		}, txnOpts(txn))
	} catch (e) {
		return txnFailure(file, '终点写入', { ok: false, state: 'rejected', error: e && e.message ? e.message : String(e) })
	}

	if (result.ok) return { ok: true, file, record }

	// 事务没提交：把原错误形状带回来，并明确 state（自检失败时一个字节都没落盘）
	if (buildError) {
		return {
			ok: false,
			file,
			error: buildError.message,
			state: result.state,
			txnId: result.txnId || null,
			rollbackError: null,
		}
	}
	return txnFailure(file, '终点写入', result)
}
