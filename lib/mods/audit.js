/**
 * lib/mods/audit.js — 能力模块：审计
 * ------------------------------------------------------------------
 * 工具 `whale_audit`：在进程内把课程包+"产物"对一遍，报出发现项。
 * 判定逻辑在 `lib/audit.js`（模块之间不许互相 import）。
 *
 * ⚠️ 覆盖范围必须写在 description 里：**本阶段只五条**（死链 / id 重复 / 幽灵进度 /
 *    缺产物 / 静默降级）。CSS 令牌完备性、对比度那类不在本阶段 —— 不许让调用方以为全查了。
 */

import path from 'node:path'
import { readPack, packSummary } from '../pack.js'
import { auditPack } from '../audit.js'

export const plugin = {
	id: 'audit',
	version: '0.1.0',
	tools: ['whale_audit'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_audit',
			description:
				'审计课程包与产物，报出发现项（file/severity/message/hint）。'
				+ '**本阶段只覆盖五条**：死链 / id 重复 / 幽灵进度 / 缺产物 / 静默降级；'
				+ 'CSS 令牌完备性与对比度**不在本阶段**。只读。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					scope: { type: 'string', description: '本阶段恒为五条全跑（保留字段）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					if (!v.findings?.length) return [{ type: 'text', text: `${v.summary} · 没有发现项 ✓` }]
					// ⚠️ 必须是**一个** text 项：宿主把多个项直接拼接、不插换行（现场看到"糊成一坨"）✗
					const lines = v.findings.slice(0, 12).map((f) => `[${f.severity}] ${f.id}${f.file ? ' @ ' + f.file : ''}\n     ${f.message}${f.hint ? '\n     → ' + f.hint : ''}`)
					return [{ type: 'text', text: [`${v.summary} · ${v.findings.length} 个发现项`, ...lines].join('\n') }]
				},
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				const pack = readPack(abs)
				const r = auditPack(abs, pack)
				const errors = r.findings.filter((f) => f.severity === 'error').length
				return {
					ok: errors === 0,
					root: abs,
					summary: `${packSummary(pack)} · ${r.findings.length} 个发现项（其中 error ${errors}）`,
					findings: r.findings,
					warnings: pack.warnings,
				}
			},
		})
	},
}
