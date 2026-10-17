/**
 * test/audit/T19.mjs — 四个可见课程行的导出请求分别指向自身课程（卡 T19 / 报告 E01）
 * ------------------------------------------------------------------
 * 病（旧行为，报告 E01 · lib/client.js#L1245-L1262）：
 *   「课程目录」的课程行是**就地**写在
 *     `for (var li = 0; li < lessons.length; li++) { var lesson = lessons[li]; … }`
 *   循环里的，`onClick: function (e) { e.stopPropagation(); doExport(lesson); }`
 *   捕的是**同一个** `var lesson` —— 循环结束后每一行的按钮都指向**最后一课**：
 *   四个导出按钮导出同一门课。
 *
 * 本文件判的就是卡面那一句（逐字）：
 *   「两点各两课，四个按钮逐一点击，请求 file 必须各自对应可见行，不能只断言"有导出按钮"。」
 *
 * 怎么判（**真行为**，不是源码关键字）：
 *   · 假基座 + mini-React **真加载** `lib/client.js`（形状照 test/panel.mjs:213-219 /
 *     test/settings-catalog.mjs:314-337：`new Function('window','require', src)` +
 *     `__ModuleLoader__.load` 收模块 + `factory(require).apply(ctx)`），真渲染出设置页
 *     「课程目录」那棵树；
 *   · **逐个真点**四个导出按钮（调用它自己的 `onClick`，传带 `stopPropagation` 的假事件，
 *     并断言 `stopPropagation` 真被调过）；
 *   · 请求体 `file` 的期望值**只由渲染出来的可见行文本**反推（`<课号>. <标题>` → file），
 *     全程不碰课程 id —— 并且反过来钉一句"file ≠ id"，让"只比 id"这条偷懒路走不通；
 *   · busy 态、重渲染之后再点，各判一遍；
 *   · **负向控制**：把实现改回"共享 var"的**临时副本**（E:/Temp 下，跑完核实绝对路径后清理）
 *     跑同一套行为检查 —— 必须红，且失败点正是"四行指向各自课程"。
 *
 * 固定用例 ID 全集（**不许漂移**）：
 *   load-client · client-format · render-course-tree · four-export-buttons · visible-title-to-file ·
 *   click-row-1..4 · stop-propagation-all · export-request-shape · four-files-distinct ·
 *   busy-row-text-and-disabled · busy-other-rows-unaffected · busy-guard-no-extra-request ·
 *   reredraw-still-own · negative-control-anchor · negative-control-red ·
 *   negative-control-failure-shape · negative-control-cleanup · main-repo-hash-unchanged · fixture-hygiene
 *
 * 验收命令：`node E:/workplace/dsh-whale-sensei/test/audit/T19.mjs`
 *   成功 → `PASS T19 checks=22 failed=0 skipped=0` exit0；失败 → `FAIL T19 …` exit1。
 * 铁律：主仓 `lib/client.js` 只读（跑完哈希必须不变）；夹具全在 E:/Temp；
 *      不碰真课程包 E:/workplace/study，不跑全量（全量归规划者独占）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createHarness, REPO, clip, makeTempDir, cleanupTempDir } from './harness.mjs'

/* ───────────────────────── 固定用例 ID 全集 ───────────────────────── */
const IDS = [
  'load-client',
  'client-format',
  'render-course-tree',
  'four-export-buttons',
  'visible-title-to-file',
  'click-row-1', 'click-row-2', 'click-row-3', 'click-row-4',
  'stop-propagation-all',
  'export-request-shape',
  'four-files-distinct',
  'busy-row-text-and-disabled',
  'busy-other-rows-unaffected',
  'busy-guard-no-extra-request',
  'reredraw-still-own',
  'negative-control-anchor',
  'negative-control-red',
  'negative-control-failure-shape',
  'negative-control-cleanup',
  'main-repo-hash-unchanged',
  'fixture-hygiene',
]

const CLIENT = path.join(REPO, 'lib', 'client.js')
const EVIDENCE = path.join(REPO, 'audit-evidence', 'T19')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/* ───────────────────────── 夹具：两点各两课（共 4 行） ─────────────────────────
 * 课程 id 与课程 file 是**两个不同的串** —— 只有真读 lesson.file 才能得到请求体里那个值。
 */
const FIX_LESSONS = [
  { id: 'programming/alpha/0001', number: 1, title: '甲的入门课', file: 'lessons/programming/alpha/0001/index.html' },
  { id: 'programming/alpha/0002', number: 2, title: '甲的进阶课', file: 'lessons/programming/alpha/0002/index.html' },
  { id: 'programming/beta/0001', number: 1, title: '乙的入门课', file: 'lessons/programming/beta/0001/index.html' },
  { id: 'programming/beta/0002', number: 2, title: '乙的进阶课', file: 'lessons/programming/beta/0002/index.html' },
]
/** 可见行文本（`<课号>. <标题>`）→ 该课的 file。判据只认这张表，不认 id。 */
const VISIBLE_TO_FILE = Object.fromEntries(FIX_LESSONS.map((l) => [`${l.number}. ${l.title}`, l.file]))
/** 可见行文本 → 课程 id（**只用来反证"file ≠ id"**） */
const VISIBLE_TO_ID = Object.fromEntries(FIX_LESSONS.map((l) => [`${l.number}. ${l.title}`, l.id]))
const VISIBLE_ORDER = FIX_LESSONS.map((l) => `${l.number}. ${l.title}`)
const EXPECTED_FILES = FIX_LESSONS.map((l) => l.file)

const CATALOG = {
  ok: true,
  configured: true,
  canCreate: false,
  circles: [{
    id: 'programming',
    name: '编程',
    points: [
      { id: 'programming/alpha', name: '甲点', fileBase: 0, nextNumber: 3, lessons: [FIX_LESSONS[0], FIX_LESSONS[1]] },
      { id: 'programming/beta', name: '乙点', fileBase: 0, nextNumber: 3, lessons: [FIX_LESSONS[2], FIX_LESSONS[3]] },
    ],
  }],
}

/* ───────────────────── 假基座 + mini-React（渲染级） ─────────────────────
 * 与既有 harness 同型（panel.mjs / settings-catalog.mjs），只多两件事：
 *   ① hook 槽位**按组件身份**存（WeakMap），嵌在 StatusPanel 里的 CatalogPanel 有自己的槽位，
 *      重渲染不会串台 —— 这样才敢"点一下 → 重渲染 → 再点"；
 *   ② 导出请求用**夹具自己控时序的 deferred**，于是「导出中…」那一帧真的能观察到。
 */
function createBench(src) {
  const asked = []
  const calls = []
  const unknownRoutes = []
  const pendingExports = []
  const effectErrors = []
  const clickLog = []
  let loadError = null
  let applyError = null
  let renderCount = 0
  let curTree = null
  let mod = null
  let exportsObj = null
  const regs = []

  const hookSlots = new WeakMap()
  const effects = []
  let curComp = null
  let cursor = 0
  let pending = false

  function slots() {
    let s = hookSlots.get(curComp)
    if (!s) { s = []; hookSlots.set(curComp, s) }
    return s
  }

  const miniReact = {
    createElement(type, p, ...kids) {
      const children = kids.flat(Infinity).filter((k) => k != null && k !== false)
      const props = p || {}
      if (typeof type === 'function') {
        // 函数组件在**它自己的** hook 上下文里就地求值。
        // ⚠️ children 只挂在**元素**上，不往 props 里塞 —— lib/client.js 的 Section 注释
        //    专门钉过这条（读 props.children 在判据里会被静默丢掉）。
        const pc = curComp
        const pk = cursor
        curComp = type
        cursor = 0
        try { return type(props) } finally { curComp = pc; cursor = pk }
      }
      return { type, props, children }
    },
    useState(init) {
      const s = slots()
      const i = cursor++
      if (!(i in s)) s[i] = typeof init === 'function' ? init() : init
      return [s[i], (v) => { s[i] = typeof v === 'function' ? v(s[i]) : v; pending = true }]
    },
    useRef(v) {
      const s = slots()
      const i = cursor++
      if (!(i in s)) s[i] = { current: v }
      return s[i]
    },
    useEffect(fn, deps) {
      const s = slots()
      const i = cursor++
      const prev = s[i]
      const changed = !prev || deps === undefined || !prev.deps
        || prev.deps.length !== deps.length || deps.some((d, k) => d !== prev.deps[k])
      s[i] = { deps }
      if (changed) effects.push(fn)
    },
  }

  const deferred = () => {
    let resolve = null
    let reject = null
    const promise = new Promise((a, b) => { resolve = a; reject = b })
    return { promise, resolve, reject }
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = function (url, init) {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    let body = null
    if (init && init.body) {
      try { body = JSON.parse(init.body) } catch (e) { body = { __unparsable: String(init.body) } }
    }
    const rec = { url: u, method, body, seq: calls.length }
    calls.push(rec)
    if (u === '/api/whale/pack/export') {
      // 导出：夹具自己控时序（不立刻 resolve）⇒「导出中…」那一帧可判、busy guard 可判
      const d = deferred()
      pendingExports.push({ rec, d })
      return Promise.resolve({ status: 200, json: () => d.promise })
    }
    let payload
    if (u.indexOf('/api/whale/status') === 0) {
      payload = { ok: true, configured: true, version: '0.0.0-t19', sections: [] }
    } else if (u.indexOf('/api/whale/catalog') === 0) {
      payload = CATALOG
    } else if (u.indexOf('/api/whale/teaching') === 0) {
      payload = { ok: true, configured: false, error: 'T19 夹具：本卡不测教学方式' }
    } else {
      unknownRoutes.push(method + ' ' + u)
      payload = { ok: false, error: 'T19 夹具没有这条假路由' }
    }
    return Promise.resolve({
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    })
  }

  const fakeWindow = {
    __ModuleLoader__: { load: (m) => { mod = m } },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (t) => clearTimeout(t),
    clearInterval: (t) => clearInterval(t),
    setInterval: (fn) => setInterval(fn, 0),
    prompt: () => {},
    open: () => {},
  }
  const primitives = { Modal: function Modal() {}, Button: function Button() {} }
  const req = (n) => {
    asked.push(n)
    if (n === 'react') return miniReact
    if (n === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('客户端 require 了没声明的包：' + n)
  }

  try { new Function('window', 'require', src)(fakeWindow, req) } catch (e) { loadError = e }

  if (!loadError && mod && typeof mod.factory === 'function') {
    try {
      exportsObj = mod.factory(req)
      exportsObj.apply({
        slots: {
          inject: (n, cb) => cb(),
          register: (spec, comp) => { regs.push({ spec, comp }); return () => {} },
        },
        effect: (fn) => fn(),
      })
    } catch (e) { applyError = e }
  }
  const settingsReg = regs.find((r) => r.spec && r.spec.name === 'settings.section' && r.spec.id === 'whale-sensei')
  const rootComp = settingsReg ? settingsReg.comp : null

  /* ——— 树上的最小查询器（只认渲染结果，函数组件已在 createElement 里求值完） ——— */
  function walk(node, visit) {
    if (node == null || node === false) return
    if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
    if (typeof node !== 'object') return
    visit(node)
    if (node.children) for (const c of node.children) walk(c, visit)
  }
  function textOf(node) {
    if (node == null || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (typeof node !== 'object') return ''
    return (node.children || []).map(textOf).join('')
  }
  function collect(tree, pred) {
    const out = []
    walk(tree, (n) => { if (pred(n)) out.push(n) })
    return out
  }
  function firstOf(node, pred) {
    let hit = null
    walk(node, (n) => { if (!hit && pred(n)) hit = n })
    return hit
  }
  const isExportButton = (n) => n.type === 'button' && (textOf(n) === '导出' || textOf(n) === '导出中…')

  /** 课程行 = 带导出按钮的那一行 `ws-treeRow`（知识点行没有按钮，天然不入选） */
  function rowsOf(tree) {
    return collect(tree, (n) => n.type === 'div' && n.props && n.props.className === 'ws-treeRow')
      .map((node) => {
        const btn = collect(node, isExportButton)[0] || null
        if (!btn) return null
        const nameSpan = firstOf(node, (m) => m.type === 'span' && m.props && m.props.className === 'ws-treeName')
        return {
          title: textOf(nameSpan),
          buttonText: textOf(btn),
          disabled: !!btn.props.disabled,
          kinds: btn.props.type,
          btn,
        }
      })
      .filter(Boolean)
  }
  /** 「课程目录」树里那个圆圈展开钮（靠 meta 里的「门课」与「知识组」卡的「个组」区分开） */
  const courseToggles = (tree) => collect(tree, (n) => n.type === 'button'
    && n.props && n.props.className === 'ws-groupToggle' && textOf(n).indexOf('门课') >= 0)
  const exportButtons = (tree) => collect(tree, isExportButton)

  const drain = () => new Promise((r) => setTimeout(r, 0))
  function renderOnce() {
    effects.length = 0
    const tree = miniReact.createElement(rootComp, {})
    const list = effects.slice()
    effects.length = 0
    for (const fn of list) {
      try { fn() } catch (e) { effectErrors.push(String((e && e.message) || e)) }
    }
    renderCount++
    return tree
  }
  /** 一直渲染到没有 pending 状态更新（每轮之间让 microtask/macrotask 都排干） */
  async function settle(maxRounds = 30) {
    pending = true
    for (let i = 0; i < maxRounds && pending; i++) {
      pending = false
      curTree = renderOnce()
      await drain()
    }
    return curTree
  }
  function fireClick(node, label) {
    const ev = {
      stopped: 0,
      stopPropagation() { ev.stopped++ },
      preventDefault() {},
      target: {},
      currentTarget: {},
    }
    let error = null
    try { node.props.onClick(ev) } catch (e) { error = e }
    const entry = { label, stopPropagationCalls: ev.stopped, error: error ? String((error && error.message) || error) : null }
    clickLog.push(entry)
    return entry
  }
  const restore = () => { globalThis.fetch = realFetch }

  return {
    get tree() { return curTree },
    get mod() { return mod },
    get exportsObj() { return exportsObj },
    get loadError() { return loadError },
    get applyError() { return applyError },
    get renderCount() { return renderCount },
    asked, calls, unknownRoutes, pendingExports, effectErrors, clickLog, regs,
    hasSettingsSection: !!rootComp,
    rootCompType: rootComp ? 'function' : null,
    factoryType: mod ? typeof mod.factory : null,
    applyType: exportsObj ? typeof exportsObj.apply : null,
    settle, fireClick, rowsOf, courseToggles, exportButtons, textOf, walk,
    restore,
  }
}

/* ───────────────────────── 正向：在真源码上跑一遍行为检查 ───────────────────────── */
async function runAgainst(src) {
  const bench = createBench(src)
  const out = {
    srcSha256: sha256(src),
    loadError: bench.loadError ? String((bench.loadError && bench.loadError.message) || bench.loadError) : null,
    applyError: bench.applyError ? String((bench.applyError && bench.applyError.message) || bench.applyError) : null,
    modId: bench.mod ? bench.mod.id : null,
    hasSettingsSection: bench.hasSettingsSection,
    rootCompType: bench.rootCompType,
    factoryType: bench.factoryType,
    applyType: bench.applyType,
    asked: bench.asked.slice(),
    renderCount: 0,
    toggleCount: 0,
    rowsAfterExpand: [],
    exportButtonCountAfterExpand: 0,
    clicks: [],
    busySnapshot: null,
    guardCallsDuringBusy: null,
    rerender: null,
    requestCountAfterClicks: 0,
    finalExportRequestCount: 0,
    finalRows: [],
    effectErrors: [],
    unknownRoutes: [],
    clickErrors: [],
    fatal: null,
  }
  try {
    if (out.loadError || out.applyError || !bench.hasSettingsSection) return out
    await bench.settle()

    const toggles = bench.courseToggles(bench.tree)
    out.toggleCount = toggles.length
    if (toggles.length) { bench.fireClick(toggles[0], 'expand-circle'); await bench.settle() }

    out.rowsAfterExpand = bench.rowsOf(bench.tree).map((r) => ({
      title: r.title, buttonText: r.buttonText, disabled: r.disabled, kinds: r.kinds,
    }))
    out.exportButtonCountAfterExpand = bench.exportButtons(bench.tree).length

    /* ——— 逐行真点：点 → 看 busy 那一帧 → 放行 → 记请求 ——— */
    for (let i = 1; i <= 4; i++) {
      const rowsNow = bench.rowsOf(bench.tree)
      if (rowsNow.length < i) { out.clicks.push({ row: i, missing: true }); break }
      const target = rowsNow[i - 1]
      const before = bench.calls.length
      const fired = bench.fireClick(target.btn, `row${i}`)
      if (fired.error) out.clickErrors.push(`row${i}: ${fired.error}`)
      await bench.settle()
      const after = bench.calls.slice(before)
      const exportCalls = after.filter((c) => c.url === '/api/whale/pack/export')
      const snapshot = bench.rowsOf(bench.tree).map((r) => ({ title: r.title, buttonText: r.buttonText, disabled: r.disabled }))

      if (i === 1) {
        out.busySnapshot = snapshot
        // busy 期间点**别的**行：doExport 的 busy guard 应当挡住（旧行为保留）
        const gBefore = bench.calls.length
        const other = bench.rowsOf(bench.tree)[1]
        if (other) bench.fireClick(other.btn, 'row2-during-busy')
        await bench.settle()
        out.guardCallsDuringBusy = bench.calls.length - gBefore
      }

      // 放行这次导出（夹具自己控时序）
      const pend = bench.pendingExports
      if (pend.length) pend[pend.length - 1].d.resolve({ ok: true, name: 'T19-fixture.zip', note: '已导出 T19-fixture.zip' })
      await bench.settle()

      out.clicks.push({
        row: i,
        title: target.title,
        buttonTextBefore: target.buttonText,
        disabledBefore: target.disabled,
        stopPropagationCalls: bench.clickLog[bench.clickLog.length - 1].stopPropagationCalls,
        firedError: fired.error,
        exportCalls: exportCalls.map((c) => ({
          url: c.url,
          method: c.method,
          body: c.body,
          bodyKeys: c.body && typeof c.body === 'object' ? Object.keys(c.body) : null,
        })),
        otherCalls: after.filter((c) => c.url !== '/api/whale/pack/export').map((c) => c.method + ' ' + c.url),
      })
    }
    out.requestCountAfterClicks = bench.calls.filter((c) => c.url === '/api/whale/pack/export').length

    /* ——— 重渲染之后再点：收起 → 展开（真状态变化）→ 再点第 3 行 ——— */
    const t2 = bench.courseToggles(bench.tree)
    if (t2.length) {
      bench.fireClick(t2[0], 'collapse')
      await bench.settle()
      const collapsedRows = bench.rowsOf(bench.tree).length
      const t3 = bench.courseToggles(bench.tree)
      bench.fireClick(t3[0], 'expand-again')
      await bench.settle()
      const rowsNow = bench.rowsOf(bench.tree)
      const target = rowsNow[2]
      if (!target) {
        out.rerender = { collapsedRows, missing: true }
      } else {
        const before = bench.calls.length
        const fired = bench.fireClick(target.btn, 'row3-after-rerender')
        if (fired.error) out.clickErrors.push(`row3-after-rerender: ${fired.error}`)
        await bench.settle()
        const after = bench.calls.slice(before).filter((c) => c.url === '/api/whale/pack/export')
        const pend = bench.pendingExports
        if (pend.length) pend[pend.length - 1].d.resolve({ ok: true, note: '已导出 T19-fixture.zip' })
        await bench.settle()
        out.rerender = {
          collapsedRows,
          title: target.title,
          stopPropagationCalls: bench.clickLog[bench.clickLog.length - 1].stopPropagationCalls,
          exportCalls: after.map((c) => ({
            url: c.url,
            method: c.method,
            body: c.body,
            bodyKeys: c.body && typeof c.body === 'object' ? Object.keys(c.body) : null,
          })),
        }
      }
    }

    out.finalExportRequestCount = bench.calls.filter((c) => c.url === '/api/whale/pack/export').length
    out.finalRows = bench.rowsOf(bench.tree).map((r) => ({ title: r.title, buttonText: r.buttonText, disabled: r.disabled }))
    out.renderCount = bench.renderCount
    out.effectErrors = bench.effectErrors.slice()
    out.unknownRoutes = bench.unknownRoutes.slice()
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  } finally {
    bench.restore()
  }
  return out
}

/* ─────────────────── 负向控制：临时副本改回「共享 var」 ───────────────────
 * 唯一锚点 = 循环里那句 `lessonKids.push(renderLessonRow(lessons[li]));`。
 * 找不到锚点 ⇒ 负向控制直接判红（**不许**静默变成"没得测所以算过"）。
 */
const LOOP_RE = /for \(var li = 0; li < lessons\.length; li\+\+\) \{\s*lessonKids\.push\(renderLessonRow\(lessons\[li\]\)\);\s*\}/

function mutateToSharedVar(src) {
  if (!LOOP_RE.test(src)) {
    return { ok: false, src: null, reason: '变异锚点找不到：循环里的 lessonKids.push(renderLessonRow(lessons[li]));' }
  }
  const legacy = [
    'for (var li = 0; li < lessons.length; li++) {',
    "\t\t\t\t\t\t\tvar lesson = lessons[li];",
    "\t\t\t\t\t\t\tlessonKids.push(react.createElement('div', {",
    "\t\t\t\t\t\t\t\tkey: 'lesson-' + lesson.id,",
    "\t\t\t\t\t\t\t\tclassName: 'ws-treeRow',",
    '\t\t\t\t\t\t\t},',
    "\t\t\t\t\t\t\t\treact.createElement('span', { className: 'ws-treeName' }, lesson.number + '. ' + lesson.title),",
    "\t\t\t\t\t\t\t\treact.createElement('span', { className: 'ws-spacer' }),",
    "\t\t\t\t\t\t\t\treact.createElement('div', { className: 'ws-rowActions' },",
    "\t\t\t\t\t\t\t\t\treact.createElement('button', {",
    "\t\t\t\t\t\t\t\t\t\ttype: 'button',",
    '\t\t\t\t\t\t\t\t\t\tdisabled: !!(exp && exp.busy),',
    "\t\t\t\t\t\t\t\t\t\tonClick: function (e) { e.stopPropagation(); doExport(lesson); },",
    "\t\t\t\t\t\t\t\t\t\tstyle: btn('ghost', 'sm'),",
    "\t\t\t\t\t\t\t\t\t}, exp && exp.busy === lesson.id ? '导出中…' : '导出'))));",
    '\t\t\t\t\t\t}',
  ].join('\n')
  const mutated = src.replace(LOOP_RE, legacy)
  return { ok: true, src: mutated, changed: mutated !== src, reason: null }
}

async function runNegativeControl(src) {
  const mut = mutateToSharedVar(src)
  const out = {
    anchorFound: mut.ok,
    anchorReason: mut.reason,
    mutatedHasSharedVar: mut.ok ? /var lesson = lessons\[li\]/.test(mut.src) && !LOOP_RE.test(mut.src) : false,
    tempDir: null,
    tempFile: null,
    tempUnderTempBase: false,
    removed: false,
    cleanupError: null,
    files: [],
    expected: EXPECTED_FILES.slice(),
    rowTitles: [],
    mismatches: [],
    allSameFile: null,
    target: null,
    runError: null,
  }
  if (!mut.ok) return out
  const dir = makeTempDir('dsh-whale-t19')
  out.tempDir = path.resolve(dir)
  out.tempUnderTempBase = out.tempDir.startsWith(path.resolve(os.tmpdir()) + path.sep)
  try {
    const libDir = path.join(out.tempDir, 'lib')
    fs.mkdirSync(libDir, { recursive: true })
    out.tempFile = path.resolve(path.join(libDir, 'client.js'))
    fs.writeFileSync(out.tempFile, mut.src, 'utf8')
    const neg = await runAgainst(mut.src)
    out.target = { loadError: neg.loadError, fatal: neg.fatal, toggleCount: neg.toggleCount }
    out.rowTitles = neg.clicks.map((c) => c.title)
    out.files = neg.clicks.map((c) => (c.exportCalls && c.exportCalls[0] ? c.exportCalls[0].body.file : null))
    out.mismatches = out.files
      .map((f, i) => (f === out.expected[i] ? null : { row: i + 1, got: f, want: out.expected[i] }))
      .filter(Boolean)
    out.allSameFile = new Set(out.files.filter(Boolean)).size === 1
  } catch (e) {
    out.runError = String((e && e.stack) || e)
  } finally {
    const c = cleanupTempDir(dir, 't19')
    out.removed = c.removed
    out.cleanupError = c.error
  }
  return out
}

/* ─────────────────────────────── 采集 ─────────────────────────────── */
const h = createHarness({ card: 'T19', expectedIds: IDS })

let fatal = null
let srcHashBefore = null
let srcHashAfterNegative = null
let srcHashAtEval = null
let pos = {}
let neg = {}

try {
  const src = fs.readFileSync(CLIENT, 'utf8')
  srcHashBefore = sha256(src)
  pos = await runAgainst(src)
  neg = await runNegativeControl(src)
  srcHashAfterNegative = sha256(fs.readFileSync(CLIENT))
  srcHashAtEval = srcHashAfterNegative
} catch (e) {
  fatal = e
}

/* 证据：原始采集结果（机器可读，无 BOM）+ 人读的一张表 */
try {
  h.evidenceJson('collected.json', { fatal: fatal ? String(fatal.stack || fatal) : null, srcHashBefore, srcHashAfterNegative, pos, neg })
  const lines = []
  lines.push('T19 原始采集（' + new Date().toISOString() + '）')
  lines.push('主仓 lib/client.js sha256 采集前：' + srcHashBefore)
  lines.push('主仓 lib/client.js sha256 负向控制后：' + srcHashAfterNegative)
  lines.push('')
  lines.push('── 渲染级事实 ──')
  lines.push(`loadError=${pos.loadError}  applyError=${pos.applyError}  modId=${pos.modId}  settingsSection=${pos.hasSettingsSection}`)
  lines.push(`asked(require)=${(pos.asked || []).join(', ')}  renderCount=${pos.renderCount}  unknownRoutes=${(pos.unknownRoutes || []).join(', ') || '（无）'}`)
  lines.push(`课程目录圆圈展开钮=${pos.toggleCount}  展开后课程行=${(pos.rowsAfterExpand || []).length}  导出按钮=${pos.exportButtonCountAfterExpand}`)
  lines.push('展开后的四行：')
  for (const r of pos.rowsAfterExpand || []) lines.push(`  「${r.title}」 按钮=${r.buttonText} disabled=${r.disabled}`)
  lines.push('')
  lines.push('── 四次逐行点击（真点 onClick，请求体 file 与可见行对齐） ──')
  for (const c of pos.clicks || []) {
    const call = (c.exportCalls || [])[0]
    const want = VISIBLE_TO_FILE[c.title]
    lines.push(`  行「${c.title}」（id=${VISIBLE_TO_ID[c.title]}） → ${call ? call.method + ' ' + call.url + ' body=' + JSON.stringify(call.body) : '（没发请求）'}`)
    lines.push(`      期望 file=${want}  对上=${call && call.body && call.body.file === want}  file≠id=${!!call && call.body.file !== VISIBLE_TO_ID[c.title]}  stopPropagation=${c.stopPropagationCalls}`)
  }
  lines.push('')
  lines.push('── busy 那一帧（第一行导出中、请求未放行时） ──')
  for (const r of pos.busySnapshot || []) lines.push(`  「${r.title}」 按钮=${r.buttonText} disabled=${r.disabled}`)
  lines.push(`busy 期间点别的行发出的请求数=${pos.guardCallsDuringBusy}（应为 0）`)
  lines.push('')
  lines.push('── 重渲染（收起→展开）后再点第 3 行 ──')
  lines.push('  ' + JSON.stringify(pos.rerender))
  lines.push('')
  lines.push('── 负向控制（临时副本：实现改回共享 var） ──')
  lines.push(`锚点找到=${neg.anchorFound}${neg.anchorReason ? '（' + neg.anchorReason + '）' : ''}  变异体含 var lesson=lessons[li]：${neg.mutatedHasSharedVar}`)
  lines.push(`夹具路径=${neg.tempFile}  在 E:/Temp 下=${neg.tempUnderTempBase}  清理=${neg.removed}${neg.cleanupError ? '（' + neg.cleanupError + '）' : ''}`)
  lines.push(`变异体四次点击得到的 file：${JSON.stringify(neg.files)}`)
  lines.push(`期望：${JSON.stringify(neg.expected)}`)
  lines.push(`对不上的行：${JSON.stringify(neg.mismatches)}  四处是否同一课=${neg.allSameFile}`)
  if (neg.runError) lines.push('变异体运行异常：' + neg.runError)
  if (pos.fatal) lines.push('正向采集致命错误：' + pos.fatal)
  if (fatal) lines.push('采集致命错误：' + String(fatal.stack || fatal))
  h.evidence('observed.txt', lines.join('\n') + '\n')
} catch (e) {
  process.stderr.write('证据落盘失败：' + String((e && e.message) || e) + '\n')
}

/* ─────────────────────────────── 判据 ─────────────────────────────── */
const C = (id, fn) => h.case(id, 'pass', () => {
  if (fatal) h.fail('采集阶段致命错误：' + String((fatal && fatal.stack) || fatal))
  fn()
})

C('load-client', () => {
  h.eq(pos.loadError, null, 'client.js 真加载不抛')
  h.eq(pos.applyError, null, 'apply(ctx) 不抛')
  h.eq(pos.modId, 'dsh-whale-sensei', '__ModuleLoader__.load 的 id 是包名')
  h.eq(pos.hasSettingsSection, true, '注册面里有 settings.section / whale-sensei')
  h.eq(pos.rootCompType, 'function', '拿到的是**组件函数**（不是现造的元素）')
})

C('client-format', () => {
  const bad = (pos.asked || []).filter((n) => n !== 'react' && n !== '@deepseek-ai/dsh-client-ui-primitives')
  h.eq((pos.asked || []).length > 0, true, '真加载时 require 过（asked 非空）')
  h.eq(bad.join(','), '', '只 require 冻结基座里的包（不给本卡加新依赖）')
  h.eq(pos.factoryType, 'function', '仍是 lazy-CJS 工厂：module.factory 是函数（没改成 ESM）')
  h.eq(pos.applyType, 'function', '仍导出 apply(ctx)')
})

C('render-course-tree', () => {
  h.eq(pos.toggleCount, 1, '「课程目录」树里恰好 1 个圆圈可展开（夹具 1 圆圈 / 2 知识点）')
  h.eq((pos.rowsAfterExpand || []).length, 4, '展开后渲染出 4 行课程')
  h.eq((pos.rowsAfterExpand || []).map((r) => r.title).join(' | '), VISIBLE_ORDER.join(' | '),
    '四行的可见行文本与夹具逐字对上（课号 + 标题）')
})

C('four-export-buttons', () => {
  h.eq(pos.exportButtonCountAfterExpand, 4, '展开后**恰好 4 个**导出按钮（不是「至少有一个」）')
  const kinds = (pos.rowsAfterExpand || []).map((r) => r.kinds).join(',')
  h.eq(kinds, 'button,button,button,button', '四个都是 type=button（保留原样）')
  const texts = (pos.rowsAfterExpand || []).map((r) => r.buttonText).join(',')
  h.eq(texts, '导出,导出,导出,导出', '四个按钮初始文案都是「导出」')
})

C('visible-title-to-file', () => {
  h.eq((pos.clicks || []).length, 4, '四次逐行点击都记到了')
  for (const c of pos.clicks) {
    const want = VISIBLE_TO_FILE[c.title]
    h.eq(!!want, true, `行「${c.title}」的**可见文本**能在夹具表里反推出 file（判据不认 id）`)
    const call = (c.exportCalls || [])[0]
    h.eq(call && call.body && call.body.file, want, `行「${c.title}」请求的就是它自己那一课`)
    h.eq(call && call.body && call.body.file !== VISIBLE_TO_ID[c.title], true,
      `自证：请求体不是拿 id 冒充的 file（${call && call.body && call.body.file} ≠ ${VISIBLE_TO_ID[c.title]}）`)
  }
})

const clickCase = (i) => () => {
  const c = (pos.clicks || [])[i - 1]
  h.eq(!!c && !c.missing, true, `第 ${i} 行的点击记录在`)
  h.eq(c.firedError, null, 'onClick 不抛')
  h.eq(c.stopPropagationCalls, 1, 'e.stopPropagation() 真被调过（恰好一次）')
  h.eq((c.exportCalls || []).length, 1, '点一下正好发一个导出请求')
  const call = c.exportCalls[0]
  h.eq(call.url, '/api/whale/pack/export', '请求打到 /api/whale/pack/export（端点没变）')
  h.eq(call.method, 'POST', 'POST（协议没变）')
  h.eq(call.bodyKeys.join(','), 'file', '请求体只有 file 这一个字段')
  h.eq(call.body.file, VISIBLE_TO_FILE[c.title], `file 指向可见行「${c.title}」那一课`)
  h.eq((c.otherCalls || []).length, 0, '那次点击没有顺带发别的请求')
}
C('click-row-1', clickCase(1))

C('click-row-2', clickCase(2))
C('click-row-3', clickCase(3))
C('click-row-4', clickCase(4))

C('stop-propagation-all', () => {
  const all = (pos.clicks || []).map((c) => c.stopPropagationCalls)
  h.eq(all.join(','), '1,1,1,1', '四次点击每次 stopPropagation 都被调过')
  h.eq(pos.rerender && pos.rerender.stopPropagationCalls, 1, '重渲染后再点的那次也调过')
})

C('export-request-shape', () => {
  const all = []
  for (const c of pos.clicks || []) for (const call of c.exportCalls || []) all.push(call)
  for (const call of (pos.rerender && pos.rerender.exportCalls) || []) all.push(call)
  h.eq(all.length, 5, '全程 5 个导出请求（4 次逐行 + 1 次重渲染后），一个不多一个不少')
  h.eq(all.every((c) => c.url === '/api/whale/pack/export').toString(), 'true', '每个都打在 /api/whale/pack/export')
  h.eq(all.every((c) => c.method === 'POST').toString(), 'true', '每个都是 POST')
  h.eq(all.every((c) => c.bodyKeys.length === 1 && c.bodyKeys[0] === 'file').toString(), 'true',
    '每个请求体都只有 file 字段（导出协议没动）')
  h.eq(all.every((c) => typeof c.body.file === 'string' && c.body.file.length > 0).toString(), 'true', 'file 都是非空字符串')
})

C('four-files-distinct', () => {
  const files = (pos.clicks || []).map((c) => ((c.exportCalls || [])[0] || {}).body).map((b) => (b ? b.file : null))
  h.eq(files.filter(Boolean).length, 4, '四次点击都记到了 file')
  h.eq(new Set(files).size, 4, '四个 file **两两不同**（共享 var 直接判死）')
  h.eq([...files].sort().join(' | '), EXPECTED_FILES.slice().sort().join(' | '), '四个 file 正是夹具那四门课')
})

C('busy-row-text-and-disabled', () => {
  const snap = pos.busySnapshot
  h.eq(Array.isArray(snap) && snap.length, 4, 'busy 那一帧快照有 4 行')
  h.eq(snap[0].title, VISIBLE_ORDER[0], 'busy 的是第一行')
  h.eq(snap[0].buttonText, '导出中…', '导出中的那一行文案是「导出中…」')
  h.eq(snap[0].disabled, true, '导出中的那一行 disabled')
})

C('busy-other-rows-unaffected', () => {
  const others = (pos.busySnapshot || []).slice(1)
  h.eq(others.map((r) => r.title).join(' | '), VISIBLE_ORDER.slice(1).join(' | '), '别的三行还是它们自己那三行')
  h.eq(others.map((r) => r.buttonText).join(','), '导出,导出,导出', '别的行文案不受影响（不是「导出中…」）')
})

C('busy-guard-no-extra-request', () => {
  h.eq(pos.guardCallsDuringBusy, 0, 'busy 期间点别的行**不发**新请求（保留 doExport 的 busy guard）')
  h.eq(pos.requestCountAfterClicks, 4, '四次逐行点击一共只有 4 个导出请求')
})

C('reredraw-still-own', () => {
  const rr = pos.rerender
  h.eq(!!rr, true, '重渲染（收起 → 再展开）之后拿到了新树')
  h.eq(rr.collapsedRows, 0, '收起时课程行确实不在（说明真的重渲染过，不是同一棵树）')
  h.eq(rr.title, VISIBLE_ORDER[2], '重渲染后点的是第 3 行')
  h.eq((rr.exportCalls || []).length, 1, '重渲染后再点一下，正好一个请求')
  h.eq(rr.exportCalls[0].body.file, VISIBLE_TO_FILE[rr.title], `重渲染后点「${rr.title}」仍指向它自己那一课`)
  h.eq(pos.finalExportRequestCount, 5, '收尾时导出请求总数 = 5（4 + 1）')
})

C('negative-control-anchor', () => {
  h.eq(neg.anchorFound, true, '负向控制能在**唯一锚点**上把实现改回共享 var'
    + (neg.anchorReason ? '（' + neg.anchorReason + '）' : ''))
  h.eq(neg.mutatedHasSharedVar, true, '变异体里确实回到 `var lesson = lessons[li]`（且锚点调用已消失）')
  h.eq(neg.tempUnderTempBase, true, `夹具落在 E:/Temp 下（${neg.tempFile}）`)
  h.eq(neg.target && neg.target.loadError, null, '变异体也能被假基座真加载起来（不是加载失败冒充的红）')
  h.eq(neg.target && neg.target.toggleCount, 1, '变异体也渲染出了同一棵树')
})

C('negative-control-red', () => {
  h.eq(neg.files.length, 4, '变异体上也真点了四个按钮')
  h.eq(neg.mismatches.length > 0, true, `共享 var 的变异体必须红（实得对不上的行数=${neg.mismatches.length}）`)
  h.eq(neg.allSameFile, true, '四处请求体指向的是同一课 —— 正是报告 E01 的形状')
})

C('negative-control-failure-shape', () => {
  const last = EXPECTED_FILES[EXPECTED_FILES.length - 1]
  h.eq(neg.files[0], last, '变异体里第一行也指向**最后一课**')
  h.eq(neg.files[3], last, '第四行（本来就对的那一行）也指向最后一课')
  h.eq(neg.mismatches.map((m) => m.row).join(','), '1,2,3', '失败点正是第 1/2/3 行 —— 就是"四行指向各自课程"这一条')
})

C('negative-control-cleanup', () => {
  h.eq(neg.removed, true, '临时副本清理成功' + (neg.cleanupError ? '（' + neg.cleanupError + '）' : ''))
  h.eq(neg.cleanupError, null, '清理没有报"拒绝清理/删不动"')
  h.eq(!!neg.tempDir && fs.existsSync(neg.tempDir), false, '清理后那个目录确实不在了')
})

C('main-repo-hash-unchanged', () => {
  h.eq(srcHashBefore, srcHashAfterNegative, '负向控制跑完，主仓 lib/client.js 逐字节没变')
  h.eq(srcHashAtEval, srcHashBefore, '判据开始前主仓仍未被碰')
  const now = sha256(fs.readFileSync(CLIENT))
  h.eq(now, srcHashBefore, '此刻主仓 lib/client.js 还是采集前那一份')
})

C('fixture-hygiene', () => {
  h.eq((pos.unknownRoutes || []).join(','), '', '渲染期间只碰了夹具声明过的假路由（/status、/catalog、/teaching）')
  h.eq((pos.effectErrors || []).length, 0, '组件 effect 一个都没抛' + ((pos.effectErrors || []).length ? '：' + pos.effectErrors.join(' | ') : ''))
  h.eq((pos.clickErrors || []).length, 0, '点击回调一个都没抛' + ((pos.clickErrors || []).length ? '：' + pos.clickErrors.join(' | ') : ''))
  h.eq((pos.finalRows || []).length, 4, '收尾时树上仍有 4 行课程（没被 busy/导出结果弄丢）')
})

/* 备注（进 notes.txt，只是索引） */
h.note(`主仓 lib/client.js sha256：采集前 ${srcHashBefore} / 负向控制后 ${srcHashAfterNegative}`)
h.note(`渲染级：圆圈展开钮 ${pos.toggleCount} 个，展开后 ${(pos.rowsAfterExpand || []).length} 行 / ${pos.exportButtonCountAfterExpand} 个导出按钮`)
h.note(`逐行点击得到的 file：${JSON.stringify((pos.clicks || []).map((c) => (((c.exportCalls || [])[0] || {}).body || {}).file))}`)
h.note(`负向控制（共享 var 临时副本）对不上的行：${JSON.stringify(neg.mismatches)}；四处同一课=${neg.allSameFile}；夹具=${neg.tempFile}；已清理=${neg.removed}`)
if (pos.fatal) h.note('正向采集致命错误：' + clip(pos.fatal, 800))
if (fatal) h.note('采集致命错误：' + clip(String((fatal && fatal.stack) || fatal), 800))

process.exit(h.run())
