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
import { intakeStatus, buildQuestions } from '../intake.js'
import { readPack, prerequisiteGaps, describeGaps } from '../pack-model.js'

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
				+ 'commit:true 有两道闸：① **前置闸** —— 该知识点的 requires 里还有没学完的课就拒绝生成'
				+ '（先建议去学那门课，而不是继续生成新课）；② **学情摸底闸** —— 没 intake 记录也拒绝。'
				+ 'slug / hintTerm / source 必填（中文标题派生不出可用文件名，且课程包不允许没有出处）。',
			parameters: {
				type: 'object',
				properties: {
					point: { type: 'string', description: '知识点 id（如 spring-boot）' },
					halo: { type: 'string', description: '圆圈 id（如 programming）；不传就从课程包里查该知识点所属圆圈' },
					number: { type: 'number', description: '第几课' },
					title: { type: 'string', description: '课标题（中文可以）' },
					slug: { type: 'string', description: '文件名用的 ASCII 小写连字符 slug' },
					hintTerm: { type: 'string', description: '本课"名字"要指到的术语' },
					source: { type: 'object', description: '出处：{ label, url }' },
					minutes: { type: 'number' },
					terms: { type: 'object' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					commit: { type: 'boolean', description: 'true = 写进 lessons/src/' },
				force: { type: 'boolean', description: 'true = 明知前置没学完 / 没做学情摸底也落盘（返回里 forced.bypassed 会列出被跳过的闸）' },
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
				// 圆圈（halo）：显式参数 > 课程包里该知识点所属的圆圈 > 不写（退回平铺，老包兼容）。
				// 为什么不只靠显式参数：调用方（agent）通常只知道知识点 id，不知道它在哪个圆圈里；
				// 而写错目录的代价是课次映射表推不出 circle/point（页面/星图/术语对账一起错位）。
				const rootArg = args.root || hctx.paths.packRoot
				let halo = args.halo
				if (!halo && rootArg && args.point) {
					try {
						const hit = readPack(path.resolve(rootArg)).points.find((p) => p.id === args.point)
						halo = hit?.circle
					} catch { /* 读不动课程包就不猜：退回平铺，别把课丢进一个不存在的圆圈 */ }
				}
				try {
					a = authorLesson({
						halo, point: args.point, number: args.number, title: args.title,
						slug: args.slug, hintTerm: args.hintTerm, source: args.source,
						minutes: args.minutes, terms: args.terms,
					})
				} catch (e) { return { ok: false, error: e?.message ?? String(e) } }
				const v = validateSkeleton(a.text)

				// ── 学情摸底闸门（commit 且非 force 时生效）──
				const root = args.root || hctx.paths.packRoot
				// ── 前置闸（2026-09-23 用户裁定）──────────────────────────────
				// 「开课摸底时就要知道学生是不是学会了相关的前置内容，如果没有，就要建议他
				//   去开没学的课**而不是继续给他生成课程**。」
				// 排在摸底闸之前：前置没补齐时，连摸底都不该做 —— 先补课。
				// 判据真源 = point.json 的 requires（readPack 早已解析），不是这里另写一套。
				if (args.commit && !args.force && root && args.point) {
					let gaps = null
					try {
						gaps = prerequisiteGaps(readPack(path.resolve(root)), args.point)
					} catch { /* 课程包读不动就不猜：交给下面的摸底闸与写盘分支 */ }
					if (gaps && gaps.ok === false) {
						return {
							ok: false,
							needsPrerequisite: true,
							point: args.point,
							missing: gaps.missing.map((l) => l.id),
							closure: gaps.closure,
							error: `前置未掌握，拒绝生成新课：${describeGaps(gaps)}`,
							hint: '先去学上面列出的课（whale_brief 的「前置体检」一节能看到全部前置状态）；确实要跳过就传 force:true',
						}
					}
				}
				if (args.commit && !args.force && root) {
					const status = intakeStatus(root, args.point)
					if (!status.done) {
						const qResult = buildQuestions({ point: args.point, topic: a.title })
						return {
							ok: false,
							needsIntake: true,
							error: `先做学情摸底：${args.point} 还没有 intake 记录`,
							questions: qResult.questions.map((q) => q.q),
							hint: '把问题问完并用 whale_intake op=record 落盘；确实要跳过就传 force:true',
						}
					}
				}

				let wrote = false
				if (args.commit) {
					if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
					const abs = path.join(path.resolve(root), a.file)
					if (fs.existsSync(abs)) return { ok: false, error: `拒绝覆盖已存在的文件：${a.file}`, file: a.file, valid: v.ok, problems: v.problems }
					fs.mkdirSync(path.dirname(abs), { recursive: true })
					fs.writeFileSync(abs, a.text, 'utf8')
					wrote = true
				}

				// 非 commit 模式也带出摸底状态（告知，不失败）
				let intake = undefined
				if (!args.commit && root) {
					const s = intakeStatus(root, args.point)
					intake = { done: s.done, missing: s.missing }
				}

				// ── force 留痕（2026-09-23）──────────────────────────────────
				// 工具描述一直承诺 force "会留痕"，但 commit+force 这条路既不返回摸底状态、
				// 也不记任何标记 —— 是张空头支票。现在把**被跳过的那几道闸**如实报出来：
				// 留痕要能回答"这次绕过了什么"，而不是只写一句"绕过了"。
				let forced = undefined
				if (args.commit && args.force && root) {
					const bypassed = []
					try {
						const gaps = args.point ? prerequisiteGaps(readPack(path.resolve(root)), args.point) : null
						if (gaps && gaps.ok === false) bypassed.push(`前置：${describeGaps(gaps)}`)
					} catch { /* 课程包读不动就不记这一条，不猜 */ }
					try {
						const st = args.point ? intakeStatus(root, args.point) : null
						if (st && !st.done) bypassed.push(`学情摸底：${args.point} 还没有 intake 记录`)
					} catch { /* 同上 */ }
					forced = { bypassed }
				}

				return { ok: v.ok, file: a.file, text: a.text, valid: v.ok, problems: v.problems, wrote, ...(intake ? { intake } : {}), ...(forced ? { forced } : {}) }
			},
		})
	},
}
