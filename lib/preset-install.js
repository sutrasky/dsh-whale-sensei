/**
 * preset-install.js —— 「鲸师模式」这个 **agent 预设** 的安装器（唯一实现）
 * ==================================================================
 * 为什么要有它（2026-09-27 的事故）：
 *   预设以前**只**由 `install-whale-sensei.ps1` 的 1c 步安装，于是别人的机器上它
 *   根本不存在 —— 而**每一条**安装路径都会踩到其中一个坑：
 *     · npm 装的人：`package.json` 的 `files` 没带 `preset/`，包里**根本没有**这份模板；
 *       连那个 .ps1 也没带 ⇒ 1c 从来没有机会跑。预设就"不见了"，而且**一声不响**。
 *     · 拿 checkout 装的人：1c 要求同时给 `-PackRoot`，不给就 SKIP（退出码仍是 0）。
 *     · 文档从头到尾没提过预设 —— 没有任何一条验收会因为它缺席而变红。
 *   修法：**装插件就该带上预设**。把"渲染 + 落盘"收进这一个模块，让三处共用：
 *     ① 插件自己（`lib/mods/preset.js` 在宿主启动时装，见那里的注释）；
 *     ② 安装脚本（`node lib/preset-install.js --dsh-home <dir>`）；
 *     ③ 判据（`test/preset.mjs`）。
 *   **不许再抄第二份** —— 渲染规则只有这里一份（模板里的 `__WHALE_SKILLS__`）。
 *
 * 宿主的发现契约（**0.2.0 与 0.2.1 是两套，必须都兼顾**）：
 *   · 0.2.0 及更早：扫 `$DSH_HOME/.agent-presets/<id>/`，一个目录（名字合法 + 含 `agent.cordis.yml`）
 *     就是一个预设 —— 没有注册表、没有清单、没有配置行。本模块**落盘那份文件**服务的是这条契约。
 *   · 0.2.1+：预设是 **YAML 声明式**（`@deepseek-ai/dsh-agent-preset` 行，`- insert:` 进组合树），
 *     **不再扫** `.agent-presets/`。所以还要在 profile 的 `cordis.patch.yml` 里补一行
 *     —— 见 {@link ensurePresetRow}（幂等，带备份，写坏还原）。
 *   · 两套都写，是为了同一份包在 0.2.0 / 0.2.1 上都能用；多写那一行在 0.2.0 上只是不起作用的配置。
 *   · 发现是**每次调用重读**（不缓存）⇒ 启动期写进去，本次就看得见，**不用重启**；
 *   · ⚠️ 组合里有一行的 `name` 解析不出来 ⇒ 该预设被标 `broken`，**开会话的选择器会把它丢掉**
 *     （设置页仍显示，带「加载失败」）。所以"预设不见了"有两种死法，这里两种都要防：
 *     没落盘、落盘了但坏。`health` 只查 YAML + 行名可解析，**不查 config** ——
 *     技能目录指错不会让预设消失，只会在挂载时没技能。
 *
 * 只改**我们生成的那一份**：文件头带 `MARKER` 的才刷新；主人手写的（没有那行）
 * 一律不动，只报一句 —— 免得把人家改过的预设盖掉。
 *
 * 命令行（安装脚本用它，也是这个模块唯一的对外缝）：
 *   node lib/preset-install.js --dsh-home <DSH_HOME> [--skills-dir <课程包/skills>]
 *                              [--src <预设模板目录>] [--json] [--check]
 *   退出码：0 = 装好了 / 已是最新 / 主人手写不动；1 = 模板缺、占位符渲染不出来、写盘失败。
 *   `--check` 只报不写（`--check` 时**永远**退出 0：它只是报告）。
 *
 * @module dsh-whale-sensei/preset-install
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findProfileDir } from './profile-packroot.js'

/** 预设 id —— 也是目录名。宿主的 id 规则：`/^[a-z0-9][a-z0-9-]*$/`（大小写、下划线、点都不行）。 */
export const PRESET_ID = 'whale-mode'

/** 用户预设根 —— 宿主侧的常量同名（`@deepseek-ai/dsh-agent-presets` 的 `USER_PRESET_DIR`）。 */
export const PRESET_ROOT_DIR = '.agent-presets'

/** 模板里的技能目录占位符（`build-preset.mjs` 合成时写进去的）。 */
export const SKILLS_PLACEHOLDER = '__WHALE_SKILLS__'

/**
 * 生成标记：**只有带这一行的文件才归我们刷新**。
 * 它是 YAML 注释（组合的顶层必须是列表，注释在列表之前是合法的），
 * 既当"这是我们生成的"的凭据，又当给主人看的说明。
 */
export const MARKER = '# 本文件由 dsh-whale-sensei 生成（改人设改插件仓 preset/whale-mode/persona.md 再重跑 build-preset.mjs）—— 不要手改，重装/升级会覆盖'

/**
 * 0.2.1+ 的 Agent 预设是 **YAML 声明式**（`@deepseek-ai/dsh-agent-preset` 行，
 * `config = { id, name, description, order, plugins[] }`），由组合树里的 `- insert:` 声明；
 * 0.2.1 **不再扫描** `<DSH_HOME>/.agent-presets/`。所以光落盘那份文件不够，
 * 还要在 profile 的 `cordis.patch.yml` 里补一行 —— 这组函数就是那一半。
 */
export const PRESET_ROW_ID = `preset-${PRESET_ID}`
export const ROW_BEGIN = '# >>> dsh-whale-sensei preset row（自动生成：DSH 0.2.1+ 的 YAML 声明式预设）>>>'
export const ROW_END = '# <<< dsh-whale-sensei preset row <<<'

/** 本模块所在的插件根（`lib/` 的上一层）—— 模板默认就在它下面的 `preset/whale-mode`。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 插件自带的模板目录。 */
export function defaultSrcDir() {
	return path.join(PLUGIN_ROOT, 'preset', PRESET_ID)
}

/**
 * DSH 根目录 —— **与宿主同一套规则**（`@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`，
 * 也和本插件 `lib/index.js` 的 `createPaths` 一致）：
 * `$DSH_HOME`（非空白）→ `~/.dsh`。**绝不退回 cwd**（那会把预设写进包里）。
 *
 * @param {object} [env] 便于测试注入；默认 `process.env`
 * @returns {string} 绝对路径
 */
export function resolveDshHome(env = process.env) {
	const v = env?.DSH_HOME
	const s = typeof v === 'string' ? v.trim() : ''
	return s ? path.resolve(s) : path.join(os.homedir(), '.dsh')
}

/**
 * 预设落盘的目录（宿主扫的就是它）。
 * @param {string} dshHome DSH 根
 * @param {string} [id] 预设 id
 * @returns {string} 绝对路径
 */
export function presetDirFor(dshHome, id = PRESET_ID) {
	return path.join(dshHome, PRESET_ROOT_DIR, id)
}

/**
 * 把模板渲染成**可落盘**的组合文本。
 *
 * 只动一处：`customSkillDirs` 的列表 —— 换成课程包的 `skills/`（POSIX 写法，Windows 上也照写）。
 * 没给技能目录时写成 `customSkillDirs: []`（**留空**而不是留着占位符：占位符会被当成一个
 * 不存在的相对目录，比空列表更难查）。配好 packRoot 后下次启动会刷新成真路径。
 *
 * 其余行**逐字不动** —— 组合（工具行 / isolate 分组 / skill 挂载）是一次成型的，
 * 改它的风险远大于改人设。
 *
 * @param {string} templateText 模板全文（`preset/whale-mode/agent.cordis.yml`）
 * @param {string} [skillsDir] 课程包的 `skills` 目录（绝对路径）；不给 = 空列表
 * @returns {string} 渲染好的文本（LF 行尾，头部带 MARKER）
 * @throws {Error} 模板里找不到 `customSkillDirs` 列表时（换一份模板，别静默产出半成品）
 */
export function renderComposition(templateText, skillsDir) {
	const lines = String(templateText).split('\n')
	const at = lines.findIndex((l) => /^\s*customSkillDirs:\s*$/.test(l))
	if (at < 0) throw new Error(`模板里找不到 customSkillDirs 列表（${SKILLS_PLACEHOLDER} 该在那儿）`)

	// 列表项 = 紧跟其后的那几行 `- xxx`（到第一个不是列表项的为止）
	let end = at + 1
	while (end < lines.length && /^\s+-\s/.test(lines[end])) end++
	if (end === at + 1) throw new Error('模板里的 customSkillDirs 是个空列表 —— 占位符不见了')

	const indent = /^(\s*)/.exec(lines[at])[1]
	const block = skillsDir
		? [`${indent}customSkillDirs:`, `${indent}  - '${String(skillsDir).replace(/\\/g, '/').replace(/'/g, "''")}'`]
		: [`${indent}customSkillDirs: []`]

	const out = [MARKER, ...lines.slice(0, at), ...block, ...lines.slice(end)]
	const text = out.join('\n')
	if (text.includes(SKILLS_PLACEHOLDER)) throw new Error('渲染后仍留着占位符 —— 模板形状变了')
	return text
}

/**
 * 预设在 profile 那一层的 YAML 声明（0.2.1+ 契约）。
 *
 * 输入是**已经渲染好的组合**（`installPreset` 落盘的那份，去掉生成标记行），
 * 输出是可直接追加到 profile `cordis.patch.yml` 的一段：
 *
 *   # >>> dsh-whale-sensei preset row ... >>>
 *   - insert:
 *       - id: preset-whale-mode
 *         name: '@deepseek-ai/dsh-agent-preset'
 *         config: { id, name, description, order, plugins: <组合> }
 *   # <<< dsh-whale-sensei preset row <<<
 *
 * @param {{name?:string, description?:string, order?:number}} meta `preset.yml` 里的显示元数据
 * @param {string} compositionText 组合全文（LF）
 * @returns {string} 追加用的 YAML 片段（末尾带换行）
 */
export function buildPresetRow(meta = {}, compositionText = '') {
	const q = (s) => `'${String(s).replace(/'/g, "''")}'`
	const name = String(meta.name ?? '鲸师模式').trim() || '鲸师模式'
	const description = String(meta.description ?? '').trim()
	const order = Number.isFinite(Number(meta.order)) ? Number(meta.order) : 5
	const body = compositionBody(compositionText)
		.map((l) => (l.length ? `          ${l}` : ''))
		.join('\n')
	return [
		ROW_BEGIN,
		'- insert:',
		`    - id: ${PRESET_ROW_ID}`,
		"      name: '@deepseek-ai/dsh-agent-preset'",
		'      config:',
		`        id: ${PRESET_ID}`,
		`        name: ${q(name)}`,
		`        description: ${q(description)}`,
		`        order: ${order}`,
		'        plugins:',
		body,
		ROW_END,
		'',
	].join('\n')
}

/** 去掉生成标记行与首部空行 —— 组合本体（会被缩进进 `plugins:` 下）。 */
function compositionBody(text) {
	const out = String(text ?? '').split('\n').filter((l) => l !== MARKER)
	while (out.length && !out[0].trim()) out.shift()
	while (out.length && !out[out.length - 1].trim()) out.pop()
	return out
}

/** 读 `<presetDir>/preset.yml` 的显示元数据（缺了就用默认值，不报错）。 */
function readPresetMeta(presetDir) {
	const meta = { name: undefined, description: undefined, order: undefined }
	try {
		const text = fs.readFileSync(path.join(presetDir, 'preset.yml'), 'utf8')
		const pick = (k) => {
			const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(text)
			return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined
		}
		meta.name = pick('name')
		meta.description = pick('description')
		const o = pick('order')
		if (o !== undefined && Number.isFinite(Number(o))) meta.order = Number(o)
	} catch { /* 没有 preset.yml 就用默认值 */ }
	return meta
}

/**
 * 把预设声明补进 profile 的 `cordis.patch.yml`（**幂等**：已经有 `preset-whale-mode` 就不动）。
 *
 * 结局都不抛：
 *   · `inserted` —— 追加好了（`backup` 是写前备份）；
 *   · `unchanged` —— 已经有这一行，没动；
 *   · `no-profile` —— 没找到装载鲸师的 profile（不猜）；
 *   · `no-composition` —— 预设文件不在（先跑 `installPreset`）；
 *   · `failed` —— 读/写/回读失败（**写坏就还原备份**，不静默）。
 *
 * @param {object} [opts]
 * @param {string} [opts.dshHome] DSH 根
 * @param {string} [opts.presetDir] 预设目录（默认按 dshHome 现算）
 * @returns {{action:string, file?:string, backup?:string, reason?:string}}
 */
export function ensurePresetRow(opts = {}) {
	const dshHome = opts.dshHome ? path.resolve(opts.dshHome) : resolveDshHome()
	const found = findProfileDir({ dshHome })
	if (!found.ok) return { action: 'no-profile', reason: found.error }
	const file = found.yml
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch (e) {
		return { action: 'failed', file, reason: `读不动 ${file}：${e?.message ?? e}` }
	}
	if (text.includes(`id: ${PRESET_ROW_ID}`)) return { action: 'unchanged', file }

	const presetDir = opts.presetDir ? path.resolve(opts.presetDir) : presetDirFor(dshHome)
	let composition
	try {
		composition = fs.readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8')
	} catch (e) {
		return { action: 'no-composition', file, reason: `预设文件不在 ${path.join(presetDir, 'agent.cordis.yml')}（${e?.message ?? e}）` }
	}

	const row = buildPresetRow(readPresetMeta(presetDir), composition)
	const backup = `${file}.bak-whale-preset-${Date.now()}`
	try {
		fs.copyFileSync(file, backup)
		fs.writeFileSync(file, `${text.replace(/\s*$/, '')}\n\n${row}`, 'utf8')
	} catch (e) {
		return { action: 'failed', file, reason: `写不动 ${file}：${e?.message ?? e}` }
	}
	try {
		const after = fs.readFileSync(file, 'utf8')
		if (!after.includes(`id: ${PRESET_ROW_ID}`) || !after.includes(ROW_END)) throw new Error('回读没看到插入行')
	} catch (e) {
		try { fs.copyFileSync(backup, file) } catch { /* 还原失败就只能把原因报清楚 */ }
		return { action: 'failed', file, reason: `写完回读校验失败（已还原备份）：${e?.message ?? e}` }
	}
	return { action: 'inserted', file, backup }
}

/**
 * 装（或刷新）预设 —— **幂等**：内容一致就一个字节都不写。
 *
 * 结局，都不抛：
 *   · `created` / `refreshed` —— 写好了（`files` 列出写了哪几个）；
 *   · `unchanged` —— 磁盘上就是最新，没动；
 *   · `kept-hand-edited` —— 有一份**没有生成标记**的文件，判定为主人手写 ⇒ 一个字都不动；
 *     （老版本安装脚本 Copy+Replace 出来的那份会被**认领**：它逐字节等于"渲染结果去掉标记行"，
 *      于是照常刷新 —— 否则老机器上的预设会永远冻结在旧版。）
 *   · `no-template` / `failed` —— 装不了，`reason` 说清为什么（**不静默降级**）。
 *
 * @param {object} opts
 * @param {string} [opts.srcDir] 模板目录（默认插件自带的 `preset/whale-mode`）
 * @param {string} [opts.dshHome] DSH 根（默认按 `resolveDshHome()` 现算）
 * @param {string} [opts.skillsDir] 课程包 `skills` 目录（不给 = 空列表）
 * @param {string} [opts.dir] 直接指定目标目录（测试用；给了就不再看 `dshHome`）
 * @param {(level:string,msg:string)=>void} [opts.log] 报话的出口
 * @returns {{action:string, dir:string, skillsDir:string|undefined, files:string[], reason?:string}}
 */
export function installPreset(opts = {}) {
	const srcDir = opts.srcDir ? path.resolve(opts.srcDir) : defaultSrcDir()
	const dir = opts.dir ? path.resolve(opts.dir) : presetDirFor(opts.dshHome ? path.resolve(opts.dshHome) : resolveDshHome())
	const skillsDir = opts.skillsDir ? path.resolve(opts.skillsDir) : undefined
	const log = typeof opts.log === 'function' ? opts.log : () => {}
	const back = (action, extra = {}) => ({ action, dir, skillsDir, files: [], ...extra })

	const tplPath = path.join(srcDir, 'agent.cordis.yml')
	let rendered
	try {
		if (!fs.existsSync(tplPath)) {
			return back('no-template', {
				reason: `插件包里没有预设模板 ${tplPath} —— 这一份安装（多半是 npm 包里漏了 preset/）带不来「鲸师模式」`,
			})
		}
		rendered = renderComposition(fs.readFileSync(tplPath, 'utf8'), skillsDir)
	} catch (e) {
		return back('failed', { reason: `渲染模板失败：${e?.message ?? e}` })
	}

	const target = path.join(dir, 'agent.cordis.yml')
	let before = null
	try {
		if (fs.existsSync(target)) before = fs.readFileSync(target, 'utf8')
	} catch (e) {
		return back('failed', { reason: `读不动已有的 ${target}：${e?.message ?? e}` })
	}

	if (before !== null && !before.includes(MARKER)) {
		// 认领旧格式：老版本是安装脚本直接 Copy+Replace 出来的（没有标记），
		// 内容与"我们渲染的这份去掉标记行"逐字节相同 ⇒ 它就是上一版生成器写的，
		// 认下来（否则老装机器的预设会永远冻结在旧版，谁也刷不动它）。
		// 手写的文件**不可能**逐字节等于渲染结果，所以这个判据不会误伤。
		const oursWithoutMarker = rendered.split('\n').slice(1).join('\n')
		if (before !== oursWithoutMarker) {
			log('warn', `${target} 不是本插件生成的（没有生成标记）—— 判定为主人手写，一个字都不动`)
			return back('kept-hand-edited', { reason: '磁盘上那份没有生成标记' })
		}
	}
	if (before === rendered) return back('unchanged')

	try {
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(target, rendered, 'utf8')
		const files = ['agent.cordis.yml']
		// preset.yml 只是显示名/顺序；模板里有就跟着抄一份（缺了预设照样能挂）
		const metaSrc = path.join(srcDir, 'preset.yml')
		if (fs.existsSync(metaSrc)) {
			fs.copyFileSync(metaSrc, path.join(dir, 'preset.yml'))
			files.push('preset.yml')
		}
		return back(before === null ? 'created' : 'refreshed', { files })
	} catch (e) {
		return back('failed', { reason: `写盘失败（${dir}）：${e?.message ?? e}` })
	}
}

/**
 * 按**当前** packRoot 装/刷新预设 —— 插件启动期与「选课程包」路由共用这一份。
 *
 * 为什么要有它（2026-09-27）：预设里的技能目录是**渲染时算出来**的。启动期 packRoot 还没配
 * （或还指着旧包）时那份是空的；用户随后在设置页选了/建了课程包，packRoot **本次会话就变了**
 * （`lib/mods/pack.js` 直接改 `hctx.paths.packRoot`）—— 不跟着刷新的话，新用户第一次开会话
 * 看到的「鲸师模式」还是 **0 个技能**。所以"改 packRoot 的地方"必须顺手调这个。
 *
 * 技能目录只在 `<packRoot>/skills` **真的存在**时才指过去（不存在就留空列表 ——
 * 指一个不存在的目录比空列表更难查）。缺了会通过 `log` 说一句，不静默。
 *
 * @param {object} opts
 * @param {string} [opts.packRoot] 当前课程包根
 * @param {string} [opts.presetDir] 预设目录（不给就按 `dshHome` 现算）
 * @param {string} [opts.dshHome] DSH 根
 * @param {string} [opts.srcDir] 模板目录
 * @param {boolean} [opts.installPresetRow] 是否顺手在 profile 的 `cordis.patch.yml` 声明一行（默认 true）
 * @param {(level:string,msg:string)=>void} [opts.log]
 * @returns {ReturnType<typeof installPreset> & {row?: {action:string, file?:string, backup?:string, reason?:string}}}
 */
export function ensurePresetForPack(opts = {}) {
	const log = typeof opts.log === 'function' ? opts.log : () => {}
	const packRoot = opts.packRoot ? path.resolve(String(opts.packRoot)) : undefined
	let skillsDir
	if (packRoot) {
		const candidate = path.join(packRoot, 'skills')
		if (fs.existsSync(candidate)) skillsDir = candidate
		else log('warn', `课程包里没有 skills/（${candidate}）—— 预设先留空技能目录，补上课程包后会再刷新一次`)
	}
	const installed = installPreset({
		dshHome: opts.dshHome,
		dir: opts.presetDir,
		skillsDir,
		srcDir: opts.srcDir,
		log,
	})
	// 0.2.1+ 还要在 profile 的 cordis.patch.yml 里声明一行（幂等；失败只告警，不拦住装预设本身）
	if (opts.installPresetRow === false) return installed
	if (installed.action === 'no-template' || installed.action === 'failed') return installed
	try {
		const row = ensurePresetRow({ dshHome: opts.dshHome, presetDir: installed.dir })
		if (row.action === 'failed') log('warn', `预设声明没写进 profile：${row.reason}`)
		else if (row.action === 'no-profile') log('warn', `没找到装载鲸师的 profile，预设声明跳过（${row.reason}）`)
		return { ...installed, row }
	} catch (e) {
		log('warn', `预设声明异常：${e?.message ?? e}`)
		return installed
	}
}

/**
 * 只看不写：现在磁盘上是什么状态（安装脚本、判据、排障都用它）。
 *
 * @param {object} opts 同 {@link installPreset}（`srcDir` / `dshHome` / `dir` / `skillsDir`）
 * @returns {{dir:string, installed:boolean, generated:boolean, skillsDir:string|undefined, name:string|undefined, reason?:string}}
 */
export function presetStatus(opts = {}) {
	const dir = opts.dir ? path.resolve(opts.dir) : presetDirFor(opts.dshHome ? path.resolve(opts.dshHome) : resolveDshHome())
	const target = path.join(dir, 'agent.cordis.yml')
	const out = { dir, installed: false, generated: false, skillsDir: undefined, name: undefined }
	try {
		if (!fs.existsSync(target)) return { ...out, reason: '目录/组合文件不在' }
		const text = fs.readFileSync(target, 'utf8')
		out.installed = true
		out.generated = text.includes(MARKER)
		// 技能目录：从 customSkillDirs 的列表项里读回来（判据要能证明"真的指对了"）
		const lines = text.split('\n')
		const at = lines.findIndex((l) => /^\s*customSkillDirs:\s*$/.test(l))
		if (at >= 0) {
			for (let i = at + 1; i < lines.length; i++) {
				const m = /^\s+-\s*'?"?([^'"\n]+?)'?"?\s*$/.exec(lines[i])
				if (!m) break
				out.skillsDir = m[1]
				break
			}
		}
		const meta = path.join(dir, 'preset.yml')
		if (fs.existsSync(meta)) {
			const m = /^name:\s*(.+)$/m.exec(fs.readFileSync(meta, 'utf8'))
			if (m) out.name = m[1].trim()
		}
		return out
	} catch (e) {
		return { ...out, reason: `读不动：${e?.message ?? e}` }
	}
}

// ── 命令行：安装脚本与排障用的那条缝 ──────────────────────────────────────────

/** `--flag value` / `--flag` 的极小解析（不引依赖）。 */
function parseArgv(argv) {
	const out = { _: [] }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (!a.startsWith('--')) { out._.push(a); continue }
		const key = a.slice(2)
		const next = argv[i + 1]
		if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ } else out[key] = true
	}
	return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = parseArgv(process.argv.slice(2))
	const opts = {
		dshHome: typeof args['dsh-home'] === 'string' ? args['dsh-home'] : undefined,
		skillsDir: typeof args['skills-dir'] === 'string' ? args['skills-dir'] : undefined,
		srcDir: typeof args.src === 'string' ? args.src : undefined,
		dir: typeof args.dir === 'string' ? args.dir : undefined,
	}
	if (args.check) {
		const st = presetStatus(opts)
		const body = {
			ok: st.installed,
			...st,
			hint: st.installed ? undefined : '装它：node lib/preset-install.js --dsh-home <DSH_HOME> [--skills-dir <课程包/skills>]',
		}
		console.log(args.json ? JSON.stringify(body, null, 2) : `预设 ${PRESET_ID}：${st.installed ? '在' : '不在'}（${st.dir}）`
			+ `\n  生成标记：${st.generated ? '有（归本插件刷新）' : '无（手写或没装）'}`
			+ `\n  技能目录：${st.skillsDir ?? '（空 —— 还没配 packRoot 或课程包没有 skills/）'}`
			+ `\n  显示名　：${st.name ?? '（无 preset.yml）'}`)
		process.exit(0)
	}
	const r = installPreset({ ...opts, log: (level, msg) => console.log(`[${level}] ${msg}`) })
	const zh = {
		created: 'OK   已安装',
		refreshed: 'OK   已刷新',
		unchanged: 'OK   已是最新（没动）',
		'kept-hand-edited': 'SKIP 磁盘上那份是手写的 —— 一个字都没动',
		'no-template': 'FAIL 模板不在',
		failed: 'FAIL 渲染/写盘失败',
	}[r.action] ?? r.action
	console.log(args.json ? JSON.stringify(r, null, 2) : `${zh}：${r.dir}${r.files.length ? `（写了 ${r.files.join('、')}）` : ''}`)
	if (r.skillsDir) console.log(`     技能目录 ${r.skillsDir}`)
	else console.log('     技能目录 留空 —— 配上 packRoot 后重启宿主会自动补上')
	if (r.reason) console.log(`     原因：${r.reason}`)
	process.exit(r.action === 'no-template' || r.action === 'failed' ? 1 : 0)
}
