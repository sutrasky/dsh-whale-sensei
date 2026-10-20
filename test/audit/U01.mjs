#!/usr/bin/env node
/**
 * test/audit/U01.mjs —— 基线与判据基础（U01 专项入口）
 * ==================================================================
 * 两个模式，**都不采集全量、都不访问活包**：
 *   ① 默认 `node test/audit/U01.mjs`
 *        只验证「已采集的材料」：本卡 `audit-evidence/U01/` 下的原始证据 + 两个 tracked 出口
 *        （`docs/unify/interfaces.md` / `docs/unify/baseline.json`）互相自洽。
 *   ② `node test/audit/U01.mjs --verify-baseline`
 *        额外把「源文件锁」对到**固定提交对象**（`git cat-file blob 2f57b1f:<path>` 重算 sha256），
 *        证明锁记的是基线提交而不是某个后来工作树的样子；
 *        **不要求后续工作树字节仍等于初始源码**，也不会再访问活包。
 *
 * 根（两个，必须分开 —— S0 收尾修正）：
 *   **读取根恒为 `<repo>/audit-evidence/U01`**（采集材料）；`--evidence-root=<绝对路径>`
 *   **只决定本次运行产物写哪儿**，不改读取根、不覆盖既有采集证据、守卫照旧。
 *
 * A01 的判据（S0 收尾修正 · 授权面）：允许出现的变化 = **U01–U20 全部卡片授权写集的并集**
 * （来源 `docs/unify/interfaces.md` §6 那张表；每次运行都把 §6 现文本重新解析一遍与常量逐卡对账）
 * ∪ `cards/U*.md` ∪ `docs/unify/**` ∪ `audit-evidence/**`。
 * 仍然必须失败：§6 之外**任何已跟踪文件**的改/删/增、**索引里出现任何改动（git add）**、
 * 任何不在授权面内的未跟踪路径、HEAD/分支漂移、
 * 受保护路径被写、`audit-evidence` 下出现 U/T23 之外的命名空间。
 * 为什么改：本会话编排模型 = **一个工作树、多 lane、写集互斥** —— 兄弟 lane 的**合法**产物
 * 不该让本卡入口变红（否则 U20 第 3 步"用 U01 复跑"永远不可执行）。判定是纯函数
 * `classifyWorktree`，每次运行都用**人造越界输入**自证它会红（`proveScopeBoundary`）；
 * 另可单跑 `--self-prove-scope` 把真实 git 输出与"注入一条野路径"的判定摊开看（只读，不写盘）。
 *
 * 判词（stdout 一行，exit 0/1/2）：
 *   `PASS U01 checks=8 failed=0 skipped=0` / `FAIL U01 …` / `BLOCKED U01 …`
 *
 * A01–A08 每条都是**真实断言**（对着证据里的字节与 git 对象算），没有恒真项；
 * A07 的伪造/删除只发生在 `E:\Temp` 的临时副本上，跑完按绝对路径守卫清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  FIXED_IDS, REPO, runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot,
  guardTempPath, safeRemoveTree, Blocked, Truncated,
} from './unify-runner.mjs'

const CARD = 'U01'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)

const BASE_SHA = '2f57b1f2cec02e4128b69497e3b6819d36aa707b'
const BRANCH = 'refactor/unify-20261018'
const MAIN_TREE = 'E:\\workplace\\dsh-whale-sensei'
const MAIN_EV = path.join(MAIN_TREE, 'audit-evidence')
const PACK = 'E:\\workplace\\study'
const TEMP_ROOT = 'E:\\Temp\\u01-s0-dlane'

const ARGV = process.argv.slice(2)
const MODE = ARGV.includes('--verify-baseline') ? 'verify-baseline' : 'collected'
const IS_MUTATION_CHILD = process.env.DSH_WHALE_U01_NO_MUTATION === '1'

/** 本卡写集（相对仓根）。受保护路径清单与它必须**不相交**（A01）。 */
const WRITE_SET = [
  'test/audit/unify-runner.mjs',
  'test/audit/U01.mjs',
  'docs/unify/interfaces.md',
  'docs/unify/baseline.json',
  'docs/unify/receipts/U01.json',
]

/**
 * ── 授权写集并集（A01 的允许面）────────────────────────────────────────────
 * **来源 = `docs/unify/interfaces.md` §6「U01–U20 写集落点」那张表**（逐卡一行，`<br>` 分隔）。
 * 这张常量是 §6 的**逐字拷贝**；A01 每次运行都会把 interfaces.md 现文本里的 §6 表重新解析一遍
 * 再与本常量**逐卡**比（`§6 自检`），不一致即红 —— 所以它不是"自己说了算的清单"，
 * 而是与接口锁互为约束的两份账。
 *
 * 为什么需要它：本会话编排模型 = **一个工作树、多 lane、写集互斥**。U02/U03/U04… 会在这棵树里
 * 陆续产出**它们被授权的**文件（`lib/unify/*.cjs`、`lib/text.js`、`test/audit/U0x.mjs`…）。
 * 若 A01 只放行 U01 自己那 5 条，兄弟 lane 一落地就红，于是 U20 第 3 步「用 U01 复跑」永远不可执行。
 * 判据因此对齐卡面：从「只有我的文件」改成「只有**任何 U 卡**被授权写的文件」—— 这是对齐，不是放宽，
 * 因为**授权并集之外**的未跟踪路径、以及**任何已跟踪文件**的改动，一条都不放行（见 classifyWorktree 与 §6 自检）。
 */
const AUTHORIZED_WRITE_SET = Object.freeze({
  U01: Object.freeze([
    'test/audit/unify-runner.mjs',
    'test/audit/U01.mjs',
    'docs/unify/interfaces.md',
    'docs/unify/baseline.json',
    'docs/unify/receipts/U01.json',
    // 账本同步（P1/P2 授权面，仅 F01 内 PROBE_VERSION 字面量断言那一处 —— 断言对象归 U04 内核，
    // 落点行记在 U01：U04 行的 §6 落点被 U04 的 A08 与卡面写集逐条锁死，T26 不是 U04 的卡面写集）。
    // 依据 docs/unify/authorization.json 的 scope.P2（第 2 条）与 derivedConsequences.C2。
    'test/audit/T26.mjs',
    // 账本登记（decisions 授权面 决-1/决-2/决-5/决-6）：三张 T 卡不是任何 U 卡的卡面写集，
    // 而 A01 的允许面 = §6 全部 U 卡写集并集，故落点行记在 U01。
    // 依据 docs/unify/authorization.json 的 decisions.quoteVerbatim（逐字「全按推荐」）
    // 与 decisions.approvedChanged 的 决-1/决-2（T03 源码字面量同步）、决-5（T12 夹具复制清单）、
    // 决-6（T10 源码字面量最小同步）。判据强度未变：真越界仍必红。
    'test/audit/T03.mjs',
    'test/audit/T12.mjs',
    'test/audit/T10.mjs',
  ]),
  U02: Object.freeze([
    'lib/unify/identity.cjs',
    'test/audit/U02.mjs',
    'docs/unify/receipts/U02.json',
  ]),
  U03: Object.freeze([
    'lib/unify/errors.cjs',
    'lib/unify/ledger-read.cjs',
    'test/audit/U03.mjs',
    'docs/unify/receipts/U03.json',
  ]),
  U04: Object.freeze([
    'lib/unify/text.cjs',
    'lib/unify/plan.cjs',
    'lib/unify/fingerprint.cjs',
    'lib/text.js',
    'lib/plan.js',
    'lib/fingerprint.js',
    'lib/pack-template/tools/pack-text.js',
    'lib/pack-template/tools/plan-map.js',
    'lib/pack-template/tools/fingerprint.js',
    'test/audit/U04.mjs',
    'docs/unify/receipts/U04.json',
  ]),
  U05: Object.freeze([
    'lib/unify/migration.cjs',
    'tools/migrate-pack.mjs',
    'test/audit/U05.mjs',
    'docs/unify/receipts/U05.json',
  ]),
  U06: Object.freeze([
    'lib/unify/commit.cjs',
    'lib/pack-template/tools/ledger-transaction.cjs',
    'tools/recover-ledgers.mjs',
    'test/audit/U06.mjs',
    'docs/unify/receipts/U06.json',
  ]),
  U07: Object.freeze([
    'lib/unify/render.cjs',
    'lib/render.js',
    'lib/render-inputs.js',
    'lib/pack-template/tools/build-lessons.js',
    'test/audit/U07.mjs',
    'docs/unify/receipts/U07.json',
  ]),
  U08: Object.freeze([
    'lib/engine.js',
    'tools/upgrade-pack.mjs',
    'lib/pack-template/tools/publish-policy.cjs',
    'test/audit/U08.mjs',
    'docs/unify/receipts/U08.json',
  ]),
  U09: Object.freeze([
    'lib/unify/pack.cjs',
    'lib/pack-model.js',
    'lib/pack.js',
    'lib/pack-template/tools/lesson-map.js',
    // 账本同步（主持人裁决 C4 的最小写集扩张）：只把 qualified/splitQualified 改走严格内核，
    // 导出面与返回语义逐字不变 —— 依据 authorization.json derivedConsequences.C4。
    'lib/point-ref.js',
    // 账本同步（§12 A 授权面，仅课程身份那一处）：依据 authorization.json scope.A。
    'test/mirror-parity.mjs',
    'test/audit/U09.mjs',
    'docs/unify/receipts/U09.json',
  ]),
  U10: Object.freeze([
    'lib/unify/stage.cjs',
    'lib/intake.js',
    'lib/goal-io.js',
    'lib/teaching-io.js',
    // 账本同步（§12 A 授权面：裸 point 夹具与 latest.vue 等身份预期）：依据 authorization.json scope.A。
    'test/intake.mjs',
    'test/audit/U10.mjs',
    'docs/unify/receipts/U10.json',
  ]),
  U11: Object.freeze([
    'lib/unify/glossary.cjs',
    'lib/glossary.js',
    'lib/glossary-io.js',
    'lib/glossary-edit-io.js',
    'lib/pack-template/assets/build-glossary.js',
    'test/audit/U11.mjs',
    'docs/unify/receipts/U11.json',
  ]),
  U12: Object.freeze([
    'lib/pack-template/tools/offline-server.js',
    'test/audit/U12.mjs',
    'docs/unify/receipts/U12.json',
  ]),
  U13: Object.freeze([
    'lib/author.js',
    'lib/rebuild-job.js',
    'lib/mods/author.js',
    'lib/mods/create.js',
    'lib/mods/plan.js',
    'test/audit/U13.mjs',
    'docs/unify/receipts/U13.json',
  ]),
  U14: Object.freeze([
    'lib/unify/records.cjs',
    'lib/ask.js',
    'lib/ask-io.js',
    'lib/notes-io.js',
    'lib/adjust-io.js',
    'lib/pack-template/tools/drain-questions.js',
    'test/audit/U14.mjs',
    'docs/unify/receipts/U14.json',
  ]),
  U15: Object.freeze([
    'lib/unify/content.cjs',
    'lib/pack-template/tools/build-starmap.js',
    'lib/pack-template/tools/build-lessons-index.js',
    'lib/pack-template/tools/build-glossary-tree.js',
    'lib/pack-template/tools/build-notes.js',
    'lib/pack-template/assets/build-questions.js',
    'test/audit/U15.mjs',
    'docs/unify/receipts/U15.json',
  ]),
  U16: Object.freeze([
    'lib/client.js',
    'lib/starter.js',
    'lib/mods/catalog.js',
    'lib/mods/goal.js',
    'lib/mods/intake.js',
    'lib/mods/starter.js',
    'lib/mods/pack.js',
    'lib/mods/lessonpack.js',
    // 账本同步（决策 决-3 收编：导出链路的身份构造/解析归 U16）：依据 authorization.json 的 decisions.approvedChanged。
    'lib/pack-export.js',
    'lib/pack-template/assets/ask.js',
    'lib/pack-template/assets/notes.js',
    'lib/pack-template/assets/adjust.js',
    'lib/pack-template/starmap/main.js',
    'test/audit/U16.mjs',
    'docs/unify/receipts/U16.json',
  ]),
  U17: Object.freeze([
    'test/audit/U17.mjs',
    'docs/unify/receipts/U17.json',
  ]),
  U18: Object.freeze([
    'lib/unify/evidence.cjs',
    'lib/evidence.js',
    'lib/evidence-io.js',
    'lib/state.js',
    'lib/state-scan.js',
    'lib/gate.js',
    'lib/pack-template/tools/ask-server.js',
    'test/audit/U18.mjs',
    'docs/unify/receipts/U18.json',
  ]),
  U19: Object.freeze([
    'lib/pack-scaffold.js',
    'package.json',
    'lib/pack-template/tools/engine-policy.cjs',
    'lib/pack-template/tools/offline-bootstrap.js',
    'tools/sync-unify-core.mjs',
    'docs/unify-mirrors.md',
    'lib/pack-template/tools/unify/identity.cjs',
    'lib/pack-template/tools/unify/errors.cjs',
    'lib/pack-template/tools/unify/ledger-read.cjs',
    'lib/pack-template/tools/unify/commit.cjs',
    'lib/pack-template/tools/unify/text.cjs',
    'lib/pack-template/tools/unify/plan.cjs',
    'lib/pack-template/tools/unify/fingerprint.cjs',
    'lib/pack-template/tools/unify/render.cjs',
    'lib/pack-template/tools/unify/pack.cjs',
    'lib/pack-template/tools/unify/stage.cjs',
    'lib/pack-template/tools/unify/glossary.cjs',
    'lib/pack-template/tools/unify/records.cjs',
    'lib/pack-template/tools/unify/content.cjs',
    'lib/pack-template/tools/unify/evidence.cjs',
    'test/audit/U19.mjs',
    'docs/unify/receipts/U19.json',
    // 决-B1 / decisions 决-9 的授权面：`FROM_PLUGIN` **只加 14 行登记项**（判据强度不变）。
    // 账本登记在 §6 的 U19 行（见 interfaces.md），常量必须与 §6 逐条一致 —— 否则 A01 的自检红。
    'test/pack-template-rules.mjs',
  ]),
  U20: Object.freeze([
    'test/audit/U20.mjs',
    'docs/unify/receipts/U20.json',
    // 集成修正面（零断言改动，只补输入准备）：T26 迁移夹具必须带上 tools/unify/*.cjs 传递依赖。
    // 与 decisions 决-5 同一类；账本登记在 §6 的 U20 行，常量必须与 §6 逐条一致。
    'test/_t26-migrated-pack.mjs',
    // §12.2 用户裁决后的身份形状替换（三份测试）+ 一行反空转样本修正
    'test/style-mode-author.mjs',
    'test/ask-answer.mjs',
    'test/circle-delete.mjs',
    'test/render-parity.mjs',
    // 深链判据的跨域搭桥（页面域两段 vs 运行态三段）
    'lib/verify.js',
  ]),
})

/** 授权写集并集（拍平去重）：**已跟踪**文件的改动只许落在这里。 */
const AUTHORIZED_PATHS = Object.freeze([...new Set(Object.values(AUTHORIZED_WRITE_SET).flat())])
const AUTHORIZED_PATH_SET = new Set(AUTHORIZED_PATHS)

/** 用户点名的 11 个变化文件（U-SPEC §1）。接口锁必须逐条覆盖。 */
const KEY_FILES = [
  'lib/pack-model.js', 'lib/ask.js', 'lib/ask-io.js', 'lib/state.js', 'lib/state-scan.js',
  'lib/fingerprint.js', 'lib/glossary.js', 'lib/glossary-io.js', 'lib/client.js',
  'package.json', 'tools/upgrade-pack.mjs',
]

/** U-SPEC §3 的检索种子 + 拟新增码。种子必须**全部**在真实码表里出现（U01 逐项提取）。 */
const SEED_CODES = [
  'IO_ERROR', 'CONFIRM_REQUIRED', 'PLAN_STALE', 'MIGRATION_PLAN_REQUIRED', 'ID_NOT_ALLOWED',
  'ID_REQUIRED', 'PLAN_REQUIRED', 'STAGE_FAILED', 'MIGRATION_NOT_CONFIRMED', 'MIGRATION_PLAN_STALE',
  'MIGRATION_NOTHING', 'MIGRATION_DONE', 'MIGRATION_FAILED',
]
const PROPOSED_CODES = ['ID_AMBIGUOUS', 'MIGRATION_REQUIRED', 'LEDGER_INVALID', 'LOCK_BUSY', 'RECOVERY_REQUIRED']

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/* ── 两个根必须分开：**读取根恒为采集目录**，`--evidence-root=` 只改写入位置 ─────
 * 语义缺陷修正（S0 收尾）：以前带 `--evidence-root=` 时把**读取根**也改成了该目录，
 * 于是 `--evidence-root=<一个空的新目录>` 会误报「缺原始证据 git-state.json」——
 * 而那个参数的本意只是"这次运行的产物写到哪儿"。
 * 现在：
 *   read  = <repo>/audit-evidence/U01     （采集材料；**恒定**，不因任何参数移动）
 *   write = 默认同 read（落 read/runs/<id>）；给了 `--evidence-root=` 就落该目录/runs/<id>
 * 唯一例外：A07 的变异复核子进程必须读**临时副本**（否则"改副本"就测不到），
 * 由父进程独占设置 DSH_WHALE_U01_READ_ROOT，且必须落在本卡临时根下、读写同一份副本。
 * 写入根仍一律走 resolveEvidenceRoot 的越界守卫（未放宽任何一条）。
 */
const COLLECTED_EV = path.join(REPO, 'audit-evidence', CARD)
const READ_ROOT_ENV = 'DSH_WHALE_U01_READ_ROOT'

function resolveRoots() {
  const hit = ARGV.find((a) => a.startsWith('--evidence-root='))
  const override = process.env[READ_ROOT_ENV]
  if (override !== undefined && override !== '') {
    // 只认 A07 变异子进程；父进程/别的入口设了它一律拒绝（防"换个根去读自己伪造的证据"）
    if (!IS_MUTATION_CHILD) return { ok: false, error: `${READ_ROOT_ENV} 只许 A07 变异子进程使用（父进程不认）` }
    const g = guardTempPath(override, { parent: TEMP_ROOT })
    if (!g.ok) return { ok: false, error: `${READ_ROOT_ENV} 越界：${g.error}` }
    if (!hit) return { ok: true, read: g.abs, write: g.abs, source: 'mutation-copy' }
    const w = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
    if (!w.ok) return { ok: false, error: w.error }
    if (path.resolve(w.root) !== g.abs) {
      return { ok: false, error: `变异子进程只许读写同一份临时副本：read=${g.abs} write=${path.resolve(w.root)}` }
    }
    return { ok: true, read: g.abs, write: g.abs, source: 'mutation-copy' }
  }
  if (!hit) return { ok: true, read: COLLECTED_EV, write: COLLECTED_EV, source: 'default' }
  // 读：仍是采集目录；写：只动 --evidence-root=（守卫照旧，越界即拒）
  const g = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
  if (!g.ok) return { ok: false, error: g.error }
  return { ok: true, read: COLLECTED_EV, write: g.root, source: 'argv' }
}

const ROOTS = resolveRoots()
const EV = ROOTS.ok ? ROOTS.read : null    // 读取根（采集材料，恒定）
const OUT = ROOTS.ok ? ROOTS.write : null  // 写入根（本次运行产物；--evidence-root= 只动它）

function evPath(rel) {
  if (!EV) throw new Blocked(`证据根解析失败：${ROOTS.error}`)
  return path.join(EV, rel)
}

function readEvText(rel) {
  const p = evPath(rel)
  if (!fs.existsSync(p)) throw new Blocked(`缺原始证据：${rel}（${p}）`)
  return fs.readFileSync(p, 'utf8')
}

function readEvJson(rel) {
  const text = readEvText(rel)
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Truncated(`原始证据不是完整 JSON（被截断/损坏）：${rel} —— ${e.message}`)
  }
}

function readDoc(rel) {
  const p = path.join(REPO, rel)
  if (!fs.existsSync(p)) throw new Blocked(`缺 tracked 出口：${rel}`)
  return fs.readFileSync(p, 'utf8')
}

function readDocJson(rel) {
  const text = readDoc(rel)
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Truncated(`tracked 出口不是完整 JSON：${rel} —— ${e.message}`)
  }
}

const eq = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg || '不相等'}：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败') }
const sameSet = (a, b, msg) => eq([...a].sort().join(','), [...b].sort().join(','), msg)

/** 只读 git（唯一被允许的外部命令：本入口不跑全量、不碰活包） */
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}`)
  return String(r.stdout ?? '')
}

/** 证据文件索引（文件名 → 字节数/sha256）；A04/A08 用它做"证据自洽"的底账 */
function indexEvidence() {
  if (!EV || !fs.existsSync(EV)) throw new Blocked(`证据目录不存在：${EV}`)
  const out = []
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name === 'runs') continue // 本入口自己的运行产物不算"采集材料"
        walk(p, r)
        continue
      }
      const buf = fs.readFileSync(p)
      out.push({ file: r, bytes: buf.length, sha256: sha256(buf) })
    }
  }
  walk(EV, '')
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 授权面（A01 的判据核心）—— 全部是纯函数，可被人造输入直接证伪
 * ══════════════════════════════════════════════════════════════════════ */

/** §6 表里"看起来像路径"的记号：含 `/`，或带文件扩展名（`package.json` 这种没斜杠的落点也要收） */
const PATH_TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const looksLikePath = (s) => PATH_TOKEN_RX.test(s) && (s.includes('/') || /\.[A-Za-z]{2,4}$/.test(s))

/**
 * 把 `docs/unify/interfaces.md` 的 **§6 表**重新解析成 `Map<卡号, 路径[]>`。
 * 只认表格行 `| U01 | … |`，只取反引号里的路径记号；`† A01` 这类用例 ID 不含斜杠也没扩展名，自然被略过。
 * 纯函数：输入文本 → 结构（不改任何东西）。
 */
function parseSection6(text) {
  const out = new Map()
  let inSection = false
  for (const line of String(text).split('\n')) {
    if (/^##\s*6\./.test(line)) { inSection = true; continue }
    if (inSection && /^##\s/.test(line)) break
    if (!inSection) continue
    const m = /^\|\s*(U\d\d)\s*\|(.*)\|/.exec(line)
    if (!m) continue
    const card = m[1]
    const toks = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter(looksLikePath)
    out.set(card, [...new Set(toks)])
  }
  return out
}

/**
 * §6 自检：常量 ↔ 接口锁的**两份账**必须逐卡逐条一致。
 * 这条一红，说明"授权面"没有权威来源（要么 §6 被改了，要么常量被手改了）——两种都不许静默通过。
 */
function assertAuthorizedSetMatchesInterfaces() {
  const parsed = parseSection6(readDoc('docs/unify/interfaces.md'))
  assert(parsed.size === 20, `§6 自检：解析出来的卡只有 ${parsed.size} 张（应为 20）—— 表格形状变了`)
  sameSet([...parsed.keys()], Object.keys(AUTHORIZED_WRITE_SET), '§6 自检：卡清单与 interfaces.md 不一致')
  for (const [card, paths] of parsed) {
    sameSet(paths, AUTHORIZED_WRITE_SET[card] ?? [], `§6 自检：${card} 的写集落点与接口锁不一致（改§6 就要同步常量，反之亦然）`)
  }
  return parsed
}

/** porcelain 的 XY → 人话（只用于违规项点名，不参与判定） */
function statusWord(code) {
  const x = String(code ?? '').trim()
  if (x === 'A' || x === '??') return 'added'
  if (x === 'D') return 'deleted'
  if (x === 'R') return 'renamed'
  if (x === 'M') return 'modified'
  return x ? 'changed' : 'unknown'
}

/** `git status --porcelain=v1` 的一行行 → { trackedChanges, untracked }（纯函数） */
function splitPorcelain(lines) {
  const trackedChanges = []
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
    trackedChanges.push({ code, path: rest, from })
  }
  return { trackedChanges, untracked }
}

/** 未跟踪项的额外允许面（**并集之外**的补充，见 A01 注释与卡面） */
const UNTRACKED_ALLOW_RULES = Object.freeze([
  { id: 'plan-cards', why: 'U 卡计划文件（cards/U*.md；不 add、不删）', test: (p) => /^cards\/U[A-Z0-9-]*\.md$/.test(p) },
  { id: 'unify-docs', why: 'U 系列 tracked 出口（docs/unify/**）', test: (p) => p === 'docs/unify' || p.startsWith('docs/unify/') },
  { id: 'evidence', why: '各卡原始证据命名空间（audit-evidence/**，已 gitignore；含 T23 这个 wording 套件写的既知例外）', test: (p) => p === 'audit-evidence' || p.startsWith('audit-evidence/') },
])

/**
 * 授权面判定（**纯函数**：不读盘、不跑 git、没有副作用）。
 *   已跟踪（改/删/增/改名）：路径必须在 §6 并集里 —— 一条都不许落在外面。
 *   未跟踪：路径 ∈ §6 并集 ∪ cards/U*.md ∪ docs/unify/** ∪ audit-evidence/**。
 * 返回 violated 明细（空数组 = 在授权面内），便于既做断言又做自证。
 */
function classifyWorktree({ trackedChanges = [], untracked = [] } = {}) {
  const violations = []
  for (const c of trackedChanges) {
    // 索引（stage）里出现任何改动即红：本系列每张卡都被要求"不 git add / 不提交"，
    // 所以"已跟踪文件被**新增**"这条与"改/删"同等对待，一律不放行（连授权并集也不放行 staging）。
    if (String(c.code)[0] !== ' ') {
      violations.push({
        kind: 'staged-change', path: c.path,
        why: '索引里出现了改动（已 git add）—— 本系列每张卡都不许 add/提交；若确有 lane 这么做，需要主持人裁决，不许静默通过',
      })
      continue
    }
    if (!AUTHORIZED_PATH_SET.has(c.path)) {
      violations.push({
        kind: `tracked-${statusWord(c.code)}`, path: c.path,
        why: '已跟踪文件被改/删/增，而该路径不在任何 U 卡的授权写集里（§6）',
      })
    }
    if (c.from && !AUTHORIZED_PATH_SET.has(c.from)) {
      violations.push({
        kind: 'tracked-renamed-from', path: c.from,
        why: '重命名的来源路径不在任何 U 卡的授权写集里（§6）',
      })
    }
  }
  for (const p of untracked) {
    if (AUTHORIZED_PATH_SET.has(p)) continue
    if (UNTRACKED_ALLOW_RULES.some((r) => r.test(p))) continue
    violations.push({
      kind: 'untracked-out-of-union', path: p,
      why: '未跟踪路径不在任何 U 卡的授权写集里（§6），也不在 cards/U*.md / docs/unify/ / audit-evidence/ 之内',
    })
  }
  return {
    violations,
    tracked: trackedChanges.map((c) => c.path),
    untracked: untracked.slice(),
    staged: violations.filter((v) => v.kind === 'staged-change').map((v) => v.path),
    trackedOutsideUnion: violations.filter((v) => v.kind.startsWith('tracked-')).map((v) => v.path),
    untrackedOutOfUnion: violations.filter((v) => v.kind === 'untracked-out-of-union').map((v) => v.path),
  }
}

/**
 * A01 的**红路径本体**：授权面一旦越界就把这张卡判红。
 * `--self-prove-scope` 也调这一个函数（喂"真实 git 输出 + 注入的野路径"），
 * 所以"注入野路径 → A01 红"是同一条代码，不是另写一遍的演示。
 */
function assertScopeClean(scope) {
  eq(scope.staged.length, 0,
    `索引（git add）里出现了改动：${scope.staged.slice(0, 5).join(', ')} —— 本系列每张卡都不许 add/提交`)
  eq(scope.trackedOutsideUnion.length, 0,
    `已跟踪文件被改/删/增，且路径不在任何 U 卡授权写集里：${scope.trackedOutsideUnion.slice(0, 5).join(', ')}`)
  eq(scope.untrackedOutOfUnion.length, 0,
    `未跟踪项里出现了 U 卡授权写集之外的路径：${scope.untrackedOutOfUnion.slice(0, 5).join(', ')}`)
  eq(scope.violations.length, 0,
    `授权面之外的变化：${scope.violations.slice(0, 5).map((v) => `${v.path}(${v.kind})`).join(' | ')}`)
}

/**
 * 自证：授权面判定**必须真的会红**。
 * 用**人造输入**逐条钉死两个方向 ——
 *   ① 现在这棵多 lane 树的形状（兄弟 lane 的合法产物）必须**放行**（否则入口又不可复验）；
 *   ② 授权面之外的野路径/已跟踪改动必须**判越界**（否则"对齐"就变成了"放宽"）。
 * 这些用例在每次运行都跑；任何一条被改成恒真，A01 当场红。
 */
function proveScopeBoundary() {
  const allowed = [
    [' M lib/text.js', 'U04 正在改的已跟踪件'],
    ['?? lib/unify/identity.cjs', 'U02 的新增内核'],
    ['?? lib/unify/ledger-read.cjs', 'U03 的新增内核'],
    ['?? lib/unify/fingerprint.cjs', 'U04 的新增内核'],
    ['?? test/audit/U04.mjs', '兄弟卡的专项入口'],
    ['?? docs/unify/receipts/U04.json', '兄弟卡的回执'],
    ['?? cards/U04.md', '计划文件'],
    ['?? audit-evidence/U02/window.json', '兄弟卡原始证据'],
    ['?? audit-evidence/T23/wording.json', 'T23 这个 wording 套件的既知例外'],
    ['?? lib/pack-template/tools/unify/text.cjs', 'U19 的生成件'],
    [' M package.json', 'U19 独占的包声明'],
    [' M lib/point-ref.js', 'U09 经主持人裁决 C4 的已跟踪件（只改 qualified/splitQualified 的内部委托）'],
    [' M test/mirror-parity.mjs', 'U09 的 §12 A 授权面（仅课程身份那一处）'],
    [' M test/intake.mjs', 'U10 的 §12 A 授权面（仅裸 point 夹具与 latest.vue 等身份预期）'],
  ]
  for (const [line, why] of allowed) {
    const r = classifyWorktree(splitPorcelain([line]))
    eq(r.violations.length, 0, `自证失败：授权面内的变化被判越界了（${why}：${line}）→ ${r.violations.map((v) => v.kind + ':' + v.path).join(',')}`)
  }
  const rejected = [
    ['?? lib/whatever.js', 'untracked-out-of-union'],
    ['?? scripts/x.mjs', 'untracked-out-of-union'],
    ['?? .tmp-run-all-result.json', 'untracked-out-of-union'],
    ['?? stray.txt', 'untracked-out-of-union'],
    ['?? docs/unify2/x.json', 'untracked-out-of-union'],
    ['?? audit-evidence2/x.json', 'untracked-out-of-union'],
    ['?? test/audit/TXX.mjs', 'untracked-out-of-union'],
    [' M test/_pack.mjs', 'tracked-modified'],
    [' M lib/adapters/jvm.js', 'tracked-modified'],
    [' D test/all.mjs', 'tracked-deleted'],
    ['A  cards/U01.md', 'staged-change'],
    ['A  test/audit/X01.mjs', 'staged-change'],
    ['M  lib/text.js', 'staged-change'],
  ]
  for (const [line, kind] of rejected) {
    const r = classifyWorktree(splitPorcelain([line]))
    eq(r.violations.length, 1, `自证失败：越界路径没被判成一条违规（${line}）→ ${JSON.stringify(r.violations)}`)
    eq(r.violations[0].kind, kind, `自证失败：越界种类不对（${line}）`)
  }
  // 混合输入：一条野路径 + 一堆合法产物 → 只抓那一条（不许一红就全红、也不许被合法的淹掉）
  const mixed = classifyWorktree(splitPorcelain([
    ' M lib/text.js', '?? lib/unify/identity.cjs', '?? docs/unify/receipts/U03.json', '?? scripts/x.mjs',
  ]))
  eq(mixed.violations.length, 1, '自证失败：混合输入里应当只抓出那一条野路径')
  eq(mixed.violations[0].path, 'scripts/x.mjs', '自证失败：混合输入抓错了对象')
}

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 固定基线 / 分支 / 两树 / 冻结状态 / 受保护路径清单
 * ══════════════════════════════════════════════════════════════════════ */
async function A01() {
  const gs = readEvJson('git-state.json')
  eq(gs.ok, true, 'git-state 采集必须成功')
  eq(gs.head, BASE_SHA, '采集时 HEAD 必须是固定执行基线')
  eq(gs.baseSha, BASE_SHA, '基线 SHA 不一致')
  eq(gs.branch, BRANCH, '分支必须是 refactor/unify-20261018')
  eq(gs.trackedDirtyCount, 0, '不允许有 tracked 改动')
  eq(gs.worktreeList.length, 2, 'git worktree list 必须仍是 2 条')
  for (const want of ['dsh-whale-sensei', 'dsh-whale-sensei-unify']) {
    assert(gs.worktreeList.some((l) => l.includes(want)), `两树列表里缺 ${want}`)
  }
  assert(gs.worktreeList.every((l) => /2f57b1f/.test(l) || /2f57b1f/.test(String(l).split('\n')[1] ?? '')), '两棵树都该停在基线 2f57b1f')
  // 未跟踪计划文件：**不要求消失**，但必须是 cards/U*.md 那批计划，且没被 add
  // （派发说明写"24 个"，实测 23 个 —— 按 git 实测登记，见 baseline.measuredDiff）
  eq(gs.untrackedPlanFiles.length, 23, '未跟踪的计划文件实测 23 个 cards/U*.md')
  assert(gs.untrackedPlanFiles.every((f) => /^cards\/U[A-Z0-9-]*\.md$/.test(f)), '未跟踪项里出现了计划文件以外的东西')

  // 真实 git 事实（不是 SPEC 的「110」）：两基线之间 108 个文件变化，11 个重点文件都在其中
  eq(gs.changedFileCount, 108, '两基线之间实测 108 个文件变化（SPEC 写 110，按实测登记）')
  eq(gs.keyFilesInDiff.length, 11, '用户点名的 11 个变化文件必须都在 diff 里')
  sameSet(gs.keyFilesInDiff, KEY_FILES, '11 个重点文件清单不一致')

  // 现状复核（只读 git；不要求后续工作树等于初始源码，那是 --verify-baseline 的事）
  eq(git(['rev-parse', 'HEAD']).trim(), BASE_SHA, '当前 HEAD 已偏离固定基线')
  eq(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), BRANCH, '当前分支已偏离')

  // 授权面的权威来源先对齐：常量 ↔ interfaces.md §6 必须逐卡逐条一致
  // （不一致 = 根本没有"授权面"可言，此时后面两条"在授权面内"的放行就没有依据）
  assertAuthorizedSetMatchesInterfaces()

  // 判据：只允许**任何 U 卡被授权写的文件**出现（见 AUTHORIZED_WRITE_SET 的注释：对齐卡面，不是放宽）。
  // 用 -uall：未跟踪目录要展开成文件，否则 `?? lib/unify/` 这种目录形态没法与 §6 逐条对账。
  const porcelain = git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean)
  const scope = classifyWorktree(splitPorcelain(porcelain))
  assertScopeClean(scope)
  // 双源对账：`git diff --name-status HEAD`（工作树+索引 vs 提交）与 status 的 tracked 部分
  // 必须是**同一批路径** —— 两套账不一致本身就是坏信号（比如索引被绕过、或 status 被参数削弱）。
  const diffPaths = git(['diff', '--name-status', 'HEAD']).split('\n').filter(Boolean)
    .map((l) => l.split(/\t/).slice(-1)[0].trim())
  sameSet(diffPaths, scope.tracked, 'git diff --name-status HEAD 与 git status 的 tracked 部分不是同一批路径（两套账不一致）')
  // 判定本身必须**真的会红**（人造输入逐条钉死；恒真守卫在这里被拆掉）
  proveScopeBoundary()

  // 受保护路径清单：既有测试 / T 审计卡 / 既有证据 / 库与工具 / 包声明
  const protectedPaths = collectProtected()
  assert(protectedPaths.length >= 60, `受保护路径清单太短（${protectedPaths.length}）—— 采集可能漏了目录`)
  const clash = WRITE_SET.filter((p) => protectedPaths.includes(p))
  eq(clash.length, 0, `本卡写集与受保护路径相交：${clash.join(',')}`)
  for (const p of ['test/all.mjs', 'test/run-all.mjs', 'test/_result.mjs', 'test/_pack.mjs',
    'test/_suite-manifest.mjs', 'test/_t26-migrated-pack.mjs', 'test/pack-template-rules.mjs',
    'test/audit/harness.mjs', 'test/audit/release.mjs', 'test/audit/release-exit-code.mjs',
    'test/audit/T01.mjs', 'lib/pack-model.js', 'tools/upgrade-pack.mjs', 'package.json']) {
    assert(protectedPaths.includes(p), `受保护路径清单里缺 ${p}`)
  }

  // 本树里 audit-evidence 只应有本卡命名空间（不覆盖任何既有 T/发布证据）
  const evRoot = path.join(REPO, 'audit-evidence')
  assert(fs.existsSync(evRoot), 'audit-evidence 目录不存在（A08 要求显式创建）')
  const others = fs.readdirSync(evRoot).filter((n) => n !== CARD)
  // 已登记的例外：`test/wording.mjs:65` 每次运行都把话术快照写进 <repo>/audit-evidence/T23/。
  // 这是**本窗口唯一一次全量**带来的副作用，不是本卡写集；判据是"它必须在窗口内产生"。
  // 兄弟 lane 的命名空间（U02–U20）按同一棵树多 lane 的模型放行 —— 它们各自只许写自己的那份；
  // 这里的判据是"名字形状"，**不是**"内容不重要"：谁能写哪份由 §6 那张表管（A01 的授权面）。
  const U_NAMESPACE_RX = /^U(?:0[1-9]|1\d|20)$/
  // 第二类已登记的例外：**真实存在的 T 卡**的证据目录（`test/audit/T<NN>.mjs` 在盘上）。
  // 决-1/决-5/决-6/决-9/P2 之后 T 卡由别的卡合法运行，它们留下的证据目录属各自 T 卡（T01/T10/T12/T26…）。
  // **不是**"T 一律放行"：没有对应 `test/audit/T<NN>.mjs` 的 T 目录、任何非 T 非 U 目录仍然红。
  const isRealT = (d) => /^T\d{2}$/.test(d) && fs.existsSync(path.join(REPO, 'test', 'audit', `${d}.mjs`))
  const unexpectedOf = (list) => list.filter((n) => n !== 'T23' && !U_NAMESPACE_RX.test(n) && !isRealT(n))
  const unexpected = unexpectedOf(others)
  eq(unexpected.length, 0, `audit-evidence 下出现了无人认领的条目（U01–U20 / T23 / 真实存在的 T 卡之外）：${unexpected.join(',')}`)
  // 反空转：既不是 U 命名空间、也没有对应 T 卡入口的名字必须被这条判据抓住。
  eq(unexpectedOf(['U01', 'T23', 'T01', 'TXX-nobody']).join(','), 'TXX-nobody',
    'audit-evidence 归属判据的自证失败（无人认领的条目必须被判出来，真实存在的 T 卡必须放行）')
  if (others.includes('T23')) {
    const mt = fs.statSync(path.join(evRoot, 'T23')).mtimeMs
    const g = readEvJson('full-gate/run.json')
    const rs = Date.parse(g.startedAtLocal)
    assert(mt >= rs - 60000 && mt <= rs + g.ms + 60000,
      'audit-evidence/T23 不是那次全量运行期间产生的（来源不明，需阻断）')
  }

  if (MODE === 'verify-baseline') {
    eq(git(['cat-file', '-t', BASE_SHA]).trim(), 'commit', '固定基线不是提交对象')
    // 基线必须是当前 HEAD（不允许后来把基线挪走）
    eq(git(['rev-parse', 'HEAD']).trim(), BASE_SHA)
  }
}

function collectProtected() {
  const out = []
  const add = (rel) => { if (!out.includes(rel)) out.push(rel) }
  const list = (dir) => {
    const abs = path.join(REPO, dir)
    if (!fs.existsSync(abs)) return []
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => (dir ? `${dir}/${e.name}` : e.name))
  }
  for (const f of list('test')) add(f)
  for (const f of list('test/audit')) add(f)
  for (const f of list('tools')) add(f)
  for (const f of list('')) add(f)
  // lib 递归
  const walkLib = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walkLib(path.join(abs, e.name), r)
      else add(r)
    }
  }
  if (fs.existsSync(path.join(REPO, 'lib'))) walkLib(path.join(REPO, 'lib'), 'lib')
  // 本卡写集里的文件是**新增**的，不属于「既有受保护路径」（受保护 = 本来就在、不许动）
  return out.filter((x) => !WRITE_SET.includes(x))
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 本窗口唯一一次全量门槛（产物完整 + 内容口径前后相同）
 * ══════════════════════════════════════════════════════════════════════ */
async function A02() {
  const run = readEvJson('full-gate/run.json')
  eq(run.packRoot, PACK, '跑的是活包 E:\\workplace\\study')
  eq(run.code, 1, '实测全量门槛退出码是 1（红）')
  eq(run.signal, null, '不允许被信号打断')
  eq(run.timedOut, false, '不允许超时')
  eq(run.rerunCount, 1, '本窗口只允许跑一次')
  eq(run.resultFileExists, true, 'run-all 机器结果必须落在本卡证据目录里')
  eq(JSON.stringify(run.argv), JSON.stringify(['node', path.join(REPO, 'test', 'all.mjs'), `--pack=${PACK}`, '--mode=real']),
    '命令必须逐字是 node test/all.mjs --pack=… --mode=real（参数数组，不拼 shell 串）')
  assert(Number(run.ms) > 1000, `门槛跑得太快不像真跑（${run.ms}ms）`)

  const stdout = readEvText('full-gate/stdout.txt')
  const stderr = readEvText('full-gate/stderr.txt')
  eq(Buffer.byteLength(stdout, 'utf8'), run.stdoutBytes, 'stdout 字节数与记录不一致（被截断/改过）')
  eq(Buffer.byteLength(stderr, 'utf8'), run.stderrBytes, 'stderr 字节数与记录不一致（被截断/改过）')
  assert(stdout.trimEnd().endsWith('=== 判词：红 ==='), 'stdout 里没有实测判词行（或判词被改）')
  assert(/课程包闸门：35 \/ 38 通过/.test(stdout), 'stdout 里闸门数字不对')
  assert(/插件套件　：56 套 · 2883 条断言/.test(stdout), 'stdout 里套件数字不对')
  assert(/子进程退出码：闸门 1 · 套件 1/.test(stdout), 'stdout 里子进程退出码不对')
  assert(/跳过 2 项/.test(stdout), 'stdout 里 skip 明细不见了')
  assert(stderr.includes('[test-context] mode=real pack=E:\\workplace\\study'), 'stderr 里没有实测上下文行')

  // 子套件机器结果：run-all 落的逐套执行记录，56 套一套不少
  eq((run.childrenDirs || []).length, 1, '逐套执行记录目录应当恰好 1 个（跑了一次）')
  eq((run.suites || []).length, 56, '逐套执行记录套数不对')
  const missing = (run.suites || []).filter((s) => typeof s.exitCode !== 'number' && s.exitCode !== null)
  eq(missing.length, 0, `有套件没有退出码：${missing.map((s) => s.id).join(',')}`)

  // 窗口：内容口径相同 + 唯一差异 .git/index（如实登记，不粉饰全清单口径）
  const pre = readEvJson('live-pack-pre.total.json')
  const post = readEvJson('live-pack-post.total.json')
  eq(pre.entries, post.entries, '窗口前后条目数变了')
  eq(pre.files, post.files, '窗口前后文件数变了')
  eq(pre.bytes, post.bytes, '窗口前后总字节数变了')
  const delta = readEvJson('live-pack-window-delta.json')
  eq(delta.onlyPre.length, 0, '窗口后少了路径（活包被删东西）')
  eq(delta.onlyPost.length, 0, '窗口后多了路径（活包被写东西）')
  eq(delta.changedPaths.length, 1, `窗口内变化的路径不止一个：${delta.changedPaths.map((c) => c.path).join(',')}`)
  eq(delta.changedPaths[0].path, '.git/index', '唯一允许的差异是 git 的 stat 缓存控制文件')
  eq(delta.changedPaths[0].bytesBefore, delta.changedPaths[0].bytesAfter, '.git/index 字节数也变了 —— 不是单纯的 stat 缓存刷新')
  eq(delta.contentManifest.same, true, '内容口径（排除 .git 控制文件）必须相同')
  eq(delta.attribution.evidence.indexMtimeInsideWindow, true, '.git/index 的 mtime 不在窗口内 —— 归因不成立')

  // tracked 基线文件里的数字必须与证据一致（篡改任一方向都会被这条抓住）
  const bl = readDocJson('docs/unify/baseline.json')
  eq(bl.base.sha, BASE_SHA)
  eq(bl.fullGate.exitCode, run.code, 'baseline.json 记的退出码与证据不一致')
  eq(bl.fullGate.suites, run.suites.length, 'baseline.json 记的套数不一致')
  eq(bl.fullGate.stderrBytes, run.stderrBytes)
  eq(bl.fullGate.stdoutBytes, run.stdoutBytes)
  eq(bl.fullGate.rerunCount, 1)
  eq(bl.livePack.window.contentManifestSame, true)
  eq(bl.livePack.window.fullManifestSame, false, '全清单口径本来就不相同（.git/index），不许记成相同')
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 逐套对账：闸门 / 套件集合 / 断言量 / 失败项 / skipped 明细
 * ══════════════════════════════════════════════════════════════════════ */
async function A03() {
  const sb = readEvJson('full-gate/suite-baseline.json')
  const bl = readDocJson('docs/unify/baseline.json')
  eq(sb.suiteCount, 56, '套件数必须是实测的 56')
  eq(sb.suites.length, 56, '逐套记录条数对不上套件数')

  // 红套件：候选六红必须**实测存在**，且如实登记实测多出来的那条
  const redIds = sb.failedSuites.map((s) => s.id)
  const six = ['challenge-gate', 'pack-model', 'brief', 'practice', 'parity-registry', 'pack-scaffold']
  for (const id of six) assert(redIds.includes(id), `候选六红里的 ${id} 实测不见了 —— 需要解释`)
  sameSet(redIds, ['brief', 'challenge-gate', 'pack-model', 'pack-scaffold', 'parity-registry', 'practice', 'settings-teaching'],
    '红套件清单必须是实测的 7 条')
  assert(redIds.includes('settings-teaching'), '实测多出的第七条红（settings-teaching）必须如实登记')
  for (const s of sb.failedSuites) {
    assert(s.exitCode === 1, `${s.id} 红套件退出码应为 1（实得 ${s.exitCode}）`)
    assert((s.redLines?.length ?? 0) + (s.failLines?.length ?? 0) + (s.machineFailIds?.length ?? 0) > 0, `${s.id} 红了却没有失败项名（对不上账）`)
    if (typeof s.failed === 'number' && s.failed > 0) assert(s.failed >= 1)
  }

  // 断言量：两种口径都记（run-all 自报 vs 逐套摘要相加），差额要有解释，不许抹平
  eq(bl.fullGate.assertions.reportedByRunAll, 2883, 'run-all 自报断言量必须与 stdout 一致')
  eq(bl.fullGate.assertions.sumOfPerSuite.passed, sb.assertionSumFromSuites.passed, '逐套摘要相加的通过数不一致')
  eq(bl.fullGate.assertions.sumOfPerSuite.failed, sb.assertionSumFromSuites.failed, '逐套摘要相加的失败数不一致')
  assert(typeof bl.fullGate.assertions.reconciliation === 'string' && bl.fullGate.assertions.reconciliation.length > 20,
    '两种断言口径的差额必须有书面解释（不许静默抹平）')

  // skipped：2 条，ID 与理由都要在
  eq(sb.skips.length, 2, 'skipped 必须恰是 2 条')
  const skipKeys = sb.skips.map((s) => `${s.suite}:${s.skip.split(' :: ')[0]}`)
  assert(skipKeys.includes('practice:practice:026'), `skip 明细里缺 practice:026（实得 ${skipKeys.join(',')}）`)
  assert(sb.skips.some((s) => s.suite === 'visual'), 'skip 明细里缺 visual')
  for (const s of sb.skips) assert(/ :: /.test(s.skip), 'skip 必须带理由，不能只留 ID')
  eq(bl.fullGate.skipped.count, 2)
  eq(bl.fullGate.skipped.ids.length, 2)

  // 课程包闸门：35/38，三个失败项点名（闸门原始逐项输出不由入口落盘 —— 这是登记过的边界）
  eq(bl.courseGate.passed, 35, '闸门通过数必须是实测 35')
  eq(bl.courseGate.total, 38, '闸门总数必须是实测 38')
  eq(bl.courseGate.failed.length, 3, '闸门失败项必须是监测到的 3 条')
  for (const name of ['offline-server.test.mjs', 'skill-draft-sync.test.mjs', 'notes-card.test.mjs']) {
    assert(bl.courseGate.failed.some((f) => f.includes(name)), `闸门失败项里缺 ${name}`)
  }
  assert(typeof bl.courseGate.boundary === 'string' && bl.courseGate.boundary.length > 20,
    '闸门逐项原始输出的边界必须写清（入口不落盘它，本卡不重跑）')

  // 假定 vs 实测：假定必须原样留档，且不得被当成判据
  eq(bl.assumptions.gate, '38/38', '假定闸门数字要原样留档')
  eq(bl.assumptions.suites, 51, '假定套件数要原样留档')
  eq(bl.assumptions.assertions, 2469, '假定断言量要原样留档')
  eq(bl.assumptions.skipped, 2, '假定 skipped 要原样留档')
  sameSet(bl.assumptions.redSuites, six, '假定六红要原样留档')
  eq(bl.assumptions.exitCode, 1)
  assert(Array.isArray(bl.measuredDiff) && bl.measuredDiff.length >= 3, '实测与假定的差异要逐条登记')
  assert(bl.measuredDiff.some((d) => /56/.test(d) && /51/.test(d)), '差异里要点明套件数 51 → 56')
  assert(bl.measuredDiff.some((d) => /2883/.test(d) || /2469/.test(d)), '差异里要点明断言量')
  assert(bl.measuredDiff.some((d) => /35/.test(d) && /38/.test(d)), '差异里要点明闸门 38/38 → 35/38')
  assert(bl.measuredDiff.some((d) => /settings-teaching/.test(d)), '差异里要点明多出的第七条红')

  // 逐套机器记录完整性：每套都有退出码 + 至少一条可对账的东西
  for (const s of sb.suites) {
    assert(typeof s.exitCode === 'number' || s.exitCode === null, `${s.id} 缺退出码`)
    const hasSummary = Number.isInteger(s.passed) && Number.isInteger(s.failed)
    const hasMachine = !!s.machine
    assert(hasSummary || hasMachine, `${s.id} 既没有摘要也没有机器结果（对不上账）`)
    if (s.machine) {
      eq(s.machine.failed > 0, s.exitCode === 1, `${s.id} 机器结果的失败数与退出码矛盾`)
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 两个 tracked 出口可进仓、无私人正文、与原始证据互相校验
 * ══════════════════════════════════════════════════════════════════════ */
async function A04() {
  const iface = readDoc('docs/unify/interfaces.md')
  const bl = readDocJson('docs/unify/baseline.json')
  const lock = readEvJson('source-lock.json')
  const extract = readEvJson('interface-extract.json')

  assert(iface.length > 8000, `interfaces.md 太短（${iface.length} 字节），不像完整的接口锁`)
  eq(bl.schema, 'whale-unify-baseline/1', 'baseline.json 的 schema 不对')
  eq(bl.scope, 'unresolved', 'baseline.json 的 scope 必须是 unresolved（§12 未裁决）')

  // ① 源文件锁：11 个重点文件 + 另读落点，路径与 sha256 三方一致（证据 / baseline / interfaces.md）
  const lockMap = new Map(lock.files.map((f) => [f.path, f.sha256]))
  const blMap = new Map((bl.sourceLock?.files ?? []).map((f) => [f.path, f.sha256]))
  eq(blMap.size, lockMap.size, 'baseline.json 的源文件锁条数与原始证据不一致')
  for (const [p, h] of lockMap) {
    eq(blMap.get(p), h, `源文件锁 ${p} 的 sha256 与原始证据不一致`)
    assert(iface.includes(p), `interfaces.md 没有覆盖 ${p}`)
    assert(iface.includes(h), `interfaces.md 里 ${p} 的 sha256 与采集值不一致`)
  }
  for (const p of KEY_FILES) {
    assert(lockMap.has(p), `源文件锁缺用户点名的 ${p}`)
    assert(blMap.has(p), `baseline 源文件锁缺 ${p}`)
  }

  // ② --verify-baseline 才把锁对到**提交对象**（默认模式不要求工作树等于初始源码）
  if (MODE === 'verify-baseline') {
    for (const [p, h] of lockMap) {
      const buf = spawnSync('git', ['cat-file', 'blob', `${BASE_SHA}:${p}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
      if (buf.status !== 0) throw new Error(`git cat-file 取不到基线对象 ${p}`)
      eq(sha256(buf.stdout), h, `${p} 的锁与基线提交对象不符（锁记错了对象）`)
    }
  }

  // ③ 接口覆盖：每个重点文件的**真实导出名**都要在 interfaces.md 里出现（不是"写了文件名"就算）
  for (const f of KEY_FILES) {
    const ex = extract.exportsByFile[f] ?? []
    if (!ex.length) {
      // 无 ESM 导出的三件（懒 CJS 客户端 / package.json / CLI）用结构标记核对
      const markers = {
        'lib/client.js': ['__ModuleLoader__', "exports.inject", "exports.apply"],
        'package.json': ['dsh.distribution.mode', '"version"', '"0.4.0"'],
        'tools/upgrade-pack.mjs': ['--plan', '--apply', '--plan-digest', 'PLAN ok=true digest='],
      }[f] ?? []
      assert(markers.length > 0, `${f} 没有导出却是重点文件 —— 需要登记结构标记`)
      for (const m of markers) assert(iface.includes(m), `interfaces.md 缺 ${f} 的结构标记 ${m}`)
      continue
    }
    const names = ex.map((e) => (e.text.match(/(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/) ?? [])[1]).filter(Boolean)
    assert(names.length > 0, `${f} 的导出名解析失败`)
    const missing = names.filter((n) => !iface.includes(n))
    eq(missing.length, 0, `interfaces.md 漏了 ${f} 的导出：${missing.slice(0, 5).join(',')}`)
  }

  // ④ 错误码：种子必须全部真实存在，拟新增码必须有查重结论，码值表不许凭空编
  const codes = (extract.codes ?? []).map((c) => c.code)
  assert(codes.length >= 60, `真实码表太短（${codes.length}）—— 采集可能漏了形状`)
  for (const seed of SEED_CODES) {
    assert(codes.includes(seed), `检索种子 ${seed} 在真实码表里没找到（不该漏）`)
    assert(iface.includes(seed), `interfaces.md 的错误码表缺 ${seed}`)
  }
  for (const p of PROPOSED_CODES) {
    assert(iface.includes(p), `interfaces.md 缺拟新增码 ${p} 的查重结论`)
    assert(!codes.includes(p), `拟新增码 ${p} 与现有码值重名了 —— 必须阻断相关卡`)
  }
  assert(/查重/.test(iface), 'interfaces.md 必须写明拟新增码的查重结论')
  // kebab 码族（另一套既有码，不能视而不见）
  for (const k of ['stale-snapshot', 'criteria-not-met', 'evidence-insufficient', 'missing-ref', 'halo-mismatch']) {
    assert(iface.includes(k), `interfaces.md 漏了 kebab 码族的 ${k}`)
  }

  // ⑤ 模板登记：单一清单 + 目录骨架，数字要能与采集到的行数对上
  const tpl = readEvJson('template-registry.json')
  eq(tpl.templateFiles.length, 126, '模板登记行数必须是 126')
  eq(tpl.scaffoldDirs.length, 12, '骨架目录必须是 12')
  assert(iface.includes('TEMPLATE_FILES'), 'interfaces.md 必须登记 TEMPLATE_FILES（U19 独占写权）')
  assert(iface.includes('SCAFFOLD_DIRS'), 'interfaces.md 必须登记 SCAFFOLD_DIRS')
  for (const f of ['tools/path-policy.cjs', 'tools/engine-policy.cjs', 'tools/ledger-transaction.cjs', 'tools/engine-files.cjs']) {
    assert(iface.includes(f), `模板登记必须点名 ${f}`)
  }

  // ⑥ T 复验清单：4 个自动入口 + T29 不编造 + release exit 2 的设计性
  const treg = readEvJson('t-reverify-registry.json')
  eq(treg.registry.length, 28, 'T 卡登记条数必须是 28（T01–T28 有源码入口）')
  eq(treg.tally.autoEntries, 4, '有自动入口的 T 卡必须是实测的 4 张')
  eq(treg.tally.copySafe, 2, '可在副本里安全复验的必须是 2 张（T13/T16）')
  eq(treg.tally.blockedLivePack, 2, '因活包被阻断的必须是 2 张（T23/T25）')
  eq(treg.t29.entryExists, false, 'T29 没有同名入口 —— 不许编造命令')
  eq(treg.t29.frozenVerdict.verdict, 'WAIVED', 'T29 冻结判词是 WAIVED（弃权不是 PASS）')
  assert(iface.includes('T29'), 'interfaces.md 必须写明 T29 无入口、不编造')
  assert(/release/i.test(iface) && /exit\s*2|退出码 2/.test(iface), 'interfaces.md 必须写明 release.mjs exit 2 是设计')
  for (const id of ['T13', 'T16', 'T23', 'T25']) {
    assert(iface.includes(id), `interfaces.md 的 T 复验清单缺 ${id}`)
    assert(iface.includes('--automated-only') || iface.includes('--auto'), 'interfaces.md 要写出自动入口的真实参数（不猜 --auto）')
  }
  // 隔离复验的真实结果也要登记
  const runs = readEvJson('t-reverify-runs.json')
  eq(runs.results.length, 2, '副本里实际复验的 T 自动入口应是 2 条（T13/T16）')
  for (const r of runs.results) {
    eq(r.code, 0, `${r.id} 在隔离副本里应当 PASS（实得退出码 ${r.code}）`)
    eq(r.timedOut, false, `${r.id} 不该超时`)
    assert((r.stdoutTail ?? []).some((l) => /^AUTO-ONLY T\d\d-AUTO checks=\d+ failed=0 skipped=0$/.test(l)),
      `${r.id} 的自动层判词行不完整`)
  }

  // ⑦ 可进仓：无私人正文 / 无本机用户目录 / 没有把聊天记录抄进来
  const PRIVATE = [
    [/[A-Za-z]:\\\\?Users\\\\?/i, '本机用户目录路径'],
    [/AppData/i, 'Windows 用户 AppData 路径'],
    [/<(?:user|human)>/i, '聊天占位符'],
    [/transcript/i, '对话转录'],
  ]
  for (const [rx, what] of PRIVATE) {
    assert(!rx.test(iface), `interfaces.md 含${what}（不可进仓）`)
    assert(!rx.test(JSON.stringify(bl)), `baseline.json 含${what}（不可进仓）`)
  }
  for (const [name, text] of [['interfaces.md', iface], ['baseline.json', readDoc('docs/unify/baseline.json')]]) {
    const longLine = text.split('\n').find((l) => l.length > 2000)
    assert(!longLine, `${name} 有超长行（像把正文贴进来了，${longLine ? longLine.length : 0} 字符）`)
  }
  // 学生正文/课程正文的标志物不许出现在 tracked 文档里
  for (const marker of ['第1题：带 @Entity', 'learning-records/intake.jsonl 的内容']) {
    assert(!iface.includes(marker), `interfaces.md 里出现了私人正文标志物：${marker}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · §12 两处冲突 + 未裁决授权 + pointKey/lessonKey 现状与 U09 唯一收敛
 * ══════════════════════════════════════════════════════════════════════ */
async function A05() {
  const iface = readDoc('docs/unify/interfaces.md')
  const bl = readDocJson('docs/unify/baseline.json')
  const rc = readDocJson('docs/unify/receipts/U01.json')

  // §12 两处冲突实据：逐行锚点都要在（行号会漂，按断言原文写）
  assert(iface.includes('test/mirror-parity.mjs'), 'interfaces.md 必须登记 §12 冲突①（mirror-parity）')
  assert(iface.includes('a.anchor'), '§12 冲突① 要写出断言原文 a.anchor')
  assert(iface.includes('spring-boot/0001'), '§12 冲突① 要写出旧预期 spring-boot/0001')
  assert(iface.includes('test/intake.mjs'), 'interfaces.md 必须登记 §12 冲突②（intake）')
  assert(iface.includes('read1.latest.vue'), '§12 冲突② 要写出断言原文 read1.latest.vue')
  assert(/未裁决|unresolved/.test(iface), 'interfaces.md 必须写明授权未裁决')

  // 授权状态：只许 unresolved，且不许出现"已授权"的自我授权
  eq(bl.scope, 'unresolved')
  eq(rc.scope, 'unresolved')
  eq(bl.authorization.status, 'unresolved', 'baseline 的授权状态必须是 unresolved')
  eq(rc.authorization.status, 'unresolved', 'receipt 的授权状态必须是 unresolved')
  for (const [name, text] of [['interfaces.md', iface], ['baseline.json', JSON.stringify(bl)], ['receipt', JSON.stringify(rc)]]) {
    assert(!/已获授权|用户已选\s*A|用户已选\s*B|authorized:\s*true/.test(text), `${name} 里出现了"已经授权"的自我声明（§12 未裁决）`)
  }
  for (const id of ['U09', 'U10', 'U14']) {
    assert(JSON.stringify(bl).includes(id), `baseline 要登记 ${id} 在未裁决下为 BLOCKED`)
  }

  // pointKey/lessonKey：既有公开导出 → U02 严格内核暂存 → U09 唯一委托收敛；禁止第三份
  assert(/pointKey\(circle,\s*point\)/.test(iface), 'interfaces.md 要写出 pointKey(circle, point) 的真实签名')
  assert(/lessonKey\(circle,\s*point,\s*number\)/.test(iface), 'interfaces.md 要写出 lessonKey(circle, point, number) 的真实签名')
  assert(iface.includes('lib/pack-model.js'), 'pointKey/lessonKey 的落点必须是 lib/pack-model.js')
  assert(/U02/.test(iface) && /暂存/.test(iface), 'interfaces.md 要写明 U02 只做严格内核暂存')
  assert(/U09/.test(iface) && /(唯一|收敛)/.test(iface), 'interfaces.md 要写明 U09 是唯一委托收敛责任方')
  assert(/禁止第三份|不得.*第三份|第三份实现/.test(iface), 'interfaces.md 必须写明"禁止第三份实现"')
  // 现状第二条构造点（point-ref.js 的 qualified）—— 这是"双实现"的实证，必须登记
  assert(iface.includes('lib/point-ref.js'), 'interfaces.md 必须登记 point-ref.js 现有的第二处构造点')
  assert(iface.includes('qualified'), 'interfaces.md 要写出 point-ref.js 里的 qualified() 名字')
  assert(iface.includes('splitQualified'), 'interfaces.md 要写出 point-ref.js 里的 splitQualified() 名字')
  // 回执里也要有这条现状与责任
  assert(JSON.stringify(rc).includes('pointKey'), 'receipt 接口消费版本里要有 pointKey/lessonKey 的现状')
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 异步拒绝 / 缺多重复 ID / 空用例 / 超时 / 截断 都不能 PASS；
 *       且本入口不重跑全量、不碰活包
 * ══════════════════════════════════════════════════════════════════════ */
async function A06() {
  const okBody = async () => { await Promise.resolve(); return true }
  const all = (override = {}) => FIXED_IDS.map((id) => ({ id, run: Object.prototype.hasOwnProperty.call(override, id) ? override[id] : okBody }))

  // ① 基线：八项都真做完才是 PASS
  const good = await runCard(CARD, FIXED_IDS, all())
  eq(good.status, 'PASS', `基线用例应当 PASS（实得 ${good.status}：${good.line}）`)
  eq(good.line, `PASS ${CARD} checks=8 failed=0 skipped=0`)
  eq(good.code, 0)

  // ② 真异步拒绝：async 体里 throw —— 不得因为"返回值是 Promise"就被记 pass
  const rejected = await runCard(CARD, FIXED_IDS, all({ A03: async () => { await Promise.resolve(); throw new Error('异步失败') } }))
  eq(rejected.status, 'FAIL', 'async 体里抛错必须 FAIL（不能误判 pass）')
  eq(rejected.code, 1)
  eq(rejected.cases.find((c) => c.id === 'A03').actual, 'fail')

  // ③ 空回调 / 没有 body
  for (const [label, override] of [['空函数体', () => {}], ['没有 body', null]]) {
    const r = await runCard(CARD, FIXED_IDS, all({ A02: override }))
    eq(r.status, 'FAIL', `${label}不得 PASS`)
    assert(r.cases.find((c) => c.id === 'A02').note.length > 0, `${label} 要点名原因`)
  }

  // ④ 缺 / 多 / 重复 ID
  const missing = await runCard(CARD, FIXED_IDS, all().slice(0, 7))
  eq(missing.status, 'FAIL', '缺一条固定用例不得 PASS')
  const extra = await runCard(CARD, FIXED_IDS, [...all(), { id: 'A09', run: okBody }])
  eq(extra.status, 'FAIL', '多出一条固定集合外用例不得 PASS')
  const dup = await runCard(CARD, FIXED_IDS, [...all(), { id: 'A01', run: okBody }])
  eq(dup.status, 'FAIL', '重复注册同一 ID 不得 PASS')
  const idsDrift = await runCard(CARD, ['A01'], all())
  eq(idsDrift.status, 'FAIL', '固定 ID 集合被改小也不得 PASS')

  // ⑤ 空用例表
  const empty = await runCard(CARD, FIXED_IDS, [])
  eq(empty.status, 'FAIL', '空用例不得 PASS')

  // ⑥ 超时 / 截断 / skip
  const timeout = await runCard(CARD, FIXED_IDS, all({ A05: async () => { await new Promise((r) => setTimeout(r, 300)); return true } }), { timeoutMs: 60 })
  eq(timeout.status, 'FAIL', '超时不得 PASS')
  assert(/超时/.test(timeout.cases.find((c) => c.id === 'A05').note), '超时要点名')
  const truncated = await runCard(CARD, FIXED_IDS, all({ A06: async () => ({ truncated: true, note: '自报截断' }) }))
  eq(truncated.status, 'FAIL', '截断不得 PASS')
  const skipped = await runCard(CARD, FIXED_IDS, all({ A06: async () => 'skip' }))
  eq(skipped.status, 'FAIL', 'skip 不得 PASS（skip ≠ pass）')
  eq(skipped.skipped, 1)

  // ⑦ BLOCKED 走 exit 2（缺料/授权），不与 FAIL 混
  const blocked = await runCard(CARD, FIXED_IDS, all(), { blocked: '缺料' })
  eq(blocked.status, 'BLOCKED')
  eq(blocked.code, 2)
  const blockedByThrow = await runCard(CARD, FIXED_IDS, all({ A01: async () => { throw new Blocked('证据缺失') } }))
  eq(blockedByThrow.status, 'BLOCKED', '用例抛 Blocked 必须整卡 BLOCKED')

  // ⑧ 本入口自己不许重跑全量、不许碰活包（结构断言 + 证据断言）
  const src = fs.readFileSync(SELF, 'utf8')
  // 结构证据：本入口**没有能力**再跑一次门槛 —— 不 spawn 全量/逐套入口、不拼 gate 命令行参数
  assert(!/spawnSync\([^)]*(?:all|run-all)\.mjs/.test(src), 'U01.mjs 不许 spawn 全量或逐套入口（默认只验采集材料）')
  const OTHER_PROC = new RegExp(['exec', 'File', 'Sync|exec', 'Sync|fork\\('].join(''))
  assert(!OTHER_PROC.test(src), 'U01.mjs 除 spawnSync 外不许用别的进程 API（exec*/fork）')
  const PACK_ARG = new RegExp(['--pack', '=E:'].join(''))
  assert(!PACK_ARG.test(src), 'U01.mjs 不许拼门槛的命令行参数（pack=…）')
  const spawns = [...src.matchAll(/spawnSync\(\s*([^,]+),/g)].map((m) => m[1].trim())
  assert(spawns.length > 0, 'U01.mjs 只该用 git 读对象 + 起自己复核变异')
  for (const target of spawns) {
    assert(/^'git'$/.test(target) || /^process\.execPath$/.test(target),
      `U01.mjs 只允许 spawn git / 自己的 node 子进程，实得 ${target}`)
  }
  assert(/spawnSync\(process\.execPath, \[SELF,/.test(src), '用 node 起子进程时只允许跑本文件（变异复核），不许跑别的入口')
  assert(!/fs\.\w+\(\s*PACK\b/.test(src), 'U01.mjs 不许对活包做文件操作（PACK 只用于字符串比对）')
  assert(!/path\.join\(\s*PACK/.test(src), 'U01.mjs 不许拼活包路径')

  // 采集材料没被这次运行改写（runs/ 之外一个字节都没动）
  const idx = readEvJson('evidence-index.json')
  const now = indexEvidence()
  const nowMap = new Map(now.map((e) => [e.file, e.sha256]))
  const drift = idx.files.filter((f) => nowMap.get(f.file) !== f.sha256)
  eq(drift.length, 0, `采集材料在验证期间被改动：${drift.map((d) => d.file).join(',')}`)
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 临时副本上的伪造/删除必须被拒绝（且干净副本必须通过）
 * ══════════════════════════════════════════════════════════════════════ */
async function A07() {
  // ① 判词行解析器自己的拒绝面（不依赖任何外部进程）
  const forge = [
    ['PASS U01 checks=7 failed=0 skipped=0', 'checks 不是 8'],
    ['PASS U01 checks=8 failed=1 skipped=0', 'failed 不为 0'],
    ['PASS U01 checks=8 failed=0 skipped=1', 'skipped 不为 0'],
    ['pass U01 checks=8 failed=0 skipped=0', '判词大小写/单词不对'],
    ['PASS U01 checks=8 failed=0', '字段残缺'],
    ['PASS U02 checks=8 failed=0 skipped=0', '卡号不对'],
    ['OK U01 checks=8 failed=0 skipped=0', '判词词不对'],
  ]
  for (const [line, why] of forge) {
    assert(parseVerdictLine(line) === null, `伪造判词没被拒：${why} —— ${line}`)
  }
  const realLine = parseVerdictLine('PASS U01 checks=8 failed=0 skipped=0')
  assert(realLine && realLine.status === 'PASS' && realLine.checks === 8, '真判词应当解析得出来')

  // ② 目录归属守卫：危险目标一律拒删
  const guards = [
    [TEMP_ROOT, '临时根自身'],
    ['E:\\Temp', 'E:\\Temp 本身'],
    ['E:\\workplace', '工作区父目录'],
    ['C:\\', '系统盘根'],
    [path.join(TEMP_ROOT, '..', 'u01-other'), '不在声明父目录下'],
  ]
  for (const [target, why] of guards) {
    const g = guardTempPath(target, { parent: TEMP_ROOT })
    assert(g.ok === false, `清理守卫放行了危险目标：${why}（${target}）`)
  }
  assert(guardTempPath(path.join(TEMP_ROOT, 'U01-mut-probe'), { parent: TEMP_ROOT }).ok === true,
    '清理守卫拒绝了合法目标（恒拒绝同样是坏守卫）')

  if (IS_MUTATION_CHILD) {
    // 变异子进程：父进程负责跑变异；这里把"子进程也得有真实断言"补上
    assert(parseVerdictLine('BLOCKED U01 缺料') !== null, 'BLOCKED 判词应当可解析')
    return
  }

  // ③ 在 E:\Temp 的临时副本上做变异：干净副本必须 PASS，三种伪造必须被拒
  const base = createEvidenceCopy('U01-mut-clean')
  try {
    const clean = runSelfOnCopy(base)
    eq(clean.code, 0, `干净副本应当 PASS（实得 ${clean.code}：${clean.line}）`)
    eq(clean.line.trim(), 'PASS U01 checks=8 failed=0 skipped=0', '干净副本的判词应当与正式入口逐字相同')

    const mutations = [
      ['del-evidence', (dir) => fs.rmSync(path.join(dir, 'full-gate', 'stdout.txt'), { force: true })],
      ['forge-verdict', (dir) => {
        const f = path.join(dir, 'full-gate', 'stdout.txt')
        fs.writeFileSync(f, '=== 两本账 ===\n  课程包闸门：38 / 38 通过\n  插件套件　：51 套 · 2469 条断言\n\n=== 判词：绿 ===\n', 'utf8')
      }],
      ['forge-exit', (dir) => {
        const f = path.join(dir, 'full-gate', 'run.json')
        const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
        doc.code = 0
        doc.timedOut = false
        doc.rerunCount = 1
        fs.writeFileSync(f, JSON.stringify(doc, null, 2), 'utf8')
      }],
      ['forge-lock', (dir) => {
        const f = path.join(dir, 'live-pack-pre.total.json')
        const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
        doc.manifestSha256 = '0'.repeat(64)
        fs.writeFileSync(f, JSON.stringify(doc, null, 2), 'utf8')
      }],
    ]
    for (const [tag, mutate] of mutations) {
      const dir = createEvidenceCopy(`U01-mut-${tag}`)
      try {
        mutate(dir)
        const r = runSelfOnCopy(dir)
        assert(r.code !== 0, `变异「${tag}」没有被拒绝（退出码 ${r.code}：${r.line}）`)
        assert(/^(FAIL|BLOCKED) U01 /.test(r.line.trim()), `变异「${tag}」的判词不是 FAIL/BLOCKED：${r.line.trim()}`)
        assert(!/^PASS U01 /.test(r.line.trim()), `变异「${tag}」居然 PASS 了`)
      } finally {
        cleanupCopy(dir)
      }
    }
  } finally {
    cleanupCopy(base)
  }
}

const VERDICT_RX = /^(PASS|FAIL|BLOCKED) (U\d\d)(?: checks=(\d+) failed=(\d+) skipped=(\d+))?(?: .*)?$/

/** 判词行解析（A07 的"伪造判词必须被拒"就落在它上面；A02 用它校 stdout 的判词） */
function parseVerdictLine(line) {
  const m = VERDICT_RX.exec(String(line ?? '').trim())
  if (!m) return null
  const [, status, card, checks, failed, skipped] = m
  if (card !== CARD) return null
  if (status === 'PASS') {
    if (checks === undefined) return null
    if (Number(checks) !== FIXED_IDS.length) return null
    if (Number(failed) !== 0) return null
    if (Number(skipped) !== 0) return null
  }
  return {
    status, card,
    checks: checks === undefined ? null : Number(checks),
    failed: failed === undefined ? null : Number(failed),
    skipped: skipped === undefined ? null : Number(skipped),
  }
}

/** 造一份证据副本（只读复制采集材料；不含 runs/，避免自嵌套）
 *  半途失败（例如读取根不可用）必须自己把半成品清掉 —— 否则会在临时根里留下
 *  `U01-mut-*` 空目录，让下一次运行的 A08 残留检查看到"不是自己造的东西"。 */
function createEvidenceCopy(name) {
  const dest = path.join(TEMP_ROOT, name)
  const g = guardTempPath(dest, { parent: TEMP_ROOT })
  if (!g.ok) throw new Error(g.error)
  fs.rmSync(dest, { recursive: true, force: true })
  try {
    fs.mkdirSync(dest, { recursive: true })
    for (const e of fs.readdirSync(EV, { withFileTypes: true })) {
      if (e.name === 'runs') continue
      const from = path.join(EV, e.name)
      const to = path.join(dest, e.name)
      if (e.isDirectory()) fs.cpSync(from, to, { recursive: true })
      else fs.copyFileSync(from, to)
    }
  } catch (e) {
    safeRemoveTree(dest, { parent: TEMP_ROOT })
    throw e
  }
  return dest
}

function cleanupCopy(dir) {
  const r = safeRemoveTree(dir, { parent: TEMP_ROOT })
  if (!r.removed) throw new Error(`临时副本清理失败：${r.error}`)
}

/** 用变异副本当**读取根**再跑一次本入口（子进程；禁止再变异，防递归）
 *  读：DSH_WHALE_U01_READ_ROOT=<副本>（否则读到的是采集材料，变异就测不到）
 *  写：`--evidence-root=<副本>`（产物留在副本里，随副本整树清理；不进采集证据） */
function runSelfOnCopy(dir) {
  const r = spawnSync(process.execPath, [SELF, `--evidence-root=${dir}`], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DSH_WHALE_U01_NO_MUTATION: '1', [READ_ROOT_ENV]: dir },
  })
  if (r.error) throw new Error(`子进程跑不起来：${r.error.message}`)
  const out = String(r.stdout ?? '')
  const lines = out.split('\n').filter(Boolean)
  eq(lines.length, 1, `本入口 stdout 必须只有一行判词（实得 ${lines.length} 行）`)
  return { code: r.status, line: lines[0] ?? '', stderr: String(r.stderr ?? '') }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 证据目录显式创建 / 清理守卫 / T 证据、主树、活包字节不变
 * ══════════════════════════════════════════════════════════════════════ */
async function A08() {
  eq(fs.existsSync(path.join(REPO, 'audit-evidence', CARD)), true, '本卡证据目录必须显式存在')
  const st = fs.statSync(path.join(REPO, 'audit-evidence', CARD))
  eq(st.isDirectory(), true)

  // 采集材料自洽：索引里每一份都在，且字节/sha256 都对得上
  const idx = readEvJson('evidence-index.json')
  assert(idx.files.length >= 15, `采集材料太少（${idx.files.length}）—— 不像完整证据`)
  for (const f of idx.files) {
    const p = evPath(f.file)
    assert(fs.existsSync(p), `索引里的证据不见了：${f.file}`)
    const buf = fs.readFileSync(p)
    eq(sha256(buf), f.sha256, `证据 ${f.file} 的内容与索引不符`)
    eq(buf.length, f.bytes, `证据 ${f.file} 的字节数与索引不符`)
  }

  // T 证据 / 主树：内容锁 + mtime 预算（写入必然更新 mtime，所以这条能证"本卡没往那儿写"）
  const lock = readEvJson('main-tree-t-evidence-lock.json')
  eq(lock.totals.newerThanWindowStart, 0, '主树冻结证据里已经出现晚于窗口开始的 mtime')
  const WINDOW_START = Date.parse(lock.windowStartIso)
  let checked = 0
  for (const e of lock.entries) {
    if (e.type !== 'file') continue
    const abs = path.join(MAIN_TREE, 'audit-evidence', e.path)
    assert(fs.existsSync(abs), `主树冻结证据不见了：${e.path}`)
    const st2 = fs.statSync(abs)
    assert(st2.mtimeMs <= WINDOW_START, `主树冻结证据的 mtime 晚于本卡窗口开始（被写过）：${e.path}`)
    if (checked < 200) {
      eq(sha256(fs.readFileSync(abs)), e.sha256, `主树冻结证据内容变了：${e.path}`)
      checked += 1
    }
  }
  assert(checked >= 100, `主树冻结证据抽样太少（${checked}）`)
  eq(git(['rev-parse', 'HEAD'], { cwd: MAIN_TREE }).trim(), BASE_SHA, '审计主树 HEAD 被动了')
  // 审计主树（E:\workplace\dsh-whale-sensei）**仍然要求整树干净** —— 它不是那棵"多 lane 共用"的树，
  // 没有任何 U 卡被授权往里写；所以 A01 的授权面对这里不适用，一条都不放宽。
  eq(git(['status', '--porcelain'], { cwd: MAIN_TREE }).split('\n').filter(Boolean).length, 0, '审计主树出现改动')

  // 活包：内容口径在窗口前后相同（第二次采样没有，只有这两次）
  const delta = readEvJson('live-pack-window-delta.json')
  eq(delta.contentManifest.same, true, '活包内容口径变了')
  eq(delta.onlyPost.length + delta.onlyPre.length, 0, '活包在窗口内增删了路径')
  const dev = readEvJson('live-pack-freeze-deviation.json')
  eq(dev.diskFact.engineUpgradeAtLocal, '2026-10-20 00:39:05', '交接偏差的时间必须如实登记')
  assert(String(dev.diskFact.planJson.source).includes('_install-20261020'), '偏差证据要指向那次引擎升级的来源')
  assert(dev.freezeBoundary.honestFreezeSinceLocal.startsWith('2026-10-20 00:39:05'),
    '冻结起点只能从 00:39:05 起算（不许声称自 19:07:56）')
  assert(/1h17m|1 小时 17/.test(dev.freezeBoundary.elapsedSinceEngineUpgrade), '静止时长要按 00:39:05 起算写清')
  const bl = readDocJson('docs/unify/baseline.json')
  assert(JSON.stringify(bl.livePack.freezeBoundary).includes('00:39:05'), 'baseline 的 freezeBoundary 必须写明这条偏差')
  assert(JSON.stringify(bl.livePack.freezeBoundary).includes('_install-20261020'), 'freezeBoundary 要留下引擎升级的来源证据')
  assert(/第三方/.test(JSON.stringify(bl.livePack.freezeBoundary)), 'freezeBoundary 要写明这是第三方写入')

  // ── 偏差 D1 的证词必须已被收窄；D5 必须登记且**逐条可复算**（S0 收尾修正 ③）────────
  const d1 = bl.livePack.deviation
  eq(d1.id, 'D1', 'livePack.deviation 仍是 D1（冻结边界那条）')
  const d1Text = d1.evidence.join('\n')
  assert(/02:06:41/.test(d1Text), 'D1 的 mtime 普查必须标明普查时刻（窗口前 02:06:41）')
  assert(/只证明/.test(d1Text) && /D5/.test(d1Text), 'D1 的 mtime 普查要收窄成"仅证明窗口开始前无晚于 00:39:05 的写"并指向 D5')
  assert(!/之后没再写过/.test(d1Text), 'D1 里"之后没再写过"那句常驻论断已被推翻，必须收窄——不许还留着')

  const d5s = bl.livePack.deviations
  assert(Array.isArray(d5s) && d5s.length >= 1, 'baseline 必须登记偏差 D5（livePack.deviations）')
  const d5 = d5s.find((d) => d?.id === 'D5')
  assert(d5, '偏差登记表里缺 D5')
  for (const key of ['what', 'evidence', 'attribution', 'consequence', 'handling']) {
    assert(key in d5, `D5 缺字段 ${key}`)
  }
  eq(d5.handling, '不修活包、不重跑、如实登记。')
  assert(/内容口径/.test(d5.consequence) && /mtime/.test(d5.consequence),
    'D5 的结论必须写明"冻结口径用内容口径（sha256），不能用 mtime"')
  assert(/preset-switch/.test(d5.attribution) && /shape-pipeline/.test(d5.attribution),
    'D5 的归因必须点名核实后的真实写者（preset-switch / shape-pipeline），不许停在 --check 线索')
  assert(/不落盘|一个字节都没写/.test(d5.attribution),
    'D5 的归因必须显式否证 `build-lessons --check` 那条线索（否则旧结论又回来了）')

  // 逐条复算 D5：10 条证据的 sha256 必须同时等于窗口前/后两份逐文件清单（内容口径）
  const preMan = new Map(readEvJson('live-pack-pre.json').entries.filter((e) => e.type === 'file').map((e) => [e.path, e.sha256]))
  const postMan = new Map(readEvJson('live-pack-post.json').entries.filter((e) => e.type === 'file').map((e) => [e.path, e.sha256]))
  const d5Files = (d5.evidence ?? []).filter((e) => e && typeof e === 'object' && typeof e.path === 'string')
  eq(d5Files.length, 10, `D5 必须逐条登记 10 个文件（实得 ${d5Files.length}）`)
  const gateRun = readEvJson('full-gate/run.json')
  const winStart = Date.parse(gateRun.startedAtLocal)
  const winEnd = winStart + Number(gateRun.ms)
  assert(Number.isFinite(winStart) && winEnd > winStart, '窗口起止时间不可解析 —— D5 的 mtime 无从核对')
  for (const f of d5Files) {
    eq(f.sha256, preMan.get(f.path), `D5 的 ${f.path} 与窗口前清单的 sha256 不一致`)
    eq(f.sha256, postMan.get(f.path), `D5 的 ${f.path} 与窗口后清单的 sha256 不一致（同字节重写不成立）`)
    eq(f.sameAsPre, true, `D5 的 ${f.path} 必须标注 sameAsPre=true`)
    eq(f.sameAsPost, true, `D5 的 ${f.path} 必须标注 sameAsPost=true`)
    const t = Date.parse(String(f.mtimeLocal).replace(' ', 'T') + '+08:00')
    assert(Number.isFinite(t), `D5 的 ${f.path} 的 mtime 不可解析：${f.mtimeLocal}`)
    assert(t >= winStart && t <= winEnd,
      `D5 的 ${f.path} 的 mtime 必须落在那次全量窗口内（窗口 ${gateRun.startedAtLocalTz} + ${gateRun.ms}ms，实得 ${f.mtimeLocal}）`)
    assert(/^2026-10-20 02:08:0[34]\.\d{3}$/.test(String(f.mtimeLocal)),
      `D5 的 ${f.path} 的 mtime 必须是实测的 02:08:03–02:08:04 那一簇（实得 ${f.mtimeLocal}）`)
  }

  // 清理守卫：本卡所有临时目录都在唯一临时根下，且没有残留（自己这一次不算残留）
  const tempEntries = fs.existsSync(TEMP_ROOT) ? fs.readdirSync(TEMP_ROOT) : []
  const selfBase = path.basename(EV)
  const stray = tempEntries.filter((n) => n.startsWith('U01-mut-') && n !== selfBase)
  eq(stray.length, 0, `临时副本没清干净：${stray.join(',')}`)

  // 回执必须存在且是 tracked 回执（索引/摘要/写集/判词/边界五项）
  const rc = readDocJson('docs/unify/receipts/U01.json')
  eq(rc.card, CARD)
  eq(rc.status, 'PASS')
  for (const key of ['completion', 'writeSet', 'interfaceConsumption', 'deltas', 'verdict', 'unverified', 'evidenceIndex', 'dependencies']) {
    assert(key in rc, `回执缺字段 ${key}`)
  }
  sameSet(rc.writeSet.map((w) => (w.path ?? w)), WRITE_SET, '回执里的实际写集与卡面写集不一致')
  eq(rc.scope, 'unresolved')
}

/* ── `--self-prove-scope`：把授权面判定摊开给人看（真实 git 输出 + 注入两条野路径）
 * 只读 git；不采集、不跑全量、不碰活包。**不是**本卡的判词入口：它不打印 `PASS/FAIL U01 checks=…`，
 * 任何把它的输出当判词的脚本都读不到那行。 */
if (ARGV.includes('--self-prove-scope')) {
  const lines = []
  const real = git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean)
  const base = classifyWorktree(splitPorcelain(real))
  lines.push(`SELF-PROVE U01 scope: tracked=${base.tracked.length} untracked=${base.untracked.length} violations=${base.violations.length}`)
  for (const v of base.violations) lines.push(`  REAL-VIOLATION ${v.kind} ${v.path}`)
  let pureOk = true
  try {
    proveScopeBoundary()
  } catch (e) {
    pureOk = false
    lines.push(`  PURE-CASES-FAIL ${e?.message ?? e}`)
  }
  lines.push(`SELF-PROVE U01 pure-cases: ${pureOk ? 'ok（人造输入逐条对）' : 'FAIL'}`)
  const injectedLines = [...real, '?? scripts/x.mjs', '?? lib/whatever.js']
  const injected = classifyWorktree(splitPorcelain(injectedLines))
  let wouldFail = '（没有变红 —— 那这条守卫就是坏的）'
  try { assertScopeClean(injected) } catch (e) { wouldFail = e.message }
  lines.push(`SELF-PROVE U01 injected: real-output + 2 wild paths -> violations=${injected.violations.length}`
    + ` -> ${injected.violations.map((v) => `${v.path}(${v.kind})`).join(' , ')}`)
  lines.push(`SELF-PROVE U01 A01-would-fail: ${wouldFail}`)
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(base.violations.length === 0 && pureOk && injected.violations.length === 2
    && /^已跟踪文件|^未跟踪项里出现了/.test(wouldFail) ? 0 : 1)
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

const verdict = await runCard(CARD, FIXED_IDS, CASES, {
  argv: ARGV,
  blocked: ROOTS.ok ? null : ROOTS.error,
})
if (ROOTS.ok) {
  // 只往**写入根**落产物：默认与采集目录同根时仍落 runs/（不覆盖采集材料）
  const dir = path.join(OUT, 'runs', `${CARD}-${MODE}-${process.pid}`)
  writeRunEvidence(verdict, dir)
}
process.exitCode = printVerdict(verdict)
