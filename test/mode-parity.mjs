#!/usr/bin/env node
/**
 * test/mode-parity.mjs —— 主题状态机对拍（#10 缺口④ / 剩余清单 B3）
 * ------------------------------------------------------------------
 * 跑：node test/mode-parity.mjs
 *
 * 为什么要这条：包侧 `assets/theme.js` 与插件 `lib/mode.js` 的 `resolveMode`
 * **共用同一个存储键、同一套 DOM 字段**（`documentElement.style.colorScheme` +
 * `body[data-ds-dark-theme]`），但两侧**无注释互指、无对拍** —— 任何一侧把
 * 「偏好优先 / 垃圾值按没偏好处理」改掉，都没有东西会红。
 *
 * 做法：**真跑包侧那份文件**，不是抄一份逻辑 —— 用 `node:vm` 起一个最小 DOM 桩
 * （`window` / `document` / `localStorage` / `matchMedia`），把 `assets/theme.js`
 * 原样丢进去执行，然后读它**真正落到 DOM 的观测量**：
 *   · `window.LessonTheme.resolved()`（包侧自己算的明暗）
 *   · `document.documentElement.style.colorScheme`
 *   · `body[data-ds-dark-theme]` 属性在不在
 *   · 它**实际读写的是哪个 localStorage 键**（由桩记录，不是抄字面量）
 * 与 `resolveMode({stored, systemDark})` 报的三个字段逐格比。
 *
 * 矩阵：偏好 ∈ {未存过, '', light, dark, system, 垃圾值 ×5} × 系统 ∈ {深, 浅}。
 *
 * 反空转：两处**真源文本变异**（`dark` 分支反转 / 未知值当深色）必须让对拍变红。
 *   ⚠️ 已知**不红**的变异：删掉 `readStored` 里的 `VALID` 校验 —— 因为
 *   `resolveDark` 的 else 分支本来就把未知值当"跟随系统"，两者行为冗余。
 *   所以钉住「垃圾值按没偏好处理」的是 `resolveDark` 的 else，不是那条校验。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { resolveMode } from '../lib/mode.js'
import { packRoot } from './_pack.mjs'

const PACK = packRoot()
let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`) } else { fails.push(m); console.log(` FAIL ${m}`) } }

const THEME_JS = path.join(PACK, 'assets', 'theme.js')
console.log(`\n[mode-parity] 课程包：${PACK}`)

/** 在最小 DOM 桩里真跑包侧 theme.js，回它落到 DOM 的观测量（+ 桩记录的读写键）。 */
function runPack(src, { stored, systemDark, boot } = {}) {
  const readKeys = []
  const written = []
  const bodyAttrs = new Set()
  const el = () => ({
    dataset: {}, style: {}, children: [],
    setAttribute() {}, addEventListener() {}, appendChild() {}, insertBefore() {}, toggleAttribute() {},
  })
  const document = {
    readyState: 'complete',                 // 让 init() 同步跑，不等 DOMContentLoaded
    documentElement: { style: {} },
    body: {
      firstChild: null,
      insertBefore() {},
      toggleAttribute(name, on) { if (on) bodyAttrs.add(name); else bodyAttrs.delete(name) },
      hasAttribute: (n) => bodyAttrs.has(n),
    },
    createElement: el,
    addEventListener() {},
  }
  const sandbox = {
    window: { LESSON_THEME: boot, addEventListener() {} },
    document,
    localStorage: {
      getItem(k) { readKeys.push(k); return stored == null ? null : String(stored) },
      setItem(k, v) { written.push([k, v]) },
    },
    matchMedia: () => ({ matches: !!systemDark, addEventListener() {}, addListener() {} }),
  }
  vm.runInNewContext(src, sandbox, { filename: THEME_JS })
  const api = sandbox.window.LessonTheme
  // ⚠️ 必须是**活取值**：`set()` 之后再调一次才能看到 DOM 的新值（快照会读到 set 之前的旧值）
  const read = () => ({
    resolved: api ? api.resolved() : undefined,
    colorScheme: document.documentElement.style.colorScheme,
    darkAttr: bodyAttrs.has('data-ds-dark-theme'),
  })
  return { api, read, ...read(), readKeys, written }
}

/** 一格对拍：包侧真跑的观测量 vs 插件 resolveMode 报的三个字段。 */
function cell(src, { stored, systemDark, boot } = {}) {
  const raw = stored == null ? null : String(stored)
  const p = runPack(src, { stored, systemDark, boot })
  const m = resolveMode({ stored: raw, systemDark })
  const diffs = []
  if (p.resolved !== m.effective) diffs.push(`resolved=${p.resolved} ≠ effective=${m.effective}`)
  if (p.colorScheme !== m.colorScheme) diffs.push(`colorScheme=${p.colorScheme} ≠ ${m.colorScheme}`)
  if (p.darkAttr !== m.darkThemeAttr) diffs.push(`darkAttr=${p.darkAttr} ≠ ${m.darkThemeAttr}`)
  return { ok: diffs.length === 0, diffs, pack: p, plugin: m }
}

// ---------- 前置 ----------
ok(fs.existsSync(THEME_JS), '前置：课程包 assets/theme.js 在（对拍的真对象是它，不是副本）')
const SRC = fs.readFileSync(THEME_JS, 'utf8')
ok(/window\.LessonTheme\s*=/.test(SRC), '前置：它自曝 window.LessonTheme（对拍借的就是这个缝）')

const probe = runPack(SRC, { stored: null, systemDark: false })
ok(!!probe.api && typeof probe.api.resolved === 'function', '前置：真跑起来了，LessonTheme.resolved() 可调')
ok(probe.readKeys.length > 0, `前置：它真的走了 localStorage 读路径（读键 ${JSON.stringify(probe.readKeys)}）`)

// ---------- 存储键对拍（不抄字面量：用桩记录到的实际键） ----------
const PLUGIN_KEY = resolveMode({ stored: null, systemDark: false }).storageKey
ok(probe.readKeys[0] === PLUGIN_KEY, `存储键对拍：包实际读 ${probe.readKeys[0]} === 插件报 ${PLUGIN_KEY}`)

// ---------- 输入矩阵 ----------
const STORED = [null, '', 'light', 'dark', 'system', 'blue', 'Light', 'DARK', ' light ', '42']
const SYS = [true, false]
let cells = 0
for (const systemDark of SYS) {
  for (const stored of STORED) {
    const r = cell(SRC, { stored, systemDark })
    cells++
    const tag = `{stored=${JSON.stringify(stored)}, 系统=${systemDark ? '深' : '浅'}}`
    ok(r.ok, `${tag} → 包 ${r.pack.resolved}/${r.pack.colorScheme}/${r.pack.darkAttr} ＝ 插件 ${r.plugin.effective}/${r.plugin.colorScheme}/${r.plugin.darkThemeAttr}${r.ok ? '' : `  ✗ ${r.diffs.join('；')}`}`)
  }
}
ok(cells === 20, `矩阵跑满：${cells} 格（${STORED.length} 种偏好 × ${SYS.length} 种系统）`)

// ---------- 两条规则各自单独钉一遍（含今天的约定） ----------
const d0 = cell(SRC, { stored: 'light', systemDark: true })
ok(d0.ok && d0.pack.resolved === 'light', '规则①「偏好优先」：存 light + 系统深 ⇒ 仍是浅（两侧同）')
const d1 = cell(SRC, { stored: 'blue', systemDark: false })
const d2 = cell(SRC, { stored: null, systemDark: false })
ok(d1.ok && d2.ok && d1.pack.resolved === d2.pack.resolved, '规则②「垃圾值按没偏好处理」：blue 与未存过同结果（两侧同）')
const d3 = cell(SRC, { stored: 'blue', systemDark: true })
ok(d3.ok && d3.pack.resolved === 'dark', '规则②（反向）：blue + 系统深 ⇒ 深，即真的跟随了系统')

// ---------- boot 注入路径（页面内联脚本给的那份） ----------
// ⚠️ `boot.preference` 是**页面注入的覆盖值**，插件的 `resolveMode` 没有这个入参 ⇒
//    等价关系是「包 boot.preference=X ≡ 插件 stored=X」，不能拿 stored=null 去比。
const b1 = runPack(SRC, { stored: null, systemDark: false, boot: { preference: 'dark' } })
ok(b1.resolved === resolveMode({ stored: 'dark', systemDark: false }).effective,
  'boot.preference=dark 覆盖存储 ⇒ 与插件拿 stored=dark 同结果')
const b2 = runPack(SRC, { stored: null, systemDark: true, boot: { preference: 'blue' } })
ok(b2.resolved === resolveMode({ stored: 'blue', systemDark: true }).effective && b2.resolved === 'dark',
  'boot.preference 是垃圾值 ⇒ 也按没偏好处理（跟随系统=深）')

// ---------- 写路径：拒垃圾值 + 写的是同一个键 ----------
const w = runPack(SRC, { stored: null, systemDark: false })
ok(w.api.set('blue') === false, '写路径：包侧 LessonTheme.set(垃圾值) 返回 false（拒写）')
ok(w.written.length === 0, '写路径：拒写时一个字节都没落 localStorage')
ok(w.api.set('dark') === true, '写路径：LessonTheme.set(dark) 返回 true')
ok(w.written.length === 1 && w.written[0][0] === PLUGIN_KEY && w.written[0][1] === 'dark',
  `写路径：落的键也是 ${PLUGIN_KEY}（桩记录 ${JSON.stringify(w.written)}）`)
const wa = w.read()   // set 之后**重新取**，不能读 runPack 返回前的快照
ok(wa.colorScheme === 'dark' && wa.darkAttr === true, '写路径：set 之后 DOM 两个字段立刻变深（与插件报的字段同名同值）')

// ---------- 反空转：真源文本变异必须让对拍变红 ----------
// ⚠️ 每个变异要配**能命中被变异分支**的探针格 —— 否则变异跑了但没被击中，会假绿。
const MUT = [
  ['dark 分支反转', "if (preference === 'dark') return true;", "if (preference === 'dark') return false;", { stored: 'dark', systemDark: false }],
  ['未知值当深色', 'return !!(mq && mq.matches);', 'return true;', { stored: 'blue', systemDark: false }],
]
for (const [label, from, to, probeCell] of MUT) {
  const mutated = SRC.replace(from, to)
  ok(mutated !== SRC, `反空转：变异「${label}」真的改到了源文本`)
  const bad = cell(mutated, probeCell)
  ok(!bad.ok, `反空转：变异「${label}」后对拍变红（探针 ${JSON.stringify(probeCell)}：${bad.diffs[0] || '（无差异——变异没被钉住！）'}）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
