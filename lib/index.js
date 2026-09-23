/**
 * dsh-whale-sensei —— 宿主半边（Node 侧）。
 *
 * 这份骨架已经把你**必须做对、但很容易漏**的几件事安排好了次序：
 *
 * ```
 *   1) 定配置与路径（路径只从一处来）
 *   2) 注册能力（工具 / 命令 / 路由）—— 每个注册都 track 收 disposer
 *   3) 自愈与对账（上一轮的中间态要不要清）
 *   4) 报状态（日志 / 健康度），最后再做
 * ```
 *
 * 次序是刻意的（来自 dsh-baode 的实测经验）：**先注册、后自愈、最后报状态**。
 *
 * # 硬规则
 *
 * | 规则 | 违反后的症状 |
 * |---|---|
 * | `name` 逐字等于 `cordis.patch.yml` 的行 id | 插件**静默不生效** |
 * | `inject` 只写**硬依赖** | 缺该服务的装配里整个插件不激活（不是"少个功能"） |
 * | 软依赖用 `ctx.inject([...], cb)` 现取 | 同上；写成硬依赖等于自断 |
 * | 每个注册都收 disposer | 重载后重复注册、监听器泄漏 |
 * | 不自己拼路径 | 写去了 A、读的是 B（看似功能没做） |
 *
 * @module dsh-whale-sensei
 */

import path from 'node:path'
import os from 'node:os'
import { selectMods, enabledModules } from './mods/index.js'

/** 插件稳定名 —— **必须逐字等于 `cordis.patch.yml` 的行 id**。 */
export const name = 'whale-sensei'

/** 硬依赖。只写"没有它这个插件根本做不了事"的服务。 */
export const inject = ['tools']

/** 配置缺省值；patch 的 config 块可覆盖。 */
export const DEFAULT_CONFIG = {
	/** 数据目录（默认 `$DSH_HOME/.dsh-whale-sensei`）。 */
	dataDir: undefined,
	/** 课程包根目录（本地那份 `study/`）。**不给就明确报错，绝不猜路径**。 */
	packRoot: undefined,
	/**
	 * 外部风格库目录（`_INDEX.md` + `<slug>.md` 所在处）。
	 * **这是可选的**：不给就只在包内 `styles/` 找；找不到只降级、不报错。
	 * 换台机器要接自己的风格库时配这一项（或设 `DSH_RAW_HTML_STYLES`），**不要去改代码**。
	 */
	stylesDir: undefined,
	/** 装载期是否往宿主标准输出打一行（排障看 dsh-web.log）。 */
	announceOnBoot: true,
	/**
	 * **学生工作区目录**（相对课程包根，默认 `code`）。
	 *
	 * 为什么要有这一项：`code/` 只是个**惯例**，不是契约。把作品放在别处
	 * （例如 `math/`）时，探针、`pack-model` 的 EXPECT 扫描、包侧 `lesson-map`
	 * 必须认**同一个值** —— 否则会出现"点亮修好了、挑战判据却瞎着"的半瘫状态。
	 */
	codeDir: undefined,
}

/**
 * 数据目录 —— **唯一算路径的地方**。
 *
 * 拿不到 `$DSH_HOME` 就退回 `~/.dsh`；**绝不静默退回当前工作目录**（那会把数据写进包里）。
 */
export function createPaths(opts = {}) {
	const home =
		opts.env?.DSH_HOME ??
		(typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
			? process.env.DSH_HOME.trim()
			: path.join(os.homedir(), '.dsh'))
	const root = opts.dataDir ? path.resolve(opts.dataDir) : path.join(home, '.dsh-whale-sensei')
	return { root, state: path.join(root, 'state') }
}

/**
 * 课程包根 —— **唯一算它的地方**。
 *
 * 顺序：显式配置 → 环境变量 `DSH_WHALE_PACK` → `undefined`（交给各工具明确报错）。
 * **绝不退回「包旁边那个文件夹」**：那种写法只在作者本机的目录布局下成立，
 * 别人拿到插件后它会指向一个不存在的路径，而且失败得**很安静**。
 *
 * @param {string|undefined} explicit 配置里的 `packRoot`
 * @param {object} [env] 便于测试注入；默认 `process.env`
 * @returns {string|undefined} 绝对路径，或 undefined（=没配）
 */
export function resolvePackRoot(explicit, env = process.env) {
	const v = explicit ?? env?.DSH_WHALE_PACK
	return v && String(v).trim() ? path.resolve(String(v).trim()) : undefined
}

/**
 * 学生工作区目录 —— **唯一算它的地方**。
 *
 * 顺序：显式配置 → 环境变量 `DSH_WHALE_CODE` → `'code'`。
 * 归一成**相对包根**的 POSIX 写法（进 `state.json` 的 `codeDir` 字段，包侧就按它判）；
 * 显式给了绝对路径就原样保留（`state-scan` 认绝对路径）。
 *
 * @param {string|undefined} explicit 配置里的 `codeDir`
 * @param {object} [env] 便于测试注入；默认 `process.env`
 * @returns {string} 相对路径（POSIX、无首尾斜杠）或绝对路径
 */
export function resolveCodeDir(explicit, env = process.env) {
	const v = explicit ?? env?.DSH_WHALE_CODE
	const s = v === undefined || v === null ? '' : String(v).trim()
	if (!s) return 'code'
	if (path.isAbsolute(s)) return path.normalize(s)
	const rel = s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
	return rel || 'code'
}

/**
 * 插件入口。
 *
 * @param {object} ctx 宿主上下文（cordis）
 * @param {object} [config] 来自 patch 的 config
 * @returns {() => void} 卸载函数
 */
export function apply(ctx, config = {}) {
	const disposers = []
	const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }

	const log = (level, message) => {
		try {
			ctx.logger?.[level]?.(`[dsh-whale-sensei] ${message}`)
		} catch {
			/* 打不出来不影响功能 */
		}
	}
	const track = (d) => {
		if (typeof d === 'function') disposers.push(d)
		return d
	}

	// —— 1) 路径
	let paths
	try {
		paths = createPaths({ dataDir: cfg.dataDir })
	} catch (e) {
		log('error', `数据目录无法定位：${e?.message ?? e}`)
	}

	// —— 2) 模块表：**能力全在 lib/mods/，这里只负责装载** ——
	// 加一个能力 = 在 lib/mods/ 放一个模块文件 + 把它的 id 写进 lib/mods/index.js 的 enabled。
	// 模块契约见 lib/mods/index.js 顶部（与 dsh-plugin-kit 的 CONVENTIONS 对齐）。
	const hctx = {
		paths: {
			...paths,
			// 课程包根：配置 → 环境变量 `DSH_WHALE_PACK` → 都没给就 undefined
			// （工具会明确报错，**不猜 cwd、不猜兄弟目录**）
			packRoot: resolvePackRoot(cfg.packRoot),
			// 外部风格库：只认显式配置（`DSH_RAW_HTML_STYLES` 由 lib/style.js 兜底）；
			// **不猜「课程包旁边那个兄弟风格仓」** —— 那是某台机器的目录布局。
			stylesDir: cfg.stylesDir ? path.resolve(cfg.stylesDir) : undefined,
			// 学生工作区目录：配置 → 环境变量 `DSH_WHALE_CODE` → `'code'`。
			// 三个带 `codeDir` 参数的探针工具（state / practice / brief）默认取它。
			codeDir: resolveCodeDir(cfg.codeDir),
		},
		log: {
			info: (m) => log('info', m),
			warn: (m) => log('warn', m),
			error: (m) => log('error', m),
		},
		registerTool: (def) => track(ctx.tools.register(def)),
		// 软依赖现取（宿主注释里的规矩：软依赖用 ctx.inject 现取，写成硬依赖等于自断）。
		// 模块拿它来挂自己的 /api 路由（例如 ask 模块要 connection 服务）。
		inject: (names, cb) => {
			if (typeof ctx.inject !== 'function') {
				log('warn', `宿主没有 ctx.inject —— 需要 ${names.join('、')} 的能力无法挂载`)
				return
			}
			ctx.inject(names, cb)
		},
	}
	{
		const plan = selectMods({ log: hctx.log })
		if (plan.problems.length) log('error', `模块表有 ${plan.problems.length} 个问题 —— 见上面各行`)
		for (const m of plan.mods) {
			try {
				m.install?.(hctx)
				m.boot?.(hctx)
			} catch (e) {
				log('error', `模块 ${m.id} 装载失败：${e?.message ?? e}`)
			}
		}
		log('info', `装载模块：${plan.mods.map((m) => m.id).join('、') || '（无）'}`)
	}

	// —— 3) 存活探针：`whale_ping`（M1 的验收靠它证明"工具真的注册上了"；真工具齐了可以删）
	// 注意：**不要**再随手加工具到这里 —— 新能力一律走 lib/mods/。
	//
	// **工具定义四项必填**：name / description / parameters / output / execute
	//   · parameters 是入参 JSON Schema；
	//   · **output 必填**（`{ schema, render }`）：漏了它宿主会拒绝注册这个工具，
	//     报 `tool "<名>" must declare output { schema, render, presentationMeta? }`
	//     —— 插件照常起来、别的都正常，只是这个工具不存在（本仓库真栽过）。
	//   · 返回值必须是**无损 JSON**；可选字段 timeoutMs / isConcurrencySafe / presentCall / presentResult。
	track(
		ctx.tools.register({
			name: 'whale_ping',
			description: '骨架自带的空工具：回显入参。换成真实现或整个删掉。',
			parameters: {
				type: 'object',
				properties: { text: { type: 'string', description: '要回显的文字' } },
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, value) => [{ type: 'text', text: `echo=${value?.echo ?? ''}\n${value?._info ?? ''}` }],
			},
			async execute(args) {
				const mods = enabledModules()
				return { ok: true, echo: String(args?.text ?? ''), dataDir: paths?.root, _info: `已装载 ${mods.length} 个模块：${mods.join(', ')}` }
			},
		}),
	)

	// —— 3) 自愈：读上一轮留下的中间态、判断要不要清（这里留白）
	// —— 4) 报状态
	if (cfg.announceOnBoot) log('info', `装载完成（数据目录 ${paths?.root ?? '未定'}）`)

	// —— 5) 清理
	const cleanup = () => {
		for (const d of disposers.splice(0).reverse()) {
			try {
				d()
			} catch {
				/* 卸载期的异常不再外抛 */
			}
		}
	}
	if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
	else {
		try {
			ctx.on?.('dispose', cleanup)
		} catch {
			/* 两个都没有：交给 loader */
		}
	}
	return cleanup
}

export default { name, apply, inject, DEFAULT_CONFIG }
