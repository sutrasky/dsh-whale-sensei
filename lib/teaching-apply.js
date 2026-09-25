/**
 * lib/teaching-apply.js — 教学参数的**一处注入** + **生效判据**（数据驱动，无学科知识）
 * ==================================================================
 * 设计建议 3 / 4（`_board/01-鲸师.md:288-289`）：唯一真源 + **一处注入**（只在"生成教学内容"
 * 那一段，不塞全局 persona）；每个参数配一条**生效判据**。
 *
 * 2026-09-25 主人裁定后的两条硬约束：
 *   ① **代码里不许有学科知识** —— 指令句一律来自台账里的 `spec`（每个取值自带 `directive`）；
 *      本文件只负责"把 spec 里的句子拼起来"和"判它到没到位"。
 *   ② **按圆圈取** —— 注入 = 全局层（学科中立）⊕ **该圆圈**的 spec 与取值。
 *      教编程与教数学走同一条缝，差别全在数据里。
 *
 * ⚠️ **判据的诚实边界**：注入是否到位、判据有没有实现 —— 机械判；判不了的返回 `ok: null`
 *    并写明原因（**不许拿"没判"冒充"判过了"**）。
 * ⚠️ 内容侧判据是**可插拔**的：圆圈在 spec 里用 `judge: '<名字>'` 声明，本文件只查名字在不在
 *    `JUDGES` 里 —— 插件**不自带任何学科判据**（编程的注释覆盖、数学的步骤完整性，都由圆圈声明）。
 */

import { resolveFor, globalSpec, defaultsFor } from './teaching-io.js'

/** 注入块的标题（唯一字符串 —— 判据与渲染都读它） */
export const INJECTION_TITLE = '教学方式（现行教学参数）'

/**
 * 内容侧判据的**可插拔表**。空表是有意的：
 * 插件不认识任何学科 —— 圆圈在 spec 里声明 `judge: '名字'`，谁声明谁负责给实现。
 * @type {Record<string, (html: string, item: object, value: any) => {ok: boolean|null, detail: string}>}
 */
export const JUDGES = Object.freeze({})

/**
 * 一个可调项 + 取值 → 那一句**指令**（从数据里取；取不到就如实返回 null，不编）。
 * @param {object} item spec 项（或 globalSpec() 的一项）
 * @param {any} value 取值
 */
export function directiveFor(item, value) {
	if (!item) return null
	const vals = Array.isArray(value) ? value : [value]
	const hit = vals
		.map((v) => (item.values || []).find((x) => x.id === v))
		.filter(Boolean)
		.map((x) => x.directive)
	if (!hit.length) return null
	// 多值项：一个取值一句，拼成一行（顺序 = 取值域顺序，保证同输入同字节）
	return hit.join(' ')
}

/**
 * 一组指令（顺序 = 全局参数表顺序 → 圆圈 spec 顺序；保证同输入同字节）。
 * @param {Record<string, any>} params 生效参数
 * @param {object[]} [spec] 该圆圈的 spec
 * @returns {string[]}
 */
export function teachingDirectives(params, spec = []) {
	const out = []
	for (const item of [...globalSpec(), ...(spec || [])]) {
		const line = directiveFor(item, params?.[item.id])
		if (line) out.push(line)
	}
	return out
}

/**
 * 注入块（**唯一生成处**）：生成教学内容那一段把它整段拼进去。
 *
 * @param {{data?: object, circle?: string, record?: object, tier?: number, params?: object, spec?: object[]}} o
 *   给了 `data` + `circle` 就按台账解析（推荐）；也可以直接给 `tier`/`params`/`spec`（测试用）
 * @returns {{ circle: string, tier: number, params: object, spec: object[], directives: string[], block: string }}
 */
export function injectionBlock(o = {}) {
	const circle = o.circle || '*'
	// 给了 `data` + `circle` 就按台账解析；直接给 tier/params/spec 时**也要把档位默认填上** ——
	// 注入要覆盖**每一个**可调项（没被学生改过的那几项，也要把"按默认怎么教"说清楚）。
	const resolved = o.params
		? { tier: o.tier ?? 1, spec: o.spec || [], ...mergeDefaults(o.tier ?? 1, o.spec || [], o.params) }
		: resolveFor(o.data, circle)
	const spec = resolved.spec || []
	const directives = teachingDirectives(resolved.params, spec)
	const head = circle === '*' ? `⚙️ ${INJECTION_TITLE}（tier ${resolved.tier}）` : `⚙️ ${INJECTION_TITLE}（${circle} · tier ${resolved.tier}）`
	const block = [head + '：', ...directives.map((d) => `   · ${d}`)].join('\n')
	return { circle, tier: resolved.tier, params: resolved.params, spec, directives, block }
}

/** 档位默认 ⊕ 显式取值（键序 = 全局 → 圆圈） */
function mergeDefaults(tier, spec, params) {
	const merged = defaultsFor(tier, spec)
	for (const [id, v] of Object.entries(params || {})) merged[id] = Array.isArray(v) ? [...v] : v
	return { tier, params: merged }
}

/* ── 判据 ───────────────────────────────────────────────────── */

/**
 * **注入侧**判据：生成话术里每条指令都在（参数改了 → 文本真变；参数没改 → 逐字节相同由调用方比）。
 * @param {string} text
 * @param {Record<string, any>} params
 * @param {object[]} [spec]
 */
export function judgeTeachingInjection(text, params, spec = []) {
	const want = teachingDirectives(params, spec)
	const missing = want.filter((d) => !String(text || '').includes(d))
	return [{
		id: 'injection',
		ok: missing.length === 0 && want.length > 0,
		detail: missing.length ? `注入缺 ${missing.length} 条指令：${missing[0].slice(0, 30)}…` : `注入齐全（${want.length} 条指令）`,
	}]
}

/**
 * **内容侧**判据：只判圆圈**声明过** `judge` 的可调项。
 * 没声明的项不判（`ok:null` + 写明）；声明了但插件里没实现 → 也 `ok:null`（**不假装判过**）。
 * @param {string} html 生成的课（或源文件）
 * @param {Record<string, any>} params
 * @param {object[]} [spec]
 */
export function judgeTeachingContent(html, params, spec = []) {
	const out = []
	for (const item of spec || []) {
		const judgeName = item.judge
		if (!judgeName) continue
		const impl = JUDGES[judgeName]
		const value = params?.[item.id]
		if (!impl) {
			out.push({ id: item.id, ok: null, detail: `圆圈声明了判据「${judgeName}」，但插件里没有实现 —— 不假装判过` })
			continue
		}
		const r = impl(String(html || ''), item, value)
		out.push({ id: item.id, ok: r.ok, detail: r.detail })
	}
	return out
}

/**
 * 汇总：内容侧 + 注入侧。`ok` 只看**判得了**的那些（`ok === null` 如实列在 `unjudged` 里）。
 * @param {{html?: string, injection?: string, params?: object, spec?: object[], data?: object, circle?: string}} o
 */
export function judgeTeaching(o = {}) {
	let params = o.params
	let spec = o.spec || []
	if (!params && o.data) {
		const r = resolveFor(o.data, o.circle || '*')
		params = r.params
		spec = r.spec
	}
	params = params || {}
	const checks = [
		...(o.injection === undefined ? [] : judgeTeachingInjection(o.injection, params, spec)),
		...(o.html === undefined ? [] : judgeTeachingContent(o.html, params, spec)),
	]
	const unjudged = checks.filter((c) => c.ok === null).map((c) => c.id)
	const failed = checks.filter((c) => c.ok === false)
	return { ok: failed.length === 0, checks, unjudged, failed: failed.map((c) => c.id) }
}
