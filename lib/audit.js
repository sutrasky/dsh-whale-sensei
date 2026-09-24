/**
 * audit.js — 审计（**只读、只判定**）
 * ------------------------------------------------------------------
 * 起草：mimo（读现有 `tools/*.js` 的判法）；收口：主线程。
 * 契约：`auditPack(root, pack) -> { findings: [{ id, severity, file, line?, message, hint }] }`
 *
 * **本阶段只覆盖五条**：死链 / id 重复 / 幽灵进度 / 缺产物 / 静默降级。
 * ⚠️ CSS 令牌完备性、对比度那类**不在本阶段**（要读预设与契约，复杂一档）——
 *    覆盖范围写在明面上，不许让调用方以为它全查了。
 */
/**
 * audit.js — 课程包审计（**只读、只判定，差异逐处列出**）
 * ------------------------------------------------------------------
 * 本阶段只做五条：
 *   1. 死链：产物页里的本地链接指向不存在的文件
 *   2. id 重复：课程 id / 知识点 id 重复
 *   3. 幽灵进度：progress.json 的 learned 里有不存在的课程 id
 *   4. 缺产物：课程的 href 指向的文件不存在
 *   5. 静默降级：已知产物缺失却没有告警
 * 不顺手做 CSS 令牌/对比度那类 ✗
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 审计一个课程包。
 * @param {string} root 课程包根目录
 * @param {object} pack readPack() 的结果
 * @returns {{ findings: Array<{ id: string, severity: string, file: string, line?: number, message: string, hint: string }> }}
 */
export function auditPack(root, pack) {
  const findings = []

  const add = (id, severity, file, line, message, hint) => {
    // ⚠️ 没有行号就**不产出 `line` 这个键** —— 不是 null、不是 0、不是空串：
    //    宿主要求工具返回值是 lossless JSON，一个 `line: undefined` 就让整次调用被拒
    //    （SESSION-LESSONS 204：报错只说 "value is not lossless JSON"、指不到字段）。
    //    五处调用（duplicate-id×2 / ghost-progress / missing-artifact / silent-degradation）
    //    本来就没有行号 —— 在这里收敛，不去改那五处调用点。
    const f = { id, severity, file }
    if (line !== undefined) f.line = line
    f.message = message
    f.hint = hint
    findings.push(f)
  }

  // ── 1. 死链：产物页里的本地链接指向不存在的文件 ──
  // 判据：参照 assets/check-terms.js 的 checkLinks()，逐页扫描 href/src，
  // 跳过外部链接（http/mailto/data/javascript）和页内锚点（#id），
  // 对相对路径做 posix normalize 后检查文件是否存在。
  const htmlFiles = [
    ...pack.lessons.map((l) => l.href),
    ...(fs.existsSync(path.join(root, 'reference', 'NOTES.html'))
      ? ['reference/NOTES.html']
      : []),
  ]

  for (const file of htmlFiles) {
    const abs = path.join(root, file)
    let content
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const dir = path.posix.dirname(file)
    const re = /(?:href|src)="([^"]+)"/g
    let m
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim()
      if (/^(https?:|mailto:|data:|javascript:)/i.test(raw)) continue
      if (raw.startsWith('#')) continue
      const hashAt = raw.indexOf('#')
      const target = hashAt === -1 ? raw : raw.slice(0, hashAt)
      if (!target) continue
      const resolved = path.posix.normalize(path.posix.join(dir, target))
      const absTarget = path.join(root, resolved)
      if (!fs.existsSync(absTarget)) {
        const line = content.substring(0, m.index).split('\n').length
        add(
          'dead-link',
          'error',
          file,
          line,
          `死链：${raw} → ${resolved}（文件不存在）`,
          `移除或修复链接 ${raw}`
        )
      }
    }
  }

  // ── 2. id 重复：课程 id / 知识点 id 重复 ──
  // 判据：遍历 pack.lessons / pack.points，用 Set 检测重复。
  const lessonIdSeen = new Set()
  for (const l of pack.lessons) {
    if (lessonIdSeen.has(l.id)) {
      add(
        'duplicate-id',
        'error',
        'pack.lessons',
        undefined,
        `课程 id 重复：${l.id}`,
        `确保课程 id 唯一（当前出现多次）`
      )
    }
    lessonIdSeen.add(l.id)
  }

  const pointIdSeen = new Set()
  for (const p of pack.points) {
    if (pointIdSeen.has(p.id)) {
      add(
        'duplicate-id',
        'error',
        'pack.points',
        undefined,
        `知识点 id 重复：${p.id}`,
        `确保知识点 id 唯一（当前出现多次）`
      )
    }
    pointIdSeen.add(p.id)
  }

  // ── 3. 幽灵进度：progress.json 的 learned 里有不存在的课程 id ──
  // 判据：参照 tools/starmap.test.mjs 第 103-108 行的 ghost 检查，
  // 逐条比对 pack.learned 与 pack.lessons 的 id 集合。
  const lessonIds = new Set(pack.lessons.map((l) => l.id))
  for (const id of pack.learned) {
    if (!lessonIds.has(id)) {
      add(
        'ghost-progress',
        'warn',
        'progress.json',
        undefined,
        `幽灵进度：learned 里的 ${id} 找不到对应课程`,
        `从 progress.json 的 learned 数组中移除 ${id}`
      )
    }
  }

  // ── 4. 缺产物：课程的 href 指向的文件不存在 ──
  // 判据：参照 tools/starmap.test.mjs 第 79-82 行的死链检查，
  // 逐课检查 l.href 对应的文件是否存在。
  for (const l of pack.lessons) {
    const abs = path.join(root, l.href)
    if (!fs.existsSync(abs)) {
      add(
        'missing-artifact',
        'error',
        l.href,
        undefined,
        `缺产物：课程 ${l.id} 的 href ${l.href} 不存在`,
        `重建课程页或修复 href`
      )
    }
  }

  // ── 5. 静默降级：已知产物缺失却没有告警 ──
  // 判据：参照 lib/verify.js 第 62-66 行，检查 starmap/content.js、
  // starmap/static.svg、reference/NOTES.html 是否存在。
  // 任何一项缺失都是静默降级（功能不报错但不工作）。
  const expectedArtifacts = [
    { file: 'starmap/content.js', hint: '星图数据缺失，星图无法渲染课程' },
    { file: 'starmap/static.svg', hint: '静态版 SVG 缺失，无法离线查看星图' },
    { file: 'reference/NOTES.html', hint: '笔记页缺失，名词和答疑无处查看' },
  ]
  for (const { file, hint } of expectedArtifacts) {
    if (!fs.existsSync(path.join(root, file))) {
      add(
        'silent-degradation',
        'warn',
        file,
        undefined,
        `已知产物缺失：${file}`,
        hint
      )
    }
  }

  return { findings }
}
