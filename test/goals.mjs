/**
 * goals.mjs — 终点契约（learning-records/goals.jsonl）全部判据
 * ------------------------------------------------------------------
 * 施工依据：`E:\workplace\study\_p0-contract.md` §3.1 / §3.2 / §3.4 / §3.6（批 1）。
 * 全部用影副本（mkdtemp），**不碰真包**。
 *
 * 判据：
 *   ① validateStage 合法样本：GoalRecord 顶层与 intake.start **同一函数生效**（§3.6-3 防「各定一套」）
 *   ② 非法样本：tier 越界 / acceptance 形状错 / point 缺失 …… validateStage 抛错；
 *      recordGoal 对坏样本**一律拒写**（拒在 append 之前）且台账逐字节不变（§3.6-1③ badGoal）
 *   ③ 无时间戳：整份 goals.jsonl 正则 /\d{4}-\d{2}-\d{2}T/ **必须不命中**（B2 修正），
 *      且没有任何 at / ts / generatedAt / updatedAt 键
 *   ④ 键序钉死：**逐行**比对键的先后（GoalRecord / artifact / acceptance / checks / from）
 *   ⑤ append-only（B5）：写第 2 版 → 旧行**一个字节都不许动**，新行 v=2、replaces=1
 *   ⑥ 失败回滚：写失败 → 文件**逐字节**回到写之前（recordIntake 同款 ftruncate 回滚）
 *   ⑦ 空态（B6）：文件不存在 → readGoals 返回空、不抛；老 intake 行 → intakeToStage 返回 null
 *   ⑧ 确定性：同样输入（含键序打乱）→ 两份 goals.jsonl **逐字节相同**（同样输入逐字节相同的行）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
	StageSpec, GOAL_SCHEMA, GOAL_KEYS, STAGE_KEYS,
	validateStage, readGoals, recordGoal, intakeToStage, goalsPath,
} from '../lib/goal-io.js'

let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
/** 断言 fn 抛错（照 test/state-probe.mjs badDoc() 骨架） */
const throws = (fn, what) => {
	let e = null
	try { fn() } catch (err) { e = err.message }
	ok(!!e, `${what} → 抛错（${String(e).slice(0, 42)}…）`)
}

console.log('[goals] 终点契约（goals.jsonl）测试')

const KEYSEQ = 'schema,point,pointPath,v,tier,artifact,acceptance,focus,from,source,replaces,reason'
const D = '一句话产出'

// 合法样本：裸 StageSpec（= ③(b) 的 intake.start 形态）
const stageSample = () => ({
	tier: 2,
	artifact: { what: '照着做出 REST 骨架', where: null },
	acceptance: [],
	focus: ['表单校验总卡住'],
})
// 合法样本：GoalRecord（两种 AcceptanceItem 形态各一条）
const recordSample = () => ({
	schema: GOAL_SCHEMA,
	point: 'spring-boot',
	pointPath: 'programming/spring-boot',
	v: 1,
	tier: 3,
	artifact: { what: '一个能独立跑的 REST 待办服务', where: 'code/_hello-spring-boot' },
	acceptance: [
		{ no: 1, deliverable: 'GET /api/tasks 能列出待办', auto: false, hint: '老师确认能说清数据流向' },
		{ no: 2, deliverable: '待办能落库重启不丢', checks: [{ id: 'c1', kind: 'configValue', value: 'server.port=8081' }] },
	],
	focus: null,
	from: { tier: 2, artifact: { what: '照着做出 REST 骨架', where: null }, acceptance: [], focus: ['表单校验总卡住'] },
	source: 'wizard',
	replaces: null,
	reason: null,
})
// recordGoal 入参（v/replaces 由台账算出，不必传）
const makeGoal = (over = {}) => ({
	schema: GOAL_SCHEMA,
	point: 'spring-boot',
	pointPath: 'programming/spring-boot',
	tier: 3,
	artifact: { what: '一个能独立跑的 REST 待办服务', where: 'code/_hello-spring-boot' },
	acceptance: [
		{ no: 1, deliverable: 'GET /api/tasks 能列出待办', auto: false, hint: '老师确认能说清数据流向' },
		{ no: 2, deliverable: '待办能落库重启不丢', checks: [{ id: 'c1', kind: 'configValue', value: 'server.port=8081' }] },
	],
	focus: null,
	source: 'wizard',
	...over,
})

/* ── ⓪ schema 登记处 + 键序常量本身钉死 ─────────────────────── */
ok(StageSpec.schema === 'whale-stage/1' && StageSpec.goalSchema === GOAL_SCHEMA, 'StageSpec 登记两个 schema 标记（whale-stage/1 + whale-goal/1）')
ok(STAGE_KEYS.join(',') === 'tier,artifact,acceptance,focus', `StageSpec 键序钉死（${STAGE_KEYS.join(',')}）`)
ok(GOAL_KEYS.join(',') === KEYSEQ, `GoalRecord 键序钉死（${KEYSEQ}）`)
ok(StageSpec.artifactKeys.join(',') === 'what,where', 'artifact 键序钉死（what,where）')

/* ── ① validateStage 合法样本（同一函数对两种形态生效） ─────── */
const sv1 = validateStage(stageSample())
ok(Object.keys(sv1).join(',') === 'tier,artifact,acceptance,focus', '裸 StageSpec 校验通过，返回键序钉死')
const sv2 = validateStage(recordSample())
ok(Object.keys(sv2).join(',') === KEYSEQ, 'GoalRecord 校验通过，返回键序钉死')
ok(Object.keys(sv2.artifact).join(',') === 'what,where', 'artifact 键序钉死')
ok(Object.keys(sv2.acceptance[0]).join(',') === 'no,deliverable,auto,hint', 'auto:false 形态键序钉死（no,deliverable,auto,hint）')
ok(Object.keys(sv2.acceptance[1]).join(',') === 'no,deliverable,checks', 'checks 形态键序钉死（no,deliverable,checks；hint 未给不出现）')
ok(Object.keys(sv2.acceptance[1].checks[0]).join(',') === 'id,kind,value', 'check 项键序钉死（id,kind,value）')
ok(Object.keys(sv2.from).join(',') === 'tier,artifact,acceptance,focus', 'from（起点台阶 StageSpec）键序钉死')
ok(!!validateStage(recordSample()) && !!validateStage(stageSample()), '同一个 validateStage() 对 GoalRecord 顶层与 intake.start 同样生效（防「各定一套」）')
// 防「各定一套」：同一个坏 tier 在两种形态下都必须被拒
throws(() => validateStage({ ...stageSample(), tier: 9 }), '坏 tier 在裸 StageSpec 上被拒')
throws(() => validateStage({ ...recordSample(), tier: 9 }), '坏 tier 在 GoalRecord 上也被拒（同一套校验）')

/* ── ② validateStage 非法样本：tier 越界 ───────────────────── */
throws(() => validateStage({ ...stageSample(), tier: 0 }), 'tier=0 越界')
throws(() => validateStage({ ...stageSample(), tier: 5 }), 'tier=5 越界')
throws(() => validateStage({ ...stageSample(), tier: '三' }, { record: false }), 'tier="三" 非整数')
throws(() => validateStage({ ...stageSample(), tier: 2.5 }), 'tier=2.5 非整数')

/* ── ②b 非法样本：acceptance 形状错 ────────────────────────── */
throws(() => validateStage({ ...stageSample(), acceptance: 'x' }), 'acceptance 非数组')
throws(() => validateStage({ ...stageSample(), acceptance: ['x'] }), 'acceptance 项非对象')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, auto: false, hint: 'x' }] }), 'acceptance 项缺 deliverable')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: '   ', checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }] }), 'deliverable 是空白串')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, checks: [] }] }), 'checks 是空数组')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, auto: false }] }), 'auto:false 却没给 hint')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, auto: false, hint: 'x', checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }] }), 'auto:false 又带 checks（两种形态必须二选一）')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }, { no: 1, deliverable: D, checks: [{ id: 'd', kind: 'annotation', value: 'A' }] }] }), 'acceptance 序号 no 重复')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 0, deliverable: D, checks: [{ id: 'c', kind: 'annotation', value: 'A' }] }] }), 'no=0 非法')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, checks: [{ id: 'c', kind: '魔法', value: 'v' }] }] }), 'check kind 不认识')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, checks: [{ kind: 'annotation', value: 'A' }] }] }), 'check 项缺 id')
throws(() => validateStage({ ...stageSample(), acceptance: [{ no: 1, deliverable: D, checks: [{ id: 'c', kind: 'annotation' }] }] }), 'check 项缺 value')
throws(() => validateStage({ ...stageSample(), focus: [''] }), 'focus 有空串')

/* ── ②c 非法样本：GoalRecord 身份字段（point 缺失等） ───────── */
const noPoint = () => { const r = recordSample(); delete r.point; return r }
throws(() => validateStage(noPoint()), 'point 缺失（GoalRecord 必填）')
throws(() => validateStage({ ...recordSample(), point: '  ' }), 'point 空白串')
throws(() => validateStage({ ...recordSample(), v: undefined }), 'v 缺失')
throws(() => validateStage({ ...recordSample(), v: 0 }), 'v=0 非法')
throws(() => validateStage({ ...recordSample(), source: undefined }), 'source 缺失')
throws(() => validateStage({ ...recordSample(), source: '邻居' }), 'source 不在 wizard/agent/manual')
throws(() => validateStage({ ...recordSample(), tier: null }), 'GoalRecord 不许 tier=null（未结构化只属于 StageSpec）')
throws(() => validateStage({ ...recordSample(), acceptance: [] }), 'acceptance=[]（终点至少一条验收判据）')
throws(() => validateStage({ ...recordSample(), artifact: { where: null } }), 'artifact.what 缺失')
throws(() => validateStage({ ...recordSample(), artifact: { what: '  ', where: null } }), 'artifact.what 空白串')
throws(() => validateStage({ ...recordSample(), extra: 1 }), '多余键（写侧严格，不静默丢）')
throws(() => validateStage({ ...recordSample(), schema: 'whale-goal/9' }), 'schema 不认识')

/* ── ③④⑤ 正常写入：键序 / 无时间戳 / append-only ───────────── */
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const fileA = goalsPath(tmpA)
const form2 = makeGoal({
	artifact: { what: '一个能部署上线的 REST 待办服务', where: 'code/_hello-spring-boot' },
	reason: '想改成能部署上线',
})
const w1 = recordGoal(tmpA, makeGoal())
ok(w1.ok === true, 'recordGoal 首版写成功')
ok(w1.record.v === 1 && w1.record.replaces === null, '首版 v=1、replaces=null（B5 留痕）')
ok(w1.record.from === null, '该 point 没有 intake.start → from=null（没有就 null）')
const textBefore = fs.readFileSync(fileA, 'utf8')

const w2 = recordGoal(tmpA, form2)
ok(w2.ok === true, 'recordGoal 第 2 版写成功（换终点 = 追加，不覆盖）')
ok(w2.record.v === 2 && w2.record.replaces === 1, '第 2 版 v=2、replaces=1（指向第 1 版）')
const textAfter = fs.readFileSync(fileA, 'utf8')
ok(textAfter.startsWith(textBefore), '旧行一个字节都不许动（写入前缀逐字节保留）')
ok(textAfter.split('\n')[0] === textBefore.trim(), '第 1 行内容一字未变')
const rg = readGoals(tmpA)
ok(rg.entries.length === 2 && rg.problems.length === 0, 'readGoals 读到 2 条、零 problems')
ok(rg.latest['spring-boot']?.v === 2, '同 point 最后一行 = 现行终点（B5 读法）')
ok(rg.latest['spring-boot']?.artifact?.what === '一个能部署上线的 REST 待办服务', '现行终点是第 2 版的内容')

// ③ 无时间戳：整份文件跑正则，必须不命中（B2 修正，硬指标）
ok(!/\d{4}-\d{2}-\d{2}T/.test(textAfter), '整份 goals.jsonl 不命中 /\\d{4}-\\d{2}-\\d{2}T/（无时间戳）')
const FORBIDDEN_TS_KEYS = ['at', 'ts', 'generatedAt', 'updatedAt']
const hasTsKey = (o) => {
	if (!o || typeof o !== 'object') return false
	return Object.keys(o).some((k) => FORBIDDEN_TS_KEYS.includes(k) || hasTsKey(o[k]))
}
ok(!hasTsKey(JSON.parse(textAfter.split('\n')[0])) && !hasTsKey(JSON.parse(textAfter.split('\n')[1])),
	'两行都没有 at / ts / generatedAt / updatedAt 键（含嵌套）')

// ④ 键序钉死：逐行比对键的先后
const linesA = textAfter.split('\n').filter((l) => l.trim())
ok(linesA.length === 2, `台账 2 行（${linesA.length}）`)
let keyOrderOk = true
for (const l of linesA) {
	const row = JSON.parse(l)
	if (Object.keys(row).join(',') !== KEYSEQ) keyOrderOk = false
	if (Object.keys(row.artifact).join(',') !== 'what,where') keyOrderOk = false
}
ok(keyOrderOk, `逐行键序都恰为 ${KEYSEQ}（artifact=what,where）`)

/* ── ⑧ 确定性：同样输入（键序打乱）→ 逐字节相同 ─────────────── */
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const shuffledV1 = {
	source: 'wizard', focus: null,
	acceptance: [
		{ hint: '老师确认能说清数据流向', auto: false, deliverable: 'GET /api/tasks 能列出待办', no: 1 },
		{ checks: [{ value: 'server.port=8081', kind: 'configValue', id: 'c1' }], deliverable: '待办能落库重启不丢', no: 2 },
	],
	artifact: { where: 'code/_hello-spring-boot', what: '一个能独立跑的 REST 待办服务' },
	tier: 3, pointPath: 'programming/spring-boot', point: 'spring-boot', schema: GOAL_SCHEMA,
}
const shuffledV2 = {
	reason: '想改成能部署上线', schema: GOAL_SCHEMA, point: 'spring-boot',
	tier: 3, source: 'wizard',
	artifact: { where: 'code/_hello-spring-boot', what: '一个能部署上线的 REST 待办服务' },
	acceptance: [
		{ no: 1, deliverable: 'GET /api/tasks 能列出待办', hint: '老师确认能说清数据流向', auto: false },
		{ no: 2, checks: [{ id: 'c1', value: 'server.port=8081', kind: 'configValue' }], deliverable: '待办能落库重启不丢' },
	],
	focus: null, pointPath: 'programming/spring-boot',
}
const wb1 = recordGoal(tmpB, shuffledV1)
const wb2 = recordGoal(tmpB, shuffledV2)
ok(wb1.ok === true && wb2.ok === true, '键序打乱的同值输入也能写')
ok(fs.readFileSync(goalsPath(tmpB), 'utf8') === textAfter,
	'同样输入（含键序不同）→ 两份 goals.jsonl 逐字节相同（键序钉死 + 无时间戳的合力）')
ok(!/\d{4}-\d{2}-\d{2}T/.test(fs.readFileSync(goalsPath(tmpB), 'utf8')), '副本同样不命中时间戳正则')

/* ── ⑥ 失败回滚：写失败 → 逐字节回到写之前 ─────────────────── */
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const fileC = goalsPath(tmpC)
fs.mkdirSync(path.dirname(fileC), { recursive: true })
// 最后一行没有换行 → append 后回读的「最后一行」解析必然失败 → 触发回读校验回滚
fs.writeFileSync(fileC, '<<<broken', 'utf8')
const beforeC = fs.readFileSync(fileC)
const wC = recordGoal(tmpC, makeGoal())
ok(wC.ok === false && /回滚/.test(String(wC.error)), `写后回读不一致 → 拒收并回滚（${String(wC.error).slice(0, 42)}…）`)
const afterC = fs.readFileSync(fileC)
ok(Buffer.compare(beforeC, afterC) === 0, '失败后文件逐字节回到写之前（ftruncate 回滚，判据照 recordIntake）')

/* ── ②d badGoal：recordGoal 对坏样本一律拒写，台账逐字节不变 ── */
const tmpG = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const fileG = goalsPath(tmpG)
ok(recordGoal(tmpG, makeGoal()).ok === true, '先写一条好的当底子')
const textG = fs.readFileSync(fileG, 'utf8')
const badGoal = (over, what) => {
	const r = recordGoal(tmpG, makeGoal(over))
	ok(r.ok === false && !!r.error, `${what} → 拒写（${String(r.error).slice(0, 42)}…）`)
	ok(fs.readFileSync(fileG, 'utf8') === textG, `${what} → 台账逐字节不变（拒在 append 之前）`)
}
badGoal({ tier: 0 }, 'tier=0')
badGoal({ tier: 5 }, 'tier=5')
badGoal({ tier: '三' }, 'tier="三"')
badGoal({ acceptance: [] }, 'acceptance=[]')
badGoal({ acceptance: [{ no: 1, deliverable: D, checks: [] }] }, 'checks=[]')
badGoal({ acceptance: [{ no: 1, deliverable: D, auto: false }] }, 'auto:false 缺 hint')
badGoal({ acceptance: [{ no: 1, deliverable: D, auto: false, hint: 'x' }, { no: 1, deliverable: D, auto: false, hint: 'y' }] }, 'no 重复')
badGoal({ point: undefined }, 'point 缺失')
badGoal({ source: '邻居' }, 'source 非法')
badGoal({ v: 99 }, '显式 v 与台账不符（不静默覆盖）')
badGoal({ extra: 1 }, '多余键')

/* ── ⑦ 空态 + B6 兼容 + intakeToStage（同一 schema） ───────── */
const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const empty = readGoals(tmpD)
ok(empty.entries.length === 0 && Object.keys(empty.latest).length === 0 && empty.problems.length === 0,
	'文件不存在 = 正常空态：readGoals 返回空、不抛')

ok(intakeToStage({ point: 'vue', level: '零基础', goal: '能独立写前端' }) === null,
	'老 intake 行（只有 point/level/goal）→ 返回 null，不写 start（B6 回落）')
const st1 = intakeToStage({ level: '零基础', can: '能照着写 CRUD', stuck: '表单校验总卡住', startTier: 2 })
ok(!!st1 && st1.tier === 2, 'intakeToStage：startTier=2 → tier 2')
ok(st1.artifact.what === '能照着写 CRUD' && st1.artifact.where === null, 'artifact.what = can（原文）；where 未填 = null')
ok(Array.isArray(st1.acceptance) && st1.acceptance.length === 0, '起点台阶 acceptance = []（起点没有验收判据）')
ok(st1.focus.join(',') === '表单校验总卡住', 'focus 装 stuck（§3.1：起点装 stuck）')
ok(Object.keys(st1).join(',') === 'tier,artifact,acceptance,focus', 'intakeToStage 返回键序钉死的 StageSpec')
ok(!!validateStage(st1), 'validateStage 对 intake.start 生效（②③b 共用同一 schema 与校验）')
const st2 = intakeToStage({ prior: '看过教程', startTier: null })
ok(st2.tier === null && st2.artifact.what === '看过教程', '没有 can → what 回落 prior；没给 startTier → tier=null（未结构化）')
const st3 = intakeToStage({ level: '零基础', startTier: 1 })
ok(st3.artifact.what === '零基础', '没有 can/prior → what 回落 level')
throws(() => intakeToStage({ startTier: '三' }), 'startTier="三" → 坏 tier 拒写')
throws(() => intakeToStage({ startTier: 5 }), 'startTier=5 → 坏 tier 拒写')
throws(() => intakeToStage({ startTier: 0 }), 'startTier=0 → 坏 tier 拒写')

/* ── from 留痕：定终点时把起点台阶拷进去（§4-(b)） ─────────── */
const tmpE = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const intakeE = path.join(tmpE, 'learning-records', 'intake.jsonl')
fs.mkdirSync(path.dirname(intakeE), { recursive: true })
fs.writeFileSync(intakeE, JSON.stringify({
	point: 'spring-boot', level: '零基础', goal: '能独立做',
	start: { tier: 2, artifact: { what: '能照着写 CRUD', where: null }, acceptance: [], focus: ['表单校验卡住'] },
	at: '2026-09-24',
}) + '\n', 'utf8')
const wE = recordGoal(tmpE, makeGoal())
ok(wE.ok === true && wE.record.from?.tier === 2, 'from 自动拷贝该 point 最新 intake 的 start')
ok(wE.record.from?.artifact?.what === '能照着写 CRUD' && wE.record.from?.focus?.[0] === '表单校验卡住', 'from 内容与 intake.start 一致（留痕）')
const tmpE2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const wE2 = recordGoal(tmpE2, makeGoal({ from: { tier: 1, artifact: { what: '认得出 @RestController', where: null }, acceptance: [], focus: null } }))
ok(wE2.ok === true && wE2.record.from?.tier === 1, '显式传 from 时以显式为准')

/* ── 读侧容错：坏行进 problems 不崩、不静默丢（§3.4-4） ─────── */
const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-goals-'))
const fileF = goalsPath(tmpF)
fs.mkdirSync(path.dirname(fileF), { recursive: true })
fs.writeFileSync(fileF,
	JSON.stringify(recordSample()) + '\n'
	+ '这不是合法的JSON{{{]\n'
	+ JSON.stringify({ ...recordSample(), point: 'react', pointPath: null, tier: 999 }) + '\n', 'utf8')
const rf = readGoals(tmpF)
ok(rf.entries.length === 2, '2 条可解析的行都读出来（坏 JSON 行照 readIntake 先例只进 problems）')
ok(rf.problems.length === 2, `坏行进 problems（${rf.problems.length} 条）`)
ok(rf.problems[0].includes('第 2 行') && rf.problems[0].includes('解析失败'), '坏 JSON 报行号（照 readIntake 形态）')
ok(rf.problems[1].includes('第 3 行') && rf.problems[1].includes('tier'), '值不合规报行号 + 字段（读侧容错、写侧严格）')
ok(rf.latest['spring-boot']?.v === 1, '好行照常成为现行终点')
ok(rf.latest.react?.tier === 999, '坏值行原文保留（不静默丢，只是记 problems）')

// 清理
for (const d of [tmpA, tmpB, tmpC, tmpD, tmpE, tmpE2, tmpF, tmpG]) {
	fs.rmSync(d, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 终点契约：schema 校验、键序钉死、无时间戳、append-only 留痕、失败回滚、空态回落全部通过')
