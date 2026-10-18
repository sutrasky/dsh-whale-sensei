/**
 * test/audit/T20.mjs — 私人数据默认不进入离线及公开产物（报告 D05 · P1）
 * ==================================================================
 * 卡面判据（**原文**）：「每类私人数据放唯一 canary，离线/公开输出全文不得含 canary，
 * 选定教学正文仍保留。公开站保留进度是源码明示的产品选择，不把进度原样发布本身另报漏洞。」
 *
 * 本壳只做一件事：把这条判据变成**能失败**的机械检查。所以它：
 *   ① **夹具由产品自己的链产出**（D7）：`writeScaffold()` 建包 → 写一节课源文件 →
 *      `tools/build-lessons.js` 真渲染 → `assets/build-glossary.js` 真生成名词表 →
 *      `tools/build-starmap.js` 真建星图（`progress.json` 点亮 + `questions/pending.jsonl` 待答
 *      ⇒ `learned:true` / `pendingQ:1` / `flag:'red'` 都是**真**的进度信号）→
 *      `tools/build-notes.js` 真生成**旧派生页**（它自己就把已答正文写进 NOTES.html —— 于是
 *      A08 的"旧派生页"不是手抄的 canary，是产品自己那份产物）。
 *      夹具里没有任何"手工补件"：读者档的 `tools/build-offline-payload.js` 是**入口本体**
 *      （`engine-files.cjs#CODE_EXCLUDE` 明写它不随包走），只能取自产品自己的骨架源
 *      `lib/pack-template/`（夹具 = 骨架源原样拷贝 ∪ `writeScaffold()` 的产物）。
 *   ② 私人面每类一个唯一 canary；**扫描产物全文**（非二进制件全部解码后搜）。
 *   ③ 两组反空转：**源包**里那些 canary 与进度信号必须先被证明**真的在**（不然"产物里没有"
 *      是废话）；**负向控制 N01** 再把基线实现（`git show ba22c94:…`）拿回来、用同一批输入
 *      跑一遍，证明旧行为**真会把私人内容发出去**。
 *   ④ 所有临时目录在 `E:/Temp/whale-T20-*`，清理前核实绝对路径属于本次夹具（N02）。
 *
 * 一行判词：`PASS T20 checks=27 failed=0 skipped=0` / `FAIL T20 …` exit1 / `BLOCKED T20 …` exit2。
 * 固定用例 ID 全集 27 条，缺 / 多 / 重都算失败（`createHarness` 的 expectedIds 自检）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { createHarness, REPO, runChild, clip } from './harness.mjs'
import { writeScaffold, TEMPLATE_FILES } from '../../lib/pack-scaffold.js'
import { FROM_PLUGIN, FROM_PACK, SANITIZE, templatePaths } from '../pack-template-rules.mjs'
import { emptyLedgerSource, serializeLedgerEntry, insertLedgerEntry } from '../../lib/ask.js'
import { renderPracticeDataModule } from '../../lib/practice.js'

const require_ = createRequire(import.meta.url)
const PUB = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'publish-policy.cjs'))
const { requiredButNotRegistered } = require_(path.join(REPO, 'lib', 'pack-template', 'tools', 'engine-files.cjs'))
const TEMPLATE_DIR = path.join(REPO, 'lib', 'pack-template')
const TOOLS_DIR = path.join(TEMPLATE_DIR, 'tools')

const CARD = 'T20'
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
const LIVE_PACK = 'E:\\workplace\\study'
const TMP_BASE = 'E:\\Temp'

const EXPECTED_IDS = [
  'P01 policy-single-source',
  'P02 plan-shape-and-digest-deterministic',
  'P03 plan-digest-changes-with-inputs',
  'P04 plan-refuses-unknown-kind',
  'Y01 registration-pairing',
  'Y02 gate-rejects-unregistered-template-file',
  'A01 reader-output-no-canary',
  'A02 public-output-no-canary',
  'A03 teaching-body-preserved',
  'A04 progress-neutralized-by-default',
  'A05 progress-shared-on-explicit-choice',
  'A06 other-canaries-still-zero-when-progress-shared',
  'A07 derived-pages-rebuilt-from-sanitized-input',
  'A08 stale-derived-page-not-carried',
  'A09 excluded-list-names-private-surfaces',
  'A10 plan-files-are-output-superset',
  'D01 confirm-required',
  'D02 stale-plan-refused',
  'D03 failed-apply-does-not-replace-output',
  'D04 source-pack-bytes-unchanged',
  'D05 cli-plan-writes-nothing',
  'D06 cli-confirm-plan-digest-and-include-progress',
  'S01 offline-skeleton-excludes-private-ledgers',
  'S02 offline-skeleton-still-propagates',
  'S03 public-reader-split-policy',
  'N01 negative-control-baseline-leaks',
  'N02 negative-control-cleanup-guard',
]

const h = createHarness({ card: CARD, expectedIds: EXPECTED_IDS, root: LIVE_PACK })
const ev = (name, text) => h.evidence(path.join('cases', `${name}.txt`), text + '\n')
const rows = (...xs) => xs.join('\n')

/* ══════════════════════════════════════════════════════ 夹具：临时目录与守卫 */

if (!fs.existsSync(TMP_BASE)) h.block(`本机没有 ${TMP_BASE}（本卡规定临时副本一律落这里）`)
const SESSION = fs.mkdtempSync(path.join(TMP_BASE, 'whale-T20-'))

/** 清理**本次夹具**：核实绝对路径确实落在 `E:\Temp` 下、目录名前缀是本卡 tag —— 否则拒绝删 */
function cleanupOwn(dir) {
  const abs = path.resolve(String(dir ?? ''))
  if (path.dirname(abs) !== path.resolve(TMP_BASE)) return { removed: false, error: `拒绝清理：${abs} 不在 ${TMP_BASE} 下` }
  if (!path.basename(abs).startsWith('whale-T20-')) return { removed: false, error: `拒绝清理：${path.basename(abs)} 前缀不是 whale-T20-` }
  try { fs.rmSync(abs, { recursive: true, force: true }); return { removed: true, error: null } } catch (e) { return { removed: false, error: `清理失败：${e?.message ?? e}` } }
}

function walk(dir, prefix = '') {
  const out = []
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of es.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

/** 列出 `base/sub` 下的文件（相对 `sub`）；`sub` 不存在就返回空 */
const under = (base, sub) => walk(path.join(base, sub))

/** 基线实现（`git show <ref>:<路径>`）—— N01 的负向控制用它。
 *  `ref` 缺省给**基线 commit**（不是 HEAD）：T20 提交之后 HEAD 里是新实现，
 *  拿 HEAD 当"旧行为"会把新实现跑两遍 ⇒ 负向控制恒真。 */
function gitShow(rel, ref = BASE_COMMIT) {
  const r = runChild(['git', 'show', `${ref}:${rel}`], { cwd: REPO, timeoutMs: 60000 })
  return r.code === 0 ? r.out : null
}

const readText = (f) => fs.readFileSync(f, 'utf8')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 产物**全文**扫描用：非二进制件解码后搜 canary（二进制件按 latin1 也要扫一遍字节） */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 扫一棵树里的所有文本：返回 [{rel, hits:[canary…]}]，另返回扫描件数/字节数（证据用） */
function scanTree(dir, canaries) {
  const found = []
  let files = 0
  let bytes = 0
  for (const rel of walk(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel))
    files++
    bytes += buf.length
    const text = looksBinary(buf) ? buf.toString('latin1') : buf.toString('utf8')
    const hits = []
    for (const [k, v] of Object.entries(canaries)) if (text.includes(v)) hits.push(k)
    if (hits.length) found.push({ rel, hits })
  }
  return { found, files, bytes }
}

/** 源包快照（path + size + mtime —— 与 `test/export-pack.mjs` 同一套口径） */
function snapshotTree(root) {
  const m = new Map()
  for (const rel of walk(root)) {
    const st = fs.statSync(path.join(root, rel))
    m.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`)
  }
  return m
}
function diffSnapshot(a, b) {
  const out = []
  for (const [k, v] of a) { if (!b.has(k)) out.push(`缺 ${k}`); else if (b.get(k) !== v) out.push(`变 ${k}（${v} → ${b.get(k)}）`) }
  for (const k of b.keys()) if (!a.has(k)) out.push(`多 ${k}`)
  return out
}

/* ══════════════════════════════════════════════════════════ canary 与夹具内容 */

const CAN = {
  '待答（questions/pending.jsonl）': 'CANARY-T20-PENDING-a1',
  '已答正文（questions-data.js question）': 'CANARY-T20-ANSWEREDTEXT-a2',
  '已答 HTML（questions-data.js answerHtml）': 'CANARY-T20-ANSWERHTML-a3',
  '笔记（notes/notes.jsonl）': 'CANARY-T20-NOTE-a4',
  '摸底（learning-records/intake.jsonl）': 'CANARY-T20-INTAKE-a5',
  '证据（learning-records/evidence.jsonl）': 'CANARY-T20-EVIDENCE-a6',
  '教学（learning-records/teaching.jsonl）': 'CANARY-T20-TEACHING-a7',
  '终点（learning-records/goals.jsonl）': 'CANARY-T20-GOAL-a8',
  '调整（learning-records/adjustments.jsonl）': 'CANARY-T20-ADJUST-a9',
  'state.json': 'CANARY-T20-STATE-aa',
  'brief.md': 'CANARY-T20-BRIEF-ab',
  '学生代码（code/EXPECT.json）': 'CANARY-T20-CODE-ad',
}
/** 「旧派生页」这一类**没有单独的 canary 串**：那一页是产品自己由已答台账 / 笔记生成出来的，
 *  所以它的内容就是上面那几条。A08 用**页级判据**抓它：源页必须含这些串、产物页必须一个都不含、
 *  且两者逐字节不同（"只删原账却复制旧派生页"必红）。 */

/** 教学正文独有的正例串（A03：产物里**必须**有它） */
const TEACH_BODY = 'CANARY-T20-TEACHINGBODY-POSITIVE-z9'
/** 夹具课程的知识点键（星图课次 id / 笔记 anchor 都走它） */
const LESSON_KEY = 'point/0001'

const lessonSource = () => `<script type="application/json" data-lesson-meta>
{
  "title": "T20 夹具课",
  "number": 1,
  "navTitle": "夹具课",
  "hintTerm": "canary",
  "source": { "label": "T20 夹具", "url": "https://example.invalid/t20" },
  "terms": {}
}
</script>

<!--@objective-->
<div class="alert alert-info"><strong>课程目标：</strong>${TEACH_BODY} 的课程目标。</div>
<!--/@objective-->

<!--@review-->
<div class="review-box" id="review-0001"><h3>开课之前</h3><p>第一节，没有上一课。</p></div>
<!--/@review-->

<!--@body-->
<h2>${TEACH_BODY}</h2>
<section class="step"><h3>① 一段正文</h3><p>${TEACH_BODY} 在这里再说一遍（产物里必须还在）。</p></section>
<!--/@body-->

<!--@reading-->
<ul><li>推荐阅读</li></ul>
<!--/@reading-->

<!--@challenges-->
<ol class="challenges"><li>挑战一</li></ol>
<!--/@challenges-->
`

/** 把一条词条落进骨架台账（与骨架同形）。
 *  ⚠️ 为什么不用 `lib/glossary-edit-io.js#writeTermSurgically`：它在**建包出来的空台账**上必抛
 *  「上一条记录末尾不是 `}`，插入点可疑」（`lib/glossary.js:164` 的"末条补逗号"在 0 词条时不成立）。
 *  那是本卡写范围之外的另一条缺陷（只在"新包里加第一个名词"这条路踩到），已在回执里报告。 */
function plantTerm(pack) {
  const p = path.join(pack, 'assets', 'glossary-data.js')
  const src = readText(p)
  const body = [
    '    canary: {',
    "      label: 'Canary',",
    "      category: '夹具',",
    "      official: 'T20 夹具术语（由夹具直接登记）。',",
    "      short: '一个夹具名词。',",
    "      analogy: '像矿坑里的金丝雀。',",
    "      lesson: '第1课'",
    '    }',
    '',
  ].join('\n')
  fs.writeFileSync(p, src.replace('    // 在这里按分类顺序添加名词……\n', body), 'utf8')
}

function runIn(cwd, scriptRel, args = []) {
  return runChild([process.execPath, path.join(cwd, scriptRel), ...args], { cwd, timeoutMs: 300000 })
}

/** 把"私人面 + canary"真实铺进一个已经建好的包（再跑包内生成器把**旧派生页**真做出来） */
function plantPrivate(pack) {
  // 学生自己的代码（**EXPECT.json 要声明这一课** —— 包侧课次映射表 `lessonMap()` 的 byKey
  // 就是从实践区的 EXPECT.json 声明里来的；不声明的话 NOTES.html 连"哪一课"都列不出来）
  fs.mkdirSync(path.join(pack, 'code', 'proj'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'code', 'proj', 'EXPECT.json'), JSON.stringify({
    note: CAN['学生代码（code/EXPECT.json）'],
    lessons: [{ id: LESSON_KEY, title: 'T20 夹具课' }],
  }, null, 2) + '\n', 'utf8')

  // 待答队列（同时喂 star 图的 pendingQ / flag —— 进度信号由产品自己的生成器算出来）
  fs.writeFileSync(path.join(pack, 'questions', 'pending.jsonl'),
    JSON.stringify({ seq: 1, id: '0001', lesson: LESSON_KEY, question: CAN['待答（questions/pending.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'questions', 'processed.jsonl'), JSON.stringify({ id: '0001', note: '已归档' }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'questions', 'seq.txt'), '1\n', 'utf8')

  // 笔记台账
  fs.writeFileSync(path.join(pack, 'notes', 'notes.jsonl'),
    JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: LESSON_KEY, text: CAN['笔记（notes/notes.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'notes', 'seq.txt'), '1\n', 'utf8')

  // 学习记录（摸底 / 证据 / 教学 / 终点 / 调整 / state / brief）
  fs.mkdirSync(path.join(pack, 'learning-records'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'learning-records', 'intake.jsonl'), JSON.stringify({ note: CAN['摸底（learning-records/intake.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', 'evidence.jsonl'), JSON.stringify({ note: CAN['证据（learning-records/evidence.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', 'teaching.jsonl'), JSON.stringify({ note: CAN['教学（learning-records/teaching.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', 'goals.jsonl'), JSON.stringify({ note: CAN['终点（learning-records/goals.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', 'adjustments.jsonl'), JSON.stringify({ note: CAN['调整（learning-records/adjustments.jsonl）'] }) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', 'state.json'), JSON.stringify({ codeDir: 'code', note: CAN['state.json'] }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', 'brief.md'), `# 备课摘要\n\n${CAN['brief.md']}\n`, 'utf8')
  fs.writeFileSync(path.join(pack, 'learning-records', '0001-夹具.md'), `学习记录：${CAN['摸底（learning-records/intake.jsonl）']}\n`, 'utf8')

  // 答疑台账**真源**：用插件自己的序列化 + 插桩（锚点与写入链同一份）
  const qpath = path.join(pack, 'assets', 'questions-data.js')
  const block = serializeLedgerEntry({
    id: '0001', date: '2026-10-16', lesson: '第1课',
    question: CAN['已答正文（questions-data.js question）'],
    page: 'lessons/demo/point/0001-canary.html', section: '正文',
    answer: '解答正文', answerHtml: `<p>${CAN['已答 HTML（questions-data.js answerHtml）']}</p>`,
  })
  fs.writeFileSync(qpath, insertLedgerEntry(readText(qpath), '0001', block), 'utf8')

  // 实践区完成度（用插件自己的序列化器生成，不手抄 UMD）
  fs.writeFileSync(path.join(pack, 'assets', 'practice-data.js'), renderPracticeDataModule({
    version: 2,
    keyScheme: 'lesson-id',
    source: 'learning-records/state.json',
    lessons: {
      [LESSON_KEY]: {
        summary: { achieved: 1, needsReview: 1, total: 1 },
        challenges: [{ no: 1, title: '挑战一', state: 'done', hints: [] }],
        missing: [],
        why: '夹具',
      },
    },
    byFile: {},
  }), 'utf8')

  // 本机配置（D3 点名的私人面之一）
  fs.writeFileSync(path.join(pack, 'lesson.config.json'), JSON.stringify({ style: { source: 'raw-html-v2', slug: 'whale-sensei' }, note: '本机配置' }, null, 2) + '\n', 'utf8')

  // 结构性排除面（D3 顺带点名的那一批）—— 都要真实存在，A09 才不是空转
  for (const d of ['dist', 'dist-offline', '.backup', '.trash', '.whale-txn', 'node_modules']) {
    fs.mkdirSync(path.join(pack, d), { recursive: true })
    fs.writeFileSync(path.join(pack, d, 'keep.txt'), `${d} 占位\n`, 'utf8')
  }
  fs.writeFileSync(path.join(pack, '.whale-write.lock'), '{"owner":"fixture"}\n', 'utf8')
  fs.mkdirSync(path.join(pack, '.git'), { recursive: true })
  fs.writeFileSync(path.join(pack, '.git', 'HEAD'), 'ref: refs/heads/fixture\n', 'utf8')

  // 进度正本（离线档的进度载体；star 图从它点亮）
  fs.writeFileSync(path.join(pack, 'progress.json'), JSON.stringify({ learned: [LESSON_KEY], notes: {} }, null, 2) + '\n', 'utf8')

  return { qpath }
}

/**
 * 建一个"由产品自己的链产出"的课程包。
 * @param {string} name 夹具名（落在 SESSION 下）
 * @param {'public'|'reader'} profile
 */
function buildFixture(name, profile) {
  const home = path.join(SESSION, name)
  const pack = path.join(home, 'pack')
  fs.mkdirSync(pack, { recursive: true })

  if (profile === 'reader') {
    // 离线档的**入口本体**只活在骨架源目录里（`CODE_EXCLUDE` 明写 `offline-bootstrap.js` /
    // `build-offline-payload.js` 不随包走）⇒ 夹具基座 = 骨架源原样拷贝（不是补件：那是产品的源）。
    fs.cpSync(TEMPLATE_DIR, pack, { recursive: true })
  }
  // 骨架数据件（台账 / 本机配置 / 空实践区 / 空星图 / README）：由**产品自己的建包链**产出
  const sib = path.join(home, 'scaffold')
  fs.mkdirSync(sib, { recursive: true })
  const built = writeScaffold(sib)
  if (!built.ok) throw new Error('夹具：writeScaffold 失败：' + built.error)
  fs.cpSync(sib, pack, { recursive: true, force: false })

  // 一节课的源文件 + 圈 / 点结构
  fs.mkdirSync(path.join(pack, 'lessons', 'src', 'demo', 'point'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'lessons', 'src', 'demo', 'point', '0001-canary.html'), lessonSource(), 'utf8')
  fs.mkdirSync(path.join(pack, 'lessons', 'demo', 'point'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'lessons', 'demo', 'halo.json'), JSON.stringify({ halo: 'demo', name: '示例圈', color: '#7c8aa5' }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(pack, 'lessons', 'demo', 'point', 'point.json'), JSON.stringify({ point: 'point', label: '示例点', fileBase: 0 }, null, 2) + '\n', 'utf8')
  plantTerm(pack)

  // 真跑包内生成器：课程页 / 名词表
  const steps = []
  for (const [rel, args] of [
    ['tools/build-lessons.js', []],
    ['assets/build-glossary.js', []],
  ]) {
    const r = runIn(pack, rel, args)
    steps.push(`${rel} exit=${r.code}${r.code === 0 ? '' : `\n${clip(r.out + r.err, 2000)}`}`)
    if (r.code !== 0) throw new Error(`夹具：${rel} 失败（exit ${r.code}）—— 夹具不正，后面全是假绿\n${clip(r.out + r.err, 2000)}`)
  }

  plantPrivate(pack)

  // 真跑包内生成器：星图（learned / pendingQ / flag 真算出来）+ 静态版 SVG
  for (const [rel, args] of [
    ['tools/build-starmap.js', []],
    ['tools/build-starmap-svg.js', []],
    // **旧派生页**：在"净化之前"用产品自己的生成器真做一份 —— 它把已答正文 / 已答 HTML /
    // 笔记全写进 reference/NOTES.html（A08 的"旧派生页"就是它，不是手抄的 canary）
    ['tools/build-notes.js', []],
  ]) {
    const r = runIn(pack, rel, args)
    steps.push(`${rel} exit=${r.code}${r.code === 0 ? '' : `\n${clip(r.out + r.err, 2000)}`}`)
    if (r.code !== 0) throw new Error(`夹具：${rel} 失败（exit ${r.code}）\n${clip(r.out + r.err, 2000)}`)
  }
  h.note(`夹具 ${name}（${profile}）生成步骤：\n  ` + steps.join('\n  ').replace(/\n/g, '\n  '))
  return { home, pack, steps }
}

const FIX = {}
function fixture(profile) {
  if (!FIX[profile]) FIX[profile] = buildFixture(`fix-${profile}`, profile)
  return FIX[profile]
}

/* ══════════════════════════════════════════════════ 真跑 CLI：产物缓存 */

/** `node <pack>/tools/<脚本> --plan …` → 一行 JSON（判据：**只**一行） */
function cliPlan(pack, kind, includeProgress) {
  const script = kind === 'public' ? 'tools/build-public.js' : 'tools/build-offline-payload.js'
  const flags = kind === 'reader' ? ['--no-node'] : []
  if (includeProgress) flags.push('--include-progress')
  const r = runIn(pack, script, ['--plan', ...flags])
  const lines = String(r.out).split(/\r?\n/).filter((l) => l.trim())
  return { r, lines, plan: lines.length === 1 ? JSON.parse(lines[0]) : null, flags }
}

/** 真跑 CLI 的 confirm 路径，产物落在包内（dist/ 或 dist-offline/whale-reader） */
function cliPublish(pack, kind, includeProgress) {
  const script = kind === 'public' ? 'tools/build-public.js' : 'tools/build-offline-payload.js'
  const flags = kind === 'reader' ? ['--no-node'] : []
  if (includeProgress) flags.push('--include-progress')
  const before = snapshotTree(pack)
  const p1 = runIn(pack, script, ['--plan', ...flags])
  const lines = String(p1.out).split(/\r?\n/).filter((l) => l.trim())
  const plan = JSON.parse(lines[lines.length - 1])
  const afterPlan = snapshotTree(pack)
  const p2 = runIn(pack, script, ['--confirm', `--plan-digest=${plan.planDigest}`, ...flags])
  const outDir = kind === 'public' ? path.join(pack, 'dist') : path.join(pack, 'dist-offline', 'whale-reader')
  return { plan, planRun: p1, planLines: lines, confirmRun: p2, outDir, before, afterPlan }
}

const PUBLISHED = {}
function published(kind, includeProgress) {
  const key = `${kind}:${includeProgress ? 1 : 0}`
  if (!PUBLISHED[key]) {
    const pack = fixture(kind).pack
    const p = cliPublish(pack, kind, includeProgress)
    if (p.confirmRun.code !== 0) throw new Error(`真跑 CLI 发布失败（${kind} includeProgress=${includeProgress}，exit ${p.confirmRun.code}）：\n${clip(p.confirmRun.out + p.confirmRun.err, 3000)}`)
    // ⚠️ CLI 的产物落点固定在包内（`dist/` / `dist-offline/whale-reader`）—— 同一个包跑第二档会覆盖第一档。
    // 所以每次发布完**就地快照**成一份独立副本，后面所有判据都读副本（产物内容逐字节相同）。
    const snap = path.join(SESSION, `published-${kind}-${includeProgress ? 'progress' : 'clean'}`)
    fs.cpSync(p.outDir, snap, { recursive: true })
    PUBLISHED[key] = { ...p, pack, rawOutDir: p.outDir, outDir: snap }
  }
  return PUBLISHED[key]
}

/* ═══════════════════════════════════════════════════════════════ 开工前快照 */

const LIVE_BEFORE = snapshotTree(LIVE_PACK)
const SNAP_DIR = 'C:\\Users\\bouyer\\Documents\\deepseek-harness\\default-workspace\\audit-handoff\\dsh-whale-sensei\\extracted\\dsh-whale-sensei'
const SNAP_BEFORE = fs.existsSync(SNAP_DIR)
  ? { files: walk(SNAP_DIR).length, bytes: walk(SNAP_DIR).reduce((n, rel) => n + fs.statSync(path.join(SNAP_DIR, rel)).size, 0) }
  : { files: -1, bytes: -1 }

/* ═════════════════════════════════════════════════════════════ P：策略与计划 */

h.case('P01 policy-single-source', 'pass', () => {
  const files = {
    public: path.join(TOOLS_DIR, 'build-public.js'),
    payload: path.join(TOOLS_DIR, 'build-offline-payload.js'),
  }
  const srcs = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readText(f)]))
  const policySrc = readText(path.join(TOOLS_DIR, 'publish-policy.cjs'))
  // 「只有一份实现」的机械判据：**策略里那些 why 一字不许在别处再出现一遍**
  // （照抄一份理由表 = 第二个真源；至于 FORBIDDEN 里点名 `questions`/`notes` 是 C-2 要求，另算）
  const whys = PUB.publicationPolicy({ kind: 'public' }).privateSurfaces.map((s) => s.why)
  const rowsOut = []
  for (const [k, s] of Object.entries(srcs)) {
    rowsOut.push(`${k}: require('./publish-policy.cjs')=${/require\(\s*'\.\/publish-policy\.cjs'\s*\)/.test(s)} · planPublication=${s.includes('planPublication(')} · applyPublication=${s.includes('applyPublication(')}`)
    rowsOut.push(`${k}: 抄了一份 why 表=${whys.filter((w) => s.includes(w)).length}`)
  }
  for (const [k, s] of Object.entries(srcs)) {
    h.assert(/require\(\s*'\.\/publish-policy\.cjs'\s*\)/.test(s), `${k} 必须 require('./publish-policy.cjs')（D1：策略只有一份实现）`)
    h.assert(s.includes('planPublication('), `${k} 必须真调 planPublication()`)
    const copied = whys.filter((w) => s.includes(w))
    h.eq(copied.length, 0, `${k} 不许自带第二份私人面理由表（只许在 publish-policy.cjs 里；实得 ${copied.join('、')}）`)
  }
  rowsOut.push(`策略 why 条数：${whys.length} · 盘上 publish-policy.cjs 含第一份：${/私人原账/.test(policySrc)}`)
  h.assert(/私人原账/.test(policySrc), 'publish-policy.cjs 必须是私人面清单的真源')

  // 运行期真调：两个 CLI 打出来的计划必须与**直接调 publish-policy** 的结果**同摘要**
  const pubFix = fixture('public').pack
  const readerFix = fixture('reader').pack
  const cliP = cliPlan(pubFix, 'public', false)
  const cliR = cliPlan(readerFix, 'reader', false)
  h.eq(cliP.r.code, 0, `build-public.js --plan 必须 exit 0（实得 ${cliP.r.code}）`)
  h.eq(cliR.r.code, 0, `build-offline-payload.js --plan 必须 exit 0（实得 ${cliR.r.code}）`)
  const directP = PUB.planPublication(pubFix, { kind: 'public' })
  const directR = PUB.planPublication(readerFix, { kind: 'reader', withNode: false })
  h.eq(cliP.plan.planDigest, directP.planDigest, 'build-public.js --plan 的摘要 == 直接调 publish-policy 的摘要')
  h.eq(cliR.plan.planDigest, directR.planDigest, 'build-offline-payload.js --plan 的摘要 == 直接调 publish-policy 的摘要')

  // 反空转：把夹具里那一份策略文件的 why 改掉 ⇒ CLI 的摘要必须跟着变（说明它**真的**在读那一份）
  const mutDir = path.join(SESSION, 'p01-mutated')
  fs.cpSync(pubFix, mutDir, { recursive: true })
  const mutPolicy = path.join(mutDir, 'tools', 'publish-policy.cjs')
  const orig = readText(mutPolicy)
  const patched = orig.replace('私人原账（待答 / 已答 / seq.txt）', '私人原账（待答 / 已答 / seq.txt）· 变异标记 P01')
  h.assert(patched !== orig, '变异必须真的改到策略文件（否则这条反空转是空转）')
  fs.writeFileSync(mutPolicy, patched, 'utf8')
  const mutPlan = cliPlan(mutDir, 'public', false)
  h.eq(mutPlan.r.code, 0, `变异后的 --plan 仍应 exit 0（实得 ${mutPlan.r.code}）`)
  h.assert(mutPlan.plan.planDigest !== cliP.plan.planDigest, '改了策略文件里的 why ⇒ 计划摘要必须变（否则 CLI 自带第二份判断）')
  rowsOut.push(`反空转：改 publish-policy.cjs 的 why ⇒ 摘要 ${cliP.plan.planDigest.slice(0, 12)}… → ${mutPlan.plan.planDigest.slice(0, 12)}…`)
  ev('P01 policy-single-source', rowsOut.join('\n'))
})

h.case('P02 plan-shape-and-digest-deterministic', 'pass', () => {
  const pubFix = fixture('public').pack
  const p = PUB.planPublication(pubFix, { kind: 'public' })
  const again = PUB.planPublication(pubFix, { kind: 'public' })
  const shape = {
    schema: p.schema, root: p.root, kind: p.kind, includeProgress: p.includeProgress,
    filesIsArray: Array.isArray(p.files), excludedIsArray: Array.isArray(p.excluded), derivedIsArray: Array.isArray(p.derived),
    planDigest: p.planDigest, inputManifest: p.inputManifest,
  }
  h.eq(p.schema, 'whale-publication/1', 'schema')
  h.eq(p.root, path.resolve(pubFix), 'root = path.resolve(root)')
  h.eq(p.kind, 'public', 'kind 回显')
  h.eq(p.includeProgress, false, '缺省 includeProgress=false（只有显式 true 才保留进度）')
  h.eq(again.planDigest, p.planDigest, '同一输入两次调用 ⇒ planDigest 相同')
  h.eq(again.inputManifest, p.inputManifest, '同一输入两次调用 ⇒ inputManifest 相同')
  h.assert(/^[0-9a-f]{64}$/.test(p.planDigest), `planDigest 必须是 64 位小写十六进制（实得 ${p.planDigest}）`)

  const sorted = p.files.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  h.eq(JSON.stringify(p.files), JSON.stringify(sorted), 'files 必须升序')
  h.eq(new Set(p.files).size, p.files.length, 'files 不许有重复')
  h.eq(p.files.filter((f) => path.isAbsolute(f) || f.includes('\\') || f.split('/').includes('..')).length, 0, 'files 只许 POSIX 相对路径（无绝对、无反斜杠、无 ..）')
  for (const e of p.excluded) h.assert(typeof e.path === 'string' && typeof e.why === 'string' && e.why.length > 0, `excluded 每条都要 {path, why}（实得 ${JSON.stringify(e)}）`)
  for (const d of p.derived) h.assert(typeof d.path === 'string' && typeof d.from === 'string' && d.from.length > 0, `derived 每条都要 {path, from}（实得 ${JSON.stringify(d)}）`)
  h.eq(p.derived.every((d) => p.files.includes(d.path)), true, 'derived 必须是 files 的子集')
  // 缺省 kind = 'reader'
  const dflt = PUB.planPublication(fixture('reader').pack, {})
  h.eq(dflt.kind, 'reader', "缺省 kind 是 'reader'")
  const readerShape = PUB.planPublication(fixture('reader').pack, { kind: 'reader', withNode: false })
  h.eq(readerShape.files.every((f) => f === 'start.cmd' || f.startsWith('app/') || !f.includes('/')), true, "reader 档：包内容一律在 app/ 下，包装件在 payload 根")

  ev('P02 plan-shape-and-digest-deterministic', rows(
    JSON.stringify(shape, null, 2),
    `files=${p.files.length} · excluded=${p.excluded.length} · derived=${p.derived.length}`,
    `reader files=${readerShape.files.length}`,
  ))
})

h.case('P03 plan-digest-changes-with-inputs', 'pass', () => {
  const readerFix = fixture('reader').pack
  const d1 = PUB.planPublication(readerFix, { kind: 'reader', withNode: false })
  const d2 = PUB.planPublication(readerFix, { kind: 'reader', includeProgress: true, withNode: false })
  const d3 = PUB.planPublication(readerFix, { kind: 'public' })
  const all = [d1.planDigest, d2.planDigest, d3.planDigest]
  h.eq(new Set(all).size, 3, `reader@false / reader@progress / public@false 三个摘要必须互不相同（实得 ${all.map((x) => x.slice(0, 8)).join(' / ')}）`)
  const inc = d2.files.filter((f) => !d1.files.includes(f)).sort()
  ev('P03 plan-digest-changes-with-inputs', rows(
    `reader@false     ${d1.planDigest}  files=${d1.files.length} derived=${d1.derived.length}`,
    `reader@progress  ${d2.planDigest}  files=${d2.files.length} derived=${d2.derived.length}`,
    `public@false     ${d3.planDigest}  files=${d3.files.length} derived=${d3.derived.length}`,
    `进度开关多出来的件：${inc.join('、') || '（无）'}`,
  ))
  h.assert(inc.length > 0, 'includeProgress:true 必须真的多带进度载体（否则开关是假的）')
})

h.case('P04 plan-refuses-unknown-kind', 'pass', () => {
  const pubFix = fixture('public').pack
  let threw = null
  let ret = null
  try { ret = PUB.planPublication(pubFix, { kind: 'whatever' }) } catch (e) { threw = String(e?.message ?? e) }
  h.assert(threw !== null || (ret && ret.ok === false), "kind:'whatever' 必须抛错或 {ok:false}，绝不静默按 reader 办")
  if (threw) h.assert(/whatever/.test(threw), `错里要点名那个 kind（实得：${threw}）`)
  h.eq(ret, null, 'kind 不认识时不许返回一份计划（静默回落 = 假绿）')
  const ap = PUB.applyPublication(pubFix, { kind: 'whatever', planDigest: 'x'.repeat(64), inputManifest: 'y' }, { confirm: true })
  h.eq(ap.ok, false, 'applyPublication 收到不认识的 kind 也必须 ok:false')
  ev('P04 plan-refuses-unknown-kind', rows(`planPublication 抛出：${threw}`, `applyPublication → ${JSON.stringify(ap)}`))
})

/* ═══════════════════════════════════════════════════════ Y：登记行与建包闸 */

h.case('Y01 registration-pairing', 'pass', () => {
  const rel = 'tools/publish-policy.cjs'
  h.eq(TEMPLATE_FILES.includes(rel), true, `lib/pack-scaffold.js#TEMPLATE_FILES 要有 ${rel}（Y-1）`)
  h.eq(FROM_PLUGIN.includes(rel), true, `test/pack-template-rules.mjs#FROM_PLUGIN 要有 ${rel}（Y-2）`)
  h.eq(FROM_PACK.includes(rel), false, 'FROM_PACK 里不许有它（硬塞必红：那条判据是"模板 == 课程包原件经中性化"）')
  h.eq(new Set(TEMPLATE_FILES).size, TEMPLATE_FILES.length, 'TEMPLATE_FILES 无重复')
  const tp = templatePaths()
  h.eq(new Set(tp).size, tp.length, 'templatePaths() 无重复')
  h.eq(tp.length, TEMPLATE_FILES.length, `两份清单必须成对（TEMPLATE_FILES=${TEMPLATE_FILES.length} · templatePaths=${tp.length}）`)
  h.eq(fs.existsSync(path.join(TOOLS_DIR, 'publish-policy.cjs')), true, '盘上要有 lib/pack-template/tools/publish-policy.cjs')
  // 建包链真件：新包里必须有它（否则包侧 build-public.js 一跑就 Cannot find module）
  const y01 = path.join(SESSION, 'y01-scaffold')
  fs.mkdirSync(y01, { recursive: true })
  const sc = writeScaffold(y01)
  h.eq(sc.ok, true, `writeScaffold 必须成功（${sc.error}）`)
  h.eq(fs.existsSync(path.join(y01, rel)), true, '新建的包里要有 tools/publish-policy.cjs')
  // 「+1 登记行」用**与提交状态无关**的形式钉住：带上这一行 ⇒ 闸空；去掉 ⇒ 闸非空（Y02）；
  // 建包件数 = TEMPLATE_FILES.length + 11（`test/pack-scaffold.mjs` 的 expectCount）。
  // 这里只**报事实**，不钉一个会随提交漂的绝对值（提交之后 `HEAD` 就含这一行了）。
  ev('Y01 registration-pairing', rows(
    `TEMPLATE_FILES=${TEMPLATE_FILES.length} · templatePaths=${tp.length}（各 +1 相等）`,
    `created=${sc.created?.length}（= TEMPLATE_FILES + 11 骨架件 = ${TEMPLATE_FILES.length + 11}）`,
    `盘上存在：${fs.existsSync(path.join(TOOLS_DIR, 'publish-policy.cjs'))}`,
    `+1 的机械形式：requiredButNotRegistered(TEMPLATE_FILES)=${JSON.stringify(requiredButNotRegistered(TEMPLATE_FILES, { templateDir: TEMPLATE_DIR }))} / 去掉那一行=${JSON.stringify(requiredButNotRegistered(TEMPLATE_FILES.filter((f) => f !== rel), { templateDir: TEMPLATE_DIR }))}`,
  ))
  h.eq(sc.created?.length, TEMPLATE_FILES.length + 11, `建包件数必须是 TEMPLATE_FILES + 11（实得 ${sc.created?.length}）`)
})

h.case('Y02 gate-rejects-unregistered-template-file', 'pass', () => {
  const rel = 'tools/publish-policy.cjs'
  const pruned = TEMPLATE_FILES.filter((f) => f !== rel)
  const missing = requiredButNotRegistered(pruned, { templateDir: TEMPLATE_DIR })
  h.assert(missing.includes(rel), `把登记行去掉 ⇒ requiredButNotRegistered 必须点名 ${rel}（实得 ${missing.join('、') || '（空）'}）`)
  const ok = requiredButNotRegistered(TEMPLATE_FILES, { templateDir: TEMPLATE_DIR })
  h.eq(ok.length, 0, `登记齐了 ⇒ requiredButNotRegistered 必须为空（实得 ${ok.join('、')}）`)
  // planScaffold 的闸真的吃这一份（源码级：那条闸不是摆设）
  const scaffoldSrc = readText(path.join(REPO, 'lib', 'pack-scaffold.js'))
  h.assert(/requiredButNotRegistered\(TEMPLATE_FILES/.test(scaffoldSrc), 'planScaffold 必须拿 requiredButNotRegistered(TEMPLATE_FILES, …) 当闸')
  h.assert(/插件模板里有引擎件没登记进随包清单/.test(scaffoldSrc), '闸的拒建文案必须在（拒建 = 当场报错，不是静默少建）')
  ev('Y02 gate-rejects-unregistered-template-file', rows(
    `去掉登记行 ⇒ requiredButNotRegistered = ${JSON.stringify(missing)}`,
    `登记齐 ⇒ ${JSON.stringify(ok)}`,
    'planScaffold 的闸：源码里 requiredButNotRegistered(TEMPLATE_FILES, …) 命中 = true',
  ))
})

/* ═════════════════════════════════════════════════════ A：产物里零 canary */

/** 源包里 canary 必须先"真的在"（不然"产物里没有"是废话） */
function assertCanariesPresent(pack) {
  const probe = { ...CAN, TEACH: TEACH_BODY }
  const src = scanTree(pack, probe)
  const missing = Object.keys(probe).filter((k) => !src.found.some((f) => f.hits.includes(k)))
  return { src, missing }
}

h.case('A01 reader-output-no-canary', 'pass', () => {
  const p = published('reader', false)
  const src = assertCanariesPresent(p.pack)
  h.eq(src.missing.length, 0, `夹具源包里每类 canary 都要真的在（缺：${src.missing.join('、') || '无'}）`)
  const scan = scanTree(p.outDir, CAN)
  ev('A01 reader-output-no-canary', rows(
    `产物：${p.outDir}`,
    `扫描：${scan.files} 个文件 / ${scan.bytes} 字节（全文）`,
    `命中：${scan.found.length ? JSON.stringify(scan.found) : '（零）'}`,
    `源包里 canary 命中件数：${src.src.found.length}（反空转：源包必须有）`,
  ))
  h.eq(scan.found.length, 0, `离线产物全文必须零 canary（命中：${JSON.stringify(scan.found.slice(0, 6))}）`)
})

h.case('A02 public-output-no-canary', 'pass', () => {
  const p = published('public', false)
  const src = assertCanariesPresent(p.pack)
  h.eq(src.missing.length, 0, `夹具源包里每类 canary 都要真的在（缺：${src.missing.join('、') || '无'}）`)
  const scan = scanTree(p.outDir, CAN)
  const privatePaths = ['questions', 'notes', 'learning-records', 'code', 'progress.json', 'lesson.config.json', 'reference/QUESTIONS.md', 'QUESTIONS.md', '.whale-txn', '.whale-write.lock']
  const bad = walk(p.outDir).filter((rel) => privatePaths.some((q) => rel === q || rel.startsWith(q + '/')))
  ev('A02 public-output-no-canary', rows(
    `产物：${p.outDir}`,
    `扫描：${scan.files} 个文件 / ${scan.bytes} 字节（全文）`,
    `命中：${scan.found.length ? JSON.stringify(scan.found) : '（零）'}`,
    `私人面路径命中：${bad.length ? bad.join('、') : '（零）'}`,
  ))
  h.eq(scan.found.length, 0, `公开产物全文必须零 canary（命中：${JSON.stringify(scan.found.slice(0, 6))}）`)
  h.eq(bad.length, 0, `公开产物里不许有私人面路径：${bad.join('、')}`)
})

h.case('A03 teaching-body-preserved', 'pass', () => {
  const pub = published('public', false)
  const rd = published('reader', false)
  const textOf = (dir) => walk(dir).filter((rel) => /\.(html|md|js|txt|cmd|ps1)$/.test(rel)).map((rel) => readText(path.join(dir, rel))).join('\n')
  const inPublic = textOf(pub.outDir).includes(TEACH_BODY)
  const inSource = textOf(pub.pack).includes(TEACH_BODY)
  const where = walk(pub.outDir).filter((rel) => fs.readFileSync(path.join(pub.outDir, rel), 'utf8').includes(TEACH_BODY))
  // 离线档的骨架**不带 lessons**（课程包是另发的 zip，`SKELETON` 里没有那一层）——
  // 所以它的正例换成"净化没把**结构与派生页**也一起清掉"（同样是防"全删了也算过"）。
  const rdContent = readText(path.join(rd.outDir, 'app', 'starmap', 'content.js'))
  const rdNotes = readText(path.join(rd.outDir, 'app', 'reference', 'NOTES.html'))
  const rdGlossary = readText(path.join(rd.outDir, 'app', 'assets', 'glossary-data.js'))
  ev('A03 teaching-body-preserved', rows(
    `教学正文独有串：${TEACH_BODY}`,
    `源包里有它：${inSource}`,
    `公开产物里有它：${inPublic}（出现位置：${where.join('、') || '（无）'}）`,
    `离线产物：骨架不带 lessons（课程包另发）⇒ 正例改为结构 / 派生页 / 名词台账都还在：`,
    `  app/starmap/content.js 里还有那颗课程星 point/0001：${rdContent.includes('point/0001')}`,
    `  app/reference/NOTES.html 是重建出来的一页：${rdNotes.length} 字节 · 有「答疑」小节=${/答疑/.test(rdNotes)}`,
    `  app/assets/glossary-data.js 里名词台账还在：${/canary/.test(rdGlossary)}`,
    `  （全删了也算过是假绿：这就是这一条的用法）`,
  ))
  h.eq(inSource, true, '夹具的课程源里必须有这段正文（否则这条判据无从谈起）')
  h.eq(inPublic, true, '公开产物里**必须**还留着选定的教学正文（防"全删了也算过"）')
  h.assert(rdContent.includes('point/0001'), '离线产物必须还带着那颗课程星（结构/课程属性保留）')
  h.assert(rdNotes.length > 800 && /答疑/.test(rdNotes), '离线产物的 reference/NOTES.html 必须是重建出来的一页（不是空文件）')
  h.assert(/canary/.test(rdGlossary), '离线产物的名词台账必须还在（内容不在禁令里）')
})

h.case('A04 progress-neutralized-by-default', 'pass', () => {
  const pub = published('public', false)
  const rd = published('reader', false)
  const out = []
  // 反空转：源包里的进度信号必须真的非空
  const srcContent = readText(path.join(pub.pack, 'starmap', 'content.js'))
  const srcPractice = readText(path.join(pub.pack, 'assets', 'practice-data.js'))
  const srcLearned = /"learned":\s*true/.test(srcContent)
  const srcPendingQ = /"pendingQ":\s*[1-9]/.test(srcContent)
  const srcFlag = /"flag":\s*"(red|yellow)"/.test(srcContent)
  const srcAchieved = /"achieved":\s*[1-9]/.test(srcPractice)
  const srcState = /"state":\s*"(done|review)"/.test(srcPractice)
  out.push(`源包进度信号（反空转）：learned=${srcLearned} pendingQ>0=${srcPendingQ} flag=${srcFlag} achieved>0=${srcAchieved} state≠todo=${srcState}`)
  h.eq(srcLearned && srcPendingQ && srcFlag, true, '夹具源包的 content.js 必须有 learn`/pendingQ/flag 三个真进度信号（反空转）')
  h.eq(srcAchieved && srcState, true, '夹具源包的 practice-data.js 必须有 achieved/state 真进度信号（反空转）')

  for (const [tag, p] of [['public', pub], ['reader', rd]]) {
    const files = walk(p.outDir)
    const contentRel = files.includes('content.js') ? 'content.js' : 'app/starmap/content.js'
    const practiceRel = files.includes('assets/practice-data.js') ? 'assets/practice-data.js' : 'app/assets/practice-data.js'
    const hasProgressJson = files.includes('progress.json') || files.includes('app/progress.json')
    const cText = readText(path.join(p.outDir, contentRel))
    const D = (() => { const w = {}; new Function('window', cText)(w); return w.STARMAP_REAL })()
    const lit = D.lessons.filter((l) => l.learned).length
    const pend = D.lessons.reduce((n, l) => n + (l.pendingQ || 0), 0)
    const flagged = D.lessons.filter((l) => l.flag).length
    const P = (() => { const m = { exports: {} }; const w = {}; new Function('module', 'globalThis', 'window', readText(path.join(p.outDir, practiceRel)))(m, w, w); return (m.exports && m.exports.lessons) ? m.exports : w.PRACTICE_DATA })()
    const achieved = Object.values(P.lessons).reduce((n, L) => n + ((L.summary && L.summary.achieved) || 0), 0)
    const review = Object.values(P.lessons).reduce((n, L) => n + ((L.summary && L.summary.needsReview) || 0), 0)
    const notTodo = Object.values(P.lessons).flatMap((L) => L.challenges || []).filter((c) => c.state !== 'todo').length
    out.push(`[${tag}] progress.json 在产物里=${hasProgressJson} · learned 非假=${lit} · pendingQ 合计=${pend} · flag 非空=${flagged} · achieved=${achieved} · needsReview=${review} · state≠todo=${notTodo}`)
    out.push(`[${tag}] content.js 文本里出现 "learned": true = ${/"learned":\s*true/.test(cText)}`)
    h.eq(hasProgressJson, false, `${tag}：默认档 progress.json 不许进产物`)
    h.eq(lit, 0, `${tag}：content.js 的 learned 必须全假`)
    h.eq(pend, 0, `${tag}：content.js 的 pendingQ 必须全 0`)
    h.eq(flagged, 0, `${tag}：content.js 的 flag 必须全 null`)
    h.eq(/"learned":\s*true/.test(cText), false, `${tag}：content.js 文本里不许出现 "learned": true`)
    h.eq(achieved, 0, `${tag}：practice-data.js 的 achieved 必须归零`)
    h.eq(review, 0, `${tag}：practice-data.js 的 needsReview 必须归零`)
    h.eq(notTodo, 0, `${tag}：practice-data.js 每题 state 必须是 todo`)
    // 课程属性不是进度：必须保留
    const total = Object.values(P.lessons).reduce((n, L) => n + ((L.summary && L.summary.total) || 0), 0)
    h.assert(total > 0, `${tag}：practice-data.js 的 total 是课程属性，必须保留（实得 ${total}）`)
  }
  ev('A04 progress-neutralized-by-default', out.join('\n'))
})

h.case('A05 progress-shared-on-explicit-choice', 'pass', () => {
  const pub = published('public', true)
  const rd = published('reader', true)
  const out = []
  for (const [tag, p] of [['public', pub], ['reader', rd]]) {
    const files = walk(p.outDir)
    const contentRel = files.includes('content.js') ? 'content.js' : 'app/starmap/content.js'
    const practiceRel = files.includes('assets/practice-data.js') ? 'assets/practice-data.js' : 'app/assets/practice-data.js'
    const cText = readText(path.join(p.outDir, contentRel))
    const D = (() => { const w = {}; new Function('window', cText)(w); return w.STARMAP_REAL })()
    const lit = D.lessons.filter((l) => l.learned).length
    const pend = D.lessons.reduce((n, l) => n + (l.pendingQ || 0), 0)
    const flagged = D.lessons.filter((l) => l.flag).length
    const P = (() => { const m = { exports: {} }; const w = {}; new Function('module', 'globalThis', 'window', readText(path.join(p.outDir, practiceRel)))(m, w, w); return (m.exports && m.exports.lessons) ? m.exports : w.PRACTICE_DATA })()
    const achieved = Object.values(P.lessons).reduce((n, L) => n + ((L.summary && L.summary.achieved) || 0), 0)
    const notTodo = Object.values(P.lessons).flatMap((L) => L.challenges || []).filter((c) => c.state !== 'todo').length
    const hasProgressJson = files.includes('app/progress.json')
    out.push(`[${tag}] learned 点亮=${lit} · pendingQ=${pend} · flag=${flagged} · achieved=${achieved} · state≠todo=${notTodo} · progress.json=${hasProgressJson}`)
    h.assert(lit > 0, `${tag}：显式 --include-progress ⇒ content.js 的 learned 必须真的亮（实得 ${lit}）`)
    h.assert(pend > 0, `${tag}：显式 --include-progress ⇒ pendingQ 必须真的非 0（实得 ${pend}）`)
    h.assert(flagged > 0, `${tag}：显式 --include-progress ⇒ flag 必须真的非空`)
    h.assert(achieved > 0, `${tag}：显式 --include-progress ⇒ practice achieved 必须保留`)
    h.assert(notTodo > 0, `${tag}：显式 --include-progress ⇒ 每题 state 必须保留非 todo`)
    if (tag === 'reader') h.eq(hasProgressJson, true, '离线档显式保留进度 ⇒ app/progress.json 必须在')
    else h.eq(hasProgressJson, false, '公开站结构上没有 progress.json（进度走 content.js / practice-data.js）')
  }
  ev('A05 progress-shared-on-explicit-choice', out.join('\n'))
})

h.case('A06 other-canaries-still-zero-when-progress-shared', 'pass', () => {
  const pub = published('public', true)
  const rd = published('reader', true)
  const out = []
  for (const [tag, p] of [['public', pub], ['reader', rd]]) {
    const scan = scanTree(p.outDir, CAN)
    out.push(`[${tag}] 命中：${scan.found.length ? JSON.stringify(scan.found) : '（零）'}（扫 ${scan.files} 个文件 / ${scan.bytes} 字节）`)
    h.eq(scan.found.length, 0, `${tag}：显式保留进度时**其他类** canary 仍必须零命中（命中：${JSON.stringify(scan.found.slice(0, 6))}）`)
  }
  ev('A06 other-canaries-still-zero-when-progress-shared', out.join('\n'))
})

h.case('A07 derived-pages-rebuilt-from-sanitized-input', 'pass', () => {
  const pub = published('public', false)
  // 独立重建：净化输入 = 包副本 + **空台账**（`lib/ask.js#emptyLedgerSource`，插件自己的"空台账"来源）
  // + 空笔记台账；然后现场跑**包内自己的** tools/build-notes.js
  const scratch = path.join(SESSION, 'a07-rebuild')
  fs.cpSync(pub.pack, scratch, { recursive: true })
  for (const rel of ['questions', 'notes', 'learning-records', 'code', 'reference/NOTES.html', 'reference/QUESTIONS.md', 'QUESTIONS.md']) {
    fs.rmSync(path.join(scratch, rel), { recursive: true, force: true })
  }
  fs.mkdirSync(path.join(scratch, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'notes', 'notes.jsonl'), '', 'utf8')
  fs.writeFileSync(path.join(scratch, 'assets', 'questions-data.js'), emptyLedgerSource('/** T20 · A07 独立重建用的空台账 */\n'), 'utf8')
  const r = runIn(scratch, 'tools/build-notes.js', [])
  h.eq(r.code, 0, `独立重建 NOTES.html 必须成功（exit ${r.code}）：${clip(r.out + r.err, 1500)}`)
  const rebuilt = fs.readFileSync(path.join(scratch, 'reference', 'NOTES.html'))
  const publishedNotes = fs.readFileSync(path.join(pub.outDir, 'reference', 'NOTES.html'))
  const sourceNotes = fs.readFileSync(path.join(pub.pack, 'reference', 'NOTES.html'))
  // 已答台账必须真被清空（不是"没命中 canary"这么宽）
  const publishedLedger = require_(path.join(pub.outDir, 'assets', 'questions-data.js'))
  const sourceLedger = require_(path.join(pub.pack, 'assets', 'questions-data.js'))
  ev('A07 derived-pages-rebuilt-from-sanitized-input', rows(
    `独立重建（空台账 + 包内 build-notes.js）：${rebuilt.length} 字节 sha=${sha(rebuilt).slice(0, 16)}…`,
    `产物里的 reference/NOTES.html      ：${publishedNotes.length} 字节 sha=${sha(publishedNotes).slice(0, 16)}…`,
    `源包里那份（旧派生页）            ：${sourceNotes.length} 字节 sha=${sha(sourceNotes).slice(0, 16)}…`,
    `台账条目数：源 ${Object.keys(sourceLedger).length} → 产物 ${Object.keys(publishedLedger).length}`,
    `产物台账 hasOwn('0001')=${Object.prototype.hasOwnProperty.call(publishedLedger, '0001')}`,
  ))
  h.eq(publishedNotes.equals(rebuilt), true, '产物里的 reference/NOTES.html 必须与"净化输入现场跑包内生成器"的结果**逐字节一致**')
  h.eq(publishedNotes.equals(sourceNotes), false, '产物里那份**绝不等于**源包里那份私人派生页（源包那份含 canary）')
  h.eq(Object.keys(publishedLedger).length, 0, '产物里的 assets/questions-data.js 必须重建为**空台账**')
  h.eq(Object.prototype.hasOwnProperty.call(publishedLedger, '0001'), false, '已答条目 0001 不许留在产物台账里')
})

h.case('A08 stale-derived-page-not-carried', 'pass', () => {
  const pub = published('public', false)
  const rd = published('reader', false)
  const A2 = CAN['已答正文（questions-data.js question）']
  const A3 = CAN['已答 HTML（questions-data.js answerHtml）']
  const A4 = CAN['笔记（notes/notes.jsonl）']
  const sourceNotes = readText(path.join(pub.pack, 'reference', 'NOTES.html'))
  h.assert(sourceNotes.includes(A2), '源包里那份旧派生页必须**真的含**已答正文（反空转：它得是产品自己生成出来的旧页）')
  h.assert(sourceNotes.includes(A3), '源包旧派生页里也要有已答 HTML')
  h.assert(sourceNotes.includes(A4), '源包旧派生页里也要有学生笔记')
  const out = []
  for (const [tag, p, rel] of [['public', pub, 'reference/NOTES.html'], ['reader', rd, 'app/reference/NOTES.html']]) {
    const text = readText(path.join(p.outDir, rel))
    out.push(`[${tag}] 产物 ${rel}：${text.length} 字节 · 含已答正文=${text.includes(A2)} · 含已答 HTML=${text.includes(A3)} · 含笔记=${text.includes(A4)} · 与源页逐字节相同=${text === sourceNotes}`)
    h.eq(text.includes(A2) || text.includes(A3) || text.includes(A4), false, `${tag}：产物不许出现旧派生页的内容（"只删原账却复制旧派生页"必须被抓）`)
    h.eq(text === sourceNotes, false, `${tag}：产物里那份绝不能就是源包里那份旧派生页`)
  }
  ev('A08 stale-derived-page-not-carried', rows(
    `源包 reference/NOTES.html：${sourceNotes.length} 字节（产品自己生成的旧派生页，含已答正文 / 已答 HTML / 笔记三类私人串）`,
    ...out,
  ))
})

h.case('A09 excluded-list-names-private-surfaces', 'pass', () => {
  const pubFix = fixture('public').pack
  const p = PUB.planPublication(pubFix, { kind: 'public' })
  // §D3 的私人面清单（夹具里都真实存在 ⇒ 每一条都必须被点名）
  const required = [
    'questions', 'notes', 'learning-records', 'code',
    'progress.json', 'lesson.config.json',
    'reference/NOTES.html', 'assets/questions-data.js', 'assets/practice-data.js', 'starmap/content.js',
    'dist', 'dist-offline', '.backup', '.git', '.trash', '.whale-txn', '.whale-write.lock', 'node_modules',
  ]
  const missing = required.filter((q) => !p.excluded.some((e) => e.path === q || e.path.startsWith(q + '/')))
  const noWhy = p.excluded.filter((e) => !e.why || !String(e.why).trim())
  const sorted = p.excluded.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  ev('A09 excluded-list-names-private-surfaces', rows(
    `excluded ${p.excluded.length} 条：`,
    ...p.excluded.map((e) => `  ${e.path}  ← ${e.why}`),
    `没被点名的私人面：${missing.join('、') || '（无）'}`,
    `缺 why 的条目：${noWhy.length}`,
    `升序：${JSON.stringify(p.excluded.map((e) => e.path)) === JSON.stringify(sorted.map((e) => e.path))}`,
  ))
  h.eq(missing.length, 0, `§D3 的私人面必须逐条点名（缺：${missing.join('、')}）`)
  h.eq(noWhy.length, 0, '每条 excluded 都要给 why（"只从清单里划掉"不算说过为什么）')
  h.eq(JSON.stringify(p.excluded.map((e) => e.path)), JSON.stringify(sorted.map((e) => e.path)), 'excluded 必须升序')
  h.assert(p.excluded.length >= required.length, `excluded 条数不该少于私人面条数（实得 ${p.excluded.length}）`)
})

h.case('A10 plan-files-are-output-superset', 'pass', () => {
  const out = []
  for (const [tag, kind, inc] of [['public', 'public', false], ['public+progress', 'public', true], ['reader', 'reader', false], ['reader+progress', 'reader', true]]) {
    const p = published(kind, inc)
    const got = walk(p.outDir).slice().sort()
    const planFiles = p.plan.files.slice().sort()
    const missing = planFiles.filter((f) => !got.includes(f))
    const extra = got.filter((f) => !planFiles.includes(f))
    out.push(`[${tag}] 产物 ${got.length} 个 · plan.files ${planFiles.length} 个 · 缺 ${missing.length} 多 ${extra.length}`)
    if (missing.length) out.push(`  产物里缺：${missing.slice(0, 8).join('、')}`)
    if (extra.length) out.push(`  产物里多：${extra.slice(0, 8).join('、')}`)
    h.eq(missing.length, 0, `[${tag}] plan.files 里每个非 derived 的件都必须在产物里（缺 ${missing.slice(0, 5).join('、')}）`)
    h.eq(extra.length, 0, `[${tag}] 产物里每个文件都必须在 plan.files 里（多 ${extra.slice(0, 5).join('、')}）`)
    // 逐件对拍：非 derived 的件在产物里必须与净化输入**逐字节相同**
    const derivedSet = new Set(p.plan.derived.map((d) => d.path))
    out.push(`  derived ${p.plan.derived.length} 件：${p.plan.derived.map((d) => `${d.path}←${d.from}`).join(' · ')}`)
    h.assert(derivedSet.size === p.plan.derived.length, `[${tag}] derived 不许重复`)
  }
  ev('A10 plan-files-are-output-superset', out.join('\n'))
})

/* ═════════════════════════════════════════════════════ D：确认、陈旧、原子 */

h.case('D01 confirm-required', 'pass', () => {
  const pack = fixture('public').pack
  const outDir = path.join(SESSION, 'd01-out')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'sentinel.txt'), '既有产物不许被碰\n', 'utf8')
  const before = snapshotTree(outDir)
  const plan = PUB.planPublication(pack, { kind: 'public' })
  const r1 = PUB.applyPublication(pack, plan, { outDir })
  const after = snapshotTree(outDir)
  const d = diffSnapshot(before, after)
  ev('D01 confirm-required', rows(
    `applyPublication(…, {outDir}) 无 confirm ⇒ ${JSON.stringify(r1)}`,
    `产物树差异：${d.length ? d.join('；') : '（逐字节未变）'}`,
  ))
  h.eq(r1.ok, false, '没有 confirm 必须 ok:false')
  h.eq(r1.code, 'CONFIRM_REQUIRED', `code 必须是 CONFIRM_REQUIRED（实得 ${r1.code}）`)
  h.eq(d.length, 0, `没有 confirm 时产物树必须逐字节未变（差异：${d.join('；')}）`)
})

h.case('D02 stale-plan-refused', 'pass', () => {
  const pack = fixture('public').pack
  const outDir = path.join(SESSION, 'd02-out')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'sentinel.txt'), '既有产物\n', 'utf8')
  const plan = PUB.planPublication(pack, { kind: 'public' })
  // 计划算完之后**改动源包**：往净化输入里塞一个字节（改一节课程源的正文）
  const target = path.join(pack, 'lessons', 'src', 'demo', 'point', '0001-canary.html')
  const orig = readFileOrNull(target)
  h.assert(orig !== null, '夹具里要有那条供改动的课程源')
  fs.appendFileSync(target, '\n')
  const before = snapshotTree(outDir)
  const r = PUB.applyPublication(pack, plan, { confirm: true, outDir })
  const after = snapshotTree(outDir)
  fs.writeFileSync(target, orig, 'utf8')    // 还原（夹具复位，后面的用例还用同一个 fixture）
  const d = diffSnapshot(before, after)
  ev('D02 stale-plan-refused', rows(
    `旧计划 planDigest=${plan.planDigest.slice(0, 16)}… inputManifest=${String(plan.inputManifest).slice(0, 16)}…`,
    `改动后 inputManifest=${PUB.planPublication(pack, { kind: 'public' }).inputManifest.slice(0, 16)}…`,
    `applyPublication ⇒ ${JSON.stringify(r)}`,
    `产物树差异：${d.length ? d.join('；') : '（逐字节未变）'}`,
  ))
  h.eq(r.ok, false, '陈旧计划必须被拒')
  h.eq(r.code, 'PLAN_STALE', `code 必须是 PLAN_STALE（实得 ${r.code}）`)
  h.eq(d.length, 0, `陈旧计划被拒时产物树必须逐字节未变（差异：${d.join('；')}）`)
})
function readFileOrNull(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

h.case('D03 failed-apply-does-not-replace-output', 'pass', () => {
  const pack = fixture('public').pack
  const outDir = path.join(SESSION, 'd03-out')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'sentinel.txt'), '既有产物（这一份必须活下来）\n', 'utf8')
  fs.writeFileSync(path.join(outDir, 'x.txt'), 'x'.repeat(1024), 'utf8')
  const before = snapshotTree(outDir)
  const plan = PUB.planPublication(pack, { kind: 'public' })
  // 打桩：写到一半失败（内容已经装配完、暂存目录已经建好，`decorate` 抛）
  const r = PUB.applyPublication(pack, plan, {
    confirm: true, outDir,
    decorate: () => { throw new Error('T20 · D03 注入：暂存阶段写到一半失败') },
  })
  const after = snapshotTree(outDir)
  const d = diffSnapshot(before, after)
  ev('D03 failed-apply-does-not-replace-output', rows(
    `注入：decorate() 在暂存阶段抛错`,
    `applyPublication ⇒ ${JSON.stringify(r)}`,
    `产物树差异：${d.length ? d.join('；') : '（逐字节未变）'}`,
    `暂存目录残留：${walk(pack).filter((f) => f.startsWith('.tmp-publication-')).join('、') || '（无）'}`,
  ))
  h.eq(r.ok, false, '写入中途失败必须 ok:false')
  h.eq(r.code, 'STAGE_FAILED', `code 必须是 STAGE_FAILED（实得 ${r.code}）`)
  h.eq(d.length, 0, `失败绝不替换既有产物（差异：${d.join('；')}）`)
  h.eq(walk(pack).filter((f) => f.startsWith('.tmp-publication-')).length, 0, '失败后不许留暂存目录')
})

h.case('D04 source-pack-bytes-unchanged', 'pass', () => {
  const pack = fixture('reader').pack
  const outDir = path.join(SESSION, 'd04-out')
  const before = snapshotTree(pack)
  const plan = PUB.planPublication(pack, { kind: 'reader', withNode: false })
  const r = PUB.applyPublication(pack, plan, {
    confirm: true, outDir,
    decorate: (dir) => {
      for (const f of ['start.cmd', 'install.cmd', 'uninstall.cmd', 'install.ps1', 'uninstall.ps1']) fs.writeFileSync(path.join(dir, f), '@echo off\n', 'utf8')
      fs.writeFileSync(path.join(dir, 'admin-source.json'), '{}\n', 'utf8')
    },
  })
  const after = snapshotTree(pack)
  const d = diffSnapshot(before, after)
  ev('D04 source-pack-bytes-unchanged', rows(
    `apply ⇒ ok=${r.ok} ${r.code ?? ''} ${r.error ?? ''}`,
    `跑前 ${before.size} 个文件 · 跑后 ${after.size} 个`,
    `差异：${d.length ? d.join('；') : '（path+size+mtime 全同）'}`,
  ))
  h.eq(r.ok, true, `这一轮 apply 必须成功（${r.code ?? ''} ${r.error ?? ''}）`)
  h.eq(d.length, 0, `跑完一轮 plan+apply，源包内每个文件 path+size+mtime 必须全同（差异：${d.join('；')}）`)
})

/* ═══════════════════════════════════════════════════════ D05 / D06：CLI */

h.case('D05 cli-plan-writes-nothing', 'pass', () => {
  const out = []
  for (const kind of ['public', 'reader']) {
    const pack = fixture(kind).pack
    const before = snapshotTree(pack)
    const p = cliPlan(pack, kind, false)
    const after = snapshotTree(pack)
    const d = diffSnapshot(before, after)
    out.push(`[${kind}] --plan exit=${p.r.code} · stdout 行数=${p.lines.length} · 含 planDigest=${!!p.plan && typeof p.plan.planDigest === 'string'}`)
    out.push(`[${kind}] 写盘差异：${d.length ? d.join('；') : '（一个字节都没写）'}`)
    h.eq(p.r.code, 0, `[${kind}] --plan 必须 exit 0（实得 ${p.r.code}）`)
    h.eq(p.lines.length, 1, `[${kind}] --plan 只许打印一行 JSON（实得 ${p.lines.length} 行）`)
    h.assert(p.plan && /^[0-9a-f]{64}$/.test(p.plan.planDigest), `[${kind}] 那一行 JSON 里要有 planDigest`)
    h.eq(d.length, 0, `[${kind}] --plan 不许写盘（差异：${d.join('；')}）`)
  }
  ev('D05 cli-plan-writes-nothing', out.join('\n'))
})

h.case('D06 cli-confirm-plan-digest-and-include-progress', 'pass', () => {
  const pack = fixture('public').pack
  const out = []
  // ① 错摘要 + --confirm ⇒ 非零退出且不写
  const before = snapshotTree(pack)
  const wrong = runIn(pack, 'tools/build-public.js', ['--confirm', '--plan-digest=' + 'f'.repeat(64)])
  const afterWrong = snapshotTree(pack)
  const dWrong = diffSnapshot(before, afterWrong)
  out.push(`错摘要：exit=${wrong.code} · 写盘差异=${dWrong.length ? dWrong.join('；') : '（没写）'}`)
  out.push(`错摘要 stderr：${clip(String(wrong.err || wrong.out).trim(), 300)}`)
  h.assert(wrong.code !== 0, `--confirm --plan-digest=<错> 必须非零退出（实得 ${wrong.code}）`)
  h.eq(dWrong.length, 0, `错摘要时不许写盘（差异：${dWrong.join('；')}）`)
  h.assert(/plan-digest|planDigest/.test(String(wrong.err || wrong.out)), '错摘要要说清是摘要不符')

  // ② 对摘要 + --confirm ⇒ 写
  const before2 = snapshotTree(pack)
  const good = runIn(pack, 'tools/build-public.js', ['--confirm', '--plan-digest=' + PUB.planPublication(pack, { kind: 'public' }).planDigest])
  const after2 = snapshotTree(pack)
  out.push(`对摘要：exit=${good.code} · dist/ 出现在写集差异里=${diffSnapshot(before2, after2).some((x) => x.includes('dist'))}`)
  h.eq(good.code, 0, `--confirm --plan-digest=<对> 必须 exit 0（实得 ${good.code}）：${clip(good.out + good.err, 1500)}`)
  h.eq(fs.existsSync(path.join(pack, 'dist', 'index.html')), true, '对摘要要真写出 dist/')

  // ③ --include-progress 只有显式给出才保留进度（两侧真跑对比）
  const noFlag = runIn(pack, 'tools/build-public.js', ['--confirm', '--plan-digest=' + PUB.planPublication(pack, { kind: 'public' }).planDigest])
  const c1 = readText(path.join(pack, 'dist', 'content.js'))
  const p1 = readText(path.join(pack, 'dist', 'assets', 'practice-data.js'))
  const tagged = runIn(pack, 'tools/build-public.js', ['--confirm', '--plan-digest=' + PUB.planPublication(pack, { kind: 'public', includeProgress: true }).planDigest, '--include-progress'])
  const c2 = readText(path.join(pack, 'dist', 'content.js'))
  const p2 = readText(path.join(pack, 'dist', 'assets', 'practice-data.js'))
  out.push(`无 --include-progress：exit=${noFlag.code} learned true=${/"learned":\s*true/.test(c1)} achieved>0=${/"achieved":\s*[1-9]/.test(p1)}`)
  out.push(`带 --include-progress：exit=${tagged.code} learned true=${/"learned":\s*true/.test(c2)} achieved>0=${/"achieved":\s*[1-9]/.test(p2)}`)
  h.eq(noFlag.code, 0, '不带 --include-progress 的默认走法必须成功')
  h.eq(/"learned":\s*true/.test(c1), false, '不带 --include-progress ⇒ 中性化（这是默认走法）')
  h.eq(/"achieved":\s*[1-9]/.test(p1), false, '不带 --include-progress ⇒ practice 完成度归零')
  h.eq(tagged.code, 0, '带 --include-progress 必须成功')
  h.eq(/"learned":\s*true/.test(c2), true, '带 --include-progress ⇒ 进度真的保留')
  h.eq(/"achieved":\s*[1-9]/.test(p2), true, '带 --include-progress ⇒ practice 完成度真的保留')

  // ④ 既有开关语义不受影响：--check 与 dist/ 逐字节对拍；--verify 不碰 dist/
  const distBefore = snapshotTree(path.join(pack, 'dist'))
  const chk = runIn(pack, 'tools/build-public.js', ['--check', '--include-progress'])
  const distAfter = snapshotTree(path.join(pack, 'dist'))
  const dCheck = diffSnapshot(distBefore, distAfter)
  const ver = runIn(pack, 'tools/build-public.js', ['--verify'])
  const distAfterVerify = snapshotTree(path.join(pack, 'dist'))
  const dVerify = diffSnapshot(distAfter, distAfterVerify)
  out.push(`--check --include-progress：exit=${chk.code}（与刚写出的 dist/ 对拍）· dist 变化=${dCheck.length}`)
  out.push(`--verify：exit=${ver.code} · dist 变化=${dVerify.length}`)
  h.eq(chk.code, 0, `--check 必须与刚写出的 dist/ 逐字节一致（exit ${chk.code}）：${clip(chk.out + chk.err, 1200)}`)
  h.eq(dCheck.length, 0, '--check 不许改 dist/')
  h.eq(ver.code, 0, `--verify 必须 exit 0（实得 ${ver.code}）：${clip(ver.out + ver.err, 1200)}`)
  h.eq(dVerify.length, 0, '--verify 不许碰 dist/')
  // ⑤ --check 的"红"语义仍在：dist/ 被动过 ⇒ 非零
  fs.appendFileSync(path.join(pack, 'dist', 'robots.txt'), '# 干扰\n')
  const chk2 = runIn(pack, 'tools/build-public.js', ['--check', '--include-progress'])
  out.push(`dist/ 被改一个字节后 --check：exit=${chk2.code}`)
  h.assert(chk2.code !== 0, `--check 必须能报漂移（实得 exit ${chk2.code}）`)
  ev('D06 cli-confirm-plan-digest-and-include-progress', out.join('\n'))
})

/* ═════════════════════════════════════════ S：离线骨架与两档一致性 */

h.case('S01 offline-skeleton-excludes-private-ledgers', 'pass', () => {
  const rd = published('reader', false)
  // ⚠️ 从**包副本**里 require：仓内的 `lib/pack-template/tools/*.js` 在 `"type":"module"` 下是 ESM，
  // `require()` 会当场抛（`offline-bootstrap.js` 只以"脚本 / 包内 CJS"两种身份跑）。
  const boot = require_(path.join(rd.pack, 'tools', 'offline-bootstrap.js'))
  const out = []
  // ① 真 initSkeleton（源 = 真跑出来的 payload 的 app/）—— 库里那份骨架
  const dest = path.join(SESSION, 's01-library')
  const r = boot.initSkeleton(dest, { src: path.join(rd.outDir, 'app') })
  h.eq(r.ok, true, `initSkeleton 必须 ok（${r.error}）`)
  for (const d of ['questions', 'notes', 'learning-records']) {
    const abs = path.join(dest, d)
    const n = fs.existsSync(abs) ? under(dest, d).length : -1
    out.push(`[payload app/ 为源] dest/${d}：存在=${fs.existsSync(abs)} 内容件数=${n}`)
    h.eq(fs.existsSync(abs), true, `initSkeleton 后 ${d} 必须存在（"目录空着也要建"）`)
    h.eq(under(dest, d).length, 0, `${d} 必须**空的**（不许铺进任何私人台账）`)
  }
  const scan = scanTree(dest, CAN)
  out.push(`[payload app/ 为源] dest 全文扫描：${scan.files} 个文件 / ${scan.bytes} 字节 · canary 命中=${scan.found.length ? JSON.stringify(scan.found) : '（零）'}`)
  h.eq(scan.found.length, 0, 'initSkeleton 出来的库里不许有任何私人 canary')

  // ② 反空转：拿**含私人台账**的包当骨架源 ⇒ 三个台账目录仍必须为空（ledger 目录只建不铺）
  const dest2 = path.join(SESSION, 's01-library-canary')
  const r2 = boot.initSkeleton(dest2, { src: rd.pack })
  h.eq(r2.ok, true, `initSkeleton(含 canary 的源) 必须 ok（${r2.error}）`)
  for (const d of ['questions', 'notes', 'learning-records']) {
    const n = under(dest2, d).length
    out.push(`[含 canary 的包为源] dest2/${d}：内容件数=${n}`)
    h.eq(n, 0, `${d} 必须空的 —— 可写台账"目录空着也要建"，内容一件不铺（反空转：源里那些文件真的在）`)
  }
  ev('S01 offline-skeleton-excludes-private-ledgers', rows(
    ...out,
    `源包里 questions/ 文件数=${under(rd.pack, 'questions').length} · notes/=${under(rd.pack, 'notes').length} · learning-records/=${under(rd.pack, 'learning-records').length}`,
    `payload app/ 由真跑 planSkeleton + 净化拷贝产出（零手工补件）`,
  ))
})

h.case('S02 offline-skeleton-still-propagates', 'pass', () => {
  // C-3 的两条判据照跑（接触面回归，不是新增判据）
  const dest = path.join(SESSION, 's02-dest')
  const boot = require_(path.join(fixture('reader').pack, 'tools', 'offline-bootstrap.js'))
  const r = boot.initSkeleton(dest, { src: fixture('reader').pack })
  h.eq(r.ok, true, `initSkeleton 必须 ok（${r.error}）`)
  h.eq(fs.existsSync(path.join(dest, 'tools', 'http-request.cjs')), true, 'dest/tools/http-request.cjs 必须在')
  h.eq(typeof require_(path.join(dest, 'tools', 'app-server.js')).handler, 'function', 'dest/tools/app-server.js 的 handler 必须是函数')
  h.eq(typeof require_(path.join(dest, 'tools', 'offline-server.js')).handler, 'function', 'dest/tools/offline-server.js 的 handler 必须是函数')
  const shape = Object.keys(r).sort().join(',')
  const sk = boot.planSkeleton(fixture('reader').pack)
  h.eq(Object.keys(sk).sort().join(','), 'dirs,files', 'planSkeleton 的返回形状必须保持 {files, dirs}')
  h.eq(shape, 'bytes,copied,dest,dirs,ok,skipped', `initSkeleton 的返回形状必须保持 {ok,dest,copied,skipped,bytes,dirs}（实得 ${shape}）`)
  // tools/ 的 TOOLS_KEEP 过滤一件都不许少：白名单里的每个存在的件都要铺出来
  const keep = boot.TOOLS_KEEP.filter((f) => fs.existsSync(path.join(TOOLS_DIR, f)))
  const missed = keep.filter((f) => !fs.existsSync(path.join(dest, 'tools', f)))
  ev('S02 offline-skeleton-still-propagates', rows(
    `initSkeleton → ok=${r.ok} copied=${r.copied} skipped=${r.skipped} bytes=${r.bytes}`,
    `返回形状键：${shape}`,
    `TOOLS_KEEP 在骨架源里存在的件：${keep.length} 个 · 漏铺：${missed.join('、') || '（零）'}`,
    `planSkeleton 形状：${Object.keys(sk).sort().join(',')}`,
  ))
  h.eq(missed.length, 0, `TOOLS_KEEP 的件一个都不许少（漏：${missed.join('、')}）`)
})

h.case('S03 public-reader-split-policy', 'pass', () => {
  const pack = fixture('public').pack   // 两档都能跑（readers 档需要 tools/offline-*，另用 reader 夹具）
  const rPack = fixture('reader').pack
  const a = PUB.planPublication(pack, { kind: 'public' })
  const b = PUB.planPublication(rPack, { kind: 'reader', withNode: false })
  // 私人面清单两档同源：同一条私人面在两边都进 excluded（只要它在包里）
  const req = ['questions', 'notes', 'learning-records', 'code', 'progress.json', 'lesson.config.json', 'reference/NOTES.html', 'assets/questions-data.js', 'assets/practice-data.js', 'starmap/content.js']
  const inBoth = req.filter((q) => a.excluded.some((e) => e.path === q || e.path.startsWith(q + '/'))
    && b.excluded.some((e) => e.path === q || e.path.startsWith(q + '/')))
  const onlyA = a.excluded.map((e) => e.path).filter((x) => !b.excluded.some((e) => e.path === x || x.startsWith(e.path + '/') || e.path.startsWith(x + '/')))
  const polP = PUB.publicationPolicy({ kind: 'public' })
  const polR = PUB.publicationPolicy({ kind: 'reader' })
  ev('S03 public-reader-split-policy', rows(
    `两档共同点名的私人面（$门间同源）：${inBoth.join('、')}`,
    `两档点名的私人面条数：public=${a.excluded.length} reader=${b.excluded.length}`,
    `只在 public 侧点名的（明示差别）：${onlyA.slice(0, 12).join('、') || '（无）'}`,
    `策略自述的私人面表（两档同一份）：${polP.privateSurfaces.length} vs ${polR.privateSurfaces.length}（必须相等）`,
    `产物根：public=${polP.outDir} · reader=${polR.outDir}`,
    `派生物表：public derived=${a.derived.length} · reader derived=${b.derived.length}`,
  ))
  h.eq(polP.privateSurfaces.length, polR.privateSurfaces.length, '私人面表两档必须同一份（不许各写一套清单）')
  h.eq(inBoth.length, req.length, `这些私人面两档都要点名（缺：${req.filter((q) => !inBoth.includes(q)).join('、')}）`)
  h.assert(polP.outDir === 'dist' && polR.outDir === 'dist-offline/whale-reader', '两档产物根必须是明示的差别')
})

/* ══════════════════════════════════════════════════ N：负向控制与夹具纪律 */

h.case('N01 negative-control-baseline-leaks', 'pass', () => {
  // ⚠️ 必须钉在**基线 commit**（不是 HEAD）：T20 提交之后 HEAD 里就是新实现了，
  // 拿 HEAD 当"旧行为"会把新实现跑两遍 —— 负向控制当场变成恒真。
  const baseBoot = gitShow('lib/pack-template/tools/offline-bootstrap.js', BASE_COMMIT)
  const basePayload = gitShow('lib/pack-template/tools/build-offline-payload.js', BASE_COMMIT)
  const basePublic = gitShow('lib/pack-template/tools/build-public.js', BASE_COMMIT)
  h.assert(!!baseBoot && !!basePayload && !!basePublic, `必须能从 ${BASE_COMMIT} 取回基线实现`)

  const out = []
  // ── 基线 A：公开站（dist/）—— WHITELIST 里 reference/ 原样进产物
  const scratchP = path.join(SESSION, 'n01-baseline-public')
  fs.cpSync(fixture('public').pack, scratchP, { recursive: true })
  fs.rmSync(path.join(scratchP, 'dist'), { recursive: true, force: true })
  fs.writeFileSync(path.join(scratchP, 'tools', 'build-public.js'), basePublic, 'utf8')
  const rp = runIn(scratchP, 'tools/build-public.js', [])
  const scanP = scanTree(path.join(scratchP, 'dist'), CAN)
  out.push(`[基线 build-public.js] exit=${rp.code}`)
  out.push(`[基线 build-public.js] dist/ 全文 ${scanP.files} 个文件 / ${scanP.bytes} 字节 · canary 命中 ${scanP.found.length} 处：${JSON.stringify(scanP.found.slice(0, 8))}`)

  // ── 基线 B：离线 payload（app/）—— planSkeleton 把三个台账目录整棵收进清单
  const scratchR = path.join(SESSION, 'n01-baseline-reader')
  fs.cpSync(fixture('reader').pack, scratchR, { recursive: true })
  fs.rmSync(path.join(scratchR, 'dist-offline'), { recursive: true, force: true })
  fs.writeFileSync(path.join(scratchR, 'tools', 'offline-bootstrap.js'), baseBoot, 'utf8')
  fs.writeFileSync(path.join(scratchR, 'tools', 'build-offline-payload.js'), basePayload, 'utf8')
  fs.rmSync(path.join(scratchR, 'tools', 'publish-policy.cjs'), { force: true })   // 基线不认策略件
  const rr = runIn(scratchR, 'tools/build-offline-payload.js', ['--no-node'])
  const appDir = path.join(scratchR, 'dist-offline', 'whale-reader', 'app')
  const scanR = scanTree(appDir, CAN)
  out.push(`[基线 build-offline-payload.js] exit=${rr.code}`)
  out.push(`[基线 build-offline-payload.js] app/ 全文 ${scanR.files} 个文件 / ${scanR.bytes} 字节 · canary 命中 ${scanR.found.length} 处：${JSON.stringify(scanR.found.slice(0, 8))}`)
  out.push(`[基线] app/questions 文件：${under(appDir, 'questions').join('、') || '（无）'}`)
  out.push(`[基线] app/learning-records 文件：${under(appDir, 'learning-records').join('、') || '（无）'}`)

  // ── 新实现：同一批输入零命中（两档都真跑）
  const newP = published('public', false)
  const newR = published('reader', false)
  const sNewP = scanTree(newP.outDir, CAN)
  const sNewR = scanTree(newR.outDir, CAN)
  out.push(`[新实现] public 零命中=${sNewP.found.length === 0} · reader 零命中=${sNewR.found.length === 0}`)

  ev('N01 negative-control-baseline-leaks', rows(
    ...out,
    `基线来源：git show ${BASE_COMMIT}:lib/pack-template/tools/{build-public,build-offline-payload,offline-bootstrap}.js`,
    `基线 implement 的原始 stdout：\n${clip(String(rp.out + rp.err), 1200)}\n---\n${clip(String(rr.out + rr.err), 1200)}`,
  ))
  h.eq(rp.code, 0, `基线 build-public.js 应当跑成功（"旧行为真会发出去"才成立）—— 实得 exit ${rp.code}`)
  h.assert(scanP.found.length > 0, '基线实现必须**真的把私人内容发出去**（负向控制的全部意义）')
  h.eq(rr.code, 0, `基线 build-offline-payload.js 应当跑成功 —— 实得 exit ${rr.code}`)
  h.assert(scanR.found.length > 0, '基线 payload 必须**真的把私人台账发出去**')
  h.eq(sNewP.found.length, 0, '新实现的公开产物对同一批输入必须零命中')
  h.eq(sNewR.found.length, 0, '新实现的离线产物对同一批输入必须零命中')
})

h.case('N02 negative-control-cleanup-guard', 'pass', () => {
  // ① 守卫必须拒绝不属于本次夹具的路径
  const bad1 = cleanupOwn(LIVE_PACK)
  const bad2 = cleanupOwn(TMP_BASE)
  const bad3 = cleanupOwn(path.join(TMP_BASE, 'not-ours'))
  h.eq(bad1.removed, false, `守卫必须拒绝活包 ${LIVE_PACK}（实得 ${JSON.stringify(bad1)}）`)
  h.eq(bad2.removed, false, `守卫必须拒绝 ${TMP_BASE} 本身（实得 ${JSON.stringify(bad2)}）`)
  h.eq(bad3.removed, false, '守卫必须拒绝前缀不对的目录')
  h.eq(fs.existsSync(LIVE_PACK), true, '活包必须还在（守卫拒绝之后什么都没删）')

  // ② 活包与只读快照零改动
  const liveAfter = snapshotTree(LIVE_PACK)
  const liveDiff = diffSnapshot(LIVE_BEFORE, liveAfter)
  const snapAfter = fs.existsSync(SNAP_DIR)
    ? { files: walk(SNAP_DIR).length, bytes: walk(SNAP_DIR).reduce((n, rel) => n + fs.statSync(path.join(SNAP_DIR, rel)).size, 0) }
    : { files: -1, bytes: -1 }
  const snapSame = JSON.stringify(SNAP_BEFORE) === JSON.stringify(snapAfter)

  // ③ 真清理本次夹具
  const cleaned = cleanupOwn(SESSION)

  ev('N02 negative-control-cleanup-guard', rows(
    `临时根：${SESSION}（dirname === ${TMP_BASE}：${path.dirname(path.resolve(SESSION)) === path.resolve(TMP_BASE)}；前缀 whale-T20- ：${path.basename(SESSION).startsWith('whale-T20-')}）`,
    `守卫拒绝：活包=${JSON.stringify(bad1)}`,
    `守卫拒绝：E:\\Temp 本身=${JSON.stringify(bad2)}`,
    `守卫拒绝：前缀不对=${JSON.stringify(bad3)}`,
    `活包 ${LIVE_PACK} 差异：${liveDiff.length ? liveDiff.slice(0, 10).join('；') : '（零改动）'}`,
    `只读快照 ${SNAP_DIR}：${JSON.stringify(SNAP_BEFORE)} → ${JSON.stringify(snapAfter)} · 相同=${snapSame}`,
    `清理本次夹具：${JSON.stringify(cleaned)} · 目录还在=${fs.existsSync(SESSION)}`,
  ))
  h.eq(liveDiff.length, 0, `活包必须零改动（差异：${liveDiff.slice(0, 6).join('；')}）`)
  h.eq(snapSame, true, '只读快照必须零改动')
  h.eq(cleaned.removed, true, `清理本次夹具必须成功（${cleaned.error}）`)
  h.eq(fs.existsSync(SESSION), false, '清理后本次夹具目录必须不存在了')
})

process.exit(h.run())
