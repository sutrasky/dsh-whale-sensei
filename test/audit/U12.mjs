/**
 * test/audit/U12.mjs —— 离线旧库迁移复用**共同三闸**（U12 新建）
 * ==================================================================
 * 被测件只有一个：`lib/pack-template/tools/offline-server.js`（模板工具；随包铺到安装目录）。
 *
 * 卡面判据（原文要点）：
 *   · 离线旧库迁移复用共同三闸（计划 → 显式确认 → **锁内**真实字节摘要），复用 U06 的
 *     `planCommit` / `applyCommit` 与既有事务件；**不新建第二套计划 / 锁 / 日志**。
 *   · **所有原有码值逐字保持**（成功 / 无事可迁 / 失败 / 缺摘要 / 过期摘要 / 阶段失败…），
 *     `digest` / `planDigest` 适配后仍原样对外。
 *   · **身份解码不在 offline-server 里新建**：需要身份迁移时**拒绝**并指向显式 CLI
 *     （`tools/migrate-pack.mjs`，U05），不复制历史解码。
 *   · **只测自建库**：不启动真实旧库迁移、不读写活包。
 *
 * 这个壳怎么做到"真断言"（不是把计划当运行报告）：
 *   ① 夹具是**自建**的：`E:\Temp\U12-cases-*` 下一个安装目录（模板工具 + **逐字节复制**的
 *      `tools/unify/*.cjs`，U-SPEC §5 的最小替代；U19 才负责真随包副本）＋ 一个自建课程库
 *      `packs/library/` ＋ 1–2 个旧课程包 `packs/<老包>/`。**一个字节都不碰活包**。
 *   ② 模块从**夹具里的副本** require（仓里 package.json 是 `type: module`，模板 `.js` 在仓内
 *      会被当成 ESM，`: 60` 就报 `require is not defined`）—— 与 T05/T06/T07/T20 同一套做法。
 *   ③ 计数探针走 `require.cache`：把夹具里的 `tools/unify/commit.cjs` 与
 *      `tools/ledger-transaction.cjs` **换成一圈包装（仍然转发给真实现）**，于是
 *      "未确认时提交调用 = 0" 是**可数的**，不是"看起来没写"。正控在 A08（真跑一次必须 +1）。
 *   ④ 整树 sha256 快照 + 进程内写守卫（拦 write/append/mkdir/cp/rename/rm）＋ 依赖锚点
 *      跑前跑后复比 —— "一个字节都没变"是可复算的。
 *
 * 固定八项（A01–A08，集合不许多、不许少；不许 skip / 恒真 / 吞错）：
 *   A01 计划只读          A02 未确认时没有提交调用      A03 缺摘要 / 过期摘要的原错误码
 *   A04 阶段失败不替换既有库产物                        A05 原有码值逐字保留
 *   A06 需要身份迁移时拒绝并指路（不复制解码）          A07 临时绕过摘要闸后判据必须红
 *   A08 零调用探针 / 证据 / 夹具 / 授权并集安全有效
 *
 * 判词：`node test/audit/U12.mjs` → `PASS U12 checks=8 failed=0 skipped=0` / exit 0；
 *       FAIL → exit 1；缺材料 / 缺授权 → BLOCKED → exit 2。
 * 原始证据落 `audit-evidence/U12/`（忽略不进仓）；`--evidence-root=<绝对路径>` 只改写入根。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  FIXED_IDS, Blocked, runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot,
  guardTempPath, safeRemoveTree,
} from './unify-runner.mjs'

const CARD = 'U12'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const TEMPLATE_TOOLS = path.join(REPO, 'lib', 'pack-template', 'tools')
const TEMPLATE_UNIFY = path.join(REPO, 'lib', 'unify')
const OFFLINE_SERVER = path.join(TEMPLATE_TOOLS, 'offline-server.js')
const MIGRATE_CLI = path.join(REPO, 'tools', 'migrate-pack.mjs')
const INTERFACES = path.join(REPO, 'docs', 'unify', 'interfaces.md')
const AUTHORIZATION = path.join(REPO, 'docs', 'unify', 'authorization.json')
const RECEIPT = path.join(REPO, 'docs', 'unify', 'receipts', 'U12.json')
const BASE_SHA = '2f57b1f2cec02e4128b69497e3b6819d36aa707b'
const LIVE_PACK = 'E:\\workplace\\study'
const TMP_BASE = 'E:\\Temp'
const requireCJS = createRequire(import.meta.url)

/* ═══════════════════════════════════════════════════════ 进程内写守卫 */
/**
 * 拦**本进程**的写 API，记绝对路径。目的不是"防"（防不住子进程），而是**可归因**：
 * 证明本次运行没有往 {本卡写集 ∪ 证据根 ∪ E:\Temp 本卡唯一目录} 之外写过东西。
 */
const WRITE_APIS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'copyFileSync', 'cpSync', 'renameSync',
  'rmSync', 'rmdirSync', 'unlinkSync', 'symlinkSync', 'chmodSync', 'utimesSync', 'writeSync',
  'mkdtempSync', 'openSync', 'truncateSync', 'createWriteStream',
]
const REAL_FS = {}
const WRITES = []
let guardInstalled = false

function recordWrite(api, args) {
  const push = (p) => {
    if (typeof p !== 'string' || !p) return
    WRITES.push({ api, path: path.resolve(p) })
  }
  if (api === 'renameSync') { push(args[0]); push(args[1]); return }
  if (api === 'copyFileSync' || api === 'cpSync') { push(args[1]); return }  // 源是"读"，只记目的地
  if (api === 'openSync') {
    const flags = String(args[1] === undefined ? 'r' : args[1])
    if (!/[wa+]/.test(flags)) return
    push(args[0]); return
  }
  push(args[0])
}

function installWriteGuard() {
  if (guardInstalled) return
  guardInstalled = true
  for (const api of WRITE_APIS) {
    const orig = fs[api]
    if (typeof orig !== 'function') continue
    REAL_FS[api] = orig
    fs[api] = function patched(...args) {
      try { recordWrite(api, args) } catch { /* 记录失败不许影响被测行为 */ }
      return orig.apply(fs, args)
    }
  }
}
installWriteGuard()

/* ═══════════════════════════════════════════════════════════════ 小工具 */
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => sha256(fs.readFileSync(p))
const readText = (p) => fs.readFileSync(p, 'utf8')
const writeText = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') }
const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const jsonText = (v) => `${JSON.stringify(v, null, 2)}\n`

/** 整棵树快照（**内容口径**：`rel` → `dir` / sha256）—— "一个字节都没变"靠它 */
function walkTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { out.push({ rel: r, dir: true }); walk(abs, r) } else out.push({ rel: r, dir: false, abs })
    }
  }
  walk(root, '')
  return out
}
function snapTree(root) {
  const m = new Map()
  for (const e of walkTree(root)) m.set(e.rel, e.dir ? 'dir' : sha256(fs.readFileSync(e.abs)))
  return m
}
function snapJson(root) {
  return JSON.stringify([...snapTree(root)].map(([k, v]) => `${k}\t${v}`))
}
function diffSnap(a, b) {
  const out = []
  for (const [k, v] of a) { if (!b.has(k)) out.push(`缺 ${k}`); else if (b.get(k) !== v) out.push(`变 ${k}`) }
  for (const k of b.keys()) if (!a.has(k)) out.push(`多 ${k}`)
  return out
}

/** 事务协议自己的落点（`.whale-txn/` 是事务件的协议目录，U06 行为：成功提交后留一个**空**目录） */
function protocolResidue(root) {
  const lock = path.join(root, '.whale-write.lock')
  const txnDir = path.join(root, '.whale-txn')
  const journals = []
  if (exists(txnDir)) {
    for (const name of fs.readdirSync(txnDir)) journals.push(name)
  }
  return { lock: exists(lock), txnDir: exists(txnDir), journals }
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

/* ── 运行目录 / 证据根 ─────────────────────────────────────────────────── */
const ARGV = process.argv.slice(2)
const EV = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
if (!EV.ok) {
  process.stderr.write(`BLOCKED ${CARD} ${EV.error}\n`)
  process.exit(2)
}
const EVIDENCE_ROOT = EV.root
if (!exists(TMP_BASE)) {
  process.stderr.write(`BLOCKED ${CARD} 本机没有 ${TMP_BASE}（卡面规定夹具一律落这里）\n`)
  process.exit(2)
}
/** 本次唯一夹具目录 */
const SESSION = fs.mkdtempSync(path.join(TMP_BASE, `${CARD}-cases-`))

function allowedWriteRoots() {
  return [EVIDENCE_ROOT, SESSION, path.join(REPO, 'audit-evidence', CARD)].map((p) => path.resolve(p))
}
function isAllowedWrite(abs) {
  const roots = allowedWriteRoots()
  if (roots.some((r) => abs === r || abs.startsWith(r + path.sep))) return true
  // `mkdtempSync('<TMP>/U12-…-')` 记到的是**前缀**（真名由内核拼）—— 只放行 TMP 下带本卡前缀的形状
  const base = path.basename(abs)
  return path.dirname(abs) === path.resolve(TMP_BASE) && /^U12-[A-Za-z0-9._-]*$/.test(base)
}

function evJson(rel, value) {
  const abs = path.join(EVIDENCE_ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return abs
}
function evText(rel, text) {
  const abs = path.join(EVIDENCE_ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${text}\n`, 'utf8')
  return abs
}

/* ── git 只读对拍（不写 index） ───────────────────────────────────────── */
function git(argv) {
  const r = spawnSync('git', ['-C', REPO, ...argv], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Blocked(`git ${argv.join(' ')} 取不到（exit ${r.status}）：${String(r.stderr || '').slice(0, 300)}`)
  return String(r.stdout || '')
}
function gitTrackedChanges() {
  const rows = []
  for (const line of git(['status', '--porcelain=v1']).split(/\r?\n/)) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const rel = line.slice(3).trim().replace(/^"(.*)"$/, '$1')
    if (code === '??') continue
    rows.push({ code, rel })
  }
  return rows
}
/** 相对**固定基线提交**的改动（工作树 vs commit；不含未跟踪） */
function gitDiffNames(ref, pathspec) {
  const out = []
  for (const line of git(['diff', '--name-only', ref, '--', pathspec]).split(/\r?\n/)) {
    const rel = line.trim().replace(/^"(.*)"$/, '$1')
    if (rel) out.push(rel)
  }
  out.sort()
  return out
}

/* ── 决-B1：`test/pack-template-rules.mjs` 的「只加登记项」形状判据（纯函数） ─────── */

/** 运行内核模块名（`lib/unify/*.cjs` 去掉 `migration.cjs`）—— 登记项应当逐项对应它 */
function coreModuleNames() {
  return fs.readdirSync(path.join(REPO, 'lib', 'unify'))
    .filter((n) => n.endsWith('.cjs') && n !== 'migration.cjs')
    .map((n) => n.replace(/\.cjs$/, ''))
    .sort()
}

/**
 * 判 `test/pack-template-rules.mjs` 相对基线是不是**只加登记项**（喂 diff 文本，不读盘）。
 *
 * 四条同时成立才算：① 零删除行；② 新增的代码行（非空、非 `//`）恰好是每份运行内核一行
 * `'tools/unify/<模块>.cjs',`；③ 模块集合与 `lib/unify/*.cjs`（去 migration）逐项相等；
 * ④ 至少一条新增注释（出处留痕）。任何一条不满足 ⇒ ok:false。
 *
 * 为什么要有它：用户禁令（scope.A.notAuthorized「仍只读，任何卡不得改其断言」）与
 * decisions 决-9（「只加登记项，不改判据强度」）是**两条不同的授权强度**。路径级放行面
 * 表达不了差别，所以 deny 原则保留，只把"这一种可机判的形状"放出来；形状对不上仍然红。
 */
export function registrationsOnlyFromDiff(diffText, coreModules) {
  const lines = String(diffText || '').split(/\r?\n/)
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const codeAdded = added.filter((l) => l.trim() && !l.trim().startsWith('//'))
  const wantRows = [...coreModules].sort().map((m) => `  'tools/unify/${m}.cjs',`)
  const problems = []
  if (removed.length) problems.push(`删除了 ${removed.length} 行既有内容`)
  const missing = wantRows.filter((w) => !codeAdded.includes(w))
  const extra = codeAdded.filter((l) => !wantRows.includes(l))
  if (missing.length) problems.push(`缺 ${missing.length} 行登记项`)
  if (extra.length) problems.push(`多出 ${extra.length} 行非登记代码`)
  if (added.length <= codeAdded.length) problems.push('新增行里没有出处注释')
  return { ok: problems.length === 0, problems, added: added.length, codeAdded: codeAdded.length, removed: removed.length }
}

/* ── 依赖锚点（A08：跑前跑后必须逐字不变） ─────────────────────────────── */
const DEPENDENCIES = [
  'lib/pack-template/tools/offline-server.js',
  'lib/pack-template/tools/ledger-transaction.cjs',
  'lib/unify/commit.cjs',
  'lib/unify/identity.cjs',
  'lib/unify/errors.cjs',
  'tools/migrate-pack.mjs',
  'test/audit/unify-runner.mjs',
  'docs/unify/interfaces.md',
  'docs/unify/authorization.json',
]
function dependencyAnchors() {
  const out = {}
  for (const rel of DEPENDENCIES) out[rel] = sha256File(path.join(REPO, rel))
  return out
}
const ANCHORS_BEFORE = dependencyAnchors()
/** 夹具里"逐字节复制权威模块"的记录（U-SPEC §5 的最小替代；不宣称随包完整） */
const COPIED_AUTHORITY = {}
/** A07 在 E:\Temp 副本里做过的变异（A08 用它把"只该有这两处不同"钉住） */
const MUTANTS = []
/** 本次运行见过的 `MIGRATION_*` 码值（A05 用来证"六个原有码值一个不少"） */
const CODES_SEEN = new Map()

/* ═══════════════════════════════════════════════════════════ 夹具 */
/** 安装目录里 offline-server 需要的同级件（都是模板里既有的） */
const INSTALL_FILES = [
  'offline-server.js', 'offline-bootstrap.js', 'path-policy.cjs', 'public-files.cjs',
  'http-security.cjs', 'http-request.cjs', 'ledger-transaction.cjs',
]
/** U06/U02/U03 的权威模块：**逐字节**复制进夹具的 `tools/unify/`（U19 才负责真副本） */
const UNIFY_COPIES = ['commit.cjs', 'identity.cjs', 'errors.cjs']

const DEST_LESSON = { rel: 'prog/base/0001-a.html', halo: 'prog', point: 'base', number: 1, title: 'A' }

/**
 * 造一个自建案例树：
 *   <root>/install/tools/**      安装目录（模板工具 + 逐字节复制的 unify 副本）
 *   <root>/packs/library/**      唯一课程库（自建；`lessons/lessons.json` 里已有一节课）
 *   <root>/packs/<老包>/lessons/** 旧课程包（默认 `olda`；可选 `oldb`）
 *
 * @param {string} name 案例名（SESSION 下的目录）
 * @param {{legacy?:string[], copies?:boolean, destIndex?:object[], mutate?:Function,
 *          legacyIndex?:(id:string)=>(object[]|null), flatLayout?:boolean}} [opts]
 */
function makeCaseTree(name, opts = {}) {
  const root = path.join(SESSION, name)
  const install = path.join(root, 'install')
  const tools = path.join(install, 'tools')
  fs.mkdirSync(tools, { recursive: true })
  for (const f of INSTALL_FILES) fs.copyFileSync(path.join(TEMPLATE_TOOLS, f), path.join(tools, f))
  if (opts.copies !== false) {
    fs.mkdirSync(path.join(tools, 'unify'), { recursive: true })
    for (const m of UNIFY_COPIES) {
      const dst = path.join(tools, 'unify', m)
      fs.copyFileSync(path.join(TEMPLATE_UNIFY, m), dst)
      COPIED_AUTHORITY[`${name}/tools/unify/${m}`] = sha256File(dst)
    }
  }
  const LIB = path.join(root, 'packs')
  const library = path.join(LIB, 'library')
  fs.mkdirSync(path.join(library, 'lessons'), { recursive: true })
  writeText(path.join(library, 'pack.json'), jsonText({ id: 'library', name: '唯一课程库（自建夹具）' }))
  const destIndex = opts.destIndex === undefined ? [DEST_LESSON] : opts.destIndex
  writeText(path.join(library, 'lessons', 'lessons.json'), jsonText({ v: 1, source: 'lessons/src', lessons: destIndex }))
  const legacyDirs = {}
  for (const id of (opts.legacy === undefined ? ['olda'] : opts.legacy)) {
    const dir = path.join(LIB, id)
    const entries = opts.legacyIndex ? opts.legacyIndex(id) : [
      { rel: `${id}/alpha/0001-x.html`, halo: id, point: 'alpha', number: 1, title: `${id} X` },
    ]
    // 课程页落点：规范 = `lessons/<圆圈>/<知识点>/<文件>.html`；`flatLayout` 造**旧平铺**
    const rels = (entries || []).map((e) => e.rel)
    if (!rels.length) rels.push(`${id}/alpha/0001-x.html`)
    for (const rel of rels) {
      const segs = String(rel).split('/')
      const onDisk = opts.flatLayout && segs.length === 3 ? [segs[0], segs[2]] : segs
      writeText(path.join(dir, 'lessons', ...onDisk), `<html data-fixture="${id}">${rel}</html>\n`)
    }
    if (entries !== null) {
      writeText(path.join(dir, 'lessons', 'lessons.json'), jsonText({ v: 1, source: 'lessons/src', lessons: entries || [] }))
    }
    legacyDirs[id] = dir
  }
  const out = { name, root, install, tools, LIB, library, legacyDirs }
  if (typeof opts.mutate === 'function') out.mutation = opts.mutate(out)
  return out
}

/**
 * 从**夹具副本**加载被测件（每个案例一棵树 → 各自一份模块实例，`LIB` 在模块求值时定住）。
 * @param {object} c `makeCaseTree()` 的返回值
 * @param {{probes?:boolean, plantOnApply?:boolean}} [opts]
 */
function loadOffline(c, opts = {}) {
  process.env.WHALE_LIB = c.LIB
  // 依赖件（`http-security.cjs`）在模块求值时会**持久化一份运行期秘密**到
  // `<LOCALAPPDATA>/鲸师课件/runtime`；夹具里用 WHALE_RUNTIME_DIR 把它指到本次唯一目录，
  // 免得判据去写用户的真实目录（那也会让"写守卫"说不清是谁写的）。
  process.env.WHALE_RUNTIME_DIR = path.join(c.root, 'runtime')
  const commitPath = path.join(c.tools, 'unify', 'commit.cjs')
  const txnPath = path.join(c.tools, 'ledger-transaction.cjs')
  const counts = { planCommit: 0, applyCommit: 0, withPackTransaction: 0 }
  if (opts.probes) {
    // 先真加载一遍，再**换掉导出**：包装仍然转发给真实现，只多记一次数
    const realCommit = requireCJS(commitPath)
    const realTxn = requireCJS(txnPath)
    const wrappedCommit = {
      ...realCommit,
      planCommit: (...a) => { counts.planCommit += 1; return realCommit.planCommit(...a) },
      applyCommit: (rootAbs, plan, o) => {
        counts.applyCommit += 1
        if (opts.plantOnApply) {
          // 模拟"计划生成之后，另一个写者动了目标"：**真**的 applyCommit 还没进去
          const target = path.join(rootAbs, opts.plantOnApply.rel || path.join('lessons', 'lessons.json'))
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, opts.plantOnApply.text)
        }
        return realCommit.applyCommit(rootAbs, plan, o)
      },
    }
    requireCJS.cache[commitPath].exports = wrappedCommit
    requireCJS.cache[txnPath].exports = {
      ...realTxn,
      withPackTransaction: (...a) => { counts.withPackTransaction += 1; return realTxn.withPackTransaction(...a) },
    }
  }
  const OS = requireCJS(path.join(c.tools, 'offline-server.js'))
  return { OS, counts }
}

/** 把一次迁移回执里的码值记进全局登记（A05 用） */
function noteCode(res, where) {
  if (!res || typeof res.code !== 'string') return res
  if (!CODES_SEEN.has(res.code)) CODES_SEEN.set(res.code, [])
  CODES_SEEN.get(res.code).push(where)
  return res
}

/** 静音被测件的 `console.log`（**只屏蔽，不改产品行为**；行原文进证据） */
const REAL_CONSOLE_LOG = console.log
function silent(fn) {
  const lines = []
  console.log = (...a) => { lines.push(a.map(String).join(' ')) }
  try {
    const value = fn()
    return { value, lines }
  } finally {
    console.log = REAL_CONSOLE_LOG
  }
}

/* ── 用例包装（与 U08 同形：每条断言都进证据） ─────────────────────────── */
function makeCase(id, body) {
  return {
    id,
    async run() {
      const started = Date.now()
      const detail = { id, asserts: [], rows: [], data: {}, ok: false, error: null }
      const ctx = {
        detail,
        data: detail.data,
        rows: (...xs) => detail.rows.push(xs.join(' ')),
        check(cond, msg) {
          const ok = !!cond
          detail.asserts.push({ ok, msg })
          if (!ok) throw new Error(msg)
        },
        eq(actual, expected, msg) {
          const ok = JSON.stringify(actual) === JSON.stringify(expected)
          detail.asserts.push({ ok, msg, actual, expected })
          if (!ok) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`)
        },
      }
      try {
        await body(ctx)
        detail.ok = true
      } catch (e) {
        detail.error = String((e && e.message) || e)
        detail.stack = String((e && e.stack) || '').split('\n').slice(0, 8).join('\n')
        throw e
      } finally {
        detail.ms = Date.now() - started
        evJson(path.join('cases', `${id}.json`), detail)
      }
    },
  }
}

/** 前置材料（缺 → BLOCKED，不是 FAIL） */
function requireMaterial() {
  for (const p of [OFFLINE_SERVER, MIGRATE_CLI, INTERFACES, AUTHORIZATION, RECEIPT,
    path.join(TEMPLATE_TOOLS, 'ledger-transaction.cjs'),
    path.join(TEMPLATE_UNIFY, 'commit.cjs'), path.join(TEMPLATE_UNIFY, 'identity.cjs'), path.join(TEMPLATE_UNIFY, 'errors.cjs')]) {
    if (!exists(p)) throw new Blocked(`缺材料：${p}`)
  }
}

/* 独立复算一份"合并后的清单"（不 import 被测件；用固定夹具自己算，作为对拍基准） */
function expectedIndexText(destEntries, srcEntryLists) {
  const byRel = new Map(destEntries.map((e) => [e.rel, e]))
  for (const list of srcEntryLists) for (const e of list) byRel.set(e.rel, e)
  const lessons = [...byRel.values()].sort((a, b) => String(a.rel).localeCompare(String(b.rel)))
  return `${JSON.stringify({ v: 1, source: 'lessons/src', lessons }, null, 2)}\n`
}

/* ═══════════════════════════════════════════════════════════════════ A01 */
const A01 = makeCase('A01', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const c = makeCaseTree('a01-plan')
  const { OS } = loadOffline(c)

  const before = snapTree(c.LIB)
  const writesBefore = WRITES.length
  const first = OS.planLegacyMigration()
  const second = OS.planLegacyMigration()
  const writesDelta = WRITES.length - writesBefore
  const after = snapTree(c.LIB)
  const diff = diffSnap(before, after)

  detail.plan = {
    count: first.count, digest: first.digest, ids: first.plan.map((p) => p.id),
    libraryExists: first.libraryExists, lib: first.lib, note: first.note,
    writesDelta, treeDiff: diff,
  }
  eq(diff, [], `计划必须只读：跑前跑后夹具整树 sha256 一字不变（差异：${diff.slice(0, 5).join('、')}）`)
  eq(writesDelta, 0, '计划期间进程内**零写调用**（不建备份 / 锁 / 日志）')
  eq(first.count, 1, '计划认出 1 个旧课程包')
  eq(first.plan.map((p) => p.id), ['olda'], '计划里的旧包 id 如实（排序后）')
  eq(first.digest, second.digest, '同一现状两次计划摘要相同（纯计算，无时间戳）')
  check(/^[0-9a-f]{32}$/.test(first.digest), `计划摘要形状保持 32 位十六进制（实得 ${first.digest}）`)
  eq(path.resolve(first.lib), path.resolve(c.LIB), '计划的库根就是夹具里那个自建库（不是活包）')
  eq(first.libraryExists, true, '夹具里唯一课程库已存在（库存在时才谈"合并"）')
  check(String(first.note).includes('旧课程包'), `计划说明还是既有的那句（实得 ${JSON.stringify(first.note)}）`)
  for (const leftover of ['.whale-write.lock', '.whale-txn', '.trash', '.migrated.json']) {
    eq(exists(path.join(c.LIB, leftover)), false, `看计划不许建 ${leftover}`)
  }
  // 反向对照：库清空后计划为空，摘要仍是同一形状（判据不是空转）
  const empty = makeCaseTree('a01-empty', { legacy: [] })
  const { OS: OS2 } = loadOffline(empty)
  const p2 = OS2.planLegacyMigration()
  detail.emptyPlan = { count: p2.count, digest: p2.digest }
  eq(p2.count, 0, '没有旧课程包时计划为空（不是恒有 1 个）')
  check(/^[0-9a-f]{32}$/.test(p2.digest), '空计划的摘要同样是 32 位十六进制')
  check(p2.digest !== first.digest, '空计划与有内容的计划摘要不同（摘要真的覆盖内容）')
  rows(`计划 count=${first.count} digest=${first.digest} 写调用 ${writesDelta} 次`)
})

/* ═══════════════════════════════════════════════════════════════════ A02 */
const A02 = makeCase('A02', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const c = makeCaseTree('a02-noconfirm')
  const { OS, counts } = loadOffline(c, { probes: true })
  const before = snapTree(c.LIB)
  const writesBefore = WRITES.length
  const { value: res, lines } = silent(() => OS.applyLegacyMigration({ confirm: false }))
  noteCode(res, 'A02/no-confirm')
  const writesDelta = WRITES.length - writesBefore
  const after = snapTree(c.LIB)

  detail.result = { ok: res.ok, code: res.code, counts, writesDelta, logs: lines, residue: protocolResidue(c.library) }
  eq(res.ok, false, '没确认必须拒')
  eq(res.code, 'MIGRATION_NOT_CONFIRMED', '拒绝码保持既有值')
  eq(counts.applyCommit, 0, '未确认时 **applyCommit 调用次数必须为 0**（计数探针，不是"看起来没写"）')
  eq(counts.withPackTransaction, 0, '未确认时**事务件一次都没进**（withPackTransaction = 0）')
  eq(counts.planCommit, 0, '未确认时连计划都不造（闸在动盘与造计划之前）')
  eq(diffSnap(before, after), [], '未确认时夹具整树 sha256 一字不变')
  eq(writesDelta, 0, '未确认时进程内零写调用')
  eq(lines, [], '未确认时不打"已合并"那种账（没有副作用式的日志）')
  const residue = protocolResidue(c.library)
  eq(residue.lock, false, '未确认时不许建包锁')
  eq(residue.txnDir, false, '未确认时不许建事务日志目录')

  // 对照：带着确认 + 真摘要才会真的调用提交（与 A05 的正控同源，这里只证"计数会动"）
  const plan = OS.planLegacyMigration()
  const okRun = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: plan.digest }))
  noteCode(okRun.value, 'A02/positive-control')
  detail.positiveControl = { code: okRun.value.code, counts }
  eq(okRun.value.code, 'MIGRATION_DONE', '对照组：确认 + 真摘要必须真迁移（否则 0 计数没有意义）')
  check(counts.applyCommit === 1 && counts.withPackTransaction === 1, `对照组的提交计数必须动（实得 ${JSON.stringify(counts)}）`)
  rows(`未确认：applyCommit=${0} withPackTransaction=${0} planCommit=${0} 写调用 ${writesDelta} 次；对照组 ${JSON.stringify(counts)}`)
})

/* ═══════════════════════════════════════════════════════════════════ A03 */
const A03 = makeCase('A03', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const c = makeCaseTree('a03-digest')
  const { OS, counts } = loadOffline(c, { probes: true })
  const plan = OS.planLegacyMigration()

  /* ① 缺摘要 */
  const before1 = snapTree(c.LIB)
  const missing = silent(() => OS.applyLegacyMigration({ confirm: true })).value
  noteCode(missing, 'A03/missing-digest')
  eq(missing.ok, false, '缺摘要必须拒')
  eq(missing.code, 'MIGRATION_PLAN_REQUIRED', '缺摘要的错误码保持既有值 MIGRATION_PLAN_REQUIRED')
  eq(diffSnap(before1, snapTree(c.LIB)), [], '缺摘要时夹具整树 sha256 一字不变')
  check(/planDigest/.test(String(missing.error)), '缺摘要的说明要点名 planDigest（人知道下一步要带什么）')

  /* ② 过期摘要（摘要与刚算的计划不一致） */
  const staleDigest = 'f'.repeat(20) + '0'.repeat(12)
  check(staleDigest !== plan.digest, '夹具用的是一个**确实不同**的摘要（判据不是空转）')
  const before2 = snapTree(c.LIB)
  const stale = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: staleDigest })).value
  noteCode(stale, 'A03/stale-digest')
  eq(stale.ok, false, '过期摘要必须拒')
  eq(stale.code, 'MIGRATION_PLAN_STALE', '过期摘要的错误码保持既有值 MIGRATION_PLAN_STALE')
  eq(diffSnap(before2, snapTree(c.LIB)), [], '过期摘要时夹具整树 sha256 一字不变')
  check(Array.isArray(stale.plan) && stale.plan.length === 1, '过期回执仍把**新鲜计划**带回去（人可以直接重新确认）')
  eq(stale.digest, plan.digest, '过期回执里的 digest 是**刚算的**那个摘要')
  eq(counts.applyCommit, 0, '缺摘要 / 过期摘要都**没有**提交调用（真字节闸还没到）')
  eq(protocolResidue(c.library).lock, false, '缺摘要 / 过期摘要不许建包锁')
  detail.cases = {
    missing: { code: missing.code, error: missing.error },
    stale: { code: stale.code, digest: stale.digest === plan.digest, counts },
  }
  rows(`缺摘要 → ${missing.code}；过期摘要 → ${stale.code}；applyCommit=${counts.applyCommit}`)
})

/* ═══════════════════════════════════════════════════════════════════ A04 */
const A04 = makeCase('A04', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const PLANTED = '{"v":1,"source":"lessons/src","lessons":[]}\n'
  const c = makeCaseTree('a04-stage')
  const { OS, counts } = loadOffline(c, {
    probes: true,
    plantOnApply: { rel: path.join('lessons', 'lessons.json'), text: PLANTED },
  })
  const plan = OS.planLegacyMigration()
  const before = snapTree(c.library)
  const beforeLib = snapTree(c.LIB)
  const { value: res } = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: plan.digest }))
  noteCode(res, 'A04/stage-conflict')
  const after = snapTree(c.library)

  // 期望：除"被另一个写者动过的那一件"以外，库里每一个字节都保持原状；迁移自己的内容一个都没落位
  const expected = new Map(before)
  expected.set('lessons/lessons.json', sha256(Buffer.from(PLANTED, 'utf8')))
  detail.result = {
    ok: res.ok, code: res.code, failure: res.failure, counts,
    planted: readText(path.join(c.library, 'lessons', 'lessons.json')) === PLANTED,
    expectedDiff: diffSnap(expected, after),
  }
  eq(res.ok, false, '锁内字节闸：目标在计划之后被改过 ⇒ 必须拒')
  eq(res.code, 'MIGRATION_PLAN_STALE', '阶段失败映射到既有的"计划过期"码（不改码值）')
  check(!!res.failure && res.failure.code === 'PLAN_STALE', `失败面细节挂在 failure 里（实得 ${JSON.stringify(res.failure && res.failure.code)}）`)
  eq(diffSnap(expected, after), [], `阶段失败**不替换既有库产物**：除被外部改过的那一件，库里逐字节不变（差异：${diffSnap(expected, after).slice(0, 5).join('、')}）`)
  eq(readText(path.join(c.library, 'lessons', 'lessons.json')), PLANTED, '被外部改过的那一件**保留外部内容**（迁移没有覆盖它）')
  eq(exists(path.join(c.library, 'lessons', 'olda', 'alpha', '0001-x.html')), false, '阶段失败时迁移自己的课程页一个都没落位')
  eq(exists(c.legacyDirs.olda), true, '阶段失败时旧包还在原位（没有改名进回收站）')
  eq(exists(path.join(c.LIB, '.trash')), false, '阶段失败时不许建回收站')
  eq(exists(path.join(c.LIB, '.migrated.json')), false, '阶段失败时不许写迁移台账')
  eq(res.rebuild, null, '阶段失败时重建链一次都没跑（收尾三件一条都不做）')
  const residue = protocolResidue(c.library)
  eq(residue.lock, false, '阶段失败后包锁必须已释放（不能留一个锁把后来的写者挡在门外）')
  eq(residue.journals, [], '阶段失败后事务日志必须收干净（不留残骸）')
  check(counts.withPackTransaction >= 1, '这一条必须**真的进过事务件**（否则"阶段失败"是假的）')
  eq(diffSnap(beforeLib, snapTree(c.LIB)).filter((x) => !/library\/lessons\/lessons\.json$/.test(x)), [],
    '库根下除被外部动过的那一件之外没有任何变化')
  rows(`阶段失败 → ${res.code} · failure=${res.failure && res.failure.code} · 事务进入 ${counts.withPackTransaction} 次`)
})

/* ═══════════════════════════════════════════════════════════════════ A05 */
const A05 = makeCase('A05', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const SRC = {
    olda: [{ rel: 'olda/alpha/0001-x.html', halo: 'olda', point: 'alpha', number: 1, title: 'olda X' }],
    oldb: [{ rel: 'oldb/alpha/0001-x.html', halo: 'oldb', point: 'alpha', number: 1, title: 'oldb X' }],
  }
  const c = makeCaseTree('a05-codes', { legacy: ['oldb', 'olda'], legacyIndex: (id) => SRC[id] })
  const { OS } = loadOffline(c)
  const plan = OS.planLegacyMigration()

  /* ① 成功：MIGRATION_DONE */
  eq(plan.plan.map((p) => p.id), ['olda', 'oldb'], '计划按 id 排序（两个旧包）')
  // 旧包马上会被搬走 ⇒ "逐字节搬进去"的对照摘要必须在动盘**之前**取
  const srcSha = {}
  for (const id of ['olda', 'oldb']) {
    srcSha[id] = sha256File(path.join(c.legacyDirs[id], 'lessons', id, 'alpha', '0001-x.html'))
  }
  const applied = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: plan.digest }))
  const done = noteCode(applied.value, 'A05/done')
  eq(done.ok, true, `确认 + 摘要齐了必须真迁移（error=${done.error || '无'}）`)
  eq(done.code, 'MIGRATION_DONE', '成功码保持既有值 MIGRATION_DONE')
  eq(done.migrated, ['olda', 'oldb'], '迁移台账里两个旧包都在（顺序 = 计划顺序）')
  for (const id of ['olda', 'oldb']) {
    const landed = path.join(c.library, 'lessons', id, 'alpha', '0001-x.html')
    eq(exists(landed), true, `${id} 的课程页进了唯一课程库`)
    eq(sha256File(landed), srcSha[id], `${id} 的课程页是**逐字节**搬进去的（不是重排/重编码）`)
    eq(exists(c.legacyDirs[id]), false, `${id} 的原目录已经让位`)
  }
  eq(readText(path.join(c.library, 'lessons', 'lessons.json')),
    expectedIndexText([DEST_LESSON], [SRC.olda, SRC.oldb]), '合并后的清单 = 独立复算的结果（既有 rel 保留、新 rel 按 rel 升序）')
  const trash = path.join(c.LIB, '.trash')
  eq(exists(trash), true, '回收站建起来了（可手工恢复）')
  const trashed = fs.readdirSync(trash).sort()
  eq(trashed.length, 2, `回收站里两个旧包（实得 ${trashed.join('、')}）`)
  for (const name of trashed) check(/^(olda|oldb)-migrated-\d+$/.test(name), `回收站条目命名保持既有形状（实得 ${name}）`)
  eq(JSON.parse(readText(path.join(c.LIB, '.migrated.json'))), ['olda', 'oldb'], '迁移台账 `.migrated.json` 如实记下两个旧包')
  check(!!done.rebuild && typeof done.rebuild.ok === 'boolean', '回执带回重建结果（既有形状）')
  eq(done.rebuild.code, 'MISSING_SCRIPT', '夹具库没有 tools/（不是完整骨架）⇒ 重建链如实报缺脚本，**不改成功码**')
  eq(applied.lines.length, 1, '成功时打一行"已合并"的账（既有行为）')
  const residue = protocolResidue(c.library)
  eq(residue.lock, false, '成功提交后包锁已释放')
  eq(residue.journals, [], '成功提交后事务日志收干净（`.whale-txn/` 里不许留 journal 子目录）')
  detail.done = { code: done.code, migrated: done.migrated, rebuild: { ok: done.rebuild.ok, code: done.rebuild.code }, residue, logs: applied.lines }

  /* ② 无事可迁：MIGRATION_NOTHING */
  const plan2 = OS.planLegacyMigration()
  eq(plan2.count, 0, '迁移过的不再出现在计划里（幂等）')
  const before2 = snapTree(c.LIB)
  const nothing = noteCode(silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: plan2.digest })).value, 'A05/nothing')
  eq(nothing.ok, true, '无事可迁是**成功**（不是失败）')
  eq(nothing.code, 'MIGRATION_NOTHING', '无事可迁的码保持既有值 MIGRATION_NOTHING')
  eq(nothing.migrated, [], '无事可迁时不谎报迁移了什么')
  eq(nothing.rebuild, null, '无事可迁时不跑重建（既有形状：rebuild=null）')
  eq(diffSnap(before2, snapTree(c.LIB)), [], '无事可迁时夹具整树 sha256 一字不变（不动盘）')

  /* ③ 失败：MIGRATION_FAILED（包锁被另一个写者占着） */
  const busyCase = makeCaseTree('a05-busy')
  const { OS: OS3 } = loadOffline(busyCase)
  fs.mkdirSync(path.join(busyCase.library, '.whale-write.lock'), { recursive: true })
  writeText(path.join(busyCase.library, '.whale-write.lock', 'lock.json'),
    jsonText({ schema: 'whale-txn/1', ownerToken: 'another-writer', pid: 1 }))
  const plan3 = OS3.planLegacyMigration()
  const before3 = snapTree(busyCase.library)
  const failed = noteCode(silent(() => OS3.applyLegacyMigration({ confirm: true, planDigest: plan3.digest })).value, 'A05/failed-lock')
  eq(failed.ok, false, '包锁被占着时必须拒（不抢锁）')
  eq(failed.code, 'MIGRATION_FAILED', '失败码保持既有值 MIGRATION_FAILED（细节挂在 failure 里）')
  check(!!failed.failure && failed.failure.code === 'LOCK_BUSY', `失败面带上共同协议的码（实得 ${JSON.stringify(failed.failure && failed.failure.code)}）`)
  eq(exists(path.join(busyCase.library, 'lessons', 'olda', 'alpha', '0001-x.html')), false, '失败时课一个都没进库')
  eq(exists(path.join(busyCase.LIB, '.migrated.json')), false, '失败时不写迁移台账')
  eq(diffSnap(before3, snapTree(busyCase.library)), [], '失败时库整树 sha256 一字不变')
  detail.failed = { code: failed.code, failure: failed.failure && failed.failure.code, error: failed.error }

  /* ④ 六个原有码值一个不少（本次运行里全都真出现过） */
  const want = ['MIGRATION_NOT_CONFIRMED', 'MIGRATION_PLAN_REQUIRED', 'MIGRATION_PLAN_STALE', 'MIGRATION_NOTHING', 'MIGRATION_DONE', 'MIGRATION_FAILED']
  const seen = want.filter((code) => CODES_SEEN.has(code))
  detail.codes = { want, seen, all: [...CODES_SEEN.keys()].sort() }
  eq(seen, want, `原有六个 MIGRATION_* 码值本次运行里都必须真出现过（缺：${want.filter((x) => !CODES_SEEN.has(x)).join('、')}）`)
  rows(`码值：${want.join(' / ')}；成功迁移 migrated=${done.migrated.join(',')} 回收站=${trashed.join(',')}`)
})

/* ═══════════════════════════════════════════════════════════════════ A06 */
const A06 = makeCase('A06', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const src = readText(OFFLINE_SERVER)

  /* ① 声明的身份是**裸 point**（没有圆圈）⇒ 拒绝 + 指路 */
  const bare = makeCaseTree('a06-bare-point', {
    legacyIndex: () => [{ rel: 'vue/0001-x.html', point: 'vue', number: 1, title: 'X' }],
  })
  const { OS: OSB } = loadOffline(bare)
  const planB = OSB.planLegacyMigration()
  const beforeB = snapTree(bare.LIB)
  const writesBeforeB = WRITES.length
  const bareRes = silent(() => OSB.applyLegacyMigration({ confirm: true, planDigest: planB.digest })).value
  noteCode(bareRes, 'A06/bare-point')
  const writesDeltaB = WRITES.length - writesBeforeB
  detail.barePoint = {
    code: bareRes.code, blocked: bareRes.blocked, failure: bareRes.failure,
    error: bareRes.error, writesDelta: writesDeltaB, treeDiff: diffSnap(beforeB, snapTree(bare.LIB)),
  }
  eq(bareRes.ok, false, '身份是旧形状时必须拒（不合并半个包）')
  eq(bareRes.code, 'MIGRATION_REQUIRED', '码值是 U-SPEC §3 的拟新增码 MIGRATION_REQUIRED（不改任何旧码）')
  check(!!bareRes.failure && bareRes.failure.code === 'MIGRATION_REQUIRED' && bareRes.failure.kind === 'input',
    `失败面必须是 makeFailure 造的（实得 ${JSON.stringify(bareRes.failure)}）`)
  check(Array.isArray(bareRes.blocked) && bareRes.blocked.length === 1 && bareRes.blocked[0].id === 'olda',
    `阻断列要点名是哪个旧包（实得 ${JSON.stringify(bareRes.blocked)}）`)
  check(/tools[\\/]migrate-pack\.mjs/.test(String(bareRes.error)), `拒绝理由必须指向显式迁移 CLI（实得 ${JSON.stringify(String(bareRes.error).split('\n')[0])}）`)
  check(/--root=/.test(String(bareRes.error)) && /--plan/.test(String(bareRes.error)), '指路要能照抄（带 --root= 与 --plan）')
  eq(writesDeltaB, 0, '拒绝时进程内零写调用')
  eq(diffSnap(beforeB, snapTree(bare.LIB)), [], '拒绝时夹具整树 sha256 一字不变（没并半个包）')
  eq(bareRes.digest, planB.digest, '拒绝回执仍带**新鲜计划摘要**（界面可以据此指路 / 重新确认）')
  check(Array.isArray(bareRes.plan) && bareRes.plan.length === 1, '拒绝回执仍带计划本身（人看得到是哪几个旧包被挡）')
  eq(exists(path.join(bare.LIB, '.migrated.json')), false, '拒绝时不写迁移台账')
  eq(protocolResidue(bare.library).lock, false, '拒绝时连包锁都不建')

  /* ② 课程页落在**旧平铺**路径（少一层圆圈）⇒ 同样拒绝 */
  const flat = makeCaseTree('a06-flat', {
    flatLayout: true,
    legacyIndex: () => [{ rel: 'olda/alpha/0001-x.html', halo: 'olda', point: 'alpha', number: 1, title: 'X' }],
  })
  const { OS: OSF } = loadOffline(flat)
  const planF = OSF.planLegacyMigration()
  const flatRes = silent(() => OSF.applyLegacyMigration({ confirm: true, planDigest: planF.digest })).value
  noteCode(flatRes, 'A06/flat-layout')
  detail.flat = { code: flatRes.code, blocked: flatRes.blocked }
  eq(flatRes.code, 'MIGRATION_REQUIRED', '旧平铺路径同样判"需要身份迁移"（不猜圆圈）')
  check(/旧平铺/.test(String(flatRes.blocked && flatRes.blocked[0] && flatRes.blocked[0].error)),
    `阻断理由要说清是旧平铺（实得 ${JSON.stringify(flatRes.blocked)}）`)

  /* ③ 规范形状的同一批料**能过**（证明 ① ② 不是"一律拒"的空转判据） */
  const good = makeCaseTree('a06-good')
  const { OS: OSG } = loadOffline(good)
  const planG = OSG.planLegacyMigration()
  const goodRes = silent(() => OSG.applyLegacyMigration({ confirm: true, planDigest: planG.digest })).value
  noteCode(goodRes, 'A06/canonical-control')
  eq(goodRes.code, 'MIGRATION_DONE', '同一套判据下，规范身份必须放行（否则拒绝判据是空转）')

  /* ④ 源码层面：**不复制历史解码**（身份只问严格内核） */
  detail.source = {
    requiresIdentity: /unifyCore\('identity'\)/.test(src),
    requiresCommit: /unifyCore\('commit'\)/.test(src),
    requiresMigration: /unify\/migration\.cjs/.test(src),
    legacyHalo: /LEGACY_HALO|legacyFallback/.test(src),
    inlineHaloFallback: /halo\s*\|\|\s*['"]programming['"]/.test(src),
    interpolatesKey: /\$\{circle\}\/\$\{point\}|\$\{segs\[0\]\}\/\$\{segs\[1\]\}/.test(src),
  }
  eq(detail.source.requiresIdentity, true, '身份判定必须**委托**给严格内核（`unifyCore(\'identity\')`）')
  eq(detail.source.requiresCommit, true, '提交必须委托给共同协议（`unifyCore(\'commit\')`）')
  eq(detail.source.requiresMigration, false, 'offline-server 不许 require 迁移专用模块（那是显式 CLI 的活）')
  eq(detail.source.legacyHalo, false, 'offline-server 不许出现"旧圆圈兜底"这种历史解码痕迹')
  eq(detail.source.inlineHaloFallback, false, 'offline-server 不许自己补一个默认圆圈（猜就是解码）')
  eq(detail.source.interpolatesKey, false, '连键的拼法都不许在这里（否则又多一处身份构造点；只有严格内核能拼）')
  rows(`裸 point → ${bareRes.code}；旧平铺 → ${flatRes.code}；规范身份 → ${goodRes.code}`)
})

/* ═══════════════════════════════════════════════════════════════════ A07 */
const A07 = makeCase('A07', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data
  const MUT_MARK = '/* U12 · A07 临时变异：绕过摘要闸 */'

  /* ① 干净副本：两道闸都必须挡住 */
  const clean = makeCaseTree('a07-clean')
  const { OS: OSClean } = loadOffline(clean)
  const cleanPlan = OSClean.planLegacyMigration()

  // 判据 1（闸③ 锁内真实字节摘要）：计划之后目标被改 ⇒ 必须拒
  const judgeByteGate = (c, plant) => {
    const { OS } = loadOffline(c, { probes: true, plantOnApply: plant })
    const plan = OS.planLegacyMigration()
    const res = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: plan.digest })).value
    noteCode(res, `A07/byte-gate/${c.name}`)
    return {
      refused: res.ok === false && res.code === 'MIGRATION_PLAN_STALE',
      code: res.code,
      mergedLanded: exists(path.join(c.library, 'lessons', 'olda', 'alpha', '0001-x.html')),
    }
  }
  // 判据 2（闸② 确认回引的摘要）：拿一个旧摘要去确认 ⇒ 必须拒
  const judgeDigestGate = (c) => {
    const { OS } = loadOffline(c)
    const plan = OS.planLegacyMigration()
    const res = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: '0'.repeat(32) })).value
    noteCode(res, `A07/digest-gate/${c.name}`)
    return { refused: res.ok === false && res.code === 'MIGRATION_PLAN_STALE', code: res.code, planned: plan.digest.length }
  }
  const PLANT = { rel: path.join('lessons', 'lessons.json'), text: '{"v":1,"source":"lessons/src","lessons":[]}\n' }
  const cleanByte = judgeByteGate(makeCaseTree('a07-clean-byte'), PLANT)
  const cleanDigest = judgeDigestGate(makeCaseTree('a07-clean-digest'))
  detail.clean = { byteGate: cleanByte, digestGate: cleanDigest }
  eq(cleanByte.refused, true, '干净副本：锁内字节闸必须挡住"计划之后被改"的提交')
  eq(cleanDigest.refused, true, '干净副本：旧摘要必须被挡（确认的必须是这一份计划）')

  /* ② 变异一：绕过**锁内字节闸**（`commit.cjs` 里那两条写前/重建摘要比较） */
  const mutByte = makeCaseTree('a07-mut-byte', {
    mutate: (c) => {
      const file = path.join(c.tools, 'unify', 'commit.cjs')
      const before = readText(file)
      const anchors = [
        'if (digest !== f.beforeDigest) {',                 // 写前字节摘要
        'if (remove !== f.remove || digest !== f.digest) {', // 重建输出摘要
      ]
      let after = before
      for (const anchor of anchors) {
        if (!after.includes(anchor)) throw new Blocked(`A07：变异锚点不在 commit.cjs 里（${anchor}）`)
        after = after.replace(anchor, `if (false) { ${MUT_MARK}`)
      }
      fs.writeFileSync(file, after, 'utf8')
      return { file, anchors, beforeSha: sha256(Buffer.from(before)), afterSha: sha256(Buffer.from(after)), marker: MUT_MARK }
    },
  })
  const mutByteRun = judgeByteGate(mutByte, PLANT)
  MUTANTS.push({ what: 'byte-gate', ...mutByte.mutation })
  detail.mutantByteGate = { mutation: mutByte.mutation, run: mutByteRun }
  check(mutByte.mutation.afterSha !== mutByte.mutation.beforeSha, '变异一的字节真的变了（判据不是空转）')
  eq(mutByteRun.refused, false, '**绕过锁内字节闸后，A04 的判据必须红**（这里实测：它不再拒）')
  eq(mutByteRun.mergedLanded, true, '变异一之后迁移真的覆盖了被外部改过的那一件（正是 A04 要挡的）')

  /* ③ 变异二：绕过**确认回引的摘要闸**（`offline-server.js` 里那条 stale 比较） */
  const mutDigest = makeCaseTree('a07-mut-digest', {
    mutate: (c) => {
      const file = path.join(c.tools, 'offline-server.js')
      const before = readText(file)
      const anchor = 'if (String(b.planDigest) !== fresh.digest) {'
      if (!before.includes(anchor)) throw new Blocked(`A07：变异锚点不在 offline-server.js 里（${anchor}）`)
      const after = before.replace(anchor, `if (false) { ${MUT_MARK}`)
      fs.writeFileSync(file, after, 'utf8')
      return { file, anchor, beforeSha: sha256(Buffer.from(before)), afterSha: sha256(Buffer.from(after)), marker: MUT_MARK }
    },
  })
  const mutDigestRun = judgeDigestGate(mutDigest)
  MUTANTS.push({ what: 'confirm-digest-gate', ...mutDigest.mutation })
  detail.mutantDigestGate = { mutation: mutDigest.mutation, run: mutDigestRun }
  check(mutDigest.mutation.afterSha !== mutDigest.mutation.beforeSha, '变异二的字节真的变了（判据不是空转）')
  eq(mutDigestRun.refused, false, '**绕过摘要闸后，A03 的判据必须红**（这里实测：旧摘要也被放行）')

  /* ④ 变异只发生在 E:\Temp 副本里（主树一个字节都没动） */
  eq(sha256File(OFFLINE_SERVER), ANCHORS_BEFORE['lib/pack-template/tools/offline-server.js'],
    '主树的 offline-server.js 与跑前锚点逐字节相同（变异只在临时副本）')
  eq(sha256File(path.join(TEMPLATE_UNIFY, 'commit.cjs')), ANCHORS_BEFORE['lib/unify/commit.cjs'],
    '主树的 lib/unify/commit.cjs 与跑前锚点逐字节相同（变异只在临时副本）')
  detail.cleanPlan = { count: cleanPlan.count, digest: cleanPlan.digest }
  rows(`干净副本：字节闸拒=${cleanByte.code} 摘要闸拒=${cleanDigest.code}`)
  rows(`变异一（锁内字节闸）→ ${mutByteRun.code}（不再拒，判据红）· 变异二（摘要闸）→ ${mutDigestRun.code}（不再拒，判据红）`)
})

/* ═══════════════════════════════════════════════════════════════════ A08 */
const A08 = makeCase('A08', async ({ check, eq, rows, data }) => {
  requireMaterial()
  const detail = data

  /* ① 进程内写守卫：本次运行的所有写入都必须落在 {证据根 ∪ 本卡唯一夹具目录} */
  const writes = WRITES.slice()
  const outside = writes.filter((w) => !isAllowedWrite(w.path))
  const repoWrites = writes.filter((w) => {
    const rel = path.relative(REPO, w.path)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !w.path.startsWith(path.resolve(EVIDENCE_ROOT) + path.sep)
  })
  detail.writeGuard = {
    total: writes.length,
    allowedRoots: allowedWriteRoots(),
    outside: outside.slice(0, 20),
    repoWrites: repoWrites.slice(0, 20),
    livePackWrites: writes.filter((w) => w.path.startsWith(path.resolve(LIVE_PACK))).length,
    byApi: writes.reduce((acc, w) => { acc[w.api] = (acc[w.api] || 0) + 1; return acc }, {}),
  }
  eq(outside, [], `写守卫：不许写到 {证据根 ∪ 本卡夹具目录} 之外（越界：${outside.slice(0, 5).map((w) => w.path).join('、')}）`)
  eq(repoWrites, [], `写守卫：本次运行不许往仓库工作树写（除证据根；越界：${repoWrites.slice(0, 5).map((w) => w.path).join('、')}）`)
  eq(detail.writeGuard.livePackWrites, 0, `写守卫：零写入活包 ${LIVE_PACK}（卡面：不读写活包）`)
  check(writes.length > 0, '写守卫真的在工作（记录数 > 0，判据不是空转）')

  /* 自证探针：在夹具里写一个 canary，守卫必须记到它（证明不是"只记不拦"的假绿） */
  {
    const probePath = path.join(SESSION, 'write-guard-probe.txt')
    const before = WRITES.length
    writeText(probePath, 'U12 write-guard probe\n')
    const hit = WRITES.slice(before).some((w) => w.path === path.resolve(probePath))
    detail.writeGuard.probe = { probePath, recorded: hit }
    eq(hit, true, '写守卫自证：夹具里写一个探针文件必须被记录（守卫是活的）')
  }

  /* ② 零调用探针有效（正控：真跑一次必须让三个计数都 +1） */
  {
    const c = makeCaseTree('a08-probe')
    const { OS, counts } = loadOffline(c, { probes: true })
    const plan = OS.planLegacyMigration()
    const res = silent(() => OS.applyLegacyMigration({ confirm: true, planDigest: plan.digest })).value
    noteCode(res, 'A08/probe-positive-control')
    detail.probe = { counts, code: res.code }
    eq(res.code, 'MIGRATION_DONE', '正控：探针装上以后迁移照样能成功（探针不改变被测行为）')
    eq(counts.planCommit, 1, '正控：planCommit 计数 +1')
    eq(counts.applyCommit, 1, '正控：applyCommit 计数 +1')
    eq(counts.withPackTransaction, 1, '正控：事务件 withPackTransaction 计数 +1（零调用判据不是恒 0）')
  }

  /* ③ 授权写集并集（interfaces.md §6）—— tracked 改动必须 ⊆ 并集；本卡三件必须在 U12 行里 */
  const interfaces = readText(INTERFACES)
  const union = new Set()
  const rowOf = new Map()   // card -> Set(rel)
  for (const line of interfaces.split(/\r?\n/)) {
    const m0 = /^\|\s*(U\d\d)\s*\|/.exec(line)
    if (!m0) continue
    const cardRow = rowOf.get(m0[1]) || new Set()
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      let token = m[1].replace(/^[†✅]\s*/u, '').trim()
      if (!token || /\s/.test(token)) continue
      if (!/^[A-Za-z0-9._/-]+$/.test(token)) continue
      if (!token.includes('/') && !/\.(cjs|js|mjs|json|md)$/.test(token)) continue
      union.add(token)
      cardRow.add(token)
    }
    rowOf.set(m0[1], cardRow)
  }
  check(union.size > 40, `授权写集并集解析成功（实得 ${union.size} 条）`)
  const u12Row = rowOf.get(CARD) || new Set()
  detail.writeset = { unionSize: union.size, u12Row: [...u12Row] }
  for (const mine of ['lib/pack-template/tools/offline-server.js', 'test/audit/U12.mjs', 'docs/unify/receipts/U12.json']) {
    check(u12Row.has(mine), `interfaces.md §6 的 ${CARD} 行必须列出 ${mine}`)
  }
  check(!u12Row.has('lib/pack.js') && !u12Row.has('lib/pack-model.js'), 'U12 行里不许夹带别的卡的落点（并集不是"人人可写"）')
  const tracked = gitTrackedChanges()
  const outOfUnion = tracked.filter((t) => !union.has(t.rel))
  detail.writeset.trackedChanges = tracked.map((t) => `${t.code} ${t.rel}`)
  detail.writeset.outOfUnion = outOfUnion.map((t) => `${t.code} ${t.rel}`)
  eq(outOfUnion, [], `tracked 改动必须 ⊆ interfaces.md §6 的授权写集并集（越界：${outOfUnion.map((t) => t.rel).slice(0, 5).join('、')}）`)
  check(tracked.some((t) => t.rel === 'lib/pack-template/tools/offline-server.js'),
    '本卡的落点 offline-server.js 必须真的被改过（判据不是空转）')

  /* ④ 回执自检：合法 JSON ＋ 声明写集 ⊆ 授权并集 ＋ 越界项明写为空 */
  const receipt = JSON.parse(readText(RECEIPT))
  eq(receipt.card, CARD, '回执的 card 是 U12')
  // 声明写集两种既有形状都认：`writeSet: [{path,action}]`（U08 那种）或 `writeSet: {trackedWrite,created}`
  const wsField = receipt.writeSet
  const declared = Array.isArray(wsField)
    ? wsField.map((x) => String((x && x.path) || x || '')).filter(Boolean)
    : [
      ...((wsField && wsField.trackedWrite) || []),
      ...((wsField && wsField.created) || []),
    ].map(String)
  detail.receipt = { card: receipt.card, declared, outOfScope: receipt.writeSetOutOfScope }
  check(declared.length >= 3, `回执声明的写集至少三件（实得 ${declared.length}）`)
  const declaredOut = declared.filter((rel) => !union.has(String(rel)))
  eq(declaredOut, [], `回执声明的写集必须 ⊆ 授权并集（越界：${declaredOut.join('、')}）`)
  eq(receipt.writeSetOutOfScope, [], '回执必须**明写越界项为空数组**（不是省略、也不是"范围说明"那个 outOfScope）')

  /* ⑤ 既有测试被改 ⇒ **按三个授权面逐条点名归属**（不是整类放行，也不是整类判红）
   *
   *   ① **本卡写集**（§6 的 U12 行那三件）                        → 放行，理由「写集(U12)」
   *   ② **§6 里有主**（运行时解析 interfaces.md §6，记主人卡号）    → 放行，理由「§6/<卡号>」
   *   ③ authorization.json 的 scope.A / P1 / P2 **或 decisions.approvedChanged** 逐字点名
   *                                                                → 放行，理由「scope.X」/「decisions.决-N」
   *   ④ 其余 → **红**（`test/pack-template-rules.mjs`、`test/_pack.mjs` 这类仍必须红）
   *
   * 为什么 ② 必须是授权面：`interfaces.md` §6 是**写集账本**，不是 §12 的附属说明。决-1/决-2 授权
   * 同步的 `test/audit/T03.mjs`、决-5 的 `T12`、决-6 的 `T10` 都**登记在 §6 的 U01 行**（带限定语），
   * 只认 `authorized[]` 逐字点名的旧口径会把这三条**已授权**的改动判成越界（假红：识别缺口）。
   *
   * 强度不降：放行**必须写得出理由**（主人卡号或授权节），逐条落进 `sources`；§6 这一面同样只认
   * **逐条点名的路径**（T 卡不是类别豁免），简称（决-2 里的「同步 T03」）与通配都不算点名。
   */
  const authz = JSON.parse(readText(AUTHORIZATION))
  check(typeof authz.quoteVerbatim === 'string' && authz.quoteVerbatim.trim() !== '',
    `授权文件里必须逐字留着人类原话（实得 ${JSON.stringify(authz.quoteVerbatim)}）`)
  check(typeof (authz.decisions && authz.decisions.quoteVerbatim) === 'string' && authz.decisions.quoteVerbatim.trim() !== '',
    `授权文件里必须逐字留着第二批人类原话（实得 ${JSON.stringify(authz.decisions && authz.decisions.quoteVerbatim)}）`)
  const TEST_PATH_RX = /test\/[A-Za-z0-9._/-]+\.mjs/g
  const CARD_WRITE_SET = ['lib/pack-template/tools/offline-server.js', 'test/audit/U12.mjs', 'docs/unify/receipts/U12.json']
  const sources = new Map()   // rel -> [{scope, owner, label}]
  const addSource = (rel, src) => {
    if (!sources.has(rel)) sources.set(rel, [])
    const arr = sources.get(rel)
    if (!arr.some((x) => x.label === src.label)) arr.push(src)
  }
  // ① 本卡写集
  for (const rel of CARD_WRITE_SET) addSource(rel, { scope: 'writeSet', owner: CARD, label: `写集(${CARD})` })
  // ② §6 有主（运行时解析；只认逐条点名的测试路径）
  for (const [card, paths] of rowOf) {
    for (const rel of paths) {
      if (!/^test\/[A-Za-z0-9._/-]+\.mjs$/.test(rel)) continue
      addSource(rel, { scope: '§6', owner: card, label: `§6/${card}` })
    }
  }
  // ③ authorization.json：scope.A / P1 / P2（逐字点名）
  for (const [key, scope] of [['A', authz.scope && authz.scope.A], ['P1', authz.scope && authz.scope.P1], ['P2', authz.scope && authz.scope.P2]]) {
    for (const line of (scope && scope.authorized) || []) {
      const text = String(line)
      const owner = /U\d\d/.test(text) ? (text.match(/U\d\d/) || [])[0] : '(未点名)'
      for (const m of text.matchAll(TEST_PATH_RX)) addSource(m[0], { scope: key, owner, label: `scope.${key}` })
    }
  }
  // ③ decisions.approvedChanged（决-1/2/5/6 逐字点名的那几条）
  for (const d of (authz.decisions && authz.decisions.approvedChanged) || []) {
    const id = String((d && d.id) || '').trim()
    const owner = /^决-\d+$/.test(id) ? id : '(未点名)'
    for (const m of String((d && d.what) || '').matchAll(TEST_PATH_RX)) addSource(m[0], { scope: 'decisions', owner, label: `decisions.${owner}` })
  }
  // **永不面**：scope.A / P1 / P2 与 decisions 的 `notAuthorized[]` 里逐字点名的路径，任何授权面都抹不平
  // （用户禁令「test/pack-template-rules.mjs 仍只读，任何卡不得改其断言」优先于 决-9 的「只加登记项」——
  //   决-9 是**更窄**的例外（只许加登记项、不许改断言），路径级的放行面表达不了它，故仍按红处理）
  const denied = new Set()
  for (const key of ['A', 'P1', 'P2']) {
    for (const line of ((authz.scope && authz.scope[key] && authz.scope[key].notAuthorized) || [])) {
      for (const m of String(line).matchAll(TEST_PATH_RX)) denied.add(m[0])
    }
  }
  for (const line of ((authz.decisions && authz.decisions.notAuthorized) || [])) {
    for (const m of String(line).matchAll(TEST_PATH_RX)) denied.add(m[0])
  }
  const deniedRaw = new Set(denied)        // 永不面的**原样**（下面断言它仍然点名那条禁令）
  // 决-B1（第三批授权，用户原文「确认」）只把**一件事**从 deny 里放出来：
  // `test/pack-template-rules.mjs` 的**登记项增行**（0 删 + 恰好那 14 行）。deny 原则不动 ——
  // 形状对不上就仍然红；下面的变异对照证明这条豁免不是恒真。
  const RULES_REL = 'test/pack-template-rules.mjs'
  const rulesDiff = git(['diff', '-U0', '--', RULES_REL])
  const rulesShape = registrationsOnlyFromDiff(rulesDiff, coreModuleNames())
  if (denied.has(RULES_REL) && rulesShape.ok) denied.delete(RULES_REL)
  const authorized = new Map()   // rel -> {scope, owner, sources}
  for (const [rel, arr] of sources) {
    if (denied.has(rel)) continue          // deny 覆盖 allow
    authorized.set(rel, { scope: arr[0].scope, owner: arr[0].owner, sources: arr.map((x) => x.label) })
  }
  const modifiedTests = gitDiffNames(BASE_SHA, 'test/').filter((rel) => rel.endsWith('.mjs'))
  const attributed = modifiedTests.map((rel) => ({ rel, ...(authorized.get(rel) || {}) }))
  const unnamed = attributed.filter((t) => !t.scope)
  detail.tests = {
    denied: [...denied],
    authorized: [...authorized.entries()].map(([rel, v]) => ({ rel, ...v })),
    modifiedTests, attributed, unnamed,
  }
  eq(unnamed.map((t) => t.rel), [], `未经授权的既有测试改动必须红（未点名：${unnamed.map((t) => t.rel).join('、')}）`)
  for (const t of attributed) {
    check(['writeSet', '§6', 'A', 'P1', 'P2', 'decisions'].includes(t.scope), `${t.rel} 的归属必须落在授权面里（实得 ${t.scope}）`)
    check(typeof t.owner === 'string' && t.owner !== '', `${t.rel} 必须写明主人（实得 ${t.owner}）`)
    check(Array.isArray(t.sources) && t.sources.length > 0, `${t.rel} 必须写得出授权理由（主人或授权节）`)
  }
  // 反空转：授权面是**逐条点名**的，不是"测试类全放行"（红样本只增不减）
  for (const other of ['test/_pack.mjs', 'test/audit/T20.mjs', 'test/audit/T23.mjs', 'test/all.mjs', 'test/pack-scaffold.mjs', 'test/alien-env.mjs']) {
    check(!authorized.has(other), `授权面不许把 ${other} 也放行（逐字点名，不是整类）`)
  }
  // deny 覆盖 allow：用户禁令（scope.A.notAuthorized「仍只读，任何卡不得改其断言」）**仍然逐字在永不面里**；
  // 决-B1（第三批授权）只把「只加登记项」这一种**可机判形状**放出来（见 registrationsOnlyFromDiff）。
  check(deniedRaw.has(RULES_REL),
    '永不面必须仍然逐字点名 test/pack-template-rules.mjs（用户禁令：它只读，任何卡不得改其断言）')
  check(sources.has(RULES_REL), '它必须由 §6 的 U19 行登记（决-B1 的账本出口；无主即越界）')
  check(rulesShape.ok, `决-B1 的豁免必须过「只加登记项」形状判据（实得 ${JSON.stringify(rulesShape.problems)}）`)
  check(authorized.has(RULES_REL) && authorized.get(RULES_REL).owner === 'U19',
    '只加登记项（形状已核）才进放行面，且主人必须是 U19')
  {
    // 变异对照：形状判据必须能"说不"（否则这条豁免就是恒真的通行证）
    const mods = coreModuleNames()
    const dropRow = (t) => t.replace(`+  'tools/unify/${mods[0]}.cjs',\n`, '')
    const turnRowIntoDeletion = (t) => t.replace(`+  'tools/unify/${mods[1]}.cjs',`, `-  'tools/unify/${mods[1]}.cjs',`)
    const injectExtra = (t) => `${t}+  'tools/unify/hack.cjs',\n`
    const changeCriterion = (t) => t.replace(`+  'tools/unify/${mods[2]}.cjs',`, `+  'tools/unify/${mods[2]}.cjs', 'assets/whatever.js',`)
    const mutants = [['删一行登记项', dropRow], ['把一行登记项改成删除', turnRowIntoDeletion], ['塞一行非登记代码', injectExtra], ['改一行非登记内容', changeCriterion]]
    for (const [what, mutate] of mutants) {
      check(!registrationsOnlyFromDiff(mutate(rulesDiff), mods).ok,
        `形状判据的变异对照失败：${what} 之后仍被判 ok（那这条豁免就是恒真的）`)
    }
    check(registrationsOnlyFromDiff(rulesDiff, mods).ok, '真实 diff 必须被形状判据判 ok（否则豁免没生效）')
  }
  check(!authorized.has('test/_pack.mjs'), '既有夹具助手 test/_pack.mjs 不在任何授权面里（仍是红）')
  // 反空转：只认逐字路径 —— 简称（决-2 里的「同步 T03」）与通配都不算点名
  check([...authorized.keys()].every((p) => p.includes('/') && !p.includes('*')), '授权面只认逐字路径（简称 / 通配不算点名）')
  // 放行**必须写得出理由**：任何一条有 scope 却没主人也没 sources 的条目都算判据失效
  check([...authorized.entries()].every(([, v]) => (typeof v.owner === 'string' && v.owner !== '') && v.sources.length > 0),
    '放行面不许出现「放行了却写不出理由」的条目')
  check(authorized.has('test/mirror-parity.mjs'), '授权面里必须点名 test/mirror-parity.mjs（U09 的 A 面）')
  check(authorized.has('test/intake.mjs'), '授权面里必须点名 test/intake.mjs（U10 的 A 面）')
  // §6 这一面同样**逐条点名**：决-1/2/5/6 的三张 T 卡必须在册，且理由里既有 §6 主人又有对应决号
  {
    const t03 = authorized.get('test/audit/T03.mjs')
    check(t03 && t03.scope === '§6' && /^U\d\d$/.test(String(t03.owner)),
      `§6 授权面里必须逐条点名 test/audit/T03.mjs 并写出 U 卡主人（实得 ${JSON.stringify(t03)}）`)
    check(t03 && t03.sources.includes('decisions.决-1'), `test/audit/T03.mjs 的理由里必须有 decisions.决-1（实得 ${JSON.stringify(t03 && t03.sources)}）`)
    const t12 = authorized.get('test/audit/T12.mjs')
    check(t12 && t12.sources.includes('decisions.决-5'), `test/audit/T12.mjs 的理由里必须有 decisions.决-5（实得 ${JSON.stringify(t12 && t12.sources)}）`)
    const t10 = authorized.get('test/audit/T10.mjs')
    check(t10 && t10.sources.includes('decisions.决-6'), `test/audit/T10.mjs 的理由里必须有 decisions.决-6（实得 ${JSON.stringify(t10 && t10.sources)}）`)
    const t26 = authorized.get('test/audit/T26.mjs')
    check(t26 && t26.sources.includes('scope.P2'), `test/audit/T26.mjs 的授权节必须仍在（scope.P2；实得 ${JSON.stringify(t26 && t26.sources)}）`)
    check(!authorized.has('test/nobody-owns-me.mjs'), '授权面不许把没人登记的测试也放行（逐条点名，不是整类）')
  }

  /* ⑥ 依赖锚点：跑前跑后逐字不变（运行期自锚） */
  const now = dependencyAnchors()
  const drift = DEPENDENCIES.filter((rel) => now[rel] !== ANCHORS_BEFORE[rel])
  detail.anchors = { before: ANCHORS_BEFORE, after: now, drift }
  eq(drift, [], `依赖锚点 sha256 不许在本次运行里变（变了的：${drift.join('、')}）`)

  /* ⑦ 夹具"逐字节复制权威模块"：**按现状字节**逐个对拍；不同只许是 A07 记名的那两处变异 */
  detail.copiedAuthority = COPIED_AUTHORITY
  check(Object.keys(COPIED_AUTHORITY).length > 0, '夹具里逐字节复制的权威模块清单非空')
  const authorityOf = {
    'offline-server.js': OFFLINE_SERVER,
    'unify/commit.cjs': path.join(TEMPLATE_UNIFY, 'commit.cjs'),
    'unify/identity.cjs': path.join(TEMPLATE_UNIFY, 'identity.cjs'),
    'unify/errors.cjs': path.join(TEMPLATE_UNIFY, 'errors.cjs'),
  }
  const mutantOf = new Map(MUTANTS.map((m) => [path.resolve(m.file), m]))
  let compared = 0
  const mutantSeen = []
  for (const e of fs.readdirSync(SESSION, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const tools = path.join(SESSION, e.name, 'install', 'tools')
    for (const [rel, auth] of Object.entries(authorityOf)) {
      const abs = path.join(tools, ...rel.split('/'))
      if (!exists(abs)) continue                        // a08-no-copies 故意没有 unify/ 副本
      const mut = mutantOf.get(path.resolve(abs))
      if (mut) {
        eq(sha256File(abs), mut.afterSha, `A07 的变异副本 ${e.name}/tools/${rel} 现状必须就是变异后的字节`)
        mutantSeen.push(`${e.name}/tools/${rel}`)
        continue
      }
      eq(sha256File(abs), sha256File(auth), `夹具副本 ${e.name}/tools/${rel} 必须与权威件逐字节相同`)
      compared += 1
    }
  }
  check(compared >= 20, `对拍到的"原封不动"副本要有足够多（实得 ${compared} 件）`)
  eq(mutantSeen.length, MUTANTS.length, `只有 A07 记名的变异副本可以不同（实得 ${mutantSeen.join('、') || '无'}）`)
  detail.copyParity = { compared, mutantSeen, mutants: MUTANTS.map((m) => ({ what: m.what, file: m.file })) }

  /* ⑧ R1 中间态：**没有** tools/unify 副本时管理台照样加载，旧库迁移如实拒绝（不静默降级） */
  const noCopies = makeCaseTree('a08-no-copies', { copies: false })
  // 连唯一课程库也不存在 —— 这一支最容易"顺手铺个骨架"，所以专门钉住：拒绝时**一个字节都不写**
  fs.rmSync(noCopies.library, { recursive: true, force: true })
  const { OS: OSN } = (() => {
    process.env.WHALE_LIB = noCopies.LIB
    process.env.WHALE_RUNTIME_DIR = path.join(noCopies.root, 'runtime')
    return { OS: requireCJS(path.join(noCopies.tools, 'offline-server.js')) }
  })()
  detail.r1 = { inRepoCopies: exists(path.join(TEMPLATE_TOOLS, 'unify')), handler: typeof OSN.handler }
  eq(typeof OSN.handler, 'function', '缺 `tools/unify/` 副本时模块照样能加载（否则 /api/health 与静态面会一起 500）')
  // ⚠️ 这里**不**断言"仓里一定没有副本"：U19 一跑，`lib/pack-template/tools/unify/` 就会生成。
  //    两条都必须是真断言、且两条都不许靠"跳过"——"有副本 ⇒ 真迁移"由 A05/A06 的规范身份用例证，
  //    "没副本 ⇒ 如实拒绝、一个字节不写"由本节证。`inRepoCopies` 只作为中间态事实登记进证据。
  const planN = OSN.planLegacyMigration()
  const beforeNoCopies = snapTree(noCopies.LIB)
  const noCopiesRes = silent(() => OSN.applyLegacyMigration({ confirm: true, planDigest: planN.digest })).value
  noteCode(noCopiesRes, 'A08/no-unify-copies')
  detail.r1.refusal = { code: noCopiesRes.code, error: noCopiesRes.error }
  eq(noCopiesRes.code, 'MIGRATION_FAILED', '缺副本时迁移如实拒绝（不打洞、不静默降级）')
  check(/tools\/unify/.test(String(noCopiesRes.error)), `拒绝理由要点名缺的是 tools/unify（实得 ${JSON.stringify(String(noCopiesRes.error).slice(0, 120))}）`)
  eq(exists(path.join(noCopies.LIB, '.migrated.json')), false, '缺副本被拒时不写迁移台账')
  eq(diffSnap(beforeNoCopies, snapTree(noCopies.LIB)), [], '缺副本被拒时库树一个字节不变（连骨架都不铺）')
  eq(exists(noCopies.library), false, '缺副本被拒时不建唯一课程库')

  /* ⑨ 夹具与清理守卫 */
  eq(path.resolve(SESSION).startsWith(path.resolve(TMP_BASE) + path.sep), true, '本次唯一夹具目录必须落在 E:\\Temp 下')
  check(new RegExp(`^${CARD}-cases-`).test(path.basename(SESSION)), `夹具目录名必须是本次专属前缀（实得 ${path.basename(SESSION)}）`)
  eq(guardTempPath(SESSION, { parent: TMP_BASE }).ok, true, '清理守卫认这次夹具目录（父目录 + 名字形状都对）')
  eq(guardTempPath(path.join(REPO, 'lib'), { parent: TMP_BASE }).ok, false, '清理守卫拒绝非本卡目录（不是"能删就删"）')
  const evShape = path.resolve(EVIDENCE_ROOT).startsWith(path.join(REPO, 'audit-evidence', CARD))
    || path.resolve(EVIDENCE_ROOT).startsWith(path.resolve(TMP_BASE) + path.sep)
  eq(evShape, true, '证据根要么是本卡 audit-evidence/U12 下的新运行目录，要么是 E:\\Temp 新目录')

  rows(`写记录 ${writes.length} 条 · 越界 ${outside.length} · 仓库写 ${repoWrites.length} · 活包写 ${detail.writeGuard.livePackWrites}`)
  rows(`授权并集 ${union.size} 条（U12 行 ${u12Row.size} 条）· tracked 改动 ${tracked.length} 条 · 越界 ${outOfUnion.length}`)
  rows(`既有测试改动 ${attributed.map((t) => `${t.rel}(${t.scope}/${t.owner})`).join('、') || '（无）'}`)
  rows(`依赖锚点漂移 ${drift.length} 条`)

  /* ⑩ 清理（守卫过；证据已落盘，清理失败只登记不覆盖判词） */
  if (process.env.U12_KEEP === '1') {
    detail.cleanup = { removed: false, error: 'U12_KEEP=1：判据调试用，保留夹具' }
  } else {
    const clean = safeRemoveTree(SESSION, { parent: TMP_BASE })
    detail.cleanup = clean
    eq(clean.removed, true, `夹具清理必须成功（${clean.error ?? ''}）`)
  }
})

/* ═════════════════════════════════════════════════════════════ 跑八项 */
const CASES = [A01, A02, A03, A04, A05, A06, A07, A08]

const verdict = await runCard(CARD, FIXED_IDS, CASES, {
  evidenceDir: EVIDENCE_ROOT,
  argv: process.argv,
  timeoutMs: 600000,
})

writeRunEvidence(verdict, EVIDENCE_ROOT)
/** 判词已经定下来了：下面的运行元信息取不到**不许**把判词弄丢（只如实登记成 null） */
const safeGit = (argv) => { try { return git(argv).trim() } catch { return null } }
evJson('run.json', {
  card: CARD,
  argv: process.argv,
  base: BASE_SHA,
  branch: safeGit(['rev-parse', '--abbrev-ref', 'HEAD']),
  head: safeGit(['rev-parse', 'HEAD']),
  evidenceRoot: EVIDENCE_ROOT,
  fixtureRoot: SESSION,
  verdict: {
    status: verdict.status, code: verdict.code, line: verdict.line,
    checks: verdict.checks, failed: verdict.failed, skipped: verdict.skipped,
  },
  codesSeen: [...CODES_SEEN.entries()].map(([code, wheres]) => ({ code, wheres: wheres.slice(0, 8) })),
  copiedAuthority: COPIED_AUTHORITY,
  dependencies: ANCHORS_BEFORE,
})

/** 收尾清场（**守卫过**）：A08 已清过一次；这里兜住"某条用例提前失败、A08 没走到清理"的情形 */
function finalCleanup() {
  if (process.env.U12_KEEP === '1') return { removed: false, error: 'U12_KEEP=1' }
  if (!exists(SESSION)) return { removed: true, error: null, note: '已被 A08 清理' }
  return safeRemoveTree(SESSION, { parent: TMP_BASE })
}
const cleanupResult = finalCleanup()
evJson('cleanup.json', cleanupResult)

process.exitCode = printVerdict(verdict)
