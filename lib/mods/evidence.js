/**
 * lib/mods/evidence.js —— 能力模块：证据档位（P0-4 戊1b，2026-09-25）
 * ==================================================================
 * 两条缝，一个写口：
 *
 *   `POST /api/whale/evidence`   ← **课页**那道题的「贴证据」小表单（照 `/api/whale/note` 的样式）
 *   `whale_evidence`（工具）      ← **agent** 在答疑写回时顺带落一条（`op=append`）/ 看现状（`op=read`）
 *
 * 两个口都走 `lib/evidence-io.js` 的 `appendEvidence()` —— **落盘口只有一处**（键序、校验、
 * 写后回读、失败逐字节回滚都由那一份实现保证）。本模块只做「入参白名单 + HTTP 码映射 + 回执」。
 *
 * ⚠️ **落盘之后要重判一次**（`probeState` + `writeState`）：判据快照（`state.json`）里带着
 *    `challenges[].evidence`，而**证据台账不在 `sourceDigest` 里**（那个指纹只算学生代码树）——
 *    不重判的话，学生刚贴的证据在快照里"看不见"，点亮会拿着旧判词拦人。所以这里落完就地重判。
 *    重判失败**不改** HTTP 码（证据确实记下了，回非 2xx 会诱导重投 → 重复一条 ✗），照 `note.js` 的先例。
 */
import path from 'node:path'
import {
	appendEvidence, readEvidence, meetsEvidence, evidencePath,
	EVIDENCE_KINDS, EVIDENCE_RANK, EVIDENCE_LABEL, EVIDENCE_MAX_BYTES,
} from '../evidence-io.js'
import { probeState, writeState } from '../state-scan.js'
import { readPack } from '../pack-model.js'

const ROUTE_PATH = '/api/whale/evidence'

const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json; charset=utf-8' },
})

/**
 * 只放行这五个字段（白名单，不是黑名单）。
 * `date` 也放行：它是**学生侧事实**，页面能填就填（缺省是 null，**绝不默认"今天"**）。
 */
function pickFields(o) {
	const out = {}
	if (typeof o.lesson === 'string') out.lesson = o.lesson
	if (o.challenge !== undefined) out.challenge = o.challenge
	if (typeof o.kind === 'string') out.kind = o.kind
	if (typeof o.date === 'string') out.date = o.date
	if (typeof o.ref === 'string') out.ref = o.ref
	if (typeof o.note === 'string') out.note = o.note
	return out
}

/** 请求体 → appendEvidence 入参。非 JSON / 非对象 → 明确报错，不猜、不兜底 */
function readArgs(raw) {
	if (raw === null || raw === undefined) return { status: 400, error: '请求体读取失败' }
	let o
	try { o = JSON.parse(String(raw)) } catch { return { status: 400, error: '请求体不是 JSON' } }
	if (!o || typeof o !== 'object' || Array.isArray(o)) {
		return { status: 400, error: '请求体必须是 JSON 对象 { lesson, challenge, kind, date?, ref?, note? }' }
	}
	return { status: 200, args: pickFields(o) }
}

/**
 * 落一条证据 → 就地重判 → 回执。
 *
 * 两种失败要分得开（照 `note.js` 的先例）：
 *   · **抛出** = 请求被拒（lesson 形态 / kind 不认识 / date 形状 / 多余键）→ 400，消息一字不改；
 *     例外：`note` 超 16KB 由 evidence-io 的闸带 `httpStatus:413`（与笔记台账同码）
 *   · **返回 ok:false** = 写后自检没过并且已经回滚 → 500（插件侧故障，不是请求的错）
 */
function toHttp(root, args) {
	const r = appendEvidence(root, args)
	if (!r.ok) {
		// `reason:'rejected'` = 请求被拒（400，消息一字不改）；`'io'` = 写盘/自检失败已回滚（500）
		return json(r.reason === 'rejected' ? 400 : 500, { ok: false, error: r.error })
	}

	// 落完就地重判：快照里 `challenges[].evidence` 才会跟上（证据台账不在 sourceDigest 里）
	let reprobed = false
	let reprobeError = null
	try {
		const pack = readPack(root)
		const { state } = probeState(root, pack, {})
		writeState(root, state)
		reprobed = true
	} catch (e) {
		reprobeError = String(e?.message ?? e)
	}

	// 回执里带上"这道题现在够不够档" —— 学生贴完当场知道过没过（不用等点亮那一步）
	const after = readEvidence(root)
	const ch = Number(r.entry.challenge)
	const min = null // 档位要求住在 EXPECT.json，这里只报"现在最强的一档是什么"
	const have = after.entries.filter((e) => e.lesson === r.entry.lesson && e.challenge === ch)
		.reduce((best, e) => (EVIDENCE_RANK[e.kind] > (EVIDENCE_RANK[best] || 0) ? e.kind : best), null)

	return json(200, {
		ok: true,
		entry: r.entry,
		file: path.relative(path.resolve(root), evidencePath(root)).split(path.sep).join('/'),
		have,
		haveLabel: have ? EVIDENCE_LABEL[have] : null,
		reprobed,
		...(reprobeError ? { reprobeError } : {}),
		...(min ? { min } : {}),
	})
}

/** 工具回执：一门课的证据现状（每道题的档位 + 还差什么） */
function describe(root, lesson) {
	const ev = readEvidence(root)
	const rows = (ev.entries || []).filter((e) => !lesson || e.lesson === lesson)
	const byLesson = new Map()
	for (const e of rows) {
		const key = e.lesson
		if (!byLesson.has(key)) byLesson.set(key, new Map())
		const m = byLesson.get(key)
		const cur = m.get(e.challenge)
		if (!cur || EVIDENCE_RANK[e.kind] > EVIDENCE_RANK[cur.kind]) m.set(e.challenge, e)
	}
	const out = []
	for (const [les, m] of [...byLesson.entries()].sort()) {
		for (const [no, e] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
			out.push({ lesson: les, challenge: no, kind: e.kind, date: e.date, ref: e.ref })
		}
	}
	return { file: ev.file, exists: ev.exists, problems: ev.problems, best: out, count: rows.length }
}

export const plugin = {
	id: 'evidence',
	version: '0.1.0',
	tools: ['whale_evidence'],

	install(hctx) {
		/* ── 工具面：agent 用（答疑写回时顺带落一条 / 看现状） ── */
		hctx.registerTool({
			name: 'whale_evidence',
			description:
				'证据台账（learning-records/evidence.jsonl，**append-only**）：机器判不了的挑战（`auto:false`）'
				+ '可以声明**最低证据档**（EXPECT.json 的 `minEvidence`），那时它不再是不阻塞的老师点头，'
				+ '而是"**补到哪一档证据才够**"。档位**强→弱**：'
				+ EVIDENCE_KINDS.map((k) => `${k}（${EVIDENCE_LABEL[k]}）`).join(' > ')
				+ '。判定取**最高档**（同一道题贴多条，强的算数）—— **只贴 verbal 一定不够**。'
				+ '两个动作：read=看某门课每道题现在的最高档；append=替学生记一条（`ref` 指向那次答疑的 box id）。'
				+ '⚠️ **台账不存在时**判据回退到"不阻塞"，但那**不是**学生可以永远不贴的理由。'
				+ `单条 note 上限 ${EVIDENCE_MAX_BYTES} 字节；` + 'date 可选但**只能显式给** YYYY-MM-DD（不许默认今天）。',
			parameters: {
				type: 'object',
				properties: {
					op: { type: 'string', enum: ['read', 'append'], default: 'read', description: '操作类型' },
					lesson: { type: 'string', description: '课次 id（`知识点/NNNN`，例 spring-boot/0001）' },
					challenge: { type: 'number', description: 'append 必填：第几道挑战（正整数序号）' },
					kind: { type: 'string', enum: [...EVIDENCE_KINDS], description: 'append 必填：证据档（强→弱）' },
					date: { type: 'string', description: '可选：YYYY-MM-DD（**只能显式给**，缺省就是 null）' },
					ref: { type: 'string', description: '可选：这条证据的出处（答疑 box id / 文件名 / 命令）' },
					note: { type: 'string', description: '可选：一句话说清这条证据是什么' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
				},
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_args, v) => {
					if (v?.error) return [{ type: 'text', text: `❌ ${v.error}` }]
					const lines = []
					if (v.op === 'append') {
						const e = v.entry || {}
						lines.push(`✅ 证据已记下：${e.lesson} 第${e.challenge}题 · ${e.kind}（${EVIDENCE_LABEL[e.kind] || ''}）`)
						if (e.ref) lines.push(`   出处：${e.ref}`)
						if (v.have) lines.push(`   这道题现在最强的一档：${v.have}`)
						if (v.reprobed) lines.push('   （已就地重判一次：判据快照跟上了，点亮那一步现在读得到这条）')
						if (v.reprobeError) lines.push(`   ⚠️ 证据记下了，但重判失败：${v.reprobeError} —— 手动跑 whale_state write:true 刷新`)
					} else {
						lines.push(`📎 证据台账（${v.file}${v.exists ? '' : ' —— **还不存在**（没贴过任何证据）'}）：`)
						for (const b of v.best || []) lines.push(`   ${b.lesson} 第${b.challenge}题 = ${b.kind}${b.ref ? `（${b.ref}）` : ''}`)
						if (!(v.best || []).length) lines.push('   （一条都没有）')
						lines.push(`   档位强→弱：${EVIDENCE_KINDS.join(' > ')}`)
						if (!v.exists) lines.push('   ⚠️ 台账不存在 ⇒ 声明了 minEvidence 的题**这一档没判**（回退到"不阻塞"）—— 贴一条即启用')
						for (const p of v.problems || []) lines.push(`   ⚠️ ${p}`)
					}
					return [{ type: 'text', text: lines.join('\n') }]
				},
			},
			async execute(args = {}) {
				const op = args.op || 'read'
				const root = args.root || hctx.paths.packRoot
				if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
				if (op === 'read') {
					return { ok: true, op: 'read', ...describe(path.resolve(root), args.lesson ? String(args.lesson) : null) }
				}
				const r = appendEvidence(path.resolve(root), {
					lesson: args.lesson, challenge: args.challenge, kind: args.kind,
					date: args.date, ref: args.ref, note: args.note,
				})
				if (!r.ok) return { ok: false, error: r.error }
				let reprobed = false
				let reprobeError = null
				try {
					const pack = readPack(path.resolve(root))
					const { state } = probeState(path.resolve(root), pack, {})
					writeState(path.resolve(root), state)
					reprobed = true
				} catch (e) {
					reprobeError = String(e?.message ?? e)
				}
				const d = describe(path.resolve(root), r.entry.lesson)
				const hit = (d.best || []).find((b) => b.challenge === r.entry.challenge)
				return { ok: true, op: 'append', entry: r.entry, have: hit ? hit.kind : null, reprobed, ...(reprobeError ? { reprobeError } : {}) }
			},
		})

		/* ── 路由面：课页那道题的「贴证据」小表单 ── */
		const route = {
			path: ROUTE_PATH,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				const root = hctx.paths.packRoot
				if (!root) return json(503, { ok: false, error: '插件没有配置 packRoot，定位不到课程包（不猜 cwd）' })
				if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
				let raw
				try {
					raw = await request.text()
				} catch {
					raw = null
				}
				const p = readArgs(raw)
				if (p.status !== 200) return json(p.status, { ok: false, error: p.error })
				return toHttp(path.resolve(root), p.args)
			},
		}

		if (typeof hctx.inject === 'function') {
			hctx.inject(['connection'], (c) => {
				const conn = c.get('connection')
				if (!conn?.fetch?.register) {
					hctx.log?.warn?.(`connection 服务没有 fetch.register —— ${ROUTE_PATH} 没挂上`)
					return
				}
				try {
					conn.fetch.register(route)
					hctx.log?.info?.(`证据路由已挂 ${ROUTE_PATH}（跨站栅栏 + 认证由基座继承）`)
				} catch (e) {
					hctx.log?.error?.(`挂 ${ROUTE_PATH} 失败：${e?.message ?? e}`)
				}
			})
		} else {
			hctx.log?.warn?.('宿主没有注入能力：证据路由未注册')
		}
	},
}

export { meetsEvidence }
