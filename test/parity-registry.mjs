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
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packRoot, PLUGIN } from './_pack.mjs'
import { templatePaths } from './pack-template-rules.mjs'

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

/** 从源文件里抓出 `MIRROR-OF:` 声明的目标 —— 支持**单行多目标**（逗号分隔）。 */
export function mirrorTargets(text) {
  const out = []
  for (const m of String(text).matchAll(/MIRROR-OF:\s*([^\n*（(]+)/g)) {
    for (const t of m[1].split(',')) {
      const s = t.trim()
      if (s) out.push(s)
    }
  }
  return out
}

/**
 * 「已登记」集合 = 登记表两侧的文件 ∪ **随包模板副本**（`FROM_PACK` 等）。
 * 为什么并入后者：模板副本由 `test/pack-scaffold.mjs` 逐字节钉着（`sanitize(原件) === 模板`），
 * 只是台账换了地方 —— 它们**大多不在登记表任何一行**，不并进来就会"一打标签就红"。
 */
export function registeredSet(rows, opts = {}) {
  const pack = opts.pack ?? PACK
  const plugin = opts.plugin ?? PLUGIN
  const set = new Set()
  for (const r of rows) {
    for (const ref of [r.a, r.b]) {
      const s = resolveSide(ref)
      if (s) set.add(s.abs)
    }
  }
  for (const rel of (opts.templatePaths ?? [])) {
    set.add(path.join(pack, rel))
    set.add(path.join(plugin, 'lib', 'pack-template', rel))
  }
  return set
}

/** 扫描时跳过的目录名（冻结副本与工作目录都不该进判据） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'skill-draft', '_p0', '_recon', '_starmap-proto', '_plugin-prep'])

/**
 * `MIRROR-OF:` 标记扫**三个根**（包 `tools/` · 包 `assets/` · 插件 `lib/`），核两件事：
 *   ① 声明成镜像却**它自己没登记** → 报出来；
 *   ② 声明的**每个目标**都得在登记表里出现 → 否则报出来。
 * ② 是「互补对绝不打标签」的**机器保障**：给互补对打标签时，目标不是镜像、登记表里没有它，当场红。
 */
export function checkMirrorMarkers(rows, opts = {}) {
  const pack = opts.pack ?? PACK
  const plugin = opts.plugin ?? PLUGIN
  const registered = opts.registered ?? registeredSet(rows, opts)
  // 标记的目标写的是**仓根相对路径**，而插件侧模板副本指向的可能是**同仓**的主实现
  // （`lib/pack-template/tools/plan-map.js` → `lib/plan.js`）⇒ 两侧仓根都收进"合法目标"集合。
  const registeredRels = new Set()
  for (const abs of registered) {
    for (const root of [pack, plugin]) {
      const r = path.relative(root, abs)
      if (r && !r.startsWith('..')) registeredRels.add(r.split(path.sep).join('/'))
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
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        if (!/\.(mjs|js|cjs)$/.test(e.name)) continue
        let text = ''
        try { text = fs.readFileSync(p, 'utf8') } catch { continue }
        const targets = mirrorTargets(text)
        if (!targets.length) continue
        const rel = path.relative(root, p).split(path.sep).join('/')
        if (!registered.has(p)) {
          problems.push(`${label} ${rel} 声明了 MIRROR-OF（${targets.join(', ')}）但**它自己**没登记进对拍表`)
        }
        for (const t of targets) {
          if (!registeredRels.has(t)) {
            problems.push(`${label} ${rel} 声明的目标 ${t} 不在登记表里 → 要么补一行登记，要么这个标签是假的`)
          }
        }
      }
    }
  }
  scan(path.join(pack, 'tools'), '包侧')
  scan(path.join(pack, 'assets'), '包侧')
  scan(path.join(plugin, 'lib'), '插件侧')
  return problems
}

/**
 * 己2：自动发现「**既没登记、也没声明**」的新镜像。
 *
 * **确定性信号（红）**：两个目录里**同相对路径 + 同内容**（模板件先按 `sanitizeText` 中性化再比）
 * 的文件对，且两侧都不在「已登记」集合里 —— 这就是"悄悄长出来、没人管的镜像"。
 * **启发式信号（黄，不红）**：同相对路径、内容不同、两侧都没登记 —— 只打印提醒，
 * 因为登记表 L127 自己写着「算不算同源是判断，不可机械判」。
 */
export function discoverMirrors(opts = {}) {
  const registered = opts.registered ?? new Set()
  const sanitize = opts.sanitize ?? ((_rel, text) => text)
  const red = []
  const yellow = []
  const dirPairs = opts.dirPairs ?? [
    [path.join(opts.plugin ?? PLUGIN, 'lib', 'pack-template'), opts.pack ?? PACK, '随包模板'],
  ]
  for (const [leftRoot, rightRoot, label] of dirPairs) {
    const stack = ['']
    while (stack.length) {
      const rel = stack.pop()
      const leftDir = rel ? path.join(leftRoot, rel) : leftRoot
      let entries = []
      try { entries = fs.readdirSync(leftDir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { stack.push(childRel); continue }
        if (!/\.(mjs|js|cjs)$/.test(e.name)) continue
        const left = path.join(leftRoot, childRel)
        const right = path.join(rightRoot, childRel)
        if (!fs.existsSync(right)) continue
        if (registered.has(left) || registered.has(right)) continue
        let same = false
        try {
          same = sanitize(childRel, fs.readFileSync(left, 'utf8')) === sanitize(childRel, fs.readFileSync(right, 'utf8'))
        } catch { continue }
        if (same) red.push(`${label}：${childRel} 两侧同源，却**既没登记也没声明** —— 补登记行 + 打 MIRROR-OF 标签`)
        else yellow.push(`${label}：${childRel} 同名但内容不同（可能同源实现、也可能只是重名）—— 交人判`)
      }
    }
  }
  return { red, yellow }
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

// 「已登记」= 登记表两侧 ∪ 随包模板副本（后者由 pack-scaffold 逐字节钉着，只是台账换了地方）
const tplPaths = templatePaths()
const registered = registeredSet(rows, { templatePaths: tplPaths })
ok(tplPaths.length > 0, `随包模板副本清单读到 ${tplPaths.length} 件（并进「已登记」集合）`)

const markerProblems = checkMirrorMarkers(rows, { registered })
ok(markerProblems.length === 0, `MIRROR-OF 标记：自己登记过、且每个目标都在表里${markerProblems.length ? '（' + markerProblems.slice(0, 3).join('；') + '）' : ''}`)

// 己2：自动发现「既没登记、也没声明」的新镜像（确定性信号红、启发式只出黄清单）
const found = discoverMirrors({ registered })
ok(found.red.length === 0, `己2 自动发现：没有"既没登记也没声明"的新镜像${found.red.length ? '（' + found.red.slice(0, 3).join('；') + '）' : ''}`)
if (found.yellow.length) {
  console.log(`  ℹ 黄清单 ${found.yellow.length} 条（同名不同内容，只提示不判红）：`)
  for (const y of found.yellow.slice(0, 6)) console.log('    · ' + y)
}

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

/* ── 己2 反空转：造一对「没登记也没声明」的同名同字节文件 → 必须报出来 ────────── */
{
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mirror-a-'))
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mirror-b-'))
  try {
    fs.mkdirSync(path.join(tmpA, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(tmpB, 'tools'), { recursive: true })
    fs.writeFileSync(path.join(tmpA, 'tools', 'fake-mirror.js'), 'export const x = 1\n', 'utf8')
    fs.writeFileSync(path.join(tmpB, 'tools', 'fake-mirror.js'), 'export const x = 1\n', 'utf8')
    const bare = discoverMirrors({ registered: new Set(), dirPairs: [[tmpA, tmpB, '夹具']] })
    ok(bare.red.length === 1 && /fake-mirror\.js/.test(bare.red[0]),
      `己2 反空转：一对同名同字节、没登记没声明的镜像 → 判据报出来（${bare.red.length} 条）`)
    const half = discoverMirrors({ registered: new Set([path.join(tmpA, 'tools', 'fake-mirror.js')]), dirPairs: [[tmpA, tmpB, '夹具']] })
    ok(half.red.length === 0, `己2 反空转：已登记的那一对**不误报**（${half.red.length} 条）`)
  } finally {
    fs.rmSync(tmpA, { recursive: true, force: true })
    fs.rmSync(tmpB, { recursive: true, force: true })
  }
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 同源实现对拍：每对的两个实现都在、落点存在且**真的在跑**')
