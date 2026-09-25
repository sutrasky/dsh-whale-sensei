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
import { challengeGate } from '../gate.js'
import { planGate } from '../plan.js'
import { startScripts } from '../rebuild-job.js'
import { readTeaching } from '../teaching-io.js'
import { injectionBlock } from '../teaching-apply.js'

/**
 * 建课程的重建链。⚠️ 必须与 `lib/mods/create.js` 的 `LESSON_CHAIN` **一致** ——
 * `test/rebuild-wiring.mjs` 拿同一条清单同时钉住两个入口，哪边漂了都红。
 * 两条（不是五条）：课程只影响课程页与星图，不动色带 / 术语 / 笔记页。
 */
const LESSON_CHAIN = ['tools/build-lessons.js', 'tools/build-starmap.js']

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
				+ 'commit:true 有**三道闸**：① **前置闸** —— 该知识点的 requires 里还有没学完的课就拒绝生成'
				+ '（先建议去学那门课，而不是继续生成新课）；② **上一课挑战闸** —— 该知识点**上一课**的挑战'
				+ '还没全过就拒绝，逐条列 #编号 + hint（判词与包侧 judgeLightup 逐字一致；'
				+ '**没声明判据的课放行**但带显式告警，防死锁）；③ **学情摸底闸** —— 没 intake 记录也拒绝。'
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
					// 教学参数的**唯一注入点**：只在"生成教学内容"这一段（不塞全局 persona —— 那会每轮付上下文租金）
					if (v.teaching?.block) lines.push('', v.teaching.block)
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
				// 放行时也要带出去的**不阻塞**回执（需人工确认的题 / 无判据告警 / required 缺口）。
				// ⚠️ 必须声明在下面那个闸**之前**：声明在使用之后就落进 TDZ，整套 author 会当场炸
				let gateReceipt = null

				// ── 大纲闸（2026-09-24 F2，依据 01:385）──────────────────────────
				// 「没大纲不许建课」—— 判据在 `lib/plan.js`（纯函数，与工具面共用一份）。
				// ⚠️ **禁 force 绕**：没有地图时"下一课教什么"根本没定，绕过去只会产出**假进度**
				//    （撞板子自己的硬规矩第 6 条："假进度比没有进度更伤"）。所以它排在 force 判断**之前**。
				if (args.commit && root && args.point) {
					let pg = null
					try {
						const pk = readPack(path.resolve(root))
						const pt = (pk.points || []).find((x) => x.id === args.point)
						// 知识点本身不认识就不在这儿拦（那是"写盘分支"的事）—— 只管"认识但没有地图"
						if (pt) pg = planGate(pt.plan, `知识点 ${args.point} 的 point.json.plan`)
					} catch { /* 课程包读不动就不猜：交给下面的摸底闸与写盘分支 */ }
					if (pg && pg.ok === false) {
						const head = pg.problems.slice(0, 3).join('；')
						const more = pg.problems.length > 3 ? `（另有 ${pg.problems.length - 3} 条）` : ''
						return {
							ok: false,
							needsPlan: true,
							point: args.point,
							problems: pg.problems,
							error: `没有大纲，拒绝生成新课：${head}${more}`,
							hint: pg.hint,
						}
					}
				}

				if (args.commit && !args.force && root && args.point) {
					let gaps = null
					let pack = null
					try {
						pack = readPack(path.resolve(root))
						gaps = prerequisiteGaps(pack, args.point)
					} catch { /* 课程包读不动就不猜：交给下面的摸底闸与写盘分支 */ }

					// ── 上一课挑战闸（2026-09-24 F1a，v3 §2.2）──────────────────────
					// 与前置闸**合并成同一条提示**（v3 §2.2/§3.2）：两个都过才放行，缺什么一次说清。
					// 判词与包侧 `tools/ask-server.js` 的 judgeLightup **逐字一致** —— 见 lib/gate.js 头部。
					let gate = null
					if (pack) {
						try {
							gate = challengeGate({ root: path.resolve(root), pack, point: args.point })
						} catch (e) {
							// 门禁自己炸了 = 判不了 → **fail-closed**（v3 §4.1），且明说是哪儿炸的，不静默
							gate = { allowed: false, code: 'gate-error', error: `门禁判定失败（判不了就不放行）：${e?.message ?? e}` }
						}
					}

					const byPrereq = gaps && gaps.ok === false
					const byChallenge = gate && gate.allowed === false
					if (byPrereq || byChallenge) {
						const parts = []
						if (byPrereq) parts.push(describeGaps(gaps))
						if (byChallenge) parts.push(gate.why || gate.error || '上一课的挑战还没过')
						return {
							ok: false,
							needsPrerequisite: !!byPrereq,
							needsChallenge: !!byChallenge,
							point: args.point,
							missing: byPrereq ? gaps.missing.map((l) => l.id) : [],
							closure: byPrereq ? gaps.closure : [],
							challenge: gate || null,
							error: `拒绝生成新课：${parts.join('　|　')}`,
							hint: byPrereq
								? '先去学上面列出的课（whale_brief 的「前置体检」一节能看到全部前置状态）；确实要跳过就传 force:true'
								: '去把上一课差的挑战补完，再点「重新检测」；确实要跳过就传 force:true',
						}
					}
					// 放行也要把**不阻塞**的回执带上：需人工确认的题、无判据告警、required 缺口
					if (gate) gateReceipt = gate
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

				// ── force 留痕（2026-09-23）──────────────────────────────────
				// 工具描述一直承诺 force "会留痕"，但 commit+force 这条路既不返回摸底状态、
				// 也不记任何标记 —— 是张空头支票。现在把**被跳过的那几道闸**如实报出来：
				// 留痕要能回答"这次绕过了什么"，而不是只写一句"绕过了"。
				//
				// ⚠️ 必须算在**写盘之前**（2026-09-24 F1a 实测）：上一课挑战闸是**顺序相关**的 ——
				//    写盘之后 `previousLesson()` 就变成了刚建的那门新课（它还没判据），
				//    于是留痕会记成"没绕过任何闸"，而实际上恰恰绕过了最要紧的那道 ✗
				let forced = undefined
				if (args.commit && args.force && root) {
					const bypassed = []
					try {
						const gaps = args.point ? prerequisiteGaps(readPack(path.resolve(root)), args.point) : null
						if (gaps && gaps.ok === false) bypassed.push(`前置：${describeGaps(gaps)}`)
					} catch { /* 课程包读不动就不记这一条，不猜 */ }
					try {
						const pk = args.point ? readPack(path.resolve(root)) : null
						// probe:false —— 留痕不该顺手改快照（那是个写操作）
						const g = pk ? challengeGate({ root: path.resolve(root), pack: pk, point: args.point, probe: false }) : null
						if (g && g.allowed === false) bypassed.push(`上一课挑战：${g.why || g.error}`)
					} catch { /* 同上 */ }
					try {
						const st = args.point ? intakeStatus(root, args.point) : null
						if (st && !st.done) bypassed.push(`学情摸底：${args.point} 还没有 intake 记录`)
					} catch { /* 同上 */ }
					forced = { bypassed }
				}

				let wrote = false
				let rebuild = null
				if (args.commit) {
					if (!root) return { ok: false, error: '没有课程包根目录：配置里写 packRoot，或给本工具传 root' }
					const abs = path.join(path.resolve(root), a.file)
					if (fs.existsSync(abs)) return { ok: false, error: `拒绝覆盖已存在的文件：${a.file}`, file: a.file, valid: v.ok, problems: v.problems }
					fs.mkdirSync(path.dirname(abs), { recursive: true })
					fs.writeFileSync(abs, a.text, 'utf8')
					wrote = true
					// 建课程**也要自己跑重建**（与建圈 / 建知识点同一条纪律：入口建完东西，
					// 产物得自己长出来，不能只把清单丢给调用方当文字看）。
					// 只跑这个包里**真的存在**的脚本；骨架里没有的如实报出来，不静默跳过。
					const kicked = startScripts(path.resolve(root), LESSON_CHAIN, { subject: '课程' })
					rebuild = kicked.job
						? {
							jobId: kicked.job.id,
							scripts: kicked.present,
							missing: kicked.missing,
							note: kicked.missing.length ? `另有 ${kicked.missing.join('、')} 不在这个包里，这次没跑` : null,
						}
						: {
							jobId: null,
							scripts: [],
							missing: kicked.missing,
							note: `课程重建没起：这个包里没有 ${kicked.missing.join('、')} —— 产物不会自己长出来`,
						}
				}

				// 非 commit 模式也带出摸底状态（告知，不失败）
				let intake = undefined
				if (!args.commit && root) {
					const s = intakeStatus(root, args.point)
					intake = { done: s.done, missing: s.missing }
				}

				// 教学参数（`learning-records/teaching.jsonl`）：**一处注入** —— 只在这一段（生成教学内容）
				// 拼进话术；参数没改 ⇒ 这块文本逐字节不变（判据在 test/teaching-apply.mjs）。
				let teaching = undefined
				if (root) {
					try {
						const { latest } = readTeaching(path.resolve(root))
						const inj = injectionBlock(latest)
						teaching = { tier: inj.tier, params: inj.params, directives: inj.directives, block: inj.block }
					} catch { /* 台账读不动就不注入：课程照生成，别因为一个可选项把主流程拦死 */ }
				}

				return { ok: v.ok, file: a.file, text: a.text, valid: v.ok, problems: v.problems, wrote, ...(teaching ? { teaching } : {}), ...(intake ? { intake } : {}), ...(gateReceipt ? { challenge: gateReceipt } : {}), ...(forced ? { forced } : {}), ...(rebuild ? { rebuild } : {}) }
			},
		})
	},
}
