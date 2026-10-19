#!/usr/bin/env node
/**
 * test/glossary-first-term.mjs —— **新课程包的第一个术语**插不进去（出厂骨架带注释）
 * ==================================================================
 * 跑：node test/glossary-first-term.mjs
 *
 * 【这条 bug 的原样】插件随包的出厂骨架 `lib/pack-template/assets/glossary-data.js` 里，
 * 空对象不是"真的空"，而是留了一行注释：
 *
 *     65:   return {
 *     66:     // 在这里按分类顺序添加名词……
 *     67:   };
 *
 * 旧实现用 `/\breturn\s*\{\s*$/` 判"这是不是空台账"—— 注释在 `return {` 的下一行，
 * `\s*$` 匹配不到它 ⇒ `empty=false` ⇒ 走到"给上一条记录补逗号"⇒ 末尾不是 `}` ⇒
 * 抛「上一条记录末尾不是 `}`，插入点可疑」⇒ **新包的第一个术语永远插不进去**。
 * 而 hintTerm 查不到术语会让 `lib/render.js` 直接拒绝渲染（renderPage 第 336 行）⇒
 * 新包的第一课永远建不出来。
 *
 * 【判据（每条都能反空转）】
 *   §0 输入是真的：读**插件出厂骨架源文件**，不是手写一个"像骨架的字符串"；
 *      建包（lib/pack-scaffold.js 的 writeScaffold）拷过去的台账必须与它**逐字节相同**。
 *   ① 首次新增（空台账 + 注释骨架）——不抛、键认得出、**注释还在**、真子进程 require 读得回。
 *   ② 再次新增（已有一条，末条要补逗号）——真子进程读得回两条，顺序不变。
 *   ③ 更新已有术语（replace:true，code 里带 `{` / `"` / 反引号模板串 / `$&`）——逐字往返。
 *      （`$&` 专门钉"不用 String.replace 拼替换串"这条：替换串里的 `$&` 会被当反向引用写飞）
 *   ④ 损坏结构仍然拒写：骨架收尾被破坏 / 上一条记录末尾不是 `}` ⇒ 抛错，且**字节不动**。
 *   ⑤ 用首个术语当 hintTerm **真构建第一课**：负向对照（没登记就必须 reject）+ 写入后
 *      `planBuild` 真的产出课程页，页面里出现术语 label（缺术语就真失败，不是 mock）。
 *
 * 反空转：把 upsertTermSource 的 `hasPrevRecord = keys.length > 0` 改回
 * `/\breturn\s*\{\s*$/` ⇒ ① ② ③ ④ ⑤ 里带"首次新增"的那几条当场红（本套件就是那个复现）。
 * 把骨架里那行注释删掉（"为了过测试改骨架"）⇒ §0 与 ①③ 立刻红。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

// T02/F02：本套件自报 `[test-context]`（run-all 逐进程对账；不 import 就是 ctxDrift 红）
import './_pack.mjs'

import { upsertTermSource, parseTermKeys } from '../lib/glossary.js'
import { writeTermSurgically } from '../lib/glossary-edit-io.js'
import { authorLesson, validateSkeleton } from '../lib/author.js'
import { planBuild } from '../lib/render-inputs.js'
import { writeScaffold, TEMPLATE_DIR } from '../lib/pack-scaffold.js'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)

let pass = 0
const fails = []
function ok(cond, msg) {
  // ⚠️ `FAIL ` 必须顶行（run-all 的 adapter 只认 `^(FAIL|✗)\s+`，缩进一条就把红行账记错）
  if (cond) { pass++; console.log('  ok  ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
/** 跑一步；抛错就变成 {ok:false,error}（后续断言据此判断"前置失败"）。 */
function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) } }
}
const NO_PRE = '  ［前置失败，本条判据未成立］'

/** 临时目录：一律 os.tmpdir() 下（绝不落课程包）＋ 清理前核对根前缀。 */
const TEMP_ROOT = os.tmpdir()
const made = []
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(TEMP_ROOT, `whale-first-term-${tag}-`))
  made.push(d)
  return d
}
function disposeAll() {
  for (const d of made) {
    const abs = path.resolve(d)
    if (!abs.startsWith(path.resolve(TEMP_ROOT) + path.sep)) throw new Error('拒绝清理未知临时目录：' + abs)
    fs.rmSync(abs, { recursive: true, force: true })
  }
}
/** 用**真子进程**加载一份生成出来的数据源并把它读回来（不 mock：真的 require 一次）。 */
function loadInSubprocess(absFile, keys) {
  const code = 'const g=require(process.argv[1]);'
    + 'const out={keys:Object.keys(g),rec:{}};'
    + 'for(const k of process.argv.slice(2))out.rec[k]=g[k]===undefined?null:g[k];'
    + 'process.stdout.write(JSON.stringify(out))'
  const r = spawnSync(process.execPath, ['-e', code, absFile, ...keys], { encoding: 'utf8' })
  if (r.error) return { ok: false, error: '起不来子进程：' + r.error.message }
  if (r.status !== 0) return { ok: false, error: `子进程退出码 ${r.status}：${(r.stderr || '').split('\n')[0]}` }
  try { return { ok: true, value: JSON.parse(r.stdout) } } catch (e) { return { ok: false, error: '子进程输出不是 JSON：' + r.stdout } }
}

console.log('\n[glossary] 新包第一个术语：出厂骨架（带注释的空台账）')

try {
  /* ── §0 输入是**真的**：插件出厂骨架源文件 + 建包时拷过去的那一份 ───────────── */
  const SKELETON_PATH = path.join(TEMPLATE_DIR, 'assets', 'glossary-data.js')
  ok(fs.existsSync(SKELETON_PATH), `§0 出厂骨架源文件在：${SKELETON_PATH}`)
  const SKEL_BYTES = fs.readFileSync(SKELETON_PATH)
  const SKEL = SKEL_BYTES.toString('utf8')
  ok(/return \{\s*\n\s*\/\/ 在这里按分类顺序添加名词/.test(SKEL),
    '§0 骨架的空对象里**真的有那行注释**（`return {` 下一行）—— 这就是旧实现判错的形状')
  ok(parseTermKeys(SKEL).length === 0 && !(SKEL_BYTES[0] === 0xEF && SKEL_BYTES[1] === 0xBB && SKEL_BYTES[2] === 0xBF),
    '§0 骨架是空台账（0 个键）且是 UTF-8 无 BOM —— 带 BOM 会走另一条路，别混进来')

  const packRoot = tmpDir('pack')
  const sc = writeScaffold(packRoot)
  ok(sc.ok === true, `§0 真建包成功（lib/pack-scaffold.js 的 writeScaffold 铺了 ${sc.created ? sc.created.length : 0} 个件）${sc.ok ? '' : '：' + sc.error}`)
  const PACK_LEDGER = path.join(packRoot, 'assets', 'glossary-data.js')
  const COPIED = (() => { try { return fs.readFileSync(PACK_LEDGER) } catch { return Buffer.alloc(0) } })()
  ok(COPIED.equals(SKEL_BYTES),
    '§0 建包拷过去的台账与出厂骨架**逐字节相同**（新包的第一个术语就是插在这份上）')

  /* ── ① 首次新增：空台账 + 注释骨架 ──────────────────────────────────────── */
  const REC1 = { label: '响应体', category: 'Web 基础', official: '官方定义：HTTP 响应正文', short: '大白话：服务器回给你的内容', analogy: '类比：回信里的正文', lesson: '第1课' }
  const first = attempt(() => upsertTermSource(SKEL, 'responsebody', REC1))
  ok(first.ok, `① 首次新增**不抛**（旧实现在这里抛「上一条记录末尾不是 \`}\`，插入点可疑」）${first.ok ? '' : '：' + first.error}`)
  const SRC1 = first.ok ? first.value : ''
  ok(first.ok && parseTermKeys(SRC1).join(',') === 'responsebody',
    `① 插入后键表 = [responsebody]（实得 [${first.ok ? parseTermKeys(SRC1).join(',') : '—'}］）${first.ok ? '' : NO_PRE}`)
  ok(first.ok && SRC1.includes('// 在这里按分类顺序添加名词'),
    `① 骨架注释**还在**（不许为了过测试删注释）${first.ok ? '' : NO_PRE}`)
  ok(first.ok && /responsebody: \{\n {6}label: '响应体',/.test(SRC1) && /lesson: '第1课'\n {4}\}\n {2}\};/.test(SRC1),
    `① 记录块插在注释之后、顶层收尾之前（末条**不带**逗号）${first.ok ? '' : NO_PRE}`)

  // 真子进程 require 读回
  const readDir1 = tmpDir('read1')
  fs.mkdirSync(path.join(readDir1, 'assets'), { recursive: true })
  const readFile1 = path.join(readDir1, 'assets', 'glossary-data.js')
  if (first.ok) fs.writeFileSync(readFile1, SRC1, 'utf8')
  const read1 = first.ok ? loadInSubprocess(readFile1, ['responsebody']) : { ok: false, error: NO_PRE }
  ok(read1.ok, `① 生成出来的源码**真能被 node require**（真子进程，不是 mock）${read1.ok ? '' : '：' + read1.error}`)
  ok(read1.ok && JSON.stringify(read1.value.rec.responsebody) === JSON.stringify(REC1),
    `① 子进程读回的记录六字段逐字一致${read1.ok ? '' : NO_PRE}`)

  /* ── ② 再次新增：已有一条记录，末条要补逗号 ─────────────────────────────── */
  const REC2 = { label: '请求体', category: 'Web 基础', official: '官方定义：HTTP 请求正文', short: '大白话：你发给服务器的内容', analogy: '类比：寄信时的正文', lesson: '第2课' }
  const second = first.ok ? attempt(() => upsertTermSource(SRC1, 'requestbody', REC2)) : { ok: false, error: NO_PRE }
  ok(second.ok, `② 已有记录时再新增**不抛**（末条补逗号那条路）${second.ok ? '' : '：' + second.error}`)
  const SRC2 = second.ok ? second.value : SRC1
  ok(second.ok && parseTermKeys(SRC2).join(',') === 'responsebody,requestbody',
    `② 键表 = [responsebody,requestbody]（顺序不变）${second.ok ? '' : NO_PRE}`)
  ok(second.ok && /lesson: '第1课'\n {4}\},\n {4}requestbody: \{/.test(SRC2),
    `② 上一条记录的 ` + '`}`' + ` 后真的补上了逗号（否则生成出来的 JS 语法错）${second.ok ? '' : NO_PRE}`)

  const readDir2 = tmpDir('read2')
  fs.mkdirSync(path.join(readDir2, 'assets'), { recursive: true })
  const readFile2 = path.join(readDir2, 'assets', 'glossary-data.js')
  fs.writeFileSync(readFile2, SRC2, 'utf8')
  const read2 = second.ok ? loadInSubprocess(readFile2, ['responsebody', 'requestbody']) : { ok: false, error: NO_PRE }
  ok(read2.ok, `② 两条记录的源码真能 require 回来${read2.ok ? '' : '：' + read2.error}`)
  ok(read2.ok && JSON.stringify(read2.value.rec.requestbody) === JSON.stringify(REC2)
    && JSON.stringify(read2.value.rec.responsebody) === JSON.stringify(REC1),
  `② 新旧两条都逐字正确、旧记录没被写坏${read2.ok ? '' : NO_PRE}`)

  /* ── ③ 更新已有术语：replace:true，code 里带 ```{``` / 引号 / 模板串 / `$&` ──── */
  const CODE = [
    'public class Demo {',
    '  String s = "引号\'与{花括号}";',
    '  String t = `模板串 ${1 + 2} 和 {大括号}`;',
    "  // $& $' $` 反向引用陷阱（用 String.replace 拼替换串就会写飞）",
    '}',
  ].join('\n')
  const REC1B = Object.assign({}, REC1, { short: '大白话：改过的一句话', code: CODE })
  const replaced = second.ok ? attempt(() => upsertTermSource(SRC2, 'responsebody', REC1B, { replace: true })) : { ok: false, error: NO_PRE }
  ok(replaced.ok, `③ replace 一条含花括号/引号/模板串的 code **不抛**${replaced.ok ? '' : '：' + replaced.error}`)
  const SRC3 = replaced.ok ? replaced.value : SRC2
  ok(replaced.ok && parseTermKeys(SRC3).join(',') === 'responsebody,requestbody',
    `③ replace 后键表不变（没多、没少、没串位）${replaced.ok ? '' : NO_PRE}`)
  ok(replaced.ok && SRC3.includes('// 在这里按分类顺序添加名词'),
    `③ replace 也不许动骨架注释${replaced.ok ? '' : NO_PRE}`)

  const readDir3 = tmpDir('read3')
  fs.mkdirSync(path.join(readDir3, 'assets'), { recursive: true })
  const readFile3 = path.join(readDir3, 'assets', 'glossary-data.js')
  fs.writeFileSync(readFile3, SRC3, 'utf8')
  const read3 = replaced.ok ? loadInSubprocess(readFile3, ['responsebody', 'requestbody']) : { ok: false, error: NO_PRE }
  ok(read3.ok, `③ 替换后的源码真能 require 回来${read3.ok ? '' : '：' + read3.error}`)
  ok(read3.ok && read3.value.rec.responsebody && read3.value.rec.responsebody.code === CODE,
    `③ code 逐字节往返（\`$&\` / 引号 / 模板串都没被当成转义序列写飞）${read3.ok ? '' : NO_PRE}`)
  ok(read3.ok && read3.value.rec.responsebody.short === '大白话：改过的一句话',
    `③ 被替换的字段真的换了${read3.ok ? '' : NO_PRE}`)
  ok(read3.ok && JSON.stringify(read3.value.rec.requestbody) === JSON.stringify(REC2),
    `③ 别的记录原样保留${read3.ok ? '' : NO_PRE}`)

  // 既有语义不许退化（只追加不覆盖 / replace 不存在的键）
  const dup = attempt(() => upsertTermSource(SRC3, 'responsebody', REC1, { replace: false }))
  ok(!dup.ok && /只追加不覆盖/.test(dup.error || ''), '③ 同键且没给 replace ⇒ 仍然拒绝（只追加不覆盖）')
  const noKey = attempt(() => upsertTermSource(SRC3, 'nope', REC1, { replace: true }))
  ok(!noKey.ok && /无法 replace/.test(noKey.error || ''), '③ replace 一个不存在的键 ⇒ 仍然抛错')

  /* ── ④ 损坏结构仍然拒写（不许静默写坏）─────────────────────────────────── */
  const noClose = first.ok ? SRC1.replace(/\n {2}\};\n\}\);\n*$/, '\n});\n') : ''
  const brokenClose = attempt(() => upsertTermSource(noClose, 'thirdterm', REC1))
  ok(first.ok && !brokenClose.ok && /找不到顶层映射收尾/.test(brokenClose.error || ''),
    `④ 骨架收尾被破坏（` + '`\\n  };`' + ` 不见了）⇒ 抛错拒写${first.ok ? '' : NO_PRE}`)
  const doubleComma = first.ok ? SRC1.replace(/\n {4}\}\n {2}\};/, '\n    },\n  };') : ''
  const brokenTail = attempt(() => upsertTermSource(doubleComma, 'thirdterm', REC1))
  ok(first.ok && !brokenTail.ok && /上一条记录末尾不是 `\}`/.test(brokenTail.error || ''),
    `④ 上一条记录末尾不是 ` + '`}`' + `（多余逗号）⇒ 抛错拒写${first.ok ? '' : NO_PRE}`)

  // 「0 个键」的另一面：台账里**有**记录、只是写歪了认不出 ⇒ 也不许当成空台账硬插。
  // 这里叠了一个更狠的形状：认不出的记录 **+ 末条之后还有一行注释**。
  // 那时 head 的末尾不是 `}`，不加逗号地插进去就是**语法错的源码**（`}` 后面直接跟新键）。
  const unrecognized = first.ok
    ? SRC1
      .replace(/^ {4}responsebody: \{/m, '  responsebody:{')
      .replace(/\n {2}\};/, '\n    // 末条之后还留了一句话\n  };')
    : ''
  const badIndent = attempt(() => upsertTermSource(unrecognized, 'thirdterm', REC1))
  ok(first.ok && !badIndent.ok && /插入点可疑/.test(badIndent.error || ''),
    `④ 台账里认不出任何记录、对象体里还有内容（写歪的键 + 末条后的注释）⇒ 拒写并点名，不会不加逗号硬插${first.ok ? '' : NO_PRE}`)

  // 落盘层：损坏的台账上写，必须拒绝且**文件一个字节都不动**
  for (const [tag, brokenSrc] of [['收尾破坏', noClose], ['末条坏', doubleComma]]) {
    const dir = tmpDir('broken-' + (tag === '收尾破坏' ? 'close' : 'tail'))
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    const abs = path.join(dir, 'assets', 'glossary-data.js')
    fs.writeFileSync(abs, brokenSrc, 'utf8')
    const before = sha(fs.readFileSync(abs))
    const w = attempt(() => writeTermSurgically({ root: dir, key: 'thirdterm', record: REC1 }))
    ok(!w.ok && /找不到顶层映射收尾|上一条记录末尾不是/.test(w.error || ''),
      `④ 落盘层：${tag}的台账写入被拒（不是静默写坏）${w.ok ? '（居然写成功了！）' : ''}`)
    ok(sha(fs.readFileSync(abs)) === before, `④ 落盘层：${tag}被拒后文件逐字节没变`)
  }

  // 确定性：同一输入产出逐字节相同（改判据不许引入不确定性）
  ok(first.ok && upsertTermSource(SKEL, 'responsebody', REC1) === SRC1, '④ 同样输入产出逐字节相同（确定性）')

  /* ── ⑤ 用首个术语当 hintTerm **真构建第一课** ───────────────────────────── */
  const HINT = 'responsebody'
  const made1 = attempt(() => authorLesson({
    halo: 'programming', point: 'spring-boot', number: 1,
    title: '第一课：跑起来', slug: 'boot-hello', hintTerm: HINT,
    source: { label: 'Spring 官方文档', url: 'https://docs.spring.io/spring-boot/' },
  }))
  ok(made1.ok, `⑤ authorLesson 生成第一课的源文件${made1.ok ? '' : '：' + made1.error}`)
  if (made1.ok) {
    const srcAbs = path.join(packRoot, ...made1.value.file.split('/'))
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true })
    fs.writeFileSync(srcAbs, made1.value.text, 'utf8')
    const skel = validateSkeleton(made1.value.text)
    ok(skel.ok, `⑤ 生成的源文件过 validateSkeleton（${made1.value.file}）${skel.ok ? '' : '：' + skel.problems.join('；')}`)

    // 负向对照：术语还没登记 ⇒ render 必须拒绝（证明这条判据是活的，套件不空转）
    const before = attempt(() => planBuild(packRoot, {}))
    ok(!before.ok && /未在 glossary-data.js 登记/.test(before.error || ''),
      `⑤ 负向对照：术语没登记时构建**必须**失败（${before.ok ? '居然建成功了 —— 判据失效' : (before.error || '').split('\n')[0]}）`)
  } else {
    ok(false, '⑤ 负向对照：源文件没生成，构建判据未成立' + NO_PRE)
  }

  // 把**首个术语**写进真建出来的新包
  const w1 = attempt(() => writeTermSurgically({ root: packRoot, key: HINT, record: REC1 }))
  ok(w1.ok && w1.value.ok === true,
    `⑤ 新包的第一个术语**真的写进去了**（旧实现在这里抛「插入点可疑」）${w1.ok ? '' : '：' + w1.error}`)
  ok(w1.ok && w1.value.ok === true && !w1.value.rolledBack,
    `⑤ 写后自检通过、没有回滚${w1.ok ? '' : NO_PRE}`)
  const ledgerNow = attempt(() => fs.readFileSync(PACK_LEDGER, 'utf8'))
  ok(ledgerNow.ok && parseTermKeys(ledgerNow.value).join(',') === HINT,
    `⑤ 新包台账里现在只有这一个键（${HINT}）${ledgerNow.ok ? '' : '：' + ledgerNow.error}`)
  ok(ledgerNow.ok && ledgerNow.value.includes('// 在这里按分类顺序添加名词'),
    '⑤ 新包台账的骨架注释还在（不许删注释换绿）')

  // 真子进程：hintTerm 查得到
  const readPack = loadInSubprocess(PACK_LEDGER, [HINT])
  ok(readPack.ok, `⑤ 新包台账**真能被 require**${readPack.ok ? '' : '：' + readPack.error}`)
  ok(readPack.ok && JSON.stringify(readPack.value.rec[HINT]) === JSON.stringify(REC1),
    `⑤ 用首个术语当 hintTerm：术语库里真的查得到这条${readPack.ok ? '' : NO_PRE}`)

  // 真构建链路：第一课必须建出来，且页面里出现术语 label
  const built = attempt(() => planBuild(packRoot, {}))
  ok(built.ok, `⑤ 构建第一课**不因缺术语失败**${built.ok ? '' : '：' + (built.error || '').split('\n')[0]}`)
  const files = built.ok ? built.value.files : []
  const html = files.find((f) => /lessons\/programming\/spring-boot\/0001-boot-hello\.html$/.test(f.path))
  ok(!!html, `⑤ 真的产出了第一课的课程页（实得：${files.map((f) => f.path).join('、') || '无'}）`)
  ok(!!html && html.content.includes(REC1.label),
    `⑤ 页面里出现了术语 label「${REC1.label}」（HINT_TERM_LABEL 槽位被真替换，不是留着占位符）`)
  ok(!!html && !/\{\{[A-Z_]+\}\}/.test(html.content),
    `⑤ 页面里没有未替换的 {{…}} 占位符${html ? '' : NO_PRE}`)
} finally {
  disposeAll()
}

// ⚠️ 这一行是 run-all.mjs 的解析契约（正则 `=== (\d+) 通过 / (\d+) 失败 ===`），别改格式
console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 新包第一个术语：出厂骨架（带注释）插得进、读得回、换得掉；坏结构仍然拒写；首个术语当 hintTerm 真构建得出第一课')
