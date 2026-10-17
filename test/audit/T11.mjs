#!/usr/bin/env node
/**
 * T11 —— 独立写口与归档接入同一事务（报告 C01 / 计划 §6 T11）
 * ------------------------------------------------------------------
 * 卡面验收判据（原文）：
 *   「每个 IO 步骤分别注入 EACCES/ENOSPC/rename 失败，并模拟进程中断后恢复；
 *     两进程并发写 N 条，断言全部保留、序号唯一、版本无冲突。」
 * 补充（原文）：「归档进程与新提问进程并行，逐条核 pending∪processed 无丢失、无重复归档。」
 *
 * 本文件只碰**自建夹具**（`E:/Temp/whale-T11-*`）：不写用户活包 `E:\workplace\study`、
 * 不写只读快照。判据分五组：
 *   ① 四个包侧写口（`/ask` `/note` `/progress` 与课后调整）真的经事务件提交；
 *   ② 每个 IO 步骤分别注入 EACCES / ENOSPC / rename 失败 → 回执可重试、目标逐字节回到写前；
 *   ③ 进程中断（真 SIGKILL）→ 日志/锁残骸就位 → 独占离线恢复 → 原状态或完整已提交状态；
 *   ④ 两进程并发写 / 归档与新提问并行 / 宿主侧写口与包侧 handler 交叉写 → 不丢、不重号；
 *   ⑤ 负向控制：在临时副本里把提交退化成旧的"两步直写"，用同一个注入证明本套件抓得住它。
 *
 * 子进程一律 `stdio:'ignore'` + 结果走 report 文件（受限沙箱下 piped stdio 的 spawn 会被 EPERM 拒）。
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHarness, REPO, clip } from './harness.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')
const TXN_ABS = path.join(REPO, 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs')
const TXN = require_(TXN_ABS)
const LIVE_PACK = 'E:/workplace/study'

/** 固定用例 ID 全集（缺一条、多一条、重一条都算失败） */
const IDS = [
  'T11-ask-commit',
  'T11-ask-record-shape',
  'T11-ask-note-commit',
  'T11-ask-progress-commit',
  'T11-ask-progress-write-interface',
  'T11-ask-fault-seq-stage-eacces',
  'T11-ask-fault-pending-stage-enospc',
  'T11-ask-fault-seq-rename-eacces',
  'T11-ask-fault-journal-enospc',
  'T11-ask-note-fault-stage-eacces',
  'T11-ask-note-fault-rename-enospc',
  'T11-ask-progress-fault-adjust-eacces',
  'T11-drain-archive-and-keep',
  'T11-drain-fault-processed-eacces',
  'T11-drain-fault-pending-rename-enospc',
  'T11-ask-kill-recover',
  'T11-drain-kill-recover',
  'T11-concurrent-two-services',
  'T11-concurrent-drain-vs-ask',
  'T11-cross-host-pack',
  'T11-negative-control-old-write',
  'T11-cleanup-guard',
]

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8')
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}
const norm = (p) => String(p).replace(/\\/g, '/')
const ioErr = (code, msg = `injected ${code}`) => {
  const e = new Error(msg)
  e.code = code
  return e
}

// ================================================================ 子进程（夹具写者）

/** 向本机端口发一个 JSON POST（子进程自测用；不依赖 fetch） */
function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let doc = null
        try { doc = JSON.parse(raw) } catch { /* 保持 null，由判据报 */ }
        resolve({ status: res.statusCode, text: raw, doc })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('fixture request timeout')))
    req.end(text)
  })
}

function serviceBurst() {
  const root = arg('root')
  const port = Number(arg('port'))
  const count = Number(arg('count'))
  const kind = arg('kind') || 'ask'
  const writer = arg('writer') || 'w'
  const report = arg('report')
  const reportDoc = { pid: process.pid, kind, writer, port, results: [], failed: [], crash: null }
  ;(async () => {
    const api = require_(path.join(root, 'tools', 'ask-server.js'))
    const server = http.createServer(api.handleRequest)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    for (let i = 0; i < count; i++) {
      const body = kind === 'ask'
        ? { question: `${kind}-${writer}-${i}`, lesson: 'fixture/0001', page: 'lessons/fixture/0001-a.html', title: 'fixture' }
        : { text: `${kind}-${writer}-${i}`, anchor: 'fixture/0001' }
      const r = await post(port, kind === 'ask' ? '/ask' : '/note', body)
      reportDoc.results.push({ i, status: r.status, id: r.doc && r.doc.id, seq: r.doc && r.doc.seq, ok: !!(r.doc && r.doc.ok) })
      if (!(r.status === 200 && r.doc && r.doc.ok)) break
    }
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    reportDoc.failed = reportDoc.results.filter((x) => !x.ok)
    writeJson(report, reportDoc)
    process.exit(reportDoc.results.length === count && reportDoc.failed.length === 0 ? 0 : 1)
  })().catch((e) => {
    reportDoc.crash = `${e && e.code ? e.code + ': ' : ''}${e && e.message ? e.message : String(e)}`
    if (report) writeJson(report, reportDoc)
    process.exit(1)
  })
}

/**
 * 宿主侧写口形状：直接用**同一个**事务件写 `notes/notes.jsonl` + `notes/seq.txt`。
 * （T10 落地后宿主入口 `lib/notes-io.js#appendNote` 内部也是这一份；本卡不依赖它的进度。）
 */
function hostNotes() {
  const root = arg('root')
  const count = Number(arg('count'))
  const writer = arg('writer') || 'host'
  const report = arg('report')
  const doc = { pid: process.pid, writer, results: [], failed: [], crash: null }
  try {
    const txn = require_(path.join(root, 'tools', 'ledger-transaction.cjs'))
    for (let i = 0; i < count; i++) {
      let r = null
      let attempts = 0
      const deadline = Date.now() + 20000
      for (;;) {
        r = txn.withPackTransaction(root, ({ files }) => {
          const seqText = files['notes/seq.txt'] === undefined ? null : files['notes/seq.txt']
          const before = files['notes/notes.jsonl'] === undefined ? null : files['notes/notes.jsonl']
          const seq = (Number(String(seqText == null ? '' : seqText).replace(/^\uFEFF/, '').trim()) || 0) + 1
          const cur = before === null ? '' : String(before)
          const rec = { id: String(seq).padStart(4, '0'), seq, kind: '笔记', anchor: 'fixture/0001', text: `host-${writer}-${i}` }
          const prefix = cur.length > 0 && !cur.endsWith('\n') ? '\n' : ''
          return {
            files: [
              { rel: 'notes/notes.jsonl', content: cur + prefix + JSON.stringify(rec) + '\n' },
              { rel: 'notes/seq.txt', content: String(seq) + '\n' },
            ],
            value: { id: rec.id, seq },
          }
        }, { ownerToken: `host-writer-${writer}` })
        if (r.state !== 'busy' || Date.now() >= deadline) break
        attempts++
        sleepSync(2)
      }
      doc.results.push({ i, state: r.state, ok: r.ok, id: r.value && r.value.id, seq: r.value && r.value.seq, attempts })
      if (!r.ok) break
    }
    doc.failed = doc.results.filter((x) => !x.ok)
    writeJson(report, doc)
    process.exit(doc.results.length === count && doc.failed.length === 0 ? 0 : 1)
  } catch (e) {
    doc.crash = `${e && e.code ? e.code + ': ' : ''}${e && e.message ? e.message : String(e)}`
    if (report) writeJson(report, doc)
    process.exit(1)
  }
}

/** 真进程中断：不抛异常、不跑 finally、没有清理机会 */
function hardKill(marker, why) {
  try { fs.writeFileSync(marker, why + '\n', 'utf8') } catch { /* best effort */ }
  process.kill(process.pid, 'SIGKILL')
  process.abort()
  process.exit(97)
}

/** 在 `fs.renameSync` 的真缝上杀进程：目标命中才杀（不是"桩脚本写标记"） */
function killAtRename(marker, endsWith, why) {
  const real = fs.renameSync
  fs.renameSync = function (a, b) {
    if (norm(b).endsWith(endsWith)) hardKill(marker, why)
    return real(a, b)
  }
}

function killAsk() {
  const root = arg('root')
  const marker = arg('marker')
  const report = arg('report')
  const api = require_(path.join(root, 'tools', 'ask-server.js'))
  killAtRename(marker, 'questions/pending.jsonl', 'kill-ask at pending rename')
  const timer = setTimeout(() => { try { writeJson(report, { missedKill: true }) } catch { /* best effort */ } process.exit(1) }, 8000)
  timer.unref?.()
  // 正常情况下进程会在 renameSync 真缝里被杀；这里只是兜底（不吞：report 会写 missedKill）
  callApi(api, 'POST', '/ask', { question: 'kill-canary', lesson: 'fixture/0001' }).catch(() => {})
}

function killDrain() {
  const root = arg('root')
  const marker = arg('marker')
  const report = arg('report')
  const drain = require_(path.join(root, 'tools', 'drain-questions.js'))
  killAtRename(marker, 'questions/pending.jsonl', 'kill-drain at pending rename')
  const timer = setTimeout(() => { try { writeJson(report, { missedKill: true }) } catch { /* best effort */ } process.exit(1) }, 8000)
  timer.unref?.()
  drain.drainPending(root)
}

// ================================================================ HTTP 处理器替身（父进程判据）

/**
 * 直接调 `handleRequest(req,res)`：req 是 EventEmitter（`readBodyBytes` 的监听同步挂上），
 * res 只实现与产品代码用到的同一小组方法。`Host` 必须是本机回环（T07 的授权闸）。
 */
function callApi(api, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = pathname
    req.headers = { host: '127.0.0.1:8788' }
    req.complete = false
    req.aborted = false
    req.destroyed = false
    req.resume = () => {}
    const headers = {}
    let status = 0
    const res = {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      setHeader(k, v) { headers[String(k).toLowerCase()] = v },
      writeHead(code, h) { status = code; this.headersSent = true; if (h) Object.assign(headers, h) },
      end(text) {
        this.writableEnded = true
        let doc = null
        try { doc = JSON.parse(String(text)) } catch { /* 由判据报 */ }
        resolve({ status, headers, text: String(text == null ? '' : text), doc })
      },
    }
    try {
      void api.handleRequest(req, res)
    } catch (e) {
      reject(e)
      return
    }
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.complete = true
    req.emit('end')
  })
}

async function callWithFs(api, method, pathname, body, patch) {
  const saved = {}
  for (const key of Object.keys(patch)) { saved[key] = fs[key]; fs[key] = patch[key](fs[key]) }
  try { return await callApi(api, method, pathname, body) } finally {
    for (const key of Object.keys(saved)) fs[key] = saved[key]
  }
}

/** 故障工厂：命中路径才抛（其余 IO 一律透传） */
const failWrite = (match, code) => (real) => (p, data, opts) => {
  if (match(norm(p))) throw ioErr(code)
  return real(p, data, opts)
}
const failAppend = (match, code) => (real) => (p, data, opts) => {
  if (match(norm(p))) throw ioErr(code)
  return real(p, data, opts)
}
const failRename = (match, code) => (real) => (a, b) => {
  if (match(norm(b))) throw ioErr(code)
  return real(a, b)
}


// ================================================================ 父进程判据

async function main() {
  const h = createHarness({ card: 'T11', expectedIds: IDS })
  const stamp = `${Date.now()}-${process.pid}`
  const evidence = path.join(REPO, 'audit-evidence', 'T11')
  fs.mkdirSync(evidence, { recursive: true })
  fs.mkdirSync('E:/Temp', { recursive: true })
  let temp
  try {
    temp = fs.mkdtempSync(`E:/Temp/whale-T11-${stamp}-`)
  } catch (e) {
    h.block(`临时夹具环境不可用（E:/Temp 建不出来）：${String(e && e.message ? e.message : e).replace(/\s+/g, ' ')}`)
    process.exitCode = h.run()
    return
  }
  h.note(`fixture=${temp}\ntxn=${TXN_ABS}`)

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
    asyncChecks.push(async () => {
      try {
        const r = await fn()
        entry.actual = r === 'skip' ? 'skip' : 'pass'
        if (r === 'skip') entry.note = entry.note || '声明为 skip'
      } catch (e) {
        entry.actual = 'fail'
        entry.note = `抛异常：${e && e.message ? e.message : String(e)}`
        entry.detail = clip(e && e.stack ? e.stack : String(e))
      }
      if (entry.actual !== entry.expected) entry.note = `实跑=${entry.actual} 与声明=${entry.expected} 不符${entry.note ? '；' + entry.note : ''}`
    })
  }
  const evidenceOf = (name, payload) => h.evidence(path.join('cases', `${name}.txt`), clip(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 30000))

  /** 建一个自包含的课程包夹具（模板整树 + 一条课次 + 台账）。 */
  const makePack = (name, { pending = null, processed = null, registered = [] } = {}) => {
    const dir = path.join(temp, name)
    fs.cpSync(TEMPLATE, dir, { recursive: true })
    fs.mkdirSync(path.join(dir, 'questions'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'learning-records'), { recursive: true })
    // 课次映射表要的三角：产物页 / 源页 / EXPECT.json（这样 /note 的 anchor 能解析成 fixture/0001）
    for (const d of [path.join(dir, 'lessons', 'fixture'), path.join(dir, 'lessons', 'src', 'fixture'), path.join(dir, 'code', 'proj')]) {
      fs.mkdirSync(d, { recursive: true })
    }
    fs.writeFileSync(path.join(dir, 'lessons', 'fixture', '0001-a.html'), '<html><body>fixture</body></html>\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'lessons', 'src', 'fixture', '0001-a.html'), '<html><body>fixture</body></html>\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'code', 'proj', 'EXPECT.json'), JSON.stringify({
      lessons: [{ id: 'fixture/0001', title: '夹具课' }],
    }, null, 2) + '\n', 'utf8')
    const ledgerSrc = `module.exports = {\n${registered.map((id) => `  '${id}': { id: '${id}', status: 'answered' }`).join(',\n')}\n};\n`
    fs.writeFileSync(path.join(dir, 'assets', 'questions-data.js'), ledgerSrc, 'utf8')
    if (pending !== null) {
      fs.writeFileSync(path.join(dir, 'questions', 'pending.jsonl'), pending, 'utf8')
      // 旧台账的序号必须接着排：从未发出过的 seq 会让"并发新提问"从 0001 重号，
      // 那是夹具自造的缺陷，不是产品缺陷。取现有 pending 里最大的四位 id。
      const maxId = pendingLinesMax(pending)
      if (maxId > 0) fs.writeFileSync(path.join(dir, 'questions', 'seq.txt'), String(maxId), 'utf8')
    }
    if (processed !== null) fs.writeFileSync(path.join(dir, 'questions', 'processed.jsonl'), processed, 'utf8')
    return dir
  }

  const txt = (dir, rel) => {
    const p = path.join(dir, rel)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  const parseJson = (text) => JSON.parse(String(text))
  const linesOf = (text) => (text === null || text === undefined ? [] : String(text).split('\n').filter((l) => l.trim()))
  const recsOf = (dir, rel) => linesOf(txt(dir, rel)).map((l) => JSON.parse(l))
  const pendingLinesMax = (text) => {
    let max = 0
    for (const line of linesOf(text)) {
      try {
        const id = String(JSON.parse(line).id)
        if (/^\d{4}$/.test(id)) max = Math.max(max, Number(id))
      } catch { /* 坏行不影响序号推导 */ }
    }
    return max
  }
  const lockExists = (dir) => fs.existsSync(path.join(dir, '.whale-write.lock'))
  const txnDirs = (dir) => {
    const p = path.join(dir, '.whale-txn')
    return fs.existsSync(p) ? fs.readdirSync(p).sort() : []
  }
  const noResidue = (dir) => {
    h.eq(lockExists(dir), false, `失败/提交之后不许留锁：${dir}`)
    h.eq(txnDirs(dir).length, 0, `事务日志必须收干净（实得 ${txnDirs(dir).join(',') || '无'}）`)
  }
  const filesBefore = (dir, rels) => Object.fromEntries(rels.map((r) => [r, txt(dir, r)]))
  const sameFiles = (dir, before, rels) => {
    for (const rel of rels) h.eq(txt(dir, rel), before[rel], `${rel} 必须逐字节回到写前`)
  }
  /** 写口失败要回 500/503 且**不泄漏注入原文/栈**（T08 的同一契约） */
  const expectWriteFailure = (res, label) => {
    h.eq(res.status === 500 || res.status === 503, true, `${label}：写盘失败必须回 5xx（实得 ${res.status} ${res.text.slice(0, 120)}）`)
    h.eq(res.doc && res.doc.ok, false, `${label}：ok=false`)
    h.eq(typeof (res.doc && res.doc.code), 'string', `${label}：要有机器可读的 code`)
    h.eq(typeof (res.doc && res.doc.error), 'string', `${label}：要有 error 文案`)
    h.eq(/injected|secret-canary|Error:|\bat .*:\d+/.test(res.text), false, `${label}：不许把内部错误原文/栈丢给客户端（${res.text.slice(0, 160)}）`)
  }

  const spawnWorker = (args, timeoutMs = 120000) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...args], { cwd: REPO, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, pid: child.pid }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, pid: child.pid, error: String(e && e.message ? e.message : e) }) })
  })
  const freePort = () => new Promise((resolve, reject) => {
    const s = http.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
  const copyEvidence = (name, from) => {
    // 机器 JSON 无 BOM（人读的 .txt 才带 BOM，见 harness）
    try { h.evidence(path.join('raw', `${name}.json`), fs.readFileSync(from, 'utf8'), { bom: false }) } catch { /* 缺 report 由判据报 */ }
  }

  // ─────────────────────────────────────────────── ① 正常提交 + 记录形状
  checkAsync('T11-ask-commit', async () => {
    const dir = makePack('ask-commit')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const r1 = await callApi(api, 'POST', '/ask', { question: '第一条', lesson: 'fixture/0001' })
    h.eq(r1.status, 200, `POST /ask（${r1.text.slice(0, 120)}）`)
    h.eq(r1.doc.ok, true, 'ok')
    h.eq(r1.doc.id, '0001', '第一条编号')
    const r2 = await callApi(api, 'POST', '/ask', { question: '第二条', lesson: 'fixture/0001' })
    h.eq(r2.doc.id, '0002', '第二条编号接着排（同一个 seq）')
    h.eq(txt(dir, 'questions/seq.txt'), '2', 'questions/seq.txt 原始字节 = "2"（不补零、不带换行）')
    const recs = recsOf(dir, 'questions/pending.jsonl')
    h.eq(recs.length, 2, '两条都落盘（一条都不许丢）')
    h.eq(recs.map((x) => x.id).join(','), '0001,0002', '编号唯一且连续')
    h.eq(fs.readFileSync(path.join(dir, 'questions', 'pending.jsonl'), 'utf8').endsWith('\n'), true, '记录以 LF 结尾')
    noResidue(dir)
    evidenceOf('ask-commit', { first: r1.doc, second: r2.doc, seq: txt(dir, 'questions/seq.txt'), records: recs })
  })

  checkAsync('T11-ask-record-shape', async () => {
    const dir = makePack('ask-shape')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const body = {
      question: '形状：换行\n"引号" \\反斜杠 😀',
      lesson: 'fixture/0001', page: 'lessons/fixture/0001-a.html', title: '夹具课',
    }
    const r = await callApi(api, 'POST', '/ask', body)
    h.eq(r.status, 200, '写入成功')
    const line = linesOf(txt(dir, 'questions/pending.jsonl'))[0]
    const rec = JSON.parse(line)
    h.eq(Object.keys(rec).join(','), 'id,at,lesson,page,title,question,status', '键序就是约定值（drain / build-questions 依赖它）')
    h.eq(rec.id, '0001', 'id 四位零填充')
    h.eq(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rec.at), true, `at 是 ISO-8601 UTC 毫秒（${rec.at}）`)
    h.eq(rec.question, body.question, 'question 逐字往返（换行/引号/反斜杠/emoji 一个不丢）')
    h.eq(rec.status, 'pending', 'status=pending')
    evidenceOf('ask-record-shape', rec)
  })

  checkAsync('T11-ask-note-commit', async () => {
    const dir = makePack('note-commit')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const r1 = await callApi(api, 'POST', '/note', { text: '笔记一', anchor: '第1课' })
    h.eq(r1.status, 200, `POST /note（${r1.text.slice(0, 120)}）`)
    h.eq(r1.doc.id, '0001', '第一条笔记 id')
    const r2 = await callApi(api, 'POST', '/note', { text: '笔记二', anchor: 'fixture/0001', date: '2026-10-16' })
    h.eq(r2.doc.id, '0002', '第二条笔记 id 接着排')
    h.eq(txt(dir, 'notes/seq.txt'), '2\n', 'notes/seq.txt 带换行（与 notes-io 同形）')
    const recs = recsOf(dir, 'notes/notes.jsonl')
    h.eq(recs.length, 2, '两条笔记都在')
    h.eq(Object.keys(recs[0]).join(','), 'id,seq,kind,anchor,text', '键序与插件写入口同形')
    h.eq(recs[0].anchor, 'fixture/0001', '第N课 → 星图课次键')
    h.eq(recs[1].anchor, 'fixture/0001', '两种写法收敛成同一个键')
    h.eq(recs[1].date, '2026-10-16', 'date 只在显式给时写')
    noResidue(dir)
    evidenceOf('note-commit', recs)
  })

  checkAsync('T11-ask-progress-commit', async () => {
    const dir = makePack('progress-commit')
    fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ learned: [], _: '注释要原样保留', note: '人读字段' }, null, 2) + '\n', 'utf8')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const r = await callApi(api, 'POST', '/progress', { lesson: 'fixture/0001', done: false, adjust: '这节讲快了', title: '夹具课' })
    h.eq(r.status, 200, `POST /progress（${r.text.slice(0, 120)}）`)
    h.eq(r.doc.ok, true, 'done:false 仍是成功回执')
    h.eq(r.doc.adjustSaved, true, '课后调整落账')
    h.eq(txt(dir, 'progress.json'), JSON.stringify({ learned: [], _: '注释要原样保留', note: '人读字段' }, null, 2) + '\n', 'done:false 不点亮：progress.json 逐字节不变')
    const adj = recsOf(dir, 'learning-records/adjustments.jsonl')
    h.eq(adj.length, 1, '调整记录一条')
    h.eq(adj[0].adjust, '这节讲快了', '调整正文逐字')
    h.eq(adj[0].lit, false, 'lit=false 留痕')
    noResidue(dir)
    evidenceOf('progress-commit', { response: r.doc, adjustment: adj[0], progress: txt(dir, 'progress.json') })
  })

  checkAsync('T11-ask-progress-write-interface', async () => {
    const dir = makePack('progress-write')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    h.eq(typeof api.writeProgress, 'function', '保留 writeProgress(p) 接口')
    const doc = { learned: ['fixture/0001'], _: '保留我' }
    const txn = api.writeProgress(doc)
    h.eq(txn.state, 'committed', `writeProgress 走事务（state=${txn.state}）`)
    h.eq(txt(dir, 'progress.json'), JSON.stringify(doc, null, 2) + '\n', '落盘形状与旧实现逐字节相同')
    h.eq(api.readProgress().learned.join(','), 'fixture/0001', 'readProgress 读得回来')
    noResidue(dir)
    evidenceOf('progress-write', { state: txn.state, progress: txt(dir, 'progress.json') })
  })

  // ─────────────────────────────────────────────── ② 每个 IO 步骤分别注入失败
  checkAsync('T11-ask-fault-seq-stage-eacces', async () => {
    const dir = makePack('fault-ask-seq-stage')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['questions/seq.txt', 'questions/pending.jsonl']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/ask', { question: 'x', lesson: 'fixture/0001' }, {
      writeFileSync: failWrite((s) => s.includes('/questions/seq.txt.tmp-txn-'), 'EACCES'),
    })
    expectWriteFailure(res, 'seq 暂存 EACCES')
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('fault-ask-seq-stage', { response: res.doc, before, after: filesBefore(dir, rels) })
  })

  checkAsync('T11-ask-fault-pending-stage-enospc', async () => {
    const dir = makePack('fault-ask-pending-stage')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['questions/seq.txt', 'questions/pending.jsonl']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/ask', { question: 'x', lesson: 'fixture/0001' }, {
      appendFileSync: failAppend((s) => s.includes('/questions/pending.jsonl.tmp-txn-'), 'ENOSPC'),
    })
    expectWriteFailure(res, 'pending 暂存 ENOSPC')
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('fault-ask-pending-stage', { response: res.doc, before, after: filesBefore(dir, rels) })
  })

  checkAsync('T11-ask-fault-seq-rename-eacces', async () => {
    const dir = makePack('fault-ask-seq-rename')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['questions/seq.txt', 'questions/pending.jsonl']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/ask', { question: 'x', lesson: 'fixture/0001' }, {
      renameSync: failRename((s) => s.endsWith('/questions/seq.txt'), 'EACCES'),
    })
    expectWriteFailure(res, 'seq rename EACCES')
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('fault-ask-seq-rename', { response: res.doc, before, after: filesBefore(dir, rels) })
  })

  checkAsync('T11-ask-fault-journal-enospc', async () => {
    const dir = makePack('fault-ask-journal')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['questions/seq.txt', 'questions/pending.jsonl']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/ask', { question: 'x', lesson: 'fixture/0001' }, {
      writeFileSync: failWrite((s) => s.includes('/.whale-txn/') && s.includes('/journal.json.tmp-'), 'ENOSPC'),
    })
    expectWriteFailure(res, 'journal ENOSPC')
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('fault-ask-journal', { response: res.doc, before, after: filesBefore(dir, rels) })
  })

  checkAsync('T11-ask-note-fault-stage-eacces', async () => {
    const dir = makePack('fault-note-stage')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['notes/notes.jsonl', 'notes/seq.txt']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/note', { text: 'n', anchor: 'fixture/0001' }, {
      // 笔记台账是 append-only：暂存走 txnFs 的 append 分支（注入也打在这个真缝上）
      appendFileSync: failAppend((s) => s.includes('/notes/notes.jsonl.tmp-txn-'), 'EACCES'),
    })
    expectWriteFailure(res, '笔记暂存 EACCES')
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('fault-note-stage', { response: res.doc, before, after: filesBefore(dir, rels) })
  })

  checkAsync('T11-ask-note-fault-rename-enospc', async () => {
    const dir = makePack('fault-note-rename')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['notes/notes.jsonl', 'notes/seq.txt']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/note', { text: 'n', anchor: 'fixture/0001' }, {
      renameSync: failRename((s) => s.endsWith('/notes/seq.txt'), 'ENOSPC'),
    })
    expectWriteFailure(res, 'note seq rename ENOSPC')
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('fault-note-rename', { response: res.doc, before, after: filesBefore(dir, rels) })
  })

  checkAsync('T11-ask-progress-fault-adjust-eacces', async () => {
    const dir = makePack('fault-progress-adjust')
    // 造一份**能点亮**的判据快照：这样这次请求的写集同时含 progress.json 与 adjustments.jsonl，
    // 失败注入打在后一件上 ⇒ 前一件也必须回到写前（"同一个写集"的真正判据，不是 done:false）。
    const fp = require_(path.join(dir, 'tools', 'fingerprint.js'))
    const codeDir = path.join(dir, 'code', 'proj')
    fs.writeFileSync(path.join(codeDir, 'Probe.java'), 'class Probe {}\n', 'utf8')
    const snapshot = {
      probeVersion: fp.PROBE_VERSION,
      projects: [{
        dir: 'code/proj',
        sourceDigest: fp.digestTree(codeDir),
        lessons: [{ id: 'fixture/0001', challenges: [{ no: 1, deliverable: '夹具挑战', done: true }] }],
      }],
    }
    fs.writeFileSync(path.join(dir, 'learning-records', 'state.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ learned: [], _: 'keep' }, null, 2) + '\n', 'utf8')
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const rels = ['progress.json', 'learning-records/adjustments.jsonl']
    const before = filesBefore(dir, rels)
    const res = await callWithFs(api, 'POST', '/progress', { lesson: 'fixture/0001', adjust: 'x' }, {
      appendFileSync: failAppend((s) => s.includes('/learning-records/adjustments.jsonl.tmp-txn-'), 'EACCES'),
    })
    expectWriteFailure(res, '课后调整暂存 EACCES')
    sameFiles(dir, before, rels)
    h.eq(txt(dir, 'progress.json'), JSON.stringify({ learned: [], _: 'keep' }, null, 2) + '\n', '点亮写入也被回滚（ledger 没多出 fixture/0001）')
    noResidue(dir)
    // 反空转：删掉故障后再点一次，必须真的点亮 —— 证明上一轮的 verdict 本来就是 ok（不是"快照无效"白过）
    const okRun = await callApi(api, 'POST', '/progress', { lesson: 'fixture/0001' })
    h.eq(okRun.doc.ok, true, `同一条课次在无故障时必须判过（${okRun.text.slice(0, 160)}）`)
    h.eq(parseJson(txt(dir, 'progress.json')).learned.includes('fixture/0001'), true, '无故障时 progress 真的点亮了 fixture/0001')
    noResidue(dir)
    evidenceOf('fault-progress-adjust', { response: res.doc, before, after: filesBefore(dir, rels), snapshot, control: okRun.doc })
  })

  // ─────────────────────────────────────────────── ③ 归档：同事务 + 失败矩阵
  check('T11-drain-archive-and-keep', () => {
    const records = [1, 2, 3, 4, 5, 6].map((n) => JSON.stringify({ id: String(n).padStart(4, '0'), question: `q${n}` }))
    const pending = records.join('\n') + '\n'
    const dir = makePack('drain-ok', { pending, registered: ['0001', '0002', '0003'] })
    const drain = require_(path.join(dir, 'tools', 'drain-questions.js'))
    h.eq(typeof drain.drainPending, 'function', '导出 drainPending(root)')
    const r = drain.drainPending(dir)
    h.eq(r.state, 'committed', `state（error=${r.error}）`)
    h.eq(r.drained, 3, `归档 3 条（实得 ${r.drained}）`)
    h.eq(r.kept, 3, `保留 3 条（实得 ${r.kept}）`)
    h.eq(recsOf(dir, 'questions/processed.jsonl').map((x) => x.id).join(','), '0001,0002,0003', 'processed = 已登记的三条（顺序不变）')
    h.eq(recsOf(dir, 'questions/pending.jsonl').map((x) => x.id).join(','), '0004,0005,0006', 'pending 只留未登记的')
    h.eq(recsOf(dir, 'questions/processed.jsonl').length + recsOf(dir, 'questions/pending.jsonl').length, 6, 'pending∪processed 仍是 6 条（一条不丢）')
    noResidue(dir)
    // 幂等：再跑一次，没有可归档的 → 一个字节都不写
    const beforePending = txt(dir, 'questions/pending.jsonl')
    const beforeProcessed = txt(dir, 'questions/processed.jsonl')
    const again = drain.drainPending(dir)
    h.eq(again.state, 'committed', '第二次也是成功')
    h.eq(again.drained, 0, '第二次没有可归档的')
    h.eq(txt(dir, 'questions/pending.jsonl'), beforePending, '第二次不动 pending')
    h.eq(txt(dir, 'questions/processed.jsonl'), beforeProcessed, '第二次不动 processed')
    evidenceOf('drain-ok', { first: r, second: again, pending: txt(dir, 'questions/pending.jsonl'), processed: txt(dir, 'questions/processed.jsonl') })
  })

  check('T11-drain-fault-processed-eacces', () => {
    const pending = [1, 2, 3].map((n) => JSON.stringify({ id: String(n).padStart(4, '0'), question: `q${n}` })).join('\n') + '\n'
    const dir = makePack('drain-fault-processed', { pending, registered: ['0001', '0002'] })
    const drain = require_(path.join(dir, 'tools', 'drain-questions.js'))
    const rels = ['questions/pending.jsonl', 'questions/processed.jsonl']
    const before = filesBefore(dir, rels)
    const saved = fs.writeFileSync
    fs.writeFileSync = (p, data, opts) => {
      if (norm(p).includes('/questions/processed.jsonl.tmp-txn-')) throw ioErr('EACCES')
      return saved(p, data, opts)
    }
    let r
    try { r = drain.drainPending(dir) } finally { fs.writeFileSync = saved }
    h.eq(r.state, 'rolled-back', `staging 失败 → 回滚（实得 ${r.state}，error=${r.error}）`)
    h.eq(/EACCES/.test(String(r.error)), true, `错误码如实（${r.error}）`)
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('drain-fault-processed', { result: r, before, after: filesBefore(dir, rels) })
  })

  check('T11-drain-fault-pending-rename-enospc', () => {
    const pending = [1, 2, 3].map((n) => JSON.stringify({ id: String(n).padStart(4, '0'), question: `q${n}` })).join('\n') + '\n'
    const dir = makePack('drain-fault-pending-rename', { pending, registered: ['0001', '0002'] })
    const drain = require_(path.join(dir, 'tools', 'drain-questions.js'))
    const rels = ['questions/pending.jsonl', 'questions/processed.jsonl']
    const before = filesBefore(dir, rels)
    const realRename = fs.renameSync
    let fired = false
    fs.renameSync = (a, b) => {
      // 只打第一次：pending 写前就存在，回滚也要用 rename 还原它（持续失败 = 回滚也挂，那是另一条判据）
      if (!fired && norm(b).endsWith('/questions/pending.jsonl')) { fired = true; throw ioErr('ENOSPC') }
      return realRename(a, b)
    }
    let r
    try { r = drain.drainPending(dir) } finally { fs.renameSync = realRename }
    h.eq(r.state, 'rolled-back', `pending 落位失败 → 回滚（实得 ${r.state}，error=${r.error}）`)
    h.eq(/ENOSPC/.test(String(r.error)), true, `错误码如实（${r.error}）`)
    sameFiles(dir, before, rels)
    noResidue(dir)
    evidenceOf('drain-fault-pending-rename', { result: r, before, after: filesBefore(dir, rels) })
  })

  // ─────────────────────────────────────────────── ④ 进程中断 + 独占恢复
  checkAsync('T11-ask-kill-recover', async () => {
    const dir = makePack('kill-ask')
    const marker = path.join(temp, 'kill-ask.marker')
    const report = path.join(temp, 'kill-ask.report.json')
    const res = await spawnWorker(['--mode=kill-ask', `--root=${dir}`, `--marker=${marker}`, `--report=${report}`], 60000)
    h.eq(res.code === 0, false, `写进程必须**真的被杀**（实得 exit=${res.code} signal=${res.signal}）`)
    h.eq(fs.existsSync(marker), true, '杀点确实走到了（marker 存在）')
    h.eq(txnDirs(dir).length, 1, `中断必须留下日志残骸（实得 ${txnDirs(dir).length} 个）`)
    h.eq(lockExists(dir), true, '中断那一刻锁还在（下次普通写会被拒，不是静默继续）')
    const journal = readJson(path.join(dir, '.whale-txn', txnDirs(dir)[0], 'journal.json'))
    h.eq(journal.schema, 'whale-txn/1', 'journal schema')
    h.eq(journal.state, 'prepared', `杀在落位阶段 → journal 是 prepared（实得 ${journal.state}）`)
    const crashSeq = txt(dir, 'questions/seq.txt')
    const crashPending = txt(dir, 'questions/pending.jsonl')
    const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'executor-t11' })
    h.eq(rec.ok, true, `离线恢复（error=${rec.error}）`)
    h.eq(rec.state, 'recovered', 'state')
    h.eq(txt(dir, 'questions/seq.txt'), null, `恢复后 = **原状态**（seq 不存在，实得 ${JSON.stringify(txt(dir, 'questions/seq.txt'))}）`)
    h.eq(txt(dir, 'questions/pending.jsonl'), null, '恢复后 pending 也没有半条记录')
    noResidue(dir)
    const api = require_(path.join(dir, 'tools', 'ask-server.js'))
    const after = await callApi(api, 'POST', '/ask', { question: '恢复后第一条', lesson: 'fixture/0001' })
    h.eq(after.status, 200, '恢复之后普通写放行')
    h.eq(after.doc.id, '0001', '恢复后从 0001 重新发号（没有跳号）')
    evidenceOf('kill-ask', {
      child: res, marker: fs.readFileSync(marker, 'utf8'), journal, crashSeq, crashPending,
      recovery: rec, seqAfter: txt(dir, 'questions/seq.txt'), pendingAfter: txt(dir, 'questions/pending.jsonl'),
    })
  })

  checkAsync('T11-drain-kill-recover', async () => {
    const records = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const pending = records.map((n) => JSON.stringify({ id: String(n).padStart(4, '0'), question: `q${n}` })).join('\n') + '\n'
    const dir = makePack('kill-drain', { pending, registered: ['0001', '0002', '0003', '0004', '0005'] })
    const marker = path.join(temp, 'kill-drain.marker')
    const report = path.join(temp, 'kill-drain.report.json')
    const res = await spawnWorker(['--mode=kill-drain', `--root=${dir}`, `--marker=${marker}`, `--report=${report}`], 60000)
    h.eq(res.code === 0, false, `归档进程必须**真的被杀**（实得 exit=${res.code} signal=${res.signal}）`)
    h.eq(fs.existsSync(marker), true, '杀点确实走到了')
    h.eq(txnDirs(dir).length, 1, '留一份日志残骸')
    h.eq(lockExists(dir), true, '锁还在')
    const journal = readJson(path.join(dir, '.whale-txn', txnDirs(dir)[0], 'journal.json'))
    h.eq(journal.state, 'prepared', `杀在 pending 落位前 → journal=prepared（实得 ${journal.state}）`)
    const crashProcessed = txt(dir, 'questions/processed.jsonl')
    const crashPending = txt(dir, 'questions/pending.jsonl')
    h.eq(recsOf(dir, 'questions/processed.jsonl').length, 5, '崩溃时 processed 已经有 5 条（这就是"重复归档"的现场）')
    h.eq(recsOf(dir, 'questions/pending.jsonl').length, 10, '崩溃时 pending 还是旧的 10 条')
    const rec = TXN.recoverPack(dir, { offline: true, confirm: true, ownerToken: 'executor-t11' })
    h.eq(rec.ok, true, `离线恢复（error=${rec.error}）`)
    h.eq(txt(dir, 'questions/processed.jsonl'), null, '恢复后 processed 回到写前（不再重复）')
    h.eq(recsOf(dir, 'questions/pending.jsonl').length, 10, '恢复后 pending 是原状态 10 条')
    noResidue(dir)
    const drain = require_(path.join(dir, 'tools', 'drain-questions.js'))
    const after = drain.drainPending(dir)
    h.eq(after.state, 'committed', `恢复后归档放行（error=${after.error}）`)
    h.eq(after.drained, 5, '归档 5 条已登记')
    h.eq(after.kept, 5, '保留 5 条未登记')
    h.eq(recsOf(dir, 'questions/processed.jsonl').length + recsOf(dir, 'questions/pending.jsonl').length, 10, 'pending∪processed 仍是 10 条（一条不丢、不重复）')
    evidenceOf('kill-drain', {
      child: res, marker: fs.readFileSync(marker, 'utf8'), journal, crashProcessed, crashPending,
      recovery: rec, after,
    })
  })

  // ─────────────────────────────────────────────── ⑤ 并发（两进程 / 归档并行 / 宿主交叉）
  checkAsync('T11-concurrent-two-services', async () => {
    const dir = makePack('concurrent-services')
    const [pa, pb] = await Promise.all([freePort(), freePort()])
    const ra = path.join(temp, 'concurrent-a.json')
    const rb = path.join(temp, 'concurrent-b.json')
    const [a, b] = await Promise.all([
      spawnWorker(['--mode=service-burst', `--root=${dir}`, `--port=${pa}`, '--count=40', '--kind=ask', '--writer=A', `--report=${ra}`]),
      spawnWorker(['--mode=service-burst', `--root=${dir}`, `--port=${pb}`, '--count=40', '--kind=ask', '--writer=B', `--report=${rb}`]),
    ])
    copyEvidence('concurrent-a', ra)
    copyEvidence('concurrent-b', rb)
    const da = fs.existsSync(ra) ? readJson(ra) : null
    const db = fs.existsSync(rb) ? readJson(rb) : null
    h.eq(a.code, 0, `writer A 退出码（signal=${a.signal}）`)
    h.eq(b.code, 0, `writer B 退出码（signal=${b.signal}）`)
    h.eq(da && da.failed.length, 0, `writer A 没有失败事务：${JSON.stringify(da && da.failed)}`)
    h.eq(db && db.failed.length, 0, `writer B 没有失败事务：${JSON.stringify(db && db.failed)}`)
    h.eq(da && da.results.length, 40, 'A 写了 40 条')
    h.eq(db && db.results.length, 40, 'B 写了 40 条')
    const recs = recsOf(dir, 'questions/pending.jsonl')
    h.eq(recs.length, 80, `台账里必须**全部 80 条**都在（一条都不许被覆盖；实得 ${recs.length}）`)
    const ids = recs.map((x) => x.id)
    h.eq(new Set(ids).size, 80, `序号唯一（去重后 ${new Set(ids).size}）`)
    h.eq(ids.slice().sort().join(','), Array.from({ length: 80 }, (_, i) => String(i + 1).padStart(4, '0')).join(','), '序号恰好 0001..0080（无跳号、无重复）')
    h.eq(txt(dir, 'questions/seq.txt'), '80', 'seq.txt 终值 = 80')
    h.eq(new Set(recs.map((x) => x.question)).size, 80, '每条操作标识唯一（没有哪条被覆盖）')
    noResidue(dir)
    evidenceOf('concurrent-two-services', { a: da, b: db, count: recs.length, seq: txt(dir, 'questions/seq.txt') })
  })

  checkAsync('T11-concurrent-drain-vs-ask', async () => {
    const original = Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(4, '0'))
    const pending = original.map((id) => JSON.stringify({ id, question: `old-${id}`, status: 'pending' })).join('\n') + '\n'
    const registered = original.slice(0, 20)
    const dir = makePack('drain-vs-ask', { pending, registered })
    const port = await freePort()
    const report = path.join(temp, 'drain-vs-ask-burst.json')
    // 归档进程与新提问进程**同时**起：归档用的旧快照不许把新提问抹掉（C01 的现场）
    const drainChild = spawn(process.execPath, [path.join(dir, 'tools', 'drain-questions.js')], { cwd: REPO, stdio: 'ignore', windowsHide: true })
    const drainDone = new Promise((resolve) => drainChild.on('close', (code, signal) => resolve({ code, signal })))
    const burst = spawnWorker(['--mode=service-burst', `--root=${dir}`, `--port=${port}`, '--count=40', '--kind=ask', '--writer=NEW', `--report=${report}`])
    const [drainRes, burstRes] = await Promise.all([drainDone, burst])
    copyEvidence('drain-vs-ask-burst', report)
    const doc = fs.existsSync(report) ? readJson(report) : null
    h.eq(drainRes.code, 0, `归档进程退出码（code=${drainRes.code} signal=${drainRes.signal}）`)
    h.eq(burstRes.code, 0, `新提问进程退出码（signal=${burstRes.signal}）`)
    h.eq(doc && doc.failed.length, 0, `新提问没有失败事务：${JSON.stringify(doc && doc.failed)}`)

    const pendingRecs = recsOf(dir, 'questions/pending.jsonl')
    const processedRecs = recsOf(dir, 'questions/processed.jsonl')
    const union = [...pendingRecs, ...processedRecs].map((x) => String(x.id))
    h.eq(new Set(union).size, union.length, `pending∪processed 无重复（去重 ${new Set(union).size} / 共 ${union.length}）`)
    // 原 40 条 + 新 40 条必须都在，且每条恰好一次
    const all = new Set()
    for (const rec of [...pendingRecs, ...processedRecs]) all.add(String(rec.id))
    h.eq(all.size, 80, `pending∪processed 恰好 80 条不同编号（原 40 + 新 40；实得 ${all.size}）`)
    for (const id of original) h.eq(all.has(id), true, `原提问 ${id} 没有丢`)
    for (let i = 0; i < 40; i++) h.eq(all.has(String(41 + i).padStart(4, '0')), true, `新提问 ${String(41 + i).padStart(4, '0')} 没有丢`)
    const processedIds = new Set(processedRecs.map((x) => String(x.id)))
    h.eq(processedIds.size, 20, `只归档了 20 条已登记（实得 ${processedIds.size}）`)
    for (const id of registered) {
      h.eq(processedIds.has(id), true, `已登记 ${id} 被归档`)
      h.eq(pendingRecs.some((x) => String(x.id) === id), false, `已登记 ${id} 不在 pending（没有重复归档）`)
    }
    const pendingIds = new Set(pendingRecs.map((x) => String(x.id)))
    for (const id of original.slice(20)) h.eq(pendingIds.has(id), true, `未登记 ${id} 留在 pending`)
    for (let i = 0; i < 40; i++) h.eq(pendingIds.has(String(41 + i).padStart(4, '0')), true, `新提问 ${String(41 + i).padStart(4, '0')} 留在 pending（没被归档的旧快照抹掉）`)
    h.eq(txt(dir, 'questions/seq.txt'), '80', 'seq.txt = 80')
    noResidue(dir)
    evidenceOf('drain-vs-ask', {
      drain: drainRes, burst: doc && { results: doc.results.length, failed: doc.failed },
      pending: pendingRecs.map((x) => x.id), processed: processedRecs.map((x) => x.id),
    })
  })

  checkAsync('T11-cross-host-pack', async () => {
    const dir = makePack('cross-host-pack')
    const port = await freePort()
    const packReport = path.join(temp, 'cross-pack.json')
    const hostReport = path.join(temp, 'cross-host.json')
    // 包侧：真 ask-server handler（HTTP、跨进程）；宿主侧：同一事务件上的宿主写口形状（跨进程）。
    const [packRes, hostRes] = await Promise.all([
      spawnWorker(['--mode=service-burst', `--root=${dir}`, `--port=${port}`, '--count=40', '--kind=note', '--writer=PACK', `--report=${packReport}`]),
      spawnWorker(['--mode=host-notes', `--root=${dir}`, '--count=40', '--writer=HOST', `--report=${hostReport}`]),
    ])
    copyEvidence('cross-pack', packReport)
    copyEvidence('cross-host', hostReport)
    const pd = fs.existsSync(packReport) ? readJson(packReport) : null
    const hd = fs.existsSync(hostReport) ? readJson(hostReport) : null
    h.eq(packRes.code, 0, `包侧进程退出码（signal=${packRes.signal}）`)
    h.eq(hostRes.code, 0, `宿主侧进程退出码（signal=${hostRes.signal}）`)
    h.eq(pd && pd.failed.length, 0, `包侧没有失败：${JSON.stringify(pd && pd.failed)}`)
    h.eq(hd && hd.failed.length, 0, `宿主侧没有失败：${JSON.stringify(hd && hd.failed)}`)
    const recs = recsOf(dir, 'notes/notes.jsonl')
    h.eq(recs.length, 80, `同一本笔记台账里 80 条都在（实得 ${recs.length}）`)
    const seqs = recs.map((x) => x.seq)
    h.eq(new Set(seqs).size, 80, `序号唯一（去重 ${new Set(seqs).size}）`)
    h.eq(seqs.slice().sort((x, y) => x - y).join(','), Array.from({ length: 80 }, (_, i) => i + 1).join(','), '序号恰好 1..80（无跳号、无重复）')
    const texts = recs.map((x) => x.text)
    h.eq(texts.some((t) => t.startsWith('note-PACK-')), true, '包侧写口的记录在')
    h.eq(texts.some((t) => t.startsWith('host-HOST-')), true, '宿主侧写口的记录在')
    h.eq(txt(dir, 'notes/seq.txt'), '80\n', 'notes/seq.txt 终值 = 80')
    noResidue(dir)
    evidenceOf('cross-host-pack', { pack: pd && pd.results.length, host: hd && hd.results.length, records: recs.length, seq: txt(dir, 'notes/seq.txt') })
  })

  // ─────────────────────────────────────────────── ⑥ 负向控制（临时副本上的真变异）
  checkAsync('T11-negative-control-old-write', async () => {
    const dir = makePack('negative-old')
    const askAbs = path.join(dir, 'tools', 'ask-server.js')
    const src = fs.readFileSync(askAbs, 'utf8')
    const MUTANT = `async function commitWithRetry(build, opts = {}) {
  // MUTANT: 旧的"先算后直写"两步（没有锁、没有日志、没有回滚）
  const files = {};
  for (const rel of ['questions/pending.jsonl','questions/seq.txt','notes/notes.jsonl','notes/seq.txt','progress.json','learning-records/adjustments.jsonl']) {
    const p = path.join(ROOT, rel);
    files[rel] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  const built = build({ root: ROOT, fs, files });
  const plan = Array.isArray(built) ? built : (built && built.files) || [];
  try {
    for (const f of plan) fs.writeFileSync(path.join(ROOT, f.rel), f.content);
  } catch (e) {
    return { ok: false, state: 'rejected', error: 'MUTANT write failed: ' + e.message, value: null };
  }
  return { ok: true, state: 'committed', value: built && built.value };
}`
    const re = /async function commitWithRetry\(build, opts = \{\}\) \{[\s\S]*?\/\* end commitWithRetry \*\/\n\}/
    if (!re.test(src)) throw new Error('变异没打到产品缝：commitWithRetry')
    const mutated = src.replace(re, MUTANT)
    fs.writeFileSync(askAbs, mutated, 'utf8')
    const api = require_(askAbs)
    const res = await callWithFs(api, 'POST', '/ask', { question: 'old-shape', lesson: 'fixture/0001' }, {
      writeFileSync: failWrite((s) => s.endsWith('/questions/pending.jsonl'), 'EACCES'),
    })
    const seqAfter = txt(dir, 'questions/seq.txt')
    const pendingAfter = txt(dir, 'questions/pending.jsonl')
    // 旧形状被抓的证据：seq 已经前进，记录却没有（半提交）—— 新实现下这条断言是 seq 不存在。
    h.eq(res.status, 500, `变异体回 5xx（实得 ${res.status}）`)
    h.eq(seqAfter, '1', `旧形状留下"序号已前进"（实得 ${JSON.stringify(seqAfter)}）`)
    h.eq(pendingAfter, null, `旧形状没有记录（实得 ${JSON.stringify(pendingAfter)}）`)
    h.eq(txnDirs(dir).length, 0, '旧形状根本没有事务日志（这正是它不可恢复的原因）')
    evidenceOf('negative-old-write', { response: res.doc, seqAfter, pendingAfter, mutant: MUTANT })
  })

  // ─────────────────────────────────────────────── ⑦ 清理守卫（最后一条）
  checkAsync('T11-cleanup-guard', async () => {
    const abs = path.resolve(temp)
    h.eq(path.dirname(abs).toLowerCase(), path.resolve('E:/Temp').toLowerCase(), `夹具在 E:/Temp 下：${abs}`)
    h.eq(path.basename(abs).startsWith(`whale-T11-${stamp}-`), true, `夹具名带本次 runId：${path.basename(abs)}`)
    h.eq(fs.existsSync(path.join(REPO, '.whale-txn')), false, '工作仓里没有被写进 .whale-txn')
    h.eq(fs.existsSync(path.join(REPO, '.whale-write.lock')), false, '工作仓里没有被写进 .whale-write.lock')
    h.eq(fs.existsSync(path.join(LIVE_PACK, '.whale-txn')), false, '用户活包里没有被写进 .whale-txn')
    h.eq(fs.existsSync(path.join(LIVE_PACK, '.whale-write.lock')), false, '用户活包里没有被写进 .whale-write.lock')
    for (const n of fs.readdirSync('E:/Temp').filter((x) => x.startsWith(`whale-T11-${stamp}-`) && x.endsWith('.marker'))) {
      try { fs.rmSync(path.join('E:/Temp', n), { force: true }) } catch { /* best effort */ }
    }
    fs.rmSync(abs, { recursive: true, force: true })
    h.eq(fs.existsSync(abs), false, '夹具已清理')
  })

  for (const run of syncChecks) run()
  for (const run of asyncChecks) await run()

  process.exitCode = h.run()
  const casesFile = path.join(evidence, 'cases.jsonl')
  if (fs.existsSync(casesFile)) fs.writeFileSync(casesFile, fs.readFileSync(casesFile, 'utf8').replace(/^\uFEFF/, ''), 'utf8')
}

if (arg('mode')) {
  const mode = arg('mode')
  if (mode === 'service-burst') serviceBurst()
  else if (mode === 'host-notes') hostNotes()
  else if (mode === 'kill-ask') killAsk()
  else if (mode === 'kill-drain') killDrain()
  else { console.error('unknown mode: ' + mode); process.exit(2) }
} else {
  await main()
}
