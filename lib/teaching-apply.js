/**
 * lib/teaching-apply.js — 教学参数的**一处注入** + **每个参数一条生效判据**
 * ==================================================================
 * 设计建议 3 / 4（`_board/01-鲸师.md:288-289`）：
 *   ③ **唯一真源 + 一处注入**：参数落一个文件；注入**只发生在"生成教学内容"那一段**，
 *      **别塞进全局 persona**（那会变成每轮都付上下文租金）；
 *   ④ **每个参数配一条生效判据** —— 把"教学风格"变成能验的东西。
 *
 * 所以本文件是两件事的**唯一实现**：
 *   · `teachingDirectives(params)` / `injectionBlock(params)` —— 注入文本的唯一生成处
 *     （`lib/mods/author.js` 的生成话术读它；别处不许再拼一份）；
 *   · `judgeTeachingContent(html, params)` / `judgeTeachingInjection(text, params)` —— 判据。
 *
 * ⚠️ **判据的诚实边界**：能机械判的（注释覆盖 / 四维出现 / 注入是否到位）就判 ok/fail；
 *    判不了的（"只关键行"是取舍不是覆盖率）返回 `ok: null` 并**写明"没有机械判据"** ——
 *    不许拿"没判"冒充"判过了"。
 * ⚠️ 四维判据是**启发式**（只看标记词，不做语义理解）。误报就往 `DIM_MARKERS` 里补词，
 *    别把判据改成"永远成立"。
 */

import { resolveParams, TEACHING_PARAMS } from './teaching-io.js'

/** 注入块的标题（唯一字符串 —— 判据与渲染都读它） */
export const INJECTION_TITLE = '教学方式（现行教学参数）'

/**
 * 每个参数 → 一句**指令**（确定性：同一取值永远同一句）。
 * 取 `on/off` 这类二元参数的**两个方向都要给句子** —— 否则"关掉"在注入里没有痕迹，
 * 判据也就没法证明它生效了。
 */
export function directiveFor(id, value) {
  switch (id) {
    case 'commentDensity':
      if (value === 'line') return '代码里**逐行**加注释：每一行可执行代码都要有一句注释说明它在做什么。'
      if (value === 'block') return '代码按**块**加注释：每个代码块开头一句说明这一块在干什么。'
      if (value === 'key') return '只在**关键行**加注释：挑真正容易看错的几行说明，别逐行铺。'
      return null
    case 'commentDims': {
      const names = { what: '做了什么', link: '和谁联动', req: '对应哪条需求', why: '为什么这么设计' }
      const list = (value || []).map((v) => names[v]).filter(Boolean)
      return list.length ? `注释要覆盖这些维度：${list.join(' / ')}。` : null
    }
    case 'explainOrder':
      if (value === 'overview-first') return '讲解顺序：**先给全貌，再进细节**。'
      if (value === 'detail-first') return '讲解顺序：**先给细节，再回到全貌**。'
      return null
    case 'termPairing':
      return value === 'on' ? '术语**首次出现**时给中英对照。' : '术语不必给中英对照（只写中文即可）。'
    case 'errorStyle':
      if (value === 'principle-first') return '讲报错：**先讲原理，再给修法**。'
      if (value === 'fix-first') return '讲报错：**直接给修法**。'
      return null
    default:
      return null
  }
}

/**
 * 一组指令（顺序 = `TEACHING_PARAMS` 顺序 —— 保证同输入同字节）。
 * @param {Record<string, string|string[]>} params
 * @returns {string[]}
 */
export function teachingDirectives(params) {
  const out = []
  for (const id of Object.keys(TEACHING_PARAMS)) {
    const line = directiveFor(id, params?.[id])
    if (line) out.push(line)
  }
  return out
}

/**
 * 注入块（**唯一生成处**）：生成教学内容那一段把它整段拼进去。
 * @param {object|null} record 现行 TeachingRecord（null = 全默认，按 tier 1）
 * @returns {{ tier: number, params: object, directives: string[], block: string }}
 */
export function injectionBlock(record) {
  const { tier, params } = resolveParams(record)
  const directives = teachingDirectives(params)
  const block = [`⚙️ ${INJECTION_TITLE}（tier ${tier}）：`, ...directives.map((d) => `   · ${d}`)].join('\n')
  return { tier, params, directives, block }
}

/* ── 判据 ───────────────────────────────────────────────────── */

/** 四维的**启发式标记词**（只看词，不做语义理解；误报就往这里补） */
export const DIM_MARKERS = Object.freeze({
  what: Object.freeze(['做什么', '做什么的', '作用', '返回', '返回什么', '负责', '干了什么']),
  link: Object.freeze(['联动', '调用', '依赖', '上游', '下游', '传给', '由谁', '跟', '和谁']),
  req: Object.freeze(['需求', '要求', '对应', '验收', '为什么要有', '满足']),
  why: Object.freeze(['为什么', '原因', '因为', '考虑', '否则', '避免']),
})

/** 从 html 里抠出代码块（`<pre>`）的纯文本 */
function codeBlocks(html) {
  const out = []
  const re = /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi
  let m
  while ((m = re.exec(String(html || '')))) out.push(m[1].replace(/<[^>]+>/g, ''))
  return out
}

/** 一行算不算"有注释"（`//` `#` `--` `/*` `*` `<!--` 都认；空行与纯括号行不算代码行） */
const COMMENT_RE = /(^|\s)(\/\/|#|--|\/\*|\*|<!--)/
function splitLines(block) {
  return String(block).split('\n').map((l) => l.trim()).filter((l) => l && !/^[)\]}]+,?$/.test(l))
}
function isComment(l) { return COMMENT_RE.test(l) }
function isCode(l) { return !isComment(l) && !/^[)\]}]+,?$/.test(l) }

/**
 * **内容侧**判据（判生成物本身）：注释密度 / 注释维度。
 * @param {string} html 生成的课程页（或源文件）
 * @param {Record<string, string|string[]>} params
 * @returns {{id: string, ok: boolean|null, detail: string}[]}
 */
export function judgeTeachingContent(html, params) {
  const blocks = codeBlocks(html)
  const out = []
  const allComment = blocks.flatMap(splitLines).filter(isComment)

  // ① 注释密度
  const density = params?.commentDensity
  if (density === 'line') {
    // 「逐行注释」的**真语义**：每一条可执行代码行的**上一行**必须是注释。
    //（不是"统计非注释行里有多少是注释" —— 那恒等于 0，是个永远红的假判据）
    const bare = []
    let total = 0
    for (const b of blocks) {
      const ls = splitLines(b)
      for (let i = 0; i < ls.length; i++) {
        if (!isCode(ls[i])) continue
        total++
        const prev = i > 0 ? ls[i - 1] : ''
        if (!isComment(prev)) bare.push(ls[i])
      }
    }
    out.push({
      id: 'commentDensity',
      ok: total === 0 ? null : bare.length === 0,
      detail: total === 0
        ? '（这一页没有代码行 —— 逐行注释这条判不了）'
        : `逐行注释：${total - bare.length}/${total} 行有注释${bare.length ? `；没注释的第一行：${bare[0].slice(0, 40)}` : ''}`,
    })
  } else if (density === 'block') {
    const missing = blocks.filter((b) => !splitLines(b).some(isComment))
    out.push({
      id: 'commentDensity',
      ok: blocks.length === 0 ? null : missing.length === 0,
      detail: blocks.length === 0 ? '（这一页没有代码块）' : `逐块注释：${blocks.length - missing.length}/${blocks.length} 个代码块有注释`,
    })
  } else if (density === 'key') {
    out.push({ id: 'commentDensity', ok: null, detail: '「只关键行」是取舍不是覆盖率 —— **没有机械判据**（人工看）' })
  }

  // ② 注释维度（启发式：标记词）
  const dims = Array.isArray(params?.commentDims) ? params.commentDims : []
  if (dims.length) {
    const text = allComment.join('\n')
    const missing = dims.filter((d) => !(DIM_MARKERS[d] || []).some((k) => text.includes(k)))
    out.push({
      id: 'commentDims',
      ok: allComment.length === 0 ? null : missing.length === 0,
      detail: allComment.length === 0
        ? '（没有注释可查 —— 维度判不了）'
        : `注释维度：${dims.length - missing.length}/${dims.length} 维出现${missing.length ? `；没出现：${missing.join(' / ')}` : ''}（启发式：只看标记词）`,
    })
  }
  return out
}

/**
 * **注入侧**判据：生成话术里每条指令都在（参数改了 → 文本真变；参数没改 → 逐字节相同由调用方比）。
 * @param {string} text 生成教学内容那一段的话术
 * @param {Record<string, string|string[]>} params
 */
export function judgeTeachingInjection(text, params) {
  const want = teachingDirectives(params)
  const missing = want.filter((d) => !String(text || '').includes(d))
  return [{
    id: 'injection',
    ok: missing.length === 0 && want.length > 0,
    detail: missing.length ? `注入缺 ${missing.length} 条指令：${missing[0].slice(0, 30)}…` : `注入齐全（${want.length} 条指令）`,
  }]
}

/**
 * 汇总：内容侧 + 注入侧。`ok` 只看**判得了**的那些（`ok === null` 如实列在 `unjudged` 里）。
 * @param {{html?: string, injection?: string, params?: object, record?: object}} o
 */
export function judgeTeaching({ html, injection, params, record } = {}) {
  const p = params || resolveParams(record).params
  const checks = [
    ...(injection === undefined ? [] : judgeTeachingInjection(injection, p)),
    ...(html === undefined ? [] : judgeTeachingContent(html, p)),
  ]
  const unjudged = checks.filter((c) => c.ok === null).map((c) => c.id)
  const failed = checks.filter((c) => c.ok === false)
  return { ok: failed.length === 0, checks, unjudged, failed: failed.map((c) => c.id) }
}
