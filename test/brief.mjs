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
 *   ⑨ ② 终点契约 / ③(a) 课后调整 / ③(c) 学习记录读内容（影副本：空态、验收 k/n 随数据变、截断、时间戳剥离、上限不静默丢）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { remainingLessons } from '../lib/pack-model.js'
import { readQueue, askPaths } from '../lib/ask-io.js'
import { loadGlossaryLedger, glossarySummary } from '../lib/glossary-io.js'
import { listLearningRecords } from '../lib/brief-io.js'
import { recordGoal } from '../lib/goal-io.js'
import { recordTeaching, GLOBAL_CIRCLE } from '../lib/teaching-io.js'
import { assertLosslessJson } from '../lib/state.js'
import { plugin as briefPlugin } from '../lib/mods/brief.js'
import { NEXT_ACTIONS } from '../lib/brief.js'
import { readNotes } from '../lib/notes-io.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
/** 两段文本的首处差异（诊断用：只说"不一样"等于没说） */
const firstDiff = (a, b) => {
	const A = String(a).split('\n'); const B = String(b).split('\n')
	for (let i = 0; i < Math.max(A.length, B.length); i++) {
		if (A[i] !== B[i]) return `第 ${i + 1} 行：${JSON.stringify(A[i] ?? '(缺)')} ≠ ${JSON.stringify(B[i] ?? '(缺)')}`
	}
	return `（行数相同但整体不同：${A.length} 行）`
}
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
// ⚠️ 这两条**不许把数字/动作写死**（2026-09-24 实测）：真包是学生**正在用**的包，
//    "还缺 5 项"这种快照会在学生做题的当天就过期。这里只验**结构**与**措辞**。
ok(NEXT_ACTIONS.includes(v1.brief.next.action) && !!v1.brief.next.why, `真包上的建议：${v1.brief.next.action} —— ${v1.brief.next.why}`)
ok(/第\d+课/.test(v1.brief.next.why) && !/\/\d{4}\b/.test(v1.brief.next.why), '建议里说的是**课标题**（给教师看的一页），不是内部 id')

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

  // ⚠️ 2026-09-24 D1：实践区改成「按圈声明」后，`code/programming/vue/`（原先只有 EXPECT.json、
  //    立不成项目）**也被认成项目** ⇒ vue 第1课成了"没做完的课"。而 decideNext 的优先级是
  //    **先补没做完的课、最后才谈开新课**（`lib/brief.js:24`）—— 它会把本文件后面要验的
  //    「前置闸 / 摸底 / 开下一课」三条分支**全挡住**。所以夹具先把 vue 第1课做满，
  //    让这三条分支真正可达；vue 第1课的判据就是这三个文件（`code/programming/vue/EXPECT.json`）。
  const vueDir = path.join(tmp, 'code', 'programming', 'vue')
  fs.mkdirSync(vueDir, { recursive: true })
  fs.writeFileSync(path.join(vueDir, 'index.html'), '<div id="app"></div>\n', 'utf8')
  fs.writeFileSync(path.join(vueDir, 'app.js'), 'createApp({})\n', 'utf8')
  fs.writeFileSync(path.join(vueDir, 'api.js'), 'export const get = () => {}\n', 'utf8')

  // ⚠️ 同理（2026-09-24 D2-b）：高数第1课（`alge/0001`）补了判据 ⇒ 它那三个产物不存在时
  //    也算"没做完的课"，照样会把编程侧的分支挡掉。本文件验的是**编程侧**的前置闸，
  //    所以把数学那边也做满（它的判据就是三个 .md）。
  const mathDir = path.join(tmp, 'math', 'alge')
  fs.mkdirSync(mathDir, { recursive: true })
  for (const n of ['0001-分解.md', '0001-极限.md', '0001-重写.md']) {
    fs.writeFileSync(path.join(mathDir, n), '# 占位（本测试不验数学内容）\n', 'utf8')
  }

  // ── ② 补齐第2课的缺口 → 建议必须变 ──
  // ⚠️ 夹具先把第2课的**两个端点挑战挖掉**：`before` 的前提是"第2课还有缺口"，
  //    而真包里学生已经把 TaskController 写完了（2026-09-24 G 条修好端点解析后，那两道端点挑战
  //    从"假阴"变成真的达成 ⇒ 不挖掉就没有缺口可补，`continue-lesson` 这条分支永远走不到）。
  //    前提必须由夹具自己造出来，不能靠"学生今天做到哪"（本文件上面 vue / math 两段同理）。
  fs.writeFileSync(
    path.join(pkg, 'controller', 'TaskController.java'),
    'package x;\n// 夹具：先把第2课的端点挑战挖掉（见上）\npublic class TaskController {\n}\n',
    'utf8'
  )
  const before = await tool2.execute({ root: tmp })
  ok(before.brief.next.action === 'continue-lesson', `补齐前：${before.brief.next.action}`)
  for (const d of ['model', 'service', 'controller', 'exception']) {
    fs.mkdirSync(path.join(pkg, d), { recursive: true })
    fs.writeFileSync(path.join(pkg, d, 'Placeholder.java'), 'package x;\n', 'utf8')
  }
  const pom = path.join(proj, 'pom.xml')
  fs.writeFileSync(pom, fs.readFileSync(pom, 'utf8').replace('</dependencies>', '  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>\n  </dependencies>'), 'utf8')
  // ⚠️ 2026-09-24：`decideNext` 的真源改成**挑战级**（与开新课的门禁同源）—— 只补 required 形状
  //    不够了：第2课的挑战还要 Task + @NotNull（挑战1）与那两个端点（挑战2/3）。
  //    不补的话 `gaps` 不为空，`continue-lesson` 会一直压在前面，前置闸那条分支根本走不到。
  fs.writeFileSync(
    path.join(pkg, 'model', 'Task.java'),
    'package x;\nimport jakarta.validation.constraints.NotNull;\npublic class Task {\n  @NotNull private String title;\n}\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(pkg, 'controller', 'TaskController.java'),
    'package x;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class TaskController {\n'
      + '  @GetMapping("/api/tasks")\n  public String list() { return "[]"; }\n'
      + '  @PatchMapping("/api/tasks/{id}/complete")\n  public String complete(@PathVariable String id) { return id; }\n}\n',
    'utf8'
  )
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
  // ⚠️ 摸底要覆盖**影副本里所有的知识点**，别写死 spring-boot / vue ——
  // 影副本是真包拷来的，真包多一个知识点（2026-09-24 加了 math/alge）而它没摸底时，
  // decideNext 会正确地建议 intake-course，那这条"补完摸底 → 该开下一课了"就静默失配了
  // （失败信息看着像功能坏了，其实是测试把数据写死了）。
  const allPoints = []
  ;(function walkPoints(d) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walkPoints(full); continue }
      if (e.name !== 'point.json') continue
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'))
        if (j && j.point) allPoints.push(String(j.point))
      } catch (e) { /* 读不动就当没有这个知识点 */ }
    }
  })(path.join(tmp, 'lessons'))
  fs.writeFileSync(intakeFile, allPoints.map((p) => JSON.stringify({ point: p, level: '有基础', goal: '能独立写一个' })).join('\n') + '\n', 'utf8')
  const afterIntake = await tool2.execute({ root: tmp })
  ok(afterIntake.brief.next.action === 'open-next-lesson', `摸底补齐后：${afterIntake.brief.next.action}（${afterIntake.brief.next.why}）—— 建议是**推出来的**，不是写死的`)
  ok(/学情摸底/.test(afterIntake.markdown), 'brief 里有「学情摸底」一节')

  // ── ③ 有待答 → 先答 ──
  fs.appendFileSync(askPaths(tmp).pending, JSON.stringify({ id: '0009', lesson: '第2课', question: '插队问一句' }) + '\n', 'utf8')
  const withPending = await tool2.execute({ root: tmp })
  ok(withPending.brief.next.action === 'answer-pending' && /待答/.test(withPending.brief.next.why), `有待答时：${withPending.brief.next.action}（${withPending.brief.next.why}）`)
  fs.writeFileSync(askPaths(tmp).pending, '', 'utf8')

  // ── ④ 没有 EXPECT.json → 不猜 ──
  // D1/D2-b 起 vue 与 math 也是项目、也有 EXPECT.json —— "没有期望"这个前提要求**三份都移走**
  const vueExpect = path.join(tmp, 'code', 'programming', 'vue', 'EXPECT.json')
  const vueExpectBody = fs.readFileSync(vueExpect, 'utf8')
  const mathExpect = path.join(tmp, 'math', 'alge', 'EXPECT.json')
  const mathExpectBody = fs.readFileSync(mathExpect, 'utf8')
  fs.rmSync(path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'), { force: true })
  fs.rmSync(vueExpect, { force: true })
  fs.rmSync(mathExpect, { force: true })
  const noExpect = await tool2.execute({ root: tmp })
  ok(noExpect.brief.next.action === 'unknown', `没有期望时：${noExpect.brief.next.action}`)
  ok(/期望|声明/.test(noExpect.brief.next.why) && !/缺 .*项/.test(noExpect.brief.next.why), `不猜缺什么（why：${noExpect.brief.next.why}）`)
  ok(/未声明期望/.test(noExpect.markdown), '正文里也写明这一条')

  // ── ⑧ 学生笔记：空台账 + 写入 + 截断 + 显示名 ──
  // 恢复 EXPECT.json（④ 删了它）
  fs.writeFileSync(path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'), JSON.stringify({ lessons: [{ id: 'spring-boot/0001', title: '第1课 REST 基础' }, { id: 'spring-boot/0002', title: '第2课 REST API 与分层' }] }), 'utf8')
  // vue 那份也按原样放回去（④ 一并移走了）
  fs.writeFileSync(vueExpect, vueExpectBody, 'utf8')
  // math 那份同理
  fs.writeFileSync(mathExpect, mathExpectBody, 'utf8')
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

  // ── ⑨ ② 终点契约 + ③(a) 课后调整 + ③(c) 学习记录读内容（影副本）──
  const lrDir = path.join(tmp, 'learning-records')
  // ④ 删过 EXPECT.json、⑧ 只放回了简版（没有 required）→ 这里放回**原件**，
  // 好验「why 尾注带终点摘要」（尾注按 §3.2 只挂在 open-next-lesson 那条 why 上）
  fs.copyFileSync(path.join(ROOT, 'code', '_hello-spring-boot', 'EXPECT.json'), path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'))
  fs.rmSync(path.join(lrDir, 'goals.jsonl'), { force: true })
  fs.rmSync(path.join(lrDir, 'adjustments.jsonl'), { force: true })

  // ② 空态：没有 goals.jsonl → 「终点还没结构化」；③(a) 空态：文件不存在 = 正常空态（不是错误）
  const noGoal1 = await tool2.execute({ root: tmp })
  const noGoal2 = await tool2.execute({ root: tmp })
  const goalSec0 = noGoal1.brief.sections.find((s) => s.title === '终点契约')
  ok(!!goalSec0 && /终点还没结构化/.test(goalSec0.lines.join('\n')), '没有 goals.jsonl → 终点契约段写「终点还没结构化」')
  const adjSec0 = noGoal1.brief.sections.find((s) => s.title === '课后调整')
  ok(!!adjSec0 && adjSec0.lines.includes('还没有课后调整'), '没有 adjustments.jsonl → 「还没有课后调整」（空态不是错误、不崩）')
  ok(noGoal1.markdown === noGoal2.markdown, '空态两次渲染逐字节相同')

  // ② 有终点：验收 k/n 随数据变（表单形态 auto:false → 升级成 checks 形态 → k 增加）
  const g1 = recordGoal(tmp, {
    pointId: 'programming/spring-boot',
    tier: 3,
    artifact: { what: '一个能独立跑的 REST 待办服务', where: 'code/_hello-spring-boot' },
    acceptance: [
      { no: 1, deliverable: '能列出待办', auto: false, hint: '机器判不了（表单形态）' },
      { no: 2, deliverable: '能讲清分层', auto: false, hint: '机器判不了（表单形态）' },
    ],
    source: 'wizard',
  })
  ok(g1.ok === true, '影副本里落第 1 版终点（recordGoal）')
  const goalBrief1 = await tool2.execute({ root: tmp })
  const goalSec1 = goalBrief1.brief.sections.find((s) => s.title === '终点契约')
  ok(/spring-boot：终点 tier 3/.test(goalSec1.lines.join('\n')), `终点契约段带档位（${goalSec1.lines[0]}）`)
  ok(/一个能独立跑的 REST 待办服务（code\/_hello-spring-boot）/.test(goalSec1.lines.join('\n')), '作品一句话 + 作品放哪进了段落')
  ok(/验收 0\/0（另有 2 项需老师确认）/.test(goalSec1.lines.join('\n')), '表单形态：验收 0/0 + 2 项需老师确认')
  const g2 = recordGoal(tmp, {
    pointId: 'programming/spring-boot',
    tier: 3,
    artifact: { what: '一个能独立跑的 REST 待办服务', where: 'code/_hello-spring-boot' },
    acceptance: [
      { no: 1, deliverable: '有构建文件', checks: [{ id: 'c1', kind: 'file', value: 'pom.xml' }] },
      { no: 2, deliverable: '有那个不存在的文件', checks: [{ id: 'c2', kind: 'file', value: 'NoSuchFile.java' }] },
    ],
    source: 'agent',
  })
  ok(g2.ok === true && g2.record.v === 2 && g2.record.replaces === 1, '换终点 = 第 2 版 append（replaces=1）')
  const goalBrief2 = await tool2.execute({ root: tmp })
  const goalSec2 = goalBrief2.brief.sections.find((s) => s.title === '终点契约')
  ok(/验收 1\/2/.test(goalSec2.lines.join('\n')), `补上 checks → k 随数据变（${goalSec2.lines[0]}）`)
  ok(/→ 缺：第2题（产出：有那个不存在的文件）/.test(goalSec2.lines.join('\n')), '缺哪题点名（产出原文）')
  ok(/v2，接替 v1/.test(goalSec2.lines.join('\n')), '换终点留痕显示在段落里（v2，接替 v1）')
  ok(/终点已定：spring-boot tier 3（验收 1\/2）/.test(goalBrief2.markdown), 'decideNext 的 why 尾注带终点摘要')

  // ③(a) 有记录：正文出现、ts 不出现在 markdown、lit:false 带「✗ 未点亮」、gaps 跟在后面
  const adjFile = path.join(lrDir, 'adjustments.jsonl')
  fs.writeFileSync(adjFile, [
    JSON.stringify({ ts: '2026-09-24T10:00:00.000Z', lesson: 'spring-boot/0001', title: '第1课', adjust: '节奏太快，希望每节多一个例子', lit: true, gaps: [] }),
    JSON.stringify({ ts: '2026-09-24T11:00:00.000Z', lesson: 'spring-boot/0002', title: '第2课', adjust: '分层没讲透', lit: false, gaps: ['第3题：分层（缺：要有 service 目录）'] }),
    JSON.stringify({ ts: '2026-09-24T12:00:00.000Z', lesson: 'spring-boot/0003', title: '第3课', adjust: '老行形态没有 lit/gaps', }),
  ].join('\n') + '\n', 'utf8')
  const withAdj = await tool2.execute({ root: tmp })
  const adjSec = withAdj.brief.sections.find((s) => s.title === '课后调整')
  ok(adjSec.lines.some((l) => l.includes('spring-boot/0001') && l.includes('节奏太快，希望每节多一个例子')), '课后调整正文出现在 brief')
  ok(adjSec.lines.some((l) => /✗ 未点亮：/.test(l) && l.includes('分层没讲透') && l.includes('缺：要有 service 目录')), 'lit:false →「✗ 未点亮」前缀 + gaps 跟在后面')
  ok(adjSec.lines.some((l) => l.includes('spring-boot/0003') && !/✗ 未点亮/.test(l)), '老行（无 lit/gaps）读侧容错：不打 ✗、不崩')
  ok(!/\d{4}-\d{2}-\d{2}T/.test(withAdj.markdown), 'ts 与 ISO 时间戳样式都不出现在 markdown')

  // ③(a) 20 条 → 只列最近 10 条 + 「另有 10 条未列」（不静默丢）
  fs.writeFileSync(adjFile, Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ ts: `t${i}`, lesson: `spring-boot/${String(i + 1).padStart(4, '0')}`, adjust: `第${i + 1}号调整`, lit: true, gaps: [] }),
  ).join('\n') + '\n', 'utf8')
  const adjCap = (await tool2.execute({ root: tmp })).brief.sections.find((s) => s.title === '课后调整')
  ok(adjCap.lines.includes('另有 10 条未列'), '20 条 → 「另有 10 条未列」')
  ok(adjCap.lines.some((l) => l.includes('第20号调整')) && !adjCap.lines.some((l) => l.includes('第5号调整')), '只列最近 10 条（第20号在、第5号不在）')

  // ③(a) 坏行（非 JSON）→ 报 problems 不崩
  fs.appendFileSync(adjFile, '这不是合法的JSON{{{]\n', 'utf8')
  const adjBad = (await tool2.execute({ root: tmp })).brief.sections.find((s) => s.title === '课后调整')
  ok(adjBad.lines.some((l) => /^⚠️ 第 \d+ 行解析失败/.test(l)), `坏行进 ⚠️ 提示不崩（${adjBad.lines[adjBad.lines.length - 1]}）`)

  // ③(c) 学习记录读内容：正文出现 / 截断有 … / 完整超长文本不出现 / 时间戳剥成 […] / 超 3 份显式报
  const longRec = '这是一段超长的学习记录正文，用来验证每份 200 字的截断上限。'.repeat(12)
  fs.writeFileSync(path.join(lrDir, 'zz-1.md'), '# 记录\n\n第一份新记录的正文内容\n', 'utf8')
  fs.writeFileSync(path.join(lrDir, 'zz-2.md'), '2026-09-24T10:00 动手时间：今天把 X 做完了\n', 'utf8')
  fs.writeFileSync(path.join(lrDir, 'zz-3.md'), longRec + '\n', 'utf8')
  const withRec = await tool2.execute({ root: tmp })
  const recSec = withRec.brief.sections.find((s) => s.title === '学习记录')
  ok(recSec.lines.some((l) => l.includes('zz-1.md') && l.includes('第一份新记录的正文内容')), '记录正文出现在 brief（不再只列文件名）')
  ok(recSec.lines.some((l) => l.includes('zz-2.md') && l.includes('[…]') && l.includes('动手时间')), 'ISO 时间戳样式剥成 […]，正文还在')
  ok(recSec.lines.some((l) => l.includes('zz-3.md') && l.includes('…')), '超长记录被截断且有可见标记（…）')
  ok(!withRec.markdown.includes(longRec), '完整超长文本不出现在 brief 里（被截断了）')
  ok(!/\d{4}-\d{2}-\d{2}T/.test(withRec.markdown), '含 ISO 时间戳的记录也不红（无时间戳硬断言保住）')
  const totalRec = listLearningRecords(tmp).length
  ok(recSec.lines[0].startsWith(`${totalRec} 份，最新：zz-3.md`), `份数口径不变（${recSec.lines[0]}）`)
  ok(recSec.lines.includes(`另有 ${totalRec - 3} 份未列`), `超过 3 份显式报未列（另有 ${totalRec - 3} 份未列）`)
  const withRec2 = await tool2.execute({ root: tmp })
  ok(withRec.markdown === withRec2.markdown, '有记录/调整/终点时两次渲染逐字节相同')

  // ── ⑩ ③ 决策接线：卡点优先 / 档位差，且**可关**（P0-2 ④）──
  //    这一节的判据是「建议真的随学生数据变」+「关掉开关就与今天逐字节相同」两条一起钉。
  {
    // 基线：此刻 tmp 里没有 gaps、终点也没有 from ⇒ 一个字都不该加（空态不编）
    const classic = (await tool2.execute({ root: tmp })).brief
    ok(classic.next.action === 'open-next-lesson', `⑩ 基线建议：${classic.next.action}`)
    ok(!/卡在|档位差|差 \d+ 档/.test(classic.next.why), `⑩ 没有卡点/档位数据 ⇒ why 里一个字都不加（${classic.next.why}）`)

    // ① 卡点优先：课后调整里写了"卡在哪" → why 必须出现那段
    const FOCUS = '第3题：分层（缺：要有 service 目录）'
    fs.writeFileSync(adjFile, [
      JSON.stringify({ ts: 't1', lesson: 'spring-boot/0001', title: '第1课', adjust: '还好', lit: true, gaps: [] }),
      JSON.stringify({ ts: 't2', lesson: 'spring-boot/0002', title: '第2课', adjust: '分层没讲透', lit: false, gaps: [FOCUS] }),
    ].join('\n') + '\n', 'utf8')
    const withFocus = (await tool2.execute({ root: tmp })).brief
    ok(withFocus.next.action === 'open-next-lesson', '⑩ 卡点**不改分支**（动作还是 open-next-lesson，只改 why）')
    ok(withFocus.next.why.includes(FOCUS) && /课后调整写着卡在/.test(withFocus.next.why),
      `⑩ 假数据写明卡点 ⇒ why 出现该卡点（${withFocus.next.why.slice(-70)}）`)
    ok(withFocus.next.why.includes('spring-boot/0002'), '⑩ 卡点带上**是哪一课的**（不然不知道该补哪一段）')

    // ② 可关：同一份数据，advice:false → why 与"没有卡点数据"时**逐字节相同**
    const offFocus = (await tool2.execute({ root: tmp, advice: false })).brief
    ok(offFocus.next.why === classic.next.why, '⑩ 关开关（advice:false）⇒ why 与没有卡点数据时**逐字节相同**（退回今天的行为）')

    // ③ 档位差：终点契约的 tier 与起点台阶 from.tier 比 → 差几档 + 地图还差几课
    const g3 = recordGoal(tmp, {
      pointId: 'programming/spring-boot',
      tier: 3,
      artifact: { what: '一个能独立跑的 REST 待办服务', where: 'code/_hello-spring-boot' },
      acceptance: [{ no: 1, deliverable: '有构建文件', checks: [{ id: 'c1', kind: 'file', value: 'pom.xml' }] }],
      from: { tier: 1, artifact: { what: '起点：能跑起一个 Hello', where: 'code/_hello-spring-boot' }, acceptance: [], focus: [] },
      source: 'agent',
    })
    ok(g3.ok === true, `⑩ 影副本里落带起点台阶的终点（from.tier=1）${g3.ok ? '' : ' —— ' + g3.error}`)
    const withTier = (await tool2.execute({ root: tmp })).brief
    ok(/起点 tier 1 → 终点 tier 3（差 2 档）/.test(withTier.next.why), `⑩ 档位差算得出来（${(withTier.next.why.match(/起点 tier[^；]*/) || [''])[0]}）`)
    const rem = remainingLessons(readPack(tmp), 'programming', 'spring-boot')
    if (rem === null) {
      ok(!/还要 \d+ 节课/.test(withTier.next.why), '⑩ 地图拿不到"还差几课" ⇒ **不说**那句（不编一个 N）')
    } else {
      ok(new RegExp(`地图上还差 ${rem} 课 —— 到这儿大概还要 ${rem} 节课`).test(withTier.next.why),
        `⑩ "还要几节课"取地图前沿的真数（还差 ${rem} 课，与 remainingLessons 同源）`)
    }
    ok(/课后调整写着卡在/.test(withTier.next.why), '⑩ 两条尾注能**同时**在（卡点 + 档位差）')

    const offTier = (await tool2.execute({ root: tmp, advice: false })).brief
    // ⚠️ 不能拿前面那个 `classic` 当基线 —— 中间又落了一版终点，`goalNote`（验收 1/2 → 1/1）本来就变了。
    // 精确判据：**关掉开关的输出 == 开着的输出把两条新尾注剥掉**（逐字节）。
    const stripNewTails = (s) => String(s)
      .replace(/；上一课（[^）]*）的课后调整写着卡在：[^；]* —— 下一课优先补这一段/, '')
      .replace(/；起点 tier \d+ → 终点 tier \d+（差 \d+ 档）(；地图上还差 \d+ 课 —— 到这儿大概还要 \d+ 节课)?/, '')
    ok(offTier.next.why === stripNewTails(withTier.next.why),
      `⑩ 关开关 ⇒ 恰好等于"开着但剥掉两条新尾注"（逐字节）：${offTier.next.why}`)
    ok(!/卡在|差 \d+ 档/.test(offTier.next.why), '⑩ 关开关后 why 里没有新尾注的任何痕迹')
    const twice = (await tool2.execute({ root: tmp })).brief
    ok(twice.markdown === withTier.markdown, '⑩ 有新数据时两次渲染仍逐字节相同（确定性没破）')
  }

  // ── ⑪ ③ 教学方式段（teaching.jsonl，丁3）──
  //    「每次开课先读的那一页」上要能一眼看到"现在按什么方式教" —— 参数是学生提的要求，
  //    渲染在这儿他才看得见"到底生效了没有"。
  {
    const beforeRes = await tool2.execute({ root: tmp })
    const sec0 = beforeRes.brief.sections.find((s) => s.title === '教学方式')
    ok(!!sec0 && sec0.lines.some((l) => /还没有教学参数/.test(l)), '⑪ 空态：没有 teaching.jsonl → 这一段在、写「还没有教学参数」、不崩')
    ok(sec0.lines.some((l) => /锁死/.test(l)), '⑪ 空态也明示锁死集（学生知道哪些不能改）')

    // 2026-09-25 主人裁定后：台账**按圆圈分节** —— 全局层（学科中立）与每个圆圈各说各的
    const sp = recordTeaching(tmp, {
      circle: 'programming', kind: 'spec',
      spec: [{ id: 'commentDensity', label: '注释密度', values: [{ id: 'line', directive: '逐行加注释。' }, { id: 'block', directive: '按块加注释。' }], defaultByTier: { 1: 'line', 2: 'line', 3: 'block', 4: 'block' } }],
      source: 'agent',
    })
    ok(sp.ok === true, `⑪ 影副本里给 programming 声明 spec（v${sp.record?.v}）`)
    const t1 = recordTeaching(tmp, {
      circle: 'programming', kind: 'values', tier: 2,
      params: { commentDensity: 'block' },
      freeText: [{ text: '别先给定义，先给例子', confirmed: true }],
      source: 'student',
    })
    ok(t1.ok === true, `⑪ 影副本里落一版**圆圈**教学参数（v${t1.record?.v}）`)
    const t2 = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 2, params: { explainOrder: 'detail-first' }, source: 'student' })
    ok(t2.ok === true, '⑪ 全局层也落一版（学科中立的参数）')
    const withRes = await tool2.execute({ root: tmp })
    const withT = withRes.brief
    const sec1 = withT.sections.find((s) => s.title === '教学方式')
    ok(/^全局（学科中立）tier 2：/.test(sec1.lines[0]) && /讲解顺序 detail-first＊/.test(sec1.lines[0]),
      `⑪ 头一行是**全局层**（学科中立），改过的打 ＊（${sec1.lines[0]}）`)
    ok(sec1.lines.some((l) => /^· programming：/.test(l) && /注释密度 block＊/.test(l)),
      '⑪ 每个圆圈**自己一行**（该圆圈的特化与取值）')
    ok(sec1.lines.some((l) => /术语 on(?!＊)/.test(l)), '⑪ 没改过的项不打 ＊（是档位默认）')
    ok(sec1.lines.some((l) => /自由补充/.test(l) && l.includes('别先给定义')), '⑪ 自由补充也念出来')
    ok(sec1.lines.length <= 6, `⑪ 这一段不超过 6 行（实得 ${sec1.lines.length} 行）${sec1.lines.length > 6 ? ' —— ' + sec1.lines.map((l) => l.slice(0, 40)).join(' ｜ ') : ''}`)
    ok(withRes.markdown !== beforeRes.markdown, `⑪ 改了参数 → brief **真变**（建议随学生数据变，不是写死的）${withRes.markdown === beforeRes.markdown ? ' —— 两边一样，首处差：' + firstDiff(beforeRes.markdown, withRes.markdown) : ''}`)
    const twiceRes = await tool2.execute({ root: tmp })
    ok(twiceRes.markdown === withRes.markdown, `⑪ 有教学参数时两次渲染逐字节相同（确定性没破）${twiceRes.markdown !== withRes.markdown ? ' —— 首处差：' + firstDiff(withRes.markdown, twiceRes.markdown) : ''}`)
    ok(!/\d{4}-\d{2}-\d{2}T/.test(withRes.markdown), '⑪ 教学参数段里没有时间戳（台账本身也不写）')
  }

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
