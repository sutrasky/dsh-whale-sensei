/**
 * lib/glossary-edit-io.js —— 术语增改的**落盘层**（ESM 适配层；源码手术在 `lib/unify/glossary.cjs`）
 *
 * 四条判据，每条都能反空转：
 *   ① 写后必须真的能被 require 回来，且目标记录与传入逐字段一致
 *   ② require 自检不过 → **不提交**（事务 rejected；文件逐字节回到写前），并明确报出 rolledBack
 *   ③ 同 key 且 replace=false → 拒绝，文件**一动不动**（手术放在写盘之前抛）
 *   ④ 一律 UTF-8 **不带 BOM**（本机 BOM 是一类 bug：JSON.parse 直接抛、
 *      逐行解析会静默少一条）
 *
 * 为什么自检要用"加载"而不是"再看一眼文本"：文本看着对、加载后字段错
 * （引号/转义/模板串写坏）是最容易漏的一类，只有真加载一次才知道。
 *
 * T10 / C01：台账是**一个写集**，读旧账、手术、加载自检、落位都在包锁内完成
 * （`withPackTransaction`）。自检在**提交前**对"将要写出的源码"做，所以自检不过时
 * 一个字节都不会落盘 —— 不需要"先写坏再回滚"。
 *
 * U11：字符串手术（`upsertTermSource`）、键解析（`parseTermKeys`）、字段逐条比对
 * （`compareTermRecord`）、"同进程重读必须最新"（`requireFresh`）都已在权威内核里，
 * 本文件只保留**事务与落盘**这一层。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const requireCJS = createRequire(import.meta.url)
const core = requireCJS('./unify/glossary.cjs')

/** 台账落点（包根相对；与内核的 `GLOSSARY_LEDGER_REL` 同一份） */
export const LEDGER_REL = path.join(...core.GLOSSARY_LEDGER_REL.split('/'))

/** 包级事务件（T09）：术语台账的读改写 + 自检在包锁内完成（T10 / C01） */
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')
/** 事务写集只认包内相对路径（与 `LEDGER_REL` 同一落点，分隔符固定为 `/`） */
const LEDGER_REL_POSIX = core.GLOSSARY_LEDGER_REL

/** 事务选项：只把调用方**显式**给的件传下去（生产不传；T10 测试用它注入故障 fs） */
function txnOpts(txn) {
  if (!txn || typeof txn !== 'object') return undefined
  const o = {}
  if (txn.fs) o.fs = txn.fs
  if (txn.ownerToken !== undefined) o.ownerToken = String(txn.ownerToken)
  if (txn.timeoutMs !== undefined) o.timeoutMs = txn.timeoutMs
  return o
}

/** 事务失败 → 抛出带**明确事务状态**的错误（原错误形状 = 抛出；不把回滚失败写成成功） */
function txnFailure(action, r) {
  const state = r && r.state ? r.state : 'rejected'
  const e = new Error(`${action}失败（事务 ${state}）：${r && r.error ? r.error : '未知错误'}`)
  e.txnState = state
  if (r && r.txnId) e.txnId = r.txnId
  if (r && r.journal) e.journal = r.journal
  if (r && r.rollbackError) e.rollbackError = r.rollbackError
  e.httpStatus = (state === 'busy' || state === 'recovery-required') ? 503 : 500
  return e
}

/** 加载并逐字段核对目标记录 */
export function verifyLoadedTerm(abs, key, record) {
  try {
    const req = createRequire(abs)
    const led = core.requireFresh(req, abs)
    const cmp = core.compareTermRecord(key, led && led[key], record)
    if (!cmp.ok) return { ok: false, error: cmp.error }
    return { ok: true, keys: Object.keys(led) }
  } catch (e) {
    return { ok: false, error: 'require 失败：' + e.message }
  }
}

/**
 * 在**内存里**加载一份台账源码（UMD 的 `module.exports = factory()` 分支），
 * 判据与 `verifyLoadedTerm` 逐字段一致。用于**提交前**自检：不在盘上留任何探针文件。
 */
function verifyLoadedTermSource(body, key, record) {
  let led
  try {
    const moduleObj = { exports: {} }
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', String(body))(moduleObj, moduleObj.exports, requireCJS)
    led = moduleObj.exports
  } catch (e) {
    return { ok: false, error: 'require 失败：' + (e && e.message ? e.message : String(e)) }
  }
  const cmp = core.compareTermRecord(key, led && led[key], record)
  if (!cmp.ok) return { ok: false, error: cmp.error }
  return { ok: true, keys: Object.keys(led) }
}

/**
 * 在课程包里插入/替换一条术语记录，写后自检，失败不提交。
 * @param {{root: string, key: string, record: object, replace?: boolean, corrupt?: boolean,
 *          txn?: {fs?:object, ownerToken?:string, timeoutMs?:number}}} o
 *        corrupt 仅供测试：故意写入语法错误，用来验证自检分支真的会走
 *        txn 仅供测试注入事务件（生产调用点不传）
 */
export function writeTermSurgically(o = {}) {
  const { root, key, record, replace = false, corrupt = false } = o
  if (!root) throw new Error('缺少 root')
  if (!key) throw new Error('缺少 key')
  const abs = path.resolve(root, LEDGER_REL)
  if (!fs.existsSync(abs)) throw new Error('找不到台账文件：' + abs)

  let buildError = null
  let value = null
  let result
  try {
    result = PACK_TXN.withPackTransaction(path.resolve(root), ({ files }) => {
      try {
        if (!Object.prototype.hasOwnProperty.call(files, LEDGER_REL_POSIX)) {
          return [{ rel: LEDGER_REL_POSIX, content: '' }]
        }
        const src = files[LEDGER_REL_POSIX] == null ? null : String(files[LEDGER_REL_POSIX])
        if (src === null) throw new Error('找不到台账文件：' + abs)
        // 手术失败（同键且没给 replace、或 replace 不存在的键）在提交之前抛 → 文件不动
        const next = core.upsertTermSource(src, key, record, { replace })
        const body = corrupt ? next + '\nfunction (\n' : next
        // 提交前自检：写出的源码真的能加载，且目标记录逐字段一致
        const check = verifyLoadedTermSource(body, key, record)
        if (!check.ok) {
          const e = new Error(check.error)
          e.selfCheckFailure = true
          throw e
        }
        value = { keys: core.parseTermKeys(body), bytes: Buffer.byteLength(body) }
        return [{ rel: LEDGER_REL_POSIX, content: Buffer.from(body, 'utf8') }]
      } catch (e) {
        buildError = e
        throw e
      }
    }, txnOpts(o.txn))
  } catch (e) {
    if (e && e.txnState) throw e
    const wrapped = new Error(`术语写入失败（事务 rejected）：${e && e.message ? e.message : String(e)}`)
    wrapped.txnState = 'rejected'
    wrapped.httpStatus = 500
    throw wrapped
  }

  if (result.ok) {
    return { ok: true, abs, keys: value.keys, bytes: value.bytes, replaced: replace }
  }
  if (buildError) {
    if (buildError.selfCheckFailure) {
      // 自检不过 ⇒ 事务未提交（一个字节都没落），保留原回执形状并加明确事务 state
      return {
        ok: false,
        error: '写后自检没过，已回滚：' + buildError.message,
        rolledBack: true,
        abs,
        state: result.state,
        txnId: result.txnId,
      }
    }
    throw buildError
  }
  throw txnFailure('术语写入', result)
}
