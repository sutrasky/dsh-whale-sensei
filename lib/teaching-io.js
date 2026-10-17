/**
 * lib/teaching-io.js — 教学参数：**唯一真源 + 唯一校验器**（2026-09-25 主人定）
 * ==================================================================
 * 主人的要求（`_board/01-鲸师.md:278-280`）：**代码注释是重要的一块**；这类东西要接进
 * 「可调整的教学方法」—— 不是通用解：每个学生可以按自己接受到的教学提要求，agent 据此改进
 * **可以改动的**教学方法，这些方法最终**进提示词**。
 *
 * 2026-09-25 主人的两条裁定（改过这一版）：
 *   ① **锁死集必须学科中立**：鲸师面向**全方面**的知识目标，不是编程专用 ——
 *      「先读学生代码」这种编程行为**不许**写进全范围（判据见 `subjectsHit()`）。
 *   ② **教学特化挂在圆圈上**：台账 `learning-records/teaching.jsonl` **按圆圈分节**，
 *      **每个圆圈有自己独立的教学方法**；特化只在生成**该圆圈的课**时注入提示词，
 *      **不是写在全范围的**。学科知识一律**数据驱动**（圆圈自己的 `spec` 记录声明），
 *      **不许硬编码在代码里**。
 *
 * 两层模型：
 *   · **全局层**（`circle: '*'`）：学科中立的参数（讲解顺序 / 术语 / 报错）—— 取值域在本文件里。
 *   · **圆圈层**（`circle: 'programming'` 等）：该圆圈自己的 `spec`（可调项 + 取值域 + 每个取值的
 *     **指令句** + 档位默认）与取值。**代码里没有任何学科词** —— 编程的注释密度、数学的解题步骤，
 *     都是**数据**，写在那个圆圈的记录里。
 *
 * 台账形态照 `lib/goal-io.js` 的 GoalRecord 那一套（`01:310` 明写"照 goal-io.js 那套"）：
 * append-only、**最新一条生效**、`v`/`replaces`/`reason` 留痕、**键序钉死**、**绝不写时间字段**。
 *
 * ⚠️ **命名避让**（`01:325`）：`whale_style` / `lib/style.js` 已经被"课程包主题（theme.css）"
 *    占了 —— 教学风格一律用 **teaching**，别再用 style 这个词。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { TIERS } from './goal-io.js'

/**
 * 包级事务件（T09）：教学台账的读旧账 → 算版本 → 追加 → 自检都在包锁内完成（T10 / C01）。
 * 每个 `(circle, kind)` 一条版本线；版本必须与写前快照同一个锁口径算。
 */
const requireCJS = createRequire(import.meta.url)
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')
/** 台账在包内的相对路径（事务写集只认包内相对路径） */
const TEACHING_REL = 'learning-records/teaching.jsonl'

export const TEACHING_SCHEMA = 'whale-teaching/1'

/** `circle` 取这个值 = **全局层**（学科中立，对所有圆圈生效） */
export const GLOBAL_CIRCLE = '*'

/**
 * 记录种类：
 *   · `spec`  = 圆圈**可调项**的声明（有哪些能改、取值域、每个取值的指令句、档位默认）；
 *   · `values`= 某一层级的**取值**；
 *   · `guide` = 圆圈的**固定做法**（学生改不了，也不是取值 —— 就是"教这个学科时按这套做"）。
 *
 * 为什么要有 `guide`（2026-09-25 主人定，P2）：教学纪律是**学科中立**的（先看学生的产出），
 * 但"**怎么看**"是特化的 —— 编程看源码树与清单文件，别的学科看别的。这类**固定做法**
 * 既不是可调项（没有取值域、学生不该改），也不能写在全范围技能里（写进去就是特化），
 * 所以它跟 spec / values 一样**挂在圆圈上**，由 `injectionBlock` 带进生成课程的提示词。
 */
export const KINDS = Object.freeze(['spec', 'values', 'guide'])

/** 键序钉死：TeachingRecord */
export const TEACHING_KEYS = Object.freeze([
	'schema', 'v', 'replaces', 'reason', 'circle', 'kind', 'spec', 'guide', 'tier', 'params', 'freeText', 'source',
])

/**
 * 键序钉死：SpecItem（圆圈声明的一个可调项）。
 *
 * ⚠️ `judge` **必须在这里**：`lib/teaching-apply.js` 的 `judgeTeachingContent()` 读它
 *    （圆圈声明 `judge: '名字'`，插件按名字查可插拔表；没实现就 `ok:null`，不假装判过）。
 *    2026-09-25 补：原先这张表里没有 `judge`，于是**声明判据这条路根本写不进来** ——
 *    agent 一写就被当"多余键"拒，`JUDGES` 永远空表，那条"可插拔"是死的。
 *    判据：`test/teaching-io.mjs` 有一条「spec 能声明 judge，且原样读回」。
 */
export const SPEC_KEYS = Object.freeze(['id', 'label', 'values', 'defaultByTier', 'judge'])

/**
 * 键序钉死：GuideItem（圆圈声明的一条**固定做法**）。
 *
 * 形状刻意做成"标题 + 若干行"：它是要**原样进提示词**的话，不是参数 ——
 * 所以没有取值域、没有档位默认、**学生改不了**（要改就是换这个圆圈的教法，那是另一回事）。
 */
export const GUIDE_KEYS = Object.freeze(['title', 'lines'])

/** 固定做法的规模上限（超了**拒写**并提示拆/合并 —— 不许静默截断） */
export const GUIDE_MAX_ITEMS = 8
export const GUIDE_MAX_LINES = 8
export const GUIDE_MAX_LINE_CHARS = 240

/** 记录来源封闭集（与 goal-io 同口径） */
export const TEACHING_SOURCES = Object.freeze(['student', 'agent', 'manual'])

/**
 * **全局可调项**（学科中立）—— 每个取值都带一句**指令句**（`directive`），
 * 注入提示词时直接用它，不需要任何学科知识。
 *
 * ⚠️ 这里**只许放对所有知识目标都成立的东西**。学科特化（编程的注释密度……）走圆圈的 `spec`。
 *    判据：`test/teaching-io.mjs` 有一条扫这张表，命中**恰好一个**学科就红。
 */
export const TEACHING_PARAMS = Object.freeze({
	explainOrder: Object.freeze({
		label: '讲解顺序',
		values: Object.freeze([
			Object.freeze({ id: 'overview-first', directive: '讲解顺序：**先给全貌，再进细节**。' }),
			Object.freeze({ id: 'detail-first', directive: '讲解顺序：**先给细节，再回到全貌**。' }),
		]),
		defaultByTier: Object.freeze({ 1: 'overview-first', 2: 'overview-first', 3: 'overview-first', 4: 'overview-first' }),
	}),
	termPairing: Object.freeze({
		label: '术语',
		values: Object.freeze([
			Object.freeze({ id: 'on', directive: '术语**首次出现**时给中英对照。' }),
			Object.freeze({ id: 'off', directive: '术语不必给中英对照（只写中文即可）。' }),
		]),
		defaultByTier: Object.freeze({ 1: 'on', 2: 'on', 3: 'on', 4: 'on' }),
	}),
	errorStyle: Object.freeze({
		label: '报错',
		values: Object.freeze([
			Object.freeze({ id: 'principle-first', directive: '讲报错：**先讲原理，再给修法**。' }),
			Object.freeze({ id: 'fix-first', directive: '讲报错：**直接给修法**。' }),
		]),
		defaultByTier: Object.freeze({ 1: 'principle-first', 2: 'principle-first', 3: 'principle-first', 4: 'principle-first' }),
	}),
})

/**
 * **锁死集**（教学纪律）：学生说改也不改。
 * 它们不是参数 —— 写进 `params` 会被当**多余键拒写**；单独提也会被点名拒（见 recordTeaching）。
 *
 * ⚠️ **必须学科中立**（主人 2026-09-25 裁定）：判据 = `subjectsHit()` 命中的学科数**恰好 1 个**就红
 *    （≥2 个是跨学科举例，放行）。清理清单：`study/鲸师-教学特化清理清单-20260925.md`。
 */
export const TEACHING_DISCIPLINE = Object.freeze([
	Object.freeze({ id: 'readStudentWorkFirst', label: '先看学生的产出', why: '没看产出就点评 = 猜（编程是代码、数学是解题过程、写作是稿子）' }),
	Object.freeze({ id: 'citeSources', label: '先查资料给出处', why: '出处逐条落课程包的 RESOURCES.md' }),
	Object.freeze({ id: 'noVerbalPass', label: '不拿口头确认判过', why: '口头确认单独出现不足以判过' }),
])

/** 自由补充那一小撮（沿用偏好台账的规矩：5 条 × 40 字） */
export const FREE_TEXT_MAX = 5
export const FREE_TEXT_MAX_CHARS = 40

/**
 * **学科词表** —— 只服务于一条判据：「全范围层必须学科中立」（主人 2026-09-25 裁定）。
 *
 * 判法不是"出现学科词就红"，而是**看它跨了几个学科**：
 *   · 命中 **恰好 1 个**学科 ⇒ **特化**（只对一个学科成立的东西写进了全范围）→ 红；
 *   · 命中 **≥2 个**学科 ⇒ 那是**跨学科举例**（"编程是代码、数学是解题过程、写作是稿子"），放行；
 *   · 命中 0 个 ⇒ 中立，放行。
 *
 * 为什么把词表放在**生产代码**里而不是测试里：它是**契约的不变量**，判据与实现必须同一份。
 */
export const SUBJECT_WORDS = Object.freeze({
	编程: Object.freeze(['代码', '编译', '函数', '变量', '注释']),
	数学: Object.freeze(['公式', '定理', '证明', '解题']),
	语言: Object.freeze(['语法', '音标', '例句', '单词']),
	写作: Object.freeze(['稿子', '段落', '行文']),
})

/**
 * 一段文本命中了哪几个学科（见 SUBJECT_WORDS 的判法说明）。
 * @param {string} text
 * @returns {string[]} 命中的学科名（顺序 = SUBJECT_WORDS 的键序）
 */
export function subjectsHit(text) {
	const t = String(text || '')
	return Object.keys(SUBJECT_WORDS).filter((k) => SUBJECT_WORDS[k].some((w) => t.includes(w)))
}

/** 契约常量：形状的**单一登记处** */
export const TeachingContract = Object.freeze({
	schema: TEACHING_SCHEMA,
	keys: TEACHING_KEYS,
	specKeys: SPEC_KEYS,
	guideKeys: GUIDE_KEYS,
	kinds: KINDS,
	tiers: TIERS,
	sources: TEACHING_SOURCES,
	globalCircle: GLOBAL_CIRCLE,
	params: TEACHING_PARAMS,
	discipline: TEACHING_DISCIPLINE,
	freeText: Object.freeze({ max: FREE_TEXT_MAX, maxChars: FREE_TEXT_MAX_CHARS }),
})

/** 台账绝对路径 */
export function teachingPath(root) {
	return path.join(path.resolve(root), 'learning-records', 'teaching.jsonl')
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

/* ── 校验工具 ───────────────────────────────────────────────── */

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

function normCircle(v, where) {
	if (typeof v !== 'string' || !v.trim()) throw bad(where, 'circle 必填（圆圈 id；全局层用 \'*\'）')
	const s = v.trim()
	if (s !== GLOBAL_CIRCLE && !/^[a-z][a-z0-9-]*$/.test(s)) {
		throw bad(where, `circle 必须是 kebab-case 圆圈 id 或 '${GLOBAL_CIRCLE}'，实得 ${JSON.stringify(v)}`)
	}
	return s
}

/**
 * 校验一个圆圈的**固定做法**（`kind: 'guide'` 的 `guide` 字段）。
 * 形状：`[{ title, lines: string[] }]` —— 标题 + 若干行，**原样进提示词**。
 *
 * 上限一律**拒写**（不静默截断、不静默丢）：固定做法是要每轮都进提示词的话，
 * 太长就是每轮付一次上下文租金，且会把真正重要的那几行淹掉。
 */
export function validateGuide(raw, where = 'guide') {
	if (!Array.isArray(raw) || !raw.length) throw bad(where, 'guide 必须是非空数组（这个圆圈的固定做法）')
	if (raw.length > GUIDE_MAX_ITEMS) {
		throw bad(where, `固定做法上限 ${GUIDE_MAX_ITEMS} 条，实得 ${raw.length} —— 先合并/删掉旧的再写（不许静默丢）`)
	}
	const seenTitles = new Set()
	const out = []
	for (const item of raw) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(where, 'guide 项必须是对象 { title, lines }')
		checkUnknownKeys(item, GUIDE_KEYS, where)
		const title = String(item.title ?? '').replace(/\s+/g, ' ').trim()
		if (!title) throw bad(where, 'guide 项缺 title（这条做法叫什么）')
		if (seenTitles.has(title)) throw bad(where, `guide 有重复标题：${title}`)
		seenTitles.add(title)
		if (!Array.isArray(item.lines) || !item.lines.length) throw bad(where, `「${title}」的 lines 必须是非空数组`)
		if (item.lines.length > GUIDE_MAX_LINES) {
			throw bad(where, `「${title}」上限 ${GUIDE_MAX_LINES} 行，实得 ${item.lines.length} —— 先压短再写`)
		}
		const lines = []
		for (const l of item.lines) {
			const s = String(l ?? '').replace(/\s+/g, ' ').trim()
			if (!s) throw bad(where, `「${title}」有空行 —— 空行不进提示词，删掉或补上内容`)
			if (s.length > GUIDE_MAX_LINE_CHARS) {
				throw bad(where, `「${title}」有一行 ${s.length} 字，超过上限 ${GUIDE_MAX_LINE_CHARS}：${s.slice(0, 30)}… —— 先压短再写`)
			}
			if (lines.includes(s)) throw bad(where, `「${title}」有重复行：${s.slice(0, 30)}…`)
			lines.push(s)
		}
		out.push({ title, lines })
	}
	return out
}

/**
 * 校验一个**圆圈的教学方法声明**（`kind: 'spec'` 的 `spec` 字段）。
 * 形状：`[{ id, label, values: [{ id, directive }], defaultByTier }]`
 * —— 取值域与**每个取值的指令句**都由数据给，代码里不留任何学科知识。
 */
export function validateSpec(raw, where = 'spec') {
	if (!Array.isArray(raw) || !raw.length) throw bad(where, 'spec 必须是非空数组（这个圆圈有哪些可调项）')
	const seen = new Set()
	const out = []
	for (const item of raw) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(where, 'spec 项必须是对象')
		checkUnknownKeys(item, SPEC_KEYS, `${where}/${item.id ?? '?'}`)
		const id = String(item.id ?? '').trim()
		if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(id)) throw bad(where, `spec 项的 id 必须是驼峰标识符，实得 ${JSON.stringify(item.id)}`)
		if (seen.has(id)) throw bad(where, `spec 里 id 重复：${id}`)
		seen.add(id)
		if (id in TEACHING_PARAMS) throw bad(where, `spec 里的 ${id} 与全局可调项同名 —— 圆圈特化要换个 id（全局的归全局）`)
		const label = String(item.label ?? '').trim()
		if (!label) throw bad(where, `${id} 缺 label（给学生看的中文名）`)
		if (!Array.isArray(item.values) || !item.values.length) throw bad(where, `${id} 的 values 必须是非空数组`)
		const vals = []
		const seenV = new Set()
		for (const v of item.values) {
			if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(where, `${id} 的取值必须是对象 { id, directive }`)
			checkUnknownKeys(v, ['id', 'directive'], `${where}/${id}/values`)
			const vid = String(v.id ?? '').trim()
			if (!vid) throw bad(where, `${id} 有取值缺 id`)
			if (seenV.has(vid)) throw bad(where, `${id} 的取值 id 重复：${vid}`)
			seenV.add(vid)
			const dir = String(v.directive ?? '').trim()
			// 每个取值**必须**带指令句：注入提示词时直接用它，不许在代码里另写一份话术
			if (!dir) throw bad(where, `${id} 的取值 ${vid} 缺 directive（这一档要怎么教，一句话）—— 没有它就没法注入`)
			vals.push({ id: vid, directive: dir })
		}
		if (!item.defaultByTier || typeof item.defaultByTier !== 'object') throw bad(where, `${id} 缺 defaultByTier`)
		const dbt = {}
		for (const t of TIERS) {
			const d = item.defaultByTier[t]
			if (d === undefined) throw bad(where, `${id} 的 defaultByTier 缺 tier ${t}（四档都要给 —— 缺一档会在学生升档那天才暴露）`)
			if (!seenV.has(d)) throw bad(where, `${id} 的 defaultByTier[${t}] = ${JSON.stringify(d)} 不在取值域里`)
			dbt[t] = d
		}
		// `judge` 可选：声明了就必须是个名字（名字在不在 `JUDGES` 里由判据那边查 —— 这里只管形状）。
		// **不声明就不落这个键**：键序与字节要与没声明过的 spec 逐字节相同。
		const judge = item.judge === undefined || item.judge === null || item.judge === ''
			? null
			: String(item.judge).trim()
		if (item.judge !== undefined && item.judge !== null && item.judge !== '' && !/^[a-zA-Z][a-zA-Z0-9]*$/.test(judge)) {
			throw bad(where, `${id} 的 judge 必须是驼峰标识符，实得 ${JSON.stringify(item.judge)}`)
		}
		out.push(judge
			? { id, label, values: vals, defaultByTier: dbt, judge }
			: { id, label, values: vals, defaultByTier: dbt })
	}
	return out
}

/** 全局参数表 → 与 spec 同形的数组（注入与判据都按同一种形状遍历） */
export function globalSpec() {
	return Object.keys(TEACHING_PARAMS).map((id) => {
		const d = TEACHING_PARAMS[id]
		return { id, label: d.label, values: d.values.map((v) => ({ id: v.id, directive: v.directive })), defaultByTier: { ...d.defaultByTier } }
	})
}

/* ── 默认值与生效值 ─────────────────────────────────────────── */

/**
 * 某一档位的**默认参数**（全局 ⊕ 该圆圈 spec；键序 = 全局在前、圆圈在后）。
 * @param {number} tier
 * @param {object[]} [spec] 该圆圈的 spec（省略 = 只有全局）
 */
export function defaultsFor(tier, spec = []) {
	const t = TIERS.includes(tier) ? tier : 1
	const out = {}
	for (const item of globalSpec()) out[item.id] = item.defaultByTier[t]
	for (const item of spec || []) out[item.id] = item.defaultByTier[t]
	return out
}

/**
 * **生效参数** = 该档位默认值（全局 ⊕ 圆圈）⊕ 全局取值 ⊕ 该圆圈取值。
 * 记录里没写的项**落回默认**（不是"没有值"）。
 *
 * @param {{globalValues?: object|null, circleValues?: object|null, spec?: object[], tier?: number|null}} o
 * @returns {{ tier: number, params: object, overridden: string[], spec: object[] }}
 */
export function resolveParams(o = {}) {
	const spec = o.spec || []
	const tier = o.tier ?? (o.circleValues?.tier ?? o.globalValues?.tier ?? 1)
	const t = TIERS.includes(tier) ? tier : 1
	const params = defaultsFor(t, spec)
	const overridden = []
	const known = new Set([...globalSpec().map((x) => x.id), ...spec.map((x) => x.id)])
	for (const layer of [o.globalValues, o.circleValues]) {
		for (const [id, v] of Object.entries(layer?.params || {})) {
			if (!known.has(id)) continue
			params[id] = Array.isArray(v) ? [...v] : v
			if (!overridden.includes(id)) overridden.push(id)
		}
	}
	return { tier: t, params, overridden, spec }
}

/* ── 校验 + 归一化（写侧严格 / 读侧容错） ───────────────────── */

/** params → 键序钉死；取值域 = 全局表 ⊕ 该圆圈 spec */
function normParams(v, where, strict, spec) {
	if (v === undefined || v === null) return {}
	if (typeof v !== 'object' || Array.isArray(v)) throw bad(where, `params 必须是对象，实得 ${JSON.stringify(v)}`)
	const table = new Map()
	for (const item of [...globalSpec(), ...(spec || [])]) table.set(item.id, item)
	const locked = TEACHING_DISCIPLINE.map((d) => d.id)
	const out = {}
	// 键序 = 参数表顺序（不是调用方给的顺序 —— 保证同输入同字节）
	for (const id of table.keys()) {
		if (!(id in v)) continue
		const item = table.get(id)
		const val = v[id]
		const ids = item.values.map((x) => x.id)
		if (Array.isArray(val)) {
			if (!val.length) throw bad(where, `params.${id}（${item.label}）给了空数组（要么给值，要么别写这一项）`)
			const seen = new Set()
			for (const x of val) {
				if (!ids.includes(x)) throw bad(where, `params.${id} 的取值不认识：${JSON.stringify(x)}（可用：${ids.join(' / ')}）`)
				if (seen.has(x)) throw bad(where, `params.${id} 重复取值：${x}`)
				seen.add(x)
			}
			out[id] = ids.filter((x) => seen.has(x))
		} else {
			if (!ids.includes(val)) throw bad(where, `params.${id}（${item.label}）的取值不认识：${JSON.stringify(val)}（可用：${ids.join(' / ')}）`)
			out[id] = val
		}
	}
	if (strict) {
		for (const k of Object.keys(v)) {
			if (table.has(k)) continue
			if (locked.includes(k)) {
				throw bad(where, `「${k}」是**教学纪律**，不在可调集里 —— 学生说改也不改（可调项见 TEACHING_PARAMS 与圆圈的 spec）`)
			}
			throw bad(where, `params 里有多余键 ${JSON.stringify(k)}（可调项：${[...table.keys()].join(' / ') || '(无)'}）`)
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
		if (item.confirmed !== true) throw bad(where, `freeText「${text}」没有 confirmed:true —— 学生点头才写`)
		out.push({ text, source: source ?? 'student', confirmed: true })
	}
	return out
}

/**
 * 校验 + 归一化成**键序钉死**的 TeachingRecord（两种 kind）。
 * @param {object} x
 * @param {{strict?: boolean, where?: string, spec?: object[]}} [opts] `spec` = 该圆圈已声明的 spec（校验取值域用）
 */
export function validateTeaching(x, { strict = false, where = 'TeachingRecord', spec = [] } = {}) {
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
	const circle = normCircle(x.circle, where)
	const kind = x.kind ?? 'values'
	if (!KINDS.includes(kind)) throw bad(where, `kind 必须是 ${KINDS.join(' / ')}，实得 ${JSON.stringify(x.kind)}`)
	const source = x.source ?? null
	if (source !== null && !TEACHING_SOURCES.includes(source)) {
		throw bad(where, `source 必须是 ${TEACHING_SOURCES.join(' / ')}，实得 ${JSON.stringify(x.source)}`)
	}

	if (kind === 'spec') {
		if (circle === GLOBAL_CIRCLE) throw bad(where, `kind=spec 必须挂在**某个圆圈**上（circle 不能是 '${GLOBAL_CIRCLE}' —— 全局的可调项在代码里，是全学科中立的）`)
		if (x.tier !== undefined && x.tier !== null) throw bad(where, 'kind=spec 不该有 tier（档位默认在 spec 的 defaultByTier 里）')
		if (x.params !== undefined && x.params !== null) throw bad(where, 'kind=spec 不该有 params（它声明的是取值域，不是取值）')
		if (x.guide !== undefined && x.guide !== null) throw bad(where, 'kind=spec 不该有 guide（固定做法是 kind=guide 的事）')
		// ⚠️ **只落该有的键**：写侧把空字段也写进去的话，读侧会拿"不该有"把它判成不合规
		//    （实测：spec 记录带 `params: {}` ⇒ 读回来整条进 problems）。键序仍是 TEACHING_KEYS 的子序。
		return {
			schema: TEACHING_SCHEMA, v, replaces, reason, circle, kind,
			spec: validateSpec(x.spec, `${where}/spec`),
			source,
		}
	}

	if (kind === 'guide') {
		if (circle === GLOBAL_CIRCLE) throw bad(where, `kind=guide 必须挂在**某个圆圈**上（circle 不能是 '${GLOBAL_CIRCLE}' —— 全局层只有学科中立的可调项）`)
		if (x.tier !== undefined && x.tier !== null) throw bad(where, 'kind=guide 不该有 tier（固定做法没有档位之分）')
		if (x.params !== undefined && x.params !== null) throw bad(where, 'kind=guide 不该有 params（固定做法不是取值）')
		if (x.freeText !== undefined && x.freeText !== null) throw bad(where, 'kind=guide 不该有 freeText（那是 values 的事）')
		if (x.spec !== undefined && x.spec !== null) throw bad(where, 'kind=guide 不该有 spec（可调项是 kind=spec 的事）')
		return {
			schema: TEACHING_SCHEMA, v, replaces, reason, circle, kind,
			guide: validateGuide(x.guide, `${where}/guide`),
			source,
		}
	}

	if (x.spec !== undefined && x.spec !== null) throw bad(where, 'kind=values 不该有 spec（那是 kind=spec 的事）')
	if (x.guide !== undefined && x.guide !== null) throw bad(where, 'kind=values 不该有 guide（那是 kind=guide 的事）')
	const tier = normTier(x.tier, where)
	return {
		schema: TEACHING_SCHEMA, v, replaces, reason, circle, kind,
		tier,
		params: normParams(x.params, where, strict, circle === GLOBAL_CIRCLE ? [] : spec),
		freeText: normFreeText(x.freeText, where, strict),
		source,
	}
}

/* ── 读：readTeaching（按圆圈分节；文件不存在 = 正常空态） ──── */

/**
 * 读台账。读法照 `readGoals`：文件不存在 / 空 = 正常空态（不是错误）；
 * 坏行进 problems 不抛、不静默丢；**每个圆圈各自"最新一条生效"**。
 *
 * @param {string} root
 * @returns {{ file: string, entries: object[], problems: string[],
 *   global: { values: object|null, v: number },
 *   circles: Record<string, { spec: object[], specV: number, values: object|null, valuesV: number,
 *     guide: object[], guideV: number }> }}
 */
/**
 * 解析台账全文（readTeaching 与事务内的「写前快照」**同一份**解析口径）。
 * @returns 同 readTeaching 的返回形状
 */
function parseTeachingText(text, file) {
	const entries = []
	const problems = []
	const lines = String(text == null ? '' : text).split('\n')
	// 先按圆圈收 spec（校验取值域要用它），再逐行严格读
	const raw = []
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim()
		if (!t) continue
		try {
			raw.push({ row: JSON.parse(t), at: i + 1 })
		} catch (e) {
			problems.push(`第 ${i + 1} 行解析失败：${e.message}`)
		}
	}
	const specByCircle = {}
	for (const { row, at } of raw) {
		if (row && row.kind === 'spec' && typeof row.circle === 'string') {
			try {
				specByCircle[row.circle] = validateSpec(row.spec, `第 ${at} 行/spec`)
			} catch (e) {
				problems.push(`第 ${at} 行不合规：${e.message}`)
			}
		}
	}
	for (const { row, at } of raw) {
		try {
			entries.push(validateTeaching(row, { strict: false, where: `第 ${at} 行`, spec: specByCircle[row?.circle] || [] }))
		} catch (e) {
			problems.push(`第 ${at} 行不合规：${e.message}`)
			entries.push(row) // 容错不丢：原文保留，只是不干净
		}
	}

	const circles = {}
	let globalValues = null
	let globalV = 0
	for (const e of entries) {
		if (!e || typeof e.circle !== 'string') continue
		if (e.circle === GLOBAL_CIRCLE) {
			if (e.kind === 'values' && Number.isSafeInteger(e.v) && e.v >= globalV) { globalValues = e; globalV = e.v }
			continue
		}
		const c = circles[e.circle] || (circles[e.circle] = { spec: [], specV: 0, values: null, valuesV: 0, guide: [], guideV: 0 })
		if (e.kind === 'spec' && Number.isSafeInteger(e.v) && e.v >= c.specV) { c.spec = e.spec || []; c.specV = e.v }
		if (e.kind === 'values' && Number.isSafeInteger(e.v) && e.v >= c.valuesV) { c.values = e; c.valuesV = e.v }
		if (e.kind === 'guide' && Number.isSafeInteger(e.v) && e.v >= c.guideV) { c.guide = e.guide || []; c.guideV = e.v }
	}
	return { file, entries, problems, global: { values: globalValues, v: globalV }, circles }
}

export function readTeaching(root) {
	const file = teachingPath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return { file, entries: [], problems: [], global: { values: null, v: 0 }, circles: {} }
	}
	return parseTeachingText(text, file)
}

/** 该圆圈的 spec（没有声明过就空数组 —— 只有全局可调项） */
export function specFor(data, circle) {
	return (data?.circles?.[circle]?.spec) || []
}

/**
 * 该圆圈的**固定做法**（`kind=guide`；没有声明过就空数组）。
 * 学生改不了 —— 它进生成课程的提示词，但不在可调集里。
 * @param {ReturnType<typeof readTeaching>} data
 * @param {string} circle
 */
export function guideFor(data, circle) {
	return (data?.circles?.[circle]?.guide) || []
}

/**
 * 该圆圈的**生效参数**（全局默认 ⊕ 全局取值 ⊕ 圆圈 spec 默认 ⊕ 圆圈取值）。
 * @param {ReturnType<typeof readTeaching>} data
 * @param {string} circle
 */
export function resolveFor(data, circle) {
	const c = data?.circles?.[circle] || null
	return resolveParams({
		globalValues: data?.global?.values || null,
		circleValues: c?.values || null,
		spec: c?.spec || [],
	})
}

/* ── 写：recordTeaching（append + 回读校验 + 失败逐字节回滚） ── */

/**
 * 追加一版（append-only：换参数/换声明 = 追加新版本，不覆盖）。
 * `v` / `replaces` 按 **(circle, kind)** 各自算 —— 每个圆圈、每种记录各有一条版本线。
 *
 * @param {string} root
 * @param {object} input TeachingRecord 形态（v/replaces 可省）
 * @param {{fs?:object, ownerToken?:string, timeoutMs?:number}} [txn] 仅供测试注入事务件（生产不传）
 * @returns {{ ok: boolean, file: string, record?: object, error?: string, state?: string }}
 */
export function recordTeaching(root, input, txn) {
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

	let circle
	try {
		circle = normCircle(input.circle, 'TeachingRecord')
	} catch (e) {
		return { ok: false, file, error: e.message }
	}
	const kind = input.kind ?? 'values'
	if (!KINDS.includes(kind)) return { ok: false, file, error: `kind 必须是 ${KINDS.join(' / ')}，实得 ${JSON.stringify(input.kind)}` }

	// 读旧账 → 算版本 → 严校验 → 追加 → 回读自检，**全部在同一个包事务内**。
	// 版本线与写前快照同一个锁口径算 —— 并发写不会撞版本。
	let buildError = null
	let record = null
	let result
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		result = PACK_TXN.withPackTransaction(path.resolve(root), ({ files }) => {
			try {
				if (!Object.prototype.hasOwnProperty.call(files, TEACHING_REL)) {
					return [{ rel: TEACHING_REL, content: '' }]
				}
				const beforeText = files[TEACHING_REL] == null ? '' : String(files[TEACHING_REL])
				const data = parseTeachingText(beforeText, file)

				// 版本线：同一 (circle, kind) 各自算
				const same = data.entries.filter((e) => e && e.circle === circle && (e.kind ?? 'values') === kind)
				let maxV = 0
				for (const e of same) if (Number.isSafeInteger(e.v) && e.v >= 1 && e.v > maxV) maxV = e.v
				const v = maxV + 1
				const prev = same.length ? same[same.length - 1] : null
				const replaces = prev && Number.isSafeInteger(prev.v) && prev.v >= 1 ? prev.v : null
				if (input.v !== undefined && input.v !== v) {
					throw new Error(`v 由台账算出应为 ${v}（${circle}/${kind} 现有最大 ${maxV}），不接受显式 ${JSON.stringify(input.v)}`)
				}
				if (input.replaces !== undefined && input.replaces !== replaces) {
					throw new Error(`replaces 由台账算出应为 ${JSON.stringify(replaces)}，不接受显式 ${JSON.stringify(input.replaces)}`)
				}

				const rec = validateTeaching({
					schema: TEACHING_SCHEMA, v, replaces,
					reason: input.reason ?? null,
					circle, kind,
					spec: input.spec ?? null,
					guide: input.guide ?? null,
					tier: input.tier ?? null,
					params: input.params ?? null,
					freeText: input.freeText ?? null,
					source: input.source ?? null,
				}, { strict: true, where: 'TeachingRecord', spec: specFor(data, circle) })

				const line = JSON.stringify(rec)
				// 已有记录前缀字节**原样保留**（只追加）
				const body = beforeText + line + '\n'
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
				return [{ rel: TEACHING_REL, content: body }]
			} catch (e) {
				buildError = e
				throw e
			}
		}, txnOpts(txn))
	} catch (e) {
		return txnFailure(file, '教学台账写入', { ok: false, state: 'rejected', error: e && e.message ? e.message : String(e) })
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
	return txnFailure(file, '教学台账写入', result)
}
