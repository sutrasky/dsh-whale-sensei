/**
 * judge-parity.mjs —— 判词表对拍：插件 `lib/gate.js` ↔ 包侧 `tools/ask-server.js`（#10 缺口①）
 * ---------------------------------------------------------------------------
 * 补的是这条债：`judgeSnapshot`（插件）与 `judgeLightup`（包侧）是**同源判词表**
 * （两边注释都写着「同一顺序、同一句 hint，改一处必须改两处」），但**此前没有任何对拍**——
 * `test/challenge-gate.mjs` 只 import 插件侧自己（注释里写"与 judgeLightup 同源"却不比），
 * `test/lightup.mjs` 真起了 ask-server 但走 HTTP 端到端、不覆盖判词矩阵。
 * ⇒ 改一边漏另一边（"插件拦住、包侧放行"）当时**没有任何测试会红**。这套补上。
 *
 * 机制（照 test/mirror-parity.mjs ② ③ / test/lightup.mjs 的现成夹具）：
 *   影副本（os.tmpdir() 下 mkdtemp）里拷 `tools/` + 一个 maven 小项目 → 真起包侧 `ask-server.js`
 *   子进程，判词从 **HTTP `POST /progress`** 的回执读（回执 = judgeLightup 的返回值过滤后原样回）；
 *   插件侧直接调 `lib/gate.js` 的 `judgeSnapshot` + `challengeGate`。**同一份 state.json、同一棵代码树**
 *   同时喂给两边 —— 包侧的 gapText 走它自己的另一条回执通道（`learning-records/adjustments.jsonl`
 *   的 `gaps` 字段 = verdict.gapText，`POST /progress` 带 adjust 就会落）。
 *   真包一个字节不动（结尾有断言钉住）。
 *
 * 断言什么（逐用例 × 逐项）：
 *   判词层（judgeSnapshot ↔ judgeLightup）：code / ok / hint / gapText / gaps / needsReview /
 *   requiredGaps / achieved·total；
 *   放行层（challengeGate ↔ /progress 写盘点）：**三元组 code × allowed × warning**。
 *
 * 豁免表（EXEMPT）：两边**有意不同**的部分，不改代码去凑一致 —— 每行写明理由，
 * 并带"双方各自实况"的断言（哪边行为变了这行就红，逼人重新裁定；两边收敛了就删行）。
 * 反过来，**出现没登记的差异一律红**（那就是漂移）。
 *
 * 反空转（开发期实测，见回报）：改 `lib/gate.js` 里 unknown-lesson 分支的返回值 ⇒ 本套必红 ⇒ 改回 ⇒ 绿。
 * 跑：node test/judge-parity.mjs [课程包根]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { challengeGate, judgeSnapshot, readSnapshot } from '../lib/gate.js'
import { probeState, writeState } from '../lib/state-scan.js'
import { digestTree, PROBE_VERSION } from '../lib/fingerprint.js'
import { migratedPack } from './_t26-migrated-pack.mjs'
import { packRoot } from './_pack.mjs'

const INPUT_ROOT = packRoot()
const ROOT = migratedPack(INPUT_ROOT)
const require_ = createRequire(import.meta.url)
const packFp = require_(path.join(ROOT, 'tools', 'fingerprint.js'))

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
const j = (v) => JSON.stringify(v)
const show = (v) => (v === undefined ? 'undefined' : j(v))

/* ── 豁免表：有意不同的部分（不是漂移，也不许为了凑一致去改产品代码）─────────
 * 每行 = (用例, 对比项) → 插件侧实况 / 包侧实况 / 理由。哪边行为变了，这行就红。
 */
const EXEMPT = [
  {
    id: 'E1', cases: ['ok（全过；auto:false 走 needsReview）', 'ok（required 还缺：不阻塞、照实回执）', 'ok（证据补到档了）'], field: 'code',
    plugIs: (v) => v === 'ok',
    packIs: (v) => v === null,
    插件: "code:'ok'",
    包侧: 'ok:true、回执里没有 code 字段',
    why: '判词不不同、回执形状不同：插件 challengeGate 的分支表按 `v.code === "ok"` 认"通过"，必须给词；'
      + '包侧 /progress 按 `verdict.ok` 布尔判（`if (verdict.code) out.code=...` 才回写），成功时不需要 code。'
      + '两边对"通过"的判定一致（ok 布尔也逐项钉住）。',
  },
  {
    id: 'E2', cases: ['unknown-lesson（快照里没这课）'], field: 'allowed',
    plugIs: (v) => v === true,
    packIs: (v) => v === false,
    插件: 'allowed:true（放行）',
    包侧: 'lit:false（不写点亮台账）',
    why: '**不同函数层**：插件判"能不能开下一课"（防死锁：刚建的课还没进快照 / id 写错，拦着就是永久卡死）；'
      + '包侧判"要不要写入点亮台账"（失败关闭，不写脏 progress.json）。判词层两边仍逐字一致。',
  },
  {
    id: 'E3', cases: ['unknown-lesson（快照里没这课）'], field: 'warning',
    plugIs: (v) => typeof v === 'string' && v.includes('《demo/0009》') && v.includes('刷新'),
    packIs: (v) => v === null,
    插件: '显式告警（指名课次 id + 修法"核对 id / 刷新快照"）',
    包侧: '无 warning 概念（拒绝时用 ok:false + code + hint 表意）',
    why: '放行就必须**显式告警**（绝不静默）；包侧不放行，故没有告警这个字段。'
      + '两句 hint（unknown-lesson / no-criteria）在判词层仍逐字一致。',
  },
  {
    id: 'E4', cases: ['no-criteria（没声明挑战判据）'], field: 'allowed',
    plugIs: (v) => v === true,
    packIs: (v) => v === false,
    插件: 'allowed:true（无闸放行）',
    包侧: 'lit:false（不写点亮台账）',
    why: '同 E2：防死锁（没声明判据的课拦着 = 永久卡死）vs 失败关闭（判据不全不点亮）。'
      + '插件侧注释写明"补上 EXPECT.json 的 challenges 之后这里会自动收紧"。',
  },
  {
    id: 'E5', cases: ['no-criteria（没声明挑战判据）'], field: 'warning',
    plugIs: (v) => typeof v === 'string' && v.includes('《demo/0003》') && v.includes('challenges'),
    packIs: (v) => v === null,
    插件: '显式告警（指名课次 + 修法"补判据"）',
    包侧: '无 warning（拒绝）',
    why: '同 E3：放行必告警；两种病（id 对不上 / 没写判据）两句 warning 各说各的修法。',
  },
  {
    id: 'E6', cases: ['criteria-not-met（有题没过）'], field: 'gapsRaw',
    plugIs: (v) => Array.isArray(v) && v.length === 1 && typeof v[0].hint === 'string'
      && Object.keys(v[0]).join(',') === 'no,deliverable,hint,missing',
    packIs: (v) => Array.isArray(v) && v.length === 1
      && Object.keys(v[0]).join(',') === 'no,deliverable,missing',
    插件: 'gaps[] 每项多个展示字段 hint（卡片逐条列 #编号+hint 要用）',
    包侧: 'gaps[] 每项只有 no/deliverable/missing',
    why: '字段形状的有意差异（展示增强），**判词内容不差异**：共有字段 no/deliverable/missing 与 gapText '
      + '逐字一致（另有两条断言钉住）。',
  },
  {
    id: 'E7', cases: ['criteria-not-met（有题没过）'], field: 'achievedTotal',
    plugIs: (v) => Array.isArray(v) && Number.isInteger(v[0]) && Number.isInteger(v[1]) && v[0] < v[1],
    packIs: (v) => Array.isArray(v) && v[0] === null && v[1] === null,
    插件: '带 achieved/total（卡片要写「上一课挑战未完成（3/5）」）',
    包侧: '无这两个字段',
    why: 'UI 计数字段，包侧回执不需要；口径已同源（都只算可机判的题，auto:false 不计入）。'
      + '判词本身（criteria-not-met + gaps）两边一致。',
  },
  {
    id: 'E8', cases: ['evidence-insufficient（只贴了口头确认）'], field: 'achievedTotal',
    plugIs: (v) => Array.isArray(v) && v[0] === 3 && v[1] === 3,
    packIs: (v) => Array.isArray(v) && v[0] === null && v[1] === null,
    插件: '带 achieved/total（这里 3/3：可机判的三题全过，卡住的是证据档）',
    包侧: '无这两个字段',
    why: '与 E7 同一个理由（UI 计数字段包侧不需要），但**形状不同**：证据不够时可机判的题是**全过**的'
      + '（3/3，不是部分），所以 E7 那条"achieved < total"的判据在这里不成立 —— 单开一行，'
      + '免得把 E7 的判据放宽成"只要有两个数就行"（那会让 E7 变成橡皮图章）。',
  },
]
const exemptOf = (c, field) => EXEMPT.find((e) => e.field === field && e.cases.includes(c))

/* ── 影副本 fixture：一个 maven 小项目 + 三课判据（照 test/lightup.mjs 的现成形态）──
 * `demo/0001` = 全过 + 第 4 题 auto:false（走 needsReview）；`demo/0002` = 第 2 题没过；
 * `demo/0003` = 没声明 challenges（→ 快照里 challenges:null）。
 */
const STUB_PACK = { circles: [{practice:{dirs:['code/demo'],adapters:['jvm']}}], points: 0, lessons: 3, learned: 0 }
const STATE = (tmp) => path.join(tmp, 'learning-records', 'state.json')
const PROGRESS = (tmp) => path.join(tmp, 'progress.json')
const ADJ = (tmp) => path.join(tmp, 'learning-records', 'adjustments.jsonl')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const readAdjust = (tmp) => (fs.existsSync(ADJ(tmp))
  ? fs.readFileSync(ADJ(tmp), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [])

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

/** 真包台账的指纹（本套全程只该读它） */
const hashReal = () => {
  const out = []
  const add = (p) => out.push(path.basename(p) + ':' + (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : '<缺>'))
  add(path.join(ROOT, 'learning-records', 'state.json'))
  add(path.join(ROOT, 'learning-records', 'adjustments.jsonl'))
  add(path.join(ROOT, 'progress.json'))
  add(path.join(ROOT, 'questions', 'pending.jsonl'))
  add(path.join(ROOT, 'notes', 'notes.jsonl'))
  return out.join('|')
}

const findLesson = (doc, id) => {
  for (const pr of doc.projects || []) {
    const l = (pr.lessons || []).find((x) => x && x.id === id)
    if (l) return l
  }
  return null
}

/** 把证据档判词塞进快照的那道题（两侧都读 `challenges[].evidence`，见 lib/gate.js / ask-server.js） */
const setEvidence = (doc, lesson, no, ev) => {
  const c = (findLesson(doc, lesson)?.challenges || []).find((x) => x.no === no)
  if (!c) throw new Error(`夹具里找不到 ${lesson} 第 ${no} 题`)
  c.evidence = ev
}

const CASES = [
  { name: 'no-snapshot（快照读不到）', lesson: 'demo/0001', number: 1, want: 'no-snapshot', noSnapshot: true },
  { name: 'unknown-lesson（快照里没这课）', lesson: 'demo/0009', number: 9, want: 'unknown-lesson' },
  { name: 'no-criteria（没声明挑战判据）', lesson: 'demo/0003', number: 3, want: 'no-criteria' },
  { name: 'stale-snapshot（探针版本旧）', lesson: 'demo/0001', number: 1, want: 'stale-snapshot', mutate: (d) => { d.probeVersion = 'p:OLD-PROBE-VERSION' } },
  { name: 'stale-snapshot（代码树又变了）', lesson: 'demo/0001', number: 1, want: 'stale-snapshot', mutate: (d) => { d.projects[0].sourceDigest = 'sha256:deadbeef-not-current' } },
  { name: 'criteria-not-met（有题没过）', lesson: 'demo/0002', number: 2, want: 'criteria-not-met' },
  { name: 'ok（全过；auto:false 走 needsReview）', lesson: 'demo/0001', number: 1, want: 'ok' },
  {
    name: 'ok（required 还缺：不阻塞、照实回执）', lesson: 'demo/0001', number: 1, want: 'ok',
    mutate: (d) => { findLesson(d, 'demo/0001').missing = [{ id: 'any', hint: '要有 @Demo' }] },
  },
  // ── 证据档（P0-4 戊1b，2026-09-25）：两侧同批加的**同一个分支**，所以必须在这里对拍 ──
  {
    name: 'evidence-insufficient（只贴了口头确认）', lesson: 'demo/0001', number: 1, want: 'evidence-insufficient',
    mutate: (d) => { setEvidence(d, 'demo/0001', 4, { min: 'test', have: 'verbal', haveRank: 1, needRank: 3, ok: false, hint: '第4题还差一档证据（现在只有「口头确认」）：补上 学生自己写的测试 或 运行结果 任意一档' }) },
  },
  {
    name: 'ok（证据补到档了）', lesson: 'demo/0001', number: 1, want: 'ok',
    mutate: (d) => { setEvidence(d, 'demo/0001', 4, { min: 'test', have: 'test', haveRank: 3, needRank: 3, ok: true, hint: '' }) },
  },
]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-judge-parity-'))
let child = null
const realBefore = hashReal()
const diffs = []            // 逐用例逐项：不一致就记一笔（之后必须能在豁免表里找到）
const observed = new Map()  // '用例|对比项' → { plug, pack }

try {
  fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true })
  const proj = path.join(tmp, 'code', 'demo')
  fs.mkdirSync(path.join(proj, 'src', 'main', 'java'), { recursive: true })
  fs.mkdirSync(path.join(proj, 'src', 'main', 'resources'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'src', 'main', 'java', 'HelloController.java'), [
    'package demo;', '',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.RestController;', '',
    '@RestController', '@Demo', 'public class HelloController {',
    '    @GetMapping("/hello")', '    public String hello() { return "hi"; }', '}', '',
  ].join('\n'), 'utf8')
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
          { no: 4, deliverable: '讲清楚为什么这么写', auto: false, hint: '要口头讲一遍，机器判不了', minEvidence: 'test' },
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
      { id: 'demo/0003', title: '没声明判据', required: [{ id: 'any', kind: 'annotation', value: 'Demo', hint: '要有 @Demo' }] },
    ],
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(PROGRESS(tmp), JSON.stringify({ _: '人和星图共读', learned: [], note: '别删我' }, null, 2) + '\n', 'utf8')

  // 判据快照：真走探针管线（probeState → writeState），不是手搓 JSON
  const { state } = probeState(tmp, STUB_PACK)
  writeState(tmp, state)
  const BASE_DOC = readJson(STATE(tmp))

  console.log(`\n[judge-parity] 课程包：${ROOT}\n  影副本：${tmp}`)

  /* ── 0. 夹具自检：两把新鲜度尺子必须同源（漂了后面的过期用例就没意义）────── */
  ok(PROBE_VERSION === packFp.PROBE_VERSION,
    `新鲜度第一把尺子同源：插件/包侧 PROBE_VERSION 一致（${PROBE_VERSION} / ${packFp.PROBE_VERSION}）`)
  ok(digestTree(path.join(tmp, 'code', 'demo')) === packFp.digestTree(path.join(tmp, 'code', 'demo')),
    '新鲜度第二把尺子同源：同一棵代码树，两边内容指纹一致')

  /* ── 真起包侧 ask-server（stdio:'ignore' —— 不碰管道就没有 EPERM/缓冲的坑）── */
  const port = await freePort()
  child = spawn(process.execPath, [path.join(tmp, 'tools', 'ask-server.js'), '--port', String(port)], { stdio: 'ignore' })
  const up = await waitUp(port)
  ok(up, `包侧 ask-server 在影副本里起来了（端口 ${port}）`)
  if (!up) throw new Error('ask-server 没起来，后面的判词矩阵都测不了')

  /* ── 1. 判词矩阵：同一组输入喂给两边，逐项对拍 ────────────────────────── */
  for (const c of CASES) {
    // ① 输入只写影副本（state.json / progress.json / adjustments.jsonl 每例复位）
    if (c.noSnapshot) fs.rmSync(STATE(tmp), { force: true })
    else {
      const doc = structuredClone(BASE_DOC)
      if (c.mutate) c.mutate(doc)
      fs.writeFileSync(STATE(tmp), JSON.stringify(doc, null, 2) + '\n', 'utf8')
    }
    fs.writeFileSync(PROGRESS(tmp), JSON.stringify({ _: '人和星图共读', learned: [] }, null, 2) + '\n', 'utf8')
    fs.writeFileSync(ADJ(tmp), '', 'utf8')

    // ② 插件侧：真 lib/gate.js（judgeSnapshot = 判词层；challengeGate(probe:false) = 放行层，
    //    probe:false 关掉"过期自动重判"，拿到的才是纯判定，跟包侧同口径）
    const doc = readSnapshot(tmp)
    const judge = judgeSnapshot(doc, tmp, c.lesson)
    const gate = challengeGate({
      root: tmp,
      pack: { lessons: [{ point: 'demo', number: c.number, id: c.lesson, learned: false }] },
      point: 'demo',
      probe: false,
    })

    // ③ 包侧：真 ask-server.js 子进程，HTTP 驱动（回执 = judgeLightup 的返回值）
    const res = await fetch(`http://127.0.0.1:${port}/progress`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lesson: c.lesson, done: true, adjust: 'judge-parity ' + c.name }),
    })
    const resp = await res.json()
    const rec = readAdjust(tmp).at(-1) || {}
    const packGapText = rec.gaps ?? []   // 包侧 gapText 的唯一回执通道（adjustments 的 gaps 字段）

    // ④ 逐项对拍（不一致 → 记一笔；有豁免才允许不一致）
    const field = (key, plugVal, packVal) => {
      const equal = j(plugVal) === j(packVal)
      if (!equal) { diffs.push({ case: c.name, field: key, plug: plugVal, pack: packVal }); observed.set(c.name + '|' + key, { plug: plugVal, pack: packVal }) }
      return { equal, exempt: exemptOf(c.name, key) }
    }
    const judged = (key, plugVal, packVal, label) => {
      const r = field(key, plugVal, packVal)
      ok(r.equal || !!r.exempt, label)
    }

    const plugCode = judge.code
    const packCode = resp.code ?? null
    judged('code', plugCode, packCode,
      `${c.name}：判词 code 两边一致（插件 ${show(plugCode)}${plugCode === gate.code ? '' : '/gate ' + show(gate.code)}、包侧 ${show(packCode)}）`)
    judged('ok', judge.ok, resp.ok,
      `${c.name}：ok 判定一致（插件 ${show(judge.ok)}、包侧 ${show(resp.ok)}）`)
    judged('hint', judge.hint ?? null, resp.hint ?? null,
      `${c.name}：hint 逐字一致（${show((judge.hint ?? '').slice(0, 24))}…）`)
    judged('gapText', judge.gapText ?? [], packGapText,
      `${c.name}：gapText 逐项一致（经包侧 adjustments 的 gaps 字段回读，${j(judge.gapText ?? [])}）`)
    const norm = (gs) => (Array.isArray(gs) ? gs.map((g) => ({ no: g.no, deliverable: g.deliverable, missing: g.missing })) : [])
    judged('gaps', norm(judge.gaps), norm(resp.gaps),
      `${c.name}：gaps 共有字段（no/deliverable/missing）逐项一致`)
    judged('gapsRaw', judge.gaps ?? null, resp.gaps ?? null,
      `${c.name}：gaps 原样一致（含字段形状）`)
    judged('needsReview', judge.needsReview ?? [], resp.needsReview ?? [],
      `${c.name}：needsReview 一致（${j(judge.needsReview ?? [])}）`)
    judged('requiredGaps', judge.requiredGaps ?? [], resp.requiredGaps ?? [],
      `${c.name}：requiredGaps 一致（${j(judge.requiredGaps ?? [])}）`)
    // 证据档（P0-4）：逐条"还差哪一档"两边必须逐字一致；回退开关也要一致
    judged('evidenceGaps', judge.evidenceGaps ?? [], resp.evidenceGaps ?? [],
      `${c.name}：evidenceGaps 一致（${j(judge.evidenceGaps ?? [])}）`)
    judged('evidenceFallback', judge.evidenceFallback ?? false, resp.evidenceFallback ?? false,
      `${c.name}：evidenceFallback 一致（${show(judge.evidenceFallback ?? false)}）`)
    judged('achievedTotal', [judge.achieved ?? null, judge.total ?? null], [resp.achieved ?? null, resp.total ?? null],
      `${c.name}：achieved/total 一致（${j([judge.achieved ?? null, judge.total ?? null])}）`)

    // ⑤ 三元组：code × allowed × warning（放行层）
    //    包侧的"放行"看**真实写盘点**（progress.json 的 learned 里有没有这一课）——
    //    不看回执的 `lit`：那是 learned **计数**（out.lit = p.learned.length），不是布尔。
    const plugAllowed = gate.allowed === true
    const packWrite = (readJson(PROGRESS(tmp)).learned || []).includes(c.lesson)
    ok(packWrite === (resp.ok === true),
      `${c.name}：包侧写盘点与判词自洽（learned 含本课 = ${show(packWrite)}、ok = ${show(resp.ok)}）`)
    ok(resp.lit === (readJson(PROGRESS(tmp)).learned || []).length,
      `${c.name}：包侧回执 lit = learned 计数（${show(resp.lit)}，不是布尔）`)
    // 判据 ②（P0-4 戊1b）：**只落 `kind:"verbal"`（口头确认）时点亮必须失败**。
    // 这里验的是**真写盘点**（progress.json 的 learned 里没有这一课），不是回执字段。
    if (c.want === 'evidence-insufficient') {
      ok(packWrite === false && resp.ok === false,
        `${c.name}：**点亮必须失败**（判据 ②：只贴口头确认不算过）—— learned 里没有这一课、ok:false`)
    }
    const ra = field('allowed', plugAllowed, packWrite)
    ok(ra.equal || !!ra.exempt,
      `${c.name}：三元组② allowed 两边一致（插件 ${show(plugAllowed)}、包侧 ${show(packWrite)}）`)
    const plugWarn = gate.warning ?? null
    const packWarn = resp.warning ?? null
    const rw = field('warning', plugWarn, packWarn)
    const warnOK = (plugWarn === null && packWarn === null)   // 同判词下：放行不带告警、拒绝也不带告警
    const warnExemptOK = !!rw.exempt && packWarn === null && packWrite === false
      && typeof plugWarn === 'string' && plugWarn.includes('《' + c.lesson + '》')
    ok((rw.equal && warnOK) || warnExemptOK,
      `${c.name}：三元组③ warning（插件 ${show(String(plugWarn).slice(0, 30))}、包侧 ${show(packWarn)}）`)

    // ⑥ 用例必须真落在目标判词上（防"夹具漂了、两边同错还全绿"）
    ok(judge.code === c.want && (c.want === 'ok' ? resp.ok === true : resp.code === c.want),
      `${c.name}：用例确实落在目标判词 ${c.want}（插件 ${show(judge.code)}、包侧 ${show(resp.code)}）`)
  }

  /* ── 2. 豁免表反向核账：登记的差异必须真存在；出现的差异必须都登记 ─────── */
  for (const e of EXEMPT) {
    const every = e.cases.every((cn) => {
      const got = observed.get(cn + '|' + e.field)
      return !!got && e.plugIs(got.plug) && e.packIs(got.pack)
    })
    ok(every,
      `豁免 ${e.id} 仍成立（${e.cases.join(' / ')} × ${e.field}：插件 ${e.插件}、包侧 ${e.包侧}）—— 两边行为变了就重新裁定这行`)
  }
  const unregistered = diffs.filter((d) => !exemptOf(d.case, d.field))
  ok(unregistered.length === 0,
    `没有未登记的差异（裸漂移）：${unregistered.length ? unregistered.map((d) => d.case + '/' + d.field).join('、') : '所有不一致都落在豁免表里'}`)

  /* ── 3. 真包一字节没动 ─────────────────────────────────────────────── */
  ok(hashReal() === realBefore, '真包台账（state/adjustments/progress/questions/notes）一字节没动')
  ok(fs.existsSync(path.join(ROOT, 'presets', 'whale-sensei.css')), '真包仍在原地（课程包根没被写坏）')
} finally {
  if (child && !child.killed) { try { child.kill() } catch { /* 已退 */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 判词表对拍：六个判词 × 两侧实现逐项一致，有意不同的部分都写在豁免表里并钉死')
