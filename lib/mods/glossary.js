/**
 * lib/mods/glossary.js — 能力模块：名词台账 → GLOSSARY.md
 * ------------------------------------------------------------------
 * 工具 `whale_glossary`：把术语台账 `assets/glossary-data.js` 合成成 `GLOSSARY.md`，
 * 并与磁盘上那份**逐字节对拍**；`write: true` 时按合成结果原子落盘。
 *
 * 为什么需要它：课程包自己的 `assets/build-glossary.js` **没有 `--check`** ——
 * GLOSSARY.md 一旦忘了重建，没有任何东西会发现它跟台账不一致 ✗（连 gate 也抓不到）。
 * 补上这道检查的方式是"把生成逻辑收进插件"，跟 theme.css（whale_style）那套一致。
 *
 * ⚠️ 边界（别越界重复造）：`assets/check-terms.js` 已经做了 14 项检查 ——
 *    包括"页面用了但台账没登记"与"台账有但没人用"的**双向对账**。
 *    本模块**不重复**那些语义，只负责"台账 → GLOSSARY.md"这一条链。
 *
 * 合成逻辑在 `lib/glossary.js`（纯），IO 在 `lib/glossary-io.js`。
 */

import path from 'node:path'
import { glossaryDrift, writeGlossary, loadGlossaryLedger, glossarySummary } from '../glossary-io.js'
import { writeTermSurgically } from '../glossary-edit-io.js'

export const plugin = {
	id: 'glossary',
	version: '0.1.0',
	tools: ['whale_glossary'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_glossary',
			description:
				'名词台账（assets/glossary-data.js）→ GLOSSARY.md 的合成与漂移检查。'
				+ '默认只检查：报出磁盘上的 GLOSSARY.md 与台账合成结果是否**逐字节一致**（课程包自带的 build-glossary.js 没有 --check，这道检查原本没有）。'
				+ 'write=true 时按合成结果原子写盘，内容没变的不重写。'
				+ 'action=add/edit 时增改一条术语：写后必须能被 require 回来且逐字段一致，自检不过就逐字节回滚；'
				+ '这两个 action 会改台账，所以必须同时传 write=true（默认只读，避免误写）；改完立刻重建 GLOSSARY.md 并重算漂移。'
				+ '覆盖面：只管 GLOSSARY.md 这一份产物；页面 ↔ 台账的双向对账请用课程包自带的 assets/check-terms.js（本工具不重复它的检查）。',
			parameters: {
				type: 'object',
				properties: {
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					write: { type: 'boolean', description: 'true = 把合成结果写进 GLOSSARY.md；默认 false = 只检查。add/edit 必须为 true' },
					action: { type: 'string', enum: ['check', 'add', 'edit'], description: 'check（默认）= 只看漂移；add = 追加一条术语；edit = 替换一条已存在的术语' },
					key: { type: 'string', description: 'add/edit 的术语键（合法标识符，例：responseentity）' },
					record: { type: 'object', description: 'add/edit 的记录：{ label, category, official, short, analogy, code?, lesson }' },
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

				const action = args.action || 'check'

				// ── add / edit：改台账属于写操作，必须显式 write=true ──────────
				if (action === 'add' || action === 'edit') {
					if (args.write !== true) {
						return { ok: false, error: `${action} 会改台账，必须同时传 write=true（默认只读，避免误写）` }
					}
					if (!args.key || typeof args.key !== 'string') return { ok: false, error: `${action} 需要 key` }
					if (!args.record || typeof args.record !== 'object') return { ok: false, error: `${action} 需要 record` }

					let w
					try {
						w = writeTermSurgically({
							root: abs, key: args.key, record: args.record, replace: action === 'edit',
						})
					} catch (e) {
						// 同键重复 / replace 不存在的键都在写盘之前抛 → 文件未动
						return { ok: false, error: `${action} 失败（台账未改动）：${e?.message ?? e}` }
					}
					if (!w.ok) return { ok: false, error: w.error, rolledBack: true === w.rolledBack }

					// 改了台账不重建 GLOSSARY.md 就立刻是漂移状态 → 顺手同步，并重算（不许拿写之前的结论充数）
					const rw = writeGlossary(abs)
					const driftAfter = glossaryDrift(abs)
					const infoAfter = glossarySummary(loadGlossaryLedger(abs))
					const verb = action === 'add' ? '已追加' : '已替换'
					return {
						ok: driftAfter.consistent === true,
						root: abs,
						action,
						key: args.key,
						replaced: w.replaced === true,
						count: infoAfter.count,
						summary: `${verb} ${args.key} · 台账 ${infoAfter.count} 个名词 · GLOSSARY.md ${driftAfter.consistent ? '已同步 ✓' : '仍有漂移'}`,
						lines: [
							'写后自检通过：能 require 回来且目标记录逐字段一致',
							rw.changed ? `✍️ 已重建 ${rw.path}（${rw.chars} 字符）` : `${rw.path} 无变化，未重写`,
							driftAfter.consistent
								? `GLOSSARY.md 与台账逐字节一致 ✓（${driftAfter.expectedChars} 字符）`
								: `仍有漂移：${driftAfter.detail}`,
						],
					}
				}

				let ledger
				try {
					ledger = loadGlossaryLedger(abs)
				} catch (e) {
					return { ok: false, error: `读术语台账失败：${e?.message ?? e}` }
				}
				const info = glossarySummary(ledger)
				let drift = glossaryDrift(abs)

				let written = null
				if (args.write === true && !drift.consistent) {
					const w = writeGlossary(abs)
					written = w.changed ? `已写入 ${w.path}（${w.chars} 字符）` : `${w.path} 无变化，未重写`
					drift = glossaryDrift(abs) // 写完重算，不许拿写之前的结论充数
				}

				const lines = [
					`台账 ${info.count} 个名词 · ${info.categories} 个分类`,
					drift.consistent
						? `GLOSSARY.md 与台账一致 ✓（${drift.expectedChars} 字符，逐字节相同）`
						: `GLOSSARY.md 与台账**不一致**：${drift.detail}`,
				]
				if (written) lines.push(`✍️ ${written}`)
				if (!drift.consistent && args.write !== true) {
					lines.push('下一步：`whale_glossary` 带 write=true 重建，或跑 `node assets/build-glossary.js`')
				}

				return {
					ok: drift.consistent,
					root: abs,
					summary: `${info.count} 个名词 · ${info.categories} 类 · ${drift.consistent ? 'GLOSSARY.md 一致 ✓' : 'GLOSSARY.md 有漂移'}`,
					lines,
					drift: { consistent: drift.consistent, missing: drift.missing, detail: drift.detail },
					written,
					warnings: info.missing.map((m) => `台账条目缺字段：${m}`),
				}
			},
		})
	},
}
