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
const realBefore = hashTree(path.join(ROOT, 'lessons')) + '|' + hashTree(path.join(ROOT, 'code')) + '|' + hashTree(path.join(ROOT, 'math'))

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
ok(good.ok === true && good.needsReview.join() === '3', '全过 → ok，且 auto:false 那题**不阻塞但显式回执题号**（3）')
const bad = judgeSnapshot(mkDoc([DONE, TODO], realDigest), ROOT, 'pt/0001')
ok(bad.code === 'criteria-not-met' && bad.gaps.length === 1 && bad.gaps[0].no === 2,
  '有 missing → criteria-not-met，且点名题号（' + JSON.stringify(bad.gapText) + '）')

// ── ③ 真包现状：三课都没做完 ⇒ 都该被拦 ──
for (const p of ['spring-boot', 'vue', 'alge']) {
  const g = challengeGate({ root: ROOT, pack, point: p })
  ok(g.allowed === false && g.code === 'criteria-not-met', `${p}：上一课挑战没过 → 拦住（${g.lesson}）`)
  ok(Array.isArray(g.missing) && g.missing.length > 0 && g.missing.every((m) => Number.isSafeInteger(m.no) && m.no > 0),
    `${p}：逐条列了缺哪几题（${(g.missing || []).map((m) => '#' + m.no).join(' ')}）`)
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
  const tools = []
  authorPlugin.install({ paths: { packRoot: tmp }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => tools.push(d) })
  const author = tools.find((t) => t.name === 'whale_author')
  ok(!!author, 'whale_author 装得上')
  const base = { point: 'alge', number: 2, title: '代数 第2课 门禁探针', slug: 'gate-probe', hintTerm: 'factorization', source: { label: 'x', url: 'https://example.com' }, root: tmp }

  const blocked = await author.execute({ ...base, commit: true })
  ok(blocked.ok === false && blocked.needsChallenge === true, 'commit 时被门禁拦住（needsChallenge=true）')
  ok(!!blocked.challenge && blocked.challenge.code === 'criteria-not-met', '回执里带着判词与课次（' + (blocked.challenge && blocked.challenge.lesson) + '）')
  ok(/拒绝生成新课/.test(blocked.error || ''), '错误文案是"拒绝生成新课：…"（与前置闸合并成一条）')
  ok(!fs.existsSync(path.join(tmp, 'lessons', 'src', 'math', 'alge', '0002-gate-probe.html')), '被拦时**一个文件都没写**')

  const forced = await author.execute({ ...base, commit: true, force: true })
  ok(!!forced.forced && forced.forced.bypassed.some((s) => /上一课挑战/.test(s)),
    'force 放行但**留痕**说清绕过了哪道闸（' + JSON.stringify(forced.forced?.bypassed) + '）')
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

// ── ⑥ 真包一字未动 ──
ok(hashTree(path.join(ROOT, 'lessons')) + '|' + hashTree(path.join(ROOT, 'code')) + '|' + hashTree(path.join(ROOT, 'math')) === realBefore,
  '真包一字未动（lessons/ + code/ + math/ 全树哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 开新课门禁：上一课挑战逐条判、无判据放行有告警、author 拦住且 force 留痕')
