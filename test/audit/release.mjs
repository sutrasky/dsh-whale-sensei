#!/usr/bin/env node
/**
 * test/audit/release.mjs — **发布检查器**入口（T28 / 报告 G03）
 * ==================================================================
 * 它回答一个问题：**今天能不能说"这份东西可以发出去"**。答案只有两种形状：
 *   · `BLOCKED release …` + **exit 非零**（今天必然是这一种）
 *   · `PASS release …` + exit 0（只有真的核验过材料、且没有任何 blocked/open 发现时才可能出现）
 *
 * 判据全部来自**结构化台账**，不读任何"status: done"之类的自由文本：
 *   ① `audit-evidence/findings-map.json` —— 固定枚举 **24 个发现**（P1=16 / P2=8）与它们对应的卡；
 *   ② `audit-evidence/planner-acceptance-summary.json` —— 每张卡的验收判词（逐字 `PASS T<n> checks=…`）；
 *   ③ `audit-evidence/waivers.json` —— 用户显式弃权的卡（WAIVED ≠ PASS ≠ BLOCKED）。
 * 证据缺失（文件不存在 / 某卡查无验收行 / 判词与卡号不符）一律记 `open` 并**打印原因**。
 *
 * 分发面（T28 §3.7）：
 *   · `package.json#dsh.distribution.mode === 'private'` ⇒ **必须**打印
 *     「未做再分发合规核验」+「依据：audit-evidence/waivers.json（T29=WAIVED，G03=waived）」；
 *   · `public` 时才去调 `tools/check-distribution.mjs --mode=public`（核材料）。
 *
 * 纪律：**只有**真的核验过材料（public + verifier ok + 无 blocked/open）才允许 `ok:true`。
 * 今天不可能 —— 私模式 + 真实的 Node/Three/字体许可材料没接入（T29 已被用户弃权）+ 4 个 blocked 发现。
 * 改不出来就如实非零：**内部专项全绿 ≠ 可分发**。
 *
 * 用法：node test/audit/release.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const require_ = createRequire(import.meta.url)
const SCHEMA = 'whale-release/1'
const FINDINGS_EXPECTED = 24
const EV_DIR = path.join(REPO, 'audit-evidence')
const json = process.argv.slice(2).includes('--json')

const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/')

/** 读一个 JSON 台账；失败不抛，返回原因（"证据缺失"必须是**可归因**的 open，不是崩掉） */
function readJson(p) {
  if (!fs.existsSync(p)) return { ok: false, value: null, error: `文件不存在：${rel(p)}` }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')), error: null }
  } catch (e) {
    return { ok: false, value: null, error: `不是合法 JSON：${rel(p)}（${e && e.message ? e.message : String(e)}）` }
  }
}

/** 分发模式：`distribution-license.cjs#modeOf`（缺失 → private；写错 → 抛） */
function distributionMode() {
  try {
    const DL = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'distribution-license.cjs'))
    return { mode: DL.modeOf(path.join(REPO, 'package.json')), error: null }
  } catch (e) {
    return { mode: 'invalid', error: e && e.message ? e.message : String(e) }
  }
}

/** 跑一次 `tools/check-distribution.mjs --mode=public --json`（只有公模式才会走到这里） */
function publicCheck() {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'check-distribution.mjs'), '--mode=public', '--json'], {
    cwd: REPO, encoding: 'utf8', timeout: 120000,
  })
  let parsed = null
  try { parsed = JSON.parse(String(r.stdout || '').trim()) } catch { /* 解析不了就如实记未核验 */ }
  const exit = typeof r.status === 'number' ? r.status : null
  // B10-R1：**退出码是判据的一部分**。只信 JSON 里的 verified 就会把「exit 非零却自报 verified」
  // 读成已核验 —— 材料核验必须以 check-distribution 的退出码 0 为门。
  const verified = exit === 0 && !!(parsed && parsed.verified === true)
  return { exit, verified, reason: verified ? null : (r.error ? String(r.error.message ?? r.error) : `check-distribution exit=${exit}`), detail: parsed }
}

const findingsDoc = readJson(path.join(EV_DIR, 'findings-map.json'))
const acceptanceDoc = readJson(path.join(EV_DIR, 'planner-acceptance-summary.json'))
const waiversDoc = readJson(path.join(EV_DIR, 'waivers.json'))

const findings = findingsDoc.ok && Array.isArray(findingsDoc.value.findings) ? findingsDoc.value.findings : []
const results = new Map()
if (acceptanceDoc.ok && Array.isArray(acceptanceDoc.value.results)) {
  for (const r of acceptanceDoc.value.results) if (r && r.id) results.set(String(r.id), r)
}
const waivers = waiversDoc.ok && Array.isArray(waiversDoc.value.waivers) ? waiversDoc.value.waivers : []
const waiverByCard = new Map(waivers.filter((w) => w && w.card).map((w) => [String(w.card), w]))

/** 一张卡的状态（closed / blocked / open / waived）+ 原因 */
function cardState(id) {
  const w = waiverByCard.get(id)
  if (w && String(w.state) === 'WAIVED') return { state: 'waived', why: `waivers.json 记 ${w.state}（${rel(path.join(EV_DIR, 'waivers.json'))}）` }
  const r = results.get(id)
  if (!r) return { state: 'open', why: `查无验收行：${id} 不在 planner-acceptance-summary.json 的 results 里` }
  const verdict = String(r.verdict || '').toUpperCase()
  const line = String(r.line || '')
  // 判词必须**自证是自己的**（`PASS T28 …`）—— "有 PASS 字样"不等于"这张卡过了"。
  // B10-R1：卡号 token 必须**恰好**是 id（后接空白/结尾）；`PASS T13-AUTO` 这类自动层判词
  // 不许被读成整卡 PASS（自动层不是整卡通过）。
  if (line && /T\d\d-AUTO\b/.test(line)) {
    return { state: 'open', why: `${id} 的验收行是自动层判词（${JSON.stringify(line.slice(0, 80))}），不是整卡通过` }
  }
  if (line && !new RegExp(`^(PASS|FAIL|BLOCKED|WAIVED)\\s+${id}(?=\\s|$)`).test(line)) {
    return { state: 'open', why: `${id} 的验收行与卡号不符（${JSON.stringify(line.slice(0, 80))}）` }
  }
  if (verdict === 'PASS' && new RegExp(`^PASS ${id}(?=\\s|$)`).test(line)) return { state: 'closed', why: null }
  if (verdict === 'BLOCKED') return { state: 'blocked', why: `${id} 缺真实证据（${line || 'BLOCKED'}）` }
  if (verdict === 'WAIVED') return { state: 'waived', why: `${id} 记 WAIVED（${line}）` }
  return { state: 'open', why: `${id} 还没实现/没验收（verdict=${verdict || '空'}${line ? ` · ${line}` : ''}）` }
}

const waiverCovers = (finding) => waivers.some((w) => {
  if (!w || !w.card || String(w.state) !== 'WAIVED') return false
  if (!finding.cards.includes(String(w.card))) return false
  const text = `${w.scope || ''} ${w.reason || ''}`
  return text.includes(finding.id)
})

/** 一个发现的聚合状态：blocked > closed(全过) > waived(弃权覆盖) > open */
function findingState(f) {
  const cards = Array.isArray(f.cards) ? f.cards.map(String) : []
  const per = cards.map((id) => ({ id, ...cardState(id) }))
  const states = per.map((p) => p.state)
  if (states.includes('blocked')) return { state: 'blocked', per, why: per.filter((p) => p.state === 'blocked').map((p) => p.why).join('；') }
  if (states.length && states.every((s) => s === 'closed')) return { state: 'closed', per, why: null }
  if (states.includes('waived') && waiverCovers(f)) {
    return { state: 'waived', per, why: '用户弃权（waivers.json 的 scope 明写覆盖本发现）——WAIVED 不是修好，也不记 closed' }
  }
  const notClosed = per.filter((p) => p.state !== 'closed' && p.state !== 'waived')
  return { state: 'open', per, why: (notClosed.length ? notClosed : per).map((p) => p.why).filter(Boolean).join('；') }
}

/* ── 逐条算（固定 24 条）────────────────────────────────────────────── */
const rows = findings.map((f) => ({ id: String(f.id), cards: (f.cards || []).map(String), ...findingState(f) }))
const tally = { closed: 0, blocked: 0, open: 0, waived: 0 }
for (const r of rows) tally[r.state] += 1
const total = rows.length
const mapProblems = []
if (!findingsDoc.ok) mapProblems.push(findingsDoc.error)
else if (total !== FINDINGS_EXPECTED) mapProblems.push(`findings-map.json 的发现数是 ${total}，固定枚举应为 ${FINDINGS_EXPECTED}`)

/* ── 分发面 ──────────────────────────────────────────────────────────── */
const dist = distributionMode()
let verified = false
let distDetail = null
if (dist.mode === 'public') {
  const pub = publicCheck()
  verified = pub.verified
  distDetail = { exit: pub.exit }
} else if (dist.mode === 'private') {
  verified = false
} else {
  verified = false
}

const distribution = {
  mode: dist.mode,
  verified,
  waiver: dist.mode === 'private' ? 'T29' : null,
  waiverFile: rel(path.join(EV_DIR, 'waivers.json')),
  ...(dist.error ? { error: dist.error } : {}),
  ...(distDetail ? { check: distDetail } : {}),
}

/** ok 的唯一通路：公模式 + 材料真核过 + 没有 blocked/open + 枚举齐 */
const ok = dist.mode === 'public' && verified && tally.blocked === 0 && tally.open === 0 && mapProblems.length === 0

if (json) {
  process.stdout.write(`${JSON.stringify({
    schema: SCHEMA, findings: total, tally, distribution, ok,
    results: rows.map((r) => ({ id: r.id, status: r.state, cards: r.cards, why: r.why || null })),
    problems: mapProblems,
  })}\n`)
  process.exit(ok ? 0 : 2)
}

/* ── 人类可读 ────────────────────────────────────────────────────────── */
const lines = []
for (const r of rows) {
  lines.push(`发现 ${r.id} ${r.state} cards=${r.cards.join(',') || '（无）'}${r.why ? ` :: ${r.why}` : ''}`)
}
for (const p of mapProblems) lines.push(`证据问题 :: ${p}`)

if (dist.mode === 'private') {
  lines.push('PRIVATE MODE — 未做再分发合规核验')
  lines.push('依据：audit-evidence/waivers.json（T29=WAIVED，G03=waived）')
  lines.push('这不等于合规；发布判定非零。')
} else if (dist.mode === 'public') {
  lines.push(`DISTRIBUTION MODE — public · 材料核验 ${verified ? '通过' : '未通过'}${distDetail ? `（check-distribution exit=${distDetail.exit}）` : ''}`)
} else {
  lines.push(`DISTRIBUTION MODE — 读不动：${dist.error || dist.mode}`)
}

const head = ok
  ? `PASS release findings=${total} closed=${tally.closed} blocked=${tally.blocked} open=${tally.open} waived=${tally.waived}`
  : `BLOCKED release findings=${total} closed=${tally.closed} blocked=${tally.blocked} open=${tally.open} waived=${tally.waived} distribution=${dist.mode} verified=${verified}`
lines.push(head)
lines.push(`结论：${ok ? '可以分发' : '不得发布 —— 不是"改个数字"能变绿的：要么核验材料 + 关掉发现，要么维持非零'}`)
process.stdout.write(lines.join('\n') + '\n')
process.exit(ok ? 0 : 2)
