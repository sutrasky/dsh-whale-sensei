/**
 * lib/gate.js — 开新课的**门禁**：上一课的挑战过没过（2026-09-24 F1a）
 * ------------------------------------------------------------------
 * 为什么单独一个模块：判词必须与**包侧** `tools/ask-server.js` 的 `judgeLightup()` **逐字一致**
 * （v3 §2.1 第一条硬约束：不许出现"没点亮却放行"）。所以这里不是另写一套判定，
 * 而是把同一套判据搬到插件侧，并让 `test/challenge-gate.mjs` 拿同一份快照对拍两边。
 *
 * 与 `judgeLightup` 的**唯一差别**：包侧遇到过期快照直接回 `stale-snapshot`（点亮是写操作，
 * 必须失败关闭）；这里按 v3 §4.1 **自动重判一次**（探针重扫 + 原子写回快照），
 * 仍失败才回 `stale-snapshot`。判定本身仍走同一条路径。
 *
 * 词汇表（与 judgeLightup 逐字相同）：
 *   no-snapshot / no-criteria / stale-snapshot / criteria-not-met / ok
 */

import fs from 'node:fs'
import path from 'node:path'
import { digestTree } from './fingerprint.js'
import { probeState, writeState } from './state-scan.js'

export const SNAPSHOT_REL = 'learning-records/state.json'

/** 读判据快照；读不动 / 不是对象 → null（调用方据此回 `no-snapshot`，不猜） */
export function readSnapshot(root) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(path.resolve(root), ...SNAPSHOT_REL.split('/')), 'utf8'))
    return doc && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

/**
 * 单课判词 —— **镜像** `tools/ask-server.js` 的 `judgeLightup()`。
 * 改这里必须同步改那边（`test/challenge-gate.mjs` 的对拍会红）。
 *
 * @param {object|null} doc 快照（`learning-records/state.json` 的内容）
 * @param {string} root 课程包根（算新鲜度用）
 * @param {string} lessonId 课次键（`point/NNNN`）
 * @returns {{ok: boolean, code: string, hint?: string, needsReview?: number[], gaps?: object[], gapText?: string[], requiredGaps?: string[]}}
 */
export function judgeSnapshot(doc, root, lessonId) {
  if (!doc) {
    return { ok: false, code: 'no-snapshot', hint: '先跑 whale_state write:true 生成判据快照', gapText: [] }
  }
  let hit = null
  let project = null
  for (const pr of doc.projects || []) {
    const l = pr && Array.isArray(pr.lessons) ? pr.lessons.find((x) => x && x.id === lessonId) : null
    if (l) { hit = l; project = pr; break }
  }
  const chs = hit ? hit.challenges : undefined
  const usable = Array.isArray(chs) && chs.length > 0
    && chs.every((c) => c && Number.isSafeInteger(c.no) && c.no > 0
      && typeof c.deliverable === 'string'
      && (c.done === true || c.done === false || c.done === null))
  if (!usable) {
    return { ok: false, code: 'no-criteria', hint: '这门课还没声明挑战判据（EXPECT.json challenges）—— 先补判据', gapText: [] }
  }
  // 新鲜度 = 内容指纹（不是 mtime）：老快照缺字段 / 项目目录读不动 → 一律判过期
  const saved = typeof project.sourceDigest === 'string' ? project.sourceDigest : ''
  let now = ''
  try {
    now = digestTree(path.resolve(root, String(project.dir || '')))
  } catch {
    now = ''
  }
  if (!saved || now !== saved) {
    return { ok: false, code: 'stale-snapshot', hint: '代码在快照之后又变了：先跑 whale_state write:true 刷新', gapText: [] }
  }
  const needsReview = []
  const gaps = []
  const gapText = []
  let achieved = 0
  let total = 0
  for (const c of chs) {
    // auto:false（机器判不了）→ 不阻塞，但题号必须显式回执
    if (c.done === null || c.needsReview === true) { needsReview.push(c.no); continue }
    total += 1
    if (c.done === true) { achieved += 1; continue }
    const miss = (Array.isArray(c.missing) ? c.missing : [])
      .map((m) => String((m && (m.hint || m.evidence || m.id)) || ''))
      .filter(Boolean)
    gaps.push({ no: c.no, deliverable: c.deliverable, hint: c.hint || '', missing: miss })
    gapText.push('第' + c.no + '题：' + c.deliverable + '（缺：' + (miss.join('、') || '未过') + '）')
  }
  // ⚠️ `achieved` / `total` 是给 UI 的（卡片上要写「上一课挑战未完成（3/5）」，v3 §1.2）——
  //    只算**可机判**的题（auto:false 不计入，与 judgeLightup 的 autoTotal 同口径）
  if (gaps.length) return { ok: false, code: 'criteria-not-met', gaps, gapText, achieved, total }
  // 判词只看 challenges，不要求 `lessons[].done === true`（Q2 裁定）——
  // 但该说的必须说：本课 required 还缺着的，作为**不阻塞**的提示回给调用方
  const requiredGaps = (Array.isArray(hit.missing) ? hit.missing : [])
    .map((m) => String((m && (m.hint || m.value || m.id)) || ''))
    .filter(Boolean)
  return { ok: true, needsReview, gapText: [], requiredGaps }
}

/**
 * 某知识点**现有的最后一课**（= "上一课"）。
 * 按 number 取最大 —— 与 `pack.lessons` 的编号规则同源（`point/NNNN`）。
 *
 * @returns {object|null} 课对象（含 id/number/learned），没有课 → null（首课）
 */
export function previousLesson(pack, point) {
  const list = (pack?.lessons || []).filter((l) => l && l.point === point)
  if (!list.length) return null
  return list.slice().sort((a, b) => (a.number || 0) - (b.number || 0))[list.length - 1]
}

/**
 * 门禁：能不能开这个知识点的**下一课**。
 *
 * 判定顺序（v3 §2.4 的矩阵）：
 *   首课（没有上一课）            → allowed
 *   上一课没声明判据              → **allowed + 显式告警**（防死锁，绝不静默）
 *   上一课挑战全过                → allowed（`needsReview` / `requiredGaps` 照实回执）
 *   上一课有 missing              → blocked，逐条列 `#编号 + hint`
 *   快照缺失 / 过期且重判失败      → unknown（fail-closed，但「重新检测」即达放行）
 *
 * @param {{root: string, pack: object, point: string, probe?: boolean}} opts
 *   `probe`（默认 true）= 快照过期时**自动重判一次**
 * @returns {object}
 */
export function challengeGate({ root, pack, point, probe = true } = {}) {
  const prev = previousLesson(pack, point)
  if (!prev) {
    return { allowed: true, code: 'first-lesson', lesson: null, why: '这个知识点还没有课 —— 首课直接进' }
  }
  const abs = path.resolve(root)
  const judge = (doc) => judgeSnapshot(doc, abs, prev.id)

  let doc = readSnapshot(abs)
  let v = judge(doc)
  let rejudged = false
  if (probe && (v.code === 'stale-snapshot' || v.code === 'no-snapshot')) {
    // v3 §4.1：过期**自动重判一次**（重扫 + 原子写回），仍失败才 fail-closed
    try {
      const { state } = probeState(abs, pack, {})
      writeState(abs, state)
      rejudged = true
      doc = readSnapshot(abs)
      v = judge(doc)
    } catch {
      /* 重判自己炸了 → 保持原判（下面按 unknown 处理） */
    }
  }

  const base = { lesson: prev.id, lessonNumber: prev.number, learned: prev.learned === true, rejudged, code: v.code }
  if (v.code === 'no-criteria') {
    // 防死锁：**放行**，但三级可见（卡片徽标 / 提示条 / 服务端日志）—— 绝不静默降级
    return {
      ...base,
      allowed: true,
      warning: `《${prev.id}》没有声明挑战判据 —— 已按**无闸放行**（补上 EXPECT.json 的 challenges 之后这里会自动收紧）`,
      why: '上一课没声明判据：放行（防死锁），但这条告警必须让用户看见',
    }
  }
  if (v.code === 'criteria-not-met') {
    return {
      ...base,
      allowed: false,
      missing: v.gaps || [],
      gapText: v.gapText || [],
      // 卡片上写「上一课挑战未完成（3/5）」要用（v3 §1.2）
      achieved: v.achieved || 0,
      total: v.total || 0,
      error: `上一课《${prev.id}》的挑战还没过 —— 还不能新开下一课`,
      why: (v.gapText || []).join('；'),
    }
  }
  if (v.code === 'ok') {
    return {
      ...base,
      allowed: true,
      needsReview: v.needsReview || [],
      requiredGaps: v.requiredGaps || [],
      why: `《${prev.id}》的挑战全部通过${(v.needsReview || []).length ? `（另有 ${v.needsReview.length} 项需人工确认，不阻塞）` : ''}`,
    }
  }
  // no-snapshot / stale-snapshot：fail-closed，但一键「重新检测」即达放行 —— 不骗人也不死锁
  return {
    ...base,
    allowed: false,
    error: `上一课《${prev.id}》的挑战**未检测**（${v.code}）：${v.hint || ''}`,
    hint: '点「立即检测」重扫一次；还是不行就说明快照真的对不上（服务未运行 / 代码又改过）',
    why: v.hint || v.code,
  }
}
