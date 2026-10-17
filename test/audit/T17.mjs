/**
 * test/audit/T17.mjs — 常驻渲染读取最新台账（卡 T17 / 报告 C03 P2）
 * ------------------------------------------------------------------
 * 病（旧行为，报告 C03：`lib/render-inputs.js#L54-L67`）：
 *   插件侧的 `loadDataFiles()` 用 `createRequire(...)` 直接 require 三个文件，而 **require 有模块缓存**
 *   —— 同一个常驻进程里，学生/老师增、改、删了 `assets/glossary-data.js` 或
 *   `assets/questions-data.js` 之后，下一次构建**读到的还是第一次那份旧对象**：
 *   产物里的名词计数、术语标签、答疑计数全是旧的（注释里还写着"这是原版行为，保留"）。
 *   包侧 `lib/pack-template/tools/build-lessons.js` 同一份逻辑（同一病、同一口径）。
 *
 * 卡面验收判据（**原文**）：
 *   「同一进程依次增/改/删术语和答疑，再构建两次，输出必须反映最新输入并在第二次稳定；不只测新进程。」
 * 卡面补充：逐次核正文、计数和术语索引；第二次文件字节及 mtime 稳定；**加载失败如实抛错，
 *   不复用旧成功结果掩盖坏账**。
 *
 * 本文件判的（固定用例 ID 全集，**不许漂移**；每条都必须**能失败**）：
 *   A01/A02 增：术语 +1 / 答疑 +1 ⇒ 产物正文（术语标签）、计数、术语索引同时反映
 *   B01/B02 改：术语 label 改 / 答疑状态改 ⇒ 产物反映**新**值（不是旧值）
 *   C01/C02 删：术语删 / 答疑删 ⇒ 产物**不含**它（计数与正文一起退）
 *   D01/D02 第二次稳定：输入不变 → 两次 planBuild 逐字节相同；writePlan 第二次 written=[]、
 *           **文件 mtime 不变**（把 mtime 先钉到一个固定过去时刻再验 —— 重写必被抓）
 *   E01/E02/E03 坏数据如实抛错：数据文件写成坏 JS / 直接删掉 ⇒ 构建**抛**，绝不回退上次成功的对象
 *   F01 不是全局清扫：强制一次数据失效（计数真的变了，反空转）之后，**无关的模块键**与
 *       执行代码（shape-render.js）的键必须都还在 `require.cache` 里
 *   F02 代码/数据缓存分开：数据失效不牵连执行代码（同一份 shape 模块对象）；数据没变时复用
 *       同一份数据对象，变了则必须是**新**对象
 *   G01 `questions-data.js` 缺失的**既有守卫**一字不改：warnings + 空 pages，不抛
 *   H01 包侧同一口径：同一个进程里跑两次包侧构建（只重载执行入口、**不动数据键**）
 *       ⇒ 第二次必须读到改盘后的新术语（旧行为：读到缓存里的旧对象，甚至因 hintTerm 登记不上而抛错）
 *   H02 包侧也不是全局清扫（无关模块键在）
 *   H03 两侧**口径一致**（源码级）：都按 resolved 键删单键、都按 mtimeMs/size/ino 判新鲜、
 *       都没做全局清扫、执行代码都不走数据加载器
 *   I01 夹具自检：自建临时课程包（E:/Temp），活包一个字节都没碰；原始观测落盘
 *
 * 铁律：夹具全在 `E:/Temp/whale-T17-*`；**绝不写** `E:\workplace\study`；
 *   变异只改临时副本（本文件跑完自检：见 `audit-evidence/T17/old-behavior-*.txt`）。
 * 一行判词：`PASS T17 checks=18 failed=0 skipped=0`（失败 exit1 / 缺料 exit2）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHarness, clip } from './harness.mjs'
import { readRenderInputs, planBuild, writePlan, diffPlan } from '../../lib/render-inputs.js'

/** 固定用例 ID 全集（缺一条、多一条、重一条都算失败） */
const IDS = [
  'A01', 'A02',
  'B01', 'B02',
  'C01', 'C02',
  'D01', 'D02',
  'E01', 'E02', 'E03',
  'F01', 'F02',
  'G01',
  'H01', 'H02', 'H03',
  'I01',
]

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const TEMPLATE = path.join(REPO, 'lib', 'pack-template')
const TMP_BASE = 'E:/Temp'
const LIVE_PACK = 'E:/workplace/study'          // 用户活包：只读提及，绝不写

fs.mkdirSync(TMP_BASE, { recursive: true })
const FIXTURE = fs.mkdtempSync(path.join(TMP_BASE, 'whale-T17-'))
const PLUGIN_PACK = path.join(FIXTURE, 'plugin-pack')     // 最小自建课程包（判插件侧）
const PACK_PACK = path.join(FIXTURE, 'pack-pack')         // 模板逐字节副本（判包侧 CLI）
const DRIVER = path.join(FIXTURE, 'driver.cjs')
const DRIVER_OUT = path.join(FIXTURE, 'driver-out.json')

const HALO = 't17fx'                 // 夹具专属圆圈 id（活包里绝不会有这个名字）
const POINT = 'point1'
const LESSON_LABEL = '演示 第1课'      // point.json 的 label『演示』+ 显示号 1
const PAGE_REL = `lessons/${HALO}/${POINT}/0001-first.html`
const SRC_REL = `lessons/src/${HALO}/${POINT}/0001-first.html`
const BODY_MARK = 'FIXTURE-BODY 正文乙'

/* ── 夹具素材（数据源与源文件都是**现场写出来的小样本**）──────────────────── */

/** 一条术语（形状照 glossary-data.js：渲染侧只认 label，其余字段留着像真的） */
const term = (label) => ({ label, category: 'fixture', official: label, short: label, lesson: `${POINT}/0001` })

/** 数据文件（CJS）—— 与 `assets/glossary-data.js` 同一形状 */
const glossaryJs = (entries) => `module.exports = ${JSON.stringify(entries, null, 2)}\n`
const questionsJs = (entries) => `module.exports = ${JSON.stringify(entries, null, 2)}\n`

/** 一节课的作者态源文件（只写本卡用得到的两段：objective / body） */
function sourceHtml(hintTerm) {
  const meta = {
    title: 'T17 夹具第一课',
    number: 1,
    navTitle: '夹具第一课',
    hintTerm,
    source: { label: 'T17 夹具出处', url: 'https://example.com/t17' },
  }
  return [
    '<script type="application/json" data-lesson-meta>',
    JSON.stringify(meta, null, 2),
    '</script>',
    '',
    '<!--@objective-->',
    '<p>FIXTURE-OBJECTIVE 目标甲</p>',
    '<!--/@objective-->',
    '',
    '<!--@body-->',
    `<p>${BODY_MARK}</p>`,
    '<!--/@body-->',
    '',
  ].join('\n')
}

const pointJson = () => JSON.stringify({ point: POINT, name: '演示点', fileBase: 0, label: '演示' }, null, 2) + '\n'
const haloJson = () => JSON.stringify({ halo: HALO, name: 'T17 夹具圈', color: '#7ec8ff', inside: [], outside: [] }, null, 2) + '\n'

/** 初始台账：两个术语 + 一条已解答的答疑 */
const INIT_GLOSSARY = () => ({ alpha: term('甲术语'), beta: term('乙术语') })
const INIT_QUESTIONS = () => ({
  '0001': {
    lesson: LESSON_LABEL,
    page: PAGE_REL,
    title: '第1课',
    question: '夹具问题',
    status: 'answered',
    answerHtml: '<p>夹具答案</p>',
  },
})

/** 把课程包的「内容件」铺进一个根目录（halo/point/src/两个数据文件） */
function layContent(root, { glossary, questions, hintTerm }) {
  const w = (rel, text) => {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf8')
  }
  w(`lessons/${HALO}/halo.json`, haloJson())
  w(`lessons/${HALO}/${POINT}/point.json`, pointJson())
  w(SRC_REL, sourceHtml(hintTerm))
  w('assets/glossary-data.js', glossaryJs(glossary))
  w('assets/questions-data.js', questionsJs(questions))
}

/** 插件侧夹具：只放渲染真正要读的东西（frame / 两个数据文件 / 执行代码 / 内容件） */
function layPluginPack() {
  for (const d of ['assets', 'tools']) fs.mkdirSync(path.join(PLUGIN_PACK, d), { recursive: true })
  fs.copyFileSync(path.join(TEMPLATE, 'assets', '_frame.html'), path.join(PLUGIN_PACK, 'assets', '_frame.html'))
  fs.copyFileSync(path.join(TEMPLATE, 'tools', 'shape-render.js'), path.join(PLUGIN_PACK, 'tools', 'shape-render.js'))
  // 无关模块（F01 的探针：全局清扫会把它一起删掉）
  fs.writeFileSync(path.join(PLUGIN_PACK, 'tools', 'sentinel.js'), "module.exports = { mark: 'T17-SENTINEL' }\n", 'utf8')
  layContent(PLUGIN_PACK, { glossary: INIT_GLOSSARY(), questions: INIT_QUESTIONS(), hintTerm: 'alpha' })
}

/** 包侧夹具：模板**逐字节副本**（引擎闭包齐全，真能跑 `node tools/build-lessons.js`）+ 内容件 */
function layPackPack() {
  fs.cpSync(TEMPLATE, PACK_PACK, { recursive: true })
  fs.writeFileSync(path.join(PACK_PACK, 'tools', 'sentinel.js'), "module.exports = { mark: 'T17-SENTINEL' }\n", 'utf8')
  layContent(PACK_PACK, { glossary: INIT_GLOSSARY(), questions: INIT_QUESTIONS(), hintTerm: 'alpha' })
}

/* ── 读产物的小工具（判据只认**产物里的真实标记**，不认"是不是报了成功"）────── */

const grab = (html, re) => { const m = re.exec(html); return m ? m[1] : null }

/** 从渲染出来的课程页里量四样：名词总数 / 本课术语（key+标签）/ 答疑数 / 正文在不在 */
function measure(html) {
  return {
    lessonLabel: grab(html, /data-ask-lesson="([^"]*)"/),
    termCount: Number(grab(html, /全部 (\d+) 个名词（含前面课程内容）/)),
    hintTerm: grab(html, /data-term="([^"]*)"/),
    hintLabel: grab(html, /data-term="[^"]*">([^<]*)</),
    qaCount: Number(grab(html, /data-qa-count="(\d+)"/)),
    body: html.includes(BODY_MARK),
    objective: html.includes('FIXTURE-OBJECTIVE'),
    bytes: html.length,
  }
}

/** 取一个构建计划里那**唯一**一页的正文（多一页少一页都要说清） */
function pageOf(plan, h, tag) {
  h.eq(plan.files.length, 1, `${tag}：夹具只有一页（实得 ${plan.files.map((f) => f.path).join(', ') || '空'}）`)
  h.eq(plan.files[0].path, PAGE_REL, `${tag}：产出的就是那一页`)
  return plan.files[0].content
}

const build = (root) => planBuild(root, {})
const measureBuild = (root, h, tag) => measure(pageOf(build(root), h, tag))

/* ── 夹具当前状态（跟着磁盘一起走，供用例回滚/断言用）────────────────────── */
const state = {
  glossary: INIT_GLOSSARY(),      // 与 PLUGIN_PACK 磁盘上那份同步
  questions: INIT_QUESTIONS(),
  hintTerm: 'alpha',
  observed: { measures: [], steps: [] },
}
function writeGlossary(next) {
  state.glossary = next
  fs.writeFileSync(path.join(PLUGIN_PACK, 'assets', 'glossary-data.js'), glossaryJs(next), 'utf8')
}
function writeQuestions(next) {
  state.questions = next
  fs.writeFileSync(path.join(PLUGIN_PACK, 'assets', 'questions-data.js'), questionsJs(next), 'utf8')
}
function writeHintTerm(termKey) {
  state.hintTerm = termKey
  fs.writeFileSync(path.join(PLUGIN_PACK, ...SRC_REL.split('/')), sourceHtml(termKey), 'utf8')
}
const note = (tag, m) => state.observed.measures.push({ tag, ...m })

/* ── 包侧驱动脚本：**同一个进程**里跑两次包侧构建（只重载执行入口，不动数据键）──
   为什么必须"同一个进程"：包侧 CLI 每次新起进程天然会重读盘（那样测不出缓存病）。
   把 `tools/build-lessons.js` 这一个键从 require.cache 里删掉再 require，
   数据文件的键**一个都不动** —— 旧行为下第二次构建就会吃到第一次的旧数据对象。 */
function writeDriver() {
  const js = `'use strict';
const fs = require('fs');
const path = require('path');
const PACK = ${JSON.stringify(PACK_PACK.replace(/\\/g, '/'))};
const OUT = ${JSON.stringify(DRIVER_OUT.replace(/\\/g, '/'))};
const rec = { pack: PACK, steps: [] };
const pageFile = () => path.join(PACK, 'lessons', '${HALO}', '${POINT}', '0001-first.html');
const grab = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };
function measure() {
  const html = fs.readFileSync(pageFile(), 'utf8');
  return {
    termCount: Number(grab(html, /全部 (\\d+) 个名词（含前面课程内容）/)),
    hintTerm: grab(html, /data-term="([^"]*)"/),
    hintLabel: grab(html, /data-term="[^"]*">([^<]*)</),
    qaCount: Number(grab(html, /data-qa-count="(\\d+)"/)),
    body: html.includes(${JSON.stringify(BODY_MARK)}),
    bytes: html.length,
  };
}
const SENT = path.join(PACK, 'tools', 'sentinel.js');
const BL = path.join(PACK, 'tools', 'build-lessons.js');
const GL = path.join(PACK, 'assets', 'glossary-data.js');
const SRC = path.join(PACK, 'lessons', 'src', '${HALO}', '${POINT}', '0001-first.html');
const sentinelKey = require.resolve(SENT);
const glKey = require.resolve(GL);
require(SENT);
rec.sentinelKey = sentinelKey;
rec.sentinelBefore = sentinelKey in require.cache;
rec.blKey = require.resolve(BL);
try {
  require(BL);                       // 第一次构建（初始台账）
  rec.run1 = measure();
  rec.steps.push({ at: 'run1', termCount: rec.run1.termCount, hintTerm: rec.run1.hintTerm });

  // —— 改盘：术语 +1，并把这节课的 hintTerm 指到新术语（源文件本来就不进模块缓存）——
  fs.writeFileSync(GL, ${JSON.stringify(glossaryJs({ alpha: term('甲术语'), beta: term('乙术语'), gamma: term('丙术语') }))}, 'utf8');
  fs.writeFileSync(SRC, ${JSON.stringify(sourceHtml('gamma'))}, 'utf8');

  delete require.cache[rec.blKey];   // 只重载「执行入口」；数据键一个都不动
  require(BL);                       // 第二次构建（**同一进程**）
  rec.run2 = measure();
  rec.steps.push({ at: 'run2', termCount: rec.run2.termCount, hintTerm: rec.run2.hintTerm });
} catch (e) {
  rec.error = (e && e.stack) ? e.stack : String(e);
} finally {
  // ⚠️ 这两个探针放 finally：H01 红的时候 H02 仍然要能独立判（一条红不许把后一条顶成假红）
  rec.sentinelAfter = sentinelKey in require.cache;
  rec.glKeyInCache = glKey in require.cache;
}
fs.writeFileSync(OUT, JSON.stringify(rec, null, 2), 'utf8');
`
  fs.writeFileSync(DRIVER, js, 'utf8')
}

/* ── 起夹具 ─────────────────────────────────────────────────────────────── */
layPluginPack()
layPackPack()
writeDriver()

const h = createHarness({
  card: 'T17',
  expectedIds: IDS,
  argv: process.argv.slice(2),
  root: PLUGIN_PACK,
})

const GLOSSARY_PATH = path.join(PLUGIN_PACK, 'assets', 'glossary-data.js')
const QUESTIONS_PATH = path.join(PLUGIN_PACK, 'assets', 'questions-data.js')
const SHAPE_PATH = path.join(PLUGIN_PACK, 'tools', 'shape-render.js')
const SHAPE_ORIG = fs.readFileSync(SHAPE_PATH)

/* ══════════════════════ A：增 ══════════════════════ */

h.case('A01', 'pass', () => {
  // 基础状态自检：这条不成立的话，后面「增了以后不一样」是白得的
  const before = measureBuild(PLUGIN_PACK, h, 'A01 增之前')
  h.eq(before.termCount, 2, 'A01 增之前：名词总数 2')
  h.eq(before.hintTerm, 'alpha', 'A01 增之前：本课术语是 alpha')
  h.eq(before.hintLabel, '甲术语', 'A01 增之前：术语标签是「甲术语」')
  note('A01-before', before)

  // **增**：往 glossary-data.js 加一条 gamma，并把这节课的 hintTerm 指到它（源文件不进模块缓存）
  writeGlossary({ ...state.glossary, gamma: term('丙术语') })
  writeHintTerm('gamma')

  const after = measureBuild(PLUGIN_PACK, h, 'A01 增之后')
  note('A01-after', after)
  h.eq(after.termCount, 3, 'A01 增一条术语 ⇒ 产物里的名词总数必须是 3（旧行为：require 缓存 → 仍是 2）')
  h.eq(after.hintTerm, 'gamma', 'A01 产物正文里的 data-term 必须是新术语的 key')
  h.eq(after.hintLabel, '丙术语', 'A01 产物正文里必须打出新术语的 label（术语索引认它）')
  h.eq(after.body, true, 'A01 正文那一段还在（整条渲染链真的跑了）')

  // 术语索引（glossaryIndex.labelToKey / termCount）也要反映最新输入
  const ctx = readRenderInputs(PLUGIN_PACK, {})
  h.eq(ctx.glossaryIndex.termCount, 3, 'A01 glossaryIndex.termCount 跟着变')
  h.eq(ctx.glossaryIndex.labelToKey['丙术语'], 'gamma', 'A01 术语索引里 label「丙术语」→ key「gamma」')
  return 'pass'
})

h.case('A02', 'pass', () => {
  // **增**：往 questions-data.js 加一条已解答的答疑
  const before = measureBuild(PLUGIN_PACK, h, 'A02 增之前')
  h.eq(before.qaCount, 1, 'A02 增之前：答疑计数 1')
  writeQuestions({
    ...state.questions,
    '0002': { ...state.questions['0001'], question: '夹具问题二', answerHtml: '<p>夹具答案二</p>' },
  })
  const after = measureBuild(PLUGIN_PACK, h, 'A02 增之后')
  note('A02-after', after)
  h.eq(after.qaCount, 2, 'A02 增一条已解答答疑 ⇒ 产物里的答疑计数必须是 2（旧行为：仍是 1）')
  h.eq(after.termCount, 3, 'A02 术语那条改动仍在（互不干扰）')
  return 'pass'
})

/* ══════════════════════ B：改 ══════════════════════ */

h.case('B01', 'pass', () => {
  // **改**：改两条术语的 label（一条是正文里看得见的 hintTerm，一条只能从术语索引查）
  writeGlossary({
    ...state.glossary,
    alpha: term('甲术语改'),
    gamma: term('丙术语（订正）'),
  })
  const after = measureBuild(PLUGIN_PACK, h, 'B01 改之后')
  note('B01-after', after)
  h.eq(after.hintLabel, '丙术语（订正）', 'B01 改了 label ⇒ 产物必须打**新**标签（旧行为：旧标签）')
  h.eq(after.termCount, 3, 'B01 只是改值、总数不变')
  const ctx = readRenderInputs(PLUGIN_PACK, {})
  h.eq(ctx.glossaryIndex.labelToKey['甲术语改'], 'alpha', 'B01 术语索引里的新 label 生效')
  h.eq(ctx.glossaryIndex.labelToKey['甲术语'], undefined, 'B01 术语索引里的**旧** label 必须消失')
  return 'pass'
})

h.case('B02', 'pass', () => {
  // **改**：答疑从「已解答」改成「待答」⇒ 计数必须减
  const before = measureBuild(PLUGIN_PACK, h, 'B02 改之前')
  h.eq(before.qaCount, 2, 'B02 改之前：答疑计数 2')
  writeQuestions({ ...state.questions, '0001': { ...state.questions['0001'], status: 'pending' } })
  const after = measureBuild(PLUGIN_PACK, h, 'B02 改之后')
  note('B02-after', after)
  h.eq(after.qaCount, 1, 'B02 把一条答疑改成待答 ⇒ 产物答疑计数必须是 1（旧行为：仍是 2）')
  return 'pass'
})

/* ══════════════════════ C：删 ══════════════════════ */

h.case('C01', 'pass', () => {
  // **删**：删掉 gamma（hintTerm 不能指向没登记的术语 —— 那是既有契约，所以同时把 hintTerm 退回 alpha）
  const g = { ...state.glossary }
  delete g.gamma
  writeGlossary(g)
  writeHintTerm('alpha')
  const after = measureBuild(PLUGIN_PACK, h, 'C01 删之后')
  note('C01-after', after)
  h.eq(after.termCount, 2, 'C01 删一条术语 ⇒ 产物名词总数必须是 2（旧行为：缓存里还是 3）')
  h.eq(after.hintTerm, 'alpha', 'C01 本课术语回到 alpha')
  h.eq(after.hintLabel, '甲术语改', 'C01 B01 那次改的 label 仍在（删 gamma 没把它带回去）')
  h.eq(after.hintLabel.includes('丙术语'), false, 'C01 产物里**不含**被删掉的「丙术语」')
  const ctx = readRenderInputs(PLUGIN_PACK, {})
  h.eq(ctx.glossaryIndex.glossary.gamma, undefined, 'C01 术语索引里 gamma 没了')
  h.eq(ctx.glossaryIndex.termCount, 2, 'C01 术语索引的计数同步退回去')
  return 'pass'
})

h.case('C02', 'pass', () => {
  // **删**：删掉 0002
  const q = { ...state.questions }
  delete q['0002']
  writeQuestions(q)
  const after = measureBuild(PLUGIN_PACK, h, 'C02 删之后')
  note('C02-after', after)
  h.eq(after.qaCount, 0, 'C02 删掉 0002 之后只剩一条「待答」⇒ 产物答疑计数必须是 0（旧行为：仍是 1）')
  return 'pass'
})

/* ══════════════════════ D：第二次稳定 ══════════════════════ */

h.case('D01', 'pass', () => {
  const p1 = build(PLUGIN_PACK)
  const p2 = build(PLUGIN_PACK)     // 输入一个字节都没动
  h.eq(JSON.stringify(p2), JSON.stringify(p1), 'D01 输入不变：两次 planBuild 结果**逐字相同**（含警告）')
  h.assert(p1.files.length > 0, 'D01 不是空转（至少一页）')
  for (const f of p1.files) {
    const again = p2.files.find((x) => x.path === f.path)
    h.eq(again && again.content, f.content, `D01 ${f.path} 两次字节相同`)
    h.assert(f.path.startsWith('lessons/'), `D01 只产出 lessons/**（${f.path}）`)
  }
  note('D01', { files: p1.files.length, warnings: p1.warnings.length })
  return 'pass'
})

h.case('D02', 'pass', () => {
  const plan = build(PLUGIN_PACK)
  const w1 = writePlan(PLUGIN_PACK, plan)
  h.eq(w1.written.length, plan.files.length, 'D02 第一次 writePlan：产物还不存在 ⇒ 全部写下去')
  h.eq(w1.unchanged.length, 0, 'D02 第一次没有"没变"的文件')

  // 把 mtime 钉到一个**固定过去时刻**：第二次若真重写，mtime 必然变成"现在" —— 睡得着抓得住
  const forced = []
  const T0 = new Date('2001-01-01T00:00:00.000Z')
  for (const f of plan.files) {
    const abs = path.join(PLUGIN_PACK, ...f.path.split('/'))
    fs.utimesSync(abs, T0, T0)
    forced.push({ path: f.path, mtimeMs: fs.statSync(abs).mtimeMs, ino: fs.statSync(abs).ino })
  }

  const plan2 = build(PLUGIN_PACK)
  const w2 = writePlan(PLUGIN_PACK, plan2)
  h.eq(w2.written.length, 0, 'D02 第二次内容相同 ⇒ written=[]')
  h.eq(w2.unchanged.length, plan2.files.length, `D02 第二次全部 unchanged（实得 ${w2.unchanged.length}）`)
  for (const f of forced) {
    const st = fs.statSync(path.join(PLUGIN_PACK, ...f.path.split('/')))
    h.eq(st.mtimeMs, f.mtimeMs, `D02 ${f.path} 的 mtime **不变**（没被重写刷掉）`)
    h.eq(st.ino, f.ino, `D02 ${f.path} 的 ino 也没变（不是"先写 tmp 再 rename"）`)
  }
  const d = diffPlan(PLUGIN_PACK, plan2)
  h.eq(d.missing.length, 0, 'D02 落盘之后没有缺件')
  h.eq(d.different.length, 0, 'D02 落盘之后没有差异')
  note('D02', { written1: w1.written.length, written2: w2.written.length, mtime: forced[0] && forced[0].mtimeMs })
  return 'pass'
})

/* ══════════════════════ E：坏数据如实抛错 ══════════════════════ */

/** 跑一个构建，把"抛没抛 + 抛了什么"如实带回来（不许吞；文件名在 stack 里，Node 的 message 不含它） */
function attemptBuild() {
  try {
    const p = build(PLUGIN_PACK)
    return { threw: false, files: p.files.length, error: null }
  } catch (e) {
    const message = (e && e.message) || String(e)
    const stack = (e && e.stack) || ''
    return { threw: true, files: null, error: message, where: `${message}\n${stack}` }
  }
}

h.case('E01', 'pass', () => {
  const good = attemptBuild()
  h.eq(good.threw, false, 'E01 前提：数据是好的，构建不抛')
  fs.writeFileSync(GLOSSARY_PATH, 'module.exports = { oops: \n', 'utf8')
  try {
    const bad = attemptBuild()
    h.eq(bad.threw, true, 'E01 glossary-data.js 写成坏 JS ⇒ 构建**必须抛**（旧行为之外的病：不许拿上次成功的数据顶替）')
    h.assert(/glossary-data\.js/.test(bad.where), `E01 报错要点名那个文件（实得 ${JSON.stringify(bad.where)}）`)
  } finally {
    writeGlossary(state.glossary)     // 还原（还原本身也要让下一次构建能重读）
  }
  const back = measureBuild(PLUGIN_PACK, h, 'E01 还原之后')
  h.eq(back.termCount, 2, 'E01 还原之后构建恢复正常（坏账没被留在缓存里）')
  return 'pass'
})

h.case('E02', 'pass', () => {
  const bak = fs.readFileSync(QUESTIONS_PATH, 'utf8')
  fs.writeFileSync(QUESTIONS_PATH, 'module.exports = { oops: \n', 'utf8')
  try {
    const bad = attemptBuild()
    h.eq(bad.threw, true, 'E02 questions-data.js 写成坏 JS ⇒ 构建**必须抛**')
    h.assert(/questions-data\.js/.test(bad.where), `E02 报错要点名那个文件（实得 ${JSON.stringify(bad.where)}）`)
  } finally {
    fs.writeFileSync(QUESTIONS_PATH, bak, 'utf8')
  }
  const back = measureBuild(PLUGIN_PACK, h, 'E02 还原之后')
  h.eq(back.qaCount, 0, 'E02 还原之后构建恢复正常（答疑计数仍是删干净后的 0）')
  return 'pass'
})

h.case('E03', 'pass', () => {
  // 数据文件被**删掉**：如实抛错，绝不复用旧成功结果
  const bak = fs.readFileSync(GLOSSARY_PATH, 'utf8')
  fs.rmSync(GLOSSARY_PATH)
  try {
    const bad = attemptBuild()
    h.eq(bad.threw, true, 'E03 glossary-data.js 被删 ⇒ 构建**必须抛**（不许悄悄用旧对象把页面照旧生出来）')
    h.assert(/glossary-data\.js/.test(bad.where), `E03 报错要点名找不到的那个文件（实得 ${JSON.stringify(bad.where)}）`)
  } finally {
    fs.writeFileSync(GLOSSARY_PATH, bak, 'utf8')
  }
  const back = measureBuild(PLUGIN_PACK, h, 'E03 还原之后')
  h.eq(back.termCount, 2, 'E03 放回去之后构建恢复正常（并且读的是**放回去的**那份）')
  return 'pass'
})

/* ══════════════════════ F：不是全局清扫 / 代码与数据缓存分开 ══════════════════ */

const requireHere = createRequire(import.meta.url)
const SENTINEL_KEY = requireHere.resolve(path.join(PLUGIN_PACK, 'tools', 'sentinel.js'))
const SHAPE_KEY = requireHere.resolve(SHAPE_PATH)
requireHere(path.join(PLUGIN_PACK, 'tools', 'sentinel.js'))

h.case('F01', 'pass', () => {
  h.eq(SENTINEL_KEY in requireHere.cache, true, 'F01 前提：无关模块（sentinel）此刻在 require.cache 里')
  h.eq(SHAPE_KEY in requireHere.cache, true, 'F01 前提：执行代码（shape-render.js）此刻在 require.cache 里')
  const before = measureBuild(PLUGIN_PACK, h, 'F01 改之前')
  // 真改一次数据 ⇒ 必须走"失效 + 重读"那条路
  writeGlossary({ ...state.glossary, delta: term('丁术语') })
  const after = measureBuild(PLUGIN_PACK, h, 'F01 改之后')
  h.eq(after.termCount, before.termCount + 1, 'F01 反空转：这次构建**确实重读了**数据（计数 +1）—— 否则下面两条是白得的')
  h.eq(SENTINEL_KEY in requireHere.cache, true, 'F01 失效只许动目标键：**无关的模块键**必须还在 require.cache 里（全局清扫会把它删掉）')
  h.eq(SHAPE_KEY in requireHere.cache, true, 'F01 执行代码的键也必须在（数据失效不牵连它）')
  note('F01', { termCountBefore: before.termCount, termCountAfter: after.termCount, sentinelKept: SENTINEL_KEY in requireHere.cache })
  return 'pass'
})

h.case('F02', 'pass', () => {
  const a = readRenderInputs(PLUGIN_PACK, {})
  const shapeObj = a.shape
  h.assert(shapeObj && typeof shapeObj.renderBlock === 'function', 'F02 前提：执行代码模块真的加载出来了')

  // 执行代码改字节（它不该被数据失效牵连重载）
  fs.writeFileSync(SHAPE_PATH, Buffer.concat([SHAPE_ORIG, Buffer.from('\n// T17 F02 变异：执行代码改了字节\n')]))
  try {
    const b = readRenderInputs(PLUGIN_PACK, {})
    h.eq(b.shape === shapeObj, true, 'F02 数据没变：执行代码仍走 require 缓存（同一个模块对象）')
    h.eq(b.glossaryIndex.glossary === a.glossaryIndex.glossary, true, 'F02 数据没变 ⇒ **复用同一份数据对象**（不是每次都重读）')

    writeGlossary({ ...state.glossary, delta: term('丁术语（改）') })
    const c = readRenderInputs(PLUGIN_PACK, {})
    h.eq(c.glossaryIndex.glossary !== b.glossaryIndex.glossary, true, 'F02 数据变了 ⇒ 必须是**新**的一份数据对象')
    h.eq(c.glossaryIndex.labelToKey['丁术语（改）'], 'delta', 'F02 新对象里带的是新内容')
    h.eq(c.glossaryIndex.labelToKey['丁术语'], undefined, 'F02 旧 label 不在索引里了')
    h.eq(c.shape === shapeObj, true, 'F02 数据失效**没有**把执行代码一起重载（两者缓存分开 —— 卡面接口要求）')
  } finally {
    fs.writeFileSync(SHAPE_PATH, SHAPE_ORIG)
  }
  return 'pass'
})

/* ══════════════════════ G：既有守卫一字不改 ══════════════════════ */

h.case('G01', 'pass', () => {
  const bak = `${QUESTIONS_PATH}.t17-moved`
  fs.renameSync(QUESTIONS_PATH, bak)
  try {
    const ctx = readRenderInputs(PLUGIN_PACK, {})
    h.eq(ctx.pages.length, 0, 'G01 缺 questions-data.js ⇒ pages 空（既有契约）')
    h.eq(Object.keys(ctx.qa).length, 0, 'G01 qa 是空对象')
    h.assert(ctx.warnings.some((w) => /questions-data\.js/.test(w)), `G01 warnings 里说明白为什么跳过（实得 ${JSON.stringify(ctx.warnings)}）`)
    const plan = build(PLUGIN_PACK)
    h.eq(plan.files.length, 0, 'G01 构建不抛、也不产出（既有"响亮跳过"的语义）')
    h.assert(plan.warnings.length > 0, 'G01 计划里带着那条告警')
  } finally {
    fs.renameSync(bak, QUESTIONS_PATH)
  }
  return 'pass'
})

/* ══════════════════════ H：包侧同一口径 ══════════════════════ */

h.case('H01', 'pass', () => {
  const r = spawnSync(process.execPath, [DRIVER], { cwd: FIXTURE, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 })
  h.eq(r.status, 0, `H01 包侧驱动进程退出码必须是 0（实得 ${r.status}）；stderr=${clip(r.stderr, 800)}`)
  const rec = JSON.parse(fs.readFileSync(DRIVER_OUT, 'utf8'))
  h.eq(rec.error === undefined, true, `H01 包侧两次构建都不许抛：${clip(rec.error, 1200)}`)
  h.eq(rec.run1.termCount, 2, 'H01 包侧第一次构建：名词总数 2')
  h.eq(rec.run1.hintTerm, 'alpha', 'H01 包侧第一次构建：本课术语 alpha')
  h.eq(rec.run1.hintLabel, '甲术语', 'H01 包侧第一次构建：标签「甲术语」')
  h.eq(rec.run1.body, true, 'H01 正文在')
  h.eq(rec.run2.termCount, 3, 'H01 **同一进程**里改盘后再构建 ⇒ 包侧必须读到第 3 条术语（旧行为：require 缓存 → 仍是 2）')
  h.eq(rec.run2.hintTerm, 'gamma', 'H01 包侧第二次构建：data-term 是新术语')
  h.eq(rec.run2.hintLabel, '丙术语', 'H01 包侧第二次构建：打出新术语的标签')
  h.eq(rec.run1.termCount !== rec.run2.termCount && rec.run1.hintTerm !== rec.run2.hintTerm,
    true, 'H01 反空转：两次真的不同（否则这条是空转）')
  note('H01', { run1: rec.run1, run2: rec.run2, steps: rec.steps })
  return 'pass'
})

h.case('H02', 'pass', () => {
  const rec = JSON.parse(fs.readFileSync(DRIVER_OUT, 'utf8'))
  h.eq(rec.sentinelBefore, true, 'H02 前提：无关模块（sentinel）在构建之前就在 require.cache 里')
  h.eq(rec.sentinelAfter, true, 'H02 包侧同样不许全局清扫：跨两次构建之后，**无关的模块键**必须还在 require.cache 里')
  h.eq(rec.glKeyInCache, true, 'H02 数据文件的键在（重读过之后又回到缓存里，不是"删了不补"）')
  return 'pass'
})

h.case('H03', 'pass', () => {
  // 两侧**口径一致**（源码级 —— 包侧那份是 CJS、插件侧是 ESM + createRequire，
  // 实现可以不同，但"只删单键 / 按 mtime+size+ino 判新鲜 / 不做全局清扫 / 执行代码不走数据加载器"四条必须一致）。
  // ⚠️ 判据只看**代码**：先剥注释 —— 两侧的注释里都写着"绝不 Object.keys(require.cache)…"
  //    来解释这条边界，不剥的话判据会被自己的说明文字绊倒（与 test/render-parity.mjs 的 E 条同一纪律）。
  const stripJsComments = (src) => String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
  const pluginSrc = stripJsComments(fs.readFileSync(path.join(REPO, 'lib', 'render-inputs.js'), 'utf8'))
  const packSrc = stripJsComments(fs.readFileSync(path.join(TEMPLATE, 'tools', 'build-lessons.js'), 'utf8'))
  h.assert(/export function readRenderInputs/.test(pluginSrc), 'H03 剥注释没剥多：插件侧的活代码（readRenderInputs）还在')
  h.assert(/function parseSource/.test(packSrc), 'H03 剥注释没剥多：包侧的活代码（parseSource）还在')
  const SWEEP = [
    [/Object\.keys\(\s*[A-Za-z_$][\w$]*\.cache\s*\)/, 'Object.keys(x.cache)'],
    [/for\s*\(\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s+in\s+[A-Za-z_$][\w$]*\.cache\s*\)/, 'for (… in x.cache)'],
  ]
  const sides = [
    { name: '插件侧 lib/render-inputs.js', src: pluginSrc, del: /delete\s+requireFromRoot\.cache\[/, shape: /requireFromRoot\('\.\/tools\/shape-render\.js'\)/ },
    { name: '包侧 lib/pack-template/tools/build-lessons.js', src: packSrc, del: /delete\s+require\.cache\[/, shape: /require\(path\.join\(__dirname, 'shape-render\.js'\)\)/ },
  ]
  for (const s of sides) {
    h.assert(s.del.test(s.src), `H03 ${s.name}：按**键**失效（delete <require>.cache[<resolvedKey>]）`)
    h.assert(/mtimeMs/.test(s.src) && /\bsize\b/.test(s.src) && (/\bino\b/.test(s.src) || /\.ino/.test(s.src)),
      `H03 ${s.name}：新鲜度按 mtimeMs + size + ino 判`)
    for (const [re, name] of SWEEP) h.assert(!re.test(s.src), `H03 ${s.name}：没有全局清扫（${name}）`)
    h.assert(s.shape.test(s.src), `H03 ${s.name}：执行代码（shape-render.js）不走数据加载器（照旧 require）`)
  }
  return 'pass'
})

/* ══════════════════════ I：夹具自检 ══════════════════════ */

h.case('I01', 'pass', () => {
  const abs = path.resolve(PLUGIN_PACK)
  h.eq(abs.startsWith(path.resolve(TMP_BASE) + path.sep), true, `I01 插件夹具在 ${TMP_BASE} 下（实得 ${abs}）`)
  h.eq(path.basename(path.resolve(FIXTURE)).startsWith('whale-T17-'), true, 'I01 夹具目录名带本次 tag（清理前要能核出归属）')
  h.eq(abs.toLowerCase().startsWith(path.resolve(LIVE_PACK).toLowerCase()), false, 'I01 夹具**不是**活包 E:/workplace/study')
  h.eq(fs.existsSync(path.join(LIVE_PACK, 'lessons', HALO)), false, `I01 活包里没有夹具的圈 ${HALO}（本次没往活包写任何东西）`)
  h.eq(fs.existsSync(path.join(PACK_PACK, 'tools', 'build-lessons.js')), true, 'I01 包侧夹具是模板逐字节副本（引擎闭包齐全）')
  h.eq(fs.readFileSync(path.join(PACK_PACK, 'tools', 'build-lessons.js'), 'utf8'),
    fs.readFileSync(path.join(TEMPLATE, 'tools', 'build-lessons.js'), 'utf8'),
    'I01 包侧夹具里的 build-lessons.js 与模板逐字节同一份（判的是产品那份代码）')
  h.evidenceJson('observed.json', state.observed)
  return 'pass'
})

/* ── 判词 ───────────────────────────────────────────────────────────────── */

const exitCode = h.run()

// 全绿才删夹具（失败留现场给规划者诊断）；删前核实绝对路径确实属于本次夹具
if (exitCode === 0) {
  const abs = path.resolve(FIXTURE)
  if (path.dirname(abs) !== path.resolve(TMP_BASE) || !path.basename(abs).startsWith('whale-T17-')) {
    process.stdout.write(`FAIL T17 checks=${IDS.length} failed=1 skipped=0（拒绝清理不属于本次夹具的路径 ${abs}）\n`)
    process.exit(1)
  }
  fs.rmSync(abs, { recursive: true, force: true })
}
process.exit(exitCode)
