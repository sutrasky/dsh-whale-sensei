/**
 * lib/unify/content.cjs —— **课程投影**的唯一实现（U15 · C lane）
 * ==================================================================
 * 解决的问题：星图 / 课程星清单 / 名词树 / 笔记页 / 答疑文档原来各自把
 * 「课程包里到底有哪些课、每门课叫什么、算不算已学、有几条答疑」重新算了一遍 ——
 * 同一份事实五处实现，改一处漏四处。本模块把那次投影收成**一份**：
 *
 *   `buildCourseContent({ root, fs, loadData, deps, sections, options })`
 *     → `{ sections: { <name>: <投影结果> } }`
 *
 * 投影结果里带着**产物正文**（`artifact.text`）、**CLI 文案**（`log` / `messages`）与
 * 供判据用的**结构化数据**（`data`）。包侧的五个生成器因此只剩「CLI + 读写」：
 * 选节、打印、落盘、退出码、`--check`、spawn 子进程。
 *
 * ## 身份口径（U-SPEC §2；别再改回去）
 *
 *   · 课程身份 = `circle/point/NNNN`。**显示名、页面锚点（`q0001` 之类）都不是课程身份**；
 *   · 课程键一律由 `./identity.cjs#lessonKey` 构造（`courseIdOf` 是它在这份实现里的唯一出口，
 *     A07 的变异就打在它上面）；
 *   · `progress.json.learned` 走 `./pack.cjs#resolveLearned`（只认规范身份，历史形状逐条点名、
 *     不计入）；**答疑台账**的 `lesson` 字段是**显示名**（课程包 `assets/_frame.html` 的
 *     `data-ask-lesson="{{LESSON_LABEL}}"`），所以只按「身份派生出来的显示名」**唯一**对位；
 *     撞车 / 对不上 → **不计入任何课**并告警（绝不猜给某一门）。
 *
 * ## 边界
 *
 *   · 纯 CJS；只依赖内置 + 同目录内核（identity / pack / text / plan / glossary / render）；
 *   · **不自己 require 盘上的课程数据**：`fs` 与 `loadData(相对路径)` 都由调用方注入
 *     （课程包工具用 `require`，宿主测试用内存夹具）；
 *   · 不读环境变量、不取时间、不用随机数 → 同输入逐字节同一产物（`--check` 才有意义）。
 */
'use strict'

const path = require('node:path')

const identity = require('./identity.cjs')
const packCore = require('./pack.cjs')
const textCore = require('./text.cjs')
const planCore = require('./plan.cjs')
const glossaryCore = require('./glossary.cjs')
const renderCore = require('./render.cjs')

/* ══════════════════════════════════════════════════════════════════════
 * 常量（落点 / 文案之外的形状）
 * ══════════════════════════════════════════════════════════════════════ */

/** 五类课程投影片段（= `buildCourseContent` 的 `sections` 取值） */
const CONTENT_SECTIONS = Object.freeze(['lessonsIndex', 'starmap', 'glossaryTree', 'notes', 'questions'])

/** 每类投影写哪个产物（包根相对的 posix 路径） */
const ARTIFACT_REL = Object.freeze({
  lessonsIndex: 'lessons/lessons.json',
  starmap: 'starmap/content.js',
  glossaryTree: 'assets/glossary-tree.js',
  notes: 'reference/NOTES.html',
  questions: 'QUESTIONS.md',
})

/** 课程页 front-matter（`<script data-lesson-meta>`）—— 与 build-lessons 同一个形状 */
const LESSON_META_RE = /<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/
/** 课程页文件名：`NNNN-*.html`（四位课号是身份的一部分） */
const LESSON_FILE_RE = /^(\d{4})-(.+)\.html$/

const LEGACY_HALO = packCore.LEGACY_HALO
const LEGACY_POINT = packCore.LEGACY_POINT

/** 没归到课的记录归到这个**明确的**桶（与包侧 build-notes / 插件写入口同一措辞） */
const UNLESSON = packCore.UNLESSON

/** 星图载荷里那三句「一条星都没有」的话都在 CLI 文案里，不在载荷里 */
const STAR_CONTENT_HEAD = '// 由 tools/build-starmap.js 生成 —— 不要手改。数据源：lessons/**/halo.json、point.json、课程页 meta、progress.json、assets/glossary-data.js */'
const TREE_GENERATED = 'tools/build-glossary-tree.js — 不要手改'
const TREE_CONTENT_SOURCE = '// 数据源：lessons/<圆圈>/halo.json · lessons/<圆圈>/<知识点>/point.json · tools/lesson-map.js · assets/glossary-data.js'

/** 每类投影需要模型里的哪些事实（读盘面由这一张表决定，不多读一个文件） */
const SECTION_NEEDS = Object.freeze({
  lessonsIndex: Object.freeze(['sourceLessons']),
  starmap: Object.freeze(['halos', 'sourceLessons', 'progress', 'pending', 'glossary']),
  glossaryTree: Object.freeze(['halos', 'lessonIndex', 'glossary']),
  notes: Object.freeze(['lessonIndex', 'questions', 'notes']),
  questions: Object.freeze(['questions', 'glossary']),
})

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

function requireFs(input) {
  const io = input && input.fs
  if (!io || typeof io.readFileSync !== 'function' || typeof io.readdirSync !== 'function') {
    throw new TypeError('content：必须注入 fs（本模块不自己读盘）')
  }
  return io
}

function requireLoadData(input) {
  const f = input && input.loadData
  if (typeof f !== 'function') {
    throw new TypeError('content：必须注入 loadData(相对路径)（台账数据源由调用方加载，内核不 require 盘上的课程数据）')
  }
  return f
}

const dirSort = (a, b) => a.name.localeCompare(b.name)

function readJson(io, abs) {
  return JSON.parse(io.readFileSync(abs, 'utf8'))
}

/** 递归收集一个目录下的文件（相对该目录的 posix 路径，按名字排序 —— 确定性） */
function walkFiles(io, absDir, { suffix = '', skipDirs = [] } = {}) {
  const out = []
  const step = (dirAbs, parts) => {
    if (!io.existsSync(dirAbs)) return
    let entries = []
    try {
      entries = io.readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.slice().sort(dirSort)) {
      const next = parts.concat(e.name)
      if (e.isDirectory()) {
        if (skipDirs.includes(e.name)) continue
        step(path.join(dirAbs, e.name), next)
        continue
      }
      if (!e.isFile()) continue
      if (suffix && !e.name.endsWith(suffix)) continue
      out.push(next.join('/'))
    }
  }
  step(absDir, [])
  return out
}

/** 读一行 JS 台账（`module.exports = {...}`）—— 由调用方注入 loader，读不动就抛（不伪装空） */
function loadLedgerObject(input, rel) {
  const loadData = requireLoadData(input)
  const value = loadData(rel)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${rel} 必须导出对象（实得 ${Array.isArray(value) ? 'array' : typeof value}）`)
  }
  return value
}

/** 一行 JSONL：坏行**逐行**跳过（追加写的台账坏一行不该毁掉整份），但 `strict` 时抛 */
function parseJsonl(text, { strict = false } = {}) {
  const records = []
  const problems = []
  for (const raw of textCore.splitLines(text)) {
    if (!raw.trim()) continue
    try {
      records.push(JSON.parse(raw))
    } catch (e) {
      if (strict) throw new Error(`台账里有坏行（${e.message}）：${raw.slice(0, 120)}`)
      problems.push(`坏行已跳过：${raw.slice(0, 120)}`)
    }
  }
  return { records, problems }
}

/** 课程身份的**唯一出口**（A07 的变异就改这个函数体：恢复两段 `point/NNNN` 后判据必须红） */
function courseIdOf(circle, point, number) {
  return identity.lessonKey(circle, point, number)
}

/** 知识点身份（`circle/point`）—— 同样只经严格内核 */
function pointIdOf(circle, point) {
  return identity.pointKey(circle, point)
}

/**
 * 「路径优先、meta 可覆盖」—— 课程归属的**唯一**规则（原 build-starmap 与 build-lessons-index 各写一遍）。
 * @param {string} rel 课程页相对 `lessons/src` 的 posix 路径
 * @param {object} meta 课程页 front-matter
 * @param {{null?:boolean}} [opts] `legacyFallback`: 平铺布局的兜底（星图给 LEGACY_*，清单给 null）
 */
function lessonTargets(rel, meta, opts = {}) {
  const parts = String(rel).split('/')
  const legacy = parts.length < 3
  const fallbackHalo = opts.legacyFallback === false ? null : LEGACY_HALO
  const fallbackPoint = opts.legacyFallback === false ? null : LEGACY_POINT
  const halo = meta.halo || (parts.length >= 3 ? parts[0] : fallbackHalo)
  const point = meta.point || (parts.length >= 3 ? parts[1] : fallbackPoint)
  return { halo, point, legacy, overriddenByMeta: Boolean(meta.halo || meta.point) }
}

/* ══════════════════════════════════════════════════════════════════════
 * 模型：把「课程包里的静态事实」读一次（按需）
 * ══════════════════════════════════════════════════════════════════════ */

/** 圆圈 → 知识点（`lessons/<circle>/halo.json`、`lessons/<circle>/<point>/point.json`） */
function readHalos(io, root) {
  const lessonsDir = path.join(root, 'lessons')
  const halos = []
  if (!io.existsSync(lessonsDir)) return halos
  for (const d of io.readdirSync(lessonsDir, { withFileTypes: true }).slice().sort(dirSort)) {
    if (!d.isDirectory()) continue
    const haloFile = path.join(lessonsDir, d.name, 'halo.json')
    if (!io.existsSync(haloFile)) continue
    const halo = readJson(io, haloFile)
    const points = []
    const dir = path.join(lessonsDir, d.name)
    for (const p of io.readdirSync(dir, { withFileTypes: true }).slice().sort(dirSort)) {
      if (!p.isDirectory()) continue
      const pf = path.join(dir, p.name, 'point.json')
      if (!io.existsSync(pf)) continue
      points.push(Object.assign({}, readJson(io, pf), { id: p.name, halo: d.name }))
    }
    halos.push(Object.assign({}, halo, { id: d.name, points }))
  }
  return halos
}

/**
 * 课程源（`lessons/src/**` 的有源模式）或课程星清单（无源离线模式）。
 * @returns {{sourceMode:boolean, entries:Array<{rel:string, meta:object|null, problem:string|null}>, warnings:string[]}}
 */
function readSourceLessons(io, root) {
  const srcDir = path.join(root, 'lessons', 'src')
  const sourceMode = io.existsSync(srcDir)
  const warnings = []
  if (sourceMode) {
    const rels = walkFiles(io, srcDir, { suffix: '.html', skipDirs: ['src'] })
    const entries = rels.map((rel) => {
      const text = io.readFileSync(path.join(srcDir, rel), 'utf8')
      const m = text.match(LESSON_META_RE)
      if (!m) return { rel, meta: null, problem: `${rel}: 没有 data-lesson-meta，跳过` }
      try {
        return { rel, meta: JSON.parse(m[1]), problem: null }
      } catch (e) {
        return { rel, meta: null, problem: `${rel}: meta 不是合法 JSON —— ${e.message}` }
      }
    })
    return { sourceMode, entries: entries.sort((a, b) => a.rel.localeCompare(b.rel)), warnings }
  }

  // 无源：`lessons/lessons.json`（导出侧 `build-lessons-index.js` 生成；条目与 src 的 meta 同形）
  const indexFile = path.join(root, 'lessons', 'lessons.json')
  const entries = []
  let index = null
  if (io.existsSync(indexFile)) {
    try {
      index = readJson(io, indexFile)
    } catch (e) {
      warnings.push(`lessons/lessons.json 读不动：${e.message}`)
    }
  }
  for (const l of (index && index.lessons) || []) {
    if (!l || !l.rel) continue
    entries.push({ rel: String(l.rel), meta: l, problem: null })
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  return { sourceMode, entries, warnings }
}

/** 进度：`progress.json.learned` 原样 + 读不到的告警（不伪装成"全都没学"之外的任何东西） */
function readProgress(io, root) {
  const file = path.join(root, 'progress.json')
  if (!io.existsSync(file)) return { exists: false, learned: [], warning: '没有 progress.json → 所有星都按"未点亮"处理' }
  const doc = readJson(io, file)
  const learned = doc && Array.isArray(doc.learned) ? doc.learned.slice() : []
  return { exists: true, learned, warning: null }
}

function readPending(io, root) {
  const file = path.join(root, 'questions', 'pending.jsonl')
  if (!io.existsSync(file)) return { exists: false, records: [], problems: [] }
  const parsed = parseJsonl(io.readFileSync(file, 'utf8'))
  return { exists: true, records: parsed.records, problems: parsed.problems }
}

function readNoteRecords(io, root) {
  const file = path.join(root, 'notes', 'notes.jsonl')
  if (!io.existsSync(file)) return { exists: false, lines: [] }
  return { exists: true, lines: textCore.splitLines(io.readFileSync(file, 'utf8')).filter((l) => l.trim()) }
}

/** 读模型（只读 `needs` 里点名的事实） */
function readCourseModel(input, needs) {
  const io = requireFs(input)
  const root = path.resolve(String(input.root))
  const want = new Set(needs)
  const model = { root, fs: io, needs: [...want] }
  if (want.has('halos')) model.halos = readHalos(io, root)
  if (want.has('sourceLessons')) model.sourceLessons = readSourceLessons(io, root)
  if (want.has('lessonIndex')) model.lessonIndex = packCore.lessonIndex(root)
  if (want.has('progress')) model.progress = readProgress(io, root)
  if (want.has('pending')) model.pending = readPending(io, root)
  if (want.has('notes')) model.notes = readNoteRecords(io, root)
  if (want.has('glossary')) model.glossary = loadLedgerObject(input, 'assets/glossary-data.js')
  if (want.has('questions')) model.questions = loadLedgerObject(input, 'assets/questions-data.js')
  return model
}

/* ══════════════════════════════════════════════════════════════════════
 * 投影 ①：课程星清单（`lessons/lessons.json`）—— 有源模式
 * ══════════════════════════════════════════════════════════════════════ */

/** 清单条目 = `{...meta, rel, slug, halo, point}`（与 src 的 meta **同形**，星图直接当 meta 用） */
function projectLessonsIndex(input) {
  const model = readCourseModel(input, SECTION_NEEDS.lessonsIndex)
  const io = model.fs
  const srcDir = path.join(model.root, 'lessons', 'src')
  if (!io.existsSync(srcDir)) {
    return {
      section: 'lessonsIndex',
      ok: false,
      fatal: {
        code: 1,
        err: ['没有 lessons/src —— 课程星清单只能在**有源文件**的机器上生成（导出侧工具，离线端不跑它）'],
      },
    }
  }
  const warnings = []
  const lessons = []
  for (const entry of model.sourceLessons.entries) {
    if (entry.problem) {
      warnings.push(entry.problem)
      continue
    }
    const meta = entry.meta
    if (meta.number == null) {
      warnings.push(`${entry.rel}: meta 里没有 number，跳过`)
      continue
    }
    const parts = entry.rel.split('/')
    const base = parts[parts.length - 1]
    const slugMatch = LESSON_FILE_RE.exec(base) || /^(.*)\.html$/.exec(base)
    const targets = lessonTargets(entry.rel, meta, { legacyFallback: false })
    lessons.push(Object.assign({}, meta, {
      rel: entry.rel,
      slug: slugMatch && slugMatch[2] ? slugMatch[2] : base.replace(/\.html$/, ''),
      halo: targets.halo,
      point: targets.point,
    }))
  }
  lessons.sort((a, b) => a.rel.localeCompare(b.rel))
  const index = { v: 1, source: 'lessons/src', lessons }
  const text = JSON.stringify(index, null, 2) + '\n'
  const circles = new Set(lessons.map((l) => l.halo).filter(Boolean)).size
  const summary = `${lessons.length} 课 / ${circles} 个圆圈`
  const out = (lines) => lines.map((line) => ({ stream: 'out', line }))
  const err = (lines) => lines.map((line) => ({ stream: 'err', line }))
  return {
    section: 'lessonsIndex',
    ok: true,
    artifact: { rel: ARTIFACT_REL.lessonsIndex, text, mode: 'direct' },
    log: [],
    warn: warnings.slice(),
    messages: {
      write: out([`写出 lessons/lessons.json：${summary}`]),
      unchanged: out([`清单没变：lessons/lessons.json（${summary}）`]),
      checkSame: out([`清单一致：lessons/lessons.json（${summary}）`]),
      checkDiff: err([
        '清单与现算不一致：lessons/lessons.json %CUR%', // `%CUR%`：不存在 / 内容不同
        '  修法：node tools/build-lessons-index.js',
      ]),
    },
    data: { index, summary, lessonCount: lessons.length, circleCount: circles },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 投影 ②：星图载荷（`starmap/content.js`）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 一条台账 `lesson` 值 → 规范课次键。
 * 只认两条：① 规范身份（`circle/point/NNNN`）；② 本包**身份派生出来的显示名**且**唯一**。
 * 其余一律不计（返回 `{ok:false, reason}`），由调用方告警 —— 不猜归属。
 *
 * @param {string} value 台账里的 `lesson`
 * @param {Array<{id:string, point:string, number:number, label:string}>} lessons 本包的课程投影
 * @param {object} byKey 规范课次键索引（`{ [id]: {key, id, point, number, label} }`）
 */
function resolveLedgerLesson(value, lessons, byKey) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: '课次是空值' }
  const ref = packCore.resolveLessonRef(value, { byKey })
  if (ref.ok && !ref.sentinel) return { ok: true, key: ref.key, via: 'identity' }
  const hits = lessons.filter((l) => l.label === value)
  if (hits.length === 1) return { ok: true, key: hits[0].id, via: 'label' }
  if (hits.length > 1) {
    return { ok: false, reason: `显示名在同包里有 ${hits.length} 门课（${hits.map((l) => l.id).join(' / ')}）—— 不猜` }
  }
  return { ok: false, reason: ref.ok ? '是「未归课」哨兵，不是一个课次' : `课次解析不到（${ref.failure.reason}）` }
}

/** 答疑（未解决）按课聚合 —— 只走 `resolveLedgerLesson` 的唯一对位，绝不按字符串相等猜 */
function pendingCountByLesson(pending, lessons, warn) {
  const byKey = {}
  for (const l of lessons) byKey[l.id] = { key: l.id, id: l.id, point: l.point, number: l.number, label: l.label }
  const map = new Map()
  for (const rec of pending.records) {
    if (!rec || typeof rec !== 'object') continue
    const r = resolveLedgerLesson(rec.lesson, lessons, byKey)
    if (!r.ok) {
      warn(`答疑记录 ${rec.id || '(无编号)'} 的课次 ${JSON.stringify(rec.lesson)} ${r.reason}（不计入任何课）`)
      continue
    }
    map.set(r.key, (map.get(r.key) || 0) + 1)
  }
  return map
}

function projectStarmap(input) {
  const model = readCourseModel(input, SECTION_NEEDS.starmap)
  const { fs: io, root } = model
  const options = (input && input.options) || {}
  const deps = (input && input.deps) || {}
  const gx = deps.galaxyShapes
  if (!gx || typeof gx.validate !== 'function' || typeof gx.pickShape !== 'function' || typeof gx.audit !== 'function') {
    throw new TypeError('content：starmap 投影要注入 deps.galaxyShapes（形状字典在课程包 tools/galaxy-shapes.cjs，不在内核里复制第二份）')
  }
  const warns = []
  const notes = []
  const warn = (m) => warns.push(m)
  const note = (m) => notes.push(m)
  const fatal = (lines) => ({ section: 'starmap', ok: false, fatal: { code: 1, err: lines } })

  const halos = model.halos
  if (!halos.length) {
    return fatal(['没有找到任何 lessons/<halo>/halo.json —— 星图无从生成'])
  }

  // —— 星系形状：硬校验 + 防单调审计（失败即退出，不静默降级成单星）——
  const shapeErrs = []
  for (const h of halos) {
    const errs = gx.validate(h, halos)
    if (errs.length) shapeErrs.push(`${h.id}：${errs.join('；')}`)
  }
  if (shapeErrs.length) {
    return fatal(['星系形状有问题（见 tools/galaxy-shapes.cjs）：'].concat(shapeErrs.map((e) => `  ✗ ${e}`)))
  }
  for (const w of gx.audit(halos)) warn(`形状审计：${w}`)

  // —— 知识点前置：解析 + 硬校验（悬空 / 自指 / 成环）——
  const allowMissingRequires = options.allowMissingRequires === true
  const requiresOf = new Map()
  {
    const byKey = new Map()
    for (const h of halos) for (const p of h.points) byKey.set(`${h.id}/${p.id}`, { h, p })
    const errs = []
    const pair = []
    const resolve = (ref, haloId) => (String(ref).includes('/') ? String(ref) : `${haloId}/${ref}`)
    for (const h of halos) {
      for (const p of h.points) {
        const self = `${h.id}/${p.id}`
        const list = []
        for (const ref of p.requires || []) {
          const key = resolve(ref, h.id)
          if (!byKey.has(key)) {
            if (allowMissingRequires) { warn(`${self}: 前置「${ref}」不在这个包里 —— 离线端降级为跳过`); continue }
            errs.push(`${self}: 前置「${ref}」找不到对应的知识点`)
            continue
          }
          if (key === self) { errs.push(`${self}: 前置指向自己`); continue }
          list.push(key)
          pair.push([key, self])
        }
        if (list.length) requiresOf.set(self, list)
      }
    }
    const adj = new Map()
    for (const [from, to] of pair) {
      if (!adj.has(from)) adj.set(from, [])
      adj.get(from).push(to)
    }
    const state = new Map()
    const dfs = (n, walkPath) => {
      if (state.get(n) === 1) {
        const cut = walkPath.slice(walkPath.indexOf(n))
        errs.push(`前置成环：${cut.concat(n).join(' → ')}`)
        return
      }
      if (state.get(n) === 2) return
      state.set(n, 1)
      for (const m of adj.get(n) || []) dfs(m, walkPath.concat(n))
      state.set(n, 2)
    }
    for (const n of adj.keys()) dfs(n, [])
    if (errs.length) {
      return fatal(['知识点前置有问题（point.json 的 requires）：'].concat([...new Set(errs)].map((e) => `  ✗ ${e}`)))
    }
  }

  // —— 进度（模型已读原文；这里只做**规范身份**折算，历史形状逐条点名）——
  if (model.progress.warning) warn(model.progress.warning)
  for (const w of model.sourceLessons.warnings) warn(w)

  // —— 课程（小星星）：有源扫 src；无源读清单 ——
  const lessons = []
  const DK_OF = new Map()          // 课次键 → 知识点身份（`circle/point`）—— 外观标定按它分圈
  const builtDisplay = new Map()   // "circle/point" → 已建课的**显示号**数组（规划暗星的前沿判断要用它）
  const legacy = []
  for (const entry of model.sourceLessons.entries) {
    if (entry.problem) { warn(entry.problem); continue }
    const meta = entry.meta
    if (!meta || meta.number == null) continue
    const targets = lessonTargets(entry.rel, meta)
    const haloId = targets.halo
    const pointId = targets.point
    if (targets.legacy) legacy.push(entry.rel)
    const halo = halos.find((h) => h.id === haloId)
    if (!halo) { warn(`${entry.rel}: meta.halo="${haloId}" 找不到对应圆圈，跳过`); continue }
    const point = halo.points.find((p) => p.id === pointId)
    if (!point) { warn(`${entry.rel}: 找不到知识点 ${haloId}/${pointId}，跳过`); continue }

    const built = path.join(root, 'lessons', entry.rel)
    if (!io.existsSync(built)) warn(`${entry.rel}: 构建产物 lessons/${entry.rel} 不存在 —— 先跑 node tools/build-lessons.js`)

    const number = Number(meta.number)
    const id = courseIdOf(haloId, pointId, number) // ★ 课程身份的唯一构造点
    const displayNumber = packCore.displayNumberOf(number, point.fileBase)
    const dk = pointIdOf(haloId, pointId)
    if (!builtDisplay.has(dk)) builtDisplay.set(dk, [])
    builtDisplay.get(dk).push(displayNumber)
    const label = point.label ? `${point.label} 第${displayNumber}课` : `第${displayNumber}课`
    lessons.push({
      id, halo: haloId, point: pointId, pointName: point.name || pointId,
      number, label, title: meta.title || '',
      navTitle: meta.navTitle || meta.title || '',
      href: `lessons/${entry.rel}`, learned: false, // 下面统一按规范身份折算
      termCount: Object.keys(meta.terms || {}).length,
      source: (meta.source && meta.source.label) || '',
      sourceUrl: (meta.source && meta.source.url) || '',
      flag: (meta.flag === 'red' || meta.flag === 'yellow') ? meta.flag : null,
    })
    DK_OF.set(id, dk)
  }
  lessons.sort((a, b) => a.point.localeCompare(b.point) || (a.number - b.number) || a.halo.localeCompare(b.halo))

  // —— 已学：`resolveLearned`（只认规范身份；历史形状逐条告警、不计入）——
  const learnedIndex = {}
  for (const l of lessons) learnedIndex[l.id] = { key: l.id, id: l.id, point: l.point, number: l.number, label: l.label }
  const learnedResult = packCore.resolveLearned(model.progress.learned, { byKey: learnedIndex })
  for (const problem of learnedResult.problems) warn(problem)
  const learnedSet = new Set(learnedResult.lit)
  for (const l of lessons) l.learned = learnedSet.has(l.id)

  // —— 答疑（未解决）计数：按规范身份聚合，只作用于目标课程 ——
  const pendingBy = pendingCountByLesson(model.pending, lessons, warn)

  // —— 外观三段 ——
  {
    const pointToHalo = new Map()
    for (const h of halos) for (const p of h.points) pointToHalo.set(pointIdOf(p.circle || h.id, p.id), h.id)
    const wMax = Math.max(1, ...lessons.map((l) => l.termCount || 0))
    const lnW = Math.log(1 + wMax)
    const gm = new Map()
    for (const l of lessons) {
      const hid = pointToHalo.get(DK_OF.get(l.id)) || l.halo
      gm.set(hid, Math.max(gm.get(hid) || 0, l.termCount || 0))
    }
    const gMax = Math.max(1, ...gm.values())
    for (const l of lessons) {
      const w = l.termCount || 0
      const ratio = lnW > 0 ? Math.log(1 + w) / lnW : 0
      l.size = Number((0.62 + 0.50 * Math.pow(ratio, 1.1)).toFixed(4))
      const hid = pointToHalo.get(DK_OF.get(l.id)) || l.halo
      const g = gm.get(hid) || 0
      const galScale = gMax > 0 ? 0.45 + 0.55 * (Math.log(1 + g) / Math.log(1 + gMax)) : 1
      const relIn = g > 0 ? w / g : 0
      l.bright = Number((galScale * (0.62 + 0.38 * relIn)).toFixed(4))
      l.pendingQ = pendingBy.get(l.id) || 0
      l.flag = l.flag || (l.pendingQ ? 'red' : null)
    }
  }
  if (legacy.length) warn(`历史平铺布局（归给 ${LEGACY_POINT}）：${legacy.join('、')} —— 目录重构后应消失`)

  // —— 连线（端点按规范身份查表：跨圈同名点不再互踩）——
  // ⚠️ 域约定（U-SPEC §2 + 决-11）：`halo.json` 里声明的连线端点是**页面域**写法
  // `point/NNNN`（作者侧一直这么写、也别改），而 `lessons[].id` 是运行态身份
  // `circle/point/NNNN`。两个域必须**显式搭桥**：先按规范键查，查不到再按页面域键查；
  // 命中的端点统一按**规范身份**落进 edges（星图节点 id 就是规范身份）。
  // 不搭桥的后果不是"少一条线"那么轻：旧活包的连线会**全部被跳过**（端点查不到），星图退化成散点。
  const byId = new Map(lessons.map((l) => [l.id, l]))
  // ⚠️ `number` 是**数字**（1 / 2 / 3），页面域写法是四位零填充（`0001`）—— 这里必须补零，
  // 否则键是 `spring-boot/1`，与 halo.json 里声明的 `spring-boot/0001` 永远对不上。
  const pageKeyOf = (l) => `${l.point}/${String(l.number).padStart(4, '0')}`
  const byPageKey = new Map(lessons.map((l) => [pageKeyOf(l), l]))
  const edges = []
  for (const halo of halos) {
    for (const e of (halo.edges && halo.edges.list) || []) {
      const a = byId.get(e.from) || byPageKey.get(e.from)
      const b = byId.get(e.to) || byPageKey.get(e.to)
      if (!a || !b) { warn(`连线 ${e.from} → ${e.to}（${e.kind}）端点还不存在，跳过`); continue }
      edges.push({ from: a.id, to: b.id, kind: e.kind || '', note: e.note || '' })
    }
  }

  // —— 规划暗星：只画**地图前沿**（判据在 ./plan.cjs，不重写）——
  let plannedTotal = 0
  const plannedOf = (h, p) => {
    const at = `${h.id}/${p.id}`
    const f = planCore.planFrontier(p.plan, builtDisplay.get(at) || [])
    if (!f.ok) {
      warn(`${at}: 地图缺失或不合法，规划暗星一颗都不画 —— ${f.problems.join('；')}`)
      return []
    }
    if (f.exhausted) {
      note(`${at}: 地图 ${f.created} 课全建完了 —— 没有下一颗星，规划暗星 0 颗`)
      return []
    }
    plannedTotal += f.stars.length
    note(`${at}: 规划暗星 ${f.stars.map((n) => `第${n.no}课`).join(' + ')}（已建 ${f.created}／共 ${f.created + f.missing}）`)
    return f.stars.map((n) => ({ no: n.no, title: n.title, deliverable: n.deliverable, criteria: n.criteria, branch: n.branch === true }))
  }

  const payload = {
    termTotal: Object.keys(model.glossary).length,
    halos: halos.map((h) => {
      const shape = gx.pickShape(h)
      const def = gx.SHAPES[shape] || {}
      const circles = gx.circlesOf(h)
      const coreList = def.coresFromCircle
        ? circles.map((cid) => {
          const o = halos.find((x) => x.id === cid)
          return { halo: cid, name: o ? o.name : cid, color: cid === h.id ? (o && o.hue) || null : null }
        })
        : [{ halo: h.id, name: h.name, color: null }]
      const coreIndexOf = (p) => {
        const i = coreList.findIndex((c) => c.halo === (p.circle || h.id))
        return i < 0 ? 0 : i
      }
      return {
        id: h.id, name: h.name, center: h.center || '',
        color: h.color || null,
        inside: h.inside || [], outside: h.outside || [],
        ...(Array.isArray(h.groups) && h.groups.length ? { groups: h.groups } : {}),
        shape,
        orbit: def.orbit || 0,
        lean: def.lean || 0,
        branch: def.branch || 'branch',
        circles,
        cores: coreList,
        points: h.points.map((p) => ({
          id: p.id, name: p.name || p.id, label: p.label || '',
          circle: p.circle || h.id,
          core: coreIndexOf(p),
          requires: requiresOf.get(`${h.id}/${p.id}`) || [],
          planned: plannedOf(h, p),
        })),
      }
    }),
    lessons,
    edges,
  }
  const body = JSON.stringify(payload, null, 2)
  const text = `${STAR_CONTENT_HEAD}\nwindow.STARMAP_REAL = ${body};\n`
  const line = (stream) => (s) => ({ stream, line: s })
  const logLines = notes.map((n) => `· ${n}`).concat(warns.map((w) => `⚠️ ${w}`))
  const summary = `[starmap] 圆圈 ${payload.halos.length} · 知识点 ${payload.halos.reduce((n, h) => n + h.points.length, 0)} · 课程 ${lessons.length}（已点亮 ${lessons.filter((l) => l.learned).length}）· 连线 ${edges.length} · 规划暗星 ${plannedTotal}`
  return {
    section: 'starmap',
    ok: true,
    artifact: { rel: ARTIFACT_REL.starmap, text, mode: 'atomic' },
    log: logLines.concat([summary]),
    warn: [],
    messages: {
      // `%REL%` / `%CHARS%` 由调用方按自己的包根与平台分隔符填（文案只在这一处）
      write: [{ stream: 'out', line: '[starmap] 写出 %REL%（%CHARS% 字符）' }],
      checkSame: [{ stream: 'out', line: '[check] ✅ 星图数据与课程包一致' }],
      checkDiff: [{ stream: 'err', line: '[check] ❌ 星图数据有漂移：跑 node tools/build-starmap.js 重建' }],
    },
    data: { payload, summary, counts: { halos: payload.halos.length, lessons: lessons.length, learned: lessons.filter((l) => l.learned).length, edges: edges.length, planned: plannedTotal } },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 投影 ③：名词树（`assets/glossary-tree.js`）
 * ══════════════════════════════════════════════════════════════════════ */

/** 有没有任何一个 `lessons/<圆圈>/halo.json`（技能包守卫用它判"这里根本没有课程数据"） */
function anyHalo(io, root) {
  const lessonsDir = path.join(root, 'lessons')
  try {
    return io.readdirSync(lessonsDir, { withFileTypes: true })
      .some((e) => e.isDirectory() && e.name !== 'src' && io.existsSync(path.join(lessonsDir, e.name, 'halo.json')))
  } catch {
    return false
  }
}

/**
 * 名词台账的 `lesson`（**显示名**）→ 课程身份。
 * 只认「身份派生出来的显示名」：唯一对位才算；撞车 / 对不上 → 不归属（进 `unassigned`），
 * 绝不把名词按字符串相似度猜给某一门课。
 */
function resolveTermLesson(lessonText, index) {
  const label = String(lessonText || '').trim()
  if (!label) return null
  const ref = packCore.resolveLessonRef(label, index)
  if (ref.ok && !ref.sentinel && index.byKey && index.byKey[ref.key]) return ref.key
  const hits = Object.keys(index.byKey || {}).filter((k) => index.byKey[k] && index.byKey[k].label === label)
  return hits.length === 1 ? hits[0] : null
}

function projectGlossaryTree(input) {
  const io = requireFs(input)
  const root = path.resolve(String(input.root))
  const hasGlossary = io.existsSync(path.join(root, 'assets', 'glossary-data.js'))
  if (!anyHalo(io, root) || !hasGlossary) {
    return {
      section: 'glossaryTree',
      ok: true,
      skip: {
        code: 0,
        log: [
          '=== 跳过：本目录没有 lessons/<圆圈>/halo.json 或 assets/glossary-data.js ===',
          '⚠️ 这是「跳过」，不是「通过」。在有课程数据的工作区里跑才有意义。',
        ],
      },
    }
  }

  const model = readCourseModel(input, SECTION_NEEDS.glossaryTree)
  const GLOSSARY = model.glossary
  const index = model.lessonIndex
  const lessonsDir = path.join(model.root, 'lessons')

  const termLesson = {}
  for (const [key, g] of Object.entries(GLOSSARY)) termLesson[key] = String((g && g.lesson) || '').trim()

  // 域桥：`halo.json` 里声明的连线端点是**页面域**写法 `point/NNNN`（决-11 不动），
  // 而本投影里的课程节点用**运行态身份** `circle/point/NNNN`。不桥的后果：名词地图里
  // 课程与课程之间的连线整片消失（判据：`tools/glossary-map.test.mjs` 的悬停连线数）。
  const pageToCanon = new Map()
  for (const [k, v] of Object.entries(index.byKey || {})) {
    if (!v || !v.point) continue
    pageToCanon.set(`${v.point}/${String(v.number).padStart(4, '0')}`, k)
  }
  const canonEdgeEnd = (x) => pageToCanon.get(String(x)) || String(x)

  const termKeyByLesson = new Map()
  const unassigned = []
  const assigned = new Set()
  for (const [key, label] of Object.entries(termLesson)) {
    if (!label) continue
    const lessonKey = resolveTermLesson(label, index)
    if (!lessonKey) continue
    if (!termKeyByLesson.has(lessonKey)) termKeyByLesson.set(lessonKey, [])
    termKeyByLesson.get(lessonKey).push(key)
  }

  const halos = io.readdirSync(lessonsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'src')
    .map((e) => e.name)
    .filter((id) => io.existsSync(path.join(lessonsDir, id, 'halo.json')))
    .sort()
    .map((haloId) => {
      const halo = readJson(io, path.join(lessonsDir, haloId, 'halo.json'))
      const pointIds = io.readdirSync(path.join(lessonsDir, haloId), { withFileTypes: true })
        .filter((e) => e.isDirectory() && io.existsSync(path.join(lessonsDir, haloId, e.name, 'point.json')))
        .map((e) => e.name)
        .sort()
      const points = pointIds.map((pid) => {
        const pj = readJson(io, path.join(lessonsDir, haloId, pid, 'point.json'))
        // ⚠️ 归属必须**圆圈 + 知识点**一起对：跨圈同名知识点（`math/vue` 与 `programming/vue`）
        //    只按 pid 过滤会把别的圈的课程挂到这个点上（A02 的原始缺陷）。
        //    ⚠️ 课次映射表的 `byKey` 条目**没有** `circle` 字段（规范键自己在第一段），别去读它。
        const circleOf = (l) => l.circle || String(l.key || l.id || '').split('/')[0]
        const lessons = Object.values(index.byKey || {})
          .filter((l) => l && circleOf(l) === haloId && l.point === pid)
          .sort((a, b) => a.displayNumber - b.displayNumber)
          .map((l) => {
            const keys = termKeyByLesson.get(l.key) || []
            keys.forEach((k) => assigned.add(k))
            let title = String(l.title || '').trim()
            if (title.startsWith(l.label)) title = title.slice(l.label.length).trim()
            return {
              key: l.key,
              label: l.label,
              title,
              number: l.displayNumber,
              page: l.page || '',
              terms: keys,
            }
          })
        return {
          id: pid,
          name: pj.name || pid,
          label: pj.label || '',
          requires: Array.isArray(pj.requires) ? pj.requires.slice() : [],
          lessons,
        }
      })
      return {
        id: haloId,
        name: halo.name || haloId,
        color: halo.color || '',
        center: halo.center || '',
        edges: ((halo.edges && halo.edges.list) || []).map((e) => ({
          from: canonEdgeEnd(e.from), to: canonEdgeEnd(e.to), kind: e.kind || '', note: e.note || '',
        })),
        points,
      }
    })

  for (const key of Object.keys(GLOSSARY)) if (!assigned.has(key)) unassigned.push(key)

  const termTotal = Object.keys(GLOSSARY).length
  const tree = { generated: TREE_GENERATED, termTotal, halos, unassigned }
  const html = `// ${TREE_GENERATED}
${TREE_CONTENT_SOURCE}
// 名词地图（glossary/index.html）读这一份；**别在页面里硬编码层级**。
(function (root) {
  'use strict';
  var TREE = ${JSON.stringify(tree, null, 2)};
  if (typeof module === 'object' && module.exports) module.exports = TREE;
  else root.GLOSSARY_TREE = TREE;
})(typeof self !== 'undefined' ? self : this);
`
  const counts = halos.map((h) => `${h.name}(${h.points.length} 知识点/${h.points.reduce((n, p) => n + p.lessons.length, 0)} 课)`).join(' · ')
  const summary = `[tree] 圆圈 ${halos.length} · ${counts} · 名词 ${termTotal}${unassigned.length ? ` · ⚠️ 拼不上课次 ${unassigned.length}：${unassigned.join(', ')}` : ''}`
  const rel = ARTIFACT_REL.glossaryTree
  return {
    section: 'glossaryTree',
    ok: true,
    artifact: { rel, text: html, mode: 'atomic' },
    log: [],
    warn: [],
    messages: {
      write: [{ stream: 'out', line: '[tree] %REL%  %CHARS% 字符' }, { stream: 'out', line: summary }],
      checkSame: [{ stream: 'out', line: `[check] ✅ %REL% 无漂移` }],
      checkMissing: [{ stream: 'err', line: `[check] ❌ %REL% 不存在（忘了构建）` }],
      checkDiff: [{ stream: 'err', line: `[check] ❌ %REL% 磁盘与构建结果不一致（改了 halo/point/课次/名词台账？）` }],
    },
    data: { tree, summary, counts: { halos: halos.length, terms: termTotal, unassigned: unassigned.length } },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 投影 ④：笔记文档页（`reference/NOTES.html`）
 * ══════════════════════════════════════════════════════════════════════ */

/** 课程页里有没有**课程源**（递归找 `NNNN-*.html`；只看一层会把"有课"误判成"没课"） */
function hasCourseSource(io, root) {
  const srcDir = path.join(root, 'lessons', 'src')
  if (!io.existsSync(srcDir)) return false
  return walkFiles(io, srcDir, { suffix: '.html', skipDirs: ['src'] }).some((rel) => LESSON_FILE_RE.test(rel.split('/').pop()))
}

/**
 * 台账里的课次值 → `{key, label}`。
 * 规范身份 → 显示名（身份派生）；显示名 → 它自己（页面领域）；`未归课` → 哨兵。
 * 对不上的返回 `null`（调用方决定落到"未归课"桶还是点名）。
 */
function resolveLessonLabel(value, index) {
  if (value === UNLESSON) return { key: UNLESSON, label: UNLESSON, sentinel: true }
  const ref = packCore.resolveLessonRef(value, index)
  if (ref.ok && !ref.sentinel && index.byKey && index.byKey[ref.key]) {
    return { key: ref.key, label: index.byKey[ref.key].label }
  }
  if (typeof value === 'string' && value.trim()) {
    const hits = Object.keys(index.byKey || {}).filter((k) => index.byKey[k] && index.byKey[k].label === value)
    if (hits.length === 1) return { key: hits[0], label: value, viaLabel: true }
    if (hits.length === 0 && /第\s*\d+\s*课/.test(value)) return { key: null, label: value, unregistered: true }
  }
  return null
}

/**
 * 一个**展示节**（按显示名组织）的可写课次身份。
 *
 * 笔记台账的 `anchor` 是**身份**（`circle/point/NNNN`），不是显示名 —— 写入口
 * （`lib/notes-io.js#appendNote` / 包侧 `ask-server.js` 的 `/note`）只认规范身份，
 * 显示名与两段课键一律当场拒写。所以生成表单时**必须**把该节对应的规范课次键烘进去，
 * 不能把显示名当身份发出去（2026-10-20 独立审查实测：发显示名 → 400 孤儿锚点）。
 *
 * 只有「显示名 → 课次」**唯一**时才给键：
 *   · 唯一命中（映射表里恰好一门课的 label 等于它）→ 给那个规范键；
 *   · 零命中（历史展示节 / `未归课` 之外的野名字）→ **不给**，页面侧也不许猜；
 *   · 多命中（跨圈同名撞车）→ **不给**，把候选报出来（写明撞车，不静默取其一）。
 * `未归课` 是**显式落桶**，它自己的规范写法就是 `未归课`（写入口认它），照旧可写。
 *
 * @param {string} label 展示节标签
 * @param {{byKey: object}} index 课次映射表
 * @returns {{key: string}|{key: null, why: string}}
 */
function writableLessonKey(label, index) {
  // 唯一实现是内核 `resolveLessonLabel`（显示名 → 规范键，唯一命中才给键）；
  // 这里只把它的 failure 翻成人话，**不另写一份命中判定**（那会变成第二座显示名桥）。
  const r = packCore.resolveLessonLabel(label, index)
  if (r.ok) return { key: r.key }
  return { key: null, why: r.failure.error }
}

function projectNotes(input) {
  const io = requireFs(input)
  const root = path.resolve(String(input.root))
  const ASSETS = path.join(root, 'assets')
  if (!io.existsSync(path.join(ASSETS, 'questions-data.js'))) {
    return {
      section: 'notes',
      ok: true,
      skip: {
        code: 0,
        log: [
          '=== 跳过：本目录没有 assets/questions-data.js（技能包只带引擎，课程数据由使用者创建）===',
          '⚠️ 这是「跳过」，不是「通过」。在有课程数据的课程包根跑才有意义。',
        ],
      },
    }
  }
  if (!hasCourseSource(io, root)) {
    return {
      section: 'notes',
      ok: true,
      skip: {
        code: 0,
        log: [
          '=== 跳过：本目录没有课程源 lessons/src/*.html（技能包只带引擎，课程数据由使用者创建）===',
          '⚠️ 这是「跳过」，不是「通过」。在有课程数据的工作区里跑才有意义。',
        ],
      },
    }
  }

  const model = readCourseModel(input, SECTION_NEEDS.notes)
  const index = model.lessonIndex
  const deps = (input && input.deps) || {}
  const withStaticTitles = deps.withStaticTitles
  if (typeof withStaticTitles !== 'function') {
    throw new TypeError('content：notes 投影要注入 deps.withStaticTitles（h2/h3 静态流彩类由课程包 tools/title-classes.js 提供，内核不造第二份）')
  }
  const escapeHtml = renderCore.escapeHtml
  const labelAnchorId = packCore.labelAnchorId
  const QUESTIONS = model.questions
  const warn = []

  /** 读笔记台账（逐行；坏行跳过 —— 与包侧既有语义一致） */
  const noteRecords = []
  for (const l of model.notes.lines) {
    try {
      const n = JSON.parse(l)
      if (n) noteRecords.push(n)
    } catch { /* 坏行跳过 */ }
  }

  /** 已解答的答疑按**课次身份**分组；台账里的 `lesson` 是显示名或规范身份，两种都经唯一换算 */
  const qaByKey = new Map()
  const qaByLabel = new Map()
  for (const q of Object.values(QUESTIONS)) {
    if (!q || q.status !== 'answered' || !q.answerHtml) continue
    const r = resolveLessonLabel(q.lesson, index)
    const key = r ? r.key : null
    if (key) {
      if (!qaByKey.has(key)) qaByKey.set(key, [])
      qaByKey.get(key).push(q)
    } else {
      // 换算不到身份（空课次 / 显示名撞车 / 映射表里没有这一课）：按**它自己的显示名**单独成节。
      // 这不是"猜归属" —— 节本来就是显示层的东西；猜归属指的是把它算到某一门**别的**课头上，那不做。
      const bucket = (r && r.label) || (String(q.lesson || '').trim() ? q.lesson : UNLESSON)
      if (!qaByLabel.has(bucket)) qaByLabel.set(bucket, [])
      qaByLabel.get(bucket).push(q)
      if (r && r.unregistered) warn(`答疑 ${q.id || ''} 的课次 ${JSON.stringify(q.lesson)} 在课次映射表里没有对应课（仍按显示名单独成节）`)
    }
  }
  for (const arr of qaByKey.values()) arr.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  for (const arr of qaByLabel.values()) arr.sort((a, b) => String(a.id).localeCompare(String(b.id)))

  /** 某课（显示名）已解答的答疑条数 —— 节按显示名组织（页面锚点就是显示名派生的） */
  const qaForLabel = (label) => {
    const out = []
    for (const [key, arr] of qaByKey) {
      const entry = index.byKey[key]
      if (entry && entry.label === label) out.push(...arr)
    }
    // 台账里**解析不到身份**的记录：显示名与本节一致就挂在它下面（不静默丢）
    if (qaByLabel.has(label)) out.push(...qaByLabel.get(label))
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }

  /** 读某课的笔记（台账 anchor → 身份 → 显示名） */
  const notesForLabel = (label) => noteRecords
    .filter((n) => {
      const r = resolveLessonLabel(n && n.anchor, index)
      const lab = r ? r.label : null
      return lab === label
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))

  const lessonNumber = (lesson) => {
    const m = /(\d+)/.exec(String(lesson))
    return m ? parseInt(m[1], 10) : 9999
  }

  // 课次清单 = 课程包里**全部课**（映射表是权威；它的 label 推出的锚点 id 与课程页小封面卡同一条公式）
  const allLabels = new Set(Object.values(index.byKey || {}).map((e) => e.label))
  for (const key of qaByKey.keys()) {
    const e = index.byKey[key]
    if (e) allLabels.add(e.label)
  }
  for (const label of qaByLabel.keys()) allLabels.add(label)
  for (const n of noteRecords) {
    const r = resolveLessonLabel(n && n.anchor, index)
    if (r && r.label) allLabels.add(r.label)
  }

  const orderOf = (label) => {
    const e = index.byLabel[label]
    return e ? [e.point, e.displayNumber] : ['~', lessonNumber(label)]
  }
  const lessons = [...allLabels].sort((a, b) => {
    const A = orderOf(a)
    const B = orderOf(b)
    return A[0] === B[0] ? A[1] - B[1] : String(A[0]).localeCompare(String(B[0]))
  })

  const sections = lessons.map((lesson) => {
    const label = lesson || UNLESSON
    const anchor = labelAnchorId(label)
    const qa = qaForLabel(lesson)
    const notes = notesForLabel(lesson)
    const lines = []
    lines.push(`  <details open class="notes-doc" id="${anchor}">`)
    lines.push(`    <summary><h2>${label}</h2></summary>`)
    lines.push(`    <h3 id="${anchor}-答疑">答疑</h3>`)
    if (qa.length) {
      lines.push('    <div class="notes-qa">')
      for (const q of qa) {
        lines.push(`      <article id="${q.anchor}">`)
        lines.push(`        <div class="notes-qa-q">问： ${escapeHtml(q.question)}</div>`)
        lines.push('        <div class="notes-qa-a">')
        lines.push(`          ${q.answerHtml}`)
        lines.push('        </div>')
        lines.push('      </article>')
      }
      lines.push('    </div>')
    } else {
      lines.push('    <p class="is-note">本课暂无答疑。</p>')
    }
    lines.push(`    <h3 id="${anchor}-笔记">我的笔记</h3>`)
    lines.push('    <div class="notes-mynotes">')
    // 表单携带的是**该节的规范课次身份**（标题仍显示名称）—— 写入口只认身份；
    // 定不到唯一课次的节**不给身份、也不给可提交的控件**，绝不猜一个目标出来。
    const target = writableLessonKey(label, index)
    if (target.key) {
      lines.push(`      <form data-note-form data-note-lesson="${escapeHtml(target.key)}">`)
      lines.push('        <textarea data-note-input rows="3" placeholder="写点你自己的话…"></textarea>')
      lines.push('        <button type="submit">记下</button>')
    } else {
      lines.push(`      <form data-note-form data-note-unwritable="${escapeHtml(target.why)}">`)
      lines.push(`        <textarea data-note-input rows="3" disabled placeholder="${escapeHtml(target.why)}"></textarea>`)
      lines.push('        <button type="submit" disabled>记下</button>')
      lines.push(`        <p class="is-note">${escapeHtml(target.why)}</p>`)
    }
    lines.push('        <ul data-note-list>')
    for (const n of notes) {
      const date = n.at ? new Date(n.at).toLocaleString('zh-CN') : ''
      lines.push(`          <li><time>${escapeHtml(date)}</time>${escapeHtml(n.text)}</li>`)
    }
    lines.push('        </ul>')
    lines.push('        <p data-note-status></p>')
    lines.push('      </form>')
    lines.push('    </div>')
    lines.push('  </details>')
    return lines.join('\n')
  }).join('\n\n')

  const navItems = lessons.map((lesson) => {
    const label = lesson || UNLESSON
    const anchor = labelAnchorId(label)
    const qa = qaForLabel(lesson)
    const notes = notesForLabel(lesson)
    return [
      '        <details open>',
      `          <summary>${label}</summary>`,
      '          <ul>',
      `            <li><a href="#${encodeURIComponent(`${anchor}-答疑`)}">答疑 <span class="notes-count">${qa.length}</span></a></li>`,
      `            <li><a href="#${encodeURIComponent(`${anchor}-笔记`)}">我的笔记 <span class="notes-count">${notes.length}</span></a></li>`,
      '          </ul>',
      '        </details>',
    ].join('\n')
  }).join('\n')

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH 笔记</title>
  <link rel="stylesheet" href="../assets/theme.css">
  <link rel="stylesheet" href="../assets/styles.css">
  <link rel="stylesheet" href="../assets/notes-page.css">
  <noscript><style>.notes-search { display: none; }</style></noscript>
</head>
<body id="top" data-notes-page="all">
  <script src="../assets/theme-boot.js"></script>
  <header class="notes-top">
    <div class="notes-top__left">
      <h1 class="notes-top__title rainbow-title">DSH 笔记</h1>
      <p class="notes-top__sub rainbow-subtitle">答疑来自 questions-data.js / 笔记来自 notes.jsonl</p>
      <a class="notes-top__map" href="../glossary/">名词解释不在这里 · 去名词地图 →</a>
    </div>
    <div class="notes-top__search">
      <input type="search" class="notes-search" placeholder="搜索..." aria-label="搜索笔记">
      <button type="button" class="notes-search__go">搜索</button>
    </div>
  </header>
  <div class="notes-shell">
    <nav class="notes-nav" aria-label="笔记导航">
${navItems}
    </nav>
    <main class="notes-main" data-content>
      <!-- 拖动手柄：必须挂在 [data-content] 容器**里面**（否则绝对定位的包含块会变成
           body 网格区的整个第 2 列，right 会把人推到窗口最右侧）—— 与课程页同一套契约 -->
      <button class="page-splitter page-splitter--start" role="separator" aria-orientation="vertical"
              data-side="start" aria-label="拖动调整正文左缘（右缘不动）；按住 Shift 平移整列" title="拖动调整正文左缘；按住 Shift 平移整列" tabindex="0"></button>
      <button class="page-splitter" role="separator" aria-orientation="vertical"
              data-side="end" aria-label="拖动调整正文右缘（左缘不动）；按住 Shift 平移整列" title="拖动调整正文右缘；按住 Shift 平移整列" tabindex="0"></button>
${sections}
      <a class="notes-to-top" href="#top">回到顶部</a>
    </main>
  </div>
  <script src="../assets/theme.js"></script>
  <script src="../assets/notes.js"></script>
  <!-- 顺序不能反：page-splitter.js 依赖 notes-width.js 提供的 window.LESSON_WIDTH -->
  <script src="../assets/notes-width.js"></script>
  <script src="../assets/page-splitter.js"></script>
</body>
</html>`

  const out = withStaticTitles(html)
  const rel = ARTIFACT_REL.notes
  return {
    section: 'notes',
    ok: true,
    artifact: { rel, text: out, mode: 'atomic' },
    log: [],
    warn: warn.slice(),
    messages: {
      write: [{ stream: 'out', line: '[build] %REL%  %CHARS% 字符' }],
      checkSame: [{ stream: 'out', line: `[check] ✅ %REL% 无漂移` }],
      checkMissing: [{ stream: 'err', line: `[check] ❌ %REL% 不存在（忘了构建）` }],
      checkDiff: [{ stream: 'err', line: `[check] ❌ %REL% 磁盘与构建结果不一致` }],
    },
    data: {
      sections: lessons.map((l) => ({ label: l, anchor: labelAnchorId(l), qa: qaForLabel(l).length, notes: notesForLabel(l).length })),
      qa: qaByKey.size,
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 投影 ⑤：疑问与解答（`QUESTIONS.md`）
 * ══════════════════════════════════════════════════════════════════════ */

function projectQuestions(input) {
  const model = readCourseModel(input, SECTION_NEEDS.questions)
  const QUESTIONS = model.questions
  const GLOSSARY = model.glossary
  const slug = glossaryCore.slug
  const pageAnchor = (q) => {
    if (!q.page || !q.anchor) return '（不落在课程页，见本笔记）'
    return '`' + q.page + '#' + q.anchor + '`'
  }
  const ids = Object.keys(QUESTIONS).sort()
  const total = ids.length
  const pending = ids.filter((id) => QUESTIONS[id].status !== 'answered')
  const L = []
  L.push('# 疑问与解答（QUESTIONS）')
  L.push('')
  L.push('> 本文件记录学生提出的每一个疑问及其解答，是**疑问的唯一台账**。')
  L.push('>')
  L.push('> 闭环：学生在课程页左栏「DSH 笔记」卡片里点「我有疑问 →」提交 → 问题落盘 `questions/pending.jsonl`')
  L.push('> → 老师按 `lesson` 技能处理，在课程页插入**青紫色解答框**（带 `id="q-NNNN"`）')
  L.push('> → 运行 `node assets/build-questions.js` 刷新本文件。')
  L.push('>')
  L.push('> ⚙️ 本文件由 `assets/build-questions.js` 自动生成，数据源是 `assets/questions-data.js`，请勿手改。')
  L.push('')
  L.push(`**共 ${total} 条疑问，待解答 ${pending.length} 条。**`)
  L.push('')
  if (total === 0) {
    L.push('> 📭 **还没有疑问。** 你的第一条会记在这里。')
    L.push('>')
    L.push('> 提交方式：打开任意课程页，点左栏「DSH 笔记」卡片里的**「我有疑问 →」**按钮，')
    L.push('> 在弹层里写下问题提交（或按 `Ctrl`+`Enter`）。')
    L.push('> 老师会把解答做成**青紫色方框**插到你产生疑问的那个章节旁边，')
    L.push('> 并把位置写进下面的表格。')
    L.push('')
  }
  L.push('## 目录')
  L.push('')
  L.push('| # | 疑问 | 课次 | 状态 | 解答位置 |')
  L.push('|---|------|------|------|---------|')
  ids.forEach((id) => {
    const q = QUESTIONS[id]
    const link = q.page && q.anchor
      ? `[${q.lesson} · ${q.section}](../${q.page}#${q.anchor})`
      : '本笔记'
    const status = q.status === 'answered' ? '✅ 已解答' : '⏳ 待解答'
    L.push(`| [${q.id}](#q${q.id}) | ${q.question} | ${q.lesson} | ${status} | ${link} |`)
  })
  L.push('')
  L.push('---')
  L.push('')
  ids.forEach((id) => {
    const q = QUESTIONS[id]
    L.push(`<a id="q${q.id}"></a>`)
    L.push('')
    L.push(`## ${q.id} · ${q.question}`)
    L.push('')
    L.push(`- **课次**：${q.lesson}`)
    L.push(`- **提出日期**：${q.date}`)
    L.push(`- **状态**：${q.status === 'answered' ? '✅ 已解答' : '⏳ 待解答'}`)
    L.push(`- **解答位置**：${pageAnchor(q)}${q.page ? '（' + q.section + '）' : ''}`)
    L.push('')
    if (q.status === 'answered') {
      L.push('**解答**')
      L.push('')
      L.push(q.answer)
    } else {
      L.push('**解答**')
      L.push('')
      L.push('（待解答）')
    }
    L.push('')
    if (q.terms && q.terms.length) {
      const links = q.terms
        .filter((t) => GLOSSARY[t])
        .map((t) => `[${GLOSSARY[t].label}](./GLOSSARY.md#${slug(GLOSSARY[t].label)})`)
      if (links.length) {
        L.push('**相关名词**：' + links.join(' · '))
        L.push('')
      }
    }
    L.push('---')
    L.push('')
  })
  L.push('## 怎么处理一条新疑问')
  L.push('')
  L.push('1. 读 `questions/pending.jsonl`，取最早一条待处理的。')
  L.push('2. 判断这条疑问属于哪一课、该落在哪一节（挂在学生产生疑问的那个知识点旁边最自然）。')
  L.push('3. 在那一节的课程页里插入解答框：')
  L.push('')
  L.push('```html')
  L.push('<div class="qa-box" id="q0003">')
  L.push('  <div class="qa-box__q"><span class="qa-box__tag">❓ 你的疑问 #0003</span>学生的原话</div>')
  L.push('  <div class="qa-box__a"><span class="qa-box__tag">💡 解答</span>解答正文</div>')
  L.push('</div>')
  L.push('```')
  L.push('')
  L.push('4. 在 `assets/questions-data.js` 里登记这条疑问（id 与页面上的 `id` 对应），状态写 `answered`。')
  L.push('5. 运行 `node assets/build-questions.js` 刷新本文件。')
  L.push('6. 跑 `node assets/check-terms.js`，它会核对每个解答框的页面与锚点是否真实存在。')
  L.push('7. 回复学生时给出**精确位置**：第几课 → 哪一节 → 解答框编号，并附可点链接。')
  L.push('')
  const text = L.join('\n')
  return {
    section: 'questions',
    ok: true,
    artifact: { rel: ARTIFACT_REL.questions, text, mode: 'atomic' },
    log: [
      '[build-questions] 已生成 QUESTIONS.md',
      `[build-questions] 疑问 ${total} 条（待解答 ${pending.length} 条）`,
    ],
    warn: [],
    messages: { write: [] },
    data: { total, pending: pending.length, ids },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */

const PROJECTIONS = Object.freeze({
  lessonsIndex: projectLessonsIndex,
  starmap: projectStarmap,
  glossaryTree: projectGlossaryTree,
  notes: projectNotes,
  questions: projectQuestions,
})

function normalizeSections(input) {
  const raw = input && input.sections
  if (raw == null) return CONTENT_SECTIONS.slice()
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const s of list) {
    const name = String(s)
    if (!CONTENT_SECTIONS.includes(name)) throw new TypeError(`content：未知的投影节 ${JSON.stringify(name)}（可选：${CONTENT_SECTIONS.join(' / ')}）`)
    if (!out.includes(name)) out.push(name)
  }
  if (!out.length) throw new TypeError('content：sections 不能是空数组（空投影没有意义）')
  return out
}

/**
 * **课程投影的唯一入口**：输入已校验的课程包（根 + 注入能力），输出派生内容。
 *
 * @param {{
 *   root: string,
 *   fs: object,
 *   loadData: (rel: string) => any,
 *   deps?: { galaxyShapes?: object, withStaticTitles?: Function },
 *   sections?: string[],
 *   options?: { allowMissingRequires?: boolean }
 * }} input
 * @returns {{
 *   sections: Record<string, object>,
 *   model: { root: string, sections: string[] }
 * }}
 */
function buildCourseContent(input) {
  const sections = normalizeSections(input)
  const out = {}
  for (const name of sections) out[name] = PROJECTIONS[name](input)
  return {
    sections: out,
    model: { root: path.resolve(String(input.root)), sections },
    artifacts: sections.filter((s) => out[s].artifact).map((s) => out[s].artifact.rel),
  }
}

/** 落盘：`direct` = 直接写（清单沿用既有语义）；`atomic` = 先写临时件再 rename（与既有生成器一致） */
function writeArtifact(options) {
  const o = options || {}
  const io = o.fs
  if (!io) throw new TypeError('content.writeArtifact：必须注入 fs')
  const target = String(o.target)
  if (o.mode === 'direct') {
    io.writeFileSync(target, String(o.content), 'utf8')
    return { target, mode: 'direct', bytes: Buffer.byteLength(String(o.content), 'utf8') }
  }
  return glossaryCore.atomicWrite({ target, content: o.content, fs: io })
}

module.exports = {
  CONTENT_SECTIONS,
  ARTIFACT_REL,
  SECTION_NEEDS,
  courseIdOf,
  pointIdOf,
  lessonTargets,
  resolveLedgerLesson,
  resolveTermLesson,
  resolveLessonLabel,
  readCourseModel,
  buildCourseContent,
  writeArtifact,
  projectLessonsIndex,
  projectStarmap,
  projectGlossaryTree,
  projectNotes,
  projectQuestions,
}
