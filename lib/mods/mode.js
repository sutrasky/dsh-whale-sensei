/**
 * lib/mods/mode.js — 能力模块：主题状态机 + 令牌成对检查
 * ------------------------------------------------------------------
 * 工具 `whale_mode`：
 *   · 给 `{ stored, systemDark }` → 算出**生效模式**（纯函数，规则照 assets/theme.test.js）
 *   · 给 `root` → 顺手查一遍 theme.css 里**颜色类令牌**是否深浅成对
 */

import path from 'node:path'
import { resolveMode, checkThemeBlocks } from '../mode.js'

export const plugin = {
	id: 'mode',
	version: '0.1.0',
	tools: ['whale_mode'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_mode',
			description:
				'主题状态机：给偏好与系统值算出生效模式（偏好优先，没偏好才跟随系统；垃圾值按没偏好处理）；'
				+ '给定 root 时顺带查 theme.css 里**颜色类**令牌是否深浅成对（字体/形状这类与主题无关，不要求成对）。',
			parameters: {
				type: 'object',
				properties: {
					stored: { type: 'string', description: "'light' | 'dark' | 省略（跟随系统）" },
					systemDark: { type: 'boolean', description: '系统当前是否深色' },
					root: { type: 'string', description: '给课程包根时会顺带做令牌成对检查' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_a, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行 ✗
					const lines = [`生效模式 ${v.effective} · colorScheme=${v.colorScheme} · data-ds-dark-theme=${v.darkThemeAttr} · 存储键 ${v.storageKey}`]
					if (v.findings) {
						lines.push(v.findings.length ? `${v.findings.length} 条令牌告警：` : '令牌深浅成对 ✓')
						for (const f of v.findings.slice(0, 8)) lines.push(`[${f.severity}] ${f.message}`)
					}
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				let mode
				try { mode = resolveMode({ stored: args.stored, systemDark: args.systemDark }) } catch (e) {
					return { ok: false, error: `状态机算不动：${e?.message ?? e}` }
				}
				const root = args.root || hctx.paths.packRoot
				const result = { ok: true, ...mode }
				if (root) {
					try {
						const r = checkThemeBlocks(path.resolve(root))
						result.findings = r.findings
						result.ok = r.findings.every((f) => f.severity !== 'error')
					} catch (e) { result.findings = []; result.warning = `令牌检查跳过：${e?.message ?? e}` }
				}
				return result
			},
		})
	},
}
