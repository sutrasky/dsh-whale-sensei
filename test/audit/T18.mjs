/**
 * test/audit/T18.mjs — 新包直接具备导出依赖闭包（卡 T18 / 报告 D06）
 * ==================================================================
 * 病（旧行为）：`lib/pack-export.js` shell-out 到**包内** `tools/build-lessons-index.js` 取课程星清单，
 * 而那一件只活在 `lib/pack-template/tools/` 里、**没登记进** `lib/pack-scaffold.js#TEMPLATE_FILES`
 * ⇒ 只用 `writeScaffold` 建出来的新包**缺它** ⇒ `exportLesson` 永远停在「生成课程星清单失败」。
 * 而 `test/export-pack.mjs` 原来用**手工拷贝**把这一件补进夹具，于是判据恒绿、缺口活着。
 *
 * 本卡判据（卡面原文）：
 *   「只用 writeScaffold 建空包，添加最小课程，直接导出成功；测试禁止额外拷补引擎件。
 *     本次未执行完整导出/压缩。」
 * 补充：真解包核内容约束；导出纯读（前后 path+size+mtime 全同）；反空转（移走必需生成器必红）。
 *
 * 固定用例 ID 全集（**不许漂移**）：
 *   A01-A06 行为锚：真建空包 / 新包自带导出生成器且**零手工补件** / 真导出成功 / 真解包核内容 /
 *                    清单与形状 / 导出纯读
 *   L01-L08 闭包登记：两份清单成对且测试不许手工补件 / **独立必需件预期锚**（从 `lib/pack-export.js`
 *                    源码独立抽包内脚本引用 + 从 `lib/pack-model.js` 抽读取链 require，逐件核对
 *                    「建出来的包里存在、与模板逐字节相同」）/ 清单件件在盘上 / pack 档闸
 *                    「模板里所有代码件（减离线通道件）都登记了」/ 闸能失败 / 抽取器能失败
 *   M01-M03 反空转：移走必需生成器必红 / 快照判据能变 / 还原后必绿
 *
 * ⚠️ **独立必需件预期锚**：L04 + A03 + M01 三件套 —— 一份是**源码抽出来的**，一份是**真跑出来的**
 * （建空包 → 加最小课程 → `exportLesson` 必须 `ok:true`），一份是**移走必需件必须红**。
 * 绝不止"几张表彼此比一比"（表比表在"几起错"时恒真，等于没判）。
 *
 * 铁律：夹具全在 `E:/Temp/whale-T18-*`；真包（活包）与只读快照**一个字节都不碰** ——
 * 本卡**不读活包**，换台机器也能跑。失败留夹具，成功才清（清前核实绝对路径属于本次夹具）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHarness, clip } from './harness.mjs'

/** 固定用例 ID 全集（漂移即判失败） */
const IDS = [
  'A01', 'A02', 'A03', 'A04', 'A05', 'A06',
  'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08',
  'M01', 'M02', 'M03',
]

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')
const ENGINE_FILES_CJS = path.join(TEMPLATE, 'tools', 'engine-files.cjs')
const EXPORT_SRC = path.join(REPO, 'lib', 'pack-export.js')
const READER_SRC = path.join(REPO, 'lib', 'pack-model.js')
const SCAFFOLD_SRC = path.join(REPO, 'lib', 'pack-scaffold.js')
const EXPORT_TEST_SRC = path.join(REPO, 'test', 'export-pack.mjs')
const EVIDENCE = path.join(REPO, 'audit-evidence/T18')
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const requireCJS = createRequire(import.meta.url)

const h = createHarness({ card: 'T18', expectedIds: IDS, evidenceDir: EVIDENCE })

const BASE = 'E:/Temp'
fs.mkdirSync(BASE, { recursive: true })
const FIXTURE = fs.mkdtempSync(path.join(BASE, 'whale-T18-'))

/* ── 小工具（快照 / 解包 / 夹具写盘）────────────────────────────────────── */

/** 一棵树的 path+size+mtime 快照（判"导出是纯读"用） */
function snapTree(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { const s = fs.statSync(p); out.push(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}`) }
    }
  }
  walk(dir)
  return out.join('\n')
}

/** 目录下的全部文件（POSIX 相对路径） */
function listFiles(dir, prefix = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) listFiles(path.join(dir, e.name), rel, out)
    else out.push(rel)
  }
  return out
}

function unzipList(zip) {
  return execFileSync(TAR, ['-tf', zip], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim().replace(/^\.\//, ''))
    .filter((s) => s && !s.endsWith('/'))
    .sort()
}
function unzipRead(zip, rel, into) {
  fs.mkdirSync(into, { recursive: true })
  execFileSync(TAR, ['-xf', zip, '-C', into], { encoding: 'utf8' })
  return fs.readFileSync(path.join(into, rel), 'utf8')
}

const mk = (pack, rel, content) => {
  const p = path.join(pack, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf8')
}

/**
 * 从**源码**里抽「这个消费者引用了哪些包内脚本」——独立于任何清单表：
 *   · `path.join('tools', 'x')` 这种字面量（老写法：脚本名写在消费者里）
 *   · `engineFiles({ profile: '…' })` 这种档位（新写法：脚本名来自单一名单）
 */
function extractPackScriptRefs(src) {
  const scripts = new Set()
  const profiles = new Set()
  for (const m of String(src).matchAll(/path\.join\(\s*'tools'\s*,\s*'([^']+)'\s*\)/g)) scripts.add(`tools/${m[1]}`)
  for (const m of String(src).matchAll(/engineFiles\(\s*\{\s*profile\s*:\s*'([^']+)'\s*\}\s*\)/g)) profiles.add(m[1])
  return { scripts: [...scripts].sort(), profiles: [...profiles].sort() }
}

/** 读取链的包内 require：`path.join(ROOT, 'tools', 'x')`（`lib/pack-model.js` 的写法） */
function extractReaderRefs(src) {
  const out = new Set()
  for (const m of String(src).matchAll(/path\.join\(\s*ROOT\s*,\s*'tools'\s*,\s*'([^']+)'\s*\)/g)) out.add(`tools/${m[1]}`)
  return [...out].sort()
}

/* ── 真活：全部在夹具里做（异步部分先跑完，再逐条判）────────────────────── */

let SCAFFOLD = null
let RULES = null
let EXPORT = null
let ENGINE = null
let fatal = null

/** 观测记录（原始证据，不只留判词） */
const obs = { at: new Date().toISOString(), fixture: FIXTURE, steps: [] }
const step = (name, data) => { obs.steps.push({ name, data }); return data }

const PACK = path.join(FIXTURE, 'pack')
const OUT = path.join(FIXTURE, 'out')
const OUT_MUT = path.join(FIXTURE, 'out-mut')
const MUT = path.join(FIXTURE, 'pack-mut')
const UNZIP = path.join(FIXTURE, 'unzip')
const ENGINE_REL = 'tools/build-lessons-index.js'

/** 本夹具自己写的课程件（**不含任何引擎件** —— 卡面判据：测试禁止额外拷补引擎件） */
const LESSON_FILES = [
  'lessons/demo/halo.json',
  'lessons/demo/alpha/point.json',
  'lessons/demo/beta/point.json',
  'lessons/src/demo/alpha/0001-hello.html',
  'lessons/demo/alpha/0001-hello.html',
]

let scaffolded = null
let packFiles = null
let beforeSnap = null
let afterSnap = null
let exportResult = null
let zipList = null
let packJson = null
let indexJson = null
let mutResult = null
let mutRestored = null
let exportClosure = null
let readerClosure = null
let packClosure = null
let srcRefs = null
let readerRefs = null
let gateClean = null
let gateDirty = null
let extractorDirty = null
let throwOnBadProfile = null

try {
  if (!fs.existsSync(TAR)) {
    h.block(`这台机器上没有 bsdtar（${TAR}）—— 真解包/真打包都没法做，缺料不记 PASS`)
    throw new Error(`BLOCKED：没有 tar.exe（${TAR}）`)
  }
  if (!fs.existsSync(ENGINE_FILES_CJS)) throw new Error(`插件里没有 ${ENGINE_FILES_CJS}（本卡的随包引擎闭包单一名单）`)

  SCAFFOLD = await import('../../lib/pack-scaffold.js')
  RULES = await import('../pack-template-rules.mjs')
  EXPORT = await import('../../lib/pack-export.js')
  ENGINE = requireCJS(ENGINE_FILES_CJS)

  /* ── A01：只用 writeScaffold 建**空包** ───────────────────────────── */
  fs.mkdirSync(PACK)
  scaffolded = step('A01.writeScaffold', SCAFFOLD.writeScaffold(PACK))

  /* ── 最小**合规**课程（只有内容件，没有任何引擎件）────────────────── */
  mk(PACK, 'lessons/demo/halo.json', `${JSON.stringify({ halo: 'demo', name: '演示圈', color: '#888888' }, null, 2)}\n`)
  // alpha 依赖 beta（前置链，beta 自己没有课 ⇒ 只带**结构**）；ghost 是故意不存在的前置（缺失要跳过、不许炸）
  mk(PACK, 'lessons/demo/alpha/point.json', `${JSON.stringify({ point: 'alpha', name: '演示点', fileBase: 0, requires: ['beta', 'ghost'] }, null, 2)}\n`)
  mk(PACK, 'lessons/demo/beta/point.json', `${JSON.stringify({ point: 'beta', name: '前置点', fileBase: 0 }, null, 2)}\n`)
  const META = {
    number: 1, title: '你好，世界', navTitle: '演示 第1课', halo: 'demo', point: 'alpha',
    terms: { a: {}, b: {} }, source: { label: '示例出处', url: 'https://example.com' },
  }
  mk(PACK, 'lessons/src/demo/alpha/0001-hello.html',
    `<!doctype html><html><head><script type="application/json" data-lesson-meta>${JSON.stringify(META)}</script></head><body>src</body></html>`)
  mk(PACK, 'lessons/demo/alpha/0001-hello.html', '<!doctype html><html><body>rendered</body></html>')
  const packFilesNow = step('A02.packFiles', listFiles(PACK))
  packFiles = packFilesNow

  /* ── A03：**直接导出**（不补任何件）───────────────────────────────── */
  beforeSnap = step('A06.before', snapTree(PACK))
  exportResult = step('A03.export', await EXPORT.exportLesson(
    { file: 'demo/alpha/0001-hello.html', outDir: OUT },
    { paths: { packRoot: PACK }, log: {} },
  ))
  afterSnap = step('A06.after', snapTree(PACK))

  if (exportResult.ok) {
    zipList = step('A04.zipList', unzipList(exportResult.zip))
    packJson = step('A05.packJson', JSON.parse(unzipRead(exportResult.zip, 'pack.json', UNZIP)))
    indexJson = step('A05.lessonsJson', JSON.parse(unzipRead(exportResult.zip, 'lessons/lessons.json', UNZIP)))
  }

  /* ── M01 / M03：临时副本上移走必需生成器（必红）→ 还原（必绿）────── */
  // ⚠️ 一律 `force` + 先查存在：产品缺件时（旧行为）这里**不许抛**把整卡带成"前置异常"，
  //    要让它落到各条用例上各自如实红（A02/A03/L02/L04/L06 才是"缺件"该红的地方）。
  fs.cpSync(PACK, MUT, { recursive: true })
  fs.rmSync(path.join(MUT, ...ENGINE_REL.split('/')), { force: true })
  mutResult = step('M01.exportWithoutGenerator', await EXPORT.exportLesson(
    { file: 'demo/alpha/0001-hello.html', outDir: OUT_MUT },
    { paths: { packRoot: MUT }, log: {} },
  ))
  // 还原：把包里那份**原样**放回去（不是从模板补 —— 证明红是"移走"造成的，不是别的）。
  // 包里本来就没有它（旧行为）时，还原这一步没有可还原的对象：如实记 null，由 M03 判红。
  const engineSrc = path.join(PACK, ...ENGINE_REL.split('/'))
  if (fs.existsSync(engineSrc)) {
    mk(MUT, ENGINE_REL, fs.readFileSync(engineSrc).toString('utf8'))
    mutRestored = step('M03.exportAfterRestore', await EXPORT.exportLesson(
      { file: 'demo/alpha/0001-hello.html', outDir: OUT_MUT },
      { paths: { packRoot: MUT }, log: {} },
    ))
  } else {
    obs.steps.push({ name: 'M03.notRestorable', data: `包内没有 ${ENGINE_REL}，这一版产品根本无从还原（旧行为）` })
  }

  /* ── L 组数据：闭包 / 清单 / 源码抽取 / 闸 ────────────────────────── */
  exportClosure = step('L04.exportClosure', ENGINE.engineFiles({ profile: 'export' }))
  readerClosure = step('L05.readerClosure', ENGINE.engineFiles({ profile: 'reader' }))
  packClosure = step('L06.packClosure', ENGINE.engineFiles({ profile: 'pack' }))
  srcRefs = step('L04.srcRefs', extractPackScriptRefs(fs.readFileSync(EXPORT_SRC, 'utf8')))
  readerRefs = step('L05.readerRefs', extractReaderRefs(fs.readFileSync(READER_SRC, 'utf8')))

  // 闸的**反空转**：干净输入必须 [] ；临时模板目录里多一个未登记代码件必须被点名
  gateClean = step('L07.gateClean', ENGINE.requiredButNotRegistered(SCAFFOLD.TEMPLATE_FILES, { templateDir: TEMPLATE }))
  const dirtyTpl = path.join(FIXTURE, 'dirty-template')
  fs.mkdirSync(path.join(dirtyTpl, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(dirtyTpl, 'tools', 'extra-engine.js'), '// 未登记的新引擎件（反空转夹具）\n', 'utf8')
  gateDirty = step('L07.gateDirty', ENGINE.requiredButNotRegistered(SCAFFOLD.TEMPLATE_FILES, { templateDir: dirtyTpl }))
  try { ENGINE.engineFiles({ profile: 'definitely-not-a-profile' }); throwOnBadProfile = false } catch { throwOnBadProfile = true }

  // 抽取器的**反空转**：伪造一份源码，多两处字面量 —— 一条会被"⊆ export 档"抓、一条会被"包里不存在"抓
  const doctored = `${fs.readFileSync(EXPORT_SRC, 'utf8')}
// 反空转夹具（只活在内存里，不落盘到产品代码）
const FAKE_A = path.join('tools', 'build-notes.js')
const FAKE_B = path.join('tools', 'definitely-not-shipped-engine.js')
`
  extractorDirty = step('L08.extractorDirty', extractPackScriptRefs(doctored))

  /* ── M02：快照判据自检（保证 A06 不是恒真）────────────────────────── */
  const probe = path.join(FIXTURE, 'snap-probe')
  fs.mkdirSync(probe, { recursive: true })
  fs.writeFileSync(path.join(probe, 'a.txt'), 'x', 'utf8')
  const s1 = snapTree(probe)
  fs.appendFileSync(path.join(probe, 'a.txt'), 'y', 'utf8')
  const s2 = snapTree(probe)
  obs.steps.push({ name: 'M02.snapshotProbe', data: { s1, s2 } })

  // 证据：原始观测（判词之外还要留"当时到底看到了什么"）
  h.note(`夹具=${FIXTURE}（失败保留 / 成功清理）`)
  h.evidenceJson('observations.json', obs)
  if (zipList) h.evidence('zip-list.txt', `${zipList.join('\n')}\n`)
  if (packFiles) h.evidence('pack-files.txt', `${packFiles.join('\n')}\n`)
  h.evidence('closure-lists.txt', [
    `export 档（${exportClosure.length}）：\n  ${exportClosure.join('\n  ')}`,
    `reader 档（${readerClosure.length}）：\n  ${readerClosure.join('\n  ')}`,
    `pack 档（${packClosure.length}）：\n  ${packClosure.join('\n  ')}`,
    `排除项：${ENGINE.CODE_EXCLUDE.join('、')}`,
    '',
  ].join('\n'))
  h.evidence('source-refs.txt', [
    `lib/pack-export.js 抽出的包内脚本字面量：${srcRefs.scripts.join('、') || '（无 —— 脚本名已收敛到单一名单）'}`,
    `lib/pack-export.js 抽出的闭包档位：${srcRefs.profiles.join('、')}`,
    `lib/pack-model.js 抽出的读取链 require：${readerRefs.join('、')}`,
    '',
    `M01 移走生成器后的导出回执：${JSON.stringify(mutResult)}`,
    `M03 还原之后的导出回执：${mutRestored ? `ok=${mutRestored.ok} name=${mutRestored.name || ''} error=${mutRestored.error || ''}` : '（无从还原：包里本来就没有那一件）'}`,
    '',
  ].join('\n'))
  h.evidence('A03-export-raw.txt', [
    `exportLesson 回执：${JSON.stringify(exportResult)}`,
    `导出的 zip 内容（${(zipList || []).length} 件）：\n  ${(zipList || []).join('\n  ')}`,
    '',
  ].join('\n'))
  h.evidence('L07-L08-antivacuous.txt', [
    `干净输入的闸：${JSON.stringify(gateClean)}`,
    `脏模板（多一个未登记件）的闸：${JSON.stringify(gateDirty)}`,
    `不认识的 profile 抛错？${throwOnBadProfile}`,
    `伪造源码抽出的字面量：${JSON.stringify(extractorDirty.scripts)}`,
    `伪造源码抽出的档位：${JSON.stringify(extractorDirty.profiles)}`,
    '',
  ].join('\n'))
} catch (e) {
  fatal = e && e.stack ? e.stack : String(e)
  h.note(`前置步骤异常：${fatal}`)
  try { h.evidence('fatal.txt', clip(fatal, 8000)) } catch { /* 证据落不下由壳自己报 */ }
}

/** 前置步骤炸了 ⇒ 每条用例都如实红（不许静默变成"跳过"或"通过"） */
const guard = (fn) => () => {
  if (fatal) throw new Error(`前置步骤抛异常（本用例没跑成，不是通过）：${fatal.split('\n')[0]}`)
  return fn()
}

/* ── ① 行为锚（A）─────────────────────────────────────────────────────── */

h.case('A01', 'pass', guard(() => {
  h.assert(scaffolded.ok === true, `writeScaffold 建空包必须成功（实得 ok=${scaffolded.ok} error=${scaffolded.error || ''}）`)
  const expect = SCAFFOLD.TEMPLATE_FILES.length + 11
  h.eq(scaffolded.created.length, expect, `建出来的文件数 = 模板 ${SCAFFOLD.TEMPLATE_FILES.length} + 骨架 11`)
  h.eq(new Set(scaffolded.created).size, scaffolded.created.length, '建包清单里不许有重复')
}))

h.case('A02', 'pass', guard(() => {
  h.assert(scaffolded.created.includes(ENGINE_REL), `导出必需的那一件必须是 **writeScaffold 铺进去的**（created 里要有 ${ENGINE_REL}）`)
  const inPack = path.join(PACK, ...ENGINE_REL.split('/'))
  const inTpl = path.join(SCAFFOLD.TEMPLATE_DIR, ...ENGINE_REL.split('/'))
  h.assert(fs.existsSync(inPack), `新包里必须真有 ${ENGINE_REL}`)
  h.assert(fs.readFileSync(inPack).equals(fs.readFileSync(inTpl)), `${ENGINE_REL} 必须与插件模板**逐字节相同**`)
  // 「测试禁止额外拷补引擎件」的机器判据：包内文件 = 建包清单 + 本夹具那 5 个课程件（一件都不多）
  h.eq(packFiles.length, scaffolded.created.length + LESSON_FILES.length,
    `包内文件数 = 建包清单 ${scaffolded.created.length} + 夹具课程件 ${LESSON_FILES.length}（多出来的就是手工补件）`)
  for (const rel of LESSON_FILES) h.assert(packFiles.includes(rel), `夹具课程件要在包里：${rel}`)
}))

h.case('A03', 'pass', guard(() => {
  h.assert(exportResult.ok === true,
    `只用 writeScaffold 建包 + 加最小课程后必须**直接导出成功**（实得 ok=${exportResult.ok} error=${exportResult.error || ''}）`)
  h.assert(fs.existsSync(exportResult.zip) && exportResult.bytes > 0, 'zip 真落在磁盘上且非空')
  h.eq(exportResult.circle, 'demo', 'zip 回执里圆圈对得上')
  h.eq(exportResult.point, 'alpha', 'zip 回执里知识点对得上')
}))

h.case('A04', 'pass', guard(() => {
  h.assert(Array.isArray(zipList), 'A03 没导出成功 ⇒ 没有 zip 可解（缺件该红的地方就是这里）')
  const want = [
    'lessons/demo/alpha/0001-hello.html',
    'lessons/demo/alpha/point.json',
    'lessons/demo/beta/point.json',        // 前置的**结构**随包走
    'lessons/demo/halo.json',
    'lessons/lessons.json',
    'pack.json',
  ]
  h.eq(zipList.length, want.length, `zip 里恰好 ${want.length} 个文件（实得 ${zipList.join(' / ')}）`)
  for (const w of want) h.assert(zipList.includes(w), `zip 里必须有 ${w}`)
  const leak = zipList.filter((p) => p.includes('/src/') || p.startsWith('assets/') || p.startsWith('starmap/'))
  h.eq(leak.join('、'), '', `包里不许有 src/assets/starmap（那些由离线阅读器的包骨架提供，实得漏 ${leak.length} 项）`)
}))

h.case('A05', 'pass', guard(() => {
  h.assert(!!packJson && !!indexJson, 'A03 没导出成功 ⇒ 没有 pack.json / lessons.json 可核')
  h.eq(packJson.id, 'demo/alpha', 'pack.json 的层级 id = <圈>/<点>')
  h.eq(packJson.circle, 'demo', 'pack.json 带 circle')
  h.eq(packJson.point, 'alpha', 'pack.json 带 point')
  h.eq(packJson.lesson && packJson.lesson.number, 1, 'pack.json 带这一课的号')
  h.eq(packJson.lesson && packJson.lesson.title, '你好，世界', 'pack.json 带这一课的标题')
  h.eq(JSON.stringify(packJson.prereqs || []), JSON.stringify(['demo/beta']), '前置链记进 pack.json，且缺失的那条（ghost）跳过')
  h.eq(indexJson.lessons.length, 1, '单课清单只有 1 条')
  h.eq(indexJson.lessons[0].rel, 'demo/alpha/0001-hello.html', '清单条目的 rel 对得上')
  h.eq(indexJson.lessons[0].halo, 'demo', '清单条目带 halo')
  h.eq(indexJson.lessons[0].point, 'alpha', '清单条目带 point')
  h.eq(indexJson.lessons[0].slug, 'hello', '清单条目带 slug（从源文件名派生）')
  h.eq(indexJson.source, 'lessons/src', '清单声明它的来源是 lessons/src')
}))

h.case('A06', 'pass', guard(() => {
  h.eq(afterSnap, beforeSnap, '导出前后源包内每个文件 path+size+mtime **全同**（导出是纯读）')
  h.assert(beforeSnap.split('\n').length === packFiles.length, `快照覆盖整棵树（${packFiles.length} 个文件）`)
}))

/* ── ② 闭包登记（L）───────────────────────────────────────────────────── */

h.case('L01', 'pass', guard(() => {
  const a = [...SCAFFOLD.TEMPLATE_FILES].sort()
  const b = [...RULES.templatePaths()].sort()
  h.eq(a.join('\n'), b.join('\n'), `运行时清单（TEMPLATE_FILES）与规则清单（templatePaths）必须成对一致（各 ${a.length} 项）`)
  h.eq(new Set(SCAFFOLD.TEMPLATE_FILES).size, SCAFFOLD.TEMPLATE_FILES.length, 'TEMPLATE_FILES 里不许有重复项')
  h.eq(new Set(RULES.templatePaths()).size, RULES.templatePaths().length, 'templatePaths() 里不许有重复项')
}))

h.case('L02', 'pass', guard(() => {
  h.eq(SCAFFOLD.TEMPLATE_FILES.filter((r) => r === ENGINE_REL).length, 1, `TEMPLATE_FILES 里 ${ENGINE_REL} 恰好一行`)
  h.eq(RULES.templatePaths().filter((r) => r === ENGINE_REL).length, 1, `templatePaths() 里 ${ENGINE_REL} 恰好一行（成对）`)
  h.assert(RULES.FROM_PACK.includes(ENGINE_REL), `它必须登记在 FROM_PACK（那条"模板 == 课程包原件经中性化"的成对判据要认它）`)
  h.eq(RULES.FROM_PLUGIN.includes(ENGINE_REL), false, '它是课程包原件派生的件，不该被塞进 FROM_PLUGIN')
  h.assert(exportClosure.includes(ENGINE_REL), `export 档闭包里必须有 ${ENGINE_REL}`)
  // 「测试禁止额外拷补引擎件」：夹具自己不许再补件（只看**代码行**：注释里说明历史不算）
  const testSrc = fs.readFileSync(EXPORT_TEST_SRC, 'utf8')
  const testCode = testSrc.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  h.assert(/writeScaffold\(/.test(testCode), 'export-pack 夹具必须用产品自己的 writeScaffold 建包')
  h.eq(/copyFileSync|pack-template/.test(testCode), false,
    'export-pack 夹具里不许再出现"手工拷补引擎件"的写法（copyFileSync / lib/pack-template）')
}))

h.case('L03', 'pass', guard(() => {
  const missing = SCAFFOLD.TEMPLATE_FILES.filter((f) => !fs.existsSync(path.join(SCAFFOLD.TEMPLATE_DIR, ...f.split('/'))))
  h.eq(missing.join('、'), '', `清单里每一件都必须在模板目录里真的存在（实得缺 ${missing.join('、') || '无'}）`)
  h.assert(fs.existsSync(path.join(SCAFFOLD.TEMPLATE_DIR, ...ENGINE_REL.split('/'))), `新登记的那件也必须在盘上：${ENGINE_REL}`)
}))

h.case('L04', 'pass', guard(() => {
  // —— 独立必需件预期锚：**从消费者源码抽**，不是从任何一张清单表读 ——
  h.assert(srcRefs.scripts.length + srcRefs.profiles.length > 0, '抽取必须真的抓到引用（抽不到 = 判据恒真，必须红）')
  h.eq(srcRefs.profiles.join('、'), 'export', 'lib/pack-export.js 只许消费 export 档闭包（多余的档位 = 有人绕过单一名单）')
  h.assert(exportClosure.length > 0, 'export 档闭包不许是空的')
  const inPack = (rel) => fs.existsSync(path.join(PACK, ...rel.split('/')))
  for (const rel of [...new Set([...exportClosure, ...srcRefs.scripts])]) {
    h.assert(SCAFFOLD.TEMPLATE_FILES.includes(rel), `导出要的件必须登记进随包清单：${rel}`)
    h.assert(inPack(rel), `导出要的件必须在**只用 writeScaffold 建出来的包**里：${rel}`)
    h.assert(fs.readFileSync(path.join(PACK, ...rel.split('/'))).equals(fs.readFileSync(path.join(SCAFFOLD.TEMPLATE_DIR, ...rel.split('/')))),
      `包内那份必须与插件模板逐字节相同：${rel}`)
  }
  // 源码里如果还留着**写死的**脚本名，也必须落在同一份闭包里（不许有第二条暗路）
  for (const rel of srcRefs.scripts) h.assert(exportClosure.includes(rel), `源码里写死的包内脚本必须落在 export 档里：${rel}`)
}))

h.case('L05', 'pass', guard(() => {
  h.assert(readerRefs.length > 0, 'lib/pack-model.js 的读取链抽取必须真的抓到东西（抽不到 = 判据恒真）')
  for (const rel of readerRefs) {
    h.assert(readerClosure.includes(rel), `读取链要的件必须在 reader 档里：${rel}`)
    h.assert(SCAFFOLD.TEMPLATE_FILES.includes(rel), `读取链要的件必须随包发（否则新包一读就 Cannot find module）：${rel}`)
    h.assert(fs.existsSync(path.join(SCAFFOLD.TEMPLATE_DIR, ...rel.split('/'))), `读取链要的件必须在模板目录里：${rel}`)
  }
  for (const rel of readerClosure) h.assert(SCAFFOLD.TEMPLATE_FILES.includes(rel), `reader 档里的每一件都要随包发：${rel}`)
}))

h.case('L06', 'pass', guard(() => {
  h.assert(packClosure.length > 0, 'pack 档闭包不许是空的（抽不到 = 闸恒真）')
  const unregistered = packClosure.filter((rel) => !SCAFFOLD.TEMPLATE_FILES.includes(rel))
  h.eq(unregistered.join('、'), '',
    `模板目录里所有代码件（减排除项）都必须在随包清单里 —— 少一件就是 D06 那个缺口（实得缺 ${unregistered.join('、') || '无'}）`)
  // 排除表不许烂掉、也不许用来藏一件已登记的件
  for (const rel of ENGINE.CODE_EXCLUDE) {
    h.assert(fs.existsSync(path.join(SCAFFOLD.TEMPLATE_DIR, ...rel.split('/'))), `排除项必须在模板里真的存在（排除表不许烂）：${rel}`)
    h.eq(SCAFFOLD.TEMPLATE_FILES.includes(rel), false, `排除项不许出现在随包清单里（排除表不许藏已登记的件）：${rel}`)
  }
  // 闸真的**接了线**：planScaffold 走的是同一条判据（不是只在测试里有一套）
  const scaffoldSrc = fs.readFileSync(SCAFFOLD_SRC, 'utf8')
  h.assert(/requiredButNotRegistered\s*\(/.test(scaffoldSrc), 'lib/pack-scaffold.js#planScaffold 必须真的调用这条闸')
  h.assert(/engine-files\.cjs/.test(scaffoldSrc), '闸的清单来源必须是 lib/pack-template/tools/engine-files.cjs（单一名单）')
}))

h.case('L07', 'pass', guard(() => {
  h.eq(gateClean.join('、'), '', `干净输入的闸必须返回空（实得 ${gateClean.join('、') || '空'}）`)
  h.assert(gateDirty.includes('tools/extra-engine.js'), `临时模板目录里多一个未登记代码件 ⇒ 闸必须点名它（实得 ${JSON.stringify(gateDirty)}）`)
  h.eq(throwOnBadProfile, true, '不认识的 profile 必须当场抛（静默回落会把闸变成恒真的）')
}))

h.case('L08', 'pass', guard(() => {
  h.assert(extractorDirty.scripts.includes('tools/build-notes.js'),
    `抽取器要能抓到源码里新写死的脚本名（实得 ${JSON.stringify(extractorDirty.scripts)}）`)
  h.assert(extractorDirty.scripts.includes('tools/definitely-not-shipped-engine.js'), '抽取器要能抓到第二处字面量')
  // 两条规则各自都能把它抓住：一条靠"不在 export 档里"，一条靠"包里没有"
  h.eq(exportClosure.includes('tools/build-notes.js'), false, '字面量若不在 export 档里 ⇒ 必须被判出来（这条规则不是恒真）')
  h.eq(fs.existsSync(path.join(PACK, 'tools', 'definitely-not-shipped-engine.js')), false, '字面量若在包里不存在 ⇒ 必须被判出来（这条规则不是恒真）')
}))

/* ── ③ 反空转（M）────────────────────────────────────────────────────── */

h.case('M01', 'pass', guard(() => {
  h.eq(mutResult.ok, false, '**反空转**：临时副本移走导出必需生成器 ⇒ 导出必须红（旧缺口正是这个形状）')
  h.assert(/build-lessons-index\.js/.test(String(mutResult.error || '')),
    `拒绝时必须点名缺哪一件（实得：${mutResult.error}）`)
  h.assert(fs.existsSync(path.join(PACK, ...ENGINE_REL.split('/'))), '源包自己那件**不许**被这个变异动过')
}))

h.case('M02', 'pass', guard(() => {
  const p = obs.steps.find((s) => s.name === 'M02.snapshotProbe')
  h.assert(!!p, '快照自检的观测必须在（否则这条用例没在判东西）')
  h.eq(p.data.s1.split('|').length, 3, '快照每行必须是 path|size|mtime 三段')
  h.assert(p.data.s1 !== p.data.s2, '改一个字节之后快照必须变（否则 A06「导出纯读」是恒真的）')
}))

h.case('M03', 'pass', guard(() => {
  h.assert(!!mutRestored, `包里本来就没有 ${ENGINE_REL}（旧行为）⇒ 无从还原 —— 这一条必须红`)
  h.assert(mutRestored.ok === true, `**还原后必绿**：把生成器放回去 ⇒ 导出再次成功（实得 ok=${mutRestored.ok} error=${mutRestored.error || ''}）`)
  h.assert(fs.existsSync(mutRestored.zip), '还原后的那次导出也要真的落下 zip')
}))

/* ── 收尾：清夹具（先核实绝对路径属于本次夹具；失败则留下）────────────── */

{
  const verdict = h.evaluate()
  if (verdict.failed === 0 && !fatal) {
    const abs = path.resolve(FIXTURE)
    const inside = abs.startsWith(path.resolve(BASE) + path.sep) && path.basename(abs).startsWith('whale-T18-')
    if (inside) fs.rmSync(abs, { recursive: true, force: true })
    else h.note(`拒绝清理：${abs} 不属于本次夹具`)
  } else {
    h.note(`夹具保留（有红/异常，便于诊断）：${FIXTURE}`)
  }
}

process.exit(h.run())
