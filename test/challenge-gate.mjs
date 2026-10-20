/**
 * challenge-gate.mjs —— 开新课的门禁：**上一课的挑战过没过**（2026-09-24 F1a）
 *
 * 为什么单开一套：v3 §2.1 的第一条硬约束是「『上一课挑战已完成』必须与包侧
 * `tools/ask-server.js` 的 `judgeLightup()` **逐字一致** —— 不许出现『没点亮却放行』」。
 * 断言放在 `lib/gate.js` 里没人跑（A3 的教训），所以接到统一那本账上；判词矩阵逐条钉住。
 *
 * 覆盖面：
 *   ① 「上一课」= 该知识点现有的最后一课（首课 → null）
 *   ② 判词矩阵：no-snapshot / unknown-lesson / no-criteria / stale-snapshot / criteria-not-met / ok
 *      （对位键 P1-11：快照里没这课 ≠ 没写判据 —— 两个 code 必须分开，hint 各说各的修法）
 *   ③ 真包现状：三课都没做完 ⇒ 三处都该被拦，且逐条列 #编号
 *   ④ 无判据课 → **放行 + 显式告警**（防死锁，绝不静默）
 *   ⑤ author 接线：commit 被拦（needsChallenge）；force 放行但**留痕**说清绕过了哪道闸
 *   ⑥ 真包一字未动
 *   ⑦⑧⑨ 探针版本（PROBE_VERSION）：值 = 探针源指纹、PROBE_SOURCES = 导入闭包（改探针不改版本号 → 红）；
 *      缺 / 不等 → stale-snapshot 且 hint 与「代码变了」那句分开；端到端自愈（临时包真跑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readPack } from '../lib/pack.js'
import { challengeGate, judgeSnapshot, previousLesson, readSnapshot } from '../lib/gate.js'
import { digestTree, PROBE_VERSION, PROBE_SOURCES } from '../lib/fingerprint.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
import { plugin as starterPlugin } from '../lib/mods/starter.js'
import { migratedPack } from './_t26-migrated-pack.mjs'
import { packRoot, PLUGIN } from './_pack.mjs'

const INPUT_ROOT = packRoot()
const ROOT = migratedPack(INPUT_ROOT)
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
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

console.log(`\n[challenge-gate] 课程包：${ROOT}`)
const pack = readPack(ROOT)
const realBefore = hashTree(path.join(ROOT, 'lessons')) + '|' + hashTree(path.join(ROOT, 'code')) + '|' + hashTree(path.join(ROOT, 'math')) + '|' + hashTree(path.join(ROOT, 'learning-records'))

// ── ① 「上一课」的确定 ──
// ⚠️ 2026-10-20 身份夹具同步：`previousLesson()` 返回的是 `readPack()` 的课对象，它的 `id`
//    是**规范课次键** `circle/point/NNNN`（U09 收敛后的运行态口径）。旧夹具写两段
//    （`vue/1001` / `alge/0001` / `spring-boot/0002`）—— 选择逻辑本来就对，错的只是 id 预期。
// ⚠️ 2026-10-20 第二处过期预期（用户裁决「甲」）：活包 spring-boot 现在有 0001/0002/**0003**
//    三课，按本判据自己的定义「该知识点现有的**最后一课**」，上一课就是 `0003`。旧值 `0002`
//    是只有两课那会儿写的 —— 它不是"放宽"，是把期望对齐到活包现状（仍是精确等值，不是子串匹配）。
ok(previousLesson(pack, 'spring-boot')?.id === 'programming/spring-boot/0003', 'spring-boot 的上一课 = programming/spring-boot/0003（该知识点现有的最后一课）')
ok(previousLesson(pack, 'vue')?.id === 'programming/vue/1001', 'vue 的上一课 = programming/vue/1001')
ok(previousLesson(pack, 'alge')?.id === 'math/alge/0001', 'alge 的上一课 = math/alge/0001（数学圈也有判据了）')
ok(previousLesson(pack, '不存在的点') === null, '不认识的知识点 → null（首课，直接放行）')

// ── ② 判词矩阵（纯函数，与 judgeLightup 同源）──
const VUE_DIR = 'code/programming/vue'
const realDigest = digestTree(path.join(ROOT, VUE_DIR))
const mkDoc = (chs, digest, dir = VUE_DIR) => ({
  // 手搓快照照抄真快照的顶层形状：probeVersion 用**常量**（import 进来的，不写字面量 ——
  // 写死就跟着版本号漂，夹具会静默测不到新路径）。故意要"老快照"的用例自己 delete 它。
  probeVersion: PROBE_VERSION,
  projects: [{ dir, sourceDigest: digest, lessons: [{ id: 'pt/0001', challenges: chs, missing: [] }] }],
})
const DONE = { no: 1, deliverable: '做完了', done: true, missing: [] }
const TODO = { no: 2, deliverable: '没做完', done: false, missing: [{ id: 'c', hint: '缺这个' }] }
const REVIEW = { no: 3, deliverable: '人工看', done: null, needsReview: true }

ok(judgeSnapshot(null, ROOT, 'pt/0001').code === 'no-snapshot', '没有快照 → no-snapshot（fail-closed 的前一站）')
ok(judgeSnapshot({ projects: [] }, ROOT, 'pt/0001').code === 'unknown-lesson', '快照里没这门课 → unknown-lesson（不是 no-criteria）')
{
  const v = judgeSnapshot({ projects: [] }, ROOT, 'pt/0001')
  ok(v.code !== 'no-criteria' && /pt\/0001/.test(v.hint || ''),
    `unknown-lesson 的 hint 点名那个 id、且与 no-criteria 分开（${v.hint}）`)
}
ok(judgeSnapshot(mkDoc(null, realDigest), ROOT, 'pt/0001').code === 'no-criteria',
  '反空转：课真在快照里、只是没声明 challenges → 仍必须 no-criteria（两个分支别混）')
ok(judgeSnapshot(mkDoc([DONE], '错的指纹'), ROOT, 'pt/0001').code === 'stale-snapshot', '内容指纹对不上 → stale-snapshot（不是 mtime）')
const good = judgeSnapshot(mkDoc([DONE, REVIEW], realDigest), ROOT, 'pt/0001')
// code 必须是词汇表里的 'ok'（不是 undefined）：漏了它会掉进兜底 fail-closed 分支，
// 把"挑战全过"误判成「未检测」—— 2026-09-24 真包第一次出现"全过"时当场暴露（G 条连带修）
ok(good.ok === true && good.code === 'ok' && good.needsReview.join() === '3', '全过 → ok（code=ok），且 auto:false 那题**不阻塞但显式回执题号**（3）')
const bad = judgeSnapshot(mkDoc([DONE, TODO], realDigest), ROOT, 'pt/0001')
ok(bad.code === 'criteria-not-met' && bad.gaps.length === 1 && bad.gaps[0].no === 2,
  '有 missing → criteria-not-met，且点名题号（' + JSON.stringify(bad.gapText) + '）')

// ── ②b 探针版本（PROBE_VERSION）：探针改了、快照还是旧判词 → 必须判过期 ──
// 为什么新加这把尺子：`sourceDigest` 只看**学生代码树**。探针实现改了（判定口径变过）时，
// 旧快照照样"指纹新鲜" → 门禁拿**旧判词**拦人（2026-09-24 实测：端点解析扩完、重启宿主后
// `challengeGate` 仍回 criteria-not-met「缺：有 PATCH …/complete」，手动 `whale_state write:true`
// 刷一次立刻放行 —— 中间没有任何东西告诉人"该刷新了"）。
const CODE_HINT = '代码在快照之后又变了：先跑 whale_state write:true 刷新'
{
  // ① 缺 probeVersion（探针升级前的快照）→ stale-snapshot，且点名**探针**
  const noProbe = mkDoc([DONE], realDigest)
  delete noProbe.probeVersion
  const v1 = judgeSnapshot(noProbe, ROOT, 'pt/0001')
  ok(v1.code === 'stale-snapshot' && /探针/.test(v1.hint || ''),
    `缺 probeVersion（指纹是新鲜的）→ stale-snapshot，且点名探针（${v1.hint}）`)
  // ② probeVersion 不等 → 同样判过期
  const wrongProbe = mkDoc([DONE], realDigest)
  wrongProbe.probeVersion = 'p:0000000000000000'
  const v2 = judgeSnapshot(wrongProbe, ROOT, 'pt/0001')
  ok(v2.code === 'stale-snapshot' && /探针/.test(v2.hint || ''), `probeVersion 不等 → stale-snapshot（${v2.hint}）`)
  // ③ 两种过期原因**两句话**：探针那句 ≠ 「代码又改过」那句（混成一句会把人指向错的修法）
  ok(v1.hint !== CODE_HINT && v2.hint !== CODE_HINT && v1.hint === v2.hint,
    '探针过期的 hint 与「代码又改过」那句**不同**（两种原因两句话）')
  // ④ 值相等 → 照旧走原有判定：`good` / `bad`（上面两条，夹具带着 probeVersion）必须照常出
  //    'ok' / 'criteria-not-met' —— 加了新尺子不许把老判词挤没
  ok(good.code === 'ok' && bad.code === 'criteria-not-met',
    'probeVersion 相等 → 照旧走原有判定（ok / criteria-not-met 都还出得来）')
}

// ── ⑧ 探针版本的机械钉子：值 = 探针源内容指纹；清单 = 导入闭包 ────────────────
// 反空转（这两条就是"真的在比"的证据）：把 PROBE_VERSION 改一个字 → ①当场红；
// 探针长了新依赖却没进清单 → ②当场红；改了探针源却没改版本号 → ①当场红
// （失败消息里把要贴的新值打出来，不用人再算一遍）。
{
  const src = (rel) => fs.readFileSync(path.join(PLUGIN, ...rel.split('/')))
  // ① 重算探针源指纹 —— 与 lib/fingerprint.js 注释里的算法**逐字复算**：
  //    按 PROBE_SOURCES 顺序、文件间 '\0' 分隔（首尾不留）、原始字节、sha256 前 16 位 hex
  const parts = []
  PROBE_SOURCES.forEach((rel, i) => { if (i) parts.push(Buffer.from('\0')); parts.push(src(rel)) })
  const expect = 'p:' + crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex').slice(0, 16)
  ok(PROBE_VERSION === expect,
    `PROBE_VERSION == 探针源指纹（改了探针就贴新值进三份 fingerprint.js）—— 应为 ${expect}，实得 ${PROBE_VERSION}`)
  // ② 导入闭包 == PROBE_SOURCES：从 lib/state.js + lib/state-scan.js 出发、只跟 './' 相对导入
  const seen = new Set()
  const walkImp = (rel) => {
    if (seen.has(rel)) return
    seen.add(rel)
    const text = src(rel).toString('utf8')
    const re = /(?:^|[\s};*])from\s+['"](\.\/[^'"]+)['"]|require\(\s*['"](\.\/[^'"]+)['"]\s*\)/gm
    for (const m of text.matchAll(re)) {
      const next = 'lib/' + (m[1] || m[2]).slice(2)
      // 排除 lib/fingerprint.js：它就是**新鲜度机制本身**（它一变 sourceDigest 自会对不上，
      // 老快照自己就过期 —— 不能自己吃自己；理由详见它的 PROBE_SOURCES 注释）
      if (next === 'lib/fingerprint.js') continue
      walkImp(next)
    }
  }
  walkImp('lib/state.js')
  walkImp('lib/state-scan.js')
  const closure = [...seen].sort()
  const declared = [...PROBE_SOURCES].sort()
  ok(closure.join() === declared.join(),
    `导入闭包 == PROBE_SOURCES（探针长了新依赖 → 红，逼人把它加进清单）${closure.join() === declared.join()
      ? `（${closure.length} 件）`
      : `—— 闭包：${closure.join('、')} ｜ 清单：${declared.join('、')}`}`)
}

// ── ⑨ 端到端自愈（真跑）：旧快照（缺 probeVersion）→ challengeGate(probe:true) 自动重判 + 原子写回 ──
// ⚠️ 建**临时包**跑（绝不碰真包的 code/** 与 learning-records/state.json）。
// 夹具的 sourceDigest 是**现算的** ⇒ 唯一的过期原因就是 probeVersion —— 缺陷现场的重演；
// 探针升级后不用手动刷新，第一次调用就该自愈（v3 §4.1 那条 stale-snapshot → 重扫 + 写回）。
{
  const tmpP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-probever-'))
  try {
    const proj = path.join(tmpP, 'code', 'demo')
    fs.mkdirSync(path.join(proj, 'src', 'main', 'java'), { recursive: true })
    fs.mkdirSync(path.join(proj, 'src', 'main', 'resources'), { recursive: true })
    // 判据样本抄 lightup.mjs 的 demo（那三条在那儿已证明会被探针判过 —— 不在这儿赌探针行为）
    fs.writeFileSync(path.join(proj, 'src', 'main', 'java', 'HelloController.java'), [
      'package demo;', '',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RestController;', '',
      '@RestController',
      '@Demo',
      'public class HelloController {',
      '    @GetMapping("/hello")',
      '    public String hello() { return "hi"; }',
      '}', '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(path.join(proj, 'pom.xml'), '<project>\n  <artifactId>demo-project</artifactId>\n</project>\n', 'utf8')
    fs.writeFileSync(path.join(proj, 'src', 'main', 'resources', 'application.properties'), 'server.port=8080\n', 'utf8')
    fs.writeFileSync(path.join(proj, 'EXPECT.json'), JSON.stringify({
      lessons: [{
        id: 'pt/0001', title: '端到端自愈样本',
        required: [{ id: 'any', kind: 'annotation', value: 'Demo', hint: '要有 @Demo' }],
        challenges: [
          { no: 1, deliverable: '有一个 @Demo 标的类', checks: [{ id: 'c1', kind: 'annotation', value: 'Demo' }] },
          { no: 2, deliverable: '有 GET /hello 端点', checks: [{ id: 'c2', kind: 'endpoint', value: 'GET /hello' }] },
          { no: 3, deliverable: '配置里有 server.port', checks: [{ id: 'c3', kind: 'configKey', value: 'server.port' }] },
          { no: 4, deliverable: '讲清楚为什么这么写', auto: false, hint: '机器判不了' },
        ],
      }],
    }, null, 2) + '\n', 'utf8')
    // 手搓"探针升级前"的旧快照：**故意没有 probeVersion**（被测行为），其余照真快照的形状
    const oldSnap = {
      version: 1,
      codeDir: 'code',
      practiceRoots: ['code'],
      projects: [{
        dir: 'code/demo', sourceDigest: digestTree(proj), expect: { path: 'code/demo/EXPECT.json', lessons: 1 },
        lessons: [{
          id: 'pt/0001', title: '端到端自愈样本', satisfied: true, missing: [], done: true,
          challenges: [{ no: 1, deliverable: '有一个 @Demo 标的类', done: true, missing: [] }],
          challengeSummary: { achieved: 1, total: 1, needsReview: 0 },
        }],
      }],
      signals: { pendingQuestions: 0, processedQuestions: 0, notes: 0, records: 0 },
      notes: [],
    }
    const vOld = judgeSnapshot(oldSnap, tmpP, 'pt/0001')
    ok(vOld.code === 'stale-snapshot' && /探针/.test(vOld.hint || ''),
      `旧快照（指纹新鲜、缺 probeVersion）→ 拦在「探针」那句（${vOld.hint}）`)
    ok(judgeSnapshot({ ...oldSnap, probeVersion: PROBE_VERSION }, tmpP, 'pt/0001').code === 'ok',
      '反证：把 probeVersion 补上就判 ok —— 拦人的唯一原因就是探针版本（指纹 / 判据都没问题）')
    fs.mkdirSync(path.join(tmpP, 'lessons', 'demo'), {recursive:true})
    fs.writeFileSync(path.join(tmpP, 'lessons', 'demo', 'halo.json'), JSON.stringify({practice:{dirs:['code/demo'],adapters:['jvm']}}))
    const demoPack = {...readPack(tmpP), lessons:[{id:'pt/0001',point:'pt',number:1}]}
    const g = challengeGate({ root: tmpP, pack: demoPack, point: 'pt', probe: true })
    ok(g.rejudged === true, '端到端：probe:true **自动重判了一次**（v3 §4.1 自愈路真的接上了）')
    const after = readSnapshot(tmpP)
    ok(after && after.probeVersion === PROBE_VERSION, `写回的快照带上了当前 probeVersion（实得 ${after && after.probeVersion}）`)
    ok(g.allowed === true && g.code === 'ok',
      `重判后放行（code=${g.code}）—— 改探针后**第一次调用就自愈**，不用手动刷新`)
  } finally {
    fs.rmSync(tmpP, { recursive: true, force: true })
  }
}

// ── ③ 与真包同构的影子副本：门禁跑得通，且**自动重判**这条按 v3 §4.1 真的触发 ──
// ⚠️ 为什么用副本而不是真包：`challengeGate` 的 `probe:true` 在快照过期时会**重研判据快照并写回**
//    （那是 v3 §4.1 的既定行为，生产里是对的）。但在测试里对**真包**这么做有两个后果：
//    ① 别的套同时读真包的 `state.json` → 互相干扰（2026-08-24 实测：全量跑时 bom-tolerance /
//       brief / practice 集体转红，单独跑全绿）；
//    ② 本套自己那句"真包一字未动"就成了假话。所以门禁一律在副本上跑，真包只读。
const KNOWN_CODES = ['no-snapshot', 'unknown-lesson', 'no-criteria', 'stale-snapshot', 'criteria-not-met', 'ok', 'first-lesson']
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate3-'))
try {
  fs.cpSync(ROOT, tmp3, { recursive: true })
  const snapPath = path.join(tmp3, 'learning-records', 'state.json')
  const dirOfLesson = (lessonId) => {
    const doc = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
    const pr = (doc.projects || []).find((x) => (x.lessons || []).some((l) => l.id === lessonId))
    return pr ? String(pr.dir || '') : ''
  }
  for (const p of ['spring-boot', 'vue', 'alge']) {
    // 逐点把**各自的实践区**弄脏（不是只弄脏一个）—— 新鲜度是按项目算的，
    // 只动 vue 的话 spring-boot / alge 的快照对它们自己而言仍然是新鲜的，重判那条路根本不会走
    const lessonId = previousLesson(readPack(tmp3), p)?.id
    const dir = lessonId ? dirOfLesson(lessonId) : ''
    if (dir) {
      const abs = path.join(tmp3, dir)
      fs.mkdirSync(abs, { recursive: true })
      fs.writeFileSync(path.join(abs, 'gate-probe.md'), 'x\n', 'utf8')
    }
    const g = challengeGate({ root: tmp3, pack: readPack(tmp3), point: p })
    ok(KNOWN_CODES.includes(g.code), `${p}：判词落在已知词汇表里（${g.code}${dir ? '，脏的是 ' + dir : ''}）`)
    ok(g.rejudged === true, `${p}：快照过期 → **自动重判了一次**（v3 §4.1，不是直接放弃）`)
    if (g.code === 'criteria-not-met') {
      ok(Array.isArray(g.missing) && g.missing.length > 0
        && g.missing.every((m) => Number.isSafeInteger(m.no) && m.no > 0 && typeof m.deliverable === 'string'),
        `${p}：判为没过时，逐条列了 #编号 + 产出（${(g.missing || []).map((m) => '#' + m.no).join(' ')}）`)
    }
  }
} finally {
  fs.rmSync(tmp3, { recursive: true, force: true })
}

// ── ④ 判不了的上一课 → 放行 + 显式告警（防死锁，绝不静默降级）：两种病、两句 warning ──
const stub = { lessons: [{ id: 'pt/0001', point: 'pt', number: 1 }] }
// ④-a 对位键（P1-11）：快照里**没这门课**（真包快照只有 spring-boot/vue/alge）→ unknown-lesson
const noHit = challengeGate({ root: ROOT, pack: stub, point: 'pt' })
ok(noHit.allowed === true && noHit.code === 'unknown-lesson',
  `快照里找不到上一课 → unknown-lesson 且**放行**（防死锁；实得 ${noHit.code}）`)
ok(!!noHit.warning && /无闸放行/.test(noHit.warning) && /id/i.test(noHit.warning),
  `unknown-lesson 的告警点名「核对 id / 刷新快照」那条修法（${noHit.warning}）`)
// ④-b 反空转：课**真在快照里**、只是没声明 challenges → 仍必须 no-criteria（也放行，但告警说的是补判据）
const tmpP4 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-nocrit-'))
try {
  fs.mkdirSync(path.join(tmpP4, 'learning-records'), { recursive: true })
  fs.writeFileSync(path.join(tmpP4, 'learning-records', 'state.json'), JSON.stringify({
    version: 1, probeVersion: PROBE_VERSION,
    projects: [{ dir: 'code/demo', sourceDigest: 'x', lessons: [{ id: 'pt/0001', challenges: null, missing: [] }] }],
  }, null, 2) + '\n', 'utf8')
  const noCrit = challengeGate({ root: tmpP4, pack: stub, point: 'pt', probe: false })
  ok(noCrit.allowed === true && noCrit.code === 'no-criteria', '无判据（课在快照里）→ 仍必须 no-criteria 且**放行**（否则永久死锁）')
  ok(!!noCrit.warning && /无闸放行/.test(noCrit.warning) && /challenges|判据/.test(noCrit.warning),
    `no-criteria 的告警说的是「补判据」那条修法（${noCrit.warning}）`)
  ok(noHit.warning !== noCrit.warning, '两种病的 warning **不是同一句**（各说各的修法 —— 别把 id 写错的人指去补判据）')
} finally {
  fs.rmSync(tmpP4, { recursive: true, force: true })
}
const first = challengeGate({ root: ROOT, pack: stub, point: 'never-seen' })
ok(first.allowed === true && first.code === 'first-lesson', '首课（没有上一课）→ 放行，不受门禁影响')

// ── ⑤ author 接线（影子副本，不碰真包）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-'))
try {
  fs.cpSync(ROOT, tmp, { recursive: true })
  // ⚠️ 2026-09-24 F2：`whale_author` 多了**大纲闸**（禁 force 绕），会在挑战闸之前把课拦住。
  //    这一段验的是"挑战闸接线"，所以先给副本里的 alge 注入一张**合法地图**，
  //    免得判据被大纲闸抢在前面（那测的就不是这一段了）。夹具自带前置条件，不依赖真包有没有。
  {
    const pf = path.join(tmp, 'lessons', 'math', 'alge', 'point.json')
    const doc = JSON.parse(fs.readFileSync(pf, 'utf8'))
    doc.plan = {
      goal: '把代数变形写成每步都有依据、别人看得懂的过程',
      nodes: [{
        no: 1, title: '第1课 代数运算与因式分解', deliverable: '0001-分解.md / 0001-极限.md / 0001-重写.md',
        criteria: '三个产物文件都在，且每步都写依据',
        why: '终点是"能讲清每一步为什么成立"，这一课是它的起点',
        sources: [{ label: '《高等数学》第七版（上册）', url: 'https://xuanshu.hep.com.cn/front/h5Mobile/bookDetails?bookId=59cfa123ba9eb884cf8241de' }],
      }],
    }
    fs.writeFileSync(pf, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  }
  const tools = []
  authorPlugin.install({ paths: { packRoot: tmp }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
  const author = tools.find((t) => t.name === 'whale_author')
  ok(!!author, 'whale_author 装得上')
  const base = { point: 'alge', number: 2, title: '代数 第2课 门禁探针', slug: 'gate-probe', hintTerm: 'factorization', source: { label: 'x', url: 'https://example.com' }, root: tmp }

  // ⚠️ ⑤ 验的是**接线**（判词本身在 ② 验）—— 期望值从同一个副本的 `challengeGate` 现算，不写死。
  //    写死就绑在"学生今天做到哪"上了：学生把 alge 做完，这条就会假红（2026-09-24 实测）。
  const gExpect = challengeGate({ root: tmp, pack: readPack(tmp), point: 'alge' })
  const blocked = await author.execute({ ...base, commit: true })
  if (gExpect.allowed === false) {
    ok(blocked.ok === false && blocked.needsChallenge === true, `commit 时被门禁拦住（needsChallenge=true，判词 ${gExpect.code}）`)
    ok(!!blocked.challenge && blocked.challenge.code === gExpect.code, '回执里的判词与门禁**同源一致**（' + (blocked.challenge && blocked.challenge.code) + '）')
    ok(/拒绝生成新课/.test(blocked.error || ''), '错误文案是"拒绝生成新课：…"（与前置闸合并成一条）')
    ok(!fs.existsSync(path.join(tmp, 'lessons', 'src', 'math', 'alge', '0002-gate-probe.html')), '被拦时**一个文件都没写**')
  } else {
    ok(blocked.needsChallenge !== true, `门禁放行（${gExpect.code}）时 author 不该拿挑战当理由拦人`)
  }

  const forced = await author.execute({ ...base, commit: true, force: true })
  ok(!!forced.forced, 'force 走完时带着留痕')
  if (gExpect.allowed === false) {
    ok(forced.forced.bypassed.some((s) => /上一课挑战/.test(s)),
      'force 放行时**留痕**说清绕过了"上一课挑战"这道闸（' + JSON.stringify(forced.forced?.bypassed) + '）')
  }
  // ⚠️ force 那条会**起异步重建作业**（它自己 spawn node 进程）—— 不等它跑完就删临时目录会 EPERM。
  //    而且留痕必须算在写盘**之前**：写盘后 `previousLesson()` 会变成刚建的新课（它还没判据）。
  if (forced.rebuild?.jobId) {
    const { waitRebuild } = await import('../lib/rebuild-job.js')
    const job = await waitRebuild(forced.rebuild.jobId)
    ok(!!job && job.done === true, 'force 起的重建作业跑完了（等它，不靠 sleep 猜）')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ⑦ 门禁读口（`/api/whale/gate`，2026-09-24 F1c）──
// 卡片三态要知道"每个知识点上一课的挑战过没过"，所以门禁要有读口。
// ⚠️ **GET 只读**：`challengeGate` 的 `probe:true` 会重判并**写回快照**（v3 §4.1 的既定行为），
//    放进 GET 就是"读接口带副作用"—— 所以这里逐条钉住：GET 一律 probe:false，重判只能 POST。
{
  const tmpG = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-route-'))
  try {
    fs.cpSync(ROOT, tmpG, { recursive: true })
    const mount = (root) => {
      const captured = []
      starterPlugin.install({
        paths: { packRoot: root },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: () => {},
        inject: (_deps, cb) => cb({ get: () => ({ fetch: { register: (r) => captured.push(r) } }) }),
      })
      return captured.find((r) => r.path === '/api/whale/gate') || null
    }

    const gate = mount(tmpG)
    ok(!!gate && gate.methods.join(',') === 'GET,POST', '门禁读口挂得上（GET / POST）')
    ok(gate.requestBody === 'buffered', '显式声明 requestBody=buffered（基座据此决定要不要缓冲请求体）')

    const call = (root, url, init) => mount(root).fetch(new Request(`http://127.0.0.1:3090${url}`, init))

    // 给 circle/point 形态也认（取最后一段）
    const r1 = await call(tmpG, '/api/whale/gate?point=programming%2Fspring-boot', { method: 'GET' })
    const b1 = await r1.json()
    ok(r1.status === 200 && b1.ok === true && b1.point === 'spring-boot', `GET 认得 circle/point 形态并取最后一段（${b1.point}）`)
    ok(b1.probe === false, '**GET 一律 probe:false**（读接口不带副作用）')
    ok(!!b1.verdict && typeof b1.verdict.allowed === 'boolean' && !!b1.verdict.lesson, `GET 带回判词（${b1.verdict?.code} / ${b1.verdict?.lesson}）`)

    // GET 绝不写盘：把副本的快照时间戳/内容记下来，GET 前后逐字节比
    const snapBefore = fs.readFileSync(path.join(tmpG, 'learning-records', 'state.json'), 'utf8')
    for (const p of ['spring-boot', 'vue', 'alge']) await call(tmpG, `/api/whale/gate?point=${p}`, { method: 'GET' })
    ok(fs.readFileSync(path.join(tmpG, 'learning-records', 'state.json'), 'utf8') === snapBefore,
      '三次 GET 之后副本快照**逐字节未变**（GET 真的没写盘）')

    // 无 point → 400（不是 500）
    const r2 = await call(tmpG, '/api/whale/gate', { method: 'GET' })
    ok(r2.status === 400 && /point/.test((await r2.json()).error || ''), `没给 point → ${r2.status}（不是 500）`)

    // 没配 packRoot → configured:false + verdict:null（卡片按「未检测」渲染，fail-closed 不猜放行）
    const r3 = await call(undefined, '/api/whale/gate?point=vue', { method: 'GET' })
    const b3 = await r3.json()
    ok(r3.status === 200 && b3.configured === false && b3.verdict === null, '没配 packRoot → configured:false 且不猜判词')

    // POST probe=1 才是重判（显式动作）
    const r4 = await call(tmpG, '/api/whale/gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ point: 'vue', probe: 1 }),
    })
    const b4 = await r4.json()
    ok(r4.status === 200 && b4.probe === true, 'POST probe=1 → probe:true（重判是显式动作）')
    ok(!!b4.verdict && typeof b4.verdict.allowed === 'boolean', `POST 也带回判词（${b4.verdict?.code}）`)
  } finally {
    fs.rmSync(tmpG, { recursive: true, force: true })
  }
}

// ── ⑥ 真包一字未动（**含 learning-records/** —— 漏了它就抓不住"门禁顺手刷了真快照"这种事）──
ok(hashTree(path.join(ROOT, 'lessons')) + '|' + hashTree(path.join(ROOT, 'code')) + '|' + hashTree(path.join(ROOT, 'math')) + '|' + hashTree(path.join(ROOT, 'learning-records')) === realBefore,
  '真包一字未动（lessons/ + code/ + math/ + learning-records/ 全树哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 开新课门禁：上一课挑战逐条判、判不了的（无判据 / 快照里没这课）都放行有告警且两句分开、author 拦住且 force 留痕')
