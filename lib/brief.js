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
 *
 * ② + ③(a)(b)(c)（P0 契约 §3 / §4）新增的段：终点契约（goals.jsonl + judgeChallenges 判验收）、
 * 课后调整（adjustments.jsonl）、学习记录读内容、学情摸底带起点台阶。
 * **decideNext 的决策分支一个没动**（Q6：课后调整 v1 只进上下文；§3.2：终点只在 why 尾注）。
 */
import { judgeChallenges } from './state.js'
import { resolveFor, TEACHING_PARAMS, TEACHING_DISCIPLINE, GLOBAL_CIRCLE } from './teaching-io.js'

/** 建议的动作类型（封闭集） */
export const NEXT_ACTIONS = ['answer-pending', 'continue-lesson', 'open-next-lesson', 'intake-course', 'learn-prerequisite', 'unknown']

/**
 * 从已收集的数据里**推导**下一步该干什么。
 * 顺序即优先级：学生当场等的先答，再补没做完的课，最后才谈开新课。
 *
 * @param {{pending: number, projects: object[], lessonTotal: number, prereq?: object|null, intake?: object, goalNote?: string}} d
 *   `goalNote` 是 ② 的终点摘要 —— **只允许出现在 why 的尾注**（决策分支 v1 一个都不许动，§3.2）
 * @returns {{action: string, why: string, lesson?: string, missing?: string[]}}
 */
export function decideNext(d) {
  const pending = d.pending || 0
  if (pending > 0) {
    return { action: 'answer-pending', why: `队列里还有 ${pending} 条待答 —— 学生正在等` }
  }
  // 「哪些课还没做完」—— **真源是挑战**（Q2 裁定：判词只看 challenges），
  // 与开新课的门禁（`lib/gate.js` 的 `judgeSnapshot`）**同一套判据**。
  // ⚠️ 2026-09-24 修正：原先只看 `l.done`（**required 级**），于是"required 补齐了但挑战没过"时，
  // brief 会说这点没事、门禁却拦住 —— 同一事实两套口径（当天在真包上实测到：
  // brief 指 Vue，门禁拦 spring-boot，两边指的是不同的课）。
  const gaps = []
  for (const p of d.projects || []) {
    const dir = p.dir ?? p.facts?.dir
    for (const l of p.lessons || []) {
      const cc = l.challengeSummary
      if (cc && cc.total > 0) {
        if (cc.achieved < cc.total) {
          const open = (l.challenges || []).filter((c) => c.done !== true && c.needsReview !== true)
          gaps.push({
            dir,
            lesson: l.id,
            title: l.title,
            kind: 'challenge',
            needsReview: cc.needsReview || 0,
            missing: open.map((c) => `第${c.no}题：${c.deliverable || c.hint || ''}`),
            nos: open.map((c) => `第${c.no}题`),
          })
        }
      } else if (!l.done) {
        // 没声明判据的课（门禁会放行）→ 退回 required 级：这一课确实还没做完，值得提醒
        gaps.push({ dir, lesson: l.id, title: l.title, kind: 'required', nos: [], missing: (l.missing || []).map((m) => m.hint || m.id) })
      }
    }
  }
  if (gaps.length) {
    const g = gaps[0]
    const tail = g.needsReview ? `（另有 ${g.needsReview} 项需人工确认，不阻塞）` : ''
    return {
      action: 'continue-lesson',
      lesson: g.lesson,
      kind: g.kind,
      missing: g.missing,
      // 给教师看的一页，说**标题**比说 id 友好（标题来自 EXPECT.json；没有就退回 id）
      // 挑战级的 why 只列题号 —— 产出原文很长，塞进去会把这一行撑爆（完整产出在 missing 里）
      why: g.kind === 'challenge'
        ? `${g.title || g.lesson}的挑战还差 ${g.missing.length} 项（${g.nos.join('、')}）${tail} —— 别开新课`
        : `${g.title || g.lesson}还缺 ${g.missing.length} 项（${g.missing.join('、')}）—— 别开新课`,
    }
  }
  const projects = d.projects || []
  if (!projects.length) {
    return { action: 'unknown', why: '没扫到学生项目（code/ 下没有含构建文件的工程）—— 不猜' }
  }
  if (!projects.some((p) => p.lessons?.length)) {
    return { action: 'unknown', why: '没有 EXPECT.json 声明期望 —— 只报事实，不替你决定缺什么' }
  }
  // 前置闸（2026-09-23 用户裁定）：要开的这个知识点，前置还没学完 → **先去补那门课**，
  // 而不是继续给他生成新课。位置放在 intake 之前：前置没补齐时，摸底也先别做。
  // 判定与措辞的真源都在 `lib/pack-model.js` 的 `prerequisiteGaps()` / `describeGaps()`
  // （消费 point.json 的 requires）—— 这里只做分支，不重写一份判法。
  if (d.prereq && d.prereq.ok === false) {
    return {
      action: 'learn-prerequisite',
      point: d.prereq.pointId,
      missing: (d.prereq.missing || []).map((l) => l.id),
      why: `${d.prereq.why || `「${d.prereq.pointId}」的前置还没学完`} —— 别开新课`,
    }
  }
  // 学情摸底缺口检查：有缺口就先摸底再开课
  if (d.intake?.missing?.length) {
    return {
      action: 'intake-course',
      missing: d.intake.missing,
      why: `${d.intake.missing.join('、')} 还没做学情摸底 —— 先问清楚再加课`,
    }
  }
  // 尾注：终点摘要（②）在最前，然后是 ③ 的两条。**一条都没有时拼出来的字符串与今天逐字节相同**
  //（原来就是 `${d.goalNote ? `；${d.goalNote}` : ''}`，改成数组 join 后这个性质不变）。
  const tails = []
  if (d.goalNote) tails.push(d.goalNote)
  if (d.focus?.items?.length) {
    tails.push(`上一课（${d.focus.lesson || '未记课次'}）的课后调整写着卡在：${d.focus.items.join('、')} —— 下一课优先补这一段`)
  }
  if (d.tier) {
    const gap = d.tier.to - d.tier.from
    tails.push(
      `起点 tier ${d.tier.from} → 终点 tier ${d.tier.to}（差 ${gap} 档）`
      + (d.tier.remaining === null ? '' : `；地图上还差 ${d.tier.remaining} 课 —— 到这儿大概还要 ${d.tier.remaining} 节课`),
    )
  }
  return {
    action: 'open-next-lesson',
    // 终点摘要只在这条 why 的**尾注**追加（② 契约 §3.2：分支不动、封闭集不动）
    why: `已声明的课全部达成（共 ${d.lessonTotal} 课）—— 可以开下一课${tails.length ? `；${tails.join('；')}` : ''}`,
  }
}

/* ── ② 终点契约（goals.jsonl）─────────────────────────────────
 * 验收判定**复用 `judgeChallenges`**（A1 裁定：判据引擎单一真源，绝不另写一份挑战判定）。
 * 硬约束：`artifact.what` 就是 wizard 的「作品一句话」—— 终点永远来自显式输入，
 * 绝不拿摸底的 can / prior / level 回落顶替（那条回落只属于起点台阶）。
 */

/** 一个项目都没扫到时给全空 facts：fail-closed —— 判不了就是没达成，不猜进度 */
const EMPTY_FACTS = Object.freeze({
  files: [], dirs: [], classes: [], annotations: [], endpoints: [], configKeys: [], configValues: [], pomArtifacts: [],
})

/** 挑一台判据用的 facts：作品放哪（artifact.where）命中哪个项目就用哪个；都没命中就并全部（顺序确定） */
function pickFacts(projects, where) {
  const ps = (projects || []).filter((p) => p && p.facts)
  if (!ps.length) return EMPTY_FACTS
  const w = String(where ?? '').trim()
  if (w) {
    const hit = ps.find((p) => w.includes(p.facts.dir) || String(p.facts.dir).includes(w))
    if (hit) return hit.facts
  }
  if (ps.length === 1) return ps[0].facts
  const all = ps.map((p) => p.facts)
  return {
    dir: all.map((f) => f.dir).join('+'),
    build: all.map((f) => f.build).find((b) => b) ?? null,
    files: all.flatMap((f) => f.files || []),
    dirs: all.flatMap((f) => f.dirs || []),
    classes: all.flatMap((f) => f.classes || []),
    annotations: all.flatMap((f) => f.annotations || []),
    endpoints: all.flatMap((f) => f.endpoints || []),
    configKeys: all.flatMap((f) => f.configKeys || []),
    configValues: all.flatMap((f) => f.configValues || []),
    pomArtifacts: all.flatMap((f) => f.pomArtifacts || []),
    built: all.some((f) => f.built),
  }
}

/**
 * 「终点契约」段的行 + 给 decideNext 的 why 尾注（纯函数）。
 * 没有现行终点 → 只提示「终点还没结构化」（B6：不判「没摸底」、不拦开课）。
 */
export function goalBrief(goals, projects) {
  const latest = goals?.latest || {}
  const pts = Object.keys(latest).sort()
  if (!pts.length) {
    return { lines: ['终点还没结构化（goals.jsonl 里还没有现行终点）'], note: '' }
  }
  const lines = []
  const parts = []
  for (const pt of pts) {
    const rec = latest[pt]
    const judged = judgeChallenges(pickFacts(projects, rec.artifact?.where), rec.acceptance)
    const art = rec.artifact || {}
    const what = `作品 ${art.what || '（未填）'}${art.where ? `（${art.where}）` : ''}`
    const miss = (judged.challenges || []).filter((x) => x.done === false)
    lines.push(
      `· ${pt}：终点 tier ${rec.tier}${rec.v > 1 ? `（v${rec.v}，接替 v${rec.replaces}）` : ''} · ${what}`
        + ` · 验收 ${judged.achieved}/${judged.total}${judged.needsReview ? `（另有 ${judged.needsReview} 项需老师确认）` : ''}`
        + (miss.length ? ` → 缺：${miss.map((x) => `第${x.no}题（产出：${x.deliverable}）`).join('、')}` : ''),
    )
    if (rec.from) {
      const stuck = (rec.from.focus || []).join('、')
      lines.push(`   起点台阶：${rec.from.tier === null ? '未定档' : 'tier ' + rec.from.tier}${stuck ? ` · 卡点：${stuck}` : ''}`)
    }
    parts.push(`${pt} tier ${rec.tier}（验收 ${judged.achieved}/${judged.total}）`)
  }
  return { lines, note: `终点已定：${parts.join('、')}` }
}

/* ── ③ 决策接线：把**学生自己的数据**接进"下一步"（2026-09-25 · P0-2 ④）
 *
 * 为什么单独一段、不塞进 `goalBrief`：`goalBrief` 只负责渲染「终点契约」那一段，
 * 而这两条**改的是建议本身**（`decideNext` 的 why）。分开才能在测试里各自钉住。
 *
 * 两条都**可关**：`input.advice === false` ⇒ 一个字段都不返回 ⇒ `decideNext` 拿到的
 * 输入与今天**逐字节相同**（判据：`test/brief.mjs` 的"关开关"一条）。
 * 数据缺了也一样不返回 —— 空态不许编。
 */
export function adviceInputs(input) {
  if (input?.advice === false) return {}
  const out = {}

  // ① 卡点优先：课后调整里写的"卡在哪" —— 取**最近一条写了 gaps 的**
  //    （台账 append-only、entries 按文件顺序；倒着找第一条非空的，就是最近一次说的卡点）
  const entries = input?.adjustments?.entries || []
  for (let i = entries.length - 1; i >= 0; i--) {
    const g = (entries[i].gaps || []).filter(Boolean)
    if (g.length) {
      out.focus = { lesson: entries[i].lesson || '', items: g }
      break
    }
  }

  // ② 档位差：现行终点契约的 tier 与它的**起点台阶**（`from.tier`，由摸底判定）比。
  //    只报"差几档"这个**算得出来的数**；"还要几节课"取地图前沿的 `missing`（真数），
  //    拿不到就**不说**这句（不编一个 N 出来）。
  const latest = input?.goals?.latest || {}
  const rem = input?.planRemaining || {}
  for (const pt of Object.keys(latest).sort()) {
    const rec = latest[pt] || {}
    const from = rec.from && typeof rec.from.tier === 'number' ? rec.from.tier : null
    const to = typeof rec.tier === 'number' ? rec.tier : null
    if (from === null || to === null || to <= from) continue
    out.tier = { point: pt, from, to, remaining: Number.isInteger(rem[pt]) ? rem[pt] : null }
    break
  }
  return out
}

/**
 * 「教学方式」段的行（纯函数，3–5 行）。
 *
 * 为什么要有这一段（`_board/01-鲸师.md:318`）：教学参数是**给学生看的承诺** ——
 * 每次开课 / 答疑先读的那一页上要能一眼看到"现在按什么方式教"，否则学生提了要求也不知道
 * 到底生效了没有。参数本身住 `learning-records/teaching.jsonl`（`whale_teaching` 写），
 * 这里**只渲染**，不改判据。
 *
 * 行数刻意压到 3–5 行：一行全局（学科中立）、每个圆圈一行（**该圆圈自己的特化**）、
 * 一行锁死集，有自由补充再加一行。**缺省态也要说话**，不留空壳。
 *
 * ⚠️ 2026-09-25 主人裁定后：台账**按圆圈分节**，每个圆圈有自己独立的教学方法 ——
 *    这一段要把"全局 + 各圆圈"分别说清，否则学生看不出他给某个圆圈提的要求生效了没有。
 */
export function teachingBrief(teaching) {
	const discipline = TEACHING_DISCIPLINE.map((d) => d.label).join(' / ')
	const circles = Object.keys(teaching?.circles || {}).sort()
	const globalV = teaching?.global?.values || null
	const hasAny = !!globalV || circles.length > 0
	if (!hasAny) {
		return {
			has: false,
			tier: 1,
			overridden: [],
			lines: [`还没有教学参数 —— 全部按**档位默认**（tier 1）；学生提要求时用 whale_teaching 的 propose → confirm 落盘`,
				`🔒 锁死（不开放调整）：${discipline}`],
		}
	}
	const val = (params, id) => { const v = params[id]; return Array.isArray(v) ? v.join('+') : v }
	const fmt = (r, labels) => Object.keys(r.params)
		.map((id) => `${labels[id] || id} ${val(r.params, id)}${r.overridden.includes(id) ? '＊' : ''}`)
		.join(' · ')
	const globalLabels = Object.fromEntries(Object.keys(TEACHING_PARAMS).map((id) => [id, TEACHING_PARAMS[id].label]))
	const g = resolveFor(teaching, GLOBAL_CIRCLE)
	const lines = []
	lines.push(`全局（学科中立）tier ${g.tier}：${fmt(g, globalLabels)}`)
	for (const c of circles.slice(0, 5)) {
		// ⚠️ 圆圈那一行只许显示**它自己的**特化与取值 —— 全局参数是上一行的事，
		//    混进来会让学生以为"我给这个圆圈改过讲解顺序"（实测踩过）。
		const cv = teaching.circles[c]?.values?.params || {}
		const labels = Object.fromEntries((teaching.circles[c]?.spec || []).map((s) => [s.id, s.label]))
		const parts = Object.entries(cv).map(([id, v]) => `${labels[id] || id} ${Array.isArray(v) ? v.join('+') : v}＊`)
		lines.push(`· ${c}：${parts.length ? `${parts.join(' · ')}（学生改过 ${parts.length} 项）` : '按档位默认（还没特化）'}`)
	}
	if (circles.length > 5) lines.push(`（另有 ${circles.length - 5} 个圆圈有特化，未列）`)
	lines.push(`🔒 锁死（不开放调整）：${discipline}`)
	// 自由补充可能落在**任何一层**（全局或某个圆圈）—— 两处都要收，别因为全局那条是空数组就短路
	const free = [...(globalV?.freeText || []), ...circles.flatMap((c) => teaching.circles[c]?.values?.freeText || [])]
	if (free.length) lines.push(`（自由补充）${free.slice(0, 3).map((f) => f.text).join('；')}`)
	for (const p of teaching?.problems || []) lines.push(`⚠️ ${p}`)
	return { has: true, tier: g.tier, overridden: g.overridden, lines }
}

/**
 * 组装 brief。
 * @param {{pack: object, projects: object[], stateNotes: string[], pending: object[], processed: number,
 *          ledger: {count: number, latest: string|null}, glossary: {count: number, categories: number},
 *          recordCount: number, records: {name: string, text: string}[],
 *          goals: {latest: Record<string, object>, problems: string[]},
 *          adjustments: {entries: object[], omitted: number, problems: string[]},
 *          notes: {id:string, seq:number, kind:string, anchor:string, text:string, label?:string|null}[]}} input
 */
export function buildBrief(input) {
  const pack = input.pack || {}
  const projects = input.projects || []
  // ② 终点契约先算好：段落用它，decideNext 只拿它当 why 尾注（决策分支不动）
  const goal = goalBrief(input.goals, projects)
  const next = decideNext({
    pending: (input.pending || []).length,
    projects,
    lessonTotal: pack.lessons || 0,
    intake: input.intake,
    // 前置体检里**第一个没过的**知识点就是这个闸要拦的目标（排序在 brief-io 里定死，保证可对拍）
    prereq: (input.prereqAll || []).find((g) => g && g.ok === false) || null,
    goalNote: goal.note,
    // ③ 决策接线：卡点 / 档位差 —— `advice:false` 时这里展开成 `{}`，输入与今天一字不差
    ...adviceInputs(input),
  })

  const sections = []

  sections.push({
    title: '课程包',
    lines: [`${pack.circles} 个圆圈 · ${pack.points} 个知识点 · ${pack.lessons} 门课程（已点亮 ${pack.learned}）`],
  })

  // 学情摸底（③(b)：已摸底行可选追加起点台阶；B6 —— 老记录无 start 照旧一行）
  const intake = input.intake || { have: 0, missing: [] }
  const intakeLines = [`已摸底 ${intake.have} 个知识点 · 缺 ${intake.missing.length}`]
  for (const m of intake.missing) intakeLines.push(`· ${m}：未摸底`)
  for (const [pt, lv] of Object.entries(intake.details || {})) {
    // B6 兼容：details 老形状是 level 字符串，新形状是 { level, start }
    const level = lv && typeof lv === 'object' ? (lv.level ?? '') : lv
    const start = lv && typeof lv === 'object' ? lv.start : null
    intakeLines.push(`· ${pt}：已摸底（${level}）${start && start.tier !== null && start.tier !== undefined ? `｜起点 tier ${start.tier}` : ''}`)
  }
  sections.push({ title: '学情摸底', lines: intakeLines })

  // ② 终点契约（goals.jsonl）：没有就只提示「终点还没结构化」（B6）
  sections.push({
    title: '终点契约',
    lines: [...goal.lines, ...(input.goals?.problems || []).map((p) => `⚠️ ${p}`)],
  })

  // ③ 教学方式（teaching.jsonl，丁3）：**每次开课先读的那一页**上要能一眼看到"现在按什么方式教"。
  //    参数是学生提的要求，渲染在这里他才看得见"到底生效了没有"。
  sections.push({ title: '教学方式', lines: teachingBrief(input.teaching).lines })

  // 前置体检（2026-09-23 用户裁定：「开课摸底时，就要知道学生是不是学会了相关的前置内容」）。
  // 每一行一个**已经有课**的知识点；没有前置（或前置都学过）也照样报一行 ——
  // 免得"没这一节"和"这节是空的"分不清。
  const prereqAll = input.prereqAll || []
  if (prereqAll.length) {
    sections.push({
      title: '前置体检',
      lines: prereqAll.map((g) => `${g.ok ? '✓' : '✗'} ${g.pointId}：${g.why || ''}`),
    })
  }

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

  // ③(a) 课后调整（adjustments.jsonl）：文件不存在 = 正常空态。
  // Q6 裁定：v1 **只进上下文**，不改 decideNext 的决策分支。
  const adj = input.adjustments || { entries: [], omitted: 0 }
  const adjLines = []
  if (!adj.entries || !adj.entries.length) {
    adjLines.push('还没有课后调整')
  } else {
    for (const a of adj.entries) {
      const label = a.lesson || a.title || '—'
      adjLines.push(`· [${label}] ${a.lit === false ? '✗ 未点亮：' : ''}${a.adjust}${a.gaps?.length ? ` → 缺：${a.gaps.join('、')}` : ''}`)
    }
    if (adj.omitted) adjLines.push(`另有 ${adj.omitted} 条未列`)
  }
  for (const p of (adj.problems || [])) adjLines.push(`⚠️ ${p}`)
  sections.push({ title: '课后调整', lines: adjLines })

  // ③(c) 学习记录：从"只列文件名"改成**读内容**（最近 3 份 × 每份前 200 字；超出显式报，不静默丢）。
  // 份数口径不变（recordCount = listLearningRecords 的长度）。
  const recs = Array.isArray(input.records) ? input.records : []
  const recCount = input.recordCount ?? recs.length
  const recLines = []
  if (!recCount) {
    recLines.push('（没有）')
  } else {
    const last = recs.length ? recs[recs.length - 1] : null
    const lastName = last ? (typeof last === 'string' ? last : last.name) : ''
    recLines.push(`${recCount} 份，最新：${lastName}`)
    for (const r of recs) {
      const name = typeof r === 'string' ? r : r.name
      const text = typeof r === 'string' ? '' : (r.text || '')
      recLines.push(text ? `· ${name}：${text}` : `· ${name}`)
    }
    if (recCount > recs.length) recLines.push(`另有 ${recCount - recs.length} 份未列`)
  }
  sections.push({ title: '学习记录', lines: recLines })

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
