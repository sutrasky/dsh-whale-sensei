/**
 * _result.mjs —— **机器结果协议 + 旧文本协议的严格 adapter**（T01 / F01）
 * ------------------------------------------------------------------
 * 为什么要有这一层：报告 F01 实测过，旧总入口只看「摘要文本」——
 *   ① 子进程先打印全绿再崩溃（exit2）→ 旧入口照样 exit0
 *   ② 摘要写「全部通过」但正文有红行 → 旧入口照样绿
 *   ③ 0/0（根本没跑）→ 旧入口照样绿
 *   ④ 同一段输出里出现两条摘要 → 旧入口只认第一条
 * 所以「解析到摘要」不等于「真的跑过」。本文件把两件事分开：
 *   - **机器结果**（七项）：`{passed, failed, skipped, reason, packRoot, base, cases}`
 *   - **旧文本 adapter**：仍然读人写的那两行摘要，但逐项对账
 *     （摘要唯一 / 红行逐条 / 执行量非零 / 摘要与红行不矛盾 / 退出码为 0），
 *     任何一项对不上就是**红**，绝不为了兼容旧输出降级放行。
 *
 * 零副作用：本文件只读盘（`readRunResult` 读一个 JSON），不写任何东西。
 */
import fs from 'node:fs'

/** 机器结果的七个字段（顺序即协议顺序） */
export const RESULT_FIELDS = ['passed', 'failed', 'skipped', 'reason', 'packRoot', 'base', 'cases']

/** 一条用例的三种状态。**skip 是独立一档，绝不计进 passed。** */
export const CASE_STATES = ['pass', 'fail', 'skip']

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0
const tail = (out, n = 12) => String(out ?? '').split('\n').slice(-n).join('\n')

/**
 * 造一条**机器结果**（七项齐全）。调用方负责把 cases 说清楚。
 * @param {{packRoot?: string, base?: string, cases?: Array, reason?: string|null, skipped?: number, exitCode?: number|null}} spec
 */
export function makeRunResult(spec = {}) {
  const cases = Array.isArray(spec.cases) ? spec.cases.map(normalizeCase) : []
  const passed = cases.filter((c) => c.status === 'pass').length
  const failed = cases.filter((c) => c.status === 'fail').length
  const skipped = isNonNegInt(spec.skipped) ? spec.skipped : cases.filter((c) => c.status === 'skip').length
  // 红了就必须说得出为什么：调用方没给 reason 时，用失败用例的 id 兜底（**不许留空**）
  let reason = spec.reason ?? null
  if (failed > 0 && !(typeof reason === 'string' && reason.trim())) {
    const ids = cases.filter((c) => c.status === 'fail').map((c) => c.id).slice(0, 8)
    reason = `失败 ${failed} 项：${ids.join('、')}${failed > ids.length ? ' …' : ''}`
  }
  return { passed, failed, skipped, reason, packRoot: spec.packRoot ?? null, base: spec.base ?? null, cases }
}

function normalizeCase(c) {
  const out = { id: String(c?.id ?? ''), status: CASE_STATES.includes(c?.status) ? c.status : 'fail' }
  if (c?.note != null) out.note = String(c.note)
  if (c?.exitCode != null) out.exitCode = c.exitCode
  // T02（F02）：子进程自报的测试上下文（`ctx=fixture/<绝对包根>`）随用例一起带出来 ——
  // 「env=A、参数=B 时所有子进程只报 B」这条判据就落在它上面。**不参与判定**，只是台账。
  if (c?.ctx != null) out.ctx = String(c.ctx)
  return out
}

/**
 * 校验机器结果：七项齐全、类型对、**计数与 cases 自洽**、有执行量。
 * @returns {{ok: boolean, errors: string[], counts: {passed:number, failed:number, skipped:number}, cases: Array}}
 */
export function validateRunResult(result) {
  const errors = []
  const cases = []
  if (!isObj(result)) {
    return { ok: false, errors: ['机器结果不是对象'], counts: { passed: 0, failed: 0, skipped: 0 }, cases }
  }
  for (const k of RESULT_FIELDS) {
    if (!(k in result)) errors.push(`缺字段 ${k}`)
  }
  if (!isNonNegInt(result.passed)) errors.push('passed 不是非负整数')
  if (!isNonNegInt(result.failed)) errors.push('failed 不是非负整数')
  if (!isNonNegInt(result.skipped)) errors.push('skipped 不是非负整数')
  if (!(result.reason == null || typeof result.reason === 'string')) errors.push('reason 不是字符串或 null')
  if (!(result.packRoot == null || typeof result.packRoot === 'string')) errors.push('packRoot 不是字符串或 null')
  if (!(result.base == null || typeof result.base === 'string')) errors.push('base 不是字符串或 null')
  if (!Array.isArray(result.cases)) {
    errors.push('cases 不是数组')
  } else {
    if (result.cases.length === 0) errors.push('cases 是空的（没有任何用例执行记录）')
    const seen = new Set()
    for (const [i, c] of result.cases.entries()) {
      if (!isObj(c)) { errors.push(`cases[${i}] 不是对象`); continue }
      if (typeof c.id !== 'string' || !c.id) errors.push(`cases[${i}].id 缺失`)
      if (!CASE_STATES.includes(c.status)) errors.push(`cases[${i}].status 不是 ${CASE_STATES.join('/')}`)
      if (c.id) {
        if (seen.has(c.id)) errors.push(`cases 里 id 重复：${c.id}`)
        seen.add(c.id)
      }
      cases.push(c)
    }
    const nPass = cases.filter((c) => c.status === 'pass').length
    const nFail = cases.filter((c) => c.status === 'fail').length
    const nSkip = cases.filter((c) => c.status === 'skip').length
    if (isNonNegInt(result.passed) && result.passed !== nPass) errors.push(`passed=${result.passed} 与 cases 里 ${nPass} 条 pass 不符`)
    if (isNonNegInt(result.failed) && result.failed !== nFail) errors.push(`failed=${result.failed} 与 cases 里 ${nFail} 条 fail 不符`)
    if (isNonNegInt(result.skipped) && result.skipped < nSkip) errors.push(`skipped=${result.skipped} 少于 cases 里 ${nSkip} 条 skip（skip 必须单列）`)
  }
  if (isNonNegInt(result.passed) && isNonNegInt(result.failed)) {
    if (result.passed + result.failed === 0) errors.push('passed+failed=0：这条结果没有任何执行量（空账不算通过）')
    if (result.failed > 0 && !(typeof result.reason === 'string' && result.reason.trim())) errors.push('failed>0 但 reason 是空的（红了要说出为什么）')
  }
  return { ok: errors.length === 0, errors, counts: { passed: result.passed, failed: result.failed, skipped: result.skipped }, cases }
}

/** 读一条落盘的机器结果。读不到/不是 JSON → ok:false（调用方按红处理，不按 0/0） */
export function readRunResult(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, errors: [`结果文件不存在：${file ?? '(未给路径)'}`], raw: null }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, errors: [`结果文件读不出：${e.message}`], raw: null }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, errors: [`结果文件不是 JSON：${e.message}`], raw: raw.slice(0, 400) }
  }
  const v = validateRunResult(parsed)
  return { ...v, raw: parsed }
}

/** 摘要行（人写的那两行）——adapter 认的就是它们 */
const GATE_LINE = /^\s*={2,}\s*闸门：(\d+)\s*\/\s*(\d+)\s*通过([^\n]*)$/gm
/**
 * 套件摘要：**必须同时带「N 套」和「M 条断言」**（那才是 run-all 的那一行）。
 * 为什么这么严：单套自己的 `=== 9 通过 / 0 失败 ===` 也很像摘要 ——
 * 报告 F01 的教训就是「只认长得像摘要的行」会被假摘要骗。
 */
const SUITE_LINE = /^\s*={2,}\s*(\d+)\s*套[^\n]*?共\s*(\d+)\s*条断言[^\n]*$/gm
/** 单套自己的摘要：`=== 9 通过 / 0 失败 ===`（只给条数，不给套数；前后可能有 ✅ 之类的装饰） */
const ONE_SUITE_LINE = /^\s*[^\d\s=]{0,4}\s*={2,}\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*={2,}\s*$/gm

/**
 * **旧文本协议 → 机器结果** 的严格 adapter。
 *
 * 与旧解析器的区别（每一条都是报告 F01 的假绿入口）：
 *   ① 摘要必须**恰好一条**（两条摘要 = 红，哪怕两条都写「全绿」）
 *   ② 摘要声称的失败数必须**与正文红行逐条对得上**（"全部通过" + 一条红行 = 红）
 *   ③ 执行量必须**非零**（0/0 不算跑过）
 *   ④ 子进程退出码必须为 0（先打全绿再崩 = 红）—— 调用方把 code 传进来
 *   ⑤ 解析不到摘要 = 红（不按 0/0）
 *
 * @param {{kind: 'gate'|'suites'|'one-suite', out: string, code: number|null, label?: string}} spec
 *   `one-suite` = 单套自己的 `=== N 通过 / M 失败 ===`（run-all 逐套对账用）。
 * @returns {{ok:boolean, parsed:boolean, kind:string, passed:number, failed:number, skipped:number,
 *            cases:Array, reason:string|null, redLines:string[], summaries:number, rawTail:string}}
 */
export function adaptLegacyText(spec = {}) {
  const kind = spec.kind === 'suites' ? 'suites' : (spec.kind === 'one-suite' ? 'one-suite' : 'gate')
  const out = String(spec.out ?? '')
  const code = spec.code == null ? null : Number(spec.code)
  const label = spec.label ?? kind
  const rx = kind === 'gate' ? GATE_LINE : (kind === 'one-suite' ? ONE_SUITE_LINE : SUITE_LINE)
  const hits = [...out.matchAll(rx)]
  // 红行**只在行首**（`✗ name` / `FAIL name`）—— 缩进的红行是别人打出来的细节，不是本层的失败项。
  // 放宽到 `\s*` 就会把套件内部的 `    ✗ 某条` 也算进来，于是「红套件 6 个 vs 红行 24 条」对不上（F01 的同类坑）。
  const redLines = [...out.matchAll(/^(?:FAIL|✗)\s+(.+)$/gm)].map((m) => m[1].trim())
  /** 红行去掉行首标记后的内容（点名套件/用例时用） */
  const redNames = redLines.map((l) => l.replace(/^(?:FAIL|✗)\s*/, ''))
  const red = (reason, extra = {}) => ({
    ok: false,
    parsed: hits.length > 0,
    kind,
    passed: 0,
    failed: Math.max(1, redLines.length),
    skipped: 0,
    fails: redLines,
    cases: [{ id: `${label}:adapter`, status: 'fail', note: reason }],
    reason,
    redLines,
    summaries: hits.length,
    rawTail: tail(out),
    ...extra,
  })

  if (hits.length === 0) return red(`解析不到${kind === 'gate' ? '闸门' : '套件'}摘要行（判失败，不按 0/0）`)
  if (hits.length > 1) return red(`摘要行出现了 ${hits.length} 次（摘要必须唯一；重复摘要一律判红）`)

  const m = hits[0]
  const first = Number(m[1])
  const second = Number(m[2])
  if (kind === 'gate') {
    const pass = first
    const total = second
    const saysGreen = /全绿/.test(m[3] ?? '')
    if (total === 0) return red('闸门执行量是 0（0/0 不算跑过）', { pass, total })
    if (pass + redLines.length > total) return red(`闸门摘要 ${pass}/${total} 与 ${redLines.length} 条红行矛盾（数字对不上）`, { pass, total })
    if (redLines.length > 0) return red(`闸门摘要说通过，正文却有 ${redLines.length} 条红行（矛盾摘要）`, { pass, total })
    if (saysGreen && pass !== total) return red(`闸门写着「全绿」却只有 ${pass}/${total}`, { pass, total })
    if (pass !== total) return red(`闸门 ${pass}/${total}：有没过的项`, { pass, total })
    if (code !== null && code !== 0) return red(`闸门摘要全绿，但子进程退出码是 ${code}（先打绿再崩 = 红）`, { pass, total })
    return {
      ok: true, parsed: true, kind, passed: total, failed: 0, skipped: 0, pass, total, fails: [],
      cases: [{ id: `${label}:gate`, status: 'pass', note: `${pass}/${total} 通过` }],
      reason: null, redLines, summaries: 1, rawTail: tail(out),
    }
  }

  if (kind === 'one-suite') {
    // 单套自己的摘要：`=== 9 通过 / 0 失败 ===`。
    // 它**只给条数、不给套数**，所以这里逐项对账：条数 vs 正文红行 vs 退出码。
    const pass = first
    const fail = second
    if (pass + fail === 0) return red('套件执行量是 0（0 通过 0 失败不算跑过）', { asserts: 0, bad: [] })
    if (fail !== redLines.length) return red(`套件摘要说 ${fail} 条失败，正文红行 ${redLines.length} 条（逐项对不上）`, { asserts: pass + fail, bad: redNames })
    if (fail > 0) {
      if (code === null || code === 0) return red(`套件摘要 ${pass} 通过 / ${fail} 失败，但退出码是 ${code === null ? '崩了(无退出码)' : code}（账不对）`, { asserts: pass + fail, bad: redNames })
      return {
        ok: false, parsed: true, kind, passed: pass, failed: fail, skipped: 0, asserts: pass + fail, bad: redNames,
        cases: redNames.map((l, i) => ({ id: `${label}:${l.split(/\s+/)[0]}`, status: 'fail', note: l })),
        reason: `${fail} 条失败`, redLines, summaries: 1, rawTail: tail(out),
      }
    }
    if (code !== null && code !== 0) return red(`套件摘要 ${pass} 通过 / 0 失败，但子进程退出码是 ${code}（先打绿再崩 = 红）`, { asserts: pass, bad: [] })
    return {
      ok: true, parsed: true, kind, passed: pass, failed: 0, skipped: 0, asserts: pass, bad: [],
      cases: [{ id: `${label}:suite`, status: 'pass', note: `${pass} 通过` }],
      reason: null, redLines, summaries: 1, rawTail: tail(out),
    }
  }

  const suites = first
  const asserts = second
  const tailText = String(m[0] ?? '').replace(/^\s*={2,}\s*\d+\s*套[^\n]*?共\s*\d+\s*条断言/, '').trim()
  const claimed = tailText.match(/(\d+)\s*套失败/)
  const saysAllPass = /全部通过/.test(tailText)
  if (suites === 0 && asserts === 0) return red('套件执行量是 0（0 套 0 条不算跑过）', { suites, asserts, bad: [] })
  if (saysAllPass && redLines.length > 0) return red(`套件摘要说「全部通过」，正文却有 ${redLines.length} 条红行（矛盾摘要）`, { suites, asserts, bad: redLines })
  if (claimed) {
    const n = Number(claimed[1])
    const bad = [...new Set(redNames.map((l) => l.split(/\s+/)[0]))]
    if (n === 0) return red('套件摘要写「0 套失败」——这是矛盾摘要（红了就要点名）', { suites, asserts, bad })
    if (n > redLines.length) return red(`套件摘要说 ${n} 套失败，正文只列出 ${redLines.length} 条红行（逐项对不上）`, { suites, asserts, bad })
    if (code !== null && code !== 0) return red(`套件摘要 ${n} 套失败且退出码 ${code}`, { suites, asserts, bad })
    return {
      ok: false, parsed: true, kind, passed: Math.max(0, asserts), failed: Math.max(n, redLines.length), skipped: 0,
      suites, asserts, bad,
      cases: redLines.map((l, i) => ({ id: `${label}:${redNames[i].split(/\s+/)[0]}`, status: 'fail', note: redNames[i] })),
      reason: `${n} 套失败`, redLines, summaries: 1, rawTail: tail(out),
    }
  }
  if (!saysAllPass) return red(`套件摘要既不说「全部通过」也不说「N 套失败」：${tailText || '(空)'}`, { suites, asserts, bad: [] })
  if (asserts === 0) return red('套件摘要说全部通过，但执行量是 0 条断言（空账不算通过）', { suites, asserts, bad: [] })
  if (suites === 0) return red('套件摘要说全部通过，但一套都没跑', { suites, asserts, bad: [] })
  if (code !== null && code !== 0) return red(`套件摘要全绿，但子进程退出码是 ${code}（先打绿再崩 = 红）`, { suites, asserts, bad: [] })
  return {
    ok: true, parsed: true, kind, passed: asserts, failed: 0, skipped: 0, suites, asserts, bad: [],
    cases: [{ id: `${label}:suites`, status: 'pass', note: `${suites} 套 · ${asserts} 条断言` }],
    reason: null, redLines, summaries: 1, rawTail: tail(out),
  }
}

/**
 * 把若干份 adapter 结论合成一条机器结果。
 * **skip 单列**：任何一份说 skip 就记 skip，绝不记成 pass。
 * @param {{packRoot?:string, base?:string, parts?:Array}} spec
 */
export function mergeRunResults(spec = {}) {
  const parts = Array.isArray(spec.parts) ? spec.parts : []
  const cases = []
  let passed = 0
  let failed = 0
  let skipped = 0
  const reasons = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') { failed++; reasons.push('有一份执行记录不是对象'); continue }
    const cs = Array.isArray(p.cases) ? p.cases : []
    cases.push(...cs.map(normalizeCase))
    passed += isNonNegInt(p.passed) ? p.passed : 0
    failed += isNonNegInt(p.failed) ? p.failed : 0
    skipped += isNonNegInt(p.skipped) ? p.skipped : 0
    if (p.reason) reasons.push(String(p.reason))
  }
  return {
    passed,
    failed,
    skipped,
    reason: failed > 0 ? (reasons.join('；') || '有红项') : null,
    packRoot: spec.packRoot ?? null,
    base: spec.base ?? null,
    cases,
  }
}

/** 给一条机器结果补上「人读的」那几行 + 判词。判词只由 failed 决定，skip 不改判词颜色。 */
export function verdictOf(result) {
  const green = isObj(result) && isNonNegInt(result.failed) && result.failed === 0
    && isNonNegInt(result.passed) && result.passed + (result.skipped ?? 0) > 0
  const skipped = isNonNegInt(result?.skipped) ? result.skipped : 0
  const verdict = !green
    ? '红'
    : (skipped > 0 ? `绿（含 ${skipped} 项跳过）` : '绿')
  return { green, verdict, skipped }
}
