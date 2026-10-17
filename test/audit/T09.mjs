#!/usr/bin/env node
/**
 * T09 —— 包级**跨进程事务与离线恢复**的判据（报告 C01 / 计划 §6 T09）
 * ------------------------------------------------------------------
 * 卡面验收判据（原文）：
 *   「每个 IO 步骤分别注入 EACCES/ENOSPC/rename 失败，并模拟进程中断后恢复；
 *     两进程并发写 N 条，断言全部保留、序号唯一、版本无冲突。」
 * 补充（原文）：「两进程各写 100 条，重复 10 轮；每轮核全部 200 条、唯一序号及每条操作标识。
 *   每个提交阶段杀死夹具写进程后，执行独占离线恢复，再核原状态或完整已提交状态；
 *   回滚失败必须保留日志且拒绝下一次普通写。」
 *
 * 本文件只碰**自建夹具**（`E:/Temp/whale-T09-*`）：不写用户活包 `E:\workplace\study`、
 * 不写只读快照。进程中断是**真杀**（`process.kill(pid,'SIGKILL')`，不跑 finally、不清理），
 * 不是"桩脚本没写标记"；子进程一律 `stdio:'ignore'` + 结果走 report 文件
 * （受限沙箱下 piped stdio 的 spawn 会被 EPERM 拒）。
 *
 * 负向控制（`T09-negative-controls`）：把**锁获取**改成"永远成功"、把**回滚**改成空操作，
 * 在临时副本里真跑一遍，证明本套件里对应的判据会变红（产品文件一个字节都不动）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHarness, REPO, clip } from './harness.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const TXN_REL = 'lib/pack-template/tools/ledger-transaction.cjs'
const TXN_ABS = path.join(REPO, TXN_REL)
const RECOVER_ABS = path.join(REPO, 'tools', 'recover-ledgers.mjs')
const TXN = require_(TXN_ABS)
const LIVE_PACK = 'E:/workplace/study'

/** 固定用例 ID 全集（**不许漂移**：缺一条、多一条、重一条都算失败） */
const IDS = [
  'T09-txn-commit',
  'T09-txn-read-modify-write',
  'T09-txn-remove-rollback',
  'T09-txn-eacces-temp',
  'T09-txn-enospc-journal',
  'T09-txn-eacces-rename',
  'T09-txn-lock-meta-fault',
  'T09-txn-rollback-error',
  'T09-txn-refuse-after-rollback-failure',
  'T09-txn-kill-stage-staging',
  'T09-txn-kill-stage-prepared',
  'T09-txn-kill-stage-rename',
  'T09-txn-kill-stage-commit-marker',
  'T09-txn-recover-exclusive',
  'T09-txn-recover-confirm-gate',
  'T09-txn-concurrent-10x200',
  'T09-txn-no-auto-steal',
  'T09-txn-busy-release',
  'T09-txn-timeout',
  'T09-recover-cli',
  'T09-recover-cli-refuses',
  'T09-not-published',
  'T09-negative-controls',
  'T09-cleanup-guard',
]

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const killMarker = (tag) => path.join('E:/Temp', `whale-T09-killed-${tag}.marker`)
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8')
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
/** 真让出 CPU 的同步睡（`Atomics.wait` 可用就用它；不可用才退回空转） */
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}

/** 注入一个**真实的 OS 级进程中断**：不抛异常、不跑 finally、不留清理机会 */
function hardKill(tag) {
  try { fs.writeFileSync(killMarker(tag), 'killed\n', 'utf8') } catch { /* best effort */ }
  process.kill(process.pid, 'SIGKILL')
  process.abort()   // 万一平台不支持该信号时的兜底
  process.exit(97)
}

/**
 * 把**产品真正走的缝**包一层：按 `--fault=<stage>:<code>:<count>` 注入失败，
 * 或按 `--kill=<stage>[:<n>]` 在同一个缝上**真杀**进程。
 *
 * stage 的切法就是产品的 IO 步骤（不是"桩脚本写标记"）：
 *   write-temp    事务自己的暂存件 `X.tmp-txn-*`
 *   write-journal journal.json（`:n` = 第 n 次写：1=prepared 2=committed）
 *   write-backup  写前字节的备份 `backup-N.bin`
 *   write-lock    锁元数据 `lock.json`
 *   rename        落位（`renameSync` 到目标）
 */
function wrapFs({ fault, kill }) {
  const [stage, code, countRaw] = String(fault || '').split(':')
  let left = countRaw === undefined || countRaw === '' ? 1 : Number(countRaw)
  const [killStage, killN] = String(kill || '').split(':')
  let journalSeq = 0
  const hit = (s) => {
    if (kill && s === killStage) {
      if (killStage !== 'write-journal' || killN === undefined || Number(killN) === journalSeq) hardKill(process.pid)
    }
    if (!fault || s !== stage) return
    if (left <= 0) return
    left -= 1
    const e = new Error(`injected ${code || 'IO_ERROR'} at ${s}`)
    e.code = code || 'IO_ERROR'
    throw e
  }
  const real = fs
  return {
    ...real,
    writeFileSync: (p, data, o) => {
      const s = String(p)
      if (s.includes('.tmp-txn-')) hit('write-temp')
      else if (s.includes('journal.json')) { journalSeq += 1; hit('write-journal') }
      else if (s.includes('backup-')) hit('write-backup')
      else if (s.includes('lock.json')) hit('write-lock')
      else if (s.includes('.tmp-')) hit('write-atomic')
      else hit('write-other')
      return real.writeFileSync(p, data, o)
    },
    renameSync: (a, b) => {
      const sb = String(b)
      if (sb.includes('journal.json')) hit('write-journal')
      else if (sb.includes('backup-')) hit('write-backup')
      else if (sb.includes('lock.json')) hit('write-lock')
      else hit('rename')
      return real.renameSync(a, b)
    },
  }
}

/** build 策略：子进程按名字重建（`read-modify-write` 是并发写口真正走的那条） */
function buildOf(name, params) {
  const ledger = 'ledger.jsonl'
  const text = (files) => (files && files[ledger] ? String(files[ledger]) : '')
  switch (name) {
    case 'append':
      return ({ files }) => [{ rel: ledger, content: text(files) + params.line + '\n' }]
    case 'throw':
      return () => { throw new Error('fixture-build-exploded') }
    case 'slow':
      return () => { const until = Date.now() + params.ms; while (Date.now() < until) { /* busy */ } return [{ rel: ledger, content: 'slow\n' }] }
    case 'read-modify-write':
      return ({ files, txnId }) => {
        const lines = text(files).split(/\r?\n/).filter((s) => s.trim())
        const rec = { op: params.op || `w${params.writer}-${params.i}`, seq: lines.length + 1, writer: params.writer, i: params.i, txnId }
        return [{ rel: ledger, content: `${lines.join('\n')}${lines.length ? '\n' : ''}${JSON.stringify(rec)}\n` }]
      }
    default:
      throw new Error(`未知 build 策略：${name}`)
  }
}

// ================================================================ 子进程（夹具写者）
async function worker() {
  const mode = arg('mode')
  const root = arg('root')
  const report = arg('report')
  const out = { mode, pid: process.pid, startedAt: new Date().toISOString() }
  try {
    if (mode === 'txn') {
      const params = JSON.parse(arg('params') || '{}')
      const t = require_(arg('module') || TXN_ABS)
      const opts = { fs: wrapFs({ fault: arg('fault'), kill: arg('kill') }) }
      if (arg('timeoutMs')) opts.timeoutMs = Number(arg('timeoutMs'))
      if (arg('owner')) opts.ownerToken = arg('owner')
      const r = t.withPackTransaction(root, buildOf(arg('build'), params), opts)
      out.result = { ok: r.ok, state: r.state, error: r.error, rollbackError: r.rollbackError, txnId: r.txnId, value: r.value }
    } else if (mode === 'concurrent') {
      const writer = Number(arg('writer'))
      const round = Number(arg('round'))
      const t = require_(arg('module') || TXN_ABS)
      const runs = []
      for (let i = 0; i < 100; i++) {
        // 跨进程**真并发**：拿不到锁就是 `busy`（卡面 outOfScope：不自动强抢）。
        // 这里按"多写者共用"的正常用法重试 —— 重试期间让出 CPU，让持锁的那个跑完。
        let r = null
        let attempts = 0
        for (; attempts < 20000; attempts++) {
          r = t.withPackTransaction(root, buildOf('read-modify-write', { writer, i, op: `w${writer}-${i}` }), { ownerToken: `writer-${writer}` })
          if (r.state !== 'busy') break
          sleepSync(2)
        }
        runs.push({ i, ok: r.ok, state: r.state, error: r.error, attempts })
        if (!r.ok) break
      }
      out.writer = writer
      out.round = round
      out.failed = runs.filter((x) => !x.ok)
      out.done = runs.length
      out.maxAttempts = runs.reduce((m, x) => Math.max(m, x.attempts || 0), 0)
    } else {
      throw new Error(`未知 worker 模式：${mode}`)
    }
  } catch (e) {
    out.crash = `${e && e.code ? e.code + ': ' : ''}${e && e.message ? e.message : String(e)}`
    out.stack = e && e.stack
  }
  if (report) writeJson(report, out)
  process.exit(out.crash ? 1 : 0)
}

/** 起一个子进程（**stdio 忽略**：结果走 report 文件）；返回 exit code / signal */
function spawnWorker(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...args], { cwd: REPO, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, timeoutMs)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, pid: child.pid }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, pid: child.pid, error: String(e && e.message ? e.message : e) }) })
  })
}

// ================================================================ 父进程（判据）
async function main() {
  const h = createHarness({ card: 'T09', expectedIds: IDS })
  const stamp = `${Date.now()}-${process.pid}`
  const evidence = path.join(REPO, 'audit-evidence', 'T09')
  fs.mkdirSync(evidence, { recursive: true })
  fs.mkdirSync('E:/Temp', { recursive: true })
  let temp
  try {
    temp = fs.mkdtempSync(`E:/Temp/whale-T09-${stamp}-`)
  } catch (e) {
    h.block(`临时夹具环境不可用（E:/Temp 建不出来）：${String(e && e.message ? e.message : e).replace(/\s+/g, ' ')}`)
    process.exitCode = h.run()
    return
  }
  h.note(`fixture=${temp}\ntxn=${TXN_ABS}`)

  const fixture = (name, initial = null) => {
    const dir = path.join(temp, name)
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
    if (initial !== null) fs.writeFileSync(path.join(dir, 'ledger.jsonl'), initial, 'utf8')
    return dir
  }
  const ledgerOf = (dir) => {
    const p = path.join(dir, 'ledger.jsonl')
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
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
  const txnDirs = (dir) => {
    const p = path.join(dir, '.whale-txn')
    return fs.existsSync(p) ? fs.readdirSync(p).sort() : []
  }
  const lockExists = (dir) => fs.existsSync(path.join(dir, '.whale-write.lock'))
  /** 锁**建好了**（目录 + 元数据都在）—— 只等目录会出现"目录在、元数据还没写"的空窗 */
  const lockReady = (dir) => fs.existsSync(path.join(dir, '.whale-write.lock', 'lock.json'))
  const evidenceOf = (name, payload) => h.evidence(path.join('cases', `${name}.txt`), clip(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 20000))

  /** 落位到 `ledger.jsonl` 的 rename **第一次**失败，别的 rename 照常 ⇒ 回滚应当成功 */
  const renameLedgerFault = () => {
    const real = fs
    let fired = false
    return {
      ...real,
      renameSync: (a, b) => {
        if (!fired && String(b).endsWith('ledger.jsonl')) { fired = true; const e = new Error('injected rename'); e.code = 'EACCES'; throw e }
        return real.renameSync(a, b)
      },
    }
  }
  /** 同一个缝**持续**坏 ⇒ 回滚也会失败 ⇒ recovery-required */
  const renameLedgerFaultAlways = () => {
    const real = fs
    return { ...real, renameSync: (a, b) => { if (String(b).endsWith('ledger.jsonl')) { const e = new Error('injected rename always'); e.code = 'EACCES'; throw e } return real.renameSync(a, b) } }
  }
  const mutate = (src, re, to, label) => {
    const out = src.replace(re, to)
    if (out === src) throw new Error(`变异没打到产品缝：${label}`)
    return out
  }

  const syncChecks = []
  const asyncChecks = []
  const record = (entry, fn) => {
    try {
      const r = fn()
      entry.actual = r === 'skip' ? 'skip' : 'pass'
      if (r === 'skip') entry.note = entry.note || '声明为 skip'
    } catch (e) {
      entry.actual = 'fail'
      entry.note = `抛异常：${e && e.message ? e.message : String(e)}`
      entry.detail = clip(e && e.stack ? e.stack : String(e))
    }
    if (entry.actual !== entry.expected) entry.note = `实跑=${entry.actual} 与声明=${entry.expected} 不符${entry.note ? '；' + entry.note : ''}`
  }
  const check = (id, fn) => {
    const entry = { id: String(id), expected: 'pass', actual: null, note: '', detail: null }
    h.cases.push(entry)
    syncChecks.push(() => record(entry, () => { try { return fn() } catch (e) { throw new Error(String(e && e.message ? e.message : e).replace(/\s+/g, ' ')) } }))
  }
  const checkAsync = (id, fn) => {
    const entry = { id: String(id), expected: 'pass', actual: null, note: '', detail: null }
    h.cases.push(entry)
    asyncChecks.push(async () => record(entry, () => fn()))
  }

  try {
    // ─────────────────────────────────────────────── ① 正常提交 + 原存在性
    check('T09-txn-commit', () => {
      const dir = fixture('commit', 'a\n')
      const r = TXN.withPackTransaction(dir, ({ files }) => [{ rel: 'ledger.jsonl', content: String(files['ledger.jsonl']) + 'b\n' }])
      h.eq(r.state, 'committed', `state（error=${r.error}）`)
      h.eq(r.ok, true, 'ok')
      h.eq(ledgerOf(dir), 'a\nb\n', '台账内容')
      h.eq(lockExists(dir), false, '提交后不留锁')
      h.eq(txnDirs(dir).length, 0, '提交后不留日志目录')
      const dir2 = fixture('commit-new')
      const r2 = TXN.withPackTransaction(dir2, () => [{ rel: 'notes/seq.txt', content: '1\n' }])
      h.eq(r2.state, 'committed', `新建文件提交（error=${r2.error}）`)
      h.eq(fs.readFileSync(path.join(dir2, 'notes', 'seq.txt'), 'utf8'), '1\n', '新建文件内容')
      h.eq(txnDirs(dir2).length, 0, '新建提交也不留日志')
      // Buffer / 空内容也要收
      const dir3 = fixture('commit-buffer', 'buf\n')
      const r3 = TXN.withPackTransaction(dir3, () => [{ rel: 'ledger.jsonl', content: Buffer.from('buf2\n', 'utf8') }, { rel: 'notes/empty.txt', content: '' }])
      h.eq(r3.state, 'committed', `Buffer 内容提交（error=${r3.error}）`)
      h.eq(ledgerOf(dir3), 'buf2\n', 'Buffer 内容落盘')
      h.eq(fs.readFileSync(path.join(dir3, 'notes', 'empty.txt'), 'utf8'), '', '空内容也算合法内容')
    })

    check('T09-txn-read-modify-write', () => {
      const dir = fixture('rmw', 'x\ny\n')
      let saw = null
      const r = TXN.withPackTransaction(dir, ({ files, txnId }) => {
        saw = { files, txnId }
        return [{ rel: 'ledger.jsonl', content: `${files['ledger.jsonl']}z\n` }, { rel: 'notes/seq.txt', content: '3\n' }]
      })
      h.eq(saw.files['ledger.jsonl'], 'x\ny\n', 'build 必须看到**真实写前字节**')
      h.eq(typeof saw.txnId, 'string', 'txnId 要给到 build')
      h.eq(r.state, 'committed', `state（error=${r.error}）`)
      h.eq(ledgerOf(dir), 'x\ny\nz\n', '台账追加')
      h.eq(fs.readFileSync(path.join(dir, 'notes', 'seq.txt'), 'utf8'), '3\n', '第二个目标也落位')
      h.eq(r.files.map((f) => f.rel).sort().join(','), 'ledger.jsonl,notes/seq.txt', '回执点名了写了哪几件')
      const dir2 = fixture('rmw-bad', 'keep\n')
      const before = dirSnapshot(dir2)
      h.eq(TXN.withPackTransaction(dir2, () => 'not-a-plan').state, 'rejected', '坏形状 → rejected')
      h.eq(TXN.withPackTransaction(dir2, () => { throw new Error('boom') }).state, 'rejected', 'build 抛错 → rejected')
      h.eq(TXN.withPackTransaction(dir2, () => Promise.resolve([{ rel: 'ledger.jsonl', content: 'x\n' }])).state, 'rejected', '异步 build → rejected（不把同步协议伪装成异步）')
      h.eq(TXN.withPackTransaction(dir2, () => [{ rel: '../escape.txt', content: 'x\n' }]).state, 'rejected', '落点跑出包根 → rejected')
      h.eq(TXN.withPackTransaction(dir2, () => [{ rel: 'ledger.jsonl', content: 42 }]).state, 'rejected', '内容不是字符串/Buffer → rejected')
      h.eq(dirSnapshot(dir2), before, '被拒时**一个字节都没动**（含锁与日志）')
    })

    check('T09-txn-remove-rollback', () => {
      const dir = fixture('remove', 'gone\n')
      fs.writeFileSync(path.join(dir, 'notes', 'seq.txt'), 'old\n', 'utf8')
      const okRun = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', remove: true }])
      h.eq(okRun.state, 'committed', `删除提交（error=${okRun.error}）`)
      h.eq(ledgerOf(dir), null, 'ledger.jsonl 被删掉')
      // 回滚分支：**唯一的落位**（notes/seq.txt，ledger.jsonl 是删除、不走 rename）失败
      // ⇒ 被删的与被改的都要回到写前
      const dir2 = fixture('remove-rollback', 'gone2\n')
      fs.writeFileSync(path.join(dir2, 'notes', 'seq.txt'), 'old2\n', 'utf8')
      const r = TXN.withPackTransaction(dir2, () => [{ rel: 'ledger.jsonl', remove: true }, { rel: 'notes/seq.txt', content: 'new\n' }], {
        fs: (() => {
          const real = fs
          return { ...real, renameSync: (a, b) => { if (String(a).includes('seq.txt.tmp-txn-') && String(b).endsWith('seq.txt')) { const e = new Error('injected'); e.code = 'EACCES'; throw e } return real.renameSync(a, b) } }
        })(),
      })
      h.eq(r.state, 'rolled-back', `state（error=${r.error}）`)
      h.eq(ledgerOf(dir2), 'gone2\n', '被删的台账**还原**了')
      h.eq(fs.readFileSync(path.join(dir2, 'notes', 'seq.txt'), 'utf8'), 'old2\n', '被改的 seq 也回到写前')
      h.eq(lockExists(dir2), false, '回滚成功要放锁')
    })

    // ─────────────────────────────────────────────── ② 每个 IO 步骤分别注入失败
    check('T09-txn-eacces-temp', () => {
      const dir = fixture('fault-temp', 'a\n')
      const before = dirSnapshot(dir)
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: wrapFs({ fault: 'write-temp:EACCES' }) })
      h.eq(r.state, 'rolled-back', `state（error=${r.error}）`)
      h.eq(/EACCES/.test(String(r.error)), true, `错误里要如实带 EACCES：${r.error}`)
      h.eq(r.rollbackError, null, '回滚成功时 rollbackError 必须为 null')
      h.eq(ledgerOf(dir), 'a\n', '台账回到写前')
      h.eq(dirSnapshot(dir), before, '夹具目录逐字节回到写前（锁与日志都不留）')
      evidenceOf('fault-eacces-temp', { result: r, ledger: ledgerOf(dir) })
    })

    check('T09-txn-enospc-journal', () => {
      const dir = fixture('fault-journal', 'a\n')
      const before = dirSnapshot(dir)
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: wrapFs({ fault: 'write-journal:ENOSPC:1' }) })
      h.eq(r.state, 'rolled-back', `state（error=${r.error}）`)
      h.eq(/ENOSPC/.test(String(r.error)), true, `错误里要如实带 ENOSPC：${r.error}`)
      h.eq(ledgerOf(dir), 'a\n', '台账没动')
      h.eq(dirSnapshot(dir), before, '目录逐字节回到写前')
      // 第 2 次写 journal（committed，**提交点**）坏掉：目标已经改了 ⇒ 必须回滚，不许半提交
      const dir2 = fixture('fault-commitmark', 'a\n')
      const r2 = TXN.withPackTransaction(dir2, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: wrapFs({ fault: 'write-journal:ENOSPC:2' }) })
      h.eq(r2.state, 'rolled-back', `提交标记写不下 → rolled-back（error=${r2.error}）`)
      h.eq(/ENOSPC/.test(String(r2.error)), true, '提交标记失败也如实带码')
      h.eq(ledgerOf(dir2), 'a\n', '目标回到写前（**没有半提交**）')
      h.eq(dirSnapshot(dir2), (() => { const d = fixture('fault-commitmark-ref', 'a\n'); const s = dirSnapshot(d); fs.rmSync(d, { recursive: true, force: true }); return s })(), '目录逐字节回到写前')
      evidenceOf('fault-enospc-journal', { prepared: r, commitMarker: r2 })
    })

    check('T09-txn-eacces-rename', () => {
      const dir = fixture('fault-rename', 'a\n')
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: renameLedgerFault() })
      h.eq(r.state, 'rolled-back', `state（error=${r.error}）`)
      h.eq(/EACCES/.test(String(r.error)), true, `错误里要如实带 EACCES：${r.error}`)
      h.eq(ledgerOf(dir), 'a\n', '台账回到写前')
      h.eq(lockExists(dir), false, '回滚成功要放锁')
      h.eq(txnDirs(dir).length, 0, '回滚成功要清日志')
      evidenceOf('fault-eacces-rename', { result: r, ledger: ledgerOf(dir) })
    })

    check('T09-txn-lock-meta-fault', () => {
      const dir = fixture('fault-lock', 'a\n')
      const before = dirSnapshot(dir)
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: wrapFs({ fault: 'write-lock:EACCES' }) })
      h.eq(r.ok, false, '拿不到锁不是成功')
      h.eq(r.state, 'rejected', `state（实得 ${r.state}，error=${r.error}）`)
      h.eq(/锁元数据写不下/.test(String(r.error)), true, `要说清是锁元数据：${r.error}`)
      h.eq(dirSnapshot(dir), before, '拒绝时一个字节都没动（空锁也收回去了）')
      evidenceOf('fault-lock-meta', { result: r })
    })

    check('T09-txn-rollback-error', () => {
      const dir = fixture('fault-rollback', 'a\n')
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: renameLedgerFaultAlways() })
      h.eq(r.state, 'recovery-required', `state（error=${r.error}）`)
      h.eq(r.ok, false, 'ok=false')
      h.eq(typeof r.rollbackError === 'string' && r.rollbackError.length > 0, true, `rollbackError 必须如实给出：${JSON.stringify(r.rollbackError)}`)
      h.eq(/EACCES/.test(String(r.rollbackError)), true, 'rollbackError 带原始错误码')
      h.eq(lockExists(dir), true, '回滚失败**不许放锁**')
      const dirs = txnDirs(dir)
      h.eq(dirs.length, 1, `回滚失败必须保留日志（实得 ${dirs.length} 个）`)
      const j = readJson(path.join(dir, '.whale-txn', dirs[0], 'journal.json'))
      h.eq(j.schema, 'whale-txn/1', 'journal schema')
      h.eq(j.state, 'recovery-required', 'journal 状态')
      h.eq(Array.isArray(j.files) && j.files.length === 1, true, 'journal 记下了写前字节的落点')
      h.eq(j.files[0].rel, 'ledger.jsonl', 'journal 点名了目标')
      h.eq(fs.existsSync(path.join(dir, '.whale-txn', dirs[0], j.files[0].backup)), true, '备份真的落在日志目录里')
      evidenceOf('rollback-error-journal', j)
    })

    check('T09-txn-refuse-after-rollback-failure', () => {
      const dir = fixture('refuse', 'a\n')
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { fs: renameLedgerFaultAlways() })
      h.eq(r.state, 'recovery-required', '前置：先造出回滚失败')
      const r2 = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'c\n' }])
      h.eq(r2.ok, false, '下一次普通写被拒')
      h.eq(r2.state, 'recovery-required', '拒绝的理由就是"还有待恢复的日志"')
      h.eq(/回滚失败/.test(String(r2.error)), true, `拒的话要说清为什么：${r2.error}`)
      h.eq(ledgerOf(dir), 'a\n', '被拒的写没有副作用')
      const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'executor-t09' })
      h.eq(rec.ok, true, `离线恢复（error=${rec.error}）`)
      h.eq(rec.state, 'recovered', 'state')
      h.eq(rec.restored.length, 1, `还原了 1 件（实得 ${rec.restored.length}）`)
      h.eq(ledgerOf(dir), 'a\n', '恢复后 = 原状态')
      h.eq(lockExists(dir), false, '恢复后锁要放掉')
      h.eq(txnDirs(dir).length, 0, '恢复后日志要收干净')
      const r3 = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'd\n' }])
      h.eq(r3.state, 'committed', `恢复之后普通写放行（error=${r3.error}）`)
      h.eq(ledgerOf(dir), 'd\n', '新写生效')
    })

    // ─────────────────────────────────────────────── ③ 进程中断（真杀）+ 离线恢复
    const killCase = (id, killArg, expect, label) => {
      const slug = killArg.replace(/[:]/g, '-')
      const dir = fixture(`kill-${slug}`, 'base\n')
      const report = path.join(temp, `kill-${slug}.json`)
      const markersBefore = new Set(fs.readdirSync('E:/Temp').filter((n) => n.startsWith('whale-T09-killed-')))
      const res = spawnSync(process.execPath, [SELF, '--mode=txn', `--root=${dir}`, `--report=${report}`,
        '--build=append', '--params={"line":"base2"}', `--kill=${killArg}`], {
        cwd: REPO, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      })
      // 杀点 marker 落在 E:/Temp 根（名字带子进程 pid）—— 这就是"真走到那个缝"的证据
      const markers = fs.readdirSync('E:/Temp').filter((n) => n.startsWith('whale-T09-killed-') && !markersBefore.has(n))
      const dirs = txnDirs(dir)
      const journal = (() => {
        if (dirs.length !== 1) return null
        const p = path.join(dir, '.whale-txn', dirs[0], 'journal.json')
        return fs.existsSync(p) ? readJson(p) : { journalMissing: true, entries: fs.readdirSync(path.join(dir, '.whale-txn', dirs[0])) }
      })()
      // 恢复**会放锁**，所以"中断那一刻锁还在不在"必须先取证再恢复
      const lockAtCrash = lockExists(dir)
      const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'executor-t09-kill' })
      const after = ledgerOf(dir)
      evidenceOf(`kill-${slug}`, {
        killArg, exit: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr,
        killMarkers: markers, journalDirs: dirs, lockAtCrash, journal, recover: rec, ledgerAfter: after,
      })
      check(id, () => {
        h.eq(res.status === 0, false, `写进程必须**真的被杀**（实得 exit=${res.status} signal=${res.signal}）`)
        h.eq(markers.length > 0, true, `杀点确实走到了（E:/Temp 下的 marker：${markers.join(',') || '（无）'}）`)
        h.eq(dirs.length, 1, `中断必须留下日志残骸（实得 ${dirs.length} 个）`)
        // 杀在暂存阶段时 journal.json 还没写出来 —— 那是**合法**的残骸（此刻没有任何目标被改）
        h.eq(journal.journalMissing === true || journal.schema === 'whale-txn/1', true, `残骸要么是 whale-txn/1 日志、要么是还没写 journal 的暂存残骸：${JSON.stringify(journal)}`)
        h.eq(lockAtCrash, true, '中断那一刻锁还在（下次普通写会被拒，不是静默继续）')
        h.eq(rec.ok, true, `离线恢复（error=${rec.error}）`)
        h.eq(expect.includes(after), true, `${label}：终态必须是「原状态」或「完整已提交状态」，实得 ${JSON.stringify(after)}`)
        h.eq(lockExists(dir), false, '恢复后锁要放掉')
        h.eq(txnDirs(dir).length, 0, '恢复后日志要收干净')
      })
    }
    killCase('T09-txn-kill-stage-staging', 'write-temp', ['base\n'], '杀在暂存阶段')
    killCase('T09-txn-kill-stage-prepared', 'write-journal:1', ['base\n', 'base\nbase2\n'], '杀在 journal(prepared) 阶段')
    killCase('T09-txn-kill-stage-rename', 'rename', ['base\n', 'base\nbase2\n'], '杀在落位阶段')
    killCase('T09-txn-kill-stage-commit-marker', 'write-journal:2', ['base\n', 'base\nbase2\n'], '杀在提交标记阶段')

    check('T09-txn-recover-exclusive', () => {
      const dir = fixture('recover-committed', 'a\n')
      const txnId = 'fixture-committed-0001'
      const jd = path.join(dir, '.whale-txn', txnId)
      fs.mkdirSync(jd, { recursive: true })
      fs.writeFileSync(path.join(jd, 'backup-0.bin'), 'a\n', 'utf8')
      writeJson(path.join(jd, 'journal.json'), {
        schema: 'whale-txn/1', txnId, root: dir, state: 'committed', startedAt: new Date().toISOString(),
        files: [{ rel: 'ledger.jsonl', target: path.join(dir, 'ledger.jsonl'), remove: false, backup: 'backup-0.bin', before: 2 }],
      })
      fs.writeFileSync(path.join(dir, 'ledger.jsonl'), 'a\ncommitted\n', 'utf8')
      const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'x' })
      h.eq(rec.ok, true, `恢复（error=${rec.error}）`)
      h.eq(rec.keptCommitted.join(','), txnId, 'committed 残骸走"保留现状"')
      h.eq(rec.restored.length, 0, 'committed 残骸不许还原备份')
      h.eq(ledgerOf(dir), 'a\ncommitted\n', '**完整已提交状态**保留')
      h.eq(txnDirs(dir).length, 0, '日志收干净')
      const rec2 = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'x' })
      h.eq(rec2.ok, true, '恢复幂等')
      h.eq(rec2.examined.length, 0, '第二次没有残骸可看')
      const dir2 = fixture('recover-empty', 'b\n')
      fs.mkdirSync(path.join(dir2, '.whale-txn', 'fixture-empty-0002'), { recursive: true })
      const rec3 = TXN.recoverPack(dir2, { offline: true, confirm: true, ownerToken: 'x' })
      h.eq(rec3.discarded.length, 1, '空残骸被丢弃')
      h.eq(ledgerOf(dir2), 'b\n', '原状态不动')
    })

    check('T09-txn-recover-confirm-gate', () => {
      const dir = fixture('recover-gate', 'a\n')
      const jd = path.join(dir, '.whale-txn', 'fixture-gate-0003')
      fs.mkdirSync(jd, { recursive: true })
      fs.writeFileSync(path.join(jd, 'backup-0.bin'), 'a\n', 'utf8')
      writeJson(path.join(jd, 'journal.json'), {
        schema: 'whale-txn/1', txnId: 'fixture-gate-0003', root: dir, state: 'prepared', startedAt: new Date().toISOString(),
        files: [{ rel: 'ledger.jsonl', target: path.join(dir, 'ledger.jsonl'), remove: false, backup: 'backup-0.bin', before: 2 }],
      })
      fs.writeFileSync(path.join(dir, 'ledger.jsonl'), 'a\nhalf\n', 'utf8')
      const before = dirSnapshot(dir)
      for (const [label, opts] of [
        ['没有 offline', { confirm: true, ownerToken: 'x' }],
        ['没有 confirm', { offline: true, ownerToken: 'x' }],
        ['没有 ownerToken', { offline: true, confirm: true }],
      ]) {
        const r = TXN.recoverPack(dir, opts)
        h.eq(r.ok, false, `${label} → 拒`)
        h.eq(r.state, 'rejected', `${label} → state=rejected`)
      }
      h.eq(dirSnapshot(dir), before, '被拒的恢复**一个字节都没动**')
      const r = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'x' })
      h.eq(r.ok, true, `给齐三项才动盘（error=${r.error}）`)
      h.eq(ledgerOf(dir), 'a\n', '半提交被还原成**原状态**')
    })

    // ─────────────────────────────────────────────── ④ 并发：两进程各 100 条 × 10 轮
    checkAsync('T09-txn-concurrent-10x200', async () => {
      const rounds = []
      for (let round = 1; round <= 10; round++) {
        const dir = fixture(`concurrent-r${round}`)
        const reports = [0, 1].map((w) => path.join(temp, `concurrent-r${round}-w${w}.json`))
        const [a, b] = await Promise.all([0, 1].map((w) => spawnWorker([
          '--mode=concurrent', `--root=${dir}`, `--report=${reports[w]}`, `--writer=${w}`, `--round=${round}`,
        ])))
        const docs = reports.map((p) => (fs.existsSync(p) ? readJson(p) : null))
        const recs = (ledgerOf(dir) ?? '').split(/\r?\n/).filter((s) => s.trim()).map((s) => JSON.parse(s))
        const seqs = recs.map((r) => r.seq)
        const ops = recs.map((r) => r.op)
        const txns = recs.map((r) => r.txnId)
        rounds.push({
          round, exit: [a.code, b.code], signal: [a.signal, b.signal],
          writers: docs.map((d) => (d ? { done: d.done, failed: d.failed.length, crash: d.crash || null, maxAttempts: d.maxAttempts } : null)),
          records: recs.length, uniqueSeq: new Set(seqs).size, uniqueOp: new Set(ops).size, uniqueTxn: new Set(txns).size,
        })
        h.eq(a.code, 0, `第 ${round} 轮 writer0 退出码（signal=${a.signal}）`)
        h.eq(b.code, 0, `第 ${round} 轮 writer1 退出码（signal=${b.signal}）`)
        h.eq(docs[0] && docs[0].failed.length, 0, `第 ${round} 轮 writer0 没有失败的事务：${JSON.stringify(docs[0] && docs[0].failed.slice(0, 3))}`)
        h.eq(docs[1] && docs[1].failed.length, 0, `第 ${round} 轮 writer1 没有失败的事务：${JSON.stringify(docs[1] && docs[1].failed.slice(0, 3))}`)
        h.eq(docs[0] && docs[0].done, 100, `第 ${round} 轮 writer0 写了 100 条`)
        h.eq(docs[1] && docs[1].done, 100, `第 ${round} 轮 writer1 写了 100 条`)
        h.eq(recs.length, 200, `第 ${round} 轮台账里必须**全部 200 条**都在（一条都不许被覆盖）`)
        h.eq(new Set(seqs).size, 200, `第 ${round} 轮序号唯一（去重后 ${new Set(seqs).size}）`)
        h.eq(new Set(ops).size, 200, `第 ${round} 轮操作标识唯一（去重后 ${new Set(ops).size}）`)
        h.eq(new Set(txns).size, 200, `第 ${round} 轮每个事务一个 id（版本无冲突）`)
        h.eq(seqs.slice().sort((x, y) => x - y).join(','), Array.from({ length: 200 }, (_, i) => i + 1).join(','), `第 ${round} 轮序号恰好 1..200（无跳号、无重复）`)
        h.eq(lockExists(dir), false, `第 ${round} 轮跑完不留锁`)
        h.eq(txnDirs(dir).length, 0, `第 ${round} 轮跑完不留日志`)
      }
      evidenceOf('concurrent-rounds', rounds)
    })

    // ─────────────────────────────────────────────── ⑤ 锁：不自动强抢 / 忙完要放
    checkAsync('T09-txn-no-auto-steal', async () => {
      const dir = fixture('lock-steal', 'a\n')
      const report = path.join(temp, 'lock-holder.json')
      const holder = spawnWorker(['--mode=txn', `--root=${dir}`, `--report=${report}`, '--build=slow',
        '--params={"ms":2500}', '--owner=holder-token', '--timeoutMs=30000'])
      const t0 = Date.now()
      while (!lockReady(dir) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25))
      h.eq(lockExists(dir), true, '持锁进程已经把锁建出来了')
      h.eq(lockReady(dir), true, '锁元数据也写好了')
      h.eq(readJson(path.join(dir, '.whale-write.lock', 'lock.json')).ownerToken, 'holder-token', '锁元数据写着持有者')
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { ownerToken: 'intruder' })
      h.eq(r.state, 'busy', `拿不到锁 → busy（实得 ${r.state}，error=${r.error}）`)
      h.eq(r.ok, false, 'busy 不是成功')
      h.eq(/不自动强抢/.test(String(r.error)), true, `要说清"不自动强抢"：${r.error}`)
      h.eq(ledgerOf(dir), 'a\n', 'busy 的写没有任何副作用')
      h.eq(readJson(path.join(dir, '.whale-write.lock', 'lock.json')).ownerToken, 'holder-token', '**锁的持有者没被换掉**（这就是"不自动强抢"）')
      const hr = await holder
      h.eq(hr.code, 0, `持锁进程正常退出（code=${hr.code} signal=${hr.signal}）`)
      h.eq(lockExists(dir), false, '持锁进程正常提交后放锁')
      h.eq(ledgerOf(dir), 'slow\n', '持锁进程自己提交成功（`slow` 策略写的就是 `slow\\n`，它会覆盖写前内容）')
      const holderDoc = fs.existsSync(report) ? readJson(report) : null
      evidenceOf('lock-no-steal', { busy: r, holder: hr, holderDoc, ledger: ledgerOf(dir) })
      h.eq(holderDoc && holderDoc.result && holderDoc.result.state, 'committed', `持锁进程的事务真的提交了：${JSON.stringify(holderDoc && holderDoc.result)}`)
    })

    checkAsync('T09-txn-busy-release', async () => {
      const dir = fixture('lock-release', 'a\n')
      const report = path.join(temp, 'lock-release.json')
      const holder = spawnWorker(['--mode=txn', `--root=${dir}`, `--report=${report}`, '--build=slow',
        '--params={"ms":1200}', '--owner=holder-token', '--timeoutMs=30000'])
      const t0 = Date.now()
      while (!lockReady(dir) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25))
      const busy = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'b\n' }])
      h.eq(busy.state, 'busy', '锁被占时 busy')
      await holder
      const ok = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'c\n' }])
      h.eq(ok.state, 'committed', `放锁之后普通写能进（error=${ok.error}）`)
      h.eq(ledgerOf(dir), 'c\n', '新写生效')
    })

    check('T09-txn-timeout', () => {
      const dir = fixture('timeout', 'a\n')
      const before = dirSnapshot(dir)
      const r = TXN.withPackTransaction(dir, () => { const until = Date.now() + 80; while (Date.now() < until) { /* busy */ } return [{ rel: 'ledger.jsonl', content: 'b\n' }] }, { timeoutMs: 20 })
      h.eq(r.state, 'rejected', `超时 → rejected（实得 ${r.state}，error=${r.error}）`)
      h.eq(/超时/.test(String(r.error)), true, `要说清是超时：${r.error}`)
      h.eq(dirSnapshot(dir), before, '超时**一个字节都没写**，也不留锁与日志')
      h.eq(TXN.withPackTransaction(dir, () => [], { timeoutMs: 0 }).state, 'rejected', 'timeoutMs=0 → rejected')
      h.eq(TXN.withPackTransaction(dir, () => [], { timeoutMs: 1.5 }).state, 'rejected', 'timeoutMs=1.5 → rejected')
    })

    // ─────────────────────────────────────────────── ⑥ 离线恢复 CLI
    check('T09-recover-cli', () => {
      const dir = fixture('cli', 'a\n')
      const r = TXN.withPackTransaction(dir, () => [{ rel: 'ledger.jsonl', content: 'half\n' }], { fs: renameLedgerFaultAlways() })
      h.eq(r.state, 'recovery-required', '前置：残骸就位')
      const checkRun = spawnSync(process.execPath, [RECOVER_ABS, dir, '--check'], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
      evidenceOf('cli-check', { exit: checkRun.status, stdout: checkRun.stdout, stderr: checkRun.stderr })
      h.eq(checkRun.status, 1, `--check 有残骸时 exit 1（实得 ${checkRun.status}）`)
      h.eq(/PENDING recover-ledgers/.test(String(checkRun.stdout)), true, `--check 输出点名 PENDING：${checkRun.stdout}`)
      h.eq(lockExists(dir), true, '--check 是只读的：锁还在')
      const run = spawnSync(process.execPath, [RECOVER_ABS, dir, '--offline', '--confirm', '--owner=executor-t09-cli'], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
      evidenceOf('cli-recover', { exit: run.status, stdout: run.stdout, stderr: run.stderr })
      h.eq(run.status, 0, `CLI 恢复 exit 0（实得 ${run.status}，stderr=${run.stderr}）`)
      h.eq(/^PASS recover-ledgers/.test(String(run.stdout)), true, `CLI 一行回执：${run.stdout}`)
      h.eq(/recovered=1/.test(String(run.stdout)), true, 'CLI 报出还原了 1 件')
      h.eq(ledgerOf(dir), 'a\n', 'CLI 恢复后 = 原状态')
      h.eq(lockExists(dir), false, 'CLI 恢复后锁放掉')
      const clean = spawnSync(process.execPath, [RECOVER_ABS, dir, '--check'], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
      h.eq(clean.status, 0, `没有残骸时 --check exit 0（实得 ${clean.status}）`)
      h.eq(/^OK recover-ledgers/.test(String(clean.stdout)), true, `干净时输出 OK：${clean.stdout}`)
    })

    check('T09-recover-cli-refuses', () => {
      const dir = fixture('cli-refuse', 'a\n')
      const run = (flags) => spawnSync(process.execPath, [RECOVER_ABS, dir, ...flags], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
      const rows = []
      const r1 = run(['--confirm', '--owner=x'])
      rows.push({ flags: '--confirm --owner=x', exit: r1.status, stderr: r1.stderr })
      h.eq(r1.status, 2, `缺 --offline → exit 2（实得 ${r1.status}）`)
      h.eq(/offline/.test(String(r1.stderr)), true, `要说清缺 offline：${r1.stderr}`)
      const r2 = run(['--offline', '--owner=x'])
      rows.push({ flags: '--offline --owner=x', exit: r2.status, stderr: r2.stderr })
      h.eq(r2.status, 2, `缺 --confirm → exit 2（实得 ${r2.status}）`)
      h.eq(/confirm/.test(String(r2.stderr)), true, `要说清缺 confirm：${r2.stderr}`)
      const r3 = run(['--offline', '--confirm'])
      rows.push({ flags: '--offline --confirm', exit: r3.status, stderr: r3.stderr })
      h.eq(r3.status, 2, `缺 --owner → exit 2（实得 ${r3.status}）`)
      h.eq(/ownerToken|owner/.test(String(r3.stderr)), true, `要说清缺 owner：${r3.stderr}`)
      const noRoot = spawnSync(process.execPath, [RECOVER_ABS], { cwd: REPO, encoding: 'utf8', timeout: 60000 })
      rows.push({ flags: '(无参数)', exit: noRoot.status, stderr: noRoot.stderr })
      h.eq(noRoot.status, 2, `没有课程包根 → exit 2（实得 ${noRoot.status}）`)
      evidenceOf('cli-refuses', rows)
      h.eq(lockExists(dir), false, '被拒的 CLI 没留锁')
      h.eq(ledgerOf(dir), 'a\n', '被拒的 CLI 没动台账')
    })

    // ─────────────────────────────────────────────── ⑦ 协议落点不许进产物 / 发布物
    check('T09-not-published', () => {
      const PUB = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'public-files.cjs'))
      for (const rel of ['.whale-txn/x/journal.json', '.whale-write.lock', '.whale-write.lock/lock.json']) {
        h.eq(PUB.isDenied(rel), true, `公开清单必须拒：${rel}`)
        const r = PUB.resolvePublicFile(REPO, '/' + rel)
        // 判据是**绝不 200**：事务日志/锁无论被归到"路径不安全(403)"还是"不在清单里(404)"都不许发出去
        h.eq(r.status === 200, false, `静态读取必须拒（不许 200）：${rel}（实得 ${r.status}）`)
        h.eq(r.status === 403 || r.status === 404, true, `静态读取必须是 403/404：${rel}（实得 ${r.status}）`)
      }
      const man = PUB.publicManifest(REPO)
      h.eq(man.files.some((f) => f.startsWith('.whale-txn') || f.startsWith('.whale-write')), false, '公开清单里没有协议落点')
      // 发布构建器：白名单只认四个目录，协议落点在包根 ⇒ 结构上进不去；再核一条反空转清单
      const bp = fs.readFileSync(path.join(REPO, 'lib', 'pack-template', 'tools', 'build-public.js'), 'utf8')
      const wl = bp.match(/const WHITELIST = \[([^\]]*)\]/)
      h.eq(!!wl, true, 'build-public.js 有 WHITELIST')
      h.eq(/whale-txn|whale-write/.test(wl[1]), false, '发布白名单里没有协议落点（白名单 = 只有 lessons/assets/reference/glossary）')
      const fb = bp.match(/const FORBIDDEN = \[([\s\S]*?)\n\]/)
      h.eq(!!fb, true, 'build-public.js 有 FORBIDDEN 反空转清单')
      h.eq(/whale-txn/.test(fb[1]), true, '反空转清单里点名了 .whale-txn')
      h.eq(/whale-write/.test(fb[1]), true, '反空转清单里点名了 .whale-write.lock')
      const bootSrc = fs.readFileSync(path.join(REPO, 'lib', 'pack-template', 'tools', 'offline-bootstrap.js'), 'utf8')
      const keepBlock = bootSrc.match(/const TOOLS_KEEP = \[([\s\S]*?)\n\]/)
      h.eq(!!keepBlock, true, 'offline-bootstrap.js 有 TOOLS_KEEP')
      h.eq(/whale-txn|whale-write/.test(keepBlock[1]), false, 'TOOLS_KEEP 里没有协议落点（离线骨架不铺运行态）')
      const target = path.join(temp, 'scaffold-publish')
      fs.mkdirSync(target)
      const built = require_(path.join(REPO, 'lib', 'pack-scaffold.js')).writeScaffold(target)
      h.eq(built.ok, true, `建包成功（${built.error}）`)
      h.eq(fs.existsSync(path.join(target, '.whale-txn')), false, '新建的包里没有 .whale-txn')
      h.eq(fs.existsSync(path.join(target, '.whale-write.lock')), false, '新建的包里没有 .whale-write.lock')
      // **事务件随包发** ⇒ 新建的包里必须有它（新包将来要按同一套口径提交/恢复）。
      // 恢复 CLI（T09-A1 归位到**仓根** `tools/recover-ledgers.mjs`）是**运维工具、不随包** ——
      // 所以这里**不再断言**新建包里有 CLI，反而断言它**不在**包里（它不是模板件）。
      h.eq(fs.existsSync(path.join(target, 'tools', 'ledger-transaction.cjs')), true, '新建的包里有 tools/ledger-transaction.cjs（事务件随包发）')
      h.eq(fs.existsSync(path.join(target, 'tools', 'recover-ledgers.mjs')), false, '新建的包里没有 tools/recover-ledgers.mjs（恢复 CLI 是仓根工具，不随包）')
      // 两件都**不在** ENGINE_FILES，但理由不同，别把 CLI 说成模板件：
      //   · 事务件 = **随包件**，只是今天没有任何引擎入口 require 它（受信闭包是机械重算的；
      //     接线到台账写口是 T10/T11/T12）；
      //   · 恢复 CLI = **仓根运维工具**（住在仓根 `tools/`，不在 `lib/pack-template/` 里），
      //     它永远不该出现在"包的引擎闭包"里。
      const EP = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'engine-policy.cjs'))
      h.eq(EP.ENGINE_FILES.includes('tools/ledger-transaction.cjs'), false, 'ENGINE_FILES 不收事务件（随包件，但闭包是机械重算的：今天没有引擎入口 require 它）')
      h.eq(EP.ENGINE_FILES.includes('tools/recover-ledgers.mjs'), false, 'ENGINE_FILES 不收恢复 CLI（它是仓根运维工具，不是模板件）')

      // —— 正例（T09-A1）：证明「隐藏分量一律不公开」这条形状规则**没有变成过度拒绝** ——
      // 用**既有 `resolvePublicFile` 真实调用**（不是读 `isDenied` 的自述），四条都必须 200。
      // 夹具 = 上面刚建出来的包（只含随包模板件）。两处**替换**按卡面「夹具缺某文件就换成
      // 夹具里真实存在的公开资源」办，并在这里写清换了哪个：
      //   ① 卡面举的 `/reference/NOTES.html` **没有**换进来：`reference/` 是 D03 明写的
      //      **私人派生页**（`DENY_PREFIXES` 里有它，T06 判它 404），不是隐藏分量规则该放开的东西；
      //      改用包根入口页 `/index.html`（`ROOT_FILES.reader` 里的真实公开件，模板包里有）。
      //   ② 「任一真实课程页」：模板包**没有**课程页（lessons/ 是内容，随包模板不带），
      //      所以按构建器口径在夹具里补一份真的课程页 + `lessons/lessons.json` 索引
      //      （公开清单里课程页的唯一来源就是这份索引），再走同一条真实解析。
      fs.mkdirSync(path.join(target, 'lessons', 'programming'), { recursive: true })
      fs.writeFileSync(path.join(target, 'lessons', 'programming', '0001-fixture.html'),
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>正例课程页</title></head><body><p>fixture</p></body></html>\n', 'utf8')
      fs.writeFileSync(path.join(target, 'lessons', 'lessons.json'), JSON.stringify({
        v: 1, source: 'lessons/src',
        lessons: [{ title: '正例课程页', number: 1, rel: 'programming/0001-fixture.html', halo: 'programming', point: 'fixture' }],
      }, null, 2) + '\n', 'utf8')
      const positives = [
        ['/assets/theme.css', '主题 CSS（随包模板件，夹具里真实存在）'],
        ['/starmap/index.html', '星图页面壳（随包模板件，夹具里真实存在）'],
        ['/index.html', '包根入口页（替代卡面举的 /reference/NOTES.html：后者是 D03 明写的私人派生页，T06 判 404）'],
        ['/lessons/programming/0001-fixture.html', '真实课程页（按构建器口径在夹具里补的，经 lessons/lessons.json 索引）'],
      ]
      const posRows = []
      for (const [url, why] of positives) {
        const r = PUB.resolvePublicFile(target, url)
        posRows.push({ url, why, status: r.status, rel: r.rel, file: r.file || null, error: r.error || null })
        h.eq(r.status, 200, `正例必须 200：${url}（${why}；实得 ${r.status}${r.error ? '：' + r.error : ''}）`)
      }
      evidenceOf('not-published-positives', posRows)
      evidenceOf('not-published', { manifestFiles: man.files.length, denied: man.denied, positives: posRows })
    })

    // ─────────────────────────────────────────────── ⑧ 负向控制（产品真缝上的变异）
    check('T09-negative-controls', () => {
      const mutDir = path.join(temp, 'mutants')
      fs.mkdirSync(mutDir, { recursive: true })
      const src = fs.readFileSync(TXN_ABS, 'utf8')

      // 变异 A：锁获取改成"永远成功"（拿不到锁也照写）→ 互斥没了
      const lockMut = mutate(src,
        /  try \{\n    fs\.mkdirSync\(lock, \{ recursive: false \}\)\n  \} catch \(e\) \{\n    const code = e && e\.code \? e\.code : 'IO_ERROR'/,
        "  try {\n    fs.mkdirSync(lock, { recursive: false })\n  } catch (e) {\n    return { ok: true }; // MUTANT A: lock always succeeds\n  }\n  if (false) {\n    const code = e && e.code ? e.code : 'IO_ERROR'",
        'A 锁获取')
      const lockFile = path.join(mutDir, 'mutant-lock.cjs')
      fs.writeFileSync(lockFile, lockMut, 'utf8')
      const MutA = require_(lockFile)
      const dirA = fixture('mutant-lock', 'a\n')
      fs.mkdirSync(path.join(dirA, '.whale-write.lock'), { recursive: true })
      fs.writeFileSync(path.join(dirA, '.whale-write.lock', 'lock.json'), JSON.stringify({ schema: 'whale-txn/1', ownerToken: 'holder', pid: 1 }), 'utf8')
      const ra = MutA.withPackTransaction(dirA, () => [{ rel: 'ledger.jsonl', content: 'b\n' }], { ownerToken: 'intruder' })
      evidenceOf('mutant-lock', { state: ra.state, error: ra.error, ledger: ledgerOf(dirA) })
      h.eq(ra.state === 'busy', false, `负向控制 A：变异后必须不再回 busy（实得 ${ra.state}）`)
      h.eq(ledgerOf(dirA), 'b\n', '负向控制 A：变异后确实抢写成功（证明 T09-txn-no-auto-steal 抓得住它）')

      // 变异 B：回滚改成空操作 → 半提交留在盘上
      const rbMut = mutate(src,
        /  const rollback = \(\) => \{\n    const errors = \[\]/,
        '  const rollback = () => {\n    const errors = []\n    if (true) return errors // MUTANT B: rollback is a no-op',
        'B 回滚')
      const rbFile = path.join(mutDir, 'mutant-rollback.cjs')
      fs.writeFileSync(rbFile, rbMut, 'utf8')
      const MutB = require_(rbFile)
      const dirB = fixture('mutant-rollback', 'a\n')
      const rb = MutB.withPackTransaction(dirB, () => [{ rel: 'ledger.jsonl', content: 'half\n' }], { fs: renameLedgerFault() })
      evidenceOf('mutant-rollback', { state: rb.state, error: rb.error, rollbackError: rb.rollbackError, ledger: ledgerOf(dirB), txnDirs: txnDirs(dirB) })
      h.eq(rb.state === 'recovery-required', false, `负向控制 B：变异后不再如实报 recovery-required（实得 ${rb.state}）`)
      h.eq(rb.rollbackError === null, true, '负向控制 B：变异后 rollbackError 是 null（证明 T09-txn-rollback-error 抓得住它）')
      try { fs.rmSync(dirB, { recursive: true, force: true }) } catch { /* best effort */ }
    })

    // ─────────────────────────────────────────────── ⑨ 清理守卫（最后一条）
    check('T09-cleanup-guard', () => {
      const abs = path.resolve(temp)
      h.eq(path.dirname(abs).toLowerCase(), path.resolve('E:/Temp').toLowerCase(), `夹具在 E:/Temp 下：${abs}`)
      h.eq(path.basename(abs).startsWith(`whale-T09-${stamp}-`), true, `夹具名带本次 runId：${path.basename(abs)}`)
      h.eq(fs.existsSync(path.join(REPO, '.whale-txn')), false, '工作仓里没有被写进 .whale-txn')
      h.eq(fs.existsSync(path.join(REPO, '.whale-write.lock')), false, '工作仓里没有被写进 .whale-write.lock')
      h.eq(fs.existsSync(path.join(LIVE_PACK, '.whale-txn')), false, '用户活包里没有被写进 .whale-txn')
      h.eq(fs.existsSync(path.join(LIVE_PACK, '.whale-write.lock')), false, '用户活包里没有被写进 .whale-write.lock')
      for (const n of fs.readdirSync('E:/Temp').filter((x) => x.startsWith('whale-T09-killed-'))) {
        try { fs.rmSync(path.join('E:/Temp', n), { force: true }) } catch { /* best effort */ }
      }
      fs.rmSync(abs, { recursive: true, force: true })
      h.eq(fs.existsSync(abs), false, '夹具已清理')
    })
  } catch (e) {
    h.note(`壳异常：${e && e.stack ? e.stack : String(e)}`)
    check('T09-unexpected', () => { throw e })
  }

  for (const run of syncChecks) run()
  for (const run of asyncChecks) await run()

  process.exitCode = h.run()
  const casesFile = path.join(evidence, 'cases.jsonl')
  if (fs.existsSync(casesFile)) fs.writeFileSync(casesFile, fs.readFileSync(casesFile, 'utf8').replace(/^\uFEFF/, ''), 'utf8')
}

if (arg('mode')) await worker()
else await main()
