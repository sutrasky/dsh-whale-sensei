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
 *   writeProfilePackRoot(packRoot, opts) -> { ok, file?, changed?, backup?, error? }
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
    return { text: [...lines, ...block].join(nl) + nl, changed: 'append', note: '原先没有这一段，已追加' }
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

  const indM = lines[idAt].match(/^(?<ind>\s*)/)
  const ind = `${indM?.groups?.ind ?? ''}  `
  lines.splice(idAt + 1, 0, `${ind}  packRoot: ${val}`, `${ind}config:`)
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
 * 落盘：找 profile → 备份 → 就地更新 → **回读校验**（判据是磁盘上的字节，不是内存里的变量）。
 * @param {string} packRoot 课程包绝对路径
 * @returns {{ok: boolean, file?: string, changed?: string, note?: string, backup?: string, error?: string}}
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

  const patched = patchPackRootYml(before, packRoot)

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

  let after = ''
  try { after = fs.readFileSync(found.yml, 'utf8') } catch { /* 读不回就按失败报 */ }
  if (!after.includes(yamlScalar(packRoot))) {
    return { ok: false, file: found.yml, backup, error: `写完了但回读没看到新的 packRoot —— 请手工检查 ${found.yml}` }
  }
  return { ok: true, file: found.yml, changed: patched.changed, note: patched.note, backup }
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
