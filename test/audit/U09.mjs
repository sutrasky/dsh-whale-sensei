#!/usr/bin/env node
/**
 * test/audit/U09.mjs —— 卡 U09 的验收入口（A lane · 包读取和课程映射收敛）
 * ======================================================================
 * 判词（`test/audit/unify-runner.mjs` 的 `runCard`，**真的 await** 后才登记）：
 *   成功 `PASS U09 checks=8 failed=0 skipped=0`      → exit 0
 *   失败 `FAIL U09 checks=N failed=M skipped=0 :: …` → exit 1
 *   缺料 `BLOCKED U09 …`                             → exit 2
 *
 * ## 这个入口证什么（固定八项，缺/多/重复/空用例都不得 PASS）
 *
 *   A01 跨圈同名点、同课号互不覆盖（两条课各自有自己的 src/page，键里带圆圈）
 *   A02 进度只影响目标课程（规范条目点亮自己那门；历史形状逐条点名、不计入；点键不扩成多门）
 *   A03 未知和歧义引用明确拒绝（`unknown` / `ambiguous` + 候选；**没有**被归一成某个键）
 *   A04 运行态拒绝历史形状；用**明确给出的规范夹具**验证新映射（**不伪称跑过 U05**）
 *   A05 源与产物关系及目录校验保持（与基线实现逐类对拍：缺源/缺产物/未声明/声明无页/坏 id）
 *   A06 宿主与独立包侧映射一致，只有一份解析实现（函数同一性 + 逐字节副本 + 无第二套算法
 *       + **每个身份命中点都归到 §6 里有主的卡**，见下「判据修正」）
 *   A07 临时恢复裸点索引后判据必须红（E:\Temp 变异副本；仓内核 sha256 不动）
 *   A08 §12 A 授权与同卡测试差异逐项对应（**A 面契约三条同时成立才绿**）、catalog 合法构造结果
 *       保持；证据与范围守卫有效
 *
 * ## 判据修正（U09-Δ · 归因口径，强度不降）
 *
 * A06 原判据是「命中点必须被**本文件里的常量表**归类」。U18 交付 `lib/unify/evidence.cjs` 并改了
 * `lib/state.js`（§6 里这两份都归 U18）之后，两处身份代码没有本地表条目就直接红 —— 红的是**表的
 * 陈旧**，不是缺陷。现改成**运行时归属**：每个命中点不仅要归类，还必须映射到
 * `docs/unify/interfaces.md` §6 里**真实拥有该文件**的那张 U 卡（卡号在运行时对 §6 核验，不硬编码
 * 路径→卡）。§6 无主的文件只许按「文件 + 痕迹」在回执里钉住
 * **上限**，同一个无主文件里冒出第三处即红；无主文件里连钉子都没有 → 红；归到一个 §6 并不拥有
 * 该文件的卡 → 红。（当时唯一这样的文件是 `lib/pack-export.js`，R3 待裁决；**决-3 之后它归 U16**，
 * 钉子随之清空 —— 见下面的「判据修正 四」。）
 *
 * A08 原自证是「`M test/intake.mjs` 不在本卡 A 面 ⇒ 必须 reject」。§6 给 U10 那一行补了
 * 「仅 §12 A 授权面」限定语之后，并集放行它是**正确**的，那条自证随之失效（它证明的是旧事实）。
 * 现改成**A 面契约**：`test/mirror-parity.mjs` 要算本卡的 §12 A 授权面，必须**同时**满足
 *   ① §6 里本卡单元格中点名它的那一段带限定语「仅 §12 A 授权面」；
 *   ② `authorization.json` 的 `scope.A` 里本卡自己的条目**逐字点名**它；
 *   ③ `authorization.json` 的 `quoteVerbatim`（人类授权原文）存在且非空。
 * 三条缺一即红；红样本换成 §6 里**确实无主**的既有测试（`test/pack-template-rules.mjs` /
 * `test/audit/T26.mjs`），条数不减，并要求契约对红样本能"说不"（可证伪）。两处 Δ 与强度对照
 * 逐条写在 `docs/unify/receipts/U09.json` 的 `deltas`。
 *
 * ## 判据修正 二（U09-Δ2 · 两处"表的陈旧"，强度不降）
 *
 * 两条红都不是 U09 交付物的缺陷：一条是**归类表**赶不上并发 lane 的合法改动，一条是**判据没有
 * 认 P2 这条已登记的授权面**。改法都朝着「可归因」而不是「放宽」：
 *
 * A06 **分类阶段**：先查显式表 `IDENTITY_SCAN_RULES`；**表里没有时**按 `interfaces.md` §6
 * **运行时**解析该路径有没有主 —— 恰好一个主 ⇒ `OWNED-OTHER-CARD`（记主人，并照旧过
 * `attributeIdentityHits` 的「§6 里那张卡确实拥有该文件」复核）；多个主 ⇒ 记不到唯一主人 ⇒ 红；
 * §6 无主 ⇒ 仍是 `UNCLASSIFIED` ⇒ 红。所以 U16 在自己的写集里改 `lib/mods/pack.js`（§6 的 U16 行
 * 拥有它）会被自动归属，而**任何**无主文件里新冒一处身份构造照样红（`deferredPins` 上限也照旧）。
 * 反空转多一条：往 §6 无主、且显式表也没有的既有文件里塞一处身份构造 → 必须红（证明"自动归属"
 * 没有变成"一律放行"）。
 *
 * A08 **A 面 diff 判据**：`test/mirror-parity.mjs` 现在有**两个**授权改动面 —— ① 本卡 §12 A 面
 * （第 149 行一带那一行旧身份预期）；② **P2 授权面**（446–456 行一带的 PROBE_VERSION 断言）。
 * `scope.P2` 从 `docs/unify/authorization.json` **现场解析**（`authorized` 里点名该文件的条目 +
 * 条目里写明的旧行窗口 + 顶层 `quoteVerbatim` 逐字），据此只把这些行从 `ok(` 逐字比对里**排除并
 * 单独登记**；排除面必须与 `scope.P2` 的文本对得上（hunk 的旧行区间落在声明窗口 ± 容差内、且
 * 内容确实是 PROBE_VERSION 断言），对不上就红。**其余 `ok(` 必须逐字不变这条整体保留**。
 * `test/audit/T26.mjs`（P2 的另一处授权对象）同理：不再是"逐字节未改"，而是"diff 恰好一行、
 * 落在声明窗口内、且 P2 明说不动的那两条 F01 断言仍在"。
 * 反空转：`scope.P2` 缺失（或 `quoteVerbatim` 缺失）⇒ 那些行**不再**被排除 ⇒ 必须红。
 *
 * ## 判据修正 三（决-7 · `splitQualified` 收敛，强度只升不降）
 *
 * U09 当时按主持人裁决条件 4 把 `lib/point-ref.js` 的 `splitQualified` **回退**成基线实现
 * （在第一个 `/` 处自拆），并在 A06 ⑥ 里断言「解析残留**恰好**是那一条已登记的 BLOCKED 边界」。
 * 用户按 `docs/unify/authorization.json` 的 `decisions.approvedChanged` 逐字「全按推荐」选了
 * **收敛（严格拒绝）**，于是这条边界被销账，判据随之改**严**：
 *   · A06 ⑥ 改成同一份纯函数 `judgePointRefResidue`：`lib/point-ref.js` 的**身份痕迹必须为 0**
 *     （构造与解析都只剩内核一份）、该文件的归类必须是 `OWNED-OTHER-CARD/U09`、全仓**不再有**
 *     `BLOCKED-BOUNDARY`；`BLOCKED-BOUNDARY` 同时从 `IDENTITY_KINDS` 里删除（边界不能再替代主人）；
 *   · 对拍矩阵带**声明的 Δ 表** `POINT_REF_STRICT`：只有表里点名的输入（9 个 × 3 halo）允许与基线不同，
 *     逐条按新正确行为断言（拒绝面只收紧），并且逐条证明基线在那一例上确实不同（Δ 不是空转）；
 *     其余输入**必须逐字相同**，条数减一即红（Δ 多冒一例也红）；
 *   · A06 ⑧ 新增**变异⑤**：把基线（`indexOf('/')` 自拆）抄回副本 → 同一份判据必须红，还原后必须重新绿。
 *
 * ## 判据修正 四（决-3 · `lib/pack-export.js` 收编，强度只升不降）
 *
 * 用户按 `docs/unify/authorization.json` 的 `decisions.approvedChanged` 逐字「全按推荐」把
 * `lib/pack-export.js` **收编给 U16**（导出链路的身份构造/解析归那张卡）。本卡据此改三处口径，
 * 每一条都朝「更可归因」而不是「放宽」：
 *   · **分类**：显式表 `IDENTITY_SCAN_RULES` 里**删掉** `lib/pack-export.js`（它曾是唯一
 *     `DEFERRED-OTHER-CARD`）。它现在在 §6 的 U16 行里 ⇒ 归因只能来自 §6 的**运行时自动归属**
 *     （`OWNED-OTHER-CARD/U16`），并且 ⑦b 的"显式表里仍然没有它"断言必须成立 —— 不许靠往表里
 *     补一条来"修好"。
 *   · **钉子账**：`deferredPins` 从"至少一条"改成"**必须逐条等于**扫描里 §6 无主的命中点"。
 *     现在仓内没有无主命中点 ⇒ 正确状态是**零条钉子**；留着旧钉子（钉一个有主文件）即红。
 *   · **反空转**（⑧）：① 把副本 §6 的 U16 行里 `lib/pack-export.js` 令牌**删掉** ⇒ 同一批字节
 *     必须重新判 `UNCLASSIFIED` 并红（证明"有主"来自 §6 那一行，不是本文件的表）；
 *     ② 钉子的**上限**仍必须咬人：拿一个 §6 真无主的既有文件（`lib/pack-server.js`）在副本里塞
 *     3 处同形拼接、按"无主文件"记账 —— 上限 2 ⇒ 必须按「上限」红，上限放到 3 ⇒ 必须变绿；
 *     ③ 授权面自证里 `M lib/pack-export.js` 必须**放行且归属 U16**，而把 §6 那一行撤掉之后
 *     同一个改动必须重新越界。
 *   · 判据里原来那条"仓内 `lib/pack-export.js` 必须与基线逐字节相同"**不再是事实**（收编后 U16
 *     会改它），换成更准确的三条：不在本卡写集 / 本进程没写它 / 它的改动可归属到 §6 的 U16；
 *     "在卡外被改"仍由 A08 ⑥ 的授权并集判据兜住（§6 里没有它时，tracked 改动照样越界红）。
 *
 * ## 真实 Δ 怎么量（不靠推断）
 *
 * A01/A02/A05/A08 都拿**基线实现**当 oracle：把当前 `lib/` 拷到 `E:\Temp\<本次唯一目录>`
 * 再用 `git show HEAD:` 把三个落点还原成基线版本 ⇒ 同一个夹具上同时跑老实现与新实现，
 * Δ 是**跑出来的**（写进证据 `detail.json` 的 `comparisons.*.oracle`）。
 *
 * ## 纪律
 *
 *   · 只写 `E:\Temp\<本次唯一目录>` 与 `audit-evidence/U09/…`；进程内 fs 写守卫 + 探针写自证；
 *   · **不读活包**、不跑任何读活包的套件（`test/*.mjs` 一律不跑；`test/catalog.mjs` 只读源码 +
 *     复算它那两条合法构造断言，不执行它——它 `import packRoot()`）；
 *   · 不跑 `test/all.mjs`、不跑 T 卡入口、不 git 写、不升版；
 *   · 已知中间态（R1：包侧 `tools/unify/*.cjs` 只由 U19 生成）用**自建最小替代**绕过，
 *     不铺模板、不碰仓内生成目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  FIXED_IDS,
  runCard,
  printVerdict,
  writeRunEvidence,
  resolveEvidenceRoot,
  guardTempPath,
  safeRemoveTree,
} from './unify-runner.mjs'

const CARD = 'U09'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const ARGV = process.argv.slice(2)
const REPO = path.resolve(HERE, '..', '..')
const require_ = createRequire(import.meta.url)

/** 读取材料的根**恒定**（不受 `--evidence-root` 影响） */
const EVIDENCE_ROOT_READ = path.join(REPO, 'audit-evidence', CARD)

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

/* ── 落点与写集（卡面 §2「写集（严格）」，逐条抄） ───────────────────────── */

const KERNEL = 'lib/unify/pack.cjs'
const HOST_MODEL = 'lib/pack-model.js'
const HOST_PACK = 'lib/pack.js'
const PACK_MAP = 'lib/pack-template/tools/lesson-map.js'
const POINT_REF = 'lib/point-ref.js'
const MIRROR = 'test/mirror-parity.mjs'
const RECEIPT = 'docs/unify/receipts/U09.json'

/**
 * 写集 = 卡面 §2 的 7 项 + 两项**主持人裁决 / A 面**：
 *   · `test/mirror-parity.mjs` —— §12 A 授权（本卡独占旧身份那一行与必要夹具输入）；
 *   · `lib/point-ref.js` —— 主持人裁决的**写集扩张**（卡面清单漏了它，而 U-SPEC §2 /
 *     interfaces.md §2 明文把"point-ref 的内联构造/拆分收敛"指派给 U09；只改两处内部调用，
 *     导出面与语义逐字保持）。回执 `writeSetExpansion` 有登记与理由。
 */
const WRITE_SET = Object.freeze([
  KERNEL,
  HOST_MODEL,
  HOST_PACK,
  PACK_MAP,
  POINT_REF,
  MIRROR,
  'test/audit/U09.mjs',
  RECEIPT,
  'audit-evidence/U09/ 下本次新建文件',
])

/**
 * §6 里 U09 的落点（U01 维护；主持人已把 A 面镜像测试与 point-ref 的写集扩张补进来）。
 * 顺序即 §6 行里出现的顺序 —— 逐条对拍，接口锁与入口不许悄悄漂。
 */
const SECTION6_EXPECTED = Object.freeze([
  KERNEL, HOST_MODEL, HOST_PACK, PACK_MAP, POINT_REF, MIRROR, 'test/audit/U09.mjs', RECEIPT,
])

/** §6 里 U09 的两个"另有授权来源"的落点（§12 A / 主持人裁决 C4）—— 授权原文必须仍查得到 */
const AUTHORIZED_ELSEWHERE = Object.freeze([MIRROR, POINT_REF])

/** 本卡改过的既有文件（必须与 git HEAD 不同） */
const CHANGED_FILES = Object.freeze([HOST_MODEL, HOST_PACK, PACK_MAP, POINT_REF, MIRROR])

/** 本卡新建的文件（git HEAD 里不存在） */
const CREATED_FILES = Object.freeze([KERNEL, 'test/audit/U09.mjs', RECEIPT])

/** 唯一历史解码模块（运行态**不许** require 它） */
const MIGRATION = 'lib/unify/migration.cjs'

/**
 * 依赖锚点：U02/U03/U04 已交付模块**本进程没写过**，且归属各自的卡（§6 解析）。
 *
 * ⚠️ 口径（主持人 2026-10-20 裁决）：**不**把它们的 sha256 钉成"跨卡静止"——
 *    那是别的卡的合法写集（U02 自己也在改它那边的锚定口径）。这里只证三件事：
 *      ① 文件读得到且非空（证据里记 sha256/字节）；
 *      ② 本卡本次进程**一个字节都没写**它们（写守卫的写记录里没有这些路径）；
 *      ③ 它们的归属在 §6 里能查到是 U02/U03/U04（不是"谁都能改的公共草稿"）。
 */
const DEPENDENCY_OWNERS = Object.freeze({
  'lib/unify/identity.cjs': 'U02',
  'lib/unify/errors.cjs': 'U03',
  'lib/unify/ledger-read.cjs': 'U03',
  'lib/unify/text.cjs': 'U04',
  'lib/unify/plan.cjs': 'U04',
})

const DETAIL = { comparisons: {}, temp: RUN_TEMP }

/* ── 小工具 ───────────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const fmt = (v) => {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（实得 ${fmt(actual)} / 期望 ${fmt(expected)}）`)
}

function sameJson(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg}（实得 ${String(a).slice(0, 400)} / 期望 ${String(b).slice(0, 400)}）`)
}

function gitRead(args) {
  const r = spawnSync('git', args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.status}：${String(r.stderr).slice(0, 400)}`)
  return String(r.stdout ?? '')
}

/** 基线版本的文件字节（oracle 与 mirror-parity Δ 都用它；只读 git） */
function headBytes(relPath) {
  const r = spawnSync('git', ['show', `HEAD:${relPath}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git show HEAD:${relPath} → ${r.status}：${String(r.stderr).slice(0, 400)}`)
  return r.stdout
}

/** 这个路径在基线提交里有没有（`git cat-file -e`；只读） */
function headExists(relPath) {
  const r = spawnSync('git', ['cat-file', '-e', `HEAD:${relPath}`], { cwd: REPO })
  return r.status === 0
}

/**
 * tracked 回执（A06 的归属钉子 + A08 的写集登记都从它读；缺/坏 JSON ⇒ 直接失败）。
 * 读盘 + `require` 一次，不缓存：A08 要验"回执本身合法"，缓存会掩盖本次运行期间的破坏。
 */
function requireReceipt() {
  const p = path.join(REPO, RECEIPT)
  assert(fs.existsSync(p), `缺 tracked 回执 ${RECEIPT}`)
  try {
    return require_(p)
  } catch (e) {
    throw new Error(`回执不是合法 JSON（require 失败）：${e.message}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的**可归因**判据（与 U04/U11 同一套纪律；本文件独立实现）
 * ──────────────────────────────────────────────────────────────────────
 * 「一个工作树、多 lane 并发」下，拿"改前整树 ↔ 现在的树"对拍会**结构性假红**：
 * 兄弟 lane 落它们自己的合法写集（U01 的 baseline.json、U05 的 migration.cjs、
 * U06 的 ledger-transaction.cjs…）会被算到本卡头上。所以判据换成四条可归因口径：
 *   ① 进程内 fs 写守卫 —— 本进程每一次写都要落在
 *      { 本卡写集 ∪ 本卡证据根 ∪ E:\Temp 下本卡本次临时根 }，并用**探针写**自证；
 *   ② 授权写集并集 —— §6（interfaces.md）+ **A 面**（authorization.json 的 scope.A）：
 *      tracked 改动必须 ⊆ 这个并集；
 *   ③ 本卡交付物内容锁 —— 写集文件的 sha256 在运行结束时必须仍等于记录值；
 *   ④ **不统计他卡的文件数/字节数**、不锚定别的卡证据。
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
  return {
    files: new Set(WRITE_SET.filter((p) => !p.endsWith('/')).map((p) => path.resolve(REPO, p))),
    roots,
    repoRoot: REPO,
  }
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

/* ── 授权写集并集（§6 + A 面） ───────────────────────────────────────────── */

const SECTION6_TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const looksLikeRepoPath = (s) => SECTION6_TOKEN_RX.test(s) && (s.includes('/') || /\.[A-Za-z]{2,4}$/.test(s))

/** §6 里「A 面」的限定语（逐字；U09 的 `test/mirror-parity.mjs` 与 U10 的 `test/intake.mjs` 都带） */
export const FACE_QUALIFIER = '仅 §12 A 授权面'

/**
 * §6 行 → `Map<卡号, {card, cell, segments, paths}>`（**纯函数**；`parseSection6` 的超集）。
 *
 * 为什么要 `cell` / `segments`：A 面契约要看「限定语是不是挂**这一条**落点上」，
 * 只看单元格里"有没有出现过这几个字"会把「仅 §12 A 授权面」误算到同格的其它落点上。
 */
export function parseSection6Blocks(text) {
  const out = new Map()
  let inSection = false
  for (const line of String(text).split('\n')) {
    if (/^##\s*6\./.test(line)) { inSection = true; continue }
    if (inSection && /^##\s/.test(line)) break
    if (!inSection) continue
    const m = /^\|\s*(U\d\d)\s*\|(.*)\|/.exec(line)
    if (!m) continue
    const cell = m[2]
    const toks = [...cell.matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter(looksLikeRepoPath)
    out.set(m[1], {
      card: m[1],
      cell,
      segments: cell.split(/<br\s*\/?>/i),
      paths: [...new Set(toks)],
    })
  }
  return out
}

/** 把 §6 落点表解析成 `Map<卡号, 路径[]>`（纯函数；不 import 兄弟卡的常量） */
export function parseSection6(text) {
  const out = new Map()
  for (const [card, block] of parseSection6Blocks(text)) out.set(card, block.paths)
  return out
}

/**
 * §6 单元格里「带 A 面限定语的那一段」所点名的测试路径 → `Map<卡号, 路径[]>`（纯函数）。
 * 只认**同一段**内既有限定语、又有该路径的情况（限定语挂错位置 ⇒ 不算 A 面）。
 */
export function section6FacePaths(blocks, qualifier = FACE_QUALIFIER) {
  const out = new Map()
  for (const [card, block] of blocks) {
    const paths = []
    for (const seg of block.segments) {
      if (!seg.includes(qualifier)) continue
      for (const m of seg.matchAll(/`([^`]+)`/g)) {
        const t = m[1]
        if (looksLikeRepoPath(t) && /^test\/.*\.mjs$/.test(t)) paths.push(t)
      }
    }
    out.set(card, [...new Set(paths)])
  }
  return out
}

export function authorizedUnion(sets) {
  const u = new Set()
  for (const paths of sets.values()) for (const p of paths) u.add(p)
  return u
}

/** §6 里「P1/P2 授权面」的限定语（逐字；U01 行给 `test/audit/T26.mjs` 挂的那一段） */
export const P2_FACE_QUALIFIER = '仅 P1/P2 授权面'

/**
 * §6 单元格里「带 P1/P2 限定语的那一段」所点名的测试路径 → `Map<卡号, 路径[]>`（纯函数）。
 * 与 `section6FacePaths` 同形：限定语必须挂在**同一段**，点在别的段落不算。
 */
export function section6P2Paths(blocks, qualifier = P2_FACE_QUALIFIER) {
  const out = new Map()
  for (const [card, block] of blocks) {
    const paths = []
    for (const seg of block.segments) {
      if (!seg.includes(qualifier)) continue
      for (const m of seg.matchAll(/`([^`]+)`/g)) {
        const t = m[1]
        if (looksLikeRepoPath(t) && /\.(?:mjs|js|cjs)$/.test(t)) paths.push(t)
      }
    }
    out.set(card, [...new Set(paths)])
  }
  return out
}

/**
 * **A 面**的授权路径：从 `docs/unify/authorization.json` 的 `scope.A.authorized` 里挑出
 * **以本卡号开头**的那些条目（纯函数，喂文档对象，不读盘）。
 *
 * 为什么必须"以本卡号开头"：`scope.A.authorized` 是 U09/U10/U14 **三张卡**的并集 ——
 * 例如「U10 独占 test/intake.mjs…」「U14 不修改 test/mirror-parity.mjs（唯一归 U09）…」。
 * 只要某条里出现 "U09" 就算数的话，U14 那条也会被算进来（它顺手点了 `test/audit/U14.mjs`），
 * A 面就被悄悄放大了。只认**本卡自己的条目**才是"不扩写授权"。
 *
 * @param {object} doc authorization.json 的内容
 * @param {string} [card] 卡号（缺省 U09）
 */
export function parseAuthorizationFace(doc, card = CARD) {
  const scopeA = doc && doc.scope && doc.scope.A ? doc.scope.A : null
  const found = [...new Set([...JSON.stringify(doc).matchAll(/test\/[A-Za-z0-9._/-]+\.mjs/g)].map((m) => m[0]))].sort()
  if (!scopeA) return { allowed: [], found, ok: false, why: 'authorization.json 里没有 scope.A' }
  const items = Array.isArray(scopeA.authorized) ? scopeA.authorized.map((x) => String(x)) : []
  const mine = items.filter((item) => new RegExp(`^\\s*${card}[\\s：:．.、,，-]`).test(item))
  const allowed = [...new Set([...mine.join('\n').matchAll(/test\/[A-Za-z0-9._/-]+\.mjs/g)].map((m) => m[0]))].sort()
  return {
    ok: allowed.includes(MIRROR) && allowed.length === 1,
    allowed,
    found,
    notAuthorized: found.filter((p) => !allowed.includes(p)),
    myItems: mine,
    quoteVerbatim: doc.quoteVerbatim,
    quoteSource: doc.quoteSource,
  }
}

/**
 * **三张卡**（U09/U10/U14）A 面的并集 → `Map<路径, 卡号[]>`。
 *
 * 为什么并集要含别人的 A 面：同一个工作树里并发 lane 会合法修改**它们自己的** A 面文件
 * （`test/intake.mjs` 归 U10）。tracked 改动必须 ⊆ 授权并集 —— 那个并集是"本轮被授权的
 * 全部路径"，不是"本卡能写的全部路径"。**本卡能写什么**由 `proveWriteScope` 单独钉。
 */
export function parseAllAFaces(doc) {
  const out = new Map()
  for (const card of ['U09', 'U10', 'U14']) {
    const face = parseAuthorizationFace(doc, card)
    for (const p of face.allowed) {
      const list = out.get(p) || []
      list.push(card)
      out.set(p, list)
    }
  }
  return out
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

/* ── P2 授权面（U09-Δ2）：authorization.json 的 scope.P2 是**第三类**授权面 ────────────
 *
 * 为什么本卡要认它：`test/mirror-parity.mjs` 现在有**两个**授权改动面 ——
 *   ① 本卡 §12 A 面（§6 的 U09 行 + scope.A 逐字点名，第 149 行一带那一行旧身份预期）；
 *   ② **P2 授权面**（scope.P2 第 1 条点名该文件 446–456 行一带的 PROBE_VERSION 断言），
 *      它属于"本轮授权的集成修正"，主人是主持人登记的 P1/P2 批次，不是本卡的 §12 A。
 * 判据仍然要求"其余 `ok(` 逐字不变"；P2 那几行只是被**排除并单独登记**，而且要能被 scope.P2
 * 的文本对上（声明窗口 + 语义都是 PROBE_VERSION 字面量断言）。对不上 ⇒ 红。
 * `scope.P2` 缺失或缺 `quoteVerbatim` ⇒ P2 面不成立 ⇒ 那些行不再被排除 ⇒ 必然红（可证伪）。
 */

/** P2 授权文本里写的行号是**旧树（HEAD）**行号；"一带" = 声明窗口 ± 这个容差 */
export const P2_LINE_TOLERANCE = 8

/**
 * 现场解析 `authorization.json` 的 `scope.P2`（**纯函数**，喂文档对象，不读盘）。
 *
 * @param {object} doc authorization.json 的内容
 * @param {string} [subject] 本卡负责的那个测试（缺省 `test/mirror-parity.mjs`）
 * @returns {{present:boolean, effective:boolean, ok:boolean, why:string,
 *            quoteVerbatim:string|null, quoteSource:string|null, subject:string,
 *            items:string[], mine:string[], entries:object[], window:{start:number,end:number}|null,
 *            paths:string[]}}
 *   `ok` = scope.P2 存在 ∧ quoteVerbatim 非空 ∧ `authorized` 里有点名 subject 的条目 ∧ 该条目写了旧行窗口。
 */
export function parseAuthorizationP2(doc, subject = MIRROR) {
  const p2 = doc && doc.scope && doc.scope.P2 ? doc.scope.P2 : null
  const quoteVerbatim = doc && typeof doc.quoteVerbatim === 'string' ? doc.quoteVerbatim : null
  const hasQuote = !!quoteVerbatim && quoteVerbatim.trim() !== ''
  const base = {
    present: !!p2, effective: false, ok: false, quoteVerbatim, quoteSource: doc ? (doc.quoteSource ?? null) : null,
    subject, items: [], mine: [], entries: [], window: null, paths: [],
  }
  if (!p2) {
    return { ...base, why: 'authorization.json 里没有 scope.P2 —— P2 授权面不成立，那些行不许从 `ok(` 逐字比对里排除' }
  }
  const items = Array.isArray(p2.authorized) ? p2.authorized.map((x) => String(x)) : []
  const mine = items.filter((it) => it.includes(subject))
  const entries = []
  for (const it of items) {
    const m = /(?:test|lib|tools)\/[A-Za-z0-9._/-]+\.(?:mjs|js|cjs)/.exec(it)
    if (!m) continue
    const range = /第\s*(\d+)\s*[–\-—~至]\s*(\d+)\s*行/.exec(it)
    const single = /第\s*(\d+)\s*行/.exec(it)
    const start = range ? Number(range[1]) : (single ? Number(single[1]) : null)
    const end = range ? Number(range[2]) : (single ? Number(single[1]) : null)
    entries.push({ path: m[0], start, end, text: it })
  }
  const myEntry = entries.find((e) => e.path === subject) ?? null
  const window = myEntry && Number.isFinite(myEntry.start) && Number.isFinite(myEntry.end)
    ? { start: myEntry.start, end: myEntry.end }
    : null
  const ok = hasQuote && mine.length > 0 && !!window
  const why = ok
    ? `scope.P2 第 ${items.indexOf(myEntry.text) + 1} 条逐字点名 ${subject} 的 ${window.start}–${window.end} 行一带；quoteVerbatim=「${quoteVerbatim}」`
    : (!hasQuote
      ? 'authorization.json 缺非空 quoteVerbatim —— P2 没有人类授权原文可引，授权面不成立'
      : (mine.length === 0 ? `scope.P2.authorized 里没有任何条目点名 ${subject}` : `${subject} 在 scope.P2 里没有可判读的旧行窗口`))
  return {
    ...base, effective: ok, ok, why, items, mine, entries, window,
    paths: [...new Set(entries.map((e) => e.path))].sort(),
  }
}

/** 多集差：`a` 里有而 `b` 里没有的（逐项次数相减）。纯函数。 */
export function multisetMissing(a, b) {
  const count = (list) => {
    const m = new Map()
    for (const x of list) m.set(x, (m.get(x) || 0) + 1)
    return m
  }
  const mb = count(b)
  const out = []
  for (const [x, n] of count(a)) {
    const k = mb.get(x) || 0
    for (let i = 0; i < n - k; i += 1) out.push(x)
  }
  return out
}

/**
 * **A08 ② 的判据函数**（纯函数）：`test/mirror-parity.mjs` 的 `ok(` 断言差异必须**恰好**落在
 * 两个授权面上 —— ① 本卡 §12 A 面那一行旧身份预期；② scope.P2 点名的 PROBE_VERSION 断言。
 * 其余 `ok(` 断言必须逐字不变（删/放宽/跳过任何一条都红）。
 *
 * @param {{hunks:object[], oldOk:string[], newOk:string[], p2:object, tolerance?:number}} args
 * @returns {{ok:boolean, why:string, u09:object[], p2Face:object[], unmapped:object[],
 *            excluded:{removed:string[],added:string[]}, missing:string[], extra:string[]}}
 */
export function judgeMirrorOkDelta({ hunks, oldOk, newOk, p2, tolerance = P2_LINE_TOLERANCE }) {
  const isOk = (l) => /\bok\(/.test(l)
  const norm = (l) => String(l).trim() // diff 里的行带原缩进，文件里的 `ok(` 行按 `okLineKey` 去过空白
  const oldAll = oldOk.map(norm)
  const newAll = newOk.map(norm)
  const blob = (h) => [...h.removed, ...h.added].join('\n')
  const win = p2 && p2.ok ? p2.window : null
  const inWindow = (h) => {
    if (!win) return false
    const s = h.oldStart - tolerance
    const e = h.oldStart + Math.max(h.oldLines, 1) - 1 + tolerance
    return win.start <= e && win.end >= s
  }
  const u09 = []
  const p2Face = []
  const unmapped = []
  for (const h of hunks) {
    const rk = h.removed.filter(isOk).map(norm)
    const ak = h.added.filter(isOk).map(norm)
    if (!rk.length && !ak.length) continue
    const b = blob(h)
    const looksP2 = /PROBE_VERSION/.test(b)
    const looksAnchor = /a\.anchor/.test(b) && /b\.anchor/.test(b)
    const where = `hunk 旧行 ${h.oldStart}–${h.oldStart + Math.max(h.oldLines, 1) - 1}`
    if (looksAnchor && !looksP2) u09.push({ removed: rk, added: ak, hunk: where })
    else if (looksP2 && win && inWindow(h)) p2Face.push({ removed: rk, added: ak, hunk: where, window: `${win.start}–${win.end}` })
    else {
      unmapped.push({
        removed: rk, added: ak, hunk: where,
        why: looksP2
          ? `PROBE_VERSION 断言不在 scope.P2 声明的旧行窗口里（${where}；窗口 ${win ? `${win.start}–${win.end} ±${tolerance}` : '不存在'}）`
          : '这条 `ok(` 变化不属于任何授权面（既不是 §12 A 的旧身份预期，也不是 P2 的 PROBE_VERSION 断言）',
      })
    }
  }
  const excluded = {
    removed: [...u09, ...p2Face].flatMap((x) => x.removed),
    added: [...u09, ...p2Face].flatMap((x) => x.added),
  }
  const oldRest = oldAll.filter(() => true)
  const newRest = newAll.filter(() => true)
  for (const l of excluded.removed) {
    const i = oldRest.indexOf(l)
    if (i >= 0) oldRest.splice(i, 1)
  }
  for (const l of excluded.added) {
    const i = newRest.indexOf(l)
    if (i >= 0) newRest.splice(i, 1)
  }
  const missing = multisetMissing(oldRest, newRest) // 旧有新没 ⇒ 被删/放宽/跳过
  const extra = multisetMissing(newRest, oldRest)   // 新有旧没 ⇒ 新增了未授权的断言
  const problems = []
  if (u09.length !== 1) problems.push(`§12 A 面（旧身份预期）必须**恰好一个** hunk 改 1 条 ok(（实得 ${u09.length} 个 hunk）`)
  else {
    if (u09[0].removed.length !== 1 || u09[0].added.length !== 1) {
      problems.push(`§12 A 面只许改 1 条 ok(（实得 删 ${u09[0].removed.length} / 增 ${u09[0].added.length}）`)
    }
  }
  if (p2Face.length === 0) problems.push('P2 授权面没有被排除任何一行（scope.P2 不成立，或 PROBE_VERSION 断言不在声明窗口内）')
  if (unmapped.length) problems.push(`有 ${unmapped.length} 条 ok( 变化不属于任何授权面：${fmt(unmapped.slice(0, 2).map((u) => u.hunk))}`)
  if (missing.length) problems.push(`有 ${missing.length} 条 ok( 断言被删/放宽/跳过：${fmt(missing.slice(0, 2))}`)
  if (extra.length) problems.push(`有 ${extra.length} 条未授权的 ok( 断言被新增：${fmt(extra.slice(0, 2))}`)
  return {
    ok: problems.length === 0, why: problems.join(' | ') || 'ok',
    u09, p2Face, unmapped, excluded, missing, extra,
    excludedCounts: { removed: excluded.removed.length, added: excluded.added.length },
    p2Counts: { removed: p2Face.reduce((n, x) => n + x.removed.length, 0), added: p2Face.reduce((n, x) => n + x.added.length, 0) },
    u09Counts: { removed: u09.reduce((n, x) => n + x.removed.length, 0), added: u09.reduce((n, x) => n + x.added.length, 0) },
    residue: { old: oldRest.length, new: newRest.length },
  }
}

/**
 * **P2 逐行补丁判据**（纯函数）：给一个"只有 P2 授权面"的既有测试（`test/audit/T26.mjs`）——
 * 不许再要求"逐字节未改"（P2 已合法改了它），但只许改**一行**、而且必须在 scope.P2 声明的旧行
 * 窗口内、内容确实是 PROBE_VERSION 断言、P2 明说"不动"的那些子断言仍原样在。
 *
 * @param {{diffText:string, window:object|null, mustKeep?:string[], mention?:RegExp, tolerance?:number, label?:string}} args
 */
export function judgeP2LinePatch({ diffText, window, mustKeep = [], mention = /PROBE_VERSION/, tolerance = 0, label = '' }) {
  const hunks = parseZeroContextDiff(diffText)
  const removed = hunks.flatMap((h) => h.removed)
  const added = hunks.flatMap((h) => h.added)
  const problems = []
  if (hunks.length !== 1) problems.push(`只许一个 hunk（实得 ${hunks.length}）`)
  if (removed.length !== 1 || added.length !== 1) problems.push(`只许改一行（实得 删 ${removed.length} / 增 ${added.length}）`)
  if (!window) problems.push('scope.P2 没给这个文件的旧行窗口 —— 无从判定"改的是不是授权面"')
  else if (hunks.length === 1) {
    const h = hunks[0]
    const s = h.oldStart - tolerance
    const e = h.oldStart + Math.max(h.oldLines, 1) - 1 + tolerance
    if (!(window.start <= e && window.end >= s)) {
      problems.push(`改动不在 scope.P2 声明的行窗口里（旧行 ${h.oldStart}–${h.oldStart + Math.max(h.oldLines, 1) - 1}；窗口 ${window.start}–${window.end} ±${tolerance}）`)
    }
  }
  if (added.length === 1 && !mention.test(added[0])) problems.push('新增的那一行里没有 PROBE_VERSION —— 与 P2 的授权对象对不上')
  for (const k of mustKeep) {
    if (!added.join('\n').includes(k)) problems.push(`P2 明说"不动"的断言在新增行里不见了：${k}`)
  }
  return {
    label, ok: problems.length === 0, why: problems.join(' | ') || 'ok',
    hunks: hunks.length, removed: removed.length, added: added.length,
    window: window ? { ...window, tolerance } : null,
    mustKeepMissing: mustKeep.filter((k) => !added.join('\n').includes(k)),
  }
}

/**
 * **A 面契约**（新口径；替代原「`M test/intake.mjs` 不在本卡 A 面 ⇒ 必须 reject」那条自证）。
 *
 * 一个测试要算某张卡的 §12 A 授权面，必须**同时**满足三条 ——
 *   ① `section6-qualifier`：§6 里该卡的单元格中，**点名它的那一段**带限定语「仅 §12 A 授权面」；
 *   ② `scope-a-verbatim`：`authorization.json` 的 `scope.A` 里**该卡自己的条目**逐字点名它（含路径原文）；
 *   ③ `quote-verbatim`：`authorization.json` 的 `quoteVerbatim`（人类授权原文）存在且非空。
 *
 * 三条缺一 ⇒ 不算 A 面。把红样本（§6 无主、scope.A 也不点名的既有测试）喂进来，①②必然为假 ——
 * 这条自证因此**可证伪**，不是"永远绿"。
 *
 * 纯函数：只吃 `blocks`（`parseSection6Blocks` 的结果）与 `authDoc`（authorization.json 的内容），不读盘。
 *
 * @param {{subject:string, blocks:Map, authDoc:object, cards?:string[]}} args
 * @returns {{subject:string, rows:object[], byCard:Map<string,object>, ok:boolean}}
 *          `ok` = 被检查的**所有**卡都满足三条；A 面只有一个主人，所以判据只用 `byCard`。
 */
export function proveAFaceContract({ subject, blocks, authDoc, cards = ['U09', 'U10'] }) {
  const facePaths = section6FacePaths(blocks)
  const hasQuote = !!authDoc && typeof authDoc.quoteVerbatim === 'string' && authDoc.quoteVerbatim.trim() !== ''
  const rows = []
  const byCard = new Map()
  for (const card of cards) {
    const s6Face = facePaths.get(card) ?? []
    const face = parseAuthorizationFace(authDoc, card)
    const namedVerbatim = (face.myItems ?? []).some((item) => item.includes(subject))
    const checks = [
      {
        check: 'section6-qualifier',
        ok: s6Face.includes(subject),
        why: `§6 的 ${card} 行必须点名 ${subject} 且限定语「${FACE_QUALIFIER}」挂在**同一段**（实得该卡 A 面落点 ${fmt(s6Face)}）`,
      },
      {
        check: 'scope-a-verbatim',
        ok: namedVerbatim,
        why: `authorization.json 的 scope.A 里 ${card} 自己的条目必须逐字点名 ${subject}（实得条目 ${fmt(face.myItems ?? [])}）`,
      },
      {
        check: 'quote-verbatim',
        ok: hasQuote,
        why: `authorization.json 必须有非空的 quoteVerbatim（人类授权原文；实得 ${fmt(authDoc && authDoc.quoteVerbatim)}）`,
      },
    ]
    rows.push(...checks.map((c) => ({ subject, card, ...c })))
    byCard.set(card, { card, ok: checks.every((c) => c.ok), failing: checks.filter((c) => !c.ok).map((c) => c.check) })
  }
  return { subject, rows, byCard, ok: rows.every((r) => r.ok) }
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
    else outOfBounds.push({ code: e.code, path: e.path, why: '已跟踪文件被改/删/增/改名，而路径不在授权并集里（§6 ∪ A 面）' })
    if (e.from) {
      if (union.has(e.from)) allowed.push({ code: e.code, path: e.from, note: 'rename 来源' })
      else outOfBounds.push({ code: e.code, path: e.from, why: 'rename 的来源路径不在授权并集里（§6 ∪ A 面）' })
    }
  }
  return { allowed, outOfBounds }
}

/**
 * A08 红路径之一：喂人造 porcelain 行，双向钉死（野路径红 / 兄弟 lane 放行 / A 面边界）。
 *
 * ⚠️ 口径修正（U09-Δ）：`M test/intake.mjs` 现在必须**放行**，因为 §6 的 U10 行已合法登记它
 * （带「仅 §12 A 授权面」限定语）—— 它进的是"本轮授权并集"，不是本卡的写允许面。要求它
 * **放行且归属 U10**（`requireOwner`），比原来的"必须 reject"更精确。
 *
 * ⚠️ 二次修正（U09-Δ2）：`M test/audit/T26.mjs` 现在也必须**放行**（§6 的 U01 行登记了它，限定语
 * 「仅 P1/P2 授权面」挂在同一段）—— 它的**改动**另由 `judgeP2LinePatch` 按 scope.P2 的声明行窗口
 * 定向钉住，不是"逐字节未改"也不是"随便改"。红样本改为 §6 里**仍然无主**的既有测试
 * （`test/pack-template-rules.mjs` / `test/all.mjs`），并对"加上 P2 之后仍越界"再证一遍。
 *
 * @param {Map<string,string[]>} sets `parseSection6` 的结果
 * @param {{allowed:string[]}} aFace 本卡 A 面
 */
export function proveScopeBoundary(sets, aFace, p2Union = []) {
  const parsed = sets ?? parseSection6(readText(path.join(REPO, 'docs/unify/interfaces.md')))
  const union = new Set(authorizedUnion(parsed))
  for (const p of (aFace && aFace.allowed) || [MIRROR]) union.add(p)
  const owners = pathOwners(parsed)
  const rows = []
  const one = (line, expect, why, requireOwner = null, inUnion = union) => {
    const { tracked } = splitPorcelainTracked([line])
    const r = classifyTrackedWrites(tracked, inUnion)
    const got = r.outOfBounds.length === 0 ? 'allow' : 'reject'
    const path0 = tracked[0] ? tracked[0].path : null
    const own = (owners.get(path0) ?? [])
    const ownerOk = requireOwner === null ? true : own.includes(requireOwner)
    rows.push({
      line, expect, got, ok: got === expect && ownerOk, why,
      section6Owners: own, requiredOwner: requireOwner,
      outOfBounds: r.outOfBounds.map((v) => v.path),
    })
  }
  one(' M lib/unify/pack.cjs', 'allow', '本卡（U09）写集')
  one(' M lib/pack-model.js', 'allow', '本卡（U09）写集')
  one(' M lib/pack.js', 'allow', '本卡（U09）写集')
  one(' M lib/pack-template/tools/lesson-map.js', 'allow', '本卡（U09）写集')
  one(' M test/mirror-parity.mjs', 'allow', '本卡 A 面（§12 A 授权，且仅此一行/夹具）', 'U09')
  one(' M lib/unify/identity.cjs', 'allow', 'U02 写集（并发/已交付）')
  one(' M lib/unify/migration.cjs', 'allow', 'U05 写集（并发/已交付）')
  one(' M docs/unify/baseline.json', 'allow', 'U01 的出口（并发）')
  one(' M test/intake.mjs', 'allow', 'U10 的 A 面：§6 已带「仅 §12 A 授权面」限定语 ⇒ 进本轮授权并集（但**不**进本卡写允许面）', 'U10')
  one(' M test/alien-env.mjs', 'reject', '§6 里**无主**、scope.A / scope.P2 也都不点名的既有测试（红样本：并集不许放行）')
  one(' M test/all.mjs', 'reject', '§6 里**无主**的既有总入口（红样本：并集不许放行）')
  one(' M test/audit/T26.mjs', 'allow', '§6 的 U01 行已登记它，且限定语「仅 P1/P2 授权面」挂在**同一段** ⇒ 进本轮授权并集；改动本身另由 P2 逐行判据钉（见 A08 ⑧）', 'U01')
  one(' M test/_pack.mjs', 'reject', '既有测试（任何卡都不许改）')
  one(' M lib/whatever.js', 'reject', '野路径（不在任何卡写集）')
  one(' D test/all.mjs', 'reject', '既有总入口被删')
  one('A  cards/U09.md', 'reject', '计划文件不是 §6 落点（且本系列不许 git add）')
  one(' M audit-evidence/U09/detail.json', 'reject', '证据目录不被 §6 授权（它是 gitignore 的原始证据）')
  {
    const mixed = classifyTrackedWrites(
      splitPorcelainTracked([' M lib/unify/pack.cjs', ' M test/mirror-parity.mjs', ' M scripts/x.mjs']).tracked, union)
    const got = mixed.outOfBounds.map((v) => v.path).join(',')
    rows.push({
      line: 'MIX[ M lib/unify/pack.cjs | M test/mirror-parity.mjs | M scripts/x.mjs]',
      expect: 'scripts/x.mjs', got,
      ok: got === 'scripts/x.mjs' && mixed.outOfBounds.length === 1, why: '混合输入只抓野路径',
    })
  }
  // U14 的 A 面（`test/audit/U14.mjs`）在 §6 里没有「仅 §12 A 授权面」限定语，但它确实是 U14 的
  // 落点 —— 这里只证「§6 有主 ⇒ 放行」，不把它算成本卡的 A 面。
  one(' M test/audit/U14.mjs', 'allow', 'U14 写集（§6 有主；U14 的 A 面落账在 authorization.json）', 'U14')
  // 决-3：`lib/pack-export.js` 收编给 U16 —— 它的 tracked 改动进授权并集（放行），但**不进**本卡
  // 写允许面（proveWriteScope 里它必须 reject）。反空转：把 §6 那一行里的落点撤掉后必须重新越界。
  one(' M lib/pack-export.js', 'allow', '§6 的 U16 行已收编它（决-3）⇒ tracked 改动进本轮授权并集；本卡写它仍是越界', 'U16')
  {
    const noToken = new Map([...parsed].map(([card, paths]) => [card, card === 'U16' ? (paths ?? []).filter((p) => p !== 'lib/pack-export.js') : paths]))
    one(' M lib/pack-export.js', 'reject', '撤掉 §6 的收编落点 ⇒ 同一个改动必须重新越界（放行来自 §6 那一行，不是白得）', null, authorizedUnion(noToken))
  }

  /* **P2 授权面**（U09-Δ2）：把 scope.P2 逐字点名的路径并进来之后 ——
   *   · T26 必须放行且归属 U01（§6 的 U01 行登记了它，限定语「仅 P1/P2 授权面」在**同一段**）；
   *   · P2 没点名的既有测试（`test/pack-template-rules.mjs`）**仍必须 reject**；
   *   · 野路径仍 reject。
   * 这三条合起来证明 P2 是"指名到行"的授权，不是"既有测试随便改"的通行证。 */
  if (p2Union.length) {
    const unionP2 = new Set(union)
    for (const p of p2Union) unionP2.add(p)
    one(' M test/audit/T26.mjs', 'allow', 'P2 授权面：§6 的 U01 行（限定语「仅 P1/P2 授权面」）+ scope.P2 逐字点名 ⇒ 进本轮授权并集', 'U01', unionP2)
    one(' M test/alien-env.mjs', 'reject', 'P2 没有点名它 ⇒ 加上 P2 之后仍越界（P2 不是改既有测试的通行证）', null, unionP2)
    one(' M test/all.mjs', 'reject', 'P2 没有点名它 ⇒ 加上 P2 之后仍越界', null, unionP2)
    one(' M lib/whatever.js', 'reject', '野路径：P2 之后仍越界', null, unionP2)
  }
  return { unionSize: union.size, p2UnionSize: p2Union.length, cards: parsed.size, rows, failures: rows.filter((r) => !r.ok) }
}

/** A08 红路径之二：写允许面的边界（兄弟 lane 的合法写入，对**本卡进程**仍判越界） */
export function proveWriteScope(scope) {
  const s = scope ?? writeAllowScope()
  const cases = [
    [KERNEL, 'allow', '本卡写集（权威内核）'],
    [HOST_MODEL, 'allow', '本卡写集（宿主适配层）'],
    [MIRROR, 'allow', '本卡写集（A 面镜像测试）'],
    [RECEIPT, 'allow', '本卡写集（tracked 回执）'],
    ['test/audit/U09.mjs', 'allow', '本卡写集（本入口）'],
    [path.join(s.roots[0], 'pack-a06', 'tools', 'unify', 'pack.cjs'), 'allow', 'E:\\Temp 本次临时根下的自建包'],
    ['docs/unify/baseline.json', 'reject', 'U01 的出口 —— 兄弟可以写，本卡写就是越界'],
    ['lib/pack-export.js', 'reject', '§6 归 U16（决-3 收编）—— 兄弟可以写，本卡写就是越界'],
    ['lib/unify/identity.cjs', 'reject', 'U02 写集 —— 同上'],
    ['lib/render.js', 'reject', 'U07 写集 —— 同上'],
    ['audit-evidence/U04/pre-change.json', 'reject', '兄弟卡的改前材料（本卡只读）'],
    ['lib/whatever.js', 'reject', '野路径'],
    ['test/intake.mjs', 'reject', 'U10 的 A 面（本卡不碰）'],
    [path.join(TEMP_PARENT, 'u09-not-this-run', 'x.txt'), 'reject', 'E:\\Temp 下别次/别人的目录（临时区不是自由区）'],
    ['C:\\Windows\\u09-x.txt', 'reject', '与仓无关的绝对路径'],
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
  for (const p of [...CHANGED_FILES, KERNEL, 'test/audit/U09.mjs']) {
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
 * 夹具（全部在 E:\Temp\<本次唯一目录> 下自建；**不读活包、不铺模板**）
 * ══════════════════════════════════════════════════════════════════════ */

function w(root, relPath, text) {
  const abs = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
  return abs
}

const wj = (root, relPath, obj) => w(root, relPath, JSON.stringify(obj, null, 2) + '\n')

/** 课次源页：带 `data-lesson-meta`（readPack 的唯一数据源） */
const lessonSrc = (halo, point, number, title) => [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title></head><body>',
  `<script type="application/json" data-lesson-meta>${JSON.stringify({ title, number, halo, point })}</script>`,
  '<!--@objective-->',
  `<p>夹具课程：${title}（手写声明，不来自活包）。</p>`,
  '<!--/@objective-->',
  '</body></html>',
  '',
].join('\n')

const lessonPage = (title) => `<!doctype html><html><body><h1>${title}</p></body></html>\n`

/** 规范夹具：分层布局 + 规范（三段）EXPECT 声明 + 规范进度 */
function fixtureCanonical(root) {
  wj(root, 'lessons/math/halo.json', { halo: 'math', name: '数学' })
  wj(root, 'lessons/math/alge/point.json', { point: 'alge', name: '代数', label: '代数', fileBase: 0 })
  w(root, 'lessons/math/alge/0001-alge.html', lessonPage('代数入门'))
  w(root, 'lessons/src/math/alge/0001-alge.html', lessonSrc('math', 'alge', 1, '代数入门'))

  wj(root, 'lessons/programming/halo.json', { halo: 'programming', name: '编程' })
  wj(root, 'lessons/programming/spring-boot/point.json', { point: 'spring-boot', name: 'Spring Boot', fileBase: 0 })
  w(root, 'lessons/programming/spring-boot/0001-boot.html', lessonPage('第一课：跑起来'))
  w(root, 'lessons/src/programming/spring-boot/0001-boot.html', lessonSrc('programming', 'spring-boot', 1, '第一课：跑起来'))
  w(root, 'lessons/programming/spring-boot/0002-rest.html', lessonPage('第二课：分层'))
  w(root, 'lessons/src/programming/spring-boot/0002-rest.html', lessonSrc('programming', 'spring-boot', 2, '第二课：分层'))

  wj(root, 'lessons/programming/vue/point.json', { point: 'vue', name: 'Vue', label: 'Vue', fileBase: 1000 })
  w(root, 'lessons/programming/vue/1001-vue.html', lessonPage('Vue 第一课'))
  w(root, 'lessons/src/programming/vue/1001-vue.html', lessonSrc('programming', 'vue', 1001, 'Vue 第一课'))

  // EXPECT 的 `lessons[].id` 是**声明**（基线里两段；U05 不迁移它、任何卡写集都没有它）
  wj(root, 'code/math/alge/EXPECT.json', { lessons: [{ id: 'alge/0001', title: '代数入门' }] })
  wj(root, 'code/programming/spring-boot/EXPECT.json', {
    lessons: [{ id: 'spring-boot/0001', title: '第一课：跑起来' }, { id: 'spring-boot/0002', title: '第二课：分层' }],
  })
  wj(root, 'code/programming/vue/EXPECT.json', { lessons: [{ id: 'vue/1001', title: 'Vue 第一课' }] })
  wj(root, 'progress.json', { v: 1, learned: ['programming/spring-boot/0001', 'math/alge/0001'] })
  return root
}

/** A01 夹具：跨圈**同名知识点** + **同课号**（`math/vue/0001` 与 `programming/vue/0001`） */
function fixtureCrossCircle(root) {
  wj(root, 'lessons/math/halo.json', { halo: 'math', name: '数学' })
  wj(root, 'lessons/math/vue/point.json', { point: 'vue', name: 'Vue（数学圈）', label: '数学Vue' })
  w(root, 'lessons/math/vue/0001-shared.html', lessonPage('数学圈的 vue 第1课'))
  w(root, 'lessons/src/math/vue/0001-shared.html', lessonSrc('math', 'vue', 1, '数学圈的 vue 第1课'))

  wj(root, 'lessons/programming/halo.json', { halo: 'programming', name: '编程' })
  wj(root, 'lessons/programming/vue/point.json', { point: 'vue', name: 'Vue（编程圈）', label: 'Vue' })
  w(root, 'lessons/programming/vue/0001-shared.html', lessonPage('编程圈的 vue 第1课'))
  w(root, 'lessons/src/programming/vue/0001-shared.html', lessonSrc('programming', 'vue', 1, '编程圈的 vue 第1课'))

  // 跨圈同名的声明必须带圆圈（不带就是歧义 —— A03 单独验）
  wj(root, 'code/programming/vue/EXPECT.json', { lessons: [{ id: 'programming/vue/0001', title: '编程圈的 vue' }] })
  wj(root, 'code/math/vue/EXPECT.json', { lessons: [{ id: 'math/vue/0001', title: '数学圈的 vue' }] })
  wj(root, 'progress.json', { v: 1, learned: ['math/vue/0001'] })
  return root
}

/** A02/A04 夹具：进度里混进历史形状（裸点 / 两段课键 / 显示名 / 裸课号 / 点键落课程位） */
function fixtureLegacyProgress(root) {
  fixtureCrossCircle(root)
  wj(root, 'progress.json', {
    v: 1,
    learned: [
      'math/vue/0001',           // 规范 → 只点亮这一门
      'vue/0001',                // 两段课键（跨圈歧义）→ 不计入
      'programming/vue',         // 点键落在课程位 → 不能扩成多门
      '第1课',                   // 显示名 → 不是身份
      '0001',                    // 裸课号 → 不是身份
      'programming/nope/0002',   // 规范但不存在 → 幽灵条目
    ],
  })
  return root
}

/** A05 夹具：源/产物关系 + 目录校验（缺源 / 缺产物 / 声明无页 / 未声明页 / 坏 id） */
function fixtureBrokenDirs(root) {
  wj(root, 'lessons/programming/halo.json', { halo: 'programming', name: '编程' })
  wj(root, 'lessons/programming/spring-boot/point.json', { point: 'spring-boot', name: 'Spring Boot' })
  // ① 只有产物页、缺课程源
  w(root, 'lessons/programming/spring-boot/0001-only-page.html', lessonPage('只有产物'))
  // ② 只有课程源、缺产物页
  w(root, 'lessons/src/programming/spring-boot/0002-only-src.html', lessonSrc('programming', 'spring-boot', 2, '只有源'))
  // ③ 有源有产物但 EXPECT 没声明
  w(root, 'lessons/programming/spring-boot/0003-undeclared.html', lessonPage('未声明'))
  w(root, 'lessons/src/programming/spring-boot/0003-undeclared.html', lessonSrc('programming', 'spring-boot', 3, '未声明'))
  wj(root, 'code/programming/spring-boot/EXPECT.json', {
    lessons: [
      { id: 'spring-boot/0001', title: '只有产物' },
      { id: 'spring-boot/0002', title: '只有源' },
      { id: 'spring-boot/0009', title: '声明了但没有页' },
      { id: 'badid', title: '形状不对' },
    ],
  })
  wj(root, 'progress.json', { v: 1, learned: [] })
  return root
}

/** A05 夹具：旧平铺布局（`lessons/NNNN-*.html` 与 `lessons/src/NNNN-*.html`） */
function fixtureFlat(root) {
  wj(root, 'lessons/programming/halo.json', { halo: 'programming', name: '编程' })
  wj(root, 'lessons/programming/spring-boot/point.json', { point: 'spring-boot', name: 'Spring Boot' })
  w(root, 'lessons/0001-flat.html', lessonPage('平铺产物'))
  w(root, 'lessons/src/0001-flat.html', lessonSrc('programming', 'spring-boot', 1, '平铺源'))
  wj(root, 'code/proj/EXPECT.json', { lessons: [{ id: 'spring-boot/0001', title: '平铺' }] })
  wj(root, 'progress.json', { v: 1, learned: [] })
  return root
}

/** A03 夹具：EXPECT.json 用**两段声明** `point/NNNN`，而该知识点在**两个圆圈**里都有课 */
function fixtureDeclAmbiguous(root) {
  fixtureCrossCircle(root)
  // 覆盖掉带圆圈的声明，换成两段声明（`declarationShape: 'point/NNNN'`）
  wj(root, 'code/programming/vue/EXPECT.json', { lessons: [{ id: 'vue/0001', title: '编程圈的 vue' }] })
  wj(root, 'code/math/vue/EXPECT.json', { lessons: [{ id: 'vue/0001', title: '数学圈的 vue' }] })
  return root
}

/* ── 判据函数（同一份判据给"真内核"和"变异内核"用；A07 就靠它变红） ─────── */

/**
 * 跨圈同号判据：两条课必须各自独立。
 * @returns {{problems: string[], keys: string[], entries: object[]}}
 */
export function judgeCrossCircle(core, root) {
  const problems = []
  const idx = core.lessonIndex(root)
  const keys = Object.keys(idx.byKey).sort()
  const want = ['math/vue/0001', 'programming/vue/0001']
  if (keys.join(',') !== want.join(',')) problems.push(`课次键应恰好是 ${want.join(' / ')}（实得 ${keys.join(' / ')}）`)
  if (idx.conflicts.length) problems.push(`不该有 conflict（实得：${idx.conflicts.join('；')}）`)
  const math = idx.byKey['math/vue/0001']
  const prog = idx.byKey['programming/vue/0001']
  if (!math || !prog) {
    problems.push('两门课没有各自独立地出现（跨圈同号被合并了）')
    return { problems, keys, entries: [] }
  }
  if (math.page === prog.page) problems.push(`跨圈同号指向了同一个产物页（${math.page}）—— 静默串页`)
  if (!String(math.page || '').includes('/math/')) problems.push(`math 那门的产物页不在 math 圈下（${math.page}）`)
  if (!String(prog.page || '').includes('/programming/')) problems.push(`programming 那门的产物页不在 programming 圈下（${prog.page}）`)
  if (!String(math.src || '').includes('lessons/src/math/vue/')) problems.push(`math 那门的课程源不对（${math.src}）`)
  if (!String(prog.src || '').includes('lessons/src/programming/vue/')) problems.push(`programming 那门的课程源不对（${prog.src}）`)
  if (math.label === prog.label) problems.push(`两条显示名撞车（都叫 ${math.label}）—— 显示层选不出唯一赢家`)
  // 进度只点亮目标课程（A01 的一半：跨圈同号互不覆盖）
  const pack = core.readPack ? core.readPack(root) : null
  if (pack) {
    const byId = Object.fromEntries(pack.lessons.map((l) => [l.id, l]))
    if (!byId['math/vue/0001'] || byId['math/vue/0001'].learned !== true) problems.push('进度里点的是 math/vue/0001，它却没被点亮')
    if (!byId['programming/vue/0001'] || byId['programming/vue/0001'].learned !== false) problems.push('跨圈同号的另一门被连带点亮了（进度串了）')
  }
  return { problems, keys, entries: [math, prog] }
}

/** 进度判据：只认规范身份；历史形状逐条点名、不计入；点键不扩成多门 */
export function judgeProgress(core, root) {
  const problems = []
  const idx = core.lessonIndex(root)
  const res = core.resolveLearned([
    'math/vue/0001',
    'vue/0001',
    'programming/vue',
    '第1课',
    '0001',
    'programming/nope/0002',
  ], idx)
  if (res.lit.join(',') !== 'math/vue/0001') problems.push(`已学集合应只有 math/vue/0001（实得 ${res.lit.join(' / ')}）`)
  if (res.problems.length !== 5) problems.push(`应当逐条点名 5 条历史/幽灵条目（实得 ${res.problems.length} 条）`)
  const joined = res.problems.join('\n')
  for (const [needle, why] of [
    ['归属歧义', '两段课键的跨圈歧义必须点名'],
    ['不是规范课次键', '历史形状必须点名"不是规范键"'],
    ['幽灵条目', '规范但不存在的条目必须按幽灵点名'],
  ]) {
    if (!joined.includes(needle)) problems.push(`问题清单里没有「${needle}」（${why}）`)
  }
  // 点键不能扩成多门已学课程：`programming/vue` 那一条不许把 programming/vue/0001 点亮
  if (res.lit.includes('programming/vue/0001')) problems.push('点键被扩展成了一门已学课程（§2 禁止）')
  return { problems, lit: res.lit, problemsCount: res.problems.length, detail: res.problems }
}

/** 目录校验判据（源/产物关系 + 声明对位）：按"冲突类别"计，不看具体键的前缀 */
export function judgeDirs(core, root) {
  const idx = core.lessonIndex(root)
  const count = (rx) => idx.conflicts.filter((c) => rx.test(c)).length
  return {
    keys: Object.keys(idx.byKey).sort(),
    conflicts: idx.conflicts.slice(),
    categories: {
      missingSrc: count(/缺课程源/),
      missingPage: count(/缺课程产物/),
      undeclared: count(/但 EXPECT.json 没声明它/),
      declaredNoPage: count(/都没有 \d{4} 的页面/),
      badIdShape: count(/id 形状不对/),
    },
  }
}

/* ── 身份实现的**全仓扫描**（A06/A08 的"只剩一份"证明） ──────────────────── */

/**
 * 三种"身份构造/解析"痕迹：
 *   ① `template-circle-point` —— `${x.circle}/${x.id|point}` 拼接；
 *   ② `indexof-slash` —— 自己 `indexOf('/')` 拆身份；
 *   ③ `padstart4` —— `padStart(4,'0')` 课号格式化。
 *
 * **两阶段归类**（跳过注释行；U09-Δ2）：
 *   ① **先查**下面这张显式表 `IDENTITY_SCAN_RULES`（少数点值得逐条写"为什么不是身份"，人工维护）；
 *   ② **表里没有时**按 `interfaces.md` §6 **运行时**解析该路径有没有主：
 *        · 恰好一个主 ⇒ `OWNED-OTHER-CARD`（记那个主人）—— 并发 lane 在自己的写集里新加一处身份
 *          构造是**合法**的，红的是"表没跟上"而不是缺陷（U16 的 `lib/mods/pack.js` 就是这样）；
 *        · 多个主     ⇒ `OWNED-OTHER-CARD` 但 `owner=null`（多主等于没主）⇒ 归属判定红，需主持人裁决；
 *        · §6 无主    ⇒ `UNCLASSIFIED` ⇒ 红（自动归属**不是**"一律放行"）。
 *
 * 每一条都必须带 `owner`（责任卡），且**卡号在运行时对 §6 核验** —— 表（或自动归属）说谁是
 * "我认为该归谁"，§6 才是"谁真的拥有这个文件"的权威（见 `attributeIdentityHits`）：
 *   · `KERNEL`             —— 严格内核本身（§6：U02 的 `lib/unify/identity.cjs` / U09 的 `pack.cjs`）；
 *   · `MIGRATION`          —— 唯一历史解码（U05）；
 *   · `NON-IDENTITY`       —— 同形但**不是**身份（提问/笔记序号、交付文件名、页面路径…），逐条给理由；
 *   · `OWNED-OTHER-CARD`   —— 真的是身份构造，落在**别的卡的写集**里（该卡在 §6 里拥有这个文件）；
 *   · `DEFERRED-OTHER-CARD`—— 真的是身份构造，而**该文件不在任何 U 卡写集**（§6 无主）⇒ 只能按
 *                             「文件 + 痕迹」在回执 `identityAttribution.deferredPins` 里钉住**上限**，
 *                             同一个无主文件里多冒一处即红。（决-3 之后仓内已没有这种文件：
 *                             `lib/pack-export.js` 收编给 U16，钉子清空 —— 钉子账见 A06 ⑦c。）
 *   · `UNCLASSIFIED`       —— 显式表没有、§6 也没有主 ⇒ 红（新出现的第四处实现）。
 *
 * ⚠️ **`BLOCKED-BOUNDARY` 已废止**（决-7）：它原本只服务 `lib/point-ref.js` 那一条"两段以上引用"
 *    的语义回退项。splitQualified 收敛到严格内核（`parseLessonKey` → `parsePointKey` → 显式拒绝）
 *    之后这条边界不存在了；种类本身也从 `IDENTITY_KINDS` 里删掉 —— 将来再有人想把某处身份实现
 *    "挂成边界"蒙过去，只会被判 `未归类` 而红（边界不能替代主人）。
 */
const IDENTITY_SCAN_RULES = Object.freeze({
  'lib/unify/identity.cjs': { kind: 'KERNEL', owner: 'U02', why: '严格内核本身（§6 归 U02）' },
  'lib/unify/pack.cjs': { kind: 'KERNEL', owner: 'U09', why: '课程映射内核（索引键与声明号格式化都在这里）' },
  'lib/unify/migration.cjs': { kind: 'MIGRATION', owner: 'U05', why: '唯一历史解码（U05）' },
  'lib/ask.js': { kind: 'NON-IDENTITY', owner: 'U14', why: '提问序号 seq 的零填充（questions 的 id，不是课号）' },
  'lib/notes-io.js': { kind: 'NON-IDENTITY', owner: 'U14', why: '笔记序号 seq 的零填充（notes/seq.txt，不是课号）' },
  'lib/pack-template/tools/ask-server.js': { kind: 'NON-IDENTITY', owner: 'U18', why: '提问序号 seq 的零填充（包侧镜像）' },
  'lib/author.js': { kind: 'NON-IDENTITY', owner: 'U13', why: '建课**文件名**里的四位课号（不是身份键；U13 写集）' },
  'lib/mods/catalog.js': { kind: 'OWNED-OTHER-CARD', owner: 'U16', why: 'catalog 对外 id 内联构造规范课次键 —— 归 U16（§6 拥有 lib/mods/catalog.js）' },
  'lib/mods/author.js': { kind: 'OWNED-OTHER-CARD', owner: 'U13', why: '`${p.circle}/${p.id}` 内联构造知识点键 —— 归 U13' },
  'lib/mods/goal.js': { kind: 'OWNED-OTHER-CARD', owner: 'U16', why: '`${hit.circle}/${hit.id}` 内联构造知识点键 —— 归 U16' },
  'lib/unify/evidence.cjs': { kind: 'OWNED-OTHER-CARD', owner: 'U18', why: '证据内核 `lessonAliases` 里内联构造规范课次键 —— 合法身份消费，归 U18（§6 拥有 lib/unify/evidence.cjs）' },
  'lib/state.js': { kind: 'OWNED-OTHER-CARD', owner: 'U18', why: '台账归属归一化里内联构造规范课次键（fail-closed 之后的正规写法）—— 归 U18（§6 拥有 lib/state.js）' },
  // ⚠️ `lib/pack-export.js`（决-3 收编）：**表里故意没有它** —— 它已在 §6 的 U16 行里，
  //    归因只能来自 §6 的运行时自动归属（A06 ⑦b 会逐条断言"显式表里仍然没有它"）。
  //    收编前它是唯一 `DEFERRED-OTHER-CARD`，靠 deferredPins 钉上限；现在钉子必须为零（A06 ⑦c）。
  'lib/pack-template/tools/offline-server.js': { kind: 'OWNED-OTHER-CARD', owner: 'U12', why: '内联构造知识点键 —— 归 U12' },
  'lib/pack-template/tools/build-lessons.js': { kind: 'OWNED-OTHER-CARD', owner: 'U07', why: '仍产出**两段**课次键 `point/NNNN` —— 归 U07（build-lessons 写集）' },
  'lib/pack-template/tools/build-starmap.js': { kind: 'OWNED-OTHER-CARD', owner: 'U15', why: '仍产出**两段**课次键 `point/NNNN` —— 归 U15（build-starmap 写集）' },
  'lib/unify/render.cjs': { kind: 'OWNED-OTHER-CARD', owner: 'U07', why: '仍产出**两段**课次键 `point/NNNN` —— 归 U07（render.cjs 写集）' },
  'lib/point-ref.js': { kind: 'OWNED-OTHER-CARD', owner: 'U09', why: '身份**构造与解析**都已收敛（`qualified` → `identity.pointKey`；`splitQualified` → `parseLessonKey`/`parsePointKey`，决-7）—— 本文件在 §6 里归 U09；此刻它已无任何自造痕迹，谁再抄回 `indexOf(\'/\')` 自拆，A06 ⑥ 的残留判据与变异⑤都会红' },
})

/** 归类种类全集（表里出现别的字符串 ⇒ 红）——`BLOCKED-BOUNDARY` 已随决-7 废止，不再是合法种类 */
const IDENTITY_KINDS = Object.freeze(['KERNEL', 'MIGRATION', 'NON-IDENTITY', 'OWNED-OTHER-CARD', 'DEFERRED-OTHER-CARD'])

/**
 * 决-7 的**逐例 Δ 表**（`lib/point-ref.js` 的 `splitQualified` 收敛到严格内核）。
 *
 * 只列「没有课程包目录可对照」那一支里会变的输入（有目录的分支根本不调用 `splitQualified`）：
 *   · `reject` —— 带 `/` 却既不是 `circle/point` 也不是 `circle/point/NNNN` ⇒ 明确拒绝，
 *                  `code` 取既有体系里最贴切的 `unknown`（**没有新码值**）；
 *   · `lesson` —— 合法课次键 ⇒ 取它所属的知识点（`id`/`bare` 不带课号）。
 * 每一条都同时断言「基线在那一例上确实不同」（否则这条 Δ 是空转的）。
 */
const POINT_REF_STRICT = Object.freeze([
  { ref: 'a/x/y', kind: 'reject', why: '三段且第三段不是四位课号' },
  { ref: 'a/x/1', kind: 'reject', why: '课号段只有一位（内核要求四位）' },
  { ref: 'a/x/0000', kind: 'reject', why: '课号 0000 越出 1–9999' },
  { ref: 'a/x/10000', kind: 'reject', why: '课号 10000 越出 1–9999' },
  { ref: '/x', kind: 'reject', why: '圆圈段是空串' },
  { ref: 'x/', kind: 'reject', why: '知识点段是空串' },
  { ref: 'a//x', kind: 'reject', why: '三段但中间段是空串' },
  { ref: 'a/x/0001', kind: 'lesson', circle: 'a', point: 'x', segment: '0001', why: '合法课次键 ⇒ 知识点是 a/x' },
  { ref: 'b/x/0002', kind: 'lesson', circle: 'b', point: 'x', segment: '0002', why: '合法课次键 ⇒ 知识点是 b/x' },
])

/** 三种"身份构造/解析"痕迹的判定式（模块级：`scanIdentityEntries` 与 `scanIdentityImplementations` 共用一份） */
const IDENTITY_PATTERNS = Object.freeze([
  ['template-circle-point', /\$\{\s*([A-Za-z_$][\w$]*)\.circle\s*\}\s*\/\s*\$\{\s*\1\.(?:id|point)\s*\}/],
  ['template-circle-point', /`\$\{\s*circle\s*\}\s*\/\$\{\s*point\s*\}/],
  ['indexof-slash', /\.indexOf\(\s*['"]\/['"]\s*\)/],
  ['padstart4', /padStart\(\s*4\s*,\s*['"]0['"]\s*\)/],
])

let _repoOwners6 = null
/**
 * 仓内 `docs/unify/interfaces.md` §6 的「路径 → 卡[]」（**运行时**解析，读一次缓存；纯读取）。
 * 自动归属用它在"显式表没有"时判"该路径有没有主"。
 */
export function section6OwnersOfRepo(repoRoot = REPO) {
  if (_repoOwners6) return _repoOwners6
  const lockPath = path.join(repoRoot, 'docs', 'unify', 'interfaces.md')
  const blocks = parseSection6Blocks(readText(lockPath))
  _repoOwners6 = pathOwners(new Map([...blocks].map(([card, b]) => [card, b.paths])))
  return _repoOwners6
}

/**
 * **两阶段归类**（U09-Δ2）：先查显式表，表里没有时按 §6 运行时归属。
 * @param {string} file 仓内相对路径
 * @param {Map<string,string[]>|null} section6Owners §6 的 路径→卡[]（缺省取仓内 §6）
 * @returns {{kind:string, owner:string|null, why:string, attribution:'explicit-table'|'section6-auto'|'section6-ambiguous'|'none'}}
 */
export function classifyIdentityFile(file, section6Owners = null) {
  const rule = IDENTITY_SCAN_RULES[file]
  if (rule) return { kind: rule.kind, owner: rule.owner ?? null, why: rule.why, attribution: 'explicit-table' }
  const owners = section6Owners ?? section6OwnersOfRepo()
  const own = owners.get(file) ?? []
  if (own.length === 1) {
    return {
      kind: 'OWNED-OTHER-CARD',
      owner: own[0],
      why: `显式表里没有 ⇒ 运行时按 interfaces.md §6 自动归属：§6 的 ${own[0]} 行点名了该文件（并发 lane 的合法身份消费）`,
      attribution: 'section6-auto',
    }
  }
  if (own.length > 1) {
    return {
      kind: 'OWNED-OTHER-CARD',
      owner: null,
      why: `§6 里多个卡都点名了该文件（${own.join('、')}）—— 多主等于没主，记不到唯一主人，需主持人裁决`,
      attribution: 'section6-ambiguous',
    }
  }
  return {
    kind: 'UNCLASSIFIED',
    owner: null,
    why: '显式表没有、interfaces.md §6 里也没有主 —— 新出现的构造/解析点必须先归到一张真实存在的 U 卡',
    attribution: 'none',
  }
}

/** `repoRoot` 下 `lib/**` + `tools/**` 的 `.js/.mjs/.cjs` → `[{file, text}]`（纯读，不写盘） */
export function identityTreeEntries(repoRoot = REPO) {
  const files = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (/\.(?:js|mjs|cjs)$/.test(e.name)) files.push(abs)
    }
  }
  walk(path.join(repoRoot, 'lib'))
  walk(path.join(repoRoot, 'tools'))
  return files.map((abs) => ({ file: path.relative(repoRoot, abs).split(path.sep).join('/'), text: readText(abs) }))
}

/**
 * 扫一批 `{file, text}`，逐条列出并归类（纯函数：不写盘、不读盘）。
 * @param {{file:string,text:string}[]} entries
 * @param {Map<string,string[]>|null} section6Owners §6 的 路径→卡[]
 */
export function scanIdentityEntries(entries, section6Owners = null) {
  const owners = section6Owners ?? section6OwnersOfRepo()
  const isComment = (s) => /^\s*(\*|\/\/|\/\*)/.test(s)
  const hits = []
  for (const { file, text } of entries) {
    const cls = classifyIdentityFile(file, owners)
    text: for (const [i, line] of String(text).split('\n').entries()) {
      if (isComment(line)) continue
      for (const [pattern, rx] of IDENTITY_PATTERNS) {
        if (!rx.test(line)) continue
        hits.push({
          file, line: i + 1, pattern,
          kind: cls.kind, classification: cls.kind, owner: cls.owner,
          why: cls.why, attribution: cls.attribution,
          text: line.trim().slice(0, 120),
        })
        continue text
      }
    }
  }
  return {
    scanned: entries.length,
    hits,
    kernelHits: hits.filter((h) => h.kind === 'KERNEL').length,
    deferred: [...new Set(hits.filter((h) => h.kind === 'DEFERRED-OTHER-CARD').map((h) => h.file))].sort(),
    ownedOther: [...new Set(hits.filter((h) => h.kind === 'OWNED-OTHER-CARD').map((h) => h.file))].sort(),
    autoAttributed: [...new Set(hits.filter((h) => h.attribution === 'section6-auto').map((h) => h.file))].sort(),
  }
}

/**
 * 扫 `lib/**` + `tools/**` 的 `.js/.mjs/.cjs`，逐条列出并归类（读盘，不写盘）。
 * `repoRoot` 可换（A06 的反空转变异在 E:\Temp 副本上跑**同一份**扫描）；
 * `section6Owners` 可换（副本树里没有 `docs/unify/interfaces.md`，归属口径仍取真仓 §6）。
 * @returns {{scanned:number, hits:object[], kernelHits:number, deferred:string[], ownedOther:string[], autoAttributed:string[]}}
 */
export function scanIdentityImplementations(repoRoot = REPO, section6Owners = null) {
  return scanIdentityEntries(identityTreeEntries(repoRoot), section6Owners)
}

/**
 * 「内核族」退化口径的显式清单：只有在 §6 **没有**登记该落点时才用得上（U18 的卡面可能只写了
 * 模块名而不在 §6 表里）。§6 有登记 ⇒ 一律以 §6 为准（那一支根本读不到本清单）。
 */
const KERNEL_FAMILY_FALLBACK = Object.freeze({
  'lib/state.js': 'U18',
  'lib/unify/evidence.cjs': 'U18',
})

/**
 * 归属口径解析（**运行时**读 §6，不硬编码 路径→卡）：
 *   · 主口径 `section6`        —— §6 里哪张卡的行点名了该文件，那张卡就拥有它；
 *   · 退化口径 `kernel-family` —— §6 没登记该落点（可能只在 U18 卡面）时，按「`lib/unify/<模块>.cjs`
 *     由负责该内核的卡拥有」的命名约定 + `KERNEL_FAMILY_FALLBACK` 显式清单归属，并在回执里写明口径。
 * @returns {{rows:object[], caliber:string, ok:boolean}}
 */
export function resolveIdentityOwnerCaliber(section6, files = Object.keys(KERNEL_FAMILY_FALLBACK)) {
  const owners = pathOwners(section6)
  const rows = files.map((file) => {
    const s6 = owners.get(file) ?? []
    if (s6.length) {
      return { file, caliber: 'section6', owner: s6[0], section6Owners: s6, ok: true, why: '§6 的行里点名了该落点' }
    }
    const fam = KERNEL_FAMILY_FALLBACK[file]
    if (!fam) return { file, caliber: 'none', owner: null, section6Owners: [], ok: false, why: '§6 无登记，退化清单里也没有' }
    const isKernelFamily = /^lib\/unify\/[A-Za-z0-9._-]+\.cjs$/.test(file)
    return {
      file, caliber: 'kernel-family', owner: fam, section6Owners: [], ok: section6.has(fam),
      why: section6.has(fam)
        ? `§6 未登记该落点 ⇒ 按内核族命名约定（${isKernelFamily ? 'lib/unify/<模块>.cjs 归负责该内核的卡' : '内核消费方按内核归属'}）+ 显式清单归 ${fam}`
        : `退化口径也失效：§6 里没有卡 ${fam}`,
    }
  })
  const caliber = rows.some((r) => r.caliber === 'kernel-family')
    ? 'kernel-family'
    : (rows.some((r) => r.caliber === 'none') ? 'none' : 'section6')
  return { rows, caliber, ok: rows.every((r) => r.ok) }
}

/**
 * 回执里的「无主文件命中点上限」→ `Map<'file|pattern', maxCount>`（**纯函数**）。
 * 支持两种登记形状：字符串 `'lib/x.js|template-circle-point|2'` 或对象 `{file, pattern, maxCount}`。
 */
export function deferredPinsFromReceipt(rc) {
  const list = rc && rc.identityAttribution && Array.isArray(rc.identityAttribution.deferredPins)
    ? rc.identityAttribution.deferredPins
    : []
  const m = new Map()
  for (const x of list) {
    let file = ''
    let pattern = ''
    let max = NaN
    if (typeof x === 'string') {
      const parts = x.split('|')
      file = parts[0] || ''
      pattern = parts[1] || ''
      max = Number(parts[2])
    } else if (x && typeof x === 'object') {
      file = String(x.file ?? '')
      pattern = String(x.pattern ?? '')
      max = Number(x.maxCount)
    }
    if (!file || !pattern || !Number.isFinite(max)) continue
    m.set(`${file}|${pattern}`, max)
  }
  return m
}

/**
 * **归属判定**（纯函数）：每个命中点必须能映射到 §6 里**有主**的卡。
 *
 * 任一不满足 ⇒ 该行红：
 *   ① 归类必须是已知种类（`UNCLASSIFIED` / 表里没有 ⇒ 红）；
 *   ② `DEFERRED-OTHER-CARD`（无主文件）：该文件在 §6 里**必须真的无主**，且 `文件|痕迹` 必须在
 *      回执里钉住上限，并**不超过**钉住值（多冒一处即红）；
 *   ③ 其余种类：必须带责任卡；卡号必须是 §6 里**真实存在的 U 卡**；且 §6 里**那张卡确实拥有该文件**
 *      （"我认为归谁"与"文档记着归谁"对不上 ⇒ 红）。
 *
 * @param {object[]} hits `scanIdentityImplementations().hits`
 * @param {{cards:Set<string>, owners:Map<string,string[]>, pins:Map<string,number>}} ctx
 */
export function attributeIdentityHits(hits, ctx) {
  const cards = ctx.cards ?? new Set()
  const owners = ctx.owners ?? new Map()
  const pins = ctx.pins ?? null
  const rows = []
  const counts = new Map()
  for (const h of hits) {
    const k = `${h.file}|${h.pattern}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  for (const h of hits) {
    const s6 = owners.get(h.file) ?? []
    const problems = []
    const kind = h.kind
    if (!kind || kind === 'UNCLASSIFIED' || !IDENTITY_KINDS.includes(kind)) {
      problems.push(`未归类（种类 ${fmt(kind)}）—— 显式表没有、§6 里也没有主：新出现的构造/解析点必须先归到一张真实存在的 U 卡`)
    } else if (kind === 'DEFERRED-OTHER-CARD') {
      if (s6.length) problems.push(`标为"§6 无主"却在 §6 里有主（${s6.join(',')}）—— 归类与文档打架`)
      if (!pins || !pins.has(`${h.file}|${h.pattern}`)) {
        problems.push(`无主文件的命中点没在回执 identityAttribution.deferredPins 里钉住（${h.file}|${h.pattern}）`)
      }
    } else if (!h.owner) {
      problems.push(h.attribution === 'section6-ambiguous'
        ? `§6 里多个卡都点名 ${h.file}（${s6.join('、')}）—— 多主等于没主，归不到唯一主人`
        : '没有责任卡（每处身份实现都必须归到一张 U 卡）')
    } else if (!cards.has(h.owner)) {
      problems.push(`责任卡 ${h.owner} 不是 §6 里真实存在的 U 卡`)
    } else if (!s6.includes(h.owner)) {
      problems.push(`§6 里 ${h.owner} 并不拥有 ${h.file}（§6 记的主：${s6.length ? s6.join(',') : '无'}）—— 归属对不上文档`)
    }
    rows.push({
      file: h.file, line: h.line, pattern: h.pattern, kind: kind ?? null, owner: h.owner ?? null,
      attribution: h.attribution ?? null,
      section6Owners: s6, pinnedMax: pins ? (pins.get(`${h.file}|${h.pattern}`) ?? null) : null,
      ok: problems.length === 0, problems,
    })
  }
  const pinRows = []
  for (const [k, max] of pins ?? new Map()) {
    const observed = counts.get(k) || 0
    const [file, pattern] = k.split('|')
    pinRows.push({
      file, line: null, pattern, kind: 'PIN', owner: null,
      observed, pinnedMax: max,
      ok: observed <= max,
      problems: observed <= max
        ? []
        : [`无主文件的命中点数超过回执钉住的上限（${k}：实测 ${observed} > 钉住 ${max}）—— 无主文件不是自由区`],
    })
  }
  const all = [...rows, ...pinRows]
  return { rows: all, hitRows: rows, pinRows, counts: [...counts].map(([key, n]) => ({ key, n })), failures: all.filter((r) => !r.ok) }
}

/**
 * 决-7 判据（纯函数）：`lib/point-ref.js` 的**身份痕迹必须为 0**，该文件的归类必须是
 * `OWNED-OTHER-CARD/U09`（显式表），且全仓**不再有** `BLOCKED-BOUNDARY`。
 *
 * 为什么单列：收敛之后 `lib/point-ref.js` 一处命中点都不剩，于是"命中点归到哪张卡"对它变成
 * 空转 —— 所以把「残留 = 0」做成一条判据，并在 A06 ⑧ 的变异⑤里把**基线实现**抄回副本，
 * 证明它真的会红（判据活着，不是靠"没有命中点"白得的绿）。
 *
 * @param {object[]} hits `scanIdentityImplementations().hits`
 * @param {{kind?:string, owner?:string|null, attribution?:string}|null} cls `classifyIdentityFile('lib/point-ref.js')`
 * @returns {{ok:boolean, rows:{ok:boolean,msg:string}[], residue:object[]}}
 */
export function judgePointRefResidue(hits, cls) {
  const list = Array.isArray(hits) ? hits : []
  const residue = list.filter((h) => h.file === POINT_REF)
  const blocked = list.filter((h) => h.kind === 'BLOCKED-BOUNDARY')
  const rows = [
    {
      ok: residue.length === 0,
      msg: `lib/point-ref.js 不许再有任何身份构造/解析痕迹（决-7 收敛后应为 0；实得 ${fmt(residue.map((h) => `${h.line}:${h.pattern}:${h.classification}`))}）`,
    },
    {
      ok: !!(cls && cls.kind === 'OWNED-OTHER-CARD' && cls.owner === 'U09' && cls.attribution === 'explicit-table'),
      msg: `lib/point-ref.js 的归类必须是 OWNED-OTHER-CARD/U09（显式表；不许再是 BLOCKED-BOUNDARY / UNCLASSIFIED；实得 ${fmt(cls ? `${cls.kind}/${cls.owner ?? '(无)'}[${cls.attribution}]` : '(无)')}）`,
    },
    {
      ok: blocked.length === 0,
      msg: `全仓扫描不许再有 BLOCKED-BOUNDARY 分类（决-7 已把这条边界销账；实得 ${fmt(blocked.map((h) => `${h.file}:${h.line}`))}）`,
    },
  ]
  return { ok: rows.every((r) => r.ok), rows, residue }
}

/* ── oracle：把 lib/ 拷到临时树、用 git HEAD 还原三个落点 ⇒ 基线实现 ──────── */

let _oldTree = null
/** @returns {string} 临时树根（含 `lib/`） */
function oldTree() {
  if (_oldTree) return _oldTree
  const dir = path.join(RUN_TEMP, 'baseline-tree')
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(path.join(REPO, 'lib'), path.join(dir, 'lib'), { recursive: true })
  for (const relPath of CHANGED_FILES) {
    if (!relPath.startsWith('lib/')) continue
    fs.writeFileSync(path.join(dir, ...relPath.split('/')), headBytes(relPath))
  }
  _oldTree = dir
  return dir
}

let _oldModel = null
let _newModel = null
let _core = null

async function oldModel() {
  if (!_oldModel) _oldModel = await import(pathToFileURL(path.join(oldTree(), 'lib/pack-model.js')).href)
  return _oldModel
}

async function newModel() {
  if (!_newModel) _newModel = await import(pathToFileURL(path.join(REPO, 'lib/pack-model.js')).href)
  return _newModel
}

function core() {
  if (!_core) _core = require_(path.join(REPO, KERNEL))
  return _core
}

/** 一次结果落证据（A08 的 detail.json 用它，避免把大对象塞进备注） */
function record(section, payload) {
  DETAIL.comparisons[section] = payload
  return payload
}

/** 判据汇总：`[{ok, msg}]` → 逐条断言 */
function assertAll(rows, section) {
  const bad = rows.filter((r) => !r.ok)
  record(section, { rows, failures: bad.map((r) => r.msg) })
  assert(bad.length === 0, bad.slice(0, 3).map((r) => r.msg).join(' | '))
}

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 跨圈同名点、同课号互不覆盖
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
  const root = fixtureCrossCircle(path.join(RUN_TEMP, 'fx-a01'))
  const model0 = await newModel()
  // 判据函数接一个带 readPack 的视图：这样"进度只点亮目标课程"那一半也在这里被真的执行
  const real = judgeCrossCircle({ ...core(), readPack: model0.readPack }, root)
  const model = model0
  const pack = model.readPack(root)

  const rows = [
    { ok: real.problems.length === 0, msg: real.problems.join('；') || 'ok' },
    { ok: real.keys.length === 2, msg: `两条课各自独立存在（${real.keys.join(' / ')}）` },
    { ok: new Set(real.entries.map((e) => e.key)).size === 2, msg: '两个键互不相同（不许被合并成一个）' },
    { ok: pack.lessons.length === 2 && new Set(pack.lessons.map((l) => l.id)).size === 2, msg: `readPack 也给出两条互不相同的课（实得 ${fmt(pack.lessons.map((l) => l.id))}）` },
    { ok: pack.warnings.length === 0, msg: `不该有 warnings（实得 ${fmt(pack.warnings)}）` },
  ]

  // Δ：基线实现把跨圈同号合成了一个页（这正是本卡修掉的缺陷）
  const old = await oldModel()
  const oldIdx = old.lessonIndex(root)
  const oldPack = old.readPack(root)
  const oldResult = {
    keys: Object.keys(oldIdx.byKey),
    conflicts: oldIdx.conflicts,
    lessonIds: oldPack.lessons.map((l) => l.id),
    distinctLessonIds: new Set(oldPack.lessons.map((l) => l.id)).size,
  }
  rows.push({ ok: oldResult.distinctLessonIds !== 2 || oldResult.keys.length !== 2, msg: `基线实现确实存在"跨圈同号被合并"（老 keys=${fmt(oldResult.keys)} / 老 lessonIds=${fmt(oldResult.lessonIds)}）—— 否则 A01 是空转` })

  record('A01', { new: { keys: real.keys, entries: real.entries.map((e) => ({ key: e.key, label: e.label, src: e.src, page: e.page })) }, oracle: oldResult })
  assertAll(rows, 'A01.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 进度只影响目标课程
 * ══════════════════════════════════════════════════════════════════════ */

async function A02() {
  const root = fixtureLegacyProgress(path.join(RUN_TEMP, 'fx-a02'))
  const judged = judgeProgress(core(), root)
  const model = await newModel()
  const pack = model.readPack(root)
  const byId = Object.fromEntries(pack.lessons.map((l) => [l.id, l]))
  const rawLearned = JSON.parse(readText(path.join(root, 'progress.json'))).learned

  const rows = [
    { ok: judged.problems.length === 0, msg: judged.problems.join('；') || 'ok' },
    { ok: byId['math/vue/0001'] && byId['math/vue/0001'].learned === true, msg: '规范条目点亮了它自己那门课' },
    { ok: byId['programming/vue/0001'] && byId['programming/vue/0001'].learned === false, msg: '跨圈同号的另一门没有被连带点亮（进度只影响目标课程）' },
    { ok: pack.learned.length === rawLearned.length && JSON.stringify(pack.learned) === JSON.stringify(rawLearned), msg: '`learned` 字段仍按原样返回（返回形状不许变：老调用方按 .length 数已学数）' },
    { ok: pack.warnings.filter((wmsg) => /不是规范课次键/.test(wmsg)).length === 2, msg: `历史形状逐条点名（两段课键之外的"点键/显示名"两条走这里；实得 ${pack.warnings.filter((x) => /不是规范课次键/.test(x)).length}）` },
    { ok: pack.warnings.filter((wmsg) => /归属歧义/.test(wmsg)).length === 2, msg: `跨圈歧义条目逐条点名候选（两段课键 + 裸课号各一条；实得 ${pack.warnings.filter((x) => /归属歧义/.test(x)).length}）` },
    { ok: pack.warnings.some((wmsg) => /幽灵条目/.test(wmsg)), msg: '规范但不存在的条目按幽灵条目点名' },
    { ok: pack.warnings.some((wmsg) => /归属歧义/.test(wmsg)), msg: '跨圈歧义条目点名候选（不猜）' },
    { ok: !pack.warnings.some((wmsg) => /点键/.test(wmsg) && /点亮/.test(wmsg)), msg: '点键不许被扩展成多门已学课程' },
  ]

  // Δ：基线实现对这些规范进度条目一无所知（全灭 + 幽灵）
  const old = await oldModel()
  const oldPack = old.readPack(root)
  const oldLit = oldPack.lessons.filter((l) => l.learned).map((l) => l.id)
  const oldResult = {
    lessonIds: oldPack.lessons.map((l) => l.id),
    lit: oldLit,
    warnings: oldPack.warnings,
  }
  rows.push({
    ok: !(oldLit.length === 1 && oldLit[0] === 'math/vue/0001'),
    msg: `基线实现确实"点亮不了规范条目"（老 lit=${fmt(oldLit)} / 老 warnings=${fmt(oldPack.warnings.slice(0, 2))}）—— 否则 A02 是空转`,
  })

  record('A02', {
    new: { lit: judged.lit, problems: judged.detail, lessonLearned: pack.lessons.map((l) => [l.id, l.learned]) },
    oracle: oldResult,
  })
  assertAll(rows, 'A02.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 未知和歧义引用明确拒绝
 * ══════════════════════════════════════════════════════════════════════ */

async function A03() {
  const root = fixtureCrossCircle(path.join(RUN_TEMP, 'fx-a03'))
  const c = core()
  const idx = c.lessonIndex(root)
  const model = await newModel()

  const cases = [
    // [输入, 期望 reason, 期望候选]
    ['vue/0001', 'ambiguous', ['math/vue/0001', 'programming/vue/0001']],
    ['vue', 'ambiguous', ['math/vue', 'programming/vue']],
    ['0001', 'ambiguous', ['math/vue/0001', 'programming/vue/0001']],
    ['math/nope/0001', 'unknown', []],
    ['nope/vue/0001', 'unknown', []],
    ['math/vue/0001', 'AMBIGUOUS-NOT', null],
  ]
  const rows = []
  const results = []
  for (const [input, wantReason, wantCands] of cases) {
    const r = c.resolveLessonRef(input, idx)
    if (input === 'math/vue/0001') {
      const okResolved = r.ok === true && r.key === input
      rows.push({ ok: okResolved, msg: `规范引用 ${input} 必须直接解析成功（实得 ${fmt(r)}）` })
      results.push({ input, ok: r.ok, key: r.key })
      continue
    }
    const reason = r.ok ? '(ok)' : r.failure.reason
    const cands = r.ok ? [] : (r.failure.candidates || [])
    rows.push({ ok: !r.ok, msg: `「${input}」必须被拒绝（实得 ${fmt(r)}）` })
    rows.push({ ok: reason === wantReason, msg: `「${input}」的拒绝原因应为 ${wantReason}（实得 ${reason}）` })
    rows.push({ ok: JSON.stringify(cands) === JSON.stringify(wantCands), msg: `「${input}」的候选应为 ${fmt(wantCands)}（实得 ${fmt(cands)}）` })
    // 明确拒绝 = **没有**被归一成某个键（不许"猜一个最近的"）
    rows.push({ ok: c.keyOfAnchor(input, idx) === null, msg: `「${input}」不得被归一成某个课次键（实得 ${fmt(c.keyOfAnchor(input, idx))}）` })
    rows.push({ ok: c.labelOfAnchor(input, idx) === null, msg: `「${input}」不得被反推出显示名（实得 ${fmt(c.labelOfAnchor(input, idx))}）` })
    results.push({ input, reason, candidates: cands })
  }

  // 包侧同一份内核：同样的拒绝（不是"宿主会拒、包侧会猜"）
  const packSide = packSideRequire(path.join(RUN_TEMP, 'fx-a03'), root)
  rows.push({ ok: typeof packSide.keyOfAnchor === 'function', msg: '包侧 lesson-map 包装装载成功（自建 tools/unify 副本）' })
  if (typeof packSide.keyOfAnchor === 'function') {
    for (const input of ['vue/0001', 'vue', '0001', 'math/nope/0001']) {
      rows.push({ ok: packSide.keyOfAnchor(input, packSide.lessonMap(root)) === null, msg: `包侧也必须拒绝「${input}」` })
    }
    // reason 级对拍：包侧内核副本 vs 宿主内核（同一份源码、两个运行实例）
    const packKernel = require_(path.join(RUN_TEMP, 'fx-a03', 'tools', 'unify', 'pack.cjs'))
    for (const input of ['vue/0001', 'vue', 'math/nope/0001', '第1课', 'spring-boot/0001']) {
      const a = packKernel.resolveLessonRef(input, packKernel.lessonIndex(root))
      const b = c.resolveLessonRef(input, idx)
      rows.push({ ok: JSON.stringify(a) === JSON.stringify(b), msg: `包侧与宿主对「${input}」的判定逐字段相同（同一份内核）` })
    }
  }

  // 写入口的拒绝口径：孤儿/历史锚点 → null（notes-io / ask-server 据此当场拒写）
  rows.push({ ok: model.keyOfAnchor('第1课', idx) === null, msg: '显示名不再被写入口归一（运行态职责已删除）' })
  rows.push({ ok: model.keyOfAnchor('spring-boot/0001', idx) === null, msg: '两段课键不再被写入口归一（历史解码只在 U05）' })

  // EXPECT.json 的**两段声明**是单列的解析分支：圆圈靠路径唯一归属派生；0/多候选一律显式拒绝
  const ambRoot = fixtureDeclAmbiguous(path.join(RUN_TEMP, 'fx-a03-decl'))
  const ambIdx = c.lessonIndex(ambRoot)
  const ambConflicts = ambIdx.conflicts.filter((x) => /归属歧义/.test(x))
  rows.push({ ok: Object.keys(ambIdx.byKey).length === 0, msg: `两段声明在多圈同名点下**一门课也不许认**（实得 ${fmt(Object.keys(ambIdx.byKey))}）` })
  rows.push({ ok: ambConflicts.length === 1, msg: `两段声明在跨圈同名点下必须报「归属歧义」（实得 ${ambConflicts.length} 条：${fmt(ambConflicts)}）` })
  rows.push({
    ok: ambConflicts.every((x) => /math\/vue\/0001/.test(x) && /programming\/vue\/0001/.test(x)),
    msg: '歧义冲突必须把**两个**候选都点出来（不猜、不取第一个）',
  })
  const uniqDecl = c.lessonIndex(fixtureCanonical(path.join(RUN_TEMP, 'fx-a03-decl-ok')))
  rows.push({ ok: uniqDecl.conflicts.length === 0 && Object.keys(uniqDecl.byKey).length === 4, msg: '两段声明在**唯一归属**的圈里照旧对位成功（声明分支不是"一律拒绝"）' })
  record('A03.declarationShape', {
    shape: 'point/NNNN（EXPECT.json 的 lessons[].id，**声明**不是身份）',
    zeroCandidate: c.lessonIndex(fixtureBrokenDirs(path.join(RUN_TEMP, 'fx-a03-decl-zero'))).conflicts.filter((x) => /都没有 \d{4} 的页面/.test(x)),
    multiCandidate: ambConflicts,
    uniqueCandidate: Object.keys(uniqDecl.byKey),
  })

  record('A03', { indexKeys: Object.keys(idx.byKey).sort(), results })
  assertAll(rows, 'A03.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 运行态拒绝历史形状；规范夹具验证新映射（**不**伪称跑过 U05）
 * ══════════════════════════════════════════════════════════════════════ */

async function A04() {
  const root = fixtureCanonical(path.join(RUN_TEMP, 'fx-a04'))
  const c = core()
  const idx = c.lessonIndex(root)
  const model = await newModel()

  const rows = []
  // ① 规范形状真的解析得通、且**原样**返回（不重建、不改大小写）
  const canonicalKeys = ['math/alge/0001', 'programming/spring-boot/0001', 'programming/spring-boot/0002', 'programming/vue/1001']
  sameJson(Object.keys(idx.byKey).sort(), canonicalKeys, '规范夹具的键必须恰好是四条规范课次键')
  for (const key of canonicalKeys) {
    const r = c.resolveLessonRef(key, idx)
    rows.push({ ok: r.ok === true && r.key === key, msg: `规范课次键 ${key} 必须解析成功且原样返回（实得 ${fmt(r)}）` })
    rows.push({ ok: c.labelOfAnchor(key, idx) === idx.byKey[key].label, msg: `${key} 的显示名反推必须回到映射表里的 label` })
  }

  // ② 历史形状逐类拒绝，且**原因可机器判读**（不是"统一 null 糊过去"）
  const historical = [
    ['alge', 'bare-point', '裸知识点'],
    ['alge/0001', 'HISTORICAL', '两段课键（point/课号，缺圆圈）'],
    ['programming/alge', 'point-key-in-lesson-slot', '两段点键落在课程位'],
    ['代数 第1课', 'display-name', '显示名（带 label 的轨道）'],
    ['第2课', 'display-name', '显示名（无 label 的轨道）'],
    ['programming/alge/1', 'narrow-lesson-number', '1 位课号（1–5 位历史写法）'],
    ['programming/alge/00001', 'wide-lesson-number', '5 位课号'],
    ['programming/alge/10000', 'wide-lesson-number', '5 位课号（>9999 也是 5 位，先按"位宽"判）'],
    ['programming/alge/0000', 'out-of-range', '四位但课号 0 越界'],
    ['programming/alge/000a', 'malformed', '课号不是十进制'],
    ['programming//0001', 'malformed', '空段'],
    ['../etc/0001', 'malformed', '路径逃逸（含 ..）'],
    ['  programming/alge/0001  ', 'untrimmed', '前后带空白'],
    ['', 'empty', '空串'],
  ]
  const got = []
  for (const [input, wantReason, why] of historical) {
    const r = c.resolveLessonRef(input, idx)
    const reason = r.ok ? '(ok)' : r.failure.reason
    const want = wantReason === 'HISTORICAL' ? 'historical-lesson-key' : wantReason
    got.push({ input, reason, ok: !r.ok && reason === want })
    rows.push({ ok: !r.ok, msg: `历史形状「${input}」必须被拒绝（${why}；实得 ${fmt(r)}）` })
    rows.push({ ok: reason === want, msg: `历史形状「${input}」的 reason 应为 ${want}（实得 ${reason}）` })
    rows.push({ ok: c.keyOfAnchor(input, idx) === null, msg: `历史形状「${input}」不得被归一（keyOfAnchor 必须是 null）` })
  }

  // ③ 规范夹具上"新映射"整链可读：readPack 的课次身份、显示号、进度都按规范算
  const pack = model.readPack(root)
  rows.push({ ok: pack.lessons.length === 4, msg: `readPack 读出 4 门课（实得 ${pack.lessons.length}）` })
  rows.push({ ok: pack.lessons.every((l) => /^[^/]+\/[^/]+\/\d{4}$/.test(l.id)), msg: 'readPack 的课程 id 全是规范课次键' })
  rows.push({ ok: pack.lessons.filter((l) => l.learned).length === 2, msg: `进度里的两条规范条目点亮两门课（实得 ${pack.lessons.filter((l) => l.learned).length}）` })
  const vue = pack.lessons.find((l) => l.point === 'vue')
  rows.push({ ok: !!vue && vue.displayNumber === 1, msg: `fileBase=1000 的轨道显示号折算成 1（实得 ${fmt(vue && vue.displayNumber)}）—— 显示换算没被身份改动带跑` })
  rows.push({ ok: !!vue && vue.label === 'Vue 第1课', msg: `带 label 的轨道显示名是「Vue 第1课」（实得 ${fmt(vue && vue.label)}）` })

  // ④ **不伪称跑过 U05**：运行态内核里没有迁移模块的任何引用；历史夹具不会被隐式迁移
  const kernelSrc = readText(path.join(REPO, KERNEL))
  const modelSrc = readText(path.join(REPO, HOST_MODEL))
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const [name, src] of [[KERNEL, kernelSrc], [HOST_MODEL, modelSrc]]) {
    rows.push({
      ok: !/require\(\s*['"][^'"]*migration\.cjs['"]\s*\)/.test(strip(src)) && !/from\s+['"][^'"]*migration\.cjs['"]/.test(strip(src)),
      msg: `${name} 不许 require 迁移模块（运行态不做隐式双读）`,
    })
  }
  rows.push({ ok: fs.existsSync(path.join(REPO, MIGRATION)), msg: `历史解码仍只在 ${MIGRATION}（U05 已交付；本卡不调用它，也不伪称跑过迁移）` })
  const legacyRoot = fixtureLegacyProgress(path.join(RUN_TEMP, 'fx-a04-legacy'))
  const legacyIdx = c.lessonIndex(legacyRoot)
  rows.push({
    ok: c.resolveLessonRef('vue/0001', legacyIdx).ok === false && Object.keys(legacyIdx.byKey).length === 2,
    msg: '历史形状**没有**被隐式迁移：映射表里不新增条目、引用仍被拒',
  })

  record('A04', { canonicalKeys, historical: got, readPack: pack.lessons.map((l) => ({ id: l.id, learned: l.learned, label: l.label, displayNumber: l.displayNumber })) })
  assertAll(rows, 'A04.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 源与产物关系及目录校验保持
 * ══════════════════════════════════════════════════════════════════════ */

async function A05() {
  const root = fixtureBrokenDirs(path.join(RUN_TEMP, 'fx-a05'))
  const c = core()
  const now = judgeDirs(c, root)
  const old = await oldModel()
  const before = judgeDirs(old, root)
  const rows = []

  // ① 冲突**类别与条数**必须与基线实现一致（保持，不是"更松/更严"）
  sameJson(now.categories, before.categories, '目录校验的冲突类别必须与基线实现逐类一致（源/产物关系 + 声明对位）')
  for (const [cat, n] of Object.entries(now.categories)) {
    rows.push({ ok: n >= 1, msg: `冲突类别 ${cat} 必须在夹具里真的出现（否则这条是空转；实得 ${n}）` })
  }

  // ② 源/产物关系逐条：缺源、缺产物都点名
  rows.push({ ok: now.conflicts.some((x) => /缺课程源/.test(x)), msg: '只有产物页时点名「缺课程源」' })
  rows.push({ ok: now.conflicts.some((x) => /缺课程产物/.test(x)), msg: '只有课程源时点名「缺课程产物」' })
  rows.push({ ok: now.conflicts.some((x) => /但 EXPECT.json 没声明它/.test(x)), msg: '有页没声明时逐条点名' })
  rows.push({ ok: now.conflicts.some((x) => /都没有 0009 的页面/.test(x)), msg: '声明了却没有页面时点名（含课号）' })
  rows.push({ ok: now.conflicts.some((x) => /id 形状不对：badid/.test(x)), msg: 'EXPECT 里形状不对的 id 当场点名' })

  // ③ 完整课（源+产物都在）必须两条路径都在，且 expect 指回声明它的文件
  const good = c.lessonIndex(fixtureCanonical(path.join(RUN_TEMP, 'fx-a05-good')))
  rows.push({ ok: Object.values(good.byKey).every((e) => e.src && e.page), msg: '完整课同时有 src 与 page（源与产物关系保持）' })
  rows.push({ ok: Object.values(good.byKey).every((e) => String(e.src).startsWith('lessons/src/') && String(e.page).startsWith('lessons/')), msg: 'src 落在 lessons/src/、page 落在 lessons/（不许互串）' })
  rows.push({ ok: Object.values(good.byKey).every((e) => String(e.expect || '').endsWith('EXPECT.json')), msg: '每条都记着声明它的 EXPECT.json（相对包根）' })

  // ④ 旧平铺布局：兜底归属 + readPack 的历史布局告警都保持
  const flatRoot = fixtureFlat(path.join(RUN_TEMP, 'fx-a05-flat'))
  const flatNew = c.lessonIndex(flatRoot)
  const flatOld = old.lessonIndex(flatRoot)
  sameJson(Object.keys(flatNew.byKey).length, Object.keys(flatOld.byKey).length, '旧平铺布局的课数必须与基线实现一致（兜底归属保持）')
  const flatPack = (await newModel()).readPack(flatRoot)
  rows.push({ ok: flatPack.lessons.length === 1, msg: `旧平铺布局仍能读出一门课（实得 ${flatPack.lessons.length}）` })
  rows.push({ ok: flatPack.warnings.some((x) => /历史平铺布局/.test(x)), msg: '旧平铺布局仍逐条告警（不静默）' })

  // ⑤ readPack 的"不是课程包"路径仍明确（不静默返回空包）
  const notPack = path.join(RUN_TEMP, 'fx-a05-notpack')
  fs.mkdirSync(notPack, { recursive: true })
  const np = (await newModel()).readPack(notPack)
  rows.push({ ok: np.warnings.some((x) => /不是课程包/.test(x)), msg: '没有 lessons/ 时明确告警「不是课程包」（不静默降级）' })

  record('A05', { categories: now.categories, baselineCategories: before.categories, conflicts: now.conflicts, flat: Object.keys(flatNew.byKey) })
  assertAll(rows, 'A05.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 宿主与独立包侧映射一致，只有一份解析实现
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 在**自建包**里铺最小包侧工具：逐字节复制权威内核到 `<pack>/tools/unify/`，
 * 再把 `lib/pack-template/tools/lesson-map.js` 拷成 `<pack>/tools/lesson-map.js`。
 * （R1：仓内 `lib/pack-template/tools/unify/` 只由 U19 生成 —— 这里**不**碰它，只在自己的临时包里补。）
 * @returns {object} 包侧 `require` 出来的 lesson-map 包装
 */
function packSideRequire(packRootDir, fixtureRoot) {
  const pack = packRootDir
  const unifyDir = path.join(pack, 'tools', 'unify')
  fs.mkdirSync(unifyDir, { recursive: true })
  for (const f of ['pack.cjs', 'identity.cjs']) {
    fs.copyFileSync(path.join(REPO, 'lib/unify', f), path.join(unifyDir, f))
  }
  fs.copyFileSync(path.join(REPO, PACK_MAP), path.join(pack, 'tools', 'lesson-map.js'))
  return require_(path.join(pack, 'tools', 'lesson-map.js'))
}

async function A06() {
  const root = fixtureCanonical(path.join(RUN_TEMP, 'fx-a06'))
  const pack = path.join(RUN_TEMP, 'pack-a06')
  fs.mkdirSync(pack, { recursive: true })
  const packSide = packSideRequire(pack, root)
  const c = core()
  const model = await newModel()
  const identity = require_(path.join(REPO, 'lib/unify/identity.cjs'))
  const rows = []

  // ① 包侧副本与权威内核**逐字节相同**（不是"内容差不多的另一份"）
  for (const f of ['pack.cjs', 'identity.cjs']) {
    const from = path.join(REPO, 'lib/unify', f)
    const to = path.join(pack, 'tools', 'unify', f)
    rows.push({ ok: sha256(fs.readFileSync(to)) === sha256(fs.readFileSync(from)), msg: `包侧 tools/unify/${f} 必须与仓内权威模块逐字节相同` })
  }
  rows.push({
    ok: sha256(fs.readFileSync(path.join(pack, 'tools', 'lesson-map.js'))) === sha256(fs.readFileSync(path.join(REPO, PACK_MAP))),
    msg: '包侧 tools/lesson-map.js 必须与本仓那份逐字节相同（同一包装，不是又抄一份）',
  })

  // ② **函数同一性**：宿主导出的映射函数就是内核里的那一个；包侧包装导出的是同一个
  for (const name of ['lessonIndex', 'labelOfAnchor', 'keyOfAnchor', 'labelAnchorId', 'lessonLabel', 'displayNumberOf']) {
    rows.push({ ok: model[name] === c[name], msg: `宿主 lib/pack-model.js 的 ${name} 必须就是内核导出（函数同一性，不是同名同值）` })
  }
  // 导出面逐名不变：U01 §2 的 23 项（内核的解析接口不算本文件导出 —— 判据直接取自内核）
  sameJson(Object.keys(model).sort(), [
    'EVIDENCE_REL', 'NOTES_REL', 'checkTermsReport', 'describeGaps', 'displayNumberOf', 'keyOfAnchor',
    'labelAnchorId', 'labelOfAnchor', 'lessonIndex', 'lessonKey', 'lessonLabel', 'loadBoxes', 'nextNumber',
    'normGroups', 'normPractice', 'packSummary', 'pointKey', 'prerequisiteGaps', 'readPack',
    'remainingLessons', 'scanTerms', 'scanTermsInPage', 'validateBoxes',
  ], 'A06 · lib/pack-model.js 的导出面必须恰好是基线那 23 项（不多、不少）')
  for (const name of ['lessonMap', 'labelOfAnchor', 'keyOfAnchor', 'labelAnchorId', 'lessonLabel', 'displayNumberOf', 'pointMeta']) {
    rows.push({ ok: typeof packSide[name] === 'function', msg: `包侧包装必须导出 ${name}（导出面逐名保持）` })
  }
  // 函数同一性只能在**同一个模块实例内**比：包侧包装导出的是它自己那份内核的函数对象
  const packCoreCopy = require_(path.join(pack, 'tools', 'unify', 'pack.cjs'))
  rows.push({ ok: packSide.lessonMap === packCoreCopy.lessonIndex, msg: '包侧 lessonMap 必须就是（包内那份）内核 lessonIndex（函数同一性：包装里没有第二套算法）' })
  rows.push({ ok: packSide.labelOfAnchor === packCoreCopy.labelOfAnchor && packSide.keyOfAnchor === packCoreCopy.keyOfAnchor, msg: '包侧锚点解析函数必须就是内核导出' })
  rows.push({ ok: packSide.labelAnchorId === packCoreCopy.labelAnchorId, msg: '包侧 labelAnchorId 必须就是内核导出' })

  // ③ 行为逐键一致（宿主 vs 包侧，同一夹具）
  const hostIdx = model.lessonIndex(root)
  const sideIdx = packSide.lessonMap(root)
  sameJson(Object.keys(sideIdx.byKey), Object.keys(hostIdx.byKey), '宿主与包侧的课次键集合必须完全一致')
  sameJson(Object.keys(sideIdx.byLabel), Object.keys(hostIdx.byLabel), '宿主与包侧的显示名索引必须完全一致')
  sameJson(Object.values(sideIdx.byKey), Object.values(hostIdx.byKey), '宿主与包侧的条目逐字段一致（键序无关地逐条对拍）')
  sameJson(sideIdx.conflicts, hostIdx.conflicts, '宿主与包侧的冲突清单必须一致')
  for (const probe of ['programming/spring-boot/0001', '第1课', 'spring-boot/0001', 'nope/9999', '未归课', 'math/alge/0001']) {
    rows.push({ ok: packSide.labelOfAnchor(probe, sideIdx) === model.labelOfAnchor(probe, hostIdx), msg: `labelOfAnchor 两侧行为一致（${probe}）` })
    rows.push({ ok: packSide.keyOfAnchor(probe, sideIdx) === model.keyOfAnchor(probe, hostIdx), msg: `keyOfAnchor 两侧行为一致（${probe}）` })
  }

  // ④ "只有一份解析实现"的源码层证据：这些计算痕迹只许躺在内核里
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const CORE_TOKENS = ['\\u0000', 'collectPages', 'readPracticeRoots', 'REF_REASONS', 'circleNormalize']
  const coreSrc = stripComments(readText(path.join(REPO, KERNEL)))
  for (const token of CORE_TOKENS) {
    if (token === 'circleNormalize') continue // 占位：不许在判据里编一个内核里没有的记号
    rows.push({ ok: coreSrc.includes(token), msg: `内核里应当有计算痕迹 ${fmt(token)} —— 反空转（否则"宿主里没有"是白得的）` })
  }
  const hostSrc = stripComments(readText(path.join(REPO, HOST_MODEL)))
  const mapSrc = stripComments(readText(path.join(REPO, PACK_MAP)))
  for (const [name, src] of [[HOST_MODEL, hostSrc], [PACK_MAP, mapSrc]]) {
    for (const token of ['collectPages', 'readPracticeRoots', 'REF_REASONS']) {
      rows.push({ ok: !src.includes(token), msg: `${name} 里还留着映射实现痕迹 ${fmt(token)}（第二份实现）` })
    }
    rows.push({ ok: !/padStart\(\s*4\s*,\s*'0'\s*\)/.test(src), msg: `${name} 里还留着课号拼接（padStart(4)）—— 身份构造只许在内核` })
    rows.push({ ok: !/readdirSync\(.*EXPECT/.test(src), msg: `${name} 里还在自己扫 EXPECT（第二套目录扫描）` })
  }
  rows.push({
    ok: (mapSrc.match(/require\(\s*['"]\.\/unify\/pack\.cjs['"]\s*\)/g) || []).length === 1,
    msg: '包侧 lesson-map.js 必须**只** require ./unify/pack.cjs 这一份（恰好一次）',
  })
  rows.push({ ok: /from\s+['"]\.\/unify\/pack\.cjs['"]/.test(hostSrc), msg: '宿主 pack-model.js 必须从 ./unify/pack.cjs 取映射实现' })

  // ⑤ 身份构造：旧导出就是严格内核本人（不是包装、不是第三份）
  rows.push({ ok: model.pointKey === identity.pointKey, msg: 'pointKey 必须就是 identity.cjs 的严格内核（函数同一性）' })
  rows.push({ ok: model.lessonKey === identity.lessonKey, msg: 'lessonKey 必须就是 identity.cjs 的严格内核（函数同一性）' })
  sameJson(Object.keys(c).sort(), [
    'LEGACY_HALO', 'LEGACY_POINT', 'REF_REASONS', 'UNLESSON',
    'displayNumberOf', 'keyOfAnchor', 'labelAnchorId', 'labelOfAnchor', 'lessonIndex', 'lessonLabel',
    'pointMeta', 'readPracticeRoots', 'resolveLearned', 'resolveLessonRef',
  ], '内核导出面必须恰好是这 14 项（不多一个同义 API、不少一个）')

  // ⑥ `lib/point-ref.js` 的内联构造**与拆分**都收敛到同一内核（写集扩张 + 决-7）
  const pointRefModel = await import(pathToFileURL(path.join(REPO, POINT_REF)).href)
  const oldPointRef = await import(pathToFileURL(path.join(oldTree(), POINT_REF)).href)
  const pointRefSrc = stripComments(readText(path.join(REPO, POINT_REF)))
  rows.push({ ok: pointRefSrc.includes("from './unify/identity.cjs'"), msg: 'lib/point-ref.js 必须从 ./unify/identity.cjs 取构造/解析' })
  rows.push({ ok: !/\$\{\s*p\.circle\s*\}\/\$\{\s*p\.id\s*\}/.test(pointRefSrc), msg: 'lib/point-ref.js 里不许再内联 `${circle}/${point}` 拼身份（构造已收敛）' })
  rows.push({ ok: !/\.indexOf\(\s*['"]\/['"]\s*\)/.test(pointRefSrc), msg: "lib/point-ref.js 里不许再用 indexOf('/') 自拆身份（决-7：解析也收敛到 parseLessonKey/parsePointKey）" })
  // 决-7 判据（同一份纯函数也在 ⑧ 的变异⑤里跑）：残留 0 + 归类 OWNED-OTHER-CARD/U09 + 不再有 BLOCKED-BOUNDARY
  const refResidue = judgePointRefResidue(scanIdentityImplementations().hits, classifyIdentityFile(POINT_REF))
  for (const r of refResidue.rows) rows.push(r)
  sameJson(Object.keys(pointRefModel).sort(), Object.keys(oldPointRef).sort(), 'lib/point-ref.js 的导出面必须逐名不变')
  /* 可达输入域上的逐例对拍（决-7 起带**声明的 Δ 表**，别处零 Δ）：
   *   · 有课程包目录的例：`splitQualified` 根本不参与 ⇒ 必须与基线**逐字相同**；
   *   · 没有课程包目录、且不在 `POINT_REF_STRICT` 里的例：也必须与基线逐字相同；
   *   · 没有目录、且在表里的例：逐条按**新正确行为**判（拒绝面只收紧、不放宽），并逐条证明
   *     基线在那一例上确实不同（否则这条 Δ 是空转）。
   * （pack 的形状要与 `readPack()` 一致：`points` 是**扁平**列表，每项带 circle + id） */
  const packPairs = [
    { name: 'programming', pack: { points: [{ id: 'vue', circle: 'programming' }, { id: 'js-basics', circle: 'programming' }] } },
    { name: 'a,b', pack: { points: [{ id: 'x', circle: 'a' }, { id: 'x', circle: 'b' }] } },
    { name: 'empty', pack: { points: [] } },
  ]
  const refCases = [
    'vue', 'programming/vue', 'js-basics', 'a/x', 'b/x', 'x', 'nope', '', 'programming/nope', 'a/x/y',
    ...POINT_REF_STRICT.map((s) => s.ref).filter((r) => r !== 'a/x/y'),
  ]
  const parityRows = []
  const deltaRows = []
  const codes = new Set()
  for (const { name, pack } of packPairs) {
    for (const ref of refCases) {
      for (const halo of [undefined, 'programming', 'a']) {
        const before = oldPointRef.resolvePointRef({ pack, ref, halo })
        const after = pointRefModel.resolvePointRef({ pack, ref, halo })
        codes.add(after.ok ? `ok:${after.unverified === true ? 'unverified' : 'verified'}` : after.code)
        const strict = POINT_REF_STRICT.find((s) => s.ref === ref)
        if (name !== 'empty' || !strict) {
          parityRows.push({ pack: name, ref, halo: halo ?? null, same: JSON.stringify(before) === JSON.stringify(after) })
          continue
        }
        deltaRows.push({ pack: name, ref, halo: halo ?? null, kind: strict.kind, old: before, now: after })
        if (strict.kind === 'reject') {
          rows.push({
            ok: after.ok === false && after.code === 'unknown'
              && after.ref === ref && after.halo === (halo ?? null)
              && Array.isArray(after.candidates) && after.candidates.length === 0
              && typeof after.error === 'string' && after.error.length > 0,
            msg: `决-7 Δ · 无目录时 ${fmt(ref)}（halo=${fmt(halo ?? null)}）必须**拒绝**为 unknown 且不带候选（既有码值体系，无新码）：${strict.why}（实得 ${fmt(after)}）`,
          })
          rows.push({
            ok: before.ok === true,
            msg: `决-7 Δ 反空转 · 基线在 ${fmt(ref)} 上确实是「收下」的（否则这条 Δ 不存在）：实得 ${fmt(before)}`,
          })
        } else {
          rows.push({
            ok: after.ok === true && after.unverified === true
              && after.circle === strict.circle && after.id === strict.point && after.bare === strict.point
              && after.key === ref,
            msg: `决-7 Δ · 无目录时课次形状 ${fmt(ref)} 必须拆成知识点 ${fmt(`${strict.circle}/${strict.point}`)}（id/bare 不带课号，key 仍是原串）：${strict.why}（实得 ${fmt(after)}）`,
          })
          rows.push({
            ok: before.ok === true && before.id === `${strict.point}/${strict.segment}` && before.id !== strict.point,
            msg: `决-7 Δ 反空转 · 基线把 ${fmt(ref)} 拆成了点 id ${fmt(`${strict.point}/${strict.segment}`)}（错的，课号被塞进点 id），本卡改成 ${fmt(strict.point)}（实得 ${fmt(before)}）`,
          })
        }
      }
    }
  }
  const parityBad = parityRows.filter((r) => !r.same)
  rows.push({ ok: parityRows.length >= 80, msg: `对拍矩阵必须足够大（实得 ${parityRows.length} 例 + Δ ${deltaRows.length} 例）` })
  rows.push({ ok: parityBad.length === 0, msg: `有目录/未声明的输入上，resolvePointRef 的返回必须与基线**逐例相同**（不一致 ${parityBad.length} 例：${fmt(parityBad.slice(0, 3))}）` })
  rows.push({
    ok: deltaRows.length === POINT_REF_STRICT.length * 3,
    msg: `决-7 的 Δ 必须**恰好**落在声明的 ${POINT_REF_STRICT.length} 个输入 × 3 halo = ${POINT_REF_STRICT.length * 3} 例上（实得 ${deltaRows.length}）—— 多出来的就是没登记的语义改动`,
  })
  // 反空转：矩阵必须真的覆盖到"成功（已核验/未核验）、未知、歧义、缺引用"这些出口
  for (const need of ['missing-ref', 'unknown', 'ambiguous', 'ok:unverified', 'ok:verified']) {
    rows.push({ ok: codes.has(need), msg: `对拍矩阵必须覆盖 ${need} 这一种出口（实得 ${fmt([...codes])}）` })
  }
  record('A06.pointRef', {
    exports: Object.keys(pointRefModel).sort(),
    parity: { cases: parityRows.length, deltaCases: deltaRows.length, mismatches: parityBad },
    strictDeltas: deltaRows,
    strictTable: POINT_REF_STRICT,
    residue: refResidue.residue.map((h) => ({ line: h.line, pattern: h.pattern, classification: h.classification })),
    codes: [...codes],
  })

  // ⑦ 全仓扫描：**每个命中点都必须归到 §6 里有主的卡**（U09-Δ：归类 ≠ 归属）
  const scanSummary = scanIdentityImplementations()
  rows.push({ ok: scanSummary.scanned > 50 && scanSummary.kernelHits > 0, msg: `扫描必须真的扫到东西（${scanSummary.scanned} 个文件 / 内核命中 ${scanSummary.kernelHits}）` })
  rows.push({ ok: !scanSummary.deferred.includes(POINT_REF) && !scanSummary.deferred.includes(KERNEL) && !scanSummary.deferred.includes(HOST_MODEL), msg: '本卡收敛过的落点不许再出现在"无主/待他卡"清单里' })

  const rcForScan = requireReceipt()
  const blocks6 = parseSection6Blocks(readText(path.join(REPO, 'docs/unify/interfaces.md')))
  const paths6 = new Map([...blocks6].map(([card, b]) => [card, b.paths]))
  const owners6 = pathOwners(paths6)
  const pins = deferredPinsFromReceipt(rcForScan)
  const attrCtx = { cards: new Set(blocks6.keys()), owners: owners6, pins }
  const attr = attributeIdentityHits(scanSummary.hits, attrCtx)

  rows.push({ ok: attr.hitRows.length === scanSummary.hits.length, msg: `每一处命中点都必须过一遍归属判定（命中 ${scanSummary.hits.length} / 判定 ${attr.hitRows.length}）` })
  rows.push({
    ok: attr.failures.length === 0,
    msg: `每个身份命中点都必须能映射到 §6 里有主的卡（无法归因的仍红）：${fmt(attr.failures.slice(0, 4).map((f) => `${f.file}:${f.line ?? '*'} ${f.kind} ${f.problems.join('；')}`))}`,
  })

  /* ⑦c 钉子账（决-3）：deferredPins 只服务「§6 无主」的命中点。`lib/pack-export.js` 收编给 U16 之后，
   *   仓内一个无主命中点都没有 ⇒ 正确状态是**零条钉子**；还留着旧钉子（钉有主文件）就是账错，必须红。
   *   这条判据两边都能证伪：无主命中点多一处而钉子没跟上 ⇒ 红；有主文件还被钉 ⇒ 红。 */
  const deferredKeys = [...new Set(scanSummary.hits
    .filter((h) => h.kind === 'DEFERRED-OTHER-CARD')
    .map((h) => `${h.file}|${h.pattern}`))].sort()
  const pinKeys = [...pins.keys()].sort()
  rows.push({
    ok: JSON.stringify(pinKeys) === JSON.stringify(deferredKeys),
    msg: `回执的 deferredPins 必须**逐条等于**扫描里 §6 无主的命中点（决-3 之后应为空：lib/pack-export.js 已归 U16；钉子 ${fmt(pinKeys)} / 无主命中 ${fmt(deferredKeys)}）`,
  })
  rows.push({
    ok: !pinKeys.some((k) => k.startsWith('lib/pack-export.js|')),
    msg: 'lib/pack-export.js 在 §6 里归 U16（决-3 收编）⇒ 回执不许再把它当无主文件钉上限（钉子只钉无主文件）',
  })
  rows.push({
    ok: (owners6.get('lib/pack-export.js') ?? []).includes('U16') && !IDENTITY_SCAN_RULES['lib/pack-export.js'],
    msg: `决-3 的落账必须两边都对得上：§6 的 U16 行点名 lib/pack-export.js，且显式表里没有它（实得 §6 主 ${fmt(owners6.get('lib/pack-export.js') ?? [])} / 表里 ${IDENTITY_SCAN_RULES['lib/pack-export.js'] ? '有条目（错）' : '没有（对）'}）`,
  })
  rows.push({ ok: attr.pinRows.every((r) => r.ok), msg: `每一条钉子都不许被突破（上限）—— 实得 ${fmt(attr.pinRows.map((r) => `${r.file}|${r.pattern} ${r.observed}/${r.pinnedMax}`))}` })

  /* ⑦b 自动归属（U09-Δ2）必须**真的被用到**，而且要能指认主人：
   *   · 显式表里没有、§6 有主的那些文件（并发 lane 自己的写集，如 U16 的 `lib/mods/pack.js`；
   *     以及决-3 收编过来的 `lib/pack-export.js`）⇒ 归那张卡；
   *   · 自动归属的每一处都必须过与显式表**同一套**复核（责任卡真实存在 + §6 里确实拥有该文件）。
   * 反空转：这些行不是靠"往表里补一条"变绿的 —— 下面逐条断言表里仍然没有它们，归因只能来自 §6。 */
  rows.push({
    ok: scanSummary.autoAttributed.length > 0,
    msg: `必须至少有一处命中点是按"表里没有 ⇒ §6 运行时归属"归因的（实得 ${fmt(scanSummary.autoAttributed)}）—— 否则 Δ2 这一支是空转`,
  })
  for (const f of scanSummary.autoAttributed) {
    const rule = IDENTITY_SCAN_RULES[f]
    const own = owners6.get(f) ?? []
    const fileHits = attr.hitRows.filter((r) => r.file === f)
    rows.push({ ok: !rule, msg: `${f} 是自动归属：显式表里仍然**没有**它（不许靠往表里补条目来"修好"）` })
    rows.push({ ok: own.length === 1, msg: `自动归属要求 §6 里 ${f} **恰好一个**主（实得 ${fmt(own)}）—— 多主等于没主` })
    rows.push({
      ok: fileHits.length > 0 && fileHits.every((r) => r.ok === true && r.kind === 'OWNED-OTHER-CARD' && own.includes(r.owner)),
      msg: `${f} 的命中点必须全部归到 §6 里真正拥有它的卡（实得 ${fmt(fileHits.map((r) => `${r.line}:${r.kind}/${r.owner ?? '(无)'}[${r.attribution}]`))}）`,
    })
  }

  rows.push({
    ok: scanSummary.autoAttributed.includes('lib/pack-export.js'),
    msg: `决-3 的收编必须真的走"表里没有 ⇒ §6 自动归属"这一支（实得自动归属 ${fmt(scanSummary.autoAttributed)}）`,
  })

  // 归属口径：**运行时**从 §6 解析（不硬编码路径→卡），并断言 U18 确实拥有这两份
  const caliber = resolveIdentityOwnerCaliber(paths6)
  rows.push({
    ok: caliber.ok && caliber.caliber === 'section6',
    msg: `U18 的内核/宿主归属必须能**运行时**从 §6 解析出来（口径 ${caliber.caliber}）：${fmt(caliber.rows.map((r) => `${r.file} → ${r.owner ?? '(无)'} [${r.caliber}]`))}`,
  })
  for (const f of ['lib/state.js', 'lib/unify/evidence.cjs']) {
    const own = owners6.get(f) ?? []
    rows.push({ ok: own.includes('U18'), msg: `${f} 必须在 §6 里归 U18（实得 ${fmt(own)}）—— 这是本卡"可归因"而不是"白红"的根据` })
  }
  for (const h of scanSummary.hits.filter((x) => x.file === 'lib/state.js' || x.file === 'lib/unify/evidence.cjs')) {
    rows.push({ ok: attr.hitRows.find((r) => r.file === h.file && r.line === h.line)?.ok === true, msg: `U18 的合法身份消费必须归到 U18（${h.file}:${h.line} ${h.pattern}）` })
  }

  /* ⑧ 反空转：把 `lib/` + `tools/` **一次读进快照**，用同一份快照铺出副本树。
   *    为什么要快照：U16 正在自己的写集里改 `lib/mods/pack.js`；若"真仓扫描"与"副本扫描"之间
   *    文件被写一次，逐条对照就会假红。快照让两边来自**同一批字节**，变异也以它为缺省对照。 */
  const snapshot = identityTreeEntries(REPO)
  const copyRoot = path.join(RUN_TEMP, 'attr-copy')
  for (const { file, text } of snapshot) w(copyRoot, file, text)
  const hitKeys = (s) => s.hits.map((h) => `${h.file}:${h.line}:${h.pattern}`).sort()
  const snapScan = scanIdentityEntries(snapshot, owners6)
  const copyScan = scanIdentityImplementations(copyRoot, owners6)
  const copyAttr = attributeIdentityHits(copyScan.hits, attrCtx)
  rows.push({ ok: copyScan.scanned === snapshot.length, msg: `副本必须含快照里的每个文件（快照 ${snapshot.length} / 副本扫描 ${copyScan.scanned}）` })
  rows.push({ ok: JSON.stringify(hitKeys(copyScan)) === JSON.stringify(hitKeys(snapScan)), msg: '副本扫描必须与真仓（同一批字节的快照）逐条相同 —— 否则下面的变异没有对照' })
  rows.push({ ok: copyAttr.failures.length === 0, msg: `副本（未变异）必须与真仓同绿（实得 ${fmt(copyAttr.failures.slice(0, 3).map((f) => f.file))}）—— 变异前的对照` })

  // 变异①：往**无主**的新文件里塞一处身份拼接 → 必须红
  const mutantUnowned = path.join(copyRoot, 'lib', 'whatever.js')
  fs.writeFileSync(mutantUnowned, '// 变异：无主文件里的身份拼接\nexport const keyOf = (circle, point) => `${circle}/${point}`\n', 'utf8')
  const scanM1 = scanIdentityImplementations(copyRoot, owners6)
  const attrM1 = attributeIdentityHits(scanM1.hits, attrCtx)
  rows.push({
    ok: attrM1.failures.some((f) => f.file === 'lib/whatever.js'),
    msg: `无主文件里塞一处身份拼接必须红（实得 ${fmt(attrM1.failures.map((f) => `${f.file}:${f.kind}`))}）`,
  })
  rows.push({ ok: scanM1.hits.length === snapScan.hits.length + 1, msg: `变异①必须恰好加一处命中（实得 +${scanM1.hits.length - snapScan.hits.length}）` })
  fs.unlinkSync(mutantUnowned)

  /* 变异②（决-3 的反空转）：`lib/pack-export.js` 的"有主"必须**只**来自 §6 的 U16 那一行。
   *   做法：拿仓内 interfaces.md 的**文本副本**删掉 U16 行里的 `lib/pack-export.js` 令牌，重新解析
   *   归属 ⇒ 同一批字节必须重新判 `UNCLASSIFIED` 并红。这条证明收编是**文档落账**的结果，
   *   不是"往本文件的显式表里写死"（⑧ 之前已断言表里仍然没有它）。 */
  const lockAbs = path.join(REPO, 'docs', 'unify', 'interfaces.md')
  const lockText = readText(lockAbs)
  const u16Line = lockText.split('\n').find((l) => /^\|\s*U16\s*\|/.test(l)) || ''
  const exportToken = '`lib/pack-export.js`'
  rows.push({
    ok: u16Line.includes(exportToken),
    msg: `变异②的前置条件：§6 的 U16 行必须点名 ${exportToken}（决-3 收编的落账；实得 ${u16Line ? '有 U16 行' : '缺 U16 行'}）—— 前置不成立时下面两条没有对象`,
  })
  const lockMutated = lockText.replace(u16Line, u16Line.split(exportToken).join(''))
  const blocksMutated = parseSection6Blocks(lockMutated)
  const ownersNoToken = pathOwners(new Map([...blocksMutated].map(([card, b]) => [card, b.paths])))
  const scanM2 = scanIdentityEntries(snapshot, ownersNoToken)
  const attrM2 = attributeIdentityHits(scanM2.hits, { cards: new Set(blocksMutated.keys()), owners: ownersNoToken, pins })
  const m2Hit = scanM2.hits.find((h) => h.file === 'lib/pack-export.js')
  rows.push({
    ok: (ownersNoToken.get('lib/pack-export.js') ?? []).length === 0 && (owners6.get('lib/pack-export.js') ?? []).length === 1,
    msg: `变异②的前置条件：撤掉令牌后 §6 里该文件必须**无主**、且真仓 §6 里必须**恰好一个**主（实得 撤后 ${fmt(ownersNoToken.get('lib/pack-export.js') ?? [])} / 真仓 ${fmt(owners6.get('lib/pack-export.js') ?? [])}）`,
  })
  rows.push({
    ok: m2Hit && m2Hit.kind === 'UNCLASSIFIED' && m2Hit.attribution === 'none',
    msg: `变异②：撤掉 §6 的收编令牌后，lib/pack-export.js 的身份痕迹必须重新判 UNCLASSIFIED（实得 ${fmt(m2Hit && `${m2Hit.kind}[${m2Hit.attribution}]`)}）`,
  })
  rows.push({
    ok: attrM2.failures.some((f) => f.file === 'lib/pack-export.js' && /未归类/.test(f.problems.join('；'))),
    msg: `变异②：撤掉收编令牌后归属判定必须红（证明"有主"来自 §6 的 U16 行；实得 ${fmt(attrM2.failures.map((f) => `${f.file}:${f.kind}`))}）`,
  })
  rows.push({
    ok: attrM2.failures.length > attr.failures.length,
    msg: `变异②必须让归因结果**变差**（收紧变化被抓住；实得 变异后 ${attrM2.failures.length} 条 / 之前 ${attr.failures.length} 条）`,
  })

  /* 变异②b（钉子上限仍咬人，纯函数证明）：决-3 把仓内的钉子清空了，但"§6 无主文件按上限钉"这个
   *   机制不能因此变成摆设。拿一个 §6 **真无主**的既有文件做靶子，在副本里塞 3 处同形拼接，
   *   把这 3 处按「无主文件的命中点」记账：上限 2 ⇒ 必须按「上限」红；上限放到 3 ⇒ 必须不再报上限。
   *   计数口径是 文件+痕迹（不是行号）—— 所以这一条同时证明"多冒一处即红"仍然成立。 */
  const pinTarget = 'lib/pack-server.js'
  const pinAbs = path.join(copyRoot, pinTarget)
  rows.push({ ok: fs.existsSync(pinAbs), msg: `变异②b 的靶子必须存在（${pinTarget}）` })
  rows.push({
    ok: (owners6.get(pinTarget) ?? []).length === 0 && !IDENTITY_SCAN_RULES[pinTarget],
    msg: `变异②b 的前置条件：${pinTarget} 在 §6 里**无主**且显式表里没有（实得 §6 主 ${fmt(owners6.get(pinTarget) ?? [])}）`,
  })
  const pinBefore = readText(pinAbs)
  fs.writeFileSync(pinAbs, pinBefore
    + '\n// 变异②b：钉子上限的靶子\nexport const pin1 = (circle, point) => `${circle}/${point}`\nexport const pin2 = (circle, point) => `${circle}/${point}`\nexport const pin3 = (circle, point) => `${circle}/${point}`\n', 'utf8')
  const pinHits = scanIdentityImplementations(copyRoot, owners6).hits
    .filter((h) => h.file === pinTarget)
    .map((h) => ({ ...h, kind: 'DEFERRED-OTHER-CARD', owner: null }))
  const pinCtx = (max) => ({ cards: new Set(blocks6.keys()), owners: owners6, pins: new Map([[`${pinTarget}|template-circle-point`, max]]) })
  const attrPin2 = attributeIdentityHits(pinHits, pinCtx(2))
  const attrPin3 = attributeIdentityHits(pinHits, pinCtx(3))
  rows.push({ ok: pinHits.length === 3, msg: `变异②b：靶子必须恰好 3 处同形命中（实得 ${pinHits.length}）` })
  rows.push({
    ok: attrPin2.failures.some((f) => f.kind === 'PIN' && /上限/.test(f.problems.join('；'))),
    msg: `变异②b：无主文件 3 处 > 钉住上限 2 ⇒ 必须按「上限」红（实得 ${fmt(attrPin2.failures.map((f) => `${f.kind}:${f.problems.join('；')}`))}）`,
  })
  rows.push({
    ok: attrPin3.failures.every((f) => f.kind !== 'PIN'),
    msg: `变异②b：上限放到 3 ⇒ 钉子不再报上限（证明计的是命中数，不是"有钉子就红"；实得 ${fmt(attrPin3.failures.map((f) => `${f.kind}:${f.problems.join('；')}`))}）`,
  })
  fs.writeFileSync(pinAbs, pinBefore, 'utf8')

  // 变异③：把一处命中点归给一张 §6 里**并不拥有该文件**的卡 → 必须红（可归因 ≠ 随便归）
  const forged = scanSummary.hits.map((h) => (h.file === 'lib/state.js' ? { ...h, owner: 'U16' } : h))
  const attrM3 = attributeIdentityHits(forged, attrCtx)
  rows.push({
    ok: attrM3.failures.some((f) => f.file === 'lib/state.js' && /并不拥有/.test(f.problems.join('；'))),
    msg: `把命中点归给 §6 里并不拥有它的卡必须红（实得 ${fmt(attrM3.failures.map((f) => `${f.file}:${f.problems.join('；')}`))}）`,
  })

  /* 变异④（U09-Δ2 的反空转）：往**§6 无主**、且显式表里也没有的既有文件里塞一处身份构造
   *   → 自动归属必须仍判 `UNCLASSIFIED` 并红（证明"表里没有就按 §6 自动归属"没有变成"一律放行"）。 */
  const unownedTarget = 'lib/pack-server.js'
  const unownedAbs = path.join(copyRoot, unownedTarget)
  rows.push({ ok: fs.existsSync(unownedAbs), msg: `变异④的靶子必须存在（${unownedTarget}）` })
  rows.push({
    ok: (owners6.get(unownedTarget) ?? []).length === 0 && !IDENTITY_SCAN_RULES[unownedTarget],
    msg: `变异④的前置条件：${unownedTarget} 在 §6 里**无主**且显式表里没有（实得 §6 主 ${fmt(owners6.get(unownedTarget) ?? [])}）—— 前置不成立时换一个靶子，不许静默放行`,
  })
  const unownedBefore = readText(unownedAbs)
  fs.writeFileSync(unownedAbs, unownedBefore + '\n// 变异：§6 无主、表里也没有的文件里塞一处身份构造\nexport const orphanKeyOf = (circle, point) => `${circle}/${point}`\n', 'utf8')
  const scanM4 = scanIdentityImplementations(copyRoot, owners6)
  const attrM4 = attributeIdentityHits(scanM4.hits, attrCtx)
  const m4Hit = scanM4.hits.find((h) => h.file === unownedTarget)
  rows.push({
    ok: m4Hit && m4Hit.kind === 'UNCLASSIFIED' && m4Hit.attribution === 'none',
    msg: `§6 无主 + 表里没有 ⇒ 必须仍判 UNCLASSIFIED（不许被自动归属放行；实得 ${fmt(m4Hit && `${m4Hit.kind}[${m4Hit.attribution}]`)}）`,
  })
  rows.push({
    ok: attrM4.failures.some((f) => f.file === unownedTarget && /未归类/.test(f.problems.join('；'))),
    msg: `§6 无主的 ${unownedTarget} 里塞一处身份构造必须红（实得 ${fmt(attrM4.failures.map((f) => `${f.file}:${f.kind}`))}）`,
  })
  fs.writeFileSync(unownedAbs, unownedBefore, 'utf8')
  rows.push({ ok: sha256(fs.readFileSync(unownedAbs)) === sha256(Buffer.from(unownedBefore, 'utf8')), msg: `变异④必须被还原（副本里的 ${unownedTarget} 与快照逐字节相同）` })
  rows.push({ ok: sha256(fs.readFileSync(path.join(REPO, unownedTarget))) === sha256(headBytes(unownedTarget)), msg: `仓内 ${unownedTarget} 不许被本卡写（与基线逐字节相同）` })

  /* 变异⑤（决-7 的反空转）：把 `lib/point-ref.js` 在副本里**还原成基线版本**（在第一个 `/` 处自拆）
   *   → 「解析痕迹必须为 0」「归类是 OWNED-OTHER-CARD/U09」「不再有 BLOCKED-BOUNDARY」这几条判据
   *   必须真的红。这一条保证「全仓只剩一份身份解析」不是白得的：谁把自拆抄回来，A06 立刻红。 */
  const refCopyAbs = path.join(copyRoot, POINT_REF)
  const refCopyBefore = readText(refCopyAbs)
  fs.writeFileSync(refCopyAbs, headBytes(POINT_REF))
  const scanM5 = scanIdentityImplementations(copyRoot, owners6)
  const m5 = judgePointRefResidue(scanM5.hits, classifyIdentityFile(POINT_REF, owners6))
  const m5Split = m5.residue.filter((h) => h.pattern === 'indexof-slash')
  rows.push({
    ok: m5.ok === false && m5Split.length === 1,
    msg: `变异⑤：把基线（indexOf('/') 自拆）抄回副本后，同一份判据必须红，且重新扫出**恰好一处**解析残留（实得 ok=${m5.ok} / 残留 ${fmt(m5.residue.map((h) => `${h.line}:${h.pattern}`))}）`,
  })
  fs.writeFileSync(refCopyAbs, refCopyBefore, 'utf8')
  const m5Back = judgePointRefResidue(scanIdentityImplementations(copyRoot, owners6).hits, classifyIdentityFile(POINT_REF, owners6))
  rows.push({ ok: m5Back.ok === true, msg: '变异⑤必须被还原（副本回到收敛版后判据重新变绿）' })
  rows.push({ ok: sha256(fs.readFileSync(refCopyAbs)) === sha256(fs.readFileSync(path.join(REPO, POINT_REF))), msg: '副本里的 lib/point-ref.js 必须与真仓逐字节相同（变异⑤不留残留）' })

  // 副本必须被还原成与真仓逐字节一致（不留变异残留）
  const exportFile = path.join(copyRoot, 'lib', 'pack-export.js')
  rows.push({ ok: sha256(fs.readFileSync(exportFile)) === sha256(fs.readFileSync(path.join(REPO, 'lib', 'pack-export.js'))), msg: '副本里的 lib/pack-export.js 必须与真仓逐字节相同（变异②只改 §6 文本，不写文件）' })
  // 决-3 收编之后：`lib/pack-export.js` 有了主（U16），本卡**仍然**不碰它。判据从"与基线逐字节相同"
  // （收编后已不是事实：U16 会改它）换成三条更准确的：不在本卡写集 / 本进程没写它 / 改动可归属 U16。
  rows.push({ ok: !WRITE_SET.includes('lib/pack-export.js'), msg: 'lib/pack-export.js 不在本卡写集（决-3 收编给 U16，不是 U09）' })
  rows.push({
    ok: sweepWriteGuard().writes.filter((x) => x.target === path.resolve(REPO, 'lib', 'pack-export.js')).length === 0,
    msg: '本卡本次进程不许写 lib/pack-export.js（它在 §6 里归 U16）',
  })
  rows.push({
    ok: (owners6.get('lib/pack-export.js') ?? []).includes('U16'),
    msg: `lib/pack-export.js 的改动必须能归属到 §6 里的 U16（实得 ${fmt(owners6.get('lib/pack-export.js') ?? [])}）`,
  })
  // 反空转（卡外被改仍红）：把 §6 并集里的收编落点撤掉 ⇒ 同一个 tracked 改动必须重新越界。
  {
    const pathsNoToken = new Map([...paths6].map(([card, ps]) => [card, card === 'U16' ? ps.filter((p) => p !== 'lib/pack-export.js') : ps]))
    const withToken = classifyTrackedWrites(splitPorcelainTracked([' M lib/pack-export.js']).tracked, authorizedUnion(paths6))
    const withoutToken = classifyTrackedWrites(splitPorcelainTracked([' M lib/pack-export.js']).tracked, authorizedUnion(pathsNoToken))
    rows.push({ ok: withToken.outOfBounds.length === 0, msg: 'M lib/pack-export.js 在 §6 有收编落点时放行（依据 U16 那一行）' })
    rows.push({ ok: withoutToken.outOfBounds.some((v) => v.path === 'lib/pack-export.js'), msg: '撤掉 §6 的收编落点后，M lib/pack-export.js 必须重新越界（卡外被改仍红）' })
  }

  record('A06.scan', {
    scanned: scanSummary.scanned,
    hits: attr.hitRows.map((r) => ({ file: r.file, line: r.line, pattern: r.pattern, kind: r.kind, owner: r.owner, attribution: r.attribution, section6Owners: r.section6Owners, ok: r.ok })),
    pins: attr.pinRows,
    pinBookkeeping: { pins: pinKeys, deferred: deferredKeys },
    caliber,
    autoAttributed: scanSummary.autoAttributed,
    mutants: {
      copyFaithful: JSON.stringify(hitKeys(copyScan)) === JSON.stringify(hitKeys(snapScan)),
      unownedFile: attrM1.failures.map((f) => ({ file: f.file, line: f.line, problems: f.problems })),
      unownedExtraHit: attrM2.failures.map((f) => ({ file: f.file, pattern: f.pattern, problems: f.problems })),
      forgedOwner: attrM3.failures.map((f) => ({ file: f.file, line: f.line, problems: f.problems })),
      section6UnownedNewHit: { target: unownedTarget, kind: m4Hit?.kind ?? null, failures: attrM4.failures.map((f) => ({ file: f.file, line: f.line, problems: f.problems })) },
      pointRefSelfSplit: { ok: m5.ok, residue: m5.residue.map((h) => ({ line: h.line, pattern: h.pattern, classification: h.classification })) },
      pinUpperBound: {
        target: pinTarget,
        hits: pinHits.length,
        pinned2: attrPin2.failures.map((f) => ({ kind: f.kind, observed: f.observed, pinnedMax: f.pinnedMax, problems: f.problems })),
        pinned3: attrPin3.failures.map((f) => ({ kind: f.kind, problems: f.problems })),
      },
    },
  })

  record('A06', {
    kernel: { path: KERNEL, bytes: fs.statSync(path.join(REPO, KERNEL)).size, sha16: sha256(fs.readFileSync(path.join(REPO, KERNEL))).slice(0, 16) },
    copies: ['pack.cjs', 'identity.cjs'].map((f) => ({ file: `tools/unify/${f}`, sha16: sha256(fs.readFileSync(path.join(pack, 'tools', 'unify', f))).slice(0, 16) })),
    keys: Object.keys(hostIdx.byKey),
  })
  assertAll(rows, 'A06.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 临时恢复裸点索引后判据必须红（E:\Temp 变异副本）
 * ══════════════════════════════════════════════════════════════════════ */

async function A07() {
  const rows = []
  const repoKernelBefore = sha256(fs.readFileSync(path.join(REPO, KERNEL)))
  const repoModelBefore = sha256(fs.readFileSync(path.join(REPO, HOST_MODEL)))
  const mutantDir = path.join(RUN_TEMP, 'mutant')
  const mutantKernel = path.join(mutantDir, 'unify', 'pack.cjs')
  fs.mkdirSync(path.join(mutantDir, 'unify'), { recursive: true })
  const src = readText(path.join(REPO, KERNEL))

  // **变异**：把规范课次键换回"裸点索引"（`point/NNNN`，没有圆圈）—— 这就是本卡修掉的旧形状。
  const from = '      canon = identity.lessonKey(circle, en.point, Number(en.number))'
  const to = '      canon = `${en.point}/${String(Number(en.number)).padStart(4, \'0\')}` // 变异：裸点索引（没有圆圈）'
  const occurrences = src.split(from).length - 1
  rows.push({ ok: occurrences === 1, msg: `变异锚点必须在内核里恰好出现一次（实得 ${occurrences}）—— 否则变异没生效、判据成了空转` })
  assert(occurrences === 1, 'A07 无法施加变异：找不到唯一的变异锚点（内核被改过？）')
  fs.writeFileSync(mutantKernel, src.replace(from, to), 'utf8')
  fs.copyFileSync(path.join(REPO, 'lib/unify/identity.cjs'), path.join(mutantDir, 'unify', 'identity.cjs'))

  // 变异内核：同样的判据必须红（用**同一份**判据函数，不是另写一套弱检查）
  const mutant = require_(mutantKernel)
  const crossRoot = fixtureCrossCircle(path.join(RUN_TEMP, 'fx-a07-cross'))
  const legacyRoot = fixtureLegacyProgress(path.join(RUN_TEMP, 'fx-a07-legacy'))
  const mutCross = judgeCrossCircle(mutant, crossRoot)
  const mutProg = judgeProgress(mutant, legacyRoot)
  const realCross = judgeCrossCircle(core(), crossRoot)
  const realProg = judgeProgress(core(), legacyRoot)

  rows.push({ ok: realCross.problems.length === 0, msg: '真内核在跨圈判据上是绿的（变异前的对照）' })
  rows.push({ ok: realProg.problems.length === 0, msg: '真内核在进度判据上是绿的（变异前的对照）' })
  rows.push({ ok: mutCross.problems.length > 0, msg: `变异内核必须让跨圈判据变红（实得 problems=${fmt(mutCross.problems)}）` })
  rows.push({ ok: mutProg.problems.length > 0, msg: `变异内核必须让进度判据变红（实得 problems=${fmt(mutProg.problems)}）` })
  rows.push({ ok: mutCross.keys.some((k) => /^[^/]+\/\d{4}$/.test(k)) || mutCross.keys.length !== 2, msg: `变异确实把键改回了裸点形状（实得 ${fmt(mutCross.keys)}）` })

  // 仓内内核 / 宿主适配层一个字节都不许被变异影响
  rows.push({ ok: sha256(fs.readFileSync(path.join(REPO, KERNEL))) === repoKernelBefore, msg: '仓内权威内核不许被变异影响' })
  rows.push({ ok: sha256(fs.readFileSync(path.join(REPO, HOST_MODEL))) === repoModelBefore, msg: '宿主适配层不许被变异影响' })
  // 仓内模板副本目录：**存在也是合法的**（U19 收口之后的状态）。
  //   ⚠️ 决-9 连带（副本出现后口径过期）：原判据是"必须不存在"，它判的是"生成件只归 U19、
  //   本卡不越界"。U19 落盘之后"不存在"不再是事实，改判**两件更要紧的事**：
  //   ① 若存在，它必须是 `lib/unify/*.cjs` 的**逐字节生成副本**（14 件齐全、无 migration.cjs、
  //      逐字节相同）—— 本卡越界"手写一份副本"会在逐字节对拍上露馅；
  //   ② 本次运行**没有**写过它（写守卫，见 A08）。判据不降，且不再依赖"目录不存在"这个过时事实。
  {
    const mirrorDir = path.join(REPO, 'lib', 'pack-template', 'tools', 'unify')
    const authDir = path.join(REPO, 'lib', 'unify')
    if (!fs.existsSync(mirrorDir)) {
      rows.push({ ok: true, msg: '仓内 lib/pack-template/tools/unify 不存在（U19 生成之前的合法中间态）' })
    } else {
      const names = fs.readdirSync(mirrorDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
      const authNames = fs.readdirSync(authDir).filter((n) => n.endsWith('.cjs') && n !== 'migration.cjs').sort()
      const missing = authNames.filter((n) => !names.includes(n))
      const extra = names.filter((n) => !authNames.includes(n))
      const sameBytes = missing.length === 0 && extra.length === 0
        && authNames.every((n) => fs.readFileSync(path.join(mirrorDir, n)).equals(fs.readFileSync(path.join(authDir, n))))
      rows.push({ ok: sameBytes, msg: `仓内 lib/pack-template/tools/unify 若存在，必须是 U19 逐字节生成的副本（缺 ${fmt(missing)} / 多 ${fmt(extra)}；逐字节对拍 ${sameBytes ? '通过' : '失败'}）` })
      rows.push({ ok: !names.includes('migration.cjs'), msg: 'migration.cjs 不许出现在随包副本目录里（迁移专用件不随包，只归显式 CLI）' })
    }
  }

  record('A07', {
    mutation: { file: 'unify/pack.cjs（本轮临时副本）', from, to, occurrences },
    real: { cross: realCross.problems, progress: realProg.problems },
    mutant: { cross: mutCross.problems, progress: mutProg.problems, keys: mutCross.keys },
  })
  assertAll(rows, 'A07.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · §12 A 授权与同卡测试差异逐项对应；catalog 构造结果保持；证据与范围守卫
 * ══════════════════════════════════════════════════════════════════════ */

/** 逐行解析 `git diff -U0` 的 hunk（纯函数；喂文本，不读盘） */
export function parseZeroContextDiff(text) {
  const hunks = []
  let cur = null
  for (const raw of String(text).split('\n')) {
    if (/^@@/.test(raw)) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
      cur = {
        oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]),
        removed: [], added: [],
      }
      hunks.push(cur)
      continue
    }
    if (!cur) continue
    if (raw.startsWith('---') || raw.startsWith('+++')) continue
    if (raw.startsWith('-')) cur.removed.push(raw.slice(1))
    else if (raw.startsWith('+')) cur.added.push(raw.slice(1))
  }
  return hunks
}

/** 一条断言行的指纹（只比"断言本身"，不比缩进空白） */
export const okLineKey = (line) => line.trim()

async function A08() {
  const rows = []

  /* ① §12 A 授权：逐字引用 + 只按 scope.A 执行（与 authorization.json 对拍） */
  const authPath = path.join(REPO, 'docs/unify/authorization.json')
  assert(fs.existsSync(authPath), 'A08 · 缺 docs/unify/authorization.json（§12 A 的书面授权）')
  const auth = JSON.parse(readText(authPath))
  const face = parseAuthorizationFace(auth)
  rows.push({ ok: face.ok === true, msg: `authorization.json 的 scope.A 必须授权 ${MIRROR}（实得 allowed=${fmt(face.allowed)}）` })
  rows.push({ ok: face.notAuthorized.includes('test/intake.mjs'), msg: 'authorization.json 里必须有 test/intake.mjs，且它属于 U10 的 A 面（对 U09 不授权）' })
  eq(auth.quoteVerbatim, '选A和授权p1和p2', 'A08 · 人类授权原文必须逐字是「选A和授权p1和p2」')

  /* ①b tracked 回执（后面 ⑥ 的授权并集要用它登记的写集扩张） */
  const rcPath = path.join(REPO, RECEIPT)
  assert(fs.existsSync(rcPath), `A08 · 缺 tracked 回执 ${RECEIPT}`)
  let rc = null
  try {
    rc = require_(rcPath)
  } catch (e) {
    throw new Error(`A08 · 回执不是合法 JSON（require 失败）：${e.message}`)
  }

  /* ①c **A 面契约**（U09-Δ 新口径）：三条同时成立才算本卡的 §12 A 授权面
   *    ① §6 里本卡单元格中"点名它的那一段"带「仅 §12 A 授权面」限定语
   *    ② authorization.json 的 scope.A 里本卡自己的条目**逐字点名**它
   *    ③ authorization.json 的 quoteVerbatim（人类授权原文）存在且非空
   * 缺一条即红；红样本（§6 无主 + scope.A 不点名的既有测试）必须被判"不算 A 面"（可证伪）。 */
  const lockTextForFace = readText(path.join(REPO, 'docs/unify/interfaces.md'))
  const blocks6 = parseSection6Blocks(lockTextForFace)
  const contract = proveAFaceContract({ subject: MIRROR, blocks: blocks6, authDoc: auth, cards: ['U09', 'U10'] })
  for (const r of contract.rows.filter((x) => x.card === 'U09')) {
    rows.push({ ok: r.ok, msg: `A 面契约 · ${r.card} · ${r.check}：${r.why}` })
  }
  rows.push({
    ok: contract.byCard.get('U09').ok === true && contract.byCard.get('U09').failing.length === 0,
    msg: `${MIRROR} 必须同时满足 A 面契约三条才算本卡的 §12 A 授权面（实得缺 ${fmt(contract.byCard.get('U09').failing)}）`,
  })
  rows.push({ ok: contract.byCard.get('U10').ok === false, msg: `${MIRROR} **不是** U10 的 A 面（U10 的 A 面是 test/intake.mjs；实得 ${fmt(contract.byCard.get('U10').failing)}）` })
  const intakeContract = proveAFaceContract({ subject: 'test/intake.mjs', blocks: blocks6, authDoc: auth, cards: ['U09', 'U10'] })
  rows.push({
    ok: intakeContract.byCard.get('U10').ok === true && intakeContract.byCard.get('U09').ok === false,
    msg: `test/intake.mjs 的 A 面归 U10（三条齐），且**不**归本卡（U09 缺 ${fmt(intakeContract.byCard.get('U09').failing)}）—— 这就是它必须被并集放行的根据`,
  })
  // 红样本对照：契约必须能"说不"（两个既有测试：`test/pack-template-rules.mjs` 在 §6 里无主；
  // `test/audit/T26.mjs` 在 §6 里归 U01 但限定语是「仅 P1/P2 授权面」—— 两者都**不是** §12 A 面）
  for (const redSubject of ['test/pack-template-rules.mjs', 'test/audit/T26.mjs']) {
    const ctrl = proveAFaceContract({ subject: redSubject, blocks: blocks6, authDoc: auth, cards: ['U09', 'U10'] })
    const failing = [...new Set(ctrl.rows.filter((r) => !r.ok).map((r) => r.check))].sort()
    rows.push({
      ok: ctrl.ok === false && contract.byCard.get('U09').ok === true && JSON.stringify(failing) === JSON.stringify(['scope-a-verbatim', 'section6-qualifier']),
      msg: `红样本对照：${redSubject} 三条里必须恰好缺「限定语 + scope.A 逐字点名」（实得缺 ${fmt(failing)}）—— 否则 A 面契约是空转`,
    })
  }

  /* ①d 反空转：把 §6 / authorization.json 的**副本**改坏，同一份纯函数必须变红 */
  const mutantsDir = path.join(RUN_TEMP, 'afce-mutants')
  fs.mkdirSync(mutantsDir, { recursive: true })

  // 变异①：抹掉 §6 的 A 面限定语（限定语在 §6 里恰好出现 2 次：U09 + U10）
  const qualifierCount = lockTextForFace.split(FACE_QUALIFIER).length - 1
  rows.push({ ok: qualifierCount === 2, msg: `变异锚点必须成立：§6 里「${FACE_QUALIFIER}」恰好出现 2 次（U09 的 mirror-parity + U10 的 intake；实得 ${qualifierCount}）` })
  const s6NoQualifier = lockTextForFace.split(FACE_QUALIFIER).join('（A 面语义说明）')
  const s6MutantFile = path.join(mutantsDir, 'interfaces-no-qualifier.md')
  fs.writeFileSync(s6MutantFile, s6NoQualifier, 'utf8')
  const cM1 = proveAFaceContract({ subject: MIRROR, blocks: parseSection6Blocks(readText(s6MutantFile)), authDoc: auth, cards: ['U09'] })
  rows.push({
    ok: JSON.stringify(cM1.byCard.get('U09').failing) === JSON.stringify(['section6-qualifier']),
    msg: `抹掉 §6 的限定语后 A 面契约必须红（且只缺限定语；实得 ${fmt(cM1.byCard.get('U09').failing)}）`,
  })
  // 纯函数再证一次（不经过文件）：同一个替换直接喂给 blocks
  const cM1b = proveAFaceContract({ subject: MIRROR, blocks: parseSection6Blocks(s6NoQualifier), authDoc: auth, cards: ['U09'] })
  rows.push({ ok: cM1b.byCard.get('U09').ok === false, msg: '纯函数口径下抹掉限定语同样必须红（不依赖落盘副本）' })

  // 变异②：authorization.json 缺 quoteVerbatim
  const authNoQuote = { ...auth }
  delete authNoQuote.quoteVerbatim
  const authMutantFile = path.join(mutantsDir, 'authorization-no-quote.json')
  fs.writeFileSync(authMutantFile, JSON.stringify(authNoQuote, null, 2) + '\n', 'utf8')
  const cM2 = proveAFaceContract({ subject: MIRROR, blocks: blocks6, authDoc: JSON.parse(readText(authMutantFile)), cards: ['U09'] })
  rows.push({
    ok: JSON.stringify(cM2.byCard.get('U09').failing) === JSON.stringify(['quote-verbatim']),
    msg: `authorization.json 缺 quoteVerbatim 后 A 面契约必须红（且只缺授权原文；实得 ${fmt(cM2.byCard.get('U09').failing)}）`,
  })

  // 变异③：scope.A 里 U09 的那条不再逐字点名 mirror-parity
  const authNoName = JSON.parse(JSON.stringify(auth))
  authNoName.scope.A.authorized = authNoName.scope.A.authorized.map((item) =>
    (String(item).startsWith('U09') ? String(item).split(MIRROR).join('那个镜像测试') : item))
  const cM3 = proveAFaceContract({ subject: MIRROR, blocks: blocks6, authDoc: authNoName, cards: ['U09'] })
  rows.push({
    ok: JSON.stringify(cM3.byCard.get('U09').failing) === JSON.stringify(['scope-a-verbatim']),
    msg: `scope.A 不再逐字点名 ${MIRROR} 后 A 面契约必须红（且只缺逐字点名；实得 ${fmt(cM3.byCard.get('U09').failing)}）`,
  })
  record('A08.faceContract', {
    subject: MIRROR,
    rows: contract.rows.map((r) => ({ check: r.check, card: r.card, ok: r.ok, why: r.why })),
    byCard: [...contract.byCard.values()],
    intake: [...intakeContract.byCard.values()],
    mutants: {
      section6QualifierStripped: cM1.byCard.get('U09').failing,
      quoteVerbatimMissing: cM2.byCard.get('U09').failing,
      scopeANotNaming: cM3.byCard.get('U09').failing,
      qualifierOccurrences: qualifierCount,
    },
  })

  /* ② 本卡 A 面 Δ：mirror-parity 只动"课程身份所需的夹具输入 + 那一行旧身份预期 + 说明"；
   *    另有 **P2 授权面**（scope.P2 点名该文件 446–456 行一带的 PROBE_VERSION 断言）—— 现场解析，
   *    只把那几行从 `ok(` 逐字比对里排除并单独登记，其余 `ok(` 仍必须逐字不变。 */
  const mirrorOld = headBytes(MIRROR).toString('utf8')
  const mirrorNew = readText(path.join(REPO, MIRROR))
  assert(mirrorOld !== mirrorNew, 'A08 · test/mirror-parity.mjs 必须真的被改过（A 面）')
  const diff = gitRead(['diff', '-U0', '--', MIRROR])
  const hunks = parseZeroContextDiff(diff)

  /* ②a **P2 授权面**：从 authorization.json 现场解析（不缓存、不抄写、不硬编码行号） */
  const p2 = parseAuthorizationP2(auth, MIRROR)
  rows.push({ ok: p2.present === true, msg: `authorization.json 必须有 scope.P2（P2 授权面是独立登记面，不是本卡的 §12 A）` })
  rows.push({ ok: p2.ok === true, msg: `scope.P2 必须成立（逐字点名 ${MIRROR} + 旧行窗口 + 非空 quoteVerbatim）：${p2.why}` })
  rows.push({ ok: p2.quoteVerbatim === '选A和授权p1和p2', msg: `P2 授权面引用的授权原文必须逐字是「选A和授权p1和p2」（实得 ${fmt(p2.quoteVerbatim)}）` })

  /* ②a-2 §6 ↔ scope.P2 必须**双向**对得上（与 A 面契约同形）：§6 里带「仅 P1/P2 授权面」限定语
   * 的那一段点名的路径，必须逐条被 scope.P2 的 `authorized` 点名；反过来 scope.P2 点名的测试在 §6
   * 里必须也有对应落点。任一侧悬空 ⇒ 红（P2 不是"文档里没说、判据里却认"的通行证）。 */
  const s6P2 = section6P2Paths(blocks6)
  const s6P2Paths = [...new Set([...s6P2.values()].flat())].sort()
  rows.push({
    ok: s6P2Paths.length > 0,
    msg: `§6 里必须有带「${P2_FACE_QUALIFIER}」限定语的落点段（实得 ${fmt(s6P2Paths)}）—— 否则 P2 授权面在接口锁里没有落点`,
  })
  for (const p of s6P2Paths) {
    rows.push({ ok: (p2.paths || []).includes(p), msg: `§6 的「${P2_FACE_QUALIFIER}」段点名 ${p} ⇒ scope.P2.authorized 必须逐字点名它（实得 ${fmt(p2.paths)}）` })
  }
  for (const p of (p2.ok ? p2.paths : []).filter((x) => x !== MIRROR)) {
    rows.push({ ok: s6P2Paths.includes(p), msg: `scope.P2 点名的 ${p} 必须在 §6 里也有「${P2_FACE_QUALIFIER}」落点（实得 ${fmt(s6P2Paths)}）—— 授权面不许悬空` })
  }
  rows.push({ ok: s6P2Paths.includes('test/audit/T26.mjs'), msg: `§6 必须给 T26 那处 P2 授权面挂上限定语（实得 ${fmt(s6P2Paths)}）` })

  /* ②b `ok(` 差异必须**恰好**落在两个授权面上（§12 A 那一行 + P2 的 PROBE_VERSION 断言） */
  const okLines = (text) => String(text).split('\n').filter((l) => /\bok\(/.test(l)).map(okLineKey)
  const oldOk = okLines(mirrorOld)
  const newOk = okLines(mirrorNew)
  const delta = judgeMirrorOkDelta({ hunks, oldOk, newOk, p2 })
  const removed = delta.u09.flatMap((x) => x.removed)
  const added = delta.u09.flatMap((x) => x.added)
  rows.push({ ok: removed.length === 1, msg: `A 面只许改**一条** \`ok(\` 断言（实得 ${removed.length} 条）` })
  rows.push({ ok: added.length === 1, msg: `A 面只许新增**一条** \`ok(\` 断言（实得 ${added.length} 条）` })
  rows.push({ ok: /a\.anchor/.test(removed[0] || '') && /b\.anchor/.test(removed[0] || ''), msg: '被改的那一行必须是旧身份预期行（a.anchor / b.anchor）' })
  rows.push({ ok: /programming\/spring-boot\/0001/.test(added[0] || ''), msg: '新的预期必须是规范课次键 programming/spring-boot/0001' })
  rows.push({ ok: !/(?<!\/)spring-boot\/0001/.test((added[0] || '').replace(/programming\/spring-boot\/0001/g, 'PROGRAMMING')), msg: '新预期行里不许残留两段课键 spring-boot/0001' })

  // 排除面**单独登记**：必须真的排除了行，且排除面与 scope.P2 的文本对得上（对不上就红）
  const p2Excluded = [...delta.p2Face.flatMap((x) => x.removed), ...delta.p2Face.flatMap((x) => x.added)]
  rows.push({
    ok: delta.p2Face.length >= 1 && delta.p2Counts.removed + delta.p2Counts.added > 0,
    msg: `P2 授权面必须**确实**排除了行（P2 面被排除 删 ${delta.p2Counts.removed} / 增 ${delta.p2Counts.added}，hunk ${fmt(delta.p2Face.map((x) => x.hunk))}；连同本卡 A 面的 1/1 共 删 ${delta.excludedCounts.removed} / 增 ${delta.excludedCounts.added}）—— 否则"排除"是空转`,
  })
  rows.push({
    ok: delta.p2Face.every((x) => p2.window && x.window === `${p2.window.start}–${p2.window.end}`),
    msg: `被排除的每个 hunk 都必须落在 scope.P2 声明的旧行窗口 ${p2.window ? `${p2.window.start}–${p2.window.end} ±${P2_LINE_TOLERANCE}` : '(无)'} 内（实得 ${fmt(delta.p2Face.map((x) => `${x.hunk}@${x.window}`))}）`,
  })
  rows.push({
    ok: p2Excluded.some((l) => /PROBE_VERSION/.test(l)),
    msg: `排除面必须与 scope.P2 的文本对得上：被排除的 \`ok(\` 里必须有 PROBE_VERSION 断言（实得 ${p2Excluded.filter((l) => /PROBE_VERSION/.test(l)).length} 条带 PROBE_VERSION）`,
  })
  rows.push({
    ok: delta.ok === true,
    msg: `除 §12 A 那一行旧身份预期与 scope.P2 授权的 PROBE_VERSION 断言外，**所有** \`ok(\` 断言必须逐字不变（删/放宽/跳过任何一条都不行）：${delta.why}`,
  })
  rows.push({
    ok: (oldOk.length - delta.excludedCounts.removed) === (newOk.length - delta.excludedCounts.added),
    msg: `除两个授权面外 \`ok(\` 断言条数必须不变（旧 ${oldOk.length} − 排除 ${delta.excludedCounts.removed} = ${oldOk.length - delta.excludedCounts.removed}；新 ${newOk.length} − 排除 ${delta.excludedCounts.added} = ${newOk.length - delta.excludedCounts.added}）`,
  })

  /* ②c 反空转：`scope.P2` 缺失（或缺 quoteVerbatim）⇒ 那些行**不再**被排除 ⇒ 判据必须红 */
  const authNoP2 = JSON.parse(JSON.stringify(auth))
  if (authNoP2.scope) delete authNoP2.scope.P2
  const p2Absent = parseAuthorizationP2(authNoP2, MIRROR)
  const deltaNoP2 = judgeMirrorOkDelta({ hunks, oldOk, newOk, p2: p2Absent })
  rows.push({ ok: p2Absent.present === false && p2Absent.ok === false, msg: '（变异）删掉 scope.P2 之后 P2 授权面必须不成立' })
  rows.push({
    ok: deltaNoP2.ok === false && deltaNoP2.p2Face.length === 0 && deltaNoP2.unmapped.length >= 1,
    msg: `（变异）缺 scope.P2 ⇒ PROBE_VERSION 那些行不再被排除 ⇒ 判据必须红（实得 ok=${deltaNoP2.ok} / 排除 ${deltaNoP2.p2Face.length} 个 hunk / 游离 ${deltaNoP2.unmapped.length} 个 hunk：${deltaNoP2.why}）`,
  })
  const authNoQuoteP2 = JSON.parse(JSON.stringify(auth))
  delete authNoQuoteP2.quoteVerbatim
  const p2NoQuote = parseAuthorizationP2(authNoQuoteP2, MIRROR)
  const deltaNoQuote = judgeMirrorOkDelta({ hunks, oldOk, newOk, p2: p2NoQuote })
  rows.push({
    ok: p2NoQuote.present === true && p2NoQuote.ok === false && deltaNoQuote.ok === false && deltaNoQuote.p2Face.length === 0,
    msg: `（变异）scope.P2 还在但 quoteVerbatim 缺失 ⇒ P2 授权面同样不成立 ⇒ 判据必须红（实得 ok=${deltaNoQuote.ok} / 排除 ${deltaNoQuote.p2Face.length} 个 hunk）`,
  })
  record('A08.p2Face', {
    subject: MIRROR,
    scopeP2: {
      present: p2.present, effective: p2.effective, ok: p2.ok, why: p2.why,
      quoteVerbatim: p2.quoteVerbatim, items: p2.items, mine: p2.mine, window: p2.window, paths: p2.paths,
      entries: p2.entries.map((e) => ({ path: e.path, start: e.start, end: e.end })),
    },
    excluded: {
      removed: delta.excluded.removed.map(okLineKey),
      added: delta.excluded.added.map(okLineKey),
      counts: delta.excludedCounts,
      p2OnlyCounts: delta.p2Counts,
      u09OnlyCounts: delta.u09Counts,
      hunks: delta.p2Face.map((x) => ({ hunk: x.hunk, window: x.window })),
      why: `scope.P2 第 ${p2.items.indexOf(p2.mine[0]) + 1} 条授权「${String(p2.mine[0] ?? '').slice(0, 60)}…」；这些行是 P2 的集成修正面（PROBE_VERSION 字面量断言），不是本卡的 §12 A`,
    },
    residue: delta.residue,
    unmapped: delta.unmapped,
    mutants: {
      scopeP2Missing: { ok: deltaNoP2.ok, excludedHunks: deltaNoP2.p2Face.length, unmappedHunks: deltaNoP2.unmapped.length, why: deltaNoP2.why },
      quoteVerbatimMissing: { ok: deltaNoQuote.ok, excludedHunks: deltaNoQuote.p2Face.length, why: deltaNoQuote.why },
    },
  })

  // 具名钉住那些**非身份**断言（正文、键序、计数器、字节上限、状态码、双写者）
  const preserved = [
    '记录**键序**一致',
    '键序就是约定值',
    '两条确实来自两个不同写入者',
    '编号同一计数器、4 位同宽',
    '两条都不含时间戳字段',
    'notes/seq.txt 是**一个**计数器、终值 2',
    '超限样本按**字节**超、按字符没超',
    '包侧超限笔记 → 413 + ok:false',
    '两侧**状态码**相同',
    '两侧**同口径的拒法**',
    '两侧都**写前拒**',
    '灰带样本夹具自检',
    '包侧实况＝按**请求体**判 → 413',
    '插件侧实况＝按**正文**判 → 收下',
  ]
  for (const needle of preserved) {
    rows.push({ ok: mirrorNew.includes(needle), msg: `非身份断言必须原样保留：${needle}` })
    rows.push({ ok: mirrorOld.includes(needle), msg: `（对照）基线里本来就有：${needle}` })
  }
  rows.push({ ok: !/anchor: '第1课'/.test(mirrorNew), msg: 'A 面夹具里不许再有显示名当 anchor（显示名不再是身份）' })
  rows.push({ ok: !/anchor: 'spring-boot\/0001'/.test(mirrorNew), msg: 'A 面夹具里不许再有两段课键当 anchor' })
  const anchorValues = [...mirrorNew.matchAll(/anchor: '([^']+)'/g)].map((m) => m[1])
  rows.push({
    ok: anchorValues.length >= 5 && anchorValues.every((v) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\d{4}$/.test(v)),
    msg: `A 面所有 anchor 夹具输入都必须是规范课次键（实得 ${fmt(anchorValues)}）`,
  })

  /* ③ catalog 合法构造结果保持（**不执行** test/catalog.mjs：它 import packRoot() 读活包） */
  const catalogPath = path.join(REPO, 'test/catalog.mjs')
  rows.push({ ok: sha256(fs.readFileSync(catalogPath)) === sha256(headBytes('test/catalog.mjs')), msg: 'test/catalog.mjs 必须逐字节未改（既有测试只读）' })
  const model = await newModel()
  rows.push({ ok: model.pointKey('programming', 'spring-boot') === 'programming/spring-boot', msg: 'catalog 的 pointKey 断言仍然成立' })
  rows.push({ ok: model.lessonKey('programming', 'spring-boot', 1) === 'programming/spring-boot/0001', msg: 'catalog 的 lessonKey 断言仍然成立' })
  const old = await oldModel()
  const legalCases = [
    ['programming', 'spring-boot', 1],
    ['programming', 'vue', 1001],
    ['math', 'alge', 1],
    ['math', 'alge', 9999],
    ['a-b', 'c_d', 42],
  ]
  for (const [circle, point, number] of legalCases) {
    eq(model.pointKey(circle, point), old.pointKey(circle, point), `合法构造结果必须与基线一致（pointKey ${circle}/${point}）`)
    eq(model.lessonKey(circle, point, number), old.lessonKey(circle, point, number), `合法构造结果必须与基线一致（lessonKey ${circle}/${point}/${number}）`)
  }
  rows.push({ ok: true, msg: '合法输入（含 fileBase 轨道号 1001、边界 9999）的构造结果与基线逐字节相同' })

  /* ④ 依赖锚点：**本进程未写** + 归属可查（不钉"跨卡静止"，那是别的卡的合法写集） */
  const lockText = readText(path.join(REPO, 'docs/unify/interfaces.md'))
  const s6 = parseSection6(lockText)
  const owners = pathOwners(s6)
  const depRows = []
  const guardNow = sweepWriteGuard()
  for (const [dep, owner] of Object.entries(DEPENDENCY_OWNERS)) {
    const abs = path.join(REPO, dep)
    assert(fs.existsSync(abs), `A08 · 依赖模块不见了：${dep}`)
    const wrote = guardNow.writes.filter((x) => x.target === path.resolve(abs))
    depRows.push({
      path: dep, owner, bytes: fs.statSync(abs).size,
      sha16: sha256(fs.readFileSync(abs)).slice(0, 16),
      writtenByThisProcess: wrote.length,
      section6Owners: owners.get(dep) ?? [],
    })
    rows.push({ ok: wrote.length === 0, msg: `本卡本次进程不许写依赖模块 ${dep}（实得 ${wrote.length} 次写）` })
    rows.push({ ok: (owners.get(dep) ?? []).includes(owner), msg: `${dep} 的归属必须能在 §6 里查到 ${owner}` })
  }
  rows.push({ ok: depRows.every((d) => d.bytes > 0), msg: '五个依赖模块都读得到（非空）' })

  /* ④b **全仓只剩一份身份构造/解析**的扫描证明（lib/**、tools/**；逐条列出并**归到 §6 有主的卡**） */
  const scan = scanIdentityImplementations()
  const scanAttr = attributeIdentityHits(scan.hits, {
    cards: new Set(s6.keys()),
    owners,
    pins: deferredPinsFromReceipt(rc),
  })
  for (const hit of scanAttr.hitRows) {
    rows.push({
      ok: hit.ok,
      msg: `身份构造/解析命中点必须归到 §6 里有主的卡（${hit.file}:${hit.line} ${hit.pattern} → ${hit.kind}/${hit.owner ?? '(无主，按钉子)'}；§6 记的主 ${fmt(hit.section6Owners)}${hit.problems.length ? '；问题：' + hit.problems.join('；') : ''}）`,
    })
  }
  {
    /* 钉子账（决-3）：deferredPins 必须**逐条等于**扫描里 §6 无主的命中点 —— 现在应为零条
     * （`lib/pack-export.js` 已收编给 U16）。旧钉子留着即红：钉子是"无主文件的记账"，不是挡箭牌。 */
    const deferredKeys = [...new Set(scan.hits
      .filter((h) => h.kind === 'DEFERRED-OTHER-CARD')
      .map((h) => `${h.file}|${h.pattern}`))].sort()
    const pinKeys = [...deferredPinsFromReceipt(rc).keys()].sort()
    rows.push({
      ok: JSON.stringify(pinKeys) === JSON.stringify(deferredKeys),
      msg: `回执的 deferredPins 必须逐条等于扫描里 §6 无主的命中点（钉子 ${fmt(pinKeys)} / 无主命中 ${fmt(deferredKeys)}）—— 无主文件不是自由区，有主文件也不许再被钉`,
    })
    rows.push({
      ok: scanAttr.pinRows.every((r) => r.ok),
      msg: `每一条钉子都不许被突破（上限；实得 ${fmt(scanAttr.pinRows.map((r) => `${r.file}|${r.pattern} ${r.observed}/${r.pinnedMax}`))}）`,
    })
    rows.push({
      ok: !IDENTITY_SCAN_RULES['lib/pack-export.js'] && (owners.get('lib/pack-export.js') ?? []).includes('U16'),
      msg: `决-3 收编的落账：§6 的 U16 行点名 lib/pack-export.js、显式表里没有它（实得 §6 主 ${fmt(owners.get('lib/pack-export.js') ?? [])}）`,
    })
    const exportHits = scan.hits.filter((h) => h.file === 'lib/pack-export.js')
    rows.push({
      ok: exportHits.every((h) => h.kind === 'OWNED-OTHER-CARD' && h.owner === 'U16' && h.attribution === 'section6-auto'),
      msg: `lib/pack-export.js 的每处痕迹都必须按 §6 自动归属成 OWNED-OTHER-CARD/U16（实得 ${fmt(exportHits.map((h) => `${h.line}:${h.pattern} ${h.kind}/${h.owner ?? '(无)'}[${h.attribution}]`))}）`,
    })
    record('A08.packExportOwnership', {
      pins: pinKeys,
      deferred: deferredKeys,
      section6Owners: owners.get('lib/pack-export.js') ?? [],
      explicitTableEntry: !!IDENTITY_SCAN_RULES['lib/pack-export.js'],
      hits: exportHits.map((h) => ({ line: h.line, pattern: h.pattern, kind: h.kind, owner: h.owner, attribution: h.attribution })),
    })
  }
  const constructHits = scan.hits.filter((h) => h.pattern === 'template-circle-point')
  const KIND_OK = ['KERNEL', 'NON-IDENTITY', 'MIGRATION', 'OWNED-OTHER-CARD', 'DEFERRED-OTHER-CARD']
  rows.push({
    ok: constructHits.every((h) => KIND_OK.includes(h.kind)),
    msg: `身份拼接的每一处都必须已归类（未归类：${fmt(constructHits.filter((h) => !KIND_OK.includes(h.kind)).map((h) => h.file))}）`,
  })
  const splitHits = scan.hits.filter((h) => h.pattern === 'indexof-slash')
  rows.push({
    ok: splitHits.every((h) => KIND_OK.includes(h.kind)),
    msg: `身份拆分的每一处都必须已归类（BLOCKED-BOUNDARY 已随决-7 废止，不再是可接受的归类；未归类：${fmt(splitHits.filter((h) => !KIND_OK.includes(h.kind)).map((h) => h.file))}）`,
  })
  // 归类为"他卡"的必须**在回执里逐条登记**（不许用归类把问题藏起来）
  const regressionBlob = JSON.stringify(rc.regressionsDiscovered || [])
  const ownedOtherFiles = [...new Set(scan.hits.filter((h) => h.kind === 'OWNED-OTHER-CARD').map((h) => h.file))].sort()
  rows.push({
    ok: ownedOtherFiles.length > 0 && ownedOtherFiles.every((f) => (owners.get(f) ?? []).length > 0),
    msg: `扫描识别出的"他卡合法身份消费"必须都能在 §6 里查到主（${ownedOtherFiles.length} 个文件：${fmt(ownedOtherFiles)}）—— 否则这类断言是空转`,
  })
  for (const f of ownedOtherFiles) {
    rows.push({ ok: (owners.get(f) ?? []).length === 1, msg: `${f} 在 §6 里必须**恰好**有一个主（实得 ${fmt(owners.get(f) ?? [])}）—— 多主等于没主` })
  }
  // §6 里**真无主**的那些才归 regressionsDiscovered（决-3 之后仓内已没有这种文件；
  // 这条循环留着是为了"将来再有新无主文件"时仍然强制登记，不是给 pack-export 留后门）
  const repoRelOwners = [...new Set(scan.hits.filter((h) => h.kind === 'DEFERRED-OTHER-CARD').map((h) => h.file))].sort()
  for (const f of repoRelOwners) {
    const base = f.split('/').pop()
    rows.push({ ok: (owners.get(f) ?? []).length === 0, msg: `${f} 标为"§6 无主"就真的不许有主（实得 ${fmt(owners.get(f) ?? [])}）` })
    rows.push({ ok: regressionBlob.includes(base) || regressionBlob.includes(f), msg: `无主文件的构造点必须在回执 regressionsDiscovered 里点名：${f}` })
  }
  /* 决-7：`lib/point-ref.js` 那一条"语义边界"已销账 —— 判据从「命中点必须是已登记的 BLOCKED 边界」
   * 换成**更严**的一组：全仓不再允许 BLOCKED-BOUNDARY 分类；那条登记必须留在回执里并标 `resolved`，
   * 且写清授权出处（决-7 / decisions）与逐例 Δ（否则"销账"只是一句声明）。 */
  const boundarySplit = scan.hits.filter((h) => h.kind === 'BLOCKED-BOUNDARY')
  rows.push({
    ok: boundarySplit.length === 0,
    msg: `全仓扫描不许再有 BLOCKED-BOUNDARY 分类（决-7 已把唯一那条边界销账；实得 ${fmt(boundarySplit.map((h) => `${h.file}:${h.line}:${h.pattern}`))}）`,
  })
  const rcBoundary = (Array.isArray(rc.blockedBoundaries) ? rc.blockedBoundaries : []).find((b) => b && b.file === POINT_REF)
  rows.push({ ok: !!rcBoundary && rcBoundary.status === 'resolved', msg: `回执 blockedBoundaries 里 ${POINT_REF} 那条必须标 status=resolved（实得 ${fmt(rcBoundary && rcBoundary.status)}）` })
  rows.push({
    ok: !!rcBoundary && /决-7/.test(JSON.stringify(rcBoundary)) && /decisions/.test(JSON.stringify(rcBoundary)),
    msg: '那条 resolved 必须写清授权出处（决-7 / docs/unify/authorization.json 的 decisions）',
  })
  rows.push({
    ok: !!rcBoundary && /Δ/.test(JSON.stringify(rcBoundary)) && /splitQualified/.test(JSON.stringify(rcBoundary)),
    msg: '那条 resolved 必须写清旧/新语义与逐例 Δ（点名 splitQualified 与 Δ 表）',
  })
  rows.push({
    ok: !!rcBoundary && /只升不降|不降/.test(JSON.stringify(rcBoundary)),
    msg: '那条 resolved 必须写强度对照（判据强度"只升不降"）——否则"销账"没法验收',
  })
  rows.push({ ok: scan.kernelHits > 0 && scan.scanned > 50, msg: `扫描必须真的扫到东西（${scan.scanned} 个文件 / 内核命中 ${scan.kernelHits}）—— 否则"没有第二处"是白得的` })
  record('A08.identityScan', { scanned: scan.scanned, hits: scanAttr.hitRows, pins: scanAttr.pinRows, kernelHits: scan.kernelHits })

  /* ⑤ 写集守卫（进程内 fs 写守卫 + 探针写自证） */
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

  /* ⑥ 授权写集并集：§6 ∪ A 面 */
  eq(s6.size, 20, `A08 · §6 解析出来的卡只有 ${s6.size} 张（应为 20）`)
  const union = new Set(authorizedUnion(s6))
  for (const p of face.allowed) union.add(p)
  // 并发 lane 的 A 面（U10 的 test/intake.mjs、U14 的 test/audit/U14.mjs）也是本轮被授权的路径 ——
  // 它们进"授权并集"（tracked 改动 ⊆ 并集），但**不进**本卡的写允许面（proveWriteScope 单独钉）。
  const allFaces = parseAllAFaces(auth)
  for (const p of allFaces.keys()) union.add(p)
  // 写集扩张（主持人裁决）：**只认回执里逐字登记的那一个文件**，不认"随便加"
  const expansionFile = rc.writeSetExpansion && rc.writeSetExpansion.file ? String(rc.writeSetExpansion.file) : null
  if (expansionFile) union.add(expansionFile)
  // **P2 授权面**（U09-Δ2）：scope.P2 逐字点名的既有测试进"本轮授权并集"（tracked 改动 ⊆ 并集），
  // 但**不进**本卡的写允许面；每一条另配"改动必须恰好落在声明行窗口内"的定向判据（见 ⑧）。
  for (const p of (p2.ok ? p2.paths : [])) union.add(p)
  sameJson([...s6.get(CARD)], SECTION6_EXPECTED, 'A08 · §6 里 U09 的落点必须逐条等于本卡的 §6 写集（接口锁与入口不一致）')
  // §6 里那两项"另有授权来源"的落点：授权原文必须仍查得到（不是靠 §6 一句话就算数）
  rows.push({ ok: union.has(MIRROR), msg: `${MIRROR} 必须在授权并集里（§6 已补登 + §12 A 的 scope.A 授权原文可查）` })
  rows.push({ ok: union.has(POINT_REF), msg: `${POINT_REF} 必须在授权并集里（§6 已补登 + 主持人裁决 C4 的落账可查）` })
  rows.push({ ok: expansionFile === POINT_REF, msg: `回执登记的唯一写集扩张必须是 ${POINT_REF}（实得 ${fmt(expansionFile)}）` })
  sameJson(face.allowed, [MIRROR], 'A08 · 本卡（U09）自己的 A 面必须**只有** test/mirror-parity.mjs')
  for (const other of ['test/intake.mjs', 'test/audit/U14.mjs']) {
    rows.push({ ok: allFaces.has(other) && !face.allowed.includes(other), msg: `${other} 属于别的卡的 A 面：进授权并集、但**不许**进本卡的 A 面` })
  }
  const c4 = (auth.derivedConsequences && Array.isArray(auth.derivedConsequences.items))
    ? auth.derivedConsequences.items.find((i) => i.id === 'C4')
    : null
  rows.push({ ok: !!c4 && /point-ref\.js/.test(JSON.stringify(c4)) && /主持人裁决/.test(JSON.stringify(c4)), msg: 'authorization.json 的 derivedConsequences.C4 必须逐字登记 point-ref 的写集扩张（主持人裁决，不是用户逐字授权）' })
  rows.push({ ok: s6.get(CARD).includes(KERNEL) && s6.get(CARD).includes(HOST_MODEL) && s6.get(CARD).includes(PACK_MAP), msg: '§6 的 U09 行点名了内核与两个宿主/包侧落点' })
  const porcelain = gitRead(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter((l) => l.trim())
  const { tracked, untracked } = splitPorcelainTracked(porcelain)
  const scopeCheck = classifyTrackedWrites(tracked, union)
  eq(scopeCheck.outOfBounds.length, 0, `A08 · tracked 改动越出授权写集并集：${scopeCheck.outOfBounds.slice(0, 5).map((v) => `${v.code.trim() || '?'} ${v.path}`).join(', ')}`)
  for (const f of CHANGED_FILES) {
    rows.push({ ok: tracked.some((t) => t.path === f), msg: `tracked 改动里必须有本卡改过的 ${f}` })
  }
  const sProof = proveScopeBoundary(s6, face, p2.ok ? p2.paths : [])
  eq(sProof.failures.length, 0, `A08 · 授权面判定的纯函数自证失败：${sProof.failures.map((f) => `${f.line} → ${f.got}（期望 ${f.expect}）`).join(' | ')}`)
  rows.push({ ok: !face.allowed.includes('test/intake.mjs'), msg: 'A 面边界自证：test/intake.mjs 不在本卡的 A 面里（U10 的授权不得被本卡扩用）' })

  /* ⑦ 交付物内容锁 */
  const lock = recordContentLock()
  eq(lock.size, CHANGED_FILES.length + 2, `A08 · 内容锁只记到 ${lock.size} 条`)
  const lockNow = verifyContentLock()
  eq(lockNow.mismatches.length, 0, `A08 · 内容锁当场复核就失败了：${lockNow.mismatches.map((m) => m.path).join(', ')}`)

  /* ⑧ 交付物真的改过 / 建过；且不许动别人 */
  const facts = []
  for (const f of CHANGED_FILES) {
    const now = sha256(fs.readFileSync(path.join(REPO, f)))
    const before = sha256(headBytes(f))
    rows.push({ ok: now !== before, msg: `${f} 与基线字节相同 —— 本卡其实没改它（对拍无意义）` })
    facts.push({ path: f, state: 'changed', beforeSha16: before.slice(0, 16), nowSha16: now.slice(0, 16) })
  }
  for (const p of CREATED_FILES) {
    rows.push({ ok: fs.existsSync(path.join(REPO, p)), msg: `新文件不见了：${p}` })
    facts.push({ path: p, state: 'created', nowSha16: sha256(fs.readFileSync(path.join(REPO, p))).slice(0, 16) })
  }
  // 不得改的既有测试与 T 卡：这些路径**不在任何 U 卡写集**里 ⇒ 逐字节必须与 HEAD 相同。
  // 例外（U09-Δ2）：`test/audit/T26.mjs` 是 **P2 授权面**（scope.P2 第 2 条点名它第 63 行的 F01 断言对象）。
  // 判据因此从"逐字节未改"换成更精确的定向判据：只许 1 个 hunk、删 1 增 1、落在 scope.P2 声明的
  // 旧行窗口内、内容确实是 PROBE_VERSION 断言，且 P2 明说"不动"的 F01 子断言仍原样在。
  const t26Path = 'test/audit/T26.mjs'
  const t26Changed = sha256(fs.readFileSync(path.join(REPO, t26Path))) !== sha256(headBytes(t26Path))
  const t26P2 = parseAuthorizationP2(auth, t26Path)
  const t26Patch = judgeP2LinePatch({
    diffText: gitRead(['diff', '-U0', '--', t26Path]),
    window: t26P2.window,
    mustKeep: ["PROBE_SOURCES.includes('lib/adapters/jvm.js')", "assert.deepEqual([...got].sort(),[...PROBE_SOURCES].sort())"],
    tolerance: 0,
    label: t26Path,
  })
  for (const p of ['test/all.mjs', 'test/audit/harness.mjs', 'test/catalog.mjs']) {
    rows.push({ ok: headExists(p), msg: `${p} 必须仍在基线提交里（否则下面那条对拍没有对象）` })
    rows.push({ ok: !union.has(p), msg: `${p} 不在任何 U 卡的授权写集里（任何卡都不许改既有测试/T 卡）` })
    rows.push({ ok: sha256(fs.readFileSync(path.join(REPO, p))) === sha256(headBytes(p)), msg: `${p} 必须逐字节未改` })
  }
  // `test/pack-template-rules.mjs`：决-B1（决-9）授权 U19 **只加登记项**。
  //   ⚠️ 原来的判据是"逐字节未改"，那是授权之前的口径。现在改判**授权原话本身**：
  //   **零删除、零修改**，新增的代码行**恰好**是那 14 行 `'tools/unify/<模块>.cjs',`。
  //   这比"未改"更贴题（"只加登记项、不改判据强度"是可机判的形状，不只是承诺）。
  {
    const p = 'test/pack-template-rules.mjs'
    rows.push({ ok: headExists(p), msg: `${p} 必须仍在基线提交里（否则登记项对拍没有对象）` })
    rows.push({ ok: union.has(p), msg: `${p} 必须由 §6 的 U19 行登记（决-B1 的账本出口；无主即越界）` })
    const d = gitRead(['diff', '--unified=0', '--', p])
    const added = d.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
    const removed = d.split(/\r?\n/).filter((l) => l.startsWith('-') && !l.startsWith('---'))
    rows.push({ ok: removed.length === 0, msg: `${p} 不许删除或修改任何既有行（决-B1 只授权"加登记项"；实得删除 ${removed.length} 行：${fmt(removed.slice(0, 3))}）` })
    const codeAdded = added.filter((l) => l.trim() && !l.trim().startsWith('//'))
    const authModules = fs.readdirSync(path.join(REPO, 'lib', 'unify'))
      .filter((n) => n.endsWith('.cjs') && n !== 'migration.cjs').map((n) => n.replace(/\.cjs$/, '')).sort()
    const wantRows = authModules.map((m) => `  'tools/unify/${m}.cjs',`)
    rows.push({ ok: codeAdded.length === wantRows.length && wantRows.every((w) => codeAdded.includes(w)),
      msg: `${p} 新增的代码行必须**恰好**是那 ${wantRows.length} 行登记项（实得 ${codeAdded.length} 行，缺 ${fmt(wantRows.filter((w) => !codeAdded.includes(w)))}，多 ${fmt(codeAdded.filter((l) => !wantRows.includes(l)))}）` })
    rows.push({ ok: added.length > codeAdded.length, msg: `${p} 的登记项应当带出处注释（新增行里必须至少有一条注释：${added.length} vs ${codeAdded.length}）` })
  }
  rows.push({ ok: headExists(t26Path), msg: `${t26Path} 必须仍在基线提交里（否则 P2 的定向判据没有对象）` })
  rows.push({
    ok: (owners.get(t26Path) ?? []).includes('U01') && t26P2.ok,
    msg: `${t26Path} 的落点必须**同时**由 §6（U01 行，限定语「${P2_FACE_QUALIFIER}」）与 scope.P2 逐字点名（实得 §6 主 ${fmt(owners.get(t26Path) ?? [])} / P2 ${t26P2.ok}）`,
  })
  rows.push({ ok: t26P2.ok === true, msg: `scope.P2 必须逐字点名 ${t26Path} 并写出旧行窗口：${t26P2.why}` })
  rows.push({
    ok: !t26Changed || (t26P2.ok && t26Patch.ok),
    msg: `${t26Path} 的改动必须**恰好**是 P2 授权那一行（1 hunk / 删1增1 / 在声明窗口内 / P2 明说不动的 F01 断言仍在）：${t26Changed ? t26Patch.why : '（本树上未改，判据不适用）'}`,
  })
  rows.push({
    ok: !t26Changed || t26Patch.mustKeepMissing.length === 0,
    msg: `P2 明说"不动"的 F01 子断言必须在 ${t26Path} 里仍原样存在（缺 ${fmt(t26Patch.mustKeepMissing)}）—— P2 不是"整个 F01 可以重写"`,
  })
  // `test/intake.mjs` 是 **U10 的 A 面**（并发 lane 正在改它）：本卡既不锚它的字节、也不许改进它
  rows.push({ ok: !face.allowed.includes('test/intake.mjs'), msg: 'A 面边界：test/intake.mjs 不在本卡（U09）的 A 面里' })
  rows.push({ ok: (allFaces.get('test/intake.mjs') || []).includes('U10'), msg: 'A 面边界：test/intake.mjs 的授权只属于 U10（进授权并集的是**它的**授权，不是本卡的）' })
  // 属于**别的卡**的落点：不钉"跨卡静止"，只证「不在本卡写集 + 本进程没写 + 改动可归属」
  const guardForLock = sweepWriteGuard()
  for (const [p, owner] of [['lib/render.js', 'U07'], ['lib/pack-scaffold.js', 'U19'], ['package.json', 'U19'], ['docs/unify/interfaces.md', 'U01'], ['docs/unify/baseline.json', 'U01']]) {
    rows.push({ ok: fs.existsSync(path.join(REPO, p)), msg: `${p} 必须可读（本卡消费它做接口/授权核对）` })
    rows.push({ ok: !WRITE_SET.includes(p), msg: `${p} 不在本卡写集` })
    rows.push({ ok: guardForLock.writes.filter((x) => x.target === path.resolve(REPO, p)).length === 0, msg: `本卡本次进程不许写 ${p}` })
    rows.push({ ok: (owners.get(p) ?? []).includes(owner), msg: `${p} 的归属必须能在 §6 里查到 ${owner}` })
    if (headExists(p)) {
      const now = sha256(fs.readFileSync(path.join(REPO, p)))
      const before = sha256(headBytes(p))
      rows.push({ ok: now === before || (owners.get(p) ?? []).includes(owner), msg: `${p} 若与基线不同，必须能归属到 ${owner}（现在是 ${now === before ? '相同' : '不同'}）` })
    }
  }
  // `authorization.json` 晚于 §6 落盘（主持人登记）：它不属于任何卡的写集，本卡只读
  {
    const p = path.join(REPO, 'docs', 'unify', 'authorization.json')
    rows.push({ ok: fs.existsSync(p), msg: 'docs/unify/authorization.json 必须可读（本卡据此引用授权原文）' })
    rows.push({ ok: !union.has('docs/unify/authorization.json'), msg: 'authorization.json 不在任何 U 卡的授权写集里（授权文件本身不许被卡改写）' })
    rows.push({ ok: sweepWriteGuard().writes.filter((x) => x.target === path.resolve(p)).length === 0, msg: '本卡本次进程不许写 authorization.json' })
  }

  /* ⑨ 证据根守卫：默认落本卡新运行目录；越界拒绝；读取根不受它影响 */
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08 · 默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08 · 默认证据根必须是 audit-evidence/U09/runs/U09-<pid>')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true, 'A08 · E:\\Temp 下带 U09- 前缀的新目录必须被接受')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 往仓内别处写必须被拒')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U01')}`], CARD, { repoRoot: REPO }).ok, false, 'A08 · 覆盖既有证据目录必须被拒')
  eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08 · 相对路径必须被拒')
  eq(path.dirname(EVIDENCE_ROOT_READ), path.join(REPO, 'audit-evidence'), 'A08 · 读取根必须恒为 <repo>/audit-evidence/U09')

  /* ⑩ 临时目录：按绝对路径与归属清理 */
  eq(guardTempPath(RUN_TEMP, { parent: TEMP_PARENT }).ok, true, `A08 · 本次临时根必须归 ${TEMP_PARENT}`)
  assert(/^u09-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08 · 本次临时根名字必须是 u09-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08 · 守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08 · 守卫必须拒绝名字形状可疑的目标')
  const scratch = path.join(RUN_TEMP, 'guard-scratch')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
  const removedTree = safeRemoveTree(scratch, { parent: RUN_TEMP })
  eq(removedTree.removed, true, `A08 · 守卫内的清理必须成功（${removedTree.error || ''}）`)
  eq(fs.existsSync(scratch), false, 'A08 · 清理后目录必须真的没了')

  /* ⑪ tracked 回执：合法 JSON、五项齐、authorization 逐字、Δ 与写集对得上 */
  //（回执本身在 ①b 已读进来 —— 那里的 JSON 合法性就是这条判据的第一半）
  rows.push({ ok: rc && rc.card === CARD, msg: 'A08 · 回执 card 不对' })
  rows.push({ ok: rc.status === 'PASS', msg: `A08 · 回执 status 必须是 PASS（实得 ${fmt(rc.status)}）` })
  for (const key of ['completion', 'dependencies', 'interfaceConsumption', 'writeSet', 'deltas', 'verdict', 'unverified', 'evidenceIndex', 'assertions', 'authorization']) {
    rows.push({ ok: key in rc, msg: `A08 · 回执缺字段 ${key}` })
  }
  rows.push({ ok: rc.authorization && rc.authorization.quoteVerbatim === auth.quoteVerbatim, msg: 'A08 · 回执 authorization.quoteVerbatim 必须与 authorization.json 逐字相同' })
  rows.push({ ok: rc.authorization && rc.authorization.quoteSource === auth.quoteSource, msg: 'A08 · 回执 authorization.quoteSource 必须与 authorization.json 逐字相同' })
  rows.push({ ok: rc.authorization && /本卡只按 scope\.A 执行/.test(rc.authorization.statement || ''), msg: 'A08 · 回执必须写明「本卡只按 scope.A 执行」' })
  rows.push({ ok: rc.authorization && rc.authorization.quoteVerbatim === '选A和授权p1和p2', msg: 'A08 · 回执里的授权原文必须是「选A和授权p1和p2」' })
  /* 自指复核（U09-Δ2）：回执登记的**交付物字节/sha256** 必须与盘上一致。
   * 为什么需要它：回执可以写着"我改了什么"，但只有把 sha256 钉在回执里、再由入口当场复算，
   * "回执描述的就是这一版交付物"才是一条判据而不是一句声明。回执**自身**的字节/sha 由本次运行的
   * `detail.json` 的 artifacts 记录（自指哈希是固定点方程，不能在本文件里自证）。 */
  const att = rc.selfAttestation
  const attFiles = att && Array.isArray(att.files) ? att.files : []
  rows.push({ ok: attFiles.length >= 5, msg: `A08 · 回执必须有 selfAttestation.files 且至少 5 条（实得 ${attFiles.length}）` })
  const attBad = []
  for (const f of attFiles) {
    const p = String(f && f.path ? f.path : '')
    const abs = path.join(REPO, p)
    if (!p || p === RECEIPT || !fs.existsSync(abs)) { attBad.push(`${p || '(空)'}:${p === RECEIPT ? '不许自证自身哈希' : 'missing'}`); continue }
    const bytes = fs.statSync(abs).size
    const sha = sha256(fs.readFileSync(abs))
    if (Number(f.bytes) !== bytes || String(f.sha256) !== sha) attBad.push(`${p}: 回执 ${f.bytes}/${String(f.sha256).slice(0, 12)} → 盘上 ${bytes}/${sha.slice(0, 12)}`)
  }
  rows.push({ ok: attBad.length === 0, msg: `A08 · 回执自指的字节/sha256 必须与盘上逐条一致（失配 ${attBad.length} 条：${fmt(attBad.slice(0, 3))}）` })
  rows.push({
    ok: attFiles.some((f) => f && f.path === 'test/audit/U09.mjs') && attFiles.some((f) => f && f.path === KERNEL),
    msg: 'A08 · 自指至少必须包含本入口（test/audit/U09.mjs）与权威内核 —— 否则"回执描述的就是这一版"没有对象',
  })
  sameJson(rc.writeSet.map((x) => (typeof x === 'string' ? x : x.path)), WRITE_SET, 'A08 · 回执里的实际写集与卡面写集不一致')
  rows.push({ ok: /无/.test(JSON.stringify(rc.writeOutOfSet)), msg: 'A08 · 回执必须写清越界项（无也写明）' })
  rows.push({ ok: Array.isArray(rc.deltas) && rc.deltas.length >= 5, msg: 'A08 · 回执必须逐条登记真实 Δ（至少 5 条）' })
  rows.push({ ok: rc.unverified.some((u) => /U19/.test(JSON.stringify(u))), msg: 'A08 · 未验证边界里必须登记"随包闭包待 U19"' })
  rows.push({ ok: rc.unverified.some((u) => /U17/.test(JSON.stringify(u))), msg: 'A08 · 未验证边界里必须登记"真实迁移后读取归 U17"' })
  rows.push({ ok: rc.unverified.some((u) => /mirror-parity/.test(JSON.stringify(u))), msg: 'A08 · 未验证边界里必须登记 A 面镜像测试的实测窗口' })
  rows.push({ ok: rc.unverified.some((u) => /point-ref/.test(JSON.stringify(u))), msg: 'A08 · 未验证边界里必须登记 lib/point-ref.js 的内联构造未在本卡写集' })
  rows.push({ ok: rc.assertions && Object.keys(rc.assertions).length >= 8, msg: 'A08 · 回执必须逐项写清 A01–A08 的断言内容' })
  rows.push({ ok: rc.verdict && rc.verdict.line === `PASS ${CARD} checks=8 failed=0 skipped=0`, msg: 'A08 · 回执判词必须是本入口的 PASS 行' })
  // 写集扩张（point-ref）：必须逐字登记来源/依据/最小化，且**不许**自称用户授权
  const ex = rc.writeSetExpansion
  rows.push({ ok: ex && ex.file === POINT_REF, msg: 'A08 · 回执必须登记 writeSetExpansion.file = lib/point-ref.js' })
  rows.push({ ok: ex && ex.authorizedBy === '主持人裁决', msg: 'A08 · 写集扩张必须写明 authorizedBy=主持人裁决（不许冒充用户逐字授权）' })
  rows.push({ ok: ex && Array.isArray(ex.basis) && ex.basis.join('|').includes('U-SPEC §2') && ex.basis.join('|').includes('interfaces.md'), msg: 'A08 · 写集扩张的依据必须逐条写明（U-SPEC §2 / interfaces.md §2）' })
  rows.push({ ok: ex && /两处/.test(JSON.stringify(ex)), msg: 'A08 · 写集扩张必须写明最小化口径（只改两处内部调用）' })
  // 新发现的回归/待裁决项（EXPECT 两段声明、他卡内联实现）必须逐条登记
  rows.push({ ok: Array.isArray(rc.regressionsDiscovered) && rc.regressionsDiscovered.length >= 2, msg: 'A08 · 回执必须逐条登记 regressionsDiscovered（EXPECT 两段声明 / 他卡内联实现）' })
  rows.push({
    ok: (rc.regressionsDiscovered || []).some((r2) => /EXPECT/.test(JSON.stringify(r2)) && /point\/NNNN|两段/.test(JSON.stringify(r2))),
    msg: 'A08 · regressionsDiscovered 必须登记「EXPECT.json 的 lessons[].id 仍是两段旧形状」这一条 R',
  })
  rows.push({
    ok: (rc.regressionsDiscovered || []).some((r2) => /build-lessons|build-starmap|render\.cjs|pack-export/.test(JSON.stringify(r2))),
    msg: 'A08 · regressionsDiscovered 必须登记「他卡/无主文件仍内联构造身份或产出两段课次键」',
  })

  record('A08', {
    authorization: { quoteVerbatim: auth.quoteVerbatim, quoteSource: auth.quoteSource, face, scopeATitle: auth.scope.A.title },
    mirrorDelta: {
      hunks: hunks.length,
      removedAssertions: removed.map(okLineKey),
      addedAssertions: added.map(okLineKey),
      okLines: { before: oldOk.length, after: newOk.length },
      anchorValues,
      changedHunkRanges: hunks.map((h) => ({ old: [h.oldStart, h.oldLines], new: [h.newStart, h.newLines] })),
      verdict: { ok: delta.ok, why: delta.why, residue: delta.residue },
    },
    p2Face: {
      scopeP2Window: p2.window,
      excludedOKLines: { removed: delta.excludedCounts.removed, added: delta.excludedCounts.added },
      t26: { changed: t26Changed, patch: { ok: t26Patch.ok, why: t26Patch.why, hunks: t26Patch.hunks, window: t26Patch.window } },
    },
    catalog: { unchanged: true, legalCases: legalCases.length },
    dependencyAnchors: depRows,
    writeSetFacts: facts,
    writeGuard: { installed: guard.installed, patched: guard.patched.length, writeCount: guard.writeCount, ops: guard.ops, probe: guard.probe, violations: guard.violations, proof: wProof.rows },
    authorizedUnion: {
      section6Cards: s6.size, section6Paths: authorizedUnion(s6).size,
      aFace: face.allowed, unionSize: union.size, p2Paths: p2.ok ? p2.paths : [],
      trackedChanges: tracked.map((t) => ({ code: t.code, path: t.path, owners: owners.get(t.path) ?? [] })),
      untrackedCount: untracked.length, outOfBounds: scopeCheck.outOfBounds, proof: sProof.rows,
    },
    contentLock: { recorded: lock.size, checksNow: lockNow.checks, mismatches: lockNow.mismatches },
    receipt: { card: rc.card, status: rc.status, writeSet: rc.writeSet.length, deltas: rc.deltas.length, assertions: Object.keys(rc.assertions || {}).length },
  })
  assertAll(rows, 'A08.rows')
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
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
  const cases = v.cases.map((cse) => (cse.id === 'A08' ? { ...cse, actual: 'fail', note: `${cse.note ? `${cse.note} | ` : ''}${reason}` } : cse))
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
  fs.mkdirSync(RUN_TEMP, { recursive: true })
  installWriteGuard(writeAllowScope())
  try {
    probeWriteGuard()
  } catch (e) {
    WRITE_GUARD.probeError = String(e?.message ?? e)
  }

  try {
    verdict = await runCard(CARD, FIXED_IDS, CASES, {
      argv: ARGV,
      blocked: evidenceGuard.ok ? null : `证据根解析失败：${evidenceGuard.error}`,
    })
  } finally {
    // 收口前先不删临时树（A08 的内容锁与写记录要留到写证据之后），清理放这里但**先核对归属**
    const resolved = path.resolve(RUN_TEMP)
    const own = path.dirname(resolved) === path.resolve(TEMP_PARENT)
      && path.basename(resolved).startsWith(`${CARD.toLowerCase()}-${process.pid}-`)
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
    DETAIL.entry = { file: rel(SELF), dir: HERE, card: CARD }
    DETAIL.argv = ARGV
    DETAIL.verdict = { line: verdict.line, code: verdict.code, ms: verdict.ms }
    DETAIL.cases = Object.fromEntries(verdict.cases.map((c) => [c.id, { status: c.actual, note: c.note, ms: c.ms }]))
    DETAIL.artifacts = [...CHANGED_FILES, ...CREATED_FILES].map((p) => ({
      path: p,
      bytes: fs.statSync(path.join(REPO, p)).size,
      sha256: sha256(fs.readFileSync(path.join(REPO, p))),
    }))
    fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
  }
  process.exitCode = printVerdict(verdict)
}
