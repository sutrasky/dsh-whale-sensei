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
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ID_RE = /^(?<ind>\s*)-\s*id:\s*whale-sensei\s*$/
const NEXT_RE = /^\s*-\s+\S/

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
    if (ID_RE.test(lines[i])) { idAt = i; break }
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
