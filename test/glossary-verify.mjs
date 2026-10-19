/**
 * glossary-verify.mjs —— 名词台账 → GLOSSARY.md 的搬运与漂移检查
 *
 * 判据的核心是**对拍**（插件合成 vs 磁盘/CLI 产物逐字节），不是"看着像"：
 *   ① 真包：插件合成 == 磁盘上的 GLOSSARY.md（这条同时证明"逐字搬对了"）
 *   ② 影副本：跑一遍课程包自带的 `node assets/build-glossary.js` 当 oracle →
 *      插件合成必须与它逐字节相同（CLI 是裁判）
 *   ③ 漂移检出：把影子的 GLOSSARY.md 改坏 → 必须报不一致，且 detail 落到行/列
 *   ④ 缺失检出：删掉影子的 GLOSSARY.md → missing=true
 *   ⑤ 落盘：写回后与合成逐字节相同；再写一次不重写（changed=false）
 *   ⑥ 工具面：默认**只检查不写盘**；write=true 才修
 *   ⑦ 真包全程未被改动
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { expectedGlossaryMarkdown, glossaryDrift, writeGlossary, loadGlossaryLedger, glossarySummary } from '../lib/glossary-io.js'
import { plugin as glPlugin } from '../lib/mods/glossary.js'
import { migratedPack } from './_t26-migrated-pack.mjs'
import { packRoot } from './_pack.mjs'

const INPUT_ROOT = packRoot()
const ROOT = migratedPack(INPUT_ROOT)
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
const hashOf = (p) => { try { return sha(fs.readFileSync(p)) } catch { return 'missing' } }
const GLOSS = path.join(ROOT, 'GLOSSARY.md')
const LEDGER = path.join(ROOT, 'assets', 'glossary-data.js')
const realBefore = hashOf(GLOSS) + '|' + hashOf(LEDGER)

console.log(`\n[glossary] 课程包：${ROOT}`)

// ── ① 真包对拍 ──
const expectedReal = expectedGlossaryMarkdown(ROOT)
const diskReal = fs.readFileSync(GLOSS, 'utf8')
ok(
  expectedReal === diskReal,
  `插件合成与磁盘 GLOSSARY.md **逐字节相同**（合成 ${expectedReal.length} / 磁盘 ${diskReal.length} 字符）`
    + (expectedReal === diskReal ? '' : ` —— ${glossaryDrift(ROOT).detail}`)
)
ok(expectedReal.length > 10000, `合成长度合理（${expectedReal.length} 字符，不是空壳）`)

// ── ⑦ 台账概览 ──
const ledger = loadGlossaryLedger(ROOT)
const info = glossarySummary(ledger)
ok(info.count === Object.keys(ledger).length && info.count > 50, `台账 ${info.count} 个名词 · ${info.categories} 个分类`)
ok(/共 \d+ 个名词，分为 \d+ 类/.test(expectedReal), '合成长文里的统计行与台账一致（占位符都填上了）')

// ── ② CLI 当 oracle（影副本）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-glossary-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const outTmp = path.join(tmp, 'GLOSSARY.md')
  fs.writeFileSync(outTmp, 'deliberately broken\n', 'utf8')
  let cliOk = true
  try {
    execFileSync(process.execPath, [path.join(tmp, 'assets', 'build-glossary.js')], { cwd: tmp, stdio: 'pipe' })
  } catch (e) { cliOk = false }
  ok(cliOk, 'CLI（assets/build-glossary.js）在影副本里跑通')
  const cliOut = fs.readFileSync(outTmp, 'utf8')
  ok(cliOut === expectedGlossaryMarkdown(tmp), `插件合成 == CLI 产物（逐字节，${cliOut.length} 字符）—— 搬运没走样`)

  // ── ③ 漂移检出 ──
  const broken = cliOut.replace('共 ', '共  ')
  fs.writeFileSync(outTmp, broken, 'utf8')
  const d1 = glossaryDrift(tmp)
  ok(d1.consistent === false && !d1.missing, `改坏一处 → 报出不一致（${d1.detail}）`)
  ok(/第 1 行/.test(d1.detail) || /第 \d+ 行/.test(d1.detail), '漂移能落到具体行/列（不是一个"不一致"了事）')

  // ── ⑥ 工具面：默认只检查不写盘 ──
  const tools = []
  glPlugin.install({ paths: { packRoot: tmp }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
  const tool = tools.find((t) => t.name === 'whale_glossary')
  ok(!!tool, 'whale_glossary 装得上')
  const checked = await tool.execute({ root: tmp })
  ok(checked.ok === false && /不一致/.test(checked.lines.join(' ')), `工具默认报出漂移（${checked.summary}）`)
  ok(fs.readFileSync(outTmp, 'utf8') === broken, '默认（没给 write）**不写盘**：坏文件原样留着')

  // ── ⑤ 落盘 ──
  const w1 = writeGlossary(tmp)
  ok(w1.changed === true && fs.readFileSync(outTmp, 'utf8') === expectedGlossaryMarkdown(tmp), `writeGlossary 写回正确内容（${w1.chars} 字符）`)
  const w2 = writeGlossary(tmp)
  ok(w2.changed === false, '内容没变时不重写（不白刷 mtime）')

  const fixed = await tool.execute({ root: tmp, write: true })
  ok(fixed.ok === true, `write=true 之后工具自报一致（${fixed.summary}）`)

  // ── ④ 缺失检出 ──
  fs.rmSync(outTmp, { force: true })
  const d2 = glossaryDrift(tmp)
  ok(d2.consistent === false && d2.missing === true, `删掉产物 → missing=true（${d2.detail}）`)
  const fixed2 = await tool.execute({ root: tmp, write: true })
  ok(fixed2.ok === true && fs.existsSync(outTmp), '产物缺失时 write=true 能重建出来')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑦ 真包没被动过 ──
ok(hashOf(GLOSS) + '|' + hashOf(LEDGER) === realBefore, '真包全程未被改动（GLOSSARY.md + 台账哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 名词台账：合成与 CLI 逐字节一致，漂移/缺失都报得出，落盘幂等')
