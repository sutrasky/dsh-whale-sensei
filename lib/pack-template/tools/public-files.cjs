'use strict'
/**
 * public-files.cjs — 静态读取的**公开清单**与路径解析（T06 / 报告 D03）
 * ------------------------------------------------------------------
 * 为什么要有它（D03 原文）：
 *   `tools/app-server.js` 的静态分支原先是
 *       `let target = path.join(ROOT, rel)` + `if (!path.resolve(target).startsWith(ROOT)) 403`
 *   两处都不够：
 *     ① **字符串前缀不是路径分量边界**：`ROOT = …\whale-pack` 时，
 *        `…\whale-pack-private\sentinel.txt` 也 `startsWith(ROOT)` —— 实测（Windows）
 *        `/..%5cwhale-pack-private%5csentinel.txt` 真的读出了包外同名前缀兄弟目录；
 *     ② **没核真身**：软链 / 目录联接把落点带出根，字符串上看不出任何问题；
 *     ③ **包根被当成公开根**：`lessons/src/**`（作者态源课）、`code/**`（学生代码）、
 *        `questions/`·`notes/`·`learning-records/`（私人原账）、`reference/NOTES.html`
 *        （私人派生页）、`pack.json` / `lesson.config.json`（配置）全都能被读走。
 *
 * 所以本文件是**静态读取的唯一一份**边界实现，三件事叠起来：
 *   · **只解一次**百分号编码 → 交给 T03 的共享路径策略 `path-policy.cjs`
 *     （`decodeRequestPath` + `resolveInside`：字面分量边界 **＋** realpath 真身边界）；
 *   · **公开清单** = 受信资源清单（声明式：目录 + 扩展名）**＋** 课程产物索引
 *     （`lessons/lessons.json` 里逐条声明过的课程页）——
 *     **不递归把包根设为公开目录**，也不是"扫盘上有什么就发什么"；
 *   · 链接（软链 / 目录联接）**本身**不放行：真身边界挡根外，`lstat` 再挡"是链接"这件事。
 *
 * 返回形状（卡面接口）：`resolvePublicFile(root, rawPath, {profile}) → {status, file?}`
 *   `status` 取 200 / 403 / 404 三档，语义写死：
 *     · **403** —— 路径本身不安全（穿越 / 绝对 / 反斜杠 / 控制字符 / 坏编码 / 链接逃逸）
 *     · **404** —— 路径安全，但不在公开清单里，或清单里却不在盘上
 *     · **200** —— 在公开清单里、真身落在根内、是普通文件 → 给 `file`（绝对路径）
 *
 * 两个 profile：
 *   · `reader`       —— 课程包自己的预览服务（`tools/app-server.js`）：整包的公开面
 *   · `admin-assets` —— 离线阅读器管理台的 `/assets/*`（`tools/offline-server.js`）：
 *                       **只**认 `<包>/assets/**`，别的目录一律不在清单里
 *
 * ⚠️ 本文件随包发（进 `lib/pack-scaffold.js` 的 `TEMPLATE_FILES`），所以：不许出现任何
 *    机器专属路径 / 兄弟仓名，也不许 require 包外的东西 —— 只依赖 node: 内置模块与
 *    同目录的 `tools/path-policy.cjs`（T03 那份共享策略，全仓只此一份实现）。
 *
 * 判据：`test/audit/T06.mjs`（同根资源 200 / 同名前缀兄弟 / 编码分隔符 / 链接出根 / 公开清单）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { decodeRequestPath, resolveInside } = require('./path-policy.cjs')

/** 认得的 profile（别的值**拒**，不静默按 reader 处理） */
const PROFILES = ['reader', 'admin-assets']

/**
 * **受信资源清单**：目录 + 允许的扩展名。声明式的，不是"扫盘"。
 * 加一条就是明确地多公开一类东西 —— 评审看得见。
 */
const RESOURCE_RULES = {
  reader: [
    // 页面外壳与运行时（`assets/_frame.html` 里逐个引用的那些）
    { dir: 'assets', ext: ['.css', '.js', '.mjs', '.woff2', '.woff', '.svg', '.png', '.ico'] },
    // 星图：页面 + 运行时 + three + 字体
    { dir: 'starmap', ext: ['.html', '.js', '.mjs', '.css', '.svg', '.woff2'] },
    // 名词地图只有一张页面壳（运行时在 assets/ 里）
    { dir: 'glossary', ext: ['.html'] },
  ],
  'admin-assets': [
    // 管理台只穿鲸师自己的主题与字体（`tools/offline-admin.html` 引用的那几件）
    { dir: 'assets', ext: ['.css', '.js', '.woff2', '.svg', '.png', '.ico'] },
  ],
}

/** 根目录下**明确**公开的单件 */
const ROOT_FILES = {
  reader: ['index.html', 'GLOSSARY.md'],
  'admin-assets': [],
}

/** 目录形式的入口（`/`、`/starmap/`、`/glossary/`）—— 只有清单里声明的这些认 */
const DIR_INDEX = {
  reader: { '': 'index.html', starmap: 'index.html', glossary: 'index.html' },
  'admin-assets': {},
}

/** **课程产物索引**（课程页的唯一来源：构建器写的那份清单） */
const LESSON_INDEX = 'lessons/lessons.json'
/** 索引里的 `rel` 是**相对 `lessons/`** 的（构建器口径）：服务面上的路径要补上这一段 */
const LESSON_DIR = 'lessons'

/**
 * 明确**不公开**的东西（纵深 + 把卡面的 outOfScope 写死在代码里，而不是靠"没列进清单"）。
 * 前缀按**路径分量**比：`lessons/src` 不会误伤 `lessons/src2`。
 */
const DENY_PREFIXES = [
  'lessons/src',        // 作者态源课（不是课程页）
  'code',               // 学生自己的代码
  'tools',              // 引擎件（含预览服务本身）
  'questions',          // 待答 / 已答原账
  'notes',              // 学生笔记原账
  'learning-records',   // 学情摸底 / 终点 / 教学 / 证据 / 快照
  'reference',          // 私人派生页（NOTES.html / QUESTIONS.md）
  'presets', 'templates', 'styles', 'skills', 'dist', 'node_modules', '.git', '.trash', '.backup',
]
/** 明确不公开的单件名（配置 / 进度 / 台账的原始件） */
const DENY_FILES = ['pack.json', 'lesson.config.json', 'progress.json']
/** 明确不公开的扩展名（原账 / 锁 / 日志 / 脚本） */
const DENY_EXT = ['.jsonl', '.lock', '.log', '.ps1', '.iss', '.yml', '.yaml']

/** 统一的拒绝回执（`status` + 一句能读的话） */
const deny = (status, error) => ({ status, error: String(error) })

/** `rel` 是不是在目录 `dir` 之下（按**分量**比，不做字符串前缀） */
function isUnder(rel, dir) {
  return rel.startsWith(`${dir}/`)
}

/**
 * 有没有**隐藏分量**（`.` 开头的目录 / 文件名）。
 *
 * 为什么要有这条（T09 / 报告 C01）：包级事务的日志与锁是 `.whale-txn/`、`.whale-write.lock` ——
 * 它们**不进学习产物、不进发布物**，是卡面明写的边界。上面那两张表（前缀 / 单件名 / 扩展名）
 * 是**枚举**，枚举漏一条就是一条公开面：`.whale-txn/<uuid>/journal.json` 的扩展名是 `.json`
 * （不在 `DENY_EXT` 里），一旦将来有人往 `RESOURCE_RULES` 里加一条 `.json` 就会连事务日志
 * 一起发出去。这条规则按**形状**兜底：隐藏分量一律不公开（`.git` / `.trash` / `.backup`
 * 也在内 —— 它们本来就在 `DENY_PREFIXES` 里枚举着，这条只是不让枚举漏掉新来的）。
 */
function hasHiddenComponent(rel) {
  return String(rel).split('/').some((seg) => seg.length > 1 && seg.startsWith('.'))
}

/** 这一条相对路径是不是明确不公开的 */
function isDenied(rel) {
  if (!rel) return true
  if (hasHiddenComponent(rel)) return true
  for (const p of DENY_PREFIXES) if (rel === p || isUnder(rel, p)) return true
  const base = path.posix.basename(rel)
  if (DENY_FILES.includes(base)) return true
  if (DENY_EXT.includes(path.posix.extname(rel).toLowerCase())) return true
  if (/\.tmp-|~$/.test(base)) return true
  return false
}

/**
 * 读**课程产物索引**（`lessons/lessons.json`）→ 该公开的课程页集合。
 *
 * ⚠️ 索引本身是**不可信输入**（导入的课件包能带它）：每一条都要过同一套边界，
 *    写得不规范 / 带穿越 / 指到 `lessons/src/` 的条目一律**剔掉**（不静默收下）。
 * ⚠️ 缓存按 `mtime+size` 失效：索引没变就不重读，变了立刻重算。
 */
const indexCache = new Map()
function lessonIndex(root) {
  const abs = path.join(root, ...LESSON_INDEX.split('/'))
  let key = 'none'
  try {
    const st = fs.statSync(abs)
    key = `${st.mtimeMs}:${st.size}`
  } catch { key = 'none' }
  const hit = indexCache.get(root)
  if (hit && hit.key === key) return hit.set

  const out = new Set()
  let text = null
  try { text = fs.readFileSync(abs, 'utf8') } catch { text = null }
  if (text !== null) {
    let idx = null
    try { idx = JSON.parse(text) } catch { idx = null }
    const list = idx && Array.isArray(idx.lessons) ? idx.lessons : []
    for (const l of list) {
      const rel = l && typeof l.rel === 'string' ? l.rel : ''
      if (!rel || !/\.html$/i.test(rel)) continue
      // 索引里的 rel 相对 `lessons/`（构建器口径）—— 补上那一段再走同一套边界
      const full = `${LESSON_DIR}/${rel}`
      const inside = resolveInside(root, full, { mustExist: false })
      if (!inside.ok) continue
      const norm = path.relative(root, inside.abs).split(path.sep).join('/')
      if (norm !== full) continue                    // 索引里写的必须就是归一后的相对路径
      if (isDenied(norm)) continue                   // lessons/src/** 之类一律剔
      out.add(norm)
    }
  }
  indexCache.set(root, { key, set: out })
  return out
}

/** 这一段请求路径（已解码）在这一档 profile 下要不要走"目录入口页" */
function dirIndexOf(rel, profile) {
  const map = DIR_INDEX[profile] || {}
  if (rel === '') return Object.prototype.hasOwnProperty.call(map, '') ? map[''] : null
  if (Object.prototype.hasOwnProperty.call(map, rel)) return `${rel}/${map[rel]}`
  return rel
}

/** 这一条相对路径在不在公开清单里 */
function inManifest(rel, profile, root) {
  if (isDenied(rel)) return false
  if ((ROOT_FILES[profile] || []).includes(rel)) return true
  for (const r of RESOURCE_RULES[profile] || []) {
    if (!isUnder(rel, r.dir)) continue
    if (r.ext.includes(path.posix.extname(rel).toLowerCase())) return true
  }
  if (profile === 'reader') {
    if (rel === LESSON_INDEX) return true
    if (lessonIndex(root).has(rel)) return true
  }
  return false
}

/**
 * 把一条**原始请求路径**解成"公开清单里的一个落点"。
 *
 * @param {string} root 课程包根（绝对或相对都行，内部 resolve）
 * @param {string} rawPath HTTP 里拿到的那串（形如 `/starmap/`、`/assets/theme.css`）
 * @param {{profile?: 'reader'|'admin-assets'}} [opts]
 * @returns {{status:number, file?:string, rel?:string, profile?:string, root?:string, error?:string}}
 */
function resolvePublicFile(root, rawPath, opts = {}) {
  const profile = opts.profile === undefined ? 'reader' : String(opts.profile)
  if (!PROFILES.includes(profile)) {
    return deny(403, `未知的静态读取 profile：${JSON.stringify(opts.profile)}（只认 ${PROFILES.join(' / ')}）`)
  }
  if (root === undefined || root === null || !String(root).trim()) {
    return deny(403, '没有课程包根目录')
  }
  const absRoot = path.resolve(String(root).trim())
  try {
    fs.realpathSync(absRoot)
  } catch {
    return deny(404, `课程包根不存在（或读不动）：${absRoot}`)
  }

  // ① 只解一次百分号编码，再按同一套规则拆分量（T03 共享策略）
  const dec = decodeRequestPath(rawPath)
  if (!dec.ok) return deny(403, dec.error)

  // ② 目录形式 → 清单里声明的入口页
  const rel = dirIndexOf(dec.rel, profile)
  if (rel === null) return deny(404, `不是公开资源：${dec.rel || '/'}`)

  // ③ 公开清单（受信资源清单 + 课程产物索引）
  if (!inManifest(rel, profile, absRoot)) return deny(404, `不在公开清单里：${rel}`)

  // ④ 字面分量边界 + realpath 真身边界（T03）
  const inside = resolveInside(absRoot, rel, {})
  if (!inside.ok) return deny(403, inside.error)

  // ⑤ 链接本身也不放行（真身边界挡"指向根外"，这里挡"它是链接"这件事）
  let st = null
  try { st = fs.lstatSync(inside.abs) } catch { return deny(404, `文件不存在：${rel}`) }
  if (st.isSymbolicLink()) return deny(403, `不读链接（软链 / 目录联接）：${rel}`)
  if (!st.isFile()) return deny(404, `不是普通文件：${rel}`)

  return { status: 200, file: inside.abs, rel, profile, root: absRoot }
}

/**
 * 公开清单的**形状**（给判据看"它是声明式清单 + 索引，不是把包根当公开目录"）。
 * 只读、不写盘。
 */
function publicManifest(root, opts = {}) {
  const profile = opts.profile === undefined ? 'reader' : String(opts.profile)
  if (!PROFILES.includes(profile)) return { ok: false, error: `未知 profile：${JSON.stringify(opts.profile)}` }
  const absRoot = path.resolve(String(root || '').trim() || '.')
  const files = new Set(ROOT_FILES[profile] || [])
  for (const [d, idx] of Object.entries(DIR_INDEX[profile] || {})) files.add(d === '' ? idx : `${d}/${idx}`)
  const dirs = (RESOURCE_RULES[profile] || []).map((r) => ({ dir: r.dir, ext: [...r.ext] }))
  if (profile === 'reader') {
    files.add(LESSON_INDEX)
    for (const f of lessonIndex(absRoot)) files.add(f)
  }
  return {
    ok: true,
    profile,
    root: absRoot,
    files: [...files].sort(),
    dirs,
    denied: { prefixes: [...DENY_PREFIXES], files: [...DENY_FILES], ext: [...DENY_EXT] },
    note: '受信资源清单（目录 + 扩展名，声明式）+ 课程产物索引（lessons/lessons.json）；**不**递归把包根设为公开目录',
  }
}

module.exports = {
  resolvePublicFile,
  publicManifest,
  PROFILES,
  RESOURCE_RULES,
  ROOT_FILES,
  DIR_INDEX,
  LESSON_INDEX,
  DENY_PREFIXES,
  DENY_FILES,
  DENY_EXT,
  isDenied,
}
