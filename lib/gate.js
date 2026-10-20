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
 *
 * **MIRROR-OF: tools/ask-server.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */

import fs from 'node:fs'
import path from 'node:path'
import { digestTree, PROBE_VERSION } from './fingerprint.js'
import { probeState, writeState } from './state-scan.js'
import { readEvidence } from './evidence-io.js'
// U18：五态归一 + 门禁现读复核的**唯一实现**在 `lib/unify/evidence.cjs`（经 `lib/evidence.js` 适配）。
// `sameLesson`：快照里的课次 id 是**声明形状**（EXPECT 的 `point/NNNN`），课次身份是**规范形状**
// （`circle/point/NNNN`）—— 两种形状的同一门课必须能被认成同一门（C6 登记过这条口径）。
import { sameLesson, liveLedgerVerdict } from './evidence.js'

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
  // ⚠️ 课次 id 的**两种形状**必须能对上（U18 / C6）：快照里是 `EXPECT.json` 的声明形状
  //    （`point/NNNN`），而课次身份是规范形状（`circle/point/NNNN`）。只做逐字相等的话，
  //    U09 把身份收成规范键之后，**每一门课都会掉进下面的 unknown-lesson**（那是"放行"，
  //    等于把缺判据扩大成通过）。所以：先逐字相等（既有行为，最快），再按点 + 号对位。
  for (const pr of doc.projects || []) {
    const l = pr && Array.isArray(pr.lessons) ? pr.lessons.find((x) => x && x.id === lessonId) : null
    if (l) { hit = l; project = pr; break }
  }
  if (hit === null) {
    for (const pr of doc.projects || []) {
      const l = pr && Array.isArray(pr.lessons) ? pr.lessons.find((x) => x && sameLesson(x.id, lessonId)) : null
      if (l) { hit = l; project = pr; break }
    }
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
  // ── T12（C02）：快照里的 `challenges[].evidence` 可能是**旧判词** ──
  // 证据台账不在 `sourceDigest` 里（那个指纹只算学生代码树），所以台账在快照之后坏掉 /
  // 读不动时，证据指纹仍然"新鲜"。这里在**门禁时**再看一眼台账状态：坏账 / 读不动 /
  // 空账 ⇒ 快照里任何"证据够档"的判词都不可信，必须按证据不够拦下（fail-closed）。
  // ⚠️ 只对**声明了 minEvidence 的题**生效；`missing` 不在此列（防死锁回退是既定策略，
  //    且判据快照的夹具可以合法地没有台账）。
  // U18：哪些态算不可信**只有一处**（`lib/unify/evidence.cjs` 的 `liveLedgerVerdict`）——
  //    包侧 `tools/ask-server.js` 的 judgeLightup 调同一台，两侧不再各写一份分支。
  let liveBroken = null
  if (chs.some((c) => c && c.evidence && c.evidence.min)) {
    const live = readEvidence(path.resolve(root))
    const verdict = liveLedgerVerdict(live, { needsEvidence: true })
    if (verdict.broken) {
      liveBroken = {
        status: verdict.status,
        errorCode: verdict.errorCode || null,
        problems: verdict.problems || [],
        why: verdict.why,
        hint: verdict.hint,
      }
    }
  }
  let achieved = 0
  let total = 0
  for (const c of chs) {
    // ── 证据档（P0-4 戊1b，2026-09-25）：**阻塞**，所以必须排在 needsReview 那条"不阻塞"快路之前 ──
    // 口径：`c.evidence.ok === false` 是探针在快照里算好的（`lib/state.js` 的 judgeChallenges），
    // 回执那句话也**存在快照里**（`c.evidence.hint`）—— 两侧只是转述，不许各写一份（会漂）。
    // T12：台账在快照之后坏掉 / 读不动 / 变空 ⇒ 旧判词作废，按证据不够拦（上面 liveBroken）。
    if (liveBroken && c.evidence && c.evidence.min) {
      evidenceGaps.push({
        no: c.no,
        deliverable: c.deliverable,
        min: c.evidence.min,
        have: c.evidence.have ?? null,
        hint: `第${c.no}题还差一档证据（${liveBroken.why}）—— ${liveBroken.hint}`,
      })
      continue
    }
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
      // T12：台账五态（由 `lib/state.js` 的 judgeChallenges 算好、随快照带过来）。
      // 只用于**回执的修法**：坏账 / 读不动时，"再去贴一条证据"不是修法（写口会拒），
      // 必须先修台账 —— 否则学生按 hint 做却永远过不了。
      // `liveBroken` = 门禁时**现读**发现的坏账 / 读不动 / 空账（快照旧了），优先级更高。
      evidenceStatus: liveBroken ? liveBroken.status : (hit.evidenceStatus ?? null),
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
 * 知识点引用的**规范归属**（U18；U13 实测的跨圈串就修在这里）。
 *
 * 为什么不能只按裸点找（`l.point === point`）：`pack.lessons[]` 只有 `point` 没有圆圈时，
 * `a/x` 与 `b/x` 会被读成同一批课 —— `a/x` 的挑战闸于是可能拿 `b/x` 的判据/证据判。
 * 这里从 **pack 模型**取规范身份：
 *   · 已给 `circle/point` → 就用它；
 *   · 只给裸点 → 从 `pack.points`（声明）与 `lessons[].circle`（课记录）求候选圆圈：
 *     只有**唯一**候选才算得出来；多个候选 = 跨圈同名，**不猜**（`ambiguous`）。
 * 认不出任何圆圈信息（老夹具 / 只给计数的 pack）→ `circle:null`，按既有裸点语义走（零回归）。
 *
 * @param {object} pack `readPack` 的结果（counts 形态也认）
 * @param {string} point 裸点 或 `circle/point`
 * @returns {{circle:string|null, point:string, ambiguous:boolean, candidates:string[]}}
 */
function lessonScope(pack, point) {
  const ref = String(point ?? '')
  const segs = ref.split('/')
  const given = segs.length === 2 && segs[0] && segs[1] ? { circle: segs[0], point: segs[1] } : { circle: null, point: ref }
  const declared = new Set()
  for (const p of (Array.isArray(pack?.points) ? pack.points : [])) {
    if (p && p.id === given.point && typeof p.circle === 'string' && p.circle) declared.add(p.circle)
  }
  const observed = new Set()
  for (const l of (Array.isArray(pack?.lessons) ? pack.lessons : [])) {
    if (!l || l.point !== given.point) continue
    if (typeof l.circle === 'string' && l.circle) observed.add(l.circle)
  }
  if (given.circle) return { circle: given.circle, point: given.point, ambiguous: false, candidates: [given.circle] }
  // ── 候选圆圈 = **声明 ∪ 课记录**（决-2 / 2026-10-20 授权）──
  // 原来这里是 `observed.size ? observed : declared`：只要某个圈有课，就**只**看课记录 ——
  // 于是"只有 a 圈有课"会把裸点**唯一**解析成 a，哪怕 b 圈也声明了同一个点（候选其实有 2 个）。
  // 这就是「候选唯一但错圈」的泄漏：建完 `a/x/0001` 再建 `b/x`，会被 `a/x/0001` 的挑战闸拦下。
  // 现在两处一起算：**只要两圈都有信息就算歧义**（不拿"哪圈有课"去猜）。
  const pool = new Set([...declared, ...observed])
  const candidates = [...pool].sort()
  if (candidates.length > 1) return { circle: null, point: given.point, ambiguous: true, candidates }
  return { circle: candidates.length === 1 ? candidates[0] : null, point: given.point, ambiguous: false, candidates }
}

/**
 * 某知识点**现有的最后一课**（= "上一课"）。
 * 按 number 取最大 —— 与 `pack.lessons` 的编号规则同源（`point/NNNN`）。
 *
 * U18：**按 circle + point 两段一起筛**（见 `lessonScope`）。跨圈同名点算不出唯一归属时
 * 返回 `null`（"不能唯一确定"）—— 调用方**不许**把它当"首课，直接放行"：
 * `challengeGate` 在调它之前先查 `ambiguous`，命中就 fail-closed 报 `ambiguous-point`。
 *
 * @returns {object|null} 课对象（含 id/number/learned），没有课 / 归属不唯一 → null
 */
export function previousLesson(pack, point) {
  const scope = lessonScope(pack, point)
  const all = (pack?.lessons || []).filter((l) => l && l.point === scope.point)
  if (!all.length) return null
  if (scope.ambiguous) return null
  // 有圆圈归属就只留这个圈的课；课记录没带 `circle` 的（老夹具）保持既有语义
  const list = scope.circle ? all.filter((l) => !l.circle || l.circle === scope.circle) : all
  if (!list.length) return null
  return list.slice().sort((a, b) => (a.number || 0) - (b.number || 0))[list.length - 1]
}

/**
 * 这个知识点的**实践区目录**（圈级 ∪ 点级；包根相对，排序去重）。
 * 用来把判据快照里的 `projects[]` 收窄到"这门课真正住的那几个目录"——
 * 跨圈同名点的两份 EXPECT 各自住在自己的圈实践区里，收窄之后就不可能互相顶替。
 * @returns {string[]} 一个都没声明 → 空数组（调用方保持既有全量语义）
 */
function practiceRootsFor(pack, circle, point) {
  const out = new Set()
  const norm = (d) => String(d ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const add = (list) => { for (const d of Array.isArray(list) ? list : []) { const v = norm(d); if (v) out.add(v) } }
  for (const c of (Array.isArray(pack?.circles) ? pack.circles : [])) {
    if (!circle || !c || c.id !== circle) continue
    add(c.practice?.dirs)
  }
  for (const p of (Array.isArray(pack?.points) ? pack.points : [])) {
    if (!p || p.id !== point) continue
    if (circle && p.circle && p.circle !== circle) continue
    add(p.practice?.dirs)
  }
  return [...out].sort()
}

/** 项目目录是不是落在这些实践区之一里（任一方向包含都算：圈级的项目目录可能比点级浅） */
function inRoots(dir, roots) {
  const d = String(dir ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!d || !roots.length) return false
  return roots.some((r) => d === r || d.startsWith(`${r}/`) || r.startsWith(`${d}/`))
}

/**
 * 把快照收窄到这门课的实践区（**只收窄、不猜**）：
 *   · 一个实践区都没声明（老包 / 夹具 / stub pack）→ 原样返回（既有行为，零回归）；
 *   · 收窄后一个项目都不剩 → 原样返回（宁可少收窄，也不制造假的 unknown-lesson）。
 */
function scopeSnapshot(doc, roots) {
  if (!doc || !roots.length) return doc
  const projects = Array.isArray(doc.projects) ? doc.projects : []
  const kept = projects.filter((pr) => pr && inRoots(pr.dir, roots))
  if (!kept.length || kept.length === projects.length) return doc
  return { ...doc, projects: kept }
}

/**
 * 门禁：能不能开这个知识点的**下一课**。
 *
 * 判定顺序（v3 §2.4 的矩阵）：
 *   隶属不唯一（跨圈同名点）        → ambiguous-point（fail-closed；**不猜**用哪一个圈的课）
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
  // ── ① 规范归属（U18）：裸点跨圈同名时**先** fail-closed，绝不拿另一个圈的课判 ──
  const scope = lessonScope(pack, point)
  if (scope.ambiguous) {
    return {
      allowed: false,
      code: 'ambiguous-point',
      lesson: null,
      lessonNumber: null,
      learned: false,
      rejudged: false,
      candidates: scope.candidates,
      error: `知识点 ${scope.point} 在课程包里有 ${scope.candidates.length} 个圆圈都在用（${scope.candidates.join(' / ')}）——`
        + ' 同名点分不出是哪一个，门禁**不猜**（猜错就会拿另一个圈的挑战/证据判这门课）',
      hint: '把知识点写成规范身份 circle/point（或让调用方带上圆圈）再试；判据与证据都按规范课次键分组，跨圈同名不许互相顶替',
      why: '上一课的归属不唯一：放行会把缺证据扩大成通过，所以这里失败关闭',
    }
  }
  const prev = previousLesson(pack, point)
  if (!prev) {
    return { allowed: true, code: 'first-lesson', lesson: null, why: '这个知识点还没有课 —— 首课直接进' }
  }
  const abs = path.resolve(root)
  // 判据快照里可能有两圈的同名课（声明形状一样）→ 先按实践区收窄到这门课
  const roots = practiceRootsFor(pack, scope.circle, scope.point)
  const judge = (doc) => judgeSnapshot(scopeSnapshot(doc, roots), abs, prev.id)

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
    // T12（C02）：若台账本身**坏账 / 读不动**，"再去贴一条"不是修法 —— 写口会拒绝，
    //   所以回执换成"先修台账"（这不是放宽，是让修法指向真能走通的那一步）。
    const evStatus = v.evidenceStatus ?? null
    const ledgerBroken = evStatus === 'invalid' || evStatus === 'io-error'
    return {
      ...base,
      allowed: false,
      evidenceGaps: v.evidenceGaps || [],
      gapText: v.gapText || [],
      achieved: v.achieved || 0,
      total: v.total || 0,
      needsReview: v.needsReview || [],
      evidenceStatus: evStatus,
      error: `上一课《${prev.id}》还有挑战的**证据档不够** —— 还不能新开下一课`,
      hint: ledgerBroken
        ? `证据台账现在是${evStatus === 'invalid' ? '**坏账**（有坏行 / 坏记录）' : '**读不动**（IO 故障）'}：`
          + '这不是"再贴一条证据"能解决的（写口会拒绝）—— 先修好 learning-records/evidence.jsonl，再按回执里点名的那一档补证据'
        : '课页那道题的「贴证据」里补上就行（回执里逐条写了还差哪一档）',
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
