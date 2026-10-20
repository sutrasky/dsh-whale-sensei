#!/usr/bin/env node
/**
 * test/audit/U07.mjs —— 课程页渲染收为单一计算（U07 专项入口）
 * ==================================================================
 * 卡面三项交付：
 *   ① `lib/unify/render.cjs`（新建）是课程页渲染的**唯一计算**（纯 CJS：不读盘 / 不看时钟 /
 *      不用随机 / 不看环境）；
 *   ② `lib/render.js` 变成 ESM 适配层（导出面、参数、默认值、返回形状逐字保留，把宿主侧的
 *      `labelAnchorId` 与 h2/h3 静态流彩类**注入**内核）；
 *   ③ `lib/pack-template/tools/build-lessons.js` 保留**包侧 CLI / IO**，渲染计算改成
 *      `require('./unify/render.cjs')`；
 *   `lib/render-inputs.js` 读后判定**已经是纯 IO 适配层**（零渲染计算），本次 0 字节改动 ——
 *   委托链 = render-inputs（IO）→ render.js（ESM 适配 + 注入）→ render.cjs（唯一计算）。
 *
 * 两个根（必须分开）：
 *   **读取根恒为 `<repo>/audit-evidence/U07`** —— 改前采集材料（`pre-change.json` /
 *   `pre-sources.json` / `pre-sources/*` / `fixtures.mjs`）。`--evidence-root=<绝对路径>`
 *   **只决定本次运行产物写哪儿**，不改读取根、不覆盖既有采集证据；缺材料 ⇒ BLOCKED。
 *
 * 判词（stdout 一行，exit 0/1/2）：
 *   `PASS U07 checks=8 failed=0 skipped=0` / `FAIL U07 …` / `BLOCKED U07 …`
 *
 * 八项判据（没有恒真项；每个对照物都是**改前字节**或**可证伪的现况**）：
 *   A01 可归因的逐字节等价 —— **两份基准**（`pre-change.json` 是 pre-U09 的旧基准，
 *       `pre-change.canonical.json` 是当前基准），三条判据缺一不可：
 *        ① 现状稳定：同一进程内同输入渲染两次逐字节相同，且与**当前基准**逐字节相同；
 *        ② 差异可归因：旧基准 → 当前基准的每一处差异都必须被一张**显式身份迁移表**解释
 *           （表由 `lib/unify/identity.cjs` 的真实函数现算，不是手写常量）；把夹具里承载
 *           身份的输入按表迁移后，当前渲染必须与**旧基准**逐字节相同；解释不了的差异 ⇒ 红；
 *        ③ 非身份零变化：把身份串从两份输出里抹掉后，非身份区块（图型/导航/笔记/答疑/
 *           coach/样式槽位/页脚）逐字节相同。
 *       反向抽取仍以**改前包侧字节**为准（收成一份时取产品侧语义，Δ 见回执），并证明
 *       旧平铺页上改前两侧本来就一致（所以"逐字节等价"不是拿分歧掩盖过去）。
 *       三条判据各带**进程内负对照**（给判据喂一个必然坏的输入，它必须红）——判据不许是空转。
 *   A02 图型 / 导航 / 笔记 / 答疑注入保持 —— 逐页断言图型 DOM、上一课/下一课、地图前沿的
 *       `data-from-plan`、手写占位回落、笔记/答疑计数（含孤儿 anchor 不许错算）、h2/h3 类注入、
 *       `{{PAGE_UP}}` 二趟、`PAGE_STYLE`、coach 三槽位注入；并核对同一断言在改前字节上也成立。
 *   A03 坏源和缺依赖如实失败 —— 坏模板（缺整行 coach 占位）/ 缺字段 / 缺文件 / 缺注入能力 /
 *       缺 `tools/unify/render.cjs`（本卡登记的中间态）/ 坏 JSON / 坏图型：全部明确失败，
 *       且失败时**不落任何产物页**（没有伪空页）。
 *   A04 纯内核 —— 源码静态扫描（无 fs / process / Date / Math.random / __dirname / import）
 *       ＋ 行为：把 fs 读、时钟、随机源、环境变量全部篡改/投毒后，同输入仍逐字节同输出。
 *   A05 宿主与独立临时包同一计算 —— 源码层（包侧与 ESM 层都没有第二份渲染计算；帧槽位正则与
 *       coach 正则全仓只有一处）＋ 运行时（E:\Temp 自建包从仓外 cwd 跑包侧 CLI，产物与宿主
 *       planBuild 对同一份输入逐字节相同；临时包里 `tools/unify/render.cjs` 与权威字节相同）。
 *   A06 同进程输入变化可见 —— 同一进程里改源文件 / 地图 / 笔记台账 / 名词台账后重算，输出跟着变；
 *       改回去逐字节回到改前字节；内核无模块级缓存（静态 + 行为）。
 *   A07 变异判据失败 —— E:\Temp 副本里给渲染输出加一个字符 → A01 那条判据必须红（含未变异对照）。
 *   A08 证据与清理受控 —— 进程内 fs 写守卫（write/append/mkdir/cp/rename/rm 全拦，记绝对路径，
 *       断言只落在 {本卡写集 ∪ 本卡证据根 ∪ E:\Temp 本次唯一目录}；探针写自证守卫挂着）＋
 *       **依赖内核口径四条**（运行期自锚 / 外漂移按 §6 归属 / P1·P2 授权面认领 / 交付物内容锁）＋
 *       **模板生成副本三条**（存在 ⇒ 必须自洽于 `tools/sync-unify-core.mjs --check`／不存在 ⇒
 *       合法但必须登记 `mirrorAbsent:true`／无论存不存在，本卡本次运行对它**零写**）＋
 *       `--evidence-root` 守卫＋临时目录按绝对路径归属清理＋tracked 回执五项齐。
 *
 * A07 的变异只发生在 `E:\Temp` 本次唯一目录里，跑完按绝对路径守卫清理。
 * 本入口**不跑活包**（只读仓内模板 + E:\Temp 自建夹具），也不访问 `E:\workplace\study`。
 *
 * ── 身份代（2026-10-19 判据修正，仍属 U07 写集）──────────────────────────────
 * U09 把课次身份从两段 `point/NNNN` 收敛到规范三段 `circle/point/NNNN`，运行态此后**如实
 * 拒绝**历史形状（U09 回执 D1/D3）。旧基准采在收敛之前，夹具账本用的是当时那代写法 ——
 * 于是**同一份夹具**上笔记计数从 2/1 变成 0/0：这是 A 授权的预期结果，不是渲染内核漂移
 * （渲染出来的身份串形状没变、非身份区块一个字节没动，判据 ②③ 证明这一点）。
 * 因此 A01 从"逐字节对拍旧快照"升级成"**可归因**的逐字节对拍"：旧基准原样保留，另采
 * 当前基准，两代之间的**每一处**差异都必须被显式迁移表解释；强度只增不减。
 *
 * ── A08 第⑤条口径修正（2026-10-21，仍属 U07 写集）────────────────────────────
 * 原口径「依赖内核 sha256 必须等于采集时值」在**共享工作区**里会把别人合法的交付判成漂移
 * （本轮 P1 按授权把 `lib/unify/fingerprint.cjs` 的 PROBE_VERSION 重算成 p:45a70ecdc10f03d4）。
 * 改成四条，强度不降（理由见下面每条的括注）：
 *   ① **运行期自锚**：模块初始化时（任何用例之前）记 10 份依赖内核的 sha256，收口前再比一次
 *      —— 证明"我这一跑没写它们"。（覆盖面换位：原来只判"跨卡静止"，现在还判"本跑没动"，
 *      并且**包含写集内的内核** render.cjs —— 那道 fs 写守卫本来就抓不到它。）
 *   ② **外漂移按归属**：与采集时值不同 ⇒ 按 `docs/unify/interfaces.md` §6 **运行时解析**归属；
 *      **无主 ⇒ 红**（不可归属的漂移一律红），有主 ⇒ 登记 + 记主人。
 *   ③ **P1/P2 授权面认同**：漂移落在 `docs/unify/authorization.json` 的 `scope.P1`（按 PROBE_SOURCES
 *      重算 PROBE_VERSION 那一个常量）或 `scope.P2` 上 ⇒ 判 `authorized-by-P1P2`（只登记，附
 *      `quoteVerbatim` 逐字）。授权面**运行时现场解析**，不硬编码；载体那一条还要求"现值 ==
 *      按 PROBE_SOURCES 的重算值 + 全仓只有这一份字面量 + 宿主/包侧不再各自持有" ——
 *      所以"随便改了个常量"照样红，认的只是授权描述的那个动作。
 *   ④ **交付物内容锁**：本卡四份生产文件必须仍等于 tracked 回执登记的字节（原样保留）。
 * 四条各有**进程内负对照**（喂必然坏的输入，必须红在指定理由上），所以它们不是空转。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  FIXED_IDS, REPO, runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot,
  guardTempPath, safeRemoveTree, Blocked,
} from './unify-runner.mjs'

const CARD = 'U07'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const ARGV = process.argv.slice(2)

/** 改前采集材料（**读取根恒定**，不受 --evidence-root 影响） */
const BASELINE_ROOT = path.join(REPO, 'audit-evidence', CARD)
const PRE_FILE = path.join(BASELINE_ROOT, 'pre-change.json')
const CANON_FILE = path.join(BASELINE_ROOT, 'pre-change.canonical.json')
const PRE_SOURCES_FILE = path.join(BASELINE_ROOT, 'pre-sources.json')
const FIXTURES_FILE = path.join(BASELINE_ROOT, 'fixtures.mjs')
/** 判据修正材料（身份代迁移表 / helper 快照 / §5 复制清单；同一读取根） */
const ERA_MODULE_FILE = path.join(BASELINE_ROOT, 'identity-era.mjs')
const HELPER_MODULE_FILE = path.join(BASELINE_ROOT, 'helper-snapshot.mjs')
const MIRROR_MODULE_FILE = path.join(BASELINE_ROOT, 'mirror-copy.mjs')

/** 两代基准的标记（采集材料与判据必须对得上，否则就是拿错尺子） */
const ERA_LEGACY = 'pre-U09-identity'
const ERA_CANONICAL = 'canonical-identity'

const TEMP_PARENT = 'E:\\Temp'
const RUN_TEMP = path.join(TEMP_PARENT, `${CARD.toLowerCase()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')

/** 本卡写集（相对仓根）—— A08 的越界守卫以它为准 */
const WRITE_SET = [
  'lib/unify/render.cjs',
  'lib/render.js',
  'lib/render-inputs.js',
  'lib/pack-template/tools/build-lessons.js',
  'test/audit/U07.mjs',
  'docs/unify/receipts/U07.json',
]
/** 改前就存在、必须逐字保留的导出面（来自 `git show HEAD:…` 的改前快照，见 pre-sources.json） */
const HOST_EXPORTS_OLD = [
  'figureMap', 'substituteFigures', 'pageSequence', 'balancedEl', 'indexOfMarkup', 'elByClass',
  'afterH2', 'h2Start', 'trimBlankLines', 'buildGlossaryIndex', 'parseSource', 'escapeHtml',
  'nextPlaceholderSpan', 'renderPage', 'extractPage', 'collectNavTitles', 'serializeSource', 'mergeBlocks',
]
const INPUTS_EXPORTS = ['readRenderInputs', 'planBuild', 'planExtract', 'diffPlan', 'writePlan']
/** 依赖内核（别人交付、本卡只消费）：9 份计算内核 —— 各有自己的主人卡（§6 解析） */
const DEP_KERNEL_NAMES = Object.freeze(['render', 'text', 'plan', 'errors', 'ledger-read', 'identity', 'pack', 'content', 'glossary'])
/** 探针版本（PROBE_VERSION）字面量的载体：U04 的 fingerprint.cjs（授权 scope.P1 认的就是它） */
const PROBE_CARRIER = 'lib/unify/fingerprint.cjs'
/** 依赖内核全集 = 上面 9 份 + **探针版本字面量的载体** */
const DEP_KERNELS = Object.freeze([...DEP_KERNEL_NAMES.map((n) => `lib/unify/${n}.cjs`), PROBE_CARRIER])
/** 本卡自己的四份生产文件（⑤-4 内容锁的对象；字节以 tracked 回执登记为准） */
const DELIVERABLES = Object.freeze([
  'lib/unify/render.cjs',
  'lib/render.js',
  'lib/render-inputs.js',
  'lib/pack-template/tools/build-lessons.js',
])
/** 探针版本字面量的**形状**（P1 授权面认的就是"这一个常量"；取值不在本文件写死） */
const PROBE_LITERAL_TEXT = /p:[0-9a-f]{16}/g
const PROBE_LITERAL_SHAPE = /^p:[0-9a-f]{16}$/
/** 授权文件里"路径"的长相（运行时从文本里抽，不手抄 P1/P2 的清单） */
const PATH_SHAPE = /^(?:lib|test|tools|docs|audit-evidence|packages)\/[A-Za-z0-9._/-]+$/
/** §5 复制清单不再手写：从包侧真实 require 图算传递闭包（见 audit-evidence/U07/mirror-copy.mjs） */

/** 本次运行的用例明细（落 detail.json；判词行仍是单行） */
const DETAIL = { card: CARD, cases: {}, comparisons: {}, temp: RUN_TEMP, writes: [], spawns: [] }

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const textSha = (text) => sha256(Buffer.from(String(text), 'utf8'))
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/')
const readText = (p) => fs.readFileSync(p, 'utf8')
const require_ = createRequire(import.meta.url)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（实得 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`)
}
function sameJson(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg}\n  实得 ${a.slice(0, 700)}\n  期望 ${b.slice(0, 700)}`)
}
/** 逐字节相等；不等就把首个差异的位置与前后的原文说出来（报告不许只说"不一致"） */
function sameBytes(actual, expected, msg) {
  if (actual === expected) return
  const a = String(actual)
  const b = String(expected)
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  throw new Error(`${msg}\n  首个差异在 ${i}（墙盘 ${a.length} 字符 / 期望 ${b.length} 字符）`
    + `\n  实得 …${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))}`
    + `\n  期望 …${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`)
}
const firstDiffAt = (a, b) => {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/* ── 读改前材料（缺料 = BLOCKED，不是 FAIL）──────────────────────────────── */

let _pre = null
function pre() {
  if (_pre) return _pre
  if (!fs.existsSync(PRE_FILE)) {
    throw new Blocked(`缺改前采集材料：${rel(PRE_FILE)} —— 先跑 node audit-evidence/U07/capture-baseline.mjs（在改动之前）`)
  }
  let doc = null
  try {
    doc = JSON.parse(readText(PRE_FILE))
  } catch (e) {
    throw new Blocked(`改前采集材料不是合法 JSON：${rel(PRE_FILE)} —— ${e.message}`)
  }
  if (doc?.schema !== 'whale-unify-u07-pre-change/1' || doc?.card !== CARD) {
    throw new Blocked(`改前采集材料形状不对（schema/card 不符）：${rel(PRE_FILE)}`)
  }
  _pre = doc
  return _pre
}

let _preSources = null
function preSources() {
  if (_preSources) return _preSources
  if (!fs.existsSync(PRE_SOURCES_FILE)) {
    throw new Blocked(`缺改前源码快照索引：${rel(PRE_SOURCES_FILE)} —— 先跑 git show 采集（见 pre-sources.json 的 schema）`)
  }
  _preSources = JSON.parse(readText(PRE_SOURCES_FILE))
  return _preSources
}

/** 当前基准（U09 身份收敛之后重采）—— 缺料同样是 BLOCKED，不是 FAIL */
let _canon = null
function canonicalBaseline() {
  if (_canon) return _canon
  if (!fs.existsSync(CANON_FILE)) {
    throw new Blocked(`缺当前基准：${rel(CANON_FILE)} —— 先跑 node audit-evidence/U07/capture-canonical.mjs`)
  }
  let doc = null
  try {
    doc = JSON.parse(readText(CANON_FILE))
  } catch (e) {
    throw new Blocked(`当前基准不是合法 JSON：${rel(CANON_FILE)} —— ${e.message}`)
  }
  if (doc?.schema !== 'whale-unify-u07-canonical-baseline/1' || doc?.card !== CARD) {
    throw new Blocked(`当前基准形状不对（schema/card 不符）：${rel(CANON_FILE)}`)
  }
  if (doc?.baselineEra !== ERA_CANONICAL) {
    throw new Blocked(`当前基准的 baselineEra 不是 ${ERA_CANONICAL}（实得 ${doc?.baselineEra}）`)
  }
  _canon = doc
  return _canon
}

/**
 * tracked 回执（⑤-4 内容锁的对象 + ⑨ 的五项齐）；**读一次**，两处共用同一份解析结果。
 * （回执是"我交付了什么字节"的唯一登记，内容锁拿它当尺子。）
 */
let _receipt = null
function receiptDoc() {
  if (_receipt) return _receipt
  const rcPath = path.join(REPO, 'docs', 'unify', 'receipts', `${CARD}.json`)
  assert(fs.existsSync(rcPath), 'A08：缺 tracked 回执 docs/unify/receipts/U07.json')
  try {
    _receipt = JSON.parse(readText(rcPath))
  } catch (e) {
    throw new Error(`A08：回执不是合法 JSON —— ${e.message}`)
  }
  return _receipt
}

/* ── 夹具（与改前采集共用同一份定义）──────────────────────────────────────── */

let _fx = null
async function fixtures() {
  if (_fx) return _fx
  if (!fs.existsSync(FIXTURES_FILE)) {
    throw new Blocked(`缺夹具定义：${rel(FIXTURES_FILE)} —— A01 必须与改前采集用同一份夹具，不能现场另造`)
  }
  _fx = await import(pathToFileURL(FIXTURES_FILE).href)
  return _fx
}

/** 判据修正材料：身份代迁移表 / helper 快照 / §5 复制清单（缺料 = BLOCKED） */
let _evidenceModules = null
async function evidenceModules() {
  if (_evidenceModules) return _evidenceModules
  for (const [file, what] of [
    [ERA_MODULE_FILE, '身份代迁移表'],
    [HELPER_MODULE_FILE, 'helper 快照'],
    [MIRROR_MODULE_FILE, '§5 复制清单'],
  ]) {
    if (!fs.existsSync(file)) throw new Blocked(`缺${what}：${rel(file)}（A01 的两代对拍要用它，不能现场另造）`)
  }
  _evidenceModules = {
    era: await import(pathToFileURL(ERA_MODULE_FILE).href),
    helpers: await import(pathToFileURL(HELPER_MODULE_FILE).href),
    mirror: await import(pathToFileURL(MIRROR_MODULE_FILE).href),
  }
  return _evidenceModules
}

/** 图型映射器 + h2/h3 类变换是包侧 CJS（仓根 package.json 是 type=module）：
 *  放进一个 CJS 作用域再 require —— 这样 A04 用的是**真实**注入能力，而不是替身。 */
function cjsScope() {
  const root = path.join(RUN_TEMP, 'cjs-scope')
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"u07-cjs-scope","private":true}\n', 'utf8')
  for (const name of ['shape-render.js', 'title-classes.js']) {
    fs.copyFileSync(path.join(TEMPLATE, 'tools', name), path.join(root, 'tools', name))
  }
  const req = createRequire(path.join(root, 'package.json'))
  return { SHAPE: req('./tools/shape-render.js'), TITLE: req('./tools/title-classes.js') }
}

function shapeMapper() {
  return cjsScope().SHAPE
}

function newRoot(tag) {
  const dir = path.join(RUN_TEMP, tag)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 目录全树（只收文件），文本件连内容一起记 */
function tree(root, { textRe = /\.(html|css|js|json|jsonl)$/ } = {}) {
  const out = []
  ;(function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      const relPath = prefix ? `${prefix}/${name}` : name
      if (fs.statSync(abs).isDirectory()) { walk(abs, relPath); continue }
      const buf = fs.readFileSync(abs)
      const row = { path: relPath, sha256: sha256(buf), bytes: buf.length }
      if (textRe.test(name)) row.text = buf.toString('utf8')
      out.push(row)
    }
  })(root, '')
  return out
}

/** 夹具"输入"清单：目录树 + 指定文件（与采集脚本同一份口径） */
const CONTENT_DIRS = ['lessons/src', 'notes', 'code']
const CONTENT_FILES = ['package.json', 'assets/glossary-data.js', 'assets/questions-data.js', 'assets/_frame.html', 'tools/shape-render.js']
function contentManifest(root) {
  const rows = []
  for (const dir of CONTENT_DIRS) {
    for (const r of tree(path.join(root, ...dir.split('/')))) rows.push({ path: `${dir}/${r.path}`, sha256: r.sha256, bytes: r.bytes })
  }
  for (const relPath of CONTENT_FILES) {
    const abs = path.join(root, ...relPath.split('/'))
    rows.push({ path: relPath, sha256: fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null, bytes: fs.existsSync(abs) ? fs.statSync(abs).size : null })
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

function normalizeOut(text, root) {
  let s = String(text ?? '')
  for (const v of [root, root.replace(/\\/g, '/')]) s = s.split(v).join('<ROOT>')
  return s
}

/** 跑包侧 CLI：cwd 一律在夹具包根（**绝不在仓内**），并把每次 spawn 记进证据 */
function runCli(packRoot, args = [], timeout = 300000) {
  assert(!path.resolve(packRoot).startsWith(REPO + path.sep), `A08: 包侧 CLI 的 cwd 不许落在仓内（${packRoot}）`)
  const r = spawnSync(process.execPath, [path.join(packRoot, 'tools', 'build-lessons.js'), ...args], {
    cwd: packRoot,
    encoding: 'utf8',
    timeout,
  })
  DETAIL.spawns.push({ script: '<pack>/tools/build-lessons.js', args, cwd: '<RUN_TEMP>/' + path.basename(packRoot), status: r.status })
  return {
    args,
    status: r.status,
    signal: r.signal ?? null,
    stdout: normalizeOut(r.stdout, packRoot),
    stderr: normalizeOut(r.stderr, packRoot),
    errorCode: r.error ? (r.error.code || r.error.message) : null,
  }
}

const tagLines = (stdout) => String(stdout ?? '').split(/\r?\n/).filter((l) => /^\[(build|check|extract)\]/.test(l)).join('\n')
const pageRows = (plan) => plan.files.map((f) => ({ path: f.path, sha256: textSha(f.content), bytes: Buffer.byteLength(f.content, 'utf8'), text: f.content }))

/**
 * 建一个"宿主夹具"（深布局、无产物页）。
 * @param {string} tag 本次运行里的子目录名
 * @param {{identity?: string}} [opts] `identity` 默认 `canonical-identity`：把承载身份的输入
 *   **按 identity.cjs 的真实函数**迁成规范形状（= 现在的真包该有的样子）。
 *   只有 A01 的"旧形状代"显式传 `pre-U09-identity`（原样，复现旧基准的输入）。
 */
async function hostFixture(tag, { identity = ERA_CANONICAL } = {}) {
  const fx = await fixtures()
  const root = newRoot(tag)
  fx.layDeep(root, { templateDir: TEMPLATE })
  if (identity === ERA_CANONICAL) (await evidenceModules()).era.migrateIdentityInputs(root)
  return root
}

/** 建一个"包侧夹具"（模板逐字节副本 + 内容 + §5 权威内核复制 + 身份代迁移） */
async function packFixture(tag, { renderSource = null, identity = ERA_CANONICAL } = {}) {
  const { era, mirror } = await evidenceModules()
  const fx = await fixtures()
  const root = newRoot(tag)
  fx.layPack(root, { templateDir: TEMPLATE })
  // §5：只在自己的 E:\Temp 包里逐字复制已交付权威模块（仓内不生成镜像；真包装归 U19）
  const copied = mirror.copyUnifyCore(REPO, root)
  if (renderSource) fs.copyFileSync(renderSource, path.join(root, 'tools', 'unify', 'render.cjs'))
  if (identity === ERA_CANONICAL) era.migrateIdentityInputs(root)
  DETAIL.comparisons[`fixture:${tag}`] = { unifyCore: copied.copied, identity }
  return root
}

/* ── A01：两代基准的**可归因**逐字节等价 ─────────────────────────────────── */

/** 宿主 planBuild 产物逐字节等于给定基准行 */
function assertPlanEqualsRows(plan, expectedRows, label) {
  sameJson(plan.files.map((f) => f.path), expectedRows.map((r) => r.path), `${label}：产出文件清单与基准一致`)
  for (const row of expectedRows) {
    const got = plan.files.find((f) => f.path === row.path)
    assert(got, `${label}：缺了基准里有的产物 ${row.path}`)
    sameBytes(got.content, row.text, `${label}：${row.path} 与基准字节不同`)
  }
}

/** 一份目录全树（tree() 的返回值）逐字节等于给定基准行 */
function assertTreeEqualsRows(treeRows, expectedRows, label) {
  const nowByPath = new Map(treeRows.map((r) => [r.path, r]))
  for (const row of expectedRows) {
    const got = nowByPath.get(row.path)
    assert(got, `${label}：包侧少了 ${row.path}`)
    eq(got.sha256, row.sha256, `${label}：${row.path} 的 sha256 与基准不同`)
    if (typeof row.text === 'string') sameBytes(got.text, row.text, `${label}：${row.path} 与基准字节不同`)
  }
  sameJson([...nowByPath.keys()].sort(), expectedRows.map((r) => r.path).slice().sort(), `${label}：包侧 lessons/** 文件集合与基准一致`)
}

/** 包侧 lessons/** 逐字节等于给定基准行（现读盘） */

/** 同一进程、同一盘上状态渲染两次：产物必须逐字节相同（不确定性 ⇒ 红） */
function assertTwiceStable(first, second, label) {
  sameJson(second.files.map((f) => f.path), first.files.map((f) => f.path), `${label}：两次渲染的产出清单不同`)
  for (const f of first.files) {
    const again = second.files.find((x) => x.path === f.path)
    assert(again, `${label}：第二次渲染缺了 ${f.path}`)
    sameBytes(again.content, f.content, `${label}：同一进程两次渲染 ${f.path} 字节不同（不确定性 ✗）`)
  }
}

/** 冷/热两轮各渲染两次（同进程）；返回四份 plan */
function renderHostTwice(root, planBuild) {
  const cold1 = planBuild(root, {})
  const cold2 = planBuild(root, {})            // 产物还没落盘：同输入第二次
  for (const f of cold1.files) {
    const abs = path.join(root, ...f.path.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.content, 'utf8')
  }
  const warm1 = planBuild(root, {})
  const warm2 = planBuild(root, {})
  return { cold: [cold1, cold2], warm: [warm1, warm2] }
}

/** 页面上的课次显示名（封面卡 `data-ask-lesson`）—— 算"这页该有几条笔记"要用它 */
function pageLessonLabel(text) {
  const m = /data-ask-lesson="([^"]*)"/.exec(String(text ?? ''))
  assert(m, 'A01：页面里找不到 data-ask-lesson —— 没法把笔记计数对到课次上')
  return m[1]
}

/**
 * 用**已交付的课程内核**（`lib/unify/pack.cjs` 的 `lessonIndex` + `labelOfAnchor`）算
 * "某课在笔记台账里有几条" —— 不另写一套匹配规则，跟构建期用的是同一个函数。
 */
function noteCountsByLabel(root) {
  const packCore = require_(path.join(REPO, 'lib', 'unify', 'pack.cjs'))
  const index = packCore.lessonIndex(root)
  const out = new Map()
  const file = path.join(root, 'notes', 'notes.jsonl')
  if (!fs.existsSync(file)) return out
  for (const line of readText(file).split(/\r?\n/)) {
    if (!line.trim()) continue
    let note = null
    try { note = JSON.parse(line) } catch { continue }
    if (!note || typeof note.anchor !== 'string') continue
    const label = packCore.labelOfAnchor(note.anchor, index)          // ← 真实解析函数
    if (!label) continue                                              // 解析不到 = 不算到任何课头上
    out.set(label, (out.get(label) || 0) + 1)
  }
  return out
}

/** 判据的**负对照**：喂一个必然坏的输入，判据必须红（否则它就是空转） */
function expectRed(what, fn, needleRe) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert(err, `${what}：喂给它一个必然坏的输入，它却通过了 —— 判据是空转`)
  const msg = String(err && err.message ? err.message : err)
  assert(needleRe.test(msg), `${what}：负对照红了，但不是因为该红的理由（实得「${msg.slice(0, 300)}」）`)
  return msg
}

/* ── A01 的三条判据（各自是纯函数：数据进、断言出；负对照直接复用）────────── */

/** ① 现状稳定：两代输入各自"两次同字节" + 与当前基准同字节 */
function checkStability({ era, render, expectedCold, expectedWarm, label }) {
  assertTwiceStable(render.cold[0], render.cold[1], `${label}·冷启动`)
  assertTwiceStable(render.warm[0], render.warm[1], `${label}·热启动`)
  assertPlanEqualsRows(render.cold[0], expectedCold, `${label}·冷启动 与当前基准`)
  assertPlanEqualsRows(render.warm[0], expectedWarm, `${label}·热启动 与当前基准`)
}

/**
 * ② 差异可归因。
 * @param {{migration: object, recorded: object, oldCold: Array, canonCold: Array, legacyCold: Array,
 *   canonCounts: Map, legacyCounts: Map, eraModule: object, identityCore: object}} opts
 */
function checkAttribution({ migration, recorded, oldCold, canonCold, legacyCold, canonCounts, legacyCounts, eraModule, identityCore }) {
  // (a) 表不是常量：recorded 必须等于**现在**用 identity.cjs 现算出来的那张
  sameJson({
    table: migration.table,
    unmappable: migration.unmappable,
    counts: migration.counts,
  }, {
    table: recorded.table,
    unmappable: recorded.unmappable,
    counts: recorded.counts,
  }, 'A01·差异可归因：现算的身份迁移表与采集材料里的那张不同（身份内核或夹具事实变了 —— 重采基准）')

  // (b) 表里的每一对都必须真是"身份内核算出来的"，不许出现解释不了的值
  for (const row of migration.table) {
    const parsedOld = identityCore.parseLessonKey(row.old)
    assert(!parsedOld.ok, `A01·差异可归因：${row.file}#${row.record} 的旧值 ${JSON.stringify(row.old)} 本来就是规范身份 —— 它不该出现在迁移表里`)
    const parsedNew = identityCore.parseLessonKey(row.canonical)
    assert(parsedNew.ok, `A01·差异可归因：迁移目标 ${JSON.stringify(row.canonical)} 不是规范课次键`)
    if (row.via === 'lessonKey') {
      const segs = row.old.split('/')
      eq(row.canonical, identityCore.lessonKey(parsedNew.value.circle, segs[0], Number(segs[1])),
        `A01·差异可归因：${row.file}#${row.record} 的迁移目标不是 lessonKey() 算出来的`)
    }
  }
  assert(migration.table.length > 0, 'A01·差异可归因：迁移表是空的 —— 它解释不了任何差异')

  // (c) 旧基准 → 当前基准的每一处差异：只许是账本身份迁移导致的笔记计数
  let explained = 0
  for (const oldRow of oldCold) {
    const canonRow = canonCold.find((r) => r.path === oldRow.path)
    const legacyRow = legacyCold.find((r) => r.path === oldRow.path)
    assert(canonRow && legacyRow, `A01·差异可归因：${oldRow.path} 在某一代里没有产物`)
    // 规范身份输入下，当前渲染必须与旧基准**逐字节相同**（= 按表迁移输入后 == 旧输出）
    sameBytes(canonRow.text, oldRow.text,
      `A01·差异可归因：把夹具里承载身份的输入按映射表迁移之后，${oldRow.path} 必须与旧基准逐字节相同（否则差异不只是身份）`)
    const label = pageLessonLabel(oldRow.text)
    const diffs = eraModule.diffTextLines(oldRow.text, legacyRow.text)
    for (const d of diffs) {
      const wasCount = /^(\s*)<span>笔记 ([0-9]+)<\/span>$/u.exec(String(d.old))
      const nowCount = /^(\s*)<span>笔记 ([0-9]+)<\/span>$/u.exec(String(d.now))
      assert(wasCount && nowCount,
        `A01·差异可归因：${oldRow.path} 第 ${d.line} 行的差异解释不了`
          + `\n  旧基准 ${JSON.stringify(d.old)}\n  旧形状账本 ${JSON.stringify(d.now)}`)
      eq(wasCount[1], nowCount[1], `A01·差异可归因：${oldRow.path} 第 ${d.line} 行连缩进都变了 —— 不是同一个槽位`)
      eq(Number(wasCount[2]), canonCounts.get(label) ?? 0,
        `A01·差异可归因：${oldRow.path} 旧基准的笔记数 ${wasCount[2]} 不等于"迁移后账本按 labelOfAnchor 算出的条数"`)
      eq(Number(nowCount[2]), legacyCounts.get(label) ?? 0,
        `A01·差异可归因：${oldRow.path} 旧形状账本上的笔记数 ${nowCount[2]} 不等于"原始账本按 labelOfAnchor 算出的条数"`)
      explained += 1
    }
  }
  assert(explained <= 8, `A01·差异可归因：差异行数 ${explained} 超出预期 —— 先把差异逐条看清楚`)

  // (d) 输出侧的身份串：两代**一次替换都不该发生**（形状没变；表只作用于输入账本）
  let outputIdentityHits = 0
  for (const oldRow of oldCold) {
    const canonRow = canonCold.find((r) => r.path === oldRow.path)
    const a = eraModule.maskIdentityStrings(oldRow.text)
    const b = eraModule.maskIdentityStrings(canonRow.text)
    sameJson(b.hits, a.hits,
      `A01·差异可归因：${oldRow.path} 输出里的身份串本身变了形状 —— 那不是"账本迁移"，是渲染改了`)
    outputIdentityHits += a.hits.length
  }
  return { explained, outputIdentityHits }
}

/** ③ 非身份零变化：抹掉身份串后，全页与非身份区块都逐字节相同 */
const NON_IDENTITY_REGIONS = Object.freeze([
  { name: '图型 DOM', start: '<div class="ds-tree">', end: '</div>' },
  { name: '导航', start: '<div class="nav-links">', end: '</div>' },
  { name: '笔记/答疑卡', start: '<aside class="notes-card"', end: '</aside>' },
  { name: '答疑入口按钮', start: '<button type="button" class="notes-card__ask"', end: '</button>' },
  { name: '样式槽位', start: '<style>', end: '</style>' },
  { name: '页脚', start: '<footer>', end: '</footer>' },
])

function checkNonIdentity({ oldCold, canonCold, eraModule }) {
  let hits = 0
  let regions = 0
  const perPage = {}
  for (const oldRow of oldCold) {
    const canonRow = canonCold.find((r) => r.path === oldRow.path)
    assert(canonRow, `A01·非身份零变化：${oldRow.path} 在当代渲染里没有产物`)
    const a = eraModule.maskIdentityStrings(oldRow.text)
    const b = eraModule.maskIdentityStrings(canonRow.text)
    sameBytes(b.text, a.text, `A01·非身份零变化：${oldRow.path} 抹掉身份串后与旧基准不同`)
    hits += a.hits.length
    perPage[oldRow.path] = { identityTokens: a.hits.length, regions: [] }
    for (const region of NON_IDENTITY_REGIONS) {
      if (!String(oldRow.text).includes(region.start)) continue
      const ra = eraModule.regionOf(a.text, region.start, region.end, `${oldRow.path}·${region.name}`)
      const rb = eraModule.regionOf(b.text, region.start, region.end, `${oldRow.path}·${region.name}`)
      sameBytes(rb, ra, `A01·非身份零变化：${oldRow.path} 的「${region.name}」区块与旧基准不同`)
      assert(ra.length > 20, `A01·非身份零变化：${oldRow.path} 的「${region.name}」区块只有 ${ra.length} 字符 —— 判据可能空转`)
      perPage[oldRow.path].regions.push(region.name)
      regions += 1
    }
  }
  assert(hits >= oldCold.length, `A01·非身份零变化：抹掉的"身份串"只有 ${hits} 处 —— 页面里本该有 #point/NNNN / data-lesson 这类串`)
  assert(regions >= 3, `A01·非身份零变化：真比对到的非身份区块只有 ${regions} 个 —— 判据可能空转`)
  return { identityTokens: hits, regions, perPage }
}

async function A01() {
  const p = pre()
  const cb = canonicalBaseline()
  const ps = preSources()
  const fx = await fixtures()
  const { era, helpers: helperSnap, mirror } = await evidenceModules()
  const identity = era.identityCore()
  const out = {}

  // ⓪ 两份基准与两代标记必须自洽（拿错尺子 ⇒ 后面全白算）
  eq(p.baselineEra, ERA_LEGACY, 'A01：旧基准必须标着 pre-U09-identity（否则"改前快照"这个名字不成立）')
  eq(cb.baselineEra, ERA_CANONICAL, 'A01：当前基准必须标着 canonical-identity')
  eq(cb.identityCore.sha256, sha256(fs.readFileSync(path.join(REPO, 'lib', 'unify', 'identity.cjs'))),
    'A01：当前基准不是这一版 lib/unify/identity.cjs 算出来的 —— 先重采基准再谈判据')
  // 改前采集确实采在基线提交的内容上
  for (const relPath of ['lib/render.js', 'lib/render-inputs.js', 'lib/pack-template/tools/build-lessons.js']) {
    assert(ps.files[relPath], `A01：改前源码快照缺 ${relPath}`)
    eq(p.sources[relPath].sha256, ps.files[relPath].sha256, `A01：${relPath} 的改前 sha256 与 git HEAD 快照不符 —— 采集与基线不是同一份内容`)
    const snap = path.join(BASELINE_ROOT, ps.files[relPath].snapshot)
    assert(fs.existsSync(snap), `A01：缺改前源码快照文件 ${ps.files[relPath].snapshot}`)
    eq(sha256(fs.readFileSync(snap)), ps.files[relPath].sha256, `A01：改前源码快照 ${ps.files[relPath].snapshot} 被改过`)
  }

  const { planBuild, planExtract } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const render = await import(pathToFileURL(path.join(REPO, 'lib', 'render.js')).href)
  const SHAPE = shapeMapper()

  // ① 两代输入：旧形状（原样，复现旧基准的输入）/ 规范身份（按 identity.cjs 迁移）
  const legacyRoot = await hostFixture('a01-host-legacy', { identity: ERA_LEGACY })
  sameJson(contentManifest(legacyRoot), p.fixtures.host, 'A01：旧形状夹具的输入字节与改前采集时不同（不是同一份输入）')
  const canonRoot = await hostFixture('a01-host-canon')
  sameJson(contentManifest(canonRoot), cb.fixtures.host, 'A01：规范身份夹具的输入字节与采集当前基准时不同')

  // ② 现算身份迁移表（全部经 identity.cjs 的真实函数；不是手写常量）
  const migration = (() => {
    const rows = era.readIdentityRecords(legacyRoot)
    const table = []
    const unmappable = []
    for (const row of rows) {
      const m = era.mapIdentity(legacyRoot, row.old)
      if (m.canonical) table.push({ file: row.file, record: row.record, old: row.old, canonical: m.canonical, via: m.via })
      else unmappable.push({ file: row.file, record: row.record, old: row.old, reason: m.unmappable })
    }
    const distinct = [...new Set(table.map((r) => `${r.old}\u0000${r.canonical}`))]
    return {
      table,
      unmappable,
      counts: { records: rows.length, mapped: table.length, unmappable: unmappable.length, distinctPairs: distinct.length },
    }
  })()

  // ③ 渲染：两代各冷/热两轮、每轮两次（同一进程）
  const legacyRender = renderHostTwice(legacyRoot, planBuild)
  const canonRender = renderHostTwice(canonRoot, planBuild)
  const canonRows = pageRows(canonRender.cold[0])
  const legacyRows = pageRows(legacyRender.cold[0])
  out.hostCold = canonRender.cold[0].files.length
  out.migration = migration.counts

  // ④ 反向抽取：旧平铺布局（两代输入各一次；抽取语义与身份代无关）
  const flatRoot = newRoot('a01-flat')
  fx.layFlat(flatRoot, { templateDir: TEMPLATE })
  sameJson(contentManifest(flatRoot), p.fixtures.flat, 'A01：旧平铺夹具（旧形状）的输入字节与改前不同')
  const canonFlat = newRoot('a01-flat-canon')
  fx.layFlat(canonFlat, { templateDir: TEMPLATE })
  era.migrateIdentityInputs(canonFlat)
  sameJson(contentManifest(canonFlat), cb.fixtures.flat, 'A01：旧平铺夹具（规范身份）的输入字节与基准不同')

  const hostExtract = planExtract(flatRoot, { lessons: [{ file: 'lessons/0001-legacy.html' }] })
  assert(hostExtract.files.length >= 1, `A01：宿主 planExtract 一个文件都没产出（${hostExtract.files.length}）`)
  const expectedExtract = p.expected.packExtract.src
  assert(typeof expectedExtract === 'string' && expectedExtract.length > 0, 'A01：改前快照里没有包侧抽取结果')
  // 改前两侧在旧平铺页上**本来就一致**（这条先立起来，"逐字节等价"才不是拿分歧掩护）
  sameBytes(p.expected.hostExtract[0].text, expectedExtract, 'A01：改前快照自相矛盾 —— 旧平铺页上宿主与包侧的抽取结果本应一致')
  sameBytes(hostExtract.files[0].content, expectedExtract, 'A01：宿主 planExtract 与改前（包侧语义）字节不同')
  const canonExtract = planExtract(canonFlat, { lessons: [{ file: 'lessons/0001-legacy.html' }] })
  sameBytes(canonExtract.files[0].content, expectedExtract, 'A01：规范身份夹具上的抽取结果与旧基准不同（身份代不该影响抽取语义）')
  out.extract = hostExtract.files[0].content.length

  // ⑤ 包侧 CLI（规范身份夹具）：build ×2 + --check —— 这里**只跑不判**：判词归 ①现状稳定，
  //    免得一条文案差异把 A01 挡在三条判据之前（那样就看不到 ②③ 的状态了）
  const packRoot = await packFixture('a01-pack')
  // §5 自证：临时包 tools/unify/ 里的清单必须**就是**从真实 require 图算出的闭包，且逐字等于仓内权威。
  //    ⚠️ 决-B2（决-9 连带）口径对齐：U19 收口之后 `writeScaffold` 铺包时会带上生成器产出的
  //    14 份运行内核副本（决-B3：生成与登记**同一动作**）。只比"require 图闭包"会把模板多带的
  //    **合法**件判成不一致。改法 = **现算并集**（不是放宽：仍是等式，且下面逐件字节对拍的面
  //    从"闭包成员"扩到"包里全部件"，比原来更强）。
  const packCoreFiles = fs.readdirSync(path.join(packRoot, 'tools', 'unify')).sort()
  const closureFiles = mirror.unifyCoreClosure(REPO)
  const templatedCore = fs.existsSync(path.join(TEMPLATE, 'tools', 'unify'))
    ? fs.readdirSync(path.join(TEMPLATE, 'tools', 'unify')).filter((n) => n.endsWith('.cjs')).sort()
    : []
  const expectedCore = [...new Set([...closureFiles, ...templatedCore])].sort()
  sameJson(packCoreFiles, expectedCore,
    'A01：临时包的 §5 复制清单必须 = require 图闭包 ∪ 模板随包生成副本（缺闭包成员或多出无名件都红）')
  sameJson(closureFiles.filter((n) => !packCoreFiles.includes(n)).join(','), '',
    'A01：临时包缺 require 图闭包成员（一件都不许缺）')
  for (const name of packCoreFiles) {
    eq(sha256(fs.readFileSync(path.join(packRoot, 'tools', 'unify', name))),
      sha256(fs.readFileSync(path.join(REPO, 'lib', 'unify', name))),
      `A01：临时包复制的 lib/unify/${name} 与权威字节不同（§5 要求逐字）`)
  }
  eq(sha256(fs.readFileSync(path.join(packRoot, 'tools', 'unify', 'render.cjs'))),
    sha256(fs.readFileSync(path.join(REPO, 'lib', 'unify', 'render.cjs'))),
    'A01：临时包里复制的 render.cjs 必须与权威字节相同（§5）')
  sameJson(contentManifest(packRoot), cb.fixtures.pack, 'A01：包侧夹具的输入字节与当前基准不同')
  out.packCore = packCoreFiles

  const run1 = runCli(packRoot, [])
  const treeAfterRun1 = tree(path.join(packRoot, 'lessons'))
  const run2 = runCli(packRoot, [])
  const treeAfterRun2 = tree(path.join(packRoot, 'lessons'))
  const check = runCli(packRoot, ['--check'])
  out.pack = [run1.status, run2.status, check.status]

  // ⑥ 包侧 --extract（同一个旧平铺页；产物字节必须与改前包装侧相同）
  const flatPack = newRoot('a01-flat-pack')
  fx.layPack(flatPack, { templateDir: TEMPLATE })
  mirror.copyUnifyCore(REPO, flatPack)
  fs.rmSync(path.join(flatPack, 'lessons'), { recursive: true, force: true })
  fx.layFlat(flatPack, { templateDir: TEMPLATE })
  era.migrateIdentityInputs(flatPack)
  sameJson(contentManifest(flatPack), cb.fixtures.flatPack, 'A01：包侧旧平铺夹具的输入字节与基准不同')
  const ex = runCli(flatPack, ['--extract', 'lessons/0001-legacy.html'])
  eq(ex.status, cb.expected.packExtract.cli.status, `A01：包侧 --extract 退出码与基准不同（stderr：${(ex.stderr || '').slice(0, 300)}）`)
  eq(tagLines(ex.stdout), cb.expected.packExtract.cli.tagLines, 'A01：包侧 --extract 的文案与基准不同')
  const exSrc = path.join(flatPack, 'lessons', 'src', '0001-legacy.html')
  assert(fs.existsSync(exSrc), 'A01：包侧 --extract 没有落下 lessons/src/0001-legacy.html')
  sameBytes(readText(exSrc), expectedExtract, 'A01：包侧 --extract 产物与改前字节不同')

  // ⑦ helper 级固定输入（13 组）：与身份代无关，必须同时等于旧基准与当前基准
  const gotHelpers = helperSnap.buildHelperSnapshot(render, SHAPE)
  sameJson(Object.keys(gotHelpers).sort(), Object.keys(cb.expected.helpers).sort(), 'A01：helper 对拍的输入组数与当前基准不一致')
  eq(helperSnap.stableJson(gotHelpers), helperSnap.stableJson(cb.expected.helpers), 'A01：helper 级输出与当前基准不同（与身份代无关的东西不该动）')
  eq(helperSnap.stableJson(p.expected.helpers), helperSnap.stableJson(cb.expected.helpers),
    'A01：helper 级快照在两代基准之间不同 —— 身份收敛不该碰到 helper')
  out.helpers = Object.keys(gotHelpers).length

  // ⑧ 三条判据（缺一不可）—— 每条各自跑，失败也要把三条的状态都说出来
  const canonCounts = noteCountsByLabel(canonRoot)
  const legacyCounts = noteCountsByLabel(legacyRoot)
  const verdicts = []
  const judge = (id, fn) => {
    try { verdicts.push({ id, ok: true, detail: fn() }) }
    catch (e) { verdicts.push({ id, ok: false, message: String(e && e.message ? e.message : e) }) }
  }

  judge('①现状稳定', () => {
    checkStability({
      era: ERA_CANONICAL, render: canonRender,
      expectedCold: cb.expected.hostCold, expectedWarm: cb.expected.hostWarm,
      label: 'A01·现状稳定·规范身份',
    })
    checkStability({
      era: ERA_LEGACY, render: legacyRender,
      expectedCold: cb.legacyEra.hostCold, expectedWarm: cb.legacyEra.hostWarm,
      label: 'A01·现状稳定·旧形状账本',
    })
    // 包侧：两轮 build + --check（同输入两次 + 与当前基准同字节）
    eq(run1.status, cb.expected.packRun1.cli.status, `A01·现状稳定：包侧第一轮 build 退出码与基准不同（stderr：${(run1.stderr || '').slice(0, 300)}）`)
    eq(tagLines(run1.stdout), cb.expected.packRun1.cli.tagLines, 'A01·现状稳定：包侧第一轮 build 的 `[build] …` 文案与基准不同')
    assertTreeEqualsRows(treeAfterRun1, cb.expected.packRun1.lessons, 'A01·现状稳定·包侧第一轮 build')
    eq(run2.status, cb.expected.packRun2.cli.status, 'A01·现状稳定：包侧第二轮 build 退出码与基准不同')
    eq(tagLines(run2.stdout), cb.expected.packRun2.cli.tagLines, 'A01·现状稳定：包侧第二轮 build 的文案与基准不同（幂等性也变了）')
    assertTreeEqualsRows(treeAfterRun2, cb.expected.packRun2.lessons, 'A01·现状稳定·包侧第二轮 build')
    sameJson(treeAfterRun2, treeAfterRun1,
      'A01·现状稳定：包侧第二轮 build 前后的 lessons/** 全树必须逐字节相同（幂等性 ✗）')
    eq(check.status, cb.expected.packCheck.status, `A01·现状稳定：包侧 --check 退出码与基准不同（stderr：${(check.stderr || '').slice(0, 300)}）`)
    eq(tagLines(check.stdout), cb.expected.packCheck.tagLines, 'A01·现状稳定：包侧 --check 的文案与基准不同')
    return {
      pagesCanonical: canonRender.cold[0].files.length,
      pagesLegacy: legacyRender.cold[0].files.length,
      packRuns: [run1.status, run2.status, check.status],
      packFiles: treeAfterRun2.length,
    }
  })

  judge('②差异可归因', () => {
    const r = checkAttribution({
      migration, recorded: cb.migration,
      oldCold: p.expected.hostCold, canonCold: canonRows, legacyCold: legacyRows,
      canonCounts, legacyCounts, eraModule: era, identityCore: identity,
    })
    // 包侧也走同一份账本：规范身份下包侧产物必须与旧基准的包侧产物逐字节相同
    assertTreeEqualsRows(treeAfterRun2, p.expected.packRun1.lessons, 'A01·差异可归因·包侧')
    return r
  })

  judge('③非身份零变化', () => checkNonIdentity({ oldCold: p.expected.hostCold, canonCold: canonRows, eraModule: era }))

  // 判据的进程内负对照：喂必然坏的输入，它必须红（否则判据是空转）
  const controls = []
  const control = (what, fn, needleRe) => {
    const msg = expectRed(what, fn, needleRe)
    controls.push({ what, red: true, first: msg.split('\n')[0].slice(0, 160) })
  }

  const failedVerdicts = verdicts.filter((v) => !v.ok)
  out.judged = verdicts.map((v) => ({ id: v.id, ok: v.ok, detail: v.detail ?? null, message: v.ok ? null : v.message.slice(0, 400) }))
  // 判据先说话：有红就直接把三条状态一起报出来（负对照这时不用跑，否则会盖住真正的红因）
  if (failedVerdicts.length) {
    throw new Error(`A01：三条判据没有同时成立\n${verdicts.map((v) => `  ${v.ok ? '✓' : '✗'} ${v.id}${v.ok ? '' : `：${v.message}`}`).join('\n')}`)
  }
  // 三条都绿了，再跑负对照：喂必然坏的输入，它们必须红 —— 这是"判据不是空转"的进程内自证
  control('①现状稳定·两次渲染不同字节', () => {
    const broken = {
      cold: [canonRender.cold[0], { files: canonRender.cold[1].files.map((f, i) => (i === 0 ? { ...f, content: `${f.content} ` } : f)) }],
      warm: canonRender.warm,
    }
    checkStability({
      era: ERA_CANONICAL, render: broken,
      expectedCold: cb.expected.hostCold, expectedWarm: cb.expected.hostWarm,
      label: 'A01·现状稳定·负对照',
    })
  }, /同一进程两次渲染|字节不同/)
  control('②差异可归因·迁移没把字节还原', () => checkAttribution({
    migration, recorded: cb.migration,
    oldCold: p.expected.hostCold, canonCold: legacyRows, legacyCold: legacyRows,
    canonCounts, legacyCounts, eraModule: era, identityCore: identity,
  }), /必须与旧基准逐字节相同/)
  control('②差异可归因·恒等映射表', () => checkAttribution({
    migration: (() => {
      const table = migration.table.map((r) => ({ ...r, canonical: r.old }))
      const distinct = [...new Set(table.map((r) => `${r.old}\u0000${r.canonical}`))]
      return { table, unmappable: migration.unmappable, counts: { ...migration.counts, distinctPairs: distinct.length } }
    })(),
    recorded: cb.migration,
    oldCold: p.expected.hostCold, canonCold: canonRows, legacyCold: legacyRows,
    canonCounts, legacyCounts, eraModule: era, identityCore: identity,
  }), /迁移表|规范课次键/)
  control('③非身份零变化·非身份字符少一个', () => {
    const rows = cb.expected.hostCold.map((r) => ({ ...r, text: r.text.replace('<h1 class="rainbow-title">', '<h1  class="rainbow-title">') }))
    assert(rows.every((r, i) => r.text !== cb.expected.hostCold[i].text), 'A01·负对照：变异没有真的落到任何一页上（控制组本身失效）')
    checkNonIdentity({ oldCold: p.expected.hostCold, canonCold: rows, eraModule: era })
  }, /抹掉身份串后|区块/)
  out.controls = controls

  // ⑨ `lib/render-inputs.js` 本次 0 字节改动（它本来就只是 IO 适配层）
  eq(sha256(fs.readFileSync(path.join(REPO, 'lib', 'render-inputs.js'))), p.sources['lib/render-inputs.js'].sha256,
    'A01：lib/render-inputs.js 被改动了 —— 本卡判定它零渲染计算，只做 IO，不该动（要动请先在回执里改口径）')
  // ⑩ 导出面逐字保留（改前快照 18 个 + render-inputs 5 个）
  sameJson(ps.files['lib/render.js'].exports.slice().sort(), HOST_EXPORTS_OLD.slice().sort(), 'A01：改前导出面快照与卡面核对表不符')
  sameJson(ps.files['lib/render-inputs.js'].exports.slice().sort(), INPUTS_EXPORTS.slice().sort(), 'A01：render-inputs 改前导出面与核对表不符')
  const nowExports = Object.keys(render).filter((k) => k !== 'default').sort()
  for (const name of HOST_EXPORTS_OLD) assert(nowExports.includes(name), `A01：lib/render.js 丢了导出 ${name}`)
  const inputs = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  for (const name of INPUTS_EXPORTS) assert(typeof inputs[name] === 'function', `A01：lib/render-inputs.js 丢了导出 ${name}`)
  out.exports = nowExports.length

  DETAIL.comparisons.A01 = out
}

/* ── A02：图型、导航、笔记和答疑注入保持 ─────────────────────────────────── */

async function A02() {
  const p = pre()
  const fx = await fixtures()
  const { planBuild, readRenderInputs } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const render = await import(pathToFileURL(path.join(REPO, 'lib', 'render.js')).href)

  const root = await hostFixture('a02-host')
  const plan = planBuild(root, {})
  const pages = Object.fromEntries(plan.files.map((f) => [f.path.split('/').pop(), f.content]))
  const prePages = Object.fromEntries(p.expected.hostCold.map((r) => [r.path.split('/').pop(), r.text]))
  const sees = (name, needle, why) => {
    assert(prePages[name].includes(needle), `A02 前提：改前字节里就有「${needle}」（${why}）`)
    assert(pages[name].includes(needle), `A02：${name} 里缺了「${needle}」（${why}）`)
  }
  const notSees = (name, needle, why) => {
    assert(!pages[name].includes(needle), `A02：${name} 里不该再出现「${needle}」（${why}）`)
  }

  // ① 图型：占位符被替换成映射器产出的 DOM，且占位符本身不留痕
  sees('0001-hello.html', '<div class="ds-tree">', '图型 hierarchy → ds-tree DOM')
  sees('0001-hello.html', 'Bean 甲', '图型节点文字进产物')
  sees('0001-hello.html', 'data-term="ioc"', 'hintTerm 的 data-term 槽位在')
  notSees('0001-hello.html', '<!--figure:f1-->', '占位符必须被替换掉（不是叠一层）')

  // ② 导航：上一课 / 下一课只在同一个知识点内连
  sees('0001-hello.html', '<a href="0002-config.html">Spring Boot 第2课：配置 →</a>', '第1课的下一课链接')
  sees('0001-hello.html', '<a href="../../../MISSION.md">← 课程目标</a>', '第一课的上一课退回课程目标')
  sees('0002-config.html', '<a href="0001-hello.html">← Spring Boot 第1课：你好世界</a>', '第2课的上一课链接')
  sees('0003-di.html', 'href="../../../starmap/#spring-boot/0003"', '{{PAGE_UP}} 二趟（分层深度 2 → ../../../）')
  sees('0001-hello.html', '速查表在 ../../../reference/NOTES.html', '{{PAGE_UP}} 二趟进作者态正文的相对链接')

  // ③ 地图前沿派生的"下一课"（末课）/ 手写占位回落（地图缺失的点）
  sees('0003-di.html', 'data-from-plan="1"', '地图有下一课 → span 带 data-from-plan')
  sees('0003-di.html', '下一课：数据访问（待开课）', '下一课课名逐字取地图原文')
  sees('1001-started.html', '下一课：待定（这条是手写的，地图缺失时必须原样保留）', '地图缺失 → 手写占位原样保留')
  notSees('1001-started.html', 'data-from-plan="1"', '地图缺失时不许假装派生出课名')

  // ④ 笔记 / 答疑计数（含：孤儿 anchor 不许错算到别人头上）
  sees('0001-hello.html', '<span>笔记 2</span>', '第1课 2 条笔记')
  sees('0002-config.html', '<span>笔记 1</span>', '第2课 1 条笔记')
  sees('0003-di.html', '<span>笔记 0</span>', '第3课 0 条笔记（孤儿 anchor nope/9999 不许算进来）')
  sees('0001-hello.html', 'data-qa-count="2"', '第1课 2 条已答答疑')
  sees('0002-config.html', 'data-qa-count="0"', '第2课 0 条已答答疑（pending 不算）')
  sees('0001-hello.html', '全部 3 个名词', 'TERM_COUNT = 名词台账条数（3）')
  sees('0001-hello.html', '<span>名词 1</span>', 'COVER_TERM_COUNT = 本课 meta.terms 的条数（1）')

  // ⑤ h2/h3 静态流彩类：没有 class 的补、已有 class 的不动
  sees('0001-hello.html', '<h2 class="rainbow-subtitle">核心概念</h2>', '裸 h2 补类')
  sees('0001-hello.html', '<h3 class="rainbow-subtitle">为什么叫容器</h3>', '裸 h3 补类')
  sees('0001-hello.html', '<h2 class="notes-card__title">已有类的小标题</h2>', '已有 class 的标题原样不动')
  sees('0001-hello.html', '<h1 class="rainbow-title">Spring Boot 第1课：你好世界</h1>', 'h1 的类来自外壳，不被二次改写')

  // ⑥ PAGE_STYLE（style 槽位）
  sees('0003-di.html', '<style>\n.u07-fixture-style { color: var(--dsw-alias-label-primary); }\n    </style>', 'style 槽位进 <style> 块')
  notSees('0001-hello.html', '{{PAGE_STYLE}}', '没有 style 段的页不许留下空槽位')

  // ⑦ coach 三槽位：空 coach 时占位符整行消失；有 coach 时在原位注入
  for (const name of Object.keys(pages)) {
    notSees(name, '<!-- @WHALE:', `coach 占位符必须被消费掉（${name}）`)
  }
  const ctx = readRenderInputs(root, {})
  const first = ctx.pages.find((pg) => pg.rel.endsWith('0001-hello.html'))
  const COACH = '<div class="coach-recap" data-fixture="1">定制层来了</div>'
  const injected = render.renderPage(first, ctx.pages, { ...ctx, coach: { RECAP: COACH } })
  const empty = render.renderPage(first, ctx.pages, ctx)
  sameBytes(empty, prePages['0001-hello.html'], 'A02：空 coach 的渲染结果必须与改前字节相同（整行消失，不是留一行空）')
  assert(injected.includes(COACH), 'A02：注入 coach 后那句必须出现在页面上')
  assert(injected !== empty, 'A02：注入了 coach 却不改产物 —— 注入是空转')
  assert(!injected.includes('@WHALE:RECAP'), 'A02：注入后占位符本身不许留痕')
  // 注入点 = 原占位符那一行：把注入内容摘掉，剩下的必须与"空 coach"逐字节相同
  sameBytes(injected.replace(COACH + '\n', ''), empty, 'A02：coach 必须**只在原占位符的整行位置**注入（不许挪位，也不许多留一行）')

  DETAIL.comparisons.A02 = { pages: Object.keys(pages).length, coachInjected: true }
}

/* ── A03：坏源和缺依赖如实失败 ───────────────────────────────────────────── */

async function A03() {
  const fx = await fixtures()
  const { planBuild } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const core = require_(path.join(REPO, 'lib', 'unify', 'render.cjs'))
  const SHAPE = shapeMapper()
  const out = {}

  /** 断言某段代码必须抛错，并把错误信息带回来（message 要能点名） */
  const mustThrow = (fn, needleRe, label) => {
    let err = null
    try { fn() } catch (e) { err = e }
    assert(err, `${label}：应当抛错，实际没有抛（静默降级 ✗）`)
    const msg = String(err && err.message ? err.message : err)
    assert(needleRe.test(msg), `${label}：错误信息没有点名问题（实得「${msg.slice(0, 300)}」）`)
    return msg
  }
  /** 失败之后不许有产物页（没有伪空页） */
  const assertNoPages = (root, label) => {
    const dir = path.join(root, 'lessons')
    const pages = fs.existsSync(dir)
      ? tree(dir).filter((r) => /\.html$/.test(r.path) && !r.path.startsWith('src/'))
      : []
    eq(pages.length, 0, `${label}：失败后不许落任何产物页（实得 ${pages.map((r) => r.path).join(', ')}）`)
  }

  // ① 坏模板：_frame.html 缺整行 coach 占位符
  {
    const root = await hostFixture('a03-bad-frame')
    const framePath = path.join(root, 'assets', '_frame.html')
    const frame = readText(framePath)
    assert(frame.includes('<!-- @WHALE:NEXT -->'), 'A03 前提：夹具外壳里本来有 <!-- @WHALE:NEXT -->')
    fs.writeFileSync(framePath, frame.replace(/^[ \t]*<!--\s*@WHALE:NEXT\s*-->\r?\n?/m, ''), 'utf8')
    out.badFrame = mustThrow(() => planBuild(root, {}), /缺整行占位符[\s\S]*@WHALE:NEXT/, 'A03·坏模板（缺 coach 占位符）')
    assertNoPages(root, 'A03·坏模板')
  }

  // ② 缺字段：meta 没有 source（槽位取值时如实炸）
  {
    const root = await hostFixture('a03-bad-meta')
    const srcPath = path.join(root, 'lessons', 'src', 'programming', 'spring-boot', '0002-config.html')
    fs.writeFileSync(srcPath, readText(srcPath).replace(/"source": \{[^}]*\},?/, ''), 'utf8')
    out.badMeta = mustThrow(() => planBuild(root, {}), /source|undefined|Cannot read/i, 'A03·缺字段（meta.source）')
    assertNoPages(root, 'A03·缺字段')
  }

  // ③ 未登记的名词（hintTerm 查不到 → 拒绝渲染）
  {
    const root = await hostFixture('a03-bad-hint')
    const srcPath = path.join(root, 'lessons', 'src', 'programming', 'spring-boot', '0002-config.html')
    fs.writeFileSync(srcPath, readText(srcPath).replace(/"hintTerm": "bean"/, '"hintTerm": "not-registered"'), 'utf8')
    out.badHint = mustThrow(() => planBuild(root, {}), /未在 glossary-data\.js 登记/, 'A03·hintTerm 未登记')
    assertNoPages(root, 'A03·hintTerm 未登记')
  }

  // ④ 坏 JSON：data-lesson-meta 不是合法 JSON
  {
    const root = await hostFixture('a03-bad-json')
    const srcPath = path.join(root, 'lessons', 'src', 'programming', 'spring-boot', '0002-config.html')
    fs.writeFileSync(srcPath, readText(srcPath).replace('data-lesson-meta>', 'data-lesson-meta>{oops'), 'utf8')
    out.badJson = mustThrow(() => planBuild(root, {}), /不是合法 JSON/, 'A03·坏 data-lesson-meta')
  }

  // ⑤ 坏图型：占位符引用了未声明的图型
  {
    const root = await hostFixture('a03-bad-figure')
    const srcPath = path.join(root, 'lessons', 'src', 'programming', 'spring-boot', '0001-hello.html')
    fs.writeFileSync(srcPath, readText(srcPath).replace('<!--figure:f1-->', '<!--figure:nope-->'), 'utf8')
    out.badFigure = mustThrow(() => planBuild(root, {}), /未声明的图型/, 'A03·未声明的图型引用')
  }

  // ⑥ 缺文件：外壳没了 → 如实失败（不是产出一张空页）
  {
    const root = await hostFixture('a03-missing-frame')
    fs.rmSync(path.join(root, 'assets', '_frame.html'), { force: true })
    out.missingFrame = mustThrow(() => planBuild(root, {}), /缺整行占位符|读不到/, 'A03·缺外壳文件')
    assertNoPages(root, 'A03·缺外壳文件')
  }

  // ⑦ 缺依赖（注入的能力没给 → 点名的失败，不是静默降级）
  {
    const root = await hostFixture('a03-missing-deps')
    const { readRenderInputs } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
    const { labelAnchorId } = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-model.js')).href)
    const { TITLE } = cjsScope()
    const DEPS = { labelAnchorId, withStaticTitles: TITLE.withStaticTitles, stripStaticTitles: TITLE.stripStaticTitles }
    const ctx = readRenderInputs(root, {})
    const page = ctx.pages[0]
    out.missingDeps = mustThrow(() => core.renderPage(page, ctx.pages, ctx), /缺渲染依赖 deps\.labelAnchorId/, 'A03·缺 deps（labelAnchorId）')
    out.missingShape = mustThrow(() => core.renderPage(page, ctx.pages, { ...ctx, shape: undefined, deps: DEPS }), /缺图型映射器 ctx\.shape/, 'A03·缺图型映射器')
    out.missingGlossary = mustThrow(() => core.renderPage(page, ctx.pages, { ...ctx, glossaryIndex: undefined, deps: DEPS }), /缺 ctx\.glossaryIndex/, 'A03·缺名词索引')
    out.missingNoteCounts = mustThrow(() => core.renderPage(page, ctx.pages, { ...ctx, noteCounts: undefined, deps: DEPS }), /缺 ctx\.noteCounts/, 'A03·缺笔记计数')
    out.missingStrip = mustThrow(() => core.extractPage(fx.LEGACY_PAGE, 'lessons/0001-legacy.html', {}, core.buildGlossaryIndex(fx.GLOSSARY), {}), /缺渲染依赖 deps\.stripStaticTitles/, 'A03·抽取缺 stripStaticTitles')
  }

  // ⑧ 缺件（**本卡登记的中间态**）：模板铺出来的包缺 `tools/unify/render.cjs`
  //    要求：明确失败 + 一个产物页都不落（不是静默跳过、不是半页）。
  {
    const root = await hostFixture('a03-missing-unify')
    fx.layPack(root, { templateDir: TEMPLATE })
    fs.mkdirSync(path.join(root, 'tools', 'unify'), { recursive: true })
    for (const name of ['text.cjs', 'plan.cjs', 'fingerprint.cjs']) {
      fs.copyFileSync(path.join(REPO, 'lib', 'unify', name), path.join(root, 'tools', 'unify', name))
    }
    // 故意让包缺 render.cjs（= U19 生成之前的真实状态）。
    // ⚠️ 决-B2（决-9 连带）口径对齐：U19 之后模板会把 14 份副本铺进夹具，
    //    "少复制一份"已经**制造不出**缺件态（模板那份还在），必须**显式 rm**。
    //    删完再断言真的没了 —— 否则这条判据是空转。
    fs.rmSync(path.join(root, 'tools', 'unify', 'render.cjs'), { force: true })
    assert(!fs.existsSync(path.join(root, 'tools', 'unify', 'render.cjs')),
      'A03·夹具里仍有 tools/unify/render.cjs —— 缺件态没造出来（判据空转）')
    const r = runCli(root, [])
    assert(r.status !== 0, 'A03·缺 tools/unify/render.cjs：包侧 CLI 必须非零退出（静默跳过 = 假通过 ✗）')
    assert(/Cannot find module '\.\/unify\/render\.cjs'/.test(r.stderr), `A03·缺件时错误信息必须点名缺的是 ./unify/render.cjs（实得 ${(r.stderr || '').slice(0, 300)}）`)
    const pages = tree(path.join(root, 'lessons')).filter((x) => /\.html$/.test(x.path) && !x.path.startsWith('src/'))
    eq(pages.length, 0, `A03·缺件时不许落产物页（实得 ${pages.map((x) => x.path).join(', ')}）`)
    out.missingUnifyCore = { status: r.status, namedInStderr: true }
  }

  // ⑨ 包侧缺外壳：同样如实失败（不是产出一张空页）
  {
    const root = await packFixture('a03-pack-frame')
    fs.rmSync(path.join(root, 'assets', '_frame.html'), { force: true })
    const r = runCli(root, [])
    assert(r.status !== 0, 'A03·包侧缺外壳必须非零退出')
    assert(/缺整行占位符|ENOENT/.test(r.stderr + r.stdout), `A03·包侧缺外壳的错误信息要点名（实得 ${(r.stderr || r.stdout || '').slice(0, 300)}）`)
  }

  DETAIL.comparisons.A03 = out
}

/* ── A04：纯内核不读取环境、时钟或磁盘 ───────────────────────────────────── */

async function A04() {
  const p = pre()
  const fx = await fixtures()
  const corePath = path.join(REPO, 'lib', 'unify', 'render.cjs')
  const core = require_(corePath)
  const src = readText(corePath)
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')   // 只判代码，不判注释

  // ① 源码静态扫描（剥注释之后）
  const banned = [
    [/require\(\s*['"]node:fs['"]\s*\)/, 'require("node:fs")'],
    [/\bfrom\s+['"](node:)?fs['"]/, 'ESM fs import'],
    [/\bprocess\s*\./, 'process.*（环境/进程）'],
    [/\b__dirname\b/, '__dirname（路径/磁盘）'],
    [/\bDate\b/, 'Date（时钟）'],
    [/\bMath\s*\.\s*random\b/, 'Math.random（随机）'],
    [/\bMath\s*\.\s*random\b|hrtime\b/, 'hrtime'],
    [/^\s*import\s+/m, 'ESM import（内核必须是 CJS）'],
    [/\brequire\.cache\b|module\.cache/, 'require.cache（模块级缓存痕迹）'],
    [/\beval\s*\(|new\s+Function\s*\(/, 'eval / new Function'],
    [/\bglobalThis\s*\.|\bglobal\s*\./, 'global/globalThis（全局状态）'],
  ]
  for (const [re, why] of banned) assert(!re.test(bare), `A04：render.cjs 里不许出现 ${why}`)
  // 只许要求同目录的纯模块（内置能力/同目录显式依赖，U-SPEC §5）
  const requires = [...bare.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  assert(requires.length >= 1, 'A04：内核至少 require 一份同目录地图判据（plan.cjs）')
  for (const r of requires) assert(/^\.\/[a-z-]+\.cjs$/.test(r), `A04：内核只许 require 同目录 .cjs（实得 ${r}）`)
  assert(!/^(let|var)\s/m.test(bare), 'A04：内核不许有模块级可变状态（顶层 let/var）')
  assert(!/^const\s+\w+\s*=\s*(new\s+Map|new\s+Set)\s*\(/m.test(bare), 'A04：内核不许有模块级 Map/Set 缓存')
  DETAIL.comparisons.A04 = { requires, bannedChecks: banned.length }

  // ② 行为：篡改环境 / 时钟 / 随机源 / 磁盘读之后，同输入逐字节同输出
  const root = await hostFixture('a04-host')
  const { readRenderInputs } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const { labelAnchorId } = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-model.js')).href)
  const { SHAPE, TITLE } = cjsScope()
  const DEPS = Object.freeze({ labelAnchorId, withStaticTitles: TITLE.withStaticTitles, stripStaticTitles: TITLE.stripStaticTitles })
  const ctx = readRenderInputs(root, {})
  const page = ctx.pages.find((pg) => pg.rel.endsWith('0001-hello.html'))
  const renderIt = (ctxIn) => core.renderPage(page, ctxIn.pages, { ...ctxIn, shape: SHAPE, deps: DEPS })
  const before = renderIt(ctx)
  // 用真实注入能力渲染出来的那张页，必须就是改前快照里那张（A04 与 A01 对同一把尺子）
  const prePage = p.expected.hostCold.find((r) => r.path.endsWith('0001-hello.html')).text
  sameBytes(before, prePage, 'A04：内核（真实注入能力）渲染出来的页与改前字节不同')

  const saves = {
    readFileSync: fs.readFileSync, readFile: fs.readFile,
    writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync,
    existsSync: fs.existsSync, statSync: fs.statSync, readdirSync: fs.readdirSync,
    openSync: fs.openSync, mkdirSync: fs.mkdirSync, rmSync: fs.rmSync,
    dateNow: Date.now, MathRandom: Math.random, Date: globalThis.Date,
  }
  let after = null
  const envBefore = process.env.U07_A04_PROBE
  try {
    const boom = (what) => () => { throw new Error(`A04: 纯内核调了 ${what}`) }
    fs.readFileSync = boom('fs.readFileSync')
    fs.readFile = boom('fs.readFile')
    fs.writeFileSync = boom('fs.writeFileSync')
    fs.appendFileSync = boom('fs.appendFileSync')
    fs.existsSync = boom('fs.existsSync')
    fs.statSync = boom('fs.statSync')
    fs.readdirSync = boom('fs.readdirSync')
    fs.openSync = boom('fs.openSync')
    fs.mkdirSync = boom('fs.mkdirSync')
    fs.rmSync = boom('fs.rmSync')
    Date.now = boom('Date.now')
    Math.random = boom('Math.random')
    globalThis.Date = function PoisonedDate() { throw new Error('A04: 纯内核调了 Date') }
    globalThis.Date.now = boom('Date.now')
    process.env.U07_A04_PROBE = 'tampered'
    after = renderIt(ctx)
  } finally {
    fs.readFileSync = saves.readFileSync
    fs.readFile = saves.readFile
    fs.writeFileSync = saves.writeFileSync
    fs.appendFileSync = saves.appendFileSync
    fs.existsSync = saves.existsSync
    fs.statSync = saves.statSync
    fs.readdirSync = saves.readdirSync
    fs.openSync = saves.openSync
    fs.mkdirSync = saves.mkdirSync
    fs.rmSync = saves.rmSync
    // ⚠️ 先还原**原 Date 对象自己的** now，再把全局 Date 换回来 —— 顺序反了会留下一个投毒的 now
    saves.Date.now = saves.dateNow
    Math.random = saves.MathRandom
    globalThis.Date = saves.Date
    if (envBefore === undefined) delete process.env.U07_A04_PROBE
    else process.env.U07_A04_PROBE = envBefore
  }
  sameBytes(after, before, 'A04：投毒 fs / 时钟 / 随机 / 环境之后输出变了 —— 内核在读盘或用时钟')

  // ③ 恢复之后重算：仍然逐字节相同（两次独立调用，不是把同一个字符串跟它自己比）
  const again = renderIt(ctx)
  sameBytes(again, before, 'A04：同输入两次独立调用必须逐字节相同（确定性）')
  assert(again.length > 1000, `A04：渲染结果短得可疑（${again.length} 字符）—— 纯内核可能是空转`)
  assert(again.includes('Spring Boot 第1课'), 'A04：渲染结果里连课次显示名都没有 —— 不是真页面')
  DETAIL.comparisons.A04.poisoned = true
  DETAIL.comparisons.A04.bytes = before.length
}

/* ── A05：宿主与独立临时包使用同一计算实现 ───────────────────────────────── */

async function A05() {
  const fx = await fixtures()
  const corePath = path.join(REPO, 'lib', 'unify', 'render.cjs')
  const coreSrc = readText(corePath)
  const comments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
  const packSrc = comments(readText(path.join(TEMPLATE, 'tools', 'build-lessons.js')))
  const hostSrc = comments(readText(path.join(REPO, 'lib', 'render.js')))
  /** 帧槽位表在源码里的字样（`/\{\{([A-Z_]+)\}\}/` 那段正则的签名）—— 用来判"全仓只有一处" */
  const SLOT_TABLE_TEXT = '([A-Z_]+)\\}\\}'
  const out = {}

  // ① 包侧只剩 CLI / IO：渲染管道的每一段都不许在本文件里再写一遍
  const packMustNot = [
    [/function\s+render\s*\(/, '包侧还留着自己的 render()'],
    [/function\s+renderPage\s*\(/, '包侧还留着自己的 renderPage()'],
    [/function\s+extractPage\s*\(/, '包侧还留着自己的 extractPage()'],
    [/function\s+parseSource\s*\(/, '包侧还留着自己的 parseSource()'],
    [/function\s+nextPlaceholderSpan\s*\(/, '包侧还留着自己的 nextPlaceholderSpan()'],
    [/function\s+collectNavTitles\s*\(/, '包侧还留着自己的 collectNavTitles()'],
    [/function\s+serializeSource\s*\(/, '包侧还留着自己的 serializeSource()'],
    [/function\s+trimBlankLines\s*\(/, '包侧还留着自己的 trimBlankLines()'],
    [/function\s+balancedEl\s*\(/, '包侧还留着自己的 balancedEl()'],
    [/function\s+indexOfMarkup\s*\(/, '包侧还留着自己的 indexOfMarkup()'],
    [/function\s+figureMap\s*\(/, '包侧还留着自己的 figureMap()'],
    [/function\s+substituteFigures\s*\(/, '包侧还留着自己的 substituteFigures()'],
    [/function\s+pageSequence\s*\(/, '包侧还留着自己的 pageSequence()'],
    [/seen\.set\(/, '包侧还留着自己的样式合并（seen 表）'],
    [/@WHALE:\(RECAP\|NEXT\|ASK\)/, '包侧还留着 coach 正则'],
  ]
  for (const [re, why] of packMustNot) assert(!re.test(packSrc), `A05：${why} —— 渲染计算只许在新核心里`)
  assert(!packSrc.includes(SLOT_TABLE_TEXT), 'A05：包侧还留着帧槽位表 —— 渲染计算只许在新核心里')
  // 而且必须真的委托过去（不是"删了就算"）
  assert(/require\(['"]\.\/unify\/render\.cjs['"]\)/.test(packSrc), 'A05：包侧必须 require("./unify/render.cjs")')
  for (const use of ['renderCore.renderPage', 'renderCore.extractPage', 'renderCore.collectNavTitles',
    'renderCore.serializeSource', 'renderCore.mergeBlockRules', 'renderCore.formatBlocks', 'renderCore.parseSource']) {
    assert(packSrc.includes(use), `A05：包侧没有真的用核心的 ${use}`)
  }
  // 包侧仍保留 CLI / IO 契约（不是"一行委托"）
  for (const keep of ['--check', '--extract', '--no-blocks', '--force-blocks', 'delete require.cache[',
    'writeAtomic', 'styleAdapter.sync', 'build-starmap.js', '跳过：本目录没有 assets/questions-data.js']) {
    assert(packSrc.includes(keep), `A05：包侧 CLI 契约「${keep}」不见了`)
  }
  out.packCliKept = true

  // ② ESM 适配层不许藏第二份渲染计算
  assert(/unify\/render\.cjs/.test(hostSrc), 'A05：lib/render.js 必须 require ./unify/render.cjs')
  for (const [re, why] of [
    [/@WHALE:\(RECAP\|NEXT\|ASK\)/, 'ESM 层还留着 coach 正则'],
    [/function\s+collectNavTitles\s*\(/, 'ESM 层还留着自己的 collectNavTitles()'],
    [/function\s+mergeBlocks\s*\(/, 'ESM 层还留着自己的 mergeBlocks()'],
    [/function\s+parseSource\s*\(/, 'ESM 层还留着自己的 parseSource()'],
    [/function\s+extractPage[\s\S]{0,80}?<\/h1>/, 'ESM 层还留着抽取实现'],
  ]) assert(!re.test(hostSrc), `A05：${why} —— 该段必须在 lib/unify/render.cjs`)
  assert(!hostSrc.includes(SLOT_TABLE_TEXT), 'A05：ESM 层还留着帧槽位表 —— 该段必须在 lib/unify/render.cjs')

  // ③ 全仓唯一性：帧槽位表 / coach 正则各只有一处**活**实现
  //    ⚠️ 决-B2（决-9 连带）口径对齐：`lib/pack-template/tools/unify/*.cjs` 是 U19 的
  //    **逐字节生成副本**（不是第二份实现），扫"唯一性"时必须现算排除 —— 否则副本一出现
  //    这条就假红。排除**不是放行**：下面顺手对拍被排除的副本与权威**逐字节相同**，
  //    把"拿生成目录藏一份真实现"这条路堵死。
  const MIRROR_OWN = 'lib/pack-template/tools/unify/'
  const scanRoots = ['lib', 'lib/pack-template/tools']
  const impls = { slot: [], coach: [] }
  const skippedCopies = { slot: [], coach: [] }
  for (const rootRel of scanRoots) {
    const dir = path.join(REPO, ...rootRel.split('/'))
    for (const r of tree(dir, { textRe: /\.(js|cjs|mjs)$/ })) {
      if (!r.text) continue
      const code = comments(r.text)
      const rel = `${rootRel}/${r.path}`.split(path.sep).join('/')
      const generated = rel.includes(MIRROR_OWN)
      if (code.includes(SLOT_TABLE_TEXT)) (generated ? skippedCopies.slot : impls.slot).push(rel)
      if (/@WHALE:\(RECAP\|NEXT\|ASK\)/.test(code)) (generated ? skippedCopies.coach : impls.coach).push(rel)
    }
  }
  sameJson(impls.slot, ['lib/unify/render.cjs'], 'A05：帧槽位表在全仓必须只有一处（lib/unify/render.cjs）')
  sameJson(impls.coach, ['lib/unify/render.cjs'], 'A05：coach 正则在全仓必须只有一处（lib/unify/render.cjs）')
  // 被排除的只能是"生成副本"这一处，且必须与权威逐字节相同
  for (const rel of [...skippedCopies.slot, ...skippedCopies.coach]) {
    const abs = path.join(REPO, ...rel.split('/'))
    assert(rel === `${MIRROR_OWN}render.cjs`, `A05：唯一性扫描排除了一个非生成副本的件（${rel}）—— 排除面不许扩大`)
    eq(sha256(fs.readFileSync(abs)), sha256(fs.readFileSync(path.join(REPO, 'lib', 'unify', 'render.cjs'))),
      `A05：被排除的生成副本 ${rel} 必须与权威 lib/unify/render.cjs 逐字节相同（否则它就是第二份实现）`)
  }
  out.unique = { slot: impls.slot, coach: impls.coach, generatedCopies: skippedCopies }

  // ④ 运行时：同一个夹具根，包侧 CLI 与宿主 planBuild 逐字节相同
  const packRoot = await packFixture('a05-pack')
  const { planBuild } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const cli = runCli(packRoot, [])
  eq(cli.status, 0, `A05：包侧 CLI 必须成功（stderr：${(cli.stderr || '').slice(0, 400)}）`)
  assert(!path.resolve(packRoot).startsWith(REPO + path.sep), 'A05：临时包必须在仓外（E:\\Temp）')
  // 临时包里只有一份渲染实现
  const packToolFiles = tree(path.join(packRoot, 'tools'), { textRe: /\.(js|cjs)$/ })
  const renderPages = packToolFiles.filter((r) => /function\s+renderPage\s*\(/.test(comments(r.text || '')))
  sameJson(renderPages.map((r) => r.path), ['unify/render.cjs'], 'A05：临时包的工具目录里必须只有一份 renderPage 实现')
  eq(sha256(fs.readFileSync(path.join(packRoot, 'tools', 'unify', 'render.cjs'))), sha256(fs.readFileSync(corePath)),
    'A05：临时包里的 render.cjs 必须与仓内权威字节逐字相同（§5 的复制清单）')

  const hostPlan = planBuild(packRoot, {})
  const cliPages = tree(path.join(packRoot, 'lessons')).filter((r) => /\.html$/.test(r.path) && !r.path.startsWith('src/'))
  eq(hostPlan.files.length, cliPages.length, `A05：两侧产出的页面数不同（宿主 ${hostPlan.files.length} / 包侧 ${cliPages.length}）`)
  for (const f of hostPlan.files) {
    const row = cliPages.find((r) => `lessons/${r.path}` === f.path)
    assert(row, `A05：包侧没有产出 ${f.path}`)
    sameBytes(row.text, f.content, `A05：${f.path} 上宿主与包侧不是同一份计算（字节不同）`)
  }
  out.runtime = { pages: hostPlan.files.length, cwdOutsideRepo: true }

  DETAIL.comparisons.A05 = out
}

/* ── A06：同进程输入变化可见 ─────────────────────────────────────────────── */

async function A06() {
  const p = pre()
  const fx = await fixtures()
  const { planBuild, readRenderInputs } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const core = require_(path.join(REPO, 'lib', 'unify', 'render.cjs'))
  const SHAPE = shapeMapper()
  const root = await hostFixture('a06-host')
  const base = planBuild(root, {})
  const baseByPath = Object.fromEntries(base.files.map((f) => [f.path, f.content]))
  sameJson(base.files.map((f) => [f.path, textSha(f.content)]), p.expected.hostCold.map((r) => [r.path, r.sha256]),
    'A06 前提：起点就是改前字节')
  const out = {}

  // ① 改源文件 → 输出跟着变；改回去 → 逐字节回到改前
  const srcPath = path.join(root, 'lessons', 'src', 'programming', 'spring-boot', '0001-hello.html')
  const srcOrig = readText(srcPath)
  const MARK = '<!--A06-MARK-->'
  fs.writeFileSync(srcPath, srcOrig.replace('<!--@body-->', `<!--@body-->\n${MARK}`), 'utf8')
  const changed = planBuild(root, {})
  const page1 = changed.files.find((f) => f.path.endsWith('0001-hello.html')).content
  assert(page1.includes(MARK), 'A06：同一进程里改了源文件，产物必须跟着变（模块级缓存把它吃掉了）')
  assert(page1 !== baseByPath['lessons/programming/spring-boot/0001-hello.html'], 'A06：改了输入但输出没变')
  fs.writeFileSync(srcPath, srcOrig, 'utf8')
  const reverted = planBuild(root, {})
  for (const f of reverted.files) sameBytes(f.content, baseByPath[f.path], `A06：改回去后 ${f.path} 必须逐字节回到改前`)
  out.sourceVisible = true

  // ② 改地图 → 末课"下一课"占位跟着变
  const planPath = path.join(root, 'lessons', 'programming', 'spring-boot', 'point.json')
  const planOrig = readText(planPath)
  const planDoc = JSON.parse(planOrig)
  planDoc.plan.nodes.find((n) => n.no === 4).title = 'A06-数据访问改名'
  fs.writeFileSync(planPath, JSON.stringify(planDoc, null, 2) + '\n', 'utf8')
  const page3 = planBuild(root, {}).files.find((f) => f.path.endsWith('0003-di.html')).content
  assert(page3.includes('下一课：A06-数据访问改名（待开课）'), 'A06：改了地图，末课的"下一课"必须跟着变')
  fs.writeFileSync(planPath, planOrig, 'utf8')
  out.planVisible = true

  // ③ 改笔记台账 → 封面卡笔记数跟着变（锚点必须是**规范身份**：U09 之后运行态不认历史形状）
  const notesPath = path.join(root, 'notes', 'notes.jsonl')
  const notesOrig = readText(notesPath)
  const thirdLessonKey = (await evidenceModules()).era.identityCore().lessonKey(fx.HALO, fx.POINT, 3)
  fs.writeFileSync(notesPath, `${notesOrig}${JSON.stringify({ anchor: thirdLessonKey, text: 'A06 新笔记' })}\n`, 'utf8')
  const page3b = planBuild(root, {}).files.find((f) => f.path.endsWith('0003-di.html')).content
  assert(page3b.includes('笔记 1'), 'A06：加了第3课的一条笔记，封面卡必须从 0 变成 1')
  fs.writeFileSync(notesPath, notesOrig, 'utf8')
  out.notesVisible = true

  // ④ 改名词台账 → TERM_COUNT 跟着变（数据文件按 resolved 键失效，不是模块级缓存）
  const glPath = path.join(root, 'assets', 'glossary-data.js')
  const glOrig = readText(glPath)
  fs.writeFileSync(glPath, glOrig.replace('module.exports = {', 'module.exports = {\n  a06term: { label: "A06 术语" },'), 'utf8')
  const page1b = planBuild(root, {}).files.find((f) => f.path.endsWith('0001-hello.html')).content
  assert(page1b.includes('全部 4 个名词'), 'A06：加了名词条数，术语计数必须从 3 变成 4')
  fs.writeFileSync(glPath, glOrig, 'utf8')
  out.glossaryVisible = true

  // ⑤ 内核本身：两次调用喂不同 ctx.frame → 输出跟着变（没有模块级缓存）
  const ctx = readRenderInputs(root, {})
  const page = ctx.pages.find((pg) => pg.rel.endsWith('0001-hello.html'))
  const deps = {
    labelAnchorId: (l) => String(l).replace(/\s+/g, '-'),
    withStaticTitles: (h) => String(h),
    stripStaticTitles: (h) => String(h),
  }
  const a = core.renderPage(page, ctx.pages, { ...ctx, shape: SHAPE, deps })
  const b = core.renderPage(page, ctx.pages, { ...ctx, shape: SHAPE, frame: ctx.frame.replace('</body>', '<!--A06-FRAME--></body>'), deps })
  assert(a !== b && b.includes('<!--A06-FRAME-->'), 'A06：同一进程里换了外壳，内核输出必须跟着变')

  DETAIL.comparisons.A06 = out
}

/* ── A07：临时修改一种渲染输出后判据失败 ─────────────────────────────────── */

async function A07() {
  const cb = canonicalBaseline()
  const fx = await fixtures()
  const { planBuild, diffPlan } = await import(pathToFileURL(path.join(REPO, 'lib', 'render-inputs.js')).href)
  const coreSrc = readText(path.join(REPO, 'lib', 'unify', 'render.cjs'))

  /** A01 里那条"包侧产物 vs 当前基准"的判据（抽出来，A07 用同一把尺子量变异体） */
  const packMatchesPre = (root) => {
    const now = tree(path.join(root, 'lessons'))
    const byPath = new Map(now.map((r) => [r.path, r]))
    const problems = []
    for (const row of cb.expected.packRun1.lessons) {
      const got = byPath.get(row.path)
      if (!got) { problems.push(`缺 ${row.path}`); continue }
      if (typeof row.text === 'string' && got.text !== row.text) {
        problems.push(`${row.path} 与基准字节不同（首个差异 ${firstDiffAt(got.text, row.text)}）`)
      }
    }
    return problems
  }

  // ① 未变异对照：同一把尺子在干净副本上必须"没问题"
  const clean = await packFixture('a07-clean')
  const cleanRun = runCli(clean, [])
  eq(cleanRun.status, 0, 'A07 前提：干净副本必须跑成功')
  eq(packMatchesPre(clean).length, 0, 'A07 前提：干净副本上 A01 判据必须通过（否则变异测试是空转）')
  // 宿主侧同一把尺子
  const hostProblemsClean = (() => {
    const plan = planBuild(clean, {})
    const rows = cb.expected.packRun1.lessons.filter((r) => r.text && /\.html$/.test(r.path) && !r.path.startsWith('src/'))
    const problems = []
    for (const row of rows) {
      const got = plan.files.find((f) => f.path === `lessons/${row.path}`)
      if (!got) { problems.push(`缺 ${row.path}`); continue }
      if (got.content !== row.text) problems.push(`${row.path} 字节不同`)
    }
    return problems
  })()
  eq(hostProblemsClean.length, 0, 'A07 前提：宿主侧判据在干净副本上必须通过')

  // ② 变异体：在 E:\Temp 副本里给**渲染输出**多加一个字符
  const mutDir = newRoot('a07-mut')
  const mutCore = path.join(mutDir, 'render.cjs.mutated')
  const MUT_FROM = '<span${mark} style="color:var(--dsw-alias-label-secondary);font-weight:bold">'
  const MUT_TO = '<span${mark} style="color:var(--dsw-alias-label-secondary); font-weight:bold">'
  assert(coreSrc.includes(MUT_FROM), 'A07：变异点在新内核里找不到（判据会变成空转）')
  fs.writeFileSync(mutCore, coreSrc.replace(MUT_FROM, MUT_TO), 'utf8')
  assert(textSha(readText(mutCore)) !== textSha(coreSrc), 'A07：变异体必须与权威字节不同')

  const mutated = await packFixture('a07-mutated', { renderSource: mutCore })
  const mutRun = runCli(mutated, [])
  eq(mutRun.status, 0, `A07：变异体也要能跑（否则测的是语法错误而不是判据）（stderr：${(mutRun.stderr || '').slice(0, 300)}）`)
  const problems = packMatchesPre(mutated)
  assert(problems.length > 0, 'A07：给渲染输出加了一个字符，A01 的逐字节判据却没红 —— 判据是空转')
  // 变异点在"下一课"那行的 span 上：只有带这一个 span 的两页会变（0003 来自地图、1001 来自手写占位）
  const affected = problems.filter((x) => /0003-di\.html|1001-started\.html/.test(x))
  eq(affected.length, 2, `A07：受影响页必须恰好是带"下一课"span 的两页（实得 ${problems.join('; ') || '无'}）`)
  assert(!problems.some((x) => /0001-hello\.html|0002-config\.html/.test(x)),
    `A07：没有那个 span 的页不该被这个变异影响（实得 ${problems.join('; ')}）`)

  // ③ 宿主侧同一把尺子也要红：变异体写在盘上的页，宿主 planBuild 必须报成漂移
  const mutDiff = diffPlan(mutated, planBuild(mutated, {}))
  assert(mutDiff.different.some((d) => /0003-di\.html/.test(d.path)),
    `A07：变异体写在盘上的页，宿主侧漂移比对必须报出来（实得 different=${JSON.stringify(mutDiff.different)}）`)
  assert(mutDiff.different.every((d) => /0003-di\.html|1001-started\.html/.test(d.path)),
    `A07：变异只落在带"下一课"span 的那两页，别页不该报漂移（实得 ${mutDiff.different.map((d) => d.path).join(', ')}）`)
  // 干净副本上宿主侧不许报漂移（对照）
  const cleanDiff = diffPlan(clean, planBuild(clean, {}))
  eq(cleanDiff.different.length, 0, 'A07 对照：干净副本上宿主侧不许报漂移')

  DETAIL.comparisons.A07 = { cleanProblems: 0, mutatedProblems: problems.length, mutatedSample: problems.slice(0, 3), point: MUT_FROM.slice(0, 40) }
}

/* ── A08 第⑤条的材料与判据：依赖内核 / §6 归属 / P1-P2 授权面 / 内容锁 ──────
 *
 * 这一组里除了 probeVersionEvidence 要读盘之外，其余判据都是**纯函数**（数据进、断言出）——
 * 因为负对照必须能把"必然坏的输入"直接喂进去，否则判据是不是空转看不出来。
 */

/** 依赖内核当前的 sha256（缺件记 null，由判据自己说清楚） */
function kernelShas() {
  const out = {}
  for (const relPath of DEP_KERNELS) {
    const abs = path.join(REPO, relPath)
    out[relPath] = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null
  }
  return out
}

/**
 * `docs/unify/interfaces.md` §6 的归属表：路径 → 卡号（**运行时解析**，不手抄）。
 * 表的一行形如 `| U04 | † \`lib/unify/text.cjs\`<br>… |`：卡号在第一格，每条落点写成反引号
 * 代码段（`†`/`✅` 是"基线里有没有"的标记，不属于路径）。
 */
function section6Ownership() {
  const file = path.join(REPO, 'docs', 'unify', 'interfaces.md')
  if (!fs.existsSync(file)) throw new Blocked('缺 docs/unify/interfaces.md —— A08 第⑤条的归属无法运行时解析')
  const buf = fs.readFileSync(file)
  const text = buf.toString('utf8')
  const head = /^##\s*6\.[^\n]*$/m.exec(text)
  if (!head) throw new Blocked('docs/unify/interfaces.md 里解析不到 §6（U01–U20 写集落点）—— 归属表读不出来')
  const rest = text.slice(head.index)
  const next = /^##\s*7\.[^\n]*$/m.exec(rest.slice(head[0].length))
  const section = rest.slice(0, head[0].length + (next ? next.index : rest.length))
  const map = new Map()
  let rows = 0
  for (const line of section.split(/\r?\n/)) {
    const row = /^\|\s*(U\d{2})\s*\|(.+)\|\s*$/.exec(line.trim())
    if (!row) continue
    rows += 1
    for (const code of row[2].matchAll(/`([^`]+)`/g)) {
      const candidate = code[1].trim()
      if (!PATH_SHAPE.test(candidate)) continue
      if (!map.has(candidate)) map.set(candidate, [])
      const owners = map.get(candidate)
      if (!owners.includes(row[1])) owners.push(row[1])
    }
  }
  assert(rows >= 18, `A08：§6 的卡表只解析出 ${rows} 行（预期 ≥18）—— 归属表像被截断了，判据会拿空表当尺子`)
  return { file: rel(file), sha256: sha256(buf), rows, map }
}

/**
 * `docs/unify/authorization.json` 的授权面：**运行时现场解析**（P1/P2 的路径集合与逐字引文
 * 都从文件里读出来，本文件不写死任何一个 path 或引文）。
 */
function authorizationDoc() {
  const file = path.join(REPO, 'docs', 'unify', 'authorization.json')
  if (!fs.existsSync(file)) throw new Blocked('缺 docs/unify/authorization.json —— A08 第⑤条的授权面无法现场解析')
  const buf = fs.readFileSync(file)
  let doc = null
  try {
    doc = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    throw new Blocked(`authorization.json 不是合法 JSON —— ${e.message}`)
  }
  const scopes = {}
  for (const [id, scope] of Object.entries(doc?.scope || {})) {
    const paths = new Set()
    for (const line of Array.isArray(scope?.authorized) ? scope.authorized : []) {
      const text = String(line)
      for (const code of text.matchAll(/`([^`]+)`/g)) {
        const candidate = code[1].trim()
        if (PATH_SHAPE.test(candidate)) paths.add(candidate)
      }
      // 也认正文里裸写的路径（授权原文不一定加反引号）
      for (const m of text.matchAll(/(?:^|[\s（(、，,：:"'[])((?:lib|test|tools|docs|audit-evidence|packages)\/[A-Za-z0-9._/-]+)/g)) {
        const candidate = m[1].replace(/[.,：:;、，]+$/, '')
        if (PATH_SHAPE.test(candidate)) paths.add(candidate)
      }
    }
    scopes[id] = { title: String(scope?.title ?? ''), paths: [...paths].sort() }
  }
  return {
    file: rel(file),
    sha256: sha256(buf),
    quoteVerbatim: String(doc?.quoteVerbatim ?? ''),
    quoteSource: String(doc?.quoteSource ?? ''),
    scopes,
  }
}

/**
 * 探针版本载体在**当前盘上**的证据：PROBE_VERSION 是不是"唯一一个字面量 + 现值 == 按
 * PROBE_SOURCES 的重算值 + 宿主/包侧不再各自持有字面量"。
 * 这正是 authorization.json `scope.P1` 逐字描述的那个动作 —— 所以它能把一次漂移认成
 * "P1 的重算"，而不是"谁把这个常量随便改了"。
 */
async function probeVersionEvidence(relPath = 'lib/unify/fingerprint.cjs') {
  const abs = path.join(REPO, relPath)
  const text = readText(abs)
  const literals = text.match(PROBE_LITERAL_TEXT) || []
  const out = {
    kernel: relPath,
    literals,
    single: literals.length === 1,
    shapeOk: literals.length === 1 && PROBE_LITERAL_SHAPE.test(literals[0]),
    carrier: literals.length > 0,
  }
  if (!out.carrier) return { ...out, recomputed: null, matches: null }
  // ① 宿主 ESM 适配层：导出值必须就是内核那个字面量，且自己不许再写第二份
  const hostFile = path.join(REPO, 'lib', 'fingerprint.js')
  const host = await import(pathToFileURL(hostFile).href)
  out.probeSources = Array.isArray(host.PROBE_SOURCES) ? host.PROBE_SOURCES.slice() : []
  out.hostLiteralCount = (readText(hostFile).match(PROBE_LITERAL_TEXT) || []).length
  out.hostExportsSameValue = host.PROBE_VERSION === literals[0]
  // ② 包侧包装器：纯委托，不许有自己的字面量
  const packWrapper = readText(path.join(REPO, 'lib', 'pack-template', 'tools', 'fingerprint.js'))
  out.packLiteralCount = (packWrapper.match(PROBE_LITERAL_TEXT) || []).length
  out.packDelegates = /require\(\s*['"]\.\/unify\/fingerprint\.cjs['"]\s*\)/.test(packWrapper)
  // ③ 按 PROBE_SOURCES 重算（原始字节 + 文件间 '\0' + sha256 前 16 位 + 'p:'）
  const parts = []
  for (const [i, srcRel] of out.probeSources.entries()) {
    if (i) parts.push(Buffer.from('\0'))
    parts.push(fs.readFileSync(path.join(REPO, srcRel)))
  }
  out.recomputeBytes = parts.reduce((n, b) => n + b.length, 0)
  out.recomputed = 'p:' + sha256(Buffer.concat(parts)).slice(0, 16)
  out.matches = out.recomputed === literals[0]
  return out
}

/** ⑤-1 判据（纯函数）：两次 sha 快照必须逐条相同 —— 不同 = "这一跑写了它" */
function checkSelfAnchored(start, end) {
  const missing = []
  const wrote = []
  for (const relPath of DEP_KERNELS) {
    const a = start ? start[relPath] : null
    const b = end ? end[relPath] : null
    if (typeof a !== 'string' || typeof b !== 'string') { missing.push(relPath); continue }
    if (a !== b) wrote.push({ path: relPath, from: a, to: b })
  }
  assert(missing.length === 0,
    `A08：依赖内核缺件或读不动：${missing.join(' | ')} —— 自锚判据没有对象可判`)
  assert(wrote.length === 0,
    `A08：本次运行写了自己的依赖内核 —— ${wrote.map((w) => `${w.path} ${w.from.slice(0, 8)}… → ${w.to.slice(0, 8)}…`).join(' | ')}`
      + '（"我这一跑没写它们"不成立；fs 写守卫抓不到写集内的内核，所以这一条必须独立判）')
  return { checked: DEP_KERNELS.length }
}

/**
 * ⑤-2 / ⑤-3 的归因（**纯函数**：漂移记录 + 归属 + 授权面 + 载体证据 → 结论或红）。
 *
 * 规则（两条都成立才算“可解释”，缺一条就红）：
 *   · **无主 ⇒ 红**：`§6` 里都找不到主人的漂移，不许当"别人的合法改动"；
 *   · **载体 ⇒ 必须有 P1 授权**：文件里带 PROBE_VERSION 字面量的，漂移只能是"按 PROBE_SOURCES
 *     重算"那一个动作 —— 授权文件里没有 `scope.P1`（或该文件不在 P1 的落点里）⇒ 红；
 *     有 P1 还必须核"唯一字面量 + 现值 == 重算值 + 宿主/包侧不再各自持有字面量"。
 *   · 其余有主漂移：登记为 `owned-registered`（附主人卡号）；若授权面认得它（P2 等）则记
 *     `authorized-by-P1P2` 并逐字引 `quoteVerbatim`。
 */
function attributeDrift(record, { owners = [], scopes = {}, quoteVerbatim = '', probe = null } = {}) {
  const row = {
    path: String(record?.path ?? ''),
    from: record?.captured ?? null,
    to: record?.now ?? null,
    owners: owners.slice(),
    authorizedScopes: Object.keys(scopes).filter((id) => (scopes[id]?.paths || []).includes(record?.path)),
  }
  assert(row.path.length > 0, 'A08：漂移记录缺 path —— 归因判据没有对象可判')
  assert(row.owners.length > 0,
    `A08：依赖内核 ${row.path} 与采集时值不同，而 docs/unify/interfaces.md §6 里**无主**`
      + `（from ${String(row.from).slice(0, 8)}… → to ${String(row.to).slice(0, 8)}…）—— 不可归属的漂移一律红`)
  if (probe && probe.carrier) {
    assert(row.authorizedScopes.includes('P1'),
      `A08：${row.path} 的漂移是 PROBE_VERSION 字面量的载体，但 authorization.json 没有 scope.P1 认领它`
        + `（现场解析到的授权面：${row.authorizedScopes.join('/') || '无'}）—— 未授权的载体漂移红`)
    assert(probe.single && probe.shapeOk,
      `A08：${row.path} 的 PROBE_VERSION 不是"唯一一个 p:<16hex> 字面量"（实得 ${JSON.stringify(probe.literals)}）`)
    assert(probe.hostLiteralCount === 0 && probe.packLiteralCount === 0,
      `A08：PROBE_VERSION 长了第二份字面量（宿主 ${probe.hostLiteralCount} 份 / 包侧 ${probe.packLiteralCount} 份）`
        + ' —— P1 只许权威内核那一份')
    assert(probe.hostExportsSameValue, 'A08：宿主导出的 PROBE_VERSION 与内核字面量不同 —— 内核不是唯一来源')
    assert(probe.packDelegates === true, 'A08：包侧包装器不再委托 ./unify/fingerprint.cjs')
    assert(probe.matches === true,
      `A08：PROBE_VERSION 现值 ${JSON.stringify(probe.literals[0])} ≠ 按 PROBE_SOURCES 的重算值`
        + ` ${JSON.stringify(probe.recomputed)} —— 这不是 P1 授权的那个动作（重算）`)
    row.classification = 'authorized-by-P1P2'
    row.scope = 'P1'
    row.quoteVerbatim = String(quoteVerbatim)
    assert(row.quoteVerbatim.length > 0, 'A08：authorization.json 没有 quoteVerbatim —— 授权面必须能逐字引用')
    row.probe = {
      literals: probe.literals, recomputed: probe.recomputed, probeSources: probe.probeSources,
      hostLiteralCount: probe.hostLiteralCount, packLiteralCount: probe.packLiteralCount,
      hostExportsSameValue: probe.hostExportsSameValue, packDelegates: probe.packDelegates,
    }
    return row
  }
  if (row.authorizedScopes.length) {
    row.classification = 'authorized-by-P1P2'
    row.scope = row.authorizedScopes.join('+')
    row.quoteVerbatim = String(quoteVerbatim)
    assert(row.quoteVerbatim.length > 0, 'A08：authorization.json 没有 quoteVerbatim —— 授权面必须能逐字引用')
    return row
  }
  row.classification = 'owned-registered'
  return row
}

/** ⑤-4 判据（纯函数）：四份生产文件必须仍等于 tracked 回执登记的字节 */
function deliverableLock(rc) {
  const rows = []
  for (const relPath of DELIVERABLES) {
    const entry = (Array.isArray(rc?.writeSet) ? rc.writeSet : []).find((w) => (typeof w === 'string' ? w : w?.path) === relPath)
    assert(entry && typeof entry === 'object',
      `A08：tracked 回执没有登记 ${relPath} —— 内容锁没有对照物（不许拿"我记得一样"顶替）`)
    assert(/^[0-9a-f]{64}$/.test(String(entry.sha256 ?? '')),
      `A08：回执里 ${relPath} 没有 sha256 —— 内容锁没有对照物`)
    const buf = fs.readFileSync(path.join(REPO, relPath))
    eq(sha256(buf), entry.sha256,
      `A08：交付物 ${relPath} 与回执登记字节不同（回执登记 ${entry.bytes ?? '?'} B）—— 收口后有人改过它`)
    if (Number.isFinite(entry.bytes)) eq(buf.length, entry.bytes, `A08：交付物 ${relPath} 的字节数与回执登记不同`)
    rows.push({ path: relPath, sha256: entry.sha256, bytes: buf.length })
  }
  return rows
}

/* ── A08：不编辑模板生成副本，证据与清理受控 ─────────────────────────────── */

/** 进程内 fs 写守卫：拦 write/append/mkdir/cp/rename/rm/open(w)，记绝对路径 */
const GUARD = { installed: false, records: [], restore: [] }

function installWriteGuard() {
  const record = (op, target) => {
    if (target === null || target === undefined) return
    const abs = path.resolve(String(target))
    GUARD.records.push({ op, abs })
  }
  const wrap = (name, mapTargets) => {
    const orig = fs[name]
    if (typeof orig !== 'function') return
    const wrapped = function patched(...args) {
      try {
        for (const target of mapTargets(args)) record(name, target)
      } catch { /* 记录失败不许影响调用本身 */ }
      return orig.apply(fs, args)
    }
    fs[name] = wrapped
    GUARD.restore.push(() => { fs[name] = orig })
  }
  wrap('writeFileSync', (a) => [a[0]])
  wrap('appendFileSync', (a) => [a[0]])
  wrap('mkdirSync', (a) => [a[0]])
  wrap('rmSync', (a) => [a[0]])
  wrap('rmdirSync', (a) => [a[0]])
  wrap('renameSync', (a) => [a[1]])
  wrap('copyFileSync', (a) => [a[1]])
  wrap('cpSync', (a) => [a[1]])
  wrap('openSync', (a) => {
    const flags = String(a[1] ?? 'r')
    return /[wa+]/.test(flags) ? [a[0]] : []
  })
  GUARD.installed = true
}

/** 一条写入路径的归属判定（**纯函数**：先判类，再决定要不要拦下来） */
function classifyWrite(absPath) {
  const abs = path.resolve(String(absPath))
  if (abs === path.resolve(RUN_TEMP)) return { ok: true, owner: 'E:/Temp 本次唯一目录' }
  if (abs.startsWith(path.resolve(RUN_TEMP) + path.sep)) return { ok: true, owner: 'E:\\Temp 本次唯一目录' }
  const ev = EVIDENCE_GUARD
  if (ev.ok) {
    const root = path.resolve(ev.root)
    if (abs === root || abs.startsWith(root + path.sep)) return { ok: true, owner: '本卡本次证据根' }
  }
  const relPath = path.relative(REPO, abs).split(path.sep).join('/')
  if (!relPath.startsWith('..') && WRITE_SET.includes(relPath)) return { ok: true, owner: '本卡写集' }
  return { ok: false, owner: relPath }
}

/* ── A08 第④条的材料与判据：模板生成副本 `lib/pack-template/tools/unify/**` ────────
 *
 * 原判据是 `eq(fs.existsSync(mirrorDir), false, …)` —— 它真正要防的是**手写/手改生成物**。
 * U19 收口的动作里就包含"用 `tools/sync-unify-core.mjs --write` 把这十四份副本生成出来"
 * （同一动作还要把它们登记进发布清单），所以"目录必须不存在"这条在收口时**必然红**，
 * 而它并没有判到真正该判的东西。改成三条，一条不松（Δ 见回执 `decision-9-mirror-existence`）：
 *   ① **存在 ⇒ 必须自洽**：等价于 `node tools/sync-unify-core.mjs --check` —— 14 件齐全、
 *      逐字节等于 `lib/unify/` 权威源码、无清单外多余件/子目录（`judgeSyncPlan` 把生成器的
 *      `plan()` 结论**逐条重述**，不只信 `ok` 那个布尔；U07 还自己按 Buffer 复算一遍）。
 *   ② **不存在 ⇒ 合法**（U19 收口之前的状态），但**必须显式登记** `mirrorAbsent:true` ——
 *      静默 = 判据在没有对象时假装通过。
 *   ③ **无论存不存在：本卡本次运行对它零写** —— 由既有进程内 fs 写守卫的绝对路径记录证明。
 *      这才是原判据真正要防的事（生成物只许生成器写，卡片不许手造）。
 *   副本在而生成器不在 ⇒ 红：一份没有生成器的生成物，谁也证明不了它没漂。
 */

/**
 * 判「模板生成副本」这一条（**纯函数**：事实进、结论出；负对照直接复用）。
 *
 * @param {{exists:boolean, generatorPresent:boolean, wrote:boolean}} facts
 * @param {(plan:object)=>string[]} judgePlan 生成器对拍计划的逐条判据
 * @param {object} [plan] 生成器 `plan()` 的结果（只在"存在且生成器在"分支里用）
 * @returns {{ok:boolean, absent:boolean, problems:string[]}}
 */
function judgeMirrorState(facts, judgePlan, plan) {
  const problems = []
  // ③ 先判零写：这条与"存不存在"无关，两种分支都必须成立
  if (facts.wrote) problems.push('本次运行写了 lib/pack-template/tools/unify/**（原判据真正要防的事）')
  // ② 不存在 ⇒ 合法（登记由调用方落到证据里，这里只给结论）
  if (!facts.exists) return { ok: problems.length === 0, absent: true, problems }
  // ① 存在 ⇒ 必须自洽
  if (!facts.generatorPresent) {
    problems.push('副本目录存在，但 tools/sync-unify-core.mjs 不在 —— 没有生成器就证明不了"逐字节等于权威源码"')
  } else {
    problems.push(...judgePlan(plan))
  }
  return { ok: problems.length === 0, absent: false, problems }
}

/**
 * `node tools/sync-unify-core.mjs --check` 的等价判据（四条**逐条重述**生成器 `plan()` 的结论）：
 * 清单 14 件 / 镜像 14 件全在 / 每一份逐字节相同 / 无清单外多余件（含 `migration.cjs`、子目录、临时件）。
 * 不直接拿 `plan.ok` 当结论 —— 单一布尔说不清红在哪儿，也没法给小样负对照。
 */
function judgeSyncPlan(p) {
  if (!p || typeof p !== 'object') return ['生成器没有给出对拍计划']
  const problems = []
  const modules = Array.isArray(p.modules) ? p.modules : []
  const missing = p.missing || []
  const changed = p.changed || []
  const extra = p.extra || []
  const extraDirs = p.extraDirs || []
  const same = p.same || []
  const authorityMissing = p.authorityMissing || []
  if (modules.length !== 14) problems.push(`生成器清单不是 14 件（实得 ${modules.length}）`)
  if (!p.mirrorExists) problems.push('plan() 说镜像目录不存在（走错分支）')
  if (missing.length) problems.push(`镜像缺 ${missing.length} 件：${missing.join('、')}`)
  if (changed.length) {
    problems.push(`镜像与权威源码字节不同 ${changed.length} 件：${changed.map((c) => `${c.name}.cjs`).join('、')}`)
  }
  if (extra.length) problems.push(`镜像有清单外多余件 ${extra.length} 个：${extra.join('、')}`)
  if (extraDirs.length) problems.push(`镜像里有子目录/非常规件：${extraDirs.join('、')}`)
  if (authorityMissing.length) problems.push(`权威源码缺件：${authorityMissing.join('、')}`)
  if (same.length !== modules.length) problems.push(`逐字节相同的件数 ${same.length} ≠ 清单 ${modules.length}`)
  if (p.ok !== true) problems.push(`生成器自评 ok=${JSON.stringify(p.ok)}`)
  return problems
}

async function A08() {
  const p = pre()
  const ps = preSources()
  const out = {}

  // ① 守卫必须**真的挂着**：探针写要被抓到，且探针本身落在允许区
  assert(GUARD.installed, 'A08：fs 写守卫没有装上 —— 越界断言就是空转')
  const probeDir = path.join(RUN_TEMP, 'guard-probe')
  fs.mkdirSync(probeDir, { recursive: true })
  const probeFile = path.join(probeDir, 'probe.txt')
  fs.writeFileSync(probeFile, 'probe', 'utf8')
  const probe = GUARD.records.filter((r) => r.abs === path.resolve(probeFile) && r.op === 'writeFileSync')
  eq(probe.length, 1, 'A08：探针写没有被守卫记录下来 —— 守卫没真的拦着 fs')
  eq(classifyWrite(probeFile).ok, true, 'A08：守卫的探针写本身就必须落在允许区（E:\\Temp 本次唯一目录）')
  out.guardProbe = { recorded: probe.length }

  // ② 归属判类：允许区三种，其余一律拒绝（含"绕到仓内别处""绕到别人的证据目录"）
  eq(classifyWrite(path.join(REPO, 'lib', 'unify', 'render.cjs')).ok, true, 'A08：写集内的文件必须允许（本卡自己写它）')
  eq(classifyWrite(path.join(REPO, 'lib', 'unify', 'identity.cjs')).ok, false, 'A08：写集外的仓内文件必须拒绝（identity.cjs 归 U02）')
  eq(classifyWrite(path.join(REPO, 'lib', 'pack-template', 'tools', 'unify', 'render.cjs')).ok, false, 'A08：不许创建 lib/pack-template/tools/unify/**（那是 U19 的生成物）')
  eq(classifyWrite(path.join(REPO, 'docs', 'unify', 'interfaces.md')).ok, false, 'A08：docs/unify/interfaces.md 归 U01，必须拒绝')
  eq(classifyWrite(path.join(BASELINE_ROOT, 'pre-change.json')).ok, false, 'A08：既有采集证据必须只读（不许覆盖）')

  // ③ 本次运行里**真的发生的写入**全部落在允许区（这就是越界守卫的正体）
  const outside = GUARD.records.filter((r) => !classifyWrite(r.abs).ok)
  eq(outside.length, 0, `A08：出现了写集外的写入：${outside.slice(0, 8).map((r) => `${r.op} ${classifyWrite(r.abs).owner}`).join(' | ')}`)
  const touchedInRepo = [...new Set(GUARD.records
    .map((r) => path.relative(REPO, r.abs).split(path.sep).join('/'))
    .filter((x) => !x.startsWith('..')))].sort()
  for (const relPath of touchedInRepo) {
    assert(WRITE_SET.includes(relPath), `A08：本次运行往仓内写了写集外的文件：${relPath}`)
  }
  out.writes = { total: GUARD.records.length, inRepo: touchedInRepo }

  // ④ 模板生成副本 `lib/pack-template/tools/unify/**`：三条（原判据「必须不存在」见回执 Δ
  //    decision-9-mirror-existence —— U19 收口的生成动作会让它必然红，而它没判到真正该判的事）。
  const mirrorDir = path.join(TEMPLATE, 'tools', 'unify')
  const mirrorAbs = path.resolve(mirrorDir)
  const touchesMirror = (abs) => {
    const a = path.resolve(String(abs))
    return a === mirrorAbs || a.startsWith(mirrorAbs + path.sep)
  }
  const generatorFile = path.join(REPO, 'tools', 'sync-unify-core.mjs')
  const mirrorExists = fs.existsSync(mirrorDir)
  const generatorPresent = fs.existsSync(generatorFile)
  const mirrorWrites = GUARD.records.filter((r) => touchesMirror(r.abs))
  const mirrorOut = {
    dir: rel(mirrorDir),
    exists: mirrorExists,
    generatorPresent,
    // ② 不存在也合法，但必须**显式登记**（不静默）
    mirrorAbsent: !mirrorExists,
  }
  let syncPlan = null

  if (mirrorExists && generatorPresent) {
    // ① 存在 ⇒ 必须自洽。直接 import 生成器本体用它自己的 plan()：与 `--check` 是**同一份判据**，
    //    不在这里手抄第二份十四件清单（手抄的清单自己会漂，那就成了"判据跟着实现改"）。
    const mod = await import(pathToFileURL(generatorFile).href)
    assert(typeof mod.plan === 'function', 'A08：tools/sync-unify-core.mjs 没有导出 plan() —— 无法做 --check 等价对拍')
    syncPlan = mod.plan({ repoRoot: REPO })
    const want = (syncPlan.modules || []).map((n) => `${n}.cjs`)
    eq(want.length, 14, 'A08：生成器清单必须正好十四件（运行态内核）')

    // 独立复算（不信生成器的自评）：目录清单 + 逐件 Buffer 对拍
    const listed = fs.readdirSync(mirrorDir, { withFileTypes: true })
    const files = listed.filter((e) => e.isFile()).map((e) => e.name).sort()
    const dirs = listed.filter((e) => !e.isFile()).map((e) => e.name)
    eq(dirs.length, 0, `A08：模板生成目录里不许有子目录/非常规件（${dirs.join('、')}）`)
    sameJson(files, [...want].sort(), 'A08：模板生成目录的文件清单必须正好等于那十四件（不多不少、不留临时件）')
    const rowsMirror = []
    for (const name of want) {
      const authorityRel = `lib/unify/${name}`
      const aBuf = fs.readFileSync(path.join(REPO, 'lib', 'unify', name))
      const mBuf = fs.readFileSync(path.join(mirrorDir, name))
      eq(mBuf.equals(aBuf), true, `A08：模板生成副本 tools/unify/${name} 必须与权威源码 ${authorityRel} 逐字节相同`)
      rowsMirror.push({ file: name, bytes: mBuf.length, sha256: sha256(mBuf), authority: authorityRel })
    }
    mirrorOut.files = rowsMirror
    mirrorOut.bytes = rowsMirror.reduce((n, r) => n + r.bytes, 0)

    // 与 CLI 再对一次（同一个 plan()，但走真正的入口 —— 证明"生成器文件"就是"CLI 跑的那个文件"）
    const cli = spawnSync(process.execPath, ['tools/sync-unify-core.mjs', '--check'],
      { cwd: REPO, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
    const cliLine = String(cli.stdout || '').trim().split(/\r?\n/)[0] || ''
    eq(cli.status, 0, `A08：node tools/sync-unify-core.mjs --check 必须 exit 0（实得 ${cli.status}：${cliLine.slice(0, 200)}）`)
    assert(/^UNIFY-CORE ok=true\b/.test(cliLine), `A08：--check 必须自报 ok=true（实得「${cliLine.slice(0, 200)}」）`)
    mirrorOut.cli = { exit: cli.status, line: cliLine }
    mirrorOut.plan = {
      ok: syncPlan.ok,
      modules: (syncPlan.modules || []).length,
      same: (syncPlan.same || []).length,
      missing: (syncPlan.missing || []).length,
      changed: (syncPlan.changed || []).length,
      extra: (syncPlan.extra || []).length,
      extraDirs: (syncPlan.extraDirs || []).length,
      bytes: syncPlan.byteTotal,
    }
  }

  // 三条合判（纯函数；负对照见下）
  const mirrorVerdict = judgeMirrorState(
    { exists: mirrorExists, generatorPresent, wrote: mirrorWrites.length > 0 },
    judgeSyncPlan, syncPlan,
  )
  assert(mirrorVerdict.problems.length === 0,
    `A08：模板生成副本不自洽（${mirrorVerdict.problems.slice(0, 3).join(' | ')}）`)

  // ③ 本卡零写它（原判据真正要防的事）—— 守卫记录按**绝对路径**判，目录本身也算"碰过"
  eq(mirrorWrites.length, 0,
    `A08：本次运行碰过模板生成目录：${mirrorWrites.slice(0, 5).map((r) => `${r.op} ${rel(r.abs)}`).join(' | ')}`)
  mirrorOut.zeroWrites = mirrorWrites.length === 0

  // 三条判据的**进程内负对照**（喂必然坏的输入，必须红在指定理由上 —— 否则它们是空转）
  const mirrorControl = (what, fn, needleRe) => {
    const msg = expectRed(what, fn, needleRe)
    mirrorOut.controls = mirrorOut.controls || []
    mirrorOut.controls.push({ what, red: true, first: msg.split('\n')[0].slice(0, 160) })
  }
  /** 一份"必然绿"的合成对拍计划（只给负对照当底子：判据不读盘，只读这些字段） */
  const greenPlan = () => {
    const names = Array.from({ length: 14 }, (_, i) => `mod${i}`)
    return {
      ok: true, mirrorExists: true, modules: names.slice(), same: names.slice(),
      missing: [], changed: [], extra: [], extraDirs: [], authorityMissing: [],
    }
  }
  const assertMirrorGreen = (f, p) => {
    const v = judgeMirrorState(f, judgeSyncPlan, p)
    assert(v.problems.length === 0, `A08：模板生成副本不自洽（${v.problems.slice(0, 3).join(' | ')}）`)
    return v
  }
  // 正对照：合成计划本身必须是"绿"的，否则下面几条红的理由就不成立
  eq(assertMirrorGreen({ exists: true, generatorPresent: true, wrote: false }, greenPlan()).absent, false,
    'A08：合成对拍计划必须判绿且走"存在"分支（否则负对照的红没有意义）')
  eq(assertMirrorGreen({ exists: false, generatorPresent: false, wrote: false }).absent, true,
    'A08：副本不存在时必须判绿且登记 absent（U19 之前的状态合法）')
  mirrorControl('④-1 副本·改了一份副本的一个字节', () => {
    const p = greenPlan()
    p.changed = [{ name: 'mod0', expected: '0'.repeat(64), actual: '1'.repeat(64), bytes: 1, expectedBytes: 2 }]
    p.same = p.same.filter((n) => n !== 'mod0')
    return assertMirrorGreen({ exists: true, generatorPresent: true, wrote: false }, p)
  }, /字节不同|字节不完全|逐字节/)
  mirrorControl('④-2 副本·目录里多了一个清单外的件', () => {
    const p = greenPlan()
    p.extra = ['migration.cjs']
    return assertMirrorGreen({ exists: true, generatorPresent: true, wrote: false }, p)
  }, /多余件|清单外/)
  mirrorControl('④-3 副本·少生成了一件', () => {
    const p = greenPlan()
    p.missing = ['mod13']
    p.same = p.same.filter((n) => n !== 'mod13')
    return assertMirrorGreen({ exists: true, generatorPresent: true, wrote: false }, p)
  }, /镜像缺|逐字节相同/)
  mirrorControl('④-4 副本·没有生成器却有一份副本', () => assertMirrorGreen(
    { exists: true, generatorPresent: false, wrote: false }, null,
  ), /没有生成器|sync-unify-core/)
  mirrorControl('④-5 副本·本次运行写了它一个字节', () => assertMirrorGreen(
    { exists: false, generatorPresent: false, wrote: true }, null,
  ), /本次运行写了/)

  out.mirror = mirrorOut
  // ② 的"不静默"落到证据上：这一键必须在，且副本不存在时必须是 true
  assert('mirrorAbsent' in mirrorOut && typeof mirrorOut.mirrorAbsent === 'boolean',
    'A08：证据里必须登记 mirrorAbsent（副本没生成时不许静默跳过这一条）')
  if (!mirrorExists) eq(mirrorOut.mirrorAbsent, true, 'A08：副本不存在时必须如实登记 mirrorAbsent:true')

  // ⑤ 依赖内核（9 份计算内核 + 探针版本载体）：口径四条 —— 自锚 / 归属 / 授权面 / 内容锁
  //
  //    原口径「必须等于采集时值」在共享工作区里会把别人合法的交付判成漂移。新口径**不是放宽**：
  //    ① 换成「本次运行没写它」（覆盖面还多了写集内那几份 —— fs 写守卫本来就抓不到它们）；
  //    ②③ 让每一次外部漂移都必须**可归属 + 可认领**（无主 / 未授权照样红）；
  //    ④ 本卡自己的字节必须仍等于回执登记。
  const anchorsNow = kernelShas()

  // ① 运行期自锚：模块初始化（任何用例之前）记的那一版，收口前必须一个不差
  const selfAnchor = checkSelfAnchored(DEP_SELF_ANCHOR.shas, anchorsNow)

  // ②③ 运行期外漂移：与采集时值不同 ⇒ 按 §6 归属 + P1/P2 授权面归因
  const ownership = section6Ownership()
  const auth = authorizationDoc()
  const unowned = DEP_KERNELS.filter((relPath) => !(ownership.map.get(relPath) || []).length)
  assert(unowned.length === 0,
    `A08：docs/unify/interfaces.md §6 里**无主**的依赖内核：${unowned.join(' | ')} —— 无主 ⇒ 红（漂移将不可归属）`)
  const kernelProbe = await probeVersionEvidence()
  const drift = []
  const unchanged = []
  const notCaptured = []
  for (const relPath of DEP_KERNELS) {
    const captured = Object.prototype.hasOwnProperty.call(p.dependencyAnchors || {}, relPath) ? p.dependencyAnchors[relPath] : null
    const now = anchorsNow[relPath]
    // 采集清单里没有它的采集时值（采集那一刻它还没交付）⇒ 不能冒充"与采集值相同"，只由 ① 自锚覆盖
    if (typeof captured !== 'string') { notCaptured.push(relPath); continue }
    if (captured === now) { unchanged.push(relPath); continue }
    const carriesLiteral = (readText(path.join(REPO, relPath)).match(PROBE_LITERAL_TEXT) || []).length > 0
    const probe = carriesLiteral ? (relPath === PROBE_CARRIER ? kernelProbe : await probeVersionEvidence(relPath)) : null
    drift.push(attributeDrift({ path: relPath, captured, now }, {
      owners: ownership.map.get(relPath), scopes: auth.scopes, quoteVerbatim: auth.quoteVerbatim, probe,
    }))
  }

  // ④ 交付物内容锁：本卡四份生产文件仍等于 tracked 回执登记的字节
  const locked = deliverableLock(receiptDoc())

  // 四条判据的**进程内负对照**（喂必然坏的输入，必须红在指定理由上 —— 否则它们是空转）
  const controls = []
  const control = (what, fn, needleRe) => {
    const msg = expectRed(what, fn, needleRe)
    controls.push({ what, red: true, first: msg.split('\n')[0].slice(0, 160) })
  }
  control('⑤-1 自锚·运行期改了一份内核', () => {
    const broken = { ...anchorsNow, [PROBE_CARRIER]: sha256(Buffer.from('u07-self-anchor-control', 'utf8')) }
    checkSelfAnchored(DEP_SELF_ANCHOR.shas, broken)
  }, /本次运行写了|依赖内核缺件/)
  control('⑤-2 归属·把漂移记录的主人抹掉', () => attributeDrift(
    { path: PROBE_CARRIER, captured: '0'.repeat(64), now: anchorsNow[PROBE_CARRIER] },
    { owners: [], scopes: auth.scopes, quoteVerbatim: auth.quoteVerbatim, probe: kernelProbe.carrier ? kernelProbe : null },
  ), /无主|不可归属/)
  control('⑤-3 授权面·authorization.json 缺 scope.P1', () => {
    const scopesWithoutP1 = Object.fromEntries(Object.entries(auth.scopes).filter(([id]) => id !== 'P1'))
    // 控制组的载体证据取"最理想的那一版"：若现值不满足 P1 的形状，就喂一份满足的，好让红的理由只可能是"缺授权"
    const goodProbe = kernelProbe.carrier ? kernelProbe : {
      kernel: PROBE_CARRIER, carrier: true, single: true, shapeOk: true,
      literals: [`p:${'0'.repeat(16)}`], recomputed: `p:${'0'.repeat(16)}`, matches: true,
      probeSources: [], hostLiteralCount: 0, packLiteralCount: 0, hostExportsSameValue: true, packDelegates: true,
    }
    return attributeDrift(
      { path: PROBE_CARRIER, captured: '0'.repeat(64), now: anchorsNow[PROBE_CARRIER] },
      { owners: ownership.map.get(PROBE_CARRIER), scopes: scopesWithoutP1, quoteVerbatim: auth.quoteVerbatim, probe: goodProbe },
    )
  }, /scope\.P1|未授权的载体漂移/)
  control('⑤-4 内容锁·回执登记的字节对不上', () => deliverableLock({
    writeSet: (receiptDoc().writeSet || []).map((w) => (
      typeof w === 'object' && w && w.path === DELIVERABLES[0] ? { ...w, sha256: '0'.repeat(64) } : w
    )),
  }), /与回执登记字节不同|没有 sha256/)

  out.depKernels = {
    total: DEP_KERNELS.length,
    selfAnchor: { when: DEP_SELF_ANCHOR.when, checked: selfAnchor.checked, shas: DEP_SELF_ANCHOR.shas },
    unchangedVsCaptured: unchanged,
    notCaptured,
    drift,
    ownership: {
      file: ownership.file, sha256: ownership.sha256, rows: ownership.rows,
      owners: Object.fromEntries(DEP_KERNELS.map((r) => [r, ownership.map.get(r) || []])),
    },
    authorization: {
      file: auth.file, sha256: auth.sha256, quoteVerbatim: auth.quoteVerbatim,
      scopes: Object.fromEntries(Object.entries(auth.scopes).map(([id, s]) => [id, s.paths])),
    },
    deliverables: locked,
    controls,
  }

  // ⑥ 写集的实际情况与声明一致：两个适配层真的改了、render-inputs 真的没改、内核真的新建了
  const nowSha = (relPath) => sha256(fs.readFileSync(path.join(REPO, relPath)))
  eq(nowSha('lib/render.js') !== p.sources['lib/render.js'].sha256, true, 'A08：lib/render.js 必须真的改成适配层（字节没变就是没做事）')
  eq(nowSha('lib/render-inputs.js'), p.sources['lib/render-inputs.js'].sha256, 'A08：lib/render-inputs.js 声明"0 字节改动"，实际变了')
  eq(nowSha('lib/pack-template/tools/build-lessons.js') !== p.sources['lib/pack-template/tools/build-lessons.js'].sha256, true, 'A08：包侧 build-lessons.js 必须真的改成委托')
  assert(!ps.files['lib/unify/render.cjs'], 'A08：改前快照里不该有 render.cjs（它必须是本卡新建的）')
  assert(fs.existsSync(path.join(REPO, 'lib', 'unify', 'render.cjs')), 'A08：新内核 lib/unify/render.cjs 不存在')
  out.writeSet = WRITE_SET.slice()

  // ⑦ --evidence-root 守卫：默认落本卡新运行目录；越界拒绝；读取根恒定
  const defaultRoot = resolveEvidenceRoot([], CARD, { repoRoot: REPO })
  eq(defaultRoot.ok, true, 'A08：默认证据根必须可解析')
  eq(defaultRoot.root, path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-${process.pid}`), 'A08：默认证据根必须是 audit-evidence/U07/runs/U07-<pid>')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(TEMP_PARENT, `${CARD}-guard-${process.pid}`)}`], CARD, { repoRoot: REPO }).ok, true,
    'A08：E:\\Temp 下带 U07- 前缀的新目录必须被接受')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib', `${CARD}-x`)}`], CARD, { repoRoot: REPO }).ok, false, 'A08：往仓内别处写必须被拒')
  eq(resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'audit-evidence', 'U04')}`], CARD, { repoRoot: REPO }).ok, false, 'A08：覆盖别的卡证据目录必须被拒')
  eq(resolveEvidenceRoot(['--evidence-root=relative/dir'], CARD, { repoRoot: REPO }).ok, false, 'A08：相对路径必须被拒')
  eq(path.dirname(PRE_FILE), BASELINE_ROOT, 'A08：读取根必须恒为 <repo>/audit-evidence/U07（--evidence-root 只动写入位置）')
  eq(readText(PRE_FILE).length > 0, true, 'A08：--evidence-root 不该影响读取根（采集材料仍然可读）')

  // ⑧ 临时目录：按绝对路径与归属清理；守卫该拒的拒、该删的删
  const g1 = guardTempPath(RUN_TEMP, { parent: TEMP_PARENT })
  eq(g1.ok, true, `A08：本次临时根必须归 E:\\Temp（${g1.error || ''}）`)
  assert(/^u07-\d+-[0-9a-f]{8}$/.test(path.basename(RUN_TEMP)), 'A08：本次临时根名字必须是 u07-<pid>-<rand>（本次唯一）')
  eq(guardTempPath(TEMP_PARENT, { parent: TEMP_PARENT }).ok, false, 'A08：守卫必须拒绝删除父目录本身')
  eq(guardTempPath(path.join(TEMP_PARENT, 'someone-else'), { parent: path.join(TEMP_PARENT, 'other') }).ok, false, 'A08：守卫必须拒绝父目录不符的目标')
  eq(guardTempPath(path.join(TEMP_PARENT, 'bad name!'), { parent: TEMP_PARENT }).ok, false, 'A08：守卫必须拒绝名字形状可疑的目标')
  const scratch = path.join(TEMP_PARENT, `u07-scratch-${process.pid}`)
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'x.txt'), 'x', 'utf8')
  const removed = safeRemoveTree(scratch, { parent: TEMP_PARENT })
  eq(removed.removed, true, `A08：守卫内的清理必须成功（${removed.error || ''}）`)
  eq(fs.existsSync(scratch), false, 'A08：清理后目录必须真的没了')

  // ⑨ tracked 回执：五项齐，且与本卡声明对得上（回执与 ⑤-4 的内容锁共用同一份解析结果）
  const rc = receiptDoc()
  eq(rc.card, CARD, 'A08：回执 card 不对')
  eq(rc.status, 'PASS', 'A08：回执 status 必须是 PASS（判词以本入口为准）')
  for (const key of ['completion', 'dependencies', 'interfaceConsumption', 'writeSet', 'deltas', 'verdict', 'unverified', 'evidenceIndex']) {
    assert(key in rc, `A08：回执缺字段 ${key}`)
  }
  sameJson(rc.writeSet.map((w) => (typeof w === 'string' ? w : w.path)), WRITE_SET, 'A08：回执里的写集与卡面写集不一致')
  eq(rc.writeSet.find((w) => (w.path || w) === 'lib/render-inputs.js').changed, false, 'A08：回执里 render-inputs.js 必须登记成"未改动"')
  assert(rc.unverified.some((u) => /U19/.test(JSON.stringify(u))), 'A08：未验证边界里必须登记"U19 生成 tools/unify/ 副本"')
  assert(rc.unverified.some((u) => /pack-scaffold|writeScaffold|模板缺件/.test(JSON.stringify(u))), 'A08：未验证边界里必须登记"模板铺出来的包缺 render.cjs"的中间态')
  assert(rc.deltas.some((d) => /extractPage|反向抽取/.test(JSON.stringify(d))), 'A08：Δ 里必须点名"反向抽取取了产品侧语义"')
  assert(/^[0-9a-f]{64}$/.test(rc.verdict.evidenceSha256 || ''), 'A08：回执里必须给采集材料的 sha256')
  out.receipt = { status: rc.status, writeSet: rc.writeSet.length }

  DETAIL.comparisons.A08 = out
}

/* ══════════════════════════════════════════════════════════════════════ */

/** 证据写入根的解析（越界即 BLOCKED，不写一个字节） */
const EVIDENCE_GUARD = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })

/** 守卫必须在**任何用例之前**装上（A08 判的是"本次运行的全部写入"） */
installWriteGuard()

/**
 * A08 第⑤条 ① 的锚点：**本次运行开始时**（任何用例之前）把 10 份依赖内核的 sha256 记下来。
 * A08 收口前再算一次并逐条比 —— 不同 = "我这一跑写了它"（含写集内的 render.cjs：那道 fs 写
 * 守卫按归属放行它，所以这一条必须独立判）。
 */
const DEP_SELF_ANCHOR = {
  when: `模块初始化（任何用例之前；pid=${process.pid}）`,
  shas: kernelShas(),
}

const CASES = [
  { id: 'A01', run: A01, timeoutMs: 240000 },
  { id: 'A02', run: A02, timeoutMs: 120000 },
  { id: 'A03', run: A03, timeoutMs: 240000 },
  { id: 'A04', run: A04, timeoutMs: 120000 },
  { id: 'A05', run: A05, timeoutMs: 240000 },
  { id: 'A06', run: A06, timeoutMs: 120000 },
  { id: 'A07', run: A07, timeoutMs: 240000 },
  { id: 'A08', run: A08, timeoutMs: 120000 },
]

let verdict = null
try {
  verdict = await runCard(CARD, FIXED_IDS, CASES, {
    argv: ARGV,
    blocked: EVIDENCE_GUARD.ok ? null : `证据根解析失败：${EVIDENCE_GUARD.error}`,
  })
} finally {
  // 本次运行的临时根：清理前核对解析后的绝对路径与归属（父目录必须是 E:\Temp，名字必须带本次 pid）
  const resolved = path.resolve(RUN_TEMP)
  const own = path.dirname(resolved) === path.resolve(TEMP_PARENT)
    && path.basename(resolved).startsWith(`${CARD.toLowerCase()}-${process.pid}-`)
  if (own) {
    for (const restore of GUARD.restore) restore()
    fs.rmSync(resolved, { recursive: true, force: true })
    DETAIL.tempCleaned = !fs.existsSync(resolved)
  } else {
    DETAIL.tempCleaned = false
    DETAIL.tempCleanupRefused = resolved
  }
}

if (EVIDENCE_GUARD.ok) {
  const dir = EVIDENCE_GUARD.root
  writeRunEvidence(verdict, dir)
  DETAIL.entry = { file: rel(SELF), dir: HERE }
  DETAIL.argv = ARGV
  DETAIL.verdict = { line: verdict.line, code: verdict.code, ms: verdict.ms }
  DETAIL.cases = Object.fromEntries(verdict.cases.map((c) => [c.id, { status: c.actual, note: c.note, ms: c.ms }]))
  DETAIL.fixtures = { file: rel(FIXTURES_FILE), sha256: sha256(fs.readFileSync(FIXTURES_FILE)) }
  DETAIL.baseline = { file: rel(PRE_FILE), sha256: sha256(fs.readFileSync(PRE_FILE)) }
  DETAIL.writeGuard = { installed: GUARD.installed, records: GUARD.records.length }
  fs.writeFileSync(path.join(dir, 'detail.json'), JSON.stringify(DETAIL, null, 2) + '\n', 'utf8')
}
process.exitCode = printVerdict(verdict)
