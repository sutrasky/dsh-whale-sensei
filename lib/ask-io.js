/**
 * ask-io.js — 疑问队列的 IO 薄壳（ESM）
 * ------------------------------------------------------------------
 * 从课程包的 tools/ask-server.js 搬运 IO 逻辑。
 *
 * 分工：
 *   · 本文件只管 文件系统读写 和 handleAsk 编排
 *   · JSON 解析、校验、序号格式化、序列化 等纯逻辑一律 import 自 ./ask.js
 *
 * 铁律：
 *   · 不 import 其它 lib/*.js（模块间不互相 import）
 *   · 不读环境变量、不读 process.cwd()、无模块级可变状态
 *   · 时钟可注入：now 参数，默认 () => new Date().toISOString()
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runSync } from './exec.js'
import {
  parseAskBody,
  formatSeq,
  serializeRecord,
  parsePending,
  validateAnswerBody,
  serializeLedgerEntry,
  insertLedgerEntry,
} from './ask.js'

/** 台账是 CommonJS（UMD），用它自己那套 require；**写完必须清缓存再 require**，否则读到的还是旧对象 */
const requireCJS = createRequire(import.meta.url)
/** 插件模板目录（**不 import 其它 lib/*.js** —— 见文件头铁律，所以这里从自身位置算） */
const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pack-template')
/**
 * 包级事务件（T09 的接口；T10 起本文件的写口统一走它）。
 * 路径按卡面逐字：从 `lib/*.js` 出发 = `./pack-template/tools/ledger-transaction.cjs`。
 */
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')

/** 队列在包内的相对路径（事务件的写集只认包内相对路径） */
const ASK_SEQ_REL = 'questions/seq.txt'
const ASK_PENDING_REL = 'questions/pending.jsonl'
/** 已答台账在包内的相对路径 */
const ASK_LEDGER_REL = 'assets/questions-data.js'

/**
 * 推导疑问队列相关路径。
 * 搬运自 ask-server.js 第 28-31 行（路径常量）。
 * @param {string} root 课程包根目录
 * @returns {{ questionsDir: string, pending: string, processed: string, seqFile: string }}
 */
export function askPaths(root) {
  const questionsDir = path.join(root, 'questions')
  return {
    questionsDir,
    pending: path.join(questionsDir, 'pending.jsonl'),
    processed: path.join(questionsDir, 'processed.jsonl'),
    seqFile: path.join(questionsDir, 'seq.txt')
  }
}

/**
 * 读序号文件，剥掉 BOM 后返回原始文本。
 * 文件不存在返回 ""。
 * 搬运自 ask-server.js 第 67-70 行（读 seq.txt + 剥 BOM）。
 * @param {string} root 课程包根目录
 * @returns {string}
 */
export function readSeq(root) {
  const { seqFile } = askPaths(root)
  try {
    return fs.readFileSync(seqFile, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

/**
 * 事务选项：只把调用方**显式**给的件传下去（默认值仍由事务件说了算）。
 * 生产调用点不传；`test/audit/T10.mjs` 用它注入故障 fs / 持锁令牌。
 */
function txnOpts(txn) {
  if (!txn || typeof txn !== 'object') return undefined
  const o = {}
  if (txn.fs) o.fs = txn.fs
  if (txn.ownerToken !== undefined) o.ownerToken = String(txn.ownerToken)
  if (txn.timeoutMs !== undefined) o.timeoutMs = txn.timeoutMs
  return o
}

/** 事务失败 → `{status, body}`：**明确事务 state**，且绝不把失败回滚写成成功 */
function txnResponse(action, r) {
  const state = r && r.state ? r.state : 'rejected'
  const retryable = state === 'busy' || state === 'recovery-required'
  return {
    status: retryable ? 503 : 500,
    body: {
      ok: false,
      error: `${action}失败（事务 ${state}）：${r && r.error ? r.error : '未知错误'}`,
      state,
      txnId: r && r.txnId ? r.txnId : null,
      rollbackError: r && r.rollbackError ? r.rollbackError : null,
      ...(state === 'busy' ? { retryable: true } : {}),
    },
  }
}

/**
 * 读 pending.jsonl 全文。不存在返回 ""。
 * 搬运自 ask-server.js 第 77-83 行（countPending 的读文件逻辑）。
 * @param {string} root 课程包根目录
 * @returns {string}
 */
export function readPendingText(root) {
  const { pending } = askPaths(root)
  try {
    return fs.readFileSync(pending, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 编排 POST /ask 处理器。
 * 搬运自 ask-server.js 第 187-238 行（POST /ask 完整处理流程）。
 *
 * 流程：校验(parseAskBody) → **同一事务里**取序号 + 入库 → 组响应。
 * 失败时**不许写盘、不许只自增序号**（T10 / C01）：`questions/seq.txt` 与
 * `questions/pending.jsonl` 是同一个写集，第二次写失败 ⇒ 两件都回到写前字节。
 * 序号在**包锁内**算（并发写者不会拿到同一个号）。
 *
 * @param {string} root 课程包根目录
 * @param {{ raw: string, now?: () => string, txn?: {fs?:object, ownerToken?:string, timeoutMs?:number} }} opts
 *        raw=请求体原文，now=时钟注入，txn=测试注入（生产不传）
 * @returns {{ status: number, body: object }}
 */
export async function handleAsk(root, { raw, now, txn } = {}) {
  const clock = now || (() => new Date().toISOString())

  // 搬运自 ask-server.js 第 205-218 行：JSON 解析 + 校验
  // 纯逻辑委托给 ./ask.js 的 parseAskBody
  const parsed = parseAskBody(raw)
  if (!parsed.ok) {
    // ⚠️ 缝上：纯层的失败形状是 { ok:false, status, error }，对外响应体是 { ok:false, error }
    //    （两个 agent 各自推断签名时这里对不上，直接导致 ESM 加载期就炸 ✗）
    return { status: parsed.status, body: { ok: false, error: parsed.error } }
  }

  const abs = path.resolve(root)
  let buildError = null
  let value = null
  let result
  try {
    fs.mkdirSync(abs, { recursive: true })
    result = PACK_TXN.withPackTransaction(abs, ({ files }) => {
      try {
        const declared = Object.prototype.hasOwnProperty.call(files, ASK_SEQ_REL)
          && Object.prototype.hasOwnProperty.call(files, ASK_PENDING_REL)
        if (!declared) {
          // 第 1 次调用：只声明写集（序号 + 队列是**同一写集**）
          return [
            { rel: ASK_SEQ_REL, content: '' },
            { rel: ASK_PENDING_REL, content: '' },
          ]
        }
        const seqText = files[ASK_SEQ_REL] == null ? '' : String(files[ASK_SEQ_REL])
        const pendingText = files[ASK_PENDING_REL] == null ? '' : String(files[ASK_PENDING_REL])

        // 搬运自 ask-server.js 第 219 行：nextId() —— 在锁内、按写前快照算
        const n = (Number(seqText.replace(/^\uFEFF/, '').trim()) || 0) + 1
        const seq = formatSeq(n)
        // 搬运自 ask-server.js 第 220-228 行：构建 record
        const record = serializeRecord(parsed.value, seq, clock)
        // 搬运自 ask-server.js 第 230 行：appendFileSync 同款（上一行没有收尾换行就先补一个）
        const prefix = pendingText.length > 0 && !pendingText.endsWith('\n') ? pendingText + '\n' : pendingText
        const body = prefix + JSON.stringify(record) + '\n'

        // 写后自检（对将要提交的字节做）：最后一行必须解析回来且与写入一致
        const lastLine = body.slice(0, -1).split('\n').pop()
        if (JSON.stringify(JSON.parse(lastLine)) !== JSON.stringify(record)) {
          throw new Error('回读字节与写入不一致')
        }
        value = { n, seq, body }
        return {
          files: [
            // 顺序有讲究：seq 先落位、pending 后落位 —— 第二条失败时必须把 seq 回滚
            // （卡面：**不得只递增 seq 而未入队**）
            { rel: ASK_SEQ_REL, content: String(n) },
            { rel: ASK_PENDING_REL, content: body },
          ],
          value,
        }
      } catch (e) {
        buildError = e
        throw e
      }
    }, txnOpts(txn))
  } catch (e) {
    return {
      status: 500,
      body: {
        ok: false,
        error: `疑问入队失败（事务 rejected）：${e && e.message ? e.message : String(e)}`,
        state: 'rejected',
      },
    }
  }

  if (result.ok) {
    // 原代码这里 console.log 一行；插件环境下不许往 stdout 喷（工具层有自己的日志面）✗
    return { status: 200, body: { ok: true, id: value.seq } }
  }
  if (buildError) {
    return {
      status: 500,
      body: {
        ok: false,
        error: `疑问入队失败（事务 ${result.state}）：${buildError.message}`,
        state: result.state,
        txnId: result.txnId || null,
      },
    }
  }
  return txnResponse('疑问入队', result)
}

/**
 * 只读分支：GET 拉待答队列。
 * 搬运自 ask-server.js 第 77-83 行（countPending）+ 第 125-128 行（GET /health 的 pending 字段）。
 * @param {string} root 课程包根目录
 * @returns {{ status: number, body: object }}
 */
export function readQueue(root) {
  // 用纯层的 parsePending：坏行**不静默吞掉**，收进 errors 一起返回
  const { entries, errors } = parsePending(readPendingText(root))
  return { status: 200, body: { ok: true, pending: entries, count: entries.length, errors } }
}

/* ── answer 写回：只动台账（其余复用课程包现成的 drain / build-notes）──────── */

/** 已答台账的位置（手写 JS，UMD） */
export function ledgerPath(root) {
  return path.join(root, 'assets', 'questions-data.js')
}

/** require 台账（先清缓存：写完再读必须拿到新的） */
export function loadLedger(root) {
  const abs = ledgerPath(root)
  delete requireCJS.cache[abs]
  return requireCJS(abs)
}

/**
 * 在**内存里**加载台账源码（UMD 的 `module.exports = factory()` 那条分支）。
 *
 * 为什么不用 require：事务提交前就要自检「写出的源码能被加载、且只多这一个键」。
 * 写到临时文件再 require 会在包外/包内留中间件，崩溃后就是垃圾；内存里求值只碰字符串，
 * 语义与 require 一致（语法错误 / 运行期抛错都会在这里抛出来）。
 */
function loadLedgerSource(src) {
  const moduleObj = { exports: {} }
  try {
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', String(src))(moduleObj, moduleObj.exports, requireCJS)
  } catch (e) {
    throw new Error(`require 失败：${e && e.message ? e.message : String(e)}`)
  }
  return moduleObj.exports
}

/**
 * 写后自检的**纯**版本（口径与 `verifyOrRollback` 的判定逐字一致）：
 * 新键恰好一个、旧键一个不少。不通过 → 调用方在提交前拒绝（事务 rejected）。
 * @returns {{ ok: boolean, note: string }}
 */
function verifyLedgerSource(src, before, key) {
  const after = loadLedgerSource(src)
  const afterKeys = Object.keys(after)
  const beforeKeys = Object.keys(before)
  const added = afterKeys.filter((k) => !beforeKeys.includes(k))
  const lost = beforeKeys.filter((k) => !afterKeys.includes(k))
  if (added.length === 1 && added[0] === key && lost.length === 0) {
    return { ok: true, note: `新增 ${added[0]} · 丢失 无` }
  }
  return { ok: false, note: `新增 ${added.join('、') || '无'} · 丢失 ${lost.join('、') || '无'}` }
}

/**
 * 就地反馈（P1-8）：按 id 查这一条疑问**答了没** —— 页面交完疑问后轮询它，
 * 答好了就把答案推回那一屏（疑问页退成归档索引）。
 * 只读、幂等；查不到 / 台账读不到 → `answered:false`（**不编**）。
 */
export function lookupAnswer(root, { id }) {
  const key = String(id ?? '').trim()
  if (!/^\d{4}$/.test(key)) {
    return { status: 400, body: { ok: false, error: 'id 必须是四位编号（如 0004）' } }
  }
  try {
    const rec = loadLedger(root)[key]
    const answered = Boolean(rec && rec.status === 'answered' && (rec.answerHtml || rec.answer))
    return answered
      ? {
          status: 200,
          body: {
            ok: true, id: key, answered: true,
            lesson: rec.lesson || '', section: rec.section || '',
            answer: rec.answer || '', answerHtml: rec.answerHtml || '',
          },
        }
      : { status: 200, body: { ok: true, id: key, answered: false } }
  } catch {
    return { status: 200, body: { ok: true, id: key, answered: false, note: '台账读不到（assets/questions-data.js）' } }
  }
}

/**
 * 写入后的自检 + **失败回滚**。
 *
 * 为什么单独抽成一个函数：这条分支（写成功、但自检不过）**只在 I/O 竞态下才可达**，
 * 不抽出来就永远走不到它 —— 等于"写了回滚代码但从没验过" ✗。
 * `load` 是**注入**的（默认 `loadLedger`）：测试传一个"读回来少了键"或"抛错"的 load，
 * 就能真的把回滚跑一遍。这是依赖注入，不是往生产代码里塞测试钩子。
 *
 * @returns {{ ok: boolean, note: string }}
 */
export function verifyOrRollback({ root, abs, src, before, key, load }) {
  const loadFn = load || (() => loadLedger(root))
  let added = []
  let lost = []
  try {
    const after = loadFn()
    const afterKeys = Object.keys(after)
    const beforeKeys = Object.keys(before)
    added = afterKeys.filter((k) => !beforeKeys.includes(k))
    lost = beforeKeys.filter((k) => !afterKeys.includes(k))
    if (added.length === 1 && added[0] === key && lost.length === 0) {
      return { ok: true, note: `新增 ${added[0]} · 丢失 无` }
    }
  } catch (e) {
    fs.writeFileSync(abs, src, 'utf8') // 回滚：原文完整还原
    delete requireCJS.cache[abs]
    return { ok: false, note: `require 失败：${e.message}` }
  }
  fs.writeFileSync(abs, src, 'utf8') // 回滚：原文完整还原
  delete requireCJS.cache[abs]
  return { ok: false, note: `新增 ${added.join('、') || '无'} · 丢失 ${lost.join('、') || '无'}` }
}

function readTextOr(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 在待答 + 已答里找这条疑问（台账的 question 必须是**学生原话**，不许调用方现编） */
export function findQuestion(root, id) {
  const P = askPaths(root)
  for (const file of [P.pending, P.processed]) {
    const { entries } = parsePending(readTextOr(file))
    const hit = entries.find((e) => String(e.id) === String(id))
    if (hit) return hit
  }
  return null
}

/**
 * 队列的**高水位**：待答 + 已答里出现过的最大编号。
 *
 * 为什么需要它：监听"有没有新提问"不能靠"文件被写过" ——
 * 我们自己 drain（重写 pending、行数变少）也会动这个文件，
 * 靠文件变化触发唤醒会变成**自己叫醒自己**的死循环 ✗。
 * 只有"编号比高水位更大"才算真·新提问 ✓
 */
export function queueHighWater(root) {
  const P = askPaths(root)
  let max = 0
  for (const file of [P.pending, P.processed]) {
    const { entries } = parsePending(readTextOr(file))
    for (const e of entries) {
      const n = Number(e.id)
      if (Number.isSafeInteger(n) && n > max) max = n
    }
  }
  return max
}

/**
 * 同步 shell-out 的**有界兜底**（T16 / D07）。
 *
 * 为什么要在这里也设界：这条同步路径是 `spawnSync`，调用方（答疑写回、笔记写回）
 * 就在 HTTP 处理里等着 —— 包里要是有一个「永不退出」或「无限打印」的重建脚本，
 * 旧行为就是**这次响应永远不返回**（内存随输出一起长）。异步那台（`lib/rebuild-job.js`）
 * 的有界手段是超时 + 64KiB 环形尾部；这里对应的两件是 `timeout` 与 `maxBuffer`。
 *
 * ⚠️ 与异步版的**口径差异**（写清楚，别当它俩一样）：
 *   · 同步版把输出**整段**收进内存（上限 = `maxBuffer`，Node 默认就是 1MiB，这里**显式**写出来，
 *     别把上界藏在缺省值里）；异步版留的是 64KiB 的**环形尾部** + `truncated` 标记。
 *   · 超时后同步版只能把**直接子进程**掐掉（spawnSync 不做进程树遍历）；异步版撤的是整棵树
 *     并确认它消失。所以"永不退出的重建脚本"在同步路径上是**有界但粗糙**的兜底 ——
 *     这条差异是 T16 的已知边界（要精细取消得走 `lib/rebuild-job.js` 的作业制）。
 *   · 两侧的**措辞与机器字段仍然同一套**（warnings / rebuild / steps，见 runScript 与 summarize 的对拍）。
 */
export const SYNC_TIMEOUT_MS = 60000
export const SYNC_MAX_OUTPUT_BYTES = 1024 * 1024

/** 跑课程包现成的无参脚本（零依赖、幂等）—— 失败如实回报，不假装成功 */
export function runScript(root, script, { timeoutMs = SYNC_TIMEOUT_MS, maxOutputBytes = SYNC_MAX_OUTPUT_BYTES } = {}) {
  const r = runSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8',
    timeout: timeoutMs,          // 到点掐掉直接子进程（拿不到退出码 → 下面如实记 -1）
    maxBuffer: maxOutputBytes,   // 输出上界：超了 spawnSync 报 ENOBUFS，hint 会带出去
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  // 失败时把**人话**带上：EPERM 这类「子进程根本没起来」的情形，光一个 -1 会把人指向错的修法
  const tail = [out.split('\n').filter(Boolean).slice(-2).join(' ／ '), r.hint].filter(Boolean).join(' ／ ')
  return {
    script,
    code: r.status === null ? -1 : r.status,
    tail,
  }
}

/* ── 执行前的引擎闸（T04 / 报告 D01）─────────────────────────────────────
 *
 * 为什么在这台机器上（而不是 `lib/engine.js` 里）：本文件的铁律是「**不 import 其它
 * lib/*.js**」（见文件头 :11）—— 但**执行包里的代码**这件事，与"哪个 lib 模块"无关，
 * 它只需要**受信引擎口径**那一份判据。所以这里用 `createRequire` 直接读
 * **插件模板里**的 `tools/engine-policy.cjs`（与上面读 CJS 台账同一手法），
 * 口径与 `lib/engine.js`、与包侧读的是**同一个文件**，不是第二份实现。
 *
 * 判据与 preview / rebuild 两侧**逐字同源**：
 *   · 每个脚本路径先过共享路径边界（绝对 / `..` / 反斜杠 / 控制字符一律拒）；
 *   · 这个包的引擎闭包必须与插件模板逐字节一致（缺件 / 不一致 → 拒）。
 *   · 任一条不过 → **零 spawn**（`rebuildArtifacts` 一条都不跑），如实回报 `engineError`。
 */

/** 模板里的受信引擎口径（唯一一份实现）；读不到就**拒**（失败关闭） */
function loadEnginePolicy() {
  const abs = path.join(TEMPLATE_DIR, 'tools', 'engine-policy.cjs')
  delete requireCJS.cache[abs]
  return requireCJS(abs)
}

/** 脚本路径的**字面**边界（口径与共享路径策略一致：绝对 / .. / 反斜杠 / 控制字符） */
function badScriptPath(script) {
  const s = String(script ?? '')
  if (!s) return '脚本路径是空的'
  if (/^[A-Za-z]:/.test(s) || s.startsWith('/') || s.startsWith('\\') || path.isAbsolute(s)) return `脚本路径是绝对路径：${JSON.stringify(s)}`
  if (s.includes('\\')) return `脚本路径里有反斜杠（一律用 /）：${JSON.stringify(s)}`
  if (/[\u0000-\u001f\u007f]/.test(s)) return '脚本路径里有控制字符（含 NUL）—— 拒绝'
  if (s.split('/').some((seg) => seg === '..')) return `脚本路径带 ..（目录穿越）：${JSON.stringify(s)}`
  return null
}

/**
 * 升级入口的**落点**（随插件安装位置算出来的**绝对路径**；本文件不许 import 其它 lib/*.js，
 * 所以这里从自身位置算 —— 与 lib/rebuild-job.js / lib/pack-server.js 的同名块**逐字同源**）。
 * @returns {string}
 */
function upgradePackEntry() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, '..', 'tools', 'upgrade-pack.mjs')
}

/**
 * 引擎被拒时的**修法**：一条能真跑起来的命令 + 两步确认（先 `--plan`，再
 * `--apply --confirm --plan-digest=<digest>`）—— 不自动升级、不覆盖。
 *
 * ⚠️ 四点同源（lib/rebuild-job.js / lib/ask-io.js / lib/pack-server.js ×2），
 *    一致性由 `test/upgrade-entry.mjs` 拿真函数逐字对拍 —— 改一处必须同步另两处。
 * 🐞 2026-10-19 修（Bug4）：旧文案写的是仓根相对的 `node tools/upgrade-pack.mjs`，
 *    npm 装出来的包里根本没有 tools/ ⇒ 用户照抄必 ENOENT。
 * @param {string} root 课程包根（绝对路径；不传就用 `<包根>` 占位）
 * @returns {string}
 */
export function upgradePackHint(root) {
  const entry = upgradePackEntry()
  const at = String(root ?? '').trim() || '<包根>'
  return `修法：用插件自带的升级入口（随插件安装的绝对路径；全局装了也可直接用 bin 名 dsh-whale-pack）`
    + `先只算不写：node "${entry}" --root="${at}" --plan（会打出 plan-digest）；`
    + `确认后再：node "${entry}" --root="${at}" --apply --confirm --plan-digest=<digest>`
}

/**
 * 执行前的引擎闸（**只读、零 spawn**）。
 * @param {string} root 课程包根
 * @param {string[]} scripts 准备跑的脚本
 * @param {{trustedEngine?:boolean}} [opts]
 *   `trustedEngine:false` = **显式旁路**（T04-R2 裁定甲）：只给"夹具不是真包"的测试调用点用，
 *   **缺省 true（严）**，生产调用点一个都不许传 false。
 * @returns {{ok:true}|{ok:false, error:string, badPaths:string[], missing:string[], mismatched:string[]}}
 */
export function verifyScriptsTrusted(root, scripts, { trustedEngine = true } = {}) {
  if (trustedEngine === false) return { ok: true }
  const badPaths = []
  for (const s of scripts) {
    const b = badScriptPath(s)
    if (b) badPaths.push(b)
  }
  if (badPaths.length) {
    return { ok: false, badPaths, missing: [], mismatched: [], error: `脚本路径越界，拒绝执行：${badPaths.join('；')}` }
  }
  let policy
  try {
    policy = loadEnginePolicy()
  } catch (e) {
    return {
      ok: false, badPaths: [], missing: [], mismatched: [],
      error: `读不到插件模板里的受信引擎口径（tools/engine-policy.cjs）：${e?.message ?? e} —— 拒绝执行包里的脚本`,
    }
  }
  let v
  try {
    v = policy.verifyEngine(root, policy.buildManifest(TEMPLATE_DIR))
  } catch (e) {
    return { ok: false, badPaths: [], missing: [], mismatched: [], error: `核验引擎时出错（${e?.message ?? e}）—— 拒绝执行包里的脚本` }
  }
  if (v.ok) return { ok: true }
  return {
    ok: false,
    badPaths: [],
    missing: v.missing,
    mismatched: v.mismatched.map((m) => m.path),
    error: `${policy.summarizeFailure(v.missing, v.mismatched)} —— 拒绝执行包里的脚本（零 spawn）。`
      + upgradePackHint(root),
  }
}

/**
 * 写回之后统一重建产物（answer 与 note **两条写入口共用**）。
 *
 * 为什么必须共用：课程页里嵌了「DSH 笔记」卡片的计数（名词 / 答疑 / 笔记），
 * `reference/NOTES.html` 里嵌了笔记正文与答疑正文 —— 两条写入口少重建哪一种，
 * 那一种就陈旧，课程包闸门（`build-lessons --check` / `build-notes --check`）当场红。
 * 2026-09-21 实测两处：answer 只重建 NOTES.html（课程页陈旧）、note 两种都不重建。
 *
 * @param {string} root 课程包根
 * @param {string[]} scripts 按序执行的无参脚本
 * @param {{ subject?: string, trustedEngine?: boolean, timeoutMs?: number, maxOutputBytes?: number }} [opts]
 *   subject 用于拼警告里的人话主语（如「台账」「笔记」）；
 *   `timeoutMs` / `maxOutputBytes`（T16）是同步路径的**有界兜底**，缺省 60s / 1MiB ——
 *   见 `runScript` 上面那段"口径差异"：同步版有界但粗糙（只掐直接子进程）。
 */
/** 引擎闸拒掉时的**同一句**告警（同步版与异步版逐字同源 —— 见 rebuild-job.js 的对拍） */
export function engineBlockedWarning(gate) {
  return `重建没起：${gate.error}`
}

export function rebuildArtifacts(root, scripts, { subject = '写入', trustedEngine = true, timeoutMs, maxOutputBytes } = {}) {
  // ── 引擎闸（T04 / D01）：**零 spawn** 的前置核验 ────────────────────────
  //    为什么放在这里：这一句下面就是 `spawnSync(node, [脚本])` —— 执行的是包里的代码。
  const gate = verifyScriptsTrusted(root, scripts, { trustedEngine })
  if (!gate.ok) {
    return {
      steps: [],
      rebuild: { ok: false, failed: [...scripts] },
      warnings: [engineBlockedWarning(gate)],
      engineError: gate.error,
      engineMissing: gate.missing,
      engineMismatched: gate.mismatched,
      badPaths: gate.badPaths,
    }
  }

  const steps = scripts.map((s) => runScript(root, s, { timeoutMs, maxOutputBytes }))
  const failed = steps.filter((s) => s.code !== 0)
  return {
    steps,
    rebuild: { ok: failed.length === 0, failed: failed.map((s) => s.script) },
    warnings: failed.map(
      (s) => `重建脚本 ${s.script} 退出码 ${s.code} —— ${subject}已写好，但产物可能是旧的：${s.tail || '（没有输出）'}`
    ),
    engineError: null,
  }
}

/**
 * 编排 POST /answer：校验 → 写台账（外科手术式追加）→ 自检 → 失败回滚 → 重建产物。
 *
 * 顺序与"宁可重复不可丢"：台账写成功前**不碰任何队列文件**；
 * 归档（drain）与重建（build-notes）复用课程包现成脚本，插件不复制它们的语义。
 *
 * @param {string} root 课程包根
 * @param {{ raw: string, now?: () => string, rebuild?: boolean,
 *           resolveLesson?: (x: string) => { key: string, label: string },
 *           txn?: {fs?: object, ownerToken?: string, timeoutMs?: number} }} opts
 *   `resolveLesson` **由调用方注入**（本文件不许 import 其它 lib/*.js，见文件头铁律）：
 *   拿一个课次写法（`第N课` 或 `point/NNNN`）换回 `{ key, label }`；解析不到就 **throw**。
 *   `txn` 仅供测试注入事务件的 fs / 令牌（生产调用点不传）。
 *   `now` **仅为兼容旧调用而保留**：它**不再参与 date**（date 只来自请求体的 `date`，缺省 null）。
 * @returns {{ status: number, body: object }}
 */
export async function handleAnswer(root, { raw, now, rebuild = true, resolveLesson, trustedEngine = true, txn } = {}) {
  // ⚠️ T27（用户裁定）：`now` 参数**保留以兼容旧调用，但它不再参与 date**。
  //    date 只来自请求体（`v.date`，缺省 null）—— 拿时钟推日期就是伪造学生侧事实：
  //    「没给日期」与「日期是今天」在台账里长得一样，事后谁也分不出哪条是编的。
  void now
  const parsed = validateAnswerBody(raw)
  if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } }
  const v = parsed.value

  const abs = ledgerPath(root)
  if (!fs.existsSync(abs)) return { status: 500, body: { ok: false, error: `找不到台账 ${abs}` } }

  const q = findQuestion(root, v.id)
  const question = q?.question || v.question
  if (!question) {
    return {
      status: 400,
      body: { ok: false, error: `队列与归档里都找不到 ${v.id}，也没给 question —— 台账只登记学生真实提过的疑问` },
    }
  }
  const lesson = v.lesson || q?.lesson || ''
  // 课次对位（P1-11）：**写回前先判、失败关闭**。
  // 台账的 `lesson` 是学生页答疑数的过滤键（`render-inputs.js` 按 `q.lesson === lesson` 计数）——
  // 写偏一个字，那一课的答疑数就**永远对不上，而且不会有任何报错**。
  // 所以：非空就必须解析得出来；解析不到 → 拒写（宁可拒，也不挂到一个不存在的课上）。
  let lessonLabel = ''
  if (lesson) {
    if (typeof resolveLesson !== 'function') {
      return {
        status: 500,
        body: { ok: false, error: '写回路径没注入课次解析器（resolveLesson）—— 判不了课次对位就不许写，这里不降级' },
      }
    }
    let hit
    try {
      hit = resolveLesson(lesson)
    } catch (e) {
      return { status: 400, body: { ok: false, error: e.message } }
    }
    if (!hit || !hit.label) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `课次对不上：${JSON.stringify(lesson)} 在课次映射表里解析不到 —— 台账 lesson 写错，学生页上的答疑数就永远对不上（且无报错）。改成一个现有课次再写。`,
        },
      }
    }
    lessonLabel = hit.label
  }
  const entry = {
    id: v.id,
    // ⚠️ 逐字取校验后的值（`string|null`）：**不补今天、不归一化**（T27）
    date: v.date,
    lesson: lessonLabel,
    question,
    // 解答不落在正文里（D3）：统一指向文档页，锚点是 qNNNN
    page: 'reference/NOTES.html',
    anchor: `q${v.id}`,
    section: v.section || (lessonLabel ? `${lessonLabel} 答疑` : '答疑'),
    answer: v.answer,
    answerHtml: v.answerHtml,
  }

  // ── 台账写回 = **一个事务**（T10 / C01）：读旧账、判重键、手术、自检、落位都在包锁内 ──
  let buildError = null
  let value = null
  let result
  try {
    fs.mkdirSync(path.resolve(root), { recursive: true })
    result = PACK_TXN.withPackTransaction(path.resolve(root), ({ files }) => {
      try {
        if (!Object.prototype.hasOwnProperty.call(files, ASK_LEDGER_REL)) {
          return [{ rel: ASK_LEDGER_REL, content: '' }]
        }
        const src = files[ASK_LEDGER_REL] == null ? null : String(files[ASK_LEDGER_REL])
        if (src === null) {
          const e = new Error(`找不到台账 ${abs}`)
          e.status = 500
          throw e
        }
        // 旧账与「重键」判定都在**锁内**、基于同一份写前快照
        let before
        try {
          before = loadLedgerSource(src)
        } catch (e) {
          const err = new Error(`台账 require 失败：${e.message}`)
          err.status = 500
          throw err
        }
        if (Object.prototype.hasOwnProperty.call(before, v.id)) {
          const err = new Error(`台账里已经有 ${v.id} —— 只追加、不覆盖`)
          err.status = 409
          throw err
        }

        let next
        try {
          next = insertLedgerEntry(src, v.id, serializeLedgerEntry(entry))
        } catch (e) {
          const err = new Error(e.message)
          err.status = 409
          throw err
        }

        // 提交前自检：新键在、旧键一个不少、只多一个（与 verifyOrRollback 同口径）
        const check = verifyLedgerSource(next, before, v.id)
        if (!check.ok) {
          const err = new Error(`写入后自检没过（${check.note}）—— 已回滚台账（事务未提交，台账逐字节回到写前）`)
          err.status = 500
          throw err
        }
        const selfCheck = check.note
        value = { selfCheck }
        return [{ rel: ASK_LEDGER_REL, content: next }]
      } catch (e) {
        buildError = e
        throw e
      }
    }, txnOpts(txn))
  } catch (e) {
    return {
      status: 500,
      body: {
        ok: false,
        error: `台账写回失败（事务 rejected）：${e && e.message ? e.message : String(e)}`,
        state: 'rejected',
      },
    }
  }

  let selfCheck
  if (result.ok) {
    selfCheck = value.selfCheck
    // 事务提交后清 require 缓存：后续读点（lookupAnswer / loadLedger）必须拿到新台账
    delete requireCJS.cache[abs]
  } else {
    if (buildError) {
      return {
        status: buildError.status || 500,
        body: {
          ok: false,
          error: buildError.message,
          state: result.state,
          txnId: result.txnId || null,
        },
      }
    }
    return txnResponse('台账写回', result)
  }

  // 顺序有讲究：先归档（pending → processed），再重建**两种**产物。
  // ⚠️ build-lessons 不能省：课程页里嵌了「DSH 笔记」卡片的计数（名词 / 答疑 / 笔记），
  //    台账一改它就陈旧。2026-09-21 实测：写完答案不重建课程页，
  //    `node tools/build-lessons.js --check` 当场红，学生页上的答疑数停在旧值。
  const built = rebuild
    ? rebuildArtifacts(root, ['tools/drain-questions.js', 'tools/build-notes.js', 'tools/build-lessons.js'], {
        subject: '台账',
        trustedEngine,
      })
    : null
  const steps = built ? built.steps : []

  // 重建失败要**结构化地**报出来，但**不能**把"写成功"说成"失败"：
  // 回非 2xx 会诱导调用方重试 → 同一条答案被写两遍（台账只追加不覆盖 ✗）。
  // 所以 status 照旧 200（台账确实写成了），失败单独成字段，并在 warnings 里点名。
  return {
    status: 200,
    body: {
      ok: true,
      id: v.id,
      ledger: 'assets/questions-data.js',
      selfCheck,
      steps,
      ...(built ? { rebuild: built.rebuild, warnings: built.warnings } : {}),
    },
  }
}
