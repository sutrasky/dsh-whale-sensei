#!/usr/bin/env node
/**
 * test/audit/U04.mjs —— 文本 / 大纲 / 指纹内核收为单一源码（U04 专项入口）
 * ==================================================================
 * 卡面三项交付：`lib/unify/{text,plan,fingerprint}.cjs` 是**唯一手工源码**；
 * `lib/{text,plan,fingerprint}.js` 只做 ESM 适配（导出面/默认值/返回形状逐字保留）；
 * `lib/pack-template/tools/{pack-text,plan-map,fingerprint}.js` 只做**纯委托**。
 *
 * 两个根（必须分开）：
 *   **读取根恒为 `<repo>/audit-evidence/U04`** —— 改前采集材料（`pre-change.json` /
 *   `fixtures.mjs` / `capture-baseline.mjs`）。`--evidence-root=<绝对路径>` **只决定本次运行
 *   产物写哪儿**，不改读取根、不覆盖既有采集证据（守卫照旧）；缺材料 ⇒ BLOCKED。
 *
 * 判词（stdout 一行，exit 0/1/2）：
 *   `PASS U04 checks=8 failed=0 skipped=0` / `FAIL U04 …` / `BLOCKED U04 …`
 *
 * 八项判据都是**改前 vs 改后**的真对拍（没有恒真项）：
 *   A01 文本边界逐例（BOM 开头/中间行/无 BOM/空串/CRLF/纯空白/null/undefined/数字/…，
 *       含 `parseJsonLoose` 的报错形状与 `what` 前缀）与改前一致；
 *   A02 大纲校验/闸/摘要/节点/前沿逐例与改前一致（含支线两颗星、exhausted、乱序、sources 简写）；
 *   A03 指纹与改前逐值一致（多目录/中文名/CRLF/BOM 归一/SKIP_DIR/确定性/反空转）+ PROBE_VERSION；
 *   A04 导出面与常量完整保留（含 ESM↔CJS 桥的**函数同一性**；PROBE_VERSION 字面量全仓唯一；
 *       PROBE_SOURCES 11 件逐字逐序 + 顺序规则 —— 决-4 把清单 9→11，前 9 条逐字不变、新增 2 条
 *       有授权出处（`docs/unify/authorization.json` 的 decisions.approvedChanged 决-4））；
 *   A05 包侧只剩委托（源码层：无函数体式计算、无第二份常量、只 require `./unify/<mod>.cjs`）
 *       + 在 E:\Temp 自建包复制权威模块后运行时等价；
 *   A06 独立包可加载、不依赖仓外路径（子进程从**仓外 cwd** require，两次不同 cwd 结果相同）；
 *   A07 把指纹临时改成常量（E:\Temp 副本）→ A03 的判据必须**失败**（含未变异对照）；
 *   A08 证据与越界守卫有效（**可归因**口径，见下方「判据范围修正」：进程内 fs 写守卫 +
 *       授权写集并集（tracked 侧）+ 本卡交付物内容锁 + U01 采集证据内容锁（只锁运行开始时
 *       看见过的那批文件；新增只登记）+ U01 关键产物外部锚点（只在**本卡运行期被写**时红）
 *       + 不统计他卡文件数/字节数；`--evidence-root` 守卫；临时目录按绝对路径归属清理；
 *       回执五项 + Δ 齐）。
 *
 * A07 的变异只发生在 `E:\Temp` 本次唯一目录里，跑完按绝对路径守卫清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  FIXED_IDS, REPO, runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot,
  guardTempPath, safeRemoveTree, Blocked,
} from './unify-runner.mjs'

const CARD = 'U04'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const ARGV = process.argv.slice(2)

/** 改前采集材料（**读取根恒定**，不受 --evidence-root 影响） */
const BASELINE_ROOT = path.join(REPO, 'audit-evidence', CARD)
const PRE_FILE = path.join(BASELINE_ROOT, 'pre-change.json')
const FIXTURES_FILE = path.join(BASELINE_ROOT, 'fixtures.mjs')
const CAPTURE_FILE = path.join(BASELINE_ROOT, 'capture-baseline.mjs')

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

/** 权威内核与三个适配层（本卡写集的前 9 项） */
const KERNEL = {
  text: 'lib/unify/text.cjs',
  plan: 'lib/unify/plan.cjs',
  fingerprint: 'lib/unify/fingerprint.cjs',
}
const HOST = {
  text: 'lib/text.js',
  plan: 'lib/plan.js',
  fingerprint: 'lib/fingerprint.js',
}
const PACK = {
  text: 'lib/pack-template/tools/pack-text.js',
  plan: 'lib/pack-template/tools/plan-map.js',
  fingerprint: 'lib/pack-template/tools/fingerprint.js',
}
/** 卡面写集（相对仓根）—— A08 的越界守卫以它为准 */
const WRITE_SET = [
  ...Object.values(KERNEL),
  ...Object.values(HOST),
  ...Object.values(PACK),
  'test/audit/U04.mjs',
  'docs/unify/receipts/U04.json',
]
/** 改前存在、改后必须逐例保留的导出面（A04） */
const EXPECTED = {
  hostText: ['stripBom', 'splitLines', 'parseJsonLoose'],
  hostPlan: ['PLAN_KEYS', 'NODE_KEYS', 'validatePlan', 'planGate', 'summarizePlan', 'planNode', 'planFrontier', 'summarizeFrontier'],
  hostFp: ['digestTree', 'PROBE_SOURCES', 'PROBE_VERSION'],
  packText: ['stripBom', 'splitLines', 'parseJsonLoose'],
  packPlan: ['PLAN_KEYS', 'NODE_KEYS', 'validatePlan', 'planFrontier', 'summarizePlan', 'summarizeFrontier', 'planNode'],
  packFp: ['digestTree', 'PROBE_VERSION'],
}
/**
 * PROBE_VERSION 的**现行**字面量（P1/P2 的实施动作；授权落账见 `docs/unify/authorization.json`
 * 的 scope.P1/P2 与 derivedConsequences.C1/C2）——
 * 不再钉死历史的 `p:e3472ea71c33181c`：U04/U09/U18 合法改过 9 个探针源里的 6 个，P1 按**同一算法**
 * 重算过一次，值合法地变了。口径改成「与权威内核那一份唯一字面量一致」，值本身仍被三条判据钉住：
 * 与内核一致（A03/A04）+ 形状 `p:<16hex>`（A03）+ 与 PROBE_SOURCES 现算重算值一致（A03）。
 * 判据强度不降：旧口径比的是一个**常量**，新口径把常量与源码重新绑在一起（改了源不改值 = 红）。
 */
const PROBE_LITERAL_RX = /PROBE_VERSION\s*=\s*'([^']*)'/g
/** 一份源码里 `PROBE_VERSION = '…'` 这种**赋值**的值列表（只数活代码：注释里引用旧写法不算） */
function probeLiteralHits(src) {
  const live = String(src).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  return [...live.matchAll(PROBE_LITERAL_RX)].map((m) => m[1])
}
/** 按 `lib/fingerprint.js` 注释里的算法**逐字**重算：PROBE_SOURCES 顺序 / 文件间 '\0'（首尾不留）/ 原始字节 / 前 16 位 hex / 冠 'p:' */
function recomputeProbeVersion(sources) {
  const parts = []
  sources.forEach((relPath, i) => {
    if (i) parts.push(Buffer.from('\0'))
    parts.push(fs.readFileSync(path.join(REPO, ...relPath.split('/'))))
  })
  return 'p:' + crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex').slice(0, 16)
}
/**
 * 改前基线（`audit-evidence/U04/pre-change.json`）里的指纹用例 fp13 记的是**旧的** PROBE_VERSION 值。
 * P1 按同一算法重算后值合法地变了 ⇒ 与基线逐值比对时把 fp13 的 `value` 这一格**归一**
 * （`shaped` 等其余字段照比；值本身由 A03 的三条判据钉住：内核字面量 / 形状 / 与 PROBE_SOURCES 重算一致）。
 * 这是 C2 授权面的实现细节，不涉及别的用例。
 */
const PROBE_BASELINE_ROW = '<PROBE_VERSION 现值：不钉旧值，见 A03 的三条判据>'
function normProbeRow(row) {
  if (!row || row.id !== 'fp13' || !row.result || typeof row.result !== 'object') return row
  return { ...row, result: { ...row.result, value: PROBE_BASELINE_ROW } }
}
/** 权威内核里**唯一**那个字面量的当前值（读不到 / 不是恰好一份 → null，让断言当场红） */
const PROBE_LITERAL = (() => {
  const hits = probeLiteralHits(fs.readFileSync(path.join(REPO, KERNEL.fingerprint), 'utf8'))
  return hits.length === 1 ? hits[0] : null
})()
/**
 * PROBE_SOURCES 的**现行**清单（11 件）与它的**排序规则** —— 授权出处 = `decisions.approvedChanged` 决-4
 * （用户在 U 系列统筹会话里的「全按推荐」，逐字见 authorization.json 的 quoteVerbatim）。
 *
 * 决-4 把清单从 **9 件补到 11 件**：`lib/pack-model.js` 现已在用的两个内核 —— `lib/unify/identity.cjs`
 * 与 `lib/unify/pack.cjs` —— 此前漏记（内核改动不会让旧快照过期）。两条都插在 `lib/text.js` 之后
 * （字节序 t < u），identity 在 pack 之前；**前 9 条一条没动、没重排**。
 *
 * ⚠️ 改前采集材料 `audit-evidence/U04/pre-change.json` **一字未动**（它是采集证据，不是判据）：
 *    变的是**口径** —— 旧口径「必须与改前那 9 件逐字相同」在决-4 之后不再成立（清单合法地长了），
 *    换成两条更细的：① 前 9 条（改前那批）逐字且顺序不变；② 尾部新增的 2 条必须有授权出处。
 *    强度不降：整份清单仍被**逐字逐序**钉死（值 + 顺序都比），Δ 只允许以"尾部新增 + 有授权"的形状出现。
 */
const PROBE_ENTRIES = ['lib/state.js', 'lib/state-scan.js']          // 探针的入口两件（顺序固定）
const PROBE_ADDED_BY_D4 = ['lib/unify/identity.cjs', 'lib/unify/pack.cjs']  // 决-4 新增的 2 条
const PROBE_SOURCES_NOW = [
  ...PROBE_ENTRIES,
  'lib/adapters/jvm.js', 'lib/evidence-io.js', 'lib/evidence.js', 'lib/exec.js',
  'lib/pack-model.js', 'lib/plan.js', 'lib/text.js',
  ...PROBE_ADDED_BY_D4,
]
/** 字节序比较（纯函数：顺序规则与它的反例自证共用同一套比较，不许"判据一套、排序另一套"） */
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isByteSorted = (xs) => xs.every((x, i) => i === 0 || byteOrder(xs[i - 1], x) <= 0)
/** 包侧每个导出的**类型期望**（`frozen` = 冻结数组；改前实测见 pre-change.json 的 packExports + 类型） */
const PACK_TYPES = {
  text: { stripBom: 'function', splitLines: 'function', parseJsonLoose: 'function' },
  plan: {
    PLAN_KEYS: 'frozen', NODE_KEYS: 'frozen', validatePlan: 'function', planFrontier: 'function',
    summarizePlan: 'function', summarizeFrontier: 'function', planNode: 'function',
  },
  fingerprint: { digestTree: 'function', PROBE_VERSION: 'string' },
}

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { cases: {}, comparisons: {}, temp: RUN_TEMP }

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')
const rowJson = (row) => JSON.stringify({ result: row.result, error: row.error })
const rowsJson = (rows) => JSON.stringify(rows.map(rowJson))
/** 大纲行的**整行**比较（它的形状是 {validate, gate, summary, …}，不是 {result}） */
const planRowJson = (row) => JSON.stringify(row)
/** 宿主独有 `gate` 投影掉之后的大纲行（包侧没有 planGate：共有部分才可比） */
const planComparable = (row) => {
  const { gate, ...rest } = row
  return rest
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
/** 报错里把值说清楚（函数用 JSON.stringify 会变成 undefined —— 那正是"看不出哪个不一样"的坑） */
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

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（判据范围修正）
 * ──────────────────────────────────────────────────────────────────────
 * 原 A08 ③ 拿「改前整树逐文件清单」跟「现在的树」全量对拍。在「一个工作树、多 lane
 * 并发」的编排下这条判据**结构性假红**：同树的 U06 / U07 / U01 落的是他们**自己**的
 * 合法写集（`lib/render.js`、`lib/pack-template/tools/build-lessons.js`、
 * `lib/pack-template/tools/ledger-transaction.cjs`、`tools/recover-ledgers.mjs`、
 * `docs/unify/baseline.json`），全树对拍把这些算到本卡头上，而且会随兄弟卡进度反复红。
 * 判据换成四条**可归因**的口径（强度不降，真越界一条都跑不掉）：
 *   ① 进程内 fs 写守卫 —— 本卡**本次进程**的每一次写都必须落在
 *      { 写集 11 项 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 } 之内；
 *      并且用一次**探针写**自证守卫真的挂上了、真的记得到。
 *   ② 授权写集并集（tracked 侧）—— `git status --porcelain -uall` 的 tracked 改动
 *      （M/D/A/R）必须 ⊆ U01–U20 全部卡授权写集的并集。并集来源 = `docs/unify/interfaces.md`
 *      §6 落点表，**独立解析**（不 import U01 的 AUTHORIZED_WRITE_SET：两张卡的入口互不依赖）。
 *      越出并集的路径判红；判定本身用纯函数人造输入双向自证（野路径红 / 兄弟 lane 放行）。
 *   ③ 本卡交付物内容锁 —— 11 个文件改完后记录的 sha256，在本次运行结束时必须仍等于实际值
 *      （防止别人手改本卡交付物）。改前↔改后逐字节对拍仍是 A01–A07 的判据，一条没动。
 *   ④ 不统计他卡的文件数 / 字节数 —— `audit-evidence/U01` 的文件数、`docs/unify/*` 的体积
 *      一概不当判据（U01 每复验一次就往 runs/ 多一个 U01-* 目录；兄弟卡还会改 docs/unify 的件）。
 *
 * ── 第二批判据范围修正（DELTA-7 · 证据新鲜度判据换成可归因口径）────────────────
 * 被删的判据：「`audit-evidence/U01` 下 `runs/` 之外的文件 mtime 必须早于本卡改前采集时刻，
 * 且采集之后新增的只能是 `runs/` 下的文件」。整合 lane 期间，主持人派出的**授权写集账本
 * 同步**任务在 `audit-evidence/U01/` 落下了 `ledger-sync-*.txt`（另一笔授权工作的合法产物）
 * —— 这条判据把它算成 U04 越界。不可归因的理由：mtime 只说明「被写过」，说不出「谁写的」；
 * 在「一个工作树、多 lane」下，任何授权工作往 U01 证据目录落文件都会让本卡假红，而且它与
 * U01 自己的 A08 重复（U01 的 A08 仍在断言它自己的采集证据不变）。替代三条（强度对照见回执
 * `deltas[kind=evidence-recency-criterion-realignment]`）：
 *   ⑤ U01 采集证据**内容锁** —— 本次运行开始时，对 `audit-evidence/U01/` 下**我当时看见过的
 *      那批文件**逐个记 sha256，收口前再比一次必须相同（内容变了 / 文件没了 → 红）；
 *      运行期**新增**的文件只登记条数与文件名，**不作失败判据**（账本同步那批正是新增）。
 *      只锁「已看见的」，所以不会因为别人的合法新增而红；销掉的是原判据的不可归因部分。
 *   ⑥ U01 关键产物**外部锚点** —— `docs/unify/interfaces.md`、`docs/unify/baseline.json`、
 *      `audit-evidence/U01/evidence-index.json` 与 U01 登记值（回执字节数 / baseline.json 的
 *      逐文件 sha256 / 改前快照 sha256）不同时**只登记 + 按 §6 归属**（前两个归 U01）；
 *      只有当它们**在本卡运行期被写**（本进程写守卫记到，或运行起止 sha 变了）时才红。
 * 归因逻辑：越出 ① 的写 = **本卡**越界写（精确到本进程，这才是「我没越界」的判据）；
 * 越出 ② 的 tracked 改动 = 这棵工作树上有**未授权**的改动（点名到路径，不按路程分摊）；
 * ③ 抓「本卡交付物在运行期间被手改」；⑤ 抓「本卡运行期 U01 采集证据内容被改写/删除」；
 * ⑥ 抓「本卡运行期动了 U01 的关键产物」（其余差异只点名归属，不判红）。
 * ══════════════════════════════════════════════════════════════════════ */

/** 直接运行 vs 被 import（自证脚本要 import 纯函数，但不许触发整卡执行/挂守卫） */
const IS_MAIN = (() => {
  const arg = process.argv[1]
  if (!arg) return false
  try { return pathToFileURL(path.resolve(arg)).href === pathToFileURL(SELF).href } catch { return false }
})()

/** 写入根的解析（越界即 BLOCKED，不写一个字节）—— A08 的写守卫也要用，故提到最前 */
const evidenceGuard = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })

/* ── ③-1 · 进程内 fs 写守卫 ─────────────────────────────────────────────── */

const WRITE_GUARD = {
  installed: false,
  scope: null,
  patched: [],
  writes: [],      // {op, api, target, allowed, why}
  violations: [],
  probe: null,
  probeError: null,
}

/** 本卡本次的**写允许面**：写集 11 项的精确绝对路径 + { 本次临时根, 本卡证据根 } 两个目录前缀 */
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
 * **纯函数**：一个写入目标是否属于「本卡本次」的允许面。
 * 相对路径按 scope.repoRoot 解析（人造输入友好）；不读盘、无副作用。
 * @returns {{allowed:boolean, why:string, abs:string}}
 */
export function classifyWriteTarget(rawTarget, scope) {
  const s = scope ?? writeAllowScope()
  const abs = path.resolve(s.repoRoot ?? REPO, String(rawTarget))
  if (s.files.has(abs)) return { allowed: true, why: '本卡写集 11 项之一', abs }
  for (const root of s.roots ?? []) {
    const r = path.resolve(root)
    if (abs === r || abs.startsWith(r + path.sep)) return { allowed: true, why: `本卡允许根 ${r}`, abs }
  }
  return { allowed: false, why: '既不在本卡写集 11 项里，也不在本卡证据根 / E:\\Temp 本次临时根之内', abs }
}

/** 挂守卫的写入口：[名字, op, 取哪个实参当目标] */
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
const FS_PROMISE_WRITES = FS_CB_WRITES.slice()

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
  for (const spec of FS_PROMISE_WRITES) mount(fs.promises, 'fs.promises', spec)
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

/**
 * **探针写**：往 E:\Temp 本卡本次临时根写一个字节，再回来查守卫**有没有记到它**。
 * 这是"守卫真的挂上了"的自证；没有这一步，"零越界"可能只是守卫没工作。
 */
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

/* ── ③-2 · 授权写集并集（tracked 侧） ───────────────────────────────────── */

/**
 * `docs/unify/interfaces.md` §6 表里"看起来像路径"的记号：含 `/`，或带文件扩展名
 * （`package.json` 这种没斜杠的落点也要收）。`† A01` 这类用例 ID 不含斜杠也没扩展名，自然略过。
 */
const SECTION6_TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const looksLikeRepoPath = (s) => SECTION6_TOKEN_RX.test(s) && (s.includes('/') || /\.[A-Za-z]{2,4}$/.test(s))

/**
 * 把 `docs/unify/interfaces.md` 的 **§6 表**解析成 `Map<卡号, 路径[]>`。
 * 与 U01 的 AUTHORIZED_WRITE_SET **同源不同实现**：这里重新读 §6 的现文本解析，
 * 不 import 兄弟卡的常量（真值是接口锁那张表，两边各自算自己的账）。纯函数。
 */
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

/** 授权并集（U01–U20 全部卡的落点拍平去重） */
export function authorizedUnion(sets) {
  const u = new Set()
  for (const paths of sets.values()) for (const p of paths) u.add(p)
  return u
}

/** 路径 → 拥有它的卡（§6 里可能多卡共有；用于把 tracked 改动点名到卡，仅供登记） */
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

/** `git status --porcelain=v1` 的一行行 → { tracked: [{code,path,from}], untracked: [path] }（纯函数） */
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

/**
 * **纯函数**：tracked 改动（M/D/A/R）是否都落在授权并集里。
 * 返回 { allowed, outOfBounds }（空 outOfBounds = 这棵工作树没有未授权的 tracked 改动）。
 * 注意它**只判 tracked 侧**：未跟踪路径的授权面归 U01 的 A01 管（它用同一张 §6 表 +
 * cards/U*.md / docs/unify/ / audit-evidence/ 三条补充规则）；本卡自己的写由 ① 守卫管。
 */
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
 * A08 的**红路径本体**之一（纯函数自证）：喂人造 porcelain 行，双向钉死。
 *   ① 这棵多 lane 树上兄弟 lane 的真实形状（U01/U06/U07 正在改的已跟踪件）必须放行；
 *   ② §6 并集之外的野路径（新增/删除/改名）必须判越界；
 *   ③ 混合输入里只抓野的那条（不许一红全红，也不许被合法的淹掉）。
 * 这些用例**每次运行都跑**（A08 里断言 failures 为空），任何一条被改成恒真当场红。
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
  // ① 兄弟 lane 的真实形状（这 5 个文件正是旧判据假红的那 5 个）
  one(' M docs/unify/baseline.json', 'allow', 'U01 的出口（正在补记偏差）')
  one(' M lib/render.js', 'allow', 'U07 写集（并发改）')
  one(' M lib/pack-template/tools/build-lessons.js', 'allow', 'U07 写集（并发改）')
  one(' M lib/pack-template/tools/ledger-transaction.cjs', 'allow', 'U06 写集（并发改）')
  one(' M tools/recover-ledgers.mjs', 'allow', 'U06 写集（并发改）')
  one(' M lib/unify/text.cjs', 'allow', '本卡（U04）写集')
  one('A  lib/unify/identity.cjs', 'allow', 'U02 的新增内核（staged add 的路径仍在并集里）')
  // ② 野路径：新增 / 修改 / 删除 / 改名，四种形状都要红
  one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
  one(' M scripts/x.mjs', 'reject', '野路径（仓里没有 scripts/ 这个落点）')
  one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
  one(' D test/all.mjs', 'reject', '既有总入口被删（不在任何卡写集）')
  one('R  lib/render.js -> lib/whatever.js', 'reject', '改名到野路径（来源合法、目标不合法）')
  one('A  cards/U01.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
  // ③ 混合输入：只有野的那条被抓
  {
    const mixed = classifyTrackedWrites(
      splitPorcelainTracked([' M lib/text.js', ' M lib/render.js', ' M scripts/x.mjs']).tracked, union)
    const got = mixed.outOfBounds.map((v) => v.path).join(',')
    rows.push({
      line: 'MIX[ M lib/text.js | M lib/render.js | M scripts/x.mjs]', expect: 'scripts/x.mjs', got,
      ok: got === 'scripts/x.mjs' && mixed.outOfBounds.length === 1, why: '混合输入只抓野路径',
      outOfBounds: mixed.outOfBounds.map((v) => v.path),
    })
  }
  return { unionSize: union.size, cards: parsed.size, rows, failures: rows.filter((r) => !r.ok) }
}

/**
 * A08 的**红路径本体**之二（纯函数自证）：写允许面的边界。
 * 同一批路径在**两张账上结论相反**——这正是归因修正的要点：
 *   U07 写集 `lib/render.js` 在 ② 里**放行**（兄弟可以写），在 ① 里**判越界**（本卡不许写）。
 */
export function proveWriteScope(scope) {
  const s = scope ?? writeAllowScope()
  const cases = [
    ['lib/unify/text.cjs', 'allow', '本卡写集（权威内核）'],
    ['docs/unify/receipts/U04.json', 'allow', '本卡写集（tracked 回执）'],
    ['test/audit/U04.mjs', 'allow', '本卡写集（本入口）'],
    [path.join(s.roots[0], 'pack-a05', 'tools', 'unify', 'text.cjs'), 'allow', 'E:\\Temp 本次临时根下的自建包'],
    // 兄弟 lane 的合法写入，对**本卡进程**一律判越界（我能写它们才是真越界）
    ['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
    ['lib/render.js', 'reject', 'U07 写集 —— 同上'],
    ['lib/pack-template/tools/build-lessons.js', 'reject', 'U07 写集 —— 同上'],
    ['lib/pack-template/tools/ledger-transaction.cjs', 'reject', 'U06 写集 —— 同上'],
    ['tools/recover-ledgers.mjs', 'reject', 'U06 写集 —— 同上'],
    // 野路径
    ['lib/whatever.js', 'reject', '野路径'],
    ['lib/unify/records.cjs', 'reject', '别卡（U18）的内核落点 —— 不在本卡写集里，写就是越界'],
    ['test/_pack.mjs', 'reject', '既有测试'],
    [path.join(TEMP_PARENT, 'u04-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
    ['C:\\Windows\\u04-x.txt', 'reject', '与仓无关的绝对路径'],
  ]
  const rows = cases.map(([p, expect, why]) => {
    const c = classifyWriteTarget(p, s)
    const got = c.allowed ? 'allow' : 'reject'
    return { path: p, expect, got, ok: got === expect, why }
  })
  return { rows, failures: rows.filter((r) => !r.ok), roots: s.roots.slice() }
}

/* ── ③-3 · 本卡交付物内容锁 ─────────────────────────────────────────────── */

const CONTENT_LOCK = { recordedAt: null, hashes: new Map(), checks: 0 }

/** 记录本卡 11 个交付物**当前**的 sha256（A08 在写完之后调一次） */
export function recordContentLock() {
  CONTENT_LOCK.hashes.clear()
  for (const p of WRITE_SET) {
    const abs = path.join(REPO, p)
    assert(fs.existsSync(abs), `内容锁：写集文件不见了 ${p}`)
    CONTENT_LOCK.hashes.set(p, sha256(fs.readFileSync(abs)))
  }
  CONTENT_LOCK.recordedAt = CONTENT_LOCK.hashes.size
  return { size: CONTENT_LOCK.hashes.size, hashes: [...CONTENT_LOCK.hashes] }
}

/** 本次运行结束时复核：记录值必须仍等于实际值（别人手改我的交付物 → 红） */
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

/* ── ③-4 · U01 采集证据内容锁（DELTA-7 的判据 ⑤） ─────────────────────────
 * 口径：**只锁我在本次运行开始时看见过的那批文件**。运行期新增的文件只登记（条数 + 文件名），
 * 不是失败判据 —— 账本同步那批 `ledger-sync-*.txt` 正是"别人的合法新增"。
 * 内容变了、文件没了 ⇒ 本卡运行期被改写/删除 ⇒ 红。
 * ──────────────────────────────────────────────────────────────────────── */

const U01_EV_ROOT = path.join(REPO, 'audit-evidence', 'U01')
const U04_PRE_TREE = () => { try { return new Map((pre().guard.tree || []).map((e) => [e.path, e])) } catch { return new Map() } }

/** 递归读一个目录 → Map<相对路径(posix), {sha256, bytes, mtimeMs}>（失败项记 null，不抛） */
export function snapshotEvidenceTree(root) {
  const out = new Map()
  const walk = (dir, prefix) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const relp = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { walk(abs, relp); continue }
      if (!e.isFile()) continue
      try {
        const st = fs.statSync(abs)
        out.set(relp, { sha256: sha256(fs.readFileSync(abs)), bytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        out.set(relp, { sha256: null, bytes: null, mtimeMs: null })
      }
    }
  }
  walk(root, '')
  return out
}

/**
 * **纯函数**：两份证据快照的差异。before = 运行开始时看见的（锁）；after = 收口前再看的。
 * added 只登记（别人的合法新增），changed / missing 才是红。人造输入友好：也接受
 * `{路径: 'sha…'}` 或 `{路径: {sha256}}` 两种形状。
 */
export function diffEvidenceSnapshot(before, after) {
  const norm = (s) => {
    if (s instanceof Map) return s
    const m = new Map()
    for (const [k, v] of Object.entries(s ?? {})) m.set(k, v)
    return m
  }
  const b = norm(before)
  const a = norm(after)
  const wantSha = (v) => (typeof v === 'string' ? v : v?.sha256 ?? null)
  const changed = []
  const missing = []
  for (const [p, want] of b) {
    if (!a.has(p)) { missing.push(p); continue }
    if (wantSha(want) !== wantSha(a.get(p))) changed.push({ path: p, want: wantSha(want), got: wantSha(a.get(p)) })
  }
  const added = []
  for (const p of a.keys()) if (!b.has(p)) added.push(p)
  added.sort()
  return {
    locked: b.size,
    observed: a.size,
    added,
    changed,
    missing,
    reds: [
      ...missing.map((p) => ({ path: p, kind: 'missing' })),
      ...changed.map((c) => ({ path: c.path, kind: 'changed', want: c.want, got: c.got })),
    ],
  }
}

/** U01 登记的逐文件 sha256（两份账：evidence-index.json 与 baseline.json 的 evidence.files） */
function u01RegisteredManifest() {
  const readJson = (p) => { try { return JSON.parse(readText(p)) } catch { return null } }
  const pick = (doc) => (Array.isArray(doc?.files) ? doc.files : [])
    .filter((f) => f && typeof f.file === 'string' && /^[0-9a-f]{64}$/.test(String(f.sha256 || '')))
    .map((f) => ({ path: `audit-evidence/U01/${f.file}`, sha256: String(f.sha256), bytes: f.bytes ?? null }))
  const idx = readJson(path.join(U01_EV_ROOT, 'evidence-index.json'))
  const base = readJson(path.join(REPO, 'docs', 'unify', 'baseline.json'))
  const fromIndex = pick(idx)
  const fromBase = pick(base?.evidence)
  const key = (rows) => rows.map((r) => `${r.path} ${r.sha256}`).sort().join('\n')
  const agree = fromIndex.length > 0 && key(fromIndex) === key(fromBase)
  const byPath = new Map()
  for (const r of [...fromIndex, ...fromBase]) if (!byPath.has(r.path)) byPath.set(r.path, r)
  return {
    files: [...byPath.values()],
    count: byPath.size,
    fromIndex: fromIndex.length,
    fromBaseline: fromBase.length,
    agree,
    sources: ['audit-evidence/U01/evidence-index.json', 'docs/unify/baseline.json#evidence.files'],
  }
}

/**
 * 运行开始时的锁：U01 整棵证据树的内容 + U01 登记清单（登记清单用来回答
 * "改前快照里已经记录过的那批文件是什么"，锁的实际范围是**运行开始时看见的全部文件**，
 * 登记清单是它的子集，并在收口时逐个核对登记 sha 仍相同）。
 */
const U01_LOCK = { recordedAt: null, entries: null, manifest: null, registeredMismatch: null }

export function recordU01EvidenceLock() {
  if (U01_LOCK.entries) return U01_LOCK
  U01_LOCK.recordedAt = new Date().toISOString()
  U01_LOCK.entries = snapshotEvidenceTree(U01_EV_ROOT)
  U01_LOCK.manifest = u01RegisteredManifest()
  const mismatch = []
  for (const f of U01_LOCK.manifest.files) {
    const got = U01_LOCK.entries.get(f.path.slice('audit-evidence/U01/'.length))
    if (!got) mismatch.push({ path: f.path, kind: 'missing-at-start' })
    else if (got.sha256 !== f.sha256) mismatch.push({ path: f.path, kind: 'differs-from-registered', registered: f.sha256, actual: got.sha256 })
  }
  U01_LOCK.registeredMismatch = mismatch
  return U01_LOCK
}

/** 收口/复核：与运行开始时的快照比一次（新增只登记；changed/missing 才是红） */
export function verifyU01EvidenceLock() {
  if (!U01_LOCK.entries) return { recorded: false, locked: 0, reds: [], added: [], changed: [], missing: [] }
  const now = snapshotEvidenceTree(U01_EV_ROOT)
  const d = diffEvidenceSnapshot(U01_LOCK.entries, now)
  return {
    recorded: true,
    recordedAt: U01_LOCK.recordedAt,
    locked: d.locked,
    observed: d.observed,
    added: d.added,
    changed: d.changed,
    missing: d.missing,
    reds: d.reds,
    manifest: {
      count: U01_LOCK.manifest.count,
      fromIndex: U01_LOCK.manifest.fromIndex,
      fromBaseline: U01_LOCK.manifest.fromBaseline,
      agree: U01_LOCK.manifest.agree,
      sources: U01_LOCK.manifest.sources,
      mismatchAtStart: U01_LOCK.registeredMismatch.length,
    },
    entries: U01_LOCK.entries,
  }
}

/* ── ③-5 · U01 关键产物的外部锚点（DELTA-7 的判据 ⑥） ────────────────────
 * 三个锚点只在**本卡运行期被写**时红（写守卫记到，或运行起止 sha 变了）；
 * 与登记值/改前快照不同只登记 + 按 §6 归属（interfaces.md / baseline.json 归 U01）。
 * ──────────────────────────────────────────────────────────────────────── */

const U01_ANCHORS = [
  { path: 'docs/unify/interfaces.md', owner: 'U01', receiptBytesKey: 'lockBytes' },
  { path: 'docs/unify/baseline.json', owner: 'U01', receiptBytesKey: 'baselineBytes' },
  { path: 'audit-evidence/U01/evidence-index.json', owner: 'U01（U01 证据根）', receiptBytesKey: null },
]

const ANCHOR_START = new Map()   // path -> {sha256, bytes}

/** 运行开始时记下三个锚点的实际内容（"我当时看见的"），收口时与它比 */
export function recordAnchorStart() {
  if (ANCHOR_START.size) return ANCHOR_START
  for (const a of U01_ANCHORS) {
    const abs = path.join(REPO, a.path)
    try {
      const buf = fs.readFileSync(abs)
      ANCHOR_START.set(a.path, { sha256: sha256(buf), bytes: buf.length })
    } catch {
      ANCHOR_START.set(a.path, { sha256: null, bytes: null })
    }
  }
  return ANCHOR_START
}

/** U01 登记值：sha256（baseline.json/evidence-index 的逐文件清单 → 改前快照）与回执字节数 */
function anchorRegistered(a) {
  const readJson = (p) => { try { return JSON.parse(readText(p)) } catch { return null } }
  const manifest = u01RegisteredManifest()
  const hit = manifest.files.find((f) => f.path === a.path)
  if (hit) return { sha256: hit.sha256, bytes: hit.bytes, shaSource: 'U01 逐文件清单（evidence-index.json / baseline.json#evidence.files）' }
  const preRow = U04_PRE_TREE().get(a.path)
  if (preRow?.sha256) return { sha256: preRow.sha256, bytes: preRow.bytes ?? null, shaSource: '本卡改前快照（audit-evidence/U04/pre-change.json#guard.tree）' }
  if (a.receiptBytesKey) {
    const rc = readJson(path.join(REPO, 'docs', 'unify', 'receipts', 'U01.json'))
    const bytes = rc?.interfaceConsumption?.[a.receiptBytesKey] ?? null
    if (bytes != null) return { sha256: null, bytes, shaSource: null }
  }
  return { sha256: null, bytes: null, shaSource: null }
}

/** 回执里登记的字节数（`docs/unify/receipts/U01.json#interfaceConsumption`） */
function anchorReceiptBytes(a) {
  if (!a.receiptBytesKey) return null
  try {
    const rc = JSON.parse(readText(path.join(REPO, 'docs', 'unify', 'receipts', 'U01.json')))
    const v = rc?.interfaceConsumption?.[a.receiptBytesKey]
    return typeof v === 'number' ? v : null
  } catch { return null }
}

/** 纯函数：三个锚点的裁决（只登记；`writtenDuringRun` 才红） */
export function judgeU01Anchors(rows, opts = {}) {
  const runtimeWrites = new Set([...(opts.runtimeWrites ?? [])].map((p) => path.resolve(String(p))))
  const out = rows.map((r) => {
    const abs = path.resolve(REPO, r.path)
    const currentSha = r.currentSha ?? null
    const startSha = r.startSha ?? null
    const registeredSha = r.registeredSha ?? null
    const currentBytes = r.currentBytes ?? null
    const registeredBytes = r.registeredBytes ?? null
    const runtimeHit = r.runtimeHit === true || runtimeWrites.has(abs)
    const windowChanged = Boolean(startSha && currentSha && startSha !== currentSha)
    const writtenDuringRun = r.writtenDuringRun === true || runtimeHit || windowChanged
    const registeredDiffers = Boolean(registeredSha && currentSha && registeredSha !== currentSha)
    const bytesDiffer = registeredBytes != null && currentBytes != null && registeredBytes !== currentBytes
    const missing = currentSha === null
    const registered = registeredSha != null || registeredBytes != null
    return {
      path: r.path,
      owner: r.owner ?? null,
      registered, registeredSha, registeredShaSource: r.registeredShaSource ?? null,
      registeredBytes, startSha, currentSha, currentBytes,
      registeredDiffers, bytesDiffer, missing, runtimeHit, windowChanged, writtenDuringRun,
      /** 只登记：与 U01 的登记值不同（归 U01，不判红） */
      informational: registeredDiffers || bytesDiffer,
      red: writtenDuringRun || missing,
      why: writtenDuringRun
        ? (runtimeHit ? '本进程写守卫记到了对它的写' : '运行起止 sha 变了（本卡运行期被写）')
        : (missing
          ? '锚点不见了'
          : (!registered
            ? '无外部登记值（只登记当前 sha；运行期被写才红）'
            : (registeredDiffers || bytesDiffer ? '与 U01 登记值不同 —— 归属 U01，不判红' : '与 U01 登记值一致'))),
    }
  })
  return { rows: out, reds: out.filter((r) => r.red), informational: out.filter((r) => !r.red && r.informational) }
}

/** 组装当前三个锚点的裁决输入（含运行开始时记下的 sha） */
function anchorRowsNow(runtimeWrites) {
  recordAnchorStart()
  return U01_ANCHORS.map((a) => {
    const abs = path.join(REPO, a.path)
    const start = ANCHOR_START.get(a.path) ?? { sha256: null, bytes: null }
    let currentSha = null
    let currentBytes = null
    try { const buf = fs.readFileSync(abs); currentSha = sha256(buf); currentBytes = buf.length } catch { /* 缺文件 → missing */ }
    const reg = anchorRegistered(a)
    return {
      path: a.path,
      owner: a.owner,
      registeredSha: reg.sha256,
      registeredShaSource: reg.shaSource,
      registeredBytes: anchorReceiptBytes(a) ?? reg.bytes,
      startSha: start.sha256,
      startBytes: start.bytes,
      currentSha,
      currentBytes,
      runtimeWrites,
    }
  })
}

/**
 * A08 的红路径本体之三（纯函数自证）：U01 采集证据内容锁的两个方向。
 *   红：锁里的文件内容变了 / 被删；
 *   绿：运行期**新增**文件（账本同步那批的形状）→ 只登记，不红。
 */
export function proveEvidenceLock() {
  const a = 'audit-evidence/U01/source-lock.json'
  const b = 'audit-evidence/U01/evidence-index.json'
  const before = { [a]: 'a'.repeat(64), [b]: 'b'.repeat(64) }
  const rows = []
  const one = (label, after, expect, why) => {
    const d = diffEvidenceSnapshot(before, after)
    const got = d.reds.length === 0 ? 'allow' : 'reject'
    rows.push({ label, expect, got, ok: got === expect, why, reds: d.reds.map((r) => `${r.kind} ${r.path}`), added: d.added })
  }
  one('新增 ledger-sync-*.txt（别人的合法产物）', { [a]: 'a'.repeat(64), [b]: 'b'.repeat(64), 'audit-evidence/U01/ledger-sync-X.txt': 'c'.repeat(64) },
    'allow', '运行期新增只登记，不作失败判据（DELTA-7 的判据 ⑤）')
  one('新增 + 一个已看见的文件被改写', { [a]: 'f'.repeat(64), [b]: 'b'.repeat(64), 'audit-evidence/U01/ledger-sync-X.txt': 'c'.repeat(64) },
    'reject', '锁里的内容变了 —— 本卡运行期被写')
  one('已看见的文件被删', { [a]: 'a'.repeat(64) }, 'reject', '锁里的文件没了 = 本卡运行期被写')
  return { rows, failures: rows.filter((r) => !r.ok) }
}

/**
 * A08 的红路径本体之四（纯函数自证）：U01 关键产物外部锚点的裁决。
 *   红：本卡运行期写 docs/unify/baseline.json（写守卫记到）；
 *   绿：interfaces.md 在**运行期之外**变了（与登记值不同）→ 归属 U01，不红。
 */
export function proveAnchorJudge() {
  const sha = (c) => c.repeat(64)
  const rows = []
  const one = (label, row, opts, expect, why) => {
    const j = judgeU01Anchors([row], opts ?? {})
    const got = j.reds.length === 0 ? 'allow' : 'reject'
    rows.push({
      label, expect, got, ok: got === expect, why,
      owner: j.rows[0].owner,
      informational: j.rows[0].informational,
      reds: j.reds.map((r) => r.path),
    })
  }
  const base = { path: 'docs/unify/baseline.json', owner: 'U01', registeredSha: sha('1'), registeredBytes: 10, startSha: sha('2'), currentSha: sha('2'), currentBytes: 10 }
  one('本卡运行期写 docs/unify/baseline.json', base,
    { runtimeWrites: [path.join(REPO, 'docs/unify/baseline.json')] },
    'reject', '锚点在本卡运行期被写 —— 该红')
  one('运行期之外与登记 sha 不同（interfaces.md 已被 U01 更新）',
    { path: 'docs/unify/interfaces.md', owner: 'U01', registeredSha: sha('1'), registeredBytes: 10, startSha: sha('3'), currentSha: sha('3'), currentBytes: 12 },
    null, 'allow', '与登记值不同只登记 + 归属 U01，不判红（DELTA-7 的判据 ⑥）')
  one('一致且没被写', base, null, 'allow', '与登记值一致 → 放行')
  return { rows, failures: rows.filter((r) => !r.ok) }
}

/* ── 只读 git（A08 的 tracked 侧判据；不做任何 git 写） ──────────────────── */

function gitRead(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  eq(r.status, 0, `git ${args.join(' ')} 必须正常退出（stderr=${String(r.stderr || '').slice(0, 300)}）`)
  return String(r.stdout ?? '')
}

/** 读改前基线（缺材料 = BLOCKED，不是 FAIL） */
let _pre = null
function pre() {
  if (_pre) return _pre
  if (!fs.existsSync(PRE_FILE)) {
    throw new Blocked(`缺改前采集材料：${rel(PRE_FILE)} —— 先跑 node audit-evidence/U04/capture-baseline.mjs（在改动之前）`)
  }
  let doc = null
  try {
    doc = JSON.parse(readText(PRE_FILE))
  } catch (e) {
    throw new Blocked(`改前采集材料不是合法 JSON：${rel(PRE_FILE)} —— ${e.message}`)
  }
  if (doc?.schema !== 'whale-unify-u04-pre-change/1' || doc?.card !== CARD) {
    throw new Blocked(`改前采集材料形状不对（schema/card 不符）：${rel(PRE_FILE)}`)
  }
  _pre = doc
  return _pre
}

/** mock 掉夹具模块（读取根恒定；不用 --evidence-root 的目录） */
let _fx = null
async function fixtures() {
  if (_fx) return _fx
  if (!fs.existsSync(FIXTURES_FILE)) {
    throw new Blocked(`缺夹具定义：${rel(FIXTURES_FILE)}（改前采集与改后判据必须用同一份）`)
  }
  _fx = await import(pathToFileURL(FIXTURES_FILE).href)
  return _fx
}

/* ── 三件宿主 / 包侧的加载（都走真实入口） ───────────────────────────────── */

const require_ = createRequire(import.meta.url)
let _host = null
async function host() {
  if (_host) return _host
  _host = {
    text: await import(pathToFileURL(path.join(REPO, HOST.text)).href),
    plan: await import(pathToFileURL(path.join(REPO, HOST.plan)).href),
    fingerprint: await import(pathToFileURL(path.join(REPO, HOST.fingerprint)).href),
  }
  return _host
}

let _hostSnap = null
/** 宿主三件的**当前**夹具结果（每个用例只算一次；指纹夹具要落临时目录） */
async function hostSnapshot() {
  if (_hostSnap) return _hostSnap
  const fx = await fixtures()
  const h = await host()
  _hostSnap = {
    text: fx.runCases(fx.TEXT_CASES, h.text),
    plan: fx.runPlanSuite(h.plan),
    fingerprint: fx.runFingerprintCases(h.fingerprint, path.join(RUN_TEMP, 'host-fp')),
  }
  return _hostSnap
}

/** 本卡交付的三份内核文件名（自建包只复制这三份，不把别的卡的件耦合进夹具） */
const MY_KERNELS = [path.basename(KERNEL.text), path.basename(KERNEL.plan), path.basename(KERNEL.fingerprint)]

/** 把包侧那一份按真实形态（`.js` = CJS、同目录 `./unify/`）加载到 E:\Temp 自建包里 */
async function packModule(which, label) {
  const fx = await fixtures()
  const packRoot = path.join(RUN_TEMP, `pack-${label}`)
  const loaded = fx.loadPackModule(REPO, PACK[which], packRoot, { kernels: MY_KERNELS })
  return { ...loaded, root: packRoot }
}

/* ── A01 · 文本边界与改前一致 ───────────────────────────────────────────── */

async function A01() {
  const fx = await fixtures()
  const preDoc = pre()
  const h = await host()

  const cur = fx.runCases(fx.TEXT_CASES, h.text)
  sameJson(cur.map(rowJson), preDoc.host.text.map(rowJson),
    'A01 · 宿主 lib/text.js：56 个文本边界用例必须与改前逐例一致')

  // 逐例点名（失败时看得出是哪一条，不是只给一坨 JSON）
  for (let i = 0; i < cur.length; i++) {
    eq(rowJson(cur[i]), rowJson(preDoc.host.text[i]), `A01 · 用例 ${cur[i].id}（${cur[i].label}）与改前不一致`)
  }

  // 报错形状：错误类型 + 前缀 + 后半句（"本机常见原因"）都要逐字在
  const errRows = cur.filter((r) => r.error)
  assert(errRows.length >= 6, `A01 · 夹具里应当有一批抛错用例（实得 ${errRows.length}）—— 少了就说明报错形状没被测到`)
  for (const r of errRows) {
    eq(r.error.name, 'Error', `A01 · 用例 ${r.id} 的异常类型必须是 Error`)
    assert(/不是合法 JSON —— /.test(r.error.message), `A01 · 用例 ${r.id} 的错误信息缺「… 不是合法 JSON —— …」形状`)
    assert(/（本机常见原因：文件带 BOM 或编码不是 UTF-8）$/.test(r.error.message), `A01 · 用例 ${r.id} 的错误信息尾部提示没保留`)
  }

  // 包侧：改前与宿主**有五处不同**（`what` 为 falsy 时的前缀）—— 收成一份后必须收敛到宿主语义；
  // 其余用例必须与改前逐字相同。
  const deltaIds = preDoc.packVsHost.text.map((d) => d.id)
  assert(deltaIds.length > 0, 'A01 · 改前基线里包侧与宿主应当有已登记的差分（否则这条带 Δ 的判据是空转）')
  const pack = await packModule('text', 'a01')
  const packCur = fx.runCases(fx.TEXT_CASES, pack.mod)
  for (let i = 0; i < packCur.length; i++) {
    const id = packCur[i].id
    if (deltaIds.includes(id)) {
      // 收敛到宿主语义（改前已知：包侧用 `what || 'JSON'`，宿主用默认参数）
      eq(rowJson(packCur[i]), rowJson(cur[i]), `A01 · 包侧用例 ${id} 必须收敛到宿主语义（旧差分已登记）`)
      const old = preDoc.pack.text.find((r) => r.id === id)
      assert(rowJson(old) !== rowJson(cur[i]), `A01 · 用例 ${id} 在改前就没差异 —— Δ 登记是假的`)
    } else {
      eq(rowJson(packCur[i]), rowJson(preDoc.pack.text[i]), `A01 · 包侧用例 ${id} 必须与改前一致`)
    }
  }
  DETAIL.comparisons.A01 = { cases: cur.length, deltaIds, packCases: packCur.length }
}

/* ── A02 · 大纲校验与前沿与改前一致 ─────────────────────────────────────── */

async function A02() {
  const fx = await fixtures()
  const preDoc = pre()
  const h = await host()

  const cur = fx.runPlanSuite(h.plan)
  for (let i = 0; i < cur.docs.length; i++) {
    eq(planRowJson(cur.docs[i]), planRowJson(preDoc.host.plan.docs[i]), `A02 · 大纲文档 ${cur.docs[i].id}（${cur.docs[i].label}）与改前不一致`)
  }
  for (let i = 0; i < cur.frontier.length; i++) {
    eq(planRowJson(cur.frontier[i]), planRowJson(preDoc.host.plan.frontier[i]), `A02 · 前沿用例 ${cur.frontier[i].id}（${cur.frontier[i].label}）与改前不一致`)
  }
  sameJson(cur, preDoc.host.plan, 'A02 · 宿主 lib/plan.js：大纲文档 + 前沿用例必须与改前逐例一致')

  // 反空转：夹具必须真的分开了「ok / 不 ok」，且前沿真的有两颗星与 exhausted 两种形状
  const okDocs = cur.docs.filter((r) => r.validate && r.validate.ok).length
  const badDocs = cur.docs.filter((r) => r.validate && r.validate.ok === false).length
  assert(okDocs >= 3 && badDocs >= 10, `A02 · 大纲夹具没有真的分开可用/不可用（ok=${okDocs} / bad=${badDocs}）`)
  const starShapes = new Set(cur.frontier.map((r) => (r.frontier?.stars || []).length))
  assert(starShapes.has(2), `A02 · 前沿夹具必须覆盖"支线两颗星"（实得 stars 数集合 ${[...starShapes].join(',') }）`)
  assert(starShapes.has(0) && starShapes.has(1), 'A02 · 前沿夹具必须覆盖"没有了（exhausted）"与"一颗"两种形状')
  const exhausted = cur.frontier.filter((r) => r.frontier?.exhausted === true).length
  assert(exhausted >= 1, 'A02 · 前沿夹具必须真的跑到 exhausted')
  const branchStars = cur.frontier.filter((r) => (r.frontier?.stars || []).length === 2)
  assert(branchStars.every((r) => r.frontier.stars[1].branch === true),
    'A02 · 第二颗星必须是标了 branch:true 的节点')
  const gateProblems = cur.docs.filter((r) => r.gate && r.gate.ok === false).length
  assert(gateProblems >= 10, `A02 · planGate 必须真的拒（实得 ${gateProblems}）—— 它是宿主独有导出`)

  // 包侧：改前与宿主逐例相同（差分 0），改后也必须与改前逐例相同
  eq(preDoc.packVsHost.planDocs.length, 0, 'A02 · 基线自检：包侧与宿主的大纲判据改前应当逐例相同')
  eq(preDoc.packVsHost.planFrontier.length, 0, 'A02 · 基线自检：包侧与宿主的前沿改前应当逐例相同')
  const pack = await packModule('plan', 'a02')
  const packCur = fx.runPlanSuite(pack.mod)
  sameJson(packCur, preDoc.pack.plan, 'A02 · 包侧 tools/plan-map.js：大纲与前沿必须与改前逐例一致')

  DETAIL.comparisons.A02 = { docs: cur.docs.length, frontier: cur.frontier.length, okDocs, badDocs, starShapes: [...starShapes] }
}

/* ── A03 · 指纹输入与输出保持既有语义 ──────────────────────────────────── */

async function A03() {
  const fx = await fixtures()
  const preDoc = pre()
  const snap = await hostSnapshot()

  sameJson(snap.fingerprint.map(normProbeRow), preDoc.host.fingerprint.map(normProbeRow),
    'A03 · 宿主 lib/fingerprint.js：指纹 14 个用例必须与改前逐值一致')
  for (let i = 0; i < snap.fingerprint.length; i++) {
    eq(rowJson(normProbeRow(snap.fingerprint[i])), rowJson(normProbeRow(preDoc.host.fingerprint[i])), `A03 · 指纹用例 ${snap.fingerprint[i].id}（${snap.fingerprint[i].label}）与改前不一致`)
  }

  // 基线自检（反空转）：夹具的"必有变化"那几条在改前基线里确实是变化的
  const byId = new Map(preDoc.host.fingerprint.map((r) => [r.id, r]))
  eq(byId.get('fp02').result, true, 'A03 · 基线自检：指纹形状必须是 sha256:<64 hex>')
  eq(byId.get('fp03').result, true, 'A03 · 基线自检：同输入再算必须同指纹')
  eq(byId.get('fp04').result, true, 'A03 · 基线自检：改排除目录必须不影响指纹')
  eq(byId.get('fp05').result, true, 'A03 · 基线自检：11 个 SKIP_DIR 目录改动都必须不影响指纹')
  eq(byId.get('fp06').result.changed, true, 'A03 · 基线自检：多一个文件必须让指纹变')
  eq(byId.get('fp07').result.changed, true, 'A03 · 基线自检：改一个字节必须让指纹变')
  eq(byId.get('fp08').result.changed, true, 'A03 · 基线自检：CRLF→LF 必须让指纹变')
  eq(byId.get('fp09').result.sameAsWithoutBom, true, 'A03 · 基线自检：BOM 归一必须同指纹')
  eq(byId.get('fp10').result.same, true, 'A03 · 基线自检：行首 BOM 也必须被剥')
  eq(byId.get('fp14').result.differ, true, 'A03 · 基线自检：中文路径必须参与指纹')

  // 当前值的确定性 + 与产物无关性（同输入两次同指纹）
  const h = await host()
  const fxDir = path.join(RUN_TEMP, 'fx-a03-repeat')
  fx.buildFingerprintFixture(fxDir)
  eq(h.fingerprint.digestTree(fxDir), h.fingerprint.digestTree(fxDir), 'A03 · 同输入两次必须同指纹')

  // PROBE_VERSION：口径按 P1/P2 的实施动作（authorization.derivedConsequences.C2）——
  // 不再钉死旧值，改判三条：与内核那一份唯一字面量一致 / 形状 p:<16hex> / 与 PROBE_SOURCES 现算重算值一致
  const probeKernelSrc = readText(path.join(REPO, KERNEL.fingerprint))
  const probeKernelLits = probeLiteralHits(probeKernelSrc)
  eq(probeKernelLits.length, 1, `A03 · 权威内核里必须有且只有一份 PROBE_VERSION 字面量（实得 ${probeKernelLits.length} 份）`)
  eq(h.fingerprint.PROBE_VERSION, PROBE_LITERAL, 'A03 · 宿主导出的 PROBE_VERSION 必须就是权威内核里那一份字面量')
  assert(/^p:[0-9a-f]{16}$/.test(h.fingerprint.PROBE_VERSION), 'A03 · PROBE_VERSION 形状必须是 p:<16 位十六进制>')
  const probeRecomputed = recomputeProbeVersion(h.fingerprint.PROBE_SOURCES)
  eq(h.fingerprint.PROBE_VERSION, probeRecomputed,
    'A03 · PROBE_VERSION 必须等于按 PROBE_SOURCES 现算的重算值（改了探针源却没改字面量 → 红）')

  // 包侧：改前与宿主逐字同源 → 改后仍逐值一致
  eq(preDoc.packVsHost.fingerprint.length, 0, 'A03 · 基线自检：包侧与宿主的指纹改前应当逐值相同')
  const pack = await packModule('fingerprint', 'a03')
  const packRows = fx.runFingerprintCases(pack.mod, path.join(RUN_TEMP, 'pack-fp'))
  sameJson(packRows.map(normProbeRow), preDoc.pack.fingerprint.map(normProbeRow), 'A03 · 包侧 tools/fingerprint.js：指纹必须与改前逐值一致')
  eq(pack.mod.PROBE_VERSION, h.fingerprint.PROBE_VERSION, 'A03 · 宿主与包侧的 PROBE_VERSION 必须同源同值')

  DETAIL.comparisons.A03 = {
    rows: snap.fingerprint.length, probe: h.fingerprint.PROBE_VERSION, packRows: packRows.length,
    probeBefore: preDoc.probe.PROBE_VERSION, probeRecomputed, probeChangedByP1: preDoc.probe.PROBE_VERSION !== h.fingerprint.PROBE_VERSION,
  }
}

/* ── A04 · 现有导出及常量完整保留 ──────────────────────────────────────── */

/** 剥掉块注释与整行注释（源码级断言必须看"活代码"；字符串里没有 `//` 形状的风险在本卡三件上不存在） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/**
 * 扫 `lib/**` + `tools/**` 的代码文件里的某个字面量（唯一性断言用）。
 *
 * 决-9 连带（副本出现后口径过期）：U19 把 `lib/unify/*.cjs` **逐字节生成**到
 * `lib/pack-template/tools/unify/`（随包副本）。那是**生成物**，不是第二份手写字面量 ——
 * 唯一性扫描必须现算排除它，并把被排除的命中挂到返回数组的 `.skipped` 上，
 * 由调用方逐字节对拍（排除 ≠ 放行）。
 */
const GENERATED_MIRROR_PREFIX = 'lib/pack-template/tools/unify/'
function scanLiteral(literal, dirs = ['lib', 'tools']) {
  const hits = []
  const skipped = []
  for (const dir of dirs) {
    const root = path.join(REPO, dir)
    if (!fs.existsSync(root)) continue
    ;(function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name)
        if (e.isDirectory()) { walk(abs); continue }
        if (!/\.(js|cjs|mjs)$/.test(e.name)) continue
        const text = readText(abs)
        const sink = rel(abs).startsWith(GENERATED_MIRROR_PREFIX) ? skipped : hits
        let idx = text.indexOf(literal)
        while (idx !== -1) {
          sink.push({ file: rel(abs), offset: idx })
          idx = text.indexOf(literal, idx + 1)
        }
      }
    })(root)
  }
  hits.skipped = skipped
  return hits
}

async function A04() {
  const preDoc = pre()
  const h = await host()
  const kernel = {
    text: require_(path.join(REPO, KERNEL.text)),
    plan: require_(path.join(REPO, KERNEL.plan)),
    fingerprint: require_(path.join(REPO, KERNEL.fingerprint)),
  }

  // ① 宿主导出面（键集合 + 类型）：与改前逐键一致，且就是那几张清单
  const keysOf = (mod) => Object.keys(mod).sort()
  sameJson(keysOf(h.text), [...preDoc.hostExports[HOST.text]].sort(), 'A04 · 宿主 lib/text.js 导出键与改前不一致')
  sameJson(keysOf(h.plan), [...preDoc.hostExports[HOST.plan]].sort(), 'A04 · 宿主 lib/plan.js 导出键与改前不一致')
  sameJson(keysOf(h.fingerprint), [...preDoc.hostExports[HOST.fingerprint]].sort(), 'A04 · 宿主 lib/fingerprint.js 导出键与改前不一致')
  sameJson(keysOf(h.text), [...EXPECTED.hostText].sort(), 'A04 · 宿主 lib/text.js 导出键必须就是那三个')
  sameJson(keysOf(h.plan), [...EXPECTED.hostPlan].sort(), 'A04 · 宿主 lib/plan.js 导出键必须就是那八个')
  sameJson(keysOf(h.fingerprint), [...EXPECTED.hostFp].sort(), 'A04 · 宿主 lib/fingerprint.js 导出键必须就是那三个')
  for (const k of EXPECTED.hostText) eq(typeof h.text[k], 'function', `A04 · 宿主 text 导出 ${k} 必须是函数`)
  for (const k of ['PLAN_KEYS', 'NODE_KEYS']) assert(Array.isArray(h.plan[k]), `A04 · ${k} 必须是数组`)
  for (const k of EXPECTED.hostPlan.filter((x) => !['PLAN_KEYS', 'NODE_KEYS'].includes(x))) {
    eq(typeof h.plan[k], 'function', `A04 · 宿主 plan 导出 ${k} 必须是函数`)
  }
  eq(typeof h.fingerprint.digestTree, 'function', 'A04 · digestTree 必须是函数')
  assert(Array.isArray(h.fingerprint.PROBE_SOURCES), 'A04 · PROBE_SOURCES 必须是数组')
  eq(typeof h.fingerprint.PROBE_VERSION, 'string', 'A04 · PROBE_VERSION 必须是字符串')

  // ② 冻结常量：值 + 顺序 + Object.freeze
  eq(Object.isFrozen(h.plan.PLAN_KEYS), true, 'A04 · PLAN_KEYS 必须仍然 Object.freeze')
  eq(Object.isFrozen(h.plan.NODE_KEYS), true, 'A04 · NODE_KEYS 必须仍然 Object.freeze')
  sameJson([...h.plan.PLAN_KEYS], ['goal', 'nodes'], 'A04 · PLAN_KEYS 的值与顺序必须不变')
  sameJson([...h.plan.NODE_KEYS], ['no', 'title', 'deliverable', 'criteria', 'why', 'branch', 'sources'],
    'A04 · NODE_KEYS 的值与顺序必须不变')

  // ③ PROBE_SOURCES：11 件**逐字逐序**钉死 + 顺序**规则**成立 + 前 9 条未动 + 新增 2 条有授权出处
  //    （决-4：9 → 11；授权 = authorization.json 的 decisions.approvedChanged 决-4）
  //    旧口径「必须与改前那 9 件逐字相同」在决-4 之后不再成立（清单合法地长了），拆成下面四条 ——
  //    强度**不降**：① 整份清单仍逐字逐序比；② 顺序规则另有一条独立判据（还有反例自证）；
  //    ③ 前缀 9 条仍与改前**逐字相同**（原有的条目一条没动、没重排）；④ 新增的 2 条必须有出处。
  eq(h.fingerprint.PROBE_SOURCES.length, PROBE_SOURCES_NOW.length,
    `A04 · PROBE_SOURCES 必须恰好 ${PROBE_SOURCES_NOW.length} 件（决-4：9 → 11；多一件少一件都红）`)
  sameJson([...h.fingerprint.PROBE_SOURCES], PROBE_SOURCES_NOW,
    `A04 · PROBE_SOURCES 必须就是那 ${PROBE_SOURCES_NOW.length} 件（值 + 顺序逐字）`)

  // ③-a 顺序规则：前两件是入口（顺序固定），其余按字节序
  sameJson([...h.fingerprint.PROBE_SOURCES].slice(0, PROBE_ENTRIES.length), PROBE_ENTRIES,
    'A04 · PROBE_SOURCES 前两件必须是入口 lib/state.js + lib/state-scan.js（顺序固定）')
  const probeRest = [...h.fingerprint.PROBE_SOURCES].slice(PROBE_ENTRIES.length)
  eq(probeRest.length, PROBE_SOURCES_NOW.length - PROBE_ENTRIES.length,
    `A04 · 入口之外的条目必须是 ${PROBE_SOURCES_NOW.length - PROBE_ENTRIES.length} 件（实得 ${probeRest.length}）`)
  eq(isByteSorted(probeRest), true, `A04 · 入口之外的条目必须按字节序（实得 ${fmt(probeRest)}）`)
  sameJson([...probeRest].sort(byteOrder), probeRest,
    'A04 · 按字节序排序后必须与原序逐字相同（"看起来像有序"不算）')
  // 顺序判据必须可证伪：把新增两件反过来就必须判 false（否则"按字节序"是恒真断言）
  eq(isByteSorted([...PROBE_ADDED_BY_D4].reverse()), false,
    `A04 · 顺序判据必须可证伪：反序的 ${fmt([...PROBE_ADDED_BY_D4].reverse())} 必须判 false`)

  // ③-b 改前那 9 条逐字不变（口径从"整份相同"改成"前缀相同"：决-4 只许在**尾部**新增）
  eq(preDoc.probe.PROBE_SOURCES.length, 9, 'A04 · 改前采集的 PROBE_SOURCES 必须是 9 件（口径变化的前提）')
  sameJson([...h.fingerprint.PROBE_SOURCES].slice(0, preDoc.probe.PROBE_SOURCES.length), preDoc.probe.PROBE_SOURCES,
    'A04 · PROBE_SOURCES 的前 9 条必须是改前那 9 条，逐字且顺序不变（原有条目一条没动、没重排）')

  // ③-c 新增的 2 条 = 决-4 点名的两件，且授权台账里真的写着（不是"我们说自己有授权"）
  sameJson([...h.fingerprint.PROBE_SOURCES].slice(preDoc.probe.PROBE_SOURCES.length), PROBE_ADDED_BY_D4,
    'A04 · PROBE_SOURCES 新增的 2 条必须恰好是 lib/unify/identity.cjs + lib/unify/pack.cjs（决-4）')
  const authDoc = JSON.parse(readText(path.join(REPO, 'docs', 'unify', 'authorization.json')))
  const decision4 = (authDoc.decisions?.approvedChanged ?? []).find((d) => d?.id === '决-4')
  assert(decision4, 'A04 · 授权台账 docs/unify/authorization.json 的 decisions.approvedChanged 里必须有决-4（9→11 的出处）')
  const decision4What = String(decision4.what ?? '')
  assert(/PROBE_SOURCES/.test(decision4What), `A04 · 决-4 的授权文字必须说的是 PROBE_SOURCES（实得 ${fmt(decision4What)}）`)
  assert(/9\s*→\s*11/.test(decision4What), `A04 · 决-4 必须明写清单 9→11（实得 ${fmt(decision4What)}）`)
  for (const p of PROBE_ADDED_BY_D4) {
    assert(decision4What.includes(p), `A04 · 决-4 的授权文字里必须点名新增条目 ${p}（实得 ${fmt(decision4What)}）`)
  }

  // ④ PROBE_VERSION：值 = 权威内核里那一份唯一字面量（P2/C2 口径，不再钉旧值），且在 lib/** + tools/** 的**活代码里唯一**
  eq(h.fingerprint.PROBE_VERSION, PROBE_LITERAL, 'A04 · 宿主导出的 PROBE_VERSION 必须就是权威内核里那一份字面量')
  const hits = scanLiteral(PROBE_LITERAL)
  eq(hits.length, 1, `A04 · PROBE_VERSION 字面量必须全仓唯一（实得 ${hits.length} 处：${hits.map((x) => x.file).join(', ') || '无'}）`)
  eq(hits[0].file, KERNEL.fingerprint, 'A04 · PROBE_VERSION 的唯一字面量必须在权威内核 lib/unify/fingerprint.cjs 里')
  // 被排除的生成副本（U19 的随包副本）必须**逐字节等于**权威内核 —— 那不是第二份手写字面量
  for (const s of (hits.skipped || [])) {
    eq(sha256(fs.readFileSync(path.join(REPO, s.file))), sha256(fs.readFileSync(path.join(REPO, KERNEL.fingerprint))),
      `A04 · 被排除的生成副本 ${s.file} 必须与权威内核逐字节相同（否则它就是第二份字面量）`)
  }

  // ⑤ ESM ↔ CJS 桥：导出的**就是**内核那几个函数（同一性，不是同名）
  for (const k of EXPECTED.hostText) {
    eq(h.text[k], kernel.text[k], `A04 · 桥：宿主 ${HOST.text} 的 ${k} 必须就是内核导出（同一性）`)
  }
  for (const k of EXPECTED.hostPlan) {
    eq(h.plan[k], kernel.plan[k], `A04 · 桥：宿主 ${HOST.plan} 的 ${k} 必须就是内核导出（同一性）`)
  }
  eq(h.fingerprint.digestTree, kernel.fingerprint.digestTree, 'A04 · 桥：digestTree 必须就是内核导出')
  eq(h.fingerprint.PROBE_VERSION, kernel.fingerprint.PROBE_VERSION, 'A04 · 桥：PROBE_VERSION 必须就是内核导出')

  // ⑥ 宿主文件里不许再留算法（否则"单一源码"是假的）
  const hostCode = {
    [HOST.text]: stripComments(readText(path.join(REPO, HOST.text))),
    [HOST.plan]: stripComments(readText(path.join(REPO, HOST.plan))),
    [HOST.fingerprint]: stripComments(readText(path.join(REPO, HOST.fingerprint))),
  }
  for (const [file, src] of Object.entries(hostCode)) {
    assert(/require_\(['"]\.\/unify\/[a-z]+\.cjs['"]\)/.test(src), `A04 · ${file} 必须通过 createRequire 从 ./unify/*.cjs 取内核`)
  }
  assert(!/replace\(\/\^\\uFEFF\//.test(hostCode[HOST.text]), `A04 · ${HOST.text} 里还留着 stripBom 的算法（第二份实现）`)
  assert(!/JSON\.parse\(/.test(hostCode[HOST.text]), `A04 · ${HOST.text} 里还留着 JSON.parse 的算法（第二份实现）`)
  assert(!/Number\.isSafeInteger/.test(hostCode[HOST.plan]), `A04 · ${HOST.plan} 里还留着 validatePlan 的算法（第二份实现）`)
  assert(!/SKIP_DIR/.test(hostCode[HOST.fingerprint]), `A04 · ${HOST.fingerprint} 里还留着 SKIP_DIR（第二份实现）`)
  assert(!/createHash\(/.test(hostCode[HOST.fingerprint]), `A04 · ${HOST.fingerprint} 里还留着 sha256 计算（第二份实现）`)

  // ⑦ 包侧导出面与改前逐键一致（不因"收成一份"而扩大 API）
  for (const which of ['text', 'plan', 'fingerprint']) {
    const pack = await packModule(which, `a04-${which}`)
    const expect = which === 'text' ? EXPECTED.packText : which === 'plan' ? EXPECTED.packPlan : EXPECTED.packFp
    sameJson(Object.keys(pack.mod), preDoc.packExports[PACK[which]], `A04 · 包侧 ${PACK[which]} 的导出键（含顺序）必须与改前一致`)
    sameJson(Object.keys(pack.mod), expect, `A04 · 包侧 ${PACK[which]} 的导出键必须就是那 ${expect.length} 个`)
    for (const k of expect) {
      const kind = PACK_TYPES[which][k]
      assert(kind, `A04 · 夹具没声明包侧 ${PACK[which]} 的 ${k} 该是什么类型`)
      if (kind === 'frozen') {
        assert(Array.isArray(pack.mod[k]), `A04 · 包侧 ${k} 必须是数组`)
        eq(Object.isFrozen(pack.mod[k]), true, `A04 · 包侧 ${k} 必须仍然冻结`)
        continue
      }
      eq(typeof pack.mod[k], kind, `A04 · 包侧 ${k} 的类型必须还是 ${kind}`)
    }
    // 包侧与**副本里那个内核**的同一性（纯委托的判据：不是"同名同值"，是同一个函数对象）
    // ⚠️ 不能与仓内 `lib/unify/*.cjs` 比同一性：那是另一份模块实例（不同路径 = 不同 module
    //    对象）。包里的委托 require 的正是它旁边那份 `./unify/<mod>.cjs`，所以比的必须是那一份。
    const packKernel = require_(path.join(pack.root, 'tools', 'unify', path.basename(KERNEL[which])))
    for (const k of expect) {
      if (k === 'PLAN_KEYS' || k === 'NODE_KEYS') continue
      eq(pack.mod[k], packKernel[k], `A04 · 包侧 ${PACK[which]} 的 ${k} 必须就是旁边那份内核的导出（纯委托）`)
    }
  }

  DETAIL.comparisons.A04 = {
    literalHits: hits.length, hostModules: 3, packModules: 3,
    // 决-4 的口径变化留痕：旧锁（改前采集）9 件 → 现锁 11 件；谁是新增、谁给的授权
    probeSources: { now: h.fingerprint.PROBE_SOURCES.length, lockedBefore: preDoc.probe.PROBE_SOURCES.length, added: PROBE_ADDED_BY_D4, authority: 'docs/unify/authorization.json decisions.approvedChanged 决-4' },
  }
}

/* ── A05 · 包侧只剩委托，不留第二份计算实现 ─────────────────────────────── */

/** 每个包侧文件的"活代码"（剥注释后）里**不许再出现**的计算痕迹 */
const NO_COMPUTE = [
  'Number.isSafeInteger', 'isHttp', 'SKIP_DIR', 'createHash', 'sha256(',
  'JSON.parse', 'JSON.stringify', 'String.fromCharCode', '\\uFEFF', 'replace(',
  'split(', 'sort(', 'Object.freeze',
]
/** 计算实现的**症状常量**：第二份表/第二份值 */
const NO_SECOND_CONST = [PROBE_LITERAL, "['goal', 'nodes']", '[\'goal\',\'nodes\']', 'target|build|out|dist']

async function A05() {
  const fx = await fixtures()
  const preDoc = pre()
  const snap = await hostSnapshot()

  for (const which of ['text', 'plan', 'fingerprint']) {
    const file = PACK[which]
    const src = readText(path.join(REPO, file))
    const code = stripComments(src)
    const kernelName = path.basename(KERNEL[which])

    // ① 只 require 一件、且必须是同目录 `./unify/<mod>.cjs`
    const requires = [...code.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1].trim())
    eq(requires.length, 1, `A05 · ${file} 只该有一处 require（实得 ${requires.length}：${requires.join(' / ')}）`)
    eq(requires[0], `'./unify/${kernelName}'`, `A05 · ${file} 的 require 目标必须是 './unify/${kernelName}'`)

    // ② 没有第二份计算（函数体 / 算法痕迹一律不许）
    assert(!/function\s+[A-Za-z_$]/.test(code), `A05 · ${file} 里不许再有函数声明（第二份计算）`)
    assert(!/=>/.test(code), `A05 · ${file} 里不许再有箭头函数（第二份计算）`)
    for (const token of NO_COMPUTE) {
      assert(!code.includes(token), `A05 · ${file} 里还留着计算痕迹 ${JSON.stringify(token)}（第二份实现）`)
    }

    // ③ 没有第二份常量（也不许再定义常量表：只允许一个接住 require 结果的 `const core`）
    for (const token of NO_SECOND_CONST) {
      assert(!code.includes(token), `A05 · ${file} 里还留着第二份常量 ${JSON.stringify(token)}`)
    }
    const consts = [...code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1])
    assert(consts.every((n) => n === 'core'), `A05 · ${file} 只许有一个接住内核的 const core（实得 ${consts.join(',') || '无'}）`)

    // ④ module.exports 只有一处
    eq((code.match(/module\.exports/g) || []).length, 1, `A05 · ${file} 只该有一处 module.exports`)
  }

  // ⑤ 运行时等价：把权威模块复制进 E:\Temp 自建包，包侧包装器的输出必须与宿主**当前**逐例相同
  const packText = await packModule('text', 'a05-text')
  const packPlan = await packModule('plan', 'a05-plan')
  const packFp = await packModule('fingerprint', 'a05-fp')
  assert(fs.existsSync(path.join(packText.root, 'tools', 'unify', 'text.cjs')), 'A05 · 自建包里必须有 tools/unify/text.cjs（真实随包布局）')
  assert(fs.existsSync(path.join(packFp.root, 'tools', 'unify', 'fingerprint.cjs')), 'A05 · 自建包里必须有 tools/unify/fingerprint.cjs')

  sameJson(fx.runCases(fx.TEXT_CASES, packText.mod).map(rowJson), snap.text.map(rowJson),
    'A05 · 自建包里的 pack-text.js 必须与宿主逐例等价')
  sameJson(fx.runPlanSuite(packPlan.mod).docs.map(planComparable), snap.plan.docs.map(planComparable),
    'A05 · 自建包里的 plan-map.js 必须与宿主逐例等价（大纲；宿主独有的 gate 投影掉）')
  sameJson(fx.runPlanSuite(packPlan.mod).frontier, snap.plan.frontier,
    'A05 · 自建包里的 plan-map.js 前沿必须与宿主逐例等价')
  sameJson(fx.runFingerprintCases(packFp.mod, path.join(RUN_TEMP, 'a05-pack-fp')), snap.fingerprint,
    'A05 · 自建包里的 fingerprint.js 必须与宿主逐值等价')

  // ⑥ 反空转：包装器确实是"从副本里的内核"取的值（不是碰巧与宿主同值）
  eq(packFp.mod.PROBE_VERSION, PROBE_LITERAL, 'A05 · 副本里的 PROBE_VERSION 必须来自复制的内核')
  const copied = readText(path.join(packFp.root, 'tools', 'unify', 'fingerprint.cjs'))
  eq(sha256(copied), sha256(readText(path.join(REPO, KERNEL.fingerprint))), 'A05 · 复制进自建包的内核必须与仓内权威内核逐字节相同')

  DETAIL.comparisons.A05 = { templateFiles: 3, copiedKernel: 3, textCases: snap.text.length }
}

/* ── A06 · 临时独立包中可以加载、模块不依赖仓外路径 ─────────────────────── */

async function A06() {
  const h = await host()
  const standalone = path.join(RUN_TEMP, 'standalone')
  const toolsDir = path.join(standalone, 'tools')
  const unifyDir = path.join(toolsDir, 'unify')
  fs.mkdirSync(unifyDir, { recursive: true })

  // 逐字节复制（真实随包布局：<pack>/tools/<tool>.js + <pack>/tools/unify/<mod>.cjs）
  const copied = []
  for (const [which, file] of Object.entries(PACK)) {
    const dest = path.join(toolsDir, path.basename(file))
    fs.copyFileSync(path.join(REPO, file), dest)
    copied.push(path.basename(file))
    eq(sha256(readText(dest)), sha256(readText(path.join(REPO, file))), `A06 · 复制出来的 ${file} 必须与仓内逐字节相同`)
  }
  for (const [which, file] of Object.entries(KERNEL)) {
    const dest = path.join(unifyDir, path.basename(file))
    fs.copyFileSync(path.join(REPO, file), dest)
    copied.push(`unify/${path.basename(file)}`)
  }
  // 包里不该有 package.json（课程包的真实形态：.js 就是 CJS）
  assert(!fs.existsSync(path.join(standalone, 'package.json')), 'A06 · 自建的独立包不该有 package.json')

  // ① 源码层：内核不依赖仓外路径 / 环境 / 时钟 / 随机 / 网络，且只用内置
  for (const [which, file] of Object.entries(KERNEL)) {
    const src = readText(path.join(REPO, file))
    assert(!/[A-Za-z]:[\\/]/.test(src), `A06 · ${file} 里出现了盘符绝对路径`)
    assert(!/E:[\\/]Temp|workplace|dsh-whale-sensei/.test(src), `A06 · ${file} 里出现了本机/仓内专属路径`)
    assert(!/process\.env/.test(src), `A06 · ${file} 不许读环境变量`)
    assert(!/Date\.now|new Date\(/.test(src), `A06 · ${file} 不许看时钟`)
    assert(!/Math\.random/.test(src), `A06 · ${file} 不许用随机数`)
    assert(!/setTimeout|setInterval/.test(src), `A06 · ${file} 不许用定时器`)
    assert(!/require\(['"](?:node:)?(?:http|https|net|tls|dns|child_process|worker_threads)['"]\)/.test(src), `A06 · ${file} 不许联网/起进程`)
    const reqs = [...src.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1].trim())
    for (const r of reqs) {
      assert(/^'node:(fs|path|crypto)'$/.test(r), `A06 · ${file} 只许 require 内置模块（实得 ${r}）`)
    }
    assert(!/require\(['"]\.\.?\.?\//.test(src.replace(/require\('node:/g, '')), `A06 · ${file} 不许 require 相对路径（仓外依赖的入口）`)
  }

  // ② 子进程从**仓外 cwd** require（两次不同 cwd，结果必须相同）
  const doc = { goal: '交付一个服务', nodes: [{ no: 1, title: '第1课', deliverable: '产物', criteria: '判据', why: '更近', sources: [{ label: 'x', url: 'https://example.com/a' }] }] }
  const script = `
const text = require(${JSON.stringify(path.join(toolsDir, 'pack-text.js'))});
const plan = require(${JSON.stringify(path.join(toolsDir, 'plan-map.js'))});
const fp = require(${JSON.stringify(path.join(toolsDir, 'fingerprint.js'))});
const BOM = String.fromCharCode(0xFEFF);
const out = {
  textKeys: Object.keys(text),
  planKeys: Object.keys(plan),
  fpKeys: Object.keys(fp),
  stripBom: text.stripBom(BOM + 'x'),
  splitLines: text.splitLines(BOM + 'l1\\n' + BOM + 'l2'),
  summary: plan.summarizePlan(${JSON.stringify(doc)}),
  frontier: plan.planFrontier(${JSON.stringify(doc)}, []).stars.map((n) => n.no),
  digest: fp.digestTree(${JSON.stringify(standalone)}),
  probeVersion: fp.PROBE_VERSION,
};
process.stdout.write(JSON.stringify(out));
`
  const runChild = (cwd) => {
    const r = spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_PATH: '' } })
    assert(!r.error, `A06 · 子进程跑不起来：${r.error && r.error.message}`)
    eq(r.status, 0, `A06 · 子进程退出码必须 0（stderr=${String(r.stderr || '').slice(0, 400)}）`)
    return JSON.parse(String(r.stdout || ''))
  }
  const fromPack = runChild(standalone)      // cwd = 自建包根（仓外）
  const fromTemp = runChild(TEMP_PARENT)     // 换一个 cwd 再来一次
  sameJson(fromPack, fromTemp, 'A06 · 两次不同 cwd 的加载结果必须相同（不依赖 cwd）')

  // ③ 结果与宿主一致（含指纹：对自建包整棵树算，宿主算同一路径必须同值）
  sameJson(fromPack.textKeys, EXPECTED.packText, 'A06 · 子进程里 pack-text.js 的导出面')
  sameJson(fromPack.planKeys, EXPECTED.packPlan, 'A06 · 子进程里 plan-map.js 的导出面')
  sameJson(fromPack.fpKeys, EXPECTED.packFp, 'A06 · 子进程里 fingerprint.js 的导出面')
  eq(fromPack.stripBom, h.text.stripBom('\uFEFFx'), 'A06 · 子进程的 stripBom 结果必须与宿主一致')
  sameJson(fromPack.splitLines, h.text.splitLines('\uFEFFl1\n\uFEFFl2'), 'A06 · 子进程的 splitLines 结果必须与宿主一致')
  eq(fromPack.summary, h.plan.summarizePlan(doc), 'A06 · 子进程的 summarizePlan 必须与宿主一致')
  sameJson(fromPack.frontier, h.plan.planFrontier(doc, []).stars.map((n) => n.no), 'A06 · 子进程的 planFrontier 必须与宿主一致')
  eq(fromPack.digest, h.fingerprint.digestTree(standalone), 'A06 · 子进程的 digestTree 必须与宿主对同一路径的结果一致')
  eq(fromPack.probeVersion, h.fingerprint.PROBE_VERSION, 'A06 · 子进程的 PROBE_VERSION 必须与宿主一致')

  DETAIL.comparisons.A06 = { copied, cwds: [standalone, TEMP_PARENT], digest: fromPack.digest }
}

/* ── A07 · 把指纹临时改成常量后判据必须失败 ────────────────────────────── */

async function A07() {
  const fx = await fixtures()
  const preDoc = pre()
  const src = readText(path.join(REPO, KERNEL.fingerprint))

  const mutDir = path.join(RUN_TEMP, 'mutation')
  const ctrlDir = path.join(RUN_TEMP, 'mutation-control')
  fs.mkdirSync(mutDir, { recursive: true })
  fs.mkdirSync(ctrlDir, { recursive: true })

  // ① 对照：未变异的副本必须复现基线（否则"变异让它失败"是空话）
  const ctrlFile = path.join(ctrlDir, 'fingerprint.cjs')
  fs.writeFileSync(ctrlFile, src, 'utf8')
  const ctrlRows = fx.runFingerprintCases(require_(ctrlFile), path.join(RUN_TEMP, 'ctrl-fp'))
  sameJson(ctrlRows.map(normProbeRow), preDoc.host.fingerprint.map(normProbeRow), 'A07 · 未变异的副本必须复现改前基线（对照）')

  // ② 变异：把 digestTree 改成返回常量（其余一字不动）
  const needle = 'function digestTree(dir) {'
  eq(src.split(needle).length, 2, `A07 · 变异锚点必须唯一：${needle}`)
  const CONST = 'sha256:' + '0'.repeat(64)
  const mutated = src.replace(needle, `${needle}\n  return ${JSON.stringify(CONST)};`)
  assert(mutated !== src, 'A07 · 变异必须真的改动源码')
  const mutFile = path.join(mutDir, 'fingerprint.cjs')
  fs.writeFileSync(mutFile, mutated, 'utf8')

  // ③ 判据（A03 的那条）在变异副本上**必须失败**
  const mutRows = fx.runFingerprintCases(require_(mutFile), path.join(RUN_TEMP, 'mut-fp'))
  assert(rowsJson(mutRows.map(normProbeRow)) !== rowsJson(preDoc.host.fingerprint.map(normProbeRow)),
    'A07 · 把指纹改成常量之后，A03 的判据仍然通过 —— 判据是空转的')
  const m = new Map(mutRows.map((r) => [r.id, r]))
  eq(m.get('fp01').result, CONST, 'A07 · 变异副本的指纹必须是那个常量（证明变异真的生效）')
  eq(m.get('fp06').result.changed, false, 'A07 · 常量指纹下"多一个文件→指纹必变"必须变成 false（判据可被证伪）')
  eq(m.get('fp08').result.changed, false, 'A07 · 常量指纹下"换行编码变化→必变"必须变成 false')
  const differing = mutRows.filter((r, i) => rowJson(normProbeRow(r)) !== rowJson(normProbeRow(preDoc.host.fingerprint[i]))).length
  assert(differing >= 5, `A07 · 变异副本应当有多条判据与基线不一致（实得 ${differing} 条）`)

  // ④ 变异只发生在 E:\Temp 副本、仓内权威内核逐字节未动
  eq(sha256(readText(path.join(REPO, KERNEL.fingerprint))), sha256(src), 'A07 · 仓内权威内核不许被变异影响')
  assert(mutFile.startsWith(path.resolve(TEMP_PARENT) + path.sep), 'A07 · 变异副本必须落在 E:\\Temp')

  DETAIL.comparisons.A07 = { constant: CONST, differing, mutatedAt: mutFile, controlAt: ctrlFile }
}

/* ── A08 · 证据与越界守卫有效 ──────────────────────────────────────────── */

async function A08() {
  const fx = await fixtures()
  const preDoc = pre()

  // ① 改前材料齐（缺一即不是"改前采集"）
  for (const p of [PRE_FILE, FIXTURES_FILE, CAPTURE_FILE]) {
    assert(fs.existsSync(p), `A08 · 改前采集材料缺失：${rel(p)}`)
  }
  eq(preDoc.files.length, 6, 'A08 · 改前材料应当锁住 6 个现有文件')
  assert(preDoc.probe.matches === true, 'A08 · 改前采集时 PROBE_VERSION 与探针源重算值必须相等（否则采集窗口不对）')

  // ② 6 个现有文件**真的被改过**，且现在都是"委托形态"
  const changedFiles = []
  for (const f of preDoc.files) {
    const abs = path.join(REPO, f.path)
    assert(fs.existsSync(abs), `A08 · 写集文件不见了：${f.path}`)
    const now = sha256(fs.readFileSync(abs))
    assert(now !== f.sha256, `A08 · ${f.path} 与改前字节相同 —— 本卡其实没改成委托（对拍无意义）`)
    changedFiles.push(f.path)
    const src = readText(abs)
    assert(/unify\//.test(src), `A08 · ${f.path} 里看不到对 ./unify/ 的委托`)
  }
  for (const relPath of Object.values(KERNEL)) {
    assert(fs.existsSync(path.join(REPO, relPath)), `A08 · 权威内核缺失：${relPath}`)
  }
  assert(!/[\r\n]\s*export\s+/.test(readText(path.join(REPO, KERNEL.text))), 'A08 · 内核必须是 CommonJS（不许出现 ESM export）')
  for (const relPath of Object.values(KERNEL)) {
    const src = readText(path.join(REPO, relPath))
    assert(/^\/\*\*/.test(src.trim()) || src.includes("'use strict';"), `A08 · ${relPath} 必须是 'use strict' 的 CJS 形态`)
    assert(!/^export\s/m.test(src), `A08 · ${relPath} 不许出现 ESM export`)
    assert(!/import\s+.*from\s+['"]/.test(src), `A08 · ${relPath} 不许出现 ESM import`)
  }

  // ③ 本卡写集 11 项**都真的改/建了**：以改前整树清单做**逐路径查表**，不做全树对拍
  //    旧判据在这里对「改前整树 ↔ 现在的树」做全量对拍 —— 在"一个工作树、多 lane"的编排下
  //    结构性假红（兄弟 lane 落它们自己的合法写集会被算到本卡头上）。现在只查本卡那 11 条：
  //    它们是**本卡独占**的路径（别人不写），逐路径对拍仍然可归因。
  const preTree = new Map((preDoc.guard.tree || []).map((e) => [e.path, e]))
  eq(preDoc.guard.treeCount, preDoc.guard.tree.length, 'A08 · 改前整树清单条数与记录不符（采集材料自洽性）')
  const writeSetFacts = []
  for (const p of WRITE_SET) {
    const abs = path.join(REPO, p)
    assert(fs.existsSync(abs), `A08 · 写集文件不见了：${p}`)
    const nowHash = sha256(fs.readFileSync(abs))
    const before = preTree.get(p)
    if (before) {
      assert(nowHash !== before.sha256, `A08 · ${p} 与改前字节相同 —— 本卡其实没改它（对拍无意义）`)
      writeSetFacts.push({ path: p, state: 'changed', beforeSha12: before.sha256.slice(0, 12), nowSha12: nowHash.slice(0, 12) })
      continue
    }
    const declared = (preDoc.toBeCreated || []).some((x) => x.path === p)
    assert(declared, `A08 · ${p} 在改前树里不存在，却也不在本卡的 toBeCreated 清单里（写集声明与事实不符）`)
    writeSetFacts.push({ path: p, state: 'created', nowSha12: nowHash.slice(0, 12) })
  }
  eq(writeSetFacts.filter((f) => f.state === 'changed').length, 6, 'A08 · 本卡应当恰好改 6 个既有文件')
  eq(writeSetFacts.filter((f) => f.state === 'created').length, 5, 'A08 · 本卡应当恰好新建 5 个文件')

  // ④ 【判据 1/4】进程内 fs 写守卫：本卡**本次进程**的每一次写都必须落在允许面内
  //    允许面 = { 写集 11 项 } ∪ { 本卡证据根, E:\Temp 下本卡本次临时根 }
  const guard = sweepWriteGuard()
  assert(guard.installed === true, 'A08 · fs 写守卫没挂上（本次进程的写无从判定）')
  assert(guard.patched.length >= 20, `A08 · 挂上的写入口太少（${guard.patched.length}）—— 守卫覆盖面不够`)
  assert(guard.probe, 'A08 · 没有做探针写 —— "守卫真的记得到"没有被自证')
  eq(guard.probe.recorded, true, 'A08 · 探针写没有被守卫记录到（守卫是假的）')
  eq(guard.probe.created, true, 'A08 · 探针写之后文件必须真的存在过')
  eq(guard.probe.allowed, true, 'A08 · 探针写必须落在 E:\\Temp 本次临时根里')
  eq(guard.probe.bytes, true, 'A08 · 探针写的字节数必须对（写真的发生了）')
  eq(guard.probeError, null, `A08 · 探针写本身失败了：${guard.probeError}`)
  eq(guard.violations.length, 0,
    `A08 · 本进程出现了允许面（写集 11 项 / 本卡证据根 / 本次临时根）之外的写入：${guard.violations.slice(0, 5).map((v) => `${v.op} ${v.target}`).join(', ')}`)
  assert(guard.writeCount >= 20, `A08 · 写记录条数太少（${guard.writeCount}）—— 守卫看起来没在真记录`)
  for (const op of ['mkdir', 'write', 'copy']) {
    assert(guard.ops.includes(op), `A08 · 写记录里没有 ${op} 这一类的写 —— 守卫漏了写入口`)
  }
  // 纯函数自证：写允许面的边界。兄弟 lane 的合法写入，对**本卡进程**仍判越界（归因在这儿分开）
  const wProof = proveWriteScope()
  eq(wProof.failures.length, 0,
    `A08 · 写允许面的纯函数自证失败：${wProof.failures.map((f) => `${f.path} → ${f.got}（期望 ${f.expect}）`).join(', ')}`)

  // ⑤ 【判据 2/4】授权写集并集（tracked 侧）：git status 的 M/D/A/R 必须 ⊆ U01–U20 并集
  const s6 = parseSection6(readText(path.join(REPO, 'docs', 'unify', 'interfaces.md')))
  eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）—— 落点表形状变了`)
  const union = authorizedUnion(s6)
  const owners = pathOwners(s6)
  // 锚点：§6 必须真的读到了落点（空表 / 漏行会让"并集"变成假放行）
  for (const [card, p] of [
    ['U01', 'docs/unify/baseline.json'], ['U04', 'lib/unify/text.cjs'],
    ['U06', 'lib/pack-template/tools/ledger-transaction.cjs'], ['U06', 'tools/recover-ledgers.mjs'],
    ['U07', 'lib/render.js'], ['U19', 'lib/pack-scaffold.js'], ['U19', 'package.json'],
  ]) {
    assert(s6.get(card)?.includes(p), `A08 · §6 解析结果里 ${card} 缺落点 ${p}`)
  }
  sameJson([...s6.get(CARD)], WRITE_SET, 'A08 · §6 里 U04 的落点必须逐条等于本卡写集（接口锁与入口不一致）')
  const porcelain = gitRead(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter((l) => l.trim())
  const { tracked, untracked } = splitPorcelainTracked(porcelain)
  const scopeCheck = classifyTrackedWrites(tracked, union)
  eq(scopeCheck.outOfBounds.length, 0,
    `A08 · tracked 改动越出 U01–U20 授权写集并集：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
  assert(tracked.length >= 6, `A08 · tracked 改动只有 ${tracked.length} 条 —— 本卡 6 个既有文件都改了，这不可能`)
  // 双源对账：`git diff --name-status HEAD` 与 status 的 tracked 部分必须是同一批路径
  const diffPaths = gitRead(['-c', 'core.quotepath=false', 'diff', '--name-status', 'HEAD'])
    .split('\n').filter((l) => l.trim()).map((l) => l.split(/\t/).slice(-1)[0].trim())
  const sameSet = (a, b) => [...a].sort().join('\n') === [...b].sort().join('\n')
  eq(sameSet(diffPaths, tracked.map((t) => t.path)), true,
    'A08 · git diff --name-status HEAD 与 git status 的 tracked 部分不是同一批路径（两套账不一致）')
  // 纯函数自证：野路径必红 / 兄弟 lane 真实形状必放行
  const sProof = proveScopeBoundary(s6)
  eq(sProof.failures.length, 0,
    `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)

  // ⑥ 【判据 3/4】本卡交付物内容锁：11 个文件的 sha256 记下来，运行结束时必须仍相等
  const lock = recordContentLock()
  eq(lock.size, WRITE_SET.length, `A08 · 内容锁只记到 ${lock.size} 条（应为 ${WRITE_SET.length}）`)
  const lockNow = verifyContentLock()
  eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)

  // ⑦ 【判据 4/4】U01 采集证据内容锁 + U01 关键产物外部锚点（DELTA-7）
  //    ⚠️ 原判据「audit-evidence/U01 下 runs/ 之外的文件 mtime 必须早于本卡改前采集时刻」
  //    已**删除**：整合 lane 期间，主持人派出的授权写集账本同步任务在 U01 证据目录落下了
  //    ledger-sync-*.txt —— mtime 只说明"被写过"，说不出"谁写的"，在「一个工作树、多 lane」
  //    下把别人的合法产物算成本卡越界（结构性假红），而且与 U01 自己的 A08 重复。
  //    替代：⑤ 只锁**我运行开始时看见过的那批文件**的内容（运行期新增只登记，不判红）；
  //          ⑥ 三个关键产物挂外部锚点，只在**本卡运行期被写**时才红，其余差异只点名归属。
  //    T23（冻结的 T 证据，无 runs 区）仍然是全目录内容摘要对拍，一条没动。
  const evidenceCheck = {}
  for (const [dir, lockRow] of Object.entries(preDoc.guard.existingEvidence)) {
    if (dir !== 'T23') continue          // U01 归到下面的内容锁 + 锚点（不数文件、不看 mtime）
    const abs = path.join(REPO, 'audit-evidence', dir)
    const entries = fs.existsSync(abs) ? fx.treeManifest(abs, { skipTop: new Set() }) : []
    eq(fx.manifestHash(entries), lockRow.hash, `A08 · 既有证据 ${dir} 的内容被改了`)
    evidenceCheck[dir] = { mode: 'content-lock（内容摘要，不数文件）', count: entries.length, countJudged: false }
  }

  // ⑤ U01 采集证据内容锁：运行开始时看见的那批文件，收口前必须逐字节相同
  const u01Lock = verifyU01EvidenceLock()
  eq(u01Lock.recorded, true, 'A08 · U01 采集证据内容锁没有在运行开始时记下来（判据没生效）')
  assert(u01Lock.locked >= 100, `A08 · U01 内容锁只锁到 ${u01Lock.locked} 个文件 —— 锁定面太小，判据空转`)
  assert(u01Lock.manifest.count >= 100, `A08 · U01 登记的逐文件清单只读到 ${u01Lock.manifest.count} 条 —— 登记清单没读到（判据空转）`)
  eq(u01Lock.reds.length, 0,
    `A08 · U01 采集证据在本卡运行期被改写/删除（锁的是运行开始时看见的文件；新增只登记）：${u01Lock.reds.slice(0, 5).map((r) => `${r.kind} ${r.path}`).join(', ')}`)

  // ⑥ U01 关键产物外部锚点：本卡运行期被写才红；与登记值不同只登记 + 归属 U01
  const anchors = judgeU01Anchors(anchorRowsNow(guard.writes.map((w) => w.target)))
  eq(anchors.reds.length, 0,
    `A08 · U01 关键产物在本卡运行期被写：${anchors.reds.slice(0, 5).map((r) => `${r.path}（${r.why}）`).join(', ')}`)
  for (const r of anchors.rows) {
    assert(fs.existsSync(path.join(REPO, r.path)), `A08 · U01 关键产物不见了：${r.path}`)
  }
  // 归属必须与 §6 解析结果一致（interfaces.md / baseline.json 归 U01；evidence-index 归其证据根）
  for (const p of ['docs/unify/interfaces.md', 'docs/unify/baseline.json']) {
    sameJson(owners.get(p) ?? [], ['U01'], `A08 · §6 里 ${p} 的归属必须是 U01`)
  }
  // 纯函数自证：内容锁两个方向 + 锚点两个方向（人造输入，每次运行都跑，改成恒真当场红）
  const lockProof = proveEvidenceLock()
  eq(lockProof.failures.length, 0,
    `A08 · U01 内容锁的纯函数自证失败：${lockProof.failures.map((r) => `${r.label} → ${r.got}（期望 ${r.expect}）`).join('; ')}`)
  const anchorProof = proveAnchorJudge()
  eq(anchorProof.failures.length, 0,
    `A08 · U01 锚点的纯函数自证失败：${anchorProof.failures.map((r) => `${r.label} → ${r.got}（期望 ${r.expect}）`).join('; ')}`)

  const evDirs = fs.readdirSync(path.join(REPO, 'audit-evidence')).sort()
  // 第一层只允许：U 卡编号目录（每卡独占一个）+ 既有 T23（T 线冻结证据）
  //   + **真实存在的 T 卡**的证据目录（`test/audit/T<NN>.mjs` 在盘上 —— 决-1/决-5/决-6/决-9/P2 之后
  //   T 卡由别的卡合法运行，证据目录按设计会留在盘上）。**不是**"T 一律放行"。
  // 他卡并发新建的 U02/U03 目录属 U-SPEC 落点表里各自的证据根，按名字可判归属；别的名字一律不许。
  const isRealT = (d) => /^T\d{2}$/.test(d) && fs.existsSync(path.join(REPO, 'test', 'audit', `${d}.mjs`))
  const unexpectedOf = (list) => list.filter((d) => !/^U\d{2}$/.test(d) && d !== 'T23' && !isRealT(d))
  const evUnexpected = unexpectedOf(evDirs)
  eq(evUnexpected.length, 0, `A08 · audit-evidence 第一层出现了无人认领的证据目录：${evUnexpected.join(', ')}`)
  // 反空转：既不在册、也没有对应 T 卡入口的名字必须被这条判据抓住（真实存在的 T 卡放行，别的仍红）。
  sameJson(unexpectedOf(['U01', 'T23', 'T01', 'TXX-nobody']), ['TXX-nobody'],
    'A08 · 反空转：无人认领的证据目录必须被判出来')
  for (const d of ['U01', 'T23']) assert(evDirs.includes(d), `A08 · 既有证据目录不见了：${d}`)
  evidenceCheck.topLevel = evDirs

  // ⑧ --evidence-root 守卫：默认落本卡新运行目录；越界拒绝；读取根不受它影响
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U04/runs/U04-<pid>')
  const tmpRoot = resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO })
  eq(tmpRoot.ok, true, `A08 · E:\\Temp 下带 ${CARD}- 前缀的新目录必须被接受`)
  const bad1 = resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO })
  eq(bad1.ok, false, 'A08 · 往仓内别处写必须被拒')
  const bad2 = resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO })
  eq(bad2.ok, false, 'A08 · 覆盖既有证据目录必须被拒')
  const bad3 = resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO })
  eq(bad3.ok, false, 'A08 · 相对路径必须被拒')
  // 读取根恒定：--evidence-root 只动写入位置
  eq(path.dirname(PRE_FILE), BASELINE_ROOT, 'A08 · 读取根必须恒为 <repo>/audit-evidence/U04')
  eq(BASELINE_ROOT, path.join(REPO, 'audit-evidence', CARD), 'A08 · 读取根不该被任何参数改成临时目录')

  // ⑨ 临时目录：按绝对路径与归属清理；守卫对该拒的拒、该删的删
  //    scratch 落在**本次唯一临时根**里（不是 E:\Temp 顶层）—— 判据 1 的允许面才闭合：
  //    本进程允许写的临时区就是 RUN_TEMP 一个，别处一概不算"临时".
  const g1 = guardTempPath(RUN_TEMP, { parent: TEMP_PARENT })
  eq(g1.ok, true, `A08 · 本次临时根必须归 ${TEMP_PARENT}（${g1.error || ''}）`)
  assert(/^u04-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u04-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')
  const scratch = path.join(RUN_TEMP, 'guard-scratch')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
  const removed = safeRemoveTree(scratch, { parent: RUN_TEMP })
  eq(removed.removed, true, `A08 · 守卫内的清理必须成功（${removed.error || ''}）`)
  eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')
  eq(guardTempPath(scratch, { parent: TEMP_PARENT }).ok, false, 'A08 · 本次临时根里的子目录不能拿 E:\\Temp 当父目录清理（归属必须精确）')

  // ⑩ 回执：tracked 回执五项齐，且与真实写集/Δ 对得上
  const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
  assert(fs.existsSync(rcPath), 'A08 · 缺 tracked 回执 docs/unify/receipts/U04.json')
  const rc = JSON.parse(readText(rcPath))
  eq(rc.card, CARD, 'A08 · 回执 card 不对')
  eq(rc.status, 'PASS', 'A08 · 回执 status 必须是 PASS（判词以本入口为准）')
  for (const key of ['completion', 'dependencies', 'interfaceConsumption', 'writeSet', 'deltas', 'verdict', 'unverified', 'evidenceIndex']) {
    assert(key in rc, `A08 · 回执缺字段 ${key}`)
  }
  sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
  const deltaIds = preDoc.packVsHost.text.map((d) => d.id)
  const registered = JSON.stringify(rc.deltas)
  for (const id of deltaIds) {
    assert(registered.includes(id), `A08 · Δ 登记里必须点名 ${id}（包侧 what 前缀收敛）`)
  }
  assert(rc.unverified.some((u) => /U19/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记"仓内随包闭包待 U19"')
  assert(rc.unverified.some((u) => /T26|migratedPack/.test(JSON.stringify(u))), 'A08 · 未验证边界里必须登记 T26 夹具新增回归')
  // 本次判据范围修正必须在回执里留痕（Δ 登记，kind=audit-criterion-scope）
  assert(rc.deltas.some((d) => d?.kind === 'audit-criterion-scope'),
    'A08 · 回执必须登记本次 A08 判据范围修正（deltas 里 kind=audit-criterion-scope）')
  // 第二批判据范围修正（删证据新鲜度判据 → 内容锁 + 外部锚点）也必须在回执里留痕
  const recencyDelta = rc.deltas.find((d) => d?.kind === 'evidence-recency-criterion-realignment')
  assert(recencyDelta, 'A08 · 回执必须登记证据新鲜度判据的替换（deltas 里 kind=evidence-recency-criterion-realignment）')
  for (const key of ['reportedFailure', 'whyWrong', 'before', 'after', 'attribution', 'strength', 'selfProof']) {
    assert(key in recencyDelta, `A08 · Δ（证据新鲜度判据替换）缺字段 ${key}`)
  }
  assert(Array.isArray(recencyDelta.after) && recencyDelta.after.length >= 3,
    `A08 · Δ（证据新鲜度判据替换）必须逐条登记三条替代判据（实得 ${recencyDelta.after?.length ?? 0} 条）`)
  assert(/假红/.test(JSON.stringify(recencyDelta)) && /不可归因/.test(JSON.stringify(recencyDelta)),
    'A08 · Δ 里必须写清「原判据会因任何授权工作在 U01 证据目录落文件而假红」与「不可归因」')

  DETAIL.comparisons.A08 = {
    // 判据 0/4：本卡 11 条的改/建事实（逐路径查表，不做全树对拍）
    changedFiles,
    writeSetFacts,
    // 判据 1/4：进程内写守卫
    writeGuard: {
      installed: guard.installed,
      patched: guard.patched.length,
      writeCount: guard.writeCount,
      ops: guard.ops,
      probe: guard.probe,
      violations: guard.violations,
      scope: guard.scope,
      proof: wProof.rows,
    },
    // 判据 2/4：授权并集（tracked 侧）+ 归因点名
    authorizedUnion: {
      cards: s6.size,
      paths: union.size,
      trackedChanges: tracked.map((t) => ({
        code: t.code, path: t.path, owners: owners.get(t.path) ?? [],
      })),
      untrackedCount: untracked.length,   // 未跟踪侧归 U01 的 A01 管，这里只登记条数
      outOfBounds: scopeCheck.outOfBounds,
      diffCrossCheck: { statusPaths: tracked.length, diffPaths: diffPaths.length, sameSet: true },
      proof: sProof.rows,
    },
    // 判据 3/4：内容锁
    contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
    // 判据 4/4：既有证据（count 只登记，不判定）
    existingEvidence: evidenceCheck,
    // 判据 4/4·⑤：U01 采集证据内容锁（只锁运行开始时看见的那批文件；新增只登记）
    u01EvidenceLock: {
      recordedAt: u01Lock.recordedAt,
      locked: u01Lock.locked,
      observed: u01Lock.observed,
      registeredManifest: u01Lock.manifest,
      addedCount: u01Lock.added.length,
      addedNames: u01Lock.added.slice(0, 200),   // 只登记条数与文件名（不判红）
      addedTruncated: u01Lock.added.length > 200,
      changed: u01Lock.changed,
      missing: u01Lock.missing,
      reds: u01Lock.reds,
      proof: lockProof.rows,
    },
    // 判据 4/4·⑥：U01 关键产物外部锚点（只在运行期被写时红；其余差异只点名归属）
    u01Anchors: {
      rows: anchors.rows.map((r) => ({
        path: r.path, owner: r.owner, registered: r.registered,
        registeredSha: r.registeredSha ? r.registeredSha.slice(0, 12) : null,
        registeredShaSource: r.registeredShaSource,
        registeredBytes: r.registeredBytes, currentBytes: r.currentBytes,
        startSha: r.startSha ? r.startSha.slice(0, 12) : null,
        currentSha: r.currentSha ? r.currentSha.slice(0, 12) : null,
        registeredDiffers: r.registeredDiffers, bytesDiffer: r.bytesDiffer,
        runtimeHit: r.runtimeHit, windowChanged: r.windowChanged,
        writtenDuringRun: r.writtenDuringRun, informational: r.informational, red: r.red, why: r.why,
      })),
      informational: anchors.informational.map((r) => r.path),
      reds: anchors.reds.map((r) => r.path),
      proof: anchorProof.rows,
    },
    evidenceRootDefault: defaultRoot.root,
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

/** 写守卫必须在**第一笔写之前**挂上（本卡的写全在 A01–A08 与收口落盘里） */
if (IS_MAIN) {
  // 运行开始时的快照（DELTA-7 的判据 ⑤⑥ 的"我当时看见的"）：先读盘，再挂守卫，再写任何东西
  try {
    recordU01EvidenceLock()
    recordAnchorStart()
  } catch (e) {
    // 采集失败不在这里判红：A08 会断言 recorded === true（判据空转必须当场红）
    DETAIL.u01SnapshotError = String(e?.message ?? e)
  }
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

/**
 * 收口复核：**整个进程**的写 + 本卡交付物内容锁 + U01 采集证据内容锁 + U01 锚点
 * （在所有写之后再看一遍）。A08 里那一次是"到目前为止"的快照；这里补的是 A08 之后仍然
 * 发生的写（证据落盘）。
 */
function closingAudit() {
  const w = sweepWriteGuard()
  const c = verifyContentLock()
  const u = verifyU01EvidenceLock()
  const a = judgeU01Anchors(anchorRowsNow(w.writes.map((x) => x.target)))
  const reasons = []
  if (!w.installed) reasons.push('写守卫没挂上')
  if (w.probeError) reasons.push(`探针写失败：${w.probeError}`)
  if (w.probe && w.probe.recorded !== true) reasons.push('探针写未被守卫记录到')
  for (const v of w.violations.slice(0, 2)) reasons.push(`越界写 ${v.op} ${v.target}`)
  for (const m of c.mismatches.slice(0, 2)) reasons.push(`交付物被改 ${m.path}`)
  for (const r of u.reds.slice(0, 2)) reasons.push(`U01 采集证据被改写 ${r.kind} ${r.path}`)
  for (const r of a.reds.slice(0, 2)) reasons.push(`U01 关键产物在运行期被写 ${r.path}`)
  if (!u.recorded) reasons.push('U01 内容锁没在运行开始时记下来')
  return { ok: reasons.length === 0, reasons, writeGuard: w, contentLock: c, u01Lock: u, anchors: a }
}

/** 收口发现越界 → 把 PASS 降成 FAIL（判词与落盘记录一致：以收口结果为准） */
function demoteVerdict(v, reasons) {
  const reason = `A08 · 收口复核失败：${reasons.slice(0, 2).join('；')}`
  const cases = v.cases.map((c) => (c.id === 'A08'
    ? { ...c, actual: 'fail', note: `${c.note ? `${c.note} | ` : ''}${reason}` }
    : c))
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
    // 本次运行的临时根：清理前核对解析后的绝对路径与归属（父目录必须是 E:\Temp，名字必须带本次 pid）
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

  // ① 证据落盘（这些写本身也在守卫的允许面里，会被记到）
  if (evidenceGuard.ok) writeRunEvidence(verdict, evidenceGuard.root)

  // ② 收口复核（此刻本进程的写都发生了；A08 之后只剩证据落盘）
  const closing = closingAudit()
  DETAIL.closing = {
    ok: closing.ok,
    reasons: closing.reasons,
    writeCount: closing.writeGuard.writeCount,
    violations: closing.writeGuard.violations,
    contentLockChecks: closing.contentLock.checks,
    contentLockMismatches: closing.contentLock.mismatches,
    u01Lock: {
      locked: closing.u01Lock.locked,
      observed: closing.u01Lock.observed,
      addedCount: closing.u01Lock.added.length,
      changed: closing.u01Lock.changed,
      missing: closing.u01Lock.missing,
      reds: closing.u01Lock.reds,
    },
    u01Anchors: {
      informational: closing.anchors.informational.map((r) => r.path),
      writtenDuringRun: closing.anchors.rows.filter((r) => r.writtenDuringRun).map((r) => r.path),
      reds: closing.anchors.reds.map((r) => r.path),
    },
  }
  if (!closing.ok && verdict.status === 'PASS') {
    verdict = demoteVerdict(verdict, closing.reasons)
    if (evidenceGuard.ok) writeRunEvidence(verdict, evidenceGuard.root)  // 以 FAIL 为准覆盖，不留自相矛盾的 PASS 记录
  }

  // ③ 明细最后落盘（含收口结果；判词行仍是 stdout 唯一一行）
  if (evidenceGuard.ok) {
    const dir = evidenceGuard.root
    DETAIL.entry = { file: rel(SELF), dir: HERE }
    DETAIL.argv = ARGV
    DETAIL.verdict = { line: verdict.line, code: verdict.code, ms: verdict.ms }
    DETAIL.cases = Object.fromEntries(verdict.cases.map((c) => [c.id, { status: c.actual, note: c.note, ms: c.ms }]))
    DETAIL.baseline = { file: rel(PRE_FILE), sha256: sha256(fs.readFileSync(PRE_FILE)) }
    fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
  }
  process.exitCode = printVerdict(verdict)
}
