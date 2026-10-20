/**
 * test/audit/unify-runner.mjs —— U 系列专项卡的**异步**执行壳（U01 新建）
 * ==================================================================
 * 为什么不能直接用 `test/audit/harness.mjs`：
 *   那边的 `h.case(id, expected, body)` 是**同步壳** —— `body()` 的返回值只要不是
 *   `'skip'` 就记 `pass`。把 `async` 回调交给它，得到一个 Promise，`Promise !== 'skip'`
 *   ⇒ **未完成的断言被记成通过**。这是"测试壳自己恒真"的同一类坑，所以 U 系列单独一个壳：
 *   每个 case **先 await 完**，再按真实结果登记。
 *
 * 契约（U-SPEC §6）：
 *   - 固定用例集合 A01–A08：缺、多、重复、顺序外的 ID 一律不得 PASS。
 *   - 空回调（没有 body / body 是空函数）、抛异常、超时、被截断 —— 都不得 PASS。
 *   - 判词**只有一行**（stdout 合计一行，不再多吐）：
 *       成功 `PASS U01 checks=8 failed=0 skipped=0`                     → exit 0
 *       失败 `FAIL U01 checks=N failed=M skipped=K :: <前三条原因>`      → exit 1
 *       缺料 `BLOCKED U01 <原因>`                                       → exit 2
 *   - 原始细节（每条 case 的状态、备注、耗时、错误栈尾巴）落证据目录，不进判词行。
 *
 * 这个文件**不判断任何业务**：业务断言全在 `test/audit/U01.mjs` 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')

/** 固定用例集合 —— 卡的验收八项。顺序即登记顺序；集合不许多、不许少。 */
export const FIXED_IDS = Object.freeze(['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'])

/** 用例体用 `throw new Blocked(...)` 表示"缺料/命中停止条件"（整卡 BLOCKED，exit 2）。 */
export class Blocked extends Error {
  constructor(reason) {
    super(String(reason))
    this.name = 'Blocked'
    this.blocked = true
  }
}

/** 用例体用 `throw new Truncated(...)` 表示"证据/输出被截断"（该条不得 PASS）。 */
export class Truncated extends Error {
  constructor(reason) {
    super(String(reason))
    this.name = 'Truncated'
    this.truncated = true
  }
}

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_NOTE_BYTES = 2048

/** 空函数体检测：把 `() => {}` / `function () {}` / `() => {}` 这类**真的什么都不做**的体拦下 */
function isEmptyBody(fn) {
  const src = Function.prototype.toString.call(fn)
  const body = src
    .replace(/^[^(]*\([^)]*\)\s*=>\s*/, '')
    .replace(/^async\s+[^(]*\([^)]*\)\s*=>\s*/, '')
    .replace(/^function\s*\w*\s*\([^)]*\)\s*/, '')
    .replace(/^async\s+function\s*\w*\s*\([^)]*\)\s*/, '')
    .trim()
  return /^\{\s*\}$/.test(body) || body === '{}'
}

/** 备注裁剪：**带显式截断标记**（截断本身要被看见，不能静默变短） */
function clipNote(text, max) {
  const s = String(text ?? '')
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false, droppedBytes: 0 }
  const dropped = Buffer.byteLength(s, 'utf8') - max
  return { text: `${s.slice(0, max)}\n…（备注被截断 ${dropped} 字节）…`, truncated: true, droppedBytes: dropped }
}

function normalizeTimeout(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

/**
 * 跑一张卡的固定八项。
 *
 * @param {string} card 卡号（如 `U01`）
 * @param {string[]} ids 声明的固定用例 ID 集合（必须**恰好**等于 FIXED_IDS）
 * @param {Array<{id:string, run:Function, timeoutMs?:number}>|Record<string, Function>} cases
 * @param {{timeoutMs?:number, maxNoteBytes?:number, blocked?:string, evidenceDir?:string, argv?:string[]}} [opts]
 * @returns {Promise<{card:string, checks:number, passed:number, failed:number, skipped:number,
 *   status:'PASS'|'FAIL'|'BLOCKED', code:number, line:string, problems:string[],
 *   truncatedNotes:number, cases:Array, blocked:string|null, ms:number}>}
 */
export async function runCard(card, ids, cases, opts = {}) {
  const started = Date.now()
  const cardId = String(card ?? '').trim() || 'U??'
  const problems = []
  const entries = []
  const notes = []
  let blocked = opts.blocked ? String(opts.blocked) : null
  const maxNote = Number.isFinite(Number(opts.maxNoteBytes)) ? Number(opts.maxNoteBytes) : DEFAULT_MAX_NOTE_BYTES

  // ── ① 固定 ID 集合自检（缺/多/重复/漂移都算问题，**不靠数字绿灯**）──────────
  const wantIds = FIXED_IDS.slice()
  const declared = Array.isArray(ids) ? ids.map((x) => String(x)) : null
  if (!declared) {
    problems.push('ids 必须是数组（固定用例集合）')
  } else {
    const seen = new Map()
    for (const id of declared) seen.set(id, (seen.get(id) ?? 0) + 1)
    for (const id of wantIds) if (!seen.has(id)) problems.push(`固定用例缺失：${id}`)
    for (const [id, n] of seen) {
      if (!wantIds.includes(id)) problems.push(`固定集合外多出用例：${id}`)
      if (n > 1) problems.push(`用例 ID 重复：${id} ×${n}`)
    }
  }

  // ── ② 用例表规范化（数组 / 映射都认；其余一律当"没给"）────────────────────
  let list = []
  if (Array.isArray(cases)) list = cases
  else if (cases && typeof cases === 'object') list = Object.entries(cases).map(([id, run]) => ({ id, run }))
  else problems.push('cases 必须是数组或 { id: fn } 映射')
  if (!list.length) problems.push('没有任何用例（空用例不得 PASS）')

  const byId = new Map()
  for (const c of list) {
    const id = String(c?.id ?? '')
    const run = c?.run
    if (!id) { problems.push('有用例没给 id'); continue }
    if (byId.has(id)) { problems.push(`用例 ID 重复注册：${id}`); continue }
    const entry = { id, expected: 'pass', actual: null, note: '', ms: 0, error: null }
    byId.set(id, entry)
    entries.push(entry)
    if (typeof run !== 'function') {
      entry.actual = 'fail'
      entry.note = '用例没有可执行的 body（空回调）'
      continue
    }
    if (isEmptyBody(run)) {
      entry.actual = 'fail'
      entry.note = '用例 body 是空函数（空回调不得 PASS）'
      continue
    }
    const timeoutMs = normalizeTimeout(c?.timeoutMs ?? opts.timeoutMs)
    const t0 = Date.now()
    let timer = null
    try {
      // ⚠️ 核心：**真的 await**。`await` 之后拿到的才是真实结果；
      //    直接把 async 回调交给同步壳，就会把未完成的 Promise 记成 pass。
      const result = await Promise.race([
        (async () => run())(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`用例超时（>${timeoutMs}ms）`)), timeoutMs)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
      if (result && typeof result === 'object' && result.truncated === true) {
        throw new Truncated(result.note || '用例自报结果被截断')
      }
      if (result === 'skip') {
        entry.actual = 'skip'
        entry.note = '声明为 skip（本卡不允许 skip：skip 不计进 pass）'
      } else {
        entry.actual = 'pass'
      }
    } catch (e) {
      if (e instanceof Blocked || e?.blocked === true) {
        entry.actual = 'fail'
        entry.note = `BLOCKED：${e?.message ?? e}`
        blocked = blocked || String(e?.message ?? e)
      } else if (e instanceof Truncated || e?.truncated === true) {
        entry.actual = 'fail'
        entry.note = `被截断：${e?.message ?? e}`
      } else {
        entry.actual = 'fail'
        entry.note = `抛异常：${e?.message ?? e}`
        entry.error = clipNote(e?.stack ?? String(e), 4000).text
      }
    } finally {
      if (timer) clearTimeout(timer)
      entry.ms = Date.now() - t0
    }
  }

  // 固定集合里声明了、实现里却没有的 —— 单列成缺失用例（**不是**静默通过）
  for (const id of wantIds) {
    if (!byId.has(id)) {
      entries.push({ id, expected: 'pass', actual: 'fail', note: '必需用例缺失（固定集合里有，实现里没有）', ms: 0, error: null })
    }
  }
  // 实现里多出来的（不在固定集合内）—— 登记成问题：集合漂移不得 PASS
  for (const e of entries) {
    if (!wantIds.includes(e.id) && e.actual === 'pass') problems.push(`用例不在固定集合内（集合漂移）：${e.id}`)
  }

  if (blocked) problems.push(`BLOCKED：${blocked}`)

  // ── ③ 备注裁剪（截断要被看见；一次截断就不许 PASS）──────────────────────
  let truncatedNotes = 0
  for (const e of entries) {
    const r = clipNote(e.note, maxNote)
    e.note = r.text
    if (r.truncated) { truncatedNotes += 1; e.truncated = true }
  }

  const checks = entries.length
  const failed = entries.filter((e) => e.actual !== 'pass').length
  const passed = entries.filter((e) => e.actual === 'pass').length
  const skipped = entries.filter((e) => e.actual === 'skip').length
  const badNotes = entries.filter((e) => e.actual !== 'pass').map((e) => `${e.id}: ${e.note || '未通过'}`)

  // PASS 的四个必要条件：没有 blocked、没有失败、没有 skip、没有截断、checks 正好等于固定集合
  const clean = !blocked && failed === 0 && skipped === 0 && truncatedNotes === 0
    && checks === FIXED_IDS.length && problems.length === 0
  const status = blocked ? 'BLOCKED' : (clean ? 'PASS' : 'FAIL')
  const code = status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1
  const reasons = problems.concat(badNotes)
  const line = status === 'PASS'
    ? `PASS ${cardId} checks=${checks} failed=0 skipped=0`
    : status === 'BLOCKED'
      ? `BLOCKED ${cardId} ${blocked ?? problems[0] ?? '缺料'}`
      : `FAIL ${cardId} checks=${checks} failed=${failed} skipped=${skipped} :: ${reasons.slice(0, 3).join(' | ') || '未通过'}`

  if (opts.argv) notes.push(`argv=${JSON.stringify(opts.argv)}`)
  return {
    card: cardId,
    checks,
    passed,
    failed,
    skipped,
    status,
    code,
    line,
    problems,
    truncatedNotes,
    blocked,
    cases: entries,
    ms: Date.now() - started,
    notes,
  }
}

/** 判词**只有一行**：stdout 一行，stderr 不写 */
export function printVerdict(verdict) {
  process.stdout.write(`${verdict.line}\n`)
  return verdict.code
}

/** 证据落盘（本卡新运行目录；**不覆盖已采集的原始证据**） */
export function writeRunEvidence(verdict, dir) {
  const abs = path.resolve(String(dir ?? ''))
  fs.mkdirSync(abs, { recursive: true })
  const record = {
    card: verdict.card,
    status: verdict.status,
    code: verdict.code,
    line: verdict.line,
    checks: verdict.checks,
    passed: verdict.passed,
    failed: verdict.failed,
    skipped: verdict.skipped,
    truncatedNotes: verdict.truncatedNotes,
    blocked: verdict.blocked,
    problems: verdict.problems,
    ms: verdict.ms,
    cases: verdict.cases.map((c) => ({ id: c.id, status: c.actual, expected: c.expected, note: c.note, ms: c.ms })),
    evidenceDir: abs,
  }
  fs.writeFileSync(path.join(abs, 'result.json'), JSON.stringify(record, null, 2), 'utf8')
  fs.writeFileSync(path.join(abs, 'cases.jsonl'), verdict.cases.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
  if (verdict.cases.some((c) => c.error)) {
    fs.writeFileSync(path.join(abs, 'errors.txt'), verdict.cases.filter((c) => c.error).map((c) => `### ${c.id}\n${c.error}`).join('\n\n') + '\n', 'utf8')
  }
  return abs
}

/**
 * `--evidence-root=<绝对路径>` 的守卫：**只许**落在
 *   ① 本卡 `audit-evidence/<card>` 下的新运行目录；② `U20` 的复验目录；
 *   ③ 明确的临时运行目录（`os.tmpdir()` 下、名字带 `u20-`/`<card>-` 前缀）。
 * 其余一律拒绝（不覆盖既有原始证据、不往仓库别处写）。
 */
export function resolveEvidenceRoot(argv, card, { repoRoot = REPO } = {}) {
  const cardId = String(card ?? '')
  const hit = (Array.isArray(argv) ? argv : []).find((a) => String(a).startsWith('--evidence-root='))
  const defaultRoot = path.join(repoRoot, 'audit-evidence', cardId, 'runs', `${cardId}-${process.pid}`)
  if (!hit) return { ok: true, root: defaultRoot, source: 'default' }
  const raw = String(hit).slice('--evidence-root='.length).trim()
  if (!raw) return { ok: false, root: null, error: '--evidence-root 给了空路径' }
  if (!path.isAbsolute(raw)) return { ok: false, root: null, error: `--evidence-root 必须是绝对路径：${raw}` }
  const abs = path.resolve(raw)
  const base = path.basename(abs)
  const named = base.startsWith(`${cardId}-`) || base.startsWith('u20-') || base.startsWith(`${cardId}.`)
  const roots = [
    path.join(repoRoot, 'audit-evidence', cardId),
    path.join(repoRoot, 'audit-evidence', 'U20'),
    path.resolve(process.env.TEMP || process.env.TMP || '/tmp'),
    path.resolve('E:\\Temp'),
  ]
  const inside = roots.some((r) => abs.startsWith(r + path.sep))
  if (!inside || !named) {
    return {
      ok: false,
      root: null,
      error: `--evidence-root 越界（只许 ${cardId} 新运行目录 / U20 复验目录 / 带 ${cardId}- 或 u20- 前缀的临时目录）：${abs}`,
    }
  }
  return { ok: true, root: abs, source: 'argv' }
}

/**
 * 临时目录清理守卫：**先核对解析后的绝对路径与归属**再递归删。
 * 归属 = 调用方声明的父目录（默认本次唯一临时根）+ 名字前缀。
 */
export function guardTempPath(target, { parent }) {
  const abs = path.resolve(String(target ?? ''))
  const par = path.resolve(String(parent ?? ''))
  const base = path.basename(abs)
  if (!abs || abs === par) return { ok: false, error: `拒绝清理：目标是空的或是父目录本身（${abs}）` }
  if (path.dirname(abs) !== par) return { ok: false, error: `拒绝清理：${abs} 的父目录不是声明的 ${par}` }
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return { ok: false, error: `拒绝清理：目录名形状可疑（${base}）` }
  return { ok: true, abs }
}

/** 带守卫的递归删除 */
export function safeRemoveTree(target, { parent }) {
  const g = guardTempPath(target, { parent })
  if (!g.ok) return { removed: false, error: g.error }
  try {
    fs.rmSync(g.abs, { recursive: true, force: true })
    return { removed: true, error: null, abs: g.abs }
  } catch (e) {
    return { removed: false, error: `清理失败：${e?.message ?? e}`, abs: g.abs }
  }
}
