/**
 * alien-env.mjs —— 「别人拿到这个插件」判据
 * ------------------------------------------------------------------
 * 为什么要有这一套：以前插件靠「插件旁边那个 study」「课程包旁边那个 dsh-raw-html-v2-master」
 * 这类**按作者本机目录布局猜出来的路径**活着。那种写法在作者机器上 100% 正常，
 * 换台机器（npm 装进 node_modules）就 0% 正常，而且**失败得很安静**。
 *
 * 这一套造一个「不是你」的机器：
 *   <tmp>/alien/course/   课程包副本（没有兄弟目录、没有 dsh-raw-html-v2-master）
 *   <tmp>/alien/plug/     插件**复制**一份（不是 junction），只放 `package.json` 的 `files` 里那些
 *   <tmp>/alien/data/     数据目录（隔离，不碰真实 $DSH_HOME）
 *
 * 判据（每条都可失败，且**带反空转**）：
 *   [1] 随包发布的文件里 0 处本机绝对路径 / `workplace` / `dsh-raw-html-v2`
 *   [2] 只配 `packRoot` 一处 → 插件装得上、工具注册齐
 *   [3] 只读工具不传 `root` 也能跑（证明「配置一处」真的够）
 *   [4] 没有外部风格库时 whale_style **只降级、不报错**，且 render 仍是**一个** text 项（不糊屏）
 *   [5] `DSH_WHALE_PACK` 环境变量也能定位；空白值当没配
 *   [6] 什么都不配 → **明确报错**，不是静默成功、不是拿 cwd 当包
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { packRoot } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..') // 插件仓
const PACK = packRoot() // 课程包（判据见 test/_pack.mjs）

// 复制课程包时跳过的重目录（只影响快慢，不影响判据）
const EXCLUDE_TOP = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']

let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-alien-'))
const alienCourse = path.join(tmpRoot, 'course')
const alienPlug = path.join(tmpRoot, 'plug')
const alienData = path.join(tmpRoot, 'data')

try {
	// ── 造机器 ────────────────────────────────────────────────────────────
	fs.cpSync(PACK, alienCourse, {
		recursive: true,
		filter: (src) => {
			if (path.resolve(src) === path.resolve(PACK)) return true
			return !EXCLUDE_TOP.includes(path.relative(PACK, src).split(path.sep)[0])
		},
	})
	const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))
	const shipped = Array.isArray(pkg.files) && pkg.files.length ? pkg.files : ['lib']
	fs.mkdirSync(alienPlug, { recursive: true })
	for (const f of shipped) {
		const s = path.join(SRC, f)
		if (fs.existsSync(s)) fs.cpSync(s, path.join(alienPlug, f), { recursive: true })
	}
	fs.mkdirSync(alienData, { recursive: true })

	ok(fs.existsSync(path.join(alienCourse, 'presets', 'whale-sensei.css')), '课程包副本像课程包（有 presets/whale-sensei.css）')
	ok(
		!fs.existsSync(path.join(path.dirname(alienCourse), 'dsh-raw-html-v2-master')) && !fs.existsSync(path.join(alienPlug, '..', 'study')),
		'这台「别人的机器」上既没有风格仓、也没有插件旁边的 study（否则下面的判据是空的）',
	)

	// ── [1] 静态守卫：随包文件里不许有「某台机器专属」的路径 ───────────────
	// 两条规则：
	//   ① 兄弟仓名 / 作者目录名（`workplace`、风格仓名）一律不许出现；
	//   ② 盘符路径不许出现，**唯一豁免**是浏览器安装位置（那是「探测候选表」，
	//      本来就该列 Windows 上的常见落点；`visual-io.js` 找不到会继续往下找）。
	//      注意源码里是**转义过的**双反斜杠（`'C:\\Program Files\\...'`），所以豁免按首段认。
	const FORBID = [/workplace/i, /dsh-raw-html-v2/i]
	const DRIVE = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"`)]*/g
	const SYSTEM_OK = /^[A-Za-z]:\\{1,2}(Program|Windows)\b/i
	const walk = (dir, out = []) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name)
			if (e.isDirectory()) walk(p, out)
			else if (/\.(js|mjs|cjs|json|ya?ml|md|txt)$/i.test(e.name)) out.push(p)
		}
		return out
	}
	const scanned = walk(alienPlug)
	const offenders = []
	for (const f of scanned) {
		const text = fs.readFileSync(f, 'utf8')
		const hits = []
		for (const r of FORBID) { const m = text.match(r); if (m) hits.push(m[0]) }
		for (const m of text.match(DRIVE) || []) if (!SYSTEM_OK.test(m)) hits.push(m)
		if (hits.length) offenders.push(`${path.relative(alienPlug, f)}（${[...new Set(hits)].slice(0, 3).join('、')}）`)
	}
	ok(
		offenders.length === 0,
		`随包 ${scanned.length} 个文件里 0 处机器专属路径${offenders.length ? '（还留着：' + offenders.join('；') + '）' : ''}`,
	)

	// ── 装载：只配 packRoot 一处 ──────────────────────────────────────────
	const loadAlien = async (config) => {
		const tools = []
		const ctx = {
			logger: { info() {}, warn() {}, error() {} },
			tools: { register: (def) => { tools.push(def); return () => {} } },
			inject: (_names, cb) => cb({ get: () => ({ fetch: { register: () => {} } }) }),
		}
		const mod = await import(pathToFileURL(path.join(alienPlug, 'lib', 'index.js')).href)
		const dispose = mod.apply(ctx, config)
		return { mod, tools, dispose }
	}

	let alien
	try {
		alien = await loadAlien({ packRoot: alienCourse, dataDir: alienData, announceOnBoot: false })
		ok(typeof alien.mod.apply === 'function', '复制过去的 lib/index.js 能 import 且 apply 是函数（无外部依赖）')
		ok(typeof alien.mod.resolvePackRoot === 'function', '导出了 resolvePackRoot（课程包定位的唯一入口）')
	} catch (e) {
		ok(false, `import / apply 复制过去的插件失败：${e?.message ?? e}`)
	}

	if (alien) {
		const names = alien.tools.map((t) => t.name)
		const want = ['whale_lessonpack', 'whale_build', 'whale_probe', 'whale_audit', 'whale_style', 'whale_mode', 'whale_state', 'whale_ask', 'whale_glossary', 'whale_brief']
		const missing = want.filter((n) => !names.includes(n))
		ok(missing.length === 0, `只配 packRoot 就把 ${names.length} 个工具装齐了${missing.length ? '（缺：' + missing.join('、') + '）' : ''}`)

		// ── [3]/[4] 只读工具：**不传 root**，必须靠配置那一处跑起来 ───────────
		for (const [name, args] of [['whale_lessonpack', {}], ['whale_style', {}], ['whale_mode', { stored: 'dark', systemDark: false }]]) {
			const t = alien.tools.find((x) => x.name === name)
			if (!t) { ok(false, `${name} 在册`); continue }
			try {
				const v = await t.execute({ ...args })
				const rendered = t.output.render(args, v)
				ok(
					Array.isArray(rendered) && rendered.length === 1 && rendered.every((x) => typeof x.text === 'string'),
					`${name} 不传 root 也能跑，且 render 是**一个** text 项（多的会被宿主拼成一坨）`,
				)
				if (name === 'whale_style') {
					const text = rendered[0].text
					ok(!text.startsWith('❌'), 'whale_style 在没有外部风格库的机器上**只降级、不报错**')
					ok(
						text.includes('读不到风格索引'),
						'降级路径确实被走到了（否则上面那条判据是空的 —— 这条是反空转哨兵）',
					)
				}
			} catch (e) {
				ok(false, `${name} 抛了：${e?.message ?? e}`)
			}
		}
		alien.dispose?.()
	}

	// ── [5] 环境变量也能定位 ─────────────────────────────────────────────
	const rp = alien?.mod?.resolvePackRoot
	if (typeof rp === 'function') {
		ok(rp(undefined, { DSH_WHALE_PACK: alienCourse }) === path.resolve(alienCourse), 'DSH_WHALE_PACK 环境变量能定位课程包')
		ok(rp(undefined, {}) === undefined, '什么都没配 → undefined（交给工具明确报错，不猜 cwd）')
		ok(rp(undefined, { DSH_WHALE_PACK: '   ' }) === undefined, '空白环境变量当没配（不然 cwd 会被当成课程包）')
		ok(rp(alienCourse, { DSH_WHALE_PACK: path.join(tmpRoot, 'nope') }) === path.resolve(alienCourse), '显式配置优先于环境变量')
	} else {
		ok(false, '拿不到 resolvePackRoot，环境变量判据没跑')
	}

	// ── [6] 反空转：什么都不配 → 必须明确报错 ─────────────────────────────
	try {
		const bare = await loadAlien({ dataDir: alienData })
		const vs = bare.tools.find((t) => t.name === 'whale_style')
		const v = await vs.execute({})
		ok(v?.ok === false && /没有课程包根目录/.test(v?.error || ''), '没配课程包时**明确报错**（不是静默成功、不是拿 cwd 当包）')
		bare.dispose?.()
	} catch (e) {
		ok(false, `没配课程包的那一跑抛了：${e?.message ?? e}`)
	}
} finally {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 临时目录清不掉不致命 */ }
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
process.exit(fails.length ? 1 : 0)
