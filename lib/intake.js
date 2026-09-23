/**
 * lib/intake.js — 学情摸底（intake）纯函数 / 薄 IO 层
 * ------------------------------------------------------------------
 * 台账：<packRoot>/learning-records/intake.jsonl，append-only，一行一个 JSON 对象。
 * 行形状：{"point":"vue","topic":"...","level":"...","background":"...","goal":"...","time":"...","unknowns":"...",
 *          "prior":"...","can":"...","stuck":"...","start":{…StageSpec…},"answers":[...],"at":"..."}
 * ③(b)：`prior/can/stuck` 是摸底三问的**原文**；`start` = 起点台阶（StageSpec，与 ② 的终点契约
 * **同一个 schema、同一个 validateStage**，见 lib/goal-io.js 的 intakeToStage）—— 四者都缺就不写 `start`。
 * 键序钉死（契约 §4-(b)）：point, topic, level, background, goal, time, unknowns, prior, can, stuck, start, answers, at
 * 老行（只有 point/level/goal）照旧能读能判（B6：绝不判「没摸底」、绝不拦开课）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { prerequisiteGaps } from './pack-model.js'
import { validateStage } from './goal-io.js'

/** 行键序钉死（§4-(b)）；不在表里的键（老调用方的自定义键）原样跟在后面，不静默丢 */
const ENTRY_KEYS = ['point', 'topic', 'level', 'background', 'goal', 'time', 'unknowns', 'prior', 'can', 'stuck', 'start', 'answers', 'at']

/** 台账绝对路径 */
export function intakePath(root) {
	return path.join(path.resolve(root), 'learning-records', 'intake.jsonl')
}

/**
 * 构建学情摸底问题。
 *
 * 前置闸（2026-09-23 用户裁定）：「**开课摸底时，就要知道学生是不是学会了相关的前置内容**，
 * 如果没有，就要建议他去开没学的课而不是继续给他生成课程。」
 * 所以这条问句不是补充说明，而是**第 1 条** —— 前置没确认之前，后面 5 条问了也白问。
 * 传了 `pack`（`readPack()` 的结果）才算得出来；不传就只有原来那 5 条（老调用方不受影响）。
 *
 * @param {{ point: string, topic?: string, pack?: object }} opts
 * @returns {{ topic: string, questions: {id: string, q: string, why: string}[], research: string[], gaps: object|null }}
 */
export function buildQuestions({ point, topic, pack } = {}) {
	const t = topic || point || '未知知识点'
	const gaps = pack && point ? prerequisiteGaps(pack, point) : null
	const questions = []
	if (gaps && gaps.ok === false) {
		const missing = gaps.missing.map((l) => `${l.label}（${l.title}）`)
		questions.push({
			id: 'prereq',
			q: `开「${t}」之前，得先学完前置的 ${gaps.closure.join('、')}。这几门课你学完了吗？`
				+ (missing.length ? `还没学的：${missing.join('、')}。` : '')
				+ `没学完的话，我们先把它们补上，再回来开「${t}」。`,
			why: '前置没学完就开新课 = 在空地基上盖楼（这是硬闸：没补齐时不会给你生成新课）',
		})
	}
	// 5 条固定 id
	questions.push(
		{
			id: 'prior',
			q: `你以前用过或看过和「${t}」相关的东西吗？哪怕是教程、文档、别人的代码都算。`,
			why: '摸清起点，避免从零开始讲你已经会的',
		},
		{
			id: 'can',
			q: `现在如果让你独立写一个跟「${t}」有关的小功能，你能写出来吗？写到哪一步会卡住？`,
			why: '判断当前能力上限，决定从哪一课开始教',
		},
		{
			id: 'stuck',
			q: `在「${t}」的学习或使用中，你卡在哪里过？哪一步最痛？`,
			why: '痛点 = 教学重点，优先解决你真正卡住的地方',
		},
		{
			id: 'goal',
			q: `学完「${t}」之后，你想达到什么水平？比如"能独立写一个小型前端应用"。`,
			why: '目标决定深度——只是"能看懂"和"能独立写"需要的训练量完全不同',
		},
		{
			id: 'time',
			q: `每周大概能花多少时间在「${t}」的学习上？`,
			why: '时间决定节奏——每周 2 小时和每周 10 小时的课程密度不一样',
		},
	)
	const research = [
		`先查官方文档 / 规范 / 源码，逐条把出处落到 RESOURCES.md，禁止凭记忆`,
		`参考 RESOURCES.md 里已有的条目，优先用官方来源而非二手博客`,
	]
	return { topic: t, questions, research, gaps }
}

/**
 * 读取台账。
 * @param {string} root
 * @returns {{ file: string, entries: object[], latest: Record<string, object>, problems: string[] }}
 */
export function readIntake(root) {
	const file = intakePath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return { file, entries: [], latest: {}, problems: [] }
	}
	const entries = []
	const problems = []
	const lines = text.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim()
		if (!raw) continue
		try {
			entries.push(JSON.parse(raw))
		} catch (e) {
			problems.push(`第 ${i + 1} 行解析失败：${e.message}`)
		}
	}
	// latest[point] = 最后一条该 point 的记录
	const latest = {}
	for (const e of entries) {
		if (e.point) latest[e.point] = e
	}
	return { file, entries, latest, problems }
}

/**
 * 查某个知识点的摸底状态。
 *
 * **判据一字不改（B6）**：`done = level && goal`、`missing` 只看 level/goal ——
 * 老记录（只有 `{point,level,goal}`）照样 done=true、绝不拦开课。
 * `start` / `structured` 是 ③(b) 的**只加法**字段：有起点台阶就带出来，没有就 null/false（只提示，不判缺失）。
 *
 * @param {string} root
 * @param {string} point
 * @returns {{ done: boolean, entry: object|null, at: string|null, level: string|null, goal: string|null, missing: string[], start: object|null, structured: boolean }}
 */
export function intakeStatus(root, point) {
	const { latest } = readIntake(root)
	const entry = latest[point] || null
	if (!entry) {
		return { done: false, entry: null, at: null, level: null, goal: null, missing: ['level', 'goal'], start: null, structured: false }
	}
	const missing = []
	if (!entry.level) missing.push('level')
	if (!entry.goal) missing.push('goal')
	// 起点台阶（③(b)）：只加法 —— 不进 missing、不影响 done
	const start = entry.start ?? null
	return {
		done: missing.length === 0,
		entry,
		at: entry.at || null,
		level: entry.level || null,
		goal: entry.goal || null,
		missing,
		start,
		structured: !!(start && start.tier !== null),
	}
}

/**
 * 追加一条摸底记录。
 *
 * 两件 ③(b) 的事（其余与原来完全一致）：
 *   ① `entry.start`（起点台阶）**写前必过 `validateStage()`** —— 与 ② 的终点契约同一套校验，
 *      坏 tier 一律拒写（拒在 append 之前，台账一个字节都不动）；
 *   ② 落盘行按 ENTRY_KEYS 钉死键序（同样输入 → 逐字节相同的行）。
 *
 * @param {string} root
 * @param {object} entry
 * @returns {{ ok: boolean, file: string, entry?: object, error?: string }}
 */
export function recordIntake(root, entry) {
	const file = intakePath(root)
	if (!entry?.point) {
		return { ok: false, file, error: 'point 缺失或为空' }
	}
	// ③(b)：起点台阶用**同一个** validateStage 校验（不许各定一套 schema）；坏样本拒写
	if (entry.start !== undefined && entry.start !== null) {
		try {
			validateStage(entry.start, { record: false, strict: true, where: 'intake.start' })
		} catch (e) {
			return { ok: false, file, error: `起点台阶不合规，拒写：${e.message}` }
		}
	}
	const ordered = {}
	for (const k of ENTRY_KEYS) {
		if (entry[k] !== undefined) ordered[k] = entry[k]
	}
	for (const k of Object.keys(entry)) {
		if (!ENTRY_KEYS.includes(k)) ordered[k] = entry[k]
	}
	// mkdir -p
	fs.mkdirSync(path.dirname(file), { recursive: true })
	// 记录写入前的文件长度（用于回滚）
	let prevLen = 0
	try {
		prevLen = fs.statSync(file).size
	} catch {
		/* 文件不存在 */
	}
	// 追加一行
	const line = JSON.stringify(ordered)
	fs.appendFileSync(file, line + '\n', 'utf8')
	// 回读校验：最后一行能解析且字段一致
	try {
		const text = fs.readFileSync(file, 'utf8')
		const lastLine = text.trim().split('\n').pop()
		const parsed = JSON.parse(lastLine)
		if (parsed.point !== entry.point) {
			throw new Error('point 不一致')
		}
	} catch (e) {
		// 回滚
		try {
			const fd = fs.openSync(file, 'r+')
			fs.ftruncateSync(fd, prevLen)
			fs.closeSync(fd)
		} catch {
			/* 如果 truncate 失败就只能报错 */
		}
		return { ok: false, file, error: `写后回读不一致，已回滚：${e.message}` }
	}
	return { ok: true, file, entry: ordered }
}
