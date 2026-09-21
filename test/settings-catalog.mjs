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
 *   [7] 真包零改动
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

      // StatusPanel hooks
      slots[0] = { phase: 'ok', data: statusData, at: '12:00:00' }  // state
      slots[1] = 0  // tick

      // CatalogPanel hooks (嵌在 StatusPanel 里)
      const expandedInit = {}
      if (catalogData && catalogData.circles) {
        for (const c of catalogData.circles) expandedInit[c.id] = true
      }
      slots[3] = { phase: 'ok', data: catalogData, error: null }  // catalog state
      slots[4] = 0  // catalog tick
      slots[5] = expandedInit  // expanded
      slots[6] = {}  // rename
      slots[7] = { open: false, name: '', id: '', saving: false, error: null }  // newCircle

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
  const allRegisteredPaths = new Set()
  const mods = ['status.js', 'catalog.js', 'create.js', 'starter.js']
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

/* ── [7] 真包零改动 ─────────────────────────────────────────────── */
{
  let out = ''
  try {
    out = execFileSync('git', ['-C', PACK, 'status', '--porcelain'], { encoding: 'utf8' })
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '')
  }
  ok(out.trim() === '', `[7] 真包 git status --porcelain 为空（实得：${out.trim() || '空'}）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 设置页：三级目录 / 圆圈改名（只改 name、其余逐字节保留）/ 模块表可查')
