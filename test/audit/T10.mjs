#!/usr/bin/env node
/**
 * T10 —— 宿主账本入口接入统一事务（报告 C01 / 计划 §6 T10）
 * ==================================================================
 * 卡面验收判据（原文）：
 *   「每个 IO 步骤分别注入 EACCES/ENOSPC/rename 失败，并模拟进程中断后恢复；
 *     两进程并发写 N 条，断言全部保留、序号唯一、版本无冲突。并发压力测试本次未执行。」
 * 补充（原文）：逐入口故障矩阵及双进程测试；笔记第二次写失败必须原树恢复，
 *   问答不得只递增 seq 而未入队；教学/终点版本无冲突。已有记录前缀字节不变。
 *   重建必须在释放锁后启动，防子进程等锁死锁。
 *
 * 本文件只碰**自建夹具**（`E:/Temp/whale-T10-*`）：不写用户活包 `E:/workplace/study`、
 * 不写只读快照。子进程一律 `stdio:'ignore'` + 结果走 report 文件。
 *
 * 为什么每个断言都走**产品入口**（appendNote / handleAsk / handleAnswer / recordGoal /
 * recordTeaching / recordIntake / writeTermSurgically）：T10 的漏洞是"入口绕过事务"，
 * 只测事务件会漏掉"忘了接线"这一整类。故障 fs 通过入口的 `txn` 参数注入（生产不传）。
 *
 * 负向控制（`T10-negative-controls`）：把 `ba22c94` 的六个**旧实现**拷进临时副本，
 * 在同一夹具上真跑一遍，证明旧行为（笔记半提交 / 问答只递增 seq）确实会被本套件抓住；
 * 产品文件一个字节都不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarness, REPO, clip } from './harness.mjs'
import { appendNote, NOTES_REL } from '../../lib/notes-io.js'
import { handleAsk, handleAnswer, askPaths } from '../../lib/ask-io.js'
import { recordGoal, readGoals, goalsPath } from '../../lib/goal-io.js'
import { recordTeaching, readTeaching, teachingPath, GLOBAL_CIRCLE } from '../../lib/teaching-io.js'
import { recordIntake, readIntake, intakePath } from '../../lib/intake.js'
import { writeTermSurgically, LEDGER_REL } from '../../lib/glossary-edit-io.js'
import { emptyLedgerSource } from '../../lib/ask.js'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const TXN_ABS = path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs')
const TXN = require_(TXN_ABS)
const BASELINE = 'ba22c948016142482f92d054f033c7dec25f2f83'
const LIVE_PACK = 'E:/workplace/study'
const CLOCK = () => '2026-10-17T00:00:00.000Z'

/** 固定用例 ID 全集（**不许漂移**：缺一条、多一条、重一条都算失败） */
export const IDS = [
  // 笔记：正常提交 / 前缀 / 自检 / 四个 IO 步骤 / 第二次写失败 / 真杀恢复
  'T10-notes-commit',
  'T10-notes-prefix',
  'T10-notes-selfcheck-rejected',
  'T10-notes-eacces-temp',
  'T10-notes-enospc-backup',
  'T10-notes-enospc-journal',
  'T10-notes-rename-seq-second',
  'T10-crash-notes-recover',
  // 问答：正常提交 / 前缀 / 四个 IO 步骤 / 只递增 seq 的回归 / 真杀恢复
  'T10-ask-commit',
  'T10-ask-prefix',
  'T10-ask-eacces-temp',
  'T10-ask-enospc-backup',
  'T10-ask-enospc-journal',
  'T10-ask-rename-pending-second',
  'T10-crash-ask-recover',
  // 已答台账：正常提交 / 前缀 / 四个 IO 步骤
  'T10-answer-commit',
  'T10-answer-prefix',
  'T10-answer-eacces-temp',
  'T10-answer-enospc-backup',
  'T10-answer-enospc-journal',
  'T10-answer-eacces-rename',
  // 终点：版本线 + 四个 IO 步骤
  'T10-goal-commit-version',
  'T10-goal-eacces-temp',
  'T10-goal-enospc-backup',
  'T10-goal-enospc-journal',
  'T10-goal-eacces-rename',
  // 教学：版本线 + 四个 IO 步骤
  'T10-teaching-commit-version',
  'T10-teaching-eacces-temp',
  'T10-teaching-enospc-backup',
  'T10-teaching-enospc-journal',
  'T10-teaching-eacces-rename',
  // 摸底：追加 + 四个 IO 步骤
  'T10-intake-commit',
  'T10-intake-eacces-temp',
  'T10-intake-enospc-backup',
  'T10-intake-enospc-journal',
  'T10-intake-eacces-rename',
  // 术语：正常提交 / 自检 / 四个 IO 步骤
  'T10-glossary-commit',
  'T10-glossary-selfcheck-rejected',
  'T10-glossary-eacces-temp',
  'T10-glossary-enospc-backup',
  'T10-glossary-enospc-journal',
  'T10-glossary-eacces-rename',
  // 跨入口
  'T10-error-shape-state',
  'T10-rebuild-after-lock',
  'T10-concurrent-two-process',
  'T10-source-wired',
  'T10-negative-controls',
  'T10-cleanup-guard',
]

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}

/** 术语台账夹具（UMD，与真包同形） */
const GLOSSARY_SRC = `(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
}(this, function () {
  return {
    body: {
      label: '响应体',
      category: 'Web 基础',
      official: '官方',
      short: '大白话',
      analogy: '类比',
      lesson: '第1课'
    }
  };
}));
`

/** 固定输入（各入口共用） */
const goalInput = (writer = 0, i = 0) => ({
  point: 'spring-boot',
  pointPath: 'programming/spring-boot',
  tier: 2,
  source: 'agent',
  artifact: { what: `作品 w${writer}-${i}`, where: null },
  acceptance: [{ no: 1, deliverable: '能说清', auto: false, hint: '老师确认' }],
  focus: null,
  reason: null,
})
const teachingInput = (i = 0) => ({
  circle: GLOBAL_CIRCLE,
  kind: 'values',
  tier: 1,
  params: { explainOrder: i % 2 ? 'detail-first' : 'overview-first' },
  source: 'student',
})
const intakeInput = (i = 0) => ({ point: 'spring-boot', level: `L${i}`, goal: `G${i}` })
const answerBody = (id, question = '学生原话') => JSON.stringify({
  id, question, answer: `解答 ${id}`, answerHtml: `<p>解答 ${id}</p>`,
})

// ================================================================ 子进程（夹具写者）
async function worker() {
  const mode = arg('mode')
  const root = arg('root')
  const report = arg('report')
  const out = { mode, pid: process.pid, root }
  try {
    if (mode === 'crash') {
      const entry = arg('entry')
      const marker = arg('marker')
      // 真杀在**提交点之前**：所有目标都已 rename 落位，但 journal 还停在 prepared
      // （第 2 次写 journal = committed 标记）。恢复必须把两件都还原成原状态。
      const real = fs
      let journalWrites = 0
      const killFs = {
        ...real,
        writeFileSync: (p, data, o) => {
          if (String(p).includes('journal.json')) {
            journalWrites += 1
            if (journalWrites === 2) {
              try { fs.writeFileSync(marker, 'killed\n', 'utf8') } catch { /* best effort */ }
              process.kill(process.pid, 'SIGKILL')
              process.abort()
              process.exit(99)
            }
          }
          return real.writeFileSync(p, data, o)
        },
      }
      if (entry === 'ask') {
        const r = await handleAsk(root, { raw: JSON.stringify({ question: '崩溃前的问题' }), now: CLOCK, txn: { fs: killFs } })
        out.result = r
      } else {
        out.result = appendNote({ root, text: '崩溃前的笔记', anchor: '第1课', txn: { fs: killFs } })
      }
    } else if (mode === 'concurrent') {
      const writer = Number(arg('writer'))
      const n = Number(arg('n') || '20')
      out.done = 0
      out.failed = []
      out.maxAttempts = 0
      const ops = (i) => [
        ['note', () => appendNote({ root, text: `T10 note w${writer} i${i}`, anchor: '第1课' })],
        ['ask', () => handleAsk(root, { raw: JSON.stringify({ question: `T10 ask w${writer} i${i}` }), now: CLOCK })],
        ['goal', () => recordGoal(root, goalInput(writer, i))],
        ['teaching', () => recordTeaching(root, teachingInput(i))],
        ['intake', () => recordIntake(root, intakeInput(i))],
      ]
      for (let i = 0; i < n; i++) {
        let bad = null
        for (const [name, fn] of ops(i)) {
          const r = await retryBusy(fn)
          out.maxAttempts = Math.max(out.maxAttempts, r.attempts || 0)
          if (!r.ok) { bad = { name, i, state: r.state, error: r.error }; break }
        }
        if (bad) { out.failed.push(bad); break }
        out.done++
      }
    } else {
      throw new Error(`未知 worker 模式：${mode}`)
    }
  } catch (e) {
    out.crash = `${e && e.code ? e.code + ': ' : ''}${e && e.message ? e.message : String(e)}`
    out.stack = e && e.stack
  }
  if (report) writeJson(report, out)
  process.exit(out.crash || (out.failed && out.failed.length) ? 1 : 0)
}

/** 入口成功判定（形状各不相同，集中在这里，别在断言里各推一遍） */
function okOf(kind, r) {
  if (kind === 'ask' || kind === 'answer') return !!(r && r.status === 200 && r.body && r.body.ok === true)
  return !!(r && r.ok === true)
}
function stateOf(kind, r) {
  if (kind === 'ask' || kind === 'answer') return r?.body?.state ?? null
  return r?.state ?? null
}
function errorOf(kind, r) {
  if (kind === 'ask' || kind === 'answer') return r?.body?.error ?? null
  return r?.error ?? null
}

/** 起一个子进程（**stdio 忽略**：结果走 report 文件；并发测试必须用异步 spawn，不能 spawnSync 串行化） */
function spawnWorker(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...args], { cwd: REPO, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, timeoutMs)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, pid: child.pid }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, pid: child.pid, error: String(e && e.message ? e.message : e) }) })
  })
}

/** busy 是**可重试**的状态（不自动强抢锁），夹具写者按正常用法重试；其它失败立即收手 */
async function retryBusy(fn) {
  const deadline = Date.now() + 60000
  let attempts = 0
  while (Date.now() < deadline) {
    attempts++
    let r
    try { r = await fn() } catch (e) { r = { ok: false, state: e.txnState || 'threw', error: e.message } }
    const kind = r && r.body && typeof r.body.ok === 'boolean' ? 'ask' : 'plain'
    if (okOf(kind, r)) return { ok: true, attempts }
    const st = stateOf(kind, r)
    if (st === 'busy') { sleepSync(2); continue }
    return { ok: false, state: st, error: errorOf(kind, r), attempts }
  }
  return { ok: false, state: 'timeout', error: 'busy 重试超时', attempts }
}

// ================================================================ 父进程（判据）
async function main() {
  const h = createHarness({ card: 'T10', expectedIds: IDS, root: REPO })
  const stamp = `${Date.now()}-${process.pid}`
  const evidence = path.join(REPO, 'audit-evidence', 'T10')
  fs.mkdirSync(evidence, { recursive: true })
  let temp
  try {
    fs.mkdirSync('E:/Temp', { recursive: true })
    temp = fs.mkdtempSync(`E:/Temp/whale-T10-${stamp}-`)
  } catch (e) {
    h.block(`临时夹具环境不可用（E:/Temp 建不出来）：${String(e && e.message ? e.message : e).replace(/\s+/g, ' ')}`)
    process.exitCode = h.run()
    return
  }
  h.note(`fixture=${temp}\nbase=${BASELINE}\ntxn=${TXN_ABS}`)

  const checks = []
  const check = (id, fn) => {
    const entry = { id: String(id), expected: 'pass', actual: null, note: '', detail: null }
    h.cases.push(entry)
    checks.push({ id: String(id), entry, fn })
  }

  // ---------------------------------------------------------------- 夹具小工具
  const makePack = (name) => {
    const dir = path.join(temp, name)
    for (const d of ['lessons/src/pt', 'lessons/pt', 'code/proj', 'notes', 'questions', 'learning-records', 'assets', 'tools']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true })
    }
    fs.writeFileSync(path.join(dir, 'lessons', 'src', 'pt', '0001-a.html'), '<html></html>\n')
    fs.writeFileSync(path.join(dir, 'lessons', 'pt', '0001-a.html'), '<html></html>\n')
    fs.writeFileSync(path.join(dir, 'code', 'proj', 'EXPECT.json'), JSON.stringify({ lessons: [{ id: 'pt/0001', title: '第1课' }] }))
    fs.writeFileSync(path.join(dir, 'assets', 'questions-data.js'), emptyLedgerSource(''), 'utf8')
    fs.writeFileSync(path.join(dir, 'assets', 'glossary-data.js'), GLOSSARY_SRC, 'utf8')
    return dir
  }
  const dirFiles = (dir) => {
    const out = []
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(d, e.name), r)
        else out.push(`${r}\t${sha(path.join(d, e.name))}`)
      }
    }
    walk(dir, '')
    return out.join('\n')
  }
  const txnDirs = (dir) => {
    const p = path.join(dir, '.whale-txn')
    return fs.existsSync(p) ? fs.readdirSync(p).sort() : []
  }
  const lockExists = (dir) => fs.existsSync(path.join(dir, '.whale-write.lock'))
  const assertClean = (dir) => {
    h.eq(lockExists(dir), false, '提交/回滚后不留锁')
    h.eq(txnDirs(dir).length, 0, '提交/回滚后不留事务日志')
  }
  const evidenceOf = (name, payload) => h.evidence(
    path.join('cases', `${name}.txt`),
    clip(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 20000),
  )

  /**
   * 故障 fs：按 `op` + 路径片段注入错误。
   * `after:true` = 先让这次操作真的落位，再报错（模拟"rename 成功但调用点看到失败"，
   * 用来覆盖备份步骤；否则备份没写出来，回滚会因缺备份而永远恢复不了）。
   */
  const faultFs = ({ op, includes, includes2, code = 'EACCES', after = false }) => {
    const real = fs
    let fired = false
    const hit = (s) => {
      if (fired) return false
      const str = String(s)
      if (!str.includes(includes)) return false
      if (includes2 && !str.includes(includes2)) return false
      fired = true
      return true
    }
    const raise = () => {
      const e = new Error(`injected ${code} at ${op}`)
      e.code = code
      throw e
    }
    if (op === 'writeFileSync') {
      return {
        ...real,
        writeFileSync: (p, data, o) => {
          if (hit(p)) raise()
          return real.writeFileSync(p, data, o)
        },
      }
    }
    if (op === 'renameSync') {
      return {
        ...real,
        renameSync: (a, b) => {
          if (hit(b)) {
            if (after) { real.renameSync(a, b); raise() }
            raise()
          }
          return real.renameSync(a, b)
        },
      }
    }
    throw new Error(`未知故障 op：${op}`)
  }
  const txnFor = (fault) => ({ fs: faultFs(fault), ownerToken: 'executor-t10' })

  // 入口调用器：统一捕获"抛出型"（笔记 / 术语）与"回执型"（其余）失败
  const callNote = (root, fault) => {
    try {
      const r = appendNote({ root, text: '故障笔记', anchor: '第1课', txn: txnFor(fault) })
      return { ok: r.ok, state: r.state || null, error: r.error || null, rolledBack: r.rolledBack === true }
    } catch (e) {
      return { ok: false, state: e.txnState || null, error: e.message, httpStatus: e.httpStatus }
    }
  }
  const callAsk = async (root, fault) => {
    const r = await handleAsk(root, { raw: JSON.stringify({ question: '故障问题' }), now: CLOCK, txn: txnFor(fault) })
    return { ok: r.status === 200, status: r.status, state: r.body.state || null, error: r.body.error || null }
  }
  const callAnswer = async (root, fault, id = '0004') => {
    const r = await handleAnswer(root, {
      raw: answerBody(id), now: CLOCK, rebuild: false, trustedEngine: false, txn: txnFor(fault),
    })
    return { ok: r.status === 200, status: r.status, state: r.body.state || null, error: r.body.error || null }
  }
  const callGoal = (root, fault) => {
    const r = recordGoal(root, goalInput(), txnFor(fault))
    return { ok: r.ok, state: r.state || null, error: r.error || null, rollbackError: r.rollbackError ?? null }
  }
  const callTeaching = (root, fault) => {
    const r = recordTeaching(root, teachingInput(), txnFor(fault))
    return { ok: r.ok, state: r.state || null, error: r.error || null, rollbackError: r.rollbackError ?? null }
  }
  const callIntake = (root, fault) => {
    const r = recordIntake(root, intakeInput(), txnFor(fault))
    return { ok: r.ok, state: r.state || null, error: r.error || null, rollbackError: r.rollbackError ?? null }
  }
  const callGlossary = (root, fault, key = 'whaletest') => {
    try {
      const r = writeTermSurgically({
        root, key, record: { label: '测试词', category: 'Web 基础', official: 'O', short: 'S', analogy: 'A', lesson: '第2课' }, txn: txnFor(fault),
      })
      return { ok: r.ok, state: r.state || null, error: r.error || null, rolledBack: r.rolledBack === true }
    } catch (e) {
      return { ok: false, state: e.txnState || null, error: e.message, httpStatus: e.httpStatus }
    }
  }

  /** 回滚成功的通用断言：state=rolled-back、原树逐字节不变、锁与日志都不留 */
  const assertRolledBack = (label, dir, before, res, code) => {
    h.eq(res.ok, false, `${label}：失败不是成功`)
    h.eq(res.state, 'rolled-back', `${label}：state（error=${res.error}）`)
    h.eq(String(res.error || '').includes(code), true, `${label}：错误如实带 ${code}（${res.error}）`)
    h.eq(dirFiles(dir), before, `${label}：夹具目录逐字节回到写前（含台账与 seq/pending）`)
    assertClean(dir)
  }

  // ================================================================ ① 笔记
  check('T10-notes-commit', () => {
    const dir = makePack('notes-commit')
    const r = appendNote({ root: dir, text: '第一条', anchor: '第1课' })
    h.eq(r.ok, true, `appendNote ok（error=${r.error || ''}）`)
    h.eq(r.id, '0001', 'id=0001')
    h.eq(r.seq, 1, 'seq=1')
    const rows = fs.readFileSync(path.join(dir, NOTES_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    h.eq(rows.length, 1, '台账一行')
    h.eq(rows[0].anchor, 'pt/0001', 'anchor 归一成星图键')
    h.eq(fs.readFileSync(path.join(dir, 'notes', 'seq.txt'), 'utf8'), '1\n', 'seq 与台账同一写集')
    assertClean(dir)
  })

  check('T10-notes-prefix', () => {
    const dir = makePack('notes-prefix')
    const oldLine = '{"id":"0001","seq":1,"kind":"笔记","anchor":"pt/0001","text":"旧记录"}\n'
    fs.writeFileSync(path.join(dir, NOTES_REL), oldLine, 'utf8')
    fs.writeFileSync(path.join(dir, 'notes', 'seq.txt'), '1\n', 'utf8')
    const r = appendNote({ root: dir, text: '第二条', anchor: '第1课' })
    h.assert(r.ok === true && r.id === '0002', `新记录接着排（${r.id}）`)
    const after = fs.readFileSync(path.join(dir, NOTES_REL), 'utf8')
    h.eq(after.startsWith(oldLine), true, '已有记录前缀字节原样保留')
    h.eq(after.trim().split('\n').length, 2, '两条都在')
    assertClean(dir)
  })

  check('T10-notes-selfcheck-rejected', () => {
    const dir = makePack('notes-selfcheck')
    const before = dirFiles(dir)
    const r = appendNote({ root: dir, text: '会写坏', anchor: '第1课', corrupt: true })
    h.eq(r.ok, false, '自检不过 → ok:false')
    h.eq(r.rolledBack, true, '回执明确 rolledBack')
    h.eq(r.state, 'rejected', `回执带明确事务 state（${r.state}）`)
    h.eq(/写后自检没过/.test(String(r.error)), true, `错误说清是自检（${r.error}）`)
    h.eq(dirFiles(dir), before, '自检不过时**一个字节都没写**')
    assertClean(dir)
  })

  check('T10-notes-eacces-temp', () => {
    const dir = makePack('notes-fault-temp')
    const before = dirFiles(dir)
    const res = callNote(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'notes.jsonl', code: 'EACCES' })
    assertRolledBack('笔记暂存失败', dir, before, res, 'EACCES')
    evidenceOf('notes-eacces-temp', { res, files: dirFiles(dir) })
  })

  check('T10-notes-enospc-backup', () => {
    const dir = makePack('notes-fault-backup')
    const before = dirFiles(dir)
    const res = callNote(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('笔记备份失败', dir, before, res, 'ENOSPC')
    evidenceOf('notes-enospc-backup', { res })
  })

  check('T10-notes-enospc-journal', () => {
    const dir = makePack('notes-fault-journal')
    const before = dirFiles(dir)
    const res = callNote(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('笔记 journal(prepared) 失败', dir, before, res, 'ENOSPC')
    evidenceOf('notes-enospc-journal', { res })
  })

  check('T10-notes-rename-seq-second', () => {
    const dir = makePack('notes-fault-rename-seq')
    const oldLine = '{"id":"0001","seq":1,"kind":"笔记","anchor":"pt/0001","text":"旧记录"}\n'
    fs.writeFileSync(path.join(dir, NOTES_REL), oldLine, 'utf8')
    fs.writeFileSync(path.join(dir, 'notes', 'seq.txt'), '1\n', 'utf8')
    const before = dirFiles(dir)
    // 计划顺序 = [notes, seq]：notes 已 rename 落位、seq rename 失败 ⇒ 必须把 notes 一起还原
    const res = callNote(dir, { op: 'renameSync', includes: 'seq.txt', code: 'EACCES' })
    assertRolledBack('笔记第二次写失败', dir, before, res, 'EACCES')
    h.eq(fs.readFileSync(path.join(dir, NOTES_REL), 'utf8'), oldLine, '台账逐字节回到写前（不是"写了再截断"）')
    h.eq(fs.readFileSync(path.join(dir, 'notes', 'seq.txt'), 'utf8'), '1\n', 'seq 也回到写前')
    evidenceOf('notes-rename-seq-second', { res, notes: readText(path.join(dir, NOTES_REL)) })
  })

  check('T10-crash-notes-recover', async () => {
    const dir = makePack('crash-notes')
    const oldLine = '{"id":"0001","seq":1,"kind":"笔记","anchor":"pt/0001","text":"崩溃前旧记录"}\n'
    fs.writeFileSync(path.join(dir, NOTES_REL), oldLine, 'utf8')
    fs.writeFileSync(path.join(dir, 'notes', 'seq.txt'), '1\n', 'utf8')
    const before = dirFiles(dir)
    const marker = path.join(temp, 'kill-notes.marker')
    const report = path.join(temp, 'kill-notes.json')
    const res = spawnSync(process.execPath, [SELF, '--mode=crash', `--root=${dir}`, '--entry=notes', `--marker=${marker}`, `--report=${report}`], {
      cwd: REPO, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    })
    const journals = txnDirs(dir)
    const lockAtCrash = lockExists(dir)
    const journal = journals.length === 1
      ? (() => { try { return readJson(path.join(dir, '.whale-txn', journals[0], 'journal.json')) } catch { return null } })()
      : null
    const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'executor-t10' })
    const afterRecover = dirFiles(dir)
    evidenceOf('crash-notes', {
      exit: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr,
      marker: fs.existsSync(marker), journals, lockAtCrash, journal, recover: rec, afterRecover,
    })
    h.eq(res.status === 0, false, `写进程必须真的被杀（exit=${res.status} signal=${res.signal}）`)
    h.eq(fs.existsSync(marker), true, '杀点确实走到（第二个目标 rename 之前）')
    h.eq(journals.length, 1, `中断必须留下日志残骸（实得 ${journals.length} 个）`)
    h.eq(journal && journal.schema, 'whale-txn/1', '残骸是 whale-txn/1 日志')
    h.eq(journal && journal.state, 'prepared', `中断发生在 prepared 之后（${journal && journal.state}）`)
    h.eq(lockAtCrash, true, '中断那一刻锁还在（下一次普通写会被拒）')
    h.eq(rec.ok, true, `离线恢复（error=${rec.error}）`)
    h.eq(afterRecover, before, '恢复后 = 原状态（台账与 seq 逐字节回到写前）')
    assertClean(dir)
    // 恢复之后普通写放行
    const r = appendNote({ root: dir, text: '恢复后写', anchor: '第1课' })
    h.assert(r.ok === true && r.id === '0002', `恢复之后普通写放行（${r.id}）`)
  })

  // ================================================================ ② 问答队列
  check('T10-ask-commit', async () => {
    const dir = makePack('ask-commit')
    const P = askPaths(dir)
    fs.writeFileSync(P.seqFile, '0', 'utf8')
    fs.writeFileSync(P.pending, '', 'utf8')
    const r = await handleAsk(dir, { raw: JSON.stringify({ question: '第一条问题' }), now: CLOCK })
    h.assert(r.status === 200 && r.body.ok === true, `handleAsk → ${r.status} ok=${r.body.ok}`)
    h.eq(r.body.id, '0001', 'id=0001')
    h.eq(fs.readFileSync(P.seqFile, 'utf8'), '1', 'seq 原始字节 = "1"（无换行，与旧实现同形）')
    const lines = fs.readFileSync(P.pending, 'utf8').trim().split('\n')
    h.eq(lines.length, 1, 'pending 一行')
    h.eq(JSON.parse(lines[0]).id, '0001', '入队记录 id 对')
    assertClean(dir)
  })

  check('T10-ask-prefix', async () => {
    const dir = makePack('ask-prefix')
    const P = askPaths(dir)
    const oldLine = JSON.stringify({ id: '0001', at: '2026-01-01T00:00:00.000Z', lesson: '', page: '', title: '', question: '旧', status: 'pending' }) + '\n'
    fs.writeFileSync(P.pending, oldLine, 'utf8')
    fs.writeFileSync(P.seqFile, '1', 'utf8')
    const r = await handleAsk(dir, { raw: JSON.stringify({ question: '第二条问题' }), now: CLOCK })
    h.assert(r.status === 200 && r.body.id === '0002', `第二条拿到 0002（${r.status}）`)
    const after = fs.readFileSync(P.pending, 'utf8')
    h.eq(after.startsWith(oldLine), true, '已有队列前缀字节原样保留')
    h.eq(fs.readFileSync(P.seqFile, 'utf8'), '2', 'seq 前进到 2')
    assertClean(dir)
  })

  check('T10-ask-eacces-temp', async () => {
    const dir = makePack('ask-fault-temp')
    const P = askPaths(dir)
    fs.writeFileSync(P.seqFile, '0', 'utf8')
    fs.writeFileSync(P.pending, '', 'utf8')
    const before = dirFiles(dir)
    const res = await callAsk(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'pending.jsonl', code: 'EACCES' })
    assertRolledBack('问答暂存失败', dir, before, res, 'EACCES')
    h.eq(fs.readFileSync(P.seqFile, 'utf8'), '0', 'seq 没动')
    evidenceOf('ask-eacces-temp', { res })
  })

  check('T10-ask-enospc-backup', async () => {
    // 两件都**不存在**：备份失败时回滚只需要"删掉本来就没有的"，不会被缺备份卡成 recovery-required
    const dir = makePack('ask-fault-backup')
    const before = dirFiles(dir)
    const res = await callAsk(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('问答备份失败', dir, before, res, 'ENOSPC')
    evidenceOf('ask-enospc-backup', { res })
  })

  check('T10-ask-enospc-journal', async () => {
    const dir = makePack('ask-fault-journal')
    const P = askPaths(dir)
    fs.writeFileSync(P.seqFile, '0', 'utf8')
    fs.writeFileSync(P.pending, '', 'utf8')
    const before = dirFiles(dir)
    const res = await callAsk(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('问答 journal(prepared) 失败', dir, before, res, 'ENOSPC')
    evidenceOf('ask-enospc-journal', { res })
  })

  check('T10-ask-rename-pending-second', async () => {
    const dir = makePack('ask-fault-rename-pending')
    const P = askPaths(dir)
    const oldLine = JSON.stringify({ id: '0001', at: '2026-01-01T00:00:00.000Z', lesson: '', page: '', title: '', question: '旧', status: 'pending' }) + '\n'
    fs.writeFileSync(P.pending, oldLine, 'utf8')
    fs.writeFileSync(P.seqFile, '1', 'utf8')
    const before = dirFiles(dir)
    // 计划顺序 = [seq, pending]：seq 已 rename 落位、pending rename 失败
    // ⇒ 必须把 seq 回滚；这正是「不得只递增 seq 而未入队」的回归
    const res = await callAsk(dir, { op: 'renameSync', includes: 'pending.jsonl', code: 'EACCES' })
    assertRolledBack('问答第二次写失败', dir, before, res, 'EACCES')
    h.eq(fs.readFileSync(P.seqFile, 'utf8'), '1', 'seq 逐字节回到写前（没有只递增）')
    h.eq(fs.readFileSync(P.pending, 'utf8'), oldLine, 'pending 逐字节回到写前（没有半行）')
    evidenceOf('ask-rename-pending-second', { res, seq: fs.readFileSync(P.seqFile, 'utf8') })
  })

  check('T10-crash-ask-recover', async () => {
    const dir = makePack('crash-ask')
    const P = askPaths(dir)
    const oldLine = JSON.stringify({ id: '0005', at: '2026-01-01T00:00:00.000Z', lesson: '', page: '', title: '', question: '崩溃前旧问题', status: 'pending' }) + '\n'
    fs.writeFileSync(P.pending, oldLine, 'utf8')
    fs.writeFileSync(P.seqFile, '5', 'utf8')
    const before = dirFiles(dir)
    const marker = path.join(temp, 'kill-ask.marker')
    const report = path.join(temp, 'kill-ask.json')
    const res = spawnSync(process.execPath, [SELF, '--mode=crash', `--root=${dir}`, '--entry=ask', `--marker=${marker}`, `--report=${report}`], {
      cwd: REPO, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    })
    const journals = txnDirs(dir)
    const lockAtCrash = lockExists(dir)
    const journal = journals.length === 1
      ? (() => { try { return readJson(path.join(dir, '.whale-txn', journals[0], 'journal.json')) } catch { return null } })()
      : null
    const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'executor-t10' })
    const afterRecover = dirFiles(dir)
    evidenceOf('crash-ask', {
      exit: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr,
      marker: fs.existsSync(marker), journals, lockAtCrash, journal, recover: rec, afterRecover,
    })
    h.eq(res.status === 0, false, `写进程必须真的被杀（exit=${res.status} signal=${res.signal}）`)
    h.eq(fs.existsSync(marker), true, '杀点确实走到（pending rename 之前）')
    h.eq(journals.length, 1, `中断必须留下日志残骸（实得 ${journals.length} 个）`)
    h.eq(journal && journal.schema, 'whale-txn/1', '残骸是 whale-txn/1 日志')
    h.eq(journal && journal.state, 'prepared', `中断发生在 prepared 之后（${journal && journal.state}）`)
    h.eq(lockAtCrash, true, '中断那一刻锁还在')
    h.eq(rec.ok, true, `离线恢复（error=${rec.error}）`)
    h.eq(afterRecover, before, '恢复后 = 原状态（seq 与 pending 逐字节回到写前）')
    h.eq(fs.readFileSync(P.seqFile, 'utf8'), '5', '恢复后 seq 回到 5（没有留下"只递增"的中间态）')
    assertClean(dir)
    const r = await handleAsk(dir, { raw: JSON.stringify({ question: '恢复后的问题' }), now: CLOCK })
    h.assert(r.status === 200 && r.body.id === '0006', `恢复之后普通写放行（${r.body.id}）`)
  })

  // ================================================================ ③ 已答台账
  check('T10-answer-commit', async () => {
    const dir = makePack('answer-commit')
    const before = fs.readFileSync(path.join(dir, 'assets', 'questions-data.js'), 'utf8')
    const at = before.indexOf('\n  };\n});')
    const head = before.slice(0, at)
    const r = await handleAnswer(dir, { raw: answerBody('0004'), now: CLOCK, rebuild: false, trustedEngine: false })
    h.assert(r.status === 200 && r.body.ok === true, `handleAnswer → ${r.status} ok=${r.body.ok}`)
    h.eq(r.body.id, '0004', 'id=0004')
    h.eq(/新增 0004 · 丢失 无/.test(String(r.body.selfCheck)), true, `自检回执（${r.body.selfCheck}）`)
    const after = fs.readFileSync(path.join(dir, 'assets', 'questions-data.js'), 'utf8')
    h.eq(after.startsWith(head), true, '原有台账前缀字节原样保留')
    h.eq(after.endsWith('\n  };\n});\n') || after.endsWith('\n  };\n});'), true, '收尾锚点原样')
    delete require_.cache[path.join(dir, 'assets', 'questions-data.js')]
    const led = require_(path.join(dir, 'assets', 'questions-data.js'))
    h.assert(!!led['0004'] && led['0004'].status === 'answered', '台账可 require 且新键在')
    assertClean(dir)
  })

  check('T10-answer-prefix', async () => {
    const dir = makePack('answer-prefix')
    const r1 = await handleAnswer(dir, { raw: answerBody('0001'), now: CLOCK, rebuild: false, trustedEngine: false })
    h.assert(r1.status === 200, '先写第一条')
    const mid = fs.readFileSync(path.join(dir, 'assets', 'questions-data.js'), 'utf8')
    const midLine = mid.split('\n').find((l) => l.includes("'0001': {"))
    const r2 = await handleAnswer(dir, { raw: answerBody('0002'), now: CLOCK, rebuild: false, trustedEngine: false })
    h.assert(r2.status === 200 && r2.body.id === '0002', '第二条写成功')
    const after = fs.readFileSync(path.join(dir, 'assets', 'questions-data.js'), 'utf8')
    h.assert(!!midLine && after.includes(midLine), '第一条的整块原样还在（append-only）')
    delete require_.cache[path.join(dir, 'assets', 'questions-data.js')]
    const led = require_(path.join(dir, 'assets', 'questions-data.js'))
    h.eq(Object.keys(led).sort().join(','), '0001,0002', '两个键都在')
    assertClean(dir)
  })

  check('T10-answer-eacces-temp', async () => {
    const dir = makePack('answer-fault-temp')
    const before = dirFiles(dir)
    const res = await callAnswer(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'questions-data.js', code: 'EACCES' })
    assertRolledBack('已答台账暂存失败', dir, before, res, 'EACCES')
    evidenceOf('answer-eacces-temp', { res })
  })

  check('T10-answer-enospc-backup', async () => {
    const dir = makePack('answer-fault-backup')
    const before = dirFiles(dir)
    const res = await callAnswer(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('已答台账备份失败', dir, before, res, 'ENOSPC')
    evidenceOf('answer-enospc-backup', { res })
  })

  check('T10-answer-enospc-journal', async () => {
    const dir = makePack('answer-fault-journal')
    const before = dirFiles(dir)
    const res = await callAnswer(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('已答台账 journal(prepared) 失败', dir, before, res, 'ENOSPC')
    evidenceOf('answer-enospc-journal', { res })
  })

  check('T10-answer-eacces-rename', async () => {
    const dir = makePack('answer-fault-rename')
    const before = dirFiles(dir)
    const res = await callAnswer(dir, { op: 'renameSync', includes: 'questions-data.js', code: 'EACCES' })
    assertRolledBack('已答台账落位失败', dir, before, res, 'EACCES')
    evidenceOf('answer-eacces-rename', { res })
  })

  // ================================================================ ④ 终点
  check('T10-goal-commit-version', () => {
    const dir = makePack('goal-commit')
    const r1 = recordGoal(dir, goalInput(0, 1))
    h.assert(r1.ok === true && r1.record.v === 1 && r1.record.replaces === null, '首版 v=1、replaces=null')
    const first = fs.readFileSync(goalsPath(dir), 'utf8')
    const r2 = recordGoal(dir, goalInput(0, 2))
    h.assert(r2.ok === true && r2.record.v === 2 && r2.record.replaces === 1, '第 2 版 v=2、replaces=1')
    const after = fs.readFileSync(goalsPath(dir), 'utf8')
    h.eq(after.startsWith(first), true, '已有记录前缀字节原样保留')
    h.eq(readGoals(dir).entries.length, 2, '台账两行')
    assertClean(dir)
  })

  check('T10-goal-eacces-temp', () => {
    const dir = makePack('goal-fault-temp')
    const before = dirFiles(dir)
    const res = callGoal(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'goals.jsonl', code: 'EACCES' })
    assertRolledBack('终点暂存失败', dir, before, res, 'EACCES')
  })

  check('T10-goal-enospc-backup', () => {
    const dir = makePack('goal-fault-backup')
    const before = dirFiles(dir)
    const res = callGoal(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('终点备份失败', dir, before, res, 'ENOSPC')
  })

  check('T10-goal-enospc-journal', () => {
    const dir = makePack('goal-fault-journal')
    const before = dirFiles(dir)
    const res = callGoal(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('终点 journal(prepared) 失败', dir, before, res, 'ENOSPC')
  })

  check('T10-goal-eacces-rename', () => {
    const dir = makePack('goal-fault-rename')
    const before = dirFiles(dir)
    const res = callGoal(dir, { op: 'renameSync', includes: 'goals.jsonl', code: 'EACCES' })
    assertRolledBack('终点落位失败', dir, before, res, 'EACCES')
  })

  // ================================================================ ⑤ 教学
  check('T10-teaching-commit-version', () => {
    const dir = makePack('teaching-commit')
    const r1 = recordTeaching(dir, teachingInput(0))
    h.assert(r1.ok === true && r1.record.v === 1, '首版 v=1')
    const first = fs.readFileSync(teachingPath(dir), 'utf8')
    const r2 = recordTeaching(dir, teachingInput(1))
    h.assert(r2.ok === true && r2.record.v === 2 && r2.record.replaces === 1, '第 2 版 v=2、replaces=1')
    const after = fs.readFileSync(teachingPath(dir), 'utf8')
    h.eq(after.startsWith(first), true, '已有记录前缀字节原样保留')
    const data = readTeaching(dir)
    h.eq(data.entries.length, 2, '台账两行')
    h.eq(data.global.v, 2, '同一 (circle,kind) 版本线到 2')
    assertClean(dir)
  })

  check('T10-teaching-eacces-temp', () => {
    const dir = makePack('teaching-fault-temp')
    const before = dirFiles(dir)
    const res = callTeaching(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'teaching.jsonl', code: 'EACCES' })
    assertRolledBack('教学暂存失败', dir, before, res, 'EACCES')
  })

  check('T10-teaching-enospc-backup', () => {
    const dir = makePack('teaching-fault-backup')
    const before = dirFiles(dir)
    const res = callTeaching(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('教学备份失败', dir, before, res, 'ENOSPC')
  })

  check('T10-teaching-enospc-journal', () => {
    const dir = makePack('teaching-fault-journal')
    const before = dirFiles(dir)
    const res = callTeaching(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('教学 journal(prepared) 失败', dir, before, res, 'ENOSPC')
  })

  check('T10-teaching-eacces-rename', () => {
    const dir = makePack('teaching-fault-rename')
    const before = dirFiles(dir)
    const res = callTeaching(dir, { op: 'renameSync', includes: 'teaching.jsonl', code: 'EACCES' })
    assertRolledBack('教学落位失败', dir, before, res, 'EACCES')
  })

  // ================================================================ ⑥ 摸底
  check('T10-intake-commit', () => {
    const dir = makePack('intake-commit')
    const r1 = recordIntake(dir, intakeInput(1))
    h.assert(r1.ok === true, '第一条写成功')
    const first = fs.readFileSync(intakePath(dir), 'utf8')
    const r2 = recordIntake(dir, intakeInput(2))
    h.assert(r2.ok === true, '第二条写成功')
    const after = fs.readFileSync(intakePath(dir), 'utf8')
    h.eq(after.startsWith(first), true, '已有记录前缀字节原样保留')
    h.eq(readIntake(dir).entries.length, 2, '台账两行')
    assertClean(dir)
  })

  check('T10-intake-eacces-temp', () => {
    const dir = makePack('intake-fault-temp')
    const before = dirFiles(dir)
    const res = callIntake(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'intake.jsonl', code: 'EACCES' })
    assertRolledBack('摸底暂存失败', dir, before, res, 'EACCES')
  })

  check('T10-intake-enospc-backup', () => {
    const dir = makePack('intake-fault-backup')
    const before = dirFiles(dir)
    const res = callIntake(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('摸底备份失败', dir, before, res, 'ENOSPC')
  })

  check('T10-intake-enospc-journal', () => {
    const dir = makePack('intake-fault-journal')
    const before = dirFiles(dir)
    const res = callIntake(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('摸底 journal(prepared) 失败', dir, before, res, 'ENOSPC')
  })

  check('T10-intake-eacces-rename', () => {
    const dir = makePack('intake-fault-rename')
    const before = dirFiles(dir)
    const res = callIntake(dir, { op: 'renameSync', includes: 'intake.jsonl', code: 'EACCES' })
    assertRolledBack('摸底落位失败', dir, before, res, 'EACCES')
  })

  // ================================================================ ⑦ 术语
  check('T10-glossary-commit', () => {
    const dir = makePack('glossary-commit')
    const before = fs.readFileSync(path.join(dir, LEDGER_REL), 'utf8')
    const rec = { label: '测试词', category: 'Web 基础', official: 'O', short: 'S', analogy: 'A', lesson: '第2课' }
    const r = writeTermSurgically({ root: dir, key: 'whaletest', record: rec })
    h.assert(r.ok === true, `writeTermSurgically ok（${r.error || ''}）`)
    const after = fs.readFileSync(path.join(dir, LEDGER_REL), 'utf8')
    h.eq(after.includes('whaletest: {'), true, '新记录真的写进台账')
    h.eq(after.includes('body: {'), true, '旧记录还在')
    delete require_.cache[path.join(dir, LEDGER_REL)]
    const led = require_(path.join(dir, LEDGER_REL))
    h.assert(led.whaletest && led.whaletest.label === '测试词', '台账可 require 且新记录字段对')
    h.assert(!!led.body, '旧记录未被破坏')
    // 手术只在顶层映射收尾前插入：原有内容（去掉末条记录的收尾 `}`）必须原样保留
    const oldHead = before.slice(0, before.lastIndexOf('\n  };'))
    h.eq(after.startsWith(oldHead.slice(0, -1)), true, '原有内容前缀原样保留')
    h.eq(Buffer.from(after, 'utf8')[0] !== 0xEF, true, '不带 BOM')
    assertClean(dir)
  })

  check('T10-glossary-selfcheck-rejected', () => {
    const dir = makePack('glossary-selfcheck')
    const before = fs.readFileSync(path.join(dir, LEDGER_REL), 'utf8')
    const r = writeTermSurgically({
      root: dir, key: 'whalebad', record: { label: '坏', category: 'C', official: 'O', short: 'S', analogy: 'A', lesson: '第1课' }, corrupt: true,
    })
    h.eq(r.ok, false, '自检不过 → ok:false')
    h.eq(r.rolledBack, true, '回执明确 rolledBack')
    h.eq(r.state, 'rejected', `回执带明确事务 state（${r.state}）`)
    h.eq(fs.readFileSync(path.join(dir, LEDGER_REL), 'utf8'), before, '自检不过时台账逐字节未变')
    assertClean(dir)
  })

  check('T10-glossary-eacces-temp', () => {
    const dir = makePack('glossary-fault-temp')
    const before = dirFiles(dir)
    const res = callGlossary(dir, { op: 'writeFileSync', includes: '.tmp-txn-', includes2: 'glossary-data.js', code: 'EACCES' })
    assertRolledBack('术语暂存失败', dir, before, res, 'EACCES')
  })

  check('T10-glossary-enospc-backup', () => {
    const dir = makePack('glossary-fault-backup')
    const before = dirFiles(dir)
    const res = callGlossary(dir, { op: 'renameSync', includes: 'backup-', code: 'ENOSPC', after: true })
    assertRolledBack('术语备份失败', dir, before, res, 'ENOSPC')
  })

  check('T10-glossary-enospc-journal', () => {
    const dir = makePack('glossary-fault-journal')
    const before = dirFiles(dir)
    const res = callGlossary(dir, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    assertRolledBack('术语 journal(prepared) 失败', dir, before, res, 'ENOSPC')
  })

  check('T10-glossary-eacces-rename', () => {
    const dir = makePack('glossary-fault-rename')
    const before = dirFiles(dir)
    const res = callGlossary(dir, { op: 'renameSync', includes: 'glossary-data.js', code: 'EACCES' })
    assertRolledBack('术语落位失败', dir, before, res, 'EACCES')
  })

  // ================================================================ ⑧ 跨入口
  check('T10-error-shape-state', async () => {
    // 同一类故障（journal 写不下）在六个入口上都必须带明确 state，且绝不写 ok:true
    const n = makePack('shape-notes')
    const nr = callNote(n, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(nr.ok, false, '笔记：失败不是成功')
    h.eq(nr.state, 'rolled-back', `笔记：state=${nr.state}`)
    h.eq(nr.httpStatus, 500, `笔记：httpStatus=${nr.httpStatus}`)

    const a = makePack('shape-ask')
    fs.writeFileSync(askPaths(a).seqFile, '0', 'utf8')
    fs.writeFileSync(askPaths(a).pending, '', 'utf8')
    const ar = await callAsk(a, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(ar.ok, false, '问答：失败不是成功')
    h.eq(ar.status >= 500, true, `问答：status=${ar.status}`)
    h.eq(ar.state, 'rolled-back', `问答：state=${ar.state}`)

    const d = makePack('shape-answer')
    const dr = await callAnswer(d, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(dr.ok, false, '已答：失败不是成功')
    h.eq(dr.status >= 500, true, `已答：status=${dr.status}`)
    h.eq(dr.state, 'rolled-back', `已答：state=${dr.state}`)

    const g = makePack('shape-goal')
    const gr = callGoal(g, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(gr.ok, false, '终点：失败不是成功')
    h.eq(gr.state, 'rolled-back', `终点：state=${gr.state}`)
    h.eq(gr.rollbackError, null, '终点：回滚成功时 rollbackError=null')

    const t = makePack('shape-teaching')
    const tr = callTeaching(t, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(tr.ok, false, '教学：失败不是成功')
    h.eq(tr.state, 'rolled-back', `教学：state=${tr.state}`)

    const i = makePack('shape-intake')
    const ir = callIntake(i, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(ir.ok, false, '摸底：失败不是成功')
    h.eq(ir.state, 'rolled-back', `摸底：state=${ir.state}`)

    const gl = makePack('shape-glossary')
    const glr = callGlossary(gl, { op: 'writeFileSync', includes: 'journal.json', code: 'ENOSPC' })
    h.eq(glr.ok, false, '术语：失败不是成功')
    h.eq(glr.state, 'rolled-back', `术语：state=${glr.state}`)
    h.eq(glr.httpStatus, 500, `术语：httpStatus=${glr.httpStatus}`)
  })

  check('T10-rebuild-after-lock', async () => {
    const dir = makePack('rebuild-after-lock')
    // 三个重建脚本：只要启动时包里还有写锁，就退出码 2 且不写标记
    for (const s of ['drain-questions.js', 'build-notes.js', 'build-lessons.js']) {
      const tag = s.replace('.js', '')
      fs.writeFileSync(path.join(dir, 'tools', s), [
        "const fs = require('fs')",
        "const path = require('path')",
        "const root = process.cwd()",
        "if (fs.existsSync(path.join(root, '.whale-write.lock'))) { console.error('LOCK_HELD'); process.exit(2) }",
        `fs.writeFileSync(path.join(root, ${JSON.stringify(`rebuild-ran-${tag}.txt`)}), 'ok\\n', 'utf8')`,
        'process.exit(0)',
        '',
      ].join('\n'), 'utf8')
    }
    const r = await handleAnswer(dir, {
      raw: answerBody('0009'), now: CLOCK, rebuild: true, trustedEngine: false,
    })
    h.assert(r.status === 200 && r.body.ok === true, `handleAnswer → ${r.status} ok=${r.body.ok}`)
    h.assert(r.body.rebuild && r.body.rebuild.ok === true, `重建链成功（${JSON.stringify(r.body.rebuild)}）`)
    h.eq((r.body.steps || []).map((s) => s.code).join(','), '0,0,0', '三个脚本退出码都是 0')
    for (const tag of ['drain-questions', 'build-notes', 'build-lessons']) {
      h.eq(fs.existsSync(path.join(dir, `rebuild-ran-${tag}.txt`)), true, `重建脚本确实启动并跑完：${tag}`)
    }
    h.eq(lockExists(dir), false, '重建启动时锁已经释放（否则脚本会以 LOCK_HELD 退出 2）')
    assertClean(dir)
    evidenceOf('rebuild-after-lock', { steps: r.body.steps, rebuild: r.body.rebuild, warnings: r.body.warnings })
  })

  check('T10-concurrent-two-process', async () => {
    const dir = makePack('concurrent')
    fs.writeFileSync(askPaths(dir).seqFile, '0', 'utf8')
    fs.writeFileSync(askPaths(dir).pending, '', 'utf8')
    const N = 20
    const reports = [0, 1].map((w) => path.join(temp, `concurrent-w${w}.json`))
    // **真并发**：两个子进程同时起（spawnSync 会串行化，那样测不到锁竞争）
    const runs = await Promise.all([0, 1].map((w) => spawnWorker([
      '--mode=concurrent', `--root=${dir}`, `--writer=${w}`, `--n=${N}`, `--report=${reports[w]}`,
    ])))
    const docs = reports.map((p) => (fs.existsSync(p) ? readJson(p) : null))
    evidenceOf('concurrent', { runs, docs })
    h.eq(runs[0].code, 0, `writer0 退出码（signal=${runs[0].signal} error=${runs[0].error || ''}）`)
    h.eq(runs[1].code, 0, `writer1 退出码（signal=${runs[1].signal} error=${runs[1].error || ''}）`)
    h.eq(docs[0] && docs[0].failed.length, 0, `writer0 没有失败事务：${JSON.stringify(docs[0] && docs[0].failed.slice(0, 3))}`)
    h.eq(docs[1] && docs[1].failed.length, 0, `writer1 没有失败事务：${JSON.stringify(docs[1] && docs[1].failed.slice(0, 3))}`)
    h.eq(docs[0] && docs[0].done, N, `writer0 写了 ${N} 轮`)
    h.eq(docs[1] && docs[1].done, N, `writer1 写了 ${N} 轮`)

    // 笔记：序号唯一且恰好 1..2N
    const notes = fs.readFileSync(path.join(dir, NOTES_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const noteIds = notes.map((r) => Number(r.id))
    h.eq(notes.length, N * 2, `笔记：全部 ${N * 2} 条都在（实得 ${notes.length}）`)
    h.eq(new Set(noteIds).size, N * 2, `笔记：序号唯一（${new Set(noteIds).size}）`)
    h.eq(noteIds.slice().sort((a, b) => a - b).join(','), Array.from({ length: N * 2 }, (_, i) => i + 1).join(','), '笔记：序号恰好 1..2N')
    h.eq(fs.readFileSync(path.join(dir, 'notes', 'seq.txt'), 'utf8').trim(), String(N * 2), '笔记：seq 终值 = 2N')

    // 问答：id 唯一且恰好 1..2N
    const qs = fs.readFileSync(askPaths(dir).pending, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const qIds = qs.map((r) => Number(r.id))
    h.eq(qs.length, N * 2, `问答：全部 ${N * 2} 条都在（实得 ${qs.length}）`)
    h.eq(new Set(qIds).size, N * 2, `问答：序号唯一（${new Set(qIds).size}）`)
    h.eq(qIds.slice().sort((a, b) => a - b).join(','), Array.from({ length: N * 2 }, (_, i) => i + 1).join(','), '问答：序号恰好 1..2N')

    // 终点 / 教学：版本无冲突（同一版本线）
    const goals = readGoals(dir).entries
    const gv = goals.map((e) => e.v)
    h.eq(goals.length, N * 2, `终点：全部 ${N * 2} 版都在（实得 ${goals.length}）`)
    h.eq(new Set(gv).size, N * 2, `终点：版本唯一（${new Set(gv).size}）`)
    h.eq(gv.slice().sort((a, b) => a - b).join(','), Array.from({ length: N * 2 }, (_, i) => i + 1).join(','), '终点：版本恰好 1..2N（无冲突）')
    h.eq(readGoals(dir).latest['spring-boot']?.v, N * 2, '终点：现行版本 = 2N')

    const teaching = readTeaching(dir).entries.filter((e) => e.circle === GLOBAL_CIRCLE && e.kind === 'values')
    const tv = teaching.map((e) => e.v)
    h.eq(teaching.length, N * 2, `教学：全部 ${N * 2} 版都在（实得 ${teaching.length}）`)
    h.eq(new Set(tv).size, N * 2, `教学：版本唯一（${new Set(tv).size}）`)
    h.eq(tv.slice().sort((a, b) => a - b).join(','), Array.from({ length: N * 2 }, (_, i) => i + 1).join(','), '教学：版本恰好 1..2N（无冲突）')

    h.eq(readIntake(dir).entries.length, N * 2, `摸底：全部 ${N * 2} 条都在`)
    assertClean(dir)
  })

  check('T10-source-wired', () => {
    const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const files = [
      ['lib/notes-io.js', ['appendNote']],
      ['lib/ask-io.js', ['handleAsk', 'handleAnswer']],
      ['lib/goal-io.js', ['recordGoal']],
      ['lib/teaching-io.js', ['recordTeaching']],
      ['lib/intake.js', ['recordIntake']],
      ['lib/glossary-edit-io.js', ['writeTermSurgically']],
    ]
    for (const [rel, fns] of files) {
      const code = strip(fs.readFileSync(path.join(REPO, rel), 'utf8'))
      h.eq(code.includes('withPackTransaction('), true, `${rel} 真的调用了 withPackTransaction`)
      h.eq(code.includes('pack-template/tools/ledger-transaction.cjs'), true, `${rel} 从事务件 require（卡面路径）`)
      for (const fn of fns) h.eq(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`).test(code), true, `${rel} 保留入口 ${fn}`)
      h.eq(/appendFileSync|ftruncateSync/.test(code), false, `${rel} 不再有绕过事务的 append/truncate 写路径`)
    }
  })

  check('T10-negative-controls', async () => {
    // ① 把基线（ba22c94）的六个旧实现拷进临时副本（产品文件一个字节都不动）
    const neg = path.join(temp, 'neg')
    fs.mkdirSync(neg, { recursive: true })
    fs.writeFileSync(path.join(neg, 'package.json'), '{"type":"module"}\n', 'utf8')
    fs.cpSync(path.join(REPO, 'lib'), path.join(neg, 'lib'), { recursive: true })
    const SIX = ['notes-io.js', 'ask-io.js', 'goal-io.js', 'teaching-io.js', 'intake.js', 'glossary-edit-io.js']
    for (const f of SIX) {
      const r = spawnSync('git', ['show', `${BASELINE}:lib/${f}`], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
      h.eq(r.status, 0, `git show 基线文件 ${f}（stderr=${clip(r.stderr, 400)}）`)
      fs.writeFileSync(path.join(neg, 'lib', f), r.stdout, 'utf8')
    }
    const oldNotes = await import(pathToFileURL(path.join(neg, 'lib', 'notes-io.js')).href)
    const oldAsk = await import(pathToFileURL(path.join(neg, 'lib', 'ask-io.js')).href)
    h.eq(/withPackTransaction/.test(fs.readFileSync(path.join(neg, 'lib', 'notes-io.js'), 'utf8')), false, '基线笔记实现确实没有事务（负向控制前提）')

    // ② 旧笔记：seq 只读 → 第二次写失败后**台账已经写了**（半提交）
    const oldDir = makePack('neg-notes-old')
    const oldSeq = path.join(oldDir, 'notes', 'seq.txt')
    fs.writeFileSync(oldSeq, '0\n', 'utf8')
    fs.chmodSync(oldSeq, 0o444)
    let oldErr = null
    try { oldNotes.appendNote({ root: oldDir, text: '旧实现', anchor: '第1课' }) } catch (e) { oldErr = e }
    const oldNotesFile = path.join(oldDir, NOTES_REL)
    const oldPartial = fs.existsSync(oldNotesFile) ? fs.readFileSync(oldNotesFile, 'utf8') : ''
    h.eq(!!oldErr, true, `旧实现第二次写失败会抛出（${oldErr && oldErr.message}）`)
    h.eq(oldErr && oldErr.txnState, undefined, '旧实现没有事务 state（本套件要求的形状在旧实现上不存在）')
    h.eq(/"id":"0001"/.test(oldPartial), true, '旧实现：台账**已经写了**（半提交 —— 这就是本卡要抓的旧行为）')
    h.eq(fs.readFileSync(oldSeq, 'utf8'), '0\n', '旧实现：seq 没走（台账有、序号没走）')
    fs.chmodSync(oldSeq, 0o666)

    // ③ 新笔记在同一条件下：明确 state + seq 不前进 + 没有半条记录
    const newDir = makePack('neg-notes-new')
    const newSeq = path.join(newDir, 'notes', 'seq.txt')
    fs.writeFileSync(newSeq, '0\n', 'utf8')
    fs.chmodSync(newSeq, 0o444)
    let newErr = null
    try { appendNote({ root: newDir, text: '新实现', anchor: '第1课' }) } catch (e) { newErr = e }
    h.eq(!!newErr, true, `新实现也如实失败（${newErr && newErr.message}）`)
    h.eq(['rolled-back', 'recovery-required'].includes(newErr && newErr.txnState), true, `新实现带明确事务 state（${newErr && newErr.txnState}）`)
    h.eq(fs.readFileSync(newSeq, 'utf8'), '0\n', '新实现：seq 没有前进')
    const newNotesFile = path.join(newDir, NOTES_REL)
    const newPartial = fs.existsSync(newNotesFile) ? fs.readFileSync(newNotesFile, 'utf8') : ''
    h.eq(/"id":"0001"/.test(newPartial), false, '新实现：台账没有半条记录')
    fs.chmodSync(newSeq, 0o666)
    if (newErr && newErr.txnState === 'recovery-required') {
      const rec = TXN.recoverPack(newDir, { offline: true, confirm: true, ownerToken: 'executor-t10' })
      h.assert(rec.ok === true && rec.state === 'recovered', `回滚失败后离线恢复（${rec.error}）`)
    }
    h.eq(lockExists(newDir), false, '新实现恢复后无锁')
    h.eq(txnDirs(newDir).length, 0, '新实现恢复后无日志')

    // ④ 旧问答：pending 只读 → seq 递增了、队列没进（"只递增 seq 而未入队"）
    const oldAskDir = makePack('neg-ask-old')
    const oldP = askPaths(oldAskDir)
    fs.writeFileSync(oldP.seqFile, '0', 'utf8')
    fs.writeFileSync(oldP.pending, '', 'utf8')
    fs.chmodSync(oldP.pending, 0o444)
    let oldAskErr = null
    try { await oldAsk.handleAsk(oldAskDir, { raw: JSON.stringify({ question: '旧实现' }), now: CLOCK }) } catch (e) { oldAskErr = e }
    h.eq(!!oldAskErr, true, `旧实现只递增 seq 时抛出（${oldAskErr && oldAskErr.message}）`)
    h.eq(oldAskErr && oldAskErr.txnState, undefined, '旧实现没有事务 state')
    h.eq(fs.readFileSync(oldP.seqFile, 'utf8'), '1', '旧实现：seq 已经递增（漏洞实证）')
    h.eq(fs.readFileSync(oldP.pending, 'utf8'), '', '旧实现：队列没有入队（漏洞实证）')
    fs.chmodSync(oldP.pending, 0o666)

    // ⑤ 新问答在同一条件下：seq 不前进 + 队列没有半行
    const newAskDir = makePack('neg-ask-new')
    const newP = askPaths(newAskDir)
    fs.writeFileSync(newP.seqFile, '0', 'utf8')
    fs.writeFileSync(newP.pending, '', 'utf8')
    fs.chmodSync(newP.pending, 0o444)
    const nr = await handleAsk(newAskDir, { raw: JSON.stringify({ question: '新实现' }), now: CLOCK })
    h.assert(nr.status >= 500 && nr.body.ok === false, `新实现如实失败（${nr.status}）`)
    h.eq(['rolled-back', 'recovery-required'].includes(nr.body.state), true, `新实现带明确事务 state（${nr.body.state}）`)
    h.eq(fs.readFileSync(newP.seqFile, 'utf8'), '0', '新实现：seq 没有前进（没有"只递增"）')
    h.eq(fs.readFileSync(newP.pending, 'utf8'), '', '新实现：队列没有半行')
    fs.chmodSync(newP.pending, 0o666)
    if (nr.body.state === 'recovery-required') {
      const rec = TXN.recoverPack(newAskDir, { offline: true, confirm: true, ownerToken: 'executor-t10' })
      h.assert(rec.ok === true && rec.state === 'recovered', `回滚失败后离线恢复（${rec.error}）`)
    }
    h.eq(lockExists(newAskDir), false, '新实现恢复后无锁')
    h.eq(txnDirs(newAskDir).length, 0, '新实现恢复后无日志')
    evidenceOf('negative-controls', {
      oldNotes: { error: oldErr && oldErr.message, partial: clip(oldPartial, 500), seq: fs.readFileSync(oldSeq, 'utf8') },
      newNotes: { error: newErr && newErr.message, state: newErr && newErr.txnState, seq: fs.readFileSync(newSeq, 'utf8'), partial: clip(newPartial, 500) },
      oldAsk: { error: oldAskErr && oldAskErr.message, seq: fs.readFileSync(oldP.seqFile, 'utf8'), pending: fs.readFileSync(oldP.pending, 'utf8') },
      newAsk: { status: nr.status, body: nr.body, seq: fs.readFileSync(newP.seqFile, 'utf8'), pending: fs.readFileSync(newP.pending, 'utf8') },
    })
  })

  // ================================================================ 清理守卫（最后一条，**异步**：前面的夹具都还要用）
  check('T10-cleanup-guard', async () => {
    const abs = path.resolve(temp)
    h.eq(path.dirname(abs).toLowerCase(), path.resolve('E:/Temp').toLowerCase(), `夹具在 E:/Temp 下：${abs}`)
    h.eq(path.basename(abs).startsWith(`whale-T10-${stamp}-`), true, `夹具名带本次 runId：${path.basename(abs)}`)
    h.eq(fs.existsSync(path.join(REPO, '.whale-txn')), false, '工作仓里没有被写进 .whale-txn')
    h.eq(fs.existsSync(path.join(REPO, '.whale-write.lock')), false, '工作仓里没有被写进 .whale-write.lock')
    h.eq(fs.existsSync(path.join(LIVE_PACK, '.whale-txn')), false, '用户活包里没有被写进 .whale-txn')
    h.eq(fs.existsSync(path.join(LIVE_PACK, '.whale-write.lock')), false, '用户活包里没有被写进 .whale-write.lock')
    fs.rmSync(abs, { recursive: true, force: true })
    h.eq(fs.existsSync(abs), false, '夹具已清理')
  })

  // ---------------------------------------------------------------- 执行 + 证据
  const runCheck = async ({ id, entry, fn }) => {
    try {
      const r = await fn()
      entry.actual = r === 'skip' ? 'skip' : 'pass'
      if (r === 'skip') entry.note = entry.note || '声明为 skip'
    } catch (e) {
      entry.actual = 'fail'
      entry.note = `抛异常：${e && e.message ? e.message : String(e)}`
      entry.detail = clip(e && e.stack ? e.stack : String(e), 8000)
    }
    if (entry.actual !== entry.expected) {
      entry.note = `实跑=${entry.actual} 与声明=${entry.expected} 不符${entry.note ? '；' + entry.note : ''}`
    }
  }
  for (const c of checks) {
    if (!h.cases.includes(c.entry)) h.cases.push(c.entry)
    await runCheck(c)
  }

  const code = h.run()
  try {
    // 机器要读的 JSONL 不带 BOM（result.json 由 evidenceJson 保证；cases.jsonl 这里补一刀）
    const casesFile = path.join(evidence, 'cases.jsonl')
    if (fs.existsSync(casesFile)) {
      fs.writeFileSync(casesFile, fs.readFileSync(casesFile, 'utf8').replace(/^\uFEFF/, ''), 'utf8')
    }
    h.evidence('command.txt', `node ${SELF}\n`, { bom: false })
    h.evidence('exit-code.txt', `${code}\n`, { bom: false })
    h.evidence('ids.txt', IDS.join('\n') + '\n', { bom: false })
  } catch { /* 证据落不下已由 h.run 报警 */ }
  process.exitCode = code
}

if (arg('mode')) await worker()
else await main()
