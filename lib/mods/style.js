/**
 * lib/mods/style.js — 能力模块：主题合成
 * ------------------------------------------------------------------
 * 工具 `whale_style`：把 `templates/contract.css` + `presets/<slug>.css` 合成 `assets/theme.css`。
 * **默认只对比、不写盘**；`commit: true` 才写（写是有副作用的动作，必须显式 ✗ 不许偷偷做）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { composeTheme, themeDrift } from '../style.js'

export const plugin = {
	id: 'style',
	version: '0.1.0',
	tools: ['whale_style'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_style',
			description:
				'合成主题：模板契约 + 预设 → assets/theme.css。默认**只对比不写盘**，commit:true 才写。'
				+ '退路链与 tools/style-adapter.js 一致；连内置基础都读不到时**报错**（拒绝静默降级）。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					commit: { type: 'boolean', description: 'true = 把合成结果写进 assets/theme.css' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				// ⚠️ 宿主把多个 text 项**直接拼接、不插换行** —— 警告必须并进同一项，
				//    否则"有警告"这一常态（别人机器上读不到风格库）在现场看就是糊成一坨。
				//    警告串自己已带 ⚠️ 前缀，这里不再叠一个。
				render: (_a, v) => v?.error
					? [{ type: 'text', text: `❌ ${v.error}` }]
					: [{ type: 'text', text: [v.summary, ...(v.warnings || []).slice(0, 5)].join('\n') }],
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				const abs = path.resolve(root)
				let r
				// 风格库目录走**配置**，不是代码里的目录猜测：没配就只在包内 `styles/` 找
				const sopts = hctx.paths.stylesDir ? { stylesDir: hctx.paths.stylesDir } : {}
				try { r = composeTheme(abs, sopts) } catch (e) { return { ok: false, error: `合成失败：${e?.message ?? e}` } }
				const d = themeDrift(abs, sopts)
				let wrote = false
				if (args.commit && !d.same) {
					fs.writeFileSync(path.join(abs, 'assets', 'theme.css'), r.css, 'utf8')
					wrote = true
				}
				return {
					ok: d.same || wrote,
					root: abs,
					slug: r.slug,
					used: r.used,
					fallback: r.fallback,
					drift: !d.same,
					wrote,
					warnings: r.warnings,
					summary: `预设 ${r.used}${r.fallback ? '（退路）' : ''} · 合成 ${r.css.length} 字符 · 与 assets/theme.css ${d.same ? '逐字节一致 ✓' : '有漂移'}${wrote ? ' · 已写入' : '（未写盘）'}`,
				}
			},
		})
	},
}
