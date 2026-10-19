#!/usr/bin/env node
/**
 * test/packroot-overlay.mjs —— profile 层 `cordis.patch.yml`：**先真解析+结构校验，再落盘**
 * ------------------------------------------------------------------
 * 跑：node test/packroot-overlay.mjs
 *
 * 这一套钉的是 2026-10-19 现场那个 bug：
 *   新建 profile 的 `cordis.patch.yml` 根是 `[]`（空流式序列），设置页选完课程包目录后
 *   往后追了一段块序列 ⇒ 文件里**两个 YAML 根** ⇒ 宿主 `failed to parse overlay`，
 *   用户按界面上的「重启宿主后依然生效」重启就再也起不来。而这条路径当时一路回"成功"。
 *
 * 判据（每条都能单独证伪）：
 *   ① 空序列根（`[]` 模板）选目录 → 落盘后的文件**能被真 YAML 解析**、只有一个根、
 *      `packRoot` 解析回原值（而且路径里的中文/空格/单引号都原样回来）——"重启可解析"。
 *   ② 已有配置保留：别的 `- id:` 段与字段**逐字节不变**；重复选择**幂等**（只出现一次目标段）。
 *   ③ 异常结构（两个根 / 两个文档 / 缩进坏 / 标签错 / id 非标量 / inline config /
 *      未闭合流式 / 标量后拖尾 / 重复段）→ **拒写、`ok:false`、原文件逐字节不变、
 *      连备份都不留**（证明校验在备份与落盘之前，不是"写完再报错"）。
 *   ④ 失败路径不谎报：`choosePack` 的 profile 那条腿失败时带 `configError`，
 *      `restartHint` 绝不说「已写入 profile 配置，重启宿主后依然生效」。
 *   ⑤ `patchPackRootYml` **仍是纯文本变换**（签名/返回形状/碰非法输入照样返回 text）——
 *      真解析只放在落盘路径里，别把文本变换变成会抛的校验器。
 *
 * ⚠️ 纪律：
 *   · **真调真跑**：真函数、真文件写盘、真 YAML 解析。为了判"产物真能不能被解析"，
 *     本文件自带一份**独立**的受限 YAML 解析器（不 import 被测实现里的那份），
 *     两边各自解析同一份字节 —— 不是正则假装解析，也不是拿源码文本当判据。
 *   · 全部临时目录建在 os.tmpdir() 下；不碰 E:\workplace\study（活包）与现用 DSH_HOME，
 *     不起宿主服务、不占端口。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { patchPackRootYml, findProfileDir, writeProfilePackRoot, checkPackRootYml } from '../lib/profile-packroot.js'
import { choosePack, plugin as packPlugin } from '../lib/mods/pack.js'
// 侧载：import 时自动上报 `[test-context]`（run-all 要逐进程对账）。本套件不需要真课程包。
import './_pack.mjs'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
const fails = []
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok  ${msg}`) } else { fails.push(msg); console.log(` FAIL ${msg}`) }
}
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}（实得 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`)

// ══════════════════════════════════════════════════════════════════════
// 测试侧**独立**的受限 YAML 解析器（判"产物能不能被解析"用；与被测实现无共享代码）
// 支持的子集正好是 profile 叠加层会出现的那些：注释、空行、`---` 文档分隔、块序列、
// 块映射、流式 [..] / {..}、单/双引号标量。解析不了就抛 —— 抛 = 这份文件不可下发。
// ══════════════════════════════════════════════════════════════════════
function stripComment(line) {
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

function testParseYaml(text) {
  const raw = String(text ?? '').split(/\r?\n/)
  const lines = []
  let n = 0
  while (n < raw.length) {
    const kept = stripComment(raw[n])
    if (kept.trim() === '') { n++; continue }
    const lead = /^[ \t]*/.exec(kept)[0]
    if (lead.includes('\t')) throw new Error(`第 ${n + 1} 行用 tab 缩进`)
    const indent = lead.length
    let t = kept.trim()
    // 块标量（| / >）：下面的缩进行是**正文**（真实宿主 profile 里就有 `prefix: |`），整段吃掉
    if (/(?:^|[:\s])[|>][-+]?\d*[-+]?$/.test(t)) {
      t = t.replace(/([|>][-+]?\d*[-+]?)$/, "'<block>'")
      let j = n + 1
      while (j < raw.length) {
        if (raw[j].trim() === '') { j++; continue }
        if ((/^[ \t]*/.exec(raw[j])[0]).length > indent) { j++; continue }
        break
      }
      lines.push({ n: n + 1, indent, text: t })
      n = j
      continue
    }
    lines.push({ n: n + 1, indent, text: t })
    n++
  }
  if (lines.length === 0) return { ok: true, value: undefined }

  const docs = []
  let cur = []
  for (const l of lines) {
    if (l.indent === 0 && l.text === '---') { docs.push(cur); cur = []; continue }
    cur.push(l)
  }
  docs.push(cur)
  const live = docs.filter((d) => d.length > 0)
  if (live.length !== 1) throw new Error(`期望恰好 1 个 YAML 文档/根，实得 ${live.length}`)
  const doc = live[0]
  if (doc[0].indent !== 0) throw new Error(`第 ${doc[0].n} 行：顶层缩进不为 0`)
  const r = tBlock(doc, 0, 0)
  if (r.next !== doc.length) throw new Error(`第 ${doc[r.next].n} 行起还有顶层内容（两个根）`)
  return { ok: true, value: r.value }
}

const isSeq = (t) => t === '-' || t.startsWith('- ')

function splitKey(text) {
  let q = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q === "'") { if (c === "'") { if (text[i + 1] === "'") i++; else q = null } continue }
    if (q === '"') { if (c === '\\') i++; else if (c === '"') q = null; continue }
    if ((c === "'" || c === '"') && i === 0) { q = c; continue }
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      const k = text.slice(0, i).trim()
      if (!k) return null
      return { key: tUnquote(k), rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

function tUnquote(s) {
  const t = s.trim()
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'")
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return JSON.parse(t)
  return t
}

function tBlock(lines, i, indent) {
  const l = lines[i]
  if (isSeq(l.text)) return tSeq(lines, i, indent)
  if (splitKey(l.text)) return tMap(lines, i, indent)
  return { value: tFlow(l.text), next: i + 1 }
}

function tSeq(lines, i, indent) {
  const arr = []
  while (i < lines.length) {
    const l = lines[i]
    if (l.indent < indent) break
    if (l.indent > indent) throw new Error(`第 ${l.n} 行多缩进了一级`)
    if (!isSeq(l.text)) break
    const m = /^-\s*/.exec(l.text)
    const rest = l.text.slice(m[0].length)
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const r = tBlock(lines, i + 1, lines[i + 1].indent)
        arr.push(r.value); i = r.next
      } else { arr.push(null); i++ }
      continue
    }
    const col = indent + m[0].length
    const sub = [{ indent: col, text: rest, n: l.n }]
    let j = i + 1
    while (j < lines.length && lines[j].indent > indent) { sub.push(lines[j]); j++ }
    for (const s of sub) if (s.indent < col) throw new Error(`第 ${s.n} 行缩进比条目内容列还浅`)
    const r = tBlock(sub, 0, col)
    if (r.next !== sub.length) throw new Error(`第 ${sub[r.next].n} 行起有没解析完的内容`)
    arr.push(r.value); i = j
  }
  return { value: arr, next: i }
}

function tMap(lines, i, indent) {
  const obj = Object.create(null)
  while (i < lines.length) {
    const l = lines[i]
    if (l.indent < indent) break
    if (l.indent > indent) throw new Error(`第 ${l.n} 行多缩进了一级`)
    if (isSeq(l.text)) break
    const kv = splitKey(l.text)
    if (!kv) throw new Error(`第 ${l.n} 行既不是 key: value 也不是列表项`)
    if (Object.prototype.hasOwnProperty.call(obj, kv.key)) throw new Error(`第 ${l.n} 行重复键 ${kv.key}`)
    if (kv.rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const r = tBlock(lines, i + 1, lines[i + 1].indent)
        obj[kv.key] = r.value; i = r.next
      } else { obj[kv.key] = null; i++ }
    } else { obj[kv.key] = tFlow(kv.rest); i++ }
  }
  return { value: obj, next: i }
}

function tFlow(src) {
  let i = 0
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  // YAML 标签（`!!js expr`）：真实 profile 叠加层里合法存在，剥掉标签再解析它后面的节点
  if (String(src).trim().startsWith('!')) {
    const m = /^!(?:<[^>]*>|!?[^\s[\]{},]*)/.exec(String(src).trim())
    if (!m || m[0] === '!' || m[0] === '!!') throw new Error(`坏的 YAML 标签：${String(src).slice(0, 24)}`)
    const rest = String(src).trim().slice(m[0].length).trim()
    return rest === '' ? null : tFlow(rest)
  }
  const single = () => {
    i++
    let out = ''
    for (;;) {
      if (i >= src.length) throw new Error('单引号没闭合')
      if (src[i] === "'") { if (src[i + 1] === "'") { out += "'"; i += 2; continue } i++; return out }
      out += src[i++]
    }
  }
  const double = () => {
    i++
    let out = ''
    for (;;) {
      if (i >= src.length) throw new Error('双引号没闭合')
      const c = src[i]
      if (c === '"') { i++; return out }
      if (c === '\\') {
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' }
        const e = src[i + 1]
        if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue }
        if (e in map) { out += map[e]; i += 2; continue }
        throw new Error(`不认识的转义 \\${e}`)
      }
      out += c; i++
    }
  }
  const value = () => {
    ws()
    if (i >= src.length) return null
    const c = src[i]
    if (c === '!') throw new Error('值带 YAML 标签')
    if (c === '[') { i++; return seq() }
    if (c === '{') { i++; return map() }
    if (c === "'") return single()
    if (c === '"') return double()
    const start = i
    while (i < src.length && !/[,\]}]/.test(src[i])) i++
    const raw = src.slice(start, i).trim()
    if (raw === '' || raw === 'null' || raw === '~') return null
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
    return raw
  }
  const seq = () => {
    const out = []
    for (;;) {
      ws()
      if (i >= src.length) throw new Error('流式序列 [ 没闭合')
      if (src[i] === ']') { i++; return out }
      if (src[i] === ',') { i++; continue }
      out.push(value())
      ws()
      if (src[i] === ',') { i++; continue }
    }
  }
  const map = () => {
    const out = Object.create(null)
    for (;;) {
      ws()
      if (i >= src.length) throw new Error('流式映射 { 没闭合')
      if (src[i] === '}') { i++; return out }
      if (src[i] === ',') { i++; continue }
      let key
      if (src[i] === "'") key = single()
      else if (src[i] === '"') key = double()
      else {
        const start = i
        while (i < src.length && src[i] !== ':' && src[i] !== '}' && src[i] !== ',') i++
        key = String(src.slice(start, i)).trim()
      }
      ws()
      if (src[i] !== ':') throw new Error('流式映射里缺冒号')
      i++
      ws()
      out[key] = (src[i] === '}' || src[i] === ',') ? null : value()
    }
  }
  const v = value()
  ws()
  if (i < src.length) throw new Error(`标量后还有拖尾内容：${JSON.stringify(src.slice(i))}`)
  return v
}

/** 解析 + 断言 overlay 形状：一个根、是数组、目标段唯一 */
function parseOverlayForTest(bytes) {
  const r = testParseYaml(bytes)
  if (!Array.isArray(r.value) && r.value !== undefined) {
    throw new Error(`顶层必须是数组（实得 ${r.value === null ? 'null' : typeof r.value}）`)
  }
  return r.value === undefined ? [] : r.value
}

// ══════════════════════════════════════════════════════════════════════
// 夹具：假 DSH_HOME（profiles/web/{cordis.patch.yml,package.json}）
// ══════════════════════════════════════════════════════════════════════
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packroot-overlay-'))
console.log(`\n[packroot-overlay] 临时目录：${TMP}`)

function makeHome(name, yml) {
  const home = path.join(TMP, name)
  const prof = path.join(home, 'profiles', 'web')
  fs.mkdirSync(prof, { recursive: true })
  const ymlFile = path.join(prof, 'cordis.patch.yml')
  if (yml !== undefined) fs.writeFileSync(ymlFile, yml, 'utf8')
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ name: 'web-profile', dependencies: { 'dsh-whale-sensei': 'link:.' } }, null, 2), 'utf8')
  return { home, prof, ymlFile }
}

function walkFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p))
    else out.push(path.relative(dir, p).split(path.sep).join('/'))
  }
  return out.sort()
}

const backupsOf = (prof) => fs.readdirSync(prof).filter((f) => /\.bak-whale-\d{8}-\d{6}$/.test(f))

/** 出厂空叠加层模板：注释头 + 一行 `[]`（本 bug 的起点） */
const EMPTY_ROOT_TEMPLATE = [
  '# 空的 profile 叠加层',
  '# 想手工加条目就往下写 - id: …',
  '[]',
  '',
].join('\n')

/** 已经有鲸师段的合法叠加层（"其它字段一个不丢"用） */
const EXISTING = [
  '# 手写的 profile 叠加层',
  '- id: other-plugin',
  '  config: { top: 1 }',
  '- id: whale-sensei',
  '  config:',
  "    packRoot: 'D:/old/pack'",
  '    announceOnBoot: true',
  "    stylesDir: 'D:/old/styles'",
  '- id: baode',
  '  config: { dataDir: \'D:/baode\' }',
  '',
].join('\n')

/** 取某一段的原文（从该 `- id:` 行到下一条目前）——判"逐字节不变" */
function sectionOf(text, id) {
  const lines = String(text).split(/\r?\n/)
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*['"]?${id}['"]?\\s*$`).test(l))
  if (at < 0) return null
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) if (/^\s*-\s+\S/.test(lines[i])) { end = i; break }
  return lines.slice(at, end).join('\n')
}

const targetEntry = (doc) => (doc || []).find((e) => e && e.id === 'whale-sensei')

// ══════════════════════════════════════════════════════════════════════
console.log('\n① 新 profile 的空序列根（`[]` 模板）→ 落盘后真能被解析')
{
  const { home, prof, ymlFile } = makeHome('empty-root', EMPTY_ROOT_TEMPLATE)
  const before = fs.readFileSync(ymlFile, 'utf8')
  const w = writeProfilePackRoot('E:\\new\\pack', { dshHome: home })
  ok(w.ok === true, `空序列根（[]）上写 packRoot 要 ok：${w.ok ? 'ok' : w.error}`)
  eq(w.changed, 'append', '空根上走的是 append')

  const disk = fs.readFileSync(ymlFile, 'utf8')
  ok(!/^\s*\[\]\s*$/m.test(disk), '磁盘上再没有孤零零一行 `[]`（留着就是两个 YAML 根）')
  let parsed = null
  let parseErr = null
  try { parsed = parseOverlayForTest(disk) } catch (e) { parseErr = e }
  ok(parseErr === null, `落盘后的字节**能被真 YAML 解析**（重启可解析）${parseErr ? '：' + parseErr.message : ''}`)
  ok(Array.isArray(parsed) && parsed.length === 1, `只有一个根、根是数组且只有 1 个条目（实得 ${parseErr ? '解析失败' : JSON.stringify(parsed)?.slice(0, 60)}）`)
  const entry = parsed ? targetEntry(parsed) : null
  ok(!!entry && entry.id === 'whale-sensei', '解析出的条目就是 - id: whale-sensei')
  eq(entry && entry.config ? entry.config.packRoot : null, 'E:/new/pack', 'packRoot 解析回原值（重启后宿主读到的就是这个）')

  // 备份在写之前就存在，且内容 = 写前原字节
  ok(!!w.backup && fs.existsSync(w.backup), '改前留了备份')
  ok(w.backup && fs.readFileSync(w.backup, 'utf8') === before, '备份内容 = **写前**原字节（备份确实在写之前完成）')
  eq(backupsOf(prof).length, 1, 'prof 目录里恰好一份备份（不多不少）')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n② 重复选择（幂等）：同一 packRoot 连写两次不重复、不漂移')
{
  const { home, ymlFile } = makeHome('idempotent', EMPTY_ROOT_TEMPLATE)
  const w1 = writeProfilePackRoot('E:\\new\\pack', { dshHome: home })
  const once = fs.readFileSync(ymlFile, 'utf8')
  const w2 = writeProfilePackRoot('E:\\new\\pack', { dshHome: home })
  const twice = fs.readFileSync(ymlFile, 'utf8')
  ok(w1.ok === true && w2.ok === true, '两次写都 ok')
  eq(w2.changed, 'replace', '第二次是就地替换（不是再追加一段）')
  ok(twice === once, '第二次落盘与第一次**逐字节相同**（幂等）')
  const targets = (twice.match(/^\s*-\s*id:\s*['"]?whale-sensei['"]?\s*$/gm) || []).length
  eq(targets, 1, '`- id: whale-sensei` 只出现一次（没有重复块）')
  const parsed2 = parseOverlayForTest(twice)
  eq(parsed2.length, 1, '解析后条目数仍是 1')

  const w3 = writeProfilePackRoot('E:\\pack\\v2', { dshHome: home })
  const three = fs.readFileSync(ymlFile, 'utf8')
  ok(w3.ok === true && w3.changed === 'replace', '换一个目录再选 → 还是就地替换')
  eq(parseOverlayForTest(three).length, 1, '换值之后条目数还是 1（没有长出第二段）')
  eq((three.match(/^\s*-\s*id:\s*['"]?whale-sensei['"]?\s*$/gm) || []).length, 1, '换值之后目标段仍只有一处')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n③ 已有配置保留：别的段与字段逐字节不变')
{
  const { home, ymlFile } = makeHome('existing', EXISTING)
  const beforeBaode = sectionOf(EXISTING, 'baode')
  const beforeOther = sectionOf(EXISTING, 'other-plugin')
  const w = writeProfilePackRoot('D:\\brand\\new', { dshHome: home })
  ok(w.ok === true, `已有配置上写要 ok：${w.ok ? 'ok' : w.error}`)
  eq(w.changed, 'replace', '已有 packRoot → 就地替换')
  const disk = fs.readFileSync(ymlFile, 'utf8')
  eq(sectionOf(disk, 'baode'), beforeBaode, '别的 id（baode）那一段**逐字节不变**')
  eq(sectionOf(disk, 'other-plugin'), beforeOther, '别的 id（other-plugin）那一段**逐字节不变**')
  ok(disk.includes('announceOnBoot: true') && disk.includes("stylesDir: 'D:/old/styles'"),
    '目标段里 config 的其它字段（announceOnBoot / stylesDir）一个不丢')
  ok(disk.includes("packRoot: 'D:/brand/new'") && !disk.includes('D:/old/pack'), 'packRoot 换成新值、旧值没了')
  const parsed = parseOverlayForTest(disk)
  eq(parsed.length, 3, '解析后三个条目都在')
  eq(targetEntry(parsed).config.packRoot, 'D:/brand/new', '解析出的 packRoot 就是新值')
  ok(disk.includes('# 手写的 profile 叠加层'), '注释也原样保留（没被"重写整份文件"抹掉）')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 中文 / 空格 / 单引号路径：写进去还要能解析回原值')
{
  const { home, ymlFile } = makeHome('weird-path', EMPTY_ROOT_TEMPLATE)
  const packRoot = "E:\\Temp\\ws-e2e-20261019\\证据\\我的 课程'包"
  const w = writeProfilePackRoot(packRoot, { dshHome: home })
  ok(w.ok === true, `带中文/空格/单引号的路径要写得进去：${w.ok ? 'ok' : w.error}`)
  const disk = fs.readFileSync(ymlFile, 'utf8')
  ok(disk.includes("''"), '磁盘上单引号按 YAML 规矩转成了两个单引号')
  const parsed = parseOverlayForTest(disk)
  const got = targetEntry(parsed)?.config?.packRoot
  eq(got, packRoot.replace(/\\/g, '/'), '路径解析回原值（中文/空格/单引号都没丢）')
  eq(typeof got, 'string', '解析出来是字符串而不是数字/布尔')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ 异常结构：拒写 + 原文件逐字节不变 + 连备份都不留')
{
  const cases = [
    {
      label: '两个根（`[]` 后面已有块条目）',
      yml: ['# tpl', '[]', '- id: baode', '  config:', '    dataDir: x', ''].join('\n'),
      rule: 'two-roots',
    },
    {
      label: '两个根（列 0 的映射根 + 块序列）',
      yml: ['top: 1', '- id: baode', '  config: { dataDir: x }', ''].join('\n'),
      rule: 'two-roots',
    },
    {
      label: '两个文档（--- 分隔）',
      yml: ['- id: baode', '  config: { dataDir: x }', '---', '- id: other', '  config: { a: 1 }', ''].join('\n'),
      rule: 'two-roots',
    },
    {
      label: '缩进坏（config 比条目内容列深、但键与块缩进对不上）',
      yml: ['- id: whale-sensei', '   config:', "    packRoot: 'D:/x'", ''].join('\n'),
      rule: 'bad-indent',
    },
    {
      label: '标签错（感叹号后面没有标签名）',
      yml: ['- id: baode', '  config:', '    x: !', '- id: whale-sensei', '  config:', '    announceOnBoot: true', ''].join('\n'),
      rule: 'tag',
    },
    {
      label: 'id 非标量（- id: [whale-sensei]）',
      yml: ['- id: [whale-sensei]', '  config:', '    announceOnBoot: true', ''].join('\n'),
      rule: 'non-scalar-id',
    },
    {
      label: 'inline config（config: { packRoot: … }）',
      yml: ['- id: whale-sensei', "  config: { packRoot: 'D:/old' }", ''].join('\n'),
      rule: 'inline-target-config',
    },
    {
      label: 'packRoot 缩进不比 config 深',
      yml: ['- id: whale-sensei', '  config:', '    announceOnBoot: true', "  packRoot: 'D:/old'", ''].join('\n'),
      rule: 'ambiguous-nesting',
    },
    {
      label: '未闭合的流式映射',
      yml: ['- id: baode', '  config: { a: 1', '- id: whale-sensei', '  config:', '    announceOnBoot: true', ''].join('\n'),
      rule: 'unclosed-flow',
    },
    {
      label: '标量后面拖尾（不是合法 YAML）',
      yml: ['- id: whale-sensei', '  config:', '    announceOnBoot: true', "    junk: 'x' y", ''].join('\n'),
      rule: 'trailing-garbage',
    },
    {
      label: '重复的目标段',
      yml: ['- id: whale-sensei', '  config:', '    announceOnBoot: true', '- id: whale-sensei', '  config:', '    announceOnBoot: false', ''].join('\n'),
      rule: 'duplicate-id-sections',
    },
  ]

  for (const c of cases) {
    const { home, prof, ymlFile } = makeHome(`reject-${cases.indexOf(c)}`, c.yml)
    const before = fs.readFileSync(ymlFile)
    const filesBefore = walkFiles(prof)
    const w = writeProfilePackRoot('E:/new/pack', { dshHome: home })
    const unchanged = fs.readFileSync(ymlFile).equals(before)
    ok(w.ok === false, `${c.label}：拒写（ok=false）`)
    ok(typeof w.error === 'string' && w.error.length > 8, `${c.label}：给出具体原因（${String(w.error).slice(0, 48)}…）`)
    eq(w.rule, c.rule, `${c.label}：拒写理由 = ${c.rule}`)
    ok(unchanged, `${c.label}：原文件**逐字节不变**`)
    eq(walkFiles(prof).length, filesBefore.length, `${c.label}：没多出文件（校验在备份/落盘之前）`)
  }
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ 真写盘失败：不谎报成功')
{
  const { home, prof } = makeHome('write-fails', undefined)
  // 让 `cordis.patch.yml` 是个目录 ⇒ 真写盘必失败（不打桩、不 mock）
  const ymlFile = path.join(prof, 'cordis.patch.yml')
  fs.mkdirSync(ymlFile, { recursive: true })
  const w = writeProfilePackRoot('E:/new/pack', { dshHome: home })
  ok(w.ok === false, '写盘真的失败时 ok=false（不是"写完了"）')
  ok(typeof w.error === 'string' && w.error.length > 0, `给出失败原因：${String(w.error).slice(0, 60)}`)
  eq(w.backup, null, '原本没有文件 ⇒ 不留备份')
  ok(!backupsOf(prof).length, 'prof 目录里没有多出来的备份文件')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ 失败路径不谎报：choosePack 的 profile 那条腿')
{
  // 一个"已经是课程包"的目录（判据：presets/whale-sensei.css）
  const packDir = path.join(TMP, 'pack')
  fs.mkdirSync(path.join(packDir, 'presets'), { recursive: true })
  fs.writeFileSync(path.join(packDir, 'presets', 'whale-sensei.css'), '/* x */\n', 'utf8')

  const brokenYml = ['# tpl', '[]', '- id: baode', '  config:', '    dataDir: x', ''].join('\n')
  const bad = makeHome('choose-bad', brokenYml)
  const badBefore = fs.readFileSync(bad.ymlFile)
  const hctx = { paths: { packRoot: undefined }, log: { info() {}, warn() {}, error() {} } }
  const res = await choosePack({ dir: packDir, dshHome: bad.home }, hctx)
  ok(res.ok === true, '选包本身仍算成功（写配置是第二条腿，失败不掩盖整件事）')
  eq(res.config, null, 'config 回执是 null（没写成功就是没写成功）')
  ok(typeof res.configError === 'string' && res.configError.length > 8, `configError 带具体原因：${String(res.configError).slice(0, 60)}`)
  ok(!/已写入 profile 配置/.test(res.restartHint), 'restartHint **绝不**说「已写入 profile 配置，重启宿主后依然生效」')
  ok(/不会生效|没写成功|失败/.test(res.restartHint), `restartHint 明说重启后不会生效：${res.restartHint}`)
  ok(fs.readFileSync(bad.ymlFile).equals(badBefore), '坏文件逐字节不变（没写半份进去）')

  // 反空转：合法 profile 上必须照旧报"已写入"
  const good = makeHome('choose-good', EMPTY_ROOT_TEMPLATE)
  const hctx2 = { paths: { packRoot: undefined }, log: { info() {}, warn() {}, error() {} } }
  const res2 = await choosePack({ dir: packDir, dshHome: good.home }, hctx2)
  ok(res2.config !== null && res2.configError === null, '合法 profile → config 回执照旧')
  ok(/已写入 profile 配置/.test(res2.restartHint), '成功时 restartHint 照旧说「已写入 profile 配置，重启宿主后依然生效」')
  ok(parseOverlayForTest(fs.readFileSync(good.ymlFile, 'utf8')).length === 1, '成功路径落盘后也只有一个根')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑧ 设置页展示侧（client.js）：失败进红字、不暗示重启生效')
{
  const clientSrc = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
  // 只看**代码行**（注释里当然可以写这句话，它不是会被渲染出来的文案）
  const clientCode = clientSrc.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  ok(!clientCode.includes('已写入 profile 配置'), '客户端**不再自己拼**「已写入 profile 配置」—— 这句只许由服务端按真实结果给（res.restartHint）')
  ok(clientCode.includes('res.restartHint'), '客户端展示用的是服务端给的 res.restartHint（失败/成功的文案跟着真结果走）')
  ok(/res\.configError/.test(clientCode), '客户端认得 res.configError')
  ok(/error:\s*[\s\S]{0,80}configError/.test(clientCode) || /configError[\s\S]{0,80}error:/.test(clientCode),
    '失败时把 configError 塞进 pick.error（红字），不是塞进成功文案')
  ok(/写 profile 配置失败/.test(clientCode), '红字里说清"写 profile 配置失败"，而不是让人以为重启就生效')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑨ patchPackRootYml 仍是纯文本变换（真解析只放在落盘路径）')
{
  const keysOf = (o) => Object.keys(o).sort().join(',')
  const bad1 = patchPackRootYml('top: 1\r\n', 'D:/y')
  ok(bad1.changed === 'append' && bad1.text.includes("packRoot: 'D:/y'"), '碰到 `top: 1` 这种文本照样返回 append（不在 patch 里拒）')
  eq(keysOf(bad1), 'changed,note,text', '返回字段集仍恰好是 changed,note,text')
  let threw = null
  let deep = null
  try { deep = patchPackRootYml('[]\n- id: baode\n  config: { a: 1 }\n', 'D:/z') } catch (e) { threw = e }
  ok(threw === null, '碰到"两个根"的文本也不抛（纯文本变换的语义没变）')
  ok(deep && typeof deep.text === 'string' && deep.text.includes('- id: whale-sensei'), '它照样把整段拼出来（拒写是落盘路径的事）')
  eq(patchPackRootYml.length, 2, '签名仍是 (text, packRoot) 两个形参')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑩ 两道闸同口径：写路径拒写的理由 = checkPackRootYml 的理由')
{
  const ymlInline = ['- id: whale-sensei', "  config: { packRoot: 'D:/old' }", ''].join('\n')
  const chk = checkPackRootYml(ymlInline)
  const { home } = makeHome('same-rule', ymlInline)
  const w = writeProfilePackRoot('E:/new/pack', { dshHome: home })
  ok(chk.ok === false && w.ok === false, 'inline config：形状闸与写闸都拒')
  eq(w.rule, chk.rule, '写闸的 rule 与 checkPackRootYml 的 rule 是同一个（不是两套口径）')

  const ymlDup = ['- id: whale-sensei', '  config:', '    a: 1', '- id: whale-sensei', '  config:', '    a: 2', ''].join('\n')
  const chk2 = checkPackRootYml(ymlDup)
  const h2 = makeHome('same-rule-dup', ymlDup)
  const w2 = writeProfilePackRoot('E:/new/pack', { dshHome: h2.home })
  eq(w2.rule, chk2.rule, '重复段：两侧 rule 也一致')

  // 反空转：合法文档必须过（不然"全都拒"也能骗过上面那几条）
  const valid = makeHome('same-rule-ok', EXISTING)
  const w3 = writeProfilePackRoot('E:/new/pack', { dshHome: valid.home })
  ok(w3.ok === true && !w3.rule, '合法的 profile 必须放行（没有 rule）')
  const found = findProfileDir({ dshHome: valid.home })
  ok(found.ok === true && found.name === 'web', 'findProfileDir 无回归（找到 web）')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑪ 真实宿主那种叠加层（块标量 + !!js 标签）不许被判死')
{
  // 形状照本机 `profiles/desktop/cordis.patch.yml` 的真实写法：`prefix: |` 里装整段提示词
  // （正文里有 `#`、有空行），别的插件用 `!!js` 表达条件。这些**都是合法叠加层** ——
  // 校验器要是把它们判死，用户这台机器的设置页就永远改不了 packRoot。
  const real = [
    '- id: preset-standard',
    '  name: "@deepseek-ai/dsh-agent-preset"',
    '  config:',
    '    plugins:',
    '      - id: persona',
    '        config:',
    '          prefix: |',
    '            You are a coding agent powered by the {{model}} model.',
    '            # 这一行里的 # 是正文，不是注释',
    '',
    '            tail line',
    '      - id: tool-bash',
    "        disabled: !!js process.platform === 'win32'",
    '- id: whale-sensei',
    '  config:',
    '    announceOnBoot: true',
    '',
  ].join('\n')
  const { home, ymlFile } = makeHome('real-like', real)
  const beforeWhale = sectionOf(real, 'whale-sensei')
  const w = writeProfilePackRoot('E:\\new\\pack', { dshHome: home })
  ok(w.ok === true, `块标量 + !!js 的合法叠加层照样能写：${w.ok ? 'ok' : w.error}`)
  const disk = fs.readFileSync(ymlFile, 'utf8')
  ok(disk.includes('prefix: |') && disk.includes('# 这一行里的 # 是正文'), '块标量正文原样保留（# 没被当注释切掉）')
  ok(disk.includes("disabled: !!js process.platform === 'win32'"), '别的插件的 !!js 标签原样保留')
  let parsed = null
  let perr = null
  try { parsed = parseOverlayForTest(disk) } catch (e) { perr = e }
  ok(perr === null, `写后的字节仍能被真解析${perr ? '：' + perr.message : ''}`)
  eq(parsed && parsed.length, 2, '两个顶层条目都在')
  eq(targetEntry(parsed)?.config?.packRoot, 'E:/new/pack', 'packRoot 落在 whale-sensei 的 config 下')
  const afterWhale = sectionOf(disk, 'whale-sensei')
  ok(afterWhale && beforeWhale && afterWhale !== beforeWhale && afterWhale.includes('announceOnBoot: true'),
    '目标段只多了 packRoot 那一行（announceOnBoot 还在）')
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑫ 目标段没有 config / `- insert:` 形状：补出来的必须仍是合法 YAML')
{
  // (a) 有 `- id: whale-sensei` 但整段只有 name（没有 config）—— 补 config 时顺序写反就废
  const bare = ['- id: whale-sensei', '  name: dsh-whale-sensei', ''].join('\n')
  const a = makeHome('no-config', bare)
  const wa = writeProfilePackRoot('E:\\new\\pack', { dshHome: a.home })
  ok(wa.ok === true, `没有 config 的目标段：写要 ok（${wa.ok ? 'ok' : wa.error}）`)
  let pa = null
  let ea = null
  try { pa = parseOverlayForTest(fs.readFileSync(a.ymlFile, 'utf8')) } catch (e) { ea = e }
  ok(ea === null, `补完之后仍能被真解析${ea ? '：' + ea.message : ''}`)
  eq(targetEntry(pa || [])?.config?.packRoot, 'E:/new/pack', 'packRoot 落在 config **下面**（不是条目的顶层键）')
  ok(fs.readFileSync(a.ymlFile, 'utf8').includes('name: dsh-whale-sensei'), '原有的 name 字段还在')

  // (b) 本包 `cordis.patch.yml` 那种 `- insert:` 嵌套形状（真文件、只读）
  const bundle = fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8')
  const b = makeHome('insert-shape', bundle)
  const wb = writeProfilePackRoot('E:\\new\\pack', { dshHome: b.home })
  ok(wb.ok === true, `- insert: 嵌套形状：写要 ok（${wb.ok ? 'ok' : String(wb.error).slice(0, 120)}）`)
  let pb = null
  let eb = null
  try { pb = parseOverlayForTest(fs.readFileSync(b.ymlFile, 'utf8')) } catch (e) { eb = e }
  ok(eb === null, `insert 形状补完之后仍能被真解析${eb ? '：' + eb.message : ''}`)
  const ins = Array.isArray(pb) && pb[0] && Array.isArray(pb[0].insert) ? pb[0].insert[0] : null
  ok(!!ins && ins.id === 'whale-sensei' && ins.name === 'dsh-whale-sensei', 'insert 里的 id/name 原样保留（没被写坏）')
  eq(ins && ins.config ? ins.config.packRoot : null, 'E:/new/pack', 'packRoot 落在 insert 条目的 config 下')
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 空序列根不再长出第二个根 · 落盘前真解析+结构校验 · 异常结构拒写不动盘 · 失败不谎报 · 幂等')
