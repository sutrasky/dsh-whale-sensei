#!/usr/bin/env node
/**
 * T06.mjs —— 静态读取只读公开资源，拒绝同名前缀 / 编码分隔符 / 链接逃逸（报告 D03 / P1）
 * ==================================================================
 * 验收判据（**原文**，见 cards/T06.md）：
 *   「同根资源200；同名前缀兄弟、编码分隔符、链接出根均拒绝；不只测普通 `../` URL。」
 *
 * 怎么做才算「不是嘴上说」：
 *   - **真驱动生产入口**：把仓内模板整棵拷进临时副本（仓里 `package.json` 是 `type: module`，
 *     直接 require 那份 `.js` 会被当成 ESM —— 副本带一份 `{"type":"commonjs"}`），再
 *     `require` 副本里的 `tools/app-server.js` / `tools/public-files.cjs`，并用**真 HTTP**
 *     （`http.createServer(handler)` + `http.request`）打每一批请求 —— 不看返回值猜，看**响应字节**。
 *   - **同名前缀兄弟目录是真造的**：包根叫 `whale-pack`，兄弟叫 `whale-pack-private`，
 *     里面放 canary。旧实现的 `path.resolve(target).startsWith(ROOT)` 对它是**真放行**的
 *     （报告 D03 的实测那条 `/..%5cwhale-pack-private%5csentinel.txt`），所以它必须真的被拒。
 *   - **链接逃逸是真链接**：本机建**目录联接（junction）**指向包根之外，再请求联接后面的
 *     一个**在公开清单里**的文件（`.css`）—— 只有 realpath 真身边界能挡住它。
 *     ⚠️ 本机 `SeCreateSymbolicLinkPrivilege` 不给（`fs.symlinkSync(..., 'file'|'dir')` = EPERM），
 *     所以**文件软链**建不出来 —— 如实写进覆盖边界，不用字符串样例冒充（junction 是真 reparse point）。
 *   - **负向控制**：先在自建临时副本上跑**基线实现**（`ba22c94` 的 `tools/app-server.js`，
 *     其余模板不变），留下它**真的读出包外同名前缀兄弟目录 / 真的顺着联接读出根外文件 /
 *     真的把私人原账当静态文件吐出来**的原始输出；再证明新实现对同一批输入拒绝。
 *   - 固定用例 ID 集合写在下面 `EXPECTED_IDS` 里：缺一条、多一条、重一条都算失败。
 *
 * ⚠️ 覆盖边界（如实写出来，不冒充）：
 *   · **文件软链 / 目录软链**：本机 `symlinkSync(..., 'file'|'dir')` 一律 EPERM（无该特权），
 *     只有 junction 建得出来。链接逃逸这条判据**用真 junction 执行**；"最终分量是软链时另拒"
 *     那一分支（`lstat().isSymbolicLink()`）本机不可测 —— 它是纵深，不是本卡判据的主证。
 *   · **`assets/**` 里的派生数据模块**（`questions-data.js` / `practice-data.js`）：课程页外壳
 *     自己就 `<script src>` 它们，同源页面本来就能读 —— 本卡把"要挡的"钉在**不在页面里的
 *     原账**（`questions/` `notes/` `learning-records/`）与**私人派生页**（`reference/NOTES.html`、
 *     `reference/QUESTIONS.md`）上，派生数据模块留在公开清单里（拒了会打断页面，且挡不住任何东西）。
 *   · **作者态源课指路页**：`/lessons/src/<一个文件名>.html` 仍回一张**现场拼出来的**指路页
 *     （不读源文件一个字节）—— 这是既有产品行为（把"打开源文件没样式"的坑变成自动纠正），
 *     本卡判据只钉"源课字节不出网"（`T06-REJECT-source-lesson-not-served`）。
 *   · **活包（`--pack=`）不参与**：本卡判据全部跑在自建临时副本上，不读也不写任何活包。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T06.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 接口 / 公开清单（唯一实现 + 声明式清单 + 课程产物索引 + 私人面）
  'T06-POLICY-single-source',
  'T06-MANIFEST-declarative-not-root-scan',
  'T06-MANIFEST-lesson-index',
  'T06-MANIFEST-denies-private',
  'T06-PROFILE-admin-assets-scope',
  // ② 同根资源 200（防止靠"全拒绝"通过验收）
  'T06-ALLOW-page-index',
  'T06-ALLOW-page-starmap-dir',
  'T06-ALLOW-page-glossary-dir',
  'T06-ALLOW-page-lesson',
  'T06-ALLOW-css',
  'T06-ALLOW-font',
  'T06-ALLOW-script',
  'T06-ALLOW-image',
  'T06-ALLOW-admin-assets',
  // ③ 拒绝面：同名前缀兄弟 / 编码分隔符 / 链接出根 / 原账与私人派生页
  'T06-REJECT-dotdot-plain',
  'T06-REJECT-same-prefix-sibling',
  'T06-REJECT-encoded-separator',
  'T06-REJECT-decode-once-only',
  'T06-REJECT-link-escape-junction',
  'T06-REJECT-absolute-and-backslash',
  'T06-REJECT-control-char-and-bad-encoding',
  'T06-REJECT-source-lesson-not-served',
  'T06-REJECT-private-ledgers',
  'T06-REJECT-private-derived-pages',
  'T06-REJECT-config-and-tools',
  'T06-REJECT-no-canary-in-any-body',
  // ④ HTTP 行为：坏编码不打崩服务 / 静态读取一个字节都不写
  'T06-HTTP-bad-encoding-stays-alive',
  'T06-HTTP-read-is-read-only',
  // ⑤ 负向控制：基线真的被这些输入击穿（原始输出留证）
  'T06-NEGCTRL-baseline-same-prefix-sibling',
  'T06-NEGCTRL-baseline-encoded-separator',
  'T06-NEGCTRL-baseline-link-escape',
  'T06-NEGCTRL-baseline-serves-private',
  'T06-NEGCTRL-old-vs-new-diff',
  // ⑥ 回归与夹具纪律
  'T06-REG-t03-t04-t05-still-green',
  'T06-REG-selftest-still-passes',
  'T06-FIXTURE-cleanup-guard',
]

/** 基线 commit（cards/T06.md 钉的那一个）—— 负向控制取它的 `tools/app-server.js` */
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
const REL_APP_SERVER = 'lib/pack-template/tools/app-server.js'
const REL_OFFLINE_SERVER = 'lib/pack-template/tools/offline-server.js'
const REL_PUBLIC = 'lib/pack-template/tools/public-files.cjs'
const NODE = process.execPath
const require_ = createRequire(import.meta.url)

/** canary：每个"不该出网"的地方放一个**独一无二**的串，命中即红 */
const CANARY = {
  sibling: 'T06-CANARY-SIBLING-9f3a1c',
  outside: 'T06-CANARY-OUTSIDE-4d7e20',
  source: 'T06-CANARY-SOURCE-LESSON-77b1',
  notes: 'T06-CANARY-NOTES-2c8d55',
  questions: 'T06-CANARY-QUESTIONS-a1e904',
  intake: 'T06-CANARY-INTAKE-6b3f18',
  code: 'T06-CANARY-CODE-0d5a72',
  pack: 'T06-CANARY-PACKJSON-31c9ee',
  cfg: 'T06-CANARY-LESSONCFG-8e4b07',
  notesHtml: 'T06-CANARY-NOTESHTML-c40a91',
  questionsMd: 'T06-CANARY-QUESTIONSMD-5f27bd',
  secret: 'T06-CANARY-ROOTSECRET-9b60ac',
  lesson: 'T06-CANARY-LESSONPAGE-e215f8',
}
const ALL_CANARIES = Object.values(CANARY)

const h = createHarness({ card: 'T06', expectedIds: EXPECTED_IDS, root: REPO })
const CASE_DIR = path.join(REPO, 'audit-evidence', 'T06', 'cases')
fs.mkdirSync(CASE_DIR, { recursive: true })

const SANDBOX = makeTempDir('t06')
const W = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8') }
const WJ = (file, obj) => W(file, `${JSON.stringify(obj, null, 2)}\n`)
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const both = (r) => String(r?.out ?? '') + String(r?.err ?? '')

/** 落一份子进程 / 请求批的**完整原始输出** */
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
      let link = ''
      try { if (e.isSymbolicLink()) link = '|link' } catch { /* 读不动如实标 */ }
      if (e.isDirectory()) { out.push(`${r}|dir${link}`); walk(abs, r) } else {
        let digest = 'unreadable'
        try { digest = sha(fs.readFileSync(abs)).slice(0, 16) } catch { /* 读不动如实标 */ }
        out.push(`${r}|file|${digest}${link}`)
      }
    }
  }
  walk(root, '')
  return out.join('\n')
}

// ================================================================ 夹具：两个包根 + 同名前缀兄弟 + 根外目标
/**
 * ⚠️ 同名前缀兄弟这条**必须**用真名字：包根叫 `whale-pack`，兄弟叫 `whale-pack-private` ——
 *    旧实现的 `startsWith(ROOT)` 只有在**名字前缀相同**时才放行（`whale-pack` ⊂ `whale-pack-private`）。
 */
const NEW_DIR = path.join(SANDBOX, 'new')
const BASE_DIR = path.join(SANDBOX, 'base')
const PACK = path.join(NEW_DIR, 'whale-pack')
const PACK_BASE = path.join(BASE_DIR, 'whale-pack')
const OUTSIDE = path.join(SANDBOX, 'outside')
const SIBLING_REL = 'whale-pack-private'

const LESSON_REL = 'math/alge/0001-alge-basics.html'
const LESSON_PAGE = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>代数入门</title></head>\n`
  + `<body><h1>代数入门</h1><p>${CANARY.lesson}</p></body></html>\n`

/** 铺一个"形状完整"的课程包：模板 + 课程产物索引 + 私人面 + 同名前缀兄弟 + 根外目标 */
function layPack(root) {
  fs.cpSync(path.join(REPO, 'lib', 'pack-template'), root, { recursive: true })
  // 仓里 package.json 是 `type: module`；副本必须是 CJS，否则 require 那份 .js 会被当成 ESM
  W(path.join(root, 'package.json'), '{"type":"commonjs"}\n')
  // —— 课程产物索引 + 课程页（公开面的正例）——
  WJ(path.join(root, 'lessons', 'lessons.json'), {
    v: 1,
    source: 'lessons/src',
    lessons: [
      { rel: LESSON_REL, title: '代数入门', number: 1, halo: 'math', point: 'alge', slug: 'alge-basics' },
      // 索引本身是**不可信输入**：这两条必须被剔掉（穿越 / 指到源课）
      { rel: '../../evil.html', title: '穿越条目', number: 9 },
      { rel: 'src/math/alge/0001-alge-basics.html', title: '源课条目', number: 10 },
    ],
  })
  W(path.join(root, 'lessons', ...LESSON_REL.split('/')), LESSON_PAGE)
  // —— 明确不公开的东西（每一样一个 canary）——
  W(path.join(root, 'lessons', 'src', ...LESSON_REL.split('/')), `<p>${CANARY.source}</p>\n`)
  // 平铺形状的源文件（`lessons/src/<一个文件名>.html`）—— 既有"指路页"只认这一种形状
  W(path.join(root, 'lessons', 'src', '0001-flat-source.html'), `<p>${CANARY.source}</p>\n`)
  W(path.join(root, 'notes', 'notes.jsonl'), `{"note":"${CANARY.notes}"}\n`)
  W(path.join(root, 'questions', 'pending.jsonl'), `{"q":"${CANARY.questions}"}\n`)
  W(path.join(root, 'learning-records', 'intake.jsonl'), `{"level":"${CANARY.intake}"}\n`)
  W(path.join(root, 'learning-records', 'state.lock'), `${CANARY.intake}\n`)
  W(path.join(root, 'code', 'programming', 'spring-boot', 'EXPECT.json'), `{"project":"${CANARY.code}"}\n`)
  W(path.join(root, 'pack.json'), `{"id":"t06","canary":"${CANARY.pack}"}\n`)
  W(path.join(root, 'lesson.config.json'), `{"style":{"canary":"${CANARY.cfg}"}}\n`)
  W(path.join(root, 'reference', 'NOTES.html'), `<p>${CANARY.notesHtml}</p>\n`)
  W(path.join(root, 'reference', 'QUESTIONS.md'), `${CANARY.questionsMd}\n`)
  W(path.join(root, 'secret', 'private.txt'), `${CANARY.secret}\n`)
  W(path.join(root, 'build.log'), `${CANARY.secret}\n`)
  W(path.join(root, 'GLOSSARY.md'), '# 名词表（T06 夹具）\n\n- alge — 代数\n')
  // —— 同名前缀兄弟目录（包根之外）——
  W(path.join(path.dirname(root), SIBLING_REL, 'sentinel.txt'), `${CANARY.sibling}\n`)
  return root
}

/** 根外目标 + 每个包根里一条**真 junction**（指向根外） */
function layOutsideAndLinks() {
  W(path.join(OUTSIDE, 'leak.css'), `/* ${CANARY.outside} */\n`)
  W(path.join(OUTSIDE, 'sentinel.txt'), `${CANARY.sibling}\n`)
  const made = []
  const failed = []
  for (const root of [PACK, PACK_BASE]) {
    const link = path.join(root, 'assets', 'link-out')
    try {
      if (!fs.existsSync(link)) fs.symlinkSync(OUTSIDE, link, 'junction')
      made.push(link)
    } catch (e) { failed.push(`${link}: ${e && e.code ? e.code : e}`) }
  }
  // 文件 / 目录软链本机建不出来（无 SeCreateSymbolicLinkPrivilege）—— 如实记下来，不用字符串样例冒充
  const probe = path.join(SANDBOX, 'symlink-probe')
  fs.mkdirSync(probe, { recursive: true })
  W(path.join(probe, 'target.txt'), 'x\n')
  const symlinkSupport = {}
  for (const [kind, target, link] of [
    ['file', path.join(probe, 'target.txt'), path.join(probe, 'file-link.txt')],
    ['dir', probe, path.join(probe, 'dir-link')],
  ]) {
    try { fs.symlinkSync(target, link, kind); symlinkSupport[kind] = 'ok' } catch (e) { symlinkSupport[kind] = String(e && e.code ? e.code : e) }
  }
  return { made, failed, symlinkSupport }
}

// ================================================================ 现场准备
let FIX = null
try {
  layPack(PACK)
  layPack(PACK_BASE)
  const links = layOutsideAndLinks()
  const baseServer = runChild(['git', '-C', REPO, 'show', `${BASE_COMMIT}:${REL_APP_SERVER}`], { cwd: REPO, timeoutMs: 60000 })
  if (baseServer.code !== 0 || !String(baseServer.out).trim()) {
    throw new Error(`git show ${BASE_COMMIT}:${REL_APP_SERVER} 失败（exit=${baseServer.code}）：${clip(both(baseServer), 300)}`)
  }
  W(path.join(PACK_BASE, 'tools', 'app-server.js'), baseServer.out)
  const baseText = fs.readFileSync(path.join(PACK_BASE, 'tools', 'app-server.js'), 'utf8')
  const newText = fs.readFileSync(path.join(PACK, 'tools', 'app-server.js'), 'utf8')
  if (baseText === newText) throw new Error('基线 app-server.js 与当前实现逐字节相同（负向控制会打空）')
  FIX = { ok: true, links, baseCommit: BASE_COMMIT, sameAsNew: baseText === newText }
} catch (e) {
  FIX = { ok: false, error: `${e && e.message ? e.message : e}` }
}
if (!FIX.ok) h.block(`夹具 / 基线副本建不起来：${FIX.error}`)
const need = () => { if (!FIX.ok) throw new Error(`夹具没就绪：${FIX.error}`) }

/** 真链接是这条判据的地基：建不出来就是环境缺失（BLOCKED），不用字符串样例冒充 */
if (FIX.ok && (!FIX.links.made.length || FIX.links.failed.length)) {
  h.block(`建不出真实的目录联接（junction）：${FIX.links.failed.join('；') || '（没有一条成功）'} —— 链接逃逸判不了`)
}

// ================================================================ require 两侧实现（副本里的 CJS）
let PUB = null
let NEW_APP = null
let BASE_APP = null
let OFF_APP = null
try {
  PUB = require_(path.join(PACK, 'tools', 'public-files.cjs'))
} catch (e) { h.block(`require 副本里的 tools/public-files.cjs 失败：${e && e.message ? e.message : e}`) }
try {
  NEW_APP = require_(path.join(PACK, 'tools', 'app-server.js'))
} catch (e) { h.block(`require 副本里的 tools/app-server.js（新实现）失败：${e && e.message ? e.message : e}`) }
try {
  BASE_APP = require_(path.join(PACK_BASE, 'tools', 'app-server.js'))
} catch (e) { h.block(`require 副本里的 tools/app-server.js（基线）失败：${e && e.message ? e.message : e}`) }
try {
  OFF_APP = require_(path.join(PACK, 'tools', 'offline-server.js'))
} catch (e) { h.block(`require 副本里的 tools/offline-server.js 失败：${e && e.message ? e.message : e}`) }

// ================================================================ 真 HTTP 驱动
/**
 * 起一次真服务、打一条请求、收走。
 * @param {Function} handler 请求处理器（新 / 基线）
 * @param {string} rawPath 原始请求路径（含百分号编码）
 * @param {{wrap?:boolean}} opts `wrap` = 把 handler 包一层（**只给基线用**：它会抛 URIError，
 *   不包的话整个测试进程会被未捕获异常带走；包了才能把"它抛了"如实记下来）
 */
function httpGet(handler, rawPath, opts = {}) {
  const use = opts.wrap
    ? (req, res) => {
      try { handler(req, res) } catch (e) {
        try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`THREW:${e && e.name ? e.name : 'Error'}:${e && e.message ? e.message : e}`) } catch { /* 连接已断 */ }
      }
    }
    : handler
  return new Promise((resolve) => {
    const srv = http.createServer(use)
    let done = false
    const finish = (v) => { if (done) return; done = true; try { srv.close(() => resolve(v)) } catch { resolve(v) } }
    srv.on('error', (e) => finish({ status: 0, error: `server:${e && e.message ? e.message : e}` }))
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      let req = null
      try {
        req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', timeout: 15000 }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => finish({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
        })
      } catch (e) { return finish({ status: 0, error: `client:${e && e.message ? e.message : e}` }) }
      req.on('error', (e) => finish({ status: 0, error: `req:${e && e.message ? e.message : e}` }))
      req.on('timeout', () => { req.destroy(); finish({ status: 0, error: 'timeout' }) })
      req.end()
    })
  })
}
const get = (raw, o) => httpGet(NEW_APP.handler, raw, o)
const getBase = (raw, o) => httpGet(BASE_APP.handler, raw, { ...(o || {}), wrap: true })
/** 离线管理台那一档（`admin-assets`）：驱动**它自己的** handler（`/assets/*`） */
const getOff = (raw) => httpGet(OFF_APP.handler, raw)
const bodyOf = (r) => (r && r.buf ? r.buf.toString('utf8') : '')
const line = (r) => `${r.status} ${r.headers && r.headers['content-type'] ? r.headers['content-type'] : ''} ${bodyOf(r).slice(0, 80).replace(/\s+/g, ' ')}`

/** 一批请求：回 `{raw, status, ct, body}`，并落证据 */
async function batch(id, raws, { mode = 'new' } = {}) {
  const rows = []
  for (const raw of raws) {
    const r = mode === 'base' ? await getBase(raw) : (mode === 'offline' ? await getOff(raw) : await get(raw))
    rows.push({ raw, status: r.status, ct: r.headers ? r.headers['content-type'] : '', body: bodyOf(r), bytes: r.buf ? r.buf.length : -1, error: r.error || null })
  }
  const text = rows.map((x) => `${x.raw}\n  status=${x.status} ct=${x.ct || ''} error=${x.error || 'none'}\n  body=${JSON.stringify(x.body.slice(0, 300))}`).join('\n')
  h.evidence(path.join('cases', `${id}.txt`), `${text}\n`)
  return rows
}
const byRaw = (rows, raw) => {
  const hit = rows.find((x) => x.raw === raw)
  if (!hit) throw new Error(`请求批里没有 ${raw}`)
  return hit
}

// ================================================================ 跑请求批（一次跑齐，各用例只读）
const RUN = {}
try {
  need()
  // ① 公开面的正例（每一样都要真 200）
  RUN.allow = await batch('T06-ALLOW-batch', [
    '/', '/index.html', '/starmap/', '/glossary/',
    `/lessons/${LESSON_REL}`, '/lessons/lessons.json',
    '/assets/theme.css', '/assets/theme.js', '/assets/starmap.ico',
    '/starmap/fonts/Lanxi-JingHei.woff2', '/GLOSSARY.md', '/starmap/main.js',
  ])
  // ② 拒绝面（每一条都不许 200，且正文不许出现任何 canary）
  RUN.reject = await batch('T06-REJECT-batch', [
    // ⚠️ 普通 `../` 会被 WHATWG URL 解析器**先归一掉**（`/../x` → `/x`）—— 所以它只能证明
    //    "不是 200"；真正的穿越测的是**编码过的点 / 分隔符**（下面那几条）。这就是卡面说的
    //    「不只测普通 `../` URL」。
    '/../whale-pack-private/sentinel.txt',
    '/..%5cwhale-pack-private%5csentinel.txt',
    '/..%2fwhale-pack-private%2fsentinel.txt',
    '/%2e%2e%2fwhale-pack-private%2fsentinel.txt',
    '/..%252fwhale-pack-private%252fsentinel.txt',
    '/%252e%252e%252fwhale-pack-private%252fsentinel.txt',
    '/assets/link-out/leak.css',
    '/assets/link-out/sentinel.txt',
    '/C:/Windows/win.ini',
    '/%5c%5cserver%5cshare%5cx.txt',
    '/assets%5ctheme.css',
    '/%00',
    '/%zz',
    '/assets/%00theme.css',
    `/lessons/src/${LESSON_REL}`,
    '/lessons/src/0001-flat-source.html',
    '/lessons/src/a/b.html',
    '/lessons/src%2f0001-flat-source.html',
    '/lessons/lessons.json.bak',
    '/notes/notes.jsonl',
    '/questions/pending.jsonl',
    '/learning-records/intake.jsonl',
    '/learning-records/state.lock',
    '/code/programming/spring-boot/EXPECT.json',
    '/pack.json',
    '/lesson.config.json',
    '/build.log',
    '/reference/NOTES.html',
    '/reference/QUESTIONS.md',
    '/tools/app-server.js',
    '/tools/public-files.cjs',
    '/secret/private.txt',
  ])
  // ③ 基线（负向控制）：同一批"该被拒"的输入
  RUN.base = await batch('T06-NEGCTRL-batch', [
    '/../whale-pack-private/sentinel.txt',
    '/..%5cwhale-pack-private%5csentinel.txt',
    '/..%2fwhale-pack-private%2fsentinel.txt',
    '/assets/link-out/leak.css',
    '/notes/notes.jsonl',
    '/questions/pending.jsonl',
    '/learning-records/intake.jsonl',
    '/code/programming/spring-boot/EXPECT.json',
    '/pack.json',
    '/lesson.config.json',
    '/reference/NOTES.html',
    '/secret/private.txt',
  ], { mode: 'base' })
  // ④ admin-assets（离线管理台的 /assets/*）—— 驱动 offline-server 自己的 handler
  RUN.admin = await batch('T06-ALLOW-admin-assets-batch', [
    '/assets/theme.css', '/assets/theme.js', '/assets/starmap.ico',
  ], { mode: 'offline' })
  RUN.adminReject = await batch('T06-REJECT-admin-assets-batch', [
    '/assets/link-out/leak.css',
    '/starmap/index.html',
    '/presets/whale-sensei.css',
    '/lessons/lessons.json',
    '/assets/%00theme.css',
  ], { mode: 'offline' })
  // ⑤ 静态读取**不写盘**：整棵树前后快照（在**请求之前**取，请求之后再取）
  const before = snapTree(PACK)
  for (const raw of [
    '/', '/starmap/', '/glossary/', `/lessons/${LESSON_REL}`, '/assets/theme.css',
    '/../whale-pack-private/sentinel.txt', '/..%5cwhale-pack-private%5csentinel.txt',
    '/assets/link-out/leak.css', '/notes/notes.jsonl', '/pack.json', '/reference/NOTES.html',
    '/%zz', '/%00', '/C:/Windows/win.ini',
  ]) await get(raw)
  RUN.readonly = { before, after: snapTree(PACK), count: 14 }
} catch (e) {
  RUN.error = `${e && e.message ? e.message : e}`
}
const needRun = () => { need(); if (RUN.error) throw new Error(`请求批没跑完：${RUN.error}`) }

// ================================================================ ① 接口 / 公开清单
h.case('T06-POLICY-single-source', 'pass', () => {
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
        if (new RegExp(`function\\s+${name}\\s*\\(`).test(text)) hits.push(r)
      }
    }
    walk(path.join(REPO, 'lib'), 'lib')
    return hits
  }
  const appSrc = stripComments(fs.readFileSync(path.join(REPO, REL_APP_SERVER), 'utf8'))
  const offSrc = stripComments(fs.readFileSync(path.join(REPO, REL_OFFLINE_SERVER), 'utf8'))
  const pubSrc = stripComments(fs.readFileSync(path.join(REPO, REL_PUBLIC), 'utf8'))
  const hits = defines('resolvePublicFile')
  const rows = [
    `resolvePublicFile 的定义处：${hits.join('、') || '（无）'}`,
    `app-server 取共享件？${/require\(['"]\.\/public-files\.cjs['"]\)/.test(appSrc)}`,
    `offline-server 取共享件？${/require\(['"]\.\/public-files\.cjs['"]\)/.test(offSrc)}`,
    `public-files 走 T03 共享路径策略？${/require\(['"]\.\/path-policy\.cjs['"]\)/.test(pubSrc)}`,
    `app-server 里旧的前缀判断还在吗（去注释后）？${/path\.resolve\(target\)\.startsWith\(ROOT\)/.test(appSrc)}`,
    `offline-server 里旧的前缀判断还在吗（去注释后）？${/target\.startsWith\(ASSETS_DIR\)/.test(offSrc)}`,
    `app-server 里还有裸 decodeURIComponent(url.pathname) 吗？${/decodeURIComponent\(url\.pathname\)/.test(appSrc)}`,
    `public-files 里有递归扫盘（readdirSync）吗？${/readdirSync/.test(pubSrc)}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T06-POLICY-single-source.txt'), rows)
  h.eq(hits.join('、'), REL_PUBLIC, `静态边界只许有一份实现（实得 ${hits.join('、') || '无'}）`)
  h.assert(/require\(['"]\.\/public-files\.cjs['"]\)/.test(appSrc), 'app-server.js 必须从共享件取（不是自己写一份前缀判断）')
  h.assert(/require\(['"]\.\/public-files\.cjs['"]\)/.test(offSrc), 'offline-server.js 必须从共享件取')
  h.assert(/require\(['"]\.\/path-policy\.cjs['"]\)/.test(pubSrc), 'public-files.cjs 必须调用 T03 的共享路径策略')
  h.eq(/path\.resolve\(target\)\.startsWith\(ROOT\)/.test(appSrc), false, 'D03 那条"字符串前缀当边界"的写法必须已经不在 app-server.js 里（注释不算）')
  h.eq(/target\.startsWith\(ASSETS_DIR\)/.test(offSrc), false, 'offline-server.js 里那条同类的字符串前缀判断也必须已经不在（注释不算）')
  h.eq(/decodeURIComponent\(url\.pathname\)/.test(appSrc), false, '静态分支不许再自己裸解一次百分号编码（只解一次的契约在共享件里）')
  h.eq(/readdirSync/.test(pubSrc), false, '公开清单不许靠扫盘（readdirSync）拼出来')
})

h.case('T06-MANIFEST-declarative-not-root-scan', 'pass', () => {
  need()
  const m = PUB.publicManifest(PACK, { profile: 'reader' })
  const pubSrc = fs.readFileSync(path.join(REPO, REL_PUBLIC), 'utf8')
  const rows = [
    `profile=${m.profile} files=${JSON.stringify(m.files)}`,
    `dirs=${JSON.stringify(m.dirs)}`,
    `denied.prefixes=${JSON.stringify(m.denied.prefixes)}`,
    `清单里有没有包根自己？${m.files.includes('') || m.files.includes('.') || m.files.includes('/')}`,
    `清单里的条目数=${m.files.length}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T06-MANIFEST-declarative-not-root-scan.txt'), rows)
  h.eq(m.ok, true, '清单要算得出来')
  h.assert(m.files.length > 0 && m.files.length < 40, `清单是**点名**的，不是"包根递归"（实得 ${m.files.length} 条）`)
  h.assert(!m.files.some((f) => f === '' || f === '.' || f === '/' || f === '**'), '清单里不许出现"整根"这类条目')
  h.assert(m.dirs.length > 0 && m.dirs.every((d) => d.dir && Array.isArray(d.ext) && d.ext.length), '受信资源清单必须是（目录 + 扩展名）的声明式规则')
  h.assert(!m.files.includes('secret/private.txt') && !m.files.includes('notes/notes.jsonl'), '根下任意位置的哨兵不许进清单')
  h.assert(/递归/.test(m.note), `清单要自陈"不递归把包根设为公开目录"：${m.note}`)
  h.eq(/readdirSync/.test(pubSrc), false, '实现里不许有扫盘式枚举')
})

h.case('T06-MANIFEST-lesson-index', 'pass', () => {
  need()
  const m = PUB.publicManifest(PACK, { profile: 'reader' })
  const idxRaw = fs.readFileSync(path.join(PACK, 'lessons', 'lessons.json'), 'utf8')
  const idx = JSON.parse(idxRaw)
  const rows = [
    `索引条目：${JSON.stringify(idx.lessons.map((l) => l.rel))}`,
    `清单里有课程页？${m.files.includes(`lessons/${LESSON_REL}`)}`,
    `清单里有穿越条目吗？${m.files.some((f) => f.includes('evil.html'))}`,
    `清单里有源课条目吗？${m.files.some((f) => f.startsWith('lessons/src/'))}`,
    `清单文件：${JSON.stringify(m.files)}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T06-MANIFEST-lesson-index.txt'), rows)
  h.assert(m.files.includes(`lessons/${LESSON_REL}`), '课程产物索引里声明过的课程页必须进清单（rel 相对 lessons/）')
  h.assert(!m.files.some((f) => f.includes('evil.html')), '索引里的穿越条目必须被剔掉（索引是不可信输入）')
  h.assert(!m.files.some((f) => f.startsWith('lessons/src/')), '索引里指到源课的条目必须被剔掉')
  h.assert(m.files.includes('lessons/lessons.json'), '课程清单本身是课程产物（公开）')
})

h.case('T06-MANIFEST-denies-private', 'pass', () => {
  need()
  const denied = [
    'lessons/src/math/alge/0001-alge-basics.html',
    'code/programming/spring-boot/EXPECT.json',
    'questions/pending.jsonl',
    'notes/notes.jsonl',
    'learning-records/intake.jsonl',
    'learning-records/state.lock',
    'pack.json',
    'lesson.config.json',
    'build.log',
    'reference/NOTES.html',
    'reference/QUESTIONS.md',
    'tools/app-server.js',
    'tools/public-files.cjs',
    'secret/private.txt',
  ]
  const m = PUB.publicManifest(PACK, { profile: 'reader' })
  const rows = denied.map((rel) => `${rel}\n  isDenied=${PUB.isDenied(rel)} 在清单里=${m.files.includes(rel)}`)
  h.evidence(path.join('cases', 'T06-MANIFEST-denies-private.txt'), `${rows.join('\n')}\n`)
  for (const rel of denied) {
    h.eq(m.files.includes(rel), false, `${rel} 不许进公开清单`)
  }
  h.eq(PUB.isDenied('lessons/src/x.html'), true, '源课（lessons/src）明确不公开')
  h.eq(PUB.isDenied('lessons/src2/x.html'), false, '前缀判断要按**分量**比：lessons/src2 不是 lessons/src')
  h.assert(PUB.DENY_PREFIXES.includes('reference'), '私人派生页（reference/）必须在明确不公开的清单里')
})

h.case('T06-PROFILE-admin-assets-scope', 'pass', () => {
  need()
  const m = PUB.publicManifest(PACK, { profile: 'admin-assets' })
  const rows = [
    `admin-assets 清单：${JSON.stringify(m.files)}`,
    `admin-assets 规则：${JSON.stringify(m.dirs)}`,
    `未知 profile：${JSON.stringify(PUB.resolvePublicFile(PACK, '/assets/theme.css', { profile: 'nonsense' }))}`,
    `没有 root：${JSON.stringify(PUB.resolvePublicFile('', '/assets/theme.css', { profile: 'admin-assets' }))}`,
    '',
  ].join('\n')
  h.evidence(path.join('cases', 'T06-PROFILE-admin-assets-scope.txt'), rows)
  h.eq(m.dirs.length, 1, 'admin-assets 只认一个目录（assets/）')
  h.eq(m.dirs[0].dir, 'assets', 'admin-assets 的目录就是 assets/')
  h.eq(m.files.length, 0, 'admin-assets 不点名任何单件（只有 assets/ 那一类）')
  h.eq(PUB.resolvePublicFile(PACK, '/starmap/index.html', { profile: 'admin-assets' }).status, 404, 'admin-assets 不认 starmap/')
  h.eq(PUB.resolvePublicFile(PACK, '/index.html', { profile: 'admin-assets' }).status, 404, 'admin-assets 不认根 index.html')
  h.eq(PUB.resolvePublicFile(PACK, '/assets/theme.css', { profile: 'nonsense' }).status, 403, '未知 profile 一律拒（不静默按 reader）')
  h.eq(PUB.resolvePublicFile('', '/assets/theme.css', { profile: 'admin-assets' }).status, 403, '没有课程包根 → 拒')
})

// ================================================================ ② 同根资源 200
const allowOk = (id, raw, { ct = null, want = null } = {}) => {
  needRun()
  const r = byRaw(RUN.allow, raw)
  h.evidence(path.join('cases', `${id}.txt`), `raw=${raw}\nstatus=${r.status} ct=${r.ct}\nbody=${JSON.stringify(r.body.slice(0, 400))}\n`)
  h.eq(r.status, 200, `${raw} 必须 200（实得 ${r.status}；body=${JSON.stringify(r.body.slice(0, 120))}）`)
  if (ct) h.assert(String(r.ct).includes(ct), `${raw} 的 content-type 要含 ${ct}（实得 ${r.ct}）`)
  if (want) h.assert(r.body.includes(want), `${raw} 拿到的必须是真内容（要找 ${want}）`)
  return r
}

h.case('T06-ALLOW-page-index', 'pass', () => {
  const a = allowOk('T06-ALLOW-page-index', '/', { ct: 'text/html', want: '<html' })
  const b = allowOk('T06-ALLOW-page-index-html', '/index.html', { ct: 'text/html' })
  h.eq(a.body, b.body, '`/` 与 `/index.html` 拿到的必须是同一份（目录入口页）')
})
h.case('T06-ALLOW-page-starmap-dir', 'pass', () => {
  const r = allowOk('T06-ALLOW-page-starmap-dir', '/starmap/', { ct: 'text/html' })
  h.assert(/星图|<html/i.test(r.body), '`/starmap/` 必须是星图页（不是 404 文本）')
  h.eq(r.body, fs.readFileSync(path.join(PACK, 'starmap', 'index.html'), 'utf8'), '拿到的必须逐字节等于盘上的 starmap/index.html')
})
h.case('T06-ALLOW-page-glossary-dir', 'pass', () => {
  const r = allowOk('T06-ALLOW-page-glossary-dir', '/glossary/', { ct: 'text/html' })
  h.eq(r.body, fs.readFileSync(path.join(PACK, 'glossary', 'index.html'), 'utf8'), '拿到的必须逐字节等于盘上的 glossary/index.html')
})
h.case('T06-ALLOW-page-lesson', 'pass', () => {
  const r = allowOk('T06-ALLOW-page-lesson', `/lessons/${LESSON_REL}`, { ct: 'text/html', want: CANARY.lesson })
  h.eq(r.body, LESSON_PAGE, '课程页必须逐字节等于盘上那一份')
})
h.case('T06-ALLOW-css', 'pass', () => {
  const r = allowOk('T06-ALLOW-css', '/assets/theme.css', { ct: 'text/css' })
  h.eq(r.body, fs.readFileSync(path.join(PACK, 'assets', 'theme.css'), 'utf8'), 'CSS 必须逐字节等于盘上那一份')
})
h.case('T06-ALLOW-font', 'pass', () => {
  const r = allowOk('T06-ALLOW-font', '/starmap/fonts/Lanxi-JingHei.woff2', { ct: 'font/woff2' })
  h.eq(r.bytes, fs.statSync(path.join(PACK, 'starmap', 'fonts', 'Lanxi-JingHei.woff2')).size, '字体必须整份给出去（字节数对得上）')
})
h.case('T06-ALLOW-script', 'pass', () => {
  allowOk('T06-ALLOW-script-theme', '/assets/theme.js', { ct: 'text/javascript' })
  allowOk('T06-ALLOW-script-main', '/starmap/main.js', { ct: 'text/javascript' })
})
h.case('T06-ALLOW-image', 'pass', () => {
  allowOk('T06-ALLOW-image-ico', '/assets/starmap.ico', { ct: 'image/x-icon' })
})
h.case('T06-ALLOW-admin-assets', 'pass', () => {
  needRun()
  const r = byRaw(RUN.admin, '/assets/theme.css')
  h.evidence(path.join('cases', 'T06-ALLOW-admin-assets.txt'),
    `admin-assets：${RUN.admin.map((x) => `${x.raw}=${x.status}`).join(' ')}\n拒绝面：${RUN.adminReject.map((x) => `${x.raw}=${x.status}`).join(' ')}\n`)
  for (const x of RUN.admin) h.eq(x.status, 200, `离线管理台的 ${x.raw} 必须 200（实得 ${x.status}）`)
  h.assert(String(r.ct).includes('text/css'), 'admin-assets 的 CSS content-type 要对')
  for (const x of RUN.adminReject) h.assert(x.status !== 200, `admin-assets 不许放行 ${x.raw}（实得 ${x.status}）`)
})

// ================================================================ ③ 拒绝面
/** 一条"必须被拒"的用例：状态不许 200，正文不许出现任何 canary */
function rejectOk(id, raw) {
  needRun()
  const r = byRaw(RUN.reject, raw)
  h.evidence(path.join('cases', `${id}.txt`), `raw=${raw}\nstatus=${r.status} ct=${r.ct}\nbody=${JSON.stringify(r.body.slice(0, 400))}\n`)
  h.assert(r.status !== 200, `${raw} 必须被拒（实得 ${r.status}；body=${JSON.stringify(r.body.slice(0, 160))}）`)
  h.assert(r.status === 403 || r.status === 404, `${raw} 的拒绝码只能是 403/404（实得 ${r.status}）`)
  for (const c of ALL_CANARIES) h.assert(!r.body.includes(c), `${raw} 的正文里不许出现 canary ${c}`)
  return r
}

h.case('T06-REJECT-dotdot-plain', 'pass', () => {
  needRun()
  // ① 普通 `../`：WHATWG URL 解析器**先**把 `..` 归一掉了（`/../x` → `/x`），
  //    所以它落到"不在清单里"（404）—— 这一条只钉"不是 200"。
  const plain = rejectOk('T06-REJECT-dotdot-plain', '/../whale-pack-private/sentinel.txt')
  h.assert(plain.status !== 200, '普通 `../` 不许 200')
  h.assert(/不在公开清单里|forbidden|not found/.test(plain.body), `拒绝要如实：${plain.body.slice(0, 120)}`)
  // ② 真正的穿越：**编码过的点 + 字面斜杠**（URL 解析器不会归一它）→ 必须 403
  const enc = rejectOk('T06-REJECT-dotdot-plain-encoded', '/%2e%2e%2fwhale-pack-private%2fsentinel.txt')
  h.eq(enc.status, 403, '编码过的点 + 字面斜杠是真穿越 → 403')
  h.assert(/\.\.|穿越/.test(enc.body), `拒绝理由要点到穿越：${enc.body.slice(0, 120)}`)
})

h.case('T06-REJECT-same-prefix-sibling', 'pass', () => {
  need()
  const sentinel = path.join(NEW_DIR, SIBLING_REL, 'sentinel.txt')
  h.assert(fs.existsSync(sentinel), `夹具前提：同名前缀兄弟目录要真的在（${sentinel}）`)
  h.assert(fs.readFileSync(sentinel, 'utf8').includes(CANARY.sibling), '夹具前提：兄弟目录里的 canary 要对')
  // ⚠️ 攻击形状必须是**编码过的反斜杠**：`..%5c` 不会被 URL 解析器归一，解出来是 Windows 分隔符 ——
  //    这正是旧实现 `startsWith(ROOT)` 放行的那一条（报告 D03 实测）。
  const r = rejectOk('T06-REJECT-same-prefix-sibling', '/..%5cwhale-pack-private%5csentinel.txt')
  h.eq(r.status, 403, '同名前缀兄弟目录必须被拒（403）')
  h.eq(r.body.includes(CANARY.sibling), false, '**兄弟目录里的内容一个字节都不许出网**')
  // 正斜杠的编码形式同样拒（两条都测，免得只堵一种分隔符）
  const r2 = rejectOk('T06-REJECT-same-prefix-sibling-fs', '/..%2fwhale-pack-private%2fsentinel.txt')
  h.eq(r2.status, 403, '编码过的正斜杠同样 403')
  h.eq(r2.body.includes(CANARY.sibling), false, '兄弟目录内容一个字节都不许出网')
})

h.case('T06-REJECT-encoded-separator', 'pass', () => {
  // 报告 D03 的实测那条：`..%5c`（编码过的反斜杠）+ `..%2f`（编码过的正斜杠）+ 编码过的点
  const a = rejectOk('T06-REJECT-encoded-separator-bs', '/..%5cwhale-pack-private%5csentinel.txt')
  const b = rejectOk('T06-REJECT-encoded-separator-fs', '/..%2fwhale-pack-private%2fsentinel.txt')
  const c = rejectOk('T06-REJECT-encoded-separator-dot', '/%2e%2e%2fwhale-pack-private%2fsentinel.txt')
  for (const [name, r] of [['..%5c', a], ['..%2f', b], ['%2e%2e%2f', c]]) {
    h.eq(r.status, 403, `编码分隔符 ${name} 必须 403`)
    h.eq(r.body.includes(CANARY.sibling), false, `编码分隔符 ${name} 不许把兄弟目录内容带出来`)
  }
  h.assert(/反斜杠|穿越/.test(a.body), `编码过的反斜杠要点到"反斜杠"：${a.body.slice(0, 120)}`)
})

h.case('T06-REJECT-decode-once-only', 'pass', () => {
  // `..%252f` 解一次是 `..%2f`（字面量，不是 `../`）—— 它**不是**路径穿越，而是"不在清单里"的普通路径。
  // 这一条钉的是"只解一次"：解两次就会变成 `../`（那才是穿越）。
  const r = rejectOk('T06-REJECT-decode-once-only', '/..%252fwhale-pack-private%252fsentinel.txt')
  h.eq(r.status, 404, '`..%252f` 只解一次 → 落在清单外（404），**不是**被当成穿越（403）')
  h.eq(r.body.includes(CANARY.sibling), false, '解两次才会漏 —— 一个字节都不许出网')
  const r2 = rejectOk('T06-REJECT-decode-once-only-again', '/%252e%252e%252fwhale-pack-private%252fsentinel.txt')
  h.eq(r2.status, 404, '`%252e%252e%252f` 同理：只解一次 → 清单外')
  h.eq(r2.body.includes(CANARY.sibling), false, '一个字节都不许出网')
})

h.case('T06-REJECT-link-escape-junction', 'pass', () => {
  need()
  const link = path.join(PACK, 'assets', 'link-out')
  h.assert(fs.existsSync(link), `夹具前提：包根里要有一条真目录联接（${link}）`)
  h.assert(fs.existsSync(path.join(OUTSIDE, 'leak.css')), '夹具前提：联接后面的目标文件要真的在')
  // ⚠️ 请求的是**在公开清单里**的扩展名（.css）—— 只有真身边界能挡住它，扩展名白名单挡不住
  const r = rejectOk('T06-REJECT-link-escape-junction', '/assets/link-out/leak.css')
  h.eq(r.status, 403, '顺着目录联接读根外文件必须 403（realpath 真身边界）')
  h.assert(/软链|目录联接|之外/.test(r.body), `理由要点到真身边界：${r.body.slice(0, 160)}`)
  h.eq(r.body.includes(CANARY.outside), false, '根外文件的内容一个字节都不许出网')
  // 非公开扩展名走清单那一道（同样是"不是 200"）
  const r2 = rejectOk('T06-REJECT-link-escape-junction-txt', '/assets/link-out/sentinel.txt')
  h.assert(r2.status === 403 || r2.status === 404, '联接后面的 .txt 也不许 200')
})

h.case('T06-REJECT-absolute-and-backslash', 'pass', () => {
  const a = rejectOk('T06-REJECT-absolute-drive', '/C:/Windows/win.ini')
  const b = rejectOk('T06-REJECT-absolute-unc', '/%5c%5cserver%5cshare%5cx.txt')
  const c = rejectOk('T06-REJECT-backslash', '/assets%5ctheme.css')
  for (const [n, r] of [['盘符', a], ['UNC', b], ['反斜杠', c]]) h.eq(r.status, 403, `${n} 必须 403`)
  h.assert(/绝对路径|盘符/.test(a.body + b.body), '绝对路径的理由要说清')
  h.assert(/反斜杠/.test(c.body), `反斜杠要单独点到：${c.body.slice(0, 120)}`)
})

h.case('T06-REJECT-control-char-and-bad-encoding', 'pass', () => {
  const a = rejectOk('T06-REJECT-nul', '/%00')
  const b = rejectOk('T06-REJECT-bad-encoding', '/%zz')
  const c = rejectOk('T06-REJECT-nul-in-name', '/assets/%00theme.css')
  for (const [n, r] of [['NUL', a], ['坏编码', b], ['名字里的 NUL', c]]) h.eq(r.status, 403, `${n} 必须 403`)
  h.assert(/控制字符/.test(a.body + c.body), '控制字符的理由要说清')
  h.assert(/百分号编码/.test(b.body), `坏编码的理由要说清：${b.body.slice(0, 120)}`)
})

h.case('T06-REJECT-source-lesson-not-served', 'pass', () => {
  needRun()
  // 既有产品行为：`/lessons/src/<一个文件名>.html` 这一条**平铺**形状给一张**现场拼的**指路页（200），
  // 但它**不读源文件** —— 源课字节不出网。
  const raw = '/lessons/src/0001-flat-source.html'
  const r = byRaw(RUN.reject, raw)
  h.evidence(path.join('cases', 'T06-REJECT-source-lesson-not-served.txt'),
    `raw=${raw}\nstatus=${r.status} ct=${r.ct}\nbody=${JSON.stringify(r.body.slice(0, 400))}\n`)
  h.assert(!r.body.includes(CANARY.source), '源课内容一个字节都不许出网（指路页必须是现场拼的）')
  h.assert(/作者态源文件/.test(r.body), `这一条形状该给指路页：${r.body.slice(0, 200)}`)
  const src = fs.readFileSync(path.join(PACK, 'lessons', 'src', '0001-flat-source.html'), 'utf8')
  h.eq(r.body.includes(src.trim()), false, '响应正文里不许出现源文件本身')
  for (const c of ALL_CANARIES) h.assert(!r.body.includes(c), `指路页里不许出现任何 canary（${c}）`)
  // 真实形状（嵌套的 lessons/src/<圈>/<点>/<文件>.html）：**404**，源课字节同样不出网
  const nested = rejectOk('T06-REJECT-source-lesson-nested', `/lessons/src/${LESSON_REL}`)
  h.eq(nested.status, 404, '嵌套源课路径 → 404（不是课程页、也不给指路页）')
  h.assert(!nested.body.includes(CANARY.source), '嵌套源课的内容一个字节都不许出网')
  // 嵌套 / 编码过的源课路径**不给**指路页（不靠"看起来像"放行）
  const r2 = rejectOk('T06-REJECT-source-lesson-nested2', '/lessons/src/a/b.html')
  h.assert(!/作者态源文件/.test(r2.body), '嵌套的 lessons/src 路径不许命中指路页')
  h.eq(r2.status, 404, '嵌套源课路径 → 404')
  const r3 = rejectOk('T06-REJECT-source-lesson-encoded', '/lessons/src%2f0001-flat-source.html')
  h.assert(!/作者态源文件/.test(r3.body), '编码过的源课路径不许命中指路页')
})

h.case('T06-REJECT-private-ledgers', 'pass', () => {
  const raws = [
    '/notes/notes.jsonl', '/questions/pending.jsonl', '/learning-records/intake.jsonl',
    '/learning-records/state.lock', '/code/programming/spring-boot/EXPECT.json',
  ]
  for (const raw of raws) rejectOk(`T06-REJECT-private-ledgers${raw.replace(/[^\w]+/g, '-')}`, raw)
  const rows = raws.map((raw) => {
    const r = byRaw(RUN.reject, raw)
    return `${raw} -> ${r.status}`
  })
  h.evidence(path.join('cases', 'T06-REJECT-private-ledgers.txt'), `${rows.join('\n')}\n`)
  for (const raw of raws) h.assert(byRaw(RUN.reject, raw).status === 404, `${raw} 不在公开清单里 → 404`)
  for (const c of [CANARY.notes, CANARY.questions, CANARY.intake, CANARY.code]) {
    h.assert(!RUN.reject.some((x) => x.body.includes(c)), `canary ${c} 一个字节都不许出网`)
  }
})

h.case('T06-REJECT-private-derived-pages', 'pass', () => {
  const a = rejectOk('T06-REJECT-notes-html', '/reference/NOTES.html')
  const b = rejectOk('T06-REJECT-questions-md', '/reference/QUESTIONS.md')
  h.eq(a.status, 404, '私人派生页 reference/NOTES.html 不许当通用静态文件')
  h.eq(b.status, 404, '私人派生页 reference/QUESTIONS.md 不许当通用静态文件')
  h.eq(a.body.includes(CANARY.notesHtml), false, 'NOTES.html 的内容不许出网')
  h.eq(b.body.includes(CANARY.questionsMd), false, 'QUESTIONS.md 的内容不许出网')
})

h.case('T06-REJECT-config-and-tools', 'pass', () => {
  const raws = ['/pack.json', '/lesson.config.json', '/build.log', '/tools/app-server.js', '/tools/public-files.cjs', '/secret/private.txt']
  for (const raw of raws) rejectOk(`T06-REJECT-config-and-tools${raw.replace(/[^\w]+/g, '-')}`, raw)
  for (const raw of raws) h.eq(byRaw(RUN.reject, raw).status, 404, `${raw} 不在公开清单里 → 404`)
  for (const c of [CANARY.pack, CANARY.cfg, CANARY.secret]) {
    h.assert(!RUN.reject.some((x) => x.body.includes(c)), `canary ${c} 一个字节都不许出网`)
  }
  h.eq(PUB.isDenied('pack.json'), true, 'pack.json 明确不公开')
  h.eq(PUB.isDenied('lesson.config.json'), true, 'lesson.config.json 明确不公开')
  h.eq(PUB.isDenied('build.log'), true, '.log 明确不公开')
})

h.case('T06-REJECT-no-canary-in-any-body', 'pass', () => {
  needRun()
  const hits = []
  for (const r of [...RUN.reject, ...RUN.adminReject]) {
    for (const c of ALL_CANARIES) if (r.body.includes(c)) hits.push(`${r.raw} → ${c}`)
  }
  const all = [...RUN.reject, ...RUN.adminReject].map((x) => `${x.raw} -> ${x.status}`).join('\n')
  const twoHundred = RUN.reject.filter((x) => x.status === 200)
  h.evidence(path.join('cases', 'T06-REJECT-no-canary-in-any-body.txt'),
    `${all}\n\n200 的（只许是源课指路页）：${twoHundred.map((x) => x.raw).join('、') || '（无）'}\n命中 canary 的：${hits.join('、') || '（无）'}\n`)
  h.eq(hits.join('、'), '', `所有被拒请求的正文里，canary 必须零命中（实得 ${hits.join('、')}）`)
  // 拒绝面里唯一的 200 只许是"作者态源课指路页"（现场拼的，不读源文件）—— 其余一条 200 都不许有
  const unexpected = twoHundred.filter((x) => !/作者态源文件/.test(x.body))
  h.eq(unexpected.map((x) => x.raw).join('、'), '', `拒绝面里除了源课指路页，一条 200 都不许有（实得 ${unexpected.map((x) => x.raw).join('、') || '（无）'}）`)
  h.assert(twoHundred.length <= 1, `200 的至多一条（源课指路页）—— 实得 ${twoHundred.length} 条：${twoHundred.map((x) => x.raw).join('、')}`)
})

// ================================================================ ④ HTTP 行为
h.case('T06-HTTP-bad-encoding-stays-alive', 'pass', () => {
  needRun()
  // 坏编码：静态分支原先直接 `decodeURIComponent(url.pathname)` → URIError（越出服务边界）。
  // 现在必须**如实 403**，而且服务还能继续答话（连续两条请求都拿到响应）。
  const r1 = byRaw(RUN.reject, '/%zz')
  const r2 = byRaw(RUN.allow, '/assets/theme.css')
  h.evidence(path.join('cases', 'T06-HTTP-bad-encoding-stays-alive.txt'),
    `/%zz -> ${r1.status} ${JSON.stringify(r1.body.slice(0, 120))}\n/assets/theme.css -> ${r2.status}\n`)
  h.eq(r1.status, 403, '坏编码要如实 403（不是 500、也不是抛出去）')
  h.assert(!/THREW/.test(r1.body), '不许把异常抛给调用方')
  h.eq(r2.status, 200, '坏编码之后服务仍要答话（同一批请求里下一条还是 200）')
})

h.case('T06-HTTP-read-is-read-only', 'pass', () => {
  needRun()
  // 静态读取**不写盘**：整棵包树前后快照逐字节比（请求在 RUN 阶段已经真打过）
  const { before, after, count } = RUN.readonly
  h.evidence(path.join('cases', 'T06-HTTP-read-is-read-only.txt'),
    `请求 ${count} 条（含正例与拒绝面）\n树相同？${before === after}\n`)
  h.assert(before.length > 0, '前置：快照不能是空的')
  h.eq(after, before, '静态读取整棵树必须一个字节不变')
})

// ================================================================ ⑤ 负向控制
h.case('T06-NEGCTRL-baseline-same-prefix-sibling', 'pass', () => {
  needRun()
  // ⚠️ 攻击形状用**编码过的反斜杠**：普通 `../` 会被 URL 解析器归一掉，两边都读不到东西 ——
  //    那不是"没漏洞"，是**没测到**。编码形式才真的把 `..\` 交给 path.join。
  const r = byRaw(RUN.base, '/..%5cwhale-pack-private%5csentinel.txt')
  h.evidence(path.join('cases', 'T06-NEGCTRL-baseline-same-prefix-sibling.txt'),
    `基线 GET /..%5cwhale-pack-private%5csentinel.txt -> ${r.status}\nbody=${JSON.stringify(r.body)}\n`)
  h.eq(r.status, 200, '**基线必须真的把包外同名前缀兄弟目录读出来**（这就是 D03 的漏洞）')
  h.assert(r.body.includes(CANARY.sibling), '基线读到的必须**就是**兄弟目录里那份内容（逐字命中 canary）')
})

h.case('T06-NEGCTRL-baseline-encoded-separator', 'pass', () => {
  needRun()
  const r = byRaw(RUN.base, '/..%5cwhale-pack-private%5csentinel.txt')
  h.evidence(path.join('cases', 'T06-NEGCTRL-baseline-encoded-separator.txt'),
    `基线 GET /..%5cwhale-pack-private%5csentinel.txt -> ${r.status}\nbody=${JSON.stringify(r.body)}\n`)
  h.eq(r.status, 200, '**基线必须真的被"编码过的反斜杠"击穿**（报告 D03 的实测那条）')
  h.assert(r.body.includes(CANARY.sibling), '基线读到的必须就是兄弟目录里那份内容')
  // 新实现对同一条输入：拒绝（对照）
  const n = byRaw(RUN.reject, '/..%5cwhale-pack-private%5csentinel.txt')
  h.assert(n.status !== 200, '新实现对同一条输入必须拒绝')
})

h.case('T06-NEGCTRL-baseline-link-escape', 'pass', () => {
  needRun()
  const r = byRaw(RUN.base, '/assets/link-out/leak.css')
  h.evidence(path.join('cases', 'T06-NEGCTRL-baseline-link-escape.txt'),
    `基线 GET /assets/link-out/leak.css -> ${r.status}\nbody=${JSON.stringify(r.body)}\n`)
  h.eq(r.status, 200, '**基线必须真的顺着目录联接读出根外文件**（字符串边界看不见它）')
  h.assert(r.body.includes(CANARY.outside), '基线读到的必须就是根外那份内容')
})

h.case('T06-NEGCTRL-baseline-serves-private', 'pass', () => {
  needRun()
  const raws = [
    '/notes/notes.jsonl', '/questions/pending.jsonl', '/learning-records/intake.jsonl',
    '/code/programming/spring-boot/EXPECT.json', '/pack.json', '/lesson.config.json',
    '/reference/NOTES.html', '/secret/private.txt',
  ]
  const rows = raws.map((raw) => {
    const r = byRaw(RUN.base, raw)
    return `${raw}\n  基线 status=${r.status} body=${JSON.stringify(r.body.slice(0, 120))}`
  })
  h.evidence(path.join('cases', 'T06-NEGCTRL-baseline-serves-private.txt'), `${rows.join('\n')}\n`)
  const leaked = raws.filter((raw) => byRaw(RUN.base, raw).status === 200)
  h.eq(leaked.length, raws.length, `**基线必须真的把私人原账 / 配置 / 私人派生页当静态文件吐出来**（实得 ${leaked.length}/${raws.length}）`)
  const canaryHit = raws.filter((raw) => {
    const b = byRaw(RUN.base, raw).body
    return ALL_CANARIES.some((c) => b.includes(c))
  })
  h.eq(canaryHit.length, raws.length, `基线吐出来的正文必须逐条命中 canary（实得 ${canaryHit.length}/${raws.length}）`)
  // 新实现：同一批一个 200 都没有
  for (const raw of raws) h.assert(byRaw(RUN.reject, raw).status !== 200, `新实现不许放行 ${raw}`)
})

h.case('T06-NEGCTRL-old-vs-new-diff', 'pass', () => {
  needRun()
  const pick = [
    '/..%5cwhale-pack-private%5csentinel.txt',
    '/..%2fwhale-pack-private%2fsentinel.txt',
    '/assets/link-out/leak.css',
    '/notes/notes.jsonl',
    '/questions/pending.jsonl',
    '/learning-records/intake.jsonl',
    '/code/programming/spring-boot/EXPECT.json',
    '/pack.json',
    '/lesson.config.json',
    '/reference/NOTES.html',
    '/secret/private.txt',
  ]
  const summary = [
    '# 负向控制：旧实现 vs 新实现（同一批输入，自建临时副本）',
    '',
    `基线实现：${BASE_COMMIT} 的 ${REL_APP_SERVER}`,
    `包根：${PACK}（新） / ${PACK_BASE}（基线）`,
    `同名前缀兄弟：${path.join(NEW_DIR, SIBLING_REL)}`,
    `根外目标（目录联接 assets/link-out）：${OUTSIDE}`,
    `软链能力：junction=${FIX.links.made.length ? 'ok' : 'none'} file/dir symlink=${JSON.stringify(FIX.links.symlinkSupport)}`,
    '',
    '| 请求 | 基线 | 新实现 |',
    '|---|---|---|',
    ...pick.map((raw) => `| \`${raw}\` | ${byRaw(RUN.base, raw).status} | ${byRaw(RUN.reject, raw).status} |`),
    '',
    '基线逐条命中的 canary：',
    ...pick.map((raw) => {
      const b = byRaw(RUN.base, raw).body
      const hit = ALL_CANARIES.filter((c) => b.includes(c))
      return `  ${raw} → ${hit.length ? hit.join('、') : '（无）'}`
    }),
    '',
    '新实现逐条命中的 canary：',
    ...pick.map((raw) => {
      const b = byRaw(RUN.reject, raw).body
      const hit = ALL_CANARIES.filter((c) => b.includes(c))
      return `  ${raw} → ${hit.length ? hit.join('、') : '（无）'}`
    }),
    '',
  ].join('\n')
  h.evidence('negative-controls.md', summary)
  h.evidence(path.join('cases', 'T06-NEGCTRL-old-vs-new-diff.txt'), summary)
  const baseLeak = pick.filter((raw) => byRaw(RUN.base, raw).status === 200).length
  const newLeak = pick.filter((raw) => byRaw(RUN.reject, raw).status === 200).length
  h.assert(baseLeak >= 8, `基线至少要漏 ${8} 条（实得 ${baseLeak}）—— 差异就是这道闸`)
  h.eq(newLeak, 0, `新实现一个字节都不许漏（实得 ${newLeak}）`)
})

// ================================================================ ⑥ 回归与夹具纪律
h.case('T06-REG-t03-t04-t05-still-green', 'pass', () => {
  const runs = {}
  for (const card of ['T03', 'T04', 'T05']) {
    const r = runChild([NODE, path.join(TEST_DIR, 'audit', `${card}.mjs`)], { cwd: REPO, timeoutMs: 900000 })
    runs[card] = r
    keepEvidence(`T06-REG-${card}-still-green`, r, {})
  }
  const line = (card) => (both(runs[card]).match(/(PASS|FAIL|BLOCKED) T\d\d[^\n]*/) || ['（没有判词）'])[0]
  h.evidence(path.join('cases', 'T06-REG-t03-t04-t05-still-green.txt'),
    ['T03', 'T04', 'T05'].map((c) => `${c}: exit=${runs[c].code} :: ${line(c)}`).join('\n') + '\n')
  for (const card of ['T03', 'T04', 'T05']) {
    h.eq(runs[card].code, 0, `${card} 必须仍绿（exit=${runs[card].code}）：${clip(both(runs[card]), 400)}`)
  }
  h.assert(/PASS T03 checks=31 failed=0 skipped=0/.test(both(runs.T03)), `T03 判词仍是 31/0/0：${line('T03')}`)
  h.assert(/PASS T04 checks=46 failed=0 skipped=0/.test(both(runs.T04)), `T04 判词仍是 46/0/0：${line('T04')}`)
  h.assert(/PASS T05 checks=58 failed=0 skipped=0/.test(both(runs.T05)), `T05 判词仍是 58/0/0：${line('T05')}`)
})

h.case('T06-REG-selftest-still-passes', 'pass', () => {
  const r = runChild([NODE, path.join(TEST_DIR, 'all.mjs'), '--selftest'], { cwd: REPO, timeoutMs: 300000 })
  keepEvidence('T06-REG-selftest-still-passes', r, {})
  h.eq(r.code, 0, `all.mjs --selftest 必须仍全绿（exit 0），实际 ${r.code}`)
  h.assert(/selftest: 17 通过 \/ 0 失败/.test(both(r)), 'selftest 仍是 17/17（判据面不许悄悄少几条）')
})

h.case('T06-FIXTURE-cleanup-guard', 'pass', () => {
  // 铁律 7：清理前核实绝对路径属于本次夹具 —— 先把这条纪律本身验一遍
  const notOurs = path.join(os.tmpdir(), 'not-our-fixture-t06')
  fs.mkdirSync(notOurs, { recursive: true })
  W(path.join(notOurs, 'x.txt'), 'x')
  const refused = cleanupTempDir(notOurs, 't06')
  const ours = makeTempDir('t06-cleanup')
  const removed = cleanupTempDir(ours, 't06-cleanup')
  h.evidence(path.join('cases', 'T06-FIXTURE-cleanup-guard.txt'),
    `非本次夹具：${JSON.stringify(refused)}\n本次夹具：${JSON.stringify(removed)}\n`)
  h.eq(refused.removed, false, '不属于本次夹具的目录必须拒绝清理')
  h.assert(/拒绝清理/.test(String(refused.error)), '拒绝时要说明原因')
  h.eq(fs.existsSync(notOurs), true, '被拒绝的目录还在（没被误删）')
  h.eq(removed.removed, true, '本次夹具要能删掉')
  fs.rmSync(notOurs, { recursive: true, force: true })
})

// ================================================================ 收尾（夹具清理 + 一行判词）
{
  const c = cleanupTempDir(SANDBOX, 't06')
  h.note(`夹具清理：${JSON.stringify(c)}（sandbox=${SANDBOX}）`)
  h.evidence('fixture-cleanup.txt', `sandbox=${SANDBOX}\n${JSON.stringify(c, null, 2)}\n`)
}
process.exit(h.run())
