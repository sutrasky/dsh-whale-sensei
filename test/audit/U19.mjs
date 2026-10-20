/**
 * test/audit/U19.mjs — U19 · 独占随包登记与生成（D lane）
 * ==================================================================
 * 卡面：`cards/U19.md`。判据：固定八项 A01–A08（U-SPEC §6 / unify-runner）。
 *
 * 本卡要证明的四件事：
 *   ① 十四份运行内核副本与 `lib/unify/*.cjs` **逐字节相同**（A01），
 *      且生成器 `tools/sync-unify-core.mjs` 的 `--check` 对「缺件 / 改字节 / 多件 / 空包」**都是红的**（A02）；
 *   ② 这十四个落点**登记成对、分类唯一**：`TEMPLATE_FILES` ↔ 引擎闭包 ↔ `FROM_PLUGIN`（A03）；
 *   ③ 从**空目录**建出来的包不靠手工补件就能加载运行内核（A04），离线骨架与引擎闭包完整，
 *      **迁移专用件 `migration.cjs` 不进运行态内核**（A05）；
 *   ④ 发布清单包含运行内核与**显式迁移 CLI**，而**开发用生成器不是运行依赖**（A06）；
 *      变异必红（A07）；范围、证据与清理守卫（A08）。
 *
 * ⚠️ 本卡曾经在**当前树**上命中停止条件（卡面明令 → BLOCKED，exit 2），不是实现失败：
 *   生成 `lib/pack-template/tools/unify/**` 与把它登记进随包清单，会**必然**撞上三处既有判据 ——
 *   · `test/pack-template-rules.mjs#FROM_PLUGIN`（只读，卡面「一个字不许改」）需要 +14 行，
 *     否则 `test/pack-scaffold.mjs`「运行时清单与规则清单一致」当场由 ok 变 FAIL（实测 89 ≠ 75）；
 *   · `test/audit/U07.mjs` 的 A08 ④ 当时无条件断言 `lib/pack-template/tools/unify/**` **必须不存在**；
 *   · `test/audit/U08.mjs` 的 A06 ⑥ 当时无条件断言 `package.json` 与基线**逐字节相同** ——
 *     而 A06 要求的「显式迁移 CLI 进发布清单」只能靠改 `package.json#files` 做到。
 *   三处都不是本卡写集（或明确只读/frozen），所以当时**不猜、不绕、不越界**：
 *   证据与「最小必要差异」落在冲突台账 `conflict-report.json`，判词 BLOCKED + exit 2。
 *
 * ✅ **现已由第三批授权解除**（交接文件 `E:/Temp/HANDOFF-U-SERIES-20261020.md` §4，用户回复原文「确认」）：
 *   · 决-B1 —— `FROM_PLUGIN` **只加 14 行登记项**（判据强度不变），`TEMPLATE_FILES` 同步 +14;
 *   · 决-B2 —— 决-9 连带的 frozen 判据对齐（U07 A08 ④ 改成「存在 ⇒ 必须自洽」；U08 A06 ⑥ 改成
 *     逐项判据、`files`/`bin` 允许受控增项）；
 *   · 决-B3 —— 十四副本的生成与四处登记必须**同一动作**；
 *   · 决-B4 —— `ENGINE_FILES` +14 的后果（既有课程包被判"缺引擎件"）归 U17，本卡不在活包上动手。
 *   台账里三处冲突保留原样并逐条写明 `resolution`（**改的是授权面，不是删除记载**）。
 *   机械面（生成 / 对拍 / 空包加载 / 变异必红）此前已在 `E:\Temp` 副本里真跑绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot, safeRemoveTree, guardTempPath, Blocked, REPO,
} from './unify-runner.mjs'
import {
  CORE_MODULES, AUTHORITY_REL, MIRROR_REL, MIGRATION_MODULE,
  plan as planSync, write as writeSync,
} from '../../tools/sync-unify-core.mjs'

const CARD = 'U19'
const TEMPLATE_DIR = path.join(REPO, 'lib', 'pack-template')
const AUTHORITY_DIR = path.join(REPO, ...AUTHORITY_REL.split('/'))
const MIRROR_DIR = path.join(REPO, ...MIRROR_REL.split('/'))
const ENGINE_FILES_REL = 'lib/pack-template/tools/engine-files.cjs'
const ENGINE_POLICY_REL = 'lib/pack-template/tools/engine-policy.cjs'
const BOOTSTRAP_REL = 'lib/pack-template/tools/offline-bootstrap.js'
const RULES_REL = 'test/pack-template-rules.mjs'
const PACK_SCAFFOLD_REL = 'lib/pack-scaffold.js'
const GENERATOR_REL = 'tools/sync-unify-core.mjs'
const MIGRATE_CLI_REL = 'tools/migrate-pack.mjs'
const INTERFACES_REL = 'docs/unify/interfaces.md'

/** 镜像件（POSIX，相对仓根）—— 单一来源是生成器的 `CORE_MODULES`，这里只做拼接 */
const MIRROR_RELS = CORE_MODULES.map((m) => `tools/unify/${m}.cjs`)

const require_ = createRequire(import.meta.url)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const read = (rel) => fs.readFileSync(path.join(REPO, ...String(rel).split('/')), 'utf8')
const readBytes = (abs) => fs.readFileSync(abs)
const exists = (rel) => fs.existsSync(path.join(REPO, ...String(rel).split('/')))
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}（实得 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/* ── 本次唯一临时根 + 证据根 ───────────────────────────────────────────── */

const TMP_BASE = path.resolve(os.tmpdir())
const TEMP_ROOT = path.join(TMP_BASE, `u19-${process.pid}`)
const EVIDENCE = resolveEvidenceRoot(process.argv.slice(2), CARD, { repoRoot: REPO })

/* ── 进程内 fs 写守卫（A08 的判据对象）─────────────────────────────────── */

const WRITES = []
const GUARD = { installed: false }
function classifyWrite(abs) {
  const p = path.resolve(String(abs))
  if (EVIDENCE.ok && EVIDENCE.root && (p === path.resolve(EVIDENCE.root) || p.startsWith(path.resolve(EVIDENCE.root) + path.sep))) {
    return { ok: true, owner: '本卡证据根' }
  }
  if (p === TEMP_ROOT || p.startsWith(TEMP_ROOT + path.sep)) return { ok: true, owner: '本次唯一临时根' }
  const rel = path.relative(REPO, p).split(path.sep).join('/')
  return { ok: false, owner: rel.startsWith('..') ? p : rel }
}
function installGuard() {
  if (GUARD.installed) return
  // 记录"**被写的那一侧**"：copy/rename 的源路径不是写点（记源会把"读权威源码"误判成越界写）
  const TARGET_INDEX = { copyFileSync: 1, renameSync: 1 }
  const wrap = (name) => {
    const orig = fs[name]
    fs[name] = function patched(...args) {
      try {
        const target = args[TARGET_INDEX[name] ?? 0]
        if (typeof target === 'string' || target instanceof URL) {
          const abs = target instanceof URL ? target.pathname : target
          WRITES.push({ op: name, abs: path.resolve(String(abs)), owner: classifyWrite(abs).owner, ok: classifyWrite(abs).ok })
        }
      } catch { /* 记录失败不影响真实调用 */ }
      return orig.apply(fs, args)
    }
  }
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync']) wrap(name)
  GUARD.installed = true
}

/* ── 小工具 ────────────────────────────────────────────────────────────── */

/** 沙箱仓根（只含权威内核 + 生成器）：`--check` 的夹具不需要整个仓 */
function makeSyncSandbox(name) {
  const root = path.join(TEMP_ROOT, name)
  const auth = path.join(root, ...AUTHORITY_REL.split('/'))
  const tools = path.join(root, 'tools')
  fs.mkdirSync(auth, { recursive: true })
  fs.mkdirSync(tools, { recursive: true })
  for (const m of CORE_MODULES) fs.copyFileSync(path.join(AUTHORITY_DIR, `${m}.cjs`), path.join(auth, `${m}.cjs`))
  fs.copyFileSync(path.join(REPO, ...GENERATOR_REL.split('/')), path.join(tools, 'sync-unify-core.mjs'))
  return root
}
function runGenerator(root, mode) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'sync-unify-core.mjs'), mode, `--root=${root}`], {
    cwd: root, encoding: 'utf8',
  })
  return { code: r.status, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() }
}
/** 在某个源文件里找一行（按内容找，不写死行号 —— 行号会漂，内容不会）。
 *  多个候选 needle 依次试：相关断言被授权改写后，第一个 needle 可能已经不在，
 *  但**这一处来源差异**仍然必须能被定位（定位不到返回 null，交给调用方判红）。 */
function lineOf(rel, ...needles) {
  const lines = read(rel).split('\n')
  for (const needle of needles) {
    for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(needle)) return i + 1
  }
  return null
}
/** 从 `export const X = [ ... ]` 里抠字符串项（解析用；不执行规则文件里的任何逻辑） */
function quotedItems(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) return []
  const open = src.indexOf('[', at)
  const close = src.indexOf(']', open)
  const block = src.slice(open + 1, close)
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}
/** `package.json#files` 的覆盖判定（`lib` 这类目录项按前缀覆盖） */
function filesCover(files, rel) {
  const posix = String(rel).split(path.sep).join('/')
  return (Array.isArray(files) ? files : []).some((entry) => {
    const e = String(entry).replace(/\/+$/, '')
    return posix === e || posix.startsWith(`${e}/`)
  })
}

/* ── 冲突台账（A03/A06 的 BLOCKED 原因都从这里取，保证"一处算、多处用"）── */

function conflictReport() {
  const rulesSrc = read(RULES_REL)
  const fromPluginLine = (() => {
    const lines = rulesSrc.split('\n')
    for (let i = 0; i < lines.length; i += 1) if (/export const FROM_PLUGIN\s*=\s*\[/.test(lines[i])) return i + 1
    return null
  })()
  return {
    generatedAt: null,
    card: CARD,
    verdict: 'RESOLVED-BY-AUTHORIZATION',
    resolvedBy: '交接文件 E:/Temp/HANDOFF-U-SERIES-20261020.md §4 决-A1 / 决-B1 / 决-B2 / 决-B3（状态：已确认；第三批 11 条全按推荐定案）',
    conflicts: [
      {
        id: 'R-U19-1',
        status: 'resolved',
        resolution: '决-B1（决-9 已预授权）：`FROM_PLUGIN` 追加 14 行 `tools/unify/<模块>.cjs` —— **只加登记项**，不改任何判据强度；`TEMPLATE_FILES` 同步 +14 ⇒ 两份清单重新成对（89 == 89）。',
        what: '登记必然要求改只读的随包规则清单（FROM_PLUGIN 需 +14 行）',
        file: RULES_REL,
        line: fromPluginLine,
        neededRows: MIRROR_RELS,
        minimalDiff: `在 ${RULES_REL}:${fromPluginLine} 的 FROM_PLUGIN 数组里追加：\n` +
          MIRROR_RELS.map((r) => `  '${r}',`).join('\n'),
        whyReadOnly: [
          'cards/U19.md:42「test/pack-template-rules.mjs 不给写权限（旧计划授权与用户禁令冲突），只读运行」',
          '本卡执行令写集：「test/pack-template-rules.mjs（只读，一个字不许改）」',
          'docs/unify/authorization.json scope.A.notAuthorized「test/pack-template-rules.mjs 仍只读，任何卡不得改其断言」',
          '其它卡（U10/U12/U13/U15）的 A08 把该文件放进「永不面」：改它即判越界（U15 回执 notAuthorizedRule 逐字点名）',
        ],
        ifNotPatched: {
          assertion: `${lineOf('test/pack-scaffold.mjs', '运行时清单与规则清单一致') ? `test/pack-scaffold.mjs:${lineOf('test/pack-scaffold.mjs', '运行时清单与规则清单一致')}` : 'test/pack-scaffold.mjs:63'}`,
          measured: 'TEMPLATE_FILES 加 14 行后 89 项 ≠ templatePaths() 75 项 ⇒ 该断言由「ok」变「FAIL」',
          alsoRed: [
            `test/audit/T18.mjs:${lineOf('test/audit/T18.mjs', '运行时清单（TEMPLATE_FILES）与规则清单')}`,
            `test/audit/T20.mjs:${lineOf('test/audit/T20.mjs', '两份清单必须成对')}`,
          ],
          baselineProof: 'U01 全量基线里同一条断言是「ok 运行时清单与规则清单一致（各 75 项）」⇒ 新增红 = U20 明令禁止的「原红内新失败」',
        },
      },
      {
        id: 'R-U19-2',
        status: 'resolved',
        resolution: '决-B2（决-9 连带）：U07 的 A08 ④ 已由「必须不存在」改成「存在 ⇒ 必须自洽于 sync --check（14 件齐全 / 逐字节等于权威 / 无多余件），不存在 ⇒ 仍按原判据」—— 判据不降，且**加了**"本次运行不许写副本目录"这条。',
        what: '生成 lib/pack-template/tools/unify/** 会顶红 U07 的 A08 ④',
        file: 'test/audit/U07.mjs',
        line: lineOf('test/audit/U07.mjs', 'fs.existsSync(mirrorDir)', 'mirrorExists'),
        minimalDiff: '该断言原文：eq(fs.existsSync(mirrorDir), false, …) —— 要么由 U07 的授权面把它改成「U19 之后允许存在」，要么等 U19 之后由一次性授权改写',
        whyReadOnly: [
          'U07 是已完成卡，其 A08 ④ 是 U07 的判据本体（不是本卡能改的写集）',
          '本卡执行令：「其它 test/audit/U*.mjs」在不得改清单里；并要求「跑这 17 张卡确认没有被你顶红」',
        ],
        ifNotPatched: { assertion: 'test/audit/U07.mjs A08 ④', measured: '镜像目录一存在，该 eq 立刻 FAIL ⇒ U07 由 PASS 变 FAIL' },
      },
      {
        id: 'R-U19-3',
        status: 'resolved',
        resolution: '决-B2（决-9 连带）：U08 的 A06 ⑥ 已由「package.json 整文件与基线逐字节相同」改成**逐项判据**（version / private / 依赖面 / 锁文件仍逐字节相同；`files`/`bin` 允许受控增项，且"没有新增条目时原判据原样保留"）。本卡只加 `files: "tools/migrate-pack.mjs"` 一项，不动 version / mode / 依赖 / lockfile。',
        what: '显式迁移 CLI 进发布清单需要改 package.json#files，而 U08 断言 package.json 与基线逐字节相同',
        file: 'test/audit/U08.mjs',
        line: lineOf('test/audit/U08.mjs', 'package.json#files', 'files`/`bin` 白名单', 'package.json'),
        minimalDiff: '在 package.json#files 里追加 "tools/migrate-pack.mjs"（A06 要求「显式迁移 CLI 进发布文件」）',
        whyReadOnly: [
          'package.json 虽在本卡写集内（「只允许改 files/bin 等必要包含关系」），但 U08 的 A06 ⑥ 无条件要求它与基线逐字节相同',
          '本卡执行令同时要求「跑 U08 确认没有被你顶红」⇒ 两条要求互斥',
        ],
        ifNotPatched: { assertion: 'test/audit/U08.mjs A06 ⑥', measured: 'package.json 任一字节变化 ⇒ 该 eq FAIL ⇒ U08 由 PASS 变 FAIL' },
      },
    ],
    mechanicallyReady: {
      note: '在 os.tmpdir() 下的副本里已真跑：补上上述三处（外加 engine-policy/offline-bootstrap 各 +14 行）后，sync --write/--check 全绿、登记成对（89==89）、空包 14 份副本逐字节等于权威且包侧 require 全通。',
      evidence: 'audit-evidence/U19/sandbox/',
    },
  }
}

/* ── A01 ─ 十四份生成副本逐字节等于权威源码 ──────────────────────────── */

async function A01() {
  if (!fs.existsSync(MIRROR_DIR)) {
    throw new Blocked(
      '生成副本目录不存在（lib/pack-template/tools/unify/）：生成被登记冲突阻断 —— ' +
      `登记这 14 份必然要求改只读的 ${RULES_REL}:${lineOf(RULES_REL, 'export const FROM_PLUGIN')}（FROM_PLUGIN +14 行），` +
      '不补则 test/pack-scaffold.mjs 的两份清单一致性断言由 ok 变 FAIL（89≠75）；' +
      '且生成目录一存在 test/audit/U07.mjs 的 A08 ④ 立刻红。详见 audit-evidence/U19/conflict-report.json',
    )
  }
  const p = planSync({ repoRoot: REPO })
  assert(p.authorityMissing.length === 0, `权威源码缺件：${p.authorityMissing.join('、')}`)
  assert(p.ok, `生成副本与权威不一致（${'UNIFY-CORE'}）：${p.problems.join(' | ')}`)
  eq(p.authority.length, CORE_MODULES.length, `权威运行内核必须恰好 ${CORE_MODULES.length} 份`)
  const detail = []
  for (const m of CORE_MODULES) {
    const a = readBytes(path.join(AUTHORITY_DIR, `${m}.cjs`))
    const b = readBytes(path.join(MIRROR_DIR, `${m}.cjs`))
    assert(a.equals(b), `${m}.cjs 与权威不是逐字节相同（长度 ${a.length} vs ${b.length}）`)
    eq(sha256(b), sha256(a), `${m}.cjs 的 sha256 必须与权威同值`)
    detail.push({ module: m, bytes: b.length, sha256: sha256(b) })
  }
  // 迁移专用件**不**成为副本（A05 的同一事实在这里先钉一次）
  assert(!fs.existsSync(path.join(MIRROR_DIR, `${MIGRATION_MODULE}.cjs`)), `${MIGRATION_MODULE}.cjs 不许出现在运行态内核目录`)
  return { files: detail.length, bytes: detail.reduce((n, d) => n + d.bytes, 0), modules: detail }
}

/* ── A02 ─ 缺件 / 改字节 / 多件 / 空包都被 `--check` 拒绝 ─────────────── */

async function A02() {
  const root = makeSyncSandbox('sync-sandbox')
  const cases = []
  const record = (id, r, expectCode) => {
    cases.push({ id, code: r.code, okFlag: /ok=true/.test(r.stdout), stdout: r.stdout.slice(0, 400) })
    eq(r.code, expectCode, `${id} 的退出码`)
    if (expectCode !== 0) assert(/ok=false/.test(r.stdout), `${id} 必须打印 ok=false（实得：${r.stdout}）`)
  }

  record('write-baseline', runGenerator(root, '--write'), 0)
  record('check-baseline', runGenerator(root, '--check'), 0)

  const mirror = path.join(root, ...MIRROR_REL.split('/'))
  // ① 缺件
  fs.unlinkSync(path.join(mirror, 'identity.cjs'))
  record('missing', runGenerator(root, '--check'), 1)
  // ② 改字节（先修回来，再翻一个字节）
  record('restore', runGenerator(root, '--write'), 0)
  const renderPath = path.join(mirror, 'render.cjs')
  const bytes = readBytes(renderPath)
  const mutated = Buffer.concat([bytes, Buffer.from('\n// u19-a02-mutation\n')])
  fs.writeFileSync(renderPath, mutated)
  record('changed-bytes', runGenerator(root, '--check'), 1)
  // ③ 多件（清单外的件 + 迁移件）
  record('restore-2', runGenerator(root, '--write'), 0)
  fs.writeFileSync(path.join(mirror, 'stray.cjs'), 'module.exports = 1\n')
  record('extra-file', runGenerator(root, '--check'), 1)
  fs.writeFileSync(path.join(mirror, `${MIGRATION_MODULE}.cjs`), 'module.exports = {}\n')
  record('migration-extra', runGenerator(root, '--check'), 1)
  // `--write` 要把多出来的件清掉（生成目录 = 生成器的输出，不是堆放处）
  const fixed = runGenerator(root, '--write')
  record('write-prunes-extras', fixed, 0)
  assert(!fs.existsSync(path.join(mirror, 'stray.cjs')) && !fs.existsSync(path.join(mirror, `${MIGRATION_MODULE}.cjs`)),
    '--write 必须清掉镜像目录里多出来的件')
  record('check-after-prune', runGenerator(root, '--check'), 0)
  // ④ 空包（镜像空 / 镜像目录不存在 / 权威缺件）
  for (const f of fs.readdirSync(mirror)) fs.unlinkSync(path.join(mirror, f))
  record('empty-mirror', runGenerator(root, '--check'), 1)
  fs.rmdirSync(mirror)
  record('missing-mirror-dir', runGenerator(root, '--check'), 1)
  fs.unlinkSync(path.join(root, ...AUTHORITY_REL.split('/'), 'plan.cjs'))
  record('authority-missing', runGenerator(root, '--check'), 1)
  return { cases }
}

/* ── A03 ─ 两份登记清单成对且分类唯一 ────────────────────────────────── */

async function A03() {
  const S = await import(pathToFileURL(path.join(REPO, ...PACK_SCAFFOLD_REL.split('/'))).href)
  const R = await import(pathToFileURL(path.join(REPO, ...RULES_REL.split('/'))).href)
  const engine = require_(path.join(REPO, ...ENGINE_FILES_REL.split('/')))
  const buckets = [
    ['FROM_PACK', R.FROM_PACK], ['FROM_SKILL', R.FROM_SKILL],
    ['FROM_PACK_BINARY', R.FROM_PACK_BINARY], ['FROM_PLUGIN', R.FROM_PLUGIN], ['DERIVED', R.DERIVED],
  ]
  const tp = R.templatePaths()

  // ① 分类唯一：每一份镜像件在**至多一个**来源桶里
  const classification = {}
  for (const rel of MIRROR_RELS) {
    const owners = buckets.filter(([, list]) => Array.isArray(list) && list.includes(rel)).map(([name]) => name)
    classification[rel] = owners
    assert(owners.length <= 1, `${rel} 同时落进多个来源桶：${owners.join('/')}（分类必须唯一）`)
  }
  // ② 规则清单覆盖（只读核对）：这是本卡**唯一**允许对 test/pack-template-rules.mjs 做的事
  const missingInRules = MIRROR_RELS.filter((rel) => !tp.includes(rel))
  const missingInRuntime = MIRROR_RELS.filter((rel) => !S.TEMPLATE_FILES.includes(rel))
  if (missingInRules.length || missingInRuntime.length) {
    const report = conflictReport()
    const c = report.conflicts[0]
    throw new Blocked(
      `登记必然要求改只读的 ${c.file}:${c.line}（FROM_PLUGIN 需 +${missingInRules.length} 行；` +
      `TEMPLATE_FILES 还缺 ${missingInRuntime.length} 行属本卡写集）；不补则随包清单与规则清单不成对 —— ` +
      `${c.ifNotPatched.assertion} 由 ok 变 FAIL（${c.ifNotPatched.measured}）。` +
      '本卡不越界，判定 BLOCKED 并提交最小必要差异',
    )
  }
  // ③ 到这里说明授权补丁已落：两份清单必须成对、无重复、引擎闸空、闭包成员全登记
  const a = [...S.TEMPLATE_FILES].sort().join('\n')
  const b = [...tp].sort().join('\n')
  eq(a, b, `两份登记清单必须成对（TEMPLATE_FILES ${S.TEMPLATE_FILES.length} 项 vs templatePaths ${tp.length} 项）`)
  eq(new Set(S.TEMPLATE_FILES).size, S.TEMPLATE_FILES.length, 'TEMPLATE_FILES 里不许有重复项')
  eq(new Set(tp).size, tp.length, 'templatePaths() 里不许有重复项')
  const unregistered = engine.requiredButNotRegistered(S.TEMPLATE_FILES, { templateDir: TEMPLATE_DIR })
  eq(unregistered.length, 0, `引擎闭包里有模板件没登记进随包清单：${unregistered.join('、')}`)
  // ④ 分类结论：这十四份是**只随插件发**的件（课程包里没有对应原件）⇒ 唯一合法桶是 FROM_PLUGIN
  for (const rel of MIRROR_RELS) eq(classification[rel].join(''), 'FROM_PLUGIN', `${rel} 的分类必须是 FROM_PLUGIN`)
  const policy = require_(path.join(REPO, ...ENGINE_POLICY_REL.split('/')))
  const missingEngine = MIRROR_RELS.filter((rel) => !policy.ENGINE_FILES.includes(rel))
  eq(missingEngine.length, 0, `受信引擎闭包 ENGINE_FILES 缺 ${missingEngine.length} 份运行内核副本：${missingEngine.join('、')}`)
  return { templateFiles: S.TEMPLATE_FILES.length, templatePaths: tp.length, classification, unregistered }
}

/* ── A04 ─ 空包不靠手工补件即可加载运行内核 ──────────────────────────── */

async function A04() {
  if (!fs.existsSync(MIRROR_DIR)) {
    throw new Blocked('生成副本目录不存在：空包加载判据无法在**当前树**上度量（生成被登记冲突阻断，见 A01/A03）')
  }
  const S = await import(pathToFileURL(path.join(REPO, ...PACK_SCAFFOLD_REL.split('/'))).href)
  const missingReg = MIRROR_RELS.filter((rel) => !S.TEMPLATE_FILES.includes(rel))
  eq(missingReg.length, 0, `空包要带运行内核，TEMPLATE_FILES 必须先登记这 14 份（缺 ${missingReg.join('、')}）`)

  const target = path.join(TEMP_ROOT, 'empty-pack')
  fs.mkdirSync(target, { recursive: true })
  const built = S.writeScaffold(target)
  assert(built.ok === true, `writeScaffold 建空包失败：${built.error}`)

  // ① 十四份都真的铺进去了，且逐字节等于权威
  const copies = {}
  for (const m of CORE_MODULES) {
    const abs = path.join(target, 'tools', 'unify', `${m}.cjs`)
    assert(fs.existsSync(abs), `建出来的包缺 tools/unify/${m}.cjs（空包必须自带运行内核）`)
    const got = readBytes(abs)
    assert(got.equals(readBytes(path.join(AUTHORITY_DIR, `${m}.cjs`))), `包内 ${m}.cjs 与权威字节不同`)
    copies[m] = { bytes: got.length, sha256: sha256(got) }
  }
  // ② 包侧 require 真的走**包内**副本（不是仓内那份）：14 份全部 require 得到东西
  const packRequire = createRequire(path.join(target, 'tools', 'lesson-map.js'))
  for (const m of CORE_MODULES) {
    const mod = packRequire(path.join(target, 'tools', 'unify', `${m}.cjs`))
    assert(mod && (typeof mod === 'object' || typeof mod === 'function'), `包内 tools/unify/${m}.cjs require 不到任何东西`)
  }
  // ③ 委托层与内核是同一函数对象（证明包装器指向包内副本）
  const wrapper = packRequire(path.join(target, 'tools', 'lesson-map.js'))
  const core = packRequire(path.join(target, 'tools', 'unify', 'pack.cjs'))
  assert(wrapper.lessonMap === core.lessonIndex, '包侧 tools/lesson-map.js 没有走包内 tools/unify/pack.cjs（委托断了）')
  const packText = packRequire(path.join(target, 'tools', 'pack-text.js'))
  const textCore = packRequire(path.join(target, 'tools', 'unify', 'text.cjs'))
  assert(packText.stripBom === textCore.stripBom, '包侧 tools/pack-text.js 没有走包内 tools/unify/text.cjs')
  // ④ 真跑两个包侧工具：一个"跳过 ≠ 通过"，一个真出产物
  const bl = spawnSync(process.execPath, [path.join(target, 'tools', 'build-lessons.js')], { cwd: target, encoding: 'utf8' })
  const blOut = `${bl.stdout}${bl.stderr}`
  assert(!/Cannot find module/i.test(blOut), `包侧 build-lessons.js 仍然 MODULE_NOT_FOUND：${blOut.slice(0, 300)}`)
  eq(bl.status, 0, '空包 build-lessons.js 应 exit 0（明确"跳过"，不是通过）')
  assert(/跳过/.test(blOut) && /不是「通过」/.test(blOut), `空包 build-lessons.js 必须明说"跳过 ≠ 通过"：${blOut.slice(0, 200)}`)
  const gl = spawnSync(process.execPath, [path.join(target, 'assets', 'build-glossary.js')], { cwd: target, encoding: 'utf8' })
  eq(gl.status, 0, `空包 assets/build-glossary.js 必须 exit 0（实得 ${gl.status}）：${`${gl.stdout}${gl.stderr}`.slice(0, 300)}`)
  assert(fs.existsSync(path.join(target, 'GLOSSARY.md')), '空包 assets/build-glossary.js 没有产出 GLOSSARY.md')
  return { created: built.created.length, copies, loaded: CORE_MODULES.length, buildLessons: bl.status, buildGlossary: gl.status }
}

/* ── A05 ─ 离线骨架与引擎闭包完整；迁移解析不进运行态内核 ────────────── */

async function A05() {
  // ① 迁移专用件绝不在运行态内核里（清单 / 副本 / 依赖三处各钉一次）
  assert(!CORE_MODULES.includes(MIGRATION_MODULE), `${MIGRATION_MODULE} 不许进运行态内核清单`)
  assert(!fs.existsSync(path.join(MIRROR_DIR, `${MIGRATION_MODULE}.cjs`)), `${MIGRATION_MODULE}.cjs 不许出现在镜像目录`)
  const offending = []
  for (const m of CORE_MODULES) {
    const src = fs.readFileSync(path.join(AUTHORITY_DIR, `${m}.cjs`), 'utf8')
    if (/require\(\s*['"]\.\/migration\.cjs['"]\s*\)/.test(src) || /from\s+['"]\.\/migration\.cjs['"]/.test(src)) offending.push(`${m}.cjs`)
  }
  eq(offending.length, 0, `运行态内核不许 require 迁移模块（实得 ${offending.join('、')}）`)

  // ② 离线骨架白名单必须带运行内核副本（否则离线库自己 require 不到 ./unify/*.cjs）
  const bootSrc = read(BOOTSTRAP_REL)
  const keep = quotedItems(bootSrc, 'const TOOLS_KEEP = [')
  const wantInKeep = CORE_MODULES.map((m) => `unify/${m}.cjs`)
  const missingKeep = wantInKeep.filter((rel) => !keep.includes(rel))
  // ③ 白名单不许烂：每一项都得在模板目录真实存在（`serve-static.js` 是**既有**悬空项，
  //    本卡只登记不冒充修复；出现**新的**悬空项当场红）
  const KNOWN_DANGLING = new Set(['serve-static.js'])
  const danglingAll = keep.filter((rel) => !fs.existsSync(path.join(TEMPLATE_DIR, 'tools', ...String(rel).split('/'))))
  const danglingNew = danglingAll.filter((rel) => !KNOWN_DANGLING.has(rel))
  eq(danglingNew.join('\n'), '', `离线骨架白名单里出现新的不存在件（表烂了）：${danglingNew.join('、')}`)

  // ④ 受信引擎闭包必须覆盖运行内核（包侧入口现在直接 require 它们）
  const policy = require_(path.join(REPO, ...ENGINE_POLICY_REL.split('/')))
  const missingEngine = MIRROR_RELS.filter((rel) => !policy.ENGINE_FILES.includes(rel))

  if (missingKeep.length || missingEngine.length) {
    throw new Blocked(
      `离线骨架/引擎闭包缺运行内核：${BOOTSTRAP_REL} 的 TOOLS_KEEP 缺 ${missingKeep.length} 行、` +
      `${ENGINE_POLICY_REL} 的 ENGINE_FILES 缺 ${missingEngine.length} 行（都在本卡写集内，但只有先解除 A03 的登记冲突才有意义：` +
      '镜像目录不存在时把闭包登记上，会让 verifyEngine 认为每个既有包都"缺引擎件"）。最小补丁：' +
      `TOOLS_KEEP += ${wantInKeep.map((r) => `'${r}'`).join('、')}；ENGINE_FILES += ${MIRROR_RELS.map((r) => `'${r}'`).join('、')}`,
    )
  }
  return { migrationInKernel: false, toolsKeep: keep.length, engineFiles: policy.ENGINE_FILES.length, missingKeep, missingEngine, dangling: danglingAll }
}

/* ── A06 ─ 发布文件包含运行内核与显式迁移 CLI；生成器不是运行依赖 ────── */

async function A06() {
  const pkg = JSON.parse(read('package.json'))
  eq(pkg.version, '0.3.3', 'package.json#version 必须仍是 0.3.3')
  eq(pkg.dsh && pkg.dsh.distribution && pkg.dsh.distribution.mode, 'private', 'dsh.distribution.mode 必须仍是 private')
  const files = Array.isArray(pkg.files) ? pkg.files : []
  // ① 运行内核（权威 + 随包副本）都必须被发布清单覆盖
  const missingKernel = [
    ...CORE_MODULES.map((m) => `${AUTHORITY_REL}/${m}.cjs`),
    ...CORE_MODULES.map((m) => `${MIRROR_REL}/${m}.cjs`),
  ].filter((rel) => !filesCover(files, rel))
  eq(missingKernel.length, 0, `发布清单（package.json#files）没覆盖运行内核：${missingKernel.join('、')}`)
  // ② 开发生成器**不是**运行依赖：不进 files、不进 bin
  assert(!filesCover(files, GENERATOR_REL), `开发用生成器 ${GENERATOR_REL} 不许进 package.json#files（它不是运行依赖）`)
  const bin = pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin).map(String) : []
  assert(!bin.some((v) => v.includes('sync-unify-core')), '生成器不许出现在 package.json#bin')
  // ③ 显式迁移 CLI 必须随发布（A06 卡面原文）
  if (!filesCover(files, MIGRATE_CLI_REL)) {
    const report = conflictReport()
    const c = report.conflicts[2]
    throw new Blocked(
      `发布清单缺显式迁移 CLI ${MIGRATE_CLI_REL}（A06 要求"发布文件包含…显式迁移 CLI"）；` +
      `补它只能改 package.json#files，而 ${c.file}:${c.line} 断言 package.json 与基线逐字节相同（${c.ifNotPatched.measured}）。` +
      '本卡不越界，判断需与 U08 的冻结断言一并裁决',
    )
  }
  return { version: pkg.version, mode: pkg.dsh.distribution.mode, filesCovered: missingKernel.length === 0, migrateCli: true }
}

/* ── A07 ─ 临时删除闭包成员 / 破坏副本后判据必红 ─────────────────────── */

async function A07() {
  const root = makeSyncSandbox('mut-sandbox')
  const mirror = path.join(root, ...MIRROR_REL.split('/'))
  const r0 = runGenerator(root, '--write')
  eq(r0.code, 0, `变异前 --write 必须绿（否则变异看不出效果）：${r0.stdout}`)

  // ① 删掉一个闭包成员 ⇒ 判据（--check）必红，且**点名**是哪一个
  const victim = 'identity'
  fs.unlinkSync(path.join(mirror, `${victim}.cjs`))
  const r1 = runGenerator(root, '--check')
  eq(r1.code, 1, '删掉一个闭包成员后 --check 必须红')
  assert(r1.stdout.includes(`${victim}.cjs`), `红的时候必须点名缺的是 ${victim}.cjs（实得：${r1.stdout}）`)
  eq(runGenerator(root, '--write').code, 0, '--write 应当能把它补回来')
  eq(runGenerator(root, '--check').code, 0, '补回来之后 --check 必须重新绿')

  // ② 破坏一个副本（翻一个字节，不改长度）⇒ 判据必红（不是"看起来差不多"就放行）
  const victim2 = 'evidence'
  const p2 = path.join(mirror, `${victim2}.cjs`)
  const b = readBytes(p2)
  const flipped = Buffer.from(b); flipped[10] = flipped[10] === 0x20 ? 0x21 : 0x20
  fs.writeFileSync(p2, flipped)
  const r2 = runGenerator(root, '--check')
  eq(r2.code, 1, '改一个字节后 --check 必须红')
  assert(r2.stdout.includes(`${victim2}.cjs`), `红的时候必须点名 ${victim2}.cjs（实得：${r2.stdout}）`)
  assert(r2.stdout.includes(sha256(flipped).slice(0, 12)), '红的报告必须给出实得字节的 sha256 前缀（可对拍，不是一句话）')

  // ③ 删掉整个镜像目录 ⇒ 判据必红（空包不算"没事"）
  eq(runGenerator(root, '--write').code, 0, '修回来')
  fs.rmSync(mirror, { recursive: true, force: true })
  const r3 = runGenerator(root, '--check')
  eq(r3.code, 1, '整个镜像目录不在时 --check 必须红')
  assert(/missing=14/.test(r3.stdout), `镜像目录不在时应报 missing=14（实得：${r3.stdout}）`)
  return { mutations: ['closure-member-deleted', 'single-byte-flipped', 'mirror-dir-removed'] }
}

/* ── A08 ─ 活包登记表未改；来源差异与新增登记全部留档 ────────────────── */

async function A08() {
  // ① fs 写守卫必须真的挂着（探针写要被抓到）
  assert(GUARD.installed, 'A08：fs 写守卫没有装上 —— 越界断言就是空转')
  const probe = path.join(TEMP_ROOT, 'guard-probe', 'probe.txt')
  fs.mkdirSync(path.dirname(probe), { recursive: true })
  fs.writeFileSync(probe, 'probe', 'utf8')
  assert(WRITES.some((w) => w.abs === path.resolve(probe)), 'A08：探针写没有被守卫记录 —— 守卫没真的拦着 fs')
  eq(classifyWrite(probe).ok, true, 'A08：临时根里的写必须允许')
  eq(classifyWrite(path.join(REPO, 'lib', 'pack-scaffold.js')).ok, false, 'A08：仓内（非证据/临时根）的写必须拒绝')
  eq(classifyWrite(path.join(REPO, 'lib', 'pack-template', 'tools', 'unify', 'render.cjs')).ok, false,
    'A08：镜像目录也不许"顺手"写（它只能由生成器写）')

  // ② 本次运行往仓内写的只有证据根
  const inRepo = WRITES.filter((w) => !String(w.owner).startsWith('..') && w.owner !== '本次唯一临时根' && !classifyWrite(w.abs).ok)
  eq(inRepo.length, 0, `A08：出现了证据根/临时根之外的写入：${inRepo.slice(0, 5).map((w) => `${w.op} ${w.owner}`).join(' | ')}`)

  // ③ 声明写集 ⊆ interfaces.md §6 的 U19 行（现场解析，不写死）
  const declared = [
    'lib/pack-scaffold.js', 'package.json', 'lib/pack-template/tools/engine-policy.cjs',
    'lib/pack-template/tools/offline-bootstrap.js', 'tools/sync-unify-core.mjs', 'docs/unify-mirrors.md',
    ...CORE_MODULES.map((m) => `${MIRROR_REL}/${m}.cjs`),
    'test/audit/U19.mjs', 'docs/unify/receipts/U19.json',
  ]
  const iface = read(INTERFACES_REL)
  const rowLine = iface.split('\n').find((l) => /^\|\s*U19\s*\|/.test(l))
  assert(rowLine, 'A08：interfaces.md §6 里找不到 U19 那一行（接口锁被改了？）')
  const rowPaths = new Set([...rowLine.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/^†\s*/, '').trim()))
  const outside = declared.filter((rel) => !rowPaths.has(rel) && !rowPaths.has(rel.replace(/^†/, '')))
  eq(outside.join('\n'), '', `A08：声明写集越出 interfaces.md §6 的 U19 行：${outside.join('、')}`)

  // ④ 三处来源差异 + 新增登记必须全部留档（证据根里有一份可机读的冲突台账）
  assert(EVIDENCE.ok, `A08：证据根非法（${EVIDENCE.error}）`)
  const conflictPath = path.join(EVIDENCE.root, 'conflict-report.json')
  assert(fs.existsSync(conflictPath), 'A08：冲突台账没落盘（来源差异与新增登记必须留档）')
  const ledger = JSON.parse(fs.readFileSync(conflictPath, 'utf8'))
  eq(ledger.conflicts.length, 3, 'A08：冲突台账必须逐条记满三处来源差异')
  for (const c of ledger.conflicts) {
    assert(c.file && c.line && c.minimalDiff && c.whyReadOnly, `A08：冲突 ${c.id} 缺 file/line/minimalDiff/whyReadOnly`)
    assert(fs.existsSync(path.join(REPO, ...c.file.split('/'))), `A08：冲突 ${c.id} 指向的文件不存在：${c.file}`)
    const actual = read(c.file).split('\n')[c.line - 1] ?? ''
    assert(actual.length > 0, `A08：冲突 ${c.id} 的行号对不上（${c.file}:${c.line} 是空行）`)
  }

  // ⑤ 生成器/入口不许写机器专属路径（它们会被随包/被复制）。判据串本身拆开拼，
  //    否则扫描会命中"判据自己"（自指的假红）
  const forbidden = [
    new RegExp(['work', 'place'].join(''), 'i'),
    new RegExp(['dsh', 'raw', 'html', 'v2'].join('-'), 'i'),
    /(?<![A-Za-z])[A-Za-z]:[\\/](?!Temp)[^\s'"`)]+/,
  ]
  for (const rel of [GENERATOR_REL, 'test/audit/U19.mjs', 'docs/unify-mirrors.md']) {
    const text = read(rel)
    for (const re of forbidden) {
      const m = text.match(re)
      assert(!m, `${rel} 里出现机器专属路径（${m && m[0]}）—— 随包件不许带本机布局`)
    }
  }

  // ⑥ 临时根清理守卫：自己这一份能删，别的东西一律拒绝
  eq(guardTempPath(TEMP_ROOT, { parent: TMP_BASE }).ok, true, 'A08：本次临时根必须能通过清理守卫')
  eq(guardTempPath(path.join(TMP_BASE, 'u19-someone-else'), { parent: path.join(TMP_BASE, 'other') }).ok, false,
    'A08：父目录不符的临时路径必须拒绝清理')
  return { writes: WRITES.length, inRepoWrites: inRepo.length, declared: declared.length, conflicts: ledger.conflicts.length }
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */

const cases = [
  { id: 'A01', run: A01 },
  { id: 'A02', run: A02 },
  { id: 'A03', run: A03 },
  { id: 'A04', run: A04 },
  { id: 'A05', run: A05 },
  { id: 'A06', run: A06 },
  { id: 'A07', run: A07 },
  { id: 'A08', run: A08 },
]

async function main() {
  installGuard()
  fs.mkdirSync(TEMP_ROOT, { recursive: true })

  // 证据根：先落冲突台账（A03/A06/A08 都读它；**一份事实、一处算**）
  if (EVIDENCE.ok) {
    fs.mkdirSync(EVIDENCE.root, { recursive: true })
    fs.writeFileSync(path.join(EVIDENCE.root, 'conflict-report.json'), JSON.stringify(conflictReport(), null, 2), 'utf8')
  }

  const verdict = await runCard(CARD, cases.map((c) => c.id), cases, {
    argv: process.argv.slice(2),
    evidenceDir: EVIDENCE.ok ? EVIDENCE.root : undefined,
  })

  // 机械面补充证据：即使整卡 BLOCKED，也把"生成器在当前树上的真实状态"留档
  if (EVIDENCE.ok) {
    const p = planSync({ repoRoot: REPO })
    fs.writeFileSync(path.join(EVIDENCE.root, 'sync-plan.json'), JSON.stringify({
      mirrorExists: p.mirrorExists,
      modules: p.modules.length,
      same: p.same.length,
      missing: p.missing,
      changed: p.changed,
      extra: p.extra,
      problems: p.problems,
      line: `UNIFY-CORE ok=${p.ok} files=${p.modules.length} same=${p.same.length} missing=${p.missing.length} changed=${p.changed.length} extra=${p.extra.length}`,
    }, null, 2), 'utf8')
    writeRunEvidence(verdict, EVIDENCE.root)
  }

  // 清理：本次唯一临时根（先核对绝对路径与归属，再递归删）
  const cleanup = safeRemoveTree(TEMP_ROOT, { parent: TMP_BASE })
  if (EVIDENCE.ok) {
    fs.writeFileSync(path.join(EVIDENCE.root, 'cleanup.json'), JSON.stringify({
      tempRoot: TEMP_ROOT, removed: cleanup.removed, error: cleanup.error, writes: WRITES.length,
    }, null, 2), 'utf8')
  }

  process.exitCode = printVerdict(verdict)
}

await main()
