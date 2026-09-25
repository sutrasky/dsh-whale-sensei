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
export const STARTER_HINT = '把开课协议送进输入框（①查资料 → ②看挑战 + 问终点与掌握程度 → ③生成课程）'

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
 * **三段**开课协议（人话，写给**任何一个**接着干活的 agent 读）。
 *
 * 2026-09-24 F1b：四步 → 三段（v3 §1.1 / 主人 2026-09-24 定）。
 *   · 原第 ① 步「先问我学什么」**整步删掉** —— 点知识点卡片时归属就已经定了（`{{belong}}` 那行）；
 *   · 原第 ② 步「先查资料」升为 ①；
 *   · 原第 ③ 步「问掌握程度」并进 ②，与「看挑战」同段 —— 两者都是写课前的**输入**，
 *     而且终点（goal/tier/acceptance）也在这里问（原表单屏删了，它是唯一的落点）；
 *   · 原第 ④ 步「大纲过一眼再写」并进 ③：**大纲内含在课程设计里，不单列一段**。
 * 为什么每一样都要写死：
 *   · ① 是课程包的硬规矩（SKILL.md §5 Research first, cite always，出处落 RESOURCES.md）；
 *   · ② 的两个落盘口（whale_intake / whale_goal）都有闸门兜底，漏一个 whale_author 就拦；
 *   · ③ 把"先给方案再动手"与逐字节对拍那套写进流程。
 * 2026-09-24 F2c：③ 加"先在**知识点地图**上定这一课教什么" —— `01:394` 要的是
 *   "③生成课程按大纲定'下一课教什么'（**替代"文件名序+1"**）"。引擎是 `whale_plan op=read`
 *   报的「下一课 第N课 <主题>」（判据在 `lib/plan.js` 的 `planFrontier`，`01:205` 的"下一个星星 —— 或两颗"）。
 *   话术里明写"别按文件名序 +1"，因为那正是它要替代的旧习惯。
 */
function protocolLines(tracks) {
	const lines = [
		'开一门新课。严格按下面三段走，**顺序就是依赖**，别跳步：',
		'',
		'① 查资料：查官方文档 / 规范 / 源码，把出处逐条落到课程包的 RESOURCES.md。',
		'   禁止凭记忆写课。',
		'',
		'② 看挑战 + 问终点与掌握程度（这一段是**写课前的输入**，必须做完再往下）：',
		'   a) 看挑战：读 learning-records/state.json，把**上一课**的挑战逐条念给我听',
		'      （过了几道、还缺哪几道、哪几道需要人工确认）。这段与开新课的门禁**同一套判据**。',
		'   b) 问终点（三件，缺一不可）：学完要能做出什么（**我的原话，一句话**）/ 学到哪一层',
		'      （1 认得 / 2 会照做 / 3 能独立做 / 4 能改能讲）/ 验收判据（一行一条）。',
		'   c) 问掌握程度：用 whale_intake op=plan 拿问题清单，逐条问我（以前用过什么 /',
		'      现在能独立写出什么 / 卡在哪一步最痛），拿到回答后 whale_intake op=record 落盘。',
		'   d) 落终点：whale_goal op=record 把 b) 问到的三件落成契约（point / goal / tier / acceptance）。',
		'      **必须排在 c) 之后** —— 契约里的起点台阶（from）会自动从最新摸底拷贝。',
		'   e) 教学方式（**学生提了才做**，没提就跳过）：他说"多加点注释"这类没法执行的话时，',
		'      **先翻译成参数取值**（whale_teaching op=read 看可调集与档位默认）→ 给他看**预览**',
		'      （会落成哪一行，op=propose 不写盘）→ **他点头**才 op=write + confirm:true。',
		'      教学纪律（先读学生代码 / 先查资料给出处 / 不拿口头确认判过）**不在可调集里**，他说改也不改。',
		'   两个落盘口没做完之前 whale_author 会被闸门拦下 —— 那是刻意的，别用 force 绕过去。',
		'',
		'③ 生成课程：**先在知识点地图上定"这一课教什么"，别按文件名序 +1** ——',
		'   whale_plan op=read 会给出「下一课 第N课 <主题>」，连同它的可交付物与通过判据；',
		'   那就是这一课的设计输入。地图说"全建完了"就别硬开新课，先问我。',
		'   然后：五槽位源文件（大纲不单列一段 —— 它就来自地图）→ whale_build 渲染 →',
		'   课程包 tools/gate.mjs 过闸门 → 重建星图与笔记 → whale_visual 截图自检。',
	]
	if (tracks.length) {
		lines.push('', `（课程包里现有的知识点：${tracks.join('、')}）`)
	}
	return lines
}

// 2026-09-24 F1b：**弹窗字段表已删**（原 8 个：topic / goal / work / tier / acceptance / scope / refs / notes）。
// v3 §1.1 把它那一屏整个删掉、改成「点知识点卡片 = 一键到位」，于是三个输入各自搬了家：
//   · `topic`            → 知识点卡片自己就说清了（`{{belong}}` 那行带 circle / point / pointId）
//   · `goal`/`tier`/`acceptance` → 三段流程的 **②看挑战段**问出来，经 `whale_goal op=record` 落 `goals.jsonl`
//   · `work`/`scope`/`refs`/`notes` → 可选信息，agent 在 ①查资料 / ②那一轮顺口问，不落契约
// ⚠️ 映射函数 `goalFromForm()` **留在本文件**（只有一份实现）—— 现在由 `lib/mods/goal.js` 调，
//    不再是 wizard 路由调。删掉它会让 agent 侧被迫另写一份映射，那就是"同一事实两套口径"。

/** 空值占位：如实说"没填的我会自己定"，而不是留一个空行让 agent 猜 */
export const FORM_EMPTY_TEXT = '（未填，你来定）'

/**
 * 拼装「开课请求」正文（**纯函数**，所以可离线判据 —— test/panel.mjs 直接调它）。
 *
 * 为什么拼装在宿主侧而不是浏览器半边：这套话术（含三段协议）只能有一份实现；
 * 客户端只负责把归属塞进来，拼装规则、校验、话术全在 `lib/starter.js`。
 *
 * 2026-09-24 F1b：`form.fields` 现在是**空数组**（弹窗表单屏已删）—— 循环留着是为了
 * 以后真要加回某个字段时不必改这里；`values` 同理。模板里现在只剩 `{{belong}}` 与 `{{protocol}}`。
 *
 * @param {{fields: {id: string}[], template: string}} form
 * @param {Record<string, string>} values
 * @param {string} protocol 三段协议全文（`buildStarter().prompt`）
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
 * 拼装「知识点地图 · 生成指令」正文（**纯函数**，可离线判据 —— test/new-course-wizard.mjs 直接调它）。
 *
 * 2026-09-24 F2d：`01-鲸师.md:204` —— "生成**知识点**的时候，这条知识点的**地图**就一起生成；
 * 后续进展都遵循这张地图，**地图是方向标**"；`:394` —— "建点入口（create.js POST /api/whale/point）
 * **随点生成地图** + whale_author 加**大纲闸**（没大纲不许建课，同摸底闸，**禁 force**）"。
 * 建点路由是纯确定性代码，**生成不了地图内容**（那要读官方文档），所以主人 2026-09-24 拍板：
 * 建点**成功**后由宿主把这条"为它生成地图"的指令拼好、随回执（`mapPrompt`）带给客户端，
 * 客户端走 composer 通道（与 send() 同一条）送进会话。
 *
 * 主人的地图口径（逐字钉死，别写歪）：**地图是大纲；暗星只包含框架和大纲内容，没有详细内容。**
 *   ⇒ 地图节点 = 课名 + 可交付物 + 通过判据（+ why + 官方出处），**不写课的正文细节**。
 *
 * 硬规矩：这套话术只有这一份实现 —— 客户端（lib/client.js）只递文本、不许自己拼。
 * 判据：test/new-course-wizard.mjs [16]-[18]（内容要素 / 失败回执不带 mapPrompt / 反空转变异）。
 *
 * @param {{circleId: string, circleName?: string, pointId: string, pointName?: string}} q
 * @returns {string}
 */
export function composeMapPrompt({ circleId, circleName, pointId, pointName } = {}) {
	const cid = String(circleId ?? '').trim()
	const pid = String(pointId ?? '').trim()
	const pidFull = `${cid}/${pid}`.replace(/^\/+|\/+$/g, '')
	const cname = String(circleName ?? '').trim() || cid
	const pname = String(pointName ?? '').trim() || pid
	const lines = [
		'【知识点地图 · 生成指令】',
		`- 知识点：${pidFull}（${cname} / ${pname}）`,
		'',
		`为上面这个知识点生成**知识点地图（大纲）**，用 whale_plan op=record 落盘（point + goal + nodes[]）：`,
		`· point = ${pidFull}（圆圈/知识点；显示名 ${cname} / ${pname}）`,
		'· goal = 这个知识点的**终点本体**：学完能交付什么（一句话 —— 全图走完就该能交出它）',
		'· nodes[] = 地图节点（一个节点 = 一课），每个节点六样，缺一不可：no / title / deliverable / criteria / why / sources',
		'    - no：课次序号（正整数）',
		'    - title：课名（只写名字）',
		'    - deliverable：这一课要交出的可交付物',
		'    - criteria：通过判据（一行一条，判得过 / 判不过）',
		'    - why：这个节点让终点更近了什么 —— **写不出 why 的节点直接砍掉**，别留在图里充数',
		'    - sources：官方出处，必须是 http(s) 的官方文档 / 规范（C0 寻源必须落盘）—— **不许编造**',
		'',
		'**地图是大纲**：节点只写课名 / 可交付物 / 通过判据（+ why + 官方出处），**不写课的正文细节** ——',
		'暗星只包含框架和大纲内容，没有详细内容。全图要覆盖到这个知识点的终点本体（goal）：走完 = 交得出。',
		'',
		'提醒：**没地图就建不了课** —— whale_author 的大纲闸会拦下（**禁 force 绕**）。先落地图，再谈开课。',
	]
	return lines.join('\n')
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
	// 三段（2026-09-24 F1b）—— 与下面 protocolLines 同源，改一处就得改另一处
	const steps = [
		'① 查资料，出处落 RESOURCES.md',
		'② 看挑战（与门禁同源）+ 问终点与掌握程度（whale_intake / whale_goal 落盘）',
		'③ whale_author → whale_build → 闸门 → 重建星图与笔记',
	]
	const prompt = protocolLines(tracks).join('\n')
	const form = {
		title: STARTER_LABEL,
		// 底部如实说明顺序（v3：**点知识点卡片即开课**，没有表单、没有第二个按钮）
		intro: '点知识点卡片即开课：①查资料 → ②看挑战（含问终点与掌握程度 3–5 问）→ ③生成课程。',
		// 字段表已删（2026-09-24 F1b）—— 留成空数组，composeRequest 的循环自然空转
		fields: [],
		emptyText: FORM_EMPTY_TEXT,
		submitLabel: '发送',
		cancelLabel: '取消',
		template: [
			'【开课请求】',
			'{{belong}}',
			'',
			'下面是本课程的流程契约，请严格按它执行（**顺序就是依赖**）：',
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
