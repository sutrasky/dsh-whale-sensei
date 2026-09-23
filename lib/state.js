/**
 * lib/state.js — 学生状态探针（纯函数层）
 * ------------------------------------------------------------------
 * 干什么：把学生工作区里的**事实**抽出来（有什么类/注解/端点/配置/依赖），
 * 再跟课程声明的**期望**（EXPECT.json）对照，算出"实现了什么 / 缺什么"。
 *
 * 词汇不是我编的：取自 `study/learning-records/0004-lesson1-mastered-lesson2-not-started.md`
 * 这份**人工**记录 —— 它说第1课达成（有 @RestController + @GetMapping("/hello")）、
 * 第2课未开始（model/service/controller/exception 四个包不存在、pom 里没有 validation）、
 * 并且点名要排除编辑器锁文件 `.LCKHelloController.java~` 与 `target/`。
 * 判据就是让本模块的结论**与那份人工记录一致**。
 *
 * 纯：不读盘、不看时钟、不写盘。确定性靠结构保证（全部排序、无时间戳）。
 */

/** 期望项支持的种类（**封闭集**：不认识的一律抛错，不静默忽略 ✗） */
export const STATE_KINDS = ['file', 'dir', 'annotation', 'endpoint', 'configKey', 'configValue', 'pomDependency', 'classSuffix']

/** 当成"学生代码/配置"来读的文本文件 */
const TEXT_RE = /\.(java|kt|xml|properties|yml|yaml)$/i
/** 构建产物 / 工具目录：不是学生写的，一律不进事实 */
const IGNORE_RE = /(^|\/)(target|build|out|dist|node_modules|\.git|\.mvn|\.idea|\.vscode)(\/|$)/
/** 编辑器残留：`.LCKHelloController.java~` / `.DS_Store` / `foo.java~` —— 人工记录里点名要排除 */
const JUNK_RE = /(^|\/)(\.[^/]*|[^/]*~)$/

const isJava = (rel) => /\.(java|kt)$/i.test(rel)
const base = (rel) => rel.split('/').pop()
const dirsOf = (files) => {
  const set = new Set()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'))
  }
  return set
}

/** 这个路径算不算学生自己的东西（构建产物与编辑器残留不算） */
export function isStudentFile(rel) {
  const p = String(rel).replace(/\\/g, '/')
  if (IGNORE_RE.test(p)) return false
  if (JUNK_RE.test(p)) return false
  return true
}

/** 这个路径要不要读进来做内容分析 */
export function isReadable(rel) {
  return isStudentFile(rel) && TEXT_RE.test(rel)
}

/* ── 内容解析（都是纯字符串处理）────────────────────────────── */

/** 注解名（只认大写开头：Javadoc 里的 `{@link}` 是小写，天然排除 ✓） */
export function parseAnnotations(text) {
  const out = new Set()
  for (const m of String(text).matchAll(/@([A-Z][A-Za-z0-9_]*)/g)) out.add(m[1])
  return [...out].sort()
}

const VERB = { Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Request: 'ANY' }

/** 端点：@GetMapping("/x") / @PostMapping(value = "/y") / @RequestMapping("/z") */
export function parseEndpoints(text, file) {
  const out = []
  const re = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/g
  for (const m of String(text).matchAll(re)) {
    out.push({ method: VERB[m[1]], path: m[2], file })
  }
  return out
}

/** 配置键：.properties 的 `k=v`，.yml 的顶层 `k:` */
export function parseConfigKeys(text, file) {
  const out = []
  if (/\.(properties)$/i.test(file)) {
    for (const m of String(text).matchAll(/^\s*([A-Za-z][\w.-]*)\s*=/gm)) out.push(m[1])
  } else if (/\.(ya?ml)$/i.test(file)) {
    for (const m of String(text).matchAll(/^([A-Za-z][\w.-]*):/gm)) out.push(m[1])
  }
  return out
}

/**
 * 配置键**与值**（规范成 `key=value`）。
 * 挑战里常写"把端口改成 8081"—— 只查"键存在"是查不出这一条的 ✗
 * @returns {string[]} 形如 `server.port=8081`
 */
export function parseConfigPairs(text, file) {
  const out = []
  const push = (k, v) => out.push(`${k}=${String(v).trim()}`)
  if (/\.(properties)$/i.test(file)) {
    for (const m of String(text).matchAll(/^\s*([A-Za-z][\w.-]*)\s*=\s*(.*)$/gm)) push(m[1], m[2])
  } else if (/\.(ya?ml)$/i.test(file)) {
    for (const m of String(text).matchAll(/^([A-Za-z][\w.-]*):\s*(.*)$/gm)) push(m[1], m[2])
  }
  return out
}

/** pom.xml 里的 artifactId（父工程、依赖、插件都收；匹配期望时按精确名对） */
export function parsePomArtifacts(text) {
  const out = new Set()
  for (const m of String(text).matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) out.add(m[1])
  return [...out].sort()
}

/* ── 事实抽取 ───────────────────────────────────────────── */

/**
 * 从"文件清单 + 文本内容"里抽出事实。**不做任何 IO**。
 * @param {string} dir 项目目录（POSIX 相对路径）
 * @param {string[]} allFiles 该项目下的全部路径（相对项目根）
 * @param {Map<string,string>} contents 路径 → 文本（只需给 isReadable 为真的）
 */
export function detectFacts(dir, allFiles, contents) {
  const files = allFiles.map((f) => f.replace(/\\/g, '/')).filter(isStudentFile).sort()
  const dirs = dirsOf(files).size ? [...dirsOf(files)].sort() : []

  const java = files.filter(isJava)
  const annotations = new Set()
  const endpoints = []
  const configKeys = new Set()
  const configPairs = new Set()
  const pomArtifacts = new Set()
  const classes = []

  for (const f of files) {
    const text = contents.get(f)
    if (text == null) continue
    if (isJava(f)) {
      for (const a of parseAnnotations(text)) annotations.add(a)
      for (const e of parseEndpoints(text, f)) endpoints.push(e)
      for (const m of String(text).matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g)) {
        classes.push({ name: m[1], file: f })
      }
    } else if (/(^|\/)pom\.xml$/.test(f)) {
      for (const a of parsePomArtifacts(text)) pomArtifacts.add(a)
    } else if (/\.(properties|ya?ml)$/i.test(f)) {
      for (const k of parseConfigKeys(text, f)) configKeys.add(k)
      for (const pair of parseConfigPairs(text, f)) configPairs.add(pair)
    }
  }

  const build = files.some((f) => /(^|\/)pom\.xml$/.test(f))
    ? 'maven'
    : files.some((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f))
      ? 'gradle'
      : null

  return {
    dir,
    build,
    files,
    dirs,
    java: {
      // ⚠️ 路径是**项目相对**的（`src/main/java/...`），开头没有斜杠 ——
      //    写成 /\/src\/main\// 会把全部主源都数成 0（实际输出里就是 0/0，判据没钉住 ✗）
      main: java.filter((f) => /(^|\/)src\/main\//.test(f)).map(base).sort(),
      test: java.filter((f) => /(^|\/)src\/test\//.test(f)).map(base).sort(),
    },
    classes: classes.sort((a, b) => a.name.localeCompare(b.name)),
    annotations: [...annotations].sort(),
    endpoints: endpoints
      .map((e) => ({ method: e.method, path: e.path, file: base(e.file) }))
      .sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method)),
    configKeys: [...configKeys].sort(),
    configValues: [...configPairs].sort(),
    pomArtifacts: [...pomArtifacts].sort(),
    built: dirs.some((d) => /(^|\/)target(\/|$)/.test(d) || /(^|\/)build(\/|$)/.test(d)),
  }
}

/* ── 期望校验 + 缺口计算 ─────────────────────────────────── */

/** 校验一份期望文档。坏输入一律抛错（课程包的规矩：不许静默降级） */
export function validateExpect(doc, where = 'EXPECT.json') {
  if (!doc || typeof doc !== 'object') throw new Error(`${where}：不是对象`)
  const lessons = doc.lessons
  if (!Array.isArray(lessons) || !lessons.length) throw new Error(`${where}：lessons 必须是非空数组`)
  const seenLesson = new Set()
  for (const l of lessons) {
    if (!l?.id) throw new Error(`${where}：每个 lesson 必须有 id`)
    if (seenLesson.has(l.id)) throw new Error(`${where}：lesson id 重复：${l.id}`)
    seenLesson.add(l.id)
    if (!Array.isArray(l.required) || !l.required.length) throw new Error(`${where}：${l.id} 的 required 必须是非空数组`)
    const seenReq = new Set()
    for (const r of l.required) {
      if (!r?.id) throw new Error(`${where}：${l.id} 有 required 项缺 id`)
      if (seenReq.has(r.id)) throw new Error(`${where}：${l.id} 的 required id 重复：${r.id}`)
      seenReq.add(r.id)
      if (!STATE_KINDS.includes(r.kind)) {
        throw new Error(`${where}：${l.id}/${r.id} 的 kind 不认识：${JSON.stringify(r.kind)}（可用：${STATE_KINDS.join(' / ')}）`)
      }
      if (typeof r.value !== 'string' || !r.value) throw new Error(`${where}：${l.id}/${r.id} 缺 value`)
    }

    // 挑战级判据（可选）：按**序号**对应课程源文件里 `<!--@challenges-->` 区块中第几个 <li>。
    // 用序号而不是 id —— 这样**课程页字节一个都不动**（改内容会牵动逐字节对拍）。
    if (l.challenges !== undefined) {
      if (!Array.isArray(l.challenges) || !l.challenges.length) {
        throw new Error(`${where}：${l.id} 的 challenges 给了就必须是非空数组（不给=不产出完成度）`)
      }
      const seenNo = new Set()
      for (const ch of l.challenges) {
        if (!Number.isSafeInteger(ch?.no) || ch.no <= 0) {
          throw new Error(`${where}：${l.id} 有挑战项缺合法 no（正整数序号，对应源文件里第几个挑战）`)
        }
        if (seenNo.has(ch.no)) throw new Error(`${where}：${l.id} 的挑战序号重复：${ch.no}`)
        seenNo.add(ch.no)
        // ⚠️ **每个挑战都必须有一句明确的产出**（哪怕是需人工确认的）——
        //    这是"让检查变容易"的前提：产出写得具体，判据就能直接从产出推出来，
        //    学生也知道要做成什么（改这条逻辑是 2026-09-22 的决定）
        if (typeof ch.deliverable !== 'string' || !ch.deliverable.trim()) {
          throw new Error(`${where}：${l.id} 挑战 ${ch.no} 缺 deliverable（一句话写清这题要做成什么）`)
        }
        if (ch.auto === false) {
          // 机器判不了的那类（"能解释清楚为什么"）：必须写明原因，且**不计入达成数**
          if (!ch.hint) throw new Error(`${where}：${l.id} 挑战 ${ch.no} 标了 auto:false，必须给 hint 说明为什么机器判不了`)
          continue
        }
        if (!Array.isArray(ch.checks) || !ch.checks.length) {
          throw new Error(`${where}：${l.id} 挑战 ${ch.no} 的 checks 必须是非空数组（判不了就把 auto 设成 false 并写 hint）`)
        }
        const seenCheck = new Set()
        for (const c of ch.checks) {
          if (!c?.id) throw new Error(`${where}：${l.id} 挑战 ${ch.no} 有 checks 项缺 id`)
          if (seenCheck.has(c.id)) throw new Error(`${where}：${l.id} 挑战 ${ch.no} 的 checks id 重复：${c.id}`)
          seenCheck.add(c.id)
          if (!STATE_KINDS.includes(c.kind)) {
            throw new Error(`${where}：${l.id}/挑战${ch.no}/${c.id} 的 kind 不认识：${JSON.stringify(c.kind)}（可用：${STATE_KINDS.join(' / ')}）`)
          }
          if (typeof c.value !== 'string' || !c.value) throw new Error(`${where}：${l.id}/挑战${ch.no}/${c.id} 缺 value`)
        }
      }
    }
  }
  return doc
}

/** 单条期望是否已满足？返回 { ok, evidence } —— evidence 要说清"看到了什么" */
export function checkRequirement(facts, req) {
  const v = req.value
  const has = (arr) => arr.some((x) => x === v)

  switch (req.kind) {
    case 'annotation': {
      const ok = has(facts.annotations)
      return { ok, evidence: ok ? `检测到 @${v}` : `没有 @${v}（现有注解：${facts.annotations.length ? facts.annotations.map((a) => '@' + a).join(' ') : '无'}）` }
    }
    case 'endpoint': {
      const [wantMethod, wantPath] = v.includes(' ') ? v.split(/\s+/) : [null, v]
      const hit = facts.endpoints.filter((e) => e.path === wantPath && (!wantMethod || e.method === wantMethod.toUpperCase()))
      const all = facts.endpoints.map((e) => `${e.method} ${e.path}`)
      return { ok: hit.length > 0, evidence: hit.length ? `有 ${hit.map((e) => e.method + ' ' + e.path).join('、')}` : `没有 ${v}（现有端点：${all.length ? all.join('、') : '无'}）` }
    }
    case 'configKey': {
      const ok = has(facts.configKeys)
      return { ok, evidence: ok ? `配置里有 ${v}` : `配置里没有 ${v}（现有键：${facts.configKeys.length ? facts.configKeys.join('、') : '无'}）` }
    }
    case 'configValue': {
      // 值写成 `key=value` 一个串（挑战里那句"把端口改成 8081"就是这一条）
      const ok = (facts.configValues || []).includes(v)
      return {
        ok,
        evidence: ok ? `配置里有 ${v}` : `配置里没有 ${v}（现有配置：${(facts.configValues || []).length ? facts.configValues.join('、') : '无'}）`,
      }
    }
    case 'pomDependency': {
      const ok = has(facts.pomArtifacts)
      return { ok, evidence: ok ? `pom 里有 ${v}` : `pom 里没有 ${v}` }
    }
    case 'file':
    case 'dir': {
      const pool = req.kind === 'file' ? facts.files : facts.dirs
      const hit = pool.filter((p) => (v.includes('*') ? globish(p, v) : p === v || base(p) === v))
      return { ok: hit.length > 0, evidence: hit.length ? `找到 ${hit.slice(0, 3).join('、')}` : `${req.kind === 'file' ? '文件' : '目录'}不存在：${v}` }
    }
    case 'classSuffix': {
      const hit = facts.classes.filter((c) => c.name.endsWith(v))
      return { ok: hit.length > 0, evidence: hit.length ? `找到 ${hit.map((c) => c.name).join('、')}` : `没有以 ${v} 结尾的类（现有类：${facts.classes.length ? facts.classes.map((c) => c.name).join('、') : '无'}）` }
    }
    default:
      // validateExpect 已经拦过，这里只是兜底（不许静默返回 false）
      throw new Error(`未知的 kind：${req.kind}`)
  }
}

function globish(p, pattern) {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
  return re.test(p) || re.test(base(p))
}

/**
 * 挑战级判定（**单一真源，抽出导出**）：三态（达成 / 未达成 / 需人工确认）。
 * 刻意**不给百分比** —— 有"需人工确认"的项时，百分比必然是假的 ✗
 * 为什么导出：`computeGaps` 与 ② 的终点验收（goals.jsonl 的 acceptance）**共用这一台**，
 * 不许再写第二份挑战判定（A1 裁定：判据引擎单一真源）。
 * @param {object} facts 学生工作区事实（detectFacts 的产物）
 * @param {object[]|null|undefined} challenges 挑战判据（validateExpect 校验过的形态）
 * @returns {{challenges: object[], achieved: number, total: number, needsReview: number}}
 */
export function judgeChallenges(facts, challenges) {
  const results = []
  let achieved = 0
  let autoTotal = 0
  let needsReview = 0
  for (const ch of challenges || []) {
    if (ch.auto === false) {
      needsReview += 1
      results.push({ no: ch.no, hint: ch.hint || '', deliverable: ch.deliverable, done: null, needsReview: true, satisfied: [], missing: [] })
      continue
    }
    autoTotal += 1
    const cs = []
    const cm = []
    for (const c of ch.checks) {
      const r = checkRequirement(facts, c)
      const item = { id: c.id, kind: c.kind, value: c.value, hint: c.hint || '', evidence: r.evidence }
      ;(r.ok ? cs : cm).push(item)
    }
    if (cm.length === 0) achieved += 1
    results.push({ no: ch.no, hint: ch.hint || '', deliverable: ch.deliverable, done: cm.length === 0, needsReview: false, satisfied: cs, missing: cm })
  }
  return { challenges: results, achieved, total: autoTotal, needsReview }
}

/**
 * 逐课算缺口。
 * @returns {{id, title, satisfied: object[], missing: object[]}[]}
 */
export function computeGaps(facts, expectDoc) {
  const doc = validateExpect(expectDoc)
  return doc.lessons.map((l) => {
    const satisfied = []
    const missing = []
    for (const req of l.required) {
      const r = checkRequirement(facts, req)
      const item = { id: req.id, kind: req.kind, value: req.value, hint: req.hint || '', evidence: r.evidence }
      ;(r.ok ? satisfied : missing).push(item)
    }

    // 挑战级：三态判定住在 judgeChallenges（单一真源，② 终点验收也调它）
    const judged = judgeChallenges(facts, l.challenges)
    const declared = (l.challenges || []).length > 0

    return {
      id: l.id,
      title: l.title || '',
      satisfied,
      missing,
      done: missing.length === 0,
      // 没声明 challenges 的课 → declared=false，**不产出完成度**（不猜）
      challenges: declared ? judged.challenges : null,
      challengeSummary: declared ? { achieved: judged.achieved, total: judged.total, needsReview: judged.needsReview } : null,
    }
  })
}

/* ── 组装最终 state ─────────────────────────────────────── */

/**
 * @param {{pack: object, projects: object[], signals: object, expects: Map<string, object|null>, codeDir?: string, digests?: Map<string, string>}} input
 *   `codeDir` = 探针扫描根（相对包根，默认 "code"）；`digests` = 每项目的内容指纹
 */
export function buildState({ pack = {}, projects = [], signals = {}, expects = new Map(), codeDir = 'code', digests = new Map() }) {
  const notes = []
  // ⚠️ readPack 给的是**数组**（circles/points/lessons 是对象数组，learned 是 id 字符串数组）——
  //    当成数字直接用会打出 `[object Object]`（实际输出里踩过 ✗）。这里一律折成计数。
  const count = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0)
  const lit = Array.isArray(pack.lessons)
    ? pack.lessons.filter((l) => l && l.learned).length
    : count(pack.learned)
  const out = projects.map((p) => {
    const doc = expects.get(p.facts.dir) ?? null
    // ⚠️ 不许 `...p` 整个摊开：扫描时挂过 `_contents`（一个 Map），摊开就会漏进 state，
    //    宿主直接拒收（"value is not lossless JSON"）✗ —— 现场踩过。只取 facts。
    const facts = p.facts
    // 内容指纹（无时间戳、纯输入函数）：点亮时比对新鲜度用（对不上 = 快照过期）
    const sourceDigest = p.sourceDigest ?? digests.get(facts.dir) ?? null
    if (!doc) {
      notes.push(`${facts.dir}：没有 EXPECT.json —— **未声明期望**，只报事实，不猜缺什么`)
      return { dir: facts.dir, facts, expect: null, lessons: [], sourceDigest }
    }
    return { dir: facts.dir, facts, expect: { lessons: doc.lessons.length }, lessons: computeGaps(facts, doc), sourceDigest }
  })
  return {
    version: 1,
    // 探针扫描根（相对包根）：包侧 ask-server 据此定位项目目录算新鲜度
    codeDir,
    // ⚠️ 故意不写时间戳：state.json 要可对拍（同样的工作区 → 逐字节相同的 state）
    pack: {
      circles: count(pack.circles),
      points: count(pack.points),
      lessons: count(pack.lessons),
      learned: lit,
    },
    projects: out,
    signals,
    notes,
  }
}

/**
 * 无损 JSON 自检：state 要能被宿主原样收下，也要能被逐字节对拍。
 * **凡是 Map / Set / Date / undefined / 函数 / 非有限数字 / 自定义原型对象，一律点名报错。**
 * 为什么必须有：`JSON.stringify` 会把 Map 悄悄变成 `{}`，用它当判据会**掩盖**这类错误
 * —— 本模块就是这么把 `_contents` 漏进 state、被宿主以 "value is not lossless JSON" 拒收的 ✗
 */
export function assertLosslessJson(value, where = 'value') {
  const bad = []
  const walk = (v, p) => {
    if (v === null) return
    const t = typeof v
    if (t === 'string' || t === 'boolean') return
    if (t === 'number') {
      if (!Number.isFinite(v)) bad.push(`${p}：非有限数字 ${v}`)
      return
    }
    if (t === 'undefined') return void bad.push(`${p}：undefined`)
    if (t === 'function' || t === 'symbol' || t === 'bigint') return void bad.push(`${p}：${t}`)
    if (Array.isArray(v)) return void v.forEach((x, i) => walk(x, `${p}[${i}]`))
    if (v instanceof Map || v instanceof Set || v instanceof Date) {
      return void bad.push(`${p}：${v.constructor.name} 不是 JSON 类型`)
    }
    if (t === 'object') {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        return void bad.push(`${p}：非普通对象（${proto?.constructor?.name || '未知原型'}）`)
      }
      for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`)
      return
    }
    bad.push(`${p}：未知类型 ${t}`)
  }
  walk(value, where)
  if (bad.length) {
    throw new Error(`不是无损 JSON：${bad.slice(0, 5).join('；')}${bad.length > 5 ? ` …还有 ${bad.length - 5} 处` : ''}`)
  }
  return value
}

/** 给人看的摘要（不是给机器读的 state） */
export function summarizeState(state) {
  const lines = []
  for (const p of state.projects) {
    const f = p.facts
    lines.push(`${f.dir}（${f.build || '无构建文件'}）· 主源 ${f.java.main.length} / 测试 ${f.java.test.length} · 端点 ${f.endpoints.length} · 注解 ${f.annotations.length}${f.built ? ' · 已构建' : ''}`)
    for (const l of p.lessons) {
      lines.push(`  ${l.done ? '✓' : '✗'} ${l.id} ${l.title}：满足 ${l.satisfied.length} / 缺 ${l.missing.length}${l.missing.length ? ' → ' + l.missing.map((m) => m.hint || m.id).join('、') : ''}`)
      // 挑战级完成度：**只报 k/n + 需人工确认 m**，不给百分比（有"需人工确认"时百分比必然是假的）
      if (l.challengeSummary) {
        const c = l.challengeSummary
        const missCh = (l.challenges || []).filter((x) => x.done === false)
        lines.push(
          `      挑战：达成 ${c.achieved} / 共 ${c.total}${c.needsReview ? `（另有 ${c.needsReview} 项需人工确认）` : ''}`
            + (missCh.length ? ` → 未过：${missCh.map((x) => `第${x.no}题（产出：${x.deliverable || x.hint}）`).join('、')}` : '')
        )
        for (const x of l.challenges || []) {
          if (x.needsReview) lines.push(`      ⚠️ 第${x.no}题需人工确认（产出：${x.deliverable || x.hint}）：${x.hint}`)
        }
      } else if (l.challenges === null) {
        lines.push('      挑战：（未声明判据 —— 不猜完成度）')
      }
    }
    if (!p.lessons.length) lines.push('  （未声明期望，只报事实）')
  }
  const s = state.signals
  lines.push(`学生信号：待答提问 ${s.pendingQuestions} · 已答 ${s.processedQuestions} · 笔记 ${s.notes} · 学习记录 ${s.records} 份 · 已点亮课程 ${state.pack.learned}/${state.pack.lessons}`)
  return lines
}
