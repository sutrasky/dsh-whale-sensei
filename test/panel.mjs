#!/usr/bin/env node
/**
 * panel.mjs —— 设置页那一节（方案一：只读状态卡）的判据
 * ------------------------------------------------------------------
 * 两半各自判，因为它们的失败方式完全不同：
 *
 *   A. **宿主半边**（`lib/mods/status.js` + `GET /api/whale/status`）
 *      真驱动一遍 fetch 处理器（假 Request），坏样本齐全。
 *      ⚠️ 关键判据不是"配了能读到"，而是**没配时回 200 且说清怎么修** ——
 *      这一节存在的意义就是把"没配 packRoot ⇒ 所有 /api/whale/* 会 503"显示出来，
 *      回 503 的话卡片只能显示一个错误，反而看不出该怎么修。
 *
 *   B. **浏览器半边**（`lib/client.js`）
 *      只做**静态格式判据**：注册的是 `settings.section`（顶层设置项那条缝）、
 *      四个字段齐全、`id` 与包名对齐、`exports.inject` 只声明用到服务、
 *      **组件在工厂作用域定义**（在渲染回调里现造会让 React 每帧重挂载）。
 *      ⚠️ 客户端**渲染**单测看不见（项目自己的教训）：这里能判到"格式对、装得上"，
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
  const captured = []
  const warns = []
  statusPlugin.install({
    paths: { packRoot: ROOT },
    log: { info: () => {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) },
    registerTool: () => {},
    inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => captured.push(r) } }) }),
  })
  const route = captured.find((r) => r.path === '/api/whale/status')
  ok(!!route, `挂了 /api/whale/status（本模块共 ${captured.length} 条）`)
  ok(route && route.path.startsWith('/api/'), `路由在 /api 前缀下（${route?.path}）—— 栅栏与认证由基座继承`)
  ok(route && Array.isArray(route.methods) && route.methods.length === 1 && route.methods[0] === 'GET', `只收 GET（${route?.methods?.join(',')}）—— 只读`)
  ok(statusPlugin.tools.length === 0, '这一节不进工具面（tools 为空）')

  if (route) {
    const get = (root) => {
      const cap = []
      statusPlugin.install({
        paths: { packRoot: root },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: () => {},
        inject: (n, cb) => cb({ get: () => ({ fetch: { register: (r) => cap.push(r) } }) }),
      })
      return cap[0].fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'GET' }))
    }

    const r1 = await get(ROOT)
    const b1 = await r1.json()
    ok(r1.status === 200 && b1.ok === true && b1.configured === true, `配了 packRoot → ${r1.status} configured=${b1.configured}`)
    ok(b1.packRoot === path.resolve(ROOT), `回报的是解析后的绝对路径（${b1.packRoot}）`)
    ok(b1.pack && b1.pack.ok === true && /个圆圈/.test(b1.pack.summary), `带课程包概况（${b1.pack?.summary}）`)
    ok(!('circles' in b1) && !('lessons' in b1), '概况在 pack 里，不把整个 pack 摊平到顶层（只挑一屏够用的）')

    const r2 = await get(undefined)
    const b2 = await r2.json()
    ok(r2.status === 200 && b2.configured === false, `**没配 packRoot 也回 200**（${r2.status} configured=${b2.configured}）—— 这一节的意义就是把这个错显示出来`)
    ok(/503/.test(b2.hint || '') && /cordis\.patch\.yml/.test(b2.hint || ''), `没配时 hint 说清症状与修法（${String(b2.hint).slice(0, 46)}…）`)

    const put = await captured[0].fetch(new Request('http://127.0.0.1:3090/api/whale/status', { method: 'PUT' }))
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

  // 注册节：与设置页里那几个顶层项同一条缝、同样的四字段
  const reg = code.match(/register\(\s*\{([\s\S]{0,220}?)\}\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/)
  ok(!!reg, '找得到一次 slots.register({…}, 组件)')
  if (reg) {
    const spec = reg[1]
    ok(/name:\s*'settings\.section'/.test(spec), `注册在 settings.section（顶层设置项那条缝）`)
    ok(/id:\s*'whale-sensei'/.test(spec), `节 id = whale-sensei`)
    ok(/order:\s*\d+/.test(spec), `带 order（${(spec.match(/order:\s*\d+/) || [''])[0]}）—— 与「表情包」(25) 等并列排序`)
    ok(/label:\s*'[^']+'/.test(spec), `带 label（${(spec.match(/label:\s*'[^']+'/) || [''])[0]}）`)
    ok(!/createElement/.test(reg[0]), `第二个参数是**组件标识符**（${reg[2]}），不是现造的组件 —— 现造会让 React 每帧重挂载`)
  }
  ok(!/settings\.plugins\.tab/.test(code), '代码里没有去抢标签页 slot settings.plugins.tab（注释里提它是允许的）')

  const inj = code.match(/exports\.inject\s*=\s*(\[[^\]]*\])/)
  ok(!!inj && /'slots'/.test(inj[1]), `exports.inject 声明了 slots（${inj?.[1]}）`)
  ok(!!inj && !/'settingsScope'/.test(inj[1]), '没声明用不到的 settingsScope（多写一个缺服务就整个半边不激活）')

  ok(/try\s*\{[\s\S]{0,200}slots\.inject/.test(code), '挂载整段在 try/catch 里 —— 浏览器半边绝不许把宿主界面搞崩')
  ok(/\/api\/whale\/status/.test(code), '面板去拉 /api/whale/status（浏览器半边拿不到 Agent 工具）')
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 设置节：只读状态路由（含"没配也回 200 并指路"）+ 客户端半边格式与官方缝对齐')
