/**
 * test/audit/U11.mjs —— 术语共享内核的专项判据（C lane · U11）
 * ==================================================================
 * 判的是这一件事：**术语计算与源码序列化只剩一份实现，IO 失败不再伪装成空词表**。
 *
 *   A01 术语文档固定输入输出等价 —— 改前快照（audit-evidence/U11/pre-change.json）↔ 改后逐例对拍：
 *       parseTermKeys / upsertTermSource（含全部拒写分支的错误文本）/ buildGlossaryMarkdown 全文 /
 *       glossarySummary / firstDiff / lesson.config.json 的 title 全变体 / writeGlossary+drift 三态 /
 *       loadGlossaryLedger / writeTermSurgically 落盘字节。
 *   A02 序列化及转义保持 —— 引号 / 反斜杠 / 真换行 / CRLF（已知归一）/ 中文 / emoji / `</script>` /
 *       `$&` 一类反向引用 / 反引号模板串 / 花括号 / 制表符 / U+2028 / HTML：逐例钉源码字面量形状 + require 往返。
 *   A03 读取失败不伪装为空词表 —— 目录 / 坏 JS / null / 数组 / 字符串 / 权限 → 明确 invalid 或 io-error，
 *       **绝不返回 `{}`**；合法空集合（出厂骨架）仍然是 `empty` + `{}`（对照，不是失败）。
 *   A04 同进程编辑后读取最新数据 —— 无模块级缓存：改文件再读立刻看到；title 也立刻看到。
 *   A05 宿主与包侧共用同一计算 —— E:\Temp 自建包（逐字复制权威模块）从**仓外 cwd** 跑包侧 CLI，
 *       产物与宿主逐字节相同；包侧文件里没有第二份计算。
 *   A06 空词表夹具 —— 基线与抽取后都实跑，比较首条新增 / 读取 / 重建；历史缺陷**未复现**（如实登记，
 *       不宣称修复），行为等价断言一条不少；T26 后的空术语迁移与同进程更新语义保留。
 *   A07 变异有效性 —— 临时（E:\Temp 副本）让包装入口包含独立计算 / 让加载返回旧缓存 → 判据必须红；
 *       干净副本必须绿；仓内文件一个字节都不受影响。
 *   A08 证据及范围守卫有效 —— 改前材料齐 + 依赖锚点 sha256 + 进程内 fs 写守卫（含探针写自证）+
 *       授权写集并集（tracked 侧，独立解析 interfaces.md §6）+ 交付物内容锁 + --evidence-root 守卫 +
 *       临时目录归属清理 + tracked 回执五项。
 *
 * 判词**只有一行**（unify-runner.printVerdict）：
 *   `PASS U11 checks=8 failed=0 skipped=0` → exit 0 ／ `FAIL U11 …` → 1 ／ `BLOCKED U11 …` → 2
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

const CARD = 'U11'
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
const KERNEL = 'lib/unify/glossary.cjs'

/** 三个宿主适配层（导出面逐字保留） */
const HOST = Object.freeze({
  glossary: 'lib/glossary.js',
  io: 'lib/glossary-io.js',
  edit: 'lib/glossary-edit-io.js',
})

/** 包侧薄委托 */
const PACK_WRAPPER = 'lib/pack-template/assets/build-glossary.js'

/**
 * 卡面精确写集（相对仓根）。A08 的 §6 对账要求**顺序**也一致（interfaces.md §6 的 U11 行）。
 */
const WRITE_SET = Object.freeze([
  KERNEL,
  HOST.glossary,
  HOST.io,
  HOST.edit,
  PACK_WRAPPER,
  'test/audit/U11.mjs',
  'docs/unify/receipts/U11.json',
])

/** 改前存在的四个文件（另一个是被新建的 KERNEL / 判据 / 回执） */
const CHANGED_FILES = Object.freeze([...Object.values(HOST), PACK_WRAPPER])

/** 内核的同目录依赖（A08 的依赖锚点：它们一漂，A01 的等价证明就不再对同一个内核成立） */
const KERNEL_DEPS = Object.freeze(['lib/unify/errors.cjs', 'lib/unify/text.cjs'])

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { comparisons: {}, temp: RUN_TEMP }

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

/**
 * 深度对拍：返回差异路径清单（改前 ↔ 改后逐例对拍的本体）。
 * 逐个路径列出来，而不是"整体不一致"——差异要能落到具体用例/具体字段。
 */
export function deepDiffs(pre, cur, at = '', out = []) {
  const ja = JSON.stringify(pre)
  const jb = JSON.stringify(cur)
  if (ja === jb) return out
  const bothObj = pre && cur && typeof pre === 'object' && typeof cur === 'object' && Array.isArray(pre) === Array.isArray(cur)
  if (bothObj) {
    const keys = new Set([...Object.keys(pre), ...Object.keys(cur)])
    for (const k of keys) deepDiffs(pre[k], cur[k], at ? `${at}.${k}` : String(k), out)
    return out
  }
  out.push({ path: at || '(根)', before: String(ja).slice(0, 240), after: String(jb).slice(0, 240) })
  return out
}

function assertNoDiff(pre, cur, group) {
  const diffs = deepDiffs(pre, cur, group)
  eq(diffs.length, 0,
    `${group} 与改前不一致（${diffs.length} 处）：${diffs.slice(0, 3).map((d) => `${d.path} 改前=${d.before} 改后=${d.after}`).join(' | ')}`)
  return diffs
}

/** 剥掉注释（源码层判据用；避免注释里的字样被当成"实现"） */
export function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function gitRead(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  eq(r.status, 0, `git ${args.join(' ')} 必须正常退出（stderr=${String(r.stderr || '').slice(0, 300)}）`)
  return String(r.stdout ?? '')
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U04 同一套纪律；本文件独立实现，不 import 兄弟卡的纯函数）
 * ──────────────────────────────────────────────────────────────────────
 * 「一个工作树、多 lane 并发」下，拿"改前整树 ↔ 现在的树"做全量对拍会**结构性假红**：
 * 兄弟 lane 落它们自己的合法写集（U01 的 baseline.json、U06 的 ledger-transaction.cjs、
 * U07 的 render.js / build-lessons.js…）会被算到本卡头上。所以判据换成四条可归因口径：
 *   ① 进程内 fs 写守卫 —— 本卡**本次进程**的每一次写都必须落在
 *      { 写集 7 项 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 }，并用**探针写**自证；
 *   ② 授权写集并集（tracked 侧）—— `git status --porcelain -uall` 的 tracked 改动
 *      （M/D/A/R）必须 ⊆ U01–U20 全部卡授权写集的并集（并集 = interfaces.md §6，独立解析）；
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

/**
 * **纯函数**：一个写入目标是否属于「本卡本次」的允许面（不读盘、无副作用）。
 * @returns {{allowed:boolean, why:string, abs:string}}
 */
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

/* ── 授权写集并集（tracked 侧，独立解析 interfaces.md §6） ─────────────────── */

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
    else outOfBounds.push({ code: e.code, path: e.path, why: '已跟踪文件被改/删/增/改名，而路径不在任何 U 卡的授权写集里（§6）' })
    if (e.from) {
      if (union.has(e.from)) allowed.push({ code: e.code, path: e.from, note: 'rename 来源' })
      else outOfBounds.push({ code: e.code, path: e.from, why: 'rename 的来源路径不在任何 U 卡授权写集里（§6）' })
    }
  }
  return { allowed, outOfBounds }
}

/**
 * A08 的**红路径本体**之一：喂人造 porcelain 行，双向钉死（野路径红 / 兄弟 lane 放行 / 混合只抓野的）。
 * 每次运行都跑，任何一条被改成恒真当场红。
 */
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
  one(' M lib/glossary.js', 'allow', '本卡（U11）写集')
  one(' M lib/pack-template/assets/build-glossary.js', 'allow', '本卡（U11）写集')
  one(' M lib/unify/text.cjs', 'allow', 'U04 写集（并发/已交付）')
  one(' M lib/pack-template/tools/ledger-transaction.cjs', 'allow', 'U06 写集（并发）')
  one(' M lib/render.js', 'allow', 'U07 写集（并发）')
  one(' M docs/unify/baseline.json', 'allow', 'U01 的出口（并发）')
  one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
  one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
  one(' D test/all.mjs', 'reject', '既有总入口被删')
  one('R  lib/glossary.js -> lib/whatever.js', 'reject', '改名到野路径（来源合法、目标不合法）')
  one('A  cards/U11.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
  one(' M audit-evidence/U11/pre-change.json', 'reject', '证据目录不被 §6 授权（它是 gitignore 的原始证据）')
  {
    const mixed = classifyTrackedWrites(
      splitPorcelainTracked([' M lib/glossary.js', ' M lib/render.js', ' M scripts/x.mjs']).tracked, union)
    const got = mixed.outOfBounds.map((v) => v.path).join(',')
    rows.push({
      line: 'MIX[ M lib/glossary.js | M lib/render.js | M scripts/x.mjs]', expect: 'scripts/x.mjs', got,
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
    ['lib/glossary.js', 'allow', '本卡写集（宿主适配层）'],
    ['docs/unify/receipts/U11.json', 'allow', '本卡写集（tracked 回执）'],
    ['test/audit/U11.mjs', 'allow', '本卡写集（本入口）'],
    [path.join(s.roots[0], 'pack-a05', 'tools', 'unify', 'glossary.cjs'), 'allow', 'E:\\Temp 本次临时根下的自建包'],
    ['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
    ['lib/render.js', 'reject', 'U07 写集 —— 同上'],
    ['lib/pack-template/tools/ledger-transaction.cjs', 'reject', 'U06 写集 —— 同上'],
    ['audit-evidence/U04/pre-change.json', 'reject', '兄弟卡的改前材料（本卡只读）'],
    ['lib/whatever.js', 'reject', '野路径'],
    ['test/_pack.mjs', 'reject', '既有测试'],
    [path.join(TEMP_PARENT, 'u11-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
    ['C:\\Windows\\u11-x.txt', 'reject', '与仓无关的绝对路径'],
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

/* ══════════════════════════════════════════════════════════════════════
 * 材料加载
 * ══════════════════════════════════════════════════════════════════════ */

let _pre = null
/** 读改前采集材料（缺材料 = BLOCKED，不是 FAIL） */
function pre() {
  if (_pre) return _pre
  if (!fs.existsSync(PRE_FILE)) {
    throw new Blocked(`缺改前采集材料：${rel(PRE_FILE)} —— 先跑 node audit-evidence/U11/capture-baseline.mjs（在改动之前）`)
  }
  let doc = null
  try {
    doc = JSON.parse(readText(PRE_FILE))
  } catch (e) {
    throw new Blocked(`改前采集材料不是合法 JSON：${rel(PRE_FILE)} —— ${e.message}`)
  }
  if (doc?.schema !== 'whale-unify-u11-pre-change/1' || doc?.card !== CARD) {
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

/* ── 三个出口的真实加载 ───────────────────────────────────────────────────── */

let _mods = null
async function mods() {
  if (_mods) return _mods
  const [glossary, io, edit] = await Promise.all([
    import(pathToFileURL(path.join(REPO, HOST.glossary)).href),
    import(pathToFileURL(path.join(REPO, HOST.io)).href),
    import(pathToFileURL(path.join(REPO, HOST.edit)).href),
  ])
  _mods = { glossary, io, edit }
  return _mods
}

/** 内核（CJS）—— 直接 require 权威源码 */
function kernel() {
  return require_(path.join(REPO, KERNEL))
}

/** 在本次临时根下造一个课程包夹具；`assets/glossary-data.js` 的内容由调用方给 */
function makePack(tag, ledgerText, config) {
  const root = path.join(RUN_TEMP, tag)
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  if (ledgerText !== undefined) fs.writeFileSync(path.join(root, 'assets', 'glossary-data.js'), ledgerText, 'utf8')
  if (config !== undefined) fs.writeFileSync(path.join(root, 'lesson.config.json'), config, 'utf8')
  return root
}

const SKELETON_LIKE = `(function (root, factory) {
  module.exports = factory();
}(this, function () {
  return {
    // 在这里按分类顺序添加名词……
  };
}));
`

const REC_A = { label: '甲', category: '甲类', official: 'O-A', short: 'S-A', analogy: 'A-A', lesson: '第1课' }
const REC_B = { label: '乙', category: '乙类', official: 'O-B', short: 'S-B', analogy: 'A-B', lesson: '第2课' }

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 术语文档固定输入输出等价（改前 ↔ 改后逐字节对拍）
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
  const fx = await fixtures()
  const preDoc = pre()
  const m = await mods()

  const cur = fx.runA01(m, RUN_TEMP)
  const diffs = assertNoDiff(preDoc.cases.A01, cur, 'A01')

  // 反空转：每一组都必须真的有料（空组会让"零差异"变成恒真）
  const groups = Object.keys(cur)
  eq(groups.sort().join(','), ['editWrite', 'firstDiff', 'load', 'markdown', 'parseTermKeys', 'summary', 'title', 'upsert', 'writer'].sort().join(','),
    'A01 的对比组集合必须完整（少了哪一组，改前↔改后就不是同一批输入）')
  assert(cur.parseTermKeys.length >= 14, `A01 · parseTermKeys 用例太少（${cur.parseTermKeys.length}）`)
  assert(cur.upsert.length >= 18, `A01 · upsert 用例太少（${cur.upsert.length}）`)
  const upsertErr = cur.upsert.filter((c) => c.result && c.result.ok === false)
  assert(upsertErr.length >= 5, `A01 · upsert 必须覆盖拒写分支（实得 ${upsertErr.length} 条抛错）—— 少了就说明错误路径没被对拍`)
  const upsertOk = cur.upsert.filter((c) => c.result && c.result.ok === true)
  assert(upsertOk.length >= 8, `A01 · upsert 必须覆盖成功分支（实得 ${upsertOk.length}）`)
  const titleErr = cur.title.filter((c) => c.result && c.result.ok === false)
  assert(titleErr.length >= 2, `A01 · title 必须覆盖坏 JSON / 空文件两条抛错（实得 ${titleErr.length}）`)
  const mdFull = cur.markdown.find((c) => c.id === 'two-categories')
  assert(mdFull && mdFull.plain.ok && mdFull.plain.snap.bytes > 2000, 'A01 · 两分类台账的 GLOSSARY.md 全文必须落进对拍面（不是只有哈希）')
  assert(/共 2 个名词，分为 2 类。/.test(mdFull.plain.text), 'A01 · GLOSSARY.md 的统计行必须在产物里（判据不是只看长度）')
  const w = cur.writer[0]
  eq(w.w1.ok, true, 'A01 · writeGlossary 必须成功')
  eq(w.w1.value.changed, true, 'A01 · 首次落盘必须 changed=true')
  eq(w.w2.value.changed, false, 'A01 · 内容没变时不得重写（changed=false）')
  eq(w.driftMissing.value.missing, true, 'A01 · 产物缺失时 drift 必须报 missing')
  eq(w.driftSame.value.consistent, true, 'A01 · 刚写完必须一致')
  eq(w.driftBroken.value.consistent, false, 'A01 · 改坏产物必须报不一致')
  assert(/第 \d+ 行第 \d+ 列/.test(w.driftBroken.value.detail), 'A01 · 漂移必须落到具体行/列')
  eq(cur.editWrite[0].result.ok, true, 'A01 · 空骨架上首条术语必须写得进去（T26 后语义）')

  DETAIL.comparisons.A01 = {
    groups: Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1])),
    diffs: diffs.length,
    markdownBytes: Object.fromEntries(cur.markdown.map((c) => [c.id, c.plain.ok ? c.plain.snap.bytes : -1])),
    upsertErrors: upsertErr.map((c) => c.id),
    titleErrors: titleErr.map((c) => c.id),
    writer: { w1: w.w1.value, w2: w.w2.value, driftBroken: w.driftBroken.value },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 序列化及转义保持
 * ══════════════════════════════════════════════════════════════════════ */

/** 单引号字面量里不许出现裸换行：一条记录的源码块固定 8 行（key + 5 字段 + lesson + `}`） */
const RECORD_BLOCK_LINES = 8

async function A02() {
  const fx = await fixtures()
  const preDoc = pre()
  const m = await mods()

  const cur = fx.runA02(m, RUN_TEMP)
  assertNoDiff(preDoc.cases.A02, cur, 'A02')

  const cases = cur.cases
  eq(cases.length, fx.escapeCases().length, 'A02 · 转义用例数必须与夹具声明一致')
  const defs = new Map(fx.escapeCases().map((d) => [d.id, d]))
  const byId = new Map(cases.map((c) => [c.id, c]))
  for (const id of ['single-quote', 'backslash', 'real-newline', 'crlf', 'emoji', 'script-close', 'dollar-refs', 'backtick', 'braces', 'tab', 'u2028', 'html-tags']) {
    assert(byId.has(id), `A02 · 缺转义用例 ${id}`)
  }

  for (const c of cases) {
    assert(c.recordSource.ok, `A02 · 用例 ${c.id} 序列化抛错：${c.recordSource.error && c.recordSource.error.message}`)
    // 形状：值一律写成单引号字面量，且**不许有裸换行**（8 行固定结构）
    eq(c.rawNewlineInLiteral, RECORD_BLOCK_LINES, `A02 · 用例 ${c.id} 的源码块必须是 ${RECORD_BLOCK_LINES} 行（换行必须转义成 \\n，不许出现裸换行）`)
    const literalLine = c.recordSource.text.split('\n').find((l) => l.startsWith('      ' + c.field + ': '))
    assert(literalLine, `A02 · 用例 ${c.id} 的 ${c.field} 字段行找不到`)
    assert(/^ {6}[a-z]+: '(?:[^'\\]|\\.)*'?,?$/.test(literalLine),
      `A02 · 用例 ${c.id} 的字段值必须是单引号字面量：${literalLine}`)
    // 往返：除已知有损用例（CRLF）外，require 回来必须逐字段相同
    if (c.note === 'lossy') {
      eq(c.roundTrip.same, false, `A02 · 用例 ${c.id}（${c.label}）在改前就是有损的，往返相同反而说明判据错了`)
      // 有损只允许发生在一个字段上：CRLF 归一成 LF，别的字段一个都不许动
      const want = nextRecord(c)
      for (const f of Object.keys(want)) {
        if (f === c.field) continue
        eq(JSON.stringify(c.roundTrip.got[f]), JSON.stringify(want[f]), `A02 · 用例 ${c.id} 的有损归一不许波及字段 ${f}`)
      }
      eq(c.roundTrip.got[c.field], String(defs.get(c.id).value).replace(/\r\n/g, '\n'), `A02 · 用例 ${c.id} 的 CRLF 必须归一成 LF（改前语义）`)
      assert(!String(c.roundTrip.got[c.field]).includes('\r'), `A02 · 用例 ${c.id} 的 CRLF 必须归一成 LF`)
    } else {
      eq(c.roundTrip.same, true, `A02 · 用例 ${c.id}（${c.label}）require 往返必须逐字段相同`)
    }
  }

  // 逐形状钉住（不是"看着对"）：这些是改前就有的具体字节形状
  const srcOf = (id) => byId.get(id).recordSource.text
  assert(srcOf('single-quote').includes("it\\'s a \\'quoted\\' thing"), 'A02 · 单引号必须写成 \\\'')
  assert(srcOf('backslash').includes('C:\\\\path\\\\to\\\\file'), 'A02 · 反斜杠必须写成 \\\\')
  assert(srcOf('real-newline').includes('line1\\nline2'), 'A02 · 真换行必须写成 \\n')
  assert(srcOf('backslash-n-as-text').includes('a\\\\nb'), 'A02 · 字面反斜杠+n 不许被当成换行（必须写成 \\\\n）')
  assert(srcOf('emoji').includes('中文🙂🚀'), 'A02 · emoji（代理对）必须原样保留')
  assert(srcOf('script-close').includes('</script><script>alert(1)</script>'),
    'A02 · `</script>` 一类逃逸形状必须原样进字面量（不做 HTML 转义）')
  // `$&` / `$'` / `$`` 是 String.replace 的反向引用陷阱：序列化用的是切片拼接，所以它们必须原样躺在字面量里
  assert(srcOf('dollar-refs').includes('$&'), 'A02 · `$&` 必须原样保留（不许被 String.replace 的反向引用吃掉）')
  assert(srcOf('dollar-refs').includes("$\\'"), 'A02 · `$\'` 必须写成 `$\\\'`（只有引号被转义，`$` 不动）')
  assert(srcOf('dollar-refs').includes('$1') && srcOf('dollar-refs').includes('$<x>'), 'A02 · `$1` / `$<x>` 必须原样保留')
  eq(byId.get('dollar-refs').roundTrip.got.official, "$& $' $` $1 $<x>", 'A02 · `$& $\\\' $` $1 $<x>` 往返必须逐字相同')
  assert(srcOf('backtick').includes('`tpl ${x}`'), 'A02 · 反引号模板串必须原样保留')
  assert(srcOf('html-tags').includes('<b>x</b>'), 'A02 · HTML 标签必须原样保留')
  assert(srcOf('u2028').includes('\u2028'), 'A02 · U+2028 必须原样保留（Node 的字符串字面量允许它）')
  assert(!/\\u2028/.test(srcOf('u2028')), 'A02 · U+2028 没有被写成转义序列（形状要跟改前一致）')

  DETAIL.comparisons.A02 = {
    cases: cases.length,
    ids: cases.map((c) => c.id),
    lossy: cases.filter((c) => c.note === 'lossy').map((c) => c.id),
    lines: [...new Set(cases.map((c) => c.rawNewlineInLiteral))],
  }
}

/** A02 的往返期望：六字段里除了被测字段之外都等于 REC_PLAIN */
function nextRecord(c) {
  const base = fixturesRecBase()
  return { ...base, [c.field]: c.value }
}

/** 与 fixtures.mjs 的 REC_PLAIN 同一份（引一次即可；避免在两处各写一遍） */
function fixturesRecBase() {
  return { label: '向量', category: '代数', official: 'Vector', short: '有方向的量', analogy: '箭头', lesson: '第1课' }
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 读取失败不伪装为空词表
 * ══════════════════════════════════════════════════════════════════════ */

async function A03() {
  const m = await mods()
  const core = kernel()

  const cases = []
  const add = (id, kind, dir) => cases.push({ id, kind, dir })

  // ① 目录（EISDIR / EPERM：路径上是目录，不是台账文件）
  {
    const dir = path.join(RUN_TEMP, 'a03-dir')
    fs.mkdirSync(path.join(dir, 'assets', 'glossary-data.js'), { recursive: true })
    add('directory', 'io-error', dir)
  }
  // ② 坏 JS（语法错）
  {
    const dir = makePack('a03-bad-js', `(function (root, factory) {\n  module.exports = factory();\n}(this, function () {\n  return {\n    a: {\n  };\n}));\n`)
    add('bad-syntax', 'invalid', dir)
  }
  // ③ 导出的不是记录对象：null / 数组 / 字符串
  for (const [id, body] of [
    ['export-null', 'module.exports = null;'],
    ['export-array', 'module.exports = [];'],
    ['export-string', 'module.exports = "nope";'],
    ['export-array-with-entries', 'module.exports = [{ label: "x" }];'],
  ]) {
    const dir = makePack('a03-' + id, body + '\n')
    add(id, 'invalid', dir)
  }
  // ④ 记录不是对象
  {
    const dir = makePack('a03-bad-record', 'module.exports = { a: "not-an-object" };\n')
    add('bad-record', 'invalid', dir)
  }
  // ⑤ 文件不存在（missing —— 只有真 ENOENT 才算"没有台账"）
  {
    const dir = path.join(RUN_TEMP, 'a03-missing')
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    add('missing-file', 'missing', dir)
  }
  // ⑥ 权限（注入 fs：EACCES / EPERM，系统码必须原样保留）
  {
    const injected = [
      { id: 'eacces', code: 'EACCES' },
      { id: 'eperm', code: 'EPERM' },
      { id: 'emfile', code: 'EMFILE' },
    ]
    for (const c of injected) {
      const fakeFs = {
        readFileSync() {
          const e = new Error(`${c.code}: injected failure`)
          e.code = c.code
          throw e
        },
      }
      const r = core.loadLedger({ abs: path.join(RUN_TEMP, 'injected', 'glossary-data.js'), fs: fakeFs, requireFrom: () => ({}) })
      eq(r.status, 'io-error', `A03 · 注入 ${c.code} 必须判 io-error（实得 ${r.status}）`)
      eq(r.errorCode, c.code, `A03 · ${c.code} 的系统码必须原样保留`)
      eq(r.ledger, null, `A03 · ${c.code} 下不许给出任何 ledger（尤其不许是 {}）`)
      eq(r.failure.kind, 'io', `A03 · ${c.code} 的 failure.kind 必须是 io`)
      eq(r.failure.code, core.IO_ERROR_CODE, `A03 · ${c.code} 的业务码必须是既有 IO_ERROR（不改名）`)
      eq(r.failure.errorCode, c.code, `A03 · ${c.code} 的 failure.errorCode 必须原样保留系统码`)
      cases.push({ id: `injected-${c.id}`, kind: 'io-error', injected: c.code, result: r })
    }
  }

  const observed = []
  for (const c of cases) {
    if (c.injected) { observed.push({ id: c.id, status: 'io-error', code: c.injected }); continue }
    const abs = path.join(c.dir, 'assets', 'glossary-data.js')

    // ① 内核层的五态结果
    const r = core.loadLedger({ abs, fs, requireFrom: require_ })
    eq(r.status, c.kind, `A03 · ${c.id} 必须判 ${c.kind}（实得 ${r.status}；problems=${JSON.stringify(r.problems)})`)
    if (c.kind === 'missing') {
      eq(r.ledger, null, 'A03 · missing 不许返回 {}（空词表是伪装，缺文件是缺文件）')
      eq(r.errorCode, 'ENOENT', 'A03 · missing 的系统码必须是 ENOENT')
    } else {
      eq(r.ledger, null, `A03 · ${c.id} 不许返回任何 ledger（尤其不许 {}）—— 这正是"读取失败伪装成空词表"）`)
      assert(r.failure, `A03 · ${c.id} 必须给统一失败结构 failure`)
      eq(r.failure.kind, c.kind === 'invalid' ? 'input' : 'io', `A03 · ${c.id} 的 failure.kind 不对`)
      eq(r.failure.code, c.kind === 'invalid' ? core.LEDGER_INVALID_CODE : core.IO_ERROR_CODE,
        `A03 · ${c.id} 的 failure.code 不对`)
      assert(r.problems.length >= 1, `A03 · ${c.id} 必须报出问题文本（不许静默）`)
      eq(typeof r.file, 'string', 'A03 · 失败结果必须点名文件')
    }

    // ② 宿主适配层：**抛**，绝不返回空台账
    let returned = null
    let thrown = null
    try {
      returned = m.io.loadGlossaryLedger(c.dir)
    } catch (e) {
      thrown = e
    }
    eq(thrown !== null, true, `A03 · loadGlossaryLedger 在 ${c.id} 上必须抛（实得返回 ${fmt(returned)}）`)
    eq(thrown.status, c.kind, `A03 · 抛出的 err.status 必须是 ${c.kind}`)
    eq(thrown.ledger, null, 'A03 · 抛出的 err.ledger 必须是 null')
    assert(thrown.message && thrown.message.length > 8, 'A03 · 错误信息不能是空话')

    // ③ 合成入口同样不许产出"空词表"文档
    let md = null
    let mdError = null
    try {
      md = m.io.expectedGlossaryMarkdown(c.dir)
    } catch (e) {
      mdError = e
    }
    eq(mdError !== null, true, `A03 · expectedGlossaryMarkdown 在 ${c.id} 上必须抛（不许合成出一份 0 名词的 GLOSSARY.md）`)
    eq(md, null, 'A03 · 失败时不许有合成结果')

    observed.push({ id: c.id, status: r.status, errorCode: r.errorCode ?? null, failure: r.failure?.code ?? null })
  }

  // ⑦ 对照：**合法空集合**必须仍然是 empty + {}（不是失败）——否则上面的判据就是"凡空即错"
  {
    const dir = makePack('a03-empty-ok', SKELETON_LIKE)
    const r = core.loadLedger({ abs: path.join(dir, 'assets', 'glossary-data.js'), fs, requireFrom: require_ })
    eq(r.status, 'empty', 'A03 · 出厂骨架（空对象 + 注释）必须判 empty')
    eq(r.ledger !== null && Object.keys(r.ledger).length, 0, 'A03 · empty 必须返回空对象（合法空集合）')
    const led = m.io.loadGlossaryLedger(dir)
    eq(Object.keys(led).length, 0, 'A03 · 空台账经适配层必须原样返回 {}')
    const md = m.io.expectedGlossaryMarkdown(dir)
    assert(/共 0 个名词，分为 0 类/.test(md), 'A03 · 空台账必须合成出"共 0 个名词"的合法文档')
    const summary = m.io.glossarySummary(led)
    eq(summary.count, 0, 'A03 · 空台账概览条数必须是 0')
  }

  // ⑧ 包侧 CLI 同一口径：坏台账 → 非零退出，且**不写出** GLOSSARY.md
  {
    const pack = await buildPackFixture('a03-cli-pack')
    fs.writeFileSync(path.join(pack, 'assets', 'glossary-data.js'), 'module.exports = null;\n', 'utf8')
    const out = runPackCli(pack)
    assert(out.status !== 0, `A03 · 包侧 CLI 在坏台账上必须非零退出（实得 ${out.status}）`)
    eq(fs.existsSync(path.join(pack, 'GLOSSARY.md')), false, 'A03 · 包侧 CLI 失败时不许写出 GLOSSARY.md（不许伪装成空词表）')
    assert(/invalid|LEDGER_INVALID|不是一个记录对象/.test(String(out.stderr) + String(out.stdout)),
      `A03 · 包侧 CLI 的错误里要点明 invalid/LEDGER_INVALID（实得 ${String(out.stderr).slice(0, 200)}）`)
  }

  DETAIL.comparisons.A03 = { cases: observed }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 同进程编辑后读取最新数据（无模块级缓存）
 * ══════════════════════════════════════════════════════════════════════ */

async function A04() {
  const m = await mods()
  const fx = await fixtures()

  const dir = makePack('a04-fresh', SKELETON_LIKE, '{"title":"甲"}')
  const ledgerAbs = path.join(dir, 'assets', 'glossary-data.js')
  const rounds = []

  // ① 初始：空台账
  eq(Object.keys(m.io.loadGlossaryLedger(dir)).length, 0, 'A04 · 初始应是空台账')

  // ② 同进程写第一条 → 立刻读到
  const w1 = m.edit.writeTermSurgically({ root: dir, key: 'a', record: REC_A })
  eq(w1.ok, true, 'A04 · 首条写入必须成功')
  const afterW1 = m.io.loadGlossaryLedger(dir)
  sameJson(Object.keys(afterW1), ['a'], 'A04 · 写完立刻读必须看到新键（无模块级缓存）')
  rounds.push({ step: 'write-a', keys: Object.keys(afterW1) })

  // ③ 同进程再写第二条 → 立刻读到两条
  const w2 = m.edit.writeTermSurgically({ root: dir, key: 'b', record: REC_B })
  eq(w2.ok, true, 'A04 · 第二条写入必须成功')
  const afterW2 = m.io.loadGlossaryLedger(dir)
  sameJson(Object.keys(afterW2), ['a', 'b'], 'A04 · 第二次写完也必须立刻看到（缓存没被清就是这里红）')
  rounds.push({ step: 'write-b', keys: Object.keys(afterW2) })

  // ④ 直接改文件（绕过事务）→ 立刻读到
  const srcNow = readText(ledgerAbs)
  const third = kernel().upsertTermSource(srcNow, 'c', { ...REC_A, label: '丙' })
  fs.writeFileSync(ledgerAbs, third, 'utf8')
  const afterDirect = m.io.loadGlossaryLedger(dir)
  sameJson(Object.keys(afterDirect), ['a', 'b', 'c'], 'A04 · 直接改文件后也必须立刻看到（不许拿旧缓存充数）')
  rounds.push({ step: 'direct-write-c', keys: Object.keys(afterDirect) })

  // ⑤ 替换已有键 → 立刻读到新内容（不只键表新鲜，值也新鲜）
  const w4 = m.edit.writeTermSurgically({ root: dir, key: 'a', record: { ...REC_A, short: 'S-A-改' }, replace: true })
  eq(w4.ok, true, 'A04 · replace 必须成功')
  eq(m.io.loadGlossaryLedger(dir).a.short, 'S-A-改', 'A04 · 值的更新也必须立刻可见')
  rounds.push({ step: 'replace-a', short: m.io.loadGlossaryLedger(dir).a.short })

  // ⑥ 标题（lesson.config.json）同样不许缓存
  const first = m.io.expectedGlossaryMarkdown(dir).split('\n')[0]
  assert(/^# 甲 名词速查笔记/.test(first), `A04 · 初始标题必须是「甲」（实得 ${first}）`)
  fs.writeFileSync(path.join(dir, 'lesson.config.json'), '{"title":"乙"}', 'utf8')
  const second = m.io.expectedGlossaryMarkdown(dir).split('\n')[0]
  assert(/^# 乙 名词速查笔记/.test(second), `A04 · 改了 title 之后必须立刻看到新标题（实得 ${second}）`)
  rounds.push({ step: 'title', first, second })

  // ⑦ verifyLoadedTerm 也必须看到最新字节
  const verified = m.edit.verifyLoadedTerm(ledgerAbs, 'a', { ...REC_A, short: 'S-A-改' })
  eq(verified.ok, true, `A04 · verifyLoadedTerm 必须读到最新记录（${verified.error || ''}）`)

  // ⑧ 反空转：三态键表必须互不相同（否则"同进程最新"这条断言是空转的）
  const keySignatures = new Set(rounds.filter((r) => r.keys).map((r) => r.keys.join(',')))
  eq(keySignatures.size, 3, `A04 · 三次读到的键表必须各不同（实得 ${[...keySignatures].join(' / ')}）`)

  DETAIL.comparisons.A04 = { rounds, verified: verified.ok }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 宿主与包侧共用同一计算
 * ══════════════════════════════════════════════════════════════════════ */

/** 权威模块清单：逐字复制进 E:\Temp 自建包（= U19 之后随包的真实布局） */
const AUTHORITY = Object.freeze(['glossary.cjs', 'errors.cjs', 'text.cjs'])

/** 包装器里**不许出现**的计算痕迹（任何一条命中都说明包侧留下了第二份实现） */
const FORBIDDEN_COMPUTE = Object.freeze([
  '## 目录',
  '名词速查笔记',
  '分类跳转',
  'Object.keys(',
  '.toLowerCase()',
  'byCategory',
  '\\u4e00',
  'slug',
  'termRecordSource',
  'upsertTermSource',
  'parseTermKeys',
  '共 ',
  '1. 打开',
  "'    ' +",
  'replace(/\'',
])

/**
 * **纯函数**：包侧包装器是不是"只剩委托"（A05 与 A07 用的是同一个判据 —— A07 变异它必须红）。
 * @returns {{ok:boolean, problems:string[], requires:string[]}}
 */
export function judgeOneComputation(src) {
  const code = stripComments(String(src))
  const problems = []
  const requires = [...code.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((x) => x[1])
  const allowed = new Set(['fs', 'path', '../tools/unify/glossary.cjs'])
  for (const r of requires) if (!allowed.has(r)) problems.push(`多余的 require：${r}`)
  if (!requires.includes('../tools/unify/glossary.cjs')) problems.push('没有把计算委托给 ../tools/unify/glossary.cjs')
  if ((code.match(/require\(/g) || []).length !== requires.length) problems.push('有非字面量的 require（无法静态判定委托目标）')
  for (const token of FORBIDDEN_COMPUTE) if (code.includes(token)) problems.push(`残留计算痕迹 ${JSON.stringify(token)}`)
  if (/function\s+[A-Za-z_$]/.test(code)) problems.push('文件里出现函数声明（第二份计算）')
  if (/=>/.test(code)) problems.push('文件里出现箭头函数（第二份计算）')
  if (/class\s+[A-Za-z_$]/.test(code)) problems.push('文件里出现 class（第二份计算）')
  const calls = [...code.matchAll(/\bcore\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1])
  if (calls.length < 4) problems.push(`对内核的调用太少（${calls.join(',') || '无'}）—— 委托不完整`)
  return { ok: problems.length === 0, problems, requires, calls: [...new Set(calls)] }
}

/** 在本次临时根下建一个真实形态的自建包（assets + tools/unify + 数据源 + 配置） */
async function buildPackFixture(tag, { terms = 0, title = '数学' } = {}) {
  const root = path.join(RUN_TEMP, tag)
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tools', 'unify'), { recursive: true })
  // ① 包侧包装器 = 仓内模板那份**逐字节副本**
  fs.copyFileSync(path.join(REPO, PACK_WRAPPER), path.join(root, 'assets', 'build-glossary.js'))
  // ② 权威模块逐字复制（U19 会做同样的事：lib/unify/<mod>.cjs → tools/unify/<mod>.cjs）
  for (const f of AUTHORITY) {
    fs.copyFileSync(path.join(REPO, 'lib', 'unify', f), path.join(root, 'tools', 'unify', f))
  }
  // ③ 数据源 + 标题配置
  let ledger = SKELETON_LIKE
  const core = kernel()
  for (let i = 0; i < terms; i++) {
    ledger = core.upsertTermSource(ledger, i === 0 ? 'a' : i === 1 ? 'b' : `t${i}`, i === 0 ? REC_A : REC_B)
  }
  fs.writeFileSync(path.join(root, 'assets', 'glossary-data.js'), ledger, 'utf8')
  if (title !== null) fs.writeFileSync(path.join(root, 'lesson.config.json'), JSON.stringify({ title }), 'utf8')
  return root
}

/** 从**仓外 cwd** 跑包侧 CLI（子进程；cwd 固定 E:\Temp） */
function runPackCli(pack) {
  const r = spawnSync(process.execPath, [path.join(pack, 'assets', 'build-glossary.js')], {
    cwd: TEMP_PARENT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.error) throw new Error(`包侧 CLI 起不来：${r.error.message}`)
  return { status: r.status, signal: r.signal, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

async function A05() {
  const m = await mods()
  const core = kernel()

  const pack = await buildPackFixture('a05-pack', { terms: 2, title: '数学' })

  // ① 仓内模板那份包装器本身必须"只剩委托"
  const wrapperSrc = readText(path.join(REPO, PACK_WRAPPER))
  const verdict = judgeOneComputation(wrapperSrc)
  eq(verdict.ok, true, `A05 · 包侧包装器不是纯委托：${verdict.problems.join('；')}`)
  sameJson(verdict.requires.sort(), ['../tools/unify/glossary.cjs', 'fs', 'path'], 'A05 · 包装器只许 require 三个件（内核 + 两个内置）')

  // ② 复制进自建包的权威模块必须与仓内**逐字节相同**
  const copied = []
  for (const f of AUTHORITY) {
    const a = fs.readFileSync(path.join(REPO, 'lib', 'unify', f))
    const b = fs.readFileSync(path.join(pack, 'tools', 'unify', f))
    eq(sha256(b), sha256(a), `A05 · 复制进自建包的 tools/unify/${f} 必须与仓内权威模块逐字节相同`)
    copied.push({ file: f, bytes: a.length, sha256: sha256(a) })
  }
  eq(sha256(fs.readFileSync(path.join(pack, 'assets', 'build-glossary.js'))), sha256(Buffer.from(wrapperSrc, 'utf8')),
    'A05 · 自建包里的 build-glossary.js 必须与仓内模板那份逐字节相同')

  // ③ 从**仓外 cwd** 跑包侧 CLI
  const run1 = runPackCli(pack)
  eq(run1.status, 0, `A05 · 包侧 CLI 必须 exit 0（stderr=${run1.stderr.slice(0, 400)}）`)
  eq(run1.signal, null, 'A05 · 包侧 CLI 不许被信号打断')

  // ④ 产物与宿主逐字节相同（这就是"共用同一计算"）
  const packOut = path.join(pack, 'GLOSSARY.md')
  assert(fs.existsSync(packOut), 'A05 · 包侧 CLI 必须写出 GLOSSARY.md')
  const packBytes = fs.readFileSync(packOut, 'utf8')
  const hostBytes = m.io.expectedGlossaryMarkdown(pack)
  eq(sha256(Buffer.from(packBytes, 'utf8')), sha256(Buffer.from(hostBytes, 'utf8')),
    `A05 · 包侧产物与宿主合成必须逐字节相同（包侧 ${Buffer.byteLength(packBytes)} B / 宿主 ${Buffer.byteLength(hostBytes)} B）`)
  eq(packBytes, hostBytes, 'A05 · 包侧产物与宿主合成必须逐字节相同（字符串级）')
  // 再与"内核直接合成"比一次（绕开任何适配层）
  const ledgerObj = m.io.loadGlossaryLedger(pack)
  eq(packBytes, core.buildGlossaryMarkdown(ledgerObj, { title: '数学' }), 'A05 · 包侧产物必须与内核直接合成逐字节相同')

  // ⑤ CLI 输出文案（被断言的部分保留）
  const lines = run1.stdout.split('\n').filter((l) => l !== '')
  const wantLines = core.glossaryCliLines({ ledger: ledgerObj, outRel: 'GLOSSARY.md' })
  sameJson(lines, wantLines, 'A05 · CLI 输出文案必须与内核的单一来源一致')
  assert(/^\[build-glossary\] 已生成 GLOSSARY\.md$/.test(lines[0]), `A05 · 第一行文案是 CLI 契约：${lines[0]}`)
  assert(/^\[build-glossary\] 名词 2 个，分类 2 个$/.test(lines[1]), `A05 · 第二行文案是 CLI 契约：${lines[1]}`)
  eq(lines.length, 2 + 2, 'A05 · 两个分类必须各打一行')

  // ⑥ 幂等：再跑一次，产物逐字节不变（原子写 + 同一计算）
  const run2 = runPackCli(pack)
  eq(run2.status, 0, 'A05 · 第二次运行也必须 exit 0')
  eq(sha256(fs.readFileSync(packOut)), sha256(Buffer.from(packBytes, 'utf8')), 'A05 · 第二次运行产物必须逐字节不变')

  // ⑦ 反向对照：宿主这一侧改了逻辑，包侧**不可能**不同步（同一份内核）
  eq(sha256(fs.readFileSync(path.join(pack, 'tools', 'unify', 'glossary.cjs'))), sha256(fs.readFileSync(path.join(REPO, KERNEL))),
    'A05 · 包里跑的就是仓内那份内核（不是别的副本）')

  DETAIL.comparisons.A05 = {
    pack,
    copied,
    wrapper: { requires: verdict.requires, calls: verdict.calls, problems: verdict.problems },
    bytes: Buffer.byteLength(packBytes, 'utf8'),
    cli: { status: run1.status, lines },
    idempotent: true,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 空词表夹具：基线与抽取后都实跑，比较首条新增 / 读取 / 重建
 * ──────────────────────────────────────────────────────────────────────
 * 卡面明令：删除"情况书中的空词表缺陷"这一无定义要求，改成可复现的行为断言。
 * 结论（本次实测）：**历史缺陷未复现** —— 固定基线 2f57b1f 的实现已经能在
 * "空对象 + 注释"的出厂骨架上插入第一个术语（改前采集 firstAdd.ok=true）。
 * 所以本卡**不宣称修复了它**，只做行为等价的逐字节对拍。
 * ══════════════════════════════════════════════════════════════════════ */

async function A06() {
  const fx = await fixtures()
  const preDoc = pre()
  const m = await mods()

  const now = fx.runA06(m, RUN_TEMP)
  const preA06 = preDoc.cases.A06
  assertNoDiff(preA06, now, 'A06')

  // ① 首条新增：两侧都成功，且**历史缺陷未复现**
  eq(now.firstAdd.ok, true, 'A06 · 空骨架（带注释）上的首条新增必须成功')
  eq(now.firstAdd.historyDefectReproduced, false, 'A06 · 历史缺陷必须**未复现**（复现了就要如实登记，不能宣称修复）')
  eq(preA06.firstAdd.historyDefectReproduced, false, 'A06 · 改前采集里历史缺陷也必须未复现（否则"未复现"这句话是假的）')
  eq(now.firstAdd.commentKept, true, 'A06 · 首条新增不许为了过测试删骨架注释')
  sameJson(now.firstAdd.keysAfter, { ok: true, value: ['responsebody'] }, 'A06 · 首条新增后键表必须只有一条')

  // ② 读取：落盘 → 同进程重读，六字段逐字一致
  eq(now.write.ok, true, `A06 · writeTermSurgically 在空包上必须成功（${now.write.message || ''}）`)
  eq(now.write.value.ok, true, 'A06 · 写回执必须 ok=true')
  eq(now.write.value.replaced, false, 'A06 · 首条必须是新增而不是替换')
  eq(now.reload.ok, true, 'A06 · 重读必须成功')
  sameJson(now.reload.keys, ['responsebody'], 'A06 · 重读必须只有那一条')
  sameJson(now.reload.record, fixturesRecBase(), 'A06 · 重读的六字段必须与写进去的逐字一致')
  eq(now.summary.value.count, 1, 'A06 · 概览条数必须是 1')

  // ③ 重建：GLOSSARY.md 必须是"共 1 个名词"
  eq(now.rebuild.ok, true, 'A06 · 重建必须成功')
  assert(/共 1 个名词，分为 1 类/.test(now.rebuild.text), 'A06 · 重建后的统计行必须是"共 1 个名词，分为 1 类"')
  assert(now.rebuild.text.includes('响应体') || now.rebuild.text.includes('向量'), 'A06 · 重建后的正文必须包含新术语的 label')
  eq(now.writeGlossary.value.changed, true, 'A06 · 首次落盘必须 changed=true')
  eq(now.disk.sha256, now.rebuild.snap.sha256, 'A06 · 磁盘产物必须与合成结果逐字节相同')

  // ④ 合法空集合仍然合法（对照）
  sameJson(now.emptyLedger.keys, [], 'A06 · 空台账必须返回 {}')
  eq(now.emptyLedger.summary.count, 0, 'A06 · 空台账概览必须是 0 条')
  assert(/^# 课程 名词速查笔记/.test(now.emptyMarkdown.firstLine), 'A06 · 空台账必须合成出合法文档')

  // ⑤ T26 后的**同进程更新语义**不许被重新引入性问题（再写一条 + replace 一条）
  const dir = path.join(RUN_TEMP, 'a06-empty-pack')
  const second = m.edit.writeTermSurgically({ root: dir, key: 'second', record: REC_B })
  eq(second.ok, true, 'A06 · 已有一条记录时再新增必须成功（末条补逗号那条路）')
  const two = m.io.loadGlossaryLedger(dir)
  sameJson(Object.keys(two), ['responsebody', 'second'], 'A06 · 第二条之后键表顺序必须不变')
  const replaced = m.edit.writeTermSurgically({ root: dir, key: 'responsebody', record: { ...REC_A, short: '换掉' }, replace: true })
  eq(replaced.ok, true, 'A06 · replace 必须成功')
  const after = m.io.loadGlossaryLedger(dir)
  eq(after.responsebody.short, '换掉', 'A06 · replace 后同进程重读必须看到新值')
  eq(after.second.label, REC_B.label, 'A06 · 别的记录必须原样保留')
  assert(readText(path.join(dir, 'assets', 'glossary-data.js')).includes('// 在这里按分类顺序添加名词'),
    'A06 · 全程不许把骨架注释弄丢')

  // ⑥ "未复现，不宣称修复"必须落进 tracked 回执（否则这句话只在代码里）
  const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
  assert(fs.existsSync(rcPath), 'A06 · 缺 tracked 回执')
  const rc = JSON.parse(readText(rcPath))
  const note = JSON.stringify(rc.deltas || []) + JSON.stringify(rc.assertions || '') + JSON.stringify(rc.unverified || '')
  assert(/未复现/.test(note), 'A06 · 回执里必须显式写「未复现，不宣称修复」')
  assert(/A06/.test(note), 'A06 · 回执里的「未复现」必须点名 A06')

  DETAIL.comparisons.A06 = {
    historyDefectReproduced: { before: preA06.firstAdd.historyDefectReproduced, after: now.firstAdd.historyDefectReproduced },
    firstAdd: { ok: now.firstAdd.ok, bytes: now.firstAdd.out.bytes, sha16: now.firstAdd.out.sha16 },
    rebuild: now.rebuild.snap,
    emptyLedger: now.emptyLedger.summary,
    sameProcessUpdate: { keys: Object.keys(after), short: after.responsebody.short },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 变异有效性（只在 E:\Temp 副本上）
 * ══════════════════════════════════════════════════════════════════════ */

/** 一个"带回旧缓存"判据：v1 写入 → 读 → 同进程改成 v2 → 再读必须看到 v2 */
export function judgeFreshness(kernelAbs, fixtureDir) {
  const requireFrom = createRequire(kernelAbs)
  const k = requireFrom(kernelAbs)
  const ledgerAbs = path.join(fixtureDir, 'assets', 'glossary-data.js')
  const readKeys = () => {
    const r = k.loadLedger({ abs: ledgerAbs, fs, requireFrom })
    return r.status === 'ok' || r.status === 'empty' ? Object.keys(r.ledger) : null
  }
  const v1 = k.upsertTermSource(SKELETON_LIKE, 'a', REC_A)
  const v2 = k.upsertTermSource(v1, 'b', REC_B)
  fs.writeFileSync(ledgerAbs, v1, 'utf8')
  const first = readKeys()
  fs.writeFileSync(ledgerAbs, v2, 'utf8')
  const second = readKeys()
  return {
    first,
    second,
    fresh: JSON.stringify(second) === JSON.stringify(['a', 'b']),
    stale: JSON.stringify(second) === JSON.stringify(first),
    status: { first: first && first.length, second: second && second.length },
  }
}

async function A07() {
  const m = await mods()
  const repoKernelBefore = sha256(fs.readFileSync(path.join(REPO, KERNEL)))
  const wrapperBefore = sha256(fs.readFileSync(path.join(REPO, PACK_WRAPPER)))
  const mutRoot = path.join(RUN_TEMP, 'a07-mutations')
  fs.mkdirSync(mutRoot, { recursive: true })

  /* ① 变异一：让**包装入口**包含独立计算 → A05 的"只剩委托"判据必须红 */
  const cleanPack = await buildPackFixture('a07-clean-pack', { terms: 2, title: '数学' })
  const cleanVerdict = judgeOneComputation(readText(path.join(cleanPack, 'assets', 'build-glossary.js')))
  eq(cleanVerdict.ok, true, `A07 · 未变异的副本必须通过（对照；${cleanVerdict.problems.join('；')}）`)

  const mutPack = path.join(mutRoot, 'pack')
  fs.cpSync(cleanPack, mutPack, { recursive: true })
  const cleanWrapper = readText(path.join(mutPack, 'assets', 'build-glossary.js'))
  // 注入一份**独立计算**：自己拼一份 markdown（标题硬编码），不再走内核合成
  const needle = 'core.atomicWrite({\n  target: OUT,\n  content: core.buildGlossaryMarkdown(loaded.ledger, {\n    title: core.readGlossaryTitle({ configPath: CONFIG, fs: fs }),\n  }),\n  fs: fs,\n});'
  eq(cleanWrapper.split(needle).length, 2, 'A07 · 变异锚点必须唯一（包装器结构变了就更新锚点）')
  const mutant = cleanWrapper.replace(needle, [
    '// 变异：在包装入口里塞一份独立计算（不再委托内核）',
    'function slug(label) {',
    '  return String(label).toLowerCase().replace(/[^\\w\\u4e00-\\u9fa5\\s-]/g, "").trim().replace(/\\s+/g, "-");',
    '}',
    'const md = [',
    "  '# 课程 名词速查笔记（GLOSSARY）',",
    "  '',",
    '  `**共 ${Object.keys(loaded.ledger).length} 个名词。**`,',
    "  '',",
    '].join("\\n");',
    'core.atomicWrite({ target: OUT, content: md, fs: fs });',
  ].join('\n'))
  assert(mutant !== cleanWrapper, 'A07 · 变异必须真的改动源码')
  fs.writeFileSync(path.join(mutPack, 'assets', 'build-glossary.js'), mutant, 'utf8')

  const mutVerdict = judgeOneComputation(mutant)
  eq(mutVerdict.ok, false, 'A07 · 包装入口包含独立计算后，A05 的"只剩委托"判据仍然通过 —— 判据是空转的')
  assert(mutVerdict.problems.some((p) => p.includes('函数声明')),
    `A07 · 变异体检出项必须点名"函数声明"（实得 ${mutVerdict.problems.join('；')}）`)
  assert(mutVerdict.problems.some((p) => p.includes('计算痕迹')),
    `A07 · 变异体检出项必须点名"残留计算痕迹"（实得 ${mutVerdict.problems.join('；')}）`)
  // 变异必须同时**改变产物**（不只是源码层被抓）
  const mutRun = runPackCli(mutPack)
  eq(mutRun.status, 0, 'A07 · 变异副本仍然能跑完（它只是算错了）')
  const mutOut = readText(path.join(mutPack, 'GLOSSARY.md'))
  const hostOut = m.io.expectedGlossaryMarkdown(mutPack)
  assert(mutOut !== hostOut, 'A07 · 独立计算必须让产物与宿主不同（否则这条变异没有效果）')

  /* ② 变异二：让加载**返回旧缓存** → A04 的"同进程最新"判据必须红 */
  const cleanKernelDir = path.join(mutRoot, 'kernel-clean')
  const mutKernelDir = path.join(mutRoot, 'kernel-mut')
  for (const d of [cleanKernelDir, mutKernelDir]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of AUTHORITY) fs.copyFileSync(path.join(REPO, 'lib', 'unify', f), path.join(d, f))
  }
  const cleanSrc = readText(path.join(cleanKernelDir, 'glossary.cjs'))
  const cacheNeedle = 'if (cache) clearModuleCache(cache, requireFrom, abs)'
  eq(cleanSrc.split(cacheNeedle).length, 2, 'A07 · 缓存清理锚点必须唯一')
  const mutSrc = cleanSrc.replace(cacheNeedle, '/* 变异：不清缓存（返回旧缓存） */')
  assert(mutSrc !== cleanSrc, 'A07 · 缓存变异必须真的改动源码')
  fs.writeFileSync(path.join(mutKernelDir, 'glossary.cjs'), mutSrc, 'utf8')

  const fixClean = path.join(mutRoot, 'fixture-clean')
  const fixMut = path.join(mutRoot, 'fixture-mut')
  for (const d of [fixClean, fixMut]) fs.mkdirSync(path.join(d, 'assets'), { recursive: true })

  const cleanJudge = judgeFreshness(path.join(cleanKernelDir, 'glossary.cjs'), fixClean)
  eq(cleanJudge.fresh, true, `A07 · 未变异的内核副本必须读到最新数据（对照；${JSON.stringify(cleanJudge)}）`)
  eq(cleanJudge.stale, false, 'A07 · 未变异的内核副本不许读到旧缓存')

  const mutJudge = judgeFreshness(path.join(mutKernelDir, 'glossary.cjs'), fixMut)
  eq(mutJudge.fresh, false, 'A07 · 不清缓存之后，"同进程再读"仍然是最新 —— A04 的判据是空转的')
  eq(mutJudge.stale, true, `A07 · 变异副本必须读到旧缓存（实得 ${JSON.stringify(mutJudge)}）`)
  sameJson(mutJudge.second, mutJudge.first, 'A07 · 变异副本的第二次读必须与第一次相同（旧缓存）')

  /* ③ 仓内文件一个字节都没被变异影响 */
  eq(sha256(fs.readFileSync(path.join(REPO, KERNEL))), repoKernelBefore, 'A07 · 仓内权威内核不许被变异影响')
  eq(sha256(fs.readFileSync(path.join(REPO, PACK_WRAPPER))), wrapperBefore, 'A07 · 仓内包侧包装器不许被变异影响')
  assert(path.resolve(mutRoot).startsWith(path.resolve(TEMP_PARENT) + path.sep), 'A07 · 变异副本必须落在 E:\\Temp')

  DETAIL.comparisons.A07 = {
    mutations: [
      {
        id: 'wrapper-independent-computation',
        marker: 'mutations/pack/assets/build-glossary.js',
        clean: { ok: cleanVerdict.ok, problems: cleanVerdict.problems },
        mutated: { ok: mutVerdict.ok, problems: mutVerdict.problems },
        outputDiffers: mutOut !== hostOut,
      },
      {
        id: 'stale-require-cache',
        marker: 'mutations/kernel-mut/glossary.cjs',
        clean: cleanJudge,
        mutated: mutJudge,
      },
    ],
    repoUntouched: true,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 证据及范围守卫有效
 * ══════════════════════════════════════════════════════════════════════ */

async function A08() {
  const preDoc = pre()

  // ① 改前材料齐 + 自洽
  for (const p of [PRE_FILE, FIXTURES_FILE, CAPTURE_FILE]) {
    assert(fs.existsSync(p), `A08 · 改前材料缺失：${rel(p)}`)
  }
  eq(preDoc.sources.length, CHANGED_FILES.length, 'A08 · 改前材料应当锁住 4 个现有文件')
  sameJson(preDoc.sources.map((s) => s.path), CHANGED_FILES, 'A08 · 改前材料的文件清单与卡面写集不一致')
  eq(preDoc.gitHead, gitRead(['rev-parse', 'HEAD']).trim(), 'A08 · 改前采集时的 HEAD 必须仍是现在的 HEAD（本卡不做任何 git 写）')

  // ② 依赖锚点：改前材料里的四个文件**必须就是 git HEAD 那份**（不是"某次跑过之后"的样子）
  const anchorRows = []
  for (const s of preDoc.sources) {
    const headBuf = spawnSync('git', ['show', `HEAD:${s.path}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    eq(headBuf.status, 0, `A08 · git show HEAD:${s.path} 必须成功`)
    eq(sha256(headBuf.stdout), s.sha256, `A08 · 改前材料的 ${s.path} 必须与 git HEAD 逐字节相同`)
    eq(s.sameAsHead, true, `A08 · 采集时 ${s.path} 必须与 HEAD 相同（改前基线成立的前提）`)
    anchorRows.push({ path: s.path, bytes: s.bytes, sha16: s.sha256.slice(0, 16) })
  }
  // 内核的同目录依赖在采集之后必须没有漂（漂了，A01 的等价证明就不再对同一个内核成立）
  const depRows = []
  for (const dep of KERNEL_DEPS) {
    const rec = preDoc.dependencies.find((d) => d.path === dep)
    assert(rec, `A08 · 改前材料里缺依赖锚点 ${dep}`)
    eq(sha256(fs.readFileSync(path.join(REPO, dep))), rec.sha256, `A08 · 依赖锚点漂了：${dep}（A01 的等价证明将不再对同一个内核成立）`)
    depRows.push({ path: dep, bytes: rec.bytes, sha16: rec.sha256.slice(0, 16) })
  }
  // interface 锁里 §1 的两条 source lock 必须等于改前实测（双重核对：锁 ↔ 采集 ↔ git）
  const lockText = readText(path.join(REPO, 'docs/unify/interfaces.md'))
  for (const relPath of [HOST.glossary, HOST.io]) {
    const row = lockText.split('\n').find((l) => l.includes('`' + relPath + '`') && /[0-9a-f]{64}/.test(l))
    assert(row, `A08 · interfaces.md §1 里找不到 ${relPath} 的锁`)
    const cells = row.split('|').map((c) => c.trim().replace(/`/g, ''))
    const bytes = Number(cells[2])
    const hash = cells.find((c) => /^[0-9a-f]{64}$/.test(c))
    const s = preDoc.sources.find((x) => x.path === relPath)
    eq(s.bytes, bytes, `A08 · ${relPath} 的改前字节数与 interface 锁不一致`)
    eq(s.sha256, hash, `A08 · ${relPath} 的改前 sha256 与 interface 锁不一致`)
  }

  // ③-0 导出面逐键保留（"导出面漂一个就红"）+ ESM 适配层与内核的**同一性**
  const m = await mods()
  const core = kernel()
  const kernelSrc = readText(path.join(REPO, KERNEL))
  sameJson(Object.keys(m.glossary).sort(), preDoc.exportFace.glossary, 'A08 · lib/glossary.js 的导出键集合与改前不一致')
  sameJson(Object.keys(m.io).sort(), preDoc.exportFace.io, 'A08 · lib/glossary-io.js 的导出键集合与改前不一致')
  sameJson(Object.keys(m.edit).sort(), preDoc.exportFace.edit, 'A08 · lib/glossary-edit-io.js 的导出键集合与改前不一致')
  for (const k of preDoc.exportFace.glossary) eq(typeof m.glossary[k], 'function', `A08 · lib/glossary.js 的 ${k} 必须还是函数`)
  for (const k of preDoc.exportFace.io) eq(typeof m.io[k], 'function', `A08 · lib/glossary-io.js 的 ${k} 必须还是函数`)
  eq(typeof m.edit.LEDGER_REL, 'string', 'A08 · LEDGER_REL 必须还是字符串常量')
  for (const k of ['verifyLoadedTerm', 'writeTermSurgically']) eq(typeof m.edit[k], 'function', `A08 · lib/glossary-edit-io.js 的 ${k} 必须还是函数`)
  for (const k of ['slug', 'categorize', 'parseTermKeys', 'termRecordSource', 'upsertTermSource', 'buildGlossaryMarkdown']) {
    eq(m.glossary[k], core[k], `A08 · 桥：lib/glossary.js 的 ${k} 必须就是内核导出（函数同一性，不是同名同值）`)
  }
  for (const k of ['firstDiff', 'glossarySummary']) eq(m.io[k], core[k], `A08 · 桥：lib/glossary-io.js 的 ${k} 必须就是内核导出`)
  eq(m.edit.LEDGER_REL, path.join(...core.GLOSSARY_LEDGER_REL.split('/')), 'A08 · LEDGER_REL 必须由内核常量派生（不另写一遍路径）')

  // ③-0b "唯一实现"的源码层证据：这些计算痕迹**只许**躺在内核里
  const HOST_COMPUTE_TOKENS = [
    "'## 按分类跳转'",
    '名词速查笔记',
    "replace(/\\r?\\n/g, '\\\\n')",
    'matchBraceEnd',
    'assertEmptyObjectBody',
    'byCategory.get(cat).push',
  ]
  const kernelCodeNoComments = stripComments(kernelSrc)
  for (const t of HOST_COMPUTE_TOKENS) {
    assert(kernelCodeNoComments.includes(t), `A08 · 内核里找不到计算痕迹 ${JSON.stringify(t)} —— 反空转检查失败（下面那条就成了恒真）`)
  }
  for (const f of Object.values(HOST)) {
    const code = stripComments(readText(path.join(REPO, f)))
    for (const t of HOST_COMPUTE_TOKENS) {
      assert(!code.includes(t), `A08 · ${f} 里还留着计算痕迹 ${JSON.stringify(t)}（第二份实现）`)
    }
  }

  // ③ 四个现有文件**真的被改过**，且都是"委托形态"；三个新文件真的建了
  const facts = []
  for (const f of preDoc.sources) {
    const now = sha256(fs.readFileSync(path.join(REPO, f.path)))
    assert(now !== f.sha256, `A08 · ${f.path} 与改前字节相同 —— 本卡其实没改它（对拍无意义）`)
    const src = readText(path.join(REPO, f.path))
    const delegates = f.path === PACK_WRAPPER
      ? src.includes("require('../tools/unify/glossary.cjs')")
      : src.includes('./unify/glossary.cjs')
    assert(delegates, `A08 · ${f.path} 里看不到对权威内核的委托`)
    facts.push({ path: f.path, state: 'changed', beforeSha16: f.sha256.slice(0, 16), nowSha16: now.slice(0, 16) })
  }
  eq(facts.length, 4, 'A08 · 应当恰好改 4 个既有文件')
  for (const p of [KERNEL, 'test/audit/U11.mjs', 'docs/unify/receipts/U11.json']) {
    assert(fs.existsSync(path.join(REPO, p)), `A08 · 新文件不见了：${p}`)
    facts.push({ path: p, state: 'created', nowSha16: sha256(fs.readFileSync(path.join(REPO, p))).slice(0, 16) })
  }
  // 内核必须是 CJS（无 ESM 语法），且不自己 require node:fs（IO 全注入）
  assert(/^\/\*\*/.test(kernelSrc.trim()) || kernelSrc.includes("'use strict'"), 'A08 · 内核必须是 CJS 形态')
  assert(!/^export\s/m.test(kernelSrc), 'A08 · 内核不许出现 ESM export')
  assert(!/^import\s/m.test(kernelSrc), 'A08 · 内核不许出现 ESM import')
  assert(!/require\(['"]node:fs['"]\)|require\(['"]fs['"]\)/.test(kernelSrc), 'A08 · 内核不许自己 require fs（IO 一律显式注入）')
  assert(!/process\.env|Math\.random|new Date\(|Date\.now\(|setTimeout|setInterval/.test(kernelSrc),
    'A08 · 内核不许读环境变量 / 用随机数 / 看时钟 / 起定时器')

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
  eq(guard.violations.length, 0,
    `A08 · 本进程出现了允许面之外的写入：${guard.violations.slice(0, 5).map((v) => `${v.op} ${v.target}`).join(', ')}`)
  assert(guard.writeCount >= 20, `A08 · 写记录条数太少（${guard.writeCount}）—— 守卫看起来没在真记录`)
  for (const op of ['mkdir', 'write', 'copy']) assert(guard.ops.includes(op), `A08 · 写记录里没有 ${op} 这一类的写`)
  const wProof = proveWriteScope()
  eq(wProof.failures.length, 0,
    `A08 · 写允许面的纯函数自证失败：${wProof.failures.map((f) => `${f.path} → ${f.got}（期望 ${f.expect}）`).join(', ')}`)

  // ⑤ 【判据 2/4】授权写集并集（tracked 侧）
  const s6 = parseSection6(lockText)
  eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
  const union = authorizedUnion(s6)
  const owners = pathOwners(s6)
  for (const [card, p] of [
    ['U01', 'docs/unify/baseline.json'], ['U04', 'lib/unify/text.cjs'], ['U06', 'lib/pack-template/tools/ledger-transaction.cjs'],
    ['U07', 'lib/render.js'], ['U11', KERNEL], ['U19', 'package.json'],
  ]) {
    assert(s6.get(card)?.includes(p), `A08 · §6 解析结果里 ${card} 缺落点 ${p}`)
  }
  sameJson([...s6.get(CARD)], WRITE_SET, 'A08 · §6 里 U11 的落点必须逐条等于本卡写集（接口锁与入口不一致）')
  const porcelain = gitRead(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter((l) => l.trim())
  const { tracked, untracked } = splitPorcelainTracked(porcelain)
  const scopeCheck = classifyTrackedWrites(tracked, union)
  eq(scopeCheck.outOfBounds.length, 0,
    `A08 · tracked 改动越出 U01–U20 授权写集并集：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
  assert(tracked.length >= 4, `A08 · tracked 改动只有 ${tracked.length} 条 —— 本卡 4 个既有文件都改了，这不可能`)
  for (const f of CHANGED_FILES) {
    assert(tracked.some((t) => t.path === f), `A08 · tracked 改动里找不到本卡改过的 ${f}`)
  }
  const diffPaths = gitRead(['-c', 'core.quotepath=false', 'diff', '--name-status', 'HEAD'])
    .split('\n').filter((l) => l.trim()).map((l) => l.split(/\t/).slice(-1)[0].trim())
  const sameSet = (a, b) => [...a].sort().join('\n') === [...b].sort().join('\n')
  eq(sameSet(diffPaths, tracked.map((t) => t.path)), true,
    'A08 · git diff --name-status HEAD 与 git status 的 tracked 部分不是同一批路径（两套账不一致）')
  const sProof = proveScopeBoundary(s6)
  eq(sProof.failures.length, 0,
    `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

  // ⑥ 【判据 3/4】交付物内容锁
  const lock = recordContentLock()
  eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
  const lockNow = verifyContentLock()
  eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)

  // ⑦ 【判据 4/4】**不统计他卡的文件数/字节数**：只做归属守卫
  //    - 本卡证据根之外的东西一律不数（别人的证据目录按设计会随各自复验增长）；
  //    - audit-evidence 第一层只允许 U 卡编号目录 + 既有 T23（T 线冻结证据）
  //      + **真实存在的 T 卡**的证据目录（`test/audit/T<NN>.mjs` 在盘上 —— 决-1/决-5/决-6/决-9/P2
  //      之后 T 卡由别的卡合法运行）。**不是**"T 一律放行"。
  const evDirs = fs.readdirSync(path.join(REPO, 'audit-evidence')).sort()
  const isRealT = (d) => /^T\d{2}$/.test(d) && fs.existsSync(path.join(REPO, 'test', 'audit', `${d}.mjs`))
  const unexpectedOf = (list) => list.filter((d) => !/^U\d{2}$/.test(d) && d !== 'T23' && !isRealT(d))
  const evUnexpected = unexpectedOf(evDirs)
  eq(evUnexpected.length, 0, `A08 · audit-evidence 第一层出现了无人认领的证据目录：${evUnexpected.join(', ')}`)
  // 反空转：既不在册、也没有对应 T 卡入口的名字必须被这条判据抓住。
  sameJson(unexpectedOf(['U01', 'T23', 'T01', 'TXX-nobody']), ['TXX-nobody'],
    'A08 · 反空转：无人认领的证据目录必须被判出来（真实存在的 T 卡放行，别的仍红）')
  for (const d of ['U01', 'T23']) assert(evDirs.includes(d), `A08 · 既有证据目录不见了：${d}`)
  // 本卡的写全部落在本卡证据根 / 本次临时根：由 ① 的守卫证明（这里只登记归属，不数别人的文件）
  const myEvidenceWrites = guard.writes.filter((w) => w.target.startsWith(path.resolve(EVIDENCE_ROOT_READ) + path.sep))
  DETAIL.comparisons.A08 = {
    anchors: { sources: anchorRows, kernelDeps: depRows },
    writeSetFacts: facts,
    writeGuard: {
      installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount, ops: guard.ops,
      probe: guard.probe, violations: guard.violations, proof: wProof.rows,
    },
    authorizedUnion: {
      cards: s6.size, paths: union.size,
      trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) ?? [] })),
      untrackedCount: untracked.length,
      outOfBounds: scopeCheck.outOfBounds,
      diffCrossCheck: { statusPaths: tracked.length, diffPaths: diffPaths.length, sameSet: true },
      proof: sProof.rows,
    },
    contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
    evidenceTopLevel: evDirs,
    myEvidenceWrites: myEvidenceWrites.length,
  }

  // ⑧ --evidence-root 守卫：默认落本卡新运行目录；越界拒绝；读取根不受它影响
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U11/runs/U11-<pid>')
  const tmpRoot = resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO })
  eq(tmpRoot.ok, true, `A08 · E:\\Temp 下带 ${CARD}- 前缀的新目录必须被接受`)
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
  eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')
  eq(path.dirname(PRE_FILE), EVIDENCE_ROOT_READ, 'A08 · 读取根必须恒为 <repo>/audit-evidence/U11')

  // ⑨ 临时目录：按绝对路径与归属清理
  const g1 = guardTempPath(RUN_TEMP, { parent: TEMP_PARENT })
  eq(g1.ok, true, `A08 · 本次临时根必须归 ${TEMP_PARENT}（${g1.error || ''}）`)
  assert(/^u11-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u11-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')
  const scratch = path.join(RUN_TEMP, 'guard-scratch')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
  const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
  eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
  eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')

  // ⑩ tracked 回执：五项齐，且与真实写集 / Δ / 未验证边界对得上；合法 JSON 可被 require
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
  for (const key of ['completion', 'dependencies', 'interfaceConsumption', 'writeSet', 'deltas', 'verdict', 'unverified', 'evidenceIndex', 'assertions']) {
    assert(key in rc, `A08 · 回执缺字段 ${key}`)
  }
  sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
  assert(/无/.test(JSON.stringify(rc.writeOutOfSet)), 'A08 · 回执必须写清越界项（无也写明）')
  assert(rc.unverified.some((u) => /U19/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记"仓内随包闭包待 U19"')
  assert(rc.unverified.some((u) => /T26|migratedPack/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 build-glossary 委托导致的 T26 夹具新增回归')
  assert(rc.deltas.some((d) => d?.kind === 'behavior-tightening' || d?.kind === 'io-failure-shape'), 'A08 · 回执必须登记 IO 失败口径/读取收紧这类 Δ')
  assert(rc.assertions && Object.keys(rc.assertions).length >= 8, 'A08 · 回执必须逐项写清 A01–A08 的断言内容')

  DETAIL.comparisons.A08 = { ...DETAIL.comparisons.A08, receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length } }
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */

/** 写守卫必须在**第一笔写之前**挂上（本卡的写全在 A01–A08 与收口落盘里） */
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
