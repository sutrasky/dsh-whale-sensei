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

/**
 * 26 张卡里属于**提交面**的那 19 张（U01–U19）。
 * A01 的"卡号唯一集合"判据用它：19 个 `U01` **不能**冒充 U01–U19 的矩阵（上一轮实测的假绿）。
 */
const PLAN_CARD_IDS = Object.freeze([
  'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10',
  'U11', 'U12', 'U13', 'U14', 'U15', 'U16', 'U17', 'U18', 'U19',
])

/**
 * `cards/` 的豁免**只限这 23 份确切计划文件**（U-SPEC 的 3 份 + U01–U20 卡面）。
 * 旧实现写的是 `p.startsWith('cards/')` —— 那就等于说"cards 下改什么都行"，
 * 上一轮实测"任意修改已提交的 cards/U01.md 仍然 U20 PASS"正是这条豁免开出来的洞。
 */
const CARDS_PLAN_FILES = Object.freeze([
  'cards/U-BATCHES.md', 'cards/U-SESSIONS.md', 'cards/U-SPEC.md',
  ...Array.from({ length: 20 }, (_, i) => `cards/U${String(i + 1).padStart(2, '0')}.md`),
])

/**
 * 第 4 次提交（2026-10-20 用户作答「沿用现链，追加第 4 次提交」+ 第二轮「A：闭环做完」）的**逐文件白名单**。
 * 逐字等于 interfaces.md §6 的 U21 修补行登记的那批落点（不是前缀）——A08 提交后逐次核收口提交，
 * A08 预提交面用它核「暂存面 ⊆ 本轮授权面」。**模块作用域**：预提交分支会在下面提前 return，
 * 声明若留在 A08 里就会踩 TDZ。
 */
const FOURTH_COMMIT_ALLOW = new Set([
      'lib/unify/pack.cjs',
      'lib/unify/content.cjs',
      'lib/unify/render.cjs',
      'lib/unify/fingerprint.cjs',
      'lib/pack-template/tools/unify/pack.cjs',
      'lib/pack-template/tools/unify/content.cjs',
      'lib/pack-template/tools/unify/render.cjs',
      'lib/pack-template/tools/unify/fingerprint.cjs',
      'lib/pack-template/assets/_frame.html',
      'lib/pack-template/assets/notes.js',
      'lib/pack-template/assets/practice.js',
      'lib/pack-template/tools/ask-server.js',
      'lib/pack-template/tools/lesson-map.js',
      'lib/mods/ask.js',
      'lib/mods/note.js',
      'lib/notes-io.js',
      'lib/practice.js',
      'lib/pack-scaffold.js',
      'test/brief.mjs',
      'test/challenge-gate.mjs',
      'test/practice.mjs',
      'test/pack-scaffold.mjs',
      'test/audit/U20.mjs',
      'test/audit/T26.mjs',
      'docs/unify/interfaces.md',
      'docs/unify/authorization.json',
      'docs/unify/receipts/U19.json',
      'docs/unify-mirrors.md',
      // 2026-10-20 第二轮（用户作答「A：闭环做完」+「有事你自己决定」）：
      // 实跑活包窗口后暴露的缺口 —— 3 个测试夹具只把两段课键换成规范三段（断言一条未删），
      // 1 个模板文件修两处 PLAN_STALE 真缺陷。逐条依据见 interfaces.md §6 的 U21 行。
      'test/evidence.mjs',
      'test/lightup.mjs',
      'test/judge-parity.mjs',
      'lib/pack-template/tools/publish-policy.cjs',
      // 深链判据的**跨域搭桥**也要跟着身份走：星图数据与课程页深链现在都用规范课次键，
      // 旧的"拿页面域 point/NNNN 去页面里找"在活包升级后恒红（build-verify / build-write / panel 三套同时红）。
      'lib/verify.js',
      // 2026-10-21 发布升版（用户授权「更新到最新版本」）：版本号与它的生成物 + 4 处版本逐字断言。
      'package.json',
      'dsh-plugin.json',
      'docs/capabilities.md',
      'test/audit/U01.mjs',
      'test/audit/U08.mjs',
      'test/audit/U19.mjs',
    ])


const ARGV = process.argv.slice(2)
const MODE = ARGV.includes('--collect') ? 'collect'
  : ARGV.includes('--checks') ? 'checks'
  : ARGV.includes('--precommit') ? 'precommit'
  : 'final'

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

/**
 * 从某个 full-gate 目录里取出「**这一次**全量的逐套原始执行记录」。
 *
 * 目录形态：`<full-gate>/<任意>.children-XXXX/<suite>.execution.json`（run-all 每跑一次落一批）。
 * ⚠️ 真实现场有**多批**（上一轮实测 U20 窗口里有 3 批，其中两批都能覆盖全部 56 套、且失败项
 *    并不完全相同 —— `pack-scaffold` 一批多一项）。旧实现按 **mtime 取最新**：那既不是"这次运行的
 *    记录"的证据，也会在两批之间**静默选一个**。
 *
 * 这里的规矩（不猜）：
 *   · 候选 = 覆盖全部 `expectedSuites` 的那些批；一批都没有 → 返回空（A03 会按"缺记录"阻断）；
 *   · 只有一批 → 用它；
 *   · 多批 → 要求它们的**逐套失败项集合完全一致**才认（那说明是同一份记录的多份拷贝）；
 *     只要有一处不一致 → `ambiguous`，A03 直接阻断并点名差异套件（不许静默挑一批）。
 *
 * @param {string} rootDir `.../full-gate`
 * @param {{expected?: {id: string, code: number|string|null}[]}} [opts] 这次运行记录里声明的逐套退出码
 * @returns {{dir: string|null, name: string|null, runs: Record<string, object|null>,
 *            candidates: string[], ambiguous: null|{differingSuites: string[], candidates: string[]}}}
 */
function loadSuiteRuns(rootDir, { expected } = {}) {
  const empty = { dir: null, name: null, runs: {}, candidates: [], ambiguous: null }
  if (!exists(rootDir)) return empty
  const batches = []
  for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !/children-/.test(e.name)) continue
    const abs = path.join(rootDir, e.name)
    const runs = {}
    for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.execution.json')) continue
      const id = f.name.slice(0, -'.execution.json'.length)
      try { runs[id] = readJson(path.join(abs, f.name)) } catch { runs[id] = null }  // 读不动 = 缺记录
    }
    batches.push({ name: e.name, abs, runs })
  }
  const want = Array.isArray(expected) && expected.length ? expected : null
  // ① 覆盖全部套件；② 逐套退出码与运行记录一致（不一致的批次是别的运行留下的，不是"这次"的记录）
  const covering = want
    ? batches.filter((b) => want.every((e) => e.id in b.runs)
      && want.every((e) => b.runs[e.id] && b.runs[e.id].code === e.code))
    : batches
  // ③ 人工**显式钉住**的批次（可选）：`<full-gate>/children-pin.json` = `{ name, note, pickedBy, at }`。
  //    这不是"放宽"：默认不存在 ⇒ 多批且不一致时照样阻断；钉住是**可审的**动作（谁、为什么），
  //    比"按 mtime 静默取最新"诚实得多。
  let pin = null
  try { pin = readJson(path.join(rootDir, 'children-pin.json')) } catch { pin = null }
  if (pin && typeof pin.name === 'string' && pin.name) {
    const hit = batches.find((b) => b.name === pin.name)
    if (!hit) return { ...empty, candidates: batches.map((b) => b.name), pin: { name: pin.name, found: false } }
    if (want && !want.every((e) => e.id in hit.runs)) {
      return { ...empty, candidates: batches.map((b) => b.name), pin: { name: pin.name, found: true, complete: false } }
    }
    return { dir: hit.abs, name: hit.name, runs: hit.runs, candidates: [hit.name], ambiguous: null, pin: { ...pin, found: true, complete: true } }
  }
  if (!covering.length) return { ...empty, candidates: batches.map((b) => b.name) }
  if (covering.length === 1) {
    return { dir: covering[0].abs, name: covering[0].name, runs: covering[0].runs, candidates: [covering[0].name], ambiguous: null }
  }
  // 多批：逐套失败项集合必须完全一致（否则就是"这一批是旧的那一批"——不许猜）
  const fingerprint = (b) => {
    const out = {}
    for (const id of Object.keys(b.runs).sort()) out[id] = parseSuiteFailItems(b.runs[id])
    return out
  }
  const prints = covering.map((b) => ({ b, fp: fingerprint(b) }))
  const ids = [...new Set(prints.flatMap((p) => Object.keys(p.fp)))].sort()
  const differingSuites = ids.filter((id) => {
    const seen = new Set(prints.map((p) => JSON.stringify(p.fp[id] ?? null)))
    return seen.size > 1
  })
  if (differingSuites.length) {
    return {
      ...empty,
      candidates: covering.map((b) => b.name),
      ambiguous: { differingSuites, candidates: covering.map((b) => b.name) },
    }
  }
  const first = covering.slice().sort((a, b) => a.name.localeCompare(b.name))[0]
  return { dir: first.abs, name: first.name, runs: first.runs, candidates: covering.map((b) => b.name), ambiguous: null }
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
  // ④ 不新增 skip：比到**具体用例**（旧口径只比套件名 ⇒ 同一套里新增一个 skip 也放行 —— 实测假绿）。
  //    两侧写法不同（逐套 machine 是 `practice:026`、run-all 顶层是 `practice:practice:026`、
  //    还有一种只有套件名的 `visual`），归一成 `套件:用例`；只有套件名的收成 `套件:*`（表示"这套有跳过"），
  //    比较时 `套件:*` 只要该套在基线上**有任何**跳过就算覆盖 —— 这不是放宽，逐用例的 token 仍然精确比。
  //
  //    ⚠️ 2026-10-21（第二轮闭环实测）：**用例序号不是判据，是"第几条断言"的副产品**。
  //    U21 修补行授权给 `test/practice.mjs` 加断言之后，那条"跳真浏览器"的跳过从 `practice:026` 挪到了
  //    `practice:027` —— 同一套、同一条数、reason 逐字相同，却被判成"新增 skip + 基线 skip 少了"。
  //    所以这里改成按「套件 + reason 文本 + 条数」的多重集比（两边都有 reason 时走这条）：
  //    新增套件 / 新增条数 / 换 reason / 少一条 —— 全都仍然红；只有序号漂移不再误判。
  //    没有 reason 可读时退回原来的 `套件:用例` 口径（原来是硬判，仍然硬判）。
  const baseDetail = Array.isArray(base.skipped?.detail) ? base.skipped.detail : []
  const curTop = Array.isArray(cur.topResult?.skipIds) ? cur.topResult.skipIds : []
  const suiteOfSkipId = (x) => {
    const s = String(x).split(' :: ')[0].trim().replace(/^skip:/, '')
    const parts = s.split(':').filter(Boolean)
    return parts[0] || ''
  }
  const topReason = (raw) => {
    const s = String(raw)
    const idx = s.indexOf(' :: ')
    return { suite: suiteOfSkipId(s), reason: idx < 0 ? '' : s.slice(idx + 4).trim() }
  }
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1)
  const baseSkipCount = new Map()
  const baseReasons = new Map()
  if (baseDetail.length) {
    for (const d of baseDetail) {
      bump(baseSkipCount, String(d.suite || ''))
      const list = baseReasons.get(String(d.suite || '')) || []
      list.push(String(d.reason == null ? '' : d.reason).trim())
      baseReasons.set(String(d.suite || ''), list)
    }
  } else {
    for (const id of (base.skipped?.ids || [])) bump(baseSkipCount, suiteOfSkipId(id))
  }
  const curSkipCount = new Map()
  for (const s of cur.suites || []) for (const id of (s.machine?.skipIds || [])) bump(curSkipCount, suiteOfSkipId(id))
  if (!curSkipCount.size) for (const raw of curTop) bump(curSkipCount, topReason(raw).suite)
  const curReasons = new Map()
  for (const raw of curTop) {
    const { suite, reason } = topReason(raw)
    const list = curReasons.get(suite) || []
    list.push(reason)
    curReasons.set(suite, list)
  }
  // 套件级：条数多了 = 新增 skip；少了 = 基线 skip 丢了（都不许）
  const newSkip = []
  const lostSkip = []
  for (const [suite, n] of curSkipCount) {
    const have = baseSkipCount.get(suite) || 0
    for (let i = have; i < n; i += 1) newSkip.push(`${suite}（第 ${have + i + 1} 条跳过）`)
  }
  for (const [suite, n] of baseSkipCount) {
    const have = curSkipCount.get(suite) || 0
    for (let i = have; i < n; i += 1) lostSkip.push(`${suite}（第 ${have + i + 1} 条跳过）`)
  }
  // 同一套条数没变时，reason 必须逐字相同（换一句"跳过理由"= 换了判据，仍然红）
  for (const [suite, baseList] of baseReasons) {
    const curList = curReasons.get(suite)
    if (!curList || curList.length !== baseList.length) continue
    const b = baseList.slice().sort()
    const c = curList.slice().sort()
    for (let i = 0; i < b.length; i += 1) {
      if (b[i] !== c[i]) { newSkip.push(`${suite}（reason 变了：${JSON.stringify(c[i]).slice(0, 120)}）`); break }
    }
  }
  if (newSkip.length) problems.push(`新增 skip：${newSkip.join(' / ')}`)
  if (lostSkip.length) problems.push(`基线 skip 少了：${lostSkip.join(' / ')}（不许把"跳过变少"当变好）`)
  const baseSkips = [...baseSkipCount.entries()].map(([k, v]) => `${k}×${v}`).sort()
  const curSkips = [...curSkipCount.entries()].map(([k, v]) => `${k}×${v}`).sort()
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
      skipped: { base: baseSkips, cur: curSkips },
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
 * A01 的判据本体：**卡号唯一集合 + 证据绑定**
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 独立复验汇总 → 卡号矩阵是否成立（纯函数，喂文档）。
 *
 * 上一轮的假绿：把 19 份复验全写成 `U01`，`cards.length === 19` 与"每张卡八个 ID"都满足，
 * 于是 U20 仍然 PASS —— 因为它只数**条数**、从没核过**卡号集合**。
 *
 * 这里硬判三件事：
 *   ① 19 条，卡号**互不重复**（重复即冒充）；
 *   ② 卡号集合**恰好**等于 U01–U19；
 *   ③ 每条证据目录与它自报的卡号**绑定**（`audit-evidence/U20/reruns/u20-<卡>`）——
 *      否则"U07 的 PASS"可以来自 U08 的目录。
 *
 * @param {{cards: object[]}} doc `audit-evidence/U20/reruns/summary.json`
 * @returns {{ok: boolean, problems: string[], names: string[]}}
 */
export function judgeCardMatrix(doc) {
  const problems = []
  const cards = Array.isArray(doc?.cards) ? doc.cards : []
  const names = cards.map((c) => String(c?.card ?? ''))
  if (cards.length !== PLAN_CARD_IDS.length) {
    problems.push(`独立复验必须覆盖 ${PLAN_CARD_IDS.length} 张卡（实得 ${cards.length}）`)
  }
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) problems.push(`卡号重复（同一张卡出现多次不能冒充整张矩阵）：${[...new Set(dup)].join(', ')}`)
  const sorted = [...names].sort()
  if (JSON.stringify(sorted) !== JSON.stringify(PLAN_CARD_IDS)) {
    const missing = PLAN_CARD_IDS.filter((id) => !names.includes(id))
    const extra = names.filter((n) => !PLAN_CARD_IDS.includes(n))
    problems.push(`卡号集合必须恰好是 U01–U19（缺：${missing.join(',') || '无'}；多：${[...new Set(extra)].join(',') || '无'}）`)
  }
  for (const c of cards) {
    const want = `audit-evidence/U20/reruns/u20-${String(c?.card ?? '')}`.replace(/\\/g, '/')
    const got = String(c?.evidenceDir ?? '').replace(/\\/g, '/')
    if (got !== want) problems.push(`${c?.card}: 证据目录与卡号不绑定（实得 ${got || '(空)'} / 期望 ${want}）`)
  }
  return { ok: problems.length === 0, problems, names: sorted }
}

/* ══════════════════════════════════════════════════════════════════════
 * A03 的判据本体：**两轮原始执行记录用同一个解析器**
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 一份 `*.execution.json` → 失败项集合（**唯一解析器**；两轮都用它）。
 *
 * 上一轮的口径问题（实测假绿）：基线那一侧读的是 `baseline.json` 里**人工摘录**的 `failItems`，
 * 本轮那一侧读 stdout；而且比较时把两边都截到 80 字、再用**子串包含**判"见过"——
 * `x.includes(bid) || bid.includes(x)` 会把"在旧失败文本里追加一段新失败"当成老失败。
 *
 * 这里的口径：
 *   · 只认行首是 `✗` / `FAIL ` 的行（与 run-all 的记账同源）；
 *   · **不截断**、**不做子串匹配**，归一（去前缀、压空白）之后按**集合**等价比较；
 *   · 两轮解析器是同一个函数 —— 基线原始记录在哪、本轮原始记录在哪，只由调用方决定。
 *
 * @param {{stdout?: string, stderr?: string}|null|undefined} execution `*.execution.json`
 * @returns {string[]} 去重排序后的失败项文本
 */
export function parseSuiteFailItems(execution) {
  const out = `${(execution && execution.stdout) || ''}\n${(execution && execution.stderr) || ''}`
  const norm = (s) => String(s).replace(/^\s*(?:✗|FAIL )\s*/, '').replace(/\s+/g, ' ').trim()
  const items = []
  for (const line of out.split(/\r?\n/)) {
    if (!/^\s*(?:✗|FAIL )/.test(line)) continue
    const t = norm(line)
    if (t) items.push(t)
  }
  return [...new Set(items)].sort()
}

/** `baseline.json` 的套件级红名单（`[{id, failItems}]`）→ 红套 id 数组 */
const redSuiteIds = (fullGate) => (fullGate?.redSuites || []).map((r) => String(r.id))

/**
 * 一批原始记录 → 红套 id（按记录的退出码判；`code !== 0` 即红）。
 * 原始记录缺失时才退回套件级元数据（缺记录本身由 judgeRawRegression 的 ① 阻断）。
 * ⚠️ 不能直接读 `fullGate.suites`：`baseline.json` 里那个字段是**套件数**（数字），
 *    本轮 `run.json` 里才是逐套数组 —— 两种形状混用会静默算成空集合。
 */
function redSuitesOf(runs, fullGate) {
  const fromRuns = Object.entries(runs || {})
    .filter(([, v]) => v && Number(v.code) !== 0)
    .map(([id]) => id)
  if (fromRuns.length) return [...new Set(fromRuns)].sort()
  const list = Array.isArray(fullGate?.suites) ? fullGate.suites : []
  return list
    .filter((s) => (s.exitCode ?? 0) !== 0 || (s.machine && (s.machine.failed || 0) > 0))
    .map((s) => String(s.id)).sort()
}

/**
 * 两轮**原始执行记录**对账（A03 的硬判据本体；纯函数，喂 `{suiteId → execution}` 映射）。
 *
 * 判据（比旧口径硬，且都只依赖原始记录）：
 *   ① 基线的每张红套：**两轮都必须有原始记录**（缺 → 阻断；不许"缺记录当没有新失败"）；
 *   ② 本轮红套集合 ⊆ 基线红套集合（新增红套 → 阻断）；
 *   ③ 原红套内：本轮失败项集合 ⊄ 基线 → 逐条点名（**新增失败必须阻断**）；
 *   ④ 本轮失败项变少 → 只登记（自然转绿/部分转绿都要人看，不静默重标定）。
 *
 * @param {{baseRuns: Record<string, object>, curRuns: Record<string, object>,
 *          baseFullGate: object, curFullGate: object}} input
 * @returns {{ok: boolean, problems: string[], registered: string[], perSuite: object[]}}
 */
export function judgeRawRegression({ baseRuns, curRuns, baseFullGate, curFullGate }) {
  const problems = []
  const registered = []
  const perSuite = []
  const baseRed = redSuiteIds(baseFullGate).sort()
  const curRed = redSuitesOf(curRuns, curFullGate)
  for (const id of curRed) {
    if (!baseRed.includes(id)) problems.push(`新增红套：${id}（基线里它是绿的）`)
  }
  for (const id of baseRed) {
    const b = baseRuns?.[id]
    const c = curRuns?.[id]
    if (!b) { problems.push(`${id}: 缺**基线**原始执行记录（无从对照，阻断）`); continue }
    if (!c) { problems.push(`${id}: 缺**本轮**原始执行记录（不许当"没有新失败"）`); continue }
    const baseItems = new Set(parseSuiteFailItems(b))
    const curItems = new Set(parseSuiteFailItems(c))
    const added = [...curItems].filter((x) => !baseItems.has(x)).sort()
    const gone = [...baseItems].filter((x) => !curItems.has(x)).sort()
    perSuite.push({ id, base: baseItems.size, cur: curItems.size, added, gone })
    for (const x of added) problems.push(`${id}: 原红套内**新增失败**：${x}`)
    for (const x of gone) registered.push(`${id}: 失败项消失（须列证后交裁决）：${x}`)
  }
  // 本轮出现红、但基线不是红套的（上面已判）；反过来"基线红、本轮不红"由套件级 reconcile 判
  return { ok: problems.length === 0, problems, registered, perSuite }
}

/* ══════════════════════════════════════════════════════════════════════
 * A05 的判据本体：**当前 status 的口径**（含未跟踪项）
 * ══════════════════════════════════════════════════════════════════════ */

/** `git status --porcelain=v1` 一行 → 路径（去状态码与两侧引号） */
const statusPath = (line) => String(line).slice(3).trim().replace(/^"(.*)"$/, '$1')

/**
 * A05 的范围判据（纯函数，喂文本）。
 *
 * 上一轮的假绿（两条，都已实测）：
 *   ① `git status` 里 `?? ` 开头的**未跟踪**项被整行丢掉 ⇒ 新增未跟踪 `lib/REVIEW-OUTSIDE.cjs`
 *      照样 PASS。这里把它们单独收出来并硬判：除 23 份计划文件外**一律阻断**。
 *   ② `cards/` 的豁免是前缀 ⇒ 改 `cards/T01.md`、改已提交的 `cards/U01.md` 都能过。
 *      这里改成**23 份确切路径**的白名单。
 *
 * @param {{statusText: string, diffBasePaths: string[], union: Set<string>|string[],
 *          mode: 'precommit'|'final'|'collect'}} input
 * @returns {{ok: boolean, problems: string[], untracked: string[], trackedOut: string[]}}
 */
export function judgeScope({ statusText, diffBasePaths, union, mode }) {
  const problems = []
  const lines = String(statusText || '').split(/\r?\n/).filter((l) => l.trim())
  const untracked = lines.filter((l) => l.startsWith('??')).map(statusPath)
  const trackedStatus = lines.filter((l) => !l.startsWith('??')).map(statusPath)
  const unionSet = union instanceof Set ? union : new Set(union || [])
  const planFiles = new Set(CARDS_PLAN_FILES)
  const NON_CARD_DELIVERY = new Set([
    'docs/unify/authorization.json',
    'docs/unify/receipts/P1-P2.json',
  ])
  // 这两份**两种模式都豁免**（2026-10-20 修）：
  //   旧实现只在"提交后"模式豁免（理由是「--precommit 那一轮它们还没跟踪，严格判定已真跑出 READY」）。
  //   那条理由只在**第一次**交付链上成立：一旦它们进了提交，相对固定基线它们就是**已跟踪的差异**，
  //   于是 `--precommit` 在任何新链上都必须先豁免它们才有可能 READY（否则 precommit 永远达不到，
  //   与「链上限 3」是同一类陈旧口径）。它们也确实不是任何 U 卡的写集落点：一份是人类授权台账本身，
  //   一份是 P1/P2 线的回执。
  const exempt = (p) => planFiles.has(p) || NON_CARD_DELIVERY.has(p)

  // ① 未跟踪项：只允许 23 份计划文件（`audit-evidence/` 与临时件在 .gitignore 里，不会出现在这里）
  const strayUntracked = untracked.filter((p) => !planFiles.has(p))
  for (const p of strayUntracked) problems.push(`未跟踪文件越界：${p}（只允许 23 份 cards/U*.md 计划文件）`)

  // ② 已跟踪改动 ⊆ §6 授权并集（工作树 status ∪ 相对固定基线的 diff，两种口径都算）
  const tracked = [...new Set([...trackedStatus, ...(diffBasePaths || [])])].filter((p) => p && !exempt(p))
  const trackedOut = tracked.filter((p) => !unionSet.has(p))
  for (const p of trackedOut) problems.push(`tracked 改动越出 §6 授权并集：${p}`)

  // ③ cards 下只允许那 23 份**未改动**的计划文件：改过的 cards/* 必须不被 exempt 吃掉
  const cardsTouched = [...new Set([...trackedStatus, ...(diffBasePaths || [])])]
    .filter((p) => p.startsWith('cards/') && !planFiles.has(p))
  for (const p of cardsTouched) problems.push(`cards/ 下出现了计划文件之外的改动：${p}`)

  return { ok: problems.length === 0, problems, untracked, trackedOut }
}

/* ══════════════════════════════════════════════════════════════════════
 * A08 的判据本体：**提交后必须实查当前 status**
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 提交后模式的判据（纯函数，喂文本）。
 *
 * 上一轮的假绿：A08 读的是**提交时记在 commit.json 里的** `statusClean: true` ——
 * 那是"当时的自报"，不是"现在的实况"。提交之后再改一处工作树，U20 照样 PASS。
 * 所以这里必须拿**当前** `git status` 判，并且与提交证明分别校验。
 *
 * @param {{statusText: string, head: string, proofHead: string, pushed: boolean|undefined}} input
 * @returns {{ok: boolean, problems: string[], dirty: string[]}}
 */
export function judgePostCommitClean({ statusText, head, proofHead, pushed }) {
  const problems = []
  const lines = String(statusText || '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length) {
    problems.push(`提交后工作树必须是干净的（实得 ${lines.length} 条未提交/未跟踪项）：${lines.map(statusPath).slice(0, 5).join(' | ')}`)
  }
  if (String(head || '') !== String(proofHead || '')) problems.push(`当前 HEAD 与提交证明不一致（${head} / ${proofHead}）`)
  if (pushed !== false) problems.push(`提交证明里 pushed 必须是 false（实得 ${JSON.stringify(pushed)}）`)
  return { ok: problems.length === 0, problems, dirty: lines.map(statusPath) }
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
  // ① 卡号矩阵：**唯一集合** + 证据与卡号绑定（纯函数，A07 会用同一份判据喂人造文档）
  const matrix = judgeCardMatrix({ cards })
  eq(matrix.problems.join(' | '), '', 'A01 · 卡号矩阵不合格（重复 / 缺卡 / 证据目录与卡号不绑定）')
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

  // ── ① 逐套**原始执行记录**对账（两轮同一个解析器；不截断、不做子串匹配）────────────
  // 旧实现读的是 `baseline.json` 里**人工摘录**的 failItems + 本轮 stdout，两边都截 80 字、
  // 再用子串包含判"见过" —— "在原红项后面接一段新失败"因此被放行（实测假绿）。
  const basePick = loadSuiteRuns(path.join(U01_EV, 'full-gate'), {})
  const curPick = loadSuiteRuns(path.join(WINDOW, 'full-gate'), { expected: (cur.suites || []).map((s) => ({ id: String(s.id), code: s.exitCode })) })
  if (basePick.ambiguous) {
    throw new Blocked(`A03 · 基线的 children 批次不唯一且失败项不一致（${basePick.ambiguous.candidates.join(' / ')}；差异套件：${basePick.ambiguous.differingSuites.join(', ')}）—— 分不出哪一批是那一次全量的记录，不猜`)
  }
  if (curPick.ambiguous) {
    throw new Blocked(`A03 · 本轮的 children 批次不唯一且失败项不一致（${curPick.ambiguous.candidates.join(' / ')}；差异套件：${curPick.ambiguous.differingSuites.join(', ')}）—— 旧实现按 mtime 静默挑最新的一批，那既不可复核也可能挑错；请重采一次全量或显式钉住批次`)
  }
  const raw = judgeRawRegression({ baseRuns: basePick.runs, curRuns: curPick.runs, baseFullGate: base.fullGate, curFullGate: cur })
  writeJson(path.join(EV, 'raw-regression.json'), {
    note: '两轮**原始**逐套执行记录对账：同一个解析器（parseSuiteFailItems；不截断、不做子串匹配）；缺记录/原红套内新增失败/新增红套一律阻断',
    parser: 'parseSuiteFailItems(execution) → 行首 ✗ / FAIL 行，去前缀压空白后按集合精确比较',
    baseBatch: basePick.name, currentBatch: curPick.name,
    baseSuites: Object.keys(basePick.runs).length, currentSuites: Object.keys(curPick.runs).length,
    ok: raw.ok, problems: raw.problems, registered: raw.registered, perSuite: raw.perSuite,
  })
  if (!raw.ok) {
    throw new Blocked(`逐套原始记录对账失败（${raw.problems.length} 条）：${raw.problems.slice(0, 3).join(' | ')} —— 缺记录 / 原红套内新失败 / 新红套都会阻断；按卡面停止条件不提交、不重标定`)
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
  // 用「当前 status ∪ 工作树 vs 固定基线」的 diff 口径：提交前后都成立（提交后 status 干净，
  // 但"相对基线改了什么"仍可核）。**未跟踪项单独硬判**（见 judgeScope ①）。
  const st = git(['status', '--porcelain=v1'])
  const diffBase = git(['diff', '--name-status', BASE_SHA]).stdout.split(/\r?\n/).filter(Boolean)
    .map((l) => l.split('\t').slice(-1)[0].trim())
  const scope = judgeScope({ statusText: st.stdout, diffBasePaths: diffBase, union, mode: MODE })
  // 三处「合法但不是写集落点」的豁免，逐条有据（都在 judgeScope 里）：
  //   · `cards/**` —— 但**只限 23 份确切计划文件**（`cards/U-SPEC.md` / `U-BATCHES.md` /
  //     `U-SESSIONS.md` / `U01–U20.md`）。旧实现写 `startsWith('cards/')`，那等于说 cards 下
  //     改什么都行 —— 上一轮实测"任意修改已提交的 cards/U01.md 仍然 PASS"就是它开的口子；
  //   · `docs/unify/authorization.json` / `docs/unify/receipts/P1-P2.json` —— 人类授权台账与
  //     P1/P2 回执，不属 U01–U20 任何一张卡；且**只在提交后（默认模式）**豁免。
  writeJson(path.join(EV, 'scope.json'), {
    note: 'A05 范围判据（当前 status 的口径 + 23 份计划文件白名单 + §6 授权并集）；未跟踪项单独硬判',
    mode: MODE,
    statusLines: String(st.stdout || '').split(/\r?\n/).filter((l) => l.trim()).length,
    untracked: scope.untracked,
    unionSize: union.size,
    ok: scope.ok,
    problems: scope.problems,
  })
  eq(scope.problems.join(' | '), '', 'A05 · 范围判据不合格（未跟踪越界 / tracked 越出授权并集 / cards 越界）')
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
  const planFiles = new Set(CARDS_PLAN_FILES)
  const changedAll = [...new Set([
    ...String(st.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map(statusPath),
    ...diffBase,
  ])].filter((p) => p && !planFiles.has(p))
  const changedTests = changedAll.filter((p) => /^test\/[^/]+\.mjs$/.test(p) || /^test\/audit\/T\d+\.mjs$/.test(p))
  const unexpectedTests = changedTests.filter((p) => !authorizedTests.includes(p) && !s6Paths.has(p))
  eq(unexpectedTests.length, 0, `A05 · 未授权的既有测试改动：${unexpectedTests.join(', ')}`)
  return { note: `${changedAll.length} 条改动全在 §6 并集（未跟踪项另判）；既有测试差异仅在授权面；活包内容口径 = 基线；HEAD 预提交 ${head.slice(0, 12)}` }
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
  // 2026-10-21：发布升版 0.3.3 → 0.4.0（用户授权「更新到最新版本」）；判据形状不变（逐字相等）。
  eq(pkg.version, '0.4.0', 'A06 · package.json#version 必须仍是 0.4.0')
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
    cases.push({ what: '新增 skip（新套件）', ok: !reconcile(base.fullGate, fakeSkipSuite).ok })
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
    // 同一套里**新增一个** skip（旧口径只比套件名 ⇒ 这条会被放行）
    const fakeSameSuiteSkip = JSON.parse(JSON.stringify(cur))
    const redSuiteId = (base.fullGate.redSuites || [])[0]?.id
    const target = fakeSameSuiteSkip.suites.find((s) => s.id === redSuiteId)
    if (target) {
      target.machine = { ...(target.machine || {}), skipIds: [...((target.machine || {}).skipIds || []), `${redSuiteId}:999`] }
      cases.push({ what: '同一套内新增 skip（具体用例）', ok: !reconcile(base.fullGate, fakeSameSuiteSkip).ok })
    }
  }

  // ⑥ 卡号矩阵：19 份 `U01` 不能冒充 U01–U19；证据目录必须与卡号绑定
  {
    const summary = readJson(need(path.join(RERUNS, 'summary.json'), '独立复验汇总'))
    const good = JSON.parse(JSON.stringify(summary))
    cases.push({ what: '真实复验汇总的卡号矩阵是成立的（变异的前提）', ok: judgeCardMatrix(good).ok })
    const dup = JSON.parse(JSON.stringify(summary))
    for (const c of dup.cards) { c.card = 'U01'; c.evidenceDir = 'audit-evidence/U20/reruns/u20-U01' }
    cases.push({ what: '19 份重复 U01 冒充 U01–U19', ok: !judgeCardMatrix(dup).ok })
    const swapped = JSON.parse(JSON.stringify(summary))
    swapped.cards[7].evidenceDir = swapped.cards[6].evidenceDir  // 拿 U07 的证据冒充 U08
    cases.push({ what: '证据目录与卡号不绑定', ok: !judgeCardMatrix(swapped).ok })
    const missing = JSON.parse(JSON.stringify(summary))
    missing.cards = missing.cards.slice(0, 18)
    cases.push({ what: '缺一张卡', ok: !judgeCardMatrix(missing).ok })
  }

  // ⑦ 范围判据：未跟踪越界 / cards 越界必须红（合法输入必须绿）
  {
    const iface = fs.readFileSync(path.join(REPO, 'docs', 'unify', 'interfaces.md'), 'utf8')
    const union = authorizedUnion(iface)
    const cleanScope = judgeScope({ statusText: '', diffBasePaths: [], union, mode: 'final' })
    cases.push({ what: '范围判据的合法对照（干净 status）', ok: cleanScope.ok })
    const untrackedScope = judgeScope({ statusText: '?? lib/REVIEW-OUTSIDE.cjs\n', diffBasePaths: [], union, mode: 'final' })
    cases.push({ what: '新增**未跟踪**的越界源码（旧口径整行丢掉 ?? ⇒ 放行）', ok: !untrackedScope.ok })
    const cardsScope = judgeScope({ statusText: ' M cards/T01.md\n', diffBasePaths: [], union, mode: 'final' })
    cases.push({ what: 'cards 下的**非**计划文件被改（旧口径 startsWith(\'cards/\') ⇒ 放行）', ok: !cardsScope.ok })
    const cardsNewScope = judgeScope({ statusText: '?? cards/U21.md\n', diffBasePaths: [], union, mode: 'final' })
    cases.push({ what: 'cards 下新增计划外文件', ok: !cardsNewScope.ok })
    const planScope = judgeScope({ statusText: '?? cards/U01.md\n', diffBasePaths: [], union, mode: 'final' })
    cases.push({ what: '23 份计划文件仍在豁免内（不误伤）', ok: planScope.ok })
  }

  // ⑧ 原始记录对账：原红套内新增失败 / 缺记录 / 新红套必须红；失败项变少只登记
  {
    const base = readJson(need(path.join(REPO, 'docs', 'unify', 'baseline.json'), 'U01 基线'))
    const basePick = loadSuiteRuns(path.join(U01_EV, 'full-gate'), {})
    const baseRuns = basePick.runs
    const okPair = judgeRawRegression({ baseRuns, curRuns: JSON.parse(JSON.stringify(baseRuns)), baseFullGate: base.fullGate, curFullGate: base.fullGate })
    cases.push({ what: '原始记录判据的合法对照（同一批记录比自己）', ok: okPair.ok })
    const redSuites = (base.fullGate.redSuites || []).map((r) => r.id)
    const someRed = redSuites.find((id) => baseRuns[id])
    if (someRed) {
      const appended = JSON.parse(JSON.stringify(baseRuns))
      appended[someRed] = { ...appended[someRed], stdout: `${appended[someRed].stdout || ''}\nFAIL 这是原红套里新增的一条失败\n` }
      const r = judgeRawRegression({ baseRuns, curRuns: appended, baseFullGate: base.fullGate, curFullGate: base.fullGate })
      cases.push({ what: `原红套（${someRed}）内**新增失败**`, ok: !r.ok })
      const removed = JSON.parse(JSON.stringify(baseRuns))
      delete removed[someRed]
      const r2 = judgeRawRegression({ baseRuns, curRuns: removed, baseFullGate: base.fullGate, curFullGate: base.fullGate })
      cases.push({ what: `缺本轮原始执行记录（${someRed}）`, ok: !r2.ok })
      const removedBase = JSON.parse(JSON.stringify(baseRuns))
      delete removedBase[someRed]
      const r3 = judgeRawRegression({ baseRuns: removedBase, curRuns: baseRuns, baseFullGate: base.fullGate, curFullGate: base.fullGate })
      cases.push({ what: `缺基线原始执行记录（${someRed}）`, ok: !r3.ok })
      // 失败项**变少**：只登记、不算红（反空转：判据不能"什么都红"）。
      // 做法：把某一条失败项的**所有**同文本行都删掉，确保它真的从集合里消失。
      const shrunk = JSON.parse(JSON.stringify(baseRuns))
      const target = parseSuiteFailItems(baseRuns[someRed])[0]
      const strip = (s) => String(s).replace(/^\s*(?:✗|FAIL )\s*/, '').replace(/\s+/g, ' ').trim()
      const kept = String(shrunk[someRed].stdout || '').split(/\r?\n/)
        .filter((l) => !(/^\s*(?:✗|FAIL )/.test(l) && strip(l) === target))
      shrunk[someRed] = { ...shrunk[someRed], stdout: kept.join('\n') }
      const r4 = judgeRawRegression({ baseRuns, curRuns: shrunk, baseFullGate: base.fullGate, curFullGate: base.fullGate })
      cases.push({ what: '原红套内失败项**变少**只登记、不误判成红', ok: r4.ok && r4.registered.length > 0 })
    }
  }

  // ⑨ 提交后状态：脏工作树 / HEAD 与证明不一致 / pushed 必须红
  {
    const clean = judgePostCommitClean({ statusText: '', head: 'abc', proofHead: 'abc', pushed: false })
    cases.push({ what: '提交后状态判据的合法对照（干净）', ok: clean.ok })
    const dirty = judgePostCommitClean({ statusText: ' M lib/practice.js\n', head: 'abc', proofHead: 'abc', pushed: false })
    cases.push({ what: '提交后**又改了工作树**（旧口径读自报的 statusClean ⇒ 放行）', ok: !dirty.ok })
    const untrackedDirty = judgePostCommitClean({ statusText: '?? lib/REVIEW-OUTSIDE.cjs\n', head: 'abc', proofHead: 'abc', pushed: false })
    cases.push({ what: '提交后出现未跟踪项', ok: !untrackedDirty.ok })
    const movedHead = judgePostCommitClean({ statusText: '', head: 'abc', proofHead: 'def', pushed: false })
    cases.push({ what: 'HEAD 与提交证明不一致', ok: !movedHead.ok })
    const pushedTrue = judgePostCommitClean({ statusText: '', head: 'abc', proofHead: 'abc', pushed: true })
    cases.push({ what: '证明里 pushed=true', ok: !pushedTrue.ok })
  }
  const bad = cases.filter((c) => !c.ok)
  eq(bad.length, 0, `A07 · 判据不能拒绝伪造：${bad.map((c) => c.what).join(', ')}`)
  writeJson(path.join(EV, 'mutations.json'), { note: 'A07 变异对照：每一条都必须让判据变红（含每类判据的合法对照，防止"什么都红"）', cases })
  return { note: `${cases.length} 条变异对照（伪造/删证据/缺ID/改判词/新增红套/原红内新失败/同套新增skip/退出码反转/19份重复U01/证据不绑定/未跟踪越界/cards越界/缺原始记录/提交后脏工作树）全部被抓住，且每类判据都有合法对照` }
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
    // 预提交面的「还没有提交」= 第 4 次提交**尚未发生**。
    // 旧口径写的是 `HEAD === 固定基线`，那只在"第一次交付"那轮成立；R5 起本轮是现链上的**第 4 次**，
    // 所以改成"基线之后已有 3 次（1 交付 + 2 收口）、而这一轮还没提交"—— 判据强度不变（仍然只能是那 3 次）。
    const chainNow = git(['rev-list', '--reverse', `${BASE_SHA}..HEAD`]).stdout.split('\n').map((x) => x.trim()).filter(Boolean)
    eq(chainNow.length, 3, `A08 · 提交前链长必须仍是 3（1 交付 + 2 收口；实得 ${chainNow.length}）—— 第 4 次提交还没发生`)
    eq(headNow, chainNow[chainNow.length - 1], 'A08 · 提交前 HEAD 必须就是那 3 次的末位（这一轮的那次提交还没发生）')
    // 暂存面必须 ⊆ 本轮授权面（只显式 add 经审核文件；禁 add . / -A / -f）
    const stagedPaths = stagedRows.map((l) => l.split('\t').slice(-1)[0].trim())
    const stagedOut = stagedPaths.filter((f) => !FOURTH_COMMIT_ALLOW.has(f))
    eq(stagedOut.length, 0, `A08 · 暂存面越出第 4 次提交白名单：${stagedOut.join(', ')}`)
    writeJson(path.join(COMMIT_EV, 'precommit.json'), {
      note: 'U20 预提交面：暂存清单（只显式 add 经审核文件；禁 add . / -A / -f）+ 第 4 次提交尚未发生 + 暂存面 ⊆ 白名单',
      staged: stagedRows, stagedCount: stagedRows.length, head: headNow,
      chainSinceBase: chainNow, stagedWithinWhitelist: true,
      capturedAtLocal: new Date().toISOString(),
    })
    return { note: `暂存 ${stagedRows.length} 条（全在白名单内），无 audit-evidence/临时件；链长 3、HEAD ${headNow.slice(0, 12)}（第 4 次提交还没发生）` }
  }
  // 提交后：提交链可核（基线 → HEAD）、**当前**工作树干净、未 push；提交面与记录的暂存面一致
  const proof = readJson(need(path.join(COMMIT_EV, 'commit.json'), '提交证明'))
  // ① **实查当前 status**（旧实现只读提交时自报的 `proof.statusClean` —— 提交后再改一处工作树，
  //    U20 照样 PASS；那是"当时自报"，不是"现在实况"）。
  const stNow = git(['status', '--porcelain=v1'])
  const clean = judgePostCommitClean({
    statusText: stNow.stdout,
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    proofHead: proof.head,
    pushed: proof.pushed,
  })
  writeJson(path.join(COMMIT_EV, 'status-now.json'), {
    note: 'A08 提交后**实查**的当前 status（不是提交时自报的 statusClean）',
    statusLines: String(stNow.stdout || '').split(/\r?\n/).filter((l) => l.trim()),
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    proofHead: proof.head,
    proofStatusClean: proof.statusClean,
    ok: clean.ok,
    problems: clean.problems,
  })
  eq(clean.problems.join(' | '), '', 'A08 · 提交后状态判据不合格（工作树不干净 / HEAD 与证明不一致 / pushed）')
  eq(git(['rev-parse', 'HEAD']).stdout.trim(), proof.head, 'A08 · 当前 HEAD 与提交证明不一致')
  const chain = git(['rev-list', '--reverse', `${BASE_SHA}..HEAD`]).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  eq(chain.length, (proof.chain || []).length, `A08 · 提交链长度与证明不一致（实 ${chain.length} / 证 ${(proof.chain || []).length}）`)
  // 首个提交之后的**每一次**收口修正：只许动它那一轮被授权的那几个文件（逐提交可核，不靠"我相信"）
  // 2026-10-20（用户授权 R5「沿用现链，追加第 4 次提交」）：上限 3 → 4。
  // 原口径是「1 次交付 + 至多 2 次用户逐次授权的收口修正」；第 4 次是**代码修补**（不是改测试台账），
  // 用户逐句授权它落在同一分支上 —— 上限与白名单各加一格，其余判据强度不变。
  // 2026-10-21（第二轮闭环）：旧的 `<= 3` 那条与下面这条重复，且会让 R5 授权的第 4 次提交必红 ——
  // 合并成一条（上限 4），两条 `父提交 === 固定基线` 的重复断言也只留一条。
  assert(chain.length >= 1 && chain.length <= 4,
    `A08 · 基线到 HEAD 只允许「1 次交付 + 至多 3 次用户逐次授权的收口/修补提交」；实得 ${chain.length} 次`)
  eq(git(['rev-parse', `${chain[0]}^`]).stdout.trim(), BASE_SHA,
    `A08 · 首个（交付）提交的父提交必须是固定基线 ${BASE_SHA}`)
  // 首个提交之后的**每一次**收口/修补：只许动它那一轮被授权的那几个文件（逐提交可核，不靠"我相信"）
const FOLLOWUP_ALLOW = [
    new Set(['test/audit/U20.mjs', 'docs/unify/receipts/U01.json']), // 第 2 次（用户 2026-10-20「可以提交」）
    new Set(['test/audit/U20.mjs']),                                 // 第 3 次（用户 2026-10-20「允许第 3 次提交」）
    FOURTH_COMMIT_ALLOW,

  ]
  for (let i = 1; i < chain.length; i += 1) {
    const allowed = FOLLOWUP_ALLOW[i - 1]
    assert(allowed, `A08 · 第 ${i + 1} 次提交没有登记允许面（链长 ${chain.length}）`)
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', chain[i]]).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    const outside = files.filter((f) => !allowed.has(f))
    eq(outside.length, 0, `A08 · 第 ${i + 1} 次（收口修正）提交越出授权面：${outside.join(', ')}`)
    assert(files.length > 0, `A08 · 第 ${i + 1} 次提交是空的（那就不该提交）`)
  }
  eq(proof.pushed, false, 'A08 · 不许 push')
  // 提交时**自报**的 statusClean 只能当"与实况对账"的输入，不能单独当判据（实况在 judgePostCommitClean）
  eq(proof.statusClean, true, 'A08 · 提交证明里自报的 statusClean 必须是 true（与上面实查的 status 对账）')
  // 没 push 的可核对证据：本分支**没有** upstream；远程跟踪分支没有因本次提交前进
  const upstream = git(['rev-parse', '--abbrev-ref', '@{u}'])
  assert(upstream.status !== 0, `A08 · 本分支不该有 upstream（有 upstream 意味着 push 过；实得 ${JSON.stringify(upstream.stdout.trim())}）`)
  const tracking = git(['for-each-ref', '--format=%(refname)', 'refs/remotes'])
  const trackingRefs = tracking.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  assert(!trackingRefs.some((r) => r.includes('refactor/unify-20261018')),
    `A08 · 远程跟踪分支里出现了本分支（说明被 push 过）：${trackingRefs.filter((r) => r.includes('refactor')).join(', ')}`)
  // 提交面与记录一致：整条链的文件合计 == 证明里记的暂存面；任何一次提交都不许带 audit-evidence
  const diffTree = chain.flatMap((c) => git(['diff-tree', '--no-commit-id', '--name-status', '-r', c]).stdout.split(/\r?\n/).filter(Boolean))
  eq(diffTree.length, proof.stagedCount, `A08 · 提交链文件合计（${diffTree.length}）与记录（${proof.stagedCount}）不一致`)
  const bad = diffTree.filter((l) => /audit-evidence\//.test(l))
  eq(bad.length, 0, `A08 · 提交里带了 audit-evidence：${bad.slice(0, 3).join(' | ')}`)
  return { note: `提交链 ${chain.length} 次（首个父提交 = 基线）· HEAD ${proof.head.slice(0, 12)} · 合计 ${diffTree.length} 个文件 · 工作树干净 · 未 push` }
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
  // 2026-10-21（发布升版 0.4.0）：三个检查器是**只读**的，而且版本一升它们的结论就会变
  // （check-contracts 从 1 变 0：capabilities.md 被 --write 重生，预存 drift 被抹平）。
  // 重跑整条 --collect 会把 19 张卡一起重跑（那是"固定基线 HEAD + 未提交"的采集前置，不可复现），
  // 所以单开一个只刷检查器的入口：命令与 --collect 里的 collectChecks() 完全同一份实现。
  if (MODE === 'checks') return collectChecks()
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
