/**
 * evidence.mjs —— 证据档位（P0-4 戊1b，2026-09-25）的判据
 * ==================================================================
 * 原始要求：`_board/03-鲸师-参考StudyMate改进方案.md:111-120`。借鉴 StudyMate 的
 * `evidence-check`：证据可信度 **运行结果 > 学生自己写的测试 > 解释能力 > 口头确认**，
 * 且「口头确认单独出现不足以判过」—— 堵的是"学生用一句「我懂了」糊过去"。
 *
 * 四条验收判据（原文）：
 *   ① 真包 `spring-boot/0001` 那条 `auto:false` 回执里出现明确的**证据档位要求**；
 *   ② **只落 `kind:"verbal"`（口头确认）时点亮必须失败**（通道已在，可测）；
 *   ③ 证据档位是 **EXPECT.json 的字段**、证据台账是 **append-only**，都不是话术；
 *   ④ 台账不存在时判据**回退到今天的机械对账**（不静默变松）。
 *
 * 覆盖面：数据层（档位 / 校验 / 最高档 / 写后回滚）· `validateExpect` 的字段规矩 ·
 * `judgeChallenges` 的四种情形 · 路由 `POST /api/whale/evidence` · 工具 `whale_evidence` ·
 * 放行层（`challengeGate`）· 页面数据（practice-data 带档位与 `state:'evidence'`）· 真包不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { plugin as evidencePlugin } from '../lib/mods/evidence.js'
import {
	readEvidence, appendEvidence, evidencePath, meetsEvidence, bestEvidence, evidenceHint,
	EVIDENCE_KINDS, EVIDENCE_RANK, EVIDENCE_KEYS, EVIDENCE_LABEL, EVIDENCE_MAX_BYTES,
} from '../lib/evidence-io.js'
import { judgeChallenges, validateExpect } from '../lib/state.js'
import { challengeGate, judgeSnapshot, readSnapshot } from '../lib/gate.js'
import { probeState, writeState } from '../lib/state-scan.js'
import { readPack } from '../lib/pack-model.js'
import { buildPracticeData } from '../lib/practice.js'
import { migratedPack } from './_t26-migrated-pack.mjs'
import { packRoot } from './_pack.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const INPUT_ROOT = packRoot()
const ROOT = migratedPack(INPUT_ROOT)
const REAL_EXPECT = path.join(ROOT, 'code', '_hello-spring-boot', 'EXPECT.json')

let pass = 0
const fails = []
function ok(cond, msg) {
	if (cond) { pass++; console.log('ok   ' + msg) } else { fails.push(msg); console.log('FAIL ' + msg) }
}
const j = (v) => JSON.stringify(v)
const factsOf = (o = {}) => ({
	dirs: [], files: [], classes: [], annotations: [], endpoints: [], configKeys: [], configValues: [], pomDependencies: [],
	...o,
})

const realBefore = fs.existsSync(evidencePath(ROOT)) ? fs.readFileSync(evidencePath(ROOT), 'utf8') : null
const realExpectBefore = fs.readFileSync(REAL_EXPECT, 'utf8')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-evidence-suite-'))
try {
	fs.cpSync(ROOT, tmp, { recursive: true })
	fs.rmSync(evidencePath(tmp), { force: true })

	/* ── ① 数据层：档位词表与强度 ─────────────────────────────────────── */
	{
		ok(EVIDENCE_KINDS.join('>') === 'run>test>explain>verbal', `档位强→弱钉死（${EVIDENCE_KINDS.join(' > ')}）`)
		ok(EVIDENCE_RANK.run > EVIDENCE_RANK.test && EVIDENCE_RANK.test > EVIDENCE_RANK.explain && EVIDENCE_RANK.explain > EVIDENCE_RANK.verbal,
			`强度值单调（run ${EVIDENCE_RANK.run} > test ${EVIDENCE_RANK.test} > explain ${EVIDENCE_RANK.explain} > verbal ${EVIDENCE_RANK.verbal}）`)
		ok(EVIDENCE_KEYS.join(',') === 'date,lesson,challenge,kind,ref,note', `键序钉死（${EVIDENCE_KEYS.join(',')}）`)
		ok(EVIDENCE_KINDS.every((k) => EVIDENCE_LABEL[k] && EVIDENCE_LABEL[k].length > 4), '每一档都有人话（回执要能说清"还差哪一档"）')
	}

	/* ── ② 台账：append-only + 最高档 + 不默认"今天" ──────────────────── */
	{
		const r0 = readEvidence(tmp)
		ok(r0.exists === false, '文件不存在 = 空态且 `exists:false`（判定层靠它做回退开关）')
		ok(appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal' }).ok === true, '能追加一条')
		const raw = fs.readFileSync(evidencePath(tmp), 'utf8')
		ok(!/"(ts|at|generatedAt|updatedAt)"\s*:/.test(raw), '台账里**没有时间字段**（项目锁死纪律；date 只能显式给）')
		ok(JSON.parse(raw.trim()).date === null, 'date 缺省 = null（**绝不默认"今天"**）')

		appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'run', date: '2026-09-25', ref: 'q-0007' })
		const r = readEvidence(tmp)
		ok(r.entries.length === 2, 'append-only：两条都在（不覆盖）')
		const m = meetsEvidence(r.entries, 'spring-boot/0001', 4, 'test')
		ok(m.have === 'run' && m.ok === true, `取**最高档**而不是"最新一条"（先口头后运行 ⇒ have=run）`)
		ok(meetsEvidence(r.entries, 'spring-boot/0001', 4, 'run').ok === true, '要 run、有 run → 够')
		ok(meetsEvidence(r.entries, 'spring-boot/0001', 3, 'test').have === null, '别的**题**的证据不算数（按 challenge 分组）')
		ok(bestEvidence(r.entries, 'spring-boot/0002', 4) === null, '别的**课**的证据不算数（按 lesson 分组）')

		// 写后回滚：坏形状一条都不落盘
		const before = fs.readFileSync(evidencePath(tmp), 'utf8')
		const bad = [
			{ challenge: 1, kind: 'run' },
			{ lesson: 'spring-boot', challenge: 1, kind: 'run' },
			{ lesson: 'spring-boot/0001', challenge: 0, kind: 'run' },
			{ lesson: 'spring-boot/0001', challenge: 1, kind: 'maybe' },
			{ lesson: 'spring-boot/0001', challenge: 1, kind: 'run', date: '今天' },
			{ lesson: 'spring-boot/0001', challenge: 1, kind: 'run', ts: 'x' },
		]
		let rejected = 0
		for (const b of bad) if (appendEvidence(tmp, b).ok === false) rejected++
		ok(rejected === bad.length, `坏形状全部拒写（${rejected}/${bad.length}）`)
		ok(fs.readFileSync(evidencePath(tmp), 'utf8') === before, '被拒的**一个字节都没落盘**')
	}

	/* ── ③ validateExpect：minEvidence 的规矩 ─────────────────────────── */
	{
		const mk = (ch) => ({ lessons: [{ id: 'x/0001', required: [{ id: 'r', kind: 'dir', value: 'a' }], challenges: [ch] }] })
		let threw = null
		try { validateExpect(mk({ no: 1, deliverable: 'd', auto: false, hint: 'h', minEvidence: 'maybe' })) } catch (e) { threw = e }
		ok(threw && /minEvidence 不认识/.test(threw.message), `档位值不认识 → 拒（${threw?.message?.slice(0, 40)}…）`)

		threw = null
		try { validateExpect(mk({ no: 1, deliverable: 'd', checks: [{ id: 'c', kind: 'dir', value: 'a' }], minEvidence: 'run' })) } catch (e) { threw = e }
		ok(threw && /别一件事两道闸/.test(threw.message), '机器判得了的题不许再要证据档（一件事两道闸 → 拒）')

		let okDoc = null
		try { okDoc = validateExpect(mk({ no: 1, deliverable: 'd', auto: false, hint: 'h', minEvidence: 'run' })) } catch (e) { /* */ }
		ok(okDoc !== null, 'auto:false 的题声明档位 → 通过')
		ok(validateExpect(mk({ no: 1, deliverable: 'd', auto: false, hint: 'h' })) !== null, '**不声明档位**也通过（可选字段，没声明 = 今天的行为）')
	}

	/* ── ④ judgeChallenges 的四种情形（判据 ④ + ②） ──────────────────── */
	{
		const chs = [
			{ no: 1, deliverable: 'd1', auto: false, hint: 'h1', minEvidence: 'test' },
			{ no: 2, deliverable: 'd2', auto: false, hint: 'h2' },
		]
		const f = factsOf()
		const A = judgeChallenges(f, chs, { lesson: 'x/0001' })
		ok(A.evidenceFallback === true && A.evidenceGaps.length === 0 && A.evidenceBlocked.length === 0,
			'判据 ④：**台账不存在** → 回退今天的机械对账（不阻塞）**且 `evidenceFallback:true` 说出来**')
		ok(A.needsReview === 2, '回退时两道题都走"需人工确认"（与今天逐字同行为）')

		const B = judgeChallenges(f, chs, { lesson: 'x/0001', evidence: { exists: true, entries: [{ lesson: 'x/0001', challenge: 1, kind: 'verbal' }] } })
		ok(B.evidenceFallback === false && B.evidenceGaps.length === 1 && B.evidenceBlocked[0] === 1,
			'判据 ②：**只落 verbal → 证据不够**（这一道被阻塞）')
		ok(B.needsReview === 1 && B.challenges.find((c) => c.no === 1).needsReview === false,
			'被阻塞的那道**不进 needsReview**（"不阻塞的需人工确认"与"阻塞"不许混成一个字段）')
		ok(B.challenges.find((c) => c.no === 2).needsReview === true, '**没声明档位**的题不受影响（仍然不阻塞）')

		const C = judgeChallenges(f, chs, { lesson: 'x/0001', evidence: { exists: true, entries: [{ lesson: 'x/0001', challenge: 1, kind: 'test' }] } })
		ok(C.evidenceGaps.length === 0 && C.challenges.find((c) => c.no === 1).evidence.ok === true, '贴到档 → 不再阻塞')
		ok(C.challenges.find((c) => c.no === 1).evidence.hint === '', '够档时不带"还差一档"那句话')

		const D = judgeChallenges(f, chs, { lesson: 'x/0001', evidence: { exists: true, entries: [] } })
		ok(D.evidenceBlocked.length === 1 && D.challenges.find((c) => c.no === 1).evidence.have === null,
			'台账存在、这道题还没贴过 → 也算不够（回执里说"还没有贴过证据"）')
		ok(/还没有贴过证据/.test(D.evidenceGaps[0].hint), `回执那句话成形：${D.evidenceGaps[0].hint.slice(0, 34)}…`)
		ok(D.evidenceGaps[0].min === 'test' && D.evidenceGaps[0].no === 1, '回执带 no 与 min（页面/卡片要逐条列）')
	}

	/* ── ⑤ 真包那条 auto:false 的题：判据 ① 的原始材料 ────────────────── */
	{
		const doc = JSON.parse(realExpectBefore)
		const l1 = doc.lessons.find((l) => l.id === 'spring-boot/0001')
		const c4 = l1.challenges.find((c) => c.no === 4)
		ok(c4.auto === false, '真包 spring-boot/0001 第 4 题是 auto:false（判据 ① 说的就是它）')
		ok(c4.minEvidence === 'run', `它声明了最低证据档 = ${c4.minEvidence}（与产出"新目录里 java -jar 跑起来"对得上）`)
		ok(EVIDENCE_KINDS.includes(c4.minEvidence), '档位值在封闭集里（validateExpect 会拦）')
	}

	/* ── ⑥ 真跑一遍探针 → 快照 → 放行层（判据 ①②④ 端到端） ─────────── */
	{
		const pack = readPack(tmp)
		// ⚠️ 前面几块已经往副本里贴过证据了 —— 这一块要从**干净的空态**起（判据 ④ 要的就是空态）
		fs.rmSync(evidencePath(tmp), { force: true })
		const snap = () => probeState(tmp, pack).state.projects.flatMap((p) => p.lessons).find((l) => l.id === 'spring-boot/0001')

		const a = snap()
		ok(a.evidenceFallback === true && a.evidenceGaps.length === 0, '判据 ④：没台账时探针也回退（快照里 `evidenceFallback:true`）')
		ok(a.challenges.find((c) => c.no === 4).evidence === null, '回退时那道题**不带** evidence 判词（不假装判过）')

		appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal' })
		const b = probeState(tmp, pack).state
		writeState(tmp, b)
		const b1 = b.projects.flatMap((p) => p.lessons).find((l) => l.id === 'spring-boot/0001')
		const ev = b1.challenges.find((c) => c.no === 4).evidence
		ok(ev && ev.ok === false && ev.min === 'run' && ev.have === 'verbal', `探针算出证据不够（min=run / have=verbal / ok=false）`)
		ok(typeof ev.hint === 'string' && ev.hint.includes('还差一档证据'), '判据 ①：**回执里出现明确的证据档位要求**')
		ok(ev.hint.includes(EVIDENCE_LABEL.run), '而且点名要哪一档（不是"补证据"这种空话）')

		// 放行层（插件侧）—— ⚠️ `challengeGate` 判的是**该知识点的上一课**，而真包里
		//    spring-boot 的最后一课是 0002（它的题全过）⇒ 用 stub 把"上一课"钉成 0001，
		//    否则判的是 0002，这条判据会假绿（照 `test/judge-parity.mjs` 的现成写法）。
		const stub = { lessons: [{ point: 'spring-boot', number: 1, id: 'spring-boot/0001', learned: false }] }
		const gate = challengeGate({ root: tmp, pack: stub, point: 'spring-boot', probe: false })
		ok(gate.code === 'evidence-insufficient' && gate.allowed === false,
			`判据 ②：放行层**拦住**（code=${gate.code} / allowed=${gate.allowed}）`)
		ok((gate.evidenceGaps || []).length === 1 && gate.evidenceGaps[0].no === 4, '拦的时候逐条说清是哪道题')
		ok(/证据档不够/.test(gate.error || '') && /贴证据/.test(gate.hint || ''), `回执说清病与修法：${gate.error}`)

		// 判词层直读（与包侧 judgeLightup 同源的那一台）
		const doc = readSnapshot(tmp)
		const judge = judgeSnapshot(doc, tmp, 'spring-boot/0001')
		ok(judge.code === 'evidence-insufficient' && judge.ok === false, 'judgeSnapshot 同一判词（插件侧）')
		ok(judge.evidenceFallback === false, '台账已在 ⇒ 回退开关关掉')

		// 补到档 → 放行
		appendEvidence(tmp, { lesson: 'spring-boot/0001', challenge: 4, kind: 'run' })
		const c = probeState(tmp, pack).state
		writeState(tmp, c)
		const c1 = c.projects.flatMap((p) => p.lessons).find((l) => l.id === 'spring-boot/0001')
		ok(c1.challenges.find((x) => x.no === 4).evidence.ok === true, '补上 run 之后那道题够了')
		const gate2 = challengeGate({ root: tmp, pack: stub, point: 'spring-boot', probe: false })
		ok(gate2.allowed === true, `补到档 → 放行（code=${gate2.code}）`)
		ok(gate2.needsReview && gate2.needsReview.includes(4), '但仍如实回执"第 4 题需人工确认"（够档 ≠ 机器判过）')
	}

	/* ── ⑦ 路由 POST /api/whale/evidence（判据 ③：是个真通道，不是话术） ── */
	{
		fs.rmSync(evidencePath(tmp), { force: true })
		const routes = []
		const tools = []
		evidencePlugin.install({
			paths: { packRoot: tmp },
			log: { info: () => {}, warn: () => {}, error: () => {} },
			registerTool: (d) => tools.push(d),
			inject: (_n, cb) => cb({ get: () => ({ fetch: { register: (r) => routes.push(r) } }) }),
		})
		ok(routes.length === 1 && routes[0].path === '/api/whale/evidence', `挂了 ${routes[0]?.path}（本模块共 ${routes.length} 条）`)
		ok(routes[0].methods.join(',') === 'POST' && routes[0].requestBody === 'buffered', 'POST + 显式 requestBody=buffered')
		ok(tools.length === 1 && tools[0].name === 'whale_evidence', '工具面是 whale_evidence')

		const post = (body) => routes[0].fetch(new Request('http://127.0.0.1:3090/api/whale/evidence', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}))

		const r = await post({ lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal', ref: 'q-0009' })
		const d = await r.json()
		ok(r.status === 200 && d.ok === true, '正常贴一条 → 200 / ok')
		ok(d.entry && d.entry.kind === 'verbal' && d.entry.date === null, '回执带刚落的那条（date 仍是 null，不默认今天）')
		ok(d.reprobed === true, '**落完就地重判**（否则快照读不到这条证据，点亮会拿旧判词拦人）')
		ok(d.have === 'verbal' && d.haveLabel === EVIDENCE_LABEL.verbal, '回执当场告诉学生"现在最强的一档是什么"')

		const doc = readSnapshot(tmp)
		const judge = judgeSnapshot(doc, tmp, 'spring-boot/0001')
		ok(judge.code === 'evidence-insufficient', '判据 ③：走**真路由**贴的证据**真的进了判词**（不是话术）')

		const bad = await post({ lesson: 'spring-boot/0001', challenge: 4, kind: 'nope' })
		const badD = await bad.json()
		ok(bad.status === 400 && /kind 不认识/.test(badD.error || ''), `档位不认识 → **400**（不是 500 —— 那是请求的错）`)
		const bad2 = await post('{不是JSON')
		ok(bad2.status === 400, '坏 JSON → 400（不是 500 崩）')
		// 白名单（不是黑名单）：白名单外的字段**够不到写口**（照 `/api/whale/note` 的 pickFields 同一立场）
		const extra = await post({ lesson: 'spring-boot/0001', challenge: 4, kind: 'run', id: 'x', seq: 99 })
		const extraD = await extra.json()
		ok(extra.status === 200 && extraD.entry && !('id' in extraD.entry) && !('seq' in extraD.entry),
			'白名单外的字段进不了台账（请求说了不算）')
		const wrong = await routes[0].fetch(new Request('http://127.0.0.1:3090/api/whale/evidence'))
		ok(wrong.status === 405, 'GET → 405')

		// 工具面
		const tool = tools[0]
		const read = await tool.execute({ op: 'read', lesson: 'spring-boot/0001', root: tmp })
		ok(read.ok === true && read.exists === true && read.best.length === 1, `工具 op=read 看得到现状（${read.best.length} 条）`)
		const app = await tool.execute({ op: 'append', lesson: 'spring-boot/0001', challenge: 4, kind: 'run', root: tmp })
		ok(app.ok === true && app.have === 'run', '工具 op=append 记一条，并回报"现在最强的一档"')
		const app2 = await tool.execute({ op: 'append', lesson: 'spring-boot/0001', challenge: 4, kind: 'nope', root: tmp })
		ok(app2.ok === false && /kind 不认识/.test(app2.error), '工具面同样拒坏档位（与路由共用同一个写口）')
		const readTxt = tool.output.render({}, read).map((x) => x.text).join('\n')
		ok(/档位强→弱/.test(readTxt), '工具回执里写着档位顺序（agent 不用去猜）')
	}

	/* ── ⑧ 页面数据：practice-data 带上档位与那一态 ───────────────────── */
	{
		const data = buildPracticeData({ state: readSnapshot(tmp), pack: readPack(tmp) })
		// ⚠️ 2026-10-20 身份夹具同步（本轮扩写集）：实践区主键是**规范课次身份**
		//   `circle/point/NNNN`（U21 修补后 buildPracticeData 只产这种键），旧夹具写两段
		//   `spring-boot/0001`。判据强度不变：仍然是"这一课**在**页面数据里"的精确查表。
		const L1 = 'programming/spring-boot/0001'
		const l = data.lessons[L1]
		ok(Boolean(l), `practice-data 里有 ${L1}`)
		const c4 = l.challenges.find((c) => c.no === 4)
		ok(c4.evidence && c4.evidence.min === 'run' && c4.evidence.ok === true, '每道题的 evidence 进了页面数据（min/have/ok）')
		ok(c4.state === 'review', '够档之后页面那一态是"需人工确认"（够档 ≠ 机器判过）')

		// 把 run 撤掉、只留 verbal → 页面那一态必须是**单独一态** `evidence`
		fs.writeFileSync(evidencePath(tmp), JSON.stringify({ date: null, lesson: 'spring-boot/0001', challenge: 4, kind: 'verbal', ref: null, note: null }) + '\n', 'utf8')
		const c = probeState(tmp, readPack(tmp)).state
		writeState(tmp, c)
		const data2 = buildPracticeData({ state: readSnapshot(tmp), pack: readPack(tmp) })
		const c4b = data2.lessons[L1].challenges.find((x) => x.no === 4)
		ok(c4b.state === 'evidence', `证据不够是**单独一态**（state=${c4b.state}）—— 不许并进 todo（那会让学生去改代码）`)
		ok(Array.isArray(c4b.missing) && /还差一档证据/.test(c4b.missing[0] || ''), '那一态带着"还差哪一档"（页面直接显示）')

		// 台账不存在 → 页面必须**说出来**（判据 ④ 不许静默变松）
		fs.rmSync(evidencePath(tmp), { force: true })
		const c2 = probeState(tmp, readPack(tmp)).state
		writeState(tmp, c2)
		const data3 = buildPracticeData({ state: readSnapshot(tmp), pack: readPack(tmp) })
		ok(data3.lessons[L1].evidenceFallback === true, '台账不存在 → 页面数据带 `evidenceFallback:true`（要显示出来）')
		const page = fs.readFileSync(path.join(PLUGIN, 'lib', 'pack-template', 'assets', 'practice.js'), 'utf8')
		ok(/evidenceFallback/.test(page) && /贴证据/.test(page), '课页脚本真的渲染那一块（贴证据表单 + 回退说明）')
		ok(/data-ev-send/.test(page) && /\/evidence/.test(page), '表单真的 POST 到 /evidence（不是只画个框）')
	}

	/* ── ⑨ 同源守卫 ─────────────────────────────────────────────────── */
	{
		const a = fs.readFileSync(path.join(ROOT, 'assets', 'practice.js'), 'utf8')
		const b = fs.readFileSync(path.join(PLUGIN, 'lib', 'pack-template', 'assets', 'practice.js'), 'utf8')
		ok(a === b, '课页脚本两份镜像**逐字节一致**（改一份必须同步另一份）')
		const pure = fs.readFileSync(path.join(PLUGIN, 'lib', 'evidence.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		ok(!/node:fs|fs\./.test(pure), '`lib/evidence.js` 是**纯层**（`state.js` 引它，不许带 fs）')
		const io = fs.readFileSync(path.join(PLUGIN, 'lib', 'evidence-io.js'), 'utf8')
		ok(/appendEvidence/.test(io) && /readEvidence/.test(io), '`lib/evidence-io.js` 是薄 IO 层（读写都在这一份）')
		const expectRaw = fs.readFileSync(REAL_EXPECT, 'utf8')
		ok(/minEvidence/.test(expectRaw), '判据 ③：档位是 **EXPECT.json 的字段**（真包里就有）')
	}

	ok((fs.existsSync(evidencePath(ROOT)) ? fs.readFileSync(evidencePath(ROOT), 'utf8') : null) === realBefore,
		'真包证据台账跑完之后与跑之前逐字相同（判据只在副本上跑）')
	ok(fs.readFileSync(REAL_EXPECT, 'utf8') === realExpectBefore, '真包 EXPECT.json 一字未动')
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }
console.log('✅ 档位强→弱 · 台账 append-only · 最高档判定 · 口头确认不够 · 台账不在时回退且说出来 · 通道真在 · 两侧同源')
