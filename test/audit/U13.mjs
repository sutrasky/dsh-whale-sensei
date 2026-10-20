/**
 * test/audit/U13.mjs —— 作者 / 建点 / 建课入口的**规范身份**专项判据（A lane · U13）
 * ==================================================================================
 * 判的是这一件事：**作者（`lib/author.js`）、建点建课入口（`lib/mods/author.js` /
 * `mods/create.js` / `mods/plan.js`）、重建（`lib/rebuild-job.js`）只生产与消费规范身份**
 * （知识点 `circle/point`、课程 `circle/point/NNNN`），不再各自拼接、也不再降维；
 * 并且既有的 force / 路径 / 大纲 / 摸底 / 写前检查**一条都没放宽**。
 *
 *   A01 正常创建结果引用完整知识点身份 —— `authorLesson` 的落点 = 内核的 `circle/point`
 *       （文件名里的 NNNN 与内核 `lessonKey` 的末段逐字相同）；工具 commit 落地后 `readPack`
 *       读出的课程 id 是 `circle/point/NNNN`；建点回执的 `id` 是 `circle/point`。
 *   A02 不同圆圈同名点不串摸底 / 目标 —— 裸 `x` 在两圈都有：大纲**拒绝**且两个 point.json
 *       一个字节不动；`a/x` 的摸底不被 `b/x` 看见；裸点落点不猜圆圈（退回平铺）。
 *       **Δ（逐条对拍旧实现）**：旧实现按"第一个"认圈 —— 这两条在旧实现上是反的。
 *   A03 缺归属 / 身份不合法 ⇒ **写入调用为零** —— 进程内写计数探针（不是"看文件在不在"）。
 *   A04 结构 / 路径拒绝**不可被 force 绕过** —— 逐条 force:true 也一样拒，理由逐字相同；
 *       同时给一条**正面控制**：force 照样能绕摸底闸（不放宽 ≠ force 失效）；
 *       **Δ（U18）**：`challengeGate` 新增「上一课归属不唯一 → 失败关闭」分支，它住在教学闸里，
 *       force 会跳过整个教学闸 —— 所以这里钉的是「force 绕过它必须逐字留痕」，而不是假设它绕不过。
 *   A05 原有顺序不放宽 —— 源码级次序 + 行为级**优先序矩阵** + 非身份面「旧实现 ↔ 新实现」0 差异。
 *       矩阵显式含 U18 新闸（上一课归属不唯一），位置 = 大纲闸之后、摸底闸之前；并用一对对照
 *       （归属唯一 → 摸底闸 / 归属不唯一 → 新闸）证明它没有把正常路径一起拦掉。
 *   A06 重建里的历史处理只**指向迁移** —— `startScripts` 的 `migration` 指路（唯一入口
 *       `tools/migrate-pack.mjs`）；体检只调严格内核 `parseLessonKey`（解不开=历史，不映射）；
 *       五个落点里没有任何第三份身份拼接；规范包零误报；历史包**零写入**（不就地迁移）。
 *   A07 变异有效性（只在 E:\Temp 副本）—— 干净副本必须绿；**去掉圆圈** / **恢复降维** /
 *       **恢复自主拼接**三种变异必须依次打红对应用例；仓内零影响。
 *   A08 既有断言冲突闸 / 文件范围 / 证据守卫 —— HEAD=基线、写集与 §6（现场解析，20 卡）∪
 *       authorization（现场解析）一致、既有 `test/**` 的 tracked 改动只许是 A 面授权的那两条、
 *       导出面 / 参数 / 默认值 / 返回形状与 HEAD 逐键逐签名对拍、fs 写守卫（含探针写自证）+
 *       依赖运行期自锚 + 交付物内容锁 + 证据根守卫 + 临时目录归属清理 + 回执 JSON 自检。
 *
 * 判词**只有一行**（unify-runner.printVerdict）：
 *   成功 `PASS U13 checks=8 failed=0 skipped=0` → exit 0 ／ `FAIL U13 …` → 1 ／ `BLOCKED U13 …` → 2
 *
 * ⚠️ 本卡**不消费 A 面**（§12 选项 A 只授权 U09/U10/U14 改既有测试）：本文件一条既有断言都没改，
 * 只消费主持人裁决 C3（依赖锚点口径）与 C4（`lib/point-ref.js` 归 U09）这类**口径对齐**。
 * ⚠️ 不跑任何既有套件、不跑 T 卡入口、不访问/不写活包、不做任何 git 写、不改任何 T 证据。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
	FIXED_IDS,
	Blocked,
	REPO,
	runCard,
	printVerdict,
	writeRunEvidence,
	resolveEvidenceRoot,
	guardTempPath,
	safeRemoveTree,
} from './unify-runner.mjs'

const CARD = 'U13'
const SELF = fileURLToPath(import.meta.url)
const ARGV = process.argv.slice(2)
const require_ = createRequire(import.meta.url)

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

/* ══════════════════════════════════════════════════════════════════════
 * 落点与写集
 * ══════════════════════════════════════════════════════════════════════ */

/** 内核（唯一严格身份实现；U02 交付，本卡只消费） */
const KERNEL = 'lib/unify/identity.cjs'

/** 本卡要改的五个既有落点（卡面精确写集） */
const HOST_FILES = Object.freeze([
	'lib/author.js',
	'lib/rebuild-job.js',
	'lib/mods/author.js',
	'lib/mods/create.js',
	'lib/mods/plan.js',
])

/** interfaces.md §6 里 U13 的落点（= 卡面写集全文） */
const SECTION6_SET = Object.freeze([
	'lib/author.js',
	'lib/rebuild-job.js',
	'lib/mods/author.js',
	'lib/mods/create.js',
	'lib/mods/plan.js',
	'test/audit/U13.mjs',
	'docs/unify/receipts/U13.json',
])
const WRITE_SET = SECTION6_SET

/**
 * 运行期**自锚**的依赖：不是本卡写集，但本卡结论依赖它们。
 * 本次进程开始时记 sha256，收口前再比必须相同（跨 lane 的"跨次"变化不算越界，
 * **本次运行期间**的变化才算 —— 那会让 A01–A06 不再对同一份依赖成立）。
 */
const ANCHOR_FILES = Object.freeze([
	'lib/unify/identity.cjs',
	'lib/unify/errors.cjs',
	'lib/unify/stage.cjs',
	'lib/unify/pack.cjs',
	'lib/pack-model.js',
	'lib/point-ref.js',
	'lib/intake.js',
	'lib/plan.js',
	'lib/gate.js',
	'lib/pack-template/tools/path-policy.cjs',
	'docs/unify/interfaces.md',
	'docs/unify/authorization.json',
	'docs/unify/baseline.json',
])

const BASELINE_SHA = '2f57b1f2cec02e4128b69497e3b6819d36aa707b'

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { temp: RUN_TEMP, comparisons: {} }

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')

function assert(cond, msg) {
	if (!cond) throw new Error(msg)
}
function fmt(v) {
	if (typeof v === 'function') return `<函数 ${v.name || '(匿名)'}>`
	try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}
function eq(actual, expected, msg) {
	if (actual !== expected) throw new Error(`${msg}（实得 ${fmt(actual)} / 期望 ${fmt(expected)}）`)
}
function sameJson(actual, expected, msg) {
	const a = JSON.stringify(actual)
	const b = JSON.stringify(expected)
	if (a !== b) throw new Error(`${msg}\n  实得 ${a.slice(0, 700)}\n  期望 ${b.slice(0, 700)}`)
}
/** 剥注释（源码层判据用；注释里的字样不算"实现"） */
export function stripComments(src) {
	return String(src)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function gitText(args) {
	const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
	eq(r.status, 0, `git ${args.join(' ')} 必须正常退出（stderr=${String(r.stderr || '').slice(0, 300)}）`)
	return String(r.stdout ?? '')
}
function gitHeadBytes(relPath) {
	const r = spawnSync('git', ['show', `HEAD:${relPath}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
	if (r.status !== 0) return null
	return r.stdout
}
function writeJson(file, obj) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}
/** 目录树快照（相对路径 + 内容 sha256）——用于"一个字节都没动"这类断言 */
function treeOf(dir) {
	const out = []
	const walk = (d) => {
		let entries = []
		try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
		for (const e of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
			const abs = path.join(d, e.name)
			if (e.isDirectory()) walk(abs)
			else if (e.isFile()) out.push({ path: path.relative(dir, abs).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(abs)) })
		}
	}
	walk(dir)
	return out
}
const findIn = (tree, relPath) => (tree.find((f) => f.path === relPath) || null)

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U04/U09/U10 同一套纪律；本文件独立实现，不 import 兄弟卡的纯函数）
 * ──────────────────────────────────────────────────────────────────────
 *   ① 进程内 fs 写守卫 —— 本卡**本次进程**的每一次写都必须落在
 *      { 写集 7 项 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 }，并用**探针写**自证；
 *   ② 授权写集并集（tracked 侧）—— `git status --porcelain -uall` 的 tracked 改动
 *      必须 ⊆ U01–U20 全部卡授权写集（interfaces.md §6，独立解析）∪ §12 授权面
 *      （`docs/unify/authorization.json` **现场解析**）；
 *   ③ 本卡交付物内容锁 + 依赖运行期自锚；
 *   ④ **不统计他卡的文件数/字节数**（不锚定别的卡证据目录、不数它们的文件）。
 * ══════════════════════════════════════════════════════════════════════ */

const IS_MAIN = (() => {
	const arg = process.argv[1]
	if (!arg) return false
	try { return pathToFileURL(path.resolve(arg)).href === pathToFileURL(SELF).href } catch { return false }
})()

/** 写入根（越界即 BLOCKED，一个字节都不写）—— 写守卫也要用，故提到最前 */
const evidenceGuard = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })

const WRITE_GUARD = {
	installed: false,
	scope: null,
	patched: [],
	writes: [],
	violations: [],
	probe: null,
	probeError: null,
}

/** 本卡本次的写允许面：写集 7 项的精确绝对路径 + { 本次临时根, 本卡证据根 } 两个目录前缀 */
function writeAllowScope() {
	const roots = [path.resolve(RUN_TEMP)]
	if (evidenceGuard.ok && evidenceGuard.root) roots.push(path.resolve(evidenceGuard.root))
	return { files: new Set(WRITE_SET.map((p) => path.resolve(REPO, p))), roots, repoRoot: REPO }
}

function toPathString(v) {
	if (typeof v === 'string') return v
	if (Buffer.isBuffer(v)) return v.toString('utf8')
	if (v && typeof v === 'object' && typeof v.href === 'string') {
		try { return fileURLToPath(v) } catch { return null }
	}
	return null
}

/** **纯函数**：一个写入目标是否属于「本卡本次」的允许面（不读盘、无副作用） */
export function classifyWriteTarget(rawTarget, scope) {
	const s = scope ?? writeAllowScope()
	const abs = path.resolve(s.repoRoot ?? REPO, String(rawTarget))
	if (s.files.has(abs)) return { allowed: true, why: '本卡写集 7 项之一', abs }
	for (const root of s.roots ?? []) {
		const r = path.resolve(root)
		if (abs === r || abs.startsWith(r + path.sep)) return { allowed: true, why: `本卡允许根 ${r}`, abs }
	}
	return { allowed: false, why: '既不在本卡写集里，也不在本卡证据根 / E:\\Temp 本次临时根之内', abs }
}

const FS_SYNC_WRITES = [
	['writeFileSync', 'write', [0]], ['appendFileSync', 'append', [0]],
	['mkdirSync', 'mkdir', [0]], ['rmSync', 'rm', [0]], ['rmdirSync', 'rmdir', [0]],
	['unlinkSync', 'unlink', [0]], ['copyFileSync', 'copy', [1]], ['cpSync', 'cp', [1]],
	['renameSync', 'rename', [0, 1]], ['truncateSync', 'truncate', [0]],
	['symlinkSync', 'symlink', [1]], ['createWriteStream', 'stream', [0]],
]
const FS_CB_WRITES = [
	['writeFile', 'write', [0]], ['appendFile', 'append', [0]], ['mkdir', 'mkdir', [0]],
	['rm', 'rm', [0]], ['rmdir', 'rmdir', [0]], ['unlink', 'unlink', [0]],
	['copyFile', 'copy', [1]], ['cp', 'cp', [1]], ['rename', 'rename', [0, 1]],
	['truncate', 'truncate', [0]],
]

function openWantsWrite(flags) {
	if (typeof flags === 'number') {
		const C = fs.constants
		const bits = C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_TRUNC | C.O_APPEND
		return (flags & bits) !== 0
	}
	const s = String(flags ?? 'r')
	return /[wa]/.test(s) || s.includes('+')
}

function recordWrite(op, api, rawTarget) {
	const s = toPathString(rawTarget)
	if (!s) return
	const c = classifyWriteTarget(s, WRITE_GUARD.scope)
	const row = { op, api, target: c.abs, allowed: c.allowed, why: c.why }
	WRITE_GUARD.writes.push(row)
	if (!c.allowed) WRITE_GUARD.violations.push(row)
}

/** 把守卫挂到 fs 的写入口上（同步 + 回调 + promises + open 的写意图） */
export function installWriteGuard(scope) {
	const target = scope ?? writeAllowScope()
	WRITE_GUARD.scope = target
	const mount = (obj, label, [name, op, idx]) => {
		const orig = obj[name]
		if (typeof orig !== 'function') return false
		const wrapped = function (...args) {
			for (const i of idx) recordWrite(op, `${label}.${name}`, args[i])
			return orig.apply(this, args)
		}
		obj[name] = wrapped
		WRITE_GUARD.patched.push(`${label}.${name}`)
		return true
	}
	for (const spec of FS_SYNC_WRITES) mount(fs, 'fs', spec)
	for (const spec of FS_CB_WRITES) mount(fs, 'fs', spec)
	for (const spec of FS_CB_WRITES) mount(fs.promises, 'fs.promises', spec)
	for (const [obj, label, name, op] of [[fs, 'fs', 'openSync', 'open'], [fs.promises, 'fs.promises', 'open', 'open']]) {
		const orig = obj[name]
		if (typeof orig !== 'function') continue
		obj[name] = function (p, flags, ...rest) {
			if (openWantsWrite(flags)) recordWrite(op, `${label}.${name}`, p)
			return orig.call(this, p, flags, ...rest)
		}
		WRITE_GUARD.patched.push(`${label}.${name}`)
	}
	WRITE_GUARD.installed = true
	return WRITE_GUARD
}

/** **探针写**：往本次临时根写一个字节，再查守卫有没有记到它（"守卫真的挂上了"的自证） */
export function probeWriteGuard() {
	const dir = path.join(RUN_TEMP, 'guard-probe')
	const file = path.join(dir, 'probe.txt')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(file, 'guard-probe\n', 'utf8')
	const seen = WRITE_GUARD.writes.filter((w) => w.target === path.resolve(file))
	WRITE_GUARD.probe = {
		file: path.resolve(file),
		created: fs.existsSync(file),
		recorded: seen.length >= 1,
		recordCount: seen.length,
		allowed: seen.length > 0 && seen.every((w) => w.allowed),
		bytes: seen.length > 0 && fs.statSync(file).size === 'guard-probe\n'.length,
	}
	fs.unlinkSync(file)
	return WRITE_GUARD.probe
}

export function sweepWriteGuard() {
	return {
		installed: WRITE_GUARD.installed,
		patched: WRITE_GUARD.patched.slice(),
		writeCount: WRITE_GUARD.writes.length,
		ops: [...new Set(WRITE_GUARD.writes.map((w) => w.op))].sort(),
		writes: WRITE_GUARD.writes.slice(),
		violations: WRITE_GUARD.violations.slice(),
		probe: WRITE_GUARD.probe,
		probeError: WRITE_GUARD.probeError,
	}
}

/**
 * A03 的**写调用计数探针**（与 A08 的守卫是两件东西：这里数"调用了几次写入口"，不管落在哪儿）。
 * 用它是为了把"拒绝时写入调用为零"钉成机器可判，而不是看文件在不在。
 */
async function withWriteCounter(fn) {
	const saved = []
	let count = 0
	const ops = []
	for (const [obj, name] of [...FS_SYNC_WRITES, ...FS_CB_WRITES]) {
		const orig = obj[name]
		if (typeof orig !== 'function') continue
		saved.push([obj, name, orig])
		obj[name] = function (...args) {
			count += 1
			ops.push(name)
			return orig.apply(this, args)
		}
	}
	const restore = () => { for (const [obj, name, orig] of saved) obj[name] = orig }
	try {
		const value = await fn()
		return { value, count, ops }
	} finally {
		restore()
	}
}

/* ── 授权写集并集（tracked 侧：§6 ∪ §12 授权面） ─────────────────────── */

const SECTION6_TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const looksLikeRepoPath = (s) => SECTION6_TOKEN_RX.test(s) && (s.includes('/') || /\.[A-Za-z]{2,4}$/.test(s))

/** 把 §6 落点表解析成 `Map<卡号, 路径[]>`（纯函数；不 import 兄弟卡的常量） */
export function parseSection6(text) {
	const out = new Map()
	let inSection = false
	for (const line of String(text).split('\n')) {
		if (/^##\s*6\./.test(line)) { inSection = true; continue }
		if (inSection && /^##\s/.test(line)) break
		if (!inSection) continue
		const m = /^\|\s*(U\d\d)\s*\|(.*)\|/.exec(line)
		if (!m) continue
		const toks = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter(looksLikeRepoPath)
		out.set(m[1], [...new Set(toks)])
	}
	return out
}

/**
 * **§12 授权面**（纯函数，直接从 `authorization.json` 原文解析，不硬编码）：
 *   · **每一节** `scope.<节>.authorized` 里的仓库路径都算授权落点 —— A 面（U09/U10/U14 的
 *     旧身份测试迁移）与 P1/P2（PROBE_VERSION 重算、两处字面量断言改写）都是人类点头过的；
 *     行内点名 `<U 卡号>` 就归那张卡，没点名的集成修正（P1/P2）归它所在的节。
 *   · `derivedConsequences.items[]` 的 `what`/`decision` 里反引号包着的仓库路径算到它点名的卡
 *     （C4 = `lib/point-ref.js` 归 U09）。
 * ⚠️ 本卡（U13）**不消费** A 面：这里解析它是为了证明"别人改测试是授权过的、本卡一条没改"。
 * ⚠️ 只认 `authorized[]`，不认 `notAuthorized[]`：后者是禁止面，永远不进并集。
 * ⚠️ 决-1/决-2 授权的 `test/audit/T03.mjs` 那一行**登记在 §6 的 U01 行**（来源账本只有一处），
 *    本卡不另建一条授权解析 —— T03 是否在册由 §6 说话。
 */
export function authorizationExtras(authDoc) {
	const extras = new Map()
	const citations = []
	const add = (card, p, why) => {
		const list = extras.get(card) || []
		if (!list.includes(p)) list.push(p)
		extras.set(card, list)
		citations.push({ card, path: p, why })
	}
	const qv = String(authDoc && authDoc.quoteVerbatim)
	const qs = String(authDoc && authDoc.quoteSource)
	// §12 的授权面是**分节**的（scope.A / scope.P1 / scope.P2 …）：每一节的 authorized[] 都是人类点头过的。
	// 之前只读 scope.A，于是 P1/P2 授权过的既有测试改动（如 test/audit/T26.mjs）会被误判成越界。
	// 归属：行内点名 U 卡就归那张卡；没有卡号（P1/P2 这种集成修正）就归它所在的节。
	for (const [sectionId, section] of Object.entries((authDoc && authDoc.scope) || {})) {
		for (const line of (section && section.authorized) || []) {
			const text = String(line)
			const card = /\b(U\d\d)\b/.exec(text)
			const owner = card ? card[1] : sectionId
			for (const m of text.matchAll(/`?([A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]+)`?/g)) {
				const p = m[1]
				if (!looksLikeRepoPath(p)) continue
				if (!/^(?:lib|test|docs|tools)\//.test(p)) continue
				add(owner, p, 'authorization.scope.' + sectionId + '.authorized')
			}
		}
	}
	for (const item of (authDoc && authDoc.derivedConsequences && authDoc.derivedConsequences.items) || []) {
		const text = `${item.what || ''}\n${item.decision || ''}`
		const card = /\b(U\d\d)\b/.exec(text)
		if (!card) continue
		for (const m of text.matchAll(/`([^`]+)`/g)) {
			const p = m[1]
			if (looksLikeRepoPath(p) && /^(?:lib|test|docs|tools)\//.test(p)) {
				add(card[1], p, `authorization.derivedConsequences.${item.id || '?'}`)
			}
		}
	}
	return { quoteVerbatim: qv, quoteSource: qs, extras, citations }
}

export function authorizedUnion(sets, extras) {
	const u = new Set()
	for (const paths of sets.values()) for (const p of paths) u.add(p)
	for (const paths of (extras ? extras.values() : [])) for (const p of paths) u.add(p)
	return u
}

export function pathOwners(sets, extras) {
	const m = new Map()
	const note = (p, card) => {
		if (!m.has(p)) m.set(p, [])
		if (!m.get(p).includes(card)) m.get(p).push(card)
	}
	for (const [card, paths] of sets) for (const p of paths) note(p, card)
	for (const [card, paths] of (extras || new Map())) for (const p of paths) note(p, card)
	return m
}

/** `git status --porcelain=v1` 的一行行 → { tracked, untracked }（纯函数） */
export function splitPorcelainTracked(lines) {
	const tracked = []
	const untracked = []
	for (const raw of Array.isArray(lines) ? lines : []) {
		const line = String(raw).replace(/\r$/, '')
		if (!line.trim()) continue
		if (line.startsWith('??')) { untracked.push(line.slice(3).trim()); continue }
		const code = line.slice(0, 2)
		let rest = line.slice(3).trim()
		let from = null
		if (/[RC]/.test(code)) {
			const parts = rest.split(' -> ')
			if (parts.length === 2) { from = parts[0].trim(); rest = parts[1].trim() }
		}
		tracked.push({ code, path: rest, from })
	}
	return { tracked, untracked }
}

/** 纯函数：tracked 改动（M/D/A/R）是否都落在授权并集里 */
export function classifyTrackedWrites(entries, union) {
	const allowed = []
	const outOfBounds = []
	for (const e of entries) {
		if (union.has(e.path)) allowed.push({ code: e.code, path: e.path })
		else outOfBounds.push({ code: e.code, path: e.path, why: '已跟踪文件被改/删/增/改名，而路径不在任何 U 卡的授权写集里（§6 ∪ §12 授权面）' })
		if (e.from) {
			if (union.has(e.from)) allowed.push({ code: e.code, path: e.from, note: 'rename 来源' })
			else outOfBounds.push({ code: e.code, path: e.from, why: 'rename 的来源路径不在任何 U 卡授权写集里（§6 ∪ §12 授权面）' })
		}
	}
	return { allowed, outOfBounds }
}

/**
 * A08 的**红路径本体**之一：喂人造 porcelain 行，双向钉死。
 * 关键一条：`test/intake.mjs` / `test/mirror-parity.mjs` **只有**靠 §12 授权面才被放行 ——
 * 把 extras 抽掉必须红（这样"授权面真的在起作用、而本卡没动测试"就不是一句空话）。
 */
export function proveScopeBoundary(sets, extras) {
	const union = authorizedUnion(sets, extras)
	const bareUnion = authorizedUnion(sets)
	const rows = []
	const one = (line, expect, why, u = union) => {
		const { tracked } = splitPorcelainTracked([line])
		const r = classifyTrackedWrites(tracked, u)
		const got = r.outOfBounds.length === 0 ? 'allow' : 'reject'
		rows.push({ line, expect, got, ok: got === expect, why, outOfBounds: r.outOfBounds.map((v) => v.path) })
	}
	one(' M lib/author.js', 'allow', '本卡（U13）写集')
	one(' M lib/rebuild-job.js', 'allow', '本卡（U13）写集')
	one(' M lib/mods/plan.js', 'allow', '本卡（U13）写集')
	one(' M lib/pack-model.js', 'allow', 'U09 写集（并发）')
	one(' M lib/point-ref.js', 'allow', 'authorization C4 追加给 U09（并发）')
	one(' M test/intake.mjs', 'allow', '§12 授权给 U10 的 A 面（不是本卡改的）')
	one(' M test/mirror-parity.mjs', 'allow', '§12 授权给 U09 的 A 面')
	one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
	one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
	one(' D test/all.mjs', 'reject', '既有总入口被删')
	one('R  lib/author.js -> lib/whatever.js', 'reject', '改名到野路径（来源合法、目标不合法）')
	one('A  cards/U13.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
	one(' M audit-evidence/U13/runs/U13-1/result.json', 'reject', '证据目录不被 §6 授权（它是 gitignore 的原始证据，只在本卡允许根里）')
	// §12 授权面的**机制**自证（用合成文档，不虚构真实文档里没有的条目）：
	// 现网 authorization.json 的 A 面两条（mirror-parity / intake）在 §6 里也有标注，
	// 所以「抽掉 extras 就红」在真实文档上不成立 —— 这里用一份**合成**授权文本来钉机制本身。
	{
		const synthetic = { scope: { A: { authorized: ['U13 独占 test/synthetic-a-face.mjs 的旧身份预期（合成自证，不是真授权）'] } }, quoteVerbatim: 'q', quoteSource: 's' }
		const syntheticExtras = authorizationExtras(synthetic).extras
		const withExtras = authorizedUnion(sets, syntheticExtras)
		const withoutExtras = authorizedUnion(sets)
		const one2 = (line, expect, why, u) => {
			const { tracked } = splitPorcelainTracked([line])
			const r = classifyTrackedWrites(tracked, u)
			const got = r.outOfBounds.length === 0 ? 'allow' : 'reject'
			rows.push({ line: `(合成授权面) ${line}`, expect, got, ok: got === expect, why, outOfBounds: r.outOfBounds.map((v) => v.path) })
		}
		one2(' M test/synthetic-a-face.mjs', 'allow', '合成授权面：extras 解析出来就放行', withExtras)
		one2(' M test/synthetic-a-face.mjs', 'reject', '合成授权面：**抽掉 extras** 就必须红（机制真的在起作用）', withoutExtras)
	}
	{
		const mixed = classifyTrackedWrites(
			splitPorcelainTracked([' M lib/author.js', ' M lib/render.js', ' M scripts/x.mjs']).tracked, union)
		const got = mixed.outOfBounds.map((v) => v.path).join(',')
		rows.push({
			line: 'MIX[ M lib/author.js | M lib/render.js | M scripts/x.mjs]', expect: 'scripts/x.mjs', got,
			ok: got === 'scripts/x.mjs' && mixed.outOfBounds.length === 1, why: '混合输入只抓野路径',
		})
	}
	return { unionSize: union.size, bareUnionSize: bareUnion.size, cards: sets.size, rows, failures: rows.filter((r) => !r.ok) }
}

/** A08 红路径之二：写允许面的边界（兄弟 lane 的合法写入，对**本卡进程**仍判越界） */
export function proveWriteScope(scope) {
	const s = scope ?? writeAllowScope()
	const cases = [
		[HOST_FILES[0], 'allow', '本卡写集（作者）'],
		[HOST_FILES[3], 'allow', '本卡写集（建点入口）'],
		['docs/unify/receipts/U13.json', 'allow', '本卡写集（tracked 回执）'],
		['test/audit/U13.mjs', 'allow', '本卡写集（本入口）'],
		[path.join(s.roots[0], 'a07-clean', 'lib', 'mods', 'plan.js'), 'allow', 'E:\\Temp 本次临时根下的自建副本'],
		['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
		['lib/pack-model.js', 'reject', 'U09 写集 —— 同上'],
		['test/mirror-parity.mjs', 'reject', 'U09 的 A 面 —— 同上'],
		['lib/unify/text.cjs', 'reject', 'U04 写集 —— 同上'],
		['audit-evidence/U11/pre-change.json', 'reject', '兄弟卡的改前材料（本卡只读）'],
		['lib/whatever.js', 'reject', '野路径'],
		['test/_pack.mjs', 'reject', '既有测试'],
		[path.join(TEMP_PARENT, 'u13-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
		['C:\\Windows\\u13-x.txt', 'reject', '与仓无关的绝对路径'],
	]
	const rows = cases.map(([p, expect, why]) => {
		const c = classifyWriteTarget(p, s)
		const got = c.allowed ? 'allow' : 'reject'
		return { path: p, expect, got, ok: got === expect, why }
	})
	return { rows, failures: rows.filter((r) => !r.ok), roots: s.roots.slice() }
}

/* ── 交付物内容锁 ─────────────────────────────────────────────────────────── */

const CONTENT_LOCK = { hashes: new Map(), checks: 0 }

export function recordContentLock() {
	CONTENT_LOCK.hashes.clear()
	for (const p of WRITE_SET) {
		const abs = path.join(REPO, p)
		assert(fs.existsSync(abs), `内容锁：写集文件不见了 ${p}`)
		CONTENT_LOCK.hashes.set(p, sha256(fs.readFileSync(abs)))
	}
	return { size: CONTENT_LOCK.hashes.size }
}
export function verifyContentLock() {
	CONTENT_LOCK.checks += 1
	const mismatches = []
	for (const [p, want] of CONTENT_LOCK.hashes) {
		const abs = path.join(REPO, p)
		if (!fs.existsSync(abs)) { mismatches.push({ path: p, kind: 'missing' }); continue }
		const got = sha256(fs.readFileSync(abs))
		if (got !== want) mismatches.push({ path: p, kind: 'changed', want, got })
	}
	return { recorded: CONTENT_LOCK.hashes.size, checks: CONTENT_LOCK.checks, mismatches }
}

/* ── 运行期自锚（依赖文件：本次进程开始时 vs 收口前） ─────────────────────── */

const ANCHORS = { at: new Map(), closed: null }

export function recordAnchors() {
	ANCHORS.at.clear()
	for (const p of ANCHOR_FILES) {
		const abs = path.join(REPO, p)
		assert(fs.existsSync(abs), `自锚：依赖文件不见了 ${p}`)
		ANCHORS.at.set(p, sha256(fs.readFileSync(abs)))
	}
	return { size: ANCHORS.at.size }
}
export function verifyAnchors() {
	const now = new Map()
	const changed = []
	for (const [p, want] of ANCHORS.at) {
		const abs = path.join(REPO, p)
		if (!fs.existsSync(abs)) { changed.push({ path: p, kind: 'missing' }); continue }
		const got = sha256(fs.readFileSync(abs))
		now.set(p, got)
		if (got !== want) changed.push({ path: p, kind: 'changed', want, got })
	}
	ANCHORS.closed = { changed, count: now.size }
	return { at: [...ANCHORS.at.entries()].map(([p, h]) => ({ path: p, sha16: h.slice(0, 16) })), changed }
}

/* ══════════════════════════════════════════════════════════════════════
 * 模块加载（仓内 / E:\Temp 副本 / HEAD 旧树 同一套代码）
 * ══════════════════════════════════════════════════════════════════════ */

const MODS = Object.freeze({
	author: 'lib/author.js',
	authorMod: 'lib/mods/author.js',
	create: 'lib/mods/create.js',
	plan: 'lib/mods/plan.js',
	rebuild: 'lib/rebuild-job.js',
	model: 'lib/pack-model.js',
})

async function loadMods(baseDir = REPO) {
	const load = (relPath) => import(pathToFileURL(path.join(baseDir, ...relPath.split('/'))).href)
	const out = { baseDir }
	for (const [key, relPath] of Object.entries(MODS)) out[key] = await load(relPath)
	out.identity = require_(path.join(baseDir, ...KERNEL.split('/')))
	return out
}

/**
 * **HEAD 旧树**：把当前 `lib/` 逐字复制到本次临时根，只把本卡的五个落点换回 `git show HEAD:` 的字节。
 * 于是它就是"改前的这五个文件 + 改后的兄弟模块"——正是本卡要证明"没动别的语义"的对拍对象。
 */
function makeOldTree() {
	const dest = path.join(RUN_TEMP, 'baseline-tree')
	fs.mkdirSync(dest, { recursive: true })
	fs.cpSync(path.join(REPO, 'lib'), path.join(dest, 'lib'), { recursive: true })
	for (const relPath of HOST_FILES) {
		const bytes = gitHeadBytes(relPath)
		assert(bytes !== null, `HEAD 里没有 ${relPath}（旧树建不出来）`)
		fs.writeFileSync(path.join(dest, ...relPath.split('/')), bytes)
	}
	fs.writeFileSync(path.join(dest, 'package.json'),
		JSON.stringify({ name: 'u13-baseline-tree', type: 'module', version: '0.0.0' }, null, 2) + '\n', 'utf8')
	return dest
}

/** 装一个工具（`plugin.install` 捕获唯一的 registerTool）—— @returns 工具定义 */
function installTool(mod, root, { trustedEngine } = {}) {
	let tool = null
	mod.plugin.install({
		paths: { packRoot: root },
		trustedEngine: trustedEngine === undefined ? false : trustedEngine,
		log: { info() {}, warn() {}, error() {} },
		registerTool: (t) => { tool = t },
	})
	assert(tool, `${mod.plugin.id} 没有注册工具`)
	return tool
}

/** 装一个路由模块（`hctx.inject(['connection'], cb)` 的假实现）—— @returns 路由表 */
function installRoutes(mod, root) {
	const routes = []
	mod.plugin.install({
		paths: { packRoot: root },
		trustedEngine: false,
		log: { info() {}, warn() {}, error() {} },
		registerTool: () => {},
		inject: (_caps, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	})
	return routes
}

const callRoute = (route, body) => route.fetch({
	method: 'POST', url: `http://127.0.0.1${route.path}`, headers: { 'content-type': 'application/json' }, json: async () => body,
}).then((r) => r.json())

/* ══════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════ */

const GOOD_NODES = Object.freeze([{
	no: 1,
	title: '探针课',
	deliverable: '一个建得出来的探针课页',
	criteria: 'whale_author commit:true 能落盘',
	why: '它证明创建入口的接线是通的',
	sources: [{ label: '夹具出处（手写声明）', url: 'https://example.invalid/u13' }],
}])
const GOOD_PLAN = Object.freeze({ goal: '把知识点教到能独立写出来', nodes: GOOD_NODES })

let fixtureSeq = 0
/**
 * 造一个**真**课程包目录（`readPack()` 读得出来的那种）。
 *
 * @param {string} tag 名字（同一次运行内唯一）
 * @param {{circles?:Array<object>, intake?:Array<object>, learned?:string[],
 *          flatSources?:string[], tools?:Record<string,string>,
 *          lessonSources?:Array<{circle:string, point:string, number:number, title?:string}>}} spec
 * @returns {string} 包根
 */
function makePack(tag, spec = {}) {
	fixtureSeq += 1
	const root = path.join(RUN_TEMP, 'fixtures', `${String(fixtureSeq).padStart(3, '0')}-${tag}`)
	fs.mkdirSync(root, { recursive: true })
	for (const c of spec.circles || []) {
		const dir = path.join(root, 'lessons', c.id)
		fs.mkdirSync(dir, { recursive: true })
		if (c.brokenHalo) fs.writeFileSync(path.join(dir, 'halo.json'), '{ 这不是合法 JSON\n', 'utf8')
		else writeJson(path.join(dir, 'halo.json'), { halo: c.id, name: c.name || c.id })
		for (const p of c.points || []) {
			const pd = path.join(dir, p.id)
			fs.mkdirSync(pd, { recursive: true })
			const doc = { point: p.id, name: p.name || p.id, fileBase: p.fileBase || 0 }
			if (p.plan) doc.plan = GOOD_PLAN
			if (p.requires) doc.requires = p.requires
			writeJson(path.join(pd, 'point.json'), doc)
		}
	}
	// 「上一课」的真实课程源：`readPack` 只从 `lessons/src/**\/NNNN-*.html` 的 meta 认课，
	// progress.json 的 learned 只决定点亮 —— 所以夹具必须真的写出课程源文件（不是伪造 id）。
	for (const l of spec.lessonSources || []) {
		const file = path.join(root, 'lessons', 'src', l.circle, l.point, `${String(l.number).padStart(4, '0')}-${l.slug || 'prev'}.html`)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file,
			'<script type="application/json" data-lesson-meta>\n'
			+ JSON.stringify({ title: l.title || '上一课', number: l.number }, null, 2)
			+ '\n</script>\n<!doctype html><title>上一课</title>\n', 'utf8')
	}
	writeJson(path.join(root, 'progress.json'), { learned: (spec.learned || []).slice() })
	for (const name of spec.flatSources || []) {
		const f = path.join(root, 'lessons', 'src', name)
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f, '<!doctype html><title>历史平铺夹具</title>\n', 'utf8')
	}
	for (const [relPath, body] of Object.entries(spec.tools || {})) {
		const f = path.join(root, ...relPath.split('/'))
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f, body, 'utf8')
	}
	if (spec.intake) {
		const f = path.join(root, 'learning-records', 'intake.jsonl')
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f, spec.intake.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
	}
	return root
}

const intakeRecord = (point, level, goal, at) => ({ point, level, goal, at })
const WORK = (tag) => path.join(RUN_TEMP, 'work', tag)

/** 结果里的绝对临时路径归一成 `<root>`（旧树/新树在同一批夹具上跑，落点不同） */
function normalizePaths(value, root) {
	const abs = JSON.stringify(path.resolve(root)).slice(1, -1)
	return JSON.parse(JSON.stringify(value).split(abs).join('<root>'))
}

/* ══════════════════════════════════════════════════════════════════════
 * 判官（A01–A06 与 A07 的变异副本用**同一份**判官；A07 只是把模块换成变异副本）
 * ══════════════════════════════════════════════════════════════════════ */

const AUTHOR_BASE = Object.freeze({
	halo: 'a', point: 'ok', number: 1, title: '探针课', slug: 'probe', hintTerm: '示波器',
	source: { label: '夹具出处', url: 'https://example.invalid/u13' },
})

/**
 * U18（`lib/gate.js` 的 `challengeGate`）新增的 fail-closed 分支：**上一课的归属不唯一**。
 *
 * 出处逐字取 `lib/gate.js` 里 `scope.ambiguous` 那支的 `why`（A05 会对着源码再复核一遍）。
 * 为什么必须失败关闭：跨圈同名点的"上一课"会拿另一个圈的课 / 判据 / 证据判这门课 ——
 * 放行等于把缺证据扩大成通过；既然算不出唯一归属，宁可不放行，也不猜。
 *
 * ⚠️ 本卡只**消费**它：`lib/**` 不在 U13 本次写集里（它是 U18 的交付物），这里一个字节都不改。
 * ⚠️ 它住在 `commit && !force` 的教学闸里 ⇒ `force:true` 会跳过它（但必须逐字留痕）。
 *    A04 钉的是这条**实际边界**；任务卡里"force 不许绕过"的假设与代码不符，已随证据上报。
 */
const U18_GATE_WHY = '上一课的归属不唯一：放行会把缺证据扩大成通过，所以这里失败关闭'
const U18_GATE_ERROR = `拒绝生成新课：${U18_GATE_WHY}`
const U18_GATE_STATE = 'u18-fail-closed'
const U18_GATE_TAG = 'author:上一课归属不唯一'
/** 决-1 之后工具入口的两个零写入样本：显式圆圈走到摸底闸 / 裸点跨圈同名被结构闸拒绝 */
const U13_DECISION_TAG = 'author:显式圆圈=确定归属（摸底闸）'
const U13_BARE_TAG = 'author:裸点跨圈同名（拒绝猜圈）'
/** 决-1 之后挑战闸的真见证：上一课在快照里没有判据 ⇒ no-snapshot（plain 拒 / force 留痕）
 *  ⚠️ `mods/author.js` 拼回执时用的是门禁的 `why`（= judgeSnapshot 的 hint），不是 `error` ——
 *     这里逐字钉的就是调用方真正拿到的那个字符串（两条分开存，别把两者混成一句）。 */
const CHALLENGE_NO_SNAPSHOT = '拒绝生成新课：先跑 whale_state write:true 生成判据快照'
const CHALLENGE_GATE_ERROR = '上一课《b/gate/0001》的挑战**未检测**（no-snapshot）：先跑 whale_state write:true 生成判据快照'
const CHALLENGE_BYPASS_TEXT = '上一课挑战：先跑 whale_state write:true 生成判据快照'

/** 判官只**记录**违规、不抛（A07 要拿同一份判官跑变异副本；抛了就看不出全部检出项） */
function treeNotEqual(violations, before, after, state, msg) {
	if (JSON.stringify(before) !== JSON.stringify(after)) violations.push({ state, msg })
}
function jsonNotEqual(violations, actual, expected, state, msg) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) violations.push({ state, msg: `${msg}（实得 ${fmt(actual)} / 期望 ${fmt(expected)}）` })
}

/**
 * A01 + A02 + A03 + A04 的本体：**规范身份**四条面（创建结果 / 跨圈隔离 / 零写 / force 边界）。
 * @param {object} mods `loadMods()` 的产物
 * @param {string} workRoot 本次判官的落点
 */
export async function judgeIdentity(mods, workRoot) {
	const violations = []
	const observed = {}
	const note = (state, msg) => violations.push({ state, msg })
	const id = mods.identity
	void workRoot
	/** 判官只**记录**违规，不抛（A07 要拿同一份判官跑变异副本，抛了就看不出全部检出项） */
	const checkTree = (before, after, state, msg) => treeNotEqual(violations, before, after, state, msg)
	const checkJson = (actual, expected, state, msg) => jsonNotEqual(violations, actual, expected, state, msg)

	/* ── ① 作者：落点 = 内核的 circle/point（文件名 NNNN 与内核 lessonKey 末段一致） ── */
	{
		const made = mods.author.authorLesson({ ...AUTHOR_BASE, point: 'vue', number: 1 })
		const key = id.pointKey('a', 'vue')
		const lessonKey = id.lessonKey('a', 'vue', 1)
		const wantFile = `lessons/src/${key}/${lessonKey.split('/').pop()}-probe.html`
		observed.authorLesson = { file: made.file, wantFile, key, lessonKey }
		if (made.file !== wantFile) note('author-file', `authorLesson 的落点应是 ${wantFile}，实得 ${made.file}`)
		if (!made.file.startsWith(`lessons/src/${key}/`)) note('author-file', 'authorLesson 的落点没有带完整知识点身份')
		const flat = mods.author.authorLesson({ ...AUTHOR_BASE, halo: undefined, point: 'vue' })
		observed.flat = flat.file
		if (flat.file !== `lessons/src/vue/${lessonKey.split('/').pop()}-probe.html`) {
			note('author-flat', `缺圆圈时不许猜圆圈（应退回平铺 lessons/src/vue/…），实得 ${flat.file}`)
		}
	}

	/* ── ② 工具面：未 commit 也是完整身份、写入调用为零 ── */
	{
		const root = makePack('a01-noncommit', { circles: [{ id: 'a', points: [{ id: 'ok', plan: true }] }] })
		const tool = installTool(mods.authorMod, root)
		const before = treeOf(root)
		const r = await tool.execute({ ...AUTHOR_BASE, commit: false })
		observed.nonCommit = { ok: r.ok, wrote: r.wrote, file: r.file, valid: r.valid }
		if (r.ok !== true || r.wrote !== false) note('noncommit', `未 commit 应当 ok:true / wrote:false，实得 ${fmt({ ok: r.ok, wrote: r.wrote })}`)
		if (r.file !== 'lessons/src/a/ok/0001-probe.html') note('noncommit', `未 commit 的落点应是完整身份路径，实得 ${r.file}`)
		checkTree(before, treeOf(root), 'noncommit', '未 commit 不许写盘')
	}

	/* ── ③ 工具面：commit 落地后 readPack 读出规范课次身份 ── */
	{
		const root = makePack('a01-commit', {
			circles: [{ id: 'a', points: [{ id: 'ok', plan: true }] }],
			intake: [intakeRecord('a/ok', '有基础', '能独立写', '2026-10-01')],
		})
		const tool = installTool(mods.authorMod, root)
		const r = await tool.execute({ ...AUTHOR_BASE, commit: true })
		observed.commit = { ok: r.ok, wrote: r.wrote, file: r.file, err: r.error || null, rebuild: r.rebuild ? { blocked: r.rebuild.blocked } : null }
		if (r.ok !== true || r.wrote !== true) note('commit', `commit:true 应当落盘成功（实得 ${fmt({ ok: r.ok, wrote: r.wrote, err: r.error })}）`)
		const abs = path.join(root, ...String(r.file || '').split('/'))
		if (!fs.existsSync(abs)) note('commit', `回执给的落点文件不存在：${r.file}`)
		const pack = mods.model.readPack(root)
		const pick = (pack.lessons || []).find((l) => l.point === 'ok')
		observed.commitLesson = pick ? pick.id : null
		if (!pick) note('commit', 'readPack 没读出刚建的课')
		else if (pick.id !== id.lessonKey('a', 'ok', 1)) note('commit', `readPack 的课程 id 应是规范课次键 a/ok/0001，实得 ${pick.id}`)
		else if (pick.circle !== 'a' || pick.point !== 'ok') note('commit', `课程的 circle/point 应逐字是 a / ok，实得 ${pick.circle} / ${pick.point}`)
	}

	/* ── ④ 建点入口：回执的 id = 规范身份；盘上落点与身份同一分层 ── */
	{
		const root = makePack('a01-point', { circles: [{ id: 'programming', points: [{ id: 'vue', plan: true }] }] })
		const routes = installRoutes(mods.create, root)
		const pointRoute = routes.find((r) => r.path === '/api/whale/point')
		if (!pointRoute) note('create-point', '建点路由没注册上')
		else {
			const body = await callRoute(pointRoute, { circle: 'programming', id: 'solid', name: 'SOLID' })
			observed.createPoint = { ok: body.ok, id: body.id, path: body.path }
			if (body.ok !== true) note('create-point', `建点应当成功（${body.error || ''}）`)
			if (body.id !== id.pointKey('programming', 'solid')) note('create-point', `建点回执的 id 应是 programming/solid，实得 ${fmt(body.id)}`)
			if (body.path !== 'lessons/programming/solid/point.json') note('create-point', `建点回执的 path 应是 lessons/programming/solid/point.json，实得 ${fmt(body.path)}`)
			if (!fs.existsSync(path.join(root, 'lessons', 'programming', 'solid', 'point.json'))) note('create-point', '建点回执说成功了，但 point.json 不在盘上')
			const pack = mods.model.readPack(root)
			const pt = (pack.points || []).find((p) => p.id === 'solid')
			if (!pt || pt.circle !== 'programming') note('create-point', 'readPack 读出来的新点没有归到 programming 圆圈')
		}
	}

	/* ── ⑤ A02：跨圈同名点不串（摸底 / 目标 / 拒写） ── */
	{
		const root = makePack('a02-cross', {
			circles: [
				{ id: 'a', points: [{ id: 'x', plan: true }, { id: 'vue', plan: true }] },
				{ id: 'b', points: [{ id: 'x', plan: true }] },
			],
			intake: [intakeRecord('a/x', 'A 级', 'A 目标', '2026-10-01')],
		})
		const planTool = installTool(mods.plan, root)
		const authorTool = installTool(mods.authorMod, root)

		// 大纲：裸 x 在两圈都有 → 拒绝 + 两个 point.json 一个字节都不动
		const before = treeOf(root)
		const amb = await planTool.execute({ op: 'record', point: 'x', goal: GOOD_PLAN.goal, nodes: GOOD_NODES })
		observed.planAmbiguous = { ok: amb.ok, ambiguous: amb.ambiguous, candidates: amb.candidates, error: String(amb.error || '').slice(0, 140) }
		if (amb.ok !== false || amb.ambiguous !== true) note('plan-ambiguous', `裸 x 必须被大纲入口拒绝（实得 ${fmt({ ok: amb.ok, ambiguous: amb.ambiguous })}）`)
		checkJson(Array.isArray(amb.candidates) ? amb.candidates.slice().sort() : amb.candidates, ['a/x', 'b/x'], 'plan-ambiguous', '大纲入口的歧义拒绝必须列出两个候选')
		checkTree(before, treeOf(root), 'plan-ambiguous', '歧义拒绝时一个字节都不许写')

		// 大纲：写 a/x 只动 a/x 的 point.json
		const okA = await planTool.execute({ op: 'record', point: 'a/x', goal: 'A 的目标', nodes: GOOD_NODES })
		observed.planA = { ok: okA.ok, point: okA.point, file: okA.file }
		if (okA.ok !== true) note('plan-write', `a/x 的大纲应当写得进去（${okA.error || ''}）`)
		if (okA.point !== 'a/x') note('plan-write', `写 a/x 之后回执的 point 应是 a/x，实得 ${fmt(okA.point)}`)
		const beforeB = findIn(before, 'lessons/b/x/point.json')
		const bNow = sha256(fs.readFileSync(path.join(root, 'lessons', 'b', 'x', 'point.json')))
		observed.planTargets = { bBefore: beforeB && beforeB.sha256.slice(0, 16), bNow: bNow.slice(0, 16) }
		if (!beforeB || beforeB.sha256 !== bNow) note('plan-target', '写 a/x 的大纲时把 b/x 的 point.json 也动了（串目标）')

		// 摸底：a/x 的记载不被 b/x 看见，反之亦然
		const nonA = await authorTool.execute({ ...AUTHOR_BASE, point: 'x', halo: 'a', commit: false })
		const nonB = await authorTool.execute({ ...AUTHOR_BASE, point: 'x', halo: 'b', commit: false })
		const nonBare = await authorTool.execute({ ...AUTHOR_BASE, point: 'x', halo: undefined, commit: false })
		observed.intakeCross = { a: nonA.intake, b: nonB.intake, bare: nonBare.intake, bareFile: nonBare.file }
		if (!nonA.intake || nonA.intake.done !== true) note('intake-cross', `a/x 摸过底，a 圈应当 done:true（实得 ${fmt(nonA.intake)}）`)
		if (!nonB.intake || nonB.intake.done !== false) note('intake-cross', `b/x 没摸过底，b 圈必须 done:false（实得 ${fmt(nonB.intake)}）`)
		if (!nonBare.intake || nonBare.intake.done !== false) note('intake-noguess', `裸 x 歧义时不许猜一圈的摸底（实得 ${fmt(nonBare.intake)}）`)
		if (String(nonBare.file) !== 'lessons/src/x/0001-probe.html') {
			note('intake-noguess', `裸 x 歧义时落点应退回平铺（不许猜圆圈），实得 ${fmt(nonBare.file)}`)
		}
	}

	/* ── ⑥ A03：缺归属 / 身份不合法 ⇒ 写入调用为零 ── */
	{
		const root = makePack('a03-zero', {
			circles: [
				{ id: 'a', points: [{ id: 'ok', plan: true }, { id: 'noplan' }] },
				// b/solo：**上一课归属唯一**（只有 b 圈声明）且有大纲 ⇒ 才能真的走到摸底闸。
				// b/ok 与 a/ok 同名 ⇒ 留给下面新增的 U18 新闸样本（归属不唯一）。
				{ id: 'b', points: [{ id: 'ok', plan: true }, { id: 'solo', plan: true }] },
			],
			intake: [intakeRecord('a/ok', '有基础', '能写', '2026-10-02')],
		})
		const authorTool = installTool(mods.authorMod, root)
		const planTool = installTool(mods.plan, root)
		const routes = installRoutes(mods.create, root)
		const pointRoute = routes.find((r) => r.path === '/api/whale/point')
		const circleRoute = routes.find((r) => r.path === '/api/whale/circle')
		const before = treeOf(root)
		const rows = []
		/** @param {RegExp|string} expect 正则匹配；**字符串 = 逐字全等**（新闸那条要逐字） */
		const zero = async (tag, fn, expect) => {
			const counted = await withWriteCounter(fn)
			const r = counted.value
			const ok = !!r && r.ok === false
			const error = String((r && r.error) || '')
			const matched = expect === undefined || expect === null
				? true
				: typeof expect === 'string' ? error === expect : expect.test(error)
			rows.push({ tag, writes: counted.count, ok, matched, error: error.slice(0, 120) })
			if (counted.count !== 0) note('zero-write', `${tag}：拒绝时写入调用应为 0 次，实得 ${counted.count} 次（${counted.ops.join(',')}）`)
			if (!ok) note('zero-write', `${tag}：应当被拒（ok:false），实得 ${fmt(r && r.ok)}`)
			if (!matched) note('zero-write', `${tag}：拒绝理由不符合预期（实得 ${fmt(r && r.error)}）`)
		}
		await zero('author:halo 穿越', () => authorTool.execute({ ...AUTHOR_BASE, halo: '../escaped', commit: true }), /id 不合法/)
		await zero('author:halo 绝对路径', () => authorTool.execute({ ...AUTHOR_BASE, halo: 'C:/Windows', commit: true }), /id 不合法/)
		await zero('author:point 穿越', () => authorTool.execute({ ...AUTHOR_BASE, point: '../../escaped', commit: true }), /id 不合法/)
		await zero('author:未知点', () => authorTool.execute({ ...AUTHOR_BASE, point: 'nope', commit: true }), /未知知识点/)
		await zero('author:点圈对不上', () => authorTool.execute({ ...AUTHOR_BASE, point: 'noplan', halo: 'b', commit: true }), /点 \/ 圈 对不上/)
		await zero('author:schema(number=0)', () => authorTool.execute({ ...AUTHOR_BASE, point: 'noplan', number: 0, commit: true }), /number 必须是/)
		await zero('author:没大纲', () => authorTool.execute({ ...AUTHOR_BASE, point: 'noplan', commit: true }), /没有大纲/)
		// 夹具改成**上一课归属唯一**的 b/solo（原来用 b/ok，U18 之后会先命中新闸）—— 保住"真的命中摸底闸"的原意
		await zero('author:没摸底', () => authorTool.execute({ ...AUTHOR_BASE, point: 'solo', halo: 'b', commit: true }), /先做学情摸底/)
		// Δ（决-1 / 2026-10-20 授权）：**显式 halo = 已经确定的身份** —— b/ok 不再被误拦成
		// 「上一课的归属不唯一」，而是走到它该停的闸（这个夹具没做 b/ok 的摸底 ⇒ 摸底闸），
		// 仍然零写入、拒绝理由逐字。
		await zero('author:显式圆圈=确定归属（摸底闸）',
			() => authorTool.execute({ ...AUTHOR_BASE, point: 'ok', halo: 'b', commit: true }),
			'先做学情摸底：ok 还没有 intake 记录')
		// 裸点跨圈同名**仍然 fail-closed**：结构闸（比教学闸更早）要求显式给 halo，零写入、理由逐字。
		// 这证明决-1 没有把"算不出归属"放宽成"猜一个圈"。
		await zero('author:裸点跨圈同名（拒绝猜圈）',
			() => authorTool.execute({ ...AUTHOR_BASE, point: 'ok', halo: undefined, commit: true }),
			'知识点 id「ok」在 2 个圆圈里都有（a / b）—— 必须显式给 halo 才能唯一识别（拒绝猜）')
		await zero('plan:歧义点', () => planTool.execute({ op: 'record', point: 'ok', goal: 'g', nodes: GOOD_NODES }), /圆圈里都有/)
		await zero('plan:未知点', () => planTool.execute({ op: 'record', point: 'nope', goal: 'g', nodes: GOOD_NODES }), /找不到这个知识点/)
		if (pointRoute) {
			await zero('create:point 坏 id', () => callRoute(pointRoute, { circle: 'a', id: 'Bad_Id', name: 'X' }), /id 不合法/)
			await zero('create:point 圆圈不存在', () => callRoute(pointRoute, { circle: 'ghost', id: 'g', name: 'X' }), /不存在/)
			await zero('create:point 身份不合法', () => callRoute(pointRoute, { circle: '../x', id: 'g', name: 'X' }), /id 不合法/)
		}
		if (circleRoute) await zero('create:circle 坏 id', () => callRoute(circleRoute, { id: 'Bad Id', name: 'X' }), /id 不合法/)
		observed.zeroWrite = rows
		checkTree(before, treeOf(root), 'zero-write', '拒绝面之后包树必须逐字节未变')
	}

	/* ── ⑦ A04：force 也绕不过路径 / 结构；新闸的实际 force 边界；还绕得过摸底闸（正面控制） ── */
	{
		const root = makePack('a04-force', {
			circles: [
				// a/solo：上一课归属唯一 + 摸底已做 + 有大纲 ⇒ 「已存在（拒覆盖）」这条能真的落到发布那一步
				{ id: 'a', points: [{ id: 'ok', plan: true }, { id: 'noplan' }, { id: 'solo', plan: true }] },
				// b/ok 与 a/ok 同名（决-1 的误拦转正样本）；b/pctl 归属唯一且没摸底 ⇒ 正面控制（force 绕摸底）；
				// b/gate 有**上一课 b/gate/0001** 且没有判据快照 ⇒ 挑战闸的 force 边界用真闸见证
				{ id: 'b', points: [{ id: 'ok', plan: true }, { id: 'pctl', plan: true }, { id: 'gate', plan: true }] },
			],
			// 「上一课」必须真的存在于 `lessons/src/**`（readPack 只从课程源 meta 认课）
			lessonSources: [{ circle: 'b', point: 'gate', number: 1 }],
			intake: [
				intakeRecord('a/ok', '有基础', '能写', '2026-10-04'),
				intakeRecord('a/solo', '有基础', '能写', '2026-10-04'),
			],
		})
		const broken = makePack('a04-broken', { circles: [{ id: 'a', brokenHalo: true, points: [{ id: 'ok', plan: true }] }] })
		const authorTool = installTool(mods.authorMod, root)
		const brokenTool = installTool(mods.authorMod, broken)
		const rows = []
		const probe = async (tag, tool, args, expectPattern) => {
			const plain = await tool.execute({ ...args, commit: true })
			const forced = await tool.execute({ ...args, commit: true, force: true })
			rows.push({
				tag,
				plain: { ok: plain.ok, error: String(plain.error || '').slice(0, 100) },
				forced: { ok: forced.ok, error: String(forced.error || '').slice(0, 100) },
			})
			if (forced.ok !== false) note('force', `${tag}：force:true 也不许放行（实得 ok:${fmt(forced.ok)}）`)
			if (!expectPattern.test(String(forced.error))) note('force', `${tag}：force 下的拒绝理由不符合预期（实得 ${fmt(forced.error)}）`)
			if (String(forced.error) !== String(plain.error)) note('force', `${tag}：force 下的拒绝理由必须与不带 force 时逐字相同`)
		}
		await probe('穿越 halo', authorTool, { ...AUTHOR_BASE, halo: '../../../escaped' }, /id 不合法/)
		await probe('绝对 halo', authorTool, { ...AUTHOR_BASE, halo: 'C:/Windows' }, /id 不合法/)
		await probe('穿越 point', authorTool, { ...AUTHOR_BASE, point: '../../escaped' }, /id 不合法/)
		await probe('未知点', authorTool, { ...AUTHOR_BASE, point: 'nope' }, /未知知识点/)
		await probe('点圈对不上', authorTool, { ...AUTHOR_BASE, point: 'noplan', halo: 'b' }, /点 \/ 圈 对不上/)
		await probe('坏包配置', brokenTool, { ...AUTHOR_BASE }, /配置坏了/)
		// 已存在（拒覆盖）：先放一个文件在落点上，再原样重放（force 也绕不过）
		const target = path.join(root, 'lessons', 'src', 'a', 'solo', '0001-probe.html')
		const frozen = '<!doctype html><title>已存在</title>\n'
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.writeFileSync(target, frozen, 'utf8')
		await probe('已存在（拒覆盖）', authorTool, { ...AUTHOR_BASE, point: 'solo' }, /拒绝覆盖/)
		if (sha256(fs.readFileSync(target)) !== sha256(Buffer.from(frozen))) note('force', '拒覆盖被绕过了：已存在的文件内容被改了')
		// Δ（决-1）：挑战闸的 force 边界改用**真挑战闸**见证（不再靠"归属不唯一"的误拦）。
		// b/gate 有上一课 b/gate/0001、没有判据快照：plain 必须被挑战闸拦下（no-snapshot，理由逐字）；
		// force 会跳过**整个教学闸**，所以这里钉的是「绕过也不许静默」——forced.bypassed 必须逐字点名。
		// ⚠️ 若将来把这支提到 force 之前（fail-closed 到底），下面 forced.ok 的期望要同步改成 false。
		const gatePlain = await authorTool.execute({ ...AUTHOR_BASE, point: 'gate', halo: 'b', commit: true })
		const gateForced = await authorTool.execute({ ...AUTHOR_BASE, point: 'gate', halo: 'b', commit: true, force: true })
		const gateBypassed = (gateForced.forced && gateForced.forced.bypassed) || []
		rows.push({
			tag: '上一课挑战闸（force 边界）',
			plain: {
				ok: gatePlain.ok, error: String(gatePlain.error || ''),
				code: (gatePlain.challenge && gatePlain.challenge.code) || null,
				gateError: String((gatePlain.challenge && gatePlain.challenge.error) || ''),
				needsChallenge: gatePlain.needsChallenge === true,
			},
			forced: {
				ok: gateForced.ok, wrote: gateForced.wrote === true, error: String(gateForced.error || ''),
				code: (gateForced.challenge && gateForced.challenge.code) || null,
			},
			bypassed: gateBypassed,
		})
		if (gatePlain.ok !== false) note('force', '挑战闸：不带 force 时必须拒绝（实得 ok:true）')
		if (String(gatePlain.error || '') !== CHALLENGE_NO_SNAPSHOT) note('force', `挑战闸：plain 的拒绝理由必须逐字（实得 ${fmt(gatePlain.error)}）`)
		if (String((gatePlain.challenge && gatePlain.challenge.error) || '') !== CHALLENGE_GATE_ERROR) note('force', `挑战闸：挑战闸自己的 error 必须逐字（实得 ${fmt(gatePlain.challenge && gatePlain.challenge.error)}）`)
		if (((gatePlain.challenge && gatePlain.challenge.code) || null) !== 'no-snapshot') note('force', '挑战闸：plain 的回执必须点名 no-snapshot（真的是挑战闸在判）')
		if (gateForced.ok !== true || gateForced.wrote !== true) note('force', `挑战闸：现状是 force 跳过整个教学闸（应落盘成功）；实得 ${fmt({ ok: gateForced.ok, err: gateForced.error })}`)
		if (!gateBypassed.some((x) => String(x) === CHALLENGE_BYPASS_TEXT)) note('force', `挑战闸：force 绕过它时必须在 forced.bypassed 里逐字点名（实得 ${fmt(gateBypassed)}）`)
		// 正面控制：force 仍然**能**绕摸底闸（不然"不放宽"就变成了"force 失效"）
		const positive = await authorTool.execute({ ...AUTHOR_BASE, point: 'pctl', halo: 'b', commit: true, force: true })
		const bypassed = (positive.forced && positive.forced.bypassed) || []
		rows.push({ tag: '正面控制：force 绕摸底闸', forced: { ok: positive.ok, wrote: positive.wrote, bypassed } })
		if (positive.ok !== true || positive.wrote !== true) note('force', `force 应当仍然能绕过摸底闸（实得 ${fmt({ ok: positive.ok, err: positive.error })}）`)
		if (!bypassed.some((x) => /学情摸底/.test(String(x)))) note('force', `force 留痕必须点名被绕过的摸底闸（实得 ${fmt(bypassed)}）`)
		observed.force = rows
	}

	return { violations, observed, workRoot }
}

/**
 * A05 的本体：**顺序矩阵**（行为级）。
 *
 * 顺序（相邻两条用"同一夹具同时踩两道闸"证明，不是把新闸塞到最后当兜底）：
 *   id 形状 > 结构 > schema > 大纲 > **上一课挑战闸** > 摸底
 *
 * 三组对照（决-1 之后，工具入口传的是**规范身份**；裸点的 fail-closed 由结构闸与门禁 API 两面见证）：
 *   ① 归属**唯一**（只有 b 圈声明 y）→ b/y 照旧停在**摸底闸**；
 *   ② 归属**不唯一**但**显式给了圆圈**（a/b 都声明 y，halo=b）→ b/y 也停在**摸底闸**
 *      —— 这就是决-1 修掉的误拦：圆圈解析出来了，身份就是确定的，不许再被降维成"算不出来"；
 *   ③ **挑战闸排在摸底闸之前**：b/z 有大纲、没摸底、但有上一课 b/z/0001 且没有判据快照
 *      ⇒ 停在挑战闸（no-snapshot），而不是摸底闸。
 *   裸点跨圈同名（不传 halo）仍然 fail-closed：结构闸要求显式 halo；门禁 API 直接给裸点时
 *   回 `ambiguous-point` 并列出两个候选（见 gateApi.bare）。
 */
export async function judgeOrder(mods, workRoot) {
	const violations = []
	const observed = { precedence: [], workRoot, pair: null, gateApi: null }
	const note = (state, msg) => violations.push({ state, msg })
	const root = makePack('a05-order', {
		circles: [
			// a/x：**有大纲、没摸底**（用来证明「大纲闸放行之后才是摸底闸」）
			// a/y：没大纲；b/y：有大纲（用来证明大纲闸按**同圈**判，不拿别的圈的 plan 放行）
			// a/y 与 b/y 同名 ⇒ 裸点归属不唯一（结构闸 + 门禁 API 各自 fail-closed）
			// b/z：有大纲、没摸底、**有上一课** ⇒ 挑战闸的位置用真闸见证
			{ id: 'a', points: [{ id: 'ok', plan: true }, { id: 'noplan' }, { id: 'x', plan: true }, { id: 'y' }] },
			{ id: 'b', points: [{ id: 'y', plan: true }, { id: 'z', plan: true }] },
		],
		lessonSources: [{ circle: 'b', point: 'z', number: 1 }],
		intake: [intakeRecord('a/ok', '有基础', '能写', '2026-10-03')],
	})
	const tool = installTool(mods.authorMod, root)

	/** 把一个回执归到它**实际命中的闸**（矩阵必须说清"这一条停在哪一闸"） */
	const gateOf = (r, error) => {
		if (r && r.needsPlan === true) return 'plan'
		if (r && r.needsChallenge === true) {
			return (r.challenge && r.challenge.code) === 'ambiguous-point' ? U18_GATE_STATE : 'challenge'
		}
		if (r && r.needsIntake === true) return 'intake'
		if (/id 不合法/.test(error)) return 'id-shape'
		if (/未知知识点/.test(error)) return 'structure'
		return 'schema'
	}
	const matches = (want, err) => (typeof want === 'string' ? err === want : want.test(err))
	const wantText = (want) => (want instanceof RegExp ? String(want) : `「${want}」`)

	const cases = [
		{ id: 'id形状 > 结构', gate: 'id-shape', args: { ...AUTHOR_BASE, halo: '../x', point: 'nosuch' }, want: /id 不合法/ },
		{ id: '结构 > schema', gate: 'structure', args: { ...AUTHOR_BASE, point: 'nosuch', slug: 'BAD' }, want: /未知知识点/ },
		{ id: 'schema > 大纲(number)', gate: 'schema', args: { ...AUTHOR_BASE, point: 'noplan', number: 0 }, want: /number 必须是/ },
		{ id: 'schema > 大纲(title)', gate: 'schema', args: { ...AUTHOR_BASE, point: 'noplan', title: '   ' }, want: /title 必填/ },
		{ id: 'schema > 大纲(source)', gate: 'schema', args: { ...AUTHOR_BASE, point: 'noplan', source: { label: '', url: '' } }, want: /source\.label/ },
		{ id: '大纲 > 摸底', gate: 'plan', args: { ...AUTHOR_BASE, point: 'noplan' }, want: /没有大纲/ },
		// 大纲闸排在挑战闸之前：同一点在另一个圈没有大纲，也先吃大纲拒绝（不是挑战闸抢先）
		{ id: '大纲 > 挑战闸', gate: 'plan', args: { ...AUTHOR_BASE, point: 'y', halo: 'a' }, want: /没有大纲/ },
		// 挑战闸排在摸底闸之前：b/z 有大纲、**没有**摸底，却有上一课 b/z/0001 且没有判据快照 ⇒ 停在挑战闸
		{ id: '挑战闸 > 摸底', gate: 'challenge', args: { ...AUTHOR_BASE, point: 'z', halo: 'b' }, want: CHALLENGE_NO_SNAPSHOT },
		// **决-1 的误拦转正**：a/y 与 b/y 都声明，但调用方显式给了 halo=b ⇒ 身份确定，照旧停在摸底闸
		{ id: '决-1 > 摸底', gate: 'intake', args: { ...AUTHOR_BASE, point: 'y', halo: 'b' }, want: /先做学情摸底/ },
		// 摸底闸仍在最后：x 归属唯一（只有 a 圈声明）⇒ 一路走到摸底闸
		{ id: '摸底', gate: 'intake', args: { ...AUTHOR_BASE, point: 'x', halo: 'a' }, want: /先做学情摸底/ },
	]
	for (const c of cases) {
		const r = await tool.execute({ ...c.args, commit: true })
		const error = String(r.error || '')
		const row = {
			id: c.id, gate: gateOf(r, error), ok: r.ok === true,
			needsPlan: r.needsPlan === true, needsIntake: r.needsIntake === true, needsChallenge: r.needsChallenge === true,
			challengeCode: (r.challenge && r.challenge.code) || null,
			error: error.slice(0, 160),
		}
		observed.precedence.push(row)
		if (r.ok !== false) note('precedence', `${c.id}：应当被拒（实得 ok:${fmt(r.ok)}）`)
		if (!matches(c.want, error)) note('precedence', `${c.id}：拒绝理由应是 ${wantText(c.want)}（实得 ${fmt(error)}）`)
		if (row.gate !== c.gate) note('precedence', `${c.id}：应当命中的闸是 ${c.gate}，实得 ${row.gate}（${fmt(row)}）`)
	}

	/* ── 对照对：归属唯一 ⇒ 摸底闸；归属不唯一但**显式给圈** ⇒ 也是摸底闸（决-1） ── */
	{
		const canonRow = observed.precedence.find((r) => r.id === '决-1 > 摸底') || null
		// ① 只声明 b/y（归属唯一）——同一形状的建课请求必须照旧停在摸底闸
		const uniqRoot = makePack('a05-order-unique', {
			circles: [
				{ id: 'a', points: [{ id: 'ok', plan: true }, { id: 'x', plan: true }] },
				{ id: 'b', points: [{ id: 'y', plan: true }] },
			],
			intake: [intakeRecord('a/ok', '有基础', '能写', '2026-10-03')],
		})
		const uniqTool = installTool(mods.authorMod, uniqRoot)
		const uniqRun = await uniqTool.execute({ ...AUTHOR_BASE, point: 'y', halo: 'b', commit: true })
		const uniqError = String(uniqRun.error || '')
		const uniqRow = {
			fixture: 'a05-order-unique（只有 b 圈声明 y）', ok: uniqRun.ok, gate: gateOf(uniqRun, uniqError),
			needsPlan: uniqRun.needsPlan === true, needsIntake: uniqRun.needsIntake === true,
			needsChallenge: uniqRun.needsChallenge === true, error: uniqError.slice(0, 160),
		}
		// ② 裸点（不传 halo）跨圈同名：工具入口仍然 fail-closed —— 由**结构闸**拒（比教学闸更早），
		//    绝不"猜一个圈继续"。
		const bareRun = await tool.execute({ ...AUTHOR_BASE, point: 'y', halo: undefined, commit: true })
		const bareError = String(bareRun.error || '')
		const bareRow = {
			fixture: 'a05-order（裸 y，不传 halo）', ok: bareRun.ok, gate: gateOf(bareRun, bareError),
			needsPlan: bareRun.needsPlan === true, needsIntake: bareRun.needsIntake === true,
			needsChallenge: bareRun.needsChallenge === true, needsHalo: /必须显式给 halo/.test(bareError),
			error: bareError.slice(0, 160),
		}
		observed.pair = {
			explicitCircle: { fixture: 'a05-order（a/y 与 b/y 都声明，显式 halo=b）', ...(canonRow || {}) },
			unique: uniqRow,
			barePoint: bareRow,
		}
		if (!canonRow || canonRow.gate !== 'intake' || canonRow.ok !== false) {
			note('decision-1', `显式 halo 的 b/y 必须走到摸底闸（决-1 之前的误拦必须消失；实得 ${fmt(canonRow)}）`)
		}
		if (canonRow && canonRow.needsChallenge === true) note('decision-1', '显式 halo 的 b/y 不该再命中挑战闸的 ambiguous-point')
		if (canonRow && canonRow.challengeCode !== null) note('decision-1', `显式 halo 的 b/y 回执不该再带挑战闸的拒绝码（实得 ${fmt(canonRow.challengeCode)}）`)
		if (uniqRow.ok !== false || uniqRow.gate !== 'intake') note('plan-scope', `归属唯一时的 b/y 必须照旧停在摸底闸（实得 ${fmt(uniqRow)}）`)
		if (uniqRow.needsPlan === true) note('plan-scope', `归属唯一时的 b/y 不该被判"没有大纲"（实得 ${fmt(uniqRow)}）`)
		if (!/先做学情摸底/.test(uniqRow.error)) note('plan-scope', `归属唯一时的 b/y 拒绝理由应是摸底闸（实得 ${fmt(uniqRow.error)}）`)
		if (bareRow.ok !== false) note('decision-1', '裸 y 跨圈同名必须被拒（不许猜一个圈）')
		if (bareRow.needsHalo !== true) note('decision-1', `裸 y 的拒绝理由必须点名"必须显式给 halo"（实得 ${fmt(bareRow.error)}）`)
		if (bareRow.needsChallenge === true) note('decision-1', '裸 y 不该走到教学闸 —— 结构闸先拒（门禁 API 的歧义判定另有见证）')
	}

	/* ── 门禁 API 自己的规范身份契约：规范身份算得出唯一归属，裸点才歧义 ── */
	{
		const gateMod = await import(pathToFileURL(path.join(mods.baseDir, 'lib', 'gate.js')).href)
		const pack = mods.model.readPack(root)
		const bare = gateMod.challengeGate({ root, pack, point: 'y', probe: false })
		const canon = gateMod.challengeGate({ root, pack, point: 'b/y', probe: false })
		observed.gateApi = {
			bare: {
				allowed: bare.allowed === true, code: bare.code, candidates: bare.candidates,
				why: String(bare.why || '').slice(0, 140), hasAmbig: /归属不唯一/.test(String(bare.why || '')),
			},
			canonical: { allowed: canon.allowed === true, code: canon.code, why: String(canon.why || '').slice(0, 140) },
		}
		if (bare.allowed !== false || bare.code !== 'ambiguous-point') note(U18_GATE_STATE, `裸 y 在两圈都声明时必须 fail-closed（实得 ${fmt(observed.gateApi.bare)}）`)
		if (JSON.stringify(bare.candidates) !== JSON.stringify(['a', 'b'])) note(U18_GATE_STATE, `裸 y 的歧义拒绝必须列出两个候选圆圈（实得 ${fmt(bare.candidates)}）`)
		if (!observed.gateApi.bare.hasAmbig) note(U18_GATE_STATE, '裸 y 的歧义拒绝必须说清"归属不唯一 ⇒ 失败关闭"')
		if (canon.allowed !== true || canon.code !== 'first-lesson') note(U18_GATE_STATE, `规范身份 b/y 没有归属歧义，必须放行到下一道闸（实得 ${fmt(observed.gateApi.canonical)}）`)
		// 决-2：**候选唯一但错圈**也必须是"不猜"——只报课记录（a 圈有课）时裸点不再是唯一解。
		// 这里用同一份 pack 去掉声明、只留 b 圈声明 + a 圈课记录的形态不可能（readPack 要求点在册），
		// 所以改用纯函数层见证：`a/x` 与 `b/x` 都声明、只有 a 有课时，裸 x 仍必须歧义。
		const crossPack = {
			points: [{ id: 'x', circle: 'a' }, { id: 'x', circle: 'b' }],
			lessons: [{ id: 'a/x/0001', circle: 'a', point: 'x', number: 1 }],
		}
		const crossBare = gateMod.challengeGate({ root, pack: crossPack, point: 'x', probe: false })
		const crossPrefer = gateMod.previousLesson(crossPack, 'x')
		observed.crossBareOnlyLessons = {
			code: crossBare.code, candidates: crossBare.candidates, prev: crossPrefer && crossPrefer.id,
		}
		if (crossBare.allowed !== false || crossBare.code !== 'ambiguous-point') {
			note('decision-2', `只有 a 圈有课、但 a/b 都声明 x 时，裸 x 仍必须 fail-closed（实得 ${fmt(observed.crossBareOnlyLessons)}）`)
		}
		if (crossPrefer !== null) note('decision-2', '只有 a 圈有课时裸 x 不许被"唯一"解析成 a（previousLesson 必须 null，不猜）')
	}

	// 大纲闸按**同圈**的 plan 判（不许拿另一圈同名点的大纲来放行）
	{
		const inA = await tool.execute({ ...AUTHOR_BASE, point: 'y', halo: 'a', commit: true })
		const inB = await tool.execute({ ...AUTHOR_BASE, point: 'y', halo: 'b', commit: true })
		observed.crossCirclePlanGate = {
			a: {
				ok: inA.ok, needsPlan: inA.needsPlan === true, needsIntake: inA.needsIntake === true,
				needsChallenge: inA.needsChallenge === true, gate: gateOf(inA, String(inA.error || '')),
				error: String(inA.error || '').slice(0, 90),
			},
			b: {
				ok: inB.ok, needsPlan: inB.needsPlan === true, needsIntake: inB.needsIntake === true,
				needsChallenge: inB.needsChallenge === true, challengeCode: (inB.challenge && inB.challenge.code) || null,
				gate: gateOf(inB, String(inB.error || '')), error: String(inB.error || '').slice(0, 160),
			},
		}
		if (inA.ok !== false || inA.needsPlan !== true) note('plan-scope', `a/y 没有大纲，应当 needsPlan（实得 ${fmt(observed.crossCirclePlanGate.a)}）`)
		if (inB.needsPlan === true) note('plan-scope', `b/y 有大纲，不该被判成"没有大纲"（拿错了圈的 plan；实得 ${fmt(observed.crossCirclePlanGate.b)}）`)
		// Δ（决-1）：b/y 显式给了圆圈 ⇒ 身份确定 ⇒ 停在下一条闸（摸底），不再是"归属不唯一"的误拦
		if (inB.ok !== false || inB.needsIntake !== true) note('decision-1', `b/y 应当停在摸底闸（实得 ${fmt(observed.crossCirclePlanGate.b)}）`)
		if (inB.needsChallenge === true) note('decision-1', 'b/y 不该再被挑战闸的歧义分支拦下（显式圆圈 = 确定的身份）')
		if (!/先做学情摸底/.test(String(inB.error || ''))) note('decision-1', `b/y 的拒绝理由应是摸底闸（实得 ${fmt(inB.error)}）`)
	}
	return { violations, observed, workRoot }
}

/**
 * A06 的本体：**重建里的历史形状只指路**（不改写、不阻断、不复制旧解析）。
 */
export async function judgeHistory(mods, workRoot) {
	const violations = []
	const observed = { workRoot }
	const note = (state, msg) => violations.push({ state, msg })
	const id = mods.identity

	// ① 规范包：零误报
	{
		const root = makePack('a06-canonical', {
			circles: [{ id: 'a', points: [{ id: 'x', plan: true }] }],
			learned: ['a/x/0001', 'a/x/0002'],
		})
		const r = mods.rebuild.startScripts(root, [], { trustedEngine: false })
		observed.canonical = {
			migration: r.migration === undefined ? null : r.migration,
			keyPresent: Object.hasOwn(r, 'migration'),
			hasJob: r.job !== null,
		}
		if (r.migration !== undefined) note('history-false-positive', `规范身份的课程包不该报历史形状（实得 ${fmt(r.migration)}）`)
	}

	// ② 历史包：只指路（三个历史条目 + 一条平铺源），且**零写入**
	{
		const root = makePack('a06-legacy', {
			circles: [{ id: 'a', points: [{ id: 'x', plan: true }] }],
			flatSources: ['0001-flat.html'],
			learned: ['x', 'x/0001', '第1课', 'a/x/0001'],
		})
		const before = treeOf(root)
		const r = mods.rebuild.startScripts(root, [], { trustedEngine: false })
		observed.legacy = r.migration
		if (!r.migration || !Array.isArray(r.migration.findings)) note('history', `历史身份包必须给出指路（实得 ${fmt(r.migration)}）`)
		else {
			const kinds = r.migration.findings.map((f) => f.kind)
			if (kinds.filter((k) => k === 'non-canonical-progress').length !== 3) note('history', `三个历史课次键应各报一条（实得 ${fmt(kinds)}）`)
			if (!kinds.includes('flat-lesson-source')) note('history', '平铺课程源应当被报出来')
			const hint = String(r.migration.hint || '')
			if (!/migrate-pack\.mjs/.test(hint)) note('history', `指路必须点名唯一迁移入口 tools/migrate-pack.mjs（实得 ${fmt(hint.slice(0, 90))}）`)
			if (!/--plan/.test(hint)) note('history', '指路必须给出 --plan（先只算不写）')
			if (!/--apply/.test(hint) || !/--confirm/.test(hint) || !/--plan-digest/.test(hint)) note('history', '指路必须给出 --apply --confirm --plan-digest=（三步契约）')
			if (!hint.includes(path.resolve(root))) note('history', `指路必须带上这个包根（实得 ${fmt(hint.slice(0, 140))}）`)
			for (const f of r.migration.findings) {
				const keys = Object.keys(f).sort().join(',')
				if (keys !== 'at,kind') note('history', `历史形状的发现项不许带迁移映射（实得字段 ${keys}）`)
			}
		}
		treeNotEqual(violations, before, treeOf(root), 'history', '历史形状只读体检：重建入口一个字节都不许写（不就地迁移）')
		if (id.parseLessonKey('x').ok !== false) note('history-kernel', '严格内核必须解不开裸点（判据的唯一依据）')
		if (id.parseLessonKey('a/x/0001').ok !== true) note('history-kernel', '严格内核必须解得开规范课次键')
	}

	// ③ 产品入口把指路带出去（且不改变四个分支的语义）
	{
		const legacy = makePack('a06-product-legacy', {
			circles: [{ id: 'programming', points: [{ id: 'vue', plan: true }] }],
			flatSources: ['0001-flat.html'],
			tools: { 'tools/build-lessons.js': 'process.exit(0)\n', 'tools/build-starmap.js': 'process.exit(0)\n' },
		})
		const pointRoute = installRoutes(mods.create, legacy).find((r) => r.path === '/api/whale/point')
		const body = await callRoute(pointRoute, { circle: 'programming', id: 'solid', name: 'SOLID' })
		observed.productLegacy = { ok: body.ok, blocked: body.rebuild && body.rebuild.blocked, hasMigration: !!(body.rebuild && body.rebuild.migration) }
		if (body.ok !== true) note('history-product', `建点本身仍应成功（${body.error || ''}）`)
		if (!body.rebuild || !body.rebuild.migration) note('history-product', '历史包的建点回执必须带出迁移指路')
		const canonical = makePack('a06-product-canonical', { circles: [{ id: 'programming', points: [{ id: 'vue', plan: true }] }] })
		const pointRoute2 = installRoutes(mods.create, canonical).find((r) => r.path === '/api/whale/point')
		const body2 = await callRoute(pointRoute2, { circle: 'programming', id: 'solid', name: 'SOLID' })
		observed.productCanonical = { ok: body2.ok, hasMigration: !!(body2.rebuild && body2.rebuild.migration) }
		if (body2.rebuild && body2.rebuild.migration) note('history-product', '规范包的回执不该出现迁移指路（误报）')
	}

	return { violations, observed, workRoot }
}

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 正常创建结果引用完整知识点身份
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
	const mods = await loadMods()
	const { violations, observed } = await judgeIdentity(mods, WORK('a01'))
	const mine = violations.filter((v) => /author-file|author-flat|noncommit|commit|create-point/.test(v.state))
	eq(mine.length, 0, `A01 · 规范身份有 ${mine.length} 处不成立：${mine.slice(0, 4).map((v) => `${v.state}: ${v.msg}`).join(' | ')}`)
	const id = mods.identity
	sameJson([id.LESSON_NUMBER_MIN, id.LESSON_NUMBER_MAX, id.LESSON_WIDTH], [1, 9999, 4], 'A01 · 内核的课号契约应是 1..9999 / 四位')
	eq(mods.author.NUMBER_MIN, id.LESSON_NUMBER_MIN, 'A01 · lib/author.js 的 NUMBER_MIN 必须就是内核那一个（不是各写一份）')
	eq(mods.author.NUMBER_MAX, id.LESSON_NUMBER_MAX, 'A01 · lib/author.js 的 NUMBER_MAX 必须就是内核那一个')
	eq(observed.nonCommit.file, 'lessons/src/a/ok/0001-probe.html', 'A01 · 未 commit 的落点也必须是完整身份')
	eq(observed.commitLesson, 'a/ok/0001', 'A01 · 落盘后 readPack 读出的课程 id 必须是规范课次键')
	eq(observed.createPoint.id, 'programming/solid', 'A01 · 建点回执的 id 必须是完整知识点身份')
	DETAIL.A01 = observed
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 不同圆圈同名点不串摸底 / 目标（含与旧实现的 Δ）
 * ══════════════════════════════════════════════════════════════════════ */

async function A02() {
	const mods = await loadMods()
	const { violations, observed } = await judgeIdentity(mods, WORK('a02'))
	const mine = violations.filter((v) => /plan-ambiguous|plan-write|plan-target|intake-cross|intake-noguess/.test(v.state))
	eq(mine.length, 0, `A02 · 跨圈隔离有 ${mine.length} 处不成立：${mine.slice(0, 4).map((v) => `${v.state}: ${v.msg}`).join(' | ')}`)
	eq(observed.planAmbiguous.ok, false, 'A02 · 裸 x 的大纲必须被拒')
	sameJson(observed.planAmbiguous.candidates.slice().sort(), ['a/x', 'b/x'], 'A02 · 歧义拒绝必须给出两个候选')
	eq(observed.planA.point, 'a/x', 'A02 · 带圆圈的写法照旧写得进去')

	// Δ：同一批判据在**旧实现**上必须是红的（否则本判据对旧实现也"过"，等于空转）
	const oldRun = await judgeIdentity(await loadMods(makeOldTree()), WORK('a02-old'))
	const oldRows = oldRun.violations.filter((v) => /intake-cross|intake-noguess|plan-ambiguous|plan-target/.test(v.state))
	assert(oldRows.length > 0, 'A02 · 旧实现上这些判据必须是红的（否则判据对旧实现也成立 = 空转）')
	const oldIntake = oldRun.observed.intakeCross
	eq(oldIntake.bare.done, true, 'A02 · Δ：旧实现裸 x 会按"第一个圈"认走 a/x 的摸底（done:true）—— 这正是本卡收掉的降维')
	eq(oldIntake.bareFile, 'lessons/src/a/x/0001-probe.html', 'A02 · Δ：旧实现裸 x 的落点会猜进 a 圈')
	eq(oldRun.observed.planAmbiguous.ok, true, 'A02 · Δ：旧大纲入口会按"第一个圈"接受裸 x（不拒绝、不列候选）')
	eq(oldRun.observed.planA.point, 'a/x', 'A02 · Δ 对照：旧实现在"带圆圈"的写法上本来就对（a/x → a/x）')
	DETAIL.A02 = {
		new: observed,
		old: {
			intakeCross: oldIntake,
			planAmbiguous: oldRun.observed.planAmbiguous,
			planTargets: oldRun.observed.planTargets,
			violations: oldRows.map((v) => `${v.state}: ${v.msg}`),
		},
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 缺归属 / 身份不合法 ⇒ 写入调用为零
 * ══════════════════════════════════════════════════════════════════════ */

async function A03() {
	const mods = await loadMods()
	const { violations, observed } = await judgeIdentity(mods, WORK('a03'))
	const mine = violations.filter((v) => /zero-write/.test(v.state))
	eq(mine.length, 0, `A03 · 零写入有 ${mine.length} 处不成立：${mine.slice(0, 4).map((v) => v.msg).join(' | ')}`)
	assert(Array.isArray(observed.zeroWrite) && observed.zeroWrite.length >= 15,
		`A03 · 零写入的拒绝面太少（${observed.zeroWrite ? observed.zeroWrite.length : 0} 条）—— 探针没覆盖到全部入口`)
	assert(observed.zeroWrite.some((r) => r.tag === U13_DECISION_TAG),
		`A03 · 决-1 的样本不见了（${U13_DECISION_TAG}）—— 显式 halo 的确定归属必须走到摸底闸并被零写入拒绝`)
	assert(observed.zeroWrite.some((r) => r.tag === U13_BARE_TAG),
		`A03 · 裸点跨圈同名仍然必须被拒（${U13_BARE_TAG}）—— 决-1 没把 fail-closed 放宽成猜一个圈`)
	for (const row of observed.zeroWrite) {
		eq(row.writes, 0, `A03 · ${row.tag}：写入调用必须恰好 0 次`)
		eq(row.ok, true, `A03 · ${row.tag}：必须被拒`)
		eq(row.matched, true, `A03 · ${row.tag}：拒绝理由要能被机器认出来（实得 ${row.error}）`)
	}
	DETAIL.A03 = { rows: observed.zeroWrite, count: observed.zeroWrite.length }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 结构及路径拒绝不可被 force 绕过
 * ══════════════════════════════════════════════════════════════════════ */

async function A04() {
	const mods = await loadMods()
	const { violations, observed } = await judgeIdentity(mods, WORK('a04'))
	const mine = violations.filter((v) => /force/.test(v.state))
	eq(mine.length, 0, `A04 · force 边界有 ${mine.length} 处不成立：${mine.slice(0, 4).map((v) => v.msg).join(' | ')}`)
	const rows = observed.force || []
	assert(rows.length >= 9, `A04 · force 的拒绝面太少（${rows.length} 条）`)
	// 原有 6 条硬拒绝 + 「已存在（拒覆盖）」一条都不许少（U18 的 Δ 只许**加**，不许拿掉）
	for (const tag of ['穿越 halo', '绝对 halo', '穿越 point', '未知点', '点圈对不上', '坏包配置', '已存在（拒覆盖）']) {
		assert(rows.some((r) => r.tag === tag), `A04 · 原有硬拒绝样本不见了：${tag}`)
	}
	for (const row of rows) {
		if (row.tag === '正面控制：force 绕摸底闸') {
			eq(row.forced.ok, true, 'A04 · 正面控制：force 必须仍然能绕摸底闸')
			continue
		}
		if (row.tag === '上一课挑战闸（force 边界）') {
			// plain 必拒且理由逐字；force 的实际边界 = 跳过整个教学闸，但**必须逐字留痕**
			// （任务卡的假设是"force 不许绕过"；实测它会绕过 —— 这里钉可观察事实，别把它写成绿不了的空断言）
			eq(row.plain.ok, false, 'A04 · 挑战闸：不带 force 时必须被拒')
			eq(row.plain.code, 'no-snapshot', 'A04 · 挑战闸：plain 的回执必须点名 no-snapshot（真的是挑战闸在判，不是别的闸）')
			eq(row.plain.error, CHALLENGE_NO_SNAPSHOT, 'A04 · 挑战闸：plain 的拒绝理由必须逐字')
			eq(row.plain.gateError, CHALLENGE_GATE_ERROR, 'A04 · 挑战闸：门禁自己的 error 必须逐字（no-snapshot 是挑战闸在判）')
			eq(row.forced.ok, true, 'A04 · 挑战闸：现状 force 会跳过教学闸（若改成 fail-closed 到底，就同步改成 false）')
			eq(row.forced.wrote, true, 'A04 · 挑战闸：force 既然跳过教学闸，就要真的落盘（不是假成功）')
			assert(row.bypassed.some((x) => String(x) === CHALLENGE_BYPASS_TEXT),
				`A04 · 挑战闸：force 绕过它时必须在 forced.bypassed 里逐字点名（实得 ${fmt(row.bypassed)}）`)
			continue
		}
		eq(row.forced.ok, false, `A04 · ${row.tag}：force:true 也必须被拒`)
		eq(row.forced.error, row.plain.error, `A04 · ${row.tag}：force 前后拒绝理由必须逐字相同`)
	}
	DETAIL.A04 = { rows }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 原有大纲和写前校验顺序不放宽
 * ══════════════════════════════════════════════════════════════════════ */

/** 源码级次序（与 T03 同一条判据的另一份见证：执行体里的 7 个锚点必须递增） */
export function orderOfExecuteBody(src) {
	const at = src.indexOf('async execute(args = {})')
	const body = at >= 0 ? src.slice(at) : ''
	const idx = (s) => body.indexOf(s)
	const order = {
		inspectPack: idx('const insp = inspectPack('),
		checkInput: idx('const schema = checkInput('),
		planGate: idx('planGate(pt.plan'),
		challengeGate: idx('challengeGate({ root, pack, point: gatePoint, probe: false })'),
		authorLesson: idx('a = authorLesson({'),
		validateSkeleton: idx('const v = validateSkeleton(a.text)'),
		publishLesson: idx('const pub = publishLesson('),
	}
	const seq = ['inspectPack', 'checkInput', 'planGate', 'challengeGate', 'authorLesson', 'validateSkeleton', 'publishLesson']
	const increasing = seq.every((k, i) => i === 0 || (order[seq[i - 1]] >= 0 && order[seq[i - 1]] < order[k]))
	return { at, order, seq, increasing }
}

async function A05() {
	const raw = readText(path.join(REPO, 'lib/mods/author.js'))
	const o = orderOfExecuteBody(stripComments(raw))
	assert(o.at >= 0, 'A05 · lib/mods/author.js 里必须找得到 execute 执行体')
	for (const [k, v] of Object.entries(o.order)) assert(v >= 0, `A05 · 执行体里必须找得到 ${k}（硬校验被挪走了？实得 ${v}）`)
	assert(o.increasing, `A05 · 次序必须仍是 解析包→点圈→schema→大纲→教学闸→生成→验证→独占新建（实得 ${JSON.stringify(o.order)}）`)
	assert(/if \(commit\) \{\s*\n\s*const insp = inspectPack\(/.test(raw), 'A05 · 解析包 / 点圈 不许被 force 或别的条件挡住')
	assert(/commit && !force && declared/.test(raw), 'A05 · 只有**教学闸**看 force（硬校验不看）')
	assert(!/fs\.writeFileSync\(\s*abs\s*,\s*a\.text/.test(raw), 'A05 · "先写正式文件再报错"的写法不许回来')
	assert(/COPYFILE_EXCL/.test(raw), 'A05 · 发布必须是不覆盖的（COPYFILE_EXCL）')
	assert(/const inside = resolveInside\(root, rel/.test(raw), 'A05 · 生成之后发布之前还要再解一次路径')

	// 决-1（2026-10-20 授权）：教学闸必须用**规范身份**，解析出来的 halo 不许在调用点丢掉。
	// 这条与 T03 钉的那一行源码字面量是同一件事的两面（U13 不消费 A 面，这里是**行为来源**的见证）。
	assert(/const gatePoint = gatePointOf\(halo, args\.point\)/.test(raw),
		'A05 · 决-1：gatePoint 必须由 halo + point 构造（② 解析出来的圆圈不许丢）')
	assert(/challengeGate\(\{ root, pack, point: gatePoint, probe: false \}\)/.test(raw),
		'A05 · 决-1：教学闸必须传规范身份 gatePoint（不许再把裸点直接交出去）')
	assert(!/challengeGate\(\{ root, pack, point: args\.point, probe: false \}\)/.test(raw),
		'A05 · 决-1：把裸点直传门禁的旧写法不许回来 —— 它会把合法首课误拦成「上一课的归属不唯一」')

	// U18 新闸的**出处**（本卡只消费、不改 lib/gate.js）：分支码与 why 必须逐字对得上。
	// 这条把"理由逐字"钉在源码上 —— U18 改了文案，A03/A04/A05 的期望会一起被提醒。
	const gateRaw = readText(path.join(REPO, 'lib/gate.js'))
	assert(gateRaw.includes("code: 'ambiguous-point'"),
		'A05 · lib/gate.js 里找不到 U18 新闸的 ambiguous-point 分支（上一课归属不唯一 → 失败关闭）')
	assert(gateRaw.includes(`why: '${U18_GATE_WHY}'`),
		`A05 · lib/gate.js 里那条 why 必须逐字是「${U18_GATE_WHY}」（U18 改了就说；本卡期望它逐字稳定）`)
	// 决-2：候选圆圈必须是**声明 ∪ 课记录**（"只有一圈有课"不许把裸点悄悄解析成那一圈）。
	const gateCode = stripComments(gateRaw)
	assert(/const pool = new Set\(\[\.\.\.declared, \.\.\.observed\]\)/.test(gateCode),
		'A05 · 决-2：lessonScope 的候选圆圈必须由声明与课记录**并集**求出（不许 observed 优先）')
	assert(!/observed\.size \? observed : declared/.test(gateCode),
		'A05 · 决-2："有课就看课记录"的旧写法不许回来 —— 那就是「候选唯一但错圈」的泄漏')

	const mods = await loadMods()
	const judge = await judgeOrder(mods, WORK('a05'))
	eq(judge.violations.length, 0,
		`A05 · 顺序矩阵有 ${judge.violations.length} 处不成立：${judge.violations.slice(0, 4).map((v) => `${v.state}: ${v.msg}`).join(' | ')}`)

	// 对照对（行为级）：归属唯一 → 摸底闸；归属不唯一但**显式给圈** → 也是摸底闸（决-1）；
	// 裸点（不传 halo）跨圈同名 → 结构闸拒绝（不猜圈）。
	eq(judge.observed.pair.unique.gate, 'intake',
		`A05 · 对照①：上一课归属唯一时 b/y 必须照旧停在摸底闸（实得 ${fmt(judge.observed.pair.unique)}）`)
	eq(judge.observed.pair.explicitCircle.gate, 'intake',
		`A05 · 对照②（决-1）：显式 halo=b 时 b/y 的身份是确定的，必须停在摸底闸而不是被误拦（实得 ${fmt(judge.observed.pair.explicitCircle)}）`)
	eq(judge.observed.pair.explicitCircle.challengeCode, null,
		'A05 · 对照②（决-1）：显式 halo 的 b/y 回执不该再带挑战闸的拒绝码')
	eq(judge.observed.pair.barePoint.ok, false, 'A05 · 对照③：裸 y 跨圈同名必须被拒（fail-closed 没有被放宽）')
	eq(judge.observed.pair.barePoint.needsHalo, true, 'A05 · 对照③：裸 y 的拒绝理由必须点名「必须显式给 halo」')
	eq(judge.observed.pair.barePoint.needsChallenge, false, 'A05 · 对照③：裸 y 由结构闸先拒，不该走到教学闸')
	// 门禁 API 的歧义分支**仍然生效**（决-1 只是不再把已确定的身份降维成裸点）
	eq(judge.observed.gateApi.bare.code, 'ambiguous-point', 'A05 · 门禁 API：裸 y 在两圈都声明时必须 fail-closed（ambiguous-point）')
	eq(JSON.stringify(judge.observed.gateApi.bare.candidates), JSON.stringify(['a', 'b']), 'A05 · 门禁 API：歧义拒绝必须列出两个候选圆圈')
	eq(judge.observed.crossBareOnlyLessons.code, 'ambiguous-point',
		'A05 · 决-2：只有 a 圈有课、a/b 都声明 x 时，裸 x 仍必须 fail-closed（不许按"只有一个圈有课"去猜）')
	eq(judge.observed.crossBareOnlyLessons.prev, null, 'A05 · 决-2：只有 a 圈有课时 previousLesson 必须 null（不猜）')

	// 非身份面：旧实现 ↔ 新实现逐字段 0 差异（防的是"顺手把别的语义改了"）。
	// ⚠️ 「决-1 > 摸底」这一行是**已登记的 Δ**（决-1：工具入口改传规范身份），从 0 差异对拍里显式排除，
	//    并单独钉住差异方向（旧实现拿 a 圈同名点的大纲先拒，新实现按同圈判 → 摸底闸）。
	const oldJudge = await judgeOrder(await loadMods(makeOldTree()), WORK('a05-old'))
	const comparable = (rows) => rows.filter((r) => r.id !== '决-1 > 摸底')
	sameJson(comparable(judge.observed.precedence), comparable(oldJudge.observed.precedence),
		'A05 · 除「决-1 > 摸底」那一条外，优先序矩阵在旧实现与新实现上必须逐字段相同')
	const newGateRow = judge.observed.precedence.find((r) => r.id === '决-1 > 摸底') || null
	const oldGateRow = oldJudge.observed.precedence.find((r) => r.id === '决-1 > 摸底') || null
	eq(oldGateRow && oldGateRow.needsPlan, true,
		'A05 · Δ：旧入口的裸点大纲闸先命中 b/y（拿 a 圈同名点的大纲），根本走不到教学闸')
	eq(newGateRow && newGateRow.needsPlan, false, 'A05 · 新入口按同圈判：b/y 有大纲，过了大纲闸')
	eq(newGateRow && newGateRow.gate, 'intake', 'A05 · 决-1 之后 b/y（显式圆圈）必须停在摸底闸')
	// Δ（与 A02 同一族）：大纲闸此前按**裸点**找点，会把另一个圆圈同名点的大纲拿来判 ——
	//   旧实现把 b/y（有大纲）判成"没有大纲"，新实现按同圈判、停在下一条闸。这条差异必须被看见。
	eq(oldJudge.observed.crossCirclePlanGate.b.needsPlan, true,
		'A05 · Δ：旧实现拿 a 圈同名点（没大纲）的 plan 去判 b/y —— 应当被判成 needsPlan（这正是本卡收掉的降维）')
	eq(judge.observed.crossCirclePlanGate.b.needsPlan, false, 'A05 · 新实现按同圈判：b/y 有大纲，停在摸底闸')
	eq(judge.observed.crossCirclePlanGate.b.gate, 'intake', 'A05 · 决-1：b/y 在新实现上必须停在摸底闸（不再是"归属不唯一"的误拦）')
	eq(judge.observed.crossCirclePlanGate.a.needsPlan, true, 'A05 · a/y 没大纲，照旧被大纲闸拦住')

	DETAIL.A05 = {
		order: o,
		precedence: judge.observed.precedence,
		pair: judge.observed.pair,
		gateApi: judge.observed.gateApi,
		crossBareOnlyLessons: judge.observed.crossBareOnlyLessons,
		crossCirclePlanGate: judge.observed.crossCirclePlanGate,
		oldCrossCirclePlanGate: oldJudge.observed.crossCirclePlanGate,
		newGateRow,
		oldGateRow,
		oldPrecedence: oldJudge.observed.precedence,
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 重建中的历史处理只指向迁移，不复制旧解析
 * ══════════════════════════════════════════════════════════════════════ */

/** U09 扫的那三种"身份构造/解析"痕迹（本卡要求这五个文件里**一条都没有**） */
const IDENTITY_TRACE_PATTERNS = Object.freeze([
	['template-circle-point', /\$\{\s*([A-Za-z_$][\w$]*)\.circle\s*\}\s*\/\s*\$\{\s*\1\.(?:id|point)\s*\}/],
	['template-circle-point', /`\$\{\s*circle\s*\}\s*\/\$\{\s*point\s*\}/],
	['indexof-slash', /\.indexOf\(\s*['"]\/['"]\s*\)/],
	['padstart4', /padStart\(\s*4\s*,\s*['"]0['"]\s*\)/],
])

export function identityTraces(src) {
	const hits = []
	for (const [i, line] of String(src).split('\n').entries()) {
		if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
		for (const [pattern, rx] of IDENTITY_TRACE_PATTERNS) {
			if (rx.test(line)) hits.push({ line: i + 1, pattern, text: line.trim().slice(0, 120) })
		}
	}
	return hits
}

async function A06() {
	const rebuildSrc = stripComments(readText(path.join(REPO, 'lib/rebuild-job.js')))
	assert(rebuildSrc.includes('migrate-pack.mjs'), 'A06 · 重建入口里找不到唯一迁移入口的指路（tools/migrate-pack.mjs）')
	assert(/--plan/.test(rebuildSrc) && /--apply/.test(rebuildSrc) && /--plan-digest/.test(rebuildSrc), 'A06 · 指路必须给出三步契约（--plan / --apply --confirm --plan-digest=）')
	assert(!/migration\.cjs/.test(rebuildSrc), 'A06 · 重建入口不许 require 迁移模块（历史解码只归 U05，运行态不调用）')
	assert(rebuildSrc.includes('identity.parseLessonKey('), 'A06 · 历史形状体检必须用严格内核（parseLessonKey）—— 否则就是另写一份解码')
	for (const relPath of HOST_FILES) {
		const hits = identityTraces(readText(path.join(REPO, relPath)))
		eq(hits.length, 0, `A06 · ${relPath} 里还有身份构造/解析痕迹（${hits.map((h) => `${h.line}:${h.pattern}`).join(',')}）—— 卡面要求五个落点只剩内核一份实现`)
	}

	const mods = await loadMods()
	const { violations, observed } = await judgeHistory(mods, WORK('a06'))
	eq(violations.length, 0, `A06 · 历史处理有 ${violations.length} 处不成立：${violations.slice(0, 4).map((v) => `${v.state}: ${v.msg}`).join(' | ')}`)
	eq(observed.canonical.migration, null, 'A06 · 规范包必须零误报')
	eq(observed.canonical.keyPresent, false, 'A06 · 规范包的 startScripts 返回连 migration 这个键都不该多（返回形状逐字保持）')
	assert(observed.legacy, 'A06 · 历史包必须给出指路')
	DETAIL.A06 = { canonical: observed.canonical, legacy: observed.legacy, product: observed.productLegacy, productCanonical: observed.productCanonical }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 变异有效性（只在 E:\Temp 副本上）
 * ══════════════════════════════════════════════════════════════════════ */

/** 把当前 `lib/` 逐字复制到本次临时根（外加一个只带 type/name 的 package.json） */
function copyLib(tag) {
	const dest = path.join(RUN_TEMP, 'a07', tag)
	fs.mkdirSync(dest, { recursive: true })
	fs.cpSync(path.join(REPO, 'lib'), path.join(dest, 'lib'), { recursive: true })
	fs.writeFileSync(path.join(dest, 'package.json'),
		JSON.stringify({ name: `u13-${tag}`, type: 'module', version: '0.0.0' }, null, 2) + '\n', 'utf8')
	return dest
}

async function A07() {
	const repoHashes = Object.fromEntries(HOST_FILES.map((p) => [p, sha256(fs.readFileSync(path.join(REPO, p)))]))
	const base = path.join(RUN_TEMP, 'a07')
	fs.mkdirSync(base, { recursive: true })

	/* ① 干净副本对照：三套判官都必须绿 */
	const cleanMods = await loadMods(copyLib('clean'))
	const cleanIdentity = await judgeIdentity(cleanMods, WORK('a07-clean-identity'))
	const cleanOrder = await judgeOrder(cleanMods, WORK('a07-clean-order'))
	const cleanHistory = await judgeHistory(cleanMods, WORK('a07-clean-history'))
	eq(cleanIdentity.violations.length, 0, `A07 · 未变异的副本必须通过身份判据（${cleanIdentity.violations.slice(0, 2).map((v) => v.msg).join(' | ')}）`)
	eq(cleanOrder.violations.length, 0, `A07 · 未变异的副本必须通过顺序判据（${cleanOrder.violations.slice(0, 2).map((v) => v.msg).join(' | ')}）`)
	eq(cleanHistory.violations.length, 0, `A07 · 未变异的副本必须通过历史判据（${cleanHistory.violations.slice(0, 2).map((v) => v.msg).join(' | ')}）`)

	/* ② 变异一：**去掉圆圈**（大纲闸按裸点找点）⇒ 顺序 / 跨圈判据必须红 */
	const mutCircleDir = copyLib('mut-drop-circle')
	const authorPath = path.join(mutCircleDir, 'lib', 'mods', 'author.js')
	const cleanAuthor = readText(authorPath)
	const circleNeedle = 'const pt = pack.points.find((x) => x.id === args.point && x.circle === halo)'
	eq(cleanAuthor.split(circleNeedle).length, 2, 'A07 · 「去掉圆圈」的变异锚点必须唯一（mods/author.js 结构变了就更新锚点）')
	const mutAuthor = cleanAuthor.replace(circleNeedle, 'const pt = pack.points.find((x) => x.id === args.point)')
	assert(mutAuthor !== cleanAuthor, 'A07 · 「去掉圆圈」变异必须真的改动源码')
	fs.writeFileSync(authorPath, mutAuthor, 'utf8')
	const mutOrder = await judgeOrder(await loadMods(mutCircleDir), WORK('a07-mut-circle'))
	assert(mutOrder.violations.length > 0, 'A07 · 去掉圆圈之后，顺序 / 跨圈判据仍然全绿 —— A05 的「大纲闸按同圈判」是空转的')
	assert(mutOrder.violations.some((v) => /plan-scope/.test(v.state)),
		`A07 · 变异体检出项必须点到大纲闸拿错圈的 plan（实得 ${mutOrder.violations.slice(0, 3).map((v) => `${v.state}: ${v.msg}`).join(' | ')}）`)

	/* ③ 变异二：**恢复降维**（大纲入口按"第一个"猜圈）⇒ A02 判据必须红 */
	const mutGuessDir = copyLib('mut-first-match')
	const planPath = path.join(mutGuessDir, 'lib', 'mods', 'plan.js')
	const cleanPlan = readText(planPath)
	const guessNeedle = '\tif (hits.length > 1) {'
	eq(cleanPlan.split(guessNeedle).length, 2, 'A07 · 「按第一个猜圈」的变异锚点必须唯一（mods/plan.js 结构变了就更新锚点）')
	const mutPlan = cleanPlan.replace(guessNeedle, '\tif (false && hits.length > 1) {')
	assert(mutPlan !== cleanPlan, 'A07 · 「恢复降维」变异必须真的改动源码')
	fs.writeFileSync(planPath, mutPlan, 'utf8')
	const mutIdentity = await judgeIdentity(await loadMods(mutGuessDir), WORK('a07-mut-guess'))
	assert(mutIdentity.violations.length > 0, 'A07 · 恢复按第一个猜圈之后，跨圈判据仍然全绿 —— A02 是空转的')
	assert(mutIdentity.violations.some((v) => /plan-ambiguous|plan-target/.test(v.state)),
		`A07 · 变异体检出项必须点名大纲写错了圈（实得 ${mutIdentity.violations.slice(0, 3).map((v) => `${v.state}: ${v.msg}`).join(' | ')}）`)

	/* ④ 变异三：**恢复自主拼接**（重建里内联 circle/point）⇒ A06 静态判据必须红 */
	const mutConcatDir = copyLib('mut-inline-concat')
	const rebuildPath = path.join(mutConcatDir, 'lib', 'rebuild-job.js')
	const cleanRebuild = readText(rebuildPath)
	const concatAnchor = 'function historyShapes(root) {'
	eq(cleanRebuild.split(concatAnchor).length, 2, 'A07 · 「恢复自主拼接」的变异锚点必须唯一')
	const mutConcat = cleanRebuild.replace(concatAnchor, 'const legacyPointKey = (p) => `${p.circle}/${p.id}`\n' + concatAnchor)
	assert(mutConcat !== cleanRebuild, 'A07 · 「恢复自主拼接」变异必须真的改动源码')
	fs.writeFileSync(rebuildPath, mutConcat, 'utf8')
	const traces = identityTraces(readText(rebuildPath))
	assert(traces.length > 0, 'A07 · 在重建里内联拼 circle/point 之后，身份痕迹扫描仍然 0 命中 —— A06 静态判据是空转的')
	assert(traces.some((h) => h.pattern === 'template-circle-point'), 'A07 · 变异体检出项必须点名"内联拼接"这一类痕迹')

	/* ⑤ 仓内文件一个字节都没被变异影响；变异全部落在 E:\Temp 本次临时根 */
	for (const p of HOST_FILES) eq(sha256(fs.readFileSync(path.join(REPO, p))), repoHashes[p], `A07 · 仓内 ${p} 不许被变异影响`)
	assert(path.resolve(base).startsWith(path.resolve(TEMP_PARENT) + path.sep), 'A07 · 变异副本必须落在 E:\\Temp')

	DETAIL.A07 = {
		clean: { identity: cleanIdentity.violations.length, order: cleanOrder.violations.length, history: cleanHistory.violations.length },
		mutations: [
			{ id: 'drop-circle', marker: 'a07/mut-drop-circle/lib/mods/author.js', violations: mutOrder.violations.slice(0, 6).map((v) => `${v.state}: ${v.msg}`) },
			{ id: 'first-match-degrade', marker: 'a07/mut-first-match/lib/mods/plan.js', violations: mutIdentity.violations.slice(0, 6).map((v) => `${v.state}: ${v.msg}`) },
			{ id: 'inline-concat', marker: 'a07/mut-inline-concat/lib/rebuild-job.js', traces },
		],
		repoUntouched: true,
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 既有断言冲突闸 / 文件范围 / 证据守卫 / 回执
 * ══════════════════════════════════════════════════════════════════════ */

/** 导出面 + 每个导出的**签名**（参数 / 默认值逐字）—— 用来跟 HEAD 旧树逐键对拍 */
function signatureOf(fn) {
	const src = Function.prototype.toString.call(fn)
	const cut = src.indexOf('{')
	return String(cut >= 0 ? src.slice(0, cut) : src).replace(/\s+/g, ' ').trim()
}
function exportFaceOf(mod) {
	const keys = Object.keys(mod).sort()
	const face = {}
	for (const k of keys) {
		const v = mod[k]
		if (typeof v === 'function') face[k] = `function ${signatureOf(v)}`
		else if (v && typeof v === 'object') {
			face[k] = `object:${JSON.stringify(v, (_k, vv) => (typeof vv === 'function' ? `<fn ${signatureOf(vv)}>` : vv))}`
		} else face[k] = `${typeof v}:${JSON.stringify(v)}`
	}
	return { keys, face }
}

/**
 * A08 的**既有断言冲突闸**（纯函数）：从既有测试源码里认出"依赖旧身份形状"的断言。
 * 命中就会被列出来（本卡一条既有测试都没改 —— 命中的必须**已经**是别的卡的 A 面授权，
 * 或登记在回执 `unverified` / `regressions` 里；不许就地改测试消掉）。
 */
const LEGACY_ASSERTION_PATTERNS = Object.freeze([
	['bare-point-latest', /latest\.(?:vue|react|spring-boot)\b/],
	['two-seg-lesson-anchor', /['"`][a-z][a-z0-9-]*\/\d{4}['"`]/],
	['flat-lesson-path', /lessons\/src\/\d{4}-/],
])

export function scanLegacyIdentityAssertions(src) {
	const hits = []
	for (const [i, line] of String(src).split('\n').entries()) {
		if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
		for (const [kind, rx] of LEGACY_ASSERTION_PATTERNS) {
			if (rx.test(line)) hits.push({ kind, line: i + 1, text: line.trim().slice(0, 140) })
		}
	}
	return hits
}

async function A08() {
	/* ① HEAD / 分支 / 基线（只消费 baseline.json，不改它） */
	const baselineDoc = JSON.parse(readText(path.join(REPO, 'docs/unify/baseline.json')))
	eq(baselineDoc.base.sha, BASELINE_SHA, 'A08 · docs/unify/baseline.json 的执行基线必须仍是 2f57b1f')
	eq(gitText(['rev-parse', 'HEAD']).trim(), BASELINE_SHA, 'A08 · HEAD 必须仍是基线提交（本卡不做任何 git 写）')
	eq(gitText(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'refactor/unify-20261018', 'A08 · 分支必须仍是 refactor/unify-20261018')

	/* ② 五个落点：HEAD 里都在、现在都真的变了；两个新文件真的建了 */
	const facts = []
	for (const p of HOST_FILES) {
		const head = gitHeadBytes(p)
		assert(head !== null, `A08 · HEAD 里没有 ${p}`)
		const now = sha256(fs.readFileSync(path.join(REPO, p)))
		const headSha = sha256(head)
		assert(now !== headSha, `A08 · ${p} 与 HEAD 字节相同 —— 本卡其实没改它（对拍无意义）`)
		facts.push({ path: p, state: 'changed', beforeSha16: headSha.slice(0, 16), nowSha16: now.slice(0, 16) })
	}
	for (const p of ['test/audit/U13.mjs', 'docs/unify/receipts/U13.json']) {
		assert(fs.existsSync(path.join(REPO, p)), `A08 · 新文件不见了：${p}`)
		facts.push({ path: p, state: 'created', nowSha16: sha256(fs.readFileSync(path.join(REPO, p))).slice(0, 16) })
	}

	/* ③ 导出面 / 参数 / 默认值 / 返回形状：与 HEAD 旧树逐键逐签名对拍 */
	const newMods = await loadMods()
	const oldMods = await loadMods(makeOldTree())
	for (const key of Object.keys(MODS)) {
		sameJson(exportFaceOf(newMods[key]), exportFaceOf(oldMods[key]),
			`A08 · ${MODS[key]} 的导出面 / 签名与 HEAD 不一致（导出面、参数、默认值必须逐字保持）`)
	}
	DETAIL.comparisons.exportFace = Object.fromEntries(Object.keys(MODS).filter((k) => k !== 'model').map((k) => [MODS[k], exportFaceOf(newMods[k]).keys]))

	/* ④ 依赖自锚：本次进程开始时 vs 现在 */
	const anchors = verifyAnchors()
	eq(anchors.changed.length, 0,
		`A08 · 本次运行期间依赖文件的字节变了：${anchors.changed.slice(0, 3).map((c) => c.path).join(', ')}（A01–A06 的结论不再对同一份依赖成立；重跑本卡）`)
	assert(anchors.at.length >= ANCHOR_FILES.length, `A08 · 自锚的依赖太少（${anchors.at.length}）`)

	/* ⑤ 授权写集并集（§6 ∪ §12，两处都**现场解析**，不硬编码）+ tracked 越界检查 */
	const lockText = readText(path.join(REPO, 'docs/unify/interfaces.md'))
	const s6 = parseSection6(lockText)
	eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
	sameJson([...s6.get(CARD)], SECTION6_SET, 'A08 · §6 里 U13 的落点必须逐条等于本卡写集')
	const authDoc = JSON.parse(readText(path.join(REPO, 'docs/unify/authorization.json')))
	eq(authDoc.quoteVerbatim, '选A和授权p1和p2', 'A08 · 人类授权的原文必须就是这句（逐字）')
	const auth = authorizationExtras(authDoc)
	assert(auth.extras.has('U10') && auth.extras.get('U10').includes('test/intake.mjs'), 'A08 · authorization.json 里找不到"U10 独占 test/intake.mjs"这条授权')
	assert(auth.extras.has('U09') && auth.extras.get('U09').includes('test/mirror-parity.mjs'), 'A08 · authorization.json 里找不到"U09 独占 test/mirror-parity.mjs"这条授权')
	assert(auth.extras.get('U09').includes('lib/point-ref.js'), 'A08 · C4 追加给 U09 的 lib/point-ref.js 没解析出来')
	assert(!auth.extras.has(CARD), 'A08 · authorization.json 里不该有给 U13 的 A 面授权（本卡不消费 A 面）')
	const union = authorizedUnion(s6, auth.extras)
	const owners = pathOwners(s6, auth.extras)
	// 决-1/决-2 授权的 `test/audit/T03.mjs` 那一行改动必须能在**来源账本（§6）**里找到主人：
	// 这是"T 线最小例外"被登记的见证（本卡不新建授权面，只断言它确实在册）。
	{
		const t03Owners = owners.get('test/audit/T03.mjs') || []
		DETAIL.comparisons.t03Owner = t03Owners
		assert(t03Owners.length > 0,
			'A08 · §6 里没有任何卡登记 test/audit/T03.mjs —— 决-1/决-2 的 T 线最小例外不在来源账本里（改动就无人授权）')
	}
	const porcelain = gitText(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter((l) => l.trim())
	const { tracked, untracked } = splitPorcelainTracked(porcelain)
	const scopeCheck = classifyTrackedWrites(tracked, union)
	eq(scopeCheck.outOfBounds.length, 0,
		`A08 · tracked 改动越出授权并集（§6 ∪ §12）：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
	for (const f of HOST_FILES) assert(tracked.some((t) => t.path === f), `A08 · tracked 改动里找不到本卡改过的 ${f}`)

	// 文件范围检查：既有测试的 tracked 改动必须**能归因** —— §6 里某张卡把它写进自己的写集
	// （`test/audit/T03.mjs` 就是决-1/决-2 授权、登记在 §6 的 U01 行的那一行），或 §12 A 逐字授权。
	// ⚠️ 原判据只认 §12 A：它把已登记在 §6 的 T 线例外（T03/T10/T12/T26）误判成"本卡改了测试"。
	const section6Tests = [...s6.values()].flat().filter((p) => /^test\//.test(p))
	assert(section6Tests.length >= 2,
		`A08 · §6 里解析出的既有测试落点太少（${section6Tests.length}）—— 归属判据会退化成"只认 §12 A"`)
	const authorizedTests = new Set([
		...section6Tests,
		...[...auth.extras.values()].flat().filter((p) => /^test\//.test(p)),
	])
	const changedTests = tracked.filter((t) => /^test\//.test(t.path) || (t.from && /^test\//.test(t.from)))
	const illegalTests = changedTests.filter((t) => !authorizedTests.has(t.path) || (t.from && !authorizedTests.has(t.from)))
	eq(illegalTests.length, 0,
		`A08 · 既有 test/** 出现了授权面之外的改动（§6 ∪ §12 A 都没人认领）：${illegalTests.map((t) => `${t.code.trim()} ${t.path}`).join(', ')}`)
	{
		// 反空转：没有主人的既有测试改动必须仍被判非法（§6 ∪ §12 A 不是整片放行）。
		const ghost = changedTests.concat([{ code: ' M', path: 'test/nobody-owns-me.mjs' }])
			.filter((t) => !authorizedTests.has(t.path))
		assert(ghost.some((t) => t.path === 'test/nobody-owns-me.mjs'),
			'A08 · 没有主人的既有测试改动必须被判非法（判据不许整片放行）')
	}
	assert(!changedTests.some((t) => t.path === 'test/audit/U13.mjs'), 'A08 · 本入口自己是**新增**（?? untracked），不许出现在 tracked 改动里')
	const sProof = proveScopeBoundary(s6, auth.extras)
	eq(sProof.failures.length, 0, `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

	/* ⑥ 既有断言冲突闸：认出既有测试里"依赖旧身份形状"的断言，并证明本卡没去改它们 */
	const legacyRows = []
	for (const relPath of ['test/mirror-parity.mjs', 'test/intake.mjs', 'test/pack-template-rules.mjs', 'test/rebuild-wiring.mjs', 'test/plan-gate.mjs', 'test/circle-create.mjs']) {
		const head = gitHeadBytes(relPath)
		if (head === null) continue
		const headHits = scanLegacyIdentityAssertions(head.toString('utf8'))
		const nowHits = scanLegacyIdentityAssertions(readText(path.join(REPO, relPath)))
		legacyRows.push({ path: relPath, headHits: headHits.length, nowHits: nowHits.length })
		if (authorizedTests.has(relPath)) continue
		eq(nowHits.length, headHits.length, `A08 · 冲突闸：${relPath} 的旧身份断言条数变了（HEAD ${headHits.length} → 现在 ${nowHits.length}），而它不在授权面内`)
	}
	// 红路径自证：闸必须真的抓得住（喂一条旧形状断言），且不误伤规范身份
	const selfTest = scanLegacyIdentityAssertions("ok(read1.latest.vue === 1, 'x')\nok(a.anchor === 'spring-boot/0001')\nconst f = 'lessons/src/0001-x.html'\n")
	eq(selfTest.length, 3, `A08 · 冲突闸的自证失败：三条旧形状断言没全抓到（实得 ${selfTest.length} 条）`)
	eq(scanLegacyIdentityAssertions("ok(a.anchor === 'programming/vue/0001')\n").length, 0, 'A08 · 冲突闸不许把规范身份当成旧形状（假阳性）')

	/* ⑦ 临时目录归属（先做一次受守卫的删除，让写记录里真的出现 rm —— 必须在 sweep 之前） */
	{
		const scratch = path.join(RUN_TEMP, 'guard-scratch')
		fs.mkdirSync(scratch, { recursive: true })
		fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
		const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
		eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
		eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')
	}
	eq(guardTempPath(RUN_TEMP, { parent: TEMP_PARENT }).ok, true, 'A08 · 本次临时根必须归 E:\\Temp')
	assert(/^u13-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u13-<pid>-<rand>（本次唯一）')
	eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
	eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
	eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')

	/* ⑧ 进程内 fs 写守卫（探针写自证） */
	const guard = sweepWriteGuard()
	eq(guard.installed, true, 'A08 · fs 写守卫没挂上（本次进程的写无从判定）')
	assert(guard.patched.length >= 20, `A08 · 挂上的写入口太少（${guard.patched.length}）`)
	assert(guard.probe, 'A08 · 没做探针写 —— "守卫真的记得到"没有被自证')
	eq(guard.probe.recorded, true, 'A08 · 探针写没有被守卫记录到（守卫是假的）')
	eq(guard.probe.created, true, 'A08 · 探针写之后文件必须真的存在过')
	eq(guard.probe.allowed, true, 'A08 · 探针写必须落在 E:\\Temp 本次临时根里')
	eq(guard.probe.bytes, true, 'A08 · 探针写的字节数必须对（写真的发生了）')
	eq(guard.probeError, null, `A08 · 探针写本身失败了：${guard.probeError}`)
	eq(guard.violations.length, 0, `A08 · 本进程出现了允许面之外的写入：${guard.violations.slice(0, 5).map((v) => `${v.op} ${v.target}`).join(', ')}`)
	assert(guard.writeCount >= 20, `A08 · 写记录条数太少（${guard.writeCount}）—— 守卫看起来没在真记录`)
	for (const op of ['mkdir', 'write', 'cp', 'rm']) assert(guard.ops.includes(op), `A08 · 写记录里没有 ${op} 这一类的写`)
	const wProof = proveWriteScope()
	eq(wProof.failures.length, 0, `A08 · 写允许面的纯函数自证失败：${wProof.failures.map((f) => `${f.path} → ${f.got}（期望 ${f.expect}）`).join(', ')}`)

	/* ⑨ `--evidence-root` 守卫 + 读取根恒定 */
	const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
	eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
	eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U13/runs/U13-<pid>')
	eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true, 'A08 · E:\\Temp 下带 U13- 前缀的新目录必须被接受')
	eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
	eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
	eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')

	/* ⑩ 交付物内容锁（当场复核） */
	const lock = recordContentLock()
	eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
	const lockNow = verifyContentLock()
	eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)

	/* ⑪ tracked 回执：合法 JSON（require 自检）+ 五项齐 + 与实际写集一致 */
	const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
	assert(fs.existsSync(rcPath), `A08 · 缺 tracked 回执 docs/unify/receipts/${CARD}.json`)
	let rc = null
	try { rc = require_(rcPath) } catch (e) { throw new Error(`A08 · 回执不是合法 JSON（require 失败）：${e.message}`) }
	eq(rc.card, CARD, 'A08 · 回执 card 不对')
	eq(rc.status, 'PASS', 'A08 · 回执 status 必须是 PASS（判词以本入口为准）')
	for (const key of ['completion', 'verdict', 'dependencies', 'interfaceConsumption', 'writeSet', 'writeOutOfSet', 'deltas', 'assertions', 'unverified', 'evidenceIndex', 'authorization', 'regressions']) {
		assert(key in rc, `A08 · 回执缺字段 ${key}`)
	}
	sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
	assert(/无/.test(JSON.stringify(rc.writeOutOfSet)), 'A08 · 回执必须写清越界项（无也写明）')
	eq(rc.authorization.quoteVerbatim, authDoc.quoteVerbatim, 'A08 · 回执必须逐字引用 quoteVerbatim')
	eq(rc.authorization.quoteSource, authDoc.quoteSource, 'A08 · 回执必须逐字引用 quoteSource')
	assert(/本卡不消费 A 面/.test(String(rc.authorization.statement)), 'A08 · 回执必须写明「本卡不消费 A 面，只消费 C4/C3 这类主持人裁决」')
	assert(/C4/.test(String(rc.authorization.decisions)) && /C3/.test(String(rc.authorization.decisions)), 'A08 · 回执必须点名消费的主持人裁决（C4 / C3）')
	for (const id of ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08']) {
		assert(rc.assertions && rc.assertions[id], `A08 · 回执必须逐项写清 ${id} 的断言内容`)
	}
	assert(Array.isArray(rc.deltas) && rc.deltas.length >= 4, `A08 · 回执必须逐条登记真实 Δ（实得 ${rc.deltas ? rc.deltas.length : 0} 条）`)
	assert(rc.unverified.some((u) => /U19/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记"仓内随包闭包待 U19"')
	assert(rc.unverified.some((u) => /U17/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记"迁移后产品全链路读回归 U17"')
	assert(rc.unverified.some((u) => /R1/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 R1（包侧 unify 副本）')
	assert((rc.regressions || []).some((r) => /lib\/gate\.js/.test(JSON.stringify(r))), 'A08 · 新发现的旧降维必须登记（lib/gate.js 的 previousLesson 按裸点过滤）')
	assert((rc.regressions || []).some((r) => /T03/.test(JSON.stringify(r))), 'A08 · 必须登记 T03 对 mods/author.js 的源码字面量约束（本卡按它执行）')
	for (const dep of ['U02', 'U09', 'U10']) {
		assert(rc.dependencies && rc.dependencies.status && rc.dependencies.status[dep], `A08 · 回执的依赖摘要里缺 ${dep}`)
	}

	DETAIL.comparisons = {
		...DETAIL.comparisons,
		anchors: anchors.at,
		writeSetFacts: facts,
		legacyAssertionGate: { rows: legacyRows, selfTest: selfTest.length },
		writeGuard: { installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount, ops: guard.ops, probe: guard.probe, violations: guard.violations, proof: wProof.rows },
		authorizedUnion: {
			cards: s6.size, paths: union.size, authorization: auth.citations,
			trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) || [] })),
			untrackedCount: untracked.length, outOfBounds: scopeCheck.outOfBounds, proof: sProof.rows,
		},
		contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
		receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length, regressions: (rc.regressions || []).length },
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */

/** 写守卫必须在**第一笔写之前**挂上（本卡的写全在 A01–A08 与收口落盘里） */
if (IS_MAIN) {
	fs.mkdirSync(RUN_TEMP, { recursive: true })
	recordAnchors()
	installWriteGuard(writeAllowScope())
	try {
		probeWriteGuard()
	} catch (e) {
		WRITE_GUARD.probeError = String(e?.message ?? e)
	}
}

const CASES = [
	{ id: 'A01', run: A01, timeoutMs: 180000 },
	{ id: 'A02', run: A02, timeoutMs: 240000 },
	{ id: 'A03', run: A03, timeoutMs: 180000 },
	{ id: 'A04', run: A04, timeoutMs: 180000 },
	{ id: 'A05', run: A05, timeoutMs: 240000 },
	{ id: 'A06', run: A06, timeoutMs: 180000 },
	{ id: 'A07', run: A07, timeoutMs: 300000 },
	{ id: 'A08', run: A08, timeoutMs: 240000 },
]

/** 收口复核：整个进程的写 + 交付物内容锁 + 依赖自锚（在所有写之后再看一遍） */
function closingAudit() {
	const w = sweepWriteGuard()
	const c = verifyContentLock()
	const a = verifyAnchors()
	const reasons = []
	if (!w.installed) reasons.push('写守卫没挂上')
	if (w.probeError) reasons.push(`探针写失败：${w.probeError}`)
	if (w.probe && w.probe.recorded !== true) reasons.push('探针写未被守卫记录到')
	for (const v of w.violations.slice(0, 2)) reasons.push(`越界写 ${v.op} ${v.target}`)
	for (const m of c.mismatches.slice(0, 2)) reasons.push(`交付物被改 ${m.path}`)
	for (const ch of a.changed.slice(0, 2)) reasons.push(`依赖在运行期间被改 ${ch.path}`)
	return { ok: reasons.length === 0, reasons, writeGuard: w, contentLock: c, anchors: a }
}

/** 收口发现越界 → 把 PASS 降成 FAIL（判词与落盘记录一致：以收口结果为准） */
function demoteVerdict(v, reasons) {
	const reason = `A08 · 收口复核失败：${reasons.slice(0, 2).join('；')}`
	const cases = v.cases.map((c) => (c.id === 'A08' ? { ...c, actual: 'fail', note: `${c.note ? `${c.note} | ` : ''}${reason}` } : c))
	const failed = cases.filter((c) => c.actual !== 'pass').length
	const passed = cases.filter((c) => c.actual === 'pass').length
	return {
		...v, status: 'FAIL', code: 1, cases, failed, passed,
		line: `FAIL ${CARD} checks=${cases.length} failed=${failed} skipped=0 :: ${reason}`,
	}
}

let verdict = null
if (IS_MAIN) {
	try {
		verdict = await runCard(CARD, FIXED_IDS, CASES, {
			argv: ARGV,
			blocked: evidenceGuard.ok ? null : `证据根解析失败：${evidenceGuard.error}`,
		})
	} finally {
		const resolved = path.resolve(RUN_TEMP)
		const own = path.dirname(resolved) === path.resolve(TEMP_PARENT) && path.basename(resolved).startsWith(`${CARD.toLowerCase()}-${process.pid}-`)
		if (own) {
			fs.rmSync(resolved, { recursive: true, force: true })
			DETAIL.tempCleaned = !fs.existsSync(resolved)
		} else {
			DETAIL.tempCleaned = false
			DETAIL.tempCleanupRefused = resolved
		}
	}

	if (evidenceGuard.ok) writeRunEvidence(verdict, evidenceGuard.root)

	const closing = closingAudit()
	DETAIL.closing = {
		ok: closing.ok,
		reasons: closing.reasons,
		writeCount: closing.writeGuard.writeCount,
		violations: closing.writeGuard.violations,
		contentLockChecks: closing.contentLock.checks,
		contentLockMismatches: closing.contentLock.mismatches,
		anchors: closing.anchors.changed,
	}
	if (!closing.ok && verdict.status === 'PASS') {
		verdict = demoteVerdict(verdict, closing.reasons)
		if (evidenceGuard.ok) writeRunEvidence(verdict, evidenceGuard.root)
	}

	if (evidenceGuard.ok) {
		const dir = evidenceGuard.root
		DETAIL.entry = { file: rel(SELF), dir: path.dirname(SELF) }
		DETAIL.argv = ARGV
		DETAIL.verdict = { line: verdict.line, code: verdict.code, ms: verdict.ms }
		DETAIL.cases = Object.fromEntries(verdict.cases.map((c) => [c.id, { status: c.actual, note: c.note, ms: c.ms }]))
		DETAIL.baseline = { file: 'docs/unify/baseline.json', sha256: sha256(fs.readFileSync(path.join(REPO, 'docs/unify/baseline.json'))) }
		fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
	}
	process.exitCode = printVerdict(verdict)
}
