/**
 * test/audit/T25.mjs —— 仅键盘完成课程选择与删除确认（卡 T25 / 报告 E03 · P2）
 * ------------------------------------------------------------------
 * 病（旧行为，只读快照里逐行核过）：
 *   · **选择面是 `div + onClick`**：圆圈卡 / 知识点卡 / `+ 新建圆圈` / 两处空态卡都是 `div`
 *     —— 没有 `tabIndex`、没有 `role`、没有键盘处理 ⇒ 键盘用户**根本到不了**这三处；
 *   · **删除确认是手写遮罩**：`key:'delete-modal'` + `position:'fixed'` + `background:'rgba(0,0,0,0.45)'`
 *     的裸 `div` —— 没有模态语义、没有标题关联、没有初焦、没有 Esc、关掉后焦点不还。
 *
 * 本文件判的就是卡面那两句（逐字）：
 *   「全程仅键盘完成选圈/点/开课；删除初焦、Tab范围、Esc、归还焦点均正确，补axe/读屏检查。
 *     本次未跑浏览器可访问性工具。」
 *
 * 怎么判（**真行为**，不是源码关键字）：
 *   ① 假基座 + mini-React **真加载** `lib/client.js`（形状照 test/audit/T19.mjs：`__ModuleLoader__.load`
 *      + `factory(require)` + `apply(ctx)`；hook 槽位**按组件身份**存，重渲染不串台；effect 真跑）；
 *   ② 键盘路径照**浏览器对原生 button 的真实语义**驱动：`Tab` 能到它（原生 button 才在 Tab 序列里）、
 *      `Enter` / `Space` 派发的 `keydown` 在**原生 button** 上会合成一次 click ——
 *      而 `div + onClick` 上按 Enter 什么都不会发生。所以这条判据**真的**能抓住「没换成 button」；
 *   ③ 鼠标路径就是直接调 `onClick`（键盘与鼠标**必须同一条路**：请求序列 + 送出正文逐字相等）；
 *   ④ 删除确认：夹具的 `primitives.Modal` 记录被调用与 props、给子树打对话框标记，
 *      **但不替客户端做初焦**（T25-R2）—— 初焦只能来自产品的效果；
 *      真行为判据（初焦在弹窗内 / 关闭后 `document.activeElement` 回到触发者）由**假 DOM** 观察；
 *   ⑤ **负向控制**：把钉死 revision 的**旧** `lib/client.js` 放进临时副本跑**同一套**检查 ——
 *      K01 / K02 / M01 必须红。revision 取不到 → `h.block`，绝不记 PASS。
 *
 * 固定用例 ID 全集（**不许漂移**，共 14 项）：
 *   K01 K02 K03 K04 K05 M01 M02 M03 M04 M05 M06 R01 R02 N01
 *
 * 验收命令：
 *   `node E:/workplace/dsh-whale-sensei/test/audit/T25.mjs`        → 默认入口**必须 BLOCKED / exit2**
 *     （真实 GUI / axe / 读屏三缺：本机拿不到的要如实列在 missing= 里 —— 这是**预期终态**）
 *   `node E:/workplace/dsh-whale-sensei/test/audit/T25.mjs --auto`  → `PASS T25-AUTO checks=14 failed=0 skipped=0`
 *     （**仅自动矩阵**全绿的唯一证明；不许把它的绿当作整卡 PASS）
 *
 * 铁律：主仓 `lib/client.js` 只读（跑完哈希必须不变）；变异只改 E:/Temp 下的临时副本；
 *      不碰只读快照、不碰用户活包 E:/workplace/study、不跑 `node test/all.mjs` 全量。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createHarness, REPO, clip, makeTempDir, cleanupTempDir } from './harness.mjs'

/* ───────────────────────── 固定用例 ID 全集（14，不许漂移） ───────────────────────── */
const IDS = ['K01', 'K02', 'K03', 'K04', 'K05', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'R01', 'R02', 'N01']

const CLIENT = path.join(REPO, 'lib', 'client.js')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 负向控制的**钉死 revision**：T25 开工时的 HEAD（`d77f361`，T24 已收口）。
 * 用常量而不是 `HEAD` —— 拿会漂的东西当负向控制，判据会随提交自己变绿/变红。
 */
const T25_BASELINE_REV = 'd77f361d25e94c9ae86723267c21f4ee65a3f9eb'

const AUTO = process.argv.slice(2).includes('--auto')

/* ───────────────────────────── 夹具数据 ───────────────────────────── */
const CATALOG = {
  ok: true,
  configured: true,
  canCreate: true,
  circles: [{
    id: 'programming',
    name: '编程',
    points: [{
      id: 'spring-boot',
      name: 'Spring Boot',
      fileBase: 0,
      nextNumber: 1,
      lessons: [],
    }],
  }],
}
const STATUS = { ok: true, configured: true, version: '0.0.0-t25', sections: [] }
const GATE = {
  ok: true,
  configured: true,
  allowed: true,
  verdict: { code: 'ready', lesson: 'programming/spring-boot/0000', total: 0, achieved: 0, missing: [], needsReview: [] },
  prereq: { ok: true, missing: [] },
}
const STARTER_ENTRY = {
  form: { fields: [], title: '新课程', intro: '为它开一门新课', submitLabel: '发送', cancelLabel: '取消' },
  prompt: '开课协议正文（夹具）',
}
const CIRCLE_TEXT = '1 个知识点 · 0 门课'
/** 无头的知识点选择屏标题（`selectCircle` 之后渲染出来的那一句） */
const POINT_HEAD = '在「编程」中选择一个知识点：'
const POINT_TEXT = '已 0 课 · 下一课 第 1 课'
const OPEN_TEXT = '开课请求正文（夹具）：编程 / Spring Boot'
const DELETE_PLAN = {
  id: 'programming',
  name: '编程',
  dir: 'lessons/programming',
  dirs: [{ path: 'lessons/programming', files: 2, bytes: 128 }],
  files: 2,
  bytes: 128,
  lessons: 0,
  lessonIds: [],
  codeDirs: [],
  progressIds: [],
  progressFile: null,
  rebuild: ['node tools/build-lessons.js', 'node tools/build-starmap.js', 'node assets/build-glossary.js', 'node tools/build-notes.js'],
}

/* ───────────────────────── 假 DOM（含 focus / activeElement） ─────────────────────────
 * 形状照 test/panel.mjs:288-364 的 `makeDom`，补三件本卡必需的东西：
 *   ① `focus()` / `document.activeElement` —— 初焦与焦点归还只能**观察**，不能靠源码关键字；
 *   ② `textContent` 可写且会**清空子树**（真 DOM 就是这个语义）；
 *   ③ `isConnected` / `document.contains` —— 焦点归还前要能分辨"还挂在文档上"。
 * 假基座把 `globalThis.document` 指向它，于是 `lib/client.js` 走的**就是**这条路（不是另写一套）。
 */
function makeFakeDom() {
  const focusLog = []
  const eqOf = (inner) => {
    const m = inner.match(/^([^=*]+)(\*=|=)?["']?([^"']*)["']?$/)
    return m || null
  }
  const matchOne = (n, one) => {
    const m = one.trim().match(/^([a-zA-Z]*)((?:\[[^\]]+\])*)$/)
    if (!m) return false
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false
    return (m[2].match(/\[[^\]]+\]/g) || []).every((a) => {
      const inner = a.slice(1, -1)
      const eq = eqOf(inner)
      if (!eq || !eq[2]) return n.getAttribute(inner) !== null
      const have = n.getAttribute(eq[1]) || ''
      return eq[2] === '*=' ? have.split(/\s+/).some((c) => c.includes(eq[3])) : have === eq[3]
    })
  }
  const match = (n, sel) => String(sel).split(',').some((one) => matchOne(n, one))
  const findIn = (root, sel) => {
    const stack = [...root.children]
    while (stack.length) {
      const n = stack.shift()
      if (match(n, sel)) return n
      stack.push(...n.children)
    }
    return null
  }
  const doc = { activeElement: null, _focusLog: focusLog, _attached: new WeakSet() }

  const mk = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(),
      className: '',
      id: '',
      children: [],
      parentElement: null,
      _attrs: {},
      _text: '',
      innerHTML: '',
      style: {},
      disabled: false,
      type: '',
      title: '',
      _on: {},
      /** 对话框归属标记：由假 `primitives.Modal` 在渲染时给子树打上（判"焦点在弹窗内"） */
      __dialog: undefined,
      setAttribute(k, v) { this._attrs[k] = String(v) },
      getAttribute(k) {
        if (k === 'class') return this.className || null
        return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null
      },
      appendChild(c) {
        if (c.parentElement) {
          const i = c.parentElement.children.indexOf(c)
          if (i >= 0) c.parentElement.children.splice(i, 1)
        }
        c.parentElement = this
        this.children.push(c)
        doc._attached.add(c)
        return c
      },
      append(...cs) { cs.forEach((c) => this.appendChild(c)) },
      insertBefore(c, ref) {
        if (c.parentElement) {
          const i = c.parentElement.children.indexOf(c)
          if (i >= 0) c.parentElement.children.splice(i, 1)
        }
        c.parentElement = this
        const at = ref ? this.children.indexOf(ref) : -1
        if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c)
        return c
      },
      remove() {
        const p = this.parentElement
        if (p) {
          const i = p.children.indexOf(this)
          if (i >= 0) p.children.splice(i, 1)
        }
        this.parentElement = null
      },
      contains(o) { let x = o; while (x) { if (x === this) return true; x = x.parentElement } return false },
      addEventListener(t, fn) { this._on[t] = fn },
      removeEventListener(t) { delete this._on[t] },
      matches(sel) { return match(this, sel) },
      closest(sel) { let x = this; while (x) { if (match(x, sel)) return x; x = x.parentElement } return null },
      querySelector(sel) { return findIn(this, sel) },
      querySelectorAll(sel) {
        const out = []
        const walk = (r) => { r.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c) }) }
        walk(this)
        return out
      },
      getBoundingClientRect() { return { left: 0, top: 0, width: 252, height: 38 } },
      get isConnected() { return doc._attached.has(this) && (this === doc.documentElement || doc.documentElement.contains(this)) },
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
      focus() {
        doc.activeElement = this
        focusLog.push({ tagName: this.tagName, text: this.textContent, cls: this.className || '', dialog: this.__dialog, tag: this.tag })
      },
      blur() { if (doc.activeElement === this) doc.activeElement = null },
      set textContent(v) { this._text = String(v); this.children = [] },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join('') },
    }
    return n
  }

  doc.createElement = (t) => mk(t)
  doc.getElementById = () => null
  doc.contains = (n) => !!n && doc.documentElement.contains(n)
  doc.documentElement = mk('html')
  doc.head = mk('head')
  doc.body = mk('body')
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  doc.querySelector = (sel) => findIn(doc.documentElement, sel)
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel)

  /** 造一个"有侧栏"的假文档（侧栏那一行纯 DOM 注入要用它；形状照 test/panel.mjs#withSidebar） */
  doc.withSidebar = () => {
    const col = doc.createElement('div')
    col.setAttribute('data-pane', 'sidebar')
    const logoRow = doc.createElement('div')
    logoRow.className = 'hHd_logoRow'
    const native = doc.createElement('button')
    native.className = 'hHd_newSession'
    col.appendChild(logoRow)
    col.appendChild(native)
    doc.body.appendChild(col)
    return { col, logoRow, native }
  }
  return doc
}

/* ───────────────────── 假基座 + mini-React（渲染级 + 焦点级） ─────────────────────
 * 与 T19 的 bench 同型，四处本卡必需的加强：
 *   ① `useEffect(fn, deps)` 在 deps 变化时真跑 —— 初焦 / 焦点归还都是 effect 干的活；
 *   ② `primitives.Modal` 是**夹具自己的**函数组件：记录 props、给子树打 `__dialog` 标记，
 *      **但不做初焦** —— 真原语的初焦我们测不到，卡面也**不许**假装测到，桩替产品做就是空转；
 *   ③ `globalThis.document` 由本夹具装上（跑完恢复），于是 `lib/client.js` 的焦点代码走真路；
 *   ④ `press(el, key)` 照**浏览器对原生 button 的真实语义**：Tab 能到它、Enter/Space 合成 click，
 *      `div + onClick` 上按同样的键**什么都不会发生**。
 */
function createBench(src, opts = {}) {
  const doc = makeFakeDom()
  if (opts.sidebar) doc.withSidebar()
  const calls = []
  const unknownRoutes = []
  const effectErrors = []
  const clickLog = []
  const drafts = []
  const submits = []
  const modalCalls = []
  const regs = []
  let loadError = null
  let applyError = null
  let renderCount = 0
  let curTree = null
  let mod = null
  let exportsObj = null
  let docSeq = 0
  let fatal = null

  const state = {
    catalog: opts.catalog === undefined ? CATALOG : opts.catalog,
    gate: opts.gate === undefined ? GATE : opts.gate,
    starterGet: opts.starterGet === undefined ? { ok: true, configured: true, entry: STARTER_ENTRY } : opts.starterGet,
    starterPost: opts.starterPost === undefined ? { ok: true, text: OPEN_TEXT } : opts.starterPost,
    deleteDry: opts.deleteDry === undefined ? { ok: true, dryRun: true, plan: DELETE_PLAN } : opts.deleteDry,
    deleteConfirm: opts.deleteConfirm === undefined
      ? { ok: true, files: 2, lessons: 0, progressCleaned: 0, needsRebuild: DELETE_PLAN.rebuild, deleted: ['lessons/programming'] }
      : opts.deleteConfirm,
  }

  /* ── mini-React（hook 槽位按组件身份存；effect 在渲染后按声明顺序跑） ── */
  const hookSlots = new WeakMap()
  const compIds = new WeakMap()
  /** 渲染出来的元素节点 → 它在假 DOM 里的那一颗（`attachRef` 用；同一节点只造一次） */
  const elByNode = new WeakMap()
  /** `type#key` → 跨渲染复用的那一颗真元素（React reconciliation 的最小模型） */
  const elByKey = new Map()
  let compSeq = 0
  let curComp = null
  let cursor = 0
  let pending = false
  let queued = []
  const cidOf = (c) => { let v = compIds.get(c); if (v === undefined) { v = ++compSeq; compIds.set(c, v) } return v }
  const slotsOf = (c) => { let s = hookSlots.get(c); if (!s) { s = []; hookSlots.set(c, s) } return s }

  /**
   * 给一个元素对应的**真元素**打对话框标记（假 Modal 渲染时调用）。
   * ⚠️ 必须在**真元素**上打：`node.__dialog`（虚拟节点）与 `el.__dialog`（真元素）是两样东西，
   * 而"焦点在不在弹窗内"看的是**真元素**（`document.activeElement`）。
   */
  function markEl(node, id) {
    const el = elOf(node)
    if (el) el.__dialog = id
  }
  /** 求值一个函数组件（每个节点只求值一次，结果挂 `__sub`） */
  function evalFn(node) {
    if (!('__sub' in node)) {
      try { node.__sub = node.type(node.props || {}) } catch { node.__sub = null }
    }
    return node.__sub
  }
  /** 对话框里**有名字**的元素才算得上"合理初焦"，不是随便一个空 div */
  function namedFocusables(node, out, id) {
    if (node == null || node === false) return out
    if (Array.isArray(node)) { node.forEach((c) => namedFocusables(c, out, id)); return out }
    if (typeof node !== 'object') return out
    if (typeof node.type === 'function') return namedFocusables(evalFn(node), out, id)
    const el = elOf(node)
    if (el) el.__dialog = id
    // ⚠️ 节点上的"文本"要走 `textOf`（虚拟节点的正文在 `children` 里，**不是** `node.textContent`）
    if (id && el && String(textOf(node) || '').trim()) out.push(node)
    ;(node.children || []).forEach((c) => namedFocusables(c, out, id))
    return out
  }

  const miniReact = {
    createElement(type, p, ...kids) {
      const children = kids.flat(Infinity).filter((k) => k != null && k !== false)
      const props = Object.assign({}, p || {}, { children: children })
      if (typeof type === 'function') {
        // 函数组件带着**它的 props**（含 children）进自己的 hook 上下文：
        // `primitives.Modal` 与 `Card` 都是从 `props.children` 读正文的。
        const pc = curComp
        const pk = cursor
        curComp = type
        cursor = 0
        try { return type(props) } finally { curComp = pc; cursor = pk }
      }
      const node = { type, props, children }
      // 宿主元素：照 React 的挂载语义造一颗真元素并调 `ref`。
      // ⚠️ **带 key 的元素跨渲染复用同一颗真元素**（React 的 reconciliation 正是如此：
      //    同一个 key 的真 DOM 节点在重渲染时是**同一个对象**）。不复用的话，客户端存下的
      //    "触发者"会被下一次渲染的 ref 回调覆盖成一颗游离节点 —— "焦点归还"就永远判不成。
      try {
        const cacheKey = (props.key === undefined || props.key === null) ? null : type + '#' + String(props.key)
        const cached = cacheKey ? elByKey.get(cacheKey) : null
        const el = cached || doc.createElement(type)
        if (cacheKey && !cached) elByKey.set(cacheKey, el)
        el.className = props.className || ''
        if (props.disabled !== undefined) el.disabled = !!props.disabled
        if (props.type !== undefined) el.type = props.type
        for (const k of Object.keys(props)) {
          if (k === 'style' || k === 'children') continue
          const v = props[k]
          if (v === null || v === undefined || v === false) continue
          el.setAttribute(k, typeof v === 'function' ? 'fn' : String(v))
        }
        elByNode.set(node, el)
        // 真元素上也要有正文：`document.activeElement` 只能看到**真元素**，
        // 而 M03/M05 要能认出"焦点落在谁身上"（不然三颗按钮长得一模一样）。
        const txt = textOf(node)
        if (txt) el.textContent = txt
        if (typeof props.ref === 'function') props.ref(el)
      } catch (e) { effectErrors.push('挂载真元素失败：' + String((e && e.message) || e)) }
      return node
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

  /**
   * 假原语：`Modal` 是**函数组件**（与真宿主一致）—— 记录 `props` + 给可聚焦元素打对话框标记
   * + 构造 `data-modal` 外壳。⚠️ **桩不做初焦**（T25-R2）：那一半是产品的效果
   * （`focusEl(deleteModalFocusTarget)`），夹具替它做就等于让 `M03`/`M04` 空转。
   */
  const primitives = {
    Button: function Button(props) {
      return miniReact.createElement('button', { type: 'button', onClick: props.onClick, disabled: props.disabled, 'data-variant': props.variant }, props.children)
    },
    Modal: function Modal(props) {
      modalCalls.push({ title: props.title, hasOnClose: typeof props.onClose === 'function', open: props.open, keys: Object.keys(props), onClose: props.onClose })
      const kids = props.children
      const id = ++docSeq
      const childArr = Array.isArray(kids) ? kids : (kids == null || kids === false ? [] : [kids])
      childArr.forEach((c) => namedFocusables(c, [], id))
      // ⚠️ **桩不替客户端做初焦**（T25-R2）：真宿主挂载时会把焦点移进对话框，但"初焦落在谁身上"
      // 是客户端那一半（产品的 `focusEl(deleteModalFocusTarget)`），夹具**不许**替它做 ——
      // 桩自己 `focus()` 会让 `M03`/`M04` 由夹具满足：产品失能不红，就是真假绿。
      // 所以这里只做模型该做的两件：记 `modalCalls`（上面）与给可聚焦元素打对话框标记（上面），
      // 焦点一律由产品的效果决定（夹具已按 React 语义调 `props.ref`，产品拿得到那颗真元素）。
      // 对话框外壳也走 createElement（于是它同样有"真元素"，`__modal` 只挂在**外壳**上）
      const box = miniReact.createElement('div', { 'data-modal': props.title }, ...childArr)
      box.__modal = true
      return box
    },
  }

  const asked = []
  const req = (n) => {
    asked.push(n)
    if (n === 'react') return miniReact
    if (n === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('客户端 require 了没声明的包：' + n)
  }

  /* ── fetch 记账（不排队，按路由回夹具数据） ── */
  const realFetch = globalThis.fetch
  globalThis.fetch = function (url, init) {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    let body = null
    if (init && init.body) {
      try { body = JSON.parse(init.body) } catch (e) { body = { __unparsable: String(init.body) } }
    }
    calls.push({ url: u, method, body, seq: calls.length })
    const json = (payload) => Promise.resolve({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    })
    if (u.indexOf('/api/whale/status') === 0) return json(STATUS)
    if (u.indexOf('/api/whale/catalog') === 0) return json(state.catalog)
    if (u.indexOf('/api/whale/teaching') === 0) return json({ ok: true, configured: false, error: 'T25 夹具：本卡不测教学方式' })
    if (u.indexOf('/api/whale/gate') === 0) return json(state.gate)
    if (u.indexOf('/api/whale/starter') === 0) return json(method === 'POST' ? state.starterPost : state.starterGet)
    if (u.indexOf('/api/whale/circle/delete') === 0) {
      return json((body && body.confirm === true) ? state.deleteConfirm : state.deleteDry)
    }
    unknownRoutes.push(method + ' ' + u)
    return json({ ok: false, error: 'T25 夹具没有这条假路由：' + method + ' ' + u })
  }

  const fakeWindow = {
    __ModuleLoader__: { load: (m) => { mod = m } },
    setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms || 0)),
    clearInterval: (t) => clearInterval(t),
    prompt: () => {},
    open: () => {},
    document: doc,
  }

  const realDoc = globalThis.document
  if (opts.focus) globalThis.document = doc

  /** 客户端会往 console.log 写产品日志（"新课程：已发送…"）—— 夹具期把它收进盒子里，
   *  免得本卡验收的 stdout 被别的行污染（harness 的判词要求 stdout/stderr 合计只有一行）。 */
  const realConsoleLog = console.log
  const consoleLines = []
  console.log = function (...args) { consoleLines.push(args.map((a) => String(a)).join(' ')) }

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
  const dialogReg = regs.find((r) => r.spec && r.spec.name === 'shell.overlay')
  const bridgeReg = regs.find((r) => r.spec && r.spec.id === 'whale-bridge')
  const panelComp = settingsReg ? settingsReg.comp : null
  const dialogComp = dialogReg ? dialogReg.comp : null

  // composer 桥：先挂一次，让 `composerActions` 拿到宿主给的 setDraft / submit
  if (bridgeReg) {
    try {
      bridgeReg.comp({ inputActions: { setDraft: (t) => drafts.push(String(t)), submit: () => submits.push(true) } })
    } catch (e) { effectErrors.push('composer 桥：' + String((e && e.message) || e)) }
  }

  /* ── 渲染 / 收敛 ── */
  const drain = () => new Promise((r) => setTimeout(r, 0))
  /** 让已经排上的 0ms 定时器真的跑完（客户端的 `window.setTimeout(...send...)` 就是靠它驱动的） */
  const runAfterFlush = async () => { await new Promise((r) => setTimeout(r, 5)) }
  function renderOnce(rootComp) {
    if (!rootComp) return null
    queued = []
    pending = false
    curComp = null
    cursor = 0
    const tree = miniReact.createElement(rootComp, {})
    const list = queued.slice()
    queued = []
    for (const item of list) {
      try { item.fn() } catch (e) { effectErrors.push(String((e && e.message) || e)) }
    }
    renderCount++
    return tree
  }
  async function settle(maxRounds = 40) {
    const rootComp = opts.panel ? panelComp : dialogComp
    if (!rootComp) return null
    pending = true
    for (let i = 0; i < maxRounds && pending; i++) {
      curTree = renderOnce(rootComp)
      await drain()
    }
    return curTree
  }
  /** 弹窗的开关在 `useDialogOpen()` 的槽位 0 上（组件身份就是弹窗组件）——夹具直接把它置上 */
  function openDialog() {
    if (!dialogComp) return false
    const s = slotsOf(dialogComp)
    s[0] = true
    pending = true
    return true
  }

  /** 树上查（函数组件求值一次后递归进去；`0` / `''` 之类**不许**当噪声丢掉） */
  function walk(node, visit) {
    if (node == null || node === false) return
    if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') { walk(evalFn(node), visit); return }
    visit(node)
    if (node.children) for (const c of node.children) walk(c, visit)
  }
  function textOf(node) {
    if (node == null || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (typeof node !== 'object') return ''
    if (typeof node.type === 'function') return textOf(evalFn(node))
    return (node.children || []).map(textOf).join('')
  }
  const collect = (tree, pred) => { const out = []; walk(tree, (n) => { if (pred(n)) out.push(n) }); return out }
  const buttons = (tree) => collect(tree, (n) => n.type === 'button')
  const buttonByText = (tree, text) => buttons(tree).find((b) => textOf(b) === text) || null
  /** 同样的按钮在树上有多颗时（设置卡里嵌了多块、`key` 相同）取**最后一颗**：
   *  它才是这一遍渲染里"活着"的那一份；取第一颗会点到上一遍留下的那份（事件挂在上一遍上）。 */
  const buttonByTextLast = (tree, text) => {
    const all = buttons(tree).filter((b) => textOf(b) === text)
    return all.length ? all[all.length - 1] : null
  }
  const buttonByKey = (tree, key) => collect(tree, (n) => n.type === 'button' && n.props && n.props.key === key)[0] || null
  const inputByPlaceholder = (tree, ph) => collect(tree, (n) => n.type === 'input' && n.props && n.props.placeholder === ph)[0] || null
  /** 主选择面卡片：**带 onClick** 的元素（`div + onClick` 的旧卡也会被这里捞到 —— K01 正是靠它判红） */
  const clickable = (tree, needle) => collect(tree, (n) => (n.type === 'div' || n.type === 'button') && n.props && typeof n.props.onClick === 'function' && textOf(n).indexOf(needle) >= 0)
  const circleCard = (tree) => clickable(tree, CIRCLE_TEXT)[0] || null
  const pointCard = (tree) => clickable(tree, POINT_TEXT)[0] || null
  const emptyCards = (tree) => clickable(tree, '直接填表开课')
  const modalNodes = (tree) => collect(tree, (n) => n.__modal === true)

  /* ── 交互：鼠标与键盘 ── */
  function fireClick(node, label) {
    const ev = { stopped: 0, preventDefault: 0, stopPropagation() { ev.stopped++ }, preventDefaultFn() { ev.preventDefault++ }, target: node, currentTarget: node }
    let error = null
    try { node.props.onClick(ev) } catch (e) { error = e }
    const entry = { label, how: 'click', tag: node.type, stopPropagationCalls: ev.stopped, error: error ? String((error && error.message) || error) : null }
    clickLog.push(entry)
    pending = true
    return entry
  }
  /**
   * 按一个键。**照浏览器对原生 button 的真实语义**：
   *   `Tab`  → 元素在 Tab 序列里（原生 button / input / textarea / a[href] / 显式 tabIndex 才算）
   *   `Enter`/`Space` → **原生 button** 上合成一次 click；`div + onClick` 上什么都不会发生
   */
  function press(node, key, label) {
    const ev = { stopped: 0, preventDefault: 0, key, stopPropagation() { ev.stopped++ }, preventDefault() { ev.preventDefault++ }, target: node, currentTarget: node }
    let error = null
    try {
      if (node.props && typeof node.props.onKeyDown === 'function') node.props.onKeyDown(ev)
      if (key === 'Tab') {
        const tag = node.type
        const focusable = tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select'
          || (tag === 'a' && node.props && node.props.href) || (node.props && node.props.tabIndex !== undefined)
        if (!focusable) throw new Error('这个元素不在 Tab 序列里（' + tag + '）—— 键盘到不了')
      } else if (key === 'Enter' || key === ' ') {
        if (node.type !== 'button') {
          throw new Error('原生 button 才会把 Enter/Space 合成 click；这是 ' + node.type + ' —— 键盘激活无效')
        }
        if (node.props && node.props.disabled) throw new Error('button 是 disabled 的，按不动')
        if (node.props && typeof node.props.onClick === 'function') node.props.onClick(ev)
      }
    } catch (e) { error = e }
    const entry = {
      label, how: key === 'Tab' ? 'tab' : 'key', key, tag: node.type,
      stopPropagationCalls: ev.stopped,
      error: error ? String((error && error.message) || error) : null,
    }
    clickLog.push(entry)
    pending = true
    return entry
  }

  const restore = () => {
    globalThis.fetch = realFetch
    if (opts.focus) globalThis.document = realDoc
    console.log = realConsoleLog
  }

  /**
   * 给一个**渲染出来的元素节点**补上它的"真元素"（假 DOM 里的一颗），
   * 并把该节点的 `ref` 回调按 React 的方式调一次 —— 客户端正是靠这个 ref 拿到触发者。
   * 同一节点只造一颗（形状照 React 的挂载语义），于是"焦点归还"能按**对象身份**比。
   */
  function attachRef(node) {
    if (!node) return null
    // 渲染时已经造过的那一颗**必须复用**（`client.js` 存的就是它；另造一颗会让"焦点归还"按身份比不中）
    let el = elByNode.get(node) || null
    if (!el) {
      el = doc.createElement(node.type)
      elByNode.set(node, el)
    }
    const txt = textOf(node)
    if (txt) el.textContent = txt
    if (node.props && typeof node.props.ref === 'function') {
      try { node.props.ref(el) } catch (e) { effectErrors.push(String((e && e.message) || e)) }
    }
    return el
  }
  /** 假 DOM 里那颗对应的真元素 */
  const elOf = (node) => elByNode.get(node) || null

  return {
    doc,
    get tree() { return curTree },
    get mod() { return mod },
    get exportsObj() { return exportsObj },
    get loadError() { return loadError },
    get applyError() { return applyError },
    get renderCount() { return renderCount },
    get fatal() { return fatal },
    set fatal(v) { fatal = v },
    state, calls, unknownRoutes, effectErrors, clickLog, drafts, submits, modalCalls, regs, asked,
    hasSettingsSection: !!panelComp,
    hasDialog: !!dialogComp,
    panelComp, dialogComp,
    rootCompType: panelComp ? 'function' : null,
    factoryType: mod ? typeof mod.factory : null,
    applyType: exportsObj ? typeof exportsObj.apply : null,
    activeEl: () => doc.activeElement,
    settle, renderOnce, openDialog, fireClick, press, attachRef, runAfterFlush,
    walk, textOf, collect, buttons, buttonByText, buttonByKey, inputByPlaceholder,
    clickable, circleCard, pointCard, emptyCards, modalNodes, namedFocusables,
    restore,
  }
}

/* ───────────────────── 场景 1：仅键盘走完选圈 → 选点 → 开课 ───────────────────── */
/**
 * @param {string} src 源码（主仓或临时副本）
 * @param {{how:'key'|'click'}} o 键盘路径 / 鼠标路径
 * @returns {object} 每一步的**可观察**记录（树上的元素类型、渲染文本、请求序列、送出正文）
 */
async function runWizard(src, o) {
  const how = (o && o.how) || 'key'
  const b = createBench(src, { focus: false, panel: false })
  const out = {
    how,
    loadError: null, applyError: null, hasDialog: false, fatal: null, renderCount: 0,
    circlesCards: [], pointsCards: [], emptyCardsNow: [], newCircleBtn: null, newPointBtn: null,
    tabs: [], keys: [],
    textAfterCircle: '', textAfterPointPress: '', textAfterOpen: '',
    finalCalls: [], drafts: [], submits: [],
    effectErrors: [], unknownRoutes: [],
  }
  try {
    if (b.loadError || b.applyError || !b.hasDialog) return out
    out.hasDialog = true
    await b.settle()
    if (!b.openDialog()) return out
    await b.settle()
    const first = b.tree
    if (!first) return out
    out.circlesCards = b.clickable(first, CIRCLE_TEXT).map((n) => ({ tag: n.type, propsType: n.props.type, key: n.props.key, text: b.textOf(n) }))
    out.emptyCardsNow = b.emptyCards(first).map((n) => ({ tag: n.type, propsType: n.props ? n.props.type : null }))
    const nc = b.buttonByKey(first, 'new-circle-btn')
    out.newCircleBtn = nc ? { tag: 'button', text: b.textOf(nc) } : null
    const np = b.buttonByKey(first, 'new-point-btn')
    out.newPointBtn = np ? { tag: 'button', text: b.textOf(np) } : null

    const circle = b.circleCard(b.tree)
    if (!circle) return out
    if (how === 'key') {
      out.tabs.push(b.press(circle, 'Tab', 'tab-to-circle'))
      out.keys.push(b.press(circle, 'Enter', 'enter-circle'))
    } else {
      out.keys.push(b.fireClick(circle, 'click-circle'))
    }
    await b.settle()
    out.textAfterCircle = b.textOf(b.tree).slice(0, 240)

    const point = b.pointCard(b.tree)
    out.pointsCards = point ? [{ tag: point.type, propsType: point.props.type, key: point.props.key, text: b.textOf(point) }] : []
    if (!point) return out
    if (how === 'key') out.tabs.push(b.press(point, 'Tab', 'tab-to-point'))
    // ① 先按第一下把门禁取回来（`selectPoint` 读的是**渲染闭包里的** gates —— 第一下通常只触发取判词）
    out.tabs.push(b.press(point, 'Tab', 'tab-to-point'))
    out.keys.push(how === 'key' ? b.press(point, 'Enter', 'enter-point-load-gates') : b.fireClick(point, 'click-point-load-gates'))
    // 客户端把「开课」排在 `window.setTimeout(..., 0)` 上：先让这一轮定时器真的跑完，再收敛
    await b.runAfterFlush()
    await b.settle()
    out.textAfterPointPress = b.textOf(b.tree).slice(0, 240)
    out.gateBack = b.calls.some((c) => c.url.indexOf('/api/whale/gate') === 0)
    // ② 第一下如果是"拦住的"（判词还没回来）就还没发；那就在判词回来之后再按第二下（真用户正是这样）。
    //    已经发出去的就**不再按** —— 否则同一张卡连按两次，那本来就会送两条（与本卡判据无关）。
    const sentAlready = b.drafts.length > 0
    const point2 = b.pointCard(b.tree)
    if (point2 && out.gateBack && !sentAlready) {
      out.keys.push(how === 'key' ? b.press(point2, 'Enter', 'enter-point') : b.fireClick(point2, 'click-point'))
      await b.settle()
    }
    out.textAfterOpen = b.textOf(b.tree).slice(0, 240)
    out.renderCount = b.renderCount
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  } finally {
    out.finalCalls = b.calls.map((c) => ({ url: c.url, method: c.method, body: c.body }))
    out.drafts = b.drafts.slice()
    out.submits = b.submits.slice()
    out.effectErrors = b.effectErrors.slice()
    out.unknownRoutes = b.unknownRoutes.slice()
    out.loadError = b.loadError ? String((b.loadError && b.loadError.message) || b.loadError) : null
    out.applyError = b.applyError ? String((b.applyError && b.applyError.message) || b.applyError) : null
    b.restore()
  }
  return out
}

/* ───────────────────── 场景 2：删除确认（Modal / 初焦 / Esc / 焦点归还） ─────────────────────
 * 这里渲染的是**设置卡**（settings.section 那个组件，内含「课程目录」）—— 删除入口就在那儿。
 * 假 DOM 真的装上（焦点只能这样观察），触发者先真拿到焦点，再走「删除」→ 弹窗 → onClose。
 */
async function runDelete(src) {
  const b = createBench(src, { focus: true, panel: true })
  const out = {
    loadError: null, applyError: null, fatal: null,
    panelRendered: false, deleteBtnFound: false, triggerFocused: false,
    modalCalls: 0, modalTitle: null, modalHasOnClose: null, modalPropKeys: null,
    overlayDivs: 0, fixedInsetDivs: 0,
    activeInDialog: null, activeIsTrigger: null, activeIsBody: null, focusedText: '',
    activeAfterClose: null, restoredToTrigger: null, stillOpenAfterEsc: null,
    cancelBtn: null, confirmBtn: null, confirmDisabled: null, confirmText: null, cancelText: null,
    textAfterOpen: '', calls: [], effectErrors: [], unknownRoutes: [], clickLog: [],
  }
  try {
    if (b.loadError || b.applyError || !b.hasSettingsSection) return out
    await b.settle()
    if (!b.tree) return out
    out.panelRendered = true
    // 取**第一颗**「删除」：设置卡树上可能同时挂着两块（`key` 相同 —— `StatusPanel` 把
    // `CatalogPanel` 求值了两遍），而事件与弹窗挂在**先**出现的那一份上，所以点它。
    const delBtn = b.buttonByText(b.tree, '删除')
    out.deleteBtnFound = !!delBtn
    if (!delBtn) return out
    // 触发者本人（渲染时 `ref` 回调挂上去的那颗**真元素**）先真的拿到焦点：
    // 真用户是 Tab 到它再按回车；`openDelete` 读的 `document.activeElement` 就是它。
    // ⚠️ 必须用**渲染时造过的那一颗**（`elByNode` 里缓存的），另造一颗身份就对不上了。
    const trig = b.attachRef(delBtn)
    // 触发者真的挂在文档上（真用户点的就是文档里那颗按钮；`isAttachedEl` 之后要判它还在不在）
    if (trig) {
      try { b.doc.body.appendChild(trig) } catch (e) { out.effectErrors.push(String((e && e.message) || e)) }
      trig.focus()
    }
    out.triggerFocused = !!trig
    b.fireClick(delBtn, 'click-delete')
    await b.settle()
    out.calls = b.calls.map((c) => ({ url: c.url, method: c.method, body: c.body }))
    const modal = b.modalNodes(b.tree)[0] || null
    out.modalCalls = b.modalCalls.length
    if (b.modalCalls.length) {
      const last = b.modalCalls[b.modalCalls.length - 1]
      out.modalTitle = last.title
      out.modalHasOnClose = last.hasOnClose
      out.modalPropKeys = last.keys
    }
    if (modal) {
      out.overlayDivs = b.collect(modal, (n) => n.type === 'div' && n.props && n.props.style
        && n.props.style.background === 'rgba(0,0,0,0.45)').length
      out.fixedInsetDivs = b.collect(modal, (n) => n.type === 'div' && n.props && n.props.style
        && n.props.style.position === 'fixed' && n.props.style.inset === '0').length
      out.textAfterOpen = b.textOf(modal).slice(0, 260)
      out.cancelBtn = b.buttonByText(modal, '取消') ? 'button' : null
      out.cancelText = b.buttonByText(modal, '取消') ? b.textOf(b.buttonByText(modal, '取消')) : null
      const okBtn = b.buttonByText(modal, '确认删除')
      out.confirmBtn = okBtn ? 'button' : null
      out.confirmDisabled = okBtn ? !!okBtn.props.disabled : null
      out.confirmText = okBtn ? b.textOf(okBtn) : null
    }
    // 初焦：必须在**弹窗内**、不是触发者、不是 body
    const a = b.doc.activeElement
    out.focusedText = a ? String(a.textContent || '').slice(0, 40) : ''
    out.activeInDialog = !!(a && a.__dialog !== undefined)
    out.activeIsTrigger = !!(a && trig && a === trig)
    out.activeIsBody = !!(a && b.doc.body && a === b.doc.body)
    // Esc / 取消：走 `onClose`（真原语的 Esc 就是它）
    if (b.modalCalls.length) {
      const last = b.modalCalls[b.modalCalls.length - 1]
      if (typeof last.onClose === 'function') {
        try { last.onClose() } catch (e) { out.effectErrors.push(String((e && e.message) || e)) }
        await b.settle()
        out.stillOpenAfterEsc = !!b.modalNodes(b.tree)[0]
        const a2 = b.doc.activeElement
        out.activeAfterClose = a2 ? String(a2.textContent || '').slice(0, 40) : null
        out.restoredToTrigger = !!(a2 && trig && a2 === trig)
      }
    }
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  } finally {
    out.effectErrors = out.effectErrors.concat(b.effectErrors.slice())
    out.unknownRoutes = b.unknownRoutes.slice()
    out.clickLog = b.clickLog.slice()
    out.loadError = b.loadError ? String((b.loadError && b.loadError.message) || b.loadError) : null
    out.applyError = b.applyError ? String((b.applyError && b.applyError.message) || b.applyError) : null
    b.restore()
  }
  return out
}

/* ───────────────────── 场景 3：`+ 新建圆圈` 键盘开/收 ───────────────────── */
async function runNewCircle(src) {
  const b = createBench(src, { focus: false, panel: false })
  const out = {
    loadError: null, applyError: null, fatal: null,
    tag: null, propsType: null, tabbable: null, keyError: null,
    formOpen: false, nameInput: false, idInput: false, createBtn: false, cancelBtn: false,
    formClosedAfterCancel: false, effectErrors: [], unknownRoutes: [],
  }
  try {
    if (b.loadError || b.applyError || !b.hasDialog) return out
    await b.settle()
    if (!b.openDialog()) return out
    await b.settle()
    const btn = b.buttonByKey(b.tree, 'new-circle-btn')
    if (!btn) return out
    out.tag = btn.type
    out.propsType = btn.props.type
    const t = b.press(btn, 'Tab', 'tab-new-circle')
    out.tabbable = !t.error
    const e = b.press(btn, 'Enter', 'enter-new-circle')
    out.keyError = e.error
    await b.settle()
    const t2 = b.tree
    out.nameInput = !!b.inputByPlaceholder(t2, '显示名（如「数学」）')
    out.idInput = !!b.inputByPlaceholder(t2, '目录 id（如 math）')
    out.formOpen = out.nameInput
    out.createBtn = !!b.buttonByText(t2, '创建')
    const cancel = b.buttonByText(t2, '取消')
    out.cancelBtn = !!cancel
    if (cancel) {
      b.fireClick(cancel, 'cancel-new-circle')
      await b.settle()
      out.formClosedAfterCancel = !b.inputByPlaceholder(b.tree, '显示名（如「数学」）')
    }
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  } finally {
    out.effectErrors = b.effectErrors.slice()
    out.unknownRoutes = b.unknownRoutes.slice()
    out.loadError = b.loadError ? String((b.loadError && b.loadError.message) || b.loadError) : null
    out.applyError = b.applyError ? String((b.applyError && b.applyError.message) || b.applyError) : null
    b.restore()
  }
  return out
}

/* ───────────────────── 静态 a11y 子集（axe 的**替代品**，不是 axe） ─────────────────────
 * C3 的 axe 层要求"真页面 + axe-core 注入"；本机拿不到那个真页面（见文件末的三缺证据），
 * 于是自动层只做**能从渲染树上看出来的**那一小部分：每个控件必须有可及名。
 * ⚠️ 它**不冒充 axe**：回执与证据里一律写清楚这一层只是静态子集。
 */
function staticA11y(tree, textOf, walk) {
  const viol = []
  const nodes = []
  walk(tree, (n) => nodes.push(n))
  for (const n of nodes) {
    const tag = n.type
    if (typeof tag !== 'string') continue
    const props = n.props || {}
    if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'a') {
      const name = String(textOf(n) || '').trim() || props['aria-label'] || props.title || props.placeholder || ''
      if (!name) viol.push({ id: 'nameless-control', tag, keys: Object.keys(props).join(',') })
    }
    if (tag === 'img' && !props.alt) viol.push({ id: 'image-alt', tag })
    if (props.role === 'link' && props.tabIndex === undefined) viol.push({ id: 'link-has-no-tabindex', tag })
    if (props.role === 'dialog' && props['aria-modal'] === undefined) viol.push({ id: 'dialog-no-aria-modal', tag })
  }
  return viol
}

/* ───────────────────── 负向控制：钉死 revision 的旧 client.js ───────────────────── */
function gitShow(rev, file) {
  return spawnSync('git', ['show', `${rev}:${file}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

async function runNegativeControl() {
  const out = {
    rev: T25_BASELINE_REV,
    available: false, reason: null, baselineBytes: null,
    tempDir: null, tempFile: null, tempUnderTempBase: false, removed: false, cleanupError: null,
    hasManualOverlay: null, oldModalPrimitiveUse: null, oldHasDeleteTitle: null,
    k01: null, k02: null, m01: null, wizFatal: null, delFatal: null,
    oldCardTag: null, oldTextAfterCircleLen: null, oldModalCalls: null, oldOverlayDivs: null,
  }
  const avail = spawnSync('git', ['cat-file', '-e', `${T25_BASELINE_REV}^{commit}`], { cwd: REPO, encoding: 'utf8' })
  if (avail.status !== 0) {
    out.reason = `固定 revision 取不到：${T25_BASELINE_REV}（git cat-file -e 退出码 ${avail.status}${avail.error ? '；' + avail.error.message : ''}）`
    return out
  }
  const shown = gitShow(T25_BASELINE_REV, 'lib/client.js')
  if (shown.status !== 0 || !shown.stdout) {
    out.reason = `固定 revision 里取不到 lib/client.js（退出码 ${shown.status}）`
    return out
  }
  const oldSrc = shown.stdout
  out.available = true
  out.baselineBytes = Buffer.byteLength(oldSrc, 'utf8')
  const count = (re) => (oldSrc.match(re) || []).length
  out.hasManualOverlay = count(/background:\s*'rgba\(0,0,0,0\.45\)'/g)
  out.oldModalPrimitiveUse = count(/createElement\(primitives\.Modal/g)
  out.oldHasDeleteTitle = oldSrc.indexOf("'删除知识圆圈「' + del.circleName + '」'") >= 0

  const dir = makeTempDir('dsh-whale-t25')
  out.tempDir = path.resolve(dir)
  out.tempUnderTempBase = out.tempDir.startsWith(path.resolve(os.tmpdir()) + path.sep)
  try {
    const libDir = path.join(out.tempDir, 'lib')
    fs.mkdirSync(libDir, { recursive: true })
    out.tempFile = path.resolve(path.join(libDir, 'client.js'))
    fs.writeFileSync(out.tempFile, oldSrc, 'utf8')

    // K01 / K02 在旧实现上（同一套键盘判据）
    const wiz = await runWizard(oldSrc, { how: 'key' })
    out.wizFatal = wiz.fatal
    const card = (wiz.circlesCards || [])[0] || null
    out.oldCardTag = card ? card.tag : null
    out.oldTextAfterCircleLen = (wiz.textAfterCircle || '').length
    out.k01 = !!(card && card.tag === 'button' && card.propsType === 'button')
    out.k02 = (wiz.textAfterCircle || '').indexOf(POINT_HEAD) >= 0
    out.k03 = (wiz.finalCalls || []).some((c) => c.method === 'POST' && c.url === '/api/whale/starter')

    // M01 在旧实现上：删除确认**不是** primitives.Modal（手写遮罩那条缝还在）
    const delRun = await runDelete(oldSrc)
    out.delFatal = delRun.fatal
    out.oldModalCalls = delRun.modalCalls
    out.oldOverlayDivs = delRun.overlayDivs
    out.m01 = delRun.modalCalls > 0
  } catch (e) {
    out.reason = String((e && e.stack) || e)
  } finally {
    const c = cleanupTempDir(dir, 't25')
    out.removed = c.removed
    out.cleanupError = c.error
  }
  return out
}

/* ───────────────────── R01 / R02：接触面回归（原样实跑） ───────────────────── */
function runChildRaw(argv, timeoutMs) {
  const started = Date.now()
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  })
  const ms = Date.now() - started
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'
  return {
    argv: argv.join(' '),
    code: typeof r.status === 'number' ? r.status : null,
    out: String(r.stdout ?? ''),
    err: String(r.stderr ?? '') + (r.error ? '\n' + String(r.error.message ?? r.error) : ''),
    ms, timedOut,
  }
}

/* ───────────────────── 三缺证据：真实 GUI / axe / 读屏（本机实测，逐项留原始凭据） ─────────────────────
 * 用户 2026-10-18 的裁定：**真实 GUI、axe、读屏缺任一项 → 整卡 BLOCKED / exit2**，不拿模拟层冒充。
 * 这里把三项"为什么拿不到"的**原始探测**跑一遍（不猜、不编）：
 *   · 真实 GUI：宿主 GUI（本机 http://127.0.0.1:57680）—— 探测 HTTP 状态。`lib/client.js` 只活在
 *     DSH 宿主里，没有任何可独立加载它的页面；而驱动用户**正在用的**那个 GUI 会动到他的会话/草稿，
 *     所以本卡不碰它，只留一个只读探测 + 如实记 `real-gui-unverified`。
 *   · axe：`axe-core` 已装成 **devDependency**（`node_modules/axe-core/axe.min.js`），但 axe 要注入
 *     **真页面**才有意义；真页面同上拿不到 ⇒ `axe-unverified`（自动层只做静态子集，**它不冒充 axe**）。
 *   · 读屏：本机没有任何可自动化的读屏路径（Windows Narrator / NVDA 都无法在无人值守下取得可复现证据）
 *     ⇒ `screen-reader-unverified`（**预期终态**）。
 */
async function probeRealGui() {
  const out = { url: 'http://127.0.0.1:57680/', status: null, authed: null, contentType: null, note: null, error: null }
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    let r = null
    try {
      r = await fetch(out.url, { method: 'GET', redirect: 'manual', signal: ctl.signal })
    } finally { clearTimeout(t) }
    out.status = r.status
    out.authed = r.status >= 200 && r.status < 300
    out.contentType = r.headers.get('content-type')
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  out.note = out.authed === true
    ? '宿主 GUI 可无凭据访问 —— 但仍需"页面里真的挂着本插件的选择面/删除弹窗"才算真 GUI 证据'
    : `宿主 GUI 拒绝匿名访问（HTTP ${out.status === null ? out.error : out.status}）⇒ 拿不到"本插件在真宿主里渲染成什么样"`
  return out
}

function probeAxeTool() {
  const p = path.join(REPO, 'node_modules', 'axe-core', 'axe.min.js')
  let bytes = null
  try { if (fs.existsSync(p)) bytes = fs.statSync(p).size } catch (e) { /* 记 null */ }
  return {
    devDependency: true,
    path: p,
    bytes,
    installed: !!bytes,
    note: 'axe-core 只作 devDependency（不进 dsh.client.external、不进客户端运行依赖）；'
      + '要在**真页面**上注入跑一次才算 axe 层，而真页面本机拿不到 ⇒ axe-unverified',
  }
}

/* ─────────────────────────────── 采集 ─────────────────────────────── */
const h = createHarness({ card: AUTO ? 'T25-AUTO' : 'T25', expectedIds: IDS })

let fatal = null
let src = ''
let srcHashBefore = null
let srcHashAfter = null
let posKey = {}
let posClick = {}
let posNewCircle = {}
let del = {}
let neg = {}
let a11y = { violations: [], checked: 0 }
let guiProbe = { url: '', status: null, authed: null, note: '', error: null }
let axeProbe = { installed: false, bytes: null, path: '', note: '' }
let r01 = { argv: '', code: null, out: '', err: '', ms: 0, timedOut: false }
let r02 = { argv: '', code: null, out: '', err: '', ms: 0, timedOut: false }

try {
  src = fs.readFileSync(CLIENT, 'utf8')
  srcHashBefore = sha256(src)
  posKey = await runWizard(src, { how: 'key' })
  posClick = await runWizard(src, { how: 'click' })
  posNewCircle = await runNewCircle(src)
  del = await runDelete(src)
  // 静态 a11y 子集：拿正向那棵树（圆圈屏 + 知识点屏的按钮都过一遍）
  const benchA11y = createBench(src, { focus: false, panel: false })
  await benchA11y.settle()
  benchA11y.openDialog()
  await benchA11y.settle()
  a11y.violations = staticA11y(benchA11y.tree, benchA11y.textOf, benchA11y.walk)
  a11y.checked = benchA11y.buttons(benchA11y.tree).length
  benchA11y.restore()
  // 三缺证据的原始探测（只读、不改任何东西）
  guiProbe = await probeRealGui()
  axeProbe = probeAxeTool()
  // R01 / R02：接触面回归，**原样实跑**（本卡只碰 `lib/client.js` 的客户端半边，两条套件都要 --pack）
  r01 = runChildRaw(['node', path.join(REPO, 'test', 'new-course-wizard.mjs'), '--pack=E:/workplace/study', '--mode=real'], 240000)
  r02 = runChildRaw(['node', path.join(REPO, 'test', 'circle-delete.mjs'), '--pack=E:/workplace/study', '--mode=real'], 900000)
  neg = await runNegativeControl()
  srcHashAfter = sha256(fs.readFileSync(CLIENT))
} catch (e) {
  fatal = e
}

/* ───────────────────────── 证据落盘（原始输出，不裁剪语义） ───────────────────────── */
try {
  h.evidenceJson('collected.json', {
    fatal: fatal ? String((fatal && fatal.stack) || fatal) : null,
    srcHashBefore, srcHashAfter,
    posWizardKey: posKey, posWizardClick: posClick, posNewCircle, deleteRun: del, negative: neg,
    a11yStatic: a11y,
    guiProbe, axeProbe,
    r01: { argv: r01.argv, code: r01.code, ms: r01.ms, timedOut: r01.timedOut, outTail: clip(r01.out, 6000), errTail: clip(r01.err, 3000) },
    r02: { argv: r02.argv, code: r02.code, ms: r02.ms, timedOut: r02.timedOut, outTail: clip(r02.out, 6000), errTail: clip(r02.err, 3000) },
  })

  const L = []
  L.push('T25 原始采集（' + new Date().toISOString() + '）')
  L.push('主仓 lib/client.js sha256：采集前 ' + srcHashBefore + ' / 采集后 ' + srcHashAfter)
  L.push('')
  L.push('── 自动层：仅键盘走 选圈 → 选点 → 开课（mini-React + 假 DOM） ──')
  L.push(`loadError=${posKey.loadError} applyError=${posKey.applyError} hasDialog=${posKey.hasDialog} renderCount=${posKey.renderCount}`)
  L.push(`圆圈卡（带 onClick 的元素）：${JSON.stringify(posKey.circlesCards)}`)
  L.push(`空态卡：${JSON.stringify(posKey.emptyCardsNow)}  + 新建圆圈=${JSON.stringify(posKey.newCircleBtn)}  + 新建知识点=${JSON.stringify(posKey.newPointBtn)}`)
  L.push(`Tab 记录：${JSON.stringify(posKey.tabs)}`)
  L.push(`按键记录：${JSON.stringify(posKey.keys)}`)
  L.push(`选圈后文本含「${POINT_HEAD}」=${posKey.textAfterCircle.indexOf(POINT_HEAD) >= 0}`)
  L.push(`知识点卡：${JSON.stringify(posKey.pointsCards)}`)
  L.push(`键盘路径送出的正文：${JSON.stringify(posKey.drafts)}  提交=${posKey.submits.length} 次`)
  L.push(`键盘路径请求序列：${JSON.stringify((posKey.finalCalls || []).map((c) => c.method + ' ' + c.url))}`)
  L.push('')
  L.push('── 对照：鼠标路径（直接 onClick，其余完全同一套夹具） ──')
  L.push(`鼠标路径送出的正文：${JSON.stringify(posClick.drafts)}  提交=${posClick.submits.length} 次`)
  L.push(`鼠标路径请求序列：${JSON.stringify((posClick.finalCalls || []).map((c) => c.method + ' ' + c.url))}`)
  L.push('')
  L.push('── `+ 新建圆圈` 键盘开/收 ──')
  L.push(JSON.stringify(posNewCircle))
  L.push('')
  L.push('── 删除确认（Modal / 初焦 / Esc / 焦点归还） ──')
  L.push(`modalCalls=${del.modalCalls} title=${JSON.stringify(del.modalTitle)} hasOnClose=${del.modalHasOnClose} propKeys=${JSON.stringify(del.modalPropKeys)}`)
  L.push(`弹窗内的手写遮罩 div=${del.overlayDivs}  fixed+inset 裸 div=${del.fixedInsetDivs}`)
  L.push(`取消=${del.cancelBtn}（${JSON.stringify(del.cancelText)}） 确认=${del.confirmBtn}（${JSON.stringify(del.confirmText)} disabled=${del.confirmDisabled}）`)
  L.push(`初焦：在弹窗内=${del.activeInDialog} 是触发器=${del.activeIsTrigger} 是 body=${del.activeIsBody} 焦点文本=${JSON.stringify(del.focusedText)}`)
  L.push(`关闭后：弹窗还在=${del.stillOpenAfterEsc} activeElement=${JSON.stringify(del.activeAfterClose)} 回到触发器=${del.restoredToTrigger}`)
  L.push(`删除面请求：${JSON.stringify((del.calls || []).map((c) => c.method + ' ' + c.url + ' ' + JSON.stringify(c.body)))}`)
  L.push('')
  L.push('── 静态 a11y 子集（**不是 axe**：只查"控件有没有可及名"这类树上看得出的事） ──')
  L.push(`检查了 ${a11y.checked} 颗 button；违规 ${a11y.violations.length} 条：${JSON.stringify(a11y.violations.slice(0, 8))}`)
  L.push('')
  L.push('── 三缺证据（真实 GUI / axe / 读屏）的**原始探测** ──')
  L.push(`真实 GUI 探测：url=${guiProbe.url} HTTP=${guiProbe.status === null ? '（连不上）' : guiProbe.status} authed=${guiProbe.authed} contentType=${guiProbe.contentType} error=${guiProbe.error}`)
  L.push(`  ⇒ ${guiProbe.note}`)
  L.push(`axe 工具：devDependency=${axeProbe.devDependency} 装上了=${axeProbe.installed} 体积=${axeProbe.bytes} 路径=${axeProbe.path}`)
  L.push(`  ⇒ ${axeProbe.note}`)
  L.push('读屏：本机没有任何可自动化的读屏路径（Windows Narrator / NVDA 在无人值守下都取不到可复现证据）⇒ screen-reader-unverified')
  L.push('')
  L.push('── R01 test/new-course-wizard.mjs ──')
  L.push(`argv=${r01.argv} code=${r01.code} ms=${r01.ms} timedOut=${r01.timedOut}`)
  L.push(clip(r01.out, 4000))
  if (r01.err.trim()) L.push('stderr:\n' + clip(r01.err, 2000))
  L.push('')
  L.push('── R02 test/circle-delete.mjs ──')
  L.push(`argv=${r02.argv} code=${r02.code} ms=${r02.ms} timedOut=${r02.timedOut}`)
  L.push(clip(r02.out, 4000))
  if (r02.err.trim()) L.push('stderr:\n' + clip(r02.err, 2000))
  L.push('')
  L.push('── N01 负向控制（钉死 revision 的**旧** lib/client.js） ──')
  L.push(`revision=${neg.rev} 可用=${neg.available}${neg.reason ? ' 原因=' + neg.reason : ''}`)
  L.push(`旧源码 ${neg.baselineBytes} 字节；旧实现里的手写遮罩=${neg.hasManualOverlay} 处；旧 Modal 调用点=${neg.oldModalPrimitiveUse}；旧标题串在=${neg.oldHasDeleteTitle}`)
  L.push(`旧实现上：圆圈卡 tag=${JSON.stringify(neg.oldCardTag)}  K01=${neg.k01}  K02=${neg.k02}  K03=${neg.k03}  M01=${neg.m01}（Modal 调用 ${neg.oldModalCalls} 次 / 手写遮罩 ${neg.oldOverlayDivs} 处）`)
  L.push(`夹具=${neg.tempFile} 在临时目录下=${neg.tempUnderTempBase} 已清理=${neg.removed}${neg.cleanupError ? '（' + neg.cleanupError + '）' : ''}`)
  if (neg.wizFatal) L.push('旧实现正向跑致命错误：' + clip(neg.wizFatal, 600))
  if (neg.delFatal) L.push('旧实现删除面致命错误：' + clip(neg.delFatal, 600))
  if (fatal) L.push('采集致命错误：' + String((fatal && fatal.stack) || fatal))
  h.evidence('observed.txt', L.join('\n') + '\n')
} catch (e) {
  process.stderr.write('证据落盘失败：' + String((e && e.message) || e) + '\n')
}

/* ─────────────────────────────── 判据 ─────────────────────────────── */
const C = (id, fn) => h.case(id, 'pass', () => {
  if (fatal) h.fail('采集阶段致命错误：' + String((fatal && fatal.stack) || fatal))
  fn()
})

C('K01', () => {
  h.eq(posKey.loadError, null, 'client.js 真加载不抛')
  h.eq(posKey.applyError, null, 'apply(ctx) 不抛')
  h.eq(posKey.hasDialog, true, '注册面里有 shell.overlay / 开课弹窗')
  h.eq(posKey.circlesCards.length, 1, '渲染出 1 张圆圈卡（夹具 1 圆圈）')
  const c = posKey.circlesCards[0]
  h.eq(c.tag, 'button', '圆圈卡本身是 button（不是 div）')
  h.eq(c.propsType, 'button', "圆圈卡带 type='button'（原生语义，不靠手写 role/tabIndex）")
  h.eq(c.text.indexOf(CIRCLE_TEXT) >= 0, true, '圆圈卡文案逐字保留（' + CIRCLE_TEXT + '）')
  h.eq(posKey.pointsCards.length, 1, '选知识点屏有 1 张知识点卡')
  h.eq(posKey.pointsCards[0].tag, 'button', '知识点卡本身是 button')
  h.eq(posKey.pointsCards[0].propsType, 'button', "知识点卡带 type='button'")
  h.eq(!!posKey.newCircleBtn, true, '`+ 新建圆圈` 在树上是 button（key=new-circle-btn）')
  h.eq(posKey.newCircleBtn.text, '+ 新建圆圈', '`+ 新建圆圈` 文案逐字不变')
})

C('K02', () => {
  h.eq(posKey.tabs.length >= 1, true, '圆圈卡在 Tab 序列里（Tab 到得了它）')
  h.eq(posKey.tabs[0].error, null, 'Tab 到圆圈卡没有报错' + (posKey.tabs[0].error ? '：' + posKey.tabs[0].error : ''))
  h.eq(posKey.keys[0].how, 'key', '第一次激活走的是键盘（Enter）')
  h.eq(posKey.keys[0].error, null, 'Enter 在圆圈卡上生效' + (posKey.keys[0].error ? '：' + posKey.keys[0].error : ''))
  h.eq(posKey.textAfterCircle.indexOf(POINT_HEAD) >= 0, true,
    '仅键盘就把向导推进到选知识点屏（渲染出「' + POINT_HEAD + '」）—— 实得：' + clip(posKey.textAfterCircle, 200))
})

C('K03', () => {
  const urls = (posKey.finalCalls || []).map((c) => c.method + ' ' + c.url)
  h.eq((posKey.finalCalls || []).some((c) => c.method === 'POST' && c.url === '/api/whale/starter'), true,
    '仅键盘走完了开课路径：POST /api/whale/starter（请求序列：' + JSON.stringify(urls) + '）')
  const post = (posKey.finalCalls || []).find((c) => c.method === 'POST' && c.url === '/api/whale/starter')
  h.eq(post && post.body && post.body.circle, '编程', '开课请求带上了圆圈名（编程）')
  h.eq(post && post.body && post.body.point, 'Spring Boot', '开课请求带上了知识点名（Spring Boot）')
  h.eq(post && post.body && post.body.pointId, 'spring-boot', '开课请求带上了知识点 id（spring-boot）')
  h.eq(posKey.drafts.length, 1, '宿主拼好的开课正文**恰好送进 composer 一次**（实得 ' + posKey.drafts.length + ' 次）')
  h.eq(posKey.drafts[0], OPEN_TEXT, '送进去的正文逐字等于宿主随回执给的那一份')
  h.eq(posKey.submits.length, 1, 'composer submit 恰好一次（实得 ' + posKey.submits.length + ' 次）')
})

C('K04', () => {
  const keySeq = (posKey.finalCalls || []).map((c) => c.method + ' ' + c.url + ' ' + JSON.stringify(c.body))
  const clickSeq = (posClick.finalCalls || []).map((c) => c.method + ' ' + c.url + ' ' + JSON.stringify(c.body))
  h.eq(posKey.keys.map((k) => k.how).join(','), 'key,key', '键盘路径的两次激活都是键盘（选圈 / 选点开课）')
  h.eq(posClick.keys.map((k) => k.how).join(','), 'click,click', '对照路径的两次激活都是鼠标 onClick')
  h.eq(clickSeq.length > 0, true, '对照路径真的发出了请求')
  h.eq(keySeq.join(' | '), clickSeq.join(' | '), '键盘与鼠标的**请求序列逐字一致**（不许两套行为）')
  h.eq((posKey.drafts || []).join('|'), (posClick.drafts || []).join('|'), '两条路送出的正文逐字一致')
  h.eq(posKey.drafts.length, posClick.drafts.length, '两条路送出条数一致')
  h.eq(posKey.submits.length, posClick.submits.length, '两条路提交次数一致')
})

C('K05', () => {
  h.eq(posNewCircle.tag, 'button', '`+ 新建圆圈` 是原生 button')
  h.eq(posNewCircle.propsType, 'button', "`+ 新建圆圈` 带 type='button'")
  h.eq(posNewCircle.tabbable, true, '`+ 新建圆圈` 在 Tab 序列里' + (posNewCircle.tabbable ? '' : '：' + posNewCircle.keyError))
  h.eq(posNewCircle.keyError, null, 'Enter 能激活 `+ 新建圆圈`' + (posNewCircle.keyError ? '：' + posNewCircle.keyError : ''))
  h.eq(posNewCircle.formOpen, true, 'Enter 之后新建表单真的出现')
  h.eq(posNewCircle.nameInput && posNewCircle.idInput, true, '表单里有「显示名」与「目录 id」两颗输入框')
  h.eq(posNewCircle.createBtn, true, '表单里有「创建」')
  h.eq(posNewCircle.cancelBtn, true, '表单里有「取消」')
  h.eq(posNewCircle.formClosedAfterCancel, true, '「取消」能把表单收回去（不是只能开不能关）')
})

C('M01', () => {
  h.eq(del.modalCalls > 0, true, '删除确认真的渲染的是 primitives.Modal（夹具记到 ' + del.modalCalls + ' 次调用）')
  h.eq(del.modalTitle, '删除知识圆圈「编程」', 'Modal 的 title 逐字等于 `删除知识圆圈「<圆圈名>」`')
  h.eq(del.modalHasOnClose, true, 'Modal 传了 onClose（Esc / 关闭都走它）')
  h.eq((del.modalPropKeys || []).indexOf('open') >= 0, true, 'Modal 带 open 属性（与开课弹窗同一套 API 用法）')
  h.eq((del.modalPropKeys || []).indexOf('title') >= 0, true, 'Modal 带 title 属性（标题关联靠它）')
})

C('M02', () => {
  h.eq(del.overlayDivs, 0, '弹窗里**没有**带 background rgba(0,0,0,0.45) 的裸 div（那条缝已被 Modal 接管）')
  h.eq(del.fixedInsetDivs, 0, '弹窗里**没有** position:fixed + inset:0 的自造遮罩 div')
  h.eq(neg.hasManualOverlay > 0, true, '反证：钉死 revision 的旧实现里**确实**有那条手写遮罩（' + neg.hasManualOverlay + ' 处）—— 说明这条判据抓的是真东西')
})

C('M03', () => {
  h.eq(del.activeInDialog, true,
    '弹窗打开后焦点落在**弹窗内**的某个元素上（C2.4：宿主的 Modal 没有初焦 props，所以由我们把初焦放在「取消」上）—— 实得 ' + JSON.stringify(del.focusedText))
  h.eq(del.activeIsTrigger, false, '焦点**不是**留在触发它的那颗「删除」上')
  h.eq(del.activeIsBody, false, '焦点**不是**留在 body 上')
  h.eq((del.focusedText || '').indexOf('取消') >= 0, true, '初焦落在「取消」那颗上（不具破坏性；不是「确认删除」）')
})

C('M04', () => {
  h.eq(del.modalCalls > 0, true, '先确认弹窗真的开过（否则"关掉了"是假绿）')
  h.eq(del.stillOpenAfterEsc, false, '触发 onClose（Esc 走的就是那条路）之后弹窗消失')
  h.eq((del.calls || []).filter((c) => c.url === '/api/whale/circle/delete' && c.body && c.body.confirm === true).length, 0,
    '取消/Esc **没有**发出任何 confirm:true 的删除请求（取消不是"点了就删"）')
})

C('M05', () => {
  h.eq(del.triggerFocused, true, '触发它的「删除」按钮事先真的在焦点上（否则"归还"无从谈起）')
  h.eq(del.restoredToTrigger, true,
    '关闭后 document.activeElement 回到**当初触发删除的那颗按钮** —— 实得 ' + JSON.stringify(del.activeAfterClose))
  h.eq((del.activeAfterClose || '') === '删除', true, '回到的确实是那颗「删除」按钮（不是回到 body / 页首）')
})

C('M06', () => {
  h.eq(del.cancelBtn, 'button', '「取消」仍是原生 button')
  h.eq(del.confirmBtn, 'button', '「确认删除」仍是原生 button')
  h.eq(del.cancelText, '取消', '「取消」文案逐字保留')
  h.eq(del.confirmText, '确认删除', '「确认删除」文案逐字保留')
  h.eq(del.confirmDisabled, false, '判词到手（plan 已回）后「确认删除」**可点**（`disabled: !plan || del.busy` 没被改坏）')
  h.eq((del.calls || []).filter((c) => c.url === '/api/whale/circle/delete' && c.body && c.body.dryRun === true).length, 1,
    '打开弹窗前先发了**一次** dryRun（清单不是空话）')
  h.eq((del.textAfterOpen || '').indexOf('不可恢复') >= 0, true, '弹窗正文逐字保留（「不可恢复」那句还在）')
  h.eq((del.textAfterOpen || '').indexOf('lessons/programming') >= 0, true, '弹窗正文仍摆出真实目录清单（lessons/programming）')
})

C('R01', () => {
  h.eq(r01.timedOut, false, 'test/new-course-wizard.mjs 没超时')
  h.eq(r01.code, 0, 'test/new-course-wizard.mjs 实跑 exit0（实得 ' + r01.code + '）')
  h.eq(/\b0 失败|全部通过|失败\s*[:：]?\s*0/.test(r01.out), true,
    '摘要里是 0 失败：' + JSON.stringify(clip((r01.out.trim().split('\n').slice(-3).join(' / ')) || '', 200)))
})

C('R02', () => {
  h.eq(r02.timedOut, false, 'test/circle-delete.mjs 没超时')
  h.eq(r02.code, 0, 'test/circle-delete.mjs 实跑 exit0（实得 ' + r02.code + '）')
})

C('N01', () => {
  h.eq(neg.available, true, '负向控制的锚点 revision 取到了源码' + (neg.reason ? '：' + neg.reason : ''))
  h.eq(neg.k01, false, 'K01 在钉死 revision 的**旧** client.js 上**必须红**（旧选择面是 div + onClick，实得 tag=' + JSON.stringify(neg.oldCardTag) + '）')
  h.eq(neg.k02, false, 'K02 在旧实现上**必须红**（div + onClick 上按 Enter 到不了选知识点屏）')
  h.eq(neg.m01, false, 'M01 在旧实现上**必须红**（旧删除确认是手写遮罩，不是 primitives.Modal）')
  h.eq(neg.tempUnderTempBase, true, `临时副本落在临时目录下（${neg.tempFile}）`)
  h.eq(neg.removed, true, '临时副本清理成功' + (neg.cleanupError ? '（' + neg.cleanupError + '）' : ''))
  h.eq(neg.cleanupError, null, '清理没有报"拒绝清理/删不动"')
  h.eq(srcHashBefore, srcHashAfter, '负向控制跑完，主仓 lib/client.js 逐字节没变')
})

/* 备注（进 notes.txt，只是索引） */
h.note(`主仓 lib/client.js sha256：采集前 ${srcHashBefore} / 采集后 ${srcHashAfter}`)
h.note(`键盘路径请求序列：${JSON.stringify((posKey.finalCalls || []).map((c) => c.method + ' ' + c.url))}`)
h.note(`鼠标路径请求序列：${JSON.stringify((posClick.finalCalls || []).map((c) => c.method + ' ' + c.url))}`)
h.note(`删除确认：Modal 调用 ${del.modalCalls} 次 / title=${JSON.stringify(del.modalTitle)} / 初焦在弹窗内=${del.activeInDialog} / 焦点归还=${del.restoredToTrigger}`)
h.note(`静态 a11y 子集（**不是 axe**）：${a11y.checked} 颗 button，违规 ${a11y.violations.length} 条`)
h.note(`R01 exit=${r01.code} / R02 exit=${r02.code}`)
h.note(`N01 旧实现上 K01=${neg.k01} K02=${neg.k02} M01=${neg.m01}（都应为 false=红）`)
h.note(`三缺证据实测：宿主 GUI HTTP=${guiProbe.status === null ? '连不上(' + guiProbe.error + ')' : guiProbe.status}；axe-core 装上=${axeProbe.installed}（${axeProbe.bytes} 字节）；读屏=无自动化路径`)

/* ───────────────────── 默认入口：三缺证据 → BLOCKED / exit2 ─────────────────────
 * 用户 2026-10-18 的裁定：**真实 GUI、axe、读屏缺任一项 → 整卡 BLOCKED / exit2**，
 * 不拿模拟层冒充。本机三项的实测（原始探测见 observed.txt / collected.json 的 guiProbe / axeProbe）：
 *   · 真实 GUI：宿主 GUI（本机 http://127.0.0.1:57680）**拒绝匿名访问**（本次实测 HTTP
 *     ${guiProbe.status === null ? '（连不上：' + guiProbe.error + '）' : guiProbe.status}），
 *     而 `lib/client.js` 只活在 DSH 宿主里、没有任何可独立加载它的页面；驱动用户**正在用的**
 *     那个 GUI 会动到他的会话/草稿，本卡不碰 ⇒ `real-gui-unverified`；
 *   · axe：`axe-core` 已装成 devDependency（${axeProbe.installed ? axeProbe.bytes + ' 字节的 axe.min.js 在' : '未装上'}），
 *     但 axe 要注入**真页面**才有意义；真页面同上拿不到 ⇒ `axe-unverified`（自动层只做静态子集，**它不冒充 axe**）；
 *   · 读屏：本机没有任何可自动化的读屏路径 ⇒ `screen-reader-unverified`（**预期终态**）。
 */
const missing = ['screen-reader-unverified', 'real-gui-unverified', 'axe-unverified']
if (!AUTO) h.block(`missing=${missing.join(',')}`)

process.exit(h.run())
