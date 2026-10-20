/**
 * lib/practice.js — 实践区的**数据层（纯）**：把探针算出的挑战完成度变成页面可读的一份数据
 * ------------------------------------------------------------------
 * 为什么是一份"数据文件"而不是接口：课程页是**静态 HTML**（`file://` 也能开），
 * 读不到插件的内存 ⇒ 只能落成 `assets/practice-data.js`（跟 `glossary-data.js` 一个套路）。
 *
 * 三条规矩：
 *   · **不猜**：没声明 `challenges` 的课，这里**不产出**它的完成度（页面那边就不显示）
 *   · **不给百分比**：只给 `{achieved, total, needsReview}` 三个数
 *   · **确定性**：不含时间戳；同样的 state → 逐字节相同的文件（可对拍、可判漂移）
 *
 * ## 身份口径（2026-10-20 独立审查后修）
 *
 * 运行数据的**主键是规范课次身份 `circle/point/NNNN`**（U-SPEC §2）。旧实现的正则
 * `/^[^/]+\/\d{4}$/` 只认**两段**，于是包侧 `readPack()` 已经输出的三段键被**全部滤掉** ——
 * `byFile` 永远是空的；而 state 快照里如果已经是三段键，则 `lessons` 也一起变空（静默丢数据）。
 *
 * 现在：
 *   · 规范形状（三段）→ 严格内核 `parseLessonKey` 校验后直接用；
 *   · 声明形状（`EXPECT.json` 的两段 `point/NNNN`，`authorization.json` C6 明确保留）→
 *     经 `lib/state.js` 的 `lessonEvidenceKeys(pack)` **在圆圈 / 项目目录上下文里**解析成规范键
 *     （与「证据台账该用哪个键」是同一个桥，不是第二份解析器）；
 *   · 解析不出来（缺上下文 / 跨圈歧义 / 形状不认识）→ **不猜、也不静默丢**：向调用方报一条
 *     冲突（工具层渲染成警告），这一行不产出。
 *
 * 主键换了名字（`keyScheme: 'lesson-key'`，version 3）：旧数据文件里的两段键**不能**再被
 * 当成同一身份，页面会明确提示"旧格式，重新生成"，而不是静默按课号串课。
 */
import { createRequire } from 'node:module'
import { lessonEvidenceKeys } from './state.js'

const requireCJS = createRequire(import.meta.url)
/** 身份内核（U02 唯一实现）：构造与解析都只有这一份，本文件不另写正则 */
const identity = requireCJS('./unify/identity.cjs')

/**
 * 课 id → 实践区的键（**只认规范课次身份** `circle/point/NNNN`）。
 *
 * 历史：以前只取末尾数字（`/\/(\d+)$/`），`spring-boot/0001` 与 `alge/0001` 都是键 `1`，
 * 两个圈的第 1 课**静默互相覆盖**；2026-09-24 改成"键就是课 id"，但正则仍只认两段，
 * 于是包侧输出的三段键全被滤掉（2026-10-20 审查实测：`byFile` 恒空）。
 *
 * 现在只做一件事：**严格**判它是不是规范课次键。是 → 原样返回；不是 → `null`（不猜）。
 * 两段的声明形状**不走这里**（它需要圆圈上下文，见 `buildPracticeData`）。
 *
 * @param {string} id 规范课次键（`circle/point/NNNN`）
 * @returns {string|null}
 */
export function practiceKeyFromLessonId(id) {
  const parsed = identity.parseLessonKey(String(id == null ? '' : id))
  return parsed.ok ? String(id) : null
}

/**
 * 一条「快照里的课」→ 规范课次键（带上下文）。
 *
 * 顺序即契约：
 *   ① 已经是规范形状 → 严格解析通过就原样用（不重建，逐字节保持）；
 *   ② 否则按**声明形状**解析：圆圈从 `pack` 的知识点归属 + **项目目录**上下文里定
 *      （`lessonEvidenceKeys(pack)`，与证据台账同一座桥）；
 *   ③ 都定不下来 → 不猜：把原因交回去（调用方负责报出来）。
 *
 * @param {string} id 课次 id（规范三段 / 声明两段）
 * @param {string} projectDir 该课所属项目目录（包根相对，实践区归属）
 * @param {(declaredId: string, projectDir?: string) => object} resolveKey 声明域 → 规范键的桥
 * @returns {{key: string}|{key: null, why: string}}
 */
function resolvePracticeKey(id, projectDir, resolveKey) {
  const raw = String(id == null ? '' : id).trim()
  if (!raw) return { key: null, why: '课次 id 是空的' }
  const parsed = identity.parseLessonKey(raw)
  if (parsed.ok) return { key: raw }
  const r = resolveKey(raw, projectDir)
  if (r && r.canonical) return { key: r.canonical }
  if (r && r.ambiguous) {
    return { key: null, why: `课次 ${JSON.stringify(raw)} 跨圈同名，分不出是哪一门（候选：${(r.ambiguity || []).join(' / ')}）—— 不猜` }
  }
  return { key: null, why: `课次 ${JSON.stringify(raw)} 解析不出规范身份（不是 circle/point/NNNN，本包也给不出圆圈归属）—— 不猜` }
}

/**
 * 把一条兜底键冲突渲染成人话（工具层直接拿去当 warning —— 文案只有这一份）。
 * @param {{base:string, files:string[], keys:string[]}} c
 */
export function describeConflict(c) {
  return `文件名兜底键有歧义：${c.base} 同时属于 ${c.files.join(' 与 ')}（${c.keys.join(' / ')}）——`
    + ' 已**丢弃**这条兜底键（页面主查课 id、次查整路径，不受影响）；'
    + '要修就改名其中一个课程页文件（否则按文件名兜底会拿到别的课的实践区）'
}

/**
 * @param {{state: object, pack: object}} input
 * @returns {{version:number, source:string, lessons:object, byFile:object}}
 */
/**
 * @param {{state: object, pack: object, conflicts?: object[]}} input
 *   `conflicts` 是**调用方给的收集器**（可选）：兜底键有歧义时往里塞一条，工具层把它渲染成警告。
 *   不给也不影响行为（照样不猜），只是没人可报。
 * @returns {{version:number, source:string, lessons:object, byFile:object}}
 */
export function buildPracticeData({ state, pack, conflicts } = {}) {
  const lessons = {}
  const fileToKey = {}
  /** 报一条"这一行没产出"的冲突（不静默丢行）；调用方没给收集器时只是不报，行为不变 */
  const report = (why, extra) => {
    if (Array.isArray(conflicts)) conflicts.push({ kind: 'identity', why, ...extra })
  }
  // 声明形状（`point/NNNN`）→ 规范键的**唯一**桥：与证据台账同一份实现（lib/state.js）
  const resolveKey = lessonEvidenceKeys(pack)

  // 课 id → 源文件名（页面知道自己被构建成哪个文件，给一条兜底查法）
  for (const l of pack?.lessons || []) {
    const r = resolvePracticeKey(l.id, '', resolveKey)
    if (!r.key) { report(r.why, { id: String(l.id == null ? '' : l.id), from: 'pack.lessons' }); continue }
    if (l.file) fileToKey[String(l.file)] = r.key
  }
  // 兜底键再补一份**纯文件名**：分层布局下 l.file 是 programming/spring-boot/0001-*.html，
  // 而课程页里 practice.js 的兜底只拿 data-ask-page 的 basename —— 不补这一份，
  // 实践区在分层后就会**静默整块不显示**（2026-09-21 实测：页面看着没事，就是没有实践区）。
  //
  // ⚠️ 2026-09-25 补的一条（P1-11「序号/位置对位」）：兜底键**只在不含糊时**才写。
  //    两个**不同的课**共用同一个文件名时，页面按文件名兜底会拿到**别的课**的实践区
  //    （主查法是课 id、次查法是整路径，文件名是最后一道兜底）—— 那是**静默错位**。
  //    这种含糊一律**不猜**：丢掉这条兜底键，并把冲突报给调用方（不许静默）。
  const alias = new Map()      // base → { key, from }
  const blocked = new Set()    // 有歧义的文件名：一律不写兜底键
  for (const [rel, key] of Object.entries(fileToKey)) {
    const base = rel.split('/').pop()
    if (!base || base in fileToKey || blocked.has(base)) continue
    const prev = alias.get(base)
    if (prev && prev.key !== key) {
      alias.delete(base)
      blocked.add(base)
      if (Array.isArray(conflicts)) conflicts.push({ base, keys: [prev.key, key], files: [prev.from, rel] })
      continue
    }
    if (!prev) alias.set(base, { key, from: rel })
  }
  for (const [base, e] of alias) fileToKey[base] = e.key

  for (const p of state?.projects || []) {
    for (const l of p.lessons || []) {
      if (!l.challengeSummary) continue // 未声明判据 → 不产出（不猜）
      const r = resolvePracticeKey(l.id, p?.dir || '', resolveKey)
      if (!r.key) { report(r.why, { id: String(l.id == null ? '' : l.id), from: 'state.projects', dir: p?.dir || '' }); continue }
      const key = r.key
      lessons[key] = {
        // `id` 也必须是**规范身份**：页面 / 别的读点拿它当键使，写两段就会与主键自相矛盾
        id: key,
        title: l.title || '',
        // 这一课的判据写在哪个文件（按圈实践区之后不再是一个固定路径，页面脚注照它显示）
        expect: p.expect?.path || null,
        summary: {
          achieved: l.challengeSummary.achieved,
          total: l.challengeSummary.total,
          needsReview: l.challengeSummary.needsReview,
        },
        // 证据档（P0-4 戊1b）：页面上的「贴证据」小表单要靠这几项
        //   · `evidenceFallback` —— 台账还没建立、这一档**没判**（页面必须说出来，不许静默变松）
        //   · 每道题的 `evidence` —— 要求哪一档 / 现在最强的一档 / 够没够
        evidenceFallback: l.evidenceFallback === true,
        challenges: (l.challenges || []).map((c) => {
          const ev = c.evidence
            ? { min: c.evidence.min, have: c.evidence.have, ok: c.evidence.ok, hint: c.evidence.hint || '' }
            : null
          const base = { no: c.no, hint: c.hint || '', deliverable: c.deliverable || '', ...(ev ? { evidence: ev } : {}) }
          // ⚠️ 证据不够是**单独一态**（`evidence`），不许并进 `todo`：
          //    它的修法不是"再写代码"，而是"贴一条够档的证据" —— 混进 todo 会让学生去改代码。
          if (ev && ev.ok === false) return { ...base, state: 'evidence', missing: [ev.hint] }
          if (c.needsReview) return { ...base, state: 'review', why: c.hint || '' }
          return { ...base, state: c.done ? 'done' : 'todo', missing: (c.missing || []).map((m) => m.hint || m.id) }
        }),
      }
    }
  }

  // 键是规范课次键（`circle/point/NNNN`）：先按课号、同号再按点 id —— 确定性，且看起来还是课次顺序
  const order = (k) => {
    const m = /^(.+)\/(\d{4})$/.exec(k)
    return m ? [Number(m[2]), m[1]] : [Number.MAX_SAFE_INTEGER, k]
  }
  const sortedLessons = {}
  for (const k of Object.keys(lessons).sort((a, b) => {
    const [na, pa] = order(a)
    const [nb, pb] = order(b)
    return na !== nb ? na - nb : pa < pb ? -1 : pa > pb ? 1 : 0
  })) {
    sortedLessons[k] = lessons[k]
  }
  const sortedFiles = {}
  for (const k of Object.keys(fileToKey).sort()) sortedFiles[k] = fileToKey[k]

  return {
    // version 3 = 键是**规范课次身份** `circle/point/NNNN`（version 2 是两段课 id，
    // 而它恰恰是"包侧输出三段、正则只认两段"那个缺口的成因；旧数据文件要重新生成）
    version: 3,
    keyScheme: 'lesson-key',
    source: 'learning-records/state.json',
    lessons: sortedLessons,
    byFile: sortedFiles,
  }
}

/** 渲染成 `assets/practice-data.js` 的源码（UMD 双出口，与 glossary-data.js 同样的形状） */
export function renderPracticeDataModule(data) {
  return [
    '/**',
    ' * practice-data.js — 课程页「实践区」的数据源（**由插件 `whale_practice` 生成**）',
    ' * ------------------------------------------------------------------',
    ' * 数据来自学生工作区的**静态事实**（探针扫出来的），插件不执行学生代码。',
    ' * 手改会在下次生成时被覆盖；要改判据请改**该项目实践区里的** EXPECT.json',
    ' * （按圈声明实践区之后它不是一个固定路径 —— 每条 lesson 的 `expect` 字段写着它在哪）。',
    ' * 本文件**不含时间戳** —— 同样的工作区会产出逐字节相同的这份文件（可对拍、可判漂移）。',
    ' */',
    '(function (root, factory) {',
    "  if (typeof module === 'object' && module.exports) {",
    '    module.exports = factory();',
    '  } else {',
    '    root.PRACTICE_DATA = factory();',
    '  }',
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {",
    '  return ' + JSON.stringify(data, null, 2) + ';',
    '});',
    '',
  ].join('\n')
}

/** 给人看的摘要 */
export function summarizePractice(data) {
  const lines = []
  for (const k of Object.keys(data.lessons || {})) {
    const d = data.lessons[k]
    const s = d.summary
    // 键是课 id（`point/NNNN`）—— 直接印出来，跨圈同名课号也不会混
    lines.push(`${d.id || k} ${d.title}：达成 ${s.achieved} / 共 ${s.total}${s.needsReview ? `（另有 ${s.needsReview} 项需人工确认）` : ''}`)
    for (const c of d.challenges) {
      lines.push(`  第${c.no}题 产出：${c.deliverable || c.hint || '（未写）'} —— ${c.state === 'done' ? '已达成' : c.state === 'todo' ? '未达成' : '需人工确认'}${c.missing?.length ? ' → ' + c.missing.join('；') : ''}`)
    }
  }
  return lines.length ? lines : ['（没有任何课声明了挑战判据 —— 不产出完成度）']
}
