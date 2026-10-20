/**
 * lib/mods/plan.js — 能力模块：知识点地图（`whale_plan`）
 * ------------------------------------------------------------------
 * **为什么有这个工具（2026-09-24 F2）**：`01:385` 要求"建点入口随点生成地图 + 没大纲不许建课"，
 * 但**建点那一步是纯确定性代码**（`POST /api/whale/point`）—— 它生成不了地图内容
 * （地图要主题、可交付物、通过判据、出处，那要读官方文档）。
 * 所以地图的**内容**由 agent 产出，这个工具就是它的落盘口 —— 与 `whale_goal` 同一个套路。
 *
 * 判据只有一份：`lib/plan.js` 的 `validatePlan()`（纯函数）。闸门（`whale_author` 的大纲闸）
 * 与这个工具调的是同一个函数 —— 不允许出现"工具收了、闸门却不认"的两套口径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { validatePlan, summarizePlan, planFrontier, summarizeFrontier, PLAN_KEYS, NODE_KEYS } from '../plan.js'
import { readPack } from '../pack-model.js'

/**
 * 身份内核（**唯一**严格实现；U02 交付）。
 *
 * 本模块此前用 `want.split('/').filter(Boolean)` 自己拆引用、并且对裸点取**第一个**同名点
 * —— 那是**降维**：两个圆圈里都有 `x` 时，地图会被写进"先遍历到的那个圈"。
 * 现在：拆分走 `identity.parsePointKey`（只认规范两段），定位只认**唯一命中的完整身份**。
 */
const requireCJS = createRequire(import.meta.url)
const identity = requireCJS('../unify/identity.cjs')

/**
 * 把 `point`（裸 id 或规范 `circle/point`）定位到**唯一**一个知识点。
 *
 * 判据（与 `lib/point-ref.js` 同一条口径：只有唯一匹配才认，绝不按"第一个"猜）：
 *   · 给了 `circle/point` → 只在这个圆圈里找；对不上就是"找不到"（不换一个圆）；
 *   · 只给裸 id → 全包唯一才认；两个圆圈都有它 → `ambiguous`（列候选，拒绝写盘）；
 *   · 身份形状不合法（三段 / 空段 / 显示名 / 逃逸）→ 不拆（不走旧解析），按找不到处理。
 *
 * @returns {{ok:true, circle:string, point:string, file:string, pointPath:string}
 *          |{ok:false, code:'missing'|'unknown'|'ambiguous', candidates?:string[], error?:string}}
 */
function locate(root, pack, point) {
	const want = String(point ?? '').trim()
	if (!want) return { ok: false, code: 'missing' }
	// 只认规范两段身份（裸 id 不是身份 —— 它按裸 id 在全包里找，且必须唯一）
	const parsed = identity.parsePointKey(want)
	const circle = parsed.ok ? parsed.value.circle : null
	const bare = parsed.ok ? parsed.value.point : want
	const hits = []
	for (const c of pack.circles || []) {
		if (circle !== null && c.id !== circle) continue
		for (const p of c.points || []) {
			if (p.id === bare) hits.push({ circle: c.id, point: p.id })
		}
	}
	if (hits.length > 1) {
		const candidates = hits.map((h) => identity.pointKey(h.circle, h.point))
		return {
			ok: false,
			code: 'ambiguous',
			candidates,
			error: `知识点 id「${want}」在 ${candidates.length} 个圆圈里都有（${candidates.join(' / ')}）`
				+ ' —— 必须给圆圈（写完整「圆圈/知识点」）才能唯一识别，绝不猜',
		}
	}
	if (!hits.length) return { ok: false, code: 'unknown' }
	const hit = hits[0]
	const pointPath = identity.pointKey(hit.circle, hit.point)
	return {
		ok: true,
		circle: hit.circle,
		point: hit.point,
		// 盘上的落点 = `lessons/<圆圈>/<知识点>/point.json`（与身份同一分层）
		file: path.join(path.resolve(root), 'lessons', ...pointPath.split('/'), 'point.json'),
		pointPath,
	}
}

export const plugin = {
	id: 'plan',
	version: '0.1.0',
	tools: ['whale_plan'],

	install(hctx) {
		hctx.registerTool({
			name: 'whale_plan',
			description:
				'知识点地图（大纲）：read=看这个点的地图（摘要 + 节点表）；record=把地图写进 point.json 的 plan 字段。'
				+ '地图 = 这个知识点要教哪几课：每个节点 `no`（课次）/ `title` / `deliverable`（可交付物）/ '
				+ '`criteria`（通过判据）/ `why`（它让终点更近了什么）/ `sources`（官方出处）六样齐。'
				+ '**缺 `why` 的节点应当直接砍掉**，别留在图里充数（01:83）。'
				+ '⚠️ 落盘前会逐条校验（与 `whale_author` 的大纲闸同一份判据）—— 校验不过就拒写，不会写半张图进去。'
				+ '地图是**方向标**：没它 `whale_author` 会拒建课（禁 force 绕）。',
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', enum: ['read', 'record'], default: 'read', description: '操作类型' },
					point: { type: 'string', description: '知识点 id（`programming/spring-boot` 或裸 `spring-boot`）' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					goal: { type: 'string', description: 'record 必填：这个知识点的终点（学完能交付什么，一句话）' },
					nodes: {
						type: 'array',
						description: `record 必填：节点数组，每项含 ${NODE_KEYS.join(' / ')}`,
						items: { type: 'object' },
					},
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					const lines = []
					if (v.op === 'record') {
						lines.push(`✅ 地图已落盘：${v.pointPath}（${v.summary}）→ ${v.file}`)
						lines.push(`   终点：${v.goal}`)
					} else {
						lines.push(`🗺️ ${v.pointPath}：${v.summary}`)
						if (v.goal) lines.push(`   终点：${v.goal}`)
						// 「下一课教什么」——③生成课程就照这一行办，别按文件名序 +1（01:394）
						if (v.nextLine) lines.push(`   ▶ ${v.nextLine}`)
					}
					for (const n of v.nodes || []) {
						lines.push(`   ${n.no}. ${n.branch ? '[支线] ' : ''}${n.title}`)
						lines.push(`      交付：${n.deliverable}`)
						lines.push(`      判据：${n.criteria}`)
						lines.push(`      为什么：${n.why}`)
						if (n.sources && n.sources.length) lines.push(`      出处：${n.sources.map((s) => s.label).join('、')}`)
					}
					if (v.problems && v.problems.length) lines.push(`⚠️ ${v.problems.join('；')}`)
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const op = args.op || 'read'
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }

				let pack = null
				try { pack = readPack(path.resolve(root)) } catch (e) {
					return { ok: false, error: `课程包读不动：${e?.message ?? e}` }
				}
				const at = locate(root, pack, args.point)
				if (!at.ok) {
					// 跨圈同名点：**拒绝**并列出候选（不挑第一个 —— 那会把地图写到另一个圆圈的 point.json）
					if (at.code === 'ambiguous') return { ok: false, ambiguous: true, candidates: at.candidates, error: at.error }
					return { ok: false, error: `找不到这个知识点：${JSON.stringify(args.point)}（要 「circle/point」 或裸 「point」）` }
				}

				// 现行地图（read 也用它；record 前要先读出来才能只改 plan 一个字段）
				let doc = null
				try { doc = JSON.parse(fs.readFileSync(at.file, 'utf8')) } catch (e) {
					return { ok: false, error: `point.json 读不动：${e?.message ?? e}` }
				}

				if (op === 'read') {
					const v = validatePlan(doc.plan, `知识点 ${at.pointPath} 的 point.json.plan`)
					// **下一课教什么** = 地图前沿（`01:205`：显示下一个星星 —— 或两颗，如果这里正好有支线分叉）。
					// 已建课的课次号取**显示号**（`no` 那一套），与地图节点同一套编号。
					const mine = (pack.lessons || []).filter((l) => l.circle === at.circle && l.point === at.point)
					const f = planFrontier(doc.plan, mine.map((l) => Number(l.displayNumber)))
					return {
						ok: true, op: 'read', point: at.pointPath, file: at.file,
						summary: summarizePlan(doc.plan),
						goal: v.ok ? String(doc.plan.goal) : '',
						nodes: v.nodes,
						problems: v.problems,
						// ③生成课程就靠这两行定"这一课教什么"，**不是**文件名序 +1
						nextLesson: f.ok && !f.exhausted ? f.next : null,
						nextLine: summarizeFrontier(f),
						stars: f.stars,
						progress: { created: f.created, missing: f.missing, exhausted: f.exhausted },
					}
				}

				// ── record：先校验，**不过就拒写**（不写半张图进去）──
				const plan = { goal: args.goal, nodes: args.nodes }
				const v = validatePlan(plan, `whale_plan record（${at.pointPath}）`)
				if (!v.ok) {
					return {
						ok: false,
						needsFix: true,
						problems: v.problems,
						error: `地图没写进去（校验不过，逐条列在下面）：${v.problems.slice(0, 3).join('；')}${v.problems.length > 3 ? `（另有 ${v.problems.length - 3} 条）` : ''}`,
						hint: '六样齐再写：no / title / deliverable / criteria / why / sources（出处要 http(s) 官方文档）。'
							+ '缺 `why`（它让终点更近了什么）的节点应当**直接砍掉**，别留在图里充数。',
					}
				}
				// 只动 plan 一个键：其余字段**原样保留**（键序也不动，plan 追加在最后）
				doc.plan = { goal: String(args.goal).trim(), nodes: v.nodes.map((n) => {
					const out = { no: n.no, title: n.title, deliverable: n.deliverable, criteria: n.criteria, why: n.why }
					if (n.branch) out.branch = true
					out.sources = n.sources
					return out
				}) }
				const text = JSON.stringify(doc, null, 2) + '\n'
				const tmp = `${at.file}.tmp-${process.pid}`
				try {
					fs.writeFileSync(tmp, text, 'utf8')
					fs.renameSync(tmp, at.file)
				} catch (e) {
					try { fs.rmSync(tmp, { force: true }) } catch { /* 清不掉就算了，别掩盖真错 */ }
					return { ok: false, error: `地图写盘失败：${e?.message ?? e}` }
				}
				// 回读自检：写完必须能被解析、且校验通过（照仓规：写完就验，不留半成品）
				let back = null
				try { back = validatePlan(JSON.parse(fs.readFileSync(at.file, 'utf8')).plan, '回读') } catch (e) {
					return { ok: false, error: `写完回读失败（文件可能坏了）：${e?.message ?? e}` }
				}
				if (!back.ok) return { ok: false, error: `写完回读校验不过：${back.problems.slice(0, 3).join('；')}` }

				// 刚写完就把"下一课教什么"算出来给老师 —— 比让他自己数文件名可靠
				const writeFrontier = planFrontier(doc.plan, (pack.lessons || [])
					.filter((l) => l.circle === at.circle && l.point === at.point)
					.map((l) => Number(l.displayNumber)))

				return {
					ok: true, op: 'record', point: at.pointPath, file: at.file,
					goal: String(args.goal).trim(), nodes: back.nodes, summary: summarizePlan(doc.plan),
					nextLesson: writeFrontier.ok && !writeFrontier.exhausted ? writeFrontier.next : null,
					nextLine: summarizeFrontier(writeFrontier),
				}
			},
		})
	},
}
