/**
 * lib/teaching-io.js — 教学参数：**唯一真源 + 唯一校验器**（2026-09-25 主人定）
 * ==================================================================
 * 主人这条要求（`_board/01-鲸师.md:278-280`）：**代码注释是重要的一块**；这类东西要接进
 * 「可调整的教学方法」—— 不是通用解：每个学生可以按自己接受到的教学提要求，agent 据此改进
 * **可以改动的**教学方法，这些方法最终**进提示词**。
 *
 * 这个文件负责其中三件事（设计建议 1 / 2 / 6，见 `01:286-291`）：
 *   ① **可枚举的参数**（取值 + 默认值）—— 纯自由文本"注入后无法验证是否生效"，也没法对比；
 *   ② **可调集 vs 锁死集** —— 学生的要求只能改可调项；**教学纪律不开放调整**
 *      （先读学生代码 / 先查资料给出处 / 不拿口头确认判过：学生说改也不改，否则他能把自己的
 *      教学质量关掉）；
 *   ③ **上限 + 合并** —— 自由补充封顶，超了**拒写并提示合并**，不许静默丢或覆盖。
 *
 * 台账形态照 `lib/goal-io.js` 的 GoalRecord 那一套（`01:310` 明写"照 goal-io.js 那套"）：
 * append-only、**最新一条生效**、`v`/`replaces`/`reason` 留痕、**键序钉死**、**绝不写时间字段**。
 *
 * ⚠️ **命名避让**（`01:325`）：`whale_style` / `lib/style.js` 已经被"课程包主题（theme.css）"
 *    占了 —— 教学风格一律用 **teaching**，别再用 style 这个词。
 * ⚠️ 参数**默认值随档位（tier 1–4）变**（设计建议 7）：初学逐行讲、进阶少注释多挑战，
 *    不是全局一刀切。
 */

import fs from 'node:fs'
import path from 'node:path'
import { TIERS } from './goal-io.js'

export const TEACHING_SCHEMA = 'whale-teaching/1'

/** 键序钉死：TeachingRecord（落盘顺序就是这里列的顺序） */
export const TEACHING_KEYS = Object.freeze([
	'schema', 'v', 'replaces', 'reason', 'tier', 'params', 'freeText', 'source',
])

/** 记录来源封闭集（与 goal-io 同口径） */
export const TEACHING_SOURCES = Object.freeze(['student', 'agent', 'manual'])

/**
 * **可调集**（参数表 = 唯一真源）：id → { label, values, multi?, defaultByTier }
 *
 * `defaultByTier` 必须给全 1/2/3/4 四档 —— 缺一档就是"某个档位没有默认值"，
 * 那种洞会在学生升档那天才暴露。示范五参数见 `01:298-302`。
 */
export const TEACHING_PARAMS = Object.freeze({
	commentDensity: Object.freeze({
		label: '注释密度',
		values: Object.freeze(['line', 'block', 'key']),
		defaultByTier: Object.freeze({ 1: 'line', 2: 'line', 3: 'block', 4: 'key' }),
	}),
	commentDims: Object.freeze({
		label: '注释维度',
		values: Object.freeze(['what', 'link', 'req', 'why']),
		multi: true,
		defaultByTier: Object.freeze({
			1: Object.freeze(['what', 'link', 'req', 'why']),
			2: Object.freeze(['what', 'link', 'req', 'why']),
			3: Object.freeze(['what', 'link', 'req', 'why']),
			4: Object.freeze(['what', 'link', 'req', 'why']),
		}),
	}),
	explainOrder: Object.freeze({
		label: '讲解顺序',
		values: Object.freeze(['overview-first', 'detail-first']),
		defaultByTier: Object.freeze({ 1: 'overview-first', 2: 'overview-first', 3: 'overview-first', 4: 'overview-first' }),
	}),
	termPairing: Object.freeze({
		label: '术语',
		values: Object.freeze(['on', 'off']),
		defaultByTier: Object.freeze({ 1: 'on', 2: 'on', 3: 'on', 4: 'on' }),
	}),
	errorStyle: Object.freeze({
		label: '报错',
		values: Object.freeze(['principle-first', 'fix-first']),
		defaultByTier: Object.freeze({ 1: 'principle-first', 2: 'principle-first', 3: 'principle-first', 4: 'principle-first' }),
	}),
})

/**
 * **锁死集**（教学纪律）：学生说改也不改。
 * 它们不是参数 —— 写进 `params` 会被当**多余键拒写**；单独提也会被点名拒（见 recordTeaching）。
 */
export const TEACHING_DISCIPLINE = Object.freeze([
	Object.freeze({ id: 'readStudentCodeFirst', label: '先读学生代码', why: '没读代码就点评 = 猜' }),
	Object.freeze({ id: 'citeSources', label: '先查资料给出处', why: '出处逐条落课程包的 RESOURCES.md' }),
	Object.freeze({ id: 'noVerbalPass', label: '不拿口头确认判过', why: '口头确认单独出现不足以判过' }),
])

/** 自由补充那一小撮（沿用偏好台账的规矩：5 条 × 40 字） */
export const FREE_TEXT_MAX = 5
export const FREE_TEXT_MAX_CHARS = 40

/** 契约常量：形状的**单一登记处**（工具描述、测试、客户端都读这里，不许各自抄一份） */
export const TeachingContract = Object.freeze({
	schema: TEACHING_SCHEMA,
	keys: TEACHING_KEYS,
	tiers: TIERS,
	sources: TEACHING_SOURCES,
	params: TEACHING_PARAMS,
	discipline: TEACHING_DISCIPLINE,
	freeText: Object.freeze({ max: FREE_TEXT_MAX, maxChars: FREE_TEXT_MAX_CHARS }),
})

/** 台账绝对路径 */
export function teachingPath(root) {
	return path.join(path.resolve(root), 'learning-records', 'teaching.jsonl')
}

/* ── 默认值与生效值 ─────────────────────────────────────────── */

/**
 * 某一档位的**默认参数**（键序 = TEACHING_PARAMS 顺序；多值项给一份拷贝，别让调用方改到常量）。
 * @param {number} tier 1..4
 * @returns {Record<string, string|string[]>}
 */
export function defaultsFor(tier) {
	const t = TIERS.includes(tier) ? tier : 1
	const out = {}
	for (const [id, def] of Object.entries(TEACHING_PARAMS)) {
		const v = def.defaultByTier[t]
		out[id] = Array.isArray(v) ? [...v] : v
	}
	return out
}

/**
 * **生效参数** = 该档位默认值 ⊕ 现行记录里显式写了的项。
 * 记录里没写的项**落回默认**（不是"没有值"）—— 学生只调一两个参数时，其余照旧。
 *
 * @param {object|null|undefined} record 现行 TeachingRecord（或 null = 全默认）
 * @returns {{ tier: number, params: Record<string, string|string[]>, overridden: string[] }}
 */
export function resolveParams(record) {
	const tier = record && TIERS.includes(record.tier) ? record.tier : 1
	const params = defaultsFor(tier)
	const overridden = []
	for (const [id, v] of Object.entries(record?.params || {})) {
		if (!(id in TEACHING_PARAMS)) continue
		params[id] = Array.isArray(v) ? [...v] : v
		overridden.push(id)
	}
	return { tier, params, overridden }
}

/* ── 校验 + 归一化（写侧严格 / 读侧容错） ───────────────────── */

function bad(where, msg) {
	return new Error(`${where}：${msg}`)
}

function checkUnknownKeys(obj, allowed, where) {
	for (const k of Object.keys(obj)) {
		if (!allowed.includes(k)) throw bad(where, `多余键 ${JSON.stringify(k)}（schema 里没有这个字段，不静默丢）`)
	}
}

function normTier(v, where) {
	if (v === undefined || v === null) return null
	if (!Number.isSafeInteger(v) || !TIERS.includes(v)) {
		throw bad(where, `tier 必须是 1/2/3/4 的整数（1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲），实得 ${JSON.stringify(v)}`)
	}
	return v
}

/** params → 键序钉死（按 TEACHING_PARAMS 顺序，不是调用方给的顺序 —— 保证同输入同字节） */
function normParams(v, where, strict) {
	if (v === undefined || v === null) return {}
	if (typeof v !== 'object' || Array.isArray(v)) throw bad(where, `params 必须是对象，实得 ${JSON.stringify(v)}`)
	const locked = TEACHING_DISCIPLINE.map((d) => d.id)
	const out = {}
	for (const id of Object.keys(TEACHING_PARAMS)) {
		if (!(id in v)) continue
		const def = TEACHING_PARAMS[id]
		const val = v[id]
		if (def.multi) {
			if (!Array.isArray(val) || !val.length) {
				throw bad(where, `params.${id}（${def.label}）必须是**非空数组**（可多选：${def.values.join(' / ')}）`)
			}
			const seen = new Set()
			for (const x of val) {
				if (!def.values.includes(x)) {
					throw bad(where, `params.${id} 的取值不认识：${JSON.stringify(x)}（可用：${def.values.join(' / ')}）`)
				}
				if (seen.has(x)) throw bad(where, `params.${id} 重复取值：${x}`)
				seen.add(x)
			}
			// 顺序钉死成 values 的顺序 —— 学生写 ['why','what'] 与 ['what','why'] 落盘必须一致
			out[id] = def.values.filter((x) => seen.has(x))
		} else {
			if (!def.values.includes(val)) {
				throw bad(where, `params.${id}（${def.label}）的取值不认识：${JSON.stringify(val)}（可用：${def.values.join(' / ')}）`)
			}
			out[id] = val
		}
	}
	if (strict) {
		for (const k of Object.keys(v)) {
			if (k in TEACHING_PARAMS) continue
			if (locked.includes(k)) {
				throw bad(where, `「${k}」是**教学纪律**，不在可调集里 —— 学生说改也不改（可调项见 TEACHING_PARAMS）`)
			}
			throw bad(where, `params 里有多余键 ${JSON.stringify(k)}（可调项：${Object.keys(TEACHING_PARAMS).join(' / ')}）`)
		}
	}
	return out
}

/** freeText → 键序钉死；上限在这里拦（拒写，不静默丢） */
function normFreeText(v, where, strict) {
	if (v === undefined || v === null) return []
	if (!Array.isArray(v)) throw bad(where, `freeText 必须是数组，实得 ${JSON.stringify(v)}`)
	if (v.length > FREE_TEXT_MAX) {
		throw bad(where, `自由补充上限 ${FREE_TEXT_MAX} 条，实得 ${v.length} —— 先合并/删掉旧的再写（不许静默丢或覆盖）`)
	}
	const out = []
	const seen = new Set()
	for (const item of v) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(where, 'freeText 项必须是对象 { text, source, confirmed }')
		if (strict) checkUnknownKeys(item, ['text', 'source', 'confirmed'], `${where}/freeText`)
		const text = String(item.text ?? '').replace(/\s+/g, ' ').trim()
		if (!text) throw bad(where, 'freeText 项的 text 不能为空')
		if (text.length > FREE_TEXT_MAX_CHARS) {
			throw bad(where, `freeText 单条上限 ${FREE_TEXT_MAX_CHARS} 字，实得 ${text.length} 字：${text.slice(0, 20)}… —— 先压短再写`)
		}
		if (seen.has(text)) throw bad(where, `freeText 有重复条目：${text}`)
		seen.add(text)
		const source = item.source ?? null
		if (source !== null && !TEACHING_SOURCES.includes(source)) {
			throw bad(where, `freeText.source 必须是 ${TEACHING_SOURCES.join(' / ')}，实得 ${JSON.stringify(source)}`)
		}
		// 写入闸 = 确认制（照偏好台账）：没点头的不落盘
		if (item.confirmed !== true) throw bad(where, `freeText「${text}」没有 confirmed:true —— 学生点头才写`)
		out.push({ text, source: source ?? 'student', confirmed: true })
	}
	return out
}

/**
 * 校验 + 归一化成**键序钉死**的 TeachingRecord。
 * @param {object} x 待校验对象
 * @param {{strict?: boolean, where?: string}} [opts] strict = 写侧（缺字段就抛）
 */
export function validateTeaching(x, { strict = false, where = 'TeachingRecord' } = {}) {
	if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(where, '记录必须是对象')
	if (strict) checkUnknownKeys(x, TEACHING_KEYS, where)
	if (x.schema !== undefined && x.schema !== null && x.schema !== TEACHING_SCHEMA) {
		throw bad(where, `schema 必须是 ${TEACHING_SCHEMA}，实得 ${JSON.stringify(x.schema)}`)
	}
	let v = x.v ?? null
	if (v !== null && (!Number.isSafeInteger(v) || v < 1)) throw bad(where, `v 必须是 ≥1 的整数，实得 ${JSON.stringify(x.v)}`)
	let replaces = x.replaces ?? null
	if (replaces !== null && (!Number.isSafeInteger(replaces) || replaces < 1)) {
		throw bad(where, `replaces 必须是 ≥1 的整数或 null，实得 ${JSON.stringify(x.replaces)}`)
	}
	const reason = x.reason === undefined || x.reason === null || x.reason === '' ? null : String(x.reason)
	const tier = normTier(x.tier, where)
	const source = x.source ?? null
	if (source !== null && !TEACHING_SOURCES.includes(source)) {
		throw bad(where, `source 必须是 ${TEACHING_SOURCES.join(' / ')}，实得 ${JSON.stringify(x.source)}`)
	}
	return {
		schema: TEACHING_SCHEMA,
		v,
		replaces,
		reason,
		tier,
		params: normParams(x.params, where, strict),
		freeText: normFreeText(x.freeText, where, strict),
		source,
	}
}

/* ── 读：readTeaching（文件不存在 = 正常空态） ─────────────── */

/**
 * 读台账。读法照 `readGoals`：文件不存在 / 空 = 正常空态（不是错误）；
 * 坏行进 problems 不抛、不静默丢；**最新一行 = 现行参数**（单包单学生，没有 point 维度）。
 *
 * @param {string} root
 * @returns {{ file: string, entries: object[], latest: object|null, problems: string[] }}
 */
export function readTeaching(root) {
	const file = teachingPath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return { file, entries: [], latest: null, problems: [] }
	}
	const entries = []
	const problems = []
	const lines = text.split('\n')
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
			entries.push(validateTeaching(row, { strict: false, where: `第 ${i + 1} 行` }))
		} catch (e) {
			problems.push(`第 ${i + 1} 行不合规：${e.message}`)
			entries.push(row) // 容错不丢：原文保留，只是不干净
		}
	}
	return { file, entries, latest: entries.length ? entries[entries.length - 1] : null, problems }
}

/* ── 写：recordTeaching（append + 回读校验 + 失败逐字节回滚） ── */

/**
 * 追加一版教学参数（append-only：换参数 = 追加新版本，不覆盖）。
 * 写入流程 = `recordGoal` 同款：**拒写在 append 之前**（坏样本一个字节都不落盘）→
 * append → 回读校验 → 失败**逐字节回滚**。
 *
 * `v` / `replaces` 由台账算出（v = 现有最大 v+1，首版 1；replaces = 被取代的 v），调用方不必传；
 * 传了必须与台账一致，否则拒写（不静默覆盖）。
 *
 * @param {string} root
 * @param {object} input TeachingRecord 形态（v/replaces 可省）
 * @returns {{ ok: boolean, file: string, record?: object, error?: string }}
 */
export function recordTeaching(root, input) {
	const file = teachingPath(root)
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, file, error: '记录必须是对象' }
	}
	if (input.schema !== undefined && input.schema !== TEACHING_SCHEMA) {
		return { ok: false, file, error: `schema 必须是 ${TEACHING_SCHEMA}，实得 ${JSON.stringify(input.schema)}` }
	}
	for (const k of Object.keys(input)) {
		if (!TEACHING_KEYS.includes(k)) {
			return { ok: false, file, error: `TeachingRecord：多余键 ${JSON.stringify(k)}（schema 里没有这个字段，不静默丢）` }
		}
	}

	const { entries, latest } = readTeaching(root)
	let maxV = 0
	for (const e of entries) {
		if (Number.isSafeInteger(e.v) && e.v >= 1 && e.v > maxV) maxV = e.v
	}
	const v = maxV + 1
	const replaces = latest && Number.isSafeInteger(latest.v) && latest.v >= 1 ? latest.v : null
	if (input.v !== undefined && input.v !== v) {
		return { ok: false, file, error: `v 由台账算出应为 ${v}（现有最大 ${maxV}），不接受显式 ${JSON.stringify(input.v)}` }
	}
	if (input.replaces !== undefined && input.replaces !== replaces) {
		return { ok: false, file, error: `replaces 由台账算出应为 ${JSON.stringify(replaces)}，不接受显式 ${JSON.stringify(input.replaces)}` }
	}

	let record
	try {
		record = validateTeaching({
			schema: TEACHING_SCHEMA,
			v,
			replaces,
			reason: input.reason ?? null,
			tier: input.tier ?? null,
			params: input.params ?? null,
			freeText: input.freeText ?? null,
			source: input.source ?? null,
		}, { strict: true, where: 'TeachingRecord' })
	} catch (e) {
		return { ok: false, file, error: e.message }
	}

	fs.mkdirSync(path.dirname(file), { recursive: true })
	let prevLen = 0
	try {
		prevLen = fs.statSync(file).size
	} catch {
		/* 文件不存在 */
	}
	const line = JSON.stringify(record)
	fs.appendFileSync(file, line + '\n', 'utf8')
	try {
		const text = fs.readFileSync(file, 'utf8')
		const lastLine = text.trim().split('\n').pop()
		const parsed = JSON.parse(lastLine)
		if (JSON.stringify(parsed) !== line) throw new Error('回读字节与写入不一致')
	} catch (e) {
		try {
			const fd = fs.openSync(file, 'r+')
			fs.ftruncateSync(fd, prevLen)
			fs.closeSync(fd)
		} catch {
			/* truncate 失败就只能报错 */
		}
		return { ok: false, file, error: `写后回读不一致，已回滚：${e.message}` }
	}
	return { ok: true, file, record }
}
