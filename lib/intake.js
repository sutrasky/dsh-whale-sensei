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
 *
 * **知识点 id 有统一解析（Bug5）**：台账的 `point` 既可能是裸 id（`js-basics`），也可能是 catalog
 * 给的复合 id（`programming/js-basics`）。读的一方一律走 `lib/point-ref.js` 的 `resolvePointRef()`
 * 把两者解成同一个规范 key 再比对（`latestIntakeFor` / `intakeStatus`）—— **一份规则，别处不另写**。
 * 写的一方**不改写历史**：`recordIntake` 照收照存（append-only），只读查询前后台账逐字节相同。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { prerequisiteGaps, readPack } from './pack-model.js'
import { validateStage } from './goal-io.js'
import { resolvePointRef } from './point-ref.js'

/** 包级事务件（T09）：摸底台账的追加 + 回读自检在包锁内完成（T10 / C01） */
const requireCJS = createRequire(import.meta.url)
const PACK_TXN = requireCJS('./pack-template/tools/ledger-transaction.cjs')
/** 台账在包内的相对路径（事务写集只认包内相对路径） */
const INTAKE_REL = 'learning-records/intake.jsonl'

/** 行键序钉死（§4-(b)）；不在表里的键（老调用方的自定义键）原样跟在后面，不静默丢 */
const ENTRY_KEYS = ['point', 'topic', 'level', 'background', 'goal', 'time', 'unknowns', 'prior', 'can', 'stuck', 'start', 'answers', 'at']

/** 台账绝对路径 */
export function intakePath(root) {
	return path.join(path.resolve(root), 'learning-records', 'intake.jsonl')
}

/** 事务选项：只把调用方**显式**给的件传下去（生产不传；T10 测试用它注入故障 fs） */
function txnOpts(txn) {
	if (!txn || typeof txn !== 'object') return undefined
	const o = {}
	if (txn.fs) o.fs = txn.fs
	if (txn.ownerToken !== undefined) o.ownerToken = String(txn.ownerToken)
	if (txn.timeoutMs !== undefined) o.timeoutMs = txn.timeoutMs
	return o
}

/** 事务失败的**原回执形状** + 明确 state / rollbackError（不把失败回滚写成成功） */
function txnFailure(file, action, r) {
	const state = r && r.state ? r.state : 'rejected'
	return {
		ok: false,
		file,
		error: `${action}失败（事务 ${state}）：${r && r.error ? r.error : '未知错误'}`,
		state,
		txnId: r && r.txnId ? r.txnId : null,
		rollbackError: r && r.rollbackError ? r.rollbackError : null,
	}
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
 * 读台账。
 *
 * @param {string} root
 * @param {{pack?: object|null}} [opts]
 *   `pack` = `readPack(root)` 的结果（可选）。给了就多算一份**规范 id 视图** `byKey`：
 *   台账里的复合 id（`programming/js-basics`）与裸 id（`js-basics`）落在**同一个键**上 ——
 *   这正是"复合/裸混用不丢记录"的落点（见 Bug5）。
 *   **不给也不影响 `latest`**（老调用方 brief-io / goal-io / adjust-io 的形状一字未改）。
 * @returns {{ file: string, entries: object[], latest: Record<string, object>, problems: string[], byKey: Record<string, object> }}
 *   `latest` = **按原始 `point` 键**给最后一条（对外形状，别动）；
 *   `byKey`  = 按**规范 id**（圆圈/知识点）给最后一条；解析不动的行退回原键（一条都不丢）。
 */
export function readIntake(root, opts = {}) {
	const file = intakePath(root)
	let text
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch {
		return { file, entries: [], latest: {}, problems: [], byKey: {} }
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
	// latest[point] = 最后一条该 point 的记录（**原始键**：老调用方的判据面，不改）
	const latest = {}
	for (const e of entries) {
		if (e.point) latest[e.point] = e
	}
	// byKey = 按规范 id 的最后一条（复合 / 裸混用落在同一个键上）
	const pack = opts && opts.pack ? opts.pack : null
	const byKey = {}
	for (const e of entries) {
		if (!e || !e.point) continue
		const r = resolvePointRef({ pack, ref: e.point })
		const key = r.ok ? r.key : String(e.point)
		byKey[key] = e
	}
	return { file, entries, latest, problems, byKey }
}

/**
 * 「按 ref 查最新一条摸底记录」—— 复合 id 与裸 id 都认（Bug5 的正解）。
 *
 * 匹配规则**只有一条**：把 `ref` 解析成规范 key（`resolvePointRef`），
 * 再在 `byKey` 里取最后一条落在这个 key 上的记录。于是：
 *   · 台账里存 `programming/js-basics`、查 `js-basics` → 命中（反之亦然）；
 *   · `a/x` 与 `b/x` 各是各的 key → **绝不串**；
 *   · 裸 id 在两个圆圈里都有 → 解析就拒了（`resolved.ok === false`），`entry` 给 null（不猜）。
 *
 * @param {string} root
 * @param {string} ref 裸 id 或复合 id
 * @param {{pack?: object|null, halo?: string|null}} [opts]
 * @returns {{ resolved: object, entry: object|null, data: object }}
 *   `resolved` = `resolvePointRef` 的原始回执（ok / code / candidates 都在，给拒绝理由用）；
 *   `data` = `readIntake` 的完整回执（entries / latest / byKey / problems）。
 */
export function latestIntakeFor(root, ref, opts = {}) {
	const pack = opts.pack ? opts.pack : tryReadPack(root)
	const resolved = resolvePointRef({ pack, ref, halo: opts.halo })
	const data = readIntake(root, { pack })
	const entry = resolved.ok ? (data.byKey[resolved.key] || null) : null
	return { resolved, entry, data }
}

/**
 * 尽力读包：读不动（坏配置 / 没权限）或没有 `lessons/` 一律当"没有目录可对照"。
 * **不猜、不抛**：摸底台账的读取不能因为课程包读不动就整个炸掉（老包 / 新建包照旧能摸底）。
 */
function tryReadPack(root) {
	if (!root) return null
	try {
		const pack = readPack(root)
		return pack && Array.isArray(pack.points) && pack.points.length ? pack : null
	} catch {
		return null
	}
}

/**
 * 查某个知识点的摸底状态。
 *
 * **判据一字不改（B6）**：`done = level && goal`、`missing` 只看 level/goal ——
 * 老记录（只有 `{point,level,goal}`）照样 done=true、绝不拦开课。
 * `start` / `structured` 是 ③(b) 的**只加法**字段：有起点台阶就带出来，没有就 null/false（只提示，不判缺失）。
 *
 * **id 解析（Bug5）**：`point` 既可以是裸 id（`js-basics`），也可以是 catalog 给的复合 id
 * （`programming/js-basics`）—— 两者解析到同一个规范 key 后取**同一条**记录。
 * 解析不动（未知 / 歧义 / 点圈对不上）时 `done=false, entry=null, ref=<拒绝回执>`，
 * 拒绝理由里带候选 / 合法 id（**不猜、也不冒充"没摸底"**）。
 *
 * @param {string} root
 * @param {string} point 裸 id 或复合 id（`circle/point`）
 * @param {{pack?: object|null, halo?: string|null}} [opts]
 *   `pack` 给了就用它核验（省一次 readPack）；`halo` 给了就只在那个圆圈里找。
 * @returns {{ done: boolean, entry: object|null, at: string|null, level: string|null, goal: string|null,
 *             missing: string[], start: object|null, structured: boolean,
 *             ref: object, key: string|null }}
 *   `ref` / `key` 是**只加法**字段（解析结果与规范 id）：老调用方只读 done / missing / entry 等，不受影响。
 */
export function intakeStatus(root, point, opts = {}) {
	const { resolved, entry } = latestIntakeFor(root, point, opts || {})
	const ref = resolved
	const key = resolved && resolved.ok ? resolved.key : null
	if (!entry) {
		return {
			done: false, entry: null, at: null, level: null, goal: null,
			missing: ['level', 'goal'], start: null, structured: false, ref, key,
		}
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
		ref,
		key,
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
 * @param {{fs?:object, ownerToken?:string, timeoutMs?:number}} [txn] 仅供测试注入事务件（生产不传）
 * @returns {{ ok: boolean, file: string, entry?: object, error?: string, state?: string }}
 */
export function recordIntake(root, entry, txn) {
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
	// 追加 + 回读自检在**同一个包事务**内完成：失败 ⇒ 台账逐字节回到写前
	let buildError = null
	let result
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		result = PACK_TXN.withPackTransaction(path.resolve(root), ({ files }) => {
			try {
				if (!Object.prototype.hasOwnProperty.call(files, INTAKE_REL)) {
					return [{ rel: INTAKE_REL, content: '' }]
				}
				const beforeText = files[INTAKE_REL] == null ? '' : String(files[INTAKE_REL])
				const line = JSON.stringify(ordered)
				// 已有记录前缀字节**原样保留**（只追加）
				const body = beforeText + line + '\n'
				// 回读校验：最后一行能解析且 point 一致
				try {
					const lastLine = body.trim().split('\n').pop()
					const parsed = JSON.parse(lastLine)
					if (parsed.point !== entry.point) throw new Error('point 不一致')
				} catch (e) {
					const err = new Error(`写后回读不一致，已回滚：${e && e.message ? e.message : String(e)}`)
					err.selfCheckFailure = true
					throw err
				}
				return [{ rel: INTAKE_REL, content: body }]
			} catch (e) {
				buildError = e
				throw e
			}
		}, txnOpts(txn))
	} catch (e) {
		return txnFailure(file, '摸底写入', { ok: false, state: 'rejected', error: e && e.message ? e.message : String(e) })
	}

	if (result.ok) return { ok: true, file, entry: ordered }

	// 事务没提交：把原错误形状带回来，并明确 state（自检失败时一个字节都没落盘）
	if (buildError) {
		return {
			ok: false,
			file,
			error: buildError.message,
			state: result.state,
			txnId: result.txnId || null,
			rollbackError: null,
		}
	}
	return txnFailure(file, '摸底写入', result)
}
