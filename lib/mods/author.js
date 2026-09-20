/**
 * lib/mods/author.js — 能力模块：生成课程源文件骨架
 * ------------------------------------------------------------------
 * 工具 `whale_author`：生成一个**合规的源文件**（第 1 行 meta + 五个槽位）并自查。
 * **默认只返回文本**；`commit: true` 才写到 `lessons/src/<NNNN>-<slug>.html`，
 * 而且**已存在就拒绝覆盖**（不拿骨架去盖真课 ✗）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { authorLesson, validateSkeleton } from '../author.js'

export const plugin = {
	id: 'author',
	version: '0.1.0',
	tools: ['whale_author'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_author',
			description:
				'生成一节课的源文件骨架（meta + objective/review/body/reading/challenges 五槽位）并自查。'
				+ '默认只返回文本；commit:true 才写进 lessons/src/，**已存在则拒绝覆盖**。'
				+ 'slug / hintTerm / source 必填（中文标题派生不出可用文件名，且课程包不允许没有出处）。',
			parameters: {
				type: 'object',
				properties: {
					point: { type: 'string', description: '知识点 id（如 spring-boot）' },
					number: { type: 'number', description: '第几课' },
					title: { type: 'string', description: '课标题（中文可以）' },
					slug: { type: 'string', description: '文件名用的 ASCII 小写连字符 slug' },
					hintTerm: { type: 'string', description: '本课"名字"要指到的术语' },
					source: { type: 'object', description: '出处：{ label, url }' },
					minutes: { type: 'number' },
					terms: { type: 'object' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					commit: { type: 'boolean', description: 'true = 写进 lessons/src/' },
				},
				required: ['point', 'number', 'title', 'slug', 'hintTerm', 'source'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_a, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					// ⚠️ 一个 text 项 + 内部换行：宿主把多个项直接拼接、不插换行 ✗
					const lines = [`${v.file} · 自查${v.valid ? '通过 ✓' : '不通过 ✗'}${v.wrote ? ' · 已写入' : '（未写盘）'}`]
					for (const p of v.problems || []) lines.push(`⚠️ ${p}`)
					if (v.text) lines.push(v.text.slice(0, 900))
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				let a
				try {
					a = authorLesson({
						halo: args.halo, point: args.point, number: args.number, title: args.title,
						slug: args.slug, hintTerm: args.hintTerm, source: args.source,
						minutes: args.minutes, terms: args.terms,
					})
				} catch (e) { return { ok: false, error: e?.message ?? String(e) } }
				const v = validateSkeleton(a.text)
				let wrote = false
				if (args.commit) {
					const root = args.root || hctx.paths.packRoot
					if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
					const abs = path.join(path.resolve(root), a.file)
					if (fs.existsSync(abs)) return { ok: false, error: `拒绝覆盖已存在的文件：${a.file}`, file: a.file, valid: v.ok, problems: v.problems }
					fs.mkdirSync(path.dirname(abs), { recursive: true })
					fs.writeFileSync(abs, a.text, 'utf8')
					wrote = true
				}
				return { ok: v.ok, file: a.file, text: a.text, valid: v.ok, problems: v.problems, wrote }
			},
		})
	},
}
