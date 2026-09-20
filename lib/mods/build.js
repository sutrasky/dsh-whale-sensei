/**
 * lib/mods/build.js — 能力模块：校验 + 渲染落盘（M2）
 * ------------------------------------------------------------------
 * 工具 `whale_build` 做两件事：
 *   ① 把"课程包"与"已落盘的产物"对一遍，报出**每一处**不一致；
 *   ② 给 `write: true` 时，用插件自己的渲染器把课程页落盘（原子写，内容没变的不重写）。
 *
 * 渲染逻辑：纯函数层 `lib/render.js`（搬运 study/tools/build-lessons.js）+ IO 薄壳
 * `lib/render-inputs.js`。对拍判据在 `test/render-parity.mjs`：
 * **同样的输入 → 逐字节相同的页面**（含"换一份新输入再对拍"的反空转判据）。
 *
 * 覆盖面（description 里必须写明，不许让调用方以为它管全部产物）：
 *   ✅ 课程页 lessons/**.html
 *   ❌ assets/theme.css（→ whale_style）· 星图 content.js / static.svg（→ 星图构建）
 *   ❌ reference/NOTES.html（→ build-notes）· assets/lesson-blocks.css（只有反向抽取才产出）
 *
 * 模块之间不许互相 import —— 共享逻辑放普通文件里。
 */

import path from 'node:path'
import { readPack, packSummary } from '../pack.js'
import { verifyPack } from '../verify.js'
import { planBuild, diffPlan, writePlan } from '../render-inputs.js'

export const plugin = {
	id: 'build',
	version: '0.2.0',
	tools: ['whale_build'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_build',
			description:
				'校验课程包与产物是否一致，并可用插件自己的渲染器把**课程页**重新渲染落盘。'
				+ '默认只校验（write=false，只读）；write=true 时按渲染结果原子写盘，内容没变的文件不重写。'
				+ '覆盖面：只含 lessons/**.html 课程页；theme.css 用 whale_style、星图用星图构建、'
				+ 'NOTES.html 用 build-notes、lesson-blocks.css 只有反向抽取才产出 —— 这四样本工具不碰。'
				+ '对拍判据：同样的输入产出逐字节相同的页面（test/render-parity.mjs）。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					write: {
						type: 'boolean',
						description: 'true = 把渲染结果落盘（只写课程页）；默认 false = 只校验不写盘',
					},
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, value) => {
					if (value?.error) return [{ type: 'text', text: `❌ ${value.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行 ✗
					const lines = [value.summary]
					if (value.render) lines.push(value.render)
					for (const w of (value.written || []).slice(0, 12)) lines.push(`✍️ 已写入 ${w}`)
					for (const d of (value.drift || []).slice(0, 12)) lines.push(`⚠️ ${d}`)
					const shown = (value.written || []).length + (value.drift || []).length
					if (shown > 24) lines.push(`…还有 ${shown - 24} 条`)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				const pack = readPack(abs)

				// ① 结构性校验（星图深链 / 静态版 / 笔记页 …）
				let verify = verifyPack(abs, pack)

				// ② 渲染对拍：插件渲染结果 vs 磁盘现状
				const plan = planBuild(abs, pack)
				let diff = diffPlan(abs, plan)

				// ③ 要写就写，然后**重新比一遍**（不许拿写之前的结论充数）
				let written = []
				if (args.write === true && plan.files.length) {
					const w = writePlan(abs, plan)
					written = w.written
					diff = diffPlan(abs, plan)
					// ⚠️ 结构性校验也必须重算：它是**写之前**跑的，不重算就会出现
					//    「本次写入 2 · 待修 0」后面紧跟「缺产物 …」这种自相矛盾的报告，
					//    而且 ok 会变成假阴 ✗（现场在影子包上抓到过这条）
					verify = verifyPack(abs, pack)
				}

				const drift = [
					...diff.missing.map((m) => `缺产物 ${m}`),
					...diff.different.map((d) => `课程页 ${d.path} 与渲染结果不一致：${d.detail}`),
					...verify.drift,
				]

				const renderLine = plan.files.length
					? `渲染 ${plan.files.length} 个课程页 · 与磁盘一致 ${diff.same.length} · 待修 ${diff.missing.length + diff.different.length}`
						+ (written.length ? ` · 本次写入 ${written.length}` : '')
					: '这个包里没有可渲染的课程页（检查 lessons/src/ 与 assets/questions-data.js）'

				return {
					ok: drift.length === 0,
					root: abs,
					summary: `${packSummary(pack)} · ${drift.length === 0 ? '产物与课程包一致 ✓' : `有 ${drift.length} 处不一致`}`,
					render: renderLine,
					written,
					drift,
					checks: verify.checks,
					warnings: pack.warnings,
				}
			},
		})
	},
}
