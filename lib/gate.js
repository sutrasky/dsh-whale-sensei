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
 *   no-snapshot / unknown-lesson / no-criteria / stale-snapshot / criteria-not-met / ok
 */

import fs from 'node:fs'
import path from 'node:path'
import { digestTree, PROBE_VERSION } from './fingerprint.js'
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
  // 对位键（P1-11）：「课次 id 在快照里找不到」与「这门课没声明判据」是**两种病、两句 hint** ——
  // 混成一句就把 id 写错的人指去"先补判据"（修法指错了）。顺序即契约：unknown-lesson 排在
  // no-snapshot 之后、no-criteria 之前（都在新鲜度两把尺子之前）—— 与包侧 judgeLightup 同一顺序、同一句 hint。
  if (hit === null) {
    return { ok: false, code: 'unknown-lesson', hint: '课次 id 不认识：' + lessonId + '（判据快照里没有这门课）—— 要么 id 写错了，要么快照是旧的；先跑 whale_state write:true 刷新一次再试', gapText: [] }
  }
  if (!usable) {
    return { ok: false, code: 'no-criteria', hint: '这门课还没声明挑战判据（EXPECT.json challenges）—— 先补判据', gapText: [] }
  }
  // 新鲜度有**两把尺子**，顺序不能反、更不能合成一条 —— 先比探针版本，再比代码树的内容指纹：
  // ① probeVersion：这份判词是**哪个版本的探针**算的（缺 / 不等 = 判定口径变过，旧判词不可信）；
  // ② sourceDigest：学生代码树变没变（原有判定，一行没动）。
  // ⚠️ 两种过期原因必须**两句话**（hint 各写各的）：探针升级 = 学生什么都不用改、刷新一次就好；
  //    代码又改了 = 你刚改的还没重判。混成一句就把人指向错的修法。
  // ⚠️ `no-snapshot`（doc 读不动）在最前面、`no-criteria` 在这之前 —— 别往它们前面插（顺序即契约）。
  if (doc.probeVersion !== PROBE_VERSION) {
    return {
      ok: false,
      code: 'stale-snapshot',
      hint: '判据快照是旧版探针算出来的（探针升级、判定口径变过）：不用改代码，跑 whale_state write:true 刷新一次即可',
      gapText: [],
    }
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
  const evidenceGaps = []
  let achieved = 0
  let total = 0
  for (const c of chs) {
    // ── 证据档（P0-4 戊1b，2026-09-25）：**阻塞**，所以必须排在 needsReview 那条"不阻塞"快路之前 ──
    // 口径：`c.evidence.ok === false` 是探针在快照里算好的（`lib/state.js` 的 judgeChallenges），
    // 回执那句话也**存在快照里**（`c.evidence.hint`）—— 两侧只是转述，不许各写一份（会漂）。
    if (c.evidence && c.evidence.ok === false) {
      evidenceGaps.push({
        no: c.no,
        deliverable: c.deliverable,
        min: c.evidence.min,
        have: c.evidence.have,
        hint: c.evidence.hint || '',
      })
      continue
    }
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
  //
  // 判定顺序**即契约**（与包侧 judgeLightup 同一顺序，改一处必须改两处）：
  //   ① criteria-not-met（机器判据的缺口，最具体）→ ② evidence-insufficient（证据档不够）→ ③ ok
  // 两者都缺时**一次回执全说**（`criteria-not-met` 里也带 `evidenceGaps`）——
  // 不然学生要修两轮才知道还差证据。
  if (gaps.length) return { ok: false, code: 'criteria-not-met', gaps, gapText, evidenceGaps, achieved, total }
  if (evidenceGaps.length) {
    return {
      ok: false,
      code: 'evidence-insufficient',
      evidenceGaps,
      gapText: evidenceGaps.map((g) => g.hint),
      achieved,
      total,
      needsReview,
      // 台账还没建立时的回退说明（判据 ④：**不静默变松**）—— 由快照的 lesson 带过来
      evidenceFallback: hit.evidenceFallback === true,
    }
  }
  // 判词只看 challenges，不要求 `lessons[].done === true`（Q2 裁定）——
  // 但该说的必须说：本课 required 还缺着的，作为**不阻塞**的提示回给调用方
  const requiredGaps = (Array.isArray(hit.missing) ? hit.missing : [])
    .map((m) => String((m && (m.hint || m.value || m.id)) || ''))
    .filter(Boolean)
  // ⚠️ code 必须给 'ok'：challengeGate 的分支表（`v.code === 'ok'`）与判词词汇表都认这个词，
  //    漏了它就会掉进兜底的 fail-closed 分支，把"挑战全过"误判成「未检测（undefined）」——
  //    2026-09-24 G 条（端点解析认了裸注解 + 类级前缀）让真包第一次出现"全过"，当场暴露。
  return {
    ok: true, code: 'ok', needsReview, gapText: [], requiredGaps,
    // 台账还没建立 → 声明了 minEvidence 的题**这一档没判**（判据 ④）。必须说出来，不许静默。
    evidenceFallback: hit.evidenceFallback === true,
  }
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
 *   上一课没声明判据 / 快照里找不到上一课 → **allowed + 显式告警**（防死锁，绝不静默；两种病两句 warning）
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
  if (v.code === 'unknown-lesson') {
    // 对位键（P1-11）：快照里找不到这门课 ≠ 没声明判据。放行口径与 no-criteria **同一条**
    // （防死锁：刚建的课还没进快照 / EXPECT 还没登记时，拦着就是永久卡死 —— 与「无判据放行」同一立场），
    // 但两句 warning 各说各的修法：这条要的是「核对 id / 刷新快照」，不是「补判据」。
    return {
      ...base,
      allowed: true,
      warning: `《${prev.id}》在判据快照里找不到（课次 id 对不上，或快照旧了）—— 已按**无闸放行**（先确认 id，再跑 whale_state write:true 刷新；不是"没写判据"）`,
      why: '上一课在快照里找不到：放行（防死锁），但这条告警必须让用户看见 —— 修法是核对 id / 刷新快照，不是补判据',
    }
  }
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
      // 证据档也缺的话**一次说全**（判定顺序见 judgeSnapshot 的尾注）
      evidenceGaps: v.evidenceGaps || [],
      // 卡片上写「上一课挑战未完成（3/5）」要用（v3 §1.2）
      achieved: v.achieved || 0,
      total: v.total || 0,
      error: `上一课《${prev.id}》的挑战还没过 —— 还不能新开下一课`,
      why: (v.gapText || []).join('；'),
    }
  }
  if (v.code === 'evidence-insufficient') {
    // P0-4 戊1b：机器判不了的那道题**不再是不阻塞的老师点头**，而是"补到哪一档证据才够"。
    // 仍然**不是死锁**：课页那道题的「贴证据」就是补法，回执里逐条说清差哪一档。
    return {
      ...base,
      allowed: false,
      evidenceGaps: v.evidenceGaps || [],
      gapText: v.gapText || [],
      achieved: v.achieved || 0,
      total: v.total || 0,
      needsReview: v.needsReview || [],
      error: `上一课《${prev.id}》还有挑战的**证据档不够** —— 还不能新开下一课`,
      hint: '课页那道题的「贴证据」里补上就行（回执里逐条写了还差哪一档）',
      why: (v.gapText || []).join('；'),
    }
  }
  if (v.code === 'ok') {
    return {
      ...base,
      allowed: true,
      needsReview: v.needsReview || [],
      requiredGaps: v.requiredGaps || [],
      // 判据 ④：台账还没建立时**这一档没判**，必须说出来（不许静默变松）
      evidenceFallback: v.evidenceFallback === true,
      why: `《${prev.id}》的挑战全部通过${(v.needsReview || []).length ? `（另有 ${v.needsReview.length} 项需人工确认，不阻塞）` : ''}`
        + (v.evidenceFallback ? '；⚠️ 证据台账还没建立，声明了最低证据档的题**这一档没判**（贴一条证据即启用）' : ''),
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
