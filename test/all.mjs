/**
 * all.mjs —— 两本账合成一个入口（A3 / T01）
 *
 *   ① 课程包闸门：`<pack>/tools/gate.mjs`        → 本版 38 项
 *   ② 插件套件　：`test/run-all.mjs <packPath>`  → 本版 50 套
 *
 * 四条硬规矩（前三条是从已经踩过的坑里长出来的，第四条是 T01 补的）：
 *   ① **解析不到摘要 = 硬失败**，绝不静默记成「0 / 0 通过」
 *   ② **跳过 ≠ 通过**：没跑的项必须单列，绝不计进通过
 *   ③ **只当裁判，不重算**：两本自报的数字原样带出，不重新数断言、不重新判 PASS
 *   ④ **摘要 ≠ 跑过**（报告 F01）：绿摘要 + 非零退出码、红行 + 「全部通过」、
 *      0/0、无摘要 + exit0、重复摘要 —— 五种假绿一律判红。
 *      判词由**机器结果**（`{passed, failed, skipped, reason, packRoot, base, cases}`）
 *      决定：子进程退出码 + 执行记录 + 旧文本 adapter 逐项对账，缺一项就是红。
 *
 * 零副作用：本文件不写任何东西（run-all 的机器结果由它自己落盘，本文件只读）。
 * 用法：
 *   node test/all.mjs [packPath]      两本都跑，合成一张表 + 一行判词 + 单一退出码
 *   node test/all.mjs --selftest      只跑解析器的原子断言（不碰任何子进程）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  resolveTestContext, contextArgs, contextEnv, formatTestContext, PLUGIN,
} from './_pack.mjs'
import { createFixture } from './_fixture.mjs'
import { adaptLegacyText, validateRunResult, readRunResult } from './_result.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// const PLUGIN = path.resolve(HERE, '..')  // 已移至 _pack.mjs

/**
 * 已知需要 3091 预览服务的套件（它们的浏览器断言会变少 —— 必须点名）。
 * T01：**不再靠探 3091 端口猜 skip**。这份名单只用来在机器结果里核对
 * 「run-all 报的 skip 里有没有它们」；skip 的唯一来源是执行记录。
 */
export const NEEDS_BROWSER = ['visual', 'practice']

const tail = (out) => String(out).split('\n').slice(-8).join('\n')

/** 旧文本协议 → 结论。**严格 adapter**：摘要唯一、红行逐项、执行量非零、退出码为 0 */
export function parseGate(out, code = null) {
  const r = adaptLegacyText({ kind: 'gate', out, code, label: 'gate' })
  return { ...r, rawTail: r.rawTail ?? tail(out) }
}

/** run-all 输出 → 结论。同上，解析不到就是失败 */
export function parseSuites(out, code = null) {
  const r = adaptLegacyText({ kind: 'suites', out, code, label: 'suites' })
  return { ...r, rawTail: r.rawTail ?? tail(out) }
}

/**
 * 合成判词。
 * - `execution` 传**对象**（新协议）= 严格判定：看子进程退出码 + 执行记录 + 机器结果。
 * - `execution` 传布尔/不传（旧签名）= 只按解析结果判，`true` 表示 3091 在监听。
 *   这条旧路径只为 `--selftest` 保留，总入口已改走严格路径。
 */
export function summarize(gate, suites, execution) {
  const lines = [
    `课程包闸门：${gate.parsed ? `${gate.pass} / ${gate.total} 通过` : '未解析到摘要（判失败）'}`,
    `插件套件　：${suites.parsed ? `${suites.suites} 套 · ${suites.asserts} 条断言` : '未解析到摘要（判失败）'}`,
  ]
  const strict = !!execution && typeof execution === 'object'
  const skipped = []
  if (!strict) {
    const browserUp = !!execution
    if (!browserUp) skipped.push(...NEEDS_BROWSER)
    const green = gate.ok && suites.ok
    const verdict = !green ? '红' : (skipped.length ? `绿（含 ${skipped.length} 套部分跳过）` : '绿')
    return { green, verdict, skipped, lines }
  }

  const { gateCode = null, suitesCode = null, suitesRecord = null } = execution
  const problems = []
  if (gateCode !== null && gateCode !== 0) problems.push(`闸门子进程退出码 ${gateCode}`)
  if (suitesCode !== null && suitesCode !== 0) problems.push(`套件子进程退出码 ${suitesCode}`)
  if (!gate.ok) problems.push(`闸门：${gate.reason || '不 ok'}`)
  if (!suites.ok) problems.push(`套件：${suites.reason || '不 ok'}`)

  let recordCheck = { ok: true, errors: [] }
  if (suitesRecord) {
    recordCheck = validateRunResult(suitesRecord)
    if (!recordCheck.ok) problems.push(`run-all 机器结果不合协议：${recordCheck.errors.slice(0, 3).join('；')}`)
    // 执行记录必须与实跑的退出码/红行对得上 —— 记录说全绿、退出码非零 = 红
    if (suitesCode !== null && recordCheck.ok && suitesCode !== 0 && suitesRecord.failed === 0) {
      problems.push(`run-all 记录说 0 失败，但退出码是 ${suitesCode}`)
    }
    // 记录与实跑红行必须一致：实跑有红而记录说 0 失败（或反过来）= 红
    const recFailed = recordCheck.ok ? suitesRecord.failed : 0
    const recBadSuites = recordCheck.ok ? suitesRecord.cases.filter((c) => c.status === 'fail' && !String(c.id).startsWith('exit:')).length : 0
    if (recordCheck.ok && suites.ok && suitesRecord.failed > 0) {
      problems.push(`实跑套件全绿，但 run-all 记录里 failed=${suitesRecord.failed}`)
    }
    if (recordCheck.ok && !suites.ok && recFailed === 0) {
      problems.push(`实跑套件有红，但 run-all 记录里 failed=0`)
    }
    if (recordCheck.ok && suites.parsed && Number.isInteger(suites.failed) && suites.failed > 0 && recBadSuites !== suites.failed) {
      problems.push(`run-all 记录里红套件 ${recBadSuites} 个，实跑红行 ${suites.failed} 条，对不上`)
    }
    if (recordCheck.ok && Number.isInteger(suitesRecord.skipped) && suitesRecord.skipped > 0) {
      skipped.push(...(Array.isArray(suitesRecord.cases) ? suitesRecord.cases.filter((c) => c.status === 'skip').map((c) => c.id) : []))
    }
  } else {
    problems.push('读不到 run-all 机器结果（执行记录缺失 = 红，不按 0/0）')
  }

  const green = problems.length === 0
  const verdict = !green ? '红' : (skipped.length ? `绿（含 ${skipped.length} 套部分跳过）` : '绿')
  return { green, verdict, skipped, lines, problems }
}

/**
 * 起一个子进程。
 * **T02（F02）**：`args` 是显式传给子进程的参数（绝对包根 + 模式），`env` 只是**兜底一致性**。
 * 以前这里只灌 `DSH_WHALE_PACK` 环境变量、argv 里什么都没有 —— 子套件于是可能用 env 里的
 * 另一个包（F02：「插件子套件丢失 B，可能用 env 里的 A」）。现在**两条都带**，且参数优先。
 */
function runNode(script, cwd, args = [], env = {}) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
    })
    return { code: 0, out: String(out), crashed: false }
  } catch (e) {
    const code = typeof e.status === 'number' ? e.status : null
    return { code, out: String(e.stdout ?? '') + String(e.stderr ?? ''), crashed: code === null, error: String(e.message ?? e) }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain && process.argv.includes('--selftest')) {
  const gGreen = parseGate('PASS 1ms x\n=== 闸门：16 / 16 通过 —— 全绿 ===', 0)
  const gRed = parseGate('FAIL 1ms y\n=== 闸门：15 / 16 通过 ===', 1)
  const gNone = parseGate('这一段里没有任何摘要行', 0)
  const sGreen = parseSuites('=== 17 套 · 共 384 条断言 · 全部通过 ✓ ===', 0)
  const sRed = parseSuites('✗ glossary-edit 0 通过 / 1 失败\n=== 17 套 · 共 353 条断言 · 1 套失败 ✗ ===', 1)
  const sNone = parseSuites('没有摘要', 0)
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
    // T01 新增：假绿矩阵（这几条以前是绿的，现在必须红）
    [parseGate('=== 闸门：38 / 38 通过 —— 全绿 ===', 2).ok === false, 'T01 绿摘要 + exit2 → 红'],
    [parseSuites('=== 50 套 · 共 2525 条断言 · 全部通过 ✓ ===', 2).ok === false, 'T01 套件绿摘要 + exit2 → 红'],
    [parseSuites('✗ a 0 通过 / 1 失败\n=== 50 套 · 共 2525 条断言 · 0 套失败 ===', 0).ok === false, 'T01 红行 + 摘要说 0 套失败 → 红'],
    [parseGate('=== 闸门：0 / 0 通过 ===', 0).ok === false, 'T01 0/0 → 红'],
    [parseSuites('=== 0 套 · 共 0 条断言 · 全部通过 ✓ ===', 0).ok === false, 'T01 0 套 0 条 → 红'],
    [parseSuites('=== 50 套 · 共 1 条断言 · 全部通过 ✓ ===\n=== 50 套 · 共 1 条断言 · 全部通过 ✓ ===', 0).ok === false, 'T01 重复摘要 → 红'],
    [parseGate('=== 闸门：38 / 38 通过 —— 全绿 ===', 0).ok === true, 'T01 真绿（exit0 + 唯一摘要 + 有量）→ ok'],
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
  // ── T02（F02）：**入口解析一次**，解析结果显式传给每一个子进程 ──────────────
  //   参数（`--pack=` / 位置参数 / `--mode=`）优先于 env；显式无效路径直接失败（exit 1）。
  let ctx
  let fixture = null
  try {
    ctx = resolveTestContext({ argv: process.argv.slice(2), env: process.env })
    if (ctx.mode === 'fixture' && !ctx.packRoot) {
      // 夹具模式：现场造一个自包含的合成包（**不依赖 study / 兄弟风格仓**）
      fixture = createFixture({ variant: process.env.DSH_WHALE_FIXTURE_VARIANT || 'multi-domain' })
      ctx = { ...ctx, packRoot: fixture.root }
    }
  } catch (e) {
    console.log('=== 两本账 ===')
    console.log('  ❌ ' + String(e.message || e).split('\n')[0])
    console.log('\n=== 判词：红（输入无效，退出码 1）===')
    process.exit(1)
  }
  const PACK = ctx.packRoot
  if (!PACK) {
    console.log('=== 两本账 ===')
    console.log('  ❌ 没有课程包根：给 --pack=<绝对路径>，或 DSH_WHALE_PACK=<绝对路径>')
    console.log('\n=== 判词：红（材料缺失，退出码 2）===')
    process.exit(2)
  }
  const ARGS = contextArgs(ctx)
  const ENV = contextEnv(ctx)
  const disposeFixture = () => {
    if (!fixture) return
    const c = fixture.dispose()
    if (!c.removed && c.error) console.log('  ⚠️ 夹具清理：' + c.error)
  }
  // run-all 的机器结果落盘路径：显式给，本入口跑完立刻读；读不到就是红。
  const resultFile = process.env.DSH_WHALE_RESULT
    || path.join(os.tmpdir(), `dsh-whale-run-all-${process.pid}.json`)
  try { fs.rmSync(resultFile, { force: true }) } catch { /* 删不掉就算了，读的时候自会报 */ }

  const gateScript = path.join(PACK, 'tools', 'gate.mjs')
  const runAllScript = process.env.DSH_WHALE_RUN_ALL || path.join(HERE, 'run-all.mjs')
  const g = runNode(gateScript, PACK, ARGS, ENV)
  const s = runNode(runAllScript, PLUGIN, ARGS, { ...ENV, DSH_WHALE_RESULT: resultFile })
  const gate = parseGate(g.out, g.code)
  const suites = parseSuites(s.out, s.code)
  const rec = readRunResult(resultFile)
  const suitesRecord = rec.ok ? rec.raw : null
  const r = summarize(gate, suites, { gateCode: g.code, suitesCode: s.code, suitesRecord })

  console.log('=== 两本账 ===')
  console.log('  ' + formatTestContext(ctx) + `（来源：pack=${ctx.source.pack} mode=${ctx.source.mode}）`)
  console.log('  包路径：' + PACK)
  for (const l of r.lines) console.log('  ' + l)
  console.log(`  子进程退出码：闸门 ${g.code === null ? '崩了(无退出码)' : g.code} · 套件 ${s.code === null ? '崩了(无退出码)' : s.code}`)
  if (r.skipped.length) {
    console.log(`  ⚠️ 跳过 ${r.skipped.length} 项（跳过 ≠ 通过）：${r.skipped.join(' / ')}`)
  }
  for (const [name, res] of [['闸门', gate], ['套件', suites]]) {
    if (!res.parsed) console.log(`  ❌ ${name}摘要解析失败（判失败）：原始输出尾部\n` + res.rawTail)
  }
  if (gate.fails && gate.fails.length) console.log('  闸门失败项：' + gate.fails.join('、'))
  if (suites.bad && suites.bad.length) console.log('  套件失败项：' + suites.bad.join('、'))
  if (g.crashed) console.log('  ❌ 闸门子进程没有正常退出：' + String(g.error || '').split('\n')[0])
  if (s.crashed) console.log('  ❌ 套件子进程没有正常退出：' + String(s.error || '').split('\n')[0])
  if (r.problems && r.problems.length) for (const p of r.problems) console.log('  ❌ ' + p)
  if (!rec.ok) for (const e of rec.errors.slice(0, 4)) console.log('  ❌ run-all 机器结果：' + e)

  // 判词只由机器结果决定：green 为真才是绿；skip 单列（绿但明说跳了几项）
  const verdict = r.green ? (r.skipped.length ? `绿（含 ${r.skipped.length} 套部分跳过）` : '绿') : '红'
  console.log(`\n=== 判词：${verdict} ===`)
  disposeFixture()
  process.exit(r.green ? 0 : 1)
}
