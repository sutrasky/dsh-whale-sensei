/**
 * test/audit/T24.mjs — 客户端轮询与 DOM 适配可完整 dispose（卡 T24 / 报告 E02）
 * ==================================================================
 * 病（旧行为，审计 E02）：
 *   · `CourseDialog()` 的重建轮询把 `window.setInterval` 挂在组件作用域的普通变量
 *     （`var rebuildTimer`）上 —— **弹窗关闭（open=false）与组件卸载都不会清**，
 *     in-flight 请求不可取消；jobId 换代时旧作业的迟到响应还会覆盖新作业；
 *   · `GroupPanel()` 的星图重建轮询用的是**裸 `setTimeout`**（全局）且**完全没有 dispose** ——
 *     切走设置页后在后台一直 ping 到 150 次；
 *   · `mountSidebarEntry()` 没有"同一所有者只留一组观察器与一行"的约束：再次 mount 会多插一行、
 *     多挂一组 observer，且只能顺着 `document.body` 兜底找根。
 *
 * 本文件判的就是卡面那三句（逐字）：
 *   「fake timers验证关闭/卸载后零请求增长；B启动后A迟到结果无效；
 *     替换侧栏根后入口恰好1个，dispose后0个。」
 *
 * 怎么判（**真行为**，不是源码关键字）：
 *   · 假基座 + mini-React **真加载** `lib/client.js`（形状照 test/audit/T19.mjs:108-247 与
 *     test/panel.mjs:311-352），真渲染 `CourseDialog`，真点「+ 新建圆圈 → 创建」
 *     走 `doCreateCircle` → `watchRebuild` → 轮询；
 *   · 假定时器**全部由夹具记账**（队列 + `advance(ms)`）——不用真定时器 + sleep；
 *   · mini-React 的 `useEffect` **真的跑 cleanup**（deps 变化与卸载都先跑上一轮的返回值）：
 *     ⚠️ 这是本卡能不能判 dispose 的**前提** —— 垫片自己不跑 cleanup，所有 dispose 判据都是空的
 *     （T19 的垫片只收集、从不跑 cleanup，所以这里必须自己写）；
 *   · in-flight 是否被 abort，直接看夹具记下的那个 `AbortController.signal.aborted`；
 *   · D 组用假 DOM + 可手动触发的假 `MutationObserver`（`observe()` 的目标会被记下来）。
 *
 * 固定用例 ID 全集（**不许漂移**，共 17）：P01..P07 / G01 / D01..D04 / R01..R04 / N01
 *   · `P03/P04/P05` 必须有**真行为证据**（请求数、`signal.aborted`、横幅文案）；
 *   · `G01` **只作索引，不作行为证据**（既有测试驱动不到 GroupPanel 的保存入口，
 *     硬造一套 UI 驱动只会得到假绿 ⇒ 它的行为证据由 `N01` 承担）；
 *   · `N01` = 负向控制：把 `T24_BASELINE_REV`（75152ca，其 lib/client.js 与改动前逐字节相同）
 *     的源码放进临时副本后跑**同一套** P03/P04/P05 检查 —— 必须红。revision 取不到 → BLOCKED。
 *
 * 验收命令：`node E:/workplace/dsh-whale-sensei/test/audit/T24.mjs`
 *   成功 → `PASS T24 checks=17 failed=0 skipped=0` exit0；失败 → `FAIL T24 …` exit1；
 *   缺料 → `BLOCKED T24 …` exit2。
 * R 组（R01..R04）要真跑接触套件，它们需要课程包：默认 `E:/workplace/study`
 * （与 `test/audit/T23.mjs:15` 同一条默认线），可用 `--pack=<课程包根>` 覆盖。
 * 铁律：不跑全量（全量归规划者独占）；只跑本卡入口与 R 组点名的那四条；主仓 `lib/client.js` 只读。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createHarness, REPO, clip, makeTempDir, cleanupTempDir, runChild } from './harness.mjs'

/* ───────────────────────── 固定用例 ID 全集（17） ───────────────────────── */
const IDS = [
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07',
  'G01',
  'D01', 'D02', 'D03', 'D04',
  'R01', 'R02', 'R03', 'R04',
  'N01',
]

const CLIENT = path.join(REPO, 'lib', 'client.js')
/** 基线 revision：**常量**（用会漂的 HEAD 当负向控制 = 判据会随提交漂移） */
const T24_BASELINE_REV = '75152ca36d838cc0d7e8a926683d0df4ab24c383'
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** `--pack=<根>` / 位置参数（与 test/_pack.mjs 同一条解析线的最简形） */
function argValue(name) {
  const pre = `--${name}=`
  const hit = process.argv.slice(2).find((a) => a.startsWith(pre))
  return hit ? hit.slice(pre.length) : undefined
}
const PACK = path.resolve(argValue('pack') || process.env.DSH_WHALE_PACK || 'E:/workplace/study')
const PACK_OK = fs.existsSync(path.join(PACK, 'presets', 'whale-sensei.css'))

/* ───────────────────────── 树上的最小查询器（只认渲染结果） ───────────────────────── */
function walk(node, visit) {
  if (node == null || node === false || node === true) return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  if (node.children) for (const c of node.children) walk(c, visit)
  if (node.props) {
    if (node.props.children) walk(node.props.children, visit)
    if (node.props.footer) walk(node.props.footer, visit)
    if (node.props.description) walk(node.props.description, visit)
  }
}
function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  let s = ''
  if (node.children) s += node.children.map(textOf).join('')
  if (node.props) {
    if (node.props.children) s += textOf(node.props.children)
    if (node.props.footer) s += textOf(node.props.footer)
  }
  return s
}
function collect(tree, pred) {
  const out = []
  walk(tree, (n) => { if (pred(n)) out.push(n) })
  return out
}
/** 找第一个「带 onClick 且文本含 needle」的节点；type 给了就再限定元素类型 */
function findClickable(tree, needle, type) {
  const hits = collect(tree, (n) => typeof (n.props && n.props.onClick) === 'function'
    && textOf(n).indexOf(needle) >= 0
    && (type === undefined || n.type === type))
  return hits[0] || null
}
function findInputs(tree) {
  return collect(tree, (n) => n.type === 'input')
}

/* ───────────────────────── 假基座 + mini-React（**真跑 cleanup**） ─────────────────────────
 * 与 T19/panel 的垫片同型，但补了本卡的关键差别：
 *   ① `useRef(v) → { current: v }` 按组件存槽位；
 *   ② `useEffect(fn, deps)` 在 **deps 变化**或**卸载**时**先跑上一轮的返回值（cleanup）**，再跑新的；
 *      卸载时跑一次全部 cleanup —— 垫片自己不跑 cleanup，所有 dispose 判据都是空的。
 *   ③ 假定时器全部由夹具记账：`window.setTimeout/setInterval/...` 进队列，`advance(ms)` 才推进。
 */
function createBench(src) {
  const asked = []
  const calls = []
  const rebuildCalls = []
  const unknownRoutes = []
  const effectErrors = []
  const timerErrors = []
  const observeCalls = []
  const moInstances = []
  const observerErrors = []
  const fetchLog = []
  /** 观察器实例上限（夹具自保：超过就是"观察风暴"，见 FakeMO.observe） */
  const OBSERVER_CAP = 200

  let clock = 0
  let timerSeq = 0
  const timers = new Map()

  function schedule(kind, fn, ms) {
    const id = ++timerSeq
    const d = Number(ms) || 0
    timers.set(id, { id, kind, fn, ms: d, due: clock + d })
    return id
  }
  const fakeWindow = {
    __ModuleLoader__: { load: (m) => { mod = m } },
    setTimeout: (fn, ms) => schedule('timeout', fn, ms),
    clearTimeout: (id) => { timers.delete(id) },
    setInterval: (fn, ms) => schedule('interval', fn, ms),
    clearInterval: (id) => { timers.delete(id) },
    prompt: () => {},
    open: () => {},
  }

  /* ── mini-React（hooks 按组件身份存，重渲染不串台） ── */
  const hookSlots = new WeakMap()
  const compIds = new WeakMap()
  const cleanups = new Map()
  let curComp = null
  let cursor = 0
  let pending = false
  let compSeq = 0
  let queued = []
  let mountedComps = []

  const cidOf = (c) => { let v = compIds.get(c); if (v === undefined) { v = ++compSeq; compIds.set(c, v) } return v }
  function slotsOf(c) { let s = hookSlots.get(c); if (!s) { s = []; hookSlots.set(c, s) } return s }

  const miniReact = {
    createElement(type, p, ...kids) {
      const children = kids.flat(Infinity).filter((k) => k != null && k !== false)
      const props = p || {}
      if (typeof type === 'function') {
        // 函数组件在**它自己的** hook 上下文里就地求值（children 只挂在元素上，不往 props 里塞）
        const pc = curComp
        const pk = cursor
        curComp = type
        cursor = 0
        try { return type(props) } finally { curComp = pc; cursor = pk }
      }
      return { type, props, children }
    },
    useState(init) {
      const s = slotsOf(curComp)
      const i = cursor++
      if (!(i in s)) s[i] = typeof init === 'function' ? init() : init
      return [s[i], (v) => { s[i] = typeof v === 'function' ? v(s[i]) : v; pending = true }]
    },
    useRef(v) {
      const s = slotsOf(curComp)
      const i = cursor++
      if (!(i in s)) s[i] = { current: v }
      return s[i]
    },
    useEffect(fn, deps) {
      const comp = curComp
      const s = slotsOf(comp)
      const i = cursor++
      const prev = s[i]
      const changed = !prev || deps === undefined || !prev.deps
        || prev.deps.length !== deps.length || deps.some((d, k) => d !== prev.deps[k])
      s[i] = { deps }
      if (changed) queued.push({ key: cidOf(comp) + ':' + i, fn })
    },
  }

  /* ── 假 DOM（形状照 test/panel.mjs:288-364，另加 `_inserts` 计数给"插入风暴"判据用） ── */
  let domMutations = 0
  function makeDom() {
    const docHolder = { doc: null }
    const match = (n, sel) => String(sel).split(',').some((one) => {
      const m = one.trim().match(/^([a-zA-Z]*)((?:\[[^\]]+\])*)$/)
      if (!m) return false
      if (m[1] && n.tagName !== m[1].toUpperCase()) return false
      return (m[2].match(/\[[^\]]+\]/g) || []).every((a) => {
        const inner = a.slice(1, -1)
        const eq = inner.match(/^([^=*]+)(\*=|=)?["']?([^"']*)["']?$/)
        if (!eq || !eq[2]) return n.getAttribute(inner) !== null
        const have = n.getAttribute(eq[1]) || ''
        return eq[2] === '*=' ? have.split(/\s+/).some((c) => c.includes(eq[3])) : have === eq[3]
      })
    })
    const findIn = (root, sel) => {
      const stack = [...root.children]
      while (stack.length) {
        const n = stack.shift()
        if (n.matches(sel)) return n
        stack.push(...n.children)
      }
      return null
    }
    const mk = (tag, cls) => {
      const n = {
        tagName: tag.toUpperCase(), className: cls || '', children: [], parentElement: null,
        _attrs: {}, _text: '', innerHTML: '', style: {}, disabled: false, type: '', _on: {}, _inserts: 0,
        setAttribute(k, v) { this._attrs[k] = String(v) },
        getAttribute(k) {
          if (k === 'class') return this.className || null
          return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null
        },
        appendChild(c) { c.parentElement = this; this.children.push(c); c._inserts++; domMutations++; return c },
        append(...cs) { cs.forEach((c) => this.appendChild(c)) },
        insertBefore(c, ref) {
          if (c.parentElement) { const i = c.parentElement.children.indexOf(c); if (i >= 0) c.parentElement.children.splice(i, 1) }
          c.parentElement = this
          const at = ref ? this.children.indexOf(ref) : -1
          if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c)
          c._inserts++; domMutations++
          return c
        },
        remove() {
          const p = this.parentElement
          if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); domMutations++ }
          this.parentElement = null
        },
        contains(o) { let x = o; while (x) { if (x === this) return true; x = x.parentElement } return false },
        addEventListener(t, fn) { this._on[t] = fn },
        matches(sel) { return match(this, sel) },
        closest(sel) { let x = this; while (x) { if (match(x, sel)) return x; x = x.parentElement } return null },
        querySelector(sel) { return findIn(this, sel) },
        querySelectorAll(sel) {
          const out = []
          const w = (r) => { r.children.forEach((c) => { if (c.matches(sel)) out.push(c); w(c) }) }
          w(this)
          return out
        },
        getBoundingClientRect() { return { left: 0, top: 0, width: 252, height: 38 } },
        get isConnected() { let x = this; while (x.parentElement) x = x.parentElement; return x === docHolder.doc.documentElement },
        get firstElementChild() { return this.children[0] || null },
        get previousElementSibling() {
          const p = this.parentElement
          if (!p) return null
          const i = p.children.indexOf(this)
          return i > 0 ? p.children[i - 1] : null
        },
        get nextElementSibling() {
          const p = this.parentElement
          if (!p) return null
          const i = p.children.indexOf(this)
          return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null
        },
        set textContent(v) { this._text = String(v); this.children = [] },
        get textContent() { return this._text + this.children.map((c) => c.textContent).join('') },
      }
      return n
    }
    const doc = { createElement: (t, cls) => mk(t, cls), getElementById: () => null }
    docHolder.doc = doc
    doc.documentElement = mk('html')
    doc.head = mk('head')
    doc.body = mk('body')
    doc.documentElement.appendChild(doc.head)
    doc.documentElement.appendChild(doc.body)
    doc.querySelector = (sel) => findIn(doc.documentElement, sel)
    doc.querySelectorAll = (sel) => {
      const out = []
      const w = (r) => { r.children.forEach((c) => { if (c.matches(sel)) out.push(c); w(c) }) }
      w(doc.documentElement)
      return out
    }
    return doc
  }

  /** 有侧栏的假文档；`inMount` = 侧栏列外面再套一层（= "最窄稳定祖先"）；`host` 给了就复用那个容器 */
  function addSidebar(doc, { inMount = true, host = null } = {}) {
    let outer = host
    if (!outer) {
      outer = inMount ? doc.createElement('div') : doc.body
      if (inMount) { outer.className = 'appShell'; doc.body.appendChild(outer) }
    }
    const col = doc.createElement('div')
    col.setAttribute('data-pane', 'sidebar')
    const logoRow = doc.createElement('div', 'hHd-Xa_logoRow')
    const native = doc.createElement('button', 'hHd-Xa_newSession')
    col.appendChild(logoRow)
    col.appendChild(native)
    col.appendChild(doc.createElement('div', 'hHd_Xa_regionArea'))
    outer.appendChild(col)
    return { host: outer, col, logoRow, native }
  }

  class FakeMO {
    constructor(cb) {
      // 上限是**夹具自保**（必须卡在构造器上：光卡 observe 的话实例数还是会指数爆炸）：
      // 回调里无条件重挂的话实例数会翻倍增长 —— 那必须当场判红（D04），
      // 而不是把夹具撑到 OOM（那就一条判词都没有了）。
      if (moInstances.length >= OBSERVER_CAP) {
        throw new Error(`T24 夹具：MutationObserver 实例超过 ${OBSERVER_CAP} 个 —— 回调里在无条件重挂（观察风暴）`)
      }
      this.cb = cb
      this.target = null
      this.opts = null
      this.disconnected = false
      this.observeCount = 0
      moInstances.push(this)
    }
    observe(target, opts) {
      this.target = target
      this.opts = opts
      this.disconnected = false
      this.observeCount++
      observeCalls.push({ mo: this, target, opts, t: clock })
    }
    disconnect() { this.disconnected = true }
  }
  const activeObservers = () => moInstances.filter((o) => !o.disconnected && o.target)
  // ⚠️ 按**快照**叫醒、逐条吞错（错记进 observerErrors）：被变异的产品可能在回调里又 new 一个观察器，
  //    在活数组上 for...of 会边遍历边长 —— 那就成了夹具自己挂死，而不是判据判红。
  const fireAllObservers = () => {
    const list = moInstances.slice()
    for (const o of list) {
      if (typeof o.cb !== 'function') continue
      try { o.cb() } catch (err) { observerErrors.push(String((err && err.message) || err)) }
    }
  }

  /* ── 假 fetch（记录 url/method/假时钟/`signal`） ── */
  const realFetch = globalThis.fetch
  const realDoc = globalThis.document
  const realMO = globalThis.MutationObserver
  const pendingRebuilds = []
  const state = {
    rebuildMode: 'ok',
    rebuildPayload: { job: { done: false, index: 0, total: 2, current: 'a.sh', scripts: ['a.sh', 'b.sh'] } },
    catalog: { ok: true, configured: true, canCreate: true, circles: [{ id: 'programming', name: '编程', points: [] }] },
    circleRebuild: { jobId: 'A', scripts: ['a.sh', 'b.sh'] },
    pointRebuild: { jobId: 'B', scripts: ['b.sh'] },
  }
  const ENTRY = {
    label: '新课程',
    prompt: '【开课请求】（T24 夹具）',
    form: { title: '新课程', intro: '点知识点卡片即开课', submitLabel: '发送', cancelLabel: '取消', fields: [], template: '' },
  }
  const jsonResp = (payload) => Promise.resolve({
    status: 200,
    ok: true,
    text: () => Promise.resolve(JSON.stringify(payload)),
    json: () => Promise.resolve(payload),
  })

  globalThis.fetch = function (url, init) {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    const signal = (init && init.signal) || null
    const rec = { url: u, method, t: clock, signal, hasSignal: !!signal }
    calls.push(rec)
    fetchLog.push(rec)
    if (u.indexOf('/api/whale/rebuild') === 0) {
      rebuildCalls.push(rec)
      if (state.rebuildMode === 'reject') return Promise.reject(new Error('T24 夹具：网络错误（rebuild）'))
      if (state.rebuildMode === 'defer') {
        let resolve = null
        const promise = new Promise((res) => { resolve = res })
        pendingRebuilds.push({ rec, resolve, url: u })
        return Promise.resolve({ status: 200, ok: true, json: () => promise })
      }
      return jsonResp(state.rebuildPayload)
    }
    if (u.indexOf('/api/whale/status') === 0) return jsonResp({ ok: true, configured: true, version: '0.0.0-t24', sections: [] })
    if (u.indexOf('/api/whale/starter') === 0 && method === 'POST') return jsonResp({ ok: true, text: '【开课请求】（T24 夹具）' })
    if (u.indexOf('/api/whale/starter') === 0) return jsonResp({ ok: true, configured: true, entry: ENTRY })
    if (u.indexOf('/api/whale/catalog') === 0) return jsonResp(state.catalog)
    if (u.indexOf('/api/whale/circle') === 0) {
      return jsonResp(Object.assign({ ok: true, id: 'math' }, state.circleRebuild ? { rebuild: state.circleRebuild } : {}))
    }
    if (u.indexOf('/api/whale/point') === 0) {
      return jsonResp(Object.assign({ ok: true, id: 'math/algebra', mapPrompt: '' },
        state.pointRebuild ? { rebuild: state.pointRebuild } : {}))
    }
    if (u.indexOf('/api/whale/gate') === 0) {
      return jsonResp({ ok: true, configured: true, point: 'unknown', probe: false, allowed: true, verdict: { allowed: true, code: 'ok', needsReview: [] } })
    }
    unknownRoutes.push(method + ' ' + u)
    return jsonResp({ ok: false, error: 'T24 夹具没有这条假路由：' + method + ' ' + u })
  }

  /* ── 加载 + apply ── */
  const primitives = { Modal: 'T24Modal', Button: 'T24Button' }
  let mod = null
  let exportsObj = null
  let rootComp = null
  let loadError = null
  let applyError = null
  const regs = []
  const ctxEffects = []
  const applyCtx = {
    slots: { inject: (n, cb) => cb(), register: (spec, comp) => { regs.push({ spec, comp }); return () => {} } },
    effect: (fn, name) => { ctxEffects.push({ fn, name }) },
  }
  const req = (n) => {
    asked.push(n)
    if (n === 'react') return miniReact
    if (n === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('客户端 require 了没声明的包：' + n)
  }
  const restore = () => { globalThis.fetch = realFetch; globalThis.document = realDoc; globalThis.MutationObserver = realMO }

  /* ── 渲染 / 结算 / 推进假时钟 ── */
  const drain = () => new Promise((r) => setTimeout(r, 0))

  function renderOnce() {
    queued = []
    const tree = mountedComps.length ? miniReact.createElement(mountedComps[0], {}) : null
    const list = queued.slice()
    queued = []
    // React 的提交顺序：先把待跑的 cleanup 跑掉，再跑新的 effect
    for (const e of list) {
      const old = cleanups.get(e.key)
      if (old) {
        cleanups.delete(e.key)
        try { old() } catch (err) { effectErrors.push('cleanup: ' + String((err && err.message) || err)) }
      }
    }
    for (const e of list) {
      try {
        const c = e.fn()
        if (typeof c === 'function') cleanups.set(e.key, c)
      } catch (err) { effectErrors.push('effect: ' + String((err && err.message) || err)) }
    }
    return tree
  }

  let curTree = null
  async function settle(maxRounds = 60) {
    pending = true
    for (let i = 0; i < maxRounds && pending; i++) {
      pending = false
      curTree = renderOnce()
      await drain()
    }
    return curTree
  }

  /** 推进假时钟：按 due 次序逐个触发，中间把 microtask / 重渲染排干 */
  async function advance(ms) {
    const target = clock + (Number(ms) || 0)
    for (;;) {
      let best = null
      for (const t of timers.values()) {
        if (t.due > target) continue
        if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t
      }
      if (!best) break
      clock = best.due
      if (best.kind === 'interval') best.due = clock + best.ms
      else timers.delete(best.id)
      try { best.fn() } catch (err) { timerErrors.push('timer: ' + String((err && err.message) || err)) }
      await drain()
      await settle()
    }
    clock = target
    await settle()
    return clock
  }

  /** 卸载：跑一次**全部** cleanup（deps 未变的那些也要跑） */
  function unmount() {
    for (const [k, fn] of Array.from(cleanups.entries())) {
      cleanups.delete(k)
      try { fn() } catch (err) { effectErrors.push('unmount: ' + String((err && err.message) || err)) }
    }
    mountedComps = []
  }

  /** 装载：装 DOM → 加载模块 → apply(ctx) → 记住要渲染的组件 */
  function boot({ dom, mountComp = true, compId = 'whale-new-course-dialog', slotName = 'shell.overlay' } = {}) {
    if (dom) { globalThis.document = dom; globalThis.MutationObserver = FakeMO }
    try {
      new Function('window', 'require', src)(fakeWindow, req)
      if (!mod || typeof mod.factory !== 'function') throw new Error('模块没有 factory（不是 lazy-CJS 形态）')
      exportsObj = mod.factory(req)
      exportsObj.apply(applyCtx)
    } catch (err) { loadError = err }
    const hit = regs.find((r) => r.spec && r.spec.name === slotName && r.spec.id === compId)
    rootComp = hit ? hit.comp : null
    if (mountComp) mountedComps = rootComp ? [rootComp] : []
    return { loadError, rootComp }
  }

  /** 在**同一个**工厂实例里再 apply 一次（= 宿主重挂 / 重复 apply 那一幕） */
  function reapply() { if (exportsObj) exportsObj.apply(applyCtx); return ctxEffects.length }

  return {
    /* 观察面 */
    get tree() { return curTree },
    get mod() { return mod },
    get exportsObj() { return exportsObj },
    get rootComp() { return rootComp },
    get loadError() { return loadError },
    get applyError() { return applyError },
    get clock() { return clock },
    get pendingTimers() { return Array.from(timers.values()).map((t) => ({ kind: t.kind, ms: t.ms, due: t.due })) },
    asked, calls, rebuildCalls, fetchLog, unknownRoutes, effectErrors, timerErrors,
    observeCalls, moInstances, observerErrors, pendingRebuilds, state, ctxEffects, regs,
    activeObservers, fireAllObservers,
    domMutations: () => domMutations,
    restore, boot, reapply, settle, advance, unmount, renderOnce,
    makeDom, addSidebar,
    texts: () => textOf(curTree),
    findClickable: (needle, type) => findClickable(curTree, needle, type),
    inputs: () => findInputs(curTree),
    click(needle, type) {
      const node = findClickable(curTree, needle, type)
      if (!node) { timerErrors.push('点不到：' + needle); return null }
      const ev = { stopped: 0, stopPropagation() { ev.stopped++ }, preventDefault() {}, target: {}, currentTarget: {} }
      try { node.props.onClick(ev) } catch (err) { timerErrors.push('click(' + needle + '): ' + String((err && err.message) || err)) }
      return ev
    },
    setState(slotIndex, value) {
      if (!rootComp) return false
      const s = slotsOf(rootComp)
      if (!(slotIndex in s)) return false
      s[slotIndex] = value
      pending = true
      return true
    },
    getSlot(slotIndex) {
      if (!rootComp) return undefined
      return slotsOf(rootComp)[slotIndex]
    },
  }
}

/* ───────────────────────── P 组：轮询生命周期（真行为） ───────────────────────── */

/** 一屏两步驱动：打开弹窗 → 点「+ 新建圆圈」→ 填表 → 点「创建」→ 等第一个重建作业 */
async function driveToFirstJob(b, opts = {}) {
  const out = { steps: [], circleCalls: [], rebuildBefore: 0, fatal: null }
  try {
    if (opts.rebuildMode) b.state.rebuildMode = opts.rebuildMode
    if (opts.rebuildPayload) b.state.rebuildPayload = opts.rebuildPayload
    if (opts.circleRebuild !== undefined) b.state.circleRebuild = opts.circleRebuild
    if (opts.catalog) b.state.catalog = opts.catalog

    await b.settle()                                  // 挂载：因 open=false，[open] effect 早退
    out.steps.push({ after: 'mount', texts: b.texts().slice(0, 0) })

    // 点侧栏那一行 → setDialogOpen(true)（真路径：startNewCourse 在 dialogReady 时开弹窗）
    const row = globalThis.document.querySelector('[data-dsh-whale-entry]')
    out.sidebarRow = !!row
    if (row && typeof row._on.click === 'function') row._on.click()
    await b.settle()                                  // open=true → 拉 starter + catalog
    out.steps.push({ after: 'open', open: !!b.tree && b.tree.props && b.tree.props.open, modalType: b.tree && b.tree.type })

    b.click('+ 新建圆圈')
    await b.settle()
    const ins = b.inputs()
    out.inputCount = ins.length
    if (ins.length >= 2) {
      ins[0].props.onChange({ target: { value: '数学' } })
      ins[1].props.onChange({ target: { value: 'math' } })
    }
    await b.settle()

    out.rebuildBefore = b.rebuildCalls.length
    b.click('创建', 'button')
    await b.settle()
    out.circleCalls = b.calls.filter((c) => c.url === '/api/whale/circle').map((c) => ({ url: c.url, method: c.method, t: c.t }))
    out.rebuildAfter = b.rebuildCalls.length
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  }
  return out
}

/** 在第一个作业之后再造一个作业（A→B）：走「+ 新建知识点 → 创建」 */
async function driveToSecondJob(b, opts = {}) {
  const out = { pointCalls: [], rebuildBefore: 0, fatal: null, inputCount: 0 }
  try {
    if (opts.pointRebuild !== undefined) b.state.pointRebuild = opts.pointRebuild
    if (opts.catalog) b.state.catalog = opts.catalog
    b.click('+ 新建知识点')
    await b.settle()
    const ins = b.inputs()
    out.inputCount = ins.length
    if (ins.length >= 2) {
      ins[0].props.onChange({ target: { value: '代数' } })
      ins[1].props.onChange({ target: { value: 'algebra' } })
    }
    await b.settle()
    out.rebuildBefore = b.rebuildCalls.length
    b.click('创建', 'button')
    await b.settle()
    out.pointCalls = b.calls.filter((c) => c.url === '/api/whale/point').map((c) => ({ url: c.url, method: c.method }))
    out.rebuildAfter = b.rebuildCalls.length
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  }
  return out
}

/** P01：首请求立刻发 + 900ms 间隔（不是 700/1200） */
async function scenarioP01(src) {
  const b = createBench(src)
  const out = { label: 'P01', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom })
    await driveToFirstJob(b, { rebuildMode: 'ok' })
    out.afterCreate = b.rebuildCalls.length
    await b.advance(900)
    out.after900 = b.rebuildCalls.length
    await b.advance(1800)
    out.after2700 = b.rebuildCalls.length
    out.times = b.rebuildCalls.map((c) => c.t)
    out.signalOnFirst = b.rebuildCalls.length ? b.rebuildCalls[0].hasSignal : null
    out.texts = b.texts()
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/** P02：job.done=true 之后不再增长 */
async function scenarioP02(src) {
  const b = createBench(src)
  const out = { label: 'P02', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom })
    await driveToFirstJob(b, {
      rebuildMode: 'ok',
      rebuildPayload: { job: { done: true, index: 1, total: 2, scripts: ['a.sh', 'b.sh'], rebuild: { ok: true }, warnings: [], total: 2 } },
    })
    out.afterCreate = b.rebuildCalls.length
    out.textAtDone = b.texts()
    await b.advance(9000)
    out.after10Windows = b.rebuildCalls.length
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/** P03：open 置 false（**不卸载**）→ 零增长 + in-flight 被 abort */
async function scenarioP03(src) {
  const b = createBench(src)
  const out = { label: 'P03', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom })
    await driveToFirstJob(b, { rebuildMode: 'defer' })
    out.beforeClose = b.rebuildCalls.length
    out.pendingBefore = b.pendingRebuilds.length
    out.openBefore = !!(b.tree && b.tree.props && b.tree.props.open)
    // 真路径关弹窗：底部「取消」（primitives.Button）→ setDialogOpen(false)
    const ev = b.click('取消', 'T24Button')
    out.clickedCancel = !!ev
    await b.settle()
    out.openAfter = !!(b.tree && b.tree.props && b.tree.props.open)
    out.aborted = b.pendingRebuilds.length > 0 && !!(b.pendingRebuilds[0].rec.signal && b.pendingRebuilds[0].rec.signal.aborted)
    out.hasSignal = b.rebuildCalls.length > 0 && b.rebuildCalls[0].hasSignal
    out.pendingTimers = b.pendingTimers
    await b.advance(9000)
    out.after10Windows = b.rebuildCalls.length
    out.texts = b.texts()
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/** P04：卸载组件 → 零增长 + in-flight 被 abort */
async function scenarioP04(src) {
  const b = createBench(src)
  const out = { label: 'P04', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom })
    await driveToFirstJob(b, { rebuildMode: 'defer' })
    out.beforeUnmount = b.rebuildCalls.length
    out.pendingBefore = b.pendingRebuilds.length
    b.unmount()
    out.aborted = b.pendingRebuilds.length > 0 && !!(b.pendingRebuilds[0].rec.signal && b.pendingRebuilds[0].rec.signal.aborted)
    out.hasSignal = b.rebuildCalls.length > 0 && b.rebuildCalls[0].hasSignal
    out.pendingTimers = b.pendingTimers
    await b.advance(9000)
    out.after10Windows = b.rebuildCalls.length
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/** P05：jobId A→B 之后，A 的迟到响应不许覆盖 B */
async function scenarioP05(src) {
  const b = createBench(src)
  const out = { label: 'P05', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom })
    const catalogWithMath = {
      ok: true, configured: true, canCreate: true,
      circles: [
        { id: 'programming', name: '编程', points: [] },
        { id: 'math', name: '数学', points: [] },
      ],
    }
    await driveToFirstJob(b, { rebuildMode: 'defer', catalog: catalogWithMath })
    out.rebuildAfterA = b.rebuildCalls.length
    out.urlA = b.rebuildCalls.length ? b.rebuildCalls[0].url : null
    await driveToSecondJob(b, { catalog: catalogWithMath })
    out.rebuildAfterB = b.rebuildCalls.length
    out.urlB = b.rebuildCalls.length > 1 ? b.rebuildCalls[1].url : null
    out.abortedA = !!(b.pendingRebuilds[0] && b.pendingRebuilds[0].rec.signal && b.pendingRebuilds[0].rec.signal.aborted)

    // B 先到 → 横幅应当是 B 的
    if (b.pendingRebuilds[1]) b.pendingRebuilds[1].resolve({ job: { done: false, index: 1, total: 2, current: 'B-NOW', scripts: ['b.sh'] } })
    await b.settle()
    out.textsAfterB = b.texts()
    // A 迟到 → 一个字都不许写进去
    if (b.pendingRebuilds[0]) b.pendingRebuilds[0].resolve({ job: { done: false, index: 0, total: 2, current: 'A-LATE', scripts: ['a.sh'] } })
    await b.settle()
    out.textsAfterLateA = b.texts()
    await b.advance(900)
    out.rebuildAtEnd = b.rebuildCalls.length
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/** P06 + P07：连续 5 次网络失败 → 退避 1/2/4/8s、停手、给可重试错误；retry 恢复 */
async function scenarioP06P07(src) {
  const b = createBench(src)
  const out = { label: 'P06/P07', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom })
    const CIRC = { jobId: 'E', scripts: ['e.sh'] }
    await driveToFirstJob(b, { rebuildMode: 'reject', circleRebuild: CIRC })
    out.t0 = b.rebuildCalls.map((c) => c.t)
    await b.advance(1000); out.t1 = b.rebuildCalls.map((c) => c.t)
    await b.advance(2000); out.t2 = b.rebuildCalls.map((c) => c.t)
    await b.advance(4000); out.t3 = b.rebuildCalls.map((c) => c.t)
    await b.advance(8000); out.t4 = b.rebuildCalls.map((c) => c.t)
    out.countAfter5 = b.rebuildCalls.length
    out.deltas = out.t4.slice(1).map((t, i) => t - out.t4[i])
    out.textsAfterFail = b.texts()
    out.pendingTimers = b.pendingTimers
    await b.advance(9000)
    out.countAfterIdle = b.rebuildCalls.length
    out.retryButton = !!b.findClickable('重试')

    // —— P07：点「重试」 ——
    b.state.rebuildMode = 'ok'
    b.state.rebuildPayload = { job: { done: false, index: 0, total: 2, current: 'E-993', scripts: ['e.sh'] } }
    const before = b.rebuildCalls.length
    b.click('重试')
    out.countRightAfterClick = b.rebuildCalls.length
    out.immediate = b.rebuildCalls.length - before
    await b.settle()
    out.textsAfterRetry = b.texts()
    out.retryButtonAfter = !!b.findClickable('重试')
    await b.advance(900)
    out.countAfter900 = b.rebuildCalls.length
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/* ─────────────────── 负数控制要复用的三条纯检查（同一套判据跑两边） ─────────────────── */
/** P03 的判据：关闭之后零增长 + in-flight aborted + 弹窗真的关了 */
function checkP03(r) {
  const grown = (r.after10Windows || 0) - (r.beforeClose || 0)
  const why = []
  if (r.fatal) why.push('采集致命：' + r.fatal)
  if (!(r.clickedCancel && r.openBefore && !r.openAfter)) why.push(`关弹窗那一幕没成立（点到了取消=${r.clickedCancel} open ${r.openBefore}→${r.openAfter}）`)
  if (grown !== 0) why.push(`关闭后推进 10×900ms 又发了 ${grown} 个请求`)
  if (r.aborted !== true) why.push(`in-flight 没有被 abort（aborted=${r.aborted}, hasSignal=${r.hasSignal}）`)
  return { ok: why.length === 0, why, grown, aborted: r.aborted }
}
/** P04 的判据：卸载之后零增长 + in-flight aborted */
function checkP04(r) {
  const grown = (r.after10Windows || 0) - (r.beforeUnmount || 0)
  const why = []
  if (r.fatal) why.push('采集致命：' + r.fatal)
  if (grown !== 0) why.push(`卸载后推进 10×900ms 又发了 ${grown} 个请求`)
  if (r.aborted !== true) why.push(`in-flight 没有被 abort（aborted=${r.aborted}, hasSignal=${r.hasSignal}）`)
  return { ok: why.length === 0, why, grown, aborted: r.aborted }
}
/** P05 的判据：B 启动后 A 的迟到结果无效（横幅是 B 的） */
function checkP05(r) {
  const why = []
  if (r.fatal) why.push('采集致命：' + r.fatal)
  if (!(r.rebuildAfterA === 1 && r.rebuildAfterB >= 2)) why.push(`两代作业没各发一个请求（A 后=${r.rebuildAfterA} B 后=${r.rebuildAfterB}）`)
  if (!(String(r.urlA).includes('id=A') && String(r.urlB).includes('id=B'))) why.push(`请求 id 不对（${r.urlA} / ${r.urlB}）`)
  if (r.abortedA !== true) why.push('A 代际的 in-flight 在换代时没有被 abort')
  if (!String(r.textsAfterB).includes('B-NOW')) why.push('B 的响应没写进横幅')
  if (String(r.textsAfterLateA).includes('A-LATE')) why.push('A 的迟到响应覆盖了 B（旧代际没作废）')
  return { ok: why.length === 0, why }
}

/* ───────────────────────── D 组：侧栏 DOM 适配 ───────────────────────── */

const ENTRY_SEL = '[data-dsh-whale-entry]'
const entryRows = (doc) => doc.querySelectorAll(ENTRY_SEL)

/** D01/D02/D03/D04 共用一次装载；每个场景一个新 bench（工厂内状态必须干净） */
function scenarioD01() {
  const b = createBench(fs.readFileSync(CLIENT, 'utf8'))
  const out = { label: 'D01', fatal: null }
  try {
    const dom = b.makeDom()
    const s = b.addSidebar(dom, { inMount: true })
    b.boot({ dom, mountComp: false })
    out.loadError = b.loadError ? String((b.loadError && b.loadError.message) || b.loadError) : null
    out.hostIsMount = s.host !== dom.body
    out.targets = b.observeCalls.map((o) => (o.target === s.host ? 'mount' : (o.target === dom.body ? 'body' : (o.target === s.col ? 'col' : 'other'))))
    out.opts = b.observeCalls.map((o) => JSON.stringify(o.opts))
    out.rows = entryRows(dom).length
    out.bodyObserved = b.observeCalls.some((o) => o.target === dom.body)
    out.activeObservers = b.activeObservers().length
    out.effectNames = b.ctxEffects.map((e) => e.name)
    out.sidebarEffectNames = b.ctxEffects.map((e) => e.name).filter((n) => n === 'whale-sensei: 侧栏入口（新课程）')
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

function scenarioD02() {
  const b = createBench(fs.readFileSync(CLIENT, 'utf8'))
  const out = { label: 'D02', fatal: null }
  try {
    const dom = b.makeDom()
    const s1 = b.addSidebar(dom, { inMount: true })
    b.boot({ dom, mountComp: false })
    out.rowsBefore = entryRows(dom).length
    // 根替换：旧列断开、新列接上（**同一个**稳定祖先里）
    s1.col.remove()
    const s2 = b.addSidebar(dom, { host: s1.host })
    out.hostSame = s2.host === s1.host
    b.fireAllObservers()
    const rows = entryRows(dom)
    out.rowsAfter = rows.length
    out.underNative = rows.length === 1 && rows[0].previousElementSibling === s2.native
    out.inNewCol = rows.length === 1 && rows[0].parentElement === s2.col
    out.text = rows.length === 1 ? rows[0].textContent : null
    out.activeObservers = b.activeObservers().length
    out.observeTargets = b.observeCalls.map((o) => (o.target === s1.host ? 'mount' : (o.target === dom.body ? 'body' : (o.target === s1.col ? 'col1' : (o.target === s2.col ? 'col2' : 'other')))))
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

function scenarioD03() {
  const b = createBench(fs.readFileSync(CLIENT, 'utf8'))
  const out = { label: 'D03', fatal: null }
  try {
    const dom = b.makeDom()
    b.addSidebar(dom, { inMount: true })
    b.boot({ dom, mountComp: false })
    out.rowsAfterFirst = entryRows(dom).length
    out.activeAfterFirst = b.activeObservers().length
    // 再 mount 一次（**不 dispose**，同一工厂实例里再 apply）→ 唯一所有者：行仍是 1、活动 observer 仍是 1 组
    b.reapply()
    out.rowsAfterSecond = entryRows(dom).length
    out.activeAfterSecond = b.activeObservers().length
    out.observeCallCount = b.observeCalls.length
    out.totalObservers = b.moInstances.length
    out.sidebarEffectCount = b.ctxEffects.filter((e) => e.name === 'whale-sensei: 侧栏入口（新课程）').length
    // dispose 最后登记的那个（ctx.effect 的回调返回 dispose）
    const mine = b.ctxEffects.filter((e) => e.name === 'whale-sensei: 侧栏入口（新课程）')
    const last = mine[mine.length - 1]
    out.effectName = last && last.name
    const dispose = last && typeof last.fn === 'function' ? last.fn() : null
    out.disposeType = typeof dispose
    if (typeof dispose === 'function') {
      dispose()
      out.disposeTwiceSafe = true
      try { dispose() } catch (err) { out.disposeTwiceSafe = false; out.disposeError = String((err && err.message) || err) }
    }
    out.rowsAfterDispose = entryRows(dom).length
    out.activeAfterDispose = b.activeObservers().length
    // dispose 之后 DOM 再动，不许把行插回来
    b.addSidebar(dom, { inMount: true })
    b.fireAllObservers()
    out.rowsAfterDisposeThenDomChange = entryRows(dom).length
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

function scenarioD04() {
  const b = createBench(fs.readFileSync(CLIENT, 'utf8'))
  const out = { label: 'D04', fatal: null }
  try {
    const dom = b.makeDom()
    const s = b.addSidebar(dom, { inMount: true })
    b.boot({ dom, mountComp: false })
    const row = entryRows(dom)[0]
    out.rowsBefore = entryRows(dom).length
    out.rowInsertsBefore = row ? row._inserts : null
    out.observeCallsBefore = b.observeCalls.length
    out.mutationsBeforeBurst = b.domMutations()
    out.observeStormPerRound = []
    for (let i = 0; i < 20; i++) {
      // 在**远离侧栏**的节点上插入 / 删除（外层 body 上换个窝），再把观察器回调全叫醒
      const far = dom.createElement('div', 'faraway')
      dom.body.appendChild(far)
      b.fireAllObservers()
      far.remove()
      b.fireAllObservers()
      out.observeStormPerRound.push(b.observeCalls.length)
    }
    const rowNow = entryRows(dom)[0]
    out.rowsAfter = entryRows(dom).length
    out.rowInsertsAfter = rowNow ? rowNow._inserts : null
    out.rowIsSameNode = rowNow === row
    out.observeCallsAfter = b.observeCalls.length
    out.activeObservers = b.activeObservers().length
    out.underNative = !!rowNow && rowNow.previousElementSibling === s.native
    out.mutationsAfterBurst = b.domMutations()
    out.observerErrors = b.observerErrors.slice()
    out.moInstances = b.moInstances.length
  } catch (e) { out.fatal = String((e && e.stack) || e) } finally { b.restore() }
  return out
}

/* ───────────────────────── R 组：四条接触套件（只跑这四条） ───────────────────────── */
const R_SUITES = [
  { id: 'R01', suite: 'panel', what: '侧栏 DOM 那批断言（test/panel.mjs:398-422）' },
  { id: 'R02', suite: 'audit/T19', what: '设置页渲染级回归' },
  { id: 'R03', suite: 'settings-catalog', what: '设置页课程目录 / 知识组卡渲染回归' },
  { id: 'R04', suite: 'new-course-wizard', what: 'CourseDialog 的现成驱动套件（本卡改了它的轮询接线）' },
]
function runRS(u) {
  const rel = path.join('test', `${u.suite}.mjs`)
  const argv = [process.execPath, path.join(REPO, rel)]
  if (u.suite !== 'audit/T19') argv.push(`--pack=${PACK}`)
  const r = runChild(argv, { cwd: REPO, timeoutMs: 600000 })
  return { ...u, rel, argv, code: r.code, out: r.out, err: r.err, ms: r.ms, timedOut: r.timedOut, spawnError: r.spawnError }
}
/** 判词：exit0 + 摘要 `0 失败`（T19 的判词形态单独认） */
function rVerdict(r) {
  if (r.suite === 'audit/T19') {
    const m = String(r.out).match(/^PASS T19 checks=(\d+) failed=0 skipped=0$/m)
    return { ok: r.code === 0 && !!m, mode: 'verdict', line: m ? m[0] : null }
  }
  const m = String(r.out).match(/^=== (\d+) 通过 \/ (\d+) 失败 ===$/m)
  return { ok: r.code === 0 && !!m && Number(m[2]) === 0, mode: 'summary', line: m ? m[0] : null, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null }
}

/* ───────────────────────── N01：负向控制（固定 revision 的旧实现必须红） ───────────────────────── */
function gitShow(rev, rel) {
  return spawnSync('git', ['show', `${rev}:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}
async function runNegativeControl(src) {
  const out = {
    rev: T24_BASELINE_REV, available: false, reason: null,
    tempDir: null, tempFile: null, tempUnderTempBase: false,
    baselineBytes: null, baselineHasHook: null, currentHasHook: null,
    removed: false, cleanupError: null,
    p03: null, p04: null, p05: null,
    mainHashBefore: null, mainHashAfter: null,
  }
  const avail = spawnSync('git', ['cat-file', '-e', `${T24_BASELINE_REV}^{commit}`], { cwd: REPO, encoding: 'utf8' })
  if (avail.error || avail.status !== 0) {
    out.reason = `固定 revision 取不到：${T24_BASELINE_REV}（git cat-file -e 退出码 ${avail.status}${avail.error ? '；' + avail.error.message : ''}）`
    return out
  }
  const shown = gitShow(T24_BASELINE_REV, 'lib/client.js')
  if (shown.error || shown.status !== 0 || !shown.stdout) {
    out.reason = `固定 revision 里取不到 lib/client.js（退出码 ${shown.status}${shown.error ? '；' + shown.error.message : ''}）`
    return out
  }
  out.available = true
  const baselineSrc = shown.stdout
  out.baselineBytes = Buffer.byteLength(baselineSrc, 'utf8')
  out.baselineHasHook = baselineSrc.includes('useRebuildJob(')
  out.currentHasHook = src.includes('useRebuildJob(')

  const dir = makeTempDir('dsh-whale-t24')
  out.tempDir = path.resolve(dir)
  out.tempUnderTempBase = out.tempDir.startsWith(path.resolve(os.tmpdir()) + path.sep)
  try {
    const libDir = path.join(out.tempDir, 'lib')
    fs.mkdirSync(libDir, { recursive: true })
    out.tempFile = path.resolve(path.join(libDir, 'client.js'))
    fs.writeFileSync(out.tempFile, baselineSrc, 'utf8')
    out.mainHashBefore = sha256(fs.readFileSync(CLIENT))
    out.p03 = await scenarioP03(baselineSrc)
    out.p04 = await scenarioP04(baselineSrc)
    out.p05 = await scenarioP05(baselineSrc)
    out.mainHashAfter = sha256(fs.readFileSync(CLIENT))
  } catch (e) {
    out.reason = '负向控制跑挂：' + String((e && e.stack) || e)
  } finally {
    const c = cleanupTempDir(dir, 't24')
    out.removed = c.removed
    out.cleanupError = c.error
  }
  return out
}

/* ─────────────────────────────── 采集 ─────────────────────────────── */
const h = createHarness({ card: 'T24', expectedIds: IDS, root: PACK })

let fatal = null
let src = ''
let srcHashBefore = null
let pos = {}
let d01 = {}, d02 = {}, d03 = {}, d04 = {}
let rRuns = []
let neg = {}
let srcHashAtEval = null

/* 采集期间把 console.log / warn 收进证据：① 判词只留一行；② "一声不吭"本身也是判据（D01） */
const realLog = console.log
const realWarn = console.warn
const captured = { log: [], warn: [] }
console.log = (...a) => { captured.log.push(a.map(String).join(' ')) }
console.warn = (...a) => { captured.warn.push(a.map(String).join(' ')) }

try {
  src = fs.readFileSync(CLIENT, 'utf8')
  srcHashBefore = sha256(src)
  pos.P01 = await scenarioP01(src)
  pos.P02 = await scenarioP02(src)
  pos.P03 = await scenarioP03(src)
  pos.P04 = await scenarioP04(src)
  pos.P05 = await scenarioP05(src)
  pos.P06P07 = await scenarioP06P07(src)
  d01 = scenarioD01()
  d02 = scenarioD02()
  d03 = scenarioD03()
  d04 = scenarioD04()
  if (!PACK_OK) h.block(`课程包不可用：${PACK}（R01/R03/R04 需要 presets/whale-sensei.css；可用 --pack=<课程包根> 指定）`)
  rRuns = R_SUITES.map(runRS)
  neg = await runNegativeControl(src)
  if (!fatal && neg.available === false) h.block(neg.reason || '固定 revision 取不到')
  srcHashAtEval = sha256(fs.readFileSync(CLIENT))
} catch (e) {
  fatal = e
} finally {
  console.log = realLog
  console.warn = realWarn
}

const p03Check = checkP03(pos.P03 || {})
const p04Check = checkP04(pos.P04 || {})
const p05Check = checkP05(pos.P05 || {})
const negP03 = checkP03(neg.p03 || {})
const negP04 = checkP04(neg.p04 || {})
const negP05 = checkP05(neg.p05 || {})

/* ── 证据：原始采集结果（机器可读，无 BOM）+ 人读的一张表 ── */
try {
  h.evidenceJson('collected.json', {
    fatal: fatal ? String(fatal.stack || fatal) : null,
    srcHashBefore, srcHashAtEval, pack: PACK, packOk: PACK_OK,
    pos, d01, d02, d03, d04,
    captured,
    checks: { p03: p03Check, p04: p04Check, p05: p05Check },
    neg, negChecks: { p03: negP03, p04: negP04, p05: negP05 },
    r: rRuns.map((r) => ({ id: r.id, suite: r.suite, code: r.code, ms: r.ms, stdout: r.out, stderr: r.err })),
  })
  const lines = []
  lines.push('T24 原始采集（' + new Date().toISOString() + '）')
  lines.push('主仓 lib/client.js sha256 采集前：' + srcHashBefore)
  lines.push('主仓 lib/client.js sha256 判据前：' + srcHashAtEval)
  lines.push('课程包：' + PACK + '（可用=' + PACK_OK + '）')
  lines.push('')
  lines.push('── P 组：轮询生命周期（假定时器） ──')
  lines.push(`P01 创建后立刻=${pos.P01?.afterCreate} / +900ms=${pos.P01?.after900} / 共 2700ms=${pos.P01?.after2700}  时间轴=${JSON.stringify(pos.P01?.times)}  首个请求带 signal=${pos.P01?.signalOnFirst}`)
  lines.push(`P02 done 后=${pos.P02?.afterCreate} 再推 10×900ms=${pos.P02?.after10Windows}  横幅=${JSON.stringify(clip(pos.P02?.textAtDone, 160))}`)
  lines.push(`P03 关闭前=${pos.P03?.beforeClose} 关闭后 10×900ms=${pos.P03?.after10Windows}  aborted=${pos.P03?.aborted}  hasSignal=${pos.P03?.hasSignal}  open ${pos.P03?.openBefore}→${pos.P03?.openAfter}  悬挂定时器=${JSON.stringify(pos.P03?.pendingTimers)}`)
  lines.push(`P04 卸载前=${pos.P04?.beforeUnmount} 卸载后 10×900ms=${pos.P04?.after10Windows}  aborted=${pos.P04?.aborted}  hasSignal=${pos.P04?.hasSignal}  悬挂定时器=${JSON.stringify(pos.P04?.pendingTimers)}`)
  lines.push(`P05 A 后=${pos.P05?.rebuildAfterA}(${pos.P05?.urlA}) B 后=${pos.P05?.rebuildAfterB}(${pos.P05?.urlB}) abortedA=${pos.P05?.abortedA}`)
  lines.push(`P05 B 到场后横幅：${JSON.stringify(clip(pos.P05?.textsAfterB, 200))}`)
  lines.push(`P05 A 迟到后横幅：${JSON.stringify(clip(pos.P05?.textsAfterLateA, 200))}`)
  lines.push(`P06 时间轴=${JSON.stringify(pos.P06P07?.t4)}  间隔=${JSON.stringify(pos.P06P07?.deltas)}  5 次后计数=${pos.P06P07?.countAfter5} 再推 10×900ms=${pos.P06P07?.countAfterIdle}  悬挂定时器=${JSON.stringify(pos.P06P07?.pendingTimers)}`)
  lines.push(`P06 失败后横幅：${JSON.stringify(clip(pos.P06P07?.textsAfterFail, 240))}`)
  lines.push(`P07 点「重试」后立刻=+${pos.P06P07?.immediate}（累计 ${pos.P06P07?.countRightAfterClick}）  再推 900ms=${pos.P06P07?.countAfter900}  重试按钮还在=${pos.P06P07?.retryButtonAfter}`)
  lines.push(`P07 重试后横幅：${JSON.stringify(clip(pos.P06P07?.textsAfterRetry, 200))}`)
  lines.push(`三个场景的判据：P03=${JSON.stringify(p03Check)} P04=${JSON.stringify(p04Check)} P05=${JSON.stringify(p05Check)}`)
  lines.push('')
  lines.push('── D 组：侧栏 DOM 适配（假 DOM + 假 MutationObserver） ──')
  lines.push(`D01 稳定祖先=外层容器:${d01.hostIsMount}  observe 目标=${JSON.stringify(d01.targets)}  opts=${JSON.stringify(d01.opts)}  行数=${d01.rows}  观察过 body=${d01.bodyObserved}  活动观察器=${d01.activeObservers}`)
  lines.push(`D01 ctx.effect 登记名=${JSON.stringify(d01.effectNames)}`)
  lines.push(`D02 换根前行数=${d02.rowsBefore} 换根后=${d02.rowsAfter} 贴住原生=${d02.underNative} 在新列里=${d02.inNewCol} 文案=${JSON.stringify(d02.text)} observe 目标=${JSON.stringify(d02.observeTargets)}`)
  lines.push(`D03 首次=${d03.rowsAfterFirst} 行/${d03.activeAfterFirst} 观察器；再 mount=${d03.rowsAfterSecond} 行/${d03.activeAfterSecond} 观察器（observe 调用累计 ${d03.observeCallCount}，实例累计 ${d03.totalObservers}）；dispose 后=${d03.rowsAfterDispose} 行/${d03.activeAfterDispose} 观察器 幂等=${d03.disposeTwiceSafe} 登记名=${JSON.stringify(d03.effectName)} 再动 DOM 后=${d03.rowsAfterDisposeThenDomChange}`)
  lines.push(`D04 20 次远处插入/删除 + 叫醒观察器：行数 ${d04.rowsBefore}→${d04.rowsAfter}（同一节点=${d04.rowIsSameNode}）  该行累计插入次数 ${d04.rowInsertsBefore}→${d04.rowInsertsAfter}  observe 调用 ${d04.observeCallsBefore}→${d04.observeCallsAfter}  活动观察器=${d04.activeObservers}  仍贴住原生=${d04.underNative}`)
  lines.push('')
  lines.push('── R 组：四条接触套件（只跑这四条） ──')
  for (const r of rRuns) {
    const v = rVerdict(r)
    lines.push(`${r.id} ${r.rel} exit=${r.code} 用时=${r.ms}ms ${v.mode === 'verdict' ? '判词=' + JSON.stringify(v.line) : '摘要=' + JSON.stringify(v.line)} → ${v.ok ? '绿' : '红'}`)
  }
  lines.push('')
  lines.push('── N01 负向控制（固定 revision 的旧 lib/client.js） ──')
  lines.push(`revision=${neg.rev} 可用=${neg.available}${neg.reason ? ' 原因=' + neg.reason : ''}`)
  lines.push(`旧源码 ${neg.baselineBytes} 字节；含 useRebuildJob=${neg.baselineHasHook}；现行源码含 useRebuildJob=${neg.currentHasHook}`)
  lines.push(`临时副本=${neg.tempFile} 在 E:/Temp 下=${neg.tempUnderTempBase} 清理=${neg.removed}${neg.cleanupError ? '（' + neg.cleanupError + '）' : ''}`)
  lines.push(`旧实现上的 P03 判据：${JSON.stringify(negP03)}`)
  lines.push(`旧实现上的 P04 判据：${JSON.stringify(negP04)}`)
  lines.push(`旧实现上的 P05 判据：${JSON.stringify(negP05)}`)
  lines.push(`旧实现 P05 迟到后横幅：${JSON.stringify(clip(neg.p05?.textsAfterLateA, 200))}`)
  lines.push(`主仓 sha256 负向控制前后：${neg.mainHashBefore} / ${neg.mainHashAfter}`)
  lines.push('')
  lines.push('── 采集期间被收走的 console 输出（判词只留一行；"一声不吭"见 D01） ──')
  lines.push(`console.log ${captured.log.length} 条：${JSON.stringify(captured.log.slice(0, 3))}`)
  lines.push(`console.warn ${captured.warn.length} 条：${JSON.stringify(captured.warn)}`)
  if (fatal) lines.push('采集致命错误：' + String(fatal.stack || fatal))
  h.evidence('observed.txt', lines.join('\n') + '\n')
  for (const r of rRuns) {
    h.evidence(`R/${r.id}-${r.suite.replace(/\//g, '_')}.stdout.log`, String(r.out || ''))
    h.evidence(`R/${r.id}-${r.suite.replace(/\//g, '_')}.stderr.log`, String(r.err || ''))
  }
} catch (e) {
  process.stderr.write('证据落盘失败：' + String((e && e.message) || e) + '\n')
}

/* ─────────────────────────────── 判据 ─────────────────────────────── */
const C = (id, fn) => h.case(id, 'pass', () => {
  if (fatal) h.fail('采集阶段致命错误：' + String((fatal && fatal.stack) || fatal))
  fn()
})

C('P01', () => {
  const r = pos.P01 || {}
  h.eq(r.fatal || null, null, 'P01 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.afterCreate, 1, 'open=true 且有 jobId：**立刻**发了 1 个请求（不等 900ms）')
  h.eq(r.after900, 2, '推进 900ms → 第 2 个')
  h.eq(r.after2700, 4, '推进到 2700ms → 第 4 个（间隔 = 900ms，不是 700/1200）')
  h.eq(JSON.stringify(r.times), JSON.stringify([0, 900, 1800, 2700]), '四个请求的假时钟时刻逐一是 0/900/1800/2700')
  h.eq(r.signalOnFirst, true, '每次请求都带 AbortController 的 signal')
})

C('P02', () => {
  const r = pos.P02 || {}
  h.eq(r.fatal || null, null, 'P02 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.afterCreate, 1, 'done 之前只有一个在途请求')
  h.eq(String(r.textAtDone).includes('产物已更新 ✓'), true, `job.done=true 的收场文案仍是「产物已更新 ✓」（${clip(r.textAtDone, 120)}）`)
  h.eq(r.after10Windows, r.afterCreate, '再推进 10×900ms：请求数**零增长**（轮询真的停了）')
})

C('P03', () => {
  h.eq(p03Check.ok, true, 'P03（open 置 false，不卸载）：' + (p03Check.why.join('；') || '关闭后零请求增长 + in-flight 被 abort'))
  h.eq(pos.P03?.grown ?? p03Check.grown, 0, `关闭后 10×900ms 的请求增量 = ${p03Check.grown}`)
  h.eq(p03Check.aborted, true, 'in-flight 的 signal.aborted === true')
})

C('P04', () => {
  h.eq(p04Check.ok, true, 'P04（卸载组件）：' + (p04Check.why.join('；') || '卸载后零请求增长 + in-flight 被 abort'))
  h.eq(p04Check.grown, 0, `卸载后 10×900ms 的请求增量 = ${p04Check.grown}`)
  h.eq(p04Check.aborted, true, 'in-flight 的 signal.aborted === true')
})

C('P05', () => {
  h.eq(p05Check.ok, true, 'P05（jobId A→B 后 A 迟到）：' + (p05Check.why.join('；') || '旧代际的迟到响应一律作废'))
  h.eq(String(pos.P05?.textsAfterLateA).includes('B-NOW'), true, 'A 迟到之后横幅里仍然是 B 的那一条')
  h.eq(String(pos.P05?.textsAfterLateA).includes('A-LATE'), false, 'A 的迟到响应一个字都没写进横幅')
})

C('P06', () => {
  const r = pos.P06P07 || {}
  h.eq(r.fatal || null, null, 'P06/P07 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.countAfter5, 5, '连续 5 次网络失败 → 尝试次数恰为 5（请求数 = 尝试数）')
  h.eq(JSON.stringify(r.deltas), JSON.stringify([1000, 2000, 4000, 8000]), '退避逐次是 1s / 2s / 4s / 8s')
  h.eq(JSON.stringify(r.t4), JSON.stringify([0, 1000, 3000, 7000, 15000]), '第 5 次尝试发生在 t=15000ms（假时钟逐次核对）')
  h.eq(r.countAfterIdle, r.countAfter5, '5 次之后不再排下一次：再推 10×900ms 请求数**零增长**')
  h.eq(String(r.textsAfterFail).includes('重试'), true, `error 是非空的、且含「重试」二字（${clip(r.textsAfterFail, 160)}）`)
  h.eq(r.retryButton, true, 'error 态下横幅上真的有一个可点的「重试」出口')
})

C('P07', () => {
  const r = pos.P06P07 || {}
  h.eq(r.immediate, 1, 'retry() 之后**立刻**再发一次（不等 900ms）')
  h.eq(String(r.textsAfterRetry).includes('重试'), false, 'retry() 之后错误文案消失（error=null）')
  h.eq(r.retryButtonAfter, false, '「重试」出口随之收起（说明错误态真的清了）')
  h.eq(String(r.textsAfterRetry).includes('正在重建产物'), true, `重试后回到"正在重建"的进度文案（${clip(r.textsAfterRetry, 160)}）`)
  h.eq(r.countAfter900 - r.countRightAfterClick, 1, '恢复 900ms 轮询：再推 900ms 正好多一个请求')
})

C('G01', () => {
  /* ⚠️ 这一条**只作索引，不作行为证据**：既有测试驱动不到 GroupPanel 的保存入口
   *   （test/settings-teaching.mjs:267 逐字写着「本判据不测知识组卡」），硬造 UI 驱动只会假绿。
   *   它的行为证据由 N01 承担（同一套 P03/P04/P05 判据跑旧实现必须红）。 */
  const defs = (src.match(/function useRebuildJob\(/g) || []).length
  const all = (src.match(/useRebuildJob\(/g) || []).length
  h.eq(defs, 1, 'useRebuildJob 在 lib/client.js 里只有一个定义（文件内 hook，不是导出）')
  h.eq(all - defs, 2, '`useRebuildJob(` 恰好有 2 个调用点（CourseDialog 与 GroupPanel）')
  const cut = src.indexOf('function CourseDialog()')
  h.eq(cut > 0, true, '源码里找得到 CourseDialog')
  h.eq((src.slice(0, cut).match(/useRebuildJob\(/g) || []).length - defs, 1, '调用点①在 CourseDialog 之前（GroupPanel）')
  h.eq((src.slice(cut).match(/useRebuildJob\(/g) || []).length, 1, '调用点②在 CourseDialog 里')
  h.eq(/setTimeout\(step, 700\)/.test(src), false, '旧的裸轮询形态 `setTimeout(step, 700)` 已消失')
  h.eq(/tries > 150/.test(src), false, '旧的 `tries > 150` 已消失')
  // 结构性索引（不是证据）：AbortController / useRef 真的落地
  h.eq(/react\.useRef\(/.test(src), true, '（索引）useRef 真的落地了')
  h.eq(/new AbortController\(/.test(src), true, '（索引）AbortController 真的落地了')
  h.eq(/(^|[^.\w])setTimeout\(/.test(src.replace(/window\.setTimeout\(/g, 'window__setTimeout(')), false, '（索引）轮询定时器不再有裸 setTimeout')
})

C('D01', () => {
  const r = d01
  h.eq(r.fatal || null, null, 'D01 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.loadError, null, '假 DOM 就位后 lib/client.js 真加载不抛')
  h.eq(r.hostIsMount, true, '夹具确实给了"最窄稳定祖先"（侧栏列外面还套着一层，不是 document.body）')
  h.eq(r.rows, 1, '侧栏那一行插进去了（恰好 1 个）')
  h.eq(r.targets.join(','), 'mount', `MutationObserver 的 observe() 目标就是那个祖先（实得 ${JSON.stringify(r.targets)}）`)
  h.eq(r.bodyObserved, false, '给了稳定祖先之后**不再**对 document.body 挂观察器')
  h.eq(r.activeObservers, 1, '活动观察器恰好 1 组')
  h.eq(r.opts.every((o) => o.includes('"childList":true') && o.includes('"subtree":true')).toString(), 'true',
    '观察参数就是 childList:true + subtree:true')
  h.eq(r.sidebarEffectNames.length, 1, 'ctx.effect 用**逐字**那句 name 登记了一次释放（whale-sensei: 侧栏入口（新课程））')
  h.eq(r.sidebarEffectNames[0], 'whale-sensei: 侧栏入口（新课程）', '登记名逐字保留')
  h.eq(captured.warn.length, 0, '浏览器半边整个采集期**一声不吭**（console.warn 一条都没有）'
    + (captured.warn.length ? '：' + captured.warn.join(' | ') : ''))
})

C('D02', () => {
  const r = d02
  h.eq(r.fatal || null, null, 'D02 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.rowsBefore, 1, '换根之前恰好 1 行')
  h.eq(r.hostSame, true, '新列接在**同一个**稳定祖先里（真的是"根替换"那一幕）')
  h.eq(r.rowsAfter, 1, '侧栏根被替换后：`[data-dsh-whale-entry]` **恰好 1 个**')
  h.eq(r.underNative, true, '那 1 行紧贴新列里的原生「新建会话」（previousElementSibling 就是它）')
  h.eq(r.inNewCol, true, '那 1 行真的在新列里（不是留在了旧列）')
  h.eq(r.text, '新课程', '行上的字仍是「新课程」')
  h.eq(r.activeObservers, 1, '换根之后活动观察器仍是 1 组（没有越换越多）')
})

C('D03', () => {
  const r = d03
  h.eq(r.fatal || null, null, 'D03 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.rowsAfterFirst, 1, '首次 mount：恰好 1 行')
  h.eq(r.activeAfterFirst, 1, '首次 mount：恰好 1 组活动观察器')
  h.eq(r.rowsAfterSecond, 1, '**未 dispose 再 mount 一次**：行仍是 1 个（唯一所有者）')
  h.eq(r.activeAfterSecond, 1, '未 dispose 再 mount：活动观察器仍是 1 组')
  h.eq(r.sidebarEffectCount, 2, '两次 mount 各登记了一次释放（同一所有者槽）')
  h.eq(r.effectName, 'whale-sensei: 侧栏入口（新课程）', 'dispose 取的是逐字那句 name 登记的回调')
  h.eq(r.disposeType, 'function', 'ctx.effect 登记的回调返回 dispose 函数')
  h.eq(r.rowsAfterDispose, 0, 'dispose() 后：行 0 个')
  h.eq(r.activeAfterDispose, 0, 'dispose() 后：观察器全断')
  h.eq(r.disposeTwiceSafe, true, 'dispose() 幂等：重复调用不报错')
  h.eq(r.rowsAfterDisposeThenDomChange, 0, 'dispose 之后 DOM 再动，也不许把行插回来')
})

C('D04', () => {
  const r = d04
  h.eq(r.fatal || null, null, 'D04 采集不抛' + (r.fatal ? '：' + clip(r.fatal, 300) : ''))
  h.eq(r.rowsAfter, 1, '远处插入/删除 20 次 + 叫醒观察器之后：行数仍是 1（没变成 2）')
  h.eq(r.rowIsSameNode, true, '还是同一行的那个节点（没有被反复重建）')
  h.eq(r.rowInsertsAfter, r.rowInsertsBefore, `那一行的累计插入次数没变（${r.rowInsertsBefore}→${r.rowInsertsAfter}）—— 回调里没有无条件重挂`)
  h.eq(r.observeCallsAfter, r.observeCallsBefore, `观察器没有被反复 observe（调用数 ${r.observeCallsBefore}→${r.observeCallsAfter}）`)
  h.eq(r.observerErrors.length, 0, '叫醒观察器时没炸出"观察风暴"' + (r.observerErrors.length ? '：' + clip(r.observerErrors.join(' | '), 300) : ''))
  h.eq(r.activeObservers, 1, '活动观察器仍是 1 组')
  h.eq(r.underNative, true, '那 1 行仍紧贴原生「新建会话」')
})

const rCase = (id) => () => {
  const r = rRuns.find((x) => x.id === id)
  h.eq(!!r, true, `${id} 真的跑了（命令 ${r ? r.argv.join(' ') : '未执行'}）`)
  if (!r) return
  h.eq(r.spawnError || null, null, `${id} 子进程起得来` + (r.spawnError ? '：' + r.spawnError : ''))
  h.eq(r.timedOut, false, `${id} 没有超时`)
  const v = rVerdict(r)
  h.eq(v.ok, true, `${id} ${r.suite} 实跑 exit=${r.code}，${v.mode === 'verdict' ? '判词' : '摘要'}=${JSON.stringify(v.line)}（期望 exit0 + 0 失败）\n原始尾部：`
    + clip(String(r.out || '').split('\n').slice(-6).join('\n'), 800))
}
C('R01', rCase('R01'))
C('R02', rCase('R02'))
C('R03', rCase('R03'))
C('R04', rCase('R04'))

C('N01', () => {
  h.eq(neg.available, true, '负向控制的锚点 revision 取到了源码' + (neg.reason ? '：' + neg.reason : ''))
  h.eq(neg.baselineHasHook, false, '旧源码里**没有** useRebuildJob（否则"旧实现"不成立）')
  h.eq(neg.currentHasHook, true, '现行源码里**有** useRebuildJob（否则本卡什么都没改）')
  h.eq(neg.tempUnderTempBase, true, `负向控制跑在 E:/Temp 下的临时副本里（${neg.tempFile}）`)
  h.eq(neg.p03 && neg.p03.fatal, null, '旧实现也能被假基座真加载起来（不是加载失败冒充的红）')
  h.eq(negP03.ok, false, 'P03 在固定 revision 的旧实现上**必须红**（关掉也不停 / 没有 abort）—— 实得红：'
    + JSON.stringify(negP03.why))
  h.eq(negP04.ok, false, 'P04 在旧实现上**必须红**（卸载也不停 / 没有 abort）—— 实得红：' + JSON.stringify(negP04.why))
  h.eq(negP05.ok, false, 'P05 在旧实现上**必须红**（旧作业的迟到响应覆盖新作业）—— 实得红：' + JSON.stringify(negP05.why))
  h.eq(neg.removed, true, '临时副本清理成功' + (neg.cleanupError ? '（' + neg.cleanupError + '）' : ''))
  h.eq(!!neg.tempDir && fs.existsSync(neg.tempDir), false, '清理后那个目录确实不在了')
  h.eq(neg.mainHashBefore, neg.mainHashAfter, '负向控制跑完，主仓 lib/client.js 逐字节没变')
  h.eq(srcHashAtEval, srcHashBefore, '判据开始前主仓仍未被碰')
  h.eq(sha256(fs.readFileSync(CLIENT)), srcHashBefore, '此刻主仓 lib/client.js 还是采集前那一份')
})

/* 备注（进 notes.txt，只是索引） */
h.note(`主仓 lib/client.js sha256：采集前 ${srcHashBefore} / 判据前 ${srcHashAtEval}`)
h.note(`P 组：P01 时间轴=${JSON.stringify(pos.P01?.times)}；P02 done 后=${pos.P02?.afterCreate}→${pos.P02?.after10Windows}；P03 ${pos.P03?.beforeClose}→${pos.P03?.after10Windows} aborted=${pos.P03?.aborted}；P04 ${pos.P04?.beforeUnmount}→${pos.P04?.after10Windows} aborted=${pos.P04?.aborted}；P06 时间轴=${JSON.stringify(pos.P06P07?.t4)}`)
h.note(`P05：A 迟到后横幅=${JSON.stringify(clip(pos.P05?.textsAfterLateA, 120))}（含 A-LATE=${String(pos.P05?.textsAfterLateA).includes('A-LATE')}）`)
h.note(`D 组：D01 observe 目标=${JSON.stringify(d01.targets)}；D02 ${d02.rowsBefore}→${d02.rowsAfter}；D03 ${d03.rowsAfterFirst}/${d03.rowsAfterSecond}→${d03.rowsAfterDispose}；D04 插入次数 ${d04.rowInsertsBefore}→${d04.rowInsertsAfter}`)
h.note(`R 组：${rRuns.map((r) => `${r.id}(${r.suite}) exit=${r.code} ${rVerdict(r).line}`).join(' | ')}`)
h.note(`N01：rev=${neg.rev} 可用=${neg.available} 旧实现 P03 红=${!negP03.ok} P04 红=${!negP04.ok} P05 红=${!negP05.ok}`)
h.note(`课程包=${PACK}（可用=${PACK_OK}）；只跑了本卡入口与 R 组点名的四条接触套件，没跑全量`)
h.note('⚠️ 已知影响（**不在本卡写集内**，需规划者裁定）：test/settings-teaching.mjs:320 的 `cursor === 24` 是'
  + '位置式 hook 槽位表。C2 把 GroupPanel 改接 useRebuildJob 后，GroupPanel 的槽位从 6 个（13–18）变成 11 个（13–23），'
  + 'TeachingPanel 顺移到 24–28 ⇒ 总槽位 24→29，那条断言会红（它自己的注释写着"结构变了槽位表要跟着更新"）。'
  + '实测（E:/Temp/whale-T24-probe-cursor.mjs，复刻该套件同一套桩、不需要课程包）：旧源码 cursor=24，现行 cursor=29。')
if (fatal) h.note('采集致命错误：' + clip(String((fatal && fatal.stack) || fatal), 800))

process.exit(h.run())
