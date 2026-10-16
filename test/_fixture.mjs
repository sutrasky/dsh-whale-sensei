/**
 * _fixture.mjs —— **合成课程包夹具**（T02 / 报告 F02）
 * ==================================================================
 * 为什么要有这一层（F02 的原话）：
 *   「固定合成夹具作单测，真实包另列 opt-in 集成」
 *
 * 以前单测的输入是**作者那台机器上的活包**：
 *   - `test/_pack.mjs` 的第三兜底 `path.join(PLUGIN,'..','study')` —— 换台机器必然不存在；
 *   - `test/circle-create.mjs` 还去读**包旁边的兄弟风格仓** `../dsh-raw-html-v2-master/styles`；
 *   - 大量计数 / label 直接绑在活包今天的内容上（活包一变，套件跟着红）。
 * 结果：单测**不是自包含的**，而且"今天绿"只对作者那台机器成立。
 *
 * 本文件造的是**合成夹具**：只从**仓内模板**（`lib/pack-template/`，插件自己随包发的那份）
 * 与**本文件里手写声明的内容**合成，一个字节都不来自活包。
 *
 * 铁律（本卡判据就钉在这几条上）：
 *   ① **不读活包**：本文件里不许出现 `study` / `dsh-raw-html-v2` / 活包绝对路径；
 *   ② **每个固定计数都有手写结构依据**：`FIXTURE_STRUCTURE` 是本文件声明的**唯一形状表**，
 *      断言里出现的任何数字都要能在这里指到它为什么是这个数（不许"改数字适配当前活包"）；
 *   ③ **风格输入也由测试显式构造**：`styles/` 目录由 `styleNames` 现场写出来，
 *      不去猜兄弟仓（见 `STYLE_SAMPLES`）；
 *   ④ **副作用只在副本上**：夹具本身就在 `os.tmpdir()` 下，`dispose()` 删的也只是它。
 *
 * 四个变体（`variant` 固定为这四个，别的值直接失败 —— 不许悄悄多一个）：
 *   - `empty`        ：**空包** —— 有包骨架与空台账，一个圆圈 / 知识点 / 课程都没有。
 *   - `multi-domain` ：**多学科** —— 两个圆圈（编程 / 数学）、三个知识点、三课（默认）。
 *   - `completed`    ：多学科 + `progress.json` 说**每一课都学过**。
 *   - `incomplete`   ：多学科 + `progress.json` 只说**第 1 课学过**（其余没开始）。
 *
 * 用法：
 *   import { createFixture } from './_fixture.mjs'
 *   const fx = createFixture({ variant: 'multi-domain' })
 *   try { ...用 fx.root 跑判据... } finally { fx.dispose() }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN = path.resolve(HERE, '..')
/** 仓内模板：插件**随包发**的那份课程包骨架（不是活包，不是兄弟仓）。 */
export const TEMPLATE_DIR = path.join(PLUGIN, 'lib', 'pack-template')

/** `variant` 的固定取值域。**多一个少一个都算失败**（判据面不许漂）。 */
export const VARIANTS = ['empty', 'multi-domain', 'completed', 'incomplete']

/**
 * 夹具的**唯一形状表** —— 每个固定计数的结构依据都在这里。
 * 断言里出现的数字必须能指回本表；改本表就是改夹具形状（要一并改断言，不许只改数字）。
 */
export const FIXTURE_STRUCTURE = {
  /** 圆圈数（multi-domain / completed / incomplete 三个变体相同） */
  circles: 2,
  /** 知识点数：programming/{spring-boot,vue} + math/alge */
  points: 3,
  /** 课程数：spring-boot 2 课 + vue 1 课 + alge 1 课 */
  lessons: 4,
  /** 圆圈 id（顺序即 `readPack()` 的排序顺序：字母序） */
  circleIds: ['math', 'programming'],
  /** 知识点 id（按圆圈归类） */
  pointIds: { math: ['alge'], programming: ['spring-boot', 'vue'] },
  /**
   * 课程 id —— 用**课号**而不是活包里的 1001：
   * 活包把 Vue 的课号写成 1001（fileBase 折算的历史遗留），夹具**不抄那个数**。
   * 夹具的课号一律从 1 起，显示号 = 课号（`fileBase: 0`）。
   */
  lessonIds: ['math/alge/0001', 'programming/spring-boot/0001', 'programming/spring-boot/0002', 'programming/vue/0001'],
  /** `completed` 变体的 `progress.json.learned` = 全部课程；`incomplete` = 只有第一课 */
  learnedCompleted: 4,
  learnedIncomplete: 1,
  /** 夹具显式造出来的风格样本数（`styles/*.md`，见 STYLE_SAMPLES） */
  styleSamples: 3,
  /** 学生小样本：`code/` 下的项目数（每个项目一个 EXPECT.json） */
  codeProjects: 2,
}

/** 显式构造的风格输入（**不猜兄弟仓**）：名字 → 内容。 */
export const STYLE_SAMPLES = {
  '_INDEX.md': '# 风格库（夹具）\n\n夹具自带的三个风格样本，只用来喂 `tools/style-adapter.js` 的"包内 styles/"那条退路。\n',
  'fixture-plain.md': '# 夹具 · 素净\n\n- 底色：浅\n- 强调色：单一\n- 圆角：小\n',
  'fixture-vivid.md': '# 夹具 · 鲜明\n\n- 底色：深\n- 强调色：双色\n- 圆角：大\n',
}

/**
 * 课程包里 NOTES 页的**合法 URL**（T02 / F02）。
 *
 * F02 原文：「CDP wrapper 统一传 PACK 目录，但 CDP 将首个位置参数视作页面 URL，
 * 原样 navigate，目录路径压过了默认 NOTES URL。」
 *
 * 所以凡是把页面交给 CDP 的地方，都要用**这个函数**算出 `file://` URL 再传，
 * 绝不传目录、也绝不手拼 `'file:///' + path.replace(...)`（那样不转义、不认盘符语义）。
 *
 * @param {string} pack 课程包根
 * @returns {string} 指向 `<pack>/reference/NOTES.html` 的 `file://` URL
 */
export function notesUrlFor(pack) {
  return pathToFileURL(path.join(path.resolve(String(pack)), 'reference', 'NOTES.html')).href
}

/** 判定一个字符串是不是"指向 NOTES 页的合法 URL"（给判据用；纯函数）。 */
export function isNotesPageUrl(u) {
  const s = String(u ?? '')
  if (!/^file:\/\//.test(s)) return false
  if (!/\/reference\/NOTES\.html$/i.test(s)) return false
  try {
    const back = fileURLToPath(s)
    return path.basename(back) === 'NOTES.html' && path.basename(path.dirname(back)) === 'reference'
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ 小工具
const W = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
const WJ = (file, obj) => W(file, JSON.stringify(obj, null, 2) + '\n')
const R = (file, rel) => {
  const src = path.join(TEMPLATE_DIR, ...rel.split('/'))
  if (!fs.existsSync(src)) throw new Error(`夹具：仓内模板里没有 ${rel}（${src}）—— 模板不完整，夹具造不出来`)
  const dst = path.join(file, ...rel.split('/'))
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

/**
 * 把仓内模板（引擎 + 设计基底 + 五个技能）铺进夹具根。
 * **逐字节拷**：模板就是插件随包发的那份，夹具没有理由再改一遍。
 */
function layTemplate(root) {
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else R(root, r)
    }
  }
  if (!fs.existsSync(TEMPLATE_DIR)) throw new Error(`夹具：仓内模板目录不存在（${TEMPLATE_DIR}）`)
  walk(TEMPLATE_DIR)
}

/** 空台账：模板里已经是空的（glossary-data / questions-data 都是骨架），这里只补空态文件 */
function layEmptyLedgers(root) {
  fs.mkdirSync(path.join(root, 'lessons', 'src'), { recursive: true })
  WJ(path.join(root, 'progress.json'), { v: 1, learned: [] })
  W(path.join(root, 'GLOSSARY.md'), '# 名词表（夹具 · 空）\n\n（还没有任何名词）\n')
  W(path.join(root, 'learning-records', 'adjustments.jsonl'), '')
  W(path.join(root, 'notes', 'notes.jsonl'), '')
  W(path.join(root, 'questions', 'pending.jsonl'), '')
  W(path.join(root, 'questions', 'seq.txt'), '0\n')
  W(path.join(root, 'learning-records', 'intake.jsonl'), '')
  W(path.join(root, 'learning-records', 'goals.jsonl'), '')
  W(path.join(root, 'learning-records', 'teaching.jsonl'), '')
  W(path.join(root, 'learning-records', 'evidence.jsonl'), '')
  W(path.join(root, 'lesson.config.json'), JSON.stringify({
    v: 1,
    _: '夹具的课程包配置（手写声明，不是活包那份）',
    title: '夹具课程包',
  }, null, 2) + '\n')
}

/**
 * 夹具自带的**闸门**（`<夹具>/tools/gate.mjs`）。
 *
 * 为什么夹具要带一个闸门：`test/all.mjs` 的两本账里，第一本是
 * `<pack>/tools/gate.mjs`。夹具模式要跑得起来，这一本也得在 —— 但**不许**把作者活包
 * 那份 `gate.mjs` 拷过来（那是活包的代码，而且它读的是活包的 `_plugin-prep/`、`code/`）。
 *
 * 所以这份闸门是**本文件手写声明**的：它只查夹具自己声明过的形状
 * （`FIXTURE_STRUCTURE` 里的圆圈 / 知识点 / 课程数，以及 progress.json 的已学数）。
 * **不猜、不空转**：断言打空（比如"应该有 2 个圈却一个都没扫到"）一样是红。
 *
 * 输出格式必须满足 `test/all.mjs` 的闸门摘要契约：
 *   `=== 闸门：<通过> / <总数> 通过 —— 全绿 ===`
 */
function gateSource(variant) {
  const expect = {
    circles: variant === 'empty' ? 0 : FIXTURE_STRUCTURE.circles,
    points: variant === 'empty' ? 0 : FIXTURE_STRUCTURE.points,
    lessons: variant === 'empty' ? 0 : FIXTURE_STRUCTURE.lessons,
    learned: variant === 'completed' ? FIXTURE_STRUCTURE.learnedCompleted
      : (variant === 'incomplete' ? FIXTURE_STRUCTURE.learnedIncomplete : 0),
  }
  return `#!/usr/bin/env node
/**
 * 夹具闸门（由 test/_fixture.mjs 手写生成，variant=${variant}）
 * 只查**夹具自己声明过的形状**；不读活包、不猜兄弟仓。
 */
import fs from 'node:fs'
import path from 'node:path'

const EXPECT = ${JSON.stringify(expect)}
const argv = process.argv.slice(2)
const packArg = argv.find((a) => a.startsWith('--pack='))
const root = path.resolve(packArg ? packArg.slice('--pack='.length) : (argv.find((a) => !a.startsWith('--')) || '.'))
const checks = []
const ok = (cond, name) => checks.push({ name, cond: !!cond })

// ① 这像个课程包（与 test/_pack.mjs 同一条判据）
ok(fs.existsSync(path.join(root, 'presets', 'whale-sensei.css')), 'presets/whale-sensei.css 在（像课程包）')

// ② 圆圈 / 知识点数（读 halo.json / point.json，与 lib/pack-model.js 同一条读法）
const lessonsDir = path.join(root, 'lessons')
let circles = [], points = []
try {
  for (const d of fs.readdirSync(lessonsDir).sort()) {
    const hf = path.join(lessonsDir, d, 'halo.json')
    if (!fs.existsSync(hf)) continue
    circles.push(d)
    for (const p of fs.readdirSync(path.join(lessonsDir, d)).sort()) {
      if (fs.existsSync(path.join(lessonsDir, d, p, 'point.json'))) points.push(d + '/' + p)
    }
  }
} catch { /* 下面按"数不对"报红 */ }
ok(circles.length === EXPECT.circles, \`圆圈数 = \${EXPECT.circles}（实得 \${circles.length}）\`)
ok(points.length === EXPECT.points, \`知识点数 = \${EXPECT.points}（实得 \${points.length}）\`)

// ③ 课程数（lessons/src/**/*.html 带 data-lesson-meta）
let lessons = 0
const walk = (dir) => {
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    if (e.isDirectory()) walk(path.join(dir, e.name))
    else if (e.name.endsWith('.html')) {
      const t = fs.readFileSync(path.join(dir, e.name), 'utf8')
      if (/data-lesson-meta/.test(t)) lessons++
    }
  }
}
walk(path.join(lessonsDir, 'src'))
ok(lessons === EXPECT.lessons, \`课程数 = \${EXPECT.lessons}（实得 \${lessons}）\`)

// ④ 进度（progress.json 的 learned 条数）
let learned = -1
try { learned = JSON.parse(fs.readFileSync(path.join(root, 'progress.json'), 'utf8')).learned.length } catch { /* -1 */ }
ok(learned === EXPECT.learned, \`已学课数 = \${EXPECT.learned}（实得 \${learned}）\`)

// —— 输出：闸门摘要契约（test/all.mjs 按它解析）——
for (const c of checks) console.log((c.cond ? 'ok   ' : 'FAIL ') + c.name)
const pass = checks.filter((c) => c.cond).length
const all = checks.length
console.log(\`\\n=== 闸门：\${pass} / \${all} 通过\${pass === all ? ' —— 全绿' : ''} ===\`)
process.exit(pass === all ? 0 : 1)
`
}

/** 铺**内容**（圆圈 / 知识点 / 课程 / 学生样本）。
 * 全部由本文件手写声明 —— 数字与 `FIXTURE_STRUCTURE` 一一对应。
 */
function layContent(root) {
  // ── 圆圈：math ──
  WJ(path.join(root, 'lessons', 'math', 'halo.json'), {
    _: '夹具圆圈（手写声明）',
    halo: 'math',
    name: '数学',
    color: '#e8f0ff',
    practice: { dirs: ['code/math'], note: '夹具：数学圈的实践区' },
    center: '把数量关系算清楚',
  })
  WJ(path.join(root, 'lessons', 'math', 'alge', 'point.json'), {
    _: '夹具知识点（手写声明）',
    point: 'alge',
    name: '代数',
    label: '',
    fileBase: 0,
    practice: { dirs: ['code/math/alge'] },
  })

  // ── 圆圈：programming ──
  WJ(path.join(root, 'lessons', 'programming', 'halo.json'), {
    _: '夹具圆圈（手写声明）',
    halo: 'programming',
    name: '编程',
    color: '#fff6e2',
    practice: { dirs: ['code/programming'] },
    center: '写出可运行、可被调用的程序',
    groups: [
      { id: 'backend', name: '后端', points: ['spring-boot'] },
      { id: 'frontend', name: '前端', points: ['vue'] },
    ],
  })
  WJ(path.join(root, 'lessons', 'programming', 'spring-boot', 'point.json'), {
    point: 'spring-boot',
    name: 'Spring Boot',
    label: '',
    fileBase: 0,
    practice: { dirs: ['code/programming/spring-boot'] },
    plan: {
      goal: '夹具终点：能跑起一个分层 REST 服务',
      nodes: [
        { no: 1, title: '第1课：跑起来', deliverable: '可运行的应用', criteria: '能启动', why: '后面每课都往上加', branch: false, sources: [{ label: '夹具出处', url: 'https://example.invalid/1' }] },
        { no: 2, title: '第2课：分层', deliverable: '三层的 CRUD', criteria: '接口通', why: '终点要分层', branch: false, sources: [{ label: '夹具出处', url: 'https://example.invalid/2' }] },
      ],
    },
  })
  WJ(path.join(root, 'lessons', 'programming', 'vue', 'point.json'), {
    point: 'vue',
    name: 'Vue',
    label: '',
    fileBase: 0,
    practice: { dirs: ['code/programming/vue'] },
  })

  // ── 课程页（`lessons/src/<圈>/<点>/NNNN-<slug>.html`，带 data-lesson-meta）──
  const lessons = [
    { halo: 'math', point: 'alge', number: 1, slug: 'alge-basics', title: '代数入门', navTitle: '代数入门', hintTerm: 'variable', terms: { variable: '用字母代表数' } },
    { halo: 'programming', point: 'spring-boot', number: 1, slug: 'boot-hello', title: '第一课：跑起来', navTitle: 'Hello', hintTerm: 'starter', terms: { starter: '一包带齐一组库', bean: 'Spring 托管的那个对象' } },
    { halo: 'programming', point: 'spring-boot', number: 2, slug: 'boot-rest', title: '第二课：分层与契约', navTitle: 'REST 分层', hintTerm: 'crud', terms: { rest: '接口设计风格', crud: '增删改查四件事' } },
    { halo: 'programming', point: 'vue', number: 1, slug: 'vue-render', title: '把接口数据渲染成页面', navTitle: '数据渲染', hintTerm: 'reactivity', terms: { reactivity: '响应式系统', template: 'HTML 模板' } },
  ]
  for (const l of lessons) {
    const rel = `${l.halo}/${l.point}/${String(l.number).padStart(4, '0')}-${l.slug}.html`
    const meta = {
      title: l.title,
      number: l.number,
      navTitle: l.navTitle,
      hintTerm: l.hintTerm,
      halo: l.halo,
      point: l.point,
      source: { label: '夹具出处（手写声明）', url: `https://example.invalid/${l.slug}` },
      terms: l.terms,
    }
    W(path.join(root, 'lessons', 'src', ...rel.split('/')), [
      '<!doctype html>',
      '<html lang="zh-CN"><head><meta charset="utf-8">',
      `<title>${l.title}</title>`,
      '</head><body>',
      `<script type="application/json" data-lesson-meta>${JSON.stringify(meta, null, 2)}</script>`,
      '<!--@objective-->',
      `<p>夹具课程：${l.title}（内容由 test/_fixture.mjs 手写声明，不来自活包）。</p>`,
      '<!--/@objective-->',
      '<!--@challenges-->',
      '<ol><li>夹具挑战一（机器判不了：auto:false + hint）</li></ol>',
      '<!--/@challenges-->',
      '</body></html>',
      '',
    ].join('\n'))
  }

  // ── 课程索引（`lessons/lessons.json`）—— 由上面的声明**算**出来，不手抄数字 ──
  WJ(path.join(root, 'lessons', 'lessons.json'), {
    v: 1,
    source: 'lessons/src',
    lessons: lessons.map((l) => ({
      title: l.title,
      number: l.number,
      navTitle: l.navTitle,
      hintTerm: l.hintTerm,
      source: { label: '夹具出处（手写声明）', url: `https://example.invalid/${l.slug}` },
      terms: l.terms,
      rel: `${l.halo}/${l.point}/${String(l.number).padStart(4, '0')}-${l.slug}.html`,
      slug: l.slug,
      halo: l.halo,
      point: l.point,
    })),
  })

  // ── 星图产物（`tools/build-starmap.js` 的输出位；夹具给最小可用形状）──
  W(path.join(root, 'starmap', 'content.js'),
    '/* 夹具星图内容（手写声明的最小形状） */\n'
    + 'window.WHALE_STARMAP = { v: 1, circles: [], points: [], lessons: [], learned: [] }\n')
  W(path.join(root, 'starmap', 'static.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="夹具星图"><rect width="100" height="100" fill="#05070e"/></svg>\n')

  // ── 参考页（`reference/NOTES.html`）—— CDP 的默认页面就是它 ──
  W(path.join(root, 'reference', 'NOTES.html'),
    '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具笔记</title></head>\n'
    + '<body><main id="notes-root"><h1>夹具笔记页</h1><p>这是合成夹具里的 NOTES 页。</p></main></body></html>\n')

  // ── 学生小样本（`code/`）：每个项目一个 EXPECT.json ──
  WJ(path.join(root, 'code', 'programming', 'spring-boot', 'EXPECT.json'), {
    project: 'programming/spring-boot',
    note: '夹具学生样本（手写声明）',
    lessons: [
      {
        id: 'spring-boot/0001',
        title: '第一课：跑起来',
        required: [{ id: 'app-class', kind: 'classSuffix', value: 'Application', hint: '有启动类' }],
        challenges: [{ no: 1, anchor: '夹具挑战一', hint: '夹具提示', auto: false, deliverable: '夹具交付物' }],
      },
      {
        id: 'spring-boot/0002',
        title: '第二课：分层与契约',
        required: [{ id: 'controller-pkg', kind: 'dir', value: 'controller', hint: '有 controller 包' }],
        challenges: [{ no: 1, anchor: '夹具挑战一', hint: '夹具提示', auto: false, deliverable: '夹具交付物' }],
      },
    ],
  })
  WJ(path.join(root, 'code', 'programming', 'vue', 'EXPECT.json'), {
    project: 'programming/vue',
    note: '夹具学生样本（手写声明）',
    lessons: [
      {
        id: 'vue/0001',
        title: '把接口数据渲染成页面',
        required: [{ id: 'page', kind: 'file', value: 'index.html', hint: '有 index.html' }],
        challenges: [{ no: 1, anchor: '夹具挑战一', hint: '夹具提示', auto: false, deliverable: '夹具交付物' }],
      },
    ],
  })
}

/** 风格输入：**由测试显式构造**（F02 原文：「风格输入也由测试显式构造」） */
function layStyles(siblingDir) {
  for (const [name, text] of Object.entries(STYLE_SAMPLES)) {
    W(path.join(siblingDir, 'styles', name), text)
  }
}

/**
 * 造一个合成课程包夹具。
 *
 * @param {{variant?: string, root?: string}} opts
 *   `variant` ∈ `VARIANTS`（缺省 `multi-domain`）；别的值**直接抛错**（不许悄悄多一个变体）。
 *   `root` 给定时用它当夹具根（调用方自己管清理）；不给就在 `os.tmpdir()` 下新开一个。
 * @returns {{root:string, variant:string, dispose:()=>{removed:boolean,error:string|null}, structure:object}}
 */
export function createFixture(opts = {}) {
  const variant = String(opts.variant ?? 'multi-domain')
  if (!VARIANTS.includes(variant)) {
    throw new Error(`createFixture：variant 只能是 ${VARIANTS.join(' / ')}（实得 ${JSON.stringify(opts.variant)}）`)
  }
  const owned = !opts.root
  const root = path.resolve(opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), `dsh-whale-fixture-${variant}-`)))
  fs.mkdirSync(root, { recursive: true })

  // ① 包骨架（仓内模板，逐字节）—— 判据"像不像课程包"就是 presets/whale-sensei.css
  layTemplate(root)
  // ② 空台账 / 配置
  layEmptyLedgers(root)
  // ③ 内容（empty 变体只有骨架，没有圆圈）
  if (variant !== 'empty') layContent(root)
  // ④ 进度
  if (variant === 'completed') {
    WJ(path.join(root, 'progress.json'), { v: 1, learned: FIXTURE_STRUCTURE.lessonIds.slice() })
  } else if (variant === 'incomplete') {
    WJ(path.join(root, 'progress.json'), { v: 1, learned: FIXTURE_STRUCTURE.lessonIds.slice(0, FIXTURE_STRUCTURE.learnedIncomplete) })
  }
  // ⑤ 夹具自带的闸门（`test/all.mjs` 的第一本账要它；**手写生成，不拷活包**）
  W(path.join(root, 'tools', 'gate.mjs'), gateSource(variant))
  // ⑥ 风格输入：显式构造在**夹具的兄弟目录**里（style-adapter 的退路链需要它，
  //    但**不许**去猜作者那台机器上的 dsh-raw-html-v2-master）
  layStyles(path.dirname(root))

  return {
    root,
    variant,
    structure: FIXTURE_STRUCTURE,
    /** 清理：只删本次自己建的临时目录（调用方给了 root 就由调用方负责） */
    dispose() {
      if (!owned) return { removed: false, error: '夹具根由调用方提供，本函数不删（调用方负责）' }
      const abs = path.resolve(root)
      const tmp = path.resolve(os.tmpdir())
      if (!abs.startsWith(tmp + path.sep)) {
        return { removed: false, error: `拒绝清理：${abs} 不在 ${tmp} 下` }
      }
      try {
        fs.rmSync(abs, { recursive: true, force: true })
        return { removed: true, error: null }
      } catch (e) {
        return { removed: false, error: `清理失败：${e && e.message ? e.message : String(e)}` }
      }
    },
  }
}
