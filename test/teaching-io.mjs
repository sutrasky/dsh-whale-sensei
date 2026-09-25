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
	FREE_TEXT_MAX, FREE_TEXT_MAX_CHARS, teachingPath, subjectsHit,
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
		const pairs = d.entries.map((e) => `${e.circle}/${e.kind ?? 'values'}`).sort()
		ok(pairs.join(' ') === '*/values judge-circle/spec programming/spec programming/values',
			`台账就这四条（${pairs.join(' ')}）—— 被拒的都没落盘`)
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
		fs.appendFileSync(file, '这不是合法JSON{{{]\n', 'utf8')
		const r = readTeaching(tmp)
		ok(r.problems.some((p) => /解析失败/.test(p)) && r.entries.length === 4, '坏行进 problems、不抛、不静默丢')
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
	ok(!fs.existsSync(teachingPath(ROOT)), '真包上没有被创建 teaching.jsonl')
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 按圆圈分节 · 全局学科中立 · 特化数据驱动（spec 带指令句）· 不串圈 · append-only 无时间戳 · propose 不写盘 / write 要点头')
