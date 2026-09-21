/**
 * build-write.mjs —— `whale_build` 的**落盘分支**验收
 *
 * 为什么单开一套：写入是唯一会改磁盘的能力，必须有反例钉住。判据：
 *   ① 干净包 + write=false：只校验、不写盘，drift 空、ok 真
 *   ② 影子包里删掉一个页面 → write=false 必须报出"缺产物"（ok 假）—— 抓得到漂移
 *   ③ 同一影子 write=true → 写入该页，且**报告自洽**：ok 真、drift 空
 *      （现场抓到过：写入后仍列"缺产物"→ ok 假阴 ✗，这条判据就是钉它的）
 *   ④ 写回的字节 == 真包同页字节（逐字节）
 *   ⑤ 再写一次：written 空（幂等，不白刷 mtime）
 *   ⑥ **真包全程未被改动**（跑前跑后哈希逐项相同）—— 实验台是影子，不是真包
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
function lessonRelPaths(lessons) {
  const out = []
  ;(function walk(d, prefix = '') {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { if (e.name !== 'src') walk(path.join(d, e.name), rel); continue }   // src = 作者态镜像
      if (e.name.endsWith('.html')) out.push(rel)
    }
  })(lessons)
  return out.sort()
}
function hashTree(root) {
  const out = []
  const lessons = path.join(root, 'lessons')
  for (const f of lessonRelPaths(lessons)) {
    out.push(f + ':' + fs.readFileSync(path.join(lessons, f), 'utf8').length + ':' + sha(fs.readFileSync(path.join(lessons, f))))
  }
  for (const rel of ['assets/theme.css', 'starmap/content.js']) {
    const p = path.join(root, rel)
    if (fs.existsSync(p)) out.push(rel + ':' + sha(fs.readFileSync(p)))
  }
  return out.join('|')
}
function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

// 假装是宿主：装一遍模块，拿到工具定义
const tools = []
const mod = await import('../lib/mods/build.js')
mod.plugin.install({ paths: { packRoot: ROOT, dataDir: ROOT }, log: () => {}, registerTool: (d) => tools.push(d) })
const tool = tools.find((t) => t.name === 'whale_build')
ok(!!tool, 'whale_build 装得上')

console.log(`\n[write] 课程包：${ROOT}`)
const realPages = lessonRelPaths(path.join(ROOT, 'lessons'))
ok(realPages.length > 0, `真包里有 ${realPages.length} 个课程页`)
const realBefore = hashTree(ROOT)

// ── ① 干净包 + write=false ──
const clean = await tool.execute({ root: ROOT })
ok(clean.drift.length === 0 && clean.ok === true, `干净包：drift 空、ok 真（drift ${clean.drift.length} 条）`)
ok((clean.written || []).length === 0, 'write=false 时一个文件都不写')

// ── 影子副本 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-write-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const victim = realPages[0]
  const victimAbs = path.join(tmp, 'lessons', victim)
  fs.rmSync(victimAbs, { force: true })

  // ── ② 漂移必须被抓到 ──
  const drift = await tool.execute({ root: tmp })
  const spotted = drift.drift.some((d) => d.includes(victim))
  ok(drift.ok === false && spotted, `缺产物被抓到（ok=${drift.ok}，${drift.drift.length} 条）`)

  // ── ③ write=true：写入 + 报告自洽 ──
  const wrote = await tool.execute({ root: tmp, write: true })
  ok((wrote.written || []).includes('lessons/' + victim), `写了缺的那一页：${(wrote.written || []).join(', ')}`)
  ok(wrote.ok === true, '写入之后 ok 为真')
  ok(wrote.drift.length === 0, `写入之后报告里没有残留漂移（残留 ${wrote.drift.length} 条：${wrote.drift.slice(0, 3).join(' / ')}）`)

  // ── ④ 写回的字节与真包逐字节相同 ──
  const a = fs.readFileSync(path.join(ROOT, 'lessons', victim), 'utf8')
  const b = fs.readFileSync(victimAbs, 'utf8')
  ok(a === b, `写回的字节与真包同页逐字节相同（${a.length} vs ${b.length} 字符）`)

  // ── ⑤ 幂等 ──
  const again = await tool.execute({ root: tmp, write: true })
  ok((again.written || []).length === 0 && again.ok === true, '再写一次：没有文件被重写，ok 仍为真')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑥ 真包没被动过 ──
ok(hashTree(ROOT) === realBefore, '真包全程未被改动（页面 / theme.css / content.js 哈希逐项相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 落盘分支：抓得到漂移、修得对、报告自洽、真包不动')
