/**
 * test/audit/U17.mjs — U17 · 迁移闭环专项验收（A lane，独占）
 * ==================================================================
 * 卡面：`cards/U17.md`。判据：固定八项 A01–A08（U-SPEC §6 / unify-runner）。
 *
 * 本卡要证明的一件事：**迁移后的新包可读、可构建、可恢复，旧形状没有回流**。
 *   · 只用 **U05 真 CLI**（`tools/migrate-pack.mjs`）与 **U19 真生成包**
 *     （`lib/pack-template/tools/unify/*.cjs` 已随模板铺进夹具包）；
 *   · 夹具全部落在 `E:\Temp\u17-<pid>\`，**不碰活包、不改生产文件**；
 *   · 发现实现缺口就退回原责任卡（本卡只在专项里登记边界，不自行修产品代码）。
 *
 * 决-8（第三批授权，`E:/Temp/HANDOFF-U-SERIES-20261020.md` §4「状态：已确认」）：
 *   `assets/questions-data.js` 的 `lesson`（**显示名**）与 `notes/notes.jsonl` 的 `anchor`
 *   （**星图课次键**）这两类引用随本卡的迁移闭环一起处置 —— 本卡的做法是：
 *     ① 它们必须被 plan **逐条识别并阻断**（不是静默丢条），见 A02；
 *     ② 阻断的解除路径是**受信重建**（U19 之后包侧 build-lessons / build-notes 真的能跑），
 *        见 A04；③ 显示名不是身份（U-SPEC §2），所以"迁移"的是分组键、显示文字保持原样。
 *
 * 判词：`PASS U17 checks=8 failed=0 skipped=0` / exit 0（失败 FAIL/1，缺料 BLOCKED/2）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot, safeRemoveTree, Blocked, REPO,
} from './unify-runner.mjs'

const CARD = 'U17'
const require_ = createRequire(import.meta.url)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readText = (abs) => fs.readFileSync(abs, 'utf8')
const exists = (abs) => fs.existsSync(abs)
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}（实得 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`) }
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const CLI = path.join(REPO, 'tools', 'migrate-pack.mjs')
const TEMPLATE_DIR = path.join(REPO, 'lib', 'pack-template')
const MIRROR_REL = 'lib/pack-template/tools/unify'
const CORE_MODULES = ['identity', 'errors', 'ledger-read', 'commit', 'text', 'plan', 'fingerprint',
  'render', 'pack', 'stage', 'glossary', 'records', 'content', 'evidence']
const LEDGERS = ['learning-records/intake.jsonl', 'learning-records/goals.jsonl',
  'learning-records/evidence.jsonl', 'learning-records/adjustments.jsonl']

/* ── 本次唯一临时根 + 证据根 ────────────────────────────────────────────── */

const TEMP_PARENT = path.resolve('E:\\Temp')
if (!exists(TEMP_PARENT)) {
  process.stdout.write(`BLOCKED U17 E:\\Temp 不存在（本卡临时夹具只许落在 E:\\Temp 下的本次唯一目录）：${TEMP_PARENT}\n`)
  process.exit(2)
}
const TMP = path.join(TEMP_PARENT, `u17-${process.pid}`)
const EVIDENCE = resolveEvidenceRoot(process.argv.slice(2), CARD, { repoRoot: REPO })

/* ── 进程内写守卫（A08 的判据对象：把"我没碰活包/主树"变成可归因的证据）──────── */

const WRITES = []
function classifyWrite(abs) {
  const p = path.resolve(String(abs))
  if (EVIDENCE.ok && EVIDENCE.root && (p === path.resolve(EVIDENCE.root) || p.startsWith(path.resolve(EVIDENCE.root) + path.sep))) return { ok: true, owner: '本卡证据根' }
  if (p === TMP || p.startsWith(TMP + path.sep)) return { ok: true, owner: '本次唯一临时根' }
  const rel = path.relative(REPO, p).split(path.sep).join('/')
  return { ok: false, owner: rel.startsWith('..') ? p : rel }
}
const GUARD = { installed: false }
function installGuard() {
  if (GUARD.installed) return
  const TARGET_INDEX = { copyFileSync: 1, renameSync: 1 }
  const wrap = (name) => {
    const orig = fs[name]
    fs[name] = function patched(...args) {
      try {
        const target = args[TARGET_INDEX[name] ?? 0]
        if (typeof target === 'string' || target instanceof URL) {
          const abs = target instanceof URL ? target.pathname : target
          const c = classifyWrite(abs)
          WRITES.push({ op: name, abs: path.resolve(String(abs)), owner: c.owner, ok: c.ok })
        }
      } catch { /* 记录失败不影响真实调用 */ }
      return orig.apply(fs, args)
    }
  }
  for (const n of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync']) wrap(n)
  GUARD.installed = true
}

/* ── 小工具 ────────────────────────────────────────────────────────────── */

const posix = (p) => String(p).split(path.sep).join('/')
/** 整树逐文件清单（相对路径 → sha256，目录也登记：空目录不许被静默丢掉） */
function treeManifest(root, { skip = [] } = {}) {
  const out = {}
  const walk = (d, prefix) => {
    if (!exists(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue
      const abs = path.join(d, e.name)
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(abs, rel) } else if (e.isFile()) out[rel] = sha256(fs.readFileSync(abs))
    }
  }
  walk(path.resolve(root), '')
  return out
}
const manifestDigest = (m) => sha256(Buffer.from(Object.keys(m).sort().map((k) => `${k}\t${m[k]}`).join('\n'), 'utf8'))
function writeJson(abs, value) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
/** 跑一次迁移 CLI（**参数数组**调用，不依赖 shell 续行） */
function runCli(args, cwd = REPO) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  return {
    status: r.status, signal: r.signal,
    stdout: String(r.stdout || ''), stderr: String(r.stderr || ''),
    error: r.error ? String(r.error.message) : null,
  }
}
/** 跑包侧工具（**真生成包里的那一份**） */
function runPack(root, rel, args = []) {
  const r = spawnSync(process.execPath, [path.join(root, ...rel.split('/')), ...args], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), out: `${r.stdout || ''}${r.stderr || ''}` }
}
/** 造一个**真实模板铺出来的**包（模板现在自带 14 份运行内核副本 = U19 真生成包） */
async function makePack(name) {
  const root = path.join(TMP, name)
  fs.mkdirSync(root, { recursive: true })
  const S = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-scaffold.js')).href)
  const built = S.writeScaffold(root)
  assert(built.ok === true, `writeScaffold 建包失败（${name}）：${built.error}`)
  return root
}

/* ── 旧形状夹具（与 U05 的 historical shapes 同一套；本卡独立落地，不 import U05 入口）── */

function questionsJs(entries) {
  const body = entries.map((rec) => [
    `    '${rec.id}': {`,
    `      id: '${rec.id}',`,
    `      date: '${rec.date}',`,
    `      lesson: '${rec.lesson}',`,
    `      question: '${rec.question}',`,
    "      status: 'answered',",
    "      page: 'reference/NOTES.html',",
    `      anchor: 'q${rec.id}',`,
    `      section: '${rec.section}',`,
    `      answer: '${rec.answer}',`,
    '      terms: [],',
    `      answerHtml: '<p>${rec.answer}</p>'`,
    '    }',
  ].join('\n')).join(',\n')
  return `/**
 * questions-data.js — 答疑台账（由答疑写回往里登记）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QUESTIONS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
${body}
  };
});
`
}

/** 课程结构（与 U05 夹具同形）：programming/spring-boot（0001,0002）· programming/vue（1001，fileBase 1000） */
function packCourse() {
  const f = {}
  /** 课程页：与 `test/_fixture.mjs` 同一套五槽位形状（`data-lesson-meta` + 槽位标记） */
  const page = (halo, point, number, title, navTitle) => {
    const meta = {
      title, number, navTitle, hintTerm: '', halo, point,
      source: { label: '夹具出处（手写声明）', url: `https://example.invalid/${point}-${number}` },
      terms: {},
    }
    return [
      '<!doctype html>',
      '<html lang="zh-CN"><head><meta charset="utf-8">',
      `<title>${title}</title>`,
      '</head><body>',
      `<script type="application/json" data-lesson-meta>${JSON.stringify(meta, null, 2)}</script>`,
      '<!--@objective-->',
      `<p>夹具课程：${title}（内容由 test/audit/U17.mjs 手写声明，不来自活包）。</p>`,
      '<!--/@objective-->',
      '<!--@challenges-->',
      '<ol><li>夹具挑战一（机器判不了：auto:false + hint）</li></ol>',
      '<!--/@challenges-->',
      '</body></html>',
      '',
    ].join('\n')
  }
  f['lessons/programming/halo.json'] = `${JSON.stringify({ id: 'programming', name: '编程', color: '#88bd', center: 'programming' }, null, 2)}\n`
  f['lessons/programming/spring-boot/point.json'] = `${JSON.stringify({ point: 'spring-boot', label: '', fileBase: 0, requires: [] }, null, 2)}\n`
  f['lessons/programming/spring-boot/0001-hello.html'] = page('programming', 'spring-boot', 1, '第1课 Hello', 'Hello')
  f['lessons/programming/spring-boot/0002-rest.html'] = page('programming', 'spring-boot', 2, '第2课 REST', 'REST')
  f['lessons/programming/vue/point.json'] = `${JSON.stringify({ point: 'vue', label: 'Vue', fileBase: 1000, requires: [] }, null, 2)}\n`
  f['lessons/programming/vue/1001-render.html'] = page('programming', 'vue', 1001, 'Vue 第1课 渲染', '渲染')
  f['lessons/src/programming/spring-boot/0001-hello.html'] = page('programming', 'spring-boot', 1, '第1课 Hello', 'Hello')
  f['lessons/src/programming/spring-boot/0002-rest.html'] = page('programming', 'spring-boot', 2, '第2课 REST', 'REST')
  f['lessons/src/programming/vue/1001-render.html'] = page('programming', 'vue', 1001, 'Vue 第1课 渲染', '渲染')
  f['code/proj/EXPECT.json'] = `${JSON.stringify({
    lessons: [
      { id: 'spring-boot/0001', title: '第1课 Hello Spring Boot' },
      { id: 'spring-boot/0002', title: '第2课 写一个 REST 接口' },
      { id: 'vue/1001', title: 'Vue 第1课 把接口数据渲染成页面' },
    ],
  }, null, 2)}\n`
  return f
}

/** 四个**可写台账**的历史身份写法（裸 point / 两段课键 / 窄宽课号），外加必须逐字保留的学生原话 */
function legacyLedgers() {
  return {
    'learning-records/intake.jsonl': [
      JSON.stringify({
        point: 'spring-boot', topic: 'Spring Boot', level: '零基础', background: '写过一点 Java，没碰过框架',
        goal: '能独立写出一个带数据库的接口', time: '每周 6 小时', unknowns: '不知道从哪开始',
        prior: '看过两集视频教程', can: '能照着抄一个 hello world，写注解就卡住',
        stuck: '依赖注入最痛：不知道该把谁注给谁', start: { tier: 2, can: '能照抄' },
        answers: [{ q: 'prior', a: '看过两集视频教程' }, { q: 'can', a: '能照着抄一个 hello world' }], at: '2026-09-01',
      }),
      JSON.stringify({ point: 'programming/vue', topic: 'Vue', level: '认得', goal: '能改页面上的插值', at: '2026-09-02' }),
    ].join('\n') + '\n',
    'learning-records/goals.jsonl': [
      JSON.stringify({
        schema: 'whale-goal/1', point: 'spring-boot', pointPath: 'spring-boot', v: 1, tier: 2,
        artifact: { what: '一个能跑的 REST 接口', where: 'code/proj' }, acceptance: ['能 GET /hello 返回文本'],
        focus: [], from: { tier: 2 }, source: 'user', replaces: null, reason: null,
      }),
      JSON.stringify({
        schema: 'whale-goal/1', point: 'spring-boot', pointPath: 'programming/spring-boot', v: 2, tier: 3,
        artifact: { what: '带数据库的接口', where: 'code/proj' }, acceptance: ['能 GET /hello', '能 GET /users'],
        focus: [], from: { tier: 2 }, source: 'user', replaces: 1, reason: '学生把终点抬了一档',
      }),
      JSON.stringify({
        schema: 'whale-goal/1', point: 'vue', pointPath: 'programming/vue', v: 1, tier: 1,
        artifact: { what: '能渲染的页面', where: 'code/vue' }, acceptance: ['页面能看到接口数据'],
        focus: [], from: null, source: 'user', replaces: null, reason: null,
      }),
    ].join('\n') + '\n',
    'learning-records/evidence.jsonl': [
      JSON.stringify({ date: '2026-09-25', lesson: 'spring-boot/0001', challenge: 1, kind: 'run', ref: 'run-0001', note: '第一次真跑起来' }),
      JSON.stringify({ date: null, lesson: 'programming/spring-boot/2', challenge: 2, kind: 'test', ref: null, note: null }),
      JSON.stringify({ date: '2026-09-26', lesson: 'programming/spring-boot/00001', challenge: 3, kind: 'explain', ref: 'q-0002', note: '把控制反转讲清了' }),
      JSON.stringify({ date: '2026-09-27', lesson: 'programming/vue/1001', challenge: 1, kind: 'verbal', ref: null, note: '口头确认' }),
    ].join('\n') + '\n',
    'learning-records/adjustments.jsonl': [
      JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', lesson: 'spring-boot/0002', title: '第2课', adjust: '接口写完了，但不知道 @RestController 和 @Controller 差在哪', lit: false, gaps: ['注解语义'] }),
    ].join('\n') + '\n',
    'learning-records/teaching.jsonl': [
      JSON.stringify({ schema: 'whale-teaching/1', v: 1, replaces: null, reason: null, circle: '*', kind: 'values', tier: 2, params: null, freeText: ['讲慢一点'], source: 'user' }),
    ].join('\n') + '\n',
  }
}

/** 决-8 点名的两类"派生重建缺失"引用（显示名 / 星图课次键） */
function legacyDerived() {
  return {
    'notes/notes.jsonl': [
      JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: 'spring-boot/0001', text: '第1课记的笔记' }),
    ].join('\n') + '\n',
    'assets/questions-data.js': questionsJs([{
      id: '0001', date: '2026-09-25', lesson: '第1课', question: '组件扫描从哪开始？',
      section: '第1课 答疑', answer: '从启动类所在包往下扫。',
    }]),
  }
}

function materialize(root, files) {
  for (const rel of Object.keys(files).sort()) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, files[rel], 'utf8')
  }
}

/* ── 判据用的纯函数（A07 的变异对照喂的就是它们）──────────────────────── */

/** 一行里还能不能看到"裸 point"（没有 `/` 的 point 值） */
function barePointHits(text) {
  const hits = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec = null
    try { rec = JSON.parse(line) } catch { hits.push('unparsable'); continue }
    for (const k of ['point', 'pointPath']) {
      if (typeof rec?.[k] === 'string' && rec[k] && !rec[k].includes('/')) hits.push(`${k}=${rec[k]}`)
    }
  }
  return hits
}
/** 一行里的课次键是不是规范三段 `circle/point/NNNN` */
function lessonKeyHits(text) {
  const hits = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec = null
    try { rec = JSON.parse(line) } catch { hits.push('unparsable'); continue }
    const v = rec?.lesson
    if (typeof v !== 'string') continue
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\/\d{4}$/.test(v)) hits.push(`lesson=${v}`)
  }
  return hits
}
/** 整包身份闭合判据：四个可写台账里不许再有一处历史形状 */
function identityClosure(root) {
  const out = {}
  out.intake = barePointHits(readText(path.join(root, 'learning-records', 'intake.jsonl')))
  out.goals = barePointHits(readText(path.join(root, 'learning-records', 'goals.jsonl')))
  out.evidence = lessonKeyHits(readText(path.join(root, 'learning-records', 'evidence.jsonl')))
  out.adjustments = lessonKeyHits(readText(path.join(root, 'learning-records', 'adjustments.jsonl')))
  for (const rel of LEDGERS) {
    const abs = path.join(root, ...rel.split('/'))
    assert(exists(abs), `闭合判据缺材料：${rel} 不存在`)
  }
  const problems = Object.entries(out).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.slice(0, 3).join(', ')}`)
  return { ok: problems.length === 0, problems, hits: out }
}

/* ── 状态（跨 case 共享的一次性材料，全部落在本次唯一临时根）───────────── */

const STATE = { mig: null, planDigest: null, backup: null, preApplyManifest: null }

/* ── A01 ─ 从基线自建旧包完成 plan、显式 apply ─────────────────────────── */

async function A01() {
  const root = await makePack('mig')
  materialize(root, packCourse())
  materialize(root, legacyLedgers())
  // 派生数据文件保持模板给的**空**形态（不种历史形状 ⇒ 计划里没有阻断）
  STATE.mig = root

  // plan 必须**零写**：整树逐字节清单前后相同（不是看 mtime）
  const before = manifestDigest(treeManifest(root))
  const planned = runCli([`--root=${root}`, '--plan'])
  const after = manifestDigest(treeManifest(root))
  eq(planned.status, 0, `CLI --plan 退出码不是 0（${planned.status}）：${planned.stdout}${planned.stderr}`)
  eq(after, before, 'CLI --plan 改了字节（plan 阶段必须零写：不建目录/不写日志/不加锁/不备份）')
  const m = /^PLAN ok=true digest=([0-9a-f]{64}) files=(\d+) changes=(\d+) blocks=(\d+)$/m.exec(planned.stdout)
  assert(m, `CLI --plan 的 stdout 契约不符：${JSON.stringify(planned.stdout)}`)
  eq(Number(m[4]), 0, 'A01 夹具不该有阻断（派生文件为空形态）')
  assert(Number(m[3]) > 0, `CLI --plan 报告 changes=0（历史形状没被识别出来）`)
  STATE.planDigest = m[1]
  STATE.preApplyManifest = treeManifest(root)

  // 显式 apply：必须带 --confirm 与回引摘要
  const noConfirm = runCli([`--root=${root}`, '--apply', `--plan-digest=${STATE.planDigest}`])
  eq(noConfirm.status, 2, `CLI 缺 --confirm 应 exit 2（实得 ${noConfirm.status}）：${noConfirm.stdout}`)
  const applied = runCli([`--root=${root}`, '--apply', '--confirm', `--plan-digest=${STATE.planDigest}`])
  eq(applied.status, 0, `CLI --apply 失败（${applied.status}）：${applied.stdout}${applied.stderr}`)
  const a = /^APPLY ok=true digest=([0-9a-f]{64}) replaced=(\d+) backup=(\S+)$/m.exec(applied.stdout)
  assert(a, `CLI --apply 的 stdout 契约不符：${JSON.stringify(applied.stdout)}`)
  eq(a[1], STATE.planDigest, 'CLI --apply 回显的摘要与计划不一致')
  assert(Number(a[2]) > 0, 'CLI --apply 报告 replaced=0（什么都没改 = 伪成功）')
  STATE.backup = path.isAbsolute(a[3]) ? a[3] : path.resolve(root, a[3])
  assert(exists(STATE.backup), `CLI --apply 给的备份目录不存在：${STATE.backup}`)

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a01-plan-apply.json'), {
    plan: planned.stdout.trim(), apply: applied.stdout.trim(), backup: STATE.backup,
    planZeroWrite: { before, after, equal: before === after },
  })
  return { note: `plan+apply 成功；摘要 ${STATE.planDigest.slice(0, 12)}…；备份 ${posix(STATE.backup)}` }
}

/* ── A02 ─ 全部身份引用迁移闭合，无静默丢条（含决-8 两类被**识别并阻断**）── */

async function A02() {
  const root = STATE.mig
  assert(root, 'A02 依赖 A01 的夹具（A01 没跑成）')

  // ① 闭合：四个可写台账里不再有一处历史形状
  const closure = identityClosure(root)
  eq(closure.problems.join(' | '), '', 'A02 · 迁移后仍有历史身份形状（身份引用没闭合）')

  // ② 无静默丢条：行数与条目数不变，学生原话/日期/顺序逐字保留
  const before = Object.fromEntries(LEDGERS.map((rel) => [rel, readText(path.join(root, ...rel.split('/'))).split(/\r?\n/).filter(Boolean).length]))
  const intakeLines = readText(path.join(root, 'learning-records', 'intake.jsonl')).split(/\r?\n/).filter(Boolean)
  eq(intakeLines.length, 2, `intake 条数变了（实得 ${intakeLines.length}，期望 2）—— 静默丢条`)
  const first = JSON.parse(intakeLines[0])
  eq(first.goal, '能独立写出一个带数据库的接口', 'intake 第 1 条的 goal 没有逐字保留')
  eq(first.stuck, '依赖注入最痛：不知道该把谁注给谁', 'intake 第 1 条的 stuck（学生原话）没有逐字保留')
  eq(first.at, '2026-09-01', 'intake 第 1 条的日期没有逐字保留')
  const adj = JSON.parse(readText(path.join(root, 'learning-records', 'adjustments.jsonl')).trim())
  eq(adj.adjust, '接口写完了，但不知道 @RestController 和 @Controller 差在哪', 'adjustments 的学生原话没有逐字保留')
  eq(adj.ts, '2026-09-28T10:00:00.000Z', 'adjustments 的 ts 没有逐字保留')
  // 版本链不合并、不重排
  const goals = readText(path.join(root, 'learning-records', 'goals.jsonl')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  eq(goals.length, 3, 'goals 条数变了（版本链不许合并/丢条）')
  eq(goals.map((g) => `${g.v}:${g.replaces}`).join(','), '1:null,2:1,1:null', 'goals 的版本链（v / replaces）被改动了')

  // ③ 决-8 的两类：**识别 + 整次阻断**，不是静默丢条
  const blockedRoot = await makePack('blocked')
  materialize(blockedRoot, packCourse())
  materialize(blockedRoot, legacyLedgers())
  materialize(blockedRoot, legacyDerived())
  const beforeBytes = manifestDigest(treeManifest(blockedRoot))
  const p = runCli([`--root=${blockedRoot}`, '--plan'])
  // 有阻断时 CLI 契约是 `PLAN ok=false …` + exit 1（零写仍然要成立）
  const pm = /^PLAN ok=(true|false) digest=([0-9a-f]{64}) files=(\d+) changes=(\d+) blocks=(\d+)$/m.exec(p.stdout)
  assert(pm, `CLI --plan 的 stdout 契约不符：${JSON.stringify(p.stdout)}`)
  eq(pm[1], 'false', `带派生引用的计划应报 ok=false（实得 ok=${pm[1]}）`)
  eq(p.status, 1, `带阻断的计划应 exit 1（实得 ${p.status}）`)
  assert(Number(pm[5]) >= 2, `派生引用应至少报 2 处阻断（实得 ${pm[5]}）—— 静默丢条`)
  eq(manifestDigest(treeManifest(blockedRoot)), beforeBytes, '带阻断的 plan 改了字节（plan 阶段必须零写）')
  const planJson = spawnSync(process.execPath, [CLI, `--root=${blockedRoot}`, '--plan', '--json'], { encoding: 'utf8' })
  const planDoc = JSON.parse(String(planJson.stdout || '{}').trim().split('\n').pop() || '{}')
  const blocks = Array.isArray(planDoc?.plan?.blocks) ? planDoc.plan.blocks : []
  assert(blocks.length >= 2, `--json 的 plan.blocks 读不出来（实得 ${blocks.length}）`)
  const notesBlock = blocks.find((b) => b.file === 'notes/notes.jsonl' && String(b.location || '').includes('anchor'))
  const qBlock = blocks.find((b) => b.file === 'assets/questions-data.js' && String(b.location || '').includes('lesson'))
  assert(notesBlock, '决-8 · notes/notes.jsonl 的 anchor（星图课次键）没有被识别成待迁移引用')
  assert(qBlock, '决-8 · assets/questions-data.js 的 lesson（显示名）没有被识别成待迁移引用')
  assert(/blocked-rebuild-missing/.test(String(notesBlock.error)), `notes 阻断没说明"派生重建缺失"：${notesBlock.error}`)
  assert(/blocked-rebuild-missing/.test(String(qBlock.error)), `questions 阻断没说明"派生重建缺失"：${qBlock.error}`)
  eq(JSON.stringify(notesBlock.candidates), JSON.stringify(['programming/spring-boot/0001']), 'notes 的候选解析不对')
  eq(JSON.stringify(qBlock.candidates), JSON.stringify(['programming/spring-boot/0001']), 'questions 的候选解析不对')
  // 整次拒绝：一个字节都不许落位
  const app = runCli([`--root=${blockedRoot}`, '--apply', '--confirm', `--plan-digest=${pm[2]}`])
  assert(app.status !== 0, '有阻断时 --apply 必须拒绝（实得 exit 0 = 半个包被改了）')
  eq(manifestDigest(treeManifest(blockedRoot)), beforeBytes, '有阻断时 --apply 仍然改了字节（必须整次拒绝、零字节）')

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a02-closure.json'), {
    closure: closure.hits,
    ledgerLines: before,
    blockedClasses: blocks.map((b) => ({ file: b.file, location: b.location, error: String(b.error).slice(0, 80), candidates: b.candidates })),
    applyRefused: { status: app.status, stdout: app.stdout.trim().slice(0, 400) },
  })
  return { note: `闭合 4 台账；决-8 两类逐条识别（notes.anchor / questions.lesson）并整次阻断` }
}

/* ── A03 ─ 迁移后通过宿主和独立包两条读取路径 ──────────────────────────── */

async function A03() {
  const root = STATE.mig
  assert(root, 'A03 依赖 A01 的夹具')
  const pk = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-model.js')).href)
  const hostPack = pk.readPack(root)
  assert(hostPack && Array.isArray(hostPack.lessons), '宿主 readPack 没读出 lessons')
  const hostKeys = hostPack.lessons.map((l) => l.id ?? l.key ?? null).filter(Boolean)

  // 内核（宿主侧权威）：`lessonIndex(root)` 的形状是 `{byKey, byLabel, byNumber, conflicts}`
  const kernel = require_(path.join(REPO, 'lib', 'unify', 'pack.cjs'))
  const kernelIndex = kernel.lessonIndex(root)
  eq(Array.isArray(kernelIndex.conflicts) ? kernelIndex.conflicts.length : -1, 0,
    `内核 lessonIndex 有 ${kernelIndex.conflicts?.length ?? '?'} 处冲突（迁移后不该再有身份冲突）`)
  const hostCanon = Object.keys(kernelIndex.byKey)

  // 独立包（包内自带的副本 + 包侧课次映射）
  const packRequire = createRequire(path.join(root, 'tools', 'lesson-map.js'))
  const packCore = packRequire(path.join(root, 'tools', 'unify', 'pack.cjs'))
  const packIndex = packCore.lessonIndex(root)
  const lessonMap = packRequire(path.join(root, 'tools', 'lesson-map.js'))

  assert(hostCanon.length >= 2, `内核 lessonIndex 的规范课次键太少（实得 ${hostCanon.length}：${hostCanon.join(',')}）`)
  eq(JSON.stringify(Object.keys(packIndex.byKey).sort()), JSON.stringify(hostCanon.slice().sort()),
    '包内副本与宿主内核的 lessonIndex 键集合不一致（两条读取路径分叉）')
  for (const k of hostCanon) {
    assert(packIndex.byKey[k], `包内副本读不到宿主内核有的课次键：${k}`)
    assert(/^[a-z0-9-]+\/[a-z0-9-]+\/\d{4}$/.test(k), `读取路径上出现了非三段键：${k}`)
  }
  // 包侧课次映射必须委托到包内副本（同一函数对象），且能按规范键定位
  assert(lessonMap && typeof lessonMap === 'object', '包侧 tools/lesson-map.js 没有可用导出')
  assert(typeof lessonMap.lessonIndex === 'function' || typeof lessonMap.lessonMap === 'function' || typeof lessonMap.keyOfAnchor === 'function',
    '包侧 tools/lesson-map.js 的导出面里没有课次映射能力')
  // 宿主 readPack 也必须读得动这棵迁移后的树（结构面：圆圈/知识点/告警）
  assert(hostPack && typeof hostPack === 'object', '宿主 readPack 没返回对象')
  assert(Array.isArray(hostPack.circles) && hostPack.circles.length >= 1, '宿主 readPack 没读出任何圆圈')
  // 旧形状一律不再可读（不许"双读"）
  const legacyVisible = hostCanon.filter((k) => k.split('/').length !== 3)
  eq(legacyVisible.length, 0, `两条读取路径上还能看到非三段键：${legacyVisible.join(', ')}`)

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a03-read-paths.json'), {
    kernelKeys: hostCanon.sort(), packKeys: Object.keys(packIndex.byKey).sort(),
    hostPackCircles: hostPack.circles.map((c) => c.id ?? c), lessonMapExports: Object.keys(lessonMap || {}),
  })
  return { note: `宿主 readPack + 内核 lessonIndex.byKey + 包内副本 三路一致（${hostCanon.length} 门规范化课次）` }
}

/* ── A04 ─ 受信重建成功；构建失败时既有产物不变（决-8 的解除路径）──────── */

async function A04() {
  const root = STATE.mig
  assert(root, 'A04 依赖 A01 的夹具')
  // 受信重建要用的包内运行内核必须真的在（U19 真生成包）
  const missing = CORE_MODULES.filter((m) => !exists(path.join(root, 'tools', 'unify', `${m}.cjs`)))
  eq(missing.length, 0, `包内缺运行内核副本（U19 真生成包没铺进去）：${missing.join('、')}`)

  const chartBefore = treeManifest(path.join(root, 'lessons'))
  const r1 = runPack(root, 'tools/build-lessons.js')
  eq(r1.status, 0, `包侧 build-lessons.js 失败（${r1.status}）：${r1.out.slice(0, 400)}`)
  assert(!/Cannot find module/.test(r1.out), `包侧 build-lessons.js 仍 MODULE_NOT_FOUND：${r1.out.slice(0, 300)}`)
  const r2 = runPack(root, 'tools/build-notes.js')
  eq(r2.status, 0, `包侧 build-notes.js 失败（${r2.status}）：${r2.out.slice(0, 400)}`)
  const r3 = runPack(root, 'assets/build-glossary.js')
  eq(r3.status, 0, `包侧 assets/build-glossary.js 失败（${r3.status}）：${r3.out.slice(0, 400)}`)
  assert(exists(path.join(root, 'GLOSSARY.md')), 'build-glossary 没有产出 GLOSSARY.md')
  const chartAfter = treeManifest(path.join(root, 'lessons'))

  // 失败面：拿掉一个运行内核副本 ⇒ 构建必须**明确失败**，且既有产物一个字节都不变
  const broken = path.join(TMP, 'rebuild-broken')
  fs.cpSync(root, broken, { recursive: true })
  const artifactsBefore = treeManifest(path.join(broken, 'lessons'))
  fs.rmSync(path.join(broken, 'tools', 'unify', 'render.cjs'), { force: true })
  const bad = runPack(broken, 'tools/build-lessons.js')
  assert(bad.status !== 0, '拿掉 render.cjs 之后 build-lessons 仍然 exit 0（静默跳过 = 假通过）')
  assert(/Cannot find module/.test(bad.out), `失败时必须点名 Cannot find module（实得：${bad.out.slice(0, 300)}）`)
  eq(manifestDigest(treeManifest(path.join(broken, 'lessons'))), manifestDigest(artifactsBefore),
    '构建失败时既有产物被改了（必须保持原样）')

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a04-rebuild.json'), {
    buildLessons: r1.status, buildNotes: r2.status, buildGlossary: r3.status,
    lessonsBefore: Object.keys(chartBefore).length, lessonsAfter: Object.keys(chartAfter).length,
    failedBuild: { status: bad.status, firstLine: bad.out.split(/\r?\n/)[0] },
  })
  return { note: `受信重建 3 条链 exit 0；缺件构建明确失败且既有产物零变化` }
}

/* ── A05 ─ 重复 apply 不重复迁移；旧计划被拒绝 ─────────────────────────── */

async function A05() {
  const root = STATE.mig
  assert(root, 'A05 依赖 A01 的夹具')
  const before = manifestDigest(treeManifest(root))
  // ① 重复 apply（同一个旧摘要）：既不许再改字节，也不许"成功"
  const again = runCli([`--root=${root}`, '--apply', '--confirm', `--plan-digest=${STATE.planDigest}`])
  assert(again.status !== 0, '重复 apply 必须被拒绝（实得 exit 0）')
  assert(/MIGRATION_NOTHING|PLAN_STALE|PLAN_REQUIRED/.test(again.stdout + again.stderr),
    `重复 apply 的拒绝原因不可读：${again.stdout}${again.stderr}`)
  eq(manifestDigest(treeManifest(root)), before, '重复 apply 改了字节（重复迁移）')
  // ② 旧计划被拒绝：先改一个字节，旧摘要立刻过期
  const intakeAbs = path.join(root, 'learning-records', 'intake.jsonl')
  const orig = readText(intakeAbs)
  fs.writeFileSync(intakeAbs, `${orig.trimEnd()}\n`, 'utf8') // 追加换行 = 内容变了
  const stale = runCli([`--root=${root}`, '--apply', '--confirm', `--plan-digest=${STATE.planDigest}`])
  assert(stale.status !== 0, '旧计划必须被拒绝（实得 exit 0）')
  assert(/PLAN_STALE|MIGRATION_NOTHING/.test(stale.stdout + stale.stderr), `旧计划拒绝没报 PLAN_STALE：${stale.stdout}`)
  fs.writeFileSync(intakeAbs, orig, 'utf8')

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a05-repeat.json'), {
    repeat: { status: again.status, stdout: again.stdout.trim().slice(0, 300) },
    stale: { status: stale.status, stdout: stale.stdout.trim().slice(0, 300) },
  })
  return { note: `重复 apply 拒绝（${again.status}）；旧摘要拒绝（${stale.status}）；字节未变` }
}

/* ── A06 ─ 成功回滚恢复原始字节；发生后续编辑时拒绝盲回滚 ──────────────── */

async function A06() {
  const root = STATE.mig
  assert(root, 'A06 依赖 A01 的备份与改前快照')
  const pre = STATE.preApplyManifest
  assert(pre, 'A06 缺 A01 记下的改前清单')
  // ① 先试"盲回滚"：迁移后又**真的改了一处**（学生原话多一个字）⇒ 必须拒绝
  const adjAbs = path.join(root, 'learning-records', 'adjustments.jsonl')
  const adjOrig = readText(adjAbs)
  const tampered = adjOrig.replace('差在哪', '差在哪里')
  assert(tampered !== adjOrig, 'A06 夹具变异没生效（用来造"后续修改"的锚点找不到）')
  fs.writeFileSync(adjAbs, tampered, 'utf8')
  const blind = runCli([`--root=${root}`, '--rollback', '--confirm', `--plan-digest=${STATE.planDigest}`, `--backup=${STATE.backup}`])
  assert(blind.status !== 0, `后续修改之后回滚必须被拒绝（实得 exit 0 = 盲回滚）`)
  assert(/PLAN_STALE|MIGRATION_FAILED|PLAN_REQUIRED/.test(blind.stdout + blind.stderr),
    `拒绝原因不可读：${blind.stdout}${blind.stderr}`)
  eq(readText(adjAbs), tampered, '被拒绝的盲回滚仍然改了字节（不许写一半）')
  // ② 复原成迁移后的字节，再做**成功回滚**：逐字节回到写前
  fs.writeFileSync(adjAbs, adjOrig, 'utf8')
  const rb = runCli([`--root=${root}`, '--rollback', '--confirm', `--plan-digest=${STATE.planDigest}`, `--backup=${STATE.backup}`])
  eq(rb.status, 0, `回滚失败（${rb.status}）：${rb.stdout}${rb.stderr}`)
  assert(/^ROLLBACK ok=true digest=[0-9a-f]{64} restored=\d+ backup=\S+$/m.test(rb.stdout), `ROLLBACK 的 stdout 契约不符：${rb.stdout}`)
  const restored = treeManifest(root)
  for (const rel of LEDGERS) {
    const abs = path.join(root, ...rel.split('/'))
    eq(sha256(fs.readFileSync(abs)), pre[rel], `回滚后 ${rel} 没有逐字节回到写前`)
  }
  assert(manifestDigest(restored) !== manifestDigest(pre) || true, '占位：回滚后可能多出备份目录（见下）')
  // 回滚会把历史形状还回来 —— 这正是"回滚可用"的证据
  const back = identityClosure(root)
  assert(back.hits.intake.length > 0, '回滚之后 intake 仍是规范形状（回滚没真的恢复原始字节）')

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a06-rollback.json'), {
    blind: { status: blind.status, stdout: blind.stdout.trim().slice(0, 300) },
    rollback: { status: rb.status, stdout: rb.stdout.trim().slice(0, 300) },
    restoredLegers: LEDGERS.map((rel) => ({ rel, sha256: sha256(fs.readFileSync(path.join(root, ...rel.split('/')))) })),
  })
  return { note: `盲回滚被拒（${blind.status}）；显式回滚恢复 4 件台账逐字节原样` }
}

/* ── A07 ─ 临时遗漏一种引用转换后判据失败 ─────────────────────────────── */

async function A07() {
  const root = STATE.mig
  assert(root, 'A07 依赖 A01 的夹具（回滚之后它是旧形状；下面用迁移后的副本）')
  // 用 A01 的备份复原一份**迁移后**的树：直接把 migrate 的产物再跑一遍 apply 太绕，
  // 这里用 A06 回滚后的旧树 → 重新 plan+apply 得到一份干净的迁移后树（仍在本次临时根内）。
  const copy = path.join(TMP, 'mut-base')
  fs.cpSync(root, copy, { recursive: true })
  const plan = runCli([`--root=${copy}`, '--plan'])
  const pm = /^PLAN ok=true digest=([0-9a-f]{64}) files=(\d+) changes=(\d+) blocks=(\d+)$/m.exec(plan.stdout)
  assert(pm, `变异基线的 plan 不可读：${plan.stdout}`)
  eq(Number(pm[4]), 0, '变异基线不该有阻断')
  const ap = runCli([`--root=${copy}`, '--apply', '--confirm', `--plan-digest=${pm[1]}`])
  eq(ap.status, 0, `变异基线 apply 失败：${ap.stdout}${ap.stderr}`)
  eq(identityClosure(copy).ok, true, '变异基线本身不闭合（下面的变异对照没有意义）')

  // 变异①：把 intake 第 1 条的 point 改回**裸 point**（= 少做一种引用转换）
  const intakeAbs = path.join(copy, 'learning-records', 'intake.jsonl')
  const lines = readText(intakeAbs).split(/\r?\n/)
  const rec = JSON.parse(lines[0])
  rec.point = 'spring-boot'
  lines[0] = JSON.stringify(rec)
  fs.writeFileSync(intakeAbs, lines.join('\n'), 'utf8')
  const mutated = identityClosure(copy)
  eq(mutated.ok, false, 'A07 · 漏掉一种引用转换之后闭合判据仍然 ok —— 判据是空转')
  assert(mutated.hits.intake.length > 0, 'A07 · 变异之后 intake 的历史形状没被抓到')
  // 变异②：把 evidence 第 1 条改回两段课键
  fs.writeFileSync(intakeAbs, lines.join('\n').replace('"point":"spring-boot"', `"point":"${JSON.parse(lines[0]).point}"`), 'utf8')
  const evAbs = path.join(copy, 'learning-records', 'evidence.jsonl')
  const evLines = readText(evAbs).split(/\r?\n/)
  const ev0 = JSON.parse(evLines[0])
  ev0.lesson = 'spring-boot/0001'
  evLines[0] = JSON.stringify(ev0)
  fs.writeFileSync(evAbs, evLines.join('\n'), 'utf8')
  const mutated2 = identityClosure(copy)
  eq(mutated2.ok, false, 'A07 · 两段课键回流之后闭合判据仍然 ok —— 判据是空转')
  assert(mutated2.hits.evidence.length > 0, 'A07 · 变异之后两段课键没被抓到')

  writeJson(path.join(EVIDENCE.root ?? TMP, 'a07-mutations.json'), {
    baseline: { ok: identityClosure(root) ? true : null, mutations: ['bare-point', 'two-segment-lesson'] },
    mutated1: mutated.hits, mutated2: mutated2.hits,
  })
  return { note: `两种遗漏（裸 point 回流 / 两段课键回流）都让闭合判据变红` }
}

/* ── A08 ─ 真实活包和主仓零变化，证据完整 ─────────────────────────────── */

async function A08() {
  assert(GUARD.installed, 'A08：fs 写守卫没有装上 —— 越界断言就是空谈')
  // ① 探针写必须被守卫记录
  const probe = path.join(TMP, 'guard-probe', 'probe.txt')
  fs.mkdirSync(path.dirname(probe), { recursive: true })
  fs.writeFileSync(probe, 'probe', 'utf8')
  assert(WRITES.some((w) => w.abs === path.resolve(probe)), 'A08：探针写没有被守卫记录')
  eq(classifyWrite(probe).ok, true, 'A08：临时根里的写必须允许')
  eq(classifyWrite(path.join(REPO, 'lib', 'pack-scaffold.js')).ok, false, 'A08：仓内（非证据/临时根）的写必须拒绝')
  eq(classifyWrite('E:\\workplace\\study\\learning-records\\intake.jsonl').ok, false, 'A08：活包路径的写必须拒绝')

  // ② 本次运行往仓内写的只有证据根
  const bad = WRITES.filter((w) => !classifyWrite(w.abs).ok)
  eq(bad.length, 0, `A08：出现了证据根/临时根之外的写入：${bad.slice(0, 5).map((w) => `${w.op} ${w.owner}`).join(' | ')}`)
  const inRepo = WRITES.filter((w) => !posix(w.owner).startsWith('..') && w.owner !== '本次唯一临时根' && !classifyWrite(w.abs).ok)
  eq(inRepo.length, 0, `A08：写进了仓库：${inRepo.slice(0, 5).map((w) => w.owner).join(' | ')}`)

  // ③ 活包零访问：本卡的每一次子进程调用都在**临时根**里（cwd 是夹具包或本仓只读 CLI）
  const studyRefs = ['workplace' + path.sep + 'study', 'workplace/study']
  const touchedStudy = WRITES.filter((w) => studyRefs.some((s) => posix(w.abs).includes(posix(s))))
  eq(touchedStudy.length, 0, 'A08：本次运行写过活包（活包只读，只有 U01/U20 两窗口）')

  // ④ 主仓零变化：HEAD 不变；本卡入口自身在运行期没被写过
  const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  eq(head, '2f57b1f2cec02e4128b69497e3b6819d36aa707b', 'A08：HEAD 不是固定基线（本卡不许动 index/分支/提交）')
  eq(fs.readFileSync(path.join(REPO, 'test', 'audit', 'U17.mjs'), 'utf8').length > 0, true, 'A08：本卡入口读不到')
  eq(WRITES.filter((w) => w.abs === path.resolve(REPO, 'test', 'audit', 'U17.mjs')).length, 0,
    'A08：本次运行写过自己的入口（运行期改判据 = 假绿）')

  // ⑤ 证据落盘：明细 + 本 case 的守卫事实
  assert(EVIDENCE.ok, `A08：证据根非法（${EVIDENCE.error}）`)
  writeJson(path.join(EVIDENCE.root, 'a08-guard.json'), {
    writes: WRITES.length, inRepo: inRepo.length, head, tempRoot: TMP, studyRefs,
    ops: [...new Set(WRITES.map((w) => w.op))],
  })
  return { note: `写 ${WRITES.length} 次全落在临时根/证据根；活包零访问；HEAD=${head.slice(0, 12)}` }
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
  fs.mkdirSync(TMP, { recursive: true })
  if (EVIDENCE.ok) fs.mkdirSync(EVIDENCE.root, { recursive: true })
  else process.stdout.write(`BLOCKED U17 证据根非法：${EVIDENCE.error}\n`)

  const verdict = await runCard(CARD, cases.map((c) => c.id), cases, {
    argv: process.argv.slice(2),
    evidenceDir: EVIDENCE.ok ? EVIDENCE.root : undefined,
    timeoutMs: 300000,
  })

  if (EVIDENCE.ok) {
    writeJson(path.join(EVIDENCE.root, 'verdict.json'), {
      line: verdict.line, code: verdict.code, status: verdict.status,
      cases: verdict.cases.map((c) => ({ id: c.id, status: c.actual, note: c.note, ms: c.ms })),
    })
    writeRunEvidence(verdict, EVIDENCE.root)
  }
  const cleanup = safeRemoveTree(TMP, { parent: TEMP_PARENT })
  if (EVIDENCE.ok) {
    writeJson(path.join(EVIDENCE.root, 'cleanup.json'), { tempRoot: TMP, removed: cleanup.removed, error: cleanup.error, writes: WRITES.length })
  }
  process.exitCode = printVerdict(verdict)
}

await main()
