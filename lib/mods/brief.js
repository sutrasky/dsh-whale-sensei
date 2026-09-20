/**
 * lib/mods/brief.js — 能力模块：备课 / 答疑的上下文包
 * ------------------------------------------------------------------
 * 工具 `whale_brief`：一条命令，把散在各处的输入合成**一页**：
 *   课程包现状 · 学生现状（含缺口）· 待答 · 已答 · 术语 · 学习记录 · **推出来的下一步建议**
 *
 * 这是计划里那个"最大缺口"（读学生产出 → 反推教学 → 步步有回应）的**落地件**：
 * 以前 agent 每轮要自己调四五个工具再脑补；现在一页读完就能决定下一步。
 *
 * ⚠️ 两条边界：
 *   · **建议是推出来的**，每句都带依据；数据不足就写"不知道"，**不猜**（见 lib/brief.js 的 decideNext）
 *   · **不读会话内容**：ctx.sessions 那套 API 我还没亲自核过，不拿它下注 ✗
 *     （要做"答疑前先读对话"得先像 connection/jobs 那样先验一遍）
 *
 * 组装逻辑在 `lib/brief.js`（纯），输入收集在 `lib/brief-io.js`。
 */

import path from 'node:path'
// 课程包事实一律从**数据层唯一入口**读（`pack.js` 已退化为它的再导出）
import { readPack, packSummary } from '../pack-model.js'
import { readBriefInputs, writeBrief, readSessionTail } from '../brief-io.js'
import { buildBrief, renderBrief } from '../brief.js'

export const plugin = {
	id: 'brief',
	version: '0.1.0',
	tools: ['whale_brief'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_brief',
			description:
				'备课 / 答疑的上下文包：把「课程包现状 + 学生现状（含与 EXPECT.json 的缺口）+ 待答队列 + 已答台账 + 术语台账 + 学习记录」'
				+ '合成一页，并给出**从数据推出来的**下一步建议（每条建议都带依据；数据不足就说不知道）。'
				+ '默认只读并把这一页返回；write=true 时另存到 learning-records/brief.md（不含时间戳，同样输入产出逐字节相同）。'
				+ 'includeSession=true 时**额外**附上"本会话最近 N 条消息"（只取 role 与截断后的纯文本）—— 那是"答疑前先读对话"用的，'
				+ '默认**不读**（读了就不保证跨轮逐字节相同，所以做成显式开关）。'
				+ '它不执行学生代码、不跑 Maven。'
				+ '（与 whale_state 的区别：那个只报学生工作区的事实与缺口，这个是"备课用的整页上下文 + 建议"。）',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					codeDir: { type: 'string', description: '学生工作区目录（默认 code）' },
					write: { type: 'boolean', description: 'true = 另存成 learning-records/brief.md；默认 false = 只返回' },
					includeSession: { type: 'boolean', description: 'true = 附上本会话最近几条消息（默认 false，不读会话）' },
					sessionMessages: { type: 'number', description: 'includeSession 时取最近几条（1..20，默认 6）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行 ✗
					const lines = [v.markdown || v.summary]
					if (v.written) lines.push(`✍️ ${v.written}`)
					for (const w of (v.warnings || []).slice(0, 6)) lines.push(`⚠️ ${w}`)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			// 第二个参数是宿主的 exec（`execute(args, exec)`）；`exec.agent.session` 就是本会话。
			async execute(args = {}, exec) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				const pack = readPack(abs)

				const opts = {}
				if (args.codeDir) opts.codeDir = args.codeDir
				const inputs = readBriefInputs(abs, pack, opts)
				// 会话是**显式开关**：默认不读（默认 brief 因此可以逐字节对拍）
				if (args.includeSession === true) {
					inputs.session = readSessionTail(exec?.agent?.session, args.sessionMessages, 160)
				}
				const brief = buildBrief(inputs)
				const markdown = renderBrief(brief)

				let written = null
				if (args.write === true) {
					const w = writeBrief(abs, markdown)
					written = w.changed ? `已写入 ${w.path}（${w.chars} 字符）` : `${w.path} 无变化，未重写`
				}

				return {
					ok: true,
					root: abs,
					summary: `${packSummary(pack)} · 待答 ${brief.counts.pending} · 下一步：${brief.next.action}`,
					markdown,
					brief,
					written,
					warnings: pack.warnings,
				}
			},
		})
	},
}
