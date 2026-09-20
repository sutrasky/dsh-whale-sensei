/**
 * probe.js — 路径分类（**纯函数**）
 * ------------------------------------------------------------------
 * 起草：mimo（读现有 `tools/*.js` 的判法）；收口：主线程（接口 / 判据 / 对拍）。
 * 契约：`probePath(root, target, pack) -> { kind, confidence, evidence[] }`
 *   · **同输入永远同输出** —— 不读时钟 / 随机数 / env；
 *   · 每条判定必须带 `evidence`（凭什么），**不许只给结论**；
 *   · 判定顺序显式：pack 元数据 → 路径模式 → 文件内容。
 * kind 取值：lesson-page / lesson-src / student-code / reference / artifact / tool / plugin-code / unknown
 */
/**
 * probe.js — 路径探测（**纯函数**：同输入永远同输出，不许读时钟/随机数/env）
 * ------------------------------------------------------------------
 * 判的是什么：给定一个文件路径，判定它在课程包里的身份。
 * 判定顺序：**先看路径模式，再看内容特征**。
 * 每条 evidence 都要说凭什么（路径模式 / 文件内容特征），不许只给结论。
 */

import path from 'node:path'
import fs from 'node:fs'

/**
 * 探测一个路径的身份。
 * @param {string} root 课程包根目录
 * @param {string} target 要探测的文件路径（绝对或相对 root）
 * @param {object} pack readPack() 的结果
 * @returns {{ kind: string, confidence: number, evidence: string[] }}
 */
export function probePath(root, target, pack) {
  // ⚠️ `path.relative` 要求两个**绝对路径** —— 传相对 target 时 Windows 会按 cwd 解析，
  //    算出 `..\..\..\lessons\…` 这种鬼东西，于是所有判定都落 unknown（本仓库踩过 ✗）。
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target)
  const rel = path.relative(root, abs).replace(/\\/g, '/')
  const evidence = []
  let kind = 'unknown'
  let confidence = 0

  // ── 0. 越界闸：不在课程包里的文件，一个课程包类型都不许判 ──
  //    少了这道闸，「内容里提到过 data-lesson-meta」的**插件源码**会被判成课程源文件。
  //    实测：lib/pack.js 里含这个字面量 → 被判 lesson-src／把握 0.9 ✗（自信地错，比不知道更坏）。
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    return {
      kind: 'unknown',
      confidence: 1.0,
      evidence: ['不在课程包内（越界，不参与类型判定）'],
    }
  }

  // ── 1. 先查 pack.lessons（最准：来自课程包自身的元数据）──
  const lesson = pack.lessons.find(
    (l) => l.href === rel || `lessons/src/${l.file}` === rel
  )
  if (lesson) {
    if (rel.startsWith('lessons/src/')) {
      kind = 'lesson-src'
      evidence.push(`路径匹配 pack.lessons 的源文件（${lesson.id}）`)
    } else {
      kind = 'lesson-page'
      evidence.push(`路径匹配 pack.lessons 的产物 href（${lesson.id}）`)
    }
    confidence = 1.0
    return { kind, confidence, evidence }
  }

  // ── 2. 路径模式（确定性规则，不读内容）──
  if (rel.startsWith('lessons/src/') && rel.endsWith('.html')) {
    kind = 'lesson-src'
    evidence.push('路径匹配 lessons/src/*.html 模式')
    confidence = 1.0
  } else if (rel.startsWith('lessons/') && rel.endsWith('.html')) {
    kind = 'lesson-page'
    evidence.push('路径匹配 lessons/*.html 模式')
    confidence = 1.0
  } else if (rel === 'reference/NOTES.html') {
    kind = 'reference'
    evidence.push('路径是 reference/NOTES.html')
    confidence = 1.0
  } else if (rel.startsWith('code/')) {
    // 学生工作区（课程包的第一等区域，由 whale_state 细看）。少了这条，
    // 学生的 pom.xml / 源码全落 unknown（现场点流程时抓到的 ✗）。
    kind = 'student-code'
    evidence.push('路径在 code/ 学生工作区下')
    confidence = 1.0
  } else if (rel.startsWith('starmap/')) {
    // ⚠️ 该目录**混有手写源**（index.html / main.js / data-layer.js）与生成物
    //    （content.js / static.svg），只按目录归属判定拿不到 1.0 的把握。
    kind = 'artifact'
    evidence.push('路径在 starmap/ 目录下（该目录混有手写源与生成物）')
    confidence = 0.8
  } else if (rel.startsWith('tools/') && /\.(js|mjs|cjs)$/.test(rel)) {
    // ⚠️ 只认 .js 会漏掉本仓库最常用的两个脚本（tools/gate.mjs、tools/starmap.test.mjs）✗
    kind = 'tool'
    evidence.push('路径匹配 tools/*.{js,mjs,cjs} 模式')
    confidence = 1.0
  } else if (rel.startsWith('lib/') && /\.(js|mjs|cjs)$/.test(rel)) {
    kind = 'plugin-code'
    evidence.push('路径匹配 lib/*.js 模式')
    confidence = 1.0
  } else if (/\.(js|mjs|cjs)$/.test(rel) && !rel.includes('/')) {
    kind = 'plugin-code'
    evidence.push('路径是根目录下的 {js,mjs,cjs} 文件')
    confidence = 1.0
  }

  // ── 3. 内容特征（仅当路径模式未能判定且文件存在时）──
  //    ⚠️ 必须用 abs 而不是 target：target 是相对路径时会按 cwd 解析，
  //       一旦 cwd ≠ root 就读不动，嗅探**静默失效**（和上面 rel 是同一个坑，上次只修了一半）。
  if (kind === 'unknown' && fs.existsSync(abs)) {
    try {
      const content = fs.readFileSync(abs, 'utf8').slice(0, 2048)
      // ⚠️ 用**标签**而不是裸字面量：裸串会把「提到过这个标记」的源码/文档/测试全拉进来。
      if (/<script[^>]*data-lesson-meta/.test(content)) {
        kind = 'lesson-src'
        evidence.push('内容含 <script … data-lesson-meta> 标签')
        confidence = 0.9
      } else if (content.includes('window.STARMAP_REAL')) {
        kind = 'artifact'
        evidence.push('内容包含 window.STARMAP_REAL 定义')
        confidence = 0.9
      } else if (
        /\.(js|mjs|cjs)$/.test(rel) &&
        (content.includes('export function') || content.includes('module.exports'))
      ) {
        kind = 'plugin-code'
        evidence.push('内容包含 export/module.exports（模块代码）')
        confidence = 0.7
      }
    } catch {
      // 读不动就不猜
    }
  }

  if (kind === 'unknown') {
    evidence.push('路径模式和内容特征均未命中任何已知类型')
  }

  return { kind, confidence, evidence }
}
