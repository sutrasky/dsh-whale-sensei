/**
 * test/audit/U10.mjs —— 学情台账统一的专项判据（B lane · U10）
 * ==================================================================
 * 判的是这一件事：**摸底 / 目标 / 教学记录三类台账共用同一套读取与提交基础，
 * 知识点归并走完整身份（circle/point）**，而既有的版本链、教学分节、学生原文与
 * 无时间戳约定一个字节都没变。
 *
 *   A01 三类台账均区分五态 —— missing / empty / ok / invalid / io-error 五个夹具逐类实跑；
 *       io-error（台账路径是目录）**不许**折成"没有台账"；invalid 带 `LEDGER_INVALID`。
 *   A02 `null` 与坏记录不进入**有效** latest —— `null` / 数组 / 标量行不进 entries / latest /
 *       latestValid；坏值行仍按既有契约"原文保留"（test/goals.mjs 钉着），但**不进** latestValid。
 *   A03 跨圈同名点的摸底与目标版本互不影响 —— a/x 与 b/x 各自一条版本线、互不盖章；
 *       裸 x 在两圈都有 → 明确拒（entry null），不猜。
 *   A04 目标学生原话逐字保留、文件不引入时间戳 —— 原文/理由逐字相等、键序钉死、
 *       整份文件不命中 ISO 时间戳、无 at/ts/generatedAt/updatedAt、前缀字节逐字节保留。
 *   A05 既有版本链和教学分节语义保持 —— 改前 `pre-change.json` 的观测快照（旧实现）
 *       与改后同一份观测**逐字段对拍 0 差异**（含台账字节 sha256 / 拒写措辞 / 裸点容忍）。
 *   A06 读改写与版本分配在共同提交边界内 —— 每次追加恰好进一次事务；计划过期 → PLAN_STALE
 *       且零覆盖；模拟并发抢先写 → 重读重算后成功（版本唯一、无空号）；坏账本 → LEDGER_INVALID
 *       且**一次事务都没进**；严格面在碰事务之前就拒。
 *   A07 变异有效性（只在 E:\\Temp 副本）—— ① 恢复"裸点归并" ⇒ 跨圈判据必须红；
 *       ② 把读取故障折成空态（吞 IO 错误）⇒ 五态判据必须红；干净副本必须绿；仓内零影响。
 *   A08 证据及范围守卫有效 —— 改前材料/导出面/依赖自锚 + 进程内 fs 写守卫（探针写自证）+
 *       授权写集并集（interfaces.md §6 ∪ authorization.json 现场解析的 §12 A 面）+
 *       交付物内容锁 + `--evidence-root` 守卫 + 临时目录归属清理 + tracked 回执五项；
 *       **A 授权面本体**：旧形状拒绝、跨圈歧义拒绝、U05 真 CLI 迁移后回读/追加断言。
 *
 * 判词**只有一行**（unify-runner.printVerdict）：
 *   `PASS U10 checks=8 failed=0 skipped=0` → exit 0 ／ `FAIL U10 …` → 1 ／ `BLOCKED U10 …` → 2
 *
 * 不跑任何既有套件（它们是 U20 的活）、不访问/不写活包、不做任何 git 写、不改任何 T 证据。
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

const CARD = 'U10'
const SELF = fileURLToPath(import.meta.url)
const HERE = path.dirname(SELF)
const ARGV = process.argv.slice(2)
const require_ = createRequire(import.meta.url)

const EVIDENCE_ROOT_READ = path.join(REPO, 'audit-evidence', CARD)
const PRE_FILE = path.join(EVIDENCE_ROOT_READ, 'pre-change.json')
const FIXTURES_FILE = path.join(EVIDENCE_ROOT_READ, 'fixtures.mjs')
const CAPTURE_FILE = path.join(EVIDENCE_ROOT_READ, 'capture-baseline.mjs')

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

/* ══════════════════════════════════════════════════════════════════════
 * 落点与写集
 * ══════════════════════════════════════════════════════════════════════ */

/** 权威内核（唯一手工源码：三类台账的共同读取与提交基础） */
const KERNEL = 'lib/unify/stage.cjs'

/** 三个宿主适配层（导出面 / 参数 / 默认值 / 返回形状逐字保留） */
const HOST = Object.freeze({
	intake: 'lib/intake.js',
	goals: 'lib/goal-io.js',
	teaching: 'lib/teaching-io.js',
})

/** A 面（§12 选项 A 授权 U10 独占的那一份既有测试的身份预期） */
const A_FACE = 'test/intake.mjs'

/**
 * A 面上被替换的 8 行（行号只是定位快照，判据按原文搜索 + 逆替换核对）
 * 前 6 行 = 首轮知识点身份（裸 point 'vue' → 'programming/vue'）；
 * 后 2 行 = 第 267/272 行的**课次**身份（旧 2 段 'spring-boot/0001' → 规范 3 段 'programming/spring-boot/0001'），
 * 与 U09/U10 收敛后运行态给出的规范课次键对齐；非身份语义（跳闸理由仍点名这门课、夹具语义）一字未动。
 */
const A_FACE_ROWS = Object.freeze([
	{ line: 71, now: "point: 'programming/vue'" },
	{ line: 78, now: "read1.latest['programming/vue']" },
	{ line: 81, now: "point: 'programming/vue'" },
	{ line: 86, now: "read2.latest['programming/vue']" },
	{ line: 87, now: "read2.latest['programming/vue']" },
	{ line: 90, now: "intakeStatus(tmp, 'programming/vue')" },
	{ line: 267, now: "(pg1.missing || []).includes('programming/spring-boot/0001')" },
	{ line: 272, now: "learned: ['programming/spring-boot/0001']" },
])

/**
 * interfaces.md §6 里 U10 的落点（**7 项**，顺序与 §6 该行逐条一致）。
 * 第 5 项 `test/intake.mjs` 是 **§12 A 授权面**：主持人裁决后 §6 是"U 卡授权落地台账"的唯一来源，
 * 所以 A 面也进 §6 —— 但它**必须**带「仅 §12 A 授权面」限定语（见 proveSection6Qualifier），
 * 且授权的权威来源**仍是** `docs/unify/authorization.json` 的人类原文（见 proveAfaceAuthority）。
 */
const STAGE_SET = Object.freeze([
	KERNEL,
	HOST.intake,
	HOST.goals,
	HOST.teaching,
	A_FACE,
	'test/audit/U10.mjs',
	'docs/unify/receipts/U10.json',
])

/** 卡面精确写集（= §6 的 7 项，A 面已在 STAGE_SET 里，去重后仍是 7 项；顺序沿用回执既有顺序） */
const WRITE_SET = Object.freeze([...STAGE_SET.filter((p) => p !== A_FACE), A_FACE])

/** 改前存在的四个文件（其余三个是被新建的） */
const CHANGED_FILES = Object.freeze([HOST.intake, HOST.goals, HOST.teaching, A_FACE])

/**
 * 运行期**自锚**的依赖：不是本卡写集，但本卡结论依赖它们。
 * 本次进程开始时记 sha256，收口前再比一次必须相同（并发 lane 的**跨次**变化不算越界，
 * **本次运行期间**的变化才算 —— 那会让 A01–A06 不再对同一份依赖成立）。
 */
const ANCHOR_FILES = Object.freeze([
	'lib/unify/identity.cjs',
	'lib/unify/errors.cjs',
	'lib/unify/ledger-read.cjs',
	'lib/unify/commit.cjs',
	'lib/unify/migration.cjs',
	'tools/migrate-pack.mjs',
	'lib/pack-template/tools/ledger-transaction.cjs',
	'lib/pack-model.js',
	'lib/point-ref.js',
	'lib/state.js',
])

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { temp: RUN_TEMP }

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
	if (a !== b) throw new Error(`${msg}\n  实得 ${a.slice(0, 600)}\n  期望 ${b.slice(0, 600)}`)
}
/** 深度对拍：返回差异路径清单（"整体不一致"不可用，差异要落到具体字段） */
export function deepDiffs(pre, cur, at = '', out = []) {
	const ja = JSON.stringify(pre)
	const jb = JSON.stringify(cur)
	if (ja === jb) return out
	const both = pre && cur && typeof pre === 'object' && typeof cur === 'object' && Array.isArray(pre) === Array.isArray(cur)
	if (both) {
		for (const k of new Set([...Object.keys(pre), ...Object.keys(cur)])) deepDiffs(pre[k], cur[k], at ? `${at}.${k}` : String(k), out)
		return out
	}
	out.push({ path: at || '(根)', before: String(ja).slice(0, 240), after: String(jb).slice(0, 240) })
	return out
}
function assertNoDiff(preValue, curValue, group) {
	const diffs = deepDiffs(preValue, curValue, group)
	eq(diffs.length, 0,
		`${group} 与改前不一致（${diffs.length} 处）：${diffs.slice(0, 3).map((d) => `${d.path} 改前=${d.before} 改后=${d.after}`).join(' | ')}`)
	return diffs
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
/** 跑一个 CLI（数组参数，不依赖 shell 续行） */
function runCli(argv, { cwd = REPO, timeoutMs = 120000 } = {}) {
	const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
	return { status: r.status, signal: r.signal, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error ? String(r.error.message) : null }
}

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

const LEDGER_REL = Object.freeze({
	intake: 'learning-records/intake.jsonl',
	goals: 'learning-records/goals.jsonl',
	teaching: 'learning-records/teaching.jsonl',
})

let fixtureSeq = 0
/** 在本次临时根下造一个**真**课程包目录（readPack 读得出来的那种） */
function makePack(tag, circles = [{ id: 'programming', points: ['vue', 'react'] }]) {
	fixtureSeq += 1
	const root = path.join(RUN_TEMP, `${tag}-${fixtureSeq}`)
	const write = (relPath, obj) => {
		const f = path.join(root, relPath)
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
	}
	fs.mkdirSync(root, { recursive: true })
	write('presets/whale-sensei.css', {})
	for (const c of circles) {
		write(`lessons/${c.id}/halo.json`, { halo: c.id, name: c.name || c.id })
		for (const p of c.points) write(`lessons/${c.id}/${p}/point.json`, { point: p, name: p, label: '', fileBase: 0, requires: [] })
	}
	write('progress.json', { learned: [] })
	return root
}
function ledgerAbs(root, kind) {
	return path.join(root, ...LEDGER_REL[kind].split('/'))
}
function writeLedgerLines(root, kind, lines) {
	const f = ledgerAbs(root, kind)
	fs.mkdirSync(path.dirname(f), { recursive: true })
	fs.writeFileSync(f, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
	return f
}
function ledgerLines(root, kind) {
	const f = ledgerAbs(root, kind)
	if (!fs.existsSync(f)) return []
	return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
}

/** 一条合法院位终点记录（读侧严格校验能过的最小形态；键序按 GOAL_KEYS） */
function goalRecord(point, v, { replaces = null, tier = 3, what = '一个能跑起来的服务' } = {}) {
	return {
		schema: 'whale-goal/1',
		point,
		pointPath: point.includes('/') ? point : null,
		v,
		tier,
		artifact: { what, where: null },
		acceptance: [{ no: 1, deliverable: '能跑起来', auto: false, hint: '老师口头确认' }],
		focus: null,
		from: null,
		source: 'manual',
		replaces,
		reason: null,
	}
}
function intakeRecord(point, level = '有基础', goal = '能改页面', at = '2026-10-01') {
	return { point, level, goal, at }
}
function teachingRecord(over = {}) {
	return {
		schema: 'whale-teaching/1',
		v: 1,
		replaces: null,
		reason: null,
		circle: '*',
		kind: 'values',
		tier: 1,
		params: {},
		freeText: [],
		source: 'student',
		...over,
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U04/U11 同一套纪律；本文件独立实现，不 import 兄弟卡的纯函数）
 * ──────────────────────────────────────────────────────────────────────
 * 「一个工作树、多 lane 并发」下，拿"改前整树 ↔ 现在的树"做全量对拍会**结构性假红**：
 * 兄弟 lane（U09 正在改 pack-model / point-ref / lesson-map）落它们自己的合法写集会被算到本卡头上。
 * 所以判据换成四条可归因口径：
 *   ① 进程内 fs 写守卫 —— 本卡**本次进程**的每一次写都必须落在
 *      { 写集 7 项 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 }，并用**探针写**自证；
 *   ② 授权写集并集（tracked 侧）—— `git status --porcelain -uall` 的 tracked 改动
 *      必须 ⊆ U01–U20 全部卡授权写集（interfaces.md §6，独立解析）∪ §12 A 授权面
 *      （`docs/unify/authorization.json` 的 `scope.A` 与 `derivedConsequences.C4` **现场解析**）；
 *   ③ 本卡交付物内容锁 —— 7 个文件记录的 sha256 在本次运行结束时必须仍等于实际值；
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
		scope: WRITE_GUARD.scope
			? { files: [...WRITE_GUARD.scope.files], roots: WRITE_GUARD.scope.roots.slice() }
			: null,
		writeCount: WRITE_GUARD.writes.length,
		ops: [...new Set(WRITE_GUARD.writes.map((w) => w.op))].sort(),
		writes: WRITE_GUARD.writes.slice(),
		violations: WRITE_GUARD.violations.slice(),
		probe: WRITE_GUARD.probe,
		probeError: WRITE_GUARD.probeError,
	}
}

/* ── 授权写集并集（tracked 侧：§6 ∪ §12 A 授权面） ─────────────────────── */

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

/** §12 A 授权面在 §6 里必须带的限定语（A 面那一项要被**显式标注**，不许混成普通落点） */
export const A_FACE_QUALIFIER = '仅 §12 A 授权面'

/** 人类授权的原文（逐字）—— A 面能不能动，判的是这句话，不是 §6 的表格 */
const A_QUOTE_VERBATIM = '选A和授权p1和p2'

/**
 * 把 §6 里某一张卡的那一行按 `<br>` **逐段**拆开（纯函数，不 import 兄弟卡的常量）：
 * 每一段 = 一个落点（`✅ path（说明）` / `† path` / 一句目录说明），带上行号外的原文。
 * `path` 取该段第一个"像仓库路径"的反引号 token；`faceQualifier` 记这段有没有 A 面限定语。
 */
export function parseSection6Row(text, card) {
	const row = String(text).split('\n').find((line) => new RegExp(`^\\|\\s*${card}\\s*\\|`).test(line)) ?? null
	if (row === null) return { found: false, card, row: null, segments: [] }
	const cells = row.split('|')
	const body = cells.length >= 3 ? cells.slice(2, -1).join('|') : ''
	const segments = body.split(/<br\s*\/?>/i).map((raw) => {
		const pathToken = [...raw.matchAll(/`([^`]+)`/g)].map((x) => x[1]).find((t) => looksLikeRepoPath(t)) ?? null
		return {
			raw: raw.trim(),
			path: pathToken,
			star: /^\s*✅/.test(raw) ? '✅' : /^\s*†/.test(raw) ? '†' : '',
			faceQualifier: raw.includes(A_FACE_QUALIFIER),
		}
	})
	return { found: true, card, row, segments }
}

/**
 * **A 面标注判据**（纯函数，喂原文绿 / 喂改坏的原文必须红）：
 *   · §6 里该卡行的 `test/intake.mjs` 那一条**必须**带「仅 §12 A 授权面」，且限定语必须紧跟在
 *     这个路径之后（同一段落里，不是挂在行尾的装饰）；
 *   · 该行**除 `test/intake.mjs` 外**的落点**一个都不许**带这句限定语（A 面只有一个文件）。
 * 这样"台账里 A 面是被显式标注的"就被钉住了，而不是"§6 里不该出现 A 面"这种随裁决失效的断言。
 */
export function proveSection6Qualifier(text, card) {
	const parsed = parseSection6Row(text, card)
	const failures = []
	if (!parsed.found) {
		failures.push(`§6 里没有 ${card} 这一行`)
		return { ok: false, failures, row: null, segments: [], face: null }
	}
	const face = parsed.segments.filter((s) => s.path === A_FACE)
	if (face.length !== 1) {
		failures.push(`§6 ${card} 行的 ${A_FACE} 落点必须恰好一条（实得 ${face.length}）`)
	} else if (!face[0].faceQualifier) {
		failures.push(`${A_FACE} 那条没带限定语「${A_FACE_QUALIFIER}」（实得 ${JSON.stringify(face[0].raw.slice(0, 120))}）`)
	} else {
		const tail = face[0].raw.slice(face[0].raw.indexOf(A_FACE) + A_FACE.length)
		if (!tail.includes(A_FACE_QUALIFIER)) {
			failures.push(`限定语必须紧跟在 ${A_FACE} 之后、写在同一条落点里（实得 ${JSON.stringify(tail.slice(0, 120))}）`)
		}
	}
	for (const s of parsed.segments) {
		if (!s.path || s.path === A_FACE) continue
		if (s.faceQualifier) failures.push(`${s.path} 那一条不该带「${A_FACE_QUALIFIER}」（A 面只有 ${A_FACE} 一个文件）`)
	}
	return { ok: failures.length === 0, failures, row: parsed.row, segments: parsed.segments, face: face[0] ?? null }
}

/**
 * **A 面的权威链**（纯函数）：`docs/unify/authorization.json` 的 `quoteVerbatim` 必须逐字等于人类原话、
 * `quoteSource` 必须写着出处、`scope.A` 必须点名「U10 独占 test/intake.mjs」。
 * §6 只是**落地台账** —— 只有 §6 的标注、没有这段原文时，A 面必须红（不许静默放行）。
 */
export function proveAfaceAuthority(authDoc) {
	const failures = []
	const qv = String((authDoc && authDoc.quoteVerbatim) ?? '')
	const qs = String((authDoc && authDoc.quoteSource) ?? '')
	if (!qv.trim()) failures.push('authorization.json 缺 quoteVerbatim —— A 面没有人类授权原文，只有 §6 标注不算数')
	else if (qv !== A_QUOTE_VERBATIM) failures.push(`quoteVerbatim 必须逐字等于「${A_QUOTE_VERBATIM}」（实得 ${JSON.stringify(qv)}）`)
	if (!qs.trim()) failures.push('authorization.json 缺 quoteSource —— 原文出处没写')
	const authorized = [...(((authDoc && authDoc.scope && authDoc.scope.A && authDoc.scope.A.authorized) || []))]
	const named = authorized.filter((l) => /\bU10\b/.test(String(l)) && String(l).includes(A_FACE))
	if (named.length === 0) failures.push(`scope.A.authorized 里没有一条同时点名 U10 与 ${A_FACE}`)
	const mine = authorizationExtras(authDoc).extras.get('U10') || []
	if (!mine.includes(A_FACE)) failures.push(`按 scope.A 解析出来的 U10 授权面里没有 ${A_FACE}`)
	return { ok: failures.length === 0, failures, quoteVerbatim: qv, quoteSource: qs, named, extras: mine }
}

/**
 * **§12 A 授权面**（纯函数，直接从 `authorization.json` 的原文解析，不硬编码）：
 *   · `scope.A.authorized` 里同一句里出现 `<U 卡号>` 与仓库路径的，算那张卡的授权落点
 *     （「U10 独占 test/intake.mjs …」「U09 独占 test/mirror-parity.mjs …」）；
 *   · `derivedConsequences.items[]` 里 id 为 C4 的条目，其 `what`/`decision` 里反引号包着的
 *     仓库路径算到它点名的卡（C4 = `lib/point-ref.js` 归 U09）。
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
	for (const line of (authDoc && authDoc.scope && authDoc.scope.A && authDoc.scope.A.authorized) || []) {
		const text = String(line)
		const card = /\b(U\d\d)\b/.exec(text)
		if (!card) continue
		for (const m of text.matchAll(/`?([A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]+)`?/g)) {
			const p = m[1]
			if (!looksLikeRepoPath(p)) continue
			if (!/^(?:lib|test|docs|tools)\//.test(p)) continue
			add(card[1], p, 'authorization.scope.A.authorized')
		}
	}
	for (const item of (authDoc && authDoc.derivedConsequences && authDoc.derivedConsequences.items) || []) {
		if (String(item && item.id) !== 'C4') continue
		const text = `${item.what || ''}\n${item.decision || ''}`
		const card = /\b(U\d\d)\b/.exec(text)
		if (!card) continue
		for (const m of text.matchAll(/`([^`]+)`/g)) {
			const p = m[1]
			if (looksLikeRepoPath(p) && /^(?:lib|test|docs|tools)\//.test(p)) add(card[1], p, 'authorization.derivedConsequences.C4')
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
		else outOfBounds.push({ code: e.code, path: e.path, why: '已跟踪文件被改/删/增/改名，而路径不在任何 U 卡的授权写集里（§6 ∪ §12 A）' })
		if (e.from) {
			if (union.has(e.from)) allowed.push({ code: e.code, path: e.from, note: 'rename 来源' })
			else outOfBounds.push({ code: e.code, path: e.from, why: 'rename 的来源路径不在任何 U 卡授权写集里（§6 ∪ §12 A）' })
		}
	}
	return { allowed, outOfBounds }
}

/**
 * A08 的**红路径本体**之一：喂人造 porcelain 行，双向钉死。
 * 关键一条：**不在任何授权落地台账里的既有测试改动必须被拒** —— 拿真实的既有测试文件
 * （`test/alien-env.mjs`，§6 与 `authorization.json` 都没收它）当红样本；
 * ⚠️ 决-B1（决-9）之后 `test/pack-template-rules.mjs` 已由 §6 的 U19 行逐条登记
 * （只加登记项），它不再是红样本 —— 红样本换成仍然无主的 `test/alien-env.mjs`，
 * "无主即拒"这条判据强度一条没降。
 * A 面 `test/intake.mjs` 则必须放行（它同时落在 §6 的 U10 行与 §12 A 面里）。
 * "A 面凭什么能动"另由 `proveAfaceAuthority` 钉在授权原文上（本函数只管并集边界）。
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
	one(' M lib/intake.js', 'allow', '本卡（U10）写集')
	one(' M lib/unify/stage.cjs', 'allow', '本卡（U10）写集')
	one(' M test/intake.mjs', 'allow', '§12 A 授权面（也在 §6 U10 行里，带限定语）')
	one(' M lib/pack-model.js', 'allow', 'U09 写集（并发）')
	one(' M lib/point-ref.js', 'allow', 'authorization C4 追加给 U09（并发）')
	one(' M lib/render.js', 'allow', 'U07 写集（并发）')
	one(' M test/mirror-parity.mjs', 'allow', '§12 A 授权给 U09')
	one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
	one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
	one(' M test/alien-env.mjs', 'reject', '既有测试、且不在任何授权落地台账里（§6 与 §12 A 都不收它）—— 必须被拒')
	one(' D test/all.mjs', 'reject', '既有总入口被删')
	one('R  lib/intake.js -> lib/whatever.js', 'reject', '改名到野路径（来源合法、目标不合法）')
	one('A  cards/U10.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
	one(' M audit-evidence/U10/pre-change.json', 'reject', '证据目录不被 §6 授权（它是 gitignore 的原始证据）')
	one(' M docs/unify/authorization.json', 'reject', '授权原文不是任何卡的落点 —— 抽掉 §12 A / §6 都改不动它')
	{
		const mixed = classifyTrackedWrites(
			splitPorcelainTracked([' M lib/intake.js', ' M lib/render.js', ' M scripts/x.mjs']).tracked, union)
		const got = mixed.outOfBounds.map((v) => v.path).join(',')
		rows.push({
			line: 'MIX[ M lib/intake.js | M lib/render.js | scripts/x.mjs]', expect: 'scripts/x.mjs', got,
			ok: got === 'scripts/x.mjs' && mixed.outOfBounds.length === 1, why: '混合输入只抓野路径',
		})
	}
	return { unionSize: union.size, bareUnionSize: bareUnion.size, cards: sets.size, rows, failures: rows.filter((r) => !r.ok) }
}

/** A08 红路径之二：写允许面的边界（兄弟 lane 的合法写入，对**本卡进程**仍判越界） */
export function proveWriteScope(scope) {
	const s = scope ?? writeAllowScope()
	const cases = [
		[KERNEL, 'allow', '本卡写集（权威内核）'],
		[HOST.intake, 'allow', '本卡写集（摸底适配层）'],
		[A_FACE, 'allow', '本卡写集（§12 A 面）'],
		['docs/unify/receipts/U10.json', 'allow', '本卡写集（tracked 回执）'],
		['test/audit/U10.mjs', 'allow', '本卡写集（本入口）'],
		[path.join(s.roots[0], 'a07-clean', 'lib', 'unify', 'stage.cjs'), 'allow', 'E:\\Temp 本次临时根下的自建副本'],
		['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
		['lib/pack-model.js', 'reject', 'U09 写集 —— 同上'],
		['test/mirror-parity.mjs', 'reject', 'U09 的 A 面 —— 同上'],
		['lib/unify/text.cjs', 'reject', 'U04 写集 —— 同上'],
		['audit-evidence/U11/pre-change.json', 'reject', '兄弟卡的改前材料（本卡只读）'],
		['lib/whatever.js', 'reject', '野路径'],
		['test/_pack.mjs', 'reject', '既有测试'],
		[path.join(TEMP_PARENT, 'u10-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
		['C:\\Windows\\u10-x.txt', 'reject', '与仓无关的绝对路径'],
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
 * 材料加载
 * ══════════════════════════════════════════════════════════════════════ */

let _pre = null
function pre() {
	if (_pre) return _pre
	if (!fs.existsSync(PRE_FILE)) {
		throw new Blocked(`缺改前采集材料：${rel(PRE_FILE)} —— 先跑 node audit-evidence/U10/capture-baseline.mjs（在改动之前）`)
	}
	let doc = null
	try { doc = JSON.parse(readText(PRE_FILE)) } catch (e) { throw new Error(`改前材料不是合法 JSON：${e.message}`) }
	_pre = doc
	return doc
}

/** 三个适配层（ESM；从仓根或 E:\Temp 副本加载同一套代码） */
async function loadAdapters(baseDir = REPO) {
	const out = {}
	for (const [key, relPath] of Object.entries(HOST)) out[key] = await import(pathToFileURL(path.join(baseDir, ...relPath.split('/'))).href)
	return out
}
/** 权威内核（CJS） */
function kernel(baseDir = REPO) {
	return require_(path.join(baseDir, ...KERNEL.split('/')))
}
/** 错误结构（U03）：判 failure 形状用 */
function errorsKernel(baseDir = REPO) {
	return require_(path.join(baseDir, 'lib', 'unify', 'errors.cjs'))
}

/* ══════════════════════════════════════════════════════════════════════
 * 判官（A01/A03 与 A07 用**同一份**判官；A07 只是把模块换成变异副本）
 * ══════════════════════════════════════════════════════════════════════ */

const STATUSES = ['missing', 'empty', 'ok', 'invalid', 'io-error']

/**
 * A01 的本体：三类台账 × 五个状态夹具，逐类实跑，返回观测与违规项。
 * @param {{intake:object, goals:object, teaching:object}} mods
 * @param {string} base 本次临时根（夹具落这里）
 */
export async function judgeFiveStates(mods, base) {
	const tag = () => path.join(base, 'five', crypto.randomBytes(3).toString('hex'))
	const mk = (name) => { const d = path.join(tag(), name); fs.mkdirSync(d, { recursive: true }); return d }
	const observed = {}
	const violations = []
	const readers = {
		intake: (root) => mods.intake.readIntake(root),
		goals: (root) => mods.goals.readGoals(root),
		teaching: (root) => mods.teaching.readTeaching(root),
	}
	const okLines = {
		intake: [JSON.stringify(intakeRecord('programming/vue'))],
		goals: [JSON.stringify(goalRecord('programming/vue', 1))],
		teaching: [JSON.stringify(teachingRecord())],
	}
	for (const kind of Object.keys(readers)) {
		const row = {}
		{
			const r = readers[kind](mk('missing'))
			row.missing = { status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length }
		}
		{
			const root = mk('empty')
			writeLedgerLines(root, kind, [])
			const r = readers[kind](root)
			row.empty = { status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length }
		}
		{
			const root = mk('ok')
			writeLedgerLines(root, kind, okLines[kind])
			const r = readers[kind](root)
			row.ok = { status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length }
		}
		{
			const root = mk('invalid')
			writeLedgerLines(root, kind, [...okLines[kind], '这不是合法JSON{{{]'])
			const r = readers[kind](root)
			row.invalid = { status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length, failureCode: r.failure ? r.failure.code : null }
		}
		{
			const root = mk('io')
			fs.mkdirSync(ledgerAbs(root, kind), { recursive: true })
			const r = readers[kind](root)
			row.io = {
				status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length,
				errorCode: r.errorCode === undefined ? null : r.errorCode, failureCode: r.failure ? r.failure.code : null,
			}
		}
		observed[kind] = row
		const want = {
			missing: { status: 'missing', exists: false, entries: 0, problems: 0 },
			empty: { status: 'empty', exists: true, entries: 0, problems: 0 },
			ok: { status: 'ok', exists: true },
			invalid: { status: 'invalid', failureCode: 'LEDGER_INVALID' },
			io: { status: 'io-error', entries: 0, errorCode: 'EISDIR', failureCode: 'IO_ERROR' },
		}
		for (const [state, expect] of Object.entries(want)) {
			for (const [k, v] of Object.entries(expect)) {
				if (state === 'ok' && k === 'entries') {
					if (!(row.ok.entries >= 1)) violations.push({ kind, state, msg: `ok 态一条记录都没读出来（${row.ok.entries}）` })
					continue
				}
				if (row[state][k] !== v) violations.push({ kind, state, msg: `${kind}/${state}.${k} 应为 ${fmt(v)}，实得 ${fmt(row[state][k])}` })
			}
		}
		if (row.invalid.problems < 1) violations.push({ kind, state: 'invalid', msg: `${kind}/invalid 没有 problems（坏行被吞了）` })
		if (row.io.problems < 1) violations.push({ kind, state: 'io', msg: `${kind}/io-error 没有 problems（读取故障被吞成空台账）` })
		const gotStatuses = [row.missing.status, row.empty.status, row.ok.status, row.invalid.status, row.io.status]
		if (new Set(gotStatuses).size !== 5) violations.push({ kind, state: '-', msg: `${kind}：五态没有区分开（${gotStatuses.join(' / ')}）` })
	}
	return { observed, violations }
}

/**
 * A03 的本体：跨圈同名点（a/x 与 b/x）的摸底 / 目标版本互不影响。
 */
export async function judgeCrossCircle(mods, base) {
	const violations = []
	fixtureSeq += 1
	const root = path.join(base, 'cross', crypto.randomBytes(3).toString('hex'))
	const write = (relPath, obj) => {
		const f = path.join(root, relPath)
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
	}
	fs.mkdirSync(root, { recursive: true })
	write('presets/whale-sensei.css', {})
	for (const id of ['a', 'b']) {
		write(`lessons/${id}/halo.json`, { halo: id, name: id })
		write(`lessons/${id}/x/point.json`, { point: 'x', name: 'x', label: '', fileBase: 0 })
	}
	write('lessons/a/vue/point.json', { point: 'vue', name: 'Vue', label: 'Vue', fileBase: 0 })
	write('progress.json', { learned: [] })

	const wa = mods.intake.recordIntake(root, { point: 'a/x', level: 'A 级', goal: 'A 目标', at: '2026-10-01' })
	const wb = mods.intake.recordIntake(root, { point: 'b/x', level: 'B 级', goal: 'B 目标', at: '2026-10-02' })
	if (!wa.ok || !wb.ok) violations.push({ state: 'intake-write', msg: `a/x 或 b/x 摸底写失败：${fmt({ a: wa.error, b: wb.error })}` })

	const read = mods.intake.readIntake(root)
	const latestKeys = Object.keys(read.latest).sort()
	if (latestKeys.join(',') !== 'a/x,b/x') violations.push({ state: 'intake-latest', msg: `latest 键应为 a/x,b/x，实得 ${latestKeys.join(',')}` })

	const fa = mods.intake.latestIntakeFor(root, 'a/x')
	const fb = mods.intake.latestIntakeFor(root, 'b/x')
	if (!fa.entry || fa.entry.level !== 'A 级') violations.push({ state: 'intake-merge', msg: `a/x 的现行记录应为 'A 级'，实得 ${fmt(fa.entry && fa.entry.level)}` })
	if (!fb.entry || fb.entry.level !== 'B 级') violations.push({ state: 'intake-merge', msg: `b/x 的现行记录应为 'B 级'，实得 ${fmt(fb.entry && fb.entry.level)}` })
	if (fa.entry && fb.entry && fa.entry === fb.entry) violations.push({ state: 'intake-merge', msg: 'a/x 与 b/x 指到了同一条记录（跨圈串了）' })
	const stA = mods.intake.intakeStatus(root, 'a/x')
	const stB = mods.intake.intakeStatus(root, 'b/x')
	const stV = mods.intake.intakeStatus(root, 'a/vue')
	if (stA.done !== true || stB.done !== true) violations.push({ state: 'intake-done', msg: `a/x、b/x 都应 done（实得 ${fmt({ a: stA.done, b: stB.done })}）` })
	if (stV.done !== false) violations.push({ state: 'intake-done', msg: 'a/vue 没摸过底却 done=true（跨点串了）' })
	const stBare = mods.intake.intakeStatus(root, 'x')
	if (!stBare.ref || stBare.ref.ok !== false || stBare.ref.code !== 'ambiguous') {
		violations.push({ state: 'intake-ambiguous', msg: `裸 x 应解析成 ambiguous，实得 ${fmt(stBare.ref && stBare.ref.code)}` })
	}
	if (stBare.entry !== null || stBare.done !== false) violations.push({ state: 'intake-ambiguous', msg: '裸 x 歧义时不许给出任何一边的记录 / done' })

	const g1 = mods.goals.recordGoal(root, goalRecord('a/x', 1, { what: 'A 版 1' }))
	const g2 = mods.goals.recordGoal(root, goalRecord('b/x', 1, { what: 'B 版 1' }))
	const g3 = mods.goals.recordGoal(root, goalRecord('a/x', 2, { replaces: 1, what: 'A 版 2' }))
	if (!g1.ok || !g2.ok || !g3.ok) violations.push({ state: 'goal-write', msg: `目标写失败：${fmt([g1.error, g2.error, g3.error])}` })
	const goals = mods.goals.readGoals(root)
	if (goals.latest['a/x']?.v !== 2) violations.push({ state: 'goal-chain', msg: `a/x 现行版本应为 2，实得 ${fmt(goals.latest['a/x'] && goals.latest['a/x'].v)}` })
	if (goals.latest['b/x']?.v !== 1) violations.push({ state: 'goal-chain', msg: `b/x 现行版本应为 1（被 a/x 的 v2 带跑了），实得 ${fmt(goals.latest['b/x'] && goals.latest['b/x'].v)}` })
	const aVers = goals.entries.filter((e) => e.point === 'a/x').map((e) => e.v)
	const bVers = goals.entries.filter((e) => e.point === 'b/x').map((e) => e.v)
	if (aVers.join(',') !== '1,2' || bVers.join(',') !== '1') violations.push({ state: 'goal-chain', msg: `两条版本线应为 a/x:1,2 / b/x:1，实得 a/x:${aVers.join(',')} b/x:${bVers.join(',')}` })
	if (goals.latest['a/x']?.artifact?.what !== 'A 版 2') violations.push({ state: 'goal-chain', msg: 'a/x 的现行终点不是它自己的第 2 版' })
	if (goals.latest['b/x']?.artifact?.what !== 'B 版 1') violations.push({ state: 'goal-chain', msg: 'b/x 的现行终点被 a/x 的内容盖掉了' })

	return { violations, fixture: root, observed: { latestKeys, aVers, bVers } }
}

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 三类台账均区分五态
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
	const mods = await loadAdapters()
	const { observed, violations } = await judgeFiveStates(mods, RUN_TEMP)
	eq(violations.length, 0, `A01 · 五态判据有 ${violations.length} 处不成立：${violations.slice(0, 4).map((v) => `${v.kind}/${v.state}: ${v.msg}`).join(' | ')}`)
	for (const kind of Object.keys(observed)) {
		const row = observed[kind]
		sameJson([row.missing.status, row.empty.status, row.ok.status, row.invalid.status, row.io.status], STATUSES,
			`A01 · ${kind} 的五态必须恰好是 missing/empty/ok/invalid/io-error`)
		eq(observed[kind].io.errorCode, 'EISDIR', `A01 · ${kind} 的 io-error 必须保留系统错误码 EISDIR（不许折成空态）`)
		eq(observed[kind].invalid.failureCode, 'LEDGER_INVALID', `A01 · ${kind} 的 invalid 必须给 LEDGER_INVALID`)
	}
	const errs = errorsKernel()
	DETAIL.A01 = { observed, violations, statuses: STATUSES, errorsExports: Object.keys(errs).length }
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · null 与坏记录不进入有效 latest
 * ══════════════════════════════════════════════════════════════════════ */

async function A02() {
	const mods = await loadAdapters()
	const base = path.join(RUN_TEMP, 'a02')
	fs.mkdirSync(base, { recursive: true })
	const out = {}

	{
		const root = path.join(base, 'intake')
		fs.mkdirSync(root, { recursive: true })
		writeLedgerLines(root, 'intake', [
			JSON.stringify(intakeRecord('programming/vue', '有基础', '能改')),
			'null', '[1,2]', '"一串字符串"', '123',
			JSON.stringify(intakeRecord('programming/react', '零基础', '能写')),
		])
		let r = null
		let threw = null
		try { r = mods.intake.readIntake(root) } catch (e) { threw = e }
		eq(threw, null, `A02 · 摸底台账里有 null 行时读侧不许抛（实得 ${threw && threw.message}）`)
		eq(r.entries.length, 2, 'A02 · 摸底：只有两条真记录进 entries（null/数组/标量都不进）')
		assert(!r.entries.some((e) => e === null || Array.isArray(e) || typeof e !== 'object'), 'A02 · 摸底 entries 里混进了非记录')
		sameJson(Object.keys(r.latest).sort(), ['programming/react', 'programming/vue'], 'A02 · 摸底 latest 只含两条真记录')
		sameJson(Object.keys(r.latestValid).sort(), ['programming/react', 'programming/vue'], 'A02 · 摸底 latestValid 同口径')
		eq(r.status, 'invalid', 'A02 · 摸底：有非记录行 ⇒ 五态是 invalid')
		assert(r.problems.length >= 4, `A02 · 摸底 problems 要逐行报出（实得 ${r.problems.length} 条）`)
		out.intake = { entries: r.entries.length, latestKeys: Object.keys(r.latest), status: r.status, problems: r.problems.length }
	}

	{
		const root = path.join(base, 'goals')
		fs.mkdirSync(root, { recursive: true })
		writeLedgerLines(root, 'goals', [
			'null',
			JSON.stringify(goalRecord('spring-boot', 1, { what: '好行' })),
			JSON.stringify({ ...goalRecord('react', 1), tier: 999 }),
		])
		let r = null
		let threw = null
		try { r = mods.goals.readGoals(root) } catch (e) { threw = e }
		eq(threw, null, `A02 · 目标台账里有 null 行时读侧不许抛（实得 ${threw && threw.message}）`)
		assert(!r.entries.some((e) => e === null), 'A02 · 目标 entries 里不许出现 null')
		assert(!r.validEntries.some((e) => e === null), 'A02 · 目标 validEntries 里不许出现 null')
		eq(r.latest.react?.tier, 999, 'A02 · 既有契约保持：坏值行仍按原文保留进 latest（一条都不许静默丢）')
		eq(r.entries.length, 2, 'A02 · 既有契约保持：两条可解析行都进 entries（坏 JSON / null 除外）')
		eq(r.latestValid.react, undefined, 'A02 · 坏值行不许进 latestValid（有效 latest）')
		eq(r.latestValid['spring-boot']?.v, 1, 'A02 · 好行进 latestValid')
		eq(r.validEntries.length, 1, 'A02 · 只有一条通过校验的记录进 validEntries')
		eq(r.status, 'invalid', 'A02 · null 行 / 坏值行 ⇒ 五态 invalid（版本分配会被拒）')
		out.goals = { entries: r.entries.length, latestKeys: Object.keys(r.latest), latestValidKeys: Object.keys(r.latestValid), status: r.status }
	}

	{
		const root = path.join(base, 'teaching')
		fs.mkdirSync(root, { recursive: true })
		writeLedgerLines(root, 'teaching', ['null', JSON.stringify(teachingRecord())])
		let r = null
		let threw = null
		try { r = mods.teaching.readTeaching(root) } catch (e) { threw = e }
		eq(threw, null, `A02 · 教学台账里有 null 行时读侧不许抛（实得 ${threw && threw.message}）`)
		eq(r.entries.length, 1, 'A02 · 教学：只有一条真记录进 entries')
		eq(r.valid.entries.length, 1, 'A02 · 教学：有效面只有一条')
		eq(r.global.values?.v, 1, 'A02 · 教学：全局取值仍是最新那一条')
		assert(!r.entries.some((e) => e === null), 'A02 · 教学 entries 里不许出现 null')
		out.teaching = { entries: r.entries.length, validEntries: r.valid.entries.length, status: r.status }
	}
	DETAIL.A02 = out
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 跨圈同名点的摸底与目标版本互不影响
 * ══════════════════════════════════════════════════════════════════════ */

async function A03() {
	const mods = await loadAdapters()
	const { violations, observed } = await judgeCrossCircle(mods, RUN_TEMP)
	eq(violations.length, 0, `A03 · 跨圈隔离有 ${violations.length} 处不成立：${violations.slice(0, 4).map((v) => `${v.state}: ${v.msg}`).join(' | ')}`)
	assert(observed.latestKeys.every((k) => k.includes('/')), `A03 · 摸底 latest 的键必须都是 circle/point（实得 ${observed.latestKeys.join(',')}）`)
	DETAIL.A03 = { violations, observed }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 目标学生原话逐字保留、文件不引入时间戳
 * ══════════════════════════════════════════════════════════════════════ */

const A04_WHAT = '做一个能扫码入库、断网也能查库存的「仓库小助手」（离线优先 · PWA）'
const A04_REASON = '学生原话：我想先把我们仓库那个 Excel 换掉，扫码枪能用、没网也能查 —— 别给我加登录'

async function A04() {
	const mods = await loadAdapters()
	const base = path.join(RUN_TEMP, 'a04')
	fs.mkdirSync(base, { recursive: true })
	const input = {
		point: 'programming/vue',
		pointPath: 'programming/vue',
		tier: 3,
		artifact: { what: A04_WHAT, where: 'code/warehouse' },
		acceptance: [{ no: 1, deliverable: '扫码 → 入库 → 列表可见', auto: false, hint: '老师确认能说清数据流' }],
		focus: null,
		source: 'wizard',
		reason: A04_REASON,
	}
	const mkRoot = (tag) => { const d = path.join(base, tag); fs.mkdirSync(d, { recursive: true }); return d }
	const root = mkRoot('pack')
	const w1 = mods.goals.recordGoal(root, { ...input })
	eq(w1.ok, true, `A04 · 第 1 版终点必须写成功（${w1.error || ''}）`)
	const w2 = mods.goals.recordGoal(root, { ...input, tier: 4 })
	eq(w2.ok, true, `A04 · 第 2 版终点必须写成功（${w2.error || ''}）`)
	const ledgerFile = path.join(root, ...LEDGER_REL.goals.split('/'))
	const text = readText(ledgerFile)
	const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

	eq(rows[0].artifact.what, A04_WHAT, 'A04 · artifact.what 必须与 wizard 原文逐字相同')
	eq(rows[1].artifact.what, A04_WHAT, 'A04 · 第 2 版也逐字保留原文')
	eq(rows[1].reason, A04_REASON, 'A04 · reason 必须逐字保留学生原话')
	eq(rows[0].acceptance[0].deliverable, '扫码 → 入库 → 列表可见', 'A04 · 验收产出原文逐字保留')

	const GOAL_KEYS = 'schema,point,pointPath,v,tier,artifact,acceptance,focus,from,source,replaces,reason'
	for (const r of rows) eq(Object.keys(r).join(','), GOAL_KEYS, 'A04 · GoalRecord 键序必须钉死')
	eq(rows[0].v, 1, 'A04 · 第 1 版 v=1')
	eq(rows[1].v, 2, 'A04 · 第 2 版 v=2')
	eq(rows[1].replaces, 1, 'A04 · 第 2 版 replaces=1')

	assert(!/\d{4}-\d{2}-\d{2}T/.test(text), 'A04 · 整份 goals.jsonl 不许命中 ISO 时间戳')
	const FORBIDDEN = ['at', 'ts', 'generatedAt', 'updatedAt', 'createdAt', 'mtime']
	const hasTsKey = (o) => {
		if (!o || typeof o !== 'object') return false
		return Object.keys(o).some((k) => FORBIDDEN.includes(k) || hasTsKey(o[k]))
	}
	for (const r of rows) assert(!hasTsKey(r), 'A04 · 记录里（含嵌套）不许出现时间字段')

	const root2 = mkRoot('pack2')
	mods.goals.recordGoal(root2, { ...input })
	mods.goals.recordGoal(root2, { ...input, tier: 4 })
	eq(readText(path.join(root2, ...LEDGER_REL.goals.split('/'))), text, 'A04 · 同样输入必须产出逐字节相同的 goals.jsonl')

	const firstLine = text.slice(0, text.indexOf('\n') + 1)
	eq(text.startsWith(firstLine), true, 'A04 · 第 1 行前缀逐字节保留')
	eq(text.split(firstLine).length, 2, 'A04 · 第 1 行内容只出现一次（没有被改写）')

	DETAIL.A04 = { bytes: Buffer.byteLength(text), lines: rows.length, keys: GOAL_KEYS, what: A04_WHAT }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 既有版本链和教学分节语义保持（改前观测 ↔ 改后观测，逐字段 0 差异）
 * ══════════════════════════════════════════════════════════════════════ */

async function A05() {
	const preDoc = pre()
	assert(preDoc.behavior && preDoc.behavior.intake && preDoc.behavior.goals && preDoc.behavior.teaching,
		'A05 · 改前材料里没有 behavior 观测快照')
	const fixtures = await import(pathToFileURL(FIXTURES_FILE).href)
	const mods = await fixtures.loadAdapters()
	// 夹具落在本次临时根里（A08 的写守卫才能归因到"本卡本次"）
	const cur = await fixtures.observe(mods, { baseDir: RUN_TEMP })
	const diffs = assertNoDiff(preDoc.behavior, cur, 'A05 · 既有语义')
	assert(preDoc.behavior.goals.versions.length === 3, 'A05 · 改前快照的版本链必须真有 3 版（否则对拍是空转）')
	assert(preDoc.behavior.teaching.records.length === 4, 'A05 · 改前快照的教学记录必须真有 4 条')
	assert(preDoc.behavior.intake.lineCount === 2, 'A05 · 改前快照的摸底必须真有 2 行')
	const mutated = JSON.parse(JSON.stringify(cur))
	mutated.goals.versions[1].v = 99
	const caught = deepDiffs(cur, mutated)
	eq(caught.length, 1, 'A05 · 对拍器必须抓得住单字段差异（否则 0 差异是恒真的）')
	assert(caught[0].path.includes('versions'), 'A05 · 对拍器要指到具体路径')
	DETAIL.A05 = { diffs, versions: cur.goals.versions, teachingRecords: cur.teaching.records.length, caught }
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 读改写与版本分配在共同提交边界内
 * ══════════════════════════════════════════════════════════════════════ */

async function A06() {
	const stage = kernel()
	const TXN = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs'))
	const base = path.join(RUN_TEMP, 'a06')
	fs.mkdirSync(base, { recursive: true })
	const out = {}
	const mk = (tag) => { const d = path.join(base, tag); fs.mkdirSync(d, { recursive: true }); return d }
	const countingTxn = () => ({
		calls: 0,
		withPackTransaction(rootArg, build, opts) {
			this.calls += 1
			return TXN.withPackTransaction(rootArg, build, opts)
		},
	})
	const appendRaw = (root, text) => {
		const f = path.join(root, ...LEDGER_REL.goals.split('/'))
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.appendFileSync(f, text, 'utf8')
	}

	/* ① 正常追加：每次恰好一次事务；版本连续、无空号 */
	{
		const root = mk('serial')
		const txn = countingTxn()
		const versions = []
		for (let i = 1; i <= 3; i++) {
			const r = stage.appendRecord('goals', root, ({ beforeText }) => ({
				content: beforeText + JSON.stringify({ p: 'programming/vue', i }) + '\n',
				value: { i },
			}), { transaction: txn, ensureParent: true })
			eq(r.ok, true, `A06 · 第 ${i} 次追加必须成功（${r.error || ''}）`)
			eq(r.attempts, 1, `A06 · 第 ${i} 次追加不该重试（实得 ${r.attempts}）`)
			assert(typeof r.planDigest === 'string' && /^[0-9a-f]{64}$/.test(r.planDigest), 'A06 · 回执必须带可复算的 planDigest')
			versions.push(r.value.i)
		}
		eq(txn.calls, 3, `A06 · 三次追加必须恰好进三次事务（实得 ${txn.calls}）`)
		eq(ledgerLines(root, 'goals').length, 3, 'A06 · 台账必须正好 3 行')
		out.serial = { calls: txn.calls, versions }
	}

	/* ② 计划过期（计划生成后目标被改）：PLAN_STALE、零覆盖、版本不撞 */
	{
		const root = mk('stale')
		appendRaw(root, JSON.stringify({ p: 'programming/vue', v: 1 }) + '\n')
		const compute = ({ beforeText }) => ({
			content: beforeText + JSON.stringify({ p: 'programming/vue', v: 2 }) + '\n',
			value: { v: 2 },
		})
		const planned = stage.planAppend('goals', root, compute)
		eq(planned.ok, true, 'A06 · 计划必须造得出来（零写）')
		const beforeApply = readText(path.join(root, ...LEDGER_REL.goals.split('/')))
		appendRaw(root, JSON.stringify({ p: 'programming/vue', v: 2, by: 'intruder' }) + '\n')
		const afterIntruder = readText(path.join(root, ...LEDGER_REL.goals.split('/')))
		const receipt = stage.applyAppend('goals', root, planned, {})
		eq(receipt.ok, false, 'A06 · 计划过期之后不许提交（旧计划不许覆盖别人的字节）')
		eq(receipt.code, 'PLAN_STALE', `A06 · 过期计划的码必须是 PLAN_STALE（实得 ${receipt.code}）`)
		eq(readText(path.join(root, ...LEDGER_REL.goals.split('/'))), afterIntruder, 'A06 · 被拒之后台账必须仍是"别人写过之后"的样子（零覆盖）')
		assert(afterIntruder !== beforeApply, 'A06 · 这条判据的前提是"目标真的被改过"')
		out.stale = { code: receipt.code, state: receipt.state, bytes: afterIntruder.length }
	}

	/* ③ 模拟并发：第一次提交前别人抢先写 ⇒ 重读重算后成功（版本唯一、无空号） */
	{
		const root = mk('retry')
		appendRaw(root, JSON.stringify({ p: 'programming/vue', v: 1 }) + '\n')
		let injected = false
		const racingTxn = {
			calls: 0,
			withPackTransaction(rootArg, build, opts) {
				racingTxn.calls += 1
				if (!injected) {
					injected = true
					appendRaw(root, JSON.stringify({ p: 'programming/vue', v: 2, by: 'racer' }) + '\n')
				}
				return TXN.withPackTransaction(rootArg, build, opts)
			},
		}
		let seq = 0
		const compute = ({ beforeText }) => {
			const versions = beforeText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).v)
			const v = Math.max(0, ...versions) + 1
			seq = v
			return { content: beforeText + JSON.stringify({ p: 'programming/vue', v, by: 'me' }) + '\n', value: { v } }
		}
		const r = stage.appendRecord('goals', root, compute, { transaction: racingTxn, retries: 4 })
		eq(r.ok, true, `A06 · 计划过期之后要重读重算再提交（${r.error || ''}）`)
		assert(r.attempts >= 2, `A06 · 这条判据要求真的重试过（实得 attempts=${r.attempts}）`)
		eq(seq, 3, 'A06 · 重试后版本必须由**这一次**读到的字节算出（v=3）')
		const rows = ledgerLines(root, 'goals').map((l) => JSON.parse(l))
		const vs = rows.map((x) => x.v).sort((a, b) => a - b)
		eq(vs.join(','), '1,2,3', `A06 · 三个版本必须唯一且连续（实得 ${vs.join(',')}）`)
		assert(rows.some((x) => x.by === 'racer') && rows.some((x) => x.by === 'me'), 'A06 · 两边的写入都必须在（没有丢更新）')
		out.retry = { attempts: r.attempts, versions: vs }
	}

	/* ④ 坏账本：版本分配拒绝，且**一次事务都没进**、一个字节都没动 */
	{
		const root = mk('invalid')
		const bad = '{"p":"programming/vue","v":1}\n这不是合法JSON{{{\n'
		const f = path.join(root, ...LEDGER_REL.goals.split('/'))
		fs.mkdirSync(path.dirname(f), { recursive: true })
		fs.writeFileSync(f, bad, 'utf8')
		const txn = countingTxn()
		const r = stage.appendRecord('goals', root, ({ beforeText }) => ({
			content: beforeText + JSON.stringify({ p: 'programming/vue', v: 9 }) + '\n',
		}), { transaction: txn, ensureParent: true })
		eq(r.ok, false, 'A06 · 坏账本上不许追加')
		eq(r.code, 'LEDGER_INVALID', `A06 · 坏账本的拒绝码必须是 LEDGER_INVALID（实得 ${r.code}）`)
		eq(txn.calls, 0, `A06 · 拒绝必须发生在提交边界之前（事务调用应为 0，实得 ${txn.calls}）`)
		eq(readText(f), bad, 'A06 · 坏账本逐字节未变')
		out.invalid = { code: r.code, txnCalls: txn.calls }
	}

	/* ⑤ 严格面：旧形状（裸点）在碰事务之前就被拒 */
	{
		const root = mk('strict')
		const txn = countingTxn()
		const r = stage.appendRecord('goals', root, () => ({ content: '{}\n' }), {
			transaction: txn, ensureParent: true, strictIdentity: true, identity: 'vue',
		})
		eq(r.ok, false, 'A06 · 严格面不许接受裸点')
		eq(r.code, 'MIGRATION_REQUIRED', `A06 · 裸点的拒绝码必须是 MIGRATION_REQUIRED（实得 ${r.code}）`)
		eq(txn.calls, 0, 'A06 · 严格面的拒绝必须在碰事务之前')
		eq(fs.existsSync(path.join(root, ...LEDGER_REL.goals.split('/'))), false, 'A06 · 被拒的严格写入不许留下台账')
		out.strict = { code: r.code, txnCalls: txn.calls }
	}
	DETAIL.A06 = out
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 变异有效性（只在 E:\Temp 副本上）
 * ══════════════════════════════════════════════════════════════════════ */

/** 把仓内 lib/ 逐字复制到本次临时根（外加一个只带 type/name 的 package.json） */
function copyLib(tag) {
	const dest = path.join(RUN_TEMP, 'a07', tag)
	fs.mkdirSync(dest, { recursive: true })
	fs.cpSync(path.join(REPO, 'lib'), path.join(dest, 'lib'), { recursive: true })
	const pkg = JSON.parse(readText(path.join(REPO, 'package.json')))
	fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: pkg.name, type: pkg.type, version: pkg.version }, null, 2) + '\n', 'utf8')
	return dest
}

async function A07() {
	const repoKernelBefore = sha256(fs.readFileSync(path.join(REPO, KERNEL)))
	const repoGoalsBefore = sha256(fs.readFileSync(path.join(REPO, HOST.goals)))
	const base = path.join(RUN_TEMP, 'a07')
	fs.mkdirSync(base, { recursive: true })

	/* ① 干净副本对照：两份判官都必须绿 */
	const cleanDir = copyLib('clean')
	const cleanMods = await loadAdapters(cleanDir)
	const cleanFive = await judgeFiveStates(cleanMods, path.join(base, 'clean-eight'))
	const cleanCross = await judgeCrossCircle(cleanMods, path.join(base, 'clean-cross'))
	eq(cleanFive.violations.length, 0, `A07 · 未变异的副本必须通过五态判据（${cleanFive.violations.slice(0, 2).map((v) => v.msg).join(' | ')}）`)
	eq(cleanCross.violations.length, 0, `A07 · 未变异的副本必须通过跨圈判据（${cleanCross.violations.slice(0, 2).map((v) => v.msg).join(' | ')}）`)

	/* ② 变异一：**恢复裸点归并** ⇒ A03 判据必须红 */
	const mutMergeDir = copyLib('mut-merge')
	const stagePath = path.join(mutMergeDir, 'lib', 'unify', 'stage.cjs')
	const cleanStage = readText(stagePath)
	const mergeNeedle = '\t\tbyKey[key] = rec'
	eq(cleanStage.split(mergeNeedle).length, 2, 'A07 · 裸点归并的变异锚点必须唯一（stage.cjs 结构变了就更新锚点）')
	const mutStage = cleanStage.replace(mergeNeedle,
		'\t\t// 变异（A07）：恢复"裸点归并"的旧行为\n'
		+ "\t\tkey = raw.includes('/') ? raw.split('/').pop() : raw\n"
		+ '\t\tbyKey[key] = rec')
	assert(mutStage !== cleanStage, 'A07 · 裸点归并变异必须真的改动源码')
	fs.writeFileSync(stagePath, mutStage, 'utf8')
	const mutMergeMods = await loadAdapters(mutMergeDir)
	const mutCross = await judgeCrossCircle(mutMergeMods, path.join(base, 'mut-cross'))
	assert(mutCross.violations.length > 0, 'A07 · 恢复裸点归并之后，跨圈隔离判据仍然通过 —— A03 是空转的')
	assert(mutCross.violations.some((v) => /A 级|B 级|串了|同一条记录/.test(v.msg)),
		`A07 · 变异体检出项必须点名跨圈串记录（实得 ${mutCross.violations.slice(0, 3).map((v) => v.msg).join(' | ')}）`)

	/* ③ 变异二：**吞 IO 错误**（io-error 折成 empty） ⇒ A01 五态判据必须红 */
	const mutIoDir = copyLib('mut-io')
	const ioStagePath = path.join(mutIoDir, 'lib', 'unify', 'stage.cjs')
	const cleanIoStage = readText(ioStagePath)
	const ioNeedle = "return result && result.status === IO_ERROR_STATUS ? IO_ERROR_STATUS : (result ? result.status : 'missing')"
	eq(cleanIoStage.split(ioNeedle).length, 2, 'A07 · 吞 IO 错误的变异锚点必须唯一')
	fs.writeFileSync(ioStagePath,
		cleanIoStage.replace(ioNeedle, "return result && result.status === IO_ERROR_STATUS ? 'empty' : (result ? result.status : 'missing')"),
		'utf8')
	const mutIoMods = await loadAdapters(mutIoDir)
	const mutFive = await judgeFiveStates(mutIoMods, path.join(base, 'mut-eight'))
	assert(mutFive.violations.length > 0, 'A07 · 吞掉 IO 错误之后五态判据仍然通过 —— A01 是空转的')
	assert(mutFive.violations.some((v) => /io-error|折成/.test(v.msg)),
		`A07 · 变异体检出项必须点名"io-error 被折成空态"（实得 ${mutFive.violations.slice(0, 3).map((v) => v.msg).join(' | ')}）`)

	/* ④ 仓内文件一个字节都没被变异影响 */
	eq(sha256(fs.readFileSync(path.join(REPO, KERNEL))), repoKernelBefore, 'A07 · 仓内权威内核不许被变异影响')
	eq(sha256(fs.readFileSync(path.join(REPO, HOST.goals))), repoGoalsBefore, 'A07 · 仓内适配层不许被变异影响')
	assert(path.resolve(base).startsWith(path.resolve(TEMP_PARENT) + path.sep), 'A07 · 变异副本必须落在 E:\\Temp')

	DETAIL.A07 = {
		mutations: [
			{ id: 'bare-point-merge', marker: 'a07/mut-merge/lib/unify/stage.cjs', clean: { violations: cleanCross.violations.length }, mutated: { violations: mutCross.violations.slice(0, 6) } },
			{ id: 'io-error-swallowed', marker: 'a07/mut-io/lib/unify/stage.cjs', clean: { violations: cleanFive.violations.length }, mutated: { violations: mutFive.violations.slice(0, 6) } },
		],
		repoUntouched: true,
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 证据及范围守卫有效（含 §12 A 授权面本体）
 * ══════════════════════════════════════════════════════════════════════ */

async function A08() {
	const preDoc = pre()

	/* ① 改前材料齐 + 自洽（四个改前文件都在，且与 git HEAD 逐字节相同） */
	for (const p of [PRE_FILE, FIXTURES_FILE, CAPTURE_FILE]) assert(fs.existsSync(p), `A08 · 改前材料缺失：${rel(p)}`)
	eq(preDoc.sources.length, CHANGED_FILES.length, 'A08 · 改前材料应当锁住 4 个现有文件')
	sameJson(preDoc.sources.map((s) => s.path), CHANGED_FILES, 'A08 · 改前材料的文件清单与卡面写集不一致')
	eq(preDoc.capturedFrom.head, gitText(['rev-parse', 'HEAD']).trim(), 'A08 · 改前采集时的 HEAD 必须仍是现在的 HEAD（本卡不做任何 git 写）')
	eq(preDoc.capturedFrom.branch, gitText(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'A08 · 分支必须仍是 refactor/unify-20261018')
	eq(preDoc.capturedFrom.baseline, '2f57b1f2cec02e4128b69497e3b6819d36aa707b', 'A08 · 执行基线必须是 2f57b1f')
	for (const s of preDoc.sources) {
		const head = gitHeadBytes(s.path)
		assert(head !== null, `A08 · git HEAD 里没有 ${s.path}`)
		eq(sha256(head), s.sha256, `A08 · 改前材料的 ${s.path} 必须与 git HEAD 逐字节相同`)
		eq(s.sameAsHead, true, `A08 · 采集时 ${s.path} 必须与 HEAD 相同（改前基线成立的前提）`)
	}

	/* ② 导出面逐键保留（"导出面漂一个就红"） */
	const mods = await loadAdapters()
	for (const key of ['intake', 'goals', 'teaching']) {
		const face = preDoc.exportFace[key]
		const keys = Object.keys(mods[key]).sort()
		sameJson(keys, face.keys, `A08 · ${HOST[key]} 的导出键集合与改前不一致`)
		for (const k of keys) {
			const got = typeof mods[key][k]
			assert(String(face.face[k]).startsWith(got), `A08 · ${HOST[key]} 的 ${k} 类型变了（改前 ${face.face[k]} / 现在 ${got}）`)
		}
	}

	/* ③ 依赖自锚：本次进程开始时 vs 现在 */
	const anchors = verifyAnchors()
	eq(anchors.changed.length, 0,
		`A08 · 本次运行期间依赖文件的字节变了：${anchors.changed.slice(0, 3).map((c) => c.path).join(', ')}（A01–A06 的结论将不再对同一份依赖成立；重跑本卡）`)
	assert(anchors.at.length >= 8, `A08 · 自锚的依赖太少（${anchors.at.length}）`)

	/* ④ 四个既有文件真的被改过 + 委托形态；三个新文件真的建了 */
	const facts = []
	for (const s of preDoc.sources) {
		const now = sha256(fs.readFileSync(path.join(REPO, s.path)))
		assert(now !== s.sha256, `A08 · ${s.path} 与改前字节相同 —— 本卡其实没改它（对拍无意义）`)
		facts.push({ path: s.path, state: 'changed', beforeSha16: s.sha256.slice(0, 16), nowSha16: now.slice(0, 16) })
	}
	for (const p of [HOST.intake, HOST.goals, HOST.teaching]) {
		const src = stripComments(readText(path.join(REPO, p)))
		assert(src.includes("requireCJS('./unify/stage.cjs')"), `A08 · ${p} 里看不到对权威内核的委托（./unify/stage.cjs）`)
		assert(src.includes('STAGE.readStageLedger('), `A08 · ${p} 的读取没有走共同读取基础（STAGE.readStageLedger）`)
		assert(src.includes('STAGE.appendRecord('), `A08 · ${p} 的写入没有走共同提交边界（STAGE.appendRecord）`)
		assert(src.includes('pack-template/tools/ledger-transaction.cjs'), `A08 · ${p} 不再从事务件 require（卡面路径）`)
		assert(!/withPackTransaction\(/.test(src), `A08 · ${p} 里还留着直接的 withPackTransaction( 调用（提交边界没收到 stage）`)
	}
	const kernelSrc = readText(path.join(REPO, KERNEL))
	const kernelNoComments = stripComments(kernelSrc)
	for (const token of ['readLedger(', 'planCommit(', 'applyCommit(', 'identity.pointKey(', 'identity.parsePointKey(', 'mergeCanonical(']) {
		assert(kernelNoComments.includes(token), `A08 · 内核里找不到 ${JSON.stringify(token)} —— 反空转检查失败（下面那条就成了恒真）`)
	}
	assert(!/^export\s/m.test(kernelSrc) && !/^import\s/m.test(kernelSrc), 'A08 · 内核必须是 CJS（不许 ESM 语法）')
	assert(!/migration\.cjs/.test(kernelNoComments), 'A08 · 运行态内核不许 require 迁移模块（历史解码只归 migration.cjs）')
	assert(!/new Date\(|Date\.now\(|Math\.random\(|process\.env/.test(kernelNoComments), 'A08 · 内核不许看时钟 / 用随机数 / 读环境变量')
	for (const p of [KERNEL, 'test/audit/U10.mjs', 'docs/unify/receipts/U10.json']) {
		assert(fs.existsSync(path.join(REPO, p)), `A08 · 新文件不见了：${p}`)
		facts.push({ path: p, state: 'created', nowSha16: sha256(fs.readFileSync(path.join(REPO, p))).slice(0, 16) })
	}

	/* ⑤ §12 A 面：只动身份，**非身份语义断言一条都没动**（逆替换必须逐字节回到 HEAD） */
	const headIntakeTest = gitHeadBytes(A_FACE)
	assert(headIntakeTest !== null, 'A08 · git HEAD 里没有 test/intake.mjs')
	const headTestText = headIntakeTest.toString('utf8')
	const curTestText = readText(path.join(REPO, A_FACE))
	assert(curTestText !== headTestText, 'A08 · test/intake.mjs 与 HEAD 相同 —— A 面其实没升级')
	const inverse = curTestText
		.split("latest['programming/vue']").join('latest.vue')
		.split("'programming/spring-boot/0001'").join("'spring-boot/0001'")
		.split("'programming/vue'").join("'vue'")
	eq(inverse === headTestText, true, 'A08 · A 面只许替换身份：把新身份逆替换回去必须与 HEAD 逐字节相同（否则就是动了别的断言/注释/夹具）')
	const headLines = headTestText.split('\n')
	const curLines = curTestText.split('\n')
	eq(curLines.length, headLines.length, 'A08 · A 面不许增删行')
	const changedLines = []
	for (let i = 0; i < headLines.length; i++) if (headLines[i] !== curLines[i]) changedLines.push(i + 1)
	eq(changedLines.join(','), '71,78,81,86,87,90,267,272', `A08 · A 面只许改这 8 行（实得 ${changedLines.join(',')}）`)
	for (const row of A_FACE_ROWS) {
		assert(curLines[row.line - 1].includes(row.now), `A08 · A 面第 ${row.line} 行没有换成新身份写法（实得 ${curLines[row.line - 1].trim()}）`)
		assert(headLines[row.line - 1] !== curLines[row.line - 1], `A08 · A 面第 ${row.line} 行其实没变`)
	}
	// 非身份语义（版本 / 日期 / 原文 / 键序）在 A 面里必须一条不少
	for (const keep of ["at: '2026-09-21'", "at: '2026-09-22'", "'零基础'", "'有基础'", "'精通'", "'能独立写前端'", 'latest 日期是后一条', 'latest[point] 字段一致', 'latest[point] 是后一条']) {
		assert(curTestText.includes(keep), `A08 · A 面丢了一条非身份语义（${keep}）`)
	}

	/* ⑥ 【判据 1/4】临时目录归属（先做一次受守卫的删除，让写记录里真的出现 rm） */
	{
		const scratch = path.join(RUN_TEMP, 'guard-scratch')
		fs.mkdirSync(scratch, { recursive: true })
		fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
		const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
		eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
		eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')
	}
	eq(guardTempPath(RUN_TEMP, { parent: TEMP_PARENT }).ok, true, 'A08 · 本次临时根必须归 E:\\Temp')
	assert(/^u10-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u10-<pid>-<rand>（本次唯一）')
	eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
	eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
	eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')

	/* ⑦ 【判据 1/4】进程内 fs 写守卫 */
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

	/* ⑧ 【判据 2/4】授权写集并集 = §6 ∪ §12 A（两处都**现场解析**，不硬编码） */
	const lockText = readText(path.join(REPO, 'docs/unify/interfaces.md'))
	const s6 = parseSection6(lockText)
	eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
	sameJson([...s6.get(CARD)], STAGE_SET, 'A08 · §6 里 U10 的落点必须逐条等于本卡的 7 项（逐条 + 顺序；A 面那一项必须在其中）')
	const qProof = proveSection6Qualifier(lockText, CARD)
	eq(qProof.failures.length, 0, `A08 · §6 里 A 面的标注不合规：${qProof.failures.join('；')}`)
	// 反空转：把限定语「抹掉」或「挪到别的落点上」，这条断言都必须红（否则它只是个恒真的装饰）
	const qualifierMutations = (() => {
		assert(qProof.row !== null && qProof.row.includes(A_FACE_QUALIFIER), 'A08 · §6 的 U10 行里找不到「仅 §12 A 授权面」这句原文（断言将无从变异）')
		const stripQ = lockText.replace(qProof.row, qProof.row.replace(A_FACE_QUALIFIER, ''))
		const movedQ = lockText.replace(qProof.row, qProof.row.replace(`\`${HOST.intake}\``, `\`${HOST.intake}\`（${A_FACE_QUALIFIER}）`))
		eq(stripQ !== lockText, true, 'A08 · 反空转变异没生效（限定语没被抹掉）')
		eq(movedQ !== lockText, true, 'A08 · 反空转变异没生效（限定语没被挪到 lib/intake.js 上）')
		const stripped = proveSection6Qualifier(stripQ, CARD).failures
		const moved = proveSection6Qualifier(movedQ, CARD).failures
		assert(stripped.some((f) => f.includes(A_FACE_QUALIFIER)), `A08 · 抹掉 §6 的「${A_FACE_QUALIFIER}」后新断言没红（实得 ${JSON.stringify(stripped)}）`)
		assert(moved.some((f) => f.includes(HOST.intake)), `A08 · 把限定语挪到 ${HOST.intake} 上后新断言没红（标注就成了装饰）`)
		return { stripped, moved }
	})()
	const authDoc = JSON.parse(readText(path.join(REPO, 'docs/unify/authorization.json')))
	eq(authDoc.quoteVerbatim, '选A和授权p1和p2', 'A08 · 人类授权的原文必须就是这句（逐字）')
	// A 面的权威链：人类原文（authorization.json）在，§6 只是落地台账；原文缺失 / scope.A 没点名 → 必须红
	const aAuth = proveAfaceAuthority(authDoc)
	eq(aAuth.failures.length, 0, `A08 · A 面的权威链不成立：${aAuth.failures.join('；')}`)
	const authMutations = (() => {
		const noQuote = { ...authDoc, quoteVerbatim: '' }
		const noSource = { ...authDoc, quoteSource: '' }
		const scopeA = (authDoc.scope && authDoc.scope.A) || {}
		const dropped = (scopeA.authorized || []).filter((l) => !(/\bU10\b/.test(String(l)) && String(l).includes(A_FACE)))
		const noScope = { ...authDoc, scope: { ...authDoc.scope, A: { ...scopeA, authorized: dropped } } }
		const bare = { ...authDoc, quoteVerbatim: '', quoteSource: '' }
		const r = {
			noQuote: proveAfaceAuthority(noQuote).failures,
			noSource: proveAfaceAuthority(noSource).failures,
			noScopeLine: proveAfaceAuthority(noScope).failures,
			ledgerOnly: proveAfaceAuthority(bare).failures,
		}
		assert(r.noQuote.some((f) => f.includes('quoteVerbatim')), 'A08 · 抽掉 quoteVerbatim 后 A 面权威链必须红（不许静默放行）')
		assert(r.noSource.some((f) => f.includes('quoteSource')), 'A08 · 抽掉 quoteSource 后 A 面权威链必须红')
		assert(r.noScopeLine.some((f) => f.includes('scope.A')), 'A08 · 抽掉 scope.A 里点名 U10 的那条后 A 面权威链必须红')
		assert(r.ledgerOnly.length >= 2, `A08 · 只有 §6 标注、没有授权原文时至少两条同时红（实得 ${JSON.stringify(r.ledgerOnly)}）`)
		return r
	})()
	const auth = authorizationExtras(authDoc)
	assert(auth.extras.has('U10') && auth.extras.get('U10').includes(A_FACE), 'A08 · authorization.json 里找不到"U10 独占 test/intake.mjs"这条授权')
	assert(auth.extras.has('U09') && auth.extras.get('U09').includes('test/mirror-parity.mjs'), 'A08 · authorization.json 里找不到"U09 独占 test/mirror-parity.mjs"这条授权')
	assert(auth.extras.get('U09').includes('lib/point-ref.js'), 'A08 · C4 追加给 U09 的 lib/point-ref.js 没解析出来')
	const union = authorizedUnion(s6, auth.extras)
	const owners = pathOwners(s6, auth.extras)
	const porcelain = gitText(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter((l) => l.trim())
	const { tracked, untracked } = splitPorcelainTracked(porcelain)
	const scopeCheck = classifyTrackedWrites(tracked, union)
	eq(scopeCheck.outOfBounds.length, 0,
		`A08 · tracked 改动越出授权并集（§6 ∪ §12 A）：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
	for (const f of CHANGED_FILES) assert(tracked.some((t) => t.path === f), `A08 · tracked 改动里找不到本卡改过的 ${f}`)
	const sProof = proveScopeBoundary(s6, auth.extras)
	eq(sProof.failures.length, 0, `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

	/* ⑨ 【判据 3/4】交付物内容锁 */
	const lock = recordContentLock()
	eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
	const lockNow = verifyContentLock()
	eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)

	/* ⑩ 【判据 4/4】**不统计他卡的文件数/字节数**：只做归属守卫 */
	const evDirs = fs.readdirSync(path.join(REPO, 'audit-evidence')).sort()
	// 第一层只允许：U 卡编号目录 + 既有 T23 + **真实存在的 T 卡**（`test/audit/T<NN>.mjs` 在盘上：
	// 决-1/决-5/决-6/决-9/P2 之后 T 卡由别的卡合法运行）。**不是**"T 一律放行"。
	const isRealT = (d) => /^T\d{2}$/.test(d) && fs.existsSync(path.join(REPO, 'test', 'audit', `${d}.mjs`))
	const unexpectedOf = (list) => list.filter((d) => !/^U\d{2}$/.test(d) && d !== 'T23' && !isRealT(d))
	const evUnexpected = unexpectedOf(evDirs)
	eq(evUnexpected.length, 0, `A08 · audit-evidence 第一层出现了无人认领的证据目录：${evUnexpected.join(', ')}`)
	// 反空转：既不在册、也没有对应 T 卡入口的名字必须被这条判据抓住。
	sameJson(unexpectedOf(['U01', 'T23', 'T01', 'TXX-nobody']), ['TXX-nobody'],
		'A08 · 反空转：无人认领的证据目录必须被判出来（真实存在的 T 卡放行，别的仍红）')
	for (const d of ['U01', 'T23']) assert(evDirs.includes(d), `A08 · 既有证据目录不见了：${d}`)

	/* ⑪ `--evidence-root` 守卫 + 读取根恒定 */
	const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
	eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
	eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U10/runs/U10-<pid>')
	eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true, 'A08 · E:\\Temp 下带 U10- 前缀的新目录必须被接受')
	eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
	eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
	eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')
	eq(path.dirname(PRE_FILE), EVIDENCE_ROOT_READ, 'A08 · 读取根必须恒为 <repo>/audit-evidence/U10')

	/* ⑫ 【A 授权面本体】旧形状拒绝 / 跨圈歧义拒绝 / U05 真迁移后回读 + 追加 */
	const base = path.join(RUN_TEMP, 'a08')
	fs.mkdirSync(base, { recursive: true })
	const kernelMod = kernel()
	const strictPack = makePack('a08-strict', [{ id: 'a', points: ['x', 'vue'] }, { id: 'b', points: ['x'] }])
	const readPackMod = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-model.js')).href)
	const packObj = readPackMod.readPack(strictPack)
	const cat = kernelMod.buildCatalogue(packObj.points)
	eq(cat.keys.length, 3, `A08 · 目录应有 3 个知识点（实得 ${cat.keys.length}）`)
	const TXN = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs'))
	const countingTxn = () => ({ calls: 0, withPackTransaction(r, b, o) { this.calls += 1; return TXN.withPackTransaction(r, b, o) } })

	// ① 旧形状（裸点）拒绝：严格面在任何事务之前就拒，台账一个字节不动
	{
		const root = path.join(base, 'reject')
		fs.mkdirSync(root, { recursive: true })
		const bare = kernelMod.classifyPoint('vue', { catalogue: cat })
		eq(bare.ok, false, 'A08 · 严格面必须拒绝旧形状裸点')
		eq(bare.code, 'MIGRATION_REQUIRED', `A08 · 裸点的拒绝码应为 MIGRATION_REQUIRED（实得 ${bare.code}）`)
		assert(/migrate-pack/.test(bare.error), 'A08 · 拒绝理由必须点名修法（显式迁移 CLI）')
		const seg3 = kernelMod.classifyPoint('a/vue/0001', { catalogue: cat })
		eq(seg3.ok, false, 'A08 · 三段课次键不许当知识点身份')
		eq(seg3.code, 'LEDGER_INVALID', `A08 · 非法形状应为 LEDGER_INVALID（实得 ${seg3.code}）`)
		const okPoint = kernelMod.classifyPoint('a/vue', { catalogue: cat })
		eq(okPoint.ok, true, 'A08 · 规范身份必须被接受')
		eq(okPoint.key, 'a/vue', 'A08 · 规范身份的键就是它自己')
		const ledger = path.join(root, ...LEDGER_REL.intake.split('/'))
		fs.mkdirSync(path.dirname(ledger), { recursive: true })
		fs.writeFileSync(ledger, `${JSON.stringify(intakeRecord('vue'))}\n${JSON.stringify(intakeRecord('a/vue'))}\n`, 'utf8')
		const strictRead = kernelMod.readStageLedger('intake', root, { capture: true })
		const ver = kernelMod.verifyIdentities(strictRead.entries, { field: 'point', catalogue: cat })
		eq(ver.ok, false, 'A08 · 严格身份核验必须拒绝裸点台账')
		eq(ver.status, 'migration-required', `A08 · 严格身份状态应为 migration-required（实得 ${ver.status}）`)
		sameJson(ver.keys, ['a/vue'], 'A08 · 严格面只接受规范身份那一条')
		const probe = countingTxn()
		const before = readText(ledger)
		const refused = kernelMod.appendRecord('intake', root, () => ({ content: 'x\n' }), {
			transaction: probe, ensureParent: true, strictIdentity: true, identity: 'vue', catalogue: cat,
		})
		eq(refused.ok, false, 'A08 · 严格面写裸点必须被拒')
		eq(refused.code, 'MIGRATION_REQUIRED', `A08 · 严格面写裸点的码应为 MIGRATION_REQUIRED（实得 ${refused.code}）`)
		eq(probe.calls, 0, 'A08 · 严格面的拒绝必须在碰事务之前')
		eq(readText(ledger), before, 'A08 · 被拒的严格写入一个字节都不许动')
	}

	// ② 跨圈歧义拒绝：裸 x 在两圈都有 → ID_AMBIGUOUS + 候选；给 halo 才解
	{
		const amb = kernelMod.classifyPoint('x', { catalogue: cat })
		eq(amb.ok, false, 'A08 · 跨圈同名裸点必须被拒（不许按第一个猜）')
		eq(amb.code, 'ID_AMBIGUOUS', `A08 · 歧义的码应为 ID_AMBIGUOUS（实得 ${amb.code}）`)
		sameJson(amb.candidates, ['a/x', 'b/x'], 'A08 · 歧义拒绝必须列出两个候选')
		const halo = kernelMod.classifyPoint('x', { catalogue: cat, halo: 'b' })
		eq(halo.ok, true, 'A08 · 给了圆圈就必须解得出来（不是死锁）')
		eq(halo.key, 'b/x', 'A08 · halo=b → b/x')
	}

	// ③ U05 真迁移：真 CLI（plan → apply），迁完可读可追加、版本链不合并、日期/原文逐字保留
	{
		const root = makePack('a08-migrate', [{ id: 'programming', points: ['vue', 'react'] }])
		// 归属依据是 lessons/ 里的**课程页**（U05 的 index 按目录结构判归属；只有 point.json 不算"有课"）
		for (const p of ['vue', 'react']) {
			const page = path.join(root, 'lessons', 'programming', p, `0001-${p}-start.html`)
			fs.mkdirSync(path.dirname(page), { recursive: true })
			fs.writeFileSync(page, '<!doctype html><title>fixture</title>\n', 'utf8')
		}
		const intakeOld = [
			JSON.stringify(intakeRecord('vue', '有基础', '能改页面', '2026-10-01')),
			JSON.stringify(intakeRecord('react', '零基础', '能写组件', '2026-10-02')),
		].join('\n') + '\n'
		const goalsOld = [
			JSON.stringify(goalRecord('vue', 1, { what: '原文 A' })),
			JSON.stringify(goalRecord('react', 1, { what: '原文 B' })),
		].join('\n') + '\n'
		const intakeFile = path.join(root, ...LEDGER_REL.intake.split('/'))
		const goalsFile = path.join(root, ...LEDGER_REL.goals.split('/'))
		fs.mkdirSync(path.dirname(intakeFile), { recursive: true })
		fs.writeFileSync(intakeFile, intakeOld, 'utf8')
		fs.writeFileSync(goalsFile, goalsOld, 'utf8')

		const migCat = kernelMod.buildCatalogue(readPackMod.readPack(root).points)
		const beforeVer = kernelMod.verifyIdentities(
			kernelMod.readStageLedger('intake', root, { capture: true }).entries, { field: 'point', catalogue: migCat })
		eq(beforeVer.ok, false, 'A08 · 迁移前：严格身份面必须判它是旧形状')
		eq(beforeVer.status, 'migration-required', 'A08 · 迁移前的严格状态应是 migration-required')

		const planRun = runCli([path.join(REPO, 'tools', 'migrate-pack.mjs'), `--root=${root}`, '--plan'])
		eq(planRun.status, 0, `A08 · U05 的 --plan 必须 exit 0（stdout=${planRun.stdout.trim()} stderr=${planRun.stderr.trim()}）`)
		const m = /^PLAN ok=true digest=([0-9a-f]{64}) files=\d+ changes=(\d+) blocks=0$/m.exec(planRun.stdout.trim())
		assert(m, `A08 · --plan 的输出不符合契约（实得 ${JSON.stringify(planRun.stdout.trim())}）`)
		assert(Number(m[2]) >= 4, `A08 · 计划至少要改 4 处身份（实得 ${m[2]}）`)
		eq(readText(intakeFile), intakeOld, 'A08 · --plan 必须零写（台账逐字节未变）')
		eq(readText(goalsFile), goalsOld, 'A08 · --plan 必须零写（目标台账逐字节未变）')

		const applyRun = runCli([path.join(REPO, 'tools', 'migrate-pack.mjs'), `--root=${root}`, '--apply', '--confirm', `--plan-digest=${m[1]}`])
		eq(applyRun.status, 0, `A08 · U05 的 --apply 必须 exit 0（stdout=${applyRun.stdout.trim()} stderr=${applyRun.stderr.trim()}）`)
		assert(/^APPLY ok=true digest=[0-9a-f]{64} replaced=\d+ backup=\S+$/m.test(applyRun.stdout.trim()),
			`A08 · --apply 的输出不符合契约（实得 ${JSON.stringify(applyRun.stdout.trim())}）`)

		// 迁移只改身份字面量：逆替换必须逐字回到迁移前（日期 / 原文 / 顺序全部保留）
		const intakeAfter = readText(intakeFile)
		const goalsAfter = readText(goalsFile)
		const invIntake = intakeAfter.split('"point":"programming/vue"').join('"point":"vue"').split('"point":"programming/react"').join('"point":"react"')
		const invGoals = goalsAfter.split('"point":"programming/vue"').join('"point":"vue"').split('"point":"programming/react"').join('"point":"react"')
		eq(invIntake, intakeOld, 'A08 · 迁移只许改身份：摸底台账逆替换回去必须与迁移前逐字节相同（日期/词句/顺序全保留）')
		eq(invGoals, goalsOld, 'A08 · 迁移只许改身份：目标台账逆替换回去必须与迁移前逐字节相同')

		// 迁移后：本模块可读
		const read = mods.intake.readIntake(root)
		eq(read.status, 'ok', `A08 · 迁移后摸底台账必须是 ok（实得 ${read.status}）`)
		sameJson(Object.keys(read.latest).sort(), ['programming/react', 'programming/vue'], 'A08 · 迁移后 latest 的键必须是规范身份')
		eq(read.latest['programming/vue'].level, '有基础', 'A08 · 迁移后 level 逐字保留')
		eq(read.latest['programming/vue'].at, '2026-10-01', 'A08 · 迁移后日期逐字保留')
		eq(mods.intake.intakeStatus(root, 'programming/vue').done, true, 'A08 · 迁移后 intakeStatus 认得出（done=true）')
		eq(mods.intake.intakeStatus(root, 'vue').done, true, 'A08 · 裸 id 照旧能查（既有解析不变）')
		const afterVer = kernelMod.verifyIdentities(
			kernelMod.readStageLedger('intake', root, { capture: true }).entries, { field: 'point', catalogue: migCat })
		eq(afterVer.ok, true, 'A08 · 迁移后严格身份面必须通过')

		// 迁移后：本模块可追加；版本链**不合并**（两点各自一条线）
		const appended = mods.intake.recordIntake(root, intakeRecord('programming/vue', '有基础', '能改页面 2', '2026-10-05'))
		eq(appended.ok, true, `A08 · 迁移后摸底可追加（${appended.error || ''}）`)
		eq(ledgerLines(root, 'intake').length, 3, 'A08 · 追加后摸底台账 3 行')
		const gv = mods.goals.recordGoal(root, goalRecord('programming/vue', 2, { replaces: 1, what: '原文 A 第 2 版' }))
		eq(gv.ok, true, `A08 · 迁移后目标可追加（${gv.error || ''}）`)
		eq(gv.record.v, 2, 'A08 · programming/vue 的下一版是 v2')
		eq(gv.record.replaces, 1, 'A08 · replaces 指向自己那条链的 v1')
		const gr = mods.goals.recordGoal(root, goalRecord('programming/react', 2, { replaces: 1, what: '原文 B 第 2 版' }))
		eq(gr.ok, true, `A08 · 另一条点也追加上（${gr.error || ''}）`)
		eq(gr.record.v, 2, 'A08 · programming/react 的下一版也是 v2（**版本链没有合并**）')
		const gRead = mods.goals.readGoals(root)
		eq(gRead.latest['programming/vue'].v, 2, 'A08 · vue 链现行 v2')
		eq(gRead.latest['programming/react'].v, 2, 'A08 · react 链现行 v2')
		eq(gRead.latest['programming/vue'].artifact.what, '原文 A 第 2 版', 'A08 · vue 链的内容是本链自己的')
		eq(gRead.latest['programming/react'].artifact.what, '原文 B 第 2 版', 'A08 · react 链的内容是本链自己的')
		DETAIL.A08Migration = {
			plan: planRun.stdout.trim(), apply: applyRun.stdout.trim(),
			changes: Number(m[2]), intakeAfter: ledgerLines(root, 'intake').length,
			chains: { vue: gRead.latest['programming/vue'].v, react: gRead.latest['programming/react'].v },
		}
	}

	/* ⑬ tracked 回执：五项齐 + 授权逐字引用 + 真实写集 / Δ / 未验证边界对得上 */
	const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
	assert(fs.existsSync(rcPath), `A08 · 缺 tracked 回执 docs/unify/receipts/${CARD}.json`)
	let rc = null
	try { rc = require_(rcPath) } catch (e) { throw new Error(`A08 · 回执不是合法 JSON（require 失败）：${e.message}`) }
	eq(rc.card, CARD, 'A08 · 回执 card 不对')
	eq(rc.status, 'PASS', 'A08 · 回执 status 必须是 PASS（判词以本入口为准）')
	for (const key of ['completion', 'verdict', 'dependencies', 'interfaceConsumption', 'writeSet', 'writeOutOfSet', 'deltas', 'assertions', 'unverified', 'evidenceIndex', 'authorization', 'blockedHistory']) {
		assert(key in rc, `A08 · 回执缺字段 ${key}`)
	}
	sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
	assert(/无/.test(JSON.stringify(rc.writeOutOfSet)), 'A08 · 回执必须写清越界项（无也写明）')
	// authorization：逐字引用人类授权 + 来源 + "本卡只按 scope.A 执行"
	eq(rc.authorization.quoteVerbatim, authDoc.quoteVerbatim, 'A08 · 回执必须逐字引用 quoteVerbatim')
	eq(rc.authorization.quoteSource, authDoc.quoteSource, 'A08 · 回执必须逐字引用 quoteSource')
	assert(String(rc.authorization.statement).includes('本卡只按 scope.A 执行'), 'A08 · 回执必须写明「本卡只按 scope.A 执行」')
	assert(String(rc.authorization.scope).includes('test/intake.mjs'), 'A08 · 回执的授权面必须点名 test/intake.mjs')
	assert(rc.blockedHistory && rc.blockedHistory.priorStatus === 'BLOCKED' && rc.blockedHistory.releasedBy === authDoc.quoteVerbatim,
		'A08 · 回执必须保留"曾 BLOCKED、现由人类 A 授权解除"的追溯（releasedBy 逐字引用授权）')
	for (const id of ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08']) {
		assert(rc.assertions && rc.assertions[id], `A08 · 回执必须逐项写清 ${id} 的断言内容`)
	}
	assert(rc.deltas.length >= 4, `A08 · 回执必须逐条登记真实 Δ（实得 ${rc.deltas.length} 条）`)
	const kinds = new Set(rc.deltas.map((d) => d && d.kind))
	for (const k of ['identity-migration', 'behavior-tightening', 'additive-fields']) {
		assert(kinds.has(k), `A08 · 回执的 Δ 里缺 ${k} 这一类`)
	}
	assert(rc.unverified.some((u) => /U19/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记"仓内随包闭包待 U19"')
	assert(rc.unverified.some((u) => /U17/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记"迁移后产品全链路读回归 U17"')
	assert(rc.unverified.some((u) => /T10/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 T10-source-wired 的旧断言冲突')
	assert(rc.unverified.some((u) => /R1/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 R1（包侧 unify 副本）')
	for (const dep of ['U02', 'U03', 'U05', 'U06']) {
		assert(rc.dependencies && rc.dependencies.status && rc.dependencies.status[dep], `A08 · 回执的依赖摘要里缺 ${dep}`)
	}

	DETAIL.comparisons = {
		anchors: anchors.at,
		writeSetFacts: facts,
		writeGuard: {
			installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount, ops: guard.ops,
			probe: guard.probe, violations: guard.violations, proof: wProof.rows,
		},
		authorizedUnion: {
			cards: s6.size, paths: union.size,
			authorization: auth.citations,
			section6Row: {
				row: qProof.row,
				segments: qProof.segments.map((s) => ({ path: s.path, star: s.star, faceQualifier: s.faceQualifier })),
				qualifier: A_FACE_QUALIFIER,
				mutations: qualifierMutations,
			},
			afaceAuthority: {
				quoteVerbatim: aAuth.quoteVerbatim, quoteSource: aAuth.quoteSource,
				named: aAuth.named, mutations: authMutations,
			},
			trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) || [] })),
			untrackedCount: untracked.length,
			outOfBounds: scopeCheck.outOfBounds,
			proof: sProof.rows,
		},
		contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
		evidenceTopLevel: evDirs,
		receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length },
		aFace: { changedLines, bytes: Buffer.byteLength(curTestText) },
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
	{ id: 'A02', run: A02, timeoutMs: 120000 },
	{ id: 'A03', run: A03, timeoutMs: 180000 },
	{ id: 'A04', run: A04, timeoutMs: 120000 },
	{ id: 'A05', run: A05, timeoutMs: 180000 },
	{ id: 'A06', run: A06, timeoutMs: 240000 },
	{ id: 'A07', run: A07, timeoutMs: 300000 },
	{ id: 'A08', run: A08, timeoutMs: 300000 },
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
		...v,
		status: 'FAIL',
		code: 1,
		cases,
		failed,
		passed,
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
		DETAIL.entry = { file: rel(SELF), dir: HERE }
		DETAIL.argv = ARGV
		DETAIL.verdict = { line: verdict.line, code: verdict.code, ms: verdict.ms }
		DETAIL.cases = Object.fromEntries(verdict.cases.map((c) => [c.id, { status: c.actual, note: c.note, ms: c.ms }]))
		DETAIL.baseline = { file: rel(PRE_FILE), bytes: fs.statSync(PRE_FILE).size, sha256: sha256(fs.readFileSync(PRE_FILE)) }
		fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
	}
	process.exitCode = printVerdict(verdict)
}
