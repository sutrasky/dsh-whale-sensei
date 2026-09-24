/**
 * challenge-gate.mjs —— 开新课的门禁：**上一课的挑战过没过**（2026-09-24 F1a）
 *
 * 为什么单开一套：v3 §2.1 的第一条硬约束是「『上一课挑战已完成』必须与包侧
 * `tools/ask-server.js` 的 `judgeLightup()` **逐字一致** —— 不许出现『没点亮却放行』」。
 * 断言放在 `lib/gate.js` 里没人跑（A3 的教训），所以接到统一那本账上；判词矩阵逐条钉住。
 *
 * 覆盖面：
 *   ① 「上一课」= 该知识点现有的最后一课（首课 → null）
 *   ② 判词矩阵：no-snapshot / no-criteria / stale-snapshot / criteria-not-met / ok
 *   ③ 真包现状：三课都没做完 ⇒ 三处都该被拦，且逐条列 #编号
 *   ④ 无判据课 → **放行 + 显式告警**（防死锁，绝不静默）
 *   ⑤ author 接线：commit 被拦（needsChallenge）；force 放行但**留痕**说清绕过了哪道闸
 *   ⑥ 真包一字未动
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readPack } from '../lib/pack.js'
import { challengeGate, judgeSnapshot, previousLesson } from '../lib/gate.js'
import { digestTree } from '../lib/fingerprint.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
import { plugin as starterPlugin } from '../lib/mods/starter.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
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
ok(previousLesson(pack, 'spring-boot')?.id === 'spring-boot/0002', 'spring-boot 的上一课 = 0002（该知识点现有的最后一课）')
ok(previousLesson(pack, 'vue')?.id === 'vue/1001', 'vue 的上一课 = 1001')
ok(previousLesson(pack, 'alge')?.id === 'alge/0001', 'alge 的上一课 = 0001（数学圈也有判据了）')
ok(previousLesson(pack, '不存在的点') === null, '不认识的知识点 → null（首课，直接放行）')

// ── ② 判词矩阵（纯函数，与 judgeLightup 同源）──
const VUE_DIR = 'code/programming/vue'
const realDigest = digestTree(path.join(ROOT, VUE_DIR))
const mkDoc = (chs, digest, dir = VUE_DIR) => ({
  projects: [{ dir, sourceDigest: digest, lessons: [{ id: 'pt/0001', challenges: chs, missing: [] }] }],
})
const DONE = { no: 1, deliverable: '做完了', done: true, missing: [] }
const TODO = { no: 2, deliverable: '没做完', done: false, missing: [{ id: 'c', hint: '缺这个' }] }
const REVIEW = { no: 3, deliverable: '人工看', done: null, needsReview: true }

ok(judgeSnapshot(null, ROOT, 'pt/0001').code === 'no-snapshot', '没有快照 → no-snapshot（fail-closed 的前一站）')
ok(judgeSnapshot({ projects: [] }, ROOT, 'pt/0001').code === 'no-criteria', '找不到课 / 没声明判据 → no-criteria')
ok(judgeSnapshot(mkDoc([DONE], '错的指纹'), ROOT, 'pt/0001').code === 'stale-snapshot', '内容指纹对不上 → stale-snapshot（不是 mtime）')
const good = judgeSnapshot(mkDoc([DONE, REVIEW], realDigest), ROOT, 'pt/0001')
// code 必须是词汇表里的 'ok'（不是 undefined）：漏了它会掉进兜底 fail-closed 分支，
// 把"挑战全过"误判成「未检测」—— 2026-09-24 真包第一次出现"全过"时当场暴露（G 条连带修）
ok(good.ok === true && good.code === 'ok' && good.needsReview.join() === '3', '全过 → ok（code=ok），且 auto:false 那题**不阻塞但显式回执题号**（3）')
const bad = judgeSnapshot(mkDoc([DONE, TODO], realDigest), ROOT, 'pt/0001')
ok(bad.code === 'criteria-not-met' && bad.gaps.length === 1 && bad.gaps[0].no === 2,
  '有 missing → criteria-not-met，且点名题号（' + JSON.stringify(bad.gapText) + '）')

// ── ③ 与真包同构的影子副本：门禁跑得通，且**自动重判**这条按 v3 §4.1 真的触发 ──
// ⚠️ 为什么用副本而不是真包：`challengeGate` 的 `probe:true` 在快照过期时会**重研判据快照并写回**
//    （那是 v3 §4.1 的既定行为，生产里是对的）。但在测试里对**真包**这么做有两个后果：
//    ① 别的套同时读真包的 `state.json` → 互相干扰（2026-08-24 实测：全量跑时 bom-tolerance /
//       brief / practice 集体转红，单独跑全绿）；
//    ② 本套自己那句"真包一字未动"就成了假话。所以门禁一律在副本上跑，真包只读。
const KNOWN_CODES = ['no-snapshot', 'no-criteria', 'stale-snapshot', 'criteria-not-met', 'ok', 'first-lesson']
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

// ── ④ 无判据课 → 放行 + 显式告警（防死锁，绝不静默降级）──
const stub = { lessons: [{ id: 'pt/0001', point: 'pt', number: 1 }] }
const noCrit = challengeGate({ root: ROOT, pack: stub, point: 'pt' })
ok(noCrit.allowed === true && noCrit.code === 'no-criteria', '无判据 → **放行**（否则永久死锁）')
ok(!!noCrit.warning && /无闸放行/.test(noCrit.warning), '而且带一句显式告警（不静默）')
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
console.log('✅ 开新课门禁：上一课挑战逐条判、无判据放行有告警、author 拦住且 force 留痕')
