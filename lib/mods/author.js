/**
 * lib/mods/author.js — 能力模块：生成课程源文件骨架
 * ------------------------------------------------------------------
 * 工具 `whale_author`：生成一个**合规的源文件**（第 1 行 meta + 五个槽位）并自查。
 * **默认只返回文本**；`commit: true` 才写到 `lessons/src/<NNNN>-<slug>.html`，
 * 而且**已存在就拒绝覆盖**（不拿骨架去盖真课 ✗）。
 *
 * ⚠️ **提交前把全部硬校验做完**（T03 / 报告 B01）—— 顺序即契约：
 *
 *     解析包 → 唯一识别点 / 圈 → schema / meta → 大纲闸 → 教学闸
 *     → 生成 → 验证 → **独占新建**
 *
 * 为什么顺序不能改（B01 的原话）：「写课没有把校验和路径边界放在**提交前**」——
 * 老实现是"先算路径、先写盘、再报 ok:false"：`halo:'../../../escaped'` 能写到包根之外；
 * `number:0` 会返回 `ok:false, valid:false, wrote:true`（文件**真的**在盘上）。
 * 「调用失败」与「没有副作用」是两件事，这里把它们钉成同一件。
 *
 * 三条硬边界（`force` **也绕不过** —— 它只绕教学闸，不绕路径 / 结构 / schema）：
 *   ① **路径**：halo / point 必须是合法 id（`validateId`）；落点用 `resolveInside` 解，
 *      越界 / 绝对路径 / 软链逃逸一律拒；
 *   ② **结构**：目录里有 `lessons/` 时它就是"声明过的课程包" —— 知识点必须在册、
 *      点与圈必须对得上、点 id 不许跨圈重名（重名就得显式给 halo 才能唯一识别）；
 *      包配置坏了（halo/point/progress 读不动）**明确拒写**，不猜；
 *   ③ **schema / meta**：number 是 1..9999 的整数；title / slug / hintTerm / source 齐全。
 *      生成出来的骨架还要过 `validateSkeleton`，**不过就不落盘**。
 *
 * 落盘只走一条路：**同目录唯一临时文件 + 不覆盖发布**（`COPYFILE_EXCL`），
 * 失败清理本次新建的空目录 —— 拒绝时整棵树的内容与存在性一个字节都不变。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { authorLesson, validateSkeleton, validateId, resolveInside, NUMBER_MIN, NUMBER_MAX } from '../author.js'
import { intakeStatus, buildQuestions } from '../intake.js'
import { describePointRef } from '../point-ref.js'
import { readPack, prerequisiteGaps, describeGaps } from '../pack-model.js'
import { challengeGate } from '../gate.js'
import { planGate } from '../plan.js'
import { startScripts, MAX_QUEUE } from '../rebuild-job.js'
import { readTeaching, GLOBAL_CIRCLE } from '../teaching-io.js'
import { injectionBlock } from '../teaching-apply.js'

/**
 * 身份内核（**唯一**严格实现；U02 交付）。
 *
 * 本模块此前自己拼 `circle/point`（"现有知识点"清单），并且**降维**取点
 * （`pack.points.find((x) => x.id === point)` 只按裸 id 找）—— 跨圈同名点会被"第一个"悄悄认走。
 * 现在：身份构造一律走内核；按点找点的地方一律**带圆圈**（点 / 圈两段一起比）。
 */
const requireCJS = createRequire(import.meta.url)
const identity = requireCJS('../unify/identity.cjs')

/**
 * 一个知识点在课程包里的规范身份（`circle/point`）。
 * 构造不出来（包数据坏了）就**明说**它身份不合法 —— 既不猜一个，也不在这里另拼一个。
 *
 * @param {{circle?:string, id?:string}} p `readPack()` 的 points[] 项
 * @returns {string}
 */
function pointIdentityOf(p) {
  try {
    return identity.pointKey(p?.circle, p?.id)
  } catch {
    return `(身份不合法：circle=${JSON.stringify(p?.circle)} point=${JSON.stringify(p?.id)}）`
  }
}

/**
 * 交给挑战闸的**知识点身份**（决-1；`docs/unify/authorization.json` 的 `decisions.approvedChanged`）。
 *
 * 为什么不能把裸点直接交出去：挑战闸判的是**上一课**，裸点在跨圈同名时只能靠 `pack` 去"算"圆圈；
 * 而 `whale_author` 在 ② 已经把圆圈解析出来了（显式 `halo`，或从课程包推出的唯一归属）——
 * 那个圆圈在这里丢掉，等于把**已经确定的身份**重新降维成"算不出来"：合法的首课
 * （`b/y` 在册、有大纲、前面没有课）会被拦成「上一课的归属不唯一」。
 *
 * 规范身份构造不出来（没有 `lessons/` 的老包 / 没解析出 halo / id 形状不合法）→ **原样回退裸点**，
 * 由 `challengeGate` 自己的 fail-closed 分支按跨圈歧义拒绝 —— 这里既不猜一个圈，也不放宽成放行。
 */
function gatePointOf(halo, point) {
  if (typeof point !== 'string' || !point) return point
  if (typeof halo !== 'string' || !halo) return point
  try {
    return identity.pointKey(halo, point)
  } catch {
    return point
  }
}

/**
 * 建课程的重建链。⚠️ 必须与 `lib/mods/create.js` 的 `LESSON_CHAIN` **一致** ——
 * `test/rebuild-wiring.mjs` 拿同一条清单同时钉住两个入口，哪边漂了都红。
 * 两条（不是五条）：课程只影响课程页与星图，不动色带 / 术语 / 笔记页。
 */
const LESSON_CHAIN = ['tools/build-lessons.js', 'tools/build-starmap.js']

/** 一次拒绝的**统一形状**：调用方只看 `ok:false` + 一句话；`code` 给机器分支用 */
const reject = (error, extra = {}) => ({ ok: false, error, ...extra })

/**
 * schema / meta 硬校验（**与 force 无关**）。返回 `{ok, problems}` —— 全过时 problems 为空。
 * 判据只写一份：这里判"输入够不够格写盘"，`validateSkeleton` 判"生成出来的骨架合不合规"。
 */
function checkInput(a) {
  const problems = []
  if (!Number.isInteger(a.number) || a.number < NUMBER_MIN || a.number > NUMBER_MAX) {
    problems.push(`number 必须是 ${NUMBER_MIN}..${NUMBER_MAX} 的整数（收到 ${JSON.stringify(a.number)}）`)
  }
  if (typeof a.title !== 'string' || !a.title.trim()) problems.push('title 必填（课标题）')
  if (typeof a.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(a.slug)) {
    problems.push(`slug 必须是 ASCII 小写连字符（收到 ${JSON.stringify(a.slug)}）—— 中文标题派生不出可用文件名`)
  }
  if (typeof a.hintTerm !== 'string' || !a.hintTerm.trim()) {
    problems.push('hintTerm 必填（本课的"名字"要指到一个真实术语）')
  }
  const src = a.source
  if (!src || typeof src !== 'object' || typeof src.label !== 'string' || !src.label.trim()
    || typeof src.url !== 'string' || !src.url.trim()) {
    problems.push('source.label / source.url 必填（课程包不允许没有出处的课）')
  }
  if (a.terms !== undefined && a.terms !== null && (typeof a.terms !== 'object' || Array.isArray(a.terms))) {
    problems.push(`terms 必须是对象（收到 ${JSON.stringify(a.terms)}）`)
  }
  if (a.minutes !== undefined && a.minutes !== null && (!Number.isFinite(a.minutes) || a.minutes < 0)) {
    problems.push(`minutes 必须是非负数字（收到 ${JSON.stringify(a.minutes)}）`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 「解析包 → 唯一识别点 / 圈」。
 *
 * 目录里**有 `lessons/`** = 它声明了自己是个课程包 ⇒ 按课程包的规矩严格判：
 * 配置读不动（坏配置）、知识点不在册（未知点）、点 / 圈对不上、点 id 跨圈重名（不唯一）
 * —— 四条都拒。目录里**没有 `lessons/`** = 还没有结构（新建包 / 老包兼容）⇒
 * 不在册可判，不拦（否则"第一节课永远建不出来"）。
 *
 * @returns {{ok:true, pack:object|null, declared:boolean, halo:string|undefined, point:object|null}
 *          |{ok:false, error:string}}
 */
function inspectPack(root, pointId, haloArg) {
  const lessonsDir = path.join(root, 'lessons')
  if (!fs.existsSync(lessonsDir)) {
    // 还没有结构：id 的形状已经在调用方验过（路径边界照样成立），这里不猜归属
    return { ok: true, pack: null, declared: false, halo: haloArg, point: null }
  }
  let pack
  try {
    pack = readPack(root)
  } catch (e) {
    return reject(`课程包读不动（拒绝写课，先修它）：${e?.message ?? e}`)
  }
  // 坏配置：halo.json / point.json / progress.json 解析不了 —— readPack 的纪律是"记进 warnings
  // 不抛错"（它是只读探针的入口，抛错会让整包读不出来）。但**写盘**是另一回事：
  // 连"这个点该不该存在、进度到哪了"都读不准，就不该往里写课。
  const broken = (pack.warnings || []).filter((w) => /读不动/.test(w))
  if (broken.length) {
    return reject(`课程包配置坏了（拒绝写课，先修它）：${broken.join('；')}`)
  }
  const hits = (pack.points || []).filter((p) => p.id === pointId)
  if (!hits.length) {
    const known = (pack.points || []).map(pointIdentityOf)
    return reject(
      `未知知识点：${pointId} 不在这个课程包里（拒绝写课）`
      + `—— 先把这个点建出来（whale_plan 的大纲闸也要它先有地图）；现有的：${known.join(' / ') || '（还没有知识点）'}`
    )
  }
  if (haloArg) {
    const hit = hits.find((p) => p.circle === haloArg) || null
    if (!hit) {
      return reject(
        `点 / 圈 对不上：知识点 ${pointId} 在 ${hits.map((h) => h.circle).join(' / ')} 里，不在 ${haloArg} 里`
        + '（拒绝写课 —— 写错目录的代价是课次映射表推不出 circle/point，页面 / 星图 / 术语对账一起错位）'
      )
    }
    return { ok: true, pack, declared: true, halo: hit.circle, point: hit }
  }
  if (hits.length > 1) {
    return reject(
      `知识点 id「${pointId}」在 ${hits.length} 个圆圈里都有（${hits.map((h) => h.circle).join(' / ')}）`
      + '—— 必须显式给 halo 才能唯一识别（拒绝猜）'
    )
  }
  return { ok: true, pack, declared: true, halo: hits[0].circle, point: hits[0] }
}

/** 临时件序号（进程内单调）—— 名字里的唯一性不靠 `Math.random`（本仓的确定性纪律） */
let TMP_SEQ = 0

/**
 * **独占新建**：把 `text` 发布成 `<root>/<rel>`。
 *
 * 四件事，缺一件就是 B01 里那条"失败却留下副作用"：
 *   ① 落点再解一次 `resolveInside`（生成完也要复核 —— 边界不许只有一处）；
 *   ② 已存在**直接拒**（连目录都不建）；
 *   ③ 同目录**唯一临时文件**先写全，再 `COPYFILE_EXCL` 发布（不覆盖，且半成品不会以正式名字出现）；
 *   ④ 失败清理**本次新建的**空目录与临时文件（自底向上，只删空的；别人的东西一个不碰）。
 *
 * @returns {{ok:true, abs:string, created:string[]}|{ok:false, error:string}}
 */
function publishLesson(root, rel, text) {
  const inside = resolveInside(root, rel, { mustExist: false })
  if (!inside.ok) return { ok: false, error: `拒绝写入（路径越界）：${inside.error}` }
  const abs = inside.abs
  if (fs.existsSync(abs)) {
    return { ok: false, error: `拒绝覆盖已存在的文件：${rel}` }
  }
  const dir = path.dirname(abs)
  // 本次要新建的目录（只清理自己建的；已存在的一律不动）
  const made = []
  let tmp = null
  try {
    const chain = []
    let cur = dir
    while (cur !== inside.root && !fs.existsSync(cur) && chain.length < 64) {
      chain.unshift(cur)
      const up = path.dirname(cur)
      if (up === cur) break
      cur = up
    }
    for (const d of chain) { fs.mkdirSync(d); made.push(d) }
    // 同目录唯一临时文件（`wx` 再保一道：名字撞了就换，绝不覆盖别人的）
    tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now().toString(36)}-${++TMP_SEQ}`)
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
    // 不覆盖发布：目标已存在时 COPYFILE_EXCL 直接失败（这是"拒覆盖"的最后一道，不是唯一一道）
    fs.copyFileSync(tmp, abs, fs.constants.COPYFILE_EXCL)
    try { fs.unlinkSync(tmp) } catch { /* 临时件清不掉不致命：正式文件已经在盘上 */ }
    return { ok: true, abs, created: made }
  } catch (e) {
    if (tmp) { try { fs.unlinkSync(tmp) } catch { /* best effort */ } }
    // 自底向上只删**空的**本次新建目录（非空 = 里面已经有别人的东西，留着）
    for (const d of made.reverse()) { try { fs.rmdirSync(d) } catch { /* 非空 / 已被别人用了 */ } }
    return { ok: false, error: `写不动 ${rel}：${e?.message ?? e}` }
  }
}

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
				+ 'commit:true 的**硬校验全在提交前做完**（force 也绕不过）：① halo/point 必须是合法 id、'
				+ '落点必须解在课程包根之内；② 有 lessons/ 的包里知识点必须在册、点与圈必须对得上、'
				+ '包配置读不动就拒写；③ number 是 1..9999 的整数、title/slug/hintTerm/source 齐全、'
				+ '生成出来的骨架要过 validateSkeleton。**任何一条不过：一个目录、一个字节都不建。**'
				+ '教学闸有三道（commit 且非 force 时生效）：① **前置闸** —— 该知识点的 requires 里'
				+ '还有没学完的课就拒绝生成（先建议去学那门课，而不是继续生成新课）；② **上一课挑战闸**'
				+ '—— 该知识点**上一课**的挑战还没全过就拒绝，逐条列 #编号 + hint（判词与包侧 judgeLightup'
				+ '逐字一致；**没声明判据的课放行**但带显式告警，防死锁）；③ **学情摸底闸** —— 没 intake'
				+ '记录也拒绝。slug / hintTerm / source 必填（中文标题派生不出可用文件名，且课程包不允许没有出处）。',
			parameters: {
				type: 'object',
				properties: {
					point: { type: 'string', description: '知识点 id（如 spring-boot）' },
					halo: { type: 'string', description: '圆圈 id（如 programming）；不传就从课程包里查该知识点所属圆圈' },
					number: { type: 'number', description: '第几课（1..9999 的整数）' },
					title: { type: 'string', description: '课标题（中文可以）' },
					slug: { type: 'string', description: '文件名用的 ASCII 小写连字符 slug' },
					hintTerm: { type: 'string', description: '本课"名字"要指到的术语' },
					source: { type: 'object', description: '出处：{ label, url }' },
					minutes: { type: 'number' },
					terms: { type: 'object' },
					root: { type: 'string', description: '课程包根目录（默认取插件配置 packRoot）' },
					commit: { type: 'boolean', description: 'true = 写进 lessons/src/' },
				force: { type: 'boolean', description: 'true = 明知前置没学完 / 没做学情摸底也落盘（返回里 forced.bypassed 会列出被跳过的闸）；**硬校验（路径 / 结构 / schema）它绕不过**' },
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
				const commit = args.commit === true
				const force = args.force === true
				const rootArg = args.root || hctx.paths.packRoot

				// ── ① 解析包 ────────────────────────────────────────────────
				// 写盘必须有根，而且根得**真的在**（`resolveInside` 也要它存在才判得了真身边界）。
				// ⚠️ 这一条排在 force 判断**之前**：force 只绕教学闸，绕不过"往哪儿写"。
				let root = null
				if (commit) {
					if (!rootArg) return reject('没有课程包根目录：配置里写 packRoot，或给本工具传 root')
					root = path.resolve(String(rootArg))
					if (!fs.existsSync(root)) return reject(`课程包根不存在：${root}（拒绝写课）`)
				} else if (rootArg) {
					root = path.resolve(String(rootArg))
				}

				// ── ② 唯一识别点 / 圈 ────────────────────────────────────────
				// id 的形状先验（它俩直接拼进目录名）：`..` / 绝对路径 / 斜杠在这里就死。
				const idProblems = []
				const pointErr = validateId(args.point)
				if (pointErr) idProblems.push(`point ${pointErr}`)
				if (args.halo !== undefined && args.halo !== null) {
					const haloErr = validateId(args.halo)
					if (haloErr) idProblems.push(`halo ${haloErr}`)
				}
				if (idProblems.length) return reject(`拒绝写课：${idProblems.join('；')}`, { problems: idProblems })

				// 圆圈（halo）：显式参数 > 课程包里该知识点所属的圆圈 > 不写（退回平铺，老包兼容）。
				// 为什么不只靠显式参数：调用方（agent）通常只知道知识点 id，不知道它在哪个圆圈里；
				// 而写错目录的代价是课次映射表推不出 circle/point（页面/星图/术语对账一起错位）。
				let halo = args.halo
				let pack = null
				let declared = false
				if (commit) {
					const insp = inspectPack(root, args.point, args.halo)
					if (insp.ok === false) return insp
					pack = insp.pack
					declared = insp.declared
					halo = insp.halo
				} else if (root && !halo && args.point) {
					// ⚠️ 只按裸点 `.find()` 取圆圈 = **降维**（Bug5 同类）：跨圈同名点会被"第一个"
					//    悄悄认走，于是非 commit 这一路报出来的摸底状态属于**另一个圆圈**。
					//    这里只认**唯一**命中；歧义就不给圆圈（不猜，交给 id 解析器如实拒）。
					try {
						const hits = readPack(root).points.filter((p) => p.id === args.point)
						if (hits.length === 1) {
							// 这一对能不能形成规范身份，由内核说了算（不合法就不给圆圈，也不猜）
							identity.pointKey(hits[0].circle, hits[0].id)
							halo = hits[0].circle
						}
					} catch { /* 读不动课程包就不猜：退回平铺，别把课丢进一个不存在的圆圈 */ }
				}

				// ── ③ schema / meta ─────────────────────────────────────────
				const schema = checkInput(args)
				if (schema.ok === false) return reject(`拒绝写课：${schema.problems.join('；')}`, { problems: schema.problems })

				// ── ④ 大纲闸（2026-09-24 F2，依据 01:385）─────────────────────
				// 「没大纲不许建课」—— 判据在 `lib/plan.js`（纯函数，与工具面共用一份）。
				// ⚠️ **禁 force 绕**：没有地图时"下一课教什么"根本没定，绕过去只会产出**假进度**
				//    （撞板子自己的硬规矩第 6 条："假进度比没有进度更伤"）。所以它排在 force 判断**之前**。
				if (commit && declared && pack) {
					// ⚠️ 按**点 + 圈**两段一起找：只按裸点找会拿另一个圆圈的同名点的大纲来判
					//    （串目标 / 串大纲），这正是本卡要收掉的那类降维。
					const pt = pack.points.find((x) => x.id === args.point && x.circle === halo)
					const pg = pt ? planGate(pt.plan, `知识点 ${args.point} 的 point.json.plan`) : null
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

				// ── ⑤ 教学闸（前置 + 上一课挑战 + 摸底）──────────────────────
				// 放行时也要带出去的**不阻塞**回执（需人工确认的题 / 无判据告警 / required 缺口）。
				// ⚠️ 必须声明在下面那个闸**之前**：声明在使用之后就落进 TDZ，整套 author 会当场炸
				let gateReceipt = null

				if (commit && !force && declared && pack) {
					// ── 前置闸（2026-09-23 用户裁定）──────────────────────────
					// 「开课摸底时就要知道学生是不是学会了相关的前置内容，如果没有，就要建议他
					//   去开没学的课**而不是继续给他生成课程**。」
					// 排在摸底闸之前：前置没补齐时，连摸底都不该做 —— 先补课。
					// 判据真源 = point.json 的 requires（readPack 早已解析），不是这里另写一套。
					let gaps = null
					try { gaps = prerequisiteGaps(pack, args.point) } catch { /* 判不了就不猜：交给下面的闸 */ }

					// ── 上一课挑战闸（2026-09-24 F1a，v3 §2.2）──────────────────
					// 与前置闸**合并成同一条提示**（v3 §2.2/§3.2）：两个都过才放行，缺什么一次说清。
					// 判词与包侧 `tools/ask-server.js` 的 judgeLightup **逐字一致** —— 见 lib/gate.js 头部。
					// ⚠️ `probe:false`（T03）：**只读判定**。`probe:true` 会在快照过期时重扫并
					//    **原子写回 state.json** —— 那是"拒写"顺带改了学生的状态，是副作用。
					//    要刷新快照就显式跑 `whale_state write:true`（回执里的 hint 会说）。
					// 决-1（2026-10-20 授权）：传**规范身份**（② 解析出来的 circle+point），裸点只在
					// 解析不出圆圈时回退 —— 那时才由门禁按跨圈歧义 fail-closed，绝不在这里猜一个圈。
					const gatePoint = gatePointOf(halo, args.point)
					let gate = null
					try {
						gate = challengeGate({ root, pack, point: gatePoint, probe: false })
					} catch (e) {
						// 门禁自己炸了 = 判不了 → **fail-closed**（v3 §4.1），且明说是哪儿炸的，不静默
						gate = { allowed: false, code: 'gate-error', error: `门禁判定失败（判不了就不放行）：${e?.message ?? e}` }
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
				if (commit && !force && root) {
					// 摸底记录的 `point` 可能是 catalog 给的复合 id（`programming/js-basics`），也可能是裸 id
					// （`js-basics`）—— 统一由 `lib/point-ref.js` 的解析器对成同一个规范 key 再比对
					// （Bug5：此前这里拿裸 id 去 `latest[point]` 精确匹配，复合 id 的记录就"看不见"了）。
					// 同时把 `halo` / `pack` 传下去：同名知识点跨圆圈重名时只有带圆圈才唯一（不猜）。
					const status = intakeStatus(root, args.point, { pack, halo })
					if (!status.done) {
						const qResult = buildQuestions({ point: args.point, topic: args.title })
						// 「id 认不出来」与「真没摸底」是**两种病、两句修法**：前者要把 id 写对（回执里带候选 / 合法 id），
						// 后者才是去摸底。混成一句就会把人指去重做一遍摸底。
						const badRef = status.ref && status.ref.ok === false ? status.ref : null
						return {
							ok: false,
							needsIntake: true,
							...(badRef ? { needsPointRef: true, candidates: badRef.candidates } : {}),
							error: badRef
								? `先做学情摸底：知识点 id 认不出来 —— ${describePointRef(badRef)}`
								: `先做学情摸底：${args.point} 还没有 intake 记录`,
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
				if (commit && force && root) {
					const bypassed = []
					try {
						const gaps = args.point ? prerequisiteGaps(readPack(root), args.point) : null
						if (gaps && gaps.ok === false) bypassed.push(`前置：${describeGaps(gaps)}`)
					} catch { /* 课程包读不动就不记这一条，不猜 */ }
					try {
						const pk = args.point ? readPack(root) : null
						// probe:false —— 留痕不该顺手改快照（那是个写操作）
						// 决-1：留痕也用**规范身份**（与上面那道闸同一份解析结果）—— 否则记下来的
						// "绕过了什么"可能属于另一个圆圈的同名点，留痕本身就成了假账。
						const g = pk ? challengeGate({ root, pack: pk, point: gatePointOf(halo, args.point), probe: false }) : null
						if (g && g.allowed === false) bypassed.push(`上一课挑战：${g.why || g.error}`)
					} catch { /* 同上 */ }
					try {
						// 留痕也走同一套 id 解析（复合 / 裸 id 都认）：不然绕过的闸会记成"没绕过任何闸"。
						const st = args.point ? intakeStatus(root, args.point, { pack, halo }) : null
						if (st && !st.done) bypassed.push(`学情摸底：${args.point} 还没有 intake 记录`)
					} catch { /* 同上 */ }
					forced = { bypassed }
				}

				// ── ⑥ 生成 ──────────────────────────────────────────────────
				let a
				try {
					a = authorLesson({
						halo, point: args.point, number: args.number, title: args.title,
						slug: args.slug, hintTerm: args.hintTerm, source: args.source,
						minutes: args.minutes, terms: args.terms,
					})
				} catch (e) { return reject(e?.message ?? String(e)) }

				// ── ⑦ 验证（骨架不合规就**不落盘**）──────────────────────────
				const v = validateSkeleton(a.text)
				if (v.ok === false) {
					return reject(`骨架自查不过，拒绝落盘：${v.problems.slice(0, 3).join('；')}`, {
						file: a.file, valid: false, problems: v.problems,
					})
				}

				// ── ⑧ 独占新建 ──────────────────────────────────────────────
				let wrote = false
				let rebuild = null
				if (commit) {
					const pub = publishLesson(root, a.file, a.text)
					if (pub.ok === false) {
						return { ok: false, error: pub.error, file: a.file, valid: v.ok, problems: v.problems }
					}
					wrote = true
					// 建课程**也要自己跑重建**（与建圈 / 建知识点同一条纪律：入口建完东西，
					// 产物得自己长出来，不能只把清单丢给调用方当文字看）。
					// 只跑这个包里**真的存在**的脚本；骨架里没有的如实报出来，不静默跳过。
					// T04-R2 裁定甲（**唯一一处 hctx 透传**）：`hctx.trustedEngine === false` 是
					// **显式旁路**，只给"夹具不是真包"的测试调用点用；生产 hctx 上没有这个字段 ⇒ 一律严。
					// T16 追加：owner = 插件作用域（`hctx.scope`）——装载回滚 / 宿主卸载时，
					// 建课程起的那条重建（与它的进程树）随之被撤，并且**等它真的结束**。
					// ⚠️ 分支顺序是**硬的**（与 lib/mods/create.js 的 `kick()` 同一口径）：
					//    引擎拒 → 缺脚本（含"空链"）→ 队列忙 → 正常。
					// 🐞 2026-10-19 修（Bug3 的同类调用方）：旧代码判的是 `kicked.job && kicked.job.engineError`
					//    —— 而引擎闸拒时 `startScripts()` 回的是 `{job:null, engineError, engineMissing,
					//    engineMismatched, badPaths}`（零 spawn，连作业都不建），`job` 是 null ⇒
					//    那个条件**永远为假**，引擎拒掉进下面"没起且 missing 空"那一支，
					//    用户看到的是逐字「课程重建没起：这个包里没有  —— 产物不会自己长出来」：
					//    既没说清病（引擎不一致），也没给修法（--plan → --apply）。
					const kicked = startScripts(root, LESSON_CHAIN, { subject: '课程', scope: hctx?.scope, trustedEngine: hctx?.trustedEngine !== false })
					const engineBlocked = kicked.engineError || (kicked.job && kicked.job.engineError) || null
					if (engineBlocked) {
						// 引擎闸拒掉：**零 spawn**，如实带出原因与修法（不许静默成"起了"）
						rebuild = {
							jobId: null,
							scripts: [],
							missing: kicked.missing,
							engineError: engineBlocked,
							engineMissing: kicked.engineMissing ?? (kicked.job && kicked.job.engineMissing) ?? [],
							engineMismatched: kicked.engineMismatched ?? (kicked.job && kicked.job.engineMismatched) ?? [],
							badPaths: kicked.badPaths ?? (kicked.job && kicked.job.badPaths) ?? [],
							blocked: 'engine',
							note: `课程重建没起：${engineBlocked}`,
						}
					} else if (!kicked.job) {
						// 没起作业且不是引擎拒 ⇒ 这个包里没有这些脚本（**不许**在 missing 空时拼出空宾语）
						rebuild = kicked.missing.length
							? {
								jobId: null,
								scripts: [],
								missing: kicked.missing,
								blocked: 'missing-scripts',
								note: `课程重建没起：这个包里没有 ${kicked.missing.join('、')} —— 产物不会自己长出来`,
							}
							: {
								jobId: null,
								scripts: [],
								missing: [],
								blocked: 'empty-chain',
								note: '课程重建没起：这条重建链上没有可跑的脚本（链是空的）—— 产物不会自己长出来',
							}
					} else if (kicked.busy === true || kicked.job.code === 'busy') {
						// 排队满了：与"包里没有脚本"是两件事，分开说（不许复用下面那句文案）
						rebuild = {
							jobId: kicked.job.id,
							scripts: kicked.present,
							missing: kicked.missing,
							busy: true,
							blocked: 'busy',
							note: `课程重建没起：重建排队已满（全局最多 ${MAX_QUEUE} 条在等）—— 这次的作业被拒，稍后重试；产物不会自己长出来`,
						}
					} else {
						rebuild = {
							jobId: kicked.job.id,
							scripts: kicked.present,
							missing: kicked.missing,
							blocked: null,
							note: kicked.missing.length ? `另有 ${kicked.missing.join('、')} 不在这个包里，这次没跑` : null,
						}
					}
					// 历史形状（平铺课程源 / 旧课次键）**只指路**：这里不解码、不迁移、也不复制旧解析
					// —— 唯一的迁移实现是 tools/migrate-pack.mjs（U05），回执里带的是它的命令行。
					if (rebuild && kicked.migration) rebuild.migration = kicked.migration
				}

				// 非 commit 模式也带出摸底状态（告知，不失败）
				let intake = undefined
				if (!commit && root) {
					// 同一套 id 解析：复合 / 裸 id 混着写过也认（`pack` 此时可能没读，intakeStatus 会自己尽力读）
					const s = intakeStatus(root, args.point, { pack, halo })
					intake = { done: s.done, missing: s.missing }
				}

				// 教学参数（`learning-records/teaching.jsonl`，**按圆圈分节**）：**一处注入** ——
				// 只在这一段（生成教学内容）拼进话术；注入 = 全局层（学科中立）⊕ **这个圆圈**的特化。
				// 参数没改 ⇒ 这块文本逐字节不变（判据在 test/teaching-apply.mjs）。
				let teaching = undefined
				if (root) {
					try {
						const data = readTeaching(root)
						const inj = injectionBlock({ data, circle: halo || GLOBAL_CIRCLE })
						teaching = { circle: inj.circle, tier: inj.tier, params: inj.params, directives: inj.directives, block: inj.block }
					} catch { /* 台账读不动就不注入：课程照生成，别因为一个可选项把主流程拦死 */ }
				}

				return { ok: v.ok, file: a.file, text: a.text, valid: v.ok, problems: v.problems, wrote, ...(teaching ? { teaching } : {}), ...(intake ? { intake } : {}), ...(gateReceipt ? { challenge: gateReceipt } : {}), ...(forced ? { forced } : {}), ...(rebuild ? { rebuild } : {}) }
			},
		})
	},
}
