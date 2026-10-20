#!/usr/bin/env node
/**
 * test/audit/U03.mjs —— 五态读取与失败结构（U03 专项入口）
 * ==================================================================
 * 判的是两个新模块的真实行为，不是它们的注释：
 *   `lib/unify/errors.cjs`      —— `failure` 结构 + `makeFailure`（只造不合并、非法 kind 明确拒）
 *   `lib/unify/ledger-read.cjs` —— `readLedger(file,{format,validate,fs})` 的五态读取
 *
 * 用法：
 *   node test/audit/U03.mjs                                  # 本卡入口
 *   node test/audit/U03.mjs --evidence-root=<绝对新运行目录>   # 只改**证据落点**，不改判据
 *
 * 判词（stdout 一行，exit 0/1/2）：
 *   `PASS U03 checks=8 failed=0 skipped=0` / `FAIL U03 …` / `BLOCKED U03 …`
 *
 * 固定八项 A01–A08 全是真实断言（对着模块的真实返回、真实临时文件、真实子进程）：
 *   A01 五态分开 / A02 坏 JSON·null·非法结构不崩 / A03 坏行不进 entries 且带行号 /
 *   A04 原始系统码与既有业务码不被改名 + 旧码零变更 + 五个新码**只有一份定义**（使用放行） /
 *   A05 按声明格式处理 /
 *   A06 读取零写入 / A07 变异（io-error 折成 empty）必须红 / A08 确定性注入+证据+清理守卫。
 *
 * 临时夹具只在 `E:\Temp\u03-s1-blane\U03-<pid>`（每次唯一），清理前核对绝对路径与归属；
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
  guardTempPath, safeRemoveTree, Blocked, Truncated,
} from './unify-runner.mjs'

const CARD = 'U03'
const SELF = fileURLToPath(import.meta.url)
const ARGV = process.argv.slice(2)
const requireCJS = createRequire(import.meta.url)

/* ── 进程内 fs 写守卫（A08 ⑦） ──────────────────────────────────────────────
 * 共享工作树里别的 lane 正在写自己的写集，所以**不能**拿"工作树干净/整棵树只有我在写"
 * 当判据（那会假红别人、也会掩盖自己的越界）。本卡只主张一件自己说了算的事：
 * 本进程的每一次 fs 写，都必须落在「本卡写集文件 / 本卡证据根 / 本卡唯一临时根」里。
 * 这里只包**写**能力（读不记），而且记录失败绝不影响原调用。
 */
const WRITE_GUARD = { writes: [], patched: [] }
for (const fnName of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync',
  'unlinkSync', 'copyFileSync', 'renameSync', 'createWriteStream', 'truncateSync']) {
  const original = fs[fnName]
  if (typeof original !== 'function') continue
  WRITE_GUARD.patched.push(fnName)
  fs[fnName] = function guardedWrite(target, ...rest) {
    try {
      // copyFileSync/renameSync 的**写目标**是第二个参数；其余函数的第一个参数就是目标
      const dest = (fnName === 'copyFileSync' || fnName === 'renameSync') ? rest[0] : target
      if (typeof dest === 'string' || dest instanceof URL) {
        WRITE_GUARD.writes.push({ fn: fnName, path: dest instanceof URL ? fileURLToPath(dest) : dest })
      }
    } catch { /* 守卫自己的记录失败不算判据失败 */ }
    return original.call(fs, target, ...rest)
  }
}

const MODULES_DIR = path.join(REPO, 'lib', 'unify')
const ERRORS_FILE = path.join(MODULES_DIR, 'errors.cjs')
const READER_FILE = path.join(MODULES_DIR, 'ledger-read.cjs')
const RECEIPT_FILE = path.join(REPO, 'docs', 'unify', 'receipts', 'U03.json')

/** 本卡写集（相对仓根）。A04 用它证明"只新增、不改既有源码"。 */
const WRITE_SET = [
  'lib/unify/errors.cjs',
  'lib/unify/ledger-read.cjs',
  'test/audit/U03.mjs',
  'docs/unify/receipts/U03.json',
]

/** 临时夹具根：**本卡唯一**的 E:\Temp 目录前缀（每次运行再套一层 U03-<pid>）。 */
const TEMP_ROOT = 'E:\\Temp\\u03-s1-blane'
const RUN_TMP = path.join(TEMP_ROOT, `U03-${process.pid}`)

/** A04：用于"码值原样带出"的真实码值（全部取自 U01 锁定的真实码表，见 interfaces.md §5）。 */
const SYSTEM_CODES = ['ENOENT', 'EISDIR', 'EACCES', 'EPERM']
const BUSINESS_CODES = ['IO_ERROR', 'PLAN_STALE', 'CONFIRM_REQUIRED', 'STAGE_FAILED']
const KEBAB_CODES = ['criteria-not-met', 'evidence-insufficient', 'missing-ref', 'halo-mismatch', 'ambiguous', 'busy']

/**
 * A04 · 码表归属的扫描范围：**生产源码**（docs/test 里的提及不是"定义"）。
 * 判的是"有没有第二份定义"，不是"这个串出现过没有"。
 */
const SCAN_DIRS = ['lib', 'tools', 'preset']
/** A04 · 五个拟新增码**唯一**允许的定义落点（相对扫描根）。 */
const SINGLE_DECL_FILE = 'lib/unify/errors.cjs'
/**
 * 决-9 连带（副本出现后口径过期）：U19 把 `lib/unify/*.cjs` **逐字节生成**到
 * `lib/pack-template/tools/unify/`。那是**副本**，不是第二份实现 —— 唯一性扫描要现算排除，
 * 并且逐字节对拍被排除的那份（见 `assertCodeOwnership`）。排除面只有这一个前缀。
 */
const GENERATED_MIRROR_PREFIX = 'lib/pack-template/tools/unify/'
/** A04 反空转夹具里两个"合法消费方"的相对路径（照着 U06 的真实落点形态）。 */
const CONSUMER_REL = 'lib/pack-template/tools/ledger-transaction.cjs'
const TOOL_REL = 'tools/recover-ledgers.mjs'

/**
 * A04 反空转的注入样本（两侧各一份，缺哪侧判据都可能空转）：
 *   · **绿**：成员集 —— 值是 `true`，只是拿码名当查找键（`Object.freeze` 包裹，和真实树的
 *     `RETRY_CODES` 同形态）。它必须**放行**：原来一刀切按 object-key 判定义的写法会把它误杀。
 *   · **红**：别名码表 `{ LOCK_BUSY: 'LOCK_BUSY' }`（键=码名、值=同一个字面量）+ 标识符绑定。
 *     它必须**阻断**：修复分类器不许把 object-key 整体放过。
 */
const SPIN_GREEN_MEMBERSHIP = 'const RETRY = Object.freeze({ PLAN_STALE: true, LOCK_BUSY: true })'
const SPIN_RED_DEFS = [
  "const CODES = { LOCK_BUSY: 'LOCK_BUSY' }",
  "const RECOVERY_REQUIRED = 'RECOVERY_REQUIRED'",
]

/** A07 的变异落点（唯一一处声明，恰好出现一次）。 */
const MUTATION_TOKEN = "const IO_ERROR_STATUS = 'io-error'"
const MUTATION_REPLACEMENT = "const IO_ERROR_STATUS = 'empty'"

/** 假 fs 上"写了就不许"的能力清单（A06 探针用它数写调用）。 */
const WRITE_APIS = [
  'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync',
  'mkdirSync', 'copyFileSync', 'writeFile', 'appendFile', 'createWriteStream', 'truncateSync',
  'openSync', 'chmodSync', 'symlinkSync',
]

/** 本次运行收集的原始材料（A08 落证据；全是真实跑出来的结果，不是手写常量）。 */
const EVID = { samples: {}, junk: [], readerSamples: [], mutation: null, temp: {}, moduleLocks: [] }

/* ══════════════════════════════════════════════════════════════════════
 * 子进程模式：只跑「读取契约」或「码表归属」，不写任何证据目录
 *   --reader-check=<dir>           A07 用（干净副本 / 变异副本）
 *   --code-ownership-check=<dir>   A04 用（只该有一份定义的副本 → 绿；塞了第二定义 → 红）
 * ⚠️ 必须放在本文件的顶层常量之后：子进程里这段要跑在 `FAKE_FILE` 初始化之后，
 *    否则会撞 TDZ（`Cannot access 'FAKE_FILE' before initialization`）。
 * ══════════════════════════════════════════════════════════════════════ */
function maybeRunSubprocessCheck() {
  const readerHit = ARGV.find((a) => a.startsWith('--reader-check='))
  if (readerHit) {
    const dir = path.resolve(readerHit.slice('--reader-check='.length))
    try {
      const mod = requireCJS(path.join(dir, 'ledger-read.cjs'))
      const err = requireCJS(path.join(dir, 'errors.cjs'))
      readerContract(mod.readLedger, err.makeFailure)
      process.stdout.write('READER-CONTRACT OK\n')
      process.exit(0)
    } catch (e) {
      process.stdout.write(`READER-CONTRACT FAIL ${e?.message ?? e}\n`)
      process.exit(1)
    }
  }
  const ownHit = ARGV.find((a) => a.startsWith('--code-ownership-check='))
  if (ownHit) {
    const dir = path.resolve(ownHit.slice('--code-ownership-check='.length))
    try {
      const errMod = requireCJS(path.join(dir, 'lib', 'unify', 'errors.cjs'))
      const codes = Object.keys(errMod.NEW_CODES ?? {}).sort()
      if (codes.length === 0) throw new Error('副本的 errors.cjs 里没有 NEW_CODES')
      assertCodeOwnership(dir, codes, { where: '副本' })
      process.stdout.write('CODE-OWNERSHIP OK\n')
      process.exit(0)
    } catch (e) {
      process.stdout.write(`CODE-OWNERSHIP FAIL ${e?.message ?? e}\n`)
      process.exit(1)
    }
  }
  return false
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '不相等'}：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败') }
function eqJson(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg)
}
/** 期望"明确拒绝"：抛了才算通过；没抛本身是失败（不是 catch 住的吞错）。 */
function mustThrow(fn, msg, rx) {
  let threw = null
  try { fn() } catch (e) { threw = e }
  if (!threw) throw new Error(`${msg}：应当明确拒绝，但没抛`)
  if (rx && !rx.test(String(threw.message ?? threw))) {
    throw new Error(`${msg}：拒绝理由不对（${threw.message ?? threw}）`)
  }
  return threw
}

function loadModule(file) {
  if (!fs.existsSync(file)) throw new Blocked(`缺模块：${path.relative(REPO, file)}`)
  return requireCJS(file)
}

function mods() {
  const err = loadModule(ERRORS_FILE)
  const reader = loadModule(READER_FILE)
  if (typeof err.makeFailure !== 'function') throw new Blocked('lib/unify/errors.cjs 没有导出 makeFailure')
  if (typeof reader.readLedger !== 'function') throw new Blocked('lib/unify/ledger-read.cjs 没有导出 readLedger')
  return { errors: err, reader }
}

/** 去掉注释再扫（注释里写"不许 process.env"不该被当成依赖；`https://` 那种不给误伤） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 伪造一条系统/业务错误（确定性注入用）。 */
function ioError(code, message = `injected ${code}`) {
  return Object.assign(new Error(message), { code })
}

/** 假 fs：只读一次就够；写能力一律记一笔并抛（A06 的"零写"就靠它数）。 */
function makeFakeFs({ text = '', error = null } = {}) {
  const calls = { readFileSync: [], writes: [] }
  const fakeFs = {
    readFileSync(p, encoding) {
      calls.readFileSync.push({ path: String(p), encoding })
      if (error) throw error
      return text
    },
  }
  for (const name of WRITE_APIS) {
    fakeFs[name] = (...args) => {
      calls.writes.push({ name, argCount: args.length })
      throw new Error(`注入探针：readLedger 不许调用 ${name}()`)
    }
  }
  return { fs: fakeFs, calls }
}

const FAKE_FILE = path.join('E:\\fake', 'ledger', 'x.jsonl')
const FAKE_ABS = path.resolve(FAKE_FILE)

// 子进程模式（A04 码表归属 / A07 读取契约）：到这一步才调 —— 它要用的常量/函数都初始化好了
maybeRunSubprocessCheck()

/* ── 证据根：默认本卡新运行目录；--evidence-root= 只换落点，不换判据 ─────── */
const ROOTS = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
const EV = ROOTS.ok ? ROOTS.root : null
const CARD_EV = path.join(REPO, 'audit-evidence', CARD)
// 本卡证据目录必须显式存在（卡面要求；它不是"自动就有了"）
fs.mkdirSync(CARD_EV, { recursive: true })

/* ── 临时夹具（绝对路径核对 + 归属核对，都走 unify-runner 的守卫） ─────── */

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

/** 目录清单 + 内容摘要（A06 的"读前读后一字不变"就比它）。 */
function snapshotTree(dir) {
  const out = []
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const p = path.join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = fs.statSync(p)
      if (e.isDirectory()) {
        out.push({ rel: r, kind: 'dir', mtimeMs: st.mtimeMs })
        walk(p, r)
        continue
      }
      out.push({ rel: r, kind: 'file', bytes: st.size, mtimeMs: st.mtimeMs, sha256: sha256(fs.readFileSync(p)) })
    }
  }
  walk(dir, '')
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 共享判据：readLedger / makeFailure 的读取契约（A01 与 A07 子进程同一份）
 * ══════════════════════════════════════════════════════════════════════ */

function readerContract(readLedger, makeFailure) {
  /* ① missing —— **只有真 ENOENT** */
  const missProbe = makeFakeFs({ error: ioError('ENOENT') })
  const miss = readLedger(FAKE_FILE, { format: 'jsonl', fs: missProbe.fs })
  eq(miss.file, FAKE_ABS, 'missing：file 必须是解析后的绝对路径')
  eq(miss.exists, false, 'missing：exists 必须是 false')
  eq(miss.status, 'missing', 'ENOENT 必须落 missing')
  eq(miss.entries.length, 0, 'missing：entries 必须为空')
  eq(miss.problems.length, 0, 'missing：problems 必须为空（不存在不是坏账）')
  eq(miss.errorCode, 'ENOENT', 'missing：原始系统码要原样保留')
  ok(!('failure' in miss), 'missing 不是失败（回不退由领域决定，读取层不塞 failure）')

  /* ② empty —— 存在但零条；合法空集合（[]）也是 empty */
  const emptyText = readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ text: '' }).fs })
  eq(emptyText.status, 'empty', '空文件必须落 empty（不是 missing）')
  eq(emptyText.exists, true, '空文件：exists 必须 true')
  eq(emptyText.entries.length, 0)
  eq(emptyText.problems.length, 0)
  ok(!('failure' in emptyText), 'empty 不是失败')
  const emptyJson = readLedger(FAKE_FILE, { format: 'json', fs: makeFakeFs({ text: '[]' }).fs })
  eq(emptyJson.status, 'empty', '合法空集合 [] 必须落 empty')
  eq(emptyJson.entries.length, 0)
  const emptyBlank = readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ text: '\n\n  \r\n' }).fs })
  eq(emptyBlank.status, 'empty', '只有空行的台账是 empty，不是 invalid')

  /* ③ ok —— 有记录且无问题 */
  const okProbe = makeFakeFs({ text: '{"id":"a"}\n{"id":"b"}\n' })
  const good = readLedger(FAKE_FILE, { format: 'jsonl', fs: okProbe.fs })
  eq(good.status, 'ok', '两条好记录必须落 ok')
  eq(good.exists, true)
  eqJson(good.entries.map((e) => e.id), ['a', 'b'], 'ok：entries 必须按原序、一条不少')
  eq(good.problems.length, 0)
  ok(!('errorCode' in good), 'ok：不该出现 errorCode')
  ok(!('failure' in good), 'ok：不该出现 failure')

  /* ④ invalid —— 坏行照收进 problems、好行照进 entries、**一条坏记录都不进 entries** */
  const invProbe = makeFakeFs({ text: '{"id":"a"}\n{bad\n' })
  const inv = readLedger(FAKE_FILE, { format: 'jsonl', fs: invProbe.fs })
  eq(inv.status, 'invalid', '有坏行必须落 invalid')
  eq(inv.exists, true)
  eqJson(inv.entries.map((e) => e.id), ['a'], '坏行不许进 entries（好行照收）')
  eq(inv.problems.length, 1, '坏行必须逐条进 problems')
  ok(/第 2 行/.test(inv.problems[0]), `problems 要带行号（实得 ${inv.problems[0]}）`)
  eq(inv.failure.kind, 'input', 'invalid：failure.kind 必须是 input')
  eq(inv.failure.code, 'LEDGER_INVALID', 'invalid：failure.code 必须是 LEDGER_INVALID')
  eq(inv.failure.line, 2, 'invalid：failure.line 指第一处坏行')
  eq(inv.failure.file, FAKE_ABS, 'invalid：failure.file 指向被读的文件')

  /* ⑤ io-error —— 目录 / 权限 / 其它读取故障 ≠ missing ≠ empty，系统码原样 */
  for (const code of ['EISDIR', 'EACCES', 'EPERM']) {
    const r = readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ error: ioError(code) }).fs })
    eq(r.status, 'io-error', `${code} 必须落 io-error`)
    eq(r.exists, true, `${code}：exists 必须 true（路径上有东西，只是读不动）`)
    eq(r.errorCode, code, `${code}：原始系统码必须原样保留`)
    eq(r.failure.kind, 'io', `${code}：failure.kind 必须是 io`)
    eq(r.failure.code, 'IO_ERROR', `${code}：业务码是既有 IO_ERROR（不改名）`)
    eq(r.failure.errorCode, code, `${code}：failure.errorCode 也是原样系统码`)
    ok(r.problems.length >= 1, `${code}：读取故障要留下 problems`)
    ok(r.status !== miss.status, `${code}：io-error 不能与 missing 同态`)
    ok(r.status !== 'empty', `${code}：io-error 不能被折成空态`)
  }

  /* ⑥ 坏 JSON / null / 非法结构：不崩，落 invalid，entries 为空 */
  const junk = [
    ['json', '{', 0],
    ['json', 'null', 0],
    ['json', '{"a":1}', 0],
    ['json', '"x"', 0],
    ['json', '12', 0],
    ['json', 'true', 0],
    ['jsonl', 'null\n', 0],
    ['jsonl', '[]\n', 0],
    ['jsonl', '{"id":"a"}\nnull\n', 1],
    ['jsonl', '\uFEFFoops\n', 0],
  ]
  for (const [format, text, expectedEntries] of junk) {
    const r = readLedger(FAKE_FILE, { format, fs: makeFakeFs({ text }).fs })
    eq(r.status, 'invalid', `${format} ${JSON.stringify(text)} 必须落 invalid（不许崩、不许当 ok）`)
    eq(r.entries.length, expectedEntries, `${format} ${JSON.stringify(text)}：entries 条数不对`)
    ok(r.problems.length >= 1, `${format} ${JSON.stringify(text)}：必须留下 problems`)
    ok(r.failure && r.failure.code === 'LEDGER_INVALID', `${format} ${JSON.stringify(text)}：必须带 LEDGER_INVALID`)
  }

  /* ⑦ 码值原样：注入什么码，带出来的就是什么码（不改名、不改大小写、不映射） */
  for (const code of [...BUSINESS_CODES, ...KEBAB_CODES, 'EACCES', 'EPERM']) {
    const r = readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ error: ioError(code) }).fs })
    eq(r.errorCode, code, `码值 ${code} 被改名了（errorCode=${r.errorCode}）`)
    eq(r.failure.errorCode, code, `码值 ${code} 在 failure.errorCode 里被改名了`)
  }

  /* ⑧ 按**声明**的格式处理：同内容两种格式各自可断言；两种格式互不兜底 */
  const arrayText = '[{"id":"a"},{"id":"b"}]'
  const asJson = readLedger(FAKE_FILE, { format: 'json', fs: makeFakeFs({ text: arrayText }).fs })
  eq(asJson.status, 'ok', '声明 json 的数组文件必须 ok')
  eqJson(asJson.entries.map((e) => e.id), ['a', 'b'], 'json：整文件数组按序成 entries')
  const asJsonl = readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ text: arrayText }).fs })
  eq(asJsonl.status, 'invalid', '同一个数组内容声明成 jsonl 必须 invalid（一行不是一条记录）')
  eq(asJsonl.entries.length, 0, 'jsonl 不许把整文件数组当一条记录收下')
  const jsonlText = '{"id":"a"}\n{"id":"b"}\n'
  const jsonlAsJson = readLedger(FAKE_FILE, { format: 'json', fs: makeFakeFs({ text: jsonlText }).fs })
  eq(jsonlAsJson.status, 'invalid', 'jsonl 内容声明成 json 必须 invalid（不许兜底）')
  eq(jsonlAsJson.entries.length, 0, 'json 不许把 jsonl 逐行兜底成数组')
  const jsonlOk = readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ text: jsonlText }).fs })
  eqJson(jsonlOk.entries, asJson.entries, '同一批记录：json 与 jsonl 两种声明读出来的规范记录必须相同')

  /* ⑨ 零写入：一次读只调一次 readFileSync，写能力一次都不碰 */
  const probe = makeFakeFs({ text: '{"id":"a"}\n' })
  readLedger(FAKE_FILE, { format: 'jsonl', fs: probe.fs })
  eq(probe.calls.writes.length, 0, `readLedger 不许有任何写调用（实得 ${JSON.stringify(probe.calls.writes)}）`)
  eq(probe.calls.readFileSync.length, 1, '一次读取只许 readFileSync 一次')
  eq(probe.calls.readFileSync[0].path, FAKE_ABS, '读的必须是解析后的绝对路径')

  /* ⑩ 失败工厂：非法 kind 明确拒绝；结构只能是 FAILURE_KEYS 的子集 */
  mustThrow(() => makeFailure({ kind: 'nope', code: 'X', error: 'e' }), '非法 kind 必须明确拒绝', /kind/)
  mustThrow(() => makeFailure({ kind: 'input', code: '', error: 'e' }), '空 code 必须拒绝', /code/)
  mustThrow(() => makeFailure({ kind: 'input', code: 'X', error: '' }), '空 error 必须拒绝', /error/)
  mustThrow(() => makeFailure({ kind: 'input', code: 'X', error: 'e', line: 0 }), '非法 line 必须拒绝', /line/)
  const built = makeFailure({ kind: 'recovery', code: 'RECOVERY_REQUIRED', error: '需要恢复' })
  eqJson(Object.keys(built), ['kind', 'code', 'error'], 'failure 只该有已给的键（可选键不硬塞 null）')
  const full = makeFailure({ kind: 'io', code: 'IO_ERROR', error: 'x', file: 'a', line: 3, errorCode: 'EACCES' })
  eqJson(Object.keys(full), ['kind', 'code', 'error', 'file', 'line', 'errorCode'], 'failure 键序固定')
}

/* ══════════════════════════════════════════════════════════════════════
 * A01 · 不存在 / 空 / 有效 / 非法 / IO 故障 —— 五态分开
 * ══════════════════════════════════════════════════════════════════════ */
async function A01() {
  resetRunTmp()
  const { errors, reader } = mods()

  // 契约内核（注入确定性 fs）：五态 + 坏 JSON/null/结构 + 码值 + 格式 + 零写 + 工厂
  readerContract(reader.readLedger, errors.makeFailure)

  // 五态取值域本身不许自造：必须与 lib/state.js 既有的 EVIDENCE_STATUSES 同一套
  eqJson(reader.LEDGER_STATUSES, ['missing', 'empty', 'ok', 'invalid', 'io-error'], 'LEDGER_STATUSES 取值域')
  const stateSrc = fs.readFileSync(path.join(REPO, 'lib', 'state.js'), 'utf8')
  const m = /export const EVIDENCE_STATUSES = Object\.freeze\(\[([^\]]+)\]\)/.exec(stateSrc)
  ok(m, 'lib/state.js 里找不到 EVIDENCE_STATUSES（五态的既有落点变了 —— 需暂停核对）')
  const existing = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  eqJson(reader.LEDGER_STATUSES, existing, '五态必须与 lib/state.js 的 EVIDENCE_STATUSES 逐字一致')

  // 真实文件上的五态（不是只有假 fs）：每态各断言 status 与关键字段
  const dir = tempDir('states')
  const missingFile = path.join(dir, 'absent.jsonl')
  const emptyFile = path.join(dir, 'empty.jsonl')
  const okFile = path.join(dir, 'ok.jsonl')
  const badFile = path.join(dir, 'bad.jsonl')
  const dirAsLedger = path.join(dir, 'as-dir.jsonl')
  fs.writeFileSync(emptyFile, '', 'utf8')
  fs.writeFileSync(okFile, '{"id":"a"}\n{"id":"b"}\n', 'utf8')
  fs.writeFileSync(badFile, '{"id":"a"}\n这不是 JSON\n', 'utf8')
  fs.mkdirSync(dirAsLedger)

  const rMiss = reader.readLedger(missingFile, { format: 'jsonl' })
  eq(rMiss.status, 'missing'); eq(rMiss.exists, false); eq(rMiss.errorCode, 'ENOENT')
  eq(rMiss.entries.length, 0); eq(rMiss.problems.length, 0)

  const rEmpty = reader.readLedger(emptyFile, { format: 'jsonl' })
  eq(rEmpty.status, 'empty'); eq(rEmpty.exists, true); eq(rEmpty.entries.length, 0)

  const rOk = reader.readLedger(okFile, { format: 'jsonl' })
  eq(rOk.status, 'ok'); eq(rOk.entries.length, 2); eqJson(rOk.entries.map((e) => e.id), ['a', 'b'])

  const rBad = reader.readLedger(badFile, { format: 'jsonl' })
  eq(rBad.status, 'invalid'); eq(rBad.entries.length, 1); eq(rBad.problems.length, 1)
  ok(/第 2 行/.test(rBad.problems[0]), `真实坏文件的问题要带行号（实得 ${rBad.problems[0]}）`)
  eq(rBad.failure.code, 'LEDGER_INVALID'); eq(rBad.failure.line, 2)

  const rIo = reader.readLedger(dirAsLedger, { format: 'jsonl' })
  eq(rIo.status, 'io-error', `目录当台账读必须 io-error（实得 ${rIo.status} / ${rIo.errorCode}）`)
  eq(rIo.errorCode, 'EISDIR', '目录读取的系统码必须原样是 EISDIR')
  eq(rIo.exists, true, 'io-error：exists 必须 true')

  const statuses = [rMiss, rEmpty, rOk, rBad, rIo].map((r) => r.status)
  eqJson(statuses, ['missing', 'empty', 'ok', 'invalid', 'io-error'], '五态在真实文件上必须各就各位、互不混同')
  eq(new Set(statuses).size, 5, '五态必须是五个不同值（合并任意两个都算失败）')

  EVID.samples.fiveStates = [rMiss, rEmpty, rOk, rBad, rIo].map((r) => ({
    file: r.file, exists: r.exists, status: r.status,
    entries: r.entries.length, problems: r.problems.slice(0, 2),
    errorCode: r.errorCode ?? null, failureCode: r.failure ? r.failure.code : null,
    failureKind: r.failure ? r.failure.kind : null,
  }))
  EVID.samples.statuses = statuses
}

/* ══════════════════════════════════════════════════════════════════════
 * A02 · 坏 JSON、null、非法结构不崩溃（且 status=invalid、不进 entries）
 * ══════════════════════════════════════════════════════════════════════ */
async function A02() {
  const { errors, reader } = mods()

  const cases = [
    ['json', '{', '截断的对象', 0],
    ['json', 'null', 'JSON 里合法的 null', 0],
    ['json', '{"a":1}', '对象而不是数组', 0],
    ['json', '"just a string"', '字符串', 0],
    ['json', '42', '数字', 0],
    ['json', 'true', '布尔', 0],
    ['json', '', '空文本按 json 声明', 0],
    ['jsonl', 'null\n', 'jsonl 里的 null 行', 0],
    ['jsonl', '[]\n', 'jsonl 里的数组行', 0],
    ['jsonl', '{"a":1}\n{"b":\n', '后一行坏 JSON（前一行仍有效）', 1],
    ['jsonl', '\uFEFF{bad\n', 'BOM 后坏 JSON', 0],
    ['jsonl', '{"id":"a"}{"id":"b"}\n', '两条粘成一行', 0],
  ]
  for (const [format, text, label, expectedEntries] of cases) {
    let r
    try {
      r = reader.readLedger(FAKE_FILE, { format, fs: makeFakeFs({ text }).fs })
    } catch (e) {
      throw new Error(`读入「${label}」崩了（应当落 invalid 而不是抛）：${e?.message ?? e}`)
    }
    ok(r && typeof r === 'object', `读入「${label}」没有返回对象`)
    eq(r.status, 'invalid', `读入「${label}」必须落 invalid（实得 ${r.status}）`)
    eq(r.exists, true, `读入「${label}」：文件存在，exists 必须 true`)
    eq(r.entries.length, expectedEntries, `读入「${label}」：坏结构不许进 entries（实得 ${JSON.stringify(r.entries)}）`)
    ok(!r.entries.some((e) => e === null || Array.isArray(e) || typeof e !== 'object'),
      `读入「${label}」：entries 里混进了非记录`)
    ok(Array.isArray(r.problems) && r.problems.length >= 1, `读入「${label}」：必须留下 problems`)
    eq(r.failure.code, 'LEDGER_INVALID', `读入「${label}」：失败码必须是 LEDGER_INVALID`)
    ok(!('errorCode' in r) || r.errorCode === undefined, `读入「${label}」：内容坏不是 IO 故障，不该有 errorCode`)
  }
  EVID.junk = cases.map(([format, text, label, expectedEntries]) => ({ format, label, bytes: Buffer.byteLength(text), entries: expectedEntries }))

  // 台面上被"声明错"的用法必须**明确拒绝**，不猜、不兜底（与"内容坏不许崩"是两层事）
  mustThrow(() => reader.readLedger(FAKE_FILE, { format: 'txt', fs: makeFakeFs({ text: '' }).fs }),
    'format 未声明/拼错必须拒绝', /format/)
  mustThrow(() => reader.readLedger(FAKE_FILE, { fs: makeFakeFs({ text: '' }).fs }),
    'format 缺省必须拒绝（不许猜 json）', /format/)
  mustThrow(() => reader.readLedger(FAKE_FILE, { format: 'jsonl', validate: 'nope', fs: makeFakeFs({ text: '' }).fs }),
    'validate 不是函数必须拒绝', /validate/)
  mustThrow(() => reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: {} }),
    '注入的 fs 没有 readFileSync 必须拒绝', /fs/)

  // 工厂的拒绝面（结构化断言，不是"随便抛个错"）
  const errs = []
  for (const bad of [
    { kind: 'input' },
    { kind: 'input', code: 'X' },
    { kind: 42, code: 'X', error: 'e' },
    { kind: 'input', code: 'X', error: 'e', file: 7 },
    { kind: 'input', code: 'X', error: 'e', line: 1.5 },
    { kind: 'input', code: 'X', error: 'e', errorCode: 0 },
  ]) {
    try { errors.makeFailure(bad); errs.push(`未拒绝 ${JSON.stringify(bad)}`) } catch (e) {
      ok(e instanceof TypeError, `拒绝理由必须是 TypeError（实得 ${e?.name}）`)
    }
  }
  eq(errs.length, 0, `makeFailure 的拒绝面有漏：${errs.join(' | ')}`)
  mustThrow(() => errors.makeFailure('not an object'), '入参不是对象必须拒绝', /对象/)
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 · 非法行不进入有效记录（混合好坏的 jsonl：好行进 entries、坏行进 problems 带行号）
 * ══════════════════════════════════════════════════════════════════════ */
async function A03() {
  const { reader } = mods()
  const dir = tempDir('mixed')
  const validate = (record) => {
    if (typeof record.id !== 'string' || record.id === '') throw new Error('id 必须是非空字符串')
    if (!Number.isSafeInteger(record.n)) throw new Error('n 必须是整数')
    return { id: record.id, n: record.n }
  }

  const text = [
    '{"id":"a","n":1}',        // 1 好
    '{"id":"b","n":oops',      // 2 坏 JSON
    '{"id":"c"}',              // 3 JSON 合法但缺 n
    '{"id":"d","n":4}',        // 4 好
    '',                        // 5 空行（既不算记录也不算问题）
    'null',                    // 6 不是记录
    '{"id":"e","n":5}',        // 7 好
    '   ',                     // 8 只有空白
  ].join('\n') + '\n'

  const file = path.join(dir, 'mixed.jsonl')
  fs.writeFileSync(file, text, 'utf8')

  const r = reader.readLedger(file, { format: 'jsonl', validate })
  eq(r.status, 'invalid', '有坏行的台账必须是 invalid（不是 ok，也不是"尽力而为的 ok"）')
  eqJson(r.entries.map((e) => e.id), ['a', 'd', 'e'], '好行必须按原序进 entries，一条不少')
  for (const bad of ['b', 'c']) {
    ok(!r.entries.some((e) => e && e.id === bad), `坏记录 ${bad} 不许出现在 entries 里`)
  }
  ok(!r.entries.some((e) => e === null || typeof e !== 'object'), 'entries 里不许出现 null/非对象')
  eq(r.problems.length, 3, `坏行要逐条进 problems（实得 ${r.problems.length}：${JSON.stringify(r.problems)}）`)
  ok(/第 2 行/.test(r.problems[0]), `第 1 处坏行是第 2 行（实得 ${r.problems[0]}）`)
  ok(/第 3 行/.test(r.problems[1]), `第 2 处坏行是第 3 行（实得 ${r.problems[1]}）`)
  ok(/第 6 行/.test(r.problems[2]), `第 3 处坏行是第 6 行（实得 ${r.problems[2]}）`)
  ok(/id|n/.test(r.problems[1]), `校验器给的理由要带出来（实得 ${r.problems[1]}）`)
  eq(r.failure.line, 2, 'failure.line 必须指第一处坏行')
  eq(r.failure.code, 'LEDGER_INVALID')
  eq(r.failure.kind, 'input')

  // 同一份内容去掉坏行 → ok，且记录与上面相同（坏行没污染好行）
  const cleanFile = path.join(dir, 'clean.jsonl')
  fs.writeFileSync(cleanFile, ['{"id":"a","n":1}', '{"id":"d","n":4}', '{"id":"e","n":5}'].join('\n') + '\n', 'utf8')
  const clean = reader.readLedger(cleanFile, { format: 'jsonl', validate })
  eq(clean.status, 'ok', '去掉坏行后必须 ok')
  eqJson(clean.entries, r.entries, '坏行不得影响好行的规范记录')

  // 校验器"没返回规范记录"同样是坏记录（不许偷偷退回原始对象）
  const noReturn = reader.readLedger(file, { format: 'jsonl', validate: () => undefined })
  eq(noReturn.status, 'invalid', '校验器没给规范记录时必须是 invalid')
  eq(noReturn.entries.length, 0, '校验器没给规范记录时不许把原始对象塞进 entries')

  EVID.samples.mixed = {
    file: path.basename(file), status: r.status, goodIds: r.entries.map((e) => e.id),
    problems: r.problems, failureLine: r.failure.line,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 原始系统码与既有业务码不被改名（且旧码值零变更）
 * ══════════════════════════════════════════════════════════════════════ */
async function A04() {
  const { errors, reader } = mods()
  const iface = fs.readFileSync(path.join(REPO, 'docs', 'unify', 'interfaces.md'), 'utf8')
  // U01 的 tracked 出口与码表登记（⑤ 用它做**动态**比对；⑥-4 用它复核字节数）
  const u01 = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'unify', 'receipts', 'U01.json'), 'utf8'))

  // ① 这些码值必须是 U01 锁定的**真实码表**里的值（不是本卡编的）
  for (const code of [...SYSTEM_CODES, ...BUSINESS_CODES, ...KEBAB_CODES]) {
    ok(iface.includes(code), `码值 ${code} 不在 U01 锁定的真实码表里 —— 不许凭空编码`)
  }
  // 系统码与 kebab 码族要在真实源码里确实存在（不只是文档里写着）
  ok(fs.readFileSync(path.join(REPO, 'lib', 'evidence-io.js'), 'utf8').includes('IO_ERROR'),
    'IO_ERROR 必须真的在 lib/evidence-io.js 里（既有业务码的落点）')
  const gateSrc = fs.readFileSync(path.join(REPO, 'lib', 'gate.js'), 'utf8')
  for (const code of ['criteria-not-met', 'evidence-insufficient', 'stale-snapshot']) {
    ok(gateSrc.includes(code), `kebab 码 ${code} 必须真的在 lib/gate.js 里`)
  }
  ok(fs.readFileSync(path.join(REPO, 'lib', 'point-ref.js'), 'utf8').includes('halo-mismatch'),
    'kebab 码 halo-mismatch 必须真的在 lib/point-ref.js 里')

  // ② 逐个码值原样带出：错一个字节（大小写、前缀、映射）就算失败
  const roundTrip = []
  for (const code of [...SYSTEM_CODES, ...BUSINESS_CODES, ...KEBAB_CODES]) {
    const r = reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ error: ioError(code) }).fs })
    eq(r.errorCode, code, `errorCode 被改名：注入 ${code} → 带出 ${r.errorCode}`)
    if (code === 'ENOENT') {
      eq(r.status, 'missing', 'ENOENT 仍是 missing（码值语义不变）')
      ok(!('failure' in r), 'missing 不带 failure（不存在不是失败）')
    } else {
      eq(r.status, 'io-error', `${code} 已是读取故障（status 语义不变）`)
      eq(r.failure.errorCode, code, `failure.errorCode 被改名：注入 ${code} → 带出 ${r.failure.errorCode}`)
      eq(r.failure.code, 'IO_ERROR', `${code} 的业务码仍是既有 IO_ERROR（不再造第二个同义码）`)
    }
    roundTrip.push({ code, status: r.status, errorCode: r.errorCode, failureCode: r.failure ? r.failure.code : null })
  }

  // ③ 工厂不覆盖领域顶层 kind/code：领域对象原样不动，失败挂在 failure 上
  const domain = { ok: false, kind: 'gate', code: 'criteria-not-met', lesson: 'spring-boot/0001' }
  const before = JSON.stringify(domain)
  const failure = errors.makeFailure({ kind: 'input', code: 'LEDGER_INVALID', error: '台账坏了', file: 'x.jsonl', line: 1 })
  const merged = { ...domain, failure }
  eq(merged.kind, 'gate', '领域顶层 kind 不许被 failure 的 kind 覆盖')
  eq(merged.code, 'criteria-not-met', '领域顶层 code 不许被 failure 的 code 覆盖')
  eq(JSON.stringify(domain), before, '工厂不许改动传入的领域对象（一个字节都不许）')
  eqJson(Object.keys(failure), ['kind', 'code', 'error', 'file', 'line'], '工厂只产 failure 对象，不把领域字段带出来')

  // ④ 两个新模块**没有改名表**：码值路径上不许出现大小写转换/映射
  for (const [name, file] of [['errors.cjs', ERRORS_FILE], ['ledger-read.cjs', READER_FILE]]) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    ok(!/\.toUpperCase\s*\(|\.toLowerCase\s*\(/.test(src), `${name} 里出现了大小写改写（码值会走形）`)
    ok(!/CODE_ALIAS|RENAME|ALIASES/.test(src), `${name} 里出现了别名/改名表`)
  }

  // ⑤ 拟新增码的**归属**（U-SPEC §3 真正要求的那两条：不许第二份定义 + 不与既有码重名）。
  //    "码名出现在某个文件里"本身**不是**冲突：合法消费方把它当 `code:` 值用
  //    （U06 正在把 LOCK_BUSY / RECOVERY_REQUIRED 接进提交守卫与恢复状态机）正是设计本意，
  //    U-SPEC 只要求"必须查重名和语义冲突 / 有冲突阻断 / 不能改旧码"，从没要求新码只能待在 lib/unify。
  const newCodes = Object.keys(errors.NEW_CODES).sort()
  eqJson(newCodes, ['ID_AMBIGUOUS', 'LEDGER_INVALID', 'LOCK_BUSY', 'MIGRATION_REQUIRED', 'RECOVERY_REQUIRED'],
    'NEW_CODES 必须是 U-SPEC 那五个')

  // ⑤-1 这五个名字来自 U01 的锁（§5.3 查重表 + 回执登记的 proposedNew），不是本卡自造
  const sec53 = iface.slice(iface.indexOf('### 5.3'))
  ok(iface.includes('### 5.3') && sec53.length > 0, 'interfaces.md 里找不到 §5.3 的查重结论（U01 的锁被移动/改名）')
  for (const code of newCodes) ok(sec53.includes(`\`${code}\``), `拟新增码 ${code} 不在 U01 §5.3 的查重表里`)
  const u01Codes = u01.interfaceConsumption?.errorCodes
  ok(u01Codes && typeof u01Codes === 'object', 'U01 回执缺 interfaceConsumption.errorCodes 登记')
  eqJson([...(u01Codes.proposedNew ?? [])].sort(), newCodes,
    'U01 回执登记的拟新增码与本卡落地的五个不一致（码名漂移必须阻断）')

  // ⑤-2 定义级查重：五个码**只许有一份定义**（lib/unify/errors.cjs），别处出现只能是"使用"；
  //      每个码在那个唯一落点里恰好声明一次。逐命中点的定义/使用分类进证据（可解释）。
  const ownership = assertCodeOwnership(REPO, newCodes, { where: '真实工作树' })
  const readerOwnUse = ownership.uses.find((u) => u.code === 'LEDGER_INVALID'
    && u.file === 'lib/unify/ledger-read.cjs' && u.reason === 'code-value')
  ok(readerOwnUse, 'ledger-read.cjs 里的 `code: \'LEDGER_INVALID\'` 必须被判成"使用"（读取层是合法消费方；判成定义就是判据自己空转）')

  // ⑤-3 重名：五个新码的名字不得与 U01 锁定的既有码（86 大写 + 17 kebab）重名
  const lockCodes = lockCodeTables(iface)
  eq(lockCodes.upper.length, lockCodes.declaredDistinct,
    `§5.1 大写码条数与文档自述"真实码表 N 个不同值"不符（${lockCodes.upper.length} ≠ ${lockCodes.declaredDistinct}）`)
  ok(Number.isInteger(u01Codes.kebabFamily), 'U01 回执缺 kebabFamily 登记（kebab 码族条数没法动态核对）')
  eq(lockCodes.kebab.length, u01Codes.kebabFamily,
    `§5.2 kebab 码族条数与 U01 回执登记不符（${lockCodes.kebab.length} ≠ ${u01Codes.kebabFamily}）`)
  const takenNames = new Set([...lockCodes.upper, ...lockCodes.kebab].map((c) => c.toLowerCase()))
  for (const code of newCodes) {
    ok(!takenNames.has(code.toLowerCase()),
      `拟新增码 ${code} 与既有码表重名（已有 ${lockCodes.upper.length} 个大写码 + ${lockCodes.kebab.length} 个 kebab 码）`)
  }

  // ⑤-4 反空转（和 A07 同一套做法：在 E:\Temp 副本上用**子进程**跑同一份判据）：
  //      消费方只用不定义 → 必须绿；往消费方塞一份第二定义 → 必须红，且点名被重复定义的码。
  const fixture = buildCodeOwnershipFixture()

  // ⑤-4a 形态判别本体（纯函数，不落盘）：object-key 这一形态**语义上分两种**，必须分开判 ——
  //      值=同一个码名字面量 → 又写了一份码值（定义，红）；值=别的（true / 'busy' / 变量）→
  //      只是拿码名当查找键（使用，放行）。下面每条都是一份**活样本**，不是口头规则。
  const shapeCases = [
    ['LOCK_BUSY', "const CODES = { LOCK_BUSY: 'LOCK_BUSY' }", 'definition', 'alias-code-table',
      '别名码表（键=码名、值=同一个字面量）'],
    ['LOCK_BUSY', "const CODES2 = Object.freeze({ LOCK_BUSY: 'LOCK_BUSY' })", 'definition', 'alias-code-table',
      'Object.freeze 包裹的别名码表'],
    ['LEDGER_INVALID', "const M = { 'LEDGER_INVALID': \"LEDGER_INVALID\" }", 'definition', 'alias-code-table',
      '引号写法的别名码表'],
    ['LOCK_BUSY', SPIN_GREEN_MEMBERSHIP, 'use', 'membership-set', '成员集（值是 true）'],
    ['LOCK_BUSY', "const MAP = { LOCK_BUSY: 'busy' }", 'use', 'mapping-key', '映射表（值是别的字符串）'],
    ['LOCK_BUSY', 'const MAP2 = { LOCK_BUSY: kLockBusy }', 'use', 'mapping-key', '映射表（值是变量引用）'],
  ]
  const shapeSeen = []
  for (const [code, src, kind, form, why] of shapeCases) {
    const occ = classifyCodeOccurrences(src, code)
    const hits = occ.filter((o) => o.kind === kind)
    eq(hits.length, 1, `「${why}」必须判成恰好一处 ${kind}（实得 ${JSON.stringify(occ.map((o) => [o.line, o.kind, o.form, o.reason]))}）`)
    eq(hits[0].form, form, `「${why}」的形态名不对（实得 ${hits[0].form}）`)
    shapeSeen.push({ code, source: src, kind, form, reason: hits[0].reason, reasonText: hits[0].reasonText })
  }

  const greenOwnership = assertCodeOwnership(fixture.green, newCodes, { where: '对照副本（消费方只用不定义）' })
  const greenConsumerUses = greenOwnership.uses.filter((u) => u.file === CONSUMER_REL).length
  ok(greenConsumerUses >= 3,
    `对照副本里消费方的合法用法必须被认出来（实得 ${greenConsumerUses} 处）—— 认不出来就是判据空转`)
  ok(greenOwnership.uses.some((u) => u.file === CONSUMER_REL && u.reason === 'comment-mention'),
    '对照副本里**注释中的提及**必须被判成"使用/提及"（既不当定义，也不当不存在）')
  // 绿副本里的**成员集**必须被看见（判成使用，不是"没扫到"）：看不见它就证明这条反空转样本没生效
  const greenMembership = greenOwnership.uses.find((u) => u.file === CONSUMER_REL
    && u.code === 'LOCK_BUSY' && u.reason === 'membership-set')
  ok(greenMembership, `对照副本里的成员集没被判成使用（样本：${SPIN_GREEN_MEMBERSHIP}）—— 判据看不见它就是空转：`
    + JSON.stringify(greenOwnership.uses.filter((u) => u.file === CONSUMER_REL)))
  eq(greenOwnership.definitions.filter((d) => d.file !== SINGLE_DECL_FILE).length, 0,
    '对照副本里消费方出现了定义（成员集/查找键不是定义，判成定义就是又误杀了）')
  const greenRun = runCodeOwnershipCheck(fixture.green)
  eq(greenRun.code, 0, `对照副本必须绿（实得 exit ${greenRun.code}：${greenRun.stdout.trim()}）`)
  eq(greenRun.stdout.trim(), 'CODE-OWNERSHIP OK', '对照副本的判词行不对')
  const redRun = runCodeOwnershipCheck(fixture.red)
  eq(redRun.code, 1, `变异副本必须红（实得 exit ${redRun.code}：${redRun.stdout.trim()}）—— 反空转失效`)
  ok(/^CODE-OWNERSHIP FAIL /.test(redRun.stdout.trim()), `变异副本的判词不是 FAIL：${redRun.stdout.trim()}`)
  ok(/第二份定义/.test(redRun.stdout), `变异副本的 FAIL 必须说清是"第二份定义"：${redRun.stdout.trim()}`)
  for (const code of ['LOCK_BUSY', 'RECOVERY_REQUIRED']) {
    ok(redRun.stdout.includes(code), `变异副本的 FAIL 要点名被重复定义的码 ${code}：${redRun.stdout.trim()}`)
  }
  // 红副本里的两种**真定义**形态逐个坐实（判据强度：值=码名本身的别名表仍然红）
  const redOwnership = scanCodeOwnership(fixture.red, newCodes)
  const redSecond = redOwnership.definitions.filter((d) => d.file !== SINGLE_DECL_FILE)
  ok(redSecond.some((d) => d.code === 'LOCK_BUSY' && d.form === 'alias-code-table'),
    `红副本里的别名码表必须仍判成定义（实得 ${JSON.stringify(redSecond.map((d) => [d.code, d.form]))}）`)
  ok(redSecond.some((d) => d.code === 'RECOVERY_REQUIRED' && d.form === 'identifier-binding'),
    '红副本里的标识符重复绑定必须仍判成定义')
  dropTempDir('mut-codes-green')
  dropTempDir('mut-codes-red')
  ok(!fs.existsSync(fixture.green) && !fs.existsSync(fixture.red), '反空转副本必须清干净（不留残渣）')

  // ⑥ 旧码值零变更：靠**内容**证明，不靠"工作树干净"（共享工作树里别的 lane 正在写自己的写集，
  //    那不属于 U03 的判据）。三件事：本卡只新增、码值宿主里码值还在、U01 的两个出口一字未动。
  const porcelain = gitStatus()
  const trackedDirty = porcelain.filter((l) => !l.startsWith('??'))
  // ⑥-1 两个新模块必须是**新增**：固定提交对象里没有
  for (const rel of ['lib/unify/errors.cjs', 'lib/unify/ledger-read.cjs']) {
    ok(!gitPathAtHead(rel), `${rel} 在固定基线提交里已存在 —— 那就不是"新增"，写集对不上`)
  }
  ok(porcelain.some((l) => l.startsWith('??') && l.includes('lib/unify')),
    'lib/unify/ 必须作为未跟踪项出现（新模块不该被 add，本卡不操作 index）')
  // ⑥-2 本卡命名空间里不许有 tracked 改动（有的话说明有人动了 index，写集纪律被破坏）
  const unifyDirty = trackedDirty
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((p) => p.startsWith('lib/unify/'))
  eq(unifyDirty.length, 0, `lib/unify/ 出现 tracked 改动：${unifyDirty.slice(0, 5).join(' | ')}`)
  // ⑥-3 码值宿主里码值必须还在（内容断言；以后谁重构这些文件，只要码值没变就不算回归）
  const HOSTS = [
    ['lib/evidence-io.js', ['IO_ERROR']],
    ['lib/gate.js', ['criteria-not-met', 'evidence-insufficient', 'stale-snapshot']],
    ['lib/point-ref.js', ['missing-ref', 'halo-mismatch', 'ambiguous']],
    ['lib/state.js', ['EVIDENCE_STATUSES']],
  ]
  for (const [rel, needles] of HOSTS) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
    for (const needle of needles) ok(text.includes(needle), `码值宿主 ${rel} 里已经没有 ${needle} —— 码值语义变了`)
  }
  // ⑥-4 U01 的两个 tracked 出口本卡一个字都没碰：字节数必须还等于 U01 回执里记的
  //      （**动态比对**：U01 若合法更新自己的出口并重记回执，本卡随之通过，不假红）
  eq(Buffer.byteLength(iface, 'utf8'), u01.interfaceConsumption.lockBytes,
    'interfaces.md 字节数与 U01 回执不符 —— 接口锁被改过')
  eq(Buffer.byteLength(fs.readFileSync(path.join(REPO, 'docs', 'unify', 'baseline.json'), 'utf8'), 'utf8'),
    u01.interfaceConsumption.baselineBytes,
    'baseline.json 字节数与 U01 回执不符 —— 基线被改过')

  EVID.samples.codes = {
    roundTrip,
    newCodes,
    lockCodes: {
      upper: lockCodes.upper.length,
      kebab: lockCodes.kebab.length,
      declaredDistinct: lockCodes.declaredDistinct,
      receiptKebabFamily: u01Codes.kebabFamily,
      receiptProposedNew: u01Codes.proposedNew,
      namesTakenButNotUsed: [...takenNames].filter((c) => newCodes.map((x) => x.toLowerCase()).includes(c)),
    },
    ownership: {
      classification: 'definition = 把码名绑定到值/键/标识符/成员/常量表的声明形态（只许 errors.cjs 一份）；'
        + 'use = code: 值、failure.code、返回对象里的值、映射表的值、比较对象、实参、注释/文档提及',
      objectKeySplit: {
        rule: 'object-key 形态按「值」再分两种语义：alias-code-table（键=码名 且 值=同一个字符串字面量，'
          + '含 Object.freeze 包裹）→ 定义，必须红；membership-set（值是 true/false/数字）或 '
          + 'mapping-key（值是别的字符串/标识符/表达式）→ 只是拿码名当查找键，使用，放行。'
          + '区间沿用"键 + 冒号"，别名表里值那一处仍记 mapped-value（落点 NEW_CODES 本身就是该形态，'
          + '每码"恰好一次声明"数的正是键那一次）。',
        liveSamples: shapeSeen,
      },
      filesWithOccurrences: ownership.filesWithOccurrences,
      definitions: ownership.definitions,
      perCode: ownership.perCode,
      usesTotal: ownership.uses.length,
      usesListed: ownership.uses.slice(0, 200),
      usesNote: ownership.uses.length > 200 ? `uses 共 ${ownership.uses.length} 处，证据只列前 200 处` : 'uses 全部列出',
    },
    antiVacuum: {
      greenConsumerUses,
      greenSecondDefinitions: greenOwnership.definitions.filter((d) => d.file !== SINGLE_DECL_FILE).length,
      greenExit: greenRun.code,
      greenVerdict: greenRun.stdout.trim().split('\n')[0],
      greenMembershipUse: greenMembership
        ? { code: greenMembership.code, form: greenMembership.reason, snippet: greenMembership.snippet }
        : null,
      redExit: redRun.code,
      redVerdict: redRun.stdout.trim().split('\n')[0],
      redSecondDefinitions: redSecond.map((d) => ({ code: d.code, form: d.form, line: d.line })),
      injectedGreen: [SPIN_GREEN_MEMBERSHIP],
      injectedRed: SPIN_RED_DEFS,
      note: '两个副本与真实工作树走**同一份** assertCodeOwnership：只用不定义（含成员集 `{ …: true }`）'
        + ' → CODE-OWNERSHIP OK / exit 0；塞第二份定义（别名码表 + 标识符绑定）→ CODE-OWNERSHIP FAIL / '
        + 'exit 1 并点名被重复定义的码。两侧都断言，缺一侧就空转：全放过 → 红样本不过；一刀切 → 绿样本不过。',
    },
    trackedDirty: trackedDirty.slice(0, 20),
    note: 'trackedDirty 里出现的既有文件属**其它 lane 的并发写**（本卡写集全为新增），只登记不归因；'
      + '本卡对"旧码值零变更"的证明靠 ⑥-1 只新增 + ⑥-3 码值宿主内容 + ⑥-4 U01 出口字节数。',
  }
}

function walkFiles(absDir, prefix = '') {
  const out = []
  if (!fs.existsSync(absDir)) return out
  for (const e of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkFiles(path.join(absDir, e.name), rel))
    else out.push(rel)
  }
  return out
}

function gitStatus() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`git status 退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}`)
  return String(r.stdout ?? '').split('\n').filter(Boolean)
}

/** 固定提交对象里有没有这个路径（判断"新增"而不是"改旧文件"） */
function gitPathAtHead(rel) {
  const r = spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: REPO, encoding: 'utf8' })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  return r.status === 0
}

/* ══════════════════════════════════════════════════════════════════════
 * A04 · 码表归属：把「定义」与「使用」分开（可解释分类器）
 * ----------------------------------------------------------------------
 * U-SPEC §3 对五个拟新增码只要求两件事：**必须查重名和语义冲突 → 不许有第二份
 * 定义**、**不能改旧码**。它**没有**要求这些码只能出现在 lib/unify 里 ——
 * 合法消费方把它们当 `code:` 值用（U06 正在把 LOCK_BUSY / RECOVERY_REQUIRED 接进
 * 提交守卫与恢复状态机）正是设计本意。所以判定不能是"文本里出现过这个串"
 * （那会把注释、文档和码值用法一起误杀），必须是"这个串在这里是被**定义**还是被
 * **使用**"，并且每个命中点都要能被逐条解释。
 *
 * 定义式（= 违规；只许出现在 lib/unify/errors.cjs，且每个码恰好一次）：
 *   ① 对象**键**、且**值是同一个码名字面量**：`{ LOCK_BUSY: 'LOCK_BUSY' }`、
 *      `'LOCK_BUSY': "LOCK_BUSY"`、`Object.freeze({ … })` 里的同类表 —— 形态名
 *      `alias-code-table`：键与值都是码名，等于**又写了一份码值字面量**（第二份定义）。
 *      ⚠️ object-key 这一形态**不能一刀切**（U03 修正：误杀过成员集）：
 *      `{ PLAN_STALE: true, LOCK_BUSY: true }`、`{ LOCK_BUSY: 'busy' }`、
 *      `Object.freeze({ … })` 里放 true / 'busy' / 数字 / 变量引用 —— 值不是那个码名
 *      字面量，只是**拿码名当查找键**，形态名 `membership-set`（值是 true/false/数字）
 *      或 `mapping-key`（值是别的字符串/标识符/表达式），属于**使用**，必须放行。
 *   ② 标识符绑定：`const|let|var LOCK_BUSY = …`、`function LOCK_BUSY(`
 *   ③ 成员绑定：`module.exports.LOCK_BUSY = …`、`obj['LOCK_BUSY'] = …`
 *   ④ 常量表（数组形态）：`const X = ['LOCK_BUSY', …]`
 * 别名表里**值**那一处（`LOCK_BUSY: 'LOCK_BUSY'` 的引号里）仍按使用（mapped-value）记：
 *   ①的定义区间只覆盖到键的冒号为止。这不是漏判 —— 键那一次已经让整张表成为第二份定义；
 *   而唯一合法落点 errors.cjs 的 `NEW_CODES` 本身就是 alias-code-table 形态，每个码在
 *   落点里"恰好一次声明"数的正是键那一次（把值也算进去就会把落点自己数成两次）。
 * 使用（= 放行；U06 正在做的事）：`code: 'LOCK_BUSY'`、`failure.code`、返回对象里
 *   的值、映射表的值（键是状态名）、membership-set / mapping-key 的键、比较对象、
 *   实参、注释/文档里的提及。
 *   简写属性 `{ LOCK_BUSY }` 不单列成定义式：它必然以标识符绑定为前提（②已经会红），
 *   单列反而会把 `f(a, LOCK_BUSY, b)` 这种**实参**误判成定义。
 * ══════════════════════════════════════════════════════════════════════ */

/** 把注释整段抹成空格（保留换行与列位置）；字符串里的 `//`、`/*` 不算注释。 */
function maskComments(src) {
  const text = String(src)
  const chars = text.split('')
  const n = text.length
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (text[k] !== '\n') chars[k] = ' '
  }
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === ch) { j += 1; break }
        j += 1
      }
      i = j
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** 同步等待（只用于"别的 lane 正在写这个文件"时的极短退避；不引依赖、不引定时器）。 */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * 读源码文本。共享工作树里 U06/U07 可能正在写这些文件：读失败就退避重试；
 * **仍然读不动就点名报错**（不许静默跳过 —— 少看一个文件，"绿"就不算数）。
 */
function readSourceText(abs) {
  let last = null
  for (const delay of [0, 20, 60, 150, 400]) {
    if (delay) sleepMs(delay)
    try { return fs.readFileSync(abs, 'utf8') } catch (e) { last = e }
  }
  throw new Error(`码表归属扫描读不动文件：${abs}（已重试 5 次；${last?.code ?? ''} ${last?.message ?? last}）`)
}

/** 从 `[` 开始做括号配对（跳过字符串/模板），返回配对的 `]` 下标；配不上就 -1。 */
function arrayLiteralEnd(masked, open) {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < masked.length) {
        if (masked[j] === '\\') { j += 2; continue }
        if (masked[j] === ch) { j += 1; break }
        j += 1
      }
      i = j - 1
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 对象**键**的出现点，逐点分成两种**语义不同**的形态（U03 修正：原来一刀切成 object-key 定义，
 * 把「拿码名当查找键的成员集」误杀成第二份定义）：
 *   · `alias-code-table` —— 键 = 码名，且**值是同一个字符串字面量**（`{ LOCK_BUSY: 'LOCK_BUSY' }`，
 *     `Object.freeze({ … })` 包裹的同类表同理）：又写了一份码值字面量 → **定义**，必须红。
 *   · `membership-set`  —— 值是 `true` / `false` / 数字（`{ PLAN_STALE: true, LOCK_BUSY: true }`）；
 *     `mapping-key`     —— 值是别的字符串 / 标识符 / 表达式（`{ LOCK_BUSY: 'busy' }`）。
 *     两者都只是**拿码名当查找键** → **使用**，必须放行。
 * 区间沿用"键 + 冒号"（不含值），和 ① 原来的区间口径一致（见上方关于值那一处的说明）。
 */
function objectKeyOccurrences(masked, code) {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[{,(])\\s*(?:'${esc}'|"${esc}"|${esc})\\s*:`, 'gm')
  const out = []
  for (const m of masked.matchAll(re)) {
    const start = m.index
    const end = m.index + m[0].length
    // 值：冒号之后跳过空白/换行，看紧跟的那个表达式是不是**同一个码名字面量**
    const rest = masked.slice(end, end + 240)
    const literal = rest.match(/^\s*(['"`])([^'"`\n]*)\1/)
    const sameLiteral = Boolean(literal) && literal[2] === code
    const scalar = /^\s*(?:true|false|null|undefined|-?\d[\d._eExX]*)\s*(?:[,}]|$)/.test(rest)
    out.push({
      start,
      end,
      form: sameLiteral ? 'alias-code-table' : (scalar ? 'membership-set' : 'mapping-key'),
      isDefinition: sameLiteral,
    })
  }
  return out
}

/** 一个码在（已抹注释的）源码里的**定义式**区间；每段带形态名，便于逐条解释。 */
function definitionSpans(masked, code, keyOccurrences = objectKeyOccurrences(masked, code)) {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const spans = []
  const add = (re, form) => {
    for (const m of masked.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, form })
  }
  // ① 对象/枚举对象的**键**：只收「键=码名 且值=同一个字面量」的别名码表（`Object.freeze({…})` 同理）；
  //    成员集 / 映射表（值是 true / 'busy' / 数字 / 变量引用）是使用，不在这里成段。
  for (const k of keyOccurrences) {
    if (k.isDefinition) spans.push({ start: k.start, end: k.end, form: k.form })
  }
  // ② 标识符绑定（`const|let|var C = …`、`function C(`）
  add(new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*(?=[=;])`, 'g'), 'identifier-binding')
  add(new RegExp(`\\bfunction\\s+${esc}\\s*\\(`, 'g'), 'function-binding')
  // ③ 成员绑定（`module.exports.C = …`、`obj['C'] = …`）
  add(new RegExp(`(?:\\.|\\[\\s*['"])${esc}(?:['"]\\s*\\])?\\s*=(?!=)`, 'g'), 'member-binding')
  // ④ 常量表（数组形态）：**配对到真正的 `]`** 再看元素里有没有这个码 ——
  //    不做"2000 字符内出现过"这种跨语句模糊匹配（那会把别的 `[` 和后面的映射值连起来误判）
  const tableRe = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:Object\.freeze\(\s*)?\[/g
  for (const m of masked.matchAll(tableRe)) {
    const open = m.index + m[0].length - 1
    const close = arrayLiteralEnd(masked, open)
    if (close < 0) continue
    if (new RegExp(`['"]${esc}['"]`).test(masked.slice(open, close + 1))) {
      spans.push({ start: open, end: close + 1, form: 'code-table-array' })
    }
  }
  return spans
}

/** 非定义的出现点：给它一个可解释的理由（证据里逐条写出来，不是黑盒）。 */
function useReason(masked, original, index, code) {
  if (original.slice(index, index + code.length) !== masked.slice(index, index + code.length)) {
    return { reason: 'comment-mention', reasonText: '注释/文档里的提及（抹注释后即为空，不是定义）' }
  }
  // 码是字符串字面量时，`before` 会以引号收尾（`code: '`），先去掉这个引号再看它前面是什么
  const before = masked.slice(Math.max(0, index - 80), index).replace(/['"`]$/, '')
  const after = masked.slice(index + code.length, index + code.length + 8).replace(/^['"`]/, '')
  if (/(?:\bcode|\berrorCode)\s*:\s*$/.test(before)) return { reason: 'code-value', reasonText: '作为 code: 的字符串值（合法消费方）' }
  if (/(?:===|!==|==|!=)\s*$/.test(before)) return { reason: 'comparison', reasonText: '比较对象' }
  if (/^[ \t]*(?:===|!==|==|!=|\.includes|\.indexOf)/.test(after)) return { reason: 'comparison', reasonText: '比较对象' }
  if (/:\s*$/.test(before)) return { reason: 'mapped-value', reasonText: '映射表里的值（键是状态名，不是码名）' }
  if (/(?:\breturn|=>|\?)\s*$/.test(before)) return { reason: 'return-value', reasonText: '作为返回值/三元分支' }
  if (/(?:\(|,)\s*$/.test(before)) return { reason: 'argument', reasonText: '作为实参/值' }
  return { reason: 'mention', reasonText: '非声明式提及' }
}

function lineNumberAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1
  return line
}

function snippetAt(text, index, len) {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index + len)
  const line = text.slice(start, end === -1 ? text.length : end).trim()
  return line.length > 140 ? `${line.slice(0, 140)}…` : line
}

/**
 * 逐命中点分类：kind = definition（定义式）/ use（使用），带行号、形态、可读理由与原文片段。
 * 命中点按**原文**取下标（抹注释不改变长度，下标一一对应）：注释里的提及也要被看见 ——
 * 它是"使用/提及"，既不是定义，也不许被当成"不存在"（那会让证据说不清）。
 */
function classifyCodeOccurrences(source, code) {
  const masked = maskComments(source)
  const keyOccurrences = objectKeyOccurrences(masked, code)
  const spans = definitionSpans(masked, code, keyOccurrences)
  const out = []
  for (const m of source.matchAll(new RegExp(`\\b${code}\\b`, 'g'))) {
    const index = m.index
    const inComment = source.slice(index, index + code.length) !== masked.slice(index, index + code.length)
    // 注释里的串**一律**按提及处理（即使它落在某段真实定义式的字符区间里，也不算定义）
    const def = (!inComment && spans.find((s) => index >= s.start && index < s.end)) || null
    // 非定义的 object-key（成员集 / 映射表）单独给出理由：它"被看见了"，只是不算定义
    const keyUse = (!inComment && !def
      && keyOccurrences.find((k) => !k.isDefinition && index >= k.start && index < k.end)) || null
    const use = def ? null
      : keyUse
        ? {
          reason: keyUse.form,
          reasonText: keyUse.form === 'membership-set'
            ? '成员集的键（值是 true/false/数字：拿码名当查找键，不是又写一份码名字面量）'
            : '映射表的键（值不是码名本身：拿码名当查找键，不是又写一份码名字面量）',
        }
        : useReason(masked, source, index, code)
    out.push({
      index,
      line: lineNumberAt(source, index),
      kind: def ? 'definition' : 'use',
      form: def ? def.form : (keyUse ? keyUse.form : 'not-a-declaration'),
      reason: def ? 'definition' : use.reason,
      reasonText: def
        ? (def.form === 'alias-code-table'
          ? '定义式（alias-code-table：键=码名且值=同一个字面量 —— 等于又写了一份码值定义）'
          : `定义式（${def.form}：把码名绑定到值/键/标识符/常量表）`)
        : use.reasonText,
      snippet: snippetAt(source, index, code.length),
    })
  }
  return out
}

/** 扫生产源码（lib / tools / preset）里这些码的每一个命中点并分类。 */
function scanCodeOwnership(rootDir, codes) {
  const report = { definitions: [], uses: [], perCode: {}, filesWithOccurrences: 0, generatedCopies: [] }
  for (const code of codes) report.perCode[code] = { definitions: 0, uses: 0, declarationsInSingle: 0 }
  for (const dirName of SCAN_DIRS) {
    for (const rel of walkFiles(path.join(rootDir, dirName))) {
      if (!/[^/]+\.(?:[cm]?js)$/i.test(rel)) continue
      if (rel.split('/').includes('node_modules')) continue
      const file = `${dirName}/${rel}`
      // 决-9 连带（副本出现后口径过期）：`lib/pack-template/tools/unify/**` 是 U19 的
      // **逐字节生成副本**，不是第二份实现 —— 唯一性扫描必须现算排除它。
      // 排除**不是放行**：assertCodeOwnership 会逐字节对拍被排除的那份与权威 errors.cjs，
      // 拿生成目录藏一份真实现这条路仍然堵死。
      if (file.startsWith(GENERATED_MIRROR_PREFIX)) { report.generatedCopies.push(file); continue }
      const source = readSourceText(path.join(rootDir, dirName, rel))
      if (!codes.some((c) => source.includes(c))) continue
      report.filesWithOccurrences += 1
      for (const code of codes) {
        if (!source.includes(code)) continue
        for (const occ of classifyCodeOccurrences(source, code)) {
          const rec = {
            code, file, line: occ.line, kind: occ.kind, form: occ.form,
            reason: occ.reason, reasonText: occ.reasonText, snippet: occ.snippet,
          }
          if (occ.kind === 'definition') {
            report.definitions.push(rec)
            report.perCode[code].definitions += 1
            if (file === SINGLE_DECL_FILE) report.perCode[code].declarationsInSingle += 1
          } else {
            report.uses.push(rec)
            report.perCode[code].uses += 1
          }
        }
      }
    }
  }
  return report
}

/**
 * A04 ⑤ 的判据本体（反空转副本走的是**同一份**函数）：
 *   ① 这些码在生产源码里**只许有一份定义**，且只能落在 lib/unify/errors.cjs；
 *   ② 每个码在那个唯一落点里恰好声明一次（重复声明本身就是第二份定义）。
 * 不满足就抛（= 判据红）；返回分类明细供证据落盘。
 */
function assertCodeOwnership(rootDir, codes, { where = '真实工作树' } = {}) {
  const report = scanCodeOwnership(rootDir, codes)
  const second = report.definitions.filter((d) => d.file !== SINGLE_DECL_FILE)
  eq(second.length, 0, `[${where}] 拟新增码出现了第二份定义（重名/语义冲突必须阻断；只许 ${SINGLE_DECL_FILE} 一份）：`
    + second.slice(0, 6).map((d) => `${d.file}:${d.line} ${d.code}（${d.form}）`).join(' | '))
  // 被排除的生成副本必须**逐字节等于**权威那一份（否则它就是第二份实现，不是副本）
  const mirrorErrors = report.generatedCopies.filter((f) => f.endsWith('/errors.cjs'))
  for (const file of mirrorErrors) {
    const a = path.join(rootDir, ...SINGLE_DECL_FILE.split('/'))
    const b = path.join(rootDir, ...file.split('/'))
    if (fs.existsSync(b)) {
      eq(fs.readFileSync(b).equals(fs.readFileSync(a)), true,
        `[${where}] 被排除的生成副本 ${file} 必须与权威 ${SINGLE_DECL_FILE} 逐字节相同（否则它是第二份定义）`)
    }
  }
  for (const code of codes) {
    eq(report.perCode[code].declarationsInSingle, 1,
      `[${where}] ${code} 在 ${SINGLE_DECL_FILE} 里必须恰好声明一次（实得 ${report.perCode[code].declarationsInSingle} 次）`)
  }
  return report
}

/**
 * 反空转夹具（A04 ⑤-4）：在本次 E:\Temp 运行目录里造两棵**迷你消费方树**，
 * 两棵的唯一差别是：红的那个在消费方里多出两份「第二定义」。
 *   <root>/lib/unify/errors.cjs                            —— 真实 errors.cjs 的拷贝（唯一合法定义）
 *   <root>/lib/pack-template/tools/ledger-transaction.cjs   —— 合法消费方（只当 code 值用）
 *   <root>/tools/recover-ledgers.mjs                        —— 合法消费方（tools/ 根也要被扫到）
 */
function buildCodeOwnershipFixture() {
  const root = { green: tempDir('mut-codes-green'), red: tempDir('mut-codes-red') }
  const consumer = (extraDefs) => [
    "'use strict'",
    '/** 合法消费方（U06 的接线形态）：五个新码只当 code 值用，不定义 */',
    '// 注释里提到 LOCK_BUSY / RECOVERY_REQUIRED 同样不算定义（提及 ≠ 定义，也不许被当成不存在）',
    "const { NEW_CODES } = require('../../unify/errors.cjs')",
    ...extraDefs,
    'function guard(state) {',
    "  if (state.busy) return { ok: false, failure: { kind: 'conflict', code: 'LOCK_BUSY', error: '已有作业在跑' } }",
    "  if (state.needsRecovery) return { ok: false, code: 'RECOVERY_REQUIRED' }",
    '  return { ok: true, code: NEW_CODES.LOCK_BUSY }',
    '}',
    'module.exports = { guard }',
    '',
  ].join('\n')
  const tool = () => [
    '#!/usr/bin/env node',
    '/** 恢复工具（合法消费方）：码值原样带出，不定义 */',
    "const res = { ok: false, code: 'RECOVERY_REQUIRED', note: '需要恢复' }",
    'process.stdout.write(`${res.code}\\n`)',
    '',
  ].join('\n')
  for (const dir of [root.green, root.red]) {
    for (const sub of [path.join('lib', 'unify'), path.join('lib', 'pack-template', 'tools'), 'tools']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true })
    }
    fs.copyFileSync(ERRORS_FILE, path.join(dir, 'lib', 'unify', 'errors.cjs'))
    fs.writeFileSync(path.join(dir, TOOL_REL), tool(), 'utf8')
  }
  fs.writeFileSync(path.join(root.green, CONSUMER_REL), consumer([
    '// ↓ 反空转用（绿）：成员集 —— 值是 true，只拿码名当查找键，不是第二份定义',
    SPIN_GREEN_MEMBERSHIP,
  ]), 'utf8')
  fs.writeFileSync(path.join(root.red, CONSUMER_REL), consumer([
    '// ↓ 反空转用（红）：把码名重新绑定一次（U-SPEC 要阻断的「第二份定义」形态）',
    ...SPIN_RED_DEFS,
  ]), 'utf8')
  return root
}

/**
 * 从 U01 的接口锁（docs/unify/interfaces.md §5）里读**码表本身**，不信任何硬编码清单：
 * §5.1 大写码表 / §5.2 kebab 码族表的第一列，以及正文自述的「真实码表 N 个不同值」。
 */
function lockCodeTables(iface) {
  const section = (title) => {
    const start = iface.indexOf(`### ${title}`)
    if (start < 0) throw new Blocked(`interfaces.md 里找不到「### ${title}」—— U01 的码表锁被移动/改名`)
    const rest = iface.slice(start + 4)
    const next = rest.search(/^### /m)
    return next < 0 ? rest : rest.slice(0, next)
  }
  const rows = (text) => [...text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1])
  const declared = iface.match(/真实码表 \*\*(\d+)\*\* 个不同值/)
  return {
    upper: rows(section('5.1')),
    kebab: rows(section('5.2')),
    declaredDistinct: declared ? Number(declared[1]) : NaN,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 · 整文件 json 与 jsonl 两种输入按声明处理（同一内容各自结果可断言）
 * ══════════════════════════════════════════════════════════════════════ */
async function A05() {
  const { reader } = mods()
  const dir = tempDir('formats')
  const validate = (r) => {
    if (typeof r.id !== 'string') throw new Error('id 必须是字符串')
    return { id: r.id, n: r.n ?? null }
  }

  const jsonFile = path.join(dir, 'ledger.json')
  const jsonlFile = path.join(dir, 'ledger.jsonl')
  fs.writeFileSync(jsonFile, '[\n  {"id":"a","n":1},\n  {"id":"b","n":2}\n]\n', 'utf8')
  fs.writeFileSync(jsonlFile, '{"id":"a","n":1}\n{"id":"b","n":2}\n', 'utf8')

  const asJson = reader.readLedger(jsonFile, { format: 'json', validate })
  const asJsonl = reader.readLedger(jsonlFile, { format: 'jsonl', validate })
  eq(asJson.status, 'ok', '整文件 json 必须 ok')
  eq(asJsonl.status, 'ok', 'jsonl 必须 ok')
  eqJson(asJson.entries, asJsonl.entries, '同一批内容：两种声明读出的规范记录必须逐字段相同')
  eq(asJson.entries.length, 2, '整文件 json：两条记录')

  // 声明错格式 → 各按各的规则失败（**不许互相兜底**）
  const wrong1 = reader.readLedger(jsonFile, { format: 'jsonl', validate })
  eq(wrong1.status, 'invalid', '整文件数组声明成 jsonl 必须 invalid（不是"自动识别成 json"）')
  ok(wrong1.entries.length < 2, `jsonl 声明下不许把整个数组当记录集合收下（实得 ${wrong1.entries.length} 条）`)
  ok(!wrong1.entries.some((e) => Array.isArray(e)), 'jsonl 声明下 entries 里不许出现数组')
  // 逐行读时只有"本身是合法 JSON 对象的那一行"能算记录（这里是第 3 行），**不许把数组拼回来**
  eqJson(wrong1.entries.map((e) => e.id), ['b'], 'jsonl 逐行读只能收下真正的合法记录行（不许还原数组）')
  ok(wrong1.problems.length >= 1, '声明错格式也要留下 problems')

  const wrong2 = reader.readLedger(jsonlFile, { format: 'json', validate })
  eq(wrong2.status, 'invalid', 'jsonl 文件声明成 json 必须 invalid（不是"逐行兜底"）')
  eq(wrong2.entries.length, 0, 'json 声明下不许把 jsonl 兜底成数组')
  ok(/JSON/.test(wrong2.problems[0]), `json 声明下的问题要说清是 JSON 解析失败（实得 ${wrong2.problems[0]}）`)

  // 整文件 json 的坏元素也要逐条定位（用"记录 #n"，不假装是行号）
  const mixedJson = path.join(dir, 'mixed.json')
  fs.writeFileSync(mixedJson, '[{"id":"a"},{"n":2},null,{"id":"d"}]', 'utf8')
  const mixed = reader.readLedger(mixedJson, { format: 'json', validate })
  eq(mixed.status, 'invalid', '数组里有坏元素 → invalid')
  eqJson(mixed.entries.map((e) => e.id), ['a', 'd'], '数组里的好元素照收、坏元素不进 entries')
  eq(mixed.problems.length, 2, '两个坏元素要各成一条问题')
  ok(/记录 #2/.test(mixed.problems[0]), `问题要指到记录序号（实得 ${mixed.problems[0]}）`)
  ok(/记录 #3/.test(mixed.problems[1]), `问题要指到记录序号（实得 ${mixed.problems[1]}）`)
  ok(!/第 3 行/.test(mixed.problems[1]), '整文件 json 不许把元素序号伪装成行号')

  // BOM 不算坏行（两种格式都认）
  const bomJsonl = path.join(dir, 'bom.jsonl')
  fs.writeFileSync(bomJsonl, '\uFEFF{"id":"a","n":1}\n', 'utf8')
  eq(reader.readLedger(bomJsonl, { format: 'jsonl', validate }).status, 'ok', 'jsonl 的 BOM 必须剥掉（不是坏行）')
  const bomJson = path.join(dir, 'bom.json')
  fs.writeFileSync(bomJson, '\uFEFF[{"id":"a"}]', 'utf8')
  eq(reader.readLedger(bomJson, { format: 'json', validate }).status, 'ok', 'json 的 BOM 必须剥掉')

  EVID.samples.formats = {
    jsonStatus: asJson.status, jsonlStatus: asJsonl.status,
    sameEntries: JSON.stringify(asJson.entries) === JSON.stringify(asJsonl.entries),
    wrongJsonlStatus: wrong1.status, wrongJsonStatus: wrong2.status,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * A06 · 读取无写盘副作用
 * ══════════════════════════════════════════════════════════════════════ */
async function A06() {
  const { reader } = mods()
  const dir = tempDir('readonly')
  const file = path.join(dir, 'ledger.jsonl')
  fs.writeFileSync(file, '{"id":"a"}\n{"id":"b"}\n', 'utf8')
  const badFile = path.join(dir, 'bad.jsonl')
  fs.writeFileSync(badFile, '{"id":"a"}\n不是JSON\n', 'utf8')

  const before = snapshotTree(dir)

  // ① 真实文件：把五种读法都跑一遍
  const reads = [
    reader.readLedger(file, { format: 'jsonl' }),
    reader.readLedger(file, { format: 'jsonl' }),
    reader.readLedger(badFile, { format: 'jsonl' }),
    reader.readLedger(path.join(dir, 'absent.jsonl'), { format: 'jsonl' }),
    reader.readLedger(dir, { format: 'jsonl' }),
  ]
  eqJson(reads.map((r) => r.status), ['ok', 'ok', 'invalid', 'missing', 'io-error'], '五种读法都要真的跑到')

  const after = snapshotTree(dir)
  eqJson(after, before, '读取不许改动目录清单 / 内容 / mtime（读前读后必须逐项相同）')

  // ② 注入探针：写能力一次都不许被调用，且每次读只读一次
  for (const [label, spec, format] of [
    ['ok', { text: '{"id":"a"}\n' }, 'jsonl'],
    ['empty', { text: '' }, 'jsonl'],
    ['invalid', { text: '{bad\n' }, 'jsonl'],
    ['missing', { error: ioError('ENOENT') }, 'jsonl'],
    ['io-error', { error: ioError('EACCES') }, 'jsonl'],
    ['json', { text: '[{"id":"a"}]' }, 'json'],
  ]) {
    const probe = makeFakeFs(spec)
    const r = reader.readLedger(FAKE_FILE, { format, fs: probe.fs })
    eq(probe.calls.writes.length, 0, `[${label}] 读取不许调用任何写能力（实得 ${JSON.stringify(probe.calls.writes)}）`)
    eq(probe.calls.readFileSync.length, 1, `[${label}] 一次读取只许 readFileSync 一次`)
    ok(r && typeof r.status === 'string', `[${label}] 必须返回结果对象`)
  }

  // ③ 结构证据：模块源码里根本没有写能力（不是"这次没调到"）
  const src = fs.readFileSync(READER_FILE, 'utf8')
  for (const api of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'createWriteStream']) {
    ok(!src.includes(`${api}(`), `ledger-read.cjs 里出现了写能力 ${api}() —— 读取层必须零写`)
  }
  const fsCalls = [...src.matchAll(/\bio\.(\w+)\(/g)].map((m) => m[1])
  eqJson([...new Set(fsCalls)], ['readFileSync'], `注入的 fs 只许被调用 readFileSync（实得 ${[...new Set(fsCalls)].join(',')}）`)

  EVID.samples.readOnly = { statuses: reads.map((r) => r.status), snapshotItems: before.length, files: before.filter((x) => x.kind === 'file').length }
}

/* ══════════════════════════════════════════════════════════════════════
 * A07 · 临时把「目录/权限读取失败」折成空态（empty）后，判据必须失败
 * ══════════════════════════════════════════════════════════════════════ */
async function A07() {
  const { reader } = mods()
  const realSrc = fs.readFileSync(READER_FILE, 'utf8')
  eq(realSrc.split(MUTATION_TOKEN).length, 2, `变异落点在源码里必须恰好出现一次（${MUTATION_TOKEN}）`)

  // ① 干净副本：同一份判据必须通过（证明失败来自变异，不是来自判据壳）
  const control = tempDir('mut-control')
  fs.copyFileSync(ERRORS_FILE, path.join(control, 'errors.cjs'))
  fs.copyFileSync(READER_FILE, path.join(control, 'ledger-read.cjs'))
  const controlRun = runReaderCheck(control)
  eq(controlRun.code, 0, `干净副本必须通过契约（实得 exit ${controlRun.code}：${controlRun.stdout.trim()}）`)
  eq(controlRun.stdout.trim(), 'READER-CONTRACT OK', '干净副本的判词行不对')

  // ② 变异副本：io-error → empty（"目录/权限读取失败折成空态"）
  const mutant = tempDir('mut-mutant')
  fs.copyFileSync(ERRORS_FILE, path.join(mutant, 'errors.cjs'))
  const mutatedSrc = realSrc.replace(MUTATION_TOKEN, MUTATION_REPLACEMENT)
  ok(mutatedSrc !== realSrc, '变异没生效（源码没被改动）')
  ok(!mutatedSrc.includes(MUTATION_TOKEN), '变异后原 tokens 还在（替换没落到位）')
  fs.writeFileSync(path.join(mutant, 'ledger-read.cjs'), mutatedSrc, 'utf8')
  eq(sha256(Buffer.from(mutatedSrc, 'utf8')) === sha256(Buffer.from(realSrc, 'utf8')), false, '变异副本必须与权威源码字节不同')

  // 变异真的把状态改了（不然后面"判据红"就无意义）
  const mutantMod = requireCJS(path.join(mutant, 'ledger-read.cjs'))
  const mutantDir = mutantMod.readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ error: ioError('EISDIR') }).fs })
  eq(mutantDir.status, 'empty', `变异必须真的把 io-error 折成 empty（实得 ${mutantDir.status}）`)
  eq(mutantMod.IO_ERROR_STATUS, 'empty', '变异后的常量必须是 empty')
  // 同一输入在权威源码上仍是 io-error（两边的差别只来自这一处变异）
  const realDir = reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs({ error: ioError('EISDIR') }).fs })
  eq(realDir.status, 'io-error', '权威源码上同一输入必须仍是 io-error')
  eq(reader.IO_ERROR_STATUS, 'io-error', '权威常量必须是 io-error')

  // ③ 变异副本上跑同一份契约判据 → 必须失败（exit 非 0，且点名 io-error）
  const mutantRun = runReaderCheck(mutant)
  ok(mutantRun.code !== 0, `变异副本竟然通过了（exit ${mutantRun.code}）—— A07 的判据无效`)
  eq(mutantRun.code, 1, `变异副本应当以 exit 1 拒绝（实得 ${mutantRun.code}）`)
  ok(/^READER-CONTRACT FAIL /.test(mutantRun.stdout.trim()), `变异副本的判词不是 FAIL：${mutantRun.stdout.trim()}`)
  ok(/io-error/.test(mutantRun.stdout), `失败必须点名 io-error（实得 ${mutantRun.stdout.trim()}）`)

  EVID.mutation = {
    token: MUTATION_TOKEN,
    replacement: MUTATION_REPLACEMENT,
    controlExit: controlRun.code,
    controlVerdict: controlRun.stdout.trim().split('\n')[0],
    mutantExit: mutantRun.code,
    mutantVerdict: mutantRun.stdout.trim().split('\n')[0],
    mutantStatusForEisdir: mutantDir.status,
    realStatusForEisdir: realDir.status,
  }

  // ④ 清干净（父目录归属核对由 safeRemoveTree 做）
  dropTempDir('mut-control')
  dropTempDir('mut-mutant')
  ok(!fs.existsSync(control) && !fs.existsSync(mutant), '变异副本必须清掉')
}

/** 用指定目录里的模块跑一次契约判据（子进程，避免和本进程的 require 缓存混） */
function runReaderCheck(dir) {
  const r = spawnSync(process.execPath, [SELF, `--reader-check=${dir}`], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  })
  if (r.error) throw new Error(`子进程跑不起来：${r.error.message}`)
  return { code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/** 用指定副本跑一次"码表归属"判据（子进程；A04 的反空转拿它的原始 exit/判词） */
function runCodeOwnershipCheck(dir) {
  const r = spawnSync(process.execPath, [SELF, `--code-ownership-check=${dir}`], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  })
  if (r.error) throw new Error(`子进程跑不起来：${r.error.message}`)
  return { code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 · 确定性 IO 注入 + 证据 + 清理守卫有效
 * ══════════════════════════════════════════════════════════════════════ */
async function A08() {
  const { errors, reader } = mods()
  if (!EV) throw new Blocked(`证据根解析失败：${ROOTS.error}`)
  fs.mkdirSync(EV, { recursive: true })

  // ① 确定性注入：同样输入两次 → 逐字节同结果（没有时钟/随机/环境混进来）
  for (const [label, spec] of [
    ['ok', { text: '{"id":"a"}\n' }],
    ['invalid', { text: '{"id":"a"}\n{bad\n' }],
    ['missing', { error: ioError('ENOENT') }],
    ['io-error', { error: ioError('EPERM') }],
  ]) {
    const a = reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs(spec).fs })
    const b = reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: makeFakeFs(spec).fs })
    eqJson(a, b, `[${label}] 同样的注入必须产出逐字节相同的结果`)
  }
  // 假 fs 的调用轨迹也必须确定
  const p1 = makeFakeFs({ text: '' }); reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: p1.fs })
  const p2 = makeFakeFs({ text: '' }); reader.readLedger(FAKE_FILE, { format: 'jsonl', fs: p2.fs })
  eqJson(p1.calls, p2.calls, '确定性注入的调用轨迹必须相同')

  // ② 模块纯度：只用内置，errors.cjs 零依赖零时钟
  const errSrc = fs.readFileSync(ERRORS_FILE, 'utf8')
  const readSrc = fs.readFileSync(READER_FILE, 'utf8')
  const errCode = stripComments(errSrc)
  const readCode = stripComments(readSrc)
  ok(!/require\s*\(/.test(errCode), 'errors.cjs 必须零 require（纯，无 IO）')
  ok(!/\bprocess\s*\.|\bDate\s*\.|Math\s*\.\s*random|setTimeout|setInterval/.test(errCode),
    'errors.cjs 不许有时钟/环境/随机依赖')
  const requires = [...readCode.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
  const allowed = ['node:path', 'node:fs', './errors.cjs']
  eq(requires.filter((r) => !allowed.includes(r)).length, 0, `ledger-read.cjs 只许依赖内置与同目录模块（实得 ${requires.join(',')}）`)
  ok(requires.includes('./errors.cjs'), 'ledger-read.cjs 必须复用 errors.cjs 的工厂（不造第二份）')
  ok(!/\bprocess\s*\.env|\bDate\s*\.\s*now|Math\s*\.\s*random/.test(readCode), 'ledger-read.cjs 不许读环境/时钟/随机')

  // ③ 临时目录：唯一、绝对、都在声明的根下；清理守卫真的拦得住危险目标
  ok(path.isAbsolute(TEMP_ROOT) && TEMP_ROOT === 'E:\\Temp\\u03-s1-blane', `临时根必须是绝对的 E:\\Temp 子目录（${TEMP_ROOT}）`)
  ok(path.isAbsolute(RUN_TMP), '本次运行临时目录必须是绝对路径')
  eq(path.dirname(RUN_TMP), TEMP_ROOT, '本次运行临时目录必须直接挂在临时根下')
  eq(path.basename(RUN_TMP), `U03-${process.pid}`, '临时目录名必须带 pid（同一根下每次唯一）')
  fs.mkdirSync(TEMP_ROOT, { recursive: true })
  for (const [target, why] of [
    [TEMP_ROOT, '临时根自身'],
    ['E:\\Temp', 'E:\\Temp 本身'],
    ['E:\\workplace', '工作区父目录'],
    ['C:\\', '系统盘根'],
    [path.join(TEMP_ROOT, '..', 'u03-other'), '不在声明父目录下'],
  ]) {
    const g = guardTempPath(target, { parent: TEMP_ROOT })
    ok(g.ok === false, `清理守卫放行了危险目标：${why}（${target}）`)
  }
  ok(guardTempPath(RUN_TMP, { parent: TEMP_ROOT }).ok === true, '清理守卫拒绝了合法目标（恒拒绝同样是坏守卫）')

  // ④ A07 的副本必须清干净（本次运行目录下不许再有 mut-* 残渣）
  ok(fs.existsSync(RUN_TMP), '本次运行临时目录必须存在过（夹具真的落在 E:\\Temp 下）')
  const siblings = fs.readdirSync(TEMP_ROOT).filter((n) => n.startsWith(`U03-${process.pid}`))
  ok(siblings.includes(path.basename(RUN_TMP)), '本次运行临时目录必须在临时根下（绝对路径核对）')
  const mutLeft = siblings.filter((n) => n.includes('-mut'))
  eq(mutLeft.length, 0, `变异副本没清干净：${mutLeft.join(',')}`)
  const leftovers = fs.existsSync(RUN_TMP) ? fs.readdirSync(RUN_TMP).filter((n) => n.startsWith('mut-')) : ['<RUN_TMP 不存在>']
  eq(leftovers.length, 0, `变异副本没清干净：${leftovers.join(',')}`)

  // ⑦ 进程内 fs 写守卫：本进程每一次写都落在「本卡写集 / 本卡证据根 / 本卡临时根」里。
  //    **不**拿"工作树干净/整棵树只有我在写"当判据 —— 共享工作树里别的 lane 正在写自己的写集。
  const allowedFiles = WRITE_SET.map((rel) => path.resolve(REPO, rel))
  const allowedRoots = [path.resolve(CARD_EV), path.resolve(TEMP_ROOT)]
  if (EV) allowedRoots.push(path.resolve(EV))
  const isAllowedWrite = (p) => {
    const abs = path.resolve(p)
    if (allowedFiles.includes(abs)) return true
    return allowedRoots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`))
  }
  const outOfScopeWrites = WRITE_GUARD.writes.filter((w) => !isAllowedWrite(w.path))
  eq(outOfScopeWrites.length, 0,
    '本进程写到了允许范围之外（只许本卡写集 / audit-evidence/U03 / --evidence-root / E:\\Temp 本卡临时根）：'
    + outOfScopeWrites.slice(0, 5).map((w) => `${w.fn} ${w.path}`).join(' | '))
  ok(WRITE_GUARD.writes.length >= 5,
    `写守卫一次写都没记到（实得 ${WRITE_GUARD.writes.length} 次）—— 守卫本身可能失效，那就不是"零越界"`)
  // 守卫自身也不能空转：本卡写集要放行、别人写集与仓内无关文件要拦下
  ok(isAllowedWrite(path.join(REPO, 'lib', 'unify', 'errors.cjs')), '写守卫把本卡写集里的文件判成越界（恒拒绝同样是坏守卫）')
  ok(!isAllowedWrite(path.join(REPO, 'lib', 'render.js')), '写守卫放行了不属于本卡写集的仓内文件（恒放行就是空转）')
  ok(!isAllowedWrite(path.join('E:\\Temp', 'u03-someone-else')), '写守卫放行了本卡临时根之外的 E:\\Temp 目录（越界守卫空转）')
  EVID.temp.writeGuard = {
    patched: WRITE_GUARD.patched,
    total: WRITE_GUARD.writes.length,
    writes: WRITE_GUARD.writes.slice(0, 80),
    allowedRoots,
    outside: outOfScopeWrites.length,
    note: '覆盖到 A08 ④ 为止的全部 fs 写；⑤ 的证据落盘与尾部 writeRunEvidence 走同一个 EV 根（已校验属于允许范围）。',
  }

  // ⑤ 证据：模块锁 + 采样 + 变异记录 + 守卫记录（都是这次真跑出来的）
  ok(EVID.samples.fiveStates && EVID.samples.fiveStates.length === 5, '证据缺五态采样（A01 没跑完？）')
  eqJson(EVID.samples.statuses, ['missing', 'empty', 'ok', 'invalid', 'io-error'], '证据里的五态顺序不对')
  ok(EVID.mutation && EVID.mutation.controlExit === 0 && EVID.mutation.mutantExit === 1, '证据缺变异结果（A07 没跑完？）')
  ok(EVID.junk.length >= 10, '证据缺坏输入清单（A02 没跑完？）')

  EVID.moduleLocks = [ERRORS_FILE, READER_FILE, SELF].map((abs) => {
    const buf = fs.readFileSync(abs)
    return { path: path.relative(REPO, abs).replace(/\\/g, '/'), bytes: buf.length, sha256: sha256(buf) }
  })
  const head = gitHead()

  const evidenceFiles = {
    'module-locks.json': { card: CARD, head, files: EVID.moduleLocks },
    'reader-samples.json': {
      card: CARD, head,
      statuses: EVID.samples.statuses,
      fiveStates: EVID.samples.fiveStates,
      mixed: EVID.samples.mixed ?? null,
      formats: EVID.samples.formats ?? null,
      codes: EVID.samples.codes ?? null,
      readOnly: EVID.samples.readOnly ?? null,
      junk: EVID.junk,
    },
    'mutation.json': { card: CARD, head, ...EVID.mutation },
    'temp-guard.json': {
      card: CARD, head,
      tempRoot: TEMP_ROOT, runTmp: RUN_TMP,
      guardRejections: 5, guardAccepted: true,
      siblings, leftovers,
      writeGuard: EVID.temp.writeGuard ?? null,
    },
  }
  const written = []
  for (const [name, doc] of Object.entries(evidenceFiles)) {
    const abs = path.join(EV, name)
    fs.writeFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    const buf = fs.readFileSync(abs)
    ok(buf.length > 0, `证据 ${name} 写出来是空的`)
    const back = JSON.parse(buf.toString('utf8'))
    eq(back.card, CARD, `证据 ${name} 回读不对`)
    written.push({ file: name, bytes: buf.length, sha256: sha256(buf) })
  }
  ok(fs.existsSync(CARD_EV), '本卡证据目录必须显式存在')
  EVID.temp.written = written

  // ⑥ 清理本次运行目录（**核对绝对路径与归属后**再删），并确认真的没了
  const cleanup = safeRemoveTree(RUN_TMP, { parent: TEMP_ROOT })
  eq(cleanup.removed, true, `本次临时目录清理必须成功：${cleanup.error}`)
  ok(!fs.existsSync(RUN_TMP), '清理后临时目录必须消失')
  eq(fs.readdirSync(TEMP_ROOT).filter((n) => n.startsWith(`U03-${process.pid}`)).length, 0,
    '清理后临时根下不许再有本次运行的目录')
  ok(Array.isArray(EVID.temp.written) && EVID.temp.written.length === 4, '证据索引必须记下四份文件')
}

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
  if (r.error) throw new Blocked(`git 跑不起来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`git rev-parse 退出码 ${r.status}`)
  return String(r.stdout ?? '').trim()
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
  // 兜底清理（A08 已经清过一次；这里是"任何一例提前炸了也别留残渣"）
  if (fs.existsSync(RUN_TMP)) {
    const g = guardTempPath(RUN_TMP, { parent: TEMP_ROOT })
    if (g.ok) safeRemoveTree(RUN_TMP, { parent: TEMP_ROOT })
  }
}
if (!verdict) {
  // runner 自己炸了（没产出判词）—— 不许静默 exit 0
  process.stdout.write(`BLOCKED ${CARD} runner 未产出判词\n`)
  process.exitCode = 2
} else {
  if (EV) writeRunEvidence(verdict, EV)
  process.exitCode = printVerdict(verdict)
}
