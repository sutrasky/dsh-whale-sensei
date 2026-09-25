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
import { probeState, writeState, scanWorkspace, scanProject } from '../lib/state-scan.js'
import { validateExpect, computeGaps, assertLosslessJson, parseEndpoints, joinEndpointPath } from '../lib/state.js'
import { summarizeState } from '../lib/state.js'
import { PROBE_VERSION } from '../lib/fingerprint.js'
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
// 2026-09-24 D1：实践区改成「按圈声明」后，**只有 EXPECT.json、没有构建文件**的
// `code/programming/vue/` 也立成了项目 —— 所以从 1 个变成 2 个（这正是本轮修掉的那个缺陷）
// 2026-09-24 D2-b：高数补了 EXPECT.json ⇒ `math/alge` 成为第 3 个（数学圈的实践区也活了）
ok(state.projects.length === 3, `扫到 3 个学生项目（实得 ${state.projects.length}：${state.projects.map((p) => p.dir).join('、')}）`)
ok(state.projects.some((p) => p.dir === 'code/programming/vue'),
  '②层缺陷回归判据：只有 EXPECT.json 的 vue 实践区也被认成项目')
ok(state.projects.some((p) => p.dir === 'math/alge'),
  '数学圈的实践区也是项目（D2-b：math/alge 的 EXPECT.json 生效）')
ok(state.projects.every((p) => !path.isAbsolute(p.dir) && !p.dir.startsWith('../')),
  '项目身份是**包根相对**路径（多根扫描下不撞名）')
ok(JSON.stringify(state.practiceRoots) === JSON.stringify(['code/_hello-spring-boot/hello-spring-boot', 'code/programming', 'code/programming/vue', 'math', 'math/alge'].sort()),
  `practiceRoots = 圈级 ∪ 点级里实际存在的（实得 ${JSON.stringify(state.practiceRoots)}）`)
ok(P?.facts.build === 'maven', `构建方式识别为 maven（实得 ${P?.facts.build}）`)
ok(P?.facts.endpoints.length >= 1, `至少认得出一个端点（实得 ${P?.facts.endpoints.length}：${(P?.facts.endpoints || []).slice(0, 4).map((e) => e.method + ' ' + e.path).join('、')}${(P?.facts.endpoints || []).length > 4 ? ' …' : ''}）`)
// ⚠️ 真包是**学生正在用**的包（2026-09-24 实测：他当天就在做第 2 课），所以这一段只验**结构与性质**
//    —— 具体端点 / 注解 / 主源数会随他写代码而变。**精确判据**搬到下面那个合成工程（确定性）。
ok(Array.isArray(P?.facts.annotations) && P.facts.annotations.every((a) => typeof a === 'string' && a),
  `注解列表形状对（${(P?.facts.annotations || []).length} 个）`)
ok(Array.isArray(P?.facts.endpoints) && P.facts.endpoints.every((e) => typeof e.method === 'string' && typeof e.path === 'string'),
  `端点列表形状对（${(P?.facts.endpoints || []).length} 个）`)
ok(!P?.facts.files.some((f) => /(^|\/)(target|\.mvn)(\/|$)/.test(f)), 'target/ 与 .mvn/ 没被当成学生文件')
ok(!P?.facts.files.some((f) => /\.LCK|~$/.test(f)), '编辑器锁文件没被算进事实')
ok(typeof state.pack.learned === 'number' && typeof state.pack.lessons === 'number',
  `pack 计数是数字（learned=${typeof state.pack.learned}、lessons=${typeof state.pack.lessons}）`)
// 计数与**包自己**对账（不写死数字）：state 是 pack 的投影
ok(state.pack.lessons === pack.lessons.length, `课数与包一致（${state.pack.lessons} / ${pack.lessons.length}）`)
ok(state.pack.learned === pack.learned.length, `点亮数与包一致（${state.pack.learned} / ${pack.learned.length}）`)
ok(!JSON.stringify(summarizeState(state)).includes('[object Object]'), '摘要里没有 [object Object]（渲染出来的每一行都是给人看的）')

// ── ①b 合成工程：**精确**判据（真包会随学生变，写死在那儿等于给自己埋雷）──
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-facts-'))
  try {
    const root = path.join(d, 'proj')
    fs.mkdirSync(path.join(root, 'src', 'main', 'java', 'com', 'x'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'main', 'resources'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src', 'test', 'java', 'com', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n', 'utf8')
    fs.writeFileSync(path.join(root, 'src', 'main', 'resources', 'application.properties'), 'server.port=8099\n', 'utf8')
    fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'com', 'x', 'App.java'),
      'package com.x;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n', 'utf8')
    fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'com', 'x', 'HelloController.java'),
      'package com.x;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class HelloController {\n  @GetMapping("/hello/{name}")\n  public String hello(@PathVariable String name) { return name; }\n}\n', 'utf8')
    fs.writeFileSync(path.join(root, 'src', 'test', 'java', 'com', 'x', 'AppTest.java'), 'package com.x;\npublic class AppTest {}\n', 'utf8')

    const { facts } = scanProject(root, 'proj')
    ok(facts.build === 'maven', `构建方式认得出（${facts.build}）`)
    ok(facts.endpoints.length === 1 && facts.endpoints[0].method === 'GET' && facts.endpoints[0].path === '/hello/{name}',
      `端点抽得准（${JSON.stringify(facts.endpoints)}）`)
    ok(facts.annotations.includes('RestController') && facts.annotations.includes('SpringBootApplication'),
      `注解抽得准（${facts.annotations.map((a) => '@' + a).join(' ')}）`)
    ok(facts.configKeys.includes('server.port'), `配置键抽得准（${facts.configKeys.join('、')}）`)
    ok(facts.pomArtifacts.length >= 1, `pom 依赖抽得出来（${facts.pomArtifacts.join('、')}）`)
    ok(facts.java.main.length === 2 && facts.java.test.length === 1, `主源 2 / 测试 1（实得 ${facts.java.main.length}/${facts.java.test.length}）`)

    // 锁文件与构建产物不算学生文件（自造一个，别靠"刚好没文件"空转）
    fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'com', 'x', '.LCKApp.java~'), 'x', 'utf8')
    fs.mkdirSync(path.join(root, 'target'), { recursive: true })
    fs.writeFileSync(path.join(root, 'target', 'App.class'), 'x', 'utf8')
    const { facts: f2 } = scanProject(root, 'proj')
    ok(!f2.files.some((f) => /\.LCK|~$/.test(f)), '合成的锁文件被排除（不是空转）')
    ok(!f2.files.some((f) => /(^|\/)target(\/|$)/.test(f)), '合成的 target/ 被排除')
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
}
ok(!JSON.stringify(summarizeState(state)).includes('[object Object]'), '摘要里没有 [object Object]（渲染出来的每一行都是给人看的）')

// ── ①c G 条：端点解析（裸注解 / 类级前缀拼接 / 旧三形态照旧）+ **不猜** ────────────
// 探针喂的是挑战判定，判据里的端点是**浏览器实际访问的全路径**（code/_hello-spring-boot/EXPECT.json
// 就写着 `PATCH /api/tasks/{id}/complete`）。所以类级前缀必须拼进来；裸注解回落到前缀本身。
// 立场：**误报比漏报更坏** —— 认不出的形态一条都不报，绝不编一个路径出来。
{
  const SRC = `package x;
import org.springframework.web.bind.annotation.*;
/**
 * 接口一览（Javadoc 里的假注解，**不许被当成代码**）：
 * 用法示例见下文，形如 {@code @RequestMapping("/doc-only")}。
 */
@RestController
@RequestMapping("/api")
class TaskCtrl {
  /** 对应 {@code GET /api}；本行还藏着一个假注解 {@code @GetMapping("/doc-only")}。 */
  @GetMapping
  String list() { return ""; }

  @GetMapping("/tasks/{id}")
  String one() { return ""; }

  @PostMapping(value = "/tasks")
  String create() { return ""; }

  @PutMapping(path = "/tasks/{id}")
  String update() { return ""; }

  @RequestMapping("/legacy")
  String legacy() { return ""; }

  @GetMapping({"/a", "/b"})
  String multi() { return ""; }

  @GetMapping(CONSTANT)
  String konst() { return ""; }
}`
  const eps = parseEndpoints(SRC, 'TaskCtrl.java')
  const has = (method, p) => eps.some((e) => e.method === method && e.path === p)
  ok(has('GET', '/api'), `裸注解 @GetMapping → 类级前缀本身（实得 ${eps.map((e) => e.method + ' ' + e.path).join('、')}）`)
  ok(has('GET', '/api/tasks/{id}'), '类级前缀拼接：/api + /tasks/{id}')
  ok(has('POST', '/api/tasks'), '旧形态 value = "/x" 照认，且拼前缀')
  ok(has('PUT', '/api/tasks/{id}'), '旧形态 path = "/x" 照认，且拼前缀')
  ok(has('ANY', '/api/legacy'), '方法级 @RequestMapping 也拼前缀（verb = ANY）')
  ok(has('GET', '/api/tasks/{id}') && eps.filter((e) => e.path === '/api/tasks/{id}').length === 2,
    '旧形态 @GetMapping("/x") 逐字保持识别（GET 与 PUT 各一条，没有互相吞掉）')
  ok(!eps.some((e) => e.path === '/doc-only' || e.path.endsWith('/doc-only')),
    'Javadoc 里的假注解不认（先剥注释再解析）—— 误报比漏报更坏')
  ok(!eps.some((e) => e.path === '/a' || e.path === '/b' || e.path === '/api/a' || e.path === '/api/b'),
    '数组参数 {"/a","/b"} → 一条都不报（不猜、不编）')
  ok(!eps.some((e) => /CONSTANT/.test(e.path)) && eps.length === 5,
    `常量参数 → 不报；总数恰为 5（实得 ${eps.length}：${eps.map((e) => e.method + ' ' + e.path).join('、')}）`)

  // 裸注解 + 类上没有前缀 → `/`（Spring 把无路径映射挂在根路径；空串会变成比不了的 `GET `）
  const root = parseEndpoints('class C {\n  @GetMapping\n  String home() { return ""; }\n}\n', 'C.java')
  ok(root.length === 1 && root[0].method === 'GET' && root[0].path === '/',
    `裸注解 + 类上没有 @RequestMapping → "/"（实得 ${JSON.stringify(root)}）`)
  ok(joinEndpointPath('/api/', '/tasks') === '/api/tasks' && joinEndpointPath('', '') === '/',
    '拼接规则：斜杠重叠归一、两边都空 → /')

  // 类上有 @RequestMapping 但**路径解析不出**（数组/常量）→ 裸注解不报：那时任何 URL 都是猜的
  const amb = parseEndpoints('@RequestMapping({"/a","/b"})\nclass C {\n  @GetMapping\n  String home() { return ""; }\n  @GetMapping("/x")\n  String x() { return ""; }\n}\n', 'Amb.java')
  ok(!amb.some((e) => e.path === '/' || e.path === '/a' || e.path === '/b'),
    `类级前缀解析不出 → 裸注解**不报**（不猜前缀；实得 ${amb.map((e) => e.method + ' ' + e.path).join('、') || '空'}）`)
  ok(amb.some((e) => e.method === 'GET' && e.path === '/x'),
    '但旧三形态照旧识别（@GetMapping("/x") 仍报 /x —— 不退化）')

  // 反空转：拿**修法前的旧正则**跑同一份源码 —— 它既漏（给不出完整 URL）又误（把 Javadoc 当代码）
  const OLD = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/g
  const oldPaths = [...SRC.matchAll(OLD)].map((m) => m[2])
  ok(oldPaths.includes('/doc-only') && !eps.some((e) => e.path.endsWith('/doc-only')),
    `反空转①：旧正则把 Javadoc 里的假注解报成端点（${oldPaths.filter((p) => p === '/doc-only').length} 条 /doc-only），新解析器 0 条`)
  ok(!oldPaths.includes('/api/tasks') && has('POST', '/api/tasks'),
    '反空转②：旧正则给不出完整 URL（只有 /tasks 片段 ⇒ 判据必假阴），新解析器给出 /api/tasks')
  ok(!oldPaths.includes('') && has('GET', '/api'),
    '反空转③：旧正则根本不认裸注解（空路径 0 条），新解析器认出 GET /api')
}

// ── ② 与人工记录对齐（外部锚）──
const l1 = P?.lessons.find((l) => l.id === 'spring-boot/0001')
const l2 = P?.lessons.find((l) => l.id === 'spring-boot/0002')
ok(l1?.done === true && l1.missing.length === 0, `第1课判定为**已达成**（缺 ${l1?.missing.length ?? '?'} 项）—— 与 learning-records/0004 一致`)
// ⚠️ 第2课那条**不能再拿 0004 当锚**：那份人工记录写的是"当时"的状态（第2课未开始），
//    而学生随时会开始做它（2026-09-24 当天就发生了）。所以只验**结构性**：
ok(!!l2, `第2课在探针结果里（${l2?.id}）`)
ok(typeof l2?.done === 'boolean' && Array.isArray(l2?.missing) && Array.isArray(l2?.satisfied),
  `第2课的判定形状对（done=${l2?.done} 满足 ${l2?.satisfied?.length} 缺 ${l2?.missing?.length}）`)
ok((l2?.missing || []).every((m) => !!m.id && !!m.kind), '缺的项都点名到具体条目（id + kind），没有空条目')

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

  // ⚠️ `P.facts.dir` 是**包根相对**（2026-09-24 D1 起）—— 而 `tmp` 下拷的就是包根，
  //    所以直接 join(tmp, dir)。旧写法 `join(tmp, 'code', dir)` 会拼成 tmp/code/code/…，
  //    rmSync 因 force 不报错，于是**坏样本根本没造出来、判据却在报"功能坏了"**（静默空转）
  const projDir = path.join(tmp, P.facts.dir)
  // ③ 删掉**所有**控制器 → 第1课必须变红
  //    ⚠️ 不许写死一个路径（`.../HelloController.java`）：学生会重构 / 改名（2026-09-24 实测踩到：
  //    文件已经不叫那个名字了，rmSync 因 force 不报错，于是**坏样本没造出来、判据却在报"功能坏了"**）
  const ctrls = []
  ;(function walkC(d) {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walkC(p); continue }
      if (/Controller\.java$/.test(e.name)) ctrls.push(p)
    }
  })(projDir)
  ok(ctrls.length > 0, `影子副本里找得到控制器文件（${ctrls.length} 个）—— 找不到这条判据就是空转`)
  for (const c of ctrls) fs.rmSync(c, { force: true })
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

  // ⑧ 挑战级完成度：**随数据变**
  // ⚠️ 判据是**增量**不是绝对值：学生随时可能已经把挑战1 做掉（2026-09-24 实测就是这么红的 ——
  //    写死"补之前 = 0"，而他当天已经写了带 @NotNull 的 Task）。所以先把它**移走**，再补回来。
  const realExpect = path.join(ROOT, 'code', '_hello-spring-boot', 'EXPECT.json')
  fs.copyFileSync(realExpect, path.join(tmp, 'code', '_hello-spring-boot', 'EXPECT.json'))
  const lessonOf = (r) => probeState(r, STUB_PACK).state.projects[0].lessons.find((l) => l.id === 'spring-boot/0002')
  const beforeCh = lessonOf(tmp)
  const achBefore = beforeCh.challengeSummary.achieved
  ok(Number.isSafeInteger(achBefore) && achBefore <= beforeCh.challengeSummary.total,
    `补之前：第2课挑战达成 ${achBefore} / 共 ${beforeCh.challengeSummary.total}`)

  // 把影副本里**已有的** Task 类全部移走（学生可能已经写过；没有就是 no-op）
  const taskFiles = []
  ;(function walkT(d) {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walkT(p); continue }
      if (/^Task.*\.java$/.test(e.name)) taskFiles.push(p)
    }
  })(path.join(tmp, P.facts.dir))
  for (const f of taskFiles) fs.rmSync(f, { force: true })
  const midCh = lessonOf(tmp)
  ok(midCh.challenges[0].done === false, `把 Task 类移走（${taskFiles.length} 个）⇒ 挑战1 变未达成（判据真的在读数据）`)

  // 补上规范的 Task + @NotNull
  // ⚠️ `P.facts.dir` 是**包根相对**，`tmp` 下拷的就是包根 → 直接 join(tmp, dir)
  const taskDir = path.join(tmp, P.facts.dir, 'src', 'main', 'java', 'com', 'sutrasky', 'hello_spring_boot', 'model')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'Task.java'), 'package x;\nimport jakarta.validation.constraints.NotNull;\npublic class Task {\n  @NotNull private String title;\n}\n', 'utf8')
  const afterCh = lessonOf(tmp)
  ok(afterCh.challengeSummary.achieved === midCh.challengeSummary.achieved + 1,
    `补回 Task + @NotNull ⇒ 达成 +1（${midCh.challengeSummary.achieved} → ${afterCh.challengeSummary.achieved}）—— **随数据变**`)
  ok(afterCh.challenges[0].done === true, '刚补的那一题（挑战1：Task + @NotNull）变达成')
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
  // 手搓快照照抄真快照的顶层形状（probeVersion 用 import 的常量，不写字面量）
  probeVersion: PROBE_VERSION,
  projects: [{ facts: emptyFacts(['A']), lessons: gapsCh }],
  signals: { pendingQuestions: 0, processedQuestions: 0, notes: 0, records: 0 },
  pack: { learned: 0, lessons: 0 },
}).join('\n')
ok(/达成 1 \/ 共 1/.test(summaryText), '摘要按「达成 k / 共 n」写')
ok(/另有 1 项需人工确认/.test(summaryText), '需人工确认的项**显式列出**（不混进达成数）')
ok(!/%/.test(summaryText), '摘要里**没有百分比**（有"需人工确认"时百分比必然是假的）')

// ── ⑪ 挑战序号对位（镜像包侧 R6）：no 集合必须恰好 = 课程源 `<!--@challenges-->` 的 <li> 条数 ──
// 病灶：R6 原本只在课程包闸门跑、插件侧看不见 ⇒ 手写坏的 EXPECT.json（no 与源里题目数
// 对不上）会让插件的 k/n **说谎**。这里走**全链**：state-scan 读源数 <li> → state.js 纯比较。
// 口径：E:\workplace\study\tools\check-lesson-content.js 的 challengeAlignment()（R6 主流程）。
{
  const tmpR6 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-r6-'))
  try {
    // 课程源：<!--@challenges--> 区块里 3 条 <li>
    const srcDir = path.join(tmpR6, 'lessons', 'src', 'demo', 'pt')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, '0001-a.html'),
      '<!doctype html><html><body><!--@challenges--><li>第 1 题</li><li>第 2 题</li><li>第 3 题</li><!--/@challenges--></body></html>\n', 'utf8')
    // 学生实践区：code/pt/EXPECT.json（项目标志 = EXPECT.json）
    fs.mkdirSync(path.join(tmpR6, 'code', 'pt'), { recursive: true })
    const expectPath = path.join(tmpR6, 'code', 'pt', 'EXPECT.json')
    const mkCh = (no) => ({ no, deliverable: `第 ${no} 题产出`, checks: [{ id: `c${no}`, kind: 'file', value: `0001-${no}.md` }] })
    const writeExpect = (nos, extra = []) => fs.writeFileSync(expectPath, JSON.stringify({
      lessons: [
        { id: 'pt/0001', title: '对位课', required: [{ id: 'r1', kind: 'file', value: 'x.md' }], challenges: nos.map(mkCh) },
        ...extra,
      ],
    }, null, 2) + '\n', 'utf8')
    const lessonOf = (id) => probeState(tmpR6, STUB_PACK).state.projects[0].lessons.find((l) => l.id === id)

    // (a) 不等 ⇒ 必须报出来（原文进 challengeAlign.message，也进摘要）
    writeExpect([1, 2])
    const mis = lessonOf('pt/0001')
    ok(mis.challengeAlign?.ok === false && /序号对位错开了/.test(mis.challengeAlign.message || ''),
      `[R6-a] no={1,2} vs 源里 3 条 <li> ⇒ **报出来**：${mis.challengeAlign?.message}`)
    const misSummary = summarizeState(probeState(tmpR6, STUB_PACK).state).join('\n')
    ok(!!mis.challengeAlign?.message && misSummary.includes(mis.challengeAlign.message), '[R6-a] 告警原文也进了人看的摘要（⚠️ 一行，不只躺 state.json）')

    // (b) 相等 ⇒ 不报
    writeExpect([1, 2, 3])
    const eq3 = lessonOf('pt/0001')
    ok(eq3.challengeAlign?.ok === true && eq3.challengeAlign.message === null,
      `[R6-b] no={1,2,3} == 源里 3 条 <li> ⇒ **不报**（message=${eq3.challengeAlign?.message}）`)

    // (c) 读不到源 ⇒ 不崩、也不静默（明说这条校验跳过）
    writeExpect([1], [{ id: 'pt/0002', title: '没源课', required: [{ id: 'r1', kind: 'file', value: 'y.md' }], challenges: [mkCh(1)] }])
    const l2 = lessonOf('pt/0002')
    ok(l2.challengeAlign?.ok === null && /读不到源，这条校验跳过/.test(l2.challengeAlign.message || ''),
      `[R6-c] 读不到课程源 ⇒ 不崩且明说跳过：${l2.challengeAlign?.message}`)
  } finally {
    fs.rmSync(tmpR6, { recursive: true, force: true })
  }
}

// ── ⑧ codeDir 不存在 ──
const none = scanWorkspace(ROOT, { codeDir: '不存在的目录' })
// 2026-09-24 D1 起：扫描根不存在**不再静默** —— 0 个项目（不炸）**且**有一条点名它的 warning
ok(none.projects.length === 0 && none.warnings.length === 1 && /不存在的目录/.test(none.warnings[0]),
  `codeDir 不存在 → 0 个项目、不炸、且**不静默**（warnings=${JSON.stringify(none.warnings)}）`)

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
