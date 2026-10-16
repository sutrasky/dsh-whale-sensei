'use strict'
/**
 * path-policy.cjs — **共享路径策略**（T03 / 报告 B01）
 * ------------------------------------------------------------------
 * 为什么是"共享"：写课（插件侧 `lib/author.js`）与包侧那些吃 HTTP 路径的工具
 * （`tools/app-server.js` / `tools/ask-server.js` 等）**必须认同同一套边界**。
 * 报告 §446 的原话：「路径检查要同时保护读/写/执行/移库 …… 归一化和 realpath
 * 边界要进入**可信 IO 边界**」—— 各写一份的结果就是"插件堵了、包侧还漏着"。
 *
 * 所以本文件是**唯一一份**实现，三件东西：
 *
 *   · `validateId(value)`                 —— 圆圈 / 知识点 id 的形状（目录名就是它）
 *   · `resolveInside(root, rel, opts)`    —— 把一个**相对路径**解到根内，越界即拒
 *   · `decodeRequestPath(rawPath)`        —— 把一个**原始请求路径**解成安全的相对路径
 *
 * 三条铁律：
 *   ① **不做静默修正**：越界、绝对路径、`..`、反斜杠、控制字符一律**拒**（返回 error），
 *      绝不"顺手 sanitize 一下再放行" —— 那会把攻击面藏进一个看不见的分支里。
 *   ② **字面边界 + 真身边界两道**：先按字符串判（不看盘），再用 `realpath` 判一次
 *      （软链 / 目录联接不能把落点带出根）。只看字符串是挡不住联接的。
 *   ③ **返回形状统一**：`{ ok:true, ... }` / `{ ok:false, error }`。调用方不许靠抛异常
 *      分支（写课入口要把拒绝**如实回执**，抛出去就变成"崩了"而不是"拒了"）。
 *
 * ⚠️ 本文件会被 `lib/pack-scaffold.js` 的 `TEMPLATE_FILES` 拷进**每一个新建的课程包**
 *    （`tools/path-policy.cjs`），所以：不许出现任何机器专属路径 / 兄弟仓名
 *    （`test/alien-env.mjs` 的静态守卫会当场红），也不许 require 包外的东西。
 *
 * 插件侧不是"另一份实现"：`lib/author.js` 只是把这里的三件**再导出**一次
 * （判据落在 `test/audit/T03.mjs` 的 `T03-POLICY-single-source`：全仓只许有一份
 * `validateId` / `resolveInside` / `decodeRequestPath` 的实现）。
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * id 的合法形状 —— 与 `lib/mods/create.js` 的 `ID_RE` **同一份口径**
 * （建圈 / 建点入口用什么，写课入口就用什么；两处不一致 = 同一个 id 一处能建一处不能写）。
 * 大小写、下划线、点、空格、斜杠一律不认 —— 它们同时是**目录名**，宽一点就多一条逃逸面。
 */
const ID_RE = /^[a-z][a-z0-9-]*$/
/** id 长度上限（目录名，别让路径长到 Windows 的 MAX_PATH 边缘） */
const ID_MAX = 64

/**
 * 校验一个圆圈 / 知识点 id。
 * @param {unknown} value
 * @returns {string|null} 合法回 `null`；不合法回**一句能照着改的**话（与 create.js 同形）
 */
function validateId(value) {
  if (typeof value !== 'string') {
    return `id 不合法：${JSON.stringify(value)} —— 必须是字符串（圆圈 / 知识点 id 同时是目录名）`
  }
  if (!ID_RE.test(value)) {
    return `id 不合法：${JSON.stringify(value)} —— 必须匹配 /^[a-z][a-z0-9-]*$/（小写字母开头，只含小写字母 / 数字 / 连字符；不要斜杠、点、空格、大写）`
  }
  if (value.length > ID_MAX) {
    return `id 太长：${value.length} 字符（上限 ${ID_MAX}）—— 它同时是目录名，别把路径撑到系统上限`
  }
  return null
}

/** 看着像"绝对路径"吗（POSIX 根 / 盘符 / UNC）——不看盘，纯字符串 */
function looksAbsolute(s) {
  const t = String(s)
  return path.isAbsolute(t) || /^[A-Za-z]:/.test(t) || t.startsWith('/') || t.startsWith('\\')
}

/** 控制字符（含 NUL）：路径里出现它一律拒 —— 下游的 fs 调用会给出难懂的错误 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * 把一段**相对路径**拆成安全的分段。
 * @param {unknown} rel
 * @param {{allowRoot?:boolean}} opts
 * @returns {{ok:true, parts:string[]}|{ok:false, error:string}}
 */
function splitRel(rel, opts = {}) {
  if (typeof rel !== 'string') {
    return { ok: false, error: `相对路径必须是字符串（收到 ${JSON.stringify(rel)}）` }
  }
  if (CONTROL_RE.test(rel)) {
    return { ok: false, error: '相对路径里有控制字符（含 NUL）—— 拒绝' }
  }
  if (looksAbsolute(rel)) {
    return { ok: false, error: `不许用绝对路径：${JSON.stringify(rel)}` }
  }
  if (rel.includes('\\')) {
    // 反斜杠在 Windows 上也是分隔符：放它过去等于给"两套归一化"留后门。
    // 我们的相对路径一律 POSIX 正斜杠（`lessons/src/<圈>/<点>/NNNN-slug.html`）。
    return { ok: false, error: `相对路径里不许有反斜杠：${JSON.stringify(rel)}（一律用 / ）` }
  }
  const parts = []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      return { ok: false, error: `相对路径里有 ..（目录穿越）：${JSON.stringify(rel)}` }
    }
    parts.push(seg)
  }
  if (!parts.length && !opts.allowRoot) {
    return { ok: false, error: `相对路径是空的（指向根本身）：${JSON.stringify(rel)}` }
  }
  return { ok: true, parts }
}

/** `realpathSync` 的安静版：读不动回 null（调用方据此决定是拒还是继续） */
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/** 离 `abs` 最近的**已存在**祖先（含它自己）——不存在的新文件也能做真身边界检查 */
function nearestExisting(abs) {
  let cur = abs
  for (let i = 0; i < 256; i++) {
    if (fs.existsSync(cur)) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
  return null
}

/** `child` 是不是在 `parent` 之内（含相等）——两侧都必须是**归一后的绝对路径** */
function isInside(parent, child) {
  if (child === parent) return true
  return child.startsWith(parent + path.sep)
}

/**
 * 把一个**相对路径**解到 `root` 之内。
 *
 * 两道边界：
 *   ① 字面：`path.join(root, rel)` 归一后必须仍在 root 内（挡 `..` / 绝对路径）；
 *   ② 真身：对"离落点最近的已存在祖先"取 `realpath`，必须仍在 `realpath(root)` 内
 *      （挡软链 / 目录联接把落点带出根 —— 只看字符串挡不住这一条）。
 *
 * @param {string} root 课程包根（必须**已存在**：写盘的前提）
 * @param {string} rel  POSIX 相对路径
 * @param {{mustExist?:boolean, allowRoot?:boolean}} [opts]
 *   `mustExist` = 落点必须已存在；`allowRoot` = 允许 `rel` 指向根本身（空 / `.`）
 * @returns {{ok:true, abs:string, root:string}|{ok:false, error:string}}
 */
function resolveInside(root, rel, opts = {}) {
  const { mustExist = false, allowRoot = false } = opts
  if (root === undefined || root === null || !String(root).trim()) {
    return { ok: false, error: '没有课程包根目录' }
  }
  const absRoot = path.resolve(String(root).trim())
  const realRoot = realpathOrNull(absRoot)
  if (realRoot === null) {
    return { ok: false, error: `课程包根不存在（或读不动）：${absRoot}` }
  }

  const split = splitRel(rel, { allowRoot })
  if (!split.ok) return split

  const abs = split.parts.length ? path.join(absRoot, ...split.parts) : absRoot
  if (!isInside(absRoot, abs)) {
    return { ok: false, error: `解析后落在课程包之外：${abs}` }
  }

  const probe = nearestExisting(abs)
  if (probe === null) return { ok: false, error: `路径解析失败（找不到任何已存在的祖先）：${abs}` }
  const realProbe = realpathOrNull(probe)
  if (realProbe === null) return { ok: false, error: `路径解析失败：${probe}` }
  if (!isInside(realRoot, realProbe)) {
    return { ok: false, error: `解析后落在课程包之外（软链 / 目录联接？）：${realProbe}` }
  }

  if (mustExist && !fs.existsSync(abs)) {
    return { ok: false, error: `文件不存在：${rel}` }
  }
  return { ok: true, abs, root: absRoot }
}

/**
 * 把一个**原始请求路径**（HTTP 里拿到的那串）解成安全的相对路径。
 *
 * 顺序即契约：先切 query / fragment（它们不是路径），再**只解一次**百分号编码，
 * 再按同一套规则拆段。解一次是有意的：解两次等于给 `%252e%252e` 开后门。
 *
 * @param {string} rawPath 形如 `/lessons/src/a/b.html?x=1#f` 或 `%2e%2e%2fetc`
 * @returns {{ok:true, rel:string, parts:string[]}|{ok:false, error:string}}
 */
function decodeRequestPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) {
    return { ok: false, error: `请求路径必须是字符串：${JSON.stringify(rawPath)}` }
  }
  let s = rawPath
  const cut = s.search(/[?#]/)
  if (cut >= 0) s = s.slice(0, cut)
  if (CONTROL_RE.test(s)) {
    return { ok: false, error: '请求路径里有控制字符（含 NUL）—— 拒绝' }
  }
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s)
    } catch (e) {
      return { ok: false, error: `百分号编码解不开：${e && e.message ? e.message : e}` }
    }
  }
  if (CONTROL_RE.test(s)) {
    return { ok: false, error: '请求路径解出来后含控制字符（含 NUL）—— 拒绝' }
  }
  // ⚠️ 开头那个 `/` 不是"绝对路径"，是路由的根（HTTP 请求路径一律带着它）—— 剥掉。
  //    但**盘符 / UNC 剥不掉**：`/<盘符>:/Windows/…` 剥完还是盘符路径，
  //    由下面的 splitRel 按"绝对路径"拒。剥掉 ≠ 放行，这一步只是把协议的一部分去掉。
  s = s.replace(/^\/+/, '')
  const split = splitRel(s, { allowRoot: true })
  if (!split.ok) return split
  return { ok: true, rel: split.parts.join('/'), parts: split.parts }
}

module.exports = {
  ID_RE,
  ID_MAX,
  validateId,
  resolveInside,
  decodeRequestPath,
  // 给判据 / 下游用的小工具（同一套边界，不许在别处再写一份）
  looksAbsolute,
  isInside,
}
