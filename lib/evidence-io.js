/**
 * lib/evidence-io.js —— 证据台账的**薄 IO 层**（P0-4「证据档位」，2026-09-25）
 * ==================================================================
 * 分层照 `lib/ask.js`（纯）↔ `lib/ask-io.js`（薄 IO）：
 *   · `lib/evidence.js`：档位词表 + 校验 + 取最高档 + 够不够档（**纯，不碰盘**，`state.js` 引它）；
 *   · **本文件**：读写台账 + 写后回读 + 失败逐字节回滚。判定逻辑一个字都不在这儿。
 *
 * 台账 `learning-records/evidence.jsonl`（append-only，一条一行）：
 *   `{ date, lesson, challenge, kind, ref, note }` —— **键序钉死**（`EVIDENCE_KEYS`）。
 *
 * 两条与项目纪律直接相关的决定：
 *   ① **不写 `ts`**。board 的建议字段里写的是 `ts`，但本项目的锁死纪律是「台账绝不写时间字段」
 *      （一有时间就永远不幂等、`--check` 的逐字节对拍当场废）。`date` 走的是**笔记台账那条例外**：
 *      学生侧事实、**只能由调用方显式给** `YYYY-MM-DD`，缺了就报错、**绝不默认「今天」**。
 *   ② **档位取"最高一档"而不是"最新一条"**：同一道题可以先口头、后来补上运行结果 ——
 *      所以台账**不需要顺序**，`date` 只服务于"学生自己看得见"。
 *
 * 2026-10-17（T12 / 报告 C02）：读侧从「读不动就当不存在」改成**五态显式回执**：
 *   `missing`（**只有真 ENOENT**）/ `empty`（存在但零条）/ `ok` / `invalid`（坏行、坏记录）/
 *   `io-error`（EISDIR / EACCES / 其它 IO 故障）。旧字段 `file / exists / entries / problems`
 *   原样保留（`exists` 仍回答"路径上有没有东西"），新增 `status`（判定层的开关）与 `errorCode`。
 *   ⚠️ **只有 `missing` 可以走既有的防死锁回退**（台账真不存在）；空账是"明确不足"、坏账与
 *   读取故障是"读不出可信证据"，三者都不许静默跳过已声明的 `minEvidence`（判定在 `lib/state.js`）。
 *
 * 2026-10-17（T12 / 报告 C01）：写侧接入 T09 的 `ledger-transaction.cjs` —— 跨进程锁、写前字节、
 *   原子落位、提交点与可恢复日志都走**同一个协议**（不另造第二套锁）。append-only 语义不变。
 *
 * `node lib/evidence-io.js --selftest` 在**临时合成的包**上验，不碰真包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
	EVIDENCE_REL, EVIDENCE_KEYS, EVIDENCE_KINDS, EVIDENCE_RANK, EVIDENCE_LABEL,
	EVIDENCE_MAX_BYTES, validateEvidence, bestEvidence, meetsEvidence, evidenceHint,
} from './evidence.js'

// 纯层的东西一律再导出 —— 调用方只认 `evidence-io` 这一个口（路由 / 工具 / 判定层都引它）
export {
	EVIDENCE_REL, EVIDENCE_KEYS, EVIDENCE_KINDS, EVIDENCE_RANK, EVIDENCE_LABEL,
	EVIDENCE_MAX_BYTES, validateEvidence, bestEvidence, meetsEvidence, evidenceHint,
}

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
/**
 * T09 事务件（随包发的那一份）。**按路径 require**（不把相对路径写成字面量 require）：
 * `lib/fingerprint.js` 的探针闭包会把字面量相对导入算进 PROBE_SOURCES；事务件不是探针源，
 * 不该因为"被 IO 层引用"就让探针版本跟着它漂。
 */
const TXN_FILE = path.join(HERE, 'pack-template', 'tools', 'ledger-transaction.cjs')
let txnModule = null
function ledgerTransaction() {
	if (!txnModule) txnModule = require_(TXN_FILE)
	return txnModule
}

/** 台账路径 */
export function evidencePath(root) {
	return path.join(path.resolve(root), EVIDENCE_REL)
}

/** 台账在包内的 POSIX 相对路径（事务协议只认这个写法） */
const EVIDENCE_REL_POSIX = String(EVIDENCE_REL).replace(/\\/g, '/')

/**
 * 解析台账正文 → `{entries, problems}`（**纯**：不碰 fs，读侧与事务内写前校验共用同一份）。
 * 坏行进 problems、好行照收 —— 不吞、不抛。
 */
function parseEvidenceText(text) {
	const entries = []
	const problems = []
	const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const s = lines[i].trim()
		if (!s) continue
		let row
		try {
			row = JSON.parse(s)
		} catch (e) {
			problems.push(`第 ${i + 1} 行不是 JSON：${e?.message ?? e}`)
			continue
		}
		try {
			entries.push(validateEvidence(row, `第 ${i + 1} 行`))
		} catch (e) {
			problems.push(e.message)
		}
	}
	return { entries, problems }
}

/**
 * 读台账。**五态显式**（T12 / C02）：
 *
 *   | status     | 含义                                   | 判定层怎么用               |
 *   |------------|----------------------------------------|----------------------------|
 *   | `missing`  | 真 ENOENT（文件确实不存在）            | **唯一**允许走防死锁回退   |
 *   | `empty`    | 文件存在，但一条有效记录都没有         | 明确不足（不许回退）       |
 *   | `ok`       | 至少一条有效记录、没有 problems        | 正常判                   |
 *   | `invalid`  | 有坏行 / 坏记录（`problems` 非空）     | 读不出可信证据 → 阻断      |
 *   | `io-error` | EISDIR / EACCES / 其它 IO 故障         | 读取故障 → 阻断            |
 *
 * 旧字段保留：`file / exists / entries / problems`；新增 `status` 与 `errorCode`（有错误码时）。
 * `exists` = "路径上有没有东西"（io-error 时为 true：真 ENOENT 才算不存在）。
 *
 * @param {string} root 课程包根
 * @param {{fs?: object}} [opts] `fs` 只给测试做**确定性 IO 注入**（缺省 = node:fs）
 * @returns {{ file: string, exists: boolean, status: 'missing'|'empty'|'ok'|'invalid'|'io-error',
 *   entries: object[], problems: string[], errorCode?: string, error?: string }}
 */
export function readEvidence(root, opts = {}) {
	const file = evidencePath(root)
	const io = opts && opts.fs ? opts.fs : fs
	let text
	try {
		text = io.readFileSync(file, 'utf8')
	} catch (e) {
		const code = String((e && e.code) || 'IO_ERROR')
		// ⚠️ **只有真 ENOENT 才算"不存在"**。EISDIR（路径是目录）/ EACCES（读不动）/
		//    EPERM / ENOTDIR / EMFILE… 一律是**读取故障**，不许伪装成"从没贴过证据"。
		if (code === 'ENOENT') {
			return { file, exists: false, status: 'missing', entries: [], problems: [], errorCode: 'ENOENT' }
		}
		const msg = String((e && e.message) || e)
		return {
			file,
			// 路径上确实有东西（只是读不动 / 是个目录）—— 与 "missing" 分开
			exists: true,
			status: 'io-error',
			entries: [],
			problems: [`证据台账读不动（${code}）：${msg}`],
			errorCode: code,
			error: msg,
		}
	}
	const { entries, problems } = parseEvidenceText(text)
	const base = { file, exists: true, entries, problems }
	// 坏账是 **invalid**（不是"空的"，也不是"不存在"）：好行仍如实带回（不吞），
	// 但判定层读到 problems 就必须 fail-closed —— "有一条好行"不等于"整本账可信"。
	if (problems.length) return { ...base, status: 'invalid' }
	if (!entries.length) return { ...base, status: 'empty' }
	return { ...base, status: 'ok' }
}

/**
 * 追加一条证据（append-only：同一条可以贴多次，判定取**最高档**）。
 *
 * 2026-10-17（T12 / C01）：落盘改走 **T09 事务**（`withPackTransaction`）——
 *   · 跨进程锁：两个进程同时贴证据不会互相覆盖（拿不到锁回 `busy`，不自动强抢）；
 *   · 写前字节由事务在**锁内**收集，落位是原子 rename，提交点之前崩溃只会回到**原状态**；
 *   · 回滚失败如实上报（`recovery-required`），日志与锁保留，下一次普通写被拒 —— 不吞错。
 *
 * 保留旧的两种失败语义（路由层据此回不同的 HTTP 码）：
 *   · `reason: 'rejected'` —— **请求被拒**（lesson 形态 / kind 不认识 / date 形状 / 多余键）→ 400
 *   · `reason: 'io'`       —— 写盘 / 事务失败（已回滚或已如实报 recovery-required）→ 500
 *
 * 坏账 / 读不动的前态检查放在**事务的 build 里**（锁内，`files` 是事务读好的写前字节）：
 * 锁外自己先读一遍会与另一个写者的原子 rename 撞车（Windows 上瞬态 EPERM/EACCES），
 * 把并发写误报成读取故障。坏账时 build 抛错 → 事务 rejected（一个字节都不写）。
 *
 * @param {string} root
 * @param {{lesson:string, challenge:number, kind:string, date?:string, ref?:string, note?:string}} input
 * @param {{fs?:object, timeoutMs?:number, ownerToken?:string}} [opts] 只给测试做确定性注入
 * @returns {{ok:boolean, file:string, reason?:'rejected'|'io', entry?:object, error?:string,
 *   state?:string, txnId?:string, rollbackError?:string|null, retryable?:boolean}}
 */
export function appendEvidence(root, input = {}, opts = {}) {
	const file = evidencePath(root)
	let entry
	try {
		entry = validateEvidence(input, 'EvidenceRecord')
	} catch (e) {
		return { ok: false, file, reason: 'rejected', error: e.message }
	}

	const abs = path.resolve(root)
	const line = JSON.stringify(entry)
	/**
	 * 事务的 build：**写前字节由事务在锁内读好**再喂进来（`files`）。
	 * ⚠️ 坏账 / 读不动的检查必须在这里做，**不能在拿锁之前自己读一遍**：
	 *    锁外读会与另一个写者的原子 rename 撞车（Windows 上瞬间 EPERM/EACCES），
	 *    把并发写误报成"读取故障"。锁内的 `files` 才是可信前态。
	 *    build 被调用两次：第一次 `files={}` 只看形状，第二次才是真前态。
	 */
	const build = ({ files }) => {
		const hasBefore = Boolean(files && Object.prototype.hasOwnProperty.call(files, EVIDENCE_REL_POSIX))
		const prev = hasBefore && files[EVIDENCE_REL_POSIX] != null ? String(files[EVIDENCE_REL_POSIX]) : ''
		if (hasBefore) {
			const parsed = parseEvidenceText(prev)
			if (parsed.problems.length) {
				throw new Error(`台账已有坏记录（${parsed.problems.length} 处：${parsed.problems[0]}）—— 拒绝在坏账上追加；先修好 learning-records/evidence.jsonl 再加`)
			}
		}
		// 结尾没换行的旧文件：先补一个换行，别把两条粘成一行（粘了 = 两条都读不出来）
		const sep = prev && !prev.endsWith('\n') ? '\n' : ''
		return [{ rel: EVIDENCE_REL_POSIX, content: prev + sep + line + '\n' }]
	}

	let r
	try {
		r = ledgerTransaction().withPackTransaction(abs, build, {
			fs: opts.fs,
			timeoutMs: opts.timeoutMs,
			ownerToken: opts.ownerToken,
		})
	} catch (e) {
		return { ok: false, file, reason: 'io', state: 'rejected', error: `事务层不可用：${e?.message ?? e}` }
	}

	if (!r || r.ok !== true) {
		const state = (r && r.state) || 'rejected'
		const rollback = r && r.rollbackError ? `；回滚失败：${r.rollbackError}（日志与锁已保留，先跑离线恢复）` : ''
		return {
			ok: false, file, reason: 'io', state,
			error: `写盘失败（${state}）：${(r && r.error) || '未知错误'}${rollback}`,
			rollbackError: (r && r.rollbackError) || null,
			txnId: r && r.txnId,
			retryable: state === 'busy',
		}
	}

	// 提交点已过：事务保证"目标要么旧要么新的完整字节"，且新内容就是上面算好的 `line`。
	// **不再做锁外回读**：那会与另一个写者的 rename 撞车，把已提交的成功误报成失败。
	return { ok: true, file, entry, state: 'committed', txnId: r.txnId }
}

/* ── 自检（临时合成的包上跑，不碰真包） ─────────────────────────────── */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
	let pass = 0
	const fails = []
	const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-evidence-'))
	try {
		const r0 = readEvidence(tmp)
		ok(r0.exists === false && r0.status === 'missing' && r0.entries.length === 0 && r0.problems.length === 0, '文件不存在 = missing（exists:false，不抛）')

		// 空账：文件存在、零条 —— 是 empty，不是 missing
		fs.mkdirSync(path.dirname(evidencePath(tmp)), { recursive: true })
		fs.writeFileSync(evidencePath(tmp), '', 'utf8')
		const rEmpty = readEvidence(tmp)
		ok(rEmpty.exists === true && rEmpty.status === 'empty' && rEmpty.entries.length === 0, '空文件 = empty（存在但零条）')
		fs.rmSync(evidencePath(tmp), { force: true })

		// IO 故障：路径是目录 → EISDIR 是 io-error，不是 missing
		fs.mkdirSync(evidencePath(tmp), { recursive: true })
		const rDir = readEvidence(tmp)
		ok(rDir.status === 'io-error' && rDir.errorCode === 'EISDIR' && rDir.exists === true, `路径是目录 = io-error（${rDir.errorCode}）`)
		fs.rmSync(evidencePath(tmp), { recursive: true, force: true })

		const w = appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal', note: '我跑起来了' })
		ok(w.ok === true && w.state === 'committed', `能追加一条（${w.ok ? 'committed' : w.error}）`)
		const r1 = readEvidence(tmp)
		ok(r1.exists === true && r1.status === 'ok' && r1.entries.length === 1, '读回来 1 条，status:ok')
		ok(Object.keys(r1.entries[0]).join(',') === EVIDENCE_KEYS.join(','), `键序钉死（${Object.keys(r1.entries[0]).join(',')}）`)
		ok(r1.entries[0].date === null, 'date 缺省 = null（**不默认「今天」**）')
		ok(!/"(ts|at|generatedAt|updatedAt)"\s*:/.test(fs.readFileSync(evidencePath(tmp), 'utf8')), '台账里没有任何时间字段（除显式 date）')

		appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'run', date: '2026-09-25', ref: 'q-0007' })
		const r2 = readEvidence(tmp)
		const m = meetsEvidence(r2.entries, 'spring-boot/0001', 4, 'test')
		ok(m.ok === true && m.have === 'run', '取**最高档**（先口头后运行 ⇒ have=run，不是"最新一条"）')
		ok(meetsEvidence(r2.entries, 'spring-boot/0001', 4, 'run').ok === true, '要 run、有 run → 够')
		ok(meetsEvidence(r2.entries, 'spring-boot/0001', 4, 'test').ok === true, '要 test、有 run → 够（更强的算够）')

		appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 1, kind: 'verbal' })
		const r3 = readEvidence(tmp)
		const m2 = meetsEvidence(r3.entries, 'spring-boot/0001', 1, 'test')
		ok(m2.ok === false && m2.have === 'verbal', '**只有口头确认 → 不够**（判据 ② 的核心）')
		ok(m2.missing.includes('run') && m2.missing.includes('test') && !m2.missing.includes('verbal'),
			`回执里列的是"够档的选项"（${m2.missing.join('/')}）`)
		ok(/还差一档证据/.test(evidenceHint('spring-boot/0001', 1, m2)), '回执那句话成形')

		ok(meetsEvidence(r3.entries, 'spring-boot/0002', 1, 'test').ok === false, '别的课的证据不算数（按 lesson 分组）')
		ok(bestEvidence(r3.entries, 'spring-boot/0001', 99) === null, '没贴过的题 → null（不抛）')

		// 坏形状一律拒
		const cases = [
			['缺 lesson', { challenge: 1, kind: 'run' }],
			['lesson 形态不对', { lesson: 'spring-boot', challenge: 1, kind: 'run' }],
			['challenge 不是正整数', { lesson: 'spring-boot/0001', challenge: 0, kind: 'run' }],
			['kind 不认识', { lesson: 'spring-boot/0001', challenge: 1, kind: 'maybe' }],
			['date 形态不对', { lesson: 'spring-boot/0001', challenge: 1, kind: 'run', date: '今天' }],
			['多余键', { lesson: 'spring-boot/0001', challenge: 1, kind: 'run', ts: '2026-09-25' }],
		]
		let rejected = 0
		for (const [name, input] of cases) {
			const r = appendEvidence(tmp, input)
			if (r.ok === false) rejected++
			else console.log(`FAIL 坏形状 · ${name}：竟然写进去了`)
		}
		ok(rejected === cases.length, `坏形状全部拒写（${rejected}/${cases.length}）`)

		// 坏行：进 problems、不抛、不丢好行；整本账 = invalid（不是 ok、不是 empty）
		const before = fs.readFileSync(evidencePath(tmp), 'utf8')
		fs.appendFileSync(evidencePath(tmp), '这不是JSON{{{\n', 'utf8')
		const r4 = readEvidence(tmp)
		ok(r4.status === 'invalid', `有坏行 = invalid（实得 ${r4.status}）`)
		ok(r4.problems.some((p) => /不是 JSON/.test(p)) && r4.entries.length === 3, '坏行进 problems、好行一条不少')
		const wBad = appendEvidence(tmp, { lesson: 'x/0001', challenge: 2, kind: 'run' })
		ok(wBad.ok === false && wBad.state === 'rejected' && /坏记录/.test(wBad.error), '坏账上拒绝追加（不在坏账上继续写）')
		fs.writeFileSync(evidencePath(tmp), before)

		// 结尾没换行的旧文件：补一条不能把两条粘成一行
		fs.writeFileSync(evidencePath(tmp), JSON.stringify({ date: null, lesson: 'x/0001', challenge: 1, kind: 'run', ref: null, note: null }), 'utf8')
		const w3 = appendEvidence(tmp, { lesson: 'x/0002', challenge: 1, kind: 'test' })
		ok(w3.ok === true && readEvidence(tmp).entries.length === 2, '结尾没换行也不粘行（补一个换行再追加）')

		// 纯层与 IO 层的分工：`lib/evidence.js` 里**一个 fs 都不许有**（判定层引它）
		const pure = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence.js'), 'utf8')
		ok(!/node:fs|require\(|fs\./.test(pure.replace(/\/\*[\s\S]*?\*\//g, '')), 'lib/evidence.js 是**纯层**（不碰 fs —— state.js 引它）')
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
	console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
	if (fails.length) process.exit(1)
}
