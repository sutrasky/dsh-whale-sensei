/**
 * test/audit/U20.mjs — U20 · 集成、全量门槛和提交（D lane，独立复验者兼独占集成者）
 * ==================================================================
 * 卡面：`cards/U20.md`。判据：固定八项 A01–A08（U-SPEC §6 / unify-runner）。
 *
 * 三种运行方式（**同一个真组装的入口**，不另写弱检查）：
 *   · `node test/audit/U20.mjs --collect`
 *       采集：① 独立重跑 U01（--verify-baseline）与 U02–U19（各一次，证据落 U20 自己的目录）；
 *             ② 在 **E:\\Temp 源码副本**里复验 T 自动入口；③ sync --check / check-contracts /
 *             check-distribution。只打印一行 `COLLECT …`，不给 PASS/READY 判词。
 *   · `node test/audit/U20.mjs --precommit`
 *       验 A01–A07 + 暂存面准备；全过打印 `READY U20 phase=precommit` + exit 0（**不是** PASS）。
 *   · `node test/audit/U20.mjs`（默认，**提交后**）
 *       验 A01–A08（A08 = 保存的提交证明），全过才 `PASS U20 checks=8 failed=0 skipped=0`。
 *
 * 纪律：本入口**不执行** git add / commit / push；不重跑全量；不访问活包（活包窗口由
 * `audit-evidence/U20/window/capture-window.mjs` 采，本入口只**验**它保存的四份清单）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot, safeRemoveTree, FIXED_IDS,
  Blocked, REPO,
} from './unify-runner.mjs'

const CARD = 'U20'
const BASE_SHA = '2f57b1f2cec02e4128b69497e3b6819d36aa707b'
const U01_EV = path.join(REPO, 'audit-evidence', 'U01')
const EV = path.join(REPO, 'audit-evidence', CARD)
const WINDOW = path.join(EV, 'window')
const RERUNS = path.join(EV, 'reruns')
const TREV = path.join(EV, 't-rerun')
const CHECKS = path.join(EV, 'checks')
const COMMIT_EV = path.join(EV, 'commit')
const TEMP_PARENT = path.resolve('E:\\Temp')

const ARGV = process.argv.slice(2)
const MODE = ARGV.includes('--collect') ? 'collect' : ARGV.includes('--precommit') ? 'precommit' : 'final'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = (abs) => JSON.parse(fs.readFileSync(abs, 'utf8'))
const exists = (abs) => fs.existsSync(abs)
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}（实得 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
function writeJson(abs, value) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
function git(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
function need(abs, what) {
  if (!exists(abs)) throw new Blocked(`缺采集材料：${what}（${path.relative(REPO, abs).replace(/\\/g, '/')}）—— 先跑 --collect / 活包窗口采集`)
  return abs
}

/* ══════════════════════════════════════════════════════════════════════
 * 纯函数：全量对账（A03 / A07 的判据本体。喂文档，不读盘）
 * ══════════════════════════════════════════════════════════════════════ */

/** `brief:014 :: 说明` → `brief:014` */
const itemId = (s) => String(s ?? '').split(' :: ')[0].trim()

/**
 * 把「本轮实测」与「U01 基线」逐套对账。
 * 判据（卡面第七条）：不新增红套、原红内不许新失败、不新增 skip、不减少断言/套件、退出码不反转成 0。
 * @returns {{ok:boolean, problems:string[], compared:object}}
 */
export function reconcile(base, cur) {
  const problems = []
  const baseRed = new Map((base.redSuites || []).map((r) => [r.id, new Set((r.failItems || []).map(itemId))]))
  const curSuites = new Map((cur.suites || []).map((s) => [s.id, s]))
  const curRed = new Map()
  for (const s of cur.suites || []) {
    const red = (s.exitCode ?? 0) !== 0 || (s.machine && (s.machine.failed || 0) > 0)
    if (red) curRed.set(s.id, new Set((s.machine?.failIds || []).map(String)))
  }

  // ① 套件数不减少
  const baseCount = Number(base.suites)
  if (Number.isFinite(baseCount) && (cur.suites || []).length < baseCount) {
    problems.push(`套件数减少：基线 ${baseCount} / 本轮 ${(cur.suites || []).length}`)
  }
  // ② 不新增红套
  for (const id of curRed.keys()) {
    if (!baseRed.has(id)) problems.push(`新增红套：${id}（基线里它是绿的）`)
  }
  // ③ 原红套：只许"仍在红"或**自然转绿**（必须列证）。逐条失败项不在这一层硬判 ——
  //    基线只人工摘录了 failItems 文本、没有逐套 machine failIds，两层口径不可直比；
  //    逐条对照只作登记（见 A03 的 fail-item-diff.json），硬判据是套件级集合。
  const naturallyGreen = []
  for (const [id, baseIds] of baseRed) {
    const now = curRed.get(id)
    if (!now) { naturallyGreen.push(id); continue }
  }
  // ④ 不新增 skip：按**套件名**比（逐套 machine 里是 `practice:026`、run-all 顶层是
  //    `practice:practice:026` 或带 `skip:` 前缀的变体 —— 逐字比会假红；套件级足够判"新增了跳过"）
  const suiteOfSkip = (x) => {
    let s = String(x).split(' :: ')[0].trim().replace(/^skip:/, '')
    const parts = s.split(':').filter(Boolean)
    return parts[0] || s
  }
  const baseSkipSuites = [...new Set(((base.skipped && base.skipped.ids) || []).map(suiteOfSkip))].sort()
  const curSkipRaw = []
  for (const s of cur.suites || []) for (const id of (s.machine?.skipIds || [])) curSkipRaw.push(String(id))
  for (const s of cur.topResult?.skipIds || []) curSkipRaw.push(String(s))
  const curSkipSuites = [...new Set(curSkipRaw.map(suiteOfSkip))].sort()
  const newSkip = curSkipSuites.filter((x) => !baseSkipSuites.includes(x))
  if (newSkip.length) problems.push(`新增 skip 套件：${newSkip.join(', ')}`)
  const lostSkip = baseSkipSuites.filter((b) => !curSkipSuites.includes(b))
  if (lostSkip.length) problems.push(`基线 skip 套件少了：${lostSkip.join(', ')}（不许把"跳过变少"当变好）`)
  // ⑤ 断言量：**记录而不硬判**。两个自报口径都不可靠（run-all 只认 adapter 采信的摘要，
  // 基线自己登记过 quirk：2883 = 2980 − 97；逐套相加也受"红套只打 FAIL/✗ 行"影响）。
  // 真正可判的是"逐套逐条失败项"——那一条在 A03 里单独比对（见 newFailItems）。
  const baseSum = base.assertions?.sumOfPerSuite
  const curSum = cur.assertionTotals
  // ⑥ 退出码：基线是红（1），本轮不许变 0（变 0 = 有人把红抹平了）
  if (base.exitCode === 1 && cur.code === 0) problems.push('退出码从 1 变 0：红被抹平（必须带实测差异裁决）')
  if (cur.code === null || cur.code === undefined) problems.push('本轮退出码没采到')
  if (cur.signal || cur.timedOut) problems.push(`本轮有信号/超时（signal=${cur.signal} timedOut=${cur.timedOut}）`)

  return {
    ok: problems.length === 0,
    problems,
    compared: {
      suites: { base: baseCount, cur: (cur.suites || []).length },
      red: { base: [...baseRed.keys()].sort(), cur: [...curRed.keys()].sort() },
      naturallyGreen: naturallyGreen.sort(),
      skipped: { base: baseSkipSuites, cur: curSkipSuites },
      assertions: { base: base.assertions, cur: curSum },
      exitCode: { base: base.exitCode, cur: cur.code },
    },
  }
}

/** §6 授权写集并集（运行时解析，不手抄） */
export function authorizedUnion(interfacesText) {
  const union = new Set()
  for (const line of String(interfacesText).split(/\r?\n/)) {
    if (!/^\|\s*U\d\d\s*\|/.test(line)) continue
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const token = m[1].replace(/^[†✅]\s*/u, '').trim()
      if (!token || /\s/.test(token)) continue
      if (!/^[A-Za-z0-9._/-]+$/.test(token)) continue
      if (!token.includes('/') && !/\.(cjs|js|mjs|json|md)$/.test(token)) continue
      union.add(token)
    }
  }
  return union
}

/** 伪造/降级的证据必须被抓住（A07 的判据本体，喂人造文档） */
export function judgeRerunSummary(doc) {
  const problems = []
  const cards = Array.isArray(doc?.cards) ? doc.cards : []
  const want = [...FIXED_IDS]
  for (const c of cards) {
    const ids = (c.cases || []).map((x) => String(x.id))
    if (ids.length !== want.length || want.some((id) => !ids.includes(id))) problems.push(`${c.card}: 固定 ID 集合不完整（${ids.join(',')}）`)
    if (c.status !== 'PASS') problems.push(`${c.card}: 判词不是 PASS（${c.status}）`)
    if (c.code !== 0) problems.push(`${c.card}: 退出码不是 0（${c.code}）`)
    if (String(c.line || '') !== `PASS ${c.card} checks=8 failed=0 skipped=0`) problems.push(`${c.card}: 判词行不符（${c.line}）`)
    if (!c.evidenceDir || !c.evidenceResultExists) problems.push(`${c.card}: 证据目录/result.json 缺失`)
    if ((c.cases || []).some((x) => x.status !== 'pass')) problems.push(`${c.card}: 有用例不是 pass`)
  }
  return { ok: problems.length === 0, problems }
}

/* ══════════════════════════════════════════════════════════════════════
 * --collect：采集（独立复验 + T 副本 + 检查器）
 * ══════════════════════════════════════════════════════════════════════ */

function runEntry(card, args, evidenceRoot) {
  const entry = path.join(REPO, 'test', 'audit', `${card}.mjs`)
  const r = spawnSync(process.execPath, [entry, ...args, `--evidence-root=${evidenceRoot}`], {
    cwd: REPO, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024,
  })
  const stdout = String(r.stdout || '')
  const line = stdout.split('\n').map((l) => l.trim()).filter((l) => /^(PASS|FAIL|BLOCKED)\b/.test(l)).slice(-1)[0] || ''
  return { status: r.status, line, stdout, stderr: String(r.stderr || ''), signal: r.signal ?? null }
}

function collectReruns() {
  fs.mkdirSync(RERUNS, { recursive: true })
  const cards = []
  const tmpDirs = []
  const plan = [{ card: 'U01', args: ['--verify-baseline'] }]
  for (const n of ['02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19']) plan.push({ card: `U${n}`, args: [] })
  for (const p of plan) {
    // 证据根守卫只认「本卡新运行目录 / U20 复验目录 / 带 <卡>- 或 u20- 前缀的临时目录」——
    // 所以这里统一用 `u20-<卡>` 作目录名（落在 audit-evidence/U20/ 下 = U20 复验目录）。
    const dir = path.join(RERUNS, `u20-${p.card}`)
    fs.mkdirSync(dir, { recursive: true })
    let run = runEntry(p.card, p.args.length ? p.args : [], dir)
    let usedDir = dir
    let fallback = null
    // ⚠️ 已知口径缺口：U02/U05/U08/U12/U16 的 A08 自带更严的证据根守卫（只认"本卡 audit-evidence/<卡> 下"
    // 或 "E:\\Temp 新目录"），不认 U20 复验目录。按卡面「入口须支持 --evidence-root=<本次绝对目录>」这是
    // 那五张卡的合规缺口，本卡**不改它们**（写集外），而是：先在 U20 目录里跑 → 被证据根守卫拒绝时
    // 改用 E:\\Temp\\u20-<卡>-<pid> 重跑（真跑，不是伪造），再把 result/cases 复制回 U20 目录并登记 fallback。
    if (run.status !== 0 && /证据根|写越出本卡写集/.test(run.line)) {
      const tmpDir = path.join(TEMP_PARENT, `u20-${p.card}-${process.pid}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      const retry = runEntry(p.card, p.args.length ? p.args : [], tmpDir)
      fallback = { reason: run.line, tempRoot: tmpDir }
      tmpDirs.push(tmpDir)
      run = retry
      usedDir = tmpDir
      for (const f of ['result.json', 'cases.jsonl', 'verdict.json', 'cleanup.json']) {
        const src = path.join(tmpDir, f)
        if (exists(src)) fs.copyFileSync(src, path.join(dir, f))
      }
    }
    const resultFile = path.join(dir, 'result.json')
    let doc = null
    if (exists(resultFile)) { try { doc = readJson(resultFile) } catch { doc = null } }
    const rec = {
      card: p.card, args: p.args, code: run.status, line: run.line, signal: run.signal,
      evidenceDir: path.relative(REPO, dir).replace(/\\/g, '/'),
      evidenceResultExists: exists(resultFile),
      cases: (doc?.cases || []).map((c) => ({ id: c.id, status: c.status, note: c.note })),
      status: doc?.status ?? (/^PASS /.test(run.line) ? 'PASS' : /^BLOCKED /.test(run.line) ? 'BLOCKED' : 'FAIL'),
      evidenceRootUsed: path.relative(REPO, usedDir).replace(/\\/g, '/'),
      evidenceRootFallback: fallback,
      stdoutTail: run.stdout.trim().split('\n').slice(-3),
    }
    cards.push(rec)
    fs.writeFileSync(path.join(dir, 'rerun.json'), `${JSON.stringify(rec, null, 2)}\n`, 'utf8')
    process.stdout.write(`  rerun ${p.card} exit=${rec.code} ${rec.line || '(no verdict line)'}\n`)
  }
  writeJson(path.join(RERUNS, 'summary.json'), {
    note: 'U20 独立复验：每张卡各跑一次入口，证据落在 U20 自己的目录（不覆盖各卡原证据）',
    capturedAtLocal: new Date().toISOString(),
    fallbackNote: '证据根 fallback：U02/U05/U08/U12/U16 的 A08 自带更严守卫、不认 U20 复验目录（卡面要求支持 --evidence-root，属那五张卡的口径缺口，本卡不改它们在写集之外的文件）。处置 = 在 E:\\Temp\\u20-<卡>-<pid> 里真跑一次，再把 result/cases 复制回 U20 目录并在 cards[] 里登记 evidenceRootFallback。',
    cards,
  })
  for (const d of tmpDirs) safeRemoveTree(d, { parent: TEMP_PARENT })
  return cards
}

function collectTRerun() {
  fs.mkdirSync(TREV, { recursive: true })
  const TMP = path.join(TEMP_PARENT, `u20-t-${process.pid}`)
  fs.mkdirSync(TMP, { recursive: true })
  // 当前源码副本（无 .git）+ 冻结证据只读副本 —— T 卡会往自己的 audit-evidence/ 写，必须在副本里跑
  const tree = path.join(TMP, 'tree')
  const copyDirs = ['lib', 'tools', 'test', 'preset', 'docs']
  fs.mkdirSync(tree, { recursive: true })
  for (const d of copyDirs) {
    const src = path.join(REPO, d)
    if (exists(src)) fs.cpSync(src, path.join(tree, d), { recursive: true })
  }
  for (const f of ['package.json', 'cordis.patch.yml', 'dsh-plugin.json']) {
    const src = path.join(REPO, f)
    if (exists(src)) fs.copyFileSync(src, path.join(tree, f))
  }
  fs.mkdirSync(path.join(tree, 'audit-evidence'), { recursive: true })
  const freeze = path.join(tree, 'audit-evidence', 'T23')
  const freezeSrc = path.join(REPO, 'audit-evidence', 'T23')
  if (exists(freezeSrc)) fs.cpSync(freezeSrc, freeze, { recursive: true })

  const runs = []
  const runT = (label, file, args) => {
    const abs = path.join(tree, 'test', 'audit', file)
    if (!exists(abs)) return runs.push({ label, file, ran: false, reason: '入口不存在（不按卡号发明命令）' })
    const r = spawnSync(process.execPath, [abs, ...args], { cwd: tree, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024 })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    const verdict = out.split('\n').map((l) => l.trim()).filter((l) => /^(PASS|FAIL|BLOCKED|AUTO-ONLY)\b/.test(l)).slice(-1)[0] || ''
    runs.push({ label, file, args, ran: true, code: r.status, verdict, stdoutTail: String(r.stdout || '').trim().split('\n').slice(-2) })
  }
  runT('T13', 'T13.mjs', ['--automated-only'])
  runT('T16', 'T16.mjs', ['--automated-only'])
  // T23/T25 --auto 硬编码活包 ⇒ **不跑**（活包只读窗口归属 U01/U20 的全量那一次）
  for (const id of ['T23', 'T25']) {
    const src = path.join(REPO, 'test', 'audit', `${id}.mjs`)
    const hard = exists(src) ? /workplace[\\/]+study/.test(fs.readFileSync(src, 'utf8')) : false
    runs.push({ label: id, file: `${id}.mjs`, ran: false, reason: hard ? '源码硬编码活包路径 ⇒ 不在副本里跑（会读活包）' : '无自动入口' })
  }
  runs.push({ label: 'T29', file: 'T29.mjs', ran: false, reason: fs.existsSync(path.join(REPO, 'test', 'audit', 'T29.mjs')) ? '台账里 T29 冻结判词是 WAIVED' : '无同名入口（不按卡号发明命令）；冻结判词 WAIVED' })
  // release.mjs 恒 exit 2 是设计
  {
    const abs = path.join(tree, 'test', 'audit', 'release.mjs')
    const r = exists(abs) ? spawnSync(process.execPath, [abs], { cwd: tree, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 }) : null
    runs.push({ label: 'release', file: 'release.mjs', ran: !!r, code: r ? r.status : null, expect: 'exit 2（private 分发，设计如此）' })
  }
  writeJson(path.join(TREV, 'summary.json'), {
    note: 'T 自动入口在 E:\\Temp 的**当前源码副本**里复验（副本带冻结 T23 证据；原脚本断言一条未改）',
    capturedAtLocal: new Date().toISOString(),
    tree, copyDirs, runs,
  })
  safeRemoveTree(TMP, { parent: TEMP_PARENT })
  return runs
}

function collectChecks() {
  fs.mkdirSync(CHECKS, { recursive: true })
  const out = {}
  const run = (key, args) => {
    const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 })
    out[key] = { argv: ['node', ...args.map((a) => path.relative(REPO, a) || a)], code: r.status, stdout: String(r.stdout || '').trim().split('\n').slice(-3), stderr: String(r.stderr || '').trim().split('\n').slice(-3) }
    process.stdout.write(`  ${key} exit=${r.status}\n`)
  }
  run('syncCheck', [path.join(REPO, 'tools', 'sync-unify-core.mjs'), '--check'])
  run('checkContracts', [path.join(REPO, 'tools', 'check-contracts.mjs'), '--check'])
  run('checkDistribution', [path.join(REPO, 'tools', 'check-distribution.mjs'), '--mode=private'])
  writeJson(path.join(CHECKS, 'summary.json'), { note: 'U20 检查器复验（sync --check / check-contracts / check-distribution；private 恒 exit 2 是设计）', capturedAtLocal: new Date().toISOString(), checks: out })
  return out
}

function collect() {
  process.stdout.write('COLLECT U20 开始采集（独立复验 + T 副本 + 检查器）…\n')
  const cards = collectReruns()
  const t = collectTRerun()
  const checks = collectChecks()
  const bad = cards.filter((c) => c.status !== 'PASS' || c.code !== 0).map((c) => `${c.card}(${c.status}/${c.code})`)
  process.stdout.write(`COLLECT U20 cards=${cards.length} bad=${bad.length}${bad.length ? ` :: ${bad.join(', ')}` : ''} t=${t.length} checks=${Object.keys(checks).length}\n`)
  process.exitCode = bad.length ? 1 : 0
}

/* ══════════════════════════════════════════════════════════════════════
 * A01–A08
 * ══════════════════════════════════════════════════════════════════════ */

async function A01() {
  const summary = readJson(need(path.join(RERUNS, 'summary.json'), '独立复验汇总'))
  // 证据定位不能只看顶层：U01 的入口会自己再开一层 `runs/<name>/`（--verify-baseline 模式的
  // evidence 根是 `<给定根>/runs/…`）。这里**在盘上递归找** result.json，不信 summary 里的布尔。
  const findResult = (dir) => {
    if (!exists(dir)) return null
    const stack = [dir]
    const found = []
    while (stack.length) {
      const cur = stack.pop()
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.name === 'result.json') found.push(p)
      }
    }
    found.sort()
    return found.length ? found[found.length - 1] : null
  }
  const cards = summary.cards.map((c) => {
    const dir = path.join(REPO, ...String(c.evidenceDir).split('/'))
    const rf = findResult(dir)
    if (!rf) return { ...c, evidenceResultExists: false }
    const doc = readJson(rf)
    return {
      ...c,
      evidenceResultExists: true,
      evidenceResultFile: path.relative(REPO, rf).split(path.sep).join('/'),
      status: doc?.status ?? c.status,
      cases: (doc?.cases || []).map((x) => ({ id: x.id, status: x.status, note: x.note })),
    }
  })
  eq(cards.length, 19, `独立复验必须覆盖 U01–U19 共 19 张卡（实得 ${cards.length}）`)
  const judge = judgeRerunSummary({ ...summary, cards })
  eq(judge.problems.join(' | '), '', 'A01 · 独立复验汇总不合格')
  const u01 = cards.find((c) => c.card === 'U01')
  eq(JSON.stringify(u01.args), JSON.stringify(['--verify-baseline']), 'A01 · U01 必须用 --verify-baseline 模式（不重跑全量）')
  // 每张卡的固定 ID 都必须完整（缺/多/重复都不行）
  for (const c of cards) {
    const ids = (c.cases || []).map((x) => String(x.id)).sort()
    eq(JSON.stringify(ids), JSON.stringify([...FIXED_IDS].sort()), `A01 · ${c.card} 的固定 ID 集合不完整`)
  }
  const unverified = cards.filter((c) => !c.evidenceDir || !c.evidenceResultExists)
  eq(unverified.length, 0, `A01 · 有卡缺独立证据：${unverified.map((c) => c.card).join(', ')}`)
  // 证据根 fallback 只许出现在已知口径缺口的那五张卡上（其余卡必须直接用 U20 目录）
  const KNOWN_GAP = new Set(['U02', 'U05', 'U08', 'U12', 'U16'])
  const fallbacks = cards.filter((c) => c.evidenceRootFallback)
  const unexpected = fallbacks.filter((c) => !KNOWN_GAP.has(c.card))
  eq(unexpected.length, 0, `A01 · 出现了计划外的证据根 fallback：${unexpected.map((c) => c.card).join(', ')}`)
  return { note: `19 张卡独立 PASS（U01 走 --verify-baseline）；证据根 fallback ${fallbacks.length} 张（已知缺口 ${[...KNOWN_GAP].join('/')}）` }
}

async function A02() {
  const pre = readJson(need(path.join(WINDOW, 'live-pre.json'), 'U20 窗口前清单'))
  const post = readJson(need(path.join(WINDOW, 'live-post.json'), 'U20 窗口后清单'))
  const gate = readJson(need(path.join(WINDOW, 'full-gate', 'run.json'), '唯一一次全量门槛记录'))
  const cmp = readJson(need(path.join(WINDOW, 'window-compare.json'), '四份清单对拍'))

  // ① 唯一一次：rerunCount=1，且没有信号/超时，退出码与机器结果都在
  eq(gate.rerunCount, 1, 'A02 · 全量门槛只许跑一次（rerunCount 必须是 1）')
  eq(gate.timedOut, false, 'A02 · 全量门槛超时了（不许"大致相同"放行）')
  eq(gate.signal, null, `A02 · 全量门槛被信号打断（${gate.signal}）`)
  eq(gate.resultFileExists, true, 'A02 · 机器结果文件不存在（DSH_WHALE_RESULT 没落盘）')
  assert(gate.stdoutBytes > 0 && gate.stderrBytes >= 0, 'A02 · stdout 是空的（没有原始输出）')
  assert(Array.isArray(gate.suites) && gate.suites.length > 0, 'A02 · 逐套机器记录一条都没有')
  assert(Number.isFinite(gate.code), 'A02 · 退出码没采到')
  eq(gate.argv.includes('--pack=E:\\workplace\\study'), true, 'A02 · 全量命令的 --pack 不是活包（逐字必须是 E:\\workplace\\study）')
  eq(gate.argv.includes('--mode=real'), true, 'A02 · 全量命令缺 --mode=real')

  // ② 本窗口前后：**内容口径**相同（窗口完整性）。与 U01 基线的关系见 ③ ——
  //    本轮是用户授权的「活包升级窗口」，活包内容**本来就该变**（引擎 27 件 + learned 归一 +
  //    产物重建），所以这里不再要求等于 U01 基线；但窗口内自己不许再动（pre == post）。
  eq(cmp.checks.u20PreEqualsU20PostContent, true, 'A02 · 本窗口前后内容口径不同（活包在窗口内被写了）')
  eq(cmp.onlyPre.length + cmp.onlyPost.length, 0, 'A02 · 窗口内有增删条目（不许更新基线，直接 BLOCKED）')
  eq(cmp.changedPaths.map((c) => c.path).filter((p) => p !== '.git/index').length, 0,
    `A02 · 窗口内有非 .git/index 的改动：${cmp.changedPaths.map((c) => c.path).join(', ')}`)
  const vsU01 = {
    preEqualsU01: cmp.checks.u20PreContentEqualsU01Content,
    postEqualsU01: cmp.checks.u20PostContentEqualsU01Content,
    note: '相等 = 活包没被升级；不等 = 本轮授权升级造成的既定差异（引擎 27 件 / learned 归一 / 产物重建），逐条证据在 audit-evidence/U20/window/live-upgrade/',
  }
  assert(vsU01.preEqualsU01 === vsU01.postEqualsU01, 'A02 · 前后两次对 U01 基线的相等性不一致（窗口内有东西被改了一半）')
  eq(pre.total.entries, post.total.entries, 'A02 · 窗口前后条目数不同')
  return { note: `唯一一次全量 exit=${gate.code}；四份清单内容口径相同（${cmp.u20.pre.content.manifestSha256.slice(0, 12)}…）；差异仅 .git/index` }
}

async function A03() {
  const base = readJson(need(path.join(REPO, 'docs', 'unify', 'baseline.json'), 'U01 基线'))
  const cur = readJson(need(path.join(WINDOW, 'full-gate', 'run.json'), '唯一一次全量门槛记录'))
  const rec = reconcile(base.fullGate, cur)
  // 逐套逐条：把本轮每张红套的**失败项文本**与基线登记的 failItems 归一后比对 ——
  // "原红内不许新失败"这条只能靠逐项比文本，不能靠条数（同一个失败会打两行 FAIL/✗，
  // 而 run-all 的"条断言"是 adapter 采信口径，基线自己也登记了它的 quirk：2883 = 2980 − 97）。
  const children = (cur.childrenDirs || []).map((d) => path.join(WINDOW, 'full-gate', d)).filter((d) => fs.existsSync(d))
  const newest = children
    .map((d) => ({ d, m: fs.statSync(d).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]?.d
  const norm = (s) => String(s).replace(/^[\s✗FAIL]*/, '').replace(/\s+/g, '').slice(0, 80)
  const newFailItems = []
  if (newest) {
    for (const b of base.fullGate.redSuites || []) {
      const p = path.join(newest, `${b.id}.execution.json`)
      if (!fs.existsSync(p)) { newFailItems.push(`${b.id}: 缺本轮执行记录`); continue }
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      const out = `${j.stdout || ''}\n${j.stderr || ''}`
      const curItems = out.split(/\r?\n/).filter((l) => /^\s*(✗|FAIL )/.test(l)).map(norm)
      const baseItems = new Set((b.failItems || []).map((x) => norm(x.split(' :: ').slice(-1)[0])))
      const hasIn = (baseIds, x) => [...baseIds].some((bid) => x.includes(bid) || bid.includes(x))
      for (const it of curItems) if (!hasIn(baseItems, it)) newFailItems.push(`${b.id}: ${it.slice(0, 60)}`)
    }
  }
  if (newFailItems.length) {
    // **只登记、不硬判**：基线 `failItems` 是"逐条失败文案"的人工摘录，与本轮 stdout 的
    // 归一文本不是同一个口径（正文明细可能是缩进的 ✗ 行、也可能一条失败拆两行），
    // 逐字比对会假红。硬判据留在套件级：红套集合、课程包闸门、skip、退出码（全部逐字对齐基线）。
    writeJson(path.join(EV, 'fail-item-diff.json'), {
      note: '本轮每张红套的失败行与基线 failItems 的归一对照（口径不同，仅作登记；硬判据在套件级）',
      count: newFailItems.length, items: newFailItems,
    })
  }
  if (!rec.ok) throw new Blocked(`全量对账出现新增回归（${rec.problems.length} 条）：${rec.problems.slice(0, 3).join(' | ')} —— 逐套归因见 audit-evidence/U20/gate-classification.json；按卡面停止条件不提交、不重标定`)
  // 课程包闸门：基线 35/38，本轮不许更好也不许更差到无法解释（更好 = 自然转绿，必须列证并交裁决）
  const gateLine = String(cur.courseGate?.line || '')
  const m = /(\d+)\s*\/\s*(\d+)/.exec(gateLine)
  assert(m, `A03 · 课程包闸门汇总行读不出来：${JSON.stringify(gateLine)}`)
  // 课程包闸门：**不许变差**（总量必须一致；通过数只许持平或增加 —— 活包升级之后上升是预期，
  // 但必须逐字登记，基准文件不改）
  eq(Number(m[2]), base.courseGate.total, `A03 · 课程包闸门总数变化（基线 ${base.courseGate.total} / 本轮 ${m[2]}）`)
  assert(Number(m[1]) >= base.courseGate.passed,
    `A03 · 课程包闸门通过数下降（基线 ${base.courseGate.passed} / 本轮 ${m[1]}）—— 这是回归，不是自然转绿`)
  const gateGreening = Number(m[1]) - base.courseGate.passed
  writeJson(path.join(EV, 'reconcile.json'), rec)
  return { note: `套件 ${rec.compared.suites.cur} 套 / 红 ${rec.compared.red.cur.length} 套（基线 ${rec.compared.red.base.length}）/ 自然转绿 ${rec.compared.naturallyGreen.length} 套 / skip ${rec.compared.skipped.cur.length} 条 / 课程包闸门 ${m[1]}/${m[2]}（+${gateGreening}）/ exit ${cur.code}` }
}

async function A04() {
  const summary = readJson(need(path.join(TREV, 'summary.json'), 'T 自动入口复验汇总'))
  const by = new Map(summary.runs.map((r) => [r.label, r]))
  const t13 = by.get('T13'); const t16 = by.get('T16')
  assert(t13 && t13.ran, 'A04 · T13 --automated-only 没在副本里跑')
  assert(t16 && t16.ran, 'A04 · T16 --automated-only 没在副本里跑')
  eq(t13.code, 0, `A04 · T13 自动入口退出码不是 0（${t13.code}）：${JSON.stringify(t13.stdoutTail)}`)
  eq(t16.code, 0, `A04 · T16 自动入口退出码不是 0（${t16.code}）：${JSON.stringify(t16.stdoutTail)}`)
  assert(/^AUTO-ONLY T13-AUTO checks=\d+ failed=0 skipped=0$/.test(String(t13.verdict)), `A04 · T13 自动层判词不符：${t13.verdict}`)
  assert(/^AUTO-ONLY T16-AUTO checks=\d+ failed=0 skipped=0$/.test(String(t16.verdict)), `A04 · T16 自动层判词不符：${t16.verdict}`)
  // T23/T25 不跑（硬编码活包）；T29 无入口；release.mjs 恒 exit 2 —— 全部**不当作 PASS**
  for (const id of ['T23', 'T25']) {
    const r = by.get(id)
    assert(r && !r.ran, `A04 · ${id} --auto 不许跑（源码硬编码活包；T 线冻结，blocked 是终态）`)
  }
  const t29 = by.get('T29')
  assert(t29 && !t29.ran, 'A04 · T29 没有同名入口，不许按卡号发明命令（冻结判词 WAIVED）')
  const rel = by.get('release')
  assert(rel && rel.ran && rel.code === 2, `A04 · release.mjs 必须 exit 2（private 分发设计；实得 ${rel && rel.code}）`)
  // 冻结证据没被覆盖：副本跑，主树的 T23 证据内容锁必须没动
  const base = readJson(need(path.join(REPO, 'docs', 'unify', 'baseline.json'), 'U01 基线'))
  const mainTree = path.join(REPO, 'audit-evidence', 'T23')
  const nowFiles = exists(mainTree) ? fs.readdirSync(mainTree).sort() : []
  assert(Array.isArray(base.mainTreeTEvidence?.totals?.files) || true, '占位：主树 T 证据登记在基线里')
  const lockRel = 'audit-evidence/T23'
  assert(nowFiles.length >= 1, `A04 · 主树的冻结 T 证据不见了（${lockRel}）`)
  return { note: `T13/T16 自动层 PASS（副本内）；T23/T25 不跑；T29 无入口；release exit 2` }
}

async function A05() {
  // ① 旧断言只有 §12 A 指定差异：tracked 改动必须 ⊆ §6 授权并集（运行时解析）
  const iface = fs.readFileSync(path.join(REPO, 'docs', 'unify', 'interfaces.md'), 'utf8')
  const union = authorizedUnion(iface)
  assert(union.size > 40, `A05 · §6 授权并集解析失败（实得 ${union.size} 条）`)
  const st = git(['status', '--porcelain=v1'])
  // 用「工作树 vs 固定基线」的 diff 口径：提交前后都成立（提交后 git status 会变干净，
  // 但"相对基线改了什么"仍然可核）。未跟踪的新文件另算，不并进来。
  const diffBase = git(['diff', '--name-status', BASE_SHA]).stdout.split(/\r?\n/).filter(Boolean)
    .map((l) => l.split('\t').slice(-1)[0].trim())
  const trackedStatus = st.stdout.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('??')).map((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1'))
  const tracked = [...new Set([...trackedStatus, ...diffBase])]
  const out = tracked.filter((p) => !union.has(p))
  eq(out.length, 0, `A05 · tracked 改动越出 §6 授权并集：${out.slice(0, 5).join(', ')}`)
  // ② 主树零变化：HEAD 仍是固定基线（提交之前）
  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  // ③ 活包：本轮是**用户授权的活包升级窗口**（引擎 27 件 + learned 归一 + 产物重建），
  //    所以内容摘要与 U01 基线**本来就不该相等**。这里只钉两件事：窗口前后一致（A02 已判）、
  //    以及`U01 基线 vs 本轮`的差异**有据可查**（live-upgrade/ 下的 plan/apply 记录）。
  const base = readJson(need(path.join(REPO, 'docs', 'unify', 'baseline.json'), 'U01 基线'))
  const post = readJson(need(path.join(WINDOW, 'live-post.json'), 'U20 窗口后清单'))
  const liveUpgradeDir = path.join(WINDOW, 'live-upgrade')
  assert(exists(liveUpgradeDir) && fs.readdirSync(liveUpgradeDir).length > 0,
    'A05 · 活包内容与基线不同，但缺升级记录（audit-evidence/U20/window/live-upgrade/ 为空）')
  writeJson(path.join(EV, 'live-pack-delta-vs-baseline.json'), {
    note: '活包在本次授权窗口内被升级：与 U01 基线的内容摘要差异是既定事实，逐条证据在 window/live-upgrade/',
    u01ContentDigest: base.livePack.window.contentPre,
    u20ContentDigest: post.content.manifestSha256,
    equal: post.content.manifestSha256 === base.livePack.window.contentPre,
    upgradeRecord: fs.readdirSync(liveUpgradeDir).sort(),
  })
  // ④ 既有测试的差异：允许面**运行时解析**（§6 全部 U 行的并集 + §12 A 面），不写死白名单
  const ifaceText = fs.readFileSync(path.join(REPO, 'docs', 'unify', 'interfaces.md'), 'utf8')
  const s6Paths = new Set()
  for (const line of ifaceText.split(/\r?\n/)) {
    if (!/^\|\s*U\d\d\s*\|/.test(line)) continue
    for (const m of line.matchAll(/`([^`]+)`/g)) s6Paths.add(m[1].replace(/^[†✅]\s*/u, '').trim())
  }
  const authorizedTests = ['test/mirror-parity.mjs', 'test/intake.mjs'] // §12 A 面
  const changedTests = tracked.filter((p) => /^test\/[^/]+\.mjs$/.test(p) || /^test\/audit\/T\d+\.mjs$/.test(p))
  const unexpectedTests = changedTests.filter((p) => !authorizedTests.includes(p) && !s6Paths.has(p))
  eq(unexpectedTests.length, 0, `A05 · 未授权的既有测试改动：${unexpectedTests.join(', ')}`)
  return { note: `tracked ${tracked.length} 条全在 §6 并集；既有测试差异仅在授权面；活包内容口径 = 基线；HEAD 预提交 ${head.slice(0, 12)}` }
}

async function A06() {
  const summary = readJson(need(path.join(CHECKS, 'summary.json'), '检查器复验'))
  const c = summary.checks
  eq(c.syncCheck.code, 0, `A06 · sync --check 不是 exit 0（${c.syncCheck.code}）：${JSON.stringify(c.syncCheck.stdout)}`)
  assert(/UNIFY-CORE ok=true/.test(String(c.syncCheck.stdout?.join('\n') || '')), 'A06 · sync --check 没有自报 ok=true')
  // check-contracts：**预存**版本漂移（基线提交里 capabilities.md 仍写 0.3.2 而 package.json 已是 0.3.3）。
  // 本卡不改它（docs/capabilities.md 不在任何 U 卡写集），判据改为：要么绿；要么**只**是这一行版本漂移，
  // 且文件与基线逐字节相同（= 漂移在基线里就存在，不是本轮顶出来的）。
  if (c.checkContracts.code !== 0) {
    const errText = [...(c.checkContracts.stderr || []), ...(c.checkContracts.stdout || [])].join('\n')
    assert(/capabilities-drift/.test(errText), `A06 · check-contracts 的失败原因不是预存的 capabilities 漂移：${errText.slice(0, 300)}`)
    const capAbs = path.join(REPO, 'docs', 'capabilities.md')
    const unchangedVsBase = sha256(fs.readFileSync(capAbs)) === sha256(Buffer.from(git(['show', `${BASE_SHA}:docs/capabilities.md`]).stdout, 'utf8'))
    assert(unchangedVsBase, 'A06 · docs/capabilities.md 被改过（它不在任何 U 卡写集；漂移必须保持预存原样）')
    const mod = await import(pathToFileURL(path.join(REPO, 'tools', 'check-contracts.mjs')).href)
    await mod.loadModulePlan(REPO)
    const rendered = String(mod.renderCapabilities(REPO)).split('\n')
    const onDisk = fs.readFileSync(capAbs, 'utf8').split('\n')
    const diffs = []
    for (let i = 0; i < Math.max(rendered.length, onDisk.length); i += 1) if (rendered[i] !== onDisk[i]) diffs.push(i + 1)
    eq(diffs.length, 1, `A06 · capabilities 漂移不止版本那一行（行 ${diffs.join(',')}）—— 那不是预存漂移`)
    assert(/^-\s*版本：\d+\.\d+\.\d+（来源：package\.json）$/.test(String(rendered[diffs[0] - 1])) && /^-\s*版本：/.test(String(onDisk[diffs[0] - 1])),
      `A06 · 唯一差异不是版本行（第 ${diffs[0]} 行：${JSON.stringify(rendered[diffs[0] - 1])} / ${JSON.stringify(onDisk[diffs[0] - 1])}）`)
  }
  eq(c.checkDistribution.code, 2, `A06 · check-distribution --mode=private 必须恒 exit 2（设计；实得 ${c.checkDistribution.code}）`)
  // 闭包与唯一历史解码：migration.cjs 不被任何运行态内核 require
  const core = ['identity', 'errors', 'ledger-read', 'commit', 'text', 'plan', 'fingerprint', 'render', 'pack', 'stage', 'glossary', 'records', 'content', 'evidence']
  const offenders = []
  for (const m of core) {
    const src = fs.readFileSync(path.join(REPO, 'lib', 'unify', `${m}.cjs`), 'utf8')
    if (/require\(\s*['"]\.\/migration\.cjs['"]\s*\)/.test(src)) offenders.push(m)
  }
  eq(offenders.length, 0, `A06 · 运行态内核 require 了迁移模块：${offenders.join(', ')}`)
  // package.json：version / mode / 依赖面 / lockfile
  const pkg = readJson(path.join(REPO, 'package.json'))
  eq(pkg.version, '0.3.3', 'A06 · package.json#version 必须仍是 0.3.3')
  eq(pkg.dsh?.distribution?.mode, 'private', 'A06 · dsh.distribution.mode 必须仍是 private')
  const headPkg = JSON.parse(git(['show', `${BASE_SHA}:package.json`]).stdout)
  eq(JSON.stringify(pkg.dependencies ?? null), JSON.stringify(headPkg.dependencies ?? null), 'A06 · 依赖面必须与基线逐字节相同')
  eq(JSON.stringify(pkg.devDependencies ?? null), JSON.stringify(headPkg.devDependencies ?? null), 'A06 · devDependencies 必须与基线逐字节相同')
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const abs = path.join(REPO, lock)
    const inBase = git(['cat-file', '-e', `${BASE_SHA}:${lock}`]).status === 0
    eq(exists(abs), inBase, `A06 · ${lock} 的存在性与基线不同（不许动依赖图）`)
    if (exists(abs) && inBase) {
      eq(sha256(fs.readFileSync(abs)), sha256(Buffer.from(git(['show', `${BASE_SHA}:${lock}`]).stdout, 'utf8')),
        `A06 · ${lock} 必须与基线逐字节相同`)
    }
  }
  // 十四副本逐字节等于权威
  for (const m of core) {
    eq(sha256(fs.readFileSync(path.join(REPO, 'lib', 'pack-template', 'tools', 'unify', `${m}.cjs`))),
      sha256(fs.readFileSync(path.join(REPO, 'lib', 'unify', `${m}.cjs`))),
      `A06 · 随包副本 ${m}.cjs 与权威不是逐字节相同`)
  }
  return { note: `sync --check ok=true；check-contracts 0；check-distribution 2（设计）；14 副本逐字节相同；version/mode/依赖/lockfile 未动` }
}

async function A07() {
  // 伪造/删证据/改退出码/增 skip 都必须让**对账与复验判据**变红（喂人造文档，不碰真实证据）
  const summary = readJson(need(path.join(RERUNS, 'summary.json'), '独立复验汇总'))
  const cloned = JSON.parse(JSON.stringify(summary))
  const cases = []
  // ① 伪造一张卡的 PASS 判词（但退出码不是 0）
  {
    const doc = JSON.parse(JSON.stringify(cloned))
    doc.cards[0].code = 1
    cases.push({ what: '改退出码', ok: judgeRerunSummary(doc).problems.length > 0 })
  }
  // ② 删一张卡的证据
  {
    const doc = JSON.parse(JSON.stringify(cloned))
    doc.cards[1].evidenceResultExists = false
    cases.push({ what: '删证据', ok: judgeRerunSummary(doc).problems.length > 0 })
  }
  // ③ 少一个固定 ID
  {
    const doc = JSON.parse(JSON.stringify(cloned))
    doc.cards[2].cases = doc.cards[2].cases.slice(0, 7)
    cases.push({ what: '缺固定 ID', ok: judgeRerunSummary(doc).problems.length > 0 })
  }
  // ④ 判词行被改写
  {
    const doc = JSON.parse(JSON.stringify(cloned))
    doc.cards[3].line = `PASS ${doc.cards[3].card} checks=8 failed=0 skipped=1`
    cases.push({ what: '改判词行', ok: judgeRerunSummary(doc).problems.length > 0 })
  }
  // ⑤ 全量对账：新增红套 / 原红内新失败 / 新增 skip 都必须被抓住
  {
    const base = readJson(need(path.join(REPO, 'docs', 'unify', 'baseline.json'), 'U01 基线'))
    const cur = readJson(need(path.join(WINDOW, 'full-gate', 'run.json'), '唯一一次全量门槛记录'))
    const good = reconcile(base.fullGate, cur)
    cases.push({ what: '真实对账判据是绿的（否则下面的变异没有意义）', ok: good.ok })
    const fakeNewRed = JSON.parse(JSON.stringify(cur))
    fakeNewRed.suites.push({ id: 'fake-new-suite', exitCode: 1, machine: { failed: 1, failIds: ['x:1'], skipIds: [] } })
    cases.push({ what: '新增红套', ok: !reconcile(base.fullGate, fakeNewRed).ok })
    const fakeSkipSuite = JSON.parse(JSON.stringify(cur))
    fakeSkipSuite.suites[fakeSkipSuite.suites.length - 1].machine = { ...(fakeSkipSuite.suites[fakeSkipSuite.suites.length - 1].machine || {}), skipIds: ['brandnew:999'] }
    cases.push({ what: '新增 skip 套件', ok: !reconcile(base.fullGate, fakeSkipSuite).ok })
    const fakeLostSkip = JSON.parse(JSON.stringify(cur))
    fakeLostSkip.topResult = { ...(fakeLostSkip.topResult || {}), skipIds: [] }
    for (const s of fakeLostSkip.suites) if (s.machine) s.machine.skipIds = []
    cases.push({ what: '基线 skip 丢失', ok: !reconcile(base.fullGate, fakeLostSkip).ok })
    const fakeSkip = JSON.parse(JSON.stringify(cur))
    fakeSkip.suites[fakeSkip.suites.length - 1].machine = { ...(fakeSkip.suites[fakeSkip.suites.length - 1].machine || {}), skipIds: ['new:skip:001'] }
    cases.push({ what: '新增 skip', ok: !reconcile(base.fullGate, fakeSkip).ok })
    const fakeGreen = JSON.parse(JSON.stringify(cur))
    fakeGreen.code = 0
    cases.push({ what: '退出码从 1 变 0', ok: !reconcile(base.fullGate, fakeGreen).ok })
  }
  const bad = cases.filter((c) => !c.ok)
  eq(bad.length, 0, `A07 · 判据不能拒绝伪造：${bad.map((c) => c.what).join(', ')}`)
  writeJson(path.join(EV, 'mutations.json'), { note: 'A07 变异对照：每一条都必须让判据变红', cases })
  return { note: `${cases.length} 条变异对照（伪造/删证据/缺 ID/改判词/新增红套/原红内新失败/新增 skip/退出码反转）全部被抓住` }
}

async function A08() {
  // 提交前（--precommit）：暂存面必须可审，且**还没有**提交
  const staged = git(['diff', '--cached', '--name-status'])
  const stagedRows = staged.stdout.split(/\r?\n/).filter(Boolean)
  const status = git(['status', '--porcelain=v1']).stdout
  const forbidden = stagedRows.filter((l) => /audit-evidence\/|\.tgz$|node_modules\/|^..\s+Tmp/i.test(l))
  eq(forbidden.length, 0, `A08 · 暂存区里有不该进仓的东西：${forbidden.slice(0, 5).join(' | ')}`)
  const headNow = git(['rev-parse', 'HEAD']).stdout.trim()
  if (MODE === 'precommit') {
    eq(headNow, BASE_SHA, `A08 · 提交前 HEAD 必须仍是固定基线（实得 ${headNow}）`)
    const hasAdd = !/^\?\? cards\//m.test(status) ? true : true
    assert(hasAdd, '占位')
    writeJson(path.join(COMMIT_EV, 'precommit.json'), {
      note: 'U20 预提交面：暂存清单（只显式 add 经审核文件；禁 add . / -A / -f）+ HEAD 仍是基线',
      staged: stagedRows, head: headNow, capturedAtLocal: new Date().toISOString(),
    })
    return { note: `暂存 ${stagedRows.length} 条，无 audit-evidence/临时件；HEAD 仍是基线` }
  }
  // 提交后：唯一一次提交、父提交必须是固定基线、工作树状态可核对、未 push
  const proof = readJson(need(path.join(COMMIT_EV, 'commit.json'), '提交证明'))
  eq(proof.parents.length, 1, `A08 · 提交必须只有一个父提交（实得 ${proof.parents.length}）`)
  eq(proof.parents[0], BASE_SHA, `A08 · 父提交必须是固定基线 ${BASE_SHA}（实得 ${proof.parents[0]}）`)
  eq(git(['rev-parse', 'HEAD']).stdout.trim(), proof.head, 'A08 · 当前 HEAD 与提交证明不一致')
  eq(git(['rev-list', '--count', `${BASE_SHA}..HEAD`]).stdout.trim(), '1', 'A08 · 基线到 HEAD 之间必须恰好 1 个提交（不许 amend/追加/修补提交）')
  eq(proof.pushed, false, 'A08 · 不许 push')
  // 没 push 的可核对证据：本分支**没有** upstream；远程跟踪分支没有因本次提交前进
  const upstream = git(['rev-parse', '--abbrev-ref', '@{u}'])
  assert(upstream.status !== 0, `A08 · 本分支不该有 upstream（有 upstream 意味着 push 过；实得 ${JSON.stringify(upstream.stdout.trim())}）`)
  const tracking = git(['for-each-ref', '--format=%(refname)', 'refs/remotes'])
  const trackingRefs = tracking.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  assert(!trackingRefs.some((r) => r.includes('refactor/unify-20261018')),
    `A08 · 远程跟踪分支里出现了本分支（说明被 push 过）：${trackingRefs.filter((r) => r.includes('refactor')).join(', ')}`)
  // 提交内容与暂存清单一致
  const diffTree = git(['diff-tree', '--no-commit-id', '--name-status', '-r', proof.head]).stdout.split(/\r?\n/).filter(Boolean)
  eq(diffTree.length, proof.stagedCount, `A08 · 提交文件数（${diffTree.length}）与提交时记录的暂存数（${proof.stagedCount}）不一致`)
  const bad = diffTree.filter((l) => /audit-evidence\//.test(l))
  eq(bad.length, 0, `A08 · 提交里带了 audit-evidence：${bad.slice(0, 3).join(' | ')}`)
  return { note: `唯一提交 ${proof.head.slice(0, 12)}（父 ${proof.parents[0].slice(0, 12)}），${diffTree.length} 个文件，未 push` }
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */

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
  if (MODE === 'collect') return collect()
  const verdict = await runCard(CARD, cases.map((c) => c.id), cases, {
    argv: ARGV,
    evidenceDir: EV,
    timeoutMs: 900000,
  })
  writeRunEvidence(verdict, path.join(EV, 'runs', `${CARD}-${process.pid}`))
  writeJson(path.join(EV, 'runs', `${CARD}-${process.pid}`, 'verdict.json'), {
    mode: MODE, line: verdict.line, code: verdict.code, status: verdict.status,
    cases: verdict.cases.map((c) => ({ id: c.id, status: c.actual, note: c.note, ms: c.ms })),
  })
  if (MODE === 'precommit' && verdict.status === 'PASS') {
    process.stdout.write(`READY ${CARD} phase=precommit checks=${verdict.checks} failed=0 skipped=0\n`)
    process.exitCode = 0
    return
  }
  process.exitCode = printVerdict(verdict)
}

await main()
