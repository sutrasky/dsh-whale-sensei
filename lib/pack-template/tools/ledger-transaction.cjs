'use strict'
/**
 * ledger-transaction.cjs — 包级**跨进程可恢复提交协议**（T09 / 报告 C01）
 * ------------------------------------------------------------------
 * 为什么要有它（C01 原文）：
 *   台账写口今天是「先写 A 再写 B」，两次写入发生在自检 try **之前** ——
 *   第二次失败（磁盘满 / 权限变化 / 崩溃）就留下半提交（`lib/notes-io.js#L116-L142`）。
 *   另有「读旧账 → 重写整账」「读 max(v) → 追加」「失败后按旧长度截断」等路径；
 *   宿主与独立服务**跨进程**同时写可能覆盖对方、重复序号或回滚掉他人记录。
 *
 * 本件提供**唯一一份**提交协议（多写者共用）：
 *   · **锁**：`.whale-write.lock`（`mkdir` 的原子性当互斥；拿不到就如实回 `busy`，
 *     **不自动强抢** —— 那是卡面 outOfScope 明写的）
 *   · **日志**：`.whale-txn/<uuid>/journal.json`（schema = `whale-txn/1`），
 *     记录每个目标的**写前字节**（备份落在日志目录里），所以恢复不依赖任何外部状态
 *   · **提交点**：所有目标 rename 落位**之后**才把 journal 翻成 `committed` ——
 *     于是崩溃恢复只有两种合法终态：**原状态** 或 **完整已提交状态**，没有半提交
 *   · **回滚失败如实上报**：回 `rollbackError`，日志**保留**，且**下一次普通写被拒**
 *     （`state:'recovery-required'`，要先离线恢复）
 *
 * 契约（卡面接口，不许自行改）：
 *   withPackTransaction(root, build, {timeoutMs:5000, fs}) -> {ok, value?, state, error?, rollbackError?}
 *     state ∈ 'committed' | 'rejected' | 'busy' | 'rolled-back' | 'recovery-required'
 *   recoverPack(root, {offline, confirm, ownerToken}) -> {ok, state, ...}
 *
 * 三条纪律：
 *   ① **只依赖 node: 内置模块**，不 require 包外的东西（本件随包发）
 *   ② 不许出现机器专属路径 / 兄弟仓名（`test/alien-env.mjs` 与 `test/pack-scaffold.mjs`
 *      的静态守卫会当场红）
 *   ③ `.whale-txn/` 与 `.whale-write.lock` **不进学习产物、不进发布物**
 *      （`tools/public-files.cjs` 的拒绝面 + `tools/build-public.js` 的排除表 +
 *      `tools/offline-bootstrap.js` 的白名单三重钉住）
 *
 * ✅ 接线（T11）：`tools/ask-server.js` / `tools/drain-questions.js` 现在**直接 require** 本件 ——
 *    于是 T04 的受信引擎闭包（从入口机械跟传递依赖）把它算进来，本件**在** `ENGINE_FILES` 里；
 *    它也在 `TOOLS_KEEP`（离线骨架白名单，漏了库自己那一份服务起不来）。
 *    闭包是"机械算出来的"，不是许愿池；`test/audit/T04.mjs` 会重算一遍。
 *    它同时进 `lib/pack-scaffold.js` 的 `TEMPLATE_FILES` 与
 *    `test/pack-template-rules.mjs` 的 `FROM_PLUGIN`（随包发的插件侧件）。
 *
 * 判据：`test/audit/T09.mjs`。
 */

const fsReal = require('node:fs')
const path = require('node:path')

/** 日志 schema（进 journal.json 的 `schema` 字段；改格式必须换串） */
const TXN_SCHEMA = 'whale-txn/1'
/** 事务日志目录（包根下；**不进学习产物 / 发布物**） */
const TXN_DIR = '.whale-txn'
/** 跨进程写锁（**不进学习产物 / 发布物**） */
const LOCK_NAME = '.whale-write.lock'
/** journal 文件名 */
const JOURNAL_NAME = 'journal.json'
/** 缺省超时（卡面接口给的默认值） */
const DEFAULT_TIMEOUT_MS = 5000
/** 合法状态（回执的 `state` 与 journal 的 `state` 共用一套词） */
const STATES = ['building', 'prepared', 'committed', 'rejected', 'busy', 'rolled-back', 'recovery-required']

/** 包根下的两个协议落点（**只算不建**） */
function txnPaths(root) {
  const abs = path.resolve(String(root == null ? '' : root).trim() || '.')
  return {
    root: abs,
    dir: path.join(abs, TXN_DIR),
    lock: path.join(abs, LOCK_NAME),
    journalOf: (id) => path.join(abs, TXN_DIR, String(id), JOURNAL_NAME),
  }
}

/** 取一个调用方给的 fs（缺省 = 真 fs）。方法在**调用点**取，不预先解构（测试替身才好注入） */
function fsOf(opts) {
  const fs = opts && opts.fs ? opts.fs : fsReal
  if (!fs || typeof fs !== 'object') throw new Error('fs 注入必须是对象')
  return fs
}

/** 路径是不是落在 root 内（**按分量比**，不做字符串前缀） */
function insideRoot(root, abs) {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 读一个小文本文件；读不动回 null（调用方自己决定这算不算失败） */
function readTextIfExists(fs, abs) {
  try {
    if (!fs.existsSync(abs)) return null
    const st = fs.statSync(abs)
    if (!st.isFile()) return null
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 读一个 JSON 文件；读不动 / 不是对象都回 null */
function readJsonIfExists(fs, abs) {
  const text = readTextIfExists(fs, abs)
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

let atomicCounter = 0
/** 临时件后缀里的**进程内唯一**片段：多进程 + 多写者并发时 `pid+counter` 不够唯一
 *  （两个同 pid 的复用进程、或同一进程重入都会撞），加一段随机数才算够 */
function uniqueSuffix() {
  return `${process.pid}-${(atomicCounter += 1)}-${require('node:crypto').randomBytes(4).toString('hex')}`
}

/**
 * 原子写一个小文件：先 `.tmp-<pid>-<n>-<rand>` 再 rename。
 * **总是把临时件路径带回来**（成功失败都给）—— 调用方按它决定"这是提交点，要留着"还是"收干净"。
 *
 * `rename` 要**重试**：Windows 上刚落盘的文件偶尔会被别的句柄短暂占住（杀软 / 索引器 /
 * 并发读者），`renameSync` 会回 `EPERM` / `EBUSY`。那是**瞬时**的，不是协议失败 ——
 * 卡面要的是"故障如实报告"，不是"把瞬时抖动也报成故障"；重试用完还不行才如实回错。
 * @returns {{ok:boolean, error?:string, code?:string, temp:string, attempts?:number}}
 */
function writeAtomic(fs, abs, content) {
  const dir = path.dirname(abs)
  const temp = `${abs}.tmp-${uniqueSuffix()}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(temp, content)
  } catch (e) {
    return { ok: false, error: `${e && e.code ? e.code : 'IO_ERROR'}: ${e && e.message ? e.message : String(e)}`, code: e && e.code ? e.code : 'IO_ERROR', temp }
  }
  let last = null
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      fs.renameSync(temp, abs)
      return { ok: true, temp, attempts: attempt }
    } catch (e) {
      last = e
      const code = e && e.code ? e.code : 'IO_ERROR'
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      // 只有瞬时码才等；EACCES 也可能是瞬时（杀软扫完就放）
      if (attempt < 6) syncSleep(15 * attempt)
    }
  }
  return { ok: false, error: `${last && last.code ? last.code : 'IO_ERROR'}: ${last && last.message ? last.message : String(last)}`, code: last && last.code ? last.code : 'IO_ERROR', temp }
}

/** 同步小睡（给 rename 重试用；`Atomics.wait` 才是真让出 CPU） */
function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}

/** 收掉一个原子写的临时件（**尽力而为**：它只是中间态，删不掉不该把事务判红） */
function dropTemp(fs, temp) {
  if (!temp) return
  try { fs.rmSync(temp, { force: true }) } catch { /* best effort */ }
}

/** 把一个 `content` 规格化成可写字节（字符串 / Buffer / TypedArray 都收；别的当场拒） */
function bytesOf(content) {
  if (content === null || content === undefined) return Buffer.from('', 'utf8')
  if (typeof content === 'string') return Buffer.from(content, 'utf8')
  if (Buffer.isBuffer(content)) return content
  if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  return null
}

/** 造一个不会撞的 uuid（**不用 crypto.randomUUID 的库依赖，只用内置**） */
function newTxnId() {
  const rnd = require('node:crypto').randomBytes(6).toString('hex')
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${rnd}`
}

/** 包根下的锁元数据（**只给人看**：真正的互斥是 mkdir 的原子性） */
function lockMeta(ownerToken) {
  return JSON.stringify({
    schema: TXN_SCHEMA,
    ownerToken: String(ownerToken == null ? '' : ownerToken),
    pid: process.pid,
    at: new Date().toISOString(),
  }, null, 2) + '\n'
}

/**
 * 拿锁（**不自动强抢**）：`mkdir` 成功 = 拿到；已存在（EEXIST）或**正被并发删除**（EPERM）→ `busy`。
 *
 * 为什么要认 EPERM：Windows 上 `mkdir` 与另一个进程的 `rmdir` 撞车时，`mkdir` 回的是
 * `EPERM`（不是 `EEXIST`）。那**不是**"锁坏了"，是"这会儿拿不到" —— 如实回 `busy` 让人重试，
 * 比报一个假的 `rejected` 诚实（卡面要的是"不自动强抢"，不是"并发删除时误报故障"）。
 * @returns {{ok:true}|{ok:false, busy:true, error:string, owner?:object}}
 */
function acquireLock(fs, root, ownerToken) {
  const { lock } = txnPaths(root)
  try {
    fs.mkdirSync(lock, { recursive: false })
  } catch (e) {
    const code = e && e.code ? e.code : 'IO_ERROR'
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
      const owner = readJsonIfExists(fs, path.join(lock, 'lock.json'))
      const who = owner && owner.ownerToken ? `（持有者 ${owner.ownerToken} / pid ${owner.pid}）` : ''
      const why = code === 'EEXIST' ? '包正在被另一个写者使用' : `锁目录这会儿拿不到（${code}：另一个进程正在删/建它）`
      return { ok: false, busy: true, owner: owner || null, error: `${why}${who}：${lock}（不自动强抢锁 —— 卡面 outOfScope；要恢复请显式跑离线恢复）` }
    }
    return { ok: false, busy: false, error: `拿锁失败（${code}）：${e && e.message ? e.message : String(e)}` }
  }
  const meta = writeAtomic(fs, path.join(lock, 'lock.json'), lockMeta(ownerToken))
  if (!meta.ok) {
    // 元数据写不下不算拿到锁：把刚建的目录收回去，别留一个空锁把后面的人挡在门外
    try { fs.rmSync(lock, { recursive: true, force: true }) } catch { /* best effort */ }
    return { ok: false, busy: false, error: `锁元数据写不下：${meta.error}` }
  }
  // 临时件不留（它就在包根，会进 `ls`；`writeAtomic` 只把 `.tmp-` 当自己的中间态）
  dropTemp(fs, meta.temp)
  return { ok: true }
}

/** 放锁（**重试**：Windows 上与并发 mkdir 撞车会 EPERM/EBUSY；尽力而为，删不掉也不许把已提交的事务说成失败） */
function releaseLock(fs, root) {
  const { lock } = txnPaths(root)
  let last = null
  for (let attempt = 1; attempt <= 8; attempt++) {
    try { fs.rmSync(lock, { recursive: true, force: true }); return { ok: true, attempts: attempt } }
    catch (e) {
      last = e
      const code = e && e.code ? e.code : 'IO_ERROR'
      if (code === 'ENOENT') return { ok: true, attempts: attempt }   // 锁已经没了 = 目标达成
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      if (attempt < 8) syncSleep(10 * attempt)
    }
  }
  return { ok: false, error: `锁删不掉（${last && last.code ? last.code : 'IO_ERROR'}）：${last && last.message ? last.message : String(last)}` }
}

/** 列出 `.whale-txn/` 下的 journal 目录（**只列目录**；读不动的目录也算残骸） */
function listJournals(fs, root) {
  const { dir } = txnPaths(root)
  let names = []
  try {
    if (!fs.existsSync(dir)) return []
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names.slice().sort()) {
    const abs = path.join(dir, name)
    let st = null
    try { st = fs.lstatSync(abs) } catch { continue }
    if (!st.isDirectory()) { out.push({ id: String(name), dir: abs, journal: null, stray: true }); continue }
    out.push({ id: String(name), dir: abs, journal: readJsonIfExists(fs, path.join(abs, JOURNAL_NAME)), stray: false })
  }
  return out
}

/** 有没有"回滚失败、等离线恢复"的日志（有 → 普通写一律拒） */
function pendingRecovery(fs, root) {
  return listJournals(fs, root).filter((j) => j.journal && j.journal.state === 'recovery-required')
}

/**
 * 断言"没有待恢复的日志"。**这是"回滚失败必须拒绝下一次普通写"的落点。**
 * @returns {{ok:true}|{ok:false, ids:string[], error:string}}
 */
function assertNoRecoveryRequired(fs, root) {
  const bad = pendingRecovery(fs, root)
  if (!bad.length) return { ok: true }
  const ids = bad.map((j) => j.id)
  return {
    ok: false,
    ids,
    error: `上一次事务回滚失败、日志还留着（${ids.join('、')}）—— 拒绝这次普通写；`
      + `先跑独占离线恢复：node tools/recover-ledgers.mjs ${root} --offline --confirm --owner=<你的令牌>`,
  }
}

/** 把 build 的返回规格化成 `[{rel, content, remove}]`（**坏形状当场拒**，不猜） */
function normalizePlan(plan) {
  const raw = Array.isArray(plan) ? plan : (plan && Array.isArray(plan.files) ? plan.files : null)
  if (!raw) return { ok: false, error: 'build 必须返回 [{rel, content}] 或 {files:[...], value?}（收到的不是这个形状）' }
  const files = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') return { ok: false, error: `写计划里有一条不是对象：${JSON.stringify(f)}` }
    const rel = String(f.rel == null ? '' : f.rel).replace(/\\/g, '/')
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return { ok: false, error: `写计划的 rel 必须是包内相对路径，实得 ${JSON.stringify(f.rel)}` }
    const remove = f.remove === true
    if (!remove && f.content === undefined) return { ok: false, error: `写计划 ${rel} 既没有 content 也没有 remove:true` }
    files.push({ rel, content: remove ? null : f.content, remove })
  }
  return { ok: true, files, value: plan && !Array.isArray(plan) && 'value' in plan ? plan.value : undefined }
}

/**
 * **跨进程可恢复提交**：拿锁 → 收集写前字节 → 原子写 → 提交点 → 放锁。
 *
 * build 是**同步**函数（本件全程同步，不把同步协议伪装成异步）：
 *   `build({ root, fs, files, txnId }) -> [{rel, content}] | {files:[...], value?}`
 *   · `files` = 每个目标**写前的字节**（`null` = 本来不存在）—— 读台账就在这里读
 *   · 返回值里的 `value` 原样带进回执的 `value` 字段
 *
 * @param {string} root 课程包根
 * @param {Function} build 只算要写什么（**不许自己写盘**；写由本函数统一做）
 * @param {{timeoutMs?:number, fs?:object, ownerToken?:string}} [opts]
 * @returns {{ok:boolean, value?:any, state:string, error?:string|null, rollbackError?:string|null,
 *            txnId?:string, journal?:string, lock?:string, files?:{rel:string,action:string}[]}}
 */
function withPackTransaction(root, build, opts = {}) {
  const fs = fsOf(opts)
  const abs = String(root == null ? '' : root).trim()
  if (!abs) return { ok: false, state: 'rejected', error: '没有课程包根目录', rollbackError: null }
  if (typeof build !== 'function') return { ok: false, state: 'rejected', error: 'build 必须是函数', rollbackError: null }
  const rootAbs = path.resolve(abs)
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, state: 'rejected', error: `timeoutMs 必须是正整数，实得 ${JSON.stringify(opts.timeoutMs)}`, rollbackError: null }
  }
  const ownerToken = opts.ownerToken === undefined ? `pid-${process.pid}` : String(opts.ownerToken)
  const deadline = Date.now() + timeoutMs
  const paths = txnPaths(rootAbs)

  // ① 待恢复的日志 → 普通写一律拒（**在拿锁之前就拒**，别去跟残骸抢锁）
  const pre = assertNoRecoveryRequired(fs, rootAbs)
  if (!pre.ok) return { ok: false, state: 'recovery-required', error: pre.error, rollbackError: null, journal: paths.dir }

  // ② 拿锁
  const lock = acquireLock(fs, rootAbs, ownerToken)
  if (!lock.ok) {
    return { ok: false, state: lock.busy ? 'busy' : 'rejected', error: lock.error, rollbackError: null, lock: paths.lock }
  }
  const done = (result) => {
    if (result.state === 'recovery-required') {
      // 回滚失败时**故意不放锁**：日志 + 锁一起当"必须先恢复"的标记
      return result
    }
    // 没落位的暂存文件（`.tmp-txn-*`）**不留**：它带着本次事务的新内容，留在包根是垃圾
    if (Array.isArray(staged)) for (const { temp } of staged) { try { fs.rmSync(temp, { force: true }) } catch { /* best effort */ } }
    // 日志目录只该活在"事务进行中"：非恢复态一律收干净
    // （**空目录也算**：`build` 抛错时目录刚建出来，留着就是一条没有 journal 的残骸）
    if (result.keepJournal !== true) {
      try { fs.rmSync(journalDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    releaseLock(fs, rootAbs)
    return result
  }

  // ③ 拿锁之后再核一次（拿锁期间别人可能刚写下一条 recovery-required）
  const post = assertNoRecoveryRequired(fs, rootAbs)
  if (!post.ok) return done({ ok: false, state: 'recovery-required', error: post.error, rollbackError: null, journal: paths.dir })

  const txnId = newTxnId()
  const journalDir = path.join(paths.dir, txnId)
  const journalFile = path.join(journalDir, JOURNAL_NAME)
  const state = { state: 'building', txnId, root: rootAbs, startedAt: new Date().toISOString(), files: [] }
  /** 已暂存但还没落位的文件（`done` 要按它清垃圾；声明在 `done` 之前） */
  let staged = null

  /** 写 journal（原子；失败如实回，不静默）。**新内容不进日志** —— 只记写前字节的落点 */
  const putJournal = () => {
    const r = writeAtomic(fs, journalFile, JSON.stringify({
      schema: TXN_SCHEMA,
      txnId: state.txnId,
      root: state.root,
      startedAt: state.startedAt,
      committedAt: state.committedAt,
      recoveryRequiredAt: state.recoveryRequiredAt,
      state: state.state,
      files: state.files.map((f) => ({ rel: f.rel, target: f.target, remove: f.remove, backup: f.backup, existed: f.existed, before: f.before })),
    }, null, 2) + '\n')
    if (r.temp) dropTemp(fs, r.temp)
    return r
  }

  /**
   * 回滚：每个目标恢复**写前状态**。
   * `f.existed` 是**布尔**（不是"备份字节数"）：`false` = 写前真的没有这个文件 ⇒ 删掉；
   * `true` = 写前有 ⇒ 从备份还原（**空文件**也要还原成空文件，不能当成"没有过"）。
   * 失败如实收集，不吞。
   */
  const rollback = () => {
    const errors = []
    for (const f of state.files) {
      try {
        if (f.existed === false) {
          fs.rmSync(f.target, { force: true })
        } else {
          const bytes = fs.readFileSync(path.join(journalDir, f.backup))
          const r = writeAtomic(fs, f.target, bytes)
          dropTemp(fs, r.temp)
          if (!r.ok) errors.push(`${f.rel}：${r.error}`)
        }
      } catch (e) {
        errors.push(`${f.rel}：${e && e.code ? e.code : 'IO_ERROR'}: ${e && e.message ? e.message : String(e)}`)
      }
    }
    return errors
  }

  /** 回滚失败 → 日志翻成 recovery-required（翻不动也要留日志），回执带 rollbackError */
  const failRollback = (primaryError, errors) => {
    state.state = 'recovery-required'
    state.recoveryRequiredAt = new Date().toISOString()
    const flipped = putJournal()
    return done({
      ok: false,
      state: 'recovery-required',
      error: primaryError,
      rollbackError: `${errors.join('；')}${flipped.ok ? '' : `（另外：recovery-required 标记也写不下：${flipped.error}）`}`,
      txnId,
      journal: journalDir,
      lock: paths.lock,
      files: state.files.map((f) => ({ rel: f.rel, action: f.remove ? 'remove' : 'write' })),
    })
  }

  try {
    // ④ 先看 build 声明的写计划**形状**（`read` 提示用来把写前字节喂给它，省一次自己读）
    const declared = build({ root: rootAbs, fs, txnId, files: {}, state })
    if (declared && typeof declared.then === 'function') {
      return done({ ok: false, state: 'rejected', error: 'build 必须同步返回（本协议是同步的；异步写口要自己把结果先算好）', rollbackError: null, txnId })
    }
    const shape = normalizePlan(declared)
    if (!shape.ok) return done({ ok: false, state: 'rejected', error: shape.error, rollbackError: null, txnId })

    // ⑤ 收集写前字节（读失败 = 拒，**不许拿"读不到"当"本来不存在"**）
    const existing = {}
    const beforeBytes = {}
    for (const f of shape.files) {
      const target = path.resolve(rootAbs, f.rel)
      if (!insideRoot(rootAbs, target)) {
        return done({ ok: false, state: 'rejected', error: `写计划的落点跑出包根了：${f.rel}`, rollbackError: null, txnId })
      }
      // 存在性与**内容**永远都要看：删除的目标也要备份（回滚要把它还原），
      // 所以"要删除"不许当成"不用读" —— 那样回滚只能还原出一个空文件（不是原状态）
      let before = null
      try {
        before = fs.existsSync(target) ? fs.readFileSync(target) : null
      } catch (e) {
        return done({
          ok: false, state: 'rejected',
          error: `读不到 ${f.rel} 的写前字节（${e && e.code ? e.code : 'IO_ERROR'}）—— 拒绝在"读不到"的基础上写`,
          rollbackError: null, txnId,
        })
      }
      existing[f.rel] = before
      beforeBytes[f.rel] = before === null ? null : Buffer.from(before).toString('utf8')
    }

    // ⑥ build 再来一次，这回带**真实的写前字节**（台账的"读旧账 → 算新账"就在这里做）
    const plan = normalizePlan(build({ root: rootAbs, fs, txnId, files: beforeBytes, state }))
    if (!plan.ok) return done({ ok: false, state: 'rejected', error: plan.error, rollbackError: null, txnId })

    for (const f of plan.files) {
      const content = f.remove ? null : bytesOf(f.content)
      if (!f.remove && content === null) {
        return done({ ok: false, state: 'rejected', error: `写计划 ${f.rel} 的 content 不是字符串 / Buffer（实得 ${typeof f.content}）`, rollbackError: null, txnId })
      }
      const existed = existing[f.rel] !== null && existing[f.rel] !== undefined
      // 写前不存在 + 要求删除 = **空操作**（不该进计划：它会让回滚去"还原"一个从没有过的文件）
      if (!existed && f.remove) continue
      state.files.push({
        rel: f.rel,
        target: path.resolve(rootAbs, f.rel),
        remove: f.remove,
        // **删除的目标也要备份**：回滚要把它还原回来
        backup: `backup-${state.files.length}.bin`,
        existed,
        // `null` = 本来不存在；数字 = 写前字节数（journal 里给人看的）
        before: existed ? Buffer.from(existing[f.rel]).length : null,
        // 新内容**不进 journal**（`putJournal` 里剔掉）：日志只记"写前字节的落点"
        content,
      })
    }

    // ⑦ 提交前超时检查（build 太慢也算超时；此时一个字节都没写）
    if (Date.now() > deadline) return done({ ok: false, state: 'rejected', error: `事务超时（${timeoutMs}ms）：build 还没算完，一个字节都没写`, rollbackError: null, txnId })

    // ⑧ 备份写进日志目录（**提交点之前**，所以任何时刻恢复都拿得到写前字节）
    //    **删除的目标也备份** —— 回滚要把它还原，不能靠"删一次"当作回滚
    for (const f of state.files) {
      const r = writeAtomic(fs, path.join(journalDir, f.backup), existing[f.rel] === null || existing[f.rel] === undefined ? Buffer.from('', 'utf8') : existing[f.rel])
      dropTemp(fs, r.temp)
      if (!r.ok) {
        const errors = rollback()
        return errors.length
          ? failRollback(`备份写不下（${f.rel}）：${r.error}`, errors)
          : done({ ok: false, state: 'rolled-back', error: `备份写不下（${f.rel}）：${r.error}`, rollbackError: null, txnId })
      }
    }

    // ⑨ 暂存新内容（同目录 `.tmp-` + rename ⇒ 目标要么旧要么新，不会被写花）
    staged = []
    for (const f of state.files) {
      if (f.remove) continue
      const temp = `${f.target}.tmp-txn-${txnId}-${staged.length}`
      try {
        fs.mkdirSync(path.dirname(f.target), { recursive: true })
        fs.writeFileSync(temp, f.content)
      } catch (e) {
        const errors = rollback()
        const why = `暂存 ${f.rel} 失败（${e && e.code ? e.code : 'IO_ERROR'}）：${e && e.message ? e.message : String(e)}`
        return errors.length ? failRollback(why, errors) : done({ ok: false, state: 'rolled-back', error: why, rollbackError: null, txnId })
      }
      staged.push({ f, temp })
    }

    // ⑩ journal → prepared（含全部写前字节的落点）；**此刻还没有任何目标被改**
    state.state = 'prepared'
    const prep = putJournal()
    if (!prep.ok) {
      const errors = rollback()
      const why = `journal(prepared) 写不下：${prep.error}`
      return errors.length ? failRollback(why, errors) : done({ ok: false, state: 'rolled-back', error: why, rollbackError: null, txnId })
    }

    if (Date.now() > deadline) {
      const errors = rollback()
      const why = `事务超时（${timeoutMs}ms）：还没提交`
      return errors.length ? failRollback(why, errors) : done({ ok: false, state: 'rolled-back', error: why, rollbackError: null, txnId })
    }

    // ⑪ 逐个落位（rename 是原子的）
    for (const { f, temp } of staged) {
      try {
        fs.renameSync(temp, f.target)
      } catch (e) {
        const errors = rollback()
        const why = `落位 ${f.rel} 失败（${e && e.code ? e.code : 'IO_ERROR'}）：${e && e.message ? e.message : String(e)}`
        return errors.length ? failRollback(why, errors) : done({ ok: false, state: 'rolled-back', error: why, rollbackError: null, txnId })
      }
    }
    for (const f of state.files) {
      if (!f.remove) continue
      try {
        fs.rmSync(f.target, { force: true })
      } catch (e) {
        const errors = rollback()
        const why = `删除 ${f.rel} 失败（${e && e.code ? e.code : 'IO_ERROR'}）：${e && e.message ? e.message : String(e)}`
        return errors.length ? failRollback(why, errors) : done({ ok: false, state: 'rolled-back', error: why, rollbackError: null, txnId })
      }
    }

    // ⑫ **提交点**：全部落位之后才翻 committed。翻不动 → 目标已经改了但日志说没提交 ⇒ 回滚。
    state.state = 'committed'
    state.committedAt = new Date().toISOString()
    const fin = putJournal()
    if (!fin.ok) {
      const errors = rollback()
      const why = `提交标记写不下：${fin.error}`
      return errors.length ? failRollback(why, errors) : done({ ok: false, state: 'rolled-back', error: why, rollbackError: null, txnId })
    }

    // ⑬ 清日志（清不掉不算失败：日志是 `committed`，恢复只会把它当"已提交"收尾）
    let cleanup = null
    try { fs.rmSync(journalDir, { recursive: true, force: true }) }
    catch (e) { cleanup = `日志目录清不掉（${e && e.code ? e.code : 'IO_ERROR'}）：${e && e.message ? e.message : String(e)}` }

    return done({
      ok: true,
      value: plan.value,
      state: 'committed',
      error: null,
      rollbackError: null,
      cleanup,
      txnId,
      files: state.files.map((f) => ({ rel: f.rel, action: f.remove ? 'remove' : 'write' })),
    })
  } catch (e) {
    // build 自己抛了：**一个字节都没写**（上面的写入全在 try 里按步回执），回 rejected
    return done({
      ok: false,
      state: 'rejected',
      error: `build 抛错：${e && e.message ? e.message : String(e)}`,
      rollbackError: null,
      txnId,
    })
  }
}

/**
 * **独占离线恢复**：把 `.whale-txn/` 里的残骸收干净，回到"原状态"或"完整已提交状态"。
 *
 * 语义（卡面接口）：
 *   · `offline:true` **且** `confirm:true` 才动盘 —— 缺一个就 `rejected`（恢复是危险操作）
 *   · `ownerToken` 必填：恢复要**显式接管**锁（那是本函数唯一的强抢路径，且只在这里）
 *   · `journal.state === 'committed'` → 保留现状（**完整已提交状态**），只清日志
 *   · 否则 → 按备份逐个恢复（**原状态**），删掉新建的、还原改过的
 *   · 恢复本身失败 → `recovery-required` + 日志保留 + 锁保留（下次普通写仍被拒）
 *
 * @param {string} root 课程包根
 * @param {{offline?:boolean, confirm?:boolean, ownerToken?:string, fs?:object}} [opts]
 * @returns {{ok:boolean, state:string, error?:string|null, examined?:string[], restored?:object[],
 *            keptCommitted?:string[], discarded?:string[], lock?:object, txnId?:string}}
 */
function recoverPack(root, opts = {}) {
  const fs = fsOf(opts)
  const abs = String(root == null ? '' : root).trim()
  if (!abs) return { ok: false, state: 'rejected', error: '没有课程包根目录' }
  const rootAbs = path.resolve(abs)
  const ownerToken = opts.ownerToken === undefined ? '' : String(opts.ownerToken)
  if (!ownerToken) return { ok: false, state: 'rejected', error: '恢复必须给 ownerToken（显式声明这次接管是谁做的）' }
  if (opts.offline !== true) return { ok: false, state: 'rejected', error: '恢复只认离线模式：必须显式给 offline:true' }
  if (opts.confirm !== true) return { ok: false, state: 'rejected', error: '恢复会改写台账：必须显式给 confirm:true' }

  const paths = txnPaths(rootAbs)
  const journals = listJournals(fs, rootAbs)
  const examined = journals.map((j) => j.id)

  // 拿锁（若锁已在，**显式接管**：把旧锁挪开再建自己的 —— 这是本函数唯一的强抢路径）
  let takeover = null
  let lock = acquireLock(fs, rootAbs, ownerToken)
  if (!lock.ok && lock.busy) {
    const stale = path.join(rootAbs, `${LOCK_NAME}.stale-${process.pid}-${Date.now().toString(36)}`)
    try {
      fs.renameSync(paths.lock, stale)
      takeover = { from: lock.owner, movedTo: stale }
    } catch (e) {
      return { ok: false, state: 'busy', error: `锁被占着，接管也失败（${e && e.code ? e.code : 'IO_ERROR'}）：${e && e.message ? e.message : String(e)}`, examined }
    }
    lock = acquireLock(fs, rootAbs, ownerToken)
  }
  if (!lock.ok) return { ok: false, state: lock.busy ? 'busy' : 'rejected', error: lock.error, examined }

  const restored = []
  const keptCommitted = []
  const discarded = []
  const failed = []

  for (const j of journals) {
    const journal = j.journal
    if (!journal) {
      // 没有 journal.json = 崩溃在"暂存"阶段（**此刻还没有任何目标被改**）⇒ 直接丢残骸
      try { fs.rmSync(j.dir, { recursive: true, force: true }); discarded.push(j.id) }
      catch (e) { failed.push(`${j.id}（清不掉残骸：${e && e.code ? e.code : 'IO_ERROR'}）`) }
      continue
    }
    if (journal.schema !== TXN_SCHEMA) {
      failed.push(`${j.id}（journal schema 不是 ${TXN_SCHEMA}：${JSON.stringify(journal.schema)}）`)
      continue
    }
    if (journal.state === 'committed') {
      // 完整已提交状态：保留现状，只清日志
      try { fs.rmSync(j.dir, { recursive: true, force: true }); keptCommitted.push(j.id) }
      catch (e) { failed.push(`${j.id}（已提交但日志清不掉：${e && e.code ? e.code : 'IO_ERROR'}）`) }
      continue
    }
    const files = Array.isArray(journal.files) ? journal.files : []
    let bad = false
    for (const f of files) {
      if (!f || typeof f.rel !== 'string' || typeof f.target !== 'string') { bad = true; failed.push(`${j.id}（journal 里有一条不合形状）`); break }
      const target = path.resolve(f.target)
      if (!insideRoot(rootAbs, target)) { bad = true; failed.push(`${j.id}（journal 里的落点跑出包根：${f.rel}）`); break }
      try {
        // `existed === false` = 写前真的没有这个文件 ⇒ 删掉；否则从备份还原（空文件也还原成空）
        // （`backup == null` 是旧日志的形状：那时"删除"没有备份，只能当"写前没有"）
        if (f.existed === false || f.backup === null || f.backup === undefined) {
          fs.rmSync(target, { force: true })
          restored.push({ txnId: j.id, rel: f.rel, action: 'removed' })
        } else {
          const bytes = fs.readFileSync(path.join(j.dir, f.backup))
          const w = writeAtomic(fs, target, bytes)
          dropTemp(fs, w.temp)
          if (!w.ok) { bad = true; failed.push(`${j.id}（还原 ${f.rel} 失败：${w.error}）`); break }
          restored.push({ txnId: j.id, rel: f.rel, action: 'restored', bytes: bytes.length })
        }
      } catch (e) {
        bad = true
        failed.push(`${j.id}（还原 ${f.rel} 失败：${e && e.code ? e.code : 'IO_ERROR'}: ${e && e.message ? e.message : String(e)}）`)
        break
      }
    }
    if (bad) {
      // 恢复失败：**日志保留 + 锁保留**，下次普通写仍被拒
      continue
    }
    try { fs.rmSync(j.dir, { recursive: true, force: true }) }
    catch (e) { failed.push(`${j.id}（恢复完成但日志清不掉：${e && e.code ? e.code : 'IO_ERROR'}）`) }
  }

  // 残骸的**暂存件**也收掉：`.tmp-txn-<journal id>-*`（只按 journal 目录名点名，不做通配扫盘）
  const swept = []
  for (const j of journals) {
    const marker = `.tmp-txn-${j.id}-`
    let names = []
    try { names = fs.readdirSync(rootAbs) } catch { names = [] }
    for (const name of names) {
      if (!name.includes(marker)) continue
      try { fs.rmSync(path.join(rootAbs, name), { force: true }); swept.push(name) }
      catch (e) { failed.push(`${j.id}（暂存件 ${name} 清不掉：${e && e.code ? e.code : 'IO_ERROR'}）`) }
    }
  }

  if (failed.length) {
    return {
      ok: false, state: 'recovery-required',
      error: `恢复没做完：${failed.join('；')}`,
      examined, restored, keptCommitted, discarded, swept, takeover, lock: { path: paths.lock, kept: true },
    }
  }
  const rel = releaseLock(fs, rootAbs)
  if (takeover) { try { fs.rmSync(takeover.movedTo, { recursive: true, force: true }) } catch { /* best effort */ } }
  return {
    ok: true, state: 'recovered',
    error: rel.ok ? null : `恢复做完了，但锁没删掉：${rel.error}`,
    examined, restored, keptCommitted, discarded, swept, takeover,
    lock: { path: paths.lock, released: rel.ok },
  }
}

module.exports = {
  TXN_SCHEMA,
  TXN_DIR,
  LOCK_NAME,
  JOURNAL_NAME,
  DEFAULT_TIMEOUT_MS,
  STATES,
  txnPaths,
  withPackTransaction,
  recoverPack,
  assertNoRecoveryRequired,
  pendingRecovery,
  listJournals,
  readJournal: (root, id, opts) => readJsonIfExists(fsOf(opts), txnPaths(root).journalOf(id)),
}
