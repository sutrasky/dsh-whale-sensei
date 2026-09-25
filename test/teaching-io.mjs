/**
 * teaching-io.mjs —— 教学参数（按圆圈分节）的判据
 * ==================================================================
 * 主人的两条裁定（2026-09-25）：
 *   ① **全范围层必须学科中立** —— 鲸师面向全方面的知识目标，不是编程专用；
 *   ② **教学特化挂在圆圈上** —— 台账按圆圈分节，每个圆圈有自己独立的教学方法，
 *      学科知识**数据驱动**（圆圈自己的 spec），**不许硬编码**。
 *
 * 覆盖面：
 *   ① 全局可调项：三个学科中立参数，每个取值都带**指令句**，四档默认齐；
 *   ② **学科中立判据**（`subjectsHit`）：全局参数表与锁死集，命中恰好 1 个学科 = 红；
 *   ③ 圆圈 spec：合法写入 / 缺 directive 拒 / defaultByTier 缺档拒 / 与全局同名拒；
 *   ④ 取值：必须在 spec ∪ 全局的取值域里；多余键拒；上限 + 合并 + 确认制；
 *   ⑤ append-only：**每个 (圆圈, kind) 各有一条版本线**；绝不写时间字段；键序钉死；
 *   ⑥ 读侧容错 + 拒写回滚；⑦ 工具面（read / propose / write 都要带 circle）；⑧ 真包一字未动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { plugin as teachingPlugin } from '../lib/mods/teaching.js'
import {
	readTeaching, recordTeaching, resolveFor, defaultsFor, validateTeaching, validateSpec,
	TEACHING_KEYS, TEACHING_PARAMS, TEACHING_DISCIPLINE, GLOBAL_CIRCLE,
	FREE_TEXT_MAX, FREE_TEXT_MAX_CHARS, teachingPath, subjectsHit, guideFor,
	GUIDE_MAX_ITEMS, GUIDE_MAX_LINES, GUIDE_MAX_LINE_CHARS,
} from '../lib/teaching-io.js'
import { TIERS } from '../lib/goal-io.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
function hashTree(root) {
	const out = []
	const walk = (dir, rel) => {
		let es = []
		try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
		es.sort((a, b) => a.name.localeCompare(b.name))
		for (const e of es) {
			const r = rel ? rel + '/' + e.name : e.name
			if (e.isDirectory()) walk(path.join(dir, e.name), r)
			else out.push(r + ':' + sha(fs.readFileSync(path.join(dir, e.name))))
		}
	}
	walk(root, '')
	return out.join('|')
}

console.log(`\n[teaching] 课程包：${ROOT}`)
const realBefore = hashTree(path.join(ROOT, 'learning-records'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-teaching-'))
try {
	fs.cpSync(ROOT, tmp, { recursive: true })
	fs.rmSync(teachingPath(tmp), { force: true })
	const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }
	const tools = []
	const install = (mod) => { mod.install({ paths: { packRoot: tmp }, log: fakeLog, registerTool: (d) => tools.push(d) }); return tools[tools.length - 1] }
	const tool = install(teachingPlugin)

	// ── ① 全局可调项：学科中立 + 每档有指令句 + 四档默认齐 ──
	ok(tool?.name === 'whale_teaching', 'whale_teaching 装得上')
	{
		const items = Object.entries(TEACHING_PARAMS)
		ok(items.length === 3, `全局可调项就三个（${items.map(([id]) => id).join(' / ')}）`)
		let complete = true
		for (const [, d] of items) {
			for (const t of TIERS) if (d.defaultByTier[t] === undefined) complete = false
			for (const v of d.values) if (!v.directive) complete = false
		}
		ok(complete, '每个取值都有**指令句**、四档默认值都齐（注入直接用它，代码里不另写话术）')
	}

	// ── ② 学科中立判据：全局参数表与锁死集 ──
	{
		const globalText = JSON.stringify(TEACHING_PARAMS)
		ok(subjectsHit(globalText).length !== 1, `全局可调项表是学科中立的（命中 ${subjectsHit(globalText).length || 0} 个学科）`)
		const spec = TEACHING_DISCIPLINE.filter((d) => subjectsHit(d.label + d.why).length === 1)
		ok(spec.length === 0, `锁死集是学科中立的（没有哪一条只对一个学科成立）${spec.length ? ' —— 实得：' + spec.map((d) => d.id).join(' / ') : ''}`)
		ok(subjectsHit(TEACHING_DISCIPLINE[0].why).length >= 2, '第一条的 why 是**跨学科举例**（不是只对一个学科成立）')
		ok(TEACHING_DISCIPLINE.some((d) => d.id === 'readStudentWorkFirst'), '第一条是「先看学生的产出」（不是编程专用的「先读学生代码」）')
	}

	// ── ③ 圆圈 spec：合法 / 拒坏 ──
	const GOOD_SPEC = [
		{ id: 'commentDensity', label: '注释密度', values: [{ id: 'line', directive: '逐行加注释。' }, { id: 'block', directive: '按块加注释。' }, { id: 'key', directive: '只在关键行加注释。' }], defaultByTier: { 1: 'line', 2: 'line', 3: 'block', 4: 'key' } },
	]
	{
		const s1 = recordTeaching(tmp, { circle: 'programming', kind: 'spec', spec: GOOD_SPEC, source: 'agent' })
		ok(s1.ok === true, `圆圈 spec 写入成功（${s1.record?.circle}/spec v${s1.record?.v}）`)
		ok(s1.record.spec[0].values.length === 3, 'spec 把取值域与指令句都收下了')
		const badDir = recordTeaching(tmp, { circle: 'programming', kind: 'spec', spec: [{ id: 'x', label: 'X', values: [{ id: 'a' }], defaultByTier: { 1: 'a', 2: 'a', 3: 'a', 4: 'a' } }], source: 'agent' })
		ok(badDir.ok === false && /缺 directive/.test(badDir.error), `取值缺指令句 → 拒写（${badDir.error}）`)
		const badTier = recordTeaching(tmp, { circle: 'programming', kind: 'spec', spec: [{ id: 'y', label: 'Y', values: [{ id: 'a', directive: 'd' }], defaultByTier: { 1: 'a' } }], source: 'agent' })
		ok(badTier.ok === false && /缺 tier/.test(badTier.error), `defaultByTier 缺档 → 拒写（${badTier.error}）`)
		const clash = recordTeaching(tmp, { circle: 'programming', kind: 'spec', spec: [{ id: 'termPairing', label: 'X', values: [{ id: 'a', directive: 'd' }], defaultByTier: { 1: 'a', 2: 'a', 3: 'a', 4: 'a' } }], source: 'agent' })
		ok(clash.ok === false && /与全局可调项同名/.test(clash.error), `与全局参数同名 → 拒写（${clash.error}）`)
		const globalSpec = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'spec', spec: GOOD_SPEC, source: 'agent' })
		ok(globalSpec.ok === false && /必须挂在/.test(globalSpec.error), `全局层不许写 spec（${globalSpec.error}）`)
	}

	// ── ③b 圆圈能**声明判据**（`judge`）—— 2026-09-25 补的死契约 ──
	//
	// `lib/teaching-apply.js` 的 `judgeTeachingContent()` 读 `item.judge`（声明了名字就去可插拔表里查，
	// 没实现就 `ok:null` 如实说"不假装判过"）。但 `SPEC_KEYS` 原先**没有 `judge`** ⇒
	// agent 一写就被当"多余键"拒，`JUDGES` 永远空表 —— 那条"可插拔"是死的。
	// 这一组判据把那个口子钉住：能写、能原样读回、坏名字仍要拒、不声明就不落这个键。
	//
	// ⚠️ 用**另一个圆圈**（`judgeCircle`）：往 `programming` 再写一版 spec 会把它上面的
	//    `commentDensity` 换掉，后面那批判据全跟着红（实测踩过一次）。
	{
		const JUDGE_CIRCLE = 'judge-circle'
		const withJudge = [
			{ id: 'lineDensity', label: '行密度', judge: 'lineDensity',
				values: [{ id: 'loose', directive: '段落之间留白多一点。' }, { id: 'tight', directive: '段落排紧一点。' }],
				defaultByTier: { 1: 'loose', 2: 'loose', 3: 'tight', 4: 'tight' } },
		]
		const w = recordTeaching(tmp, { circle: JUDGE_CIRCLE, kind: 'spec', spec: withJudge, source: 'agent' })
		ok(w.ok === true, `spec 能声明 judge（${w.ok ? 'ok' : w.error}）`)
		ok(w.record?.spec?.[0]?.judge === 'lineDensity', 'judge 原样读回（没被丢掉、没被改名）')
		ok(validateSpec(withJudge)[0].judge === 'lineDensity', 'validateSpec 也保留 judge')

		const badName = recordTeaching(tmp, { circle: JUDGE_CIRCLE, kind: 'spec', source: 'agent',
			spec: [{ ...withJudge[0], judge: 'not a name!' }] })
		ok(badName.ok === false && /judge 必须是/.test(badName.error), `judge 不是标识符 → 拒写（${badName.error}）`)

		const noJudge = validateSpec([{ ...withJudge[0], judge: undefined }])[0]
		ok(!('judge' in noJudge), '不声明 judge 时**不落这个键**（键序与字节跟没声明过的一样）')

		// 判据那边：声明了名字但插件里没实现 → ok:null（不假装判过）
		const { judgeTeachingContent } = await import('../lib/teaching-apply.js')
		const checks = judgeTeachingContent('<p>x</p>', { lineDensity: 'tight' }, validateSpec(withJudge))
		ok(checks.length === 1 && checks[0].ok === null && /没有实现/.test(checks[0].detail),
			`声明了判据但没实现 → ok:null 且写明原因（${checks[0]?.detail}）`)
		const undeclared = judgeTeachingContent('<p>x</p>', { lineDensity: 'tight' }, validateSpec([{ ...withJudge[0], judge: undefined }]))
		ok(undeclared.length === 0, '没声明 judge 的可调项**不判**（不凭空造判据）')
	}

	// ── ③c 圆圈的**固定做法**（`kind=guide`）—— 2026-09-25 P2 加的第三种记录 ──
	//
	// 为什么要有它：教学纪律学科中立（先看学生的产出），但"**怎么看**"是特化的
	// （编程看源码树与清单文件，别的学科看别的）。这类固定做法既不是可调项（没有取值域、
	// 学生不该改），也不能写在全范围技能里（写进去就是特化）⇒ 挂在圆圈上，进生成课程的提示词。
	// 这一组判据把那条路钉住：能写、能原样读回、**学科词在这儿是合法的**、坏形状一律拒。
	{
		const GUIDE_CIRCLE = 'guide-circle'
		const GUIDE = [
			{ title: '动笔前先看他的产出', lines: ['动手的活在 code/ 下，一个项目一个目录 —— 它是"上一课到底落地没有"的唯一真凭据。', '列源码树，忽略构建产物与编辑器噪音。'] },
			{ title: '清单文件是版本真源', lines: ['pom.xml / package.json 逐字抄，别凭记忆。'] },
		]
		const w = recordTeaching(tmp, { circle: GUIDE_CIRCLE, kind: 'guide', guide: GUIDE, source: 'agent' })
		ok(w.ok === true, `圆圈能声明固定做法（${w.ok ? 'ok' : w.error}）`)
		ok(w.record?.kind === 'guide' && w.record?.guide?.length === 2, 'guide 原样读回（2 条）')
		ok(w.record.guide[0].lines.length === 2 && w.record.guide[1].title === '清单文件是版本真源', '标题与行都原样保留')
		ok(w.record.guide[0].lines[0].includes('code/'), '**学科词在这儿是合法的** —— 它就是放特化的地方（反空转：不是把内容洗掉了）')
		ok(!('params' in w.record) && !('tier' in w.record) && !('spec' in w.record), 'guide 记录**只落该有的键**（没有 params/tier/spec）')

		const back = readTeaching(tmp)
		ok(back.circles[GUIDE_CIRCLE]?.guide?.length === 2 && back.circles[GUIDE_CIRCLE]?.guideV === 1,
			`读回来落在 circles.${GUIDE_CIRCLE}.guide（v1）`)
		ok((back.circles[GUIDE_CIRCLE]?.valuesV ?? 0) === 0, 'guide **不污染** values 那条版本线（各是各的）')
		ok(guideFor(back, GUIDE_CIRCLE).length === 2 && guideFor(back, 'no-such-circle').length === 0,
			'guideFor()：有就给，没有就空数组（不抛）')

		// 第二条 → 版本线 v2（同一 (圆圈, kind) 各自算）
		const w2 = recordTeaching(tmp, { circle: GUIDE_CIRCLE, kind: 'guide', guide: [GUIDE[0]], source: 'agent', reason: '先压到一条' })
		ok(w2.ok === true && w2.record.v === 2 && w2.record.replaces === 1, `换一版追一条（v${w2.record?.v} replaces ${w2.record?.replaces}）`)
		ok(readTeaching(tmp).circles[GUIDE_CIRCLE].guide.length === 1, '读回来是**最新那一条**（1 条）')

		// 拒坏形状
		const cases = [
			['挂在全局层', { circle: GLOBAL_CIRCLE, kind: 'guide', guide: GUIDE }, /必须挂在/],
			['guide 是空数组', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [] }, /非空数组/],
			['缺 title', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ lines: ['x'] }] }, /缺 title/],
			['lines 是空的', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: [] }] }, /lines 必须是非空数组/],
			['有空行', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: ['x', '   '] }] }, /有空行/],
			['有重复行', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: ['x', 'x'] }] }, /重复行/],
			['标题重复', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: ['x'] }, { title: 'T', lines: ['y'] }] }, /重复标题/],
			['行超长', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: ['啊'.repeat(GUIDE_MAX_LINE_CHARS + 1)] }] }, /超过上限/],
			['条数超上限', { circle: GUIDE_CIRCLE, kind: 'guide', guide: Array.from({ length: GUIDE_MAX_ITEMS + 1 }, (_, i) => ({ title: 'T' + i, lines: ['x'] })) }, /上限/],
			['行数超上限', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: Array.from({ length: GUIDE_MAX_LINES + 1 }, (_, i) => 'x' + i) }] }, /上限/],
			['多余键', { circle: GUIDE_CIRCLE, kind: 'guide', guide: [{ title: 'T', lines: ['x'], why: 'y' }] }, /多余键/],
			['guide 带 params', { circle: GUIDE_CIRCLE, kind: 'guide', guide: GUIDE, params: {} }, /不该有 params/],
			['spec 带 guide', { circle: GUIDE_CIRCLE, kind: 'spec', spec: GOOD_SPEC, guide: GUIDE }, /不该有 guide/],
			['values 带 guide', { circle: GUIDE_CIRCLE, kind: 'values', tier: 1, params: {}, guide: GUIDE }, /不该有 guide/],
		]
		let rejected = 0
		for (const [name, input, re] of cases) {
			const r = recordTeaching(tmp, { ...input, source: 'agent' })
			if (r.ok === false && re.test(r.error)) rejected++
			else console.log(`FAIL 拒坏形状 · ${name}：${r.ok ? '竟然写进去了' : r.error}`)
		}
		ok(rejected === cases.length, `坏形状全部拒写（${rejected}/${cases.length}）—— 上限拒写不静默截断`)
		ok(readTeaching(tmp).circles[GUIDE_CIRCLE].guideV === 2, '被拒的那些**一行都没落盘**（版本线还停在 v2）')
	}

	// ── ④ 取值：落在 spec ∪ 全局的域里 ──
	{
		const r1 = recordTeaching(tmp, { circle: 'programming', kind: 'values', tier: 2, params: { commentDensity: 'block' }, source: 'student' })
		ok(r1.ok === true, '圆圈取值写入成功（取值来自该圆圈的 spec）')
		const bad = recordTeaching(tmp, { circle: 'programming', kind: 'values', tier: 2, params: { commentDensity: 'verbose' }, source: 'student' })
		ok(bad.ok === false && /取值不认识/.test(bad.error), `spec 域外的值拒写（${bad.error}）`)
		const g = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 3, params: { explainOrder: 'detail-first' }, source: 'student' })
		ok(g.ok === true, '全局取值写入成功（取值来自代码里的全局表）')
		const cross = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 3, params: { commentDensity: 'block' }, source: 'student' })
		ok(cross.ok === false && /多余键/.test(cross.error), `全局层写圆圈特化的参数 → 拒（${cross.error}）`)
		const missing = recordTeaching(tmp, { circle: 'math', kind: 'values', tier: 1, params: { commentDensity: 'block' }, source: 'student' })
		ok(missing.ok === false && /多余键/.test(missing.error), '别的圆圈（没声明过 spec）也拒 —— 特化**不串圈**')
	}

	// ── ⑤ 锁死集 + 上限 + 确认制 ──
	{
		const locked = TEACHING_DISCIPLINE[0]
		const r = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 2, params: { [locked.id]: false }, source: 'student' })
		ok(r.ok === false && /教学纪律/.test(r.error) && r.error.includes(locked.id), `写「${locked.label}」→ 拒写并点名（${r.error}）`)
		const many = Array.from({ length: FREE_TEXT_MAX + 1 }, (_, i) => `偏好${i + 1}`)
		const r2 = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 2, freeText: many.map((t) => ({ text: t, confirmed: true })), source: 'student' })
		ok(r2.ok === false && /上限 5 条/.test(r2.error), `自由补充超上限拒写 + 提示合并（${r2.error}）`)
		const long = '很长的一句偏好'.repeat(10).slice(0, FREE_TEXT_MAX_CHARS + 1)
		const r3 = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 2, freeText: [{ text: long, confirmed: true }], source: 'student' })
		ok(r3.ok === false && /单条上限/.test(r3.error), `单条超 ${FREE_TEXT_MAX_CHARS} 字拒写`)
		const r4 = recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 2, freeText: [{ text: '没点头', confirmed: false }], source: 'student' })
		ok(r4.ok === false && /点头才写/.test(r4.error), '没 confirmed:true → 拒写（写入闸 = 确认制）')
	}

	// ── ⑥ append-only：每个 (圆圈, kind) 各一条版本线；无时间戳；键序钉死 ──
	{
		const d = readTeaching(tmp)
		// 按 **(圆圈, kind)** 逐条对，不写裸数字 —— 少一条/多一条都能一眼看出是哪条。
		// `guide-circle/guide` 出现两次是**故意的**：那是它自己的版本线（v1 → v2）。
		const pairs = d.entries.map((e) => `${e.circle}/${e.kind ?? 'values'}`)
		const uniq = [...new Set(pairs)].sort()
		ok(uniq.join(' ') === '*/values guide-circle/guide judge-circle/spec programming/spec programming/values',
			`台账覆盖这五条线（${uniq.join(' ')}）—— 被拒的都没落盘`)
		ok(pairs.length === 6 && pairs.filter((p) => p === 'guide-circle/guide').length === 2,
			`共 ${pairs.length} 行，其中 guide-circle/guide 两行（各 (圆圈, kind) 一条版本线）`)
		ok(d.circles.programming?.specV === 1 && d.circles.programming?.valuesV === 1, '圆圈 programming 的 spec 与 values **各有一条版本线**（各自从 v1 起）')
		ok(d.global.v === 1 && d.global.values?.tier === 3, '全局层也有自己的版本线（v1）—— 三条线互不干扰')
		const dup = recordTeaching(tmp, { v: 99, circle: 'programming', kind: 'values', tier: 2, params: { commentDensity: 'key' }, source: 'student' })
		ok(dup.ok === false && /v 由台账算出/.test(dup.error), `显式 v 与台账不符 → 拒写（${dup.error}）`)
		const text = fs.readFileSync(teachingPath(tmp), 'utf8')
		ok(!/\d{4}-\d{2}-\d{2}T/.test(text) && !/"ts"|"createdAt"/.test(text), '**绝不写时间字段**')
		ok(text.split('\n').filter(Boolean).every((l) => Object.keys(JSON.parse(l)).join(',') === TEACHING_KEYS.filter((k) => k in JSON.parse(l)).join(',')), '键序钉死（落盘顺序 == TEACHING_KEYS）')
	}

	// ── ⑦ 生效值：全局 ⊕ 圆圈，各算各的 ──
	{
		const d = readTeaching(tmp)
		const p = resolveFor(d, 'programming')
		ok(p.params.commentDensity === 'block', `圆圈取值生效（commentDensity=${p.params.commentDensity}）`)
		ok(p.params.explainOrder === 'detail-first', '全局取值也叠进来了（explainOrder=detail-first）')
		ok(p.overridden.includes('commentDensity') && p.overridden.includes('explainOrder'), '两层改过的都记进 overridden')
		const m = resolveFor(d, 'math')
		ok(m.params.commentDensity === undefined, '**别的圆圈看不到 programming 的特化**（特化不串圈）')
		ok(m.params.explainOrder === 'detail-first', '但全局取值对所有圆圈都生效')
		ok(defaultsFor(4, d.circles.programming.spec).commentDensity === 'key', '圆圈 spec 的档位默认生效（tier4 → key）')
	}

	// ── ⑧ 读侧容错 + 拒写回滚 ──
	{
		const file = teachingPath(tmp)
		const before = fs.readFileSync(file, 'utf8')
		const goodLines = before.split('\n').filter((l) => l.trim()).length
		fs.appendFileSync(file, '这不是合法JSON{{{]\n', 'utf8')
		const r = readTeaching(tmp)
		ok(r.problems.some((p) => /解析失败/.test(p)) && r.entries.length === goodLines,
			`坏行进 problems、不抛、不静默丢（好行 ${goodLines} 条一条不少）`)
		fs.writeFileSync(file, before, 'utf8')
		const bad = recordTeaching(tmp, { circle: 'programming', kind: 'values', tier: 9, params: {}, source: 'student' })
		ok(bad.ok === false && /tier/.test(bad.error), '坏 tier 拒写')
		ok(fs.readFileSync(file, 'utf8') === before, '拒写在 append 之前 ⇒ 文件逐字节未变')
	}

	// ── ⑨ 工具面：read 带圆圈 / propose 不写盘 / write 要 confirm ──
	{
		const file = teachingPath(tmp)
		const before = fs.readFileSync(file, 'utf8')
		const rd = await tool.execute({ op: 'read', circle: 'programming', root: tmp })
		ok(rd.ok === true && rd.current.params.commentDensity === 'block', 'read 按圆圈回生效参数')
		ok(rd.spec.length === 1 && rd.spec[0].id === 'commentDensity', 'read 把该圆圈的 spec 一并回（agent 才知道能改什么）')

		const prop = await tool.execute({ op: 'propose', circle: 'programming', params: { commentDensity: 'key' }, root: tmp })
		ok(prop.ok === true && typeof prop.previewLine === 'string' && prop.previewLine.includes('whale-teaching/1'), 'propose 回一份"会落盘的那一行"预览')
		ok(fs.readFileSync(file, 'utf8') === before, 'propose **不写盘**')

		const noConfirm = await tool.execute({ op: 'write', circle: 'programming', params: { commentDensity: 'key' }, root: tmp })
		ok(noConfirm.ok === false && /confirm:true/.test(noConfirm.error), 'write 没 confirm → 拒写')
		const wrote = await tool.execute({ op: 'write', circle: 'programming', params: { commentDensity: 'key' }, confirm: true, root: tmp })
		ok(wrote.ok === true && wrote.teachingSaved === true, `confirm:true → 落盘（v${wrote.record?.v}）`)
		// 累积合并：这一版只提了 commentDensity，**不许**把之前的全局取值丢掉
		const after = readTeaching(tmp)
		ok(after.global.values?.params?.explainOrder === 'detail-first', '改圆圈参数不会动到全局层的取值')
		const reset = await tool.execute({ op: 'write', circle: 'programming', params: { commentDensity: null }, confirm: true, root: tmp })
		ok(reset.ok === true && !('commentDensity' in reset.record.params), 'params 给 null = 显式落回档位默认')
	}

	// ── ⑩ 真包一字未动 ──
	ok(hashTree(path.join(ROOT, 'learning-records')) === realBefore, '真包 learning-records/ 一字未动')
	// ⚠️ 这条原先写的是"真包上**没有** teaching.jsonl" —— 那是在真包还是空的时候写的。
	//    P2 给 programming 落了 spec + guide 之后它就**必红**，而它想判的其实是"本套件没往真包写"。
	//    改成比**内容**：有台账就比逐字节，没有就比"还是没有"（两种都成立，判据不再绑在外部状态上）。
	ok(!fs.existsSync(teachingPath(ROOT)) || hashTree(path.join(ROOT, 'learning-records')) === realBefore,
		`真包台账跑完之后与跑之前逐字节相同（${fs.existsSync(teachingPath(ROOT)) ? '有台账：比内容' : '没台账：比不存在'}）`)
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 按圆圈分节 · 全局学科中立 · 特化数据驱动（spec 带指令句）· 不串圈 · append-only 无时间戳 · propose 不写盘 / write 要点头')
