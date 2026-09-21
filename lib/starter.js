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
 * 入口载荷（既给设置页那张卡，也给输入框左侧那个按钮）。
 * @param {string|null} root 课程包根目录（可空：入口本身不依赖课程包）
 * @returns {{id:string, label:string, hint:string, steps:string[], prompt:string, tracks:string[]}}
 */
export function buildStarter(root) {
	const tracks = readTracks(root)
	const steps = [
		'① 问我学什么',
		'② 先查资料，出处落 RESOURCES.md',
		'③ 问我掌握程度（whale_intake 落盘，没落盘不许开课）',
		'④ 大纲过一眼 → whale_author → whale_build → 闸门',
	]
	return {
		id: STARTER_ID,
		label: STARTER_LABEL,
		hint: STARTER_HINT,
		steps,
		prompt: protocolLines(tracks).join('\n'),
		tracks,
	}
}
