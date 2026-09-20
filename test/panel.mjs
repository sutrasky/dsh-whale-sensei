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
 *      只做**静态格式判据**：注册的是 `settings.section`（顶层设置项那条缝）、
 *      四个字段齐全、`id` 与包名对齐、`exports.inject` 只声明用到服务、
 *      **组件在工厂作用域定义**（在渲染回调里现造会让 React 每帧重挂载）、
 *      以及**样式只用官方语义令牌**（自己造色在深浅色主题里必崩）。
 *      ⚠️ 客户端**渲染**单测看不见（项目自己的教训）：这里能判到"格式对、内容对、装得上"，
 *      "卡片真的画出来了"只能重启宿主 + 刷新页面由人眼确认。**不谎报。**
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { plugin as statusPlugin } from '../lib/mods/status.js'

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

    const r2 = await get(undefined)
    const b2 = await r2.json()
    ok(r2.status === 200 && b2.configured === false, `**没配 packRoot 也回 200**（${r2.status} configured=${b2.configured}）—— 这一节的意义就是把这个错显示出来`)
    ok(/503/.test(b2.hint || '') && /cordis\.patch\.yml/.test(b2.hint || ''), `没配时 hint 说清症状与修法（${String(b2.hint).slice(0, 42)}…）`)

    const put = await mount(ROOT)[0].fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'PUT' }))
    ok(put.status === 405, `PUT → ${put.status}（只读）`)
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
console.log('✅ 设置节：只读状态路由（六块真数据 + 没配也回 200 并指路）+ 客户端半边格式与官方缝对齐')
