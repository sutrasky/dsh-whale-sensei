/**
 * lib/brief-io.js — 上下文包的 IO 薄壳：把散在各处的输入收成一处
 * ------------------------------------------------------------------
 * 复用已有的壳，不重写它们的语义：
 *   · 学生现状   ← lib/state-scan.js 的 probeState（它已经会读 EXPECT.json 并算缺口）
 *   · 待答队列   ← lib/ask-io.js 的 readQueue（BOM 容忍）
 *   · 已答归档   ← questions/processed.jsonl（走 lib/ask.js 的 parsePending）
 *   · 已答台账   ← lib/ask-io.js 的 loadLedger + questions-data.js 的键
 *   · 术语       ← lib/glossary-io.js 的 loadGlossaryLedger + glossarySummary
 *   · 学习记录   ← learning-records/*.md 的文件名（只列名字，不读内容）
 *
 * 组装逻辑（含"下一步建议"的推导）在 `lib/brief.js`（纯）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { probeState } from './state-scan.js'
import { readQueue, loadLedger, askPaths } from './ask-io.js'
import { loadGlossaryLedger, glossarySummary } from './glossary-io.js'
import { parsePending } from './ask.js'
import { readNotes } from './notes-io.js'
import { lessonIndex, labelOfAnchor, prerequisiteGaps, describeGaps } from './pack-model.js'
import { readIntake } from './intake.js'

/**
 * learning-records/*.md 的文件名（按名字排序 —— 名字带序号，所以排序即时间序）
 *
 * ⚠️ 排除 `brief.md`：它是本工具自己的**产物**，写在那儿会被数进"学习记录 N 份"，
 *    于是"再写一次"永远发现内容变了 → 不幂等（实测踩过 ✗）。产物不许污染它自己的输入。
 */
const OWN_ARTIFACTS = new Set(['brief.md'])

export function listLearningRecords(root) {
  try {
    return fs
      .readdirSync(path.join(root, 'learning-records'))
      .filter((f) => f.endsWith('.md') && !OWN_ARTIFACTS.has(f))
      .sort()
  } catch {
    return []
  }
}

/** 已答归档条数（processed.jsonl 里能解析的行数） */
export function countProcessed(root) {
  const file = askPaths(root).processed
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  return parsePending(text).entries.length
}

/** 已答台账概览：登记了几条、最新一条的编号 */
export function ledgerOverview(root) {
  try {
    const ledger = loadLedger(root)
    const keys = Object.keys(ledger).sort()
    return { count: keys.length, latest: keys.length ? keys[keys.length - 1] : null }
  } catch {
    return { count: 0, latest: null }
  }
}

/**
 * 学情摸底概览：课程包里有课次的知识点中，哪些已摸底、哪些没摸底。
 * 不含时间戳（brief 逐字节对拍判据要求）。
 */
export function buildIntakeSummary(root, pack) {
  // 收集课程包里有课次的知识点（从 points 列表或 circles 推导）
  const allPoints = []
  if (Array.isArray(pack?.points)) {
    for (const p of pack.points) {
      if (typeof p === 'string') allPoints.push(p)
      else if (p?.id) allPoints.push(p.id)
    }
  }
  // 没有课程包就空
  if (!allPoints.length) return { have: 0, missing: [], details: {} }
  const { latest } = readIntake(root)
  const missing = []
  const details = {}
  for (const pt of allPoints) {
    const e = latest[pt]
    if (e?.level && e?.goal) {
      details[pt] = e.level
    } else {
      missing.push(pt)
    }
  }
  return { have: Object.keys(details).length, missing, details }
}

/**
 * 一次取齐 brief 需要的全部输入。
 * @param {string} root 课程包根
 * @param {object} pack readPack 的结果
 * @param {{codeDir?: string}} opts
 */
export function readBriefInputs(root, pack, opts = {}) {
  const { state } = probeState(root, pack, opts)
  const queue = readQueue(root)
  let glossary = { count: 0, categories: 0 }
  try {
    glossary = glossarySummary(loadGlossaryLedger(root))
  } catch {
    /* 台账读不动就报 0，不猜 */
  }
  // 课次索引只读一次：`lessonIndex` 没有记忆化（每次调用都重扫产物页与源页目录），
  // 放进下面的 map 就变成「每条笔记扫一遍课程包」——笔记一多就是秒级开销。
  // 前置体检（2026-09-23）：开课摸底时就要看得见"前置学没学过"。
  // 只报**已经有课**的知识点 —— 一门课都还没有的知识点，还没到能学它的地步。
  // 措辞用 `describeGaps()` 的同一份实现（工具输出与 author 的拒绝理由不许各说各话）。
  const prereqAll = []
  if (Array.isArray(pack?.points) && Array.isArray(pack?.lessons)) {
    for (const p of pack.points) {
      if (!pack.lessons.some((l) => l.point === p.id)) continue
      const gaps = prerequisiteGaps(pack, p.id)
      prereqAll.push({ ...gaps, why: describeGaps(gaps) })
    }
    prereqAll.sort((a, b) => a.pointId.localeCompare(b.pointId))
  }

  const lessonIdx = lessonIndex(root)
  return {
    pack: {
      circles: Array.isArray(pack?.circles) ? pack.circles.length : pack?.circles ?? 0,
      points: Array.isArray(pack?.points) ? pack.points.length : pack?.points ?? 0,
      lessons: Array.isArray(pack?.lessons) ? pack.lessons.length : pack?.lessons ?? 0,
      learned: Array.isArray(pack?.lessons) ? pack.lessons.filter((l) => l.learned).length : 0,
    },
    prereqAll,
    projects: state.projects,
    stateNotes: state.notes,
    pending: queue.body.pending || [],
    processed: countProcessed(root),
    ledger: ledgerOverview(root),
    glossary,
    records: listLearningRecords(root),
    notes: readNotes(root).map((n) => ({
      ...n,
      label: labelOfAnchor(n.anchor, lessonIdx),
    })),
    intake: buildIntakeSummary(root, pack),
  }
}

/**
 * 把消息里的**可见文本**抽出来。
 *
 * ⚠️ 只取 `type === 'text'` 的块。宿主的 ContentBlockMap 是
 *   `'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | 'tool-result'`
 *   （`dsh-tool-cordis` 的类型声明里写着 `ReasoningBlock = { type:'reasoning', text:string }`）。
 *   第一版把所有块的 `text` 都拼起来 ⇒ **思考内容被当可见回复泄漏进 brief** ✗
 *   —— 这是现场调用时肉眼发现的，单测没覆盖到。宁可只认 text 块、其余算"无可见文本"。
 */
function messageText(m) {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter((p) => p && typeof p === 'object' && p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 从会话里取**最近 N 条**消息。
 *
 * 依据（自己读源码核过的，不是猜的）：
 *   · 工具能拿到 `exec.agent.session`（宿主的 `execute(args, exec)` 约定）
 *   · `Session.deriveMessages(): Message[]` 直接给出对话消息（`dsh-session/lib/index.js:1269`），
 *     形状是标准 provider 消息 `{ role, content: [{ type, text }] }`
 *     （`dsh-session/lib/types/surface.js:75-110`）
 *   · ⚠️ 这些 Message 是**共享且深冻结**的（同处注释明说）⇒
 *     **只抽 role + 截断后的纯文本，绝不把原始对象带出去**（那也会破坏 lossless JSON ✗）
 *
 * @param {object} session exec.agent.session
 * @param {number} limit 取最近几条（1..20，默认 6）
 * @param {number} maxChars 每条截断长度（40..600，默认 160）
 */
export function readSessionTail(session, limit = 6, maxChars = 160) {
  if (!session || typeof session.deriveMessages !== 'function') {
    return { ok: false, why: '拿不到会话对象（这个工具不是在一个 agent 会话里被调用的？）', messages: [] }
  }
  let raw
  try {
    raw = session.deriveMessages()
  } catch (e) {
    return { ok: false, why: `读会话失败：${e?.message ?? e}`, messages: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, why: 'deriveMessages() 没给出数组（API 形状变了？）', messages: [] }
  }
  const n = Math.max(1, Math.min(20, Number(limit) || 6))
  const cap = Math.max(40, Math.min(600, Number(maxChars) || 160))
  // 没有可见文本的消息（tool-result / image / 纯 reasoning）**整条丢掉**，
  // 否则"最近 N 条"会被空壳占满（且那 N 条里一条对话都没有）
  const visible = raw
    .map((m) => ({ role: String(m?.role ?? '?'), text: clip(messageText(m), cap) }))
    .filter((m) => m.text)
  return {
    ok: true,
    why: '',
    total: raw.length,
    visible: visible.length,
    shown: Math.min(n, visible.length),
    messages: visible.slice(-n),
  }
}

/** 原子写 brief（内容没变不重写） */
export function writeBrief(root, text, rel = 'learning-records/brief.md') {
  const abs = path.join(root, ...rel.split('/'))
  let prev = null
  try {
    prev = fs.readFileSync(abs, 'utf8')
  } catch {
    /* 不存在 */
  }
  if (prev === text) return { path: rel, changed: false, chars: text.length }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, abs)
  return { path: rel, changed: true, chars: text.length }
}
