#!/usr/bin/env node
/**
 * T01.mjs —— 让统一裁判拒绝假绿（报告 F01 / P1）
 * ==================================================================
 * 验收判据（原文）：绿摘要+exit2、红行+0失败、0/0、无摘要+exit0、重复摘要均 exit1；
 *                   正常执行才绿。
 * 专项用例：除原文矩阵外，测试壳自身断言失败 / 子进程崩溃 / 无检查 / 必需 case 缺失
 *           均须非零；取消固定 3091 端口猜 skip。
 *
 * 怎么做才算「不是假绿」：
 *   - 每条负例都**真起子进程**跑真实入口 `test/all.mjs`（夹具包里放假闸门/假 run-all），
 *     看它的退出码与判词，而不是在本地重算一遍判词。
 *   - 每个夹具的**完整 stdout/stderr/退出码/机器结果**都落到 audit-evidence/T01/。
 *   - 固定用例 ID 集合写在下面 EXPECTED_IDS 里：缺一条、多一条、重一条都算失败。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T01.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 原文验收矩阵（五条负例 + 正常执行才绿）
  'T01-ALL-green-summary-exit2',
  'T01-ALL-red-line-zero-failed',
  'T01-ALL-zero-over-zero',
  'T01-ALL-no-summary-exit0',
  'T01-ALL-duplicate-summary',
  'T01-ALL-normal-green',
  // ② run-all 这一层自己的假绿入口
  'T01-RUN-contradiction',
  'T01-RUN-crash-after-green',
  'T01-RUN-missing-summary',
  'T01-RUN-green-fixture',
  // ③ 测试壳自身的负向自检
  'T01-HARNESS-assert-fail',
  'T01-HARNESS-body-throw',
  'T01-HARNESS-missing-required-case',
  'T01-HARNESS-extra-case',
  'T01-HARNESS-blocked-exit2',
  // ④ 旧文本 adapter 的逐项对账（不进子进程，直接喂文本）
  'T01-ADAPTER-gate-duplicate',
  'T01-ADAPTER-gate-zero',
  'T01-ADAPTER-gate-red-with-green-text',
  'T01-ADAPTER-suites-claimed-zero-failed',
  'T01-ADAPTER-suites-allpass-with-redline',
  'T01-ADAPTER-suites-missing-summary',
  'T01-ADAPTER-suites-duplicate',
  'T01-ADAPTER-suites-single-suite-summary-not-mistaken',
  // ⑤ 旧裁判确实会被这些负例骗过（证明「旧行为确实假绿」，不是嘴上说）
  'T01-OLD-fooled-by-green-summary-exit2',
  'T01-OLD-fooled-by-zero-over-zero',
  'T01-OLD-fooled-by-no-summary-exit0',
  'T01-OLD-fooled-by-duplicate-summary',
]

const NODE = process.execPath
const CASE_DIR = path.join(REPO, 'audit-evidence', 'T01', 'cases')

const h = createHarness({ card: 'T01', expectedIds: EXPECTED_IDS, root: REPO })

// ---------------------------------------------------------------- 夹具小工具
const CARD = `'T01'`
/** 假闸门：绿摘要 + 退出码 2（「先打全绿再崩」） */
const FAKE_GATE_GREEN_EXIT2 = `process.stdout.write('=== 闸门：38 / 38 通过 —— 全绿 ===\\n')\nprocess.exit(2)\n`
/** 假闸门：正常（exit 0 + 唯一摘要） */
const FAKE_GATE_OK = `process.stdout.write('=== 闸门：38 / 38 通过 —— 全绿 ===\\n')\nprocess.exit(0)\n`

/** 用一段脚本当 run-all；脚本内容由 scenario.runAll 给 */
function fakeRunAll(js) { return `${js}\n` }

/**
 * 夹具的机器结果（七项）。**cases 条数必须与 passed/failed 自洽** —— 这正是协议要的。
 * 假 run-all 把它写到 `DSH_WHALE_RESULT`（总入口会显式给这个环境变量）。
 */
function recordWriter(cases, extra = {}) {
  const passed = cases.filter((c) => c.status === 'pass').length
  const failed = cases.filter((c) => c.status === 'fail').length
  const rec = {
    passed,
    failed,
    skipped: 0,
    reason: failed ? (extra.reason ?? `失败 ${failed} 项：${cases.filter((c) => c.status === 'fail').map((c) => c.id).join('、')}`) : null,
    packRoot: extra.packRoot ?? null,
    base: 'fixture run-all',
    cases,
  }
  return `import fs from 'node:fs'\nfs.writeFileSync(process.env.DSH_WHALE_RESULT, ${JSON.stringify(JSON.stringify(rec))}, 'utf8')\n`
}

const RUN_ALL = {
  /** 绿摘要但退出码 2 */
  greenExit2: fakeRunAll(`process.stdout.write('=== 1 套 · 共 9 条断言 · 全部通过 ✓ ===\\n')\nprocess.exit(2)`),
  /** 红行 + 摘要说 0 套失败 */
  redLineZeroFailed: fakeRunAll(`process.stdout.write('✗ pack-parity 0 通过 / 1 失败\\n')\nprocess.stdout.write('=== 1 套 · 共 9 条断言 · 0 套失败 ===\\n')\nprocess.exit(0)`),
  /** 0/0 */
  zeroOverZero: fakeRunAll(`process.stdout.write('=== 0 套 · 共 0 条断言 · 全部通过 ✓ ===\\n')\nprocess.exit(0)`),
  /** 无摘要 + exit0 */
  noSummary: fakeRunAll(`process.stdout.write('什么都没有，就是没跑\\n')\nprocess.exit(0)`),
  /** 重复摘要（两条都写全绿） */
  duplicate: fakeRunAll(`process.stdout.write('=== 1 套 · 共 9 条断言 · 全部通过 ✓ ===\\n')\nprocess.stdout.write('=== 1 套 · 共 9 条断言 · 全部通过 ✓ ===\\n')\nprocess.exit(0)`),
  /** 正常：唯一摘要 + 非零执行量 + exit0 + 机器结果对得上 */
  green: fakeRunAll(recordWriter([{ id: 'pack-parity', status: 'pass', exitCode: 0 }])
    + `process.stdout.write('=== 1 套 · 共 9 条断言 · 全部通过 ✓ ===\\n')\nprocess.exit(0)`),
  /** 红行 + 0 套失败 + 机器结果**照实记红**（用来隔离「红行」这一条判据） */
  redLineZeroFailedHonest: fakeRunAll(recordWriter([{ id: 'pack-parity', status: 'fail', exitCode: 1, note: '0 通过 / 1 失败' }])
    + `process.stdout.write('✗ pack-parity 0 通过 / 1 失败\\n')\nprocess.stdout.write('=== 1 套 · 共 9 条断言 · 0 套失败 ===\\n')\nprocess.exit(1)`),
  /** 无摘要 + exit0 + 机器结果照实记红 */
  noSummaryHonest: fakeRunAll(recordWriter([{ id: 'pack-parity', status: 'fail', exitCode: 0, note: '解析不到套件摘要行' }])
    + `process.stdout.write('什么都没有，就是没跑\\n')\nprocess.exit(0)`),
  /** 重复摘要 + 机器结果照实记红 */
  duplicateHonest: fakeRunAll(recordWriter([{ id: 'pack-parity', status: 'fail', exitCode: 0, note: '摘要行出现了 2 次' }])
    + `process.stdout.write('=== 1 套 · 共 9 条断言 · 全部通过 ✓ ===\\n')\nprocess.stdout.write('=== 1 套 · 共 9 条断言 · 全部通过 ✓ ===\\n')\nprocess.exit(0)`),
  /** 0/0 + 机器结果**自报全绿**（空账伪装成绿账） */
  zeroOverZeroFakeGreen: fakeRunAll(recordWriter([{ id: 'pack-parity', status: 'pass', exitCode: 0 }])
    + `process.stdout.write('=== 0 套 · 共 0 条断言 · 全部通过 ✓ ===\\n')\nprocess.exit(0)`),
}

/** 机器结果文件（run-all 的七项）——夹具里也放一份「自报全绿」的，看入口认不认 */
function writeRecord(file, spec = {}) {
  const rec = {
    passed: spec.passed ?? 50,
    failed: spec.failed ?? 0,
    skipped: spec.skipped ?? 0,
    reason: spec.reason ?? null,
    packRoot: spec.packRoot ?? null,
    base: spec.base ?? 'fixture',
    cases: spec.cases ?? [{ id: 'fixture:suites', status: 'pass', note: '50 套' }],
  }
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8')
  return rec
}

/**
 * 起一个假课程包 + 假 run-all，然后**真跑** `test/all.mjs`。
 * 返回 {code, out, err, timedOut, packRoot, resultFile}
 */
function runAllEntry(tag, { gate = FAKE_GATE_OK, runAll = RUN_ALL.green, record = null } = {}) {
  const root = makeTempDir(`dsh-whale-T01-all-${tag}`)
  const pack = path.join(root, 'pack')
  fs.mkdirSync(path.join(pack, 'presets'), { recursive: true })
  fs.mkdirSync(path.join(pack, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'presets', 'whale-sensei.css'), '/* fixture pack marker */\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'tools', 'gate.mjs'), gate, 'utf8')
  const runAllFile = path.join(root, 'fixture-run-all.mjs')
  fs.writeFileSync(runAllFile, runAll, 'utf8')
  const resultFile = path.join(root, 'run-all-result.json')
  if (record) writeRecord(resultFile, record)
  const r = runChild([NODE, path.join(TEST_DIR, 'all.mjs'), pack], {
    cwd: REPO,
    env: { DSH_WHALE_RUN_ALL: runAllFile, DSH_WHALE_RESULT: resultFile },
    timeoutMs: 120000,
  })
  return { ...r, packRoot: pack, resultFile, root }
}

/** 证据：把一次子进程的完整原始输出落盘（不裁剪语义，超长只留头尾） */
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
  h.evidence(path.join('cases', `${id}.txt`), clip(text, 20000))
}

const verdictOf = (out) => {
  const m = String(out).match(/=== 判词：([^=]+)===/)
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------- ① 原文验收矩阵
h.case('T01-ALL-green-summary-exit2', 'fail', () => {
  const r = runAllEntry('green-exit2', { gate: FAKE_GATE_GREEN_EXIT2, runAll: RUN_ALL.green })
  keepEvidence('T01-ALL-green-summary-exit2', r, { packRoot: r.packRoot, verdict: verdictOf(r.out) })
  cleanupTempDir(r.root, 'T01-all-green-exit2')
  h.assert(r.code === 1, `绿摘要+exit2 应当 exit1，实际 ${r.code}`)
  h.assert(verdictOf(r.out) === '红', `判词应当红，实际 ${verdictOf(r.out)}`)
  h.assert(/闸门子进程退出码 2/.test(r.out), '应当点名闸门退出码 2')
})

h.case('T01-ALL-red-line-zero-failed', 'fail', () => {
  const r = runAllEntry('red-zero', { runAll: RUN_ALL.redLineZeroFailedHonest })
  keepEvidence('T01-ALL-red-line-zero-failed', r, { verdict: verdictOf(r.out) })
  cleanupTempDir(r.root, 'T01-all-red-zero')
  h.assert(r.code === 1, `红行+0失败 应当 exit1，实际 ${r.code}`)
  h.assert(verdictOf(r.out) === '红', `判词应当红，实际 ${verdictOf(r.out)}`)
  h.assert(/0 套失败|矛盾/.test(r.out), '应当点名「0 套失败」这条矛盾')
})

h.case('T01-ALL-zero-over-zero', 'fail', () => {
  const r = runAllEntry('zero', { runAll: RUN_ALL.zeroOverZeroFakeGreen })
  keepEvidence('T01-ALL-zero-over-zero', r, { verdict: verdictOf(r.out) })
  cleanupTempDir(r.root, 'T01-all-zero')
  h.assert(r.code === 1, `0/0 应当 exit1，实际 ${r.code}`)
  h.assert(verdictOf(r.out) === '红', `判词应当红，实际 ${verdictOf(r.out)}`)
})

h.case('T01-ALL-no-summary-exit0', 'fail', () => {
  const r = runAllEntry('nosum', { runAll: RUN_ALL.noSummaryHonest })
  keepEvidence('T01-ALL-no-summary-exit0', r, { verdict: verdictOf(r.out) })
  cleanupTempDir(r.root, 'T01-all-nosum')
  h.assert(r.code === 1, `无摘要+exit0 应当 exit1，实际 ${r.code}`)
  h.assert(verdictOf(r.out) === '红', `判词应当红，实际 ${verdictOf(r.out)}`)
})

h.case('T01-ALL-duplicate-summary', 'fail', () => {
  const r = runAllEntry('dup', { runAll: RUN_ALL.duplicateHonest })
  keepEvidence('T01-ALL-duplicate-summary', r, { verdict: verdictOf(r.out) })
  cleanupTempDir(r.root, 'T01-all-dup')
  h.assert(r.code === 1, `重复摘要 应当 exit1，实际 ${r.code}`)
  h.assert(verdictOf(r.out) === '红', `判词应当红，实际 ${verdictOf(r.out)}`)
  h.assert(/摘要行出现了 2 次|重复摘要/.test(r.out), '应当点名摘要重复')
})

h.case('T01-ALL-normal-green', 'pass', () => {
  const r = runAllEntry('ok', { gate: FAKE_GATE_OK, runAll: RUN_ALL.green })
  keepEvidence('T01-ALL-normal-green', r, { verdict: verdictOf(r.out) })
  cleanupTempDir(r.root, 'T01-all-ok')
  h.assert(r.code === 0, `正常执行应当 exit0，实际 ${r.code}`)
  h.assert(verdictOf(r.out) === '绿', `判词应当绿，实际 ${verdictOf(r.out)}`)
})

// ---------------------------------------------------------------- ② run-all 自己这一层
/** 造一个假插件仓：真 run-all.mjs + 真 _result.mjs + 三个假套件 */
function makeRunAllFixture(tag, suites) {
  const root = makeTempDir(`dsh-whale-T01-run-${tag}`)
  fs.mkdirSync(path.join(root, 'test'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't01-fixture', type: 'module' }, null, 2), 'utf8')
  fs.copyFileSync(path.join(TEST_DIR, 'run-all.mjs'), path.join(root, 'test', 'run-all.mjs'))
  fs.copyFileSync(path.join(TEST_DIR, '_result.mjs'), path.join(root, 'test', '_result.mjs'))
  fs.copyFileSync(path.join(TEST_DIR, '_suite-manifest.mjs'), path.join(root, 'test', '_suite-manifest.mjs'))
  // T02（F02）后 `run-all.mjs` 会 import `./_pack.mjs`（定源 + 逐进程对账）——
  // 假插件仓里也得有它，否则子进程直接 ERR_MODULE_NOT_FOUND（那不是本卡要测的东西）。
  fs.copyFileSync(path.join(TEST_DIR, '_pack.mjs'), path.join(root, 'test', '_pack.mjs'))
  // T02（F02）后 `run-all.mjs` 会**顶层解析一次**测试上下文：没有包根就直接 exit 2（不猜路径）。
  // 假插件仓里补一个"看着像课程包"的目录（判据件就是 presets/whale-sensei.css），
  // 让本卡的负例仍然测的是「假绿判定」，而不是"没给包根"。
  const pack = path.join(root, 'pack')
  fs.mkdirSync(path.join(pack, 'presets'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'presets', 'whale-sensei.css'), '/* T01 假包 */\n', 'utf8')
  for (const [name, src] of Object.entries(suites)) {
    // T02（F02）：`run-all.mjs` 现在会**逐进程对账** `[test-context]`（参数传没传到每个子进程）。
    // 假套件也得像真套件那样报一行 —— 否则会被记成 ctxDrift（那是另一条判据，不该在这里红）。
    // 这一行按 `_pack.mjs` 的固定格式写死，与真套件的上报形状一致。
    const ctxLine = `process.stderr.write('[test-context] mode=real pack=' + ${JSON.stringify(pack)} + '\\n')\n`
    fs.writeFileSync(path.join(root, 'test', `${name}.mjs`), ctxLine + src, 'utf8')
  }
  const resultFile = path.join(root, 'result.json')
  const r = runChild([NODE, path.join(root, 'test', 'run-all.mjs'), `--pack=${pack}`], {
    cwd: root,
    env: { DSH_WHALE_RESULT: resultFile, DSH_WHALE_SUITES: Object.keys(suites).join(',') },
    timeoutMs: 120000,
  })
  let record = null
  try { record = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { record = null }
  return { ...r, root, resultFile, record }
}

const SUITE_GREEN = `process.stdout.write('  ok 一条\\n=== 2 通过 / 0 失败 ===\\n')\nprocess.exit(0)\n`
const SUITE_CONTRADICTION = `process.stdout.write('  FAIL 某条\\n=== 1 通过 / 1 失败 ===\\n')\nprocess.exit(1)\n`
const SUITE_CRASH_AFTER_GREEN = `process.stdout.write('  ok 一条\\n=== 2 通过 / 0 失败 ===\\n')\nprocess.exit(2)\n`
const SUITE_NO_SUMMARY = `process.stdout.write('我什么都没说\\n')\nprocess.exit(0)\n`

h.case('T01-RUN-contradiction', 'fail', () => {
  const f = makeRunAllFixture('contra', { 'pack-parity': SUITE_CONTRADICTION, 'build-verify': SUITE_GREEN })
  keepEvidence('T01-RUN-contradiction', f, { record: JSON.stringify(f.record) })
  cleanupTempDir(f.root, 'T01-run-contra')
  h.assert(f.code === 1, `有红套件应当 exit1，实际 ${f.code}`)
  h.assert(f.record && f.record.failed > 0, '机器结果里 failed 必须 > 0')
  h.assert(f.record && f.record.cases.some((c) => c.id === 'pack-parity' && c.status === 'fail'), '机器结果必须点名 pack-parity 是 fail')
})

h.case('T01-RUN-crash-after-green', 'fail', () => {
  const f = makeRunAllFixture('crash', { 'pack-parity': SUITE_CRASH_AFTER_GREEN, 'build-verify': SUITE_GREEN })
  keepEvidence('T01-RUN-crash-after-green', f, { record: JSON.stringify(f.record) })
  cleanupTempDir(f.root, 'T01-run-crash')
  h.assert(f.code === 1, `先打绿再崩 应当 exit1，实际 ${f.code}`)
  h.assert(f.record && f.record.failed > 0, '机器结果里 failed 必须 > 0')
  h.assert(f.record && f.record.cases.some((c) => c.id === 'exit:pack-parity'), '机器结果必须有 exit:pack-parity 记账')
  h.assert(/先打绿再崩|退出码 2/.test(f.out), '应当点名退出码 2')
})

h.case('T01-RUN-missing-summary', 'fail', () => {
  const f = makeRunAllFixture('nosum', { 'pack-parity': SUITE_NO_SUMMARY, 'build-verify': SUITE_GREEN })
  keepEvidence('T01-RUN-missing-summary', f, { record: JSON.stringify(f.record) })
  cleanupTempDir(f.root, 'T01-run-nosum')
  h.assert(f.code === 1, `缺摘要 应当 exit1，实际 ${f.code}`)
  h.assert(f.record && f.record.failed > 0, '机器结果里 failed 必须 > 0')
})

h.case('T01-RUN-green-fixture', 'pass', () => {
  const f = makeRunAllFixture('green', { 'pack-parity': SUITE_GREEN, 'build-verify': SUITE_GREEN })
  keepEvidence('T01-RUN-green-fixture', f, { record: JSON.stringify(f.record) })
  cleanupTempDir(f.root, 'T01-run-green')
  h.assert(f.code === 0, `真绿 应当 exit0，实际 ${f.code}`)
  h.assert(f.record && f.record.failed === 0 && f.record.passed === 2, `机器结果应当 passed=2 failed=0，实际 ${JSON.stringify(f.record && { p: f.record.passed, f: f.record.failed })}`)
  h.assert(f.record && Array.isArray(f.record.cases) && f.record.cases.length === 2, '机器结果 cases 应当 2 条')
})

// ---------------------------------------------------------------- ③ 测试壳自身的负向自检
/** 拿一个**新的**壳判一遍（**不打印** —— 免得往本卡的 stdout 多吐行），只看它的退出码 */
function shellCheck(tag, build) {
  const sub = createHarness({ card: 'T01', expectedIds: tag.expectedIds ?? null, evidenceDir: path.join(CASE_DIR, `shell-${tag.name}`) })
  build(sub)
  const ev = sub.evaluate()
  return { code: ev.code, cases: sub.cases.map((c) => `${c.id}=${c.actual}`).join(',') }
}

h.case('T01-HARNESS-assert-fail', 'pass', () => {
  const r = shellCheck({ name: 'assert-fail' }, (s) => {
    s.case('c1', 'pass', () => s.assert(false, '故意断言失败'))
  })
  h.eq(r.code, 1, '壳里断言失败必须 exit1')
})

h.case('T01-HARNESS-body-throw', 'pass', () => {
  const r = shellCheck({ name: 'body-throw' }, (s) => {
    s.case('c1', 'pass', () => { throw new Error('故意抛') })
  })
  h.eq(r.code, 1, 'case body 抛异常必须 exit1（不许被吞掉）')
})

h.case('T01-HARNESS-missing-required-case', 'pass', () => {
  const r = shellCheck({ name: 'missing', expectedIds: ['a', 'b'] }, (s) => {
    s.case('a', 'pass', () => {})
  })
  h.eq(r.code, 1, '必需 case 缺失必须 exit1')
  h.assert(/b=fail/.test(r.cases), `缺失的 b 应当记 fail，实际 ${r.cases}`)
})

h.case('T01-HARNESS-extra-case', 'pass', () => {
  const r = shellCheck({ name: 'extra', expectedIds: ['a'] }, (s) => {
    s.case('a', 'pass', () => {})
    s.case('偷偷加的', 'pass', () => {})
  })
  h.eq(r.code, 1, '固定 ID 集合外的 case 必须 exit1（集合漂移）')
})

h.case('T01-HARNESS-blocked-exit2', 'pass', () => {
  const r = shellCheck({ name: 'blocked' }, (s) => {
    s.case('c1', 'pass', () => {})
    s.block('故意缺料')
  })
  h.eq(r.code, 2, '缺料必须 exit2（绝不记成 PASS）')
})

// ---------------------------------------------------------------- ④ 旧文本 adapter 逐项对账
/** 直接喂文本给 adapter（不碰子进程）——这就是「严格 adapter」的判据面 */
let adaptLegacyText = null
try {
  const mod = await import(pathToFileURL(path.join(TEST_DIR, '_result.mjs')).href)
  adaptLegacyText = mod.adaptLegacyText
} catch (e) {
  h.block(`读不到 test/_result.mjs：${e && e.message ? e.message : String(e)}`)
}
const adapt = (spec) => {
  if (!adaptLegacyText) throw new Error('adapter 没加载（材料缺失）')
  return adaptLegacyText(spec)
}
/** adapter 探针：跑一次、落原始证据、再判 —— 证据不落就等于没跑过 */
function probeAdapter(id, spec) {
  const r = adapt(spec)
  h.evidence(path.join('cases', `${id}.txt`),
    `# ${id}\ninput.kind=${spec.kind} input.code=${spec.code}\ninput.out=${JSON.stringify(spec.out)}\n`
    + `adapter=${JSON.stringify({ ok: r.ok, parsed: r.parsed, reason: r.reason, summaries: r.summaries, passed: r.passed, failed: r.failed, redLines: r.redLines })}\n`)
  return r
}

h.case('T01-ADAPTER-gate-duplicate', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-gate-duplicate', { kind: 'gate', out: '=== 闸门：38 / 38 通过 —— 全绿 ===\n=== 闸门：38 / 38 通过 —— 全绿 ===', code: 0 })
  h.assert(r.ok === false, '重复闸门摘要必须判红')
  h.eq(r.summaries, 2, '应当数出 2 条摘要')
})

h.case('T01-ADAPTER-gate-zero', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-gate-zero', { kind: 'gate', out: '=== 闸门：0 / 0 通过 ===', code: 0 })
  h.assert(r.ok === false, '0/0 闸门必须判红')
})

h.case('T01-ADAPTER-gate-red-with-green-text', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-gate-red-with-green-text', { kind: 'gate', out: 'FAIL 1ms x\n=== 闸门：38 / 38 通过 —— 全绿 ===', code: 0 })
  h.assert(r.ok === false, '红行 + 全绿摘要必须判红（矛盾摘要）')
})

h.case('T01-ADAPTER-suites-claimed-zero-failed', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-suites-claimed-zero-failed', { kind: 'suites', out: '✗ pack-parity 0 通过 / 1 失败\n=== 50 套 · 共 2525 条断言 · 0 套失败 ===', code: 0 })
  h.assert(r.ok === false, '红行 + 0 套失败必须判红')
})

h.case('T01-ADAPTER-suites-allpass-with-redline', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-suites-allpass-with-redline', { kind: 'suites', out: '✗ pack-parity 0 通过 / 1 失败\n=== 50 套 · 共 2525 条断言 · 全部通过 ✓ ===', code: 0 })
  h.assert(r.ok === false, '红行 + 全部通过必须判红')
})

h.case('T01-ADAPTER-suites-missing-summary', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-suites-missing-summary', { kind: 'suites', out: '没有摘要', code: 0 })
  h.assert(r.ok === false && r.parsed === false, '缺摘要必须 parsed=false 且判红')
})

h.case('T01-ADAPTER-suites-duplicate', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-suites-duplicate', { kind: 'suites', out: '=== 50 套 · 共 2525 条断言 · 全部通过 ✓ ===\n=== 50 套 · 共 2525 条断言 · 全部通过 ✓ ===', code: 0 })
  h.assert(r.ok === false, '重复套件摘要必须判红')
  h.eq(r.summaries, 2, '应当数出 2 条摘要')
})

h.case('T01-ADAPTER-suites-single-suite-summary-not-mistaken', 'pass', () => {
  const r = probeAdapter('T01-ADAPTER-suites-single-suite-summary-not-mistaken', { kind: 'suites', out: '  ok 一条\n=== 2 通过 / 0 失败 ===', code: 0 })
  h.assert(r.ok === false && r.parsed === false, '单套自己的「2 通过 / 0 失败」不许被当成 run-all 摘要（F01 教训）')
})

// ---------------------------------------------------------------- ⑤ 旧裁判确实会被骗（基线对照）
/**
 * 取**基线 commit** 的 test/all.mjs（只读 git show，不碰只读快照），放进临时副本里 import，
 * 用**同一批假绿文本**喂它 —— 目的：证明「旧裁判会绿」这句话是可复现的事实，不是断言。
 */
const BASELINE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
let oldJudge = null
let oldJudgeDir = null
try {
  const { execFileSync } = await import('node:child_process')
  const src = execFileSync('git', ['show', `${BASELINE_COMMIT}:test/all.mjs`], { cwd: REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  oldJudgeDir = makeTempDir('dsh-whale-T01-old')
  fs.mkdirSync(path.join(oldJudgeDir, 'test'), { recursive: true })
  fs.writeFileSync(path.join(oldJudgeDir, 'test', 'all.mjs'), src, 'utf8')
  fs.copyFileSync(path.join(TEST_DIR, '_pack.mjs'), path.join(oldJudgeDir, 'test', '_pack.mjs'))
  const mod = await import(pathToFileURL(path.join(oldJudgeDir, 'test', 'all.mjs')).href)
  oldJudge = { parseGate: mod.parseGate, parseSuites: mod.parseSuites, summarize: mod.summarize, bytes: src.length }
} catch (e) {
  h.block(`取不到基线 test/all.mjs：${e && e.message ? e.message : String(e)}`)
}

h.case('T01-OLD-fooled-by-green-summary-exit2', 'pass', () => {
  const out = '=== 闸门：38 / 38 通过 —— 全绿 ==='
  const gate = oldJudge.parseGate(out)
  const r = oldJudge.summarize(gate, oldJudge.parseSuites('=== 50 套 · 共 2525 条断言 · 全部通过 ✓ ==='), true)
  const newJudge = adapt({ kind: 'gate', out, code: 2 })
  h.evidence(path.join('cases', 'T01-OLD-fooled-by-green-summary-exit2.txt'),
    `旧裁判 parseGate("${out}") = ${JSON.stringify(gate)}\n旧裁判 summarize(...).green = ${r.green}（exit2 它根本没看）\n新 adapter.ok = ${newJudge.ok}（reason=${newJudge.reason}）\n`)
  h.assert(r.green === true, `旧裁判应当被绿摘要+exit2 骗过（green=true），实际 ${r.green}`)
  h.assert(newJudge.ok === false, '新裁判必须拒绝绿摘要+exit2')
})

h.case('T01-OLD-fooled-by-zero-over-zero', 'pass', () => {
  const gOut = '=== 闸门：0 / 0 通过 ==='
  const sOut = '=== 0 套 · 共 0 条断言 · 全部通过 ✓ ==='
  const gate = oldJudge.parseGate(gOut)
  const suites = oldJudge.parseSuites(sOut)
  const r = oldJudge.summarize(gate, suites, true)
  const newGate = adapt({ kind: 'gate', out: gOut, code: 0 })
  h.evidence(path.join('cases', 'T01-OLD-fooled-by-zero-over-zero.txt'),
    `旧裁判 gate=${JSON.stringify(gate)}\n旧裁判 suites=${JSON.stringify(suites)}\n旧裁判 green=${r.green}\n新 adapter gate.ok=${newGate.ok}（${newGate.reason}）\n`)
  h.assert(r.green === true, `旧裁判应当被 0/0 骗过（green=true），实际 ${r.green}`)
  h.assert(newGate.ok === false, '新裁判必须拒绝 0/0')
})

h.case('T01-OLD-fooled-by-no-summary-exit0', 'pass', () => {
  const out = '什么都没有，就是没跑'
  const gate = oldJudge.parseGate(out)
  const r = oldJudge.summarize(gate, oldJudge.parseSuites(out), true)
  const newJudge = adapt({ kind: 'gate', out, code: 0 })
  h.evidence(path.join('cases', 'T01-OLD-fooled-by-no-summary-exit0.txt'),
    `旧裁判 parsed=${gate.parsed} ok=${gate.ok}（不 ok 是对的：它这里判红）\n旧裁判 summarize.green=${r.green}\n新 adapter.ok=${newJudge.ok}\n`)
  h.assert(r.green === false, '旧裁判对「无摘要」其实判红（这一条不是旧裁判的漏洞，是留给新裁判的对照）')
  h.assert(newJudge.ok === false && newJudge.parsed === false, '新裁判对无摘要必须红')
})

h.case('T01-OLD-fooled-by-duplicate-summary', 'pass', () => {
  const out = '=== 闸门：38 / 38 通过 —— 全绿 ===\n=== 闸门：38 / 38 通过 —— 全绿 ==='
  const gate = oldJudge.parseGate(out)
  const r = oldJudge.summarize(gate, oldJudge.parseSuites('=== 50 套 · 共 2525 条断言 · 全部通过 ✓ ==='), true)
  const newJudge = adapt({ kind: 'gate', out, code: 0 })
  h.evidence(path.join('cases', 'T01-OLD-fooled-by-duplicate-summary.txt'),
    `旧裁判 parseGate 只看第一条摘要：${JSON.stringify({ ok: gate.ok, pass: gate.pass, total: gate.total })}\n旧裁判 green=${r.green}\n新 adapter.ok=${newJudge.ok} summaries=${newJudge.summaries}（${newJudge.reason}）\n`)
  h.assert(r.green === true, `旧裁判应当被重复摘要骗过（green=true），实际 ${r.green}`)
  h.assert(newJudge.ok === false && newJudge.summaries === 2, '新裁判必须数出 2 条摘要并判红')
})

if (oldJudgeDir) {
  const c = cleanupTempDir(oldJudgeDir, 'T01-old')
  h.note(`基线对照临时副本 ${oldJudgeDir}：removed=${c.removed}${c.error ? ` err=${c.error}` : ''}`)
}

process.exit(h.run())
