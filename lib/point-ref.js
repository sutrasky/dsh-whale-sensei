/**
 * lib/point-ref.js — 知识点 id 的**统一解析**（circle/point 复合 id ↔ 裸 id）
 * ==================================================================
 * 病根（Bug5）：同一个知识点在仓库里有两种写法，各层各用一半 ——
 *
 *   · **catalog / 页面 / 星图**给的是复合 id：`lib/pack-model.js` 的 `pointKey(circle, point)`
 *     → `programming/js-basics`（`lib/mods/catalog.js` 的 `id: \`${c.id}/${pt.id}\`` 同源）；
 *   · **落盘目录 / 写课入口**给的是裸 id：`lessons/<圆圈>/<知识点>/` 的目录名就是 `js-basics`,
 *     `whale_author` 的 `point` 参数也是它（`lib/author.js` 的 `validateId` 根本不许斜杠）。
 *
 * 于是 `whale_intake` 把复合 id 原样存进 `learning-records/intake.jsonl`，而 `whale_author`
 * 用裸 id 去 `latest[point]` 精确匹配 → 「摸底做了」却回「先做学情摸底：js-basics 还没有 intake 记录」。
 *
 * 判据（任务卡四条硬要求，全部落在**这一个**函数里，别处不许各写一套）：
 *   ① **一份规则**：输入 `{pack, ref, halo?}`，输出 `{ok:true, circle, id, key}` 或明确的拒绝原因；
 *   ② **不许简单去前缀**：`a/x` 与 `b/x` 是两个不同的 `key`，同名知识点绝不串记录；
 *   ③ **只有唯一匹配才认**：裸 id 在两个圆圈里都存在 → 拒绝（列候选），不猜；
 *   ④ **未知 id 拒绝**并列出包里合法 id；点 / 圈对不上也拒绝（并说清它属于哪个圈）。
 *
 * 两条兼容纪律（每一处都是刻意的）：
 *   · **没有目录可对照**（`pack` 为 null / 包里零个知识点 —— 老包、还没建点的包、只做摸底的目录）时
 *     退回**结构性**解析：带 `/` 的按 `circle/id` 分层，不带的就按裸 id 原样用。
 *     这时 `unverified:true` —— 明确标记"没有目录核对过归属"，**不猜**；老调用方（`intakeStatus(root,'vue')`）
 *     照旧工作。而 `a/x` 与 `b/x` 在这种模式下**仍然是两个 key**（隔离不靠课程包才成立）。
 *   · **课程包读得出来**时一律按目录核验：裸 id 必须唯一（或多给 `halo`）才认。
 *
 * ⚠️ 本模块是**纯函数**：不读盘、不写盘、不缓存 —— 课程包由调用方用 `readPack()` 读好传进来。
 */

/** 一个方向：合法 id 的排列顺序固定（按圆圈、再按点），拒绝理由里的候选才可对拍 */
function pointsOf(pack) {
	const list = Array.isArray(pack?.points) ? pack.points : []
	const out = []
	for (const p of list) {
		if (!p || typeof p !== 'object') continue
		if (typeof p.id !== 'string' || !p.id) continue
		if (typeof p.circle !== 'string' || !p.circle) continue
		out.push(p)
	}
	return out
}

/** 知识点在课程包里的规范 id（`pointKey` 的同一个形状，但不 import 它：那是纯字符串拼接） */
function qualified(p) {
	return `${p.circle}/${p.id}`
}

/** 把 `a/x` 拆成 `{circle:'a', id:'x'}`；不带 `/` 或形状不合法 → null（**不猜**） */
function splitQualified(ref) {
	const i = ref.indexOf('/')
	if (i <= 0 || i === ref.length - 1) return null
	return { circle: ref.slice(0, i), id: ref.slice(i + 1) }
}

/** `ref` 归一成字符串（`undefined` / `null` → 空串；数字等原样 toString）；不抛错 */
function normRef(ref) {
	if (ref === undefined || ref === null) return ''
	return String(ref).trim()
}

/**
 * 解析一个知识点引用。
 *
 * @param {{pack?: object|null, ref?: string, halo?: string|null}} spec
 *   `pack` = `readPack(root)` 的返回值（或 `null`：没有目录可对照）；
 *   `ref` = 裸 id（`js-basics`）或复合 id（`programming/js-basics`）；
 *   `halo` = 圆圈 id（可选；给了就**只**在这个圆圈里找，对不上就拒绝而不是换一个圆找）
 * @returns {{ok:true, circle:string|null, id:string, key:string, bare:string, halo:string|null, unverified:boolean}
 *          |{ok:false, code:'missing-ref'|'unknown'|'ambiguous'|'halo-mismatch', ref:string, halo:string|null,
 *            candidates:string[], error:string}}
 */
export function resolvePointRef({ pack, ref, halo } = {}) {
	const raw = normRef(ref)
	const h = typeof halo === 'string' && halo.trim() ? halo.trim() : null
	if (!raw) {
		return {
			ok: false,
			code: 'missing-ref',
			ref: '',
			halo: h,
			candidates: [],
			error: '没有给知识点 id（point / ref 是空的）',
		}
	}
	const pts = pointsOf(pack)

	// ── 没有目录可对照：只按**形状**分层，标 unverified（不猜归属）──
	if (!pts.length) {
		const parts = splitQualified(raw)
		return parts
			? { ok: true, circle: parts.circle, id: parts.id, key: `${parts.circle}/${parts.id}`, bare: parts.id, halo: h, unverified: true }
			: { ok: true, circle: h, id: raw, key: raw, bare: raw, halo: h, unverified: true }
	}

	// ── 有目录：一律核验 ──
	// 命中判据只有两条：裸 id 相等，或与规范 id 逐字相等（`a/x` 这种复合写法）。
	const byRef = pts.filter((p) => p.id === raw || qualified(p) === raw)
	if (!byRef.length) {
		const legal = pts.map(qualified)
		return {
			ok: false,
			code: 'unknown',
			ref: raw,
			halo: h,
			candidates: legal,
			error: `未知知识点 id「${raw}」—— 这个课程包里没有它；合法 id：${legal.join(' / ') || '（还没有知识点）'}`,
		}
	}
	const scoped = h ? byRef.filter((p) => p.circle === h) : byRef
	if (!scoped.length) {
		// 点存在、但不在给定的圆圈里 —— 这是"写错目录"的前兆，必须拒绝（别悄悄换一个圆写）
		const where = byRef.map(qualified)
		return {
			ok: false,
			code: 'halo-mismatch',
			ref: raw,
			halo: h,
			candidates: where,
			error: `点 / 圈对不上：「${raw}」在 ${where.join(' / ')} 里，不在圆圈 ${h} 里`,
		}
	}
	if (scoped.length > 1) {
		// 唯一匹配才认：同名知识点在两个圆圈里都存在 → 拒绝，列候选（**绝不按"第一个"猜**）
		const candidates = scoped.map(qualified)
		return {
			ok: false,
			code: 'ambiguous',
			ref: raw,
			halo: h,
			candidates,
			error: `知识点 id「${raw}」在 ${candidates.length} 个圆圈里都有（${candidates.join(' / ')}）`
				+ ' —— 必须给圆圈（halo）或用完整 id（圆圈/知识点）才能唯一识别，绝不猜',
		}
	}
	const hit = scoped[0]
	return { ok: true, circle: hit.circle, id: hit.id, key: qualified(hit), bare: hit.id, halo: hit.circle, unverified: false }
}

/**
 * 拒绝结果说成人话（工具回执 / 拒绝理由 / 日志共用这**一份**措辞，避免各说各话）。
 *
 * @param {ReturnType<typeof resolvePointRef>|null|undefined} r
 * @returns {string}
 */
export function describePointRef(r) {
	if (!r || typeof r !== 'object') return '（没有解析结果）'
	if (r.ok === true) return r.unverified ? `${r.key}（没有课程包目录可对照，未核验归属）` : r.key
	const cands = Array.isArray(r.candidates) ? r.candidates : []
	if (r.code === 'missing-ref') return '没有给知识点 id'
	if (r.code === 'unknown') return `未知知识点 id「${r.ref}」—— 合法 id：${cands.join(' / ') || '（还没有知识点）'}`
	if (r.code === 'ambiguous') return `知识点 id「${r.ref}」在 ${cands.length} 个圆圈里都有（${cands.join(' / ')}）—— 必须显式给圆圈（halo）或写完整的「圆圈/知识点」`
	if (r.code === 'halo-mismatch') return `点 / 圈对不上：「${r.ref}」在 ${cands.join(' / ')} 里，不在圆圈 ${r.halo} 里`
	return r.error || String(r.code || '解析失败')
}

/**
 * 课程包里全部合法知识点 id（按圆圈、再按点；给"未知 id"的拒绝理由与 UI 用）。
 * @param {object|null} pack
 * @returns {string[]}
 */
export function listPointRefs(pack) {
	return pointsOf(pack).map(qualified)
}
