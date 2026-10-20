#!/usr/bin/env node
/**
 * test/audit/U06.mjs —— 共同提交守卫（U06 专项入口）
 * ==================================================================
 * 判的是三个落点的**真实行为**，不是它们的注释：
 *   `lib/unify/commit.cjs`                          —— 新建：planCommit / applyCommit（三闸、七态、whale-commit/1）
 *   `lib/pack-template/tools/ledger-transaction.cjs` —— 改：**只增** `failureFor()`（七态 → 失败面 kind）
 *   `tools/recover-ledgers.mjs`                      —— 改：**只增** `--json`（文本回执与退出码逐字保持）
 *
 * 用法：
 *   node test/audit/U06.mjs                                    # 本卡入口
 *   node test/audit/U06.mjs --evidence-root=<绝对新运行目录>     # 只改**证据落点**，不改判据
 *
 * 判词（stdout 一行，exit 0/1/2）：
 *   `PASS U06 checks=8 failed=0 skipped=0` / `FAIL U06 …` / `BLOCKED U06 …`
 *
 * 固定八项 A01–A08 全是真断言（真临时课程包、真包锁、真 journal、真子进程、真 CLI）：
 *   A01 三闸分别可拒绝（计划 / 确认 / 真实字节摘要，各带码与 failure）
 *   A02 前置拒绝时**提交调用次数为零**（注入计数探针 = 0；成功路径证明探针会涨到 1）
 *   A03 摘要覆盖**真实字节**变化（同计划、输入改一个字节 → 摘要变且被拒；含非 UTF-8 字节）
 *   A04 锁内变化被拒绝（计划后、提交前改目标 → 拒绝；旧计划不覆盖；新内容还在；复核发生在锁内）
 *   A05 七态 + `whale-txn/1` 日志 schema + 待恢复阻断（逐态断言；待恢复时普通写被拒且 build 零调用）
 *   A06 恢复失败如实报告（真残骸 + 事务实现抛错两路：recovery-required、材料保留、不宣称成功/已恢复）
 *   A07 临时跳过确认闸 / 吞掉恢复失败 → 判据必须失败（E:\Temp 副本变异；干净副本 PASS 对照）
 *   A08 运行期自锚（七件依赖 boot=end）+ §6 归属登记 + 交付物内容锁 + 进程内写守卫 + 路径守卫 + 证据落盘 + 清理
 *
 * A08 的锚点口径（**不是**「interfaces.md 的 sha 必须等于 U03 消费时记下的锁值」）：
 *   ① 运行期自锚：本次运行开始记下七件依赖的 sha256，收口前再比一次，必须逐字节相同；
 *   ② 本进程写守卫：本次运行真的写过锚点 ⇒ 红（非本卡写权的东西，字节相同也不许写）；
 *   ③ 交付物内容锁：本卡的交付物必须仍等于 `docs/unify/receipts/U06.json` 登记的字节；
 *   ④ 跨卡登记值漂移：只登记 + 按 interfaces.md §6 归属（interfaces.md/baseline.json → U01，
 *      errors.cjs/ledger-read.cjs → U03），**不**因此判红 —— 合法性由归属卡自己的判据负责。
 * 为什么改：interfaces.md 归 U01，在授权路径上被合法账本同步更新过两次
 *   （docs/unify/receipts/U01.json 的 deltas L1 / L3），跨卡字节等值锚必然陈旧。
 *
 * 用法补充（只做判据反空转自证，不改任何判据）：
 *   node test/audit/U06.mjs --anchor-self-proof   # 3 红 2 绿样本：锚点分类器 / 写守卫分类器
 *
 * 临时夹具只在 `E:\Temp\u06-s2-blane\U06-<pid>`（每次唯一）；清理前核对绝对路径与归属。
 * 不访问活包 `E:\workplace\study`，不写主树，不跑全量门槛，不碰任何既有 test/*.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  FIXED_IDS, REPO, runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot,
  guardTempPath, safeRemoveTree, Blocked,
} from './unify-runner.mjs'

const CARD = 'U06'
const SELF = fileURLToPath(import.meta.url)
const ARGV = process.argv.slice(2)
const requireCJS = createRequire(import.meta.url)

const COMMIT_FILE = path.join(REPO, 'lib', 'unify', 'commit.cjs')
const ERRORS_FILE = path.join(REPO, 'lib', 'unify', 'errors.cjs')
const TXN_FILE = path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs')
const CLI_FILE = path.join(REPO, 'tools', 'recover-ledgers.mjs')
const IFACE_FILE = path.join(REPO, 'docs', 'unify', 'interfaces.md')
const RECEIPT_DIR = path.join(REPO, 'docs', 'unify', 'receipts')
const RECEIPT_FILES = Object.freeze({
  U01: path.join(RECEIPT_DIR, 'U01.json'),
  U03: path.join(RECEIPT_DIR, 'U03.json'),
  U06: path.join(RECEIPT_DIR, 'U06.json'),
})
const LEDGER_READ_FILE = path.join(REPO, 'lib', 'unify', 'ledger-read.cjs')

/** 本卡写集（相对仓根）。A08 的写守卫拿它当"允许写"的名单之一。 */
const WRITE_SET = [
  'lib/unify/commit.cjs',
  'lib/pack-template/tools/ledger-transaction.cjs',
  'tools/recover-ledgers.mjs',
  'test/audit/U06.mjs',
  'docs/unify/receipts/U06.json',
]

/**
 * A08 的**依赖锚点**（七件）—— 归属逐条按 `docs/unify/interfaces.md` §6 的写集表，
 * A08 会**从 §6 表里解析归属**再和这里逐条比对（不靠这张常量表自说自话）。
 */
const ANCHOR_SPECS = Object.freeze([
  { rel: 'docs/unify/interfaces.md', owner: 'U01', role: 'interface-lock', why: 'U06 的码表 / 落点表 / 接口锁' },
  { rel: 'docs/unify/baseline.json', owner: 'U01', role: 'baseline', why: 'U06 的基线出口' },
  { rel: 'lib/pack-template/tools/ledger-transaction.cjs', owner: 'U06', role: 'deliverable', why: '本卡交付物（只增 failureFor）' },
  { rel: 'tools/recover-ledgers.mjs', owner: 'U06', role: 'deliverable', why: '本卡交付物（只增 --json）' },
  { rel: 'lib/unify/commit.cjs', owner: 'U06', role: 'deliverable', why: '本卡交付物（planCommit / applyCommit）' },
  { rel: 'lib/unify/errors.cjs', owner: 'U03', role: 'dependency', why: 'failure 结构 + makeFailure 唯一工厂' },
  { rel: 'lib/unify/ledger-read.cjs', owner: 'U03', role: 'dependency', why: '五态读取（U06 消费面同源）' },
])

/** 临时夹具根：**本卡唯一**的 E:\Temp 目录前缀（每次运行再套一层 U06-<pid>）。 */
const TEMP_ROOT = 'E:\\Temp\\u06-s2-blane'
const RUN_TMP = path.join(TEMP_ROOT, `U06-${process.pid}`)

/** 七态（U-SPEC §3）：两个模块都必须用这一套词，逐字。 */
const SEVEN_STATES = ['building', 'prepared', 'committed', 'rejected', 'busy', 'rolled-back', 'recovery-required']

/** U01 锁定的码值（interfaces.md §5 的真实码表；不凭空编码）。 */
const GATE_CODES = { plan: 'PLAN_REQUIRED', confirm: 'CONFIRM_REQUIRED', bytes: 'PLAN_STALE' }
const NEW_CODES = ['LOCK_BUSY', 'RECOVERY_REQUIRED']

/** A07 的两个变异落点（各在源码里**恰好出现一次**）。 */
const MUT_GATE2_TOKEN = 'if (opts.confirm !== true) {'
const MUT_GATE2_REPLACEMENT = 'if (false) { // MUTANT: skip confirm gate'
const MUT_RECOVERY_TOKEN = 'if (state === RECOVERY_STATE) return recoveryReceipt(res)'
const MUT_RECOVERY_REPLACEMENT = "if (state === RECOVERY_STATE) return { ok: true, state: 'committed', code: null, error: null, failure: null, rollbackError: null, journal: null, value: undefined } // MUTANT: swallow recovery failure"

/** T09 判据里锁着的两段源码（本卡改事务件时**逐字不许动**；A08 用它们证明"只增"）。 */
const T09_LOCK_REGION = /  try \{\n    fs\.mkdirSync\(lock, \{ recursive: false \}\)\n  \} catch \(e\) \{\n    const code = e && e\.code \? e\.code : 'IO_ERROR'/
const T09_ROLLBACK_REGION = /  const rollback = \(\) => \{\n    const errors = \[\]/

/** 本次运行收集的原始材料（A08 落证据；全是真跑出来的结果，不是手写常量）。 */
const EVID = { gates: {}, states: null, recovery: null, mutation: null, guard: null, samples: [], cli: null }

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '不相等'}：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败') }
function eqJson(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg)
}
function countOf(text, token) { return String(text).split(token).length - 1 }

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function loadMods() {
  for (const [label, file] of [['commit.cjs', COMMIT_FILE], ['errors.cjs', ERRORS_FILE], ['ledger-transaction.cjs', TXN_FILE]]) {
    if (!fs.existsSync(file)) throw new Blocked(`缺模块：${label}（${path.relative(REPO, file)}）`)
  }
  const C = requireCJS(COMMIT_FILE)
  const TXN = requireCJS(TXN_FILE)
  if (typeof C.planCommit !== 'function' || typeof C.applyCommit !== 'function') {
    throw new Blocked('lib/unify/commit.cjs 没有导出 planCommit / applyCommit')
  }
  if (typeof TXN.withPackTransaction !== 'function' || typeof TXN.recoverPack !== 'function') {
    throw new Blocked('ledger-transaction.cjs 的既有导出（withPackTransaction / recoverPack）不见了 —— 接口锁破了')
  }
  return { C, TXN }
}

/* ── 临时目录（绝对路径 + 归属核对都走 runner 的守卫） ───────────────────── */

function resetRunTmp() {
  const g = guardTempPath(RUN_TMP, { parent: TEMP_ROOT })
  if (!g.ok) throw new Blocked(`临时目录守卫拒绝：${g.error}`)
  if (!path.isAbsolute(RUN_TMP) || !RUN_TMP.startsWith(`${TEMP_ROOT}${path.sep}`)) {
    throw new Blocked(`临时目录不是 TEMP_ROOT 下的绝对子目录：${RUN_TMP}`)
  }
  fs.mkdirSync(TEMP_ROOT, { recursive: true })
  fs.rmSync(RUN_TMP, { recursive: true, force: true })
  fs.mkdirSync(RUN_TMP, { recursive: true })
  return RUN_TMP
}

function tempDir(name) {
  const abs = path.join(RUN_TMP, name)
  const g = guardTempPath(abs, { parent: RUN_TMP })
  if (!g.ok) throw new Error(`临时子目录守卫拒绝：${g.error}`)
  fs.rmSync(abs, { recursive: true, force: true })
  fs.mkdirSync(abs, { recursive: true })
  return abs
}

function dropTempDir(name) {
  const abs = path.join(RUN_TMP, name)
  const r = safeRemoveTree(abs, { parent: RUN_TMP })
  if (!r.removed) throw new Error(`临时子目录清理失败：${r.error}`)
  return abs
}

/** 造一个最小课程包：只有一个台账文件（够判提交协议，不塞私人正文）。 */
function pack(name, { ledger = 'a\n', extra = null } = {}) {
  const root = tempDir(name)
  const ledgerAbs = path.join(root, 'ledger.jsonl')
  if (ledger !== null) fs.writeFileSync(ledgerAbs, ledger, 'utf8')
  if (extra) for (const [rel, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text, 'utf8')
  }
  return { root, ledger: ledgerAbs }
}

/* ── build 策略（与事务件的 build 同一形状：同步、只算不写） ─────────────── */

const appendBuild = (line) => ({ files }) => [{ rel: 'ledger.jsonl', content: `${(files && files['ledger.jsonl']) || ''}${line}\n` }]

const MULTI_BUILD = ({ files }) => ({
  operation: 'compact',
  value: { kept: 1 },
  files: [
    { rel: 'z.txt', content: 'zzz' },
    { rel: 'ledger.jsonl', remove: true },
    { rel: 'a.txt', content: 'aaa' },
    { rel: 'z.txt', content: 'zzz2' },
  ],
})

/* ── 注入式 fs（全部是**产品真缝**上的替身，不是"桩脚本写标记"） ────────── */

const isLedgerTarget = (p) => String(p).split(path.sep).join('/').endsWith('/ledger.jsonl')

/** 落位/回滚在 ledger 上失败：`always:true` ⇒ 回滚也失败 ⇒ recovery-required */
function faultFs({ always = false, times = 1 } = {}) {
  let left = always ? Infinity : times
  return {
    ...fs,
    renameSync: (a, b) => {
      if (isLedgerTarget(b) && left > 0) {
        if (left !== Infinity) left -= 1
        const e = new Error('injected EACCES at rename'); e.code = 'EACCES'; throw e
      }
      return fs.renameSync(a, b)
    },
  }
}

/** 观察 journal 每次落盘的**真实内容**（schema / state / 键集），不改行为 */
function journalWatchFs(sink) {
  return {
    ...fs,
    renameSync: (a, b) => {
      if (String(b).endsWith('journal.json')) {
        try {
          const text = fs.readFileSync(a, 'utf8')
          const doc = JSON.parse(text)
          sink.push({ state: doc.state, keys: Object.keys(doc), fileKeys: Array.isArray(doc.files) && doc.files[0] ? Object.keys(doc.files[0]) : [], text })
        } catch { sink.push({ state: null, keys: [], fileKeys: [], text: '' }) }
      }
      return fs.renameSync(a, b)
    },
  }
}

/** 观察"闸三复核那一刻锁在不在"（锁内 vs 锁外，靠它证明） */
function lockProbeFs(lockPath, state) {
  return {
    ...fs,
    readFileSync: (p, o) => {
      if (state.armed && isLedgerTarget(p)) state.observed.push({ at: 'gate3-read', lockHeld: fs.existsSync(lockPath) })
      return fs.readFileSync(p, o)
    },
  }
}

/** 计数探针：数"提交调用次数"（A02 的零调用就靠它） */
function countingTxn(TXN) {
  const counter = { calls: 0, builds: 0 }
  const wrapped = {
    ...TXN,
    withPackTransaction: (...args) => {
      counter.calls += 1
      return TXN.withPackTransaction(...args)
    },
  }
  return { txn: wrapped, counter }
}

/* ── 读盘小工具 ─────────────────────────────────────────────────────── */

const txnDirs = (root) => {
  const dir = path.join(root, '.whale-txn')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort()
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const lockExists = (root) => fs.existsSync(path.join(root, '.whale-write.lock'))
const journalOf = (root, id) => {
  const p = path.join(root, '.whale-txn', id, 'journal.json')
  return fs.existsSync(p) ? readJson(p) : null
}
/** 某目录里第一个残骸的 journal（没有就 null） */
function firstJournal(root) {
  const dirs = txnDirs(root).filter((n) => fs.existsSync(path.join(root, '.whale-txn', n, 'journal.json')))
  return dirs.length ? { id: dirs[0], dir: path.join(root, '.whale-txn', dirs[0]), doc: journalOf(root, dirs[0]) } : null
}

function gitShow(rel) {
  const r = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`git show HEAD:${rel} 退出码 ${r.status}`)
  return String(r.stdout ?? '')
}
function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  return String(r.stdout ?? '').trim()
}
/** `git status --porcelain` 的行（共享工作树里别的 lane 的合法改动只登记，不归因本卡） */
function gitStatus() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`git status 退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}`)
  return String(r.stdout ?? '').split('\n').filter(Boolean)
}
/** head 的每一行都能按顺序在 cur 里找到（= 纯插入，既有行一个都没改/删） */
function isLineSubsequence(headText, curText) {
  const head = headText.split('\n')
  let i = 0
  for (const line of curText.split('\n')) if (i < head.length && line === head[i]) i += 1
  return i === head.length
}

/* ══════════════════════════════════════════════════════════════════════
 * 运行期自锚 + 归属：判据内核（A08 用它判，`--anchor-self-proof` 用它自证）
 * ⚠️ 全是纯函数 / 纯读盘，**不**知道 A08 的上下文 —— 这样自证的样本与真判的是同一份代码。
 * ══════════════════════════════════════════════════════════════════════ */

/** 统一成仓根相对的 posix 路径（绝对路径按 REPO 折算；大小写不折叠，Windows 由调用方对齐） */
function normRel(p) {
  const s = String(p ?? '')
  if (!s) return ''
  const rel = path.isAbsolute(s) ? path.relative(REPO, s) : s
  return rel.split(path.sep).join('/').replace(/^\.\//, '')
}

/** 单个锚点的当前快照（字节数 + 原始字节 sha256） */
function readAnchor(rel) {
  const buf = fs.readFileSync(path.join(REPO, rel))
  return { bytes: buf.length, sha256: sha256(buf) }
}

/** 七件锚点的当前快照（键 = 相对仓根路径） */
function snapshotAnchors() {
  const out = {}
  for (const spec of ANCHOR_SPECS) out[spec.rel] = readAnchor(spec.rel)
  return out
}

/** 回执里 writeSet 的 { 路径 → 登记项 }（只收记了 sha256 的那些） */
function receiptWriteSet(receipt) {
  const map = new Map()
  for (const e of (receipt && Array.isArray(receipt.writeSet) ? receipt.writeSet : [])) {
    if (e && typeof e.path === 'string' && typeof e.sha256 === 'string') map.set(normRel(e.path), e)
  }
  return map
}

/**
 * 把「开跑快照 + 收口快照 + 各卡回执登记值」拼成分类器的输入行。
 * `recorded` 一律**从回执动态取**（U01 记的是字节数，U03/U06 记的是 sha256），不把数值烤进源码。
 */
function anchorRows(boot, end, receipts) {
  const u01 = (receipts && receipts.U01 && receipts.U01.interfaceConsumption) || {}
  const u03Set = receiptWriteSet(receipts && receipts.U03)
  const u06Set = receiptWriteSet(receipts && receipts.U06)
  const bytesRecord = (card, field, value, source) => (
    typeof value === 'number' && Number.isFinite(value) ? { card, field, kind: 'bytes', value, source } : null
  )
  return ANCHOR_SPECS.map((spec) => {
    const b = boot[spec.rel]
    const e = end[spec.rel]
    let recorded = null
    if (spec.rel === 'docs/unify/interfaces.md') {
      recorded = bytesRecord('U01', 'interfaceConsumption.lockBytes', u01.lockBytes, 'docs/unify/receipts/U01.json')
    } else if (spec.rel === 'docs/unify/baseline.json') {
      recorded = bytesRecord('U01', 'interfaceConsumption.baselineBytes', u01.baselineBytes, 'docs/unify/receipts/U01.json')
    } else {
      const hit = (spec.owner === 'U03' ? u03Set : u06Set).get(spec.rel)
      if (hit) {
        recorded = {
          card: spec.owner, field: 'writeSet.sha256', kind: 'sha256', value: hit.sha256,
          source: `docs/unify/receipts/${spec.owner}.json`,
        }
      }
    }
    return {
      rel: spec.rel, owner: spec.owner, role: spec.role, why: spec.why,
      boot: b ? b.sha256 : null, end: e ? e.sha256 : null, bytes: e ? e.bytes : null,
      recorded,
    }
  })
}

/**
 * 锚点分类器（**纯函数**）。
 *
 * 输入 `{ anchors, writes, foreign }`：
 *   anchors —— [{ rel, owner, role, boot, end, bytes, recorded? }]（recorded 见 anchorRows）
 *   writes  —— 本进程本次运行真的写过的目标 [{ rel } | { path }]
 *   foreign —— 别的卡的合法产物（只登记，**绝不**判）
 *
 * 判据（逐条可归因；红 = ``violations`` 里出现该 rel）：
 *   ① 运行期自锚：`boot === end` 必须成立 —— 本次运行一个字都没写它。
 *   ② 本进程写守卫：非交付物（写权不归本卡）只要本进程写过就红 —— 字节相同也红。
 *   ③ 交付物内容锁：`role === 'deliverable'` 必须仍等于登记字节 —— 这就是"我写下的字节"。
 *   ④ 跨卡登记值漂移（非交付物）：只标 `attributed-drift` + 归属到 §6 的卡，**不**红。
 *      —— 合法账本同步（interfaces.md 的 U01 写权）必须可归因，不能把别的卡钉死在本卡的开跑时刻。
 */
function classifyAnchors({ anchors, writes = [], foreign = [] }) {
  const written = new Set((Array.isArray(writes) ? writes : []).map((w) => normRel(w && (w.rel ?? w.path))))
  const rows = []
  const violations = []
  for (const a of (Array.isArray(anchors) ? anchors : [])) {
    const rel = normRel(a.rel)
    const stable = a.boot === a.end
    const wroteDuringRun = written.has(rel)
    const matches = a.recorded
      ? (a.recorded.kind === 'bytes' ? a.bytes === a.recorded.value : a.end === a.recorded.value)
      : null
    const kinds = []
    if (!stable) kinds.push('run-time-write')
    else if (a.role !== 'deliverable' && wroteDuringRun) kinds.push('process-write')
    if (a.role === 'deliverable' && matches === false) kinds.push('content-lock')
    const state = kinds.length ? kinds[0] : (matches === false ? 'attributed-drift' : 'locked')
    rows.push({
      rel, owner: a.owner, role: a.role, boot: a.boot, end: a.end, bytes: a.bytes,
      recorded: a.recorded ?? null, matchesRecorded: matches, stable, wroteDuringRun, state, violationKinds: kinds,
    })
    for (const kind of kinds) violations.push({ rel, kind, owner: a.owner, boot: a.boot, end: a.end })
  }
  const anchored = new Set(rows.map((r) => r.rel))
  const foreignRels = (Array.isArray(foreign) ? foreign : []).map(normRel)
  return { rows, violations, foreign: foreignRels, ignoredForeign: foreignRels.filter((r) => !anchored.has(r)) }
}

/** 写守卫的允许面匹配器（写集文件 + 允许根） */
function allowedMatcher(allowed) {
  const exact = ((allowed && allowed.exact) || []).map((x) => path.resolve(x).toLowerCase())
  const roots = ((allowed && allowed.roots) || []).filter(Boolean).map((x) => path.resolve(x).toLowerCase())
  return (abs) => {
    const p = path.resolve(String(abs)).toLowerCase()
    if (exact.some((x) => x === p)) return true
    return roots.some((r) => p === r || p.startsWith(`${r}${path.sep.toLowerCase()}`))
  }
}

/** 写守卫分类器（**纯函数**）：返回写到允许面之外的条目 */
function writeViolations(entries, allowed) {
  const inAllowed = allowedMatcher(allowed)
  return (Array.isArray(entries) ? entries : []).filter((e) => !inAllowed(e && e.path))
}

/** 本卡回执的内容锁：writeSet 里记了 sha256 的每一条都必须仍等于盘上的字节 */
function verifyReceiptContentLocks(receipt) {
  const rows = []
  const violations = []
  for (const e of (receipt && Array.isArray(receipt.writeSet) ? receipt.writeSet : [])) {
    if (!e || typeof e.path !== 'string') continue
    const abs = path.join(REPO, e.path)
    if (typeof e.sha256 !== 'string') {
      rows.push({ path: e.path, kind: e.kind ?? null, locked: false, note: '回执没记摘要（自指/未登记），内容锁跳过' })
      continue
    }
    const buf = fs.readFileSync(abs)
    const sha = sha256(buf)
    const okSha = sha === e.sha256 && (typeof e.bytes === 'number' ? buf.length === e.bytes : true)
    rows.push({
      path: e.path, kind: e.kind ?? null, locked: true, bytes: buf.length, sha256: sha,
      lockedBytes: typeof e.bytes === 'number' ? e.bytes : null, lockedSha256: e.sha256, ok: okSha,
    })
    if (!okSha) {
      violations.push({
        path: e.path, actualBytes: buf.length, actualSha256: sha,
        lockedBytes: typeof e.bytes === 'number' ? e.bytes : null, lockedSha256: e.sha256,
      })
    }
  }
  return { rows, violations }
}

/** 从 interfaces.md §6 的写集表里**解析**某个落点归哪张卡（表里没写 / 写了多处同样算问题） */
function section6OwnerOf(ifaceText, rel) {
  const hits = []
  for (const line of String(ifaceText ?? '').split('\n')) {
    const m = /^\|\s*(U\d+)\s*\|/.exec(line)
    if (!m) continue
    if (line.includes(rel)) hits.push(m[1])
  }
  return hits.length === 1 ? hits[0] : `AMBIGUOUS(${hits.join(',') || 'none'})`
}

/**
 * interfaces.md 的**合法更新出处**（U01 回执里的账本同步 delta）。
 * 只认 U01 自己登记过、且 `files` 里点名 interfaces.md 的那些 —— 出处可逐条复核，不靠注释自说自话。
 */
function collectLedgerSyncDeltas(u01Receipt) {
  const deltas = (u01Receipt && u01Receipt.deltas) || {}
  const picks = [deltas.authorizedWriteSetLedgerSync, deltas.authorizedWriteSetLedgerSyncU10].filter(Boolean)
  return picks.map((d) => {
    const files = Array.isArray(d.files) ? d.files : []
    const landings = []
    for (const line of [d.what, d.why].filter(Boolean)) {
      for (const m of String(line).matchAll(/✅\s*([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g)) landings.push(m[1])
    }
    return {
      id: d.id ?? null,
      kind: d.kind ?? null,
      touchesInterfaceLock: files.some((f) => String(f).includes('interfaces.md')),
      landings: [...new Set(landings)],
      files: files.map(String),
    }
  })
}

/**
 * 本卡**开跑那一刻**七件依赖的快照 —— A08 的"运行期自锚"基准。
 * 只做本运行内的一致性（boot === end）；与别的卡的登记值不同**只登记 + 归属**，不判红。
 */
const BOOT_ANCHORS = Object.freeze(snapshotAnchors())

/* ══════════════════════════════════════════════════════════════════════
 * 反空转自证：3 红 + 2 绿（`--anchor-self-proof`；A08 会起子进程跑这一份）
 * ⚠️ 样本是**纯数据**，与真实树无关 —— 它证明的是"分类器会红/会绿"，不是"树正好绿"。
 * ══════════════════════════════════════════════════════════════════════ */

const FAKE_SHA = (ch) => String(ch).repeat(64)

/** 七件锚点的"全部锁定"基线样本 */
function lockedSampleAnchors() {
  return ANCHOR_SPECS.map((spec, i) => {
    const sha = FAKE_SHA(String.fromCharCode(97 + i))
    return {
      rel: spec.rel, owner: spec.owner, role: spec.role,
      boot: sha, end: sha, bytes: 1000 + i,
      recorded: { card: spec.owner, field: 'sample.sha256', kind: 'sha256', value: sha, source: 'sample' },
    }
  })
}

/** 别的卡的合法产物（U04/U10/U14/U18 的交付物）—— 存在也不该进本卡的锚点集 */
const OTHER_CARD_ARTIFACTS = Object.freeze([
  'lib/unify/text.cjs',
  'lib/unify/stage.cjs',
  'lib/unify/records.cjs',
  'lib/unify/evidence.cjs',
  'test/audit/U18.mjs',
])

/**
 * 五个样本：3 红（运行期写 interfaces.md / 运行期改写本卡交付物 commit.cjs / 写野路径 lib/whatever.js）
 *          + 2 绿（interfaces.md 在运行期外被 U01 合法同步 → 归属 U01；别的卡合法产物存在 → 不红）
 */
function anchorSelfProofSamples() {
  const IFACE = 'docs/unify/interfaces.md'
  const COMMIT = 'lib/unify/commit.cjs'
  const base = lockedSampleAnchors()
  const withPatch = (rel, patch) => base.map((r) => (r.rel === rel ? { ...r, ...patch } : { ...r }))
  const allowed = {
    exact: WRITE_SET.map((rel) => path.join(REPO, rel)),
    // ⚠️ 这里不引用 CARD_EV（它在本文件后面才初始化）：同一个值，直接按形状拼。
    roots: [RUN_TMP, path.join(REPO, 'audit-evidence', CARD)],
  }
  return [
    {
      id: 'R1-iface-written-during-run', expect: 'red', kind: 'anchors',
      why: 'docs/unify/interfaces.md 在本次运行期被写（boot≠end）——（接口锁归 U01，本卡写权为零）',
      input: { anchors: withPatch(IFACE, { end: FAKE_SHA('z'), bytes: 9999 }), writes: [{ rel: IFACE }] },
      want: [{ rel: IFACE, kinds: ['run-time-write'] }],
    },
    {
      id: 'R2-own-deliverable-rewritten', expect: 'red', kind: 'anchors',
      why: '本卡交付物 lib/unify/commit.cjs 在运行期被改成不是回执登记的字节（运行期写 + 内容锁双重红）',
      input: { anchors: withPatch(COMMIT, { end: FAKE_SHA('y'), bytes: 1 }), writes: [{ rel: COMMIT }] },
      want: [{ rel: COMMIT, kinds: ['run-time-write', 'content-lock'] }],
    },
    {
      id: 'R3-wild-path-write', expect: 'red', kind: 'writes',
      why: '写野路径 lib/whatever.js（不在写集、不在证据根、不在本卡临时根）',
      input: { entries: [{ op: 'writeFileSync', path: path.join(REPO, 'lib', 'whatever.js') }], allowed },
      wantViolations: 1, wantPath: 'lib/whatever.js',
    },
    {
      id: 'G1-iface-drift-attributed-U01', expect: 'green', kind: 'anchors',
      why: 'interfaces.md 在**运行期外**被 U01 合法同步过（boot=end，但与旧登记值不同）：只登记 + 归属 U01，不红',
      input: {
        anchors: withPatch(IFACE, { recorded: { card: 'U01', field: 'sample.stale', kind: 'sha256', value: FAKE_SHA('q'), source: 'sample' } }),
        writes: [],
      },
      want: [],
      wantRow: { rel: IFACE, state: 'attributed-drift', owner: 'U01' },
    },
    {
      id: 'G2-foreign-artifacts-present', expect: 'green', kind: 'anchors',
      why: '别的卡的合法产物存在（U04/U10/U14/U18）→ 不进本卡锚点集、不红（本卡不要求整棵树停在某个 sha）',
      input: { anchors: base, writes: [], foreign: OTHER_CARD_ARTIFACTS.slice() },
      want: [],
    },
  ]
}

/** 跑五个样本，逐条判「期望红/绿」是否真的兑现（这一份就是判据本身的对照组） */
function runAnchorSelfProof() {
  const results = []
  for (const s of anchorSelfProofSamples()) {
    const problems = []
    let violations = []
    let rows = []
    let ignoredForeign = []
    if (s.kind === 'anchors') {
      const r = classifyAnchors(s.input)
      violations = r.violations
      rows = r.rows
      ignoredForeign = r.ignoredForeign
      if (s.expect === 'green' && rows.length !== s.input.anchors.length) problems.push(`分类器没判完所有锚点（${rows.length}/${s.input.anchors.length}）`)
      if (s.expect === 'green' && Array.isArray(s.input.foreign)
        && ignoredForeign.length !== s.input.foreign.length) problems.push(`别的卡的产物被拉进锚点集：${JSON.stringify(rows.filter((x) => !ANCHOR_SPECS.some((y) => y.rel === x.rel)).map((x) => x.rel))}`)
    } else {
      violations = writeViolations(s.input.entries, s.input.allowed)
    }
    if (s.expect === 'red') {
      if (!violations.length) problems.push('期望红，判据却放行（空转）')
      for (const w of (s.want || [])) {
        const hits = violations.filter((v) => normRel(v.rel ?? v.path) === normRel(w.rel))
        if (!hits.length) problems.push(`没点名 ${w.rel}`)
        else for (const kind of (w.kinds || [])) {
          const seen = hits.flatMap((h) => (Array.isArray(h.kind) ? h.kind : [h.kind]))
          if (!seen.includes(kind)) problems.push(`${w.rel} 缺红型 ${kind}（实得 ${JSON.stringify(seen)}）`)
        }
      }
      if (typeof s.wantViolations === 'number' && violations.length !== s.wantViolations) {
        problems.push(`红条数应为 ${s.wantViolations}（实得 ${violations.length}）`)
      }
      if (s.wantPath && !violations.some((v) => normRel(v.path) === s.wantPath)) problems.push(`没点名野路径 ${s.wantPath}`)
    } else {
      if (violations.length) problems.push(`期望绿，判据却红：${JSON.stringify(violations.slice(0, 3))}`)
      if (s.kind === 'anchors' && s.wantRow) {
        // 绿不是"没扫到"：必须被看见、被判成 attributed-drift，且归属到 §6 的那张卡
        const row = rows.find((x) => normRel(x.rel) === normRel(s.wantRow.rel))
        if (!row) problems.push(`绿样本没被判到（${s.wantRow.rel} 不在分类结果里）`)
        else {
          if (row.state !== s.wantRow.state) problems.push(`${s.wantRow.rel} 的判定应为 ${s.wantRow.state}（实得 ${row.state}）`)
          if (row.owner !== s.wantRow.owner) problems.push(`${s.wantRow.rel} 的归属应为 ${s.wantRow.owner}（实得 ${row.owner}）`)
        }
      }
    }
    results.push({
      id: s.id, expect: s.expect, kind: s.kind, why: s.why,
      ok: problems.length === 0, problems,
      observed: {
        violations, ignoredForeign,
        rows: rows.map((x) => ({ rel: x.rel, owner: x.owner, state: x.state, matchesRecorded: x.matchesRecorded })),
      },
    })
  }
  const red = results.filter((r) => r.expect === 'red')
  const green = results.filter((r) => r.expect === 'green')
  return {
    ok: results.every((r) => r.ok),
    samples: results.length,
    red: red.length,
    green: green.length,
    results,
  }
}

/** `--anchor-self-proof` 子进程模式：只打判词与样本行，不跑任何用例、不写任何文件 */
function maybeRunAnchorSelfProof() {
  if (!ARGV.includes('--anchor-self-proof')) return false
  const proof = runAnchorSelfProof()
  for (const r of proof.results) {
    const actual = r.ok ? r.expect : (r.expect === 'red' ? 'green' : 'red')
    process.stdout.write(`SAMPLE ${r.id} expect=${r.expect} actual=${actual} ${r.ok ? 'OK' : 'FAIL'}\n`)
    if (!r.ok) process.stdout.write(`  problems: ${r.problems.join(' | ')}\n`)
  }
  process.stdout.write(proof.ok
    ? `ANCHOR-SELF-PROOF OK samples=${proof.samples} red=${proof.red} green=${proof.green}\n`
    : `ANCHOR-SELF-PROOF FAIL samples=${proof.samples} red=${proof.red} green=${proof.green}\n`)
  process.exit(proof.ok ? 0 : 1)
}


/* ══════════════════════════════════════════════════════════════════════
 * 子进程模式：A07 的判据内核（干净副本 / 变异副本各跑一次）
 * ⚠️ 必须放在顶层常量之后：子进程里这段要用到 COMMIT/ERRORS/TXN 的路径常量
 * ══════════════════════════════════════════════════════════════════════ */

function maybeRunContract() {
  const hit = ARGV.find((a) => a.startsWith('--commit-contract='))
  if (!hit) return false
  const dir = path.resolve(hit.slice('--commit-contract='.length))
  try {
    commitContract(dir)
    process.stdout.write('COMMIT-CONTRACT OK\n')
    process.exit(0)
  } catch (e) {
    process.stdout.write(`COMMIT-CONTRACT FAIL ${e?.message ?? e}\n`)
    process.exit(1)
  }
  return true
}

/**
 * A07 的判据内核（对**给定目录里的模块副本**跑；不写证据目录）。
 * 覆盖四件事：正常提交 / 确认闸拒绝 / 锁内摘要闸拒绝 / 恢复失败如实上报。
 */
function commitContract(dir) {
  const C = requireCJS(path.join(dir, 'lib', 'unify', 'commit.cjs'))
  const packRoot = path.join(dir, 'pack')
  fs.mkdirSync(packRoot, { recursive: true })
  const ledger = path.join(packRoot, 'ledger.jsonl')
  fs.writeFileSync(ledger, 'a\n', 'utf8')
  const build = appendBuild('b')

  // ① 正常提交：committed 且字节真的落位
  const p1 = C.planCommit(packRoot, build)
  if (!p1.ok) throw new Error(`planCommit 失败：${p1.error}`)
  const r1 = C.applyCommit(packRoot, p1.plan, { confirm: true, planDigest: p1.plan.planDigest, build })
  if (r1.ok !== true || r1.state !== 'committed') throw new Error(`正常提交没有 committed（state=${r1.state} code=${r1.code}）`)
  if (fs.readFileSync(ledger, 'utf8') !== 'a\nb\n') throw new Error('正常提交没有真的写出字节')

  // ② 闸二：没有显式确认 → 必须 CONFIRM_REQUIRED，且事务一次都不许调用
  const p2 = C.planCommit(packRoot, build)
  if (!p2.ok) throw new Error(`第二次 planCommit 失败：${p2.error}`)
  let calls = 0
  const probe = { withPackTransaction: () => { calls += 1; throw new Error('确认闸之后才许调用事务') } }
  const g2 = C.applyCommit(packRoot, p2.plan, { build, transaction: probe })
  if (g2.ok !== false) throw new Error('没有确认竟然提交成功了')
  if (g2.code !== 'CONFIRM_REQUIRED') throw new Error(`确认闸没有拒绝成 CONFIRM_REQUIRED（实得 code=${g2.code} / state=${g2.state}）`)
  if (calls !== 0) throw new Error(`前置拒绝竟然调用了事务 ${calls} 次`)

  // ③ 闸三（锁内）：计划之后改目标 → PLAN_STALE，且旧计划不许覆盖新内容
  fs.writeFileSync(ledger, 'NEW\n', 'utf8')
  const g3 = C.applyCommit(packRoot, p2.plan, { confirm: true, planDigest: p2.plan.planDigest, build })
  if (g3.ok !== false || g3.code !== 'PLAN_STALE') {
    throw new Error(`锁内摘要闸没有拒绝成 PLAN_STALE（实得 ok=${g3.ok} code=${g3.code} state=${g3.state}）`)
  }
  if (fs.readFileSync(ledger, 'utf8') !== 'NEW\n') throw new Error('旧计划覆盖了计划生成之后写进去的新内容')

  // ④ 恢复失败 → recovery-required（材料保留、绝不宣称成功）
  fs.writeFileSync(ledger, 'a\n', 'utf8')
  const p4 = C.planCommit(packRoot, build)
  if (!p4.ok) throw new Error(`第四次 planCommit 失败：${p4.error}`)
  const rec = C.applyCommit(packRoot, p4.plan, { confirm: true, planDigest: p4.plan.planDigest, build, fs: faultFs({ always: true }) })
  if (rec.ok !== false) throw new Error('恢复失败竟然报了成功（本该 recovery-required）')
  if (rec.state !== 'recovery-required') throw new Error(`恢复失败没有报 recovery-required（实得 state=${rec.state} code=${rec.code}）`)
  if (!txnDirs(packRoot).length) throw new Error('恢复失败却没有留下待恢复材料')
  return true
}

maybeRunContract()
maybeRunAnchorSelfProof()

/* ── 证据根：默认本卡新运行目录；--evidence-root= 只换落点，不换判据 ─────── */
const ROOTS = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
const EV = ROOTS.ok ? ROOTS.root : null
const CARD_EV = path.join(REPO, 'audit-evidence', CARD)
fs.mkdirSync(CARD_EV, { recursive: true })

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 三闸分别可拒绝（计划 / 确认 / 真实字节摘要）
 * ══════════════════════════════════════════════════════════════════════ */
async function A01() {
  resetRunTmp()
  const { C, TXN } = loadMods()
  const iface = fs.readFileSync(IFACE_FILE, 'utf8')

  const { root } = pack('gates')
  const build = appendBuild('b')
  const planned = C.planCommit(root, build)
  ok(planned.ok === true, `planCommit 失败：${planned.error}`)
  const plan = planned.plan

  // 计划的形状：schema / root / operation / files（排序去重、只记摘要）/ planDigest
  eq(plan.schema, 'whale-commit/1', '计划 schema 必须是 whale-commit/1')
  eq(plan.root, path.resolve(root), '计划的 root 必须是解析后的绝对路径')
  eq(typeof plan.operation, 'string', '计划必须有 operation')
  eqJson(Object.keys(plan), ['schema', 'root', 'operation', 'files', 'planDigest'], '计划的键集固定')
  eqJson(Object.keys(plan.files[0]).sort(), ['beforeDigest', 'bytes', 'digest', 'rel', 'remove'], 'files 每条只记摘要/字节数，不落正文')
  ok(!('content' in plan.files[0]), '计划里不许出现内容正文（只记摘要）')
  ok(/^[0-9a-f]{64}$/.test(plan.planDigest), 'planDigest 必须是 hex64')
  eq(C.planDigestOf(plan), plan.planDigest, 'planDigest 必须可由计划内容复算（改一个字节就变）')

  const codes = []
  const probeOf = () => countingTxn(TXN)

  // ── 闸一：五种无效计划各拒一次（码 PLAN_REQUIRED / kind input）；transaction 零调用
  const tamper = (patch) => {
    const cand = { ...plan, ...patch }
    if (patch.files) cand.planDigest = ''
    if (patch.files) cand.planDigest = C.planDigestOf(cand)
    return cand
  }
  const badPlans = [
    ['schema 被改成别的协议', tamper({ schema: 'whale-commit/2' })],
    ['root 与本次提交的包根不符', tamper({ root: path.join(RUN_TMP, 'other-pack') })],
    ['operation 是空白', tamper({ operation: '   ' })],
    ['planDigest 被改过（计划自己都不自洽）', { ...plan, planDigest: 'f'.repeat(64) }],
    ['落点跑出包根', tamper({ files: [{ ...plan.files[0], rel: '../escape.jsonl' }] })],
    ['files 没有排序', tamper({ files: [...plan.files, { ...plan.files[0], rel: 'a.txt' }] })],
    ['files 出现未知键（被塞了正文？）', tamper({ files: [{ ...plan.files[0], content: 'PRIVATE BODY' }] })],
  ]
  for (const [label, bad] of badPlans) {
    const probe = probeOf()
    const r = C.applyCommit(root, bad, { confirm: true, planDigest: bad.planDigest, build, transaction: probe.txn })
    eq(r.ok, false, `[闸一] ${label} 必须被拒`)
    eq(r.state, 'rejected', `[闸一] ${label} → state=rejected`)
    eq(r.code, GATE_CODES.plan, `[闸一] ${label} → code=${GATE_CODES.plan}（实得 ${r.code}）`)
    eq(r.failure.kind, 'input', `[闸一] ${label} → failure.kind=input`)
    eq(r.failure.code, GATE_CODES.plan, `[闸一] ${label} → failure.code=${GATE_CODES.plan}`)
    ok(typeof r.failure.error === 'string' && r.failure.error.length > 0, `[闸一] ${label} → failure 必须带话`)
    eq(probe.counter.calls, 0, `[闸一] ${label} 是前置拒绝：提交调用必须是 0（实得 ${probe.counter.calls}）`)
    codes.push({ gate: 'plan', label, code: r.code, state: r.state, kind: r.failure.kind, calls: probe.counter.calls })
  }
  eqJson(C.COMMIT_GATES, ['plan', 'confirm', 'bytes'], '三闸的固定顺序（plan → confirm → bytes）')

  // ── 闸二：确认缺失 / 不是字面 true / planDigest 回引不符
  for (const [label, opts] of [
    ['完全没给 confirm', { build }],
    ['confirm 不是字面 true（"yes"）', { confirm: 'yes', planDigest: plan.planDigest, build }],
    ['confirm 是 1', { confirm: 1, planDigest: plan.planDigest, build }],
  ]) {
    const probe = probeOf()
    const r = C.applyCommit(root, plan, { ...opts, transaction: probe.txn })
    eq(r.ok, false, `[闸二] ${label} 必须被拒`)
    eq(r.state, 'rejected', `[闸二] ${label} → state=rejected`)
    eq(r.code, GATE_CODES.confirm, `[闸二] ${label} → code=${GATE_CODES.confirm}（实得 ${r.code}）`)
    eq(r.failure.kind, 'confirmation', `[闸二] ${label} → failure.kind=confirmation`)
    eq(probe.counter.calls, 0, `[闸二] ${label} 是前置拒绝：提交调用必须是 0`)
    codes.push({ gate: 'confirm', label, code: r.code, state: r.state, kind: r.failure.kind, calls: probe.counter.calls })
  }
  {
    const probe = probeOf()
    const r = C.applyCommit(root, plan, { confirm: true, planDigest: '0'.repeat(64), build, transaction: probe.txn })
    eq(r.ok, false, '[闸二] planDigest 回引不符必须被拒')
    eq(r.code, GATE_CODES.bytes, '[闸二] planDigest 回引不符 → PLAN_STALE（确认的不是这份计划）')
    eq(r.failure.kind, 'conflict', '[闸二] 回引不符 → failure.kind=conflict')
    eq(probe.counter.calls, 0, '[闸二] 回引不符是前置拒绝：提交调用必须是 0')
    codes.push({ gate: 'confirm', label: 'planDigest 回引不符', code: r.code, state: r.state, kind: r.failure.kind, calls: probe.counter.calls })
  }

  // ── 闸三：真实字节摘要（锁内）——目标在计划之后被改过
  fs.writeFileSync(path.join(root, 'ledger.jsonl'), 'changed\n', 'utf8')
  {
    const probe = probeOf()
    const r = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build, transaction: probe.txn })
    eq(r.ok, false, '[闸三] 目标被改过必须被拒')
    eq(r.state, 'rejected', '[闸三] → state=rejected')
    eq(r.code, GATE_CODES.bytes, `[闸三] → code=${GATE_CODES.bytes}（实得 ${r.code}）`)
    eq(r.failure.kind, 'conflict', '[闸三] → failure.kind=conflict')
    eq(r.failure.file, 'ledger.jsonl', '[闸三] failure.file 必须指到被改的落点')
    eq(r.rollbackError, null, '[闸三] 锁内拒绝发生在任何写入之前，不该有回滚错误')
    eq(fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8'), 'changed\n', '[闸三] 被拒后目标保持"新内容"，旧计划没覆盖')
    eq(probe.counter.calls, 1, '[闸三] 锁内复核必须真的进事务（它只能在锁里做）')
    codes.push({ gate: 'bytes', label: '计划后改目标', code: r.code, state: r.state, kind: r.failure.kind, calls: probe.counter.calls })
  }

  // ── 闸序：闸一先于闸二，闸二先于闸三（不是"随便哪一闸先报"）
  {
    const probe = probeOf()
    const r1 = C.applyCommit(root, { ...plan, schema: 'nope' }, { build, transaction: probe.txn })
    eq(r1.code, GATE_CODES.plan, '闸序①：计划无效 + 没有确认 → 必须报计划闸（不是确认闸）')
    const r2 = C.applyCommit(root, plan, { build, transaction: probe.txn })
    eq(r2.code, GATE_CODES.confirm, '闸序②：目标已被改过 + 没有确认 → 必须报确认闸（不是摘要闸）')
    eq(probe.counter.calls, 0, '闸序①②都在前置：提交调用必须是 0')
  }

  // ── 三闸码都是 U01 的**真实码值**（不凭空编码）+ 新码只在 lib/unify 落地
  for (const code of [GATE_CODES.plan, GATE_CODES.confirm, GATE_CODES.bytes, ...NEW_CODES]) {
    ok(iface.includes(code), `码值 ${code} 不在 U01 锁定的真实码表里（不许凭空编码）`)
  }
  const C_ = C
  eqJson(C_.STATE_CODES.busy, 'LOCK_BUSY', 'busy 的码是 U-SPEC 拟新增码 LOCK_BUSY')
  eqJson(C_.STATE_CODES['recovery-required'], 'RECOVERY_REQUIRED', '待恢复的码是 U-SPEC 拟新增码 RECOVERY_REQUIRED')

  // ── build 不许写权威目标（交给它的是只读 fs 视图）
  {
    const d = pack('build-write')
    const sneaky = C.planCommit(d.root, ({ fs: io }) => {
      io.writeFileSync(path.join(d.root, 'evil.txt'), 'x')
      return [{ rel: 'ledger.jsonl', content: 'x\n' }]
    })
    eq(sneaky.ok, false, 'build 尝试写盘必须当场被拒')
    eq(sneaky.code, GATE_CODES.plan, 'build 写盘 → 计划闸拒绝（PLAN_REQUIRED）')
    ok(/不许写盘/.test(sneaky.error), `拒绝理由要说清"不许写盘"：${sneaky.error}`)
    eq(fs.existsSync(path.join(d.root, 'evil.txt')), false, 'build 的写尝试不许真的落盘')
  }

  // 计划/摘要的确定性：同一输入两次 → 逐字节同计划
  const a1 = C.planCommit(pack('det-1').root, build)
  const a2 = C.planCommit(pack('det-2').root, build)
  ok(a1.ok && a2.ok, '确定性对照的两个计划都必须成功')
  ok(a1.plan.planDigest !== a2.plan.planDigest, '不同包根的同一份计划摘要必须不同（root 进了摘要）')

  // files 必须**排序去重**：build 乱序 + 重复 rel → 计划里升序、同 rel 只留一条（后者覆盖前者）
  {
    const d = pack('sorted-dedup')
    const sorted = C.planCommit(d.root, MULTI_BUILD)
    ok(sorted.ok, `乱序/重复 rel 的 build 也要能出计划：${sorted.error}`)
    eqJson(sorted.plan.files.map((f) => f.rel), ['a.txt', 'ledger.jsonl', 'z.txt'], 'files 必须按 rel 升序、且去重（z.txt 只留一条）')
    eq(sorted.plan.operation, 'compact', 'operation 来自 build 的声明')
    eq(sorted.plan.files.find((f) => f.rel === 'z.txt').digest, sha256(Buffer.from('zzz2', 'utf8')), '同 rel 去重时后一条覆盖前一条')
    eq(sorted.plan.files.find((f) => f.rel === 'ledger.jsonl').remove, true, 'remove 落点也进计划（摘要为 null）')
    eq(sorted.plan.files.find((f) => f.rel === 'ledger.jsonl').digest, null, 'remove 落点的输出摘要必须是 null')
  }

  EVID.gates = { codes, planKeys: Object.keys(plan), fileKeys: Object.keys(plan.files[0]) }
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 前置拒绝时提交调用次数为零（计数探针 = 0；成功路径 = 1）
 * ══════════════════════════════════════════════════════════════════════ */
async function A02() {
  const { C, TXN } = loadMods()
  const { root, ledger } = pack('count')
  const build = appendBuild('b')
  const plan = C.planCommit(root, build).plan

  // 前置拒绝三条（闸一 / 闸二 / 闸二-b）：探针一次都不许涨
  const refusals = [
    ['闸一：计划无效', { plan: { ...plan, schema: 'nope' }, opts: { confirm: true, planDigest: plan.planDigest, build } }],
    ['闸二：没有确认', { plan, opts: { build } }],
    ['闸二：planDigest 回引不符', { plan, opts: { confirm: true, planDigest: '1'.repeat(64), build } }],
  ]
  const rows = []
  for (const [label, c] of refusals) {
    const { txn, counter } = countingTxn(TXN)
    const r = C.applyCommit(root, c.plan, { ...c.opts, transaction: txn })
    eq(r.ok, false, `${label} 必须被拒`)
    eq(counter.calls, 0, `${label} 是前置拒绝：提交调用次数必须是 0（实得 ${counter.calls}）`)
    rows.push({ label, code: r.code, calls: counter.calls })
  }

  // 成功路径：同一个探针必须涨到 1（证明探针真的在数，不是恒 0 的空壳）
  {
    const { txn, counter } = countingTxn(TXN)
    const r = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build, transaction: txn })
    eq(r.ok, true, `成功路径必须提交（实得 state=${r.state} code=${r.code} error=${r.error}）`)
    eq(r.state, 'committed', '成功路径 → state=committed')
    eq(counter.calls, 1, `成功路径的提交调用次数必须是 1（实得 ${counter.calls}）`)
    eq(fs.readFileSync(ledger, 'utf8'), 'a\nb\n', '成功路径必须真的写出字节')
    rows.push({ label: '成功路径（探针有效性对照）', code: null, calls: counter.calls })
  }

  // 空转保护：探针在**闸三**（锁内）才会涨一次 —— 这一条把"0 次"钉在"前置"上，而不是"从不调用"
  {
    fs.writeFileSync(ledger, 'drift\n', 'utf8')
    const { txn, counter } = countingTxn(TXN)
    const r = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build, transaction: txn })
    eq(r.code, GATE_CODES.bytes, '漂移后必须被摘要闸拒')
    eq(counter.calls, 1, `摘要闸只能在锁内做，因此会进事务一次（实得 ${counter.calls}）`)
    rows.push({ label: '闸三：锁内（必须进事务一次）', code: r.code, calls: counter.calls })
  }

  EVID.samples.push({ case: 'A02', rows })
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 摘要覆盖真实字节变化（同计划、输入改一个字节 → 摘要变且被拒）
 * ══════════════════════════════════════════════════════════════════════ */
async function A03() {
  const { C } = loadMods()
  const build = appendBuild('b')

  const { root, ledger } = pack('bytes-utf8', { ledger: 'a\n' })
  const p1 = C.planCommit(root, build)
  ok(p1.ok, `planCommit 失败：${p1.error}`)
  const before = { planDigest: p1.plan.planDigest, digest: p1.plan.files[0].digest, beforeDigest: p1.plan.files[0].beforeDigest }

  // 同内容再算一次：摘要必须逐字节相同（确定性；否则下面的"变"没有意义）
  const again = C.planCommit(root, build)
  eq(again.plan.planDigest, before.planDigest, '同一输入两次算出的计划摘要必须相同')

  // 目标改一个字节：写前摘要变、输出摘要变、计划摘要变
  fs.writeFileSync(ledger, 'a\nx', 'utf8')
  const p2 = C.planCommit(root, build)
  ok(p2.ok, `改一个字节后 planCommit 失败：${p2.error}`)
  ok(p2.plan.planDigest !== before.planDigest, '目标改一个字节后，计划摘要必须变')
  ok(p2.plan.files[0].beforeDigest !== before.beforeDigest, '目标改一个字节后，写前摘要必须变')
  ok(p2.plan.files[0].digest !== before.digest, '目标改一个字节后，输出摘要必须变（build 是读-改-写）')

  // 用**旧计划**提交：必须被拒，且新内容还在
  const r = C.applyCommit(root, p1.plan, { confirm: true, planDigest: p1.plan.planDigest, build })
  eq(r.ok, false, '旧计划必须被拒（摘要不覆盖 = 会静默覆盖别人的新内容）')
  eq(r.code, GATE_CODES.bytes, `旧计划 → code=${GATE_CODES.bytes}`)
  eq(fs.readFileSync(ledger, 'utf8'), 'a\nx', '被拒后目标必须还是"改过之后"的字节')

  // 非 UTF-8 字节也算"真实字节"：utf8 字符串比较会漏掉这种变化，字节摘要不会
  const binRoot = pack('bytes-bin', { ledger: null }).root
  const binLedger = path.join(binRoot, 'ledger.jsonl')
  fs.writeFileSync(binLedger, Buffer.from([0x61, 0x00, 0xff]))
  const binBuild = () => [{ rel: 'ledger.jsonl', content: Buffer.from([0x62, 0x00, 0xff]) }]
  const bp = C.planCommit(binRoot, binBuild)
  ok(bp.ok, `二进制台账的 planCommit 失败：${bp.error}`)
  eq(bp.plan.files[0].beforeDigest, sha256(Buffer.from([0x61, 0x00, 0xff])), '写前摘要必须是**原始字节**的 sha256')
  eq(bp.plan.files[0].digest, sha256(Buffer.from([0x62, 0x00, 0xff])), '输出摘要必须是**原始字节**的 sha256')
  fs.writeFileSync(binLedger, Buffer.from([0x61, 0x00, 0xfe])) // 只差 1 个字节，utf8 解码会变成替换字符
  const br = C.applyCommit(binRoot, bp.plan, { confirm: true, planDigest: bp.plan.planDigest, build: binBuild })
  eq(br.ok, false, '非 UTF-8 台账改一个字节也必须被拒（utf8 字符串比较会漏掉）')
  eq(br.code, GATE_CODES.bytes, '非 UTF-8 台账改一个字节 → PLAN_STALE')
  eqJson([...fs.readFileSync(binLedger)], [0x61, 0x00, 0xfe], '被拒后字节原样保留')

  EVID.samples.push({
    case: 'A03',
    planDigests: { before: before.planDigest, after: p2.plan.planDigest, changed: before.planDigest !== p2.plan.planDigest },
    digests: { before: before.beforeDigest, after: p2.plan.files[0].beforeDigest },
    nonUtf8: { code: br.code, bytesKept: [...fs.readFileSync(binLedger)] },
  })
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 锁内变化被拒绝（计划后、提交前改目标 → 拒绝；旧计划不覆盖；新内容还在）
 * ══════════════════════════════════════════════════════════════════════ */
async function A04() {
  const { C } = loadMods()
  const build = appendBuild('b')
  const { root, ledger } = pack('lockchange')
  const plan = C.planCommit(root, build).plan

  const lockPath = path.join(root, '.whale-write.lock')
  const state = { armed: false, observed: [] }
  const probe = lockProbeFs(lockPath, state)
  state.armed = true

  // 计划生成之后、提交之前：别人（不受本计划约束的写者）改了目标
  fs.writeFileSync(ledger, 'SOMEONE-ELSE\n', 'utf8')
  const r = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build, fs: probe })
  state.armed = false

  eq(r.ok, false, '锁内发现目标被改 → 必须拒绝')
  eq(r.state, 'rejected', '锁内拒绝 → state=rejected')
  eq(r.code, GATE_CODES.bytes, `锁内拒绝 → code=${GATE_CODES.bytes}（实得 ${r.code}）`)
  eq(r.failure.kind, 'conflict', '锁内拒绝 → failure.kind=conflict')
  eq(r.failure.file, 'ledger.jsonl', 'failure.file 必须指到被改的落点')

  // ① 复核真的发生在**锁内**：每一次读目标字节时锁都在（含闸三那一次）
  ok(state.observed.length >= 2, `闸三没读目标字节（观察点 ${JSON.stringify(state.observed)}）：事务自己读写前字节 1 次 + 闸三复核 1 次`)
  eq(state.observed.filter((o) => o.lockHeld !== true).length, 0, '读目标字节时锁必须都在 —— 否则那只是"提交前检查"，不是锁内复核')

  // ② 旧计划没有覆盖新内容
  eq(fs.readFileSync(ledger, 'utf8'), 'SOMEONE-ELSE\n', '被拒后目标必须保持"别人写进去的新内容"')
  // ③ 事务被拒后不留残骸与锁（拒绝发生在写入之前）
  eq(txnDirs(root).filter((n) => fs.existsSync(path.join(root, '.whale-txn', n, 'journal.json'))).length, 0, '被拒后不许留下 journal')
  eq(lockExists(root), false, '被拒后锁必须放掉')

  // ④ 同一计划换回原字节后可以提交（拒绝只针对"不一致"，不是恒拒）
  fs.writeFileSync(ledger, 'a\n', 'utf8')
  const r2 = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build })
  eq(r2.ok, true, `恢复原字节后同一计划必须能提交（state=${r2.state} code=${r2.code} error=${r2.error}）`)
  eq(fs.readFileSync(ledger, 'utf8'), 'a\nb\n', '提交后字节是 build 算出的那份')

  EVID.samples.push({ case: 'A04', firstCode: r.code, readsObserved: state.observed.length, allLockHeld: state.observed.every((o) => o.lockHeld === true), afterReject: 'SOMEONE-ELSE', thenCommit: r2.state })
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 七态、whale-txn/1 日志 schema、待恢复阻断
 * ══════════════════════════════════════════════════════════════════════ */
async function A05() {
  const { C, TXN } = loadMods()
  const build = appendBuild('b')

  // ① 七态：两个模块同一套词，逐字
  eqJson(TXN.STATES, SEVEN_STATES, 'ledger-transaction.cjs 的 STATES 必须是七态逐字')
  eqJson(C.COMMIT_STATES, SEVEN_STATES, 'commit.cjs 的 COMMIT_STATES 必须是同一套七态')
  eq(new Set(SEVEN_STATES).size, 7, '七态必须是七个不同值')

  // ② building / prepared：**事务进行中的真实状态**（观察点 = build 拿到的 state + journal 落盘）
  const { root, ledger } = pack('journal')
  const journalDocs = []
  const liveStates = []
  const directBuild = (ctx) => {
    liveStates.push(ctx.state && ctx.state.state)
    return [{ rel: 'ledger.jsonl', content: `${(ctx.files && ctx.files['ledger.jsonl']) || ''}c\n` }]
  }
  const direct = TXN.withPackTransaction(root, directBuild, { fs: journalWatchFs(journalDocs) })
  eq(direct.state, 'committed', `直接跑事务件也必须提交（state=${direct.state} error=${direct.error}）`)
  eq(liveStates[0], 'building', `事务进行中的第一态必须是 building（实得 ${JSON.stringify(liveStates)}）`)
  ok(liveStates.every((s) => s === 'building'), `事务进行中只该是 building（实得 ${JSON.stringify(liveStates)}）`)
  eqJson(journalDocs.map((d) => d.state), ['prepared', 'committed'], 'journal 落盘的状态序列必须是 prepared → committed')
  eqJson(journalDocs.map((d) => d.keys), [
    ['schema', 'txnId', 'root', 'startedAt', 'state', 'files'],
    ['schema', 'txnId', 'root', 'startedAt', 'committedAt', 'state', 'files'],
  ], 'whale-txn/1 日志字段必须逐字（顺序也在内）')
  eqJson(journalDocs[0].fileKeys, ['rel', 'target', 'remove', 'backup', 'existed', 'before'], 'journal 的 files 记录字段逐字')
  for (const d of journalDocs) {
    ok(!d.text.includes('c\\n'), `journal 里不许出现**新内容**（只记写前字节的落点）：${d.text.slice(0, 120)}`)
  }
  eq(fs.readFileSync(ledger, 'utf8'), 'a\nc\n', '直接事务真的写出了字节')

  // ③ committed 回执
  const p = C.planCommit(pack('receipt-committed').root, build).plan
  const committed = C.applyCommit(p.root, p, { confirm: true, planDigest: p.planDigest, build })
  eq(committed.state, 'committed', '成功回执必须是 committed')
  ok(committed.ok === true, '成功回执 ok=true')
  ok(SEVEN_STATES.includes(committed.state), '回执 state 必须在七态集合里')

  // ④ rejected（闸一）
  const rejected = C.applyCommit(p.root, { ...p, schema: 'nope' }, { confirm: true, planDigest: p.planDigest, build })
  eq(rejected.state, 'rejected', '闸一拒绝 → state=rejected')
  ok(SEVEN_STATES.includes(rejected.state), 'rejected 在七态集合里')

  // ⑤ busy（锁被另一个写者持有：不自动强抢）
  const busyPack = pack('receipt-busy')
  fs.mkdirSync(path.join(busyPack.root, '.whale-write.lock'), { recursive: true })
  fs.writeFileSync(path.join(busyPack.root, '.whale-write.lock', 'lock.json'), JSON.stringify({ schema: 'whale-txn/1', ownerToken: 'holder', pid: process.pid }), 'utf8')
  const busyPlan = C.planCommit(busyPack.root, build).plan
  let busyBuildCalls = 0
  const busy = C.applyCommit(busyPack.root, busyPlan, { confirm: true, planDigest: busyPlan.planDigest, build: (c) => { busyBuildCalls += 1; return build(c) } })
  eq(busy.state, 'busy', `锁被占 → state=busy（实得 ${busy.state} error=${busy.error}）`)
  eq(busy.code, 'LOCK_BUSY', 'busy 的码必须是 LOCK_BUSY')
  eq(busy.failure.kind, 'conflict', 'busy → failure.kind=conflict')
  eq(busyBuildCalls, 0, 'busy 时不跑 build（一个字节都没算）')
  eq(fs.readFileSync(busyPack.ledger, 'utf8'), 'a\n', 'busy 的写没有任何副作用')
  eq(readJson(path.join(busyPack.root, '.whale-write.lock', 'lock.json')).ownerToken, 'holder', '锁的持有者没被换掉（不自动强抢）')
  fs.rmSync(path.join(busyPack.root, '.whale-write.lock'), { recursive: true, force: true })

  // ⑥ rolled-back（落位失败但回滚成功）
  const rbPack = pack('receipt-rolledback')
  const rbPlan = C.planCommit(rbPack.root, build).plan
  const rolled = C.applyCommit(rbPack.root, rbPlan, { confirm: true, planDigest: rbPlan.planDigest, build, fs: faultFs({ times: 1 }) })
  eq(rolled.state, 'rolled-back', `落位失败但回滚成功 → state=rolled-back（实得 ${rolled.state} error=${rolled.error}）`)
  eq(rolled.code, 'IO_ERROR', 'rolled-back 的码是既有 IO_ERROR')
  eq(rolled.failure.kind, 'io', 'rolled-back → failure.kind=io')
  eq(fs.readFileSync(rbPack.ledger, 'utf8'), 'a\n', '回滚后 = 原状态')
  eq(lockExists(rbPack.root), false, '回滚后锁放掉')

  // ⑦ recovery-required + 待恢复阻断普通写（普通写连 build 都不跑）
  const recPack = pack('receipt-recovery')
  const recPlan = C.planCommit(recPack.root, build).plan
  const rec = C.applyCommit(recPack.root, recPlan, { confirm: true, planDigest: recPlan.planDigest, build, fs: faultFs({ always: true }) })
  eq(rec.state, 'recovery-required', `回滚也失败 → state=recovery-required（实得 ${rec.state}）`)
  eq(rec.code, 'RECOVERY_REQUIRED', '待恢复的码是 RECOVERY_REQUIRED')
  eq(rec.failure.kind, 'recovery', '待恢复 → failure.kind=recovery')
  const residue = firstJournal(recPack.root)
  ok(residue, '待恢复必须留下 journal 材料')
  eq(residue.doc.schema, 'whale-txn/1', '残骸 journal 的 schema 必须是 whale-txn/1')
  eq(residue.doc.state, 'recovery-required', '残骸 journal 的状态必须是 recovery-required')
  ok(fs.existsSync(path.join(residue.dir, residue.doc.files[0].backup)), '备份材料必须真的在日志目录里')
  eq(lockExists(recPack.root), true, '待恢复时锁必须保留（下一次普通写仍被拒）')

  {
    let buildCalls = 0
    const { txn, counter } = countingTxn(TXN)
    const blocked = C.applyCommit(recPack.root, recPlan, { confirm: true, planDigest: recPlan.planDigest, build: (c) => { buildCalls += 1; return build(c) }, transaction: txn })
    eq(blocked.ok, false, '待恢复时普通写必须被拒')
    eq(blocked.state, 'recovery-required', '待恢复拒绝 → state=recovery-required')
    eq(blocked.code, 'RECOVERY_REQUIRED', '待恢复拒绝 → code=RECOVERY_REQUIRED')
    eq(buildCalls, 0, '待恢复拒绝时 build 一次都不许跑')
    eq(counter.calls, 0, '待恢复拒绝在进入事务之前就发生（提交调用 0 次）')
    eq(fs.readFileSync(recPack.ledger, 'utf8'), 'a\n', '待恢复拒绝不写任何字节')
  }

  // ⑧ 离线恢复 CLI：--check 只读报告（exit 1）+ --json 机器可读；恢复后普通写恢复
  const chk = spawnSync(process.execPath, [CLI_FILE, recPack.root, '--check'], { cwd: REPO, encoding: 'utf8', timeout: 120000 })
  eq(chk.status, 1, `--check 有残骸时 exit 1（实得 ${chk.status}）`)
  ok(/^PENDING recover-ledgers/.test(String(chk.stdout)), `--check 的文本回执必须逐字保持：${chk.stdout}`)
  const chkJson = spawnSync(process.execPath, [CLI_FILE, recPack.root, '--check', '--json'], { cwd: REPO, encoding: 'utf8', timeout: 120000 })
  eq(chkJson.status, 1, `--check --json 有残骸时 exit 1（实得 ${chkJson.status}）`)
  const chkDoc = JSON.parse(String(chkJson.stdout).trim().split('\n').pop())
  eq(chkDoc.ok, false, '--check --json：有残骸时 ok=false')
  eq(chkDoc.pending.length, 1, '--check --json 要点名那一条待恢复日志')
  eq(chkDoc.failure.kind, 'recovery', '--check --json 的 failure.kind 必须来自事务件的 failureFor（recovery）')
  eq(chkDoc.failure.errorCode, undefined, '--check 的综合失败没有系统码，就不许硬塞 errorCode')
  eq(lockExists(recPack.root), true, '--check 是只读的：锁还在')

  const recovered = spawnSync(process.execPath, [CLI_FILE, recPack.root, '--offline', '--confirm', '--owner=executor-u06', '--json'], { cwd: REPO, encoding: 'utf8', timeout: 120000 })
  eq(recovered.status, 0, `离线恢复 exit 0（实得 ${recovered.status}，stderr=${recovered.stderr}）`)
  const recDoc = JSON.parse(String(recovered.stdout).trim().split('\n').pop())
  eq(recDoc.ok, true, '--json 恢复成功 ok=true')
  eq(recDoc.state, 'recovered', '--json 恢复的 state 是 recovered（事务件的既有词）')
  eq(recDoc.failure, null, '恢复成功不带 failure')
  eq(lockExists(recPack.root), false, '恢复后锁放掉')
  eq(fs.readFileSync(recPack.ledger, 'utf8'), 'a\n', '恢复后 = 原状态')
  const afterPlan = C.planCommit(recPack.root, build).plan
  const after = C.applyCommit(recPack.root, afterPlan, { confirm: true, planDigest: afterPlan.planDigest, build })
  eq(after.state, 'committed', `恢复之后普通写能进（实得 ${after.state}）`)

  EVID.states = {
    seven: SEVEN_STATES,
    liveStates,
    journal: journalDocs.map((d) => ({ state: d.state, keys: d.keys, fileKeys: d.fileKeys })),
    receipts: { committed: committed.state, rejected: rejected.state, busy: busy.state, rolledBack: rolled.state, recovery: rec.state },
    cli: { checkExit: chk.status, checkJson: chkDoc, recoverExit: recovered.status, recoverState: recDoc.state },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 恢复失败如实报告（不宣称已恢复）
 * ══════════════════════════════════════════════════════════════════════ */
async function A06() {
  const { C, TXN } = loadMods()
  const build = appendBuild('b')

  // ① 真残骸：落位与回滚都在同一个缝上失败 ⇒ recovery-required + 材料保留
  const { root, ledger } = pack('honest')
  const plan = C.planCommit(root, build).plan
  const r = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build, fs: faultFs({ always: true }) })

  eq(r.ok, false, '恢复失败不许报成功')
  eq(r.state, 'recovery-required', '恢复失败 → state=recovery-required')
  eq(r.code, 'RECOVERY_REQUIRED', '恢复失败 → code=RECOVERY_REQUIRED')
  eq(r.failure.kind, 'recovery', '恢复失败 → failure.kind=recovery')
  ok(!('recovered' in r), '回执里不许出现"已恢复"的宣称字段')
  ok(typeof r.rollbackError === 'string' && r.rollbackError.length > 0, `回执必须带 rollbackError（实得 ${JSON.stringify(r.rollbackError)}）`)
  ok(typeof r.journal === 'string' && r.journal.includes('.whale-txn'), `回执必须指到保留下来的日志目录（实得 ${JSON.stringify(r.journal)}）`)
  ok(fs.existsSync(r.journal), '回执指的日志目录必须真的还在盘上')

  const residue = firstJournal(root)
  ok(residue, '必须留下待恢复材料')
  eq(residue.doc.state, 'recovery-required', '残骸状态必须是 recovery-required（材料完整）')
  eq(residue.doc.schema, 'whale-txn/1', '残骸 schema 必须是 whale-txn/1')
  const backups = (residue.doc.files || []).map((f) => f.backup)
  ok(backups.length === 1 && fs.existsSync(path.join(residue.dir, backups[0])), '写前字节的备份必须还在（材料保留）')
  eq(lockExists(root), true, '恢复失败时锁必须保留（下次普通写仍被拒）')
  eq(fs.readFileSync(ledger, 'utf8'), 'a\n', '恢复失败这一路没有改动目标（rename 都没成功）')

  // ② 事务实现自己抛错（"恢复抛错"）：必须如实报 recovery-required，且绝不宣称已恢复
  const throwPack = pack('honest-throw')
  const throwPlan = C.planCommit(throwPack.root, build).plan
  const counters = { recover: 0, txn: 0 }
  const throwingTxn = {
    ...TXN,
    withPackTransaction: (rootArg, buildArg, optsArg = {}) => {
      counters.txn += 1
      TXN.withPackTransaction(rootArg, buildArg, { ...optsArg, fs: faultFs({ always: true }) })
      const e = new Error('恢复抛错（注入：recoverPack 没做完）')
      e.code = 'EACCES'
      throw e
    },
    recoverPack: () => {
      counters.recover += 1
      throw new Error('恢复抛错（注入）')
    },
  }
  const thrown = C.applyCommit(throwPack.root, throwPlan, { confirm: true, planDigest: throwPlan.planDigest, build, transaction: throwingTxn })
  eq(thrown.ok, false, '恢复抛错也不许报成功')
  eq(thrown.state, 'recovery-required', `恢复抛错 → state=recovery-required（实得 ${thrown.state}）`)
  eq(thrown.code, 'RECOVERY_REQUIRED', '恢复抛错 → code=RECOVERY_REQUIRED')
  eq(thrown.failure.kind, 'recovery', '恢复抛错 → failure.kind=recovery')
  ok(/恢复抛错/.test(thrown.error), `回执要保留抛错原文：${thrown.error}`)
  eq(thrown.failure.errorCode, 'EACCES', '系统码必须原样保留（不改名、不折算）')
  const throwResidue = firstJournal(throwPack.root)
  ok(throwResidue, '恢复抛错后材料必须还在（不许悄悄清干净再报成功）')
  eq(throwResidue.doc.state, 'recovery-required', '抛错后的残骸仍是 recovery-required')
  eq(lockExists(throwPack.root), true, '抛错后锁仍在（普通写继续被拒）')
  eq(counters.recover, 0, 'applyCommit 不许自己偷偷跑 recoverPack 再宣称恢复')
  eq(counters.txn, 1, '事务实现被调用一次（探针有效性）')

  // ③ 抛错且盘上没有材料时：如实报"拒绝"，同样不许报成功
  const bareTxn = {
    ...TXN,
    withPackTransaction: () => { throw new Error('事务实现抛错但没有留材料'); },
  }
  const barePack = pack('honest-bare')
  const barePlan = C.planCommit(barePack.root, build).plan
  const bare = C.applyCommit(barePack.root, barePlan, { confirm: true, planDigest: barePlan.planDigest, build, transaction: bareTxn })
  eq(bare.ok, false, '抛错且无材料 → 不许报成功')
  eq(bare.state, 'rejected', `抛错且无材料 → state=rejected（实得 ${bare.state}）`)
  eq(bare.failure.kind, 'io', '抛错且无材料 → failure.kind=io（协议/IO 故障，不是"可以重试的冲突"）')
  eq(lockExists(barePack.root), false, '没有材料时不许凭空说"要恢复"')

  EVID.recovery = {
    realResidue: { journalState: residue.doc.state, backup: backups[0], lockKept: true, receiptJournal: r.journal },
    thrown: { state: thrown.state, code: thrown.code, errorCode: thrown.failure.errorCode, materialKept: Boolean(throwResidue), recoverCalls: counters.recover },
    bare: { state: bare.state, kind: bare.failure.kind },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 临时跳过一闸 / 吞掉恢复失败 → 判据必须失败
 * ══════════════════════════════════════════════════════════════════════ */
async function A07() {
  const srcText = fs.readFileSync(COMMIT_FILE, 'utf8')
  eq(countOf(srcText, MUT_GATE2_TOKEN), 1, `变异落点（确认闸）在源码里必须恰好出现一次：${MUT_GATE2_TOKEN}`)
  eq(countOf(srcText, MUT_RECOVERY_TOKEN), 1, `变异落点（恢复分支）在源码里必须恰好出现一次：${MUT_RECOVERY_TOKEN}`)

  /** 复制一份模块闭包（commit.cjs → errors.cjs → 事务件），可选打一个变异 */
  const copyModules = (name, mutation) => {
    const dir = tempDir(name)
    fs.mkdirSync(path.join(dir, 'lib', 'unify'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'lib', 'pack-template', 'tools'), { recursive: true })
    fs.copyFileSync(ERRORS_FILE, path.join(dir, 'lib', 'unify', 'errors.cjs'))
    fs.copyFileSync(TXN_FILE, path.join(dir, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs'))
    const text = mutation ? srcText.replace(mutation.token, mutation.replacement) : srcText
    if (mutation) {
      ok(text !== srcText, `变异没生效：${mutation.token}`)
      ok(!text.includes(mutation.token), `变异后原 token 还在：${mutation.token}`)
    }
    fs.writeFileSync(path.join(dir, 'lib', 'unify', 'commit.cjs'), text, 'utf8')
    return dir
  }
  const runContract = (dir) => {
    const r = spawnSync(process.execPath, [SELF, `--commit-contract=${dir}`], { cwd: REPO, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
    if (r.error) throw new Error(`子进程跑不起来：${r.error.message}`)
    return { code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
  }

  // ① 干净副本：同一份判据必须通过（证明失败来自变异，不是来自判据壳）
  const control = copyModules('mut-control', null)
  eq(sha256(fs.readFileSync(path.join(control, 'lib', 'unify', 'commit.cjs'))), sha256(Buffer.from(srcText)), '干净副本的 commit.cjs 必须与权威源码逐字节相同')
  const ctl = runContract(control)
  eq(ctl.code, 0, `干净副本必须通过判据内核（exit ${ctl.code}：${ctl.stdout.trim()} ${ctl.stderr.trim()}）`)
  eq(ctl.stdout.trim(), 'COMMIT-CONTRACT OK', '干净副本的判词行不对')

  // ② 变异 1：跳过确认闸 → 判据必须失败，且点名确认闸
  const m1 = copyModules('mut-gate2', { token: MUT_GATE2_TOKEN, replacement: MUT_GATE2_REPLACEMENT })
  const m1run = runContract(m1)
  ok(m1run.code !== 0, `跳过确认闸的变异副本竟然通过了（exit ${m1run.code}）—— A07 的判据无效`)
  eq(m1run.code, 1, `变异副本应当以 exit 1 拒绝（实得 ${m1run.code}）`)
  ok(/^COMMIT-CONTRACT FAIL /.test(m1run.stdout.trim()), `变异副本的判词不是 FAIL：${m1run.stdout.trim()}`)
  ok(/CONFIRM_REQUIRED/.test(m1run.stdout), `失败必须点名确认闸：${m1run.stdout.trim()}`)
  // 变异真的改变了行为（不是把文件改坏）：进程内跑一次——权威源码拒，变异副本不拒
  {
    const Mut = requireCJS(path.join(m1, 'lib', 'unify', 'commit.cjs'))
    const fixture = pack('mut-gate2-live')
    const build = appendBuild('b')
    const p = Mut.planCommit(fixture.root, build).plan
    const real = C_apply(requireCJS(COMMIT_FILE), fixture.root, p, build)
    eq(real.code, GATE_CODES.confirm, '对照：权威源码必须拒绝（CONFIRM_REQUIRED）')
    const probeCalls = { n: 0 }
    const withoutTxn = { withPackTransaction: () => { probeCalls.n += 1; return { ok: false, state: 'rejected', error: 'stub', rollbackError: null } } }
    const mutRes = Mut.applyCommit(fixture.root, p, { planDigest: p.planDigest, build, transaction: withoutTxn })
    ok(mutRes.code !== GATE_CODES.confirm, `变异副本竟然还拒绝成 CONFIRM_REQUIRED（code=${mutRes.code}）—— 变异无效`)
    eq(probeCalls.n, 1, '变异副本确实越过了确认闸、进到了事务（变异真的生效）')
  }

  // ③ 变异 2：把恢复失败当成成功 → 判据必须失败，且点名 recovery-required
  const m2 = copyModules('mut-recovery', { token: MUT_RECOVERY_TOKEN, replacement: MUT_RECOVERY_REPLACEMENT })
  const m2run = runContract(m2)
  ok(m2run.code !== 0, `吞掉恢复失败的变异副本竟然通过了（exit ${m2run.code}）—— A07 的判据无效`)
  eq(m2run.code, 1, `变异副本应当以 exit 1 拒绝（实得 ${m2run.code}）`)
  ok(/^COMMIT-CONTRACT FAIL /.test(m2run.stdout.trim()), `变异副本的判词不是 FAIL：${m2run.stdout.trim()}`)
  ok(/recovery-required/.test(m2run.stdout), `失败必须点名 recovery-required：${m2run.stdout.trim()}`)
  {
    const Mut = requireCJS(path.join(m2, 'lib', 'unify', 'commit.cjs'))
    const fixture = pack('mut-recovery-live')
    const build = appendBuild('b')
    const p = Mut.planCommit(fixture.root, build).plan
    const mutRes = Mut.applyCommit(fixture.root, p, { confirm: true, planDigest: p.planDigest, build, fs: faultFs({ always: true }) })
    eq(mutRes.ok, true, '变异副本确实把恢复失败当成了成功（变异生效）')
    eq(mutRes.state, 'committed', '变异副本宣称 committed（这正是"吞掉恢复失败"）')
    ok(fs.readdirSync(path.join(fixture.root, '.whale-txn')).length > 0, '变异副本下材料其实还在（宣称成功是假的）—— 证明判据必须抓它')
  }

  EVID.mutation = {
    gate2: { token: MUT_GATE2_TOKEN, controlExit: ctl.code, mutantExit: m1run.code, mutantVerdict: m1run.stdout.trim().split('\n')[0] },
    recovery: { token: MUT_RECOVERY_TOKEN, mutantExit: m2run.code, mutantVerdict: m2run.stdout.trim().split('\n')[0] },
  }

  // ④ 清干净（归属核对由 safeRemoveTree 做）
  for (const name of ['mut-control', 'mut-gate2', 'mut-recovery']) {
    dropTempDir(name)
    ok(!fs.existsSync(path.join(RUN_TMP, name)), `变异副本必须清掉：${name}`)
  }
}

/** 小壳：对某份 commit 模块跑一次"没有确认"的提交（A07 的进程内对照用） */
function C_apply(C, root, plan, build) {
  return C.applyCommit(root, plan, { build })
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 运行期自锚（七件依赖 boot=end）+ §6 归属登记 + 交付物内容锁 + 写守卫 + 证据 + 清理
 * ══════════════════════════════════════════════════════════════════════ */
async function A08() {
  const { C, TXN } = loadMods()
  if (!EV) throw new Blocked(`证据根解析失败：${ROOTS.error}`)

  const iface = fs.readFileSync(IFACE_FILE, 'utf8')
  const receipts = {
    U01: JSON.parse(fs.readFileSync(RECEIPT_FILES.U01, 'utf8')),
    U03: JSON.parse(fs.readFileSync(RECEIPT_FILES.U03, 'utf8')),
    U06: JSON.parse(fs.readFileSync(RECEIPT_FILES.U06, 'utf8')),
  }
  const u03 = receipts.U03
  const u03Iface = u03.interfaceConsumption || {}

  /* ── ① 反空转自证：锚点分类器 / 写守卫分类器的 3 红 2 绿（子进程跑同一份纯函数） ── */
  const proofRun = spawnSync(process.execPath, [SELF, '--anchor-self-proof'], { cwd: REPO, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  if (proofRun.error) throw new Error(`反空转子进程跑不起来：${proofRun.error.message}`)
  const proofOut = String(proofRun.stdout ?? '')
  eq(proofRun.status, 0, `反空转自证必须通过（exit ${proofRun.status}）：${proofOut.trim()} ${String(proofRun.stderr ?? '').trim()}`)
  const sampleLines = proofOut.split('\n').filter((l) => l.startsWith('SAMPLE '))
  eq(sampleLines.length, 5, `反空转样本必须是 5 条（实得 ${sampleLines.length}）：${proofOut.trim()}`)
  eq(sampleLines.filter((l) => / expect=red actual=red OK$/.test(l)).length, 3, `必须 3 条红都真的红（判据没空转）：${sampleLines.join(' / ')}`)
  eq(sampleLines.filter((l) => / expect=green actual=green OK$/.test(l)).length, 2, `必须 2 条绿都真的绿（判据没恒红）：${sampleLines.join(' / ')}`)
  ok(/^ANCHOR-SELF-PROOF OK samples=5 red=3 green=2$/m.test(proofOut), `反空转判词不对：${proofOut.trim()}`)
  const selfProof = { exitCode: proofRun.status, samples: 5, red: 3, green: 2, lines: sampleLines, verdict: proofOut.trim().split('\n').pop() }

  /* ── ② 运行期自锚：七件依赖「开跑快照 = 收口快照」（本卡这一跑一个字都没写它们） ── */
  const endAnchors = snapshotAnchors()
  const rowsNow = anchorRows(BOOT_ANCHORS, endAnchors, receipts)
  const cls = classifyAnchors({ anchors: rowsNow, writes: [] })
  eq(cls.rows.length, ANCHOR_SPECS.length, `锚点必须是 ${ANCHOR_SPECS.length} 件（实得 ${cls.rows.length}）`)
  for (const row of cls.rows) {
    ok(typeof row.boot === 'string' && typeof row.end === 'string', `锚点读不到：${row.rel}`)
    eq(row.stable, true,
      `本次运行期 ${row.rel} 被改写（boot≠end：${row.boot} → ${row.end}）—— 它的写权不归本卡，一个字都不许写`)
  }
  eq(cls.violations.length, 0, `锚点判据出现红（本次运行期被写）：${JSON.stringify(cls.violations.slice(0, 3))}`)
  // 归属**从 interfaces.md §6 的写集表里解析**，再与锚点清单逐条比（不拿常量表自说自话）
  const attribution = ANCHOR_SPECS.map((spec) => ({
    rel: spec.rel, role: spec.role, ownerFromSection6: section6OwnerOf(iface, spec.rel), declaredOwner: spec.owner,
  }))
  for (const a of attribution) {
    eq(a.ownerFromSection6, a.declaredOwner, `${a.rel} 的归属与 interfaces.md §6 不符（§6=${a.ownerFromSection6} / 清单=${a.declaredOwner}）`)
  }
  // 跨卡登记值：与登记值不同**只登记 + 按 §6 归属**，不判红（U01 的合法账本同步必须可归因）
  const attributedDrift = cls.rows
    .filter((r) => r.matchesRecorded === false)
    .map((r) => ({ rel: r.rel, owner: r.owner, role: r.role, state: r.state, boot: r.boot, end: r.end, recorded: r.recorded }))
  eq(cls.rows.filter((r) => r.role === 'deliverable' && r.matchesRecorded === false).length, 0,
    `本卡交付物与回执登记值不符（内容锁破了）：${JSON.stringify(attributedDrift.filter((r) => r.role === 'deliverable'))}`)

  /* ── ③ 交付物内容锁：本卡回执登记的字节必须仍是盘上的字节（"我写下的字节"） ── */
  const contentLock = verifyReceiptContentLocks(receipts.U06)
  eq(contentLock.violations.length, 0, `本卡交付物与回执登记的字节不符：${JSON.stringify(contentLock.violations.slice(0, 3))}`)
  const lockedRows = contentLock.rows.filter((r) => r.locked === true)
  ok(lockedRows.length >= 4, `回执里记了摘要的交付物太少（${lockedRows.length}）—— 内容锁形同虚设`)
  for (const rel of ['lib/unify/commit.cjs', 'lib/pack-template/tools/ledger-transaction.cjs', 'tools/recover-ledgers.mjs', 'test/audit/U06.mjs']) {
    const row = lockedRows.find((r) => normRel(r.path) === rel)
    ok(row, `本卡交付物 ${rel} 没有内容锁（回执 writeSet 必须记 bytes + sha256）`)
    eq(row.ok, true, `本卡交付物 ${rel} 的内容锁不成立（回执 ${row.lockedSha256} ×${row.lockedBytes}B / 盘上 ${row.sha256} ×${row.bytes}B）`)
  }

  /* ── ④ 依赖行为锁（替代旧的「errors.cjs 跨卡字节等值」：字节等值天然陈旧，行为契约不陈旧） ── */
  const ERR = requireCJS(ERRORS_FILE)
  eqJson(ERR.FAILURE_KINDS, ['input', 'confirmation', 'conflict', 'io', 'recovery'],
    'errors.cjs 的 failure kind 域必须逐字保持（本卡所有 failure 都靠它）')
  eq(typeof ERR.makeFailure, 'function', 'makeFailure 是唯一失败工厂，必须还在')
  eq(typeof ERR.isFailure, 'function', 'isFailure 必须还在')
  eq(ERR.NEW_CODES.LOCK_BUSY, 'LOCK_BUSY', 'LOCK_BUSY 的落点必须还在 errors.cjs')
  eq(ERR.NEW_CODES.RECOVERY_REQUIRED, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED 的落点必须还在 errors.cjs')
  {
    let badKind = null
    try { ERR.makeFailure({ kind: 'not-a-kind', code: 'X', error: 'x' }) } catch (e) { badKind = e }
    ok(badKind instanceof TypeError, 'makeFailure 必须仍然拒绝非法 kind（TypeError）')
    const f = ERR.makeFailure({ kind: 'conflict', code: GATE_CODES.bytes, error: '样例' })
    eq(f.kind, 'conflict', 'makeFailure 的 kind 必须原样带出')
    eq(f.code, GATE_CODES.bytes, 'makeFailure 的 code 必须原样带出')
    eq(ERR.isFailure(f), true, 'makeFailure 造出来的对象必须被 isFailure 认')
  }
  // U03 的登记值只登记 + 归属 U03；漂移由上面的 attributedDrift 记录，不在这里判红
  const u03Anchor = cls.rows.find((r) => r.rel === 'lib/unify/errors.cjs')
  ok(u03Anchor && u03Anchor.recorded && u03Anchor.recorded.card === 'U03', 'errors.cjs 的跨卡登记值必须被登记（归属 U03）')

  /* ── ⑤ 接口锁的**合法更新出处**（两次账本同步 → 三处落点；只登记、不判红） ── */
  const ledgerSyncs = collectLedgerSyncDeltas(receipts.U01)
  eq(ledgerSyncs.length, 2, 'U01 回执里必须有两次账本同步（deltas L1 / L3）作为「接口锁被合法更新」的出处')
  for (const d of ledgerSyncs) ok(d.touchesInterfaceLock, `账本同步 ${d.id} 必须点名 interfaces.md 是它改的（出处逐条可查）`)
  const landings = [...new Set(ledgerSyncs.flatMap((d) => d.landings))]
  eq(landings.length, 3, `两次合法更新必须落到三处落点（实得 ${JSON.stringify(landings)}）`)
  const staleRecords = [{
    rel: 'docs/unify/interfaces.md',
    card: 'U03',
    field: 'interfaceConsumption.lockSha256',
    value: u03Iface.lockSha256 ?? null,
    bytes: u03Iface.lockBytes ?? null,
    matchesNow: typeof u03Iface.lockSha256 === 'string' && u03Iface.lockSha256 === endAnchors['docs/unify/interfaces.md'].sha256,
    blocking: false,
    why: '旧判据要求 interfaces.md 的 sha256 == U03 消费时记下的锁值。interfaces.md 归 U01，且它在授权路径上被合法账本同步更新过两次（docs/unify/receipts/U01.json deltas L1 / L3，依据 docs/unify/authorization.json 的 derivedConsequences.C4 / scope.A），跨卡字节等值锚必然陈旧 —— 只登记 + 按 §6 归属 U01，不判红。',
  }]
  ok(staleRecords[0].value !== null, 'U03 回执里记的旧接口锁值必须被登记（不许静默丢）')
  eq(staleRecords[0].blocking, false, '旧跨卡锁值只登记、不判红')
  eq(cls.violations.filter((v) => v.rel === 'docs/unify/interfaces.md').length, 0, '陈旧的跨卡锁值不许把本卡判红')

  /* ── ⑥ 改动锚点：事务件只在 HEAD 基础上**纯插入**，日志/锁/状态码逐字未动 ─ */
  const headText = gitShow('lib/pack-template/tools/ledger-transaction.cjs')
  const curText = fs.readFileSync(TXN_FILE, 'utf8')
  eq(sha256(Buffer.from(headText, 'utf8')), '0361593f96ca0a940c0b34aef94ca7f74541b18568723a3d79c8c2436b1f8e2f',
    'HEAD 上的 ledger-transaction.cjs 与 U01 锁定的 sha 不符 —— 基线漂了')
  ok(iface.includes('0361593f96ca0a940c0b34aef94ca7f74541b18568723a3d79c8c2436b1f8e2f'), 'interfaces.md 里必须记着事务件的基线 sha')
  ok(curText !== headText, '事务件必须真的被改过（只增 failureFor 那一块）')
  ok(isLineSubsequence(headText, curText), '事务件的改动必须是**纯插入**：既有行一个都不许改或删（日志/锁/状态码逐字保持）')
  ok(curText.split('\n').length > headText.split('\n').length, '事务件是纯插入 ⇒ 行数必须变多')
  for (const name of ['TXN_SCHEMA', 'TXN_DIR', 'LOCK_NAME', 'JOURNAL_NAME', 'DEFAULT_TIMEOUT_MS', 'STATES', 'txnPaths', 'withPackTransaction', 'recoverPack', 'assertNoRecoveryRequired', 'pendingRecovery', 'listJournals', 'readJournal']) {
    ok(TXN[name] !== undefined, `事务件的既有导出 ${name} 不见了 —— 接口锁破了`)
  }
  eq(TXN.TXN_SCHEMA, 'whale-txn/1', '日志 schema 必须仍是 whale-txn/1')
  eq(TXN.TXN_DIR, '.whale-txn', '日志目录常量逐字')
  eq(TXN.LOCK_NAME, '.whale-write.lock', '锁名常量逐字')
  eq(TXN.JOURNAL_NAME, 'journal.json', 'journal 文件名逐字')
  eq(TXN.DEFAULT_TIMEOUT_MS, 5000, '默认超时逐字（5000）')
  ok(T09_LOCK_REGION.test(curText), 'T09 判据锁着的"锁获取"段落已被改动 —— 既有锁行为不许改')
  ok(T09_ROLLBACK_REGION.test(curText), 'T09 判据锁着的"回滚"段落已被改动 —— 既有回滚行为不许改')
  eq((curText.match(new RegExp(T09_LOCK_REGION.source, 'g')) || []).length, 1, '锁获取段落必须恰好一处（不许出现第二套锁）')
  eq((curText.match(new RegExp(T09_ROLLBACK_REGION.source, 'g')) || []).length, 1, '回滚段落必须恰好一处（不许出现第二套回滚）')
  // 不许出现第二套日志目录/第二把锁的名字（不是"看起来没有"，是名字层面扫）
  for (const forbidden of ['.whale-txn-2', '.whale-write.lock2', 'whale-commit/2']) {
    ok(!curText.includes(forbidden) && !fs.readFileSync(COMMIT_FILE, 'utf8').includes(forbidden), `出现了第二套协议落点：${forbidden}`)
  }
  // 新码只许落在 lib/unify/*（U03 的查重结论延伸到本卡消费方）—— 按**代码**扫，注释不算落点
  const curCode = stripComments(curText)
  const cliCode = stripComments(fs.readFileSync(CLI_FILE, 'utf8'))
  for (const code of NEW_CODES) {
    ok(fs.readFileSync(COMMIT_FILE, 'utf8').includes(code), `commit.cjs 必须用上拟新增码 ${code}`)
    ok(!curCode.includes(code), `事务件里不许出现新码 ${code}（码表只许落在 lib/unify/*）`)
    ok(!cliCode.includes(code), `恢复 CLI 里不许出现新码 ${code}（码表只许落在 lib/unify/*）`)
  }
  // 恢复 CLI 的默认文本回执与退出码逐字保持（只增 --json）
  const cliText = fs.readFileSync(CLI_FILE, 'utf8')
  for (const needle of ['PASS recover-ledgers', 'FAIL recover-ledgers', 'PENDING recover-ledgers', 'OK recover-ledgers', 'process.exit(2)', 'process.exit(1)', 'process.exit(0)']) {
    ok(cliText.includes(needle), `恢复 CLI 的既有文本/退出码不见了：${needle}`)
  }
  ok(cliText.includes("argv.find((a) => a.startsWith('--owner='))"), '恢复 CLI 的既有参数解析逐字保持')
  ok(/--owner=\$\{root\}/.test(cliText) || cliText.includes('--owner=<令牌>'), '恢复 CLI 的用法文本还在')

  /* ── ⑦ 进程内写守卫：拦写能力、记绝对路径；本卡所有写必须落在允许根内 ── */
  const guard = installWriteGuard()
  const allowed = {
    exact: WRITE_SET.map((rel) => path.resolve(REPO, rel)),
    roots: [path.resolve(RUN_TMP), path.resolve(CARD_EV), EV ? path.resolve(EV) : null].filter(Boolean),
  }

  // 真跑一遍提交（写守卫必须看见它：全部落在本卡临时目录内）
  const { root } = pack('guard')
  const build = appendBuild('b')
  const plan = C.planCommit(root, build).plan
  const committed = C.applyCommit(root, plan, { confirm: true, planDigest: plan.planDigest, build })
  eq(committed.state, 'committed', '写守卫期间的提交必须成功（否则守卫记录没有意义）')
  // 恢复失败那一支也要在守卫下跑一遍（它会写 journal/备份/锁）
  const recPack = pack('guard-recovery')
  const recPlan = C.planCommit(recPack.root, build).plan
  const rec = C.applyCommit(recPack.root, recPlan, { confirm: true, planDigest: recPlan.planDigest, build, fs: faultFs({ always: true }) })
  eq(rec.state, 'recovery-required', '写守卫期间的恢复失败路径必须跑到')

  // 守卫自证：往允许目录写一个哨兵，必须被记到
  const sentinel = path.join(RUN_TMP, 'guard-sentinel.txt')
  fs.writeFileSync(sentinel, 'probe\n', 'utf8')
  ok(guard.log.some((x) => path.resolve(x.path) === path.resolve(sentinel) && x.op === 'writeFileSync'), '写守卫没有记录哨兵写 —— 守卫没挂上')

  // 越界自证：在**本次唯一临时根**（不是运行子目录）写一个探针，守卫必须把它记成越界
  const offScopeProbe = path.join(TEMP_ROOT, `U06-${process.pid}-offscope.txt`)
  fs.writeFileSync(offScopeProbe, 'probe\n', 'utf8')
  fs.rmSync(offScopeProbe, { force: true })
  const offScope = guard.log.filter((x) => path.resolve(x.path).toLowerCase() === path.resolve(offScopeProbe).toLowerCase())
  eq(offScope.length, 2, `越界探针必须被记到两次写（写 + 删），实得 ${JSON.stringify(offScope)}`)
  ok(!fs.existsSync(offScopeProbe), '越界探针必须已删掉')
  // 「写野路径 ⇒ 红」在**真盘真写**上对照一次：越界探针不在允许面内 ⇒ 分类器必须点名两条（与 R3 同一份判据）
  {
    const probeViolations = writeViolations(offScope, allowed)
    eq(probeViolations.length, 2, `真盘上的野路径写必须被判越界（lib/whatever.js 那条红的活对照）：${JSON.stringify(probeViolations)}`)
    EVID.anchorWildPathProbe = {
      probe: path.relative(REPO, offScopeProbe).replace(/\\/g, '/'),
      writes: offScope.map((x) => x.op), flagged: probeViolations.map((x) => x.op), inAllowedFace: false,
    }
  }

  const entries = guard.log.filter((x) => !offScope.includes(x))
  ok(entries.length >= 20, `写守卫只记到 ${entries.length} 次写 —— 提交协议的真实写盘没被看见`)
  // 与 `--anchor-self-proof` 的 R3 用**同一份**分类器（allowedMatcher / writeViolations）
  const violations = writeViolations(entries, allowed)
  eq(violations.length, 0, `本卡写到了允许根之外：${JSON.stringify(violations.slice(0, 5))}`)
  // 本进程一次都不许写锚点（即便字节相同）：这是"本次运行没写它们"的第二道证明
  const anchorWrites = entries.filter((x) => ANCHOR_SPECS.some((s) => normRel(x.path) === s.rel))
  eq(anchorWrites.length, 0, `本进程写到了依赖锚点（写权不归本卡）：${JSON.stringify(anchorWrites.slice(0, 5))}`)
  const ops = [...new Set(entries.map((x) => x.op))].sort()
  ok(ops.length >= 4, `写守卫记到的写能力种类太少（${ops.join(',')}）`)
  guard.uninstall()
  ok(guard.log.length >= entries.length + 2, '卸载前必须留下完整记账')
  // 卸载后不再记账（守卫真的拆掉了，不会污染后面的证据写）
  const afterUninstall = guard.log.length
  fs.writeFileSync(path.join(RUN_TMP, 'post-uninstall.txt'), 'x', 'utf8')
  eq(guard.log.length, afterUninstall, '卸载后写守卫不许再记账')

  /* ── ⑧ 临时目录与清理守卫 ─────────────────────────────────────────── */
  ok(path.isAbsolute(TEMP_ROOT) && TEMP_ROOT === 'E:\\Temp\\u06-s2-blane', `临时根必须是绝对的 E:\\Temp 子目录（${TEMP_ROOT}）`)
  eq(path.dirname(RUN_TMP), TEMP_ROOT, '本次运行目录必须直接挂在临时根下')
  eq(path.basename(RUN_TMP), `U06-${process.pid}`, '临时目录名必须带 pid（同一根下每次唯一）')
  for (const [target, why] of [
    [TEMP_ROOT, '临时根自身'],
    ['E:\\Temp', 'E:\\Temp 本身'],
    ['E:\\workplace', '工作区父目录'],
    ['C:\\', '系统盘根'],
    [path.join(TEMP_ROOT, '..', 'u06-other'), '不在声明父目录下'],
  ]) {
    const g = guardTempPath(target, { parent: TEMP_ROOT })
    ok(g.ok === false, `清理守卫放行了危险目标：${why}（${target}）`)
  }
  ok(guardTempPath(RUN_TMP, { parent: TEMP_ROOT }).ok === true, '清理守卫拒绝了合法目标（恒拒绝同样是坏守卫）')

  /* ── ⑨ 证据落盘（都是这次真跑出来的） ─────────────────────────────── */
  ok(EVID.gates && EVID.gates.codes.length >= 10, '证据缺三闸矩阵（A01 没跑完？）')
  ok(EVID.states && EVID.states.receipts.recovery === 'recovery-required', '证据缺七态采样（A05 没跑完？）')
  ok(EVID.recovery && EVID.recovery.realResidue, '证据缺恢复失败材料（A06 没跑完？）')
  ok(EVID.mutation && EVID.mutation.gate2.mutantExit === 1 && EVID.mutation.recovery.mutantExit === 1, '证据缺变异结果（A07 没跑完？）')

  fs.mkdirSync(EV, { recursive: true })
  const head = gitHead()
  const sha = (p) => sha256(fs.readFileSync(p))
  const anchorRowsForEvidence = cls.rows.map((r) => ({
    rel: r.rel, owner: r.owner, role: r.role, boot: r.boot, end: r.end, bytes: r.bytes,
    stable: r.stable, wroteDuringRun: r.wroteDuringRun,
    recorded: r.recorded, matchesRecorded: r.matchesRecorded, state: r.state,
  }))
  const criterion = {
    what: '运行期自锚 + 归属（取代「docs/unify/interfaces.md 的 sha256 == U03 消费时记下的锁值」）',
    hardReds: [
      '① 运行期自锚：boot≠end ⇒ 本次运行期被写（本卡写权不归它）',
      '② 本进程写守卫：非交付物被本进程写过 ⇒ 红（字节相同也红）',
      '③ 交付物内容锁：本卡交付物 ≠ 回执登记的字节 ⇒ 红',
    ],
    registeredOnly: '④ 与跨卡登记值不同（非交付物）⇒ 只登记 + 按 interfaces.md §6 归属，不红',
    whyReplaced: 'interfaces.md 归 U01，在授权路径上被合法账本同步更新过两次（docs/unify/receipts/U01.json deltas L1 / L3；依据 docs/unify/authorization.json 的 derivedConsequences.C4 / scope.A）——跨卡字节等值锚必然陈旧，且与接口锁的写权归属冲突',
    attributionRule: '每次都从 interfaces.md §6 的写集表**现场解析**归属，再与锚点清单逐条比对',
  }
  const evidenceFiles = {
    'module-locks.json': {
      card: CARD, head,
      files: [COMMIT_FILE, ERRORS_FILE, TXN_FILE, CLI_FILE, SELF].map((abs) => ({
        path: path.relative(REPO, abs).replace(/\\/g, '/'), bytes: fs.statSync(abs).size, sha256: sha(abs),
      })),
      dependencies: {
        note: '判的是「本次运行期一个字都没写它们」（boot = end），不是「等于某张卡昨天的快照」',
        anchors: anchorRowsForEvidence,
        staleRecords,
        ledgerSyncs,
        landings,
        deliverableContentLock: contentLock.rows,
        'ledger-transaction.cjs@HEAD': { sha256: sha256(Buffer.from(headText, 'utf8')), u01Locked: true, insertOnly: isLineSubsequence(headText, curText) },
      },
      writeSet: WRITE_SET,
      sharedTree: {
        note: '共享工作树里别的 lane/卡的合法改动**只登记不归因**（本卡的判据不锚定它们的字节数）',
        changes: gitStatus().slice(0, 40),
      },
    },
    'anchors.json': {
      card: CARD, head, criterion, selfProof,
      bootAndEnd: anchorRowsForEvidence,
      attribution,
      attributedDrift,
      staleRecords,
      ledgerSyncs: ledgerSyncs.map((d) => ({ id: d.id, kind: d.kind, touchesInterfaceLock: d.touchesInterfaceLock, landings: d.landings, files: d.files })),
      landings,
      contentLock: contentLock.rows,
      anchorWrites: anchorWrites.length,
      wildPathProbe: EVID.anchorWildPathProbe ?? null,
    },
    'gate-matrix.json': { card: CARD, head, gates: C.COMMIT_GATES, codes: EVID.gates.codes, planKeys: EVID.gates.planKeys, fileKeys: EVID.gates.fileKeys, samples: EVID.samples },
    'states.json': { card: CARD, head, ...EVID.states },
    'recovery.json': { card: CARD, head, ...EVID.recovery },
    'mutation.json': { card: CARD, head, ...EVID.mutation },
    'write-guard.json': {
      card: CARD, head,
      tempRoot: TEMP_ROOT, runTmp: RUN_TMP,
      allowedRoots: allowed.roots, allowedExact: allowed.exact.map((p) => path.relative(REPO, p).replace(/\\/g, '/')),
      recordedWrites: entries.length, ops, offScopeProbe: offScope.map((x) => x.op), violations: violations.length,
      anchorWrites: anchorWrites.length,
      sampled: entries.filter((x) => x.op === 'renameSync').slice(0, 8).map((x) => path.basename(x.path)),
    },
  }
  const written = []
  for (const [name, doc] of Object.entries(evidenceFiles)) {
    const abs = path.join(EV, name)
    fs.writeFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    const buf = fs.readFileSync(abs)
    ok(buf.length > 0, `证据 ${name} 写出来是空的`)
    eq(JSON.parse(buf.toString('utf8')).card, CARD, `证据 ${name} 回读不对`)
    written.push({ file: name, bytes: buf.length, sha256: sha256(buf) })
  }
  ok(fs.existsSync(CARD_EV), '本卡证据目录必须显式存在')
  EVID.guard = {
    recordedWrites: entries.length, ops, violations: violations.length,
    offScopeProbe: offScope.length, sentinel: true, evidence: written,
  }

  /* ── ⑩ 收口前再比一次（证据都写完之后的真·收口快照） ─────────────── */
  const finalAnchors = snapshotAnchors()
  const clsFinal = classifyAnchors({ anchors: anchorRows(BOOT_ANCHORS, finalAnchors, receipts), writes: entries })
  eq(clsFinal.violations.length, 0,
    `收口时锚点判据出现红（本卡运行期写过/交付物内容锁破了）：${JSON.stringify(clsFinal.violations.slice(0, 3))}`)
  for (const spec of ANCHOR_SPECS) {
    eq(finalAnchors[spec.rel].sha256, endAnchors[spec.rel].sha256,
      `${spec.rel} 在证据落盘之后又被改了（收口 ${finalAnchors[spec.rel].sha256} / 开跑 ${BOOT_ANCHORS[spec.rel].sha256}）`)
  }

  /* ── ⑪ 清理本次运行目录（核对绝对路径与归属后再删） ──────────────── */
  const cleanup = safeRemoveTree(RUN_TMP, { parent: TEMP_ROOT })
  eq(cleanup.removed, true, `本次临时目录清理必须成功：${cleanup.error}`)
  ok(!fs.existsSync(RUN_TMP), '清理后临时目录必须消失')
  eq(fs.readdirSync(TEMP_ROOT).filter((n) => n.startsWith(`U06-${process.pid}`)).length, 0, '清理后临时根下不许再有本次运行的目录')
  ok(Array.isArray(written) && written.length === 7, '证据索引必须记下七份文件')
}

/** 进程内写守卫：把 fs 的写能力包一层，记下**绝对路径**（只记账、不改变成功与否） */
function installWriteGuard() {
  const log = []
  const saved = {}
  const ops = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'cpSync', 'renameSync', 'rmSync', 'unlinkSync', 'rmdirSync']
  const push = (op, p) => {
    if (p === undefined || p === null) return
    log.push({ op, path: path.resolve(String(p)) })
  }
  for (const op of ops) {
    const orig = fs[op]
    if (typeof orig !== 'function') continue
    saved[op] = orig
    fs[op] = function (a, ...rest) {
      push(op, a)
      if (op === 'renameSync' || op === 'cpSync') push(op, rest[0])
      return orig.call(fs, a, ...rest)
    }
  }
  return {
    log,
    uninstall() {
      for (const [op, fn] of Object.entries(saved)) fs[op] = fn
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
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

let verdict
try {
  verdict = await runCard(CARD, FIXED_IDS, CASES, {
    argv: ARGV,
    blocked: ROOTS.ok ? null : ROOTS.error,
  })
} finally {
  // 兜底清理（A08 已经清过一次；任何一例提前炸了也别留残渣）
  if (fs.existsSync(RUN_TMP)) {
    const g = guardTempPath(RUN_TMP, { parent: TEMP_ROOT })
    if (g.ok) safeRemoveTree(RUN_TMP, { parent: TEMP_ROOT })
  }
}
if (!verdict) {
  process.stdout.write(`BLOCKED ${CARD} runner 未产出判词\n`)
  process.exitCode = 2
} else {
  if (EV) writeRunEvidence(verdict, EV)
  process.exitCode = printVerdict(verdict)
}
