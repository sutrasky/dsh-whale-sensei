/**
 * lib/brief.js — 备课 / 答疑的**上下文包**（纯函数层）
 * ------------------------------------------------------------------
 * 解决的问题（计划里点名的"最大缺口"）：
 *   "读学生产出 → 反过来改教学 → 步步有回应" —— 以前 agent 每轮都得自己东拼西凑：
 *   看代码现状（whale_state）、看待答队列（whale_ask）、看已答台账、看术语、看学习记录……
 *   这里把这几样**合成一页**，并给出**从数据推出来的**下一步建议。
 *
 * 两条硬规矩：
 *   1. **建议必须可推导**：每一句"下一步"都要带上依据；没有数据就写"不知道"，不猜 ✗
 *   2. **不含时间戳**：同样的输入 → 逐字节相同的 brief（可对拍）
 */

/** 建议的动作类型（封闭集） */
export const NEXT_ACTIONS = ['answer-pending', 'continue-lesson', 'open-next-lesson', 'intake-course', 'unknown']

/**
 * 从已收集的数据里**推导**下一步该干什么。
 * 顺序即优先级：学生当场等的先答，再补没做完的课，最后才谈开新课。
 *
 * @param {{pending: number, projects: object[], lessonTotal: number}} d
 * @returns {{action: string, why: string, lesson?: string, missing?: string[]}}
 */
export function decideNext(d) {
  const pending = d.pending || 0
  if (pending > 0) {
    return { action: 'answer-pending', why: `队列里还有 ${pending} 条待答 —— 学生正在等` }
  }
  const gaps = []
  for (const p of d.projects || []) {
    for (const l of p.lessons || []) {
      if (!l.done) gaps.push({ dir: p.dir ?? p.facts?.dir, lesson: l.id, title: l.title, missing: l.missing.map((m) => m.hint || m.id) })
    }
  }
  if (gaps.length) {
    const g = gaps[0]
    return {
      action: 'continue-lesson',
      lesson: g.lesson,
      missing: g.missing,
      // 给教师看的一页，说**标题**比说 id 友好（标题来自 EXPECT.json；没有就退回 id）
      why: `${g.title || g.lesson}还缺 ${g.missing.length} 项（${g.missing.join('、')}）—— 别开新课`,
    }
  }
  const projects = d.projects || []
  if (!projects.length) {
    return { action: 'unknown', why: '没扫到学生项目（code/ 下没有含构建文件的工程）—— 不猜' }
  }
  if (!projects.some((p) => p.lessons?.length)) {
    return { action: 'unknown', why: '没有 EXPECT.json 声明期望 —— 只报事实，不替你决定缺什么' }
  }
  // 学情摸底缺口检查：有缺口就先摸底再开课
  if (d.intake?.missing?.length) {
    return {
      action: 'intake-course',
      missing: d.intake.missing,
      why: `${d.intake.missing.join('、')} 还没做学情摸底 —— 先问清楚再加课`,
    }
  }
  return { action: 'open-next-lesson', why: `已声明的课全部达成（共 ${d.lessonTotal} 课）—— 可以开下一课` }
}

/**
 * 组装 brief。
 * @param {{pack: object, projects: object[], stateNotes: string[], pending: object[], processed: number,
 *          ledger: {count: number, latest: string|null}, glossary: {count: number, categories: number},
 *          records: string[], notes: {id:string, seq:number, kind:string, anchor:string, text:string, label?:string|null}[]}} input
 */
export function buildBrief(input) {
  const pack = input.pack || {}
  const projects = input.projects || []
  const next = decideNext({ pending: (input.pending || []).length, projects, lessonTotal: pack.lessons || 0, intake: input.intake })

  const sections = []

  sections.push({
    title: '课程包',
    lines: [`${pack.circles} 个圆圈 · ${pack.points} 个知识点 · ${pack.lessons} 门课程（已点亮 ${pack.learned}）`],
  })

  // 学情摸底
  const intake = input.intake || { have: 0, missing: [] }
  const intakeLines = [`已摸底 ${intake.have} 个知识点 · 缺 ${intake.missing.length}`]
  for (const m of intake.missing) intakeLines.push(`· ${m}：未摸底`)
  for (const [pt, lv] of Object.entries(intake.details || {})) {
    intakeLines.push(`· ${pt}：已摸底（${lv}）`)
  }
  sections.push({ title: '学情摸底', lines: intakeLines })

  const projectLines = []
  for (const p of projects) {
    const f = p.facts
    projectLines.push(`${f.dir}（${f.build || '无构建文件'}）· 主源 ${f.java.main.length} / 测试 ${f.java.test.length} · 端点 ${f.endpoints.length} · 注解 ${f.annotations.length}`)
    for (const l of p.lessons || []) {
      projectLines.push(`  ${l.done ? '✓' : '✗'} ${l.id} ${l.title}：满足 ${l.satisfied.length} / 缺 ${l.missing.length}${l.missing.length ? ' → ' + l.missing.map((m) => m.hint || m.id).join('、') : ''}`)
      // 挑战级：只报 k/n + 需人工确认 m（**不给百分比** —— 有需人工确认的项时百分比必然是假的）
      if (l.challengeSummary) {
        const c = l.challengeSummary
        const miss = (l.challenges || []).filter((x) => x.done === false)
        projectLines.push(
          `      挑战：达成 ${c.achieved} / 共 ${c.total}${c.needsReview ? `（另有 ${c.needsReview} 项需人工确认）` : ''}`
            + (miss.length ? ` → 未过：${miss.map((x) => `第${x.no}题（产出：${x.deliverable || x.hint}）`).join('、')}` : '')
        )
      } else if (l.challenges === null) {
        projectLines.push('      挑战：（未声明判据 —— 不猜完成度）')
      }
    }
    if (!(p.lessons || []).length) projectLines.push('  （未声明期望：只报事实，不猜缺什么）')
  }
  sections.push({ title: '学生现状', lines: projectLines.length ? projectLines : ['（code/ 下没有扫到工程）'] })

  sections.push({
    title: '待答',
    lines: input.pending?.length
      ? input.pending.map((q) => `#${q.id} ${q.lesson || ''} · ${String(q.question || '').slice(0, 60)}`)
      : ['（空）'],
  })

  sections.push({
    title: '已答',
    lines: [`归档 ${input.processed ?? 0} 条 · 台账登记 ${input.ledger?.count ?? 0} 条${input.ledger?.latest ? `（最新 #${input.ledger.latest}）` : ''}`],
  })

  sections.push({
    title: '术语',
    lines: [`${input.glossary?.count ?? 0} 个名词 · ${input.glossary?.categories ?? 0} 类`],
  })

  sections.push({
    title: '学习记录',
    lines: input.records?.length ? [`${input.records.length} 份，最新：${input.records[input.records.length - 1]}`, ...input.records.slice(-3, -1)] : ['（没有）'],
  })

  // 学生笔记
  const notes = input.notes || []
  const NOTE_CAP = 20
  const NOTE_LEN = 120
  const noteClip = (s) => { const t = String(s ?? '').trim(); return t.length > NOTE_LEN ? t.slice(0, NOTE_LEN) + '…' : t }
  const noteLines = [`共 ${notes.length} 条`]
  if (!notes.length) {
    noteLines.push('还没有笔记')
  } else {
    for (const n of notes.slice(0, NOTE_CAP)) {
      const loc = n.label || n.anchor
      noteLines.push(`· [${loc}] ${noteClip(n.text)}`)
    }
    if (notes.length > NOTE_CAP) {
      noteLines.push(`另有 ${notes.length - NOTE_CAP} 条未列`)
    }
  }
  sections.push({ title: '学生笔记', lines: noteLines })

  // 会话（**可选**：只有显式要求时才读 —— 默认不读，默认 brief 才能逐字节对拍）
  if (input.session) {
    const s = input.session
    sections.push({
      title: `会话（最近 ${s.shown ?? 0} 条可见 / 会话共 ${s.total ?? 0} 条）`,
      lines: s.ok
        ? (s.messages || []).map((m) => `${m.role}：${m.text || '（空）'}`)
        : [`（拿不到会话：${s.why}）`],
    })
  }

  if (input.stateNotes?.length) {
    sections.push({ title: '提示', lines: input.stateNotes })
  }

  return { sections, next, counts: { pending: input.pending?.length ?? 0, projects: projects.length, gapLessons: next.action === 'continue-lesson' ? 1 : 0 } }
}

/** 渲染成一页 Markdown（给人/agent 读）—— 同样输入逐字节相同（不含时间戳） */
export function renderBrief(brief) {
  const L = ['# 备课 / 答疑上下文包', '']
  for (const s of brief.sections) {
    L.push(`## ${s.title}`)
    for (const l of s.lines) L.push(l)
    L.push('')
  }
  L.push('## 建议的下一步')
  L.push(`${brief.next.action}：${brief.next.why}`)
  return L.join('\n')
}
