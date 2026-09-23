/**
 * lib/starter.js — 开课入口的**开场白协议**（纯函数层）
 * ------------------------------------------------------------------
 * 解决的问题：DSH 主页面原来没有任何"下一节课从哪开始"的入口，
 * 于是每开一门新课时，流程契约（先查资料 → 问掌握程度 → 再生成）**全靠 agent 自觉** ——
 * 2026-09-21 实测就漏掉了"问掌握程度"这一步。
 *
 * 办法：把协议**算好**（而不是写在客户端里），由宿主随只读状态路由一起发出去：
 *   · 浏览器半边的入口按钮只负责"画 + 塞文本"，不持有第二份协议；
 *   · 于是"协议里到底写了什么"是**可离线判据的**（test/panel.mjs 断言要素齐全），
 *     而不是只能靠人眼看。
 *
 * 两条硬规矩：
 *   1. **纯函数、不含时间戳**：同样的输入 → 逐字节相同的输出（可对拍）；
 *   2. 协议里点名的工具名必须是**真的存在**的（`whale_intake` / `whale_author` /
 *      `whale_build` / `whale_visual`）—— 写一个不存在的工具名，比不写还坏。
 */

import { readPack } from './pack-model.js'

/** 入口的稳定 id（客户端注册 slot 时用它；改这个名字等于换一个入口） */
export const STARTER_ID = 'new-course'

/** 按钮上显示的文案。**客户端那一行也写着同一个字**（`lib/client.js` 的 `ENTRY_LABEL`），
 *  test/panel.mjs 拿这个常量对拍 —— 改一处就得改另一处。 */
export const STARTER_LABEL = '新课程'

/** 一句话提示（鼠标悬浮 / 副标题）；客户端 `ENTRY_TITLE` 与它同义 */
export const STARTER_HINT = '把开课协议送进输入框（先查资料 → 问掌握程度 → 再生成课程）'

/**
 * 课程包里现有的知识点名（失败就空数组，绝不因为读不动课程包而不给入口）
 * @param {string|null} root
 * @returns {string[]}
 */
function readTracks(root) {
	if (!root) return []
	try {
		const pack = readPack(root)
		return (pack.points || [])
			.map((p) => p.name || p.id)
			.filter(Boolean)
	} catch {
		return []
	}
}

/**
 * 四步开课协议（人话，写给**任何一个**接着干活的 agent 读）。
 * 为什么每一步都要写死：
 *   · 第 ① 步防"你没说清我就猜"；
 *   · 第 ② 步是课程包的硬规矩（SKILL.md §5 Research first, cite always，出处落 RESOURCES.md）；
 *   · 第 ③ 步就是 2026-09-21 漏掉的那一步 —— 由 `whale_intake` 落盘、`whale_author` 闸门兜底；
 *   · 第 ④ 步把"先给方案再动手"写进流程：大纲先过一眼，再写正文。
 */
function protocolLines(tracks) {
	const lines = [
		'开一门新课。严格按下面四步走，别跳步：',
		'',
		'① 先问我学什么：要学哪个知识点/主题、想拿它解决什么问题。',
		'   （我这条消息里已经说清了就直接用，不要再问一遍。）',
		'',
		'② 先查资料，再动笔：查官方文档 / 规范 / 源码，把出处逐条落到课程包的 RESOURCES.md。',
		'   禁止凭记忆写课。',
		'',
		'③ 问我掌握程度 —— 这一步必须有，而且要在写课之前完成：',
		'   用 whale_intake op=plan 拿问题清单，逐条问我（以前用过什么 / 现在能独立写出什么 /',
		'   卡在哪一步最痛 / 学完想达到什么水平 / 每周能投入多少），拿到回答后',
		'   whale_intake op=record 落盘。没落盘之前 whale_author 会被闸门拦下 ——',
		'   那是刻意的，别用 force 绕过去。',
		'',
		'④ 回答拿到之后，先把这一课的大纲给我过一眼（教什么、前置是什么、分几节），',
		'   我说行再写正文：whale_author 生成五槽位源文件 → 写内容 → whale_build 渲染 →',
		'   课程包 tools/gate.mjs 过闸门 → 重建星图与笔记 → whale_visual 截图自检。',
	]
	if (tracks.length) {
		lines.push('', `（课程包里现有的知识点：${tracks.join('、')}）`)
	}
	return lines
}

/**
 * 弹窗里要问的字段 —— **做课必要信息**，刻意**不含摸底**：
 * 摸底（学生现在会什么）是发出去之后由 agent 按四步协议第 ③ 步单独问的那一轮，
 * 混进这张表就会变成"填表即摸底"，而学生往往不知道该怎么说。
 *
 * ② 终点接线（P0 契约 §3.1 / Q5 裁定）：`goal` 保留为「作品一句话」（= GoalRecord.artifact.what，
 * **原文逐字**，不许拿摸底的 can/prior/level 回落顶替），同批收 `work`（作品放哪，可选）/
 * `tier`（必填，学到哪一层）/ `acceptance`（必填，一行一条）→ 三者一起落
 * `learning-records/goals.jsonl`（lib/goal-io.js 的 recordGoal）。
 * 必填集合 = topic + goal + tier + acceptance。措辞**避开**「掌握程度 / 学过什么 / 基础如何」
 * —— 那是摸底的问法（test/panel.mjs 与 --selftest 都钉着这条红线）。
 */
export const FORM_FIELDS = [
	{ id: 'topic', label: '要学什么', hint: '知识点 / 主题，例如「Vue 3 组合式 API」', required: true, multiline: false },
	{ id: 'goal', label: '学完要能做出什么', hint: '一句话就够，用来定验收标准', required: true, multiline: true },
	{ id: 'work', label: '作品放哪', hint: '作品仓 / 路径，例如「code/_hello-spring-boot」；不填就是还没定', required: false, multiline: false },
	{ id: 'tier', label: '学到哪一层', hint: '1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲（填一个数字）', required: true, multiline: false },
	{ id: 'acceptance', label: '验收判据', hint: '一行一条，写清「做成什么样就算过」', required: true, multiline: true },
	{ id: 'scope', label: '期望篇幅与深度', hint: '例如「3 节，能上手写 CRUD」', required: false, multiline: false },
	{ id: 'refs', label: '指定资料 / 参考', hint: '官方链接、书名、仓库地址；不填我自己找', required: false, multiline: true },
	{ id: 'notes', label: '其它要求', hint: '风格、语言 / 版本、时间安排', required: false, multiline: true },
]

/** 空值占位：如实说"没填的我会自己定"，而不是留一个空行让 agent 猜 */
export const FORM_EMPTY_TEXT = '（未填，你来定）'

/**
 * 拼装「开课请求」正文（**纯函数**，所以可离线判据 —— test/panel.mjs 直接调它）。
 *
 * 为什么拼装在宿主侧而不是浏览器半边：这套话术（含四步协议）只能有一份实现；
 * 客户端只负责收集 `values`，拼装规则、必填校验、话术全在 `lib/starter.js`。
 *
 * @param {{fields: {id: string}[], template: string}} form
 * @param {Record<string, string>} values
 * @param {string} protocol 四步协议全文（`buildStarter().prompt`）
 * @param {string} [circle] 圆圈名（可选）
 * @param {string} [point] 知识点名（可选）
 * @param {string} [pointId] 知识点规范 id（可选，如 "programming/spring-boot"）
 * @returns {string}
 */
export function composeRequest(form, values = {}, protocol = '', circle, point, pointId) {
	const pick = (id) => {
		const raw = values[id]
		return (raw === undefined || raw === null ? '' : String(raw)).trim() || FORM_EMPTY_TEXT
	}
	let text = form.template
	for (const f of form.fields) text = text.split(`{{${f.id}}}`).join(pick(f.id))
	// 归属行：只有传了 circle 和 point 时才出现。
	// 末尾**不带换行** —— 模板里 `{{belong}}` 独占一行，带 `\n` 会多出一个空行。
	const belongLine = (circle && point && pointId)
		? `- 归属：${circle} / ${point}（${pointId}）`
		: ''
	// 处理归属行：如果 belongLine 为空，移除模板中的空行
	if (!belongLine) {
		// 移除 {{belong}} 及其后面的换行符
		text = text.replace('{{belong}}\n', '')
	} else {
		text = text.split('{{belong}}').join(belongLine)
	}
	return text.split('{{protocol}}').join(protocol)
}

/**
 * 必填却没填的字段**标签**（宿主侧也查一遍：客户端那次校验只是为了省一次往返，不是判据）。
 * @returns {string[]}
 */
export function missingRequired(form, values = {}) {
	return form.fields
		.filter((f) => f.required && !String(values[f.id] ?? '').trim())
		.map((f) => f.label)
}

/**
 * 表单答案 → 终点契约的写入入参（**纯函数**；落盘在 `lib/mods/starter.js` 走 `recordGoal`）。
 *
 * 三条硬口径（P0 契约 §3.1 / §3.2 / Q10 + 主线程硬约束）：
 *   ① `artifact.what` = wizard `goal` **原文逐字** —— 绝不拿摸底的 can / prior / level 回落顶替
 *      （`intakeToStage` 里那条 can→prior→level 回落**只属于起点台阶**的语义）。
 *   ② 归属只认 `pointId`（"programming/spring-boot" 形态）：`point` 取其**最后一段**；
 *      没有 pointId = 无法归属 → 返回 null（调用方**不落盘**，只提示「终点还没结构化」，Q10）。
 *      （POST 里的 `point` 是**显示名**（client.js 发 selectedPoint.name），落进台账会污染命名空间。）
 *   ③ `acceptance` 表单逐行 → `{no, deliverable, auto:false, hint}`（§3.1：一行一条，机器判不了就老实标 auto:false，
 *      agent 后续版本可升级为带 checks 的机械判据）。
 *
 * tier 只在这里做"数字面值"归一（表单收上来的是字符串）；**值**合不合法由 `validateStage()` 判
 * （写侧严格，坏值原样传进去让它报错 —— 不许在这儿另定一套 schema）。
 *
 * @returns {object|null} recordGoal 的入参（v / replaces / from 由台账算），无归属 → null
 */
export function goalFromForm(values = {}, pointId) {
	const pid = String(pointId ?? '').trim()
	if (!pid) return null
	const segs = pid.split('/').filter(Boolean)
	const point = segs.length ? segs[segs.length - 1] : null
	if (!point) return null
	const rawTier = String(values.tier ?? '').trim()
	const tier = /^[1-4]$/.test(rawTier) ? Number(rawTier) : rawTier
	const lines = String(values.acceptance ?? '')
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean)
	return {
		point,
		pointPath: pid,
		tier,
		// artifact.what = goal 原文逐字（终点必须来自 wizard 的显式输入）
		artifact: {
			what: String(values.goal ?? '').trim(),
			where: String(values.work ?? '').trim() || null,
		},
		acceptance: lines.map((line, i) => ({ no: i + 1, deliverable: line, auto: false, hint: line })),
		focus: null,
		source: 'wizard',
		reason: null,
	}
}

/**
 * 入口载荷（给侧栏按钮 + 弹窗；弹窗的字段与模板也在这里，客户端不持有第二份）。
 * @param {string|null} root 课程包根目录（可空：入口本身不依赖课程包）
 * @returns {{id:string, label:string, hint:string, steps:string[], prompt:string, tracks:string[], form:object}}
 */
export function buildStarter(root) {
	const tracks = readTracks(root)
	const steps = [
		'① 问我学什么',
		'② 先查资料，出处落 RESOURCES.md',
		'③ 问我掌握程度（whale_intake 落盘，没落盘不许开课）',
		'④ 大纲过一眼 → whale_author → whale_build → 闸门',
	]
	const prompt = protocolLines(tracks).join('\n')
	const form = {
		title: STARTER_LABEL,
		// 弹窗底部如实说明顺序 —— 摸底在**这条消息之后**，不是填表时问
		intro: '填完点「发送」。发送后我会：先查官方资料 → 再问你掌握程度（3–5 个问题）→ 给你看大纲 → 最后才写课。',
		fields: FORM_FIELDS,
		emptyText: FORM_EMPTY_TEXT,
		submitLabel: '发送',
		cancelLabel: '取消',
		template: [
			'【开课请求】',
			'{{belong}}',
			...FORM_FIELDS.map((f) => `- ${f.label}：{{${f.id}}}`),
			'',
			'下面是本课程的流程契约，请严格按它执行；第 ③ 步的「掌握程度」要**在这条消息之后、写课之前**做：',
			'',
			'{{protocol}}',
		].join('\n'),
	}
	return {
		id: STARTER_ID,
		label: STARTER_LABEL,
		hint: STARTER_HINT,
		steps,
		prompt,
		tracks,
		form,
	}
}
