/**
 * lib/state-scan.js — 学生状态探针的 IO 薄壳
 * ------------------------------------------------------------------
 * 只干三件事：**走目录、读文本、写 state.json**。判定逻辑全在 `lib/state.js`（纯函数）。
 *
 * 两个约定（都来自真实工作区，不是想象）：
 *   - 项目根 = 含 `pom.xml` / `build.gradle(.kts)` 的那一层（取最外层匹配，不再往里找子项目）
 *   - 期望文件 `EXPECT.json` 先找项目根，再找它的上一层（学生的目录习惯是 `code/_项目名/项目名/`）
 *
 * 确定性：readdir 结果一律排序；不写时间戳；不读环境变量。
 */

import fs from 'node:fs'
import path from 'node:path'
import { stripBom } from './text.js'
// 笔记台账路径只从数据层唯一入口取：这个正本 2026-09-24 才从包根挪到 notes/，
// 谁在这里重打一遍字面量，下次挪动就会漏掉一处（本文件就是这么被查出来的）
import { NOTES_REL } from './pack-model.js'
import { isStudentFile, isReadable, detectFacts, buildState, validateExpect } from './state.js'

const BUILD_RE = /^(pom\.xml|build\.gradle|build\.gradle\.kts)$/
const SKIP_DIR = /^(target|build|out|dist|node_modules|\.git|\.mvn|\.idea|\.vscode|\.backup|\.tmp.*)$/

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
export function findProjects(codeDir) {
  const found = []
  const dig = (dir, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    if (entries.some((e) => e.isFile() && BUILD_RE.test(e.name))) {
      found.push(rel || '.')
      return // 找到了就不再往里挖（子模块不算独立项目）
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIR.test(e.name)) continue
      dig(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
    }
  }
  dig(codeDir, '')
  return found.sort()
}

/** 读单个项目：文件清单 + 需要的文本内容 → facts */
export function scanProject(codeDir, rel) {
  const abs = path.join(codeDir, rel)
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
  return { facts: detectFacts(rel, all, contents) }
}

/** 找 EXPECT.json：先项目根，再上一层 */
export function findExpect(codeDir, rel) {
  const candidates = [
    path.join(codeDir, rel, 'EXPECT.json'),
    rel.includes('/') ? path.join(codeDir, rel.split('/')[0], 'EXPECT.json') : null,
  ].filter(Boolean)
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
 * 扫整个工作区 → 可以交给 `buildState` 的材料。
 * @param {string} root 课程包根
 * @param {{codeDir?: string, pack?: object, only?: string}} opts
 */
export function scanWorkspace(root, opts = {}) {
  const codeRel = opts.codeDir || 'code'
  const codeDir = path.isAbsolute(codeRel) ? codeRel : path.join(root, codeRel)
  const rels = findProjects(codeDir).filter((r) => !opts.only || r === opts.only)
  const projects = []
  const expects = new Map()
  const warnings = []
  for (const rel of rels) {
    projects.push(scanProject(codeDir, rel))
    try {
      const e = findExpect(codeDir, rel)
      if (e) expects.set(rel, e.doc)
    } catch (err) {
      warnings.push(err.message)
    }
  }
  const signals = scanSignals(root)
  return { projects, expects, signals, warnings, codeDir }
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
  const { projects, expects, signals, warnings } = scanWorkspace(root, opts)
  const state = buildState({ pack, projects, signals, expects })
  return { state, warnings }
}
