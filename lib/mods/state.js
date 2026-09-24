/**
 * lib/mods/state.js — 能力模块：学生状态探针
 * ------------------------------------------------------------------
 * 工具 `whale_state`：扫学生工作区（默认 `code/`）→ 抽出**事实**（类 / 注解 / 端点 / 配置 / 依赖）
 * → 跟课程声明的**期望**（`EXPECT.json`）对照 → 报出"实现了什么 / 缺什么"。
 *
 * ⚠️ 别跟 `whale_probe` 混：
 *   - `whale_probe` = **路径分类器**（判断一个路径属于课程包哪一类），无状态；
 *   - `whale_state`  = **学生状态探针**（读学生产出 → 教学决策的入参），本工具。
 *
 * ⚠️ 没有 EXPECT.json 时**不猜期望**：只报事实，并在 notes 里明说"未声明期望"（不静默降级 ✗）。
 * ⚠️ `ok` 不表示"学生做对了"：缺东西是**信息**不是失败。要看结论请读 lessons[].missing。
 *
 * 判定逻辑在 `lib/state.js`（纯），IO 在 `lib/state-scan.js`。
 */

import path from 'node:path'
// 课程包事实一律从**数据层唯一入口**读（`pack.js` 已退化为它的再导出）
import { readPack, packSummary } from '../pack-model.js'
import { probeState, writeState } from '../state-scan.js'
import { summarizeState, assertLosslessJson } from '../state.js'

export const plugin = {
	id: 'state',
	version: '0.1.0',
	tools: ['whale_state'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_state',
			description:
				'学生状态探针：扫学生工作区（默认 code/），抽出事实（构建方式 / 类 / 注解 / 端点 / 配置键 / pom 依赖），'
				+ '与课程声明的期望 EXPECT.json 对照，报出"实现了什么、缺什么"，并带出学生信号（待答提问 / 笔记 / 学习记录 / 已点亮课程）。'
				+ '默认只读；write=true 时把结果写成 learning-records/state.json（不含时间戳，同样输入产出逐字节相同的 state）。'
				+ '没有 EXPECT.json 时只报事实、不猜期望。注意它不执行学生代码、不跑 Maven。'
				+ '（与 whale_probe 的区别：那个是路径分类器，这个是学生状态探针。）',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					codeDir: { type: 'string', description: '兜底学生工作区目录（没有实践区声明时才用它；默认 code）' },
					project: { type: 'string', description: '只看某一个项目（**包根相对**路径，如 code/programming/vue，可选）' },
					write: { type: 'boolean', description: 'true = 写成 learning-records/state.json；默认 false = 只报不写' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, value) => {
					if (value?.error) return [{ type: 'text', text: `❌ ${value.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行（现场"糊成一坨"）✗
					const lines = [value.summary]
					for (const l of value.lines || []) lines.push(l)
					for (const n of (value.notes || []).slice(0, 6)) lines.push(`ℹ️ ${n}`)
					for (const w of (value.warnings || []).slice(0, 6)) lines.push(`⚠️ ${w}`)
					if (value.written) lines.push(`✍️ ${value.written}`)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				const pack = readPack(abs)

				const opts = {}
				// 扫哪些目录：**圈级 / 点级声明的实践区**（在 `pack` 上，由 probeState 内部取并集）；
				// `codeDir` 只是"一处都没声明"时的兜底根 —— 显式参数 > 插件配置 > 库里缺省 'code'
				const codeDir = args.codeDir || hctx.paths.codeDir
				if (codeDir) opts.codeDir = codeDir
				if (args.project) opts.only = args.project

				const { state, warnings } = probeState(abs, pack, opts)
				// 自检：state 必须是无损 JSON。宿主对返回值的要求是"无损"，
				// 结果它只会回一句 value is not lossless JSON（不给位置）✗ —— 这里先说清是哪儿。
				assertLosslessJson(state, 'state')
				const lines = summarizeState(state)
				const empty = state.projects.length === 0

				let written = null
				if (args.write === true && !empty) {
					const w = writeState(abs, state)
					written = w.changed ? `已写入 ${w.path}（${JSON.stringify(state).length} 字节）` : `${w.path} 无变化，未重写`
				}

				return {
					ok: true,
					root: abs,
					summary: `${packSummary(pack)} · 扫到 ${state.projects.length} 个学生项目`
						+ (empty ? `（${(state.practiceRoots || []).join('、') || opts.codeDir || 'code'} 下没有找到项目）` : ''),
					lines,
					state,
					notes: state.notes,
					warnings,
					written,
				}
			},
		})
	},
}
