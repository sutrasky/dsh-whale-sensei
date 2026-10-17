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
import { createResourceScope } from './resource-scope.js'
import { cancelAllRebuilds } from './rebuild-job.js'
import { selectMods, enabledModules } from './mods/index.js'
import { resolveDshHome, presetDirFor } from './preset-install.js'

/** 插件稳定名 —— **必须逐字等于 `cordis.patch.yml` 的行 id**。 */
export const name = 'whale-sensei'

/** `output` / `parameters` 这类字段要的是"普通对象"，数组与 null 都不算 */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 工具定义的五项必填自查（T14：**在真注册之前**拦下，宁可整批失败，不要半注册）。
 *
 * 为什么放在这里而不是靠宿主：宿主拒绝注册时只留一行日志，插件照常起来、别的都正常，
 * 只有这个工具**不存在**（本仓库真栽过：漏 `output` ⇒ `tool "x" must declare output …`）。
 * 插件自己先查，就能把"这个模块装失败了"变成**可观测**的失败状态。
 *
 * @returns {string|null} 不合格的原因；合格返回 null
 */
function toolDefProblem(def) {
	if (!isObject(def)) return '定义必须是对象'
	if (typeof def.name !== 'string' || def.name.trim() === '') return 'name 必须是非空字符串'
	if (typeof def.description !== 'string' || def.description.trim() === '') return 'description 必须是非空字符串'
	if (!isObject(def.parameters)) return 'parameters 必须是对象（入参 JSON Schema）'
	if (!isObject(def.output)) return 'output 必须是对象（漏了它宿主会拒绝注册）'
	if (typeof def.output.render !== 'function') return 'output.render 必须是函数'
	if (typeof def.execute !== 'function') return 'execute 必须是函数'
	return null
}

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
	/**
	 * 启动期要不要**自动装「鲸师模式」预设**（默认要）。
	 *
	 * 关掉它 = 这台机器上不写 `<DSH_HOME>/.agent-presets/whale-mode/`。
	 * 默认开着的理由见 `lib/mods/preset.js` 顶部：预设以前只由安装脚本落盘，
	 * 结果"别人装的机器上没有预设"（npm 包里没带模板 / 1c 静默 SKIP / 文档没提）。
	 */
	installPreset: true,
	/**
	 * 预设落盘目录（默认 `<DSH_HOME>/.agent-presets/whale-mode`）。
	 * 只有在 DSH_HOME 与宿主认定的不是同一个时才需要配 —— 一般**不要配**。
	 */
	presetDir: undefined,
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
	return { home, root, state: path.join(root, 'state') }
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
	const scope = createResourceScope()
	const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }

	const log = (level, message) => {
		try {
			ctx.logger?.[level]?.(`[dsh-whale-sensei] ${message}`)
		} catch {
			/* 打不出来不影响功能 */
		}
	}
	const track = (d) => {
		if (typeof d === 'function') scope.add(d)
		return d
	}
	/** 本批 apply 已经注册过的工具名（撞名 = 整批失败，不静默覆盖） */
	const registeredTools = new Set()

	// —— 1.5) 重建作业**归本插件**（T16 / D07）：卸载时先撤作业，再**等进程树真的退出** ——
	//
	// 为什么挂在插件作用域上（而不是只靠各模块自己传 `hctx.scope`）：
	//   模块传 scope 是**每条作业**的接线；这一条是**整台插件**的底线 ——
	//   哪个模块忘了递、或者将来新加的入口没照做，"宿主卸载 = 不留残留进程"这条判据仍然成立。
	//   `scope.add` 的 disposer 若回 Promise，`resource-scope` 会 await 它（resource-scope.js:21-23），
	//   而 `cancelAllRebuilds` 正是"进程树确认消失（≤5s）之后才 resolve"的那个 Promise
	//   ⇒ 「卸载后子进程与作业均结束」不是喊一嗓子，是**等它结束**。
	// 幂等：同一个 scope 只会挂一条（lib/rebuild-job.js 里按 scope 记账），重复登记不出错。
	track(() => cancelAllRebuilds(scope))

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
	const observe = (s) => s.dispose().then(({ errors }) => {
		for (const e of errors) log('error', `资源清理失败：${e?.message ?? e}`)
		return { errors }
	})
	const hctx = {
		scope,
		/**
		 * **每次 apply 的真实装载状态**（顺序 = 装载顺序，初值 `planned`）：
		 * `{ id, state: 'planned'|'installed'|'failed', error? }`。
		 *
		 * 为什么要有它：`enabledModules()` 是**配置表**（"写着要装"），不是安装事实。
		 * 装失败 / 被整批回滚时，拿配置表冒充实装载 = 卡上显示"已装 25 个"而工具根本不在。
		 * 日志、status 卡、whale_ping 一律只认这个数组。
		 */
		mods: [],
		paths: {
			...paths,
			// DSH 根目录（`$DSH_HOME` → `~/.dsh`，与宿主同一套规则）——
			// 「鲸师模式」预设要落在它下面的 `.agent-presets/`（宿主扫的就是那一层）。
			dshHome: paths?.home ?? resolveDshHome(),
			// 预设目标目录：`installPreset: false` 时**不给**（模块据此判断"主人关掉了"）；
			// 默认 `<DSH_HOME>/.agent-presets/whale-mode`。
			presetDir: cfg.installPreset === false
				? undefined
				: cfg.presetDir
					? path.resolve(cfg.presetDir)
					: presetDirFor(paths?.home ?? resolveDshHome()),
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
		registerTool: (def) => {
			// T14：**先校验、后注册** —— 不合格就抛，让"这个模块装失败了"成为可观测状态；
			// 抛在注册之前 ⇒ 不留半注册（模块里先注册成功的那些由事务统一回收）。
			const problem = toolDefProblem(def)
			if (problem) throw new Error(`工具 ${isObject(def) ? JSON.stringify(def.name) : '（不是对象）'} 定义不合格：${problem}`)
			if (registeredTools.has(def.name)) throw new Error(`工具 ${def.name} 在同一批装载里注册了不止一次`)
			registeredTools.add(def.name)
			return track(ctx.tools.register(def))
		},
		// 软依赖现取（宿主注释里的规矩：软依赖用 ctx.inject 现取，写成硬依赖等于自断）。
		// 模块拿它来挂自己的 /api 路由（例如 ask 模块要 connection 服务）。
		inject: (names, cb) => {
			if (typeof ctx.inject !== 'function') {
				log('warn', `宿主没有 ctx.inject —— 需要 ${names.join('、')} 的能力无法挂载`)
				return
			}
			let current
			const handle = ctx.inject(names, (c) => {
				if (scope.disposed) return
				if (current) observe(current)
				const child = current = scope.child()
				const cleanup = () => observe(child)
				try {
					if (typeof c?.effect === 'function') c.effect(() => cleanup)
					else if (typeof c?.on === 'function') {
						const off = c.on('dispose', cleanup)
						if (typeof off === 'function') child.add(off)
					}
					const result = cb(c, child)
					if (typeof result === 'function') child.add(result)
					return cleanup
				} catch (e) {
					cleanup()
					throw e
				}
			})
			if (typeof handle === 'function') scope.add(handle)
			else if (typeof handle?.dispose === 'function') scope.add(() => handle.dispose())
			return handle
		},
	}
	// —— 2) 装载事务：**契约不合格 → 一个都不装；中途抛错 → 整批回滚** ——
	//
	// 旧行为（T14 之前的现场）：某个模块 install 抛错只记一行日志，后面的继续装，
	// 最后还打一行"装载模块：A、B、C…"把失败的也算进去 —— 卡上看着装齐了，工具却不在。
	// 现在：状态是**可观测**的（hctx.mods），失败即整批失败并回收已注册资源。
	let modulesOk = true
	{
		const plan = selectMods({ log: hctx.log })
		// 真实装载状态（顺序 = 装载顺序）；初值一律 planned
		hctx.mods = plan.mods.map((m) => ({ id: m.id, state: 'planned' }))
		// 契约不合格的那些模块：它们**没有也不会**被装，如实标 failed（其余未开始的保持 planned）
		const rejected = new Map((plan.moduleProblems ?? []).map((p) => [p.id, p.problem]))
		for (const s of hctx.mods) {
			if (rejected.has(s.id)) {
				s.state = 'failed'
				s.error = rejected.get(s.id)
			}
		}

		if (!plan.ok) {
			modulesOk = false
			log('error', `模块表有 ${plan.problems.length} 个问题 —— 整批拒绝装载（一个模块都不装）`)
			observe(scope) // 一个都没装也照样 dispose：事务要么整批成立、要么什么都不留
		} else {
			const byId = new Map(plan.mods.map((m) => [m.id, m]))
			for (const s of hctx.mods) {
				const m = byId.get(s.id)
				try {
					// 查不到条目说明内部不一致：**不许**当作"装好了"（那正是这张卡要消灭的假成功）
					if (!m) throw new Error(`装载表里找不到模块条目 ${String(s.id)}`)
					m.install?.(hctx)
					m.boot?.(hctx)
					s.state = 'installed'
				} catch (e) {
					s.state = 'failed'
					s.error = String(e?.message ?? e)
					modulesOk = false
					// **不再继续宣称成功**：后面的模块不装（保持 planned），已装的那些如实标出来 ——
					// "装过又被回收"**不许**继续写 installed（失败的回滚不写成成功）。
					for (const prev of hctx.mods) {
						if (prev.state !== 'installed') continue
						prev.state = 'failed'
						prev.error = `整批回滚：模块 ${s.id} 装载失败（已注册资源已回收）`
					}
					log('error', `模块 ${s.id} 装载失败：${s.error} —— 整批回滚，不再继续装后面的模块`)
					observe(scope) // 回收已注册资源（scope.dispose 幂等，只做一次）
					break
				}
			}
		}

		// 日志只报**真实状态**：只列 installed 的；失败的单独列出 id 与原因（绝不混进上面那行）
		const installed = hctx.mods.filter((m) => m.state === 'installed')
		const failed = hctx.mods.filter((m) => m.state === 'failed')
		const planned = hctx.mods.filter((m) => m.state === 'planned')
		log('info', `装载模块：${installed.map((m) => m.id).join('、') || '（无）'}`)
		if (failed.length) {
			log('error', `装载失败 ${failed.length} 个：${failed.map((m) => `${m.id}（${m.error ?? '未知原因'}）`).join('；')}`
				+ (planned.length ? `　其余 ${planned.length} 个未装载` : ''))
		}
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
	//
	// 装载失败（整批拒绝或中途回滚）时**不注册它**：scope 已经倒掉了，
	// 这时候还挂个"存活探针"只会让人以为插件装上了（工具面应当保持干净）。
	if (modulesOk) {
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
					// 只报**真实装载**的模块；配置表启用数只在两者不一致时补一句
					const installed = hctx.mods.filter((m) => m.state === 'installed').map((m) => m.id)
					const configured = enabledModules()
					const note = installed.length === configured.length ? '' : `（配置表启用 ${configured.length} 个，未全部装上）`
					return {
						ok: true,
						echo: String(args?.text ?? ''),
						dataDir: paths?.root,
						_info: `已装载 ${installed.length} 个模块：${installed.join(', ')}${note}`,
					}
				},
			}),
		)
	} else {
		log('warn', '装载未完成 —— 不注册存活探针 whale_ping（工具面保持干净，避免"看着装上了"）')
	}

	// —— 3) 自愈：读上一轮留下的中间态、判断要不要清（这里留白）
	// —— 4) 报状态（只报真实状态：装失败就别说"装载完成"）
	if (cfg.announceOnBoot) {
		log(modulesOk ? 'info' : 'error', modulesOk
			? `装载完成（数据目录 ${paths?.root ?? '未定'}）`
			: `装载**未**完成（数据目录 ${paths?.root ?? '未定'}）—— 见上面的失败行`)
	}

	// —— 5) 清理
	const cleanup = () => observe(scope)
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
