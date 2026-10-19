/**
 * intake-id-resolve.mjs — **Bug5 回归**：知识点 id 的统一解析（circle/point 复合 ↔ 裸 id）
 * ==================================================================
 * 病根：catalog 给的 id 是 `programming/js-basics`（`pointKey(circle, point)`），
 *       `whale_intake` 原样存进 `learning-records/intake.jsonl` 的 `point`；
 *       而 `whale_author` 用裸 id `js-basics` 去 `latest[point]` 精确匹配 ——
 *       于是「摸底明明做了」却回一句「先做学情摸底：js-basics 还没有 intake 记录」。
 *
 * 判据（对应任务卡六条验收，全部真函数 / 真文件）：
 *   ① catalog 复合 id 摸底后 → `whale_author` 的 intake 闸**放行**（真跑工具面 execute，
 *      ok:true 且回执里没有「还没有 intake 记录」，落盘文件真的在）；真没摸底的负对照仍被拦。
 *   ② 唯一裸 id 兼容：历史裸 id 记录（`js-basics`）也能被复合 id / author 认出来。
 *   ③ 同名知识点隔离：圆圈 a 的 x 摸底不能让圆圈 b 的 x 变 done（`a/x` ≠ `b/x`，绝不串）。
 *   ④ 未知输入 / 歧义输入**明确被拒**，拒绝理由里带候选 / 合法值（不猜）。
 *   ⑤ 历史老行（`{point,level,goal}` 无 `start`）照旧 done=true，不判「没摸底」。
 *   ⑥ `whale_intake op=read` 视图不因复合 / 裸混用**丢记录**（按规范 id 合并，原始键原样带出）。
 *
 * 纪律：
 *   · 摸底写入走 `recordIntake()` 的**真实包事务写盘**（`pack-template/tools/ledger-transaction.cjs`），
 *     **不 mock**；台账一律新建在 `os.tmpdir()` 下的真目录里（不碰活包、不碰 DSH_HOME）。
 *   · 课程包是**真文件树**（`lessons/<圆圈>/halo.json` + `lessons/<圆圈>/<知识点>/point.json` +
 *     `progress.json`），用真的 `readPack()` 读回来判 —— 不是手搓对象冒充包。
 *   · append-only 铁证：只读查询前后台账**逐字节相同**；历史行一条不删、一个字段不补。
 *   · 解出器本身用**动态 import**：旧实现（`lib/point-ref.js` 还不存在）时这里逐条报红，
 *     而不是整份套件在这里崩掉 —— 红日志要能逐条读出「哪条判据现在不过」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import './_pack.mjs' // 只为自报 [test-context]（T02/F02 逐进程对账；本套件自带夹具，不用包根）
import { intakePath, recordIntake, readIntake, intakeStatus } from '../lib/intake.js'
import { readPack } from '../lib/pack-model.js'
import { buildIntakeSummary } from '../lib/brief-io.js'
import { buildBrief, decideNext } from '../lib/brief.js'
import { plugin as authorPlugin } from '../lib/mods/author.js'
import { plugin as intakePlugin } from '../lib/mods/intake.js'
import { plugin as goalPlugin } from '../lib/mods/goal.js'

let pass = 0
const fails = []
/** 一条断言一行；红行必须**行首** FAIL（适配器按行首认红行，条数要与摘要一致） */
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(flat(msg)); console.log('FAIL ' + flat(msg)) }
}
/** 断言里的错误文本可能带换行/多行 —— 压成一行（否则红行条数与摘要对不上） */
function flat(s) {
	return String(s ?? '').replace(/\s*\n\s*/g, ' ').trim()
}
const errText = (e) => flat(e && e.message ? e.message : String(e))

console.log('[intake-id-resolve] 知识点 id 统一解析（Bug5 回归）')

// ── 夹具：真文件树（tmp 下；不碰活包 / DSH_HOME）────────────────────────────
const TMPBASE = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-intake-id-'))
const madeDirs = [TMPBASE]
function newDir(name) {
	const d = path.join(TMPBASE, name)
	fs.mkdirSync(d, { recursive: true })
	return d
}
function writeJson(dir, rel, obj) {
	const f = path.join(dir, rel)
	fs.mkdirSync(path.dirname(f), { recursive: true })
	fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
	return f
}
/** 一张合法院图（`lib/plan.js` 的 validatePlan 判据：goal + nodes[no/title/deliverable/criteria/why/sources]） */
const PLAN = {
	goal: '交付一个能在浏览器里跑起来、能点的页面',
	nodes: [{
		no: 1,
		title: '第1课 起步',
		deliverable: '一个能打开并显示标题与文字的页面',
		criteria: '打开页面能看到标题与文字',
		why: '终点是交付页面 —— 先得让它显示出来',
		sources: [{ label: 'MDN', url: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript' }],
	}],
}
/**
 * 造一个**真的**课程包目录（`readPack()` 读得出来的那种）。
 * @param {string} name 子目录名
 * @param {Array<{id:string, name?:string, points:Array<{id:string, plan?:object, requires?:string[], label?:string, fileBase?:number}>}>} circles
 */
function makePack(name, circles, opts = {}) {
	const root = newDir(name)
	// 「像课程包」的标记件（`test/_pack.mjs` 的 looksLikePack 判据；这里不靠它，但让夹具是真的包）
	fs.mkdirSync(path.join(root, 'presets'), { recursive: true })
	fs.writeFileSync(path.join(root, 'presets', 'whale-sensei.css'), '/* fixture */\n', 'utf8')
	for (const c of circles) {
		writeJson(root, `lessons/${c.id}/halo.json`, { halo: c.id, name: c.name || c.id })
		for (const p of c.points) {
			writeJson(root, `lessons/${c.id}/${p.id}/point.json`, {
				point: p.id,
				name: p.name || p.id,
				label: p.label || '',
				fileBase: p.fileBase ?? 0,
				requires: p.requires || [],
				...(p.plan ? { plan: p.plan } : {}),
			})
		}
	}
	if (opts.progress !== false) writeJson(root, 'progress.json', { learned: opts.learned || [] })
	return root
}
const ledgerText = (root) => fs.readFileSync(intakePath(root), 'utf8')
const ledgerLines = (root) => ledgerText(root).trim().split('\n').filter(Boolean)

const fakeLog = { info() { }, warn() { }, error() { } }
function installTool(mod, root) {
	let tool = null
	mod.install({ paths: { packRoot: root }, log: fakeLog, registerTool: (d) => { tool = d } })
	return tool
}

try {
	// ══════════════════════════════════════════════════════════════════
	// ⓪ 解析器模块（`lib/point-ref.js`）—— 只此一份规则，别处不许各写一套
	// ══════════════════════════════════════════════════════════════════
	let pointRefMod = null
	try {
		pointRefMod = await import('../lib/point-ref.js')
	} catch (e) {
		ok(false, 'lib/point-ref.js 存在且可导入（统一解析器的落点）— ' + errText(e))
	}
	const resolvePointRef = pointRefMod?.resolvePointRef
	const describePointRef = pointRefMod?.describePointRef
	ok(typeof resolvePointRef === 'function', 'lib/point-ref.js 导出 resolvePointRef({pack, ref, halo})')
	ok(typeof describePointRef === 'function', 'lib/point-ref.js 导出 describePointRef()（拒绝理由与工具回执共用一份措辞）')
	/** 解析器缺失时不炸：返回 null，让每条断言各报一句红 */
	const R = (spec) => (typeof resolvePointRef === 'function' ? resolvePointRef(spec) : null)

	// 包 A：一个圆圈两个点 + 另一个圆圈一个点（裸 id 全局唯一）
	const rootA = makePack('packA', [
		{ id: 'programming', points: [{ id: 'js-basics' }, { id: 'vue' }] },
		{ id: 'math', points: [{ id: 'alge' }] },
	])
	const packA = readPack(rootA)
	ok(packA.points.length === 3 && packA.circles.length === 2,
		`夹具包被真的 readPack() 读出来：${packA.circles.length} 圆圈 / ${packA.points.length} 知识点`)

	// 包 B：两个圆圈里**同名**知识点 x（隔离判据的靶子）
	const rootB = makePack('packB', [
		{ id: 'a', points: [{ id: 'x' }] },
		{ id: 'b', points: [{ id: 'x' }] },
	])
	const packB = readPack(rootB)

	// ── ① 规范 / 复合 id ──
	const rComposite = R({ pack: packA, ref: 'programming/js-basics' })
	ok(!!rComposite && rComposite.ok === true && rComposite.key === 'programming/js-basics'
		&& rComposite.circle === 'programming' && rComposite.id === 'js-basics',
		`复合 id 解析成 {circle,id,key}（实测 ${JSON.stringify(rComposite)}）`)
	ok(!!rComposite && rComposite.unverified !== true, '课程包读得出来时是**核验过**的解析（不是 unverified 兜底）')

	// ── ② 唯一裸 id 兼容 ──
	const rBare = R({ pack: packA, ref: 'js-basics' })
	ok(!!rBare && rBare.ok === true && rBare.key === 'programming/js-basics',
		`唯一裸 id 解析到同一个规范 key（实测 key=${rBare && rBare.key}）`)
	const rBareHalo = R({ pack: packA, ref: 'js-basics', halo: 'programming' })
	ok(!!rBareHalo && rBareHalo.ok === true && rBareHalo.key === 'programming/js-basics', '裸 id + halo 也解析得出来（同一答案）')

	// ── ③ 同名隔离（a/x 与 b/x 各是各的）──
	const rAX = R({ pack: packB, ref: 'a/x' })
	const rBX = R({ pack: packB, ref: 'b/x' })
	ok(!!rAX && rAX.ok === true && rAX.key === 'a/x', `a/x 解析成 a/x（实测 ${rAX && rAX.key}）`)
	ok(!!rBX && rBX.ok === true && rBX.key === 'b/x', `b/x 解析成 b/x（实测 ${rBX && rBX.key}）`)
	ok(!!rAX && !!rBX && rAX.key !== rBX.key, '同名知识点在两个圆圈里是**两个不同的 key**（不许简单去前缀）')
	const rXHaloA = R({ pack: packB, ref: 'x', halo: 'a' })
	const rXHaloB = R({ pack: packB, ref: 'x', halo: 'b' })
	ok(!!rXHaloA && rXHaloA.ok === true && rXHaloA.key === 'a/x', '裸 x + halo=a → a/x')
	ok(!!rXHaloB && rXHaloB.ok === true && rXHaloB.key === 'b/x', '裸 x + halo=b → b/x')

	// ── ④ 歧义 / 未知 / 点圈对不上：明确拒（带候选 / 合法值）──
	const rAmb = R({ pack: packB, ref: 'x' })
	ok(!!rAmb && rAmb.ok === false && rAmb.code === 'ambiguous', `裸 x 在 a/b 都有 → 拒绝（实测 code=${rAmb && rAmb.code}）`)
	ok(!!rAmb && Array.isArray(rAmb.candidates) && rAmb.candidates.join(',') === 'a/x,b/x',
		`歧义理由里列出两个候选（实测 ${JSON.stringify(rAmb && rAmb.candidates)}）`)
	ok(typeof describePointRef === 'function' && !!rAmb
		&& /a\/x/.test(describePointRef(rAmb)) && /b\/x/.test(describePointRef(rAmb))
		&& /halo/.test(describePointRef(rAmb)),
		`歧义的说人话版本带候选与修法（实测 ${typeof describePointRef === 'function' && rAmb ? describePointRef(rAmb) : '（缺 describePointRef）'}）`)

	const rUnknown = R({ pack: packA, ref: 'nope' })
	ok(!!rUnknown && rUnknown.ok === false && rUnknown.code === 'unknown', `未知 id → 拒绝（实测 code=${rUnknown && rUnknown.code}）`)
	ok(!!rUnknown && Array.isArray(rUnknown.candidates) && rUnknown.candidates.includes('programming/js-basics')
		&& rUnknown.candidates.includes('math/alge'),
		`未知 id 的理由里列出包里的**合法 id**（实测 ${JSON.stringify(rUnknown && rUnknown.candidates)}）`)
	ok(typeof describePointRef === 'function' && !!rUnknown && /programming\/js-basics/.test(describePointRef(rUnknown)),
		'未知 id 的说人话版本带合法值')

	const rMismatch = R({ pack: packA, ref: 'js-basics', halo: 'math' })
	ok(!!rMismatch && rMismatch.ok === false && rMismatch.code === 'halo-mismatch'
		&& (rMismatch.candidates || []).includes('programming/js-basics'),
		`点 / 圈对不上 → 拒绝并说清它属于哪个圈（实测 ${JSON.stringify(rMismatch && rMismatch.code)} / ${JSON.stringify(rMismatch && rMismatch.candidates)}）`)

	const rEmpty = R({ pack: packA, ref: '  ' })
	ok(!!rEmpty && rEmpty.ok === false && rEmpty.code === 'missing-ref', `空 ref → 拒绝（code=${rEmpty && rEmpty.code}）`)

	// 没有目录可对照（老包 / 新建包）：按形状分层，**不猜归属**，但不能因此拒掉老用法
	const rNoPackBare = R({ pack: null, ref: 'vue' })
	ok(!!rNoPackBare && rNoPackBare.ok === true && rNoPackBare.key === 'vue' && rNoPackBare.unverified === true,
		'没有课程包时裸 id 照旧认（unverified，不猜归属）')
	const rNoPackComposite = R({ pack: null, ref: 'a/x' })
	ok(!!rNoPackComposite && rNoPackComposite.ok === true && rNoPackComposite.key === 'a/x',
		'没有课程包时 a/x 与 b/x 仍是两个 key（结构性隔离，不去前缀）')

	// ══════════════════════════════════════════════════════════════════
	// ① 验收一：catalog 复合 id 落盘后，裸 id 查得到（Bug5 的核心）
	// ══════════════════════════════════════════════════════════════════
	const recComposite = recordIntake(rootA, {
		point: 'programming/js-basics', level: '零基础', goal: '能写一个能点的页面', at: '2026-10-19',
	})
	ok(recComposite.ok === true, `recordIntake 用 catalog 复合 id 真事务落盘（${recComposite.ok ? 'ok' : recComposite.error}）`)
	ok(ledgerLines(rootA).length === 1
		&& ledgerLines(rootA)[0].includes('"point":"programming/js-basics"'),
		`台账里存的是**原样复合 id**（不偷偷改写成裸 id）：${ledgerLines(rootA)[0]}`)
	const afterWrite = ledgerText(rootA)

	const stBareAfterComposite = intakeStatus(rootA, 'js-basics')
	ok(stBareAfterComposite.done === true,
		'★ 复合 id 摸底后，author 用的裸 id 也认（不再判「没摸底」）')
	ok(stBareAfterComposite.entry && stBareAfterComposite.entry.point === 'programming/js-basics',
		'拿回来的是台账上那条**原记录**（历史不被改写）')
	ok(stBareAfterComposite.key === 'programming/js-basics',
		`intakeStatus 带出规范 key（只加法字段，实测 ${stBareAfterComposite.key}）`)
	const stCompositeAfterComposite = intakeStatus(rootA, 'programming/js-basics')
	ok(stCompositeAfterComposite.done === true && stCompositeAfterComposite.level === '零基础',
		'复合 id 查自己当然也 done（level 取最新那条）')
	ok(stBareAfterComposite.missing.length === 0, 'done 时 missing 为空（level/goal 都在）')
	ok(ledgerText(rootA) === afterWrite, '只读查询（intakeStatus）不改台账一个字节（append-only）')

	// ══════════════════════════════════════════════════════════════════
	// ② 验收二：唯一裸 id 的历史记录也能被认出来
	// ══════════════════════════════════════════════════════════════════
	const rootBare = makePack('packBare', [
		{ id: 'programming', points: [{ id: 'js-basics' }, { id: 'vue' }] },
	])
	const recBare = recordIntake(rootBare, {
		point: 'js-basics', level: '有基础', goal: '能改一个页面', at: '2026-10-18',
	})
	ok(recBare.ok === true, '历史裸 id 记录照旧能落盘（不做破坏性改写）')
	ok(intakeStatus(rootBare, 'programming/js-basics').done === true,
		'历史裸 id 记录能被**复合 id** 认出来（老台账兼容）')
	ok(intakeStatus(rootBare, 'js-basics').done === true, '裸 id 查裸 id 也照样 done')
	ok(ledgerLines(rootBare)[0].includes('"point":"js-basics"'),
		'老行原样留在台账里（一个字段没被补、一个字符没被改）')

	// ══════════════════════════════════════════════════════════════════
	// ③ 验收三：同名知识点隔离（a/x ≠ b/x）
	// ══════════════════════════════════════════════════════════════════
	const recA = recordIntake(rootB, { point: 'a/x', level: 'A 级', goal: 'A 目标', at: '2026-10-17' })
	ok(recA.ok === true, '圆圈 a 的 x 摸底落盘')
	ok(intakeStatus(rootB, 'a/x').done === true, 'a/x 自己 done=true')
	ok(intakeStatus(rootB, 'b/x').done === false, '★ 圆圈 a 的 x 摸底**不能**让圆圈 b 的 x 变 done（隔离）')
	ok(intakeStatus(rootB, 'x', { halo: 'a' }).done === true, 'halo=a 时裸 x 唯一命中 a/x')
	ok(intakeStatus(rootB, 'x', { halo: 'b' }).done === false, 'halo=b 时裸 x 不会串到 a/x 的记录上')
	const stAmbiguousBare = intakeStatus(rootB, 'x')
	ok(!!stAmbiguousBare.ref && stAmbiguousBare.ref.ok === false && stAmbiguousBare.ref.code === 'ambiguous',
		`裸 x（无 halo、两圈都有）→ 明确拒（实测 ${JSON.stringify(stAmbiguousBare.ref && stAmbiguousBare.ref.code)}）`)
	ok(stAmbiguousBare.done === false && stAmbiguousBare.entry === null,
		'歧义时**不猜**：done=false、entry=null（不给任何一边盖章）')
	// 歧义的历史裸行（老台账里就可能长这样）也不许被算进任何一边
	const recAmbiguousLegacy = recordIntake(rootB, { point: 'x', level: '裸行', goal: '裸目标', at: '2026-10-17' })
	ok(recAmbiguousLegacy.ok === true, '歧义裸行本身允许追加（append-only，历史不许删）')
	ok(intakeStatus(rootB, 'a/x').entry && intakeStatus(rootB, 'a/x').entry.level === 'A 级',
		'歧义裸行没被算进 a/x（还是 a/x 那条）')
	ok(intakeStatus(rootB, 'b/x').done === false, '歧义裸行也没让 b/x 变 done（不猜）')

	// ══════════════════════════════════════════════════════════════════
	// ④ 验收四：未知 / 歧义输入被拒（工具面），理由带候选 / 合法值
	// ══════════════════════════════════════════════════════════════════
	const intakeToolA = installTool(intakePlugin, rootA)
	const beforeReject = ledgerText(rootA)
	const badUnknown = await intakeToolA.execute({ op: 'record', point: 'nope', level: 'x', goal: 'y', root: rootA })
	ok(badUnknown.ok === false, `whale_intake op=record 未知 id → 拒写（实测 ok=${badUnknown.ok}）`)
	ok(/programming\/js-basics/.test(String(badUnknown.error || '')),
		`拒绝理由里列出合法 id（实测 ${badUnknown.error}）`)
	ok(ledgerText(rootA) === beforeReject, '被拒的写入一个字节都没落盘（拒就是拒，不留半条）')

	const intakeToolB = installTool(intakePlugin, rootB)
	const beforeAmbig = ledgerText(rootB)
	const badAmbiguous = await intakeToolB.execute({ op: 'record', point: 'x', level: 'x', goal: 'y', root: rootB })
	ok(badAmbiguous.ok === false, `whale_intake op=record 歧义 id → 拒写（实测 ok=${badAmbiguous.ok}）`)
	ok(/a\/x/.test(String(badAmbiguous.error || '')) && /b\/x/.test(String(badAmbiguous.error || '')),
		`歧义拒绝理由里列出候选（实测 ${badAmbiguous.error}）`)
	ok(ledgerText(rootB) === beforeAmbig, '歧义被拒时也没落盘')
	// 歧义不是死锁：显式给 halo 就能解
	const resolvedByHalo = await intakeToolB.execute({ op: 'record', point: 'x', halo: 'b', level: '有基础', goal: 'b 目标', root: rootB })
	ok(resolvedByHalo.ok === true, `歧义用 halo 解掉后能落盘（实测 ${resolvedByHalo.ok ? 'ok' : resolvedByHalo.error}）`)
	ok(intakeStatus(rootB, 'b/x').done === true, 'a/x 与 b/x 现在各自独立 done（互不污染）')
	ok(intakeStatus(rootB, 'a/x').entry.level === 'A 级', 'b/x 的摸底没盖掉 a/x 的记录')

	// ══════════════════════════════════════════════════════════════════
	// ⑤ 验收五：历史老行 {point,level,goal} 无 start → 照旧 done=true
	// ══════════════════════════════════════════════════════════════════
	const rootOld = makePack('packOld', [{ id: 'programming', points: [{ id: 'vue' }] }])
	fs.mkdirSync(path.join(rootOld, 'learning-records'), { recursive: true })
	const OLD_LINE = JSON.stringify({ point: 'programming/vue', level: '有基础', goal: '能改页面' })
	fs.writeFileSync(intakePath(rootOld), OLD_LINE + '\n', 'utf8')
	const stOld = intakeStatus(rootOld, 'vue')
	ok(stOld.done === true && stOld.missing.length === 0, '老行 {point,level,goal}（无 start）→ done=true（B6：绝不判「没摸底」）')
	ok(stOld.start === null && stOld.structured === false, '老行没有 start → start=null / structured=false（只提示，不判缺失）')
	ok(stOld.entry && !('start' in stOld.entry), '读出来的还是老行原样（没补字段）')
	ok(ledgerText(rootOld) === OLD_LINE + '\n', '读老行不改台账（逐字节相同）')
	// 连 lessons/ 都没有的目录（老包 / 只做摸底的新目录）：裸 id 照旧能读，不许因为"没目录可对照"就拒
	const rootNoPack = newDir('packNoDir')
	fs.mkdirSync(path.join(rootNoPack, 'learning-records'), { recursive: true })
	fs.writeFileSync(intakePath(rootNoPack), JSON.stringify({ point: 'vue', level: '无', goal: '有' }) + '\n', 'utf8')
	const stNoPack = intakeStatus(rootNoPack, 'vue')
	ok(stNoPack.done === true, '没有 lessons/ 的目录里裸 id 照旧 done=true（老调用方不受影响）')
	const stNoPackComposite = intakeStatus(rootNoPack, 'a/vue')
	ok(stNoPackComposite.done === false, '没有 lessons/ 时 a/vue 不会串到裸 vue 的记录上（结构性隔离）')

	// ══════════════════════════════════════════════════════════════════
	// ⑥ 验收六：whale_intake op=read 不因复合 / 裸混用丢记录
	// ══════════════════════════════════════════════════════════════════
	const rootRead = makePack('packRead', [
		{ id: 'programming', points: [{ id: 'js-basics' }, { id: 'vue' }] },
	])
	const readTool = installTool(intakePlugin, rootRead)
	const rA = await readTool.execute({ op: 'record', point: 'programming/vue', level: 'A 复合', goal: '目标 A', root: rootRead })
	const rB = await readTool.execute({ op: 'record', point: 'vue', level: 'B 裸', goal: '目标 B', root: rootRead })
	const rC = await readTool.execute({ op: 'record', point: 'programming/js-basics', level: 'C 复合', goal: '目标 C', root: rootRead })
	ok(rA.ok === true && rB.ok === true && rC.ok === true, '复合 / 裸混着记录三条（真实事务写盘）')
	ok(ledgerLines(rootRead).length === 3, '台账里是 3 行（append-only，谁也没覆盖谁）')
	const rd = await readTool.execute({ op: 'read', root: rootRead })
	ok(rd.ok === true, 'op=read 成功')
	const readKeys = Object.keys(rd.points || {})
	ok(readKeys.length === 2, `★ 视图按规范 id 合并成 2 个知识点（实测 ${readKeys.length}：${readKeys.join(' / ')}）`)
	ok(rd.points?.['programming/vue'] && rd.points['programming/vue'].level === 'B 裸',
		`同一个点的复合 + 裸两条合成一条，**取最新那条**（实测 level=${rd.points && rd.points['programming/vue'] && rd.points['programming/vue'].level}）`)
	ok(rd.points?.['programming/js-basics'] && rd.points['programming/js-basics'].level === 'C 复合',
		'复合 id 的点落在规范键上（查得到，不丢）')
	ok(!('vue' in (rd.points || {})), '不再同一个逻辑点两个键（不重复计数、也不丢记录）')
	ok(rd.raw && rd.raw.vue && rd.raw['programming/vue'] && rd.raw.vue.level === 'B 裸',
		`原始行按原键原样带出（一条没丢，实测 raw 键=${rd.raw ? Object.keys(rd.raw).join(' / ') : '（没有 raw）'}）`)
	const rendered = readTool.output.render({}, rd)[0].text
	ok(rendered.split('\n')[0] === '📚 摸底记录：2 个知识点',
		`op=read 的渲染按 2 个知识点报（实测首行「${rendered.split('\n')[0]}」）`)
	ok(rendered.includes('programming/vue') && rendered.includes('B 裸'), '渲染里那个点用的是规范 id + 最新 level')

	// ══════════════════════════════════════════════════════════════════
	// ① 验收一（工具面终判）：复合 id 摸底 → whale_author 放行；负对照仍被拦
	// ══════════════════════════════════════════════════════════════════
	const rootAuthor = makePack('packAuthor', [{
		id: 'programming',
		points: [
			{ id: 'js-basics', plan: PLAN },
			{ id: 'css', plan: PLAN }, // 负对照：可真没摸底
		],
	}])
	const authorTool = installTool(authorPlugin, rootAuthor)
	const intakeToolAuthor = installTool(intakePlugin, rootAuthor)
	const recAuthor = await intakeToolAuthor.execute({
		op: 'record', point: 'programming/js-basics', level: '零基础', goal: '能写一个能点的页面', root: rootAuthor,
	})
	ok(recAuthor.ok === true, 'catalog 复合 id 走 whale_intake op=record 落盘（真实事务）')

	const authorArgs = {
		point: 'js-basics', // ← author 一直用裸 id（目录名就是它）
		number: 1, title: 'JS 起步', slug: 'js-basics-intro', hintTerm: '变量',
		source: { label: 'MDN', url: 'https://developer.mozilla.org/' },
		commit: true, root: rootAuthor,
	}
	const authorOk = await authorTool.execute(authorArgs)
	ok(authorOk.ok === true,
		`★ 复合 id 摸底后 whale_author 放行（实测 ok=${authorOk.ok}${authorOk.error ? ' error=' + authorOk.error : ''}）`)
	ok(authorOk.needsIntake !== true, '回执里不再有 needsIntake:true')
	ok(!/还没有 intake 记录/.test(String(authorOk.error || '')), '回执里不再有「还没有 intake 记录」')
	ok(authorOk.wrote === true, 'commit:true 真的写盘了')
	const authorFile = path.join(rootAuthor, 'lessons', 'src', 'programming', 'js-basics', '0001-js-basics-intro.html')
	ok(fs.existsSync(authorFile), `落盘文件真的在：lessons/src/programming/js-basics/0001-js-basics-intro.html`)

	// 负对照：同一个包里**真没摸底**的 css 仍要被拦住（证明闸没被放宽）
	const authorBlocked = await authorTool.execute({ ...authorArgs, point: 'css', title: 'CSS 起步', slug: 'css-intro', hintTerm: '选择器' })
	ok(authorBlocked.ok === false && authorBlocked.needsIntake === true,
		`负对照：真没摸底的 css 仍被 intake 闸拦住（实测 ok=${authorBlocked.ok} needsIntake=${authorBlocked.needsIntake}）`)
	ok(/还没有 intake 记录/.test(String(authorBlocked.error || '')), '负对照的拒绝理由仍是原来那句（没被改坏）')
	ok(!fs.existsSync(path.join(rootAuthor, 'lessons', 'src', 'programming', 'css', '0001-css-intro.html')),
		'被拦的那次一个字节都没写')

	// ② 验收二（工具面）：历史裸 id 记录也能让 author 放行
	const rootAuthorBare = makePack('packAuthorBare', [{ id: 'programming', points: [{ id: 'js-basics', plan: PLAN }] }])
	const authorToolBare = installTool(authorPlugin, rootAuthorBare)
	const intakeToolBare = installTool(intakePlugin, rootAuthorBare)
	await intakeToolBare.execute({ op: 'record', point: 'js-basics', level: '有基础', goal: '能改页面', root: rootAuthorBare })
	const authorBareOk = await authorToolBare.execute({ ...authorArgs, root: rootAuthorBare })
	ok(authorBareOk.ok === true,
		`★ 历史裸 id 摸底记录也能让 whale_author 放行（实测 ok=${authorBareOk.ok}${authorBareOk.error ? ' error=' + authorBareOk.error : ''}）`)
	ok(fs.existsSync(path.join(rootAuthorBare, 'lessons', 'src', 'programming', 'js-basics', '0001-js-basics-intro.html')),
		'裸 id 记录那条路也真的写了课程文件')

	// ══════════════════════════════════════════════════════════════════
	// ⑦ 验收（同一 bug 的另外两扇门）：brief 的「学情摸底」与 goal 契约的 `from`
	//    原本它们各按**原始裸键**读 `latest[point]` —— 复合 id 落的摸底会被当"没摸底"。
	//    现在必须与 author / whale_intake 走**同一套**解析（`resolvePointRef` + `latestIntakeFor`）。
	// ══════════════════════════════════════════════════════════════════
	const rootShare = makePack('packShare', [{ id: 'programming', points: [{ id: 'js-basics' }] }])
	const packShare = readPack(rootShare)
	const shareTool = installTool(intakePlugin, rootShare)
	const recShare = await shareTool.execute({
		op: 'record', point: 'programming/js-basics', level: '有基础', goal: '能写一个能点的页面',
		prior: '写过一点', can: '能改样例', stuck: '响应式', startTier: 3, root: rootShare,
	})
	ok(recShare.ok === true && recShare.status?.start?.tier === 3,
		'复合 id + 起点台阶落盘（真事务；status 带出 start.tier=3）')

	// ① brief：真调 buildIntakeSummary + buildBrief（不查源码、不拼字符串）
	const summary = buildIntakeSummary(rootShare, packShare)
	ok(summary.have === 1 && summary.missing.length === 0,
		`★ brief 的学情概览认得出复合 id 的摸底（实测 have=${summary.have} / missing=${summary.missing.length}）`)
	ok(summary.details['js-basics']?.level === '有基础' && summary.details['js-basics']?.start?.tier === 3,
		'details 仍是 {level, start} 两字段（形状没变、判据面没扩）')
	const brief = buildBrief({
		pack: { circles: 1, points: 1, lessons: 1, learned: 0 },
		projects: [], pending: [], processed: 0, ledger: { count: 0, latest: null },
		glossary: { count: 0, categories: 0 }, records: [], recordCount: 0, notes: [], intake: summary,
	})
	const intakeSec = brief.sections.find((s) => s.title === '学情摸底')
	ok(!!intakeSec && intakeSec.lines[0] === '已摸底 1 个知识点 · 缺 0',
		`buildBrief 的「学情摸底」段按「已摸底 1」报（实测「${intakeSec ? intakeSec.lines[0] : '（没有这一段）'}」）`)
	ok(!!intakeSec && intakeSec.lines.some((l) => l.includes('js-basics') && l.includes('已摸底') && l.includes('有基础')),
		'学情段列出该点 + level（不再当没摸底）')
	ok(!!intakeSec && !intakeSec.lines.some((l) => l.includes('未摸底')), '学情段里一条「未摸底」都没有')
	// 决策链上也必须看得见（`decideNext` 的 intake-course 分支只读 `intake.missing`）：
	// projects 要给"课已做完"的形状，否则更早的 unknown / continue-lesson 分支会先返回、测不到这一步。
	const shareProjects = [{ lessons: [{ id: 'js-basics/0001', title: '第1课', done: true, satisfied: [], missing: [] }] }]
	const dnShare = decideNext({ pending: 0, projects: shareProjects, lessonTotal: 1, intake: summary })
	ok(dnShare.action === 'open-next-lesson',
		`decideNext 不再因为误判"没摸底"把动作打成 intake-course（实测 ${dnShare.action}）`)

	// ② goal：真调 whale_goal op=record，`from` 从复合 id 的摸底接上起点台阶
	const goalTool = installTool(goalPlugin, rootShare)
	const goalRec = await goalTool.execute({
		op: 'record', point: 'js-basics', goal: '交付一个能点的页面', tier: 2, acceptance: ['三个文件齐'], root: rootShare,
	})
	ok(goalRec.ok === true, `whale_goal op=record 成功（实测 ${goalRec.ok ? 'ok' : goalRec.error}）`)
	ok(goalRec.record?.from?.tier === 3,
		`★ 契约的 from 从复合 id 的摸底接上起点台阶（实测 ${JSON.stringify(goalRec.record?.from?.tier)}）`)
	// catalog 原样把完整 id 传给 whale_goal 也认（pointId 糖 → point = 最后一段，pointPath = 复合 id）
	const goalRec2 = await goalTool.execute({
		op: 'record', point: 'programming/js-basics', goal: '交付一个能点的页面', tier: 2, acceptance: ['三个文件齐'], root: rootShare,
	})
	ok(goalRec2.ok === true && goalRec2.record?.from?.tier === 3,
		`catalog 完整 id 直传 whale_goal 也能接上 from（实测 ${JSON.stringify(goalRec2.record?.from?.tier)}）`)
	ok(goalRec2.record?.v === 2 && goalRec2.record?.replaces === 1,
		'同一点再记一版 = v2 取代 v1（append-only 没被破坏）')

	// ③ 歧义裸 id：brief / goal 都**不许炸**，如实"拿不到"（就是从前的行为：按缺省）
	const rootShareAmb = makePack('packShareAmb', [
		{ id: 'a', points: [{ id: 'x' }] },
		{ id: 'b', points: [{ id: 'x' }] },
	])
	const packShareAmb = readPack(rootShareAmb)
	const shareAmbTool = installTool(intakePlugin, rootShareAmb)
	await shareAmbTool.execute({
		op: 'record', point: 'a/x', level: 'A 级', goal: 'A 目标',
		prior: 'p', can: 'c', stuck: 's', startTier: 4, root: rootShareAmb,
	})
	let ambSummary = null
	let ambThrew = null
	try { ambSummary = buildIntakeSummary(rootShareAmb, packShareAmb) } catch (e) { ambThrew = e }
	ok(!ambThrew, `歧义时 buildIntakeSummary 不抛错（不许炸${ambThrew ? '：' + errText(ambThrew) : ''}）`)
	ok(!!ambSummary && ambSummary.have === 0 && ambSummary.missing.length === 2,
		`歧义时如实当"拿不到"（实测 have=${ambSummary?.have} / missing=${ambSummary?.missing?.length}）`)
	const goalAmbTool = installTool(goalPlugin, rootShareAmb)
	const ambGoal = await goalAmbTool.execute({
		op: 'record', point: 'x', goal: 'x 的终点', tier: 2, acceptance: ['能跑'], root: rootShareAmb,
	})
	ok(ambGoal.ok === true, `歧义 id 下 whale_goal 不炸（实测 ok=${ambGoal.ok}${ambGoal.error ? ' / ' + ambGoal.error : ''}）`)
	ok(ambGoal.record?.from === null,
		`歧义时 from 拿不到就 null（不许借 a/x 的起点台阶，实测 ${JSON.stringify(ambGoal.record?.from)}）`)

	// ④ 历史裸 id 行：brief 概览与 goal 的 from 照旧
	const rootShareBare = makePack('packShareBare', [{ id: 'programming', points: [{ id: 'js-basics' }] }])
	const packShareBare = readPack(rootShareBare)
	const shareBareTool = installTool(intakePlugin, rootShareBare)
	await shareBareTool.execute({
		op: 'record', point: 'js-basics', level: '有基础', goal: '能写',
		prior: 'p', can: 'c', stuck: 's', startTier: 2, root: rootShareBare,
	})
	const bareSummary = buildIntakeSummary(rootShareBare, packShareBare)
	ok(bareSummary.have === 1 && bareSummary.details['js-basics']?.start?.tier === 2,
		`★ 历史裸 id 行：brief 学情概览照旧认（实测 have=${bareSummary.have} / tier=${bareSummary.details['js-basics']?.start?.tier}）`)
	const bareGoal = await installTool(goalPlugin, rootShareBare).execute({
		op: 'record', point: 'js-basics', goal: '能写页面', tier: 2, acceptance: ['x'], root: rootShareBare,
	})
	ok(bareGoal.ok === true && bareGoal.record?.from?.tier === 2,
		`★ 历史裸 id 行：契约 from 照旧接上（实测 tier=${JSON.stringify(bareGoal.record?.from?.tier)}）`)

	// 兼容性：readIntake().latest 的**对外形状不变**（brief-io / goal-io / adjust-io 在用）
	const compat = readIntake(rootRead)
	ok(compat && typeof compat.latest === 'object' && Array.isArray(compat.entries)
		&& typeof compat.file === 'string' && Array.isArray(compat.problems),
		'readIntake(root) 仍是 {file,entries,latest,problems}（老调用方的形状没被改坏）')
	ok(Object.keys(compat.latest).join(',') === 'programming/vue,vue,programming/js-basics',
		`latest 仍按**原始 point 键**各给最后一条（不合并、不改形）：实测 ${Object.keys(compat.latest).join(',')}`)
	const compatWithPack = readIntake(rootRead, { pack: readPack(rootRead) })
	ok(Object.keys(compatWithPack.byKey).join(',') === 'programming/vue,programming/js-basics',
		`规范 id 视图 byKey 与 latest **各自独立**（byKey 2 条 / latest 3 条，老调用方读 latest 一个点不会被算两遍）：实测 ${Object.keys(compatWithPack.byKey).join(',')}`)
	ok(compatWithPack.latest['programming/vue']?.level === 'A 复合' && compatWithPack.latest.vue?.level === 'B 裸'
		&& compatWithPack.entries.length === 3,
		'latest 一个键对应一条**原始记录**（entries 3 条一条不少，没有别名被塞进 latest）')
} catch (e) {
	ok(false, '套件运行时抛错（不算通过）：' + errText(e))
}

// ── 清理（只删自己造的 tmp 目录）─────────────────────────────────────────
for (const d of madeDirs) {
	try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) {
	for (const f of fails) console.log('    ✗ ' + f)
	process.exit(1)
}
console.log('✅ 知识点 id 统一解析：复合 / 裸 id 互通、同名隔离、未知拒写、历史兼容、author 放行')
