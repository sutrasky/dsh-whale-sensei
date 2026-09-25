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
 * `node lib/evidence-io.js --selftest` 在**临时合成的包**上验，不碰真包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

/** 台账路径 */
export function evidencePath(root) {
	return path.join(path.resolve(root), EVIDENCE_REL)
}

/**
 * 读台账。文件不存在 = **正常空态**（不是错误）；坏行进 problems **不抛、不静默丢**。
 * @param {string} root 课程包根
 * @returns {{ file: string, exists: boolean, entries: object[], problems: string[] }}
 */
export function readEvidence(root) {
	const file = evidencePath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		// ⚠️ `exists` 是**判定层要用的开关**（判据 ④：台账不存在时回退到今天的机械对账）——
		//    必须如实反映"文件在不在"，不许拿"entries 是空的"顶替：文件在、但一条没有，
		//    是"学生开过这个口子"，与"从没建过台账"是两回事。
		return { file, exists: false, entries: [], problems: [] }
	}
	const entries = []
	const problems = []
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
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
	return { file, exists: true, entries, problems }
}

/**
 * 追加一条证据（append-only：同一条可以贴多次，判定取**最高档**）。
 *
 * 照 `appendNote` 的规矩：写前算好一行 → 追加 → **re-read 自检** → 不过就按写前快照
 * **逐字节回滚**（不留半行）。一律 UTF-8 **不带 BOM**。
 *
 * 两种失败要分得开（路由层据此回不同的 HTTP 码）：
 *   · `reason: 'rejected'` —— **请求被拒**（lesson 形态 / kind 不认识 / date 形状 / 多余键）→ 400
 *   · `reason: 'io'`       —— 写盘或写后自检失败（已回滚）→ 500（插件侧故障，不是请求的错）
 *
 * @param {string} root
 * @param {{lesson:string, challenge:number, kind:string, date?:string, ref?:string, note?:string}} input
 * @returns {{ok:boolean, file:string, reason?:'rejected'|'io', entry?:object, error?:string}}
 */
export function appendEvidence(root, input = {}) {
	const file = evidencePath(root)
	let entry
	try {
		entry = validateEvidence(input, 'EvidenceRecord')
	} catch (e) {
		return { ok: false, file, reason: 'rejected', error: e.message }
	}

	const abs = path.resolve(root)
	const before = fs.existsSync(file) ? fs.readFileSync(file) : null
	const prev = before ? before.toString('utf8') : ''
	// 结尾没换行的旧文件：先补一个换行，别把两条粘成一行（粘了 = 两条都读不出来）
	const sep = prev && !prev.endsWith('\n') ? '\n' : ''
	const line = JSON.stringify(entry)

	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.appendFileSync(file, sep + line + '\n', 'utf8')
	} catch (e) {
		return { ok: false, file, reason: 'io', error: `写盘失败：${e?.message ?? e}` }
	}

	// 写后回读自检：不过就回滚（含"文件原本不存在"这一种）
	try {
		const back = readEvidence(abs)
		if (back.problems.length) throw new Error(`写后回读有 ${back.problems.length} 条不合规：${back.problems[0]}`)
		const last = back.entries[back.entries.length - 1]
		if (JSON.stringify(last) !== line) throw new Error('写后回读的最后一条与刚写的不一致')
	} catch (e) {
		try {
			if (before) fs.writeFileSync(file, before)
			else fs.rmSync(file, { force: true })
		} catch { /* 回滚自己炸了：下面如实报 */ }
		return { ok: false, file, reason: 'io', error: `写后自检不过，已回滚：${e?.message ?? e}` }
	}

	return { ok: true, file, entry }
}

/* ── 自检（临时合成的包上跑，不碰真包） ─────────────────────────────── */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
	let pass = 0
	const fails = []
	const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-evidence-'))
	try {
		const r0 = readEvidence(tmp)
		ok(r0.exists === false && r0.entries.length === 0 && r0.problems.length === 0, '文件不存在 = 正常空态（exists:false，不抛）')

		const w = appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal', note: '我跑起来了' })
		ok(w.ok === true, `能追加一条（${w.ok ? 'ok' : w.error}）`)
		const r1 = readEvidence(tmp)
		ok(r1.exists === true && r1.entries.length === 1, '读回来 1 条，exists:true')
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

		// 坏行：进 problems、不抛、不丢好行
		const before = fs.readFileSync(evidencePath(tmp), 'utf8')
		fs.appendFileSync(evidencePath(tmp), '这不是JSON{{{\n', 'utf8')
		const r4 = readEvidence(tmp)
		ok(r4.problems.some((p) => /不是 JSON/.test(p)) && r4.entries.length === 3, '坏行进 problems、好行一条不少')
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
