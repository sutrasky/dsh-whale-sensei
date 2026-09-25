/**
 * teaching-io.mjs —— 教学参数（`learning-records/teaching.jsonl` + `whale_teaching`）
 * ==================================================================
 * 主人的要求（`_board/01-鲸师.md:278-280`）：学生可以按自己接受到的教学提要求，
 * agent 据此改**可调项** —— 不是通用解，最终进提示词。
 *
 * 覆盖面（每条对着一个设计建议，`01:286-292`）：
 *   ① **可枚举 + 默认值随档位**（建议 1 / 7）：四档都有默认值，缺一档就红；
 *   ② **可调集**：取值域拦得住；多值项非空、去重、**顺序钉死**（同输入同字节）；
 *   ③ **锁死集**（建议 2）：写教学纪律 → **拒写并点名**（学生说改也不改）；
 *   ④ **上限 + 合并**（建议 6）：自由补充 5 条 × 40 字，超了拒写 + 提示合并，不静默丢；
 *   ⑤ append-only：v / replaces 由台账算，不覆盖旧版；**绝不写时间字段**；键序钉死；
 *   ⑥ 读侧容错：坏行进 problems 不抛、不静默丢；文件不存在 = 正常空态；
 *   ⑦ 工具面：read / propose（预览不写盘）/ write（**必须 confirm:true**）；
 *   ⑧ 真包一字未动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { plugin as teachingPlugin } from '../lib/mods/teaching.js'
import {
	readTeaching, recordTeaching, resolveParams, defaultsFor, validateTeaching,
	TEACHING_KEYS, TEACHING_PARAMS, TEACHING_DISCIPLINE, FREE_TEXT_MAX, FREE_TEXT_MAX_CHARS, teachingPath,
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

	// ── ① 可枚举 + 默认值随档位（四档缺一档就红）──
	ok(tool?.name === 'whale_teaching', 'whale_teaching 装得上')
	{
		let complete = true
		for (const [id, def] of Object.entries(TEACHING_PARAMS)) {
			for (const t of TIERS) if (def.defaultByTier[t] === undefined) complete = false
			if (!def.values.length) complete = false
		}
		ok(complete, `每个参数在 1/2/3/4 四档都有默认值、且取值域非空（${Object.keys(TEACHING_PARAMS).length} 个参数）`)
		ok(defaultsFor(1).commentDensity === 'line' && defaultsFor(3).commentDensity === 'block' && defaultsFor(4).commentDensity === 'key',
			'注释密度随档位变（tier1/2 逐行 · tier3 逐块 · tier4 只关键行）')
		ok(JSON.stringify(defaultsFor(1).commentDims) === JSON.stringify(['what', 'link', 'req', 'why']),
			'多值项默认全开（做了什么 + 和谁联动 + 对应哪条需求 + 为什么这么设计）')
		ok(defaultsFor(3).commentDensity === defaultsFor(2).commentDensity || defaultsFor(1).commentDensity === defaultsFor(2).commentDensity,
			'相邻档位可以同值（默认值是**查表**得来的，不是按 tier 现算的）')
	}

	// ── ② 空态 + 工具 read ──
	{
		const empty = await tool.execute({ op: 'read', root: tmp })
		ok(empty.ok === true && empty.version === null, '空台账：read 回 version=null、不炸')
		ok(empty.current.tier === 1 && empty.current.params.commentDensity === 'line', '空台账 → 全部落回 tier 1 默认')
		ok(empty.discipline.length === 3, `锁死集在 read 里明示（${empty.discipline.map((d) => d.label).join(' / ')}）`)
		ok(!fs.existsSync(teachingPath(tmp)), 'read 不写盘')
	}

	// ── ③ 可调集：取值域拦得住 + 多值项顺序钉死 ──
	{
		const bad = recordTeaching(tmp, { tier: 2, params: { commentDensity: 'verbose' }, source: 'student' })
		ok(bad.ok === false && /取值不认识/.test(bad.error), `取值域外的值拒写（${bad.error}）`)
		const bad2 = recordTeaching(tmp, { tier: 2, params: { commentDims: [] }, source: 'student' })
		ok(bad2.ok === false && /非空数组/.test(bad2.error), `多值项给空数组拒写（${bad2.error}）`)
		const r1 = recordTeaching(tmp, { tier: 2, params: { commentDims: ['why', 'what'] }, source: 'student' })
		ok(r1.ok === true, '合法多值写入成功')
		ok(JSON.stringify(r1.record.params.commentDims) === JSON.stringify(['what', 'why']),
			`多值项**顺序钉死**成参数表顺序（写 ['why','what'] 落盘是 ${JSON.stringify(r1.record.params.commentDims)}）`)
		ok(Object.keys(r1.record).join(',') === TEACHING_KEYS.join(','), '键序钉死（落盘顺序 == TEACHING_KEYS）')
	}

	// ── ④ 锁死集：写教学纪律 → 拒写并点名 ──
	{
		const locked = TEACHING_DISCIPLINE[0]
		const r = recordTeaching(tmp, { tier: 2, params: { [locked.id]: false }, source: 'student' })
		ok(r.ok === false && /教学纪律/.test(r.error) && r.error.includes(locked.id),
			`写「${locked.label}」→ 拒写并点名是教学纪律（${r.error}）`)
		const before = fs.readFileSync(teachingPath(tmp), 'utf8')
		ok(!before.includes(locked.id), '被拒的那一版一个字节都没落盘')
	}

	// ── ⑤ 上限 + 合并（自由补充 5 × 40）──
	{
		const many = Array.from({ length: FREE_TEXT_MAX + 1 }, (_, i) => `偏好${i + 1}`)
		const r = recordTeaching(tmp, { tier: 2, freeText: many, source: 'student' })
		ok(r.ok === false && /上限 5 条/.test(r.error) && /合并/.test(r.error), `超 ${FREE_TEXT_MAX} 条拒写 + 提示合并（${r.error}）`)
		const long = '这是一句很长的偏好'.repeat(10).slice(0, FREE_TEXT_MAX_CHARS + 1)
		const r2 = recordTeaching(tmp, { tier: 2, freeText: [{ text: long, confirmed: true }], source: 'student' })
		ok(r2.ok === false && /单条上限/.test(r2.error), `单条超 ${FREE_TEXT_MAX_CHARS} 字拒写（${r2.error}）`)
		const r3 = recordTeaching(tmp, { tier: 2, freeText: [{ text: '没点头', confirmed: false }], source: 'student' })
		ok(r3.ok === false && /点头才写/.test(r3.error), '没 confirmed:true → 拒写（写入闸 = 确认制）')
		const r4 = recordTeaching(tmp, { tier: 2, freeText: [{ text: '别先给定义，先给例子', confirmed: true }], source: 'student' })
		ok(r4.ok === true && r4.record.freeText[0].confirmed === true, '合规自由补充写入（confirmed 记成 true）')
	}

	// ── ⑥ append-only：v / replaces 由台账算；无时间戳 ──
	{
		const { entries, latest } = readTeaching(tmp)
		ok(entries.length === 2 && latest.v === 2, `append-only：台账 ${entries.length} 行，最新 v${latest.v}`)
		ok(latest.replaces === 1, 'replaces = 被取代的那一版（1）')
		const dup = recordTeaching(tmp, { v: 99, tier: 2, params: { termPairing: 'off' }, source: 'student' })
		ok(dup.ok === false && /v 由台账算出/.test(dup.error), `显式 v 与台账不符 → 拒写（${dup.error}）`)
		const text = fs.readFileSync(teachingPath(tmp), 'utf8')
		ok(!/\d{4}-\d{2}-\d{2}T/.test(text) && !/"ts"|"createdAt"|"date"/.test(text), '**绝不写时间字段**（与 goals.jsonl 同一条纪律）')
		ok(text.split('\n').filter(Boolean).every((l) => JSON.parse(l).schema === 'whale-teaching/1'), '每行都带 schema')
	}

	// ── ⑦ 生效值 = 档位默认 ⊕ 覆盖 ──
	{
		const { entries, latest } = readTeaching(tmp)
		const cur = resolveParams(latest)
		ok(cur.params.termPairing === 'on' && !cur.overridden.includes('termPairing'), '没写过的项落回档位默认（不是"没有值"）')
		const v1 = resolveParams(entries[0])
		ok(v1.params.commentDims.length === 2 && v1.overridden.includes('commentDims'), 'v1 写过的项生效并记进 overridden')
		ok(cur.overridden.length === 0, '最新一版没提 params ⇒ 生效值全落回默认（**最新一条是全部真相**，append-only 的读法）')
		const t4 = resolveParams({ tier: 4, params: {} })
		ok(t4.params.commentDensity === 'key', '换档位 = 默认值跟着变（tier4 只关键行）')
	}

	// ── ⑧ 读侧容错 + 拒写回滚 ──
	{
		const file = teachingPath(tmp)
		const before = fs.readFileSync(file, 'utf8')
		fs.appendFileSync(file, '这不是合法JSON{{{]\n', 'utf8')
		const r = readTeaching(tmp)
		ok(r.problems.some((p) => /解析失败/.test(p)) && r.entries.length === 2, '坏行进 problems、不抛、不静默丢（合规行照读）')
		fs.writeFileSync(file, before, 'utf8')
		const bad = recordTeaching(tmp, { tier: 9, params: {}, source: 'student' })
		ok(bad.ok === false && /tier/.test(bad.error), `坏 tier 拒写（${bad.error}）`)
		ok(fs.readFileSync(file, 'utf8') === before, '拒写在 append 之前 ⇒ 文件逐字节未变（回滚判据）')
	}

	// ── ⑨ 工具面：propose 预览不写盘 / write 要 confirm ──
	{
		const file = teachingPath(tmp)
		const before = fs.readFileSync(file, 'utf8')
		const prop = await tool.execute({ op: 'propose', params: { commentDensity: 'block' }, freeText: ['例子多一点'], root: tmp })
		ok(prop.ok === true && typeof prop.previewLine === 'string' && prop.previewLine.includes('whale-teaching/1'),
			'propose 回一份"会落盘的那一行"预览')
		ok(fs.readFileSync(file, 'utf8') === before, 'propose **不写盘**')
		ok(prop.current.params.commentDensity === 'block', 'propose 顺带回"改完会长什么样"（生效值）')

		const noConfirm = await tool.execute({ op: 'write', params: { commentDensity: 'block' }, root: tmp })
		ok(noConfirm.ok === false && /confirm:true/.test(noConfirm.error), `write 没 confirm → 拒写（${noConfirm.error}）`)
		ok(fs.readFileSync(file, 'utf8') === before, '没点头的那次也没写盘')

		const wrote = await tool.execute({ op: 'write', params: { commentDensity: 'block' }, freeText: ['例子多一点'], confirm: true, root: tmp })
		ok(wrote.ok === true && wrote.teachingSaved === true && wrote.record.v === 3, `confirm:true → 落盘 v${wrote.record?.v}`)
		const after = readTeaching(tmp).latest
		ok(after.params.commentDensity === 'block' && after.freeText[0].text === '例子多一点', '落盘内容与 propose 预览同形')
		// ⚠️ 累积合并：这一版只提了 commentDensity，**不许**把 v1 调过的 commentDims 静默丢掉
		ok(JSON.stringify(after.params.commentDims) === JSON.stringify(['what', 'why']),
			`只改一个参数不会把别的覆盖丢掉（commentDims 仍是 ${JSON.stringify(after.params.commentDims)}）`)
		// 显式重置：params 里给 null = 落回档位默认（取消覆盖的唯一出口）
		const reset = await tool.execute({ op: 'write', params: { commentDims: null }, confirm: true, root: tmp })
		ok(reset.ok === true && !('commentDims' in reset.record.params),
			`params 给 null = 显式落回默认（v${reset.record?.v} 里不再有 commentDims）`)

		const badKey = await tool.execute({ op: 'write', params: { readStudentCodeFirst: false }, confirm: true, root: tmp })
		ok(badKey.ok === false && /教学纪律/.test(badKey.error), '工具面也拦得住教学纪律（不是只有底层拦）')
		let threw = ''
		try { validateTeaching({ tier: 2, params: { nope: 1 } }, { strict: true }) } catch (e) { threw = e.message }
		ok(/多余键/.test(threw), `validateTeaching 对多余键抛错（${threw}）`)
	}

	// ── ⑩ 真包一字未动 ──
	ok(hashTree(path.join(ROOT, 'learning-records')) === realBefore, '真包 learning-records/ 一字未动')
	ok(!fs.existsSync(teachingPath(ROOT)), '真包上没有被创建 teaching.jsonl（全部动作都在拷贝里）')
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 可枚举 + 档位默认 · 可调集拦得住 · 教学纪律锁死 · 上限拒写提示合并 · append-only 无时间戳 · propose 不写盘 / write 要点头')
