/**
 * lib/teaching-view.js — 设置页「教学方式」：**只读视图** + 「跟老师说」正文拼装
 * ==================================================================
 * 主人 2026-09-25 定的形态（设置页那一条）：
 *   学生**在设置里**对 agent 说出自己的要求 → agent 按**那个圆圈**的可调项改参数 →
 *   **改完给他看**（节奏照既有约定：先 `op=propose` 出预览 → 他点头 → 才 `op=write`）。
 *
 * 本文件只做两件**纯**事（无 IO、无学科知识）：
 *   ① `teachingView()` —— 把台账 + 课程包的圆圈清单折成设置页要渲染的形状：
 *      **现行取值**（含"这一项是谁定的"）+ **注入原文**（与 `injectionBlock` **逐字节同源**，
 *      不是另写一份"差不多"的话 —— 学生看到的必须就是老师收到的那段）。
 *   ② `requestText()`  —— 把「圆圈 + 学生原话 + 现行参数」拼成**给 agent 的请求正文**。
 *      拼装规则**只有这一份**（与 `lib/starter.js` 的开课正文同一个立场：浏览器半边不拼话术）。
 *
 * ⚠️ **本文件是全范围面**（它跟所有圆圈打交道）—— 不许只对一个学科成立。
 *    判据：`test/settings-teaching.mjs` 拿 `subjectsHit()` 扫**整个源文件**，命中恰好 1 个学科就红。
 *    可调项、取值、指令句一律**从台账取**，这里一个字都不许写。
 *
 * ⚠️ **只读**：这里没有任何写盘路径 —— 落盘只有 `recordTeaching()` 一个口（agent 经
 *    `whale_teaching op=write` 走它）。设置页发起的是一段**对话**，不是一次写。
 */

import { globalSpec, resolveFor, TEACHING_DISCIPLINE, GLOBAL_CIRCLE } from './teaching-io.js'
import { injectionBlock } from './teaching-apply.js'

export const TEACHING_VIEW_SCHEMA = 'whale-teaching-view/1'

/** 学生那一句要求的长度上限（超了**拒发**，不静默截断 —— 截断会把他的意思改掉） */
export const REQUEST_MAX_CHARS = 300

/**
 * 一个可调项 → 设置页的一行。
 * 学生看的就是**那句指令**（取值本身没有中文名，指令句就是它的意思）。
 *
 * `from` 是这一行的关键：
 *   · `own`     = **这一层自己定的**（全局层里就是全局记录，圆圈块里就是那个圆圈自己的记录）；
 *   · `global`  = 继承全局层（只有圆圈块会出这个）；
 *   · `default` = 谁都没写，落回该档位默认。
 * （P1 修过的坑：别把全局取值渲染成圆圈的特化 —— 学生会以为"我给这个圆圈改过"。）
 */
function rowOf(item, resolved, ownParams, globalParams) {
	const value = resolved?.params?.[item.id]
	const valueIds = (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null)
	const directives = valueIds
		.map((v) => (item.values || []).find((x) => x.id === v))
		.filter(Boolean)
		.map((x) => x.directive)
	const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k)
	return {
		id: item.id,
		label: item.label,
		value: value ?? null,
		valueIds,
		directives,
		from: has(ownParams, item.id) ? 'own' : (has(globalParams, item.id) ? 'global' : 'default'),
		// 这一项有得选吗（有取值域就有）—— 设置页用它提示"这个圆圈能调什么"
		choosable: (item.values || []).map((x) => ({ id: x.id, directive: x.directive })),
	}
}

/**
 * 一层（全局层 或 某个圆圈）的视图。
 * @param {{circle: string, name: string, spec: object[], resolved: object, ownParams: object|null,
 *          globalParams: object|null, values: object|null, block: string}} o
 */
function layerView(o) {
	// `home` = 这一项**归哪一层**（全局表里的，还是这个圆圈自己 spec 声明的）；
	// 与 `from`（取值是谁定的）是两件事 —— 设置页要分开说，不然"能调什么"会串台。
	const items = [
		...globalSpec().map((item) => ({ ...rowOf(item, o.resolved, o.ownParams, o.globalParams), home: 'global' })),
		...(o.spec || []).map((item) => ({ ...rowOf(item, o.resolved, o.ownParams, o.globalParams), home: 'circle' })),
	]
	return {
		circle: o.circle,
		name: o.name,
		tier: o.resolved?.tier ?? 1,
		hasSpec: (o.spec || []).length > 0,
		/** 只有**这一层自己**改过的项 —— 圆圈那一行靠它，不许拿生效值冒充特化 */
		own: items.filter((r) => r.from === 'own').map((r) => r.id),
		items,
		tunables: items.map((r) => ({ id: r.id, label: r.label, home: r.home })),
		freeText: (o.values?.freeText || []).map((f) => ({ text: f.text, source: f.source ?? 'student' })),
		/** 这个圆圈的**固定做法**（`kind=guide`）：学生改不了，但得让他看得见 */
		guide: (o.guide || []).map((g) => ({ title: g.title, lines: [...g.lines] })),
		guideV: o.guideV ?? 0,
		block: o.block,
	}
}

/**
 * 设置页要渲染的**整块视图**。
 *
 * @param {ReturnType<import('./teaching-io.js').readTeaching>} data 台账（`readTeaching(root)`）
 * @param {{circles?: {id: string, name?: string}[]}} [opts]
 *   `circles` = **课程包里的圆圈清单**（`readPack` 来的）。一定要传：
 *   台账里还没有记录的圆圈也必须列出来 —— 学生正是要对"还没定过教学方式"的圆圈提要求。
 *   台账里有、课程包里已经没有的圆圈**也列**（`orphan: true`，不静默丢）。
 */
export function teachingView(data, opts = {}) {
	const listed = Array.isArray(opts.circles) ? opts.circles : []
	const globalValues = data?.global?.values || null
	const globalParams = globalValues?.params || null

	const globalLayer = layerView({
		circle: GLOBAL_CIRCLE,
		name: '全局层（对所有圆圈生效）',
		spec: [],
		resolved: resolveFor(data, GLOBAL_CIRCLE),
		// 全局层的"自己"就是全局记录 —— 这一层没有"继承"这一说
		ownParams: globalParams,
		globalParams,
		values: globalValues,
		block: injectionBlock({ data, circle: GLOBAL_CIRCLE }).block,
	})

	const known = new Set(listed.map((c) => c && c.id).filter(Boolean))
	const orphanIds = Object.keys(data?.circles || {}).filter((id) => !known.has(id))
	const all = [...listed.filter(Boolean), ...orphanIds.map((id) => ({ id, name: id, orphan: true }))]

	const circles = all.map((c) => {
		const rec = data?.circles?.[c.id] || null
		const layer = layerView({
			circle: c.id,
			name: c.name || c.id,
			spec: rec?.spec || [],
			resolved: resolveFor(data, c.id),
			ownParams: rec?.values?.params || null,
			globalParams,
			values: rec?.values || null,
			guide: rec?.guide || [],
			guideV: rec?.guideV ?? 0,
			block: injectionBlock({ data, circle: c.id }).block,
		})
		return {
			...layer,
			orphan: c.orphan === true,
			specV: rec?.specV ?? 0,
			valuesV: rec?.valuesV ?? 0,
			reason: rec?.values?.reason ?? null,
		}
	})

	return {
		schema: TEACHING_VIEW_SCHEMA,
		file: data?.file ?? null,
		problems: [...(data?.problems || [])],
		global: globalLayer,
		circles,
		/** 锁死集：学生说改也不改（设置页只展示，不给入口） */
		locked: TEACHING_DISCIPLINE.map((d) => ({ id: d.id, label: d.label })),
	}
}

/** 视图里找一层（全局层 或 某个圆圈） */
function layerOf(view, circle) {
	if (!view) return null
	if (circle === GLOBAL_CIRCLE) return view.global || null
	return (view.circles || []).find((c) => c.circle === circle) || null
}

/**
 * 「跟老师说」的**请求正文**（拼装规则只有这一份）。
 *
 * 为什么要有它：学生在设置页里只写一句人话（"讲慢一点"），剩下的是**宿主拼的**——
 * 哪个圆圈、现在是什么、可调项在哪查、按什么节奏落盘、哪些是红线。浏览器半边不拼话术。
 *
 * @param {{circle?: string, request: string, view?: object}} o
 *   `view` = `teachingView()` 的结果（拿不到就少给一段现状 —— 正文仍可用，只是老师要自己 read）
 * @returns {string}
 */
export function requestText(o = {}) {
	const circle = String(o.circle ?? GLOBAL_CIRCLE).trim() || GLOBAL_CIRCLE
	const request = String(o.request ?? '').replace(/\s+/g, ' ').trim()
	if (!request) throw new Error('学生那一句要求是空的 —— 没话可带')
	if (request.length > REQUEST_MAX_CHARS) {
		throw new Error(`学生那一句 ${request.length} 字，超过上限 ${REQUEST_MAX_CHARS} —— 先让他说短点（截断会把意思改掉，所以拒发）`)
	}

	const layer = layerOf(o.view, circle)
	const isGlobal = circle === GLOBAL_CIRCLE
	const where = isGlobal
		? '全局层（对所有圆圈生效）'
		: `圆圈「${circle}」${layer?.name && layer.name !== circle ? '（' + layer.name + '）' : ''}`

	const lines = [
		'【教学方式 · 学生提了要求】',
		'',
		`改哪一层：${where}`,
		`学生原话：「${request}」`,
	]

	if (layer) {
		lines.push('', `这一层现在生效的教学参数（tier ${layer.tier}）：`)
		const rows = (layer.items || []).filter((r) => (r.directives || []).length)
		for (const r of rows) {
			const mark = r.from === 'own' ? '（这一层自己定的）' : (r.from === 'global' ? '（继承全局层）' : '（还没定过，用的档位默认）')
			lines.push(`   · ${r.label}${mark}：${r.directives.join(' ')}`)
		}
		if (!rows.length) lines.push('   · （这一层还没有任何生效参数）')
		if (!isGlobal && layer.hasSpec === false) {
			lines.push(`   ⚠️ 这个圆圈**还没声明过可调项** —— 先用 \`kind=spec\` 给它声明，再写取值。`)
		}
		if (!isGlobal) {
			const g = layer.guide || []
			lines.push(g.length
				? `   这个圆圈的**固定做法**（学生改不了，走 \`kind=guide\`）：${g.map((x) => x.title).join(' / ')}`
				: '   这个圆圈还没有固定做法（`kind=guide`）。')
		}
	}

	lines.push(
		'',
		'请按既有节奏办，**不要跳步**：',
		`   ① \`whale_teaching op=read circle="${circle}"\` —— 先看**这一层**的可调项、取值域与固定做法（可调项由该圆圈的 spec 声明；没声明过就先声明）。`,
		'   ② 把他这句话**翻译成参数取值**，用 `op=propose` 出一版**预览**给他看（propose 不写盘）。',
		'   ③ **他点头**才 `op=write`。写的是哪一层就只动那一层。',
		'   ④ 改完用一句话把「现在是什么」说给他听 —— 设置页「教学方式」也会跟着刷新。',
		'',
		'⚠️ 他那句话**落不到任何可调项上**时：如实说哪一句落不到、问他要一句更具体的 —— **不许**自己编一个参数塞进去。',
		'   确属这个圆圈的**固定做法**（"教它时按这套做"）才动 `kind=guide`，**同样要他点头**（先 propose 预览）。',
		'',
		`红线（**不在可调集里，他说改也不改**）：${TEACHING_DISCIPLINE.map((d) => d.label).join(' / ')}。`,
	)

	return lines.join('\n')
}
