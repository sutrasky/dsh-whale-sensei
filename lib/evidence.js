/**
 * lib/evidence.js —— 证据档位的**纯函数层**（P0-4「证据档位」，2026-09-25）
 * ==================================================================
 * 为什么要有它（`_board/03-鲸师-参考StudyMate改进方案.md:111-120`）：`auto:false`（机器判不了）
 * 的挑战今天只是"不阻塞 + 列出来"，**学生可以用一句「我懂了」糊过去**。借鉴 StudyMate 的
 * `evidence-check`：证据可信度 **运行结果 > 学生自己写的测试 > 解释能力 > 口头确认**，
 * 且「口头确认单独出现不足以判过」。
 *
 * 分层照 `lib/ask.js`（纯）↔ `lib/ask-io.js`（薄 IO）的现成规矩：
 *   · **本文件**：档位词表 + 校验 + 取最高档 + 够不够档 + 回执那句话。**不碰盘**。
 *   · `lib/evidence-io.js`：读写台账（`readEvidence` / `appendEvidence`）。
 *
 * ⚠️ **本文件会被 `lib/state.js` import** —— 而 state.js 是**纯层**（"不读 env / 时钟 / 随机数 /
 *    DOM"，只借 fingerprint 的一个字面量常量）。所以这里**一个 fs 都不许有**，否则判定层的
 *    纯度就被 IO 传染了。
 */
import { EVIDENCE_REL } from './pack-model.js'

export { EVIDENCE_REL }

/**
 * 证据档位，**强 → 弱**（顺序即契约：判据、回执、UI 都按它排）。
 * 每一档都带上人话与"怎么补"——回执要能说清"还差哪一档"。
 */
export const EVIDENCE_KINDS = Object.freeze(['run', 'test', 'explain', 'verbal'])

/** 强度值：run 4 > test 3 > explain 2 > verbal 1（`EVIDENCE_KINDS` 的下标反过来就是它） */
export const EVIDENCE_RANK = Object.freeze(
	Object.fromEntries(EVIDENCE_KINDS.map((k, i) => [k, EVIDENCE_KINDS.length - i])),
)

/** 键序钉死：EvidenceRecord */
export const EVIDENCE_KEYS = Object.freeze(['date', 'lesson', 'challenge', 'kind', 'ref', 'note'])

/** 每一档的人话（判据与回执共用一份 —— 不许在别处再写一遍这几个词） */
export const EVIDENCE_LABEL = Object.freeze({
	run: '运行结果（真的跑起来 / 跑过的输出）',
	test: '学生自己写的测试（测试代码与它的输出）',
	explain: '解释能力（把为什么讲清楚）',
	verbal: '口头确认（只说了「我做完了」）',
})

/** 单条证据的正文上限 —— 与笔记台账同阈值同单位（**字节**，中文一字 3 字节） */
export const EVIDENCE_MAX_BYTES = 16 * 1024

/** 课次 id 形态：`<知识点>/<NNNN>`（与课程包的课次 id 同源） */
export const LESSON_ID_RE = /^[A-Za-z0-9._-]+\/\d{4}$/

const bad = (where, msg) => new Error(`证据台账/${where}：${msg}`)

/**
 * 校验 + 归一化成**键序钉死**的 EvidenceRecord（纯函数；IO 层与读侧共用这一份）。
 * 读侧也用它：不合规的进 problems，**不进 entries**（不静默收脏数据）。
 * @param {object} x
 * @param {string} [where]
 */
export function validateEvidence(x, where = 'EvidenceRecord') {
	if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(where, '记录必须是对象')

	const lesson = String(x.lesson ?? '').trim()
	if (!lesson) throw bad(where, '缺 lesson（这条证据是哪门课的）')
	if (!LESSON_ID_RE.test(lesson)) {
		throw bad(where, `lesson 必须是「知识点/NNNN」形态（例 spring-boot/0001），实得 ${JSON.stringify(x.lesson)}`)
	}
	const challenge = Number(x.challenge)
	if (!Number.isSafeInteger(challenge) || challenge <= 0) {
		throw bad(where, `challenge 必须是正整数序号（对应课程里第几道挑战），实得 ${JSON.stringify(x.challenge)}`)
	}
	const kind = String(x.kind ?? '').trim()
	if (!EVIDENCE_KINDS.includes(kind)) {
		throw bad(where, `kind 不认识：${JSON.stringify(x.kind)}（可用：${EVIDENCE_KINDS.join(' / ')}，强→弱）`)
	}
	// `date` 可选，**给了就必须是真日期**，绝不默认"今天"（笔记台账的同一条例外）
	const date = x.date === undefined || x.date === null || x.date === '' ? null : String(x.date).trim()
	if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw bad(where, 'date 给就必须是 YYYY-MM-DD（不许默认「今天」）')
	}
	const ref = x.ref === undefined || x.ref === null || x.ref === '' ? null : String(x.ref).trim()
	const note = x.note === undefined || x.note === null || x.note === '' ? null : String(x.note)
	if (note !== null && Buffer.byteLength(note, 'utf8') > EVIDENCE_MAX_BYTES) {
		throw bad(where, `note 太长（上限 ${EVIDENCE_MAX_BYTES} 字节）`)
	}
	for (const k of Object.keys(x)) {
		if (!EVIDENCE_KEYS.includes(k)) throw bad(where, `多余键 ${JSON.stringify(k)}（schema 里没有这个字段，不静默丢）`)
	}
	return { date, lesson, challenge, kind, ref, note }
}

/**
 * 某道题**最强的那条证据**（判定层的唯一取法）。
 * @param {object[]} entries `readEvidence().entries`
 * @param {string} lesson
 * @param {number} challenge
 * @returns {{kind:string, rank:number, date:string|null, ref:string|null}|null} 没有 = null
 */
export function bestEvidence(entries, lesson, challenge) {
	let best = null
	for (const e of entries || []) {
		if (!e || e.lesson !== lesson || e.challenge !== challenge) continue
		const rank = EVIDENCE_RANK[e.kind] || 0
		if (!best || rank > best.rank) best = { kind: e.kind, rank, date: e.date ?? null, ref: e.ref ?? null }
	}
	return best
}

/**
 * 这道题**够不够档**。
 *
 * ⚠️ 取的是**最高档**，不是"最新一条"：同一道题可以先口头、后来补上运行结果 ——
 *    台账因此**不需要顺序**，`date` 只服务于"学生自己看得见"。
 *
 * @param {object[]} entries
 * @param {string} lesson
 * @param {number} challenge
 * @param {string} min 要求的最低档（`EVIDENCE_KINDS` 之一）
 * @returns {{ ok:boolean, min:string, have:string|null, haveRank:number, needRank:number,
 *   missing:string[], best:object|null }}
 *   `missing` = 比 `min` **更强或相等**的档位（按强→弱排）—— 回执里说"补这几档里任意一档都行"
 */
export function meetsEvidence(entries, lesson, challenge, min) {
	const needRank = EVIDENCE_RANK[min] || 0
	const best = bestEvidence(entries, lesson, challenge)
	const haveRank = best ? best.rank : 0
	return {
		ok: haveRank >= needRank,
		min,
		have: best ? best.kind : null,
		haveRank,
		needRank,
		missing: EVIDENCE_KINDS.filter((k) => EVIDENCE_RANK[k] >= needRank),
		best,
	}
}

/** 回执用的一句话：「这项还差一档证据：贴出你的运行结果」 */
export function evidenceHint(lesson, challenge, m) {
	if (!m) return ''
	const need = EVIDENCE_KINDS.filter((k) => EVIDENCE_RANK[k] >= m.needRank).map((k) => EVIDENCE_LABEL[k])
	const have = m.have ? `现在只有「${EVIDENCE_LABEL[m.have]}」` : '还没有贴过证据'
	return `第${challenge}题还差一档证据（${have}）：补上 ${need.join(' 或 ')} 任意一档 —— 课页那道题的「贴证据」里贴上就行`
}
