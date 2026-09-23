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
 */

import fs from 'node:fs'
import path from 'node:path'

/** ISO 时间戳样式 → `[…]`（与 brief-io.readLearningRecords 同一条正则、同一口径） */
const STAMP = /\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?/g

/** 台账绝对路径 */
export function adjustmentsPath(root) {
	return path.join(path.resolve(root), 'learning-records', 'adjustments.jsonl')
}

/**
 * 读课后调整台账（append-only，一行一条）。
 *
 * @param {string} root 课程包根
 * @param {{limit?: number, maxChars?: number}} [opts] limit = 最多列最近几条（默认 10）；maxChars = 每条字数上限（默认 160）
 * @returns {{ file: string, entries: {lesson: string, title: string, adjust: string, lit: boolean|null, gaps: string[]}[], total: number, omitted: number, problems: string[] }}
 *   `total` = 台账里能解析的总条数；`omitted` = 因上限没列出来的条数；坏行进 `problems` 不抛、不静默丢（照 readIntake）。
 */
export function readAdjustments(root, { limit = 10, maxChars = 160 } = {}) {
	const file = adjustmentsPath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return { file, entries: [], total: 0, omitted: 0, problems: [] }
	}
	const rows = []
	const problems = []
	const lines = text.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim()
		if (!raw) continue
		try {
			rows.push(JSON.parse(raw))
		} catch (e) {
			problems.push(`第 ${i + 1} 行解析失败：${e.message}`)
		}
	}
	const clip = (s) => {
		const t = String(s ?? '').replace(STAMP, '[…]').replace(/\s+/g, ' ').trim()
		return t.length > maxChars ? t.slice(0, maxChars) + '…' : t
	}
	const entries = rows.slice(-Math.max(1, limit)).map((r) => ({
		lesson: typeof r.lesson === 'string' ? r.lesson : '',
		title: typeof r.title === 'string' ? r.title : '',
		adjust: clip(r.adjust),
		// 老行没写 lit → null（unknown）：不打 ✗，不猜点没点亮
		lit: typeof r.lit === 'boolean' ? r.lit : null,
		gaps: Array.isArray(r.gaps) ? r.gaps.map((g) => clip(g)) : [],
		// `ts` 刻意**不带出去**（G-9：进被对拍产物前裁掉时间字段）
	}))
	return { file, entries, total: rows.length, omitted: Math.max(0, rows.length - entries.length), problems }
}
