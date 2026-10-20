/**
 * lib/adjust-io.js — 课后调整台账（learning-records/adjustments.jsonl）的**只读端**
 * ------------------------------------------------------------------
 * ③(a)（P0 施工契约 §4-(a)）：课程包侧 `POST /progress` 已经把"标记学完 + 一句课后调整"落进
 * `learning-records/adjustments.jsonl`（写入端 tools/ask-server.js，形状 `{ts, lesson, title, adjust, lit, gaps}`），
 * 但插件侧全库零消费 —— 这份台账对鲸师一直是隐形的（板子「灵感」第一条）。本模块把它读进
 * `whale_brief` 的「课后调整」段（N-22：下节课生成的硬需求输入）。
 *
 * 三条纪律：
 *   ① **文件不存在 / 空文件 = 正常空态**（N-1：本包此刻就没有这个文件）—— 不是错误、不抛、不告警；
 *   ② 进 brief 前**裁掉 `ts`**（G-9：被对拍的产物不许带时间字段），正文里的 ISO 时间戳样式也剥成 `[…]`
 *      （与 lib/brief-io.js 的 readLearningRecords 同一口径，保 test/brief.mjs 的无时间戳硬断言）；
 *   ③ 上限：最近 10 条 × 每条 160 字，超出的显式报「另有 N 条未列」（照 brief.js 学生笔记「不许静默丢」的先例）。
 *
 * 读侧容错（Q6 / B6 同源）：老行只有 `{ts,lesson,title,adjust}` → `lit` 当 `null`（不打 ✗）、`gaps` 当空；
 * **v1 只进上下文，不改 `decideNext` 的决策分支**（Q6 裁定）。
 *
 * U14 起**记录的规范化投影与"台账怎么读"只有一个出处**：`lib/unify/records.cjs`
 * （`normalizeAdjustmentRecord()` / `readRecordLedger()`，五态口径与其它台账同一套）。
 * 本文件保留既有导出面、参数、默认值与返回形状**逐字不变**，但读取故障不再被静默折成空态：
 *   · 文件不存在 → 空态（既有语义，保留）；
 *   · 空文件 → 空态；
 *   · 有坏行 → 合法行照收，坏行进 `problems`（既有行为），另带 U03 的五态口径；
 *   · 读不动（目录 / 权限 / 其它 I/O 故障）→ **进 `problems` 报出来**（旧实现返回"空台账"，
 *     那是把读取故障伪装成"没有台账"，A03 要抓的正是这个）。
 */
import { createRequire } from 'node:module'

const requireCJS = createRequire(import.meta.url)
/** 记录构建内核（U14 唯一实现：调整记录的规范化投影 + 台账五态读取） */
const RECORDS = requireCJS('./unify/records.cjs')

/** 台账绝对路径 */
export function adjustmentsPath(root) {
	return RECORDS.ledgerFile('adjust', root)
}

/**
 * 读课后调整台账（append-only，一行一条）。
 *
 * @param {string} root 课程包根
 * @param {{limit?: number, maxChars?: number}} [opts] limit = 最多列最近几条（默认 10）；maxChars = 每条字数上限（默认 160）
 * @returns {{ file: string, entries: {lesson: string, title: string, adjust: string, lit: boolean|null, gaps: string[]}[], total: number, omitted: number, problems: string[] }}
 *   `total` = 台账里能解析的总条数；`omitted` = 因上限没列出来的条数；坏行/读取故障进 `problems` 不抛、不静默丢。
 */
export function readAdjustments(root, { limit = 10, maxChars = 160 } = {}) {
	const read = RECORDS.readRecordLedger('adjust', root)
	const file = read.file || adjustmentsPath(root)
	if (read.status === 'missing' || read.status === 'empty') {
		return { file, entries: [], total: 0, omitted: 0, problems: [] }
	}
	// 坏行 / 读取故障：问题原样带出（不静默变空台账）；合法行照旧进投影
	// ⚠️ 文案契约保持：brief 侧按「第 N 行解析失败」这句出 ⚠️（test/brief.mjs 钉着），
	//    所以把 U03 五态口径里的坏行文案**适配**回既有措辞（这是适配层的表述，不是第二次计算）。
	const problems = (Array.isArray(read.problems) ? read.problems : []).map((p) =>
		String(p).replace(/^第 (\d+) 行不是 JSON：/, '第 $1 行解析失败：'))
	const rows = Array.isArray(read.entries) ? read.entries : []
	const entries = rows
		.slice(-Math.max(1, limit))
		.map((r) => RECORDS.normalizeAdjustmentRecord(r, { maxChars }))
	return { file, entries, total: rows.length, omitted: Math.max(0, rows.length - entries.length), problems }
}
