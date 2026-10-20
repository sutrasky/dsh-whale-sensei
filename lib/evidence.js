/**
 * lib/evidence.js —— 证据档位的**纯函数层**（P0-4「证据档位」，2026-09-25）
 * ==================================================================
 * 为什么要有它（`_board/03-鲸师-参考StudyMate改进方案.md:111-120`）：`auto:false`（机器判不了）
 * 的挑战今天只是"不阻塞 + 列出来"，**学生可以用一句「我懂了」糊过去**。借鉴 StudyMate 的
 * `evidence-check`：证据可信度 **运行结果 > 学生自己写的测试 > 解释能力 > 口头确认**，
 * 且「口头确认单独出现不足以判过」。
 *
 * 分层照 `lib/ask.js`（纯）↔ `lib/ask-io.js`（薄 IO）的现成规矩：
 *   · **本文件**：档位词表的**适配层**（导出面与改前逐字相同）。档位校验、"取最高档"、
 *     五态归一、缺证据失败关闭的**唯一实现**在 U18 收口到 `lib/unify/evidence.cjs`；
 *   · `lib/evidence-io.js`：读写台账（`readEvidence` / `appendEvidence`）。
 *
 * ⚠️ **本文件会被 `lib/state.js` import** —— 而 state.js 是**纯层**（"不读 env / 时钟 / 随机数 /
 *    DOM"，只借 fingerprint 的一个字面量常量）。所以这里**一个 fs 调用都不许有**，否则判定层的
 *    纯度就被 IO 传染了。内核是 CJS，按**路径** require（与 `lib/fingerprint.js` 桥内核同一手法）：
 *    ⚠️ 路径**不写字面量的点斜杠相对导入**（那句 `require_('<点>/unify/evidence.cjs')` 的写法）——
 *    `lib/fingerprint.js` 的探针闭包按源码文本扫相对导入，写成字面量会让内核文件凭空进
 *    `PROBE_SOURCES`（那份清单只归 U04/P1，改它等于偷偷改探针版本的口径）。
 *    理由与 `lib/evidence-io.js` 按路径 require 事务件**逐字同源**。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVIDENCE_REL } from './pack-model.js'

export { EVIDENCE_REL }

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const KERNEL_FILE = path.join(HERE, 'unify', 'evidence.cjs')
/** 证据内核（唯一实现；U18 起本文件只是它的适配层） */
const core = require_(KERNEL_FILE)

/**
 * 证据档位，**强 → 弱**（顺序即契约：判据、回执、UI 都按它排）。
 * 每一档都带上人话与"怎么补"——回执要能说清"还差哪一档"。
 */
export const EVIDENCE_KINDS = core.EVIDENCE_KINDS

/** 强度值：run 4 > test 3 > explain 2 > verbal 1（`EVIDENCE_KINDS` 的下标反过来就是它） */
export const EVIDENCE_RANK = core.EVIDENCE_RANK

/** 键序钉死：EvidenceRecord */
export const EVIDENCE_KEYS = core.EVIDENCE_KEYS

/** 每一档的人话（判据与回执共用一份 —— 不许在别处再写一遍这几个词） */
export const EVIDENCE_LABEL = core.EVIDENCE_LABEL

/** 单条证据的正文上限 —— 与笔记台账同阈值同单位（**字节**，中文一字 3 字节） */
export const EVIDENCE_MAX_BYTES = core.EVIDENCE_MAX_BYTES

/** 课次 id 形态：`<知识点>/<NNNN>`（声明形状；规范形状另有其一，见内核） */
export const LESSON_ID_RE = core.LESSON_ID_RE

/** 规范课次 id 形态：`<圆圈>/<知识点>/<NNNN>`（运行态身份） */
export const CANONICAL_LESSON_ID_RE = core.CANONICAL_LESSON_ID_RE

/** 台账五态（`readEvidence().status`）—— 顺序即契约 */
export const LEDGER_STATUSES = core.LEDGER_STATUSES

/**
 * 课次 id 的**跨形状比较**（声明形状 `point/NNNN` ↔ 规范形状 `circle/point/NNNN`）：
 * 点 + 号必须一致；两侧都带圆圈时圆圈也必须一致。见 `authorization.json` 的 C6。
 */
export const sameLesson = core.sameLesson

/**
 * 同一门课**可接受的台账键**（规范形状在前；`bareUnique:false` = 2 段写法有歧义，不收它）。
 */
export const lessonAliases = core.lessonAliases

/**
 * 校验 + 归一化成**键序钉死**的 EvidenceRecord（纯函数；IO 层与读侧共用这一份）。
 * 读侧也用它：不合规的进 problems，**不进 entries**（不静默收脏数据）。
 * @param {object} x
 * @param {string} [where]
 */
export const validateEvidence = core.validateEvidence

/**
 * 某道题**最强的那条证据**（判定层的唯一取法）。
 * @param {object[]} entries `readEvidence().entries`
 * @param {string|string[]} lessons 可接受的台账键（规范形状 + 无歧义时的声明形状）
 * @param {number} challenge
 */
export const bestEvidence = core.bestEvidence

/**
 * 这道题**够不够档**（取最高档，不是"最新一条"）。
 * @param {object[]} entries
 * @param {string|string[]} lessons
 * @param {number} challenge
 * @param {string} min 要求的最低档（`EVIDENCE_KINDS` 之一）
 */
export const meetsEvidence = core.meetsEvidence

/** 回执用的一句话：「这项还差一档证据：贴出你的运行结果」 */
export const evidenceHint = core.evidenceHint

/** "够档的几档"的人话（阻断回执用） */
export const requiredEvidenceText = core.requiredEvidenceText

/** 台账对象 → 五态（`missing` / `empty` / `ok` / `invalid` / `io-error`） */
export const ledgerStatusOf = core.ledgerStatusOf

/** 台账是否**读不出可信证据**（坏账 / 读不动） */
export const isBrokenStatus = core.isBrokenStatus

/** 阻断面的一句话（坏账 / 读不动共用） */
export const brokenWhyText = core.brokenWhyText

/** 单条挑战的证据判定（快照判定与包侧点亮共用这一台） */
export const judgeRequirement = core.judgeRequirement

/** 门禁 / 点亮时的**现读复核**（坏账 / 读不动 / 空账 ⇒ 旧判词作废） */
export const liveLedgerVerdict = core.liveLedgerVerdict
