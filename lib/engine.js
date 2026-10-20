/**
 * lib/engine.js — **受信引擎闭包**：核验 / 升级计划 / 显式升级（T04 / 报告 D01）
 * ------------------------------------------------------------------
 * 报告 D01 的事实（证据行号）：
 *   · `lib/pack-server.js#L87-L118` —— 宿主 `createRequire(包)` 直接 **require 包里的**
 *     `tools/app-server.js`；
 *   · `lib/rebuild-job.js#L75-L96` —— 宿主 `spawn(process.execPath, [包内脚本])`；
 *   · `lib/pack-template/tools/offline-server.js#L427-L444` —— 离线阅读器同样按包内脚本起服务。
 *   三处执行的都是**课程包里可写的那份代码** ⇒ 换掉一个字节，宿主下一次预览 / 重建就跑别人的代码。
 *
 * 本模块给三处调用点提供**同一份**前置核验与升级手段：
 *
 *   verifyEngine(root, expectedManifest) → {ok, digest, missing, mismatched}
 *   planEngineUpgrade(root)              → {files, beforeHashes, planDigest, commit}
 *   applyEngineUpgrade(root, {confirm, planDigest})
 *   trustedManifest()                    → 插件**自己模板**的那份受信清单
 *
 * 判据口径（**唯一一份实现**在 `lib/pack-template/tools/engine-policy.cjs`，本文件只做再导出 +
 * 升级那一半）：
 *   · 清单 = **仓内明确代码清单**（`ENGINE_FILES`）逐件 SHA-256；涵盖传递 require / import
 *     与构建子进程（闭包怎么算出来的写在那个文件的注释里，判据在 `test/audit/T04.mjs` 重算）。
 *   · **不信导入包自带的清单**：受信清单只从插件模板算（`trustedManifest`）。
 *   · 缺件 / 字节不一致 / 空清单 → `ok:false`；调用方必须**零 require / 零 spawn** 地拒绝。
 *   · 升级源**只取插件模板**（`TEMPLATE_DIR`），不接受调用方给任意来源路径。
 *   · 备份失败**不得替换**；计划过期（digest 对不上）拒绝；目标**是软链**拒绝。
 *
 * ── 共同三闸（U06 / U08）───────────────────────────────────────────────────────
 * 升级是**显式危险写入**，它不再自带一套"计划 / 确认 / 摘要"判定，而是接到 U06 的共同协议上：
 *
 *   ① 有效计划  —— `planCommit(root, build, {fs})` 给出 `whale-commit/1` 计划，
 *                  本文件把它翻成既有的 `{files:[{path,action,before,after}], planDigest}`
 *                  形状（**原有输出契约不变**）。计划**只读**：不建目录 / 日志 / 锁 / 备份。
 *   ② 显式确认  —— `applyCommit()` 的闸②：`confirm:true` + 调用方回引的 `planDigest` 逐字相符。
 *   ③ 锁内真实字节摘要 —— `applyCommit()` 的闸③：事务件**持锁后**重读每个目标的真实字节，
 *                  再用同一份写前字节重建一遍输出摘要；任一处不符 ⇒ `PLAN_STALE`，一个字节都不落位。
 *
 * 锁 / 日志（`whale-txn/1`）/ 七态 / 离线恢复**全部复用** `ledger-transaction.cjs`
 * （经由 `lib/unify/commit.cjs`）—— 本文件**不建**第二套计划、第二份日志、第二把锁。
 *
 * 本文件额外保留的既有语义（T04 钉住、**不许放宽**）：
 *   · 先备份再替换：`<root>/.engine-backup-<时间戳>/`（`rollbackEngineUpgrade` 只认它）；
 *     备份失败 ⇒ 一件都不替换；备份时机在闸①②之后、真正拿锁之前（前置拒绝时连目录都不建）。
 *   · 目标是软链 / 目录联接 ⇒ 计划里标 `reject`，提交直接拒（绝不写穿链接）。
 *   · 失败文案：`--confirm` / 计划摘要 / 过期或对不上 / 软链 / 备份失败 —— 逐字保持既有说法。
 *
 * 边界（说清，别当它是沙箱）：
 *   这是**引擎一致性核验**，不是任意数据沙箱。学生自己的课、笔记、代码、台账**不在**清单里，
 *   它们变了不影响核验；把"哈希匹配"说成"任意数据沙箱"是错的（本卡 outOfScope 明写）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { TEMPLATE_DIR } from './pack-scaffold.js'

const requireCJS = createRequire(import.meta.url)

/** 受信引擎口径的唯一实现（随包发的那一份，与课程包侧**同一个文件**） */
const policy = requireCJS(path.join(TEMPLATE_DIR, 'tools', 'engine-policy.cjs'))
/** 共同提交守卫（U06）—— 三闸与七态的唯一实现 */
const commitProtocol = requireCJS('./unify/commit.cjs')
/** 失败结构（U03）里的唯一工厂 */
const { makeFailure } = requireCJS('./unify/errors.cjs')
/** 包级事务件（U06 重读后沿用；与 `commit.cjs` 的默认实现是**同一个模块实例**） */
const ledgerTransaction = requireCJS(path.join(TEMPLATE_DIR, 'tools', 'ledger-transaction.cjs'))

export const MANIFEST_VERSION = policy.MANIFEST_VERSION
/** 受信引擎闭包（仓内明确代码清单，POSIX 相对路径） */
export const ENGINE_FILES = policy.ENGINE_FILES
/** 入口注册表（固定：预览 / 答疑归档 / 笔记 / 重建 / 术语） */
export const ENTRY_REGISTRY = policy.ENTRY_REGISTRY
export const buildManifest = policy.buildManifest
export const verifyEngine = policy.verifyEngine
export const digestOfManifest = policy.digestOfManifest
export const sha256 = policy.sha256
export const registryScripts = policy.registryScripts
export const checkRegistry = policy.checkRegistry
export const summarizeFailure = policy.summarizeFailure

/** 升级时**不进**备份、也不算"改动"的临时件前缀 */
const TMP_PREFIX = '.tmp-engine-'
/** 备份目录名前缀（在包根下；`<prefix><时间戳>`） */
const BACKUP_PREFIX = '.engine-backup-'
/** 共同协议的计划 operation（写进 `whale-commit/1` 计划；判据可复算） */
const COMMIT_OPERATION = 'engine-upgrade'

/**
 * 插件**自己模板**的受信清单（唯一可信来源；**绝不**读包自带的清单）。
 * @returns {object} 与 `buildManifest` 同形
 */
export function trustedManifest() {
  return buildManifest(TEMPLATE_DIR)
}

/**
 * 一次核验的**人话**结论（调用方直接贴进 error / note）。
 * @param {{ok:boolean, missing:string[], mismatched:object[]}} v
 * @param {string} [what] 主语（如「预览服务」）
 */
export function engineVerdict(v, what = '引擎') {
  if (v && v.ok) return `${what}与插件受信版本一致`
  const parts = []
  if (v && v.missing && v.missing.length) parts.push(`缺 ${v.missing.length} 件（${v.missing.slice(0, 3).join('、')}${v.missing.length > 3 ? ' …' : ''}）`)
  if (v && v.mismatched && v.mismatched.length) parts.push(`字节不一致 ${v.mismatched.length} 件（${v.mismatched.slice(0, 3).map((m) => m.path).join('、')}${v.mismatched.length > 3 ? ' …' : ''}）`)
  return `${what}与插件受信版本不一致：${parts.join('；') || (v && v.error) || '核验不通过'}`
}

/* ── 共同三闸的 build（**只读**：只算"要写什么"，一个字节都不写） ───────── */

/** 包内相对路径 → 绝对路径 */
function at(root, rel) {
  return path.join(String(root), ...String(rel).split('/'))
}

/**
 * 造 `planCommit` / `applyCommit` 共用的 `build`。
 *
 * 契约（`lib/unify/commit.cjs` 文件头）：**同步纯计算**、拿到的 `fs` 连写能力都没有、
 * 返回 `[{rel, content}]` 或 `{operation, files, value}`。所以"字节在暂存重建"这件事
 * 由事务件在锁内做，本函数只负责读出模板字节并算出差异。
 *
 * @param {{source:string, rejectRels:Set<string>, state:object}} opts
 */
function makeEngineBuild({ source, rejectRels, state }) {
  return function build({ fs: io }) {
    const files = []
    const replaced = []
    const added = []
    const unreadable = []
    for (const rel of ENGINE_FILES) {
      if (rejectRels.has(rel)) continue
      let srcBuf = null
      try {
        srcBuf = io.readFileSync(at(source, rel))
      } catch (e) {
        unreadable.push(`${rel}（${e && e.code ? e.code : '读不到'}）`)
        continue
      }
      let before = null
      try {
        before = io.existsSync(at(state.root, rel)) ? io.readFileSync(at(state.root, rel)) : null
      } catch (e) {
        throw new Error(`读不到 ${rel} 的当前字节（${e && e.code ? e.code : 'IO_ERROR'}）—— 拒绝在"读不到"的基础上造计划`)
      }
      if (before !== null && before.equals(srcBuf)) continue
      files.push({ rel, content: srcBuf })
      if (before === null) added.push(rel)
      else replaced.push(rel)
    }
    if (unreadable.length) {
      throw new Error(`插件模板不完整（缺 ${unreadable.length} 件引擎件）：${unreadable.slice(0, 5).join('、')}`)
    }
    state.replaced = replaced
    state.added = added
    return {
      operation: COMMIT_OPERATION,
      files,
      value: {
        source,
        replaced,
        added,
        planDigest: state.planDigest || null,
        backupDir: state.backupDir || null,
        note: files.length
          ? `已升级 ${replaced.length + added.length} 件（备份在 ${state.backupDir || '（无）'}）`
          : '已经与插件受信引擎一致，没有要动的件',
      },
    }
  }
}

/* ── 升级计划（**只读**：走共同协议的 planCommit） ──────────────────────── */

/** 把共同协议的失败面翻成既有的一句人话（码值不改、文案保持） */
function planFailureText(res, abs) {
  const raw = String((res && res.failure && res.failure.error) || (res && res.error) || '计划算不出来')
  if (/没有课程包根目录/.test(raw)) return '没有课程包根目录'
  if (/不是目录|不可用/.test(raw)) return `课程包根不存在或不是目录：${abs}`
  return raw
}

/**
 * 算一份**升级计划**（**只读、不写盘**：不建目录 / 日志 / 锁 / 备份）。
 *
 * 计划身份（`planDigest`）来自共同协议 `planCommit()` 的 `whale-commit/1` 计划 ——
 * 它同时覆盖「根 + operation + 每个落点的写前摘要 / 输出摘要 / 字节数」，因此它同时是
 *   · **计划身份**（`--apply` 必须回同一个 digest），
 *   · **过期判据**（计划算完之后包又变了 → 重算的 digest 不同 → 拒绝）。
 *
 * `files` 只列**真的要动**的那些（与模板字节不同的）；已经一致的不列（`upToDate:true`）。
 * `beforeHashes` = 包里**现在**的字节摘要（`null` = 现在没有这一件 / 是软链而不碰）。
 *
 * @param {string} root 课程包根
 * @param {{fs?:object}} [opts] `fs` 是判据注入点（与共同协议同一个口径）
 * @returns {{ok:boolean, root?:string, source?:string, files?:object[], beforeHashes?:object,
 *            planDigest?:string, upToDate?:boolean, commit?:object, code?:string, failure?:object,
 *            error?:string}}
 */
export function planEngineUpgrade(root, opts = {}) {
  const io = opts && opts.fs ? opts.fs : fs
  const rootText = String(root ?? '').trim()
  if (!rootText) return { ok: false, error: '没有课程包根目录' }
  const abs = path.resolve(rootText)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: `课程包根不存在或不是目录：${abs}` }
  }

  // 来源**只取插件模板**（不接受调用方给任意来源路径）
  const src = TEMPLATE_DIR
  const missingSrc = ENGINE_FILES.filter((rel) => {
    try { return !fs.statSync(at(src, rel)).isFile() } catch { return true }
  })
  if (missingSrc.length) {
    return { ok: false, error: `插件模板不完整（缺 ${missingSrc.length} 件引擎件）：${missingSrc.slice(0, 5).join('、')}` }
  }

  // 目标**是软链 / 目录联接**：拒（写进去只会穿过链接落到别处，包内那一件仍是旧的）。
  // 它们**不进**共同计划（一个字节都不会被写），但要在既有 `files` 里点名，让 CLI 说清楚。
  const rejectRels = new Set()
  const rejectEntries = []
  const beforeHashes = {}
  for (const rel of ENGINE_FILES) {
    const target = at(abs, rel)
    let lst = null
    try { lst = fs.lstatSync(target) } catch { /* 不存在 = add */ }
    if (lst && lst.isSymbolicLink()) {
      rejectRels.add(rel)
      beforeHashes[rel] = null
      rejectEntries.push({ path: rel, action: 'reject', before: null, after: null, why: '目标是软链 / 目录联接 —— 拒绝替换' })
      continue
    }
    try { beforeHashes[rel] = lst && lst.isFile() ? sha256(fs.readFileSync(target)) : null } catch { beforeHashes[rel] = null }
  }

  const state = { root: abs, rejectRels, replaced: [], added: [], backupDir: null }
  const build = makeEngineBuild({ source: src, rejectRels, state })
  const planned = commitProtocol.planCommit(abs, build, { fs: io })
  if (!planned || planned.ok !== true) {
    return {
      ok: false,
      error: planFailureText(planned, abs),
      code: planned && planned.code ? planned.code : 'PLAN_REQUIRED',
      failure: planned && planned.failure ? planned.failure : null,
    }
  }
  const commitPlan = planned.plan

  const entries = (commitPlan.files || []).map((f) => {
    const before = beforeHashes[f.rel] === undefined ? null : beforeHashes[f.rel]
    return {
      path: f.rel,
      action: before === null ? 'add' : 'replace',
      before,
      after: { sha256: f.digest, bytes: f.bytes },
    }
  })
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const files = [...rejectEntries, ...entries].sort(byPath)

  return {
    ok: true,
    root: abs,
    source: src,
    files,
    beforeHashes,
    planDigest: commitPlan.planDigest,
    upToDate: files.length === 0,
    // 共同协议的计划原件（`applyEngineUpgrade` 用它提交；判据也用它证明"同一套计划"）
    commit: commitPlan,
  }
}

/**
 * 旧口径的计划摘要（**保留导出，不再是计划身份**）。
 * 计划身份已归共同协议 `planCommit()`（`whale-commit/1`）；本函数只为兼容既有 import 保留，
 * 纯函数、同样输入永远同样摘要。
 */
export function digestOfPlan({ root, source, files, beforeHashes }) {
  const rows = [...(files ?? [])]
    .map((f) => `${f.path}\t${f.action}\t${(f.after && f.after.sha256) || ''}`)
    .sort()
  const before = Object.keys(beforeHashes ?? {}).sort().map((k) => `${k}\t${beforeHashes[k] ?? ''}`)
  const text = [
    `plan=${MANIFEST_VERSION}`,
    `root=${path.resolve(String(root ?? ''))}`,
    `source=${path.resolve(String(source ?? ''))}`,
    ...rows,
    '--before--',
    ...before,
  ].join('\n')
  return sha256(Buffer.from(text, 'utf8'))
}

/* ── 显式升级（共同三闸 + 既有备份 / 回滚语义） ────────────────────────── */

/**
 * 把**既有备份语义**挂到共同协议上。
 *
 * 事务件本身在锁内已有"写前字节备份 + 回滚"（`whale-txn/1` 日志）；这里补的是
 * **用户能拿走的那一份** `<root>/.engine-backup-<时间戳>/`（`rollbackEngineUpgrade` 只认它）
 * —— 时机 = 闸①②都过了之后、真正拿锁之前：
 *   · 前置拒绝（缺确认 / 摘要不符）⇒ 连这个目录都不会被建（A02 的计数探针也看这个）；
 *   · 备份失败 ⇒ 直接拒、**一件都不替换**（既有语义）；
 *   · 闸③在锁内失败（一个字节都没写）⇒ 把这次备份收回（它基于**未锁**的字节，留着会误导回滚）。
 *
 * **不是**第二套锁 / 日志：拿锁、写日志、七态、回滚都在 `withPackTransaction` 里。
 */
function makeEngineTransaction({ realTransaction, source, state, io }) {
  const ioOf = io
  return {
    withPackTransaction(rootAbs, build, txnOpts) {
      const entries = Array.isArray(state.entries) ? state.entries.filter((f) => f.action !== 'reject') : []
      try {
        if (entries.length) {
          const dir = path.join(rootAbs, `${BACKUP_PREFIX}${state.stamp}`)
          ioOf.mkdirSync(dir, { recursive: true })
          for (const f of entries) {
            if (f.action !== 'replace') continue
            const dst = at(dir, f.path)
            ioOf.mkdirSync(path.dirname(dst), { recursive: true })
            ioOf.copyFileSync(at(rootAbs, f.path), dst)
          }
          ioOf.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify({
            planDigest: state.planDigest,
            root: rootAbs,
            source,
            files: entries.map((f) => ({ path: f.path, action: f.action, before: f.before, after: f.after })),
          }, null, 2)}\n`, 'utf8')
          state.backupDir = dir
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        if (state.backupDir) { try { ioOf.rmSync(state.backupDir, { recursive: true, force: true }) } catch { /* 尽力清理 */ } }
        state.backupDir = null
        state.backupError = msg
        return { ok: false, state: 'rejected', error: `备份失败（${msg}）—— 已中止，包里一件都没动`, rollbackError: null }
      }

      const res = realTransaction.withPackTransaction(rootAbs, build, txnOpts)

      // 一个字节都没写就失败（闸③ / 锁忙）：收回这次备份（理由见函数头）
      if (!res || res.ok !== true) {
        const st = String(res && res.state ? res.state : '')
        if (st === 'rejected' || st === 'busy') {
          if (state.backupDir) { try { ioOf.rmSync(state.backupDir, { recursive: true, force: true }) } catch { /* 尽力清理 */ } }
          state.backupDir = null
        }
      }
      return res
    },
    failureFor: (r) => (typeof realTransaction.failureFor === 'function' ? realTransaction.failureFor(r) : null),
    txnPaths: (r) => (typeof realTransaction.txnPaths === 'function' ? realTransaction.txnPaths(r) : path.join(String(r), '.whale-txn')),
    assertNoRecoveryRequired: (ioArg, rootArg) => (typeof realTransaction.assertNoRecoveryRequired === 'function'
      ? realTransaction.assertNoRecoveryRequired(ioArg, rootArg)
      : { ok: true }),
  }
}

/** 共同协议的回执 → 既有的升级回执（既有字段一个不改；`state` / `failure` / `code` 是新增字段） */
function applyFailureReceipt({ out, failure, state, abs, planDigest }) {
  const code = String((failure && failure.code) || (out && out.code) || 'IO_ERROR')
  const st = String((out && out.state) || '')
  const base = {
    ok: false,
    root: abs,
    planDigest,
    replaced: Array.isArray(state.replaced) ? state.replaced : [],
    added: Array.isArray(state.added) ? state.added : [],
    backupDir: state.backupDir === undefined ? null : state.backupDir,
    rolledBack: false,
    code,
    failure,
    state: st,
  }
  if (state.backupError) {
    const error = `备份失败（${state.backupError}）—— 已中止，包里一件都没动`
    return { ...base, error, code: 'IO_ERROR', failure: makeFailure({ kind: 'io', code: 'IO_ERROR', error }) }
  }
  if (code === 'CONFIRM_REQUIRED') {
    return { ...base, error: '升级会覆盖包里的引擎件 —— 必须显式确认（--confirm）才动盘' }
  }
  if (code === 'PLAN_STALE') {
    const missingDigest = !planDigest || typeof planDigest !== 'string'
    return {
      ...base,
      error: missingDigest
        ? '没给计划摘要（--plan-digest=<digest>）—— 没有它就无法判"这份计划还是不是当初那一份"'
        : `计划过期或对不上（${failure.error}）—— 包里那些引擎件在算完计划之后又变过，重新跑一次 --plan 再提交`,
    }
  }
  if (code === 'LOCK_BUSY') {
    return { ...base, error: `包正在被另一个写者使用，稍后重试（${failure.error}）` }
  }
  if (st === 'recovery-required') {
    return {
      ...base, rolledBack: true,
      error: `上一次事务回滚失败，日志与锁都保留、离线恢复前不接受普通写入：${failure.error}`,
    }
  }
  if (st === 'rolled-back') {
    return {
      ...base, rolledBack: true,
      error: `升级中途失败（${failure.error}）—— 已就地回滚到升级前（备份留在 ${state.backupDir ?? '（无）'}）`,
    }
  }
  return { ...base, error: failure.error }
}

/**
 * **显式升级**：把插件模板的引擎件铺进这个包（**先备份，再替换**）。
 *
 * 三闸（共同协议 `applyCommit`，缺一不可、顺序固定）：
 *   ① 有效计划 / 目标 / 操作；
 *   ② `confirm === true` + 调用方回引的 `planDigest` 逐字相符；
 *   ③ 锁内真实字节摘要（事务件持锁后重读 + 重建，不符即 `PLAN_STALE`）。
 *
 * 前置拒绝（①②）**一次都不调用事务件**（A02 的计数探针据此记 0）。
 * 备份语义不变：`<root>/.engine-backup-<时间戳>/` 先落盘，备份失败 **不替换**。
 * 中途失败由事务件回滚；回滚失败如实报 `recovery-required`（不宣称已恢复）。
 *
 * @param {string} root
 * @param {{confirm?:boolean, planDigest?:string, now?:() => number, fs?:object,
 *          transaction?:object}} [opts]
 *        `now` / `fs` / `transaction` 是**判据注入点**（`now` 决定备份目录名；既有用法不变）
 * @returns {{ok:boolean, root?:string, planDigest?:string, replaced?:string[], added?:string[],
 *            backupDir?:string|null, rolledBack?:boolean, error?:string, code?:string,
 *            failure?:object|null, state?:string, note?:string}}
 */
export function applyEngineUpgrade(root, { confirm = false, planDigest = '', now, fs: injectedFs, transaction } = {}) {
  const io = injectedFs || fs
  const rootText = String(root ?? '').trim()
  if (!rootText) return { ok: false, error: '没有课程包根目录' }
  const abs = path.resolve(rootText)

  const plan = planEngineUpgrade(abs, { fs: io })
  if (!plan.ok) return { ok: false, error: plan.error }

  const rejected = plan.files.filter((f) => f.action === 'reject')
  if (rejected.length) {
    return { ok: false, error: `拒绝替换软链目标：${rejected.map((f) => f.path).join('、')}（写进去会穿过链接落到别处）` }
  }

  const stamp = typeof now === 'function' ? String(now()) : String(Date.now())
  const state = {
    root: abs,
    stamp,
    entries: plan.files,
    planDigest: plan.commit.planDigest,
    backupDir: null,
    backupError: null,
    replaced: [],
    added: [],
  }
  const build = makeEngineBuild({ source: plan.source, rejectRels: new Set(), state })
  const realTransaction = transaction || ledgerTransaction
  const txn = makeEngineTransaction({ realTransaction, source: plan.source, state, io })

  const out = commitProtocol.applyCommit(abs, plan.commit, {
    confirm,
    planDigest,
    build,
    transaction: txn,
    fs: io,
  })

  if (out && out.ok === true) {
    const v = out.value && typeof out.value === 'object' ? out.value : {}
    const receipt = {
      ok: true,
      root: abs,
      planDigest: v.planDigest || plan.commit.planDigest,
      replaced: Array.isArray(v.replaced) ? v.replaced : [],
      added: Array.isArray(v.added) ? v.added : [],
      backupDir: v.backupDir === undefined ? null : v.backupDir,
      rolledBack: false,
      state: String(out.state || 'committed'),
      failure: null,
    }
    if (v.note) receipt.note = v.note
    return receipt
  }

  const failure = (out && out.failure)
    || makeFailure({ kind: 'io', code: 'IO_ERROR', error: '升级被拒（共同提交协议没有给出原因）' })
  return applyFailureReceipt({ out, failure, state, abs, planDigest })
}

/**
 * 从一份备份目录**显式回滚**（`applyEngineUpgrade` 自动回滚之外的"人工后悔"口）。
 * 只认**本模块**写出来的备份（`plan.json` 必须在、`root` 必须与传入的根一致）。
 *
 * 这是"从一份显式备份还原"的既有能力（不是提交协议，也不写日志/锁）：`confirm` 闸与
 * 备份归属校验逐字保持。
 *
 * @param {string} root
 * @param {{confirm?:boolean, backupDir?:string}} [opts]
 */
export function rollbackEngineUpgrade(root, { confirm = false, backupDir = '' } = {}) {
  if (confirm !== true) return { ok: false, error: '回滚会覆盖包里的引擎件 —— 必须显式确认（--confirm）' }
  const abs = path.resolve(String(root ?? ''))
  const dir = path.resolve(String(backupDir ?? ''))
  if (!backupDir) return { ok: false, error: '没给备份目录' }
  if (!dir.startsWith(abs + path.sep) || !path.basename(dir).startsWith(BACKUP_PREFIX)) {
    return { ok: false, error: `拒绝：${dir} 不是这个包里的引擎备份目录（须在 ${abs} 下且以 ${BACKUP_PREFIX} 开头）` }
  }
  const planFile = path.join(dir, 'plan.json')
  let rec = null
  try { rec = JSON.parse(fs.readFileSync(planFile, 'utf8')) } catch (e) {
    return { ok: false, error: `读不到备份里的 plan.json：${e && e.message ? e.message : e}` }
  }
  if (path.resolve(String(rec.root ?? '')) !== abs) {
    return { ok: false, error: `备份记录的根（${rec.root}）与传入的根（${abs}）不是同一个 —— 拒绝` }
  }
  const restored = []
  const removed = []
  try {
    for (const f of rec.files ?? []) {
      const target = path.join(abs, ...String(f.path).split('/'))
      const src = path.join(dir, ...String(f.path).split('/'))
      if (f.action === 'add') { fs.rmSync(target, { force: true }); removed.push(f.path); continue }
      if (!fs.existsSync(src)) return { ok: false, error: `备份里缺 ${f.path} —— 拒绝半套回滚` }
      const tmp = `${target}.${TMP_PREFIX}${process.pid}`
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, target)
      restored.push(f.path)
    }
  } catch (e) {
    return { ok: false, error: `回滚失败（${e && e.message ? e.message : e}）—— 备份仍在 ${dir}`, restored, removed }
  }
  return { ok: true, root: abs, backupDir: dir, restored, removed, note: `已回滚 ${restored.length} 件、移除 ${removed.length} 件` }
}

/** 插件模板里那份引擎清单的摘要（给界面/日志一个"我们认的是哪一版"的指纹） */
export function trustedDigest() {
  return trustedManifest().digest
}

/** 共同三闸的协议名（判据与回执引用它，别在别处再写一份字符串） */
export const ENGINE_COMMIT_SCHEMA = commitProtocol.COMMIT_SCHEMA
/** 供判据用：备份目录名常量 */
export const ENGINE_BACKUP_PREFIX = BACKUP_PREFIX
/** 供判据用：临时件前缀 */
export const ENGINE_TMP_PREFIX = TMP_PREFIX
/** 供判据用：`crypto` 的同一份实现（别在别处再写一份 sha256 口径） */
export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
