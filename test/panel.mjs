#!/usr/bin/env node
/**
 * panel.mjs —— 设置页那一节（只读状态卡）的判据
 * ------------------------------------------------------------------
 * 两半各自判，因为它们的失败方式完全不同：
 *
 *   A. **宿主半边**（`lib/mods/status.js` + `GET /api/whale/status`）
 *      真驱动一遍 fetch 处理器（假 Request）。**"卡片里显示什么"由宿主算好（`sections`）**，
 *      所以这里能连"内容"一起判 —— 不必只能靠人眼看。
 *      ⚠️ 关键判据不是"配了能读到"，而是**没配时回 200 且说清怎么修** ——
 *      这一节存在的意义就是把"没配 packRoot ⇒ 所有 /api/whale/* 会 503"显示出来，
 *      回 503 的话卡片只能显示一个错误，反而看不出该怎么修。
 *
 *   B. **浏览器半边**（`lib/client.js`）
 *      只做**静态格式判据**：注册的是 `settings.section`（顶层设置项那条缝）**与
 *      `conversation.input.left`（输入框左侧的开课入口）**、
 *      四个字段齐全、`id` 与包名对齐、`exports.inject` 只声明用到服务、
 *      **组件在工厂作用域定义**（在渲染回调里现造会让 React 每帧重挂载）、
 *      **入口只用 `setDraft` 不用 `submit`**（只填草稿、不替你发）、
 *      以及**样式只用官方语义令牌**（自己造色在深浅色主题里必崩）。
 *      ⚠️ 客户端**渲染**单测看不见（项目自己的教训）：这里能判到"格式对、内容对、装得上"，
 *      "卡片真的画出来了"只能重启宿主 + 刷新页面由人眼确认。**不谎报。**
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { plugin as statusPlugin } from '../lib/mods/status.js'
import { plugin as starterPlugin } from '../lib/mods/starter.js'
import { STARTER_LABEL } from '../lib/starter.js'
import { packRoot, PLUGIN } from './_pack.mjs'

const ROOT = packRoot()

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }

console.log(`\n[panel] 课程包：${ROOT}`)

/* ── A. 宿主半边：状态路由 ─────────────────────────────────────────────── */
{
  const mount = (root) => {
    const cap = []
    statusPlugin.install({
      paths: { packRoot: root, root: path.join(PLUGIN, '..', '.dsh-whale-sensei') },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => cap.push(r) } }) }),
    })
    return cap
  }

  const cap0 = mount(ROOT)
  const route = cap0.find((r) => r.path === '/api/whale/status')
  ok(!!route, `挂了 /api/whale/status（本模块共 ${cap0.length} 条）`)
  ok(route && route.methods.length === 1 && route.methods[0] === 'GET', `只收 GET（${route?.methods?.join(',')}）—— 只读`)
  ok(route?.requestBody === 'buffered', '显式声明 requestBody（缺了会被基座当 streaming，GET 会 400 空体）')
  ok(statusPlugin.tools.length === 0, '这一节不进工具面（tools 为空）')

  if (route) {
    const get = (root) => mount(root)[0].fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'GET' }))
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))

    const r1 = await get(ROOT)
    const b1 = await r1.json()
    ok(r1.status === 200 && b1.ok === true && b1.configured === true, `配了 packRoot → ${r1.status} configured=${b1.configured}`)
    ok(b1.packRoot === path.resolve(ROOT), `回报解析后的绝对路径（${b1.packRoot}）`)
    ok(b1.version === pkg.version, `版本从 package.json 读、不硬编码（${b1.version}）`)

    // —— 卡片内容：由宿主算好，所以这里能判"厚不厚、真不真" ——
    const secs = b1.sections || []
    const titles = secs.map((s) => s.title)
    ok(Array.isArray(secs) && secs.length >= 5, `sections 有 ${secs.length} 块（${titles.join(' / ')}）`)
    ok(['课程包', '产物', '审计', '台账', '学生工作区', '插件'].every((t) => titles.includes(t)), '六块齐全（课程包 / 产物 / 审计 / 台账 / 学生工作区 / 插件）')
    const rows = secs.flatMap((s) => s.rows)
    ok(rows.length >= 13, `合计 ${rows.length} 行（不是"就两行糊弄"）`)
    ok(rows.every((r) => typeof r.name === 'string' && r.name && typeof r.value === 'string'), '每行都是 { name, value } 非空字符串')
    ok(rows.every((r) => r.state === undefined || ['ok', 'warn', 'error'].includes(r.state)), 'state 只取 ok / warn / error（客户端照它上色）')
    const find = (t, n) => (secs.find((s) => s.title === t) || {}).rows?.find((r) => r.name === n)
    ok(/1 圆圈 · 2 知识点 · 3 门课程/.test(find('课程包', '概况')?.value || ''), `课程包概况是真数字（${find('课程包', '概况')?.value}）`)
    ok(/^\d+ \/ \d+$/.test(find('课程包', '已点亮')?.value || ''), `已点亮 x / y（${find('课程包', '已点亮')?.value}）`)
    ok(find('产物', '一致性')?.value === '产物与课程包一致' && find('产物', '一致性')?.state === 'ok', `产物一致性与 whale_build 同源（${find('产物', '一致性')?.value}）`)
    ok(!!find('审计', '审计')?.value, `审计块有结论（${find('审计', '审计')?.value}）`)
    ok(/69 条 · 15 类/.test(find('台账', '名词')?.value || ''), `台账名词是真数（${find('台账', '名词')?.value}）`)
    ok(/待答 \d+ · 已答 \d+/.test(find('台账', '答疑')?.value || ''), `答疑是真数（${find('台账', '答疑')?.value}）`)
    ok(/\d+ 个/.test(find('学生工作区', '项目')?.value || ''), `学生工作区是真数（${find('学生工作区', '项目')?.value}）`)
    ok(!!find('插件', '版本')?.value, `插件块有版本（${find('插件', '版本')?.value}）`)

    const r2 = await get(undefined)
    const b2 = await r2.json()
    ok(r2.status === 200 && b2.configured === false, `**没配 packRoot 也回 200**（${r2.status} configured=${b2.configured}）—— 这一节的意义就是把这个错显示出来`)
    ok(/503/.test(b2.hint || '') && /cordis\.patch\.yml/.test(b2.hint || ''), `没配时 hint 说清症状与修法（${String(b2.hint).slice(0, 42)}…）`)

    const put = await mount(ROOT)[0].fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'PUT' }))
    ok(put.status === 405, `PUT → ${put.status}（只读）`)
  }
}

/* ── A2. 宿主半边：开课入口的两条路由（`lib/mods/starter.js`）─────────────
 * 弹窗要的两个东西都在这里：**字段与模板**（GET）、**把答案拼成正文**（POST）。
 * 判据放在这一层而不是浏览器半边 —— 话术只有宿主一份，所以"问了什么、拼成什么"可以离线判。
 */
{
  const mount = (root) => {
    const cap = []
    starterPlugin.install({
      paths: { packRoot: root, root: path.join(PLUGIN, '..', '.dsh-whale-sensei') },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => cap.push(r) } }) }),
    })
    return cap
  }
  const route = mount(ROOT).find((r) => r.path === '/api/whale/starter')
  ok(!!route, '挂了 /api/whale/starter')
  ok(route?.methods?.join(',') === 'GET,POST', `一条路由两种方法（${route?.methods?.join(',')}）—— 同路径拆两条会撞`)
  ok(route?.requestBody === 'buffered', '显式声明 requestBody（不写的话 GET 会被装 body 而抛）')
  ok(starterPlugin.tools.length === 0, '这一节不进工具面（tools 为空）')

  const get = (root) => mount(root)[0].fetch(new Request('http://127.0.0.1:3090/api/whale/starter', { method: 'GET' }))
  const post = (values) => route.fetch(new Request('http://127.0.0.1:3090/api/whale/starter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  }))

  const g = await get(ROOT)
  const gb = await g.json()
  const form = gb.entry?.form || {}
  ok(g.status === 200 && gb.configured === true, `GET → ${g.status} configured=${gb.configured}`)
  ok(gb.entry?.label === STARTER_LABEL, `按钮/弹窗标题与宿主常量一致（${gb.entry?.label}）`)
  ok(Array.isArray(form.fields) && form.fields.length === 5, `弹窗 ${(form.fields || []).length} 个字段`)
  ok((form.fields || []).filter((f) => f.required).map((f) => f.id).join(',') === 'topic,goal', '必填只有「要学什么 / 学完要能做出什么」')
  ok(/掌握程度/.test(form.intro || ''), '弹窗说明里写明后面会问掌握程度（摸底在发出去之后）')
  ok(!/掌握程度|学过什么|基础如何/.test(JSON.stringify(form.fields)), '**弹窗字段里不问摸底**')
  ok(/whale_intake/.test(gb.entry.prompt || '') && /RESOURCES\.md/.test(gb.entry.prompt || ''), '协议全文齐（查资料 + 摸底的机械闸门都在）')
  ok((form.template || '').includes('{{protocol}}'), '模板带 {{protocol}} 占位')

  const p = await post({ topic: 'Vue 3 组合式 API', goal: '能独立写一个小型前端应用' })
  const pb = await p.json()
  ok(p.status === 200 && pb.ok === true && pb.text.startsWith('【开课请求】'), `POST 合法 → ${p.status}，正文以「【开课请求】」开头`)
  ok(pb.text.includes('Vue 3 组合式 API') && pb.text.includes('（未填，你来定）'), '答案进正文，没填的字段写成「（未填，你来定）」')
  ok(!/\{\{[a-z]+\}\}/.test(pb.text), '正文里没有没替换的占位符')
  const missing = await post({ goal: 'x' })
  const mb = await missing.json()
  ok(missing.status === 400 && mb.missing?.join(',') === '要学什么', `缺必填 → ${missing.status} ${mb.error}`)

  const g2 = await get(undefined)
  const gb2 = await g2.json()
  ok(g2.status === 200 && gb2.configured === false && !!gb2.entry?.form, '没配 packRoot 也发 entry（弹窗不该静默消失）')
}

/* ── B0. 浏览器半边：**真加载一遍**（不是 grep） ─────────────────────────
 * 为什么加这一段：静态 grep 只能证明"文件里写着这行字"。浏览器半边真正的失败方式是
 * "文件能读、格式看着对、装配上去什么也没发生" —— 那段代码在单测里从来没被执行过。
 * 这里用一个假基座把 `lib/client.js` 跑起来：`__ModuleLoader__.load` 收下模块、`apply(ctx)`
 * 真的被调用、两个 `slots.register` 真的发生。
 *
 * 侧栏那一行更狠一点：它**不走 slot**（侧栏没有对外可注册的缝），是往 DOM 里插一行 ——
 * 于是再造一个**最小假 DOM**，把三条最难的不变式钉住（2026-09-21 现场连踩两个坑）：
 *   ① 插在原生「新建会话」正下方；② 被别的插件行挤下去要挪回来；③ 侧栏晚出现要补插。
 * **渲染**（长什么样、和「新会话」对不齐）仍然只能人眼 —— 这一步本仓库不谎报。
 */
{
  const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
  let mod = null
  // ⚠️ `window` 是 `new Function('window', …)` 的**形参** —— 模块里的 `window.setTimeout` 指的是这里，
  //    不是 `globalThis.window`（第一版就是漏了它，发送路径静默不生效）。
  const fakeWindow = {
    __ModuleLoader__: { load: (m) => { mod = m } },
    setTimeout: (fn) => setTimeout(fn, 0),
    prompt: () => {},
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  }
  const asked = []
  // 官方原语：弹窗用 Modal、按钮用 Button。宿主侧真的提供这个包（本机多个第三方插件也在 require 它）。
  const primitives = { Modal: function Modal() {}, Button: function Button() {} }
  const req = (n) => {
    asked.push(n)
    if (n === 'react') return react
    if (n === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('客户端 require 了没声明的包：' + n)
  }

  let boom = null
  try {
    new Function('window', 'require', src)(fakeWindow, req)
  } catch (e) { boom = e }
  ok(!boom && !!mod, `真加载：lazy-CJS 工厂能跑起来${boom ? '（' + boom.message + '）' : ''}`)
  ok(mod?.id === pkg.name, `__ModuleLoader__.load 的 id 是包名（${mod?.id}）`)
  ok(asked.every((n) => n === 'react' || n === '@deepseek-ai/dsh-client-ui-primitives'), `只 require 了冻结基座里的包（${[...new Set(asked)].join(', ') || '无'}）`)

  const regs = []
  const ctx = {
    slots: {
      inject: (name, cb) => cb(),
      register: (spec, comp) => { regs.push({ spec, comp }); return () => {} },
    },
  }
  let applied = null
  try {
    const exportsObj = mod.factory(req)
    ok(typeof exportsObj.apply === 'function', '导出 apply(ctx)')
    ok(Array.isArray(exportsObj.inject) && exportsObj.inject.join() === 'slots', `导出 inject = ['slots']（${JSON.stringify(exportsObj.inject)}）`)
    exportsObj.apply(ctx)
  } catch (e) { applied = e }
  ok(!applied, `apply(ctx) 不抛${applied ? '（' + applied.message + '）' : ''}`)
  ok(regs.length === 3, `apply 里真的注册了 3 个坐位（实际 ${regs.length}）`)
  ok(regs[0]?.spec?.name === 'settings.section' && regs[0]?.spec?.id === 'whale-sensei', `坐位①：settings.section / whale-sensei（${regs[0]?.spec?.name}/${regs[0]?.spec?.id}）`)
  ok(regs[1]?.spec?.name === 'conversation.input.left' && regs[1]?.spec?.id === 'whale-bridge', `坐位②：conversation.input.left / whale-bridge（${regs[1]?.spec?.name}/${regs[1]?.spec?.id}）`)
  ok(regs[2]?.spec?.name === 'shell.overlay' && regs[2]?.spec?.id === 'whale-new-course-dialog', `坐位③：shell.overlay / whale-new-course-dialog（${regs[2]?.spec?.name}/${regs[2]?.spec?.id}）—— 弹窗挂在官方"整帧浮层"缝上`)
  ok(regs.every((r) => typeof r.comp === 'function'), '三处注册的都是**组件函数**，不是现造的元素')
  ok(regs[1].comp({ inputActions: {} }) === null, '桥组件渲染 null —— 它只把 inputActions 接出来，不占界面')

  // —— 侧栏那一行：用**最小假 DOM** 真跑一遍注入逻辑 ——
  //    侧栏没有对外的 slot（我们是往 DOM 里插一行），这段逻辑在 Node 里本来**一条判据都没有**；
  //    而它恰恰是最难的部分（2026-09-21 现场连踩两个坑）。这里钉住三条不变式：
  //      ① 插在原生「新建会话」正下方；
  //      ② 别的插件行（技能中心）插到我上面时，我能挪回去；
  //      ③ 侧栏还没渲染出来时先别插，等它出现再插（缺了这条就是"静默什么都不发生"）。
  {
    /** 极简选择器匹配：够用于本插件用到的那几种（tag[class*="x"] / [attr="v"] / [attr] / 逗号列表） */
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
    const makeDom = () => {
      const mk = (tag, cls) => {
        const n = {
          tagName: tag.toUpperCase(), className: cls || '', children: [], parentElement: null,
          _attrs: {}, _text: '', innerHTML: '', style: {}, disabled: false, type: '', _on: {},
          setAttribute(k, v) { this._attrs[k] = String(v) },
          getAttribute(k) { if (k === 'class') return this.className || null; return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null },
          appendChild(c) { c.parentElement = this; this.children.push(c); return c },
          append(...cs) { cs.forEach((c) => this.appendChild(c)) },
          insertBefore(c, ref) {
            if (c.parentElement) { const i = c.parentElement.children.indexOf(c); if (i >= 0) c.parentElement.children.splice(i, 1) }
            c.parentElement = this
            const at = ref ? this.children.indexOf(ref) : -1
            if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c)
            return c
          },
          remove() { const p = this.parentElement; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1) } this.parentElement = null },
          contains(o) { let x = o; while (x) { if (x === this) return true; x = x.parentElement } return false },
          addEventListener(t, fn) { this._on[t] = fn },
          matches(sel) { return match(this, sel) },
          closest(sel) { let x = this; while (x) { if (match(x, sel)) return x; x = x.parentElement } return null },
          querySelector(sel) { return findIn(this, sel) },
          querySelectorAll(sel) { const out = []; const walk = (r) => { r.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c) }) }; walk(this); return out },
          getBoundingClientRect() { return { left: 0, top: 0, width: 252, height: 38 } },
          get isConnected() { let x = this; while (x.parentElement) x = x.parentElement; return x === doc.documentElement },
          get firstElementChild() { return this.children[0] || null },
          get previousElementSibling() { const p = this.parentElement; if (!p) return null; const i = p.children.indexOf(this); return i > 0 ? p.children[i - 1] : null },
          get nextElementSibling() { const p = this.parentElement; if (!p) return null; const i = p.children.indexOf(this); return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null },
          set textContent(v) { this._text = String(v); this.children = [] },
          get textContent() { return this._text + this.children.map((c) => c.textContent).join('') },
        }
        return n
      }
      const doc = { createElement: (t, cls) => mk(t, cls), getElementById: () => null }
      doc.documentElement = mk('html')
      doc.head = mk('head')
      doc.body = mk('body')
      doc.documentElement.appendChild(doc.head)
      doc.documentElement.appendChild(doc.body)
      doc.querySelector = (sel) => findIn(doc.documentElement, sel)
      return doc
    }
    /** 造一个"有侧栏"的假文档：html > body > [sidebarCol(data-pane=sidebar) > logoRow, newSession, regionArea, footArea] */
    const withSidebar = (doc) => {
      const col = doc.createElement('div')
      col.setAttribute('data-pane', 'sidebar')
      const logoRow = doc.createElement('div', 'hHd-Xa_logoRow')
      const native = doc.createElement('button', 'hHd-Xa_newSession')
      col.appendChild(logoRow)
      col.appendChild(native)
      col.appendChild(doc.createElement('div', 'hHd-Xa_regionArea'))
      doc.body.appendChild(col)
      return { col, logoRow, native }
    }

    const realDoc = globalThis.document
    const realMO = globalThis.MutationObserver
    const seen = []
    let row = null
    try {
      class FakeMO {
        constructor(cb) { this.cb = cb; seen.push(this) }
        observe() {} disconnect() {}
      }
      const req2 = (n) => {
        if (n === 'react') return react
        if (n === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        throw new Error('意外 require：' + n)
      }
      // 浏览器半边所有挂载点都包在 try/catch 里（不许把宿主界面搞崩）—— 代价是**出错会静默**。
      // 所以这里把 console.warn 抓下来：假 DOM 跑的时候一声不吭，才算真的没事。
      const warns = []
      const realWarn = console.warn
      const applyOnce = (doc) => {
        globalThis.document = doc
        globalThis.MutationObserver = FakeMO
        const exportsObj = mod.factory(req2)
        exportsObj.apply({ slots: { inject: (n, cb) => cb(), register: () => () => {} }, effect: (fn) => fn() })
      }

      // ① 侧栏已经在 → 直接插在「新建会话」正下方
      const doc1 = makeDom()
      const s1 = withSidebar(doc1)
      console.warn = (...a) => warns.push(a.map(String).join(' '))
      applyOnce(doc1)
      console.warn = realWarn
      ok(warns.length === 0, `挂载侧栏入口时一声不吭（try/catch 里没吞掉异常）${warns.length ? '：' + warns.join(' | ') : ''}`)
      row = doc1.querySelector('[data-dsh-whale-entry]')
      ok(!!row && row.tagName === 'BUTTON', '侧栏那一行真的插进了 DOM（假 DOM）')
      ok(row?.previousElementSibling === s1.native, '位置①：紧贴原生「新建会话」下面（previousElementSibling 就是它）')
      ok(row?.textContent === '新课程', `行上的字是「新课程」（${row?.textContent}）`)
      ok(row?.getAttribute('data-dsh-whale-entry') === '' && row?.getAttribute('data-dsh-part') === 'sidebar-entry', '带 data-dsh-whale-entry 与 data-dsh-part（可被识别、可被别的插件避让）')

      // ② 别的插件行插到我上面 → 触发 observer → 必须挪回「新建会话」正下方
      const skill = doc1.createElement('button', 'cBrkua_entry')
      skill.setAttribute('data-dsh-skill-explorer-entry', '')
      s1.col.insertBefore(skill, row)
      ok(row.previousElementSibling === skill, '（先把技能中心插到我上面，模拟现场那一幕）')
      seen.forEach((o) => o.cb())
      ok(row.previousElementSibling === s1.native, '位置②：被技能中心挤下去后**挪回了「新建会话」正下方**')
      ok(row.nextElementSibling === skill && skill.nextElementSibling !== row, '技能中心被排到我后面（顺序：新建会话 → 新课程 → 技能中心）')

      // ③ 侧栏还没渲染出来 → 先不插；等它出现，body observer 要补插（缺这条 = 静默什么都不发生）
      const doc2 = makeDom()
      applyOnce(doc2)
      ok(!doc2.querySelector('[data-dsh-whale-entry]'), '侧栏还没出现时：行没被插进去（也不报错）')
      const s2 = withSidebar(doc2)
      seen.filter((o) => o.cb).forEach((o) => o.cb())
      ok(doc2.querySelector('[data-dsh-whale-entry]')?.previousElementSibling === s2.native, '侧栏一出现就补插到「新建会话」正下方（body observer 生效）')

      // ④ 整条真流程：点侧栏那行 → 弹窗开 → 拉载荷 → 填字段 → 点「发送」→ setDraft + submit
      //    这需要 React 的**状态**（弹窗开/关、字段值、phase），所以这里用一个 40 行的 mini-React：
      //    只实现 useState/useEffect(deps)/useRef/createElement，够跑这一个组件。
      {
        const doc3 = makeDom()
        const s3 = withSidebar(doc3)
        const made = { modal: [], buttons: [], trees: [] }
        const prim = {
          Modal: (props) => ({ __modal: true, props }),
          Button: (props) => ({ __button: true, props }),
        }
        // mini-React：hooks 按调用顺序存；deps 变了才重跑 effect；setState 触发微任务重渲染
        const slots = []
        let cursor = 0
        let comp = null
        let props = null
        let tree = null
        const effects = []
        const render = () => {
          cursor = 0
          effects.length = 0
          tree = comp(props)
          for (const fn of effects) fn()
          return tree
        }
        const schedule = () => { Promise.resolve().then(render) }
        const miniReact = {
          createElement: (type, p, ...kids) => ({ type, props: p || {}, children: kids.flat().filter((k) => k !== null && k !== undefined && k !== false) }),
          useState(init) {
            const i = cursor++
            if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
            return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; schedule() }]
          },
          useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
          useEffect(fn, deps) {
            const i = cursor++
            const prev = slots[i]
            const changed = !prev || deps === undefined || !prev.deps || prev.deps.length !== deps.length || deps.some((d, k) => d !== prev.deps[k])
            slots[i] = { deps }
            if (changed) effects.push(fn)
          },
        }
        const req4 = (n) => {
          if (n === 'react') return miniReact
          if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
          throw new Error('意外 require：' + n)
        }
        const realFetch = globalThis.fetch
        const realWindow = globalThis.window
        const drafted = []
        const submitted = []
        const replies = [
          {
            ok: true,
            configured: true,
            entry: {
              label: '新课程',
              prompt: '协议全文（假）',
              form: {
                title: '新课程', intro: '说明（摸底在后面）', submitLabel: '发送', cancelLabel: '取消',
                fields: [{ id: 'topic', label: '要学什么', required: true, multiline: false }],
                template: '【开课请求】\n- 要学什么：{{topic}}\n\n{{protocol}}',
              },
            },
          },
          { ok: true, text: '【开课请求】\n- 要学什么：Vue 3\n\n协议全文（假）' },
        ]
        const seenUrls = []
        globalThis.fetch = (url, init) => {
          seenUrls.push((init && init.method ? init.method + ' ' : 'GET ') + url)
          return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(replies.shift() || { ok: false, error: '没有更多假回复' })) })
        }
        globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0), prompt: () => {} }
        try {
          const exportsObj = mod.factory(req4)
          const regs4 = []
          globalThis.document = doc3
          globalThis.MutationObserver = FakeMO
          exportsObj.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs4.push({ spec, comp: c }); return () => {} } }, effect: (fn) => fn() })
          // 桥坐位渲染一次 → 把 inputActions 接出来（真流程里由宿主渲染）
          regs4.find((r) => r.spec.id === 'whale-bridge').comp({
            inputActions: { setDraft: (t) => drafted.push(t), submit: () => submitted.push(1) },
          })
          // 「发送」键路径要靠重渲染，所以这里把弹窗组件挂进 mini-React，再由侧栏那行把它打开
          const dialogComp = regs4.find((r) => r.spec.name === 'shell.overlay').comp
          comp = dialogComp
          props = {}
          render()
          ok(tree?.type === prim.Modal && tree.props.open === false, `未打开时：官方 Modal 渲染但 open=false（${tree?.props?.open}）`)
          const entryRow = doc3.querySelector('[data-dsh-whale-entry]')
          ok(typeof entryRow?._on?.click === 'function', '侧栏那一行有 click 处理器')
          entryRow._on.click()
          await new Promise((r) => setTimeout(r, 0))
          await new Promise((r) => setTimeout(r, 0))
          ok(tree?.props?.open === true, '点一下侧栏那行 → 弹窗打开（open=true）')
          ok(seenUrls[0] === 'GET /api/whale/starter', `弹窗打开时拉载荷（${seenUrls[0]}）`)
          // 递归找"渲染某个字段"的那个元素（它在 body → 字段行 → FieldInput 这一层）
          const fieldEls = []
          const walk = (el) => {
            if (!el || !el.children) return
            for (const c of el.children) {
              if (c && c.props && c.props.field) fieldEls.push(c)
              walk(c)
            }
          }
          walk(tree)
          ok(fieldEls.length === 1, `弹窗按宿主给的字段表画出了字段（字段表来自 entry.form，实得 ${fieldEls.length} 个）`)
          const fieldEl = fieldEls[0]
          const inputEl = fieldEl.type(fieldEl.props) // FieldInput 是纯函数组件，直接渲染一次
          ok(!!inputEl?.props && typeof inputEl.props.onChange === 'function', `字段渲染成 ${inputEl?.type}（${fieldEl.props.field.id}）`)
          inputEl.props.onChange({ target: { value: 'Vue 3' } })
          await new Promise((r) => setTimeout(r, 0))
          const footer = tree.props.footer
          const sendBtn = footer.children.find((b) => b && b.props && b.props.variant === 'primary')
          ok(!!sendBtn && sendBtn.children.join('') === '发送', `底部有 primary「发送」（${sendBtn?.children?.join('')}）`)
          const cancelBtn = footer.children.find((b) => b && b.props && b.props.variant === 'outline')
          ok(!!cancelBtn, '底部有「取消」（outline）')
          sendBtn.props.onClick()
          await new Promise((r) => setTimeout(r, 0))
          await new Promise((r) => setTimeout(r, 0))
          ok(seenUrls[1] === 'POST /api/whale/starter', `按发送 → POST 拼装（${seenUrls[1]}）`)
          ok(drafted.length === 1 && drafted[0].includes('Vue 3') && drafted[0].includes('协议全文（假）'), '拼好的正文交给了 inputActions.setDraft')
          ok(submitted.length === 1, '紧接着调了 inputActions.submit —— 发送键就是启动键')
          ok(tree?.props?.open === false, '发送后弹窗自动关上')
        } catch (e) {
          ok(false, `点侧栏 → 弹窗 → 发送 这条流程跑不通：${e?.message ?? e}`)
        } finally {
          globalThis.fetch = realFetch
          globalThis.window = realWindow
        }
      }
    } catch (e) {
      ok(false, `侧栏注入假 DOM 跑不通：${e?.message ?? e}`)
    } finally {
      globalThis.document = realDoc
      globalThis.MutationObserver = realMO
    }
  }
}

/* ── B. 浏览器半边：静态格式 ───────────────────────────────────────────── */
{
  const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
  // 判"代码里有没有"必须**先剥注释**：本文件的注释里正写着"别去抢 settings.plugins.tab"、
  // 也写着"不许出现 import/export" —— 拿原文 grep 会把提醒本身当成违规（第一次就红在这儿）。
  // 这不是 JS 解析器，只处理本文件的两种形态。⚠️ **先剥行注释、再剥块注释**：
  // 行注释里出现过 `/api/whale/*`，那个 `/*` 会被块注释正则当成开注释，把后面几十行代码一起吃掉
  // （2026-09-21 实测：`require('@deepseek-ai/dsh-client-ui-primitives')` 就是这么消失的）。
  const code = src
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  ok(!/^\s*(import|export)\s/m.test(code), 'lazy-CJS：没有 ESM 的 import/export 语句')
  const idm = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/)
  ok(idm && idm[1] === pkg.name, `id 逐字等于包名（${idm?.[1]} vs ${pkg.name}）`)

  const reg = code.match(/register\(\s*\{([\s\S]{0,220}?)\}\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/)
  ok(!!reg, '找得到一次 slots.register({…}, 组件)')
  if (reg) {
    const spec = reg[1]
    ok(/name:\s*'settings\.section'/.test(spec), '注册在 settings.section（顶层设置项那条缝）')
    ok(/id:\s*'whale-sensei'/.test(spec), '节 id = whale-sensei')
    ok(/order:\s*\d+/.test(spec), `带 order（${(spec.match(/order:\s*\d+/) || [''])[0]}）—— 与「表情包」(25) 等并列排序`)
    ok(/label:\s*'[^']+'/.test(spec), `带 label（${(spec.match(/label:\s*'[^']+'/) || [''])[0]}）`)
    ok(!/createElement/.test(reg[0]), `第二个参数是**组件标识符**（${reg[2]}），不是现造的组件 —— 现造会让 React 每帧重挂载`)
  }
  ok(!/settings\.plugins\.tab/.test(code), '代码里没有去抢标签页 slot settings.plugins.tab（注释里提它是允许的）')

  const inj = code.match(/exports\.inject\s*=\s*(\[[^\]]*\])/)
  ok(!!inj && /'slots'/.test(inj[1]), `exports.inject 声明了 slots（${inj?.[1]}）`)
  ok(!!inj && !/'settingsScope'/.test(inj[1]), '没声明用不到的 settingsScope（多写一个缺服务就整个半边不激活）')

  ok(/try\s*\{[\s\S]{0,220}slots\.inject/.test(code), '挂载整段在 try/catch 里 —— 浏览器半边绝不许把宿主界面搞崩')
  ok(/\/api\/whale\/status/.test(code), '设置页卡片拉 /api/whale/status（浏览器半边拿不到 Agent 工具）')
  ok(/\/api\/whale\/starter/.test(code) && /postStarter/.test(code), '开课入口拉 /api/whale/starter 并 POST 拼装（话术与拼装都在宿主侧）')
  ok(/status === 404/.test(code) && /重启宿主/.test(code), '404 有专门话术：说清"宿主还没装载这条路由，要重启宿主"（别让人以为路径写错了）')

  // 开课入口（侧栏那一行）：纯 DOM 注入，位置紧贴「新建会话」正下方
  ok(/data-dsh-whale-entry/.test(code), '入口那一行是纯 DOM 行（属性 data-dsh-whale-entry）')
  ok(/\[data-pane="sidebar"\]/.test(code) && /sidebarCol/.test(code), '定位侧栏外壳：`[data-pane="sidebar"], [class*="sidebarCol"]`（与技能中心同一套选择器）')
  ok(/button\[class\*="newSession"\]/.test(code), '定位原生「新建会话」按钮（新版嵌 logoRow、老版是直接子节点）')
  ok(/MutationObserver/.test(code), 'MutationObserver 自愈：React 重渲染把它冲掉时插回')
  ok(/previousElementSibling === base/.test(code), '**位置断言**：被别的插件行（技能中心）挤下去时挪回「新建会话」正下方')
  ok(/align-self:stretch/.test(code) && !/width:100%/.test(code), '撑满靠 align-self:stretch，**不写 width:100%**（写了总宽比「新会话」多 4px）')
  ok(/data-sidebar-collapsed/.test(code), '侧栏收起（rail）时切成 36×36 图标按钮（与原生收起变体一致）')
  ok(new RegExp("ENTRY_LABEL = '" + STARTER_LABEL + "'").test(code), `按钮/弹窗标题与宿主侧 STARTER_LABEL 一致（${STARTER_LABEL}）`)

  // 弹窗：用**官方 Modal**（不自己造遮罩/Esc/焦点），字段来自宿主
  ok(/require\(['"]@deepseek-ai\/dsh-client-ui-primitives['"]\)/.test(code), 'require 官方 primitives（本机多个第三方插件同款，不必进 dsh.client.external）')
  ok(/primitives\.Modal/.test(code), '弹窗用 `primitives.Modal` —— 不自己搓模态框')
  ok(/primitives\.Button/.test(code), '按钮用 `primitives.Button`（variant 由官方定义）')
  ok(/shell\.overlay/.test(code) && /id:\s*'whale-new-course-dialog'/.test(code), '挂在 shell.overlay（官方"整帧浮层"缝，当前零占用）')
  ok(!/要学什么|学完要能做出/.test(code), '**字段与话术不在客户端**（宿主 entry.form 发什么就画什么，没有第二份）')

  // composer 桥：不渲染任何东西，只把 inputActions 接出来给弹窗用
  ok(/conversation\.input\.left/.test(code), '坐位 conversation.input.left（composer 左侧工具行，零占用）')
  ok(/id:\s*'whale-bridge'/.test(code), '桥坐位 id = whale-bridge（不去抢官方 id）')
  ok(/function ComposerBridge[\s\S]{0,240}return null/.test(code), '桥组件**渲染 null** —— 它唯一职责是把 inputActions 接出来')
  ok(/setDraft\(\s*text\s*\)/.test(code), '「发送」先 setDraft（把拼好的正文写进草稿）')
  ok(/ia\.submit\s*\(/.test(code), '「发送」再 submit —— 这一下就是回车启动（用户明确要求发送键启动）')
  ok(/typeof ia\.setDraft\s*===\s*'function'/.test(code), '用之前先判类型（宿主换版就走退路，不静默失败）')
  ok(/navigator\.clipboard|window\.prompt/.test(code), '拿不到 inputActions 时有复制到剪贴板的退路')
  ok(/typeof ia\.submit\s*===\s*'function'/.test(code), 'submit 也先判类型（没有就别硬调）')

  // 样式：只许用宿主注入的语义令牌，不许自己造色（自己造色在深浅色下必崩，且和官方对不上）
  const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}[\s'";,)]/g)].map((m) => m[0].trim())
  ok(hex.length === 0, `代码里没有硬编码颜色${hex.length ? '（' + hex.join('、') + '）' : ''}`)
  const tokens = [...code.matchAll(/var\(--dsw-[a-z0-9-]+\)/g)].map((m) => m[0])
  ok(new Set(tokens).size >= 5, `样式走官方语义令牌（用到 ${new Set(tokens).size} 个，如 ${tokens[0] || '无'}）`)
  ok(tokens.every((t) => /^var\(--dsw-(alias|static|specific)-/.test(t)), '用到的都是宿主的 --dsw-* 令牌')
  ok(/重新读取/.test(code), '有「重新读取」按钮 —— 只读 ≠ 静态')
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 设置节 + 开课入口：只读状态路由（六块真数据 + 没配也回 200 并指路 + entry 协议四要素）+ 客户端半边格式与官方缝对齐')
