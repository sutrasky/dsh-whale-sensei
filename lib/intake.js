/**
 * lib/intake.js — 学情摸底（intake）纯函数 / 薄 IO 层
 * ------------------------------------------------------------------
 * 台账：<packRoot>/learning-records/intake.jsonl，append-only，一行一个 JSON 对象。
 * 行形状：{"point":"vue","topic":"...","level":"...","background":"...","goal":"...","time":"...","unknowns":"...","answers":[...],"at":"..."}
 */

import fs from 'node:fs'
import path from 'node:path'
import { prerequisiteGaps } from './pack-model.js'

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
 * @param {string} root
 * @param {string} point
 * @returns {{ done: boolean, entry: object|null, at: string|null, level: string|null, goal: string|null, missing: string[] }}
 */
export function intakeStatus(root, point) {
	const { latest } = readIntake(root)
	const entry = latest[point] || null
	if (!entry) {
		return { done: false, entry: null, at: null, level: null, goal: null, missing: ['level', 'goal'] }
	}
	const missing = []
	if (!entry.level) missing.push('level')
	if (!entry.goal) missing.push('goal')
	return {
		done: missing.length === 0,
		entry,
		at: entry.at || null,
		level: entry.level || null,
		goal: entry.goal || null,
		missing,
	}
}

/**
 * 追加一条摸底记录。
 * @param {string} root
 * @param {object} entry
 * @returns {{ ok: boolean, file: string, entry?: object, error?: string }}
 */
export function recordIntake(root, entry) {
	const file = intakePath(root)
	if (!entry?.point) {
		return { ok: false, file, error: 'point 缺失或为空' }
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
	const line = JSON.stringify(entry)
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
	return { ok: true, file, entry }
}
