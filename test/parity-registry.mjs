#!/usr/bin/env node
/**
 * test/parity-registry.mjs —— 「同源实现 ↔ 对拍」登记表的机械校验（§5）
 * ------------------------------------------------------------------
 * 登记表 = 课程包 `_plugin-prep/同源实现-对拍登记表.md`（规矩与限制都写在那儿）。
 * 本判据逐行核三件事，任何一件不成立就红：
 *
 *   ① 两个实现文件都在（A 在课程包侧、B 在插件侧）；
 *   ② 对拍落点存在；
 *   ③ **那条对拍真的在跑** —— 落点是插件套件 → 必须在 `test/run-all.mjs` 的套件表里；
 *      落点是课程包脚本 → 必须在 `tools/gate.mjs` 的检查表里；
 *      落点是 `--selftest` 命令行 → **由本判据当场跑一遍**并核退出码 0。
 *
 * 为什么要有「③ 真的在跑」：2026-09-22 摸出来 `lib/pack-model.js --selftest`（课次映射表的对拍）
 * **当时没有任何套件在跑它** —— 表里写着有对拍、实际没人跑，正是这个项目一直在消灭的那种账。
 *
 * 附带：`MIRROR-OF: <对方文件>` 标记 —— 声明成镜像却没登记 → 红（见登记表「能与不能」那节）。
 *
 * 反空转（自带）：伪造一行指向不存在的落点 → 校验必须报出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packRoot, PLUGIN } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACK = packRoot()
const REGISTRY = path.join(PACK, '_plugin-prep', '同源实现-对拍登记表.md')

let pass = 0
const fails = []
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ' + msg) } else { fails.push(msg); console.log(` FAIL ${msg}`) } }

/** 从登记表里抓出数据行：[A, B, 落点]（只认三列的表格行，且首列以 包: 或 插件: 开头） */
export function parseRegistry(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^\|\s*(包|插件):/.test(line)) continue
    const cells = line.split('|').map((s) => s.trim()).filter((s, i, a) => !(i === 0 || i === a.length - 1))
    if (cells.length < 3) continue
    rows.push({ a: cells[0], b: cells[1], test: cells[2] })
  }
  return rows
}

const resolveSide = (ref) => {
  const m = /^(包|插件):(.+)$/.exec(String(ref).trim())
  if (!m) return null
  const root = m[1] === '包' ? PACK : PLUGIN
  const rest = m[2].trim()
  // 允许 `插件:lib/pack-model.js --selftest` 这种"文件 + 参数"写法
  const file = rest.split(/\s+/)[0]
  return { side: m[1], file, abs: path.join(root, file), rest }
}

/**
 * 逐行核。抽成纯函数是为了让反空转能在同一份实现上跑伪造数据。
 * @returns {string[]} 问题列表（空 = 全过）
 */
export function checkRegistry(rows, opts = {}) {
  const problems = []
  const pack = opts.pack ?? PACK
  const plugin = opts.plugin ?? PLUGIN
  const runAll = fs.existsSync(path.join(plugin, 'test', 'run-all.mjs')) ? fs.readFileSync(path.join(plugin, 'test', 'run-all.mjs'), 'utf8') : ''
  const gate = fs.existsSync(path.join(pack, 'tools', 'gate.mjs')) ? fs.readFileSync(path.join(pack, 'tools', 'gate.mjs'), 'utf8') : ''
  const runCmd = opts.runCmd ?? ((file, extra) => spawnSync(process.execPath, [file, ...extra], { cwd: plugin, encoding: 'utf8', timeout: 120_000 }))

  if (!rows.length) problems.push('登记表里一行数据都没有 —— 要么表被写坏，要么规矩被绕过了')

  for (const row of rows) {
    const label = `${row.a} ↔ ${row.b}`
    const A = resolveSide(row.a)
    const B = resolveSide(row.b)
    if (!A || !B) { problems.push(`${label}：左右两侧的写法必须是 包:<路径> / 插件:<路径>`); continue }
    for (const side of [A, B]) {
      if (!fs.existsSync(side.abs)) problems.push(`${label}：找不到 ${side.side}:${side.file}`)
    }

    const T = resolveSide(row.test)
    if (!T) { problems.push(`${label}：对拍落点必须写成 包:<路径> / 插件:<路径>`); continue }
    if (!fs.existsSync(T.abs)) { problems.push(`${label}：对拍落点不存在 → ${T.side}:${T.file}`); continue }

    if (T.rest.includes('--selftest')) {
      // 命令行自检：当场跑，核退出码（这样"真的在跑"不是一句声明）
      const r = runCmd(T.abs, ['--selftest', pack])
      if (r.status !== 0) problems.push(`${label}：${T.side}:${T.file} --selftest 退出码 ${r.status}（对拍没跑通）`)
    } else if (T.side === '插件') {
      const name = path.basename(T.file).replace(/\.mjs$/, '')
      if (!runAll.includes(`'${name}'`)) problems.push(`${label}：对拍 ${T.file} 不在 test/run-all.mjs 的套件表里 → 没人跑它`)
    } else {
      const rel = path.relative(pack, T.abs).split(path.sep).join('/')
      if (!gate.includes(rel)) problems.push(`${label}：对拍 ${rel} 不在 tools/gate.mjs 的检查表里 → 没人跑它`)
    }
  }
  return problems
}

/** `MIRROR-OF:` 标记扫两个仓：声明成镜像却没登记 → 报出来 */
export function checkMirrorMarkers(rows, opts = {}) {
  const pack = opts.pack ?? PACK
  const plugin = opts.plugin ?? PLUGIN
  const registered = new Set()
  for (const r of rows) {
    for (const ref of [r.a, r.b]) {
      const s = resolveSide(ref)
      if (s) registered.add(s.abs)
    }
  }
  const problems = []
  const scan = (root, label) => {
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        if (!/\.(mjs|js|cjs)$/.test(e.name)) continue
        let text = ''
        try { text = fs.readFileSync(p, 'utf8') } catch { continue }
        const m = /MIRROR-OF:\s*(\S+)/.exec(text)
        if (!m) continue
        if (!registered.has(p)) problems.push(`${label} ${path.relative(root, p)} 声明了 MIRROR-OF（${m[1]}）但没登记进对拍表`)
      }
    }
  }
  scan(path.join(pack, 'tools'), '包侧')
  scan(path.join(plugin, 'lib'), '插件侧')
  return problems
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */
console.log(`\n[parity-registry] 课程包：${PACK}`)

if (!fs.existsSync(REGISTRY)) {
  console.log(` FAIL 找不到登记表 ${REGISTRY}`)
  console.log('\n=== 0 通过 / 1 失败 ===')
  process.exit(1)
}
const text = fs.readFileSync(REGISTRY, 'utf8')
const rows = parseRegistry(text)
ok(rows.length >= 4, `登记表里解析到 ${rows.length} 对同源实现`)

const problems = checkRegistry(rows)
ok(problems.length === 0, `每一对：两个实现文件都在 / 落点存在 / **落点真的在跑**${problems.length ? '（' + problems.slice(0, 4).join('；') + '）' : ''}`)

const markerProblems = checkMirrorMarkers(rows)
ok(markerProblems.length === 0, `MIRROR-OF 标记都被登记过${markerProblems.length ? '（' + markerProblems.slice(0, 3).join('；') + '）' : ''}`)

/* ── 反空转：伪造一行，校验必须报出来 ─────────────────────────────────── */
{
  const fake = [...rows, { a: '包:tools/build-lessons.js', b: '插件:lib/render.js', test: '插件:test/this-file-does-not-exist.mjs' }]
  const fakeProblems = checkRegistry(fake)
  ok(fakeProblems.some((p) => /对拍落点不存在/.test(p)),
    `反空转：伪造一行指向不存在的落点 → 判据捕获（${fakeProblems.filter((p) => /不存在/.test(p)).length} 条）`)

  // 反空转 2：把一条**存在的**落点挂到不跑的套件上 → 「没人跑它」必须报出来
  const orphan = [...rows, { a: '包:tools/pack-text.js', b: '插件:lib/text.js', test: '插件:test/_pack.mjs' }]
  const orphanProblems = checkRegistry(orphan)
  ok(orphanProblems.some((p) => /没人跑它/.test(p)),
    `反空转：落点文件存在但不在套件表里 → 判据说"没人跑它"（${orphanProblems.filter((p) => /没人跑它/.test(p)).length} 条）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 同源实现对拍：每对的两个实现都在、落点存在且**真的在跑**')
