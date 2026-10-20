#!/usr/bin/env node
/**
 * test/audit/U02.mjs —— 规范身份内核（U02 专项入口）
 * ==================================================================
 * 入口：`node test/audit/U02.mjs`（可选 `--evidence-root=<绝对路径>`）
 *
 * 判词（stdout **只有一行**，exit 0/1/2）：
 *   `PASS U02 checks=8 failed=0 skipped=0` / `FAIL U02 …` / `BLOCKED U02 …`
 *
 * 八项（本卡固定集合，全部是真实断言，没有 skip、没有恒真、没有吞错）：
 *   A01 键构造与解析往返一致（含课号补零 0001/0009/0100/9999；并与既有导出的合法输入逐字节对拍）
 *   A02 不同圆圈同名知识点不冲突（programming/vue 与 math/vue 互不相等、互不覆盖）
 *   A03 运行态拒绝裸点、两段课键、显示名
 *   A04 拒绝空组成部分与路径逃逸形状
 *   A05 四位课号边界符合契约、超范围不截断（0/-1/10000/1.5/'0001' 等逐个断言）
 *   A06 模块无 IO、无时钟、无环境依赖（源码静态扫描 + 行为断言 + 模块实例重建）
 *   A07 临时去掉圆圈组成部分后判据必须变红（只在 E:\Temp 本次唯一目录；干净副本必须先 PASS）
 *   A08 文件越界与证据守卫（写集 ⊆ 卡面写集、证据只在允许位置、临时目录按绝对路径清理）
 *       ＋ 依赖锚点：**本卡运行期没写**那些只读文件（运行期自锚），并且若它们在运行期之外
 *         已与 U01 锚点不同，则按 docs/unify/interfaces.md §6 的落点表**归属到合法卡**；
 *         无归属的漂移、以及既有测试的既有改动，仍然红（口径见下方「依赖锚点」一节）。
 *
 * 执行壳用 `test/audit/unify-runner.mjs` 的 `runCard`（**真 await**），
 * 不用同步 `case()` 壳 —— 那会把未完成的 Promise 记成通过。
 *
 * 调试开关（**不产出判词、不落证据**，只打印锚点判定结果，供人核对反空转红/绿）：
 *   `node test/audit/U02.mjs --print-anchor-demos`
 *
 * 只读边界：lib/pack-model.js、lib/point-ref.js、既有 test/*.mjs、cards/、docs/unify/interfaces.md、
 * docs/unify/baseline.json 全部只读；本卡不碰活包、不碰审计主树、不跑全量门槛、不操作 git 仓库状态。
 *
 * ⚠️ 「本卡只读」≠「全树静止」：§12 A 路径上 U09 的写集**就是** lib/pack-model.js，
 * U18/U19 同理会改 lib/state.js / package.json。所以 A08 不再断言「与 U01 锚点逐字节相同」
 * （那实际是在断言别的卡一个字都没动过 —— 判据口径错），改成「本卡运行期没写它」+
 * 「已漂移则归属到 §6 落点表里的那张卡」。真越界（无归属的漂移、既有测试被改）仍然红。
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
// 既有公开导出（只读消费）：A01 用它证明"合法输入逐字节一致"，A05 用它登记 padStart 的现状差异。
import { pointKey as baselinePointKey, lessonKey as baselineLessonKey } from '../../lib/pack-model.js'

const CARD = 'U02'
const SELF = fileURLToPath(import.meta.url)
const requireCjs = createRequire(import.meta.url)

const IDENTITY_REL = 'lib/unify/identity.cjs'
const IDENTITY_ABS = path.join(REPO, IDENTITY_REL)
const TEMP_PARENT = 'E:\\Temp'
const MUT_PREFIX = 'U02-mut-'
/** A07 变异标记（也用来让子进程自证"我跑的是干净副本还是变异副本"） */
const MUTATION_MARKER = '/* U02-MUTANT 点键丢掉 circle */'
const IS_MUTATION_CHILD = process.env.DSH_WHALE_U02_NO_MUTATION === '1'
const EXPECT_MUTANT = process.env.DSH_WHALE_U02_EXPECT_MUTANT === '1'

/** 本卡写集（相对仓根）—— 与卡面逐条相同；A08 断言"写集 ⊆ 卡面写集"。 */
const WRITE_SET = [
  'lib/unify/identity.cjs',
  'test/audit/U02.mjs',
  'docs/unify/receipts/U02.json',
  'audit-evidence/U02/',
]

/** 只读边界（A08 断言写集与它们不相交；也是"没改既有东西"的显式清单）。 */
const PROTECTED = [
  'lib/pack-model.js',
  'lib/point-ref.js',
  'package.json',
  'docs/unify/interfaces.md',
  'docs/unify/baseline.json',
  'docs/unify/authorization.json',
  'test/audit/unify-runner.mjs',
  'test/audit/U01.mjs',
  'test/audit/harness.mjs',
  'cards/U-SPEC.md',
  'cards/U02.md',
]

/** 本卡自己的三个可写文件：运行期间也不许被改动（防并发写者与意外自改）。 */
const SELF_FILES = ['lib/unify/identity.cjs', 'test/audit/U02.mjs', 'docs/unify/receipts/U02.json']

/**
 * 运行期自锚（A08 ①）：卡面点名要自锚的六个文件 —— **本卡这一跑不许写它们**。
 * 这跟"它们在全国范围内不许变"是两件事：U09 改 lib/pack-model.js 合法，但**本卡进程**不许写。
 */
const SELF_ANCHOR_FILES = [
  'lib/pack-model.js',
  'lib/point-ref.js',
  'package.json',
  'lib/unify/identity.cjs',
  'test/audit/unify-runner.mjs',
  'docs/unify/interfaces.md',
]

/** U01 的两份锚点产物自己也要进自锚集合：它们一变，外部基准就没了。 */
const ANCHOR_ARTIFACTS = ['docs/unify/baseline.json']

/* ══════════════════════════════════════════════════════════════════════
 * 证据根：**读取的材料根不随 --evidence-root 变**（本卡读的是 REPO 里的源码）
 * ══════════════════════════════════════════════════════════════════════ */
const ARGV = process.argv.slice(2)
const EV_SPEC = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
if (!EV_SPEC.ok) {
  // 证据根非法 ⇒ 既不能落证据也不能冒充通过：BLOCKED + exit 2（单行判词）
  process.stdout.write(`BLOCKED ${CARD} 证据根非法：${EV_SPEC.error}\n`)
  process.exit(2)
}
const EV_ROOT = EV_SPEC.root
const EV_SOURCE = EV_SPEC.source

/* ══════════════════════════════════════════════════════════════════════
 * 断言原语（每条都计数；用例内任何一条失败都会让该用例 FAIL）
 * ══════════════════════════════════════════════════════════════════════ */
let CURRENT_CASE = null
const COUNTS = Object.create(null)
const FACTS = []

function tally() {
  if (CURRENT_CASE) COUNTS[CURRENT_CASE] = (COUNTS[CURRENT_CASE] || 0) + 1
}

function assert(cond, msg) {
  tally()
  if (!cond) throw new Error(msg || '断言失败')
}

function eq(actual, expected, msg) {
  tally()
  if (actual !== expected) {
    throw new Error(`${msg || '不相等'}：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
  }
}

function deepEq(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg)
}

function fact(note, payload) {
  FACTS.push({ case: CURRENT_CASE, note, payload })
}

function caseBody(id, body) {
  return async () => {
    CURRENT_CASE = id
    COUNTS[id] = 0
    return body()
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function identityModule() {
  if (!fs.existsSync(IDENTITY_ABS)) throw new Blocked(`缺身份内核：${IDENTITY_REL}（${IDENTITY_ABS}）`)
  return requireCjs(IDENTITY_ABS)
}

/** 构造期拒绝：必须是 IdentityError + 带具体 failure（不是"随便抛了个错"）。 */
function expectIdentityThrow(label, fn, reason, field) {
  let thrown = null
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  assert(thrown !== null, `${label} 应当被拒绝，但没有抛错（返回了值）`)
  assert(thrown && thrown.name === 'IdentityError',
    `${label} 抛的不是 IdentityError：${thrown && thrown.name}: ${thrown && thrown.message}`)
  const f = thrown.failure
  assert(f && typeof f === 'object', `${label} 的 IdentityError 没带 failure`)
  eq(f.kind, 'input', `${label} 的 failure.kind`)
  eq(f.reason, reason, `${label} 的失败原因`)
  if (field) eq(f.field, field, `${label} 的失败字段`)
  assert(typeof f.error === 'string' && f.error.length > 0, `${label} 的失败理由不能是空话`)
  return f
}

/** 解析期拒绝：{ok:false, failure}，且**不给 value**（拒绝就不能有半成品答案）。 */
function expectParseFail(label, result, reason, field) {
  assert(result && result.ok === false, `${label} 应当被拒绝，实得 ${JSON.stringify(result)}`)
  assert(!Object.prototype.hasOwnProperty.call(result, 'value'), `${label} 被拒绝时不该同时给 value`)
  const f = result.failure
  assert(f && typeof f === 'object', `${label} 没有 failure`)
  eq(f.kind, 'input', `${label} 的 failure.kind`)
  eq(f.reason, reason, `${label} 的失败原因`)
  if (field) eq(f.field, field, `${label} 的失败字段`)
  assert(typeof f.error === 'string' && f.error.length > 0, `${label} 的失败理由不能是空话`)
  return f
}

/* ══════════════════════════════════════════════════════════════════════
 * 仓内清单对拍（A08：本次运行没有写集外文件）
 * ══════════════════════════════════════════════════════════════════════ */
const SNAPSHOT_EXCLUDE = new Set(['.git', 'audit-evidence', 'node_modules'])

function snapshotRepo(root = REPO) {
  const out = []
  const walk = (dir, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      throw new Error(`清单对拍读不了目录 ${dir}：${e.message}`)
    }
    for (const ent of entries) {
      if (SNAPSHOT_EXCLUDE.has(ent.name)) continue
      const abs = path.join(dir, ent.name)
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        out.push(`${relPath}/`)
        walk(abs, relPath)
      } else if (ent.isFile()) {
        const st = fs.statSync(abs)
        out.push(`${relPath}|${st.size}|${Math.round(st.mtimeMs)}`)
      } else {
        out.push(`${relPath}|other`)
      }
    }
  }
  walk(root, '')
  out.sort()
  return out
}

/** 内容指纹（bytes + sha256）；文件不存在记 null —— 不用 mtime，也不用 git 状态。 */
function hashOf(abs) {
  if (!fs.existsSync(abs)) return null
  const buf = fs.readFileSync(abs)
  return { bytes: buf.length, sha256: sha256(buf) }
}

function hashWatched() {
  const map = Object.create(null)
  for (const rel of WATCHED_FILES) map[rel] = hashOf(path.join(REPO, rel))
  return map
}

function diffSnapshots(before, after) {
  const setBefore = new Set(before)
  const setAfter = new Set(after)
  const onlyBefore = before.filter((x) => !setAfter.has(x))
  const onlyAfter = after.filter((x) => !setBefore.has(x))
  return { onlyBefore, onlyAfter, same: onlyBefore.length === 0 && onlyAfter.length === 0 }
}

/* ══════════════════════════════════════════════════════════════════════
 * 依赖锚点：口径修正（A08 的 ① / ②）
 * ──────────────────────────────────────────────────────────────────────
 * 旧判据（已废）：`lib/pack-model.js` / `package.json` 的字节 + sha256 必须**等于**
 *   U01 接口锁登记的值。它实际断言的是「跨卡静止」—— 而 §12 A 路径上 U09 的写集
 *   **就是** lib/pack-model.js（把 pointKey/lessonKey 与 point-ref 的内联构造收敛到
 *   lib/unify/identity.cjs），U09 一落地这条必红。那是判据口径错，不是本卡交付物有问题
 *   （依据：docs/unify/authorization.json 的 derivedConsequences.C3）。
 *
 * 新判据（强度不减，且可归因）：
 *   ① 运行期自锚：运行开始与收口各取一次内容指纹，**本卡这一跑不许写**它们
 *      （写入另有进程内 fs 写守卫逐次记录绝对路径，可按路径逐条比对）。
 *   ② 归属：若某文件在运行期**之外**就已与 U01 锚点不同，不再判红，而按
 *      docs/unify/interfaces.md §6 的**落点表**（运行时解析，本文件不抄死这份表）
 *      判「谁合法拥有它」；落点表里没有归属 ⇒ 仍然红。
 *   ③ 既有测试（test/*.mjs、test/audit/T*.mjs）的既有改动一律红：唯一例外是 §12 A
 *      的授权面（test/mirror-parity.mjs 归 U09、test/intake.mjs 归 U10）。
 * ══════════════════════════════════════════════════════════════════════ */

/** §12 A 的授权面：既有测试里**唯一**允许被某张卡同卡原子迁移的两处。 */
const AUTH_FACE = new Map([
  ['test/mirror-parity.mjs', 'U09'],
  ['test/intake.mjs', 'U10'],
])

/** interfaces.md 里「U01–U20 写集落点」那一节的序号。 */
const LANDING_SECTION = 6

const MD_ABS = path.join(REPO, 'docs', 'unify', 'interfaces.md')
const BASELINE_ABS = path.join(REPO, 'docs', 'unify', 'baseline.json')

/** 接口锁里的锚点行：`| `path` | 字节 | `sha256` |`（§1 重点文件 + §3 另读落点）。 */
function readLockedSource(file) {
  const md = fs.readFileSync(MD_ABS, 'utf8')
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rx = new RegExp(`\\|\\s*\`${esc}\`\\s*\\|\\s*(\\d+)\\s*\\|\\s*\`([0-9a-f]{64})\`\\s*\\|`)
  const m = rx.exec(md)
  if (!m) throw new Blocked(`接口锁（docs/unify/interfaces.md）里找不到 ${file} 的字节/sha256 行`)
  return { bytes: Number(m[1]), sha256: m[2] }
}

/** 从 interfaces.md 的 §1 / §3 表格里抽锚点行（只认 `| `path` | 数字 | `64hex` |` 的形状）。 */
function parseAnchorRows(md) {
  const rows = new Map()
  let section = 0
  for (const line of md.split(/\r?\n/)) {
    const head = /^##\s+(\d+)\./.exec(line)
    if (head) { section = Number(head[1]); continue }
    if (section !== 1 && section !== 3) continue
    const row = /^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*`([0-9a-f]{64})`\s*\|/.exec(line)
    if (!row) continue
    if (rows.has(row[1])) throw new Error(`接口锁里同一个文件登记了两次锚点：${row[1]}`)
    rows.set(row[1], { bytes: Number(row[2]), sha256: row[3], section })
  }
  return rows
}

/**
 * 从 interfaces.md §6 抽「谁合法拥有哪个落点」。
 * 只认路径形状的反引号令牌：`A01` 这类用例令牌、以及带中文的整句（示例：`audit-evidence/U01/ 下…`）
 * 都不算落点。同一落点被两张卡同时认领 ⇒ 表本身自相矛盾，直接报错（不静默取先到的那个）。
 */
function parseLandingTable(md) {
  const owners = new Map()
  const cards = new Set()
  let section = 0
  for (const line of md.split(/\r?\n/)) {
    const head = /^##\s+(\d+)\./.exec(line)
    if (head) { section = Number(head[1]); continue }
    if (section !== LANDING_SECTION) continue
    const row = /^\|\s*(U\d\d)\s*\|(.*)\|\s*$/.exec(line)
    if (!row) continue
    const card = row[1]
    cards.add(card)
    for (const tok of row[2].matchAll(/`([^`]+)`/g)) {
      const raw = tok[1].trim()
      if (!/^[A-Za-z0-9._/-]+$/.test(raw)) continue
      if (!raw.includes('/') && !raw.includes('.')) continue
      const rel = raw.replace(/\/+$/, '')
      if (!rel) continue
      if (owners.has(rel) && owners.get(rel) !== card) {
        throw new Error(`§6 落点表自相矛盾：${rel} 同时归 ${owners.get(rel)} 与 ${card}`)
      }
      owners.set(rel, card)
    }
  }
  return { owners, cards }
}

let ANCHOR_LOAD_ERROR = null
let ANCHOR_ROWS = new Map()
let ANCHOR_TABLE = new Map()
let OWNER_TABLE = new Map()
let LANDING_CARDS = new Set()
try {
  const md = fs.readFileSync(MD_ABS, 'utf8')
  const baseline = JSON.parse(fs.readFileSync(BASELINE_ABS, 'utf8'))
  ANCHOR_ROWS = parseAnchorRows(md)
  ANCHOR_TABLE = new Map((baseline.sourceLock?.files ?? []).map((f) => [f.path, { bytes: f.bytes, sha256: f.sha256, role: f.role }]))
  const landing = parseLandingTable(md)
  OWNER_TABLE = landing.owners
  LANDING_CARDS = landing.cards
  if (ANCHOR_ROWS.size === 0 || ANCHOR_TABLE.size === 0 || OWNER_TABLE.size === 0) {
    ANCHOR_LOAD_ERROR = `锚点表解析结果为空（md 行=${ANCHOR_ROWS.size} baseline 条=${ANCHOR_TABLE.size} 落点=${OWNER_TABLE.size}）`
  }
} catch (e) {
  ANCHOR_LOAD_ERROR = `读不动 U01 锚点（${MD_ABS} / ${BASELINE_ABS}）：${e.message}`
}

/**
 * 判定面 = U01 登记的 29 条锚点 + 卡面点名的 6 个自锚文件 + U01 的锚点产物 + 本卡自己的 3 个可写文件。
 * 只增不减：少看一个文件就是一处漏判。
 */
const WATCHED_FILES = [...new Set([
  ...ANCHOR_TABLE.keys(),
  ...SELF_ANCHOR_FILES,
  ...ANCHOR_ARTIFACTS,
  ...SELF_FILES,
])]

const CARD_ENTRY_RX = /^test\/audit\/U\d\d\.mjs$/

/** 既有测试 = test/** 里除各卡自己新建的 test/audit/U??.mjs 之外的文件；落点表里有主人的按归属判。 */
function isExistingTest(rel) {
  if (!rel.startsWith('test/')) return false
  if (CARD_ENTRY_RX.test(rel)) return false
  return !OWNER_TABLE.has(rel)
}

const stateKey = (h) => (h && Number.isFinite(h.bytes) && typeof h.sha256 === 'string' ? `${h.bytes}:${h.sha256}` : null)

/**
 * 依赖锚点判定（**纯函数**：同样的输入永远同样的判定，没有模块状态、不看时钟、不读盘）。
 *
 * 状态：`ok` 通过 / `attributed` 放行但**记名归属**（不是"没看见"） / `red` 红。
 * 顺序即口径：运行期写入 → 运行期增删改 → 与 U01 锚点比 → 既有测试 → 落点表归属。
 *
 * @param {{rel:string, before?:object|null, after?:object|null, anchor?:object|null, wroteByThisRun?:boolean}} input
 * @returns {{rel:string,status:'ok'|'attributed'|'red',code:string,reason:string,owner:string|null,
 *   before:string|null,after:string|null,anchor:string|null}}
 */
function judgeAnchor(input) {
  const rel = String(input?.rel ?? '')
  const before = input?.before === undefined ? null : (input.before ?? null)
  const after = input?.after === undefined ? before : (input.after ?? null)
  const anchor = Object.prototype.hasOwnProperty.call(input ?? {}, 'anchor')
    ? (input.anchor ?? null)
    : (ANCHOR_TABLE.get(rel) ?? null)
  const wroteByThisRun = input?.wroteByThisRun === true
  const owner = OWNER_TABLE.get(rel) ?? null
  const out = (status, code, reason, ownerOverride) => ({
    rel, status, code, reason, owner: ownerOverride ?? owner,
    before: stateKey(before), after: stateKey(after), anchor: stateKey(anchor),
  })

  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    return out('red', 'not-repo-relative', '判定输入不是仓内相对路径（判据不接受越界形状的输入）')
  }
  // ① 运行期自锚：本卡这一跑写了它 ⇒ 红（不管别的卡是否"有权"改它 —— 那不是本卡的手）
  if (wroteByThisRun) return out('red', 'run-window-write', '本卡这一跑写了它（运行期自锚失败）')

  const change = before === null && after === null ? 'absent'
    : before === null ? 'created'
      : after === null ? 'deleted'
        : (stateKey(before) === stateKey(after) ? 'unchanged' : 'modified')

  if (change === 'absent') return out('ok', 'absent', '这棵树里没有它（不参与判定，也不冒充通过）')
  if (change === 'modified') {
    if (owner && owner !== CARD && !isExistingTest(rel)) {
      return out('attributed', 'run-window-concurrent', `运行期内容变了，但落点表把它归 ${owner}（本进程写日志里没有它）`)
    }
    return out('red', 'run-window-change', owner
      ? `运行期被改，且归属 ${owner} 要么是本卡自己、要么是既有测试`
      : '运行期被改，且它在任何 U 卡落点表里都没有归属')
  }
  if (change === 'created') {
    if (owner) return out('attributed', 'created-in-landing', `新建，落点表把它归 ${owner}`)
    return out('red', 'created-outside-writeset', '新建，但它不在任何 U 卡落点表里（写集外新增）')
  }
  if (change === 'deleted') {
    if (anchor) return out('red', 'anchored-deleted', 'U01 登记过它，却被删了')
    if (owner) return out('attributed', 'deleted-in-landing', `删除，落点表把它归 ${owner}`)
    return out('red', 'deleted-outside-writeset', '删除，且不在任何 U 卡落点表里')
  }

  // ②③ 运行期没变 → 与 U01 锚点比，再按落点表归属
  const anchorState = stateKey(anchor)
  if (!anchorState) return out('ok', 'un-anchored', 'U01 没有登记它的锚点值（这类文件只能靠运行期自锚判）')
  if (anchorState === stateKey(after)) return out('ok', 'anchored-intact', '与 U01 锚点逐字节一致')
  if (isExistingTest(rel)) {
    const auth = AUTH_FACE.get(rel)
    if (auth) return out('attributed', 'authorized-test-migration', `§12 A 授权面：既有测试的身份预期由 ${auth} 同卡原子迁移`, auth)
    return out('red', 'existing-test-modified', '既有测试的既有改动不在 §12 A 的授权面内')
  }
  if (owner && owner !== CARD) return out('attributed', 'owned-drift', `已与 U01 锚点不同，但落点表把它归 ${owner}`)
  if (owner === CARD) return out('ok', 'own-drift', '本卡自己的写集文件（运行期自锚已单独判过）')
  return out('red', 'unattributable-drift', '与 U01 锚点不同，且它在任何 U 卡落点表里都没有归属')
}

/** 把判定面整体判一遍（A08 与调试开关共用同一段，避免"打印一套、断言另一套"）。 */
function classifyWatched(before, after, writeLogTargets) {
  const norm = (p) => {
    try { return path.resolve(String(p)).toLowerCase() } catch { return null }
  }
  const wrote = new Set((writeLogTargets ?? []).map(norm).filter(Boolean))
  return WATCHED_FILES.map((rel) => judgeAnchor({
    rel,
    before: before?.[rel] ?? null,
    after: after?.[rel] ?? null,
    wroteByThisRun: wrote.has(norm(path.join(REPO, rel))),
  }))
}

/**
 * 反空转自证的人造输入：**4 红 + 5 绿**。
 * 红的三条正是口径修正要防的三类真越界：野路径新增、本卡运行期写锚点、既有测试被改；
 * 绿的是 U09/U10 的合法改动（pack-model.js / lesson-map.js / mirror-parity.mjs / intake.mjs）
 * 与 U04 的 fingerprint.js。
 * （lesson-map.js 与两张 A 面测试不在 U01 的 29 条锁里，Green 5/8 用**人造锚点**，
 *   只用来证明"归属判据"本身有效 —— 这些不冒充外部锚点。）
 * 账本同步后：mirror-parity 已落 §6 U09、intake 已落 §6 U10 → 两条都走 owned-drift
 * （仍是 attributed + **写明主人**，强度不降）；authorized-test-migration 分支仍在代码里，
 * 只是 A 面那两处现在都已有 §6 归属，不再有落在这条分支上的活样本。
 */
function anchorDemos() {
  const h = (bytes, ch) => ({ bytes, sha256: String(ch).repeat(64) })
  const pmAnchor = ANCHOR_TABLE.get('lib/pack-model.js') ?? h(61085, 'd')
  const fpAnchor = ANCHOR_TABLE.get('lib/fingerprint.js') ?? h(7901, '6')
  const packTestAnchor = ANCHOR_TABLE.get('test/_pack.mjs') ?? h(12119, '2')
  const lessonMapAnchor = h(4321, 'f')
  const mirrorAnchor = h(8000, '8')
  return [
    { name: '野路径 lib/whatever.js 被新建（任何落点表都没有）', expect: 'red', code: 'created-outside-writeset', input: { rel: 'lib/whatever.js', before: null, after: h(64, 'a') } },
    { name: '本卡运行期改了 lib/pack-model.js', expect: 'red', code: 'run-window-write', input: { rel: 'lib/pack-model.js', before: pmAnchor, after: h(61200, 'b'), wroteByThisRun: true } },
    { name: '未归属的既有测试改动 M test/_pack.mjs', expect: 'red', code: 'existing-test-modified', input: { rel: 'test/_pack.mjs', before: h(12200, 'c'), after: h(12200, 'c'), anchor: packTestAnchor } },
    { name: '运行期并发改动且无归属 tools/stray.mjs', expect: 'red', code: 'run-window-change', input: { rel: 'tools/stray.mjs', before: h(10, '1'), after: h(11, '2') } },
    { name: 'U09 合法改 lib/pack-model.js（M）', expect: 'attributed', code: 'owned-drift', input: { rel: 'lib/pack-model.js', before: h(62000, 'e'), after: h(62000, 'e'), anchor: pmAnchor } },
    { name: 'U09 合法改 lib/pack-template/tools/lesson-map.js（M，人造锚点）', expect: 'attributed', code: 'owned-drift', input: { rel: 'lib/pack-template/tools/lesson-map.js', before: h(5000, '9'), after: h(5000, '9'), anchor: lessonMapAnchor } },
    { name: 'U04 合法改 lib/fingerprint.js（M）', expect: 'attributed', code: 'owned-drift', input: { rel: 'lib/fingerprint.js', before: h(8100, '4'), after: h(8100, '4'), anchor: fpAnchor } },
    { name: '§6 落点表把 test/mirror-parity.mjs 归 U09（M，人造锚点）', expect: 'attributed', code: 'owned-drift', input: { rel: 'test/mirror-parity.mjs', before: h(9000, '7'), after: h(9000, '7'), anchor: mirrorAnchor } },
    { name: '§6 落点表把 test/intake.mjs 归 U10（M，人造锚点）', expect: 'attributed', code: 'owned-drift', input: { rel: 'test/intake.mjs', before: h(11000, '5'), after: h(11000, '5'), anchor: h(10000, '3') } },
  ]
}

function runAnchorDemos() {
  return anchorDemos().map((d) => {
    const actual = judgeAnchor(d.input)
    return {
      name: d.name,
      expect: d.expect,
      expectCode: d.code,
      actual,
      matched: actual.status === d.expect && actual.code === d.code,
    }
  })
}

/** 剥掉注释（只用于源码扫描；不改变被执行的代码） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
}

const START_SNAPSHOT = snapshotRepo()
/** 运行期自锚的起点快照（A08 ①）：内容指纹，不是 mtime。 */
const START_HASHES = hashWatched()

/* ══════════════════════════════════════════════════════════════════════
 * 进程内写调用守卫（A08：「写集外零写入」的**可归因**证据）
 * ──────────────────────────────────────────────────────────────────────
 * 为什么不用「全仓清单前后相同」来判：同一个工作树上可能同时有别的卡在写
 * （本卡执行期间实测到并发 lane 改过 lib/text.js 等），全仓差**无法归因**到本卡。
 * 这里改成拦下本进程**每一次** fs 写调用并记绝对路径 —— 本卡自己的写足迹就完全可判。
 * 判据：本次运行的所有写目标都只能是 ① 本次证据根 ② E:\Temp 下本卡前缀的临时副本。
 * ══════════════════════════════════════════════════════════════════════ */
const WRITE_LOG = []
const WRITE_APIS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync',
  'renameSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'truncateSync',
]

function toAbs(target) {
  try {
    if (typeof target === 'string') return path.resolve(target)
    if (Buffer.isBuffer(target)) return path.resolve(target.toString('utf8'))
    if (target instanceof URL) return path.resolve(fileURLToPath(target))
    return null
  } catch {
    return null
  }
}

for (const name of WRITE_APIS) {
  const original = fs[name]
  if (typeof original !== 'function') continue
  fs[name] = function patchedWrite(...args) {
    // ⚠️ 复制类 API 的第 1 个参数是**源**（读），写目标是第 2 个；记错了会把只读源当成越界写。
    let targets
    if (name === 'copyFileSync' || name === 'cpSync') targets = [toAbs(args[1])]
    else if (name === 'renameSync') targets = [toAbs(args[0]), toAbs(args[1])]
    else targets = [toAbs(args[0])]
    for (const target of targets) WRITE_LOG.push({ api: name, target })
    return original.apply(this, args)
  }
}

function isUnder(abs, root) {
  if (!abs || !root) return false
  return abs === root || abs.startsWith(root + path.sep)
}

/** 本进程允许写的位置：本次证据根 + E:\Temp 下本卡前缀的临时副本 */
function writeTargetAllowed(abs) {
  if (isUnder(abs, EV_ROOT)) return true
  if (isUnder(abs, TEMP_PARENT)) {
    const first = path.relative(TEMP_PARENT, abs).split(path.sep)[0]
    if (first && first.startsWith(MUT_PREFIX)) return true
  }
  return false
}

/** 本卡自己这三个文件在运行期间不许被改动（并发写者/自己都不许；清单见上方 SELF_FILES） */
function hashSelfFiles() {
  const map = Object.create(null)
  for (const rel of SELF_FILES) {
    const abs = path.join(REPO, rel)
    if (!fs.existsSync(abs)) { map[rel] = null; continue }
    const buf = fs.readFileSync(abs)
    map[rel] = `${buf.length}:${sha256(buf)}`
  }
  return map
}
const START_SELF = hashSelfFiles()

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 键构造与解析往返一致（并与既有导出对拍）
 * ══════════════════════════════════════════════════════════════════════ */
const A01 = caseBody('A01', () => {
  const id = identityModule()

  // 签名承接：既有导出的参数个数必须原样（不是"同义新 API"）
  eq(id.pointKey.length, baselinePointKey.length, 'pointKey 的参数个数必须与既有导出一致')
  eq(id.lessonKey.length, baselineLessonKey.length, 'lessonKey 的参数个数必须与既有导出一致')

  // ① 知识点键：合法输入的返回字符串与既有实现**逐字节一致**，且往返可逆
  const circles = ['programming', 'math', 'alge']
  const points = ['spring-boot', 'vue', 'js-basics', 'js']
  let pointPairs = 0
  for (const circle of circles) {
    for (const point of points) {
      const key = id.pointKey(circle, point)
      eq(key, baselinePointKey(circle, point), `pointKey(${circle},${point}) 必须与 pack-model 现行实现逐字节一致`)
      eq(key, `${circle}/${point}`, `pointKey(${circle},${point}) 的规范形状`)
      const back = id.parsePointKey(key)
      assert(back.ok === true, `parsePointKey(${key}) 应当成功，实得 ${JSON.stringify(back)}`)
      deepEq(Object.keys(back.value).sort(), ['circle', 'point'], '解析值只许有 circle/point 两个字段')
      eq(back.value.circle, circle, `往返后 circle 必须原样（${key}）`)
      eq(back.value.point, point, `往返后 point 必须原样（${key}）`)
      // 再构造一次 = 原键（幂等）
      eq(id.pointKey(back.value.circle, back.value.point), key, `往返后再构造必须等于原键（${key}）`)
      pointPairs += 1
    }
  }
  fact('pointKey 合法输入对拍 + 往返', { pairs: pointPairs, circles, points })

  // ② 课次键：补零 0001 / 0009 / 0100 / 9999（卡面点名的四个边界形状）
  const numberCases = [[1, '0001'], [9, '0009'], [100, '0100'], [9999, '9999']]
  for (const [number, padded] of numberCases) {
    for (const [circle, point] of [['programming', 'spring-boot'], ['math', 'vue'], ['alge', 'vectors']]) {
      const key = id.lessonKey(circle, point, number)
      eq(key, baselineLessonKey(circle, point, number), `lessonKey(${circle},${point},${number}) 必须与既有实现逐字节一致`)
      eq(key, `${circle}/${point}/${padded}`, `课号 ${number} 必须补成 ${padded}`)
      assert(/\/\d{4}$/.test(key), `课次键末尾必须正好四位十进制（${key}）`)
      const back = id.parseLessonKey(key)
      assert(back.ok === true, `parseLessonKey(${key}) 应当成功，实得 ${JSON.stringify(back)}`)
      deepEq(Object.keys(back.value).sort(), ['circle', 'number', 'point'], '课次解析值只许有 circle/point/number')
      eq(back.value.circle, circle, `课次往返 circle（${key}）`)
      eq(back.value.point, point, `课次往返 point（${key}）`)
      eq(back.value.number, number, `课次往返 number 必须是数字（${key}）`)
      eq(id.lessonKey(back.value.circle, back.value.point, back.value.number), key, `课次往返后再构造必须等于原键（${key}）`)
    }
  }
  fact('lessonKey 补零与往返', { numbers: numberCases.map((x) => x[0]), padded: numberCases.map((x) => x[1]) })

  // ③ 解析值不可被调用方就地改写（冻结值；避免"解析一次、全局串味"）
  const frozen = id.parsePointKey('programming/vue')
  assert(Object.isFrozen(frozen.value), '解析出来的 value 必须是冻结的')
  const frozenLesson = id.parseLessonKey('programming/vue/0001')
  assert(Object.isFrozen(frozenLesson.value), '课次解析出来的 value 必须是冻结的')
})

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 不同圆圈同名知识点不冲突
 * ══════════════════════════════════════════════════════════════════════ */
const A02 = caseBody('A02', () => {
  const id = identityModule()

  const progKey = id.pointKey('programming', 'vue')
  const mathKey = id.pointKey('math', 'vue')
  eq(progKey, 'programming/vue', 'programming 圆圈的 vue 键')
  eq(mathKey, 'math/vue', 'math 圆圈的 vue 键')
  assert(progKey !== mathKey, '不同圆圈的同名知识点键必须不相等（不许只按 point 认身份）')
  eq(progKey.startsWith('programming/'), true, 'programming/vue 必须带自己的圆圈前缀')
  eq(mathKey.startsWith('math/'), true, 'math/vue 必须带自己的圆圈前缀')
  eq(progKey.slice(-'/vue'.length), '/vue', '同名部分只在末尾（圆圈不同才是身份差异所在）')

  const progBack = id.parsePointKey(progKey)
  const mathBack = id.parsePointKey(mathKey)
  eq(progBack.value.circle, 'programming', 'programming/vue 反解出的圆圈')
  eq(mathBack.value.circle, 'math', 'math/vue 反解出的圆圈')
  eq(progBack.value.point, 'vue', 'programming/vue 反解出的点')
  eq(mathBack.value.point, 'vue', 'math/vue 反解出的点')

  // 同一映射里共存、互不覆盖（这正是"同名不冲突"的运行态判据）
  const bag = new Map()
  bag.set(progKey, 'prog-record')
  bag.set(mathKey, 'math-record')
  eq(bag.size, 2, '同名知识点键必须能在同一映射里共存，不许互相覆盖')
  eq(bag.get('programming/vue'), 'prog-record', 'programming/vue 的记录不能被 math/vue 覆盖')
  eq(bag.get('math/vue'), 'math-record', 'math/vue 的记录不能被 programming/vue 覆盖')

  // 课次键同样隔离
  const progLesson = id.lessonKey('programming', 'vue', 1)
  const mathLesson = id.lessonKey('math', 'vue', 1)
  assert(progLesson !== mathLesson, '不同圆圈的同名知识点课次键必须不相等')
  eq(progLesson, 'programming/vue/0001', 'programming 的课次键')
  eq(mathLesson, 'math/vue/0001', 'math 的课次键')
  eq(id.parseLessonKey(progLesson).value.circle, 'programming', '课次反解 circle（programming）')
  eq(id.parseLessonKey(mathLesson).value.circle, 'math', '课次反解 circle（math）')
  eq(new Set([progKey, mathKey, progLesson, mathLesson]).size, 4, '四个身份必须互不相同')

  fact('跨圆圈同名隔离', { progKey, mathKey, progLesson, mathLesson })
})

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 运行态拒绝裸点、两段课键、显示名
 * ══════════════════════════════════════════════════════════════════════ */
const A03 = caseBody('A03', () => {
  const id = identityModule()

  // ① 裸知识点：不认（不许开裸身份字符串别名）
  const naked = ['vue', 'spring-boot', 'js-basics']
  for (const raw of naked) {
    expectParseFail(`parsePointKey(${JSON.stringify(raw)})`, id.parsePointKey(raw), 'segment-count')
    expectParseFail(`parseLessonKey(${JSON.stringify(raw)})`, id.parseLessonKey(raw), 'segment-count')
  }

  // ② 两段课键：circle/point 当课键 → 拒绝（它不是课次身份）
  for (const raw of ['programming/vue', 'math/vue', 'programming/spring-boot']) {
    expectParseFail(`parseLessonKey(${JSON.stringify(raw)})`, id.parseLessonKey(raw), 'segment-count')
  }
  // 反向：三段课键当知识点键 → 也拒绝
  for (const raw of ['programming/vue/0001', 'programming/spring-boot/0100']) {
    expectParseFail(`parsePointKey(${JSON.stringify(raw)})`, id.parsePointKey(raw), 'segment-count')
  }

  // ③ 显示名：不识别（显示文字与实体身份分开）
  //    段数不成立的单段显示名（两种解析器都必须拒），以及带圆圈的课次显示名（对课键而言段数也不对）。
  const displayNames = ['第1课', 'Vue 第1课', '第 1 课', '第1课：Vue', 'Lesson 1']
  for (const raw of displayNames) {
    expectParseFail(`parsePointKey(${JSON.stringify(raw)})`, id.parsePointKey(raw), 'segment-count')
    expectParseFail(`parseLessonKey(${JSON.stringify(raw)})`, id.parseLessonKey(raw), 'segment-count')
  }
  // 「Vue 第1课」这类带圆圈名的课次显示名：对课键是两段（不是 circle/point/NNNN）
  expectParseFail('parseLessonKey("programming/vue 第1课")', id.parseLessonKey('programming/vue 第1课'), 'segment-count')
  // 「第1课」被塞进课号段：段数对但课号不是四位十进制
  expectParseFail('parseLessonKey("programming/vue/第1课")', id.parseLessonKey('programming/vue/第1课'), 'lesson-not-digits')

  // ④ 拒绝结果的完整形状（机器可判读，不是一句话糊过去）
  const sample = id.parseLessonKey('vue')
  const f = expectParseFail('parseLessonKey("vue")', sample, 'segment-count')
  eq(f.value, 'vue', 'failure.value 必须原样带上被拒的输入')

  // ⑤ 空 / 只有空白：不认
  expectParseFail('parsePointKey("")', id.parsePointKey(''), 'empty')
  expectParseFail('parsePointKey("   ")', id.parsePointKey('   '), 'whitespace-only')
  expectParseFail('parseLessonKey("")', id.parseLessonKey(''), 'empty')
  expectParseFail('parseLessonKey("  ")', id.parseLessonKey('  '), 'whitespace-only')
  // 前后空白不是"可容忍装饰"
  expectParseFail('parsePointKey(" programming/vue")', id.parsePointKey(' programming/vue'), 'untrimmed')
  expectParseFail('parseLessonKey("programming/vue/0001 ")', id.parseLessonKey('programming/vue/0001 '), 'untrimmed')

  // ⑥ 非字符串输入也一律拒绝（不 toString 猜一个）
  for (const raw of [null, undefined, 42, true, ['programming', 'vue'], { circle: 'programming' }]) {
    expectParseFail(`parsePointKey(${JSON.stringify(raw)})`, id.parsePointKey(raw), 'not-string')
  }

  fact('运行态拒绝面', { naked, displayNames, rejected: '裸点/两段课键/三段点键/显示名/空/空白/非字符串' })
})

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 拒绝空组成部分与路径逃逸形状
 * ══════════════════════════════════════════════════════════════════════ */
const A04 = caseBody('A04', () => {
  const id = identityModule()

  // 构造期：组成部分逐个校验（不是"拼起来再说"）
  const constructCases = [
    ['pointKey 空 circle', () => id.pointKey('', 'vue'), 'empty', 'circle'],
    ['pointKey 空 point', () => id.pointKey('programming', ''), 'empty', 'point'],
    ['pointKey 只有空白的 circle', () => id.pointKey('   ', 'vue'), 'whitespace-only', 'circle'],
    ['pointKey 只有空白的 point', () => id.pointKey('programming', ' \t '), 'whitespace-only', 'point'],
    ['pointKey point 带后缀空白', () => id.pointKey('programming', 'vue '), 'untrimmed', 'point'],
    ['pointKey circle 带前缀空白', () => id.pointKey(' programming', 'vue'), 'untrimmed', 'circle'],
    ['pointKey circle 里塞整条点键', () => id.pointKey('programming/vue', 'x'), 'contains-separator', 'circle'],
    ['pointKey point 里塞分隔符', () => id.pointKey('programming', 'vue/js'), 'contains-separator', 'point'],
    ['pointKey point 是 ..', () => id.pointKey('programming', '..'), 'path-escape', 'point'],
    ['pointKey circle 是 ..', () => id.pointKey('..', 'vue'), 'path-escape', 'circle'],
    ['pointKey circle 是 .', () => id.pointKey('.', 'vue'), 'path-escape', 'circle'],
    ['pointKey point 含反斜杠', () => id.pointKey('programming', 'a\\b'), 'path-escape', 'point'],
    ['pointKey point 含 .. 段', () => id.pointKey('programming', 'vue/../../etc'), 'contains-separator', 'point'],
    ['pointKey circle 是盘符', () => id.pointKey('C:', 'vue'), 'drive-letter', 'circle'],
    ['pointKey circle 是盘符路径', () => id.pointKey('C:\\x', 'vue'), 'drive-letter', 'circle'],
    ['pointKey point 含控制字符', () => id.pointKey('programming', 'v\u0000ue'), 'control-char', 'point'],
    ['pointKey circle 不是字符串', () => id.pointKey(null, 'vue'), 'not-string', 'circle'],
    ['pointKey point 是数字', () => id.pointKey('programming', 42), 'not-string', 'point'],
    ['lessonKey 空 circle', () => id.lessonKey('', 'p', 1), 'empty', 'circle'],
    ['lessonKey point 含反斜杠', () => id.lessonKey('a', 'b\\c', 1), 'path-escape', 'point'],
    ['lessonKey circle 含分隔符', () => id.lessonKey('a/b', 'p', 1), 'contains-separator', 'circle'],
    ['lessonKey circle 是盘符', () => id.lessonKey('D:', 'p', 1), 'drive-letter', 'circle'],
  ]
  for (const [label, fn, reason, field] of constructCases) expectIdentityThrow(label, fn, reason, field)

  // 解析期：空段 / 逃逸形状 / 绝对路径味道
  const parseCases = [
    ['parsePointKey 空 circle 段', () => id.parsePointKey('/vue'), 'empty', 'circle'],
    ['parsePointKey 空 point 段', () => id.parsePointKey('programming/'), 'empty', 'point'],
    ['parsePointKey 多一个空段', () => id.parsePointKey('programming//vue'), 'segment-count'],
    ['parsePointKey point 是 ..', () => id.parsePointKey('programming/..'), 'path-escape', 'point'],
    ['parsePointKey circle 是盘符', () => id.parsePointKey('C:/vue'), 'drive-letter', 'circle'],
    ['parsePointKey 尾随空白', () => id.parsePointKey('programming/vue '), 'untrimmed'],
    ['parsePointKey 前缀空白', () => id.parsePointKey(' programming/vue'), 'untrimmed'],
    ['parseLessonKey 空 point 段', () => id.parseLessonKey('programming//0001'), 'empty', 'point'],
    ['parseLessonKey 空课号段', () => id.parseLessonKey('programming/vue/'), 'empty', 'number'],
    ['parseLessonKey circle 是 ..', () => id.parseLessonKey('../vue/0001'), 'path-escape', 'circle'],
    ['parseLessonKey 反斜杠', () => id.parseLessonKey('programming\\vue/0001'.replace('\\', '\\')), 'segment-count'],
    ['parseLessonKey circle 是盘符', () => id.parseLessonKey('C:/vue/0001'), 'drive-letter', 'circle'],
  ]
  for (const [label, fn, reason, field] of parseCases) expectParseFail(label, fn(), reason, field)

  // 合法值不能被"顺手收紧"误杀：真实合法形状必须仍然通过
  for (const okKey of ['programming/spring-boot', 'math/vue', 'alge/vectors']) {
    assert(id.parsePointKey(okKey).ok === true, `合法知识点键被误拒：${okKey}`)
  }
  for (const okLesson of ['programming/spring-boot/0001', 'math/vue/0009', 'alge/vectors/0100', 'alge/vectors/9999']) {
    assert(id.parseLessonKey(okLesson).ok === true, `合法课次键被误拒：${okLesson}`)
  }

  fact('组成部分与逃逸形状拒绝面', { construct: constructCases.length, parse: parseCases.length })
})

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 四位课号边界符合契约、超范围不截断
 * ══════════════════════════════════════════════════════════════════════ */
const A05 = caseBody('A05', () => {
  const id = identityModule()

  // ① 接受面：1–9999 的整数，四位补零
  const accept = [[1, '0001'], [9, '0009'], [10, '0010'], [100, '0100'], [999, '0999'], [1000, '1000'], [9999, '9999']]
  for (const [number, padded] of accept) {
    eq(id.lessonKey('programming', 'vue', number), `programming/vue/${padded}`, `课号 ${number} 的规范键`)
    const back = id.parseLessonKey(`programming/vue/${padded}`)
    assert(back.ok === true, `parseLessonKey(programming/vue/${padded}) 应当成功`)
    eq(back.value.number, number, `课号 ${padded} 反解出的数字`)
  }

  // ② 拒绝面：非整数 / 超范围 / 非数字类型 —— 逐个断言"拒绝"，而不是"给个近似值"
  const reject = [
    [0, 'lesson-out-of-range'],
    [-1, 'lesson-out-of-range'],
    [10000, 'lesson-out-of-range'],
    [10001, 'lesson-out-of-range'],
    [1.5, 'not-integer'],
    [0.5, 'not-integer'],
    [Number.NaN, 'not-integer'],
    [Number.POSITIVE_INFINITY, 'not-integer'],
    [Number.NEGATIVE_INFINITY, 'not-integer'],
    [-0, 'lesson-out-of-range'],
    ['0001', 'not-number'],
    ['1', 'not-number'],
    ['9999', 'not-number'],
    [null, 'not-number'],
    [undefined, 'not-number'],
    [true, 'not-number'],
  ]
  for (const [number, reason] of reject) {
    expectIdentityThrow(`lessonKey(programming,vue,${JSON.stringify(number)})`,
      () => id.lessonKey('programming', 'vue', number), reason, 'number')
  }

  // ③ 超范围**不截断、不取模、不换号**：既有实现的现状必须如实登记（不是修好它）
  //    ⚠️ 这是**跨卡事实**，不是本卡的交付主张：U09 一旦把旧导出委托到严格内核
  //    （§12 A + authorization.json 的 P1/C3 口径），「padStart 照拼」就不存在了。
  //    所以按**两种已登记状态**判，两种都逐条断言，没有第三种（判别式 = 函数同一性）：
  //      状态 OLD：旧导出仍是就地拼接 → 5 条照拼结果逐字对拍（原样保留）
  //      状态 CONVERGED：旧导出就是 identity.cjs 的函数 → 同一性 + 5 个非法课号逐个被拒、理由逐条对拍
  const oldExportIsStrictKernel = baselineLessonKey === id.lessonKey && baselinePointKey === id.pointKey
  if (oldExportIsStrictKernel) {
    // 「同一件事只有一份实现」：旧导出与严格内核必须是**同一个函数**（比逐字节相等更强）
    eq(baselineLessonKey, id.lessonKey, '旧导出已收敛时必须与严格内核是同一个函数（不许第三份实现）')
    eq(baselinePointKey, id.pointKey, '旧导出已收敛时必须与严格内核是同一个函数（不许第三份实现）')
    const convergedRejects = [
      [10000, 'lesson-out-of-range', '超范围不截断：10000 必须被拒'],
      [0, 'lesson-out-of-range', '0 必须被拒'],
      [-1, 'lesson-out-of-range', '负数必须被拒'],
      [1.5, 'not-integer', '小数必须被拒'],
      ['0001', 'not-number', '字符串课号必须被拒'],
    ]
    for (const [number, reason, why] of convergedRejects) {
      expectIdentityThrow(`收敛后的旧导出 lessonKey(programming,vue,${JSON.stringify(number)})`,
        () => baselineLessonKey('programming', 'vue', number), reason, 'number')
      // 同一输入在严格内核上必须同一种结局（两份导出不许各说各话）
      expectIdentityThrow(`严格内核 lessonKey(programming,vue,${JSON.stringify(number)})`,
        () => id.lessonKey('programming', 'vue', number), reason, 'number')
    }
    fact('既有 lessonKey 的现状：已收敛到严格内核（U09）', {
      state: 'converged',
      identity: 'baselineLessonKey === id.lessonKey（函数同一性）',
      rejected: convergedRejects.map(([n, r, why]) => `${JSON.stringify(n)} → ${r}（${why}）`),
      note: 'U02 交付时的「padStart 照拼」现状值已随 U09 的合法收敛消失；此处登记收敛后的真实状态，不冒充旧状态。',
    })
  } else {
    oldExportState = 'laissez-faire'
    eq(baselineLessonKey('programming', 'vue', 10000), 'programming/vue/10000',
      '既有实现 padStart 不校验范围：10000 照拼成五位（现状事实）')
    eq(baselineLessonKey('programming', 'vue', 0), 'programming/vue/0000',
      '既有实现对 0 不做范围校验（现状事实）')
    eq(baselineLessonKey('programming', 'vue', -1), 'programming/vue/00-1',
      '既有实现对负数不做范围校验（现状事实）')
    eq(baselineLessonKey('programming', 'vue', 1.5), 'programming/vue/01.5',
      '既有实现对小数不做整数校验（现状事实）')
    eq(baselineLessonKey('programming', 'vue', '0001'), 'programming/vue/0001',
      '既有实现把字符串课号也照拼（现状事实）')
    // 这一支的存在本身要记账：旧导出**尚未**收敛（暂存双实现），不许被读成"已收敛"
    fact('既有 padStart 无范围校验的差异（不是缺陷修复）', {
      state: 'laissez-faire',
      baseline: { 10000: 'programming/vue/10000', 0: 'programming/vue/0000', '-1': 'programming/vue/00-1', '1.5': 'programming/vue/01.5' },
      strict: '全部拒绝（lesson-out-of-range / not-integer / not-number）',
      note: '旧导出仍未收敛到严格内核（暂存双实现，收敛归 U09）。',
    })
  }

  // ④ 解析侧：只认四位；超范围/宽度不对一律拒绝
  for (const okText of ['programming/vue/0001', 'programming/vue/0009', 'programming/vue/0100', 'programming/vue/9999']) {
    assert(id.parseLessonKey(okText).ok === true, `应当接受四位课号段：${okText}`)
  }
  const parseReject = [
    ['programming/vue/0000', 'lesson-out-of-range'],
    ['programming/vue/10000', 'lesson-width'],
    ['programming/vue/001', 'lesson-width'],
    ['programming/vue/1', 'lesson-width'],
    ['programming/vue/00001', 'lesson-width'],
    ['programming/vue/1.5', 'lesson-not-digits'],
    ['programming/vue/-001', 'lesson-not-digits'],
    ['programming/vue/000a', 'lesson-not-digits'],
    ['programming/vue/0001 ', 'untrimmed'],
    ['programming/vue/+001', 'lesson-not-digits'],
  ]
  for (const [raw, reason] of parseReject) {
    expectParseFail(`parseLessonKey(${JSON.stringify(raw)})`, id.parseLessonKey(raw), reason)
  }

  // ⑤ 严格内核从不返回五位/符号形状：所有合法课号都落在 \d{4}
  for (let number = 1; number <= 9999; number += 997) {
    const key = id.lessonKey('programming', 'vue', number)
    assert(/^programming\/vue\/\d{4}$/.test(key), `合法课号 ${number} 必须产出四位（实得 ${key}）`)
    eq(key.length, 'programming/vue/'.length + 4, `合法课号 ${number} 的键长必须固定`)
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 模块无 IO、无时钟、无环境依赖
 * ══════════════════════════════════════════════════════════════════════ */
const A06 = caseBody('A06', () => {
  const id = identityModule()
  const src = fs.readFileSync(IDENTITY_ABS, 'utf8')

  // ① 静态：源码里不许出现 IO / 时钟 / 随机 / 环境 / 进程 / ESM 语法
  const forbidden = [
    [/\brequire\s*\(/, '模块加载 require(...)'],
    [/\bimport\b/, 'ESM 语法 import'],
    [/\bprocess\b/, 'process（环境/进程）'],
    [/\bDate\b/, 'Date（时钟）'],
    [/\bMath\s*\.\s*random\b/, 'Math.random（随机）'],
    [/\bglobalThis\b/, 'globalThis（全局逃逸口）'],
    [/\bsetTimeout\b/, 'setTimeout（时钟）'],
    [/\bsetInterval\b/, 'setInterval（时钟）'],
    [/\bfetch\s*\(/, 'fetch（网络）'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest（网络）'],
    [/\b__dirname\b/, '__dirname（路径/文件系统味道）'],
    [/\b__filename\b/, '__filename（路径/文件系统味道）'],
    [/\bfs\b/, 'fs（文件系统）'],
    [/\bos\b/, 'os（环境）'],
    [/\bnode:[a-z]/, '引用 node: 内置模块'],
  ]
  for (const [rx, why] of forbidden) {
    assert(!rx.test(src), `身份内核源码里出现了 ${why}（应保持纯函数：${rx}）`)
  }
  assert(/^'use strict'\r?\n/.test(src), "身份内核必须是 CJS 且首行 'use strict'")
  assert(/\bmodule\.exports\s*=/.test(src), '身份内核必须用 module.exports 导出（纯 CJS）')
  assert(!/^\s*export\s/m.test(src), '身份内核不许出现 ESM export 语法')

  // ② 行为：同一输入重复调用完全一致（不缓存、不随调用顺序变）
  const probe = (mod) => JSON.stringify([
    mod.pointKey('programming', 'vue'),
    mod.lessonKey('programming', 'vue', 1),
    mod.parsePointKey('math/spring-boot'),
    mod.parseLessonKey('alge/vectors/0100'),
  ])
  const first = probe(id)
  const second = probe(id)
  eq(second, first, '同进程两次调用必须完全一致')

  // ③ 篡改环境不影响结果（真改 process.env，跑完还原）
  const tamperKeys = ['WHALE_IDENTITY_KEY_STYLE', 'WHALE_UNIFY_IDENTITY', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL']
  const saved = Object.create(null)
  for (const k of tamperKeys) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined
  try {
    for (const k of tamperKeys) process.env[k] = `tampered-${k}-${first.length}`
    eq(probe(id), first, '篡改 process.env 后，同一输入必须仍是同一输出（模块不许看环境）')
  } finally {
    for (const k of tamperKeys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
  eq(probe(id), first, '还原环境后结果必须仍一致')

  // ④ 模块实例重建：没有模块级状态缓存（换一个实例，结果逐字节相同）
  const resolved = requireCjs.resolve(IDENTITY_ABS)
  delete requireCjs.cache[resolved]
  const rebuilt = requireCjs(IDENTITY_ABS)
  eq(probe(rebuilt), first, '重建模块实例后同一输入必须同一输出（模块级不许有状态缓存）')
  eq(rebuilt.pointKey('programming', 'vue'), id.pointKey('programming', 'vue'), '重建实例的键构造必须一致')

  fact('无 IO / 无时钟 / 无环境依赖', { forbiddenPatterns: forbidden.length, tamperKeys, instanceRebuild: true })
})

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 临时去掉圆圈组成部分后判据必须变红（E:\Temp 唯一目录；干净副本对照）
 * ══════════════════════════════════════════════════════════════════════ */
const COPY_FILES = [
  'package.json',
  'test/audit/U02.mjs',
  'test/audit/unify-runner.mjs',
]
const COPY_DIRS = ['lib', 'docs/unify']

function makeCopy(tag) {
  const dest = path.join(TEMP_PARENT, `${MUT_PREFIX}${tag}-${process.pid}-${Date.now().toString(36)}`)
  const g = guardTempPath(dest, { parent: TEMP_PARENT })
  if (!g.ok) throw new Error(`临时副本路径不合法（清理守卫拒了它自己）：${g.error}`)
  fs.mkdirSync(dest, { recursive: true })
  for (const rel of COPY_DIRS) {
    const from = path.join(REPO, rel)
    if (!fs.existsSync(from)) throw new Blocked(`缺待复制的材料目录：${rel}`)
    fs.cpSync(from, path.join(dest, rel), { recursive: true })
  }
  for (const rel of COPY_FILES) {
    const from = path.join(REPO, rel)
    if (!fs.existsSync(from)) throw new Blocked(`缺待复制的材料：${rel}`)
    const to = path.join(dest, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  return dest
}

function cleanupCopy(dir) {
  const r = safeRemoveTree(dir, { parent: TEMP_PARENT })
  if (!r.removed) throw new Error(`临时副本清理失败：${r.error}`)
  assert(!fs.existsSync(dir), `临时副本清理后仍然存在：${dir}`)
}

/** 在副本里重跑本入口（子进程；禁止再变异，防递归） */
function runSelfOnCopy(dir, { mutant }) {
  const env = { ...process.env, DSH_WHALE_U02_NO_MUTATION: '1' }
  if (mutant) env.DSH_WHALE_U02_EXPECT_MUTANT = '1'
  else delete env.DSH_WHALE_U02_EXPECT_MUTANT
  const r = spawnSync(process.execPath, [path.join(dir, 'test', 'audit', 'U02.mjs'), `--evidence-root=${dir}`], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env,
  })
  if (r.error) throw new Error(`子进程跑不起来：${r.error.message}`)
  const lines = String(r.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
  eq(lines.length, 1, `本入口 stdout 必须只有一行判词（实得 ${lines.length} 行：${lines.slice(0, 3).join(' / ')}）`)
  return { code: r.status, line: lines[0].trim(), stderr: String(r.stderr ?? '') }
}

const A07 = caseBody('A07', () => {
  // ① 判词识别守卫：伪造/错位的判词不能被当成 PASS（本卡自己的判词契约）
  const RX = /^(PASS|FAIL|BLOCKED) (U\d\d)(?: checks=(\d+) failed=(\d+) skipped=(\d+))?(?: .*)?$/
  const parseVerdict = (line) => {
    const m = RX.exec(String(line ?? '').trim())
    if (!m) return null
    const [, status, card, checks, failed, skipped] = m
    if (card !== CARD) return null
    if (status === 'PASS') {
      if (checks === undefined || Number(checks) !== FIXED_IDS.length) return null
      if (Number(failed) !== 0 || Number(skipped) !== 0) return null
    }
    return { status, card, checks: checks === undefined ? null : Number(checks) }
  }
  for (const forged of [
    'PASS U02 checks=7 failed=0 skipped=0',
    'PASS U02 checks=8 failed=0 skipped=1',
    'pass U02 checks=8 failed=0 skipped=0',
    'PASS U02 checks=8 failed=0',
    'PASS U01 checks=8 failed=0 skipped=0',
    'OK U02 checks=8 failed=0 skipped=0',
  ]) {
    assert(parseVerdict(forged) === null, `伪造/错位判词没被识别出来：${forged}`)
  }
  assert(parseVerdict(`PASS ${CARD} checks=8 failed=0 skipped=0`) !== null, '真判词必须解析得出来')

  if (IS_MUTATION_CHILD) {
    // 子进程侧的真实断言：证明"我这次跑的是干净副本还是变异副本"
    const src = fs.readFileSync(IDENTITY_ABS, 'utf8')
    const marked = src.includes(MUTATION_MARKER)
    if (EXPECT_MUTANT) {
      assert(marked, '变异子进程应当跑在变异后的源码上（源码里没有变异标记 ⇒ 父进程根本没改到它）')
    } else {
      assert(!marked, '干净对照子进程的源码不该带变异标记（否则对照就不干净）')
    }
    return
  }

  // ② 干净副本必须先 PASS（证明判据本身可用、副本运行环境与正式入口一致）
  const clean = makeCopy('clean')
  let cleanRun = null
  try {
    cleanRun = runSelfOnCopy(clean, { mutant: false })
    eq(cleanRun.code, 0, `干净副本应当 PASS（实得 exit ${cleanRun.code}：${cleanRun.line}）${cleanRun.stderr ? ` / stderr=${cleanRun.stderr.slice(0, 300)}` : ''}`)
    eq(cleanRun.line, `PASS ${CARD} checks=8 failed=0 skipped=0`, '干净副本的判词必须与正式入口逐字相同')
  } finally {
    cleanupCopy(clean)
  }

  // ③ 变异：点键构造里去掉圆圈组成部分 ⇒ 判据必须变红（A01/A02 必然先炸）
  const mutantDir = makeCopy('nockcircle')
  let mutantRun = null
  let mutationReport = null
  try {
    const target = path.join(mutantDir, IDENTITY_REL)
    const src = fs.readFileSync(target, 'utf8')
    // 精确定位 pointKey 的返回模板（两段拼接），把它改成只留第二段 —— 圆圈从点键里消失
    const fnMatch = /function pointKey\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(src)
    assert(fnMatch !== null, '找不到 pointKey 的函数体（源码结构变了，变异锚点失效）')
    const template = /return\s+`\$\{(\w+)\}\/\$\{(\w+)\}`/.exec(fnMatch[2])
    assert(template !== null, `pointKey 的返回不是「两段拼接」（源码结构变了）：${fnMatch[2].trim().slice(0, 120)}`)
    const anchor = template[0]
    const dropped = template[1]
    const kept = template[2]
    const replacement = 'return `${' + kept + '}` ' + MUTATION_MARKER
    const mutated = src.replace(anchor, () => replacement)
    assert(mutated !== src, '变异没有真正改变源码')
    fs.writeFileSync(target, mutated, 'utf8')
    mutationReport = {
      file: IDENTITY_REL,
      anchor,
      replacement,
      whatChanged: `pointKey 不再含 ${dropped}（第一段组成部分）—— 不同圆圈的同名知识点会塌成同一个键`,
      mutantBytes: fs.statSync(target).size,
      mutantSha256: sha256(fs.readFileSync(target)),
    }

    mutantRun = runSelfOnCopy(mutantDir, { mutant: true })
    assert(mutantRun.code !== 0, `变异副本居然没变红（exit ${mutantRun.code}：${mutantRun.line}）`)
    eq(mutantRun.code, 1, `变异副本必须以 exit 1 变红（实得 ${mutantRun.code}：${mutantRun.line}）`)
    assert(/^FAIL U02 /i.test(mutantRun.line) && /^FAIL U02 /.test(mutantRun.line),
      `变异副本的判词必须以 "FAIL U02 " 开头（实得 ${mutantRun.line}）`)
    assert(!/^PASS /.test(mutantRun.line), `变异副本不许 PASS（实得 ${mutantRun.line}）`)
    assert(/\bA0[12]\b/.test(mutantRun.line), `变异必须打在键构造/跨圆圈判据上（实得 ${mutantRun.line}）`)
  } finally {
    cleanupCopy(mutantDir)
  }

  // ④ 变异过程与两份判词进本次证据（不覆盖任何既有证据）
  fs.mkdirSync(EV_ROOT, { recursive: true })
  fs.writeFileSync(path.join(EV_ROOT, 'U02-mutation-report.json'), JSON.stringify({
    card: CARD,
    cleanCopyVerdict: cleanRun.line,
    cleanCopyExit: cleanRun.code,
    mutant: mutationReport,
    mutantVerdict: mutantRun.line,
    mutantExit: mutantRun.code,
    note: '变异只在 E:\\Temp 的本次唯一副本里做；跑完按绝对路径守卫清理（父目录 E:\\Temp + 名字前缀 U02-mut-）。',
  }, null, 2), 'utf8')

  fact('A07 变异', { cleanCopy: cleanRun.line, mutant: mutantRun.line, mutantExit: mutantRun.code })
})

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 文件越界与证据守卫
 *    ④ 依赖锚点：本卡运行期没写 + 已漂移则归属到 §6 落点表里的合法卡
 *       （readLockedSource / judgeAnchor / classifyWatched 在「依赖锚点」一节）
 * ══════════════════════════════════════════════════════════════════════ */
const A08 = caseBody('A08', () => {
  const id = identityModule()

  // ① 写集声明 = 卡面写集，且与只读边界不相交
  eq(WRITE_SET.length, 4, '本卡写集条目数必须与卡面一致（内核 / 入口 / 回执 / 证据目录）')
  for (const want of ['lib/unify/identity.cjs', 'test/audit/U02.mjs', 'docs/unify/receipts/U02.json', 'audit-evidence/U02/']) {
    assert(WRITE_SET.includes(want), `写集缺卡面条目：${want}`)
  }
  for (const rel of WRITE_SET) {
    const normalized = rel.replace(/\/$/, '')
    assert(!PROTECTED.includes(normalized), `写集与只读边界相交：${rel}`)
    assert(!normalized.startsWith('cards/'), `写集不许碰卡面文件：${rel}`)
    assert(!/^test\/(?!audit\/U02\.mjs$)/.test(normalized), `写集不许碰既有测试：${rel}`)
    assert(path.isAbsolute(normalized) === false, `写集必须是仓内相对路径：${rel}`)
  }

  // ② 证据根守卫矩阵（纯函数；越界一律拒绝，合法临时目录放行）
  const def = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  assert(def.ok === true, `默认证据根应当合法：${def.error || ''}`)
  eq(def.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), '默认证据根形状')
  const rejects = [
    ['--evidence-root=relative/dir', '相对路径'],
    [`--evidence-root=${path.join(REPO, 'lib')}`, '仓内别处（lib/）'],
    [`--evidence-root=${path.join(REPO, 'test')}`, '仓内别处（test/）'],
    ['--evidence-root=', '空路径'],
    [`--evidence-root=${path.join('E:\\workplace', 'study', 'U02-x')}`, '活包目录（禁止）'],
    [`--evidence-root=${path.join(TEMP_PARENT, 'u99-wrong-card')}`, '名字不带本卡前缀'],
  ]
  for (const [arg, why] of rejects) {
    const g = resolveEvidenceRoot([arg], CARD, { repoRoot: REPO })
    assert(g.ok === false, `证据根守卫放行了越界目标：${why}（${arg}）`)
    assert(typeof g.error === 'string' && g.error.length > 0, `越界拒绝必须带理由：${why}`)
  }
  const accept = resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, 'U02-check')}`], CARD, { repoRoot: REPO })
  assert(accept.ok === true, `合法的临时证据根被拒了（恒拒绝同样是坏守卫）：${accept.error || ''}`)
  eq(path.basename(accept.root), 'U02-check', '合法临时证据根应原样保留')

  // ③ 本次运行自己的证据根：绝对路径 + 落在允许位置
  assert(path.isAbsolute(EV_ROOT), `证据根必须是绝对路径：${EV_ROOT}`)
  const inRepo = EV_ROOT.startsWith(path.join(REPO, 'audit-evidence', CARD) + path.sep)
  const inTemp = EV_ROOT.startsWith(TEMP_PARENT + path.sep)
  assert(inRepo || inTemp, `本次证据根越界：${EV_ROOT}（来源 ${EV_SOURCE}）`)
  // 读取的材料根不随 --evidence-root 变：REPO 来自入口文件所在仓根，身份内核永远从 REPO 的 lib/unify 读
  eq(REPO, path.resolve(path.dirname(SELF), '..', '..'), 'REPO 必须来自入口文件所在仓根（不受 --evidence-root 影响）')
  eq(path.dirname(IDENTITY_ABS), path.join(REPO, 'lib', 'unify'), '身份内核的读取路径必须来自仓根，不受 --evidence-root 影响')
  assert(!IDENTITY_ABS.startsWith(path.join(REPO, 'audit-evidence') + path.sep), '身份内核不许从证据目录里读')
  assert(!IDENTITY_ABS.startsWith(path.join(EV_ROOT, 'audit-evidence') + path.sep), '身份内核不许从证据根下面的镜像读')

  // ④ 依赖锚点（口径：**本卡运行期没写** + 已漂移则归属到 §6 落点表里的合法卡）
  //    旧口径「必须等于 U01 接口锁的字节/sha256」实际断言的是「跨卡静止」：
  //    §12 A 路径上 U09 的写集就是 lib/pack-model.js，它一落地旧口径必红 —— 判据口径错，
  //    不是本卡交付物有问题（见 docs/unify/authorization.json 的 derivedConsequences.C3）。
  if (ANCHOR_LOAD_ERROR) throw new Blocked(ANCHOR_LOAD_ERROR)

  // ④a 锚点来源自证：两份 U01 产物（interfaces.md §1/§3 与 baseline.json）必须逐条对得上，
  //     否则"锚点"本身没有外部基准（自证不算证据）。
  eq(ANCHOR_ROWS.size, 29, '接口锁 §1（11 重点文件）+ §3（18 另读落点）的锚点行数')
  eq(ANCHOR_TABLE.size, ANCHOR_ROWS.size, 'baseline.json 的 sourceLock 条目数必须与接口锁行数相同')
  for (const [rel, row] of ANCHOR_ROWS) {
    const j = ANCHOR_TABLE.get(rel)
    assert(j !== undefined, `baseline.json 缺接口锁登记过的锚点：${rel}`)
    eq(j.bytes, row.bytes, `两份 U01 锚点产物的字节数对不上：${rel}`)
    eq(j.sha256, row.sha256, `两份 U01 锚点产物的 sha256 对不上：${rel}`)
  }
  const pmLock = readLockedSource('lib/pack-model.js')
  const pkgLock = readLockedSource('package.json')
  eq(ANCHOR_TABLE.get('lib/pack-model.js')?.sha256, pmLock.sha256, '锚点表与 readLockedSource 必须同源（pack-model.js）')
  eq(ANCHOR_TABLE.get('package.json')?.sha256, pkgLock.sha256, '锚点表与 readLockedSource 必须同源（package.json）')

  // ④b 落点表自证：§6 必须覆盖 U01–U20 二十张卡，卡面点名的归属必须落在说的那张卡上
  eq(LANDING_CARDS.size, 20, '§6 落点表必须覆盖 U01–U20 全部二十张卡')
  assert(OWNER_TABLE.size >= 40, `§6 落点表解析出来的落点太少（${OWNER_TABLE.size}）—— 解析没在真的跑`)
  const ownershipExpect = {
    'lib/pack-model.js': 'U09',
    'lib/pack.js': 'U09',
    'lib/pack-template/tools/lesson-map.js': 'U09',
    'lib/point-ref.js': 'U09', // §6 U09 行已登记（主持人裁决 C4 的最小写集扩张：只有 qualified/splitQualified
    // 两个内部调用改走严格内核，导出面与返回语义逐字不变）—— 收敛责任仍唯一在 U09，不是"有主可改"
    'lib/text.js': 'U04',
    'lib/plan.js': 'U04',
    'lib/fingerprint.js': 'U04',
    'lib/glossary.js': 'U11',
    'lib/glossary-io.js': 'U11',
    'lib/glossary-edit-io.js': 'U11',
    'lib/engine.js': 'U08',
    'lib/pack-template/tools/publish-policy.cjs': 'U08',
    'lib/render.js': 'U07',
    'lib/pack-template/tools/build-lessons.js': 'U07',
    'lib/pack-template/tools/ledger-transaction.cjs': 'U06',
    'tools/recover-ledgers.mjs': 'U06',
    'lib/unify/identity.cjs': CARD,
    'package.json': 'U19',
    'test/audit/unify-runner.mjs': 'U01',
    'test/mirror-parity.mjs': 'U09', // §6 U09 行已登记（仅 §12 A 授权面：课程身份那一处）；
    // 它不是"既有测试可以随便改"的口子 —— 非身份断言仍然不许动，真越界照样红
    'test/intake.mjs': 'U10', // §6 U10 行已登记（仅 §12 A 授权面：裸 point 夹具与 latest.vue 等身份预期）；
    // 同理不是"既有测试可以随便改"的口子 —— 非身份断言仍然不许动，真越界照样红
  }
  for (const [rel, want] of Object.entries(ownershipExpect)) {
    eq(OWNER_TABLE.get(rel) ?? null, want, `§6 落点表的归属与本卡口径不一致：${rel}`)
  }

  // ④b-2 A 面例外与本次口径修正的**外部依据**：必须逐字来自 docs/unify/authorization.json，
  //        不是本入口里的一个常量说了算（缺料就 BLOCKED，不静默降级成"默认允许"）。
  const authAbs = path.join(REPO, 'docs', 'unify', 'authorization.json')
  if (!fs.existsSync(authAbs)) {
    throw new Blocked('缺 docs/unify/authorization.json：§12 A 面例外与依赖锚点口径修正没有外部依据')
  }
  const AUTHORIZATION = JSON.parse(fs.readFileSync(authAbs, 'utf8'))
  eq(AUTHORIZATION.quoteVerbatim, '选A和授权p1和p2', '授权原文必须逐字（A 面例外的唯一依据）')
  const aFaceText = JSON.stringify(AUTHORIZATION.scope?.A ?? {})
  for (const [rel, card] of AUTH_FACE) {
    assert(aFaceText.includes(rel), `A 授权面必须逐字点名 ${rel}（本卡的例外不许凭空放宽）`)
    assert(aFaceText.includes(card), `A 授权面必须逐字点名 ${card}（${rel} 的迁移责任卡）`)
  }
  const c3 = (AUTHORIZATION.derivedConsequences?.items ?? []).find((x) => x && x.id === 'C3')
  assert(c3 !== undefined, 'authorization.json 必须登记 C3（依赖锚点判据口径）')
  assert(String(c3.what ?? '').includes('依赖锚点判据'), 'C3 必须就是「依赖锚点判据」这一条（口径修正的依据）')

  // ④c 真跑判定：判定面里每个文件都判一次，**一个红都不许有**
  const END_HASHES = hashWatched()
  const CLASSIFIED = classifyWatched(START_HASHES, END_HASHES, WRITE_LOG.map((w) => w.target))
  eq(CLASSIFIED.length, WATCHED_FILES.length, '判定必须覆盖整个判定面（漏一个就是放水）')
  assert(WATCHED_FILES.length >= 35, `判定面太小（${WATCHED_FILES.length}）—— 漏判 `)
  for (const rel of SELF_ANCHOR_FILES) assert(WATCHED_FILES.includes(rel), `判定面漏了卡面点名要自锚的文件：${rel}`)
  for (const rel of SELF_FILES) assert(WATCHED_FILES.includes(rel), `判定面漏了本卡自己的可写文件：${rel}`)
  const REDS = CLASSIFIED.filter((x) => x.status === 'red')
  eq(REDS.length, 0, `依赖锚点判红：${REDS.slice(0, 3).map((r) => `${r.rel}[${r.code}]`).join(' , ')}`)
  const ATTRIBUTED = CLASSIFIED.filter((x) => x.status === 'attributed')
  for (const rec of ATTRIBUTED) {
    assert(OWNER_TABLE.get(rec.rel) === rec.owner || AUTH_FACE.get(rec.rel) === rec.owner,
      `放行必须带得出 §6 的主人（不许"无主也放行"）：${rec.rel}`)
  }
  // 非空转：锚点比对确实在跑（不是整张表都 un-anchored），且至少有一条 ok
  assert(CLASSIFIED.some((x) => x.code === 'anchored-intact'), '没有任何文件与 U01 锚点逐字节一致 —— 锚点比对没在真的跑')
  assert(CLASSIFIED.some((x) => x.status === 'ok'), '一条 ok 都没有 —— 判定没有真的在跑')
  // 旧口径点名的两个文件：要么与锚点一致，要么放行且写得出主人
  for (const rel of ['lib/pack-model.js', 'package.json']) {
    const rec = CLASSIFIED.find((x) => x.rel === rel)
    assert(rec !== undefined, `判定面必须包含 ${rel}`)
    assert(rec.status === 'ok' || rec.status === 'attributed',
      `${rel} 的判定必须是 ok/attributed（实得 ${rec.status}/${rec.code}：${rec.reason}）`)
    if (rec.status === 'attributed') eq(rec.owner, OWNER_TABLE.get(rel), `${rel} 放行时必须写明 §6 的主人`)
  }

  // ④d 反空转自证：人造输入 **4 红 + 4 绿**逐条命中（红的三条正是本次口径要防的三类真越界）
  const DEMOS = runAnchorDemos()
  const demoReds = DEMOS.filter((d) => d.expect === 'red')
  const demoGreens = DEMOS.filter((d) => d.expect === 'attributed')
  assert(demoReds.length >= 3, `反空转的红样本必须有 ≥3 条（实得 ${demoReds.length}）`)
  assert(demoGreens.length >= 2, `反空转的绿样本必须有 ≥2 条（实得 ${demoGreens.length}）`)
  for (const d of DEMOS) {
    assert(d.matched, `人造输入的判定与预期不符（判据被改松/改错）：${d.name} → 实得 ${d.actual.status}/${d.actual.code}，预期 ${d.expect}/${d.expectCode}`)
  }
  eq(new Set(demoReds.map((d) => d.actual.code)).size, demoReds.length,
    '每条红样本必须是**不同**的拒绝理由（一条钝刀不算判据）')
  eq(JSON.stringify(runAnchorDemos()), JSON.stringify(DEMOS), '同一输入必须同一判定（判据不许带状态）')
  for (const [rel, code] of [
    ['lib/whatever.js', 'created-outside-writeset'],
    ['lib/pack-model.js', 'run-window-write'],
    ['test/_pack.mjs', 'existing-test-modified'],
  ]) {
    const d = demoReds.find((x) => x.actual.rel === rel)
    assert(d !== undefined, `反空转的红样本缺失：${rel}`)
    eq(d.actual.code, code, `反空转样本的拒绝理由：${rel}`)
  }
  for (const rel of ['lib/pack-model.js', 'lib/pack-template/tools/lesson-map.js']) {
    const d = demoGreens.find((x) => x.actual.rel === rel)
    assert(d !== undefined, `U09 合法改 ${rel} 必须被判为放行（口径不能变成"全红"）`)
    eq(d.actual.status, 'attributed', `U09 合法改 ${rel} 的状态`)
    eq(d.actual.owner, 'U09', `U09 合法改 ${rel} 的归属`)
  }

  // ④e 归属记录进本次证据：**放行不是"没看见"**，每一处放行都带主人与前后指纹
  fs.mkdirSync(EV_ROOT, { recursive: true })
  fs.writeFileSync(path.join(EV_ROOT, 'anchor-classification.json'), JSON.stringify({
    card: CARD,
    criterion: '依赖锚点：本卡运行期未写（内容锁 + 进程内写调用守卫）＋ 若在运行期之外已与 U01 锚点不同，则按 docs/unify/interfaces.md §6 落点表归属到合法卡；无归属漂移、既有测试改动仍然红。',
    anchorSources: {
      markdown: 'docs/unify/interfaces.md §1（11 重点文件）+ §3（18 另读落点）',
      json: 'docs/unify/baseline.json sourceLock.files',
      rows: ANCHOR_ROWS.size,
      entries: ANCHOR_TABLE.size,
    },
    ownership: { source: 'docs/unify/interfaces.md §6（运行时解析，不在入口里抄死）', cards: LANDING_CARDS.size, entries: OWNER_TABLE.size },
    authFace: Object.fromEntries(AUTH_FACE),
    watched: WATCHED_FILES.length,
    classified: CLASSIFIED,
    attributed: ATTRIBUTED.map((r) => ({ rel: r.rel, owner: r.owner, code: r.code, anchor: r.anchor, now: r.after })),
    demos: DEMOS.map((d) => ({ name: d.name, expect: `${d.expect}/${d.expectCode}`, actual: `${d.actual.status}/${d.actual.code}`, owner: d.actual.owner, matched: d.matched })),
    note: '旧口径「等于 U01 锁的 sha256」已废：它断言的是跨卡静止（authorization.json C3）。',
  }, null, 2), 'utf8')

  fact('A08 依赖锚点（口径修正后）', {
    criterion: 'run-window-not-written + ownership-attribution',
    watched: WATCHED_FILES.length,
    anchorRows: ANCHOR_ROWS.size,
    ownership: `${LANDING_CARDS.size} 张卡 / ${OWNER_TABLE.size} 个落点（运行时解析 §6）`,
    attributed: ATTRIBUTED.map((r) => `${r.rel} -> ${r.owner} [${r.code}]`),
    demos: `${demoReds.length} 红 / ${demoGreens.length} 绿 全部命中`,
    oldCriterionReplaced: 'pack-model.js / package.json 不再要求"等于接口锁 sha256"，改为运行期自锚 + 归属；真越界仍红',
  })

  // ⑤ 本次运行没有写集外写入（**进程内写调用守卫**：每个写目标的绝对路径都必须在允许位置）
  //    ① 先证明守卫真的挂上了：往本次证据根写一个探针，它必须出现在日志里
  fs.mkdirSync(EV_ROOT, { recursive: true })
  const probePath = path.join(EV_ROOT, 'U02-write-probe.txt')
  fs.writeFileSync(probePath, 'write-guard probe\n', 'utf8')
  fs.rmSync(probePath, { force: true })
  assert(WRITE_LOG.some((w) => w.target === path.resolve(probePath)),
    '写调用守卫没挂上：探针写入没有被记录（恒空的日志不能当"零越界"）')
  //    ② 真正的判据：本次运行记录到的所有写目标，都必须落在允许位置
  const writeTargets = WRITE_LOG.map((w) => w.target).filter(Boolean)
  const outsideWrite = writeTargets.filter((abs) => !writeTargetAllowed(abs))
  eq(outsideWrite.length, 0,
    `本次运行写了写集外/未经允许的位置：${outsideWrite.slice(0, 3).join(' , ')}`)
  assert(writeTargets.length >= 2, `写调用记录太少（${writeTargets.length}）—— 守卫没在真的工作`)
  //    ③ 观测登记（不是判据）：本卡运行窗口内整个工作树出现的变化，含并发写者
  const afterSnapshot = snapshotRepo()
  const obs = diffSnapshots(START_SNAPSHOT, afterSnapshot)
  if (!obs.same) {
    fact('运行窗口内的全仓观测差异（可能是并发写者；不是本卡判据）', {
      onlyBefore: obs.onlyBefore.slice(0, 10),
      onlyAfter: obs.onlyAfter.slice(0, 10),
    })
  }
  assert(afterSnapshot.length >= 50, `仓内清单条目太少（${afterSnapshot.length}）—— 观测没有真的在跑`)

  // ⑤b 本卡自己这三个文件在运行期间不许被改（自己或并发写者都不许）
  const nowSelf = hashSelfFiles()
  for (const rel of SELF_FILES) {
    eq(nowSelf[rel], START_SELF[rel], `本卡自己的文件在本次运行期间被改了：${rel}`)
  }

  // ⑥ tracked 回执存在、是完整 JSON、五项齐全、声明的写集与代码一致
  const receiptPath = path.join(REPO, 'docs', 'unify', 'receipts', 'U02.json')
  if (!fs.existsSync(receiptPath)) throw new Blocked('缺 tracked 回执：docs/unify/receipts/U02.json')
  let receipt = null
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  } catch (e) {
    throw new Error(`tracked 回执不是完整 JSON：${e.message}`)
  }
  eq(receipt.card, CARD, '回执的 card 字段')
  for (const key of ['completion', 'interfaceConsumption', 'writeSet', 'outOfScope', 'staging', 'verdict',
    'verification', 'deltas', 'evidenceIndex', 'unverified', 'authorization', 'handoff', 'commands']) {
    assert(Object.prototype.hasOwnProperty.call(receipt, key), `回执缺必填段：${key}`)
  }
  const declared = (Array.isArray(receipt.writeSet) ? receipt.writeSet : []).map((x) => String(x.path ?? x).replace(/\/$/, ''))
  const actual = WRITE_SET.map((x) => x.replace(/\/$/, ''))
  eq(declared.slice().sort().join('|'), actual.slice().sort().join('|'), '回执声明的写集必须与入口里的写集逐条相同')
  eq(String(receipt.verification?.entry ?? ''), `node test/audit/${CARD}.mjs`, '回执必须登记本卡入口')
  assert(receipt.staging && receipt.staging.dualImplementation === true, '回执必须登记「暂存双实现」')
  assert(String(receipt.staging.owner ?? '').includes('U09'), '回执必须写明旧导出委托收敛的唯一责任卡（U09）')
  assert(receipt.authorization?.status === 'unresolved', '回执不许代写 §12 的 A/B 授权')

  // ⑦ 临时目录按绝对路径清理：E:\Temp 下本卡的临时副本残留为零（本次证据根自己不算残留）
  const stray = fs.readdirSync(TEMP_PARENT)
    .filter((n) => n.startsWith(MUT_PREFIX))
    .map((n) => path.join(TEMP_PARENT, n))
    .filter((abs) => path.resolve(abs) !== path.resolve(EV_ROOT))
  eq(stray.length, 0, `E:\\Temp 下还有本卡没清干净的临时副本：${stray.slice(0, 3).join(',')}`)

  // ⑧ 入口用的是异步壳（真 await），不是同步用例壳；也没有把计划当运行报告
  const selfSrc = fs.readFileSync(SELF, 'utf8')
  const specifiers = [...selfSrc.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert(specifiers.length >= 2, `入口的 import 说明符太少（${specifiers.length}）—— 扫描没在跑`)
  assert(specifiers.includes('./unify-runner.mjs'), `入口必须从 test/audit/unify-runner.mjs 取执行壳（实得 ${specifiers.join(',')}）`)
  assert(!specifiers.some((s) => s.includes('harness')), '入口的 import 不许指向同步壳')
  assert(/\brunCard\s*\(\s*CARD\s*,/.test(selfSrc), '入口必须用 runCard(CARD, FIXED_IDS, cases) 跑八项')
  assert(/await\s+runCard\s*\(/.test(selfSrc), 'runCard 必须被 await（不 await 就会把未完成结果记成通过）')
  // 扫描前先剥注释（注释里写"不要用某个壳"本身不该被当成那个壳）
  const codeOnly = stripComments(selfSrc)
  assert(!/\bcase\s*\(/.test(codeOnly), '入口不许自带同步用例壳的影子实现')

  fact('A08 越界/证据守卫', {
    evidenceRoot: EV_ROOT,
    evidenceSource: EV_SOURCE,
    writeSet: WRITE_SET,
    protectedFiles: PROTECTED.length,
    snapshotEntries: afterSnapshot.length,
    guardRejects: rejects.length,
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 跑卡 + 落证据 + 打印一行判词
 * ══════════════════════════════════════════════════════════════════════ */
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

function writeDetail(verdict, dir) {
  const buf = fs.readFileSync(IDENTITY_ABS)
  const record = {
    card: CARD,
    line: verdict.line,
    status: verdict.status,
    code: verdict.code,
    evidenceRoot: dir,
    evidenceSource: EV_SOURCE,
    argv: ARGV,
    identity: { file: IDENTITY_REL, bytes: buf.length, sha256: sha256(buf) },
    assertionsPerCase: COUNTS,
    totalAssertions: Object.values(COUNTS).reduce((a, b) => a + b, 0),
    cases: verdict.cases.map((c) => ({ id: c.id, status: c.actual, note: c.note, ms: c.ms })),
    facts: FACTS,
    snapshotEntries: START_SNAPSHOT.length,
    watchedFingerprints: START_HASHES,
    anchorCriterion: {
      criterion: 'run-window-not-written + ownership-attribution',
      watched: WATCHED_FILES.length,
      anchorRows: ANCHOR_ROWS.size,
      landingCards: LANDING_CARDS.size,
      landingEntries: OWNER_TABLE.size,
    },
    note: '本文件是本次运行的明细（用例级断言条数 + 事实），不进仓；判词只有 stdout 那一行。',
  }
  fs.writeFileSync(path.join(dir, 'U02-detail.json'), JSON.stringify(record, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'identity-source.sha256.txt'),
    `${sha256(buf)}  ${buf.length} bytes  ${IDENTITY_REL}\n`, 'utf8')
}

/* ══════════════════════════════════════════════════════════════════════
 * 调试开关（**不产出判词、不落证据**，只打印锚点判定结果）
 *   node test/audit/U02.mjs --print-anchor-demos
 * 判定与 A08 共用 judgeAnchor / classifyWatched，避免"打印一套、断言另一套"。
 * ══════════════════════════════════════════════════════════════════════ */
function printAnchorReport() {
  if (ANCHOR_LOAD_ERROR) {
    process.stdout.write(`ANCHOR-DEMOS BLOCKED ${ANCHOR_LOAD_ERROR}\n`)
    return 2
  }
  const live = classifyWatched(START_HASHES, hashWatched(), [])
  const short = (s) => (s === null ? 'null' : `${s.slice(0, 16)}…`)
  const lines = []
  lines.push(`=== LIVE 判定面 ${live.length} 个文件（U01 锚点 ${ANCHOR_ROWS.size} 行 / §6 落点 ${OWNER_TABLE.size} 条 / ${LANDING_CARDS.size} 张卡）===`)
  for (const r of live) {
    lines.push(`[LIVE] ${r.status.padEnd(10)} ${r.rel.padEnd(46)} code=${r.code.padEnd(24)} owner=${r.owner ?? '-'}  anchor=${short(r.anchor)} now=${short(r.after)}`)
  }
  const demos = runAnchorDemos()
  const reds = demos.filter((d) => d.expect === 'red')
  const greens = demos.filter((d) => d.expect === 'attributed')
  lines.push('=== DEMOS 人造输入（反空转自证；expect=red 必须红，expect=green 必须放行并带主人）===')
  for (const d of demos) {
    const label = d.expect === 'red' ? 'red' : 'green'
    lines.push(`[DEMO] ${d.matched ? '✓' : '✗'} expect=${label.padEnd(5)} actual=${d.actual.status.padEnd(10)} code=${d.actual.code.padEnd(26)} owner=${d.actual.owner ?? '-'}  ${d.name}`)
  }
  const liveReds = live.filter((r) => r.status === 'red')
  const matched = demos.filter((d) => d.matched).length
  lines.push(`ANCHOR-DEMOS red=${reds.length} green=${greens.length} matched=${matched}/${demos.length} | live=${live.length} red=${liveReds.length} attributed=${live.filter((r) => r.status === 'attributed').length} absent=${live.filter((r) => r.code === 'absent').length}`)
  process.stdout.write(lines.join('\n') + '\n')
  const ok = matched === demos.length && reds.length >= 3 && greens.length >= 2 && liveReds.length === 0
  return ok ? 0 : 1
}

if (ARGV.includes('--print-anchor-demos')) process.exit(printAnchorReport())

const verdict = await runCard(CARD, FIXED_IDS, CASES, { argv: ARGV })

try {
  writeRunEvidence(verdict, EV_ROOT)
  writeDetail(verdict, EV_ROOT)
} catch (e) {
  // 证据落不下来 ⇒ 不能冒充"已交付"：BLOCKED + exit 2
  process.stdout.write(`BLOCKED ${CARD} 证据落盘失败：${e.message}\n`)
  process.exit(2)
}

process.exit(printVerdict(verdict))
