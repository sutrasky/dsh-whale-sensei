#!/usr/bin/env node
/**
 * T12 —— 证据读取故障 fail-closed（报告 C02 P1 / C01 P1；计划 §6 T12）
 * ==================================================================
 * 卡面验收判据（原文）：
 *   「ENOENT、空账、损坏 JSONL、EISDIR、EACCES 分别给不同回执；
 *     后四种不能静默跳过已声明的证据要求。」
 * 补充（原文）：「EACCES 用确定性 IO 注入，并另记真实权限环境测试；空账是明确不足不是 IO 错误。
 *   append 也跑 T09 故障与双进程矩阵。」
 *
 * 本文件只碰**自建夹具**（`E:/Temp/whale-T12-*`）：不写用户活包 `E:\workplace\study`、
 * 不写只读快照。子进程一律 `stdio:'ignore'` + 结果走 report 文件（受限沙箱下 piped stdio 的
 * spawn 会被 EPERM 拒）；进程中断是**真杀**（`process.kill(pid,'SIGKILL')`）。
 *
 * 负向控制（`T12-negative-baseline`）：从基线 commit `ba22c94` 取 `lib/evidence-io.js` /
 * `lib/state.js` 放进**临时副本**，证明旧实现真的把 EISDIR / 坏账当"不存在 / 可用"而放行
 * （产品文件一个字节都不动）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarness, REPO, clip } from './harness.mjs'
import { readEvidence, appendEvidence, evidencePath } from '../../lib/evidence-io.js'
import { judgeChallenges } from '../../lib/state.js'
import { probeState, writeState } from '../../lib/state-scan.js'
import { challengeGate, readSnapshot } from '../../lib/gate.js'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const TXN = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs'))
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
const LIVE_PACK = 'E:/workplace/study'

/** 固定用例 ID 全集（**不许漂移**：缺一条、多一条、重一条都算失败） */
const IDS = [
  'T12-read-enoent',
  'T12-read-empty',
  'T12-read-invalid-jsonl',
  'T12-read-invalid-record',
  'T12-read-eisdir',
  'T12-read-eacces-inject',
  'T12-read-real-permission-boundary',
  'T12-read-legacy-fields',
  'T12-judge-missing-fallback',
  'T12-judge-empty-blocked',
  'T12-judge-invalid-blocked',
  'T12-judge-ioerr-blocked',
  'T12-judge-ok-passes',
  'T12-judge-legacy-shapes',
  'T12-propagate-probe-invalid',
  'T12-propagate-gate-broken',
  'T12-propagate-gate-stale-ledger',
  'T12-append-commit',
  'T12-append-reject-no-write',
  'T12-append-refuse-corrupt',
  'T12-append-fault-matrix',
  'T12-append-rollback-failure-recover',
  'T12-append-concurrent-200',
  'T12-append-kill-recover',
  'T12-negative-baseline',
  'T12-cleanup-guard',
]

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const json = (v) => JSON.stringify(v, null, 2)
const record = (lesson, challenge, kind, ref = null) => JSON.stringify({ date: null, lesson, challenge, kind, ref, note: null }) + '\n'

/** 证据目录缺省：`audit-evidence/T12/`（harness 会写 result.json / cases.jsonl） */
const h = createHarness({ card: 'T12', expectedIds: IDS })

// ================================================================ 子进程（夹具写者）
function workerAppend() {
  const root = arg('root')
  const report = arg('report')
  const writer = Number(arg('writer'))
  const n = Number(arg('n') || 100)
  const out = { writer, pid: process.pid, done: 0, failed: [], maxAttempts: 0 }
  for (let i = 0; i < n; i++) {
    let r = null
    let attempts = 0
    for (; attempts < 20000; attempts++) {
      // 跨进程真并发：拿不到锁就是 busy（卡面 outOfScope：不自动强抢）—— 正常用法是重试
      r = appendEvidence(root, {
        lesson: 'x/0001', challenge: 1, kind: 'run', ref: `w${writer}-${i}`,
      }, { ownerToken: `writer-${writer}`, timeoutMs: 10000 })
      if (r.state !== 'busy') break
      sleepSync(2)
    }
    out.maxAttempts = Math.max(out.maxAttempts, attempts)
    if (!r || !r.ok) {
      out.failed.push({ i, state: r && r.state, error: r && r.error })
      break
    }
    out.done += 1
  }
  fs.writeFileSync(report, json(out), 'utf8')
  process.exit(out.failed.length ? 1 : 0)
}

function workerKill() {
  const root = arg('root')
  const marker = arg('marker')
  const report = arg('report')
  const real = fs
  const io = {
    ...real,
    renameSync: (a, b) => {
      if (String(b).endsWith('evidence.jsonl')) {
        // 真杀：不跑 finally、不给清理机会（与 T09 的进程中断同口径）
        fs.writeFileSync(marker, json({ at: 'rename', target: String(b), pid: process.pid }) + '\n', 'utf8')
        process.kill(process.pid, 'SIGKILL')
        process.abort()
        process.exit(97)
      }
      return real.renameSync(a, b)
    },
  }
  const r = appendEvidence(root, { lesson: 'x/0001', challenge: 1, kind: 'run', ref: 'killed' }, {
    fs: io, ownerToken: 'kill-worker', timeoutMs: 10000,
  })
  fs.writeFileSync(report, json(r), 'utf8')
  process.exit(r.ok ? 0 : 1)
}

if (arg('mode') === 'append-worker') workerAppend()
else if (arg('mode') === 'append-kill') workerKill()
else await main()

// ================================================================ 父进程（判据）
async function main() {
  const stamp = `${Date.now()}-${process.pid}`
  const evidence = path.join(REPO, 'audit-evidence', 'T12')
  fs.mkdirSync(evidence, { recursive: true })
  fs.mkdirSync('E:/Temp', { recursive: true })
  let temp
  try {
    temp = fs.mkdtempSync(`E:/Temp/whale-T12-${stamp}-`)
  } catch (e) {
    h.block(`临时夹具环境不可用（E:/Temp 建不出来）：${String(e?.message ?? e).replace(/\s+/g, ' ')}`)
    process.exitCode = h.run()
    return
  }
  h.note(`fixture=${temp}\ntxn=${path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs')}`)
  // 清理守卫用"跑前/跑后不变"而不是"绝对不存在"：并行执行者可能有自己的临时态，别把别人的痕迹算成我们写的
  const protocolBefore = {
    repo: [fs.existsSync(path.join(REPO, '.whale-txn')), fs.existsSync(path.join(REPO, '.whale-write.lock'))],
    live: [fs.existsSync(path.join(LIVE_PACK, '.whale-txn')), fs.existsSync(path.join(LIVE_PACK, '.whale-write.lock'))],
  }

  const fixture = (name, initialLedger = null) => {
    const dir = path.join(temp, name)
    fs.mkdirSync(dir, { recursive: true })
    if (initialLedger !== null) {
      fs.mkdirSync(path.dirname(evidencePath(dir)), { recursive: true })
      fs.writeFileSync(evidencePath(dir), initialLedger, 'utf8')
    }
    return dir
  }
  const ledgerOf = (root) => {
    const p = evidencePath(root)
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null
  }
  const dirSnapshot = (dir) => {
    const rows = []
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(d, e.name), r)
        else rows.push(`${r}\t${sha(path.join(d, e.name))}`)
      }
    }
    walk(dir, '')
    return rows.join('\n')
  }
  const txnDirs = (root) => {
    const p = path.join(root, '.whale-txn')
    return fs.existsSync(p) ? fs.readdirSync(p).sort() : []
  }
  const lockExists = (root) => fs.existsSync(path.join(root, '.whale-write.lock'))
  const caseEvidence = (name, payload) => h.evidence(path.join('cases', `${name}.txt`),
    clip(typeof payload === 'string' ? payload : json(payload), 20000))

  /** 确定性 IO 注入（只改测试夹具的 fs 替身，产品文件不动） */
  const wrapFs = ({ stage, code = 'EACCES', always = false }) => {
    const real = fs
    let fired = 0
    const boom = (where) => {
      fired += 1
      if (!always && fired !== 1) return
      const e = new Error(`injected ${code} at ${where}`)
      e.code = code
      throw e
    }
    return {
      ...real,
      writeFileSync: (p, d, o) => {
        const s = String(p)
        if (stage === 'write-temp' && /evidence\.jsonl\.tmp-txn-/.test(s)) boom('write-temp')
        else if (stage === 'write-journal' && /journal\.json(\.tmp-|$)/.test(s)) boom('write-journal')
        return real.writeFileSync(p, d, o)
      },
      renameSync: (a, b) => {
        const sb = String(b)
        if (stage === 'rename-target' && sb.endsWith('evidence.jsonl')) boom('rename-target')
        else if (stage === 'write-journal' && sb.endsWith('journal.json')) boom('write-journal')
        return real.renameSync(a, b)
      },
    }
  }

  /** 两个子进程各追加 n 条（跨进程真并发）；返回两边的 report */
  const spawnWorker = (args, timeoutMs = 180000) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...args], { cwd: REPO, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, timeoutMs)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, pid: child.pid }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, pid: child.pid, error: String(e?.message ?? e) }) })
  })

  const facts = {
    dirs: [], files: [], classes: [], annotations: [], endpoints: [],
    configKeys: [], configValues: [], pomDependencies: [],
  }
  const chs = [
    { no: 1, deliverable: 'd1', auto: false, hint: 'h1', minEvidence: 'test' },
    { no: 2, deliverable: 'd2', auto: false, hint: 'h2' },
  ]

  try {
    /* ─────────────────────────────────────────────── ① 读侧五态 ── */
    h.case('T12-read-enoent', 'pass', () => {
      const root = fixture('read-missing')
      const r = readEvidence(root)
      h.eq(r.status, 'missing', '真 ENOENT → missing')
      h.eq(r.exists, false, 'exists:false')
      h.eq(r.errorCode, 'ENOENT', 'errorCode=ENOENT')
      h.eq(r.entries.length, 0, 'entries 空')
      h.eq(r.problems.length, 0, 'problems 空（不是 IO 错误）')
      caseEvidence('read-missing', r)
    })

    h.case('T12-read-empty', 'pass', () => {
      const root = fixture('read-empty', '')
      const r = readEvidence(root)
      h.eq(r.status, 'empty', '空文件 → empty（存在但零条）')
      h.eq(r.exists, true, 'exists:true')
      h.eq(r.entries.length, 0, 'entries 空')
      h.eq(r.problems.length, 0, '空账不是 IO 错误（problems 空）')
      // 只有空行也一样
      fs.writeFileSync(evidencePath(root), '\n\n  \n', 'utf8')
      h.eq(readEvidence(root).status, 'empty', '只有空行 → 仍 empty')
      caseEvidence('read-empty', { empty: r, blank: readEvidence(root) })
    })

    h.case('T12-read-invalid-jsonl', 'pass', () => {
      const root = fixture('read-invalid-jsonl', record('x/0001', 1, 'run') + '这不是JSON{{{\n')
      const r = readEvidence(root)
      h.eq(r.status, 'invalid', '坏 JSONL → invalid')
      h.eq(r.exists, true, 'exists:true')
      h.eq(r.entries.length, 1, '好行如实带回（不吞）')
      h.eq(r.problems.length, 1, '坏行如实进 problems')
      h.eq(/不是 JSON/.test(r.problems[0]), true, `problems 说清是坏 JSON：${r.problems[0]}`)
      caseEvidence('read-invalid-jsonl', r)
    })

    h.case('T12-read-invalid-record', 'pass', () => {
      // 合法 JSON、但记录不合规（challenge=0）：也是 invalid，不是 ok
      const root = fixture('read-invalid-record', JSON.stringify({ date: null, lesson: 'x/0001', challenge: 0, kind: 'run', ref: null, note: null }) + '\n')
      const r = readEvidence(root)
      h.eq(r.status, 'invalid', '坏记录 → invalid')
      h.eq(r.entries.length, 0, '坏记录不进 entries')
      h.eq(r.problems.some((p) => /challenge/.test(p)), true, `problems 点名字段：${r.problems.join('；')}`)
      caseEvidence('read-invalid-record', r)
    })

    h.case('T12-read-eisdir', 'pass', () => {
      const root = fixture('read-eisdir')
      fs.mkdirSync(evidencePath(root), { recursive: true }) // 路径是目录
      const r = readEvidence(root)
      h.eq(r.status, 'io-error', 'EISDIR → io-error（不是 missing）')
      h.eq(r.errorCode, 'EISDIR', `errorCode=EISDIR（实得 ${r.errorCode}）`)
      h.eq(r.exists, true, 'exists:true（路径上有东西）')
      h.eq(r.problems.length > 0, true, 'problems 里有读取故障说明')
      caseEvidence('read-eisdir', r)
    })

    h.case('T12-read-eacces-inject', 'pass', () => {
      const root = fixture('read-eacces', record('x/0001', 1, 'run'))
      // 确定性注入：EACCES 是真实权限环境的替代（本机 Windows chmod 不拦读 —— 见下一条）
      const fake = {
        readFileSync: () => {
          const e = new Error(`EACCES: permission denied, open '${evidencePath(root)}'`)
          e.code = 'EACCES'
          throw e
        },
      }
      const r = readEvidence(root, { fs: fake })
      h.eq(r.status, 'io-error', 'EACCES → io-error')
      h.eq(r.errorCode, 'EACCES', `errorCode=EACCES（实得 ${r.errorCode}）`)
      h.eq(r.entries.length, 0, '读不动时不编造 entries')
      h.eq(r.problems.some((p) => /EACCES/.test(p)), true, 'problems 带错误码')
      caseEvidence('read-eacces-inject', r)
    })

    h.case('T12-read-real-permission-boundary', 'pass', () => {
      // 真实权限环境测试：能跑就跑；本机 Windows 上 chmod 不拦同一用户读 —— 如实记录覆盖边界
      const root = fixture('read-real-perm', record('x/0001', 1, 'run'))
      const p = evidencePath(root)
      let enforced = null
      let err = null
      try {
        fs.chmodSync(p, 0o000)
        try { fs.readFileSync(p, 'utf8'); enforced = false } catch (e) { enforced = true; err = e.code }
      } finally {
        try { fs.chmodSync(p, 0o600) } catch { /* best effort */ }
      }
      h.note(`真实权限环境：chmod 000 后读取${enforced ? '被拒（EACCES 可真实复现）' : '仍成功（本账户/Windows 不拦）—— EACCES 覆盖依赖上面的确定性注入'}`)
      // 两种环境都算通过：断言"已如实判定"，不是断言平台一定拦
      h.eq(typeof enforced, 'boolean', '真实权限测试跑完并给出结论')
      caseEvidence('read-real-permission', { enforced, errorCode: err, file: p })
    })

    h.case('T12-read-legacy-fields', 'pass', () => {
      const root = fixture('read-legacy', record('x/0001', 1, 'run'))
      const r = readEvidence(root)
      for (const k of ['file', 'exists', 'entries', 'problems']) h.eq(k in r, true, `旧字段保留：${k}`)
      h.eq(r.file, evidencePath(root), 'file 是绝对路径')
      h.eq(r.status, 'ok', 'ok 台账 → status:ok')
      const miss = readEvidence(fixture('read-legacy-missing'))
      h.eq(miss.file, evidencePath(path.join(temp, 'read-legacy-missing')), 'missing 也带 file')
      caseEvidence('read-legacy', { ok: r, missing: miss })
    })

    /* ─────────────────────────────────────────────── ② 判定层：只有 missing 可回退 ── */
    h.case('T12-judge-missing-fallback', 'pass', () => {
      const A = judgeChallenges(facts, chs, { lesson: 'x/0001' }) // 没给 evidence = missing
      h.eq(A.evidenceStatus, 'missing', '缺省 evidence → missing')
      h.eq(A.evidenceFallback, true, 'missing → 回退（防死锁策略保留）')
      h.eq(A.evidenceBlocked.length, 0, 'missing 不产生阻断')
      h.eq(A.needsReview, 2, '回退时两道题都走"需人工确认"（与今天同行为）')
      h.eq(A.challenges.find((c) => c.no === 1).evidence, null, '回退时不假装判过（evidence=null）')
      const B = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: readEvidence(fixture('judge-missing')) })
      h.eq(B.evidenceStatus, 'missing', '真实 ENOENT 也是 missing')
      h.eq(B.evidenceFallback, true, '真实 ENOENT 同样回退（唯一允许的放行）')
      caseEvidence('judge-missing', { noEvidence: A, enoent: B })
    })

    h.case('T12-judge-empty-blocked', 'pass', () => {
      const root = fixture('judge-empty', '')
      const E = readEvidence(root)
      const D = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: E })
      h.eq(D.evidenceStatus, 'empty', '空账 → empty')
      h.eq(D.evidenceFallback, false, '空账**不许**回退')
      h.eq(D.evidenceBlocked.join(','), '1', '声明 minEvidence 的第 1 题被阻断')
      h.eq(D.evidenceGaps.length, 1, '逐条列缺口')
      h.eq(D.evidenceGaps[0].min, 'test', '缺口带 min')
      h.eq(D.evidenceGaps[0].status, 'empty', '缺口带 status（空账 = 明确不足）')
      h.eq(/还没有贴过证据/.test(D.evidenceGaps[0].hint), true, `回执说清没贴过：${D.evidenceGaps[0].hint}`)
      h.eq(/空账是明确不足/.test(D.evidenceGaps[0].hint), true, '回执说清空账 ≠ 没有台账')
      h.eq(D.challenges.find((c) => c.no === 1).needsReview, false, '被阻断的题不进 needsReview')
      h.eq(D.challenges.find((c) => c.no === 2).needsReview, true, '没声明 minEvidence 的题不受影响')
      caseEvidence('judge-empty', D)
    })

    h.case('T12-judge-invalid-blocked', 'pass', () => {
      const root = fixture('judge-invalid', record('x/0001', 1, 'run') + '坏行{{{\n')
      const E = readEvidence(root)
      const D = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: E })
      h.eq(D.evidenceStatus, 'invalid', '坏账 → invalid')
      h.eq(D.evidenceFallback, false, '坏账**不许**回退')
      h.eq(D.evidenceBlocked.join(','), '1', '坏账阻断声明 minEvidence 的题')
      h.eq(/损坏/.test(D.evidenceGaps[0].hint) && /不能当作/.test(D.evidenceGaps[0].hint), true,
        `回执说清"坏账读不出可信证据"：${D.evidenceGaps[0].hint}`)
      h.eq(D.challenges.find((c) => c.no === 1).evidence.status, 'invalid', '快照里的 evidence 带 status')
      caseEvidence('judge-invalid', D)
    })

    h.case('T12-judge-ioerr-blocked', 'pass', () => {
      const root = fixture('judge-ioerr')
      fs.mkdirSync(evidencePath(root), { recursive: true })
      const E = readEvidence(root)
      const D = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: E })
      h.eq(D.evidenceStatus, 'io-error', 'EISDIR → io-error')
      h.eq(D.evidenceFallback, false, '读取故障**不许**回退')
      h.eq(D.evidenceBlocked.join(','), '1', '读取故障阻断声明 minEvidence 的题')
      h.eq(/读取故障/.test(D.evidenceGaps[0].hint) && /EISDIR/.test(D.evidenceGaps[0].hint), true,
        `回执说清是读取故障（不是没贴过）：${D.evidenceGaps[0].hint}`)
      h.eq(D.evidenceGaps[0].errorCode, 'EISDIR', '缺口带 errorCode')
      caseEvidence('judge-ioerr', D)
    })

    h.case('T12-judge-ok-passes', 'pass', () => {
      const root = fixture('judge-ok', record('x/0001', 1, 'run'))
      const E = readEvidence(root)
      const D = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: E })
      h.eq(D.evidenceStatus, 'ok', '好账 → ok')
      h.eq(D.evidenceBlocked.length, 0, '够档 → 不阻断')
      h.eq(D.challenges.find((c) => c.no === 1).evidence.ok, true, '第 1 题证据够档')
      h.eq(D.challenges.find((c) => c.no === 1).evidence.hint, '', '够档时不带"还差一档"')
      h.eq(D.challenges.find((c) => c.no === 1).needsReview, true, '够档 ≠ 机器判过（仍需人工确认）')
      caseEvidence('judge-ok', D)
    })

    h.case('T12-judge-legacy-shapes', 'pass', () => {
      // 旧调用方只给 {exists, entries, problems}：兼容推断必须与五态同义
      const A = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: { exists: false, entries: [], problems: [] } })
      h.eq(A.evidenceStatus, 'missing', '旧形状 exists:false → missing')
      h.eq(A.evidenceFallback, true, '旧形状 missing 仍回退')
      const B = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: { exists: true, entries: [], problems: [] } })
      h.eq(B.evidenceStatus, 'empty', '旧形状 exists:true + 零条 → empty')
      h.eq(B.evidenceBlocked.join(','), '1', '旧形状空账 → 阻断（不是回退）')
      const C = judgeChallenges(facts, chs, {
        lesson: 'x/0001',
        evidence: { exists: true, problems: ['第 1 行不是 JSON'], entries: [{ lesson: 'x/0001', challenge: 1, kind: 'run' }] },
      })
      h.eq(C.evidenceStatus, 'invalid', '旧形状有 problems → invalid')
      h.eq(C.evidenceBlocked.join(','), '1', '旧形状坏账 → 阻断（好行也不能吞掉坏账）')
      caseEvidence('judge-legacy', { A, B, C })
    })

    /* ─────────────────────────────────────────────── ③ 传播：probeState → 快照 → 门禁 ── */
    const makePack = (name, ledger) => {
      const root = path.join(temp, name)
      fs.mkdirSync(path.join(root, 'code', 'demo', 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'code', 'demo', 'pom.xml'), '<project>\n  <artifactId>demo</artifactId>\n</project>\n', 'utf8')
      fs.writeFileSync(path.join(root, 'code', 'demo', 'EXPECT.json'), json({
        lessons: [{
          id: 'demo/0001',
          title: '证据读取故障',
          required: [{ id: 'r', kind: 'dir', value: 'src', hint: '要有 src' }],
          challenges: [{ no: 1, deliverable: '讲清楚为什么', auto: false, hint: '机器判不了', minEvidence: 'run' }],
        }],
      }) + '\n', 'utf8')
      fs.mkdirSync(path.dirname(evidencePath(root)), { recursive: true })
      if (ledger === 'DIR') fs.mkdirSync(evidencePath(root), { recursive: true })
      else fs.writeFileSync(evidencePath(root), ledger, 'utf8')
      return root
    }
    const packStub = { lessons: [{ point: 'demo', number: 1, id: 'demo/0001', learned: false }] }
    const lessonOf = (state) => (state.projects || []).flatMap((p) => p.lessons || []).find((l) => l.id === 'demo/0001')

    h.case('T12-propagate-probe-invalid', 'pass', () => {
      const root = makePack('prop-invalid', record('demo/0001', 1, 'run') + '坏行{{{\n')
      const { state, warnings } = probeState(root, {})
      const l = lessonOf(state)
      h.eq(Boolean(l), true, '快照里有 demo/0001')
      h.eq(l.evidenceStatus, 'invalid', '快照记下台账五态')
      h.eq(l.evidenceFallback, false, '坏账不进回退')
      h.eq(l.evidenceGaps.length, 1, '快照里逐条列证据阻断')
      h.eq(l.challenges.find((c) => c.no === 1).evidence.ok, false, '挑战判词是"证据不够"')
      h.eq(warnings.some((w) => /证据台账/.test(w) && /阻断/.test(w)), true, `探针 warnings 说出坏账：${warnings.filter((w) => /证据台账/.test(w)).join('；')}`)
      writeState(root, state)
      caseEvidence('prop-invalid', { lesson: l, warnings })
    })

    h.case('T12-propagate-gate-broken', 'pass', () => {
      const root = makePack('prop-gate', 'DIR') // EISDIR
      const { state } = probeState(root, {})
      writeState(root, state)
      const doc = readSnapshot(root)
      h.eq(Boolean(doc), true, '快照写出来了')
      const gate = challengeGate({ root, pack: packStub, point: 'demo', probe: false })
      h.eq(gate.allowed, false, '读不动 → 门禁**拒绝**（不是放行）')
      h.eq(gate.code, 'evidence-insufficient', `判词 code=${gate.code}`)
      h.eq(gate.evidenceStatus, 'io-error', '门禁回执带台账五态')
      h.eq(/坏账|读不动/.test(gate.hint || ''), true, `修法指向"先修台账"：${gate.hint}`)
      h.eq((gate.evidenceGaps || []).length, 1, '门禁逐条列缺口')
      // 对照：missing 时仍放行（防死锁策略没被取消）
      const root2 = makePack('prop-gate-missing', '')
      fs.rmSync(evidencePath(root2), { force: true })
      const s2 = probeState(root2, {}).state
      writeState(root2, s2)
      const gate2 = challengeGate({ root: root2, pack: packStub, point: 'demo', probe: false })
      h.eq(gate2.allowed, true, '台账真的不存在 → 仍放行（既有防死锁策略）')
      h.eq(gate2.evidenceFallback, true, '并如实回执 evidenceFallback')
      caseEvidence('prop-gate', { broken: gate, missing: gate2 })
    })

    h.case('T12-propagate-gate-stale-ledger', 'pass', () => {
      // 证据台账**不在** sourceDigest 里：快照"新鲜"但台账在之后坏掉 → 门禁必须现读、拦下
      const root = makePack('prop-stale', record('demo/0001', 1, 'run'))
      const s0 = probeState(root, {}).state
      writeState(root, s0)
      const before = challengeGate({ root, pack: packStub, point: 'demo', probe: false })
      h.eq(before.allowed, true, '前置：台账好、证据够档 → 放行')
      // 快照之后把台账写坏（sourceDigest 只算学生代码树，所以快照仍然"新鲜"）
      fs.appendFileSync(evidencePath(root), '坏行{{{\n', 'utf8')
      const after = challengeGate({ root, pack: packStub, point: 'demo', probe: false })
      h.eq(after.allowed, false, '台账在快照之后坏掉 → 门禁**仍拦**（不拿旧判词放行）')
      h.eq(after.code, 'evidence-insufficient', `code=${after.code}`)
      h.eq(after.evidenceStatus, 'invalid', '门禁现读到 invalid')
      h.eq((after.evidenceGaps || []).some((g) => /损坏/.test(g.hint || '')), true, '缺口说清坏账')
      // 空账同理
      fs.writeFileSync(evidencePath(root), '', 'utf8')
      const emptyGate = challengeGate({ root, pack: packStub, point: 'demo', probe: false })
      h.eq(emptyGate.allowed, false, '台账被清空（空账）→ 门禁**仍拦**')
      h.eq(emptyGate.evidenceStatus, 'empty', '门禁现读到 empty')
      caseEvidence('prop-gate-stale', { before, after, emptyGate })
    })

    /* ─────────────────────────────────────────────── ④ append：正常 / 拒写 / 坏账 ── */
    h.case('T12-append-commit', 'pass', () => {
      const root = fixture('append-commit', record('x/0001', 1, 'test'))
      const before = ledgerOf(root)
      const r = appendEvidence(root, { lesson: 'x/0001', challenge: 2, kind: 'run', ref: 't12' })
      h.eq(r.ok, true, `追加成功（${r.error || ''}）`)
      h.eq(r.state, 'committed', '事务 committed')
      h.eq(r.reason, undefined, '成功时不带 reason')
      h.eq(typeof r.txnId, 'string', '回执带 txnId')
      const after = ledgerOf(root)
      h.eq(after.startsWith(before), true, '**已有前缀字节不变**（append-only）')
      h.eq(after.trim().split(/\r?\n/).length, 2, '两条')
      h.eq(readEvidence(root).status, 'ok', '读回 status:ok')
      h.eq(lockExists(root), false, '提交后不留锁')
      h.eq(txnDirs(root).length, 0, '提交后不留日志')
      // 结尾没换行的旧台账：补一条不粘行
      const root2 = fixture('append-nonewline', JSON.stringify({ date: null, lesson: 'x/0001', challenge: 1, kind: 'run', ref: null, note: null }))
      const w = appendEvidence(root2, { lesson: 'x/0002', challenge: 1, kind: 'test' })
      h.eq(w.ok, true, '旧台账结尾没换行也能追加')
      h.eq(readEvidence(root2).entries.length, 2, '两条都读得出来（没粘行）')
      caseEvidence('append-commit', { r, after, nonewline: w })
    })

    h.case('T12-append-reject-no-write', 'pass', () => {
      const root = fixture('append-reject', record('x/0001', 1, 'test'))
      const before = dirSnapshot(root)
      const bad = appendEvidence(root, { lesson: 'x/0001', challenge: 1, kind: 'nope' })
      h.eq(bad.ok, false, '坏档位 → 拒')
      h.eq(bad.reason, 'rejected', 'reason=rejected（请求的错，不是 IO）')
      h.eq(dirSnapshot(root), before, '被拒时**一个字节都没写**（含锁与日志）')
      const bad2 = appendEvidence(root, { lesson: 'x', challenge: 1, kind: 'run' })
      h.eq(bad2.ok, false, '坏 lesson → 拒')
      h.eq(dirSnapshot(root), before, '第二个拒写也没有副作用')
      caseEvidence('append-reject', { bad, bad2 })
    })

    h.case('T12-append-refuse-corrupt', 'pass', () => {
      const root = fixture('append-corrupt', record('x/0001', 1, 'test') + '坏行{{{\n')
      const before = ledgerOf(root)
      const r = appendEvidence(root, { lesson: 'x/0001', challenge: 2, kind: 'run' })
      h.eq(r.ok, false, '坏账上拒绝追加')
      h.eq(r.reason, 'io', 'reason=io')
      h.eq(r.state, 'rejected', 'state=rejected')
      h.eq(/坏记录/.test(r.error || ''), true, `说清为什么：${r.error}`)
      h.eq(ledgerOf(root), before, '坏账一个字节都没动')
      h.eq(lockExists(root), false, '没有留锁')
      caseEvidence('append-corrupt', r)
    })

    /* ─────────────────────────────────────────────── ⑤ append 的 T09 故障矩阵 ── */
    h.case('T12-append-fault-matrix', 'pass', () => {
      const rows = []
      for (const [stage, code] of [['write-temp', 'EACCES'], ['write-journal', 'ENOSPC'], ['rename-target', 'EACCES']]) {
        const root = fixture(`fault-${stage}`, record('x/0001', 1, 'test'))
        const before = dirSnapshot(root)
        const r = appendEvidence(root, { lesson: 'x/0001', challenge: 2, kind: 'run' }, { fs: wrapFs({ stage, code }) })
        rows.push({ stage, code, result: r, ledger: ledgerOf(root) })
        h.eq(r.ok, false, `${stage}/${code}：不是成功`)
        h.eq(r.state, 'rolled-back', `${stage}/${code}：state=${r.state}（error=${r.error}）`)
        h.eq(/EACCES|ENOSPC/.test(String(r.error)), true, `${stage}/${code}：错误里如实带码`)
        h.eq(dirSnapshot(root), before, `${stage}/${code}：目录逐字节回到写前（锁与日志都不留）`)
        h.eq(lockExists(root), false, `${stage}/${code}：回滚成功要放锁`)
        h.eq(txnDirs(root).length, 0, `${stage}/${code}：回滚成功要清日志`)
      }
      caseEvidence('append-fault-matrix', rows)
    })

    h.case('T12-append-rollback-failure-recover', 'pass', () => {
      const root = fixture('rollback-failure', record('x/0001', 1, 'test'))
      const before = ledgerOf(root)
      const r = appendEvidence(root, { lesson: 'x/0001', challenge: 2, kind: 'run' },
        { fs: wrapFs({ stage: 'rename-target', code: 'EACCES', always: true }) })
      h.eq(r.ok, false, '回滚失败 → 不是成功')
      h.eq(r.state, 'recovery-required', `state=${r.state}（error=${r.error}）`)
      h.eq(typeof r.rollbackError === 'string' && r.rollbackError.length > 0, true, `rollbackError 如实给出：${r.rollbackError}`)
      h.eq(ledgerOf(root), before, '目标仍在写前（没有半提交）')
      h.eq(lockExists(root), true, '回滚失败**不许放锁**')
      h.eq(txnDirs(root).length, 1, '回滚失败必须保留日志')
      const j = JSON.parse(fs.readFileSync(path.join(root, '.whale-txn', txnDirs(root)[0], 'journal.json'), 'utf8'))
      h.eq(j.schema, 'whale-txn/1', 'journal schema')
      h.eq(j.state, 'recovery-required', 'journal 状态')
      // 下一次普通写被拒（T09 口径）
      const refused = appendEvidence(root, { lesson: 'x/0001', challenge: 3, kind: 'run' })
      h.eq(refused.ok, false, '下一次普通写被拒')
      h.eq(refused.state, 'recovery-required', '拒绝理由是"还有待恢复的日志"')
      h.eq(ledgerOf(root), before, '被拒的写没有副作用')
      // 离线恢复 → 再写
      const rec = TXN.recoverPack(root, { offline: true, confirm: true, ownerToken: 'executor-t12' })
      h.eq(rec.ok, true, `离线恢复成功（${rec.error || ''}）`)
      h.eq(ledgerOf(root), before, '恢复后 = 原状态')
      h.eq(lockExists(root), false, '恢复后放锁')
      h.eq(txnDirs(root).length, 0, '恢复后清日志')
      const again = appendEvidence(root, { lesson: 'x/0001', challenge: 3, kind: 'run' })
      h.eq(again.ok, true, `恢复后普通写放行（${again.error || ''}）`)
      h.eq(readEvidence(root).entries.length, 2, '新写生效')
      caseEvidence('rollback-failure', { r, refused, rec, again, journal: j })
    })

    /* ─────────────────────────────────────────────── ⑥ 双进程并发（100 × 2） ── */
    let concurrent = null
    try {
      const root = fixture('concurrent')
      const reports = [0, 1].map((w) => path.join(temp, `concurrent-w${w}.json`))
      const [a, b] = await Promise.all([0, 1].map((w) => spawnWorker([
        '--mode=append-worker', `--root=${root}`, `--report=${reports[w]}`, `--writer=${w}`, '--n=100',
      ])))
      const docs = reports.map((p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null))
      const rows = (ledgerOf(root) ?? '').split(/\r?\n/).filter((s) => s.trim()).map((s) => JSON.parse(s))
      concurrent = { exit: [a.code, b.code], signal: [a.signal, b.signal], docs, rows, lock: lockExists(root), txnDirs: txnDirs(root) }
    } catch (e) {
      concurrent = { error: String(e?.stack ?? e) }
    }
    h.case('T12-append-concurrent-200', 'pass', () => {
      if (concurrent.error) throw new Error(`并发夹具异常：${concurrent.error}`)
      h.eq(concurrent.exit[0], 0, `writer0 退出码（signal=${concurrent.signal[0]}）`)
      h.eq(concurrent.exit[1], 0, `writer1 退出码（signal=${concurrent.signal[1]}）`)
      h.eq(concurrent.docs[0]?.done, 100, `writer0 写了 100 条（failed=${JSON.stringify(concurrent.docs[0]?.failed)}）`)
      h.eq(concurrent.docs[1]?.done, 100, `writer1 写了 100 条（failed=${JSON.stringify(concurrent.docs[1]?.failed)}）`)
      h.eq(concurrent.rows.length, 200, '台账里**全部 200 条**都在（一条都没被覆盖）')
      h.eq(new Set(concurrent.rows.map((r) => r.ref)).size, 200, '每条操作标识唯一')
      h.eq(new Set(concurrent.rows.map((r) => `${r.lesson}/${r.challenge}/${r.kind}`)).size, 1, '每条记录仍是同一条证据形状')
      h.eq(concurrent.rows.every((r) => r.lesson === 'x/0001' && r.challenge === 1 && r.kind === 'run'), true, '没有串写/错写')
      h.eq(readEvidence(path.join(temp, 'concurrent')).status, 'ok', '读回来是 ok')
      h.eq(concurrent.lock, false, '跑完不留锁')
      h.eq(concurrent.txnDirs.length, 0, '跑完不留日志')
      caseEvidence('concurrent', {
        exit: concurrent.exit, signal: concurrent.signal,
        writers: concurrent.docs.map((d) => ({ done: d?.done, failed: d?.failed?.length, maxAttempts: d?.maxAttempts, crash: d?.crash })),
        records: concurrent.rows.length, uniqueRef: new Set(concurrent.rows.map((r) => r.ref)).size,
      })
    })

    /* ─────────────────────────────────────────────── ⑦ 进程中断（真杀）+ 离线恢复 ── */
    let killed = null
    try {
      const root = fixture('kill', record('x/0001', 1, 'test'))
      const before = ledgerOf(root)
      const marker = path.join(temp, 'kill.marker')
      const report = path.join(temp, 'kill.report.json')
      const res = await spawnWorker(['--mode=append-kill', `--root=${root}`, `--marker=${marker}`, `--report=${report}`], 60000)
      const dirs = txnDirs(root)
      const journal = (() => {
        if (dirs.length !== 1) return null
        const p = path.join(root, '.whale-txn', dirs[0], 'journal.json')
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { journalMissing: true, entries: fs.readdirSync(path.join(root, '.whale-txn', dirs[0])) }
      })()
      const atCrash = { ledger: ledgerOf(root), lock: lockExists(root), dirs, journal, marker: fs.existsSync(marker), report: fs.existsSync(report) }
      const rec = TXN.recoverPack(root, { offline: true, confirm: true, ownerToken: 'executor-t12-kill' })
      const after = ledgerOf(root)
      const again = appendEvidence(root, { lesson: 'x/0001', challenge: 2, kind: 'run' })
      killed = { res, before, atCrash, rec, after, again, lockAfter: lockExists(root), dirsAfter: txnDirs(root) }
    } catch (e) {
      killed = { error: String(e?.stack ?? e) }
    }
    h.case('T12-append-kill-recover', 'pass', () => {
      if (killed.error) throw new Error(`中断夹具异常：${killed.error}`)
      h.eq(killed.res.code === 0, false, `写进程必须**真的被杀**（exit=${killed.res.code} signal=${killed.res.signal}）`)
      h.eq(killed.atCrash.marker, true, '杀点确实走到了（marker 在）')
      h.eq(killed.atCrash.report, false, '被杀进程没来得及写 report（真中断，不是桩）')
      h.eq(killed.atCrash.dirs.length, 1, `中断必须留下日志残骸（实得 ${killed.atCrash.dirs.length} 个）`)
      h.eq(killed.atCrash.lock, true, '中断那一刻锁还在（下一次普通写会被拒）')
      h.eq(killed.atCrash.ledger, killed.before, '中断时刻台账仍是原状态（原子落位之前）')
      h.eq(killed.atCrash.journal && (killed.atCrash.journal.journalMissing === true || killed.atCrash.journal.schema === 'whale-txn/1'), true,
        `残骸要么是还没写 journal 的暂存件、要么是 whale-txn/1：${json(killed.atCrash.journal)}`)
      h.eq(killed.rec.ok, true, `离线恢复成功（${killed.rec.error || ''}）`)
      h.eq(killed.after, killed.before, '恢复后 = 原状态')
      h.eq(killed.lockAfter, false, '恢复后放锁')
      h.eq(killed.dirsAfter.length, 0, '恢复后清日志')
      h.eq(killed.again.ok, true, `恢复后普通写放行（${killed.again.error || ''}）`)
      caseEvidence('kill-recover', {
        exit: killed.res.code, signal: killed.res.signal, atCrash: killed.atCrash,
        recover: killed.rec, ledgerAfter: killed.after, again: killed.again,
      })
    })

    /* ─────────────────────────────────────────────── ⑧ 负向控制（基线实现真的会放行） ── */
    let negative = null
    try {
      const baseDir = path.join(temp, 'baseline-lib')
      fs.mkdirSync(baseDir, { recursive: true })
      // 基线是 ESM：临时目录没有 package.json 时 .js 会被当 CJS 加载 —— 显式标成 module
      fs.writeFileSync(path.join(baseDir, 'package.json'), '{"type":"module"}\n', 'utf8')
      // 基线 state.js 的导入闭包：fingerprint / evidence / pack-model / exec / text / plan
      for (const f of ['fingerprint.js', 'evidence.js', 'pack-model.js', 'exec.js', 'text.js', 'plan.js']) {
        fs.copyFileSync(path.join(REPO, 'lib', f), path.join(baseDir, f))
      }
      for (const f of ['state.js', 'evidence-io.js']) {
        const r = spawnSync('git', ['-C', REPO, 'show', `${BASE_COMMIT}:lib/${f}`], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
        if (r.status !== 0) throw new Error(`git show ${BASE_COMMIT}:lib/${f} 失败（exit=${r.status}）：${String(r.stderr || '').slice(0, 200)}`)
        fs.writeFileSync(path.join(baseDir, f), r.stdout, 'utf8')
      }
      const baseState = await import(pathToFileURL(path.join(baseDir, 'state.js')).href)
      const baseIo = await import(pathToFileURL(path.join(baseDir, 'evidence-io.js')).href)
      // ① EISDIR：旧 readEvidence 把读取故障当"不存在"
      const dirRoot = fixture('baseline-eisdir')
      fs.mkdirSync(evidencePath(dirRoot), { recursive: true })
      const oldRead = baseIo.readEvidence(dirRoot)
      const oldJudge = baseState.judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: oldRead })
      const newRead = readEvidence(dirRoot)
      const newJudge = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: newRead })
      // ② 坏账 + 一条好证据：旧实现仍按好行判过；新实现阻断
      const badRoot = fixture('baseline-corrupt', record('x/0001', 1, 'run') + '坏行{{{\n')
      const oldBadRead = baseIo.readEvidence(badRoot)
      const oldBadJudge = baseState.judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: oldBadRead })
      const newBadRead = readEvidence(badRoot)
      const newBadJudge = judgeChallenges(facts, chs, { lesson: 'x/0001', evidence: newBadRead })
      negative = {
        eisdir: { oldRead, oldJudge, newRead, newJudge },
        corrupt: { oldRead: oldBadRead, oldJudge: oldBadJudge, newBadRead, newBadJudge },
      }
    } catch (e) {
      negative = { error: String(e?.stack ?? e) }
    }
    h.case('T12-negative-baseline', 'pass', () => {
      if (negative.error) throw new Error(`负向控制夹具异常：${negative.error}`)
      const { eisdir: a, corrupt: b } = negative
      h.eq(a.oldRead.exists, false, '负向控制：旧 readEvidence 把 EISDIR 报成 exists:false')
      h.eq(a.oldJudge.evidenceFallback, true, '负向控制：旧 judgeChallenges **回退放行**（fallback:true）')
      h.eq(a.oldJudge.evidenceBlocked.length, 0, '负向控制：旧实现**不阻断**（这正是 C02 的漏洞）')
      h.eq(a.newRead.status, 'io-error', '新读法：EISDIR → io-error')
      h.eq(a.newJudge.evidenceBlocked.join(','), '1', '新判定：明确阻断')
      h.eq(b.oldRead.problems.length > 0, true, '负向控制：旧读法也看得见 problems')
      h.eq(b.oldJudge.evidenceBlocked.length, 0, '负向控制：旧判定却**吞掉坏行**、按好行判过')
      h.eq(b.newBadRead.status, 'invalid', '新读法：坏账 → invalid')
      h.eq(b.newBadJudge.evidenceBlocked.join(','), '1', '新判定：坏账 → 阻断，不吞坏行')
      caseEvidence('negative-baseline', negative)
    })

    /* ─────────────────────────────────────────────── ⑨ 清理守卫（最后一条） ── */
    h.case('T12-cleanup-guard', 'pass', () => {
      const abs = path.resolve(temp)
      h.eq(path.dirname(abs).toLowerCase(), path.resolve('E:/Temp').toLowerCase(), `夹具在 E:/Temp 下：${abs}`)
      h.eq(path.basename(abs).startsWith(`whale-T12-${stamp}-`), true, `夹具名带本次 runId：${path.basename(abs)}`)
      const repoNow = [fs.existsSync(path.join(REPO, '.whale-txn')), fs.existsSync(path.join(REPO, '.whale-write.lock'))]
      const liveNow = [fs.existsSync(path.join(LIVE_PACK, '.whale-txn')), fs.existsSync(path.join(LIVE_PACK, '.whale-write.lock'))]
      h.eq(repoNow.join(','), protocolBefore.repo.join(','), '工作仓里的协议落点与跑前一致（没被写进 .whale-txn / .whale-write.lock）')
      h.eq(liveNow.join(','), protocolBefore.live.join(','), '用户活包的协议落点与跑前一致（没被写进 .whale-txn / .whale-write.lock）')
      fs.rmSync(abs, { recursive: true, force: true })
      h.eq(fs.existsSync(abs), false, '夹具已清理')
    })
  } catch (e) {
    h.note(`壳异常：${e?.stack ?? String(e)}`)
    h.case('T12-unexpected', 'pass', () => { throw e })
  }

  process.exitCode = h.run()
  // cases.jsonl 要能被机器直接 JSON.parse（harness 默认写 BOM 的是给人看的文本）
  const casesFile = path.join(evidence, 'cases.jsonl')
  if (fs.existsSync(casesFile)) fs.writeFileSync(casesFile, fs.readFileSync(casesFile, 'utf8').replace(/^\uFEFF/, ''), 'utf8')
}
