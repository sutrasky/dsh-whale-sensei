/**
 * author.js — 生成课程源文件骨架（**不写盘**）
 * ------------------------------------------------------------------
 * 起草：mimo（读现有 tools/*.js 的判法）；收口：主线程（接口 / 判据 / 对拍）。
 * 契约：`authorLesson(input) -> {file,text}` / `validateSkeleton(text) -> {ok,problems}`
 *   · **文件名必须显式给 ASCII slug**（中文标题派生出来的 slug 是空的 —— 本仓库踩过 ✗）
 *   · **source 必填**（课程包规矩：每课都要能指到官方来源）
 *   · **number 是 1..9999 的整数**、**halo / point 必须是合法 id**（目录名就是它们）
 *
 * ⚠️ 路径边界（T03 / 报告 B01）：`validateId` / `resolveInside` / `decodeRequestPath`
 *    **只有一份实现**，住在随包的 `lib/pack-template/tools/path-policy.cjs` —— 这里只是
 *    再导出（写课入口与包侧工具必须认同同一套边界，各写一份 = 一边堵一边漏）。
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

import { createRequire } from 'node:module'

const SLOT_RE = /<!--@([a-z]+)-->/g

/**
 * 共享路径策略（**唯一实现**在 `lib/pack-template/tools/path-policy.cjs`）。
 * 它随包发给每一个课程包（`tools/path-policy.cjs`），包侧工具与插件侧读的是同一份 ——
 * 报告 §446 的「归一化和 realpath 边界要进入可信 IO 边界」落在这里。
 */
const require_ = createRequire(import.meta.url)
const policy = require_('./pack-template/tools/path-policy.cjs')

/**
 * 身份内核（**唯一**严格实现；U02 交付）。本文件**不再自己拼** `circle/point`：
 * 目录分层就是知识点身份，构造一律走内核（U-SPEC §2「禁止第三份实现」）。
 * 课号的**范围与位数**也以它为准 —— 这里只把两个常量转出去，不再各写一遍。
 */
const identity = require_('./unify/identity.cjs')

/** 圆圈 / 知识点 id 的形状判据（`null` = 合法；否则回一句能照着改的话） */
export const validateId = policy.validateId
/** 把相对路径解到课程包根内（越界 / 绝对路径 / 软链逃逸一律拒） */
export const resolveInside = policy.resolveInside
/** 把原始请求路径解成安全的相对路径（只解一次百分号编码） */
export const decodeRequestPath = policy.decodeRequestPath

/** 课次的合法区间（4 位文件名 `NNNN-slug.html` 能表达的整数）—— 与身份内核同一份契约 */
export const NUMBER_MIN = identity.LESSON_NUMBER_MIN
export const NUMBER_MAX = identity.LESSON_NUMBER_MAX

/**
 * 课程源文件的**分层目录**。
 *
 * 两边都给 = 知识点身份（`circle/point`，由 `lib/unify/identity.cjs` 形成 —— 这是唯一实现）；
 * 只给一边 = 还没有完整归属（老包 / 新建包的第一步），**不构造身份**，退回平铺（老行为逐字保留）。
 *
 * @param {string|undefined|null} halo 圆圈 id
 * @param {string|undefined|null} point 知识点 id
 * @returns {string} 目录段（空串 = 平铺在 `lessons/src/` 下）
 */
function layoutDir(halo, point) {
  if (halo !== undefined && halo !== null && point !== undefined && point !== null) {
    return identity.pointKey(halo, point)
  }
  return halo !== undefined && halo !== null ? String(halo) : point !== undefined && point !== null ? String(point) : ''
}

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
  // ⚠️ **id 必须是合法 id**（T03）：它俩直接拼进目录名 —— `..` / 绝对路径 / 斜杠
  //    过去能一路写到课程包外面（报告 B01 的实测）。这里拒掉，比"事后 sanitize"可靠。
  for (const [k, v] of [['halo', halo], ['point', point]]) {
    if (v === undefined || v === null) continue
    const err = validateId(v)
    if (err) throw new Error(`authorLesson：${k} ${err}`)
  }
  // ⚠️ **number 是 1..9999 的整数**（T03）：文件名是 `NNNN-slug.html`（4 位），
  //    `0` / 小数 / 负数会生成 `0000-` / `2.5-` 这种文件名，而 `0` 那一版
  //    **今天会返回 ok:false 却照样把文件写下去**（报告 B01 的实测）。
  if (!Number.isInteger(number) || number < NUMBER_MIN || number > NUMBER_MAX) {
    throw new Error(`authorLesson：number 必须是 ${NUMBER_MIN}..${NUMBER_MAX} 的整数（收到 ${JSON.stringify(number)}）`)
  }
  // 四位宽度：与身份内核的课号契约同一份（`LESSON_WIDTH`）；范围已由上面的 NUMBER_MIN/MAX 校验过
  const padded = String(number).padStart(identity.LESSON_WIDTH, '0')

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
  // ⚠️ **路径必须反映 M3 的分层布局**：`lessons/src/<圆圈>/<知识点>/NNNN-slug.html`。
  //    平铺在 `lessons/src/` 下的源文件虽然能被递归发现，但**课次映射表（lesson-map）从路径
  //    推 circle/point，平铺就推不出** —— 页面/星图/术语对账都会跟着错位。
  //    halo 缺省时不猜：退回平铺（老包兼容），但工具那边会先从课程包把圆圈查出来。
  //    ⚠️ 目录段 = **知识点身份**，由 `lib/unify/identity.cjs` 形成（本文件不再自己拼）。
  const dir = layoutDir(halo, point)

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
    file: dir ? `lessons/src/${dir}/${filename}` : `lessons/src/${filename}`,
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
