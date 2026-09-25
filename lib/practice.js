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
 */

/**
 * 课 id（`spring-boot/0001`）→ 实践区的键。
 *
 * **键就是课 id 本身**（2026-09-24 D2-a 改）。以前只取末尾的数字（`/\/(\d+)$/`），
 * 于是 `spring-boot/0001` 与 `alge/0001` **都是键 `1`** —— 两个圈的第 1 课在实践区里
 * **静默互相覆盖**（后写的赢），页面按课号查就会串课。课 id 全局唯一（point id 唯一），
 * 直接拿它当键，两个圈各有 `0001` 也不撞；而且课程页里本来就写着它
 * （`<details class="adjust" data-lesson="spring-boot/0001">`），主查法不用再换算。
 *
 * @param {string} id 课 id（`point/NNNN`）
 * @returns {string|null} 形状不对就 null（不猜）
 */
export function practiceKeyFromLessonId(id) {
  const s = String(id || '').trim()
  return /^[^/]+\/\d{4}$/.test(s) ? s : null
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

  // 课 id → 源文件名（页面知道自己被构建成哪个文件，给一条兜底查法）
  for (const l of pack?.lessons || []) {
    const key = practiceKeyFromLessonId(l.id)
    if (key && l.file) fileToKey[String(l.file)] = key
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
      const key = practiceKeyFromLessonId(l.id)
      if (!key) continue
      lessons[key] = {
        id: l.id,
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

  // 键是课 id（`point/NNNN`）：先按课号、同号再按点 id —— 确定性，且看起来还是课次顺序
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
    // version 2 = 键是课 id（version 1 是"课号"，两个圈各有 0001 时会撞 —— 见 practiceKeyFromLessonId）
    version: 2,
    keyScheme: 'lesson-id',
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
