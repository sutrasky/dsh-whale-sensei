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
import { plugin as preset } from './preset.js'

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
	preset,
]

/** 模块表：声明 + 开关 */
export const manifest = {
	/** 真正会装载的模块 id（顺序即装载顺序）；不在表里的模块只是"放着" */
	mods: {
		enabled: ['lessonpack', 'build', 'probe', 'audit', 'style', 'mode', 'intake', 'goal', 'teaching', 'plan', 'author', 'state', 'ask', 'glossary', 'brief', 'visual', 'practice', 'note', 'evidence', 'status', 'starter', 'catalog', 'create', 'pack', 'preset'],
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

/** 模块 id 的合法形状（enabled 里逐字比的就是它） */
const ID_RE = /^[a-z][A-Za-z0-9_]*$/
/** 本插件的工具名约定（`whale_` 前缀 + 小写下划线） */
const TOOL_RE = /^whale_[a-z0-9_]+$/

/**
 * 按开关挑出要装载的模块，并把契约错误在**装载前**拦下（不静默跳过 ✗）。
 *
 * 返回 `{ok, mods, problems}`：
 *   · `ok` = `problems.length === 0`（**唯一的放行条件**；apply 只看它）
 *   · `mods` = 启用且已声明的模块对象（顺序即装载顺序）
 *   · `problems` = 字符串数组（文案只增不改：既有那些句子逐字保留）
 *
 * 另附 `moduleProblems`（逐模块的失败归因，`[{id, problem}]`）——**给 apply 的装载事务用**：
 * 计划被拒时它决定 `hctx.mods` 里哪几条标 `failed`（其余未开始的保持 `planned`）。
 * 它不进对外判据面（判据面就是上面那三个字段）。
 *
 * @param {{log?: {warn?: Function, error?: Function}}} io
 * @returns {{ok:boolean, mods:object[], problems:string[], moduleProblems:{id:string,problem:string}[]}}
 */
export function selectMods(io = {}) {
	const enabled = new Set(manifest.mods.enabled)
	const picked = []
	const problems = []
	/** @type {{id:string, problem:string}[]} */
	const moduleProblems = []

	/** 记一条问题，并把它归到某个模块头上（同一模块多条就并成一条 reason） */
	const reject = (id, problem) => {
		problems.push(problem)
		const hit = moduleProblems.find((x) => x.id === id)
		if (hit) hit.problem = `${hit.problem}；${problem}`
		else moduleProblems.push({ id, problem })
	}

	// 只声明不启用 = 放着备用（合法），不算错
	for (const m of mods) {
		if (enabled.has(m.id)) picked.push(m)
	}
	// 启用了但没声明 = 装配不上（必须红）。这一条没有对应模块条目，只进 problems。
	for (const id of enabled) {
		if (!mods.some((m) => m.id === id)) problems.push(`enabled 里的 "${id}" 没有对应模块文件`)
	}
	// 契约自查（先于任何安装动作：装配不上的计划不许装一半）
	const seenIds = new Set()
	const seenTools = new Map()
	for (const m of picked) {
		if (!m.id || !ID_RE.test(m.id)) reject(m.id, `模块 id 不合法：${JSON.stringify(m.id)}`)
		if (seenIds.has(m.id)) reject(m.id, `模块 id 撞车：${JSON.stringify(m.id)} 在装载表里出现了不止一次`)
		seenIds.add(m.id)
		if (typeof m.version !== 'string' || m.version.trim() === '') {
			reject(m.id, `模块 ${m.id} 的 version 不是非空字符串：${JSON.stringify(m.version)}`)
		}
		if (typeof m.install !== 'function' && typeof m.boot !== 'function') {
			reject(m.id, `模块 ${m.id} 既没有 install 也没有 boot`)
		}
		if (m.tools !== undefined && !Array.isArray(m.tools)) {
			reject(m.id, `模块 ${m.id} 的 tools 必须是数组：${JSON.stringify(m.tools)}`)
			continue
		}
		for (const t of m.tools ?? []) {
			if (seenTools.has(t)) {
				// 撞车是**双方**的契约问题：两个模块不可能一起装上，两边都算不合格
				reject(m.id, `工具名撞车：${t}（${seenTools.get(t)} 与 ${m.id}）`)
				reject(seenTools.get(t), `工具名撞车：${t}（${seenTools.get(t)} 与 ${m.id}）`)
			}
			seenTools.set(t, m.id)
			if (!TOOL_RE.test(t)) reject(m.id, `工具名不符合本插件约定（whale_ 前缀）：${t}`)
		}
	}
	for (const p of problems) io.log?.error?.(`[module] ${p}`)
	return { ok: problems.length === 0, mods: picked, problems, moduleProblems }
}
