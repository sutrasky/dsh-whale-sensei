/**
 * profile-packroot.js — 把 `packRoot` 写进 **profile 层**的 `cordis.patch.yml`
 * ------------------------------------------------------------------
 * 为什么写这一层：包内的 `cordis.patch.yml` 随包分发、**重装会被覆盖**，
 * 所以机器本地值必须写 profile 那层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）。
 *
 * 为什么不能只改内存：`packRoot` 在宿主**启动时解析一次**。设置页选完目录后，
 * 本次会话靠 `hctx.paths.packRoot` 立即生效；要"重启后还算数"，就得落盘这一份。
 *
 * ⚠️ **补丁行会整体替换该 id 的 `config`** —— 所以这里是**就地改一行**，
 *    已有字段（`announceDir` / `announceOnBoot` / `stylesDir` …）一个都不许丢。
 *    这条规则与 `install-whale-sensei.ps1 -PackRoot` 是同一条（两份实现，各自有测试）。
 *
 * 契约：
 *   patchPackRootYml(text, packRoot) -> { text, changed: 'replace'|'insert'|'append', note }
 *                                      （**纯文本变换**：不解析、不校验、碰到坏文本也照样返回 text）
 *   writeProfilePackRoot(packRoot, opts) -> { ok, file?, changed?, note?, backup?, rule?, error? }
 *                                      （**落盘路径**：写前过两道闸 —— checkPackRootYml 的形状闸 +
 *                                        文件内 parseOverlayYml/validateOverlayYml 的真解析/结构闸；
 *                                        不过 ⇒ ok:false + rule + error，一个字节都不写、连备份都不建）
 *   checkPackRootYml(text) -> { ok, rule, reason }   （T22-R2：只判形状、不改文本；与安装器
 *                        install-whale-sensei.ps1#Test-PatchedYmlShape 同一套口径，逐例同判）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NEXT_RE = /^\s*-\s+\S/
/** 流式序列/映射里"提到 whale-sensei"的判据（两侧同一口径，见下面的 checkPackRootYml） */
const WHALE_TOKEN_RE = /(^|[^\w-])whale-sensei([^\w-]|$)/

/**
 * 解析一行列表项的 id 头 —— **与 PS 侧 `install-whale-sensei.ps1#Test-PatchedYmlShape` 同一套口径**
 * （T22-R2 第二批）：两侧对同一份文本必须给出同一个形状判定。
 *   `- id: whale-sensei` / `- id: 'whale-sensei'` / `- id: "whale-sensei"`  → scalar
 *   `- id: [whale-sensei]` / `- id: {name: whale-sensei}`                    → non-scalar（mentions=true）
 * 认不出来返回 null。纯函数：不碰盘、不起子进程。
 * @returns {{ind:string, kind:'scalar'|'non-scalar', value:string, mentions:boolean}|null}
 */
function parseIdHead(line) {
  const m = /^(\s*)-\s*id:\s*(.*?)\s*$/.exec(String(line ?? ''))
  if (!m) return null
  const ind = m[1]
  const raw = m[2]
  if (raw === '') return { ind, kind: 'scalar', value: '', mentions: false }
  const c = raw[0]
  if (c === '[' || c === '{') return { ind, kind: 'non-scalar', value: raw, mentions: WHALE_TOKEN_RE.test(raw) }
  if ((c === "'" || c === '"') && raw.length >= 2 && raw[raw.length - 1] === c) {
    return { ind, kind: 'scalar', value: raw.slice(1, -1), mentions: false }
  }
  return { ind, kind: 'scalar', value: raw, mentions: false }
}

/** 单引号 YAML 标量：反斜杠转正斜杠（与仓库既有写法一致），单引号翻倍转义 */
function yamlScalar(v) {
  return `'${String(v).replace(/\\/g, '/').replace(/'/g, "''")}'`
}

// ──────────────────────────────────────────────────────────────────────
// 真 YAML 解析 + 叠加层结构校验（**本文件内部**，不导出 —— 导出面不变）
//
// 为什么要有这一份：2026-10-19 现场那个事故的根因是"写完了却没解析过"。
// 新建 profile 的 `cordis.patch.yml` 出厂只有一行 `[]`（空流式序列根），
// 往后追一段块序列就成了**两个 YAML 根** ⇒ 宿主启动时
// `failed to parse overlay … end of the stream or a document separator is expected`，
// 而这条路径一路回"已追加 / 已写入 profile 配置，重启宿主后依然生效"，
// 用户照着重启就再也起不来。所以落盘前必须**真的解析一遍候选字节**。
//
// 支持的子集 = profile 叠加层会出现的那些：注释 / 空行 / `---` 文档分隔 / 块序列 /
// 块映射 / 流式 [..] {..} / 单双引号标量（含 '' 与反斜杠转义）/ 标量类型解析。
// **解析不了就拒写**，不拿正则猜结构：两个根、缩进坏、标签错、未闭合流式、
// 标量后拖尾、重复键都必须判得出来。
// ──────────────────────────────────────────────────────────────────────

class OverlayYamlError extends Error {
  constructor(rule, reason, line) {
    super(reason)
    this.name = 'OverlayYamlError'
    this.rule = rule
    this.reason = reason
    this.line = line
  }
}

/** 去掉行尾注释：`#` 必须在行首或前面是空白，并且不在引号里 */
function stripYamlComment(line) {
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q === "'") { if (c === "'") { if (line[i + 1] === "'") i++; else q = null } continue }
    if (q === '"') { if (c === '\\') i++; else if (c === '"') q = null; continue }
    if (c === "'" || c === '"') { q = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * 切行：去注释、丢空行、记缩进（tab 缩进直接判错 —— YAML 的块缩进只许空格）。
 *
 * ⚠️ **块标量**（`key: |` / `- >-` ...）要特殊对待：它下面的缩进行是**正文**，
 * 里面的 `#` 不是注释、里面的 `- id:` 也不是条目（真实宿主的 profile 叠加层里
 * 就有 `prefix: |` 装整段系统提示词）。所以正文整段吃掉，结构上只留一个标量占位。
 */
function overlayLines(text) {
  const raw = String(text ?? '').split(/\r?\n/)
  const out = []
  for (let n = 0; n < raw.length; n++) {
    const kept = stripYamlComment(raw[n])
    if (kept.trim() === '') continue
    const lead = /^[ \t]*/.exec(kept)[0]
    if (lead.includes('\t')) {
      throw new OverlayYamlError('tab-indent', `第 ${n + 1} 行用 tab 缩进 —— YAML 的块缩进只许空格`, n + 1)
    }
    const indent = lead.length
    let t = kept.trim()
    if (/(?:^|[:\s])[|>][-+]?\d*[-+]?$/.test(t)) {
      t = t.replace(/([|>][-+]?\d*[-+]?)$/, "'<block>'")
      let j = n + 1
      while (j < raw.length) {
        if (raw[j].trim() === '') { j++; continue }
        if ((/^[ \t]*/.exec(raw[j])[0]).length > indent) { j++; continue }
        break
      }
      out.push({ n: n + 1, indent, text: t })
      n = j - 1
      continue
    }
    out.push({ n: n + 1, indent, text: t })
  }
  return out
}

const isSeqText = (t) => t === '-' || t.startsWith('- ')

/** 带 YAML 标签的值（`disabled: !!js expr`）—— 结构上它就是个"有标签的节点" */
class TaggedYaml {
  constructor(tag, value) {
    this.tag = tag
    this.value = value
  }
}

/**
 * 切出 YAML 标签：`!!js expr` / `!foo x` / `!<tag:uri> x`。
 * 没有标签 → null；标签语法坏了（`!` / `!!` 后面没有名字）→ 抛 `tag`（这就是"标签错"）。
 * 注意：标签本身**不是**错误 —— 真实宿主的 profile 叠加层里 `disabled: !!js …` 很常见，
 * 判死它等于让用户一台机器都改不了配置。错的只有"标签语法坏"这一种。
 */
function splitYamlTag(src, lineNo) {
  const s = String(src ?? '')
  if (!s.startsWith('!')) return null
  const m = /^!(?:<[^>]*>|!?[^\s[\]{},]*)/.exec(s)
  const tag = m ? m[0] : '!'
  if (tag === '' || tag === '!' || tag === '!!') {
    throw new OverlayYamlError('tag', `第 ${lineNo} 行有坏的 YAML 标签（${JSON.stringify(s.slice(0, 24))}）—— 感叹号后面缺标签名`, lineNo)
  }
  return { tag, rest: s.slice(tag.length) }
}

function unquoteYamlScalar(raw) {
  const t = String(raw).trim()
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'")
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '0': '\0' }[c] ?? c))
  }
  return t
}

/** `key:` 切开（冒号后必须是空白或行尾；引号里的冒号不算） */
function splitYamlKey(text) {
  const s = String(text)
  let q = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q === "'") { if (c === "'") { if (s[i + 1] === "'") i++; else q = null } continue }
    if (q === '"') { if (c === '\\') i++; else if (c === '"') q = null; continue }
    if ((c === "'" || c === '"') && i === 0) { q = c; continue }
    if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t')) {
      const key = unquoteYamlScalar(s.slice(0, i))
      if (key === '') return null
      return { key, rest: s.slice(i + 1).trim() }
    }
  }
  return null
}

function resolvePlainScalar(raw) {
  const t = String(raw).trim()
  if (t === '' || t === 'null' || t === '~') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t)
  return t
}

/** 解析一个"行内值"：先切标签，再解析流式序列 / 流式映射 / 单双引号标量 / 纯标量。真解析，解析不了就抛。 */
function yamlFlowValue(src, lineNo) {
  const raw = String(src ?? '').trim()
  if (raw === '') return null
  const tg = splitYamlTag(raw, lineNo)
  const s = tg ? tg.rest.trim() : raw
  if (s === '') return new TaggedYaml(tg.tag, null)
  const v = yamlInlineNode(s, lineNo)
  return tg ? new TaggedYaml(tg.tag, v) : v
}

function yamlInlineNode(src, lineNo) {
  const s = String(src).trim()
  if (s === '') return null
  const err = (rule, msg) => { throw new OverlayYamlError(rule, `第 ${lineNo} 行：${msg}`, lineNo) }
  let i = 0
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }

  const single = () => {
    i++
    let out = ''
    for (;;) {
      if (i >= s.length) err('unclosed-quote', '单引号字符串没闭合')
      if (s[i] === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue }
        i++
        return out
      }
      out += s[i++]
    }
  }
  const double = () => {
    i++
    let out = ''
    for (;;) {
      if (i >= s.length) err('unclosed-quote', '双引号字符串没闭合')
      const c = s[i]
      if (c === '"') { i++; return out }
      if (c === '\\') {
        const e = s[i + 1]
        if (e === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue }
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f' }
        if (!Object.prototype.hasOwnProperty.call(map, e)) err('parse-error', `不认识的转义 \\${e}`)
        out += map[e]
        i += 2
        continue
      }
      out += c
      i++
    }
  }
  const value = () => {
    ws()
    if (i >= s.length) return null
    const c = s[i]
    if (c === '!') {
      const tg2 = splitYamlTag(s.slice(i), lineNo)
      i += tg2.tag.length
      ws()
      return new TaggedYaml(tg2.tag, i >= s.length ? null : value())
    }
    if (c === '&' || c === '*') err('anchor', `anchor/alias（${c}）不在叠加层支持的语法里`)
    if (c === '[') { i++; return seq() }
    if (c === '{') { i++; return map() }
    if (c === "'") return single()
    if (c === '"') return double()
    const start = i
    while (i < s.length && !/[,\]}]/.test(s[i])) i++
    return resolvePlainScalar(s.slice(start, i))
  }
  const seq = () => {
    const out = []
    for (;;) {
      ws()
      if (i >= s.length) err('unclosed-flow', '流式序列 [ 没闭合')
      if (s[i] === ']') { i++; return out }
      if (s[i] === ',') { i++; continue }
      out.push(value())
      ws()
      if (i < s.length && s[i] === ',') { i++; continue }
    }
  }
  const map = () => {
    const out = Object.create(null)
    for (;;) {
      ws()
      if (i >= s.length) err('unclosed-flow', '流式映射 { 没闭合')
      if (s[i] === '}') { i++; return out }
      if (s[i] === ',') { i++; continue }
      let key
      if (s[i] === "'") key = single()
      else if (s[i] === '"') key = double()
      else {
        const start = i
        while (i < s.length && s[i] !== ':' && s[i] !== '}' && s[i] !== ',') i++
        key = String(s.slice(start, i)).trim()
        if (key === '') err('parse-error', '流式映射里有一个空键')
      }
      ws()
      if (s[i] !== ':') err('parse-error', `流式映射里缺冒号（键 ${key}）`)
      i++
      ws()
      out[key] = (i < s.length && (s[i] === '}' || s[i] === ',')) ? null : value()
    }
  }

  const v = value()
  ws()
  if (i < s.length) err('trailing-garbage', `标量后面还有拖尾内容（${JSON.stringify(s.slice(i))}）—— 这不是合法 YAML`)
  return v
}

function overlayParseBlock(lines, i, indent) {
  const l = lines[i]
  if (isSeqText(l.text)) return overlayParseSeq(lines, i, indent)
  if (splitYamlKey(l.text)) return overlayParseMap(lines, i, indent)
  return { value: yamlFlowValue(l.text, l.n), next: i + 1 }
}

function overlayParseSeq(lines, i, indent) {
  const arr = []
  while (i < lines.length) {
    const l = lines[i]
    if (l.indent < indent) break
    if (l.indent > indent) {
      throw new OverlayYamlError('bad-indent', `第 ${l.n} 行缩进（${l.indent}）比同级条目的缩进（${indent}）深 —— 这份文件不是能安全就地改的 YAML`, l.n)
    }
    if (!isSeqText(l.text)) break
    const m = /^-\s*/.exec(l.text)
    const rest = l.text.slice(m[0].length)
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const r = overlayParseBlock(lines, i + 1, lines[i + 1].indent)
        arr.push(r.value)
        i = r.next
      } else { arr.push(null); i++ }
      continue
    }
    const col = indent + m[0].length
    if (isSeqText(rest)) {
      throw new OverlayYamlError('unsupported-syntax', `第 ${l.n} 行是 "- - …"（列表套列表的紧凑写法）—— 只支持标准块写法，不敢猜`, l.n)
    }
    const side = [{ indent: col, text: rest, n: l.n }]
    let j = i + 1
    while (j < lines.length && lines[j].indent > indent) { side.push(lines[j]); j++ }
    for (const s2 of side) {
      if (s2.indent < col) {
        throw new OverlayYamlError('bad-indent', `第 ${s2.n} 行缩进（${s2.indent}）比条目内容列（${col}）还浅 —— 这条目的结构坏了`, s2.n)
      }
    }
    const r = overlayParseBlock(side, 0, col)
    if (r.next < side.length) {
      throw new OverlayYamlError('bad-indent', `第 ${side[r.next].n} 行接不上（缩进线不对）`, side[r.next].n)
    }
    arr.push(r.value)
    i = j
  }
  return { value: arr, next: i }
}

function overlayParseMap(lines, i, indent) {
  const obj = Object.create(null)
  while (i < lines.length) {
    const l = lines[i]
    if (l.indent < indent) break
    if (l.indent > indent) {
      throw new OverlayYamlError('bad-indent', `第 ${l.n} 行缩进（${l.indent}）比同级键的缩进（${indent}）深 —— 这份文件不是能安全就地改的 YAML`, l.n)
    }
    if (isSeqText(l.text)) break
    const kv = splitYamlKey(l.text)
    if (!kv) {
      throw new OverlayYamlError('parse-error', `第 ${l.n} 行既不是 key: value 也不是列表项：“${l.text.slice(0, 32)}”`, l.n)
    }
    if (Object.prototype.hasOwnProperty.call(obj, kv.key)) {
      throw new OverlayYamlError('duplicate-key', `第 ${l.n} 行重复了键 ${kv.key}`, l.n)
    }
    const tg = kv.rest === '' ? null : splitYamlTag(kv.rest, l.n)
    const tail = tg ? tg.rest.trim() : kv.rest
    if (tail === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const r = overlayParseBlock(lines, i + 1, lines[i + 1].indent)
        obj[kv.key] = tg ? new TaggedYaml(tg.tag, r.value) : r.value
        i = r.next
      } else {
        obj[kv.key] = tg ? new TaggedYaml(tg.tag, null) : null
        i++
      }
    } else {
      obj[kv.key] = yamlFlowValue(kv.rest, l.n)
      i++
    }
  }
  return { value: obj, next: i }
}

/** 真解析整份文本 → { ok, value?, rule?, reason?, line? }。**纯函数**：不碰盘、不起子进程。 */
function parseOverlayYml(text) {
  try {
    const lines = overlayLines(text)
    const docs = []
    let cur = []
    for (const l of lines) {
      if (l.indent === 0 && (l.text === '---' || l.text === '...')) { docs.push(cur); cur = []; continue }
      cur.push(l)
    }
    docs.push(cur)
    const live = docs.filter((d) => d.length > 0)
    if (live.length > 1) {
      throw new OverlayYamlError('two-roots', `解析出 ${live.length} 个 YAML 文档（被 --- 分隔）—— 叠加层只能有一个根（数组）`, live[1][0].n)
    }
    if (live.length === 0) return { ok: true, value: undefined }
    const doc = live[0]
    if (doc[0].indent !== 0) {
      throw new OverlayYamlError('bad-indent', `第 ${doc[0].n} 行：顶层内容的缩进必须是 0（实得 ${doc[0].indent}）`, doc[0].n)
    }
    const r = overlayParseBlock(doc, 0, 0)
    if (r.next < doc.length) {
      const rest = doc[r.next]
      throw new OverlayYamlError('two-roots',
        `解析完一个根之后，第 ${rest.n} 行还有顶层内容 —— 这是**第二个 YAML 根**（宿主会报 failed to parse overlay）。`
        + '空叠加层的根写成 `[]` 或干脆留空都行，但不能既有 `[]` 又往下写 `- id:`', rest.n)
    }
    return { ok: true, value: r.value }
  } catch (e) {
    if (e instanceof OverlayYamlError) return { ok: false, rule: e.rule, reason: e.reason, line: e.line }
    return { ok: false, rule: 'parse-error', reason: `YAML 解析失败：${e?.message ?? e}` }
  }
}

function isPlainMapping(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof TaggedYaml)
}

/** 叠加层契约：根是数组、每个条目是映射、目标段唯一且 config 结构可就地改 */
function validateOverlayStructure(doc) {
  if (doc === undefined || doc === null) return { ok: true, rule: '', reason: '' }
  if (!Array.isArray(doc)) {
    return {
      ok: false,
      rule: 'root-not-sequence',
      reason: `顶层解析出来不是数组（是 ${typeof doc}）—— 叠加层的根必须是「- id: …」/「- insert: …」组成的列表`,
    }
  }
  // 条目集合 = 顶层条目 + `- insert:` 列表里的子条目（两种形状都真出现过：本包自己的
  // cordis.patch.yml 就是 `- insert:` 包一层）。补丁也可能落在 insert 的子条目上，
  // 所以"目标段"的判定必须两个层级都看 —— 否则合法文件会被误判成"改完找不到 packRoot"。
  const flat = []
  for (let k = 0; k < doc.length; k++) {
    const e = doc[k]
    if (!isPlainMapping(e)) {
      return { ok: false, rule: 'entry-not-mapping', reason: `第 ${k + 1} 个条目解析出来不是映射（是 ${Array.isArray(e) ? '数组' : typeof e}）—— 每个条目都得是 - id: …` }
    }
    flat.push({ e, where: `第 ${k + 1} 个条目` })
    if ('insert' in e) {
      if (!Array.isArray(e.insert)) {
        return { ok: false, rule: 'insert-not-sequence', reason: `第 ${k + 1} 个条目的 insert 不是列表` }
      }
      for (let j = 0; j < e.insert.length; j++) {
        const sub = e.insert[j]
        if (!isPlainMapping(sub)) {
          return { ok: false, rule: 'entry-not-mapping', reason: `第 ${k + 1} 个条目 insert 里的第 ${j + 1} 个子条目不是映射` }
        }
        flat.push({ e: sub, where: `第 ${k + 1} 个条目 insert 里的第 ${j + 1} 个子条目` })
      }
    }
  }

  const targets = []
  for (const { e, where } of flat) {
    if ('id' in e && e.id !== null && typeof e.id === 'object') {
      return { ok: false, rule: 'non-scalar-id', reason: `${where}的 id 不是标量（${JSON.stringify(e.id)}）—— 就地改哪一段都是猜` }
    }
    if ('config' in e && e.config !== null && !isPlainMapping(e.config)) {
      return { ok: false, rule: 'config-not-mapping', reason: `${where}的 config 不是映射（${JSON.stringify(e.config)}）—— 补丁值得是 config 下的键` }
    }
    if (e.id === 'whale-sensei') targets.push({ e, where })
  }
  if (targets.length > 1) {
    return { ok: false, rule: 'duplicate-id-sections', reason: '文档里有多个 - id: whale-sensei 段，就地改哪一段都是猜' }
  }
  if (targets.length === 1) {
    const { e, where } = targets[0]
    if ('packRoot' in e) {
      return { ok: false, rule: 'pack-root-outside-config', reason: `${where}里的 packRoot 不在 config 下面（缩进不比 config 深）—— 就地改会插出重复键` }
    }
    if (isPlainMapping(e.config) && 'packRoot' in e.config && typeof e.config.packRoot !== 'string') {
      return { ok: false, rule: 'pack-root-not-scalar', reason: `${where}的 config.packRoot 解析出来不是字符串（${JSON.stringify(e.config.packRoot)}）—— 宿主读不到路径` }
    }
  }
  return { ok: true, rule: '', reason: '' }
}

/** 解析 + 结构校验（内部）：不过就 ok:false + rule + reason；过了把解析树放在 doc 里 */
function validateOverlayYml(text) {
  const p = parseOverlayYml(text)
  if (!p.ok) return { ok: false, rule: p.rule, reason: p.reason, line: p.line }
  const s = validateOverlayStructure(p.value)
  if (!s.ok) return { ok: false, rule: s.rule, reason: s.reason }
  return { ok: true, rule: '', reason: '', doc: p.value }
}

/** 从解析树里取 `- id: whale-sensei` 的 `config.packRoot`（顶层或 insert 子条目，取不到返回 null） */
function overlayPackRootOf(doc) {
  if (!Array.isArray(doc)) return null
  const flat = []
  for (const e of doc) {
    flat.push(e)
    if (isPlainMapping(e) && Array.isArray(e.insert)) flat.push(...e.insert)
  }
  for (const e of flat) {
    if (isPlainMapping(e) && e.id === 'whale-sensei' && isPlainMapping(e.config) && typeof e.config.packRoot === 'string') {
      return e.config.packRoot
    }
  }
  return null
}

/**
 * 就地更新（或追加）`- id: whale-sensei` 那一段的 `packRoot`。**纯函数，不碰盘**。
 * @param {string} text 原文件全文
 * @param {string} packRoot 课程包绝对路径
 */
export function patchPackRootYml(text, packRoot) {
  const src = String(text ?? '')
  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const val = yamlScalar(packRoot)

  let idAt = -1
  for (let i = 0; i < lines.length; i++) {
    const h = parseIdHead(lines[i])
    if (h && h.kind === 'scalar' && h.value === 'whale-sensei') { idAt = i; break }
  }

  if (idAt < 0) {
    const block = [
      '',
      '# --- dsh-whale-sensei: 课程包根目录 ------------------------------------------',
      '# 设置页「鲸师」里选的目录写在这里（profile 层）。包内那份随包分发、重装会被覆盖，',
      '# 所以机器本地值必须写这一层。改完要重启宿主：packRoot 只在启动时解析一次。',
      '- id: whale-sensei',
      '  config:',
      `    packRoot: ${val}`,
    ]
    // ⚠️ 空叠加层的出厂模板长这样：注释头 + 一行 `[]`（空流式序列 = 空的顶层数组）。
    // 直接往后追块序列就成了**两个 YAML 根**（`[]` 之后再来 `- id:`），宿主
    // `--dump-config` / 启动时直接 `failed to parse overlay … end of the stream or a
    // document separator is expected` —— 而这条路径回的是"已追加"，设置页也报成功，
    // 用户按文档重启宿主就再也起不来（2026-10-19 隔离环境实测，两个独立新建 profile 都复现）。
    // 所以追加时把那一行空流式根去掉：`[]` 本来就表示"没有条目"，不是一条条目。
    // 只在文档里**一个顶层块序列项都没有**时才动它 —— 已经有条目的文件结构不由这里猜。
    const hasBlockItems = lines.some((l) => NEXT_RE.test(l))
    const base = hasBlockItems ? lines : lines.filter((l) => l.trim() !== '[]')
    const droppedEmptyRoot = base.length !== lines.length
    return {
      text: [...base, ...block].join(nl) + nl,
      changed: 'append',
      note: droppedEmptyRoot
        ? '原先没有这一段，已追加（同时去掉模板里的空 `[]` 顶层数组 —— 留着会变成两个 YAML 根，宿主解析失败）'
        : '原先没有这一段，已追加',
    }
  }

  let endAt = lines.length
  for (let i = idAt + 1; i < lines.length; i++) {
    if (NEXT_RE.test(lines[i])) { endAt = i; break }
  }

  for (let i = idAt + 1; i < endAt; i++) {
    const m = lines[i].match(/^(?<ind>\s*)packRoot\s*:/)
    if (m) {
      const before = lines[i]
      lines[i] = `${m.groups.ind}packRoot: ${val}`
      return { text: lines.join(nl) + nl, changed: 'replace', note: `替换了 packRoot 那一行（其余字段保留）：${before.trim()} → ${lines[i].trim()}` }
    }
  }

  for (let i = idAt + 1; i < endAt; i++) {
    const m = lines[i].match(/^(?<ind>\s*)config\s*:\s*$/)
    if (m) {
      lines.splice(i + 1, 0, `${m.groups.ind}  packRoot: ${val}`)
      return { text: lines.join(nl) + nl, changed: 'insert', note: '该段有 config 但没有 packRoot，已插入一行' }
    }
  }

  // 该段没有 config：补一个 `config:`，把 packRoot 放在它**下面**。
  // ⚠️ 顺序不能反：先写 `packRoot:` 再写 `config:` ⇒ packRoot 落在条目的顶层（不在 config 里），
  //    而 `- insert:` 那种嵌套条目下更会直接把缩进写坏（2026-10-19 由真解析闸抓出来的老 bug）。
  const indM = lines[idAt].match(/^(?<ind>\s*)/)
  const ind = `${indM?.groups?.ind ?? ''}  `
  lines.splice(idAt + 1, 0, `${ind}config:`, `${ind}  packRoot: ${val}`)
  return { text: lines.join(nl) + nl, changed: 'insert', note: '该段没有 config，已补 config + packRoot' }
}

/** `$DSH_HOME`（与 lib/index.js 的 createPaths 同一套退路：拿不到就 ~/.dsh） */
function resolveDshHome(opts = {}) {
  if (opts.dshHome) return path.resolve(opts.dshHome)
  const env = opts.env ?? process.env
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') return path.resolve(env.DSH_HOME.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * 找装载了鲸师的那个 profile 目录。
 * 判据：`cordis.patch.yml` 里提到 `whale-sensei`，或 `package.json` 里提到 `dsh-whale-sensei`。
 * 多个命中且分不清 → **明确报错**（不猜）。
 */
export function findProfileDir(opts = {}) {
  const home = resolveDshHome(opts)
  const base = path.join(home, 'profiles')
  let names = []
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (e) {
    return { ok: false, error: `读不到 profiles 目录：${base}（${e?.message ?? e}）` }
  }

  const hits = []
  for (const name of names) {
    const dir = path.join(base, name)
    const yml = path.join(dir, 'cordis.patch.yml')
    let inYml = false
    let inPkg = false
    try { inYml = fs.readFileSync(yml, 'utf8').includes('whale-sensei') } catch { /* 没有这个文件 */ }
    try { inPkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8').includes('dsh-whale-sensei') } catch { /* 同上 */ }
    if (inYml || inPkg) hits.push({ name, dir, yml, inYml, inPkg })
  }

  if (hits.length === 1) return { ok: true, ...hits[0], home }
  if (hits.length > 1) {
    const onlyYml = hits.filter((h) => h.inYml)
    if (onlyYml.length === 1) return { ok: true, ...onlyYml[0], home }
    return { ok: false, error: `有多个 profile 提到鲸师（${hits.map((h) => h.name).join('、')}）—— 请手工改配置` }
  }
  return { ok: false, error: `没找到装载了鲸师的 profile（${base} 下 ${names.length} 个）—— 请手工改配置` }
}

/**
 * 落盘：找 profile → **两道闸**（形状闸 + 真解析/结构闸）→ 备份 → 就地更新 → **回读再解析**。
 *
 * 判据是**磁盘上的字节**，不是内存里的变量：
 *   ① 写前形状闸：`checkPackRootYml`（缩进/重复段/inline config 这类"就地改就是猜"的形状）
 *   ② 写前解析闸：候选字节必须**真的能被解析成一份叠加层**（一个根 + 数组 + 目标段可就地改），
 *      并且解析出来的 `config.packRoot` 逐字等于要写的值 —— 不过就 `ok:false`，
 *      **一个字节都不写**（连备份都不建，所以磁盘上不会多出任何东西）。
 *   ③ 备份仍在**写之前**完成（保留原字节，不是"写坏了再想办法"）。
 *   ④ 写后回读：磁盘字节再解析一遍，仍是一个根且 `packRoot` 就是新值；不然把原内容写回并报错。
 *
 * 为什么要有 ②：2026-10-19 那次事故就是"写完了没解析过" —— 空模板根是 `[]`，
 * 追加块序列后成了两个 YAML 根，宿主启动就 `failed to parse overlay`，而这里一路回成功。
 *
 * @param {string} packRoot 课程包绝对路径
 * @returns {{ok: boolean, file?: string, changed?: string, note?: string, backup?: string, rule?: string, error?: string}}
 */
export function writeProfilePackRoot(packRoot, opts = {}) {
  if (!packRoot) return { ok: false, error: '没有给 packRoot' }
  const found = findProfileDir(opts)
  if (!found.ok) return { ok: false, error: found.error }

  let before = ''
  let existed = false
  try {
    before = fs.readFileSync(found.yml, 'utf8')
    existed = true
  } catch { /* 文件不存在 → 新建 */ }

  // —— 闸 ① 形状（纯文本层面"就地改是不是在猜"）——
  const shape = checkPackRootYml(before)
  if (!shape.ok) {
    return {
      ok: false,
      file: found.yml,
      rule: shape.rule,
      error: `拒写：${shape.reason}（原文件一个字节都没动，也没留备份）`,
    }
  }

  const patched = patchPackRootYml(before, packRoot)
  const want = String(packRoot).replace(/\\/g, '/')

  // —— 闸 ② 真解析 + 叠加层结构（候选字节，落盘前）——
  const cand = validateOverlayYml(patched.text)
  if (!cand.ok) {
    return {
      ok: false,
      file: found.yml,
      rule: cand.rule,
      error: `拒写：改完的 YAML 通不过解析/结构校验 —— ${cand.reason}（原文件一个字节都没动，也没留备份）`,
    }
  }
  const candRoot = overlayPackRootOf(cand.doc)
  if (candRoot !== want) {
    return {
      ok: false,
      file: found.yml,
      rule: 'pack-root-mismatch',
      error: `拒写：改完的 YAML 解析出来的 packRoot 是 ${JSON.stringify(candRoot)}，不是 ${JSON.stringify(want)}（原文件一个字节都没动，也没留备份）`,
    }
  }

  if (opts.dryRun) return { ok: true, file: found.yml, changed: patched.changed, note: patched.note }

  let backup = null
  try {
    if (existed) {
      backup = `${found.yml}.bak-whale-${stamp()}`
      fs.copyFileSync(found.yml, backup)
    }
    // UTF-8 **无 BOM**、保留原换行风格 —— 不要因为一次改配置就把整份文件的行尾翻一遍
    fs.writeFileSync(found.yml, patched.text, 'utf8')
  } catch (e) {
    return { ok: false, file: found.yml, backup, error: `写不动 ${found.yml}：${e?.message ?? e}` }
  }

  // —— 回读校验：判据是磁盘上的字节（再解析一遍，不只是 includes）——
  let after = ''
  try { after = fs.readFileSync(found.yml, 'utf8') } catch { /* 读不回就按失败报 */ }
  const re = after ? validateOverlayYml(after) : { ok: false, rule: 'unreadable', reason: '读不回来' }
  const reRoot = re.ok ? overlayPackRootOf(re.doc) : null
  if (!re.ok || reRoot !== want) {
    const why = re.ok
      ? `回读解析出的 packRoot 是 ${JSON.stringify(reRoot)}，不是 ${JSON.stringify(want)}`
      : `回读解析不过：${re.reason}`
    const restored = restoreBefore(found.yml, before, existed)
    return {
      ok: false,
      file: found.yml,
      backup,
      rule: re.rule || 'readback-failed',
      error: `写完了但回读校验没过 —— ${why}；${restored ? '已把原内容写回' : '写回原内容也失败了，请手工检查'} ${found.yml}`,
    }
  }
  return { ok: true, file: found.yml, changed: patched.changed, note: patched.note, backup }
}

/** 回读校验没过时把原内容写回（原本不存在就删掉刚建的）——返回是否成功 */
function restoreBefore(file, before, existed) {
  try {
    if (existed) fs.writeFileSync(file, before, 'utf8')
    else fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * T22-R2 §3.2：**只判形状、不改文本**的纯函数检查入口（本批新增导出）。
 *
 * 规则与 PS 侧 `install-whale-sensei.ps1#Test-PatchedYmlShape` 是**同一套**（逐例同判）：
 * 两边都只按 `test/audit/T22.mjs#YAML_SHAPE_TABLE` 那张表判，禁止各写一套样例。
 *
 * 判定顺序（两侧逐字一致，见测试 Y01–Y07）：
 *   ① 目标 id 头是流式序列/映射且提到 whale-sensei        → non-scalar-id
 *   ② 文档里有 ≥2 个 `- id: whale-sensei` 标量段           → duplicate-id-sections
 *   ③ 没有这一段                                           → 接受（追加整段）
 *   ④ 目标块里 packRoot: 的缩进不比 config: 深              → ambiguous-nesting
 *   ⑤ 目标块里的 config: 后面还有东西（inline 流式映射）    → inline-target-config
 *   ⑥ 其余                                                 → 接受（replace / insert）
 *
 * 「接受」不等于"怎么写都对"：本函数只说形状**支持就地编辑**，具体那一行怎么落
 * 仍由 patchPackRootYml 负责（它一个字都没改返回形状）。
 *
 * 「拒绝」= **写前拒绝、一个字节都不写**（调用方负责；不是"写完再报错"）。
 *
 * @param {string} text cordis.patch.yml 全文
 * @returns {{ ok: boolean, rule: string, reason: string }} ok=true 时 rule='' reason=''
 */
export function checkPackRootYml(text) {
  const lines = String(text ?? '').split(/\r?\n/)

  const heads = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s/.test(lines[i])) continue
    const h = parseIdHead(lines[i])
    if (h) heads.push({ at: i, ...h })
  }

  const nonScalar = heads.filter((h) => h.kind === 'non-scalar' && h.mentions)
  if (nonScalar.length > 0) {
    return {
      ok: false,
      rule: 'non-scalar-id',
      reason: '目标块的 id 值不是标量（id: [whale-sensei] / {..: whale-sensei}）—— 就地改哪一段都是猜',
    }
  }

  const scalar = heads.filter((h) => h.kind === 'scalar' && h.value === 'whale-sensei')
  if (scalar.length > 1) {
    return {
      ok: false,
      rule: 'duplicate-id-sections',
      reason: '文档里有多个 - id: whale-sensei 段，就地改哪一段都是猜',
    }
  }
  if (scalar.length === 0) return { ok: true, rule: '', reason: '' }

  const at = scalar[0].at
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*-\s+\S/.test(lines[i])) { end = i; break }
  }

  let cfgInd = -1
  let cfgInline = false
  let prFound = false
  let prInd = -1
  for (let i = at + 1; i < end; i++) {
    if (cfgInd < 0) {
      const m = /^(\s*)config\s*:(.*)$/.exec(lines[i])
      if (m) {
        cfgInd = m[1].length
        const rest = m[2].trim()
        if (rest !== '' && !rest.startsWith('#')) cfgInline = true
      }
    }
    if (!prFound) {
      const m = /^(\s*)packRoot\s*:/.exec(lines[i])
      if (m) { prFound = true; prInd = m[1].length }
    }
  }

  if (cfgInd >= 0 && prFound && prInd <= cfgInd) {
    return {
      ok: false,
      rule: 'ambiguous-nesting',
      reason: '目标块里的 packRoot: 缩进不比 config: 深 —— 它不在 config 的映射里，就地改会插出重复键',
    }
  }
  if (cfgInd >= 0 && cfgInline) {
    return {
      ok: false,
      rule: 'inline-target-config',
      reason: '目标块里的 config: 是 inline 流式映射 —— 就地改会插出第二个 config 键',
    }
  }
  return { ok: true, rule: '', reason: '' }
}
