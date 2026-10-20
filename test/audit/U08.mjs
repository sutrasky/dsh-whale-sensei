/**
 * test/audit/U08.mjs —— 引擎升级与发布协议适配（D lane / S3）
 * ==================================================================
 * 卡面（cards/U08.md 修订版）要证明的八项，逐条**真断言**：
 *
 *   A01 两类计划（引擎升级 / 发布）都**只读**：跑前跑后夹具整树 sha256 不变，
 *       不建 `.backup` / 锁 / 日志（进程内写守卫的写记录增量 = 0）。
 *   A02 缺确认或计划均拒绝（两条独立）；**前置拒绝时共同协议一次都不被调用**（计数探针 = 0）。
 *   A03 输入变化后旧计划失效：改一个字节 ⇒ 计划摘要变 ⇒ 提交被拒，且**旧计划不覆盖新内容**。
 *   A04 暂存 / 校验 / 备份失败**不替换**既有产物（注入失败 ⇒ 原字节不变 + 明确失败码）。
 *   A05 现有码值及 CLI 原有输出契约**不被改名**：upgrade-pack 的开关/文案/退出码、
 *       publish-policy 的导出与码值（与基线 `git show 2f57b1f` 动态对拍）。
 *   A06 升级源与发布排除策略**不被放宽**：升级源只取插件模板、CLI 无任意来源开关、
 *       FROM_PACK / SANITIZE 未被抽项、私模式仍是 private、私人面表逐条未变；
 *       `package.json` 是**逐项**判据（版本 / 私模式 / 依赖面 / 锁文件逐字节，`files`/`bin`
 *       只许白名单新增且不许删既有条目，其余键整体闭合 —— Δ 见回执 decision9PackageJsonAssertion）。
 *   A07 临时绕过共同守卫后判据**必须失败**：E:\Temp 副本里让 `commit.cjs` 跳过确认闸 /
 *       摘要闸 / 锁内重建 ⇒ 同一批探针当场红；干净副本四项全绿。
 *   A08 全程夹具操作、保留完整证据：进程内写守卫（只允许 {本卡写集 ∪ 证据根 ∪ E:\Temp 本卡唯一目录}）
 *       ＋ 授权写集并集（tracked 改动 ⊆ interfaces.md §6 的并集）＋ 依赖锚点 sha256 ＋ 清理守卫。
 *
 * 判词（唯一一行）：PASS / FAIL / BLOCKED（由 `test/audit/unify-runner.mjs` 产出）。
 * 用法：
 *   node test/audit/U08.mjs
 *   node test/audit/U08.mjs --evidence-root=E:\Temp\U08-<新目录>
 *
 * ⚠️ 已登记回归（不是本卡修的，见回执）：`lib/pack-template/tools/unify/` 只由 U19 生成，
 *    而 `tools/publish-policy.cjs` 现在要 require `./unify/commit.cjs`。所以**本卡夹具**
 *    在 E:\Temp 包里逐字节复制已交付权威模块（`lib/unify/{commit,errors}.cjs`）作为**最小替代**，
 *    并在 A08 记录复制清单与 sha256 —— 不宣称随包完整。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  FIXED_IDS, Blocked, runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot,
  guardTempPath, safeRemoveTree,
} from './unify-runner.mjs'
import { writeScaffold } from '../../lib/pack-scaffold.js'

const CARD = 'U08'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const TEMPLATE_DIR = path.join(REPO, 'lib', 'pack-template')
const UPGRADE_CLI = path.join(REPO, 'tools', 'upgrade-pack.mjs')
const PUBLISH_POLICY = path.join(TEMPLATE_DIR, 'tools', 'publish-policy.cjs')
/** 执行基线（U01 锁定；只做 git 只读对拍） */
const BASE_SHA = '2f57b1f2cec02e4128b69497e3b6819d36aa707b'
const requireCJS = createRequire(import.meta.url)

/* ═══════════════════════════════════════════════════════════ 进程内写守卫 */
/**
 * 拦**本进程**的写 API，记绝对路径。目的不是"防"（防不住子进程），而是**可归因**：
 * 证明本次运行没有往 {本卡写集 ∪ 证据根 ∪ E:\Temp 本卡唯一目录} 之外写过东西。
 * 子进程（CLI 探针）的写入由**夹具整树快照**兜住。
 */
const WRITE_APIS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdir', 'copyFileSync', 'cpSync', 'renameSync',
  'rmSync', 'rmdirSync', 'unlinkSync', 'symlinkSync', 'chmodSync', 'utimesSync', 'writeFile',
  'appendFile', 'createWriteStream', 'mkdtempSync', 'mkdtemp', 'openSync', 'truncateSync',
]
const REAL_FS = {}
const WRITES = []
let guardInstalled = false

function recordWrite(api, args) {
  const push = (p) => {
    if (typeof p !== 'string' || !p) return
    WRITES.push({ api, path: path.resolve(p) })
  }
  if (api === 'renameSync') { push(args[0]); push(args[1]); return }
  if (api === 'copyFileSync' || api === 'cpSync') { push(args[1]); return }   // 源是"读"，只记目的地
  if (api === 'openSync') {
    const flags = String(args[1] === undefined ? 'r' : args[1])
    if (!/[wa+]/.test(flags)) return
    push(args[0]); return
  }
  push(args[0])
}

function installWriteGuard() {
  if (guardInstalled) return
  guardInstalled = true
  for (const api of WRITE_APIS) {
    const orig = fs[api]
    if (typeof orig !== 'function') continue
    REAL_FS[api] = orig
    fs[api] = function patched(...args) {
      try { recordWrite(api, args) } catch { /* 记录失败不许影响被测行为 */ }
      return orig.apply(fs, args)
    }
  }
}
installWriteGuard()

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => sha256(fs.readFileSync(p))
const readText = (p) => fs.readFileSync(p, 'utf8')
const writeText = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') }
const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }

/** 整棵树快照（**内容口径**：`rel` → `dir` / sha256）—— A01/A03/A04 都用它证"一个字节都没变" */
function walkTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { out.push({ rel: r, dir: true }); walk(abs, r) } else out.push({ rel: r, dir: false, abs })
    }
  }
  walk(root, '')
  return out
}
function snapTree(root) {
  const m = new Map()
  for (const e of walkTree(root)) m.set(e.rel, e.dir ? 'dir' : sha256(fs.readFileSync(e.abs)))
  return m
}
function snapJson(root) {
  return JSON.stringify([...snapTree(root)].map(([k, v]) => `${k}\t${v}`))
}
function diffSnap(a, b) {
  const out = []
  for (const [k, v] of a) { if (!b.has(k)) out.push(`缺 ${k}`); else if (b.get(k) !== v) out.push(`变 ${k}`) }
  for (const k of b.keys()) if (!a.has(k)) out.push(`多 ${k}`)
  return out
}

/* ═════════════════════════════════════════════════════════ 夹具 / 运行目录 */

const ARGV = process.argv.slice(2)
const EV = resolveEvidenceRoot(ARGV, CARD, { repoRoot: REPO })
if (!EV.ok) {
  process.stderr.write(`BLOCKED ${CARD} ${EV.error}\n`)
  process.exit(2)
}
const EVIDENCE_ROOT = EV.root
if (!fs.existsSync(path.resolve('E:\\Temp'))) {
  process.stderr.write('BLOCKED U08 本机没有 E:\\Temp（卡面规定夹具一律落这里）\n')
  process.exit(2)
}
/** 本次唯一夹具目录（先 mkdtemp 再由写守卫覆盖到） */
const SESSION = fs.mkdtempSync('E:/Temp/U08-cases-')

/** 允许的写根：证据根 ∪ 本次唯一夹具目录 */
function allowedWriteRoots() {
  return [EVIDENCE_ROOT, SESSION].map((p) => path.resolve(p))
}
function isAllowedWrite(abs) {
  const roots = allowedWriteRoots()
  if (roots.some((r) => abs === r || abs.startsWith(r + path.sep))) return true
  // `mkdtempSync('E:/Temp/U08-cases-')` 记到的是**前缀**（真实目录名由内核拼出来）——
  // 只放行 E:\Temp 下带本卡前缀的这一个形状，别的地方一律不认。
  const base = path.basename(abs)
  return path.dirname(abs) === path.resolve('E:\\Temp') && /^U08-[A-Za-z0-9._-]*$/.test(base)
}

function evDir(sub = '') {
  const d = path.join(EVIDENCE_ROOT, sub)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function writeEvidenceJson(rel, value) {
  const abs = path.join(EVIDENCE_ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return abs
}
function evText(rel, text) {
  const abs = path.join(EVIDENCE_ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${text}\n`, 'utf8')
  return abs
}

/** 复制一棵树（夹具用料：只拷**读**的东西） */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

/* ── git 只读对拍（不写 index：`git show` 是纯对象读取） ─────────────────── */
function gitShow(rel, ref = BASE_SHA) {
  const r = spawnSync('git', ['-C', REPO, 'show', `${ref}:${rel}`], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Blocked(`git show ${ref}:${rel} 取不到（exit ${r.status}）：${String(r.stderr || '').slice(0, 300)}`)
  return r.stdout
}
/** `git show` 的**字节**版本（逐字节对拍用：不经 utf8 往返）；取不到 ⇒ null，红不红由判据决定 */
function gitShowBuffer(rel, ref = BASE_SHA) {
  const r = spawnSync('git', ['-C', REPO, 'show', `${ref}:${rel}`],
    { encoding: 'buffer', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}

/**
 * 把一段 JSON 文本按**顶层成员**切开：`key → { start, end, raw }`（`raw` 是盘上的原始字符）。
 * 为什么不用 `JSON.stringify` 对拍：那会把格式化与键序差异抹平，而这里要判的正是"逐字节相同"。
 * 扫描器带字符串/转义状态机（值里的 `}` `,` 带不偏它）；调用方还会核"切出来的键集合 ==
 * `JSON.parse` 的键集合"，两道一起保证切片是真的、不是拿错位置对拍。
 */
function topLevelMembers(text) {
  const members = new Map()
  const stack = []
  let keyBuf = null
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const start = i
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '"') { i += 1; break }
        i += 1
      }
      const top = stack[stack.length - 1]
      if (top && top.kind === 'obj' && top.expectKey) {
        keyBuf = text.slice(start + 1, i - 1)
        top.expectKey = false
        continue
      }
      if (stack.length === 1 && keyBuf !== null) {
        members.set(keyBuf, { start, end: i, raw: text.slice(start, i) })
        keyBuf = null
        if (top) top.expectKey = true
      }
      continue
    }
    if (c === '{' || c === '[') {
      const isObj = c === '{'
      const isRootMember = keyBuf !== null && stack.length === 1
      stack.push({ kind: isObj ? 'obj' : 'arr', expectKey: isObj, start: i, key: isRootMember ? keyBuf : null })
      keyBuf = null
      i += 1
      continue
    }
    if (c === '}' || c === ']') {
      const closed = stack.pop()
      i += 1
      if (stack.length === 1 && closed && closed.key !== null && closed.key !== undefined) {
        members.set(closed.key, { start: closed.start, end: i, raw: text.slice(closed.start, i) })
      }
      const top = stack[stack.length - 1]
      if (top && top.kind === 'obj') top.expectKey = true
      continue
    }
    if (c === ',') {
      const top = stack[stack.length - 1]
      if (top && top.kind === 'obj') top.expectKey = true
      i += 1
      continue
    }
    if (c === ':') { i += 1; continue }   // 键与值之间的分隔符（读完键之后遇到，不是值）
    if (/\s/.test(c)) { i += 1; continue }
    // 原始量（数字 / true / false / null）
    if (stack.length === 1 && keyBuf !== null) {
      const start = i
      while (i < text.length && !/[,\s}\]]/.test(text[i])) i += 1
      members.set(keyBuf, { start, end: i, raw: text.slice(start, i) })
      keyBuf = null
      const top = stack[stack.length - 1]
      if (top) top.expectKey = true
      continue
    }
    i += 1
  }
  return members
}
function gitTrackedChanges() {
  const r = spawnSync('git', ['-C', REPO, 'status', '--porcelain=v1'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) throw new Blocked(`git status 取不到（exit ${r.status}）：${String(r.stderr || '').slice(0, 300)}`)
  const rows = []
  for (const line of String(r.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const rel = line.slice(3).trim().replace(/^"(.*)"$/, '$1')
    if (code === '??') continue
    rows.push({ code, rel })
  }
  return rows
}

/* ── 依赖锚点（A08：跑前跑后必须逐字不变） ─────────────────────────────── */
const DEPENDENCIES = [
  'lib/unify/errors.cjs',
  'lib/unify/commit.cjs',
  'lib/unify/ledger-read.cjs',
  'lib/pack-template/tools/ledger-transaction.cjs',
  'lib/pack-template/tools/engine-policy.cjs',
  'lib/pack-scaffold.js',
  'test/audit/unify-runner.mjs',
  'docs/unify/interfaces.md',
  'docs/unify/baseline.json',
  'package.json',
]
function dependencyAnchors() {
  const out = {}
  for (const rel of DEPENDENCIES) out[rel] = sha256File(path.join(REPO, rel))
  return out
}
const ANCHORS_BEFORE = dependencyAnchors()
/** 夹具里"逐字节复制权威模块"的记录（U-SPEC §5 的最小替代；不宣称随包完整） */
const COPIED_AUTHORITY = {}

/* ── 引擎包 / 发布包 / 迁移包 的夹具 ───────────────────────────────────── */

/** 引擎包：模板整棵 + lessons/ + presets/（"像课程包"的判据件），可故意改坏一件 */
function makeEnginePack(name, { tamper = true } = {}) {
  const pack = path.join(SESSION, 'engine', name)
  fs.mkdirSync(pack, { recursive: true })
  copyTree(TEMPLATE_DIR, pack)
  fs.mkdirSync(path.join(pack, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(pack, 'presets'), { recursive: true })
  if (tamper) fs.appendFileSync(path.join(pack, 'tools', 'ask-server.js'), '\n// U08 夹具：故意改坏一个字节\n', 'utf8')
  return pack
}

/** 把 U19 将来生成的包侧副本**逐字节**复制进夹具（最小替代；A08 记录清单与 sha256） */
function supplyPackUnifyCopies(pack) {
  const dir = path.join(pack, 'tools', 'unify')
  fs.mkdirSync(dir, { recursive: true })
  for (const m of ['commit.cjs', 'errors.cjs']) {
    const src = path.join(REPO, 'lib', 'unify', m)
    const dst = path.join(dir, m)
    fs.copyFileSync(src, dst)
    COPIED_AUTHORITY[`${path.basename(pack)}/tools/unify/${m}`] = sha256File(dst)
  }
}

/** 发布包：模板整棵 ∪ `writeScaffold()` 产物（产品自己的建包链） + 最小替代 + 私人面 */
function makePublicationPack(name) {
  const home = path.join(SESSION, 'publish', name)
  const pack = path.join(home, 'pack')
  fs.mkdirSync(pack, { recursive: true })
  copyTree(TEMPLATE_DIR, pack)
  const sib = path.join(home, 'scaffold')
  fs.mkdirSync(sib, { recursive: true })
  const built = writeScaffold(sib)
  if (!built.ok) throw new Blocked(`夹具：writeScaffold 失败（${built.error}）`)
  fs.cpSync(sib, pack, { recursive: true, force: false })
  supplyPackUnifyCopies(pack)
  fs.mkdirSync(path.join(pack, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(pack, 'reference'), { recursive: true })
  if (!exists(path.join(pack, 'GLOSSARY.md'))) writeText(path.join(pack, 'GLOSSARY.md'), '# 课程 名词速查笔记（GLOSSARY）\n')
  // 星图进度载荷去掉：净化链会**真跑** build-starmap-svg.js（那是 U07/U19 的生成链），本卡不需要它
  fs.rmSync(path.join(pack, 'starmap', 'content.js'), { force: true })
  // 私人面：A06 要证明它们**真的**被排掉（不是"表里写着"）
  writeText(path.join(pack, 'lesson.config.json'), '{"title":"U08 夹具"}\n')
  writeText(path.join(pack, 'progress.json'), '{"learned":[]}\n')
  writeText(path.join(pack, 'code', 'proj', 'EXPECT.json'), '{"lessons":[]}\n')
  writeText(path.join(pack, 'questions', 'pending.jsonl'), '{"id":"0001","question":"U08-CANARY-Q"}\n')
  writeText(path.join(pack, 'questions', 'seq.txt'), '1\n')
  writeText(path.join(pack, 'notes', 'notes.jsonl'), '{"id":"0001","text":"U08-CANARY-N"}\n')
  writeText(path.join(pack, 'learning-records', 'intake.jsonl'), '{"note":"U08-CANARY-I"}\n')
  const PUB = requireCJS(path.join(pack, 'tools', 'publish-policy.cjs'))
  return { home, pack, PUB }
}

/** 迁移 CLI 夹具（与 T26 的 migrateFixture 同形；只验 `--adapters` 分支没被动过） */
function makeMigrationPack(name) {
  const pack = makeEnginePack(name, { tamper: false })
  writeText(path.join(pack, 'lessons', 'a', 'halo.json'), JSON.stringify({ name: '数学', practice: { dirs: ['code/a'] }, other: { fixed: 7 } }))
  writeText(path.join(pack, 'lessons', 'a', 'p', 'point.json'), JSON.stringify({ name: '点', practice: { dirs: ['code/a/p'] }, z: '留存' }))
  writeText(path.join(pack, 'code', 'a', 'student.txt'), 'student bytes')
  return pack
}

/** 各档的 `decorate`（产物里由构建器写的那几件；与 `READER_GENERATED` / `PUBLIC_GENERATED` 同集合） */
const READER_GENERATED = ['start.cmd', 'install.cmd', 'uninstall.cmd', 'install.ps1', 'uninstall.ps1', 'admin-source.json', 'distribution-receipt.json', 'LICENSES.txt']
const PUBLIC_GENERATED = ['404.html', 'robots.txt']
function decorator(kind) {
  return (dir) => {
    for (const rel of (kind === 'reader' ? READER_GENERATED : PUBLIC_GENERATED)) writeText(path.join(dir, rel), 'U08 fixture\n')
  }
}

/* ── 子进程 ─────────────────────────────────────────────────────────────── */
function runNode(argv, { cwd = REPO, timeout = 300000 } = {}) {
  const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 })
  return {
    argv, code: r.status, signal: r.signal, timedOut: r.error && r.error.code === 'ETIMEDOUT',
    out: String(r.stdout ?? ''), err: String(r.stderr ?? ''),
    both: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`,
  }
}
function cli(args, opts) {
  return runNode([UPGRADE_CLI, ...args], opts)
}

/* ── 动态加载被测模块（引擎是插件侧 ESM；发布走**包侧副本**=权威文件的逐字节拷贝） ── */
const ENGINE = await import(pathToFileURL(path.join(REPO, 'lib', 'engine.js')).href)
const { makeFailure, NEW_CODES, FAILURE_KINDS } = requireCJS(path.join(REPO, 'lib', 'unify', 'errors.cjs'))

/* ═══════════════════════════════════════════════════════════════ 用例包装 */
function makeCase(id, body) {
  return {
    id,
    async run() {
      const started = Date.now()
      const detail = { id, asserts: [], rows: [], data: {}, ok: false, error: null }
      const ctx = {
        detail,
        data: detail.data,
        rows: (...xs) => detail.rows.push(xs.join(' ')),
        check(cond, msg) {
          const ok = !!cond
          detail.asserts.push({ ok, msg })
          if (!ok) throw new Error(msg)
        },
        eq(actual, expected, msg) {
          const ok = JSON.stringify(actual) === JSON.stringify(expected)
          detail.asserts.push({ ok, msg, actual, expected })
          if (!ok) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`)
        },
      }
      try {
        await body(ctx)
        detail.ok = true
      } catch (e) {
        detail.error = String((e && e.message) || e)
        detail.stack = String((e && e.stack) || '').split('\n').slice(0, 8).join('\n')
        throw e
      } finally {
        detail.ms = Date.now() - started
        writeEvidenceJson(path.join('cases', `${id}.json`), detail)
      }
    },
  }
}

/** 前置材料存在性（缺 → BLOCKED，不是 FAIL） */
function requireMaterial() {
  for (const p of [path.join(REPO, 'lib', 'engine.js'), UPGRADE_CLI, PUBLISH_POLICY]) {
    if (!exists(p)) throw new Blocked(`缺落点：${p}`)
  }
  for (const p of [path.join(REPO, 'lib', 'unify', 'commit.cjs'), path.join(REPO, 'lib', 'unify', 'errors.cjs')]) {
    if (!exists(p)) throw new Blocked(`缺依赖（U03/U06 交付物）：${p}`)
  }
}

/* ═══════════════════════════════════════════════════════════════════ A01 */
const A01 = makeCase('A01', async ({ check, eq, rows, data }) => {
  const cases = (data.cases = [])

  // ① 引擎升级计划：只读
  const enginePack = makeEnginePack('a01')
  const beforeEngine = snapTree(enginePack)
  const writesBefore = WRITES.length
  const planA = ENGINE.planEngineUpgrade(enginePack)
  const planB = ENGINE.planEngineUpgrade(enginePack)
  const writesAfter = WRITES.length
  const afterEngine = snapTree(enginePack)
  const dEngine = diffSnap(beforeEngine, afterEngine)
  cases.push({ what: 'engine-plan', ok: planA.ok, writes: writesAfter - writesBefore, treeDiff: dEngine })
  eq(dEngine.length, 0, `引擎升级计划只读：夹具整树 sha256 必须一字不变（差异：${dEngine.slice(0, 5).join('、')}）`)
  eq(writesAfter - writesBefore, 0, '引擎升级计划期间进程内**零写调用**')
  eq(planA.planDigest, planB.planDigest, '同一输入两次计划摘要相同（计划是纯计算）')
  eq(planA.commit.schema, 'whale-commit/1', '计划身份来自 U06 共同协议（schema=whale-commit/1）')
  eq(planA.source, path.resolve(TEMPLATE_DIR), '升级源只能是插件模板')
  eq(planA.upToDate, false, '改坏的夹具包不该是 upToDate')
  for (const leftover of ['.engine-backup-', '.whale-txn', '.whale-write.lock', '.tmp-engine-']) {
    const hits = fs.readdirSync(enginePack).filter((n) => n.startsWith(leftover))
    eq(hits.length, 0, `计划不许建 ${leftover}（实得 ${hits.join('、') || '无'}）`)
  }

  // ② 发布计划：只读
  const pub = makePublicationPack('a01')
  const beforePub = snapTree(pub.pack)
  const writesBeforePub = WRITES.length
  const pubPlanPublic = pub.PUB.planPublication(pub.pack, { kind: 'public' })
  const pubPlanReader = pub.PUB.planPublication(pub.pack, { kind: 'reader', withNode: false })
  const writesAfterPub = WRITES.length
  const afterPub = snapTree(pub.pack)
  const dPub = diffSnap(beforePub, afterPub)
  cases.push({ what: 'publication-plan', ok: true, writes: writesAfterPub - writesBeforePub, treeDiff: dPub })
  eq(dPub.length, 0, `发布计划只读：夹具整树 sha256 必须一字不变（差异：${dPub.slice(0, 5).join('、')}）`)
  eq(writesAfterPub - writesBeforePub, 0, '发布计划期间进程内**零写调用**')
  eq(pubPlanPublic.commit.schema, 'whale-commit/1', '发布计划身份同样来自 U06 共同协议')
  eq(pubPlanReader.commit.schema, 'whale-commit/1', 'reader 档计划身份同样来自 U06 共同协议')
  eq(pubPlanPublic.schema, 'whale-publication/1', '发布计划对外 shape 不变（schema=whale-publication/1）')
  for (const leftover of ['.whale-txn', '.whale-write.lock', '.tmp-publication-']) {
    const hits = fs.readdirSync(pub.pack).filter((n) => n.startsWith(leftover))
    eq(hits.length, 0, `发布计划不许建 ${leftover}（实得 ${hits.join('、') || '无'}）`)
  }
  rows(`引擎计划 files=${planA.files.length} digest=${planA.planDigest.slice(0, 12)}…`)
  rows(`发布计划 public files=${pubPlanPublic.files.length} reader files=${pubPlanReader.files.length}`)
  writeEvidenceJson('cases/A01-evidence.json', { cases, copiedAuthority: COPIED_AUTHORITY })
})

/* ═══════════════════════════════════════════════════════════════════ A02 */
const A02 = makeCase('A02', async ({ check, eq, rows, data }) => {
  const detail = Object.assign(data, { engine: [], publication: [] })

  // ① 引擎：缺确认 → 拒；共同协议**一次都不被调用**
  {
    const pack = makeEnginePack('a02-confirm')
    const plan = ENGINE.planEngineUpgrade(pack)
    const before = snapJson(pack)
    let calls = 0
    const probe = { withPackTransaction() { calls += 1; return { ok: false, state: 'rejected', error: 'U08 计数探针：不该被调用' } } }
    const r = ENGINE.applyEngineUpgrade(pack, { confirm: false, planDigest: plan.planDigest, transaction: probe })
    detail.engine.push({ what: 'no-confirm', ok: r.ok, code: r.code, calls, same: snapJson(pack) === before })
    eq(r.ok, false, '引擎升级：缺 --confirm 必须拒')
    eq(r.code, 'CONFIRM_REQUIRED', '引擎升级：缺确认的码必须是既有 CONFIRM_REQUIRED（不改名）')
    check(/--confirm/.test(String(r.error)), `拒绝文案要点名 --confirm（实得 ${r.error}）`)
    eq(calls, 0, '前置拒绝时共同协议调用次数必须为 **0**')
    eq(snapJson(pack), before, '被拒时夹具一个字节都不许动')
  }

  // ② 引擎：缺计划摘要 → 拒（与"缺确认"独立的一条）
  {
    const pack = makeEnginePack('a02-digest')
    writeText(path.join(pack, 'lessons', 'README.md'), 'x\n')
    const before = snapJson(pack)
    let calls = 0
    const probe = { withPackTransaction() { calls += 1; return { ok: false, state: 'rejected', error: 'U08 计数探针：不该被调用' } } }
    const r = ENGINE.applyEngineUpgrade(pack, { confirm: true, planDigest: '', transaction: probe })
    detail.engine.push({ what: 'no-digest', ok: r.ok, code: r.code, calls, same: snapJson(pack) === before })
    eq(r.ok, false, '引擎升级：缺计划摘要必须拒')
    eq(r.code, 'PLAN_STALE', '引擎升级：缺摘要走既有 PLAN_STALE（不回落到新码）')
    check(/计划摘要/.test(String(r.error)), `拒绝文案要点名"计划摘要"（实得 ${r.error}）`)
    eq(calls, 0, '缺摘要时共同协议调用次数必须为 **0**')
    eq(snapJson(pack), before, '被拒时夹具一个字节都不许动')
  }

  // ③ 发布：缺确认 → 拒；提交调用 0 次
  {
    const pub = makePublicationPack('a02')
    const plan = pub.PUB.planPublication(pub.pack, { kind: 'public' })
    const outDir = path.join(pub.home, 'out')
    writeText(path.join(outDir, 'sentinel.txt'), '既有产物不许被碰\n')
    const before = snapJson(outDir)
    let calls = 0
    const probe = { withPackTransaction() { calls += 1; return { ok: false, state: 'rejected', error: 'U08 计数探针：不该被调用' } } }
    const r = pub.PUB.applyPublication(pub.pack, plan, { transaction: probe })
    detail.publication.push({ what: 'no-confirm', ok: r.ok, code: r.code, calls, same: snapJson(outDir) === before })
    eq(r.ok, false, '发布：缺 confirm 必须拒')
    eq(r.code, 'CONFIRM_REQUIRED', '发布：缺确认的码必须是既有 CONFIRM_REQUIRED')
    eq(calls, 0, '发布前置拒绝时共同协议调用次数必须为 **0**')
    eq(snapJson(outDir), before, '发布被拒时既有产物逐字节不变')
  }

  // ④ 发布：缺计划 → 拒（独立一条；不需要 confirm）
  {
    const pub = makePublicationPack('a02b')
    let calls = 0
    const probe = { withPackTransaction() { calls += 1; return { ok: false, state: 'rejected' } } }
    const r = pub.PUB.applyPublication(pub.pack, { kind: 'public', root: pub.pack }, { confirm: true, transaction: probe })
    detail.publication.push({ what: 'no-plan', ok: r.ok, code: r.code, calls })
    eq(r.ok, false, '发布：没有计划（无 planDigest）必须拒')
    eq(r.code, 'PLAN_REQUIRED', '发布：缺计划的码必须是既有 PLAN_REQUIRED')
    eq(calls, 0, '缺计划时共同协议调用次数必须为 **0**')
  }

  rows(`引擎两条：${detail.engine.map((x) => `${x.what}→${x.code}/calls=${x.calls}`).join(' · ')}`)
  rows(`发布两条：${detail.publication.map((x) => `${x.what}→${x.code}/calls=${x.calls}`).join(' · ')}`)
  writeEvidenceJson('cases/A02-evidence.json', detail)
})

/* ═══════════════════════════════════════════════════════════════════ A03 */
const A03 = makeCase('A03', async ({ check, eq, rows, data }) => {
  const detail = data

  // ① 引擎：改一个字节 → 摘要变 → 旧计划不覆盖新内容
  {
    const pack = makeEnginePack('a03')
    const plan = ENGINE.planEngineUpgrade(pack)
    const target = path.join(pack, 'tools', 'build-notes.js')
    const base = fs.readFileSync(target)
    const injected = Buffer.concat([base, Buffer.from('\n// U08 · A03 在计划之后改的一个字节\n')])
    fs.writeFileSync(target, injected)
    const planAfter = ENGINE.planEngineUpgrade(pack)
    const r = ENGINE.applyEngineUpgrade(pack, { confirm: true, planDigest: plan.planDigest })
    const now = fs.readFileSync(target)
    detail.engine = {
      digestBefore: plan.planDigest, digestAfter: planAfter.planDigest,
      changed: plan.planDigest !== planAfter.planDigest,
      ok: r.ok, code: r.code, error: String(r.error).slice(0, 200),
      preserved: now.equals(injected),
    }
    check(plan.planDigest !== planAfter.planDigest, '改一个字节之后重算的计划摘要必须变（摘要覆盖输入字节）')
    eq(r.ok, false, '旧计划提交必须被拒')
    eq(r.code, 'PLAN_STALE', '旧计划的拒码必须是既有 PLAN_STALE')
    check(/过期|对不上/.test(String(r.error)), `拒绝文案要说明"过期或对不上"（实得 ${r.error}）`)
    eq(now.equals(injected), true, '**旧计划不许覆盖新内容**：被改的那一字节必须还在')
  }

  // ② 发布：改一字节 → 摘要变 → 旧计划被拒且既有产物不变
  {
    const pub = makePublicationPack('a03')
    const plan = pub.PUB.planPublication(pub.pack, { kind: 'public' })
    const outDir = path.join(pub.home, 'out')
    writeText(path.join(outDir, 'sentinel.txt'), '既有产物（A03 必须活下来）\n')
    const beforeOut = snapJson(outDir)
    const target = path.join(pub.pack, 'GLOSSARY.md')
    fs.appendFileSync(target, ' ', 'utf8')
    const planAfter = pub.PUB.planPublication(pub.pack, { kind: 'public' })
    const r = pub.PUB.applyPublication(pub.pack, plan, { confirm: true, outDir })
    detail.publication = {
      digestBefore: plan.planDigest, digestAfter: planAfter.planDigest,
      changed: plan.planDigest !== planAfter.planDigest,
      ok: r.ok, code: r.code, error: String(r.error).slice(0, 200),
      outSame: snapJson(outDir) === beforeOut,
      sourceKept: fs.readFileSync(target, 'utf8').endsWith(' '),
    }
    check(plan.planDigest !== planAfter.planDigest, '发布：改一个字节之后计划摘要必须变')
    eq(r.ok, false, '发布：旧计划提交必须被拒')
    eq(r.code, 'PLAN_STALE', '发布：旧计划的拒码必须是既有 PLAN_STALE')
    eq(detail.publication.outSame, true, '发布旧计划被拒时既有产物逐字节不变')
    eq(detail.publication.sourceKept, true, '发布旧计划被拒时源包那个字节必须还在')
  }

  rows(`引擎：${detail.engine.digestBefore.slice(0, 10)}… → ${detail.engine.digestAfter.slice(0, 10)}… code=${detail.engine.code}`)
  rows(`发布：${detail.publication.digestBefore.slice(0, 10)}… → ${detail.publication.digestAfter.slice(0, 10)}… code=${detail.publication.code}`)
  writeEvidenceJson('cases/A03-evidence.json', detail)
})

/* ═══════════════════════════════════════════════════════════════════ A04 */
const A04 = makeCase('A04', async ({ check, eq, rows, data }) => {
  const detail = Object.assign(data, { engine: [], publication: [] })

  // ① 引擎 · 备份失败 ⇒ 一件都不替换
  {
    const pack = makeEnginePack('a04-backup')
    const plan = ENGINE.planEngineUpgrade(pack)
    const before = snapJson(pack)
    const target = path.join(pack, 'tools', 'ask-server.js')
    const beforeTarget = fs.readFileSync(target)
    const stamp = '9999999999999'
    writeText(path.join(pack, `.engine-backup-${stamp}`), '这个文件故意占着备份目录的落点\n')
    const beforeWithBlocker = snapJson(pack)
    const r = ENGINE.applyEngineUpgrade(pack, { confirm: true, planDigest: plan.planDigest, now: () => Number(stamp) })
    detail.engine.push({
      what: 'backup-fail', ok: r.ok, code: r.code, state: r.state,
      error: String(r.error).slice(0, 200), unchanged: fs.readFileSync(target).equals(beforeTarget),
      treeSameAsBlocked: snapJson(pack) === beforeWithBlocker,
    })
    eq(r.ok, false, '备份失败必须如实拒绝')
    eq(r.code, 'IO_ERROR', '备份失败的码必须是既有 IO_ERROR')
    check(/备份失败/.test(String(r.error)), `拒绝文案要点名备份失败（实得 ${r.error}）`)
    eq(fs.readFileSync(target).equals(beforeTarget), true, '备份失败时被替换件必须还是原字节')
    eq(snapJson(pack), beforeWithBlocker, '备份失败时夹具一个字节都不许动')
    check(before.length >= 0 && exists(path.join(pack, `.engine-backup-${stamp}`)), '占位文件还在（没有把它删掉当"清理"）')
  }

  // ② 引擎 · 暂存失败 ⇒ 事务回滚、原字节不变
  {
    const pack = makeEnginePack('a04-stage')
    const plan = ENGINE.planEngineUpgrade(pack)
    const target = path.join(pack, 'tools', 'ask-server.js')
    const beforeTarget = fs.readFileSync(target)
    const before = snapJson(pack)
    const injected = { ...fs }
    for (const k of Object.keys(REAL_FS)) injected[k] = fs[k]
    injected.writeFileSync = function patchedStaging(p, ...rest) {
      if (String(p).includes('.tmp-txn-')) {
        const e = new Error('U08 注入：暂存阶段失败')
        e.code = 'EACCES'
        throw e
      }
      return REAL_FS.writeFileSync.call(fs, p, ...rest)
    }
    const r = ENGINE.applyEngineUpgrade(pack, { confirm: true, planDigest: plan.planDigest, fs: injected })
    detail.engine.push({
      what: 'stage-fail', ok: r.ok, code: r.code, state: r.state, rolledBack: r.rolledBack,
      error: String(r.error).slice(0, 200), unchanged: fs.readFileSync(target).equals(beforeTarget),
      engineFaultLeftover: fs.readdirSync(pack).filter((n) => n.startsWith('.tmp-engine-')),
    })
    eq(r.ok, false, '暂存失败必须如实拒绝')
    eq(r.code, 'IO_ERROR', '暂存失败的码必须是既有 IO_ERROR（事务回滚）')
    eq(r.state, 'rolled-back', '暂存失败必须落在事务件的 rolled-back 态')
    eq(fs.readFileSync(target).equals(beforeTarget), true, '暂存失败时被替换件必须还是原字节')
    eq(detail.engine.at(-1).engineFaultLeftover.length, 0, '暂存失败不许留 .tmp-engine-* 临时件')
    check(before.length > 0, '夹具快照非空（判据不是空转）')
  }

  // ③ 引擎 · 校验失败（模板字节漂移）⇒ 拒绝且原字节不变
  {
    const pack = makeEnginePack('a04-verify')
    const plan = ENGINE.planEngineUpgrade(pack)
    const target = path.join(pack, 'tools', 'ask-server.js')
    const beforeTarget = fs.readFileSync(target)
    const driftTarget = path.join(TEMPLATE_DIR, 'tools', 'ask-server.js')
    const injected = { ...fs }
    for (const k of Object.keys(REAL_FS)) injected[k] = fs[k]
    injected.readFileSync = function patchedDrift(p, ...rest) {
      const buf = fs.readFileSync(p, ...rest)
      if (path.resolve(String(p)) === path.resolve(driftTarget)) return Buffer.concat([buf, Buffer.from('\n// U08 注入：模板漂移\n')])
      return buf
    }
    const r = ENGINE.applyEngineUpgrade(pack, { confirm: true, planDigest: plan.planDigest, fs: injected })
    detail.engine.push({
      what: 'verify-fail', ok: r.ok, code: r.code, error: String(r.error).slice(0, 200),
      unchanged: fs.readFileSync(target).equals(beforeTarget),
    })
    eq(r.ok, false, '校验失败（模板字节漂移）必须拒')
    eq(r.code, 'PLAN_STALE', '校验失败的码必须是既有 PLAN_STALE')
    eq(fs.readFileSync(target).equals(beforeTarget), true, '校验失败时被替换件必须还是原字节')
  }

  // ④ 发布 · 暂存失败（decorate 抛）⇒ 既有产物不变、不留暂存目录
  {
    const pub = makePublicationPack('a04-stage')
    const plan = pub.PUB.planPublication(pub.pack, { kind: 'public' })
    const outDir = path.join(pub.home, 'out')
    writeText(path.join(outDir, 'sentinel.txt'), '既有产物（A04 必须活下来）\n')
    const before = snapJson(outDir)
    const r = pub.PUB.applyPublication(pub.pack, plan, {
      confirm: true, outDir,
      decorate: () => { throw new Error('U08 注入：暂存阶段写到一半失败') },
    })
    detail.publication.push({
      what: 'stage-fail', ok: r.ok, code: r.code, error: String(r.error).slice(0, 200),
      outSame: snapJson(outDir) === before,
      tmpLeft: fs.readdirSync(pub.pack).filter((n) => n.startsWith('.tmp-publication-')),
    })
    eq(r.ok, false, '发布暂存失败必须如实拒绝')
    eq(r.code, 'STAGE_FAILED', '发布暂存失败的码必须是既有 STAGE_FAILED')
    eq(detail.publication.at(-1).outSame, true, '发布暂存失败时既有产物逐字节不变')
    eq(detail.publication.at(-1).tmpLeft.length, 0, '发布暂存失败后不许留 .tmp-publication-* 目录')
  }

  // ⑤ 发布 · 校验失败（verify 抛）⇒ 既有产物不变
  {
    const pub = makePublicationPack('a04-verify')
    const plan = pub.PUB.planPublication(pub.pack, { kind: 'public' })
    const outDir = path.join(pub.home, 'out')
    writeText(path.join(outDir, 'sentinel.txt'), '既有产物（A04 校验失败必须活下来）\n')
    const before = snapJson(outDir)
    const r = pub.PUB.applyPublication(pub.pack, plan, {
      confirm: true, outDir,
      verify: () => { throw new Error('U08 注入：产物校验失败') },
    })
    detail.publication.push({
      what: 'verify-fail', ok: r.ok, code: r.code, error: String(r.error).slice(0, 200),
      outSame: snapJson(outDir) === before,
    })
    eq(r.ok, false, '发布校验失败必须如实拒绝')
    eq(r.code, 'STAGE_FAILED', '发布校验失败的码必须是既有 STAGE_FAILED')
    eq(detail.publication.at(-1).outSame, true, '发布校验失败时既有产物逐字节不变')
  }

  rows(`引擎：${detail.engine.map((x) => `${x.what}→${x.code}/${x.state ?? '-'}`).join(' · ')}`)
  rows(`发布：${detail.publication.map((x) => `${x.what}→${x.code}`).join(' · ')}`)
  writeEvidenceJson('cases/A04-evidence.json', detail)
})

/* ═══════════════════════════════════════════════════════════════════ A05 */
const A05 = makeCase('A05', async ({ check, eq, rows, data }) => {
  const detail = Object.assign(data, { cli: [], codes: {}, exports: {}, baseline: {} })

  /* ① 引擎 CLI 的开关 / 文案 / 退出码（interfaces.md §2 的 stdout 契约） */
  const cliPack = makeEnginePack('a05')
  {
    const help = cli(['--help'])
    detail.cli.push({ argv: help.argv, code: help.code, first: help.out.split('\n')[0] })
    eq(help.code, 0, '--help 必须 exit 0')
    check(help.out.includes(UPGRADE_CLI), '--help 里打的入口必须是本文件绝对路径')
    check(help.out.includes('dsh-whale-pack'), '--help 里必须给出 bin 名 dsh-whale-pack')
    check(help.out.includes('--apply --confirm --plan-digest='), '--help 里必须保住两步机制')
    check(!/node tools\//.test(help.out), '--help 里不许出现仓根相对路径')
  }
  {
    const planRun = cli([`--root=${cliPack}`, '--plan'])
    detail.cli.push({ argv: planRun.argv, code: planRun.code, first: planRun.out.split('\n')[0] })
    eq(planRun.code, 0, '--plan 必须 exit 0')
    const m = /^PLAN ok=true digest=([0-9a-f]{64}) files=(\d+)$/m.exec(planRun.out)
    check(!!m, `--plan 的 stdout 契约必须逐字保住（实得 ${planRun.out.split('\n')[0]}）`)
    check(m && Number(m[2]) >= 1, '--plan 必须列出一件以上要动的件')
    const digest = m ? m[1] : ''
    const jsonRun = cli([`--root=${cliPack}`, '--plan', '--json'])
    const lastLine = jsonRun.out.trim().split('\n').at(-1)
    let parsed = null
    try { parsed = JSON.parse(lastLine) } catch { parsed = null }
    eq(jsonRun.code, 0, '--plan --json 必须 exit 0')
    eq(parsed && parsed.op, 'plan', '--json 的最后一行必须是 op:"plan" 的 JSON')
    eq(parsed && parsed.planDigest, digest, '--json 的 digest 与 PLAN 行一致')

    const noConfirm = cli([`--root=${cliPack}`, '--apply', `--plan-digest=${digest}`])
    detail.cli.push({ argv: noConfirm.argv, code: noConfirm.code, fail: noConfirm.err.trim().split('\n')[0] })
    eq(noConfirm.code, 1, '缺 --confirm 必须 exit 1')
    check(/^FAIL /m.test(noConfirm.err), '缺 --confirm 必须以 FAIL 一行报错')
    check(/--confirm/.test(noConfirm.err), '缺 --confirm 的文案要点名 --confirm')

    const badDigest = cli([`--root=${cliPack}`, '--apply', '--confirm', `--plan-digest=${'f'.repeat(64)}`])
    detail.cli.push({ argv: badDigest.argv, code: badDigest.code })
    eq(badDigest.code, 1, '错摘要必须 exit 1')

    const noRoot = cli(['--plan'])
    eq(noRoot.code, 2, '缺 --root 必须 exit 2（用法错）')
    const ghostRoot = cli([`--root=${path.join(SESSION, 'no-such-dir')}`, '--plan'])
    eq(ghostRoot.code, 2, '课程包根不存在必须 exit 2（材料缺失）')
    const notPack = path.join(SESSION, 'not-a-pack')
    fs.mkdirSync(notPack, { recursive: true })
    writeText(path.join(notPack, 'hello.txt'), 'x\n')
    const notPackRun = cli([`--root=${notPack}`, '--plan'])
    eq(notPackRun.code, 2, '不像课程包的目录必须 exit 2')

    const applyRun = cli([`--root=${cliPack}`, '--apply', '--confirm', `--plan-digest=${digest}`])
    detail.cli.push({ argv: applyRun.argv, code: applyRun.code, first: applyRun.out.split('\n')[0] })
    eq(applyRun.code, 0, `--apply 必须 exit 0（实得 ${applyRun.code}：${applyRun.both.slice(0, 300)}）`)
    const applyLine = /^APPLY ok=true digest=[0-9a-f]{64} replaced=(\d+) added=(\d+) backup=(.+)$/m.exec(applyRun.out)
    check(!!applyLine, `APPLY 的 stdout 契约必须逐字保住（实得 ${applyRun.out.split('\n')[0]}）`)
    eq(ENGINE.verifyEngine(cliPack, ENGINE.trustedManifest()).ok, true, 'CLI 升级之后引擎核验必须通过')

    const afterPlan = cli([`--root=${cliPack}`, '--plan'])
    check(/PLAN ok=true digest=[0-9a-f]{64} files=0/.test(afterPlan.out), '升级完成后再算计划必须是 files=0（幂等）')
  }

  /* ② `--adapters` 迁移分支（T26 的 CLI 契约）不被影响 */
  {
    const migPack = makeMigrationPack('a05')
    const planRun = cli([`--root=${migPack}`, '--adapters=jvm', '--plan', '--json'])
    detail.cli.push({ argv: planRun.argv, code: planRun.code, first: planRun.out.split('\n')[0] })
    eq(planRun.code, 0, `--adapters=jvm --plan 必须 exit 0（实得 ${planRun.code}：${planRun.both.slice(0, 200)}）`)
    const m = /^PLAN ok=true digest=([0-9a-f]{64}) files=(\d+)$/m.exec(planRun.out)
    check(!!m, `--adapters 的 PLAN 行必须逐字保住（实得 ${planRun.out.split('\n')[0]}）`)
    const digest = m ? m[1] : ''
    const noConfirm = cli([`--root=${migPack}`, '--adapters=jvm', '--apply', `--plan-digest=${digest}`])
    eq(noConfirm.code, 1, '--adapters 缺 --confirm 必须 exit 1')
    const applyRun = cli([`--root=${migPack}`, '--adapters=jvm', '--apply', '--confirm', `--plan-digest=${digest}`])
    detail.cli.push({ argv: applyRun.argv, code: applyRun.code, first: applyRun.out.split('\n')[0] })
    eq(applyRun.code, 0, `--adapters 显式提交必须 exit 0（实得 ${applyRun.code}：${applyRun.both.slice(0, 200)}）`)
    check(/^APPLY ok=true digest=[0-9a-f]{64} declarations=\d+$/m.test(applyRun.out), '--adapters 的 APPLY 行必须逐字保住')
  }

  /* ③ 发布侧导出面与形状不变 */
  const pub = makePublicationPack('a05')
  eq(sha256File(path.join(pub.pack, 'tools', 'publish-policy.cjs')), sha256File(PUBLISH_POLICY), '被检的包侧 publish-policy 必须与仓内权威件逐字节相同')
  eq(Object.keys(pub.PUB).sort(), ['PUBLISH_KINDS', 'applyPublication', 'planPublication', 'publicationPolicy'].sort(), 'publish-policy 的导出面不许改名/增删')
  eq(pub.PUB.PUBLISH_KINDS, ['reader', 'public'], 'PUBLISH_KINDS 必须逐字不变')
  const pol = pub.PUB.publicationPolicy({ kind: 'public' })
  eq(Object.keys(pol).sort(), ['appDir', 'derivedProducers', 'includeProgress', 'kind', 'outDir', 'privateSurfaces', 'publicDrop', 'publicFiles', 'publicTop', 'schema', 'structuralExcludes'].sort(), 'publicationPolicy 的返回键不许改名/增删')
  eq(pol.schema, 'whale-publication/1', 'publicationPolicy.schema 不变')

  /* ④ 码值：与基线（git show 2f57b1f）**动态对拍** */
  const baselineDir = path.join(SESSION, 'baseline')
  writeText(path.join(baselineDir, 'publish-policy.cjs'), gitShow('lib/pack-template/tools/publish-policy.cjs'))
  const BASELINE_PUB = requireCJS(path.join(baselineDir, 'publish-policy.cjs'))
  {
    const curPack = makePublicationPack('a05-codes-cur')
    const basePack = makePublicationPack('a05-codes-base')
    const outCur = path.join(curPack.home, 'out')
    const outBase = path.join(basePack.home, 'out')
    writeText(path.join(outCur, 'sentinel.txt'), 'x\n')
    writeText(path.join(outBase, 'sentinel.txt'), 'x\n')

    const curPlan = curPack.PUB.planPublication(curPack.pack, { kind: 'public' })
    const basePlan = BASELINE_PUB.planPublication(basePack.pack, { kind: 'public' })

    const curNoConfirm = curPack.PUB.applyPublication(curPack.pack, curPlan, { outDir: outCur })
    const baseNoConfirm = BASELINE_PUB.applyPublication(basePack.pack, basePlan, { outDir: outBase })
    const curNoPlan = curPack.PUB.applyPublication(curPack.pack, { kind: 'public' }, { confirm: true, outDir: outCur })
    const baseNoPlan = BASELINE_PUB.applyPublication(basePack.pack, { kind: 'public' }, { confirm: true, outDir: outBase })

    fs.appendFileSync(path.join(curPack.pack, 'GLOSSARY.md'), ' ', 'utf8')
    fs.appendFileSync(path.join(basePack.pack, 'GLOSSARY.md'), ' ', 'utf8')
    const curStale = curPack.PUB.applyPublication(curPack.pack, curPlan, { confirm: true, outDir: outCur })
    const baseStale = BASELINE_PUB.applyPublication(basePack.pack, basePlan, { confirm: true, outDir: outBase })

    const curStage = curPack.PUB.applyPublication(curPack.pack, curPack.PUB.planPublication(curPack.pack, { kind: 'public' }), {
      confirm: true, outDir: outCur, decorate: () => { throw new Error('U08 · A05 注入') },
    })
    const baseStage = BASELINE_PUB.applyPublication(basePack.pack, BASELINE_PUB.planPublication(basePack.pack, { kind: 'public' }), {
      confirm: true, outDir: outBase, decorate: () => { throw new Error('U08 · A05 注入') },
    })

    detail.codes = {
      confirm: [baseNoConfirm.code, curNoConfirm.code],
      plan: [baseNoPlan.code, curNoPlan.code],
      stale: [baseStale.code, curStale.code],
      stage: [baseStage.code, curStage.code],
    }
    eq(detail.codes.confirm[0], 'CONFIRM_REQUIRED', '基线：缺确认码 = CONFIRM_REQUIRED（对拍基准）')
    eq(detail.codes.confirm[1], detail.codes.confirm[0], '缺确认码与基线逐字相同')
    eq(detail.codes.plan[0], 'PLAN_REQUIRED', '基线：缺计划码 = PLAN_REQUIRED（对拍基准）')
    eq(detail.codes.plan[1], detail.codes.plan[0], '缺计划码与基线逐字相同')
    eq(detail.codes.stale[0], 'PLAN_STALE', '基线：陈旧计划码 = PLAN_STALE（对拍基准）')
    eq(detail.codes.stale[1], detail.codes.stale[0], '陈旧计划码与基线逐字相同')
    eq(detail.codes.stage[0], 'STAGE_FAILED', '基线：暂存失败码 = STAGE_FAILED（对拍基准）')
    eq(detail.codes.stage[1], detail.codes.stage[0], '暂存失败码与基线逐字相同')
  }

  /* ⑤ 三个落点里的既有码字面量：基线有的，现在还在；新出现的码只能来自
   *    U01 锁定的既有码表 ∪ U03 登记的五个新码（不许自造第三个码） */
  const interfacesSrc = readText(path.join(REPO, 'docs', 'unify', 'interfaces.md'))
  const legacyCodes = new Set()
  for (const line of interfacesSrc.split(/\r?\n/)) {
    const m = /^\|\s*`([A-Za-z][A-Za-z0-9_-]+)`\s*\|/.exec(line.trim())
    if (m) legacyCodes.add(m[1])
  }
  const allowedAdded = new Set([...legacyCodes, ...Object.values(NEW_CODES)])
  check(legacyCodes.size >= 80, `U01 的既有码表解析成功（实得 ${legacyCodes.size} 条）`)
  const CARD_ID = /^[A-Z]\d{2}$/            // 卡号（U06 / A02 / T04 …）不是码值
  // 只认**字符串字面量**里的码（`'PLAN_STALE'` / `"IO_ERROR"`）：标识符（如 `COMMIT`）不算码值
  const QUOTED_CODE_RE = /['"]([A-Z][A-Z0-9_]{2,})['"]/g
  const COMMON_WORDS = new Set(['JSON', 'UTF8', 'URL', 'SHA', 'HTTP', 'HTTPS', 'API', 'CSS', 'HTML', 'README', 'TODO', 'NOTE', 'MD', 'JS', 'CJS', 'MJS', 'ID', 'OK', 'FAIL', 'PASS', 'BLOCKED', 'PLAN', 'APPLY', 'STDIN', 'STDOUT', 'STDERR', 'BOM', 'LF', 'CRLF', 'POSIX', 'NUL', 'EPERM', 'EEXIST', 'ENOENT', 'EACCES', 'EBUSY', 'EISDIR', 'ETIMEDOUT', 'ENOTEMPTY'])
  for (const rel of ['lib/engine.js', 'tools/upgrade-pack.mjs', 'lib/pack-template/tools/publish-policy.cjs']) {
    const before = gitShow(rel)
    const after = readText(path.join(REPO, rel))
    const codesOf = (text) => new Set([...text.matchAll(QUOTED_CODE_RE)].map((m) => m[1])
      .filter((c) => !COMMON_WORDS.has(c) && !CARD_ID.test(c)))
    const beforeCodes = codesOf(before)
    const afterCodes = codesOf(after)
    const dropped = [...beforeCodes].filter((c) => !afterCodes.has(c))
    const added = [...afterCodes].filter((c) => !beforeCodes.has(c))
    const unknownAdded = added.filter((c) => !allowedAdded.has(c))
    detail.codes[rel] = { before: [...beforeCodes].sort(), added: added.sort(), dropped: dropped.sort() }
    eq(dropped, [], `${rel} 不许丢掉基线里已有的码字面量（丢掉 = 改名）`)
    eq(unknownAdded, [], `${rel} 新出现的码必须在 U01 既有码表 ∪ U03 新码里（实得多出 ${unknownAdded.join('、') || '无'}）`)
    if (rel.endsWith('publish-policy.cjs')) {
      // 反空转：这一份基线里**确实**有码字面量（否则上面两条是空转）
      check(beforeCodes.size >= 4, `基线 publish-policy 里至少 4 个码字面量（实得 ${beforeCodes.size}）—— 码值对拍不是空转`)
      for (const must of ['CONFIRM_REQUIRED', 'PLAN_REQUIRED', 'PLAN_STALE', 'STAGE_FAILED']) {
        check(afterCodes.has(must), `当前 publish-policy 仍带既有码 ${must}`)
      }
    }
  }

  /* ⑥ 引擎模块的导出面：基线名字一个不少 */
  {
    const before = gitShow('lib/engine.js')
    const names = [...before.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])
      .concat([...before.matchAll(/^export const (\w+)/gm)].map((m) => m[1]))
    const missing = names.filter((n) => !(n in ENGINE))
    detail.exports.engine = { baselineNames: names.sort(), missing }
    eq(missing, [], 'lib/engine.js 的导出名不许删/改（基线的每一个都还在）')
    check(names.length >= 10, '基线导出名取到（判据不是空转）')
  }
  /* ⑦ 新增失败结构只用 U03 的 kind 域 */
  check(FAILURE_KINDS.length === 5, 'U03 的 failure.kind 域是 5 个（既有契约）')

  rows(`CLI 用例：${detail.cli.map((x) => `${x.argv.slice(1).join(' ')}=${x.code}`).join(' · ')}`)
  rows(`码值对拍：${JSON.stringify(detail.codes.confirm)} / ${JSON.stringify(detail.codes.plan)} / ${JSON.stringify(detail.codes.stale)} / ${JSON.stringify(detail.codes.stage)}`)
  writeEvidenceJson('cases/A05-evidence.json', detail)
})

/* ═══════════════════════════════════════════════════════════════════ A06 */
const A06 = makeCase('A06', async ({ check, eq, rows, data }) => {
  const detail = Object.assign(data, { upgradeSource: {}, publicationPolicy: {}, rules: {}, packageJson: {} })

  /* ① 升级源：只取插件模板；CLI 没有"任意来源"开关 */
  const enginePack = makeEnginePack('a06')
  const plan = ENGINE.planEngineUpgrade(enginePack)
  eq(plan.source, path.resolve(TEMPLATE_DIR), '升级源只能是插件模板（绝对路径逐字相同）')
  const cliSrc = readText(UPGRADE_CLI)
  const flags = [...cliSrc.matchAll(/args\[['"]([^'"]+)['"]\]/g)].map((m) => m[1])
  const fromish = [...new Set(flags)].filter((f) => /^(from|source|src|origin|template|tpl|input)$/i.test(f))
  eq(fromish, [], `CLI 不许出现"任意来源路径"的开关（实得 ${fromish.join('、') || '无'}）`)
  check(!/--from=|--source=/.test(cliSrc), 'CLI 源码里不许有 --from= / --source= 这类字面量')
  detail.upgradeSource = { source: plan.source, templateDir: path.resolve(TEMPLATE_DIR), cliFlags: [...new Set(flags)].sort() }

  /* ② 受信引擎闭包：基线里的件一件不少（不许"放宽到少核几件"） */
  const policyBefore = gitShow('lib/pack-template/tools/engine-policy.cjs')
  const filesBefore = [...policyBefore.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1]).filter((p) => p.includes('/'))
  const dropped = filesBefore.filter((rel) => !ENGINE.ENGINE_FILES.includes(rel))
  eq(dropped, [], `ENGINE_FILES 不许抽掉基线里的件（抽掉 = 放宽核验面；实得 ${dropped.join('、')}）`)
  eq(ENGINE.checkRegistry().ok, true, '入口注册表只引用受信清单内的脚本（闭包自洽）')
  detail.upgradeSource.engineFiles = ENGINE.ENGINE_FILES.length

  /* ③ 发布排除策略：与基线 `publicationPolicy()` **逐条对拍** */
  const baselineDir = path.join(SESSION, 'baseline')
  writeText(path.join(baselineDir, 'publish-policy.cjs'), gitShow('lib/pack-template/tools/publish-policy.cjs'))
  const BASELINE_PUB = requireCJS(path.join(baselineDir, 'publish-policy.cjs'))
  const pub = makePublicationPack('a06')
  for (const kind of ['public', 'reader']) {
    const a = BASELINE_PUB.publicationPolicy({ kind })
    const b = pub.PUB.publicationPolicy({ kind })
    eq(b.privateSurfaces.map((s) => s.path), a.privateSurfaces.map((s) => s.path), `${kind}：私人面表逐条不变（不放宽）`)
    eq(b.privateSurfaces.map((s) => s.mode), a.privateSurfaces.map((s) => s.mode), `${kind}：每条私人面的处置方式不变`)
    eq(b.privateSurfaces.map((s) => s.why), a.privateSurfaces.map((s) => s.why), `${kind}：每条私人面的理由不变（真源仍在这一份）`)
    eq(b.structuralExcludes.map((s) => s.path), a.structuralExcludes.map((s) => s.path), `${kind}：结构性排除面不变`)
    eq(b.publicTop, a.publicTop, `${kind}：公开白名单不变`)
    eq(b.publicFiles, a.publicFiles, `${kind}：顶层单文件白名单不变`)
    eq(b.publicDrop.map((r) => r.why), a.publicDrop.map((r) => r.why), `${kind}：白名单内部排除规则不变`)
    eq(b.derivedProducers, a.derivedProducers, `${kind}：派生物表不变`)
    eq(b.outDir, a.outDir, `${kind}：产物根不变`)
  }
  eq(pub.PUB.PUBLISH_KINDS, BASELINE_PUB.PUBLISH_KINDS, 'PUBLISH_KINDS 与基线一致')
  detail.publicationPolicy = {
    privateSurfaces: pub.PUB.publicationPolicy({ kind: 'public' }).privateSurfaces.length,
    structuralExcludes: pub.PUB.publicationPolicy({ kind: 'public' }).structuralExcludes.length,
    baselinePrivateSurfaces: BASELINE_PUB.publicationPolicy({ kind: 'public' }).privateSurfaces.length,
  }

  /* ④ 运行期证据：真存在的私人面**真的**被排掉（不是"表里写着"） */
  const pubPlan = pub.PUB.planPublication(pub.pack, { kind: 'public' })
  const excluded = new Set(pubPlan.excluded.map((e) => e.path))
  for (const rel of ['lesson.config.json', 'progress.json', 'assets/questions-data.js', 'assets/practice-data.js']) {
    check(excluded.has(rel), `${rel} 必须在 excluded 里（发布排除策略没放宽）`)
  }
  for (const dir of ['questions', 'notes', 'learning-records', 'code']) {
    check([...excluded].some((p) => p === dir || p.startsWith(`${dir}/`)), `私人面目录 ${dir} 必须在 excluded 里`)
    check(!pubPlan.files.some((f) => f === dir || f.startsWith(`${dir}/`)), `私人面目录 ${dir} 不许进产物清单`)
  }

  /* ⑤ FROM_PACK / SANITIZE 不被抽项（基线 ⊆ 现在） */
  const rulesSrc = readText(path.join(REPO, 'test', 'pack-template-rules.mjs'))
  const rulesBefore = gitShow('test/pack-template-rules.mjs')
  function arrayBlock(text, name) {
    const at = text.indexOf(`export const ${name} = [`)
    if (at < 0) return null
    let depth = 0
    let i = text.indexOf('[', at)
    const begin = i
    for (; i < text.length; i++) {
      const c = text[i]
      if (c === '[') depth += 1
      else if (c === ']') { depth -= 1; if (depth === 0) break }
    }
    return text.slice(begin, i + 1)
  }
  function quotedPaths(block) {
    if (!block) return []
    const out = []
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      for (const m of line.matchAll(/'([^'\n]+)'/g)) out.push(m[1])
    }
    return out
  }
  const fromPackBefore = quotedPaths(arrayBlock(rulesBefore, 'FROM_PACK'))
  const fromPackNow = quotedPaths(arrayBlock(rulesSrc, 'FROM_PACK'))
  const fromPluginBefore = quotedPaths(arrayBlock(rulesBefore, 'FROM_PLUGIN'))
  const fromPluginNow = quotedPaths(arrayBlock(rulesSrc, 'FROM_PLUGIN'))
  const sanitizeBefore = [...(arrayBlock(rulesBefore, 'SANITIZE') || '').matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
  const sanitizeNow = [...(arrayBlock(rulesSrc, 'SANITIZE') || '').matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
  const removedFromPack = fromPackBefore.filter((p) => !fromPackNow.includes(p))
  const removedFromPlugin = fromPluginBefore.filter((p) => !fromPluginNow.includes(p))
  const removedSanitize = sanitizeBefore.filter((p) => !sanitizeNow.includes(p))
  eq(removedFromPack, [], `FROM_PACK 不许被抽项（抽掉 = 来源放宽；实得 ${removedFromPack.join('、')}）`)
  eq(removedFromPlugin, [], `FROM_PLUGIN 不许被抽项（实得 ${removedFromPlugin.join('、')}）`)
  eq(removedSanitize, [], `SANITIZE 规则不许被抽项（实得 ${removedSanitize.join('、')}）`)
  eq(sanitizeNow.length, sanitizeBefore.length, `SANITIZE 规则数不变（基线 ${sanitizeBefore.length}）`)
  check(fromPackNow.length >= fromPackBefore.length, 'FROM_PACK 项数不许减少（仍然逐字节取自课程包原件）')
  detail.rules = {
    fromPack: [fromPackBefore.length, fromPackNow.length],
    fromPlugin: [fromPluginBefore.length, fromPluginNow.length],
    sanitize: [sanitizeBefore.length, sanitizeNow.length],
  }

  /* ⑥ 版本 + 私模式 + 依赖面 + 锁文件 + `files`/`bin` 白名单（package.json **不归本卡写**）──
   *
   * 原判据是「整文件与基线逐字节相同」。U19 的 A06 要求把显式迁移 CLI（`tools/migrate-pack.mjs`）
   * 登记进发布清单 `package.json#files` —— 于是那条在收口时**必然红**；而且它把版本、私模式、
   * 依赖面、锁文件全混进一个哈希里，红了也说不清红在哪。改成逐项判据 + 「其余键整体闭合」：
   * 只放开 `files`/`bin` 的**白名单新增**，别处一律逐字节（Δ 见回执 `decision9PackageJsonAssertion`）。
   * 没有新增条目时，原判据**原样保留**（整文件逐字节相同）—— "没放宽"不是口号。
   */
  const pkgPath = path.join(REPO, 'package.json')
  const pkgText = readText(pkgPath)
  const pkg = JSON.parse(pkgText)
  const pkgBaseText = gitShow('package.json')
  const basePkg = JSON.parse(pkgBaseText)
  const curMembers = topLevelMembers(pkgText)
  const baseMembers = topLevelMembers(pkgBaseText)
  // 扫描器自证：切出来的键集合必须与 JSON.parse 的键集合逐字相同（否则后面是拿错切片对拍）
  const memberKeys = (m) => [...m.keys()].sort()
  eq(memberKeys(curMembers), Object.keys(pkg).sort(), 'package.json 的顶层键切片与 JSON.parse 的键集合必须一致（扫描器自证）')
  eq(memberKeys(baseMembers), Object.keys(basePkg).sort(), '基线 package.json 的顶层键切片与 JSON.parse 的键集合必须一致（扫描器自证）')
  /** 一个顶层成员在原始文本里的字节（不存在 ⇒ null）；尾部空白不算内容 */
  const memberRaw = (m, key) => (m.has(key) ? m.get(key).raw.replace(/\s+$/, '') : null)

  // ① 版本逐字
  eq(pkg.version, '0.3.3', 'package.json version 必须仍是 0.3.3（逐字）')
  // ② 私模式逐字
  eq(pkg.dsh && pkg.dsh.distribution && pkg.dsh.distribution.mode, 'private', 'dsh.distribution.mode 必须仍是 private（逐字）')
  // ③ 依赖面逐字节：dependencies / devDependencies / engines（含"基线没有 ⇒ 现在也不许有"）
  const pinnedDependencyKeys = ['dependencies', 'devDependencies', 'engines']
  for (const key of pinnedDependencyKeys) {
    const nowRaw = memberRaw(curMembers, key)
    const baseRaw = memberRaw(baseMembers, key)
    eq(nowRaw === null, baseRaw === null, `package.json#${key} 的存在性必须与基线一致（不许新开一个依赖面）`)
    if (baseRaw !== null) eq(nowRaw, baseRaw, `package.json#${key} 必须与基线逐字节相同`)
  }
  // ④ 锁文件：与基线逐字节相同；存在性也不许变（新增/删除锁文件都会动依赖图）
  const lockRel = 'package-lock.json'
  const lockAbs = path.join(REPO, lockRel)
  const lockNow = exists(lockAbs)
  const lockBaseBuf = gitShowBuffer(lockRel)
  eq(lockNow, lockBaseBuf !== null, `${lockRel} 的存在性必须与基线一致（不许静默新增/删除锁文件）`)
  if (lockNow && lockBaseBuf !== null) {
    const lockBuf = fs.readFileSync(lockAbs)
    eq(lockBuf.length, lockBaseBuf.length, `${lockRel} 的字节数必须与基线相同`)
    eq(sha256(lockBuf), sha256(lockBaseBuf), `${lockRel} 必须与基线逐字节相同`)
  }
  // 写守卫证明：本卡本次运行**零写** package.json 与锁文件（原判据的"没写权"换成可归因的证据）
  const pkgWrites = WRITES.filter((w) => w.path === path.resolve(pkgPath))
  const lockWrites = WRITES.filter((w) => w.path === path.resolve(lockAbs))
  eq(pkgWrites.length, 0, '写守卫：本卡本次运行没写过 package.json（一个字节都不许写）')
  eq(lockWrites.length, 0, `写守卫：本卡本次运行没写过 ${lockRel}`)

  // ⑤ `files` / `bin`：只许白名单新增，不许删既有条目，既有条目相对顺序不许动
  const ADD_ALLOW_PREFIX = ['lib/pack-template/tools/unify/']
  const ADD_ALLOW_EXACT = new Set(['tools/migrate-pack.mjs'])
  const allowedAddition = (entry) => ADD_ALLOW_EXACT.has(entry)
    || ADD_ALLOW_PREFIX.some((p) => entry === p.replace(/\/$/, '') || entry.startsWith(p))
  const filesNow = pkg.files
  const filesBase = basePkg.files
  check(Array.isArray(filesNow) && Array.isArray(filesBase), 'package.json#files 与基线都必须是数组')
  for (const item of filesNow) check(typeof item === 'string' && item.length > 0, 'package.json#files 的条目必须是非空字符串')
  const filesBaseSet = new Set(filesBase)
  // **唯一允许的删除**：`"docs"` → `docs/capabilities.md` + `docs/dsh-native-style.md`（逐条登记）。
  // 理由（U20 全量实测顶出来的真问题）：`docs` 是**整棵子树**进包，而 U 系列的审计文档
  // （docs/unify/**、docs/unify-mirrors.md）里写有作者机器布局（E:\\workplace\\… / E:\\Temp\\…），
  // alien-env 的静态守卫「随包文件里 0 处机器专属路径」因此变红（实测 25 个文件 / 354 处）。
  // 判据**没有放松**：删除必须逐条登记（未登记的删除仍红），替换后那两条必须真的在 files 里，
  // 且 docs/ 顶层脱离随包面的文件必须**恰好**是 U 系列审计文档（新增文件会立刻在这里露出来）。
  const REMOVE_ALLOW_EXACT = new Set(['docs'])
  const REPLACE_DOCS = ['docs/capabilities.md', 'docs/dsh-native-style.md']
  const removedEntries = filesBase.filter((x) => !filesNow.includes(x))
  const illegalRemovals = removedEntries.filter((x) => !REMOVE_ALLOW_EXACT.has(x))
  eq(illegalRemovals, [], `package.json#files 不许删除任何既有条目（**未登记**的删除即红：${illegalRemovals.join('、')}）`)
  if (removedEntries.includes('docs')) {
    for (const keep of REPLACE_DOCS) check(filesNow.includes(keep), `「docs」被收窄时必须保留 ${keep}（白名单替换不许顺手丢文件）`)
    const docsAbs = path.join(REPO, 'docs')
    const docsTop = fs.existsSync(docsAbs)
      ? fs.readdirSync(docsAbs, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `docs/${e.name}`).sort()
      : []
    const unshipped = docsTop.filter((f) => !filesNow.includes(f))
    eq(unshipped.join(','), 'docs/unify-mirrors.md',
      `docs/ 顶层脱离随包面的文件必须恰好是 U 系列审计文档 docs/unify-mirrors.md（实得：${unshipped.join(' / ') || '无'}）`)
  }
  const addedEntries = filesNow.filter((x) => !filesBaseSet.has(x))
  const illegalEntries = addedEntries.filter((x) => !allowedAddition(x) && !REPLACE_DOCS.includes(x))
  eq(illegalEntries, [],
    `package.json#files 的新增条目必须在白名单里（只许 tools/migrate-pack.mjs、lib/pack-template/tools/unify/ 相关、docs 的两个明确文件；越界：${illegalEntries.join('、')}）`)
  const filePos = new Map(filesNow.map((x, idx) => [x, idx]))
  const keptBase = filesBase.filter((x) => !removedEntries.includes(x))
  const baseOrder = keptBase.map((x) => filePos.get(x))
  eq(baseOrder.filter((v) => v !== undefined).length, keptBase.length, 'package.json#files 的既有条目必须全部还在（逐条登记的替换除外）')
  eq(baseOrder.every((v, idx) => idx === 0 || v > baseOrder[idx - 1]), true,
    'package.json#files 既有条目的相对顺序不许变（新增插在任何位置都可以）')
  const binNow = pkg.bin || {}
  const binBase = basePkg.bin || {}
  eq(Array.isArray(binNow), false, 'package.json#bin 必须是对象')
  for (const [name, target] of Object.entries(binBase)) {
    eq(binNow[name], target, `package.json#bin.${name} 不许改名/改指向（基线 ${target}）`)
  }
  const binAdded = Object.entries(binNow).filter(([name]) => !Object.prototype.hasOwnProperty.call(binBase, name))
  const illegalBins = binAdded.filter(([, target]) => !allowedAddition(String(target)))
  eq(illegalBins.map(([name]) => name), [],
    `package.json#bin 的新增项也必须在白名单里（目标只许 tools/migrate-pack.mjs 与 lib/pack-template/tools/unify/ 相关）`)

  // ⑥ 其余顶层键整体闭合：除 files/bin 外**每一个**键都与基线逐字节相同（删除顶层键也红）
  const MUTABLE_KEYS = new Set(['files', 'bin'])
  const closedKeys = []
  for (const key of Object.keys(pkg)) {
    if (MUTABLE_KEYS.has(key)) continue
    eq(memberRaw(curMembers, key), memberRaw(baseMembers, key),
      `package.json#${key} 必须与基线逐字节相同（只放开 files/bin 的白名单新增）`)
    closedKeys.push(key)
  }
  const vanishedKeys = Object.keys(basePkg).filter((k) => !Object.prototype.hasOwnProperty.call(pkg, k))
  eq(vanishedKeys, [], `package.json 不许删除顶层键（缺失即红：${vanishedKeys.join('、')}）`)
  // ⑦ 字节级闭合：把「整行只是白名单新增条目」的那些行去掉之后，余下必须与基线**逐字节**相同。
  //    没有新增时，这一条**就是**原判据（整文件与基线逐字节相同）—— 原判据原样保留，一行没松。
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const jsonTok = (s) => `"${JSON.stringify(String(s)).slice(1, -1)}"`
  const stripLine = (text, re) => text.replace(new RegExp(re.source, 'gm'), '')
  let strippedPkg = pkgText
  for (const entry of addedEntries) {
    strippedPkg = stripLine(strippedPkg, new RegExp(`^[ \\t]*${escRe(jsonTok(entry))}[ \\t]*,?[ \\t]*\\r?\\n`))
  }
  for (const [name, target] of binAdded) {
    strippedPkg = stripLine(strippedPkg,
      new RegExp(`^[ \\t]*${escRe(jsonTok(name))}[ \\t]*:[ \\t]*${escRe(jsonTok(String(target)))}[ \\t]*,?[ \\t]*\\r?\\n`))
  }
  // 新增插在数组/对象末尾时会留下"上一行多出来的那个逗号"（本判据模拟删除的副产品）——
  // 两侧做**同一次**规范化，所以它只修这个模拟产物，不会放过真实文件里的差异
  // （合法 JSON 里不会出现 `,` 紧跟 `]`/`}`，这个模式在真文件上恒为空操作）。
  // 删除侧**对称**规范化：被逐条登记允许删除的条目（如 `"docs"`），从基线那一侧也去掉同一行 ——
  // 否则"删除 + 两条替换"会被误读成"改了别的字节"。没登记的删除在上面（⑤）已经红了。
  let strippedBase = pkgBaseText
  for (const entry of removedEntries) {
    strippedBase = stripLine(strippedBase, new RegExp(`^[ \\t]*${escRe(jsonTok(entry))}[ \\t]*,?[ \\t]*\\r?\\n`))
  }
  const normalizeTailComma = (t) => t.replace(/,\r?\n([ \t]*[\]}])/g, '\n$1')
  eq(normalizeTailComma(strippedPkg), normalizeTailComma(strippedBase),
    'package.json 去掉白名单新增行（与逐条登记删除行）之后必须与基线逐字节相同（其余一个字节都不许动）')

  eq(pkg.bin && pkg.bin['dsh-whale-pack'], 'tools/upgrade-pack.mjs', 'bin.dsh-whale-pack 仍指向仓根 tools/upgrade-pack.mjs')
  check((pkg.files || []).includes('tools/upgrade-pack.mjs'), 'package.json#files 里仍点名 tools/upgrade-pack.mjs')
  detail.packageJson = {
    version: pkg.version,
    mode: pkg.dsh.distribution.mode,
    bin: pkg.bin,
    files: { baseline: filesBase.length, now: filesNow.length, added: addedEntries, removed: removedEntries },
    binAdded: binAdded.map(([name]) => name),
    lockFile: { rel: lockRel, present: lockNow, baselinePresent: lockBaseBuf !== null, writes: lockWrites.length },
    pkgWrites: pkgWrites.length,
    closedKeys,
    sha: sha256File(pkgPath),
  }

  rows(`升级源=${detail.upgradeSource.source} · ENGINE_FILES=${detail.upgradeSource.engineFiles}`)
  rows(`私人面 ${detail.publicationPolicy.privateSurfaces} 条（基线 ${detail.publicationPolicy.baselinePrivateSurfaces}）· 结构性排除 ${detail.publicationPolicy.structuralExcludes} 条`)
  rows(`规则数 FROM_PACK=${detail.rules.fromPack.join('→')} FROM_PLUGIN=${detail.rules.fromPlugin.join('→')} SANITIZE=${detail.rules.sanitize.join('→')}`)
  writeEvidenceJson('cases/A06-evidence.json', detail)
})

/* ═══════════════════════════════════════════════════════════════════ A07 */
const PROBE_SOURCE = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const require_ = createRequire(pathToFileURL(path.join(ROOT, '__probe.cjs')).href)
const E = await import(pathToFileURL(path.join(ROOT, 'lib', 'engine.js')).href)
const TPL = path.join(ROOT, 'lib', 'pack-template')
const TMP = fs.mkdtempSync(path.join(ROOT, '.probe-'))
const copyTree = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}
const write = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t, 'utf8') }
function enginePack(name) {
  const pack = path.join(TMP, 'engine', name)
  fs.mkdirSync(pack, { recursive: true })
  copyTree(TPL, pack)
  fs.mkdirSync(path.join(pack, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(pack, 'presets'), { recursive: true })
  fs.appendFileSync(path.join(pack, 'tools', 'ask-server.js'), '\n// probe tamper\n')
  return pack
}
function publicationPack(name) {
  const home = path.join(TMP, 'pub', name)
  const pack = path.join(home, 'pack')
  fs.mkdirSync(pack, { recursive: true })
  copyTree(TPL, pack)
  fs.mkdirSync(path.join(pack, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(pack, 'reference'), { recursive: true })
  if (!fs.existsSync(path.join(pack, 'GLOSSARY.md'))) write(path.join(pack, 'GLOSSARY.md'), '# 课程 名词速查笔记（GLOSSARY）\n')
  fs.rmSync(path.join(pack, 'starmap', 'content.js'), { force: true })
  write(path.join(pack, 'lesson.config.json'), '{"title":"probe"}\n')
  const PUB = require_(path.join(pack, 'tools', 'publish-policy.cjs'))
  return { home, pack, PUB }
}
const out = {}

// ① 引擎：确认闸
try {
  const pack = enginePack('confirm')
  const plan = E.planEngineUpgrade(pack)
  const r = E.applyEngineUpgrade(pack, { confirm: false, planDigest: plan.planDigest })
  out.engineConfirm = !r.ok && r.code === 'CONFIRM_REQUIRED'
  out.engineConfirmDetail = { ok: r.ok, code: r.code }
} catch (e) { out.engineConfirm = false; out.engineConfirmDetail = { threw: String(e && e.message || e) } }

// ② 引擎：摘要闸（计划之后改一个字节）
try {
  const pack = enginePack('digest')
  const plan = E.planEngineUpgrade(pack)
  const target = path.join(pack, 'tools', 'build-notes.js')
  const base = fs.readFileSync(target)
  const injected = Buffer.concat([base, Buffer.from('\n// probe late change\n')])
  fs.writeFileSync(target, injected)
  const r = E.applyEngineUpgrade(pack, { confirm: true, planDigest: plan.planDigest })
  out.engineDigest = !r.ok && r.code === 'PLAN_STALE' && fs.readFileSync(target).equals(injected)
  out.engineDigestDetail = { ok: r.ok, code: r.code }
} catch (e) { out.engineDigest = false; out.engineDigestDetail = { threw: String(e && e.message || e) } }

// ③ 发布：确认闸
try {
  const { pack, PUB } = publicationPack('confirm')
  const plan = PUB.planPublication(pack, { kind: 'public' })
  const r = PUB.applyPublication(pack, plan, { outDir: path.join(TMP, 'out-confirm') })
  out.pubConfirm = !r.ok && r.code === 'CONFIRM_REQUIRED'
  out.pubConfirmDetail = { ok: r.ok, code: r.code }
} catch (e) { out.pubConfirm = false; out.pubConfirmDetail = { threw: String(e && e.message || e) } }

// ④ 发布：**锁内**真实字节摘要（前置检查放行、事务一进门就让输入漂移）
try {
  const { pack, PUB } = publicationPack('inlock')
  const plan = PUB.planPublication(pack, { kind: 'public' })
  const target = path.join(pack, 'GLOSSARY.md')
  let late = false
  const drift = { ...fs }
  drift.readFileSync = (p, ...a) => {
    const buf = fs.readFileSync(p, ...a)
    if (late && path.resolve(String(p)) === path.resolve(target)) return Buffer.concat([buf, Buffer.from('X')])
    return buf
  }
  const txn = {
    withPackTransaction(root, build, opts) {
      late = true
      return require_(path.join(root, 'tools', 'ledger-transaction.cjs')).withPackTransaction(root, build, opts)
    },
    failureFor: (r) => require_(path.join(root, 'tools', 'ledger-transaction.cjs')).failureFor(r),
    assertNoRecoveryRequired: (io, root) => require_(path.join(root, 'tools', 'ledger-transaction.cjs')).assertNoRecoveryRequired(io, root),
  }
  const outDir = path.join(TMP, 'out-inlock')
  const r = PUB.applyPublication(pack, plan, {
    confirm: true, outDir, fs: drift, transaction: txn,
    decorate: (dir) => { for (const f of ['404.html', 'robots.txt']) write(path.join(dir, f), 'probe\n') },
  })
  out.pubInLock = !r.ok && r.code === 'PLAN_STALE' && !fs.existsSync(outDir)
  out.pubInLockDetail = { ok: r.ok, code: r.code }
} catch (e) { out.pubInLock = false; out.pubInLockDetail = { threw: String(e && e.message || e) } }

process.stdout.write('<<<PROBE>>>' + JSON.stringify(out) + '\n')
`

function runProbe(treeRoot) {
  const probeFile = path.join(treeRoot, 'u08-guard-probe.mjs')
  writeText(probeFile, PROBE_SOURCE)
  const r = runNode([probeFile], { cwd: treeRoot, timeout: 300000 })
  const m = /<<<PROBE>>>(\{.*\})/m.exec(r.out)
  let parsed = null
  try { parsed = m ? JSON.parse(m[1]) : null } catch { parsed = null }
  return { ...r, probe: parsed, probeFile }
}

/** 造一份"当前源码的副本"（只拷 lib/ + package.json；A07 只在副本里变异） */
function makeSourceCopy(name, mutate) {
  const root = path.join(SESSION, 'copies', name)
  fs.mkdirSync(root, { recursive: true })
  copyTree(path.join(REPO, 'lib'), path.join(root, 'lib'))
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'))
  fs.mkdirSync(path.join(root, 'lib', 'pack-template', 'tools', 'unify'), { recursive: true })
  for (const m of ['commit.cjs', 'errors.cjs']) {
    const dst = path.join(root, 'lib', 'pack-template', 'tools', 'unify', m)
    fs.copyFileSync(path.join(root, 'lib', 'unify', m), dst)
  }
  if (mutate) {
    const commitPath = path.join(root, 'lib', 'unify', 'commit.cjs')
    const src = readText(commitPath)
    const patched = mutate(src)
    if (patched === src) throw new Error(`A07：变异没有命中 commit.cjs（${name}）—— 判据会空转，必须修`)
    fs.writeFileSync(commitPath, patched, 'utf8')
    fs.writeFileSync(path.join(root, 'lib', 'pack-template', 'tools', 'unify', 'commit.cjs'), patched, 'utf8')
  }
  return root
}

const A07 = makeCase('A07', async ({ check, eq, rows, data }) => {
  const detail = Object.assign(data, { copies: [] })

  const clean = makeSourceCopy('clean', null)
  const noConfirm = makeSourceCopy('no-confirm', (src) => src.replace(
    'if (opts.confirm !== true) {',
    'if (false) { /* U08 · A07 变异：跳过确认闸 */',
  ))
  const noDigest = makeSourceCopy('no-digest', (src) => {
    let out = src.replace('if (opts.planDigest !== plan.planDigest) {', 'if (false) { /* U08 · A07 变异：跳过摘要闸（引回） */')
    out = out.replace('if (digest !== f.beforeDigest) {', 'if (false) { /* U08 · A07 变异：跳过锁内写前摘要 */')
    out = out.replace('if (remove !== f.remove || digest !== f.digest) {', 'if (false) { /* U08 · A07 变异：跳过锁内重建摘要 */')
    return out
  })
  const noGuard = makeSourceCopy('no-guard', (src) => src.replace(
    'out = opts.build({ root: rootAbs, fs: readOnlyFs(io), files: preUtf8, plan })',
    'out = { files: plan.files.map((f) => (f.remove ? { rel: f.rel, remove: true } : { rel: f.rel, content: Buffer.alloc(0) })) } /* U08 · A07 变异：跳过锁内重建 */',
  ))

  const runs = {}
  for (const [name, root] of [['clean', clean], ['no-confirm', noConfirm], ['no-digest', noDigest], ['no-guard', noGuard]]) {
    const run = runProbe(root)
    runs[name] = run
    detail.copies.push({ name, code: run.code, probe: run.probe, stderrTail: run.err.slice(-400) })
    writeEvidenceJson(path.join('a07', `${name}.json`), { name, code: run.code, probe: run.probe, out: run.out.slice(-4000), err: run.err.slice(-4000) })
  }

  const cleanProbe = runs.clean.probe
  check(!!cleanProbe, '干净副本的探针必须产出可解析结果（判据不许空转）')
  eq(cleanProbe.engineConfirm, true, '干净副本：缺确认 ⇒ 引擎提交必须被挡住')
  eq(cleanProbe.engineDigest, true, '干净副本：计划过期 ⇒ 引擎提交必须被挡住')
  eq(cleanProbe.pubConfirm, true, '干净副本：缺确认 ⇒ 发布提交必须被挡住')
  eq(cleanProbe.pubInLock, true, '干净副本：前置检查放行后输入漂移 ⇒ 锁内复核必须挡住')

  eq(runs['no-confirm'].probe && runs['no-confirm'].probe.engineConfirm, false, '变异 ①（跳过确认闸）后，A02 的"缺确认必拒"必须**红**')
  eq(runs['no-confirm'].probe && runs['no-confirm'].probe.pubConfirm, true, '变异 ① 只动共同协议；发布侧的确认闸仍在（如实记录差异，不夸大）')
  eq(runs['no-digest'].probe && runs['no-digest'].probe.engineDigest, false, '变异 ②（跳过摘要闸）后，A03 的"旧计划必拒"必须**红**')
  eq(runs['no-guard'].probe && runs['no-guard'].probe.pubInLock, false, '变异 ③（跳过锁内重建）后，发布侧"锁内复核必拒"必须**红**')

  rows(`干净副本探针：${JSON.stringify(cleanProbe)}`)
  rows(`变异副本：no-confirm=${JSON.stringify(runs['no-confirm'].probe)} · no-digest=${JSON.stringify(runs['no-digest'].probe)} · no-guard=${JSON.stringify(runs['no-guard'].probe)}`)
})

/* ═══════════════════════════════════════════════════════════════════ A08 */
const A08 = makeCase('A08', async ({ check, eq, rows, data }) => {
  const detail = data

  /* ① 进程内写守卫：本次运行的所有写入都必须落在 {证据根 ∪ 本卡唯一夹具目录} */
  const writes = WRITES.slice()
  const outside = writes.filter((w) => !isAllowedWrite(w.path))
  const repoWrites = writes.filter((w) => {
    const rel = path.relative(REPO, w.path)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !w.path.startsWith(path.resolve(EVIDENCE_ROOT) + path.sep)
  })
  detail.writeGuard = {
    total: writes.length,
    allowedRoots: allowedWriteRoots(),
    outside: outside.slice(0, 20),
    repoWrites: repoWrites.slice(0, 20),
    byApi: writes.reduce((acc, w) => { acc[w.api] = (acc[w.api] || 0) + 1; return acc }, {}),
  }
  eq(outside, [], `写守卫：不许写到 {证据根 ∪ 本卡夹具目录} 之外（越界：${outside.slice(0, 5).map((w) => w.path).join('、')}）`)
  eq(repoWrites, [], `写守卫：本次运行不许往仓库工作树写（除证据根；越界：${repoWrites.slice(0, 5).map((w) => w.path).join('、')}）`)
  check(writes.length > 0, '写守卫真的在工作（记录数 > 0，判据不是空转）')

  /* 自证探针：在夹具里写一个 canary，守卫必须记到它（证明不是"只记不拦"的假绿） */
  {
    const probePath = path.join(SESSION, 'write-guard-probe.txt')
    const before = WRITES.length
    writeText(probePath, 'U08 write-guard probe\n')
    const hit = WRITES.slice(before).some((w) => w.path === path.resolve(probePath))
    detail.writeGuard.probe = { probePath, recorded: hit }
    eq(hit, true, '写守卫自证：夹具里写一个探针文件必须被记录（守卫是活的）')
  }

  /* ② 授权写集并集（interfaces.md §6）—— tracked 改动必须 ⊆ 并集 */
  const interfaces = readText(path.join(REPO, 'docs', 'unify', 'interfaces.md'))
  const union = new Set()
  for (const line of interfaces.split(/\r?\n/)) {
    if (!/^\|\s*U\d\d\s*\|/.test(line)) continue
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      let token = m[1].replace(/^[†✅]\s*/u, '').trim()
      if (!token || /\s/.test(token)) continue
      if (!/^[A-Za-z0-9._/-]+$/.test(token)) continue
      if (!token.includes('/') && !/\.(cjs|js|mjs|json|md)$/.test(token)) continue
      union.add(token)
      if (token.startsWith('lib/unify/') && !token.endsWith('/')) union.add(token)
    }
  }
  check(union.size > 40, `授权写集并集解析成功（实得 ${union.size} 条）`)
  const tracked = gitTrackedChanges()
  const outOfUnion = tracked.filter((t) => !union.has(t.rel))
  detail.writeset = {
    unionSize: union.size,
    trackedChanges: tracked.map((t) => `${t.code} ${t.rel}`),
    outOfUnion: outOfUnion.map((t) => `${t.code} ${t.rel}`),
  }
  eq(outOfUnion, [], `tracked 改动必须 ⊆ interfaces.md §6 的授权写集并集（越界：${outOfUnion.map((t) => t.rel).slice(0, 5).join('、')}）`)
  for (const mine of ['lib/engine.js', 'lib/pack-template/tools/publish-policy.cjs']) {
    check(tracked.some((t) => t.rel === mine), `本卡写集里的 ${mine} 必须真的被改过（判据不是空转）`)
  }
  // CLI 是 `package.json#bin`：本卡**不需要改**它（三闸在 lib/engine.js 里接），所以它必须与基线逐字节相同
  // —— 这是"原有 CLI 契约不被改名"的最硬证据（文件一个字节都没动）
  eq(sha256File(UPGRADE_CLI), sha256(Buffer.from(gitShow('tools/upgrade-pack.mjs'), 'utf8')),
    'tools/upgrade-pack.mjs 与基线逐字节相同（CLI 契约不是"改完再对拍"，而是原封不动）')
  detail.writeset.cliUnchanged = true

  /* ③ 依赖锚点：跑前跑后逐字不变 */
  const now = dependencyAnchors()
  const drift = DEPENDENCIES.filter((rel) => now[rel] !== ANCHORS_BEFORE[rel])
  detail.anchors = { before: ANCHORS_BEFORE, after: now, drift }
  eq(drift, [], `依赖锚点 sha256 不许在本次运行里变（变了的：${drift.join('、')}）`)
  for (const rel of ['docs/unify/interfaces.md', 'docs/unify/baseline.json', 'package.json', 'lib/unify/commit.cjs', 'lib/unify/errors.cjs']) {
    check(!!ANCHORS_BEFORE[rel], `依赖锚点取到 ${rel}`)
  }

  /* ④ 夹具与清理守卫 */
  const isTemp = path.resolve(SESSION).startsWith(path.resolve('E:\\Temp') + path.sep)
  eq(isTemp, true, '本次唯一夹具目录必须落在 E:\\Temp 下')
  check(/^U08-cases-/.test(path.basename(SESSION)), `夹具目录名必须是本次专属前缀（实得 ${path.basename(SESSION)}）`)
  const guardOk = guardTempPath(SESSION, { parent: 'E:\\Temp' })
  eq(guardOk.ok, true, '清理守卫认这次夹具目录（父目录 + 名字形状都对）')
  const guardBad = guardTempPath(path.join(REPO, 'lib'), { parent: 'E:\\Temp' })
  eq(guardBad.ok, false, '清理守卫拒绝非本卡目录（不是"能删就删"）')
  const evShape = EVIDENCE_ROOT.startsWith(path.join(REPO, 'audit-evidence', CARD)) || EVIDENCE_ROOT.startsWith(path.resolve('E:\\Temp') + path.sep)
  eq(evShape, true, '证据根要么是本卡 audit-evidence/U08 下的新运行目录，要么是 E:\\Temp 新目录')
  check(!WRITES.some((w) => w.path.startsWith(path.resolve('E:\\workplace\\study'))), '本次运行零写入活包 E:\\workplace\\study')

  /* ⑤ 最小替代记录（U19 才负责真随包；这里只记录复制清单与摘要） */
  detail.copiedAuthority = COPIED_AUTHORITY
  check(Object.keys(COPIED_AUTHORITY).length >= 2, '夹具里逐字节复制的权威模块清单非空（U-SPEC §5 的最小替代）')
  const authoritySha = sha256File(path.join(REPO, 'lib', 'unify', 'commit.cjs'))
  for (const [rel, sha] of Object.entries(COPIED_AUTHORITY)) {
    if (rel.endsWith('commit.cjs')) eq(sha, authoritySha, `夹具副本 ${rel} 必须与权威 lib/unify/commit.cjs 逐字节相同`)
  }

  rows(`写记录 ${detail.writeGuard.total} 条 · 越界 ${outside.length} · 仓库写 ${repoWrites.length}`)
  rows(`授权并集 ${union.size} 条 · tracked 改动 ${tracked.length} 条 · 越界 ${outOfUnion.length}`)
  rows(`依赖锚点漂移 ${drift.length} 条`)

  /* ⑥ 清理（守卫过；证据已落盘，清理失败只登记不覆盖判词） */
  if (process.env.U08_KEEP === '1') {
    detail.cleanup = { removed: false, error: 'U08_KEEP=1：判据调试用，保留夹具' }
    rows(`夹具保留（U08_KEEP=1）：${SESSION}`)
  } else {
    const clean = safeRemoveTree(SESSION, { parent: 'E:\\Temp' })
    detail.cleanup = clean
    eq(clean.removed, true, `夹具清理必须成功（${clean.error ?? ''}）`)
  }
  writeEvidenceJson('cases/A08-evidence.json', detail)
})

/* ═════════════════════════════════════════════════════════════════ 跑八项 */
const CASES = [A01, A02, A03, A04, A05, A06, A07, A08]

const verdict = await runCard(CARD, FIXED_IDS, CASES, {
  evidenceDir: EVIDENCE_ROOT,
  argv: process.argv,
  timeoutMs: 600000,
})

writeRunEvidence(verdict, EVIDENCE_ROOT)
writeEvidenceJson('run.json', {
  card: CARD,
  argv: process.argv,
  base: BASE_SHA,
  branch: (() => {
    const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
    return String(r.stdout || '').trim()
  })(),
  head: (() => {
    const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    return String(r.stdout || '').trim()
  })(),
  evidenceRoot: EVIDENCE_ROOT,
  fixtureRoot: SESSION,
  verdict: { status: verdict.status, code: verdict.code, line: verdict.line, checks: verdict.checks, failed: verdict.failed, skipped: verdict.skipped },
  copiedAuthority: COPIED_AUTHORITY,
  dependencies: ANCHORS_BEFORE,
})

/** 收尾清场（**守卫过**）：A08 已在自己的判据里清过一次；这里兜住"某条用例提前失败、
 *  A08 没走到清理"的情形 —— FAIL 时也不把夹具留在 E:\Temp（证据已落盘）。
 *  `U08_KEEP=1` 时保留（调试用）。 */
function finalCleanup() {
  if (process.env.U08_KEEP === '1') return { removed: false, error: 'U08_KEEP=1' }
  if (!exists(SESSION)) return { removed: true, error: null, note: '已被 A08 清理' }
  return safeRemoveTree(SESSION, { parent: 'E:\\Temp' })
}
const cleanupResult = finalCleanup()
writeEvidenceJson('cleanup.json', cleanupResult)

process.exit(printVerdict(verdict))
