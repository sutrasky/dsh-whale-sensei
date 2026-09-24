#!/usr/bin/env node
/**
 * test/lightup.mjs —— ① 点亮换钉子：`POST /progress` 的**先判后写**回归网
 * ------------------------------------------------------------------
 * 为什么这一套必须先落地再动代码：`POST /progress` 与 adjustments.jsonl 写入
 * 此前是**零用例覆盖**（契约 R1 红线）—— 改坏无人知。本套按契约 §2.2 的
 * 判决分支表 A–G 逐条钉住（HTTP 一律 200 + `ok:false` + `code`，只有 A 是 400）：
 *
 *   A 缺 lesson            → 400，什么都没落
 *   B 快照缺失/读不懂/无 projects → `no-snapshot`（不写 learned，adjust 照落）
 *   C 无判据（课找不到 / challenges 为空 / 判据结构不合法）→ `no-criteria`
 *   D 快照过期（内容指纹对不上 / 老快照没有指纹字段）→ `stale-snapshot`
 *   E 判据未全过            → `criteria-not-met` + `gaps:[{no,deliverable,missing}]`
 *   F 通过                  → 唯一写盘点：`learned.push` + `writeProgress`；
 *                             `auto:false` 题不阻塞（L3），回执显式 `needsReview:[题号]`
 *   G 显式 `done:false`     → 不尝试点亮（`ok:true` + `code:'not-requested'`）
 *
 * 另钉四件事：
 *   · adjustments.jsonl 记录形状（键序 `ts,lesson,title,adjust,lit,gaps`），
 *     **拒绝时也照落**且 `lit:false` + `gaps`（反静默：学生写了话不许丢）
 *   · 幂等：重复提交只有一条 learned
 *   · `progress.json` 形状零变化：`_` / `note` 原样保留
 *   · 指纹用**插件侧** `lib/fingerprint.js` 算期望值 —— 包侧 `tools/fingerprint.js`
 *     一旦漂移，D/F 分支当场红（R13 的第二道网；逐案例对拍在 mirror-parity）
 *
 * 全程影副本（`os.tmpdir()` 下 mkdtemp）+ 真起包侧 ask-server —— 真包一个字节都不动。
 * 跑：node test/lightup.mjs [课程包根]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { probeState, writeState } from '../lib/state-scan.js'
import { digestTree, PROBE_VERSION } from '../lib/fingerprint.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const waitUp = async (port, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const STUB_PACK = { circles: 0, points: 0, lessons: 3, learned: 0 }
const STATE = (tmp) => path.join(tmp, 'learning-records', 'state.json')
const PROGRESS = (tmp) => path.join(tmp, 'progress.json')
const ADJ = (tmp) => path.join(tmp, 'learning-records', 'adjustments.jsonl')

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const readAdjust = (tmp) => (fs.existsSync(ADJ(tmp))
  ? fs.readFileSync(ADJ(tmp), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [])
const noLearned = (tmp, label) => ok(readJson(PROGRESS(tmp)).learned.length === 0, `${label}：没写 learned（失败关闭）`)

/* ── 影副本 fixture：一个 maven 小项目 + 三课判据 ──────────────────────────
 * `demo/0001` = 真包 `spring-boot/0001` 形态：3 题机械判 + 第 4 题 `auto:false`（L3 口径）
 * `demo/0002` = 判据未全过样本（第 2 题的注解永远不出现）
 * `demo/0003` = 没声明 challenges（→ 快照里 challenges:null）
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-lightup-'))
let child = null
let port = 0
try {
  fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true })
  const proj = path.join(tmp, 'code', 'demo')
  fs.mkdirSync(path.join(proj, 'src', 'main', 'java'), { recursive: true })
  fs.mkdirSync(path.join(proj, 'src', 'main', 'resources'), { recursive: true })
  const JAVA = [
    'package demo;',
    '',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '',
    '@RestController',
    '@Demo',
    'public class HelloController {',
    '    @GetMapping("/hello")',
    '    public String hello() { return "hi"; }',
    '}',
    '',
  ].join('\n')
  const JAVA_FILE = path.join(proj, 'src', 'main', 'java', 'HelloController.java')
  fs.writeFileSync(JAVA_FILE, JAVA, 'utf8')
  fs.writeFileSync(path.join(proj, 'pom.xml'), '<project>\n  <artifactId>demo-project</artifactId>\n</project>\n', 'utf8')
  fs.writeFileSync(path.join(proj, 'src', 'main', 'resources', 'application.properties'), 'server.port=8080\n', 'utf8')
  fs.writeFileSync(path.join(proj, 'EXPECT.json'), JSON.stringify({
    lessons: [
      {
        id: 'demo/0001', title: '你好，点亮',
        required: [{ id: 'any', kind: 'annotation', value: 'Demo', hint: '要有 @Demo' }],
        challenges: [
          { no: 1, deliverable: '有一个 @Demo 标的类', checks: [{ id: 'c1', kind: 'annotation', value: 'Demo' }] },
          { no: 2, deliverable: '有 GET /hello 端点', checks: [{ id: 'c2', kind: 'endpoint', value: 'GET /hello' }] },
          { no: 3, deliverable: '配置里有 server.port', checks: [{ id: 'c3', kind: 'configKey', value: 'server.port' }] },
          { no: 4, deliverable: '讲清楚为什么这么写', auto: false, hint: '要口头讲一遍，机器判不了' },
        ],
      },
      {
        id: 'demo/0002', title: '差一题',
        required: [{ id: 'any', kind: 'annotation', value: 'Demo', hint: '要有 @Demo' }],
        challenges: [
          { no: 1, deliverable: '有一个 @Demo 标的类', checks: [{ id: 'c1', kind: 'annotation', value: 'Demo' }] },
          { no: 2, deliverable: '有 @Nope 注解', checks: [{ id: 'c2', kind: 'annotation', value: 'Nope', hint: '要加 @Nope' }] },
        ],
      },
      {
        id: 'demo/0003', title: '没声明判据',
        required: [{ id: 'any', kind: 'annotation', value: 'Demo', hint: '要有 @Demo' }],
      },
    ],
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(PROGRESS(tmp), JSON.stringify({ _: '人和星图共读', learned: [], note: '别删我' }, null, 2) + '\n', 'utf8')

  // 判据快照：真走探针管线（probeState → writeState），不是手搓 JSON
  const { state } = probeState(tmp, STUB_PACK)
  writeState(tmp, state)
  const snapText = fs.readFileSync(STATE(tmp), 'utf8')
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/progress`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    let j = null
    try { j = await res.json() } catch { /* 非 JSON 就是它自己的判据 */ }
    return { status: res.status, body: j }
  }

  console.log(`\n[lightup] 课程包：${ROOT}\n  影副本：${tmp}`)
  port = await freePort()
  child = spawn(process.execPath, [path.join(tmp, 'tools', 'ask-server.js'), '--port', String(port)], { stdio: 'ignore' })
  const up = await waitUp(port)
  ok(up, `包侧 ask-server 在影副本里起来了（端口 ${port}）`)
  if (!up) throw new Error('ask-server 没起来，后面的分支都测不了')

  // ── A 缺 lesson → 400 ────────────────────────────────────────────────
  {
    const { status, body } = await post({ done: true, adjust: 'A 样本' })
    ok(status === 400 && body && body.ok === false, `A 缺 lesson → 400 + ok:false（实得 ${status}）`)
    ok(readAdjust(tmp).length === 0, 'A 缺 lesson：什么都没落（adjustments 仍空）')
    noLearned(tmp, 'A')
  }

  // ── G 显式 done:false → 不尝试点亮（先于 B 测：证明它连快照都不用）──────
  {
    const { status, body } = await post({ lesson: 'demo/0001', done: false, adjust: 'G：先不点亮', title: 'T' })
    ok(status === 200 && body.ok === true && body.code === 'not-requested', `G done:false → ok:true + code:'not-requested'（实得 ${body && body.code}）`)
    noLearned(tmp, 'G')
    const recs = readAdjust(tmp)
    ok(recs.length === 1 && recs[0].lit === false && recs[0].gaps.length === 0 && recs[0].adjust === 'G：先不点亮',
      'G：adjust 照落，lit:false、gaps 为空（没尝试点亮）')
  }

  // ── B 快照缺失 / 读不懂 / 无 projects → no-snapshot ────────────────────
  {
    fs.rmSync(STATE(tmp), { force: true })
    const r1 = await post({ lesson: 'demo/0001', done: true, adjust: 'B1：快照没了' })
    ok(r1.body.code === 'no-snapshot' && r1.body.ok === false, `B1 快照缺失 → no-snapshot（实得 ${r1.body.code}）`)
    ok(/whale_state/.test(r1.body.hint || ''), `B1 hint 点名怎么修（${r1.body.hint}）`)
    fs.writeFileSync(STATE(tmp), '{ 这不是 JSON', 'utf8')
    const r2 = await post({ lesson: 'demo/0001', done: true })
    ok(r2.body.code === 'no-snapshot', `B2 快照读不懂 → no-snapshot（实得 ${r2.body.code}）`)
    // B3 的本意是「快照没有 projects」（畸形样本），**不是**"老快照"夹具 —— 所以 probeVersion
    // 照抄真快照的顶层形状（用常量，不写字面量）；故意造老快照的是 D1，那处保留缺字段形态。
    fs.writeFileSync(STATE(tmp), JSON.stringify({ version: 1, probeVersion: PROBE_VERSION }), 'utf8')
    const r3 = await post({ lesson: 'demo/0001', done: true })
    ok(r3.body.code === 'no-snapshot', `B3 快照没有 projects → no-snapshot（实得 ${r3.body.code}）`)
    noLearned(tmp, 'B')
    const recs = readAdjust(tmp)
    ok(recs.length === 2 && recs[1].lit === false && recs[1].gaps.length === 0, 'B1：拒绝时 adjust 仍落账且 lit:false')
  }

  // ── C 无判据 → no-criteria ───────────────────────────────────────────
  {
    fs.writeFileSync(STATE(tmp), snapText, 'utf8')
    const r1 = await post({ lesson: 'demo/9999', done: true, adjust: 'C1：没这课' })
    ok(r1.body.code === 'no-criteria' && r1.body.ok === false, `C1 快照里没这课 → no-criteria（实得 ${r1.body.code}）`)
    const r2 = await post({ lesson: 'demo/0003', done: true })
    ok(r2.body.code === 'no-criteria', `C2 challenges 为空 → no-criteria（实得 ${r2.body.code}）`)
    // C3 判据结构不合法（快照被写坏）→ 也算「没有可用判据」
    const bad = JSON.parse(snapText)
    bad.projects[0].lessons.find((l) => l.id === 'demo/0001').challenges = [{ no: 1 }]
    fs.writeFileSync(STATE(tmp), JSON.stringify(bad, null, 2) + '\n', 'utf8')
    const r3 = await post({ lesson: 'demo/0001', done: true })
    ok(r3.body.code === 'no-criteria', `C3 challenges 结构不合法 → no-criteria（实得 ${r3.body.code}）`)
    fs.writeFileSync(STATE(tmp), snapText, 'utf8')
    noLearned(tmp, 'C')
  }

  // ── D 快照过期 → stale-snapshot ──────────────────────────────────────
  {
    // D1 老快照：没有 codeDir / sourceDigest（老包升级前的形态）→ 一律判过期，提示刷新
    const old = JSON.parse(snapText)
    delete old.codeDir
    for (const p of old.projects) delete p.sourceDigest
    fs.writeFileSync(STATE(tmp), JSON.stringify(old, null, 2) + '\n', 'utf8')
    const r1 = await post({ lesson: 'demo/0001', done: true })
    ok(r1.body.code === 'stale-snapshot' && /刷新/.test(r1.body.hint || ''), `D1 老快照（无指纹字段）→ stale-snapshot + 刷新提示（实得 ${r1.body.code}：${r1.body.hint}）`)
    fs.writeFileSync(STATE(tmp), snapText, 'utf8')

    // D3 探针升级前的快照：指纹新鲜、**只缺 probeVersion** → 判词是「探针」那句，
    // 且与 D1「代码又改过」那句**分开**（两种过期原因两句话 —— 2026-09-24 缺陷：只比指纹时
    // 这种快照会被当"新鲜"，拿着旧判词拦人）
    const oldProbe = JSON.parse(snapText)
    delete oldProbe.probeVersion
    fs.writeFileSync(STATE(tmp), JSON.stringify(oldProbe, null, 2) + '\n', 'utf8')
    const r3 = await post({ lesson: 'demo/0001', done: true })
    ok(r3.body.code === 'stale-snapshot' && /探针/.test(r3.body.hint || ''),
      `D3 缺 probeVersion（指纹新鲜）→ stale-snapshot + 探针那句（实得 ${r3.body.code}：${r3.body.hint}）`)
    ok(r3.body.hint !== r1.body.hint, `D3 的 hint 与 D1「代码又改过」那句不同（${r3.body.hint}）`)
    fs.writeFileSync(STATE(tmp), snapText, 'utf8')

    // D2 快照之后改一个字节 → 指纹必变（反空转的现场版）
    const before = fs.readFileSync(JAVA_FILE, 'utf8')
    fs.writeFileSync(JAVA_FILE, before + '// 改一个字节\n', 'utf8')
    const r2 = await post({ lesson: 'demo/0001', done: true, adjust: 'D2：改完没刷新快照' })
    ok(r2.body.code === 'stale-snapshot', `D2 快照后改字节 → stale-snapshot（实得 ${r2.body.code}）`)
    noLearned(tmp, 'D')
    // 恢复字节 → 指纹复原（内容指纹不看 mtime，改回去就不是"过期"）
    fs.writeFileSync(JAVA_FILE, before, 'utf8')
    ok(digestTree(proj) === readJson(STATE(tmp)).projects[0].sourceDigest,
      'D2 恢复字节后指纹复原（内容指纹 = 插件侧算法算的期望值，两侧一漂这里就红）')
  }

  // ── E 判据未全过 → criteria-not-met + gaps ────────────────────────────
  {
    const { status, body } = await post({ lesson: 'demo/0002', done: true, adjust: 'E：差一题', title: '差一题' })
    ok(status === 200 && body.ok === false && body.code === 'criteria-not-met', `E 判据未全过 → criteria-not-met（实得 ${body.code}）`)
    ok(Array.isArray(body.gaps) && body.gaps.length === 1 && body.gaps[0].no === 2,
      `E gaps 点名到题号（${JSON.stringify(body.gaps && body.gaps.map((g) => g.no))}）`)
    ok(typeof body.gaps?.[0]?.deliverable === 'string' && Array.isArray(body.gaps?.[0]?.missing) && body.gaps[0].missing.length >= 1,
      'E gaps 形状 = { no, deliverable, missing:[hint…] }')
    noLearned(tmp, 'E')
    const rec = readAdjust(tmp).pop()
    ok(rec.lit === false && Array.isArray(rec.gaps) && /^第2题：/.test(rec.gaps[0] || ''),
      `E：adjust 照落且 gaps 留痕（lit:false，gaps[0]=${JSON.stringify(rec.gaps[0])}）`)
  }

  // ── F 通过 → 唯一写盘点；auto:false 不阻塞（L3）────────────────────────
  {
    const { status, body } = await post({ lesson: 'demo/0001', done: true, adjust: 'F：过了', title: '你好，点亮' })
    ok(status === 200 && body.ok === true, `F 判据全过 → ok:true（实得 ${status}/${body.ok}）`)
    ok(Array.isArray(body.needsReview) && body.needsReview.join(',') === '4',
      `F auto:false 题不阻塞但显式列出题号 needsReview（实得 ${JSON.stringify(body.needsReview)}）`)
    const prog = readJson(PROGRESS(tmp))
    ok(prog.learned.length === 1 && prog.learned[0] === 'demo/0001', `F learned 写进 progress.json（${JSON.stringify(prog.learned)}）`)
    ok(prog._ !== undefined && prog.note !== undefined, 'F progress.json 的 _ / note 原样保留（形状零变化）')
    ok(body.lit === 1, `F 回执 lit 计数 = ${body.lit}`)
    const rec = readAdjust(tmp).pop()
    ok(rec.lit === true && rec.gaps.length === 0, 'F：adjust 记录带 lit:true + 空 gaps')

    // 幂等：重复提交只有一条 learned
    const again = await post({ lesson: 'demo/0001', done: true })
    ok(again.body.ok === true && readJson(PROGRESS(tmp)).learned.length === 1,
      'F 幂等：重复提交 learned 仍只有一条')

    // Q2 欠账（2026-09-24）：本课 required 还缺着 → **不阻塞点亮**，但回执必须说出来。
    // 为什么两件事都要钉：判词只看 challenges（要 done 会把「required 里也有机器判不了的项」
    // 变成新的死锁）；可要是只点亮不吭声，学生就会以为"全过、万事大吉"——那也是静默。
    {
      const before = fs.readFileSync(STATE(tmp), 'utf8')
      const doc = readJson(STATE(tmp))
      const les = doc.projects[0].lessons.find((l) => l.id === 'demo/0001')
      les.missing = [{ id: 'x', kind: 'dir', value: 'controller', hint: 'controller 包（接口层）', evidence: '目录不存在：controller' }]
      fs.writeFileSync(STATE(tmp), JSON.stringify(doc, null, 2) + '\n', 'utf8')
      const r = await post({ lesson: 'demo/0001', done: true, adjust: 'F2：required 还缺' })
      ok(r.body.ok === true, `F2 required 有缺口**不阻塞**点亮（ok=${r.body.ok}）`)
      ok(Array.isArray(r.body.requiredGaps) && r.body.requiredGaps.join('|') === 'controller 包（接口层）',
        `F2 缺口如实回执 requiredGaps（实得 ${JSON.stringify(r.body.requiredGaps)}）`)
      fs.writeFileSync(STATE(tmp), before, 'utf8')
    }
  }

  // ── 记录形状（键序钉死）────────────────────────────────────────────────
  {
    const recs = readAdjust(tmp)
    ok(recs.every((r) => Object.keys(r).join(',') === 'ts,lesson,title,adjust,lit,gaps'),
      `adjustments.jsonl 键序钉死 ts,lesson,title,adjust,lit,gaps（${Object.keys(recs[0]).join(',')}）`)
    ok(recs.every((r) => typeof r.lit === 'boolean' && Array.isArray(r.gaps)), 'lit 是布尔、gaps 是数组')
  }
} finally {
  if (child && !child.killed) { try { child.kill() } catch { /* 已退 */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 点亮换钉子：A–G 七条分支都按契约判决，失败一律关闭、不静默')
