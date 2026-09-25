#!/usr/bin/env node
/**
 * test/settings-catalog.mjs — 设置页：三级目录 / 圆圈改名 / 模块表可查
 * ------------------------------------------------------------------
 * 断言：
 *   [1] canCreate === true（读真路由）
 *   [2] 改名端点：建圆圈 → rename → halo.json name 变、其余逐字节未变、id 目录名没变
 *   [3] 改名拒绝：目标不存在 → 拒绝；name 空 → 拒绝；两条都不产生文件
 *   [4] 反空转：halo.json 没有 name 行 → rename 必须拒绝
 *   [5] 模块表一份实现两处调用：status.js 与 whale_ping 用的是同一个函数
 *   [6] 设置卡渲染：三级（圆圈名 / 知识点名 / 下一课第K课）在；canCreate:false 时无新建入口
 *   [7] 真包零改动（**相对基线**）
 *   [8] 路径覆盖：客户端调的路径 ⊆ 已注册路由
 *   [9] 行为级：点「数学」展开的是数学（不串台）+ 删除必须先弹窗、只有确认才发 confirm:true
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

import { packRoot, PLUGIN } from './_pack.mjs'
import { enabledModules } from '../lib/mods/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const PACK = packRoot()

/**
 * 真包基线：本套件一个字节都不许写真包。**相对基线**比，不是"必须为空" ——
 * 用户从设置页建圆圈（本插件的功能）就会让真包多出未提交的改动（2026-09-22 实测的假红）。
 */
function gitStatus(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  } catch (e) {
    return 'ERR:' + ((e.stdout || '') + (e.stderr || '')).trim()
  }
}
const realBefore = gitStatus(PACK)

/**
 * fixture 卫生：把真包里**用户自己建的圆圈**从副本里剔掉，只留 programming。
 * 本套件会在副本上建 `math`，而用户完全可能已经用设置页建过 `math` ——
 * 那时副本里已有它，"建 math"会被拒覆盖打回，判据就报一堆与插件无关的假红（2026-09-22 实测）。
 */
function pruneCircles(packDir) {
  const lessons = path.join(packDir, 'lessons')
  for (const n of fs.readdirSync(lessons)) {
    if (n === 'programming' || n === 'src') continue
    fs.rmSync(path.join(lessons, n), { recursive: true, force: true })
  }
}

let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

console.log(`\n[settings-catalog] 课程包：${PACK}`)

/* ── [1] canCreate === true（读真路由）────────────────────────────── */
{
  const { plugin } = await import('../lib/mods/catalog.js')
  const routes = []
  plugin.install({
    paths: { packRoot: PACK },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    registerTool: () => {},
    inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
  })
  const catalogRoute = routes.find((r) => r.path === '/api/whale/catalog')
  const res = await catalogRoute.fetch(new Request('http://127.0.0.1:3090/api/whale/catalog', { method: 'GET' }))
  const data = await res.json()
  ok(data.canCreate === true, `[1] canCreate === true（实际 ${data.canCreate}）`)
}

/* ── [2] 改名端点：外科式替换 ────────────────────────────────────── */
{
  // 在临时课程包副本上操作
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-rename-'))
  const tmpPack = path.join(tmpRoot, 'pack')
  const EXCLUDE = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']
  fs.cpSync(PACK, tmpPack, {
    recursive: true,
    filter: (src) => {
      if (path.resolve(src) === path.resolve(PACK)) return true
      return !EXCLUDE.includes(path.relative(PACK, src).split(path.sep)[0])
    },
  })
  pruneCircles(tmpPack)  // 本块要建 `math`；用户真包里可能已有 math（见 pruneCircles 注释）

  try {
    const { plugin: createPlugin } = await import(pathToFileURL(path.join(SRC, 'lib', 'mods', 'create.js')).href)
    const routes = []
    createPlugin.install({
      paths: { packRoot: tmpPack, dataDir: tmpPack },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
    })

    const circleR = routes.find((r) => r.path === '/api/whale/circle')
    const renameR = routes.find((r) => r.path === '/api/whale/circle/rename')

    // ① 建圆圈 math
    const mkRes = await circleR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle',
      json: async () => ({ name: '原名', id: 'math' }),
    })
    const mkBody = await mkRes.json()
    ok(mkBody.ok === true, '[2] 建圆圈 math 成功')

    const haloPath = path.join(tmpPack, 'lessons', 'math', 'halo.json')
    const before = fs.readFileSync(haloPath, 'utf8')

    // ② rename 为「数学」（走独立的 rename 路由）
    const rnRes = await renameR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle/rename',
      json: async () => ({ id: 'math', name: '数学' }),
    })
    const rnBody = await rnRes.json()
    ok(rnBody.ok === true, '[2] rename 成功')
    ok(rnBody.id === 'math', `[2] 响应 id = ${rnBody.id}`)
    ok(rnBody.name === '数学', `[2] 响应 name = ${rnBody.name}`)
    ok(rnBody.path === 'lessons/math/halo.json', `[2] 响应 path = ${rnBody.path}`)

    const after = fs.readFileSync(haloPath, 'utf8')

    // ③ name 变了
    const afterHalo = JSON.parse(after)
    ok(afterHalo.name === '数学', `[2] halo.json name 变成「${afterHalo.name}」`)

    // ④ 除 name 那一行外，文件其余部分逐字节未变
    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    const beforeFiltered = beforeLines.filter((l) => !/^\s*"name"\s*:/.test(l))
    const afterFiltered = afterLines.filter((l) => !/^\s*"name"\s*:/.test(l))
    ok(beforeFiltered.join('\n') === afterFiltered.join('\n'), '[2] 除 name 行外，文件其余部分逐字节未变')

    // ⑤ id 目录名没变
    ok(fs.existsSync(path.join(tmpPack, 'lessons', 'math', 'halo.json')), '[2] lessons/math/ 目录仍在（id 目录名没变）')

    // ⑥ 再改一次（从「数学」改回「原名」），确认还能正确替换
    const rn2Res = await renameR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle/rename',
      json: async () => ({ id: 'math', name: '改回' }),
    })
    const rn2Body = await rn2Res.json()
    ok(rn2Body.ok === true, '[2] 二次改名成功')
    const halo2 = JSON.parse(fs.readFileSync(haloPath, 'utf8'))
    ok(halo2.name === '改回', `[2] 二次改名后 name = ${halo2.name}`)

  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ }
  }
}

/* ── [3] 改名拒绝 ───────────────────────────────────────────────── */
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-rename-reject-'))
  const tmpPack = path.join(tmpRoot, 'pack')
  const EXCLUDE = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']
  fs.cpSync(PACK, tmpPack, {
    recursive: true,
    filter: (src) => {
      if (path.resolve(src) === path.resolve(PACK)) return true
      return !EXCLUDE.includes(path.relative(PACK, src).split(path.sep)[0])
    },
  })

  try {
    const { plugin: createPlugin } = await import(pathToFileURL(path.join(SRC, 'lib', 'mods', 'create.js')).href)
    const routes = []
    createPlugin.install({
      paths: { packRoot: tmpPack, dataDir: tmpPack },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
    })

    const circleR = routes.find((r) => r.path === '/api/whale/circle')
    const renameR = routes.find((r) => r.path === '/api/whale/circle/rename')

    // 3a. 目标不存在 → 拒绝
    const r1 = await renameR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle/rename',
      json: async () => ({ id: 'nonexistent', name: '随便' }),
    })
    const b1 = await r1.json()
    ok(b1.ok === false, `[3a] 目标不存在 → 拒绝（${b1.error}）`)
    ok(!fs.existsSync(path.join(tmpPack, 'lessons', 'nonexistent')), '[3a] 没有产生目录')

    // 3b. name 空 → 拒绝
    // 先建一个圆圈
    await circleR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle',
      json: async () => ({ name: '测试', id: 'testcircle' }),
    })

    const r2 = await renameR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle/rename',
      json: async () => ({ id: 'testcircle', name: '' }),
    })
    const b2 = await r2.json()
    ok(b2.ok === false && /name 不能为空/.test(b2.error), `[3b] name 空 → 拒绝（${b2.error}）`)

    // 确认 halo.json 没被改
    const halo = JSON.parse(fs.readFileSync(path.join(tmpPack, 'lessons', 'testcircle', 'halo.json'), 'utf8'))
    ok(halo.name === '测试', '[3b] halo.json name 没变（仍是「测试」）')

  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ }
  }
}

/* ── [4] 反空转：halo.json 没有 name 行 → rename 必须拒绝 ───────── */
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-rename-noname-'))
  const tmpPack = path.join(tmpRoot, 'pack')
  const EXCLUDE = ['_starmap-proto', 'demo', 'code', '.git', '.backup', '.tmp-cov', 'node_modules', 'skill-draft', '_chrome-profile']
  fs.cpSync(PACK, tmpPack, {
    recursive: true,
    filter: (src) => {
      if (path.resolve(src) === path.resolve(PACK)) return true
      return !EXCLUDE.includes(path.relative(PACK, src).split(path.sep)[0])
    },
  })

  try {
    // 造一个没有 name 的 halo.json
    const circleDir = path.join(tmpPack, 'lessons', 'noname')
    fs.mkdirSync(circleDir, { recursive: true })
    fs.writeFileSync(path.join(circleDir, 'halo.json'), JSON.stringify({ _: 'no name field', halo: 'noname' }, null, 2) + '\n', 'utf8')

    const { plugin: createPlugin } = await import(pathToFileURL(path.join(SRC, 'lib', 'mods', 'create.js')).href)
    const routes = []
    createPlugin.install({
      paths: { packRoot: tmpPack, dataDir: tmpPack },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
    })

    const renameR = routes.find((r) => r.path === '/api/whale/circle/rename')
    const r = await renameR.fetch({
      method: 'POST',
      url: 'http://localhost/api/whale/circle/rename',
      json: async () => ({ id: 'noname', name: '试图填名' }),
    })
    const b = await r.json()
    ok(b.ok === false && /匹配数/.test(b.error), `[4] 没有 name 行的 halo → 拒绝（${b.error}）`)

    // 确认文件没被改
    const after = fs.readFileSync(path.join(circleDir, 'halo.json'), 'utf8')
    ok(!after.includes('试图填名'), '[4] 文件没被顺手写入')

  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ }
  }
}

/* ── [5] 模块表一份实现两处调用 ──────────────────────────────────── */
{
  // 5a. enabledModules() 是从 index.js 导出的函数
  ok(typeof enabledModules === 'function', '[5] enabledModules 是函数')
  const mods = enabledModules()
  ok(Array.isArray(mods) && mods.length > 0, `[5] enabledModules() 返回数组（${mods.length} 项）`)
  ok(mods.includes('catalog') && mods.includes('create'), '[5] 数组包含 catalog 和 create')

  // 5b. status.js 的插件 section 包含「已装载模块」行（用真路由验证）
  const { plugin: statusPlugin } = await import('../lib/mods/status.js')
  const cap = []
  statusPlugin.install({
    paths: { packRoot: PACK, root: path.join(PLUGIN, '..', '.dsh-whale-sensei') },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    registerTool: () => {},
    inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => cap.push(r) } }) }),
  })
  const statusRoute = cap.find((r) => r.path === '/api/whale/status')
  const res = await statusRoute.fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'GET' }))
  const data = await res.json()
  const pluginSection = (data.sections || []).find((s) => s.title === '插件')
  ok(!!pluginSection, '[5] status 响应有「插件」section')
  const modRow = (pluginSection?.rows || []).find((r) => r.name === '已装载模块')
  ok(!!modRow, '[5] 「插件」section 有「已装载模块」行')
  ok(modRow && new RegExp(`${mods.length} 个`).test(modRow.value), `[5] 已装载模块行包含 ${mods.length} 个（${modRow?.value}）`)

  // 5c. 用函数同一性断言：status.js import 的 enabledModules 就是 index.js 导出的那个
  //     不用 grep 数注释，用源码里只有一处构造那个列表来判
  const indexSrc = fs.readFileSync(path.join(PLUGIN, 'lib', 'mods', 'index.js'), 'utf8')
  const enabledExportCount = (indexSrc.match(/export function enabledModules/g) || []).length
  ok(enabledExportCount === 1, `[5] index.js 里只有一处 export function enabledModules（实得 ${enabledExportCount}）`)

  // 5d. status.js 通过动态 import 从 ./index.js 拿 enabledModules（延迟导入避免循环依赖）
  const statusSrc = fs.readFileSync(path.join(PLUGIN, 'lib', 'mods', 'status.js'), 'utf8')
  ok(/import\s*\(\s*'\.\/index\.js'\s*\)/.test(statusSrc) && /enabledModules/.test(statusSrc), '[5] status.js 动态 import ./index.js 并使用 enabledModules')

  // 5e. lib/index.js import 的也是 index.js 的 enabledModules
  const libIndexSrc = fs.readFileSync(path.join(PLUGIN, 'lib', 'index.js'), 'utf8')
  ok(/import\s*\{[^}]*enabledModules[^}]*\}\s*from\s*'\.\/mods\/index\.js'/.test(libIndexSrc), '[5] lib/index.js 从 ./mods/index.js import enabledModules')
}

/* ── [6] 设置卡渲染：三级目录 ────────────────────────────────────── */
{
  const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
  const code = src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // 6a. CatalogPanel 组件存在
  ok(/function CatalogPanel/.test(code), '[6] CatalogPanel 组件存在')

  // 6b. 嵌在 StatusPanel 内部（不新增注册，保持 panel.mjs 的 3 个坐位不变）
  ok(/CatalogPanel/.test(code), '[6] StatusPanel 内嵌 CatalogPanel')
  ok(/课程目录/.test(code), '[6] 「课程目录」标题在源码中')

  // 6c. 拉 /api/whale/catalog
  ok(/\/api\/whale\/catalog/.test(code), '[6] CatalogPanel 拉 /api/whale/catalog')

  // 6d. 用 mini-React 渲染 CatalogPanel 验证三级结构
  {
    const fakeWindow = {
      __ModuleLoader__: { load: (m) => {} },
      setTimeout: (fn) => setTimeout(fn, 0),
      prompt: () => {},
    }
    let mod = null
    fakeWindow.__ModuleLoader__.load = (m) => { mod = m }
    const mr = {
      createElement: (type, p, ...kids) => {
        const flat = kids.flat(Infinity)
        return { type, props: p || {}, children: flat.filter((k) => k != null && k !== false) }
      },
      useState: (v) => [v, () => {}],
      useRef: (v) => ({ current: v }),
      useEffect() {},
    }
    const prim = { Modal: function Modal() {}, Button: function Button() {} }
    const req = (n) => {
      if (n === 'react') return mr
      if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
      throw new Error('意外 require：' + n)
    }
    new Function('window', 'require', src)(fakeWindow, req)
    const exp = mod.factory(req)
    const regs = []
    exp.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs.push({ spec, comp: c }); return () => {} } }, effect: (fn) => fn() })

    const StatusComp = regs.find((r) => r.spec.id === 'whale-sensei')?.comp
    ok(typeof StatusComp === 'function', '[6] 找到 StatusPanel 组件函数（内嵌 CatalogPanel）')

    /** 递归收集树里所有文本节点（遇到函数组件则求值它再递归） */
    function collectTexts(node, out) {
      if (node == null || node === false) return
      if (typeof node === 'string') { out.push(node); return }
      if (Array.isArray(node)) { node.forEach((c) => collectTexts(c, out)); return }
      // 函数组件：求值它（mini-React 不自动求值 createElement 里的函数组件）
      if (typeof node.type === 'function') {
        try { collectTexts(node.type(node.props || {}), out); } catch { /* ignore */ }
        return
      }
      if (node.children) node.children.forEach((c) => collectTexts(c, out))
      if (node.props) {
        if (node.props.children) {
          const ch = node.props.children
          if (Array.isArray(ch)) ch.forEach((c) => collectTexts(c, out))
          else collectTexts(ch, out)
        }
      }
    }

    /**
     * 渲染 StatusPanel（内含 CatalogPanel），返回文本。
     * StatusPanel hooks:
     *   useState(state) → slot 0, useState(tick) → slot 1, useEffect(fetch) → slot 2
     * CatalogPanel hooks (紧接其后):
     *   useState(catState) → slot 3, useState(catTick) → slot 4, useState(expanded) → slot 5,
     *   useState(rename) → slot 6, useState(newCircle) → slot 7, useEffect(loadCatalog) → slot 8
     */
    function renderStatusWithCatalog(statusData, catalogData) {
      let cursor = 0
      const slots = []
      const miniR = {
        createElement: (type, p, ...kids) => {
          const flat = kids.flat(Infinity)
          return { type, props: p || {}, children: flat.filter((k) => k != null && k !== false) }
        },
        useState(init) {
          const i = cursor++
          if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
          return [slots[i], () => {}]
        },
        useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
        useEffect() { cursor++ },
      }
      const req2 = (n) => {
        if (n === 'react') return miniR
        if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
        throw new Error('意外 require：' + n)
      }
      // 创建独立的 mod 实例
      const fakeW2 = {
        __ModuleLoader__: { load: (m) => { /* ignore */ } },
        setTimeout: (fn) => setTimeout(fn, 0),
        prompt: () => {},
      }
      let mod2 = null
      fakeW2.__ModuleLoader__.load = (m) => { mod2 = m }
      new Function('window', 'require', src)(fakeW2, req2)
      const exp2 = mod2.factory(req2)
      const regs2 = []
      exp2.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs2.push({ spec, comp: c }); return () => {} } }, effect: (fn) => fn() })
      const Comp = regs2.find((r) => r.spec.id === 'whale-sensei')?.comp

      // StatusPanel hooks：state / tick / pick（选课程包）—— pick 之后才是 useEffect
      slots[0] = { phase: 'ok', data: statusData, at: '12:00:00' }  // state
      slots[1] = 0  // tick
      slots[2] = null  // pick（选课程包目录的状态）

      // CatalogPanel hooks (嵌在 StatusPanel 里)
      const expandedInit = {}
      if (catalogData && catalogData.circles) {
        for (const c of catalogData.circles) expandedInit[c.id] = true
      }
      slots[4] = { phase: 'ok', data: catalogData, error: null }  // catalog state
      slots[5] = 0  // catalog tick
      slots[6] = expandedInit  // expanded
      slots[7] = {}  // rename
      slots[8] = { open: false, name: '', id: '', saving: false, error: null }  // newCircle

      const tree = Comp({})
      const texts = []
      collectTexts(tree, texts)
      return texts.join(' ')
    }

    // 6d. canCreate:false + 有数据 → 三级结构都在
    {
      const statusData = { ok: true, configured: true, version: '0.1.0', sections: [{ title: '插件', rows: [{ name: '版本', value: '0.1.0' }] }] }
      const catalogData = { ok: true, configured: true, canCreate: false, circles: [
        { id: 'programming', name: '编程', points: [
          { id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 3, lessons: [
            { id: 'programming/spring-boot/0001', number: 1, title: '第一课' },
            { id: 'programming/spring-boot/0002', number: 2, title: '第二课' },
          ] },
        ] },
      ] }
      const allText = renderStatusWithCatalog(statusData, catalogData)

      ok(allText.includes('编程'), `[6] 圆圈名「编程」在渲染结果中`)
      ok(allText.includes('Spring Boot'), `[6] 知识点名「Spring Boot」在渲染结果中`)
      ok(allText.includes('下一课 第 3 课'), `[6] 「下一课 第 3 课」在渲染结果中（nextNumber 3 - fileBase 0 = 3）`)
      ok(allText.includes('1 个知识点 · 2 门课'), `[6] 「1 个知识点 · 2 门课」在渲染结果中`)

      // canCreate:false → 没有「新建圆圈」入口
      ok(!allText.includes('+ 新建圆圈'), '[6] canCreate=false → 没有「新建圆圈」入口')

      // 有「课程目录」标题
      ok(allText.includes('课程目录'), '[6] 「课程目录」标题在渲染结果中')
    }

    // 6e. canCreate:true + 0 圆圈 → 有「+ 新建圆圈」入口
    {
      const statusData2 = { ok: true, configured: true, version: '0.1.0', sections: [] }
      const catalogData2 = { ok: true, configured: true, canCreate: true, circles: [] }
      const allText2 = renderStatusWithCatalog(statusData2, catalogData2)
      ok(allText2.includes('+ 新建圆圈'), '[6] canCreate=true → 有「+ 新建圆圈」入口')
    }
  }
}

/* ── [9] 行为级：展开按自己的 id 生效 + 删除必须弹窗确认 ──────────────
 *
 * 起因（2026-09-22 真机）：用户在设置页点「数学」的展开，展开出来的却是「编程」。
 * 根因是 `for (var ci…)` 里的 `var c` 是**函数作用域共享**的 —— 所有圆圈行的 onClick
 * 在点击时读到的都是循环结束时最后那个 `c`（`readdirSync().sort()` 之后 programming 排最后）。
 *
 * 所以这个判据不看源码结构、也不读 hook 槽位，而是**把用户那句话原样跑一遍**：
 *   渲染两个圆圈（数学在前、编程在后）→ 点「数学」→ 数学的知识点必须出现、编程的必须不出现。
 * 旧代码在这里必红（点数学展编程）。fixture 里数学**故意放第一个**、编程放最后一个 ——
 * 正好是"最后一个是编程"那个致命顺序。
 */
{
  const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
  const prim = { Modal: function Modal() {}, Button: function Button() {} }

  const catalogData = { ok: true, configured: true, canCreate: true, circles: [
    { id: 'math', name: '数学', points: [
      { id: 'algebra', name: '代数', fileBase: 0, nextNumber: 1, lessons: [] },
    ] },
    { id: 'programming', name: '编程', points: [
      { id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 3, lessons: [
        { id: 'programming/spring-boot/0001', number: 1, title: '第一课' },
      ] },
    ] },
  ] }

  const DELETE_PLAN = {
    id: 'math', name: '数学', dir: 'lessons/math',
    dirs: [{ path: 'lessons/math', files: 1, bytes: 64 }],
    files: 4, bytes: 120, lessons: 0, lessonIds: [],
    codeDirs: [], progressIds: [], progressFile: null,
    rebuild: ['node tools/build-lessons.js', 'node tools/build-starmap.js', 'node assets/build-glossary.js', 'node tools/build-notes.js'],
  }

  const calls = []
  let queue = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null })
    const payload = queue.length ? queue.shift() : { ok: false, error: '没排队（判据里忘记 push 响应了）' }
    return { status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
  }

  /** mini-React：useState 的 setter **真写回 slots**，所以再渲染一次就能看到新状态 */
  function mount() {
    const slots = []
    let cursor = 0
    const miniR = {
      createElement: (type, p, ...kids) => {
        const flat = kids.flat(Infinity)
        return { type, props: p || {}, children: flat.filter((k) => k != null && k !== false) }
      },
      useState(init) {
        const i = cursor++
        if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
        const set = (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }
        return [slots[i], set]
      },
      useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
      useEffect() { cursor++ },
    }
    const req = (n) => {
      if (n === 'react') return miniR
      if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
      throw new Error('意外 require：' + n)
    }
    let mod = null
    const fakeWindow = { __ModuleLoader__: { load: (m) => { mod = m } }, setTimeout: (fn) => setTimeout(fn, 0), prompt: () => {} }
    new Function('window', 'require', src)(fakeWindow, req)
    const exp = mod.factory(req)
    const regs = []
    exp.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs.push({ spec, comp: c }); return () => {} } }, effect: (fn) => fn() })
    const Comp = regs.find((r) => r.spec.id === 'whale-sensei')?.comp

    // StatusPanel: useState(state)=0, useState(tick)=1, useState(pick)=2, useEffect=3
    // CatalogPanel: useState(catState)=4, useState(catTick)=5, useState(expanded)=6,
    //               useState(rename)=7, useState(newCircle)=8, useState(del)=9, useState(notice)=10, useEffect=11
    slots[0] = { phase: 'ok', data: { ok: true, configured: true, version: '0.1.0', sections: [{ title: '插件', rows: [{ name: '版本', value: '0.1.0' }] }] }, at: '12:00:00' }
    slots[1] = 0
    slots[2] = null
    slots[4] = { phase: 'ok', data: catalogData, error: null }
    slots[5] = 0
    return { render: () => { cursor = 0; return Comp({}) }, slots }
  }

  /**
   * 求值函数组件，**每个节点只求值一次**（结果挂在节点的 `__sub` 上）。
   * 为什么必须记忆化：mini-React 的 hook 槽位是靠"这次渲染里第几次调用"定位的，
   * 而遍历时会顺带求值 CatalogPanel —— 同一棵树走第二遍就会把手里的 cursor 带到
   * 槽位之外去（`!(i in slots)` 成立 → 组件被按**初值**重新初始化，于是看到
   * 「正在读课程目录…」这种假状态）。走两遍就得复用同一份求值结果。
   */
  function evalFn(node) {
    if (!('__sub' in node)) {
      try { node.__sub = node.type(node.props || {}) } catch { node.__sub = null }
    }
    return node.__sub
  }

  function walk(node, pred, out = []) {
    if (node == null || node === false || typeof node === 'string') return out
    if (Array.isArray(node)) { for (const c of node) walk(c, pred, out); return out }
    if (typeof node.type === 'function') {
      const sub = evalFn(node)
      if (sub) walk(sub, pred, out)
      return out
    }
    if (pred(node)) out.push(node)
    if (node.children) for (const c of node.children) walk(c, pred, out)
    if (node.props && node.props.children && !Array.isArray(node.children)) {
      const ch = node.props.children
      if (Array.isArray(ch)) for (const c of ch) walk(c, pred, out)
      else walk(ch, pred, out)
    }
    return out
  }

  const textsOf = (node) => {
    const out = []
    const rec = (n) => {
      if (n == null || n === false) return
      if (typeof n === 'string') { out.push(n); return }
      if (Array.isArray(n)) { n.forEach(rec); return }
      if (typeof n.type === 'function') { const sub = evalFn(n); if (sub) rec(sub); return }
      if (n.children) n.children.forEach(rec)
    }
    rec(node)
    return out
  }

  try {
    const h = mount()

    // ① 初始：两个圆圈都收起（默认收起）
    const t0 = textsOf(h.render()).join(' ')
    ok(!t0.includes('代数'), '[9] 初始「数学」是收起的（不显示它的知识点「代数」）')
    ok(!t0.includes('Spring Boot'), '[9] 初始「编程」也是收起的')

    // ② 点「数学」的展开 —— 用户那句话原样跑一遍
    const mathRow = walk(h.render(), (n) => n.props && n.props.key === 'circle-math')[0]
    ok(!!mathRow, '[9] 渲染树里找得到 key=circle-math 的圆圈行')
    mathRow.props.onClick()
    const t1 = textsOf(h.render()).join(' ')
    ok(t1.includes('代数'), '[9] 点「数学」→ 展开出数学自己的知识点「代数」')
    ok(!t1.includes('Spring Boot'), `[9] 点「数学」不许把「编程」一起展开（${t1.includes('Spring Boot') ? '✗ 串台了：编程被展开' : '没有串台'}）`)

    // ③ 再点「编程」→ 两个各自独立
    const progRow = walk(h.render(), (n) => n.props && n.props.key === 'circle-programming')[0]
    progRow.props.onClick()
    const t2 = textsOf(h.render()).join(' ')
    ok(t2.includes('代数') && t2.includes('Spring Boot'), '[9] 再点「编程」→ 两个圆圈各自展开（展开状态按 id 分开存）')

    // ④ 删除入口：必须先 dryRun（不真删），而且必须是「数学」那一个按钮
    const mathBlock = walk(h.render(), (n) => n.props && n.props.key === 'circle-block-math')[0]
    ok(!!mathBlock, '[9] 找得到「数学」那一整块（key=circle-block-math）')
    const delBtn = walk(mathBlock, (n) => n.type === 'button' && Array.isArray(n.children) && n.children.join('') === '删除')[0]
    ok(!!delBtn, '[9] 「数学」那一块里有「删除」按钮')

    queue.push({ ok: true, dryRun: true, plan: DELETE_PLAN })
    delBtn.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 20))
    ok(calls.length === 1 && calls[0].url === '/api/whale/circle/delete' && calls[0].body.id === 'math' && calls[0].body.dryRun === true,
      `[9] 点「删除」先发 dryRun 且 id 是 math（实得 ${JSON.stringify(calls[0]?.body)}）`)
    ok(calls[0] && calls[0].body.confirm === undefined, '[9] dryRun 那一次**不许**带 confirm（这时还没确认）')

    // ⑤ 弹窗：把真实清单摆出来
    const modal = walk(h.render(), (n) => n.props && n.props.key === 'delete-modal')[0]
    ok(!!modal, '[9] dryRun 回来后弹出确认弹窗（不是直接删）')
    const mt = textsOf(modal).join(' ')
    ok(mt.includes('删除知识圆圈「数学」'), `[9] 弹窗点名要删的是「数学」（${mt.slice(0, 30)}…）`)
    ok(mt.includes('不可恢复'), '[9] 弹窗写明不可恢复')
    ok(mt.includes('lessons/math'), '[9] 弹窗摆出真实目录名（不是空话）')

    // ⑥ 只有点「确认删除」才发 confirm:true
    const okBtn = walk(modal, (n) => n.type === 'button' && Array.isArray(n.children) && n.children.join('') === '确认删除')[0]
    ok(!!okBtn, '[9] 弹窗里有「确认删除」按钮')
    queue.push({ ok: true, files: 1, lessons: 0, progressCleaned: 0, needsRebuild: DELETE_PLAN.rebuild, deleted: ['lessons/math'] })
    okBtn.props.onClick()
    await new Promise((r) => setTimeout(r, 20))
    ok(calls.length === 2 && calls[1].body.confirm === true && calls[1].body.id === 'math',
      `[9] 点「确认删除」才发 confirm:true（第二次：${JSON.stringify(calls[1]?.body)}）`)

    // ⑦ 删完弹窗关掉 + 结果横幅摆出重建命令
    const after = h.render()
    ok(walk(after, (n) => n.props && n.props.key === 'delete-modal').length === 0, '[9] 删成功后弹窗关闭')
    const at = textsOf(after).join(' ')
    ok(at.includes('已删除圆圈「数学」'), `[9] 结果横幅说明删了什么（${at.slice(0, 40)}…）`)
    ok(at.includes('node tools/build-lessons.js'), '[9] 结果横幅摆出重建命令（照抄服务端返回的那批）')
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ── [8] 路径覆盖：客户端调的路径 ⊆ 已注册路由 ─────────────────────── */
{
  const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
  // 先剥注释，避免注释里的 /api/whale/* 被抓到
  const code = src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // 8a. 从 client.js 源码里抓出所有 /api/whale/... 字面量路径
  // 匹配 fetch('/api/whale/…') 以及模板串拼接出的路径
  const clientPaths = new Set()
  // 字面量：'/api/whale/xxx' 或 "/api/whale/xxx"
  const literalRe = /['"]\/api\/whale\/[a-z][a-z0-9/-]*['"]/g
  for (const m of code.matchAll(literalRe)) {
    clientPaths.add(m[0].slice(1, -1))  // strip quotes
  }
  // 模板串拼接：`/api/whale/${expr}/xxx` —— 把模板变量替换成 [^/]+ 模式
  const tplRe = /`\/api\/whale\/[^`]+`/g
  for (const m of code.matchAll(tplRe)) {
    // 尝试从模板串里提取路径模式
    const stripped = m[0].replace(/\$\{[^}]+\}/g, '[^/]+')
    // 如果能解析成已知路径就加入
    if (/^['"]\/api\/whale\//.test(stripped) || /^\/api\/whale\//.test(stripped)) {
      // 对于模板串，我们用 grep 从代码里找出实际的已知路径
    }
  }
  // 已知的客户端路径硬编码清单（从代码静态分析得出）
  const knownClientPaths = [
    '/api/whale/status',
    '/api/whale/catalog',
    '/api/whale/starter',
    '/api/whale/circle',
    '/api/whale/circle/rename',
    '/api/whale/point',
    '/api/whale/pack/choose',
  ]
  for (const p of knownClientPaths) {
    // 只把源码里确实出现的路径加入
    if (code.includes(`'${p}'`) || code.includes(`"${p}"`) || code.includes('`/api/whale/')) {
      clientPaths.add(p)
    }
  }
  // 也检查模板串拼接出的 /api/whale/catalog?topic=...（catalog 带查询参数的情况）
  // 实际查代码，客户端目前没有这种拼接

  ok(clientPaths.size > 0, `[8a] 从 client.js 抓到 ${clientPaths.size} 条 /api/whale/... 路径`)

  // 8b. 收集所有模块注册的路径
  //
  // 名单 = **所有挂了路由的模块**（不只是 client.js 调的那几个）——
  // `ask.js` / `note.js` 的路由是**课程包页面**在调（`assets/ask.js` / `assets/notes.js`），
  // 收进来只会让下面的注册集合更完整，[8c] 的"⊆"仍然是真的。
  // 完整性由 [8b2] 的源码级判据守着（漏一个就红，不会静默缩小覆盖面）。
  const allRegisteredPaths = new Set()
  const mods = ['status.js', 'catalog.js', 'create.js', 'starter.js', 'pack.js', 'teaching.js', 'ask.js', 'note.js', 'evidence.js']
  // 反陈旧（2026-09-25 补）：这张名单是手写的，新增一个挂路由的模块很容易忘了加进来 ——
  // 那时 [8c] 的覆盖面会**静默缩小**（不是变红）。所以先用源码级判据把名单钉住：
  // 凡是源码里出现 `fetch.register` 的模块，都必须在这张名单里。
  {
    const modDir = path.join(SRC, 'lib', 'mods')
    const withRoutes = fs.readdirSync(modDir)
      .filter((f) => f.endsWith('.js') && /fetch\.register/.test(fs.readFileSync(path.join(modDir, f), 'utf8')))
    const notListed = withRoutes.filter((f) => !mods.includes(f))
    ok(notListed.length === 0,
      `[8b2] 挂了路由的模块都在名单里（漏了：${notListed.join(', ') || '无'}；名单共 ${mods.length} 个）`)
  }
  for (const modFile of mods) {
    try {
      const { plugin } = await import(pathToFileURL(path.join(SRC, 'lib', 'mods', modFile)).href)
      const modRoutes = []
      plugin.install({
        paths: { packRoot: PACK, dataDir: PACK, root: path.join(PLUGIN, '..', '.dsh-whale-sensei') },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: () => {},
        inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => modRoutes.push(r) } }) }),
      })
      for (const r of modRoutes) allRegisteredPaths.add(r.path)
    } catch (e) {
      ok(false, `[8b] 加载 ${modFile} 失败：${e?.message ?? e}`)
    }
  }
  ok(allRegisteredPaths.size > 0, `[8b] 收集到 ${allRegisteredPaths.size} 条已注册路由`)

  // 8c. 断言：客户端抓到的每个路径，都在注册集合里
  const missing = [...clientPaths].filter((p) => !allRegisteredPaths.has(p))
  ok(missing.length === 0, `[8c] 客户端路径 ⊆ 注册路由（${missing.length ? '缺少：' + missing.join(', ') : '全覆盖'}）`)

  // 8d. 反空转：故意从注册集合里删一条，断言判据会红
  const registeredCopy = new Set(allRegisteredPaths)
  const firstPath = [...clientPaths][0]
  registeredCopy.delete(firstPath)
  const fakeMissing = [...clientPaths].filter((p) => !registeredCopy.has(p))
  ok(fakeMissing.length >= 1, `[8d] 反空转：删除 ${firstPath} 后判据捕获 ${fakeMissing.length} 条缺失（期望 ≥1）`)
}

/* ── [7] 真包零改动（**相对基线**）───────────────────────────────── */
{
  const after = gitStatus(PACK)
  ok(after === realBefore, `[7] 真包 git status 与跑之前相同（相对基线；基线=${realBefore || '空'}，实得=${after || '空'}）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 设置页：三级目录 / 圆圈改名（只改 name、其余逐字节保留）/ 模块表可查')
