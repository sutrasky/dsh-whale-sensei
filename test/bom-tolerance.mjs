/**
 * bom-tolerance.mjs —— BOM 容忍（本机已知坑位，收在 lib/text.js）
 *
 * 为什么单开一套：PowerShell 用 `Set-Content` / `Add-Content -Encoding utf8` 写出来的文件
 * **开头带 BOM**（`EF BB BF`），于是 `JSON.parse` 抛、或逐行解析时那一行被 catch 成 null
 * → **静默少算一条数据**。课程包自己的脚本都专门剥它（`drain-questions.js:30`、
 * `ask-watch.js:52-54`），插件这边漏剥过一次，现场表现为"队列里明明有这条却说找不到" ✗
 *
 * 判据的形状（关键）：**同一份内容，带 BOM 与不带 BOM，插件读出来的结果必须完全一致**。
 * 所以不写"期望值"，而是**两个批次对拍**：
 *   Phase 1：影副本里写**干净**的 progress.json / notes.jsonl / point.json / EXPECT.json / lesson.config.json
 *   Phase 2：同样内容**全加上 BOM**（notes 故意把 BOM 放在中间那一行）
 *   → readPack / planBuild / probeState / composeTheme 四路结果逐字相同 ✓
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { planBuild } from '../lib/render-inputs.js'
import { probeState } from '../lib/state-scan.js'
import { composeTheme } from '../lib/style.js'
import { stripBom, splitLines, parseJsonLoose } from '../lib/text.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12)
const BOM = '\uFEFF'
const hashTree = (dir) => {
  const out = []
  const walk = (d, rel) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r + ':' + sha(fs.readFileSync(path.join(d, e.name))))
    }
  }
  walk(dir, '')
  return out.join('|')
}

console.log(`\n[bom] 课程包：${ROOT}`)

// ── ① 基础：剥 BOM 的三个助手 ──
ok(stripBom(`${BOM}abc`) === 'abc' && stripBom(`a${BOM}b`) === `a${BOM}b`, 'stripBom 只剥**开头**那一个')
ok(splitLines(`${BOM}a\n${BOM}b\nc`)[1] === 'b', 'splitLines 逐行剥**行首**的 BOM（PowerShell 的 Add-Content 就是把 BOM 落在追加行行首）')
ok(splitLines('a\uFEFFb')[0] === 'a\uFEFFb', '只在行首剥：行内/行尾的 BOM 不动 —— 与课程包自带的 drain-questions.js 保持一致（不擅自扩大语义）')
ok(parseJsonLoose(`${BOM}{"a":1}`).a === 1, 'parseJsonLoose 能吃带 BOM 的 JSON')
let perr = null
try { parseJsonLoose('nope') } catch (e) { perr = e.message }
ok(!!perr && /BOM/.test(perr), `解析失败时错误信息点明可能是 BOM/编码问题（${String(perr).slice(0, 40)}…）`)

const realBefore = hashTree(ROOT)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bom-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const F = {
    progress: path.join(tmp, 'progress.json'),
    config: path.join(tmp, 'lesson.config.json'),
    notes: path.join(tmp, 'notes', 'notes.jsonl'),
    point: path.join(tmp, 'lessons', 'programming', 'spring-boot', 'point.json'),
    expect: path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'),
  }
  for (const [k, p] of Object.entries(F)) {
    if (!fs.existsSync(p)) { ok(false, `测试前提：${k} 存在（${p}）`); }
  }

  // 只改这几份输入，日志与 DOM 里不会出现 BOM（PAGE 里也没有）
  const NOTE_LINES = [
    JSON.stringify({ lesson: '第1课', text: '干净的笔记一' }),
    JSON.stringify({ lesson: '第1课', text: '干净的笔记二' }),
  ]
  const writeSet = (bom) => {
    const b = bom ? BOM : ''
    fs.writeFileSync(F.notes, b + NOTE_LINES[0] + '\n' + b + NOTE_LINES[1] + '\n', 'utf8')
    // progress.json / lesson.config.json / point.json / EXPECT.json：只加 BOM，内容不变
    for (const key of ['progress', 'config', 'point', 'expect']) {
      const raw = fs.readFileSync(F[key], 'utf8')
      fs.writeFileSync(F[key], b + stripBom(raw), 'utf8')
    }
  }
  const snap = () => {
    const pack = readPack(tmp)
    const plan = planBuild(tmp, pack)
    const state = probeState(tmp, pack).state
    const style = composeTheme(tmp, {})
    return {
      learned: JSON.stringify(pack.learned),
      warnings: pack.warnings.length,
      plan: plan.files.map((f) => f.path + ':' + sha(f.content)).join('|'),
      planBytes: plan.files.map((f) => f.content.length).join(','),
      state: sha(JSON.stringify(state)),
      proseLessons: state.projects[0]?.lessons?.length ?? -1,
      styleUsed: style.used,
      styleChars: (style.css || '').length,
    }
  }

  writeSet(false)
  const clean = snap()
  writeSet(true)
  const bom = snap()

  ok(clean.learned === bom.learned, `readPack：progress.json 带 BOM 也读得出进度（learned ${bom.learned}）`)
  ok(clean.plan === bom.plan && clean.planBytes === bom.planBytes, `planBuild：渲染结果**逐字相同**（${bom.planBytes}）`)
  ok(clean.state === bom.state, 'state 探针：EXPECT.json + point.json 带 BOM 结果也相同')
  ok(clean.proseLessons === bom.proseLessons && bom.proseLessons >= 0, `缺口计算照常（${bom.proseLessons} 课）`)
  ok(clean.styleUsed === bom.styleUsed && clean.styleChars === bom.styleChars, `主题合成：lesson.config.json 带 BOM 也拿到 style（预设 ${bom.styleUsed} · ${bom.styleChars} 字符）`)
  // 反向断言：证明"带 BOM"这一批**真的**把 BOM 写进去了（否则上面全是空转）
  ok(
    fs.readFileSync(F.notes, 'utf8').startsWith(BOM) && fs.readFileSync(F.progress, 'utf8').startsWith(BOM),
    '反空转：Phase 2 的文件确实以 BOM 开头（不然上面的对拍没有意义）'
  )
  // 中间那一行的 BOM：笔记数必须与干净批次一致（这条最容易静默少算）
  ok(
    splitLines(fs.readFileSync(F.notes, 'utf8')).filter((l) => l.trim()).length === 2,
    'notes.jsonl 中间那行带 BOM 也仍被算作 2 条（不静默丢）'
  )
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

ok(hashTree(ROOT) === realBefore, '真包全程未被改动（全树哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ BOM 容忍：带 BOM 与不带 BOM，四路读取结果完全一致')
