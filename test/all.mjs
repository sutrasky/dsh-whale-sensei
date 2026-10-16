/**
 * all.mjs —— 两本账合成一个入口（A3）
 *
 *   ① 课程包闸门：`<pack>/tools/gate.mjs`        → 本版 33 项
 *   ② 插件套件　：`test/run-all.mjs <packPath>`  → 本版 50 套 / 2525 条断言
 *
 * 三条硬规矩（都是从已经踩过的坑里长出来的）：
 *   ① **解析不到摘要 = 硬失败**，绝不静默记成「0 / 0 通过」
 *      —— run-all 上刚发生过：套件摘要多写一个前缀就被记成「0 通过 / 1 失败」✗
 *   ② **跳过 ≠ 通过**：3091 没监听时判词必须写成「绿（含 2 套部分跳过）」并点名是哪两套
 *   ③ **只当裁判，不重算**：两本自报的数字原样带出，不重新数断言、不重新判 PASS
 *
 * 零副作用：本文件不写任何东西。
 * 用法：
 *   node test/all.mjs [packPath]      两本都跑，合成一张表 + 一行判词 + 单一退出码
 *   node test/all.mjs --selftest      只跑解析器的原子断言（不碰任何子进程）
 */
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packRoot, PLUGIN } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// const PLUGIN = path.resolve(HERE, '..')  // 已移至 _pack.mjs

/** 依赖 3091 预览服务的套件（它们的浏览器断言会静默变少 —— 必须点名） */
export const NEEDS_BROWSER = ['visual', 'practice']

const tail = (out) => String(out).split('\n').slice(-8).join('\n')

/** 闸门输出 → 结论。解析不到摘要 → parsed:false（调用方按失败处理，不按 0/0） */
export function parseGate(out) {
  const m = String(out).match(/闸门：(\d+)\s*\/\s*(\d+)\s*通过/)
  if (!m) return { ok: false, parsed: false, error: '解析不到闸门摘要行', rawTail: tail(out) }
  const pass = Number(m[1])
  const total = Number(m[2])
  const fails = [...String(out).matchAll(/^(?:FAIL|✗)\s+(.+)$/gm)].map((x) => x[1].trim())
  return { ok: pass === total && fails.length === 0, parsed: true, pass, total, fails }
}

/** run-all 输出 → 结论。同上，解析不到就是失败 */
export function parseSuites(out) {
  const m = String(out).match(/===\s*(\d+)\s*套\s*·\s*共\s*(\d+)\s*条断言\s*·\s*(全部通过|(\d+)\s*套失败)/)
  if (!m) return { ok: false, parsed: false, error: '解析不到套件摘要行', rawTail: tail(out) }
  const failed = m[4] ? Number(m[4]) : 0
  const bad = [...String(out).matchAll(/^✗\s+(\S+)/gm)].map((x) => x[1])
  return { ok: failed === 0, parsed: true, suites: Number(m[1]), asserts: Number(m[2]), failed, bad }
}

/** 合成判词：任何一本没解析到 / 有红 → 红；有跳过 → 明说，不给干净的"全绿" */
export function summarize(gate, suites, browserUp) {
  const lines = [
    `课程包闸门：${gate.parsed ? `${gate.pass} / ${gate.total} 通过` : '未解析到摘要（判失败）'}`,
    `插件套件　：${suites.parsed ? `${suites.suites} 套 · ${suites.asserts} 条断言` : '未解析到摘要（判失败）'}`,
  ]
  const skipped = browserUp ? [] : NEEDS_BROWSER.slice()
  const green = gate.ok && suites.ok
  const verdict = !green ? '红' : (skipped.length ? `绿（含 ${skipped.length} 套部分跳过）` : '绿')
  return { green, verdict, skipped, lines }
}

function probePort(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (v) => { try { s.destroy() } catch { /* 已关就算了 */ } resolve(v) }
    s.setTimeout(timeoutMs)
    s.on('connect', () => done(true))
    s.on('timeout', () => done(false))
    s.on('error', () => done(false))
  })
}

function runNode(script, cwd) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain && process.argv.includes('--selftest')) {
  const gGreen = parseGate('PASS 1ms x\n=== 闸门：16 / 16 通过 —— 全绿 ===')
  const gRed = parseGate('FAIL 1ms y\n=== 闸门：15 / 16 通过 ===')
  const gNone = parseGate('这一段里没有任何摘要行')
  const sGreen = parseSuites('=== 17 套 · 共 384 条断言 · 全部通过 ✓ ===')
  const sRed = parseSuites('✗ glossary-edit 0 通过 / 1 失败\n=== 17 套 · 共 353 条断言 · 1 套失败 ✗ ===')
  const sNone = parseSuites('没有摘要')
  const cases = [
    [gGreen.ok === true && gGreen.pass === 16 && gGreen.total === 16, '闸门全绿 → ok 16/16'],
    [gRed.ok === false && gRed.fails.length === 1, '闸门有红 → 不是 ok，且列出 FAIL 行'],
    [gNone.parsed === false && gNone.ok === false, '闸门摘要缺失 → parsed=false（判失败，不按 0/0）'],
    [sGreen.ok === true && sGreen.suites === 17 && sGreen.asserts === 384, '套件全绿 → ok 17 套/384 条'],
    [sRed.ok === false && sRed.failed === 1 && sRed.bad.join() === 'glossary-edit', '套件有红 → 不是 ok，且点名是哪套'],
    [sNone.parsed === false && sNone.ok === false, '套件摘要缺失 → parsed=false'],
    [summarize(gGreen, sGreen, false).verdict.includes('部分跳过'), '3091 停 → 判词点名部分跳过（不给干净的绿）'],
    [summarize(gGreen, sGreen, true).verdict === '绿', '3091 在 → 判词就是绿'],
    [summarize(gNone, sGreen, true).green === false, '闸门解析失败 → 整体红'],
    [summarize(gGreen, sNone, true).green === false, '套件解析失败 → 整体红'],
  ]
  let bad = 0
  for (const [cond, msg] of cases) {
    console.log((cond ? 'ok   ' : 'FAIL ') + msg)
    if (!cond) bad++
  }
  console.log('\n=== selftest: ' + (cases.length - bad) + ' 通过 / ' + bad + ' 失败 ===')
  process.exit(bad ? 1 : 0)
}

if (isMain) {
  const PACK = packRoot()
  const browserUp = await probePort(3091)
  const g = runNode(path.join(PACK, 'tools', 'gate.mjs'), PACK)
  const s = runNode(path.join(HERE, 'run-all.mjs'), PLUGIN)
  const gate = parseGate(g.out)
  const suites = parseSuites(s.out)
  const r = summarize(gate, suites, browserUp)

  console.log('=== 两本账 ===')
  console.log('  包路径：' + PACK)
  for (const l of r.lines) console.log('  ' + l)
  console.log(`  子进程退出码：闸门 ${g.code} · 套件 ${s.code} · 3091 ${browserUp ? '在监听' : '未监听'}`)
  if (r.skipped.length) {
    console.log(`  ⚠️ 3091 未监听 → ${r.skipped.join(' / ')} 的浏览器断言**没有执行**（跳过 ≠ 通过）`)
  }
  for (const [name, res] of [['闸门', gate], ['套件', suites]]) {
    if (!res.parsed) console.log(`  ❌ ${name}摘要解析失败（判失败）：原始输出尾部\n` + res.rawTail)
  }
  if (gate.fails && gate.fails.length) console.log('  闸门失败项：' + gate.fails.join('、'))
  if (suites.bad && suites.bad.length) console.log('  套件失败项：' + suites.bad.join('、'))
  console.log(`\n=== 判词：${r.verdict} ===`)
  process.exit(r.green ? 0 : 1)
}
