/** Explicit JVM adapter. Pure: no IO and no imports from state. */
const isJava = (rel) => /\.(java|kt)$/i.test(rel)
const base = (rel) => rel.split('/').pop()
const dirsOf = files => new Set(files.flatMap(f => f.split('/').slice(0,-1).map((_,i)=>f.split('/').slice(0,i+1).join('/'))))
export function validateAdapters(adapters = []) {
  if (!Array.isArray(adapters) || adapters.some(a => typeof a !== 'string' || a !== 'jvm')) throw new Error('未知或非法 adapters 声明：' + JSON.stringify(adapters))
  return [...new Set(adapters)].sort()
}
/* ── 内容解析（都是纯字符串处理）────────────────────────────── */

/** 注解名（只认大写开头：Javadoc 里的 `{@link}` 是小写，天然排除 ✓） */
export function parseAnnotations(text) {
  const src = stripJavaNoise(text)   // 与 parseEndpoints 同口径：注释里 `{@code @NotNull}` 不是真注解
  const out = new Set()
  for (const m of src.matchAll(/@([A-Z][A-Za-z0-9_]*)/g)) out.add(m[1])
  return [...out].sort()
}

const VERB = { Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Request: 'ANY' }

/**
 * 去掉 Java 的注释与字符串字面量之外的噪音（**注释**里写 `{@code @GetMapping("/x")}` 不是代码）。
 * 为什么必须有它：Javadoc 里常拿 `{@code @…}` 举例 —— 不剥注释就是**误报**，
 * 而这个探针的立场是「误报比漏报更坏」（学生会照着假端点改代码）。
 * 字符串字面量原样保留（`@GetMapping("/x")` 的引号是真参数）。
 */
export function stripJavaNoise(text) {
  const LIT = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g
  return String(text).replace(LIT, (m) => (/^\/[/*]/.test(m) ? ' ' : m))
}

/** 取 `@Name` 后面**括号平衡**的参数原文（没有括号 → { args: null, end }）。字符串里的括号不算数。 */
function annotationCall(text, at) {
  let i = at
  while (i < text.length && /[@A-Za-z0-9_.]/.test(text[i])) i++
  const name = text.slice(at + 1, i)
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] !== '(') return { name, args: null, end: i }
  let depth = 0
  const start = i
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++ }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (!depth) { i++; break } }
  }
  return { name, args: text.slice(start + 1, i - 1), end: i }
}

/**
 * 映射注解的参数 → 路径。**拿不准一律 `null`（不猜、不编）**：
 *   · `@GetMapping` / `@GetMapping()`            → `''`（裸注解：用类型级前缀）
 *   · `@GetMapping("/x")` / `('/x')`             → `/x`（后面还能跟别的属性）
 *   · `@GetMapping(value = "/x")` / `(path=…)`   → `/x`（value / path 必须打头）
 *   · 数组 `({"/a","/b"})`、常量 `(PATH)`、`(produces=…, value=…)` 等 → `null`（不报）
 */
function mappingPath(args) {
  if (args == null) return ''
  const s = args.trim()
  if (!s) return ''
  let m = /^(["'])((?:\\.|(?!\1).)*)\1(?:\s*,[\s\S]*)?$/.exec(s)
    || /^(?:value|path)\s*=\s*(["'])((?:\\.|(?!\1).)*)\1(?:\s*,[\s\S]*)?$/.exec(s)
  if (!m) return null
  return m[2]
}

/** 类型前缀与方法路径拼成**浏览器实际访问到的**路径。`/api` + `/tasks` → `/api/tasks`。 */
export function joinEndpointPath(prefix, path) {
  const p = String(prefix || '')
  const q = String(path || '')
  if (p && q) return p.replace(/\/+$/, '') + '/' + q.replace(/^\/+/, '')
  if (p) return p
  if (q) return q
  return '/'
}

/**
 * 端点解析（学生代码静态探针）。**误报比漏报更坏**：认不出的形态一律不报，绝不编路径。
 *
 * 支持的三种形态（2026-09-24 G 条扩到「类级前缀 + 裸注解」）：
 *   1. `@GetMapping("/x")` / `@GetMapping(value = "/x")` / `@GetMapping(path = "/x")` —— 逐字保持原样识别；
 *   2. **类级前缀拼接**：类上 `@RequestMapping("/api")` + 方法上 `@GetMapping("/tasks")` → `/api/tasks`
 *      （判据里的端点就是浏览器实际访问的全路径，见 `code/_hello-spring-boot/EXPECT.json` 的
 *      `PATCH /api/tasks/{id}/complete`）；
 *   3. **裸注解**：`@GetMapping`（无括号 / 无路径）→ 路径 = 类级前缀本身；类上也没有 → `/`
 *      （依据：Spring MVC 的无路径映射就挂在类型前缀上，没有前缀就是根路径 ——
 *      浏览器访问 `http://host:port/` 命中它；判据值要能跟 `/hello` 这类条目同一形状比对，
 *      空串会出现 `GET ` 这种比不了的值，所以取 `/`）。
 *
 * 不猜的地方（识别不出就**如实不报**）：
 *   · 注释里的假注解（`{@code @GetMapping}`）—— 先剥注释再解析；
 *   · 参数是数组 / 常量 / `value` 不打头的多属性写法 → 该条不报；
 *   · 类上有 `@RequestMapping` 但路径解析不出（数组 / 常量）→ **裸注解不报**
 *     （前缀未知时拼出来的任何 URL 都是猜的）。
 */
export function parseEndpoints(text, file) {
  const src = stripJavaNoise(text)
  const out = []

  // ── 类型声明：每个类型的位置 + 深度未知没关系 —— 方法上的映射归**最近的前一个类型声明**：
  //    嵌套类的方法归嵌套类（Spring 的类型级映射也不跨嵌套类），同文件第二个顶层类归它自己。
  const types = []
  for (const m of src.matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g)) {
    types.push({ name: m[1], at: m.index })
  }

  // ── 类型级 @RequestMapping：必须紧贴类型声明（两者之间不许有 `{` —— 有就说明它其实是上一个类的成员）──
  const classPrefix = new Map()   // type.at → { path: string|null }（null = 有前缀但解析不出）
  for (const t of types) {
    const before = src.slice(0, t.at)
    let best = null
    for (const m of before.matchAll(/@RequestMapping\b/g)) {
      const call = annotationCall(src, m.index)
      if (call.end > t.at) continue
      if (src.slice(call.end, t.at).includes('{')) continue
      best = call
    }
    if (!best) { classPrefix.set(t.at, { path: '' }); continue }
    classPrefix.set(t.at, { path: mappingPath(best.args) })
  }

  // ── 方法级映射（类型级那条上面已经消费掉了，这里按"最近的前一个类型"归属）──
  const taken = new Set()
  for (const t of types) {
    for (const m of src.slice(0, t.at).matchAll(/@RequestMapping\b/g)) {
      const call = annotationCall(src, m.index)
      if (call.end > t.at) continue
      if (src.slice(call.end, t.at).includes('{')) continue
      taken.add(m.index)
    }
  }

  for (const m of src.matchAll(/@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g)) {
    if (taken.has(m.index)) continue
    const call = annotationCall(src, m.index)
    const owner = [...types].reverse().find((t) => t.at < m.index)
    const path = mappingPath(call.args)
    if (path == null) continue                     // 认不出的形态：不报（不猜、不编）
    if (!owner) continue                           // 不在任何类型里（不是合法 Java）：不报
    const prefix = classPrefix.get(owner.at)
    if (!prefix) continue
    if (path === '' && prefix.path == null) continue   // 裸注解 + 前缀未知：不报（绝不猜一个 URL）
    out.push({ method: VERB[m[1]], path: joinEndpointPath(prefix.path ?? '', path), file })
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
  const files = [...allFiles].sort()
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

