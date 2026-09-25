/**
 * lib/state-scan.js — 学生状态探针的 IO 薄壳
 * ------------------------------------------------------------------
 * 只干三件事：**走目录、读文本、写 state.json**。判定逻辑全在 `lib/state.js`（纯函数）。
 *
 * 三个约定（都来自真实工作区，不是想象）：
 *   - **扫描根 = 声明的实践区**（圈级 `halo.json` 的 `practice.dirs` ∪ 点级 `point.json` 的
 *     `practice.dirs`）；一处都没声明才回落到配置的 `codeDir`（老包零回归）。
 *     2026-09-24 主人定：**每个知识圆圈有各自对应的实践区域**。
 *   - 项目根 = 含**构建文件或 `EXPECT.json`** 的那一层（取最外层匹配，不再往里找子项目）。
 *     ⚠️ `EXPECT.json` 也算项目标志：原来只认 `pom.xml`/`build.gradle`，于是
 *     `code/programming/vue/`（只有 EXPECT.json + 学生的 html/js）**永远立不成项目**，
 *     那份判据永远读不到 —— 2026-09-24 实测到的独立缺陷。
 *   - 期望文件 `EXPECT.json` 先找项目根，再找它的上一层（学生的目录习惯是 `code/_项目名/项目名/`）
 *
 * 项目身份：`projects[].dir` = **包根相对 POSIX 路径**（`code/programming/vue`）。
 * 为什么不是"相对扫描根"：多根之后根相对写法会**撞名**（两个根下都叫 `src` 就分不清）。
 *
 * 确定性：readdir 结果一律排序；不写时间戳；不读环境变量。
 */

import fs from 'node:fs'
import path from 'node:path'
import { stripBom } from './text.js'
// 笔记台账路径只从数据层唯一入口取：这个正本 2026-09-24 才从包根挪到 notes/，
// 谁在这里重打一遍字面量，下次挪动就会漏掉一处（本文件就是这么被查出来的）
import { NOTES_REL } from './pack-model.js'
import { readEvidence } from './evidence-io.js'
import { isStudentFile, isReadable, detectFacts, buildState, validateExpect } from './state.js'
// 内容指纹（同源对：课程包 tools/fingerprint.js）—— 排除清单与本文件 walkFiles 同一份
import { digestTree } from './fingerprint.js'

// 「这是不是 **JVM** 项目」的类型判据（只影响事实怎么读，不再决定"是不是项目"）
const BUILD_RE = /^(pom\.xml|build\.gradle|build\.gradle\.kts)$/
// 「这是不是一个**项目**」的标志：构建文件 **或** EXPECT.json（见文件头第 2 条约定）
const PROJECT_MARK_RE = /^(pom\.xml|build\.gradle|build\.gradle\.kts|EXPECT\.json)$/
const SKIP_DIR = /^(target|build|out|dist|node_modules|\.git|\.mvn|\.idea|\.vscode|\.backup|\.tmp.*)$/

/** 拼包根相对路径（POSIX）；`rel` 为空时用 `name` */
const joinRel = (rel, name) => (rel ? `${rel}/${name}` : name)

/** 路径 → 包根相对 POSIX 写法；根在包外（绝对路径）就原样保留 */
function relOf(packRoot, abs) {
  const r = path.relative(packRoot, abs).replace(/\\/g, '/')
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs.replace(/\\/g, '/')
}


/** 递归列出目录下的文件（POSIX 相对路径，已排序） */
export function walkFiles(dir, prefix = '') {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue
      out.push(...walkFiles(path.join(dir, e.name), rel))
    } else if (e.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/** 找出所有"项目根"（含构建文件的那一层），按路径排序 */
export function findProjects(rootAbs, rootRel) {
  const found = []
  const dig = (dir, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    if (entries.some((e) => e.isFile() && PROJECT_MARK_RE.test(e.name))) {
      found.push({ dir: rel || '.', abs: dir })
      return // 找到了就不再往里挖（子模块不算独立项目）
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIR.test(e.name)) continue
      dig(path.join(dir, e.name), joinRel(rel, e.name))
    }
  }
  dig(rootAbs, rootRel || '')
  // ⚠️ 用**码位序**不用 `localeCompare`：后者随区域设置变，同样输入在不同机器上可能排出不同顺序，
  //    直接破坏"同样的工作区 → 逐字节相同的 state"这条对拍判据（现场踩过：`_` 在 ICU 里排到了 `p` 后面）
  return found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

/** 读单个项目：文件清单 + 需要的文本内容 → facts */
export function scanProject(abs, dir) {
  const all = walkFiles(abs)
  const contents = new Map()
  for (const f of all) {
    if (!isReadable(f)) continue
    try {
      contents.set(f, fs.readFileSync(path.join(abs, f), 'utf8'))
    } catch {
      /* 读不动就不猜（该文件只会以"存在"参与事实） */
    }
  }
  // ⚠️ 不要把 contents（Map）挂到返回值上：上层会把它摊进 state，宿主直接拒收
  //    （"value is not lossless JSON"）✗ —— 现场踩过。
  // sourceDigest = 项目目录的内容指纹（新鲜度判据，无时间戳、纯输入函数）：
  // 提交点亮时 ask-server 现算比对，对不上 = 快照过期（失败关闭，不点亮）
  return { facts: detectFacts(dir, all, contents), sourceDigest: digestTree(abs) }
}

/** 找 EXPECT.json：先项目根，再上一层 */
export function findExpect(abs) {
  // 候选：项目根自己，再往上一层（学生的目录习惯是 `<项目名>/<项目名>/`，
  // 期望文件写在外层）。两层都不在 → null（上层报"未声明期望"，不猜缺什么）
  const candidates = [path.join(abs, 'EXPECT.json')]
  const up = path.dirname(abs)
  if (up !== abs) candidates.push(path.join(up, 'EXPECT.json'))
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const raw = fs.readFileSync(c, 'utf8')
      let doc
      try {
        doc = JSON.parse(stripBom(raw))
      } catch (e) {
        throw new Error(`${c}：不是合法 JSON —— ${e.message}`)
      }
      return { path: c, doc: validateExpect(doc, c) }
    }
  }
  return null
}

/**
 * 挑战序号对位：数课程源 `<!--@challenges-->` 区块里的 `<li>` 条数（IO 层，B4）。
 *
 * 口径镜像课程包 `tools/check-lesson-content.js`（课程包内相对路径） 的 **R6** ——
 * 主流程 `challengeAlignment()`（:432）+ 源定位 `findLessonSource()`（:424）：
 * `EXPECT.json` 的 `challenges[].no` 集合必须**恰好**等于该课课程源
 * `<!--@challenges-->` 区块里 `<li>` 的条数 {1..liCount}。本层只干 IO（定位 + 数数），
 * **判定是纯比较**、住 `lib/state.js` 的 `checkChallengeAlignment`（那边注释同样钉着 R6 出处）。
 *
 * ⚠️ 读不到源**不崩、不静默**：liCount=null + reason（"读不到源：…"），由 state.js 报
 *    "这条校验跳过"。id 形状不对 / 源里没有 @challenges 区块同理（对位无从校验，照报）。
 *
 * @param {string} root 课程包根
 * @param {object} doc EXPECT.json（validateExpect 校验过的形态）
 * @returns {Object<string, {source: string|null, liCount: number|null, reason: string|null, unreadable?: boolean}>}
 */
export function readChallengeLiCounts(root, doc) {
  const out = {}
  for (const l of Array.isArray(doc?.lessons) ? doc.lessons : []) {
    const chs = Array.isArray(l?.challenges) ? l.challenges : []
    if (!chs.length) continue // 没声明判据 = 不产出完成度（R6 同口径：不猜）
    const id = String(l?.id || '')
    const m = /^([^/]+)\/(\d{4})$/.exec(id) // R6 :454 同一条 id 形状（point/NNNN）
    if (!m) {
      out[id] = { source: null, liCount: null, reason: 'id 不是 point/NNNN 形状，序号对位无从校验', unreadable: false }
      continue
    }
    const [, pointId, num] = m
    // 源定位镜像 R6 的 findLessonSource（:424）：lessons/src/<圆圈>/<知识点>/NNNN-*.html。
    // 那边圈从 points 表来；这里圈未知 ⇒ 逐圈找、取**字典序第一个**命中（确定性：一律排序）。
    let srcFile = null
    let srcRel = null
    try {
      const srcRoot = path.join(root, 'lessons', 'src')
      const circles = fs.readdirSync(srcRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name).sort()
      for (const circle of circles) {
        let names = []
        try { names = fs.readdirSync(path.join(srcRoot, circle, pointId)) } catch { continue }
        const hit = names.filter((n) => new RegExp(`^${num}-.*\\.html$`).test(n)).sort()[0] // R6 :427 同一条
        if (hit) { srcFile = path.join(srcRoot, circle, pointId, hit); srcRel = relOf(root, srcFile); break }
      }
    } catch (e) {
      out[id] = { source: null, liCount: null, reason: `${e?.message ?? e}`, unreadable: true }
      continue
    }
    if (!srcFile) {
      out[id] = { source: null, liCount: null, reason: `找不到课程源 lessons/src/<圆圈>/${pointId}/${num}-*.html`, unreadable: true }
      continue
    }
    let html
    try {
      html = fs.readFileSync(srcFile, 'utf8')
    } catch (e) {
      out[id] = { source: srcRel, liCount: null, reason: `${srcRel} 读失败（${e?.message ?? e}）`, unreadable: true }
      continue
    }
    const block = /<!--@challenges-->([\s\S]*?)<!--\/@challenges-->/.exec(html) // R6 :471 同一条
    if (!block) {
      out[id] = { source: srcRel, liCount: null, reason: `${srcRel} 里找不到 <!--@challenges--> 区块`, unreadable: false }
      continue
    }
    const lis = [...block[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)] // R6 :478 同一条
    out[id] = { source: srcRel, liCount: lis.length, reason: null }
  }
  return out
}

const countLines = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

/** 学生信号：提问 / 笔记 / 学习记录（都只数条数，不读内容） */
export function scanSignals(root) {
  const lessons = path.join(root, 'lessons')
  return {
    pendingQuestions: countLines(path.join(root, 'questions', 'pending.jsonl')),
    processedQuestions: countLines(path.join(root, 'questions', 'processed.jsonl')),
    notes: countLines(path.join(root, NOTES_REL)),
    records: (() => {
      try {
        return fs.readdirSync(path.join(root, 'learning-records')).filter((f) => f.endsWith('.md')).length
      } catch {
        return 0
      }
    })(),
    lessonPages: (() => {
      // 递归数产物页：分层布局后是 lessons/<圆圈>/<知识点>/NNNN-*.html。
      // 只扫一层在分层后会数出 0 —— 那是"看起来对、其实空"的静默错（2026-09-21 实测）。
      // src/ 是作者态镜像，不算产物页。
      let n = 0
      const walk = (d) => {
        let es = []
        try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of es) {
          if (e.isDirectory()) { if (e.name !== 'src') walk(path.join(d, e.name)); continue }
          if (/^\d{4}-.*\.html$/.test(e.name)) n++
        }
      }
      walk(lessons)
      return n
    })(),
  }
}

/**
 * 声明的实践区（包根相对、排序去重）：**圈级 ∪ 点级**。
 * 一处都没声明才回落 `fallback`（插件配置的 `codeDir`）—— 老包零回归。
 *
 * 为什么是并集不是覆盖：圈级声明"这个圈的实践区范围"，点级声明"这个点的具体落点"，
 * 两者都要扫到。去重与排序保证同样的工作区产出逐字节相同的 state。
 *
 * @param {object} pack `readPack` 的结果（circles / points 上各带 `practice.dirs`）
 * @param {string} fallback 兜底根
 * @returns {string[]}
 */
export function collectPracticeRoots(pack, fallback) {
  const out = new Set()
  const add = (d) => {
    const rel = String(d ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (rel) out.add(rel)
  }
  // ⚠️ `pack` 可能是**计数形态**（`circles` / `points` 是数字，见 `state.js` 的 `count()`）——
  //    直接 `for...of` 一个数字会 TypeError（现场踩过：state-probe 整套崩）。不是数组就当成"没声明"。
  const circles = Array.isArray(pack?.circles) ? pack.circles : []
  const points = Array.isArray(pack?.points) ? pack.points : []
  for (const c of circles) for (const d of Array.isArray(c?.practice?.dirs) ? c.practice.dirs : []) add(d)
  for (const p of points) for (const d of Array.isArray(p?.practice?.dirs) ? p.practice.dirs : []) add(d)
  if (!out.size && fallback) add(fallback)
  return [...out].sort()
}

/**
 * 扫整个工作区 → 可以交给 `buildState` 的材料。
 * @param {string} root 课程包根
 * @param {{codeDir?: string, pack?: object, only?: string}} opts
 *   `codeDir` = **兜底**根（没有声明时用）；`pack` = `readPack` 结果（实践区声明从它取）
 */
export function scanWorkspace(root, opts = {}) {
  const packRoot = path.resolve(root)
  const codeRel = opts.codeDir || 'code'
  const roots = collectPracticeRoots(opts.pack, codeRel)
  const projects = []
  const expects = new Map()
  const warnings = []
  const usedRoots = []
  const seen = new Set()
  for (const rel of roots) {
    const abs = path.isAbsolute(rel) ? rel : path.join(packRoot, rel)
    if (!fs.existsSync(abs)) {
      // 声明了但目录还没建：**不报错、不静默** —— 进 warnings，且不记进 practiceRoots
      warnings.push(`实践区 ${rel} 不存在 —— 这一处没有作品可扫（是目录还没建，不是"学生没做"）`)
      continue
    }
    usedRoots.push(rel)
    for (const hit of findProjects(abs, rel)) {
      if (opts.only && hit.dir !== opts.only) continue
      // 嵌套声明（圈 `code/programming` + 点 `code/programming/vue`）会命中同一个项目 → 按 dir 去重
      if (seen.has(hit.dir)) continue
      seen.add(hit.dir)
      projects.push(scanProject(hit.abs, hit.dir))
      try {
        const e = findExpect(hit.abs)
        // 存 `{ path, doc }`：`path` 要进 state，给课程页显示"判据写在哪个文件"。
        // ⚠️ 必须**包根相对**（findExpect 给的是绝对路径）：直接落盘会让
        //    ① 同样的工作区在不同机器/不同目录上产出**不同**的文件（对拍与漂移判据全废）
        //    ② 本机路径漏进发布产物（alien-env 有静态守卫盯着）—— 2026-09-24 实测踩到
        if (e) expects.set(hit.dir, { path: relOf(packRoot, e.path), doc: e.doc })
      } catch (err) {
        warnings.push(err.message)
      }
    }
  }
  const signals = scanSignals(root)
  // codeRel = 兜底根的**相对**写法（仍进 state.json 的 `codeDir`，包侧老读法照旧）；
  // practiceRoots = 本轮**实际存在**的扫描根（排序、去重，无时间戳）；
  // digests = 每个项目的内容指纹（进 state.json 的 `projects[].sourceDigest`）
  const digests = new Map(projects.map((p) => [p.facts.dir, p.sourceDigest]))
  // 挑战序号对位的源计数（镜像 R6）：只数**声明了挑战**的那些课，读不到源如实带 reason ——
  // 手写坏的 EXPECT.json（no 与源里题目数对不上）不再让插件的 k/n 说谎
  const lessonSources = {}
  for (const { doc } of expects.values()) {
    for (const [id, info] of Object.entries(readChallengeLiCounts(packRoot, doc))) lessonSources[id] = info
  }
  // 证据台账（P0-4 戊1b）：**在这里读一次**，交给判定层 —— 判定层是纯的（不读盘）。
  // ⚠️ 读的是 `{exists, entries}` 整个对象（不是 entries 数组）：`exists === false` 是
  //    判据 ④ 的那个开关（台账不存在 → 回退今天的机械对账），拿空数组顶替就把两者混了。
  const evidence = readEvidence(root)
  return { projects, expects, signals, warnings, codeDir: codeRel, codeRel, practiceRoots: usedRoots, digests, lessonSources, evidence }
}

/** 原子写 state.json（先 `.tmp-<pid>` 再 rename）；内容没变就不重写 */
export function writeState(root, state, rel = 'learning-records/state.json') {
  const abs = path.join(root, ...rel.split('/'))
  const content = JSON.stringify(state, null, 2) + '\n'
  let prev = null
  try {
    prev = fs.readFileSync(abs, 'utf8')
  } catch {
    /* 不存在 */
  }
  if (prev === content) return { path: rel, changed: false }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, abs)
  return { path: rel, changed: true }
}

/** 一步到位：扫 + 组装（给工具与测试共用） */
export function probeState(root, pack, opts = {}) {
  // `pack` 必须传进扫描层：实践区声明（圈级 / 点级）就住在它上面。
  // 这里显式覆盖 opts.pack，调用方漏传也不会退化成"只有兜底根"。
  const { projects, expects, signals, warnings, codeRel, practiceRoots, digests, lessonSources, evidence } = scanWorkspace(root, { ...opts, pack })
  const state = buildState({ pack, projects, signals, expects, codeDir: codeRel || 'code', practiceRoots, digests, lessonSources, evidence })
  return { state, warnings }
}
