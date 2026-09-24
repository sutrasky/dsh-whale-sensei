/**
 * intake.mjs — 学情摸底（intake）全部判据
 *
 * 判据：
 *   ① buildQuestions 五条 id 唯一 + research 里含 RESOURCES.md
 *   ② recordIntake 落盘 → 文件多一行、回读一致；再记一次 → readIntake().latest[point] 是后一条
 *   ③ point 缺失 → 不写盘（文件行数不变）
 *   ④ 台账里混一行坏 JSON → readIntake().problems 有它且不抛
 *   ④b ③(b) 起点台阶：三问落盘 / 键序钉死 / 同一 validateStage 拒坏 tier / B6 老记录活样本（不拦开课）
 *   ⑤ whale_author 闸门：commit:true（无摸底）→ ok:false、needsIntake:true、目标文件不存在；
 *      whale_intake op=record 之后再 commit:true → 文件存在；
 *      另建一例 force:true → 文件存在
 *   ⑥ decideNext：有 intake 缺口 → intake-course；缺口补上 → open-next-lesson
 *   ⑦ buildBrief 含「学情摸底」一节
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildQuestions, recordIntake, readIntake, intakeStatus } from '../lib/intake.js'
import { decideNext, buildBrief, NEXT_ACTIONS } from '../lib/brief.js'
import { buildIntakeSummary } from '../lib/brief-io.js'
import { validateStage } from '../lib/goal-io.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
import { plugin as intakePlugin } from '../lib/mods/intake.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

console.log('[intake] 学情摸底测试')

// ── ① buildQuestions ──
const q1 = buildQuestions({ point: 'vue', topic: 'Vue 3 组合式 API' })
ok(q1.questions.length === 5, 'buildQuestions 返回 5 条问题')
const ids = q1.questions.map((q) => q.id)
ok(new Set(ids).size === 5, '五条 id 唯一')
ok(ids.join(',') === 'prior,can,stuck,goal,time', 'id 顺序正确：prior,can,stuck,goal,time')
ok(q1.questions.every((q) => q.q && q.why), '每条都有 q 和 why')
ok(q1.questions[0].q.includes('Vue 3 组合式 API'), 'topic 嵌进了问题文本')
ok(q1.research.length >= 2, 'research 至少 2 条')
ok(q1.research.some((r) => r.includes('RESOURCES.md')), 'research 里含 RESOURCES.md（逐字）')

// 没有 topic 时用 point
const q2 = buildQuestions({ point: 'spring-boot' })
ok(q2.questions[0].q.includes('spring-boot'), '没有 topic 时用 point 作为问题文本')

// ── ①b 前置没学完 → 第 1 条问题就是前置闸（2026-09-23 用户裁定）──
const q3 = buildQuestions({
	point: 'vue',
	pack: {
		points: [
			{ id: 'spring-boot', circle: 'programming', requires: [] },
			{ id: 'vue', circle: 'programming', requires: ['spring-boot'] },
		],
		lessons: [{ id: 'spring-boot/0001', point: 'spring-boot', number: 1, label: '第1课', title: 'Hello', learned: false }],
	},
})
ok(q3.questions.length === 6 && q3.questions[0].id === 'prereq',
	`前置没学完 → 多问一条前置，且排在第一条（实得 ${q3.questions.length} 条，首条 ${q3.questions[0].id}）`)
ok(q3.gaps && q3.gaps.ok === false && q3.gaps.missing.length === 1, 'buildQuestions 把前置体检结果一并带出来（给调用方用）')
ok(buildQuestions({ point: 'vue' }).questions.length === 5, '不传 pack 就只有原来 5 条 —— 读不到就不猜（老调用方不受影响）')

// ── ② recordIntake 落盘 + 回读一致 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-intake-'))
const file = path.join(tmp, 'learning-records', 'intake.jsonl')

const e1 = { point: 'vue', level: '零基础', goal: '能独立写前端', at: '2026-09-21' }
const r1 = recordIntake(tmp, e1)
ok(r1.ok === true, 'recordIntake 写成功')
ok(fs.readFileSync(file, 'utf8').trim().split('\n').length === 1, '文件多了一行')

const read1 = readIntake(tmp)
ok(read1.entries.length === 1, 'readIntake 读到 1 条')
ok(read1.latest.vue?.level === '零基础', 'latest[point] 字段一致')

// 再记一次同 point → latest 应是后一条
const e2 = { point: 'vue', level: '有基础', goal: '精通', at: '2026-09-22' }
const r2 = recordIntake(tmp, e2)
ok(r2.ok === true, '第二次记录也成功')
const read2 = readIntake(tmp)
ok(read2.entries.length === 2, '文件现在有 2 条')
ok(read2.latest.vue?.level === '有基础', 'latest[point] 是后一条')
ok(read2.latest.vue?.at === '2026-09-22', 'latest 日期是后一条')

// intakeStatus
const st1 = intakeStatus(tmp, 'vue')
ok(st1.done === true, 'vue 的 intakeStatus.done = true')
ok(st1.level === '有基础', 'intakeStatus 返回最新 level')

const st2 = intakeStatus(tmp, 'react')
ok(st2.done === false, '不存在的 point → done=false')
ok(st2.missing.length > 0, '不存在的 point → missing 非空')

// ── ③ point 缺失 → 不写盘 ──
const linesBefore = fs.readFileSync(file, 'utf8').trim().split('\n').length
const r3 = recordIntake(tmp, { level: 'x', goal: 'y' })
ok(r3.ok === false && /point/.test(r3.error), 'point 缺失 → 返回错误')
ok(fs.readFileSync(file, 'utf8').trim().split('\n').length === linesBefore, 'point 缺失 → 文件行数不变')

const r3b = recordIntake(tmp, { point: '', level: 'x' })
ok(r3b.ok === false, 'point 空字符串 → 也拒绝')

// ── ④ 坏 JSON → problems 有它且不抛 ──
fs.appendFileSync(file, '这不是合法的JSON{{{]\n', 'utf8')
const read4 = readIntake(tmp)
ok(read4.problems.length === 1, '坏 JSON 行进了 problems')
ok(read4.problems[0].includes('第'), 'problems 里有行号信息')
ok(read4.entries.length === 2, '好行仍正常读出（不因坏行抛错）')

// ── ④b ③(b) 起点台阶：三问落盘 / 键序钉死 / 同一 validateStage / B6 活样本 ──
{
	const stageTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-intake-stage-'))
	let stageTool = null
	intakePlugin.install({ paths: { packRoot: stageTmp }, log: { info: () => {}, warn: () => {}, error: () => {} }, registerTool: (d) => { stageTool = d } })

	// ① 三问（原文）+ startTier → entry.start（StageSpec）
	const sr = await stageTool.execute({
		op: 'record', point: 'spring-boot', topic: 'Spring Boot', level: '有基础', background: '写过 Java',
		goal: '能独立做', time: '每周 5 小时', unknowns: '不懂自动配置',
		prior: '用过 Spring MVC', can: '能写 Controller', stuck: '事务边界搞不清', startTier: 3,
		answers: [{ q: 'q', a: 'a' }],
	})
	ok(sr.ok === true, '三问 + startTier 落盘成功')
	const sEntry = readIntake(stageTmp).latest['spring-boot']
	ok(sEntry.prior === '用过 Spring MVC' && sEntry.can === '能写 Controller' && sEntry.stuck === '事务边界搞不清', '三问原文落盘可回读')
	ok(!!sEntry.start && sEntry.start.tier === 3, `entry.start = 起点台阶（tier ${sEntry.start?.tier}）`)
	ok((sEntry.start.focus || []).join('、') === '事务边界搞不清', '起点台阶的 focus = stuck（痛点 = 教学重点）')
	ok(Object.keys(sEntry).join(',') === 'point,topic,level,background,goal,time,unknowns,prior,can,stuck,start,answers,at',
		`键序钉死（${Object.keys(sEntry).join(',')}）`)
	ok(!!validateStage(sEntry.start), '同一个 validateStage() 认这份 start（②③b 共用 schema，防「各定一套」）')

	// intakeStatus 只加法（B6）：done/missing 判据一字未改，start / structured 是新字段
	const st = intakeStatus(stageTmp, 'spring-boot')
	ok(st.done === true && st.missing.length === 0, 'done 判据一字未改（= level && goal）')
	ok(st.structured === true && st.start?.tier === 3, 'intakeStatus 带出 start / structured（只加法）')

	// ② 同一套校验：坏 tier 拒写（拒在 append 之前）
	const stageFile = path.join(stageTmp, 'learning-records', 'intake.jsonl')
	const linesBefore2 = fs.readFileSync(stageFile, 'utf8').trim().split('\n').length
	const badTool = await stageTool.execute({ op: 'record', point: 'vue', level: '零基础', startTier: 5 })
	ok(badTool.ok === false && /startTier|tier/.test(badTool.error || ''), `startTier=5 → 拒写（${badTool.error}）`)
	const badDirect = recordIntake(stageTmp, { point: 'vue', level: '零基础', start: { tier: 9, artifact: { what: 'x', where: null }, acceptance: [], focus: null } })
	ok(badDirect.ok === false && /起点台阶/.test(badDirect.error || ''), `recordIntake 层坏 start 也拒写（${badDirect.error}）`)
	ok(fs.readFileSync(stageFile, 'utf8').trim().split('\n').length === linesBefore2, '拒写在 append 之前（台账没多行）')

	// 渲染：op=read 印「起点台阶：tier N · 卡点：<stuck>」
	const rendered = stageTool.output.render({}, await stageTool.execute({ op: 'read' }))[0].text
	ok(/起点台阶：tier 3/.test(rendered) && /卡点：事务边界搞不清/.test(rendered),
		`op=read 渲染起点台阶（${rendered.split('\n').find((l) => l.includes('起点台阶'))}）`)

	// ③ B6 活样本：只有 {point,level,goal} 的老行 —— 绝不判「没摸底」、绝不拦开课（老包缺新字段同理）
	const oldTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-intake-old-'))
	fs.mkdirSync(path.join(oldTmp, 'learning-records'), { recursive: true })
	fs.writeFileSync(path.join(oldTmp, 'learning-records', 'intake.jsonl'),
		JSON.stringify({ point: 'vue', level: '有基础', goal: '能独立写一个' }) + '\n', 'utf8')
	const oldStatus = intakeStatus(oldTmp, 'vue')
	ok(oldStatus.done === true && oldStatus.missing.length === 0, '老记录 {point,level,goal} → done=true（B6：绝不判「没摸底」）')
	ok(oldStatus.start === null && oldStatus.structured === false, '老记录无 start → start=null / structured=false（只提示，不判缺失）')
	const oldSummary = buildIntakeSummary(oldTmp, { points: [{ id: 'vue' }], circles: [], lessons: [] })
	ok(oldSummary.have === 1 && oldSummary.missing.length === 0, 'buildIntakeSummary 判据一字未改（e?.level && e?.goal）')
	const oldProjects = [{ lessons: [{ id: 'vue/0001', title: '第1课', done: true, satisfied: [], missing: [] }] }]
	const oldNext = decideNext({ pending: 0, projects: oldProjects, lessonTotal: 1, intake: oldSummary })
	ok(oldNext.action === 'open-next-lesson', `老记录不拦开课（decideNext=${oldNext.action}，不是 intake-course）`)
	const oldBrief = buildBrief({
		pack: { circles: 1, points: 1, lessons: 1, learned: 0 },
		projects: [], pending: [], processed: 0, ledger: { count: 0, latest: null },
		glossary: { count: 0, categories: 0 }, records: [], recordCount: 0, notes: [], intake: oldSummary,
	})
	const oldSec = oldBrief.sections.find((s) => s.title === '学情摸底')
	ok(oldSec.lines.some((l) => l.includes('已摸底（有基础）') && !l.includes('起点台阶')), '老记录 → brief 不出「起点台阶」（照旧一行）')
	const oldGoalSec = oldBrief.sections.find((s) => s.title === '终点契约')
	ok(/终点还没结构化/.test(oldGoalSec.lines.join('')), '没有 goals.jsonl → 只提示「终点还没结构化」')

	fs.rmSync(stageTmp, { recursive: true, force: true })
	fs.rmSync(oldTmp, { recursive: true, force: true })
}

// ── ⑤ whale_author 闸门 ──
const authorTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-author-gate-'))
const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }

function installAuthor(root) {
	let tool = null
	authorPlugin.install({ paths: { packRoot: root }, log: fakeLog, registerTool: (d) => { tool = d } })
	return tool
}
function installIntake(root) {
	let tool = null
	intakePlugin.install({ paths: { packRoot: root }, log: fakeLog, registerTool: (d) => { tool = d } })
	return tool
}

const authorTool = installAuthor(authorTmp)
const authorArgs = {
	point: 'spring-boot', halo: 'programming', number: 9, title: '冒烟骨架', slug: 'smoke-skeleton',
	hintTerm: '自动配置', source: { label: 'x', url: 'https://example.com/' },
}

// commit:true 无摸底 → 闸门拦住
const g1 = await authorTool.execute({ ...authorArgs, commit: true })
ok(g1.ok === false, 'commit:true 无摸底 → ok=false')
ok(g1.needsIntake === true, 'needsIntake=true')
ok(g1.error.includes('spring-boot'), 'error 包含 point 名')
ok(Array.isArray(g1.questions) && g1.questions.length === 5, '返回了 5 条问题')
ok(g1.hint.includes('force:true'), 'hint 提示 force:true')
// 目标文件不存在
const targetFile = path.join(authorTmp, 'lessons', 'src', 'programming', 'spring-boot', '0009-smoke-skeleton.html')
ok(!fs.existsSync(targetFile), '闸门拦住后目标文件不存在')

// whale_intake op=record 之后再 commit → 文件存在
const intakeTool = installIntake(authorTmp)
await intakeTool.execute({ op: 'record', point: 'spring-boot', level: '零基础', goal: '能写 REST API' })
const g2 = await authorTool.execute({ ...authorArgs, commit: true })
ok(g2.ok === true && g2.wrote === true, '做完摸底后 commit:true → 写成功')
ok(fs.existsSync(targetFile), '目标文件存在了')

// 另建一例 force:true → 即使没摸底也能写
const forceTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-author-force-'))
const authorTool2 = installAuthor(forceTmp)
const forceArgs = {
	point: 'vue', number: 1, title: 'Vue 入门', slug: 'vue-intro',
	hintTerm: '响应式', source: { label: 'x', url: 'https://example.com/' },
}
const g3 = await authorTool2.execute({ ...forceArgs, commit: true, force: true })
ok(g3.ok === true && g3.wrote === true, 'force:true 无摸底也能写')

// ── ⑤b 前置闸（2026-09-23 用户裁定）：「前置没学完 → 建议去学那门课，而不是继续生成新课」──
// 空目录测不出这条闸：readPack 读不到知识点 → prerequisiteGaps 走 unknown-point → **不拦**
// （拿"不知道"当"不合格"会误拦正在新建的第一课）。所以要手搓一个**最小课程包**。
const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-author-prereq-'))
const writeJson = (rel, obj) => {
	const f = path.join(gateTmp, rel)
	fs.mkdirSync(path.dirname(f), { recursive: true })
	fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}
writeJson('lessons/programming/halo.json', { halo: 'programming', name: '编程' })
// ⚠️ 这两个点还要带上**合法地图**（2026-09-24 F2 起 `whale_author` 有大纲闸，且**禁 force**）：
//    不给地图的话，这两段测的「前置闸 / 放行」会被大纲闸抢在前面拦掉 —— 判据就测不到该测的东西。
const SMOKE_PLAN = {
	goal: '交付一个能跑起来、能访问接口的服务',
	nodes: [{
		no: 1, title: '第1课 起步', deliverable: '一个能跑起来、访问得到 /hello 的应用',
		criteria: '访问 /hello 有响应', why: '终点是交付服务 —— 先得让它跑起来',
		sources: [{ label: '官方指南', url: 'https://spring.io/guides/gs/spring-boot/' }],
	}],
}
writeJson('lessons/programming/spring-boot/point.json', { point: 'spring-boot', name: 'Spring Boot', label: '', fileBase: 0, plan: SMOKE_PLAN })
writeJson('lessons/programming/vue/point.json', { point: 'vue', name: 'Vue', label: 'Vue', fileBase: 1000, requires: ['spring-boot'], plan: SMOKE_PLAN })
// 前置点下必须**真有课**，否则走的是 emptyPoints 那条分支（也拦，但理由不同）
const sbSrc = path.join(gateTmp, 'lessons', 'src', 'programming', 'spring-boot')
fs.mkdirSync(sbSrc, { recursive: true })
fs.writeFileSync(path.join(sbSrc, '0001-hello.html'),
	'<script type="application/json" data-lesson-meta>\n'
	+ JSON.stringify({ title: '第1课', number: 1, navTitle: '第1课', hintTerm: 'x', terms: {}, source: { label: 'x', url: 'https://example.com/' } }, null, 2)
	+ '\n</script>\n', 'utf8')
const vueTarget = path.join(gateTmp, 'lessons', 'src', 'programming', 'vue', '1001-vue-intro.html')
const vueArgs = { point: 'vue', number: 1001, title: 'Vue 入门', slug: 'vue-intro', hintTerm: '响应式', source: { label: 'x', url: 'https://example.com/' }, commit: true }
const gateTool = installAuthor(gateTmp)

fs.writeFileSync(path.join(gateTmp, 'progress.json'), JSON.stringify({ learned: [] }, null, 2) + '\n', 'utf8')
const pg1 = await gateTool.execute({ ...vueArgs })
ok(pg1.ok === false && pg1.needsPrerequisite === true, `前置没学完 → 拒绝生成新课（实得 ok=${pg1.ok} needsPrerequisite=${pg1.needsPrerequisite}）`)
ok(String(pg1.error).includes('spring-boot') && (pg1.missing || []).includes('spring-boot/0001'),
	`拒绝理由点名缺的是哪一课（实得 ${JSON.stringify(pg1.missing)}）`)
ok(!fs.existsSync(vueTarget), '被前置闸拦住后，目标文件不存在')

// 点亮前置课 → 前置闸放行，接着由摸底闸接手
fs.writeFileSync(path.join(gateTmp, 'progress.json'), JSON.stringify({ learned: ['spring-boot/0001'] }, null, 2) + '\n', 'utf8')
const pg2 = await gateTool.execute({ ...vueArgs })
ok(pg2.needsPrerequisite !== true && pg2.needsIntake === true, '前置点亮后放行，改由摸底闸接手')

// force 留痕：描述承诺过"会留痕"，此前是空头支票 —— 要如实报出绕过了哪几道闸
const pg3 = await gateTool.execute({ ...vueArgs, force: true })
ok(pg3.ok === true && pg3.wrote === true, 'force:true 能落盘')
ok(Array.isArray(pg3.forced?.bypassed) && pg3.forced.bypassed.some((s) => /学情摸底/.test(s)),
	`force 留痕：列出被跳过的闸（实得 ${JSON.stringify(pg3.forced)}）`)

// 非 commit 模式带出摸底状态
const g4 = await authorTool.execute({ ...authorArgs })
ok(g4.intake?.done === true, '非 commit 模式：intake.done=true（刚才已摸底）')
const authorTool3 = installAuthor(forceTmp)
const g5 = await authorTool3.execute({ ...forceArgs })
ok(g5.intake?.done === false, '非 commit 模式：未摸底时 intake.done=false')
ok(Array.isArray(g5.intake?.missing) && g5.intake.missing.length > 0, '非 commit 模式：missing 非空')

// ── ⑥ decideNext：intake 缺口 ──
const baseProjects = [{
	lessons: [
		{ id: 'spring-boot/0001', title: '第1课', done: true, satisfied: [], missing: [] },
		{ id: 'spring-boot/0002', title: '第2课', done: true, satisfied: [], missing: [] },
	],
}]

// 有缺口 → intake-course
const dn1 = decideNext({
	pending: 0,
	projects: baseProjects,
	lessonTotal: 2,
	intake: { have: 0, missing: ['vue', 'spring-boot'] },
})
ok(dn1.action === 'intake-course', '有 intake 缺口 → intake-course')
ok(NEXT_ACTIONS.includes('intake-course'), 'intake-course 在 NEXT_ACTIONS 封闭集里')
ok(dn1.missing.includes('vue'), 'missing 里列出了具体 point')
ok(/还没做学情摸底/.test(dn1.why), 'why 说清原因')

// 缺口补上 → open-next-lesson
const dn2 = decideNext({
	pending: 0,
	projects: baseProjects,
	lessonTotal: 2,
	intake: { have: 2, missing: [] },
})
ok(dn2.action === 'open-next-lesson', '缺口补上 → open-next-lesson')

// 没有 intake 数据（旧 brief 不带它）→ 不卡
const dn3 = decideNext({
	pending: 0,
	projects: baseProjects,
	lessonTotal: 2,
})
ok(dn3.action === 'open-next-lesson', '没有 intake 数据时不卡（向后兼容）')

// ── ⑦ buildBrief 含学情摸底一节 ──
const brief1 = buildBrief({
	pack: { circles: 1, points: 2, lessons: 3, learned: 1 },
	projects: [],
	pending: [],
	processed: 0,
	ledger: { count: 0, latest: null },
	glossary: { count: 0, categories: 0 },
	records: [],
	notes: [],
	intake: { have: 1, missing: ['vue'], details: { 'spring-boot': '零基础' } },
})
const intakeSec = brief1.sections.find((s) => s.title === '学情摸底')
ok(!!intakeSec, 'buildBrief 有「学情摸底」一节')
ok(intakeSec.lines[0] === '已摸底 1 个知识点 · 缺 1', '摘要行格式正确')
ok(intakeSec.lines.some((l) => l.includes('vue') && l.includes('未摸底')), '未摸底的 point 出现')
ok(intakeSec.lines.some((l) => l.includes('spring-boot') && l.includes('零基础')), '已摸底的 point 出现且带 level')

// 无 intake 数据时仍然有这一节
const brief2 = buildBrief({
	pack: { circles: 1, points: 2, lessons: 3, learned: 1 },
	projects: [],
	pending: [],
	processed: 0,
	ledger: { count: 0, latest: null },
	glossary: { count: 0, categories: 0 },
	records: [],
	notes: [],
})
const intakeSec2 = brief2.sections.find((s) => s.title === '学情摸底')
ok(!!intakeSec2, '无 intake 数据时仍有这一节')
ok(intakeSec2.lines[0] === '已摸底 0 个知识点 · 缺 0', '无数据时摘要行为 0 / 0')

// 清理
fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(authorTmp, { recursive: true, force: true })
fs.rmSync(forceTmp, { recursive: true, force: true })

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 学情摸底：闸门、落盘、问题生成、brief 集成全部通过')
