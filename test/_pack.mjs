/**
 * _pack.mjs —— **测试输入的唯一定源**（T02 / 报告 F02）
 * ==================================================================
 * F02 的原话：「包根跨进程丢失、活包耦合」——
 *   「`all <B>` 的 gate 用 B，但插件子套件丢失 B，可能用 env 里的 A 或作者兄弟 study；
 *     无效显式根还会静默兜底。」
 *
 * 所以本文件只做两件事，而且都只有**一份**实现：
 *
 *   ① `resolveTestContext({argv,env})` —— **只由顶层解析一次**：
 *        参数（`--pack=<绝对路径>` / `--mode=<fixture|real>`）→ 环境变量 `DSH_WHALE_PACK` /
 *        `DSH_WHALE_MODE`。**参数优先于 env**；**显式给了无效路径直接失败**（绝不静默兜底）。
 *        解析结果 `{mode, packRoot, base}` 由顶层**显式传给每一个子进程**（argv 与环境变量都带）。
 *
 *   ② `packRoot(cliArg)` —— 单个套件拿包根。它**不再有第三兜底**
 *        （原 `path.join(PLUGIN,'..','study')` 已删：换台机器必然不存在，
 *          且会把"作者那台机器的目录布局"变成单测的隐含前提）。
 *
 * ⚠️ 本文件**不许**再出现任何"猜兄弟仓"的路径（`study` / `dsh-raw-html-v2-master` 之类）。
 *    那正是 F02 要切断的耦合。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN = path.resolve(HERE, '..')

/** 两种模式：`fixture` = 合成夹具（自包含）；`real` = 真实课程包（opt-in 集成）。 */
export const MODES = ['fixture', 'real']

/** 一个目录像不像课程包：有 `presets/whale-sensei.css` 才算。 */
export function looksLikePack(dir) {
	return !!dir && fs.existsSync(path.join(dir, 'presets', 'whale-sensei.css'))
}

/** 解析 `--pack=<v>` / `--mode=<v>` 这种显式参数；返回 undefined 表示**没给**。 */
function flagValue(argv, name) {
	const eq = `--${name}=`
	for (let i = 0; i < argv.length; i++) {
		const a = String(argv[i] ?? '')
		if (a.startsWith(eq)) return a.slice(eq.length)
		if (a === `--${name}` && i + 1 < argv.length) return String(argv[i + 1])
	}
	return undefined
}

/** 位置参数（不以 `--` 开头、且不是某个 flag 的值）—— 只认第一个当包根（旧用法兼容）。 */
function positional(argv) {
	for (let i = 0; i < argv.length; i++) {
		const a = String(argv[i] ?? '')
		if (a.startsWith('--')) { if (!a.includes('=')) i++; continue }
		return a
	}
	return undefined
}

const errMsg = (e) => String((e && e.message) || e).split('\n')[0]

/**
 * **测试输入的唯一定源**。只由顶层（`test/all.mjs` / `test/run-all.mjs` / `test/integration.mjs`）
 * 调一次；子进程只读结果，不再自己解析。
 *
 * @param {{argv?:string[], env?:object}} spec
 * @returns {{mode:'fixture'|'real', packRoot:string|null, base:string, source:object}}
 *   `packRoot` 为 `null` 只可能出现在 `fixture` 模式且没显式给包根时
 *   （顶层应当用 `test/_fixture.mjs` 造一个再把它传下去）。
 * @throws 显式给了无效路径 / 无效 mode 时**直接抛错**（绝不静默兜底）
 */
export function resolveTestContext(spec = {}) {
	const argv = Array.isArray(spec.argv) ? spec.argv : process.argv.slice(2)
	const env = spec.env ?? process.env
	const source = { pack: 'none', mode: 'none' }

	// —— ① 包根：参数优先于 env；**显式无效直接失败** ——
	const argPack = flagValue(argv, 'pack')
	const posPack = positional(argv)
	const explicitPack = argPack !== undefined ? argPack : posPack
	const envPack = String(env?.DSH_WHALE_PACK ?? '')
	let packRoot = null
	if (explicitPack !== undefined && String(explicitPack).trim()) {
		const abs = path.resolve(String(explicitPack).trim())
		if (!looksLikePack(abs)) {
			throw new Error(
				`显式指定的课程包无效：${abs}\n`
				+ '  判据：目录下要有 presets/whale-sensei.css。\n'
				+ '  **显式路径无效时不再兜底**（F02：静默兜底会把"用了哪个包"藏起来）—— 请给一个真的课程包。'
			)
		}
		packRoot = abs
		source.pack = argPack !== undefined ? 'argv:--pack' : 'argv:positional'
	} else if (envPack.trim()) {
		const abs = path.resolve(envPack.trim())
		if (!looksLikePack(abs)) {
			throw new Error(
				`环境变量 DSH_WHALE_PACK 指向的不是课程包：${abs}\n`
				+ '  判据：目录下要有 presets/whale-sensei.css。显式配置无效时不再兜底。'
			)
		}
		packRoot = abs
		source.pack = 'env:DSH_WHALE_PACK'
	}

	// —— ② 模式：参数优先于 env；默认按"有没有包根"判 ——
	const argMode = flagValue(argv, 'mode')
	const envMode = String(env?.DSH_WHALE_MODE ?? '').trim()
	let mode = null
	if (argMode !== undefined && String(argMode).trim()) {
		mode = String(argMode).trim()
		source.mode = 'argv:--mode'
	} else if (envMode) {
		mode = envMode
		source.mode = 'env:DSH_WHALE_MODE'
	} else {
		mode = packRoot ? 'real' : 'fixture'
		source.mode = 'derived'
	}
	if (!MODES.includes(mode)) {
		throw new Error(`无效的测试模式 ${JSON.stringify(mode)}：只能是 ${MODES.join(' / ')}`)
	}
	if (mode === 'real' && !packRoot) {
		throw new Error('模式是 real，但没有课程包根（给 --pack=<绝对路径> 或 DSH_WHALE_PACK=<绝对路径>）')
	}
	return { mode, packRoot, base: 'test', source }
}

/**
 * **不抛错**的包根解析（只回答"解析出来是什么"，不做失败处理）。
 *
 * 顺序与 `resolveTestContext` 完全一致：**参数优先于 env**。
 * 为什么要有它：`testContext()`（自报那一行）必须与 `packRoot()`（套件真正用的那个）
 * **同一条解析线** —— 否则就会出现 F02 那种"账上写 A、实际用 B"：
 * 子进程明明拿到了 `--pack=B`，自报却读 env 里的 A，于是"参数传没传到"根本判不出来。
 *
 * @returns {{root:string|null, source:string, explicit:string|undefined, invalid:boolean}}
 */
function resolvePackRootRaw() {
	const argv = process.argv.slice(2)
	const explicit = flagValue(argv, 'pack') ?? positional(argv)
	if (explicit !== undefined && String(explicit).trim()) {
		const abs = path.resolve(String(explicit).trim())
		return { root: looksLikePack(abs) ? abs : null, source: 'argv', explicit: abs, invalid: !looksLikePack(abs) }
	}
	const envPack = String(process.env.DSH_WHALE_PACK ?? '').trim()
	if (envPack) {
		const abs = path.resolve(envPack)
		return { root: looksLikePack(abs) ? abs : null, source: 'env', explicit: undefined, invalid: !looksLikePack(abs) }
	}
	return { root: null, source: 'none', explicit: undefined, invalid: false }
}

/**
 * 单个套件拿课程包根。**没有第三兜底**（F02）。
 *
 * 顺序：显式参数 → 环境变量 `DSH_WHALE_PACK`。两者都没有就**大声报错**。
 * **显式给了无效路径直接失败**（不静默回落到 env —— 那会把"用了哪个包"藏起来）。
 *
 * @param {string} [cliArg] 显式包根；不给时看 `--pack=` / 位置参数 / 环境变量
 * @returns {string} 课程包根（绝对路径）
 */
export function packRoot(cliArg) {
	if (cliArg !== undefined && String(cliArg).trim()) {
		const abs = path.resolve(String(cliArg).trim())
		if (looksLikePack(abs)) return abs
		throw new Error(
			`显式指定的课程包无效：${abs}\n`
			+ '  判据：目录下要有 presets/whale-sensei.css。\n'
			+ '  **显式路径无效时不再兜底**（F02：静默兜底会把"用了哪个包"藏起来）。'
		)
	}
	const r = resolvePackRootRaw()
	if (r.root) return r.root
	if (r.invalid) {
		throw new Error(
			`${r.source === 'env' ? '环境变量 DSH_WHALE_PACK 指向的不是课程包' : '显式指定的课程包无效'}：${r.explicit}\n`
			+ '  判据：目录下要有 presets/whale-sensei.css。显式配置无效时不再兜底。'
		)
	}
	throw new Error(
		'找不到课程包（判据：目录下有 presets/whale-sensei.css）。\n'
		+ '  试过：' + (r.explicit ? `argv[${JSON.stringify(r.explicit)}]；` : '')
		+ 'env DSH_WHALE_PACK=' + JSON.stringify(process.env.DSH_WHALE_PACK ?? null) + '\n'
		+ '  用法：node test/<套件>.mjs --pack=<课程包根>   或   DSH_WHALE_PACK=<课程包根> node test/<套件>.mjs\n'
		+ '  （单测请用合成夹具：test/_fixture.mjs 的 createFixture()，别去猜兄弟仓）'
	)
}

/**
 * 当前套件生效的测试上下文 —— **与 `packRoot()` 同一条解析线**（参数优先于 env）。
 * 只读，不解析新东西、不抛错（自报那一行不能因为环境坏掉就把整个套件搞崩）。
 */
export function testContext() {
	const r = resolvePackRootRaw()
	const envMode = String(process.env.DSH_WHALE_MODE ?? '').trim()
	const mode = MODES.includes(envMode) ? envMode : (r.root ? 'real' : 'fixture')
	return { mode, packRoot: r.root, source: r.source }
}

/**
 * 一行**机器可读**的测试上下文 —— 给「参数到底传没传到子进程」当判据用。
 * 顶层与子进程都打这一行；T02 的专项验收就按它逐进程对账。
 * 格式固定（改它就是改判据面）：`[test-context] mode=<m> pack=<绝对路径|none>`
 */
export function formatTestContext(ctx = testContext()) {
	return `[test-context] mode=${ctx.mode} pack=${ctx.packRoot ?? 'none'}`
}

/** 打那一行（各套件在自己开头调一次；run-all 据此逐进程对账） */
export function reportTestContext() {
	const line = formatTestContext()
	process.stdout.write(line + '\n')
	return line
}

/** 顶层把一个上下文变成**传给子进程**的 argv 尾巴（绝对包根 + 模式，两者都显式）。 */
export function contextArgs(ctx) {
	const out = []
	if (ctx?.packRoot) out.push(`--pack=${path.resolve(ctx.packRoot)}`)
	if (ctx?.mode) out.push(`--mode=${ctx.mode}`)
	return out
}

/** 顶层把一个上下文变成**传给子进程**的环境变量（argv 已经显式带了；env 只作兜底一致性）。 */
export function contextEnv(ctx) {
	const env = {}
	if (ctx?.packRoot) env.DSH_WHALE_PACK = path.resolve(ctx.packRoot)
	else env.DSH_WHALE_PACK = ''
	if (ctx?.mode) env.DSH_WHALE_MODE = ctx.mode
	return env
}

/** 从一段子进程输出里抽出 `[test-context]` 那一行（run-all 逐进程对账用）。返回 null 表示没打。 */
export function parseTestContextLine(out) {
	const all = [...String(out ?? '').matchAll(/^\[test-context\] mode=(\S+) pack=(\S+)$/gm)]
	if (!all.length) return null
	const m = all[all.length - 1]
	return { mode: m[1], packRoot: m[2] === 'none' ? null : m[2], lines: all.length }
}

/** 判断一个显式包根是不是本机存在的课程包（给审计脚本做"无效路径"用例用，纯函数）。 */
export function isUsablePack(p) {
	try { return looksLikePack(path.resolve(String(p ?? ''))) } catch { return false }
}

/** 供错误信息与审计引用：本文件不再有的兜底（**结构性证据**：这两条不许回来）。 */
export const FORBIDDEN_FALLBACKS = ['study', 'dsh-raw-html-v2-master']

export { errMsg }

// ------------------------------------------------------------------ 自动上报（T02 / F02）
/** `[test-context]` 那一行的固定格式（判据面；改它就是改验收面） */
export const CONTEXT_LINE_RE = /^\[test-context\] mode=(\S+) pack=(\S+)$/

/**
 * **每个 import 本文件的进程都自报一次测试上下文** —— 这是「参数传到每个子进程」的判据落点。
 *
 * 为什么放在 import 时，而不是让 50 个套件各写一行：漏一个套件就漏一个判据面。
 * 放在这里，**凡是用 `_pack.mjs` 定源的进程都会报**；没报的（不 import 本文件的套件）
 * 由 `run-all.mjs` 记进 `ctxDrift` 单列 —— 缺一不可，绝不当成通过。
 *
 * 打 **stderr**：stdout 是套件的摘要协议（`=== N 通过 / M 失败 ===`），别去污染它。
 * 格式固定：`[test-context] mode=<fixture|real> pack=<绝对路径|none>`
 */
if (!process.env.DSH_WHALE_NO_CONTEXT_LINE) {
	process.stderr.write(formatTestContext(testContext()) + '\n')
}
