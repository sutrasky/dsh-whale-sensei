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
import { STARTER_LABEL } from '../lib/starter.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const ROOT = process.argv[2] || path.resolve(PLUGIN, '..', 'study')

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

    // —— 开课入口载荷（`lib/starter.js`）：协议全文由宿主算好，这里判"要素齐不齐" ——
    const e1 = b1.entry || {}
    ok(e1.id === 'new-course' && !!e1.label, `entry 有稳定 id 与按钮文案（${e1.id} / ${e1.label}）`)
    ok(Array.isArray(e1.steps) && e1.steps.length === 4, `entry.steps 四步（${(e1.steps || []).length} 步）`)
    const prompt = e1.prompt || ''
    ok(/问我学什么|先问我学什么/.test(prompt), '协议第①步：先问学什么')
    ok(/RESOURCES\.md/.test(prompt), '协议第②步：查资料落 RESOURCES.md（出处不许凭记忆）')
    ok(/whale_intake/.test(prompt) && /掌握程度/.test(prompt), '协议第③步：问掌握程度并 whale_intake 落盘（2026-09-21 漏掉的那一步）')
    ok(/闸门|拦下/.test(prompt), '协议写明：没落盘会被闸门拦下')
    ok(/whale_author/.test(prompt) && /whale_build/.test(prompt), '协议第④步：点名真实存在的工具（whale_author / whale_build）')
    ok(Array.isArray(e1.tracks), `entry.tracks 是数组（课程包现有知识点：${(e1.tracks || []).join('、') || '（无）'}）`)

    const r2 = await get(undefined)
    const b2 = await r2.json()
    ok(r2.status === 200 && b2.configured === false, `**没配 packRoot 也回 200**（${r2.status} configured=${b2.configured}）—— 这一节的意义就是把这个错显示出来`)
    ok(/503/.test(b2.hint || '') && /cordis\.patch\.yml/.test(b2.hint || ''), `没配时 hint 说清症状与修法（${String(b2.hint).slice(0, 42)}…）`)
    ok(!!b2.entry?.prompt, '**没配 packRoot 也发 entry** —— 入口不该因为没配课程包就静默消失')

    const put = await mount(ROOT)[0].fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'PUT' }))
    ok(put.status === 405, `PUT → ${put.status}（只读）`)
  }
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
  const fakeWindow = { __ModuleLoader__: { load: (m) => { mod = m } } }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  }
  const asked = []
  const req = (n) => { asked.push(n); if (n === 'react') return react; throw new Error('客户端 require 了没声明的包：' + n) }

  let boom = null
  try {
    new Function('window', 'require', src)(fakeWindow, req)
  } catch (e) { boom = e }
  ok(!boom && !!mod, `真加载：lazy-CJS 工厂能跑起来${boom ? '（' + boom.message + '）' : ''}`)
  ok(mod?.id === pkg.name, `__ModuleLoader__.load 的 id 是包名（${mod?.id}）`)
  ok(asked.every((n) => n === 'react'), `只 require 了冻结基座里的包（${[...new Set(asked)].join(', ') || '无'}）`)

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
  ok(regs.length === 2, `apply 里真的注册了 2 个坐位（实际 ${regs.length}）`)
  ok(regs[0]?.spec?.name === 'settings.section' && regs[0]?.spec?.id === 'whale-sensei', `坐位①：settings.section / whale-sensei（${regs[0]?.spec?.name}/${regs[0]?.spec?.id}）`)
  ok(regs[1]?.spec?.name === 'conversation.input.left' && regs[1]?.spec?.id === 'whale-bridge', `坐位②：conversation.input.left / whale-bridge（${regs[1]?.spec?.name}/${regs[1]?.spec?.id}）`)
  ok(regs.every((r) => typeof r.comp === 'function'), '两处注册的都是**组件函数**，不是现造的元素')
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
      const req2 = (n) => { if (n === 'react') return react; throw new Error('意外 require：' + n) }
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
  // 这不是 JS 解析器，只处理本文件的两种形态：块注释 + **整行**行注释。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

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
  ok(/\/api\/whale\/status/.test(code), '面板去拉 /api/whale/status（浏览器半边拿不到 Agent 工具）')

  // 开课入口：注册在输入框左侧工具行，点一下把协议 setDraft 进输入框
  ok(/data-dsh-whale-entry/.test(code), '入口那一行是纯 DOM 行（属性 data-dsh-whale-entry）')
  ok(/\[data-pane="sidebar"\]/.test(code) && /sidebarCol/.test(code), '定位侧栏外壳：`[data-pane="sidebar"], [class*="sidebarCol"]`（与技能中心同一套选择器）')
  ok(/button\[class\*="newSession"\]/.test(code), '定位原生「新建会话」按钮（新版嵌 logoRow、老版是直接子节点）')
  ok(/MutationObserver/.test(code), 'MutationObserver 自愈：React 重渲染把它冲掉时插回')
  ok(/previousElementSibling === base/.test(code), '**位置断言**：被别的插件行（技能中心）挤下去时挪回「新建会话」正下方')
  ok(/align-self:stretch/.test(code) && !/width:100%/.test(code), '撑满靠 align-self:stretch，**不写 width:100%**（写了总宽比「新会话」多 4px）')
  ok(/data-sidebar-collapsed/.test(code), '侧栏收起（rail）时切成 36×36 图标按钮（与原生收起变体一致）')
  ok(new RegExp("ENTRY_LABEL = '" + STARTER_LABEL + "'").test(code), `客户端那行按钮的字与宿主侧 STARTER_LABEL 一致（${STARTER_LABEL}）`)

  // composer 桥：不渲染任何东西，只把 inputActions 接出来给侧栏那一行用
  ok(/conversation\.input\.left/.test(code), '坐位 conversation.input.left（composer 左侧工具行，零占用）')
  ok(/id:\s*'whale-bridge'/.test(code), '桥坐位 id = whale-bridge（不去抢官方 id）')
  ok(/function ComposerBridge[\s\S]{0,240}return null/.test(code), '桥组件**渲染 null** —— 它唯一职责是把 inputActions 接出来')
  ok(/setDraft/.test(code), '点一下用 inputActions.setDraft 把协议写进草稿')
  ok(/typeof ia\.setDraft\s*===\s*'function'/.test(code), '用之前先判类型（宿主换版就走退路，不静默失败）')
  ok(/navigator\.clipboard|window\.prompt/.test(code), '拿不到 inputActions 时有复制到剪贴板的退路')
  ok(!/\.submit\s*\(/.test(code), '**不自动 submit** —— 只填草稿，人自己回车（避免误发）')
  ok(/entry\.prompt/.test(code), '协议全文从宿主侧的 entry.prompt 读（客户端不持有第二份）')

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
