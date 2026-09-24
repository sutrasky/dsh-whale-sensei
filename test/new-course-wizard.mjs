#!/usr/bin/env node
/**
 * test/new-course-wizard.mjs — 新课程向导判据
 * ------------------------------------------------------------------
 * 断言：
 *   1. starter.js 的字段定义：8 个 id 齐全、四个必填（topic / goal / tier / acceptance）、label 与 hint 逐字等于既有文本
 *   2. 正文组装：给 circle/point 时含 `- 归属：…（programming/spring-boot）`；不给时不含
 *   3. catalog 客户端契约：canCreate === false、nextFileBase 存在且对 programming 为 2000（max fileBase + 1000）
 *   4. 客户端源码里三屏的顺序正确
 *   5. 反空转哨兵：故意错序会红
 *   6. 不许出现死按钮：canCreate === false 时渲染函数不产出新建按钮
 *  10. 新建圆圈表单：点开后有显示名输入框、目录 id 输入框、创建/取消按钮
 *  11. 新建圆圈提交：POST /api/whale/circle body 带用户填的 name/id
 *  12. 新建圆圈成功：重拉 catalog、step 推进到 1、selectedCircle 是新建的
 *  13. 新建圆圈失败：错误人话出现在树里、状态不推进
 *  14. 新建知识点同款：POST /api/whale/point → step 推进到 2、归属行带新知识点名
 *  15. 反空转：doCreateCircle 换成空函数 → [11] 的判据必须红
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { packRoot, PLUGIN } from './_pack.mjs'
import { FORM_EMPTY_TEXT, composeRequest, buildStarter, goalFromForm, composeMapPrompt } from '../lib/starter.js'

const ROOT = packRoot()
let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }

console.log(`\n[new-course-wizard] 课程包：${ROOT}`)

/* ── [1] 流程契约：三段 + 字段表已删（2026-09-24 F1b）──────────────────── */
{
	const entry = buildStarter(null)

	// 字段表删了：v3 §1.1「点知识点卡片 = 一键到位」，那一屏整个没了
	ok(Array.isArray(entry.form.fields) && entry.form.fields.length === 0,
		`[1] 弹窗字段表已删 ⇒ 空数组（${(entry.form.fields || []).length} 个）`)
	ok((entry.form.fields || []).filter((f) => f.required).length === 0, '[1] 不再有必填字段（终点改由 ②段的 whale_goal 收）')

	// 三段：查资料 → 看挑战（含问终点与掌握程度）→ 生成课程
	ok(entry.steps.length === 3, `[1] 步骤三段（${entry.steps.length}）`)
	ok(/查资料/.test(entry.steps[0]) && /看挑战/.test(entry.steps[1]) && /whale_author/.test(entry.steps[2]),
		`[1] 三步依次是查资料 / 看挑战 / 生成课程（${entry.steps.join(' | ')}）`)

	// 协议全文：三段齐、两个落盘口点名、「四步」这个说法不许再出现
	const p = entry.prompt
	ok(/查资料/.test(p) && /看挑战/.test(p) && /生成课程/.test(p), '[1] 协议正文三段齐')
	ok(!/四步/.test(p), '[1]「四步」已经不在协议里')
	ok(/whale_intake/.test(p) && /whale_goal/.test(p), '[1] ②段点名两个落盘工具（whale_intake / whale_goal）')
	ok(/RESOURCES\.md/.test(p), '[1] ①段要求出处落 RESOURCES.md')
	ok(/必须排在 c\) 之后/.test(p), '[1] 写清 whale_goal 必须排在 intake 之后（from 才带得上起点台阶）')

	// 模板只剩两个占位
	ok(entry.form.template.includes('{{belong}}') && entry.form.template.includes('{{protocol}}'),
		'[1] 模板带 {{belong}} 与 {{protocol}} 两个占位')
	ok(!/\{\{(topic|goal|tier|acceptance|work|scope|refs|notes)\}\}/.test(entry.form.template),
		'[1] 模板里不再有字段占位符')
}

/* ── [2] 正文组装：归属行按需出现 ──────────────────────────────────────── */
{
	const entry = buildStarter(null)

	// 给 circle/point/pointId 时，正文应含归属行
	const textWithBelong = composeRequest(
		entry.form,
		{ topic: 'Spring Boot 入门', goal: '能独立写 REST API' },
		entry.prompt,
		'编程',
		'Spring Boot',
		'programming/spring-boot'
	)
	ok(textWithBelong.includes('- 归属：编程 / Spring Boot（programming/spring-boot）'), '[2] 给 circle/point 时含归属行')

	// 不给 circle/point 时，正文不应含归属行（反空转）
	const textWithoutBelong = composeRequest(
		entry.form,
		{ topic: 'Spring Boot 入门', goal: '能独立写 REST API' },
		entry.prompt
	)
	ok(!textWithoutBelong.includes('- 归属：'), '[2] 不给 circle/point 时不含归属行（反空转）')
	// 不给归属时，正文开头应该是【开课请求】后直接跟字段，没有空行
	ok(textWithoutBelong.startsWith('【开课请求】\n\n下面是'), '[2] 不给归属时正文开头是「【开课请求】」+ 空行（占位被摘掉，不留空行）')
}

/* ── [2b] goalFromForm：终点契约入参（纯函数）────────────────────────────
/* ── [2b] goalFromForm：终点契约入参（纯函数）────────────────────────────
 * 硬约束（主线程裁定）：终点必须来自**显式输入** —— `artifact.what` = goal 原文逐字，
 * 绝不拿摸底的 can / prior / level 回落顶替（那条回落只属于「起点台阶」）。
 */
{
	const gi = goalFromForm({
		goal: '一个能独立跑的 REST 待办服务', work: 'code/_hello-spring-boot', tier: '3',
		acceptance: 'GET /api/tasks 能列出待办\n能新增一条待办',
	}, 'programming/spring-boot')
	ok(gi.point === 'spring-boot' && gi.pointPath === 'programming/spring-boot', `[2b] point 取 pointId 最后一段、pointPath 原样（${gi.point} / ${gi.pointPath}）`)
	ok(gi.artifact.what === '一个能独立跑的 REST 待办服务', '[2b] artifact.what = wizard goal 原文逐字')
	ok(gi.artifact.where === 'code/_hello-spring-boot', '[2b] artifact.where = 作品放哪')
	ok(gi.tier === 3, `[2b] tier 归一成数值（${gi.tier}）`)
	ok(gi.acceptance.length === 2 && gi.acceptance.map((a) => a.no).join(',') === '1,2', '[2b] 验收判据一行一条、序号连续')
	ok(gi.acceptance.every((a) => a.auto === false && a.hint === a.deliverable), '[2b] 表单行 → auto:false 形态（机器判不了就老实标）')
	ok(gi.source === 'wizard' && gi.focus === null, '[2b] source=wizard、focus=null（终点侧不装卡点）')
	ok(goalFromForm({ goal: 'x', tier: '2', acceptance: 'y' }, 'programming/vue').artifact.what === 'x', '[2b] 终点只来自显式输入（函数签名里根本没有 level/prior/can 可回落）')
	ok(goalFromForm({ goal: 'x', tier: '1', acceptance: 'y' }) === null, '[2b] 没有 pointId → null（不落盘，只提示「终点还没结构化」）')
	ok(goalFromForm({ goal: 'x', tier: '1', acceptance: 'y' }, '   ') === null, '[2b] pointId 空白 → 同样 null')
	ok(goalFromForm({ goal: 'x', tier: '三', acceptance: 'y' }, 'programming/vue').tier === '三', '[2b] 坏 tier 原样带出（值校验归 validateStage）')
	ok(goalFromForm({ goal: 'x', tier: '1', acceptance: 'y' }, 'programming/vue').artifact.where === null, '[2b] 作品放哪不填 → where=null')
}

/* ── [3] catalog 客户端契约 ─────────────────────────────────────────────── */
{
	// 真包现算：programming 下 spring-boot(fileBase=0)、vue(fileBase=1000) → max(0,1000)+1000 = 2000
	const { plugin } = await import('../lib/mods/catalog.js')
	const routes = []
	plugin.install({
		paths: { packRoot: ROOT },
		log: { info: () => {}, warn: () => {}, error: () => {} },
		registerTool: () => {},
		inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	})
	const catalogRoute = routes.find((r) => r.path === '/api/whale/catalog')
	ok(!!catalogRoute, '[3] catalog 路由存在')

	const res = await catalogRoute.fetch(new Request('http://127.0.0.1:3090/api/whale/catalog', { method: 'GET' }))
	const data = await res.json()

	ok(data.canCreate === true, `[3] canCreate === true（实际 ${data.canCreate}）`)

	const programming = data.circles.find((c) => c.id === 'programming')
	ok(!!programming, '[3] 找到 programming 圆圈')
	ok(typeof programming.nextFileBase === 'number', `[3] nextFileBase 存在且为数字（${programming.nextFileBase}）`)

	// 真包：programming 下有 spring-boot(fileBase=0) 和 vue(fileBase=1000)
	// max(0, 1000) + 1000 = 2000
	ok(programming.nextFileBase === 2000, `[3] programming.nextFileBase = ${programming.nextFileBase}（期望 2000）`)
}

/* ── detectStepOrder：向导屏顺序检测器（被 [4] 和 [5] 共用）────────────── */
/**
 * 检测已剥注释的源码里各屏条件的出现顺序。
 *
 * **2026-09-24 F1c：两屏了**（原第 3 屏「填表单」已删）。所以这里改成：
 *   · 找第 0/1 屏，且 0 在 1 前面；
 *   · **并断言第 2 屏真的没了**（`state.step === 2` 一处都不许剩）—— 删干净才是交付。
 * 返回 { mark0, mark1, mark2, inOrder }；mark2 恒为 -1 才算对。
 */
function detectStepOrder(src) {
	const mark0 = src.indexOf('state.step === 0 && state.catalog')
	const mark1 = src.indexOf('state.step === 1 && state.selectedCircle')
	const mark2 = src.indexOf('state.step === 2')
	const inOrder = mark0 > -1 && mark1 > -1 && mark0 < mark1
	return { mark0, mark1, mark2, inOrder }
}

/* ── [4] 客户端源码里三屏的顺序正确 ───────────────────────────────────── */
{
	const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
	const code = src
		.replace(/^[ \t]*\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')

	const r = detectStepOrder(code)
	ok(r.mark0 > -1, `[4] 找到 step === 0 条件（位置 ${r.mark0}）`)
	ok(r.mark1 > -1, `[4] 找到 step === 1 条件（位置 ${r.mark1}）`)
	ok(r.mark2 === -1, `[4] 第 3 屏（填表单）已经**删干净**（step === 2 出现 ${r.mark2 === -1 ? 0 : 1} 处）`)
	ok(r.inOrder, `[4] 两屏顺序正确：step0(${r.mark0}) → step1(${r.mark1})`)
}

/* ── [4b] 两列表单必须"缩得动"：不许再写回 '1fr 1fr' ────────────────────────
 * 为什么要有这一条（2026-09-24 现场）：
 *   宿主弹窗盒是 `._dialog_w1urq_22 { width: min(380px,100%); overflow: hidden }` —— **固定 380px、溢出即切**。
 *   而 '1fr 1fr' 的 grid 轨道默认 `min-width: auto`，**缩不到 <input> 的固有宽度以下**
 *   （UA 默认 size=20 ≈ 170px）⇒ 两列各 ~180px、共需 368px，而 box 内可用只有 308px
 *   ⇒ 右边那个输入框被 `overflow:hidden` **一刀切掉**（用户原话："右边像是被一刀切了、输入框被截断"）。
 *   修法：轨道写 `minmax(0, 1fr)` + 输入框带 `minWidth:0 / width:100% / boxSizing:border-box`。
 *   这条守卫钉住修法，别再退化。 */
{
	const code2 = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
	const bad = code2.match(/gridTemplateColumns:\s*'1fr 1fr'/g) || []
	ok(bad.length === 0, `[4b] 没有退化成 '1fr 1fr' 的轨道（实得 ${bad.length} 处）—— 它会被 380px 弹窗盒切右边`)
	const shrinkable = code2.match(/gridTemplateColumns:\s*'minmax\(0, 1fr\) minmax\(0, 1fr\)'/g) || []
	ok(shrinkable.length >= 3, `[4b] 三处两列表单都用 minmax(0,1fr)（实得 ${shrinkable.length} 处）`)
	const minW = code2.match(/minWidth: 0/g) || []
	ok(minW.length >= 6, `[4b] 行内输入框都带了 minWidth:0（实得 ${minW.length} 处，应 ≥6）`)
}

/* ── [4c] 组件边界：CourseDialog 不许引用**别的组件**的状态 ──────────────────
 * 为什么要有这一条（2026-09-24 现场）：
 *   弹窗（`function CourseDialog()`）与设置卡是**两个组件**，各自有自己的 useState。
 *   给「新建圆圈」加重建横幅时，误用了设置卡那套 `setNotice(...)` / `setTick(...)` ——
 *   在 CourseDialog 作用域里它们**根本不存在**，于是用户点「创建」当场
 *   `setNotice is not defined`，整个建圈流程炸掉。
 *   渲染型测试抓不到它（异常发生在 fetch 的 .then 里，成了未处理拒绝），所以这里用源码边界钉住：
 *   CourseDialog 函数体里**只许**出现它自己的 setState / setRebuild。 */
{
	const srcC = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')
	const a = srcC.indexOf('function CourseDialog()')
	const b = srcC.indexOf('function applyCourseDialog(', a)
	const rawBody = a >= 0 && b > a ? srcC.slice(a, b) : ''
	// 剥注释再判：守卫看的是**代码**，注释里写反例（"别写成 setNotice(...)"）不该算数
	const body = rawBody
		.replace(/^[ \t]*\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
	ok(body.length > 0, `[4c] 切出 CourseDialog 的函数体（剥注释后 ${body.length} 字符）`)
	ok(!/\bsetNotice\s*\(/.test(body), '[4c] CourseDialog 里不许调 setNotice —— 那是另一个组件的状态，会当场 ReferenceError')
	ok(!/\bsetTick\s*\(/.test(body), '[4c] CourseDialog 里不许调 setTick —— 同上')
	ok(/\bsetRebuild\s*\(/.test(body), '[4c] 重建横幅走本组件自己的 setRebuild')
}

/* ── [5] 反空转哨兵：故意错序的假源码会红 ──────────────────────────────── */
{
	// 构造假源码：step2 的代码块排在 step0 前面（真错序，不是靠中文注释）
	const fakeSource = `
		if (state.step === 2 && form) { renderForm(); }
		if (state.step === 1 && state.selectedCircle) { renderPoints(); }
		if (state.step === 0 && state.catalog) { renderCircles(); }
	`
	const r = detectStepOrder(fakeSource)
	ok(!r.inOrder, `[5] 反空转哨兵：故意错序的假源码被同一个函数检测为顺序错误（inOrder=${r.inOrder})`)
}

/* ── 共用工具：加载 client.js 并用 mini-React 渲染 CourseDialog ──────────── */
const _src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8')

/** 递归收集树里所有文本节点（包括 props.footer 等非 children 的子树） */
function collectTexts(node, out) {
	if (node == null || node === false) return
	if (typeof node === 'string') { out.push(node); return }
	if (Array.isArray(node)) { node.forEach((c) => collectTexts(c, out)); return }
	if (node.children) node.children.forEach((c) => collectTexts(c, out))
	if (node.props) {
		if (node.props.children) {
			const ch = node.props.children
			if (Array.isArray(ch)) ch.forEach((c) => collectTexts(c, out))
			else collectTexts(ch, out)
		}
		// Modal 的 footer / description 等也是子树
		if (node.props.footer) collectTexts(node.props.footer, out)
		if (node.props.description) collectTexts(node.props.description, out)
	}
}

/** 判断文本数组里是否有任何一项包含 needle */
function hasText(texts, needle) {
	return texts.some((t) => t.includes(needle))
}

/** 递归收集树里所有 input 元素的 props（placeholder / value / disabled） */
function collectInputs(node, out) {
	if (node == null || node === false) return
	if (typeof node === 'string') return
	if (Array.isArray(node)) { node.forEach((c) => collectInputs(c, out)); return }
	if (node.type === 'input') {
		out.push({ placeholder: node.props.placeholder, value: node.props.value, disabled: node.props.disabled })
	}
	if (node.children) node.children.forEach((c) => collectInputs(c, out))
	if (node.props) {
		if (node.props.children) {
			const ch = node.props.children
			if (Array.isArray(ch)) ch.forEach((c) => collectInputs(c, out))
			else collectInputs(ch, out)
		}
		if (node.props.footer) collectInputs(node.props.footer, out)
	}
}

/** 递归收集树里所有 button 元素的文本、onClick、disabled */
function findButtons(node, out) {
	if (node == null || node === false) return
	if (typeof node === 'string') return
	if (Array.isArray(node)) { node.forEach((c) => findButtons(c, out)); return }
	if (node.type === 'button') {
		const texts = []
		collectTexts(node, texts)
		out.push({ text: texts.join(' '), onClick: node.props.onClick, disabled: node.props.disabled })
	}
	if (node.children) node.children.forEach((c) => findButtons(c, out))
	if (node.props) {
		if (node.props.children) {
			const ch = node.props.children
			if (Array.isArray(ch)) ch.forEach((c) => findButtons(c, out))
			else findButtons(ch, out)
		}
		if (node.props.footer) findButtons(node.props.footer, out)
	}
}

/**
 * 用预置 hook 槽位渲染一次 CourseDialog，返回收集到的文本数组。
 * useDialogOpen() 内部调 useState(dialogOpen) → 槽位 0
 * 主 state 的 useState({…}) → 槽位 1
 * useEffect / useRef 消费后续槽位，我们不需要它们。
 */
function renderWithState(initialState) {
	let cursor = 0
	const slots = []
	const mr = {
		createElement: (type, p, ...kids) => {
			const flat = kids.flat(Infinity)
			return { type, props: p || {}, children: flat.filter((k) => k != null && k !== false) }
		},
		useState(init) {
			const i = cursor++
			if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
			return [slots[i], () => {}]
		},
		useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
		useEffect() { cursor++ },
	}
	const prim = { Modal: function Modal() {}, Button: function Button() {} }
	const req = (n) => {
		if (n === 'react') return mr
		if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
		throw new Error('意外 require：' + n)
	}
	const fakeW = {
		__ModuleLoader__: { load: () => {} },
		setTimeout: (fn) => setTimeout(fn, 0),
		prompt: () => {},
	}
	let mod = null
	fakeW.__ModuleLoader__.load = (m) => { mod = m }
	new Function('window', 'require', _src)(fakeW, req)
	const exp = mod.factory(req)
	const regs = []
	exp.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs.push({ spec, comp: c }); return () => {} } }, effect: (fn) => fn() })

	const CourseDialog = regs.find((r) => r.spec.name === 'shell.overlay').comp

	// 预填 hook 槽位：
	// useDialogOpen() 内部: useState(dialogOpen) → slot 0, useEffect(fn, []) → slot 1
	// CourseDialog 主体: useState({...state}) → slot 2
	slots[0] = true   // useDialogOpen() 返回 true → 弹窗打开
	slots[1] = { deps: [] }  // useEffect 的占位（deps 不变 = effect 不跑）
	slots[2] = initialState  // 主 state

	const tree = CourseDialog({})
	const texts = []
	collectTexts(tree, texts)
	return texts
}

/**
 * renderAndAct — 带 mock fetch 和 setState 跟踪的渲染。
 * 与 renderWithState 同构，但：
 *   - fetch 被替换为 window.fetch（通过改源码），可通过 fetchResponseQueue 控制返回值
 *   - setState 实际更新 slots[2]，并记录每次调用
 *   - 返回 { render(), fetchCalls, setStateCalls, slots }
 * 用法：先 render() 拿树，找到 onClick 调用，await 微任务，再 render() 看更新后的树。
 */
function renderAndAct(initialState, fetchResponseQueue, srcOverride) {
	let cursor = 0
	const slots = []
	const setStateCalls = []
	const mr = {
		createElement: (type, p, ...kids) => {
			const flat = kids.flat(Infinity)
			return { type, props: p || {}, children: flat.filter((k) => k != null && k !== false) }
		},
		useState(init) {
			const i = cursor++
			if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
			return [slots[i], function (updater) {
				if (typeof updater === 'function') {
					slots[i] = updater(slots[i])
				} else {
					slots[i] = updater
				}
				setStateCalls.push({ slot: i, value: slots[i] })
			}]
		},
		useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
		useEffect() { cursor++ },
	}
	const prim = { Modal: function Modal() {}, Button: function Button() {} }
	const req = (n) => {
		if (n === 'react') return mr
		if (n === '@deepseek-ai/dsh-client-ui-primitives') return prim
		throw new Error('意外 require：' + n)
	}

	const fetchCalls = []
	const responseQueue = [...(fetchResponseQueue || [])]
	const fakeW = {
		__ModuleLoader__: { load: () => {} },
		setTimeout: (fn) => setTimeout(fn, 0),
		prompt: () => {},
		fetch: function (url, opts) {
			fetchCalls.push({ url, opts })
			const responseBody = responseQueue.length > 0 ? responseQueue.shift() : { ok: true }
			const bodyStr = JSON.stringify(responseBody)
			return Promise.resolve({
				json: () => Promise.resolve(responseBody),
				text: () => Promise.resolve(bodyStr),
				ok: true,
				status: 200,
			})
		},
	}

	// 替换 bare fetch() → window.fetch()，使 mock 生效
	const srcToUse = srcOverride || _src
	const modifiedSrc = srcToUse.replace(/\bfetch\(/g, 'window.fetch(')

	let mod = null
	fakeW.__ModuleLoader__.load = (m) => { mod = m }
	new Function('window', 'require', modifiedSrc)(fakeW, req)
	const exp = mod.factory(req)
	const regs = []
	exp.apply({ slots: { inject: (n, cb) => cb(), register: (spec, c) => { regs.push({ spec, comp: c }); return () => {} } }, effect: (fn) => fn() })

	const CourseDialog = regs.find((r) => r.spec.name === 'shell.overlay').comp

	slots[0] = true   // useDialogOpen() → true
	slots[1] = { deps: [] }  // useEffect 占位
	slots[2] = initialState

	function render() {
		cursor = 0
		const tree = CourseDialog({})
		const texts = []
		collectTexts(tree, texts)
		return { tree, texts }
	}

	return { render, fetchCalls, setStateCalls, slots, regs, responseQueue }
}

/* ── [6] 不许出现死按钮：canCreate false/true 各验一遍 ──────────────────── */
{
	// —— canCreate: false → 两个按钮都不应出现 ——
	const textsFalse = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: false, circles: [{ id: 'programming', name: '编程', points: [{ id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 1, lessons: [] }] }] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	})
	ok(!hasText(textsFalse, '+ 新建圆圈'), '[6] canCreate=false → 不渲染「+ 新建圆圈」')
	ok(!hasText(textsFalse, '+ 新建知识点'), '[6] canCreate=false → 不渲染「+ 新建知识点」')

	// —— canCreate: true → 「+ 新建圆圈」应出现 ——
	const textsTrue = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: true, circles: [{ id: 'programming', name: '编程', points: [{ id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 1, lessons: [] }] }] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	})
	ok(hasText(textsTrue, '+ 新建圆圈'), `[6] canCreate=true → 渲染了「+ 新建圆圈」`)

	// —— step=1 + canCreate: true → 「+ 新建知识点」应出现 ——
	const textsStep1 = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [{ id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 1, lessons: [] }] },
		selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	})
	ok(hasText(textsStep1, '+ 新建知识点'), `[6] canCreate=true, step=1 → 渲染了「+ 新建知识点」`)
}

/* ── [7] catalog 拿不到：留在第 1 屏 + 原因可见（**不跳表单屏** —— 那屏已删）──── */
{
	const whyText = '无法读取课程包目录'
	const textsFallback = renderWithState({
		phase: 'ready',
		entry: { form: { fields: [], title: '新课程', intro: '', emptyText: '', submitLabel: '发送', cancelLabel: '取消', template: '' } },
		values: {}, why: null, step: 0,
		catalog: null,
		selectedCircle: null, selectedPoint: null,
		catalogWhy: whyText,
		gates: {},
	})
	ok(!hasText(textsFallback, '发送'), '[7] catalog 拿不到 → **没有发送按钮**（表单屏已删，一键到位在卡片上）')
	ok(!hasText(textsFallback, '要学什么'), '[7] catalog 拿不到 → 不再渲染表单字段')
	ok(hasText(textsFallback, whyText), `[7] catalog 拿不到 → 原因「${whyText}」可见（warning 段渲染了 catalogWhy）`)
}
/* ── [8] 反空转：故意不传原因时，warning 段不该渲染原因文本 ────────────── */
{
	// catalogWhy=null, why=null → 界面里不该出现任何原因相关文本
	const textsNoWhy = renderWithState({
		phase: 'ready',
		entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 2,
		catalog: null,
		selectedCircle: null, selectedPoint: null,
		catalogWhy: null,
	})
	const whyPhrases = ['无法读取', '不可用', '未配置', 'packRoot', 'error', '为什么']
	const leaked = whyPhrases.filter((p) => textsNoWhy.join('').includes(p))
	ok(leaked.length === 0, `[8] 反空转：不传原因时界面里没有原因文本（${leaked.length ? '漏了：' + leaked.join(',') : '干净'}）`)
}

/* ── [9] 空列表出路：0 圆圈 / 0 知识点时有出口；非空时不显示 ────────────── */
{
	// —— 0 圆圈 → 出口在 ——
	const textsEmptyCircles = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: false, circles: [] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
	})
	ok(hasText(textsEmptyCircles, '直接填表开课'), '[9] 0 圆圈 → 显示「直接填表开课」出口')

	// —— 有圆圈 → 出口不在 ——
	const textsNonEmptyCircles = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: false, circles: [{ id: 'programming', name: '编程', points: [{ id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 1, lessons: [] }] }] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
	})
	ok(!hasText(textsNonEmptyCircles, '直接填表开课'), '[9] 有圆圈 → 不显示出口')

	// —— 0 知识点 → 出口在 ——
	const textsEmptyPoints = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: false, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [] },
		selectedPoint: null, catalogWhy: null,
	})
	ok(hasText(textsEmptyPoints, '直接填表开课'), '[9] 0 知识点 → 显示「直接填表开课」出口')

	// —— 有知识点 → 出口不在 ——
	const textsNonEmptyPoints = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: false, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [{ id: 'spring-boot', name: 'Spring Boot', fileBase: 0, nextNumber: 1, lessons: [] }] },
		selectedPoint: null, catalogWhy: null,
	})
	ok(!hasText(textsNonEmptyPoints, '直接填表开课'), '[9] 有知识点 → 不显示出口')

	// —— 反空转：故意不给出路（0 圆圈但不显示出口），要求红 ——
	// 用同样的 0 圆圈数据，断言出口「必须存在」—— 如果实现没加出口，这条就红
	const textsEmptyCirclesCheck = renderWithState({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: false, circles: [] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
	})
	ok(textsEmptyCirclesCheck.join('').includes('直接填表开课'), '[9] 反空转：0 圆圈时出口必须存在（没有就是死路）')
}

/* ── [10] 点「+ 新建圆圈」→ 出现显示名输入框、目录 id 输入框、提交按钮 ──── */
{
	const { render } = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
		newCircle: { open: true, name: '', id: '', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	})
	const { tree, texts } = render()

	// 检查 input 元素（placeholder 不在文本节点里，需要走树结构）
	const inputs = []
	collectInputs(tree, inputs)
	ok(inputs.some((i) => i.placeholder === '显示名（如「数学」）'), '[10] 新建圆圈表单：有显示名输入框')
	ok(inputs.some((i) => i.placeholder === '目录 id（如 math）'), '[10] 新建圆圈表单：有目录 id 输入框')

	// 检查按钮
	const buttons = []
	findButtons(tree, buttons)
	ok(buttons.some((b) => b.text === '创建'), '[10] 新建圆圈表单：有「创建」按钮')
	ok(buttons.some((b) => b.text === '取消'), '[10] 新建圆圈表单：有「取消」按钮')
}

/* ── [11] 提交 → POST /api/whale/circle body 带用户填的 name/id ───────── */
/* ── [12] 成功后 → 重拉 catalog、step=1、selectedCircle 是新建的 ─────── */
{
	const { render, fetchCalls, slots } = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
		newCircle: { open: true, name: '数学', id: 'math', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	}, [
		// POST /api/whale/circle 的响应
		{ ok: true, id: 'math' },
		// GET /api/whale/catalog 的响应（reloadCatalog 用）
		{ ok: true, configured: true, canCreate: true, circles: [{ id: 'math', name: '数学', points: [] }] },
	])

	const { tree } = render()

	// 找到「创建」按钮并调用
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	ok(!!createBtn, '[11] 找到「创建」按钮')
	createBtn.onClick()

	await new Promise((r) => setTimeout(r, 10))

	// [11] 检查 POST 请求
	const postCall = fetchCalls.find((c) => c.url === '/api/whale/circle')
	ok(!!postCall, '[11] 发出了 POST /api/whale/circle')
	if (postCall) {
		ok(postCall.opts.method === 'POST', '[11] 请求方法是 POST')
		const body = JSON.parse(postCall.opts.body)
		ok(body.name === '数学', `[11] body.name === '数学'（实际 "${body.name}"）`)
		ok(body.id === 'math', `[11] body.id === 'math'（实际 "${body.id}"）`)
	}

	// [12] 检查 catalog 重拉和状态推进
	const catalogCall = fetchCalls.find((c) => c.url === '/api/whale/catalog')
	ok(!!catalogCall, '[12] 成功后发出了 GET /api/whale/catalog（重拉）')

	const finalState = slots[2]
	ok(finalState.step === 1, `[12] 状态推进到 step === 1（实际 ${finalState.step}）`)
	ok(finalState.selectedCircle && finalState.selectedCircle.id === 'math', `[12] selectedCircle.id === 'math'（实际 ${(finalState.selectedCircle || {}).id}）`)
}

/* ── [13] 失败 → 错误人话出现在树里、状态不推进 ─────────────────────── */
{
	const { render, fetchCalls, slots } = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
		newCircle: { open: true, name: '数学', id: 'math', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	}, [
		// POST /api/whale/circle 的失败响应
		{ ok: false, error: '目录 id 不合法：math 包含非法字符' },
	])

	const { tree } = render()

	// 找到「创建」按钮并调用
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	createBtn.onClick()

	await new Promise((r) => setTimeout(r, 10))

	// 重新渲染看更新后的树
	const { texts: updatedTexts } = render()
	ok(hasText(updatedTexts, '目录 id 不合法：math 包含非法字符'), '[13] 失败后错误人话出现在树里')

	// 状态不推进
	const finalState = slots[2]
	ok(finalState.step === 0, `[13] 失败后 step 仍为 0（实际 ${finalState.step}）`)

	// 没有 catalog 重拉
	const catalogCall = fetchCalls.find((c) => c.url === '/api/whale/catalog')
	ok(!catalogCall, '[13] 失败后没有重拉 catalog')
}

/* ── [14] 新建知识点同款：POST /api/whale/point → step=2、归属行带新知识点名 ── */
{
	const { render, fetchCalls, slots } = renderAndAct({
		phase: 'ready',
		entry: { form: { fields: [{ id: 'topic', label: '要学什么', required: true, multiline: false }], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [] },
		selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: true, name: '代数', id: 'algebra', saving: false, error: null },
	}, [
		// POST /api/whale/point 的响应
		{ ok: true, id: 'programming/algebra' },
		// GET /api/whale/catalog 的响应（reloadCatalog 用，含新建的知识点）
		{ ok: true, configured: true, canCreate: true, circles: [{ id: 'programming', name: '编程', points: [{ id: 'algebra', name: '代数', fileBase: 0, nextNumber: 1, lessons: [] }] }] },
	])

	const { tree } = render()

	// 找到「创建」按钮并调用
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	ok(!!createBtn, '[14] 找到知识点「创建」按钮')
	createBtn.onClick()

	await new Promise((r) => setTimeout(r, 10))

	// 检查 POST 请求
	const postCall = fetchCalls.find((c) => c.url === '/api/whale/point')
	ok(!!postCall, '[14] 发出了 POST /api/whale/point')
	if (postCall) {
		ok(postCall.opts.method === 'POST', '[14] 请求方法是 POST')
		const body = JSON.parse(postCall.opts.body)
		ok(body.circle === 'programming', `[14] body.circle === 'programming'（实际 "${body.circle}"）`)
		ok(body.name === '代数', `[14] body.name === '代数'（实际 "${body.name}"）`)
		ok(body.id === 'algebra', `[14] body.id === 'algebra'（实际 "${body.id}"）`)
	}

	// 检查状态推进
	const finalState = slots[2]
	// 表单屏已删（2026-09-24 F1c）：建完**留在选知识点这一屏**，不跳任何地方
	ok(finalState.step === 1, `[14] 成功后仍留在选知识点屏（step === 1，实际 ${finalState.step}）`)
	ok(finalState.selectedPoint === null, '[14] 不预选任何点（点卡片才是开课动作）')

	// 重新渲染：新建的点应该在**卡片列表**里（它能点了）
	const { texts: updatedTexts } = render()
	ok(hasText(updatedTexts, '代数'), '[14] 新建的知识点出现在卡片列表里（可以点了）')
}

/* ── [15] 反空转：doCreateCircle 换成空函数 → [11] 的判据必须红 ───────── */
{
	// 修改源码：onClick: doCreateCircle → onClick: function() {}
	const brokenSrc = _src.replace(/onClick: doCreateCircle,/g, 'onClick: function() {},')

	const { render, fetchCalls } = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 0,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: null, selectedPoint: null, catalogWhy: null,
		newCircle: { open: true, name: '数学', id: 'math', saving: false, error: null },
		newPoint: { open: false, name: '', id: '', saving: false, error: null },
	}, [
		{ ok: true, id: 'math' },
		{ ok: true, configured: true, canCreate: true, circles: [{ id: 'math', name: '数学', points: [] }] },
	], brokenSrc)

	const { tree } = render()

	// 找到「创建」按钮并调用 onClick（现在是空函数）
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	ok(!!createBtn, '[15] 找到「创建」按钮（broken 版）')

	if (createBtn) {
		createBtn.onClick()
		await new Promise((r) => setTimeout(r, 10))
	}

	// 反空转断言：fetch 不应该被调用（因为 onClick 是空函数）
	const postCall = fetchCalls.find((c) => c.url === '/api/whale/circle')
	ok(!postCall, '[15] 反空转：doCreateCircle 换成空函数 → POST 未发出（证明 [11] 不是摆设）')
}

/* ══════ 判据 1–4：建点成功 → 「为它生成知识点地图（大纲）」的指令 ══════════════
 * 依据 `01-鲸师.md:204 / :394` + 主人 2026-09-24 拍板（建点成功后自动送一条"生成这张地图"的指令）。
 * 链路：`lib/starter.js` 的 composeMapPrompt（话术唯一家）→ `lib/mods/create.js` 的
 * `POST /api/whale/point` 成功回执 `mapPrompt` → `lib/client.js` 的 pushToComposer（composer 通道）。
 *   [16] 判据 1：话术内容要素齐全
 *   [17] 判据 3：反空转 —— 话术函数换成返回空串，判据必须报出来
 *   [18] 判据 2：只有成功回执带 mapPrompt（坏 id / 重名 / 缺参数 → 没有）
 *   [19] 判据 4：客户端真的会送（成功恰好一次且逐字相同；失败 / 缺 mapPrompt 一次都不送）
 */
const MAP_SAMPLE = { circleId: 'programming', circleName: '编程', pointId: 'spring-boot', pointName: 'Spring Boot' }

/**
 * 地图话术的**内容判据**（[16] 的逐条断言与它同源；[17] 拿它跑变异）。
 * @returns {string[]} 问题列表，空 = 过
 */
function mapPromptProblems(text, exp = { id: 'programming/spring-boot', names: ['编程', 'Spring Boot'] }) {
	const t = String(text ?? '')
	const p = []
	if (!t.trim()) p.push('正文是空的（话术函数返回了空串）')
	if (!t.includes(exp.id)) p.push(`缺点名 圆圈/知识点 规范 id（${exp.id}）`)
	for (const n of exp.names) if (!t.includes(n)) p.push(`缺点名显示名（${n}）`)
	if (!t.includes('whale_plan')) p.push('缺 whale_plan')
	if (!t.includes('op=record')) p.push('缺 op=record')
	if (!t.includes('point') || !t.includes('goal') || !t.includes('nodes')) p.push('缺落盘三件 point + goal + nodes[]')
	for (const f of ['no', 'title', 'deliverable', 'criteria', 'why', 'sources']) {
		if (!t.includes(f)) p.push(`缺节点字段名 ${f}`)
	}
	if (!t.includes('砍')) p.push('缺「why 写不出就砍掉这个节点」的意思')
	if (!t.includes('http')) p.push('缺 sources = http(s) 官方文档/规范')
	if (!t.includes('大纲')) p.push('缺「地图是大纲」')
	if (!t.includes('正文细节')) p.push('缺「不写正文细节」')
	if (!t.includes('学完') || !t.includes('交付')) p.push('缺 goal = 学完能交付什么（终点本体）')
	if (!t.includes('建不了课') || !t.includes('force')) p.push('缺「没地图就建不了课 / 禁 force 绕」')
	return p
}

/* ── [16] 判据 1：lib/starter.js 拼出的正文要素齐全 ─────────────────── */
{
	const text = composeMapPrompt(MAP_SAMPLE)
	ok(text.includes('whale_plan'), '[16] 话术含 whale_plan')
	ok(text.includes('op=record'), '[16] 话术含 op=record')
	ok(text.includes('point') && text.includes('goal') && text.includes('nodes'), '[16] 写明落盘三件：whale_plan op=record（point + goal + nodes[]）')
	ok(text.includes('no'), '[16] 节点六样 · no')
	ok(text.includes('title'), '[16] 节点六样 · title')
	ok(text.includes('deliverable'), '[16] 节点六样 · deliverable')
	ok(text.includes('criteria'), '[16] 节点六样 · criteria')
	ok(text.includes('why'), '[16] 节点六样 · why')
	ok(text.includes('sources'), '[16] 节点六样 · sources')
	ok(text.includes('why') && text.includes('砍'), '[16] why 与「写不出 why 就把这个节点砍掉」的意思')
	ok(text.includes('http'), '[16] sources 必须是 http(s) 官方文档/规范')
	ok(text.includes('大纲') && text.includes('正文细节'), '[16] 「地图是大纲 / 不写正文细节」的意思')
	ok(text.includes('programming/spring-boot') && text.includes('编程') && text.includes('Spring Boot'), '[16] 点名知识点（圆圈/知识点 与显示名）')
	ok(text.includes('学完') && text.includes('交付'), '[16] goal = 终点本体（学完能交付什么，一句话）')
	ok(text.includes('建不了课') && text.includes('force'), '[16] 提醒：没地图就建不了课（大纲闸，禁 force 绕）')
	const problems = mapPromptProblems(text)
	ok(problems.length === 0, `[16] 统一内容判据全过（${problems.join('；') || '干净'}）`)
}

/* ── [17] 判据 3：反空转 —— 话术函数换成返回空串，判据必须报出来 ────── */
{
	const libDir = path.join(PLUGIN, 'lib')
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-map-prompt-'))
	for (const f of fs.readdirSync(libDir)) {
		if (f.endsWith('.js')) fs.copyFileSync(path.join(libDir, f), path.join(tmp, f))
	}
	const src = fs.readFileSync(path.join(libDir, 'starter.js'), 'utf8')
	const mutated = src.replace(/export function composeMapPrompt\([\s\S]*?\n}/, "export function composeMapPrompt() {\n\treturn ''\n}")
	ok(mutated !== src && /return ''/.test(mutated), '[17] 变异真的发生了：composeMapPrompt 整个换成 return ""')
	fs.writeFileSync(path.join(tmp, 'starter.js'), mutated, 'utf8')
	const broken = await import(pathToFileURL(path.join(tmp, 'starter.js')).href)
	ok(broken.composeMapPrompt(MAP_SAMPLE) === '', '[17] 变异后的函数真的返回空串')
	const problems = mapPromptProblems(broken.composeMapPrompt(MAP_SAMPLE))
	ok(problems.length > 0, `[17] 反空转：返回空串 → 判据必须报出来（实报 ${problems.length} 条，如「${problems[0] || '无'}」）`)
	ok(mapPromptProblems(composeMapPrompt(MAP_SAMPLE)).length === 0, '[17] 同一判据在真话术上是过的（不是永远报错的假判据）')
	fs.rmSync(tmp, { recursive: true, force: true })
}

/* ── [18] 判据 2：只有建点成功回执带 mapPrompt（失败一个字都不带）───── */
{
	// 合成最小课程包（临时目录，绝不碰真包）：一个圆圈 + 一个已有点（用它测「重名拒覆盖」）
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-map-route-'))
	fs.mkdirSync(path.join(tmp, 'lessons', 'math', 'algebra'), { recursive: true })
	fs.writeFileSync(path.join(tmp, 'lessons', 'math', 'halo.json'), JSON.stringify({ halo: 'math', name: '数学' }, null, 2) + '\n')
	fs.writeFileSync(path.join(tmp, 'lessons', 'math', 'algebra', 'point.json'), JSON.stringify({ point: 'algebra', name: '代数', fileBase: 0 }, null, 2) + '\n')
	const routes = []
	const hctx = {
		paths: { packRoot: tmp, dataDir: tmp },
		log: { info() {}, warn() {}, error() {} },
		registerTool: () => {},
		inject: (names, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
	}
	const { plugin } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'mods', 'create.js')).href)
	plugin.install(hctx)
	const pointR = routes.find((r) => r.path === '/api/whale/point')
	const call = (body) => pointR.fetch({ method: 'POST', url: 'http://127.0.0.1/api/whale/point', json: async () => body })

	const good = await (await call({ circle: 'math', name: '几何', id: 'geometry' })).json()
	ok(good.ok === true, '[18] 建点成功（math/geometry）')
	ok(typeof good.mapPrompt === 'string' && good.mapPrompt.trim().length > 0, '[18] 成功回执带非空 mapPrompt')
	ok(mapPromptProblems(good.mapPrompt, { id: 'math/geometry', names: ['数学', '几何'] }).length === 0,
		`[18] 回执里的 mapPrompt 过内容判据（${mapPromptProblems(good.mapPrompt, { id: 'math/geometry', names: ['数学', '几何'] }).join('；') || '干净'}）`)
	ok(good.mapPrompt.includes('math/geometry') && good.mapPrompt.includes('几何') && good.mapPrompt.includes('数学'),
		'[18] mapPrompt 点名圆圈/知识点与显示名（math/geometry · 数学 / 几何）')

	const badId = await (await call({ circle: 'math', name: 'X', id: 'Bad_Id' })).json()
	ok(badId.ok === false && !('mapPrompt' in badId), '[18] 坏 id → 失败回执里没有 mapPrompt')
	const dup = await (await call({ circle: 'math', name: '代数2', id: 'algebra' })).json()
	ok(dup.ok === false && !('mapPrompt' in dup), '[18] 重名（拒覆盖）→ 失败回执里没有 mapPrompt')
	const noName = await (await call({ circle: 'math', id: 'trig' })).json()
	ok(noName.ok === false && !('mapPrompt' in noName), '[18] 缺参数（没有 name）→ 失败回执里没有 mapPrompt')
	fs.rmSync(tmp, { recursive: true, force: true })
}

/* ── [19] 判据 4：客户端真的会送（composer 通道与 send() 同一条）────── */
{
	const mapText = composeMapPrompt(MAP_SAMPLE)
	const drafted = []
	const submitted = []
	const act = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [] },
		selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: true, name: '代数', id: 'algebra', saving: false, error: null },
	}, [
		// ① POST /api/whale/point 成功回执（mapPrompt 就是 [18] 钉的那个字段）
		{ ok: true, id: 'programming/algebra', mapPrompt: mapText },
		// ② reloadCatalog 的 GET /api/whale/catalog
		{ ok: true, configured: true, canCreate: true, circles: [{ id: 'programming', name: '编程', points: [{ id: 'algebra', name: '代数', fileBase: 0, nextNumber: 1, lessons: [] }] }] },
	])
	// composer 桥（宿主注入的 inputActions）—— 与 panel.mjs 那条真流程同一套缝
	const bridge = act.regs.find((r) => r.spec.id === 'whale-bridge')
	ok(!!bridge, '[19] composer 桥（id: whale-bridge）在假环境里注册了')
	bridge.comp({ inputActions: { setDraft: (t) => drafted.push(t), submit: () => submitted.push(1) } })

	const { tree } = act.render()
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	ok(!!createBtn, '[19] 找到知识点「创建」按钮')
	createBtn.onClick()
	await new Promise((r) => setTimeout(r, 30))

	ok(drafted.length === 1, `[19] 建点成功 → composer 通道恰好被调用一次（setDraft 实得 ${drafted.length} 次）`)
	ok(drafted.length === 1 && drafted[0] === mapText, '[19] 送出的文本 === 服务端给的 mapPrompt（逐字相同）')
	ok(submitted.length === 1, `[19] submit 恰好一次（实得 ${submitted.length} 次）`)

	// 重试同一次建点（服务端拒覆盖）→ **不许再送第二条**
	act.responseQueue.push({ ok: false, error: '知识点 programming/algebra 已存在，拒绝覆盖' })
	act.slots[2] = Object.assign({}, act.slots[2], { newPoint: { open: true, name: '代数', id: 'algebra', saving: false, error: null } })
	const again = act.render()
	const btns2 = []
	findButtons(again.tree, btns2)
	const retryBtn = btns2.find((b) => b.text === '创建')
	if (retryBtn) retryBtn.onClick()
	await new Promise((r) => setTimeout(r, 30))
	ok(drafted.length === 1 && submitted.length === 1, `[19] 重试被拒后没有再送（setDraft 仍 ${drafted.length} 次）—— 同一次建点只送一条`)
}

/* ── [19b] 建点失败 → composer 一次都不许被调用 ─────────────────────── */
{
	const drafted = []
	const submitted = []
	const act = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [] },
		selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: true, name: '代数', id: 'algebra', saving: false, error: null },
	}, [
		{ ok: false, error: 'point id 不合法：Bad_Id —— 必须匹配 /^[a-z][a-z0-9-]*$/' },
	])
	const bridge = act.regs.find((r) => r.spec.id === 'whale-bridge')
	bridge.comp({ inputActions: { setDraft: (t) => drafted.push(t), submit: () => submitted.push(1) } })
	const { tree } = act.render()
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	if (createBtn) createBtn.onClick()
	await new Promise((r) => setTimeout(r, 30))
	ok(drafted.length === 0 && submitted.length === 0,
		`[19b] 建点失败 → composer 一次都没被调用（setDraft ${drafted.length} / submit ${submitted.length}）`)
}

/* ── [19c] 成功但没拿到 mapPrompt（旧宿主 / 缺字段）→ 也一个字不送 ──── */
{
	const drafted = []
	const submitted = []
	const act = renderAndAct({
		phase: 'ready', entry: { form: { fields: [], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 1,
		catalog: { ok: true, canCreate: true, circles: [] },
		selectedCircle: { id: 'programming', name: '编程', points: [] },
		selectedPoint: null, catalogWhy: null,
		newCircle: { open: false, name: '', id: '', saving: false, error: null },
		newPoint: { open: true, name: '代数', id: 'algebra', saving: false, error: null },
	}, [
		{ ok: true, id: 'programming/algebra' },
		{ ok: true, configured: true, canCreate: true, circles: [{ id: 'programming', name: '编程', points: [{ id: 'algebra', name: '代数', fileBase: 0, nextNumber: 1, lessons: [] }] }] },
	])
	const bridge = act.regs.find((r) => r.spec.id === 'whale-bridge')
	bridge.comp({ inputActions: { setDraft: (t) => drafted.push(t), submit: () => submitted.push(1) } })
	const { tree } = act.render()
	const buttons = []
	findButtons(tree, buttons)
	const createBtn = buttons.find((b) => b.text === '创建')
	if (createBtn) createBtn.onClick()
	await new Promise((r) => setTimeout(r, 30))
	ok(drafted.length === 0 && submitted.length === 0,
		`[19c] 没拿到 mapPrompt → 一个字都不送（硬约束 1；setDraft ${drafted.length} / submit ${submitted.length}）`)
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 新课程向导：三段契约 / 字段表已删 / 归属行按需出现 / 新建流程判据 / 建点后地图指令（mapPrompt）')
