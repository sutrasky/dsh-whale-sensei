/**
 * state-probe.mjs —— 学生状态探针（`whale_state`）验收
 *
 * 最硬的一条判据在 ②：探针的结论必须跟**人工写的** `learning-records/0004` 对上
 *   —— "第1课已达成且超出要求 / 第2课一处都未开始"。
 * 判据是外部锚，不是我自己拍的。
 *
 * 其余：
 *   ① 事实抽得对（构建方式 / 端点 / 注解 / 配置 / 锁文件与 target 不算学生代码）
 *   ③ 坏样本：删掉控制器 → 第1课必须变成未达成，且点名缺什么
 *   ④ 没有 EXPECT.json → 不猜期望（明说"未声明期望"）
 *   ⑤ 未知 kind → 抛错（不静默忽略）
 *   ⑥ 无时间戳、两次扫描逐字相同（state 可对拍）
 *   ⑦ 默认不写盘；write 出来的是确定性产物；真工作区一字未动
 *   ⑧ codeDir 不存在 → 0 个项目且不炸
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPack } from '../lib/pack.js'
import { probeState, writeState, scanWorkspace } from '../lib/state-scan.js'
import { validateExpect, computeGaps, assertLosslessJson } from '../lib/state.js'
import { summarizeState } from '../lib/state.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
function hashTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out.push(r + ':' + sha(fs.readFileSync(path.join(dir, e.name))))
    }
  }
  walk(root, '')
  return out.join('|')
}

const STUB_PACK = { circles: 1, points: 2, lessons: 2, learned: 1 }
const realBefore = hashTree(path.join(ROOT, 'code'))
const stateRelAbs = path.join(ROOT, 'learning-records', 'state.json')
const hadState = fs.existsSync(stateRelAbs)
const stateBodyBefore = hadState ? fs.readFileSync(stateRelAbs, 'utf8') : ''

console.log(`\n[state] 课程包：${ROOT}`)
const pack = readPack(ROOT)
const { state } = probeState(ROOT, pack)
const P = state.projects[0]

// ── ⓪ state 必须**无损 JSON**（宿主会拒收非 JSON 值）──
//    这条是现场抓出来的：扫描时挂的 `_contents`（Map）被摊进 state，宿主回
//    "value is not lossless JSON"，而我的判据用的是 JSON.stringify —— 它把 Map 悄悄变成 {}，
//    于是**判据全绿、工具在线上炸** ✗。以后不许拿 JSON.stringify 当"能序列化"的判据。
let lossless = null
try { assertLosslessJson(state) } catch (e) { lossless = e.message }
ok(lossless === null, `state 是无损 JSON（${lossless || '通过'}）`)
ok(!('_contents' in state.projects[0]), '扫描时的中间产物（_contents）没有漏进 state')
let guardWorks = null
try { assertLosslessJson({ a: new Map() }) } catch (e) { guardWorks = e.message }
ok(!!guardWorks, `无损自检本身能变红（${guardWorks || '对 Map 没报错 ✗'}）`)

// ── ① 事实抽得对 ──
ok(state.projects.length === 1, `扫到 1 个学生项目（实得 ${state.projects.length}）`)
ok(P?.facts.build === 'maven', `构建方式识别为 maven（实得 ${P?.facts.build}）`)
ok(P?.facts.endpoints.length === 3, `端点数 3（实得 ${P?.facts.endpoints.length}：${(P?.facts.endpoints || []).map((e) => e.method + ' ' + e.path).join('、')}）`)
ok(P?.facts.annotations.includes('RestController') && P?.facts.annotations.includes('GetMapping'), `注解含 @RestController 与 @GetMapping（现有 ${(P?.facts.annotations || []).map((a) => '@' + a).join(' ')}）`)
ok(P?.facts.configKeys.includes('server.port'), `配置键含 server.port（现有 ${(P?.facts.configKeys || []).join('、')}）`)
ok(P?.facts.pomArtifacts.includes('spring-boot-starter-webmvc'), 'pom 依赖里认出 spring-boot-starter-webmvc')
ok(!P?.facts.files.some((f) => /(^|\/)(target|\.mvn)(\/|$)/.test(f)), 'target/ 与 .mvn/ 没被当成学生文件')
ok(!P?.facts.files.some((f) => /\.LCK|~$/.test(f)), '编辑器锁文件没被算进事实')
// ⚠️ 这两条是实际输出暴露的漏判：主源/测试数被数成 0，pack 计数打成了 [object Object]
ok(P?.facts.java.main.length === 2 && P?.facts.java.test.length === 1, `主源 2 / 测试 1（实得 ${P?.facts.java.main.length}/${P?.facts.java.test.length}）`)
ok(typeof state.pack.learned === 'number' && typeof state.pack.lessons === 'number', `pack 计数是数字（learned=${typeof state.pack.learned}、lessons=${typeof state.pack.lessons}）`)
ok(state.pack.lessons === 3 && state.pack.learned === 1, `pack 计数正确：3 门课 / 点亮 1（实得 ${state.pack.lessons}/${state.pack.learned}）`)
ok(!JSON.stringify(summarizeState(state)).includes('[object Object]'), '摘要里没有 [object Object]（渲染出来的每一行都是给人看的）')

// ── ② 与人工记录对齐（外部锚）──
const l1 = P?.lessons.find((l) => l.id === 'spring-boot/0001')
const l2 = P?.lessons.find((l) => l.id === 'spring-boot/0002')
ok(l1?.done === true && l1.missing.length === 0, `第1课判定为**已达成**（缺 ${l1?.missing.length ?? '?'} 项）—— 与 learning-records/0004 一致`)
ok(l2?.done === false && l2.missing.length === l2.satisfied.length + l2.missing.length, `第2课判定为**未开始**（满足 ${l2?.satisfied.length} / 缺 ${l2?.missing.length}）—— 与 learning-records/0004 一致`)
ok(l2?.missing.some((m) => m.id === 'validation') && l2.missing.some((m) => m.id === 'service-pkg'), '第2课缺的项点名到具体条目（含 validation、service 包）')

// ── ⑥ 无时间戳 + 确定性 ──
const json1 = JSON.stringify(probeState(ROOT, pack).state)
const json2 = JSON.stringify(probeState(ROOT, pack).state)
ok(json1 === json2, '两次扫描结果逐字相同（state 可对拍）')
ok(!/\d{4}-\d{2}-\d{2}T/.test(json1), 'state 里没有时间戳（否则没法对拍）')

// ── 影子副本：坏样本 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-state-'))
try {
  fs.cpSync(path.join(ROOT, 'code'), path.join(tmp, 'code'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'learning-records'), { recursive: true })

  const projDir = path.join(tmp, 'code', P.facts.dir)
  const ctrl = path.join(projDir, 'src', 'main', 'java', 'com', 'sutrasky', 'hello_spring_boot', 'HelloController.java')

  // ③ 删掉控制器 → 第1课必须变红
  fs.rmSync(ctrl, { force: true })
  const broken = probeState(tmp, STUB_PACK).state.projects[0]
  const b1 = broken.lessons.find((l) => l.id === 'spring-boot/0001')
  ok(b1.done === false, '坏样本（删掉控制器）→ 第1课判定为未达成')
  ok(b1.missing.some((m) => m.id === 'rest-controller') && b1.missing.some((m) => m.id === 'hello-endpoint'), `坏样本点名缺什么（${b1.missing.map((m) => m.id).join('、')}）`)
  ok(b1.missing.find((m) => m.id === 'rest-controller').evidence.includes('没有 @RestController'), '缺口带证据："没有 @RestController"')

  // 锁文件必须被排除（自造一个，别靠"刚好没文件"空转）
  fs.writeFileSync(path.join(projDir, 'src', 'main', 'java', 'com', '.LCKHelloController.java~'), 'lock', 'utf8')
  const withJunk = probeState(tmp, STUB_PACK).state.projects[0]
  ok(!withJunk.facts.files.some((f) => f.includes('.LCK')), '自造的 .LCK…~ 锁文件被排除（不是空转）')

  // ④ 没有 EXPECT.json → 不猜期望
  fs.rmSync(path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'), { force: true })
  const noExpect = probeState(tmp, STUB_PACK).state
  ok(noExpect.projects[0].expect === null && noExpect.projects[0].lessons.length === 0, '没有 EXPECT.json 时不产出任何"缺什么"结论')
  ok(noExpect.notes.some((n) => n.includes('未声明期望')), '并且明说"未声明期望"（不静默降级）')

  // ⑦ 写盘：默认不写；write 出来的产物确定
  ok(!fs.existsSync(path.join(tmp, 'learning-records', 'state.json')), '默认（未开 write）不产生 state.json')
  const w1 = writeState(tmp, probeState(tmp, STUB_PACK).state)
  ok(w1.changed === true && fs.existsSync(path.join(tmp, 'learning-records', 'state.json')), 'write 时写出 learning-records/state.json')
  const body1 = fs.readFileSync(path.join(tmp, 'learning-records', 'state.json'), 'utf8')
  const w2 = writeState(tmp, probeState(tmp, STUB_PACK).state)
  ok(w2.changed === false && fs.readFileSync(path.join(tmp, 'learning-records', 'state.json'), 'utf8') === body1, '同样的工作区再写一次：内容逐字节相同且不重写')

  // ⑧ 挑战级完成度：**随数据变**（先恢复期望文件，再补一个带 @NotNull 的 Task 类）
  const realExpect = path.join(ROOT, 'code', '_hello-spring-boot', 'EXPECT.json')
  fs.copyFileSync(realExpect, path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'))
  const beforeCh = probeState(tmp, STUB_PACK).state.projects[0].lessons.find((l) => l.id === 'spring-boot/0002')
  ok(beforeCh.challengeSummary.achieved === 0, `补之前：第2课挑战达成 ${beforeCh.challengeSummary.achieved} / 共 ${beforeCh.challengeSummary.total}`)
  const taskDir = path.join(tmp, 'code', P.facts.dir, 'src', 'main', 'java', 'com', 'sutrasky', 'hello_spring_boot', 'model')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'Task.java'), 'package x;\nimport jakarta.validation.constraints.NotNull;\npublic class Task {\n  @NotNull private String title;\n}\n', 'utf8')
  const afterCh = probeState(tmp, STUB_PACK).state.projects[0].lessons.find((l) => l.id === 'spring-boot/0002')
  ok(afterCh.challengeSummary.achieved === 1, `补上 Task + @NotNull 之后：达成 ${afterCh.challengeSummary.achieved}（**随数据变**）`)
  ok(afterCh.challenges[0].done === true && afterCh.challenges[1].done === false, '第1题变达成、第2题仍未达成（逐题判，不是整课一刀切）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑤ 未知 kind 必须抛错 ──
let threw = null
try {
  validateExpect({ lessons: [{ id: 'x', required: [{ id: 'a', kind: '魔法', value: 'v' }] }] })
} catch (e) { threw = e.message }
ok(!!threw && threw.includes('不认识'), `未知 kind 被挡下（${threw || '没有抛错 ✗'}）`)
let threw2 = null
try {
  validateExpect({ lessons: [{ id: 'x', required: [{ id: 'a', kind: 'annotation', value: '' }] }] })
} catch (e) { threw2 = e.message }
ok(!!threw2, '期望项缺 value 被挡下')

// ── ⑨ 挑战级判据的坏样本（结构校验一律抛错，不静默当达成）──
// 注意：每条样本都要带**合法的 deliverable** —— 否则会先因为"缺产出"抛错，判据就通过得莫名其妙 ✗
const D = '一句话产出'
const badDoc = (challenges, what) => {
  let e = null
  try {
    validateExpect({ lessons: [{ id: 'x', required: [{ id: 'a', kind: 'annotation', value: 'A' }], challenges }] })
  } catch (err) { e = err.message }
  ok(!!e, `${what} → 抛错（${String(e).slice(0, 44)}…）`)
}
badDoc([{ no: 1, deliverable: D, checks: [{ id: 'c', kind: '魔法', value: 'v' }] }], '挑战判据里 kind 不认识')
badDoc([{ no: 1, deliverable: D, checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }, { no: 1, deliverable: D, checks: [{ id: 'd', kind: 'annotation', value: 'A' }] }], '挑战序号重复')
badDoc([{ no: 0, deliverable: D, checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }], '挑战序号非法（0）')
badDoc([{ no: 1, deliverable: D, auto: false }], 'auto:false 却没写 hint')
badDoc([{ no: 1, deliverable: D, checks: [] }], 'checks 是空数组')
badDoc([], 'challenges 给了空数组')
badDoc([{ no: 1, checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }], '缺 deliverable（每道挑战都必须有明确产出）')
badDoc([{ no: 1, deliverable: '   ', checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }], 'deliverable 是空白串')

// ── ⑩ 没声明 challenges → 不猜；"需人工确认"不计入达成数；摘要里没有百分比 ──
const emptyFacts = (annotations = []) => ({
  dir: 'd', build: 'maven', files: [], dirs: [], java: { main: [], test: [] },
  classes: [], annotations, endpoints: [], configKeys: [], configValues: [], pomArtifacts: [],
})
const gapsNoCh = computeGaps(emptyFacts([]), { lessons: [{ id: 'x', required: [{ id: 'a', kind: 'annotation', value: 'A' }] }] })
ok(gapsNoCh[0].challenges === null && gapsNoCh[0].challengeSummary === null, '没声明 challenges → 完成度为 null（**不猜**）')
const gapsCh = computeGaps(emptyFacts(['A']), {
  lessons: [{
    id: 'x',
    required: [{ id: 'a', kind: 'annotation', value: 'A' }],
    challenges: [
      { no: 1, deliverable: '产出甲', checks: [{ id: 'c', kind: 'annotation', value: 'A' }] },
      { no: 2, deliverable: '产出乙', auto: false, hint: '机器判不了' },
    ],
  }],
})
const cs = gapsCh[0].challengeSummary
ok(cs.achieved === 1 && cs.total === 1 && cs.needsReview === 1, `需人工确认的项**不计入达成数**（达成 ${cs.achieved} / 共 ${cs.total} ＋ ${cs.needsReview} 项人工）`)
const summaryText = summarizeState({
  projects: [{ facts: emptyFacts(['A']), lessons: gapsCh }],
  signals: { pendingQuestions: 0, processedQuestions: 0, notes: 0, records: 0 },
  pack: { learned: 0, lessons: 0 },
}).join('\n')
ok(/达成 1 \/ 共 1/.test(summaryText), '摘要按「达成 k / 共 n」写')
ok(/另有 1 项需人工确认/.test(summaryText), '需人工确认的项**显式列出**（不混进达成数）')
ok(!/%/.test(summaryText), '摘要里**没有百分比**（有"需人工确认"时百分比必然是假的）')

// ── ⑧ codeDir 不存在 ──
const none = scanWorkspace(ROOT, { codeDir: '不存在的目录' })
ok(none.projects.length === 0 && none.warnings.length === 0, 'codeDir 不存在 → 0 个项目且不炸')

// ── 真工作区没被动过 ──
ok(hashTree(path.join(ROOT, 'code')) === realBefore, '真工作区一字未动（code/ 全树哈希相同）')
// 注意：state.json 是**正常使用**会产出的东西（write:true），所以这里不比"不存在"，
// 只比"本次测试没动过它"——否则用户跑过一次 write 就会把这套判据弄红 ✗
const stateRel = path.join(ROOT, 'learning-records', 'state.json')
ok(
  fs.existsSync(stateRel) === hadState && (hadState ? fs.readFileSync(stateRel, 'utf8') === stateBodyBefore : true),
  `本次测试没有创建或改动真包的 learning-records/state.json（测试前 ${hadState ? '已存在' : '不存在'}）`
)

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 学生状态探针：事实对、与人工记录一致、坏样本报得出缺什么、不猜期望、产物可对拍')
