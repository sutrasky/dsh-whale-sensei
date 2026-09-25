/**
 * teaching-view.mjs —— 设置页「教学方式」的判据（只读视图 + 「跟老师说」正文）
 * ==================================================================
 * 主人 2026-09-25 定的形态：**每个圆圈的参数都能在设置里对 agent 说** ——
 * 学生说出自己的要求 → agent 按那个圆圈的可调项改参数 → **改完给他看**。
 *
 * 这一套判的是**设置页那一半**（`lib/teaching-view.js`，纯函数，离线跑）：
 *   ① 视图把**课程包里每一个圆圈**都列出来 —— 台账里一条记录都没有的也要列
 *      （学生正是要对"还没定过教学方式"的圆圈提要求）；
 *   ② 台账里有、课程包里已经没有的圆圈**也列**（`orphan`），不静默丢；
 *   ③ `from` 的语义：这一层自己定的 / 继承全局层 / 还没定过 —— **不许把全局取值
 *      渲染成圆圈的特化**（P1 修过的坑，这里钉一条反空转判据）；
 *   ④ **注入原文与 `injectionBlock` 逐字节同源** —— 学生看到的必须就是老师收到的那段；
 *   ⑤ 参数改了就变、没改就逐字节相同（反空转）；
 *   ⑥ `requestText`：带齐圆圈 / 学生原话逐字 / 现行参数 / 节奏 / 锁死集；空与超长**拒发**
 *      （超长**不截断** —— 截断会把学生的意思改掉）；
 *   ⑦ **只读**：这一层没有任何写盘路径；
 *   ⑧ **学科中立**：整个源文件命中学科数 ≠ 1（禁词表，主人 2026-09-25 裁定）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readTeaching, recordTeaching, GLOBAL_CIRCLE, TEACHING_DISCIPLINE, subjectsHit } from '../lib/teaching-io.js'
import { injectionBlock } from '../lib/teaching-apply.js'
import { teachingView, requestText, REQUEST_MAX_CHARS, TEACHING_VIEW_SCHEMA } from '../lib/teaching-view.js'
import { readPack } from '../lib/pack-model.js'
import { packRoot } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const ROOT = packRoot()

let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tview-'))
// 真包基线：判据只在副本上跑，跑完真包必须**逐字节未变**。
// ⚠️ 原先这条写的是"真包上没有 teaching.jsonl" —— P2 给 programming 落了 spec + guide 之后
//    它就必红，而它想判的是"本套件没往真包写"。改成比内容（见 teaching-io.mjs ⑩）。
const REAL_LEDGER = path.join(ROOT, 'learning-records', 'teaching.jsonl')
const realBefore = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null
try {
	fs.cpSync(ROOT, tmp, { recursive: true })
	const ledger = path.join(tmp, 'learning-records', 'teaching.jsonl')
	fs.rmSync(ledger, { force: true })

	const pack = readPack(tmp)
	const listed = pack.circles.map((c) => ({ id: c.id, name: c.name || c.id }))
	const first = listed[0]?.id
	ok(Boolean(first), `课程包里有圆圈可判（${listed.map((c) => c.id).join(' / ') || '(无)'}）`)

	// ── ① 空台账：视图仍然把课程包里的圆圈**全部**列出来 ──
	{
		const view = teachingView(readTeaching(tmp), { circles: listed })
		ok(view.schema === TEACHING_VIEW_SCHEMA, `视图带 schema（${view.schema}）`)
		ok(view.global.circle === GLOBAL_CIRCLE, `全局层的 circle 是 '${GLOBAL_CIRCLE}'`)
		ok(view.locked.length === TEACHING_DISCIPLINE.length, `锁死集全在（${view.locked.map((l) => l.label).join(' / ')}）`)
		ok(view.circles.length === listed.length,
			`空台账也要列出课程包里全部 ${listed.length} 个圆圈（实得 ${view.circles.length}）`)
		ok(view.circles.every((c) => c.hasSpec === false), '空台账时每个圆圈都还没声明可调项（hasSpec=false）')
		ok(view.circles.every((c) => (c.own || []).length === 0), '空台账时没有"它自己定的"项（own 为空）')
		const rows = view.global.items.filter((r) => (r.directives || []).length > 0)
		ok(rows.length === 3 && rows.every((r) => r.from === 'default'),
			`全局三个可调项都落回档位默认（${rows.map((r) => r.id + '=' + r.from).join(' ')}）`)
		ok(view.global.tunables.every((t) => t.home === 'global'), '全局层的可调项 home 全是 global')
	}

	// ── ② 台账里有、课程包里没有的圆圈也列（orphan，不静默丢）──
	{
		const ghost = 'ghost-circle-xyz'
		const w = recordTeaching(tmp, { circle: ghost, kind: 'values', tier: 1, params: {}, source: 'student' })
		ok(w.ok === true, `先造一个"课程包里已经没有"的圆圈记录（${w.ok ? 'ok' : w.error}）`)
		const view = teachingView(readTeaching(tmp), { circles: listed })
		const hit = view.circles.find((c) => c.circle === ghost)
		ok(Boolean(hit) && hit.orphan === true, '课程包里没有的圆圈**也列**出来，并标 orphan:true（不静默丢）')
		ok(view.circles.length === listed.length + 1, `圆圈数 = 课程包 ${listed.length} + 孤儿 1`)
		// 收拾干净，后面几条判据不受它影响
		const rows = fs.readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() && !l.includes(ghost))
		fs.writeFileSync(ledger, rows.length ? rows.join('\n') + '\n' : '', 'utf8')
	}

	// ── ③ from 的语义 + 反空转：全局取值**不许**被渲染成圆圈的特化 ──
	{
		recordTeaching(tmp, { circle: GLOBAL_CIRCLE, kind: 'values', tier: 1, params: { explainOrder: 'detail-first' }, source: 'student' })
		let view = teachingView(readTeaching(tmp), { circles: listed })
		const g = view.global.items.find((r) => r.id === 'explainOrder')
		ok(g.from === 'own', '全局记录写过的项：全局层里 from=own（这一层自己定的）')
		ok(g.directives.join('').includes('先给细节'), `全局层显示的是**生效值**那句指令（${g.directives.join('')}）`)

		const c0 = view.circles.find((c) => c.circle === first)
		const c0row = c0.items.find((r) => r.id === 'explainOrder')
		ok(c0row.from === 'global', '同一项在圆圈块里是 from=global（继承来的，不是它自己定的）')
		ok((c0.own || []).length === 0, '反空转：圆圈没有自己的覆盖时 own 必须为空（别把全局取值当圆圈特化）')
		ok(c0row.directives.join('').includes('先给细节'), '但圆圈块显示的仍是**生效值**（继承结果看得见）')

		// 圆圈自己定一版 → 这一行翻成 own，且 own 有它
		recordTeaching(tmp, { circle: first, kind: 'values', tier: 1, params: { explainOrder: 'overview-first' }, source: 'student' })
		view = teachingView(readTeaching(tmp), { circles: listed })
		const c1 = view.circles.find((c) => c.circle === first)
		const c1row = c1.items.find((r) => r.id === 'explainOrder')
		ok(c1row.from === 'own', '圆圈自己写过之后：这一行翻成 from=own')
		ok(c1.own.includes('explainOrder'), `own 里出现 explainOrder（${c1.own.join('/')}）`)
		ok(c1row.directives.join('').includes('先给全貌'), '圆圈块显示圆圈自己的取值（不再显示继承来的那句）')
		ok(c1.valuesV === 1, `圆圈取值版本线从 v1 起（实得 v${c1.valuesV}）`)
	}

	// ── ④ 圆圈声明 spec 之后：可调项里出现 home=circle 的项 ──
	{
		const spec = [
			{
				id: 'figureDensity',
				label: '图示密度',
				values: [
					{ id: 'more', directive: '每个要点都配一张示意图。' },
					{ id: 'fewer', directive: '只在关键处配图。' },
				],
				defaultByTier: { 1: 'more', 2: 'more', 3: 'fewer', 4: 'fewer' },
			},
		]
		const w = recordTeaching(tmp, { circle: first, kind: 'spec', spec, source: 'agent' })
		ok(w.ok === true, `圆圈能声明自己的可调项（${w.ok ? 'ok' : w.error}）`)
		const view = teachingView(readTeaching(tmp), { circles: listed })
		const c = view.circles.find((x) => x.circle === first)
		ok(c.hasSpec === true, 'hasSpec 翻成 true')
		const tun = c.tunables.filter((t) => t.home === 'circle')
		ok(tun.length === 1 && tun[0].id === 'figureDensity', `可调项里出现圆圈自己的项（${tun.map((t) => t.id).join('/')}）`)
		ok(c.tunables.filter((t) => t.home === 'global').length === 3, '全局那三项仍在（home=global），没被圆圈项挤掉')
		const row = c.items.find((r) => r.id === 'figureDensity')
		ok(row.from === 'default' && row.directives.join('').includes('示意图'), '圆圈声明的项还没定取值 → 显示档位默认那句')
		ok(c.own.includes('explainOrder') && !c.own.includes('figureDensity'), 'own 只列**定过取值的**项（声明可调项 ≠ 定过值）')
	}

	// ── ④b 圆圈的**固定做法**（`kind=guide`）也进视图与注入原文（P2 加的）──
	{
		const guide = [
			{ title: '动笔前先看他的产出', lines: ['列源码树，忽略构建产物与编辑器噪音。', '找五类信号，逐个如实报。'] },
		]
		const w = recordTeaching(tmp, { circle: first, kind: 'guide', guide, source: 'agent' })
		ok(w.ok === true, `圆圈能声明固定做法（${w.ok ? 'ok' : w.error}）`)
		const data = readTeaching(tmp)
		const view = teachingView(data, { circles: listed })
		const c = view.circles.find((x) => x.circle === first)
		ok(c.guide.length === 1 && c.guide[0].title === '动笔前先看他的产出', '视图带上了固定做法（标题）')
		ok(c.guide[0].lines.length === 2 && c.guide[0].lines[1] === '找五类信号，逐个如实报。', '固定做法的每一行都带上了')
		ok(c.guideV === 1, `固定做法有自己的版本线（v${c.guideV}）`)
		ok(c.block === injectionBlock({ data, circle: first }).block, '带固定做法之后，注入原文**仍然与 injectionBlock 逐字节同源**')
		ok(c.block.includes('动笔前先看他的产出') && c.block.includes('找五类信号，逐个如实报。'), '固定做法进了注入原文（老师真会收到）')
		ok(!(view.global.guide || []).length, '全局层没有固定做法（那是圆圈的东西）')

		// 请求正文要把固定做法念出来 —— 否则老师不知道这个圆圈已经有做法了
		const t = requestText({ circle: first, request: '讲慢一点', view })
		ok(t.includes('动笔前先看他的产出'), '「跟老师说」的正文里念出了这个圆圈的固定做法')
		ok(t.includes('kind=guide'), '正文写明"落不到可调项上时，确属固定做法才动 kind=guide"')

		// 没声明过固定做法的圆圈：正文如实说"还没有"
		const other = listed.find((x) => x.id !== first)
		if (other) {
			const t2 = requestText({ circle: other.id, request: '讲慢一点', view })
			ok(t2.includes('还没有固定做法'), '没声明过的圆圈：正文如实说"还没有固定做法"')
		} else {
			ok(true, '（课程包只有一个圆圈，跳过"没有固定做法"的判据）')
		}
	}

	// ── ⑤ 注入原文与 injectionBlock **逐字节同源** + 改了就变 / 没改逐字节相同 ──
	{
		const data = readTeaching(tmp)
		const view = teachingView(data, { circles: listed })
		const c = view.circles.find((x) => x.circle === first)
		const direct = injectionBlock({ data, circle: first }).block
		ok(c.block === direct, '圆圈块的注入原文与 injectionBlock 逐字节相同（学生看到的 = 老师收到的）')
		ok(view.global.block === injectionBlock({ data, circle: GLOBAL_CIRCLE }).block, '全局块的注入原文同源')
		ok(c.block.includes('每个要点都配一张示意图'), '注入原文里带着圆圈自己 spec 的指令句')
		ok(c.block.includes('先给全貌'), '注入原文里带着圆圈自己的取值')

		const again = teachingView(readTeaching(tmp), { circles: listed }).circles.find((x) => x.circle === first).block
		ok(again === c.block, '台账没动 → 注入原文逐字节相同（反空转）')

		// ⚠️ 一条 `values` 记录是**该层的完整取值集**，不是增量 —— 只写一项，其余就落回继承。
		//    这正是工具侧 `mergeParams()` 存在的理由（agent 走 `whale_teaching` 时会把之前的覆盖带上）。
		//    这条判据把语义钉住：谁改 `recordTeaching` 成"合并写"，这里会红。
		recordTeaching(tmp, { circle: first, kind: 'values', tier: 2, params: { figureDensity: 'fewer' }, source: 'student' })
		const dropped = teachingView(readTeaching(tmp), { circles: listed }).circles.find((x) => x.circle === first)
		ok(dropped.items.find((r) => r.id === 'explainOrder').from === 'global',
			'直接写一条只带一项的 values 记录 → 该层其余项落回**继承**（记录 = 完整取值集，不是增量）')
		ok(dropped.block.includes('只在关键处配图') && !dropped.block.includes('先给全貌'),
			'注入原文跟着变成"继承来的那句"（不是把旧覆盖偷偷留着）')

		// 把这一层该有的取值写全（= 工具侧 mergeParams 的结果）→ 注入原文才带着两层
		recordTeaching(tmp, { circle: first, kind: 'values', tier: 2, params: { figureDensity: 'fewer', explainOrder: 'overview-first' }, source: 'student' })
		const after = teachingView(readTeaching(tmp), { circles: listed }).circles.find((x) => x.circle === first).block
		ok(after !== c.block && after.includes('只在关键处配图') && after.includes('先给全貌'),
			'改了参数 → 注入原文跟着变（不是拿快照糊弄）')
	}

	// ── ⑥ requestText：带齐该带的 ──
	{
		const data = readTeaching(tmp)
		const view = teachingView(data, { circles: listed })
		const words = '讲慢一点，多给我画点图'
		const t = requestText({ circle: first, request: words, view })
		ok(t.includes(words), '学生原话**逐字**带进正文')
		ok(t.includes(`circle="${first}"`), `正文点名了是哪一层（circle="${first}"）`)
		ok(t.includes('op=read') && t.includes('op=propose') && t.includes('op=write'), '节奏三步都在（read → propose → write）')
		ok(t.includes('不写盘'), '写明 propose 不写盘')
		ok(t.includes('他点头'), '写明点头才写')
		for (const d of TEACHING_DISCIPLINE) ok(t.includes(d.label), `锁死集在正文里点名：${d.label}`)
		ok(t.includes('先给全貌'), '正文里带现行参数（老师不用自己猜现在是什么）')

		const g = requestText({ circle: GLOBAL_CIRCLE, request: '讲慢一点', view })
		ok(g.includes('全局层'), '全局层的正文写明改的是全局层')
		ok(!g.includes('还没声明过可调项'), '全局层不该提"圆圈还没声明可调项"')

		// 没有 spec 的圆圈 → 正文提示先声明
		const other = listed.find((c) => c.id !== first)?.id
		if (other) {
			const o = requestText({ circle: other, request: '换个教法', view })
			ok(o.includes('还没声明过可调项'), '圆圈没声明 spec → 正文提示"先声明再写取值"')
		} else {
			ok(true, '（课程包只有一个圆圈，跳过"没声明 spec"的判据）')
		}

		// 拿不到视图也不能崩（少一段现状，正文仍可用）
		const bare = requestText({ circle: first, request: '讲慢一点' })
		ok(bare.includes('讲慢一点') && bare.includes('op=read'), '拿不到视图时仍拼得出可用正文（只是少了现状那一段）')
	}

	// ── ⑦ 拒空 / 拒超长（**不截断**）──
	{
		let e1 = null
		try { requestText({ circle: first, request: '   ' }) } catch (e) { e1 = e }
		ok(e1 !== null && /空/.test(e1.message), '空要求 → 拒发（报"没话可带"）')

		const long = '啊'.repeat(REQUEST_MAX_CHARS + 1)
		let e2 = null
		try { requestText({ circle: first, request: long }) } catch (e) { e2 = e }
		ok(e2 !== null, `超长（${REQUEST_MAX_CHARS + 1} 字）→ 拒发`)
		ok(e2 && e2.message.includes(String(REQUEST_MAX_CHARS + 1)), '拒发时说出**实际字数**（不是静默截断）')
		ok(e2 && !e2.message.includes(long), '拒发信息里不塞整段超长原文')

		const edge = requestText({ circle: first, request: '啊'.repeat(REQUEST_MAX_CHARS) })
		ok(edge.includes('啊'.repeat(REQUEST_MAX_CHARS)), `正好 ${REQUEST_MAX_CHARS} 字 → 放行（边界值不误伤）`)
	}

	// ── ⑧ 只读 + 学科中立（源码级）──
	{
		// 扫**代码**而不是注释：这个文件的头注里就写着"落盘只有 recordTeaching 一个口"，
		// 拿整份原文做正则会把注释里的名字当违规（实测踩过）。
		const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
		const src = strip(fs.readFileSync(path.join(PLUGIN, 'lib', 'teaching-view.js'), 'utf8'))
		ok(!/recordTeaching|writeFileSync|appendFileSync|mkdirSync|fs\.rm|fs\.write/.test(src),
			'这一层**没有任何写盘路径**（落盘口只有 recordTeaching 一处，agent 走它）')
		ok(!/from '\.\/teaching-io\.js'/.test(src) || !/recordTeaching/.test(src), '也没从 teaching-io 引写口进来')
		const hit = subjectsHit(fs.readFileSync(path.join(PLUGIN, 'lib', 'teaching-view.js'), 'utf8'))
		ok(hit.length !== 1, `禁词表 · lib/teaching-view.js：不是只对一个学科成立（命中 ${hit.length} 个：${hit.join('/') || '无'}）`)

		const client = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
		ok(client.includes('/api/whale/teaching/request'), '设置页点的是宿主那条「拼正文」路由（不在浏览器半边拼话术）')
		ok(/发给老师/.test(client), '设置页有「发给老师」这个入口')
		ok(/教学方式/.test(client) && /注入原文|实际会收到这一段/.test(client), '设置页显示「现行取值 + 注入原文」')
	}

	const realAfter = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null
	ok(realAfter === realBefore,
		`真包台账跑完之后与跑之前逐字相同（${realBefore === null ? '两边都没有' : '两边都有，比内容'}）`)
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }
console.log('✅ 视图列出全部圆圈 · from 不串台 · 注入原文逐字节同源 · 正文带齐节奏与锁死集 · 只读 · 学科中立')
