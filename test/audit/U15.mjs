/**
 * test/audit/U15.mjs —— 课程投影的专项判据（C lane · U15）
 * ==================================================================
 * 判的是这一件事：**星图 / 课程星清单 / 名词树 / 笔记页 / 答疑文档从同一份课程事实生成**，
 * 课程身份是规范三段 `circle/point/NNNN`（不再是两段 `point/NNNN`），
 * 进度与答疑只作用于目标课程，跨圈同名知识点互不覆盖，读坏了不产出伪空产物。
 *
 *   A01 两种模式都生成完整课程身份 —— 有源包（`lessons/src`）与无源清单包（`lessons/lessons.json`）
 *       的星图载荷逐课对：`id` = 规范三段、与 `halo/point/number` 自洽、`label` 由身份派生、
 *       `href` 指向真产物、知识点在载荷 `halos[].points[]` 里查得到；课程星清单条目 `{...meta,rel,slug,halo,point}` 齐。
 *   A02 跨圈同名点互不覆盖 —— 两个圈都有 `vue` 且课号相同（原始缺陷：两段键撞成同一个）：
 *       载荷里两门课的规范身份不同、`byId` 不撞、名词树里每门课只挂在自己的圈+知识点下。
 *   A03 进度和答疑只作用于目标课程 —— `learned` 只点亮规范化后的那一门；
 *       未解决答疑按身份聚合，显示名撞车/页锚点（`q0001`）一律**不计入任何课**并告警。
 *   A04 术语显示名从身份推导，不反向猜归属 —— 术语台账的 `lesson` 是显示名：
 *       唯一对位才挂课；撞车 → 进 `unassigned`（不猜）；写成规范身份时按身份挂到那门课。
 *   A05 错误读取传播，不生成伪空产物 —— 坏 `halo.json` / 坏台账 → 生成器非零退出且产物字节不变；
 *       离线包坏清单的既有"告警降级"如实保留（不静默、不造假课）。
 *   A06 重复构建稳定，差异仅限已批准身份变更 —— 同输入两次构建逐字节相同；固定样例
 *       （改前采集 `audit-evidence/U15/pre-change.json`）与改后对拍：清单/名词树/笔记/答疑四件
 *       逐字节相同（单圈包），星图载荷的差异**逐条点名**（`id` 两段→三段、`learned`、`pendingQ`、`flag`、`edges`）。
 *   A07 恢复局部课键后判据必须红 —— E:\Temp 副本里把 `courseIdOf` 改回两段 `point/NNNN`，
 *       同一组身份判据必须报错；干净副本必须绿。
 *   A08 清单模式、证据和既有断言冲突检查有效 —— `--print` 纯 JSON + 无源模式契约 +
 *       改前材料/依赖锚点/写守卫（探针自证）/授权并集/内容锁/证据根守卫/临时目录归属 +
 *       回执五项（含 writeSet 自指 bytes/sha）+ **授权面现场解析**（scope.A / scope.P1 / scope.P2 的
 *       authorized[] 逐字点名的那几条既有测试才放行，每条写出 authorizedBy；notAuthorized[] 永不进放行面；
 *       未被点名的既有测试照旧红 —— 用合成行双向自证分类器）。
 *
 * 判词**只有一行**（unify-runner.printVerdict）：
 *   `PASS U15 checks=8 failed=0 skipped=0` → exit 0 ／ `FAIL U15 …` → 1 ／ `BLOCKED U15 …` → 2
 *
 * 不跑任何既有套件（它们读活包 / 写 T 证据），不访问活包，不做任何 git 写。
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

const CARD = 'U15'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
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

/** 权威内核（唯一手工源码） */
const KERNEL = 'lib/unify/content.cjs'

/** 五个包侧薄委托（顺序 = 卡面写集顺序 = interfaces.md §6 的 U15 行顺序） */
const PACK_SHELLS = Object.freeze([
  'lib/pack-template/tools/build-starmap.js',
  'lib/pack-template/tools/build-lessons-index.js',
  'lib/pack-template/tools/build-glossary-tree.js',
  'lib/pack-template/tools/build-notes.js',
  'lib/pack-template/assets/build-questions.js',
])

/** 卡面精确写集（相对仓根） */
const WRITE_SET = Object.freeze([
  KERNEL,
  ...PACK_SHELLS,
  'test/audit/U15.mjs',
  'docs/unify/receipts/U15.json',
])

/** 改前已存在的五个生成器（另外三个是本卡新建） */
const CHANGED_FILES = Object.freeze([...PACK_SHELLS])

/** 内核的同目录依赖（A08 的依赖锚点：它们一漂，A06 的等价证明就不再对同一个内核成立） */
const KERNEL_DEPS = Object.freeze([
  'lib/unify/identity.cjs',
  'lib/unify/pack.cjs',
  'lib/unify/text.cjs',
  'lib/unify/plan.cjs',
  'lib/unify/glossary.cjs',
  'lib/unify/errors.cjs',
])

/** 五个包侧生成器 + 各自的产物 */
const GENERATORS = Object.freeze([
  Object.freeze({ name: 'lessonsIndex', script: 'tools/build-lessons-index.js', rel: 'lessons/lessons.json' }),
  Object.freeze({ name: 'starmap', script: 'tools/build-starmap.js', rel: 'starmap/content.js' }),
  Object.freeze({ name: 'glossaryTree', script: 'tools/build-glossary-tree.js', rel: 'assets/glossary-tree.js' }),
  Object.freeze({ name: 'notes', script: 'tools/build-notes.js', rel: 'reference/NOTES.html' }),
  Object.freeze({ name: 'questions', script: 'assets/build-questions.js', rel: 'QUESTIONS.md' }),
])

const DETAIL = { comparisons: {}, temp: RUN_TEMP }

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')
const posixRel = (p) => String(p).split(path.sep).join('/')

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

/** 深度差异清单（逐路径，落到具体字段） */
export function deepDiffs(pre, cur, at = '', out = []) {
  const ja = JSON.stringify(pre)
  const jb = JSON.stringify(cur)
  if (ja === jb) return out
  const both = pre && cur && typeof pre === 'object' && typeof cur === 'object' && Array.isArray(pre) === Array.isArray(cur)
  if (both) {
    for (const k of new Set([...Object.keys(pre), ...Object.keys(cur)])) {
      deepDiffs(pre[k], cur[k], at ? `${at}.${k}` : String(k), out)
    }
    return out
  }
  out.push({ path: at || '(根)', before: String(ja).slice(0, 240), after: String(jb).slice(0, 240) })
  return out
}

function gitRead(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  eq(r.status, 0, `git ${args.join(' ')} 必须正常退出（stderr=${String(r.stderr || '').slice(0, 300)}）`)
  return String(r.stdout ?? '')
}

/* ── 决-B1：`test/pack-template-rules.mjs` 的「只加登记项」形状判据（纯函数，喂 diff 文本） ──
 * 与 U12 的同名判据口径一致（那里带四条变异对照）：① 零删除；② 新增代码行恰好是每份运行内核
 * 一行 `'tools/unify/<模块>.cjs',`；③ 模块集合与 `lib/unify/*.cjs`（去 migration）逐项相等；
 * ④ 至少一条新增注释。任何一条不满足 ⇒ ok:false。
 * 用户禁令（scope.A.notAuthorized「仍只读，任何卡不得改其断言」）**不动**：它仍在永不面里，
 * 只是「只加登记项」这一种可机判形状被第三批授权（决-B1，用户原文「确认」）放出来。 */
function coreModuleNamesU15() {
  return fs.readdirSync(path.join(REPO, 'lib', 'unify'))
    .filter((n) => n.endsWith('.cjs') && n !== 'migration.cjs')
    .map((n) => n.replace(/\.cjs$/, ''))
    .sort()
}
/** 用户禁令点名的那份既有测试（模块级常量：多处判据共用，避免各处重复字面量） */
const RULES_REL_X = 'test/pack-template-rules.mjs'
function registrationsOnlyFromDiffU15(diffText, coreModules = coreModuleNamesU15()) {
  const lines = String(diffText || '').split(/\r?\n/)
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const codeAdded = added.filter((l) => l.trim() && !l.trim().startsWith('//'))
  const wantRows = [...coreModules].sort().map((m) => `  'tools/unify/${m}.cjs',`)
  const problems = []
  if (removed.length) problems.push(`删除了 ${removed.length} 行既有内容`)
  if (wantRows.some((w) => !codeAdded.includes(w))) problems.push('缺登记项')
  if (codeAdded.some((l) => !wantRows.includes(l))) problems.push('多出非登记代码')
  if (added.length <= codeAdded.length) problems.push('新增行里没有出处注释')
  return { ok: problems.length === 0, problems, added: added.length, codeAdded: codeAdded.length, removed: removed.length }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U04/U11 同一套纪律；本文件独立实现）
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
  if (s.files.has(abs)) return { allowed: true, why: '本卡写集之一', abs }
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

/* ── 授权写集并集（tracked 侧，独立解析 interfaces.md §6） ─────────────────── */

const SECTION6_TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const looksLikeRepoPath = (s) => SECTION6_TOKEN_RX.test(s) && (s.includes('/') || /\.[A-Za-z]{2,4}$/.test(s))

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

export function authorizedUnion(sets) {
  const u = new Set()
  for (const paths of sets.values()) for (const p of paths) u.add(p)
  return u
}

export function pathOwners(sets) {
  const m = new Map()
  for (const [card, paths] of sets) {
    for (const p of paths) {
      if (!m.has(p)) m.set(p, [])
      m.get(p).push(card)
    }
  }
  return m
}

/* ── 既有测试的三个授权面（§12 A/P1/P2 ∪ decisions.approvedChanged ∪ interfaces.md §6 有主） ──
 *
 * 为什么必须有三面：`interfaces.md` §6 是**写集账本**，不是 §12 的附属说明。决-1/决-2 授权同步的
 * `test/audit/T03.mjs`、决-5 的 `T12`、决-6 的 `T10` 都**登记在 §6 的 U01 行**（带限定语），
 * 只认 `authorized[]` 逐字点名的旧口径会把这三条**已授权**的改动判成越界（假红：识别缺口）。
 * 强度不降：每一面都只认**逐条点名**的路径（简称/通配不算），放行必须写出**理由标签**（主人或授权节），
 * `notAuthorized[]` 里的路径仍是永不面（deny 覆盖 allow）。
 */

/** 授权面的**理由标签**形状：授权节 / 决号 / §6 主人；多面用 '+' 连起来 */
const FACE_LABEL = String.raw`(?:scope\.[A-Za-z0-9]+|decisions\.决-\d+|§6\/U\d\d)`
export const FACE_LABEL_RX = new RegExp(`^${FACE_LABEL}(?:\\+${FACE_LABEL})*$`)

/**
 * **纯函数**：`decisions.approvedChanged` 的现场解析 —— `决-N` 的 `what` 里**逐字点名**的既有测试路径。
 * 简称不算点名（决-2 只写「同步 T03」，没有路径 ⇒ 不产生放行面）。
 * @returns {{allow: Map<string,{authorizedBy:string,item:number,quote:string}>, perDecision: Record<string,string[]>}}
 */
export function decisionTestScopes(authz) {
  const allow = new Map()
  const perDecision = {}
  const list = (authz && authz.decisions && authz.decisions.approvedChanged) || []
  for (const d of list) {
    const id = String((d && d.id) || '').trim()
    if (!/^决-\d+$/.test(id)) continue
    const paths = testPathsIn(d && d.what)
    perDecision[id] = paths
    for (const p of paths) {
      if (!allow.has(p)) allow.set(p, { authorizedBy: `decisions.${id}`, item: null, quote: String((d && d.what) || '').slice(0, 160) })
    }
  }
  return { allow, perDecision }
}

/**
 * **纯函数**：`interfaces.md` §6 里**逐条点名**的既有测试 → 主人（U 卡号）列表。
 * 运行时解析（`parseSection6` 的产物），不硬编码卡号。
 */
export function section6TestOwners(sets) {
  const m = new Map()
  for (const [card, paths] of sets) {
    for (const p of paths) {
      if (!EXISTING_TEST_PATH_RX.test(p)) continue
      if (!m.has(p)) m.set(p, [])
      if (!m.get(p).includes(card)) m.get(p).push(card)
    }
  }
  return m
}

/**
 * **纯函数**：把三个授权面合成**唯一放行面**。每条都带上全部理由（`sources`，按
 * authorization → decisions → §6 的顺序拼接，因此 `authorizedBy` 一定写得出东西）；
 * `deny`（`notAuthorized[]`）里的路径最后统一删除 —— **deny 覆盖 allow**。
 * @returns {Map<string,{authorizedBy:string, sources:string[], owner:string|null, item:number|null, quote:string|null}>}
 */
export function mergeTestFaces({ authorization = new Map(), decisions = new Map(), section6 = new Map(), deny = [] } = {}) {
  const out = new Map()
  const bump = (p, label, extra = {}) => {
    if (!out.has(p)) out.set(p, { authorizedBy: label, sources: [], owner: null, item: null, quote: null })
    const cur = out.get(p)
    if (!cur.sources.includes(label)) cur.sources.push(label)
    cur.authorizedBy = cur.sources.join('+')
    for (const k of ['owner', 'item', 'quote']) {
      const v = extra[k]
      if (cur[k] === null && v !== null && v !== undefined) cur[k] = v
    }
  }
  for (const [p, info] of asPathMap(authorization)) {
    const label = authorizeLabel(info)
    bump(p, label.authorizedBy, {
      owner: info && typeof info === 'object' && /^U\d\d$/.test(String(info.owner)) ? info.owner : null,
      item: label.item,
    })
  }
  for (const [p, info] of asPathMap(decisions)) {
    const label = authorizeLabel(info)
    bump(p, label.authorizedBy, { item: label.item, quote: info && typeof info === 'object' ? info.quote : null })
  }
  for (const [p, cards] of asPathMap(section6)) {
    for (const card of (Array.isArray(cards) ? cards : [cards])) bump(p, `§6/${card}`, { owner: card })
  }
  for (const p of asPathSet(deny)) out.delete(p)
  return out
}

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

export function classifyTrackedWrites(entries, union) {
  const allowed = []
  const outOfBounds = []
  for (const e of entries) {
    if (union.has(e.path)) allowed.push({ code: e.code, path: e.path })
    else outOfBounds.push({ code: e.code, path: e.path, why: '已跟踪文件被改/删/增/改名，而路径不在任何 U 卡的授权写集里（§6）' })
    if (e.from) {
      if (union.has(e.from)) allowed.push({ code: e.code, path: e.from, note: 'rename 来源' })
      else outOfBounds.push({ code: e.code, path: e.from, why: 'rename 的来源路径不在任何 U 卡授权写集里（§6）' })
    }
  }
  return { allowed, outOfBounds }
}

/**
 * 授权面（`scope.A` / `scope.P1` / `scope.P2`）的**现场解析**。
 *
 * 判据为什么从"只读 A 面"扩到三节：用户明示「选A和授权p1和p2」。
 * P1 授权「重算 PROBE_VERSION + 唯一字面量」，P2 授权「改写两处『在包装器源码里找 PROBE_VERSION 字面量』
 * 的断言对象」——后者**逐字点名**了 `test/mirror-parity.mjs` 与 `test/audit/T26.mjs`。
 * 只认 A 面的旧口径会把这条**已授权**的 T26 改动判成越界（假红：识别缺口，不是交付物缺陷）。
 *
 * 口径（强度不降）：
 *   · 只认**逐字路径**（`test/*.mjs`、`test/audit/T*.mjs`）：`T26 F01` 这种简称、`test/audit/T*` 这种通配都不算点名；
 *   · 放行面**逐字枚举**并与授权文件现场对拍（多一条 / 少一条都红），每条带出授权节 `authorizedBy`；
 *   · `notAuthorized[]` 里的路径进**永不面**，deny 覆盖 allow（列进去就永远不放行）；
 *   · 没被任何 `authorized[]` 点名的既有测试（如 `test/_pack.mjs`、`test/pack-template-rules.mjs`）照旧红 ——
 *     **T 卡不是类别豁免**，只有逐字点名的那几条放行。
 */

/** 既有测试路径的形状（判据只认这两种） */
const EXISTING_TEST_PATH_RX = /^(?:test\/[A-Za-z0-9._-]+\.mjs|test\/audit\/T[A-Za-z0-9._-]*\.mjs)$/
const TEST_MENTION_RX = /test\/[A-Za-z0-9._/-]+\.mjs/g

/** 授权文件里要现场解析的三节（顺序即归属优先级：先出现的节赢） */
export const AUTHZ_SECTIONS = Object.freeze(['A', 'P1', 'P2'])

/** 纯函数：从一段授权文本里抽出**逐字点名的既有测试路径**（不认简称、不做通配） */
export function testPathsIn(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(TEST_MENTION_RX)) {
    if (EXISTING_TEST_PATH_RX.test(m[0]) && !out.includes(m[0])) out.push(m[0])
  }
  return out
}

/**
 * 纯函数：把 `docs/unify/authorization.json` 现场解析成「放行面 + 永不面」。
 * @returns {{allow: Map<string,{authorizedBy:string,item:number,quote:string}>,
 *            deny: Map<string,{deniedBy:string,item:number,quote:string}>,
 *            perSection: Record<string,{present:boolean,title:string|null,authorized:string[],notAuthorized:string[]}>,
 *            sections: string[]}}
 */
export function authorizationTestScopes(authz, sections = AUTHZ_SECTIONS) {
  const allow = new Map()
  const deny = new Map()
  const perSection = {}
  for (const name of sections) {
    const node = authz && authz.scope ? authz.scope[name] : null
    const row = {
      present: !!node,
      title: node && typeof node.title === 'string' ? node.title : null,
      authorized: [],
      notAuthorized: [],
    }
    if (node) {
      const auth = Array.isArray(node.authorized) ? node.authorized : []
      const not = Array.isArray(node.notAuthorized) ? node.notAuthorized : []
      auth.forEach((text, i) => {
        for (const p of testPathsIn(text)) {
          row.authorized.push(p)
          if (!allow.has(p)) allow.set(p, { authorizedBy: `scope.${name}`, item: i + 1, quote: String(text).slice(0, 160) })
        }
      })
      not.forEach((text, i) => {
        for (const p of testPathsIn(text)) {
          row.notAuthorized.push(p)
          if (!deny.has(p)) deny.set(p, { deniedBy: `scope.${name}.notAuthorized`, item: i + 1, quote: String(text).slice(0, 160) })
        }
      })
    }
    perSection[name] = row
  }
  // 永不面覆盖放行面：notAuthorized 里点过的路径，任何一个 authorized 节点名都不算
  for (const p of deny.keys()) allow.delete(p)
  return { allow, deny, perSection, sections: [...sections] }
}

/** 把 `path → 授权信息` 归一成 Map（兼容旧的「卡号字符串」写法，纯函数） */
function asPathMap(v) {
  const out = new Map()
  if (v instanceof Map) { for (const [p, info] of v) out.set(posixRel(p), info); return out }
  if (v && typeof v === 'object') { for (const [p, info] of Object.entries(v)) out.set(posixRel(p), info); return out }
  return out
}
function asPathSet(v) {
  const out = new Set()
  if (v instanceof Map) { for (const p of v.keys()) out.add(posixRel(p)); return out }
  if (Array.isArray(v)) { for (const p of v) out.add(posixRel(p)); return out }
  if (v && typeof v === 'object') { for (const p of Object.keys(v)) out.add(posixRel(p)); return out }
  return out
}
const authorizeLabel = (info) => (typeof info === 'string' ? { authorizedBy: info, item: null } : { authorizedBy: info?.authorizedBy ?? '(未署名)', item: info?.item ?? null })

/**
 * 「既有测试被改」的**分类器**：本卡写集里的文件放行；授权面里**逐条点名**的既有测试放行并写明理由
 * （`authorizedBy`：`scope.X` / `decisions.决-N` / `§6/Uxx`，多面用 '+' 连起来；`owner` 是主人卡号）；
 * `notAuthorized[]` 里的路径**永不**放行（deny 覆盖 allow）；其余 `test/**` 一律冲突。非测试文件放行。
 *
 * @param {Array<{code:string,path:string}>} entries
 * @param {{writeSet?:string[], allowedTests?:Record<string,string|{authorizedBy:string,item?:number,owner?:string,sources?:string[]}>|Map, deniedTests?:string[]|Set<string>|Map}} opts
 */
export function classifyExistingTestConflicts(entries, { writeSet = WRITE_SET, allowedTests = {}, deniedTests = [] } = {}) {
  const own = new Set(writeSet.map((p) => posixRel(p)))
  const allowedBy = asPathMap(allowedTests)
  const denied = asPathSet(deniedTests)
  const conflicts = []
  const allowed = []
  for (const e of entries) {
    const p = posixRel(e.path)
    if (own.has(p)) { allowed.push({ code: e.code, path: p, why: '本卡写集' }); continue }
    if (denied.has(p)) {
      conflicts.push({ code: e.code, path: p, why: '授权文件的 notAuthorized[] 逐字点名了它 —— 永不进放行面（deny 覆盖 allow）' })
      continue
    }
    if (allowedBy.has(p)) {
      const raw = allowedBy.get(p)
      const info = authorizeLabel(raw)
      const owner = raw && typeof raw === 'object' ? (raw.owner ?? null) : null
      const sources = raw && typeof raw === 'object' && Array.isArray(raw.sources) ? raw.sources.slice() : [info.authorizedBy]
      allowed.push({
        code: e.code, path: p, authorizedBy: info.authorizedBy, item: info.item, owner, sources,
        why: `${info.authorizedBy} 逐条点名（本卡不代劳）`,
      })
      continue
    }
    if (/^test\//.test(p)) {
      conflicts.push({ code: e.code, path: p, why: '既有测试不在本卡写集里，也没在任何授权面里被逐条点名（§12 scope.A/P1/P2 ∪ decisions.approvedChanged ∪ interfaces.md §6 有主；T 卡不是类别豁免）' })
      continue
    }
    allowed.push({ code: e.code, path: p, why: '非测试文件' })
  }
  return { conflicts, allowed, allowedBy, denied }
}

/** A08 红路径：喂人造 porcelain 行，双向钉死（野路径红 / 兄弟 lane 放行 / 混合只抓野的） */
export function proveScopeBoundary(sets) {
  const parsed = sets ?? parseSection6(readText(path.join(REPO, 'docs/unify/interfaces.md')))
  const union = authorizedUnion(parsed)
  const rows = []
  const one = (line, expect, why) => {
    const { tracked } = splitPorcelainTracked([line])
    const r = classifyTrackedWrites(tracked, union)
    const got = r.outOfBounds.length === 0 ? 'allow' : 'reject'
    rows.push({ line, expect, got, ok: got === expect, why, outOfBounds: r.outOfBounds.map((v) => v.path) })
  }
  one(` M ${KERNEL}`, 'allow', '本卡（U15）写集')
  one(' M lib/pack-template/tools/build-starmap.js', 'allow', '本卡（U15）写集')
  one(' M lib/unify/text.cjs', 'allow', 'U04 写集（并发/已交付）')
  one(' M lib/pack-template/tools/ledger-transaction.cjs', 'allow', 'U06 写集（并发）')
  one(' M lib/render.js', 'allow', 'U07 写集（并发）')
  one(' M docs/unify/baseline.json', 'allow', 'U01 的出口（并发）')
  one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
  one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
  one(' D test/all.mjs', 'reject', '既有总入口被删')
  one('R  lib/unify/content.cjs -> lib/whatever.js', 'reject', '改名到野路径（来源合法、目标不合法）')
  one('A  cards/U15.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
  one(' M audit-evidence/U15/pre-change.json', 'reject', '证据目录不被 §6 授权（它是 gitignore 的原始证据）')
  {
    const mixed = classifyTrackedWrites(
      splitPorcelainTracked([` M ${KERNEL}`, ' M lib/render.js', ' M scripts/x.mjs']).tracked, union)
    const got = mixed.outOfBounds.map((v) => v.path).join(',')
    rows.push({
      line: 'MIX[ M content.cjs | M lib/render.js | M scripts/x.mjs]', expect: 'scripts/x.mjs', got,
      ok: got === 'scripts/x.mjs' && mixed.outOfBounds.length === 1, why: '混合输入只抓野路径',
    })
  }
  return { unionSize: union.size, cards: parsed.size, rows, failures: rows.filter((r) => !r.ok) }
}

/** A08 红路径之二：写允许面的边界（兄弟 lane 的合法写入，对**本卡进程**仍判越界） */
export function proveWriteScope(scope) {
  const s = scope ?? writeAllowScope()
  const cases = [
    [KERNEL, 'allow', '本卡写集（权威内核）'],
    ['lib/pack-template/assets/build-questions.js', 'allow', '本卡写集（包侧生成器）'],
    ['docs/unify/receipts/U15.json', 'allow', '本卡写集（tracked 回执）'],
    ['test/audit/U15.mjs', 'allow', '本卡写集（本入口）'],
    [path.join(s.roots[0], 'pack-a01', 'tools', 'unify', 'content.cjs'), 'allow', 'E:\\Temp 本次临时根下的自建包'],
    ['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
    ['lib/render.js', 'reject', 'U07 写集 —— 同上'],
    ['lib/pack-scaffold.js', 'reject', 'U19 写集 —— 同上'],
    ['audit-evidence/U04/pre-change.json', 'reject', '兄弟卡的改前材料（本卡只读）'],
    ['lib/whatever.js', 'reject', '野路径'],
    ['test/_pack.mjs', 'reject', '既有测试'],
    [path.join(TEMP_PARENT, 'u15-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
    ['C:\\Windows\\u15-x.txt', 'reject', '与仓无关的绝对路径'],
  ]
  const rows = cases.map(([p, expect, why]) => {
    const c = classifyWriteTarget(p, s)
    const got = c.allowed ? 'allow' : 'reject'
    return { path: p, expect, got, ok: got === expect, why }
  })
  return { rows, failures: rows.filter((r) => !r.ok), roots: s.roots.slice() }
}

/**
 * A08 红路径之三：**逐条点名才放行** —— 既有测试的改动双向钉死。
 * 野测试 / 简称 / notAuthorized / §6 无主那几行的期望是硬编码的（不跟着输入走）；点名路径的行从
 * **真实授权面的现场解析结果**取（§12 A/P1/P2 ∪ decisions.approvedChanged ∪ §6 有主），并逐条核对
 * `authorizedBy`（放行了却写不出理由 = 判据没生效）。
 *
 * 红样本只增不减：`test/pack-template-rules.mjs`（用户禁令）、`test/_pack.mjs`（既有夹具助手）、
 * `test/all.mjs`（总入口）、`test/audit/T20.mjs` 与 `T23`（未登记的 T 卡）、`test/glossary-verify.mjs`（野测试）
 * 共 6 条铁红；`test/audit/U07.mjs` 从"铁红"改成 **§6 有主的正控**（旧口径把它判红是识别缺口，不是禁令）。
 */
export function proveExistingTestBoundary(scopes) {
  const allow = asPathMap(scopes && scopes.allow ? scopes.allow : scopes || {})
  const deny = asPathSet(scopes && scopes.deny ? scopes.deny : [])
  const opts = { allowedTests: allow, deniedTests: deny }
  const named = (p) => allow.has(p)
  const rows = []
  const one = (line, expect, why) => {
    const { tracked, untracked } = splitPorcelainTracked([line])
    const entries = tracked.length ? tracked : untracked.map((p) => ({ code: '??', path: p }))
    const r = classifyExistingTestConflicts(entries, opts)
    const got = r.conflicts.length ? 'conflict' : 'allow'
    const hit = r.allowed.find((a) => a.authorizedBy)
    rows.push({
      line, expect, got, ok: got === expect, why,
      authorizedBy: hit ? hit.authorizedBy : null, owner: hit ? (hit.owner ?? null) : null,
      conflicts: r.conflicts.map((c) => c.path),
    })
  }
  // ① 铁红（7 条，旧口径 6 条 → 只增不减）：用户禁令里的只读测试、既有夹具助手、总入口、
  //    未登记的 T 卡、焦点之外的 U 卡专项入口、野测试
  one(' M test/pack-template-rules.mjs', 'conflict', '只读清单断言（用户禁令；它在 scope.A.notAuthorized 里 → 永不面，决-9 的「只加登记项」也抹不平）')
  one(' M test/_pack.mjs', 'conflict', '既有夹具助手（§12 与 §6 都没点名它）')
  one(' D test/all.mjs', 'conflict', '既有总入口被删')
  one(' M test/audit/T20.mjs', 'conflict', 'T 卡不是类别豁免：§6 只登记了 T26/T03/T12/T10 四张')
  one(' M test/audit/T23.mjs', 'conflict', '未登记的 T 卡（§6 无主、§12 也没点名）')
  one(' M test/audit/U07.mjs', 'conflict', '焦点之外的 U 卡专项入口（三类授权面都只认 test/*.mjs 与 test/audit/T*.mjs）')
  one(' M test/glossary-verify.mjs', 'conflict', '既有测试但未被任何授权面点名')
  // ①b **§6 有主 + decisions 命名** ⇒ 放行（新面的正控：理由必须同时写得出决号与主人）
  one(' M test/audit/T10.mjs', 'allow', '§6 有主（U01）+ decisions.决-6 —— 两条理由都要写出来')
  // ①c 同一个分类器，喂一张"§6 登了路径却没主人"的表 ⇒ 必须红（归属面不许整片放行）
  {
    const forged = mergeTestFaces({ section6: new Map([['test/audit/T21.mjs', []]]) })
    const r = classifyExistingTestConflicts([{ code: ' M', path: 'test/audit/T21.mjs' }], { allowedTests: forged, deniedTests: new Set() })
    rows.push({
      line: 'FORGED[§6 登了 test/audit/T21.mjs 却写不出主人]', expect: 'conflict',
      got: r.conflicts.length ? 'conflict' : 'allow', ok: r.conflicts.length > 0,
      why: '§6 里没有主人的路径 ⇒ 红（有主才放行，且理由必须写得出卡号）', conflicts: r.conflicts.map((c) => c.path),
    })
  }
  // ② 本卡写集放行
  one(` M ${KERNEL}`, 'allow', '本卡写集（内核新建/改动）')
  one(` M ${PACK_SHELLS[0]}`, 'allow', '本卡写集（生成器改薄委托）')
  one('?? test/audit/U15.mjs', 'allow', '本卡新建的专项入口（未跟踪）')
  // ③ 授权面逐条点名的路径放行（逐条带出理由：授权节 / 决号 / §6 主人）
  for (const [p, info] of allow) {
    const label = authorizeLabel(info).authorizedBy
    one(` M ${p}`, 'allow', `${label} 逐条点名（本卡不代劳）`)
  }
  // ④ 简称不算点名：P1 文本里的「T26 F01」、决-2 的「同步 T03」都不是路径
  {
    const samples = [
      '同步登记「旧值 p:e3472ea71c33181c → 新值」的转换事实与受影响判据（challenge-gate ⑧①、T26 F01、以及任何固定 probeVersion 的夹具说明）。',
      'lib/gate.js 修「候选唯一但错圈」泄漏（按 circle+point 过滤）；同步 T03',
    ]
    const hit = samples.flatMap((s) => testPathsIn(s))
    rows.push({
      line: 'TEXT[P1 的「T26 F01」/ 决-2 的「同步 T03」]', expect: '', got: hit.join(','),
      ok: hit.length === 0, why: '简称 / 卡片号不是路径，不构成授权点名（只认逐字 test/*.mjs）',
    })
  }
  // ⑤ deny 覆盖 allow：即使某个 authorized[] 点名了 notAuthorized 里的路径，也必须红
  {
    const forged = authorizationTestScopes({
      scope: {
        P2: {
          authorized: ['允许改 test/pack-template-rules.mjs 的断言（伪造）'],
          notAuthorized: ['test/pack-template-rules.mjs 仍只读，任何卡不得改其断言'],
        },
      },
    }, ['P2'])
    rows.push({
      line: 'FORGED[authorized 与 notAuthorized 同时点名 test/pack-template-rules.mjs]', expect: 'conflict',
      got: forged.allow.has('test/pack-template-rules.mjs') ? 'allow' : 'conflict',
      ok: !forged.allow.has('test/pack-template-rules.mjs') && forged.deny.has('test/pack-template-rules.mjs'),
      why: 'notAuthorized 永不进放行面（deny 覆盖 allow）',
    })
  }
  // ⑤b deny 覆盖 allow **在合并面上**同样成立：decisions 点名 + notAuthorized 点名 ⇒ 红
  {
    const forged = mergeTestFaces({
      decisions: new Map([['test/pack-template-rules.mjs', { authorizedBy: 'decisions.决-9' }]]),
      section6: new Map([['test/pack-template-rules.mjs', ['U19']]]),
      deny: ['test/pack-template-rules.mjs'],
    })
    rows.push({
      line: 'FORGED[decisions.决-9 + §6/U19 都点名，但 notAuthorized 也点名]', expect: 'conflict',
      got: forged.has('test/pack-template-rules.mjs') ? 'allow' : 'conflict',
      ok: !forged.has('test/pack-template-rules.mjs'),
      why: '合并面同样 deny 覆盖 allow（用户禁令优先于更窄的预授权）',
    })
  }
  // ⑥ 混合输入：只抓没有被授权点名的既有测试
  {
    const mixed = splitPorcelainTracked([' M test/intake.mjs', ' M test/glossary-verify.mjs', ` M ${KERNEL}`, ' M lib/render.js']).tracked
    const r = classifyExistingTestConflicts(mixed, opts)
    const want = named('test/intake.mjs') ? 'test/glossary-verify.mjs' : 'test/intake.mjs,test/glossary-verify.mjs'
    rows.push({
      line: 'MIX[test/intake.mjs | test/glossary-verify.mjs | content.cjs | lib/render.js]', expect: want,
      got: r.conflicts.map((c) => c.path).join(','),
      ok: r.conflicts.map((c) => c.path).join(',') === want, why: '混合输入只抓未授权点名的既有测试',
    })
  }
  return { rows, failures: rows.filter((r) => !r.ok), allow: [...allow.keys()], deny: [...deny.keys()] }
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

/* ══════════════════════════════════════════════════════════════════════
 * 材料加载
 * ══════════════════════════════════════════════════════════════════════ */

let _pre = null
/** 读改前采集材料（缺材料 = BLOCKED，不是 FAIL） */
function pre() {
  if (_pre) return _pre
  if (!fs.existsSync(PRE_FILE)) {
    throw new Blocked(`缺改前采集材料：${rel(PRE_FILE)} —— 先跑 node audit-evidence/U15/capture-baseline.mjs（在改动之前）`)
  }
  let doc = null
  try {
    doc = JSON.parse(readText(PRE_FILE))
  } catch (e) {
    throw new Blocked(`改前采集材料不是合法 JSON：${rel(PRE_FILE)} —— ${e.message}`)
  }
  if (doc?.schema !== 'whale-unify-u15-pre-change/1' || doc?.card !== CARD) {
    throw new Blocked(`改前采集材料形状不对（schema/card 不符）：${rel(PRE_FILE)}`)
  }
  _pre = doc
  return _pre
}

let _fx = null
async function fixtures() {
  if (_fx) return _fx
  if (!fs.existsSync(FIXTURES_FILE)) {
    throw new Blocked(`缺夹具定义：${rel(FIXTURES_FILE)}（改前采集与改后判据必须用同一份）`)
  }
  _fx = await import(pathToFileURL(FIXTURES_FILE).href)
  return _fx
}

/** 造一个夹具包（E:\Temp 下的本次唯一临时根里；`fill` 决定单圈 / 跨圈同名点） */
async function makePack(tag, fill) {
  const fx = await fixtures()
  const dir = path.join(RUN_TEMP, tag)
  const made = await fx.scaffoldPack(dir, { fill })
  return { root: dir, fill, core: made.core, courses: made.courses, fx }
}

/** 跑包内生成器（子进程；stdio 走管道不影响被测生成器 —— 它们不写管道） */
function runGen(packRoot, script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: packRoot, encoding: 'utf8' })
  return { script, args, exit: r.status, signal: r.signal || null, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

const ARTIFACT_REL = Object.freeze({
  lessonsIndex: 'lessons/lessons.json',
  starmap: 'starmap/content.js',
  glossaryTree: 'assets/glossary-tree.js',
  notes: 'reference/NOTES.html',
  questions: 'QUESTIONS.md',
})

const artifactAbs = (packRoot, name) => path.join(packRoot, ARTIFACT_REL[name])
const hasArtifact = (packRoot, name) => fs.existsSync(artifactAbs(packRoot, name))
const readArtifact = (packRoot, name) => readText(artifactAbs(packRoot, name))
const artifactSha = (packRoot, name) => (hasArtifact(packRoot, name) ? sha256(fs.readFileSync(artifactAbs(packRoot, name))) : null)

/** 读 `starmap/content.js` 的载荷（`window.STARMAP_REAL`，与 data-layer 同一读法） */
function readPayload(packRoot) {
  const src = readText(path.join(packRoot, 'starmap', 'content.js'))
  const win = {}
  new Function('window', src)(win)
  return win.STARMAP_REAL
}

/** 读名词树产物（`assets/glossary-tree.js` 里 `var TREE = {...}`） */
function readTree(packRoot) {
  const src = readText(path.join(packRoot, 'assets', 'glossary-tree.js'))
  const m = /var TREE = ([\s\S]*?);\n  if \(typeof module/.exec(src)
  assert(m, '名词树产物里找不到 `var TREE = {...}`')
  return JSON.parse(m[1])
}

/** 跑五个生成器（返回到运行明细） */
function runAll(packRoot) {
  return GENERATORS.map((g) => runGen(packRoot, g.script))
}

/* ── 身份判据（A01/A02/A03/A07 共用；A07 的变异就打在它盯着的身份上） ──────── */

/**
 * 载荷里的课程身份是否**完整且规范**。返回 problems（空 = 通过）。
 * 判据全部来自 U-SPEC §2：课程身份 = `circle/point/NNNN`（1–9999、四位）；显示文字不是身份。
 */
export function courseIdentityProblems(payload, identity, fileBaseOf = () => 0) {
  const problems = []
  if (!payload || !Array.isArray(payload.lessons) || !Array.isArray(payload.halos)) {
    return ['载荷形状不对（缺 lessons / halos 数组）']
  }
  const points = new Map()
  for (const h of payload.halos) for (const p of h.points || []) points.set(`${h.id}/${p.id}`, { h, p })
  const seen = new Map()
  for (const l of payload.lessons) {
    const where = `课程 ${fmt(l.id)}`
    let parsed = null
    try { parsed = identity.parseLessonKey(l.id) } catch (e) { problems.push(`${where}：身份解析抛错（${e.message}）`); continue }
    if (!parsed || !parsed.ok) {
      problems.push(`${where}：不是规范课程身份（${parsed && parsed.failure ? parsed.failure.reason : '解析失败'}）`)
      continue
    }
    const v = parsed.value
    if (v.circle !== l.halo) problems.push(`${where}：id 的圆圈段 ${v.circle} ≠ halo ${l.halo}`)
    if (v.point !== l.point) problems.push(`${where}：id 的知识点段 ${v.point} ≠ point ${l.point}`)
    if (v.number !== Number(l.number)) problems.push(`${where}：id 的课号段 ${v.number} ≠ number ${l.number}`)
    if (l.id !== `${l.halo}/${l.point}/${String(l.number).padStart(4, '0')}`) problems.push(`${where}：id 与 halo/point/number 拼出来的规范键不一致`)
    if (seen.has(l.id)) problems.push(`${where}：同一个身份出现了 ${seen.get(l.id) + 1} 次（跨圈同名点撞车）`)
    seen.set(l.id, (seen.get(l.id) || 0) + 1)
    const key = `${l.halo}/${l.point}`
    const hit = points.get(key)
    if (!hit) { problems.push(`${where}：halos[].points[] 里没有这个知识点 ${key}`); continue }
    const dn = displayNumberOf(Number(l.number), fileBaseOf(l.halo, l.point))
    const expectedLabel = hit.p.label ? `${hit.p.label} 第${dn}课` : `第${dn}课`
    if (l.label !== expectedLabel) problems.push(`${where}：label 「${l.label}」不是身份派生的「${expectedLabel}」`)
    if (typeof l.href !== 'string' || !l.href.startsWith('lessons/')) problems.push(`${where}：href 不是包根相对的课程页路径（${fmt(l.href)}）`)
    if (typeof l.learned !== 'boolean') problems.push(`${where}：learned 必须是布尔值`)
  }
  return problems
}

/** 与包侧 `displayNumberOf` 同一条换算（fileBase 只影响显示号，绝不改号） */
function displayNumberOf(number, fileBase) {
  return Number(number) - (Number(fileBase) || 0)
}

/**
 * 从包里的 `point.json` 读 `fileBase`（载荷里不带它；判据要独立于被测产物取这个事实）。
 * 读不到就当 0（与 point.json 缺省一致）。
 */
function fileBaseReader(packRoot) {
  return (circle, point) => {
    const f = path.join(packRoot, 'lessons', circle, point, 'point.json')
    if (!fs.existsSync(f)) return 0
    try {
      return Number(JSON.parse(readText(f)).fileBase) || 0
    } catch {
      return 0
    }
  }
}

/** 身份判据的断言版本（A01/A02/A03/A07 都调它） */
function assertIdentityComplete(packRoot, identity, label) {
  const problems = courseIdentityProblems(readPayload(packRoot), identity, fileBaseReader(packRoot))
  eq(problems.length, 0, `${label}：课程身份不完整/不规范（${problems.slice(0, 4).join('；')}）`)
}

/* ══════════════════════════════════════════════════════════════════════
 * A01 —— 有源包和无源清单包均生成完整课程身份
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
  const identity = require_(path.join(REPO, 'lib/unify/identity.cjs'))
  const pack = await makePack('a01-source', 'single')
  const runs = runAll(pack.root)
  sameJson(runs.map((r) => r.exit), [0, 0, 0, 0, 0], `A01 · 有源包五个生成器都必须 exit 0（${runs.map((r) => `${r.script}=${r.exit}`).join(' ')}）`)

  // ① 有源包：课程星清单条目「与 src 的 meta 同形」+ 归属齐
  const index = JSON.parse(readArtifact(pack.root, 'lessonsIndex'))
  eq(index.v, 1, 'A01 · 清单版本号')
  eq(index.source, 'lessons/src', 'A01 · 清单 source 必须是 lessons/src')
  eq(index.lessons.length, pack.courses.length, 'A01 · 清单条目数 = 课程数')
  for (const l of index.lessons) {
    for (const k of ['rel', 'slug', 'halo', 'point', 'number', 'title']) {
      assert(l[k] !== undefined && l[k] !== null, `A01 · 清单条目缺字段 ${k}（${fmt(l.rel)}）`)
    }
    assert(/^\d{4}-/.test(path.posix.basename(l.rel)), `A01 · 清单 rel 的文件名必须是四位课号开头（${l.rel}）`)
  }

  // ② 有源包：星图载荷逐课规范身份 + 与清单同源
  assertIdentityComplete(pack.root, identity, 'A01 · 有源包')
  const payload = readPayload(pack.root)
  eq(payload.lessons.length, pack.courses.length, 'A01 · 星图课程数与清单一致')
  sameJson(
    payload.lessons.map((l) => l.id).sort(),
    index.lessons.map((l) => `${l.halo}/${l.point}/${String(l.number).padStart(4, '0')}`).sort(),
    'A01 · 星图课程身份集合必须与课程星清单（同一条 meta）一致'
  )
  for (const l of payload.lessons) {
    assert(fs.existsSync(path.join(pack.root, l.href)), `A01 · 载荷里的 href 必须指向真实产物（${l.href}）`)
  }

  // ③ 无源离线包：只有 lessons/lessons.json（删掉 lessons/src）也要生成完整身份
  const offline = path.join(RUN_TEMP, 'a01-offline')
  fs.cpSync(pack.root, offline, { recursive: true })
  pack.fx.stripSources(offline)
  eq(fs.existsSync(path.join(offline, 'lessons', 'src')), false, 'A01 · 离线包必须真的没有 lessons/src')
  eq(fs.existsSync(path.join(offline, 'lessons', 'lessons.json')), true, 'A01 · 离线包必须带着课程星清单')
  const offRun = runGen(offline, 'tools/build-starmap.js')
  eq(offRun.exit, 0, `A01 · 无源包重建星图必须 exit 0（实得 ${offRun.exit}，stderr=${offRun.err.slice(0, 200)}）`)
  assertIdentityComplete(offline, identity, 'A01 · 无源清单包')
  const offPayload = readPayload(offline)
  eq(offPayload.lessons.length, payload.lessons.length, 'A01 · 无源包课程数 = 有源包课程数')
  sameJson(offPayload.lessons.map((l) => l.id), payload.lessons.map((l) => l.id), 'A01 · 两种模式的课程身份集合必须相同')
  eq(readArtifact(offline, 'starmap'), readArtifact(pack.root, 'starmap'), 'A01 · 同输入下无源模式与有源模式的星图产物逐字节相同')

  // ④ 无源时「只出清单」的那两个生成器按既有契约说话（不是静默通过）
  const offIndex = runGen(offline, 'tools/build-lessons-index.js')
  eq(offIndex.exit, 1, 'A01 · 没有 lessons/src 时课程星清单生成器必须 exit 1')
  assert(/没有 lessons\/src/.test(offIndex.err), `A01 · 必须说清为什么不出清单（stderr=${offIndex.err.slice(0, 200)}）`)
  const offNotes = runGen(offline, 'tools/build-notes.js')
  eq(offNotes.exit, 0, 'A01 · 没有课程源时笔记页生成器是「响亮跳过」exit 0（既有契约）')
  assert(offNotes.out.includes('这是「跳过」') && offNotes.out.includes('不是「通过」'),
    `A01 · 跳过必须说清"跳过 ≠ 通过"（${offNotes.out.slice(0, 200)}）`)

  DETAIL.comparisons.A01 = {
    sourceLessons: payload.lessons.map((l) => ({ id: l.id, label: l.label, learned: l.learned, pendingQ: l.pendingQ })),
    offlineLessons: offPayload.lessons.map((l) => l.id),
    indexEntries: index.lessons.length,
    starmapBytes: readArtifact(pack.root, 'starmap').length,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 —— 跨圈同名点的课程互不覆盖
 * ══════════════════════════════════════════════════════════════════════ */

async function A02() {
  const identity = require_(path.join(REPO, 'lib/unify/identity.cjs'))
  const pack = await makePack('a02-cross', 'cross')
  const runs = runAll(pack.root)
  sameJson(runs.map((r) => r.exit), [0, 0, 0, 0, 0], `A02 · 跨圈包五个生成器都必须 exit 0（${runs.map((r) => `${r.script}=${r.exit}`).join(' ')}）`)

  // ① 改前确有此缺陷（不伪造"修好了"）：采集里两门课是**同一个两段键**
  const preDoc = pre()
  const prePayload = preDoc.fixtures.cross.artifacts.starmap.payload
  const preIds = prePayload.lessons.map((l) => l.id)
  eq(new Set(preIds).size, 1, `A02 · 改前采集里两门课应当撞成同一个两段键（实得 ${fmt(preIds)}）`)
  assert(preIds.every((id) => !identity.parseLessonKey(id).ok), `A02 · 改前的键必须不是规范三段（实得 ${fmt(preIds)}）`)

  // ② 改后：身份两门、互不相同
  assertIdentityComplete(pack.root, identity, 'A02 · 跨圈包')
  const payload = readPayload(pack.root)
  eq(payload.lessons.length, 2, 'A02 · 跨圈同名点仍是两门课（不许被合并成一门）')
  const ids = payload.lessons.map((l) => l.id).sort()
  sameJson(ids, ['math/vue/0001', 'programming/vue/0001'], 'A02 · 两门课的规范身份')
  eq(new Set(ids).size, 2, 'A02 · 身份必须互不相同（两段键会在 Map 里互踩）')

  // ③ 同名同号的两个知识点各自只挂自己的课（名词树按 圆圈+知识点 归属）
  const tree = readTree(pack.root)
  const byHalo = new Map(tree.halos.map((h) => [h.id, h]))
  for (const [halo, pid, expectKey] of [['math', 'vue', 'math/vue/0001'], ['programming', 'vue', 'programming/vue/0001']]) {
    const h = byHalo.get(halo)
    assert(h, `A02 · 名词树缺圆圈 ${halo}`)
    const pt = h.points.find((p) => p.id === pid)
    assert(pt, `A02 · 名词树缺知识点 ${halo}/${pid}`)
    sameJson(pt.lessons.map((l) => l.key), [expectKey], `A02 · ${halo}/${pid} 只许挂自己的课`)
  }
  // 改前采集里同一份树把两门课都挂到了每个点上（缺陷实证）
  const preTreeSrc = preDoc.fixtures.cross.artifacts.glossaryTree.text
  const preTree = JSON.parse(/var TREE = ([\s\S]*?);\n  if \(typeof module/.exec(preTreeSrc)[1])
  for (const h of preTree.halos) {
    eq(h.points[0].lessons.length, 2, `A02 · 改前采集里 ${h.id}/vue 应当挂着 2 门课（跨圈串课实证）`)
  }

  // ④ 笔记/答疑不把两门课混成"身份键当标题"的节
  const notes = readArtifact(pack.root, 'notes')
  assert(!/<summary><h2[^>]*>math\/vue\/0001<\/h2>/.test(notes), 'A02 · 笔记节标题不许是裸身份键（改前缺陷）')
  const preNotes = preDoc.fixtures.cross.artifacts.notes.text
  assert(/<summary><h2[^>]*>math\/vue\/0001<\/h2>/.test(preNotes), 'A02 · 改前采集里应当有"裸身份键当标题"的节（缺陷实证）')

  DETAIL.comparisons.A02 = { preIds, postIds: ids, tree: tree.halos.map((h) => ({ halo: h.id, lessons: h.points[0].lessons.map((l) => l.key) })) }
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 —— 进度和答疑只作用于目标课程
 * ══════════════════════════════════════════════════════════════════════ */

async function A03() {
  const identity = require_(path.join(REPO, 'lib/unify/identity.cjs'))
  const single = await makePack('a03-single', 'single')
  sameJson(runAll(single.root).map((r) => r.exit), [0, 0, 0, 0, 0], 'A03 · 单圈包五个生成器 exit 0')
  const p1 = readPayload(single.root)
  const byId1 = new Map(p1.lessons.map((l) => [l.id, l]))
  // ① 进度只点亮规范化后的那一门
  sameJson(p1.lessons.filter((l) => l.learned).map((l) => l.id), ['programming/spring-boot/0001'], 'A03 · 只许点亮进度里那一门')
  // ② 答疑只落到目标课（台账里一条是显示名「第1课」、一条是规范身份 programming/vue/1001）
  sameJson(p1.lessons.filter((l) => l.pendingQ > 0).map((l) => [l.id, l.pendingQ]), [['programming/spring-boot/0001', 1], ['programming/vue/1001', 1]], 'A03 · 未解决答疑按身份落到两门课')
  eq(byId1.get('programming/spring-boot/0002').pendingQ, 0, 'A03 · 没答疑的课必须是 0')
  eq(byId1.get('programming/vue/1002').pendingQ, 0, 'A03 · 没答疑的课必须是 0')
  eq(byId1.get('programming/spring-boot/0001').flag, 'red', 'A03 · 有未解决答疑 → red')
  eq(byId1.get('programming/spring-boot/0002').flag, null, 'A03 · 没答疑 → 无异常标记')

  // ③ 跨圈：只点亮 math 那门；显示名撞车的答疑**不计入任何课**（不猜）
  const cross = await makePack('a03-cross', 'cross')
  const crossRuns = runAll(cross.root)
  eq(crossRuns[1].exit, 0, 'A03 · 跨圈包星图生成 exit 0')
  const p2 = readPayload(cross.root)
  sameJson(p2.lessons.filter((l) => l.learned).map((l) => l.id), ['math/vue/0001'], 'A03 · 跨圈包只许点亮 math/vue/0001（显示名相同也不能串）')
  const byId2 = new Map(p2.lessons.map((l) => [l.id, l]))
  eq(byId2.get('math/vue/0001').pendingQ, 1, 'A03 · 规范身份那条答疑落在 math 那门')
  eq(byId2.get('programming/vue/0001').pendingQ, 0, 'A03 · 显示名撞车那条不许被算到另一门头上')
  assert(/答疑记录 0002/.test(crossRuns[1].out) && /不猜/.test(crossRuns[1].out),
    `A03 · 撞车必须点名告警（stdout=${crossRuns[1].out.slice(0, 400)}）`)

  // ④ 页锚点（`q0001`）不是课程引用：加一条 `lesson: q0001` 的答疑，必须不计入任何课且告警
  const anchorPack = path.join(RUN_TEMP, 'a03-anchor')
  fs.cpSync(single.root, anchorPack, { recursive: true })
  fs.appendFileSync(path.join(anchorPack, 'questions', 'pending.jsonl'),
    JSON.stringify({ id: '0009', at: '2026-10-09T08:00:00.000Z', lesson: 'q0001', page: 'lessons/programming/spring-boot/0001-hello.html', title: '第1课', question: '页锚点不是课次', status: 'pending' }) + '\n', 'utf8')
  const ranchor = runGen(anchorPack, 'tools/build-starmap.js')
  eq(ranchor.exit, 0, 'A03 · 带页锚点记录的包仍能重建星图')
  const p3 = readPayload(anchorPack)
  eq(p3.lessons.reduce((n, l) => n + (l.pendingQ || 0), 0), 2, 'A03 · 页锚点（q0001）不计入任何课（总数仍是 2）')
  assert(/答疑记录 0009/.test(ranchor.out) && /q0001/.test(ranchor.out), `A03 · 页锚点必须被告警（stdout=${ranchor.out.slice(0, 400)}）`)
  assert(identity.parseLessonKey('q0001').ok === false, 'A03 · 页锚点形状必须不是课程身份')

  DETAIL.comparisons.A03 = {
    single: p1.lessons.map((l) => ({ id: l.id, learned: l.learned, pendingQ: l.pendingQ, flag: l.flag })),
    cross: p2.lessons.map((l) => ({ id: l.id, learned: l.learned, pendingQ: l.pendingQ })),
    anchorTotal: p3.lessons.reduce((n, l) => n + (l.pendingQ || 0), 0),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 —— 术语显示名从身份推导，不反向猜归属
 * ══════════════════════════════════════════════════════════════════════ */

async function A04() {
  const single = await makePack('a04-single', 'single')
  eq(runGen(single.root, 'tools/build-glossary-tree.js').exit, 0, 'A04 · 单圈包名词树 exit 0')
  const t1 = readTree(single.root)
  sameJson(t1.unassigned, [], 'A04 · 唯一显示名的术语必须全部挂上课（unassigned 空）')
  const span = new Map(t1.halos.flatMap((h) => h.points.flatMap((p) => p.lessons.map((l) => [l.key, l]))))
  sameJson((span.get('programming/spring-boot/0001') || {}).terms, ['boot'], 'A04 · boot 必须先按身份挂到 programming/spring-boot/0001')
  sameJson((span.get('programming/vue/1001') || {}).terms, ['proxy'], 'A04 · proxy 必须挂到 programming/vue/1001')
  for (const [, l] of span) {
    eq(l.label, l.label.trim(), `A04 · 课次显示名不能带空白（${fmt(l.label)}）`)
    assert(/第\d+课$/.test(l.label), `A04 · 课次显示名必须由身份派生（${l.label}）`)
  }

  // 撞车：两门课的显示名一模一样 → 术语**不许**被猜给任何一门，进 unassigned 并点名
  const cross = await makePack('a04-cross', 'cross')
  const crossRun = runGen(cross.root, 'tools/build-glossary-tree.js')
  eq(crossRun.exit, 0, 'A04 · 跨圈包名词树 exit 0')
  const t2 = readTree(cross.root)
  sameJson(t2.unassigned, ['dot'], 'A04 · 显示名撞车的术语必须进 unassigned（不许猜给某一门）')
  for (const h of t2.halos) for (const p of h.points) for (const l of p.lessons) {
    eq(l.terms.includes('dot'), false, `A04 · ${l.key} 不该拿到归属不明的术语 dot`)
  }
  assert(/拼不上课次 1：dot/.test(crossRun.out), `A04 · 生成日志必须点名拼不上的术语（stdout=${crossRun.out.slice(0, 300)}）`)

  // 反向：台账里写**规范身份**时，按身份挂到那门课（显示名从身份推导）
  const byKey = path.join(RUN_TEMP, 'a04-key')
  fs.cpSync(single.root, byKey, { recursive: true })
  fs.writeFileSync(path.join(byKey, 'assets', 'glossary-data.js'), `module.exports = {
  boot: { label: '启动类', category: '基础', official: 'x', short: 'y', analogy: 'z', lesson: 'programming/spring-boot/0001' },
};
`, 'utf8')
  eq(runGen(byKey, 'tools/build-glossary-tree.js').exit, 0, 'A04 · 台账写规范身份时名词树 exit 0')
  const t3 = readTree(byKey)
  sameJson(t3.unassigned, [], 'A04 · 规范身份必须能挂上课')
  const hit = t3.halos.flatMap((h) => h.points.flatMap((p) => p.lessons)).find((l) => l.key === 'programming/spring-boot/0001')
  sameJson(hit.terms, ['boot'], 'A04 · 规范身份 → 那一门课，显示名由课次映射表给')

  DETAIL.comparisons.A04 = { single: t1.unassigned, cross: t2.unassigned, byKeyHit: hit.terms }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 —— 错误读取传播，不生成伪空产物
 * ══════════════════════════════════════════════════════════════════════ */

async function A05() {
  const base = await makePack('a05-base', 'single')
  sameJson(runAll(base.root).map((r) => r.exit), [0, 0, 0, 0, 0], 'A05 · 基准包五个生成器 exit 0')

  // ① 坏 halo.json → 星图非零退出，产物字节不变（不许写成"伪空星图"）
  const badHalo = path.join(RUN_TEMP, 'a05-bad-halo')
  fs.cpSync(base.root, badHalo, { recursive: true })
  const beforeStarmap = fs.readFileSync(artifactAbs(badHalo, 'starmap'))
  fs.writeFileSync(path.join(badHalo, 'lessons', 'programming', 'halo.json'), '{ 这不是 JSON', 'utf8')
  const r1 = runGen(badHalo, 'tools/build-starmap.js')
  eq(r1.exit, 1, `A05 · 坏 halo.json 必须 exit 1（实得 ${r1.exit}）`)
  assert(r1.err.trim().length > 0, 'A05 · 读坏必须把原因说在 stderr 上（不许静默）')
  eq(sha256(fs.readFileSync(artifactAbs(badHalo, 'starmap'))), sha256(beforeStarmap), 'A05 · 读坏时星图产物必须一个字节都不变')

  // ② 坏名词台账 → 名词树非零退出，产物字节不变
  const badGloss = path.join(RUN_TEMP, 'a05-bad-glossary')
  fs.cpSync(base.root, badGloss, { recursive: true })
  const beforeTree = fs.readFileSync(artifactAbs(badGloss, 'glossaryTree'))
  fs.writeFileSync(path.join(badGloss, 'assets', 'glossary-data.js'), 'module.exports = { 坏', 'utf8')
  const r2 = runGen(badGloss, 'tools/build-glossary-tree.js')
  eq(r2.exit, 1, `A05 · 坏名词台账必须 exit 1（实得 ${r2.exit}）`)
  assert(r2.err.trim().length > 0, 'A05 · 读坏必须把原因说在 stderr 上')
  eq(sha256(fs.readFileSync(artifactAbs(badGloss, 'glossaryTree'))), sha256(beforeTree), 'A05 · 读坏时名词树产物必须一个字节都不变')

  // ③ 坏答疑台账 → 笔记页非零退出，NOTES 字节不变
  const badQ = path.join(RUN_TEMP, 'a05-bad-questions')
  fs.cpSync(base.root, badQ, { recursive: true })
  const beforeNotes = fs.readFileSync(artifactAbs(badQ, 'notes'))
  fs.writeFileSync(path.join(badQ, 'assets', 'questions-data.js'), 'module.exports = [', 'utf8')
  const r3 = runGen(badQ, 'tools/build-notes.js')
  eq(r3.exit, 1, `A05 · 坏答疑台账必须 exit 1（实得 ${r3.exit}）`)
  eq(sha256(fs.readFileSync(artifactAbs(badQ, 'notes'))), sha256(beforeNotes), 'A05 · 读坏时笔记页产物必须一个字节都不变')

  // ④ 产物不存在 + 读坏 → 不许凭空造出一个"空产物"
  const noArt = path.join(RUN_TEMP, 'a05-no-artifact')
  fs.cpSync(base.root, noArt, { recursive: true })
  fs.rmSync(artifactAbs(noArt, 'starmap'))
  fs.writeFileSync(path.join(noArt, 'lessons', 'programming', 'halo.json'), '{ 坏', 'utf8')
  const r4 = runGen(noArt, 'tools/build-starmap.js')
  eq(r4.exit, 1, 'A05 · 读坏 + 产物缺失仍必须 exit 1')
  eq(fs.existsSync(artifactAbs(noArt, 'starmap')), false, 'A05 · 读坏时不许新建伪空产物')

  // ⑤ 离线包坏清单：既有语义是"告警降级"（如实保留），但必须**说出来**且不造课
  const offline = path.join(RUN_TEMP, 'a05-offline-bad-index')
  fs.cpSync(base.root, offline, { recursive: true })
  base.fx.stripSources(offline)
  fs.writeFileSync(path.join(offline, 'lessons', 'lessons.json'), '{ 坏', 'utf8')
  const r5 = runGen(offline, 'tools/build-starmap.js')
  eq(r5.exit, 0, 'A05 · 离线包坏清单沿用既有降级语义（exit 0）')
  assert(/lessons\/lessons\.json 读不动/.test(r5.out), `A05 · 降级必须点名（stdout=${r5.out.slice(0, 300)}）`)
  eq(readPayload(offline).lessons.length, 0, 'A05 · 降级后不许凭空造课（0 门，而不是假数据）')

  DETAIL.comparisons.A05 = {
    badHalo: { exit: r1.exit, stderr: r1.err.slice(0, 200) },
    badGlossary: { exit: r2.exit, stderr: r2.err.slice(0, 200) },
    badQuestions: { exit: r3.exit, stderr: r3.err.slice(0, 200) },
    offlineBadIndex: { exit: r5.exit, lessons: 0, warned: true },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 —— 重复构建稳定，固定样例差异仅限已批准身份变更
 * ══════════════════════════════════════════════════════════════════════ */

/** 逐课字段的允许差（已批准的身份变更及其派生量） */
const ALLOWED_LESSON_DELTA = Object.freeze(['id', 'learned', 'pendingQ', 'flag'])

function withoutKeys(obj, keys) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v
  return out
}

async function A06() {
  const preDoc = pre()
  const single = await makePack('a06-single', 'single')

  // ① 同输入两次构建：五个产物逐字节相同（确定性 → --check 才有意义）
  const runs1 = runAll(single.root)
  sameJson(runs1.map((r) => r.exit), [0, 0, 0, 0, 0], 'A06 · 第一次构建五个生成器 exit 0')
  const first = Object.fromEntries(GENERATORS.map((g) => [g.name, artifactSha(single.root, g.name)]))
  const firstPayload = readPayload(single.root)
  const runs2 = runAll(single.root)
  sameJson(runs2.map((r) => r.exit), [0, 0, 0, 0, 0], 'A06 · 第二次构建五个生成器 exit 0')
  for (const g of GENERATORS) {
    eq(artifactSha(single.root, g.name), first[g.name], `A06 · ${g.rel} 第二次构建必须逐字节相同（重复构建不稳定）`)
  }
  // 第二次的星图载荷（对象层）也必须相同
  sameJson(readPayload(single.root), firstPayload, 'A06 · 星图载荷对象层稳定')

  // ② `--check` 契约（被断言的输出文案逐字 + 退出码）：构建后逐件绿；人为漂移 → 非零且点出漂移
  const checkCases = [
    { script: 'tools/build-lessons-index.js', rel: ARTIFACT_REL.lessonsIndex, okLine: `清单一致：lessons/lessons.json（${single.courses.length} 课 / 1 个圆圈）`, driftLine: '清单与现算不一致' },
    { script: 'tools/build-starmap.js', rel: ARTIFACT_REL.starmap, okLine: '[check] ✅ 星图数据与课程包一致', driftLine: '星图数据有漂移' },
    { script: 'tools/build-glossary-tree.js', rel: ARTIFACT_REL.glossaryTree, okLine: null, driftLine: '磁盘与构建结果不一致' },
    { script: 'tools/build-notes.js', rel: ARTIFACT_REL.notes, okLine: null, driftLine: '磁盘与构建结果不一致' },
  ]
  const checkRows = []
  for (const c of checkCases) {
    const okLine = c.okLine || `[check] ✅ ${path.relative(single.root, artifactAbs(single.root, Object.keys(ARTIFACT_REL).find((k) => ARTIFACT_REL[k] === c.rel)))} 无漂移`
    const r = runGen(single.root, c.script, ['--check'])
    eq(r.exit, 0, `A06 · ${c.script} --check 构建后必须 exit 0（实得 ${r.exit}；stderr=${r.err.slice(0, 200)}）`)
    assert(r.out.includes(okLine), `A06 · ${c.script} --check 的输出文案不一致（期望含「${okLine}」；实得 ${r.out.slice(0, 300)}）`)
    checkRows.push({ script: c.script, okLine, exit: r.exit })
    fs.appendFileSync(artifactAbs(single.root, Object.keys(ARTIFACT_REL).find((k) => ARTIFACT_REL[k] === c.rel)), '\n/* drift-probe */\n', 'utf8')
    const d = runGen(single.root, c.script, ['--check'])
    eq(d.exit, 1, `A06 · ${c.script} --check 漂移后必须 exit 1（实得 ${d.exit}）`)
    assert(d.err.includes(c.driftLine), `A06 · ${c.script} --check 漂移必须点出漂移（期望含「${c.driftLine}」；实得 ${d.err.slice(0, 200)}）`)
    checkRows[checkRows.length - 1].drift = { exit: d.exit, line: c.driftLine }
    // 复原（后面还要跟改前对拍）
    runGen(single.root, c.script)
  }

  // ③ 与改前采集对拍（单圈包）：四件逐字节相同
  const preArtifacts = preDoc.fixtures.single.artifacts
  for (const name of ['lessonsIndex', 'glossaryTree', 'notes', 'questions']) {
    const was = preArtifacts[name]
    assert(was.present, `A06 · 改前采集缺产物 ${name}`)
    eq(artifactSha(single.root, name), was.sha256, `A06 · ${ARTIFACT_REL[name]} 与改前不一致（这不是已批准的身份变更）`)
  }

  // ③ 星图载荷：结构逐字节同（除允许字段），且允许字段的**新值**逐条点名验证
  const prePayload = preArtifacts.starmap.payload
  const nowPayload = readPayload(single.root)
  eq(nowPayload.termTotal, prePayload.termTotal, 'A06 · termTotal 必须与改前一致')
  sameJson(nowPayload.halos, prePayload.halos, 'A06 · halos（圆圈/知识点/前置/暗星）不许变')
  eq(nowPayload.lessons.length, prePayload.lessons.length, 'A06 · 课程数不许变')
  const preStruct = prePayload.lessons.map((l) => withoutKeys(l, ALLOWED_LESSON_DELTA))
  const nowStruct = nowPayload.lessons.map((l) => withoutKeys(l, ALLOWED_LESSON_DELTA))
  const structDiffs = deepDiffs(preStruct, nowStruct, 'lessons')
  eq(structDiffs.length, 0, `A06 · 除已批准的身份字段外载荷还有差异：${structDiffs.slice(0, 4).map((d) => `${d.path} ${d.before}→${d.after}`).join(' | ')}`)

  // 已批准差异 ①：id 两段 → 规范三段（改前确实是两段）
  for (let i = 0; i < prePayload.lessons.length; i++) {
    const was = prePayload.lessons[i]
    const now = nowPayload.lessons[i]
    eq(was.id, `${was.point}/${String(was.number).padStart(4, '0')}`, `A06 · 改前采集里第 ${i} 门课的键应当是两段 point/NNNN（缺陷实证）`)
    eq(now.id, `${now.halo}/${now.point}/${String(now.number).padStart(4, '0')}`, `A06 · 改后第 ${i} 门课必须是规范三段`)
  }
  // 已批准差异 ②：learned / pendingQ / flag 由身份派生（改前因两段键对不上而全是 false/0）
  eq(prePayload.lessons.every((l) => l.learned === false), true, 'A06 · 改前采集里 learned 应当全是 false（两段键对不上规范进度）')
  eq(prePayload.lessons.every((l) => (l.pendingQ || 0) === 0), true, 'A06 · 改前采集里 pendingQ 应当全是 0（同上）')
  const expectedLearned = new Set(['programming/spring-boot/0001'])
  for (const l of nowPayload.lessons) {
    eq(l.learned, expectedLearned.has(l.id), `A06 · ${l.id} 的 learned 必须等于"进度里有它"`)
    eq(l.pendingQ, l.id === 'programming/spring-boot/0001' || l.id === 'programming/vue/1001' ? 1 : 0, `A06 · ${l.id} 的 pendingQ`)
    eq(l.flag, l.pendingQ ? 'red' : null, `A06 · ${l.id} 的 flag 必须由 pendingQ 派生`)
  }
  // 已批准差异 ③：edges 端点由两段键变三段后才连得上（改前 0 条，改后 1 条且就是 halo.json 里那条）
  eq(prePayload.edges.length, 0, 'A06 · 改前采集里 edges 应当为 0（两段键连不上）')
  sameJson(nowPayload.edges, [{ from: 'programming/vue/1001', to: 'programming/vue/1002', kind: 'next', note: '第一课 → 第二课' }],
    'A06 · 改后 edges 必须逐字等于 halo.json 声明的那条')

  // ④ 跨圈包：改前/改后差异**只**是已批准的身份后果（名词树按圈归属、笔记不再拿身份键当标题）
  const cross = await makePack('a06-cross', 'cross')
  sameJson(runAll(cross.root).map((r) => r.exit), [0, 0, 0, 0, 0], 'A06 · 跨圈包五个生成器 exit 0')
  const preCross = preDoc.fixtures.cross.artifacts
  eq(artifactSha(cross.root, 'questions'), preCross.questions.sha256, 'A06 · 跨圈包 FAQ 文档与改前逐字节相同')
  eq(artifactSha(cross.root, 'lessonsIndex'), preCross.lessonsIndex.sha256, 'A06 · 跨圈包课程星清单与改前逐字节相同')
  const nowTree = readTree(cross.root)
  eq(nowTree.termTotal, JSON.parse(/var TREE = ([\s\S]*?);\n  if \(typeof module/.exec(preCross.glossaryTree.text)[1]).termTotal, 'A06 · 名词总数不变')
  for (const h of nowTree.halos) {
    eq(h.points[0].lessons.length, 1, `A06 · 跨圈包名词树里 ${h.id}/vue 只该剩自己的 1 门课（改前 2 门是串课缺陷）`)
  }

  // ⑤ 有源 vs 无源：星图产物逐字节相同（清单模式与源模式同源）
  const offline = path.join(RUN_TEMP, 'a06-offline')
  fs.cpSync(single.root, offline, { recursive: true })
  single.fx.stripSources(offline)
  eq(runGen(offline, 'tools/build-starmap.js').exit, 0, 'A06 · 无源包重建 exit 0')
  eq(artifactSha(offline, 'starmap'), artifactSha(single.root, 'starmap'), 'A06 · 无源模式的星图产物必须与有源模式逐字节相同')

  DETAIL.comparisons.A06 = {
    repeat: first,
    checkContract: checkRows,
    allowedLessonDelta: ALLOWED_LESSON_DELTA,
    preIds: prePayload.lessons.map((l) => l.id),
    nowIds: nowPayload.lessons.map((l) => l.id),
    edges: nowPayload.edges,
    structDiffs: 0,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 —— 临时恢复局部课键后判据必须红
 * ══════════════════════════════════════════════════════════════════════ */

const MUTATION_NEEDLE = 'return identity.lessonKey(circle, point, number)'
const MUTATION_BODY = 'return `${point}/${String(number).padStart(4, \'0\')}`'

/** 把 `courseIdOf` 改回两段 `point/NNNN`（改前缺陷的写法）。返回 {text, count} */
export function mutatingLessonKey(src) {
  const count = String(src).split(MUTATION_NEEDLE).length - 1
  return { text: String(src).replace(MUTATION_NEEDLE, MUTATION_BODY), count }
}

async function A07() {
  const identity = require_(path.join(REPO, 'lib/unify/identity.cjs'))
  const clean = await makePack('a07-clean', 'cross')
  eq(runGen(clean.root, 'tools/build-starmap.js').exit, 0, 'A07 · 干净副本星图 exit 0')
  assertIdentityComplete(clean.root, identity, 'A07 · 干净副本')

  // 变异只发生在 E:\\Temp 副本里：改包内的 tools/unify/content.cjs（权威内核的逐字副本）
  const mutant = path.join(RUN_TEMP, 'a07-mutant')
  fs.cpSync(clean.root, mutant, { recursive: true })
  const kernelPath = path.join(mutant, 'tools', 'unify', 'content.cjs')
  const original = readText(kernelPath)
  eq(sha256(original), sha256(readText(path.join(REPO, KERNEL))), 'A07 · 变异前的包内副本必须与权威内核逐字节相同')
  const mutated = mutatingLessonKey(original)
  eq(mutated.count, 1, `A07 · 变异点必须唯一命中（实得 ${mutated.count} 次）—— 否则变异无效、判据恒真`)
  assert(mutated.text !== original, 'A07 · 变异必须真的改了字节')
  fs.writeFileSync(kernelPath, mutated.text, 'utf8')

  const run = runGen(mutant, 'tools/build-starmap.js')
  eq(run.exit, 0, `A07 · 变异副本仍应能跑完（exit 0，实得 ${run.exit}：${run.err.slice(0, 200)}）`)
  const problems = courseIdentityProblems(readPayload(mutant), identity, fileBaseReader(mutant))
  assert(problems.length > 0, 'A07 · 恢复两段课键后身份判据必须报错（恒真 = 变异无效）')
  assert(problems.some((p) => /不是规范课程身份/.test(p)), `A07 · 必须命中"不是规范课程身份"（实得 ${problems.slice(0, 2).join('；')}）`)

  // 干净副本上同一组判据必须绿（对照：不是"判据永远红"）
  eq(courseIdentityProblems(readPayload(clean.root), identity, fileBaseReader(clean.root)).length, 0, 'A07 · 干净副本上同一组判据必须通过')
  // 仓内权威内核一个字节都没被这次变异影响
  eq(sha256(readText(path.join(REPO, KERNEL))), sha256(original), 'A07 · 仓内权威内核不许被变异碰到')

  // 变异后的产物差异也要看得见（否则"跑完了"会骗人）
  assert(readArtifact(mutant, 'starmap') !== readArtifact(clean.root, 'starmap'), 'A07 · 变异副本的星图产物必须与干净副本不同')

  DETAIL.comparisons.A07 = {
    mutation: { needle: MUTATION_NEEDLE, body: MUTATION_BODY, count: mutated.count },
    problems: problems.slice(0, 6),
    mutantBytes: readArtifact(mutant, 'starmap').length,
    cleanBytes: readArtifact(clean.root, 'starmap').length,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 —— 清单模式、证据和既有断言冲突检查有效
 * ══════════════════════════════════════════════════════════════════════ */

async function A08() {
  const preDoc = pre()

  // ① 改前材料齐 + 自洽（五个生成器 + 依赖锚点）
  for (const p of [PRE_FILE, FIXTURES_FILE, CAPTURE_FILE]) {
    assert(fs.existsSync(p), `A08 · 改前材料缺失：${rel(p)}`)
  }
  sameJson(preDoc.sources.map((s) => s.path), CHANGED_FILES, 'A08 · 改前材料锁的文件清单必须等于卡面五个既有生成器')
  eq(preDoc.gitHead, gitRead(['rev-parse', 'HEAD']).trim(), 'A08 · 改前采集时的 HEAD 必须仍是现在的 HEAD（本卡不做任何 git 写）')
  for (const s of preDoc.sources) {
    const headBuf = spawnSync('git', ['show', `HEAD:${s.path}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    eq(headBuf.status, 0, `A08 · git show HEAD:${s.path} 必须成功`)
    eq(sha256(headBuf.stdout), s.sha256, `A08 · 改前材料里的 ${s.path} 必须与 git HEAD 逐字节相同`)
  }
  // 依赖锚点（运行期自锚）：内核依赖在采集之后必须没漂，否则 A06 的对拍不再对同一个内核成立
  for (const dep of KERNEL_DEPS) {
    const want = preDoc.deps[dep]
    assert(want, `A08 · 改前材料里缺依赖锚点 ${dep}`)
    eq(sha256(fs.readFileSync(path.join(REPO, dep))), want, `A08 · 依赖锚点漂了：${dep}`)
  }

  // ② 「唯一实现」的源码层证据：计算痕迹只许躺在内核里，五个壳里不许留
  const COMPUTE_TOKENS = [
    'data-lesson-meta',
    'Math.log(1 + wMax)',
    'displayNumberOf',
    'labelAnchorId',
    'resolveLearned',
    'unassigned',
  ]
  const kernelSrc = readText(path.join(REPO, KERNEL))
  for (const t of COMPUTE_TOKENS) {
    assert(kernelSrc.includes(t), `A08 · 内核里找不到计算痕迹 ${JSON.stringify(t)} —— 反空转检查失败（下面那条就成了恒真）`)
  }
  const shellFacts = []
  for (const f of PACK_SHELLS) {
    const src = readText(path.join(REPO, f))
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert(/require\(['"](?:\.\.\/tools\/unify|\.\/unify)\/content\.cjs['"]\)/.test(code), `A08 · ${f} 里看不到对课程投影内核的委托`)
    for (const t of COMPUTE_TOKENS) {
      assert(!code.includes(t), `A08 · ${f} 里还留着计算痕迹 ${JSON.stringify(t)}（第二份实现）`)
    }
    assert(!/JSON\.stringify\(payload/.test(code), `A08 · ${f} 里还在自己序列化星图载荷（第二份实现）`)
    shellFacts.push({ path: f, bytes: Buffer.byteLength(src, 'utf8'), sha16: sha256(Buffer.from(src)).slice(0, 16) })
  }
  // 五个既有文件真的被改过（不是空跑）
  for (const s of preDoc.sources) {
    assert(sha256(fs.readFileSync(path.join(REPO, s.path))) !== s.sha256, `A08 · ${s.path} 与改前字节相同 —— 本卡其实没改它`)
  }
  // 内核是纯 CJS 形态（不 ESM、不自己 require 盘上的课程数据、不依赖"当前时刻"）
  // ⚠️ 只禁**取当前时间**的写法（`Date.now()` / `new Date()` 空参）—— 笔记页要格式化台账里
  //    **已有**的 `n.at`（`new Date(n.at)`），那是确定性的，不该被这条判据误伤。
  assert(!/^export\s/m.test(kernelSrc), 'A08 · 内核不许出现 ESM export')
  assert(!/^import\s/m.test(kernelSrc), 'A08 · 内核不许出现 ESM import')
  assert(!/process\.env|Math\.random|Date\.now\s*\(|new Date\s*\(\s*\)|setTimeout|setInterval/.test(kernelSrc),
    'A08 · 内核不许读环境变量 / 用随机数 / 取当前时间 / 起定时器')
  for (const same of ['./identity.cjs', './pack.cjs', './text.cjs', './plan.cjs', './glossary.cjs', './render.cjs']) {
    assert(kernelSrc.includes(`require('${same}')`), `A08 · 内核必须只依赖同目录内核（缺 require('${same}')）`)
  }

  // ③ 清单模式 + --print 契约（插件侧 `pack-export` 靠它取条目：stdout 只能是 JSON）
  const pack = await makePack('a08-manifest', 'single')
  eq(runGen(pack.root, 'tools/build-lessons-index.js').exit, 0, 'A08 · 课程星清单生成 exit 0')
  const printed = runGen(pack.root, 'tools/build-lessons-index.js', ['--print'])
  eq(printed.exit, 0, 'A08 · --print exit 0')
  let printedDoc = null
  try {
    printedDoc = JSON.parse(printed.out)
  } catch (e) {
    throw new Error(`A08 · --print 的 stdout 必须是纯 JSON（解析失败：${e.message}；前 120 字=${printed.out.slice(0, 120)}）`)
  }
  eq(printedDoc.v, 1, 'A08 · --print 的清单版本号')
  eq(printedDoc.lessons.length, pack.courses.length, 'A08 · --print 条目数')
  assert(printed.out.trim().split('\n').length === 1, 'A08 · --print 只许往 stdout 写一行 JSON（其它信息一律 stderr）')
  const diskIndex = JSON.parse(readArtifact(pack.root, 'lessonsIndex'))
  sameJson(printedDoc, diskIndex, 'A08 · --print 与磁盘清单必须同源（同一条 meta 解析）')

  // 清单模式：无源包里星图读清单（有源/无源产物逐字节相同已在 A01/A06 断言，这里只钉"读的是清单"）
  const offline = path.join(RUN_TEMP, 'a08-offline')
  fs.cpSync(pack.root, offline, { recursive: true })
  pack.fx.stripSources(offline)
  fs.rmSync(path.join(offline, 'starmap', 'content.js'), { force: true })
  const offRun = runGen(offline, 'tools/build-starmap.js')
  eq(offRun.exit, 0, 'A08 · 无源包星图 exit 0')
  eq(JSON.parse(readArtifact(offline, 'lessonsIndex')).source, 'lessons/src', 'A08 · 清单自报的 source 保持不变')
  eq(readPayload(offline).lessons.length, pack.courses.length, 'A08 · 无源包从清单里读到了全部课程')

  // 离线端 CLI 开关仍在：悬空前置默认**硬失败**；`--allow-missing-requires` 才降级成告警 + 剔除
  const dangling = path.join(RUN_TEMP, 'a08-dangling')
  fs.cpSync(pack.root, dangling, { recursive: true })
  const vuePoint = path.join(dangling, 'lessons', 'programming', 'vue', 'point.json')
  const vueDoc = JSON.parse(readText(vuePoint))
  vueDoc.requires = ['spring-boot', 'ghost-point']
  fs.writeFileSync(vuePoint, JSON.stringify(vueDoc, null, 2) + '\n', 'utf8')
  const strictRun = runGen(dangling, 'tools/build-starmap.js')
  eq(strictRun.exit, 1, 'A08 · 悬空前置默认必须硬失败（exit 1）')
  assert(/前置「ghost-point」找不到对应的知识点/.test(strictRun.err), `A08 · 硬失败必须点名悬空前置（stderr=${strictRun.err.slice(0, 200)}）`)
  const relaxedRun = runGen(dangling, 'tools/build-starmap.js', ['--allow-missing-requires'])
  eq(relaxedRun.exit, 0, 'A08 · --allow-missing-requires 必须降级成 exit 0')
  assert(/ghost-point/.test(relaxedRun.out) && /离线端降级为跳过/.test(relaxedRun.out),
    `A08 · 降级必须点名（stdout=${relaxedRun.out.slice(0, 300)}）`)
  const relaxedPoint = readPayload(dangling).halos.flatMap((h) => h.points).find((p) => p.id === 'vue')
  sameJson(relaxedPoint.requires, ['programming/spring-boot'], 'A08 · 降级后悬空那条必须被剔除（不是留着悬空引用）')

  // ④ 【判据 1/4】进程内 fs 写守卫
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
  for (const op of ['mkdir', 'write', 'copy']) assert(guard.ops.includes(op), `A08 · 写记录里没有 ${op} 这一类的写`)
  const wProof = proveWriteScope()
  eq(wProof.failures.length, 0, `A08 · 写允许面的纯函数自证失败：${wProof.failures.map((f) => `${f.path} → ${f.got}（期望 ${f.expect}）`).join(', ')}`)

  // ⑤ 【判据 2/4】授权写集并集（tracked 侧）
  const lockText = readText(path.join(REPO, 'docs/unify/interfaces.md'))
  const s6 = parseSection6(lockText)
  eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
  const union = authorizedUnion(s6)
  const owners = pathOwners(s6)
  sameJson([...s6.get(CARD)], WRITE_SET, 'A08 · §6 里 U15 的落点必须逐条等于本卡写集（接口锁与入口不一致）')
  const porcelain = gitRead(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter((l) => l.trim())
  const { tracked, untracked } = splitPorcelainTracked(porcelain)
  const scopeCheck = classifyTrackedWrites(tracked, union)
  eq(scopeCheck.outOfBounds.length, 0,
    `A08 · tracked 改动越出 U01–U20 授权写集并集：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
  for (const f of CHANGED_FILES) {
    assert(tracked.some((t) => t.path === f), `A08 · tracked 改动里找不到本卡改过的 ${f}`)
  }
  const sProof = proveScopeBoundary(s6)
  eq(sProof.failures.length, 0, `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

  // ⑥ 【判据 3/4】**三个授权面的现场解析**：既有测试的改动只许被
  //    ① scope.A / scope.P1 / scope.P2 的 `authorized[]`（用户明示「选A和授权p1和p2」）
  //    ② `decisions.approvedChanged` 的 `决-N`（人类原话「全按推荐」）
  //    ③ `interfaces.md` §6 里**有主**（写集账本，运行时解析出主人卡号）
  //    逐条点名；三面都没有 ⇒ 红。**放行必须写得出理由**（授权节 / 决号 / 主人）。
  //    ⚠️ 旧口径只读 A 面（后来扩到 A/P1/P2）→ P2 的 `test/audit/T26.mjs`、§6 登记的
  //    `test/audit/T03.mjs`（决-1/决-2）、`T12`（决-5）、`T10`（决-6）都被误判越界，
  //    是**识别缺口**（假红），不是 U15 交付物缺陷；本卡 A 面零消费的事实不变。
  const authz = JSON.parse(readText(path.join(REPO, 'docs/unify/authorization.json')))
  eq(authz.quoteVerbatim, '选A和授权p1和p2', 'A08 · 授权原文必须逐字是「选A和授权p1和p2」')
  const scopes = authorizationTestScopes(authz)
  for (const name of AUTHZ_SECTIONS) {
    assert(scopes.perSection[name].present,
      `A08 · 授权文件缺 scope.${name} 节 —— 授权面要现场解析 A / P1 / P2 三节，缺一节就无从判定（不许按"没读到就当没授权"放行）`)
  }
  // A 面口径与上一版逐字相同（仍是 U09/U10/U14，仍不许出现 U15/U19）
  const aScopeText = JSON.stringify(authz.scope.A)
  for (const only of ['U09', 'U10', 'U14']) assert(aScopeText.includes(only), `A08 · 授权 A 面必须点名 ${only}`)
  for (const never of ['U15', 'U19']) assert(!new RegExp(`\\b${never}\\b`).test(aScopeText), `A08 · 授权 A 面里不该出现 ${never}（本卡不消费 A 面）`)
  // 放行面**逐字枚举**（多一条/少一条都红，不是"含在 A 面就放行"）
  //   ⚠️ 这里用 eq + join（而不是 sameJson）是为了让 FAIL 的判词仍是**一行**：
  //   判词契约是「只有一行」，被断言集合的差异放在同一条消息里逐字列出。
  eq([...scopes.allow.keys()].sort().join(','),
    'test/audit/T26.mjs,test/intake.mjs,test/mirror-parity.mjs',
    'A08 · 放行面必须逐字等于授权文件 authorized[] 点名的那几条既有测试')
  eq(scopes.allow.get('test/mirror-parity.mjs').authorizedBy, 'scope.A', 'A08 · test/mirror-parity.mjs 的授权来源必须是 scope.A（U09 的 A 面）')
  eq(scopes.allow.get('test/intake.mjs').authorizedBy, 'scope.A', 'A08 · test/intake.mjs 的授权来源必须是 scope.A（U10 的 A 面）')
  eq(scopes.allow.get('test/audit/T26.mjs').authorizedBy, 'scope.P2', 'A08 · test/audit/T26.mjs 的授权来源必须是 scope.P2（改写 F01 内 PROBE_VERSION 断言对象）')
  // P1 只授权「重算 PROBE_VERSION + 唯一字面量」，没有逐字点名任何既有测试路径 → 不产生放行面
  eq(scopes.perSection.P1.authorized.length, 0,
    `A08 · scope.P1 不该点名既有测试路径（它授权的是重算与唯一字面量；放行面只认逐字路径；实得 ${scopes.perSection.P1.authorized.join(',') || '无'}）`)
  // notAuthorized 永不进放行面（用户禁令：pack-template-rules 只读）
  assert(scopes.deny.has('test/pack-template-rules.mjs'),
    'A08 · scope.A.notAuthorized 必须逐字点名 test/pack-template-rules.mjs（用户禁令：它只读，任何卡不得改其断言）')
  assert(!scopes.allow.has('test/pack-template-rules.mjs'), 'A08 · notAuthorized 里的路径永不许进放行面（deny 覆盖 allow）')
  for (const p of scopes.allow.keys()) {
    assert(fs.existsSync(path.join(REPO, p)), `A08 · 授权面点名的既有测试必须真的存在于盘上（存疑即不放行）：${p}`)
  }
  // ② §6 有主 + ③ decisions.approvedChanged（都**运行时解析**，不硬编码卡号/决号）
  const s6Tests = section6TestOwners(s6)
  const decT = decisionTestScopes(authz)
  for (const [p, want] of [['test/audit/T26.mjs', 'U01'], ['test/audit/T03.mjs', 'U01'], ['test/audit/T12.mjs', 'U01'], ['test/audit/T10.mjs', 'U01']]) {
    const owned = s6Tests.get(p) || []
    eq(owned.includes(want), true, `A08 · interfaces.md §6 必须把 ${p} 登记在 ${want} 行（实得 ${owned.join(',') || '无主'}）`)
  }
  for (const p of ['test/intake.mjs', 'test/mirror-parity.mjs']) {
    assert((s6Tests.get(p) || []).length > 0, `A08 · ${p} 在 §6 里必须有主（实得无主）`)
  }
  for (const p of ['test/_pack.mjs', 'test/audit/T20.mjs', 'test/audit/T23.mjs']) {
    assert(!s6Tests.has(p), `A08 · ${p} 不该被 §6 登记（它必须仍然是红样本：§6 是逐条登记，不是测试类豁免）`)
  }
  // 决-B1（第三批授权）：`test/pack-template-rules.mjs` 由 §6 的 **U19 单点**登记（逐条登记，
  // 仍不是"测试类豁免"）—— 主人必须是具体卡号 U19，不能是通配/空。
  eq((s6Tests.get('test/pack-template-rules.mjs') || []).join(','), 'U19',
    'A08 · §6 必须把 test/pack-template-rules.mjs 登记在 U19 这一行（决-B1 的账本出口）')
  eq((decT.perDecision['决-1'] || []).join(','), 'test/audit/T03.mjs', 'A08 · decisions.决-1 必须逐字点名 test/audit/T03.mjs（且只有它）')
  eq((decT.perDecision['决-5'] || []).join(','), 'test/audit/T12.mjs', 'A08 · decisions.决-5 必须逐字点名 test/audit/T12.mjs（且只有它）')
  eq((decT.perDecision['决-6'] || []).join(','), 'test/audit/T10.mjs', 'A08 · decisions.决-6 必须逐字点名 test/audit/T10.mjs（且只有它）')
  eq((decT.perDecision['决-2'] || []).join(','), '', 'A08 · decisions.决-2 只写「同步 T03」—— 简称不产生放行面')
  assert(decT.allow.has('test/pack-template-rules.mjs'),
    'A08 · decisions.决-9 确实逐字点名了 test/pack-template-rules.mjs（更窄的预授权：只加登记项）')
  // 合并面：§12 ∪ decisions ∪ §6，deny 覆盖 allow
  const merged = mergeTestFaces({ authorization: scopes.allow, decisions: decT.allow, section6: s6Tests, deny: scopes.deny })
  for (const p of ['test/audit/T03.mjs', 'test/audit/T10.mjs', 'test/audit/T12.mjs']) {
    assert(merged.has(p), `A08 · 合并放行面必须有 ${p}（§6/decisions 逐条点名）`)
    eq(FACE_LABEL_RX.test(merged.get(p).authorizedBy), true,
      `A08 · ${p} 的放行理由必须写得出（授权节/决号/主人；实得 ${JSON.stringify(merged.get(p).authorizedBy)}）`)
    assert(merged.get(p).sources.some((x) => x.startsWith('decisions.决-')),
      `A08 · ${p} 的理由里必须有对应决号（实得 ${merged.get(p).sources.join('+')}）`)
    assert(/^U\d\d$/.test(String(merged.get(p).owner)), `A08 · ${p} 必须写出 §6 主人（实得 ${merged.get(p).owner}）`)
  }
  eq(merged.get('test/audit/T26.mjs').authorizedBy, 'scope.P2+§6/U01',
    'A08 · test/audit/T26.mjs 的理由必须同时写出授权节与 §6 主人（两面都在册）')
  assert(!merged.has(RULES_REL_X),
    'A08 · deny 覆盖 allow：即便 decisions.决-9 点名了 test/pack-template-rules.mjs，它也绝不进**通用**放行面（用户禁令优先；唯一例外是下面那条"只加登记项"形状豁免）')
  assert(!merged.has('test/_pack.mjs'), 'A08 · test/_pack.mjs 不在任何授权面里（仍是红）')
  for (const p of [...new Set([...scopes.allow.keys(), ...decT.allow.keys()])]) {
    assert(fs.existsSync(path.join(REPO, p)), `A08 · 授权面/决号点名的既有测试必须真的存在于盘上（存疑即不放行）：${p}`)
  }
  // 决-B1 的窄豁免：`test/pack-template-rules.mjs` 仍在永不必名单里（用户禁令照旧点名），
  // 只有"只加登记项"这一种**可机判形状**才从 deny 里让开；形状对不上仍然 conflict。
  const RULES_REL = 'test/pack-template-rules.mjs'
  const rulesShape = registrationsOnlyFromDiffU15(gitRead(['diff', '-U0', '--', RULES_REL]))
  assert(rulesShape.ok, `A08 · 决-B1 的豁免必须过「只加登记项」形状判据（实得 ${JSON.stringify(rulesShape.problems)}）`)
  {
    // 反空转：形状判据必须能"说不"（塞一行非登记代码就得不 ok，否则这条豁免是恒真的）
    const tampered = `${gitRead(['diff', '-U0', '--', RULES_REL])}+  'assets/whatever.js',\n`
    assert(!registrationsOnlyFromDiffU15(tampered).ok,
      'A08 · 形状判据的变异对照失败：塞一行非登记代码之后仍被判 ok（那这条豁免就是恒真的）')
  }
  const denyForConflicts = new Set(scopes.deny)
  if (rulesShape.ok) denyForConflicts.delete(RULES_REL)
  const mergedForConflicts = mergeTestFaces({ authorization: scopes.allow, decisions: decT.allow, section6: s6Tests, deny: denyForConflicts })
  const testConflict = classifyExistingTestConflicts(tracked, { allowedTests: mergedForConflicts, deniedTests: denyForConflicts })
  eq(testConflict.conflicts.length, 0,
    `A08 · 既有测试的改动不在任何授权面内（§12 scope.A/P1/P2 ∪ decisions.approvedChanged ∪ interfaces.md §6 有主都没逐条点名它）：${testConflict.conflicts.slice(0, 5).map((c) => `${c.code.trim() || '?'} ${c.path}`).join(', ')}`)
  // 被放行的既有测试改动必须**写得出理由**（授权节 / 决号 / §6 主人；放行了却署名不出 = 判据没生效）
  for (const t of tracked) {
    const p = posixRel(t.path)
    if (!/^test\//.test(p)) continue
    const hit = testConflict.allowed.find((a) => a.path === p)
    assert(hit && typeof hit.authorizedBy === 'string' && FACE_LABEL_RX.test(hit.authorizedBy),
      `A08 · 既有测试 ${p} 被放行却没写出理由（authorizedBy=${JSON.stringify(hit && hit.authorizedBy)} / owner=${JSON.stringify(hit && hit.owner)}）`)
  }
  // 本卡自己的入口不在 tracked 改动里（它是新建、未跟踪）—— 一旦变成 tracked 就是有人 add 了
  assert(!tracked.some((t) => t.path === 'test/audit/U15.mjs'), 'A08 · 本卡入口不该出现在 tracked 改动里（普通卡不 add）')
  const tProof = proveExistingTestBoundary({ allow: merged, deny: scopes.deny })
  eq(tProof.failures.length, 0, `A08 · 既有测试冲突分类器的自证失败：${tProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

  // ⑦ 【判据 4/4】交付物内容锁 + 证据根/临时目录归属 + 回执五项
  const lock = recordContentLock()
  eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
  eq(verifyContentLock().mismatches.length, 0, 'A08 · 内容锁当场复核就失败了')
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U15/runs/U15-<pid>')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true,
    'A08 · E:\\Temp 下带 U15- 前缀的新目录必须被接受')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
  eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')
  eq(path.dirname(PRE_FILE), EVIDENCE_ROOT_READ, 'A08 · 读取根必须恒为 <repo>/audit-evidence/U15')
  const g1 = guardTempPath(RUN_TEMP, { parent: TEMP_PARENT })
  eq(g1.ok, true, `A08 · 本次临时根必须归 ${TEMP_PARENT}（${g1.error || ''}）`)
  assert(/^u15-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u15-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')
  const scratch = path.join(RUN_TEMP, 'guard-scratch')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
  const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
  eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
  eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')

  // ⑧ tracked 回执：五项齐、写集逐条、R1 登记、合法 JSON 可 require
  const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
  assert(fs.existsSync(rcPath), `A08 · 缺 tracked 回执 docs/unify/receipts/${CARD}.json`)
  let rc = null
  try {
    rc = require_(rcPath)
  } catch (e) {
    throw new Error(`A08 · 回执不是合法 JSON（require 失败）：${e.message}`)
  }
  eq(rc.card, CARD, 'A08 · 回执 card 不对')
  eq(rc.status, 'PASS', 'A08 · 回执 status 必须是 PASS（判词以本入口为准）')
  for (const key of ['completion', 'dependencies', 'interfaceConsumption', 'writeSet', 'writeOutOfSet', 'deltas', 'verdict', 'unverified', 'evidenceIndex', 'assertions']) {
    assert(key in rc, `A08 · 回执缺字段 ${key}`)
  }
  sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
  // 回执**自指事实**：writeSet 里声明了 bytes / sha256 的条目必须与盘上逐字节一致
  // （回执自己那条不许声明 sha256 —— 自指不可能稳定；本判据只管"声明了就必须对"）
  for (const w of rc.writeSet) {
    if (typeof w === 'string') continue
    const abs = path.join(REPO, posixRel(w.path))
    assert(fs.existsSync(abs), `A08 · 回执 writeSet 里的 ${w.path} 盘上不存在`)
    if (typeof w.bytes === 'number') eq(fs.statSync(abs).size, w.bytes, `A08 · 回执声明的 ${w.path} bytes 与盘上不一致`)
    if (w.sha256) eq(sha256(fs.readFileSync(abs)), w.sha256, `A08 · 回执声明的 ${w.path} sha256 与盘上不一致`)
  }
  assert(/无/.test(JSON.stringify(rc.writeOutOfSet)), 'A08 · 回执必须写清越界项（无也写明）')
  assert(rc.authorization && rc.authorization.quoteVerbatim === '选A和授权p1和p2', 'A08 · 回执必须逐字引用授权原文')
  assert(/本卡不消费 A 面/.test(JSON.stringify(rc.authorization)), 'A08 · 回执必须写明「本卡不消费 A 面」')
  assert(/notAuthorized/.test(JSON.stringify(rc.authorization)), 'A08 · 回执必须写明授权面口径（authorized 逐字点名 / notAuthorized 永不进放行面）')
  const r1 = JSON.stringify(rc.unverified && rc.unverified.regressions ? rc.unverified.regressions : rc.unverified)
  assert(/U19/.test(r1) && /content\.cjs/.test(r1), 'A08 · R1（模板铺出来的包缺 tools/unify/content.cjs）必须登记在回执的未验证/回归里')
  for (const f of PACK_SHELLS) assert(r1.includes(path.posix.basename(f)), `A08 · R1 登记要逐文件点名 ${f}`)
  assert(rc.assertions && Object.keys(rc.assertions).length >= 8, 'A08 · 回执必须逐项写清 A01–A08 的断言内容')
  assert(Array.isArray(rc.deltas) && rc.deltas.length >= 1, 'A08 · 回执必须登记 Δ（身份变更 / 行为差异）')
  assert(rc.deltas.some((d) => d && d.kind === 'p1p2-test-authorization'), 'A08 · 回执必须登记本轮授权面修正的 Δ（kind=p1p2-test-authorization）')

  DETAIL.comparisons.A08 = {
    anchors: { sources: preDoc.sources.map((s) => s.path), deps: KERNEL_DEPS.length },
    shellFacts,
    writeGuard: {
      installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount,
      ops: guard.ops, probe: guard.probe, violations: guard.violations, proof: wProof.rows,
    },
    authorizedUnion: {
      cards: s6.size, paths: union.size,
      trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) ?? [] })),
      untrackedCount: untracked.length,
      outOfBounds: scopeCheck.outOfBounds,
      proof: sProof.rows,
    },
    authorizationScope: {
      quote: authz.quoteVerbatim,
      sections: AUTHZ_SECTIONS.map((n) => ({
        section: `scope.${n}`,
        present: scopes.perSection[n].present,
        title: scopes.perSection[n].title,
        authorizedPaths: scopes.perSection[n].authorized,
        notAuthorizedPaths: scopes.perSection[n].notAuthorized,
      })),
      allow: [...scopes.allow.entries()].map(([p, v]) => ({ path: p, authorizedBy: v.authorizedBy, item: v.item })),
      deny: [...scopes.deny.entries()].map(([p, v]) => ({ path: p, deniedBy: v.deniedBy, item: v.item })),
      // ② §6 有主：运行时从 interfaces.md §6 解析出的「既有测试 → 主人卡号」
      section6TestOwners: [...s6Tests.entries()].map(([p, cards]) => ({ path: p, owners: cards })),
      // ③ decisions.approvedChanged：逐条决号 → 它逐字点名的既有测试路径
      decisionPaths: decT.perDecision,
      // 三面合并后的**唯一放行面**（每条带出全部理由与 §6 主人；deny 已覆盖 allow）
      mergedAllow: [...merged.entries()].map(([p, v]) => ({ path: p, authorizedBy: v.authorizedBy, sources: v.sources, owner: v.owner })),
      trackedTestChanges: tracked
        .map((t) => posixRel(t.path))
        .filter((p) => /^test\//.test(p))
        .map((p) => {
          const hit = testConflict.allowed.find((a) => a.path === p) || {}
          return { path: p, authorizedBy: hit.authorizedBy ?? null, owner: hit.owner ?? null, sources: hit.sources ?? [] }
        }),
      conflicts: testConflict.conflicts,
      proof: tProof.rows,
    },
    contentLock: { recorded: lock.size, mismatches: 0 },
    manifestMode: {
      printedBytes: printed.out.length, printedLessons: printedDoc.lessons.length,
      offlineLessons: readPayload(offline).lessons.length,
      dangling: { strict: strictRun.exit, relaxed: relaxedRun.exit, pruned: relaxedPoint.requires },
    },
    receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */

/** 写守卫必须在**第一笔写之前**挂上（本卡的写全在夹具造包与证据落盘里） */
if (IS_MAIN) {
  fs.mkdirSync(RUN_TEMP, { recursive: true })
  installWriteGuard(writeAllowScope())
  try {
    probeWriteGuard()
  } catch (e) {
    WRITE_GUARD.probeError = String(e?.message ?? e)
  }
}

const CASES = [
  { id: 'A01', run: A01 },
  { id: 'A02', run: A02 },
  { id: 'A03', run: A03 },
  { id: 'A04', run: A04 },
  { id: 'A05', run: A05 },
  { id: 'A06', run: A06 },
  { id: 'A07', run: A07 },
  { id: 'A08', run: A08 },
]

/** 收口复核：整个进程的写 + 交付物内容锁（在所有写之后再看一遍） */
function closingAudit() {
  const w = sweepWriteGuard()
  const c = verifyContentLock()
  const reasons = []
  if (!w.installed) reasons.push('写守卫没挂上')
  if (w.probeError) reasons.push(`探针写失败：${w.probeError}`)
  if (w.probe && w.probe.recorded !== true) reasons.push('探针写未被守卫记录到')
  for (const v of w.violations.slice(0, 2)) reasons.push(`越界写 ${v.op} ${v.target}`)
  for (const m of c.mismatches.slice(0, 2)) reasons.push(`交付物被改 ${m.path}`)
  return { ok: reasons.length === 0, reasons, writeGuard: w, contentLock: c }
}

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
    DETAIL.preChange = { file: rel(PRE_FILE), bytes: fs.statSync(PRE_FILE).size, sha256: sha256(fs.readFileSync(PRE_FILE)) }
    fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
  }
  process.exitCode = printVerdict(verdict)
}
