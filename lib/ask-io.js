/**
 * ask-io.js — 疑问队列的 IO 薄壳（ESM）
 * ------------------------------------------------------------------
 * 从 ask-server.js（E:/workplace/study/tools/ask-server.js）搬运 IO 逻辑。
 *
 * 分工：
 *   · 本文件只管 文件系统读写 和 handleAsk 编排
 *   · JSON 解析、校验、序号格式化、序列化 等纯逻辑一律 import 自 ./ask.js
 *
 * 铁律：
 *   · 不 import 其它 lib/*.js（模块间不互相 import）
 *   · 不读环境变量、不读 process.cwd()、无模块级可变状态
 *   · 时钟可注入：now 参数，默认 () => new Date().toISOString()
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  parseAskBody,
  formatSeq,
  serializeRecord,
  parsePending,
  validateAnswerBody,
  serializeLedgerEntry,
  insertLedgerEntry,
} from './ask.js'

/** 台账是 CommonJS（UMD），用它自己那套 require；**写完必须清缓存再 require**，否则读到的还是旧对象 */
const requireCJS = createRequire(import.meta.url)

/**
 * 推导疑问队列相关路径。
 * 搬运自 ask-server.js 第 28-31 行（路径常量）。
 * @param {string} root 课程包根目录
 * @returns {{ questionsDir: string, pending: string, processed: string, seqFile: string }}
 */
export function askPaths(root) {
  const questionsDir = path.join(root, 'questions')
  return {
    questionsDir,
    pending: path.join(questionsDir, 'pending.jsonl'),
    processed: path.join(questionsDir, 'processed.jsonl'),
    seqFile: path.join(questionsDir, 'seq.txt')
  }
}

/**
 * 读序号文件，剥掉 BOM 后返回原始文本。
 * 文件不存在返回 ""。
 * 搬运自 ask-server.js 第 67-70 行（读 seq.txt + 剥 BOM）。
 * @param {string} root 课程包根目录
 * @returns {string}
 */
export function readSeq(root) {
  const { seqFile } = askPaths(root)
  try {
    return fs.readFileSync(seqFile, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

/**
 * 原子递增序号：先写临时文件再 rename，保证不丢号。
 * 搬运自 ask-server.js 第 65-75 行（nextId 逻辑），但加了原子写入。
 * @param {string} root 课程包根目录
 * @returns {{ next: number, seq: string }} next=数字，seq=补零字符串
 */
export function bumpSeq(root) {
  const { seqFile } = askPaths(root)
  // 搬运自 ask-server.js 第 67-70 行：读 seq.txt，剥 BOM
  let n = 0
  try {
    n = Number(fs.readFileSync(seqFile, 'utf8').replace(/^\uFEFF/, '').trim()) || 0
  } catch {
    /* 第一次运行，文件不存在 */
  }
  n += 1
  // 搬运自 ask-server.js 第 73 行：写回 seq.txt
  // 原子写入：先写临时文件再 rename（原代码直接 writeFileSync，此处加强）
  const dir = path.dirname(seqFile)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = seqFile + '.tmp'
  fs.writeFileSync(tmp, String(n), 'utf8')
  fs.renameSync(tmp, seqFile)
  // 搬运自 ask-server.js 第 74 行：padStart(4, '0')
  return { next: n, seq: formatSeq(n) }
}

/**
 * 追加一行到 pending.jsonl（自动补 \n）。
 * 搬运自 ask-server.js 第 230 行（appendFileSync）。
 * @param {string} root 课程包根目录
 * @param {string} line 要追加的 JSON 字符串（不含换行）
 */
export function appendPending(root, line) {
  const { pending, questionsDir } = askPaths(root)
  fs.mkdirSync(questionsDir, { recursive: true })
  // 搬运自 ask-server.js 第 230 行：appendFileSync + '\n'
  // 保证不会写坏行：如果文件已有内容但末尾没有 \n，先补一个
  try {
    const existing = fs.readFileSync(pending, 'utf8')
    if (existing.length > 0 && !existing.endsWith('\n')) {
      fs.appendFileSync(pending, '\n', 'utf8')
    }
  } catch {
    /* 文件不存在，不需要补 */
  }
  fs.appendFileSync(pending, line + '\n', 'utf8')
}

/**
 * 读 pending.jsonl 全文。不存在返回 ""。
 * 搬运自 ask-server.js 第 77-83 行（countPending 的读文件逻辑）。
 * @param {string} root 课程包根目录
 * @returns {string}
 */
export function readPendingText(root) {
  const { pending } = askPaths(root)
  try {
    return fs.readFileSync(pending, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 编排 POST /ask 处理器。
 * 搬运自 ask-server.js 第 187-238 行（POST /ask 完整处理流程）。
 *
 * 流程：校验(parseAskBody) → 取序号(bumpSeq) → 入库(appendPending) → 组响应
 * 失败时**不许写盘、不许自增序号**。
 *
 * @param {string} root 课程包根目录
 * @param {{ raw: string, now?: () => string }} opts raw=请求体原文，now=时钟注入
 * @returns {{ status: number, body: object }}
 */
export async function handleAsk(root, { raw, now } = {}) {
  const clock = now || (() => new Date().toISOString())

  // 搬运自 ask-server.js 第 205-218 行：JSON 解析 + 校验
  // 纯逻辑委托给 ./ask.js 的 parseAskBody
  const parsed = parseAskBody(raw)
  if (!parsed.ok) {
    // ⚠️ 缝上：纯层的失败形状是 { ok:false, status, error }，对外响应体是 { ok:false, error }
    //    （两个 agent 各自推断签名时这里对不上，直接导致 ESM 加载期就炸 ✗）
    return { status: parsed.status, body: { ok: false, error: parsed.error } }
  }

  // 搬运自 ask-server.js 第 219 行：nextId()
  // 校验通过才递增序号（失败时不写盘、不自增）
  const { seq } = bumpSeq(root)

  // 搬运自 ask-server.js 第 220-228 行：构建 record
  const record = serializeRecord(parsed.value, seq, clock)

  // 搬运自 ask-server.js 第 230 行：appendFileSync
  appendPending(root, JSON.stringify(record))

  // 原代码这里 console.log 一行；插件环境下不许往 stdout 喷（工具层有自己的日志面）✗
  // 成功响应：搬运自 ask-server.js 第 234 行
  return { status: 200, body: { ok: true, id: seq } }
}

/**
 * 只读分支：GET 拉待答队列。
 * 搬运自 ask-server.js 第 77-83 行（countPending）+ 第 125-128 行（GET /health 的 pending 字段）。
 * @param {string} root 课程包根目录
 * @returns {{ status: number, body: object }}
 */
export function readQueue(root) {
  // 用纯层的 parsePending：坏行**不静默吞掉**，收进 errors 一起返回
  const { entries, errors } = parsePending(readPendingText(root))
  return { status: 200, body: { ok: true, pending: entries, count: entries.length, errors } }
}

/* ── answer 写回：只动台账（其余复用课程包现成的 drain / build-notes）──────── */

/** 已答台账的位置（手写 JS，UMD） */
export function ledgerPath(root) {
  return path.join(root, 'assets', 'questions-data.js')
}

/** require 台账（先清缓存：写完再读必须拿到新的） */
export function loadLedger(root) {
  const abs = ledgerPath(root)
  delete requireCJS.cache[abs]
  return requireCJS(abs)
}

/**
 * 写入后的自检 + **失败回滚**。
 *
 * 为什么单独抽成一个函数：这条分支（写成功、但自检不过）**只在 I/O 竞态下才可达**，
 * 不抽出来就永远走不到它 —— 等于"写了回滚代码但从没验过" ✗。
 * `load` 是**注入**的（默认 `loadLedger`）：测试传一个"读回来少了键"或"抛错"的 load，
 * 就能真的把回滚跑一遍。这是依赖注入，不是往生产代码里塞测试钩子。
 *
 * @returns {{ ok: boolean, note: string }}
 */
export function verifyOrRollback({ root, abs, src, before, key, load }) {
  const loadFn = load || (() => loadLedger(root))
  let added = []
  let lost = []
  try {
    const after = loadFn()
    const afterKeys = Object.keys(after)
    const beforeKeys = Object.keys(before)
    added = afterKeys.filter((k) => !beforeKeys.includes(k))
    lost = beforeKeys.filter((k) => !afterKeys.includes(k))
    if (added.length === 1 && added[0] === key && lost.length === 0) {
      return { ok: true, note: `新增 ${added[0]} · 丢失 无` }
    }
  } catch (e) {
    fs.writeFileSync(abs, src, 'utf8') // 回滚：原文完整还原
    delete requireCJS.cache[abs]
    return { ok: false, note: `require 失败：${e.message}` }
  }
  fs.writeFileSync(abs, src, 'utf8') // 回滚：原文完整还原
  delete requireCJS.cache[abs]
  return { ok: false, note: `新增 ${added.join('、') || '无'} · 丢失 ${lost.join('、') || '无'}` }
}

function readTextOr(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 在待答 + 已答里找这条疑问（台账的 question 必须是**学生原话**，不许调用方现编） */
export function findQuestion(root, id) {
  const P = askPaths(root)
  for (const file of [P.pending, P.processed]) {
    const { entries } = parsePending(readTextOr(file))
    const hit = entries.find((e) => String(e.id) === String(id))
    if (hit) return hit
  }
  return null
}

/**
 * 队列的**高水位**：待答 + 已答里出现过的最大编号。
 *
 * 为什么需要它：监听"有没有新提问"不能靠"文件被写过" ——
 * 我们自己 drain（重写 pending、行数变少）也会动这个文件，
 * 靠文件变化触发唤醒会变成**自己叫醒自己**的死循环 ✗。
 * 只有"编号比高水位更大"才算真·新提问 ✓
 */
export function queueHighWater(root) {
  const P = askPaths(root)
  let max = 0
  for (const file of [P.pending, P.processed]) {
    const { entries } = parsePending(readTextOr(file))
    for (const e of entries) {
      const n = Number(e.id)
      if (Number.isSafeInteger(n) && n > max) max = n
    }
  }
  return max
}

/** 跑课程包现成的无参脚本（零依赖、幂等）—— 失败如实回报，不假装成功 */
export function runScript(root, script) {
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  return {
    script,
    code: r.status === null ? -1 : r.status,
    tail: out.split('\n').filter(Boolean).slice(-2).join(' ／ '),
  }
}

/**
 * 编排 POST /answer：校验 → 写台账（外科手术式追加）→ 自检 → 失败回滚 → 重建产物。
 *
 * 顺序与"宁可重复不可丢"：台账写成功前**不碰任何队列文件**；
 * 归档（drain）与重建（build-notes）复用课程包现成脚本，插件不复制它们的语义。
 *
 * @param {string} root 课程包根
 * @param {{ raw: string, now?: () => string, rebuild?: boolean }} opts
 * @returns {{ status: number, body: object }}
 */
export async function handleAnswer(root, { raw, now, rebuild = true } = {}) {
  const clock = now || (() => new Date().toISOString())
  const parsed = validateAnswerBody(raw)
  if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } }
  const v = parsed.value

  const abs = ledgerPath(root)
  if (!fs.existsSync(abs)) return { status: 500, body: { ok: false, error: `找不到台账 ${abs}` } }
  const src = fs.readFileSync(abs, 'utf8')

  let before
  try {
    before = loadLedger(root)
  } catch (e) {
    return { status: 500, body: { ok: false, error: `台账 require 失败：${e.message}` } }
  }
  if (Object.prototype.hasOwnProperty.call(before, v.id)) {
    return { status: 409, body: { ok: false, error: `台账里已经有 ${v.id} —— 只追加、不覆盖` } }
  }

  const q = findQuestion(root, v.id)
  const question = q?.question || v.question
  if (!question) {
    return {
      status: 400,
      body: { ok: false, error: `队列与归档里都找不到 ${v.id}，也没给 question —— 台账只登记学生真实提过的疑问` },
    }
  }
  const lesson = v.lesson || q?.lesson || ''
  const entry = {
    id: v.id,
    date: String(clock()).slice(0, 10),
    lesson,
    question,
    // 解答不落在正文里（D3）：统一指向文档页，锚点是 qNNNN
    page: 'reference/NOTES.html',
    anchor: `q${v.id}`,
    section: v.section || (lesson ? `${lesson} 答疑` : '答疑'),
    answer: v.answer,
    answerHtml: v.answerHtml,
  }

  let next
  try {
    next = insertLedgerEntry(src, v.id, serializeLedgerEntry(entry))
  } catch (e) {
    return { status: 409, body: { ok: false, error: e.message } }
  }

  // 原子写
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, next, 'utf8')
  fs.renameSync(tmp, abs)

  // 写完必须能 require 回来：新键在、旧键一个不少、只多一个
  const check = verifyOrRollback({ root, abs, src, before, key: v.id })
  if (!check.ok) {
    return { status: 500, body: { ok: false, error: `写入后自检没过（${check.note}）—— 已回滚台账` } }
  }

  const steps = []
  if (rebuild) {
    for (const script of ['tools/drain-questions.js', 'tools/build-notes.js']) {
      steps.push(runScript(root, script))
    }
  }

  // 重建失败要**结构化地**报出来，但**不能**把"写成功"说成"失败"：
  // 回非 2xx 会诱导调用方重试 → 同一条答案被写两遍（台账只追加不覆盖 ✗）。
  // 所以 status 照旧 200（台账确实写成了），失败单独成字段，并在 warnings 里点名。
  const failed = steps.filter((s) => s.code !== 0)

  return {
    status: 200,
    body: {
      ok: true,
      id: v.id,
      ledger: 'assets/questions-data.js',
      selfCheck: check.note,
      steps,
      ...(rebuild
        ? {
            rebuild: { ok: failed.length === 0, failed: failed.map((s) => s.script) },
            warnings: failed.map(
              (s) => `重建脚本 ${s.script} 退出码 ${s.code} —— 台账已写好，但产物可能是旧的：${s.tail || '（没有输出）'}`
            ),
          }
        : {}),
    },
  }
}
