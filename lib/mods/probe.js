/**
 * lib/mods/probe.js — 能力模块：路径分类
 * ------------------------------------------------------------------
 * 工具 `whale_probe`：给一个路径，说清它属于课程包的哪一类 + **凭什么**。
 * 判定逻辑在 `lib/probe.js`（模块之间不许互相 import，共享逻辑放普通文件）。
 */

import path from 'node:path'
import { readPack } from '../pack.js'
import { probePath } from '../probe.js'

export const plugin = {
	id: 'probe',
	version: '0.1.0',
	tools: ['whale_probe'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_probe',
			description:
				'给一个路径，判定它属于课程包的哪一类（课程页 / 课程源 / 参考 / 构建产物 / 工具脚本 / 插件代码 / 未知）'
				+ '并给出**依据**。纯函数：同一输入永远同一输出。只读。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '相对课程包根（或绝对）的路径' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
				},
				required: ['path'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					return [{
						type: 'text',
						text: `${v.kind}（把握 ${v.confidence}）\n依据：${(v.evidence || []).join('\n     · ')}`,
					}]
				},
			},
			async execute(args = {}) {
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				if (!args.path) return { ok: false, error: '缺 path' }
				const abs = path.resolve(root)
				const r = probePath(abs, args.path, readPack(abs))
				return { ok: true, path: args.path, ...r }
			},
		})
	},
}
