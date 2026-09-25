/**
 * teaching-apply.mjs —— 教学参数的**一处注入** + **生效判据**（丁2 / P1 后）
 * ==================================================================
 * 2026-09-25 主人裁定后，这一层的两条硬约束：
 *   ① **代码里不许有学科知识** —— 指令句一律来自台账的 `spec`（每个取值自带 `directive`）；
 *   ② **按圆圈取** —— 注入 = 全局层（学科中立）⊕ **该圆圈**的特化；教编程与教数学走同一条缝。
 *
 * 覆盖面：
 *   ① 注入块**数据驱动**：spec 里的指令句出现在块里；改 spec/取值 → 文本真变；同输入逐字节相同；
 *   ② **代码里没有学科词**（源码级：`teaching-apply.js` 命中学科数必须是 0）；
 *   ③ 一处注入：只有 `whale_author` 引用注入器（源码级）；
 *   ④ 判据：注入侧咬得住；内容侧**只判圆圈声明过的**，没实现就如实 `ok:null`（不假装判过）；
 *   ⑤ 真包一字未动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
	injectionBlock, teachingDirectives, directiveFor, judgeTeachingContent, judgeTeachingInjection, judgeTeaching,
	INJECTION_TITLE, JUDGES,
} from '../lib/teaching-apply.js'
import { subjectsHit, readTeaching, recordTeaching, teachingPath, GLOBAL_CIRCLE, globalSpec } from '../lib/teaching-io.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
import { packRoot } from './_pack.mjs'

const ROOT = packRoot()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
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

console.log(`\n[teaching-apply] 课程包：${ROOT}`)
const realBefore = hashTree(path.join(ROOT, 'learning-records'))

/** 一个**圆圈自己的** spec（编程圈的注释密度 —— 它是**数据**，不是代码） */
const SPEC = [
	{ id: 'commentDensity', label: '注释密度', values: [{ id: 'line', directive: '逐行加注释。' }, { id: 'block', directive: '按块加注释。' }, { id: 'key', directive: '只在关键行加注释。' }], defaultByTier: { 1: 'line', 2: 'line', 3: 'block', 4: 'key' } },
]

// ── ① 注入块：数据驱动 + 确定性 ──
{
	const def = injectionBlock({ tier: 1, params: {} })
	ok(def.directives.length === globalSpec().length, `空参数也能拼出全局指令（${def.directives.length} 条）`)
	ok(def.block.includes(INJECTION_TITLE), '注入块有标题')
	ok(injectionBlock({ tier: 1, params: {} }).block === def.block, '同一份参数 → 注入块**逐字节相同**')

	const withSpec = injectionBlock({ tier: 2, params: { commentDensity: 'block', explainOrder: 'detail-first' }, spec: SPEC })
	ok(withSpec.block.includes('按块加注释。'), '**圆圈 spec 里的指令句**出现在注入块里（代码里没有这句话）')
	ok(withSpec.block.includes('先给细节'), '全局取值的指令句也在（两层叠一起）')
	ok(withSpec.block !== def.block, '参数改了 → 注入文本**真变**')
	ok(withSpec.directives.length === globalSpec().length + 1, '指令数 = 全局 + 该圆圈的项数')
	ok(directiveFor(SPEC[0], 'key') === '只在关键行加注释。', 'directiveFor 从数据里取句子')
	ok(directiveFor(SPEC[0], 'nope') === null, '取不到就返回 null（**不编一句话**）')
	ok(!withSpec.block.includes('代码里**逐行**'), '注入里**没有**任何硬编码话术（那句话现在只可能来自 spec）')
}

// ── ② 代码里没有学科知识（源码级）──
{
	const files = ['lib/teaching-apply.js', 'lib/teaching-io.js']
	const hits = []
	for (const f of files) {
		const src = fs.readFileSync(path.join(PLUGIN, f), 'utf8')
		// 只扫**代码行**：
		//   · 注释块里保留主人的原话引用与清理清单指针 —— 那是出处，不是规则；
		//   · `SUBJECT_WORDS` 那一块是**判据自己的词表**（禁词表），不是教学内容。
		let code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
		code = code.replace(/export const SUBJECT_WORDS[\s\S]*?\n\}\)\n/, '\n')
		const n = subjectsHit(code)
		// 与 `subjectsHit` 的判法一致：**恰好一个**学科 = 特化（红）；≥2 个 = 跨学科举例（放行）
		if (n.length === 1) hits.push(`${f}: ${n.join(',')}`)
	}
	ok(hits.length === 0, `教学层代码里**没有学科特化**（学科知识全是数据）${hits.length ? ' —— 实得：' + hits.join(' / ') : ''}`)
	ok(Object.keys(JUDGES).length === 0, '插件**不自带任何学科判据**（JUDGES 是空表，谁声明谁给实现）')
}

// ── ③ 一处注入：源码级证明"没塞进 persona / 别处没拼第二份" ──
{
	const hits = []
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) { walk(path.join(dir, e.name)); continue }
			if (!e.name.endsWith('.js')) continue
			const t = fs.readFileSync(path.join(dir, e.name), 'utf8')
			if (/injectionBlock\(|teachingDirectives\(/.test(t)) hits.push(e.name)
		}
	}
	walk(path.join(PLUGIN, 'lib'))
	ok(hits.sort().join(',') === 'author.js,teaching-apply.js',
		`注入只发生在生成那一段（引用注入器的文件：${hits.join(' / ')}）`)
}

// ── ④ 判据 ──
{
	const inj = injectionBlock({ tier: 1, params: {}, spec: SPEC })
	const good = judgeTeachingInjection(inj.block, inj.params, SPEC)
	ok(good[0].ok === true, `注入齐全 → 过（${good[0].detail}）`)
	const bad = judgeTeachingInjection(inj.block.replace(inj.directives[0], ''), inj.params, SPEC)
	ok(bad[0].ok === false && /缺 1 条/.test(bad[0].detail), `缺一条指令 → 红（${bad[0].detail}）`)

	// 内容侧：**只判圆圈声明过的**；没声明的不判；声明了没实现也不假装判过
	const noJudge = judgeTeachingContent('<p>x</p>', {}, SPEC)
	ok(noJudge.length === 0, 'spec 没声明 judge ⇒ 内容侧**一条都不判**（不猜学科）')
	const declared = SPEC.map((s) => ({ ...s, judge: 'commentCoverage' }))
	const r = judgeTeachingContent('<pre>x</pre>', { commentDensity: 'line' }, declared)
	ok(r.length === 1 && r[0].ok === null && /没有实现/.test(r[0].detail),
		`声明了 judge 但插件没实现 ⇒ 如实 ok:null（${r[0].detail}）—— 不假装判过`)

	const sum = judgeTeaching({ injection: inj.block, html: '<p>x</p>', params: inj.params, spec: SPEC })
	ok(sum.ok === true && sum.failed.length === 0, `汇总：注入过 + 内容侧无判据（checks ${sum.checks.length} 条）`)
	const sum2 = judgeTeaching({ injection: inj.block.replace(inj.directives[0], ''), params: inj.params, spec: SPEC })
	ok(sum2.ok === false && sum2.failed.includes('injection'), '汇总：注入缺了就整体红')
	const sum3 = judgeTeaching({ injection: inj.block, html: '<p>x</p>', params: inj.params, spec: declared })
	ok(sum3.ok === true && sum3.unjudged.includes('commentDensity'), '汇总把"判不了的"单列（unjudged），不当成过也不当成错')
}

// ── ⑤ 真跑 whale_author：按**该圆圈的**特化注入 ──
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-apply-'))
	try {
		fs.cpSync(ROOT, tmp, { recursive: true })
		fs.rmSync(teachingPath(tmp), { force: true })
		recordTeaching(tmp, { circle: 'programming', kind: 'spec', spec: SPEC, source: 'agent' })
		recordTeaching(tmp, { circle: 'programming', kind: 'values', tier: 2, params: { commentDensity: 'block' }, source: 'student' })
		recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 2, params: { errorStyle: 'fix-first' }, source: 'student' })

		const tools = []
		const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }
		authorPlugin.install({ paths: { packRoot: tmp }, log: fakeLog, registerTool: (d) => tools.push(d) })
		const tool = tools[tools.length - 1]
		const v = await tool.execute({ point: 'spring-boot', number: 9, title: '教学参数冒烟课', slug: 'teaching-smoke', hintTerm: 'bean', source: { label: 'Spring 官方', url: 'https://spring.io' }, root: tmp })
		ok(v.teaching?.circle === 'programming', `注入带上了圆圈（${v.teaching?.circle}）`)
		ok(v.teaching.params.commentDensity === 'block' && v.teaching.params.errorStyle === 'fix-first', '注入用的是**该圆圈 ⊕ 全局**的生效参数')
		ok(v.teaching.block.includes('按块加注释。'), '该圆圈的指令句进了注入块')
		const rendered = tool.output.render({}, v).map((x) => x.text).join('\n')
		ok(rendered.includes(INJECTION_TITLE), '注入块**真的进了 agent 读到的那段话术**')

		// 另一个圆圈（没特化）拿不到 programming 的句子
		const data = readTeaching(tmp)
		const other = injectionBlock({ data, circle: 'math' })
		ok(!other.block.includes('按块加注释。'), '**别的圆圈拿不到 programming 的指令句**（特化不串圈）')
		ok(other.block.includes('直接给修法'), '但全局的句子对所有圆圈都生效')
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

ok(hashTree(path.join(ROOT, 'learning-records')) === realBefore, '真包 learning-records/ 一字未动')
ok(!fs.existsSync(teachingPath(ROOT)), '真包上没有被创建 teaching.jsonl')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 注入数据驱动（代码无学科词）· 一处注入 · 按圆圈取 · 判不了的如实 null · 反空转')
