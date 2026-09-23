/**
 * lib/pack-model.js —— 数据层唯一入口（A1b 第 ①② 件）
 *
 * ① lessonIndex(root)：**唯一课次映射表** —— `第N课 ↔ point/NNNN ↔ 源/产物路径`
 *    来源：`code/*​/EXPECT.json` 的 `lessons[].id`（形如 `spring-boot/0001`，本次实测确认）
 *        + `lessons/src/NNNN-*.html`（源）+ `lessons/NNNN-*.html`（产物）
 *    判据：两侧都出现的课次才算成立；只在一边出现 → 报 conflict（不许静默取其一）
 *
 * ② scanTerms(root)：**唯一 data-term 扫描器** —— 语义与课程包自带的
 *    `assets/check-terms.js` 对齐：`<pre>` 代码块里的标记不算（那条检查自称
 *    「代码块内无标记」）。同时对两个数字**都对拍**（含 pre 的总数 / 去掉 pre 的数），
 *    因为本轮在别处量到 23/46 与 check-terms 报的 24/47 不一致 —— 差在哪必须查清，
 *    不许取平均、不许猜。
 *
 * 只读、无副作用。`node lib/pack-model.js --selftest [packRoot]` 自带原子断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripBom } from './text.js'

const readText = (p) => fs.readFileSync(p, 'utf8')
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/')

/**
 * 笔记台账的**唯一**路径定义（数据层在这里说一次，别处只许引用、不许再抄一个字面量）。
 * 为什么是 `notes/notes.jsonl` 而不是包根：课程包侧 7 个读者（build-notes / build-lessons /
 * render-inputs / state-scan / notes-card.test / ask-server / 规格文档）全都读这个路径 ——
 * 2026-09-24 裁定「正本 = `notes/notes.jsonl`」。A1b 早期写成包根，等于写进了一个没人读的文件，
 * 而 `notes/seq.txt` 又是两个写入口共用的 → 号会串。这类"两套口径"正是本项目在消灭的东西。
 */
export const NOTES_REL = path.join('notes', 'notes.jsonl')

/** 第 0001 课 → '第1课'（本项目唯一的人类可读课次写法，别在别处再造一个） */
export function lessonLabel(number) {
  return '第' + Number(number) + '课'
}

/**
 * 编号折算：**文件号（内部 ID）→ 显示号**。fileBase 来自 point.json（缺省 0 = 不折算）。
 * ⚠️ 与课程包侧 `tools/lesson-map.js` 的同名函数逐字对应（`--selftest` 对拍钉住，改一边必须改另一边）。
 * 依据（用户 2026-09-21 裁定「轨道机制」）：`byNumber` 按文件名的 4 位号索引，两条轨道不能共用 0001 ——
 * Vue 第一课的文件号是 1001，而页面上显示「Vue 第1课」。
 */
export function displayNumberOf(number, fileBase) {
  return Number(number) - (Number(fileBase) || 0)
}

/** 扫 lessons/<halo>/<point>/point.json：point → { label, fileBase }（镜像 lesson-map.js） */
function pointMeta(abs) {
  const out = new Map()
  const dir = path.join(abs, 'lessons')
  if (!fs.existsSync(dir)) return out
  for (const haloId of fs.readdirSync(dir)) {
    const hp = path.join(dir, haloId)
    let isDir = false
    try { isDir = fs.statSync(hp).isDirectory() } catch { isDir = false }
    if (!isDir) continue
    for (const pid of fs.readdirSync(hp)) {
      const pf = path.join(hp, pid, 'point.json')
      if (!fs.existsSync(pf)) continue
      let d
      try { d = JSON.parse(readText(pf)) } catch (e) { continue }
      out.set(d.point || pid, { label: d.label || '', fileBase: Number(d.fileBase) || 0 })
    }
  }
  return out
}

/** 唯一课次映射表：{ byKey, byLabel, byNumber, conflicts } */
export function lessonIndex(root) {
  const abs = path.resolve(root)
  const byNumber = new Map()

  // 产物页与源页：文件名 `NNNN-*.html`。
  // **递归**：分层布局（lessons[/src]/<圆圈>/<知识点>/NNNN-*.html）与旧的平铺都要认 ——
  // 存进 map 的是**相对包根的路径**（镜像课程包侧 tools/lesson-map.js）。
  const collect = (dir, field) => {
    const root = path.join(abs, dir)
    if (!fs.existsSync(root)) return
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) {
          // ⚠️ lessons/src 是作者态镜像，不是产物页：扫进去会把 page 指到源文件上（对拍会差 1 处标记）
          if (e.name === 'src') continue
          walk(full); continue
        }
        const m = /^(\d{4})-(.+)\.html$/.exec(e.name)
        if (!m) continue
        const en = byNumber.get(m[1]) || { number: m[1], slug: m[2] }
        en[field] = rel(abs, full)
        byNumber.set(m[1], en)
      }
    }
    walk(root)
  }
  collect(path.join('lessons', 'src'), 'src')
  collect('lessons', 'page')

  // EXPECT.json：权威的 `point/NNNN` 键。
  // **递归**扫 code/（≤4 层）—— 镜像 tools/lesson-map.js：Vue 轨的 EXPECT 在
  // `code/programming/vue/`（point.json 的 practice.dirs），只扫一层会漏掉它。
  const codeDir = path.join(abs, 'code')
  const declared = new Map()
  const readExpect = (exp) => {
    let doc
    try { doc = JSON.parse(readText(exp)) } catch (e) { return } // 读不动就跳过，冲突检查会暴露
    for (const l of doc.lessons || []) {
      if (!l || typeof l.id !== 'string') continue
      declared.set(l.id, { id: l.id, title: l.title, expect: rel(abs, exp) })
    }
  }
  const walkExpect = (dir, depth) => {
    if (depth > 4) return
    let names = []
    try { names = fs.readdirSync(dir) } catch (e) { return }
    if (names.includes('EXPECT.json')) readExpect(path.join(dir, 'EXPECT.json'))
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue
      const p = path.join(dir, n)
      let isDir = false
      try { isDir = fs.statSync(p).isDirectory() } catch { isDir = false }
      if (isDir) walkExpect(p, depth + 1)
    }
  }
  if (fs.existsSync(codeDir)) walkExpect(codeDir, 1)

  const byKey = {}
  const byLabel = {}
  const conflicts = []
  const pm = pointMeta(abs)
  for (const [id, d] of declared) {
    const m = /^(.+)\/(\d{4})$/.exec(id)
    if (!m) { conflicts.push('EXPECT 里的 id 形状不对：' + id); continue }
    const number = m[2]
    const e = byNumber.get(number)
    if (!e) { conflicts.push(id + ' 在 EXPECT 里声明了，但 lessons/ 与 lessons/src/ 里都没有 ' + number + ' 的页面'); continue }
    const info = pm.get(m[1]) || { label: '', fileBase: 0 }
    const displayNumber = displayNumberOf(number, info.fileBase)
    const entry = {
      key: id,
      point: m[1],
      number,
      displayNumber,
      label: info.label ? `${info.label} 第${displayNumber}课` : `第${displayNumber}课`,
      pointLabel: info.label,
      fileBase: info.fileBase,
      title: d.title,
      expect: d.expect,
      src: e.src || null,
      page: e.page || null,
    }
    if (!entry.src) conflicts.push(id + ' 缺课程源（lessons/src/' + number + '-*.html）')
    if (!entry.page) conflicts.push(id + ' 缺课程产物（lessons/' + number + '-*.html）')
    byKey[id] = entry
    byLabel[entry.label] = entry
  }
  for (const [number, e] of byNumber) {
    if (![...declared.keys()].some((k) => k.endsWith('/' + number))) {
      conflicts.push('lessons 里有 ' + number + '（' + (e.page || e.src) + '）但 EXPECT.json 没声明它')
    }
  }
  return { byKey, byLabel, byNumber: Object.fromEntries(byNumber), conflicts }
}

/**
 * 台账的 `anchor`（**星图课次键**，如 `spring-boot/0001`）→ 课次显示名（`第1课`）。
 *
 * 方向要说清：「调用方写法 → 课次键」的推导在**写入口**（`lib/notes-io.js`）做，台账因此只存键；
 * 这里是**反向**那一步 —— 键 → 显示名，也**只在这一处**做。
 * 读点不许各自拼 `第N课`：label 在映射表里是 `lessonLabel(number)` 的产物，
 * 星图侧还可能带知识点前缀（`build-starmap.js:180`），自己拼出来的迟早会漂 ✗
 *
 * @param {string} anchor 台账里的 anchor
 * @param {{byKey: object}} index `lessonIndex(root)` 的返回值
 * @returns {string|null} 解析不到（孤儿锚点 / 旧格式记录）→ null，由调用方决定算 0 还是报警
 */
export function labelOfAnchor(anchor, index) {
  return index?.byKey?.[anchor]?.label ?? null
}

/**
 * 调用方写法（`第1课` label 或 `spring-boot/0001` key）→ **星图课次键**。
 *
 * 这是写入口那一步的**唯一实现**：插件的 `lib/notes-io.js`（`appendNote`）与课程包侧的
 * 旧写入口 `tools/ask-server.js` 都走它 / 它在那边的镜像 `tools/lesson-map.js`，
 * 两份实现由 `--selftest` 对拍钉住（改一边必须改另一边）。
 * 解析不到（孤儿锚点）→ null，由调用方决定报错文案。
 *
 * @param {string} anchor
 * @param {{byKey: object, byLabel: object}} index `lessonIndex(root)` 的返回值
 * @returns {string|null}
 */
export function keyOfAnchor(anchor, index) {
  if (!anchor) return null
  return index?.byKey?.[anchor]?.key ?? index?.byLabel?.[anchor]?.key ?? null
}

/** 把 <pre>…</pre> 摘掉（check-terms 的语义：代码块里的标记不算） */
function stripPre(html) {
  return html.replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
}

/** 单页统计：{ all, outsidePre, inPre: [...] } */
export function scanTermsInPage(html) {
  const grab = (s) => [...String(s).matchAll(/data-term="([^"]+)"/g)].map((m) => m[1])
  const all = grab(html)
  const outside = grab(stripPre(html))
  const inPre = all.slice()
  for (const k of outside) {
    const i = inPre.indexOf(k)
    if (i !== -1) inPre.splice(i, 1)
  }
  const tally = (arr) => arr.reduce((o, k) => { o[k] = (o[k] || 0) + 1; return o }, {})
  return { all: all.length, outsidePre: outside.length, inPre, byKey: tally(outside) }
}

/** 全包扫描：{ pages: [{page, all, outsidePre, inPre}], totalAll, totalOutside, byKey } */
export function scanTerms(root) {
  const abs = path.resolve(root)
  const idx = lessonIndex(abs)
  const pages = []
  const byKey = {}
  for (const entry of Object.values(idx.byKey)) {
    if (!entry.page) continue
    const p = path.join(abs, entry.page)
    if (!fs.existsSync(p)) continue
    const s = scanTermsInPage(readText(p))
    pages.push({ page: entry.page, key: entry.key, ...s })
    for (const [k, n] of Object.entries(s.byKey)) byKey[k] = (byKey[k] || 0) + n
  }
  return {
    pages,
    totalAll: pages.reduce((n, p) => n + p.all, 0),
    totalOutside: pages.reduce((n, p) => n + p.outsidePre, 0),
    inPre: pages.flatMap((p) => p.inPre.map((k) => p.page + ':' + k)),
    byKey,
  }
}

/* ── 规范 id 与下一课号（纯函数，不读盘） ────────────────────────────────
 *
 * **id 一律用 `/` 分层**（`programming/spring-boot`、`programming/spring-boot/0001`），
 * 因为 id 自身可能含 `-`（`spring-boot`），用 `-` 当分隔符会歧义；
 * `/` 也是唯一的路径分隔符，不会出现在目录名里。
 */

/**
 * 知识点的规范 id。
 *
 * @param {string} circle 圆圈 id（如 `programming`）
 * @param {string} point  知识点 id（如 `spring-boot`）
 * @returns {string} `programming/spring-boot`
 */
export function pointKey(circle, point) {
  return `${circle}/${point}`
}

/**
 * 课程的规范 id。
 *
 * @param {string} circle 圆圈 id（如 `programming`）
 * @param {string} point  知识点 id（如 `spring-boot`）
 * @param {number} number 课号（如 1）
 * @returns {string} `programming/spring-boot/0001`
 */
export function lessonKey(circle, point, number) {
  return `${circle}/${point}/${String(number).padStart(4, '0')}`
}

/**
 * 该知识点下一门课的课号 —— **文件号**（现有最大文件号 + 1）。
 *
 * ⚠️ 这是**文件号**不是显示号：显示号要按 `fileBase` 折算（见 `displayNumberOf`）。
 *    例：`vue` 的 `fileBase=1000`，文件号 1002 → 课页显示「第2课」。
 * ⚠️ 必须**按 `circle` + `point` 两个字段一起筛**：`vue` 这种 id 在不同圆圈里可能重名，
 *    只按 point 筛会把别的圆圈的课号算进来 → 下一课号凭空跳号。
 * ⚠️ 号只从 `pack.lessons` 算 —— 与 catalog 列出来的那批课**同一个来源**，不引第二份真相。
 * 没有课时返回该知识点的 `fileBase + 1`；
 * 找不到该知识点 → 返回 `null`（**不返回 0/1 冒充**）。
 *
 * @param {{ points: Array<{id: string, circle: string, fileBase?: number}>, lessons: Array<{circle: string, point: string, number: number}> }} pack readPack 的返回值
 * @param {string} circle 圆圈 id
 * @param {string} point  知识点 id
 * @returns {number|null}
 */
export function nextNumber(pack, circle, point) {
  const p = pack.points?.find((pt) => pt.id === point && pt.circle === circle)
  if (!p) return null

  const numbers = (pack.lessons || [])
  	.filter((l) => l.circle === circle && l.point === point)
  	.map((l) => Number(l.number))
  	.filter((n) => Number.isFinite(n))
  if (numbers.length > 0) return Math.max(...numbers) + 1

  // 没有课 → fileBase + 1
  return (Number(p.fileBase) || 0) + 1
}

/** check-terms.js 自报的数字（对拍用；它同时会打印「代码块内无标记」） */
export function checkTermsReport(root) {
  const abs = path.resolve(root)
  let out = ''
  try {
    out = execFileSync(process.execPath, [path.join(abs, 'assets', 'check-terms.js')], { cwd: abs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '')
  }
  const marks = [...out.matchAll(/名词标记 (\d+) 处/g)].map((m) => Number(m[1]))
  return { marks, saysNoMarkInCode: out.includes('代码块内无标记'), raw: out }
}

/* ── ③④ 三类 box 的装载与不变量 ────────────────────────────────────────
   box = { id, kind, anchor, payload }
     · 名词解释：id = 术语键(slug)     anchor = 记录的 lesson（'第1课'）
     · 疑问　　：id = 提问号('0004')   anchor = 记录的 anchor/lesson，另带 terms[]
     · 笔记　　：id + seq（notes.jsonl 可能还不存在 → 空数组，不报错）
   规矩（2026-09-24 定）：**只存 anchor**，课次显示名由映射表推导；
   `date` 保留字段但**不给默认值** —— 缺了就报出来，不许悄悄填"今天"。 */
export async function loadBoxes(root) {
  const abs = path.resolve(root)
  const { createRequire } = await import('node:module')
  const boxes = []
  const problems = []

  const loadJs = (file) => {
    const p = path.join(abs, file)
    if (!fs.existsSync(p)) return null
    const req = createRequire(p)
    delete req.cache[p]
    try { return req(p) } catch (e) { problems.push(file + ' 加载失败：' + e.message); return null }
  }

  const led = loadJs(path.join('assets', 'glossary-data.js'))
  for (const [slug, r] of Object.entries(led || {})) {
    boxes.push({
      id: slug, kind: '名词解释', anchor: r.lesson,
      payload: { label: r.label, official: r.official, short: r.short, analogy: r.analogy },
    })
  }

  const q = loadJs(path.join('assets', 'questions-data.js'))
  // 形状未知：数组 / {entries|questions|data} / **以 id 为键的映射**（实测就是这个）——三种都认
  const inner = q && (q.entries || q.questions || q.data)
  const qArr = Array.isArray(q)
    ? q
    : inner
      ? (Array.isArray(inner) ? inner : Object.values(inner))
      : Object.values(q || {}).filter((v) => v && typeof v === 'object' && ('id' in v || 'question' in v))
  for (const r of qArr) {
    if (!r || typeof r !== 'object') continue
    if (!r.date) problems.push('疑问 ' + (r.id || '?') + ' 缺 date（不许默认今天）')
    // 实测：答疑台账的 `anchor` 是**页面锚点**（q0001，用于在 NOTES.html 里跳转），
    // 不是星图能解析的课次键 ✗ —— 同一个字段名被用了两种含义。
    // 这里把它保留为 pageAnchor，星图锚点改由 `lesson` 经映射表推导（不动既有数据）。
    const rawAnchor = String(r.anchor || '')
    const looksLikeStarKey = /^[a-z-]+\/\d{4}$/.test(rawAnchor) || /^第\d+课$/.test(rawAnchor)
    boxes.push({
      id: String(r.id || ''), kind: '疑问',
      anchor: looksLikeStarKey ? rawAnchor : String(r.lesson || ''),
      pageAnchor: rawAnchor, terms: r.terms || [],
      payload: { question: r.question, answer: r.answer },
    })
  }

  const np = path.join(abs, NOTES_REL)
  if (fs.existsSync(np)) {
    const lines = fs.readFileSync(np, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      let o
      try { o = JSON.parse(s) } catch { problems.push('notes.jsonl 有一行不是合法 JSON：' + s.slice(0, 40)); continue }
      boxes.push({ id: String(o.id || ''), kind: '笔记', anchor: o.anchor, seq: o.seq, payload: { text: o.text } })
    }
  }
  return { boxes, problems }
}

/** ④ 不变量：id 每类唯一、anchor 必须能在课次映射表里解析到（孤儿锚点要报出来） */
export function validateBoxes(boxes, index) {
  const problems = []
  const seen = new Set()
  for (const b of boxes) {
    const k = b.kind + '/' + b.id
    if (!b.id) problems.push(b.kind + ' 缺 id')
    else if (seen.has(k)) problems.push('撞 id：' + k)
    else seen.add(k)
    if (!b.anchor) problems.push('缺 anchor：' + k)
    else if (!index.byKey[b.anchor] && !index.byLabel[b.anchor]) problems.push('孤儿锚点：' + k + ' → ' + b.anchor)
  }
  const counts = boxes.reduce((o, b) => { o[b.kind] = (o[b.kind] || 0) + 1; return o }, {})
  return { problems, counts }
}

/* ── ⑤ 课程包事实（原 `lib/pack.js`，2026-09-24 收进数据层唯一入口）─────────────
 *
 * 为什么搬进来：`whale_state` / `whale_brief` 的输出里有"圆圈 / 知识点 / 课程 / 已点亮"
 * 这些**课程包事实**，而它们原先来自另一个读取器 `lib/pack.js` 的 `readPack()` ——
 * 于是同一个包里出现两条独立的路径解析线（`lessonIndex()` 与 `readPack()`）。
 * 队列② 的口径是"数据层唯一入口"，所以这里把它收进来；`lib/pack.js` 退化成**再导出**，
 * 实现只剩这一份（不是两份实现 + 对拍，而是真的只有一份）。
 *
 * 搬动时**逐字保留**原实现，只在本地变量 `rel` 上改名 `relParts`（避免遮蔽本文件的 `rel()`）：
 * 验收判据是 `whale_state` / `whale_brief` 的输出**逐字节不变**。
 *
 * 原三条纪律照旧：root 由调用方给（绝不猜路径）；只读；读不动**不静默跳过**（记进 warnings）。
 * 这里只读**课程包本身**；星图那些派生量（shape / 坐标 / size / bright）仍不在这里。
 */
const LESSON_META_RE = /<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/
const LESSON_FILE_RE = /^\d{4}-.*\.html$/

/** 历史平铺布局（`lessons/src/NNNN-*.html`）里的课归给这个圆圈/知识点。
 *  **与 tools/build-lessons.js、tools/build-starmap.js 同一条兜底** —— 三处必须一致，
 *  否则 pack 与工具链就会对不上（这一条正是被 test/pack-parity.mjs 抓出来的 ✗→✓）。 */
const LEGACY_HALO = 'programming'
const LEGACY_POINT = 'spring-boot'

/** 递归找 `NNNN-*.html`（不跟软链，避免绕出去） */
function walkLessonFiles(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkLessonFiles(p, out)
    else if (e.isFile() && LESSON_FILE_RE.test(e.name)) out.push(p)
  }
  return out
}

function readJsonWarn(file, warnings, what) {
  try {
    // ⚠️ 剥 BOM：progress.json 常被手工/工具改，PowerShell 写出来会带 \uFEFF（见 lib/text.js）
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (e) {
    warnings.push(`${what} 读不动：${path.basename(file)}（${e.message}）`)
    return null
  }
}

/**
 * 读一个课程包。
 *
 * @param {string} root 课程包根目录（必须有 `lessons/`）
 * @returns {{root:string, circles:Array, points:Array, lessons:Array, learned:string[], warnings:string[]}}
 */
export function readPack(root) {
  const warnings = []
  const lessonsDir = path.join(root, 'lessons')
  const srcDir = path.join(lessonsDir, 'src')

  if (!fs.existsSync(lessonsDir)) {
    warnings.push(`不是课程包：找不到 ${path.join(root, 'lessons')}`)
    return { root, circles: [], points: [], lessons: [], learned: [], warnings }
  }

  // —— 圆圈 → 知识点 ——
  const circles = []
  const pointToCircle = new Map()
  for (const haloId of fs.readdirSync(lessonsDir).sort()) {
    const haloFile = path.join(lessonsDir, haloId, 'halo.json')
    if (!fs.existsSync(haloFile)) continue
    const halo = readJsonWarn(haloFile, warnings, '圆圈')
    if (!halo) continue
    const id = halo.halo || haloId
    const points = []
    for (const pid of fs.readdirSync(path.join(lessonsDir, haloId)).sort()) {
      const pf = path.join(lessonsDir, haloId, pid, 'point.json')
      if (!fs.existsSync(pf)) continue
      const p = readJsonWarn(pf, warnings, '知识点')
      if (!p) continue
      const point = {
        id: p.point || pid,
        circle: id,
        name: p.name || p.point || pid,
        label: p.label || '',
        fileBase: Number.isFinite(p.fileBase) ? p.fileBase : 0,
        requires: Array.isArray(p.requires) ? p.requires.slice() : [],
      }
      points.push(point)
      pointToCircle.set(point.id, id)
    }
    if (!points.length) warnings.push(`圆圈 ${id} 下一个知识点都没有`)
    circles.push({
      id,
      name: halo.name || id,
      // 圆圈身份色（§11，2026-09-22 落盘）：标题配色与星图恒星色都读它。
      // 归一成小写，免得 `#FFF6E2` 与 `#fff6e2` 在冻结表（小写建的）里对不上。
      color: typeof halo.color === 'string' ? halo.color.toLowerCase() : null,
      center: halo.center || '',
      inside: Array.isArray(halo.inside) ? halo.inside.slice() : [],
      outside: Array.isArray(halo.outside) ? halo.outside.slice() : [],
      shape: halo.shape || null,
      points,
    })
  }

  // —— 进度（决定课程"学过 / 没学过"）——
  let learned = []
  const progressFile = path.join(root, 'progress.json')
  if (fs.existsSync(progressFile)) {
    const p = readJsonWarn(progressFile, warnings, '进度')
    learned = Array.isArray(p?.learned) ? p.learned.slice() : []
  } else {
    warnings.push('没有 progress.json —— 所有课程都按"没学过"处理')
  }
  const learnedSet = new Set(learned)

  // —— 课程：从 `lessons/src/**/NNNN-*.html` 的 meta 读 ——
  const lessons = []
  for (const file of walkLessonFiles(srcDir).sort()) {
    const relParts = path.relative(srcDir, file).split(path.sep)
    const name = relParts.pop()
    const base = name.replace(/\.html$/, '')
    const text = fs.readFileSync(file, 'utf8')
    const m = text.match(LESSON_META_RE)
    if (!m) { warnings.push(`${relParts.concat(name).join('/')} 没有 data-lesson-meta，跳过`); continue }
    let meta
    try { meta = JSON.parse(m[1]) } catch (e) { warnings.push(`${name} 的 meta 不是合法 JSON，跳过`); continue }

    // 归属：**路径优先，meta 可覆盖**；平铺布局走兜底（与两个 tools/ 脚本同一条规则）
    const legacy = relParts.length < 2
    const haloId = meta.halo || (legacy ? LEGACY_HALO : relParts[0])
    const pointId = meta.point || (legacy ? LEGACY_POINT : relParts[1])
    if (!pointToCircle.has(pointId)) { warnings.push(`${name} 指向不存在的知识点 ${haloId}/${pointId}，跳过`); continue }
    if (legacy) warnings.push(`${name} 是历史平铺布局（按 ${haloId}/${pointId} 归档）—— 目录重构后应消失`)

    const point = circles.find((c) => c.id === haloId)?.points.find((p) => p.id === pointId)
    const number = Number(meta.number) || 0
    const id = `${pointId}/${String(number).padStart(4, '0')}`
    // 显示号按 point.json 的 fileBase 折算（镜像 tools/build-starmap.js:180）
    const displayNumber = displayNumberOf(number, point?.fileBase)
    lessons.push({
      id,
      circle: haloId,
      point: pointId,
      pointName: point?.name || pointId,
      number,
      displayNumber,
      label: point?.label ? `${point.label} 第${displayNumber}课` : `第${displayNumber}课`,
      title: meta.title || '',
      navTitle: meta.navTitle || meta.title || '',
      href: `lessons/${relParts.concat(`${base}.html`).join('/')}`,
      learned: learnedSet.has(id),
      termCount: Object.keys(meta.terms || {}).length,
      source: meta.source?.label || '',
      sourceUrl: meta.source?.url || '',
      flag: (meta.flag === 'red' || meta.flag === 'yellow') ? meta.flag : null,
      file: `${relParts.concat(`${base}.html`).join('/')}`,
    })
  }
  lessons.sort((a, b) => a.point.localeCompare(b.point) || a.number - b.number)

  // —— 自查：进度里有没有"不存在的课程"（幽灵会把星图点不亮还查不出原因）——
  for (const id of learned) if (!lessons.some((l) => l.id === id)) warnings.push(`进度里的 ${id} 找不到对应课程（幽灵条目）`)

  return { root, circles, points: circles.flatMap((c) => c.points), lessons, learned, warnings }
}

/**
 * 前置体检 —— 「要学这个知识点，前置还差哪些课？」
 * ------------------------------------------------------------------
 * 2026-09-23 用户裁定：**开课摸底时就要判前置**；没学会就先建议他去补那门课，
 * 而不是继续给他生成新课。这条规矩此前只写在 `_plugin-prep/LESSON-FLOW.md`
 * （「前置闭包」「不出现前置没教」），**没有任何机器判据**，所以 Vue 第1课能直接
 * 建在"学生连 HTML 都没学过"的地基上。
 *
 * 真源早就有了：`lessons/<圆圈>/<知识点>/point.json` 的 `requires`，
 * 由 `readPack()` 解析进 `points[].requires`。在此之前它只被课程包侧
 * `tools/build-starmap.js` 拿去画星图虚线航道 —— 数据一直在，缺的是"当闸用"这一步。
 *
 * 判定粒度 = **课**，不是点。点级只能问"这个知识点碰过没有"，学生碰过第 1 课
 * 就算碰过 —— 那恰好放过本机的真实情形（spring-boot 0001 已掌握、0002 一处未开始，
 * 却要开 Vue 第1课）。课级才拦得住。
 *
 * 悬空 / 成环由课程包侧 `tools/build-starmap.js` 硬闸拦（exit 1）；这里仍做防御：
 * 解析不到的 requires 进 `ghostRequires`，成环靠 visited 集合兜住（不会死循环）。
 *
 * @param {object} pack `readPack(root)` 的返回值
 * @param {string} pointId 要学的知识点 id（如 'vue'）
 * @returns {{
 *   ok: boolean,                       // **能不能往下走** —— 只被"真有可执行的缺口"置 false
 *   pointId: string,
 *   reason: 'ok'|'unknown-point'|'missing',
 *   closure: string[],
 *   missing: Array<object>,
 *   emptyPoints: string[],
 *   ghostRequires: string[],
 * }}
 */
export function prerequisiteGaps(pack, pointId) {
  const points = pack?.points ?? []
  const lessons = pack?.lessons ?? []
  const target = points.find((p) => p.id === pointId)
  if (!target) {
    // ⚠️ 找不到这个知识点 **不拦**（ok:true）。理由：课程包读不动、或这个知识点刚建还没写进
    //    point.json 时，我们**没有任何依据**说它的前置没学好 —— 拿"不知道"当"不合格"会误拦
    //    正在新建的第一课（本仓库的判据一律"没数据就不猜"，这里同理）。
    //    真有缺口的形状只有一种：reason === 'missing'。
    return { ok: true, pointId, reason: 'unknown-point', closure: [], missing: [], emptyPoints: [], ghostRequires: [] }
  }

  // 与包侧 build-starmap.js 同一条解析规则：ref 带 `/` 就是全路径，否则按**同圆圈**解析
  const byQualified = new Map(points.map((p) => [`${p.circle}/${p.id}`, p]))
  const resolve = (ref, circle) => {
    const s = String(ref)
    return byQualified.get(s.includes('/') ? s : `${circle}/${s}`) ?? null
  }

  const closure = []
  const ghostRequires = []
  const seen = new Set([`${target.circle}/${target.id}`])
  const queue = [target]
  while (queue.length) {
    const cur = queue.shift()
    for (const ref of cur.requires ?? []) {
      const dep = resolve(ref, cur.circle)
      if (!dep) { ghostRequires.push(`${cur.circle}/${cur.id} → ${ref}`); continue }
      const key = `${dep.circle}/${dep.id}`
      if (seen.has(key)) continue
      seen.add(key)
      closure.push(dep.id)
      queue.push(dep)
    }
  }

  const closurePoints = closure.map((id) => points.find((p) => p.id === id))
  const emptyPoints = closurePoints.filter((p) => !lessons.some((l) => l.point === p.id)).map((p) => p.id)
  const missing = lessons
    .filter((l) => closure.includes(l.point) && !l.learned)
    .sort((a, b) => a.point.localeCompare(b.point) || a.number - b.number)

  const ok = missing.length === 0 && emptyPoints.length === 0 && ghostRequires.length === 0
  return { ok, pointId, reason: ok ? 'ok' : 'missing', closure, missing, emptyPoints, ghostRequires }
}

/**
 * 把 `prerequisiteGaps()` 的结果说成一句人话（工具输出与拒绝理由共用一份措辞）。
 * @param {object} gaps
 * @returns {string}
 */
export function describeGaps(gaps) {
  if (!gaps) return ''
  if (gaps.reason === 'unknown-point') return `课程包里找不到知识点 ${gaps.pointId} —— 没有已知前置，不拦`
  if (gaps.ok) return `${gaps.pointId} 的前置都已学过`
  const bits = []
  if (gaps.missing.length) {
    bits.push(`还没学的课：${gaps.missing.map((l) => `${l.label}（${l.title}）`).join('、')}`)
  }
  if (gaps.emptyPoints.length) bits.push(`前置知识点还没有课：${gaps.emptyPoints.join('、')}`)
  if (gaps.ghostRequires.length) bits.push(`悬空的前置：${gaps.ghostRequires.join('、')}`)
  return `先补齐 ${gaps.closure.join('、')} —— ${bits.join('；')}`
}

/** 一句话摘要（给工具的 render 用） */
export function packSummary(pack) {
  const lit = pack.lessons.filter((l) => l.learned).length
  return `${pack.circles.length} 个圆圈 · ${pack.points.length} 个知识点 · ${pack.lessons.length} 门课程（已点亮 ${lit}）`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
  const packArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  // 包路径：显式参数 → 环境变量 DSH_WHALE_PACK → 报错给用法。
  // **不猜「插件旁边那个 study」** —— 那是作者本机的布局，装到别人机器上（node_modules 里）一定不存在。
  const packBase = packArg ?? ((process.env.DSH_WHALE_PACK || '').trim() || null)
  if (!packBase) {
    console.error('用法：node lib/pack-model.js --selftest <课程包根>')
    console.error('  或：DSH_WHALE_PACK=<课程包根> node lib/pack-model.js --selftest')
    process.exit(2)
  }
  const ROOT = path.resolve(packBase)
  const failures = []
  const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

  console.log('包路径：' + ROOT)
  const idx = lessonIndex(ROOT)
  console.log('映射表：' + Object.keys(idx.byKey).join(' | '))
  ok(Object.keys(idx.byKey).length === 3, '映射表覆盖 3 课（' + Object.keys(idx.byKey).length + '）')
  ok(Object.keys(idx.byKey).every((k) => /^[a-z-]+\/\d{4}$/.test(k)), '每一课的键都是 point/NNNN 形状')
  ok(Object.values(idx.byKey).every((e) => e.src && e.page), '每一课都同时有课程源与产物页')
  ok(idx.byLabel['第1课'] && idx.byLabel['第2课'] && idx.byLabel['Vue 第1课'], '显示名 ↔ point/NNNN 双向都查得到（含第二条轨道的「Vue 第1课」）')
  ok(idx.conflicts.length === 0, '无 conflict' + (idx.conflicts.length ? '（实得：' + idx.conflicts.join('；') + '）' : ''))

  // 反向那一步（课次键 → 显示名）只经 labelOfAnchor：往返必须回到同一个显示名，
  // 否则"写入口存键、读点反推名"这条链就断了（笔记会静默挂不上课）
  ok(Object.keys(idx.byKey).every((k) => labelOfAnchor(k, idx) === idx.byKey[k].label), 'labelOfAnchor 往返：每个 point/NNNN 键都反推回自己的显示名')
  ok(labelOfAnchor('nope/9999', idx) === null, '解析不到的 anchor → null（不瞎猜一个课次）')
  ok(labelOfAnchor(undefined, idx) === null && labelOfAnchor('', idx) === null, '空 / 缺 anchor → null（旧格式记录不会被错算到某课头上）')

  // ── 第二份实现的对拍：课程包侧 `tools/lesson-map.js` vs 这里的 `lessonIndex()` ──
  // 包侧工具是 CommonJS、且要能脱离插件独立运行，所以那份实现必须存在 —— 那就必须钉住它不许漂。
  // 先例：`test/render-parity.mjs:43,82` 本来就在跨仓跑包侧 build-lessons.js 做对拍。
  let packMod = null
  try {
    packMod = createRequire(import.meta.url)(path.join(ROOT, 'tools', 'lesson-map.js'))
  } catch (e) {
    ok(false, '包侧课次映射表装载失败（' + (e?.message ?? e) + '）—— 路径应为 <包>/tools/lesson-map.js')
  }
  if (packMod) {
    const proj = (m) => Object.keys(m.byKey).sort().map((k) => {
      const e = m.byKey[k]
      return [k, e.label, e.point, e.number, e.title ?? null]
    })
    const pm = packMod.lessonMap(ROOT)
    ok(JSON.stringify(proj(pm)) === JSON.stringify(proj(idx)), '对拍：包侧 lesson-map.js 与 lessonIndex() 逐键一致（' + Object.keys(idx.byKey).length + ' 键 × label/point/number/title）')
    const both = (a) => [packMod.labelOfAnchor(a, pm), labelOfAnchor(a, idx)]
    ok(Object.keys(idx.byKey).every((k) => both(k)[0] === both(k)[1]), '对拍：labelOfAnchor 两边行为一致（每个真实键）')
    ok(both('nope/9999')[0] === both('nope/9999')[1] && both('nope/9999')[0] === null, '对拍：labelOfAnchor 解析不到时两边都 → null（不瞎猜一个课次）')
    // 写入口那一步（写法 → 键）也是两份实现：插件的 notes-io 与包侧的旧 /note 各走一份 —— 同样钉住
    const bothKey = (a) => [packMod.keyOfAnchor(a, pm), keyOfAnchor(a, idx)]
    ok(Object.keys(idx.byKey).every((k) => { const b = bothKey(k); return b[0] === k && b[1] === k }), '对拍：keyOfAnchor 把 point/NNNN 还原成它自己（两边一致）')
    ok(Object.values(idx.byKey).every((e) => { const b = bothKey(e.label); return b[0] === e.key && b[1] === e.key }), '对拍：keyOfAnchor 把「第N课」归到同一个星图课次键 —— 两种写法收敛成一种（两边一致）')
    ok(bothKey('nope/9999')[0] === null && bothKey('nope/9999')[1] === null, '对拍：keyOfAnchor 解析不到时两边都 → null（孤儿锚点会被两个写入口同样拒掉）')
  }

  // 包侧的 `tools/pack-text.js` 是 `lib/text.js` 的对应物：笔记读取的三个读点靠它剥 BOM。
  // 少了它，一行带 BOM 的笔记会被静默丢成 0 条（2026-09-24 实测出来的真 bug）—— 所以钉住它。
  try {
    const pt = createRequire(import.meta.url)(path.join(ROOT, 'tools', 'pack-text.js'))
    const bomLines = pt.splitLines('\uFEFF{"id":"0001"}\n{"id":"0002"}')
    const allParse = bomLines.every((l) => { try { JSON.parse(l); return true } catch { return false } })
    ok(bomLines.length === 2 && allParse, '包侧 pack-text.js 逐行剥 BOM：带 BOM 的首行仍能 JSON.parse（少了它笔记会被静默丢掉）')
    ok(pt.stripBom('\uFEFFx') === 'x', '包侧 stripBom 只剥开头那一个 BOM')
  } catch (e) {
    ok(false, '包侧 pack-text.js 装载失败（' + (e?.message ?? e) + '）—— 路径应为 <包>/tools/pack-text.js')
  }

  const s1 = scanTerms(ROOT)
  console.log('扫描器：含 pre ' + s1.totalAll + ' 处 / 去掉 pre ' + s1.totalOutside + ' 处' + (s1.inPre.length ? '；pre 内 ' + s1.inPre.join(',') : '；pre 内 0'))
  const s2 = scanTerms(ROOT)
  ok(JSON.stringify(s1) === JSON.stringify(s2), '确定性：同输入两次扫描结果逐字节相同')

  const rep = checkTermsReport(ROOT)
  console.log('check-terms 自报：' + JSON.stringify(rep.marks) + ' · 自称代码块内无标记=' + rep.saysNoMarkInCode)
  // check-terms 扫的是 lessons + reference（页序 lessons 在前），本扫描器只管课程页 →
  // 只能拿它的**课程页前缀**对拍。第一版拿总数对拍，于是把 reference 页那 1 处算进来，
  // 报出"72 vs 71"的假冲突 ✗ —— 这正是本项目要消灭的那类错：同一事实两套口径。
  const lessonsMarks = rep.marks.slice(0, s1.pages.length).slice().sort((a, b) => a - b)
  const mine = s1.pages.map((p) => p.all).sort((a, b) => a - b)
  ok(JSON.stringify(lessonsMarks) === JSON.stringify(mine), '逐页标记数对拍一致（check-terms ' + JSON.stringify(lessonsMarks) + ' vs 扫描器 ' + JSON.stringify(mine) + '）')
  ok(lessonsMarks.reduce((a, b) => a + b, 0) === s1.totalAll, '课程页合计一致（' + s1.totalAll + '）')
  console.log('非课程页另有 ' + (rep.marks.reduce((a, b) => a + b, 0) - s1.totalAll) + ' 处（reference/，本扫描器按设计不管）')
  ok(!rep.saysNoMarkInCode || s1.inPre.length === 0, 'check-terms 说"代码块内无标记"，扫描器也必须找不到 pre 内标记')

  const loaded = await loadBoxes(ROOT)
  const val = validateBoxes(loaded.boxes, idx)
  console.log('box 装载：' + JSON.stringify(val.counts))
  if (loaded.problems.length) console.log('  装载问题：' + loaded.problems.slice(0, 5).join('；'))
  ok(loaded.boxes.length >= 62, '三类 box 装进来了（' + loaded.boxes.length + ' 个）')
  ok((val.counts['名词解释'] || 0) >= 62, '名词解释 box 至少 62 条（台账 62 条）')
  ok(loaded.problems.length === 0, '装载无问题' + (loaded.problems.length ? '（' + loaded.problems.slice(0, 3).join('；') + '）' : ''))
  ok(val.problems.length === 0, '不变量通过：id 不撞、anchor 都能解析' + (val.problems.length ? '（实得 ' + val.problems.slice(0, 3).join('；') + '）' : ''))
  const again = await loadBoxes(ROOT)
  ok(JSON.stringify(again.boxes) === JSON.stringify(loaded.boxes), '确定性：两次装载逐字节相同')
  console.log('笔记 box：' + (val.counts['笔记'] || 0) + ' 个（台账 0 条 → 0 且不报错）')

  // ── 前置体检（2026-09-23）：判据用**合成包**钉住，不读盘。
  //    学生的进度天天变，拿真包断言"缺哪几课"第二天就红 —— 那是脆，不是严。
  //    真包只做结构烟测（找得到 vue、返回结构完整）。
  {
    const mk = (learned) => ({
      points: [
        { id: 'html', circle: 'programming', requires: [] },
        { id: 'js', circle: 'programming', requires: ['html'] },
        { id: 'spring-boot', circle: 'programming', requires: [] },
        { id: 'vue', circle: 'programming', requires: ['js', 'spring-boot'] },
      ],
      lessons: [
        { id: 'html/2001', point: 'html', number: 2001, label: 'HTML 第1课', title: '骨架', learned: learned.includes('html/2001') },
        { id: 'js/3001', point: 'js', number: 3001, label: 'JS 第1课', title: '语法', learned: learned.includes('js/3001') },
        { id: 'spring-boot/0001', point: 'spring-boot', number: 1, label: '第1课', title: 'hello', learned: learned.includes('spring-boot/0001') },
      ],
    })
    const g0 = prerequisiteGaps(mk([]), 'vue')
    ok(g0.closure.join(',') === 'js,spring-boot,html', '前置体检：闭包是传递的（vue → js,spring-boot,html）')
    ok(g0.missing.map((l) => l.id).join(',') === 'html/2001,js/3001,spring-boot/0001',
      '前置体检：闭包里没学过的课全列出来（按知识点 + 课号排）')
    const g1 = prerequisiteGaps(mk(['html/2001', 'js/3001', 'spring-boot/0001']), 'vue')
    ok(g1.ok && g1.reason === 'ok', '前置体检：前置都学过了 → ok（不拦）')
    const g2 = prerequisiteGaps(mk([]), 'html')
    ok(g2.ok && g2.closure.length === 0, '前置体检：没有 requires 的知识点 → 直接 ok（写它的第一课不该被自己拦住）')
    ok(prerequisiteGaps(mk([]), 'nope').reason === 'unknown-point', '前置体检：不认识的知识点 → unknown-point')
    ok(prerequisiteGaps(mk([]), 'nope').ok === true,
      '前置体检：**不知道就不拦**（拿"读不动/还没建"当"不合格"会误拦正在新建的第一课）')
    const g3 = prerequisiteGaps({
      points: [{ id: 'vue', circle: 'programming', requires: ['ghost-point'] }, { id: 'ghost-point', circle: 'programming', requires: [] }],
      lessons: [],
    }, 'vue')
    ok(!g3.ok && g3.emptyPoints.join(',') === 'ghost-point', '前置体检：前置知识点一门课都还没有 → 拦（否则学生会等一门不存在的课）')
    const cyc = { points: [{ id: 'a', circle: 'p', requires: ['b'] }, { id: 'b', circle: 'p', requires: ['a'] }], lessons: [] }
    ok(prerequisiteGaps(cyc, 'a').closure.join(',') === 'b', '前置体检：成环不死循环（visited 兜住）')
    ok(prerequisiteGaps({ points: [{ id: 'x', circle: 'p', requires: ['nope'] }], lessons: [] }, 'x').ghostRequires.length === 1,
      '前置体检：悬空 requires 进 ghostRequires 并判不 ok')

    const real = readPack(ROOT)
    const gv = prerequisiteGaps(real, 'vue')
    ok(gv.reason !== 'unknown-point', '真包：vue 这个知识点找得到')
    ok(typeof gv.ok === 'boolean' && Array.isArray(gv.missing) && Array.isArray(gv.closure), '真包：前置体检返回结构完整')
    console.log('真包前置体检：vue → ' + (gv.ok ? 'ok' : describeGaps(gv)))
  }

  console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
  process.exit(failures.length ? 1 : 0)
}
