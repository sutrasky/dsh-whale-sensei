/**
 * test/audit/U14.mjs —— 答疑 / 笔记 / 调整记录的统一专项判据（B lane · U14）
 * ======================================================================
 * 判的是这一件事：**四类记录（答疑队列 / 笔记台账 / 课后调整台账 / 已答台账）共用一份记录构建，
 * 记录与序号在同一个提交计划里一起落位，课程身份与页面锚点严格分开**，而既有的键序、
 * 学生原文、日期语义（T27）、归档生命周期与返回形状**一个字节都没变**。
 *
 *   A01 记录和序号一起提交 —— ask / note 两个写入路径的计划里**同时**含台账与 seq 两个落点，
 *       每次追加恰好进一次事务；连写两次得到 0001/0002；单文件路径（answer / adjust）仍走同一协议。
 *   A02 第二个文件写入失败不留下半提交 —— 在**第二个落位**注入 rename 失败（第一个已落位）：
 *       事务 `rolled-back`，两件都逐字节回到写前，注入确实生效，暂存残骸/日志/锁都收干净。
 *   A03 读取故障不当空队列或空台账 —— 四类台账 × 五态逐类实跑；序号文件读不动时**拒绝写入**
 *       （不是从 0001 重新发号）；宿主读端（adjust-io）把读取故障报进 problems。
 *   A04 课程身份与页面锚点不混淆 —— `q0001` 只能当页面锚点；当课程键一律拒；
 *       规范 `circle/point/NNNN` 原样通过；跨圈歧义拒 `ID_AMBIGUOUS` 并列候选；`未归课` 哨兵保留。
 *   A05 归档只处理确实已答记录 —— 只搬"台账里有这条且 status==='answered'"的行；其余原样留下；
 *       搬走的行逐字节等于队列原文；没有可归档的行时零写；并与 HEAD 版旧实现逐字节对拍。
 *   A06 拒绝损坏账本上的后续普通写入 —— 坏 JSONL / 读不动（目录）/ 待恢复日志三种坏账本，
 *       普通写入一律在**碰任何事务之前**拒（事务调用次数 = 0），台账字节不动。
 *   A07 变异有效性（只在 E:\Temp 副本）—— ① 归档口径放宽 ⇒ A05 必须红；② 绕过事务两段直接写 ⇒
 *       A01/A02 必须红；干净副本必须绿；仓内零影响。
 *   A08 证据及范围守卫有效 —— 写守卫（探针自证）+ 依赖自锚 + 授权写集并集 + 内容锁 +
 *       `--evidence-root` 守卫 + 临时目录归属清理 + tracked 回执五项；A 授权面本体（旧形状拒绝、
 *       跨圈歧义拒绝、U05 真 CLI 迁移后回读/追加）+ 「未改 test/mirror-parity.mjs」的机器证明。
 *
 * 判词**只有一行**（unify-runner.printVerdict）：
 *   `PASS U14 checks=8 failed=0 skipped=0` → exit 0 ／ `FAIL U14 …` → 1 ／ `BLOCKED U14 …` → 2
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
  runCard,
  FIXED_IDS,
  Blocked,
  printVerdict,
  writeRunEvidence,
  resolveEvidenceRoot,
  safeRemoveTree,
  guardTempPath,
} from './unify-runner.mjs'

const CARD = 'U14'
const SELF = fileURLToPath(import.meta.url)
const HERE = path.dirname(SELF)
const REPO = path.resolve(HERE, '..', '..')
const ARGV = process.argv.slice(2)
const require_ = createRequire(import.meta.url)

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

/* ══════════════════════════════════════════════════════════════════════
 * 落点与写集
 * ══════════════════════════════════════════════════════════════════════ */

/** 权威内核（四类记录的唯一构建 + 共同提交 + 归档判定） */
const KERNEL = 'lib/unify/records.cjs'

/** 四个宿主适配层 + 包侧归档脚本（导出面 / 参数 / 默认值 / 返回形状逐字保留） */
const HOST = Object.freeze({
  ask: 'lib/ask.js',
  askIo: 'lib/ask-io.js',
  notesIo: 'lib/notes-io.js',
  adjustIo: 'lib/adjust-io.js',
  drain: 'lib/pack-template/tools/drain-questions.js',
})

/** §12 A 面里**唯一归 U09** 的那一行所在文件（本卡**不得**改它） */
const U09_A_FACE = 'test/mirror-parity.mjs'

/** interfaces.md §6 里 U14 的落点（= 卡面写集里不是证据目录的那 8 项） */
const SECTION6_SET = Object.freeze([
  KERNEL,
  HOST.ask,
  HOST.askIo,
  HOST.notesIo,
  HOST.adjustIo,
  HOST.drain,
  'test/audit/U14.mjs',
  'docs/unify/receipts/U14.json',
])

/** 卡面精确写集：§6 的 8 项（证据目录按目录前缀放行，见 writeAllowScope） */
const WRITE_SET = Object.freeze([...SECTION6_SET])

/** 改前就存在、本卡改过的五个文件（其余三个是被新建的） */
const CHANGED_FILES = Object.freeze([HOST.ask, HOST.askIo, HOST.notesIo, HOST.adjustIo, HOST.drain])

/**
 * 运行期**自锚**的依赖：本卡结论依赖它们。本次进程开始时记 sha256，收口前再比一次必须相同。
 * 其中 `test/mirror-parity.mjs` 是**反向锚**：它必须在本进程运行期间一个字节都没变
 * （§12 A 授权把它唯一给了 U09，本卡不得改）。
 */
const ANCHOR_FILES = Object.freeze([
  'lib/unify/identity.cjs',
  'lib/unify/errors.cjs',
  'lib/unify/ledger-read.cjs',
  'lib/unify/commit.cjs',
  'lib/pack-template/tools/ledger-transaction.cjs',
  'tools/migrate-pack.mjs',
  'lib/unify/migration.cjs',
  'lib/pack-model.js',
  'test/audit/unify-runner.mjs',
  'docs/unify/interfaces.md',
  'docs/unify/authorization.json',
  KERNEL,
  U09_A_FACE,
])

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { temp: RUN_TEMP }

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')
const readOrNull = (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function fmt(v) {
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`)
}
function sameJson(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg}（期望 ${b}，实得 ${a}）`)
}

/** 剥注释（源码层判据用；注释里的字样不算"实现"） */
export function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 固定基线提交里的某个文件字节（只读；对拍与"未改"证明用） */
function gitHeadBytes(relPath) {
  const r = spawnSync('git', ['-C', REPO, 'show', `HEAD:${relPath}`], { encoding: 'buffer', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  return r.stdout
}

/** 跑一个 CLI（数组参数，不依赖 shell 续行） */
function runCli(argv, { cwd = REPO, timeoutMs = 120000 } = {}) {
  const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: timeoutMs })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal || null }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U02/U10 同一套纪律；本文件独立实现）
 * ──────────────────────────────────────────────────────────────────────
 * 「一个工作树、多 lane 并发」下，拿"改前整树 ↔ 现在的树"做全量对拍会**结构性假红**。
 * 所以判据换成四条可归因口径：
 *   ① 进程内 fs 写守卫 —— 本卡**本次进程**的每一次写都必须落在
 *      { 写集 8 项 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 }，并用**探针写**自证；
 *   ② 授权写集并集（tracked 侧）—— tracked 改动必须 ⊆ §6 ∪ §12 A 授权面；
 *   ③ 本卡交付物内容锁 —— 8 个文件记录的 sha256 在本次运行结束时必须仍等于实际值；
 *   ④ **不统计他卡的文件数/字节数**。
 * ══════════════════════════════════════════════════════════════════════ */

const IS_MAIN = (() => {
  const arg = process.argv[1]
  if (!arg) return false
  try { return pathToFileURL(path.resolve(arg)).href === pathToFileURL(SELF).href } catch { return false }
})()

/** 写入根（越界即 BLOCKED，一个字节都不写） */
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

/** 本卡本次的写允许面：写集 8 项的精确绝对路径 + { 本次临时根, 本卡证据根 } 两个目录前缀 */
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
  if (s.files.has(abs)) return { allowed: true, why: '本卡写集 8 项之一', abs }
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

/**
 * **§12 A 授权面**（纯函数，直接从 `authorization.json` 的原文解析，不硬编码）：
 *   · `scope.A.authorized` 里同一句同时出现 `<U 卡号>` 与仓库路径的，算那张卡的授权落点；
 *   · `derivedConsequences.items[]` 里 id 为 C4 的条目（`lib/point-ref.js` 归 U09）。
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
  /**
   * 逐**分句**解析（不能按"整行第一个卡号"归因）：同一行里既有"U14 不修改 test/mirror-parity.mjs"，
   * 也有"…只写入 test/audit/U14.mjs"。按整行归因会把 U09 的 A 面错记成 U14 的授权 ——
   * 那正是本卡最不能出的错。所以：
   *   · 先按 `；`/`;` 切分句；
   *   · 含否定词（不修改 / 不动 / 不得 / 不写 / 不改）的分句**不算授权**；
   *   · 每个分句内，路径记给**该分句里出现的**卡号（没有卡号但路径里带 Uxx 时，记给路径自己点名的卡）。
   */
  const NEGATIVE = /不修改|不要修改|不动|不得|不写|不改|不扩/
  for (const line of (authDoc && authDoc.scope && authDoc.scope.A && authDoc.scope.A.authorized) || []) {
    for (const clause of String(line).split(/[；;]/)) {
      const text = clause.trim()
      if (!text || NEGATIVE.test(text)) continue
      const cards = [...text.matchAll(/\b(U\d\d)\b/g)].map((m) => m[1])
      if (!cards.length) continue
      for (const m of text.matchAll(/`?([A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]+)`?/g)) {
        const p = m[1]
        if (!looksLikeRepoPath(p)) continue
        if (!/^(?:lib|test|docs|tools)\//.test(p)) continue
        // 路径自己点名的卡（`test/audit/U14.mjs` → U14）优先；否则记给分句里出现的卡
        const own = /(?:^|\/)(U\d\d)\./i.exec(p)
        const card = own ? own[1].toUpperCase() : cards[0]
        add(card, p, 'authorization.scope.A.authorized')
      }
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
 * 关键两条：① `test/mirror-parity.mjs` **只有**靠 §12 A 给 U09 的那条授权才被放行
 * （抽掉 extras 必须红），而且它**不在**本卡写集里；② 本卡落点只靠 §6 就放行。
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
  one(' M lib/unify/records.cjs', 'allow', '本卡（U14）写集')
  one(' M lib/ask.js', 'allow', '本卡（U14）写集')
  one(' M lib/ask-io.js', 'allow', '本卡（U14）写集')
  one(' M lib/notes-io.js', 'allow', '本卡（U14）写集')
  one(' M lib/adjust-io.js', 'allow', '本卡（U14）写集')
  one(' M lib/pack-template/tools/drain-questions.js', 'allow', '本卡（U14）写集')
  one(' M docs/unify/receipts/U14.json', 'allow', '本卡（U14）写集')
  one(' M test/mirror-parity.mjs', 'allow', '§12 A 授权给 **U09**（并发 lane）')
  one(' M test/intake.mjs', 'allow', '§12 A 授权给 U10（并发 lane）')
  one(' M lib/point-ref.js', 'allow', 'authorization C4 追加给 U09（并发 lane）')
  one(' M lib/render.js', 'allow', 'U07 写集（并发）')
  one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
  one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
  one(' D test/all.mjs', 'reject', '既有总入口被删')
  one('A  cards/U14.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
  one(' M audit-evidence/U14/pre.json', 'reject', '证据目录不被 §6 授权（它是 gitignore 的原始证据）')
  // 抽掉 extras 的对照：喂一条**只在 extras 里**的路径，union 放行 / bareUnion 拒绝
  {
    const onlyExtras = new Map([['U14', ['lib/only-in-authorization.js']]])
    const withExtras = authorizedUnion(sets, onlyExtras)
    const without = authorizedUnion(sets)
    const row = (u) => classifyTrackedWrites(splitPorcelainTracked([' M lib/only-in-authorization.js']).tracked, u).outOfBounds.length
    rows.push({
      line: ' M lib/only-in-authorization.js', expect: 'allow', got: row(withExtras) === 0 ? 'allow' : 'reject',
      ok: row(withExtras) === 0 && row(without) === 1, why: '授权面真的在起作用（抽掉 extras 必须红）',
    })
  }
  {
    const mixed = classifyTrackedWrites(
      splitPorcelainTracked([' M lib/ask.js', ' M lib/render.js', ' M scripts/x.mjs']).tracked, union)
    const got = mixed.outOfBounds.map((v) => v.path).join(',')
    rows.push({
      line: 'MIX[ M lib/ask.js | M lib/render.js | M scripts/x.mjs]', expect: 'scripts/x.mjs', got,
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
    [HOST.askIo, 'allow', '本卡写集（答疑 IO 薄壳）'],
    [HOST.drain, 'allow', '本卡写集（包侧归档脚本）'],
    ['docs/unify/receipts/U14.json', 'allow', '本卡写集（tracked 回执）'],
    ['test/audit/U14.mjs', 'allow', '本卡写集（本入口）'],
    [path.join(s.roots[0], 'a07-clean', 'lib', 'unify', 'records.cjs'), 'allow', 'E:\\Temp 本次临时根下的自建副本'],
    ['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
    ['lib/pack-model.js', 'reject', 'U09 写集 —— 同上'],
    [U09_A_FACE, 'reject', 'U09 的 A 面 —— 本卡连碰都不许碰'],
    ['test/intake.mjs', 'reject', 'U10 的 A 面 —— 同上'],
    ['lib/unify/stage.cjs', 'reject', 'U10 写集 —— 同上'],
    ['audit-evidence/U10/pre-change.json', 'reject', '兄弟卡的改前材料（本卡只读）'],
    ['lib/whatever.js', 'reject', '野路径'],
    ['test/_pack.mjs', 'reject', '既有测试'],
    [path.join(TEMP_PARENT, 'u14-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
    ['C:\\Windows\\u14-x.txt', 'reject', '与仓无关的绝对路径'],
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
 * 模块加载（CJS 内核 + ESM 宿主；都能从仓根或 E:\Temp 副本加载同一套代码）
 * ══════════════════════════════════════════════════════════════════════ */

/** 权威内核（CJS；baseDir 允许指向 A07 的副本） */
function kernel(baseDir = REPO) {
  const abs = path.join(baseDir, ...KERNEL.split('/'))
  delete require_.cache[abs]
  return require_(abs)
}
/** 包级事务件（同一份实现；A07 副本也要给 commit 用） */
function transaction(baseDir = REPO) {
  const abs = path.join(baseDir, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs')
  delete require_.cache[abs]
  return require_(abs)
}
/** 四个宿主（ESM）。包侧 drain 是 CJS 且只在"自建临时包"里可加载（仓根是 type=module），
 *  它的用例在 A05/A07 里用 `makeDrainPack()` 逐字复制到临时包后跑。 */
async function loadHosts(baseDir = REPO) {
  const out = {}
  for (const [key, relPath] of Object.entries(HOST)) {
    if (key === 'drain') continue
    out[key] = await import(pathToFileURL(path.join(baseDir, ...relPath.split('/'))).href)
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════ */

let fixtureSeq = 0

/**
 * 在本次临时根下造一个**真**课程包目录：
 *   · 课次三角：`lessons/<circle>/<point>/0001-x.html` + `lessons/src/...` + `code/<proj>/EXPECT.json`
 *   · 已答台账（UMD 空台账）
 *   · 队列 / 笔记 / 学习记录目录
 */
function makePack(tag, circles = [{ id: 'programming', points: ['vue'] }]) {
  fixtureSeq += 1
  const root = path.join(RUN_TEMP, 'packs', `${tag}-${fixtureSeq}-${crypto.randomBytes(3).toString('hex')}`)
  fs.mkdirSync(root, { recursive: true })
  const lessons = []
  for (const circle of circles) {
    for (const point of circle.points) {
      for (const sub of [path.join('lessons', circle.id, point), path.join('lessons', 'src', circle.id, point)]) {
        fs.mkdirSync(path.join(root, sub), { recursive: true })
        fs.writeFileSync(path.join(root, sub, '0001-start.html'), `<!doctype html><title>${circle.id}/${point}</title>\n`, 'utf8')
      }
      lessons.push({ id: `${circle.id}/${point}/0001`, title: '第1课' })
    }
  }
  fs.mkdirSync(path.join(root, 'code', 'proj'), { recursive: true })
  fs.writeFileSync(path.join(root, 'code', 'proj', 'EXPECT.json'), `${JSON.stringify({ lessons }, null, 2)}\n`, 'utf8')
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), kernel().emptyLedgerSource('/** fixture 台账 */\n'), 'utf8')
  for (const d of ['questions', 'notes', 'learning-records']) fs.mkdirSync(path.join(root, d), { recursive: true })
  return root
}

/** 写一个台账（jsonl） */
function writeLines(root, relPath, lines) {
  const abs = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
  return abs
}

/** 学生原话样本（含换行 / 引号 / 反斜杠 / emoji —— 任何重序列化都会在这里露馅） */
const RICH_TEXT = '第一行：为什么 `$&` 会写飞？\n第二行：反斜杠 \\ 与引号 " 与 emoji 😀 与全角　空格'

/** 建一份带条目的已答台账源（条目是 JSON 形态的简化记录，够 drain 判"确实已答"） */
function writeAnswerLedger(root, entries) {
  let src = kernel().emptyLedgerSource('/** fixture 台账 */\n')
  const blocks = entries.map((e) => `  '${e.id}': ${JSON.stringify(e)}`)
  if (blocks.length) src = src.replace(kernel().LEDGER_ANCHOR, `,\n${blocks.join(',\n')}${kernel().LEDGER_ANCHOR}`)
  fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), src, 'utf8')
  return src
}

/* ══════════════════════════════════════════════════════════════════════
 * 判官（A01/A02/A05/A06 与 A07 用**同一份**判官；A07 只是把模块换成变异副本）
 * ══════════════════════════════════════════════════════════════════════ */

/** 计数事务（包一层真事务件）：断言"进事务几次"与"根本没进事务" */
function countingTxn(txn) {
  const box = {
    calls: 0,
    withPackTransaction(root, build, opts) {
      box.calls += 1
      return txn.withPackTransaction(root, build, opts)
    },
  }
  if (typeof txn.assertNoRecoveryRequired === 'function') box.assertNoRecoveryRequired = (io, root) => txn.assertNoRecoveryRequired(io, root)
  if (typeof txn.failureFor === 'function') box.failureFor = (res) => txn.failureFor(res)
  if (typeof txn.txnPaths === 'function') box.txnPaths = (root) => txn.txnPaths(root)
  if (typeof txn.pendingRecovery === 'function') box.pendingRecovery = (io, root) => txn.pendingRecovery(io, root)
  return box
}

/**
 * A01 本体：记录与序号**一起**提交。
 */
export function judgeCommitTogether(km, tx, base) {
  const violations = []
  const observed = {}
  const root = path.join(base, 'a01', crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(root, { recursive: true })

  // ① ask：计划同时含 pending 与 seq；一次追加只进一次事务
  const probe = countingTxn(tx)
  const askPlan = km.planRecordAppend('ask', root, () => ({ content: '', seqContent: '' }), { fs })
  if (askPlan.ok !== true) {
    violations.push(`ask 的 planRecordAppend 失败：${askPlan.error}`)
  } else {
    const rels = askPlan.plan.files.map((f) => f.rel)
    if (JSON.stringify(rels) !== JSON.stringify(['questions/pending.jsonl', 'questions/seq.txt'])) {
      violations.push(`ask 计划里的落点不对：${JSON.stringify(rels)}`)
    }
    if (askPlan.plan.schema !== 'whale-commit/1') violations.push(`ask 计划的 schema 不是 whale-commit/1（${askPlan.plan.schema}）`)
    if (!/^[0-9a-f]{64}$/.test(String(askPlan.plan.planDigest))) violations.push('ask 计划没有 sha256 摘要')
  }
  const askRoot = path.join(root, 'ask')
  fs.mkdirSync(askRoot, { recursive: true })
  const r1 = km.appendAskRecord(askRoot, { question: '第一个问题', lesson: 'programming/vue/0001' }, { at: '2026-10-20T00:00:00.000Z', transaction: probe })
  const r2 = km.appendAskRecord(askRoot, { question: '第二个问题' }, { at: '2026-10-20T00:00:01.000Z', transaction: probe })
  const seqText = readOrNull(path.join(askRoot, 'questions', 'seq.txt'))
  const pendingText = readOrNull(path.join(askRoot, 'questions', 'pending.jsonl'))
  const lines = String(pendingText || '').split('\n').filter((l) => l.trim())
  observed.ask = {
    ok: [r1.ok, r2.ok], states: [r1.state, r2.state], ids: [r1.value && r1.value.id, r2.value && r2.value.id],
    seq: seqText, txnCalls: probe.calls, lines: lines.length,
  }
  if (!(r1.ok && r2.ok)) violations.push(`ask 两次追加必须都成功（${r1.error} / ${r2.error}）`)
  if (probe.calls !== 2) violations.push(`ask 两次追加应恰好进两次事务（实得 ${probe.calls}）—— 记录与序号没在同一提交里`)
  if (seqText !== '2') violations.push(`ask 的 questions/seq.txt 原始字节应为 "2"（实得 ${fmt(seqText)}）`)
  if (JSON.stringify([r1.value && r1.value.id, r2.value && r2.value.id]) !== JSON.stringify(['0001', '0002'])) {
    violations.push(`ask 编号应为 0001/0002（实得 ${JSON.stringify([r1.value && r1.value.id, r2.value && r2.value.id])}）`)
  }
  if (lines.length !== 2) violations.push(`ask 队列应有两行（实得 ${lines.length}）`)
  if (lines.length === 2) {
    const a = JSON.parse(lines[0])
    const b = JSON.parse(lines[1])
    if (Object.keys(a).join(',') !== 'id,at,lesson,page,title,question,status') violations.push(`ask 记录键序变了：${Object.keys(a).join(',')}`)
    if (b.id !== '0002') violations.push(`ask 第二行编号不是 0002（${b.id}）`)
  }

  // ② note：同样两个落点；seq 字节是 "2\n"（既有契约）
  const noteRoot = path.join(root, 'note')
  fs.mkdirSync(noteRoot, { recursive: true })
  const p2 = countingTxn(tx)
  const n1 = km.appendNoteRecord(noteRoot, { text: '第一条笔记', anchorKey: 'programming/vue/0001' }, { transaction: p2 })
  const n2 = km.appendNoteRecord(noteRoot, { text: '第二条笔记', anchorKey: 'programming/vue/0001', date: '2026-10-20' }, { transaction: p2 })
  const notePlan = km.planRecordAppend('note', noteRoot, () => ({ content: '', seqContent: '' }), { fs })
  observed.note = {
    ok: [n1.ok, n2.ok], seq: readOrNull(path.join(noteRoot, 'notes', 'seq.txt')),
    txnCalls: p2.calls, planRels: notePlan.ok ? notePlan.plan.files.map((f) => f.rel) : notePlan.error,
  }
  if (!(n1.ok && n2.ok)) violations.push(`note 两次追加必须都成功（${n1.error} / ${n2.error}）`)
  if (p2.calls !== 2) violations.push(`note 两次追加应恰好进两次事务（实得 ${p2.calls}）`)
  if (observed.note.seq !== '2\n') violations.push(`note 的 notes/seq.txt 原始字节应为 "2\\n"（实得 ${fmt(observed.note.seq)}）`)
  if (JSON.stringify(observed.note.planRels) !== JSON.stringify(['notes/notes.jsonl', 'notes/seq.txt'])) {
    violations.push(`note 计划里的落点不对：${JSON.stringify(observed.note.planRels)}`)
  }

  // ③ 单文件路径（adjust / answer）：同一个提交协议，但只含一个落点
  const adjRoot = path.join(root, 'adjust')
  fs.mkdirSync(adjRoot, { recursive: true })
  const p3 = countingTxn(tx)
  const ar = km.appendAdjustRecord(adjRoot, { lesson: 'programming/vue/0001', title: '第1课', adjust: '还行', lit: true, gaps: [] }, { transaction: p3 })
  const adjPlan = km.planRecordAppend('adjust', adjRoot, () => ({ content: '' }), { fs })
  observed.adjust = { ok: ar.ok, txnCalls: p3.calls, planRels: adjPlan.ok ? adjPlan.plan.files.map((f) => f.rel) : adjPlan.error }
  if (!ar.ok) violations.push(`adjust 追加失败：${ar.error}`)
  if (p3.calls !== 1) violations.push(`adjust 一次追加应恰好进一次事务（实得 ${p3.calls}）`)
  if (JSON.stringify(observed.adjust.planRels) !== JSON.stringify(['learning-records/adjustments.jsonl'])) {
    violations.push(`adjust 计划里的落点不对：${JSON.stringify(observed.adjust.planRels)}`)
  }
  return { observed, violations }
}

/** 故障 fs：在**指定目标**的某个 fs 操作上抛错（只影响这个副本，仓内真 fs 不动）
 *  `once: true`（默认）= **单次**故障：回滚时的同一目标不再抛，才能验证"回滚确实把字节还原"。 */
function faultFs(spec) {
  const fired = { count: 0 }
  const hit = (p) => {
    const s = String(toPathString(p) || '')
    if (!s.includes(spec.includes)) return false
    if (spec.includes2 && !s.includes(spec.includes2)) return false
    if (spec.once !== false && fired.count > 0) return false
    fired.count += 1
    return true
  }
  const raise = () => {
    const e = new Error(`injected ${spec.code} at ${spec.op}`)
    e.code = spec.code
    throw e
  }
  if (spec.op === 'renameSync') {
    return {
      fired,
      fs: {
        ...fs,
        renameSync: (a, b) => {
          if (hit(b)) raise()
          return fs.renameSync(a, b)
        },
      },
    }
  }
  return {
    fired,
    fs: {
      ...fs,
      writeFileSync: (p, data, o) => {
        if (hit(p)) raise()
        return fs.writeFileSync(p, data, o)
      },
    },
  }
}

/**
 * A02 本体：第二个文件写入失败不留下半提交。
 * 注入点在**第二次 rename 的目标**（第一个目标已经落位）—— 这才是"半提交"的现场。
 */
export function judgeHalfCommit(km, tx, base) {
  const violations = []
  const observed = []
  const cases = [
    { kind: 'ask', rel: 'questions/pending.jsonl', seqRel: 'questions/seq.txt' },
    { kind: 'note', rel: 'notes/notes.jsonl', seqRel: 'notes/seq.txt' },
  ]
  for (const c of cases) {
    const root = path.join(base, 'a02', `${c.kind}-${crypto.randomBytes(4).toString('hex')}`)
    fs.mkdirSync(root, { recursive: true })
    // 先写一条基线内容，让"回滚到写前字节"有东西可回
    const seed = c.kind === 'ask'
      ? km.appendAskRecord(root, { question: '种子' }, { at: '2026-10-20T00:00:00.000Z', transaction: tx })
      : km.appendNoteRecord(root, { text: '种子', anchorKey: 'programming/vue/0001' }, { transaction: tx })
    if (!seed.ok) { violations.push(`${c.kind} 的种子写入失败：${seed.error}`); continue }
    const before = {
      ledger: readOrNull(path.join(root, ...c.rel.split('/'))),
      seq: readOrNull(path.join(root, ...c.seqRel.split('/'))),
    }
    const fault = faultFs({ op: 'renameSync', includes: c.seqRel.split('/').pop(), code: 'EIO' })
    const res = c.kind === 'ask'
      ? km.appendAskRecord(root, { question: '会失败的' }, { at: '2026-10-20T00:00:01.000Z', transaction: tx, fs: fault.fs })
      : km.appendNoteRecord(root, { text: '会失败的', anchorKey: 'programming/vue/0001' }, { transaction: tx, fs: fault.fs })
    const after = {
      ledger: readOrNull(path.join(root, ...c.rel.split('/'))),
      seq: readOrNull(path.join(root, ...c.seqRel.split('/'))),
    }
    const leftovers = fs.readdirSync(path.dirname(path.join(root, ...c.rel.split('/')))).filter((n) => n.includes('.tmp-txn-'))
    const txnDirs = fs.existsSync(path.join(root, '.whale-txn')) ? fs.readdirSync(path.join(root, '.whale-txn')) : []
    const lock = fs.existsSync(path.join(root, '.whale-write.lock'))
    observed.push({
      kind: c.kind, ok: res.ok, state: res.state, code: res.code, error: res.error,
      fired: fault.fired.count, ledgerSame: after.ledger === before.ledger, seqSame: after.seq === before.seq,
      leftovers, txnDirs, lock,
    })
    if (res.ok !== false) violations.push(`${c.kind}：注入失败后不许报成功（ok=${res.ok}）`)
    if (res.state !== 'rolled-back') violations.push(`${c.kind}：state 应为 rolled-back（实得 ${res.state}；error=${res.error}）`)
    if (fault.fired.count < 1) violations.push(`${c.kind}：故障注入一次都没生效 —— 这条断言是空的`)
    if (after.ledger !== before.ledger) violations.push(`${c.kind}：台账没有回到写前字节（出现半提交）`)
    if (after.seq !== before.seq) violations.push(`${c.kind}：序号文件没有回到写前字节（出现半提交）`)
    if (leftovers.length) violations.push(`${c.kind}：台账目录里留下暂存残骸 ${leftovers.join(',')}`)
    if (txnDirs.length) violations.push(`${c.kind}：事务日志没有收干净 ${txnDirs.join(',')}`)
    if (lock) violations.push(`${c.kind}：包锁没有释放`)
  }
  return { observed, violations }
}

/**
 * A03 本体：读取故障不当空队列或空台账。
 */
export async function judgeReadStates(km, hosts, base) {
  const violations = []
  const observed = {}
  const mk = (name) => { const d = path.join(base, 'a03', `${name}-${crypto.randomBytes(3).toString('hex')}`); fs.mkdirSync(d, { recursive: true }); return d }

  const okLines = {
    ask: [JSON.stringify({ id: '0001', at: 't', lesson: 'programming/vue/0001', page: '', title: '', question: '问', status: 'pending' })],
    note: [JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: 'programming/vue/0001', text: '笔记' })],
    adjust: [JSON.stringify({ ts: 't', lesson: 'programming/vue/0001', title: '第1课', adjust: '调整', lit: true, gaps: [] })],
  }
  const relOf = { ask: 'questions/pending.jsonl', note: 'notes/notes.jsonl', adjust: 'learning-records/adjustments.jsonl' }

  for (const kind of ['ask', 'note', 'adjust']) {
    const row = {}
    {
      const root = mk(`${kind}-missing`)
      const r = km.readRecordLedger(kind, root)
      row.missing = { status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length }
    }
    {
      const root = mk(`${kind}-empty`)
      writeLines(root, relOf[kind], [])
      const r = km.readRecordLedger(kind, root)
      row.empty = { status: r.status, exists: r.exists, entries: r.entries.length, problems: r.problems.length }
    }
    {
      const root = mk(`${kind}-ok`)
      writeLines(root, relOf[kind], okLines[kind])
      const r = km.readRecordLedger(kind, root)
      row.ok = { status: r.status, entries: r.entries.length, problems: r.problems.length }
    }
    {
      const root = mk(`${kind}-invalid`)
      writeLines(root, relOf[kind], [...okLines[kind], '这不是合法JSON{{{]'])
      const r = km.readRecordLedger(kind, root)
      row.invalid = { status: r.status, entries: r.entries.length, problems: r.problems.length, failureCode: r.failure ? r.failure.code : null }
    }
    {
      const root = mk(`${kind}-io`)
      fs.mkdirSync(path.join(root, ...relOf[kind].split('/')), { recursive: true })
      const r = km.readRecordLedger(kind, root)
      row.io = {
        status: r.status, entries: r.entries.length, problems: r.problems.length,
        errorCode: r.errorCode === undefined ? null : r.errorCode, failureCode: r.failure ? r.failure.code : null,
      }
    }
    observed[kind] = row
    const want = {
      missing: { status: 'missing', exists: false, entries: 0, problems: 0 },
      empty: { status: 'empty', exists: true, entries: 0, problems: 0 },
      ok: { status: 'ok' },
      invalid: { status: 'invalid', failureCode: 'LEDGER_INVALID' },
      io: { status: 'io-error', entries: 0, errorCode: 'EISDIR', failureCode: 'IO_ERROR' },
    }
    for (const [state, expect] of Object.entries(want)) {
      for (const [k, v] of Object.entries(expect)) {
        if (row[state][k] !== v) violations.push({ kind, state, msg: `${kind}/${state}.${k} 应为 ${fmt(v)}，实得 ${fmt(row[state][k])}` })
      }
    }
    if (row.ok.entries < 1) violations.push({ kind, state: 'ok', msg: `${kind}/ok 一条记录都没读出来` })
    if (row.invalid.problems < 1) violations.push({ kind, state: 'invalid', msg: `${kind}/invalid 没有 problems（坏行被吞了）` })
    if (row.io.problems < 1) violations.push({ kind, state: 'io', msg: `${kind}/io-error 没有 problems（读取故障被吞成空台账）` })
    const gotStatuses = [row.missing.status, row.empty.status, row.ok.status, row.invalid.status, row.io.status]
    if (new Set(gotStatuses).size !== 5) violations.push({ kind, state: '-', msg: `${kind}：五态没有区分开（${gotStatuses.join(' / ')}）` })
  }

  // ④ 已答台账（JS 源码）：missing / empty / ok / invalid / io-error 同五态
  {
    const row = {}
    {
      const root = mk('answer-missing')
      const r = km.readRecordLedger('answer', root)
      row.missing = { status: r.status, exists: r.exists, entries: r.entries.length }
    }
    {
      const root = mk('answer-empty')
      fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
      fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), km.emptyLedgerSource('/** h */\n'), 'utf8')
      const r = km.readRecordLedger('answer', root)
      row.empty = { status: r.status, entries: r.entries.length }
    }
    {
      const root = mk('answer-ok')
      fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
      writeAnswerLedger(root, [{ id: '0001', status: 'answered', anchor: 'q0001' }])
      const r = km.readRecordLedger('answer', root)
      row.ok = { status: r.status, entries: r.entries.length }
    }
    {
      const root = mk('answer-invalid')
      fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
      fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), 'module.exports = { 这不是 js ]]]\n', 'utf8')
      const r = km.readRecordLedger('answer', root)
      row.invalid = { status: r.status, failureCode: r.failure ? r.failure.code : null }
    }
    {
      const root = mk('answer-io')
      fs.mkdirSync(path.join(root, 'assets', 'questions-data.js'), { recursive: true })
      const r = km.readRecordLedger('answer', root)
      row.io = { status: r.status, errorCode: r.errorCode || null, failureCode: r.failure ? r.failure.code : null }
    }
    observed.answer = row
    const want = {
      missing: { status: 'missing', exists: false, entries: 0 },
      empty: { status: 'empty', entries: 0 },
      ok: { status: 'ok' },
      invalid: { status: 'invalid', failureCode: 'LEDGER_INVALID' },
      io: { status: 'io-error', errorCode: 'EISDIR', failureCode: 'IO_ERROR' },
    }
    for (const [state, expect] of Object.entries(want)) {
      for (const [k, v] of Object.entries(expect)) {
        if (row[state][k] !== v) violations.push({ kind: 'answer', state, msg: `answer/${state}.${k} 应为 ${fmt(v)}，实得 ${fmt(row[state][k])}` })
      }
    }
    if (row.ok.entries < 1) violations.push({ kind: 'answer', state: 'ok', msg: 'answer/ok 一条记录都没读出来' })
  }

  // ⑤ 序号文件读不动 → **拒绝写入**（不是从 0001 重新发号）
  {
    const root = makePack('a03-seq', [{ id: 'programming', points: ['vue'] }])
    const probe = countingTxn(transaction())
    const first = km.appendNoteRecord(root, { text: '第一条', anchorKey: 'programming/vue/0001' }, { transaction: probe })
    if (!first.ok) violations.push(`a03：种子笔记写入失败：${first.error}`)
    const before = readOrNull(path.join(root, 'notes', 'notes.jsonl'))
    const seqBefore = readOrNull(path.join(root, 'notes', 'seq.txt'))
    fs.rmSync(path.join(root, 'notes', 'seq.txt'), { force: true })
    fs.mkdirSync(path.join(root, 'notes', 'seq.txt'), { recursive: true })   // 目录 = EISDIR 读取故障
    const p2 = countingTxn(transaction())
    const seqBad = km.appendNoteRecord(root, { text: '第二条（应该被拒）', anchorKey: 'programming/vue/0001' }, { transaction: p2 })
    observed.seqReadFault = { ok: seqBad.ok, code: seqBad.code, txnCalls: p2.calls, ledgerSame: readOrNull(path.join(root, 'notes', 'notes.jsonl')) === before }
    if (seqBad.ok !== false) violations.push('a03：序号文件读不动时必须拒绝写入（不许从 0001 重新发号）')
    if (seqBad.code !== 'IO_ERROR') violations.push(`a03：序号读不动的拒绝码应为 IO_ERROR（实得 ${seqBad.code}）`)
    if (p2.calls !== 0) violations.push(`a03：序号读不动的拒绝必须在碰事务之前（实得 ${p2.calls} 次）`)
    if (readOrNull(path.join(root, 'notes', 'notes.jsonl')) !== before) violations.push('a03：被拒之后台账字节动了')
    fs.rmSync(path.join(root, 'notes', 'seq.txt'), { recursive: true, force: true })
    if (seqBefore !== '1\n') violations.push(`a03：种子的 notes/seq.txt 应为 "1\\n"（实得 ${fmt(seqBefore)}）`)
  }

  // ⑥ 宿主读端：adjust-io 把读取故障报进 problems（不再伪装成空台账）
  {
    const root = makePack('a03-adjust', [{ id: 'programming', points: ['vue'] }])
    fs.mkdirSync(path.join(root, 'learning-records', 'adjustments.jsonl'), { recursive: true })
    const r = hosts.adjustIo.readAdjustments(root)
    observed.adjustHostIo = { entries: r.entries.length, problems: r.problems.length, first: r.problems[0] || null }
    if (r.problems.length < 1) violations.push('a03：adjust-io 读不动时必须把故障报进 problems（旧实现静默返回空台账）')
    if (!/台账读不动/.test(String(r.problems[0]))) violations.push(`a03：adjust-io 的故障文案应点明"台账读不动"（实得 ${fmt(r.problems[0])}）`)
    const missing = hosts.adjustIo.readAdjustments(path.join(base, 'a03', 'nope-dir'))
    observed.adjustHostMissing = { entries: missing.entries.length, problems: missing.problems.length }
    if (missing.problems.length !== 0) violations.push('a03：文件不存在是**正常空态**，不该报 problem（既有语义必须保留）')
  }
  return { observed, violations }
}

/**
 * A04 本体：课程身份与页面锚点不混淆。
 */
export function judgeIdentitySplit(km, base) {
  const violations = []
  const observed = {}
  const index = {
    byKey: {
      'programming/vue/0001': { label: '第1课' },
      'programming/vue/0002': { label: '第2课' },
      'a/x/0001': { label: '第1课' },
      'b/x/0001': { label: '第1课' },
    },
  }
  const cat = km.buildCatalogue(index)
  observed.catalogue = { keys: cat.keys.length, byPointX: cat.byPoint.get('x') }

  // ① 页面锚点：只能当页面定位值
  observed.pageAnchor = {
    isPage: km.isPageAnchor('q0001'), isNot: km.isPageAnchor('q0001x'),
    of: km.pageAnchorOf('0004'), parsed: km.parsePageAnchor('q0004'),
  }
  if (km.isPageAnchor('q0001') !== true) violations.push('A04：q0001 必须被认成页面锚点')
  if (km.isPageAnchor('q0001x') !== false) violations.push('A04：q0001x 不是页面锚点')
  if (km.pageAnchorOf('0004') !== 'q0004') violations.push('A04：pageAnchorOf(0004) 应为 q0004')
  if (km.parsePageAnchor('0004').ok !== false) violations.push('A04：不带 q 前缀的编号不是页面锚点')

  // ② 页面锚点**当课程键**：一律拒
  {
    const got = km.classifyCourseRef('q0001')
    observed.pageAnchorAsCourse = { ok: got.ok, code: got.code, reason: got.reason }
    if (got.ok !== false) violations.push('A04：页面锚点 q0001 不许当课程键（必须拒）')
    if (got.code !== 'LEDGER_INVALID') violations.push(`A04：页面锚点当课程键的码应为 LEDGER_INVALID（实得 ${got.code}）`)
    if (got.reason !== 'page-anchor') violations.push(`A04：页面锚点当课程键的 reason 应为 page-anchor（实得 ${got.reason}）`)
    if (!/页面锚点/.test(String(got.error))) violations.push('A04：拒绝理由必须点明"页面锚点"')
  }

  // ③ 规范课次键：经 identity 内核原样通过（不重建、不改写）
  {
    const got = km.classifyCourseRef('programming/vue/0001')
    observed.canonical = { ok: got.ok, key: got.key, shape: got.shape }
    if (got.ok !== true) violations.push('A04：规范课次键必须被接受')
    if (got.key !== 'programming/vue/0001') violations.push(`A04：规范课次键必须原样返回（实得 ${got.key}）`)
    if (got.shape !== 'lesson') violations.push(`A04：规范课次键的 shape 应为 lesson（实得 ${got.shape}）`)
  }

  // ④ 跨圈歧义：裸点 x 在两圈都有 → ID_AMBIGUOUS + 两个候选（绝不猜）
  {
    const got = km.classifyCourseRef('x', { catalogue: cat })
    observed.ambiguous = { ok: got.ok, code: got.code, candidates: got.candidates }
    if (got.ok !== false) violations.push('A04：跨圈同名裸点必须被拒（不许按第一个猜）')
    if (got.code !== 'ID_AMBIGUOUS') violations.push(`A04：歧义拒绝的码应为 ID_AMBIGUOUS（实得 ${got.code}）`)
    sameJson(got.candidates, ['a/x', 'b/x'], 'A04：歧义拒绝必须列出两个候选')
    const halo = km.classifyCourseRef('x', { catalogue: cat, halo: 'b' })
    if (halo.ok !== true || halo.key !== 'b/x') violations.push(`A04：给了圆圈就必须解得出来（b/x），实得 ${JSON.stringify(halo)}`)
  }

  // ⑤ 未归课哨兵桶保留（既有语义）；页面锚点/显示名一律不是笔记锚点
  {
    const sentinel = km.classifyNoteAnchor('未归课')
    if (sentinel.ok !== true) violations.push('A04：未归课哨兵必须被接受（既有桶语义）')
    if (km.classifyNoteAnchor('q0001').ok !== false) violations.push('A04：页面锚点不许当笔记锚点')
    const label = km.classifyNoteAnchor('第1课')
    observed.displayName = { ok: label.ok, code: label.code, reason: label.reason }
    if (label.ok !== false) violations.push('A04：显示名不是身份（必须拒）')
    if (label.code !== 'MIGRATION_REQUIRED') violations.push(`A04：显示名的拒绝码应为 MIGRATION_REQUIRED（实得 ${label.code}）`)
    const legacyTwo = km.classifyNoteAnchor('vue/0001')
    if (legacyTwo.ok !== false) violations.push('A04：两段课键（point/课号）不是规范身份（必须拒）')
    if (legacyTwo.code !== 'MIGRATION_REQUIRED') violations.push(`A04：两段课键的拒绝码应为 MIGRATION_REQUIRED（实得 ${legacyTwo.code}）`)
  }

  // ⑥ 已答条目：anchor 是页面定位值、lesson 是显示名 —— **两个槽位**
  {
    const entry = km.buildAnswerEntry({
      id: '0004', date: null, lesson: '第1课', question: '问', section: '答疑', answer: '答', answerHtml: '<p>答</p>',
    })
    observed.answerEntry = { anchor: entry.anchor, lesson: entry.lesson, keys: Object.keys(entry).join(',') }
    if (entry.anchor !== 'q0004') violations.push(`A04：已答条目的 anchor 应为 q0004（实得 ${entry.anchor}）`)
    if (entry.lesson !== '第1课') violations.push(`A04：已答条目的 lesson 是课次显示名（既有契约），不得换成身份键（实得 ${entry.lesson}）`)
    let threw = null
    try {
      km.buildAnswerEntry({ id: '0004', date: null, lesson: 'q0004', question: '问', section: 's', answer: 'a', answerHtml: '<p>a</p>' })
    } catch (e) { threw = e }
    if (!threw) violations.push('A04：把页面锚点塞进课程槽位（lesson）必须抛错')
    // 落盘后两个槽位仍在不同位置
    const root = makePack('a04', [{ id: 'programming', points: ['vue'] }])
    const w = km.appendAnswerEntry(root, entry, { transaction: transaction() })
    if (!w.ok) violations.push(`A04：已答条目写入失败：${w.error}`)
    const src = readOrNull(path.join(root, 'assets', 'questions-data.js')) || ''
    observed.ledgerSlots = { hasAnchor: /anchor: 'q0004'/.test(src), hasLesson: /lesson: '第1课'/.test(src) }
    if (!/anchor: 'q0004'/.test(src)) violations.push('A04：落盘的 anchor 槽位应是页面锚点 q0004')
    if (!/lesson: '第1课'/.test(src)) violations.push('A04：落盘的 lesson 槽位应是课次显示名（未被换身份键）')
  }
  return { observed, violations }
}

/**
 * A05 本体：归档只处理**确实已答**记录，保留键序与原始正文。
 *
 * @param {object} km kernel
 * @param {object} tx 事务件
 * @param {object} drainMod 包侧 drain-questions 模块（自建临时包里的副本）
 * @param {string} base 本次临时根
 * @param {Function} makeRootFixture 造包回调
 */
export function judgeArchive(km, tx, drainMod, base, makeRootFixture) {
  const violations = []
  const observed = {}
  const root = makeRootFixture('a05')
  // 队列：0001 已答（带正文）/ 0002 登记但 status=pending / 0003 未登记 / 坏行
  const L = [
    JSON.stringify({ id: '0001', question: RICH_TEXT }),
    JSON.stringify({ id: '0002', question: '登记了但没答完' }),
    JSON.stringify({ id: '0003', question: '根本没登记' }),
    '这一行不是 JSON',
  ]
  writeLines(root, 'questions/pending.jsonl', L)
  fs.writeFileSync(path.join(root, 'questions', 'seq.txt'), '3', 'utf8')
  fs.writeFileSync(path.join(root, 'questions', 'processed.jsonl'), `${JSON.stringify({ id: '0000', question: '早先归档的' })}\n`, 'utf8')
  writeAnswerLedger(root, [
    { id: '0000', status: 'answered', anchor: 'q0000', answer: '早先', answerHtml: '<p>早先</p>' },
    { id: '0001', status: 'answered', anchor: 'q0001', answer: '解答', answerHtml: '<p>解答</p>' },
    { id: '0002', status: 'pending', anchor: 'q0002' },
  ])
  const seqBefore = readOrNull(path.join(root, 'questions', 'seq.txt'))
  const processedBefore = readOrNull(path.join(root, 'questions', 'processed.jsonl'))

  const r = drainMod.drainPending(root)
  const pendingAfter = readOrNull(path.join(root, 'questions', 'pending.jsonl'))
  const processedAfter = readOrNull(path.join(root, 'questions', 'processed.jsonl'))
  observed.drain = { drained: r.drained, kept: r.kept, state: r.state, ok: r.ok, registered: r.registered, empty: r.empty }
  observed.pendingAfter = pendingAfter
  observed.processedAfter = processedAfter
  if (r.ok !== true || r.state !== 'committed') violations.push(`A05：归档应成功（state=${r.state} error=${r.error}）`)
  if (r.drained !== 1) violations.push(`A05：只该归档 1 条（确实已答的 0001），实得 ${r.drained}`)
  if (r.kept !== 3) violations.push(`A05：应保留 3 条未答/未登记/坏行，实得 ${r.kept}`)
  if (processedAfter !== `${processedBefore}${L[0]}\n`) {
    violations.push(`A05：processed 必须是「原有内容 + 原始队列行」，逐字节相同。实得 ${fmt(processedAfter)}`)
  }
  if (pendingAfter !== `${L[1]}\n${L[2]}\n${L[3]}\n`) {
    violations.push(`A05：留下的三行必须原样、原序（实得 ${fmt(pendingAfter)}）`)
  }
  if (/0002/.test(String(processedAfter))) violations.push('A05：登记了但 status=pending 的 0002 不许被搬走')
  if (seqBefore !== readOrNull(path.join(root, 'questions', 'seq.txt'))) violations.push('A05：归档不该动 questions/seq.txt')

  // 再归档一次：没有可归档的行 → 零写、committed
  const again = drainMod.drainPending(root)
  observed.again = { drained: again.drained, kept: again.kept, state: again.state, ok: again.ok }
  if (again.drained !== 0 || again.state !== 'committed') violations.push(`A05：第二次归档应无进展且 committed（实得 drained=${again.drained} state=${again.state}）`)
  if (readOrNull(path.join(root, 'questions', 'pending.jsonl')) !== pendingAfter) violations.push('A05：没有可归档的行时队列必须零写')

  // 空队列：empty=true，且队列文件不被创建
  {
    const emptyRoot = makeRootFixture('a05-empty')
    const rr = drainMod.drainPending(emptyRoot)
    observed.emptyQueue = { empty: rr.empty, state: rr.state, ok: rr.ok }
    if (rr.empty !== true || rr.state !== 'committed') violations.push(`A05：空队列应 empty=true + committed（实得 ${JSON.stringify(observed.emptyQueue)}）`)
    if (fs.existsSync(path.join(emptyRoot, 'questions', 'pending.jsonl'))) violations.push('A05：空队列不该被创建出来')
  }
  void tx
  void km
  return { observed, violations }
}

/**
 * A06 本体：拒绝损坏账本上的后续普通写入。
 */
export function judgeCorruptWrites(km, tx, base) {
  const violations = []
  const observed = {}
  const mk = (name) => { const d = path.join(base, 'a06', `${name}-${crypto.randomBytes(3).toString('hex')}`); fs.mkdirSync(d, { recursive: true }); return d }

  const cases = [
    {
      key: 'ask-bad-json',
      seed: (root) => writeLines(root, 'questions/pending.jsonl', ['{"id":"0001"}', '坏行{{{']),
      rel: 'questions/pending.jsonl',
      run: (root, probe) => km.appendAskRecord(root, { question: 'x' }, { at: '2026-10-20T00:00:00.000Z', transaction: probe }),
      wantCode: 'LEDGER_INVALID',
    },
    {
      key: 'note-bad-json',
      seed: (root) => writeLines(root, 'notes/notes.jsonl', ['{"id":"0001"}', '坏行']),
      rel: 'notes/notes.jsonl',
      run: (root, probe) => km.appendNoteRecord(root, { text: 'x', anchorKey: 'programming/vue/0001' }, { transaction: probe }),
      wantCode: 'LEDGER_INVALID',
    },
    {
      key: 'note-io-error',
      seed: (root) => fs.mkdirSync(path.join(root, 'notes', 'notes.jsonl'), { recursive: true }),
      rel: null,
      run: (root, probe) => km.appendNoteRecord(root, { text: 'x', anchorKey: 'programming/vue/0001' }, { transaction: probe }),
      wantCode: 'IO_ERROR',
    },
    {
      key: 'answer-bad-js',
      seed: (root) => {
        fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
        fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), 'module.exports = { 坏 ]]]\n', 'utf8')
      },
      rel: 'assets/questions-data.js',
      run: (root, probe) => km.appendAnswerEntry(root, km.buildAnswerEntry({ id: '0009', date: null, lesson: '第1课', question: 'q', section: 's', answer: 'a', answerHtml: '<p>a</p>' }), { transaction: probe }),
      wantCode: 'LEDGER_INVALID',
    },
  ]
  for (const c of cases) {
    const root = mk(c.key)
    c.seed(root)
    const before = c.rel ? readOrNull(path.join(root, ...c.rel.split('/'))) : null
    const probe = countingTxn(tx)
    const r = c.run(root, probe)
    const after = c.rel ? readOrNull(path.join(root, ...c.rel.split('/'))) : null
    observed[c.key] = { ok: r.ok, state: r.state, code: r.code, refusedBeforeCommit: r.refusedBeforeCommit, txnCalls: probe.calls, unchanged: before === after }
    if (r.ok !== false) violations.push(`A06/${c.key}：坏账本上必须拒绝普通写入（实得 ok=${r.ok}）`)
    if (r.code !== c.wantCode) violations.push(`A06/${c.key}：拒绝码应为 ${c.wantCode}（实得 ${r.code}）`)
    if (probe.calls !== 0) violations.push(`A06/${c.key}：拒绝必须在碰事务之前（实得 ${probe.calls} 次）`)
    if (c.rel && before !== after) violations.push(`A06/${c.key}：被拒之后台账字节动了`)
  }

  // 待恢复（recovery-required）：普通写入仍被拒 —— 用事务件自己的判定，不另造一套
  {
    const root = mk('recovery')
    const paths = tx.txnPaths(root)
    const jid = 'fake-recovery'
    fs.mkdirSync(path.join(paths.dir, jid), { recursive: true })
    fs.writeFileSync(path.join(paths.dir, jid, 'journal.json'), `${JSON.stringify({
      schema: 'whale-txn/1', txnId: jid, root, state: 'recovery-required', files: [],
    }, null, 2)}\n`, 'utf8')
    const probe = countingTxn(tx)
    const r = km.appendAskRecord(root, { question: 'x' }, { at: '2026-10-20T00:00:00.000Z', transaction: probe })
    observed.recovery = { ok: r.ok, state: r.state, code: r.code, txnCalls: probe.calls, queueExists: fs.existsSync(path.join(root, 'questions', 'pending.jsonl')) }
    if (r.ok !== false) violations.push('A06/recovery：有待恢复日志时必须拒绝普通写入')
    if (r.state !== 'recovery-required') violations.push(`A06/recovery：state 应为 recovery-required（实得 ${r.state}）`)
    if (r.code !== 'RECOVERY_REQUIRED') violations.push(`A06/recovery：码应为 RECOVERY_REQUIRED（实得 ${r.code}）`)
    if (probe.calls !== 0) violations.push(`A06/recovery：待恢复的拒绝必须在碰事务之前（实得 ${probe.calls}）`)
    if (observed.recovery.queueExists) violations.push('A06/recovery：被拒之后队列文件不该被创建')
  }
  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07：变异只在 E:\Temp 副本
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把本卡依赖的权威内核按**两种随包布局**逐字复制到副本（记录复制清单与摘要）：
 *   · `lib/unify/*.cjs`（宿主布局，本卡内核与 commit 的默认事务路径都在这里解析）；
 *   · `lib/pack-template/tools/unify/*.cjs`（U19 生成的随包布局，包侧 drain 从这里 require）。
 * 两处都是**同一份字节**（不是两份实现）—— 变异时两处一起改，判据才针对同一个实现。
 */
export function materializeKernelCopy(baseDir, tag) {
  const target = path.join(baseDir, 'a07', tag)
  const files = []
  const copy = (fromRel, toRel) => {
    const from = path.join(REPO, ...fromRel.split('/'))
    const to = path.join(target, ...toRel.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    files.push({ rel: toRel, bytes: fs.statSync(to).size, sha256: sha256(fs.readFileSync(to)) })
  }
  for (const m of ['identity.cjs', 'errors.cjs', 'ledger-read.cjs', 'commit.cjs', 'records.cjs']) {
    copy(`lib/unify/${m}`, `lib/unify/${m}`)
    copy(`lib/unify/${m}`, `lib/pack-template/tools/unify/${m}`)
  }
  copy('lib/pack-template/tools/ledger-transaction.cjs', 'lib/pack-template/tools/ledger-transaction.cjs')
  copy(HOST.drain, 'lib/pack-template/tools/drain-questions.js')
  return { root: target, files }
}

/** 变异 ①：把归档口径放宽成"每一行都算已答"（A05 必须红） */
export function mutateArchiveLoose(root) {
  const from = 'if (rec && typeof rec === \'object\' && !Array.isArray(rec) && answered.has(String(rec.id))) drained.push(line)'
  const to = 'if (rec && typeof rec === \'object\' && !Array.isArray(rec)) drained.push(line)'
  const mutated = []
  for (const abs of [path.join(root, 'lib', 'unify', 'records.cjs'), path.join(root, 'lib', 'pack-template', 'tools', 'unify', 'records.cjs')]) {
    const src = fs.readFileSync(abs, 'utf8')
    assert(src.includes(from), '变异 ① 的锚点在 records.cjs 里找不到（变异失效 = 判据空转）')
    fs.writeFileSync(abs, src.replace(from, to), 'utf8')
    mutated.push(rel(abs))
  }
  return { mutated, from, to }
}

/** 变异 ②：临时绕过事务、恢复两段直接写（A01/A02 必须红） */
export function mutateBypassCommit(root) {
  const anchor = '  const extra = commitExtra(opts)\n  const res = applyCommit('
  const bypass = [
    '  const extra = commitExtra(opts)',
    '  {',
    '    const rootAbs = path.resolve(String(root == null ? \'\' : root))',
    '    const before = {}',
    '    for (const f of planned.plan.files) {',
    '      const abs = path.resolve(rootAbs, f.rel)',
    '      before[f.rel] = nodeFs.existsSync(abs) ? String(nodeFs.readFileSync(abs)) : null',
    '    }',
    '    const built = planned.build({ root: rootAbs, fs: nodeFs, files: before, plan: planned.plan })',
    '    for (const f of built.files) {',
    '      const abs = path.resolve(rootAbs, f.rel)',
    '      nodeFs.mkdirSync(path.dirname(abs), { recursive: true })',
    '      nodeFs.writeFileSync(abs, f.content)',
    '    }',
    '    return { ok: true, state: \'committed\', code: null, error: null, failure: null, rollbackError: null, journal: null, txnId: \'mutant-bypass\', value: built.value, planDigest: planned.plan.planDigest, rel: planned.rel, file: planned.file, seqRel: planned.seqRel, seqFile: planned.seqFile, id: null, seq: null, buildError: null }',
    '  }',
    '  const res = applyCommit(',
  ].join('\n')
  const mutated = []
  for (const abs of [path.join(root, 'lib', 'unify', 'records.cjs'), path.join(root, 'lib', 'pack-template', 'tools', 'unify', 'records.cjs')]) {
    const src = fs.readFileSync(abs, 'utf8')
    assert(src.includes(anchor), '变异 ② 的锚点在 records.cjs 里找不到（变异失效 = 判据空转）')
    fs.writeFileSync(abs, src.replace(anchor, bypass), 'utf8')
    mutated.push(rel(abs))
  }
  return { mutated, anchor, to: '绕过事务、两段直接写' }
}

/* ══════════════════════════════════════════════════════════════════════
 * 用例
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
  const verdict = judgeCommitTogether(kernel(), transaction(), RUN_TEMP)
  DETAIL.A01 = verdict
  sameJson(verdict.violations, [], 'A01 · 记录与序号必须一起提交')
}

async function A02() {
  const verdict = judgeHalfCommit(kernel(), transaction(), RUN_TEMP)
  DETAIL.A02 = verdict
  sameJson(verdict.violations, [], 'A02 · 第二个文件写入失败不留下半提交')
}

async function A03() {
  const hosts = await loadHosts()
  const verdict = await judgeReadStates(kernel(), hosts, RUN_TEMP)
  DETAIL.A03 = verdict
  sameJson(verdict.violations, [], 'A03 · 读取故障不当空队列或空台账')
}

async function A04() {
  const verdict = judgeIdentitySplit(kernel(), RUN_TEMP)
  DETAIL.A04 = verdict
  sameJson(verdict.violations, [], 'A04 · 课程身份与页面锚点不混淆')
}

/** 造一个"包侧 drain 可用"的自建临时包（tools/unify/* + tools/ledger-transaction.cjs 逐字复制） */
export function makeDrainPack(tag) {
  const root = path.join(RUN_TEMP, 'drain', `${tag}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(path.join(root, 'tools', 'unify'), { recursive: true })
  const copy = (fromRel, toRel) => {
    const from = path.join(REPO, ...fromRel.split('/'))
    const to = path.join(root, ...toRel.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  for (const m of ['identity.cjs', 'errors.cjs', 'ledger-read.cjs', 'commit.cjs', 'records.cjs']) {
    copy(`lib/unify/${m}`, `tools/unify/${m}`)
  }
  copy('lib/pack-template/tools/ledger-transaction.cjs', 'tools/ledger-transaction.cjs')
  copy(HOST.drain, 'tools/drain-questions.js')
  for (const d of ['assets', 'questions', 'notes', 'learning-records']) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), kernel().emptyLedgerSource('/** fixture 台账 */\n'), 'utf8')
  const abs = path.join(root, 'tools', 'drain-questions.js')
  delete require_.cache[abs]
  const mod = require_(abs)
  return { root, mod }
}

async function A05() {
  const pack = makeDrainPack('a05')
  const verdict = judgeArchive(kernel(), transaction(), pack.mod, RUN_TEMP, (tag) => makePack(tag, [{ id: 'programming', points: ['vue'] }]))
  DETAIL.A05 = { ...verdict, drainPack: rel(pack.root) }
  sameJson(verdict.violations, [], 'A05 · 归档只处理确实已答记录，保留键序和原始正文')

  // 既有实现对拍：同一批输入，HEAD 版旧 drain 与新 drain 的**产物逐字节**比一次
  const oldDir = path.join(RUN_TEMP, 'old', 'drain')
  const headDrain = gitHeadBytes(HOST.drain)
  assert(headDrain !== null, 'A05 · git HEAD 里没有 drain-questions.js')
  fs.mkdirSync(oldDir, { recursive: true })
  fs.writeFileSync(path.join(oldDir, 'drain-questions.js'), headDrain)
  fs.copyFileSync(path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs'), path.join(oldDir, 'ledger-transaction.cjs'))
  const oldAbs = path.join(oldDir, 'drain-questions.js')
  delete require_.cache[oldAbs]
  const oldMod = require_(oldAbs)
  const parity = []
  for (const scenario of ['all-answered', 'mixed', 'nothing-answered']) {
    const runOn = (mod, tag) => {
      const root = path.join(RUN_TEMP, 'a05-parity', `${tag}-${scenario}-${crypto.randomBytes(3).toString('hex')}`)
      fs.mkdirSync(path.join(root, 'questions'), { recursive: true })
      fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
      const ids = scenario === 'all-answered' ? ['0001', '0002'] : scenario === 'mixed' ? ['0001'] : []
      const queue = ['0001', '0002', '0003'].map((id) => JSON.stringify({ id, question: `问 ${id}` }))
      fs.writeFileSync(path.join(root, 'questions', 'pending.jsonl'), `${queue.join('\n')}\n`, 'utf8')
      const blocks = ids.map((id) => `  '${id}': { id: '${id}', status: 'answered', anchor: 'q${id}' }`)
      const ledger = kernel().emptyLedgerSource('/** h */\n').replace(
        kernel().LEDGER_ANCHOR,
        `${blocks.length ? ',' : ''}\n${blocks.join(',\n')}${kernel().LEDGER_ANCHOR}`)
      fs.writeFileSync(path.join(root, 'assets', 'questions-data.js'), ledger, 'utf8')
      const r = mod.drainPending(root)
      return {
        drained: r.drained, kept: r.kept, state: r.state, empty: r.empty,
        pending: readOrNull(path.join(root, 'questions', 'pending.jsonl')),
        processed: readOrNull(path.join(root, 'questions', 'processed.jsonl')),
      }
    }
    const a = runOn(oldMod, 'old')
    const b = runOn(pack.mod, 'new')
    parity.push({ scenario, old: a, new: b, same: JSON.stringify(a) === JSON.stringify(b) })
  }
  DETAIL.A05Parity = parity
  for (const row of parity) {
    eq(row.new.state, 'committed', `A05 · 对拍场景 ${row.scenario}：新实现应 committed`)
    eq(row.new.drained, row.old.drained, `A05 · 对拍场景 ${row.scenario}：归档条数与旧实现一致`)
    eq(row.new.pending, row.old.pending, `A05 · 对拍场景 ${row.scenario}：pending 产物逐字节与旧实现一致`)
    eq(row.new.processed, row.old.processed, `A05 · 对拍场景 ${row.scenario}：processed 产物逐字节与旧实现一致`)
  }
}

async function A06() {
  const verdict = judgeCorruptWrites(kernel(), transaction(), RUN_TEMP)
  DETAIL.A06 = verdict
  sameJson(verdict.violations, [], 'A06 · 拒绝损坏账本上的后续普通写入')
}

async function A07() {
  const base = path.join(RUN_TEMP, 'a07-run')
  fs.mkdirSync(base, { recursive: true })
  const clean = materializeKernelCopy(base, 'clean')
  const loose = materializeKernelCopy(base, 'mutant-archive')
  const bypass = materializeKernelCopy(base, 'mutant-bypass')
  const mut1 = mutateArchiveLoose(loose.root)
  const mut2 = mutateBypassCommit(bypass.root)
  const tx = transaction()
  const makeRoot = (tag) => makePack(tag, [{ id: 'programming', points: ['vue'] }])
  const drainOf = (copyRoot) => {
    const p = path.join(copyRoot, 'lib', 'pack-template', 'tools', 'drain-questions.js')
    delete require_.cache[p]
    return require_(p)
  }
  const drainClean = drainOf(clean.root)
  const drainLoose = drainOf(loose.root)
  const drainClean2 = drainOf(clean.root)

  const judgeOf = (kmMod, drainMod) => ({
    archive: judgeArchive(kmMod, tx, drainMod, base, makeRoot).violations,
    commit: judgeCommitTogether(kmMod, tx, base).violations,
    half: judgeHalfCommit(kmMod, tx, base).violations,
  })
  const cleanV = judgeOf(kernel(clean.root), drainClean)
  const looseV = judgeOf(kernel(loose.root), drainLoose)
  const bypassV = judgeOf(kernel(bypass.root), drainClean2)

  DETAIL.A07 = {
    copies: { clean: clean.files.length, loose: loose.files.length, bypass: bypass.files.length },
    mutations: [mut1, mut2],
    clean: { archive: cleanV.archive.length, commit: cleanV.commit.length, half: cleanV.half.length },
    loose: { archive: looseV.archive.length, first: looseV.archive.slice(0, 2) },
    bypass: { commit: bypassV.commit.length, half: bypassV.half.length, first: [...bypassV.commit, ...bypassV.half].slice(0, 2) },
  }

  eq(cleanV.archive.length, 0, `A07 · 干净副本的归档判据必须绿（实得 ${cleanV.archive.slice(0, 2).join(' | ')}）`)
  eq(cleanV.commit.length, 0, `A07 · 干净副本的 A01 判据必须绿（实得 ${cleanV.commit.slice(0, 2).join(' | ')}）`)
  eq(cleanV.half.length, 0, `A07 · 干净副本的 A02 判据必须绿（实得 ${cleanV.half.slice(0, 2).join(' | ')}）`)
  assert(looseV.archive.length > 0, 'A07 · 变异 ①（每一行都算已答）之后 A05 判据必须红 —— 否则那条判据是空转的')
  assert(bypassV.commit.length > 0 || bypassV.half.length > 0,
    'A07 · 变异 ②（绕过事务、两段直接写）之后 A01/A02 判据必须红 —— 否则提交边界的判据是空转的')
  // 变异只发生在 E:\Temp 副本：干净副本必须与仓内内核逐字节相同
  eq(sha256(fs.readFileSync(path.join(REPO, ...KERNEL.split('/')))), sha256(fs.readFileSync(path.join(clean.root, ...KERNEL.split('/')))),
    'A07 · 干净副本必须与仓内内核逐字节相同')
  eq(sha256(fs.readFileSync(path.join(REPO, ...KERNEL.split('/')))), ANCHORS.at.get(KERNEL),
    'A07 · 变异跑完之后仓内内核的字节必须与本次进程开始时一致')
}

async function A08() {
  const facts = []
  /* ① 文件存在性 + 导出面（内核与五个落点） */
  for (const p of [KERNEL, ...Object.values(HOST), 'test/audit/U14.mjs', 'docs/unify/receipts/U14.json']) {
    assert(fs.existsSync(path.join(REPO, p)), `A08 · 交付物不见了：${p}`)
  }
  const km = kernel()
  for (const name of ['planRecordAppend', 'applyRecordAppend', 'appendRecord', 'appendAskRecord', 'appendNoteRecord', 'appendAnswerEntry',
    'readRecordLedger', 'answeredIds', 'archiveAnswered', 'classifyCourseRef', 'classifyNoteAnchor', 'buildAnswerEntry',
    'serializeLedgerEntry', 'insertEntry', 'emptyLedgerSource', 'LEDGER_ANCHOR', 'LEDGER_MARKER', 'isPageAnchor', 'pageAnchorOf',
    'nextSeq', 'formatId', 'readSequence', 'splitAnswered']) {
    assert(km[name] !== undefined, `A08 · 内核缺导出 ${name}`)
  }
  const kernelSrc = readText(path.join(REPO, KERNEL))
  const kernelNoComments = stripComments(kernelSrc)
  for (const token of ['planCommit(', 'applyCommit(', 'identity.parseLessonKey(', 'identity.parsePointKey(', 'readLedger(', 'PAGE_ANCHOR_RE']) {
    assert(kernelNoComments.includes(token), `A08 · 内核里找不到 ${JSON.stringify(token)} —— 反空转检查失败（相关判据就成了恒真）`)
  }
  assert(!/^export\s/m.test(kernelSrc) && !/^import\s/m.test(kernelSrc), 'A08 · 内核必须是 CJS（不许 ESM 语法）')
  assert(!/migration\.cjs/.test(kernelNoComments), 'A08 · 运行态内核不许 require 迁移模块（历史解码只归 migration.cjs）')
  assert(!/new Date\(|Date\.now\(|Math\.random\(|process\.env/.test(kernelNoComments), 'A08 · 内核不许看时钟 / 用随机数 / 读环境变量')
  // 五个宿主都真的委托了内核（不许留着第二份记录构建）
  for (const [key, p] of Object.entries(HOST)) {
    const src = stripComments(readText(path.join(REPO, p)))
    const token = key === 'drain' ? "require('./unify/records.cjs')" : "requireCJS('./unify/records.cjs')"
    assert(src.includes(token), `A08 · ${p} 没有委托 records 内核（找不到 ${token}）`)
    for (const killer of ['appendFileSync(', 'ftruncateSync(']) {
      assert(!src.includes(killer), `A08 · ${p} 里还有绕过提交边界的 ${killer} 写路径`)
    }
  }
  // 记录层不再自己写权威目标 / 自己开事务（回滚只归事务件）
  // ⚠️ `verifyOrRollback` 是**既有导出的兼容哨兵**（保留其原有"自检不过就原文还原"行为，
  //    它是被注入 load 的测试钩子，不在生产写路径上），所以只核它**之前**的写路径。
  for (const [key, p] of Object.entries(HOST)) {
    const src = stripComments(readText(path.join(REPO, p)))
    if (key !== 'drain') {
      const writePath = src.split('export function verifyOrRollback')[0]
      assert(!/writeFileSync\(\s*(abs|absRoot|notesAbs|ledgerAbs)/.test(writePath), `A08 · ${p} 还在自己写权威目标`)
      assert(!/withPackTransaction\(\s*(abs|absRoot|path\.resolve)/.test(writePath), `A08 · ${p} 还在自己直接开事务（提交边界没收到 records）`)
    }
  }
  // 导出面与 HEAD 逐字相同（ask / ask-io / notes-io / adjust-io）
  {
    const exportsOf = (src) => [...src.matchAll(/export\s+(?:async\s+)?(?:const|function)\s+(\w+)/g)].map((m) => m[1]).sort()
    for (const p of [HOST.ask, HOST.askIo, HOST.notesIo, HOST.adjustIo]) {
      const head = gitHeadBytes(p)
      assert(head !== null, `A08 · git HEAD 里没有 ${p}`)
      sameJson(exportsOf(readText(path.join(REPO, p))), exportsOf(head.toString('utf8')), `A08 · ${p} 的导出面必须与 HEAD 逐字相同`)
    }
    const curAsk = readText(path.join(REPO, HOST.ask))
    assert(curAsk.includes('export const LEDGER_ANCHOR = RECORDS.LEDGER_ANCHOR'), 'A08 · LEDGER_ANCHOR 必须从内核取（不许再写一份字面量）')
    const headAsk = gitHeadBytes(HOST.ask).toString('utf8')
    assert(headAsk.includes("export const LEDGER_ANCHOR = '\\n  };\\n});'"), 'A08 · HEAD 的 LEDGER_ANCHOR 字面量形状变了（对拍前提失效）')
  }
  // 包侧 drain 的导出面与 HEAD 相同
  {
    const head = (gitHeadBytes(HOST.drain) || Buffer.from('')).toString('utf8')
    const cur = readText(path.join(REPO, HOST.drain))
    const modsOf = (src) => [...src.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, ' ')).join('|')
    eq(modsOf(cur), modsOf(head), 'A08 · 包侧 drain 的模块导出面必须与 HEAD 相同')
  }

  /* ② 旧实现对拍：纯函数层与新实现逐字一致（记录形状 / 台账条目 / 空台账 / 插入 / 拒绝文案） */
  {
    const oldDir = path.join(RUN_TEMP, 'old-ask')
    fs.mkdirSync(oldDir, { recursive: true })
    const headAsk = gitHeadBytes(HOST.ask)
    assert(headAsk !== null, 'A08 · git HEAD 里没有 lib/ask.js')
    fs.writeFileSync(path.join(oldDir, 'ask.js'), headAsk)
    fs.writeFileSync(path.join(oldDir, 'package.json'), '{"type":"module"}\n', 'utf8')
    const oldAsk = await import(pathToFileURL(path.join(oldDir, 'ask.js')).href)
    const newAsk = await import(pathToFileURL(path.join(REPO, HOST.ask)).href)
    const clock = () => '2026-10-20T00:00:00.000Z'
    const payloads = [
      { question: RICH_TEXT, lesson: 'programming/vue/0001', page: 'lessons/programming/vue/0001-a.html', title: '标题' },
      { question: '  ', lesson: '', page: '', title: '' },
      { question: 'x'.repeat(5000), lesson: 'l'.repeat(80) },
    ]
    for (const p of payloads) {
      sameJson(newAsk.serializeRecord(p, '0007', clock), oldAsk.serializeRecord(p, '0007', clock), `A08 · serializeRecord 必须与 HEAD 逐字节等价（${JSON.stringify(p).slice(0, 40)}）`)
    }
    const entries = [
      { id: '0001', date: null, lesson: '第1课', question: RICH_TEXT, page: 'reference/NOTES.html', anchor: 'q0001', section: '第1课 答疑', answer: '解答\n第二行', answerHtml: '<p>解答</p>' },
      { id: '0002', date: '2026-10-20', lesson: '第2课', question: 'q', page: 'reference/NOTES.html', anchor: 'q0002', section: '答疑', answer: 'a', answerHtml: '<p>a</p>' },
    ]
    for (const e of entries) {
      eq(newAsk.serializeLedgerEntry(e), oldAsk.serializeLedgerEntry(e), `A08 · serializeLedgerEntry 必须与 HEAD 逐字节相同（${e.id}）`)
      eq(newAsk.serializeLedgerEntry(e, '  '), oldAsk.serializeLedgerEntry(e, '  '), `A08 · serializeLedgerEntry 的缩进参数必须与 HEAD 同效（${e.id}）`)
    }
    eq(newAsk.LEDGER_ANCHOR, oldAsk.LEDGER_ANCHOR, 'A08 · LEDGER_ANCHOR 值必须与 HEAD 相同')
    eq(newAsk.LEDGER_MARKER, oldAsk.LEDGER_MARKER, 'A08 · LEDGER_MARKER 值必须与 HEAD 相同')
    for (const head of ['/** 头注释 */\n', '']) {
      eq(newAsk.emptyLedgerSource(head), oldAsk.emptyLedgerSource(head), 'A08 · emptyLedgerSource 必须与 HEAD 逐字节相同')
    }
    const baseLedger = oldAsk.emptyLedgerSource('/** h */\n')
    const block = newAsk.serializeLedgerEntry(entries[0])
    eq(newAsk.insertLedgerEntry(baseLedger, '0001', block), oldAsk.insertLedgerEntry(baseLedger, '0001', block), 'A08 · insertLedgerEntry 必须与 HEAD 逐字节相同')
    const ins = oldAsk.insertLedgerEntry(baseLedger, '0001', block)
    for (const [src, key, why] of [[baseLedger + 'x\n', '0001', '锚点出现两次'], [ins, '0001', '键已存在']]) {
      let a = null
      let b = null
      try { oldAsk.insertLedgerEntry(src, key, block) } catch (e) { a = e.message }
      try { newAsk.insertLedgerEntry(src, key, block) } catch (e) { b = e.message }
      eq(b, a, `A08 · insertLedgerEntry 的拒绝文案必须与 HEAD 相同（${why}）`)
    }
  }

  /* ③ 【A 授权面本体】旧形状拒绝 / 跨圈歧义拒绝 / U05 真迁移后回读 + 追加 */
  {
    const index = {
      byKey: {
        'programming/vue/0001': { label: '第1课' },
        'programming/react/0001': { label: '第1课' },
        'a/x/0001': { label: '第1课' },
        'b/x/0001': { label: '第1课' },
      },
    }
    const cat = km.buildCatalogue(index)
    // 旧形状：裸点 / 显示名 / 1–5 位课号 / 两段课键 —— 运行态一律拒，只给修法（迁移工具）
    const oldShapes = [
      ['vue', 'MIGRATION_REQUIRED', 'bare-point'],
      ['第1课', 'MIGRATION_REQUIRED', 'display-name'],
      ['programming/vue/1', 'MIGRATION_REQUIRED', 'lesson-width'],
      ['programming/vue/00001', 'MIGRATION_REQUIRED', 'lesson-width'],
      ['vue/0001', 'MIGRATION_REQUIRED', 'point-lesson'],
    ]
    const rows = []
    for (const [ref, code, reason] of oldShapes) {
      const got = km.classifyCourseRef(ref, { catalogue: cat })
      rows.push({ ref, ok: got.ok, code: got.code, reason: got.reason })
      eq(got.ok, false, `A08 · 旧形状 ${JSON.stringify(ref)} 必须被拒（运行态不隐式归一）`)
      eq(got.code, code, `A08 · 旧形状 ${JSON.stringify(ref)} 的拒绝码应为 ${code}`)
      eq(got.reason, reason, `A08 · 旧形状 ${JSON.stringify(ref)} 的 reason 应为 ${reason}`)
      if (code === 'MIGRATION_REQUIRED') assert(/migrate-pack|迁移/.test(got.error), `A08 · ${ref} 的拒绝理由必须点名修法（显式迁移）`)
    }
    DETAIL.A08OldShapes = rows
    // 歧义：裸 x 在两圈都有
    const amb = km.classifyCourseRef('x', { catalogue: cat })
    eq(amb.ok, false, 'A08 · 跨圈同名裸点必须被拒')
    eq(amb.code, 'ID_AMBIGUOUS', 'A08 · 歧义的码应为 ID_AMBIGUOUS')
    sameJson(amb.candidates, ['a/x', 'b/x'], 'A08 · 歧义拒绝必须列两个候选')

    // 严格面拒写时零事务、零字节
    {
      const root = path.join(RUN_TEMP, 'a08-strict', crypto.randomBytes(3).toString('hex'))
      fs.mkdirSync(path.join(root, 'learning-records'), { recursive: true })
      writeLines(root, 'learning-records/adjustments.jsonl', [JSON.stringify({ lesson: 'vue/0001', title: '第1课', adjust: '旧形状', lit: true, gaps: [] })])
      const before = readOrNull(path.join(root, 'learning-records/adjustments.jsonl'))
      const probe = countingTxn(transaction())
      const refused = km.appendRecord('adjust', root, ({ beforeText }) => {
        const got = km.classifyCourseRef('vue/0001')
        if (!got.ok) throw new Error(`课程引用不合法：${got.error}`)
        return { content: `${beforeText}{}\n` }
      }, { transaction: probe })
      eq(refused.ok, false, 'A08 · 旧形状的写入必须被拒')
      eq(probe.calls, 0, 'A08 · 旧形状的拒绝必须在碰事务之前')
      eq(readOrNull(path.join(root, 'learning-records/adjustments.jsonl')), before, 'A08 · 被拒的旧形状写入一个字节都不许动')
    }

    // U05 真迁移：调整台账的 lesson 是 `point/课号`（旧形状）→ CLI plan → apply → 回读 + 追加
    {
      const root = makePack('a08-migrate', [{ id: 'programming', points: ['vue', 'react'] }])
      // EXPECT 的 `lessons[].id` 是**声明形状** `point/NNNN`（圆圈由 lessons/<circle>/<point>/ 目录派生；
      // 见 authorization.json 的 derivedConsequences.C6）—— 迁移夹具必须按这个形状写
      fs.writeFileSync(path.join(root, 'code', 'proj', 'EXPECT.json'), `${JSON.stringify({
        lessons: [{ id: 'vue/0001', title: '第1课' }, { id: 'react/0001', title: '第1课' }],
      }, null, 2)}\n`, 'utf8')
      const oldLines = [
        JSON.stringify({ ts: 't1', lesson: 'vue/0001', title: '第1课', adjust: '第一行正文', lit: true, gaps: [] }),
        JSON.stringify({ ts: 't2', lesson: 'react/0001', title: '第1课', adjust: '第二行正文', lit: false, gaps: ['卡在分层'] }),
      ]
      const adjFile = writeLines(root, 'learning-records/adjustments.jsonl', oldLines)
      const beforeText = readText(adjFile)
      const planRun = runCli([path.join(REPO, 'tools', 'migrate-pack.mjs'), `--root=${root}`, '--plan'])
      eq(planRun.status, 0, `A08 · U05 的 --plan 必须 exit 0（stdout=${planRun.stdout.trim()} stderr=${planRun.stderr.trim()}）`)
      const m = /^PLAN ok=true digest=([0-9a-f]{64}) files=\d+ changes=(\d+) blocks=0$/m.exec(planRun.stdout.trim())
      assert(m, `A08 · --plan 的输出不符合契约（实得 ${JSON.stringify(planRun.stdout.trim())}）`)
      assert(Number(m[2]) >= 2, `A08 · 计划至少要改 2 处身份（实得 ${m[2]}）`)
      eq(readText(adjFile), beforeText, 'A08 · --plan 必须零写（台账逐字节未变）')
      const applyRun = runCli([path.join(REPO, 'tools', 'migrate-pack.mjs'), `--root=${root}`, '--apply', '--confirm', `--plan-digest=${m[1]}`])
      eq(applyRun.status, 0, `A08 · U05 的 --apply 必须 exit 0（stdout=${applyRun.stdout.trim()} stderr=${applyRun.stderr.trim()}）`)
      assert(/^APPLY ok=true digest=[0-9a-f]{64} replaced=\d+ backup=\S+$/m.test(applyRun.stdout.trim()),
        `A08 · --apply 的输出不符合契约（实得 ${JSON.stringify(applyRun.stdout.trim())}）`)
      // 迁移只改身份字面量：逆替换必须逐字回到迁移前（正文 / 键序 / 日期全保留）
      const afterText = readText(adjFile)
      const inverse = afterText
        .split('"lesson":"programming/vue/0001"').join('"lesson":"vue/0001"')
        .split('"lesson":"programming/react/0001"').join('"lesson":"react/0001"')
      eq(inverse, beforeText, 'A08 · 迁移只许改身份：逆替换回去必须与迁移前逐字节相同')
      // 迁移后：本卡内核可读、可追加，且新写入用规范身份
      const read = km.readRecordLedger('adjust', root)
      eq(read.status, 'ok', `A08 · 迁移后调整台账必须是 ok（实得 ${read.status}）`)
      sameJson(read.entries.map((e) => e.lesson).sort(), ['programming/react/0001', 'programming/vue/0001'], 'A08 · 迁移后 lesson 必须是规范身份')
      const probe = countingTxn(transaction())
      const wrote = km.appendAdjustRecord(root, { lesson: 'programming/vue/0001', title: '第2课', adjust: '迁移后追加', lit: true, gaps: [] }, { transaction: probe })
      eq(wrote.ok, true, `A08 · 迁移后必须能追加（${wrote.error || ''}）`)
      eq(probe.calls, 1, 'A08 · 迁移后的追加恰好进一次事务')
      const rowsOut = readText(adjFile).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      eq(rowsOut.length, 3, 'A08 · 追加后台账应有 3 行')
      eq(rowsOut[2].lesson, 'programming/vue/0001', 'A08 · 新写入的 lesson 是规范身份')
      eq(rowsOut[0].adjust, '第一行正文', 'A08 · 迁移前的正文逐字保留')
      DETAIL.A08Migration = { plan: planRun.stdout.trim(), apply: applyRun.stdout.trim(), rows: rowsOut.length }
    }
  }

  /* ④ 交付物内容锁 */
  const lock = recordContentLock()
  eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
  const lockNow = verifyContentLock()
  eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)
  for (const p of [KERNEL, ...Object.values(HOST), 'test/audit/U14.mjs']) {
    facts.push({ path: p, nowSha16: sha256(fs.readFileSync(path.join(REPO, p))).slice(0, 16) })
  }

  /* ⑤ **未改 `test/mirror-parity.mjs`** 的机器证明（§12 A 把它唯一给了 U09） */
  {
    const abs = path.join(REPO, U09_A_FACE)
    const nowSha = sha256(fs.readFileSync(abs))
    const atStart = ANCHORS.at.get(U09_A_FACE)
    const touched = WRITE_GUARD.writes.filter((w) => w.target === path.resolve(abs))
    DETAIL.U09Face = { sha16: nowSha.slice(0, 16), atStart16: String(atStart || '').slice(0, 16), writesByThisRun: touched.length }
    eq(touched.length, 0, 'A08 · 本卡进程**一次都不许写** test/mirror-parity.mjs（§12 A 唯一归 U09）')
    eq(nowSha, atStart, 'A08 · test/mirror-parity.mjs 在本次运行期间必须一个字节都没变（它唯一归 U09）')
    assert(!WRITE_SET.includes(U09_A_FACE), 'A08 · test/mirror-parity.mjs 不许出现在 U14 写集里')
    const src = readText(abs)
    assert(/a\.anchor/.test(src) && /b\.anchor/.test(src), 'A08 · （定位）mirror-parity 的身份锚点断言仍在原处 —— 那是 U09 的 A 面')
  }

  /* ⑥ 临时目录归属 + 清理守卫（先做一次受守卫的删除，让写记录里真的出现 rm） */
  {
    const scratch = path.join(RUN_TEMP, 'guard-scratch')
    fs.mkdirSync(scratch, { recursive: true })
    fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
    const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
    eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
    eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')
  }
  eq(guardTempPath(RUN_TEMP, { parent: TEMP_PARENT }).ok, true, 'A08 · 本次临时根必须归 E:\\Temp')
  assert(/^u14-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u14-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')

  /* ⑦ 进程内 fs 写守卫 */
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
  for (const op of ['mkdir', 'write', 'copy', 'rm', 'rename']) assert(guard.ops.includes(op), `A08 · 写记录里没有 ${op} 这一类的写`)
  const wProof = proveWriteScope()
  eq(wProof.failures.length, 0, `A08 · 写允许面的纯函数自证失败：${wProof.failures.map((f) => `${f.path} → ${f.got}（期望 ${f.expect}）`).join(', ')}`)

  /* ⑧ 授权写集并集 = §6 ∪ §12 A（两处都**现场解析**，不硬编码） */
  const lockText = readText(path.join(REPO, 'docs', 'unify', 'interfaces.md'))
  const s6 = parseSection6(lockText)
  eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
  sameJson([...s6.get(CARD)].sort(), [...SECTION6_SET].sort(), 'A08 · §6 里 U14 的落点必须逐条等于本卡的 8 项')
  assert(!s6.get(CARD).includes(U09_A_FACE), 'A08 · §6 的 U14 落点本来就不含 mirror-parity（它只由 §12 A 授权给 U09）')
  const authDoc = JSON.parse(readText(path.join(REPO, 'docs', 'unify', 'authorization.json')))
  eq(authDoc.quoteVerbatim, '选A和授权p1和p2', 'A08 · 人类授权的原文必须就是这句（逐字）')
  const auth = authorizationExtras(authDoc)
  assert(auth.extras.has('U09') && auth.extras.get('U09').includes(U09_A_FACE), 'A08 · authorization.json 里找不到"U09 独占 test/mirror-parity.mjs"这条授权')
  assert(auth.extras.has('U09') && auth.extras.get('U09').includes('lib/point-ref.js'), 'A08 · C4 追加给 U09 的 lib/point-ref.js 没解析出来')
  assert(auth.extras.has('U10') && auth.extras.get('U10').includes('test/intake.mjs'), 'A08 · authorization.json 里找不到"U10 独占 test/intake.mjs"这条授权')
  const u14Extras = auth.extras.get('U14') || []
  assert(!u14Extras.includes(U09_A_FACE), 'A08 · §12 A 给 U14 的授权面里**不得**出现 mirror-parity（那是 U09 的）')
  const union = authorizedUnion(s6, auth.extras)
  const owners = pathOwners(s6, auth.extras)
  const porcelain = spawnSync('git', ['-C', REPO, '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', timeout: 60000 })
  assert(porcelain.status === 0, `A08 · git status 失败：${(porcelain.stderr || '').trim()}`)
  const { tracked, untracked } = splitPorcelainTracked(String(porcelain.stdout).split('\n').filter((l) => l.trim()))
  const scopeCheck = classifyTrackedWrites(tracked, union)
  eq(scopeCheck.outOfBounds.length, 0,
    `A08 · tracked 改动越出授权并集（§6 ∪ §12 A）：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
  for (const f of CHANGED_FILES) assert(tracked.some((t) => t.path === f), `A08 · tracked 改动里找不到本卡改过的 ${f}`)
  const sProof = proveScopeBoundary(s6, auth.extras)
  eq(sProof.failures.length, 0, `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

  /* ⑨ 【判据 4/4】**不统计他卡的文件数/字节数**：只做归属守卫。
     第一层只允许：U 卡编号目录 + 既有 T23 + **真实存在的 T 卡**（`test/audit/T<NN>.mjs` 在盘上 ——
     决-1/决-5/决-6/决-9/P2 之后 T 卡由别的卡合法运行）。**不是**"T 一律放行"。 */
  const evDirs = fs.readdirSync(path.join(REPO, 'audit-evidence')).sort()
  const isRealT = (d) => /^T\d{2}$/.test(d) && fs.existsSync(path.join(REPO, 'test', 'audit', `${d}.mjs`))
  const unexpectedOf = (list) => list.filter((d) => !/^U\d{2}$/.test(d) && d !== 'T23' && !isRealT(d))
  const evUnexpected = unexpectedOf(evDirs)
  eq(evUnexpected.length, 0, `A08 · audit-evidence 第一层出现了无人认领的证据目录：${evUnexpected.join(', ')}`)
  // 反空转：既不在册、也没有对应 T 卡入口的名字必须被这条判据抓住。
  sameJson(unexpectedOf(['U01', 'T23', 'T01', 'TXX-nobody']), ['TXX-nobody'],
    'A08 · 反空转：无人认领的证据目录必须被判出来（真实存在的 T 卡放行，别的仍红）')
  for (const d of ['U01', 'T23']) assert(evDirs.includes(d), `A08 · 既有证据目录不见了：${d}`)

  /* ⑩ `--evidence-root` 守卫 + 读取根恒定 */
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U14/runs/U14-<pid>')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true, 'A08 · E:\\Temp 下带 U14- 前缀的新目录必须被接受')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
  eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')

  /* ⑪ tracked 回执：五项齐 + 授权逐字引用 + 真实写集 / Δ / 未验证边界对得上 */
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
  eq(rc.authorization.quoteVerbatim, authDoc.quoteVerbatim, 'A08 · 回执必须逐字引用 quoteVerbatim')
  eq(rc.authorization.quoteSource, authDoc.quoteSource, 'A08 · 回执必须逐字引用 quoteSource')
  assert(String(rc.authorization.statement).includes('本卡只按 scope.A 执行'), 'A08 · 回执必须写明「本卡只按 scope.A 执行」')
  assert(String(rc.authorization.statement).includes('未改 test/mirror-parity.mjs'), 'A08 · 回执必须写明「未改 test/mirror-parity.mjs」')
  assert(rc.blockedHistory && rc.blockedHistory.priorStatus === 'BLOCKED' && rc.blockedHistory.releasedBy === authDoc.quoteVerbatim,
    'A08 · 回执必须保留"曾 BLOCKED、现由人类 A 授权解除"的追溯（releasedBy 逐字引用授权）')
  for (const id of FIXED_IDS) assert(rc.assertions && rc.assertions[id], `A08 · 回执必须逐项写清 ${id} 的断言内容`)
  assert(rc.deltas.length >= 4, `A08 · 回执必须逐条登记真实 Δ（实得 ${rc.deltas.length} 条）`)
  const kinds = new Set(rc.deltas.map((d) => d && d.kind))
  for (const k of ['behavior-tightening', 'delegation', 'identity-separation']) {
    assert(kinds.has(k), `A08 · 回执的 Δ 里缺 ${k} 这一类`)
  }
  assert(rc.unverified.some((u) => /R1/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 R1（包侧 unify 副本）')
  assert(rc.unverified.some((u) => /U18/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 U18（两侧最终对拍）')
  assert(rc.unverified.some((u) => /U17/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 U17（迁移后产品全链路）')
  assert(rc.unverified.some((u) => /mirror-parity/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 mirror-parity 未跑')
  for (const dep of ['U02', 'U03', 'U05', 'U06', 'U10']) {
    assert(rc.dependencies && rc.dependencies.status && rc.dependencies.status[dep], `A08 · 回执的依赖摘要里缺 ${dep}`)
  }

  DETAIL.comparisons = {
    anchors: ANCHORS.at.size,
    writeSetFacts: facts,
    writeGuard: {
      installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount, ops: guard.ops,
      probe: guard.probe, violations: guard.violations, proof: wProof.rows,
    },
    authorizedUnion: {
      cards: s6.size, paths: union.size,
      authorization: auth.citations,
      trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) || [] })),
      untrackedCount: untracked.length,
      outOfBounds: scopeCheck.outOfBounds,
      proof: sProof.rows,
    },
    contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
    evidenceTopLevel: evDirs,
    receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length },
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
  { id: 'A05', run: A05, timeoutMs: 240000 },
  { id: 'A06', run: A06, timeoutMs: 120000 },
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
    fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
  }
  process.exitCode = printVerdict(verdict)
}
