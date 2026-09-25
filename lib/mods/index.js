/**
 * lib/mods/index.js — 本插件的**模块表**（唯一的能力清单）
 * ------------------------------------------------------------------
 * 为什么自己立一张（而不靠 dsh-plugin-kit 的那套）：那套是**工具箱自己的架构**，
 * 模板生成出来的插件没有它。我们照它的形状自己实现 30 行，换来两件事：
 *   1) **加一个能力 = 放一个模块文件 + 加一行表项**（不用动 lib/index.js）；
 *   2) kit 的 M1/M2 检查（模块表可装载 / 开关与文件一致）从此会真的跑起来。
 *
 * 模块契约（与 kit 的 CONVENTIONS 对齐，字段名照抄）：
 *   export const plugin = {
 *     id: 'lessonpack',                  // 必须逐字等于下面 enabled 里的项
 *     version: '0.1.0',
 *     tools: ['whale_xxx'],              // 本模块注册的工具名（契约名，撞名要在装载前拦下）
 *     install(hctx),                     // 至少 install / boot 之一
 *   }
 * 硬约束：**模块之间不许互相 import** —— 共享逻辑放 `lib/*.js`（普通文件）。
 */

import { plugin as lessonpack } from './lessonpack.js'
import { plugin as build } from './build.js'
import { plugin as probe } from './probe.js'
import { plugin as audit } from './audit.js'
import { plugin as style } from './style.js'
import { plugin as mode } from './mode.js'
import { plugin as intake } from './intake.js'
import { plugin as goal } from './goal.js'
import { plugin as teaching } from './teaching.js'
import { plugin as plan } from './plan.js'
import { plugin as author } from './author.js'
import { plugin as state } from './state.js'
import { plugin as ask } from './ask.js'
import { plugin as glossary } from './glossary.js'
import { plugin as brief } from './brief.js'
import { plugin as visual } from './visual.js'
import { plugin as practice } from './practice.js'
import { plugin as note } from './note.js'
import { plugin as evidence } from './evidence.js'
import { plugin as status } from './status.js'
import { plugin as starter } from './starter.js'
import { plugin as catalog } from './catalog.js'
import { plugin as create } from './create.js'
import { plugin as pack } from './pack.js'

/** 已写好的模块（`enabled` 决定谁真的装载） */
export const mods = [
	lessonpack,
	build,
	probe,
	audit,
	style,
	mode,
	intake,
	goal,
	teaching,
	plan,
	author,
	state,
	ask,
	glossary,
	brief,
	visual,
	practice,
	note,
	evidence,
	status,
	starter,
	catalog,
	create,
	pack,
]

/** 模块表：声明 + 开关 */
export const manifest = {
	/** 真正会装载的模块 id（顺序即装载顺序）；不在表里的模块只是"放着" */
	mods: {
		enabled: ['lessonpack', 'build', 'probe', 'audit', 'style', 'mode', 'intake', 'goal', 'teaching', 'plan', 'author', 'state', 'ask', 'glossary', 'brief', 'visual', 'practice', 'note', 'evidence', 'status', 'starter', 'catalog', 'create', 'pack'],
	},
}

/**
 * 已装载模块清单（唯一真源）。
 * status.js 的「已装载模块」行与 whale_ping 都调用这个函数，不许抄两遍列表。
 * @returns {string[]} 已启用模块的 id 数组
 */
export function enabledModules() {
	return [...manifest.mods.enabled]
}

/**
 * 按开关挑出要装载的模块，并把契约错误在**装载前**拦下（不静默跳过 ✗）。
 * @param {{log?: {warn?: Function, error?: Function}}} io
 */
export function selectMods(io = {}) {
	const enabled = new Set(manifest.mods.enabled)
	const picked = []
	const problems = []

	// 只声明不启用 = 放着备用（合法），不算错
	for (const m of mods) {
		if (enabled.has(m.id)) picked.push(m)
	}
	// 启用了但没声明 = 装配不上（必须红）
	for (const id of enabled) {
		if (!mods.some((m) => m.id === id)) problems.push(`enabled 里的 "${id}" 没有对应模块文件`)
	}
	// 契约自查
	const seenTools = new Map()
	for (const m of picked) {
		if (!m.id || !/^[a-z][A-Za-z0-9_]*$/.test(m.id)) problems.push(`模块 id 不合法：${JSON.stringify(m.id)}`)
		if (typeof m.install !== 'function' && typeof m.boot !== 'function') problems.push(`模块 ${m.id} 既没有 install 也没有 boot`)
		for (const t of m.tools ?? []) {
			if (seenTools.has(t)) problems.push(`工具名撞车：${t}（${seenTools.get(t)} 与 ${m.id}）`)
			seenTools.set(t, m.id)
			if (!/^whale_[a-z0-9_]+$/.test(t)) problems.push(`工具名不符合本插件约定（whale_ 前缀）：${t}`)
		}
	}
	for (const p of problems) io.log?.error?.(`[module] ${p}`)
	return { mods: picked, problems }
}
