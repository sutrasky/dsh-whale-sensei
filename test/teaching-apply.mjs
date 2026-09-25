/**
 * teaching-apply.mjs —— 教学参数的**一处注入** + **每个参数一条生效判据**（丁2）
 * ==================================================================
 * 设计建议 3 / 4（`_board/01-鲸师.md:288-289`）：
 *   ③ 唯一真源 + **一处注入**：只发生在"生成教学内容"那一段，**别塞进全局 persona**；
 *   ④ **每个参数配一条生效判据** —— 把"教学风格"变成能验的东西。
 *
 * 覆盖面：
 *   ① 注入文本**唯一生成处**：同参数逐字节相同；参数改了文本真变；
 *   ② 只注入在 `whale_author` 的生成话术里（源码级：别的模块不许拼第二份）；
 *   ③ 内容侧判据**真的咬得住**（反空转：删掉一条注释 → 当场红）；
 *   ④ 判不了的如实说"没有机械判据"（`ok:null`）—— **不许拿"没判"冒充"判过了"**；
 *   ⑤ 真包一字未动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
	injectionBlock, teachingDirectives, directiveFor, judgeTeachingContent, judgeTeachingInjection, judgeTeaching,
	INJECTION_TITLE, DIM_MARKERS,
} from '../lib/teaching-apply.js'
import { defaultsFor, TEACHING_PARAMS, teachingPath } from '../lib/teaching-io.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
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

console.log(`\n[teaching-apply] 课程包：${ROOT}`)
const realBefore = hashTree(path.join(ROOT, 'learning-records'))

// ── ① 注入文本：唯一生成处 + 确定性 ──
{
	const def = injectionBlock(null)
	ok(def.tier === 1 && def.directives.length === Object.keys(TEACHING_PARAMS).length,
		`全默认也能拼出注入块（tier ${def.tier}，${def.directives.length} 条指令）`)
	ok(def.block.includes(INJECTION_TITLE) && def.block.split('\n').length === def.directives.length + 1,
		'注入块 = 标题 + 每条参数一行（没有多余散文）')
	ok(injectionBlock(null).block === def.block, '同一份参数 → 注入块**逐字节相同**（确定性）')

	const changed = injectionBlock({ tier: 4, params: { commentDensity: 'key', errorStyle: 'fix-first' } })
	ok(changed.block !== def.block, '参数改了 → 注入文本**真变**')
	ok(changed.block.includes('只在**关键行**加注释') && changed.block.includes('直接给修法'),
		'变的是对应那两条（注释密度 / 报错），不是整块重写')
	ok(changed.tier === 4 && changed.block.includes('tier 4'), '档位也进注入块（默认值随档位变的可见证据）')

	// 每个参数都必须有一句指令 —— 没有指令 = 这个参数"注入了但看不见"
	const noDirective = Object.keys(TEACHING_PARAMS).filter((id) => !directiveFor(id, defaultsFor(1)[id]))
	ok(noDirective.length === 0, `每个参数都有指令句（缺指令的：${noDirective.join(' / ') || '无'}）`)
	// 二元参数的**两个方向**都要有句子（否则"关掉"在注入里没痕迹，判据也证明不了它生效）
	ok(directiveFor('termPairing', 'on') !== directiveFor('termPairing', 'off'), '二元参数两个方向各有一句（关掉也看得见）')
	ok(teachingDirectives(defaultsFor(1)).length === Object.keys(TEACHING_PARAMS).length, 'teachingDirectives 顺序 = 参数表顺序')
}

// ── ② 一处注入：源码级证明"没塞进 persona / 别处没拼第二份" ──
{
	const modsDir = path.join(ROOT, '..', 'dsh-whale-sensei', 'lib')
	const libDir = fs.existsSync(modsDir) ? modsDir : path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'lib')
	const hits = []
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) { walk(path.join(dir, e.name)); continue }
			if (!e.name.endsWith('.js')) continue
			const t = fs.readFileSync(path.join(dir, e.name), 'utf8')
			if (/injectionBlock\(/.test(t) || /teachingDirectives\(/.test(t)) hits.push(e.name)
		}
	}
	walk(libDir)
	ok(hits.sort().join(',') === 'author.js,teaching-apply.js',
		`注入只发生在生成那一段（引用注入器的文件：${hits.join(' / ')}）—— 没塞进 persona / 没别处拼第二份`)
}

// ── ③ 内容侧判据：逐行 / 逐块 / 只关键行 ──
{
	const lineOk = `<pre>\n// 做：返回问候\nconst a = 1\n// 做：返回 a\nreturn a\n</pre>`
	const r1 = judgeTeachingContent(lineOk, { commentDensity: 'line' })
	ok(r1[0].ok === true, `逐行：每行都有注释 → 过（${r1[0].detail}）`)

	// 反空转：删掉一条注释 → 必须红，且点名那一行
	const lineBad = `<pre>\n// 做：返回问候\nconst a = 1\nreturn a\n</pre>`
	const r2 = judgeTeachingContent(lineBad, { commentDensity: 'line' })
	ok(r2[0].ok === false && /return a/.test(r2[0].detail), `逐行：少一条注释 → 红且点名（${r2[0].detail}）`)

	const blockOk = `<pre>\n// 这一段在算总数\nconst a = 1\nreturn a\n</pre>`
	ok(judgeTeachingContent(blockOk, { commentDensity: 'block' })[0].ok === true, '逐块：块内有注释 → 过')
	const blockBad = `<pre>\nconst a = 1\nreturn a\n</pre>`
	ok(judgeTeachingContent(blockBad, { commentDensity: 'block' })[0].ok === false, '逐块：整块没注释 → 红')

	const keyRes = judgeTeachingContent(blockOk, { commentDensity: 'key' })[0]
	ok(keyRes.ok === null && /没有机械判据/.test(keyRes.detail),
		`「只关键行」如实报**没有机械判据**（ok=${keyRes.ok}）—— 不许拿"没判"冒充"判过了"`)
	ok(judgeTeachingContent('<p>没有代码块</p>', { commentDensity: 'line' })[0].ok === null, '没有代码块 → 这条判不了，如实 null')
}

// ── ④ 内容侧判据：四维（启发式）──
{
	const four = `<pre>\n// 做了什么：返回问候\n// 和谁联动：被 TaskController 调用\n// 对应需求：验收第 2 条\n// 为什么：避免每次都重建\nconst a = 1\n</pre>`
	const r = judgeTeachingContent(four, { commentDims: ['what', 'link', 'req', 'why'] })
	ok(r[0].ok === true, `四维齐全 → 过（${r[0].detail}）`)

	const missingWhy = `<pre>\n// 做了什么：返回问候\n// 和谁联动：被调用\n// 对应需求：验收第 2 条\nconst a = 1\n</pre>`
	const r2 = judgeTeachingContent(missingWhy, { commentDims: ['what', 'link', 'req', 'why'] })
	ok(r2[0].ok === false && /why/.test(r2[0].detail), `缺「为什么」→ 红且点名（${r2[0].detail}）`)

	// 只开两维时，另两维不参与判（关掉的维度不该被判红）
	const twoOnly = judgeTeachingContent(missingWhy, { commentDims: ['what', 'link'] })
	ok(twoOnly[0].ok === true, '只开两维 → 只判那两维（关掉的维度不参与，不会假红）')
	ok(Object.keys(DIM_MARKERS).length === 4, '四维标记词表齐全（what / link / req / why）')
}

// ── ⑤ 注入侧判据 + 汇总 ──
{
	const inj = injectionBlock(null)
	const good = judgeTeachingInjection(inj.block, inj.params)
	ok(good[0].ok === true, `注入齐全 → 过（${good[0].detail}）`)
	const bad = judgeTeachingInjection(inj.block.replace(inj.directives[0], ''), inj.params)
	ok(bad[0].ok === false && /缺 1 条/.test(bad[0].detail), `缺一条指令 → 红（${bad[0].detail}）`)

	const custom = { ...defaultsFor(1), commentDims: ['what'] }   // 只开一维，fixture 好写
	const cInj = injectionBlock({ tier: 1, params: custom })
	const htmlGood = '<pre>\n// 返回 x\nconst a = 1\n</pre>'      // 代码行上一行有注释，且命中 what（返回）
	const htmlBad = '<pre>\nconst a = 1\n</pre>'
	const sum = judgeTeaching({ html: htmlGood, injection: cInj.block, params: cInj.params })
	ok(sum.ok === true && sum.failed.length === 0, `汇总：两条判据都过（checks ${sum.checks.length} 条）`)
	const sum2 = judgeTeaching({ html: htmlBad, injection: cInj.block, params: cInj.params })
	ok(sum2.ok === false && sum2.failed.includes('commentDensity'), '汇总：内容判据红了就整体红（不掩盖）')
	// 「判不了的」要单独列：注入块按 key 档重建，才谈得上"注入本身是齐的、只是内容判不了"
	const keyInj = injectionBlock({ tier: 1, params: { ...custom, commentDensity: 'key' } })
	const sum3 = judgeTeaching({ html: htmlGood, injection: keyInj.block, params: keyInj.params })
	ok(sum3.ok === true && sum3.unjudged.includes('commentDensity'), '汇总把"判不了的"单独列出来（unjudged），不当成过也不当成错')
}

// ── ⑥ 真跑 whale_author：注入块出现在生成话术里 ──
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-apply-'))
	try {
		fs.cpSync(ROOT, tmp, { recursive: true })
		fs.rmSync(teachingPath(tmp), { force: true })
		// 落一版学生改过的参数（只改注释密度）
		const { recordTeaching } = await import('../lib/teaching-io.js')
		recordTeaching(tmp, { tier: 2, params: { commentDensity: 'block' }, source: 'student' })

		const tools = []
		const fakeLog = { info: () => {}, warn: () => {}, error: () => {} }
		authorPlugin.install({ paths: { packRoot: tmp }, log: fakeLog, registerTool: (d) => tools.push(d) })
		const tool = tools[tools.length - 1]
		const v = await tool.execute({ point: 'spring-boot', number: 9, title: '教学参数冒烟课', slug: 'teaching-smoke', hintTerm: 'bean', source: { label: 'Spring 官方', url: 'https://spring.io' }, root: tmp })
		ok(v.teaching && typeof v.teaching.block === 'string', 'whale_author 回执里带上了注入块（teaching.block）')
		ok(v.teaching.params.commentDensity === 'block' && v.teaching.tier === 2, '注入用的是台账里的现行参数（学生改过的 block + tier 2）')
		const rendered = tool.output.render({}, v).map((x) => x.text).join('\n')
		ok(rendered.includes(INJECTION_TITLE), '注入块**真的进了 agent 读到的那段话术**（不是只躺在返回值里）')
		ok(!fs.existsSync(teachingPath(ROOT)), '真包上没有被创建 teaching.jsonl')
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

// ── ⑦ 真包一字未动 ──
ok(hashTree(path.join(ROOT, 'learning-records')) === realBefore, '真包 learning-records/ 一字未动')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 一处注入（只在这段）· 每个参数一条判据 · 判不了的如实 null · 反空转删字即红')
