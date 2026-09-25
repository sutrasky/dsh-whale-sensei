#!/usr/bin/env node
/**
 * test/deadlink-parity.mjs —— 「死链 / 缺产物」互补对拍（口径不动，只钉差异）
 * ---------------------------------------------------------------------------
 * 补的是这条债（B6 判定「要修」，但**不动口径**）：插件 `lib/audit.js` 与包侧
 * `tools/starmap.test.mjs` 的【死链】组是**同一谓词的两种实现、取数不同**
 * （活源产物页 HTML 全文 vs 构建产物 `starmap/content.js`），各有对方照不到的盲区 ——
 * 硬统一会丢掉一类检出，所以两边产品代码一个字都不改，只把差异钉成「已知且有意」：
 *
 *   复现①  产物页里加 `<a href="nope.html">`
 *           ⇒ 插件报 dead-link（error、带行号）；包侧【死链】组**不报**
 *   复现②  `lessons/src/math/alge/x-z.html`（meta number=7）重建 content.js 但不建产物
 *           ⇒ 包侧报「死链：alge/0007→lessons/math/alge/x-z.html」；插件 **0 报**
 *             （readPack 只认 lessons/src 下的 `NNNN-*.html`，x-z.html 被文件名过滤器挡掉）
 *
 * 机制（照 test/judge-parity.mjs 那套现成做法）：豁免表 EXEMPT + **双方实况断言** ——
 * 每行同时断言「插件这边会报 X」**和**「包侧这边不报 Y」，任一边以后变了这行就红，
 * 逼人重新裁定（不许悄悄改产品代码去凑一致）；登记过的差异必须真存在（豁免反核账）；
 * 健康夹具上两边必须同时 ∅ —— 出现任何没登记的差异一律红（裸漂移）。
 *
 * 造夹具全在 `os.tmpdir()` 的 mkdtemp **影副本**里（真包 tools/ + starmap/ 只被拷出去读），
 * 结尾哈希钉住「真包一个字节没动」。
 *
 * 反空转（开发期实测，见回报）：`lib/audit.js` 的 dead-link 判定
 * `if (!fs.existsSync(absTarget))` 临时改成 `if (false && …)` ⇒ 本套必红
 * （复现① 的插件侧实况 + 豁免 D1 反核账一起红）⇒ 改回 ⇒ 绿。
 *
 * 跑：node test/deadlink-parity.mjs [课程包根]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { auditPack } from '../lib/audit.js'
import { readPack } from '../lib/pack-model.js'
import { packRoot } from './_pack.mjs'

const PACK = packRoot()

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
const j = (v) => JSON.stringify(v)

/* ── 豁免表：两边**有意不同**的部分（不是漂移，也不许为了凑一致去改产品代码）─────
 * 每行 = 用例 → 插件侧实况 / 包侧实况 / 理由。哪边行为变了，这行就红。
 */
const EXEMPT = [
  {
    id: 'D1',
    key: '复现①（页内死链）',
    case: '复现①：产物页里有页内死链 `<a href="nope.html">`',
    插件: 'dead-link 恰好 1 条（nope.html，error，file=lessons/math/alge/0001-algebra-basics.html、line=6）',
    包侧: '【死链】组干净（0 条）',
    plugIs: (o) => {
      const d = o.plug.filter((f) => f.id === 'dead-link')
      return d.length === 1 && d[0].message.includes('nope.html') && d[0].line === 6
        && d[0].file === 'lessons/math/alge/0001-algebra-basics.html'
    },
    packIs: (o) => o.pack.seen === true && o.pack.clean === true,
    why: '**同一谓词的两种实现、取数不同（活源 vs 构建产物）**：插件读产物页 HTML 全文逐个扫 href/src'
      + '（跳外链与 #锚点、去 #片段、按页目录 normalize）；包侧只读构建产物 starmap/content.js 的 '
      + 'lessons[].href 逐个 existsSync —— 页内链接根本不在它的取数里。页内死链只有插件这一侧照得到。',
  },
  {
    id: 'D2',
    key: '复现②（产物没建）',
    case: '复现②：content.js 里有课、产物没建（alge/0007 → lessons/math/alge/x-z.html）',
    插件: '0 条（连 missing-artifact 都不报）',
    包侧: '【死链】组 1 条：alge/0007→lessons/math/alge/x-z.html',
    plugIs: (o) => o.plug.length === 0,
    packIs: (o) => o.pack.seen === true && o.pack.clean === false
      && o.pack.entries.some((e) => e.includes('alge/0007') && e.includes('lessons/math/alge/x-z.html')),
    why: '反向的同一件事：包侧取数是构建产物 content.js（构建器按 meta 认课、不看文件名）；插件取数是'
      + '活源文件树，readPack 只认 `lessons/src/**/NNNN-*.html`，x-z.html 被过滤器挡掉 ⇒ 这课压根不在'
      + '它的课程清单里，dead-link 与 missing-artifact 都无从报。产物没建只有包侧照得到。',
  },
]
const exemptOf = (key) => EXEMPT.find((e) => e.key === key)

/* ── 影副本夹具（os.tmpdir() + mkdtemp；真包只读、一个字节不动）────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-deadlink-parity-'))

const META = (n, title) =>
  `<script type="application/json" data-lesson-meta>{"number":${n},"title":${JSON.stringify(title)},"terms":{}}</script>`

const srcPage = (n, title) => [
  '<!doctype html>',
  `<html lang="zh-CN"><head><meta charset="utf-8">${META(n, title)}</head>`,
  '<body></body>',
  '</html>',
].join('\n')

/** 产物页：第 6 行是那条死链（行号是构造出来的已知值，断言里逐字钉住） */
const builtPage = (withDead) => [
  '<!doctype html>',                                                        // 1
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>0001</title></head>', // 2
  '<body>',                                                                 // 3
  '<h1>0001 代数基础</h1>',                                                   // 4
  '<p><a href="https://example.com">外链</a> · <a href="#top">锚点</a> · <a href="0001-algebra-basics.html">自链</a></p>', // 5
  ...(withDead ? ['<p><a href="nope.html">死链</a></p>'] : []),              // 6
  '</body></html>',
].join('\n')

const lesson = (id, number, title, href) => ({ id, label: `第${number}课`, title, href, learned: false, termCount: 0, number })
const contentJs = (lessons) => `window.STARMAP_REAL = ${JSON.stringify({
  termTotal: 0,
  halos: [{ id: 'math', name: '数学', center: '', points: [{ id: 'alge', name: '代数' }] }],
  lessons,
  edges: [],
}, null, 2)};\n`

function shadow(name, { lessons, built, srcFiles }) {
  const root = path.join(tmp, name)
  fs.mkdirSync(root, { recursive: true })
  // 真包的 tools/ + starmap/ 原样拷进影副本：包侧那条判据在"它自己的包"里跑，跑的是真源码
  fs.cpSync(path.join(PACK, 'tools'), path.join(root, 'tools'), { recursive: true })
  fs.cpSync(path.join(PACK, 'starmap'), path.join(root, 'starmap'), { recursive: true })
  fs.mkdirSync(path.join(root, 'reference'), { recursive: true })
  fs.writeFileSync(path.join(root, 'reference', 'NOTES.html'), '')
  fs.writeFileSync(path.join(root, 'progress.json'), '{"learned":[]}')
  fs.writeFileSync(path.join(root, 'starmap', 'content.js'), contentJs(lessons))
  fs.mkdirSync(path.join(root, 'lessons', 'math', 'alge'), { recursive: true })
  fs.mkdirSync(path.join(root, 'lessons', 'src', 'math', 'alge'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lessons', 'math', 'halo.json'),
    JSON.stringify({ halo: 'math', name: '数学', center: '', inside: [], outside: [] }))
  fs.writeFileSync(path.join(root, 'lessons', 'math', 'alge', 'point.json'),
    JSON.stringify({ point: 'alge', name: '代数', label: '代数', fileBase: 0 }))
  for (const [rel, body] of Object.entries(built)) fs.writeFileSync(path.join(root, ...rel.split('/')), body)
  for (const [rel, body] of Object.entries(srcFiles)) fs.writeFileSync(path.join(root, ...rel.split('/')), body)
  return root
}

const HREF_0001 = 'lessons/math/alge/0001-algebra-basics.html'
const rootHealthy = shadow('healthy', {
  lessons: [lesson('alge/0001', 1, '代数基础', HREF_0001)],
  built: { [HREF_0001]: builtPage(false) },
  srcFiles: { 'lessons/src/math/alge/0001-algebra-basics.html': srcPage(1, '代数基础') },
})
const rootA = shadow('repro1-page-deadlink', {
  lessons: [lesson('alge/0001', 1, '代数基础', HREF_0001)],
  built: { [HREF_0001]: builtPage(true) },
  srcFiles: { 'lessons/src/math/alge/0001-algebra-basics.html': srcPage(1, '代数基础') },
})
const rootB = shadow('repro2-artifact-missing', {
  lessons: [lesson('alge/0007', 7, 'x-z', 'lessons/math/alge/x-z.html')],
  built: {},
  srcFiles: { 'lessons/src/math/alge/x-z.html': srcPage(7, 'x-z') },
})

/* ── 两侧观察口：插件 = 真调 auditPack(readPack())；包侧 = 真跑 tools/starmap.test.mjs ── */
const pluginSide = (root) => auditPack(root, readPack(root)).findings

const packSide = (root) => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'starmap.test.mjs')],
    { cwd: root, encoding: 'utf8', timeout: 120000 })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const line = out.split(/\r?\n/).find((l) => l.includes('每门课的 href 都指向真实文件'))
  if (!line) return { seen: false, clean: null, entries: [], line: null }  // 组没了/没跑到 ⇒ 一律红
  const m = /（死链：(.+)）/.exec(line)
  return { seen: true, clean: line.includes('✅'), entries: m ? m[1].split(', ') : [], line: line.trim() }
}

/** 真包里本套碰过的文件的哈希（只该被读） */
const hashReal = () => {
  const out = []
  for (const rel of ['tools/starmap.test.mjs', 'tools/galaxy-shapes.cjs', 'tools/plan-map.js',
    'starmap/content.js', 'starmap/main.js', 'progress.json']) {
    const p = path.join(PACK, ...rel.split('/'))
    out.push(rel + ':' + (fs.existsSync(p)
      ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)
      : '<缺>'))
  }
  return out.join('|')
}

const realBefore = hashReal()
const observed = new Map()
try {
  for (const [key, root] of [
    ['健康基线（两边都该是 ∅）', rootHealthy],
    ['复现①（页内死链）', rootA],
    ['复现②（产物没建）', rootB],
  ]) {
    observed.set(key, { plug: pluginSide(root), pack: packSide(root) })
  }
  const get = (key) => observed.get(key)

  /* ── 0. 观察口与夹具的健全性（防"看错行 = 永远绿"）────────────────────── */
  ok([...observed.values()].every((o) => o.pack.seen),
    '包侧那组的输出三个夹具里都真被看到了（行文「每门课的 href 都指向真实文件」；看不到了 = 口径变了，重新裁定）')
  ok(path.resolve(tmp).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()),
    `夹具全在 os.tmpdir() 的影副本里（${path.basename(tmp)}）—— 真包只被读`)

  /* ── 1. 健康基线：两边必须同时 ∅（任何一边报了 = 没登记的裸漂移）────────── */
  const healthy = get('健康基线（两边都该是 ∅）')
  ok(healthy.plug.length === 0,
    `健康基线：插件侧 0 条（实际 ${healthy.plug.length}：${j(healthy.plug.map((f) => f.id))}）`)
  ok(healthy.pack.clean === true,
    `健康基线：包侧【死链】组干净（实际：${healthy.pack.line}）`)
  ok(healthy.plug.length === 0 && healthy.pack.clean === true,
    '没有未登记的差异（裸漂移）：健康夹具上两边必须同时是 ∅ —— 任何一边报了就是没登记的差异')

  /* ── 2. 复现① 双方实况：插件报 X（带行号）且 包侧不报 Y ───────────────── */
  const a = get('复现①（页内死链）')
  const deadA = a.plug.filter((f) => f.id === 'dead-link')
  ok(deadA.length === 1 && deadA[0].message.includes('nope.html'),
    `复现①插件侧实况：恰好 1 条 dead-link 指向 nope.html（实际 ${deadA.length} 条${deadA.length ? '：' + j(deadA[0].message) : ''}）`)
  ok(deadA.length === 1 && deadA[0].line === 6 && deadA[0].file === HREF_0001,
    `复现①插件侧实况：带行号且指得准（file=${HREF_0001}、line=6；实际 ${deadA.length ? 'file=' + deadA[0].file + ' line=' + j(deadA[0].line) : '无'}）`)
  ok(a.pack.clean === true,
    `复现①包侧实况：【死链】组不报（它只查 content.js 的 href 存在性；实际：${a.pack.line}）`)

  /* ── 3. 复现② 双方实况：包侧报 Y 且 插件不报 X ────────────────────────── */
  const b = get('复现②（产物没建）')
  ok(b.pack.clean === false && b.pack.entries.some((e) => e.includes('alge/0007') && e.includes('lessons/math/alge/x-z.html')),
    `复现②包侧实况：报「alge/0007→lessons/math/alge/x-z.html」（实际：${j(b.pack.entries)}）`)
  ok(b.plug.length === 0,
    `复现②插件侧实况：0 条（NNNN-*.html 过滤器把 x-z.html 挡在课程清单外；实际 ${b.plug.length}：${j(b.plug.map((f) => f.id))}）`)

  /* ── 4. 豁免表反向核账：登记的差异必须真存在（双方实况逐边钉住）────────── */
  for (const e of EXEMPT) {
    const o = get(e.key)
    ok(!!o && e.plugIs(o) && e.packIs(o),
      `豁免 ${e.id} 仍成立（${e.case}：插件 ${e.插件}；包侧 ${e.包侧}）—— 两边行为变了就重新裁定这行`)
  }
  ok(EXEMPT.every((e) => observed.has(e.key)),
    '豁免表每行都能对上一个真跑出来的用例（不许有悬空的登记行）')

  /* ── 5. 真包一个字节没动 ─────────────────────────────────────────────── */
  ok(hashReal() === realBefore, '真包（tools/、starmap/、progress.json 的哈希）一个字节没动')
  ok(fs.existsSync(path.join(PACK, 'presets', 'whale-sensei.css')), '真包仍在原地（课程包根没被写坏）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 死链/缺产物互补对拍：两个最小复现都钉成「已知且有意」，双方实况逐边断言，真包一字节没动')
