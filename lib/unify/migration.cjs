'use strict'
/**
 * lib/unify/migration.cjs —— **一次性身份迁移**（U05 新建）
 * ==================================================================
 * 这是全仓**唯一**允许解码历史身份写法的地方（U-SPEC §2 / §4）。运行态任何读取
 * 路径都**不许**调用本模块做隐式双读、不许按环境/调用栈/测试目录改规则、也不许
 * 留长期兼容层 —— 它只被显式迁移命令调用一次。
 *
 * ## 三个入口（U-SPEC §4 的设计接口†，本卡落地）
 *
 *   planIdentityMigration(root, {fs})                     → {ok:true, plan} | {ok:false, ...}
 *   applyIdentityMigration(root, {confirm, planDigest, fs, build})       → 回执
 *   rollbackIdentityMigration(root, {confirm, planDigest, backupDir, fs}) → 回执
 *
 * 回执形状与 `lib/unify/commit.cjs` **同一套**（`{ok,state,code?,error?,failure?,
 * rollbackError?,journal?,value?}`，七态），因为提交/回滚都走它：本模块只负责
 * "历史形状 → 规范身份"的计算，事务（包锁 / whale-txn/1 / 七态）归 U06 那层，
 * 本模块**不拿锁、不写日志、不自己回滚**。
 *
 * ## 规范身份（U02 内核）
 *
 *   知识点键  circle/point
 *   课次键    circle/point/NNNN（1–9999，四位十进制）
 *
 * 构造与解析一律走 `./identity.cjs`（不复制第二份规则）。
 *
 * ## 历史形状清单（每一类都**先核实真实结构/上下文**再决定归一或阻断）
 *
 * | 类 | 真实落点（基线源码核实） | 处置 |
 * |---|---|---|
 * | `bare-point` | `learning-records/intake.jsonl` 的 `point`（lib/intake.js:12-14 明说裸 id 与复合 id 混用）、`goals.jsonl` 的 `point`/`pointPath`（lib/goal-io.js:364-399） | 归一到 `circle/point`（圆圈由 `lessons/<circle>/<point>/point.json` 唯一确定） |
 * | `point-lesson`（`point/课号`，缺圆圈） | `evidence.jsonl` 的 `lesson`（lib/evidence-io.js:9 的键序注释与 254-309 的样例 `spring-boot/0001`）、`notes/notes.jsonl` 的 `anchor`（lib/notes-io.js:5-14，且明确"星图课次键 = point/NNNN"）、`adjustments.jsonl` 的 `lesson`（lib/adjust-io.js:5,63） | 补齐圆圈成 `circle/point/NNNN` |
 * | `point-in-lesson-slot`（两段点键落在课程位） | 同一批课程位字段；`identity.cjs` 文件头点名"两段课键"是运行态拒绝的形状 | 仅当该知识点**只有一门**已学课程时归一；0 门=缺归属、≥2 门=歧义（点键**不能**扩展成多门课） |
 * | `narrow-lesson-number` / `wide-lesson-number`（1–5 位课号） | 课程位字段里的 `circle/point/1`、`/01`、`/00001`… | 数值 1–9999 才补零归一；0 / >9999 = 越界阻断；>5 位 = 形状不可判定，阻断 |
 * | `display-name`（显示名） | `assets/glossary-data.js` 的 `lesson: '第1课'`（lib/pack-template/tools/build-glossary-tree.js:62-73 用**显示名**反查课次；模板注释 41 行 `lesson: '第2课'`）、`assets/questions-data.js` 的 `lesson`（lib/ask-io.js:644-650 落的是 `hit.label`） | **阻断**（见下"派生重建"） |
 * | `legacy-flat-path`（旧平铺路径） | `assets/practice-data.js` 的 `byFile` 键 `lessons/0001-x.html`（lib/practice.js:55-80 的 byFile 表）、`lessons/0001-*.html` 平铺页（lesson-map.js:74-75 `LEGACY_HALO/LEGACY_POINT`） | 平铺页只作为**归属依据**；`practice-data.js` 里的键**阻断**（见下） |
 * | `bare-lesson-number`（只有课号） | `assets/practice-data.js` v1 的 `lessons` 键（lib/practice.js:14-28,134-136 明说 v1 用课号、跨圈同号会撞） | 候选唯一才归一；跨圈同号 = 歧义阻断 |
 * | `canonical-*` | 已经是 `circle/point` / `circle/point/NNNN` | 不动（逐字节保留） |
 *
 * ### 为什么 display-name / legacy-flat-path / notes 的 anchor 是**阻断**而不是归一
 *
 * 这三个地方改的不只是台账，而是**派生产物**的输入：
 *   · `assets/glossary-data.js` 的 `lesson` → `GLOSSARY.md` 的「首次出现」列直接印它
 *     （lib/glossary.js:234-238）；
 *   · `assets/questions-data.js` 的 `lesson` → `reference/NOTES.html` 的分组键与
 *     课程页「DSH 笔记」卡片的答疑计数（lib/render-inputs.js 按 `q.lesson === lesson` 计数）；
 *   · `notes/notes.jsonl` 的 `anchor` → `reference/NOTES.html` 与课程页笔记计数
 *     （build-notes.js:7 / build-lessons.js:248-254）。
 *
 * 而本基线**没有可注入的纯重建入口**（只读核实，见回执 `rebuildEntries`）：
 *   · 包侧 `tools/build-lessons.js:56` 与（经 U04 委托的）`tools/pack-text.js` 现在
 *     都 require `./unify/*.cjs`，而 `lib/pack-template/tools/unify/` 由 U19 才生成
 *     ⇒ **MODULE_NOT_FOUND**（已登记回归 R1），跑不起来；
 *   · 宿主的 `lib/glossary-io.js#expectedGlossaryMarkdown` 是真实可用的**合成**函数，
 *     但它按**磁盘上的旧台账**合成（没有"传入新字节"的入参），且要 `createRequire`
 *     **执行**目标数据模块 —— 那与本卡 A08「JS 数据不执行」冲突；
 *   · 本卡明令"不通过执行旧包脚本补齐"。
 *
 * 所以这三类一律 `blocked-rebuild-missing`：**报出候选与原因，整次 apply 阻断**，
 * 而不是"猜一个改写"。迁移后产品两条读取路径的全链路只由 U17 实证（本卡不伪造）。
 *
 * ## JS 数据只做**安全静态读取**
 *
 * 禁止 `require` / `eval` / `Function` / 执行目标模块。本文件自带一个极小的
 * **tokenizer + 字面量递归下降解析器**，只认这些序列化形状：
 *   对象 / 数组 / 单双引号字符串 / **无插值**模板串 / 数字 / true|false|null /
 *   注释 / 尾逗号（真实台账里就有）；
 * 以及课程包数据文件的 **UMD 信封**：`(function (root, factory) { … })(…, function () { return <字面量>; })`。
 * 信封里出现白名单之外的 token（`fs` / `require` / `writeFileSync` / 任何自定义标识符…）
 * ⇒ **阻断**（"无法判定就不猜"，A08 的副作用探针正是打在这里）。信封内核之外
 * **一个 token 都不执行**，也不会被求值。
 *
 * ## 零时钟、零随机、零环境
 *
 * 计划、备份目录名、清单全部是输入的纯函数：同一次输入 → 逐字节相同的计划与
 * 备份内容（`planDigest` 可复算）。**不给任何目标台账加时间戳**（卡面硬约束）。
 */

const path = require('node:path')
const crypto = require('node:crypto')
const nodeFs = require('node:fs')

const identity = require('./identity.cjs')
const { makeFailure } = require('./errors.cjs')
const { readLedger } = require('./ledger-read.cjs')
const { planCommit, applyCommit } = require('./commit.cjs')

/** 迁移计划 schema（改形状必须换串） */
const MIGRATION_SCHEMA = 'whale-migration/1'

/** 备份清单 schema */
const BACKUP_SCHEMA = 'whale-migration-backup/1'

/** 备份根（包根下的隐藏目录；不进任何扫描集合） */
const BACKUP_ROOT = '.backup'

/** 历史平铺布局的兜底归属 —— 与 `lesson-map.js:74-75` / `pack-model.js` 的同名常量**同值**（核实，不是发明） */
const LEGACY_HALO = 'programming'
const LEGACY_POINT = 'spring-boot'

/** 未归课哨兵（lesson-map.js:219 `UNLESSON`）—— 它是**合法落点**，不是身份，原样保留 */
const UNLESSON = '未归课'

/** 形状类（顺序即文档顺序；`plan.classes` 按它排序） */
const SHAPE_CLASSES = Object.freeze([
	'bare-point',
	'point-lesson',
	'point-in-lesson-slot',
	'narrow-lesson-number',
	'wide-lesson-number',
	'bare-lesson-number',
	'display-name',
	'legacy-flat-path',
	'canonical-point',
	'canonical-lesson',
	'sentinel',
])

/** 阻断类（每一类都对应一条"为什么不归一"） */
const BLOCK_CLASSES = Object.freeze([
	'ambiguous-point',
	'unknown-point',
	'ambiguous-lesson',
	'orphan-lesson',
	'out-of-range-lesson',
	'unparsable-lesson',
	'unparsable-point',
	'index-problem',
	'blocked-rebuild-missing',
	'js-shape-unsafe',
	'version-chain-collision',
])

/* ── 台账 / 数据文件清单（真实落点，逐条核实过；见文件头表格） ───────────── */

/**
 * 写入口（权威源，改完不牵动本基线里的任何派生产物）。
 * `slots[].kind` ∈ point / lesson / display。
 */
const WRITABLE_FILES = Object.freeze([
	{ rel: 'learning-records/intake.jsonl', format: 'jsonl', slots: [{ field: 'point', kind: 'point' }] },
	{ rel: 'learning-records/goals.jsonl', format: 'jsonl', slots: [{ field: 'point', kind: 'point' }, { field: 'pointPath', kind: 'point' }] },
	{ rel: 'learning-records/evidence.jsonl', format: 'jsonl', slots: [{ field: 'lesson', kind: 'lesson' }] },
	{ rel: 'learning-records/adjustments.jsonl', format: 'jsonl', slots: [{ field: 'lesson', kind: 'lesson' }] },
])

/**
 * 只读核验的台账：`teaching.jsonl` 的身份是 `circle`（lib/teaching-io.js:235-238
 * 只认 kebab 圆圈 id 或 `*`）—— 已经是**单段**规范 id，没有可迁移的历史形状；
 * 但它必须是**读得懂**的合法台账，否则整次 apply 阻断（不拿"读不动"当"没有身份"）。
 */
const READONLY_LEDGERS = Object.freeze(['learning-records/teaching.jsonl'])

/**
 * 阻断文件（改它们必然让派生产物陈旧，而本基线没有可注入的纯重建入口）。
 * `reasonCode` 进 block 的 `error` 前缀，便于回执与判据机器读。
 */
const BLOCKED_FILES = Object.freeze([
	{
		rel: 'assets/glossary-data.js', format: 'js', dataShape: 'glossary',
		slots: [{ field: 'lesson', kind: 'display' }],
		reason: 'blocked-rebuild-missing: assets/glossary-data.js 的 lesson 是**显示名**（U-SPEC §2：显示文字与实体身份分开），'
			+ '改写成身份键会让派生产物 GLOSSARY.md 的「首次出现」列陈旧（lib/glossary.js:234-238）；'
			+ '本基线没有可注入的纯重建入口（包侧 build-glossary 走 require 执行数据模块且被禁令/回归 R1 挡住，'
			+ '宿主 lib/glossary-io.js#expectedGlossaryMarkdown 只能按磁盘旧台账合成）。整次 apply 阻断，产品读回归 U17。',
	},
	{
		rel: 'assets/questions-data.js', format: 'js', dataShape: 'questions',
		slots: [{ field: 'lesson', kind: 'display' }],
		reason: 'blocked-rebuild-missing: assets/questions-data.js 的 lesson 是**显示名**（lib/ask-io.js:644-650 落的是 label），'
			+ '它同时是 reference/NOTES.html 的分组键与课程页「DSH 笔记」卡片的答疑计数键（lib/render-inputs.js 的 q.lesson === lesson）；'
			+ '改它必须重建 NOTES.html 与全部课程页，而本基线两条重建入口（build-notes.js 经 pack-text、build-lessons.js）都因回归 R1 缺 ./unify/*.cjs。整次 apply 阻断，归 U17。',
	},
	{
		rel: 'assets/practice-data.js', format: 'js', dataShape: 'practice',
		slots: [],
		reason: 'blocked-rebuild-missing: assets/practice-data.js 是**纯派生产物**（lib/practice.js:50-141 由 state 快照算出，头部自己写着"手改会被覆盖"），'
			+ '它的 lessons 键是课次身份、byFile 键是旧平铺路径；改写它等于手改生成物，且下次 whale_practice 会用旧身份重写回来。'
			+ '正确修法是 U17 把生成侧的键换成规范身份后重新生成。整次 apply 阻断。',
	},
	{
		rel: 'notes/notes.jsonl', format: 'jsonl',
		slots: [{ field: 'anchor', kind: 'lesson' }],
		reason: 'blocked-rebuild-missing: notes/notes.jsonl 的 anchor 是**星图课次键**（lesson-map.js:16），'
			+ '它是 reference/NOTES.html 的分组键（build-notes.js:7,66）与课程页笔记计数键（build-lessons.js:248-254）；'
			+ '改它必须重建这两份派生产物，而它们在本基线都因回归 R1 缺 ./unify/*.cjs 跑不起来。整次 apply 阻断，归 U17。',
	},
])

/* ── 小工具（纯计算；无时钟 / 无随机 / 无 env） ───────────────────────── */

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

function textBytes(text) {
	return Buffer.from(String(text), 'utf8')
}

/** 内容摘要（**按字节**，与 commit 协议同口径） */
function digestOf(text) {
	return sha256(textBytes(text))
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function errMessage(e) {
	return e && e.message ? String(e.message) : String(e)
}

function sysCode(e) {
	return e && e.code ? String(e.code) : 'IO_ERROR'
}

function sysErr(e) {
	return { code: sysCode(e), message: errMessage(e) }
}

/** 路径是不是落在 root 内（按分量比，不做字符串前缀） */
function insideRoot(rootAbs, abs) {
	const rel = path.relative(rootAbs, abs)
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 包内相对路径（统一 `/` 分隔） */
function relOf(rootAbs, abs) {
	return path.relative(rootAbs, abs).split(path.sep).join('/')
}

function fsOf(opts, where) {
	const io = opts && opts.fs ? opts.fs : nodeFs
	if (!io || typeof io !== 'object') throw new TypeError(`${where}：fs 注入必须是对象`)
	for (const name of ['readFileSync', 'existsSync', 'readdirSync', 'statSync']) {
		if (typeof io[name] !== 'function') throw new TypeError(`${where}：fs 注入至少要提供 ${name}()`)
	}
	return io
}

/** 读文本（不存在 → exists:false；别的读取故障往上报，不折成"没有"） */
function readText(io, abs) {
	let buf
	try {
		if (!io.existsSync(abs)) return { exists: false, text: null, bytes: 0, digest: null, buf: null }
		buf = io.readFileSync(abs)
	} catch (e) {
		const s = sysErr(e)
		const err = new Error(`读不动（${s.code}）：${abs}`)
		err.code = s.code
		throw err
	}
	const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
	const back = textBytes(text)
	const original = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
	return {
		exists: true,
		text,
		buf: original,
		bytes: original.length,
		digest: sha256(original),
		// UTF-8 往返必须成立：不成立就没有"逐字节保留"这回事 → 调用方按阻断处理
		roundTrip: back.equals(original),
	}
}

/** 目录列表（存在才读；读不动返回 code） */
function listDir(io, abs) {
	try {
		if (!io.existsSync(abs)) return { ok: true, exists: false, names: [] }
		const st = io.statSync(abs)
		if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) return { ok: true, exists: false, names: [] }
		return { ok: true, exists: true, names: io.readdirSync(abs).map(String) }
	} catch (e) {
		return { ok: false, exists: false, names: [], ...sysErr(e) }
	}
}

function failure(kind, code, error, extra) {
	return makeFailure({ kind, code, error, ...(extra || {}) })
}

function badPlan(code, error, failureObj, extra) {
	return { ok: false, plan: null, code, error, failure: failureObj || failure('input', code, error), ...(extra || {}) }
}

/* ══════════════════════════════════════════════════════════════════════
 * §2 安全静态读取：tokenizer + 字面量解析（**不执行任何东西**）
 * ══════════════════════════════════════════════════════════════════════ */

/** 解析/形状失败（内部用；调用方把它转成 block） */
class ShapeError extends Error {
	constructor(message, at) {
		super(message)
		this.name = 'ShapeError'
		this.at = at === undefined ? null : at
	}
}

const PUNCT3 = ['===', '!==', '...']
const PUNCT2 = ['==', '!=', '&&', '||', '=>', '<=', '>=', '++', '--']
const PUNCT1 = '{}()[];,:.=!?<>+-*/%&|^~#@'

function isIdentStart(ch) {
	return /[A-Za-z_$]/.test(ch)
}

function isIdentPart(ch) {
	return /[A-Za-z0-9_$]/.test(ch)
}

/**
 * 把一段源码切成 token。**只切不解释**，任何不认识的字符都当场抛（不猜）。
 * token：{type:'string'|'template'|'number'|'ident'|'punct', value, start, end, quote?}
 */
function tokenize(text, where) {
	const tokens = []
	const n = text.length
	let i = 0
	while (i < n) {
		const ch = text[i]
		if (ch === '\uFEFF' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i += 1; continue }
		// 注释：整段吞掉（注释里的反引号/引号不进解析）
		if (ch === '/' && text[i + 1] === '/') {
			const end = text.indexOf('\n', i)
			i = end === -1 ? n : end
			continue
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2)
			if (end === -1) throw new ShapeError(`${where}：块注释没有收尾`, i)
			i = end + 2
			continue
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch
			let j = i + 1
			let value = ''
			let closed = false
			while (j < n) {
				const c = text[j]
				if (c === '\\') {
					const nx = text[j + 1]
					if (nx === undefined) throw new ShapeError(`${where}：字符串在转义处截断`, j)
					const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }
					if (nx === 'u') {
						const hex = text.slice(j + 2, j + 6)
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ShapeError(`${where}：\\u 转义不完整`, j)
						value += String.fromCharCode(parseInt(hex, 16))
						j += 6
						continue
					}
					if (nx === 'x') {
						const hex = text.slice(j + 2, j + 4)
						if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ShapeError(`${where}：\\x 转义不完整`, j)
						value += String.fromCharCode(parseInt(hex, 16))
						j += 4
						continue
					}
					value += Object.prototype.hasOwnProperty.call(map, nx) ? map[nx] : nx
					j += 2
					continue
				}
				if (quote === '`' && c === '$' && text[j + 1] === '{') {
					// 模板串插值 = 运行时求值 ⇒ 不可静态判定，直接拒
					throw new ShapeError(`${where}：模板串里有 \${…} 插值（不可静态判定，拒绝执行/求值）`, j)
				}
				if (c === quote) { closed = true; break }
				if (quote !== '`' && (c === '\n' || c === '\r')) {
					throw new ShapeError(`${where}：字符串里有裸换行（单/双引号串不允许）`, j)
				}
				value += c
				j += 1
			}
			if (!closed) throw new ShapeError(`${where}：字符串没有收尾`, i)
			tokens.push({ type: quote === '`' ? 'template' : 'string', value, quote, start: i, end: j + 1 })
			i = j + 1
			continue
		}
		if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] || ''))) {
			const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i))
			if (!m) throw new ShapeError(`${where}：数字写法不认识`, i)
			tokens.push({ type: 'number', value: m[0], start: i, end: i + m[0].length })
			i += m[0].length
			continue
		}
		if (isIdentStart(ch)) {
			let j = i + 1
			while (j < n && isIdentPart(text[j])) j += 1
			tokens.push({ type: 'ident', value: text.slice(i, j), start: i, end: j })
			i = j
			continue
		}
		const three = text.slice(i, i + 3)
		if (PUNCT3.includes(three)) { tokens.push({ type: 'punct', value: three, start: i, end: i + 3 }); i += 3; continue }
		const two = text.slice(i, i + 2)
		if (PUNCT2.includes(two)) { tokens.push({ type: 'punct', value: two, start: i, end: i + 2 }); i += 2; continue }
		if (PUNCT1.includes(ch)) { tokens.push({ type: 'punct', value: ch, start: i, end: i + 1 }); i += 1; continue }
		throw new ShapeError(`${where}：有不认识的字符 ${JSON.stringify(ch)}`, i)
	}
	return tokens
}

/**
 * 字面量递归下降解析（只认数据字面量；碰到表达式/调用/标识符就是**阻断**）。
 * 节点：{kind:'object', props:[{key,keyStart,keyEnd,value}], start, end}
 *       {kind:'array', items:[…]} / {kind:'string'|'template'|'number'|'boolean'|'null', value, start, end, quote?}
 */
function parseLiteral(tokens, startIndex, where) {
	let i = startIndex

	const peek = () => tokens[i]
	const expectPunct = (value) => {
		const t = peek()
		if (!t || t.type !== 'punct' || t.value !== value) {
			throw new ShapeError(`${where}：期望 ${JSON.stringify(value)}，实得 ${t ? JSON.stringify(t.value) : '结束'}`, t ? t.start : null)
		}
		i += 1
		return t
	}

	function parseValue() {
		const t = peek()
		if (!t) throw new ShapeError(`${where}：字面量意外结束`, null)
		if (t.type === 'punct' && t.value === '{') return parseObject()
		if (t.type === 'punct' && t.value === '[') return parseArray()
		if (t.type === 'string') { i += 1; return { kind: 'string', value: t.value, quote: t.quote, start: t.start, end: t.end } }
		if (t.type === 'template') { i += 1; return { kind: 'template', value: t.value, quote: '`', start: t.start, end: t.end } }
		if (t.type === 'number') { i += 1; return { kind: 'number', value: t.value, start: t.start, end: t.end } }
		if (t.type === 'ident') {
			if (t.value === 'true' || t.value === 'false') { i += 1; return { kind: 'boolean', value: t.value === 'true', start: t.start, end: t.end } }
			if (t.value === 'null') { i += 1; return { kind: 'null', value: null, start: t.start, end: t.end } }
			if (t.value === 'undefined') { i += 1; return { kind: 'null', value: null, start: t.start, end: t.end } }
			throw new ShapeError(`${where}：字面量里出现标识符 ${JSON.stringify(t.value)}（表达式/变量 = 需要执行，一律拒绝）`, t.start)
		}
		throw new ShapeError(`${where}：字面量里出现 ${JSON.stringify(t.value)}（不是数据字面量）`, t.start)
	}

	function parseObject() {
		const open = expectPunct('{')
		const props = []
		for (;;) {
			let t = peek()
			if (!t) throw new ShapeError(`${where}：对象没有收尾`, open.start)
			if (t.type === 'punct' && t.value === '}') { i += 1; return { kind: 'object', props, start: open.start, end: t.end } }
			let key = null
			let keyStart = null
			let keyEnd = null
			if (t.type === 'string' || t.type === 'template') { key = t.value; keyStart = t.start; keyEnd = t.end; i += 1 }
			else if (t.type === 'ident') { key = t.value; keyStart = t.start; keyEnd = t.end; i += 1 }
			else if (t.type === 'number') { key = t.value; keyStart = t.start; keyEnd = t.end; i += 1 }
			else throw new ShapeError(`${where}：对象的键不是字面量`, t.start)
			expectPunct(':')
			const value = parseValue()
			props.push({ key: String(key), keyStart, keyEnd, value })
			t = peek()
			if (t && t.type === 'punct' && t.value === ',') { i += 1; continue }
			if (t && t.type === 'punct' && t.value === '}') { i += 1; return { kind: 'object', props, start: open.start, end: t.end } }
			throw new ShapeError(`${where}：对象成员之间既不是 , 也不是 }`, t ? t.start : null)
		}
	}

	function parseArray() {
		const open = expectPunct('[')
		const items = []
		for (;;) {
			const t = peek()
			if (!t) throw new ShapeError(`${where}：数组没有收尾`, open.start)
			if (t.type === 'punct' && t.value === ']') { i += 1; return { kind: 'array', items, start: open.start, end: t.end } }
			items.push(parseValue())
			const t2 = peek()
			if (t2 && t2.type === 'punct' && t2.value === ',') { i += 1; continue }
			if (t2 && t2.type === 'punct' && t2.value === ']') { i += 1; return { kind: 'array', items, start: open.start, end: t2.end } }
			throw new ShapeError(`${where}：数组项之间既不是 , 也不是 ]`, t2 ? t2.start : null)
		}
	}

	const node = parseValue()
	return { node, nextIndex: i }
}

/**
 * UMD 信封白名单 —— 出现白名单之外的标识符 / 标点 = 信封里有代码。
 * 这是 A08 的落点：`fs.writeFileSync(...)` / `require(...)` / `root.PWNED = 1`
 * 里的 `fs` / `writeFileSync` / `require` / `PWNED` 都不在表里 ⇒ 阻断。
 */
const ENVELOPE_IDENTS = Object.freeze([
	'function', 'if', 'else', 'typeof', 'return',
	'module', 'exports', 'root', 'factory', 'globalThis', 'this', 'self', 'window', 'define',
	'undefined', 'use', 'strict',
	'QUESTIONS', 'GLOSSARY', 'PRACTICE_DATA',
])
const ENVELOPE_PUNCT = Object.freeze(['(', ')', '{', '}', '[', ']', ';', '=', '.', ',', '===', '==', '!==', '!=', '!', '&&', '||', '?', ':'])
const ENVELOPE_STRINGS = Object.freeze(['use strict', 'object', 'undefined', 'globalThis'])

/**
 * 读一个课程包数据文件（UMD + `return <字面量>`）。
 *
 * @returns {{ok:true, node:object, tokens:Array, returnIndex:number}|{ok:false, error:string, at:number|null}}
 */
function readDataLiteral(text, where) {
	let tokens
	try {
		tokens = tokenize(text, where)
	} catch (e) {
		if (e instanceof ShapeError) return { ok: false, error: e.message, at: e.at }
		throw e
	}
	const returns = []
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i].type === 'ident' && tokens[i].value === 'return') returns.push(i)
	}
	if (returns.length !== 1) {
		return { ok: false, error: `${where}：UMD 信封里必须恰好有一个 return（实得 ${returns.length} 个）—— 结构不可判定`, at: null }
	}
	const retIdx = returns[0]
	// ① 信封头：只许白名单（这是"不执行、也不许有会执行的代码"的机器判据）
	for (let i = 0; i < retIdx; i += 1) {
		const t = tokens[i]
		if (t.type === 'ident') {
			if (!ENVELOPE_IDENTS.includes(t.value)) {
				return { ok: false, error: `${where}：UMD 信封里出现白名单外的标识符 ${JSON.stringify(t.value)}（疑似会执行的代码，拒绝）`, at: t.start }
			}
			continue
		}
		if (t.type === 'punct') {
			if (!ENVELOPE_PUNCT.includes(t.value)) {
				return { ok: false, error: `${where}：UMD 信封里出现白名单外的符号 ${JSON.stringify(t.value)}（拒绝）`, at: t.start }
			}
			continue
		}
		if (t.type === 'string' || t.type === 'template') {
			if (!ENVELOPE_STRINGS.includes(t.value)) {
				return { ok: false, error: `${where}：UMD 信封里出现白名单外的字符串 ${JSON.stringify(t.value)}（拒绝）`, at: t.start }
			}
			continue
		}
		return { ok: false, error: `${where}：UMD 信封里出现数字/其它字面量（拒绝）`, at: t.start }
	}
	// ② return 之后必须直接是数据字面量
	let parsed
	try {
		parsed = parseLiteral(tokens, retIdx + 1, where)
	} catch (e) {
		if (e instanceof ShapeError) return { ok: false, error: e.message, at: e.at }
		throw e
	}
	// ③ 尾巴：只许 `;` `}` `)` 收信封（`return {…};});` / `return {…};};` / `return {…};`）
	const tail = tokens.slice(parsed.nextIndex)
	for (const t of tail) {
		if (t.type !== 'punct' || ![';', '}', ')'].includes(t.value)) {
			return { ok: false, error: `${where}：return 之后还有别的 token ${JSON.stringify(t.value)}（结构不可判定，拒绝）`, at: t.start }
		}
	}
	if (!tail.length || tail[tail.length - 1].value !== ';') {
		return { ok: false, error: `${where}：return 之后没有用 ; 收尾（结构不可判定，拒绝）`, at: null }
	}
	// ④ 括号必须**整份文件**配平：信封真的闭合了（只数尾巴会漏掉头部的开括号，反过来也不行）
	let depth = 0
	for (const t of tokens) {
		if (t.type !== 'punct') continue
		if (t.value === '{' || t.value === '(' || t.value === '[') depth += 1
		else if (t.value === '}' || t.value === ')' || t.value === ']') {
			depth -= 1
			if (depth < 0) return { ok: false, error: `${where}：括号不配平（多出来一个 ${t.value}）`, at: t.start }
		}
	}
	if (depth !== 0) return { ok: false, error: `${where}：信封没有配平闭合（还差 ${depth} 个）`, at: null }
	return { ok: true, node: parsed.node, tokens, returnIndex: retIdx, nextIndex: parsed.nextIndex }
}

/** 解析一行 JSONL（**不执行**；只认 JSON 值，且必须是对象） */
function parseJsonLine(text, where) {
	const tokens = tokenize(text, where)
	const parsed = parseLiteral(tokens, 0, where)
	if (parsed.nextIndex !== tokens.length) {
		throw new ShapeError(`${where}：一行里有多余 token（不是单个 JSON 值）`, tokens[parsed.nextIndex] ? tokens[parsed.nextIndex].start : null)
	}
	if (parsed.node.kind !== 'object') throw new ShapeError(`${where}：一条记录必须是对象`, parsed.node.start)
	return parsed.node
}

/** 值节点 → 字符串（slot 只认字符串） */
function stringOfNode(node) {
	if (!node) return null
	if (node.kind === 'string' || node.kind === 'template') return node.value
	return null
}

/* ── 字符串字面量渲染（保持原引号风格；只转义必要字符） ─────────────────── */

function renderStringLiteral(value, quote) {
	const s = String(value)
	if (quote === '"') return JSON.stringify(s)
	if (quote === '`') return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'
	return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'"
}

/** 按编辑表重写一段文本（编辑**降序**应用；越界/重叠一律拒） */
function applyEdits(text, edits) {
	const sorted = edits.slice().sort((a, b) => b.start - a.start)
	let out = text
	let lastStart = Infinity
	for (const e of sorted) {
		if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start || e.end > text.length) {
			throw new ShapeError(`编辑区间不合法：${JSON.stringify({ start: e.start, end: e.end })}`, e.start)
		}
		if (e.end > lastStart) throw new ShapeError('编辑区间重叠（拒绝写出可疑文本）', e.start)
		out = out.slice(0, e.start) + e.text + out.slice(e.end)
		lastStart = e.start
	}
	return out
}

/* ══════════════════════════════════════════════════════════════════════
 * §3 身份索引（圆圈 / 知识点 / 课次）—— 归属的唯一依据：lessons/ 目录结构
 * ══════════════════════════════════════════════════════════════════════ */

/** 课次显示名（与 lesson-map.js:31-42 / pack-model.js:51-64 同一条换算，只读） */
function labelOf(pointMeta, number) {
	const display = Number(number) - (Number(pointMeta.fileBase) || 0)
	return pointMeta.label ? `${pointMeta.label} 第${display}课` : `第${display}课`
}

/**
 * 建身份索引。**只读**（readFileSync / readdirSync / statSync）。
 *
 * 归属规则（与 lesson-map.js:84-120 同一条，不发明新规则）：
 *   `lessons/<circle>/<point>/NNNN-*.html` → circle/point 就是路径上那两层；
 *   `lessons/NNNN-*.html`（旧平铺） → point 是 LEGACY_POINT，circle 再由
 *   "哪个圆圈有这个知识点" 唯一确定（0 个 = 缺归属，≥2 个 = 歧义 → 阻断）。
 */
function buildIndex(rootAbs, io) {
	const problems = []
	const lessonDirs = listDir(io, path.join(rootAbs, 'lessons'))
	if (!lessonDirs.ok) {
		problems.push({ file: 'lessons', location: 'readdir', from: null, candidates: [], error: `index-problem: lessons/ 读不动（${lessonDirs.code}）：${lessonDirs.message}`, cls: 'index-problem' })
	}

	const points = []
	const circles = []

	/** 一个 (circle, point) 目录 → point 记录 + 该目录下的课程页号 */
	const readPointDir = (circle, point, dirAbs) => {
		let canon
		try {
			canon = identity.pointKey(circle, point)
		} catch (e) {
			problems.push({ file: relOf(rootAbs, dirAbs), location: 'id', from: `${circle}/${point}`, candidates: [], error: `index-problem: 目录名不是合法身份组成部分（${errMessage(e)}）`, cls: 'index-problem' })
			return null
		}
		const pf = path.join(dirAbs, 'point.json')
		const meta = { circle, point, label: '', fileBase: 0, hasPointJson: false }
		try {
			const got = readText(io, pf)
			if (got.exists) {
				const doc = JSON.parse(String(got.text).replace(/^\uFEFF/, ''))
				if (!isPlainObject(doc)) throw new Error('不是对象')
				meta.hasPointJson = true
				meta.label = String(doc.label == null ? '' : doc.label).trim()
				meta.fileBase = Number(doc.fileBase) || 0
				if (typeof doc.point === 'string' && doc.point.trim() && doc.point.trim() !== point) {
					problems.push({
						file: relOf(rootAbs, pf), location: 'point', from: String(doc.point), candidates: [point],
						error: `index-problem: point.json 的 point（${doc.point}）与目录名（${point}）不一致 —— 归属不可判定`, cls: 'index-problem',
					})
				}
			}
		} catch (e) {
			problems.push({
				file: relOf(rootAbs, pf), location: 'json', from: null, candidates: [],
				error: `index-problem: point.json 读不动/不是合法 JSON（${errMessage(e)}）—— 归属不可判定`, cls: 'index-problem',
			})
		}
		meta.key = canon
		return meta
	}

	for (const circleName of [...lessonDirs.names].sort()) {
		if (circleName === 'src' || circleName.startsWith('.')) continue
		const circleAbs = path.join(rootAbs, 'lessons', circleName)
		let st = null
		try { st = io.statSync(circleAbs) } catch { st = null }
		if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) continue
		let valid = null
		try { valid = identity.pointKey(circleName, 'p') } catch { valid = null }
		if (!valid) continue
		circles.push(circleName)
		const subs = listDir(io, circleAbs)
		for (const pointName of [...subs.names].sort()) {
			if (pointName.startsWith('.')) continue
			const dirAbs = path.join(circleAbs, pointName)
			let pst = null
			try { pst = io.statSync(dirAbs) } catch { pst = null }
			if (!pst || typeof pst.isDirectory !== 'function' || !pst.isDirectory()) continue
			const meta = readPointDir(circleName, pointName, dirAbs)
			if (meta) points.push(meta)
		}
	}

	/** point 名 → 候选圆圈（多候选 = 歧义，0 = 缺归属） */
	const pointCircles = new Map()
	for (const p of points) {
		const list = pointCircles.get(p.point) || []
		list.push(p.circle)
		pointCircles.set(p.point, list)
	}
	for (const [name, list] of pointCircles) pointCircles.set(name, [...new Set(list)].sort())

	const pointMetaByKey = new Map()
	for (const p of points) pointMetaByKey.set(`${p.circle}/${p.point}`, p)

	/* 课程页：lessons/ 与 lessons/src/ 都扫（src 是作者态镜像，不是产物页，但同样证明"这门课存在"） */
	const lessons = new Map() // `${point}/${number}` → lesson（circle 待归属）
	const addPage = (rel, circleHint) => {
		const parts = rel.split('/')
		const file = parts[parts.length - 1]
		const m = /^(\d{4})-(.+)\.html$/.exec(file)
		if (!m) return
		const number = m[1]
		let circle = circleHint
		let point = null
		let flat = false
		if (parts.length >= 4 && parts[0] === 'lessons' && parts[1] === 'src') {
			circle = parts[2]
			point = parts[3]
		} else if (parts.length === 2 && parts[0] === 'lessons') {
			flat = true
			point = LEGACY_POINT
			if (!circle) circle = LEGACY_HALO
		} else if (parts.length >= 3) {
			point = parts[parts.length - 2]
			circle = parts.length >= 4 ? parts[parts.length - 3] : circle
		}
		if (!point) return
		const key = `${point}/${number}`
		const prev = lessons.get(key) || { point, number, circle: null, page: null, src: null, flat: false }
		if (flat) { prev.flat = true; if (!prev.circle) prev.circle = circle }
		if (parts[1] === 'src') prev.src = rel
		else prev.page = rel
		if (!prev.circle && circle) prev.circle = circle
		lessons.set(key, prev)
	}

	const walkLessons = (dirAbs, relBase) => {
		const got = listDir(io, dirAbs)
		if (!got.ok) {
			problems.push({ file: relBase || 'lessons', location: 'readdir', from: null, candidates: [], error: `index-problem: ${relBase || 'lessons'}/ 读不动（${got.code}）`, cls: 'index-problem' })
			return
		}
		for (const name of [...got.names].sort()) {
			if (name.startsWith('.')) continue
			const abs = path.join(dirAbs, name)
			const rel = relBase ? `${relBase}/${name}` : name
			let st = null
			try { st = io.statSync(abs) } catch { st = null }
			if (!st) continue
			if (typeof st.isDirectory === 'function' && st.isDirectory()) { walkLessons(abs, rel); continue }
			addPage(rel)
		}
	}
	if (lessonDirs.ok && lessonDirs.exists) walkLessons(path.join(rootAbs, 'lessons'), 'lessons')

	/* EXPECT.json 的 `lessons[].id`（point/NNNN）也是"这门课存在"的权威声明（lesson-map.js:140-171 同一源） */
	const declared = new Map()
	const readExpectNodes = (dirAbs, depth) => {
		if (depth > 4) return
		const got = listDir(io, dirAbs)
		if (!got.ok) return
		if (got.names.includes('EXPECT.json')) {
			const file = path.join(dirAbs, 'EXPECT.json')
			try {
				const text = readText(io, file).text
				const doc = JSON.parse(String(text).replace(/^\uFEFF/, ''))
				for (const l of Array.isArray(doc && doc.lessons) ? doc.lessons : []) {
					if (!l || typeof l.id !== 'string') continue
					const m = /^(.+)\/(\d{4})$/.exec(l.id)
					if (!m) continue
					declared.set(`${m[1]}/${m[2]}`, { point: m[1], number: m[2], expect: relOf(rootAbs, file) })
				}
			} catch { /* 读不动就不采信（与 lesson-map 一致：冲突检查会暴露） */ }
		}
		for (const name of got.names) {
			if (name.startsWith('.') || name === 'node_modules') continue
			const abs = path.join(dirAbs, name)
			let st = null
			try { st = io.statSync(abs) } catch { st = null }
			if (st && typeof st.isDirectory === 'function' && st.isDirectory()) readExpectNodes(abs, depth + 1)
		}
	}
	const codeDir = path.join(rootAbs, 'code')
	if (io.existsSync(codeDir)) readExpectNodes(codeDir, 1)

	for (const [key, d] of declared) if (!lessons.has(key)) lessons.set(key, { point: d.point, number: d.number, circle: null, page: null, src: null, flat: false, expect: d.expect })

	/* 归属圆圈：路径给了就用路径；没给（旧平铺 / 只有 EXPECT 声明）就按知识点唯一圆圈定 */
	const finalized = []
	for (const key of [...lessons.keys()].sort()) {
		const l = lessons.get(key)
		let circle = l.circle
		if (!circle) {
			const cands = pointCircles.get(l.point) || []
			if (cands.length === 1) circle = cands[0]
			else if (cands.length === 0) {
				problems.push({
					file: l.page || l.src || l.expect || key, location: 'circle', from: l.point, candidates: [],
					error: `index-problem: 课次 ${l.point}/${l.number} 没有归属圆圈（没有任何 lessons/<circle>/${l.point}/point.json）`, cls: 'index-problem',
				})
				continue
			} else {
				problems.push({
					file: l.page || l.src || l.expect || key, location: 'circle', from: l.point, candidates: cands.map((c) => `${c}/${l.point}`),
					error: `index-problem: 课次 ${l.point}/${l.number} 的圆圈有 ${cands.length} 个候选（${cands.join(' / ')}）—— 归属歧义`, cls: 'index-problem',
				})
				continue
			}
		}
		let canon
		try {
			canon = identity.lessonKey(circle, l.point, Number(l.number))
		} catch (e) {
			problems.push({ file: l.page || key, location: 'id', from: `${circle}/${l.point}/${l.number}`, candidates: [], error: `index-problem: 课次身份不合法（${errMessage(e)}）`, cls: 'index-problem' })
			continue
		}
		const meta = pointMetaByKey.get(`${circle}/${l.point}`) || { label: '', fileBase: 0 }
		finalized.push({
			circle, point: l.point, number: Number(l.number), key: canon,
			label: labelOf(meta, Number(l.number)),
			page: l.page || null, src: l.src || null, flat: l.flat === true,
		})
	}

	finalized.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

	const byKey = new Map()
	const byLabelMap = new Map()
	const byPointConcrete = new Map() // `${circle}/${point}` → [lesson]
	const byNumber = new Map()
	for (const l of finalized) {
		byKey.set(l.key, l)
		const labelList = byLabelMap.get(l.label) || []
		labelList.push(l)
		byLabelMap.set(l.label, labelList)
		const pl = byPointConcrete.get(`${l.circle}/${l.point}`) || []
		pl.push(l)
		byPointConcrete.set(`${l.circle}/${l.point}`, pl)
		const nl = byNumber.get(l.number) || []
		nl.push(l)
		byNumber.set(l.number, nl)
	}

	const index = {
		circles: [...new Set(circles)].sort(),
		points: points.map((p) => ({ circle: p.circle, point: p.point, label: p.label, fileBase: p.fileBase })).sort((a, b) => (a.circle + '/' + a.point < b.circle + '/' + b.point ? -1 : 1)),
		lessons: finalized.map((l) => ({ key: l.key, circle: l.circle, point: l.point, number: l.number, label: l.label, page: l.page, src: l.src, flat: l.flat })),
		byKey,
		byLabel: byLabelMap,
		byPointConcrete,
		byNumber,
		pointCircles,
		problems,
	}
	return index
}

/** 索引的规范 JSON（进 plan.indexDigest；不含 Map） */
function indexDigestOf(index) {
	const view = {
		circles: index.circles,
		points: index.points,
		lessons: index.lessons,
	}
	return digestOf(JSON.stringify(view))
}

/* ══════════════════════════════════════════════════════════════════════
 * §4 形状分类：历史写法 → 规范身份（或阻断）
 * ══════════════════════════════════════════════════════════════════════ */

function block(cls, candidates, error) {
	return { ok: false, cls, candidates: candidates.slice(), error }
}

/** 知识点槽：只认 `circle/point`；裸点靠圆圈唯一归属补齐 */
function resolvePointValue(value, index) {
	if (typeof value !== 'string' || value.trim() === '') return { ok: false, skip: true }
	const text = value
	if (text !== text.trim()) return block('unparsable-point', [], `unparsable-point: 值两侧带空白（${JSON.stringify(text)}）—— 不猜，阻断`)
	const parsed = identity.parsePointKey(text)
	if (parsed.ok) {
		const { circle, point } = parsed.value
		if (!index.circles.includes(circle)) return block('unknown-point', [], `unknown-point: 圆圈 ${JSON.stringify(circle)} 不在 lessons/ 里（${JSON.stringify(text)}）`)
		const pl = index.byPointConcrete.get(`${circle}/${point}`)
		if (!pl || !pl.length) return block('unknown-point', [], `unknown-point: 知识点 ${JSON.stringify(circle + '/' + point)} 没有任何课程/目录（${JSON.stringify(text)}）`)
		return { ok: true, key: text, cls: 'canonical-point', changed: false }
	}
	const segs = text.split('/')
	if (segs.length === 2) return block('unparsable-point', [], `unparsable-point: ${errMessage(new identity.IdentityError(parsed.failure))}（${JSON.stringify(text)}）`)
	if (segs.length > 2) return block('unparsable-point', [], `unparsable-point: 知识点键必须两段（circle/point），实得 ${segs.length} 段（${JSON.stringify(text)}）`)
	// 裸点：归属圆圈必须唯一
	const cands = index.pointCircles.get(text) || []
	if (cands.length === 0) return block('unknown-point', [], `unknown-point: 裸知识点 ${JSON.stringify(text)} 在 lessons/ 里找不到归属圆圈`)
	if (cands.length > 1) {
		return block('ambiguous-point', cands.map((c) => `${c}/${text}`), `ambiguous-point: 裸知识点 ${JSON.stringify(text)} 有 ${cands.length} 个圆圈候选（${cands.join(' / ')}）—— 不猜`)
	}
	let canon
	try {
		canon = identity.pointKey(cands[0], text)
	} catch (e) {
		return block('unparsable-point', [], `unparsable-point: 补齐圆圈后仍不合法（${errMessage(e)}）`)
	}
	const pl = index.byPointConcrete.get(`${cands[0]}/${text}`)
	if (!pl || !pl.length) return block('unknown-point', [], `unknown-point: 知识点 ${canon} 没有任何课程/目录`)
	return { ok: true, key: canon, cls: 'bare-point', changed: canon !== text }
}

/** 课次槽：circle/point/NNNN（含 1–5 位历史课号 / point/课号 / 两段点键 / 裸课号 / 显示名） */
function resolveLessonValue(value, index) {
	if (typeof value !== 'string' || value.trim() === '') return { ok: false, skip: true }
	const text = value
	if (text === UNLESSON) return { ok: true, key: text, cls: 'sentinel', changed: false }
	if (text !== text.trim()) return block('unparsable-lesson', [], `unparsable-lesson: 值两侧带空白（${JSON.stringify(text)}）—— 不猜，阻断`)

	const canonical = identity.parseLessonKey(text)
	if (canonical.ok) {
		const { circle, point, number } = canonical.value
		const key = text
		if (!index.byKey.has(key)) {
			const cands = candidatesForLesson(index, circle, point, number)
			return block('orphan-lesson', cands, `orphan-lesson: ${JSON.stringify(key)} 在 lessons/ 与 EXPECT.json 里都没有对应课程（孤儿引用；不删、不猜）`)
		}
		return { ok: true, key, cls: 'canonical-lesson', changed: false }
	}

	const segs = text.split('/')
	if (segs.length === 3) {
		const [circle, point, numText] = segs
		let pointParsed
		try {
			pointParsed = identity.pointKey(circle, point)
		} catch (e) {
			return block('unparsable-lesson', [], `unparsable-lesson: ${errMessage(e)}（${JSON.stringify(text)}）`)
		}
		const num = lessonNumberFromSegment(numText)
		if (!num.ok) return block(num.cls, num.candidates, num.error)
		if (!index.circles.includes(circle)) return block('unknown-point', [], `unknown-point: 圆圈 ${JSON.stringify(circle)} 不在 lessons/ 里`)
		const key = identity.lessonKey(circle, point, num.number)
		if (!index.byKey.has(key)) {
			return block('orphan-lesson', candidatesForLesson(index, circle, point, num.number), `orphan-lesson: ${JSON.stringify(key)} 没有对应课程（${JSON.stringify(text)}）`)
		}
		const cls = numText.length < 4 ? 'narrow-lesson-number' : 'wide-lesson-number'
		return { ok: true, key, cls, changed: key !== text }
	}

	if (segs.length === 2) {
		const [head, tail] = segs
		if (/^[0-9]+$/.test(tail)) {
			// `point/课号`（缺圆圈）
			const num = lessonNumberFromSegment(tail)
			if (!num.ok) return block(num.cls, num.candidates, num.error)
			const cands = index.pointCircles.get(head) || []
			if (cands.length === 0) return block('unknown-point', [], `unknown-point: 知识点 ${JSON.stringify(head)} 在 lessons/ 里找不到归属圆圈（${JSON.stringify(text)}）`)
			if (cands.length > 1) return block('ambiguous-point', cands.map((c) => `${c}/${head}/${num.number}`), `ambiguous-point: 知识点 ${JSON.stringify(head)} 有 ${cands.length} 个圆圈候选（${cands.join(' / ')}）—— 不猜`)
			const key = identity.lessonKey(cands[0], head, num.number)
			if (!index.byKey.has(key)) {
				return block('orphan-lesson', candidatesForLesson(index, cands[0], head, num.number), `orphan-lesson: ${JSON.stringify(key)} 没有对应课程（${JSON.stringify(text)}）`)
			}
			return { ok: true, key, cls: 'point-lesson', changed: key !== text }
		}
		// `circle/point` 被放在**课程位**（两段点键当课次用）——运行态明文拒绝的形状
		const asPoint = identity.parsePointKey(text)
		if (!asPoint.ok) return block('unparsable-lesson', [], `unparsable-lesson: 既不是 circle/point/NNNN 也不是 circle/point（${JSON.stringify(text)}）`)
		const { circle, point } = asPoint.value
		if (!index.circles.includes(circle)) return block('unknown-point', [], `unknown-point: 圆圈 ${JSON.stringify(circle)} 不在 lessons/ 里`)
		const lessonsOfPoint = index.byPointConcrete.get(`${circle}/${point}`) || []
		if (lessonsOfPoint.length === 0) {
			return block('orphan-lesson', [], `orphan-lesson: 点键 ${JSON.stringify(text)} 落在课程位，但该知识点没有任何已学课程（缺归属）`)
		}
		if (lessonsOfPoint.length > 1) {
			return block('ambiguous-lesson', lessonsOfPoint.map((l) => l.key), `ambiguous-lesson: 点键 ${JSON.stringify(text)} 落在课程位，该知识点有 ${lessonsOfPoint.length} 门课程（${lessonsOfPoint.map((l) => l.key).join(' / ')}）—— 点键不能扩展成多门已学课程`)
		}
		return { ok: true, key: lessonsOfPoint[0].key, cls: 'point-in-lesson-slot', changed: lessonsOfPoint[0].key !== text }
	}

	if (segs.length === 1) {
		if (/^[0-9]+$/.test(text)) {
			// 只有课号（practice-data v1 的键形状）
			const num = lessonNumberFromSegment(text)
			if (!num.ok) return block(num.cls, num.candidates, num.error)
			const cands = index.byNumber.get(num.number) || []
			if (cands.length === 0) return block('orphan-lesson', [], `orphan-lesson: 裸课号 ${JSON.stringify(text)} 没有对应课程`)
			if (cands.length > 1) return block('ambiguous-lesson', cands.map((l) => l.key), `ambiguous-lesson: 裸课号 ${JSON.stringify(text)} 在 ${cands.length} 个知识点下都有（${cands.map((l) => l.key).join(' / ')}）—— 不猜`)
			return { ok: true, key: cands[0].key, cls: 'bare-lesson-number', changed: cands[0].key !== text }
		}
		const labelHits = index.byLabel.get(text) || []
		if (labelHits.length === 1) return { ok: true, key: labelHits[0].key, cls: 'display-name', changed: labelHits[0].key !== text, displayText: text }
		if (labelHits.length > 1) return block('ambiguous-lesson', labelHits.map((l) => l.key), `ambiguous-lesson: 显示名 ${JSON.stringify(text)} 同时对应 ${labelHits.length} 门课（${labelHits.map((l) => l.key).join(' / ')}）—— 不猜`)
		// 不是显示名：可能是裸知识点被放进课程位
		const pointCands = index.pointCircles.get(text) || []
		if (pointCands.length) {
			const out = []
			for (const c of pointCands) out.push(...(index.byPointConcrete.get(`${c}/${text}`) || []))
			if (out.length === 1) return { ok: true, key: out[0].key, cls: 'point-in-lesson-slot', changed: out[0].key !== text }
			if (out.length === 0) return block('orphan-lesson', [], `orphan-lesson: 裸知识点 ${JSON.stringify(text)} 落在课程位，但没有任何已学课程`)
			return block('ambiguous-lesson', out.map((l) => l.key), `ambiguous-lesson: 裸知识点 ${JSON.stringify(text)} 落在课程位且有 ${out.length} 门课程 —— 点键不能扩展成多门已学课程`)
		}
		return block('unparsable-lesson', [], `unparsable-lesson: 既不是课次键、显示名，也不是已知知识点（${JSON.stringify(text)}）`)
	}

	return block('unparsable-lesson', [], `unparsable-lesson: 段数 ${segs.length} 不可判定（${JSON.stringify(text)}）`)
}

/** 课号段：1–5 位历史写法归一；0 / >9999 越界；>5 位不可判定 */
function lessonNumberFromSegment(text) {
	if (!/^[0-9]+$/.test(text)) {
		return { ok: false, cls: 'unparsable-lesson', candidates: [], error: `unparsable-lesson: 课号段不是十进制数字（${JSON.stringify(text)}）` }
	}
	if (text.length > 5) {
		return { ok: false, cls: 'unparsable-lesson', candidates: [], error: `unparsable-lesson: 课号段 ${JSON.stringify(text)} 是 ${text.length} 位，超出"1–5 位"历史形状，形状不可判定` }
	}
	const number = Number(text)
	if (!Number.isSafeInteger(number) || number < identity.LESSON_NUMBER_MIN || number > identity.LESSON_NUMBER_MAX) {
		return {
			ok: false, cls: 'out-of-range-lesson', candidates: [],
			error: `out-of-range-lesson: 课号 ${JSON.stringify(text)} 折算成 ${number}，超出 ${identity.LESSON_NUMBER_MIN}–${identity.LESSON_NUMBER_MAX}（越界不截断、不取模、不自动减 fileBase）`,
		}
	}
	return { ok: true, number }
}

/** 孤儿场景下给出"同知识点现有课次"作为 candidates（给人看的定位线索，不当成可自动选的候选） */
function candidatesForLesson(index, circle, point, number) {
	const list = index.byPointConcrete.get(`${circle}/${point}`) || []
	return list.map((l) => l.key).sort()
}

/* ══════════════════════════════════════════════════════════════════════
 * §5 引用位置扫描（台账 jsonl / 数据 js）
 * ══════════════════════════════════════════════════════════════════════ */

/** 解析 JSONL 文本 → 行表（保留原始行尾，便于逐字节保留未改动的字节） */
function splitLines(text) {
	const out = []
	let i = 0
	while (i <= text.length) {
		const nl = text.indexOf('\n', i)
		if (nl === -1) {
			out.push({ body: text.slice(i), eol: '' })
			break
		}
		let end = nl
		let eol = '\n'
		if (end > i && text[end - 1] === '\r') { end -= 1; eol = '\r\n' }
		out.push({ body: text.slice(i, end), eol })
		i = nl + 1
	}
	return out
}

/**
 * 扫描一个 JSONL 台账里的身份槽。
 * @returns {{ok:true, sites:Array}|{ok:false, error:string, at:number|null}}
 *   site = {location, from, start, end, quote, cls, result}
 */
function scanJsonl(text, spec, where) {
	const lines = splitLines(text)
	const sites = []
	for (let li = 0; li < lines.length; li += 1) {
		const body = lines[li].body
		if (!body.trim()) continue
		let node
		try {
			node = parseJsonLine(body, `${where} 第 ${li + 1} 行`)
		} catch (e) {
			if (e instanceof ShapeError) return { ok: false, error: e.message, at: e.at }
			throw e
		}
		for (const slot of spec.slots) {
			const prop = node.props.find((p) => p.key === slot.field)
			if (!prop) continue
			const value = stringOfNode(prop.value)
			if (value === null) continue
			sites.push({
				location: `L${li + 1}:${slot.field}`,
				from: value,
				line: li + 1,
				field: slot.field,
				kind: slot.kind,
				start: prop.value.start,
				end: prop.value.end,
				quote: prop.value.quote,
				nodeKind: prop.value.kind,
			})
		}
	}
	return { ok: true, sites, lines }
}

/** 在 JS 字面量里按 dataShape 逐个取身份槽 */
function scanJsLiteral(node, spec, where) {
	const sites = []
	const own = (obj) => (obj.kind === 'object' ? obj.props : [])
	const find = (obj, key) => own(obj).find((p) => p.key === key)

	if (spec.dataShape === 'glossary' || spec.dataShape === 'questions') {
		for (const entry of own(node)) {
			if (entry.value.kind !== 'object') {
				return { ok: false, error: `${where}：条目 ${JSON.stringify(entry.key)} 的值不是对象（数据形状不认识）`, at: entry.value.start }
			}
			for (const slot of spec.slots) {
				const prop = find(entry.value, slot.field)
				if (!prop) continue
				const value = stringOfNode(prop.value)
				if (value === null) continue
				sites.push({
					location: `${entry.key}.${slot.field}`, from: value, kind: slot.kind,
					start: prop.value.start, end: prop.value.end, quote: prop.value.quote, nodeKind: prop.value.kind,
				})
			}
		}
		return { ok: true, sites }
	}

	if (spec.dataShape === 'practice') {
		const lessonsProp = find(node, 'lessons')
		if (lessonsProp && lessonsProp.value.kind === 'object') {
			for (const entry of own(lessonsProp.value)) {
				// 键本身是课次身份（v1 = 课号，v2 = point/NNNN）；`#key` 与 `.id` 要分开命名，
				// 否则同一个引用位置会长出两条处置（那会被去重闸当成"结构不可判定"）
				const keyNode = { start: entry.keyStart, end: entry.keyEnd }
				sites.push({
					location: `lessons[${entry.key}]#key`, from: entry.key, kind: 'lesson',
					start: keyNode.start, end: keyNode.end, quote: null, nodeKind: 'key', isKey: true,
				})
				const idProp = find(entry.value, 'id')
				if (idProp) {
					const value = stringOfNode(idProp.value)
					if (value !== null) {
						sites.push({
							location: `lessons[${entry.key}].id`, from: value, kind: 'lesson',
							start: idProp.value.start, end: idProp.value.end, quote: idProp.value.quote, nodeKind: idProp.value.kind,
						})
					}
				}
			}
		}
		const byFileProp = find(node, 'byFile')
		if (byFileProp && byFileProp.value.kind === 'object') {
			for (const entry of own(byFileProp.value)) {
				// 路径键（可能是旧平铺路径）与它映射到的课次身份是**两个**引用位置，必须分开命名
				sites.push({
					location: `byFile[${entry.key}]#path`, from: entry.key, kind: 'legacy-path',
					start: entry.keyStart, end: entry.keyEnd, quote: null, nodeKind: 'key', isKey: true,
				})
				const value = stringOfNode(entry.value)
				if (value !== null) {
					sites.push({
						location: `byFile[${entry.key}]#value`, from: value, kind: 'lesson',
						start: entry.value.start, end: entry.value.end, quote: entry.value.quote, nodeKind: entry.value.kind,
					})
				}
			}
		}
		return { ok: true, sites }
	}

	return { ok: false, error: `${where}：未知数据形状 ${JSON.stringify(spec.dataShape)}`, at: null }
}

/** 旧平铺路径（`lessons/NNNN-*.html`）→ 归属候选（依据 lesson-map.js:74-75 的常量） */
function resolveLegacyPath(pathValue, index) {
	const m = /^lessons\/(\d{4})-([^/]+)\.html$/.exec(pathValue)
	if (!m) return { ok: true, cls: 'canonical-lesson', changed: false, key: pathValue, pathOnly: true }
	const cands = index.pointCircles.get(LEGACY_POINT) || []
	const candidates = cands.map((c) => `${c}/${LEGACY_POINT}/${m[1]}`)
	if (candidates.length === 1) return { ok: true, cls: 'legacy-flat-path', changed: true, key: candidates[0], candidates }
	if (candidates.length === 0) return block('orphan-lesson', [], `orphan-lesson: 旧平铺路径 ${JSON.stringify(pathValue)} 的归属知识点 ${LEGACY_POINT} 不在 lessons/ 里（缺归属）`)
	return block('ambiguous-point', candidates, `ambiguous-point: 旧平铺路径 ${JSON.stringify(pathValue)} 的归属知识点 ${LEGACY_POINT} 在 ${candidates.length} 个圆圈里都有 —— 不猜`)
}

/* ══════════════════════════════════════════════════════════════════════
 * §6 迁移计划（**零写**）
 * ══════════════════════════════════════════════════════════════════════ */

function emptyClassTally() {
	const tally = new Map()
	for (const id of [...SHAPE_CLASSES, ...BLOCK_CLASSES]) tally.set(id, { id, verdict: 'none', occurrences: 0, files: new Set() })
	return tally
}

/** 计划 / 重算共用的确定性排序：先文件、再 location（**不许依赖遍历顺序**） */
function byFileThenLoc(a, b) {
	if (a.file !== b.file) return a.file < b.file ? -1 : 1
	if (a.location === b.location) return 0
	return a.location < b.location ? -1 : 1
}

const SITE_FINDERS = Object.freeze({
	point: (value, index) => resolvePointValue(value, index),
	lesson: (value, index) => resolveLessonValue(value, index),
	display: (value, index) => resolveLessonValue(value, index),
	'legacy-path': (value, index) => resolveLegacyPath(value, index),
})

/** 把一个文件 spec 的每个槽位转成 site 表（jsonl / js 两条读法，都**不执行**） */
function sitesOfFile(text, spec, index) {
	if (spec.format === 'jsonl') {
		const scanned = scanJsonl(text, spec, spec.rel)
		if (!scanned.ok) return { ok: false, error: `unparsable-ledger: ${scanned.error}` }
		return { ok: true, sites: scanned.sites }
	}
	const literal = readDataLiteral(text, spec.rel)
	if (!literal.ok) return { ok: false, error: `js-shape-unsafe: ${literal.error}` }
	const scanned = scanJsLiteral(literal.node, spec, spec.rel)
	if (!scanned.ok) return { ok: false, error: `js-shape-unsafe: ${scanned.error}` }
	return { ok: true, sites: scanned.sites }
}

/**
 * 造迁移计划。**对目标目录零写**：不建目录、不写日志、不加锁、不备份；
 * 只读文件字节，算映射与预期输出，最后给 `planDigest`。
 *
 * @param {string} root 课程包根
 * @param {{fs?:object}} [opts]
 * @returns {{ok:true, plan:object}|{ok:false, plan:null, code:string, error:string, failure:object}}
 */
function planIdentityMigration(root, opts = {}) {
	const io = fsOf(opts, 'planIdentityMigration')
	const rootText = String(root == null ? '' : root).trim()
	if (!rootText) return badPlan('PLAN_REQUIRED', '没有课程包根目录')
	const rootAbs = path.resolve(rootText)
	let st = null
	try {
		st = io.statSync(rootAbs)
	} catch (e) {
		const s = sysErr(e)
		return badPlan('PLAN_REQUIRED', `课程包根不可用（${s.code}）：${rootAbs}`,
			failure('input', 'PLAN_REQUIRED', `课程包根不可用（${s.code}）：${rootAbs}`, { file: rootAbs, errorCode: s.code }))
	}
	if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
		return badPlan('PLAN_REQUIRED', `课程包根不是目录：${rootAbs}`)
	}
	if (io.existsSync(path.join(rootAbs, '.git'))) {
		return badPlan('PLAN_REQUIRED', `拒绝在带 .git 的目录上迁移（课程包根应当是课程包本身，不是仓库根）：${rootAbs}`)
	}

	const index = buildIndex(rootAbs, io)
	const tally = emptyClassTally()
	const changes = []
	const blocks = []
	const inputs = []
	const jsUnsafe = []

	const noteClass = (cls, verdict, file) => {
		const t = tally.get(cls)
		if (!t) return
		t.occurrences += 1
		t.files.add(file)
		if (verdict === 'block') t.verdict = 'block'
		else if (t.verdict !== 'block') t.verdict = 'normalize'
	}

	// 索引自身的问题 → 阻断（整次 apply）
	for (const p of index.problems) {
		blocks.push({
			file: String(p.file), location: String(p.location || ''),
			from: p.from === null || p.from === undefined ? null : String(p.from),
			candidates: (p.candidates || []).map(String), error: String(p.error),
		})
		noteClass(p.cls || 'index-problem', 'block', String(p.file))
	}

	/** 一个槽位：决定"改成什么"或"阻断什么"（不做任何 IO） */
	const handleSite = (spec, site) => {
		const finder = SITE_FINDERS[site.kind]
		if (!finder) return
		const resolved = finder(site.from, index)
		if (!resolved || resolved.skip) return
		if (!resolved.ok) {
			blocks.push({ file: spec.rel, location: site.location, from: site.from, candidates: (resolved.candidates || []).map(String), error: String(resolved.error) })
			noteClass(resolved.cls, 'block', spec.rel)
			return
		}
		// 形状类的**最终处置**：可写且确实要改 = normalize；落在阻断文件里 = block
		const verdict = spec.reason && resolved.changed ? 'block' : 'normalize'
		noteClass(resolved.cls, verdict, spec.rel)
		if (!resolved.changed) return
		if (spec.reason) {
			// 派生重建缺失：报出候选，**整次阻断**
			blocks.push({
				file: spec.rel, location: site.location, from: site.from,
				candidates: [String(resolved.key)],
				error: `${spec.reason}（若要归一，目标是 ${resolved.key}）`,
			})
			noteClass('blocked-rebuild-missing', 'block', spec.rel)
			return
		}
		changes.push({
			file: spec.rel, location: site.location, from: site.from, to: resolved.key, cls: resolved.cls,
			edit: { start: site.start, end: site.end, quote: site.quote, isKey: site.isKey === true },
		})
	}

	for (const spec of [...WRITABLE_FILES, ...BLOCKED_FILES]) {
		const abs = path.join(rootAbs, ...String(spec.rel).split('/'))
		let got
		try {
			got = readText(io, abs)
		} catch (e) {
			const s = sysErr(e)
			return badPlan('IO_ERROR', `读不动 ${spec.rel}（${s.code}）：${s.message}`,
				failure('io', 'IO_ERROR', `读不动 ${spec.rel}（${s.code}）：${s.message}`, { file: spec.rel, errorCode: s.code }))
		}
		if (!got.exists) continue
		if (got.roundTrip === false) {
			blocks.push({ file: spec.rel, location: 'bytes', from: null, candidates: [], error: 'unparsable-ledger: 文件不是合法 UTF-8（无法逐字节保留地改写，阻断）' })
			noteClass('index-problem', 'block', spec.rel)
			continue
		}
		inputs.push({ file: spec.rel, bytes: got.bytes, digest: got.digest })
		const scanned = sitesOfFile(got.text, spec, index)
		if (!scanned.ok) {
			blocks.push({ file: spec.rel, location: spec.format === 'jsonl' ? 'json' : 'js-literal', from: null, candidates: [], error: scanned.error })
			noteClass(spec.format === 'jsonl' ? 'index-problem' : 'js-shape-unsafe', 'block', spec.rel)
			if (spec.format !== 'jsonl') jsUnsafe.push({ file: spec.rel, error: scanned.error })
			continue
		}
		for (const site of scanned.sites) handleSite(spec, site)
	}

	// 只读核验的台账（teaching.jsonl）：它必须**读得懂**；身份是单段 circle，没有历史形状
	for (const rel of READONLY_LEDGERS) {
		const abs = path.join(rootAbs, ...String(rel).split('/'))
		let got
		try {
			got = readText(io, abs)
		} catch (e) {
			const s = sysErr(e)
			return badPlan('IO_ERROR', `读不动 ${rel}（${s.code}）：${s.message}`,
				failure('io', 'IO_ERROR', `读不动 ${rel}（${s.code}）：${s.message}`, { file: rel, errorCode: s.code }))
		}
		if (!got.exists) continue
		if (got.roundTrip === false) {
			blocks.push({ file: rel, location: 'bytes', from: null, candidates: [], error: 'unparsable-ledger: 文件不是合法 UTF-8' })
			noteClass('index-problem', 'block', rel)
			continue
		}
		inputs.push({ file: rel, bytes: got.bytes, digest: got.digest })
		// 用 U03 的五态读法（**唯一**的台账读取契约：missing/empty/ok/invalid/io-error）核验；
		// 这里只要"读得懂"，不取记录（它的身份是单段 circle，没有可迁移的历史形状）
		const read = readLedger(abs, { format: 'jsonl', fs: io })
		if (read.status === 'invalid' || read.status === 'io-error') {
			blocks.push({
				file: rel, location: 'jsonl', from: null, candidates: [],
				error: `unparsable-ledger: ${read.status} —— ${read.problems[0] || '台账不可信'}`,
			})
			noteClass('index-problem', 'block', rel)
		}
	}

	// 版本链：**不可证明同源就不许合并** —— goals.jsonl 里两条**原始 point 不同**的记录，
	// 归一后如果撞在同一个 (point, v) 上，就等于把两条版本链悄悄并成一条 ⇒ 整次阻断。
	// （同一条原始 point 出现的重复 v 不在这里判：那属于台账自身的历史问题，本卡不擅自"修"。）
	{
		const rel = 'learning-records/goals.jsonl'
		let got = null
		try {
			got = readText(io, path.join(rootAbs, ...rel.split('/')))
		} catch {
			got = null
		}
		if (got && got.exists && got.roundTrip !== false) {
			const normalizedByLine = new Map()
			for (const c of changes) {
				if (c.file !== rel) continue
				const m = /^L(\d+):point$/.exec(c.location)
				if (m) normalizedByLine.set(Number(m[1]), c.to)
			}
			const chains = new Map()
			const lines = splitLines(got.text)
			for (let li = 0; li < lines.length; li += 1) {
				const body = lines[li].body
				if (!body.trim()) continue
				let node = null
				try {
					node = parseJsonLine(body, `${rel} 第 ${li + 1} 行`)
				} catch {
					continue // 坏行另有判据（readLedger/形状扫描）负责，这里不重复报
				}
				const pointProp = node.props.find((p) => p.key === 'point')
				const vProp = node.props.find((p) => p.key === 'v')
				const point = stringOfNode(pointProp ? pointProp.value : null)
				const v = vProp && vProp.value.kind === 'number' ? String(Number(vProp.value.value)) : null
				if (!point || v === null) continue
				const normalized = normalizedByLine.get(li + 1) || point
				const key = `${normalized}\u0000${v}`
				const prev = chains.get(key)
				if (!prev) {
					chains.set(key, { line: li + 1, from: point })
					continue
				}
				if (prev.from === point) continue
				blocks.push({
					file: rel, location: `L${li + 1}:point`, from: point, candidates: [normalized],
					error: `version-chain-collision: 第 ${prev.line} 行（point=${JSON.stringify(prev.from)}）与第 ${li + 1} 行（point=${JSON.stringify(point)}）归一后都落在 ${normalized}、v 都是 ${v} —— 两条版本链不可证明同源，不许合并`,
				})
				noteClass('version-chain-collision', 'block', rel)
			}
		}
	}

	// 同一个引用位置出现两条处置 = 结构不可判定 → 阻断（不静默挑一条）
	// ⚠️ 重复项先收集、后追加：**不许在遍历 `blocks` 的同时往它里面 push**（那就是死循环）
	const seen = new Set()
	const duplicates = []
	for (const list of [changes, blocks]) {
		for (const entry of list) {
			const id = `${entry.file}\u0000${entry.location}`
			if (seen.has(id)) {
				duplicates.push({ file: entry.file, location: entry.location, from: entry.from === undefined ? null : entry.from, candidates: [], error: 'duplicate-location: 同一个引用位置出现两条处置（结构不可判定，阻断）' })
				noteClass('index-problem', 'block', entry.file)
				continue
			}
			seen.add(id)
		}
	}
	for (const dup of duplicates) blocks.push(dup)

	const byFileThenLoc = (a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.location < b.location ? -1 : a.location > b.location ? 1 : 0)
	const sortChanges = changes.slice().sort(byFileThenLoc)
	const sortBlocks = blocks.slice().sort(byFileThenLoc)

	const indexDigest = indexDigestOf(index)
	const changedFiles = [...new Set(sortChanges.map((c) => c.file))].sort()

	// 备份目录名 = 计划核心的摘要前 16 位（**确定性**，不含时钟/随机）
	const planCoreForId = {
		schema: MIGRATION_SCHEMA,
		root: rootAbs,
		operation: 'identity-migration',
		indexDigest,
		inputs: inputs.slice().sort((a, b) => (a.file < b.file ? -1 : 1)),
		changes: sortChanges.map((c) => ({ file: c.file, location: c.location, from: c.from, to: c.to })),
		blocks: sortBlocks,
	}
	const backupId = digestOf(JSON.stringify(planCoreForId)).slice(0, 16)
	const backupDir = `${BACKUP_ROOT}/${backupId}`

	// 目标文件新字节（纯函数；计划阶段算一次，apply 阶段在锁内**重算**并与 planDigest 对）
	const nextByFile = new Map()
	const backupFiles = []
	if (changedFiles.length) {
		for (const rel of changedFiles) {
			const abs = path.join(rootAbs, ...rel.split('/'))
			const before = readText(io, abs)
			const edits = sortChanges.filter((c) => c.file === rel)
			nextByFile.set(rel, buildFileContent(rel, before.text, edits))
			backupFiles.push({ file: rel, bytes: before.bytes, digest: before.digest })
		}
	}
	const baseOutputs = []
	for (const rel of changedFiles) {
		const next = nextByFile.get(rel)
		baseOutputs.push({ file: rel, bytes: textBytes(next).length, digest: digestOf(next) })
	}
	for (const b of backupFiles) baseOutputs.push({ file: `${backupDir}/${b.file}`, bytes: b.bytes, digest: b.digest })
	const baseOutputsSorted = baseOutputs.sort((a, b) => (a.file < b.file ? -1 : 1))

	const classes = [...tally.values()]
		.filter((t) => t.occurrences > 0)
		.map((t) => ({ id: t.id, verdict: t.verdict, occurrences: t.occurrences, files: [...t.files].sort() }))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

	const plan = {
		schema: MIGRATION_SCHEMA,
		root: rootAbs,
		operation: 'identity-migration',
		indexDigest,
		index: { circles: index.circles, points: index.points, lessons: index.lessons.map((l) => ({ key: l.key, label: l.label, page: l.page })) },
		inputs: planCoreForId.inputs,
		changes: planCoreForId.changes,
		blocks: planCoreForId.blocks,
		classes,
		backup: { dir: backupDir, files: backupFiles.map((b) => ({ file: b.file, digest: b.digest, bytes: b.bytes })) },
		jsUnsafe,
		manifest: { file: `${backupDir}/manifest.json`, bytes: 0, digest: null },
		outputs: baseOutputsSorted,
		planDigest: '',
	}
	plan.planDigest = planDigestOf(plan)

	// 备份清单（含 planDigest；它由被摘要的字段派生 ⇒ 不再进 planDigest，避免自指）
	const manifest = backupManifestSource({
		root: rootAbs, backupDir, planDigest: plan.planDigest, indexDigest,
		inputs: plan.inputs, changes: plan.changes, blocks: plan.blocks,
		files: plan.backup.files.map((b) => ({ file: b.file, beforeDigest: b.digest, bytes: b.bytes, afterDigest: digestOf(nextByFile.get(b.file)) })),
	})
	plan.manifest = { file: plan.manifest.file, bytes: textBytes(manifest).length, digest: digestOf(manifest) }
	plan.outputs = [...baseOutputsSorted, plan.manifest].sort((a, b) => (a.file < b.file ? -1 : 1))
	return { ok: true, plan }
}

/** 计划核心（`planDigest` 的覆盖面）：输入字节 + 映射 + 预期输出（备份清单只由其派生，不进摘要） */
function planCoreOf(plan) {
	return {
		schema: plan.schema,
		root: plan.root,
		operation: plan.operation,
		indexDigest: plan.indexDigest,
		inputs: plan.inputs,
		changes: plan.changes,
		blocks: plan.blocks,
		backup: { dir: plan.backup.dir, files: plan.backup.files },
		outputs: (plan.outputs || []).filter((o) => !plan.manifest || o.file !== plan.manifest.file),
	}
}

/** 计划摘要（可复算；同输入永远同一摘要） */
function planDigestOf(plan) {
	return digestOf(JSON.stringify(planCoreOf(plan)))
}

/** 备份清单正文（确定性文本；无时间戳） */
function backupManifestSource({ root, backupDir, planDigest, indexDigest, inputs, changes, blocks, files }) {
	return JSON.stringify({
		schema: BACKUP_SCHEMA,
		root,
		backupDir,
		planDigest,
		indexDigest,
		inputs,
		changes,
		blocks,
		files,
	}, null, 2) + '\n'
}

/**
 * 由"写前字节 + 该文件的诸条映射"算出**新文本**（纯函数；同输入永远同一输出）。
 * 编辑只落在身份字面量上，别的字节一个都不动（正文 / 日期 / 顺序全部逐字保留）。
 */
function buildFileContent(rel, beforeText, changeEntries) {
	if (!changeEntries.length) return beforeText
	const spec = [...WRITABLE_FILES, ...BLOCKED_FILES].find((f) => f.rel === rel)
	if (!spec) throw new ShapeError(`不认识的迁移目标 ${rel}`)
	if (spec.format !== 'jsonl') {
		// 本基线里 JS 数据文件的身份槽全部是阻断类（见文件头"派生重建"），走到这里是设计外的
		throw new ShapeError(`${rel} 是 JS 数据文件，本基线的迁移不写 JS（引用位置一律阻断）`)
	}
	const lines = splitLines(String(beforeText))
	const byLine = new Map()
	for (const c of changeEntries) {
		const m = /^L(\d+):(.+)$/.exec(c.location)
		if (!m) throw new ShapeError(`location 形状不认识：${c.location}`)
		const li = Number(m[1]) - 1
		const list = byLine.get(li) || []
		list.push(c)
		byLine.set(li, list)
	}
	for (const [li, list] of byLine) {
		const line = lines[li]
		if (!line) throw new ShapeError(`第 ${li + 1} 行不存在`)
		line.body = applyEdits(line.body, list.map((c) => ({
			start: c.edit.start, end: c.edit.end,
			text: renderStringLiteral(c.to, c.edit.quote || '"'),
		})))
	}
	return lines.map((l) => l.body + l.eol).join('')
}

/* ══════════════════════════════════════════════════════════════════════
 * §7 锁内重建（受信变换）：只用**写前字节**重算，绝不直接给 content
 * ══════════════════════════════════════════════════════════════════════ */

/** 声明本次要写的落点（目标 + 备份 + 清单）；planCommit 第一次调用用它 */
function declareFromPlan(plan) {
	const rels = [...new Set([...plan.changes.map((c) => c.file), ...plan.backup.files.map((b) => `${plan.backup.dir}/${b.file}`), plan.manifest.file])].sort()
	return { operation: 'identity-migration', value: null, files: rels.map((rel) => ({ rel, content: '' })) }
}

/**
 * 用**写前字节**重算整份输出（事务的 build 回调；同步、纯计算、不写盘）。
 * 任何重算结果与计划不符 → 抛错（提交层据此拒写，一个字节都不落位）。
 */
function buildFromPlan(rootAbs, io, files, plan) {
	const index = buildIndex(rootAbs, io)
	const recalculated = []
	const blocks = []

	for (const spec of [...WRITABLE_FILES, ...BLOCKED_FILES]) {
		const text = files[spec.rel]
		if (typeof text !== 'string') continue
		const scanned = sitesOfFile(text, spec, index)
		if (!scanned.ok) {
			blocks.push({ file: spec.rel, error: scanned.error })
			continue
		}
		for (const site of scanned.sites) {
			const finder = SITE_FINDERS[site.kind]
			if (!finder) continue
			const resolved = finder(site.from, index)
			if (!resolved || resolved.skip) continue
			if (!resolved.ok) {
				blocks.push({ file: spec.rel, location: site.location, error: resolved.error })
				continue
			}
			if (!resolved.changed) continue
			if (spec.reason) {
				blocks.push({ file: spec.rel, location: site.location, error: `${spec.reason}（若要归一，目标是 ${resolved.key}）` })
				continue
			}
			recalculated.push({
				file: spec.rel, location: site.location, from: site.from, to: resolved.key,
				edit: { start: site.start, end: site.end, quote: site.quote, isKey: site.isKey === true },
			})
		}
	}

	// 索引问题（重算时若冒出新问题也算策略漂移）
	if (index.problems.length) blocks.push({ file: String(index.problems[0].file), location: 'index', error: String(index.problems[0].error) })
	if (blocks.length) {
		const e = new Error(`锁内重算出现阻断（${blocks.length} 处）：${blocks[0].error}`)
		e.migrationBlocks = blocks
		throw e
	}

	// 重算结果的顺序必须与计划一致（计划按 file+location 升序）；比较前先排序，再逐条比三元组
	recalculated.sort(byFileThenLoc)
	const want = plan.changes.map((c) => ({ file: c.file, location: c.location, from: c.from, to: c.to }))
	const got = recalculated.map((c) => ({ file: c.file, location: c.location, from: c.from, to: c.to }))
	if (JSON.stringify(want) !== JSON.stringify(got)) {
		throw new Error('锁内重算的映射与计划不一致（输入 / 归属 / 策略在计划之后被改过，旧计划不许覆盖）')
	}

	const entries = []
	for (const rel of [...new Set(recalculated.map((c) => c.file))].sort()) {
		const before = files[rel]
		entries.push({ rel, content: buildFileContent(rel, before, recalculated.filter((c) => c.file === rel)) })
	}	for (const b of plan.backup.files) {
		const before = files[b.file]
		if (typeof before !== 'string') throw new Error(`写前字节缺失：${b.file}`)
		entries.push({ rel: `${plan.backup.dir}/${b.file}`, content: before })
	}
	const afterDigestOf = (rel) => {
		const hit = entries.find((e) => e.rel === rel)
		return hit ? digestOf(hit.content) : null
	}
	const manifest = backupManifestSource({
		root: plan.root, backupDir: plan.backup.dir, planDigest: plan.planDigest, indexDigest: plan.indexDigest,
		inputs: plan.inputs, changes: plan.changes, blocks: plan.blocks,
		files: plan.backup.files.map((b) => ({ file: b.file, beforeDigest: b.digest, bytes: b.bytes, afterDigest: afterDigestOf(b.file) })),
	})
	entries.push({ rel: plan.manifest.file, content: manifest })
	return {
		operation: 'identity-migration',
		value: { planDigest: plan.planDigest, backupDir: plan.backup.dir, changes: plan.changes.length, backupFiles: plan.backup.files.length },
		files: entries.sort((a, b) => (a.rel < b.rel ? -1 : 1)),
	}
}

/** 默认的 build（applyCommit 的注入点：受信重建能力从这里进） */
function defaultBuild(rootAbs, io, plan) {
	return ({ files }) => {
		if (!files || !Object.keys(files).length) return declareFromPlan(plan)
		return buildFromPlan(rootAbs, io, files, plan)
	}
}

/* ══════════════════════════════════════════════════════════════════════
 * §8 apply / rollback（三闸 + 事务；不伪装成功、不覆盖后续修改）
 * ══════════════════════════════════════════════════════════════════════ */

function receiptFailure(state, failureObj, extra) {
	const out = {
		ok: false,
		state,
		code: failureObj.code,
		error: failureObj.error,
		failure: failureObj,
		rollbackError: extra && extra.rollbackError !== undefined ? extra.rollbackError : null,
		journal: extra && extra.journal !== undefined ? extra.journal : null,
		value: undefined,
	}
	return out
}

/** 阻断类 → 拒绝码（歧义用新增码 ID_AMBIGUOUS；其余是既有码 MIGRATION_FAILED 的"迁移失败"语义） */
function codeOfBlocks(blocks) {
	return blocks.some((b) => /ambiguous/.test(String(b.error))) ? 'ID_AMBIGUOUS' : 'MIGRATION_FAILED'
}

/**
 * 应用迁移（三闸：有效计划 → 显式确认 → 锁内真实字节摘要）。
 *
 * @param {string} root 课程包根
 * @param {{confirm?:boolean, planDigest?:string, fs?:object, build?:Function}} [opts]
 * @returns {{ok:boolean, state:string, code?:string|null, error?:string|null, failure?:object|null,
 *            rollbackError?:string|null, journal?:string|null, value?:any}}
 */
function applyIdentityMigration(root, opts = {}) {
	const io = fsOf(opts, 'applyIdentityMigration')
	const rootText = String(root == null ? '' : root).trim()
	if (!rootText) return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', '没有课程包根目录'))
	const rootAbs = path.resolve(rootText)

	// 闸一：重新造一遍计划（有效计划 / 目标 / 操作）
	const fresh = planIdentityMigration(rootAbs, { fs: io })
	if (!fresh.ok) return receiptFailure('rejected', fresh.failure)
	const plan = fresh.plan

	// 计划里有任何阻断 → **整次阻断**（一处坏，别的文件一个字节都不动）
	if (plan.blocks.length) {
		const first = plan.blocks[0]
		return receiptFailure('rejected', failure('conflict', codeOfBlocks(plan.blocks),
			`计划有 ${plan.blocks.length} 处阻断，整次 apply 不执行（第一处：${first.file} ${first.location} ${first.error}）`,
			{ file: first.file }), { value: { blocks: plan.blocks.length } })
	}
	if (!plan.changes.length) {
		return receiptFailure('rejected', failure('input', 'MIGRATION_NOTHING',
			'没有需要迁移的历史身份写法（nothing to migrate）—— 这不是成功，也不许写任何字节'))
	}

	// 闸二：显式确认 + 回引摘要（缺摘要 ≠ 过期摘要，两条独立拒绝）
	if (opts.confirm !== true) {
		return receiptFailure('rejected', failure('confirmation', 'CONFIRM_REQUIRED',
			'显式迁移会改写台账：必须显式给 confirm:true（不接受"看起来像真"）'))
	}
	const givenDigest = typeof opts.planDigest === 'string' ? opts.planDigest.trim() : ''
	if (!givenDigest) {
		return receiptFailure('rejected', failure('confirmation', 'PLAN_REQUIRED',
			'必须回引 planDigest（先跑 --plan 拿摘要）；没有摘要的 apply 一律拒绝'))
	}
	if (givenDigest !== plan.planDigest) {
		return receiptFailure('rejected', failure('conflict', 'PLAN_STALE',
			`调用方给的 planDigest 与当前计划不符（给 ${JSON.stringify(givenDigest)} / 当前 ${plan.planDigest}）—— 你确认的不是这份计划`))
	}

	// 闸三（锁内）：交给 commit 协议（三闸 + 事务），这里只组装 build
	const build = typeof opts.build === 'function'
		? (ctx) => wrapInjectedBuild(opts.build, ctx, plan)
		: defaultBuild(rootAbs, io, plan)

	const planned = planCommit(rootAbs, build, { fs: io })
	if (!planned.ok) return receiptFailure('rejected', planned.failure)

	const res = applyCommit(rootAbs, planned.plan, {
		confirm: true,
		planDigest: planned.plan.planDigest,
		build,
		fs: io,
	})
	const out = {
		ok: res.ok === true,
		state: String(res.state || 'rejected'),
		code: res.code === undefined ? null : res.code,
		error: res.error === undefined ? null : res.error,
		failure: res.failure === undefined ? null : res.failure,
		rollbackError: res.rollbackError === undefined ? null : res.rollbackError,
		journal: res.journal === undefined ? null : res.journal,
		value: res.ok === true
			? { planDigest: plan.planDigest, backupDir: plan.backup.dir, changes: plan.changes.length, backupFiles: plan.backup.files.length, commitDigest: planned.plan.planDigest }
			: (res.value === undefined ? null : res.value),
	}
	return out
}

/** 注入的 build（受信重建能力）：必须是同步纯计算；结果交给提交层的摘要复核 */
function wrapInjectedBuild(userBuild, ctx, plan) {
	if (!ctx || !Object.keys(ctx.files || {}).length) return declareFromPlan(plan)
	const out = userBuild(ctx)
	if (out && typeof out.then === 'function') throw new Error('注入的 build 必须同步返回（协议是同步的）')
	return out
}

/**
 * 回滚：按**当前产物摘要**防止覆盖"回滚之后又被改过"的内容。
 *
 * @param {string} root 课程包根
 * @param {{confirm?:boolean, planDigest?:string, backupDir?:string, fs?:object}} [opts]
 * @returns {{ok:boolean, state:string, code?:string|null, error?:string|null, failure?:object|null,
 *            rollbackError?:string|null, journal?:string|null, value?:any}}
 */
function rollbackIdentityMigration(root, opts = {}) {
	const io = fsOf(opts, 'rollbackIdentityMigration')
	const rootText = String(root == null ? '' : root).trim()
	if (!rootText) return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', '没有课程包根目录'))
	const rootAbs = path.resolve(rootText)

	if (opts.confirm !== true) {
		return receiptFailure('rejected', failure('confirmation', 'CONFIRM_REQUIRED', '回滚会改写台账：必须显式给 confirm:true'))
	}
	const givenDigest = typeof opts.planDigest === 'string' ? opts.planDigest.trim() : ''
	if (!givenDigest) return receiptFailure('rejected', failure('confirmation', 'PLAN_REQUIRED', '必须回引 planDigest（这次迁移计划的摘要）'))

	const rawBackup = String(opts.backupDir == null ? '' : opts.backupDir).trim()
	if (!rawBackup) return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', '必须给 backupDir（该次迁移的专属备份目录）'))
	const backupAbs = path.isAbsolute(rawBackup) ? path.resolve(rawBackup) : path.resolve(rootAbs, rawBackup)
	if (!insideRoot(rootAbs, backupAbs)) {
		return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', `backupDir 必须落在课程包根内：${backupAbs}`))
	}

	let manifestText = null
	try {
		const got = readText(io, path.join(backupAbs, 'manifest.json'))
		if (!got.exists) return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', `备份清单不存在：${path.join(backupAbs, 'manifest.json')}`))
		manifestText = got.text
	} catch (e) {
		const s = sysErr(e)
		return receiptFailure('rejected', failure('io', 'IO_ERROR', `备份清单读不动（${s.code}）：${s.message}`, { errorCode: s.code }))
	}
	let manifest = null
	try {
		manifest = JSON.parse(manifestText)
	} catch (e) {
		return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', `备份清单不是合法 JSON：${errMessage(e)}`))
	}
	if (!isPlainObject(manifest) || manifest.schema !== BACKUP_SCHEMA) {
		return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', `备份清单 schema 不是 ${BACKUP_SCHEMA}`))
	}
	if (path.resolve(String(manifest.root)) !== rootAbs) {
		return receiptFailure('rejected', failure('conflict', 'PLAN_STALE', `备份清单属于别的课程包根（${manifest.root} / 本次 ${rootAbs}）`))
	}
	if (manifest.planDigest !== givenDigest) {
		return receiptFailure('rejected', failure('conflict', 'PLAN_STALE', `备份清单记的计划摘要与调用方给的不符（清单 ${JSON.stringify(manifest.planDigest)} / 给 ${JSON.stringify(givenDigest)}）`))
	}
	const files = Array.isArray(manifest.files) ? manifest.files : []
	if (!files.length) return receiptFailure('rejected', failure('input', 'PLAN_REQUIRED', '备份清单里没有任何文件（无事可回滚）'))

	// ① 当前产物摘要必须仍是"提交后的样子"（否则会覆盖后续修改）
	const restore = []
	for (const f of files) {
		const rel = String(f && f.file)
		const abs = path.join(rootAbs, ...rel.split('/'))
		let cur
		try {
			cur = readText(io, abs)
		} catch (e) {
			const s = sysErr(e)
			return receiptFailure('rejected', failure('io', 'IO_ERROR', `回滚前读不动 ${rel}（${s.code}）：${s.message}`, { file: rel, errorCode: s.code }))
		}
		const curDigest = cur.exists ? cur.digest : null
		if (curDigest !== f.afterDigest) {
			return receiptFailure('rejected', failure('conflict', 'PLAN_STALE',
				`${rel} 的当前字节与"迁移后"记录的摘要不符 —— 迁移之后它被改过，回滚拒绝覆盖后续修改`,
				{ file: rel }))
		}
		const backed = readText(io, path.join(backupAbs, ...rel.split('/')))
		if (!backed.exists) return receiptFailure('rejected', failure('recovery', 'RECOVERY_REQUIRED', `备份文件缺失：${path.join(backupAbs, rel)}`, { file: rel }))
		if (backed.digest !== f.beforeDigest) {
			return receiptFailure('rejected', failure('recovery', 'RECOVERY_REQUIRED', `备份文件 ${rel} 的字节与清单记的写前摘要不符（备份损坏，拒绝还原）`, { file: rel }))
		}
		restore.push({ rel, content: backed.text })
	}

	const restoreBuild = (ctx) => {
		if (!ctx || !Object.keys(ctx.files || {}).length) {
			return { operation: 'identity-rollback', value: null, files: restore.map((r) => ({ rel: r.rel, content: '' })) }
		}
		return { operation: 'identity-rollback', value: { planDigest: givenDigest, restored: restore.length, backupDir: rawBackup }, files: restore }
	}
	const planned = planCommit(rootAbs, restoreBuild, { fs: io })
	if (!planned.ok) return receiptFailure('rejected', planned.failure)

	const res = applyCommit(rootAbs, planned.plan, {
		confirm: true, planDigest: planned.plan.planDigest, build: restoreBuild, fs: io,
	})
	return {
		ok: res.ok === true,
		state: String(res.state || 'rejected'),
		code: res.code === undefined ? null : res.code,
		error: res.error === undefined ? null : res.error,
		failure: res.failure === undefined ? null : res.failure,
		rollbackError: res.rollbackError === undefined ? null : res.rollbackError,
		journal: res.journal === undefined ? null : res.journal,
		value: res.ok === true ? { planDigest: givenDigest, restored: restore.length, backupDir: rawBackup, commitDigest: planned.plan.planDigest } : (res.value === undefined ? null : res.value),
	}
}

module.exports = {
	MIGRATION_SCHEMA,
	BACKUP_SCHEMA,
	BACKUP_ROOT,
	SHAPE_CLASSES,
	BLOCK_CLASSES,
	WRITABLE_FILES,
	BLOCKED_FILES,
	READONLY_LEDGERS,
	LEGACY_HALO,
	LEGACY_POINT,
	UNLESSON,
	planDigestOf,
	planIdentityMigration,
	applyIdentityMigration,
	rollbackIdentityMigration,
}
