#!/usr/bin/env node
/**
 * test/export-pack.mjs — 「导出这一节课」（离线课件包 zip）的判据
 * ------------------------------------------------------------------
 * 场景 B（离线阅读器）的**导出侧**：设置页「课程目录」里每节课后面的「导出」。
 * 判据自己**造一个最小课程包**（不依赖真包，换机器也能跑），在临时目录里真导、真解、真核。
 *
 * [1] 真导出：产出 zip，且**恰好 5 个文件**（pack.json + 圈/点结构 + 这一课的产物 + 单课清单）
 * [2] **边界**：包里**不许有** `lessons/src/`、`assets/`、`starmap/`（那些由离线阅读器的包骨架提供）
 * [3] 形状：`pack.json` 带层级 id（`<圈>/<点>`）与课号/标题；单课清单只有 1 条且 `rel` 对得上
 * [4] 文件名：`鲸师课件-<课程名>.zip`；同名第二次导出 → 自动加课号（不覆盖、不静默）
 * [5] 反空转：路径穿越 / 产物不存在 / 源文件没了 ⇒ 一律 `ok:false` 且 error 说人话
 * [6] 纯读：导出前后课程包内每个文件的 path+size+mtime **全同**（导出不许改包）
 * [7] `safeName`：非法字符 / 超长 / 空串
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { exportLesson, safeName } from '../lib/pack-export.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg) } else { fails.push(msg); console.log(` FAIL ${msg}`) }
}

/** 课程包内所有文件的 path+size+mtime 快照（判据 [6] 用） */
function snapshot(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { const s = fs.statSync(p); out.push(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}`) }
    }
  }
  walk(dir)
  return out.join('\n')
}

function unzipList(zip) {
  return execFileSync(TAR, ['-tf', zip], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim().replace(/^\.\//, ''))
    .filter((s) => s && !s.endsWith('/'))   // tar 也会列目录条目 —— 判据只数文件
    .sort()
}
function unzipRead(zip, rel, into) {
  fs.mkdirSync(into, { recursive: true })
  execFileSync(TAR, ['-xf', zip, '-C', into], { encoding: 'utf8' })
  return fs.readFileSync(path.join(into, rel), 'utf8')
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-export-test-'))
const PACK = path.join(TMP, 'pack')
const OUT = path.join(TMP, 'out')
const UNZIP = path.join(TMP, 'unzip')

const mk = (rel, content) => {
  const p = path.join(PACK, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

try {
  /* ── 造一个最小课程包（不依赖真包）──────────────────────────────── */
  mk('lessons/demo/halo.json', `${JSON.stringify({ halo: 'demo', name: '演示圈', color: '#888888' }, null, 2)}\n`)
  // alpha **依赖 beta**（前置链），而 beta 自己没有课 —— 导出 alpha 的课时必须把 beta 的
  // **结构**（point.json）一起带上：否则收件人那边星图的前置航道缺一条、重建还会被悬空校验拒。
  // `ghost` 是**故意不存在**的前置：验证"缺失的那条跳过、不许炸"。
  mk('lessons/demo/alpha/point.json', `${JSON.stringify({ point: 'alpha', name: '演示点', fileBase: 0, requires: ['beta', 'ghost'] }, null, 2)}\n`)
  mk('lessons/demo/beta/point.json', `${JSON.stringify({ point: 'beta', name: '前置点', fileBase: 0 }, null, 2)}\n`)
  const META = {
    number: 1,
    title: '你好，世界',
    navTitle: '演示 第1课',
    halo: 'demo',
    point: 'alpha',
    terms: { a: {}, b: {} },
    source: { label: '示例出处', url: 'https://example.com' },
  }
  mk('lessons/src/demo/alpha/0001-hello.html',
    `<!doctype html><html><head><script type="application/json" data-lesson-meta>${JSON.stringify(META)}</script></head><body>src</body></html>`)
  mk('lessons/demo/alpha/0001-hello.html', '<!doctype html><html><body>rendered</body></html>')
  fs.mkdirSync(path.join(PACK, 'tools'), { recursive: true })
  fs.copyFileSync(
    path.join(PLUGIN, 'lib', 'pack-template', 'tools', 'build-lessons-index.js'),
    path.join(PACK, 'tools', 'build-lessons-index.js'))

  const hctx = { paths: { packRoot: PACK }, log: {} }
  const before = snapshot(PACK)

  /* ── [1] 真导出 ─────────────────────────────────────────────────── */
  const r1 = await exportLesson({ file: 'demo/alpha/0001-hello.html', outDir: OUT }, hctx)
  ok(r1.ok === true, `[1] 真导出成功 —— ${r1.ok ? `${r1.name}（${r1.bytes} 字节）` : r1.error}`)
  ok(r1.ok === true && fs.existsSync(r1.zip) && r1.bytes > 0, '[1] zip 真落在磁盘上且非空')

  if (r1.ok) {
    const list = unzipList(r1.zip)
    const want = [
      'lessons/demo/alpha/0001-hello.html',
      'lessons/demo/alpha/point.json',
      'lessons/demo/beta/point.json',        // 前置的结构随包走
      'lessons/demo/halo.json',
      'lessons/lessons.json',
      'pack.json',
    ]
    ok(list.length === want.length && want.every((w) => list.includes(w)),
      `[1] 恰好 6 个文件（含前置结构）—— ${list.join(' / ')}`)

    /* ── [2] 边界：不许有 src / assets / starmap ─────────────────── */
    const leak = list.filter((p) => p.includes('/src/') || p.startsWith('assets/') || p.startsWith('starmap/'))
    ok(leak.length === 0, `[2] 包里没有 src/assets/starmap —— 漏项 ${leak.length} 个`)

    /* ── [3] 形状 ──────────────────────────────────────────────── */
    const packJson = JSON.parse(unzipRead(r1.zip, 'pack.json', UNZIP))
    ok(packJson.id === 'demo/alpha' && packJson.circle === 'demo' && packJson.point === 'alpha',
      `[3] pack.json 带层级 id —— ${packJson.id}`)
    ok(packJson.lesson && packJson.lesson.number === 1 && packJson.lesson.title === '你好，世界',
      `[3] pack.json 带这一课的号与标题 —— 第${packJson.lesson?.number}课 ${packJson.lesson?.title}`)

    const idx = JSON.parse(unzipRead(r1.zip, 'lessons/lessons.json', UNZIP))
    ok(Array.isArray(idx.lessons) && idx.lessons.length === 1 && idx.lessons[0].rel === 'demo/alpha/0001-hello.html',
      `[3] 单课清单只有 1 条且 rel 对得上 —— ${idx.lessons?.length} 条`)
    ok(idx.lessons?.[0]?.title === '你好，世界' && idx.lessons?.[0]?.halo === 'demo' && idx.lessons?.[0]?.point === 'alpha',
      '[3] 清单条目与 src meta 同形（title/halo/point 都在）')

    /* ── [13] 前置结构随包走（治本：离线端不必再靠 `--allow-missing-requires` 降级）── */
    ok(Array.isArray(packJson.prereqs) && packJson.prereqs.includes('demo/beta') && !packJson.prereqs.includes('demo/ghost'),
      `[13] pack.json 记下前置链，缺的那条跳过 —— ${JSON.stringify(packJson.prereqs)}`)
    ok(list.includes('lessons/demo/beta/point.json'),
      '[13] 前置的 point.json 真进了 zip（星图那条前置航道才立得住）')
    ok(Array.isArray(r1.prereqs) && r1.prereqs.includes('demo/beta'),
      `[13] 返回值里也报了前置 —— ${JSON.stringify(r1.prereqs)}`)
    ok(!list.some((p) => p.includes('beta/0001') || p.includes('beta/') && p.endsWith('.html')),
      '[13] 只带前置的**结构**，不带前置的课（没发给学生的内容一页都不漏）')

    /* ── [4] 文件名：课程名 + 同名加课号 ─────────────────────────── */
    ok(r1.name === '鲸师课件-你好，世界.zip', `[4] 文件名用课程名 —— ${r1.name}`)
    const r2 = await exportLesson({ file: 'demo/alpha/0001-hello.html', outDir: OUT }, hctx)
    ok(r2.ok === true && /-0001\.zip$/.test(r2.name), `[4] 同名第二次导出自动加课号 —— ${r2.ok ? r2.name : r2.error}`)
    const r3 = await exportLesson({ file: 'demo/alpha/0001-hello.html', outDir: OUT }, hctx)
    ok(r3.ok === false && /已经有/.test(r3.error || ''), `[4] 第三次如实拒绝、不静默覆盖 —— ${r3.error}`)
  }

  /* ── [5] 反空转 ─────────────────────────────────────────────────── */
  const evil = await exportLesson({ file: '../evil.html', outDir: OUT }, hctx)
  ok(evil.ok === false && /相对路径/.test(evil.error || ''), `[5] 路径穿越被拒 —— ${evil.error}`)
  const missing = await exportLesson({ file: 'demo/alpha/9999-nope.html', outDir: OUT }, hctx)
  ok(missing.ok === false && /找不到/.test(missing.error || ''), `[5] 产物不存在时如实报 —— ${missing.error}`)
  const noSrc = await exportLesson({ file: 'demo/alpha/0001-hello.html', outDir: OUT }, {
    paths: { packRoot: path.join(TMP, 'nosrc') }, log: {},
  })
  ok(noSrc.ok === false, `[5] 没有课程包时如实报 —— ${noSrc.error}`)

  /* ── [6] 纯读：导出没改包一个字节（**在动 src 之前**取快照）──────── */
  ok(before === snapshot(PACK), '[6] 导出前后课程包内每个文件 path+size+mtime 全同（导出是纯读）')

  // 源没了 → 清单生成器当场报「没有 lessons/src」⇒ 导出必须拒绝（不是"导出一个空包"）
  fs.rmSync(path.join(PACK, 'lessons', 'src'), { recursive: true, force: true })
  const goneSrc = await exportLesson({ file: 'demo/alpha/0001-hello.html', outDir: OUT }, hctx)
  ok(goneSrc.ok === false && /没有 lessons\/src|清单里没有/.test(goneSrc.error || ''), `[5] 源文件没了 ⇒ 拒绝 —— ${goneSrc.error}`)

  /* ── [7] safeName ──────────────────────────────────────────────── */
  ok(!/[\\/:*?"<>|]/.test(safeName('a/b:c*?"<>|d')), `[7] safeName 去掉非法字符 —— ${safeName('a/b:c*?"<>|d')}`)
  ok(safeName('   ') === '课程', `[7] safeName 空串回落到「课程」 —— ${safeName('   ')}`)
  ok(safeName('长'.repeat(80)).length <= 60, `[7] safeName 截断到 60 —— ${safeName('长'.repeat(80)).length}`)
  ok(safeName('...hidden...') === 'hidden', `[7] safeName 去掉首尾点 —— ${safeName('...hidden...')}`)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1) }
