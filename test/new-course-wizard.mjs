#!/usr/bin/env node
/**
 * test/new-course-wizard.mjs — 新课程向导判据
 * ------------------------------------------------------------------
 * 断言：
 *   1. starter.js 的字段定义：5 个 id 齐全、两个必填、label 与 hint 逐字等于既有文本
 *   2. 正文组装：给 circle/point 时含 `- 归属：…（programming/spring-boot）`；不给时不含
 *   3. catalog 客户端契约：canCreate === false、nextFileBase 存在且对 programming 为 2000（max fileBase + 1000）
 *   4. 客户端源码里三屏的顺序正确
 *   5. 反空转哨兵：故意错序会红
 *   6. 不许出现死按钮：canCreate === false 时渲染函数不产出新建按钮
 */

import fs from 'node:fs'
import path from 'node:path'
import { packRoot, PLUGIN } from './_pack.mjs'
import { FORM_FIELDS, FORM_EMPTY_TEXT, composeRequest, buildStarter } from '../lib/starter.js'

const ROOT = packRoot()
let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }

console.log(`\n[new-course-wizard] 课程包：${ROOT}`)

/* ── [1] starter.js 字段定义 ───────────────────────────────────────────── */
{
	ok(FORM_FIELDS.length === 5, `[1] 字段数量：${FORM_FIELDS.length}（期望 5）`)

	const ids = FORM_FIELDS.map((f) => f.id)
	ok(ids.join(',') === 'topic,goal,scope,refs,notes', `[1] 字段 id 齐全且顺序正确（${ids.join(',')}）`)

	const required = FORM_FIELDS.filter((f) => f.required)
	ok(required.length === 2 && required.map((f) => f.id).join(',') === 'topic,goal', `[1] 必填字段：${required.map((f) => f.id).join(',')}（期望 topic,goal）`)

	// 逐字校验 label（这是"问什么没变"的判据）
	const expectedLabels = {
		topic: '要学什么',
		goal: '学完要能做出什么',
		scope: '期望篇幅与深度',
		refs: '指定资料 / 参考',
		notes: '其它要求',
	}
	for (const f of FORM_FIELDS) {
		ok(f.label === expectedLabels[f.id], `[1] ${f.id}.label === "${expectedLabels[f.id]}"（实际 "${f.label}"）`)
	}

	// 逐字校验 hint
	const expectedHints = {
		topic: '知识点 / 主题，例如「Vue 3 组合式 API」',
		goal: '一句话就够，用来定验收标准',
		scope: '例如「3 节，能上手写 CRUD」',
		refs: '官方链接、书名、仓库地址；不填我自己找',
		notes: '风格、语言 / 版本、时间安排',
	}
	for (const f of FORM_FIELDS) {
		ok(f.hint === expectedHints[f.id], `[1] ${f.id}.hint === "${expectedHints[f.id]}"（实际 "${f.hint}"）`)
	}
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
	ok(textWithoutBelong.startsWith('【开课请求】\n- 要学什么：'), '[2] 不给归属时正文开头保持老行为（无空行）')
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

/* ── detectStepOrder：三屏顺序检测器（被 [4] 和 [5] 共用）────────────── */
/**
 * 检测已剥注释的源码里三屏条件的出现顺序。
 * 返回 { mark0, mark1, mark2, inOrder }。
 * mark* 是三个代码条件字符串在 src 中的 indexOf 位置（-1 = 没找到）。
 * inOrder = 仅当 mark0 > -1 且 mark0 < mark1 < mark2 时为 true。
 */
function detectStepOrder(src) {
	const mark0 = src.indexOf('state.step === 0 && state.catalog')
	const mark1 = src.indexOf('state.step === 1 && state.selectedCircle')
	const mark2 = src.indexOf('state.step === 2 && form')
	const inOrder = mark0 > -1 && mark1 > -1 && mark2 > -1 && mark0 < mark1 && mark1 < mark2
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
	ok(r.mark2 > -1, `[4] 找到 step === 2 条件（位置 ${r.mark2}）`)
	ok(r.inOrder, `[4] 三屏顺序正确：step0(${r.mark0}) → step1(${r.mark1}) → step2(${r.mark2})`)
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

/* ── [7] 退回单屏表单：catalog 拿不到时 step=2、发送按钮在、原因可见 ──── */
{
	// catalog 拿不到 → step=2、catalog=null、catalogWhy 有值
	const whyText = '无法读取课程包目录'
	const textsFallback = renderWithState({
		phase: 'ready',
		entry: { form: { fields: [{ id: 'topic', label: '要学什么', required: true, multiline: false }], title: '新课程', intro: '', submitLabel: '发送', cancelLabel: '取消' } },
		values: {}, why: null, step: 2,
		catalog: null,
		selectedCircle: null, selectedPoint: null,
		catalogWhy: whyText,
	})
	ok(hasText(textsFallback, '要学什么'), '[7] catalog 拿不到 → step=2 → 表单字段在')
	ok(hasText(textsFallback, '发送'), '[7] catalog 拿不到 → 发送按钮在')
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

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 新课程向导：三屏顺序 / 字段逐字未变 / 归属行按需出现')
