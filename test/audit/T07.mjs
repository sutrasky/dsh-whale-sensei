#!/usr/bin/env node
/**
 * T07.mjs —— 独立服务授权并隔离管理台与课件（报告 D02 / P1）
 * ==================================================================
 * 验收判据（**原文**，见 cards/T07.md 与 cards/T07-R1.md）：
 *   「evil/null origin、简单表单、text/plain 均在无权限时 **403 且树不变**；正常管理页仍能操作。
 *     **本次没用真实浏览器验证 PNA/LNA 是否提前拦截，不宣称所有浏览器都可被跨站攻击。**」
 *
 * 怎么做才算「不是嘴上说」：
 *   - **真驱动生产入口**：把仓内模板整棵拷进临时副本（仓里 `package.json` 是 `type: module`，
 *     直接 require 那份 `.js` 会被当成 ESM —— 副本带一份 `{"type":"commonjs"}`），再
 *     `require` 副本里的 `tools/ask-server.js` / `tools/app-server.js` / `tools/http-security.cjs`，
 *     并用**真 HTTP**（`http.createServer(handler)` + `http.request`）打每一批请求 ——
 *     不看返回值猜，看**响应字节**与**盘上的树**。
 *   - **负向控制**：在自建临时副本上跑**基线实现**（`ba22c94` 的 `ask-server.js` /
 *     `offline-server.js`），留下它**真的**被 `Origin: http://evil.test` + `text/plain` 的
 *     `/ask` 击穿（200 且 `questions/pending.jsonl` 真的多了一条）、被无体跨源
 *     `POST /api/clear` 击穿（200 且课程库真的进了 `.trash`）的原始输出；
 *     再证明新实现对同一批输入 **403 且树逐字节不变**。
 *   - **正例必须真过**（防止靠"全拒绝"通过）：合法管理（开会话 / 打开 / 重建 / 导入 / 迁移 / 清库）
 *     与合法学生面（提问 / 笔记 / 进度）都要**真成功**。
 *   - **分账**：服务端 handler 的判据在本文件里跑；**真实浏览器**侧（PNA/LNA 是否提前拦截、
 *     恶意表单在真浏览器里长什么样）本卡**没有**做 —— 如实记成「未验证」，
 *     不用假浏览器测试冒充（见 `T07-BROWSER-not-verified-recorded`）。
 *
 * ⚠️ 覆盖边界（如实写出来，不冒充）：
 *   · **真实浏览器**：本机没有可驱动的浏览器会话 ⇒ 跨站恶意 Origin / 简单表单的
 *     "浏览器侧"证据缺失。卡面明说本次不验证 PNA/LNA，所以这里只记「未验证」。
 *   · **`file://` 那条路**：默认**拒**（不盲信 `null`）；显式开 `--allow-file-origin` 之后
 *     仍然要求 `Sec-Fetch-Mode: cors`（简单表单是 `navigate`）。开关本身由判据证明。
 *   · **`/evidence`（实践区贴证据）**：那条路由住在**插件**侧（`/api/whale/evidence`），
 *     不在本卡的三个独立服务里 —— 本卡不碰它（不在落点）。
 *   · **管理确认（`confirm:true`）落在哪**：`/api/import`（写课程库，query 确认，因为体是原始
 *     zip 字节）与 `/api/migrate`（`applyLegacyMigration` 的 confirm + planDigest 两道闸）。
 *     `/api/open` `/api/rebuild` `/api/remove` `/api/clear` **不额外要 confirm** ——
 *     它们的 id / 固定库语义与界面上的 `window.confirm` 守着；**若在这里要 confirm**，
 *     同一个非法 id 会因为"没带确认"从 400 变成 403，把 T05 的 id 判据语义挪走
 *     （实测踩到：`T05-ID-http-remove-400`）。管理能力本身仍由 **admin 作用域**把守。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T07.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 接口 / 单一实现 / 运行态秘密
  'T07-CAP-single-source',
  'T07-CAP-no-cors-as-authorization',
  'T07-CAP-session-endpoint-issues-token',
  'T07-CAP-token-bound-to-origin-scope-pack',
  'T07-CAP-runtime-secret-private-or-refuse',
  // ② 分源与作用域：课件源换不到管理能力
  'T07-ISOLATE-reader-cannot-call-admin',
  'T07-ISOLATE-admin-capability-not-in-pack-artifacts',
  'T07-ADMIN-html-from-trusted-install-resource',
  // ③ 正例：合法管理操作真成功
  'T07-ALLOW-admin-session',
  'T07-ALLOW-admin-open',
  'T07-ALLOW-admin-rebuild',
  'T07-ALLOW-admin-import',
  'T07-ALLOW-admin-migrate',
  'T07-ALLOW-admin-clear',
  // ④ 正例：合法学生面真成功
  'T07-ALLOW-student-ask',
  'T07-ALLOW-student-note',
  'T07-ALLOW-student-progress',
  // ⑤ 拒绝面：无权限 403 且树不变
  'T07-REJECT-evil-origin-simple-form',
  'T07-REJECT-evil-origin-text-plain',
  'T07-REJECT-null-origin',
  'T07-REJECT-missing-capability',
  'T07-REJECT-wrong-scope-token',
  'T07-REJECT-wrong-origin-token',
  'T07-REJECT-wrong-pack-token',
  'T07-REJECT-tampered-token',
  'T07-REJECT-expired-token',
  'T07-REJECT-bad-host-dns-rebinding',
  'T07-REJECT-file-origin-opt-in-only',
  'T07-REJECT-admin-write-no-capability',
  'T07-REJECT-no-side-effect-tree-unchanged',
  // ⑥ 负向控制：旧实现真被击穿（原始输出留证）
  'T07-NEGCTRL-baseline-ask-evil-origin',
  'T07-NEGCTRL-baseline-ask-null-origin-text-plain',
  'T07-NEGCTRL-baseline-clear-no-body',
  'T07-NEGCTRL-old-vs-new-diff',
  // ⑦ 回归与夹具纪律 / 分账
  'T07-REG-t03-t04-t05-t06-still-green',
  'T07-REG-selftest-still-passes',
  'T07-BROWSER-not-verified-recorded',
  'T07-FIXTURE-cleanup-guard',
]

/** 基线 commit（cards/T07.md 钉的那一个）—— 负向控制取它的两个服务 */
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
const REL_ASK = 'lib/pack-template/tools/ask-server.js'
const REL_OFFLINE = 'lib/pack-template/tools/offline-server.js'
const REL_SECURITY = 'lib/pack-template/tools/http-security.cjs'
const REL_ADMIN_HTML = 'lib/pack-template/tools/offline-admin.html'
const REL_SESSION_JS = 'lib/pack-template/assets/session.js'
const REL_FRAME = 'lib/pack-template/assets/_frame.html'
const NODE = process.execPath
const require_ = createRequire(import.meta.url)

/** canary：写盘成功的证据串（命中即"副作用真的发生了"） */
const CANARY = {
  ask: 'T07-CANARY-ASK-4f1c9d',
  note: 'T07-CANARY-NOTE-7b2e35',
  library: 'T07-CANARY-LIBRARY-1a6d08',
  adjust: 'T07-CANARY-ADJUST-3e5b71',
}
const ALL_CANARIES = Object.values(CANARY)

const h = createHarness({ card: 'T07', expectedIds: EXPECTED_IDS, root: REPO })
const CASE_DIR = path.join(REPO, 'audit-evidence', 'T07', 'cases')
fs.mkdirSync(CASE_DIR, { recursive: true })

/**
 * **第二个可信来源**（`http://127.0.0.1:9`）。
 *
 * 为什么要它：`CAP_WRONG_ORIGIN` 判的是"令牌是发给 A 的、请求来自 B"——
 * 只有**A 与 B 都可信**时这条分支才走得到（B 不可信会先在来源那一关被拒成
 * `ORIGIN_UNTRUSTED`，那测的是另一条）。所以把 `http://127.0.0.1:9` 放进
 * `WHALE_TRUSTED_ORIGIN`（`http-security.cjs` 认这个环境变量，与 `--origin=` 同一份口径）。
 *
 * ⚠️ 必须在 `require` 新实现**之前**设好：`ask-server.js` 在模块加载时建能力集。
 *    本进程是判据自己的进程，改完就地还原（不污染后续子进程）。
 */
const SECOND_ORIGIN = 'http://127.0.0.1:9'
const PREV_TRUSTED_ORIGIN = process.env.WHALE_TRUSTED_ORIGIN
process.env.WHALE_TRUSTED_ORIGIN = [PREV_TRUSTED_ORIGIN || '', SECOND_ORIGIN].filter(Boolean).join(',')

const SANDBOX = makeTempDir('t07')
const W = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8') }
const WJ = (file, obj) => W(file, `${JSON.stringify(obj, null, 2)}\n`)
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const both = (r) => String(r?.out ?? '') + String(r?.err ?? '')

/** 落一份子进程的**完整原始输出** */
function keepEvidence(id, r, extra = {}) {
  const text = [
    `# ${id}`,
    `exit=${r && r.code === null ? 'null(无退出码/崩溃)' : (r ? r.code : 'n/a')} timedOut=${r ? r.timedOut : 'n/a'} ms=${r ? r.ms : 'n/a'}`,
    `spawnError=${(r && r.spawnError) || 'none'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    '--- stdout ---',
    String(r?.out ?? ''),
    '--- stderr ---',
    String(r?.err ?? ''),
    '',
  ].join('\n')
  h.evidence(path.join('cases', `${id}.txt`), clip(text, 60000))
}

/** 整棵树快照（内容 + 存在性）—— 比"返回值"硬 */
function snapTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { out.push(`${r}|dir`); walk(abs, r) } else {
        let digest = 'unreadable'
        try { digest = sha(fs.readFileSync(abs)).slice(0, 16) } catch { /* 读不动如实标 */ }
        out.push(`${r}|file|${digest}`)
      }
    }
  }
  walk(root, '')
  return out.join('\n')
}

/* ================================================================ 夹具：新 / 基线两套副本 */

const NEW_DIR = path.join(SANDBOX, 'new')
const BASE_DIR = path.join(SANDBOX, 'base')
const PACK = path.join(NEW_DIR, 'whale-pack')
const PACK_BASE = path.join(BASE_DIR, 'whale-pack')
const LIB_ADMIN = path.join(SANDBOX, 'lib-admin')
const LIB_MIGRATE = path.join(SANDBOX, 'lib-migrate')
const LIB_IMPORT = path.join(SANDBOX, 'lib-import')
const LIB_BASE = path.join(SANDBOX, 'lib-base')
const LIB_CLEARED = path.join(SANDBOX, 'lib-cleared')      // 基线负向控制用（库会被移走）
const LIB_CLEAR_OK = path.join(SANDBOX, 'lib-clear-ok')    // 新实现的正例用（单独一条库）

/** 铺一个"形状完整"的课程包（模板整棵 + CJS package.json + 空台账） */
function layPack(root) {
  fs.cpSync(path.join(REPO, 'lib', 'pack-template'), root, { recursive: true })
  W(path.join(root, 'package.json'), '{"type":"commonjs"}\n')
  W(path.join(root, 'questions', 'pending.jsonl'), '')
  W(path.join(root, 'questions', 'seq.txt'), '0\n')
  W(path.join(root, 'notes', 'notes.jsonl'), '')
  W(path.join(root, 'notes', 'seq.txt'), '0\n')
  W(path.join(root, 'learning-records', 'adjustments.jsonl'), '')
  WJ(path.join(root, 'progress.json'), { v: 1, learned: [] })
  WJ(path.join(root, 'lessons', 'lessons.json'), {
    v: 1, source: 'lessons/src',
    lessons: [{ rel: 'demo/alpha/0001-hello.html', title: '演示课', number: 1, halo: 'demo', point: 'alpha', slug: 'hello' }],
  })
  W(path.join(root, 'lessons', 'demo', 'alpha', '0001-hello.html'),
    '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>演示课</title></head>\n<body><h1>演示课</h1></body></html>\n')
  // 课次映射表（`lesson-map.js`）扫的是 `lessons/<圈>/<点>/point.json` —— 没有它，
  // `/note` 会把锚点判成"孤儿锚点"（实测：现有锚点集合是空的）
  W(path.join(root, 'lessons', 'demo', 'halo.json'), JSON.stringify({ halo: 'demo', name: '演示圈', color: '#fff6e2' }, null, 2) + '\n')
  W(path.join(root, 'lessons', 'demo', 'alpha', 'point.json'), JSON.stringify({ point: 'alpha', name: '演示点', fileBase: 0 }, null, 2) + '\n')
  // ⚠️ `byKey` 只从 **EXPECT.json 声明过的**课次长出来（`lessons/**` 里没声明的会进 conflicts，
  //    但**不进** byKey）—— 少了它，`/note` 的锚点解析不到（实测"现有："是空的）。
  WJ(path.join(root, 'code', 'demo', 'EXPECT.json'), {
    project: 'demo',
    lessons: [{ id: 'alpha/0001', title: '演示课' }],
  })
  return root
}

/** 铺一个最小课程库（唯一课程库 = `<lib>/library`）——
 *  ⚠️ 用**模板自己的骨架**（`initSkeleton`）铺：`/api/open` 要库里有 `tools/app-server.js`、
 *     `/api/rebuild` 要库里有重建链的五个脚本 —— 手搓一个"只有课"的目录测不到正例。 */
function layLibrary(lib, opts = {}) {
  const dir = path.join(lib, 'library')
  const skeleton = require_(path.join(PACK, 'tools', 'offline-bootstrap.js'))
  fs.mkdirSync(dir, { recursive: true })
  const s = skeleton.initSkeleton(dir, { src: PACK, refreshTools: true })
  if (!s.ok) throw new Error(`夹具：骨架铺不进 ${dir}（${s.error}）`)
  WJ(path.join(dir, 'lessons', 'lessons.json'), {
    v: 1, source: 'lessons/src',
    lessons: [{ rel: 'demo/alpha/0001-hello.html', title: '库里的演示课', number: 1, halo: 'demo', point: 'alpha', slug: 'hello' }],
  })
  W(path.join(dir, 'lessons', 'demo', 'halo.json'), JSON.stringify({ halo: 'demo', name: '演示圈', color: '#fff6e2' }, null, 2) + '\n')
  W(path.join(dir, 'lessons', 'demo', 'alpha', 'point.json'), JSON.stringify({ point: 'alpha', name: '演示点', fileBase: 0 }, null, 2) + '\n')
  W(path.join(dir, 'lessons', 'demo', 'alpha', '0001-hello.html'),
    '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>库里的演示课</title></head><body><h1>库里的演示课</h1></body></html>\n')
  // 课程库自带的**管理页**（不可信件）：骨架把它从模板拷进库里，这里**改写成 canary** ——
  // 管理页必须由**受信安装资源**（跑 offline-server 那个目录）提供，课程库自带那份一个字节都不许出网。
  W(path.join(dir, 'tools', 'offline-admin.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LIBRARY-ADMIN-CANARY</title></head>\n<body>${CANARY.library}</body></html>\n`)
  if (opts.legacy) {
    const old = path.join(lib, 'old-pack')
    W(path.join(old, 'lessons', 'demo', 'alpha', '0001-old.html'), '<p>旧包的一课</p>\n')
    WJ(path.join(old, 'lessons', 'lessons.json'), {
      v: 1, source: 'lessons/src',
      lessons: [{ rel: 'demo/alpha/0001-old.html', title: '旧包的一课', number: 1 }],
    })
  }
  return dir
}

/** 最小合法 zip（只用 STORE，不压缩）：pack.json + lessons/lessons.json + 一课 */
function makeZip(entries) {
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    // ⚠️ 中央目录里的偏移是**本地头在整份 zip 里的字节位置**：`offset` 必须在 push 之后、
    //    加上这一条自己的长度**之前**取（写反了 helper 会报「Int64 无法容纳中央目录偏移量」）。
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

// ================================================================ 现场准备
let FIX = null
try {
  layPack(PACK)
  layPack(PACK_BASE)
  for (const [rel, dest] of [[REL_ASK, 'ask-server.js'], [REL_OFFLINE, 'offline-server.js']]) {
    const r = runChild(['git', '-C', REPO, 'show', `${BASE_COMMIT}:${rel}`], { cwd: REPO, timeoutMs: 60000 })
    if (r.code !== 0 || !String(r.out).trim()) throw new Error(`git show ${BASE_COMMIT}:${rel} 失败（exit=${r.code}）：${clip(both(r), 300)}`)
    W(path.join(PACK_BASE, 'tools', dest), r.out)
  }
  const same = [[REL_ASK, 'ask-server.js'], [REL_OFFLINE, 'offline-server.js']].filter(([rel, dest]) => {
    const a = fs.readFileSync(path.join(REPO, rel), 'utf8')
    const b = fs.readFileSync(path.join(PACK_BASE, 'tools', dest), 'utf8')
    return a === b
  })
  if (same.length) throw new Error(`基线副本与当前实现逐字节相同（负向控制会打空）：${same.map(([r]) => r).join('、')}`)
  for (const lib of [LIB_ADMIN, LIB_MIGRATE, LIB_IMPORT, LIB_BASE, LIB_CLEARED, LIB_CLEAR_OK]) fs.mkdirSync(lib, { recursive: true })
  layLibrary(LIB_ADMIN)
  layLibrary(LIB_MIGRATE, { legacy: true })
  layLibrary(LIB_IMPORT)
  layLibrary(LIB_BASE)
  layLibrary(LIB_CLEARED)
  layLibrary(LIB_CLEAR_OK)
  FIX = { ok: true, baseCommit: BASE_COMMIT }
} catch (e) {
  FIX = { ok: false, error: `${e && e.message ? e.message : e}` }
}
if (!FIX.ok) h.block(`夹具 / 基线副本建不起来：${FIX.error}`)
const need = () => { if (!FIX.ok) throw new Error(`夹具没就绪：${FIX.error}`) }

// ================================================================ require 新实现（副本里的 CJS）
let NEW_APP = null
let SEC = null
try { NEW_APP = require_(path.join(PACK, 'tools', 'app-server.js')) } catch (e) { h.block(`require 副本里的 tools/app-server.js（新实现）失败：${e && e.message ? e.message : e}`) }
try { SEC = require_(path.join(PACK, 'tools', 'http-security.cjs')) } catch (e) { h.block(`require 副本里的 tools/http-security.cjs 失败：${e && e.message ? e.message : e}`) }

/* ⚠️ 两个 offline-server **不在这里 require**：它们读的是**进程级**的 `WHALE_LIB`
      （`resolveLib()` 在模块加载时算一次）—— 一个进程里 require 两次会共用同一份 `LIB`。
      所以它们由**各自的子进程**驱动（见 `runOfflineDriver`），每个子进程一个库。 */

/* ================================================================ 真 HTTP 驱动（新实现，同进程） */

/**
 * 起一次真服务、跑一段**共用同一个端口**的请求，收走。
 *
 * ⚠️ 必须共用端口：能力令牌**绑来源**，而来源就是"本次服务的那个端口" ——
 * 每批各起一个服务会让"这批拿的令牌去那批用"必然 403（那测的是错配，不是正例）。
 *
 * @param {Function} handler
 * @param {(port:number, origin:string) => Promise<any>} body 在服务起好之后跑
 */
function withServer(handler, body) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    let done = false
    const finish = (v) => { if (done) return; done = true; try { srv.close(() => resolve(v)) } catch { resolve(v) } }
    srv.on('error', (e) => finish({ error: `server:${e && e.message ? e.message : e}`, rows: [] }))
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port
      try {
        const out = await body(port, `http://127.0.0.1:${port}`)
        finish({ ...out, port })
      } catch (e) {
        finish({ error: `body:${e && e.message ? e.message : e}`, rows: [], port })
      }
    })
  })
}

/** 打一批请求（**共用 `port`**）；回 rows（每行带 `req`） */
function requestBatch(port, reqs) {
  const rows = []
  return reqs.reduce((chain, r) => chain.then(() => new Promise((res) => {
    let req
    try {
      req = http.request({
        host: '127.0.0.1', port, path: r.path, method: r.method || 'POST',
        timeout: 120000,
        headers: Object.assign({ host: `127.0.0.1:${port}` }, r.headers || {}),
      }, (resp) => {
        const chunks = []
        resp.on('data', (c) => chunks.push(c))
        resp.on('end', () => {
          const buf = Buffer.concat(chunks)
          rows.push({ req: r, status: resp.statusCode, headers: resp.headers, buf, text: buf.toString('utf8') })
          res()
        })
      })
    } catch (e) { rows.push({ req: r, status: 0, error: `client:${e && e.message ? e.message : e}`, text: '' }); return res() }
    req.on('error', (e) => { rows.push({ req: r, status: 0, error: `req:${e && e.message ? e.message : e}`, text: '' }); res() })
    req.on('timeout', () => { req.destroy(); rows.push({ req: r, status: 0, error: 'timeout', text: '' }); res() })
    if (r.body !== undefined && r.body !== null) req.write(r.body)
    req.end()
  })), Promise.resolve()).then(() => rows)
}

/** 一批请求 → 落证据 */
function keepBatch(id, rows) {
  const text = rows.map((x) => {
    let body = x.text
    try { body = JSON.stringify(JSON.parse(x.text)) } catch { /* 原样 */ }
    return `${x.req.method || 'POST'} ${x.req.path}\n  origin=${(x.req.headers || {}).origin || '（无）'} ct=${(x.req.headers || {})['content-type'] || '（无）'} cap=${(x.req.headers || {})['X-Whale-Capability'] ? '有' : '（无）'}\n  status=${x.status} error=${x.error || 'none'}\n  body=${JSON.stringify(String(body).slice(0, 400))}`
  }).join('\n')
  h.evidence(path.join('cases', `${id}.txt`), `${text}\n`)
}

const rowAt = (out, i) => {
  const arr = Array.isArray(out) ? out : (out && out.rows)
  const r = arr ? arr[i] : null
  if (!r) throw new Error(`请求批里没有第 ${i} 条（共 ${arr ? arr.length : 0} 条）`)
  return r
}
const jsonOf = (row) => { try { return JSON.parse(row.text) } catch { return null } }

/* ================================================================ 跑新实现那一批 */

const EVIL = 'http://evil.test'
const FORM_HEADERS = { origin: EVIL, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const PLAIN_HEADERS = { origin: EVIL, 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' }
const NULL_HEADERS = { origin: 'null', 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' }

const RUN = {}
try {
  need()
  const askBody = JSON.stringify({ question: CANARY.ask, lesson: '演示课', page: 'p.html', title: 'T' })
  const noteBody = JSON.stringify({ text: CANARY.note, anchor: 'alpha/0001' })
  const adjustBody = JSON.stringify({ lesson: '演示课', done: false, adjust: CANARY.adjust })

  // 一次起服务，四段跑完（拒绝面 / 会话 / 学生面 / 错配）—— **同一个端口**，令牌才成立
  //
  // ⚠️ 把服务端的 `console.log` 收走：`ask-server.js` 在收到疑问 / 笔记时会打一行
  //    （`[ask] 收到 #0001 …`）。那是**产品行为**，但卡面要求验收命令的
  //    stdout/stderr **合计只给一行判词** —— 所以这里把它转存成证据文件，不放它上 stdout。
  const serverLog = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => { serverLog.push(a.map((x) => String(x)).join(' ')) }
  console.error = (...a) => { serverLog.push('ERR ' + a.map((x) => String(x)).join(' ')) }
  let out
  try {
    out = await withServer(NEW_APP.handler, async (port, origin) => {
    const SAME_ORIGIN = origin
    // ① 拒绝面（树快照在它前后取）
    const before = snapTree(PACK)
    const reject = await requestBatch(port, [
      // 简单表单（跨站）：浏览器带 Origin + navigate；**发不出自定义头**
      { path: '/ask', headers: FORM_HEADERS, body: askBody },
      { path: '/api/session', headers: FORM_HEADERS, body: '{"scope":"reader"}' },
      // text/plain + evil origin（D02 实测那条形状）
      { path: '/ask', headers: PLAIN_HEADERS, body: askBody },
      { path: '/note', headers: PLAIN_HEADERS, body: noteBody },
      { path: '/progress', headers: PLAIN_HEADERS, body: adjustBody },
      // Origin: null（默认不认）
      { path: '/ask', headers: NULL_HEADERS, body: askBody },
      { path: '/api/session', headers: NULL_HEADERS, body: '{"scope":"reader"}' },
      // 同源但**没有令牌**（令牌是唯一凭据）
      { path: '/ask', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json' }, body: askBody },
      // 伪造 / 改过的令牌
      { path: '/ask', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': 'wcap1.bogus.bogus' }, body: askBody },
      // Host 不是本机回环（DNS rebinding 形状）
      { path: '/ask', headers: { host: 'evil.test', origin: 'http://evil.test', 'content-type': 'application/json' }, body: askBody },
    ])
    const after = snapTree(PACK)
    keepBatch('T07-REJECT-batch', reject)

    // ①b **读口**（边界要看得见）：跨源读**不给** CORS 头 ⇒ 攻击者读不到正文；
    //     读口没有副作用 ⇒ 树不变。这条与"写口必须 403"是**两件事**，分开钉。
    const reads = await requestBatch(port, [
      { method: 'GET', path: '/progress', headers: PLAIN_HEADERS },
      { method: 'GET', path: '/notes', headers: PLAIN_HEADERS },
      { method: 'GET', path: '/ask?id=0001', headers: PLAIN_HEADERS },
      { method: 'GET', path: '/health', headers: PLAIN_HEADERS },
    ])
    keepBatch('T07-READS-batch', reads)

    // ② 正例：合法会话（同源）
    const allow = await requestBatch(port, [
      { path: '/api/session', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json' }, body: '{"scope":"reader"}' },
      { path: '/api/session', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json' }, body: '{"scope":"admin"}' },
      { path: '/api/session', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json' }, body: '{"scope":"nonsense"}' },
      { method: 'GET', path: '/health', headers: PLAIN_HEADERS },
    ])
    keepBatch('T07-ALLOW-batch', allow)
    const readerToken = (() => { const d = jsonOf(allow[0]); return d && d.ok ? d.token : '' })()
    const adminToken = (() => { const d = jsonOf(allow[1]); return d && d.ok ? d.token : '' })()

    // ③ 学生面正例（带 reader 令牌）
    const student = await requestBatch(port, [
      { path: '/ask', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': readerToken }, body: askBody },
      { method: 'GET', path: '/ask?id=0001', headers: { origin: SAME_ORIGIN, 'X-Whale-Capability': readerToken } },
      { path: '/note', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': readerToken }, body: noteBody },
      { method: 'GET', path: '/notes', headers: { origin: SAME_ORIGIN, 'X-Whale-Capability': readerToken } },
      { path: '/progress', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': readerToken }, body: adjustBody },
      { method: 'GET', path: '/progress', headers: { origin: SAME_ORIGIN, 'X-Whale-Capability': readerToken } },
    ])
    keepBatch('T07-ALLOW-student-batch', student)

    // ④ 错配：令牌用错地方
    // ⚠️ 课程包自己的服务**签不出** admin 令牌（这正是分源隔离）—— 所以这里用**同一份秘密**
    //    在判据这一侧直接签一个 admin 作用域的令牌（等价于"另一个服务签的"），
    //    用来证明"作用域是硬绑的"。
    const foreignAdmin = (() => {
      try {
        const secret = SEC.loadRuntimeSecret({ scope: path.basename(PACK) }).secret
        return SEC.mintToken({ pack: path.basename(PACK), scope: 'admin', origin: SAME_ORIGIN, exp: Date.now() + 60000, secret })
      } catch { return '' }
    })()
    const mismatch = await requestBatch(port, [
      { path: '/ask', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': readerToken.replace(/\.[^.]+$/, '.AAAA') }, body: askBody },
      { path: '/ask', headers: { origin: SAME_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': foreignAdmin }, body: askBody },
      { path: '/ask', headers: { origin: SECOND_ORIGIN, 'content-type': 'application/json', 'X-Whale-Capability': readerToken }, body: askBody },
    ])
    keepBatch('T07-REJECT-mismatch-batch', mismatch)

    return { rows: reject, reject, reads, allow, student, mismatch, tokens: { readerToken, adminToken, origin: SAME_ORIGIN }, rejectTree: { before, after } }
    })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  h.evidence(path.join('cases', 'T07-server-console.txt'),
    `（收走的服务端 stdout/stderr —— 卡面要求验收命令只给一行判词，所以这些**不**上 stdout）\n${serverLog.join('\n')}\n`)
  if (out.error) throw new Error(out.error)
  RUN.reject = out.reject
  RUN.reads = out.reads
  RUN.allow = out.allow
  RUN.student = out.student
  RUN.mismatch = out.mismatch
  RUN.tokens = out.tokens
  RUN.rejectTree = out.rejectTree
  RUN.port = out.port
} catch (e) {
  RUN.error = `${e && e.message ? e.message : e}`
}
const needRun = () => { need(); if (RUN.error) throw new Error(`请求批没跑完：${RUN.error}`) }

/* ================================================================ 纯函数判据（能力集） */

const fakeReq = (headers) => ({ headers })

const PURE = {}
try {
  need()
  const sec = SEC
  const sharedSecret = crypto.randomBytes(32)
  const caps = sec.createCapabilities({
    packId: 'pure-pack',
    adminOrigin: 'http://127.0.0.1:3091',
    readerOrigin: 'http://127.0.0.1:8788',
    selfScope: 'reader',        // 课程包自己的服务：本站来源只服务 reader
    secret: sharedSecret,
  })
  // ⚠️ 两个能力集**共用同一份秘密**：不然"别的包发的令牌"会先撞签名（`CAP_BAD_SIGNATURE`），
  //    测到的是签名不是"包对不上"。判据要的是**包这一层**的绑定。
  const other = sec.createCapabilities({
    packId: 'other-pack',
    adminOrigin: 'http://127.0.0.1:3091',
    readerOrigin: 'http://127.0.0.1:8788',
    selfScope: 'admin',      // 另一个**管理台**服务（用来测"包对不上"）
    secret: sharedSecret,
  })
  // 只认管理来源的那一份（课件来源**不在**任何清单里）—— 用来钉"课件源换不到管理能力"
  const adminOnly = sec.createCapabilities({
    packId: 'admin-only', adminOrigin: 'http://127.0.0.1:3091', readerOrigin: [], selfScope: 'reader', secret: sharedSecret,
  })
  // 管理台那一份（`selfScope: 'admin'` + `adminPaths`）—— 用来钉"课件页换不到管理令牌"
  // ⚠️ 与 `caps` **同一个 packId**：不然"作用域错配"会先撞"包不对"，测到的是另一条。
  const adminSrv = sec.createCapabilities({
    packId: 'pure-pack',
    adminOrigin: [], readerOrigin: [],
    selfScope: 'admin',
    adminPaths: ['/', '/index.html'],
    secret: sharedSecret,
  })
  const adminReq = fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/' })
  const adminPageReq = adminReq
  const readerReq = fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788' })
  const readerTok = caps.mint(readerReq, 'reader')
  const adminTok = adminSrv.mint(adminPageReq, 'admin')
  const otherTok = other.mint(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/' }), 'admin')
  const expired = sec.mintToken({ pack: 'pure-pack', scope: 'reader', origin: 'http://127.0.0.1:8788', exp: Date.now() - 1000, secret: sharedSecret })
  const V = {
    adminOk: adminSrv.authorize(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/', 'x-whale-capability': adminTok.token }), { scope: 'admin', needConfirm: true, confirm: true }),
    adminNoConfirm: adminSrv.authorize(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/', 'x-whale-capability': adminTok.token }), { scope: 'admin', needConfirm: true }),
    readerTokenOnAdmin: adminSrv.authorize(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/', 'x-whale-capability': readerTok.token }), { scope: 'admin', needConfirm: true, confirm: true }),
    adminTokenOnReader: caps.authorize(fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788', 'x-whale-capability': adminTok.token }), { scope: 'reader' }),
    wrongOrigin: caps.authorize(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', 'x-whale-capability': readerTok.token }), { scope: 'reader' }),
    wrongPack: adminSrv.authorize(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/', 'x-whale-capability': otherTok.token }), { scope: 'admin', needConfirm: true, confirm: true }),
    tampered: adminSrv.authorize(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/', 'x-whale-capability': adminTok.token.replace(/\.[^.]+$/, '.AAAA') }), { scope: 'admin', needConfirm: true, confirm: true }),
    expired: caps.authorize(fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788', 'x-whale-capability': expired }), { scope: 'reader' }),
    evilOrigin: caps.authorize(fakeReq({ host: '127.0.0.1:8788', origin: EVIL }), { scope: 'reader' }),
    nullOrigin: caps.authorize(fakeReq({ host: '127.0.0.1:8788', origin: 'null' }), { scope: 'reader' }),
    badHost: caps.authorize(fakeReq({ host: 'evil.test', origin: 'http://evil.test' }), { scope: 'reader' }),
    noOrigin: caps.authorize(fakeReq({ host: '127.0.0.1:8788' }), { scope: 'reader' }),
    canMintAdminFromReaderOrigin: caps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788' }), 'admin'),
    canMintReaderFromReaderOrigin: caps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788' }), 'reader'),
    // 「本站自己的来源」是**逐作用域**判的：课件来源在本站上能拿 reader，但拿不到 admin
    // 这里故意用**不是本站**的来源（7777）—— 测的是"不在管理清单里"，与 selfScope 那条分开
    canMintAdminFromReaderOriginStrict: adminOnly.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:7777' }), 'admin'),
    canMintAdminFromSelfReaderScope: caps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788' }), 'admin'),
  }
  // 管理台那一份：管理页（`/`）能拿 admin；反代过去的课件页（`/library/...`）不能
  const A = {
    adminFromAdminPage: adminSrv.canMint(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/' }), 'admin'),
    adminFromCoursewarePage: adminSrv.canMint(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/library/starmap/' }), 'admin'),
    adminFromCoursewareLesson: adminSrv.canMint(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', referer: 'http://127.0.0.1:3091/library/lessons/demo/alpha/0001-hello.html' }), 'admin'),
    adminNoReferer: adminSrv.canMint(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091' }), 'admin'),
    readerFromAdminSrv: adminSrv.canMint(fakeReq({ host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091' }), 'reader'),
  }
  const fileCaps = sec.createCapabilities({
    packId: 'file-pack', adminOrigin: [], readerOrigin: [], trustFileOrigin: true, secret: sharedSecret,
  })
  const F = {
    defaultDenied: caps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'null', 'sec-fetch-mode': 'cors' }), 'reader'),
    optInCors: fileCaps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'null', 'sec-fetch-mode': 'cors' }), 'reader'),
    optInNavigate: fileCaps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'null', 'sec-fetch-mode': 'navigate' }), 'reader'),
    optInAdmin: fileCaps.canMint(fakeReq({ host: '127.0.0.1:8788', origin: 'null', 'sec-fetch-mode': 'cors' }), 'admin'),
  }
  PURE.caps = caps
  PURE.V = V
  PURE.F = F
  PURE.A = A
  h.evidence(path.join('cases', 'T07-CAP-pure.txt'), [
    '# 能力集纯函数判据（无 HTTP）',
    `admin+confirm → ${JSON.stringify(V.adminOk)}`,
    `admin 无 confirm → ${JSON.stringify(V.adminNoConfirm)}`,
    `reader 令牌打 admin → ${JSON.stringify(V.readerTokenOnAdmin)}`,
    `admin 令牌打 reader → ${JSON.stringify(V.adminTokenOnReader)}`,
    `换来源用令牌 → ${JSON.stringify(V.wrongOrigin)}`,
    `别的包发的令牌 → ${JSON.stringify(V.wrongPack)}`,
    `改过的令牌 → ${JSON.stringify(V.tampered)}`,
    `过期令牌 → ${JSON.stringify(V.expired)}`,
    `evil origin → ${JSON.stringify(V.evilOrigin)}`,
    `null origin → ${JSON.stringify(V.nullOrigin)}`,
    `Host 不是本机回环 → ${JSON.stringify(V.badHost)}`,
    `没有 Origin（非浏览器） → ${JSON.stringify(V.noOrigin)}`,
    `课件来源换 admin（管理清单里没有它） → ${JSON.stringify(V.canMintAdminFromReaderOriginStrict)}`,
    `课件来源换 admin（本服务 selfScope=reader） → ${JSON.stringify(V.canMintAdminFromSelfReaderScope)}`,
    `课件来源换 admin（本站来源那条路） → ${JSON.stringify(V.canMintAdminFromReaderOrigin)}`,
    `课件来源换 reader → ${JSON.stringify(V.canMintReaderFromReaderOrigin)}`,
    `管理台：管理页（/）换 admin → ${JSON.stringify(A.adminFromAdminPage)}`,
    `管理台：课件页（/library/starmap/）换 admin → ${JSON.stringify(A.adminFromCoursewarePage)}`,
    `管理台：课件课页换 admin → ${JSON.stringify(A.adminFromCoursewareLesson)}`,
    `管理台：没有 Referer 换 admin → ${JSON.stringify(A.adminNoReferer)}`,
    `管理台：自己的来源换 reader → ${JSON.stringify(A.readerFromAdminSrv)}`,
    `file:// 默认 → ${JSON.stringify(F.defaultDenied)}`,
    `file:// 显式开 + cors → ${JSON.stringify(F.optInCors)}`,
    `file:// 显式开 + navigate（简单表单）→ ${JSON.stringify(F.optInNavigate)}`,
    `file:// 显式开换 admin → ${JSON.stringify(F.optInAdmin)}`,
    '',
  ].join('\n'))
} catch (e) {
  PURE.error = `${e && e.message ? e.message : e}`
}
const needPure = () => { need(); if (PURE.error) throw new Error(`纯函数判据没跑完：${PURE.error}`) }

/* ================================================================ 离线端：子进程驱动（各自一个库） */

/**
 * 驱动脚本：跑一批动作。**令牌与端口都在子进程里当场取**（`{{token}}` / `{{origin}}` 占位符），
 * 因为令牌绑来源，而来源是那个子进程当场监听的端口 —— 父进程猜不到。
 */
const DRIVER_SRC = `#!/usr/bin/env node
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const flag = (n) => { const p = '--' + n + '='; const hit = argv.find((a) => a.startsWith(p)); return hit === undefined ? null : hit.slice(p.length) }
const tmpl = flag('tmpl')
const planFile = flag('plan')
process.env.WHALE_LIB = flag('lib')

const OS = require(path.join(tmpl, 'tools', 'offline-server.js'))
const ACTIONS = JSON.parse(fs.readFileSync(planFile, 'utf8'))

function one(port, vars, r) {
  return new Promise((res) => {
    const sub = (v) => String(v).replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])))
    const headers = {}
    for (const [k, v] of Object.entries(r.headers || {})) headers[k] = sub(v)
    // ⚠️ 体只走 base64（body 是**文本**）—— 原始 zip 字节不能塞进 JSON 计划里当字符串
    //    （那会在 UTF-16 转换里被改写，helper 报「Int64 无法容纳中央目录偏移量」）。
    const body = r.bodyBase64 ? Buffer.from(r.bodyBase64, 'base64')
      : (r.body === undefined || r.body === null ? null : sub(r.body))
    const req = http.request({
      host: '127.0.0.1', port, path: r.path, method: r.method || 'POST', timeout: 120000,
      headers: Object.assign({ host: '127.0.0.1:' + port }, headers),
    }, (resp) => {
      const chunks = []
      resp.on('data', (c) => chunks.push(c))
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 原样 */ }
        res({ path: r.path, status: resp.statusCode, text: text.slice(0, 20000), json })
      })
    })
    req.on('error', (e) => res({ path: r.path, status: 0, error: String(e && e.message ? e.message : e) }))
    req.on('timeout', () => { req.destroy(); res({ path: r.path, status: 0, error: 'timeout' }) })
    if (body !== null) req.write(body)
    req.end()
  })
}

function batch(port, vars, reqs) {
  return (async () => {
    const rows = []
    for (const r of reqs) rows.push(await one(port, vars, r))
    return rows
  })()
}

;(async () => {
  const out = { lib: process.env.WHALE_LIB, tmpl, actions: [] }
  const srv = http.createServer(OS.handler)
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve) })
  const port = srv.address().port
  out.port = port
  const vars = { origin: 'http://127.0.0.1:' + port }
  for (const a of ACTIONS) {
    try {
      if (a.kind === 'http') out.actions.push({ kind: 'http', rows: await batch(port, vars, a.reqs || []) })
      else if (a.kind === 'session') {
        const rows = await batch(port, vars, [{ path: '/api/session', headers: { origin: '{{origin}}', 'content-type': 'application/json' }, body: JSON.stringify({ scope: a.scope || 'reader' }) }])
        const d = rows[0] && rows[0].json
        if (d && d.ok && d.token) vars[a.as || 'token'] = d.token
        out.actions.push({ kind: 'session', rows, tokenCaptured: !!(d && d.token) })
      } else if (a.kind === 'login') {
        // 直接向能力集要一个令牌（不走 HTTP）：给"正例"省一个来回，语义与 /api/session 完全一样
        const req = { headers: { host: '127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port } }
        const m = OS.capabilities.mint(req, a.scope || 'admin')
        if (m.ok) vars[a.as || 'token'] = m.token
        out.actions.push({ kind: 'login', ok: !!m.ok, scope: m.scope, origin: m.origin, code: m.code || null, how: m.how || null })
      } else if (a.kind === 'libraryInfo') out.actions.push({ kind: 'libraryInfo', result: OS.libraryInfo() })
      else if (a.kind === 'plan') out.actions.push({ kind: 'plan', result: OS.planLegacyMigration() })
      else out.actions.push({ kind: a.kind, error: 'unknown action' })
    } catch (e) {
      out.actions.push({ kind: a.kind, error: String(e && e.message ? e.message : e) })
    }
  }
  try { if (typeof OS.closePackServers === 'function') OS.closePackServers() } catch { /* 忽略 */ }
  srv.close()
  process.stdout.write('<<<R>>>' + JSON.stringify(out) + '\\n')
  process.exit(0)
})().catch((e) => {
  process.stdout.write('<<<E>>>' + JSON.stringify({ error: String(e && e.stack ? e.stack : e) }) + '\\n')
  process.exit(3)
})
`
const DRIVER_FILE = path.join(SANDBOX, 't07-offline-driver.cjs')
W(DRIVER_FILE, DRIVER_SRC)

/** 跑一次离线端子进程；回 `{code, out, err, data}` */
function runOfflineDriver(id, tmpl, lib, actions, timeoutMs = 900000) {
  const planFile = path.join(SANDBOX, `plan-${id}.json`)
  WJ(planFile, actions)
  const r = runChild([NODE, DRIVER_FILE, `--tmpl=${tmpl}`, `--lib=${lib}`, `--plan=${planFile}`], { cwd: REPO, timeoutMs })
  keepEvidence(id, r, { tmpl, lib })
  const m = /<<<R>>>(\{[\s\S]*?\})\r?\n/.exec(String(r.out))
  let data = null
  if (m) { try { data = JSON.parse(m[1]) } catch { data = null } }
  return { ...r, data }
}
const actRows = (drv, i) => {
  const a = drv.data && drv.data.actions ? drv.data.actions[i] : null
  if (!a || !a.rows) throw new Error(`驱动第 ${i} 个动作没有 rows（${JSON.stringify(a)}）`)
  return a.rows
}

const OFF = {}
try {
  need()
  // ① 管理正例：开会话（admin，走 HTTP）→ 再用同一份能力集拿一个令牌做 打开 / 重建
  //    （`login` 与 `/api/session` 是**同一份**能力集的同一个 `mint()`，只是省掉一个来回）
  OFF.admin = runOfflineDriver('T07-OFFLINE-admin', PACK, LIB_ADMIN, [
    { kind: 'session', scope: 'admin', as: 'token' },
    { kind: 'login', scope: 'admin', as: 'token2' },
    { kind: 'http', reqs: [
      { method: 'GET', path: '/', headers: {} },
      { path: '/api/health', headers: { origin: '{{origin}}', 'X-Whale-Capability': '{{token}}' } },
      { path: '/api/library', headers: { origin: '{{origin}}', 'X-Whale-Capability': '{{token}}' } },
      { path: '/api/open', headers: { origin: '{{origin}}', 'content-type': 'application/json', 'X-Whale-Capability': '{{token2}}' }, body: '{}' },
      { path: '/api/rebuild', headers: { origin: '{{origin}}', 'content-type': 'application/json', 'X-Whale-Capability': '{{token2}}' }, body: '{}' },
      { path: '/api/open', headers: { origin: '{{origin}}', 'content-type': 'application/json' }, body: '{}' },
      { path: '/api/rebuild', headers: { origin: '{{origin}}', 'content-type': 'application/json' }, body: '{}' },
      { path: '/api/clear', headers: { origin: '{{origin}}', 'content-type': 'application/json' }, body: '{}' },
    ] },
  ])
  // ② 管理正例：导入（要 confirm）—— 单独一个库，别把 ① 的库搅了
  const zip = makeZip([
    { name: 'pack.json', data: JSON.stringify({ v: 1, id: 'imported', lesson: { title: '导入的课' } }) },
    { name: 'lessons/lessons.json', data: JSON.stringify({ v: 1, source: 'lessons/src', lessons: [{ rel: 'demo/beta/0001-imported.html', title: '导入的课', number: 1, halo: 'demo', point: 'beta', slug: 'imported' }] }) },
    { name: 'lessons/demo/halo.json', data: JSON.stringify({ halo: 'demo', name: '演示圈', color: '#e8f0ff' }) },
    { name: 'lessons/demo/beta/point.json', data: JSON.stringify({ point: 'beta', name: '演示点', fileBase: 0 }) },
    { name: 'lessons/demo/beta/0001-imported.html', data: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>导入的课</title></head><body><h1>导入的课</h1></body></html>\n' },
  ])
  const zipFile = path.join(SANDBOX, 'import-good.zip')
  fs.writeFileSync(zipFile, zip)
  OFF.import = runOfflineDriver('T07-OFFLINE-import', PACK, LIB_IMPORT, [
    { kind: 'session', scope: 'admin', as: 'token' },
    { kind: 'http', reqs: [
      { path: '/api/import?name=good.zip&confirm=1', headers: { origin: '{{origin}}', 'content-type': 'application/zip', 'X-Whale-Capability': '{{token}}' }, bodyBase64: zip.toString('base64') },
      { path: '/api/import?name=good.zip', headers: { origin: '{{origin}}', 'content-type': 'application/zip', 'X-Whale-Capability': '{{token}}' }, bodyBase64: zip.toString('base64') },
    ] },
  ])
  // ③ 管理正例：迁移旧课程包（先看计划 → 带摘要确认）
  OFF.migrate = runOfflineDriver('T07-OFFLINE-migrate', PACK, LIB_MIGRATE, [
    { kind: 'session', scope: 'admin', as: 'token' },
    { kind: 'plan' },
    { kind: 'http', reqs: [
      { path: '/api/migrate', headers: { origin: '{{origin}}', 'content-type': 'application/json', 'X-Whale-Capability': '{{token}}' }, body: JSON.stringify({}) },
    ] },
  ])
} catch (e) {
  OFF.error = `${e && e.message ? e.message : e}`
}
const needOff = () => { need(); if (OFF.error) throw new Error(`离线端子进程没跑完：${OFF.error}`) }

/* ================================================================ 负向控制：基线实现 */

const BASE = {}
try {
  need()
  // ① 基线 ask-server：evil origin + text/plain 真的写盘
  const baseAskDriver = path.join(SANDBOX, 't07-base-ask-driver.cjs')
  W(baseAskDriver, `#!/usr/bin/env node
'use strict'
const http = require('http')
const path = require('path')
const tmpl = process.argv[2]
const ASK = require(path.join(tmpl, 'tools', 'ask-server.js'))
const srv = http.createServer(ASK.handleRequest)
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port
  const rows = []
  const reqs = [
    { name: 'evil-origin-text-plain', headers: { host: '127.0.0.1:' + port, origin: 'http://evil.test', 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }, body: JSON.stringify({ question: '${CANARY.ask}', lesson: '演示课' }) },
    { name: 'null-origin-text-plain', headers: { host: '127.0.0.1:' + port, origin: 'null', 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }, body: JSON.stringify({ question: '${CANARY.ask}-NULL', lesson: '演示课' }) },
    { name: 'evil-origin-simple-form', headers: { host: '127.0.0.1:' + port, origin: 'http://evil.test', 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, body: 'question=x&lesson=y' },
  ]
  ;(function next(i) {
    if (i >= reqs.length) {
      console.log('<<<R>>>' + JSON.stringify({ port, rows }))
      srv.close(() => process.exit(0))
      return
    }
    const r = reqs[i]
    const req = http.request({ host: '127.0.0.1', port, path: '/ask', method: 'POST', headers: r.headers }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        rows.push({ name: r.name, status: res.statusCode, acao: res.headers['access-control-allow-origin'] || null, text: text.slice(0, 300) })
        next(i + 1)
      })
    })
    req.on('error', (e) => { rows.push({ name: r.name, status: 0, error: String(e && e.message ? e.message : e) }); next(i + 1) })
    req.write(r.body)
    req.end()
  })(0)
})
`)
  const r = runChild([NODE, baseAskDriver, PACK_BASE], { cwd: REPO, timeoutMs: 120000 })
  keepEvidence('T07-NEGCTRL-baseline-ask', r, { pack: PACK_BASE })
  const m = /<<<R>>>(\{[\s\S]*?\})\r?\n/.exec(String(r.out))
  BASE.ask = m ? JSON.parse(m[1]) : null
  BASE.askPending = (() => { try { return fs.readFileSync(path.join(PACK_BASE, 'questions', 'pending.jsonl'), 'utf8') } catch { return '' } })()
  BASE.askSeq = (() => { try { return fs.readFileSync(path.join(PACK_BASE, 'questions', 'seq.txt'), 'utf8').trim() } catch { return '' } })()
  h.evidence(path.join('cases', 'T07-NEGCTRL-baseline-ask-raw.txt'),
    `${JSON.stringify(BASE.ask, null, 2)}\n\n--- 基线副本的 questions/pending.jsonl ---\n${BASE.askPending}\n--- seq.txt ---\n${BASE.askSeq}\n`)

  // ② 基线 offline-server：无体跨源 POST /api/clear 真的把库移进 .trash
  const baseOffDriver = path.join(SANDBOX, 't07-base-offline-driver.cjs')
  W(baseOffDriver, `#!/usr/bin/env node
'use strict'
const http = require('http')
const path = require('path')
process.env.WHALE_LIB = process.argv[3]
const OS = require(path.join(process.argv[2], 'tools', 'offline-server.js'))
const srv = http.createServer(OS.handler)
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port
  const req = http.request({ host: '127.0.0.1', port, path: '/api/clear', method: 'POST', headers: { host: '127.0.0.1:' + port, origin: 'http://evil.test', 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } }, (res) => {
    let text = ''
    res.on('data', (c) => { text += c })
    res.on('end', () => {
      try { if (typeof OS.closePackServers === 'function') OS.closePackServers() } catch { }
      console.log('<<<R>>>' + JSON.stringify({ port, status: res.statusCode, acao: res.headers['access-control-allow-origin'] || null, text: text.slice(0, 300) }))
      srv.close(() => process.exit(0))
    })
  })
  req.on('error', (e) => {
    console.log('<<<R>>>' + JSON.stringify({ port, status: 0, error: String(e && e.message ? e.message : e) }))
    srv.close(() => process.exit(0))
  })
  req.end()
})
`)
  const r2 = runChild([NODE, baseOffDriver, PACK_BASE, LIB_CLEARED], { cwd: REPO, timeoutMs: 120000 })
  keepEvidence('T07-NEGCTRL-baseline-clear', r2, { pack: PACK_BASE, lib: LIB_CLEARED })
  const m2 = /<<<R>>>(\{[\s\S]*?\})\r?\n/.exec(String(r2.out))
  BASE.clear = m2 ? JSON.parse(m2[1]) : null
  BASE.libraryGone = !fs.existsSync(path.join(LIB_CLEARED, 'library'))
  BASE.trash = (() => { try { return fs.readdirSync(path.join(LIB_CLEARED, '.trash')) } catch { return [] } })()
  h.evidence(path.join('cases', 'T07-NEGCTRL-baseline-clear-raw.txt'),
    `${JSON.stringify(BASE.clear, null, 2)}\n\n--- 清库后：库还在吗 ---\nlibrary 还在？${!BASE.libraryGone}\n.trash 里：${JSON.stringify(BASE.trash)}\n`)
} catch (e) {
  BASE.error = `${e && e.message ? e.message : e}`
}
const needBase = () => { need(); if (BASE.error) throw new Error(`负向控制没跑完：${BASE.error}`) }

/* ================================================================ ① 接口 / 单一实现 / 秘密 */

h.case('T07-CAP-single-source', 'pass', () => {
  need()
  /** 去掉注释再判：注释里**引用**旧写法不算"旧写法还在"（字符串 includes 会被注释满足 = 假绿） */
  const stripComments = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const defines = (name) => {
    const hits = []
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue }
        if (!/\.(js|cjs|mjs)$/.test(e.name)) continue
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8')
        // `function name(` 或 `const name = (`（两种定义形状都算 —— 不然"导出的箭头函数"会被漏掉）
        if (new RegExp(`function\\s+${name}\\s*\\(`).test(text)) { hits.push(r); continue }
        if (new RegExp(`const\\s+${name}\\s*=`).test(text)) { hits.push(r); continue }
      }
    }
    walk(path.join(REPO, 'lib'), 'lib')
    return hits
  }
  const createHits = defines('createCapabilities')
  const authHits = defines('authorizeRequest')
  // ⚠️ `authorizeRequest` 在共享件里是**导出对象的一个属性**（`authorizeRequest: (req, opts) => …`），
  //    不是 `function` / `const` 声明 —— 上面那两种形状都漏它。所以另加一条"属性定义"形状。
  const authProp = []
  {
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue }
        if (!/\.(js|cjs|mjs)$/.test(e.name)) continue
        if (new RegExp(`\\bauthorizeRequest\\s*:`).test(fs.readFileSync(path.join(dir, e.name), 'utf8'))) authProp.push(r)
      }
    }
    walk(path.join(REPO, 'lib'), 'lib')
  }
  const authAll = [...new Set([...authHits, ...authProp])]
  const secSrc = stripComments(fs.readFileSync(path.join(REPO, REL_SECURITY), 'utf8'))
  const askSrc = stripComments(fs.readFileSync(path.join(REPO, REL_ASK), 'utf8'))
  const offSrc = stripComments(fs.readFileSync(path.join(REPO, REL_OFFLINE), 'utf8'))
  const appSrc = stripComments(fs.readFileSync(path.join(REPO, 'lib/pack-template/tools/app-server.js'), 'utf8'))
  const rows = [
    `createCapabilities 的定义处：${createHits.join('、') || '（无）'}`,
    `authorizeRequest 的定义处：${authAll.join('、') || '（无）'}`,
    `ask-server 取共享件？${/require\(['"]\.\/http-security\.cjs['"]\)/.test(askSrc)}`,
    `app-server 取共享件？${/require\(['"]\.\/http-security\.cjs['"]\)|api\.gate/.test(appSrc)}`,
    `offline-server 取共享件？${/require\(['"]\.\/http-security\.cjs['"]\)/.test(offSrc)}`,
    `http-security 只依赖 node: 内置？${!/require\(['"][^'"]*(?:path-policy|public-files|ask-server|app-server)/.test(secSrc)}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T07-CAP-single-source.txt'), rows)
  h.eq(createHits.join('、'), REL_SECURITY, `授权件只许有一份实现（实得 ${createHits.join('、') || '无'}）`)
  h.eq(authAll.join('、'), REL_SECURITY, `authorizeRequest 也只许有一份（实得 ${authAll.join('、') || '无'}）`)
  h.assert(/require\(['"]\.\/http-security\.cjs['"]\)/.test(askSrc), 'ask-server.js 必须从共享件取')
  h.assert(/require\(['"]\.\/http-security\.cjs['"]\)/.test(offSrc), 'offline-server.js 必须从共享件取')
  h.assert(/require\(['"]\.\/http-security\.cjs['"]\)/.test(appSrc) || /api\.gate/.test(appSrc), 'app-server.js 必须复用同一份授权闸')
  h.assert(!/require\(['"][^'"]*(?:path-policy|public-files|ask-server|app-server)/.test(secSrc), '授权件不 require 包内别的件（随包发的独立件）')
})

h.case('T07-CAP-no-cors-as-authorization', 'pass', () => {
  need()
  const stripComments = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const secSrc = stripComments(fs.readFileSync(path.join(REPO, REL_SECURITY), 'utf8'))
  const askRaw = fs.readFileSync(path.join(REPO, REL_ASK), 'utf8')
  const askSrc = stripComments(askRaw)
  const rows = [
    `授权件里读 CORS 响应头？${/_allowOrigin|Access-Control-Allow-Origin/.test(secSrc)}`,
    `授权件里出现 res\.setHeader？${/res\.setHeader/.test(secSrc)}`,
    `ask-server 的 CORS 决定还是只住在 decideCors 一处？${/function decideCors/.test(askSrc)}`,
    `ask-server 的**写口**走 gate() 的处数：${(askSrc.match(/if \(!gate\(req, res\)\) return;/g) || []).length}（/ask /note /progress 三处）`,
    `ask-server 的**读口**（GET /progress /ask /notes）不设闸 —— 它们在源码里还带着 gate 吗？${/GET' && url\.pathname === '\/progress'\) \{\s*\n\s*if \(!gate/.test(askSrc)}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T07-CAP-no-cors-as-authorization.txt'), rows)
  h.eq(/_allowOrigin|Access-Control-Allow-Origin/.test(secSrc), false, '授权判断里不许出现 CORS 响应头（D02 就是"拿 CORS 当授权"）')
  h.eq(/res\.setHeader/.test(secSrc), false, '授权件不写响应头（它只判，不碰传输层）')
  // **写口一个不漏**：三个 POST（/ask /note /progress）各一处闸
  const gates = (askSrc.match(/if \(!gate\(req, res\)\) return;/g) || []).length
  h.eq(gates, 3, `ask-server 的**每一个写口**都要过闸（/ask /note /progress 各一处，实得 ${gates} 处）`)
  // **读口不设闸**是**写清楚的边界**（不是漏掉）：D02 的病是"副作用"，读口没有副作用，
  // 而跨源读读不到正文（不给不可信来源任何 CORS 头）。给读口上闸要改落点外的 `index.html`。
  h.assert(/读口不设闸/.test(askRaw), '读口开放这件事必须在源码里**写清楚**（边界要看得见，不是默默漏掉）')
  // 用真 HTTP 把这条边界钉住：evil origin 的 GET 拿得到 200，但**一个 CORS 头都不给** ⇒ 读不到正文
  needRun()
  const reads = RUN.reads
  h.evidence(path.join('cases', 'T07-CAP-reads-open-but-unreadable.txt'),
    reads.map((r) => `GET ${r.req.path}\n  origin=${r.req.headers.origin} status=${r.status} ACAO=${(r.headers || {})['access-control-allow-origin'] || '（无）'}\n  body=${JSON.stringify(String(r.text).slice(0, 160))}`).join('\n') + '\n')
  for (const r of reads) {
    h.eq(r.status, 200, `读口 ${r.req.path} 对跨源 GET 仍是 200（读口不设闸）`)
    h.eq((r.headers || {})['access-control-allow-origin'], undefined,
      `**读口必须一个 CORS 头都不给**（evil origin 读不到正文）：${r.req.path}`)
  }
  h.eq(RUN.rejectTree.before, RUN.rejectTree.after, '读口被跨源 GET 之后，整棵包树同样逐字节不变')
})

h.case('T07-CAP-session-endpoint-issues-token', 'pass', () => {
  needRun()
  const reader = jsonOf(rowAt(RUN.allow, 0))
  const adminAsk = rowAt(RUN.allow, 1)
  const bad = rowAt(RUN.allow, 2)
  const health = rowAt(RUN.allow, 3)
  h.evidence(path.join('cases', 'T07-CAP-session-endpoint-issues-token.txt'),
    `reader 会话：${JSON.stringify(reader)}\n向课程包服务要 admin：${adminAsk.status} ${String(adminAsk.text).slice(0, 240)}\n未知作用域：${bad.status} ${bad.text.slice(0, 160)}\n/health（无需令牌）：${health.status}\n`)
  h.eq(rowAt(RUN.allow, 0).status, 200, '可信来源 POST /api/session 要 200')
  h.assert(reader && reader.ok === true && typeof reader.token === 'string' && reader.token.length > 40, '会话要回一个真令牌')
  h.eq(reader.scope, 'reader', '缺省作用域是 reader')
  // **课程包自己的服务**要 admin 令牌：403 —— 管理能力不在这条服务上（分源隔离的直接体现）
  h.eq(adminAsk.status, 403, '向课程包自己的服务要 admin 作用域 → 403（管理能力不在这里）')
  h.eq(jsonOf(adminAsk) && jsonOf(adminAsk).code, 'ORIGIN_SCOPE_MISMATCH', `拒法要点到作用域不匹配（实得 ${jsonOf(adminAsk) && jsonOf(adminAsk).code}）`)
  h.eq(bad.status, 400, '未知作用域 → 400（不静默按 reader 发）')
  h.eq(health.status, 200, '/health 不需要令牌（探活口）')
  const hdrs = rowAt(RUN.allow, 0).headers || {}
  h.eq(hdrs['access-control-allow-origin'], undefined, '会话响应不许带 Access-Control-Allow-Origin')
})

h.case('T07-CAP-token-bound-to-origin-scope-pack', 'pass', () => {
  needPure()
  const V = PURE.V
  h.evidence(path.join('cases', 'T07-CAP-token-bound-to-origin-scope-pack.txt'),
    [V.wrongOrigin, V.wrongPack, V.tampered, V.expired, V.adminTokenOnReader, V.readerTokenOnAdmin]
      .map((x, i) => `#${i} ${JSON.stringify(x)}`).join('\n') + '\n')
  h.eq(V.wrongOrigin.ok, false, '换来源用令牌必须拒')
  h.eq(V.wrongOrigin.code, 'CAP_WRONG_ORIGIN', `换来源的拒法要点到来源（实得 ${V.wrongOrigin.code}）`)
  h.eq(V.wrongPack.ok, false, '别的课程包发的令牌必须拒')
  h.eq(V.wrongPack.code, 'CAP_WRONG_PACK', `别的包的拒法要点到包（实得 ${V.wrongPack.code}）`)
  h.eq(V.tampered.ok, false, '改过的令牌必须拒')
  h.eq(V.tampered.code, 'CAP_BAD_SIGNATURE', `改过的令牌要点到签名（实得 ${V.tampered.code}）`)
  h.eq(V.expired.ok, false, '过期令牌必须拒')
  h.eq(V.expired.code, 'CAP_EXPIRED', `过期要点到过期（实得 ${V.expired.code}）`)
  h.eq(V.adminTokenOnReader.ok, false, 'admin 令牌不许当 reader 用（作用域是硬绑的）')
  h.eq(V.adminTokenOnReader.code, 'CAP_WRONG_SCOPE', `作用域错配要点到作用域（实得 ${V.adminTokenOnReader.code}）`)
  h.eq(V.readerTokenOnAdmin.ok, false, 'reader 令牌更不许当 admin 用')
})

h.case('T07-CAP-runtime-secret-private-or-refuse', 'pass', () => {
  need()
  const sec = SEC
  const dir = path.join(SANDBOX, 'runtime-probe')
  fs.mkdirSync(dir, { recursive: true })
  const prev = process.env.WHALE_RUNTIME_DIR
  process.env.WHALE_RUNTIME_DIR = dir
  let ok1 = null
  let ok2 = null
  try {
    ok1 = sec.loadRuntimeSecret({ scope: 'probe' })
    ok2 = sec.loadRuntimeSecret({ scope: 'probe' })
  } finally {
    if (prev === undefined) delete process.env.WHALE_RUNTIME_DIR; else process.env.WHALE_RUNTIME_DIR = prev
  }
  const file = path.join(dir, 'session-secret')
  const exists = fs.existsSync(file)
  const mode = exists ? (fs.statSync(file).mode & 0o777) : null
  // 权限保证不了 → 拒绝落盘与复用。
  // ⚠️ 用**文件占住目录名**（不是"不存在的路径"：`mkdirSync(recursive)` 会把不存在的路径建出来，
  //    那样测到的是"建得出来"，不是"保证不了"）。文件占位下 mkdir 必 EEXIST/ENOTDIR。
  const blocker = path.join(SANDBOX, 'runtime-blocked')
  W(blocker, 'not a directory\n')
  const prev2 = process.env.WHALE_RUNTIME_DIR
  process.env.WHALE_RUNTIME_DIR = path.join(blocker, 'runtime')
  let refused = null
  try { refused = sec.loadRuntimeSecret({ scope: 'probe' }) } finally {
    if (prev2 === undefined) delete process.env.WHALE_RUNTIME_DIR; else process.env.WHALE_RUNTIME_DIR = prev2
  }
  const shortEnv = (() => {
    const p = process.env.WHALE_RUNTIME_SECRET
    process.env.WHALE_RUNTIME_SECRET = 'short'
    let r = null
    try { r = sec.loadRuntimeSecret({ scope: 'probe' }) } finally {
      if (p === undefined) delete process.env.WHALE_RUNTIME_SECRET; else process.env.WHALE_RUNTIME_SECRET = p
    }
    return r
  })()
  h.evidence(path.join('cases', 'T07-CAP-runtime-secret-private-or-refuse.txt'), [
    `运行目录：${dir}`,
    `第一次：source=${ok1.source} persisted=${ok1.persisted} why=${ok1.why}`,
    `第二次：source=${ok2.source} persisted=${ok2.persisted} why=${ok2.why}`,
    `秘密文件在不在：${exists} mode=${mode === null ? 'n/a' : mode.toString(8)}`,
    `两次秘密相同（复用）？${ok1.secret.equals(ok2.secret)}`,
    `建不出来的运行目录 → source=${refused.source} persisted=${refused.persisted} why=${refused.why}`,
    `太短的 WHALE_RUNTIME_SECRET → source=${shortEnv.source} persisted=${shortEnv.persisted} why=${shortEnv.why}`,
    '',
  ].join('\n'))
  h.eq(ok1.persisted, true, '权限能保证时秘密要落进当前用户私有运行目录')
  h.eq(ok2.persisted, true, '第二次要能复用（不然令牌每次重启就失效）')
  h.assert(ok1.secret.equals(ok2.secret), '复用必须是同一份秘密')
  h.eq(ok1.source, 'private-file', `落盘的秘密来源要是 private-file（实得 ${ok1.source}）`)
  h.assert(exists, '秘密文件要真的落盘')
  if (process.platform !== 'win32') h.eq(mode, 0o600, `POSIX 上秘密文件必须 0600（实得 ${mode === null ? 'n/a' : mode.toString(8)}）`)
  h.eq(refused.persisted, false, '权限保证不了 → **拒绝落盘**')
  h.eq(refused.source, 'ephemeral', `拒绝落盘时退回临时秘密（实得 ${refused.source}）`)
  h.assert(/拒绝落盘/.test(String(refused.why)), `拒绝的理由要说清（实得 ${refused.why}）`)
  h.eq(shortEnv.source, 'ephemeral', '太短的显式秘密也要拒（不许悄悄补零）')
})

/* ================================================================ ② 分源与作用域 */

h.case('T07-ISOLATE-reader-cannot-call-admin', 'pass', () => {
  needPure()
  const V = PURE.V
  const F = PURE.F
  const A = PURE.A
  h.evidence(path.join('cases', 'T07-ISOLATE-reader-cannot-call-admin.txt'), [
    `课件来源换 admin（管理清单里没有它） → ${JSON.stringify(V.canMintAdminFromReaderOriginStrict)}`,
    `课件来源换 admin（本服务 selfScope=reader） → ${JSON.stringify(V.canMintAdminFromSelfReaderScope)}`,
    `课件来源换 admin（本站来源那条路） → ${JSON.stringify(V.canMintAdminFromReaderOrigin)}`,
    `课件来源换 reader → ${JSON.stringify(V.canMintReaderFromReaderOrigin)}`,
    `管理台：管理页（/）换 admin → ${JSON.stringify(A.adminFromAdminPage)}`,
    `管理台：课件页（/library/starmap/）换 admin → ${JSON.stringify(A.adminFromCoursewarePage)}`,
    `管理台：课件课页换 admin → ${JSON.stringify(A.adminFromCoursewareLesson)}`,
    `管理台：没有 Referer 换 admin → ${JSON.stringify(A.adminNoReferer)}`,
    `管理台：自己的来源换 reader → ${JSON.stringify(A.readerFromAdminSrv)}`,
    `reader 令牌打 admin → ${JSON.stringify(V.readerTokenOnAdmin)}`,
    `file:// 显式开换 admin → ${JSON.stringify(F.optInAdmin)}`,
    '',
  ].join('\n'))
  // ① 课件来源不在管理清单里 → 换不到 admin
  h.eq(V.canMintAdminFromReaderOriginStrict.ok, false, '**课件来源换不到 admin 令牌**（这正是卡面「课件源不能调用管理能力」）')
  h.eq(V.canMintAdminFromReaderOriginStrict.code, 'ORIGIN_UNTRUSTED', `拒法要点到来源（实得 ${V.canMintAdminFromReaderOriginStrict.code}）`)
  // ② 课程包自己的服务声明 selfScope=reader ⇒ 它自己的来源也换不到 admin
  h.eq(V.canMintAdminFromSelfReaderScope.ok, false, '课程包自己的服务（selfScope=reader）换不到 admin 令牌')
  h.eq(V.canMintAdminFromSelfReaderScope.code, 'ORIGIN_SCOPE_MISMATCH', `拒法要点到作用域不匹配（实得 ${V.canMintAdminFromSelfReaderScope.code}）`)
  h.eq(V.canMintReaderFromReaderOrigin.ok, true, '课件来源能换 reader 令牌（学生面照旧能用）')
  // ③ 管理台：管理页能换 admin，**反代过去的课件页不能**（同源，靠页面闸分）
  h.eq(A.adminFromAdminPage.ok, true, '管理台自己的管理页（Referer=/）要能换 admin 令牌')
  h.eq(A.adminFromCoursewarePage.ok, false, '**课件页（/library/starmap/）换不到 admin 令牌**')
  h.eq(A.adminFromCoursewarePage.code, 'ADMIN_REFERER_NOT_ADMIN', `拒法要点到页面（实得 ${A.adminFromCoursewarePage.code}）`)
  h.eq(A.adminFromCoursewareLesson.ok, false, '课件课页同样换不到 admin 令牌')
  h.eq(A.adminNoReferer.ok, true, '没有 Referer（非浏览器调用）放行 —— 那类调用没有 CSRF 面')
  h.eq(A.readerFromAdminSrv.ok, false, '管理台自己的来源只服务 admin（reader 走包服务那一侧）')
  h.eq(V.readerTokenOnAdmin.ok, false, 'reader 令牌打管理口必须拒')
  h.eq(F.optInAdmin.ok, false, 'file:// 来源即使显式开了也只拿 reader（管理能力不给 opaque 来源）')
})

h.case('T07-ISOLATE-admin-capability-not-in-pack-artifacts', 'pass', () => {
  need()
  // 管理令牌**不是**烘进产物的：模板里不许出现任何令牌串 / 秘密；页面侧只**开**会话，不**存**令牌
  const files = [
    REL_ADMIN_HTML, REL_SESSION_JS, REL_FRAME,
    'lib/pack-template/assets/ask.js', 'lib/pack-template/assets/notes.js',
    'lib/pack-template/assets/adjust.js', 'lib/pack-template/starmap/main.js',
    'lib/pack-template/tools/build-offline-payload.js',
  ]
  const hits = []
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
    if (/wcap1\.[A-Za-z0-9_-]{16,}/.test(text)) hits.push(`${rel}: 出现像令牌的串`)
    if (/session-secret/.test(text)) hits.push(`${rel}: 出现秘密文件名`)
  }
  const adminSrc = fs.readFileSync(path.join(REPO, REL_ADMIN_HTML), 'utf8')
  const sessSrc = fs.readFileSync(path.join(REPO, REL_SESSION_JS), 'utf8')
  const rows = [
    `命中：${hits.join('、') || '（无）'}`,
    `管理页从 /api/session 换令牌？${/\/api\/session/.test(adminSrc)}`,
    `管理页把令牌写进 localStorage？${/localStorage/.test(adminSrc)}`,
    `会话件把令牌写进 localStorage？${/localStorage/.test(sessSrc)}`,
    `会话件把令牌挂在 window 上？${/window\.WhaleSession/.test(sessSrc)}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T07-ISOLATE-admin-capability-not-in-pack-artifacts.txt'), rows)
  h.eq(hits.join('、'), '', `产物里不许出现令牌 / 秘密（实得 ${hits.join('、')}）`)
  h.assert(/\/api\/session/.test(adminSrc), '管理页的令牌必须**运行时**从 /api/session 换')
  h.eq(/localStorage/.test(adminSrc), false, '管理页不许把令牌写进 localStorage（那是**下发课件**的形状）')
  h.eq(/localStorage/.test(sessSrc), false, '会话件也不许把令牌写进 localStorage')
})

h.case('T07-ADMIN-html-from-trusted-install-resource', 'pass', () => {
  needOff()
  const rows = actRows(OFF.admin, 2)
  const root = rows[0]
  h.evidence(path.join('cases', 'T07-ADMIN-html-from-trusted-install-resource.txt'), [
    `管理页 GET / → status=${root ? root.status : 'n/a'}`,
    `正文里有受信安装资源那份的标记？${root ? /鲸师课件 · 离线阅读器/.test(String(root.text)) : 'n/a'}`,
    `正文里有课程库那份的 canary？${root ? String(root.text).includes(CANARY.library) : 'n/a'}`,
    `正文里有 LIBRARY-ADMIN-CANARY？${root ? /LIBRARY-ADMIN-CANARY/.test(String(root.text)) : 'n/a'}`,
    '',
  ].join('\n'))
  h.assert(!!root && root.status === 200, 'GET / 要给管理页（200）')
  h.assert(/鲸师课件 · 离线阅读器/.test(String(root.text)), '管理页正文要是**受信安装资源**那一份')
  h.eq(String(root.text).includes(CANARY.library), false, '**课程库自带的管理 HTML 一个字节都不许出网**')
  h.eq(/LIBRARY-ADMIN-CANARY/.test(String(root.text)), false, '课程库那份管理页的标题也不许出现')
  // 静态判据：ADMIN_HTML 的落点不许在课程库里
  const offSrc = fs.readFileSync(path.join(REPO, REL_OFFLINE), 'utf8')
  h.assert(/path\.join\(__dirname, 'offline-admin\.html'\)/.test(offSrc), '管理页默认取**本服务自己目录**里的那一份（受信安装资源）')
  h.eq(/path\.join\(LIB[^)]*offline-admin/.test(offSrc), false, '管理页落点绝不许拼进课程库（LIB）')
})

/* ================================================================ ③ 正例：合法管理操作 */

h.case('T07-ALLOW-admin-session', 'pass', () => {
  needOff()
  const sess = OFF.admin.data.actions[0]
  const row = (sess.rows || [])[0]
  h.evidence(path.join('cases', 'T07-ALLOW-admin-session.txt'),
    `管理台开会话：status=${row.status} body=${String(row.text).slice(0, 240)}\n`)
  h.eq(row.status, 200, '管理台（受信来源）开会话要 200')
  h.assert(row.json && row.json.ok === true && row.json.scope === 'admin', '要拿到 admin 作用域的令牌')
  h.eq(sess.tokenCaptured, true, '令牌要真的被页面侧拿到（不是只有服务端自己知道）')
})

h.case('T07-ALLOW-admin-open', 'pass', () => {
  needOff()
  const rows = actRows(OFF.admin, 2)
  const health = rows.find((r) => r.path === '/api/health')
  const lib = rows.find((r) => r.path === '/api/library')
  const open = rows.find((r) => r.path === '/api/open')
  h.evidence(path.join('cases', 'T07-ALLOW-admin-open.txt'),
    `health=${health && health.status} library=${lib && lib.status}\nopen=${open && open.status} ${String(open && open.text).slice(0, 240)}\n`)
  h.eq(health.status, 200, 'GET /api/health 要 200')
  h.eq(lib.status, 200, 'GET /api/library 要 200')
  h.eq(open.status, 200, '**合法管理页仍能操作**：POST /api/open（带 admin 令牌）要 200')
  h.assert(open.json && open.json.ok === true && typeof open.json.url === 'string', `打开星图要给出 url（实得 ${String(open.text).slice(0, 160)}）`)
})

h.case('T07-ALLOW-admin-rebuild', 'pass', () => {
  needOff()
  const rows = actRows(OFF.admin, 2)
  const rb = rows.find((r) => r.path === '/api/rebuild')
  h.evidence(path.join('cases', 'T07-ALLOW-admin-rebuild.txt'),
    `rebuild=${rb && rb.status} ${String(rb && rb.text).slice(0, 600)}\n`)
  h.eq(rb.status, 200, 'POST /api/rebuild（带 admin 令牌）要 200')
  h.assert(rb.json && rb.json.ok === true, `重建要真的跑通（实得 ${String(rb.text).slice(0, 300)}）`)
  h.assert(Array.isArray(rb.json.steps) && rb.json.steps.length > 0, '重建要逐步回报（steps 非空）')
})

h.case('T07-ALLOW-admin-import', 'pass', () => {
  needOff()
  const rows = actRows(OFF.import, 1)
  const okRow = rows[0]
  const noConfirm = rows[1]
  h.evidence(path.join('cases', 'T07-ALLOW-admin-import.txt'),
    `带 confirm：${okRow.status} ${String(okRow.text).slice(0, 400)}\n不带 confirm：${noConfirm.status} ${String(noConfirm.text).slice(0, 240)}\n`)
  h.eq(okRow.status, 200, '合法导入（admin 令牌 + confirm）要 200')
  h.assert(okRow.json && okRow.json.ok === true && okRow.json.added >= 1, `导入要真的加进课（实得 ${String(okRow.text).slice(0, 300)}）`)
  h.eq(noConfirm.status, 403, '同一份导入**不带 confirm** 要 403（管理写口要显式确认）')
  h.eq(noConfirm.json && noConfirm.json.code, 'CONFIRM_REQUIRED', `拒法要点到确认（实得 ${noConfirm.json && noConfirm.json.code}）`)
  h.assert(fs.existsSync(path.join(LIB_IMPORT, 'library', 'lessons', 'demo', 'beta', '0001-imported.html')), '导入的那一课要真的落到库里')
})

h.case('T07-ALLOW-admin-migrate', 'pass', () => {
  needOff()
  const plan = OFF.migrate.data.actions[1]
  const rows = actRows(OFF.migrate, 2)
  const noConfirm = rows.find((r) => r.path === '/api/migrate')
  h.evidence(path.join('cases', 'T07-ALLOW-admin-migrate.txt'), [
    `计划：count=${plan.result && plan.result.count} digest=${plan.result && plan.result.digest}`,
    `不带确认：${noConfirm.status} ${String(noConfirm.text).slice(0, 300)}`,
    '',
  ].join('\n'))
  h.assert(plan.result && plan.result.count === 1, `夹具前提：库里要有一个待迁移的旧课程包（实得 ${plan.result && plan.result.count}）`)
  h.eq(noConfirm.status, 200, 'POST /api/migrate 不带确认：回执要可读（200 + ok:false，不是 500）')
  h.eq(noConfirm.json && noConfirm.json.code, 'MIGRATION_NOT_CONFIRMED', `拒法要点到确认（实得 ${noConfirm.json && noConfirm.json.code}）`)
  h.assert(fs.existsSync(path.join(LIB_MIGRATE, 'old-pack')), '**不带确认时一个字节都没动**（旧包还在原地）')
  // 真迁移：同一条库、带摘要
  const drv2 = runOfflineDriver('T07-OFFLINE-migrate-apply', PACK, LIB_MIGRATE, [
    { kind: 'session', scope: 'admin', as: 'token' },
    { kind: 'plan' },
  ])
  const digest = drv2.data.actions[1].result.digest
  const drv3 = runOfflineDriver('T07-OFFLINE-migrate-confirm', PACK, LIB_MIGRATE, [
    { kind: 'session', scope: 'admin', as: 'token' },
    { kind: 'http', reqs: [{ path: '/api/migrate', headers: { origin: '{{origin}}', 'content-type': 'application/json', 'X-Whale-Capability': '{{token}}' }, body: JSON.stringify({ confirm: true, planDigest: digest }) }] },
  ])
  const done = actRows(drv3, 1)[0]
  h.evidence(path.join('cases', 'T07-ALLOW-admin-migrate-apply.txt'),
    `digest=${digest}\n带确认 + 摘要：${done.status} ${String(done.text).slice(0, 500)}\n`)
  h.eq(done.status, 200, '带确认 + 摘要的迁移要 200')
  h.assert(done.json && done.json.ok === true && done.json.code === 'MIGRATION_DONE', `迁移要真的做成（实得 ${String(done.text).slice(0, 300)}）`)
  h.assert(Array.isArray(done.json.migrated) && done.json.migrated.includes('old-pack'), '迁移要报出被并进来的旧包名')
})

h.case('T07-ALLOW-admin-clear', 'pass', () => {
  needOff()
  const rows = actRows(OFF.admin, 2)
  const noCapRow = rows[7]
  h.evidence(path.join('cases', 'T07-ALLOW-admin-clear.txt'),
    `不带令牌的 /api/clear：${noCapRow.status} ${String(noCapRow.text).slice(0, 240)}\n`)
  h.eq(noCapRow.status, 403, '**不带令牌**的跨源 POST /api/clear 必须 403（D02 那条攻击形状）')
  h.eq(noCapRow.json && noCapRow.json.code, 'CAP_MISSING', `拒法要点到缺令牌（实得 ${noCapRow.json && noCapRow.json.code}）`)
  // 合法清库：单独一条库（`LIB_CLEARED` 已经被基线负向控制移走了），带 admin 令牌
  const drv = runOfflineDriver('T07-OFFLINE-clear', PACK, LIB_CLEAR_OK, [
    { kind: 'session', scope: 'admin', as: 'token' },
    { kind: 'http', reqs: [{ path: '/api/clear', headers: { origin: '{{origin}}', 'content-type': 'application/json', 'X-Whale-Capability': '{{token}}' }, body: '{}' }] },
  ])
  const ok = actRows(drv, 1)[0]
  h.evidence(path.join('cases', 'T07-ALLOW-admin-clear-ok.txt'),
    `带 admin 令牌的清库：${ok.status} ${String(ok.text).slice(0, 300)}\n库还在？${fs.existsSync(path.join(LIB_CLEAR_OK, 'library'))}\n`)
  h.eq(ok.status, 200, '合法清库（admin 令牌）要 200')
  h.assert(ok.json && ok.json.ok === true, `清库要真的做成（实得 ${String(ok.text).slice(0, 300)}）`)
  h.eq(fs.existsSync(path.join(LIB_CLEAR_OK, 'library')), false, '清库之后库里那一份要真的不在了（移进回收站）')
})

/* ================================================================ ④ 正例：合法学生面 */

h.case('T07-ALLOW-student-ask', 'pass', () => {
  needRun()
  const post = rowAt(RUN.student, 0)
  const poll = rowAt(RUN.student, 1)
  const j = jsonOf(post)
  h.evidence(path.join('cases', 'T07-ALLOW-student-ask.txt'),
    `POST /ask：${post.status} ${String(post.text).slice(0, 240)}\nGET /ask?id：${poll.status} ${String(poll.text).slice(0, 240)}\n`)
  h.eq(post.status, 200, '合法学生提问（reader 令牌）要 200')
  h.assert(j && j.ok === true && /^\d{4}$/.test(String(j.id)), `提问要真的落号（实得 ${String(post.text).slice(0, 160)}）`)
  h.assert(fs.readFileSync(path.join(PACK, 'questions', 'pending.jsonl'), 'utf8').includes(CANARY.ask), '疑问要真的写进 questions/pending.jsonl')
  h.eq(poll.status, 200, '就地反馈的轮询（GET /ask?id）要 200')
})

h.case('T07-ALLOW-student-note', 'pass', () => {
  needRun()
  const post = rowAt(RUN.student, 2)
  const list = rowAt(RUN.student, 3)
  const j = jsonOf(post)
  h.evidence(path.join('cases', 'T07-ALLOW-student-note.txt'),
    `POST /note：${post.status} ${String(post.text).slice(0, 240)}\nGET /notes：${list.status} ${String(list.text).slice(0, 240)}\n`)
  h.eq(post.status, 200, '合法笔记（reader 令牌）要 200')
  h.assert(j && j.ok === true && /^\d{4}$/.test(String(j.id)), `笔记要真的落号（实得 ${String(post.text).slice(0, 160)}）`)
  h.assert(fs.readFileSync(path.join(PACK, 'notes', 'notes.jsonl'), 'utf8').includes(CANARY.note), '笔记要真的写进 notes/notes.jsonl')
  h.eq(list.status, 200, 'GET /notes 要 200')
  h.assert(Array.isArray(jsonOf(list)), 'GET /notes 要回一个数组')
})

h.case('T07-ALLOW-student-progress', 'pass', () => {
  needRun()
  const post = rowAt(RUN.student, 4)
  const get = rowAt(RUN.student, 5)
  h.evidence(path.join('cases', 'T07-ALLOW-student-progress.txt'),
    `POST /progress：${post.status} ${String(post.text).slice(0, 300)}\nGET /progress：${get.status} ${String(get.text).slice(0, 240)}\n`)
  h.eq(post.status, 200, '合法进度回写（reader 令牌）要 200')
  h.assert(jsonOf(post) && jsonOf(post).adjustSaved === true, `课后调整要真的落账（实得 ${String(post.text).slice(0, 240)}）`)
  h.assert(fs.readFileSync(path.join(PACK, 'learning-records', 'adjustments.jsonl'), 'utf8').includes(CANARY.adjust), '调整要真的写进 learning-records/adjustments.jsonl')
  h.eq(get.status, 200, 'GET /progress 要 200')
})

/* ================================================================ ⑤ 拒绝面 */

/** 一条"必须被拒"的用例：403 + 正文不许出现任何 canary */
function rejectOk(id, row, expectCode) {
  needRun()
  h.evidence(path.join('cases', `${id}.txt`),
    `status=${row.status}\norigin=${(row.req.headers || {}).origin || '（无）'}\nbody=${JSON.stringify(String(row.text).slice(0, 400))}\n`)
  h.eq(row.status, 403, `必须 403（实得 ${row.status}；body=${JSON.stringify(String(row.text).slice(0, 200))}）`)
  const j = jsonOf(row)
  h.assert(j && j.ok === false, '拒绝要回 ok:false')
  if (expectCode) h.eq(j.code, expectCode, `拒法要点到 ${expectCode}（实得 ${j.code}）`)
  for (const c of ALL_CANARIES) h.assert(!String(row.text).includes(c), `拒绝正文里不许出现 canary ${c}`)
  return row
}

h.case('T07-REJECT-evil-origin-simple-form', 'pass', () => {
  needRun()
  // 简单表单：浏览器会带 Origin + navigate；**发不出自定义请求头** —— 这正是 D02 要挡的形状
  rejectOk('T07-REJECT-evil-origin-simple-form', rowAt(RUN.reject, 0), 'ORIGIN_UNTRUSTED')
  rejectOk('T07-REJECT-evil-origin-simple-form-session', rowAt(RUN.reject, 1), 'ORIGIN_UNTRUSTED')
})

h.case('T07-REJECT-evil-origin-text-plain', 'pass', () => {
  needRun()
  rejectOk('T07-REJECT-evil-origin-text-plain-ask', rowAt(RUN.reject, 2), 'ORIGIN_UNTRUSTED')
  rejectOk('T07-REJECT-evil-origin-text-plain-note', rowAt(RUN.reject, 3), 'ORIGIN_UNTRUSTED')
  rejectOk('T07-REJECT-evil-origin-text-plain-progress', rowAt(RUN.reject, 4), 'ORIGIN_UNTRUSTED')
})

h.case('T07-REJECT-null-origin', 'pass', () => {
  needRun()
  rejectOk('T07-REJECT-null-origin-ask', rowAt(RUN.reject, 5), 'ORIGIN_OPAQUE_DENIED')
  rejectOk('T07-REJECT-null-origin-session', rowAt(RUN.reject, 6), 'ORIGIN_OPAQUE_DENIED')
})

h.case('T07-REJECT-missing-capability', 'pass', () => {
  needRun()
  rejectOk('T07-REJECT-missing-capability', rowAt(RUN.reject, 7), 'CAP_MISSING')
})

h.case('T07-REJECT-wrong-scope-token', 'pass', () => {
  needRun()
  rejectOk('T07-REJECT-wrong-scope-token', rowAt(RUN.mismatch, 1), 'CAP_WRONG_SCOPE')
  needPure()
  h.eq(PURE.V.adminTokenOnReader.ok, false, 'admin 令牌打 reader 也要拒')
})

h.case('T07-REJECT-wrong-origin-token', 'pass', () => {
  needRun()
  rejectOk('T07-REJECT-wrong-origin-token', rowAt(RUN.mismatch, 2), 'CAP_WRONG_ORIGIN')
})

h.case('T07-REJECT-wrong-pack-token', 'pass', () => {
  needPure()
  const V = PURE.V
  h.evidence(path.join('cases', 'T07-REJECT-wrong-pack-token.txt'), `${JSON.stringify(V.wrongPack)}\n`)
  h.eq(V.wrongPack.ok, false, '别的课程包发的令牌必须拒')
  h.eq(V.wrongPack.code, 'CAP_WRONG_PACK', `要点到包（实得 ${V.wrongPack.code}）`)
})

h.case('T07-REJECT-tampered-token', 'pass', () => {
  needRun()
  // `wcap1.bogus.bogus` 的载荷 base64 解出来不是 JSON ⇒ `CAP_MALFORMED`（形状就不对）
  rejectOk('T07-REJECT-tampered-token', rowAt(RUN.reject, 8), 'CAP_MALFORMED')
  // 真令牌改掉签名那一段 ⇒ `CAP_BAD_SIGNATURE`（形状对、签名不对）
  rejectOk('T07-REJECT-tampered-token-http', rowAt(RUN.mismatch, 0), 'CAP_BAD_SIGNATURE')
})

h.case('T07-REJECT-expired-token', 'pass', () => {
  needPure()
  const V = PURE.V
  h.evidence(path.join('cases', 'T07-REJECT-expired-token.txt'), `${JSON.stringify(V.expired)}\n`)
  h.eq(V.expired.ok, false, '过期令牌必须拒')
  h.eq(V.expired.code, 'CAP_EXPIRED', `要点到过期（实得 ${V.expired.code}）`)
})

h.case('T07-REJECT-bad-host-dns-rebinding', 'pass', () => {
  needRun()
  rejectOk('T07-REJECT-bad-host-dns-rebinding', rowAt(RUN.reject, 9), 'HOST_NOT_LOCAL')
  needPure()
  h.eq(PURE.V.badHost.ok, false, 'Host 不是本机回环也要拒（DNS rebinding 形状）')
  h.eq(PURE.V.badHost.code, 'HOST_NOT_LOCAL', `要点到 Host（实得 ${PURE.V.badHost.code}）`)
})

h.case('T07-REJECT-file-origin-opt-in-only', 'pass', () => {
  needPure()
  const F = PURE.F
  h.evidence(path.join('cases', 'T07-REJECT-file-origin-opt-in-only.txt'),
    [`默认（不开开关）：${JSON.stringify(F.defaultDenied)}`, `显式开 + cors：${JSON.stringify(F.optInCors)}`, `显式开 + navigate：${JSON.stringify(F.optInNavigate)}`, ''].join('\n'))
  h.eq(F.defaultDenied.ok, false, '**默认不认 Origin: null**（不盲信 null）')
  h.eq(F.defaultDenied.code, 'ORIGIN_OPAQUE_DENIED', `拒法要点到 opaque（实得 ${F.defaultDenied.code}）`)
  h.eq(F.optInCors.ok, true, '显式开开关之后，浏览器的取数请求（Sec-Fetch-Mode: cors）要能拿 reader 令牌')
  h.eq(F.optInNavigate.ok, false, '**简单表单（navigate）即使开着开关也不给**（它不是取数请求）')
  h.eq(F.optInNavigate.code, 'ORIGIN_OPAQUE_NOT_FETCH', `拒法要点到取数元数据（实得 ${F.optInNavigate.code}）`)
})

h.case('T07-REJECT-admin-write-no-capability', 'pass', () => {
  needOff()
  const rows = actRows(OFF.admin, 2)
  const openNoCap = rows[5]
  const rebuildNoCap = rows[6]
  h.evidence(path.join('cases', 'T07-REJECT-admin-write-no-capability.txt'),
    `不带令牌 POST /api/open：${openNoCap.status} ${String(openNoCap.text).slice(0, 200)}\n不带令牌 POST /api/rebuild：${rebuildNoCap.status} ${String(rebuildNoCap.text).slice(0, 200)}\n`)
  h.eq(openNoCap.status, 403, '管理写口不带令牌必须 403')
  h.eq(rebuildNoCap.status, 403, '管理写口不带令牌必须 403')
  h.eq(openNoCap.json && openNoCap.json.code, 'CAP_MISSING', `拒法要点到缺令牌（实得 ${openNoCap.json && openNoCap.json.code}）`)
})

h.case('T07-REJECT-no-side-effect-tree-unchanged', 'pass', () => {
  needRun()
  const { before, after } = RUN.rejectTree
  const diff = (() => {
    const a = before.split('\n')
    const b = after.split('\n')
    const out = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`- ${a[i] || ''}\n+ ${b[i] || ''}`)
    return out.slice(0, 10).join('\n')
  })()
  h.evidence(path.join('cases', 'T07-REJECT-no-side-effect-tree-unchanged.txt'),
    `拒绝批（${RUN.reject.length} 条）前后：树相同？${before === after}\n${diff}\n`)
  h.assert(before.length > 0, '前置：快照不能是空的')
  h.eq(after, before, '**无权限跨源写入零副作用**：整棵包树必须逐字节不变')
  const twoHundred = RUN.reject.filter((r) => r.status === 200)
  h.eq(twoHundred.map((r) => r.req.path).join('、'), '', `拒绝批里一条 200 都不许有（实得 ${twoHundred.map((r) => r.req.path).join('、') || '（无）'}）`)
})

/* ================================================================ ⑥ 负向控制 */

h.case('T07-NEGCTRL-baseline-ask-evil-origin', 'pass', () => {
  needBase()
  const rows = (BASE.ask && BASE.ask.rows) || []
  const evil = rows.find((r) => r.name === 'evil-origin-text-plain')
  const form = rows.find((r) => r.name === 'evil-origin-simple-form')
  h.evidence(path.join('cases', 'T07-NEGCTRL-baseline-ask-evil-origin.txt'), [
    `基线 ${BASE_COMMIT} 的 tools/ask-server.js`,
    `evil origin + text/plain → ${JSON.stringify(evil)}`,
    `evil origin + 简单表单 → ${JSON.stringify(form)}`,
    `基线副本 questions/pending.jsonl：${JSON.stringify(BASE.askPending)}`,
    `基线副本 questions/seq.txt：${JSON.stringify(BASE.askSeq)}`,
    '',
  ].join('\n'))
  h.assert(!!evil, '前置：负向控制要真的打过这一条')
  h.eq(evil.status, 200, '**基线必须真的被 evil origin + text/plain 击穿**（这就是 D02 的漏洞）')
  h.assert(String(evil.text).includes('"ok":true'), '基线要回 ok:true（副作用真的发生了）')
  h.eq(evil.acao, null, '基线的响应里**没有** ACAO —— 可它照样写盘（"CORS 不是授权"的证据）')
  h.assert(BASE.askPending.includes(CANARY.ask), '基线副本的 questions/pending.jsonl 里要**真的**多出那一条')
  h.assert(Number(BASE.askSeq) >= 2, `基线的发号器要真的动过（实得 seq=${BASE.askSeq}）`)
})

h.case('T07-NEGCTRL-baseline-ask-null-origin-text-plain', 'pass', () => {
  needBase()
  const rows = (BASE.ask && BASE.ask.rows) || []
  const nul = rows.find((r) => r.name === 'null-origin-text-plain')
  h.evidence(path.join('cases', 'T07-NEGCTRL-baseline-ask-null-origin-text-plain.txt'),
    `基线 null origin + text/plain → ${JSON.stringify(nul)}\n基线副本 pending.jsonl：${JSON.stringify(BASE.askPending)}\n`)
  h.assert(!!nul, '前置：负向控制要真的打过这一条')
  h.eq(nul.status, 200, '**基线必须真的被 null origin + text/plain 击穿**（null 不专属于 file://）')
  h.assert(BASE.askPending.includes(`${CANARY.ask}-NULL`), '基线副本里要**真的**多出 null origin 那一条')
})

h.case('T07-NEGCTRL-baseline-clear-no-body', 'pass', () => {
  needBase()
  h.evidence(path.join('cases', 'T07-NEGCTRL-baseline-clear-no-body.txt'), [
    `基线 ${BASE_COMMIT} 的 tools/offline-server.js`,
    `无体跨源 POST /api/clear → ${JSON.stringify(BASE.clear)}`,
    `清库后 library 还在？${!BASE.libraryGone}`,
    `.trash 里：${JSON.stringify(BASE.trash)}`,
    '',
  ].join('\n'))
  h.assert(!!BASE.clear, '前置：负向控制要真的打过这一条')
  h.eq(BASE.clear.status, 200, '**基线必须真的被无体跨源 POST /api/clear 击穿**（这就是 D02 的第二条）')
  h.eq(BASE.clear.acao, null, '基线的响应里**没有** ACAO —— 可它照样把库移走')
  h.eq(BASE.libraryGone, true, '基线真的把唯一课程库移出了原位')
  h.assert(BASE.trash.length >= 1, `回收站里要真的多出一条（实得 ${JSON.stringify(BASE.trash)}）`)
})

h.case('T07-NEGCTRL-old-vs-new-diff', 'pass', () => {
  needBase()
  needRun()
  // ⚠️ 表格里的**基线**列一律取自**实测行**（不许手写一个"看起来更糟"的数字）——
  //    实测里基线那条"简单表单"是 **400**（它把非 JSON 的体当坏 JSON 拒了，**不是**被授权挡住的），
  //    真的被击穿的是 `text/plain` + JSON 体那两条与无体 `/api/clear` 那条。
  const baseAsk = (name) => (BASE.ask.rows || []).find((r) => r.name === name) || {}
  const rows = [
    ['evil origin + text/plain + JSON 体 → POST /ask', `**${baseAsk('evil-origin-text-plain').status}**（真的写盘：pending.jsonl 多出 canary）`, rowAt(RUN.reject, 2).status],
    ['null origin + text/plain + JSON 体 → POST /ask', `**${baseAsk('null-origin-text-plain').status}**（真的写盘）`, rowAt(RUN.reject, 5).status],
    ['evil origin + 简单表单（非 JSON 体）→ POST /ask', `${baseAsk('evil-origin-simple-form').status}（基线把它当坏 JSON 拒了 —— **不是**被授权挡住的）`, rowAt(RUN.reject, 0).status],
    ['同源但没令牌 → POST /ask', '（基线**根本没有令牌这个概念**）', rowAt(RUN.reject, 7).status],
    ['evil origin + text/plain + JSON 体 → POST /note', '（基线同样放行 —— 与 /ask 同一段逻辑，本次未单独复跑）', rowAt(RUN.reject, 3).status],
    ['无体跨源 POST /api/clear', `**${BASE.clear ? BASE.clear.status : 'n/a'}**（库真的进了 .trash）`, rowAt(RUN.reject, 4).status],
  ]
  const summary = [
    '# 负向控制：旧实现 vs 新实现（同一批输入形状，自建临时副本）',
    '',
    `基线实现：${BASE_COMMIT} 的 ${REL_ASK} / ${REL_OFFLINE}`,
    `包根：${PACK}（新） / ${PACK_BASE}（基线）`,
    `库：${LIB_BASE}（基线 POST /api/clear 的落点）`,
    '',
    '| 请求 | 基线（实测） | 新实现 |',
    '|---|---|---|',
    ...rows.map(([name, base, neu]) => `| \`${name}\` | ${base} | ${neu} |`),
    '',
    `基线真的写进了 pending.jsonl：${BASE.askPending.includes(CANARY.ask)}（seq.txt = ${BASE.askSeq}）`,
    `基线那两条 text/plain 响应里**没有** ACAO：${baseAsk('evil-origin-text-plain').acao === null} —— 可它照样写盘（"CORS 不是授权"）`,
    `基线真的把库移走了：${BASE.libraryGone}（.trash 里：${JSON.stringify(BASE.trash)}）`,
    `新实现：拒绝批一个 200 都没有 + 树逐字节不变：${RUN.reject.filter((r) => r.status === 200).length === 0 && RUN.rejectTree.before === RUN.rejectTree.after}`,
    '',
    '> 基线那条"简单表单"是 **400**：它把 `application/x-www-form-urlencoded` 的体当坏 JSON 拒了 ——',
    '> 那是**解析层**的拒绝，不是授权层。真正被授权缺口击穿的是 `text/plain` + JSON 体那两条',
    '> 与无体 `/api/clear` 那条（副作用真的发生了）。这三条就是 D02 的实测形状。',
    '',
  ].join('\n')
  h.evidence('negative-controls.md', summary)
  h.evidence(path.join('cases', 'T07-NEGCTRL-old-vs-new-diff.txt'), summary)
  const newTwoHundred = RUN.reject.filter((r) => r.status === 200).length
  h.eq(newTwoHundred, 0, `新实现一个 200 都不许有（实得 ${newTwoHundred}）`)
  h.eq(RUN.rejectTree.before, RUN.rejectTree.after, '新实现的树逐字节不变')
})

/* ================================================================ ⑦ 回归与夹具纪律 / 分账 */

h.case('T07-REG-t03-t04-t05-t06-still-green', 'pass', () => {
  const runs = {}
  for (const card of ['T03', 'T04', 'T05', 'T06']) {
    const r = runChild([NODE, path.join(TEST_DIR, 'audit', `${card}.mjs`)], { cwd: REPO, timeoutMs: 1800000 })
    runs[card] = r
    keepEvidence(`T07-REG-${card}-still-green`, r, {})
  }
  const line = (card) => (both(runs[card]).match(/(PASS|FAIL|BLOCKED) T\d\d[^\n]*/) || ['（没有判词）'])[0]
  h.evidence(path.join('cases', 'T07-REG-t03-t04-t05-t06-still-green.txt'),
    ['T03', 'T04', 'T05', 'T06'].map((c) => `${c}: exit=${runs[c].code} :: ${line(c)}`).join('\n') + '\n')
  for (const card of ['T03', 'T04', 'T05', 'T06']) {
    h.eq(runs[card].code, 0, `${card} 必须仍绿（exit=${runs[card].code}）：${clip(both(runs[card]), 400)}`)
  }
  h.assert(/PASS T03 checks=31 failed=0 skipped=0/.test(both(runs.T03)), `T03 判词仍是 31/0/0：${line('T03')}`)
  h.assert(/PASS T04 checks=46 failed=0 skipped=0/.test(both(runs.T04)), `T04 判词仍是 46/0/0：${line('T04')}`)
  h.assert(/PASS T05 checks=58 failed=0 skipped=0/.test(both(runs.T05)), `T05 判词仍是 58/0/0：${line('T05')}`)
  h.assert(/PASS T06 checks=36 failed=0 skipped=0/.test(both(runs.T06)), `T06 判词仍是 36/0/0：${line('T06')}`)
})

h.case('T07-REG-selftest-still-passes', 'pass', () => {
  const r = runChild([NODE, path.join(TEST_DIR, 'all.mjs'), '--selftest'], { cwd: REPO, timeoutMs: 300000 })
  keepEvidence('T07-REG-selftest-still-passes', r, {})
  h.eq(r.code, 0, `all.mjs --selftest 必须仍全绿（exit 0），实际 ${r.code}`)
  h.assert(/selftest: 17 通过 \/ 0 失败/.test(both(r)), 'selftest 仍是 17/17（判据面不许悄悄少几条）')
})

h.case('T07-BROWSER-not-verified-recorded', 'pass', () => {
  // **分账**：服务端 handler 的判据在上面；真实浏览器侧本卡**没有**做。
  // 这里把"没做"如实写进证据 —— 不用假浏览器测试冒充（铁律 8）。
  const text = [
    '# 浏览器侧证据：未验证（分账，如实记录）',
    '',
    `日期：${new Date().toISOString().slice(0, 10)}`,
    '状态：**未验证**',
    '',
    '## 本卡做了的（服务端 handler，真 HTTP）',
    '· evil / null origin、简单表单、`text/plain` 在**无权限**时 403 且整棵包树逐字节不变',
    '· 合法管理（开会话 / 打开 / 重建 / 导入 / 迁移 / 清库）与合法学生面（提问 / 笔记 / 进度）真成功',
    '· 负向控制：基线实现真被同一批输入击穿（200 + 真的写盘 / 真的移库）',
    '',
    '## 本卡**没有**做的（不许当成"已验证"）',
    '· 真实浏览器里跨站请求是否被 **PNA / LNA（Private/Local Network Access）提前拦截**：未验证',
    '  —— 所以**不宣称**所有浏览器都可被跨站攻击，也不宣称都被拦住。',
    '· 真实浏览器里 `Origin: null` 的 `file://` 页面与沙箱 iframe 的实际头形状：未验证。',
    '· 真实浏览器里简单表单 / `text/plain` fetch 的实际到达率：未验证。',
    '',
    '## 怎么补（后续卡 / 有浏览器环境时）',
    '1. 起两个来源：`node tools/offline-server.js`（管理台）与一个 `http://127.0.0.1:<别的端口>` 的恶意页；',
    '2. 恶意页用 `<form>`（简单表单）与 `fetch(..., {mode:"no-cors"})`（text/plain）打管理口；',
    '3. 记录**浏览器是否先拦**（Network 面板 / 控制台）与服务端实际收到的状态码 —— 两者都要留证；',
    '4. 用 `file://` 打开一张课程页，记录 `Origin` / `Sec-Fetch-*` 的实际值。',
    '',
  ].join('\n')
  h.evidence('browser-side-not-verified.md', text)
  h.evidence(path.join('cases', 'T07-BROWSER-not-verified-recorded.txt'), text)
  // 这条用例必须**真的**声明"未验证"：本文件里不许出现"浏览器已验证"的自称
  const self = fs.readFileSync(new URL(import.meta.url), 'utf8')
  h.eq(/browserVerified:\s*true/.test(self), false, '不许在判据里自称浏览器侧已验证')
  h.assert(/未验证/.test(text), '证据里要如实写明"未验证"')
})

h.case('T07-FIXTURE-cleanup-guard', 'pass', () => {
  // 铁律 7：清理前核实绝对路径属于本次夹具 —— 先把这条纪律本身验一遍
  const notOurs = path.join(os.tmpdir(), 'not-our-fixture-t07')
  fs.mkdirSync(notOurs, { recursive: true })
  W(path.join(notOurs, 'x.txt'), 'x')
  const refused = cleanupTempDir(notOurs, 't07')
  const ours = makeTempDir('t07-cleanup')
  const removed = cleanupTempDir(ours, 't07-cleanup')
  h.evidence(path.join('cases', 'T07-FIXTURE-cleanup-guard.txt'),
    `非本次夹具：${JSON.stringify(refused)}\n本次夹具：${JSON.stringify(removed)}\n`)
  h.eq(refused.removed, false, '不属于本次夹具的目录必须拒绝清理')
  h.assert(/拒绝清理/.test(String(refused.error)), '拒绝时要说明原因')
  h.eq(fs.existsSync(notOurs), true, '被拒绝的目录还在（没被误删）')
  h.eq(removed.removed, true, '本次夹具要能删掉')
  fs.rmSync(notOurs, { recursive: true, force: true })
})

/* ================================================================ 收尾（夹具清理 + 一行判词） */
{
  const c = cleanupTempDir(SANDBOX, 't07')
  h.note(`夹具清理：${JSON.stringify(c)}（sandbox=${SANDBOX}）`)
  h.evidence('fixture-cleanup.txt', `sandbox=${SANDBOX}\n${JSON.stringify(c, null, 2)}\n`)
}
process.exit(h.run())
