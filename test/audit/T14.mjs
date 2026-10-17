/**
 * T14.mjs —— 模块契约错误拒装且无半注册（报告 A02 / P2）
 * ==================================================================
 * 这张卡要钉住的现场（旧行为）：
 *
 *   lib/index.js 的装载循环**逐模块 try/catch 后继续**，最后还打一行
 *   「装载模块：A、B、C…」把失败的也算进去；`selectMods()` 只有 `{mods,problems}`，
 *   没有 `ok`，也没有"哪些模块不合格"的逐模块归因 ⇒ **装配错了也观测不到**：
 *   插件照常起来、卡上写着"已装载 N 个"，而工具根本不在。
 *
 * 判据（全部可失败，且带反空转）：
 *
 *   S 组（契约门，`selectMods(io) → {ok,mods,problems}`）
 *     · 真实模块表必须**放行**（`ok===true`、`problems===[]`）—— 否则下面的红全是空的
 *     · 非法 id / 空 id / 重复 id / 重复工具 / 非 whale_ 前缀 / 缺 version /
 *       tools 不是数组 / 既无 install 也无 boot / enabled 里没有对应文件 ⇒ 全部 red
 *     · 既有文案**逐字保留**（加固只许追加，不许把老句子改掉）
 *     · `ok` 恒等于 `problems.length === 0`
 *
 *   A 组（装载事务，真跑 `lib/index.js` 的 apply）
 *     · 干净装载：`hctx.mods` 逐条 `installed`，工具真的注册上（含 whale_ping）
 *     · registerTool 五项（name / description / parameters / output / output.render / execute）
 *       任一不合格 ⇒ 该模块 `failed`、**不合格的那个 def 一次都没进过注册表**（零半注册）、
 *       整批回滚（先前装上的也如实标出来）、registry 归零、不注册 whale_ping
 *     · install 中途抛错 / boot 抛错 ⇒ 同上，且 **抛错前注册的资源确实被回收**（history 里留有它）
 *     · 第二个模块抛错 ⇒ 第一个模块的资源也归零（卡面「补充」的原话）
 *     · 计划被拒（非法 id / 重复 id / 重复工具）⇒ 一个模块都不装，registry 空
 *     · cleanup / ctx.effect / ctx.on('dispose') 三条路径只清一次，重复调用不出错
 *     · status 卡有 apply 上下文时只报**真装载状态**；没有 apply 上下文时**如实标注**
 *       "未经 apply，安装状态未知"，不许把配置表当安装事实
 *     · 日志只报真实状态：`装载模块：` 那行只列 installed 的（失败的不许混进去），
 *       失败另有单独一行列出 id 与原因
 *     · `moduleTableDrift` 语义未被改动（它比的是**配置漂移**，不是安装结果）
 *
 * 一行判词：成功 `PASS T14 checks=N failed=0 skipped=0`；失败 `FAIL T14 …` 且 exit 1。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { mods, manifest, enabledModules, selectMods } from '../../lib/mods/index.js'
import { apply } from '../../lib/index.js'
import { plugin as statusPlugin, moduleTableDrift } from '../../lib/mods/status.js'

/** 固定用例 ID 全集（不许漂移；少一条/多一条都算失败） */
const IDS = [
	'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13',
	'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13',
	'A14', 'A15', 'A16', 'A17', 'A18', 'A19',
]

const records = []
const observations = []
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = path.join(repo, 'audit-evidence/T14')
fs.mkdirSync(evidence, { recursive: true })
const stamp = `${Date.now()}-${process.pid}`
const base = 'E:/Temp'
fs.mkdirSync(base, { recursive: true })
const fixture = fs.mkdtempSync(path.join(base, 'whale-T14-'))

const FILES = ['lib/mods/index.js', 'lib/index.js', 'lib/mods/status.js', 'test/audit/T14.mjs']
const hashes = Object.fromEntries(FILES.map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(repo, f))).digest('hex')]))

const eq = assert.deepEqual

const check = async (id, fn) => {
	let timeout
	try {
		await Promise.race([
			Promise.resolve().then(fn),
			new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${id} timed out after 10000ms`)), 10000) }),
		])
		records.push({ id, status: 'pass' })
	} catch (e) {
		records.push({ id, status: 'fail', error: e?.stack || String(e) })
	} finally {
		clearTimeout(timeout)
	}
}

/* ── 影子模块表：mods / manifest.mods.enabled 是导出的**数组**，就地改、跑完逐字节还原 ──────
 * 为什么不另立"注入表"的接口：卡面钉死的接口就是 `selectMods(io) → {ok,mods,problems}`，
 * 表本身是模块级单例（lib/index.js 用的也是同一份）。判据要注入错误就只能动这份表，
 * 所以一律走 try/finally 还原（还原后 enabledModules() 必须还是原来那 25 个）。
 */
async function withTableMutation(mutate, fn) {
	const savedMods = mods.slice()
	const savedEnabled = manifest.mods.enabled.slice()
	try {
		mutate()
		return await fn()
	} finally {
		mods.length = 0
		mods.push(...savedMods)
		manifest.mods.enabled.length = 0
		manifest.mods.enabled.push(...savedEnabled)
	}
}

/** 往真表上追加若干模块（契约门用例） */
const withExtraMods = (extra, fn) =>
	withTableMutation(() => { for (const e of extra) { mods.push(e); manifest.mods.enabled.push(e.id) } }, fn)

/** 把整张表换成影子表（装载事务用例：隔离，跑的就是 lib/index.js 的 apply） */
const withShadowTable = (entries, fn) =>
	withTableMutation(() => {
		mods.length = 0
		manifest.mods.enabled.length = 0
		for (const e of entries) { mods.push(e); manifest.mods.enabled.push(e.id) }
	}, fn)

/** 影子模块（契约字段可以按用例裁掉/改坏） */
const shadowMod = (over = {}) => ({ id: 'a_mod', version: '1.0.0', tools: [], install() {}, ...over })

/** 影子工具定义（默认五项齐全） */
const toolDef = (name, over = {}) => ({
	name,
	description: `T14 夹具工具 ${name}`,
	parameters: { type: 'object', properties: {}, additionalProperties: false },
	output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ok' }] },
	execute: async () => ({ ok: true }),
	...over,
})
const drop = (obj, key) => { const d = { ...obj }; delete d[key]; return d }

/**
 * 影子宿主：`tools.register` 是**唯一**的注册缝（T14 判的就是"这里留没留半注册"）。
 * `history` 记**每一次真的进过注册表的名字**（用来证明"先前确实注册上了、后来确实被回收"），
 * `registry` 是当下在册的名字。
 */
function host({ effect = true, on = true } = {}) {
	const registry = new Map()
	const history = []
	const logs = []
	const routes = []
	const effects = []
	const disposeHandlers = []
	const ctx = {
		logger: Object.fromEntries(['info', 'warn', 'error'].map((k) => [k, (m) => logs.push([k, String(m)])])),
		tools: {
			register(def) {
				if (registry.has(def.name)) throw new Error(`duplicate register: ${def.name}`)
				history.push(def.name)
				registry.set(def.name, def)
				return () => { registry.delete(def.name) }
			},
		},
		inject: (names, cb) => cb({
			get: () => ({
				fetch: {
					register: (r) => {
						routes.push(r)
						return () => { const i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1) }
					},
				},
			}),
		}),
	}
	if (effect) ctx.effect = (fn) => { const off = fn(); if (typeof off === 'function') effects.push(off); return off }
	if (on) {
		ctx.on = (event, fn) => {
			disposeHandlers.push([event, fn])
			return () => {
				const i = disposeHandlers.findIndex(([e, f]) => e === event && f === fn)
				if (i >= 0) disposeHandlers.splice(i, 1)
			}
		}
	}
	return {
		ctx, registry, history, logs, routes, effects,
		names: () => [...registry.keys()],
		async unload() {
			for (const off of [...effects].reverse()) await off()
			await this.emitDispose()
		},
		async emitDispose() { for (const [, fn] of [...disposeHandlers].reverse()) await fn() },
	}
}

const config = (over = {}) => ({ installPreset: false, announceOnBoot: false, dataDir: path.join(fixture, 'data'), ...over })
const logLines = (h) => h.logs.map(([level, m]) => `${level} ${m}`)

/* ── 夹具课程包（给 status 卡用：只读副本，绝不碰活包 E:\workplace\study） ────────── */
const packDir = path.join(fixture, 'pack')
fs.cpSync(path.join(repo, 'lib/pack-template'), packDir, { recursive: true })

/** 从 status 路由响应里取出「插件」块的某一行 */
async function statusRow(mountCtx, name) {
	const routes = []
	statusPlugin.install({
		...mountCtx,
		inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	})
	const route = routes.find((r) => r.path === '/api/whale/status')
	assert.ok(route, `status 路由挂上了（取「${name}」行）`)
	const res = await route.fetch(new Request('http://127.0.0.1:3091/api/whale/status', { method: 'GET' }))
	const body = await res.json()
	const section = (body.sections || []).find((s) => s.title === '插件')
	assert.ok(section, '「插件」section 在')
	const row = (section.rows || []).find((r) => r.name === name)
	assert.ok(row, `「${name}」行在`)
	return row
}

let fatal
let captured = null

try {
	/* ══════════════════════════ S 组：契约门 ══════════════════════════ */

	await check('S01', () => {
		// 反空转哨兵：真实模块表必须放行，否则后面所有"拦得住"的判据都是空的
		const plan = selectMods() // 无参调用不许抛（T13 H01 就是这么调的）
		eq(plan.ok, true)
		eq(plan.problems, [])
		eq(plan.mods.length, enabledModules().length)
		eq(plan.mods.map((m) => m.id), enabledModules())
		assert.ok(plan.mods.length > 0, '真实表不是空的')
	})

	await check('S02', () => {
		// ok 的定义 = problems.length === 0（两个方向都要成立）
		const good = selectMods()
		eq(good.ok, true)
		eq(good.ok, good.problems.length === 0)
		return withExtraMods([shadowMod({ id: '2bad' })], () => {
			const bad = selectMods({ log: { error: () => {} } })
			eq(bad.ok, false)
			eq(bad.ok, bad.problems.length === 0)
			assert.ok(bad.problems.length > 0)
		})
	})

	await check('S03', () => {
		const logged = []
		return withExtraMods([shadowMod({ id: 'Bad-Name' })], () => {
			const plan = selectMods({ log: { error: (m) => logged.push(String(m)) } })
			eq(plan.ok, false)
			assert.ok(plan.problems.some((p) => /^模块 id 不合法：/.test(p)), `非法 id 被拦下（${plan.problems.join(' | ')}）`)
			assert.ok(plan.moduleProblems.some((p) => p.id === 'Bad-Name'), '非法 id 有逐模块归因（apply 据此标 failed）')
			assert.ok(logged.some((m) => m.startsWith('[module] ')), '问题仍按老样子往 io.log.error 打，且带 [module] 前缀')
			assert.ok(logged.some((m) => m.includes('Bad-Name')), '日志里能看到是哪个模块坏了')
		})
	})

	await check('S04', () => {
		return withExtraMods([shadowMod({ id: '' })], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			assert.ok(plan.problems.some((p) => p === '模块 id 不合法：""'), `空 id 被拦下（${plan.problems.join(' | ')}）`)
		})
	})

	await check('S05', () => {
		// 重复 id：两个模块对象同名 —— 装哪个都说不清，两边都不合格
		const one = shadowMod({ id: 'dup_mod', tools: ['whale_t14_one'] })
		const two = shadowMod({ id: 'dup_mod', tools: ['whale_t14_two'] })
		return withExtraMods([one, two], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			assert.ok(plan.problems.some((p) => /^模块 id 撞车：/.test(p)), `重复 id 被拦下（${plan.problems.join(' | ')}）`)
			assert.ok(plan.moduleProblems.some((p) => p.id === 'dup_mod'))
		})
	})

	await check('S06', () => {
		// 重复工具名：两个模块声明同一个工具 —— 后装的会盖掉先装的，必须拦
		const one = shadowMod({ id: 'a_one', tools: ['whale_t14_dup'] })
		const two = shadowMod({ id: 'a_two', tools: ['whale_t14_dup'] })
		return withExtraMods([one, two], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			// 既有文案逐字保留（老句子不许被改写）
			const legacy = '工具名撞车：whale_t14_dup（a_one 与 a_two）'
			assert.ok(plan.problems.includes(legacy), `重复工具被拦下且用旧文案（${plan.problems.join(' | ')}）`)
			// 撞车是**双方**的契约问题：两边都要有归因，不许只怪后来那个
			assert.ok(plan.moduleProblems.some((p) => p.id === 'a_one'), '先声明的一方也算不合格')
			assert.ok(plan.moduleProblems.some((p) => p.id === 'a_two'), '后声明的一方算不合格')
		})
	})

	await check('S07', () => {
		return withExtraMods([shadowMod({ id: 'a_toolname', tools: ['bad_tool'] })], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			const legacy = '工具名不符合本插件约定（whale_ 前缀）：bad_tool'
			assert.ok(plan.problems.includes(legacy), `非 whale_ 前缀被拦下且用旧文案（${plan.problems.join(' | ')}）`)
		})
	})

	await check('S08', () => {
		// 缺 version / 空白 version 都要拦（契约新增项）
		const noVer = { id: 'a_nover', tools: [], install() {} }
		const blankVer = shadowMod({ id: 'a_blankver', version: '   ' })
		return withExtraMods([noVer, blankVer], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			assert.ok(plan.problems.some((p) => p.includes('a_nover') && /version/.test(p)), `缺 version 被拦下（${plan.problems.join(' | ')}）`)
			assert.ok(plan.problems.some((p) => p.includes('a_blankver') && /version/.test(p)), '空白 version 被拦下')
		})
	})

	await check('S09', () => {
		// tools 声明必须是数组（写成字符串会被逐字符当成工具名）
		return withExtraMods([shadowMod({ id: 'a_tools', tools: 'whale_t14_x' })], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			assert.ok(plan.problems.some((p) => p.includes('a_tools') && /tools 必须是数组/.test(p)), `tools 非数组被拦下（${plan.problems.join(' | ')}）`)
		})
	})

	await check('S10', () => {
		return withExtraMods([{ id: 'a_dead', version: '1.0.0', tools: [] }], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			const legacy = '模块 a_dead 既没有 install 也没有 boot'
			assert.ok(plan.problems.includes(legacy), `既无 install 也无 boot 被拦下且用旧文案（${plan.problems.join(' | ')}）`)
		})
	})

	await check('S11', () => {
		// enabled 里有个根本没有模块文件的 id
		return withTableMutation(() => { manifest.mods.enabled.push('ghost_mod') }, () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			const legacy = 'enabled 里的 "ghost_mod" 没有对应模块文件'
			assert.ok(plan.problems.includes(legacy), `没对应模块文件被拦下且用旧文案（${plan.problems.join(' | ')}）`)
			assert.ok(!plan.mods.some((m) => m.id === 'ghost_mod'), '没文件的模块不会进装载表')
		})
	})

	await check('S12', () => {
		// 一个模块同时踩两条旧契约：既有文案必须**同时**出现（只增不改）
		const broken = { id: '2bad' } // 非法 id + 既无 install 也无 boot
		return withExtraMods([broken], () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			assert.ok(plan.problems.includes('模块 id 不合法："2bad"'), `旧文案①逐字保留（${plan.problems.join(' | ')}）`)
			assert.ok(plan.problems.includes('模块 2bad 既没有 install 也没有 boot'), '旧文案②逐字保留')
		})
	})

	await check('S13', () => {
		// moduleProblems 是 problems 的逐模块投影：每一段都能在 problems 里逐字找到，且 id 都来自被挑中的模块
		const bad = [shadowMod({ id: '3bad', tools: 'not-array' }), shadowMod({ id: 'a_ok2', tools: ['bad_tool'] })]
		return withExtraMods(bad, () => {
			const plan = selectMods({ log: { error: () => {} } })
			eq(plan.ok, false)
			const pickedIds = new Set(plan.mods.map((m) => m.id))
			for (const mp of plan.moduleProblems) {
				assert.ok(pickedIds.has(mp.id), `归因的 id 来自被挑中的模块（${mp.id}）`)
				for (const part of String(mp.problem).split('；')) {
					assert.ok(plan.problems.includes(part), `归因里的每一段都在 problems 里逐字存在：${part}`)
				}
			}
			const attributed = new Set(plan.moduleProblems.flatMap((mp) => String(mp.problem).split('；')))
			for (const p of plan.problems) {
				if (/^enabled 里的/.test(p)) continue // 这条没有模块条目，只能进 problems
				assert.ok(attributed.has(p), `problems 里每条模块问题都有归因：${p}`)
			}
		})
	})

	/* ══════════════════════════ A 组：装载事务 ══════════════════════════ */

	await check('A01', async () => {
		// 反空转哨兵：真表 + 一个探针模块，装完必须**逐条 installed**（没有假红）
		captured = null
		const spy = shadowMod({ id: 'a_spy', install(h) { captured = h } })
		await withExtraMods([spy], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config())
			assert.ok(captured, '探针模块拿到了 apply 上下文')
			eq(captured.mods.map((m) => m.id), enabledModules())
			eq(captured.mods.filter((m) => m.state !== 'installed'), [])
			assert.ok(captured.mods.every((m) => !('error' in m)), '成功的不带 error 字段')
			eq(h.names().length, 19) // 18 个模块工具 + whale_ping
			assert.ok(h.names().includes('whale_ping'), '干净装载时存活探针也在')
			observations.push({ case: 'A01', tools: h.names() })
			await cleanup()
			eq(h.names(), [])
		})
	})

	await check('A02', async () => {
		// 缺 output：这个 def 一次都不许进注册表（零半注册），整批回滚
		captured = null
		const first = shadowMod({ id: 'a_first', tools: ['whale_t14_a'], install(h) { captured = h; h.registerTool(toolDef('whale_t14_a')) } })
		const bad = shadowMod({ id: 'a_bad', tools: ['whale_t14_b'], install(h) { h.registerTool(drop(toolDef('whale_t14_b'), 'output')) } })
		await withShadowTable([first, bad], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config())
			const byId = Object.fromEntries(captured.mods.map((m) => [m.id, m]))
			eq(byId.a_bad.state, 'failed')
			assert.match(byId.a_bad.error, /output 必须是对象/)
			eq(byId.a_first.state, 'failed', '整批回滚：先前装上的不许继续宣称成功')
			assert.match(byId.a_first.error, /整批回滚/)
			eq(h.names(), [], '零半注册资源')
			assert.ok(!h.history.includes('whale_t14_b'), '不合格的 def 从来没进过注册表')
			assert.ok(h.history.includes('whale_t14_a'), '反空转：前一个模块确实注册过（否则"回收"是空的）')
			assert.ok(!h.names().includes('whale_ping'), '装载失败不注册存活探针')
			observations.push({ case: 'A02', history: h.history, states: captured.mods.map((m) => [m.id, m.state, m.error]) })
			await cleanup()
			eq(h.names(), [])
		})
	})

	// registerTool 的五项：逐项注入不合格（判据形状一致，免得手工复制出错）
	const fieldCases = [
		['A03', 'name', () => ({ ...toolDef('whale_t14_b'), name: '' }), /name 必须是非空字符串/],
		['A04', 'description', () => drop(toolDef('whale_t14_b'), 'description'), /description 必须是非空字符串/],
		['A05', 'parameters', () => ({ ...toolDef('whale_t14_b'), parameters: [] }), /parameters 必须是对象/],
		['A06', 'output.render', () => ({ ...toolDef('whale_t14_b'), output: { schema: { type: 'object' }, render: 'not-a-fn' } }), /output\.render 必须是函数/],
		['A07', 'execute', () => ({ ...toolDef('whale_t14_b'), execute: 'not-a-fn' }), /execute 必须是函数/],
	]
	for (const [id, field, make, expect] of fieldCases) {
		await check(id, async () => {
			captured = null
			const first = shadowMod({ id: 'a_first', tools: ['whale_t14_a'], install(h) { captured = h; h.registerTool(toolDef('whale_t14_a')) } })
			const bad = shadowMod({ id: 'a_bad', tools: ['whale_t14_b'], install(h) { h.registerTool(make()) } })
			await withShadowTable([first, bad], async () => {
				const h = host()
				const cleanup = apply(h.ctx, config())
				const byId = Object.fromEntries(captured.mods.map((m) => [m.id, m]))
				eq(byId.a_bad.state, 'failed', `${field} 不合格 ⇒ 模块 failed`)
				assert.match(byId.a_bad.error, expect, `${field} 的失败原因要指名道姓（${byId.a_bad.error}）`)
				eq(byId.a_first.state, 'failed')
				eq(h.names(), [], `${field}：整批归零`)
				assert.ok(!h.history.includes('whale_t14_b'), `${field}：不合格的 def 没进过注册表`)
				await cleanup()
				eq(h.names(), [])
			})
		})
	}

	await check('A08', async () => {
		// install 中途抛错：抛之前注册的工具必须被回收
		captured = null
		const boom = shadowMod({
			id: 'a_boom',
			tools: ['whale_t14_boom'],
			install(h) { captured = h; h.registerTool(toolDef('whale_t14_boom')); throw new Error('boom-by-design') },
		})
		const later = shadowMod({ id: 'a_later', tools: ['whale_t14_later'], install(h) { h.registerTool(toolDef('whale_t14_later')) } })
		await withShadowTable([boom, later], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config())
			const byId = Object.fromEntries(captured.mods.map((m) => [m.id, m]))
			eq(byId.a_boom.state, 'failed')
			eq(byId.a_boom.error, 'boom-by-design')
			eq(byId.a_later.state, 'planned', '失败之后的模块保持 planned（不许记 installed）')
			eq(h.names(), [], '抛错前注册的资源被回收')
			assert.ok(h.history.includes('whale_t14_boom'), '反空转：它确实注册过，回收才有意义')
			await cleanup()
			eq(h.names(), [])
		})
	})

	await check('A09', async () => {
		// install 成功、boot 抛错：同样整批失败并回收
		captured = null
		const badBoot = shadowMod({
			id: 'a_boot',
			tools: ['whale_t14_boot'],
			install(h) { captured = h; h.registerTool(toolDef('whale_t14_boot')) },
			boot() { throw new Error('boot-by-design') },
		})
		await withShadowTable([badBoot], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config())
			eq(captured.mods[0].state, 'failed')
			eq(captured.mods[0].error, 'boot-by-design')
			eq(h.names(), [])
			assert.ok(h.history.includes('whale_t14_boot'), '反空转：install 阶段确实注册过')
			await cleanup()
		})
	})

	await check('A10', async () => {
		// 卡面「补充」的原话：第二个模块安装抛错后，**第一个模块的资源也须归零**
		captured = null
		const first = shadowMod({ id: 'a_first', tools: ['whale_t14_a'], install(h) { captured = h; h.registerTool(toolDef('whale_t14_a')) } })
		const second = shadowMod({ id: 'a_second', tools: ['whale_t14_b'], install() { throw new Error('second-module-install-failed') } })
		const third = shadowMod({ id: 'a_third', tools: ['whale_t14_c'], install(h) { h.registerTool(toolDef('whale_t14_c')) } })
		await withShadowTable([first, second, third], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config())
			const states = captured.mods.map((m) => [m.id, m.state])
			eq(states, [['a_first', 'failed'], ['a_second', 'failed'], ['a_third', 'planned']])
			eq(h.names(), [], '第一个模块的资源也归零（零半注册）')
			assert.ok(h.history.includes('whale_t14_a'), '反空转：第一个模块确实注册成功过')
			assert.ok(!h.history.includes('whale_t14_c'), '第三个模块一次都没装（不许继续宣称装载）')
			observations.push({ case: 'A10', history: h.history, states })
			await cleanup()
			eq(h.names(), [])
		})
	})

	// 计划被拒（整批拒装）：一个模块都不跑 ⇒ 外面拿不到 apply 上下文里的 hctx.mods，
	// 但失败状态**照原样**进了日志 —— 失败行就是 hctx.mods 的投影（id + 原因 + 未装载数），
	// 所以这里的判据落在"拒装 + 零注册 + 日志逐条点名"上。
	const planCases = [
		['A11', '非法 id', [shadowMod({ id: 'a_ok', tools: ['whale_t14_ok'] }), shadowMod({ id: 'Bad-Name' })], 'Bad-Name', /模块 id 不合法/],
		['A12', '重复 id', [shadowMod({ id: 'dup_mod', tools: ['whale_t14_one'] }), shadowMod({ id: 'dup_mod', tools: ['whale_t14_two'] })], 'dup_mod', /模块 id 撞车/],
		['A13', '重复工具', [shadowMod({ id: 'a_one', tools: ['whale_t14_dup'] }), shadowMod({ id: 'a_two', tools: ['whale_t14_dup'] })], 'a_one', /工具名撞车/],
	]
	for (const [id, label, entries, badId, expect] of planCases) {
		await check(id, async () => {
			captured = null
			await withShadowTable(entries, async () => {
				const h = host()
				const cleanup = apply(h.ctx, config())
				eq(captured, null, '计划被拒 ⇒ 一个模块都没跑（探针拿不到上下文）')
				eq(h.names(), [], `${label}：一个工具都没注册`)
				const lines = logLines(h)
				assert.ok(lines.some((l) => /整批拒绝装载/.test(l)), `拒装要明说（${lines.join(' | ')}）`)
				const failLine = lines.find((l) => /装载失败 \d+ 个：/.test(l))
				assert.ok(failLine, `失败状态进了日志（${lines.join(' | ')}）`)
				assert.ok(failLine.includes(badId), `失败行点到了模块 id（${failLine}）`)
				assert.match(failLine, expect, `失败行带原因（${failLine}）`)
				const modLine = lines.find((l) => l.includes('装载模块：'))
				assert.ok(modLine && /装载模块：（无）/.test(modLine), `「装载模块：」那行只列 installed（${modLine}）`)
				assert.ok(!modLine.includes(badId), '失败的不许混进「装载模块：」那行')
				observations.push({ case: id, log: lines.filter((l) => /装载/.test(l)) })
				await cleanup()
			})
		})
	}

	await check('A14', async () => {
		// 卸载幂等：apply 返回的 cleanup 与 ctx.effect 两条路径（含重复调用）只清一次、不抛
		captured = null
		const one = shadowMod({ id: 'a_first', tools: ['whale_t14_a'], install(h) { captured = h; h.registerTool(toolDef('whale_t14_a')) } })
		await withShadowTable([one], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config())
			eq(h.names(), ['whale_t14_a', 'whale_ping'])
			await cleanup()
			eq(h.names(), [])
			await cleanup() // 第二次
			eq(h.names(), [])
			await h.unload() // ctx.effect 那条路径再清一次
			eq(h.names(), [])
			await h.unload()
			eq(h.names(), [])
		})
	})

	await check('A15', async () => {
		// 宿主只有 ctx.on（没有 ctx.effect）时：dispose 事件也能清干净，重复触发不出错
		captured = null
		const one = shadowMod({ id: 'a_first', tools: ['whale_t14_a'], install(h) { captured = h; h.registerTool(toolDef('whale_t14_a')) } })
		await withShadowTable([one], async () => {
			const h = host({ effect: false, on: true })
			apply(h.ctx, config())
			eq(h.names(), ['whale_t14_a', 'whale_ping'])
			await h.emitDispose()
			eq(h.names(), [])
			await h.emitDispose()
			eq(h.names(), [])
		})
	})

	await check('A16', async () => {
		// status 卡（**有 apply 上下文**）只报真装载状态：失败批次不许把配置数说成已装载
		captured = null
		const okFirst = shadowMod({
			id: 'a_first',
			tools: ['whale_t14_first'],
			install(h) { captured = h; h.registerTool(toolDef('whale_t14_first')) },
		})
		const boom = shadowMod({
			id: 'a_boom',
			tools: ['whale_t14_boom'],
			install(h) { h.registerTool(toolDef('whale_t14_boom')); throw new Error('boom-by-design') },
		})
		const three = shadowMod({ id: 'a_three', tools: ['whale_t14_three'], install(h) { h.registerTool(toolDef('whale_t14_three')) } })
		await withShadowTable([okFirst, boom, three], async () => {
			const h = host()
			apply(h.ctx, config({ packRoot: packDir }))
			assert.ok(captured, '拿到了真 apply 上下文')
			eq(captured.paths.packRoot, path.resolve(packDir))
			// 用**真 apply 的 hctx.mods** 驱动 status（captured 自己的 scope 已倒，另给一个薄挂载面）
			const row = await statusRow({
				paths: { packRoot: packDir, root: path.join(fixture, 'data') },
				log: { info() {}, warn() {}, error() {} },
				mods: captured.mods,
			}, '已装载模块')
			assert.ok(row.value.startsWith('0 个：'), `装的 0 个就报 0 个（${row.value}）`)
			eq(row.state, 'error', '有失败 ⇒ error（客户端照它上色）')
			assert.ok(row.value.includes('a_boom'), '失败模块点名')
			assert.ok(row.value.includes('boom-by-design'), '失败原因带上')
			assert.ok(row.value.includes('失败 2 个') && row.value.includes('a_first'), '被回滚的也如实算失败（不许写成已装载）')
			assert.ok(row.value.includes('未装载 1 个'), `没装的如实算"未装载"（${row.value}）`)
			observations.push({ case: 'A16', row })
		})
	})

	await check('A17', async () => {
		// status 卡（**没有 apply 上下文**）：拿不到安装事实就如实标注，不许把配置表当安装事实
		const n = enabledModules().length
		const row = await statusRow({
			paths: { packRoot: packDir, root: path.join(fixture, 'data') },
			log: { info() {}, warn() {}, error() {} },
		}, '已装载模块')
		assert.ok(row.value.startsWith(`${n} 个：`), `旧判据的形状保留：以「${n} 个」开头（${row.value}）`)
		eq(row.state, 'warn', '未经 apply ⇒ warn（不是 ok）')
		assert.ok(/未经 apply/.test(row.value) && /安装状态未知/.test(row.value), `如实标注这是配置而非安装事实（${row.value}）`)
	})

	await check('A18', async () => {
		// 日志只报真实状态：`装载模块：` 只列 installed；失败单独一行给出 id + 原因
		captured = null
		const first = shadowMod({ id: 'a_first', tools: ['whale_t14_a'], install(h) { captured = h; h.registerTool(toolDef('whale_t14_a')) } })
		const bad = shadowMod({ id: 'a_bad', tools: ['whale_t14_b'], install(h) { h.registerTool(drop(toolDef('whale_t14_b'), 'output')) } })
		await withShadowTable([first, bad], async () => {
			const h = host()
			const cleanup = apply(h.ctx, config({ announceOnBoot: true }))
			const lines = logLines(h)
			const modLines = lines.filter((l) => l.includes('装载模块：'))
			eq(modLines.length, 1, `只打一行「装载模块：」（${lines.join(' | ')}）`)
			assert.ok(/装载模块：（无）$/.test(modLines[0]), `失败批次里 installed 是空的，这一行只许列 installed（${modLines[0]}）`)
			assert.ok(!modLines[0].includes('a_first') && !modLines[0].includes('a_bad'), '被回滚的与失败的都不许出现在这一行')
			const failLine = lines.find((l) => /装载失败 \d+ 个：/.test(l))
			assert.ok(failLine, '有 failed 就要有失败行')
			assert.ok(failLine.includes('a_bad') && failLine.includes('output 必须是对象'), `失败行给出 id 与原因（${failLine}）`)
			assert.ok(failLine.includes('a_first') && failLine.includes('整批回滚'), `被回滚的也如实列出（${failLine}）`)
			assert.ok(lines.some((l) => /装载\*\*未\*\*完成/.test(l)), 'announceOnBoot 打开时也不许说"装载完成"')
			observations.push({ case: 'A18', lines: lines.filter((l) => /装载/.test(l)) })
			await cleanup()
		})
	})

	await check('A19', async () => {
		// moduleTableDrift 的语义不许被这次改动带跑：它比的是**配置漂移**，不是安装结果
		const same = path.join(fixture, 'mods-same.js')
		fs.writeFileSync(same, "export const manifest = {\n\tmods: {\n\t\tenabled: ['a', 'b'],\n\t},\n}\n", 'utf8')
		const other = path.join(fixture, 'mods-other.js')
		fs.writeFileSync(other, "export const manifest = {\n\tmods: {\n\t\tenabled: ['a', 'b', 'c'],\n\t},\n}\n", 'utf8')
		eq(moduleTableDrift(['a', 'b'], same), null)
		eq(moduleTableDrift(['a', 'b'], other), { disk: ['a', 'b', 'c'], mem: ['a', 'b'] })
		eq(moduleTableDrift(['a', 'b'], path.join(fixture, '不存在.js')), null)
	})
} catch (e) {
	fatal = e?.stack || String(e)
}

/* 影子表还原是否彻底的**独立**校验（不靠上面 try/finally 自觉） */
try {
	if (mods.length === 0) throw new Error('影子表还原失败：mods 被清空了')
	if (manifest.mods.enabled.length === 0) throw new Error('影子表还原失败：enabled 被清空了')
	if (JSON.stringify(mods.map((m) => m.id)) !== JSON.stringify(manifest.mods.enabled)) {
		throw new Error('影子表还原失败：mods 与 enabled 不再一致')
	}
} catch (e) {
	fatal ??= e?.stack || String(e)
}

if (JSON.stringify(records.map((r) => r.id)) !== JSON.stringify(IDS)) fatal ??= 'fixed case ID set mismatch'
const failed = records.filter((r) => r.status === 'fail').length + (fatal ? 1 : 0)
const verdict = failed ? 'FAIL' : 'PASS'
const result = {
	verdict,
	label: 'T14',
	checks: records.length,
	failed,
	skipped: 0,
	ids: IDS,
	hashes,
	records,
	observations,
	fatal: fatal ?? null,
	fixture,
}
const out = path.join(evidence, `run-${stamp}.json`)
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8')

// 失败时保留夹具便于诊断；成功时只删本次 mkdtemp 出来的那个绝对目录
if (!failed) {
	const abs = path.resolve(fixture)
	if (path.dirname(abs) !== path.resolve(base) || !path.basename(abs).startsWith('whale-T14-')) {
		throw new Error('unsafe fixture cleanup')
	}
	fs.rmSync(abs, { recursive: true, force: true })
}

console.log(`${verdict} T14 checks=${records.length} failed=${failed} skipped=0`)
if (failed) {
	for (const r of records.filter((x) => x.status === 'fail')) console.log(`  FAIL ${r.id}: ${String(r.error).split('\n')[0]}`)
	if (fatal) console.log(`  FATAL ${String(fatal).split('\n')[0]}`)
	console.log(`  evidence: ${out}`)
}
process.exit(failed ? 1 : 0)
