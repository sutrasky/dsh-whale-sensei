'use strict'
/**
 * engine-policy.cjs — **受信引擎闭包**的判据与核验（T04 / 报告 D01）
 * ------------------------------------------------------------------
 * 为什么要有它（D01 原文的落点）：
 *   宿主预览（`lib/pack-server.js`）与构建链（`lib/rebuild-job.js` / `lib/ask-io.js`）
 *   今天**直接执行课程包里的代码** —— `createRequire(包)/require(包内 app-server.js)`、
 *   `spawn(node 包内 build-*.js)`。包里的那些脚本是**可写的**：换掉一个字节，
 *   宿主下一次预览/重建就跑了别人的代码。报告 §4.1 要求「执行前先核验受信引擎」。
 *
 * 本文件是那份核验的**唯一一份实现**，也是**随包发**的那一份（进 `TEMPLATE_FILES`）：
 *   插件侧 `lib/engine.js` 从**同一个** `lib/pack-template/tools/engine-policy.cjs` 取口径，
 *   课程包侧将来要自检也读它 —— 各写一份的结果就是"插件堵了、包侧还漏着"
 *   （与 T03 的 `tools/path-policy.cjs` 同一条纪律）。
 *
 * 三件东西：
 *   · `ENGINE_FILES`          —— **仓内明确代码清单**（不是"看盘上有什么"）：闭包的根
 *   · `buildManifest(root)`   —— 对清单逐件算 SHA-256 → 清单对象（含总摘要）
 *   · `verifyEngine(root, expectedManifest)` —— 拿**受信清单**核验一个包
 *
 * 四条铁律：
 *   ① **不信包自带的清单**：`expectedManifest` 一律由**调用方**（插件自己的模板）给出；
 *      本文件只负责"包里的字节 == 受信清单里的字节吗"。
 *   ② **缺件即拒**：清单里任何一件在包里不存在 / 不是普通文件（软链、目录）→ 拒。
 *      不做"缺的就算了"—— 那等于木马包删掉引擎件、只留一个任意入口就能过。
 *   ③ **空清单即拒**：`expectedManifest.files` 不是非空数组 → 拒（防"什么都不核验就放行"）。
 *   ④ **只读**：核验**不写盘、不起子进程**。写盘只发生在升级（`applyEngineUpgrade`，插件侧）。
 *
 * ⚠️ 本文件会被 `lib/pack-scaffold.js` 的 `TEMPLATE_FILES` 拷进**每一个新建的课程包**
 *    （`tools/engine-policy.cjs`），所以：不许出现任何机器专属路径 / 兄弟仓名
 *    （`test/alien-env.mjs` 的静态守卫会当场红），也不许 require 包外的东西。
 *    因此它**只依赖 node: 内置模块**，且**不 require** `tools/path-policy.cjs`
 *    （两件都是"随包发"的独立件，谁也不欠谁）。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** 清单格式版本：进摘要输入 —— 改格式必须让旧计划过期 */
const MANIFEST_VERSION = 1

/**
 * **受信引擎闭包**：仓内明确代码清单（POSIX 相对路径）。
 *
 * 这份清单是**机械算出来的**，不是眼看出来的 —— 从入口出发跟 require / import
 * （含 `require(path.join(__dirname, 'x.js'))` 这种间接写法、`await import(...)` 动态加载、
 * 以及 `spawnSync(process.execPath, [path.join(__dirname,'x.js')])` 起的**构建子进程**），
 * 算到不动点。`test/audit/T04.mjs` 有一条判据在**改完代码之后重算一遍**，
 * 清单与真实闭包漂了（少一件 / 多一件）当场红。
 *
 * 入口注册表（`ENTRY_REGISTRY`）是**固定**的：现有预览、答疑归档、构建链。
 * 不接受任意脚本路径 —— 谁想加一条链，得先改这里、再让闭包判据同意。
 */
const ENGINE_FILES = [
  // —— 预览入口（宿主进程内 require）——
  'tools/app-server.js',
  'tools/ask-server.js',
  // —— 答疑归档 / 重建链（宿主 spawn 子进程）——
  'tools/drain-questions.js',
  'tools/build-notes.js',
  'tools/build-lessons.js',
  'tools/build-starmap.js',
  'tools/build-starmap-svg.js',
  'tools/build-glossary-tree.js',
  'tools/circle-bands.js',
  'tools/style-adapter.js',
  'assets/build-glossary.js',
  // —— 上面这些的传递依赖（漏一件 = 建完跑不动）——
  'tools/lesson-map.js',
  'tools/pack-text.js',
  'tools/fingerprint.js',
  'tools/plan-map.js',
  'tools/title-classes.js',
  'tools/shape-render.js',
  'tools/style-check.js',
  'tools/galaxy-shapes.cjs',
  'starmap/data-layer.js',
  // —— 核验自己的那一份（随包发，必须也在受信集合里）——
  'tools/engine-policy.cjs',
  // —— 静态读取的公开清单（T06）：app-server 直接 require 它，而它又 require 共享路径策略 ——
  'tools/public-files.cjs',
  'tools/path-policy.cjs',
  // —— 独立服务的授权件（T07 / 报告 D02）：app-server / ask-server / offline-server 都 require 它 ——
  'tools/http-security.cjs',
  'tools/http-request.cjs',
  // —— 包级提交协议（T11 / 报告 C01）：ask-server / drain-questions 现在**直接 require** 它 ——
  //    机械闭包（`T04-ENGINE-required-deps-present`）从入口跟到它，不登记就是"少一件"。
  'tools/ledger-transaction.cjs',
]

/**
 * **入口注册表**（固定）：三条链 —— 预览 / 答疑归档 / 重建。
 * 每条链的 `scripts` 必须**全部**落在 `ENGINE_FILES` 里；
 * `verifyEngine` 会核这件事，`test/audit/T04.mjs` 也会（含"任意脚本路径"的负例）。
 */
const ENTRY_REGISTRY = [
  {
    id: 'preview',
    kind: 'require',
    subject: '预览服务',
    scripts: ['tools/app-server.js'],
  },
  {
    id: 'answer',
    kind: 'spawn',
    subject: '答疑写回',
    scripts: ['tools/drain-questions.js', 'tools/build-notes.js', 'tools/build-lessons.js'],
  },
  {
    id: 'notes',
    kind: 'spawn',
    subject: '笔记写回',
    scripts: ['tools/build-notes.js', 'tools/build-lessons.js'],
  },
  {
    id: 'rebuild',
    kind: 'spawn',
    subject: '重建链',
    scripts: ['tools/build-starmap.js', 'tools/build-starmap-svg.js', 'tools/build-glossary-tree.js',
      'tools/circle-bands.js', 'tools/style-adapter.js'],
  },
  {
    id: 'glossary',
    kind: 'spawn',
    subject: '术语产物',
    scripts: ['assets/build-glossary.js'],
  },
]

/** 摘要：字节 → 小写十六进制 SHA-256 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 清单里的一件：`{ path, sha256 }` */
function entryOf(root, rel) {
  const abs = path.join(root, ...String(rel).split('/'))
  let st
  try {
    st = fs.lstatSync(abs)
  } catch (e) {
    return { path: rel, sha256: null, missing: true, why: `不存在（${e && e.code ? e.code : '读不到'}）` }
  }
  // 软链 / 目录联接 / 目录：一律不当成"受信引擎件"（真身边界是 T03 的 path-policy 管的，
  // 这里要的是"这一件的字节就是受信的那一份"）
  if (st.isSymbolicLink()) return { path: rel, sha256: null, missing: true, why: '是软链 / 目录联接' }
  if (!st.isFile()) return { path: rel, sha256: null, missing: true, why: '不是普通文件' }
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch (e) {
    return { path: rel, sha256: null, missing: true, why: `读不动（${e && e.code ? e.code : e}）` }
  }
  return { path: rel, sha256: sha256(buf), bytes: buf.length }
}

/**
 * 对一份**清单**算总摘要。
 * 摘要输入 = 版本号 + 逐件 `path` + `sha256`（按 path 排序、LF 连接）——
 * 同样的清单永远同样摘要；换一个字节、少一件、多一件，摘要必变。
 */
function digestOfManifest(files) {
  const rows = [...files]
    .map((f) => ({ path: String(f.path), sha256: String(f.sha256 ?? '') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const text = [`manifest=${MANIFEST_VERSION}`, ...rows.map((r) => `${r.path}\t${r.sha256}`)].join('\n')
  return sha256(Buffer.from(text, 'utf8'))
}

/**
 * 对 `root` 按 `ENGINE_FILES` 算一份清单（**只读**）。
 * @param {string} root 课程包根（或任何有 `tools/` 的目录）
 * @param {{ files?: string[] }} [opts] `files` 可换一份清单（判据用；默认就是受信那份）
 * @returns {{ version:number, files:{path:string,sha256:string|null,missing?:boolean,why?:string}[], digest:string,
 *             missing:string[], ok:boolean, root:string }}
 */
function buildManifest(root, opts = {}) {
  const abs = path.resolve(String(root ?? ''))
  const list = Array.isArray(opts.files) ? opts.files.map(String) : ENGINE_FILES
  const files = list.map((rel) => entryOf(abs, rel))
  const missing = files.filter((f) => f.missing).map((f) => f.path)
  return {
    version: MANIFEST_VERSION,
    root: abs,
    files,
    missing,
    ok: missing.length === 0,
    digest: digestOfManifest(files),
  }
}

/** 受信清单的"形状"合不合格（防"什么都不核验就放行"） */
function manifestProblem(expected) {
  if (!expected || typeof expected !== 'object') return '受信清单不是对象'
  if (!Array.isArray(expected.files) || expected.files.length === 0) return '受信清单里没有 files（空清单 = 不核验，拒绝）'
  const bad = expected.files.filter((f) => !f || typeof f.path !== 'string' || !f.path)
  if (bad.length) return `受信清单里有 ${bad.length} 条缺 path`
  return null
}

/**
 * **核验一个包**：它的引擎字节是否与受信清单逐件相同。
 *
 * 只读、不起子进程、不写盘。失败时调用方必须**零 require / 零 spawn** 地拒绝
 * （调用点见 `lib/pack-server.js` / `lib/rebuild-job.js` / `lib/ask-io.js`）。
 *
 * @param {string} root 课程包根
 * @param {{version?:number, files:{path:string,sha256:string}[], digest?:string}} expected 受信清单
 * @returns {{ok:boolean, digest:string|null, missing:string[], mismatched:{path:string,expected:string,actual:string|null}[],
 *            checked:string[], error:string|null}}
 */
function verifyEngine(root, expected) {
  const problem = manifestProblem(expected)
  if (problem) {
    return { ok: false, digest: null, missing: [], mismatched: [], checked: [], error: problem }
  }
  const abs = path.resolve(String(root ?? ''))
  if (!abs || !String(root ?? '').trim()) {
    return { ok: false, digest: null, missing: [], mismatched: [], checked: [], error: '没有课程包根目录' }
  }

  const missing = []
  const mismatched = []
  const checked = []
  for (const want of expected.files) {
    const got = entryOf(abs, want.path)
    checked.push(want.path)
    if (got.missing) {
      missing.push(`${want.path}（${got.why}）`)
      continue
    }
    if (String(want.sha256 ?? '') !== got.sha256) {
      mismatched.push({ path: want.path, expected: String(want.sha256 ?? ''), actual: got.sha256 })
    }
  }

  const ok = missing.length === 0 && mismatched.length === 0
  return {
    ok,
    // 摘要口径：**实得**那一份（无论过不过都给，调用方可以拿它去比对计划）
    digest: buildManifest(abs, { files: expected.files.map((f) => f.path) }).digest,
    missing,
    mismatched,
    checked,
    error: ok ? null : summarizeFailure(missing, mismatched),
  }
}

/** 把核验失败翻成**一句能照着改的**话（调用方直接贴进 error） */
function summarizeFailure(missing, mismatched) {
  const parts = []
  if (missing.length) parts.push(`缺 ${missing.length} 件：${missing.slice(0, 4).join('、')}${missing.length > 4 ? ' …' : ''}`)
  if (mismatched.length) parts.push(`字节不一致 ${mismatched.length} 件：${mismatched.slice(0, 4).map((m) => m.path).join('、')}${mismatched.length > 4 ? ' …' : ''}`)
  return `这个课程包的引擎与插件受信版本不一致（${parts.join('；')}）`
}

/** 入口注册表里引用到的全部脚本（去重、保序） */
function registryScripts() {
  const out = []
  for (const e of ENTRY_REGISTRY) for (const s of e.scripts) if (!out.includes(s)) out.push(s)
  return out
}

/**
 * 入口注册表自查（**纯函数**）：每条链的脚本都必须在受信清单里。
 * 为什么要有它：注册表是"宿主只执行这些"的白名单，它自己引用了清单外的脚本 = 白名单漏了。
 * @returns {{ok:boolean, unknown:string[], error:string|null}}
 */
function checkRegistry() {
  const known = new Set(ENGINE_FILES)
  const unknown = []
  for (const e of ENTRY_REGISTRY) {
    if (!e || typeof e.id !== 'string' || !Array.isArray(e.scripts) || !e.scripts.length) {
      return { ok: false, unknown, error: `注册表里有一条不合形状：${JSON.stringify(e)}` }
    }
    for (const s of e.scripts) if (!known.has(s)) unknown.push(`${e.id} -> ${s}`)
  }
  return unknown.length
    ? { ok: false, unknown, error: `注册表引用了受信清单之外的脚本：${unknown.join('、')}` }
    : { ok: true, unknown: [], error: null }
}

module.exports = {
  MANIFEST_VERSION,
  ENGINE_FILES,
  ENTRY_REGISTRY,
  sha256,
  digestOfManifest,
  buildManifest,
  verifyEngine,
  registryScripts,
  checkRegistry,
  summarizeFailure,
}
