/**
 * author.js — 生成课程源文件骨架（**不写盘**）
 * ------------------------------------------------------------------
 * 起草：mimo（读现有 tools/*.js 的判法）；收口：主线程（接口 / 判据 / 对拍）。
 * 契约：`authorLesson(input) -> {file,text}` / `validateSkeleton(text) -> {ok,problems}`
 *   · **文件名必须显式给 ASCII slug**（中文标题派生出来的 slug 是空的 —— 本仓库踩过 ✗）
 *   · **source 必填**（课程包规矩：每课都要能指到官方来源）
 */
/**
 * draft/author.js — 课程源文件生成与骨架校验（**只生成文本，不写盘**）
 * ------------------------------------------------------------------
 * 判法来源：
 *   · meta 格式：第 1 行 <script type="application/json" data-lesson-meta>
 *     （lessons/src/0001-*.html L1）
 *   · meta 必填键：title / number / navTitle / hintTerm / terms / source
 *     （pack.js L121-123 解析 meta 时依赖这些；source 含 label+url）
 *   · 槽位：<!--@objective--> ... <!--/@objective-->
 *     <!--@body--> ... <!--/@body-->
 *   ·   <!--@reading--> ... <!--/@reading-->
 *     <!--@challenges--> ... <!--/@challenges-->
 *   ·   <!--@review--> ... <!--/@review-->（可选）
 *     （_frame.html L72-105 的占位对应；源文件样板 L103-L456）
 *   · 文件名：^\d{4}-.*\.html$（pack.js L19 LESSON_FILE_RE）
 *   · 路径：lessons/src/NNNN-*.html（pack.js L57）
 */

const SLOT_RE = /<!--@([a-z]+)-->/g

/**
 * 生成合规的课程源文件文本。
 * 只返回文本与建议路径，不写盘。
 *
 * @param {{ halo: string, point: string, number: number, title: string, slug: string,
 *           hintTerm: string, source: { label: string, url: string },
 *           minutes?: number, terms?: Record<string,string> }} params
 * @returns {{ file: string, text: string }}
 */
export function authorLesson({ halo, point, number, title, slug, hintTerm, source, minutes, terms }) {
  const padded = String(number).padStart(4, '0')
  // ⚠️ **slug 必须显式给**：中文标题派生出来的 slug 是空的 → `0009-.html` ✗（本仓库实测过）
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`authorLesson：slug 必须是 ASCII 小写连字符（收到 ${JSON.stringify(slug)}）—— 中文标题派生不出可用文件名`)
  }
  // ⚠️ **source 必填**：课程包的规矩是"每课都要能指到官方来源"（见 halo.json 的 tech.rule）
  if (!source || !source.label || !source.url) {
    throw new Error('authorLesson：source.label / source.url 必填（课程包不允许没有出处的课）')
  }
  // ⚠️ **hintTerm 必填**：它要能在术语库里查到，空串会让构建期报错
  if (!hintTerm) throw new Error('authorLesson：hintTerm 必填（本课的"名字"要指到一个真实术语）')
  const filename = `${padded}-${slug}.html`

  // meta JSON
  const meta = {
    title,
    number,
    navTitle: title,
    hintTerm,
    source: { label: source.label, url: source.url },
    terms: terms || {},
  }

  // 构造文本
  const lines = [
    `<script type="application/json" data-lesson-meta>`,
    JSON.stringify(meta, null, 2),
    `</script>`,
    ``,
    `<!--@objective-->`,
    `    <div class="alert alert-info">`,
    `        <strong>课程目标：</strong>（待填写）`,
    minutes != null
      ? `        <br><strong>预计时间：</strong>${minutes} 分钟`
      : `        <br><strong>预计时间：</strong>（待填写） 分钟`,
    `    </div>`,
    `<!--/@objective-->`,
    ``,
    `<!--@body-->`,
    `    <h2>（正文标题）</h2>`,
    `    <p>（正文内容）</p>`,
    `<!--/@body-->`,
    ``,
    `<!--@reading-->`,
    `    <ol>`,
    `        <li>（推荐阅读 1）</li>`,
    `    </ol>`,
    `<!--/@reading-->`,
    ``,
    `<!--@challenges-->`,
    `    <div class="alert alert-warning">`,
    `        <ol>`,
    `            <li><strong>（挑战 1）</strong><br>做：（描述）<br>验收：（标准）</li>`,
    `        </ol>`,
    `    </div>`,
    `<!--/@challenges-->`,
    ``,
  ]

  return {
    file: `lessons/src/${filename}`,
    text: lines.join('\n'),
  }
}

/**
 * 校验课程源文件骨架。
 *
 * @param {string} text 源文件全文
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateSkeleton(text) {
  const problems = []

  // 1. meta 存在且可 JSON.parse
  const metaRe = /<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/
  const metaMatch = text.match(metaRe)
  if (!metaMatch) {
    problems.push('缺少 data-lesson-meta 脚本块')
  } else {
    let meta
    try {
      meta = JSON.parse(metaMatch[1])
    } catch (e) {
      problems.push(`meta 不是合法 JSON：${e.message}`)
      meta = null
    }
    if (meta) {
      // 2. 必填键
      for (const key of ['title', 'number', 'navTitle', 'terms', 'source']) {
        if (!(key in meta)) problems.push(`meta 缺少必填键「${key}」`)
      }
      if (meta.source && typeof meta.source === 'object') {
        if (!meta.source.label) problems.push('meta.source.label 为空')
        if (!meta.source.url) problems.push('meta.source.url 为空')
      }
    }
  }

  // 3. 槽位成对（每对 <!--@x--> 和 <!--/@x--> 必须同时存在）
  const openSlots = new Set()
  const closeSlots = new Set()
  let m
  const openRe = /<!--@([a-z]+)-->/g
  const closeRe = /<!--\/@([a-z]+)-->/g
  while ((m = openRe.exec(text)) !== null) openSlots.add(m[1])
  while ((m = closeRe.exec(text)) !== null) closeSlots.add(m[1])

  const requiredSlots = ['objective', 'body', 'reading', 'challenges']
  const optionalSlots = ['review']

  for (const slot of requiredSlots) {
    if (!openSlots.has(slot)) problems.push(`缺少开标记 <!--@${slot}-->`)
    if (!closeSlots.has(slot)) problems.push(`缺少闭标记 <!--/@${slot}-->`)
    if (openSlots.has(slot) && !closeSlots.has(slot)) {
      problems.push(`槽位「${slot}」有开标记但没有闭标记`)
    }
    if (!openSlots.has(slot) && closeSlots.has(slot)) {
      problems.push(`槽位「${slot}」有闭标记但没有开标记`)
    }
  }

  // 可选槽位：如果有开就必须有闭
  for (const slot of optionalSlots) {
    if (openSlots.has(slot) && !closeSlots.has(slot)) {
      problems.push(`槽位「${slot}」有开标记但没有闭标记`)
    }
    if (!openSlots.has(slot) && closeSlots.has(slot)) {
      problems.push(`槽位「${slot}」有闭标记但没有开标记`)
    }
  }

  // 4. 文件名（如果 text 开头能推断出文件名的话）
  //    这里检查 meta.number 是否能生成合法文件名
  //    validateSkeleton 只接收 text，文件名由外部检查；这里检查 meta.number 的存在性
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1])
      if (meta.number != null && (!Number.isFinite(meta.number) || meta.number < 1)) {
        problems.push(`meta.number 不是正整数：${meta.number}`)
      }
    } catch { /* 已经报过了 */ }
  }

  return { ok: problems.length === 0, problems }
}
