/**
 * render-inputs.js — IO 薄壳 + 编排（搬运 build-lessons.js 的行号区间）
 * ------------------------------------------------------------------
 * 职责：读课程包的 IO 数据（frame / glossary / questions / point 标签 / 笔记计数），
 *       编排渲染与抽取的调用顺序，产出 { path, content } 文件清单。
 *
 * 纯逻辑（parseSource / renderPage / extractPage / serializeSource /
 *   buildGlossaryIndex / mergeBlocks 等）全部从 ./render.js import，
 *   不复制一份到自己文件里。
 *
 * 约束：
 *   - 数据文件（glossary-data.js / questions-data.js / shape-render.js）
 *     用 createRequire(import.meta.url) 加载（CommonJS → require 缓存行为同原版）
 *   - 不许读环境变量 / 读 cwd
 *
 * 起草：mimo（搬运 build-lessons.js 的行 242–301、303–323、26–31、652–669）；
 * 收口：主线程（接口 / 判据 / 对拍）。
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { stripBom, splitLines } from './text.js'
import { lessonIndex, labelOfAnchor, displayNumberOf } from './pack-model.js'
// 纯逻辑从 ./render.js import（不许复制一份）
import {
  parseSource,
  renderPage,
  extractPage,
  collectNavTitles,
  serializeSource,
  buildGlossaryIndex,
  mergeBlocks,
} from './render.js'

/* ── 常量（从原 build-lessons.js 行 44 搬来）────────────────────────────── */

const SECTION_NAMES = ['style', 'objective', 'review', 'body', 'reading', 'challenges']

/* ── 路径推导（原 build-lessons.js 行 26–31，改成从 root 参数推导）──────────── */

/** @param {string} root 课程包根目录 */
function derivePaths(root) {
  // 原版：const ROOT = path.join(__dirname, '..')；这里 root 由调用方给
  const srcDir = path.join(root, 'lessons', 'src')
  const outDir = path.join(root, 'lessons')
  const assets = path.join(root, 'assets')
  const framePath = path.join(assets, '_frame.html')
  const notesDir = path.join(root, 'notes')
  const notesJsonl = path.join(notesDir, 'notes.jsonl')
  return { root, srcDir, outDir, assets, framePath, notesDir, notesJsonl }
}

/* ── 数据加载（CommonJS require，保留缓存行为 —— 同原版）────────────────── */

/**
 * 用 createRequire 加载 CommonJS 数据文件。
 * require 有模块缓存：两次构建之间文件被改不会重读 —— 这是原版行为，保留。
 */
function loadDataFiles(root) {
  // createRequire 的基准路径必须指向一个文件（不是目录），
  // 用 package.json 作为锚点最稳
  const requireFromRoot = createRequire(path.join(root, 'package.json'))
  const glossary = requireFromRoot('./assets/glossary-data.js')
  const questions = requireFromRoot('./assets/questions-data.js')
  const shape = requireFromRoot('./tools/shape-render.js')
  return { glossary, questions, shape }
}

/* ── walkSrc / pointLabel / loadSources（原 build-lessons.js 行 242–301）───── */

const LEGACY_HALO = 'programming'
const LEGACY_POINT = 'spring-boot'

/**
 * 递归扫描 src 目录，返回相对路径数组（已排序）。
 * readdirSync 的排序必须保留 —— 行 255 原文：.sort((a, b) => a.name.localeCompare(b.name))
 */
function walkSrc(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkSrc(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

/**
 * 知识点的显示信息：lessons/<halo>/<point>/point.json 的 label 与 fileBase
 * （label 空串 = 不前缀，显示「第N课」；fileBase 是编号折算基准）。
 * 原 build-lessons.js 行 264–272 + 轨道机制（文件号是内部 ID、显示号要折算）。
 */
function pointInfo(outDir, halo, point) {
  const f = path.join(outDir, halo, point, 'point.json')
  if (!fs.existsSync(f)) return { label: '', fileBase: 0 }
  let d
  try {
    d = JSON.parse(stripBom(fs.readFileSync(f, 'utf8')))
  } catch (e) {
    throw new Error(`${halo}/${point}/point.json 不是合法 JSON —— ${e.message}`)
  }
  return { label: d.label || '', fileBase: Number(d.fileBase) || 0 }
}

/**
 * 扫描并解析所有源文件，返回页对象数组。
 * 原 build-lessons.js 行 274–301。
 *
 * 注意：
 *   - readdirSync 的排序必须保留（walkSrc 内 .sort）
 *   - 结果再按 rel 排序（行 300）
 *   - PAGE_UP 由层级推出，不手工维护
 */
function loadSources(srcDir, outDir, glossary, shape) {
  if (!fs.existsSync(srcDir)) return { pages: [], pageUp: '../' }

  const pages = walkSrc(srcDir).map((rel) => {
    const base = rel.split('/').pop()
    // 旧实现用 /^\d{4}-/ 过滤：不合规的文件**静默消失**。这里改成直接报错。
    if (!/^\d{4}-.*\.html$/.test(base)) {
      throw new Error(`lessons/src/${rel}：文件名必须形如 NNNN-*.html（旧实现会静默跳过，所以这里直接报错）`)
    }
    const parts = rel.split('/')
    const page = parseSource(fs.readFileSync(path.join(srcDir, rel), 'utf8'), base, shape)
    // 真相顺序：**路径优先**（lessons/src/<圆圈>/<知识点>/NNNN-*.html），
    // meta 里的 halo / point 可以覆盖 —— 给测试桩与迁移期用（如星图增删查改的实验圈）。
    const halo = page.meta.halo || (parts.length >= 3 ? parts[0] : LEGACY_HALO)
    const point = page.meta.point || (parts.length >= 3 ? parts[1] : LEGACY_POINT)
    page.rel = rel
    page.halo = halo
    page.point = point
    const { label, fileBase } = pointInfo(outDir, halo, point)
    // 文件号是内部 ID、显示号按 fileBase 折算 —— 规则在 pack-model.js（与课程包 lesson-map.js 对拍钉住）
    page.fileBase = fileBase
    page.displayNumber = displayNumberOf(page.meta.number, fileBase)
    page.label = label ? `${label} 第${page.displayNumber}课` : `第${page.displayNumber}课`
    return page
  })
  const depths = new Set(pages.map((p) => p.rel.split('/').length - 1))
  if (depths.size > 1) {
    throw new Error(`源文件层级混用（${[...depths].sort().join(' 与 ')} 层）—— 平铺与分层不能同时存在，统一后再构建`)
  }
  const pageUp = '../'.repeat([...depths][0] + 1)
  return { pages: pages.sort((a, b) => a.rel.localeCompare(b.rel)), pageUp }
}

/* ── 笔记/答疑计数（原 build-lessons.js 行 303–323）─────────────────────── */

/**
 * 某课已解答的答疑条数。依赖 QUESTIONS 内存常量 —— 由薄壳加载后传进去。
 * 原 build-lessons.js 行 321–323。
 */
function countQA(questions, lesson) {
  return Object.values(questions).filter((q) => q.lesson === lesson && q.status === 'answered' && q.answerHtml).length
}

/* ── 笔记计数映射（预先读一次，按课次显示名统计）──────────────────────────── */

/**
 * 预先读一次笔记台账，按**课次显示名**分组统计，返回 { label → count } 映射。
 *
 * 台账里存的是 `anchor` = **星图课次键**（写入口 `notes-io.js` 归一化），
 * 而渲染侧一路用的是 label（`render.js:294` 的 `noteCounts.get(lesson)`）——
 * 所以反向那一步在这里做一次，且**只经 `pack-model.js` 的 labelOfAnchor**：
 * 读点自己拼 `第N课` 迟早会漂（星图侧 label 还可能带知识点前缀）。
 * 解析不到的 anchor（孤儿 / 旧格式）跳过，不错算到别人头上。
 *
 * 原版每页读一次 → 这里改成读一次建表，但产出的数字必须完全一样。
 */
function buildNoteCounts(notesJsonl, index) {
  const counts = new Map()
  try {
    const lines = splitLines(fs.readFileSync(notesJsonl, 'utf8')).filter((l) => l.trim())
    for (const l of lines) {
      let n
      try { n = JSON.parse(l); } catch { continue }
      const label = labelOfAnchor(n && n.anchor, index)
      if (label) counts.set(label, (counts.get(label) || 0) + 1)
    }
  } catch {
    // 台账不存在时返回空映射（同原版每页 catch 返回 0）
  }
  return counts
}

/* ── point 标签映射（预先批量读成一个 labels 映射）─────────────────────────── */

/**
 * 预先读取所有 point.json，构建 { "halo/point" → label } 映射。
 * 原版是每页读一次 pointLabel() → 这里改成读一次建表，但产出的字符串必须完全一样。
 */
function buildPointLabels(outDir) {
  const labels = new Map()
  // 遍历 lessons/ 下的 halo 子目录，再遍历 point 子目录
  let halos
  try { halos = fs.readdirSync(outDir, { withFileTypes: true }) } catch { return labels }
  for (const h of halos) {
    if (!h.isDirectory()) continue
    const haloDir = path.join(outDir, h.name)
    let points
    try { points = fs.readdirSync(haloDir, { withFileTypes: true }) } catch { continue }
    for (const p of points) {
      if (!p.isDirectory()) continue
      const pf = path.join(haloDir, p.name, 'point.json')
      if (!fs.existsSync(pf)) continue
      try {
        const data = JSON.parse(stripBom(fs.readFileSync(pf, 'utf8')))
        labels.set(`${h.name}/${p.name}`, data.label || '')
      } catch (e) {
        throw new Error(`${h.name}/${p.name}/point.json 不是合法 JSON —— ${e.message}`)
      }
    }
  }
  return labels
}

/* ── ctx 构建（薄壳：IO 全在这里，之后的编排只用纯数据）────────────────────── */

/**
 * 读取所有 IO 数据，构建渲染上下文。
 * 返回 { frame, glossaryIndex, labels, noteCounts, qa, pages }
 *
 * @param {string} root 课程包根目录
 * @param {object} pack 由 readPack 返回的课程包对象（目前未直接使用，预留接口）
 */
export function readRenderInputs(root, pack) {
  const warnings = []
  const paths = derivePaths(root)

  // 守卫：缺 questions-data.js 时跳过（原 build-lessons.js 行 34–38）
  if (!fs.existsSync(path.join(paths.assets, 'questions-data.js'))) {
    warnings.push('跳过：本目录没有 assets/questions-data.js（技能包只带引擎，课程数据由使用者创建）')
    return { frame: '', glossaryIndex: {}, labels: new Map(), noteCounts: new Map(), qa: {}, pages: [], pageUp: '../', warnings }
  }

  // 加载 CommonJS 数据文件（行 40–42）
  const { glossary, questions, shape } = loadDataFiles(root)

  // 读 _frame.html（行 343：每个 root 只读一次，放进 ctx.frame）
  // 丢掉 _frame.html 顶部的说明注释（行 345）
  let frame = ''
  try {
    const raw = fs.readFileSync(paths.framePath, 'utf8')
    frame = raw.slice(raw.indexOf('<!DOCTYPE'))
  } catch {
    warnings.push(`读不到 ${paths.framePath}`)
  }

  // 构建 glossary 索引（行 216–219：LABEL_TO_KEY / TERM_COUNT）
  const glossaryIndex = buildGlossaryIndex(glossary)

  // 预先批量读 point 标签（原版每页读一次 → 改成一次建表）
  const labels = buildPointLabels(paths.outDir)

  // 预先读 notes.jsonl 建计数映射（原版每页读一次 → 改成一次建表）
  const noteCounts = buildNoteCounts(paths.notesJsonl, lessonIndex(root))

  // 扫描并解析所有源文件（行 274–301）
  const { pages, pageUp } = loadSources(paths.srcDir, paths.outDir, glossary, shape)

  return { frame, glossaryIndex, labels, noteCounts, qa: questions, shape, pages, pageUp, warnings }
}

/* ── planBuild（原 build-lessons.js 行 652–669 的「生成内容」部分）──────────── */

/**
 * 构建所有课程页，返回 { files, warnings }。
 * 绝不写盘、绝不 console.log、绝不 process.exit。
 * 文件顺序确定（按 rel 排序）。路径一律 POSIX 斜杠。
 *
 * @param {string} root 课程包根目录
 * @param {object} pack
 */
export function planBuild(root, pack) {
  const ctx = readRenderInputs(root, pack)
  if (!ctx.pages.length) return { files: [], warnings: ctx.warnings }

  const files = []
  for (const page of ctx.pages) {
    // renderPage 来自 ./render.js —— 纯逻辑，不复制
    // ⚠️ 冻结签名是 renderPage(page, all, ctx)，搬运时按 7 个位置参数调过（ctx 会变成 frame 字符串）✗
    const html = renderPage(page, ctx.pages, ctx)
    files.push({
      path: `lessons/${page.rel}`,
      content: html,
    })
  }
  // 路径一律 POSIX 斜杠（已经是，因为 rel 用 / 拼接）
  // 按 rel 排序（原行 300 已排序，这里保持）
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, warnings: ctx.warnings }
}

/* ── planExtract（原 build-lessons.js 行 414–604、620–640 的 extract 分支）── */

/**
 * 把 lessons/ 下已构建的页面反向拆成源文件。
 * 也就是 lessons/src/<file> 的内容，调用 ./render.js 的 extractPage / collectNavTitles / serializeSource。
 * 拿不准就照 414-604 与 620-640 行的 extract 分支逐字搬。
 *
 * @param {string} root 课程包根目录
 * @param {object} pack
 */
export function planExtract(root, pack) {
  const warnings = []
  const paths = derivePaths(root)

  if (!pack.lessons || !pack.lessons.length) {
    warnings.push('没有课程可抽取')
    return { files: [], warnings }
  }

  // 加载 glossary（extract 需要 LABEL_TO_KEY 反查）
  const { glossary } = loadDataFiles(root)
  const glossaryIndex = buildGlossaryIndex(glossary)

  // 读取已构建页面的 HTML 内容（原行 619：loaded = pages.map(p => ({ file: p, text: fs.readFileSync(p, 'utf8') }))）
  const loaded = pack.lessons.map((lesson) => {
    const filePath = path.join(paths.root, lesson.file)
    try {
      return { file: lesson.file, text: fs.readFileSync(filePath, 'utf8') }
    } catch {
      warnings.push(`读不到已构建页面：${lesson.file}`)
      return null
    }
  }).filter(Boolean)

  if (!loaded.length) return { files: [], warnings }

  // collectNavTitles（行 620）
  const navTitles = collectNavTitles(loaded, glossaryIndex)

  const files = []
  const styles = []
  for (const p of loaded) {
    // extractPage（行 625）
    const page = extractPage(p.text, p.file, navTitles, glossaryIndex)
    // serializeSource（行 627）
    const srcPath = `lessons/src/${page.file}`
    const content = serializeSource(page)
    files.push({ path: srcPath, content })
    // 收集内联样式（行 628）
    styles.push({ file: page.file, css: page._inlineStyle || '' })
  }

  // 合并内联样式为 lesson-blocks.css（行 632–634）
  const styled = styles.filter((s) => s.css.trim())
  if (styled.length) {
    const blocksContent = mergeBlocks(styled)
    files.push({ path: 'assets/lesson-blocks.css', content: blocksContent })
  }

  return { files, warnings }
}

/* ── 漂移比对 / 原子落盘（原 build-lessons.js 137-141 writeAtomic + 656 check 比对）── */

/**
 * 把 plan 的每个文件与磁盘现状比一遍。**只读**。
 * 每一处差异都要能说清"哪个文件、差在哪"，不许只回一句"不一致"。
 *
 * @returns {{ missing: string[], different: {path: string, detail: string}[], same: string[] }}
 */
export function diffPlan(root, plan) {
  const missing = []
  const different = []
  const same = []
  for (const f of plan.files) {
    const abs = path.join(root, f.path)
    let disk = null
    try {
      disk = fs.readFileSync(abs, 'utf8')
    } catch {
      missing.push(f.path)
      continue
    }
    if (disk === f.content) {
      same.push(f.path)
      continue
    }
    different.push({ path: f.path, detail: firstDiff(disk, f.content) })
  }
  return { missing, different, same }
}

/** 首个差异的位置（行/列 + 两侧长度）—— 报"不一致"必须能落到具体位置 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const line = a.slice(0, i).split('\n').length
  const col = i - (a.lastIndexOf('\n', i - 1) + 1)
  return `第 ${line} 行第 ${col} 列（磁盘 ${a.length} 字符 / 渲染 ${b.length} 字符）`
}

/**
 * 原子落盘：先写 `.tmp-<pid>` 再 rename（照搬原版 writeAtomic 的语义）。
 * 内容与磁盘相同的文件**不重写** —— 免得白白刷新 mtime（本仓库已经有"闸门重写产物"的教训）。
 *
 * @returns {{ written: string[], unchanged: string[] }}
 */
export function writePlan(root, plan) {
  const written = []
  const unchanged = []
  for (const f of plan.files) {
    const abs = path.join(root, f.path)
    let prev = null
    try {
      prev = fs.readFileSync(abs, 'utf8')
    } catch {
      /* 不存在 → 需要写 */
    }
    if (prev === f.content) {
      unchanged.push(f.path)
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    fs.writeFileSync(tmp, f.content, 'utf8')
    fs.renameSync(tmp, abs)
    written.push(f.path)
  }
  return { written, unchanged }
}
