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

/** 课 id（`spring-boot/0001`）→ 页面认得的课号（`1`，与页面内联 meta 的 number 对齐） */
export function practiceKeyFromLessonId(id) {
  const m = /\/(\d+)$/.exec(String(id || ''))
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? String(n) : null
}

/**
 * @param {{state: object, pack: object}} input
 * @returns {{version:number, source:string, lessons:object, byFile:object}}
 */
export function buildPracticeData({ state, pack } = {}) {
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
  for (const [rel, key] of Object.entries(fileToKey)) {
    const base = rel.split('/').pop()
    if (base && !(base in fileToKey)) fileToKey[base] = key
  }

  for (const p of state?.projects || []) {
    for (const l of p.lessons || []) {
      if (!l.challengeSummary) continue // 未声明判据 → 不产出（不猜）
      const key = practiceKeyFromLessonId(l.id)
      if (!key) continue
      lessons[key] = {
        id: l.id,
        title: l.title || '',
        summary: {
          achieved: l.challengeSummary.achieved,
          total: l.challengeSummary.total,
          needsReview: l.challengeSummary.needsReview,
        },
        challenges: (l.challenges || []).map((c) =>
          c.needsReview
            ? { no: c.no, hint: c.hint || '', deliverable: c.deliverable || '', state: 'review', why: c.hint || '' }
            : {
                no: c.no,
                hint: c.hint || '',
                deliverable: c.deliverable || '',
                state: c.done ? 'done' : 'todo',
                missing: (c.missing || []).map((m) => m.hint || m.id),
              }
        ),
      }
    }
  }

  const sortedLessons = {}
  for (const k of Object.keys(lessons).sort((a, b) => Number(a) - Number(b))) sortedLessons[k] = lessons[k]
  const sortedFiles = {}
  for (const k of Object.keys(fileToKey).sort()) sortedFiles[k] = fileToKey[k]

  return { version: 1, source: 'learning-records/state.json', lessons: sortedLessons, byFile: sortedFiles }
}

/** 渲染成 `assets/practice-data.js` 的源码（UMD 双出口，与 glossary-data.js 同样的形状） */
export function renderPracticeDataModule(data) {
  return [
    '/**',
    ' * practice-data.js — 课程页「实践区」的数据源（**由插件 `whale_practice` 生成**）',
    ' * ------------------------------------------------------------------',
    ' * 数据来自学生工作区的**静态事实**（探针扫出来的），插件不执行学生代码。',
    ' * 手改会在下次生成时被覆盖；要改判据请改 code/<项目>/EXPECT.json。',
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
    lines.push(`第${k}课 ${d.title}：达成 ${s.achieved} / 共 ${s.total}${s.needsReview ? `（另有 ${s.needsReview} 项需人工确认）` : ''}`)
    for (const c of d.challenges) {
      lines.push(`  第${c.no}题 产出：${c.deliverable || c.hint || '（未写）'} —— ${c.state === 'done' ? '已达成' : c.state === 'todo' ? '未达成' : '需人工确认'}${c.missing?.length ? ' → ' + c.missing.join('；') : ''}`)
    }
  }
  return lines.length ? lines : ['（没有任何课声明了挑战判据 —— 不产出完成度）']
}
