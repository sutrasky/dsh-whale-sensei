/**
 * audit/harness.mjs —— 审计卡的**公共小测试壳**（T01 建，后续卡只新增自己的入口）
 * ------------------------------------------------------------------
 * 契约（已批准计划 §4）：
 *   - stdout/stderr 合计只给**一行**：
 *       成功  `PASS T<n> checks=N failed=0 skipped=0`
 *       失败  `FAIL T<n> ...`                且 exit 1
 *       缺料  `BLOCKED T<n> ...`             且 exit 2
 *   - N 必须 > 0，并**核对固定的用例 ID 集合**（缺一条、多一条、重一条都算失败）——
 *     禁止只靠数字绿灯。
 *   - 子进程完整原始输出、退出码、用例执行记录落到 `R/audit-evidence/T<n>/`；
 *     一行结论只是索引，不替代原始证据。
 *   - 超时、输出截断、异常、缺摘要**都不得被吞掉**：一律记成 fail 并留原始片段。
 *
 * 为什么壳自己也要能失败：报告 F01/F03 的教训是「测试壳自己恒真」。
 * 所以本壳有三道自检：① 每个用例**声明**期望状态，实跑与声明不符即 fail；
 * ② 固定 ID 集合必须逐条对上；③ 壳内部异常一律变成 fail（不是 throw 出去消失）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')
export const TEST_DIR = path.join(REPO, 'test')
export const EVIDENCE_DIR = path.join(REPO, 'audit-evidence')

/** 把一段文字裁成能塞进证据文件、又不丢信息尾巴的形状 */
export function clip(text, n = 4000) {
  const s = String(text ?? '')
  if (s.length <= n) return s
  return `${s.slice(0, n / 2)}\n…（截断 ${s.length - n} 字节）…\n${s.slice(-n / 2)}`
}

/**
 * 起一个子进程，**完整**带回 stdout/stderr/退出码。
 * 超时/崩溃/截断都不吞：超时单独标 timedOut，退出码照实带。
 *
 * ⚠️ 用 `spawnSync` 而不是 `execFileSync`：`execFileSync` 在**成功**时只返回 stdout，
 * stderr 会整个丢掉 —— 而 `_pack.mjs` 的 `[test-context]` 上报（T02 判据）走的就是 stderr。
 * 收不到 stderr 就等于判据看不见，所以这里必须两条流都收。
 *
 * @param {string[]} argv  [node, ...args] 或 ['node', script, ...]；第一个元素是解释器
 * @param {{cwd?:string, env?:object, timeoutMs?:number, input?:string}} opts
 */
export function runChild(argv, opts = {}) {
  const cmd = argv[0]
  const args = argv.slice(1)
  const started = Date.now()
  const baseOpts = {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  }
  if (opts.input !== undefined) baseOpts.input = opts.input
  const r = spawnSync(cmd, args, baseOpts)
  const ms = Date.now() - started
  const out = String(r.stdout ?? '')
  const errText = String(r.stderr ?? '')
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' || /timed? ?out/i.test(String(r.error?.message ?? ''))
  if (r.error && r.status === null && r.signal == null) {
    // 起不来（ENOENT 之类）：把错误并进 stderr，别让它消失
    return { code: null, out, err: errText + String(r.error.message ?? r.error), ms, timedOut, spawnError: String(r.error.message ?? r.error) }
  }
  const code = typeof r.status === 'number' ? r.status : null
  const note = r.error && code === null ? String(r.error.message ?? r.error) : ''
  return { code, out, err: errText + (note ? '\n' + note : ''), ms, timedOut, spawnError: note || null }
}

/** 建一个只属于本次运行的临时目录（**调用方负责清理前核实路径**）。tag 就是目录名前缀。 */
export function makeTempDir(tag = 'dsh-whale-audit') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
  return dir
}

/**
 * 清理本次夹具。**清理前核实绝对路径确实属于本次夹具**：
 * 必须落在 os.tmpdir() 下、且目录名带本次 tag 前缀 —— 不满足就拒绝删并报出来。
 */
export function cleanupTempDir(dir, tag) {
  const abs = path.resolve(String(dir ?? ''))
  const tmp = path.resolve(os.tmpdir())
  const base = path.basename(abs)
  const inside = abs.startsWith(tmp + path.sep)
  // tag 可以给全名（dsh-whale-xxx）也可以给裸名（xxx），两种都认
  const named = !!tag && (base.startsWith(`${tag}-`) || base.startsWith(`dsh-whale-${tag}-`))
  if (!inside || !named) {
    return { removed: false, error: `拒绝清理：${abs} 不属于本次夹具（需在 ${tmp} 下且名字以 ${tag}- / dsh-whale-${tag}- 开头）` }
  }
  try {
    fs.rmSync(abs, { recursive: true, force: true })
    return { removed: true, error: null }
  } catch (e) {
    return { removed: false, error: `清理失败：${e && e.message ? e.message : String(e)}` }
  }
}

/**
 * 建测试壳。
 * @param {{card:string, evidenceDir?:string, expectedIds?:string[]|null, argv?:string[], root?:string}} opts
 */
export function createHarness(opts = {}) {
  const card = String(opts.card ?? 'T00')
  const evidenceDir = opts.evidenceDir ?? path.join(EVIDENCE_DIR, card)
  const argv = opts.argv ?? process.argv.slice(2)
  const started = Date.now()
  const cases = []
  const index = new Map()
  const notes = []
  let blocked = null
  let resultFile = null
  let wroteEvidence = false

  const h = {
    card,
    evidenceDir,
    argv,
    get cases() { return cases },
    note(msg) { notes.push(String(msg)); return h },

    /** 声明一个用例：id 固定、expected 固定（pass/fail/skip），body 实跑 */
    case(id, expected, body) {
      if (index.has(id)) {
        cases.push({ id: String(id), expected: 'fail', actual: 'fail', note: `用例 id 重复注册：${id}` })
        return h
      }
      const entry = { id: String(id), expected, actual: null, note: '', detail: null }
      index.set(entry.id, entry)
      cases.push(entry)
      if (typeof body === 'function') {
        try {
          const r = body()
          entry.actual = r === 'skip' ? 'skip' : 'pass'
          if (r === 'skip') entry.note = entry.note || '声明为 skip'
        } catch (e) {
          entry.actual = 'fail'
          entry.note = `抛异常：${e && e.message ? e.message : String(e)}`
          entry.detail = clip(e && e.stack ? e.stack : String(e))
        }
      } else {
        entry.actual = 'pass'
      }
      if (entry.actual !== entry.expected) {
        entry.note = `实跑=${entry.actual} 与声明=${entry.expected} 不符${entry.note ? '；' + entry.note : ''}`
      }
      return h
    },

    /** 环境/材料缺失 → BLOCKED（exit 2）。**绝不把缺环境记成 PASS。** */
    block(reason) { blocked = String(reason); return h },

    /** 断言失败（给 case body 用；抛出后由 case() 记 fail） */
    fail(msg) { throw new Error(String(msg)) },

    assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败') },
    eq(actual, expected, msg) {
      if (actual !== expected) throw new Error(`${msg || '不相等'}：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
    },

    /**
     * 落一份证据（原始输出，不裁剪语义）。
     * **带 UTF-8 BOM**：本机 shell 是 Windows PowerShell 5.1，读无 BOM 的文本会按 ANSI/GBK 解码，
     * 中文证据在 `Get-Content` 里会变成乱码 —— 证据是给人看的，编码不能自己先坏掉。
     * 机器要 `JSON.parse` 的那些（`result.json`）走 `evidenceJson`（**不带 BOM**）。
     */
    evidence(name, text, { bom = true } = {}) {
      fs.mkdirSync(evidenceDir, { recursive: true })
      const file = path.join(evidenceDir, name)
      fs.writeFileSync(file, (bom ? '\uFEFF' : '') + String(text), 'utf8')
      wroteEvidence = true
      return file
    },

    /** 落一份 JSON 证据（**不带 BOM**：BOM 会让 JSON.parse 直接抛） */
    evidenceJson(name, obj) {
      return h.evidence(name, JSON.stringify(obj, null, 2), { bom: false })
    },

    /**
     * 判完但**不打印**（给壳自身的负向自检用：那些子壳不许往 stdout 多吐一行）。
     * @returns {{code:number, status:string, head:string, failed:number, passed:number, skipped:number}}
     */
    evaluate() {
      const expectedIds = Array.isArray(opts.expectedIds) ? opts.expectedIds.map(String) : null
      // 自检①：固定用例 ID 集合必须逐条对上（缺/多/重都算失败）
      if (expectedIds) {
        const want = new Set(expectedIds)
        const got = new Map()
        for (const c of cases) got.set(c.id, (got.get(c.id) ?? 0) + 1)
        for (const id of expectedIds) {
          if (!got.has(id)) cases.push({ id, expected: 'pass', actual: 'fail', note: '必需用例缺失（固定 ID 集合里有，实跑里没有）' })
        }
        for (const [id, n] of got) {
          if (!want.has(id)) cases.push({ id, expected: 'fail', actual: 'fail', note: `固定 ID 集合外的用例（集合漂移）：${id}` })
          if (n > 1) cases.push({ id: `${id}#dup`, expected: 'fail', actual: 'fail', note: `用例 ${id} 注册了 ${n} 次` })
        }
      }
      const failed = cases.filter((c) => c.actual !== 'pass').length
      const passed = cases.filter((c) => c.actual === 'pass').length
      const skipped = cases.filter((c) => c.actual === 'skip').length
      const badNotes = cases.filter((c) => c.actual !== 'pass' && c.note).map((c) => `${c.id}: ${c.note}`)
      const status = blocked ? 'BLOCKED' : (failed > 0 ? 'FAIL' : 'PASS')
      const head = blocked
        ? `BLOCKED ${card} ${blocked}`
        : failed > 0
          ? `FAIL ${card} checks=${cases.length} failed=${failed} skipped=${skipped} :: ${badNotes.slice(0, 3).join(' | ')}`
          : `PASS ${card} checks=${cases.length} failed=0 skipped=${skipped}`
      return { code: blocked ? 2 : (failed > 0 ? 1 : 0), status, head, failed, passed, skipped, cases }
    },

    /**
     * 跑完、落证据、按 §4 打印**一行**判词并给出退出码。
     * @returns {number} 0 / 1 / 2
     */
    run() {
      const ev = h.evaluate()
      const { passed, failed, skipped, status, head } = ev
      const badNotes = cases.filter((c) => c.actual !== 'pass' && c.note).map((c) => `${c.id}: ${c.note}`)
      // 机器结果（七项）+ 证据（**一行结论只是索引**）
      try {
        fs.mkdirSync(evidenceDir, { recursive: true })
        const record = {
          passed,
          failed,
          skipped,
          reason: blocked ? `BLOCKED：${blocked}` : (failed > 0 ? badNotes.join('；') : null),
          packRoot: opts.root ?? null,
          base: `node ${path.relative(REPO, path.join(TEST_DIR, 'audit', `${card}.mjs`)).replace(/\\/g, '/')}`,
          cases: cases.map((c) => ({ id: c.id, status: c.actual ?? 'fail', note: c.note || undefined, expected: c.expected })),
          evidence: evidenceDir,
        }
        h.evidenceJson('result.json', record)
        h.evidence('cases.jsonl', cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
        if (notes.length) h.evidence('notes.txt', notes.join('\n') + '\n')
        resultFile = path.join(evidenceDir, 'result.json')
        wroteEvidence = true
      } catch (e) {
        // 证据落不下**不是**可以静默的事：把它算成失败
        process.stderr.write(`证据落盘失败：${e && e.message ? e.message : String(e)}\n`)
        return 1
      }
      process.stdout.write(`${head}\n`)
      return ev.code
    },
  }
  return h
}
