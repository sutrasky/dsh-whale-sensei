/**
 * ask-route.mjs —— 课程疑问（提交 + 拉取）验收
 *
 * 分两层验，**说清哪层没被验**：
 *   A. 模块层（本文件）：校验 / 序号 / 入队 / 拉取 / 路由形状 —— 全部可确定地验
 *   B. 栅栏层（**本文件验不了，必须现场验**）：跨站 403 / 未认证 401 是**基座**做的
 *      （dsh-client-connection 的 /api prefix 路由先调 requestRejection 再过桥）。
 *      所以这里只验「我们挂的位置对」（/api 前缀下 + 精确 methods），
 *      真正的坏样本请求留到重启后用 HTTP 打 —— 不拿假 connection 冒充基座 ✗
 *
 * 判据：
 *   ① 合法 POST → 200 { ok:true, id:"0001" }，pending.jsonl 恰好多一行，seq.txt = 1
 *   ② 三条坏样本（非 JSON / 空 question / 超 16KB）→ 400/400/413，且**队列与序号一动不动**
 *   ③ GET 拉取与文件逐字段一致；坏行**不静默吞掉**（出现在 errors 里）
 *   ④ 路由形状符合基座 assertFetchRoute：path 在 /api 下、methods 精确不重复、requestBody 显式
 *   ⑤ 宿主没有 connection 能力时不抛错（只 warn，工具面仍可用）
 *   ⑥ 路由处理器：合法 POST 200、GET 拉取、非 GET/POST 405、缺 packRoot 503、**响应里不许有 CORS 头**
 *   ⑦ 真包全程未被改动（questions/ 全树 + assets/ask.js 哈希）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { handleAsk, readQueue, askPaths, readSeq, lookupAnswer, loadLedger } from '../lib/ask-io.js'
import { ASK_MAX_BYTES, parseAskBody } from '../lib/ask.js'
import { plugin as askPlugin } from '../lib/mods/ask.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
function hashTree(dir) {
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
const realBefore = hashTree(path.join(ROOT, 'questions')) + '||' + sha(fs.readFileSync(path.join(ROOT, 'assets', 'ask.js')))

const BODY = { question: '为什么 @RestController 能直接返回 JSON？', lesson: 'spring-boot/0001', page: 'lessons/programming/spring-boot/0001-spring-boot-hello-world.html', title: '第1课' }
const CLOCK = () => '2026-01-01T00:00:00.000Z' // 时钟注入 → 产物可对拍

console.log(`\n[ask] 课程包：${ROOT}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ask-'))
try {
  const P = askPaths(tmp)

  // ── ① 合法提交 ──
  const r1 = await handleAsk(tmp, { raw: JSON.stringify(BODY), now: CLOCK })
  ok(r1.status === 200 && r1.body.ok === true && r1.body.id === '0001', `合法 POST → 200 { ok:true, id:"${r1.body.id}" }`)
  const lines1 = fs.readFileSync(P.pending, 'utf8').split('\n').filter((l) => l.trim())
  ok(lines1.length === 1, `pending.jsonl 恰好多一行（${lines1.length} 行）`)
  const rec = JSON.parse(lines1[0])
  ok(
    rec.id === '0001' && rec.at === '2026-01-01T00:00:00.000Z' && rec.lesson === BODY.lesson && rec.question === BODY.question && rec.status === 'pending',
    `入队记录逐字段对（id/at/lesson/question/status），键序 ${Object.keys(rec).join(',')}`
  )
  ok(readSeq(tmp) === '1', `seq.txt 递增到 1（实得 "${readSeq(tmp)}"）`)

  // ── ② 坏样本：三条，队列与序号必须一动不动 ──
  const frozen = fs.readFileSync(P.pending, 'utf8') + '|' + readSeq(tmp)
  const BADS = [
    ['不是 JSON', 'not json at all', 400, 'JSON 解析失败'],
    ['question 为空', JSON.stringify({ question: '   ' }), 400, '疑问内容为空'],
    ['超过 16KB', JSON.stringify({ question: '很'.repeat(ASK_MAX_BYTES) }), 413, '问题太长了，请精简到 16KB 以内'],
  ]
  for (const [name, raw, wantStatus, wantErr] of BADS) {
    const r = await handleAsk(tmp, { raw, now: CLOCK })
    ok(r.status === wantStatus && r.body.ok === false && r.body.error === wantErr, `坏样本「${name}」→ ${r.status} ${r.body.error}`)
  }
  ok(fs.readFileSync(P.pending, 'utf8') + '|' + readSeq(tmp) === frozen, '三条坏样本之后：队列内容与序号**一字未动**（没有半行垃圾、没有空跳号）')
  ok(parseAskBody('x'.repeat(ASK_MAX_BYTES + 1)).status === 413, '超长判定按**字节**算（中文一字 3 字节，用字符数会判宽）')

  // ── ③ 拉取：与文件一致 + 坏行不静默吞掉 ──
  const r2 = await handleAsk(tmp, { raw: JSON.stringify({ ...BODY, question: '第二条' }), now: CLOCK })
  ok(r2.body.id === '0002', `第二条拿到 0002（不重号）`)
  fs.appendFileSync(P.pending, '这不是 JSON\n', 'utf8')
  const q = readQueue(tmp)
  ok(q.status === 200 && q.body.count === 2 && q.body.pending[1].id === '0002', `GET 拉到 ${q.body.count} 条，逐字段与文件一致`)
  ok(q.body.errors.length === 1 && q.body.errors[0].line === 3, `坏行出现在 errors 里（第 ${q.body.errors?.[0]?.line} 行）—— 不静默吞掉`)

  // ── ③b BOM：PowerShell 建/追加的文件会带 \uFEFF（课程包自己的 drain / ask-watch 都专门剥它）。
  //        队列读取不剥的话，**真实场景里第一条问题会"在队列里找不到"** ✗（现场踩过）──
  fs.appendFileSync(P.pending, '\uFEFF' + JSON.stringify({ id: '0003', question: '带 BOM 的第三行' }) + '\n', 'utf8')
  const q2 = readQueue(tmp)
  ok(q2.body.pending.some((e) => e.id === '0003'), '带 BOM 的那行仍解析成条目（不因 BOM 变成坏行）')
  ok(q2.body.errors.length === 1 && q2.body.pending.length === 3, `BOM 只影响那一行、不牵连别的（条目 ${q2.body.pending.length} / 坏行 ${q2.body.errors.length}）`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ④⑤⑥ 路由形状 + 处理器（用假 connection 捕获，只验"挂对了地方"）──
const captured = []
const warns = []
const tools = []
const mkCtx = (packRoot, withInject = true) => {
  const ctx = {
    paths: { packRoot },
    log: { info: () => {}, warn: (m) => warns.push(m), error: (m) => warns.push('E:' + m) },
    registerTool: (d) => tools.push(d),
  }
  if (withInject) {
    // ⚠️ 假件要**按服务名路由**，别假设"只软依赖某几个"：
    //    本模块先后加过 jobs（原生监听）—— 写死假设会让这条测试在无关改动后变红 ✗（踩过两次）
    const KNOWN = ['connection', 'jobs']
    ctx.inject = (names, cb) => {
      ok(names.every((n) => KNOWN.includes(n)), `软依赖都是已知服务（实得 ${names.join('、')}）`)
      if (names.includes('connection')) cb({ get: () => ({ fetch: { register: (r) => captured.push(r) } }) })
      if (names.includes('jobs')) cb({ jobs: { start: () => 'job-fake' } })
    }
  }
  return ctx
}

askPlugin.install(mkCtx(ROOT))
// ⚠️ 按 path 选，别用 captured[0] / captured[last]：本模块现在挂**两条**路由
//    （/api/whale/ask 与 /api/whale/answer），拿错位置就会去测另一条 ✗
const pick = (p) => captured.filter((r) => r.path === p)
ok(pick('/api/whale/ask').length === 1, `挂了 /api/whale/ask 这一条（本模块共 ${captured.length} 条）`)
const route = pick('/api/whale/ask')[0]
ok(typeof route.path === 'string' && route.path.startsWith('/api/'), `路由在 /api 前缀下（${route.path}）—— 基座只挂 /api，别处不会被栅栏罩住`)
ok(route.path !== '/api', '没有占用基座保留的 /api 本身')
ok(Array.isArray(route.methods) && route.methods.length > 0 && new Set(route.methods).size === route.methods.length, `methods 非空且不重复（${route.methods.join(',')}）`)
ok(route.requestBody === 'buffered', `显式声明 requestBody=buffered（不写的话基座不缓冲请求体）`)
ok(route.methods.includes('POST') && route.methods.includes('GET'), 'POST（提交）与 GET（拉取）都在')

// 处理器：拿影子包当 root
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ask-route-'))
try {
  askPlugin.install(mkCtx(tmp2))
  const h = pick('/api/whale/ask').pop().fetch
  const post = await h(new Request('http://127.0.0.1:3090/api/whale/ask', { method: 'POST', body: JSON.stringify(BODY), headers: { 'content-type': 'application/json' } }))
  const postBody = await post.json()
  ok(post.status === 200 && postBody.ok === true && postBody.id === '0001', `路由处理器：POST → ${post.status} { ok:true, id:"${postBody.id}" }`)
  ok(!post.headers.get('access-control-allow-origin'), '响应里**没有** CORS 允许头（旧 ask-server 放行 * ✗，栅栏归基座）')
  const get = await h(new Request('http://127.0.0.1:3090/api/whale/ask', { method: 'GET' }))
  const getBody = await get.json()
  ok(get.status === 200 && getBody.count === 1, `路由处理器：GET → ${get.status} count=${getBody.count}`)
  const put = await h(new Request('http://127.0.0.1:3090/api/whale/ask', { method: 'PUT' }))
  ok(put.status === 405, `路由处理器：PUT → ${put.status}（只接受 GET/POST）`)
  // 就地反馈（P1-8）：带 ?id= 的 GET 走「查这一条答了没」那条读口（影子包没台账 ⇒ 如实说不，不报错）
  const got = await h(new Request('http://127.0.0.1:3090/api/whale/ask?id=9999', { method: 'GET' }))
  const gotBody = await got.json()
  ok(got.status === 200 && gotBody.answered === false, `路由处理器：GET ?id=9999 → ${got.status} answered=${gotBody.answered}（就地反馈的读口）`)
} finally {
  fs.rmSync(tmp2, { recursive: true, force: true })
}

// 专门装一个"没配 packRoot"的实例来验 503（先前那条 captured 是影子包的，别拿错）
askPlugin.install(mkCtx(undefined))
const noRoot = await pick('/api/whale/ask').pop().fetch(new Request('http://127.0.0.1/api/whale/ask', { method: 'GET' }))
const noRootBody = await noRoot.json()
ok(noRoot.status === 503 && /packRoot/.test(noRootBody.error || ''), `没配 packRoot → ${noRoot.status} ${noRootBody.error || ''}（明确报错，不猜 cwd）`)

const before = warns.length
askPlugin.install(mkCtx(ROOT, false))
ok(warns.length > before && !warns.slice(before).some((w) => w.startsWith('E:')), `宿主没有 connection 能力时只 warn 不抛（${warns.slice(before)[0] || ''}）`)

// ── ⑥ 工具面 ──
const tool = tools.find((t) => t.name === 'whale_ask')
ok(!!tool, 'whale_ask 装得上')
const listed = await tool.execute({ root: ROOT })
ok(listed.ok === true && typeof listed.summary === 'string', `whale_ask list（真包，只读）：${listed.summary}`)
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ask-tool-'))
try {
  const sub = await tool.execute({ root: tmp3, action: 'submit', question: '工具提交的一条', lesson: 'spring-boot/0002' })
  ok(sub.ok === true && sub.summary.includes('#0001'), `whale_ask submit → ${sub.summary}`)
  ok(JSON.parse(fs.readFileSync(askPaths(tmp3).pending, 'utf8').trim()).question === '工具提交的一条', '工具提交的内容确实落进了队列')
} finally {
  fs.rmSync(tmp3, { recursive: true, force: true })
}

// ── ⑥c 就地反馈（P1-8）：按 id 查「答了没」—— 页面交完疑问后轮询它，答好了推回那一屏 ──
{
  const ledger = loadLedger(ROOT)
  const answeredId = Object.keys(ledger).find((k) => ledger[k]?.status === 'answered' && (ledger[k].answerHtml || ledger[k].answer))
  ok(Boolean(answeredId), `真包台账里有已答条目（拿它当真值：${answeredId || '无'}）`)
  if (answeredId) {
    const r = lookupAnswer(ROOT, { id: answeredId })
    ok(r.status === 200 && r.body.answered === true && Boolean(r.body.answerHtml),
      `lookupAnswer(已答 ${answeredId}) → answered:true 且带回 answerHtml（页面能就地显示）`)
  }
  const never = lookupAnswer(ROOT, { id: '9999' })
  ok(never.status === 200 && never.body.answered === false, 'lookupAnswer(没答过的编号) → answered:false（**不编**）')
  const bad = lookupAnswer(ROOT, { id: 'abc' })
  ok(bad.status === 400 && /四位编号/.test(bad.body.error || ''), `lookupAnswer(坏 id) → ${bad.status} ${bad.body.error || ''}`)
}

// ── ⑥d agent 侧话术（P1-8 判据④）：答复正文**不贴全文**，只给清单与指针 ──
ok(/清单与指针/.test(tool.description || '') && /不要贴进对话/.test(tool.description || ''),
  '工具描述里写死「答复正文不要贴进对话、只给清单与指针」（正文贴全文既吃 token 又会被压缩损耗）')

// ── ⑦ 真包没被动过 ──
const realAfter = hashTree(path.join(ROOT, 'questions')) + '||' + sha(fs.readFileSync(path.join(ROOT, 'assets', 'ask.js')))
ok(realAfter === realBefore, '真包全程未被改动（questions/ 全树 + assets/ask.js 哈希相同）')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 疑问队列：校验/序号/入队/拉取都对，坏样本一动不动；栅栏留给现场验（基座管）')
