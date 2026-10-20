/**
 * lib/unify/evidence.cjs —— 证据档位与「够不够档」判定的**唯一实现**（U18）
 * ==================================================================
 * 为什么要有这个内核（U-SPEC §3「领域归并保持：目标现行版本、证据最高档、队列既有生命周期；
 * missing 的原业务回退不扩大」）：
 *   证据档位这件事今天住在**三处**（`lib/evidence.js` 的纯层、`lib/state.js` 的
 *   `judgeChallenges`、`lib/gate.js` 的 `judgeSnapshot`，外加包侧 `tools/ask-server.js` 的
 *   `judgeLightup` 再抄一遍分支）—— 同一件事四份口径，一漂就是"插件放行、包侧拦住"。
 *   本文件把**取最高档**、**五态**、**缺证据失败关闭**、**门禁现读复核**收成一份；
 *   上面四个落点只做适配/委托（导出面、参数、默认值、返回形状逐字保持）。
 *
 * 三条锁死的语义（改之前先读 `lib/evidence.js` 的文件头与 `cards/U18.md`）：
 *   ① **取最高档**（run > test > explain > verbal），不是"最新一条"：同一道题先口头、
 *      后来补上运行结果 → 台账不需要顺序，`date` 只服务学生自己看得见。
 *   ② **缺失证据失败关闭**：只有 `missing`（真 ENOENT）可以走**既有的**防死锁回退，
 *      且必须 `evidenceFallback:true` 说出来；`empty` / `invalid` / `io-error` 一律阻断。
 *   ③ **不把缺证据扩大成通过**：本文件只收紧、不放宽；`minEvidence` 没声明的题一道都不变。
 *
 * 纯：**一个 fs 都没有**。`lib/state.js` 是纯层（"不读 env / 时钟 / 随机数 / DOM"），
 * 它 import 的适配层 `lib/evidence.js` 也只 import 本文件 —— 读盘一律在
 * `lib/evidence-io.js` / `lib/state-scan.js` / 包侧 `tools/ask-server.js`。
 */
'use strict'

/**
 * 证据档位，**强 → 弱**（顺序即契约：判据、回执、UI 都按它排）。
 * 每一档都带上人话与"怎么补"——回执要能说清"还差哪一档"。
 */
const EVIDENCE_KINDS = Object.freeze(['run', 'test', 'explain', 'verbal'])

/** 强度值：run 4 > test 3 > explain 2 > verbal 1（`EVIDENCE_KINDS` 的下标反过来就是它） */
const EVIDENCE_RANK = Object.freeze(
  Object.fromEntries(EVIDENCE_KINDS.map((k, i) => [k, EVIDENCE_KINDS.length - i])),
)

/** 键序钉死：EvidenceRecord */
const EVIDENCE_KEYS = Object.freeze(['date', 'lesson', 'challenge', 'kind', 'ref', 'note'])

/** 每一档的人话（判据与回执共用一份 —— 不许在别处再写一遍这几个词） */
const EVIDENCE_LABEL = Object.freeze({
  run: '运行结果（真的跑起来 / 跑过的输出）',
  test: '学生自己写的测试（测试代码与它的输出）',
  explain: '解释能力（把为什么讲清楚）',
  verbal: '口头确认（只说了「我做完了」）',
})

/** 单条证据的正文上限 —— 与笔记台账同阈值同单位（**字节**，中文一字 3 字节） */
const EVIDENCE_MAX_BYTES = 16 * 1024

/**
 * 课次身份的**两种合法形状**（`docs/unify/interfaces.md` §2 / U-SPEC §2）：
 *   · 声明形状 `point/NNNN` —— `EXPECT.json` 的 `lessons[].id` 本轮仍是它（`authorization.json`
 *     的 `derivedConsequences.C6` 登记过：统一到 3 段要新授权）；
 *   · 规范形状 `circle/point/NNNN` —— 运行态内核（`lib/unify/identity.cjs`）构造的唯一身份。
 * 证据台账 `learning-records/evidence.jsonl` 的 `lesson` 字段**两种都收**：
 *   收 2 段是为了不打断既有台账（零回归）；收 3 段是因为跨圈同名点只有它能不串
 *   （U13 实测：`a/x` 与 `b/x` 的 2 段写法完全同形，光看台账分不出是谁的）。
 * 判定时**规范形状优先**：见 `lessonAliases()` 与 `judgeRequirement()` 里的歧义分支。
 */
const LESSON_ID_RE = /^[A-Za-z0-9._-]+\/\d{4}$/
const CANONICAL_LESSON_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\d{4}$/

/**
 * 证据台账的五态（`readEvidence().status`）—— 顺序即契约。
 * **只有 `missing`（真 ENOENT）可以走防死锁回退**；其余四态都不许静默跳过证据要求。
 */
const LEDGER_STATUSES = Object.freeze(['missing', 'empty', 'ok', 'invalid', 'io-error'])

/** 唯一允许回退的态（既有业务策略，**不扩大**：多一个态进来就是放宽） */
const FALLBACK_STATUS = 'missing'

const bad = (where, msg) => new Error(`证据台账/${where}：${msg}`)

/* ══════════════════════════════════════════════════════════════════════
 * 一、课次身份：解析 / 别名（**不新增同义公开 API** —— 这只是本内核的内部形状）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 解析一个课次 id 字面量（**只看形状，不查课程包**）。
 * @param {string} value
 * @returns {{circle:string|null, point:string, number:string}|null} 形状不认识 → null
 */
function parseLessonId(value) {
  if (typeof value !== 'string' || !value) return null
  if (CANONICAL_LESSON_ID_RE.test(value)) {
    const [circle, point, number] = value.split('/')
    return { circle, point, number }
  }
  if (LESSON_ID_RE.test(value)) {
    const [point, number] = value.split('/')
    return { circle: null, point, number }
  }
  return null
}

/**
 * 两个课次 id 字面量**是不是同一门课**（跨形状容忍，见 C6）。
 * 规则：`point` + `number` 必须一致；两侧都带圆圈时圆圈也必须一致；
 * 一侧只有声明形状（没有圆圈）→ 按点 + 号对位（这就是 EXPECT 的声明形状）。
 */
function sameLesson(a, b) {
  if (a === b) return true
  const pa = parseLessonId(a)
  const pb = parseLessonId(b)
  if (!pa || !pb) return false
  if (pa.point !== pb.point || pa.number !== pb.number) return false
  if (pa.circle !== null && pb.circle !== null) return pa.circle === pb.circle
  return true
}

/**
 * 同一门课**可接受的台账键**（规范形状在前）。
 *
 * `bare` 什么时候才收：该 `point/NNNN` 在课程包里**只有唯一归属**（一个圆圈）时才收 ——
 * 跨圈同名点收 2 段就等于让 `a/x` 的证据记到 `b/x` 头上（U13 实测的那条串）。
 *
 * @param {{circle?:string|null, point:string, number:number|string}} id
 * @param {{bareUnique?:boolean}} [opts] `bareUnique:false` = 2 段写法有歧义，不许用它入账
 * @returns {string[]} 至少一项（规范形状；`bareUnique!==false` 时再加 2 段）
 */
function lessonAliases(id, opts = {}) {
  const point = String(id && id.point)
  const number = String(id && id.number)
  const out = []
  const circle = id && id.circle != null && String(id.circle) ? String(id.circle) : null
  if (circle) out.push(`${circle}/${point}/${number}`)
  if (opts.bareUnique !== false) out.push(`${point}/${number}`)
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、记录校验（键序钉死）+ 取最高档
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 校验 + 归一化成**键序钉死**的 EvidenceRecord（纯函数；IO 层与读侧共用这一份）。
 * 读侧也用它：不合规的进 problems，**不进 entries**（不静默收脏数据）。
 * @param {object} x
 * @param {string} [where]
 */
function validateEvidence(x, where = 'EvidenceRecord') {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(where, '记录必须是对象')

  const lesson = String(x.lesson ?? '').trim()
  if (!lesson) throw bad(where, '缺 lesson（这条证据是哪门课的）')
  // 两种合法形状：声明形状 `point/NNNN`（既有台账零回归）与规范形状 `circle/point/NNNN`
  if (!LESSON_ID_RE.test(lesson) && !CANONICAL_LESSON_ID_RE.test(lesson)) {
    throw bad(
      where,
      `lesson 必须是「知识点/NNNN」或「圆圈/知识点/NNNN」形态（例 spring-boot/0001），实得 ${JSON.stringify(x.lesson)}`,
    )
  }
  const challenge = Number(x.challenge)
  if (!Number.isSafeInteger(challenge) || challenge <= 0) {
    throw bad(where, `challenge 必须是正整数序号（对应课程里第几道挑战），实得 ${JSON.stringify(x.challenge)}`)
  }
  const kind = String(x.kind ?? '').trim()
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw bad(where, `kind 不认识：${JSON.stringify(x.kind)}（可用：${EVIDENCE_KINDS.join(' / ')}，强→弱）`)
  }
  // `date` 可选，**给了就必须是真日期**，绝不默认"今天"（笔记台账的同一条例外）
  const date = x.date === undefined || x.date === null || x.date === '' ? null : String(x.date).trim()
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw bad(where, 'date 给就必须是 YYYY-MM-DD（不许默认「今天」）')
  }
  const ref = x.ref === undefined || x.ref === null || x.ref === '' ? null : String(x.ref).trim()
  const note = x.note === undefined || x.note === null || x.note === '' ? null : String(x.note)
  if (note !== null && Buffer.byteLength(note, 'utf8') > EVIDENCE_MAX_BYTES) {
    throw bad(where, `note 太长（上限 ${EVIDENCE_MAX_BYTES} 字节）`)
  }
  for (const k of Object.keys(x)) {
    if (!EVIDENCE_KEYS.includes(k)) throw bad(where, `多余键 ${JSON.stringify(k)}（schema 里没有这个字段，不静默丢）`)
  }
  return { date, lesson, challenge, kind, ref, note }
}

/** 台账键的接受表：字符串 → [字符串]；数组 → 去重去空；null/undefined → [] */
function acceptedKeys(lessons) {
  const list = Array.isArray(lessons) ? lessons : [lessons]
  const out = []
  for (const raw of list) {
    if (raw === null || raw === undefined) continue
    const s = String(raw)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 某道题**最强的那条证据**（判定层的唯一取法）。
 *
 * `lessons` 可以是**一组**可接受的台账键（规范形状 + 无歧义时再加声明形状）——
 * 这就是跨圈同名点不串的实现点：不接受的那一门课的证据，一条都不算数。
 *
 * @param {object[]} entries `readEvidence().entries`
 * @param {string|string[]} lessons 可接受台账键（见 `lessonAliases`）
 * @param {number} challenge
 * @returns {{kind:string, rank:number, date:string|null, ref:string|null, lesson:string}|null} 没有 = null
 */
function bestEvidence(entries, lessons, challenge) {
  const keys = acceptedKeys(lessons)
  if (!keys.length) return null
  let best = null
  for (const e of entries || []) {
    if (!e || e.challenge !== challenge) continue
    if (!keys.includes(String(e.lesson))) continue
    const rank = EVIDENCE_RANK[e.kind] || 0
    if (!best || rank > best.rank) {
      best = { kind: e.kind, rank, date: e.date ?? null, ref: e.ref ?? null, lesson: String(e.lesson) }
    }
  }
  return best
}

/**
 * 这道题**够不够档**。
 *
 * ⚠️ 取的是**最高档**，不是"最新一条"：同一道题可以先口头、后来补上运行结果 ——
 *    台账因此**不需要顺序**，`date` 只服务于"学生自己看得见"。
 *
 * @param {object[]} entries
 * @param {string|string[]} lessons 可接受台账键
 * @param {number} challenge
 * @param {string} min 要求的最低档（`EVIDENCE_KINDS` 之一）
 * @returns {{ ok:boolean, min:string, have:string|null, haveRank:number, needRank:number,
 *   missing:string[], best:object|null }}
 *   `missing` = 比 `min` **更强或相等**的档位（按强→弱排）—— 回执里说"补这几档里任意一档都行"
 */
function meetsEvidence(entries, lessons, challenge, min) {
  const needRank = EVIDENCE_RANK[min] || 0
  const best = bestEvidence(entries, lessons, challenge)
  const haveRank = best ? best.rank : 0
  return {
    ok: haveRank >= needRank,
    min,
    have: best ? best.kind : null,
    haveRank,
    needRank,
    missing: EVIDENCE_KINDS.filter((k) => EVIDENCE_RANK[k] >= needRank),
    best,
  }
}

/** 回执用的一句话：「这项还差一档证据：贴出你的运行结果」 */
function evidenceHint(lesson, challenge, m) {
  if (!m) return ''
  const need = EVIDENCE_KINDS.filter((k) => EVIDENCE_RANK[k] >= m.needRank).map((k) => EVIDENCE_LABEL[k])
  const have = m.have ? `现在只有「${EVIDENCE_LABEL[m.have]}」` : '还没有贴过证据'
  return `第${challenge}题还差一档证据（${have}）：补上 ${need.join(' 或 ')} 任意一档 —— 课页那道题的「贴证据」里贴上就行`
}

/** "够档的几档"的人话（阻断回执用；与 `evidenceHint` 同一套标签，不另写一份） */
function requiredEvidenceText(min) {
  const needRank = EVIDENCE_RANK[min] || 0
  return EVIDENCE_KINDS.filter((k) => EVIDENCE_RANK[k] >= needRank).map((k) => EVIDENCE_LABEL[k]).join(' 或 ')
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、台账五态（**唯一**归一实现）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 台账对象 → 五态（**兼容旧字段**：只给 `{exists, entries, problems}` 的调用方）。
 *   · 新读法（`lib/evidence-io.js`）直接给 `status`，走第一分支；
 *   · 旧读法：`exists:false` → missing；`problems` 非空 → invalid；
 *     `entries` 非空 → ok；`exists:true` 且零条 → empty。
 * @param {object|null|undefined} ledger
 * @returns {'missing'|'empty'|'ok'|'invalid'|'io-error'}
 */
function ledgerStatusOf(ledger) {
  if (!ledger) return 'missing'
  if (typeof ledger.status === 'string' && LEDGER_STATUSES.includes(ledger.status)) return ledger.status
  if (ledger.exists === false) return 'missing'
  if (ledger.exists !== true) return 'missing'
  if (Array.isArray(ledger.problems) && ledger.problems.length) return 'invalid'
  if (Array.isArray(ledger.entries) && ledger.entries.length) return 'ok'
  return 'empty'
}

/** 台账是否**读不出可信证据**（坏账 / 读不动）—— 决定回执该说"修台账"还是"再贴一条" */
function isBrokenStatus(status) {
  return status === 'invalid' || status === 'io-error'
}

/** 阻断面的一句话（坏账 / 读不动共用；`empty` 不是坏账，另有措辞） */
function brokenWhyText(status, detail = {}) {
  const problems = Array.isArray(detail.problems) ? detail.problems : []
  const errorCode = detail.errorCode || 'IO_ERROR'
  if (status === 'invalid') {
    return `证据台账**损坏**（${problems.length || 1} 处坏记录${problems[0] ? `，例：${problems[0]}` : ''}）`
  }
  if (status === 'io-error') return `证据台账**读不动**（${errorCode}）`
  return ''
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、单条挑战的证据判定（`lib/state.js` 的快照判定与包侧两侧共用）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 一道题的证据判定 —— **单一实现**。
 *
 * 返回的 `evidence` 就是落进快照 `challenges[].evidence` 的那个对象（形状逐字保持）：
 * `{min, have, haveRank, needRank, ok, hint, status, errorCode?}`；走回退 / 不分档时是 `null`。
 *
 * `blocked:true` 表示**必须阻断**（"缺证据不扩大成通过"的那一半）；`fallback:true` 表示
 * 台账真的不存在、按既有策略回退到机械对账（且必须被 `evidenceFallback` 说出来）。
 *
 * @param {{status?:string, exists?:boolean, entries?:object[], problems?:string[], errorCode?:string}|null} ledger
 * @param {{lessons:string|string[], challenge:number, min:string, ambiguous?:boolean, ambiguity?:string[]}} spec
 */
function judgeRequirement(ledger, spec) {
  const status = ledgerStatusOf(ledger)
  const min = String(spec.min)
  const no = Number(spec.challenge)
  const entries = Array.isArray(ledger && ledger.entries) ? ledger.entries : []
  const keys = acceptedKeys(spec.lessons)

  // ① 台账**真的不存在**（只有 ENOENT）→ 走既有防死锁回退，但必须说出来
  if (status === FALLBACK_STATUS) {
    return { status, blocked: false, fallback: true, ok: true, evidence: null, no, min }
  }
  // ② invalid / io-error：读不出可信证据 —— 明说"不是没贴过"，并阻断
  //    （排在"歧义"之前：台账本身坏了时，先修台账才是修法 —— 让人先改课次写法是错的指路）
  if (isBrokenStatus(status)) {
    const need = requiredEvidenceText(min)
    const why = brokenWhyText(status, ledger)
    const line = status === 'invalid'
      ? `第${no}题还差一档证据（${why}）—— 读不出可信证据，**不能当作"没贴过"跳过**；先修好 learning-records/evidence.jsonl，再补 ${need} 任意一档`
      : `第${no}题还差一档证据（${why}）—— 这是**读取故障**，不是"没贴过证据"；修好前不能跳过证据要求（仍要求 ${need} 任意一档）`
    return {
      status, blocked: true, fallback: false, ok: false,
      have: null, haveRank: 0, needRank: EVIDENCE_RANK[min] || 0,
      no, min,
      hint: line,
      errorCode: status === 'io-error' ? (ledger && ledger.errorCode) || 'IO_ERROR' : undefined,
      evidence: {
        min, have: null, haveRank: 0, needRank: EVIDENCE_RANK[min] || 0, ok: false, hint: line, status,
        ...(status === 'io-error' ? { errorCode: (ledger && ledger.errorCode) || 'IO_ERROR' } : {}),
      },
      gap: { no, deliverable: spec.deliverable, min, have: null, hint: line, status },
    }
  }
  // ③ 跨圈同名点：2 段台账键无歧义才许用；两个圈都有 → **不猜**，按"读不出可信证据"阻断
  if (spec.ambiguous === true) {
    const cands = Array.isArray(spec.ambiguity) ? spec.ambiguity : []
    const line = `第${no}题还差一档证据（台账里这类课次的归属有 ${cands.length || 2} 个候选：${cands.join(' / ') || '跨圈同名'}）`
      + ' —— 2 段写法（point/NNNN）在这里分不出是哪个圈，**不猜**；把证据的 lesson 写成规范课次键 circle/point/NNNN 再贴'
    return {
      status, blocked: true, fallback: false, ok: false,
      have: null, haveRank: 0, needRank: EVIDENCE_RANK[min] || 0,
      no, min,
      hint: line,
      evidence: { min, have: null, haveRank: 0, needRank: EVIDENCE_RANK[min] || 0, ok: false, hint: line, status },
      gap: { no, deliverable: spec.deliverable, min, have: null, hint: line, status },
    }
  }
  // ④ 读得到台账、但调用方没说这是哪门课 —— 无法按课次分组，**不猜**（fail-closed）
  if (!keys.length) {
    const line = `第${no}题：不知道这是哪门课（调用方没给可用的课次键）—— 证据按课次 id 分组，不猜；先修调用方`
    return {
      status, blocked: true, fallback: false, ok: false,
      have: null, haveRank: 0, needRank: EVIDENCE_RANK[min] || 0,
      no, min, hint: line,
      evidence: { min, have: null, haveRank: 0, needRank: EVIDENCE_RANK[min] || 0, ok: false, hint: line, status },
      gap: { no, deliverable: spec.deliverable, min, have: null, hint: line, status },
    }
  }
  // ⑤ empty / ok：正常判（最高档）
  const m = meetsEvidence(entries, keys, no, min)
  // ⚠️ 只有**不够**的时候才带"还差一档"那句话：够档的题带一句话会让回执自相矛盾
  //    （"已达成"旁边挂一句"还差一档证据"）。空账（empty）**明确说出来**。
  const line = m.ok
    ? ''
    : evidenceHint(keys[0], no, m)
      + (status === 'empty' ? '（台账存在但一条有效记录都没有 —— 空账是明确不足，不是"没有台账"）' : '')
  const evidence = {
    min, have: m.have, haveRank: m.haveRank, needRank: m.needRank, ok: m.ok, hint: line, status,
  }
  if (m.ok) return { status, blocked: false, fallback: false, ok: true, ...m, no, min, hint: '', evidence, gap: null }
  return {
    status, blocked: true, fallback: false, ok: false, ...m, no, min, hint: line, evidence,
    gap: { no, deliverable: spec.deliverable, min, have: m.have, hint: line, status },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、门禁的**现读复核**（`lib/gate.js` 与包侧 `judgeLightup` 共用）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 门禁 / 点亮时**现读一次**台账的判定（T12 的 C02）：快照里的 `challenges[].evidence`
 * 可能是**旧判词** —— 证据台账不在 `sourceDigest` 里（那个指纹只算学生代码树），
 * 所以台账在快照之后坏掉 / 读不动 / 变空时，"证据够档"那句判词就不可信了。
 *
 * 这里把"哪些态算不可信"收成**唯一**一处：`invalid` / `io-error` / `empty`。
 * `missing` 不在此列（防死锁回退是既定策略，且判据快照的夹具可以合法地没有台账）——
 * 这一条**不许**为了少写代码把 `missing` 也算进来（那是把缺证据扩大成通过的反面：
 * 把"没有台账"当"台账坏了"会让新包第一课永远点不亮）。
 *
 * @param {object|null} ledger `readEvidence()` 的结果（现读）
 * @param {{needsEvidence?:boolean}} [opts] 有题声明了 `minEvidence` 才需要复核
 * @returns {{broken:boolean, status:string, why:string, hint:string, errorCode:string|null, problems:string[]}}
 */
function liveLedgerVerdict(ledger, opts = {}) {
  if (opts.needsEvidence !== true) {
    return { broken: false, status: ledgerStatusOf(ledger), why: '', hint: '', errorCode: null, problems: [] }
  }
  const status = ledgerStatusOf(ledger)
  const problems = Array.isArray(ledger && ledger.problems) ? ledger.problems : []
  const errorCode = (ledger && ledger.errorCode) || null
  if (!isBrokenStatus(status) && status !== 'empty') {
    return { broken: false, status, why: '', hint: '', errorCode, problems }
  }
  const why = status === 'empty' ? '证据台账是**空账**（存在但零条）' : brokenWhyText(status, { problems, errorCode })
  const hint = `快照里的证据判词已不可信（证据台账不在 sourceDigest 里）；先修好 learning-records/evidence.jsonl 再补`
  return { broken: true, status, why, hint, errorCode, problems }
}

/* ══════════════════════════════════════════════════════════════════════
 * 六、导出（U18 之后：证据档位、五态、缺证据失败关闭都只认这一份）
 * ══════════════════════════════════════════════════════════════════════ */

module.exports = Object.freeze({
  // 词表 / 常量
  EVIDENCE_KINDS,
  EVIDENCE_RANK,
  EVIDENCE_KEYS,
  EVIDENCE_LABEL,
  EVIDENCE_MAX_BYTES,
  LESSON_ID_RE,
  CANONICAL_LESSON_ID_RE,
  LEDGER_STATUSES,
  FALLBACK_STATUS,
  // 记录与档位
  validateEvidence,
  acceptedKeys,
  bestEvidence,
  meetsEvidence,
  evidenceHint,
  requiredEvidenceText,
  // 身份（内部形状，不新增同义公开 API）
  parseLessonId,
  sameLesson,
  lessonAliases,
  // 五态与失败关闭
  ledgerStatusOf,
  isBrokenStatus,
  brokenWhyText,
  judgeRequirement,
  liveLedgerVerdict,
})
