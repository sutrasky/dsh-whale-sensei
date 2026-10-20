/**
 * test/audit/U18.mjs —— 证据、状态与门禁的统一专项判据（B lane · U18）
 * ======================================================================
 * 判的是这一件事：**证据档位 / 台账五态 / 缺证据失败关闭只有一份实现**
 * （`lib/unify/evidence.cjs`），宿主侧（`lib/state.js` 的快照判定、`lib/gate.js` 的门禁）
 * 与包侧（`tools/ask-server.js` 的点亮判定）都只是它的适配者；跨圈同名课程的判据与证据
 * **不许互相顶替**，损坏 / 读不动的台账**不许**靠旧快照继续点亮，而 `missing` 这条既有的
 * 防死锁回退**一个态都不许扩大**；模板 `ask-server` 的普通记录写口接到 U14 的
 * `records.cjs` + U06 的 `commit.cjs`，宿主与包侧**共用一本台账与一个计数器**。
 *
 *   A01 跨圈同名课程判据与证据不串 —— `a/x` 与 `b/x` 各自只能拿自己的判据/证据判：
 *       证据台账键解析（2 段写法只在唯一归属时可接受）、快照里同一门课的两种课次形状
 *       （声明 `point/NNNN` ↔ 规范 `circle/point/NNNN`）能对上、**快照按实践区收窄**、
 *       `previousLesson` 按 circle+point 两段筛；裸点跨圈同名 ⇒ 门禁 fail-closed（`ambiguous-point`）。
 *       与 HEAD 旧树对拍：旧 `previousLesson` 只按裸点筛（`previousLesson('x')` 会拿到 b 圈的课，
 *       `previousLesson('a/x')` 反而看不见 a 自己的课）—— 这正是本卡收掉的降维。
 *   A02 五态完整传播 —— `missing/empty/ok/invalid/io-error` 逐态从 `readEvidence` 一直传到
 *       快照的 `lessons[].evidenceStatus` 与门禁判词，**io-error 不被折成 empty**（错误码保留、
 *       `exists:true`、措辞不同）；`ledgerStatusOf` 对旧字段形状也归一出同一套五态。
 *   A03 损坏账本不能通过旧快照继续点亮 —— 快照在台账还好的时候写成（`evidence.ok:true`），
 *       之后台账坏掉 / 读不动 / 变空：插件门禁与包侧 `/progress` **两侧都**拦证据不够，且
 *       进度里**不会**多出那门课（旧快照的判词作废，不点亮）。
 *   A04 真正缺失的既有业务回退策略不被扩大 —— 只有 `missing`（真 ENOENT）回退，且必须
 *       `evidenceFallback:true` 说出来；`empty/invalid/io-error` 一个都不回退（逐态断言）。
 *   A05 空证据与 IO 故障分别给出明确结果 —— 空账（存在零条）说"空账是明确不足"、写口仍可追加；
 *       IO 故障（目录 / EACCES）说"读不动（码）"、写口拒绝且台账字节不动 —— 两种病两句修法。
 *   A06 宿主与包侧判定一致 + 记录写口共用提交 —— 五态下插件 `challengeGate` 与包侧
 *       `POST /progress` 的 `code`/`hint` 逐字相同；模板 `ask-server` 的 `/ask`、`/note`
 *       经 `tools/unify/records.cjs`（+ `./unify/commit.cjs`）提交，与宿主 `lib/ask-io.js` /
 *       `lib/notes-io.js` **共用一本台账与一个计数器**（编号接着发，不重发）；
 *       并把副本里的 `commit.cjs` 打坏 ⇒ 写口必须失败且一个字节不落（证明提交真的经过 U06）。
 *   A07 临时让包侧只信旧快照后判据必须红 —— 只在 E:\Temp 副本里把 `ask-server` 的现读复核
 *       短路掉：同一夹具下它必须回 ok 并点亮（红），干净副本必须拦住；仓内字节零变化。
 *   A08 进程内零写探针 / 旧断言冲突 / 证据守卫有效 —— fs 写守卫（探针写自证）、依赖自锚、
 *       交付物内容锁、§6 现场解析的写集并集与 tracked 越界检查、既有测试**零改动**的冲突闸、
 *       `--evidence-root` 守卫、临时目录归属清理、tracked 回执五项 + 写集 sha + Δ 登记；
 *       **跨卡归属锚**（原「兄弟卡的文件必须与 HEAD 逐字节相同」= 结构性假红，已改成三条：
 *       运行期自锚 + §6 运行时归属（有主只登记 / 无主红）+ 本进程写过就红）。
 *
 * 判词**只有一行**（unify-runner.printVerdict）：
 *   `PASS U18 checks=8 failed=0 skipped=0` → exit 0 ／ `FAIL U18 …` → 1 ／ `BLOCKED U18 …` → 2
 *
 * 不跑任何既有套件（那是 U20 的活）、不访问/不写活包、不做任何 git 写、不改任何 T 证据。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  runCard,
  FIXED_IDS,
  printVerdict,
  writeRunEvidence,
  resolveEvidenceRoot,
  safeRemoveTree,
  guardTempPath,
} from './unify-runner.mjs'

const CARD = 'U18'
const SELF = fileURLToPath(import.meta.url)
const HERE = path.dirname(SELF)
const REPO = path.resolve(HERE, '..', '..')
const ARGV = process.argv.slice(2)
const require_ = createRequire(import.meta.url)

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

/* ══════════════════════════════════════════════════════════════════════
 * 落点与写集（`docs/unify/interfaces.md` §6 的 U18 行 = 9 项）
 * ══════════════════════════════════════════════════════════════════════ */

/** 证据 / 五态 / 失败关闭的**唯一实现**（新增设计 †） */
const KERNEL = 'lib/unify/evidence.cjs'

/** 本卡改的既有落点（导出面 / 参数 / 默认值 / 返回形状逐字保留；只改内部委托） */
const HOST = Object.freeze({
  evidence: 'lib/evidence.js',
  evidenceIo: 'lib/evidence-io.js',
  state: 'lib/state.js',
  stateScan: 'lib/state-scan.js',
  gate: 'lib/gate.js',
  askServer: 'lib/pack-template/tools/ask-server.js',
})

/** `mods/author.js` 里那一行 `challengeGate({ root, pack, point: args.point, probe: false })` 的宿主 */
const AUTHOR_MOD = 'lib/mods/author.js'
/** T03 用**源码字面量**钉死上面那一行；本卡不许改它、也不许改 T03 */
const T03 = 'test/audit/T03.mjs'
/** U09 的 A 面（本卡一次都不许写） */
const U09_A_FACE = 'test/mirror-parity.mjs'

/** interfaces.md §6 里 U18 的落点（= 卡面写集里不是证据目录的那 9 项） */
const SECTION6_SET = Object.freeze([
  KERNEL,
  HOST.evidence,
  HOST.evidenceIo,
  HOST.state,
  HOST.stateScan,
  HOST.gate,
  HOST.askServer,
  'test/audit/U18.mjs',
  'docs/unify/receipts/U18.json',
])

/** 卡面精确写集：§6 的 9 项（证据目录按目录前缀放行，见 writeAllowScope） */
const WRITE_SET = Object.freeze([...SECTION6_SET])

/** 改前就存在、本卡改过的五个文件（其余是被新建的） */
const CHANGED_FILES = Object.freeze([HOST.evidence, HOST.evidenceIo, HOST.state, HOST.gate, HOST.askServer])

/** 新建的三个落点 */
const NEW_FILES = Object.freeze([KERNEL, 'test/audit/U18.mjs', 'docs/unify/receipts/U18.json'])

/**
 * 运行期**自锚**的依赖：本卡结论依赖它们。本次进程开始时记 sha256，收口前再比一次必须相同。
 * 其中 `test/mirror-parity.mjs`、`test/audit/T03.mjs`、`lib/mods/author.js`、`test/challenge-gate.mjs`、
 * `test/evidence.mjs` 是**反向锚**：它们必须在本进程运行期间一个字节都没变
 * （本卡没有改它们的授权；T03 的源码字面量还钉着 `mods/author.js` 的调用形状）。
 *
 * ⚠️ `docs/unify/interfaces.md` 与 `docs/unify/authorization.json` **不在这里**：它们是本卡
 * **读一次就判一次**的输入（§6 归属表 / §12 A 授权面），不是 A01–A07 跑起来的依赖 ——
 * 兄弟 lane 按自己的卡面更新 §6 行或授权面是**合法**的（U01 的 P1/P2 就改过 authorization.json），
 * 把它们钉成"整跑字节不变"只会在并发树上制造假红（本轮实测撞到过一次）。改见 SPEC_DOCS：
 * 一次读、按同一份快照判、把版本 sha 记进证据。
 */
const ANCHOR_FILES = Object.freeze([
  'lib/unify/identity.cjs',
  'lib/unify/errors.cjs',
  'lib/unify/ledger-read.cjs',
  'lib/unify/commit.cjs',
  'lib/unify/records.cjs',
  'lib/pack-template/tools/ledger-transaction.cjs',
  'lib/pack-model.js',
  'test/audit/unify-runner.mjs',
  KERNEL,
  U09_A_FACE,
  T03,
  AUTHOR_MOD,
  'test/challenge-gate.mjs',
  'test/evidence.mjs',
])

/** 本卡写集的期望导出面增量（多一个少一个都算接口漂） */
const EXPORT_DELTA = Object.freeze({
  'lib/evidence.js': Object.freeze({
    added: Object.freeze([
      'CANONICAL_LESSON_ID_RE', 'LEDGER_STATUSES', 'brokenWhyText', 'isBrokenStatus', 'judgeRequirement',
      'ledgerStatusOf', 'lessonAliases', 'liveLedgerVerdict', 'requiredEvidenceText', 'sameLesson',
    ]),
    removed: Object.freeze([]),
  }),
  [HOST.state]: Object.freeze({ added: Object.freeze(['lessonEvidenceKeys']), removed: Object.freeze([]) }),
  [HOST.evidenceIo]: Object.freeze({ added: Object.freeze([]), removed: Object.freeze([]) }),
  [HOST.stateScan]: Object.freeze({ added: Object.freeze([]), removed: Object.freeze([]) }),
  [HOST.gate]: Object.freeze({ added: Object.freeze([]), removed: Object.freeze([]) }),
})

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { temp: RUN_TEMP }

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')
const readOrNull = (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null)
const writeText = (abs, text) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
}
const writeJson = (abs, value) => writeText(abs, `${JSON.stringify(value, null, 2)}\n`)

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
function includes(haystack, needle, msg) {
  if (!String(haystack ?? '').includes(needle)) throw new Error(`${msg}（找不到 ${fmt(needle)}，实得 ${fmt(String(haystack ?? '').slice(0, 300))}）`)
}

/** 剥注释（源码层判据用；注释里的字样不算"实现"） */
function stripComments(src) {
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
function gitText(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || '').trim()}`)
  return String(r.stdout)
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U13/U14 同一套纪律；本文件独立实现）
 * ──────────────────────────────────────────────────────────────────────
 * 「一个工作树、多 lane 并发」下，拿"改前整树 ↔ 现在的树"做全量对拍会**结构性假红**。
 * 所以判据换成四条可归因口径：
 *   ① 进程内 fs 写守卫 —— 本卡**本次进程**的每一次写都必须落在
 *      { 写集 9 项 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 }，并用**探针写**自证；
 *   ② 授权写集并集（tracked 侧）—— tracked 改动必须 ⊆ §6 ∪ §12 A 授权面；
 *   ③ 本卡交付物内容锁 —— 9 个文件记录的 sha256 在本次运行结束时必须仍等于实际值；
 *   ④ **不统计他卡的文件数/字节数**；
 *   ⑤ 兄弟卡的文件不拿 HEAD 对拍 —— 改「运行期自锚 + §6 运行时归属 + 本进程零写」三条
 *      （见下面的 CROSS_CARD 一段；原「等于 HEAD」这件事本身就是假红源）。
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

/** 本卡本次的写允许面：写集 9 项的精确绝对路径 + { 本次临时根, 本卡证据根 } 两个目录前缀 */
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
function classifyWriteTarget(rawTarget, scope) {
  const s = scope ?? writeAllowScope()
  const abs = path.resolve(s.repoRoot ?? REPO, String(rawTarget))
  if (s.files.has(abs)) return { allowed: true, why: '本卡写集 9 项之一', abs }
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
function installWriteGuard(scope) {
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
function probeWriteGuard() {
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

function sweepWriteGuard() {
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

/** 写允许面的**纯函数自证**（正例/反例各几条；不读盘） */
function proveWriteScope() {
  const scope = writeAllowScope()
  const rows = []
  const check = (target, expect) => {
    const got = classifyWriteTarget(target, scope).allowed
    rows.push({ path: target, expect, got })
  }
  check(path.resolve(REPO, WRITE_SET[0]), true)
  for (const p of WRITE_SET) check(path.resolve(REPO, p), true)
  check(path.join(RUN_TEMP, 'x', 'y.txt'), true)
  if (evidenceGuard.ok) check(path.join(evidenceGuard.root, 'result.json'), true)
  check(path.resolve(REPO, 'lib', 'index.js'), false)
  check(path.resolve(REPO, 'test', 'all.mjs'), false)
  check('E:\\Temp\\someone-else-u99\\x.txt', false)
  check(path.resolve(REPO, 'docs', 'unify', 'interfaces.md'), false)
  const failures = rows.filter((r) => r.got !== r.expect)
  return { rows, failures }
}

/* ── 授权写集并集（tracked 侧：§6 ∪ §12 A 授权面） ─────────────────────── */

const SECTION6_TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const looksLikeRepoPath = (s) => SECTION6_TOKEN_RX.test(s) && (s.includes('/') || /\.[A-Za-z]{2,4}$/.test(s))

/** 把 §6 落点表解析成 `Map<卡号, 路径[]>`（纯函数；不 import 兄弟卡的常量） */
function parseSection6(text) {
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

/** §12 A 的授权面（只认 `authorization.json` 里逐字写明的路径，不扩写、不猜） */
function authorizationExtras(authDoc) {
  const extras = new Map()
  const citations = []
  const push = (card, path) => {
    if (!/^U\d\d$/.test(card) || !looksLikeRepoPath(path)) return
    if (!extras.has(card)) extras.set(card, [])
    if (!extras.get(card).includes(path)) extras.get(card).push(path)
  }
  const text = JSON.stringify(authDoc.scope ?? {})
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const ctx = text.slice(Math.max(0, m.index - 120), m.index)
    const card = /U\d\d/.exec(ctx)?.[0]
    if (card) push(card, m[1])
  }
  for (const m of text.matchAll(/\b(U\d\d)\b[^"`]{0,160}?((?:test|lib|tools|docs|cards)\/[A-Za-z0-9._/-]+)/g)) {
    push(m[1], m[2])
  }
  for (const item of Array.isArray(authDoc.derivedConsequences?.items) ? authDoc.derivedConsequences.items : []) {
    const blob = `${item?.what ?? ''} ${item?.evidence ?? ''} ${item?.decision ?? ''}`
    for (const m of blob.matchAll(/\b(U\d\d)\b/g)) {
      const card = m[1]
      const tail = blob.slice(m.index, m.index + 400)
      for (const p of tail.matchAll(/(?:test|lib|tools|docs|cards)\/[A-Za-z0-9._/-]+/g)) push(card, p[0])
    }
    citations.push(item?.id ?? '?')
  }
  return { extras, citations }
}

function authorizedUnion(section6, extras) {
  const union = new Set()
  for (const v of section6.values()) for (const p of v) union.add(p)
  for (const v of extras.values()) for (const p of v) union.add(p)
  return union
}
function pathOwners(section6, extras) {
  const owners = new Map()
  const add = (card, p) => {
    if (!owners.has(p)) owners.set(p, [])
    if (!owners.get(p).includes(card)) owners.get(p).push(card)
  }
  for (const [card, list] of section6) for (const p of list) add(card, p)
  for (const [card, list] of extras) for (const p of list) add(card, p)
  return owners
}

/** git status --porcelain 的行 → { tracked, untracked }（`??` 是未跟踪，其余是 tracked 改动） */
function splitPorcelainTracked(lines) {
  const tracked = []
  const untracked = []
  for (const line of lines) {
    if (!line || !line.trim()) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3).trim()
    if (code === '??') { untracked.push(rest); continue }
    if (code.includes('R') || code.includes('C')) {
      const [from, to] = rest.split(' -> ').map((s) => s.trim())
      tracked.push({ code, path: to, from })
      continue
    }
    tracked.push({ code, path: rest })
  }
  return { tracked, untracked }
}

function classifyTrackedWrites(tracked, union) {
  const inBounds = []
  const outOfBounds = []
  for (const t of tracked) {
    const okPath = union.has(t.path) && (!t.from || union.has(t.from))
    ;(okPath ? inBounds : outOfBounds).push(t)
  }
  return { inBounds, outOfBounds }
}

/* ── 依赖自锚 + 交付物内容锁 ─────────────────────────────────────────── */

const ANCHORS = { at: new Map(), closed: null }
function recordAnchors() {
  for (const p of ANCHOR_FILES) {
    const abs = path.join(REPO, ...p.split('/'))
    if (!fs.existsSync(abs)) continue
    ANCHORS.at.set(p, sha256(fs.readFileSync(abs)))
  }
  return ANCHORS
}function verifyAnchors() {
  const changed = []
  for (const [p, sha] of ANCHORS.at) {
    const abs = path.join(REPO, ...p.split('/'))
    const now = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null
    if (now !== sha) changed.push({ path: p, atStart: sha, now })
  }
  return { at: [...ANCHORS.at.keys()], changed }
}

/**
 * 交付物在**本进程开始时**的字节（运行期自锚的另一半）：`ANCHORS` 管依赖，
 * 这里管"本卡自己交付的 9 个文件"—— A07 的"仓内一个字节没动"与收口复核都用它。
 */
const BOOT_SHA = new Map()
function recordBootSha() {
  for (const p of WRITE_SET) {
    const abs = path.join(REPO, ...p.split('/'))
    if (fs.existsSync(abs)) BOOT_SHA.set(p, sha256(fs.readFileSync(abs)))
  }
  return BOOT_SHA
}
function verifyBootSha() {
  const changed = []
  for (const [p, sha] of BOOT_SHA) {
    const abs = path.join(REPO, ...p.split('/'))
    const now = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null
    if (now !== sha) changed.push({ path: p, atStart: sha, now })
  }
  return { at: [...BOOT_SHA.keys()], changed }
}

const CONTENT_LOCK = { hashes: new Map(), checks: 0 }
function recordContentLock() {
  for (const p of WRITE_SET) {
    const abs = path.join(REPO, ...p.split('/'))
    if (fs.existsSync(abs)) CONTENT_LOCK.hashes.set(p, sha256(fs.readFileSync(abs)))
  }
  return CONTENT_LOCK.hashes
}
function verifyContentLock() {
  const mismatches = []
  for (const [p, sha] of CONTENT_LOCK.hashes) {
    const abs = path.join(REPO, ...p.split('/'))
    const now = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null
    CONTENT_LOCK.checks += 1
    if (now !== sha) mismatches.push({ path: p, recorded: sha, now })
  }
  return { checks: CONTENT_LOCK.checks, mismatches }
}

/* ── 跨卡归属锚（A08 ⑦ 的三条判据） ────────────────────────────────── */

/**
 * 本卡**不许碰**、但可能由兄弟卡合法拥有的文件。
 *
 * 原判据是「必须与 HEAD 逐字节相同」。在"一个工作树、多 lane 并发"下那是**结构性假红**：
 * §6 把 `lib/mods/starter.js` 判给 U16，U16 按自己的卡面改它就是合法的，而 U18 的 A08 会把
 * 它读成"本卡越界"。所以换成三条（收掉的是假红，不是"不许碰"）：
 *
 *   ① **运行期自锚** —— 进程开始时记 sha256，A08 与收口各比一次：相同 ⇒ 这一跑没动过它。
 *   ② **归属按 §6 运行时解析**（不硬编码卡号）—— 运行期外已变（start ≠ HEAD）时看主人：
 *      有主 ⇒ **只登记 + 记主人，不红**；**无主 ⇒ 红**（没人授权这次改动）。
 *      运行期**内**变（start ≠ now）走同一条归属：写守卫沉默 ⇒ 不是本进程写的，但那也必须
 *      能归因（无主 / 主人里有本卡 ⇒ 红）。
 *   ③ **本进程零写** —— 写守卫的逐笔记录里出现它 ⇒ **红**（优先于 ②，有主也不放行）。
 *
 * 归属只认 `docs/unify/interfaces.md` §6；§12 A 面（既有测试契约的授权）不参与 ——
 * 所以"§6 里无主"一律红，这条不许用别处的授权抹平。
 *
 * ⚠️ 决-1/决-2（`docs/unify/authorization.json` 的 `decisions.approvedChanged`）把
 * `test/audit/T03.mjs` 里那一行源码字面量列入"必改"，它的落点**登记在 §6 的 U01 行**
 * （带「仅 decisions 决-1/决-2 授权面」限定语）。所以本卡在这里**不新建授权面**：归属仍只由 §6
 * 解析，另外加一条**只改一行**的源码锁（`judgeT03DecisionLine`）—— 归属 + 改动形状两道一起判。
 */
const CROSS_CARD_FILES = Object.freeze([T03, 'lib/mods/starter.js'])
const CROSS_CARD = { at: new Map() }

/**
 * 决-1/决-2 授权的 `test/audit/T03.mjs` 那**一行**：它用**源码字面量**钉住
 * `lib/mods/author.js` 里那次 `challengeGate({ ... })` 调用。
 *
 * ⚠️ 这里**不硬编码**新旧字面量（上一版硬编码了 `point: args.point` / `point: gatePoint` 两条，
 *    等于用测试去追实现：决-1 一落地就得回来改测试，而"改测试"本身又需要授权）。改成**运行时从
 *    两侧源码里读**：
 *      · 旧值 ← `git show HEAD:test/audit/T03.mjs`（基线字节，不可变）；
 *      · 新值 ← 盘上的 `test/audit/T03.mjs`；
 *      · 两者的形状逐条判：恰好一行、恰好是钉住 challengeGate 的那一行、点不许是裸点。
 *    再往前一步：`judgeT03PinMatchesAuthor` 要求那个新值**逐字出现在 `lib/mods/author.js` 里**、
 *    且 author.js 里**任何一次** challengeGate 调用都不许把裸点交给门禁（决-1 的核心）。
 *    强度对照：旧版「必须逐字等于某个常量」→ 现在「必须逐字等于盘上钉住的那一行、那一行必须真的
 *    出现在 author.js 里、且作者侧没有一处裸点」。更严，不是更松。
 */

/** 一行 `challengeGate: idx('challengeGate({ ... })'),` 里的**内层调用字面量** */
export const T03_PIN_RX = /challengeGate:\s*idx\('(challengeGate\(\{[^']*\}\))'\)/

/** 裸点直传的形状（决-1 要消灭的那一种） */
export const BARE_POINT_ARGS = Object.freeze(['args.point', 'args.point.trim()', 'point'])

/** **纯函数**：从 T03 源码里读出它当前钉住的那些 `challengeGate({...})` 字面量（逐行定位，不猜） */
export function extractT03GatePins(text) {
  const out = []
  String(text ?? '').split('\n').forEach((line, i) => {
    const m = T03_PIN_RX.exec(line)
    if (m) out.push({ line: i + 1, pin: m[1], source: line.trim() })
  })
  return out
}

/** **纯函数**：抽出源码里所有 `challengeGate({...})` 调用的实参文本（含 point 实参） */
export function extractChallengeGateCalls(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/challengeGate\(\{([^}]*)\}\)/g)) {
    const args = m[1]
    const pm = /\bpoint:\s*([^,}]+)/.exec(args)
    out.push({ args: args.trim(), pointArg: pm ? pm[1].trim() : null, call: `challengeGate({${args.trim()}})` })
  }
  return out
}
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * **纯函数**：从 `lib/gate.js` 源码里抽出「只按裸点筛」的那一个 `.filter(...)` 表达式
 * （`previousLesson` 里 `x.point === point` 的那一行）。运行时读，不硬编码旧行 ——
 * 旧行属于 HEAD 字节，写死在测试里等于用测试去追实现。
 */
export function extractBarePointFilter(src) {
  const m = /filter\(\s*\([^)]*\)\s*=>[^)]*?\.point\s*===\s*point\s*\)/.exec(String(src ?? ''))
  return m ? m[0].trim() : null
}

/**
 * **纯函数**：T03 相对 HEAD 只能差**一行**，且那一行恰好是它钉住 challengeGate 的那一行；
 * 改前必须与 HEAD 钉住的字面量同形，改后必须是**规范身份**（点不是裸点）。
 * @returns {{ok:boolean, problems:string[], diffs:Array<{line:number, before:string|null, after:string|null}>, headLines:number, nowLines:number, headPin:string|null, nowPin:string|null}}
 */
export function judgeT03DecisionLine(headText, nowText) {
  const problems = []
  const a = String(headText ?? '').split('\n')
  const b = String(nowText ?? '').split('\n')
  const headPins = extractT03GatePins(headText)
  const nowPins = extractT03GatePins(nowText)
  if (!String(headText ?? '').trim()) problems.push('HEAD 版的 test/audit/T03.mjs 读不到 —— 「只改一行」无从判定')
  if (headPins.length !== 1) problems.push(`HEAD 版 T03 必须恰好钉住一行 challengeGate 调用（实得 ${headPins.length} 行）—— 读不出来就无从判定改的是哪一行`)
  if (nowPins.length !== 1) problems.push(`盘上的 T03 必须恰好钉住一行 challengeGate 调用（实得 ${nowPins.length} 行）—— 多钉/少钉都不行`)
  if (a.length !== b.length) {
    problems.push(`T03 的行数变了（HEAD ${a.length} → 现在 ${b.length}）—— decisions 只授权改一行的期望字面量，不许增删行`)
  }
  const diffs = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) diffs.push({ line: i + 1, before: a[i] ?? null, after: b[i] ?? null })
  if (diffs.length !== 1) problems.push(`T03 的变化行数必须恰好 1 行（实得 ${diffs.length} 行）—— 多改的行都属越界`)
  const d = diffs[0]
  if (d && headPins.length === 1 && nowPins.length === 1) {
    const headPin = headPins[0]
    const nowPin = nowPins[0]
    if (headPin.pin === nowPin.pin) problems.push('T03 钉住的字面量一行都没变 —— 决-1 要的是把它同步成规范身份调用')
    if (headPin.line !== nowPin.line) problems.push(`钉住的那一行挪了位置（HEAD 第 ${headPin.line} 行 → 现在第 ${nowPin.line} 行）—— decisions 只授权改字面量本身`)
    if (d.line !== nowPin.line) problems.push(`被改的第 ${d.line} 行不是 T03 钉住 challengeGate 的那一行（钉的是第 ${nowPin.line} 行）`)
    if (!String(d.before).includes(headPin.pin)) {
      problems.push(`改前那一行不再逐字包含 HEAD 钉住的字面量（改前是 ${JSON.stringify(String(d.before).trim().slice(0, 140))}）`)
    }
    if (!String(d.after).includes(nowPin.pin)) {
      problems.push(`改后那一行不再逐字包含盘上钉住的字面量（改后是 ${JSON.stringify(String(d.after).trim().slice(0, 140))}）`)
    }
    const pinned = extractChallengeGateCalls(nowPin.pin)[0]
    if (!pinned) problems.push('T03 钉住的那一行里读不出 challengeGate 调用的实参')
    else if (pinned.pointArg === null) problems.push('T03 钉住的 challengeGate 调用没写 point 实参 —— 无从判定是不是裸点')
    else if (BARE_POINT_ARGS.includes(pinned.pointArg)) {
      problems.push(`T03 钉住的 point 实参仍是裸点（point: ${pinned.pointArg}）—— 决-1 要的是经规范身份构造的值`)
    }
  }
  return {
    ok: problems.length === 0, problems, diffs, headLines: a.length, nowLines: b.length,
    headPin: headPins.length === 1 ? headPins[0].pin : null,
    nowPin: nowPins.length === 1 ? nowPins[0].pin : null,
  }
}

/**
 * **纯函数**（决-1 的核心判据）：T03 钉住的字面量必须**逐字出现在 `lib/mods/author.js` 里**，
 * 且 author.js 里**任何一次** `challengeGate({...})` 调用都不许把裸点交给门禁；钉住那次调用的
 * point 实参必须能证明是"经规范身份构造的值"（本地 `= gatePointOf(...)` 派生，或行内 `gatePointOf(...)`）。
 * @returns {{ok:boolean, problems:string[], pin:string|null, pinnedPoint:string|null, calls:Array<{pointArg:string|null}>}}
 */
export function judgeT03PinMatchesAuthor(t03Text, authorText) {
  const problems = []
  const pins = extractT03GatePins(t03Text)
  const src = String(authorText ?? '')
  if (pins.length !== 1) {
    return { ok: false, problems: [`T03 必须恰好钉住一行 challengeGate 调用（实得 ${pins.length} 行）—— 无从与作者侧对拍`], pin: null, pinnedPoint: null, calls: [] }
  }
  const pin = pins[0].pin
  if (!src.includes(pin)) {
    problems.push(`T03 钉住的字面量没有逐字出现在 lib/mods/author.js 里（钉的是 ${JSON.stringify(pin.slice(0, 140))}）—— 期望与调用点已经不同形`)
  }
  const calls = extractChallengeGateCalls(src)
  if (calls.length === 0) problems.push('lib/mods/author.js 里读不到任何 challengeGate({...}) 调用 —— 裸点判据无从判定')
  for (const c of calls) {
    if (c.pointArg === null) problems.push(`author.js 里有一次 challengeGate 调用没写 point 实参：${c.call.slice(0, 140)}`)
    else if (BARE_POINT_ARGS.includes(c.pointArg)) {
      problems.push(`author.js 里还有一次 challengeGate 调用把裸点直传门禁（point: ${c.pointArg}）：${c.call.slice(0, 160)}`)
    }
  }
  const pinned = extractChallengeGateCalls(pin)[0]
  const pinnedPoint = pinned ? pinned.pointArg : null
  if (!pinned || pinnedPoint === null) {
    problems.push('T03 钉住的调用里读不出 point 实参')
  } else if (!/^gatePointOf\(/.test(pinnedPoint)) {
    // 不是行内构造 ⇒ 必须能证明本地的那个标识符就是 gatePointOf(...) 派生出来的规范身份
    const derived = new RegExp(`(?:const|let|var)\\s+${escapeRx(pinnedPoint)}\\s*=\\s*gatePointOf\\(`).test(src)
    if (!derived) {
      problems.push(`T03 钉住的 point 实参 ${pinnedPoint} 不是经规范身份构造的值（既不是行内 gatePointOf(...)，也找不到「= gatePointOf(...)」的本地派生）`)
    }
  }
  return { ok: problems.length === 0, problems, pin, pinnedPoint, calls: calls.map((c) => ({ pointArg: c.pointArg })) }
}

/** 运行期自锚：**必须在本次进程第一笔写之前**调用（见文件末尾的 IS_MAIN 块） */
function recordCrossCardAnchors() {
  for (const p of CROSS_CARD_FILES) {
    const abs = path.join(REPO, ...p.split('/'))
    CROSS_CARD.at.set(p, fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null)
  }
  return CROSS_CARD.at
}

/**
 * **纯函数**：一个跨卡锚文件现在该不该红（不读盘；输入全是 sha 与归属，可被反空转用例直接驱动）。
 *
 * @param {{file:string, startSha:string|null, nowSha:string|null, headSha:string|null,
 *          owners:string[]|undefined, writesByThisRun:number|undefined}} input
 *   `owners` 必须是**运行时**从 §6 解析出来的主人列表（不许在调用方硬编码）
 * @returns {{path:string, ok:boolean, rule:string, reasons:string[], row:object}}
 */
export function judgeCrossCardAnchor({ file, startSha, nowSha, headSha, owners, writesByThisRun }) {
  const reasons = []
  const own = Array.isArray(owners) ? owners.slice() : []
  const writes = Number(writesByThisRun) || 0
  const row = {
    path: file,
    rule: '',
    drift: 'none',
    owners: own,
    writesByThisRun: writes,
    inHead: headSha !== null && headSha !== undefined,
    now16: String(nowSha || '').slice(0, 16) || null,
    atStart16: String(startSha || '').slice(0, 16) || null,
    head16: String(headSha || '').slice(0, 16) || null,
  }

  // ③ 本进程写过 ⇒ 红（最先判：它不在本卡写集里，有主也不放行）
  if (writes > 0) {
    row.rule = 'process-wrote'
    reasons.push(`A08 · 本卡进程写过 ${file}（写守卫逐笔记录 ${writes} 次）—— 它不在本卡写集里，写它一律红`)
  }

  // ① 锚要建得起来：开始时读不到 / 现在不见了 ⇒ 判不了 ⇒ 红（不因"有主"而放过）
  if (!startSha) {
    row.rule = row.rule || 'no-anchor'
    reasons.push(`A08 · ${file} 的运行期自锚没建成（进程开始时读不到它）—— "本进程没写它"无从证明`)
  } else if (!nowSha) {
    row.rule = row.rule || 'vanished'
    reasons.push(`A08 · ${file} 在本次运行期间不见了（跨卡锚文件必须还在）`)
  } else if (nowSha !== startSha) {
    // ② 运行期内变过：写守卫没有记录 ⇒ 不是本进程写的，但仍必须能按 §6 归因
    row.drift = 'runtime'
    if (own.length === 0) {
      row.rule = row.rule || 'runtime-unattributed'
      reasons.push(`A08 · 运行期无主漂移：${file} 在本次运行期间被改，而 §6 里没有任何卡拥有它（没人授权这次改动）`)
    } else if (own.includes(CARD)) {
      row.rule = row.rule || 'runtime-own-owner'
      reasons.push(`A08 · 运行期漂移落在本卡名下：${file} 的 §6 主人是 ${own.join('/')}，本卡不许动它`)
    } else if (!row.rule) {
      row.rule = 'runtime-attributed'
    }
  } else if (startSha !== headSha) {
    // ② 运行期外已变（兄弟 lane 在本次进程启动前就改过了）：按 §6 归属 —— 有主只登记，无主红
    row.drift = 'before-run'
    if (own.length === 0) {
      row.rule = row.rule || 'before-run-unattributed'
      reasons.push(`A08 · ${file} 在运行期外已变，且 §6 里没有任何卡拥有它（本卡没有授权改它，别人也没有）`)
    } else if (!row.rule) {
      row.rule = 'before-run-attributed'
    }
  } else if (!row.rule) {
    row.rule = 'head-equal'
  }

  return { path: file, ok: reasons.length === 0, rule: row.rule, reasons, row }
}

/** 现场把一个跨卡锚文件判一遍（§6 归属**运行时**解析；A08 与收口共用这一份） */
function judgeCrossCardFile(file, { owners, atBoot }) {
  const abs = path.join(REPO, ...file.split('/'))
  const head = gitHeadBytes(file)
  const now = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null
  const writes = WRITE_GUARD.writes.filter((w) => w.target === path.resolve(abs)).length
  // owners 既可以是「路径 → 主人[]」的 Map（现场解析结果），也可以是显式列表（反空转用例用）
  const list = owners instanceof Map ? (owners.get(file) || []) : (Array.isArray(owners) ? owners : [])
  return judgeCrossCardAnchor({
    file,
    startSha: (atBoot ?? CROSS_CARD.at).get(file) ?? null,
    nowSha: now,
    headSha: head === null ? null : sha256(head),
    owners: list,
    writesByThisRun: writes,
  })
}

/** §6 的主人表（运行时解析；读不动就是"没有主人"⇒ 该红的会红） */
function section6Owners() {
  try {
    return pathOwners(parseSection6(specDocText('docs/unify/interfaces.md')), new Map())
  } catch {
    return new Map()
  }
}

/* ── 规格文档快照（docs/unify 的两份**输入**） ─────────────────────────── */

/**
 * `docs/unify/interfaces.md`（§6 写集归属）与 `docs/unify/authorization.json`（§12 A 授权面）
 * 是本卡**读一次、判一次**的输入，不是运行期依赖。
 *
 * 为什么不再要求"整跑字节不变"：兄弟 lane 按自己的卡面更新 §6 行 / 授权面是**合法**的
 * （U01 的 P1/P2 就改过 authorization.json；本轮实测就在一次运行的 3 秒里被改过一次 ⇒ 假红），
 * 而 A01–A07 的执行完全不读这两份文件（它们读 lib/** 与夹具）—— "整跑冻结"想保护的东西
 * 与"依赖自锚"不是一回事。
 *
 * 改成：**一次读、按同一份快照判、把版本 sha 记进证据**。语义强度不降 ——
 * §6 行 = 本卡写集、授权面、quoteVerbatim 等所有断言仍对着**同一份**快照判（不会出现
 * "前半段按旧版本、后半段按新版本"的混判），快照的 sha256 落 detail.json 可审计；
 * 若运行期间盘上又变了，证据里如实记 `driftAfterSnapshot`（不红：那是别人的合法写，
 * 且这一跑用的确实是记下来的那一版）。
 */
const SPEC_DOCS = {
  files: Object.freeze(['docs/unify/interfaces.md', 'docs/unify/authorization.json']),
  snap: new Map(),
}

function specDoc(relPath) {
  if (!SPEC_DOCS.snap.has(relPath)) {
    const abs = path.join(REPO, ...relPath.split('/'))
    const buf = fs.existsSync(abs) ? fs.readFileSync(abs) : null
    SPEC_DOCS.snap.set(relPath, {
      path: relPath,
      text: buf === null ? null : buf.toString('utf8'),
      sha256: buf === null ? null : sha256(buf),
      bytes: buf === null ? 0 : buf.length,
      readAt: 'run',
    })
  }
  return SPEC_DOCS.snap.get(relPath)
}

/** 快照的文本（读不到就抛 —— §6 归属 / 授权面无从解析，判据不许"猜"） */
function specDocText(relPath) {
  const d = specDoc(relPath)
  assert(d.text !== null, `A08 · 规格文档读不到：${relPath}（§6 归属 / 授权面无从解析）`)
  return d.text
}

/** 快照事实（A08 与收口各记一次；`driftAfterSnapshot` 只记录、不判红） */
function specDocFacts() {
  return SPEC_DOCS.files.map((p) => {
    const s = specDoc(p)
    const abs = path.join(REPO, ...p.split('/'))
    const now = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null
    return {
      path: p,
      bytes: s.bytes,
      sha16: String(s.sha256 || '').slice(0, 16),
      driftAfterSnapshot: now !== s.sha256,
      note: '本卡按这一份快照判（§6 归属 / §12 A 授权面）；兄弟 lane 其后改写不构成本卡越界',
    }
  })
}

/* ══════════════════════════════════════════════════════════════════════
 * 装载本卡的落点（宿主侧 ESM + 内核 CJS）
 * ══════════════════════════════════════════════════════════════════════ */

function kernel(baseDir = REPO) {
  const abs = path.join(baseDir, ...KERNEL.split('/'))
  delete require_.cache[abs]
  return require_(abs)
}

async function loadHosts(baseDir = REPO) {
  const load = (p) => import(pathToFileURL(path.join(baseDir, ...p.split('/'))).href)
  return {
    baseDir,
    evidence: await load(HOST.evidence),
    evidenceIo: await load(HOST.evidenceIo),
    state: await load(HOST.state),
    stateScan: await load(HOST.stateScan),
    gate: await load(HOST.gate),
    model: await load('lib/pack-model.js'),
    askIo: await load('lib/ask-io.js'),
    notesIo: await load('lib/notes-io.js'),
    core: kernel(baseDir),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════ */

let fixtureSeq = 0
const FIXTURES = path.join(RUN_TEMP, 'fixtures')

/** 夹具的「有产出」那一档（机器判不了 + 声明最低证据档 `run`） */
const EV_CHALLENGE = (no = 1, min = 'run') => ({
  no,
  deliverable: `第${no}题：把东西真的跑起来`,
  auto: false,
  hint: '机器判不了（要能讲清为什么）',
  minEvidence: min,
})
/** 夹具的机器判据那一档（`ok:true` = 判据满足；false = 判据不满足） */
const CHECKS_CHALLENGE = (no, ok) => ({
  no,
  deliverable: `第${no}题：产出文件`,
  checks: [{ id: `c${no}`, kind: 'file', value: ok ? 'Main.java' : 'Missing.java', hint: `要 ${ok ? 'Main.java' : 'Missing.java'}` }],
})
const REQUIRED = Object.freeze([{ id: 'r1', kind: 'file', value: 'Main.java', hint: '主类 Main.java' }])

/** 一条合法证据行（键序钉死） */
const evidenceLine = (lesson, kind = 'run', challenge = 1) =>
  JSON.stringify({ date: null, lesson, challenge, kind, ref: null, note: null })

/** 课程源 + 页面（`readPack` 只从 `lessons/src/**\/NNNN-*.html` 读课；页面用于 lessonIndex） */
function writeLessonFiles(root, circle, point, number, title) {
  const meta = { halo: circle, point, number, title }
  const html = `<!doctype html>\n<script type="application/json" data-lesson-meta>${JSON.stringify(meta)}</script>\n<!--@challenges-->\n<li>把东西跑起来</li>\n<!--/@challenges-->\n`
  writeText(path.join(root, 'lessons', 'src', circle, point, `${String(number).padStart(4, '0')}-lesson.html`), html)
  writeText(path.join(root, 'lessons', circle, point, `${String(number).padStart(4, '0')}-lesson.html`), html)
}

const BASE_DIRS = Object.freeze(['questions', 'notes', 'learning-records', 'assets'])

/**
 * 单圈夹具：`<circle>/<point>` 一个点、一门课（`0001`，证据档 `run`），项目在 `code/<circle>/<point>`。
 * @param {string} tag 名字（同一次运行内唯一）
 * @param {{circle?:string, point?:string, evidence?:string[]|null, challenges?:object[],
 *          extraLessons?:Array<{number:number, challenges:object[]}>}} [spec]
 *   `evidence:null` = **不建台账文件**（missing）；`evidence:[]` = 空文件（empty）
 */
function makeOneCirclePack(tag, spec = {}) {
  fixtureSeq += 1
  const circle = spec.circle || 'a'
  const point = spec.point || 'x'
  const root = path.join(FIXTURES, `${String(fixtureSeq).padStart(3, '0')}-${tag}`)
  fs.mkdirSync(root, { recursive: true })
  writeJson(path.join(root, 'lessons', circle, 'halo.json'), { halo: circle, name: circle })
  writeJson(path.join(root, 'lessons', circle, point, 'point.json'), {
    point,
    name: point,
    fileBase: 0,
    practice: { dirs: [`code/${circle}/${point}`] },
  })
  writeJson(path.join(root, 'progress.json'), { learned: [] })
  for (const d of BASE_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true })
  const projDir = path.join(root, 'code', circle, point)
  const lessons = [{
    id: `${point}/0001`,
    title: '夹具第一课',
    required: REQUIRED.slice(),
    challenges: spec.challenges || [EV_CHALLENGE(1, 'run')],
  }]
  for (const extra of spec.extraLessons || []) {
    lessons.push({
      id: `${point}/${String(extra.number).padStart(4, '0')}`,
      title: `夹具第${extra.number}课`,
      required: REQUIRED.slice(),
      challenges: extra.challenges,
    })
  }
  writeJson(path.join(projDir, 'EXPECT.json'), { lessons })
  writeText(path.join(projDir, 'Main.java'), 'class Main {}\n')
  writeLessonFiles(root, circle, point, 1, '夹具第一课')
  for (const extra of spec.extraLessons || []) writeLessonFiles(root, circle, point, extra.number, `夹具第${extra.number}课`)
  if (spec.evidence !== null) {
    fs.writeFileSync(path.join(root, 'learning-records', 'evidence.jsonl'), (spec.evidence || []).join('\n') + ((spec.evidence || []).length ? '\n' : ''), 'utf8')
  }
  return root
}

/**
 * 跨圈同名夹具：`a/x` 与 `b/x` **各一份** EXPECT（课次 id 都是声明形状 `x/0001`、`x/0002`），
 * 分住各自的实践区 `code/a/x` / `code/b/x`。
 *   · `a/x/0001` —— 证据档课（需要 `run`）；`a/x/0002` —— 机器判据**已过**
 *   · `b/x/0001` —— 证据档课（需要 `run`）；`b/x/0002` —— 机器判据**没过**
 * 于是"串了没有"在四处同时可见：证据键解析 / 快照判定 / 门禁 previousLesson / 快照收窄。
 */
function makeCrossPack(tag = 'cross') {
  fixtureSeq += 1
  const root = path.join(FIXTURES, `${String(fixtureSeq).padStart(3, '0')}-${tag}`)
  fs.mkdirSync(root, { recursive: true })
  for (const circle of ['a', 'b']) {
    writeJson(path.join(root, 'lessons', circle, 'halo.json'), { halo: circle, name: circle })
    writeJson(path.join(root, 'lessons', circle, 'x', 'point.json'), {
      point: 'x',
      name: 'x',
      fileBase: 0,
      practice: { dirs: [`code/${circle}/x`] },
    })
    for (const [number, title] of [[1, '证据课'], [2, '机器判据课']]) writeLessonFiles(root, circle, 'x', number, `${circle} ${title}`)
    const projDir = path.join(root, 'code', circle, 'x')
    writeJson(path.join(projDir, 'EXPECT.json'), {
      lessons: [
        { id: 'x/0001', title: '证据课', required: REQUIRED.slice(), challenges: [EV_CHALLENGE(1, 'run')] },
        {
          id: 'x/0002',
          title: '机器判据课',
          required: REQUIRED.slice(),
          challenges: [CHECKS_CHALLENGE(1, circle === 'a')],
        },
      ],
    })
    writeText(path.join(projDir, 'Main.java'), 'class Main {}\n')
  }
  writeJson(path.join(root, 'progress.json'), { learned: ['a/x/0001', 'a/x/0002', 'b/x/0001'] })
  for (const d of BASE_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true })
  return root
}

/** 跑一遍真探针并把快照写回（`whale_state write:true` 的等价物） */
function probeAndWrite(hosts, root) {
  const pack = hosts.model.readPack(root)
  const { state } = hosts.stateScan.probeState(root, pack, {})
  hosts.stateScan.writeState(root, state)
  return { pack, state }
}

/** 把快照从盘上读回来（门禁 / 包侧读的就是它） */
function readSnapshotDoc(root) {
  return JSON.parse(readText(path.join(root, 'learning-records', 'state.json')))
}

function lessonsOf(state) {
  return (state.projects || []).flatMap((p) => (p.lessons || []).map((l) => ({ dir: p.dir, ...l })))
}
function lessonOf(state, dir, id) {
  return lessonsOf(state).find((l) => l.dir === dir && l.id === id) || null
}

/* ── 包侧（模板 tools）副本 ──────────────────────────────────────────── */

/** 逐字复制一份「模板 tools + 已交付权威内核」到临时包里（U19 之前仓内没有随包副本 —— R1） */
const TOOLS_TEMPLATE = { dir: path.join(RUN_TEMP, 'tools-template'), copies: [] }
function ensureToolsTemplate() {
  if (fs.existsSync(path.join(TOOLS_TEMPLATE.dir, 'ask-server.js'))) return TOOLS_TEMPLATE.dir
  fs.mkdirSync(path.join(TOOLS_TEMPLATE.dir, 'unify'), { recursive: true })
  fs.cpSync(path.join(REPO, 'lib', 'pack-template', 'tools'), TOOLS_TEMPLATE.dir, { recursive: true })
  const copies = []
  for (const name of fs.readdirSync(path.join(REPO, 'lib', 'unify')).sort()) {
    if (!name.endsWith('.cjs')) continue
    const from = path.join(REPO, 'lib', 'unify', name)
    const to = path.join(TOOLS_TEMPLATE.dir, 'unify', name)
    fs.copyFileSync(from, to)
    copies.push({ rel: `tools/unify/${name}`, bytes: fs.statSync(to).size, sha256: sha256(fs.readFileSync(to)) })
  }
  TOOLS_TEMPLATE.copies = copies
  return TOOLS_TEMPLATE.dir
}

/**
 * 让一个夹具包"能跑包侧服务"：把模板 tools 副本铺进 `<root>/tools/`。
 * @param {string} root 夹具包根
 * @param {(toolsDir:string)=>void} [patch] 铺完之后、require 之前对副本的局部改动（A06 的提交自证 / A07 的变异）
 * @returns {{root:string, ask:object, copies:object[]}}
 */
function serverize(root, patch) {
  const template = ensureToolsTemplate()
  const target = path.join(root, 'tools')
  fs.cpSync(template, target, { recursive: true })
  if (typeof patch === 'function') patch(target)
  const abs = path.join(target, 'ask-server.js')
  delete require_.cache[abs]
  const ask = require_(abs)
  const copies = fs.readdirSync(path.join(template, 'unify')).sort().map((name) => {
    const file = path.join(target, 'unify', name)
    return { rel: `tools/unify/${name}`, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }
  })
  return { root, ask, copies }
}

/** 假响应对象（`json()` / `cors()` 只用到这几个成员） */
function mockRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(code, headers) {
      this.status = code
      this.headers = headers || {}
      this.headersSent = true
      return this
    },
    setHeader(k, v) { this.headers[k] = v },
    end(t) { this.body = t == null ? '' : String(t); this.writableEnded = true },
    on() {},
  }
}

/** 假请求对象（`readBodyBytes` 需要一个可读流；Host 是本机回环 ⇒ 无 Origin 走 OK_NO_ORIGIN） */
function mockReq(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:8788' }
  stream.complete = true
  return stream
}

/**
 * 直调包侧入口（与 `http.createServer(handleRequest)` 同一条路径，只是不占端口）。
 *
 * ⚠️ 包侧服务自己会往 stdout/stderr 打日志（`[ask] 收到 #0001 …` / 写失败那行）—— 那是
 * **被服务自己的日志**，不是判词。判词必须只有一行，所以这里把服务日志**收进证据**
 * （`DETAIL.serviceLog`）并还原控制台：既不吞（证据里能看），也不污染判词行。
 */
const SERVICE_LOG = []
async function callPack(ask, method, url, body) {
  const origLog = console.log
  const origError = console.error
  const lines = []
  const capture = (stream) => (...a) => { lines.push(`${stream} ${a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')}`) }
  console.log = capture('out')
  console.error = capture('err')
  const res = mockRes()
  try {
    await ask.handleRequest(mockReq(method, url, body), res)
  } finally {
    console.log = origLog
    console.error = origError
  }
  SERVICE_LOG.push(...lines.map((l) => `${method} ${url} :: ${l}`))
  DETAIL.serviceLog = SERVICE_LOG.slice(-40)
  let parsed = null
  try { parsed = res.body ? JSON.parse(res.body) : null } catch { parsed = { raw: res.body } }
  return { status: res.status, body: parsed }
}

/** 注入式假 fs：只用于确定性的 IO 故障（EACCES），不碰真盘 */
function deniedFs(code = 'EACCES') {
  return {
    readFileSync() {
      const e = new Error(`${code}: permission denied, read`)
      e.code = code
      throw e
    },
  }
}

/* ── HEAD 旧树（只读对拍用：把本卡的五个落点换回 HEAD 字节） ─────────────── */

let OLD_TREE = null
/**
 * 旧树根：当前 `lib/` 的逐字副本 + **五个宿主落点换回 HEAD 字节**。
 * 于是它就是"改前的这五个文件 + 改后的兄弟模块"—— A01/A08 的对拍对象。
 * @returns {string}
 */
function oldTree() {
  if (OLD_TREE) return OLD_TREE
  const dest = path.join(RUN_TEMP, 'old-tree')
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(path.join(REPO, 'lib'), path.join(dest, 'lib'), { recursive: true })
  for (const p of [HOST.gate, HOST.evidence, HOST.evidenceIo, HOST.state, HOST.stateScan]) {
    const bytes = gitHeadBytes(p)
    assert(bytes !== null, `HEAD 里没有 ${p}（旧树建不出来）`)
    fs.writeFileSync(path.join(dest, ...p.split('/')), bytes)
  }
  fs.writeFileSync(path.join(dest, 'package.json'),
    JSON.stringify({ name: 'u18-old-tree', type: 'module', version: '0.0.0' }, null, 2) + '\n', 'utf8')
  OLD_TREE = dest
  return dest
}

let OLD_GATE = null
async function oldGateMod() {
  if (!OLD_GATE) OLD_GATE = await import(pathToFileURL(path.join(oldTree(), 'lib', 'gate.js')).href)
  return OLD_GATE
}
let OLD_EVIDENCE = null
async function oldEvidenceMod() {
  if (!OLD_EVIDENCE) OLD_EVIDENCE = await import(pathToFileURL(path.join(oldTree(), 'lib', 'evidence.js')).href)
  return OLD_EVIDENCE
}

/* ══════════════════════════════════════════════════════════════════════
 * 五态的夹具工厂（每个态一个**独立**的包：同一份夹具，只换台账的"病"）
 * ══════════════════════════════════════════════════════════════════════ */

const FIVE_STATES = Object.freeze(['missing', 'empty', 'ok', 'invalid', 'io-error'])

/** 某态的包：`missing` = 根本没有台账文件（真 ENOENT）；`empty` = 空文件；其余按病造 */
function packForState(tag, state_) {
  const root = makeOneCirclePack(`${tag}-${state_}`, {
    evidence: state_ === 'empty' ? [] : state_ === 'ok' ? [evidenceLine('a/x/0001')] : null,
  })
  const ev = path.join(root, 'learning-records', 'evidence.jsonl')
  if (state_ === 'invalid') writeText(ev, '这不是JSON{{{\n')
  if (state_ === 'io-error') {
    fs.rmSync(ev, { force: true })
    fs.mkdirSync(ev, { recursive: true })
  }
  return root
}

/** 某态在**判定层**应当长什么样（A02/A04/A05/A06 共用这一张表） */
const STATE_EXPECT = Object.freeze({
  missing: { exists: false, errorCode: 'ENOENT', fallback: true, blocked: false, gate: 'ok', word: null },
  empty: { exists: true, errorCode: null, fallback: false, blocked: true, gate: 'evidence-insufficient', word: '空账' },
  ok: { exists: true, errorCode: null, fallback: false, blocked: false, gate: 'ok', word: null },
  invalid: { exists: true, errorCode: null, fallback: false, blocked: true, gate: 'evidence-insufficient', word: '损坏' },
  'io-error': { exists: true, errorCode: 'EISDIR', fallback: false, blocked: true, gate: 'evidence-insufficient', word: '读不动' },
})

/* ══════════════════════════════════════════════════════════════════════
 * A01：跨圈同名课程判据与证据不串
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * A01 的本体：四处同时判"串没串"—— ① 证据台账键解析；② 快照判定（`judgeChallenges`）；
 * ③ 门禁的"上一课"（`previousLesson` / `challengeGate`）；④ 判据快照按实践区收窄。
 * 末尾与 HEAD 旧树对拍，证明"旧实现只按裸点筛"这条降维真的存在（不是本卡凭空收紧）。
 *
 * @returns {{observed:object, violations:string[]}} 只**记录**违规、不抛（A07 的变异副本复用同一份判官）
 */
export function judgeCrossCircle(hosts, root, oldGate) {
  const violations = []
  const note = (m) => violations.push(m)
  const pack = hosts.model.readPack(root)
  const observed = {}

  /* ① 证据台账键：规范形状只用自己；声明形状只在**唯一归属**时可接受 */
  {
    const resolve = hosts.state.lessonEvidenceKeys(pack)
    const fromA = resolve('x/0001', 'code/a/x')
    const fromB = resolve('x/0001', 'code/b/x')
    const bare = resolve('x/0001', '')
    const canonical = resolve('a/x/0001', 'code/b/x')
    observed.keys = { fromA, fromB, bare, canonical }
    if (fromA.canonical !== 'a/x/0001') note(`① a 的 x/0001 应解析成 a/x/0001，实得 ${fmt(fromA.canonical)}`)
    if (fromB.canonical !== 'b/x/0001') note(`① b 的 x/0001 应解析成 b/x/0001，实得 ${fmt(fromB.canonical)}`)
    if (fromA.aliases.includes('x/0001')) note('① 跨圈同名时 2 段写法不许进可接受键（会串证据）')
    if (fromB.aliases.includes('x/0001')) note('① 跨圈同名时 2 段写法不许进可接受键（会串证据）')
    if (!(bare.ambiguous === true && bare.aliases.length === 0)) note('① 光看裸点分不出归属时必须报歧义且不给可接受键（不猜）')
    if (!(canonical.canonical === 'a/x/0001' && canonical.aliases.length === 1)) note('① 规范形状只许用自己（不许被降维成 2 段）')
  }

  /* ② 快照判定：证据只算它自己那一门课 */
  const evFile = path.join(root, 'learning-records', 'evidence.jsonl')
  const setEvidence = (lines) => {
    fs.rmSync(evFile, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(evFile), { recursive: true })
    fs.writeFileSync(evFile, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
  }
  const challengeOf = (state, dir, id) => {
    const l = lessonOf(state, dir, id)
    return l && Array.isArray(l.challenges) ? l.challenges.find((c) => c.no === 1) : null
  }
  const snapshotOf = () => {
    const { state } = probeAndWrite(hosts, root)
    return state
  }
  {
    setEvidence([evidenceLine('a/x/0001')])
    let state = snapshotOf()
    const a1 = challengeOf(state, 'code/a/x', 'x/0001')
    const b1 = challengeOf(state, 'code/b/x', 'x/0001')
    observed.evidenceOnlyA = {
      aOk: a1 && a1.evidence && a1.evidence.ok,
      aGaps: (lessonOf(state, 'code/a/x', 'x/0001').evidenceGaps || []).length,
      bOk: b1 && b1.evidence && b1.evidence.ok,
      bGaps: (lessonOf(state, 'code/b/x', 'x/0001').evidenceGaps || []).map((g) => g.hint.slice(0, 40)),
    }
    if (!(a1 && a1.evidence && a1.evidence.ok === true)) note('② 台账里只有 a/x/0001 的证据时，a/x/0001 必须够档')
    if (!(b1 && b1.evidence && b1.evidence.ok === false)) note('② 台账里只有 a/x/0001 的证据时，b/x/0001 必须**不够档**（串了）')
    if ((lessonOf(state, 'code/b/x', 'x/0001').evidenceGaps || []).length !== 1) note('② b/x/0001 必须有一条"还差一档证据"的回执')

    setEvidence([evidenceLine('b/x/0001')])
    state = snapshotOf()
    const a2 = challengeOf(state, 'code/a/x', 'x/0001')
    const b2 = challengeOf(state, 'code/b/x', 'x/0001')
    if (!(b2 && b2.evidence && b2.evidence.ok === true)) note('② 只有 b/x/0001 的证据时，b/x/0001 必须够档')
    if (!(a2 && a2.evidence && a2.evidence.ok === false)) note('② 只有 b/x/0001 的证据时，a/x/0001 必须不够档（串了）')

    // 两段写法在跨圈同名下**不猜**：两边都阻断，且措辞说清"有 2 个候选"
    setEvidence([evidenceLine('x/0001')])
    state = snapshotOf()
    const a3 = lessonOf(state, 'code/a/x', 'x/0001')
    const b3 = lessonOf(state, 'code/b/x', 'x/0001')
    observed.bareTwoSeg = {
      a: (a3.evidenceGaps || []).map((g) => g.hint.slice(0, 80)),
      b: (b3.evidenceGaps || []).map((g) => g.hint.slice(0, 80)),
    }
    for (const [tag, l] of [['a/x', a3], ['b/x', b3]]) {
      const gaps = l.evidenceGaps || []
      if (gaps.length !== 1) note(`② 台账里写 2 段 x/0001（跨圈同名）时，${tag} 必须阻断（不猜）`)
      else if (!/归属有 2 个候选/.test(gaps[0].hint) || !/不猜/.test(gaps[0].hint)) note(`② ${tag} 的阻断说明必须点名"归属有 2 个候选 / 不猜"`)
    }

    // 两门课各贴自己的证据 ⇒ 都够档（真正按课次分组）
    setEvidence([evidenceLine('a/x/0001'), evidenceLine('b/x/0001')])
    state = snapshotOf()
    const a4 = challengeOf(state, 'code/a/x', 'x/0001')
    const b4 = challengeOf(state, 'code/b/x', 'x/0001')
    if (!(a4 && a4.evidence && a4.evidence.ok === true && b4 && b4.evidence && b4.evidence.ok === true)) {
      note('② 两门课各贴自己的证据时都必须够档（按规范课次键分组）')
    }
    observed.bothOk = true
  }

  /* ③ 门禁：上一课按 circle+point 两段筛；裸点跨圈同名 ⇒ fail-closed */
  {
    setEvidence([evidenceLine('a/x/0001'), evidenceLine('b/x/0001')])
    const snap = probeAndWrite(hosts, root)
    const pk = snap.pack
    const prevA = hosts.gate.previousLesson(pk, 'a/x')
    const prevB = hosts.gate.previousLesson(pk, 'b/x')
    const prevBare = hosts.gate.previousLesson(pk, 'x')
    const gateA = hosts.gate.challengeGate({ root, pack: pk, point: 'a/x', probe: false })
    const gateB = hosts.gate.challengeGate({ root, pack: pk, point: 'b/x', probe: false })
    const gateBare = hosts.gate.challengeGate({ root, pack: pk, point: 'x', probe: false })
    observed.gate = {
      prevA: prevA && prevA.id, prevB: prevB && prevB.id, prevBare: prevBare && prevBare.id,
      a: { allowed: gateA.allowed, code: gateA.code, lesson: gateA.lesson },
      b: { allowed: gateB.allowed, code: gateB.code, lesson: gateB.lesson, gaps: (gateB.gapText || []).slice(0, 2) },
      bare: { allowed: gateBare.allowed, code: gateBare.code, candidates: gateBare.candidates, why: gateBare.why, error: gateBare.error },
    }
    if (!(prevA && prevA.id === 'a/x/0002')) note(`③ previousLesson(a/x) 应是 a 圈自己的最后一课 a/x/0002，实得 ${fmt(prevA && prevA.id)}`)
    if (!(prevB && prevB.id === 'b/x/0002')) note(`③ previousLesson(b/x) 应是 b 圈自己的最后一课 b/x/0002，实得 ${fmt(prevB && prevB.id)}`)
    if (prevBare !== null) note('③ 裸点跨圈同名时 previousLesson 必须返回 null（不猜），调用方据此 fail-closed')
    if (!(gateA.allowed === true && gateA.code === 'ok' && gateA.lesson === 'a/x/0002')) {
      note(`③ a/x 的挑战闸必须只按 a 自己的上一课判并放行（b/x/0002 的判据不许拦下 a/x）；实得 ${fmt(observed.gate.a)}`)
    }
    if (!(gateB.allowed === false && gateB.code === 'criteria-not-met' && gateB.lesson === 'b/x/0002')) {
      note(`③ b/x 的挑战闸必须按 b 自己的上一课判并拦住（不许拿 a 的"已过"放行）；实得 ${fmt(observed.gate.b)}`)
    }
    if (!(gateBare.allowed === false && gateBare.code === 'ambiguous-point')) {
      note(`③ 裸点跨圈同名时挑战闸必须 fail-closed（ambiguous-point），实得 ${fmt(observed.gate.bare.code)}`)
    }
    sameJsonNoThrow(gateBare.candidates, ['a', 'b'], note, '③ 歧义拒绝必须列出两个候选圆圈')
    if (!/上一课的归属不唯一/.test(String(gateBare.why || ''))) note('③ 歧义拒绝的 why 必须说清"归属不唯一 ⇒ 失败关闭"')

    // ④ 收窄的必要性：**不**收窄时判 b/x/0002 会命中 a 的同名课（这正是被修掉的串）
    const unscoped = hosts.gate.judgeSnapshot(readSnapshotDoc(root), root, 'b/x/0002')
    observed.unscoped = { ok: unscoped.ok, code: unscoped.code }
    if (unscoped.ok !== true) {
      note('④（夹具前提）不按实践区收窄时，b/x/0002 会命中 a 的同名课并被放行 —— 这条前提不成立，收窄判据就成了空转')
    }

    /* ⑤ 与 HEAD 旧树对拍：旧实现只按裸点筛（既串圈、又因课次形状对不上而 fail-open） */
    const oldPrevA = oldGate.previousLesson(pk, 'a/x')
    const oldPrevBare = oldGate.previousLesson(pk, 'x')
    const oldGateBare = oldGate.challengeGate({ root, pack: pk, point: 'x', probe: false })
    observed.head = {
      prevA: oldPrevA && oldPrevA.id,
      prevBare: oldPrevBare && oldPrevBare.id,
      gateBare: { allowed: oldGateBare.allowed, code: oldGateBare.code, lesson: oldGateBare.lesson },
    }
    if (oldPrevA !== null) note('⑤（Δ 前提）HEAD 的 previousLesson 只按裸点筛：previousLesson(a/x) 应当看不见 a 自己的课（实得非 null，拍不开旧行为）')
    if (!(oldPrevBare && oldPrevBare.id === 'b/x/0002')) note('⑤（Δ 前提）HEAD 的 previousLesson(x) 应当把 b 圈的课当成"上一课"（这就是串圈实据）')
    if (!(oldGateBare.allowed === true && oldGateBare.lesson === 'b/x/0002')) {
      note('⑤（Δ 前提）HEAD 在裸点上会拿 b/x/0002 判，而快照里是声明形状 ⇒ 逐字相等对不上 ⇒ unknown-lesson 放行（串圈 + fail-open）')
    }
    if (!(hosts.gate.challengeGate({ root, pack: pk, point: 'x', probe: false }).allowed === false)) {
      note('⑤ 新实现必须把这条 fail-open 收掉（裸点跨圈同名 ⇒ 不放行）')
    }
  }

  return { observed, violations }
}

/** `sameJson` 的不抛版本（判官只记录） */
function sameJsonNoThrow(actual, expected, note, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) note(`${msg}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`)
}

/* ══════════════════════════════════════════════════════════════════════
 * A02：五态完整传播
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * A02 的本体：五态逐态从 `readEvidence()` 一路传到快照（`lessons[].evidenceStatus`）与门禁判词，
 * 并证明 **io-error 不被折成 empty**（错误码保留、`exists:true`、修法措辞不同）。
 */
export function judgeFiveStates(hosts) {
  const violations = []
  const note = (m) => violations.push(m)
  const chk = (cond, m) => { if (!cond) note(m) }
  const chkEq = (actual, expected, m) => { if (actual !== expected) note(`${m}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`) }
  const observed = {}

  for (const st of FIVE_STATES) {
    const root = packForState('a02', st)
    const want = STATE_EXPECT[st]
    const live = hosts.evidenceIo.readEvidence(root)
    const { pack, state } = probeAndWrite(hosts, root)
    const lesson = lessonOf(state, 'code/a/x', 'x/0001')
    const evCh = lesson && Array.isArray(lesson.challenges) ? lesson.challenges.find((c) => c.no === 1) : null
    const gate = hosts.gate.challengeGate({ root, pack, point: 'a/x', probe: false })
    const judged = hosts.state.judgeChallenges({}, [EV_CHALLENGE(1, 'run')], { lessons: ['a/x/0001'], evidence: live })
    const liveVerdict = hosts.core.liveLedgerVerdict(live, { needsEvidence: true })
    const hints = (lesson.evidenceGaps || []).map((g) => g.hint)
    const joined = hints.join(' | ')

    observed[st] = {
      live: { status: live.status, exists: live.exists, errorCode: live.errorCode || null, problems: live.problems.length, entries: live.entries.length },
      snapshot: {
        evidenceStatus: lesson.evidenceStatus,
        evidenceFallback: lesson.evidenceFallback,
        gaps: hints.map((h) => h.slice(0, 70)),
        challengeEvidence: evCh && evCh.evidence ? { ok: evCh.evidence.ok, status: evCh.evidence.status, min: evCh.evidence.min, have: evCh.evidence.have } : null,
      },
      gate: { allowed: gate.allowed, code: gate.code, evidenceStatus: gate.evidenceStatus ?? null, fallback: gate.evidenceFallback === true },
      judged: { fallback: judged.evidenceFallback, blocked: judged.evidenceBlocked, status: judged.evidenceStatus },
      liveVerdict: { broken: liveVerdict.broken, status: liveVerdict.status, errorCode: liveVerdict.errorCode, why: liveVerdict.why.slice(0, 80) },
    }

    chkEq(live.status, st, `A02 · ${st}：readEvidence 的 status`)
    chkEq(live.exists, want.exists, `A02 · ${st}：exists（只有真 ENOENT 才算不存在）`)
    chkEq(live.errorCode || null, want.errorCode, `A02 · ${st}：errorCode 必须保留`)
    chkEq(judged.evidenceFallback, want.fallback, `A02 · ${st}：judgeChallenges 的回退开关`)
    chkEq(judged.evidenceBlocked.length > 0, want.blocked, `A02 · ${st}：judgeChallenges 是否阻断`)
    chkEq(lesson.evidenceStatus, st, `A02 · ${st}：快照里的 lessons[].evidenceStatus 必须如实带出五态`)
    chkEq(lesson.evidenceFallback, want.fallback, `A02 · ${st}：快照里的 evidenceFallback`)
    chkEq(gate.allowed, !want.blocked, `A02 · ${st}：门禁是否放行`)
    chkEq(gate.code, want.gate, `A02 · ${st}：门禁判词码`)
    if (want.word) chk(new RegExp(want.word).test(joined), `A02 · ${st}：阻断说明必须点名"${want.word}"（实得 ${fmt(joined.slice(0, 120))}）`)
    if (want.blocked) {
      chk((gate.evidenceGaps || []).length === 1, `A02 · ${st}：门禁必须逐条回执"还差哪一档证据"`)
      chkEq(evCh && evCh.evidence && evCh.evidence.ok, false, `A02 · ${st}：快照里那道题的 evidence.ok`)
    }
    chkEq(liveVerdict.broken, st !== 'ok' && st !== 'missing', `A02 · ${st}：liveLedgerVerdict 的不可信判定（empty/invalid/io-error 才算不可信）`)

    // io-error 与 empty **不是同一件事**：不许折成空账，也不许只在措辞上相同
    if (st === 'io-error') {
      chk(live.problems.length >= 1, 'A02 · io-error：读取故障必须如实进 problems（不吞）')
      chk(!/空账/.test(joined), 'A02 · io-error 不许被折成"空账"')
      chk(/读不动/.test(joined), 'A02 · io-error 的修法必须说"读不动（码）"')
      chkEq(gate.evidenceStatus, 'io-error', 'A02 · io-error：门禁回执里的五态')
    }
    if (st === 'empty') {
      chkEq(live.problems.length, 0, 'A02 · empty：空账不是坏账（problems 必须为空）')
      chk(/空账/.test(joined), 'A02 · empty 必须明确说"空账是明确不足"')
      chk(!/读不动/.test(joined), 'A02 · empty 不许说成"读不动"')
    }
  }

  /* 注入式 EACCES：读取故障的另一条路径，也必须如实保留系统错误码（不折成空） */
  {
    const root = makeOneCirclePack('a02-eacces', { evidence: [evidenceLine('a/x/0001')] })
    const live = hosts.evidenceIo.readEvidence(root, { fs: deniedFs('EACCES') })
    const judged = hosts.state.judgeChallenges({}, [EV_CHALLENGE(1, 'run')], { lessons: ['a/x/0001'], evidence: live })
    observed.eacces = { status: live.status, errorCode: live.errorCode, exists: live.exists, blocked: judged.evidenceBlocked, hint: (judged.evidenceGaps[0] || {}).hint?.slice(0, 90) }
    chkEq(live.status, 'io-error', 'A02 · EACCES：读不动必须是 io-error（不是 empty / missing）')
    chkEq(live.errorCode, 'EACCES', 'A02 · EACCES：系统错误码原样保留')
    chkEq(live.exists, true, 'A02 · EACCES：路径上有东西（只是读不动）')
    chkEq(judged.evidenceBlocked.length, 1, 'A02 · EACCES：声明了 minEvidence 的题必须阻断')
    chkEq(judged.evidenceFallback, false, 'A02 · EACCES：读取故障不许走 missing 的回退')
    chk(/读不动\*\*（EACCES）/.test(String(observed.eacces.hint || '')), 'A02 · EACCES：回执必须说清"读不动（EACCES）"')
  }

  /* `ledgerStatusOf` 对**旧字段形状**也归一成同一套五态（兼容旧调用方，不另立口径） */
  {
    const cases = [
      ['null', null, 'missing'],
      ['exists:false', { exists: false, entries: [], problems: [] }, 'missing'],
      ['exists:true 零条', { exists: true, entries: [], problems: [] }, 'empty'],
      ['有记录', { exists: true, entries: [{ lesson: 'a/x/0001', challenge: 1, kind: 'run' }], problems: [] }, 'ok'],
      ['有坏行', { exists: true, entries: [], problems: ['坏'] }, 'invalid'],
      ['新读法 status', { status: 'io-error', exists: true, entries: [], problems: [], errorCode: 'EISDIR' }, 'io-error'],
    ]
    observed.ledgerStatusOf = []
    for (const [label, input, want] of cases) {
      const got = hosts.core.ledgerStatusOf(input)
      observed.ledgerStatusOf.push({ label, got, want })
      chkEq(got, want, `A02 · ledgerStatusOf(${label})`)
    }
    sameJsonNoThrow(hosts.core.LEDGER_STATUSES, [...FIVE_STATES], note, 'A02 · 五态词表的顺序即契约')
    sameJsonNoThrow(hosts.core.LEDGER_STATUSES, hosts.state.EVIDENCE_STATUSES, note, 'A02 · state.js 的五态词表必须与内核同一份')
    chkEq(hosts.core.isBrokenStatus('empty'), false, 'A02 · empty 不是"坏账"（它是明确不足）')
    chkEq(hosts.core.isBrokenStatus('invalid'), true, 'A02 · invalid 是坏账')
    chkEq(hosts.core.isBrokenStatus('io-error'), true, 'A02 · io-error 是坏账')
  }

  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A03：损坏账本不能通过旧快照继续点亮
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * A03 的本体：快照在台账**还好的时候**写成（旧判词说"够档"），之后台账坏掉 / 变空 / 读不动 ——
 * 插件门禁与包侧 `/progress` 必须**两侧都**拦，进度里不许多出那门课；恢复台账后又能点亮（不是死锁）。
 *
 * @param {string[]} variants 破坏方式（默认 empty/invalid/io-error）
 */
export async function judgeStaleSnapshot(hosts, variants = ['empty', 'invalid', 'io-error']) {
  const violations = []
  const note = (m) => violations.push(m)
  const chk = (cond, m) => { if (!cond) note(m) }
  const chkEq = (actual, expected, m) => { if (actual !== expected) note(`${m}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`) }
  const observed = {}

  for (const st of variants) {
    const root = packForState(`a03-${st}`, 'ok')
    const good = probeAndWrite(hosts, root)
    const lesson = lessonOf(good.state, 'code/a/x', 'x/0001')
    const evCh = lesson.challenges.find((c) => c.no === 1)
    const oldJudgement = evCh && evCh.evidence ? evCh.evidence : null
    const ev = path.join(root, 'learning-records', 'evidence.jsonl')
    // 快照写成之后，台账才出问题（证据台账不在 sourceDigest 里 ⇒ 快照仍然"新鲜"）
    if (st === 'empty') fs.writeFileSync(ev, '', 'utf8')
    if (st === 'invalid') writeText(ev, '这不是JSON{{{\n')
    if (st === 'io-error') { fs.rmSync(ev, { force: true }); fs.mkdirSync(ev, { recursive: true }) }

    const pack = hosts.model.readPack(root)
    const gate = hosts.gate.challengeGate({ root, pack, point: 'a/x', probe: false })
    const srv = serverize(root)
    const lit = await callPack(srv.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
    const progress = JSON.parse(readText(path.join(root, 'progress.json')))
    observed[st] = {
      oldJudgement,
      gate: { allowed: gate.allowed, code: gate.code, evidenceStatus: gate.evidenceStatus ?? null, gaps: (gate.evidenceGaps || []).map((g) => g.hint.slice(0, 90)) },
      packSide: { status: lit.status, ok: lit.body && lit.body.ok, code: lit.body && lit.body.code, evidenceGaps: ((lit.body || {}).evidenceGaps || []).map((g) => g.hint.slice(0, 90)) },
      learned: progress.learned,
    }

    chk(oldJudgement && oldJudgement.ok === true, `A03/${st}：快照里的旧判词必须本来是"够档"（否则这条判据空转）`)
    chkEq(gate.allowed, false, `A03/${st}：台账坏掉之后门禁必须拦住（旧快照的判词作废）`)
    chkEq(gate.code, 'evidence-insufficient', `A03/${st}：门禁判词码`)
    chkEq(gate.evidenceStatus, st, `A03/${st}：门禁回执里的五态`)
    chk((gate.evidenceGaps || []).length === 1, `A03/${st}：门禁必须逐条说清哪道题、差哪一档`)
    chk(/learning-records\/evidence\.jsonl/.test(JSON.stringify(gate.evidenceGaps || [])), `A03/${st}：修法必须指向台账文件`)
    chkEq(lit.body && lit.body.ok, false, `A03/${st}：包侧 /progress 也不许点亮`)
    chkEq(lit.body && lit.body.code, 'evidence-insufficient', `A03/${st}：包侧判词码必须与插件同一词表`)
    chk(!progress.learned.includes('a/x/0001'), `A03/${st}：被拦住时进度里不许出现那门课（旧快照不能继续点亮）`)

    // 恢复台账 ⇒ 立刻能点亮（拦住 ≠ 死锁）
    fs.rmSync(ev, { recursive: true, force: true })
    writeText(ev, `${evidenceLine('a/x/0001')}\n`)
    const gate2 = hosts.gate.challengeGate({ root, pack: hosts.model.readPack(root), point: 'a/x', probe: false })
    const lit2 = await callPack(srv.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
    const progress2 = JSON.parse(readText(path.join(root, 'progress.json')))
    observed[st].recovered = { gateAllowed: gate2.allowed, gateCode: gate2.code, packOk: lit2.body && lit2.body.ok, learned: progress2.learned }
    chkEq(gate2.allowed, true, `A03/${st}：台账修好之后门禁必须放行（不是死锁）`)
    chkEq(lit2.body && lit2.body.ok, true, `A03/${st}：台账修好之后包侧必须能点亮`)
    chk(progress2.learned.includes('a/x/0001'), `A03/${st}：恢复后进度里应当真的点亮`)
  }

  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04：真正缺失的既有业务回退策略不被扩大
 * ══════════════════════════════════════════════════════════════════════ */

/** A04 的本体：只有 `missing`（真 ENOENT）回退，其余四态一个都不回退。 */
export async function judgeFallbackLimits(hosts) {
  const violations = []
  const note = (m) => violations.push(m)
  const chk = (cond, m) => { if (!cond) note(m) }
  const chkEq = (actual, expected, m) => { if (actual !== expected) note(`${m}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`) }
  const observed = { table: {} }

  for (const st of FIVE_STATES) {
    const root = packForState('a04', st)
    const live = hosts.evidenceIo.readEvidence(root)
    const judged = hosts.state.judgeChallenges({}, [EV_CHALLENGE(1, 'run')], { lessons: ['a/x/0001'], evidence: live })
    const { pack, state } = probeAndWrite(hosts, root)
    const lesson = lessonOf(state, 'code/a/x', 'x/0001')
    const gate = hosts.gate.challengeGate({ root, pack, point: 'a/x', probe: false })
    observed.table[st] = {
      fallback: judged.evidenceFallback,
      snapshotFallback: lesson.evidenceFallback,
      blocked: judged.evidenceBlocked,
      gate: { allowed: gate.allowed, fallback: gate.evidenceFallback === true, code: gate.code },
    }
    chkEq(judged.evidenceFallback, st === 'missing', `A04 · ${st}：只有 missing 允许回退（既有防死锁策略不扩大）`)
    chkEq(lesson.evidenceFallback, st === 'missing', `A04 · ${st}：快照里的 evidenceFallback 只许在 missing 时置真`)
    chkEq(judged.evidenceBlocked.length > 0, st !== 'missing' && st !== 'ok', `A04 · ${st}：非 missing 的坏态必须阻断`)
    chkEq(gate.allowed, st === 'missing' || st === 'ok', `A04 · ${st}：门禁放行面`)
    if (st === 'missing') {
      chkEq(gate.evidenceFallback, true, 'A04 · missing：门禁必须**显式说出来**这一档没判（不许静默变松）')
      chkEq(judged.challenges[0].evidence, null, 'A04 · missing：回退时那道题不带 evidence 判词（不假装判过）')
      chkEq(judged.challenges[0].needsReview, true, 'A04 · missing：回退时那道题落在 needsReview（不冒充机器判过）')
    }
  }

  /* 常量与边界：回退态**只有** missing 一个；空 / 坏 / 读不动都不在里头 */
  chkEq(hosts.core.FALLBACK_STATUS, 'missing', 'A04 · 内核里允许回退的态必须**只有** missing')
  chkEq(hosts.core.LEDGER_STATUSES.length, 5, 'A04 · 五态不许增删')
  chkEq(hosts.core.LEDGER_STATUSES.filter((s) => s === hosts.core.FALLBACK_STATUS).length, 1, 'A04 · 回退态在五态里唯一')

  /* 包侧同一条：missing ⇒ ok + evidenceFallback:true；empty ⇒ ok:false（既有回退不许扩到空账） */
  {
    const rootMissing = packForState('a04-pack-missing', 'missing')
    probeAndWrite(hosts, rootMissing)
    const srvMissing = serverize(rootMissing)
    const rMissing = await callPack(srvMissing.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
    observed.packMissing = { ok: rMissing.body && rMissing.body.ok, fallback: rMissing.body && rMissing.body.evidenceFallback, lit: (rMissing.body && rMissing.body.learned) || [] }
    chkEq(rMissing.body && rMissing.body.ok, true, 'A04 · 包侧：台账真不存在时按既有策略放行（防死锁）')
    chkEq(rMissing.body && rMissing.body.evidenceFallback, true, 'A04 · 包侧：回退必须显式回执 evidenceFallback:true')

    const rootEmpty = packForState('a04-pack-empty', 'empty')
    probeAndWrite(hosts, rootEmpty)
    const srvEmpty = serverize(rootEmpty)
    const rEmpty = await callPack(srvEmpty.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
    observed.packEmpty = { ok: rEmpty.body && rEmpty.body.ok, code: rEmpty.body && rEmpty.body.code, fallback: rEmpty.body && rEmpty.body.evidenceFallback }
    chkEq(rEmpty.body && rEmpty.body.ok, false, 'A04 · 包侧：空账**不许**吃 missing 的回退（否则就是扩大策略）')
    chkEq(rEmpty.body && rEmpty.body.code, 'evidence-insufficient', 'A04 · 包侧：空账必须按证据不够拦')
  }

  /* 回退是"台账还没建立"的临时态：贴第一条证据之后必须自动关闭 */
  {
    const root = packForState('a04-append', 'missing')
    const before = probeAndWrite(hosts, root).state
    const w = hosts.evidenceIo.appendEvidence(root, { lesson: 'a/x/0001', challenge: 1, kind: 'run' })
    chkEq(w.ok, true, 'A04 · 真缺失时写口必须能建立台账（回退不是"不让写"）')
    const after = probeAndWrite(hosts, root).state
    const lb = lessonOf(before, 'code/a/x', 'x/0001')
    const la = lessonOf(after, 'code/a/x', 'x/0001')
    observed.fallbackCloses = { before: lb.evidenceFallback, after: la.evidenceFallback, afterEvOk: la.challenges[0].evidence && la.challenges[0].evidence.ok }
    chkEq(lb.evidenceFallback, true, 'A04 · 贴证据前：回退开关为真')
    chkEq(la.evidenceFallback, false, 'A04 · 贴证据后：回退开关必须关闭（回退只覆盖"还没台账"）')
    chkEq(la.challenges[0].evidence && la.challenges[0].evidence.ok, true, 'A04 · 贴证据后：那道题必须真的够档')
  }

  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05：空证据与 IO 故障分别给出明确结果
 * ══════════════════════════════════════════════════════════════════════ */

/** A05 的本体：空账 vs 读不动 —— 两种病、两句修法；空账可继续写，读不动连写前字节都读不到。 */
export function judgeEmptyVsIo(hosts) {
  const violations = []
  const note = (m) => violations.push(m)
  const chk = (cond, m) => { if (!cond) note(m) }
  const chkEq = (actual, expected, m) => { if (actual !== expected) note(`${m}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`) }
  const observed = {}

  /* ① 空账：明确不足，但**不是坏账** —— 写口可以把它变成"有记录" */
  {
    const root = makeOneCirclePack('a05-empty', { evidence: [] })
    const live = hosts.evidenceIo.readEvidence(root)
    const judged = hosts.state.judgeChallenges({}, [EV_CHALLENGE(1, 'run')], { lessons: ['a/x/0001'], evidence: live })
    const hint = (judged.evidenceGaps[0] || {}).hint || ''
    const verdict = hosts.core.liveLedgerVerdict(live, { needsEvidence: true })
    const w = hosts.evidenceIo.appendEvidence(root, { lesson: 'a/x/0001', challenge: 1, kind: 'run' })
    const after = hosts.evidenceIo.readEvidence(root)
    observed.empty = {
      status: live.status, exists: live.exists, problems: live.problems.length,
      hint: hint.slice(0, 140), verdict: { broken: verdict.broken, why: verdict.why },
      write: { ok: w.ok, state: w.state }, afterStatus: after.status, afterEntries: after.entries.length,
    }
    chkEq(live.status, 'empty', 'A05 · 空文件必须读成 empty（不是 missing）')
    chkEq(live.exists, true, 'A05 · 空文件 exists 必须为真')
    chkEq(live.problems.length, 0, 'A05 · 空账没有坏记录（不许把它说成坏账）')
    chkEq(judged.evidenceBlocked.length, 1, 'A05 · 空账必须阻断已声明的 minEvidence')
    chk(/空账/.test(hint), 'A05 · 空账的修法必须点明"空账是明确不足"')
    chk(!/读不动/.test(hint), 'A05 · 空账的修法不许写成"读不动"（两种病两句修法）')
    chkEq(verdict.broken, true, 'A05 · 空账会让旧快照的证据判词不可信（broken）')
    chkEq(w.ok, true, 'A05 · 空账上必须能追加（写口不是死路）')
    chkEq(after.status, 'ok', 'A05 · 追加之后台账变成 ok')
  }

  /* ② IO 故障（路径是目录）：读不动 —— 连写前字节都读不到，写口必须在事务内拒 */
  {
    const root = makeOneCirclePack('a05-iodir', { evidence: null })
    const ev = path.join(root, 'learning-records', 'evidence.jsonl')
    fs.mkdirSync(ev, { recursive: true })
    const live = hosts.evidenceIo.readEvidence(root)
    const judged = hosts.state.judgeChallenges({}, [EV_CHALLENGE(1, 'run')], { lessons: ['a/x/0001'], evidence: live })
    const hint = (judged.evidenceGaps[0] || {}).hint || ''
    const verdict = hosts.core.liveLedgerVerdict(live, { needsEvidence: true })
    const w = hosts.evidenceIo.appendEvidence(root, { lesson: 'a/x/0001', challenge: 1, kind: 'run' })
    observed.ioDir = {
      status: live.status, exists: live.exists, errorCode: live.errorCode, problems: live.problems.length,
      hint: hint.slice(0, 140), verdict: { broken: verdict.broken, why: verdict.why, errorCode: verdict.errorCode },
      write: { ok: w.ok, reason: w.reason, state: w.state, retryable: w.retryable === true, error: String(w.error || '').slice(0, 140) },
      stillDir: fs.statSync(ev).isDirectory(),
    }
    chkEq(live.status, 'io-error', 'A05 · 目录路径必须读成 io-error')
    chkEq(live.errorCode, 'EISDIR', 'A05 · 目录路径必须保留 EISDIR')
    chkEq(live.exists, true, 'A05 · 读取故障时 exists 为真（不等于"不存在"）')
    chkEq(judged.evidenceBlocked.length, 1, 'A05 · 读不动必须阻断')
    chk(/读不动/.test(hint), 'A05 · 读不动的修法必须点明"读不动"')
    chk(!/空账/.test(hint), 'A05 · 读不动不许写成"空账"')
    chkEq(verdict.broken, true, 'A05 · 读不动会让旧快照的证据判词不可信（broken）')
    chkEq(verdict.errorCode, 'EISDIR', 'A05 · liveLedgerVerdict 必须带出系统错误码')
    chkEq(w.ok, false, 'A05 · 读不动时写口必须拒（不许在"读不到前态"的基础上写）')
    chkEq(w.reason, 'io', 'A05 · 读不动属于 IO 类失败（不是"请求被拒"）')
    chk(/读不到|写前字节/.test(String(w.error || '')), 'A05 · 拒绝理由必须说清"读不到写前字节"')
    chkEq(fs.statSync(ev).isDirectory(), true, 'A05 · 被拒之后那条路径仍是目录（一个字节都不许替换）')
  }

  /* ③ 两种病的**回执不同**（同一道题、同一档证据要求，只有病的种类不同） */
  {
    const h1 = observed.empty.hint
    const h2 = observed.ioDir.hint
    chk(h1 !== h2, 'A05 · 空账与读不动的回执必须不是同一句')
    chk(/空账/.test(h1) && !/先修好/.test(h1), 'A05 · 空账的回执不指向"先修好台账"（它压根没坏，是"一条都没有"）')
    chk(/修好/.test(h2), 'A05 · 读不动的回执必须说"修好台账"（写口会拒，再贴一条不是修法）')
  }

  /* ④ `brokenWhyText` 也只剩一处口径：五态里只有两种"坏"有措辞 */
  {
    const texts = FIVE_STATES.map((s) => hosts.core.brokenWhyText(s, { problems: ['例'], errorCode: 'EISDIR' }))
    observed.brokenWhy = texts
    chkEq(texts[0], '', 'A05 · missing 没有"坏"的措辞')
    chkEq(texts[1], '', 'A05 · empty 没有"坏"的措辞（它是明确不足，另有措辞）')
    chkEq(texts[2], '', 'A05 · ok 没有"坏"的措辞')
    chk(/损坏/.test(texts[3]), 'A05 · invalid 的措辞说"损坏"')
    chk(/读不动/.test(texts[4]), 'A05 · io-error 的措辞说"读不动"')
  }

  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A06：宿主与包侧判定一致 + 记录写口共用提交
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * A06 的本体：
 *   ① 五态下插件 `challengeGate` 与包侧 `POST /progress` 的判词码 / 回执逐字相同；
 *   ② 模板 `ask-server` 的 `/ask` `/note` 经 `tools/unify/records.cjs`（+ `./unify/commit.cjs`）
 *      提交，与宿主 `lib/ask-io.js` / `lib/notes-io.js` **共用一本台账与一个计数器**；
 *   ③ 反向自证：把副本里的 `commit.cjs` 打坏 ⇒ 写口必须失败且一个字节不落（证明提交真的经过 U06）；
 *   ④ R1 边界：副本缺 `records.cjs` 时写口必须**明确失败**，不许退回第二份记录实现。
 */
export async function judgeParityAndRecords(hosts) {
  const violations = []
  const note = (m) => violations.push(m)
  const chk = (cond, m) => { if (!cond) note(m) }
  const chkEq = (actual, expected, m) => { if (actual !== expected) note(`${m}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`) }
  const observed = { parity: {}, port: {}, mutation: {}, r1: {} }

  /* ① 五态：同一份快照 + 同一本台账，两侧判词必须一致 */
  for (const st of FIVE_STATES) {
    const root = packForState(`a06-${st}`, st)
    const { pack } = probeAndWrite(hosts, root)
    const plugin = hosts.gate.challengeGate({ root, pack, point: 'a/x', probe: false })
    const srv = serverize(root)
    const r = await callPack(srv.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
    const body = r.body || {}
    const pluginCode = plugin.allowed ? 'ok' : plugin.code
    const packCode = body.ok === true ? 'ok' : body.code
    const pluginHints = (plugin.evidenceGaps || []).map((g) => g.hint)
    const packHints = (body.evidenceGaps || []).map((g) => g.hint)
    observed.parity[st] = {
      plugin: { allowed: plugin.allowed, code: pluginCode, hints: pluginHints.map((h) => h.slice(0, 70)), fallback: plugin.evidenceFallback === true },
      pack: { ok: body.ok, code: packCode, hints: packHints.map((h) => h.slice(0, 70)), fallback: body.evidenceFallback === true },
    }
    chkEq(packCode, pluginCode, `A06 · ${st}：宿主与包侧的判词码必须一致`)
    chkEq(body.ok, plugin.allowed, `A06 · ${st}：宿主与包侧的放行结论必须一致`)
    sameJsonNoThrow(packHints, pluginHints, note, `A06 · ${st}：两侧的回执那句话必须逐字相同（同一台生成的）`)
    if (st === 'missing') chkEq(body.evidenceFallback, plugin.evidenceFallback === true, `A06 · ${st}：两侧的 evidenceFallback 必须一致`)
  }

  /* ② 记录写口：包侧与宿主共用一本台账 + 一个计数器 */
  {
    const root = makeOneCirclePack('a06-port', { evidence: [evidenceLine('a/x/0001')] })
    const srv = serverize(root)
    const q1 = await callPack(srv.ask, 'POST', '/ask', { question: '第一问', lesson: 'a/x/0001', page: 'lessons/a/x/0001-lesson.html', title: '夹具' })
    const q2 = await callPack(srv.ask, 'POST', '/ask', { question: '第二问' })
    const askSeqAfterPack = readText(path.join(root, 'questions', 'seq.txt'))
    const pendingLines = readText(path.join(root, 'questions', 'pending.jsonl')).split('\n').filter((l) => l.trim())
    const n1 = await callPack(srv.ask, 'POST', '/note', { text: '第一条笔记', lesson: 'a/x/0001' })
    const n2 = await callPack(srv.ask, 'POST', '/note', { text: '第二条笔记', anchor: 'a/x/0001', date: '2026-10-20' })
    const noteSeqAfterPack = readText(path.join(root, 'notes', 'seq.txt'))
    const noteLinesBeforeHost = readText(path.join(root, 'notes', 'notes.jsonl')).split('\n').filter((l) => l.trim())
    // 宿主入口接着发号（同一个 seq 文件、同一本台账）
    const hostAsk = await hosts.askIo.handleAsk(root, { raw: JSON.stringify({ question: '宿主第三问', lesson: 'a/x/0001' }) })
    const askSeqAfterHost = readText(path.join(root, 'questions', 'seq.txt'))
    const hostNote = hosts.notesIo.appendNote({ root, text: '宿主第三条笔记', anchor: 'a/x/0001' })
    const noteSeqAfterHost = readText(path.join(root, 'notes', 'seq.txt'))
    const noteLinesAfterHost = readText(path.join(root, 'notes', 'notes.jsonl')).split('\n').filter((l) => l.trim())
    const pendingAfterHost = readText(path.join(root, 'questions', 'pending.jsonl')).split('\n').filter((l) => l.trim())
    observed.port = {
      askIds: [q1.body && q1.body.id, q2.body && q2.body.id],
      noteIds: [n1.body && n1.body.id, n2.body && n2.body.id],
      askSeqAfterPack, askSeqAfterHost, pendingLines: pendingLines.length, pendingAfterHost: pendingAfterHost.length,
      noteSeqAfterPack, noteSeqAfterHost, noteLinesBeforeHost: noteLinesBeforeHost.length, noteLinesAfterHost: noteLinesAfterHost.length,
      hostAsk: { status: hostAsk.status, id: hostAsk.body && hostAsk.body.id },
      hostNote: { id: hostNote && hostNote.id, seq: hostNote && hostNote.seq, bytes: hostNote && hostNote.bytes },
      copies: srv.copies.length,
    }
    sameJsonNoThrow(observed.port.askIds, ['0001', '0002'], note, 'A06 · 包侧 /ask 的编号必须是 0001/0002')
    chkEq(askSeqAfterPack, '2', 'A06 · 包侧 /ask 的计数器在同一个 seq 文件里（"2"）')
    chkEq(pendingLines.length, 2, 'A06 · 包侧 /ask 两条记录在同一个队列文件里')
    sameJsonNoThrow(observed.port.noteIds, ['0001', '0002'], note, 'A06 · 包侧 /note 的编号必须是 0001/0002')
    chkEq(noteSeqAfterPack, '2\n', 'A06 · 包侧 /note 的计数器写法与既有契约一致（"2\\n"）')
    chkEq(hostAsk.status, 200, 'A06 · 宿主 handleAsk 必须成功')
    chkEq(hostAsk.body && hostAsk.body.id, '0003', 'A06 · 宿主入口必须接着包侧的计数器发号（0003 ⇒ 同一个计数器）')
    chkEq(askSeqAfterHost, '3', 'A06 · 宿主写完之后 seq.txt 必须是 3')
    chkEq(hostNote && hostNote.id, '0003', 'A06 · 宿主 appendNote 必须接着包侧的计数器发号（0003）')
    chkEq(noteSeqAfterHost, '3\n', 'A06 · 宿主写完之后 notes/seq.txt 必须是 "3\\n"')
    chkEq(noteLinesBeforeHost.length, 2, 'A06 · 包侧 /note 两条记录在同一个台账文件里')
    chkEq(noteLinesAfterHost.length, 3, 'A06 · 宿主追加之后是同一个台账文件里的第 3 行（一本台账）')
    chkEq(pendingAfterHost.length, 3, 'A06 · 宿主追问之后是同一个队列文件里的第 3 行（一本台账）')
    const noteRows = noteLinesAfterHost.map((l) => JSON.parse(l))
    chkEq(noteRows[1].date, '2026-10-20', 'A06 · 显式给出的 date 必须逐字落盘（不许默认"今天"）')
    chkEq(noteRows[2].date, undefined, 'A06 · 没给 date 时不许补一个日期')
    chkEq(Object.keys(noteRows[2]).join(','), 'id,seq,kind,anchor,text', 'A06 · 笔记记录的键序必须沿用既有契约')
    // 副本与仓内是**同一份**内核字节（不是第二份实现）
    for (const copy of srv.copies) {
      const repoFile = path.join(REPO, 'lib', 'unify', path.basename(copy.rel))
      chkEq(copy.sha256, sha256(fs.readFileSync(repoFile)), `A06 · 副本 ${copy.rel} 必须与仓内核逐字节相同（同一份实现）`)
    }
    chkEq(srv.copies.length, fs.readdirSync(path.join(REPO, 'lib', 'unify')).filter((n) => n.endsWith('.cjs')).length,
      'A06 · 副本内核的个数必须等于仓内 lib/unify 的 .cjs 个数')
  }

  /* ②b 撞号：seq 落后于台账 ⇒ 保留既有的 400 与逐字文案（只追加不覆盖） */
  {
    const root = makeOneCirclePack('a06-clash', { evidence: null })
    writeText(path.join(root, 'notes', 'seq.txt'), '0')
    writeText(path.join(root, 'notes', 'notes.jsonl'), `${JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: 'a/x/0001', text: '旧笔记' })}\n`)
    const srv = serverize(root)
    const r = await callPack(srv.ask, 'POST', '/note', { text: '撞号的新笔记', anchor: 'a/x/0001' })
    observed.port.clash = { status: r.status, ok: r.body && r.body.ok, error: r.body && r.body.error }
    chkEq(r.status, 400, 'A06 · 撞号必须回 400（既有契约）')
    chk(/已存在/.test(String((r.body || {}).error || '')), 'A06 · 撞号文案必须还是「已存在（seq.txt 落后于台账？）：只追加不覆盖」')
    chkEq(readText(path.join(root, 'notes', 'notes.jsonl')).split('\n').filter((l) => l.trim()).length, 1, 'A06 · 撞号时台账一个字节都不许动')
  }

  /* ③ 反向自证：把副本里的 commit.cjs 打坏 ⇒ 写口必须失败且不落字节（提交真的经过 U06） */
  {
    const root = makeOneCirclePack('a06-mutant-commit', { evidence: null })
    let patch = null
    const anchor = 'function applyCommit(root, plan, opts = {}) {'
    const srv = serverize(root, (toolsDir) => {
      const f = path.join(toolsDir, 'unify', 'commit.cjs')
      const before = readText(f)
      assert(before.includes(anchor), 'A06 · 变异锚点（applyCommit）在 commit.cjs 里找不到 —— 变异失效')
      const forced = `${anchor}\n\treturn { ok: false, state: 'rejected', code: 'MUTANT_COMMIT_BLOCKED', error: '变异：绕过 U06 提交（A06 反向自证）', failure: null, rollbackError: null, journal: null, txnId: null, value: undefined }`
      writeText(f, before.replace(anchor, forced))
      patch = { file: 'tools/unify/commit.cjs', shaBefore: sha256(before), shaAfter: sha256(readText(f)) }
    })
    const r = await callPack(srv.ask, 'POST', '/ask', { question: '提交被打坏时的一问' })
    observed.mutation = {
      patch,
      status: r.status,
      code: r.body && r.body.code,
      pendingExists: fs.existsSync(path.join(root, 'questions', 'pending.jsonl')),
      seqExists: fs.existsSync(path.join(root, 'questions', 'seq.txt')),
    }
    chkEq(r.status, 500, 'A06 · 提交被绕过时写口必须失败（不许假装写成功）')
    chkEq((r.body || {}).ok, false, 'A06 · 提交被绕过时回执必须 ok:false')
    chkEq((r.body || {}).code, 'WRITE_FAILED', 'A06 · 提交被绕过时的回执码（既有词汇表不变）')
    chkEq(fs.existsSync(path.join(root, 'questions', 'pending.jsonl')), false, 'A06 · 提交被绕过时一个字节都不许落（没有第二份写路径）')
    chkEq(fs.existsSync(path.join(root, 'questions', 'seq.txt')), false, 'A06 · 提交被绕过时序号也不许前进')
  }

  /* ④ R1 边界：副本缺 records.cjs ⇒ 写口**明确失败**（不许退回第二份记录实现） */
  {
    const root = makeOneCirclePack('a06-r1', { evidence: null })
    const srv = serverize(root)
    fs.rmSync(path.join(root, 'tools', 'unify', 'records.cjs'), { force: true })
    const r = await callPack(srv.ask, 'POST', '/ask', { question: '记录内核缺失时的一问' })
    const rn = await callPack(srv.ask, 'POST', '/note', { text: '记录内核缺失时的一条笔记', anchor: 'a/x/0001' })
    observed.r1 = {
      ask: { status: r.status, ok: r.body && r.body.ok, code: r.body && r.body.code },
      note: { status: rn.status, ok: rn.body && rn.body.ok, code: rn.body && rn.body.code },
      pendingExists: fs.existsSync(path.join(root, 'questions', 'pending.jsonl')),
      notesExists: fs.existsSync(path.join(root, 'notes', 'notes.jsonl')),
    }
    chkEq(r.status, 500, 'A06 · R1：副本缺 records.cjs 时 /ask 必须明确失败（不是 200）')
    chkEq((r.body || {}).ok, false, 'A06 · R1：/ask 必须 ok:false')
    chkEq(rn.status, 500, 'A06 · R1：副本缺 records.cjs 时 /note 必须明确失败')
    chkEq(fs.existsSync(path.join(root, 'questions', 'pending.jsonl')), false, 'A06 · R1：明确失败时不许落任何字节')
    chkEq(fs.existsSync(path.join(root, 'notes', 'notes.jsonl')), false, 'A06 · R1：明确失败时不许落任何字节')
  }

  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07：临时让包侧只信旧快照后判据必须红（只在 E:\Temp 副本）
 * ══════════════════════════════════════════════════════════════════════ */

/** A07 的本体：副本里把「现读复核」短路掉 ⇒ 同一夹具下它必须回 ok 并点亮；干净副本必须拦住。 */
export async function judgeSnapshotOnlyMutation() {
  const violations = []
  const note = (m) => violations.push(m)
  const chk = (cond, m) => { if (!cond) note(m) }
  const chkEq = (actual, expected, m) => { if (actual !== expected) note(`${m}（期望 ${fmt(expected)}，实得 ${fmt(actual)}）`) }
  const observed = {}

  const cleanRoot = packForState('a07-clean', 'ok')
  const mutantRoot = packForState('a07-mutant', 'ok')
  const hosts = await loadHosts()
  // 两个包的快照都在"台账好的时候"写成（旧判词说"够档"）
  const cleanSnap = probeAndWrite(hosts, cleanRoot)
  const mutantSnap = probeAndWrite(hosts, mutantRoot)
  const cleanOld = lessonOf(cleanSnap.state, 'code/a/x', 'x/0001').challenges.find((c) => c.no === 1).evidence
  const mutantOld = lessonOf(mutantSnap.state, 'code/a/x', 'x/0001').challenges.find((c) => c.no === 1).evidence

  const ANCHOR = 'if (verdict.broken) liveBroken = verdict;'
  let patchInfo = null
  const srvClean = serverize(cleanRoot)
  const srvMutant = serverize(mutantRoot, (toolsDir) => {
    const f = path.join(toolsDir, 'ask-server.js')
    const before = readText(f)
    assert(before.includes(ANCHOR), 'A07 · 变异锚点（现读复核那一行）在 ask-server 里找不到 —— 变异失效')
    const after = before.replace(ANCHOR, 'if (false && verdict.broken) liveBroken = verdict;')
    assert(after !== before, 'A07 · 变异没生效（替换后字节相同）')
    writeText(f, after)
    patchInfo = { rel: 'tools/ask-server.js', from: ANCHOR, to: 'if (false && verdict.broken) liveBroken = verdict;', shaBefore: sha256(before), shaAfter: sha256(after) }
  })

  // 快照写成之后，两个包的台账才坏掉
  const corrupt = (root) => writeText(path.join(root, 'learning-records', 'evidence.jsonl'), '这不是JSON{{{\n')
  corrupt(cleanRoot)
  corrupt(mutantRoot)

  const rc = await callPack(srvClean.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
  const rm = await callPack(srvMutant.ask, 'POST', '/progress', { lesson: 'a/x/0001', done: true })
  const progressClean = JSON.parse(readText(path.join(cleanRoot, 'progress.json')))
  const progressMutant = JSON.parse(readText(path.join(mutantRoot, 'progress.json')))
  Object.assign(observed, {
    patch: patchInfo,
    oldJudgements: { clean: cleanOld && cleanOld.ok, mutant: mutantOld && mutantOld.ok },
    clean: { status: rc.status, ok: rc.body && rc.body.ok, code: rc.body && rc.body.code, learned: progressClean.learned },
    mutant: { status: rm.status, ok: rm.body && rm.body.ok, code: rm.body && rm.body.code, learned: progressMutant.learned },
  })

  chkEq(cleanOld && cleanOld.ok, true, 'A07 · 干净副本的快照旧判词必须本来是"够档"（否则变异对比没意义）')
  chkEq(mutantOld && mutantOld.ok, true, 'A07 · 变异副本的快照旧判词也必须本来是"够档"')
  chkEq(rc.body && rc.body.ok, false, 'A07 · 干净副本：台账坏掉之后必须拦住（对照组）')
  chkEq(rc.body && rc.body.code, 'evidence-insufficient', 'A07 · 干净副本的判词码')
  chk(!progressClean.learned.includes('a/x/0001'), 'A07 · 干净副本：不许点亮')
  chkEq(rm.body && rm.body.ok, true, 'A07 · 变异副本（只信旧快照）**必须**回 ok —— 否则 A03 那条判据是空转的')
  chk(progressMutant.learned.includes('a/x/0001'), 'A07 · 变异副本必须把课点亮（证明"只信旧快照"真的会让坏账通过）')

  // 变异只发生在 E:\Temp 副本：干净副本与仓内逐字节相同，仓内一个字节没动
  const repoAbs = path.join(REPO, ...HOST.askServer.split('/'))
  const repoAsk = readText(repoAbs)
  const cleanAsk = readText(path.join(cleanRoot, 'tools', 'ask-server.js'))
  const mutantAsk = readText(path.join(mutantRoot, 'tools', 'ask-server.js'))
  observed.bytes = {
    repo: sha256(repoAsk).slice(0, 16),
    clean: sha256(cleanAsk).slice(0, 16),
    mutant: sha256(mutantAsk).slice(0, 16),
    atStart: String(BOOT_SHA.get(HOST.askServer) || '').slice(0, 16),
  }
  chkEq(sha256(cleanAsk), sha256(repoAsk), 'A07 · 干净副本必须与仓内 ask-server 逐字节相同')
  chk(sha256(mutantAsk) !== sha256(repoAsk), 'A07 · 变异副本必须真的与仓内不同（变异发生了）')
  chkEq(BOOT_SHA.get(HOST.askServer), sha256(repoAsk), 'A07 · 仓内 ask-server 的字节必须与本次进程开始时一致（变异只在副本里）')
  const touched = WRITE_GUARD.writes.filter((w) => w.target === path.resolve(repoAbs))
  chkEq(touched.length, 0, 'A07 · 本进程一次都不许写仓内的 ask-server（变异只在副本里）')

  return { observed, violations }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08：既有断言冲突闸（纯函数 + 自证）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 从既有测试源码里认出"依赖**旧的证据 / 门禁形状**"的断言。
 * 命中就会被列出来（本卡一条既有测试都没改 —— 命中的必须**已经**是别的卡的授权面，
 * 或登记在回执 `regressions` / `unverified` 里；不许就地改测试消掉）。
 */
const LEGACY_ASSERTION_PATTERNS = Object.freeze([
  ['two-seg-evidence-lesson', /lesson:\s*['"][a-z][a-z0-9-]*\/\d{4}['"]/],
  ['bare-point-gate', /previousLesson\([^)]*,\s*['"][a-z][a-z0-9-]*['"]\s*\)/],
  ['two-seg-snapshot-lesson', /judgeSnapshot\([^)]*,\s*['"][a-z][a-z0-9-]*\/\d{4}['"]\s*\)/],
])
export function scanLegacyEvidenceAssertions(src) {
  const hits = []
  for (const [i, line] of String(src).split('\n').entries()) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
    for (const [kind, rx] of LEGACY_ASSERTION_PATTERNS) {
      if (rx.test(line)) hits.push({ kind, line: i + 1, text: line.trim().slice(0, 140) })
    }
  }
  return hits
}

/* ══════════════════════════════════════════════════════════════════════
 * 用例
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
  const hosts = await loadHosts()
  const root = makeCrossPack('a01')
  const oldGate = await oldGateMod()
  const { observed, violations } = judgeCrossCircle(hosts, root, oldGate)
  DETAIL.A01 = observed
  sameJson(violations, [], 'A01 · 跨圈同名课程判据与证据不串')
}

async function A02() {
  const hosts = await loadHosts()
  const { observed, violations } = judgeFiveStates(hosts)
  DETAIL.A02 = observed
  sameJson(violations, [], 'A02 · 五态完整传播')
}

async function A03() {
  const hosts = await loadHosts()
  const { observed, violations } = await judgeStaleSnapshot(hosts)
  DETAIL.A03 = observed
  sameJson(violations, [], 'A03 · 损坏账本不能通过旧快照继续点亮')
}

async function A04() {
  const hosts = await loadHosts()
  const { observed, violations } = await judgeFallbackLimits(hosts)
  DETAIL.A04 = observed
  sameJson(violations, [], 'A04 · 真正缺失的既有业务回退策略不被扩大')
}

async function A05() {
  const hosts = await loadHosts()
  const { observed, violations } = judgeEmptyVsIo(hosts)
  DETAIL.A05 = observed
  sameJson(violations, [], 'A05 · 空证据与 IO 故障分别给出明确结果')
}

async function A06() {
  const hosts = await loadHosts()
  const { observed, violations } = await judgeParityAndRecords(hosts)
  DETAIL.A06 = observed
  sameJson(violations, [], 'A06 · 宿主与包侧判定一致，记录写口共用提交')
}

async function A07() {
  const { observed, violations } = await judgeSnapshotOnlyMutation()
  DETAIL.A07 = observed
  sameJson(violations, [], 'A07 · 临时让包侧只信旧快照后判据必须红')
}

async function A08() {
  const facts = []
  const hosts = await loadHosts()

  /* ① 交付物存在性 */
  for (const p of WRITE_SET) assert(fs.existsSync(path.join(REPO, ...p.split('/'))), `A08 · 交付物不见了：${p}`)

  /* ② 内核的导出面与纯层纪律 */
  const core = kernel()
  for (const name of ['validateEvidence', 'acceptedKeys', 'bestEvidence', 'meetsEvidence', 'evidenceHint', 'requiredEvidenceText',
    'ledgerStatusOf', 'isBrokenStatus', 'brokenWhyText', 'judgeRequirement', 'liveLedgerVerdict']) {
    assert(core[name] !== undefined, `A08 · 内核缺导出 ${name}`)
  }
  const kernelSrc = readText(path.join(REPO, ...KERNEL.split('/')))
  const kernelNoComments = stripComments(kernelSrc)
  assert(!/^export\s/m.test(kernelSrc) && !/^import\s/m.test(kernelSrc), 'A08 · 内核必须是 CJS（不许 ESM 语法）')
  assert(!/require\(\s*['"]node:fs['"]\s*\)/.test(kernelNoComments) && !/\bfs\./.test(kernelNoComments), 'A08 · 内核不许碰 fs（判定层是纯的）')
  assert(!/new Date\(|Date\.now\(|Math\.random\(|process\.env/.test(kernelNoComments), 'A08 · 内核不许看时钟 / 用随机数 / 读环境变量')
  assert(!/migration\.cjs/.test(kernelNoComments), 'A08 · 运行态内核不许 require 迁移模块（历史解码只归 migration.cjs）')
  for (const token of ['function judgeRequirement', 'function liveLedgerVerdict', 'function ledgerStatusOf', 'function meetsEvidence', 'FALLBACK_STATUS']) {
    assert(kernelNoComments.includes(token), `A08 · 内核里找不到 ${JSON.stringify(token)} —— 反空转检查失败`)
  }

  /* ③ 五个宿主落点的导出面增量**恰好**等于登记值（多一个少一个都算接口漂） */
  {
    const oldHosts = await loadHosts(oldTree())
    const deltaOf = (newMod, oldMod) => {
      const nk = Object.keys(newMod).sort()
      const ok = Object.keys(oldMod).sort()
      return { added: nk.filter((k) => !ok.includes(k)), removed: ok.filter((k) => !nk.includes(k)) }
    }
    const rows = {}
    const keyOf = { [HOST.evidence]: 'evidence', [HOST.state]: 'state', [HOST.evidenceIo]: 'evidenceIo', [HOST.stateScan]: 'stateScan', [HOST.gate]: 'gate' }
    for (const [p, key] of Object.entries(keyOf)) {
      const delta = deltaOf(hosts[key], oldHosts[key])
      rows[p] = delta
      sameJson(delta.added, EXPORT_DELTA[p].added, `A08 · ${p} 的导出增量必须与登记值逐字相同（新增接口必须登记）`)
      sameJson(delta.removed, EXPORT_DELTA[p].removed, `A08 · ${p} 的导出一个都不许少（旧调用方还在）`)
    }
    DETAIL.exportDelta = rows
  }

  /* ④ 委托给内核的源码级证据（不许留着第二份实现） */
  {
    const evidenceSrc = stripComments(readText(path.join(REPO, ...HOST.evidence.split('/'))))
    assert(/core\.(validateEvidence|meetsEvidence|judgeRequirement)/.test(evidenceSrc), 'A08 · lib/evidence.js 必须委托内核（不是第二份实现）')
    assert(!/function\s+validateEvidence\s*\(/.test(evidenceSrc), 'A08 · lib/evidence.js 不许自己实现 validateEvidence')
    const io = stripComments(readText(path.join(REPO, ...HOST.evidenceIo.split('/'))))
    includes(io, 'ledgerStatusOf(', 'A08 · lib/evidence-io.js 必须把"算什么态"交给内核')
    assert(!/status:\s*'invalid'/.test(io) && !/status:\s*'empty'/.test(io), 'A08 · lib/evidence-io.js 里不许再有第二套五态分支')
    const stateSrc = stripComments(readText(path.join(REPO, ...HOST.state.split('/'))))
    includes(stateSrc, 'judgeRequirement(', 'A08 · lib/state.js 必须调内核的 judgeRequirement')
    assert(!/ledgerStatus === 'empty'/.test(stateSrc), 'A08 · lib/state.js 里不许再自己写"哪一态算阻断"的分支')
    const gateSrc = stripComments(readText(path.join(REPO, ...HOST.gate.split('/'))))
    for (const token of ['liveLedgerVerdict(', 'sameLesson(', 'ambiguous-point', 'practiceRootsFor(', 'scopeSnapshot(']) {
      includes(gateSrc, token, `A08 · lib/gate.js 缺少 ${token}`)
    }
    includes(gateSrc, 'export function challengeGate({ root, pack, point, probe = true } = {})', 'A08 · challengeGate 的签名/默认值必须逐字保留')
    includes(gateSrc, 'export function previousLesson(pack, point)', 'A08 · previousLesson 的签名必须逐字保留')
    const askSrc = stripComments(readText(path.join(REPO, ...HOST.askServer.split('/'))))
    for (const token of ["'unify', 'records.cjs'", "'unify', 'evidence.cjs'", 'appendAskRecord(', 'appendNoteRecord(', 'liveLedgerVerdict(', 'ledgerStatusOf(', 'validateEvidence(']) {
      includes(askSrc, token, `A08 · ask-server 缺少 ${token}（记录/证据内核没接上）`)
    }
    assert(!/status:\s*'pending'/.test(askSrc), 'A08 · ask-server 里不许再自己拼答疑记录形状（那归 records 内核）')
    assert(!/\{\s*rel:\s*REL\.questionSeq/.test(askSrc) && !/\{\s*rel:\s*REL\.noteSeq/.test(askSrc), 'A08 · ask-server 里不许再自己写 seq 落点（发号归 records 内核）')
    includes(askSrc, 'core.ledgerStatusOf(', 'A08 · ask-server 的证据读取必须用内核的 ledgerStatusOf')
  }

  /* ⑤ `lib/state-scan.js` 本卡**没有改**：它早就把整本台账（带 status）交给纯层，改它没有依据 */
  {
    const head = gitHeadBytes(HOST.stateScan)
    assert(head !== null, `A08 · HEAD 里没有 ${HOST.stateScan}`)
    eq(sha256(fs.readFileSync(path.join(REPO, ...HOST.stateScan.split('/')))), sha256(head),
      `A08 · ${HOST.stateScan} 本卡没有改它（字节必须与 HEAD 相同 —— 理由见回执）`)
    const src = stripComments(readText(path.join(REPO, ...HOST.stateScan.split('/'))))
    includes(src, 'const evidence = readEvidence(root)', 'A08 · （前提）state-scan 早就在读整本台账')
    includes(src, 'evidence }', 'A08 · （前提）state-scan 早就把整本台账交给 buildState —— 所以本卡不需要改它')
    const ioSrc = readText(path.join(REPO, ...HOST.evidenceIo.split('/')))
    includes(ioSrc, "status: 'io-error'", 'A08 · （前提）五态的读取侧本来就在 evidence-io 里')
  }

  /* ⑥ 与 HEAD 旧实现的**行为**对拍（常量 / 纯函数 / 拒绝面；新增能力另列） */
  {
    const oldEv = await oldEvidenceMod()
    const newEv = hosts.evidence
    for (const name of ['EVIDENCE_KINDS', 'EVIDENCE_RANK', 'EVIDENCE_KEYS', 'EVIDENCE_LABEL', 'EVIDENCE_MAX_BYTES']) {
      sameJson(newEv[name], oldEv[name], `A08 · ${name} 必须与 HEAD 逐字相同`)
    }
    eq(String(newEv.LESSON_ID_RE), String(oldEv.LESSON_ID_RE), 'A08 · LESSON_ID_RE 必须与 HEAD 相同')
    eq(newEv.EVIDENCE_REL, oldEv.EVIDENCE_REL, 'A08 · EVIDENCE_REL 必须与 HEAD 相同')
    const entries = [
      { date: null, lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal', ref: null, note: null },
      { date: '2026-10-20', lesson: 'spring-boot/0001', challenge: 4, kind: 'run', ref: 'q-1', note: '跑起来了' },
      { date: null, lesson: 'spring-boot/0001', challenge: 1, kind: 'test', ref: null, note: null },
      { date: null, lesson: 'vue/1001', challenge: 4, kind: 'explain', ref: null, note: null },
    ]
    for (const min of ['verbal', 'explain', 'test', 'run']) {
      const oldM = oldEv.meetsEvidence(entries, 'spring-boot/0001', 4, min)
      const newM = newEv.meetsEvidence(entries, 'spring-boot/0001', 4, min)
      sameJson({ ...newM, best: newM.best ? { kind: newM.best.kind, rank: newM.best.rank, date: newM.best.date, ref: newM.best.ref } : null },
        { ...oldM, best: oldM.best ? { kind: oldM.best.kind, rank: oldM.best.rank, date: oldM.best.date, ref: oldM.best.ref } : null },
        `A08 · meetsEvidence（声明形状 / min=${min}）的既有字段必须与 HEAD 相同`)
      eq(newEv.evidenceHint('spring-boot/0001', 4, newM), oldEv.evidenceHint('spring-boot/0001', 4, oldM),
        `A08 · evidenceHint（min=${min}）必须与 HEAD 逐字相同`)
    }
    // ⚠️ 返回形状的**唯一**增量：bestEvidence 多一个 `lesson`（哪一条台账键命中的，回执要用）。
    //    既有字段必须逐字段相同，多出来的字段必须只有这一个（登记在回执 interfaceConsumption 里）。
    const oldBest = oldEv.bestEvidence(entries, 'spring-boot/0001', 4)
    const newBest = newEv.bestEvidence(entries, 'spring-boot/0001', 4)
    const sharedFields = (b) => ({ kind: b.kind, rank: b.rank, date: b.date, ref: b.ref })
    sameJson(sharedFields(newBest), sharedFields(oldBest), 'A08 · bestEvidence 的既有字段必须与 HEAD 逐字段相同')
    sameJson(Object.keys(newBest).sort(), [...Object.keys(oldBest).sort(), 'lesson'].sort(),
      'A08 · bestEvidence 只许多一个登记过的 lesson 字段（多别的就是接口漂）')
    eq(newBest.lesson, 'spring-boot/0001', 'A08 · bestEvidence.lesson 必须是命中的那条台账键')
    eq(newEv.bestEvidence(entries, 'spring-boot/0001', 99), null, 'A08 · bestEvidence 没贴过的题 → null（不抛）')
    const oldMeets = oldEv.meetsEvidence(entries, 'spring-boot/0001', 4, 'test')
    const newMeets = newEv.meetsEvidence(entries, 'spring-boot/0001', 4, 'test')
    sameJson({ ...newMeets, best: sharedFields(newMeets.best) }, { ...oldMeets, best: sharedFields(oldMeets.best) },
      'A08 · meetsEvidence 的既有字段必须与 HEAD 逐字段相同（best 里的增量单独核）')
    const validRecords = [
      { lesson: 'spring-boot/0001', challenge: 4, kind: 'run' },
      { date: '2026-10-20', lesson: 'spring-boot/0001', challenge: 1, kind: 'test', ref: 'r', note: '正文' },
      { date: null, lesson: 'vue/1001', challenge: 2, kind: 'verbal', ref: null, note: null },
    ]
    for (const r of validRecords) sameJson(newEv.validateEvidence(r), oldEv.validateEvidence(r), `A08 · validateEvidence 的归一化必须与 HEAD 逐字段相同（${JSON.stringify(r).slice(0, 40)}）`)
    const badRecords = [
      ['缺 lesson', { challenge: 1, kind: 'run' }],
      ['challenge 非正整数', { lesson: 'spring-boot/0001', challenge: 0, kind: 'run' }],
      ['kind 不认识', { lesson: 'spring-boot/0001', challenge: 1, kind: 'maybe' }],
      ['date 形态不对', { lesson: 'spring-boot/0001', challenge: 1, kind: 'run', date: '今天' }],
      ['多余键', { lesson: 'spring-boot/0001', challenge: 1, kind: 'run', ts: 'x' }],
      ['note 过长', { lesson: 'spring-boot/0001', challenge: 1, kind: 'run', note: 'x'.repeat(16 * 1024 + 1) }],
      ['lesson 形态不对', { lesson: 'spring-boot', challenge: 1, kind: 'run' }],
    ]
    const badRows = []
    for (const [label, r] of badRecords) {
      let a = null
      let b = null
      try { oldEv.validateEvidence(r) } catch (e) { a = e.message }
      try { newEv.validateEvidence(r) } catch (e) { b = e.message }
      badRows.push({ label, oldRejects: a !== null, newRejects: b !== null, sameMessage: a === b, old: a, new: b })
      assert(a !== null, `A08 ·（前提）HEAD 的 validateEvidence 必须拒绝 ${label}`)
      assert(b !== null, `A08 · 拒绝面不许放宽：新实现必须拒绝 ${label}`)
      if (label !== 'lesson 形态不对') eq(b, a, `A08 · 拒绝文案必须与 HEAD 相同（${label}）`)
    }
    DETAIL.headParity = { badRows }
    let oldRejectsCanonical = false
    try { oldEv.validateEvidence({ lesson: 'a/x/0001', challenge: 1, kind: 'run' }) } catch { oldRejectsCanonical = true }
    assert(oldRejectsCanonical, 'A08 ·（前提）HEAD 不认规范课次键 —— 这条新增能力必须如实登记')
    sameJson(newEv.validateEvidence({ lesson: 'a/x/0001', challenge: 1, kind: 'run' }),
      { date: null, lesson: 'a/x/0001', challenge: 1, kind: 'run', ref: null, note: null },
      'A08 · 规范课次键必须被接受并原样归一（键序钉死）')
    const oldGateSrc = stripComments((gitHeadBytes(HOST.gate) || Buffer.from('')).toString('utf8'))
    const oldBareFilter = extractBarePointFilter(oldGateSrc)
    const nowGateSrc = stripComments(readText(path.join(REPO, ...HOST.gate.split('/'))))
    DETAIL.barePointFilter = { head: oldBareFilter, stillInNow: oldBareFilter === null ? null : nowGateSrc.includes(oldBareFilter) }
    assert(oldBareFilter !== null, 'A08 · （前提）HEAD 的 previousLesson 里读不到「只按裸点筛」的那一行 —— 「去掉降维」这条 Δ 无从判定')
    assert(!nowGateSrc.includes(oldBareFilter),
      `A08 · 新实现不许再保留"只按裸点筛"的那一行（运行时从 HEAD 读出的旧行是 ${JSON.stringify(oldBareFilter)}）`)
  }

  /* ⑦ 反向锚：T03 的源码字面量 / 其它卡的落点 —— 本卡一个字节都不许写 */
  {
    const rows = []
    // (a) 跨卡归属锚（三条：运行期自锚 / §6 运行时归属 / 本进程零写）。
    //     原判据是「必须与 HEAD 逐字节相同」——它在"一个工作树、多 lane 并发"下必然假红
    //     （U16 按 §6 授权改 `lib/mods/starter.js`，本卡却把它读成"U18 越界"）。
    //     换法只收掉假红，不收掉"不许碰"：③ 本进程写过就红（有主也不放行）、② §6 无主就红。
    const owners = section6Owners()
    for (const p of CROSS_CARD_FILES) {
      // 跨卡锚文件**不许**出现在本卡写集里（"不许碰"的底线）。
      // T03 同时在依赖自锚里（反向锚：运行期变一下就红，口径与这里的"§6 无主"一致，不冲突）；
      // starter.js **不在**依赖自锚里 —— 它是兄弟卡落点，只能靠"归属 + 本进程零写"判。
      assert(!WRITE_SET.includes(p), `A08 · ${p} 不许出现在本卡写集里（跨卡锚要它保持"不许碰"）`)
      assert(!ANCHOR_FILES.includes(p) || p === T03,
        `A08 · ${p} 既有 §6 归属又是本卡依赖自锚 —— 两种判据会互相顶替，只许留一种`)
      const judged = judgeCrossCardFile(p, { owners })
      rows.push(judged.row)
      assert(judged.ok, judged.reasons.join('；'))
    }
    DETAIL.crossCardAnchors = rows.slice()
    // ── 决-1/决-2 的 T 线最小例外：T03 只许改**那一行** ──
    // 归属仍在 §6（U01 行带「仅 decisions 决-1/决-2 授权面」限定语）；这里加一道**改动形状**锁：
    // 行数、行位置、旧值、新值全部判死 —— 比"与 HEAD 逐字节相同"更能说明"改的是被授权的那一行"。
    // ⚠️ 旧值/新值**不再硬编码**：旧值从 `git show HEAD:test/audit/T03.mjs` 里读它当时钉的那一行，
    //    新值从盘上 T03 里读，再把新值与 `lib/mods/author.js` 里真实的那次调用逐字对拍（决-1 的核心）。
    const authorSrc = readText(path.join(REPO, ...AUTHOR_MOD.split('/')))
    {
      const t03Head = gitHeadBytes(T03)
      const t03HeadText = t03Head === null ? '' : t03Head.toString('utf8')
      const t03NowText = readText(path.join(REPO, ...T03.split('/')))
      const t03Lock = judgeT03DecisionLine(t03HeadText, t03NowText)
      DETAIL.t03DecisionLine = {
        ok: t03Lock.ok, headLines: t03Lock.headLines, nowLines: t03Lock.nowLines,
        diffs: t03Lock.diffs.map((d) => ({ line: d.line })), headPin: t03Lock.headPin, nowPin: t03Lock.nowPin,
      }
      eq(t03Lock.diffs.length, 1, `A08 · 决-1：T03 相对 HEAD 只许差**一行**（实得 ${t03Lock.diffs.length} 行；其它断言的字节不许动）`)
      eq(t03Lock.ok, true, `A08 · 决-1：T03 的改动必须恰好是那一行字面量迁移（${t03Lock.problems.join(' | ')}）`)
      // ① 动态对拍：T03 钉住的那一行必须**逐字**出现在 lib/mods/author.js 里（不再比常量）。
      const pinMatch = judgeT03PinMatchesAuthor(t03NowText, authorSrc)
      DETAIL.t03PinMatch = { ok: pinMatch.ok, pin: pinMatch.pin, pinnedPoint: pinMatch.pinnedPoint, calls: pinMatch.calls, problems: pinMatch.problems }
      eq(pinMatch.ok, true,
        `A08 · 决-1：T03 钉住的字面量必须逐字出现在 ${AUTHOR_MOD} 里、且作者侧任何一次 challengeGate 调用都不许传裸点（${pinMatch.problems.join(' | ')}）`)
      assert(pinMatch.pin !== null && authorSrc.includes(pinMatch.pin),
        'A08 · 决-1：钉住的调用与 author.js 的调用点必须逐字同形（期望 ↔ 实现不许各写各的）')
      assert(pinMatch.pinnedPoint !== null && !BARE_POINT_ARGS.includes(pinMatch.pinnedPoint),
        `A08 · 决-1：mods/author.js 交给 challengeGate 的 point 必须是规范身份构造出来的值，不是裸点（实得 ${pinMatch.pinnedPoint}）`)
      // 反空转一：多改一行 / 把那一行改成 author.js 里不存在的值 / 把点改回裸点，锁都必须红（不是恒真）。
      const pinNow = t03Lock.nowPin
      assert(typeof pinNow === 'string' && pinNow.length > 0, 'A08 · 反空转前提：从盘上的 T03 里读不出它钉住的字面量')
      eq(judgeT03DecisionLine(t03HeadText, `${t03NowText}\n// extra`).ok, false, 'A08 · 反空转：T03 多改一行必须被这条锁抓住')
      const pinHalo = pinNow.replace(/(point:\s*)[^,}]+/, '$1haloX')
      assert(pinHalo !== pinNow, 'A08 · 反空转前提：钉住的那一行里能定位到 point 实参')
      eq(judgeT03PinMatchesAuthor(t03NowText.replace(pinNow, pinHalo), authorSrc).ok, false,
        'A08 · 反空转：把钉住的点改成 author.js 里不存在的值必须被抓住（只"改了一行"不够）')
      const pinBare = pinNow.replace(/(point:\s*)[^,}]+/, '$1args.point')
      eq(judgeT03DecisionLine(t03HeadText, t03NowText.replace(pinNow, pinBare)).ok, false,
        'A08 · 反空转：把钉住的点改回裸点 args.point 必须被抓住（决-1 的核心）')
      // 反空转二：author.js 一侧把调用行改回裸点 ⇒ 与钉住字面量不同形 + 裸点两条都红。
      const authorBare = authorSrc.replace(/(challengeGate\(\{[^}]*?point:\s*)[^,}]+/, '$1args.point')
      assert(authorBare !== authorSrc, 'A08 · 反空转前提：author.js 里能定位到那次 challengeGate 调用的 point 实参')
      eq(judgeT03PinMatchesAuthor(t03NowText, authorBare).ok, false,
        'A08 · 反空转：author.js 把调用行改回 point: args.point 必须被抓住（副本实测见本次证据）')
      // 反空转三：归属判据本身也不许整片放行 —— 同一份字节，§6 无主 ⇒ 红；有主 ⇒ 只登记。
      const t03NowSha = sha256(fs.readFileSync(path.join(REPO, ...T03.split('/'))))
      const t03HeadSha = t03Head === null ? null : sha256(t03Head)
      const orphan = judgeCrossCardAnchor({ file: T03, startSha: t03NowSha, nowSha: t03NowSha, headSha: t03HeadSha, owners: [], writesByThisRun: 0 })
      eq(orphan.ok, false, 'A08 · 反空转：§6 里没人登记 T03 时，它的改动必须无主判红（归属判据不许整片放行）')
      const owned = judgeCrossCardAnchor({ file: T03, startSha: t03NowSha, nowSha: t03NowSha, headSha: t03HeadSha, owners: ['U01'], writesByThisRun: 0 })
      eq(owned.ok, true, 'A08 · 反空转：§6 里有主（U01）时，运行期外的改动只登记不红')
      assert(!SECTION6_SET.includes(T03) && !WRITE_SET.includes(T03), 'A08 · T03 不在本卡写集里（本卡一个字节都不写它）')
    }
    // (b) 已被**别的卡**合法改过的两个：只要求"本进程零写 + 运行期间未变"（不拿 HEAD 对拍 —— 那会结构性假红）
    for (const p of [AUTHOR_MOD, U09_A_FACE]) {
      const abs = path.join(REPO, ...p.split('/'))
      const now = sha256(fs.readFileSync(abs))
      const touched = WRITE_GUARD.writes.filter((w) => w.target === path.resolve(abs))
      rows.push({ path: p, rule: 'runtime-frozen', sha16: now.slice(0, 16), atStart16: String(ANCHORS.at.get(p) || '').slice(0, 16), writesByThisRun: touched.length })
      eq(now, ANCHORS.at.get(p), `A08 · ${p} 在本次运行期间必须一个字节都没变（它是别的卡的落点）`)
      eq(touched.length, 0, `A08 · 本进程一次都不许写 ${p}`)
      assert(!WRITE_SET.includes(p), `A08 · ${p} 不许出现在本卡写集里`)
    }
    DETAIL.reverseAnchors = rows
    // 规范身份构造：交给门禁的身份必须由 halo + point 构造（② 解析出来的圆圈不许在调用点丢掉）
    assert(/gatePointOf\(\s*halo\s*,\s*args\.point\s*\)/.test(authorSrc),
      'A08 · 决-1：交给门禁的身份必须由 halo + point 构造（gatePointOf(halo, args.point)）')
    // 裸点直传：author.js 里**任何一次** challengeGate 调用都不许把 args.point 直接交给门禁（不限那一行）
    const bareCalls = extractChallengeGateCalls(authorSrc).filter((c) => c.pointArg !== null && BARE_POINT_ARGS.includes(c.pointArg))
    eq(bareCalls.length, 0, `A08 · 决-1：把裸点直传门禁的旧调用点不许回来（实得 ${bareCalls.map((c) => c.call).join(' / ') || '无'}）`)
    const t03Src = readText(path.join(REPO, ...T03.split('/')))
    includes(t03Src, extractT03GatePins(t03Src)[0].pin, 'A08 · T03 的源码字面量锚点必须与新调用点同形（逐字，运行时从 T03 读出）')
    const starterSrc = readText(path.join(REPO, 'lib/mods/starter.js'))
    // 回执里 `starter-bare-point` 那条 Δ 的**前提**：starter.js 自己把裸点交给 challengeGate。
    // 它是 U16 的文件 —— 主人把它改掉不是本卡的越界，所以这里只登记"前提成立 / 已被主人消除"，
    // 不拿别人的文件内容硬钉本卡的判词（那又是同一类假红）；但"§6 无主"仍然红。
    const premiseLive = starterSrc.includes('point: pid')
    const starterOwner = (section6Owners().get('lib/mods/starter.js') || [])
    DETAIL.crossCardPremise = { path: 'lib/mods/starter.js', premise: 'point: pid', live: premiseLive, owners: starterOwner }
    if (!premiseLive) {
      assert(starterOwner.length > 0 && !starterOwner.includes(CARD),
        'A08 · starter.js 已不再把裸点交给门禁（回执 Δ 的前提被消除），但 §6 里没有别的卡拥有它 —— 这次变化无主')
    }
  }

  /* ⑧ 既有断言冲突闸：认出既有测试里"依赖旧证据/门禁形状"的断言，并证明本卡没去改它们 */
  const legacyRows = []
  {
    const files = ['test/evidence.mjs', 'test/challenge-gate.mjs', 'test/judge-parity.mjs', 'test/lightup.mjs',
      'test/state-probe.mjs', 'test/probe-audit.mjs', 'test/mirror-parity.mjs', 'test/pack-model.mjs']
    for (const p of files) {
      const head = gitHeadBytes(p)
      if (head === null) { legacyRows.push({ path: p, missingInHead: true }); continue }
      const headText = head.toString('utf8')
      const nowText = readText(path.join(REPO, ...p.split('/')))
      const headHits = scanLegacyEvidenceAssertions(headText)
      const nowHits = scanLegacyEvidenceAssertions(nowText)
      const sameBytes = sha256(Buffer.from(nowText)) === sha256(Buffer.from(headText))
      legacyRows.push({ path: p, headHits: headHits.length, nowHits: nowHits.length, sameBytes })
      eq(nowHits.length, headHits.length, `A08 · 冲突闸：${p} 的旧形状断言条数变了（HEAD ${headHits.length} → 现在 ${nowHits.length}），而它不在本卡授权面内`)
      if (p !== U09_A_FACE) eq(sameBytes, true, `A08 · 冲突闸：${p} 的字节变了（本卡没有改既有测试的授权）`)
    }
    const selfTest = scanLegacyEvidenceAssertions([
      "ok(r.evidence, 'x')",
      "appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'run' })",
      "ok(previousLesson(pack, 'spring-boot')?.id === 'spring-boot/0001')",
      "ok(judgeSnapshot(doc, tmp, 'spring-boot/0001').code === 'ok')",
      '',
    ].join('\n'))
    eq(selfTest.length, 3, `A08 · 冲突闸的自证失败：三条旧形状断言没全抓到（实得 ${selfTest.length} 条）`)
    const falsePositive = scanLegacyEvidenceAssertions([
      "appendEvidence(tmp, { lesson: 'a/x/0001', challenge: 1, kind: 'run' })",
      "ok(previousLesson(pack, 'a/x')?.id === 'a/x/0001')",
      "ok(judgeSnapshot(doc, tmp, 'a/x/0001').code === 'ok')",
      '',
    ].join('\n'))
    eq(falsePositive.length, 0, `A08 · 冲突闸不许把规范身份当成旧形状（假阳性 ${JSON.stringify(falsePositive.slice(0, 2))}）`)
    DETAIL.legacyGate = { rows: legacyRows, selfTest: selfTest.length, falsePositive: falsePositive.length }
  }

  /* ⑨ 交付物内容锁（当场复核） */
  const lock = recordContentLock()
  eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
  const lockNow = verifyContentLock()
  eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)

  /* ⑩ 依赖自锚（本次进程开始时 vs 现在） */
  const anchors = verifyAnchors()
  eq(anchors.changed.length, 0,
    `A08 · 本次运行期间依赖文件的字节变了：${anchors.changed.slice(0, 3).map((c) => c.path).join(', ')}（A01–A07 的结论不再对同一份依赖成立；重跑本卡）`)
  assert(anchors.at.length >= ANCHOR_FILES.length, `A08 · 自锚的依赖太少（${anchors.at.length}）`)

  /* ⑪ 授权写集并集（§6 ∪ §12 A，两处都**现场解析**，不硬编码）+ tracked 越界检查 */
  // 两份规格文档都走 SPEC_DOCS 的**同一份快照**（A08⑦ 用的也是它）：这一跑的每一条断言
  // 都对着记进 detail.json 的那一版判，不会出现"前半段旧版本 / 后半段新版本"的混判。
  const lockText = specDocText('docs/unify/interfaces.md')
  const s6 = parseSection6(lockText)
  eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
  sameJson([...s6.get(CARD)].sort(), [...SECTION6_SET].sort(), 'A08 · §6 里 U18 的落点必须逐条等于本卡写集')
  const authDoc = JSON.parse(specDocText('docs/unify/authorization.json'))
  eq(authDoc.quoteVerbatim, '选A和授权p1和p2', 'A08 · 人类授权的原文必须就是这句（逐字）')
  const auth = authorizationExtras(authDoc)
  assert(auth.extras.has('U09') && auth.extras.get('U09').includes(U09_A_FACE), 'A08 · authorization.json 里找不到"U09 独占 test/mirror-parity.mjs"这条授权')
  assert(auth.extras.has('U10') && auth.extras.get('U10').includes('test/intake.mjs'), 'A08 · authorization.json 里找不到"U10 独占 test/intake.mjs"这条授权')
  // §12 A 面只关于**既有测试契约**：U18 不得从它那里拿到任何 test/ 路径（本卡不消费 A 面）
  assert(!(auth.extras.get(CARD) || []).some((p) => /^test\//.test(p)),
    `A08 · authorization.json 不许给 U18 任何既有测试的授权（本卡不消费 A 面；实得 ${JSON.stringify(auth.extras.get(CARD) || [])}）`)
  const union = authorizedUnion(s6, auth.extras)
  const owners = pathOwners(s6, auth.extras)
  const porcelain = gitText(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter((l) => l.trim())
  const { tracked, untracked } = splitPorcelainTracked(porcelain)
  const scopeCheck = classifyTrackedWrites(tracked, union)
  eq(scopeCheck.outOfBounds.length, 0,
    `A08 · tracked 改动越出授权并集（§6 ∪ §12 A）：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
  for (const f of CHANGED_FILES) assert(tracked.some((t) => t.path === f), `A08 · tracked 改动里找不到本卡改过的 ${f}`)
  // 既有 test/** 的每一笔改动都必须**能归因**：§6 里某张卡把它写进自己的写集（运行时解析），
  // 或 §12 A 面逐字授权。两处都没有 ⇒ 红（"没人授权"）。
  // 原判据只认 §12 A 的两张卡（U09/U10），于是 U01 按 scope.P2 改 test/audit/T26.mjs 会被判成
  // 越界 —— 与 starter.js 同一类假红（本卡进程零写由 fs 写守卫判，不靠这份名单）。
  const testOwners = (p) => [...s6.entries()].filter(([, list]) => list.includes(p)).map(([card]) => card)
  const section6Tests = [...s6.values()].flat().filter((p) => /^test\//.test(p))
  const authorizedTests = new Set([
    ...section6Tests,
    ...[...auth.extras.values()].flat().filter((p) => /^test\//.test(p)),
  ])
  const changedTests = tracked.filter((t) => /^test\//.test(t.path) || (t.from && /^test\//.test(t.from)))
  const illegalTests = changedTests.filter((t) => !authorizedTests.has(t.path) || (t.from && !authorizedTests.has(t.from)))
  DETAIL.changedTests = changedTests.map((t) => ({ code: t.code.trim(), path: t.path, from: t.from || null, owners: testOwners(t.path) }))
  eq(illegalTests.length, 0,
    `A08 · 既有 test/** 出现了无人授权的改动（§6 里没有卡拥有它、§12 A 也没逐字授权）：${illegalTests.map((t) => `${t.code.trim()} ${t.path}`).join(', ')}`)
  // 不是"整片放行"：没有主人的测试路径必须判非法（自证判据非空转）
  assert(section6Tests.length >= 2, `A08 · §6 里解析出的既有测试落点太少（${section6Tests.length}）—— 归属判据会退化成"只认 §12 A"`)
  {
    const ghost = changedTests.concat([{ code: ' M', path: 'test/nobody-owns-me.mjs' }])
    const ghostIllegal = ghost.filter((t) => !authorizedTests.has(t.path) || (t.from && !authorizedTests.has(t.from)))
    assert(ghostIllegal.some((t) => t.path === 'test/nobody-owns-me.mjs'),
      'A08 · 没有主人的既有测试改动必须被判非法（判据不许整片放行）')
  }
  assert(!tracked.some((t) => t.path === 'test/audit/U18.mjs'), 'A08 · 本入口自己是**新增**（?? untracked），不许出现在 tracked 改动里')
  {
    const self6 = parseSection6(['## 6. 写集落点', '| U18 | † `a/b.cjs` ✅ `c/d.json` |', '## 7. 别处', '| U18 | `zzz.txt` |', ''].join('\n'))
    eq(self6.size, 1, 'A08 · §6 解析器的自证失败（章节边界没吃住）')
    sameJson(self6.get('U18'), ['a/b.cjs', 'c/d.json'], 'A08 · §6 解析器的自证失败（路径 token 没抓全）')
    const clean = classifyTrackedWrites([{ code: ' M', path: 'a/b.cjs' }], authorizedUnion(self6, new Map()))
    eq(clean.outOfBounds.length, 0, 'A08 · tracked 范围判定的自证失败（授权面内的路径被判越界）')
    const dirty = classifyTrackedWrites([{ code: ' M', path: 'zzz/out-of-scope.mjs' }], authorizedUnion(self6, new Map()))
    eq(dirty.outOfBounds.length, 1, 'A08 · tracked 范围判定的自证失败（越界路径没被抓到）')
  }

  /* ⑫ **不统计他卡的文件数/字节数**：只做归属守卫 */
  const evDirs = fs.readdirSync(path.join(REPO, 'audit-evidence')).sort()
  // 允许面：① 本系列 U 卡的证据目录；② `T23`（既有硬编码，活包硬编码只许被引用）；
  // ③ **真实存在的 T 卡**的目录（`test/audit/T<NN>.mjs` 在盘上）—— 决-1/决-5/决-6/决-9/P2 之后，
  //    T 卡由别的卡合法运行，它们的证据目录会留在盘上（T01/T10/T12/T26…）。
  //    **不是**"T 一律放行"：没有对应 `test/audit/T<NN>.mjs` 的 T 目录、任何非 T 非 U 目录仍然红。
  const s6Paths = [...section6Owners().keys()]
  const registeredT = new Set()
  for (const p of s6Paths) {
    const m = /^test\/audit\/(T\d{2})\.mjs$/.exec(p)
    if (m) registeredT.add(m[1])
  }
  const realT = (d) => /^T\d{2}$/.test(d) && fs.existsSync(path.join(REPO, 'test', 'audit', `${d}.mjs`))
  DETAIL.evidenceDirs = { dirs: evDirs, registeredT: [...registeredT].sort(), realT: evDirs.filter(realT) }
  const unexpectedOf = (list) => list.filter((d) => !/^U\d{2}$/.test(d) && d !== 'T23' && !realT(d))
  const evUnexpected = unexpectedOf(evDirs)
  eq(evUnexpected.length, 0, `A08 · audit-evidence 第一层出现了无人认领的证据目录：${evUnexpected.join(', ')}`)
  // 反空转：既不在册、也没有对应 T 卡入口的名字必须被这条判据抓住。
  sameJson(unexpectedOf(['U01', 'T23', 'T01', 'TXX-nobody']), ['TXX-nobody'],
    'A08 · 反空转：无人认领的证据目录必须被判出来（真实存在的 T 卡放行，别的仍红）')
  for (const d of ['U01', 'T23']) assert(evDirs.includes(d), `A08 · 既有证据目录不见了：${d}`)
  assert(evDirs.includes(CARD), 'A08 · 本卡的证据目录 audit-evidence/U18 必须存在（本次运行创建）')

  /* ⑬ `--evidence-root` 守卫 + 默认读取根恒定 */
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U18/runs/U18-<pid>')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true, 'A08 · E:\\Temp 下带 U18- 前缀的新目录必须被接受')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
  eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')

  /* ⑭ 临时目录归属 + 清理守卫（先做一次受守卫的删除，让写记录里真的出现 rm） */
  {
    const scratch = path.join(RUN_TEMP, 'guard-scratch')
    fs.mkdirSync(scratch, { recursive: true })
    fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
    const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
    eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
    eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')
  }
  eq(guardTempPath(RUN_TEMP, { parent: TEMP_PARENT }).ok, true, 'A08 · 本次临时根必须归 E:\\Temp')
  assert(/^u18-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u18-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')

  /* ⑮ 进程内 fs 写守卫（探针写自证） */
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

  /* ⑯ tracked 回执：合法 JSON（require 自检）+ 五项齐 + 写集 sha + Δ 登记 + 逐字行为 Δ */
  const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
  assert(fs.existsSync(rcPath), `A08 · 缺 tracked 回执 docs/unify/receipts/U18.json`)
  let rc = null
  try { rc = require_(rcPath) } catch (e) { throw new Error(`A08 · 回执不是合法 JSON（require 失败）：${e.message}`) }
  eq(rc.card, CARD, 'A08 · 回执 card 不对')
  eq(rc.status, 'PASS', 'A08 · 回执 status 必须是 PASS（判词以本入口为准）')
  for (const key of ['card', 'title', 'status', 'base', 'verdict', 'completion', 'authorization', 'dependencies',
    'interfaceConsumption', 'writeSet', 'writeSetEvidenceDirs', 'writeOutOfSet', 'deltas', 'regressions',
    'assertions', 'unverified', 'evidenceIndex', 'receiptSelfCheck']) {
    assert(key in rc, `A08 · 回执缺字段 ${key}`)
  }
  const baselineDoc = JSON.parse(readText(path.join(REPO, 'docs', 'unify', 'baseline.json')))
  eq(rc.base.sha, baselineDoc.base.sha, 'A08 · 回执里的执行基线必须仍是 docs/unify/baseline.json 的基线提交')
  eq(rc.verdict.command, `node test/audit/${CARD}.mjs`, 'A08 · 回执里的验收入口')
  eq(rc.verdict.exitCode, 0, 'A08 · 回执里的退出码')
  eq(rc.verdict.line, 'PASS U18 checks=8 failed=0 skipped=0', 'A08 · 回执里的判词行')
  sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
  for (const w of rc.writeSet) {
    if (w.selfReferential === true) {
      // 回执不能装它自己的摘要（自指）—— 其它每一项都必须带 sha，这一项必须**显式**标出来
      eq(w.path, 'docs/unify/receipts/U18.json', 'A08 · 只有回执文件本身可以标 selfReferential')
      continue
    }
    const abs = path.join(REPO, ...String(w.path).split('/'))
    eq(w.bytes, fs.statSync(abs).size, `A08 · 回执里 ${w.path} 的字节数必须与盘上一致`)
    eq(w.sha256, sha256(fs.readFileSync(abs)), `A08 · 回执里 ${w.path} 的 sha256 必须与盘上一致`)
    // 写集里出现的文件只有三种真实状态：改过 / 新建 / **列了写集但实测未改**（不许含糊成 created）
    const wantState = CHANGED_FILES.includes(w.path) ? 'changed' : NEW_FILES.includes(w.path) ? 'created' : 'unchanged'
    eq(w.state, wantState, `A08 · 回执里 ${w.path} 的 state 不对（期望 ${wantState}）`)
    if (wantState === 'unchanged') includes(String(w.note || ''), '未改', `A08 · ${w.path} 标了 unchanged 就必须写明为什么没改`)
  }
  assert(rc.writeSet.some((w) => w.selfReferential === true), 'A08 · 回执必须显式标出"自指的那一项"（不能默默漏 sha）')
  assert(/无/.test(JSON.stringify(rc.writeOutOfSet)), 'A08 · 回执必须写清越界项（无也写明）')
  eq(rc.authorization.quoteVerbatim, authDoc.quoteVerbatim, 'A08 · 回执必须逐字引用 quoteVerbatim')
  eq(rc.authorization.quoteSource, authDoc.quoteSource, 'A08 · 回执必须逐字引用 quoteSource')
  assert(/本卡不消费/.test(String(rc.authorization.statement)), 'A08 · 回执必须写明「本卡不消费 §12 A 面」')
  assert(/C1/.test(String(rc.authorization.decisions)) && /C6/.test(String(rc.authorization.decisions)),
    'A08 · 回执必须点名消费的主持人裁决（C1 / C6）')
  for (const id of FIXED_IDS) {
    assert(rc.assertions && typeof rc.assertions[id] === 'string' && rc.assertions[id].length >= 40, `A08 · 回执必须逐项写清 ${id} 的断言内容`)
  }
  assert(Array.isArray(rc.deltas) && rc.deltas.length >= 5, `A08 · 回执必须逐条登记真实 Δ（实得 ${rc.deltas ? rc.deltas.length : 0} 条）`)
  const deltaKinds = new Set(rc.deltas.map((d) => d && d.kind))
  for (const k of ['fail-closed', 'evidence-single-source', 'cross-circle-isolation', 'ledger-five-states', 'records-delegation',
    'cross-card-anchor-attribution', 'cross-card-test-authorization', 'cross-card-spec-doc-snapshot']) {
    assert(deltaKinds.has(k), `A08 · 回执的 Δ 里缺 ${k} 这一类`)
  }
  /* 跨卡归属锚这条 Δ 必须把"原判据 / 为什么必然假红 / 新三条 / 强度对照"写全 */
  {
    const crossDelta = rc.deltas.find((d) => d && d.kind === 'cross-card-anchor-attribution')
    assert(crossDelta, 'A08 · 回执必须登记跨卡归属锚这条 Δ（cross-card-anchor-attribution）')
    const blob = JSON.stringify(crossDelta)
    for (const token of ['必须与 HEAD 逐字节相同', 'lib/mods/starter.js', 'U16', '§6', '运行期自锚', '无主', '写守卫', '强度']) {
      includes(blob, token, `A08 · 跨卡归属锚的 Δ 必须写清 ${token}`)
    }
    assert(!/变弱|放宽|放水/.test(blob), 'A08 · 跨卡归属锚的 Δ 不许写成"判据变弱 / 放宽 / 放水"（收掉的是假红，不是约束）')
    assert(Array.isArray(crossDelta.rules) && crossDelta.rules.length === 3,
      `A08 · 跨卡归属锚的 Δ 必须逐条列出新的三条（实得 ${Array.isArray(crossDelta.rules) ? crossDelta.rules.length : 0} 条）`)
    includes(String(crossDelta.whyFalseRed || ''), 'U16', 'A08 · 跨卡归属锚的 Δ 必须说清"为什么原判据必然假红"（点名合法改它的卡）')
  }
  /* 既有 test 改动的归属 / 规格文档快照（同一类假红）：每条都必须写清原判据 / 假红成因 / 新口径 / 强度 */
  for (const k of ['cross-card-test-authorization', 'cross-card-spec-doc-snapshot']) {
    const d = rc.deltas.find((x) => x && x.kind === k)
    assert(d, `A08 · 回执必须登记 ${k} 这条 Δ`)
    for (const field of ['old', 'new', 'whyFalseRed', 'strength']) {
      assert(typeof d[field] === 'string' && d[field].length >= 20, `A08 · Δ ${k} 必须写清 ${field}（"改了判据"不是一句话）`)
    }
    assert(!/变弱|放宽|放水/.test(JSON.stringify(d)), `A08 · Δ ${k} 不许写成"判据变弱 / 放宽 / 放水"（换的是归属口径，不是放行面）`)
  }
  includes(String((rc.deltas.find((d) => d && d.kind === 'cross-card-test-authorization') || {}).whyFalseRed || ''), '§6',
    'A08 · 既有 test 归属那条 Δ 的假红成因必须点名 §6 归属（U01 的 test/audit/T26.mjs）')
  includes(String((rc.deltas.find((d) => d && d.kind === 'cross-card-spec-doc-snapshot') || {}).whyFalseRed || ''), 'authorization.json',
    'A08 · 规格文档快照那条 Δ 的假红成因必须点名被并发改写的那份文档')
  const gateDelta = rc.deltas.find((d) => d && d.kind === 'fail-closed')
  assert(gateDelta, 'A08 · 回执必须有一条 fail-closed 的行为 Δ')
  includes(JSON.stringify(gateDelta), '上一课的归属不唯一：放行会把缺证据扩大成通过，所以这里失败关闭', 'A08 · 行为 Δ 的新行为必须逐字登记')
  includes(JSON.stringify(gateDelta), '先做学情摸底', 'A08 · 行为 Δ 的旧行为必须逐字登记（U13 A03）')
  includes(JSON.stringify(gateDelta), '拒绝覆盖', 'A08 · 行为 Δ 的旧行为必须逐字登记（U13 A04）')
  includes(JSON.stringify(gateDelta), 'U13', 'A08 · 行为 Δ 必须点名受影响卡 U13')
  for (const id of ['A03', 'A04', 'A05']) includes(JSON.stringify(gateDelta), id, `A08 · 行为 Δ 必须点名 U13 的 ${id}`)
  includes(JSON.stringify(gateDelta), 'ambiguous-point', 'A08 · 行为 Δ 必须点名新的拒绝码')
  const regIds = (rc.regressions || []).map((r) => r && r.id)
  for (const id of ['PROBE_VERSION', 'T03-literal', 'R1', 'starter-bare-point', 'U13-A03-A04-A05']) {
    assert(regIds.includes(id), `A08 · 回执的 regressions 里缺 ${id}`)
  }
  const unIds = (rc.unverified || []).map((u) => u && u.id)
  for (const id of ['R1', 'U13', 'full-suite', 'live-pack', 'U19', 'EXPECT-3seg']) {
    assert(unIds.includes(id), `A08 · 回执的 unverified 里缺 ${id}`)
  }
  for (const p of [HOST.evidence, HOST.state, HOST.evidenceIo, HOST.stateScan, HOST.gate]) {
    const recorded = rc.interfaceConsumption.exportSurfaceDelta[p]
    assert(recorded, `A08 · 回执的 interfaceConsumption.exportSurfaceDelta 缺 ${p}`)
    sameJson(recorded.added, EXPORT_DELTA[p].added, `A08 · 回执里 ${p} 的导出增量与现场不一致`)
    sameJson(recorded.removed, EXPORT_DELTA[p].removed, `A08 · 回执里 ${p} 的移除增量与现场不一致`)
  }
  // 返回形状的唯一增量（bestEvidence 多一个 lesson）必须被登记，不许静默漂
  const rsDelta = rc.interfaceConsumption.returnShapeDelta || {}
  assert(JSON.stringify(rsDelta).includes('"added":["lesson"]') || JSON.stringify(rsDelta).includes('"added": [\n        "lesson"\n      ]'),
    `A08 · 回执必须登记 bestEvidence 返回值多出的 lesson 字段（实得 ${JSON.stringify(rsDelta).slice(0, 200)}）`)
  assert(rc.dependencies && rc.dependencies.status && rc.dependencies.status.U14, 'A08 · 回执的依赖摘要里缺 U14（records 内核）')
  assert(rc.dependencies && rc.dependencies.status && rc.dependencies.status.U06, 'A08 · 回执的依赖摘要里缺 U06（提交三闸）')
  for (const dep of ['U02', 'U03']) assert(rc.dependencies.status[dep], `A08 · 回执的依赖摘要里缺 ${dep}`)
  eq(rc.receiptSelfCheck.command, "node -e \"require('./docs/unify/receipts/U18.json')\"", 'A08 · 回执必须登记 JSON 自检命令')

  for (const p of [KERNEL, ...Object.values(HOST), 'test/audit/U18.mjs', 'docs/unify/receipts/U18.json']) {
    facts.push({ path: p, nowSha16: sha256(fs.readFileSync(path.join(REPO, ...p.split('/')))).slice(0, 16) })
  }

  DETAIL.comparisons = {
    anchors: anchors.at.length,
    writeSetFacts: facts,
    writeGuard: {
      installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount,
      ops: guard.ops, probe: guard.probe, violations: guard.violations, proof: wProof.rows,
    },
    authorizedUnion: {
      cards: s6.size, paths: union.size, authorization: auth.citations,
      trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) || [] })),
      untrackedCount: untracked.length, outOfBounds: scopeCheck.outOfBounds,
    },
    contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
    specDocs: specDocFacts(),
    evidenceTopLevel: evDirs,
    receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length, regressions: rc.regressions.length, unverified: rc.unverified.length },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */

/** 写守卫必须在**第一笔写之前**挂上（本卡的写全在 A01–A08 与收口落盘里） */
if (IS_MAIN) {
  fs.mkdirSync(RUN_TEMP, { recursive: true })
  // ⚠️ 包侧 `http-security.cjs` 在**模块装载时**就会去建"当前用户私有运行目录"（`%LOCALAPPDATA%\鲸师课件\runtime`，
  //    既有行为，与 U18 无关）。本卡把它显式改到本次临时根（`WHALE_RUNTIME_DIR` 是那一份实现支持的官方口径），
  //    这样"加载包侧服务"这件事不会在本卡允许面之外留下字节。
  process.env.WHALE_RUNTIME_DIR = path.join(RUN_TEMP, 'runtime')
  recordAnchors()
  recordBootSha()
  recordCrossCardAnchors()
  installWriteGuard(writeAllowScope())
  try {
    probeWriteGuard()
  } catch (e) {
    WRITE_GUARD.probeError = String(e?.message ?? e)
  }
}

const CASES = [
  { id: 'A01', run: A01, timeoutMs: 180000 },
  { id: 'A02', run: A02, timeoutMs: 180000 },
  { id: 'A03', run: A03, timeoutMs: 240000 },
  { id: 'A04', run: A04, timeoutMs: 240000 },
  { id: 'A05', run: A05, timeoutMs: 120000 },
  { id: 'A06', run: A06, timeoutMs: 300000 },
  { id: 'A07', run: A07, timeoutMs: 240000 },
  { id: 'A08', run: A08, timeoutMs: 300000 },
]

/** 收口复核：整个进程的写 + 交付物内容锁 + 依赖自锚 + 跨卡归属锚（在所有写之后再看一遍） */
function closingAudit() {
  const w = sweepWriteGuard()
  const c = verifyContentLock()
  const a = verifyAnchors()
  const b = verifyBootSha()
  const x = closingCrossCardAnchors()
  const reasons = []
  if (!w.installed) reasons.push('写守卫没挂上')
  if (w.probeError) reasons.push(`探针写失败：${w.probeError}`)
  if (w.probe && w.probe.recorded !== true) reasons.push('探针写未被守卫记录到')
  for (const v of w.violations.slice(0, 2)) reasons.push(`越界写 ${v.op} ${v.target}`)
  for (const m of c.mismatches.slice(0, 2)) reasons.push(`交付物被改 ${m.path}`)
  for (const ch of a.changed.slice(0, 2)) reasons.push(`依赖在运行期间被改 ${ch.path}`)
  for (const ch of b.changed.slice(0, 2)) reasons.push(`交付物在运行期间被改 ${ch.path}`)
  for (const r of x.reds.slice(0, 2)) reasons.push(r.reasons[0] || `跨卡锚不成立 ${r.path}`)
  return { ok: reasons.length === 0, reasons, writeGuard: w, contentLock: c, anchors: a, bootSha: b, crossCard: x }
}

/** 收口时的跨卡归属复核（与 A08 ⑦ 同一份判官；"运行期自锚"的第二次比） */
function closingCrossCardAnchors() {
  const owners = section6Owners()
  const rows = CROSS_CARD_FILES.map((p) => judgeCrossCardFile(p, { owners }))
  return { rows: rows.map((r) => r.row), reds: rows.filter((r) => !r.ok) }
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
    crossCard: closing.crossCard.rows,
    specDocs: specDocFacts(),
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
