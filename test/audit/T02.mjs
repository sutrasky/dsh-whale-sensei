#!/usr/bin/env node
/**
 * T02.mjs —— 统一测试包根、移除私人活包依赖（报告 F02 / P1）
 * ==================================================================
 * 验收判据（**原文**，见 cards/T02.md）：
 *   ① env=A、参数=B 时**所有子进程只报 B**；
 *   ② **无 study / 无兄弟风格仓**也能跑单测；
 *   ③ **CDP 收到指向 NOTES 页的合法 URL**。
 *   —— 「具体浏览器错误本次未测，不宣称必然某条异常」。
 *
 * 怎么做才算「不是嘴上说」：
 *   - 每条判据都**真起子进程**跑真实入口（`test/run-all.mjs` / `test/all.mjs` /
 *     `test/integration.mjs` / `lib/cdp.js`），看它们的输出与退出码，而不是在本地重算一遍。
 *   - 每个用例的**完整 stdout/stderr/退出码**都落到 `audit-evidence/T02/`。
 *   - 固定用例 ID 集合写在下面 `EXPECTED_IDS` 里：缺一条、多一条、重一条都算失败。
 *   - **不许把红改绿**：真包那 6 套红（challenge-gate / pack-model / brief / practice /
 *     parity-registry / pack-scaffold）本卡**不要求变绿**，只要求**如实报告** ——
 *     所以下面的用例断言的是"这 6 套仍在红名单里且与基线同名"，不是"它们绿了"。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T02.mjs
 *      （真包路径可用 `--real-pack=<绝对路径>` 或 `DSH_WHALE_REAL_PACK` 覆盖）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 输入定源：参数优先于 env / 显式无效直接失败 / 只由顶层解析一次
  'T02-RESOLVE-env-only',
  'T02-RESOLVE-param-over-env',
  'T02-RESOLVE-param-invalid-hard-fail',
  'T02-RESOLVE-env-invalid-hard-fail',
  'T02-RESOLVE-none',
  'T02-RESOLVE-mode-flag',
  'T02-RESOLVE-bad-mode-rejected',
  'T02-RESOLVE-real-without-pack-rejected',
  'T02-RESOLVE-positional-compat',
  'T02-SRC-no-sibling-fallback',
  'T02-SRC-context-args-wired',
  // ② env=A、参数=B → 所有子进程只报 B
  'T02-CTX-all-children-report-B',
  'T02-CTX-runall-ctx-recorded',
  'T02-CTX-context-line-present',
  'T02-CTX-drift-detected',
  'T02-CTX-args-and-env-agree',
  // ③ 无 study / 无兄弟风格仓也能跑单测
  'T02-FIXTURE-create-variants',
  'T02-FIXTURE-gate-selfcheck',
  'T02-FIXTURE-structure-declared',
  'T02-FIXTURE-no-live-pack-read',
  'T02-FIXTURE-no-sibling-style-read',
  'T02-NOSTUDY-sandbox-run',
  'T02-NOSTUDY-sibling-style-absent',
  // ④ 真实包：opt-in 集成 + 原有 6 套红如实报告
  'T02-REAL-integration-entry',
  'T02-REAL-red-reported',
  'T02-REAL-via-all-explicit',
  'T02-REAL-copy-only-side-effects',
  // ⑤ CDP：指向 NOTES 页的合法 URL
  'T02-CDP-notes-url-helper',
  'T02-CDP-page-arg-is-url',
  'T02-CDP-rejects-directory-arg',
  'T02-CDP-selftest-reaches-browser',
  // ⑥ 回归：T01 入口与旧用法不被打破
  'T02-REG-t01-still-passes',
  'T02-REG-selftest-still-passes',
  'T02-REG-legacy-env-invocation',
]

/** 基线就有的 6 套红（F02 只要求**如实报告**，不要求变绿） */
const BASELINE_RED = ['challenge-gate', 'pack-model', 'brief', 'practice', 'parity-registry', 'pack-scaffold']

const NODE = process.execPath
const CASE_DIR = path.join(REPO, 'audit-evidence', 'T02', 'cases')

/** 真包路径：`--real-pack=` / `DSH_WHALE_REAL_PACK` / 本机约定位置 */
function resolveRealPack() {
  const eq = '--real-pack='
  const arg = process.argv.slice(2).find((a) => a.startsWith(eq))
  const cand = [
    arg ? arg.slice(eq.length) : null,
    process.env.DSH_WHALE_REAL_PACK,
    process.env.DSH_WHALE_PACK,
    'E:\\workplace\\study',
  ].filter(Boolean)
  for (const c of cand) {
    const abs = path.resolve(String(c))
    if (fs.existsSync(path.join(abs, 'presets', 'whale-sensei.css'))) return abs
  }
  return null
}
const REAL_PACK = resolveRealPack()

const h = createHarness({ card: 'T02', expectedIds: EXPECTED_IDS, root: REPO })

// ---------------------------------------------------------------- 证据小工具
/** 落一份子进程的**完整原始输出**（超长只留头尾，语义不裁） */
function keepEvidence(id, r, extra = {}) {
  const text = [
    `# ${id}`,
    `exit=${r.code === null ? 'null(无退出码/崩溃)' : r.code} timedOut=${r.timedOut} ms=${r.ms}`,
    `spawnError=${r.spawnError ?? 'none'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    '--- stdout ---',
    String(r.out ?? ''),
    '--- stderr ---',
    String(r.err ?? ''),
    '',
  ].join('\n')
  h.evidence(path.join('cases', `${id}.txt`), clip(text, 30000))
}

/** 从输出里抽 `[test-context]` 行（取最后一条：顶层与子进程都会打） */
function ctxLines(out) {
  return [...String(out ?? '').matchAll(/^\[test-context\] mode=(\S+) pack=(\S+)$/gm)]
    .map((m) => ({ mode: m[1], packRoot: m[2] }))
}

/** stdout + stderr 拼起来（判"某句话出现过没有"时用；两条流都要算） */
const both = (r) => String(r?.out ?? '') + String(r?.err ?? '')

/** 造两个**可区分**的夹具（A / B）——用 variant 不同 + 根目录名不同来区分 */
function twoPacks() {
  // tag 用**裸名**：`cleanupTempDir` 认 `dsh-whale-<tag>-*`（全名会被拼成 dsh-whale-dsh-whale-…）
  const a = makeTempDir('dsh-whale-T02-packA')
  const b = makeTempDir('dsh-whale-T02-packB')
  return { a, b }
}

/** 在一个空目录里铺一个**最小可判包**（只给 `presets/whale-sensei.css` 这个判据件） */
function seedPack(dir) {
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'presets', 'whale-sensei.css'), '/* T02 A/B 判别夹具 */\n', 'utf8')
  return dir
}

const RUN_ALL = path.join(TEST_DIR, 'run-all.mjs')
const ALL = path.join(TEST_DIR, 'all.mjs')

/** 本次审计自己建过的临时目录（跑完逐条核实再删 —— 清理前必须确认属于本次） */
const OWN_TEMP = []

/** 跑 `test/run-all.mjs`（可点名只跑几套），返回原始结果 */
function runRunAll(tag, { pack, env = {}, suites = 'pack-parity,bom-tolerance', timeoutMs = 180000 } = {}) {
  const resultDir = makeTempDir(`dsh-whale-T02-result-${tag}`)
  OWN_TEMP.push({ dir: resultDir, tag: `T02-result-${tag}` })
  const resultFile = path.join(resultDir, 'result.json')
  const r = runChild([NODE, RUN_ALL, ...(pack ? [`--pack=${pack}`] : []), '--mode=real'], {
    cwd: REPO,
    env: { ...env, DSH_WHALE_RESULT: resultFile, ...(suites ? { DSH_WHALE_SUITES: suites } : {}) },
    timeoutMs,
  })
  let record = null
  try { record = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { record = null }
  return { ...r, resultFile, record }
}

// ---------------------------------------------------------------- ① 输入定源
// 全部直接 import `test/_pack.mjs`（纯函数，不起子进程）—— 这些是**唯一算法**的原子断言。
let P = null
try {
  P = await import(pathToFileURL(path.join(TEST_DIR, '_pack.mjs')).href)
} catch (e) {
  h.block(`读不到 test/_pack.mjs：${e && e.message ? e.message : String(e)}`)
}
const resolve = (spec) => {
  if (!P) throw new Error('_pack.mjs 没加载（材料缺失）')
  return P.resolveTestContext(spec)
}
/** 探针：跑一次、落证据、再判 —— 证据不落就等于没跑过 */
function probe(id, fn) {
  let out, err = null
  try { out = { ok: true, value: fn() } } catch (e) { err = String(e.message || e); out = { ok: false, error: err } }
  h.evidence(path.join('cases', `${id}.txt`),
    `# ${id}\nresult=${JSON.stringify(out)}\n`)
  if (err) throw new Error(err)
  return out.value
}

// 这两个目录只是"看着像包"的判别夹具（A/B 各一个，互不相同）
const ab = twoPacks()
const PACK_A = seedPack(ab.a)
const PACK_B = seedPack(ab.b)

h.case('T02-RESOLVE-env-only', 'pass', () => {
  const c = probe('T02-RESOLVE-env-only', () => resolve({ argv: [], env: { DSH_WHALE_PACK: PACK_A } }))
  h.eq(c.packRoot, PACK_A, '只给 env 时包根就是 env 那个')
  h.eq(c.source.pack, 'env:DSH_WHALE_PACK', '来源要标明是 env（可追溯）')
})

h.case('T02-RESOLVE-param-over-env', 'pass', () => {
  const c = probe('T02-RESOLVE-param-over-env', () => resolve({ argv: [`--pack=${PACK_B}`], env: { DSH_WHALE_PACK: PACK_A } }))
  h.eq(c.packRoot, PACK_B, 'env=A、参数=B 时解析结果必须是 B（参数优先）')
  h.eq(c.source.pack, 'argv:--pack', '来源要标明是 argv')
})

h.case('T02-RESOLVE-param-invalid-hard-fail', 'pass', () => {
  const bogus = path.join(os.tmpdir(), 'dsh-whale-T02-not-a-pack')
  const r = probe('T02-RESOLVE-param-invalid-hard-fail', () => {
    try {
      resolve({ argv: [`--pack=${bogus}`], env: { DSH_WHALE_PACK: PACK_A } })
      return { threw: false }
    } catch (e) { return { threw: true, message: String(e.message).split('\n')[0] } }
  })
  h.eq(r.threw, true, '显式无效路径必须**直接失败**（不许静默兜底到 env 的 A）')
  h.assert(/无效/.test(r.message), `错误要说清是"无效"：${r.message}`)
})

h.case('T02-RESOLVE-env-invalid-hard-fail', 'pass', () => {
  const bogus = path.join(os.tmpdir(), 'dsh-whale-T02-not-a-pack-2')
  const r = probe('T02-RESOLVE-env-invalid-hard-fail', () => {
    try {
      resolve({ argv: [], env: { DSH_WHALE_PACK: bogus } })
      return { threw: false }
    } catch (e) { return { threw: true, message: String(e.message).split('\n')[0] } }
  })
  h.eq(r.threw, true, 'env 指向无效路径也要硬失败（不静默回落）')
})

h.case('T02-RESOLVE-none', 'pass', () => {
  const c = probe('T02-RESOLVE-none', () => resolve({ argv: [], env: {} }))
  h.eq(c.packRoot, null, '什么都没给时 packRoot 是 null（顶层据此决定造夹具）')
  h.eq(c.mode, 'fixture', '什么都没给时默认是 fixture 模式（单测自包含）')
})

h.case('T02-RESOLVE-mode-flag', 'pass', () => {
  const c = probe('T02-RESOLVE-mode-flag', () => resolve({ argv: [`--pack=${PACK_A}`, '--mode=real'], env: {} }))
  h.eq(c.mode, 'real', '--mode=real 生效')
  h.eq(c.source.mode, 'argv:--mode', '模式来源要标明是 argv')
})

h.case('T02-RESOLVE-bad-mode-rejected', 'pass', () => {
  const r = probe('T02-RESOLVE-bad-mode-rejected', () => {
    try { resolve({ argv: ['--mode=随便写的'], env: {} }); return { threw: false } }
    catch (e) { return { threw: true, message: String(e.message).split('\n')[0] } }
  })
  h.eq(r.threw, true, '模式取值域外的值必须拒绝（不许悄悄多一个模式）')
})

h.case('T02-RESOLVE-real-without-pack-rejected', 'pass', () => {
  const r = probe('T02-RESOLVE-real-without-pack-rejected', () => {
    try { resolve({ argv: ['--mode=real'], env: {} }); return { threw: false } }
    catch (e) { return { threw: true, message: String(e.message).split('\n')[0] } }
  })
  h.eq(r.threw, true, 'real 模式没有包根必须拒绝（不能猜一个）')
})

h.case('T02-RESOLVE-positional-compat', 'pass', () => {
  const c = probe('T02-RESOLVE-positional-compat', () => resolve({ argv: [PACK_A], env: {} }))
  h.eq(c.packRoot, PACK_A, '位置参数（旧用法 `node test/all.mjs <pack>`）仍认')
  h.eq(c.source.pack, 'argv:positional', '来源标明是位置参数')
})

h.case('T02-SRC-no-sibling-fallback', 'pass', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, '_pack.mjs'), 'utf8')
  // 结构性证据：**旧的第三兜底**（`path.join(PLUGIN, '..', 'study')`）必须已经不在。
  // 只在**非注释行**里找（文档注释里会把它当"已删掉的那条"引用，那是说明不是兜底）；
  // 也只在"真的去解析那个路径"的写法里找（`FORBIDDEN_FALLBACKS` 那个反面清单不算）。
  const codeLines = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  const fallbackRe = /path\.join\(\s*PLUGIN\s*,\s*'\.\.'\s*,\s*'study'\s*\)/
  const hits = codeLines.filter((l) => fallbackRe.test(l)).map((l) => l.trim())
  h.evidence(path.join('cases', 'T02-SRC-no-sibling-fallback.txt'),
    `test/_pack.mjs 非注释行里还有旧的兄弟仓兜底 path.join(PLUGIN,'..','study')？ ${hits.length > 0}\n`
    + `命中的代码行：${hits.length ? '\n  ' + hits.join('\n  ') : '（无）'}\n`)
  h.eq(hits.length, 0, `\`test/_pack.mjs\` 里不许再有 \`path.join(PLUGIN, "..", "study")\` 这条兜底（实得 ${hits.join(' / ') || '无'}）`)
  h.assert(/resolveTestContext/.test(src), '定源函数 resolveTestContext 必须就在 _pack.mjs 里（只此一份）')
  h.assert(/contextArgs/.test(src), '传给子进程的参数构造器 contextArgs 必须在（顶层靠它显式传）')
})

h.case('T02-SRC-context-args-wired', 'pass', () => {
  const allSrc = fs.readFileSync(ALL, 'utf8')
  const runAllSrc = fs.readFileSync(RUN_ALL, 'utf8')
  h.evidence(path.join('cases', 'T02-SRC-context-args-wired.txt'),
    `all.mjs 用 contextArgs？ ${/contextArgs\(/.test(allSrc)}\n`
    + `all.mjs 把 ARGS 传给子进程？ ${/runNode\([^)]*ARGS/.test(allSrc)}\n`
    + `run-all.mjs 用 contextArgs？ ${/contextArgs\(/.test(runAllSrc)}\n`
    + `run-all.mjs 把 CHILD_ARGS 传给子进程？ ${/\.\.\.CHILD_ARGS/.test(runAllSrc)}\n`)
  h.assert(/contextArgs\(/.test(allSrc), '`test/all.mjs` 必须用 contextArgs 构造子进程参数')
  h.assert(/runNode\([^)]*ARGS/.test(allSrc), '`test/all.mjs` 必须把 ARGS 真的传给子进程')
  h.assert(/contextArgs\(/.test(runAllSrc), '`test/run-all.mjs` 必须用 contextArgs 构造子进程参数')
  h.assert(/\.\.\.CHILD_ARGS/.test(runAllSrc), '`test/run-all.mjs` 必须把 CHILD_ARGS 真的传给每个套件')
})

// ---------------------------------------------------------------- ② env=A、参数=B → 所有子进程只报 B
// 这里用**两个夹具包**当 A / B：env 指向 A、参数给 B。
// 每个子套件都会在 stderr 打一行 `[test-context] mode=… pack=…`（`_pack.mjs` 自动上报），
// run-all 再把每条用例自报的 ctx 记进机器结果 —— 判据就落在"有没有一条报 A"。
const AB_SUITES = 'pack-parity,bom-tolerance,catalog,probe-audit,pack-model'

h.case('T02-CTX-all-children-report-B', 'pass', () => {
  const f = runRunAll('ab', { pack: PACK_B, env: { DSH_WHALE_PACK: PACK_A }, suites: AB_SUITES })
  keepEvidence('T02-CTX-all-children-report-B', f, {
    PACK_A, PACK_B, suites: AB_SUITES, record: JSON.stringify(f.record && { p: f.record.passed, f: f.record.failed }),
  })
  h.assert(f.record != null, 'run-all 必须落机器结果（读不到就是红）')
  const cases = f.record.cases.filter((c) => !String(c.id).startsWith('exit:'))
  const reported = cases.filter((c) => /^ctx=/.test(String(c.ctx ?? '')))
  const toA = cases.filter((c) => String(c.ctx ?? '').includes(PACK_A))
  const toB = cases.filter((c) => String(c.ctx ?? '').includes(PACK_B))
  h.assert(cases.length >= 5, `点名的 ${AB_SUITES.split(',').length} 套都要有用例记录（实得 ${cases.length}）`)
  h.eq(reported.length, cases.length, '每一套都要自报测试上下文（没报的会被 run-all 记成 ctxDrift）')
  h.eq(toA.length, 0, `**不许有任何子进程报 A**（实得 ${toA.length} 条：${toA.map((c) => c.id).join('、')}）`)
  h.eq(toB.length, cases.length, `所有子进程都要报 B（实得 ${toB.length}/${cases.length}）`)
  h.eq(f.record.packRoot, PACK_B, '机器结果里的 packRoot 也要是 B')
})

h.case('T02-CTX-runall-ctx-recorded', 'pass', () => {
  const f = runRunAll('ctxrec', { pack: PACK_B, env: { DSH_WHALE_PACK: PACK_A }, suites: 'pack-parity,bom-tolerance' })
  keepEvidence('T02-CTX-runall-ctx-recorded', f, { record: JSON.stringify(f.record) })
  const lines = ctxLines(both(f))
  h.assert(lines.length > 0, 'run-all 的输出里必须有 [test-context] 行')
  const last = lines[lines.length - 1]
  h.eq(last.packRoot, PACK_B, 'run-all 自报的包根必须是 B')
  h.eq(last.mode, 'real', 'run-all 自报的模式必须是 real')
  h.assert(!both(f).includes(`pack=${PACK_A}`), '整段输出里不许出现 `pack=A`（那说明参数没传到）')
})

h.case('T02-CTX-context-line-present', 'pass', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, '_pack.mjs'), 'utf8')
  h.evidence(path.join('cases', 'T02-CTX-context-line-present.txt'),
    `_pack.mjs 里有 [test-context] 上报？ ${/\[test-context\]/.test(src)}\n`
    + `run-all.mjs 里有逐进程对账？ ${/ctxDrift/.test(fs.readFileSync(RUN_ALL, 'utf8'))}\n`)
  h.assert(/\[test-context\]/.test(src), '`_pack.mjs` 必须自动上报 `[test-context]`（否则判不了"传到没传到"）')
  h.assert(/ctxDrift/.test(fs.readFileSync(RUN_ALL, 'utf8')), '`run-all.mjs` 必须有逐进程对账（ctxDrift）')
})

h.case('T02-CTX-drift-detected', 'pass', () => {
  // 反空转：逐进程对账本身必须**抓得住**"子进程报了 A"这种漂移。
  // 直接喂 `_pack.mjs` 的解析器（纯函数）：它必须能从一段输出里认出 A，且认得出"没报"。
  const parse = P.parseTestContextLine
  const outWithA = `ok 一条\n=== 2 通过 / 0 失败 ===\n[test-context] mode=real pack=${PACK_A}\n`
  const outWithB = `ok 一条\n=== 2 通过 / 0 失败 ===\n[test-context] mode=real pack=${PACK_B}\n`
  const outSilent = `ok 一条\n=== 2 通过 / 0 失败 ===\n`
  const a = parse(outWithA)
  const b = parse(outWithB)
  const none = parse(outSilent)
  h.evidence(path.join('cases', 'T02-CTX-drift-detected.txt'),
    `parse(报 A) = ${JSON.stringify(a)}\nparse(报 B) = ${JSON.stringify(b)}\nparse(没报) = ${JSON.stringify(none)}\n`)
  h.eq(a && a.packRoot, PACK_A, '解析器要认得出"子进程报的是 A"（这样漂移才抓得住）')
  h.eq(b && b.packRoot, PACK_B, '解析器要认得出"子进程报的是 B"')
  h.eq(none, null, '"没报"必须解析成 null（run-all 据此记 ctxDrift，绝不当成通过）')
  h.assert(a.packRoot !== b.packRoot, 'A 与 B 必须可区分（否则这条判据是空的）')
})

h.case('T02-CTX-args-and-env-agree', 'pass', () => {
  // 顶层传给子进程的**两条腿**（argv 与 env）必须指向同一个绝对包根
  const ctx = { mode: 'real', packRoot: PACK_B }
  const args = P.contextArgs(ctx)
  const env = P.contextEnv(ctx)
  h.evidence(path.join('cases', 'T02-CTX-args-and-env-agree.txt'),
    `contextArgs=${JSON.stringify(args)}\ncontextEnv=${JSON.stringify(env)}\n`)
  h.assert(args.includes(`--pack=${PACK_B}`), `argv 里要带绝对包根（实得 ${args.join(' ')}）`)
  h.assert(args.includes('--mode=real'), 'argv 里要带模式')
  h.eq(env.DSH_WHALE_PACK, PACK_B, 'env 里也要带同一个包根（两条腿一致）')
  h.eq(env.DSH_WHALE_MODE, 'real', 'env 里也要带同一个模式')
  h.assert(path.isAbsolute(env.DSH_WHALE_PACK), 'env 里必须是**绝对**路径')
  // 没包根时不许瞎编一个
  const noPack = P.contextEnv({ mode: 'fixture', packRoot: null })
  h.eq(noPack.DSH_WHALE_PACK, '', 'fixture 且没包根时 env 要显式清空（不许留着上一个包的残留）')
})

// ---------------------------------------------------------------- ③ 无 study / 无兄弟风格仓也能跑单测
let F = null
try {
  F = await import(pathToFileURL(path.join(TEST_DIR, '_fixture.mjs')).href)
} catch (e) {
  h.block(`读不到 test/_fixture.mjs：${e && e.message ? e.message : String(e)}`)
}
const fixtures = []
/** 造一个夹具并登记，跑完统一 dispose（**清理前核实路径**由 _fixture 自己做） */
function fixture(variant) {
  if (!F) throw new Error('_fixture.mjs 没加载（材料缺失）')
  const fx = F.createFixture({ variant })
  fixtures.push(fx)
  return fx
}

h.case('T02-FIXTURE-create-variants', 'pass', () => {
  const seen = []
  for (const v of F.VARIANTS) {
    const fx = fixture(v)
    const hasMarker = fs.existsSync(path.join(fx.root, 'presets', 'whale-sensei.css'))
    const hasLessons = fs.existsSync(path.join(fx.root, 'lessons'))
    seen.push({ variant: v, root: fx.root, hasMarker, hasLessons })
    h.assert(hasMarker, `${v}：夹具必须带 presets/whale-sensei.css（判据件）`)
    h.assert(hasLessons, `${v}：夹具必须有 lessons/（readPack 的入口）`)
  }
  h.eq(seen.length, 4, '四个变体（empty / multi-domain / completed / incomplete）都要造得出来')
  h.evidence(path.join('cases', 'T02-FIXTURE-create-variants.txt'), JSON.stringify(seen, null, 2) + '\n')
  // 取值域外的变体必须**直接拒绝**（不许悄悄多一个）
  let threw = false
  try { F.createFixture({ variant: '偷偷加的' }) } catch { threw = true }
  h.eq(threw, true, '变体取值域外的值必须拒绝')
})

h.case('T02-FIXTURE-gate-selfcheck', 'pass', () => {
  const fx = fixture('multi-domain')
  const r = runChild([NODE, path.join(fx.root, 'tools', 'gate.mjs'), `--pack=${fx.root}`], { cwd: REPO, timeoutMs: 60000 })
  keepEvidence('T02-FIXTURE-gate-selfcheck', r, { root: fx.root })
  h.eq(r.code, 0, `夹具自带的闸门必须全绿（exit 0），实际 ${r.code}`)
  h.assert(/闸门：\d+ \/ \d+ 通过/.test(both(r)), '闸门要按 test/all.mjs 的摘要契约输出')
  h.assert(/全绿/.test(both(r)), '闸门摘要要带「全绿」')
})

h.case('T02-FIXTURE-structure-declared', 'pass', () => {
  // 每个固定计数都要能指回手写结构表（不许"改数字适配当前活包"）
  const S = F.FIXTURE_STRUCTURE
  const fx = fixture('multi-domain')
  const gateOut = runChild([NODE, path.join(fx.root, 'tools', 'gate.mjs'), `--pack=${fx.root}`], { cwd: REPO, timeoutMs: 60000 }).out
  h.evidence(path.join('cases', 'T02-FIXTURE-structure-declared.txt'),
    `FIXTURE_STRUCTURE=${JSON.stringify(S)}\n--- 夹具闸门实测 ---\n${gateOut}\n`)
  h.eq(S.circles, 2, '结构表声明圆圈 2 个')
  h.eq(S.points, 3, '结构表声明知识点 3 个')
  h.eq(S.lessons, 4, '结构表声明课程 4 门')
  h.eq(S.lessonIds.length, S.lessons, 'lessonIds 的条数必须与 lessons 一致（同一张表，不许两处各写一个数）')
  h.eq(S.styleSamples, Object.keys(F.STYLE_SAMPLES).length, '结构表声明的风格样本数必须与实际样本数一致')
  h.assert(new RegExp(`圆圈数 = ${S.circles}（实得 ${S.circles}）`).test(gateOut), '夹具实测的圆圈数要与结构表一致')
  h.assert(new RegExp(`课程数 = ${S.lessons}（实得 ${S.lessons}）`).test(gateOut), '夹具实测的课程数要与结构表一致')
})

h.case('T02-FIXTURE-no-live-pack-read', 'pass', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, '_fixture.mjs'), 'utf8')
  // 结构性证据：夹具只从**仓内模板**（lib/pack-template）合成，不读活包。
  // 只认"真的本机绝对路径"：`X:\` 或 `X:/`（**不认** `https://` 那种 URL scheme ——
  // 夹具里手写的 `https://example.invalid/...` 是出处声明，不是机器路径）。
  const readsTemplate = /pack-template/.test(src)
  const absLive = [...src.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s'"`)]*/g)].map((m) => m[0])
  h.evidence(path.join('cases', 'T02-FIXTURE-no-live-pack-read.txt'),
    `夹具读仓内模板（lib/pack-template）？ ${readsTemplate}\n`
    + `夹具源码里的本机绝对路径：${absLive.length ? absLive.join('、') : '（无）'}\n`)
  h.eq(readsTemplate, true, '夹具必须从**仓内模板**合成（lib/pack-template）')
  h.eq(absLive.length, 0, `夹具源码里不许有本机绝对路径（实得 ${absLive.join('、') || '无'}）`)
})

h.case('T02-FIXTURE-no-sibling-style-read', 'pass', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, 'circle-create.mjs'), 'utf8')
  const fixtureSrc = fs.readFileSync(path.join(TEST_DIR, '_fixture.mjs'), 'utf8')
  const readsSibling = /path\.join\(path\.dirname\(PACK\)\s*,\s*'dsh-raw-html-v2-master'/.test(src)
  h.evidence(path.join('cases', 'T02-FIXTURE-no-sibling-style-read.txt'),
    `circle-create.mjs 还去读包旁兄弟仓？ ${readsSibling}\n`
    + `circle-create.mjs 用 STYLE_SAMPLES 显式构造风格输入？ ${/STYLE_SAMPLES/.test(src)}\n`
    + `_fixture.mjs 导出 STYLE_SAMPLES？ ${/export const STYLE_SAMPLES/.test(fixtureSrc)}\n`)
  h.eq(readsSibling, false, '`test/circle-create.mjs` 不许再去读包旁的 `dsh-raw-html-v2-master/styles`')
  h.assert(/STYLE_SAMPLES/.test(src), '风格输入必须由测试**显式构造**（用 STYLE_SAMPLES）')
  h.assert(/export const STYLE_SAMPLES/.test(fixtureSrc), '`_fixture.mjs` 必须导出显式风格样本')
})

h.case('T02-NOSTUDY-sandbox-run', 'pass', () => {
  // 把 test/ + lib/ 拷进一个**没有任何兄弟仓**的沙箱，用默认（夹具）模式跑几套单测。
  // 这台"别人的机器"上没有 study、没有 dsh-raw-html-v2-master —— 跑得起来才算自包含。
  const sandbox = makeTempDir('dsh-whale-T02-nostudy')
  fs.cpSync(path.join(REPO, 'test'), path.join(sandbox, 'test'), {
    recursive: true,
    filter: (src) => !/[\\/](audit-evidence|node_modules|\.git)([\\/]|$)/.test(src),
  })
  fs.cpSync(path.join(REPO, 'lib'), path.join(sandbox, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 't02-nostudy', type: 'module' }, null, 2), 'utf8')
  const siblings = fs.readdirSync(sandbox).filter((n) => /study|dsh-raw-html-v2/i.test(n))
  // 走 `test/all.mjs`（**默认夹具模式**的入口）：它会现场造一个合成包，
  // 所以这个沙箱里既没有 study、也没有任何兄弟风格仓，单测照样跑得起来。
  const r = runChild([NODE, path.join(sandbox, 'test', 'all.mjs')], {
    cwd: sandbox,
    env: { DSH_WHALE_SUITES: 'pack-parity,bom-tolerance', DSH_WHALE_RESULT: path.join(sandbox, 'r.json') },
    timeoutMs: 300000,
  })
  keepEvidence('T02-NOSTUDY-sandbox-run', r, { sandbox, siblings: siblings.join('、') || '（无）' })
  h.eq(siblings.length, 0, '沙箱里不许有 study / 兄弟风格仓（否则这条判据是空的）')
  h.assert(ctxLines(both(r)).length > 0, `沙箱里的入口也要报 [test-context]（原始输出尾部：${clip(both(r), 400)}）`)
  h.assert(/mode=fixture/.test(both(r)), '沙箱里走的是夹具模式（自包含，不依赖活包）')
  h.assert(/闸门：5 \/ 5 通过/.test(both(r)), '沙箱里夹具自带的闸门必须真的跑绿（不是静默跳过）')
  // ⚠️ **不断言套件全绿**：合成夹具喂不饱那些"计数绑在活包内容上"的套件
  //    （它们会红，那是它们自己的内容耦合，不是"跑不起来"）。这里只要求**摘要真的出来了**。
  h.assert(/插件套件　：\d+ 套 · \d+ 条断言/.test(both(r)), '沙箱里必须真的跑出套件摘要（不是静默失败）')
  h.assert(/判词：/.test(both(r)), '沙箱里必须真的给出判词')
  cleanupTempDir(sandbox, 'dsh-whale-T02-nostudy')
})

h.case('T02-NOSTUDY-sibling-style-absent', 'pass', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, '_pack.mjs'), 'utf8')
  // 结构性证据：定源算法里**没有任何**"猜兄弟仓"的分支。
  // 只看**非注释行**（文档注释会引用那条已删的兜底，那是说明不是代码）；
  // 也排除 `FORBIDDEN_FALLBACKS`（那是**反面清单**，它列名字正是为了断言"不许回来"）。
  const siblingHints = src.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .filter((l) => !/FORBIDDEN_FALLBACKS/.test(l))
    .filter((l) => /study|dsh-raw-html-v2/i.test(l))
    .map((l) => l.trim())
  h.evidence(path.join('cases', 'T02-NOSTUDY-sibling-style-absent.txt'),
    `_pack.mjs 非注释、非反面清单行里提到 study/兄弟仓的：\n${siblingHints.length ? siblingHints.join('\n') : '（无）'}\n`)
  h.eq(siblingHints.length, 0, `定源算法里不许有猜兄弟仓的代码（实得 ${siblingHints.join(' / ') || '无'}）`)
})

// ---------------------------------------------------------------- ④ 真实包：opt-in 集成 + 6 套红如实报告
h.case('T02-REAL-integration-entry', 'pass', () => {
  if (!REAL_PACK) throw new Error('找不到真课程包（--real-pack= / DSH_WHALE_REAL_PACK）')
  const r = runChild([NODE, path.join(TEST_DIR, 'integration.mjs'), `--pack=${REAL_PACK}`, '--only=pack-parity'], {
    cwd: REPO, timeoutMs: 180000,
  })
  keepEvidence('T02-REAL-integration-entry', r, { REAL_PACK })
  h.assert(r.code === 0 || r.code === 1, `集成入口要正常收场（0 绿 / 1 红），实际 ${r.code}`)
  h.assert(/集成（真包 opt-in）/.test(both(r)), '要明说这是"真包 opt-in"那条路')
  h.assert(/mode=real/.test(both(r)), '集成必须显式钉成 real 模式')
  h.assert(both(r).includes(REAL_PACK), '要报出真包路径')
})

h.case('T02-REAL-red-reported', 'pass', () => {
  if (!REAL_PACK) throw new Error('找不到真课程包（--real-pack= / DSH_WHALE_REAL_PACK）')
  // 只跑基线那 6 套红：证明它们**仍在红名单里、与基线同名**（本卡不要求它们变绿）
  const r = runChild([NODE, ALL, `--pack=${REAL_PACK}`, '--mode=real'], {
    cwd: REPO,
    env: { DSH_WHALE_SUITES: BASELINE_RED.join(',') },
    timeoutMs: 900000,
  })
  keepEvidence('T02-REAL-red-reported', r, { REAL_PACK, baselineRed: BASELINE_RED.join(',') })
  const m = both(r).match(/套件失败项：(.+)/)
  const reported = m ? m[1].split('、').map((s) => s.trim()).filter(Boolean) : []
  h.assert(m != null, '真包跑完必须点名"套件失败项"（不许只说红不说哪套）')
  for (const name of BASELINE_RED) {
    h.assert(reported.includes(name), `基线红名单里的 ${name} 必须被如实报告（实得：${reported.join('、') || '无'}）`)
  }
  h.eq(r.code, 1, `有红套件时退出码必须是 1（实得 ${r.code}）`)
  h.eq(reported.length, BASELINE_RED.length, `红名单条数要与基线一致（实得 ${reported.length}：${reported.join('、')}）`)
})

h.case('T02-REAL-via-all-explicit', 'pass', () => {
  if (!REAL_PACK) throw new Error('找不到真课程包（--real-pack= / DSH_WHALE_REAL_PACK）')
  // env 给 A、参数给真包：证明 `test/all.mjs` 只报真包
  const r = runChild([NODE, ALL, `--pack=${REAL_PACK}`, '--mode=real'], {
    cwd: REPO,
    env: { DSH_WHALE_PACK: PACK_A, DSH_WHALE_SUITES: 'pack-parity' },
    timeoutMs: 300000,
  })
  keepEvidence('T02-REAL-via-all-explicit', r, { REAL_PACK, PACK_A })
  const lines = ctxLines(both(r))
  h.assert(lines.length > 0, 'all.mjs 要报 [test-context]')
  h.eq(lines[lines.length - 1].packRoot, REAL_PACK, 'env=A、参数=真包时，顶层自报必须是真包')
  h.assert(!both(r).includes(`pack=${PACK_A}`), '输出里不许出现 `pack=A`')
})

h.case('T02-REAL-copy-only-side-effects', 'pass', () => {
  if (!REAL_PACK) throw new Error('找不到真课程包（--real-pack= / DSH_WHALE_REAL_PACK）')
  // 真包在跑之前 / 之后**一字未动**（相对基线 git status 相同）
  const git = (dir) => {
    const r = runChild(['git', '-C', dir, 'status', '--porcelain'], { cwd: REPO, timeoutMs: 60000 })
    return r.code === 0 ? r.out.trim() : `ERR(${r.code}):${clip(r.out + r.err, 400)}`
  }
  const before = git(REAL_PACK)
  const r = runChild([NODE, path.join(TEST_DIR, 'integration.mjs'), `--pack=${REAL_PACK}`, '--only=pack-parity'], {
    cwd: REPO, timeoutMs: 180000,
  })
  const after = git(REAL_PACK)
  keepEvidence('T02-REAL-copy-only-side-effects', r, {
    REAL_PACK, before: clip(before, 800), after: clip(after, 800),
  })
  h.eq(after, before, '跑完真包集成后 git status 必须与跑之前相同（副作用只在副本上）')
})

// ---------------------------------------------------------------- ⑤ CDP：指向 NOTES 页的合法 URL
h.case('T02-CDP-notes-url-helper', 'pass', () => {
  const fx = fixture('multi-domain')
  const u = F.notesUrlFor(fx.root)
  h.evidence(path.join('cases', 'T02-CDP-notes-url-helper.txt'),
    `notesUrlFor(${fx.root}) = ${u}\nisNotesPageUrl = ${F.isNotesPageUrl(u)}\n`)
  h.eq(F.isNotesPageUrl(u), true, '`notesUrlFor` 必须算出指向 NOTES 页的合法 file:// URL')
  h.assert(/^file:\/\//.test(u), '必须是 file:// URL（不是目录路径）')
  h.assert(/reference\/NOTES\.html$/.test(u), '必须指向 reference/NOTES.html')
  // 手拼的 `'file:///' + path.replace(/\\/g,'/')` 不转义 —— 用带空格的路径证明区别
  const weird = path.join(os.tmpdir(), 'dsh whale T02 pack')
  fs.mkdirSync(path.join(weird, 'reference'), { recursive: true })
  fs.writeFileSync(path.join(weird, 'reference', 'NOTES.html'), '<html></html>', 'utf8')
  const enc = F.notesUrlFor(weird)
  h.evidence(path.join('cases', 'T02-CDP-notes-url-helper.txt'),
    `notesUrlFor(${fx.root}) = ${u}\nisNotesPageUrl = ${F.isNotesPageUrl(u)}\n`
    + `带空格路径 → ${enc}（合法 URL 会转义成 %20）\n`)
  h.assert(/%20/.test(enc), '带空格的路径要被转义（手拼 file:// 字符串做不到这一点）')
  cleanupTempDir(weird, 'dsh-whale')
})

h.case('T02-CDP-page-arg-is-url', 'pass', () => {
  const fx = fixture('multi-domain')
  // 真跑 pack-model.mjs：它内部会真起 lib/cdp.js --selftest <NOTES URL>
  const r = runChild([NODE, path.join(TEST_DIR, 'pack-model.mjs'), `--pack=${fx.root}`], { cwd: REPO, timeoutMs: 300000 })
  keepEvidence('T02-CDP-page-arg-is-url', r, { root: fx.root })
  const pageLine = both(r).split('\n').find((l) => /^页面/.test(l.trim()))
  h.evidence(path.join('cases', 'T02-CDP-page-arg-is-url.txt'),
    `pack-model 跑出来的「页面」行：${pageLine ?? '（没有）'}\n退出码=${r.code}\n`
    + `--- both() 里以 浏览器/页面 开头的行 ---\n`
    + both(r).split('\n').filter((l) => /^(浏览器|页面)/.test(l)).join('\n') + '\n')
  h.assert(/^页面/m.test(both(r)), 'CDP selftest 必须把「页面」那行打出来（证明它收到了什么）')
  const url = pageLine ? pageLine.replace(/^页面\s*：\s*/, '').trim() : ''
  h.assert(/^file:\/\//.test(url), `CDP 收到的页面必须是 file:// URL（实得 ${url || '空'}）`)
  h.assert(/reference\/NOTES\.html$/.test(url), `CDP 收到的页面必须指向 NOTES 页（实得 ${url || '空'}）`)
})

h.case('T02-CDP-rejects-directory-arg', 'pass', () => {
  // 结构性 + 行为双证：`lib/cdp.js` 的页面解析必须把**目录**挡在门外
  const cdpSrc = fs.readFileSync(path.join(REPO, 'lib', 'cdp.js'), 'utf8')
  const r = runChild([NODE, path.join(REPO, 'lib', 'cdp.js'), '--selftest', REAL_PACK || os.tmpdir()], {
    cwd: REPO,
    env: { DSH_WHALE_PACK: REAL_PACK || '' },
    timeoutMs: 300000,
  })
  keepEvidence('T02-CDP-rejects-directory-arg', r, { REAL_PACK })
  h.evidence(path.join('cases', 'T02-CDP-rejects-directory-arg.txt'),
    `lib/cdp.js 有 resolvePageUrl 导出？ ${/export function resolvePageUrl/.test(cdpSrc)}\n`
    + `lib/cdp.js 用 pathToFileURL？ ${/pathToFileURL/.test(cdpSrc)}\n`
    + `--- 传目录当页面时的原始输出（尾部） ---\n${clip(r.out + r.err, 4000)}\n`)
  h.assert(/export function resolvePageUrl/.test(cdpSrc), '`lib/cdp.js` 必须有可判的页面解析函数')
  h.assert(/pathToFileURL/.test(cdpSrc), '`lib/cdp.js` 必须用 pathToFileURL（不手拼 file:// 字符串）')
  h.assert(/不像 URL/.test(both(r)), '传目录时要**明说**它不像 URL（并忽略），不能拿它去 navigate')
})

h.case('T02-CDP-selftest-reaches-browser', 'pass', () => {
  if (!REAL_PACK) throw new Error('找不到真课程包（--real-pack= / DSH_WHALE_REAL_PACK）')
  const r = runChild([NODE, path.join(REPO, 'lib', 'cdp.js'), '--selftest', F ? F.notesUrlFor(REAL_PACK) : ''], {
    cwd: REPO, timeoutMs: 300000,
  })
  keepEvidence('T02-CDP-selftest-reaches-browser', r, { REAL_PACK, url: F ? F.notesUrlFor(REAL_PACK) : '' })
  // 本卡**不宣称**某条浏览器错误必然出现：只要求"页面是合法 URL，且 CDP 真的拿它去截图了"。
  // 浏览器缺失（本机没装）算**环境缺失**，如实说，不记 PASS。
  if (/找不到浏览器|no browser|ENOENT/i.test(both(r)) && r.code !== 0) {
    h.block('本机没有可用浏览器，CDP 真跑不了（环境缺失，不记 PASS）')
  }
  h.assert(/^页面\s*：\s*file:\/\//m.test(both(r)), 'CDP 必须收到 file:// 页面')
  h.assert(/视口截图尺寸恰好|截图落在/.test(both(r)), 'CDP 必须真的走到截图那一步（不是拿到 URL 就退）')
})

// ---------------------------------------------------------------- ⑥ 回归：T01 入口与旧用法
h.case('T02-REG-t01-still-passes', 'pass', () => {
  const r = runChild([NODE, path.join(TEST_DIR, 'audit', 'T01.mjs')], { cwd: REPO, timeoutMs: 900000 })
  keepEvidence('T02-REG-t01-still-passes', r, {})
  h.eq(r.code, 0, `T01 专项必须仍然 PASS（exit 0），实际 ${r.code}`)
  h.assert(/^PASS T01 checks=\d+ failed=0 skipped=0$/m.test(both(r).trim()), `T01 判词要仍是 PASS（实得：${both(r).trim().split('\n').slice(-1)[0]}）`)
})

h.case('T02-REG-selftest-still-passes', 'pass', () => {
  const r = runChild([NODE, ALL, '--selftest'], { cwd: REPO, timeoutMs: 120000 })
  keepEvidence('T02-REG-selftest-still-passes', r, {})
  h.eq(r.code, 0, `all.mjs --selftest 必须仍全绿（exit 0），实际 ${r.code}`)
  h.assert(/selftest: \d+ 通过 \/ 0 失败/.test(both(r)), 'selftest 摘要要仍是 0 失败')
})

h.case('T02-REG-legacy-env-invocation', 'pass', () => {
  // 旧用法（只给 env、不给参数）仍要能用 —— CI 就是这么调的（test/ci.mjs 设 DSH_WHALE_PACK）
  const r = runRunAll('legacy', { pack: null, env: { DSH_WHALE_PACK: PACK_A }, suites: 'pack-parity' })
  keepEvidence('T02-REG-legacy-env-invocation', r, { PACK_A })
  const lines = ctxLines(both(r))
  h.assert(lines.length > 0, '旧用法也要报 [test-context]')
  h.eq(lines[lines.length - 1].packRoot, PACK_A, '只给 env 时包根就是 env 那个（旧用法不破）')
  h.eq(lines[lines.length - 1].mode, 'real', '只给 env 时按 real 走（与 T02 之前一致）')
})

// ---------------------------------------------------------------- 收尾：清理夹具
{
  const notes = []
  for (const fx of fixtures) {
    const c = fx.dispose()
    notes.push(`${fx.variant} ${fx.root} removed=${c.removed}${c.error ? ` err=${c.error}` : ''}`)
  }
  for (const [d, tag] of [[ab.a, 'T02-packA'], [ab.b, 'T02-packB']]) {
    const c = cleanupTempDir(d, tag)
    notes.push(`${d} removed=${c.removed}${c.error ? ` err=${c.error}` : ''}`)
  }
  // 本次审计自己建的 run-all 结果目录 —— 清理前由 cleanupTempDir 核实路径属于本次 tag
  for (const t of OWN_TEMP) {
    const c = cleanupTempDir(t.dir, t.tag)
    notes.push(`${t.dir} removed=${c.removed}${c.error ? ` err=${c.error}` : ''}`)
  }
  h.note(notes.join('\n'))
}

process.exit(h.run())
