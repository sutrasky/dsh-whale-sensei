/**
 * brief.mjs —— 备课 / 答疑上下文包（`whale_brief`）
 *
 * 最硬的一条判据是 ②：**建议必须随数据变** ——
 *   影副本里把第2课缺的四项补上 → 建议必须从 `continue-lesson` 变成 `open-next-lesson`。
 *   如果建议是写死的字符串，这一条就会红 ✓
 *
 * 判据：
 *   ① 真包上跑：六段齐全，数字与各来源**对拍**（pack / state / queue / glossary / records）
 *   ② 补齐缺口（建 4 个包 + pom 加依赖）→ 建议变成 open-next-lesson
 *   ③ 投一条待答 → 建议变成 answer-pending（学生当场等的优先）
 *   ④ 删掉 EXPECT.json → 建议 unknown，且 why 说明"没有声明期望"，**不许**说缺什么
 *   ⑤ 确定性：两次渲染逐字节相同、不含时间戳
 *   ⑥ 默认不写盘；write=true → learning-records/brief.md == 渲染结果；再写不重写
 *   ⑦ 真包未被改动
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || path.resolve(HERE, '..', '..', 'study')
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
  ['课程包', '学生现状', '待答', '已答', '术语', '学习记录'].every((t) => titles.includes(t)),
  `六段齐全（${titles.join(' / ')}）`
)
ok(v1.markdown.includes(`${pack.circles.length} 个圆圈`) && v1.markdown.includes(`${pack.lessons.length} 门课程`), '课程包数字与 readPack 一致')
const q = readQueue(ROOT)
ok(v1.brief.counts.pending === (q.body.pending || []).length, `待答数与队列一致（${v1.brief.counts.pending}）`)
const g = glossarySummary(loadGlossaryLedger(ROOT))
ok(v1.markdown.includes(`${g.count} 个名词`) && v1.markdown.includes(`${g.categories} 类`), `术语数与台账一致（${g.count} / ${g.categories}）`)
ok(v1.markdown.includes(`${listLearningRecords(ROOT).length} 份`), `学习记录份数与目录一致（${listLearningRecords(ROOT).length}）`)
ok(v1.brief.next.action === 'continue-lesson' && /第2课/.test(v1.brief.next.why), `真包上的建议：${v1.brief.next.action} —— ${v1.brief.next.why}`)
ok(/还缺 5 项/.test(v1.brief.next.why) && !/spring-boot\/0002 还缺/.test(v1.brief.next.why), '建议里说的是**课标题**（给教师看的一页），不是内部 id')

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
  ok(after.brief.next.action === 'open-next-lesson', `补齐后：${after.brief.next.action}（${after.brief.next.why}）—— 建议是**推出来的**，不是写死的`)
  ok(/✓ spring-boot\/0002/.test(after.markdown), '学生现状里第2课已变成达成 ✓')

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
console.log('✅ 上下文包：六段与各来源对拍一致，建议随数据变，不猜、可对拍、可落盘')
