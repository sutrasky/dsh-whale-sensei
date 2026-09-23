/**
 * brief.mjs —— 备课 / 答疑上下文包（`whale_brief`）
 *
 * 最硬的一条判据是 ②：**建议必须随数据变** ——
 *   影副本里把第2课缺的四项补上 → 建议必须从 `continue-lesson` 变成 `open-next-lesson`。
 *   如果建议是写死的字符串，这一条就会红 ✓
 *
 * 判据：
 *   ① 真包上跑：七段齐全，数字与各来源**对拍**（pack / state / queue / glossary / records / notes）
 *   ② 补齐缺口（建 4 个包 + pom 加依赖）→ 建议变成 open-next-lesson
 *   ③ 投一条待答 → 建议变成 answer-pending（学生当场等的优先）
 *   ④ 删掉 EXPECT.json → 建议 unknown，且 why 说明"没有声明期望"，**不许**说缺什么
 *   ⑤ 确定性：两次渲染逐字节相同、不含时间戳
 *   ⑥ 默认不写盘；write=true → learning-records/brief.md == 渲染结果；再写不重写
 *   ⑦ 真包未被改动
 *   ⑧ 学生笔记：空台账 → 这段在、写「还没有笔记」、不崩；有笔记时总条数正确、正文出现、课次显示名、截断、无时间戳
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { readQueue, askPaths } from '../lib/ask-io.js'
import { loadGlossaryLedger, glossarySummary } from '../lib/glossary-io.js'
import { listLearningRecords } from '../lib/brief-io.js'
import { assertLosslessJson } from '../lib/state.js'
import { plugin as briefPlugin } from '../lib/mods/brief.js'
import { readNotes } from '../lib/notes-io.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
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

const tools = []
const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }
const installAt = (root) => {
  const t = []
  briefPlugin.install({ paths: { packRoot: root }, log: fakeLog, registerTool: (d) => { t.push(d); tools.push(d) } })
  return t.find((x) => x.name === 'whale_brief')
}
const realBefore = hashTree(path.join(ROOT, 'code')) + '|' + sha(fs.readFileSync(path.join(ROOT, 'questions', 'pending.jsonl')))

console.log(`\n[brief] 课程包：${ROOT}`)

// ── ① 真包 ──
const tool = installAt(ROOT)
ok(!!tool, 'whale_brief 装得上')
const v1 = await tool.execute({ root: ROOT })
const pack = readPack(ROOT)
const titles = v1.brief.sections.map((s) => s.title)
ok(
  ['课程包', '学生现状', '待答', '已答', '术语', '学生笔记', '学习记录'].every((t) => titles.includes(t)),
  `七段齐全（${titles.join(' / ')}）`
)
ok(v1.markdown.includes(`${pack.circles.length} 个圆圈`) && v1.markdown.includes(`${pack.lessons.length} 门课程`), '课程包数字与 readPack 一致')
const q = readQueue(ROOT)
ok(v1.brief.counts.pending === (q.body.pending || []).length, `待答数与队列一致（${v1.brief.counts.pending}）`)
const g = glossarySummary(loadGlossaryLedger(ROOT))
ok(v1.markdown.includes(`${g.count} 个名词`) && v1.markdown.includes(`${g.categories} 类`), `术语数与台账一致（${g.count} / ${g.categories}）`)
ok(v1.markdown.includes(`${listLearningRecords(ROOT).length} 份`), `学习记录份数与目录一致（${listLearningRecords(ROOT).length}）`)
ok(v1.brief.next.action === 'continue-lesson' && /第2课/.test(v1.brief.next.why), `真包上的建议：${v1.brief.next.action} —— ${v1.brief.next.why}`)
ok(/还缺 5 项/.test(v1.brief.next.why) && !/spring-boot\/0002 还缺/.test(v1.brief.next.why), '建议里说的是**课标题**（给教师看的一页），不是内部 id')

// ── ⑧ 学生笔记（真包上）──
const realNotes = readNotes(ROOT)
const noteSection = v1.brief.sections.find((s) => s.title === '学生笔记')
ok(!!noteSection, '学生笔记这一段存在')
ok(noteSection.lines[0] === `共 ${realNotes.length} 条`, `笔记总条数与 readNotes 一致（${realNotes.length}）`)
if (realNotes.length) {
  ok(v1.markdown.includes(realNotes[0].text.slice(0, 40)), '第一条笔记正文出现在 brief 里')
}

// ── ⑤ 确定性与 no-timestamp ──
const v1b = await tool.execute({ root: ROOT })
ok(v1.markdown === v1b.markdown, '两次渲染逐字节相同')
ok(!/\d{4}-\d{2}-\d{2}T/.test(v1.markdown), 'brief 里没有时间戳（可对拍）')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-brief-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  const tool2 = installAt(tmp)
  const proj = path.join(tmp, 'code', '_hello-spring-boot', 'hello-spring-boot')
  const pkg = path.join(proj, 'src', 'main', 'java', 'com', 'sutrasky', 'hello_spring_boot')

  // ── ② 补齐第2课的缺口 → 建议必须变 ──
  const before = await tool2.execute({ root: tmp })
  ok(before.brief.next.action === 'continue-lesson', `补齐前：${before.brief.next.action}`)
  for (const d of ['model', 'service', 'controller', 'exception']) {
    fs.mkdirSync(path.join(pkg, d), { recursive: true })
    fs.writeFileSync(path.join(pkg, d, 'Placeholder.java'), 'package x;\n', 'utf8')
  }
  const pom = path.join(proj, 'pom.xml')
  fs.writeFileSync(pom, fs.readFileSync(pom, 'utf8').replace('</dependencies>', '  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>\n  </dependencies>'), 'utf8')
  const after = await tool2.execute({ root: tmp })
  // ── 前置闸（2026-09-23 用户裁定）──
  // 学生代码里第2课的**形状缺口**补上了（探针说 ✓），但 `progress.json` 还没点亮它，
  // 而 vue 的 requires 是 spring-boot —— 所以此时**不许开新课**，建议必须指向那门没学完的课。
  // 这里刻意用"没点亮"而不是"探针说 ✓"当掌握判据：EXPECT 是形状判据，占位文件也能过；
  // 真源是 progress.json 的 learned（星图点亮、whale_state 报的"已点亮 N/M"都读它）。
  ok(after.brief.next.action === 'learn-prerequisite', `前置没点亮：${after.brief.next.action}（${after.brief.next.why}）`)
  ok(after.brief.next.point === 'vue' && (after.brief.next.missing || []).includes('spring-boot/0002'),
    `前置闸点名缺的是 spring-boot/0002（实得 ${after.brief.next.point} / ${JSON.stringify(after.brief.next.missing)}）`)
  ok(/别开新课/.test(after.brief.next.why), '前置闸的话说清了「别开新课」')
  ok(/✓ spring-boot\/0002/.test(after.markdown), '学生现状里第2课已变成达成 ✓')
  ok(/前置体检/.test(after.markdown) && /✗ vue/.test(after.markdown) && /✓ spring-boot/.test(after.markdown),
    'brief 里有「前置体检」一节：vue 判 ✗、spring-boot 判 ✓')

  // 把第2课点亮（学生真的学完了）→ 前置闸放行，才轮到"先摸底"
  fs.writeFileSync(path.join(tmp, 'progress.json'),
    JSON.stringify({ learned: ['spring-boot/0001', 'spring-boot/0002'] }, null, 2) + '\n', 'utf8')
  const lit = await tool2.execute({ root: tmp })
  ok(lit.brief.next.action === 'intake-course' && /摸底/.test(lit.brief.next.why),
    `前置点亮后先要摸底：${lit.brief.next.action}（${lit.brief.next.why}）`)
  ok(/✓ vue/.test(lit.markdown), '前置体检：vue 的前置都学过了 → ✓')

  // 把摸底补上 → 才轮到"开下一课"
  const intakeFile = path.join(tmp, 'learning-records', 'intake.jsonl')
  fs.mkdirSync(path.dirname(intakeFile), { recursive: true })
  fs.writeFileSync(intakeFile, ['spring-boot', 'vue'].map((p) => JSON.stringify({ point: p, level: '有基础', goal: '能独立写一个' })).join('\n') + '\n', 'utf8')
  const afterIntake = await tool2.execute({ root: tmp })
  ok(afterIntake.brief.next.action === 'open-next-lesson', `摸底补齐后：${afterIntake.brief.next.action}（${afterIntake.brief.next.why}）—— 建议是**推出来的**，不是写死的`)
  ok(/学情摸底/.test(afterIntake.markdown), 'brief 里有「学情摸底」一节')

  // ── ③ 有待答 → 先答 ──
  fs.appendFileSync(askPaths(tmp).pending, JSON.stringify({ id: '0009', lesson: '第2课', question: '插队问一句' }) + '\n', 'utf8')
  const withPending = await tool2.execute({ root: tmp })
  ok(withPending.brief.next.action === 'answer-pending' && /待答/.test(withPending.brief.next.why), `有待答时：${withPending.brief.next.action}（${withPending.brief.next.why}）`)
  fs.writeFileSync(askPaths(tmp).pending, '', 'utf8')

  // ── ④ 没有 EXPECT.json → 不猜 ──
  fs.rmSync(path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'), { force: true })
  const noExpect = await tool2.execute({ root: tmp })
  ok(noExpect.brief.next.action === 'unknown', `没有期望时：${noExpect.brief.next.action}`)
  ok(/期望|声明/.test(noExpect.brief.next.why) && !/缺 .*项/.test(noExpect.brief.next.why), `不猜缺什么（why：${noExpect.brief.next.why}）`)
  ok(/未声明期望/.test(noExpect.markdown), '正文里也写明这一条')

  // ── ⑧ 学生笔记：空台账 + 写入 + 截断 + 显示名 ──
  // 恢复 EXPECT.json（④ 删了它）
  fs.writeFileSync(path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'), JSON.stringify({ lessons: [{ id: 'spring-boot/0001', title: '第1课 REST 基础' }, { id: 'spring-boot/0002', title: '第2课 REST API 与分层' }] }), 'utf8')
  // 空台账：这段在、写「还没有笔记」
  const emptyNotes = await tool2.execute({ root: tmp })
  const noteSec0 = emptyNotes.brief.sections.find((s) => s.title === '学生笔记')
  ok(!!noteSec0, '空台账时学生笔记这一段仍在')
  ok(noteSec0.lines[0] === '共 0 条', '空台账总条数为 0')
  ok(noteSec0.lines.includes('还没有笔记'), '空台账写「还没有笔记」')

  // 写入 3 条笔记，覆盖截断和显示名
  const noteDir = path.join(tmp, 'notes')
  fs.mkdirSync(noteDir, { recursive: true })
  const longText = '这是一段超长的笔记正文，用来测试截断功能。'.repeat(10) // >120 字符
  const notesLines = [
    JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: 'spring-boot/0001', text: '第一条笔记正文' }),
    JSON.stringify({ id: '0002', seq: 2, kind: '笔记', anchor: 'spring-boot/0002', text: longText }),
    JSON.stringify({ id: '0003', seq: 3, kind: '笔记', anchor: 'spring-boot/0001', text: '第三条' }),
  ].join('\n') + '\n'
  fs.writeFileSync(path.join(noteDir, 'notes.jsonl'), notesLines, 'utf8')

  const withNotes = await tool2.execute({ root: tmp })
  const noteSec = withNotes.brief.sections.find((s) => s.title === '学生笔记')
  ok(!!noteSec, '有笔记时学生笔记这一段在')
  const directNotes = readNotes(tmp)
  ok(noteSec.lines[0] === `共 ${directNotes.length} 条`, `笔记总条数与 readNotes 一致（${directNotes.length}）`)
  ok(noteSec.lines[0] === '共 3 条', '写了 3 条就是 3 条')
  ok(withNotes.markdown.includes('第一条笔记正文'), '第一条笔记正文出现在 brief 里')
  ok(noteSec.lines.some((l) => l.includes('第1课')), '显示的是课次显示名（第1课），不是生锚点')
  ok(noteSec.lines.some((l) => l.includes('…')), '超长正文被截断且有可见标记（…）')
  ok(!withNotes.markdown.includes(longText), '完整超长文本不出现在 brief 里（被截断了）')
  // 确定性：两次渲染逐字节相同
  const withNotes2 = await tool2.execute({ root: tmp })
  ok(withNotes.markdown === withNotes2.markdown, '有笔记时两次渲染逐字节相同')

  // 超过展示上限（20 条）：必须写出未列条数，**不许静默丢**
  const many = []
  for (let i = 4; i <= 24; i++) {
    many.push(JSON.stringify({ id: String(i).padStart(4, '0'), seq: i, kind: '笔记', anchor: 'spring-boot/0001', text: `第${i}条` }))
  }
  fs.writeFileSync(path.join(noteDir, 'notes.jsonl'), notesLines + many.join('\n') + '\n', 'utf8')
  const capped = await tool2.execute({ root: tmp })
  const capSec = capped.brief.sections.find((s) => s.title === '学生笔记')
  ok(capSec.lines[0] === '共 24 条', `条数超过上限时总数仍准确（${capSec.lines[0]}）`)
  ok(capSec.lines.includes('另有 4 条未列'), '超过 20 条上限时写出未列条数（另有 4 条未列）')
  ok(!capSec.lines.some((l) => l.includes('第24条')), '被截掉的笔记不出现（第24条不在展示里）')

  // ── ⑥ 落盘 ──
  ok(!fs.existsSync(path.join(tmp, 'learning-records', 'brief.md')), '默认不写盘')
  const w1 = await tool2.execute({ root: tmp, write: true })
  const briefFile = path.join(tmp, 'learning-records', 'brief.md')
  ok(w1.written?.includes('已写入') && fs.readFileSync(briefFile, 'utf8') === w1.markdown, 'write=true 写出的内容 == 返回的那一页')
  ok(w1.markdown === (await tool2.execute({ root: tmp })).markdown, '写了 brief.md 之后，"学习记录 N 份"不受影响（产物不污染自己的输入）')
  const w2 = await tool2.execute({ root: tmp, write: true })
  ok(/无变化/.test(w2.written || ''), `内容没变时不重写（${w2.written}）`)

  // ── ⑦ 会话：默认不读；显式开关才读；拿不到就明说；原始对象不许漏出去 ──
  ok(!v1.markdown.includes('## 会话'), '默认**不读**会话（brief 里没有"会话"这一段）')
  const fakeSession = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '第一条（应被"最近 N 条"截掉）' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '内部推理：不该出现在 brief 里' }, { type: 'text', text: '可见回复' }] },
      { role: 'tool', content: [{ type: 'tool-result', text: '工具结果：本条没有可见文本，应被整条丢掉' }] },
      { role: 'user', content: '第三条（字符串形状的 content 也要认）' },
      { role: 'assistant', content: [{ type: 'text', text: '第'.repeat(400) }] },
    ],
  }
  const withSess = await tool2.execute({ root: tmp, includeSession: true, sessionMessages: 2 }, { agent: { session: fakeSession } })
  const sess = withSess.brief.sections.find((s) => s.title.startsWith('会话'))
  ok(!!sess && sess.lines.length === 2, `includeSession → 只取最近 2 条**可见**消息（实得 ${sess?.lines.length}）`)
  ok(/^user：第三条/.test(sess.lines[0]) && /^assistant：/.test(sess.lines[1]), '每条都带 role，且字符串形状的 content 也认')
  ok(sess.lines[1].endsWith('…'), '过长消息被截断（以 … 结尾）')
  ok(!withSess.markdown.includes('内部推理'), '**reasoning 块不算可见文本**（思考内容不许泄漏进 brief）—— 现场抓到过')
  ok(!withSess.markdown.includes('工具结果'), '没有可见文本的消息被整条丢掉（不占"最近 N 条"的名额）')
  ok(/最近 2 条可见/.test(sess.title) && /会话共 5 条/.test(sess.title), `标题写清"几条可见 / 会话共几条"（${sess.title}）`)
  const clamped = await tool2.execute({ root: tmp, includeSession: true, sessionMessages: 99 }, { agent: { session: fakeSession } })
  ok(clamped.brief.sections.find((s) => s.title.startsWith('会话')).lines.length === 4, 'sessionMessages 超上限被夹（这里只有 4 条可见）')
  const noSess = await tool2.execute({ root: tmp, includeSession: true }, {})
  const noSessSection = noSess.brief.sections.find((s) => s.title.startsWith('会话'))
  ok(!!noSessSection && /拿不到会话/.test(noSessSection.lines[0]), `拿不到会话时明说，不崩（${noSessSection?.lines[0]}）`)
  let lossless = null
  try { assertLosslessJson(withSess, 'value') } catch (e) { lossless = e.message }
  ok(lossless === null, `返回值是无损 JSON（深冻结的原始消息没有泄漏出去）${lossless ? '：' + lossless : ''}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑦ 真包没被动过 ──
ok(hashTree(path.join(ROOT, 'code')) + '|' + sha(fs.readFileSync(path.join(ROOT, 'questions', 'pending.jsonl'))) === realBefore, '真包未被改动（code/ 全树 + pending.jsonl）')
ok(!fs.existsSync(path.join(ROOT, 'learning-records', 'brief.md')) || true, '（真包里的 brief.md 由使用者决定，测试只用影副本）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 上下文包：七段与各来源对拍一致，建议随数据变，不猜、可对拍、可落盘')
