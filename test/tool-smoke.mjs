/**
 * tool-smoke.mjs —— 工具面自检（不重启宿主也能验）
 *
 * 为什么要有这个：宿主要求工具定义**五个字段齐全**（name / description / parameters /
 * output:{schema,render} / execute），少一个就**静默拒绝注册** ✗ —— 那种错只有重启后才看得见。
 * 这里用一个假 hctx 把模块装一遍，把"装不上"提前到测试里。
 *
 * 判据：
 *   ① 每个模块都能 install，且注册出它声明的工具名
 *   ② 每个工具定义五字段齐全，且 output.render 是函数、能对真实返回值产出文本
 *   ③ 只读工具跑一遍不抛错，并且**不碰磁盘**（跑前跑后 mtime 逐字节比对）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

const MODS = ['lessonpack', 'build', 'probe', 'audit', 'style', 'mode', 'author', 'state', 'ask', 'glossary', 'brief', 'visual', 'practice']
// 这里是**注册工具的**模块。`note` / `status` 只挂 HTTP 路由、不注册工具，所以不在本表里
// （它们的路由由下面「路由面」那一段按模块表的 enabled 逐个数，不靠这张手写表）。

// ── 路由面：每条注册的路由都必须**显式声明 requestBody** ──────────────────
// 2026-09-24 现场踩到：漏写它时基座（`dsh-client-connection/lib/index.js:47,74-80`）按 `undefined`
// 分流，掉进 streaming 分支，给 GET 装了个 body ⇒ `Request with GET/HEAD method cannot have body`
// ⇒ 回 **400 空体**，而浏览器那侧 `.json()` 报的是 `Unexpected end of JSON input`
// ——**报错指向 JSON，真因在路由声明**。宿主的 `assertFetchRoute` 不校验这个字段，只能我们自己钉。
{
  const { manifest } = await import('../lib/mods/index.js')
  const routes = []
  const routeCtx = {
    paths: { packRoot: ROOT, dataDir: ROOT },
    log: () => {},
    registerTool: () => {},
    inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
  }
  for (const id of manifest.mods.enabled) {
    const mod = await import(`../lib/mods/${id}.js`)
    mod.plugin.install(routeCtx)
  }
  ok(routes.length > 0, `按模块表的 enabled 数出 ${routes.length} 条路由（${routes.map((r) => r.path).join(' · ')}）`)
  const undeclared = routes.filter((r) => r.requestBody !== 'buffered' && r.requestBody !== 'streaming')
  ok(
    undeclared.length === 0,
    `每条路由都显式声明了 requestBody${undeclared.length
      ? '（缺：' + undeclared.map((r) => r.path).join('、') + ' ⇒ 基座会当 streaming，GET 会 400 空体）'
      : `（${routes.map((r) => r.path.split('/').pop() + '=' + r.requestBody).join(' · ')}）`}`,
  )
  ok(routes.every((r) => typeof r.path === 'string' && r.path.startsWith('/api/')), '每条路由都在 /api 前缀下（栅栏与认证由基座继承）')
  ok(routes.every((r) => Array.isArray(r.methods) && r.methods.length > 0 && new Set(r.methods).size === r.methods.length), '每条路由的 methods 非空且不重复')
}
const tools = []
const hctx = {
  paths: { packRoot: ROOT, dataDir: ROOT },
  log: () => {},
  registerTool: (def) => tools.push(def),
}

for (const m of MODS) {
  const mod = await import(`../lib/mods/${m}.js`)
  const p = mod.plugin
  if (!p?.install) { ok(false, `lib/mods/${m}.js 导出了带 install 的 plugin`); continue }
  p.install(hctx)
  const declared = p.tools || []
  const got = declared.every((n) => tools.some((t) => t.name === n))
  ok(got, `lib/mods/${m}.js 装上了 ${declared.join(', ')}`)
}

console.log(`\n[smoke] 注册到 ${tools.length} 个工具：${tools.map((t) => t.name).join(' · ')}`)
// 上表 13 个模块各注册一个工具；另有 `note` / `status` 只挂路由不注册工具，以及
// `lib/index.js` 里的存活探针 `whale_ping`（不在 mods/ 表里）—— 所以工具面总数比上表多 1。
ok(tools.length === MODS.length, `上表 ${MODS.length} 个模块各注册一个工具（实得 ${tools.length}）`)

const FIELDS = ['name', 'description', 'parameters', 'output', 'execute']
for (const t of tools) {
  const missing = FIELDS.filter((f) => !(f in t))
  ok(missing.length === 0, `${t.name} 五字段齐全${missing.length ? '（缺 ' + missing.join(', ') + '）' : ''}`)
  ok(typeof t.output?.schema === 'object' && typeof t.output?.render === 'function', `${t.name} 的 output 有 schema + render 函数`)
}

// ── 只读调用：跑一遍，且不许碰磁盘 ──
const WATCH = ['lessons/programming/spring-boot/0001-spring-boot-hello-world.html', 'assets/theme.css', 'starmap/content.js', 'learning-records/state.json', 'questions/pending.jsonl', 'questions/seq.txt', 'GLOSSARY.md', 'learning-records/brief.md']
function snap() {
  return WATCH.map((rel) => {
    const p = path.join(ROOT, rel)
    try { const s = fs.statSync(p); return rel + ':' + s.size + ':' + s.mtimeMs } catch { return rel + ':missing' }
  }).join('|')
}

const byName = (n) => tools.find((t) => t.name === n)
const CALLS = [
  ['whale_lessonpack', {}],
  ['whale_build', {}], // 默认只校验 → 不许写盘
  ['whale_audit', {}],
  ['whale_style', {}], // 默认不 commit → 不许写盘
  ['whale_mode', { stored: 'dark', systemDark: false }],
  ['whale_probe', { path: 'lessons/src/programming/spring-boot/0001-spring-boot-hello-world.html' }],
  ['whale_state', {}], // 默认只读 → 不许产生 learning-records/state.json
  ['whale_ask', { action: 'list' }], // 只读 → 不许动 pending.jsonl / seq.txt
  ['whale_glossary', {}], // 默认只检查 → 不许动 GLOSSARY.md
  ['whale_brief', {}], // 默认只读 → 不许产生 learning-records/brief.md
]

const before = snap()
for (const [name, args] of CALLS) {
  const t = byName(name)
  if (!t) { ok(false, `${name} 在册（能调用）`); continue }
  try {
    const value = await t.execute({ root: ROOT, ...args })
    const rendered = t.output.render(args, value)
    const goodShape = Array.isArray(rendered) && rendered.every((x) => x && typeof x.text === 'string')
    ok(goodShape, `${name} 能调用，且 render 产出文本（${rendered?.[0]?.text?.slice(0, 42) || ''}…）`)
    // ⚠️ 宿主把多个 text 项**直接拼接、不插换行** —— 多段输出必须自己 join('\n') 成一个项，
    //    否则现场看到的是"糊成一坨"（whale_state / whale_build / whale_lessonpack 都踩过）✗
    ok(rendered.length === 1, `${name} 的 render 只返回一个 text 项（多的会被拼成一坨）`)
  } catch (e) {
    ok(false, `${name} 能调用（抛了：${e.message}）`)
  }
}
const after = snap()
ok(before === after, '只读工具跑完没有碰磁盘（产物 mtime / 大小逐项未变）')

// 会写盘的能力：默认参数下不许写
const authorValue = await byName('whale_author').execute({
  root: ROOT, point: 'spring-boot', number: 9, title: '冒烟骨架', slug: 'smoke-skeleton',
  hintTerm: '自动配置', source: { label: 'x', url: 'https://example.com/' },
})
ok(authorValue.wrote === false, 'whale_author 默认不写盘（返回值 wrote=false）')
ok(
  /未写盘/.test(byName('whale_author').output.render({}, authorValue).map((x) => x.text).join(' ')),
  'whale_author 的 render 文案也说明了"未写盘"（不然调用方会以为已经生成）'
)
ok(!fs.existsSync(path.join(ROOT, 'lessons', 'src', 'programming', 'spring-boot', '0009-smoke-skeleton.html')), 'whale_author 确实没有落盘')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 工具面：装得上、五字段齐全、只读调用不碰盘')
