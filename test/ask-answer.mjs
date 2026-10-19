/**
 * ask-answer.mjs —— 解答写回台账（`whale_ask action=answer` / POST /api/whale/answer）验收
 *
 * 为什么用**全影副本**：answer 之后要真跑课程包的 `tools/drain-questions.js` 与
 * `tools/build-notes.js`（零依赖无参幂等），只有整套课程包在身上才跑得起来。
 *
 * 判据：
 *   ① 合法 answer → 台账多一个键，11 个字段齐，旧键一个不少，条数正好 +1
 *   ② 幂等：同 id 再答 → 409，台账**逐字节不变**
 *   ③ 坏样本三连（找不到的 id 且没给 question / 空 answer / 缺 answerHtml）→ 4xx，
 *      且台账 + pending + processed 三份哈希**全不变**
 *   ④ 插入是外科手术：原文除"新增那一段"之外逐字节不变（前缀相同 + 尾部锚点原样）
 *   ⑤ 坏台账（require 不过）→ 500，且文件**一字未动**（不写坏东西）
 *   ⑥ rebuild：drain 把这条从 pending 归档进 processed，build-notes 退出码 0，
 *      重建出来的 NOTES.html 里**真的出现**了这次写的答案
 *   ⑦ 路由形状：/api/whale/answer 在 /api 前缀下、只收 POST
 *   ⑧ 真包全程未被改动
 *
 * ⑦ **回滚分支**（写入成功但自检不过 → 写回原文）现在**真的被覆盖**了：
 *    自检那段被抽成 `verifyOrRollback({ …, load })`，`load` 是注入的 ⇒
 *    测试传一个"读回来少了键"或"抛错"的 load，就能把回滚走一遍（依赖注入，不是测试钩子）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { handleAnswer, ledgerPath, loadLedger, verifyOrRollback } from '../lib/ask-io.js'
import { LEDGER_ANCHOR, insertLedgerEntry, serializeLedgerEntry } from '../lib/ask.js'
import { plugin as askPlugin } from '../lib/mods/ask.js'
import { packRoot } from './_pack.mjs'
import { lessonIndex, keyOfAnchor } from '../lib/pack-model.js'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
const hashOf = (p) => { try { return sha(fs.readFileSync(p)) } catch { return 'missing' } }
const CLOCK = () => '2026-01-02T03:04:05.000Z'

/**
 * 课次解析器：用**包自己那份** `lessonIndex`（不是测试桩）—— 影子包是从真包整树拷的，
 * 真实课次表就在里面。`handleAnswer` 现在**必须**注入它：判不了课次对位就不许写。
 */
const resolverFor = (root) => (x) => {
  const idx = lessonIndex(root)
  const key = keyOfAnchor(x, idx)
  if (!key) throw new Error(`课次对不上：${JSON.stringify(x)} 在课次映射表里解析不到（现有：${Object.values(idx.byKey).map((e) => e.label).join(' / ')}）`)
  return { key, label: idx.byKey[key].label }
}
/**
 * 调一次 `handleAnswer`。
 *
 * ⚠️ T04-R2 裁定甲：本套件的影副本是**真包的拷贝**（引擎是旧的那份），而且 ⑤ 节还**故意**
 * 删掉 `tools/build-notes.js` 来验"脚本跑挂了"那条失败路径 —— 与 T04 的引擎闸互斥
 * （闸要求闭包完整且与受信清单逐字节一致）。所以夹具调用点**显式旁白路**：
 * `trustedEngine:false`（缺省是 true/严；生产调用点不传）。**断言一字不动。**
 */
const answer = (root, opts) => handleAnswer(root, { resolveLesson: resolverFor(root), trustedEngine: false, ...opts })

const realLedger = path.join(ROOT, 'assets', 'questions-data.js')
const realBefore = hashOf(realLedger) + '|' + hashOf(path.join(ROOT, 'questions', 'pending.jsonl')) + '|' + hashOf(path.join(ROOT, 'questions', 'processed.jsonl'))

console.log(`\n[answer] 课程包：${ROOT}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-answer-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const L = ledgerPath(tmp)
  const PENDING = path.join(tmp, 'questions', 'pending.jsonl')
  const PROCESSED = path.join(tmp, 'questions', 'processed.jsonl')
  const NOTES = path.join(tmp, 'reference', 'NOTES.html')

  const before = loadLedger(tmp)
  const beforeKeys = Object.keys(before)
  const srcBefore = fs.readFileSync(L, 'utf8')

  // 造一条待答疑问（学号 0004）
  const MARK = 'ASK-ANSWER-MARK-0004'
  fs.appendFileSync(PENDING, JSON.stringify({
    id: '0004', at: '2026-01-01T00:00:00.000Z', lesson: '第2课', page: 'lessons/programming/spring-boot/0002-rest-api-crud.html',
    title: '第二课', question: '为什么 @RequestBody 要配合 @Valid 才生效？', status: 'pending',
  }) + '\n', 'utf8')
  const pendingLines = () => fs.readFileSync(PENDING, 'utf8').split('\n').filter((l) => l.trim()).length
  const processedLines = () => fs.readFileSync(PROCESSED, 'utf8').split('\n').filter((l) => l.trim()).length
  const pLines0 = pendingLines()
  const dLines0 = processedLines()

  const BODY = { id: '0004', date: '2026-01-02', answer: '一句话：@Valid 负责触发校验，@RequestBody 只负责把 JSON 读成对象。', answerHtml: `<p><strong>${MARK}</strong>：<code>@Valid</code> 触发校验。</p>` }

  // ── ① 合法写回（先关重建，单独验写台账）──
  const r1 = await answer(tmp, { raw: JSON.stringify(BODY), now: CLOCK, rebuild: false })
  ok(
    r1.status === 200 && r1.body.ok === true && r1.body.id === '0004',
    `合法 answer → ${r1.status} ${r1.body.ok ? `{ ok:true, id:"${r1.body.id}" }（自检：${r1.body.selfCheck}）` : `{ ok:false, error:"${r1.body.error}" }`}`
  )
  const after = loadLedger(tmp)
  const afterKeys = Object.keys(after)
  ok(afterKeys.length === beforeKeys.length + 1 && afterKeys.every((k, i) => i < beforeKeys.length ? k === beforeKeys[i] : k === '0004'), `台账多一个键且旧键顺序未变（${beforeKeys.length} → ${afterKeys.length}）`)
  const e = after['0004']
  const FIELDS = ['id', 'date', 'lesson', 'question', 'status', 'page', 'anchor', 'section', 'answer', 'terms', 'answerHtml']
  ok(FIELDS.every((f) => f in e), `11 个字段齐（${Object.keys(e).join(',')}）`)
  ok(e.id === '0004' && e.status === 'answered' && e.anchor === 'q0004' && e.page === 'reference/NOTES.html' && e.date === '2026-01-02', `关键字段对（status=answered / anchor=q0004 / page=NOTES / date=${e.date}）`)
  ok(e.question === '为什么 @RequestBody 要配合 @Valid 才生效？', 'question 用的是队列里的**学生原话**（不是调用方现编的）')
  ok(Array.isArray(e.terms) && e.terms.length === 0, 'terms 是空数组（需要时再补）')

  // ── ④ 外科手术：除"新增块 + 一个逗号"外逐字节不变 ──
  const srcAfter = fs.readFileSync(L, 'utf8')
  const anchor = '\n  };\n});'
  const expectedBlock = serializeLedgerEntry({
    id: '0004', date: '2026-01-02', lesson: '第2课',
    question: '为什么 @RequestBody 要配合 @Valid 才生效？',
    page: 'reference/NOTES.html', anchor: 'q0004', section: '第2课 答疑',
    answer: BODY.answer, answerHtml: BODY.answerHtml,
  })
  ok(srcAfter.includes(expectedBlock), '新增块与纯函数给出的应当形态**逐字相同**')
  ok(srcAfter.replace(expectedBlock, '') === srcBefore.replace(anchor, `,\n${anchor}`), '除新增块与补上的那一个逗号外，原文逐字节不变')

  // ── ② 幂等 ──
  const frozenLedger = hashOf(L)
  const r2 = await answer(tmp, { raw: JSON.stringify({ ...BODY, answer: '改一版' }), now: CLOCK, rebuild: false })
  ok(r2.status === 409 && /已经有/.test(r2.body.error), `同 id 再答 → ${r2.status} ${r2.body.error}`)
  ok(hashOf(L) === frozenLedger, '被拒之后台账**逐字节不变**')

  // ── ③ 坏样本三连 ──
  const frozen = hashOf(L) + '|' + hashOf(PENDING) + '|' + hashOf(PROCESSED)
  const BADS = [
    ['找不到的 id 且没给 question', { id: '0099', answer: 'x', answerHtml: '<p>x</p>' }, 400, /找不到/],
    ['空 answer', { id: '0005', answer: '   ', answerHtml: '<p>x</p>' }, 400, /解答内容为空/],
    ['缺 answerHtml', { id: '0005', answer: '有正文但没 HTML' }, 400, /answerHtml/],
    ['id 不是四位', { id: '5', answer: 'x', answerHtml: '<p>x</p>' }, 400, /四位编号/],
  ]
  for (const [name, body, want, re] of BADS) {
    const r = await answer(tmp, { raw: JSON.stringify(body), now: CLOCK, rebuild: false })
    ok(r.status === want && re.test(r.body.error || ''), `坏样本「${name}」→ ${r.status} ${r.body.error}`)
  }
  ok(hashOf(L) + '|' + hashOf(PENDING) + '|' + hashOf(PROCESSED) === frozen, '四条坏样本之后：台账 + pending + processed 三份哈希**全不变**')

  // ── ⑤ 坏台账（require 不过）→ 500 且一字未动 ──
  const broken = srcAfter.replace(/^\(function/m, '(((( function')
  fs.writeFileSync(L, broken, 'utf8')
  const hBroken = hashOf(L)
  const r3 = await answer(tmp, { raw: JSON.stringify({ id: '0006', answer: 'x', answerHtml: '<p>x</p>', question: 'q' }), now: CLOCK, rebuild: false })
  ok(r3.status === 500, `坏台账 → ${r3.status}（${String(r3.body.error).slice(0, 40)}…）`)
  ok(hashOf(L) === hBroken, '坏台账上一个字都没写进去')
  fs.writeFileSync(L, srcAfter, 'utf8')
  ok(typeof loadLedger(tmp)['0004'] === 'object', '恢复台账后 require 正常（脚本收尾自检）')

  // ── ⑦ 回滚分支：注入 load 把"写成功但自检不过"真的走一遍 ──
  const srcNow = fs.readFileSync(L, 'utf8')
  const beforeNow = loadLedger(tmp)
  const poisoned = () => ({ ...beforeNow }) // 少了新键 → 自检应当不过
  const rolled = verifyOrRollback({ root: tmp, abs: L, src: srcNow, before: beforeNow, key: '0099', load: poisoned })
  ok(rolled.ok === false && /新增 无/.test(rolled.note), `自检不过 → 如实报失败（${rolled.note}）`)
  ok(fs.readFileSync(L, 'utf8') === srcNow, '**原文被完整写回**（回滚真的执行了，不是只报个错）')
  const throwing = () => { throw new Error('模拟 require 失败') }
  const rolled2 = verifyOrRollback({ root: tmp, abs: L, src: srcNow, before: beforeNow, key: '0099', load: throwing })
  ok(
    rolled2.ok === false && /require 失败/.test(rolled2.note) && fs.readFileSync(L, 'utf8') === srcNow,
    'load 抛错时也回滚（require 失败那条分支）'
  )

  // ── ⑥ rebuild：真跑 drain + build-notes + build-lessons ──
  const notesBefore = hashOf(NOTES)
  const r4 = await answer(tmp, { raw: JSON.stringify({ id: '0005', answer: '第二条解答正文', answerHtml: `<p>${MARK}-5</p>`, question: '占位（队列里找不到时应拒，这里补上 question）' }), now: CLOCK, rebuild: true })
  ok(r4.status === 200, `rebuild 路径 → ${r4.status}`)
  ok((r4.body.steps || []).every((s) => s.code === 0), `三步脚本都退出码 0（${(r4.body.steps || []).map((s) => s.script + '=' + s.code).join(' · ')}）`)
  // 回归钉（2026-09-21 实测的真缺陷）：重建链原来只跑 drain + build-notes，
  // 而课程页里嵌了「DSH 笔记」卡片的答疑计数 → 写完答案课程页就陈旧、
  // 课程包闸门 `build-lessons --check` 当场红。这一步少了 build-lessons 就是旧病复发。
  ok(
    (r4.body.steps || []).map((s) => s.script).join('、') ===
      'tools/drain-questions.js、tools/build-notes.js、tools/build-lessons.js',
    `重建链三步齐全、顺序固定（${(r4.body.steps || []).map((s) => s.script).join(' · ')}）`
  )
  // drain 的语义是"**台账里登记过的**一律归档" —— 所以先前那条 0004（已登记）这时也会被归档，
  // pending 1→0、processed 3→4。这不是副作用，正是它该做的 ✓（第一次我按"只归档新的那条"写，写错了）
  ok(
    pendingLines() === pLines0 - 1 && processedLines() === dLines0 + 1,
    `drain 归档：pending ${pLines0}→${pendingLines()}（已登记的 0004 被归档）· processed ${dLines0}→${processedLines()}`
  )
  ok(hashOf(NOTES) !== notesBefore, 'NOTES.html 被重建（哈希变了）')
  const notes = fs.readFileSync(NOTES, 'utf8')
  ok(notes.includes(MARK), '重建出来的 NOTES.html 里**真的出现**了这次写的答案')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑥b 重建失败：写成功不许被说成失败，失败也不许被吞掉 ──
// 造一个"build-notes 跑不起来"的影子包（脚本删掉）。answer 仍必须 200 + ok:true ——
// 台账**真的**写成了，回非 2xx 会诱导调用方重试、把同一条答案写两遍 ✗；
// 但 rebuild.ok 必须为 false、warnings 必须点名，且工具层不许再说"产物已重建"。
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-answer-fail-'))
  try {
    fs.cpSync(ROOT, tmp2, { recursive: true })
    fs.rmSync(path.join(tmp2, 'tools', 'build-notes.js'), { force: true })
    const r5 = await answer(tmp2, {
      raw: JSON.stringify({ id: '0006', answer: '正文', answerHtml: '<p>fail-path</p>', question: '占位' }),
      now: CLOCK,
      rebuild: true,
    })
    ok(r5.status === 200 && r5.body.ok === true, `重建脚本挂掉时仍回 200 ok:true（台账确实写成了；回 5xx 会诱导重试 → 写两遍）`)
    ok(r5.body.rebuild && r5.body.rebuild.ok === false, `重建失败被结构化报出（rebuild.ok=${r5.body.rebuild?.ok}）`)
    ok((r5.body.rebuild?.failed || []).includes('tools/build-notes.js'), `失败项点名到脚本（${(r5.body.rebuild?.failed || []).join('、') || '无'}）`)
    ok(
      (r5.body.warnings || []).some((w) => /build-notes/.test(w) && /产物可能/.test(w)),
      `warnings 里点名"产物可能是旧的"（${(r5.body.warnings || [])[0] || '无'}）`
    )
    ok(loadLedger(tmp2)['0006'] !== undefined, '台账里那条答案仍在（写没丢）')
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true })
  }
}

// ── ⑥c 课次对位：写偏一个字必须**拒写**，不许静默挂到一个不存在的课上（P1-11）──
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-answer-lesson-'))
  try {
    fs.cpSync(ROOT, tmp3, { recursive: true })
    const L3 = ledgerPath(tmp3)
    const P3 = path.join(tmp3, 'questions', 'pending.jsonl')
    const h0 = hashOf(L3) + '|' + hashOf(P3)
    const bodyOf = (id, lesson) => JSON.stringify({ id, answer: '正文', answerHtml: '<p>x</p>', question: '占位', lesson })

    // ① 课次写偏一个字 → 400，且台账与队列**一字未动**
    const bad = await answer(tmp3, { raw: bodyOf('0007', '第2课x'), now: CLOCK, rebuild: false })
    ok(
      bad.status === 400 && /课次对不上/.test(bad.body.error || ''),
      `课次写偏一个字 → ${bad.status} 拒写（${bad.body.error || ''}）`
    )
    ok(hashOf(L3) + '|' + hashOf(P3) === h0, '拒写时台账与队列**一字未动**')

    // ② 给星图课次键（point/NNNN）→ 归一成显示名落盘（两种写法收敛成一种，别在台账里留两种写法）
    const keyed = await answer(tmp3, { raw: bodyOf('0007', 'spring-boot/0002'), now: CLOCK, rebuild: false })
    ok(
      keyed.status === 200 && loadLedger(tmp3)['0007']?.lesson === '第2课',
      `给 point/NNNN → 落盘归一成显示名（${loadLedger(tmp3)['0007']?.lesson}）`
    )

    // ③ 没注入解析器 + 非空 lesson → 拒写（不许"判不了就放过去"）
    const noRes = await handleAnswer(tmp3, { raw: bodyOf('0008', '第2课'), now: CLOCK, rebuild: false })
    ok(
      noRes.status === 500 && /没注入课次解析器/.test(noRes.body.error || ''),
      `没注入课次解析器 → ${noRes.status} 拒写（${noRes.body.error || ''}）`
    )
  } finally {
    fs.rmSync(tmp3, { recursive: true, force: true })
  }
}

// ── ⑥d 反空转：收尾锚点被改坏必须**抛错点名**，还原必须回绿（对齐课程包 tools/check-terms.test.mjs）──
// 只写"锚点恰好一处就能写"是**正向**断言：守卫被删掉时它照样绿。这里补的是**反向**那一半 ——
// 三种变异（改一字 / 删掉 / 复制成两处）都必须失败且点名"收尾锚点 + 次数"，且全程只动 mkdtemp 拷贝。
{
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-answer-anchor-'))
  try {
    fs.cpSync(ROOT, tmp4, { recursive: true })
    const L4 = ledgerPath(tmp4)
    const src4 = fs.readFileSync(L4, 'utf8')
    const hReal = hashOf(realLedger)
    const write = (key) => insertLedgerEntry(fs.readFileSync(L4, 'utf8'), key, serializeLedgerEntry({
      id: key, date: '2026-01-02', lesson: '演示', question: '原话', answer: '解答', answerHtml: '<p>x</p>',
    }))
    const threwMsg = (mut) => {
      fs.writeFileSync(L4, mut(src4), 'utf8')          // 变异写进拷贝，真包不动
      try { write('0010'); return '' } catch (e) { return e.message }
    }
    const m1 = threwMsg((s) => s.replace(LEDGER_ANCHOR, LEDGER_ANCHOR.replace('};', '},')))
    ok(/台账结构不认识/.test(m1) && /收尾锚点出现 0 次/.test(m1), `反空转：锚点改一个字 → 抛错点名（${m1 || '没抛 = 判据空转 ✗'}）`)
    const m2 = threwMsg((s) => s.split(LEDGER_ANCHOR).join(''))
    ok(/收尾锚点出现 0 次/.test(m2), `反空转：锚点删掉（0 处）→ 抛错点名（${m2 || '没抛 = 判据空转 ✗'}）`)
    const m3 = threwMsg((s) => s + LEDGER_ANCHOR)
    ok(/收尾锚点出现 2 次/.test(m3), `反空转：锚点变两处（2 处）→ 抛错点名（${m3 || '没抛 = 判据空转 ✗'}）`)
    fs.writeFileSync(L4, src4, 'utf8')
    const out = write('0010')
    ok(out.includes(`'0010': {`) && out.split(LEDGER_ANCHOR).length - 1 === 1, '反空转：还原后回绿（插入成功，锚点仍恰好一处）')
    ok(fs.readFileSync(L4, 'utf8') === src4 && hashOf(realLedger) === hReal, '真包台账一字未动（变异只发生在 mkdtemp 拷贝上）')
  } finally {
    fs.rmSync(tmp4, { recursive: true, force: true })
  }
}

// ── ⑦ 路由形状 ──
const captured = []
askPlugin.install({
  paths: { packRoot: ROOT },
  log: { info: () => {}, warn: () => {}, error: () => {} },
  registerTool: () => {},
  inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => captured.push(r) } }) }),
})
const paths = captured.map((r) => r.path)
ok(paths.includes('/api/whale/answer'), `answer 路由已挂（${paths.join('、')}）`)
const ans = captured.find((r) => r.path === '/api/whale/answer')
ok(ans.methods.join(',') === 'POST' && ans.requestBody === 'buffered', `answer 只收 POST 且 requestBody=buffered（${ans.methods.join(',')}）`)
ok(captured.every((r) => r.path.startsWith('/api/')), '两条路由都在 /api 前缀下（栅栏与认证由基座继承）')

// ── ⑧ 真包没被动过 ──
const realAfter = hashOf(realLedger) + '|' + hashOf(path.join(ROOT, 'questions', 'pending.jsonl')) + '|' + hashOf(path.join(ROOT, 'questions', 'processed.jsonl'))
ok(realAfter === realBefore, '真包全程未被改动（台账 + pending + processed 哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 解答写回：台账外科手术式追加、幂等、坏样本一动不动、drain+build-notes 真的跑通')
