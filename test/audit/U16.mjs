/**
 * test/audit/U16.mjs —— U16（前端与调用边界）的**行为**判据
 * ======================================================================
 * 卡片：`cards/U16.md`。目标只有一句：**浏览器侧与工具调用侧不再自行截断身份**，
 * 且写请求送达正确实体。八项 A01–A08 全部是**真断言**（真跑代码、真读回执、真比字节），
 * 不是 grep，也不是"计划即报告"。
 *
 * 为什么不用真浏览器：本环境没有可用的浏览器/宿主（`cards/U16.md` 明说"无真实浏览器"）。
 * 所以：
 *   · 浏览器半边 `lib/client.js` 用**真源码** + 迷你 React/模块加载器桩加载并**驱动**；
 *   · 课程包页面脚本（`assets/*.js`）用**声明式 DOM 桩**驱动（桩上打 `__simulated` 标记）；
 *   · 宿主侧一律走**真路由函数**（`mods/*.js` 的 `install()` + 真 `Request`）。
 * 任何"真实浏览器 / 真实宿主验收"的说法都不许从这里冒出来 —— 见 A08。
 *
 * 守卫（本文件自己实现，判据落本卡 `audit-evidence/U16/`）：
 *   ① **进程内 fs 写守卫**：拦 write/append/mkdir/cp/rename/rm，写点必须落在
 *      {本卡写集 ∪ 证据根 ∪ E:\\Temp 本卡唯一目录}；越界当场抛。
 *   ② **活包/主树读守卫**：读 `E:\\workplace\\study`（活包）与 `E:\\workplace\\dsh-whale-sensei`（主树）直接抛。
 *   ③ **运行时解析** `docs/unify/interfaces.md` §6 的 U16 授权并集（tracked ⊆ 并集）。
 *   ④ **运行期自锚**：本卡写集在运行开始时与收口前各算一次 sha256，两次必须相同。
 *
 * 判词（`test/audit/unify-runner.mjs`）：
 *   PASS U16 checks=8 failed=0 skipped=0      → exit 0
 *   FAIL U16 ...                             → exit 1
 *   BLOCKED U16 ...                          → exit 2
 *
 * 参数：`--evidence-root=<绝对路径>` 只改证据落点（限本卡新目录 / 临时目录）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { runCard, printVerdict, writeRunEvidence, resolveEvidenceRoot, safeRemoveTree, REPO } from './unify-runner.mjs'
import { Blocked, Truncated } from './unify-runner.mjs'

const CARD = 'U16'
const argv = process.argv.slice(2)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const fileSha = (abs) => sha256(fs.readFileSync(abs))

/* ───────────────────────────── 本卡写集（逐字来自 cards/U16.md） ───────────────────────────── */

/** 相对仓根的十三个落点 + 本卡两个新文件（15 条；证据根另算，见 allowedWriteRoots）。 */
const WRITE_SET_REL = Object.freeze([
	'lib/client.js',
	'lib/starter.js',
	'lib/mods/catalog.js',
	'lib/mods/goal.js',
	'lib/mods/intake.js',
	'lib/mods/starter.js',
	'lib/mods/pack.js',
	'lib/mods/lessonpack.js',
	// 决策 决-3 收编：导出链路的身份构造/解析归本卡（§6 的 U16 行已登记；
	// 依据 docs/unify/authorization.json 的 decisions.approvedChanged「全按推荐」）。
	'lib/pack-export.js',
	'lib/pack-template/assets/ask.js',
	'lib/pack-template/assets/notes.js',
	'lib/pack-template/assets/adjust.js',
	'lib/pack-template/starmap/main.js',
	'test/audit/U16.mjs',
	'docs/unify/receipts/U16.json',
])
const WRITE_SET = WRITE_SET_REL.map((rel) => path.resolve(REPO, ...rel.split('/')))

const evRoot = resolveEvidenceRoot(argv, CARD, { repoRoot: REPO })
const EVIDENCE_ROOT = evRoot.ok ? evRoot.root : path.join(REPO, 'audit-evidence', CARD, 'runs', `${CARD}-blocked`)
const TEMP_PARENT = path.resolve('E:\\Temp')
const TEMP_ROOT = path.join(TEMP_PARENT, `${CARD}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`)

/** 禁止访问的两个只读世界（活包 + 审计主树） */
const FORBIDDEN_READ_ROOTS = [
	path.resolve('E:\\workplace\\study'),
	path.resolve('E:\\workplace\\dsh-whale-sensei'),
]

const isUnder = (child, parent) => {
	const a = path.resolve(String(child))
	const b = path.resolve(String(parent))
	return a === b || a.startsWith(b + path.sep)
}
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function flush(times = 4) {
	for (let i = 0; i < times; i++) await sleep(0)
}

/**
 * 判词行必须是 stdout **唯一**的一行（unify-runner 的契约）。被测的 `lib/client.js`
 * 自己有 `console.log`（真浏览器里是给排障用的），桩上跑它就会把无关行吐到 stdout ——
 * 所以探针期间把 console 收进证据、不落 stdout，跑完原样还原。
 */
const consoleLog = []
async function withQuietConsole(fn) {
	const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error }
	console.log = (...a) => { consoleLog.push(a.map(String).join(' ')) }
	console.info = console.log
	console.warn = console.log
	console.error = console.log
	try {
		return await fn()
	} finally {
		Object.assign(console, saved)
	}
}
class BlockedCase extends Blocked {}

/* ───────────────────────────── ① fs 写守卫（本进程内） ───────────────────────────── */

const guard = { installed: false, writes: [], reads: [], violations: [], trips: [], orig: null }

function allowedWriteRoots() {
	return [EVIDENCE_ROOT, TEMP_ROOT]
}
function isAllowedWrite(abs) {
	if (WRITE_SET.includes(abs)) return true
	return allowedWriteRoots().some((root) => isUnder(abs, root))
}

function installFsGuard() {
	if (guard.installed) return
	const orig = (guard.orig = {
		writeFileSync: fs.writeFileSync,
		appendFileSync: fs.appendFileSync,
		mkdirSync: fs.mkdirSync,
		cpSync: fs.cpSync,
		renameSync: fs.renameSync,
		rmSync: fs.rmSync,
		writeFile: fs.writeFile,
		appendFile: fs.appendFile,
		copyFile: fs.copyFile,
		readFileSync: fs.readFileSync,
		readdirSync: fs.readdirSync,
		existsSync: fs.existsSync,
		statSync: fs.statSync,
	})
	const checkWrite = (fnName, p) => {
		const abs = path.resolve(String(p))
		if (!isAllowedWrite(abs)) {
			guard.violations.push(`${fnName} ${abs}`)
			throw new Error(`U16 写守卫拒绝越界写（${fnName}）：${abs}`)
		}
		guard.writes.push(`${fnName} ${abs}`)
		return abs
	}
	const checkRead = (fnName, p) => {
		const abs = path.resolve(String(p))
		for (const root of FORBIDDEN_READ_ROOTS) {
			if (isUnder(abs, root)) {
				guard.violations.push(`READ ${abs}`)
				throw new Error(`U16 读守卫拒绝访问只读世界（${fnName}）：${abs}`)
			}
		}
		guard.reads.push(abs)
		return abs
	}
	fs.writeFileSync = function (p, ...rest) { checkWrite('writeFileSync', p); return orig.writeFileSync.call(fs, p, ...rest) }
	fs.appendFileSync = function (p, ...rest) { checkWrite('appendFileSync', p); return orig.appendFileSync.call(fs, p, ...rest) }
	fs.mkdirSync = function (p, ...rest) { checkWrite('mkdirSync', p); return orig.mkdirSync.call(fs, p, ...rest) }
	fs.cpSync = function (src, dst, ...rest) { checkWrite('cpSync', dst); return orig.cpSync.call(fs, src, dst, ...rest) }
	fs.renameSync = function (a, b, ...rest) { checkWrite('renameSync', b); return orig.renameSync.call(fs, a, b, ...rest) }
	fs.rmSync = function (p, ...rest) { checkWrite('rmSync', p); return orig.rmSync.call(fs, p, ...rest) }
	fs.writeFile = function (p, data, ...rest) { checkWrite('writeFile', p); return orig.writeFile.call(fs, p, data, ...rest) }
	fs.appendFile = function (p, data, ...rest) { checkWrite('appendFile', p); return orig.appendFile.call(fs, p, data, ...rest) }
	fs.copyFile = function (a, b, ...rest) { checkWrite('copyFile', b); return orig.copyFile.call(fs, a, b, ...rest) }
	fs.readFileSync = function (p, ...rest) { checkRead('readFileSync', p); return orig.readFileSync.call(fs, p, ...rest) }
	fs.readdirSync = function (p, ...rest) { checkRead('readdirSync', p); return orig.readdirSync.call(fs, p, ...rest) }
	fs.existsSync = function (p) { checkRead('existsSync', p); return orig.existsSync.call(fs, p) }
	fs.statSync = function (p, ...rest) { checkRead('statSync', p); return orig.statSync.call(fs, p, ...rest) }
	guard.installed = true
}

/** 故意撞一次守卫（证明它真的会拦、且**写之前**就拦），只在证据里留痕 */
function proveGuardTrips() {
	const target = path.resolve(REPO, 'lib', 'render.js') // 不在本卡写集：只读
	const before = fs.readFileSync(target)
	let threw = null
	try {
		fs.writeFileSync(target, 'U16 guard trip\n')
	} catch (e) {
		threw = String(e?.message ?? e)
	}
	const after = fs.readFileSync(target)
	const trip = { target: path.relative(REPO, target), threw, unchanged: Buffer.compare(before, after) === 0 }
	guard.trips.push(trip)
	const idx = guard.violations.findIndex((v) => v.includes(target))
	if (idx >= 0) guard.violations.splice(idx, 1) // 这一条是**故意**撞的
	return trip
}

/* ───────────────────────────── ② 迷你 React（只够驱动 client.js 的组件） ───────────────────────────── */

function createMiniReact() {
	const hooks = new Map() // Comp -> { slots: [], deps: [] }
	const runtime = { cleanups: [], dirty: false, pending: [], cursor: null }
	const createElement = (type, props, ...kids) => {
		const p = Object.assign({}, props || {})
		if (kids.length === 1) p.children = kids[0]
		else if (kids.length > 1) p.children = kids
		return { type, props: p, children: kids }
	}
	const hooksOf = () => {
		const c = runtime.cursor
		if (!c) throw new Error('迷你 React：hooks 在组件外被调用')
		return c
	}
	const react = {
		createElement,
		useState(init) {
			const c = hooksOf()
			const i = c.i++
			if (!(i in c.slots)) c.slots[i] = init
			const set = (v) => {
				c.slots[i] = typeof v === 'function' ? v(c.slots[i]) : v
				runtime.dirty = true
			}
			return [c.slots[i], set]
		},
		useRef(init) {
			const c = hooksOf()
			const i = c.i++
			if (!(i in c.slots)) c.slots[i] = { current: init }
			return c.slots[i]
		},
		useEffect(fn, deps) {
			const c = hooksOf()
			const i = c.i++
			const prev = c.deps[i]
			const changed = prev === undefined
				|| !Array.isArray(deps)
				|| !Array.isArray(prev)
				|| deps.length !== prev.length
				|| deps.some((d, k) => d !== prev[k])
			if (changed) {
				c.deps[i] = Array.isArray(deps) ? deps.slice() : null
				runtime.pending.push(fn)
			}
		},
	}

	function renderNode(node) {
		if (node === null || node === undefined || node === false || node === true) return null
		if (typeof node === 'string' || typeof node === 'number') return String(node)
		if (Array.isArray(node)) {
			const out = []
			for (const n of node) {
				const r = renderNode(n)
				if (r === null) continue
				if (Array.isArray(r)) out.push(...r)
				else out.push(r)
			}
			return out
		}
		const { type, props, children } = node
		if (typeof type === 'function') {
			const rec = hooks.get(type) || { slots: [], deps: [] }
			hooks.set(type, rec)
			const frame = { i: 0, slots: rec.slots, deps: rec.deps }
			const prev = runtime.cursor
			runtime.cursor = frame
			let out
			try { out = type(props) } finally { runtime.cursor = prev }
			return renderNode(out)
		}
		const kids = (children && children.length ? children : (props.children !== undefined ? [].concat(props.children) : []))
		const rendered = []
		for (const k of kids) {
			const r = renderNode(k)
			if (r === null) continue
			if (Array.isArray(r)) rendered.push(...r)
			else rendered.push(r)
		}
		return { type: String(type), props, children: rendered }
	}

	return {
		react,
		seed(Comp, slots) { hooks.set(Comp, { slots: slots.slice(), deps: [] }) },
		render(Comp, props) {
			runtime.pending = []
			runtime.dirty = false
			const tree = renderNode(createElement(Comp, props))
			return { tree, effects: runtime.pending.slice() }
		},
		async settle(Comp, props, { rounds = 12 } = {}) {
			let tree = null
			for (let i = 0; i < rounds; i++) {
				const out = this.render(Comp, props)
				tree = out.tree
				const effects = out.effects
				for (const fn of effects) {
					const cleanup = fn()
					if (typeof cleanup === 'function') runtime.cleanups.push(cleanup)
				}
				await flush()
				if (effects.length === 0 && runtime.dirty === false) return tree
			}
			return tree
		},
		dispose() {
			for (const fn of runtime.cleanups.splice(0)) {
				try { fn() } catch { /* 清理失败不影响判据 */ }
			}
		},
	}
}

function walk(node, visit) {
	if (node === null || node === undefined) return
	if (typeof node === 'string') return
	if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return }
	visit(node)
	for (const k of node.children || []) walk(k, visit)
}
function nodeText(node) {
	if (node === null || node === undefined) return ''
	if (typeof node === 'string') return node
	if (Array.isArray(node)) return node.map(nodeText).join('')
	return (node.children || []).map(nodeText).join('')
}
function findButtons(tree) {
	const out = []
	walk(tree, (n) => { if (n.type === 'button') out.push(n) })
	return out
}

/* ───────────────────────────── ③ 桩：fetch / window / DOM ───────────────────────────── */

function makeWindowStub() {
	return {
		__simulated: true, // 谁也不许把它当真浏览器
		setTimeout(fn, ms) { return setTimeout(fn, ms) },
		clearTimeout(t) { clearTimeout(t) },
		setInterval(fn, ms) { return setInterval(fn, ms) },
		clearInterval(t) { clearInterval(t) },
		open() { /* 不打标签页 */ },
		prompt() { return null },
	}
}

function makeFetchStub(respond) {
	const calls = []
	const fetchImpl = async (url, init) => {
		const call = { url: String(url), method: (init && init.method) || 'GET', body: null }
		if (init && typeof init.body === 'string' && init.body.trim()) {
			try { call.body = JSON.parse(init.body) } catch { call.body = init.body }
		}
		calls.push(call)
		const payload = (await respond(call)) || { ok: true }
		const text = JSON.stringify(payload)
		return {
			ok: payload.ok !== false,
			status: payload.__status || 200,
			text: async () => text,
			json: async () => payload,
		}
	}
	return { fetchImpl, calls }
}

/* ───────────────────────────── ④ 合成课程包（E:\\Temp 下，绝不碰活包） ───────────────────────────── */

const LESSON_META = (number, title) => JSON.stringify({ number, title, terms: {}, source: { label: 'U16 夹具', url: 'https://example.invalid/u16' } })

function buildPack(root, spec) {
	const w = (rel, text) => {
		const abs = path.join(root, ...rel.split('/'))
		fs.mkdirSync(path.dirname(abs), { recursive: true })
		fs.writeFileSync(abs, text)
	}
	fs.mkdirSync(root, { recursive: true })
	w('progress.json', JSON.stringify({ learned: [] }, null, 2) + '\n')
	fs.mkdirSync(path.join(root, 'learning-records'), { recursive: true })
	fs.mkdirSync(path.join(root, 'code'), { recursive: true })
	w('code/.keep', '')
	for (const c of spec.circles) {
		w(`lessons/${c.id}/halo.json`, JSON.stringify({ halo: c.id, name: c.name }, null, 2) + '\n')
		for (const p of c.points) {
			w(`lessons/${c.id}/${p.id}/point.json`, JSON.stringify({ point: p.id, name: p.name, fileBase: p.fileBase || 0, requires: [] }, null, 2) + '\n')
		}
	}
	for (const l of spec.lessons) {
		const base = `${String(l.number).padStart(4, '0')}-hello`
		w(`lessons/src/${l.circle}/${l.point}/${base}.html`,
			`<!doctype html><html><head><script type="application/json" data-lesson-meta>${LESSON_META(l.number, l.title)}</script></head><body>src</body></html>`)
		w(`lessons/${l.circle}/${l.point}/${base}.html`, `<!doctype html><html><body>rendered ${l.circle}/${l.point}/${base}</body></html>`)
	}
	return root
}

const PACK_SPEC = Object.freeze({
	// ⚠️ 两个圆圈里各有一个 **同显示名** 的知识点（`Vue`），但身份不同 —— A01 靠这一对
	circles: [
		{ id: 'programming', name: '编程', points: [{ id: 'vue', name: 'Vue' }, { id: 'spring-boot', name: 'Spring Boot' }] },
		{ id: 'math', name: '数学', points: [{ id: 'vue', name: 'Vue' }] },
	],
	lessons: [
		{ circle: 'programming', point: 'vue', number: 1, title: '第1课 组件' },
		{ circle: 'programming', point: 'spring-boot', number: 1, title: '第1课 起步' },
		{ circle: 'math', point: 'vue', number: 1, title: '第1课 向量' },
	],
})

/* ───────────────────────────── ⑤ 加载被测代码（可从任意 tree 根加载，供 A07 用） ───────────────────────────── */

function loadClientSource(treeRoot, win) {
	const abs = path.join(treeRoot, 'lib', 'client.js')
	const src = fs.readFileSync(abs, 'utf8')
	const loaded = []
	win.__ModuleLoader__ = { load(spec) { loaded.push(spec) } }
	// eslint-disable-next-line no-new-func
	new Function('window', src)(win)
	if (loaded.length !== 1) throw new Error(`lib/client.js 应当恰好 load 一次（实测 ${loaded.length} 次）`)
	return { spec: loaded[0], src, abs, win }
}

/**
 * 把 `lib/client.js` 真装起来：`__ModuleLoader__.load` → `factory(require)` → `apply(ctx)`。
 * @returns {{client:object, registrations:Array, instance:object, spec:object, src:string}}
 */
function mountClient(treeRoot) {
	const win = makeWindowStub()
	const loaded = loadClientSource(treeRoot, win)
	const instance = createMiniReact()
	const primitives = {
		Modal: function Modal(props) {
			return instance.react.createElement('div', { 'data-dsh-modal': true }, props && props.children)
		},
		Button: function Button(props) {
			return instance.react.createElement('button', {
				type: 'button',
				disabled: props && props.disabled,
				onClick: props && props.onClick,
				variant: props && props.variant,
			}, props && props.children)
		},
	}
	const req = (name) => {
		if (name === 'react') return instance.react
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
		throw new Error(`lib/client.js require 了未冻结的包：${name}`)
	}
	const client = loaded.spec.factory(req)
	const registrations = []
	const ctx = {
		slots: {
			inject(name, cb) {
				const dispose = cb()
				return () => { if (typeof dispose === 'function') dispose() }
			},
			register(spec, component) {
				registrations.push({ spec, component })
				return () => {}
			},
		},
	}
	client.apply(ctx)
	return { client, registrations, instance, spec: loaded.spec, src: loaded.src, win: loaded.win }
}

/* ───────────────────────────── ⑥ 宿主侧：真装真调 ───────────────────────────── */

async function mountMod(treeRoot, modRel, packRoot) {
	const url = pathToFileURL(path.join(treeRoot, 'lib', 'mods', modRel)).href
	const mod = await import(url)
	const routes = []
	const tools = []
	mod.plugin.install({
		paths: { packRoot },
		log: { info() {}, warn() {}, error() {} },
		registerTool: (def) => { tools.push(def); return () => {} },
		inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	})
	return { plugin: mod.plugin, routes, tools }
}

const jsonOf = async (res) => ({ status: res.status, body: await res.json() })
function callRoute(route, url, init) {
	return route.fetch(new Request(`http://127.0.0.1:3090${url}`, init))
}

/* ───────────────────────────── ⑦ 共享夹具 ───────────────────────────── */

const shared = { promise: null }

function setup() {
	if (shared.promise) return shared.promise
	shared.promise = (async () => {
		fs.mkdirSync(TEMP_ROOT, { recursive: true })
		const packRoot = buildPack(path.join(TEMP_ROOT, 'packs', 'u16-pack'), PACK_SPEC)
		const catalog = await mountMod(REPO, 'catalog.js', packRoot)
		const catalogRoute = catalog.routes.find((r) => r.path === '/api/whale/catalog')
		if (!catalogRoute) throw new BlockedCase('lib/mods/catalog.js 没有挂出 /api/whale/catalog')
		const cat = await jsonOf(await callRoute(catalogRoute, '/api/whale/catalog', { method: 'GET' }))
		if (!cat.body || cat.body.ok !== true) throw new BlockedCase(`catalog 路由没能读合成课程包：${JSON.stringify(cat.body).slice(0, 200)}`)
		return { packRoot, catalog: cat.body }
	})()
	return shared.promise
}

function pointOf(catalog, circleId, pointId) {
	const c = (catalog.circles || []).find((x) => x.id === circleId)
	if (!c) throw new BlockedCase(`合成课程包里没有圆圈 ${circleId}`)
	const p = (c.points || []).find((x) => x.id === `${circleId}/${pointId}` || x.id === pointId)
	if (!p) throw new BlockedCase(`合成课程包里没有知识点 ${circleId}/${pointId}`)
	return p
}

/* ───────────────────────────── ⑧ 探针：驱动开课弹窗（发送目标） ───────────────────────────── */

/**
 * 驱动 `CourseDialog`：选圆圈 → 点知识点卡片 → 抓住 POST /api/whale/starter 的请求体。
 * 宿主侧路由是**真的**（`mods/starter.js` 装出来的），所以这条探针同时证明"浏览器发什么"
 * 与 "宿主怎么解身份"两端。
 *
 * @param {string} treeRoot 被测树根（A07 的副本也走它）
 * @param {{packRoot:string, catalog:object, circleName:string, pointName:string,
 *          starterBody?:(call:object, real:object)=>object}} cfg
 */
async function probeStarterTargetRaw(treeRoot, cfg) {
	const { catalog } = cfg
	const starter = await mountMod(treeRoot, 'starter.js', cfg.packRoot)
	const starterRoute = starter.routes.find((r) => r.path === '/api/whale/starter')
	if (!starterRoute) throw new BlockedCase('mods/starter.js 没挂出 /api/whale/starter')

	const mounted = mountClient(treeRoot)
	const dialogReg = mounted.registrations.find((r) => r.spec && r.spec.name === 'shell.overlay')
	if (!dialogReg) throw new BlockedCase('lib/client.js 没有注册 shell.overlay（开课弹窗）')
	// composer 桥：让它真的接上，才能证明"失败时一个字都没送进会话"
	const drafts = []
	const submits = []
	const bridgeReg = mounted.registrations.find((r) => r.spec && r.spec.name === 'conversation.input.left')
	const fetchState = { gateCalls: [], starterPosts: [], other: [] }

	const { fetchImpl } = makeFetchStub(async (call) => {
		const url = call.url
		if (url.indexOf('/api/whale/catalog') === 0) return catalog
		if (url.indexOf('/api/whale/starter') === 0) {
			if (call.method === 'POST') {
				const res = await callRoute(starterRoute, '/api/whale/starter', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(call.body || {}),
				})
				const body = await res.json()
				fetchState.starterPosts.push({ request: call.body, response: body })
				if (cfg.starterBody) return cfg.starterBody(call, body)
				return body
			}
			const res = await callRoute(starterRoute, '/api/whale/starter', { method: 'GET' })
			return await res.json()
		}
		if (url.indexOf('/api/whale/gate') === 0) {
			// 门禁是**只读**探针：URL 由客户端决定（A01/A03 比它的身份），
			// 回给界面的是一个"放行"桩 —— 判据要的不是门禁判词本身（那归 U18/T 卡）。
			fetchState.gateCalls.push({ url })
			return {
				ok: true, configured: true, allowed: true, prereq: { ok: true, missing: [] },
				verdict: { allowed: true, code: 'first-lesson', lesson: null, needsReview: [] },
			}
		}
		fetchState.other.push(url)
		return { ok: true }
	})
	const realFetch = globalThis.fetch
	globalThis.fetch = fetchImpl
	try {
		if (bridgeReg) {
			await mounted.instance.settle(bridgeReg.component, {
				inputActions: { setDraft: (t) => drafts.push(String(t)), submit: () => submits.push(1) },
			})
		}
		const Comp = dialogReg.component
		// CourseDialog 的 hook 槽位（按调用顺序）：
		//   0 = useDialogOpen 的 open、1 = 它的订阅 effect、2 = 大 state、3 = dialogReady effect、
		//   4 = load effect、5 = currentJob、6..8 = useRebuildJob、9 = 重建横幅 effect
		const seeds = []
		seeds[0] = true
		seeds[2] = {
			phase: 'idle', entry: null, values: {}, why: null, step: 0, gates: {},
			blocked: false, detecting: false, catalog: null, selectedCircle: null,
			selectedPoint: null, catalogWhy: null,
			newCircle: { open: false, name: '', id: '', saving: false, error: null },
			newPoint: { open: false, name: '', id: '', saving: false, error: null },
			rebuild: null,
		}
		seeds[5] = null
		mounted.instance.seed(Comp, seeds)
		let tree = await mounted.instance.settle(Comp, {})
		const circleBtn = findButtons(tree).find((b) => nodeText(b).indexOf(cfg.circleName) >= 0 && nodeText(b).indexOf('个知识点') >= 0)
		if (!circleBtn) throw new BlockedCase(`开课弹窗没渲染出圆圈「${cfg.circleName}」卡片（可见文本：${JSON.stringify(nodeText(tree).slice(0, 300))}）`)
		circleBtn.props.onClick({ stopPropagation() {} })
		tree = await mounted.instance.settle(Comp, {})
		const pointCandidates = findButtons(tree).filter((b) => nodeText(b).indexOf(cfg.pointName) >= 0)
		const pointBtn = pointCandidates.find((b) => nodeText(b).indexOf('个知识点') < 0 && nodeText(b).indexOf(cfg.circleName) < 0)
		if (!pointBtn) {
			throw new BlockedCase(`开课弹窗没渲染出知识点「${cfg.pointName}」卡片（按钮：${JSON.stringify(pointCandidates.map((b) => nodeText(b)).slice(0, 10))}）`)
		}
		pointBtn.props.onClick({ stopPropagation() {} })
		tree = await mounted.instance.settle(Comp, {})
		await flush(8)
		return { tree, fetchState, finalText: nodeText(tree), drafts, submits }
	} finally {
		globalThis.fetch = realFetch
		mounted.instance.dispose()
	}
}

/* ───────────────────────────── ⑨ 探针：驱动「课程目录」里的导出 ───────────────────────────── */

/** 薄的静音壳（判词行必须是 stdout 唯一一行；client.js 自己的 console.log 收进证据） */
function probeStarterTarget(treeRoot, cfg) { return withQuietConsole(() => probeStarterTargetRaw(treeRoot, cfg)) }
function probeExportTarget(treeRoot, cfg) { return withQuietConsole(() => probeExportTargetRaw(treeRoot, cfg)) }

async function probeExportTargetRaw(treeRoot, cfg) {
	const mounted = mountClient(treeRoot)
	const reg = mounted.registrations.find((r) => r.spec && r.spec.name === 'settings.section' && r.spec.id === 'whale-sensei')
	if (!reg) throw new BlockedCase('lib/client.js 没有注册 settings.section 的「鲸师」一节')
	const calls = []
	const TEACHING = {
		ok: true, configured: true, locked: [], circles: [],
		global: { circle: '*', name: '全局层', items: [], tunables: [], guide: [], freeText: [], block: '', hasSpec: true, own: [] },
	}
	const { fetchImpl } = makeFetchStub(async (call) => {
		calls.push(call)
		const url = call.url
		if (url.indexOf('/api/whale/catalog') === 0) return cfg.catalog
		if (url.indexOf('/api/whale/teaching') === 0) return TEACHING
		if (url.indexOf('/api/whale/status') === 0) return { ok: true, configured: true, version: '0.9.9', sections: [] }
		if (url.indexOf('/api/whale/pack/export') === 0) return { ok: true, name: '鲸师课件-x.zip', note: '已导出' }
		return { ok: true }
	})
	const realFetch = globalThis.fetch
	globalThis.fetch = fetchImpl
	try {
		const Comp = reg.component
		// StatusPanel 的 hook 槽位：0 = state、1 = tick、2 = pick、3 = status effect
		const seeds = []
		seeds[0] = { phase: 'ok', data: { ok: true, configured: true, version: '0.9.9', sections: [] }, at: 'x' }
		seeds[1] = 0
		seeds[2] = null
		mounted.instance.seed(Comp, seeds)
		let tree = await mounted.instance.settle(Comp, {})
		// 展开「课程目录」里那个圆圈（GroupPanel 也画同款开关，所以把带「编程」的都点开）
		for (const b of findButtons(tree).filter((x) => x.props && x.props.className === 'ws-groupToggle' && nodeText(x).indexOf('编程') >= 0)) {
			b.props.onClick({ stopPropagation() {} })
		}
		tree = await mounted.instance.settle(Comp, {})
		const exportBtn = findButtons(tree).find((b) => nodeText(b).trim() === '导出')
		if (!exportBtn) throw new BlockedCase(`「课程目录」里没渲染出「导出」按钮（可见按钮：${JSON.stringify(findButtons(tree).map((b) => nodeText(b).trim()).slice(0, 40))}）`)
		exportBtn.props.onClick({ stopPropagation() {} })
		await flush(8)
		return { exportCall: calls.find((c) => c.url.indexOf('/api/whale/pack/export') === 0), calls, tree }
	} finally {
		globalThis.fetch = realFetch
		mounted.instance.dispose()
	}
}

/** Node 22 的 `navigator` 是只读 getter：必须用 defineProperty 换，并原样还原 */
const globalSlots = new Map()
function setGlobalStub(name, value) {
	if (!globalSlots.has(name)) globalSlots.set(name, Object.getOwnPropertyDescriptor(globalThis, name) || null)
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false })
	return () => {
		const desc = globalSlots.get(name)
		globalSlots.delete(name)
		if (desc) Object.defineProperty(globalThis, name, desc)
		else delete globalThis[name]
	}
}

/* ───────────────────────────── ⑩ 声明式 DOM 桩（跑课程包页面脚本） ───────────────────────────── */

function makeElementStub(tag) {
	const handlers = new Map()
	const qcache = new Map()
	const el = {
		__simulated: true,
		tagName: String(tag || 'div').toUpperCase(),
		className: '',
		style: {},
		children: [],
		hidden: false,
		disabled: false,
		value: '',
		textContent: '',
		innerHTML: '',
		title: '',
		attributes: new Map(),
		__q: qcache,
		setAttribute(k, v) { this.attributes.set(String(k), String(v)) },
		getAttribute(k) { return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null },
		appendChild(child) { this.children.push(child); if (child && !child.parentNode) child.parentNode = el; return child },
		removeChild(child) { this.children = this.children.filter((c) => c !== child) },
		querySelector(sel) {
			if (!qcache.has(sel)) qcache.set(sel, makeElementStub('div'))
			return qcache.get(sel)
		},
		querySelectorAll() { return [] },
		addEventListener(type, fn) {
			if (!handlers.has(type)) handlers.set(type, [])
			handlers.get(type).push(fn)
		},
		removeEventListener() {},
		focus() {},
		select() {},
		click() { this.fire('click') },
		fire(type, ev) {
			const list = handlers.get(type) || []
			for (const fn of list) fn(ev || { target: el, preventDefault() {}, stopPropagation() {} })
			return list.length
		},
		handlers,
		closest() { return null },
		parentNode: null,
	}
	return el
}

/** 薄的静音壳（判词行必须是 stdout 唯一一行；页面脚本的 console 输出收进证据） */
function probeAssetScript(treeRoot, assetRel, cfg) { return withQuietConsole(() => probeAssetScriptRaw(treeRoot, assetRel, cfg)) }

/**
 * 在声明式 DOM 桩上真跑一个课程包页面脚本。
 * @param {string} treeRoot
 * @param {string} assetRel 形如 `lib/pack-template/assets/adjust.js`
 * @param {object} cfg { bodyAttrs, blocks, queryMap, queryAll, pageTitle, location, triggerId, after }
 */
async function probeAssetScriptRaw(treeRoot, assetRel, cfg) {
	const src = fs.readFileSync(path.join(treeRoot, ...assetRel.split('/')), 'utf8')
	const posts = []
	const realFetch = globalThis.fetch
	const fetchImpl = async (url, init) => {
		const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null
		posts.push({ url: String(url), method: (init && init.method) || 'GET', body })
		const payload = { ok: true, adjustSaved: true, code: 'lit', lit: 1, id: '0001', answered: true, answer: '（夹具答案）', section: '夹具' }
		return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
	}
	globalThis.fetch = fetchImpl
	const restores = []
	const elements = new Map()
	const bodyAttrs = new Map(Object.entries(cfg.bodyAttrs || {}))
	const getEl = (id) => {
		if (!elements.has(id)) elements.set(id, makeElementStub('div'))
		return elements.get(id)
	}
	for (const [id, init] of Object.entries(cfg.blocks || {})) {
		const el = getEl(id)
		for (const [k, v] of Object.entries(init.attributes || {})) el.setAttribute(k, v)
		if ('value' in init) el.value = init.value
	}
	const body = makeElementStub('body')
	body.getAttribute = (k) => (bodyAttrs.has(String(k)) ? bodyAttrs.get(String(k)) : null)
	body.setAttribute = (k, v) => { bodyAttrs.set(String(k), String(v)) }
	const documentStub = {
		__simulated: true,
		title: cfg.pageTitle || '第1课：夹具',
		readyState: 'complete',
		body,
		head: makeElementStub('head'),
		documentElement: makeElementStub('html'),
		createElement: (tag) => makeElementStub(tag),
		getElementById: (id) => ((cfg.blocks && Object.prototype.hasOwnProperty.call(cfg.blocks, id)) ? getEl(id) : null),
		querySelector: (sel) => {
			if (cfg.queryMap && Object.prototype.hasOwnProperty.call(cfg.queryMap, sel)) {
				const id = cfg.queryMap[sel]
				return typeof id === 'string' ? getEl(id) : id
			}
			return null
		},
		querySelectorAll: (sel) => (cfg.queryAll && cfg.queryAll[sel]) || [],
		addEventListener() {},
		removeEventListener() {},
		fonts: null,
	}
	const locationStub = Object.assign({ protocol: 'http:', origin: 'http://127.0.0.1:3091', pathname: '/lessons/programming/vue/0001-hello.html' }, cfg.location || {})
	const navigatorStub = { clipboard: { writeText: async () => {} } }
	const localStorageStub = {
		store: new Map(),
		getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
		setItem(k, v) { this.store.set(k, String(v)) },
	}
	const windowStub = {
		__simulated: true, LESSON_ASK_ENDPOINT: '', location: locationStub,
		matchMedia: () => ({ matches: false }), setTimeout, setInterval, clearTimeout, clearInterval, addEventListener() {},
	}
	// 只读 getter（如 Node 22 的 navigator）必须走 defineProperty，收尾原样还原
	restores.push(setGlobalStub('document', documentStub))
	restores.push(setGlobalStub('location', locationStub))
	restores.push(setGlobalStub('navigator', navigatorStub))
	restores.push(setGlobalStub('localStorage', localStorageStub))
	restores.push(setGlobalStub('window', windowStub))
	try {
		// eslint-disable-next-line no-new-func
		const fn = new Function('window', 'document', 'location', 'navigator', 'localStorage', src)
		fn(windowStub, documentStub, locationStub, navigatorStub, localStorageStub)
		await flush(4)
		if (cfg.triggerId) getEl(cfg.triggerId).fire('click')
		await flush(6)
		if (cfg.after) await cfg.after({ documentStub, getEl, posts })
		await flush(4)
		return { posts, documentStub, getEl }
	} finally {
		globalThis.fetch = realFetch
		while (restores.length) restores.pop()()
	}
}

/* ───────────────────────────── ⑪ 运行时解析 interfaces.md §6 的授权并集 ───────────────────────────── */

function readAuthorizedWriteSet() {
	const file = path.join(REPO, 'docs', 'unify', 'interfaces.md')
	if (!fs.existsSync(file)) throw new BlockedCase('缺 docs/unify/interfaces.md（U01 的接口锁）—— 无法解析本卡授权并集')
	const text = fs.readFileSync(file, 'utf8')
	const line = text.split(/\r?\n/).find((l) => /^\|\s*U16\s*\|/.test(l))
	if (!line) throw new BlockedCase('docs/unify/interfaces.md §6 里找不到 U16 那一行')
	const paths = []
	for (const m of line.matchAll(/`([^`]+)`/g)) {
		const raw = m[1].trim().replace(/^[✅†]\s*/, '')
		if (!raw || /\s/.test(raw)) continue
		paths.push(raw)
	}
	return paths
}

/* ───────────────────────────── ⑫ 自锚（本卡写集的 sha256） ───────────────────────────── */

function hashWriteSet() {
	const out = {}
	for (const rel of WRITE_SET_REL) {
		const abs = path.resolve(REPO, ...rel.split('/'))
		out[rel] = fs.existsSync(abs) ? { bytes: fs.statSync(abs).size, sha256: fileSha(abs) } : null
	}
	return out
}

/* ───────────────────────────── 证据累加器 ───────────────────────────── */

const evidence = { probes: {}, guard: null, mutation: null, scope: null, selfAnchor: null }

/* ───────────────────────────── 用例 ───────────────────────────── */

const cases = []

/* ── A01：选择跨圈同名知识点，发送目标不同 ───────────────────────────────── */
cases.push({
	id: 'A01',
	async run() {
		const { packRoot, catalog } = await setup()
		const pProg = pointOf(catalog, 'programming', 'vue')
		const pMath = pointOf(catalog, 'math', 'vue')
		if (pProg.name !== pMath.name) throw new Error(`夹具前提不成立：跨圈点的显示名不同（${pProg.name} / ${pMath.name}）`)
		if (pProg.id === pMath.id) throw new Error(`夹具前提不成立：跨圈同名点的身份相同（${pProg.id}）`)

		const a = await probeStarterTarget(REPO, { packRoot, catalog, circleName: '编程', pointName: 'Vue' })
		const b = await probeStarterTarget(REPO, { packRoot, catalog, circleName: '数学', pointName: 'Vue' })
		const postA = a.fetchState.starterPosts[0]
		const postB = b.fetchState.starterPosts[0]
		if (!postA || !postB) throw new Error(`两次选择都没有发出 POST /api/whale/starter（${a.fetchState.starterPosts.length} / ${b.fetchState.starterPosts.length}）`)
		const idA = postA.request && postA.request.pointId
		const idB = postB.request && postB.request.pointId
		if (idA === idB) throw new Error(`跨圈同名知识点发出去的 pointId 相同（都是 ${JSON.stringify(idA)}）—— 身份被截成了裸段`)
		if (idA !== pProg.id || idB !== pMath.id) {
			throw new Error(`发送的目标身份不是宿主声明的规范 id：编程→${JSON.stringify(idA)}（应 ${pProg.id}）/ 数学→${JSON.stringify(idB)}（应 ${pMath.id}）`)
		}
		if (postA.request.circleId === postB.request.circleId) throw new Error(`两次发送的 circleId 相同（${JSON.stringify(postA.request.circleId)}）`)
		const textA = String(postA.response.text || '')
		const textB = String(postB.response.text || '')
		if (!textA.includes(`（${pProg.id}）`) || !textB.includes(`（${pMath.id}）`)) {
			throw new Error(`宿主拼出来的归属行没带各自的规范身份（编程：${JSON.stringify(textA.split('\n')[1])} / 数学：${JSON.stringify(textB.split('\n')[1])}）`)
		}
		evidence.probes.A01 = {
			programming: { request: postA.request, belongLine: String(textA).split('\n')[1], name: pProg.name },
			math: { request: postB.request, belongLine: String(textB).split('\n')[1], name: pMath.name },
			gateUrls: a.fetchState.gateCalls.map((g) => g.url),
		}
	},
})

/* ── A02：课程选择、导出和提问使用同一目标身份 ───────────────────────────── */
cases.push({
	id: 'A02',
	async run() {
		const { packRoot, catalog } = await setup()
		const point = pointOf(catalog, 'programming', 'vue')
		if (!(point.lessons || []).length) throw new BlockedCase('合成课程包里 programming/vue 没有课 —— A02 需要一门课可导出')

		// ① 课程选择（开课弹窗）用的身份
		const sel = await probeStarterTarget(REPO, { packRoot, catalog, circleName: '编程', pointName: 'Vue' })
		const selected = sel.fetchState.starterPosts[0]
		if (!selected) throw new Error('开课弹窗没有发出 POST /api/whale/starter')
		if (selected.request.pointId !== point.id) throw new Error(`选择用的身份不是规范 id：${JSON.stringify(selected.request.pointId)} ≠ ${point.id}`)

		// ② 导出（课程目录「导出」）请求体里的 `lesson` 必须是**被点那一行的**规范课次键
		const exp = await probeExportTarget(REPO, { catalog })
		if (!exp.exportCall) throw new Error(`点「导出」没有发出 POST /api/whale/pack/export（请求：${JSON.stringify(exp.calls.map((c) => c.url))}）`)
		const body = exp.exportCall.body || {}
		const allLessons = (catalog.circles || []).flatMap((c) => (c.points || []).flatMap((p) => p.lessons || []))
		const lesson = allLessons.find((l) => l.id === body.lesson)
		if (!lesson) throw new Error(`导出请求的目标身份不是 catalog 里的任何一课：${JSON.stringify(body.lesson)}（可用：${allLessons.map((l) => l.id).join(', ')}）`)

		// ③ 宿主按身份解出**这一课自己的**源侧文件（不再信调用方塞的路径）
		const { resolveExportTarget } = await import(pathToFileURL(path.join(REPO, 'lib', 'mods', 'pack.js')).href)
		const resolved = resolveExportTarget(lesson.id, packRoot)
		if (!resolved.ok) throw new Error(`宿主按规范课次键解不出导出目标：${resolved.error}`)
		if (resolved.file !== lesson.file) throw new Error(`宿主解出的文件不是这一课的：${JSON.stringify(resolved.file)} ≠ ${JSON.stringify(lesson.file)}`)

		// ④ 提问（课程包页面脚本 assets/ask.js）：页面自报的那一页必须就是这一课，且不被截断
		const pageRel = `lessons/${lesson.file}`
		const openBtn = makeElementStub('button')
		const ask = await probeAssetScript(REPO, 'lib/pack-template/assets/ask.js', {
			bodyAttrs: { 'data-ask-page': pageRel, 'data-ask-lesson': '第1课' },
			pageTitle: '第1课：夹具',
			queryAll: { '[data-ask-open]': [openBtn] },
			after: async ({ documentStub }) => {
				const layer = documentStub.body.children.find((c) => c.className === 'ask-layer')
				if (!layer) throw new Error('ask.js 没有建出弹层（.ask-layer）')
				const panel = layer.children.find((c) => c.className === 'ask-panel')
				if (!panel) throw new Error('ask.js 没有建出面板（.ask-panel）')
				const input = panel.__q.get('.ask-panel__input')
				const submit = panel.__q.get('.ask-panel__submit')
				if (!input || !submit) throw new Error('ask.js 没有接上输入框/提交键')
				input.value = '这一课的分层怎么拆？'
				submit.fire('click')
			},
		})
		const askPost = ask.posts.find((p) => p.url.includes('/ask'))
		if (!askPost) throw new BlockedCase('assets/ask.js 在桩上一条 /ask 请求都没发出')
		if (askPost.body.page !== pageRel) throw new Error(`提问带的页面不是这一课：${JSON.stringify(askPost.body.page)} ≠ ${pageRel}`)
		if (askPost.body.lesson !== '第1课') throw new Error(`提问的课次显示名变了：${JSON.stringify(askPost.body.lesson)}`)
		// 另一个方向：页面没自报路径时**也不许把身份截成末段**（老实现 `pathname.replace(/^.*[\\/]/,'')`）
		const openBtn2 = makeElementStub('button')
		const askNoAttr = await probeAssetScript(REPO, 'lib/pack-template/assets/ask.js', {
			bodyAttrs: { 'data-ask-lesson': '第1课' },
			pageTitle: '第1课：夹具',
			queryAll: { '[data-ask-open]': [openBtn2] },
			location: { pathname: `/${pageRel}` },
			after: async ({ documentStub }) => {
				const layer = documentStub.body.children.find((c) => c.className === 'ask-layer')
				const panel = layer && layer.children.find((c) => c.className === 'ask-panel')
				const input = panel && panel.__q.get('.ask-panel__input')
				const submit = panel && panel.__q.get('.ask-panel__submit')
				input.value = '路径也要完整'
				submit.fire('click')
			},
		})
		const askPost2 = askNoAttr.posts.find((p) => p.url.includes('/ask'))
		if (!askPost2) throw new BlockedCase('（兜底路径）assets/ask.js 没有发请求')
		if (askPost2.body.page !== pageRel) {
			throw new Error(`页面没自报路径时 ask.js 把身份截断了：${JSON.stringify(askPost2.body.page)}（应保留整条 ${pageRel}）`)
		}

		// ⑤ 课后调整（浏览器侧另一个写口）：发出去的就是同一条规范课次键
		const adj = await probeAssetScript(REPO, 'lib/pack-template/assets/adjust.js', {
			blocks: {
				'adjust-box': { attributes: { 'data-lesson': lesson.id } },
				'adjust-text': { value: '这段要再讲细一点' },
				'adjust-done': {},
				'adjust-status': {},
			},
			queryMap: { '.adjust': 'adjust-box' },
			triggerId: 'adjust-done',
		})
		const post = adj.posts.find((p) => p.url.indexOf('/progress') >= 0)
		if (!post) throw new BlockedCase('assets/adjust.js 没有在桩上发出 /progress 请求')
		if (post.body.lesson !== lesson.id) throw new Error(`课后调整用的课次身份不是规范键：${JSON.stringify(post.body.lesson)} ≠ ${lesson.id}`)

		// ⑥ 门禁读口本身也认规范身份（host 侧：不再自己截末段）
		const starter = await mountMod(REPO, 'starter.js', packRoot)
		const gateRoute = starter.routes.find((r) => r.path === '/api/whale/gate')
		const gateRes = await jsonOf(await callRoute(gateRoute, `/api/whale/gate?point=${encodeURIComponent(point.id)}`, { method: 'GET' }))
		if (gateRes.body.pointId !== point.id) throw new Error(`门禁读口没把规范身份带出来：${JSON.stringify(gateRes.body.pointId)}`)
		if (gateRes.body.circle !== 'programming') throw new Error(`门禁读口没带出圆圈：${JSON.stringify(gateRes.body.circle)}`)

		evidence.probes.A02 = {
			selectedPointId: selected.request.pointId,
			lessonId: lesson.id,
			exportLesson: body.lesson,
			exportFile: body.file,
			resolvedFile: resolved.file,
			askPage: askPost.body.page,
			askPageFallback: askPost2.body.page,
			adjustLesson: post.body.lesson,
			gate: { point: gateRes.body.point, pointId: gateRes.body.pointId, circle: gateRes.body.circle },
		}
	},
})

/* ── A03：显示文字不作为身份重新解析 ─────────────────────────────────────── */
cases.push({
	id: 'A03',
	async run() {
		const { packRoot, catalog } = await setup()
		const starter = await mountMod(REPO, 'starter.js', packRoot)
		const route = starter.routes.find((r) => r.path === '/api/whale/starter')
		// 显示名故意写成**另一个知识点的规范 id**：拿名字当身份的实现在这里必错
		const res = await jsonOf(await callRoute(route, '/api/whale/starter', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				values: {},
				circle: '编程',
				point: 'programming/spring-boot', // 这是一个**显示名**
				pointId: 'programming/vue',        // 这才是身份
			}),
		}))
		if (res.status !== 200 || res.body.ok !== true) throw new Error(`合法身份被拒：${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)
		const belong = String(res.body.text || '').split('\n').find((l) => l.indexOf('- 归属：') === 0) || ''
		if (!belong.includes('（programming/vue）')) throw new Error(`归属行没有按 pointId 走：${JSON.stringify(belong)}`)
		if (belong.includes('（programming/spring-boot）')) throw new Error(`归属行把显示名当成了身份：${JSON.stringify(belong)}`)

		// 客户端：catalog 里把某点的**显示名**写成另一个点的规范 id，发送后身份仍是它自己的
		const evil = JSON.parse(JSON.stringify(catalog))
		const c = (evil.circles || []).find((x) => x.id === 'programming')
		const p = (c.points || []).find((x) => x.id === 'programming/vue')
		p.name = 'programming/spring-boot'
		const probe = await probeStarterTarget(REPO, { packRoot, catalog: evil, circleName: '编程', pointName: 'programming/spring-boot' })
		const sent = probe.fetchState.starterPosts[0]
		if (!sent) throw new Error('显示名伪装成 id 的那一屏没有发出 POST')
		if (sent.request.pointId !== 'programming/vue') throw new Error(`客户端把显示名当身份发了出去：${JSON.stringify(sent.request.pointId)}（应为 programming/vue）`)
		const gateUrls = probe.fetchState.gateCalls.map((g) => g.url)
		if (!gateUrls.some((u) => decodeURIComponent(u).includes('point=programming/vue'))) {
			throw new Error(`门禁查询没有用规范身份：${JSON.stringify(gateUrls)}`)
		}
		evidence.probes.A03 = { belongLine: belong, evilSentPointId: sent.request.pointId, gateUrls }
	},
})

/* ── A04：失败结构转为可见错误，不显示成功 ───────────────────────────────── */
cases.push({
	id: 'A04',
	async run() {
		const { packRoot, catalog } = await setup()
		// ① 宿主：歧义身份 → ok:false + failure（kind/code 都在），且**没有**正文（不许"当成功"）
		const starter = await mountMod(REPO, 'starter.js', packRoot)
		const route = starter.routes.find((r) => r.path === '/api/whale/starter')
		const amb = await jsonOf(await callRoute(route, '/api/whale/starter', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ values: {}, pointId: 'vue' }),
		}))
		if (amb.body.ok !== false) throw new Error(`歧义身份居然成功了：${JSON.stringify(amb.body).slice(0, 240)}`)
		if (!amb.body.failure || amb.body.failure.code !== 'ID_AMBIGUOUS' || amb.body.failure.kind !== 'input') {
			throw new Error(`失败结构没带 kind/code：${JSON.stringify(amb.body.failure)}`)
		}
		if (typeof amb.body.text === 'string' && amb.body.text) throw new Error('失败回执里还带着正文（会被当成功）')

		// ② 导出：不存在的规范课次 → 明确失败（有码）
		const packMod = await mountMod(REPO, 'pack.js', packRoot)
		const exportRoute = packMod.routes.find((r) => r.path === '/api/whale/pack/export')
		const bad = await jsonOf(await callRoute(exportRoute, '/api/whale/pack/export', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lesson: 'programming/vue/9999' }),
		}))
		if (bad.body.ok !== false) throw new Error(`不存在的课次居然导出成功了：${JSON.stringify(bad.body).slice(0, 240)}`)
		if (!bad.body.failure || !bad.body.failure.code) throw new Error(`导出失败没有结构化的码：${JSON.stringify(bad.body)}`)

		// ③ 浏览器侧：宿主回失败 → 界面**看得见**（带码），且**一个字都没送进会话**
		const probe = await probeStarterTarget(REPO, {
			packRoot, catalog, circleName: '编程', pointName: 'Vue',
			starterBody: () => ({
				ok: false,
				error: '知识点身份认不出来',
				failure: { kind: 'input', code: 'ID_AMBIGUOUS', error: '知识点 id「vue」在 2 个圆圈里都有' },
			}),
		})
		const text = String(probe.finalText || '')
		if (!text.includes('ID_AMBIGUOUS')) throw new Error(`失败回执没有变成可见文案（可见文本：${JSON.stringify(text.slice(0, 300))}）`)
		if (probe.drafts.length !== 0) throw new Error(`失败路径居然往会话里送了 ${probe.drafts.length} 段正文（不显示成功）`)
		if (probe.submits.length !== 0) throw new Error(`失败路径居然提交了 ${probe.submits.length} 次（不显示成功）`)
		evidence.probes.A04 = {
			hostFailure: amb.body,
			exportFailure: bad.body,
			clientVisibleText: text.split('\n').filter((l) => l.includes('ID_AMBIGUOUS')).slice(0, 3),
			drafts: probe.drafts.length,
			submits: probe.submits.length,
		}
	},
})

/* ── A05：现有工具名、端点和宿主装载方式保持 ─────────────────────────────── */
cases.push({
	id: 'A05',
	async run() {
		const { packRoot } = await setup()
		const expectRoutes = [
			['catalog.js', '/api/whale/catalog', 'GET', []],
			['starter.js', '/api/whale/starter', 'GET,POST', []],
			['starter.js', '/api/whale/gate', 'GET,POST', []],
			['pack.js', '/api/whale/pack/choose', 'POST', []],
			['pack.js', '/api/whale/pack/open', 'POST', []],
			['pack.js', '/api/whale/pack/export', 'POST', []],
			['goal.js', null, null, ['whale_goal']],
			['intake.js', null, null, ['whale_intake']],
			['lessonpack.js', null, null, ['whale_lessonpack']],
		]
		const seen = []
		for (const [modRel, routePath, methods, tools] of expectRoutes) {
			const mod = await mountMod(REPO, modRel, packRoot)
			if (routePath) {
				const r = (mod.routes || []).find((x) => x.path === routePath)
				if (!r) throw new Error(`mods/${modRel} 不再挂 ${routePath}（现有端点必须保持）`)
				if (r.methods.join(',') !== methods) throw new Error(`${routePath} 的方法变了：${r.methods.join(',')} ≠ ${methods}`)
				seen.push(`${routePath} ${r.methods.join(',')}`)
			}
			const names = (mod.plugin.tools || []).slice().sort()
			if (names.join(',') !== tools.slice().sort().join(',')) {
				throw new Error(`mods/${modRel} 的工具名变了：${names.join(',')} ≠ ${tools.join(',')}`)
			}
		}
		// 宿主装载方式的唯一真源：模块表启用清单
		const idx = await import(pathToFileURL(path.join(REPO, 'lib', 'mods', 'index.js')).href)
		const wantEnabled = ['lessonpack', 'build', 'probe', 'audit', 'style', 'mode', 'intake', 'goal', 'teaching', 'plan', 'author', 'state', 'ask', 'glossary', 'brief', 'visual', 'practice', 'note', 'evidence', 'status', 'starter', 'catalog', 'create', 'pack', 'preset']
		if (idx.enabledModules().join(',') !== wantEnabled.join(',')) throw new Error(`模块装载表变了：${idx.enabledModules().join(',')}`)
		// 浏览器半边：模块 id / 注入面 / 坐位注册全都不许动
		const mounted = mountClient(REPO)
		if (mounted.spec.id !== 'dsh-whale-sensei') throw new Error(`client 模块 id 变了：${mounted.spec.id}`)
		if (mounted.client.inject.join(',') !== 'slots') throw new Error(`client 注入面变了：${JSON.stringify(mounted.client.inject)}`)
		if (typeof mounted.client.apply !== 'function') throw new Error('client 不再导出 apply')
		const wantSlots = [
			'settings.section:whale-sensei',
			'conversation.input.left:whale-bridge',
			'shell.overlay:whale-new-course-dialog',
			'sidebar.panellist:whale-sensei-pack',
			'main:whale-sensei-pack',
		]
		const gotSlots = mounted.registrations.map((r) => {
			const s = r.spec || {}
			return s.name === 'main' ? `main:${s.key}` : `${s.name}:${s.id}`
		})
		for (const w of wantSlots) if (!gotSlots.includes(w)) throw new Error(`client 坐位注册少了 ${w}（实得 ${gotSlots.join(' / ')}）`)
		if (/\bimport\s+[^;]*\bfrom\s+['"]/.test(mounted.src)) throw new Error('lib/client.js 出现了 ESM import 语法（懒 CJS 半边不许有）')
		evidence.probes.A05 = { routes: seen, enabled: idx.enabledModules(), slots: gotSlots }
	},
})

/* ── A06：普通记录写入不新增重复确认流程 ─────────────────────────────────── */
cases.push({
	id: 'A06',
	async run() {
		const { catalog } = await setup()
		const newPack = buildPack(path.join(TEMP_ROOT, 'packs', 'u16-record'), PACK_SPEC)
		// ① 工具入参里没有 `confirm`（普通记录写入不许新增确认闸）
		for (const modRel of ['intake.js', 'goal.js', 'lessonpack.js']) {
			const mod = await mountMod(REPO, modRel, newPack)
			const def = mod.tools[0]
			if (!def) throw new BlockedCase(`mods/${modRel} 没有注册工具`)
			const props = (def.parameters && def.parameters.properties) || {}
			if (Object.prototype.hasOwnProperty.call(props, 'confirm')) throw new Error(`${def.name} 新增了 confirm 入参（普通记录写入不许加重复确认）`)
		}
		// ② 一次 op=record 就落盘（不需要第二轮确认），且只写一行
		const intake = await mountMod(REPO, 'intake.js', newPack)
		const def = intake.tools[0]
		const rec = await def.execute({ op: 'record', point: 'programming/vue', level: '有基础', root: newPack })
		if (!rec || rec.ok !== true) throw new Error(`whale_intake op=record 没成：${JSON.stringify(rec).slice(0, 200)}`)
		const ledger = path.join(newPack, 'learning-records', 'intake.jsonl')
		if (!fs.existsSync(ledger)) throw new Error('op=record 没有落盘（intake.jsonl 不存在）')
		const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
		if (lines.length !== 1) throw new Error(`一次 op=record 写了 ${lines.length} 行（应恰好 1 行）`)
		// ③ 开课弹窗的普通写入：一次点击 = 一次 POST，没有第二道"确认"往返
		const probe = await probeStarterTarget(REPO, { packRoot: newPack, catalog, circleName: '编程', pointName: 'Vue' })
		const posts = probe.fetchState.starterPosts
		if (posts.length !== 1) throw new Error(`一次「点卡片开课」发出了 ${posts.length} 次 POST（应恰好 1 次）`)
		if (JSON.stringify(posts[0].request).includes('"confirm"')) throw new Error('开课请求里出现了 confirm 字段（普通写入不该要确认）')
		// ④ 不可恢复的操作**仍然**要确认（既有确认流程不许被这次改动抹掉）
		const create = await mountMod(REPO, 'create.js', newPack)
		const delRoute = create.routes.find((r) => r.path === '/api/whale/circle/delete')
		if (!delRoute) throw new BlockedCase('mods/create.js 没有 /api/whale/circle/delete')
		const noConfirm = await jsonOf(await callRoute(delRoute, '/api/whale/circle/delete', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'programming' }),
		}))
		if (noConfirm.body.ok === true) throw new Error('删除圆圈在没有 confirm 的情况下成功了（既有确认流程被抹掉了）')
		evidence.probes.A06 = { record: { ok: rec.ok, lines: lines.length }, starterPosts: posts.length, deleteWithoutConfirm: noConfirm.body }
	},
})

/* ── A07：临时恢复身份末段截断后，行为探针必须失败（E:\\Temp 副本） ───────── */
cases.push({
	id: 'A07',
	async run() {
		const { packRoot, catalog } = await setup()
		const base = path.join(TEMP_ROOT, 'a07')
		const clean = path.join(base, 'clean')
		const mutated = path.join(base, 'mutated')
		const copyTree = (dst) => {
			fs.mkdirSync(dst, { recursive: true })
			fs.cpSync(path.join(REPO, 'lib'), path.join(dst, 'lib'), { recursive: true })
			fs.cpSync(path.join(REPO, 'package.json'), path.join(dst, 'package.json'))
		}
		copyTree(clean)
		copyTree(mutated)
		// 变异：把**身份末段截断**装回去（旧实现就是 `split('/').pop()`）
		const clientAbs = path.join(mutated, 'lib', 'client.js')
		const src = fs.readFileSync(clientAbs, 'utf8')
		const needle = 'postData.pointId = snap.selectedPoint.id;     // 规范知识点 id（身份）'
		if (!src.includes(needle)) throw new BlockedCase(`变异锚点没找到（client.js 里那条身份赋值变了）：${needle}`)
		const patched = src.replace(needle, "postData.pointId = String(snap.selectedPoint.id).split('/').pop();  // ← A07 变异：恢复末段截断")
		if (patched === src) throw new BlockedCase('变异没生效')
		fs.writeFileSync(clientAbs, patched)
		const mutatedHasTruncation = /split\('\/'\)\.pop\(\)/.test(fs.readFileSync(clientAbs, 'utf8'))

		const runProbe = async (treeRoot) => {
			const m1 = await probeStarterTarget(treeRoot, { packRoot, catalog, circleName: '编程', pointName: 'Vue' })
			const m2 = await probeStarterTarget(treeRoot, { packRoot, catalog, circleName: '数学', pointName: 'Vue' })
			const a = m1.fetchState.starterPosts[0]
			const b = m2.fetchState.starterPosts[0]
			const idA = a && a.request && a.request.pointId
			const idB = b && b.request && b.request.pointId
			return { idA, idB, distinct: !!idA && !!idB && idA !== idB }
		}
		const cleanResult = await runProbe(clean)
		const mutatedResult = await runProbe(mutated)
		// 干净副本对照：必须绿（证明"红"来自变异，不是副本本身）
		if (!cleanResult.distinct) throw new Error(`干净副本上探针就失败了（${JSON.stringify(cleanResult)}）—— 判据本身不可信`)
		if (mutatedResult.distinct) throw new Error(`变异副本上探针居然通过了（${JSON.stringify(mutatedResult)}）—— 这条判据抓不到"身份末段截断"`)
		if (path.dirname(path.resolve(base)) !== path.resolve(TEMP_ROOT)) throw new Error('A07 的临时副本不在本卡唯一临时目录下（清理守卫会拒）')
		evidence.mutation = {
			anchor: needle,
			mutation: 'pointId 恢复为 split("/").pop()',
			mutatedHasTruncation,
			cleanCopy: path.relative(TEMP_ROOT, clean),
			mutatedCopy: path.relative(TEMP_ROOT, mutated),
			clean: cleanResult,
			mutated: mutatedResult,
		}
	},
})

/* ── A08：无浏览器环境时不得冒充真实浏览器验收；证据与范围守卫有效 ─────────── */
cases.push({
	id: 'A08',
	async run() {
		const { packRoot } = await setup()
		// ① 环境事实：没有真浏览器
		if (globalThis.document && globalThis.document.__simulated !== true) throw new Error('本机居然有真 document —— "无浏览器"口径要重定')
		if (globalThis.window && globalThis.window.__simulated !== true && globalThis.window.__ModuleLoader__) throw new Error('本机居然有真的浏览器模块加载器 —— 口径要重定')
		// ② 我们用的桩必须自报是桩；探针跑完必须把全局还原
		const mounted = mountClient(REPO)
		if (mounted.spec.id !== 'dsh-whale-sensei') throw new Error('client 模块 id 不对')
		const adj = await probeAssetScript(REPO, 'lib/pack-template/assets/adjust.js', {
			blocks: {
				'adjust-box': { attributes: { 'data-lesson': 'programming/vue/0001' } },
				'adjust-text': { value: 'x' }, 'adjust-done': {}, 'adjust-status': {},
			},
			queryMap: { '.adjust': 'adjust-box' },
			triggerId: 'adjust-done',
		})
		if (adj.posts.length === 0) throw new Error('页面脚本探针在桩上一条请求都没发出（判据是空的）')
		if (globalThis.document !== undefined) throw new Error('探针结束后没有还原全局 document（会污染后续判据）')
		// ③ 写守卫真的会拦：故意往**非写集**的仓内文件写一次
		const trip = proveGuardTrips()
		if (!trip.threw) throw new Error('写守卫没有拦下越界写（守卫失效）')
		if (!trip.unchanged) throw new Error('被拒的越界写居然改动了目标文件（没有在写之前拦）')
		if (!/U16 写守卫拒绝/.test(String(trip.threw))) throw new Error(`越界写的错误不像守卫给的：${trip.threw}`)
		// ④ 运行期没有别的越界（写 / 读活包 / 读主树）
		if (guard.violations.length) throw new Error(`运行期出现越界访问：${JSON.stringify(guard.violations.slice(0, 5))}`)
		// ⑤ 范围守卫：tracked ⊆ interfaces.md §6 的 U16 授权并集
		const authorized = readAuthorizedWriteSet()
		const outside = WRITE_SET_REL.filter((rel) => !authorized.includes(rel))
		if (outside.length) throw new Error(`写集超出 interfaces.md §6 的 U16 授权：${outside.join('、')}（授权表：${authorized.join('、')}）`)
		evidence.scope = { authorized, declared: WRITE_SET_REL.slice(), outside }
		// ⑥ 自锚：写集在本轮运行期间没被改过
		const now = hashWriteSet()
		if (!evidence.selfAnchor) evidence.selfAnchor = { start: now }
		if (JSON.stringify(now) !== JSON.stringify(evidence.selfAnchor.start)) throw new Error('本卡写集在运行期间被改动（自锚不一致）')
		// ⑦ 回执必须如实登记"真实浏览器未验证"
		const receiptAbs = path.join(REPO, 'docs', 'unify', 'receipts', 'U16.json')
		if (!fs.existsSync(receiptAbs)) throw new Error('缺 docs/unify/receipts/U16.json（tracked 回执）')
		let receipt
		try { receipt = JSON.parse(fs.readFileSync(receiptAbs, 'utf8')) } catch (e) { throw new Error(`U16 回执不是合法 JSON：${e.message}`) }
		const browserClaim = receipt && receipt.verification && receipt.verification.realBrowser
		if (browserClaim !== 'unverified') throw new Error(`回执 verification.realBrowser 必须是 "unverified"（实得 ${JSON.stringify(browserClaim)}）—— 无浏览器环境不许冒充真实验收`)
		// ⑧ 证据根归属 + 真的落了盘
		if (!isUnder(EVIDENCE_ROOT, path.join(REPO, 'audit-evidence', CARD)) && !isUnder(EVIDENCE_ROOT, TEMP_PARENT)) throw new Error(`证据根越界：${EVIDENCE_ROOT}`)
		evidence.guard = { trip, violations: guard.violations.slice(), writes: guard.writes.length, reads: guard.reads.length, evidenceRoot: EVIDENCE_ROOT }
		await mountMod(REPO, 'lessonpack.js', packRoot) // 改过工具面的模块仍装得上
	},
})

/* ───────────────────────────── 跑固定八项 ───────────────────────────── */

if (!evRoot.ok) {
	printVerdict({
		card: CARD, checks: 0, passed: 0, failed: 0, skipped: 0, status: 'BLOCKED', code: 2,
		line: `BLOCKED ${CARD} ${evRoot.error}`, problems: [evRoot.error], truncatedNotes: 0,
		blocked: evRoot.error, cases: [], ms: 0, notes: [],
	})
	process.exit(2)
}

// 自锚起点：先把本卡写集的哈希固定下来（A08 收口前复比）
try {
	evidence.selfAnchor = { start: hashWriteSet() }
} catch (e) {
	printVerdict({
		card: CARD, checks: 0, passed: 0, failed: 0, skipped: 0, status: 'BLOCKED', code: 2,
		line: `BLOCKED ${CARD} 无法哈希本卡写集：${String(e?.message || e)}`, problems: [], truncatedNotes: 0,
		blocked: 'hash', cases: [], ms: 0, notes: [],
	})
	process.exit(2)
}

installFsGuard()

const verdict = await runCard(CARD, ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'], cases, { argv, maxNoteBytes: 4096 })

const code = verdict.status === 'PASS' ? 0 : verdict.status === 'BLOCKED' ? 2 : 1

// 证据落盘（原始明细：探针抓到的请求/回执/文本 + 变异 + 守卫）
try {
	writeRunEvidence(verdict, EVIDENCE_ROOT)
	fs.writeFileSync(path.join(EVIDENCE_ROOT, 'probes.json'), JSON.stringify(Object.assign({ console: consoleLog.slice(-300) }, evidence), null, 2) + '\n')
	let endHash = null
	try { endHash = hashWriteSet() } catch (e) { endHash = { error: String(e?.message || e) } }
	fs.writeFileSync(path.join(EVIDENCE_ROOT, 'summary.json'), JSON.stringify({
		card: CARD,
		status: verdict.status,
		code,
		line: verdict.line,
		cases: verdict.cases.map((c) => ({ id: c.id, status: c.actual, note: c.note, ms: c.ms })),
		selfAnchor: { start: evidence.selfAnchor?.start ?? null, end: endHash },
		guard: { trips: guard.trips, violations: guard.violations, writes: guard.writes.length, reads: guard.reads.length },
		scope: evidence.scope,
		mutation: evidence.mutation,
		browserVerified: false,
	}, null, 2) + '\n')
} catch (e) {
	// 证据落盘失败**不能**把红的判词改成绿
	process.stderr.write(`U16 证据落盘失败：${String((e && e.message) || e)}\n`)
}

// 临时目录清理（守卫先核对绝对路径与归属）
try {
	const cleanup = safeRemoveTree(TEMP_ROOT, { parent: TEMP_PARENT })
	process.stderr.write(`U16 临时目录清理：${cleanup.removed ? '已删除' : '未删除（' + cleanup.error + '）'} ${TEMP_ROOT}\n`)
} catch (e) {
	process.stderr.write(`U16 临时目录清理失败：${String((e && e.message) || e)}\n`)
}

process.exit(printVerdict(verdict))
