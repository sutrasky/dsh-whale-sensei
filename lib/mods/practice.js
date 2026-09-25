/**
 * lib/mods/practice.js — 能力模块：实践区（`whale_practice`）
 * ------------------------------------------------------------------
 * 工具 `whale_practice`：把探针算出的**挑战完成度**落成页面可读的
 * `assets/practice-data.js`（课程页是静态页，读不到插件内存），并做**漂移检查**。
 *
 * 和 `whale_style` / `whale_glossary` 同一个形状：默认只校验、`write:true` 才落盘、
 * 内容没变不重写；判据是"生成的字节 == 磁盘的字节"。
 *
 * 边界（照计划的 A 方案）：**插件不执行学生代码** —— 这里只回显静态事实的结论；
 * 页面上的实践区只显示"达成 k / 共 n（另有 m 项需人工确认）"，**不给百分比**。
 */

import fs from 'node:fs'
import path from 'node:path'
import { readPack, packSummary } from '../pack.js'
import { probeState } from '../state-scan.js'
import { buildPracticeData, renderPracticeDataModule, describeConflict, summarizePractice } from '../practice.js'

const REL = 'assets/practice-data.js'

export const plugin = {
	id: 'practice',
	version: '0.1.0',
	tools: ['whale_practice'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_practice',
			description:
				'实践区：把学生工作区的**静态事实**（探针扫的类/注解/端点/配置/依赖）对上课里声明的挑战判据，'
				+ `生成课程页可读的 ${REL}，并与磁盘上那份**逐字节对拍**。`
				+ '默认只校验（write=false）；write=true 时原子落盘，内容没变的不重写。'
				+ '判据不给百分比，只给"达成 k / 共 n（另有 m 项需人工确认）"。'
				+ '它不执行学生代码、不跑 Maven（A 方案：页面只回显）。'
				+ '（挑战判据写在 code/<项目>/EXPECT.json 的 challenges 里，按序号对应课程里的第几道挑战。）',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					codeDir: { type: 'string', description: '学生工作区目录（默认 code）' },
					write: { type: 'boolean', description: `true = 把生成结果写进 ${REL}；默认 false = 只校验` },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行 ✗
					const lines = [v.summary]
					for (const l of v.lines || []) lines.push(l)
					for (const w of (v.warnings || []).slice(0, 6)) lines.push(`⚠️ ${w}`)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				const pack = readPack(abs)

				const opts = {}
				// 扫哪个目录：显式参数 > 插件配置 `codeDir` > 库里缺省 'code'
				const codeDir = args.codeDir || hctx.paths.codeDir
				if (codeDir) opts.codeDir = codeDir
				const { state } = probeState(abs, pack, opts)
				// 兜底键有歧义时 buildPracticeData 会往这里塞一条 —— 工具层必须把它**说出来**
				// （不猜是行为，不报就是静默）
				const conflicts = []
				const data = buildPracticeData({ state, pack, conflicts })
				const text = renderPracticeDataModule(data)

				const target = path.join(abs, ...REL.split('/'))
				let disk = null
				try {
					disk = fs.readFileSync(target, 'utf8')
				} catch {
					/* 还没生成过 */
				}
				const consistent = disk === text

				let written = null
				if (args.write === true && !consistent) {
					fs.mkdirSync(path.dirname(target), { recursive: true })
					const tmp = `${target}.tmp-${process.pid}`
					fs.writeFileSync(tmp, text, 'utf8')
					fs.renameSync(tmp, target)
					written = `已写入 ${REL}（${text.length} 字节）`
				} else if (args.write === true) {
					written = `${REL} 无变化，未重写`
				}

				const lines = summarizePractice(data)
				lines.unshift(
					consistent
						? `${REL} 与当前事实一致（逐字节相同）`
						: disk === null
							? `${REL} 还不存在 —— 带 write=true 生成`
							: `${REL} 有漂移（磁盘 ${disk.length} 字节 / 生成 ${text.length} 字节）`
				)
				if (written) lines.push(`✍️ ${written}`)

				return {
					ok: consistent || args.write === true,
					root: abs,
					summary: `${packSummary(pack)} · 实践区 ${Object.keys(data.lessons).length} 课${consistent ? ' · 一致 ✓' : ' · 有漂移'}`,
					lines,
					data,
					written,
					warnings: [...(pack.warnings || []), ...conflicts.map(describeConflict)],
				}
			},
		})
	},
}
