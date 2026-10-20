/**
 * test/audit/U05.mjs —— U05 专项判据（固定 A01–A08，全部真断言）
 * ==================================================================
 * 被测对象：`lib/unify/migration.cjs`（唯一历史解码） + `tools/migrate-pack.mjs`（CLI）。
 *
 * 纪律（本会话共用，写死在判据里）：
 *   ① **可归因**：进程内 fs 写守卫（下面 `createWriteGuard`）拦下所有写能力调用并记绝对路径，
 *      断言它们只落在 {本卡写集 ∪ 本卡证据根 ∪ E:\Temp 本卡唯一临时目录}；
 *      守卫用一次**探针写**自证"真的挂着"（不是空壳）。
 *   ② 授权写集并集从 `docs/unify/interfaces.md` §6 现读（不写死名单），
 *      tracked 写必须 ⊆ 该并集；本卡自己的写集另有一条更窄的断言。
 *   ③ 依赖锚点 sha256：本卡消费的四个 U 模块在整套判据跑前/跑后逐字节不变。
 *   ④ 不跑全量、不碰活包、不跑 T 卡入口、不读模板侧 `unify/`（U19 才生成）。
 *
 * 判据失败一律抛（`assert`），不吞错、不 skip、不恒真。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
	runCard, FIXED_IDS, printVerdict, writeRunEvidence,
	resolveEvidenceRoot, safeRemoveTree, guardTempPath,
} from './unify-runner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const requireCJS = createRequire(import.meta.url)

const MIGRATION_REL = 'lib/unify/migration.cjs'
const CLI_REL = 'tools/migrate-pack.mjs'
const TEST_REL = 'test/audit/U05.mjs'
const RECEIPT_REL = 'docs/unify/receipts/U05.json'

/** 本卡写集（卡面精确写集；比 §6 并集更窄） */
const CARD_WRITE_PREFIXES = Object.freeze([
	'lib/unify/migration.cjs',
	'tools/migrate-pack.mjs',
	'test/audit/U05.mjs',
	'docs/unify/receipts/U05.json',
	'audit-evidence/U05/',
])

/** 本卡消费的依赖锚点（U02 / U03 / U06；路径相对仓根） */
const DEPENDENCY_ANCHORS = Object.freeze([
	'lib/unify/identity.cjs',
	'lib/unify/errors.cjs',
	'lib/unify/ledger-read.cjs',
	'lib/unify/commit.cjs',
	'lib/pack-template/tools/ledger-transaction.cjs',
])

const CHILD = process.env.U05_A07_CHILD === '1'

/** 排障用（U05_TRACE=1 时才打；不进判词行、不写证据） */
function trace(message) {
	if (process.env.U05_TRACE === '1') process.stderr.write(`[U05] ${message}\n`)
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

function digestFile(abs) {
	return sha256(fs.readFileSync(abs))
}

function readme(pathName) {
	return fs.readFileSync(pathName, 'utf8')
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function relPosix(abs) {
	return path.relative(REPO, abs).split(path.sep).join('/')
}

/** 整棵树的逐字节清单（目录 / 文件字节 / 链接目标都算；用于 A02 的"零修改"） */
function treeManifest(dirAbs) {
	const rows = []
	const walk = (dir, rel) => {
		const names = fs.readdirSync(dir).slice().sort()
		for (const name of names) {
			const abs = path.join(dir, name)
			const r = rel ? `${rel}/${name}` : name
			const st = fs.lstatSync(abs)
			if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
				rows.push({ rel: r, type: 'link', target: fs.readlinkSync(abs) })
			} else if (st.isDirectory()) {
				rows.push({ rel: r, type: 'dir' })
				walk(abs, r)
			} else {
				rows.push({ rel: r, type: 'file', bytes: st.size, digest: digestFile(abs) })
			}
		}
	}
	walk(dirAbs, '')
	return rows
}

function manifestDigest(rows) {
	return sha256(rows.map((r) => JSON.stringify(r)).join('\n'))
}

/** 两份清单的第一处差异（报错时给人看，不打印私人正文） */
function firstManifestDiff(a, b) {
	const n = Math.max(a.length, b.length)
	for (let i = 0; i < n; i += 1) {
		const x = a[i] === undefined ? '<缺>' : JSON.stringify(a[i])
		const y = b[i] === undefined ? '<缺>' : JSON.stringify(b[i])
		if (x !== y) return { index: i, before: x, after: y }
	}
	return null
}

/** 跑一次 CLI（参数**数组**调用，不依赖 shell 续行） */
function runCli(args) {
	const res = spawnSync(process.execPath, [path.join(REPO, 'tools', 'migrate-pack.mjs'), ...args], {
		cwd: REPO, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
	})
	return { status: res.status, signal: res.signal, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), error: res.error ? String(res.error.message) : null }
}

function writeJson(abs, value) {
	// 证据落地也走守卫 fs：证据根同样要能归因（不是"测试自己随便写"）
	io.writeFileSync(abs, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * "失败的事务没留下伪成功"的严格判据：
 *   文件字节一个都不许变 / 不许出现新文件 / 不许留 `.whale-txn` 或包锁；
 *   唯一允许的残留是**该次计划备份目录下的空目录**（事务件在写内容之前先 mkdir，
 *   备份内容落不下去时这些空目录没有拥有者去清 —— 这是既有事务件的行为，不是伪成功）。
 * @returns {string[]} 被容忍的空目录
 */
function assertTreeIntact(before, after, { allowEmptyDirsUnder }) {
	const prefix = allowEmptyDirsUnder.endsWith('/') ? allowEmptyDirsUnder : `${allowEmptyDirsUnder}/`
	// 备份根（`.backup`）本身也可能被建出来 —— 它同样属于"该次计划备份目录"这一支
	const backupRoot = prefix.split('/')[0]
	const filesBefore = before.filter((r) => r.type !== 'dir')
	const filesAfter = after.filter((r) => r.type !== 'dir')
	assert.equal(manifestDigest(filesAfter), manifestDigest(filesBefore),
		`失败的事务改了文件字节或留下新文件：${JSON.stringify(firstManifestDiff(filesBefore, filesAfter))}`)
	const dirsBefore = new Set(before.filter((r) => r.type === 'dir').map((r) => r.rel))
	const extraDirs = after.filter((r) => r.type === 'dir' && !dirsBefore.has(r.rel))
	// 允许的空目录：备份根、该次计划备份目录、以及事务件自己的 `.whale-txn`（它只清 txn 子目录，
	// 父目录是既有事务件的常驻书签）。**目录里一个文件都不许留** —— 那由上面的文件清单比对兜住。
	const toleratedDirs = new Set([backupRoot, allowEmptyDirsUnder, '.whale-txn'])
	for (const d of extraDirs) {
		assert.ok(toleratedDirs.has(d.rel) || d.rel.startsWith(prefix), `失败的事务留下越界目录：${d.rel}`)
	}
	assert.equal(after.filter((r) => r.rel.startsWith('.whale-txn/')).length, 0, '失败的事务留下了 .whale-txn 里的 journal 残骸')
	assert.equal(after.filter((r) => r.rel === '.whale-write.lock').length, 0, '失败的事务留下了包锁')
	return extraDirs.map((d) => d.rel)
}

/* ══════════════════════════════════════════════════════════════════════
 * 进程内 fs 写守卫（可归因的核心）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 写能力 → **被写路径**在参数里的下标。
 * ⚠️ `rename/copyFile/cp/symlink` 的 args[0] 是**源**（读的那一侧）：记成"写"会造出假越界
 * （A07 从仓里拷源码时踩到过）。`rename` 的源确实被搬走了，所以源与目标都记。
 */
const WRITE_APIS = Object.freeze([
	{ api: 'writeFileSync', at: [0] },
	{ api: 'appendFileSync', at: [0] },
	{ api: 'mkdirSync', at: [0] },
	{ api: 'rmSync', at: [0] },
	{ api: 'rmdirSync', at: [0] },
	{ api: 'unlinkSync', at: [0] },
	{ api: 'truncateSync', at: [0] },
	{ api: 'chmodSync', at: [0] },
	{ api: 'createWriteStream', at: [0] },
	{ api: 'renameSync', at: [0, 1] },
	{ api: 'copyFileSync', at: [1] },
	{ api: 'cpSync', at: [1] },
	{ api: 'symlinkSync', at: [1] },
])

/**
 * 包一层 fs：写能力记绝对路径后委托；读能力原样绑定。
 * `log` 可被 reset（用于"某一段窗口里有没有写"的断言），`all` **只增不清**（全 suite 累积，
 * 用来断言"整次判据跑下来仓内写只落在本卡写集里"）。
 * @returns {{fs:object, log:Array, all:Array, allow:Array, reset:Function}}
 */
function createWriteGuard(baseFs, allowRoots) {
	const log = []
	const all = []
	const fsView = {}
	for (const key of Object.keys(baseFs)) {
		const value = baseFs[key]
		fsView[key] = typeof value === 'function' ? value.bind(baseFs) : value
	}
	const record = (api, target) => {
		let abs = null
		try {
			abs = path.resolve(String(target))
		} catch {
			abs = String(target)
		}
		const entry = { api, abs, rel: abs && path.isAbsolute(abs) ? relPosix(abs) : null }
		log.push(entry)
		all.push(entry)
	}
	for (const spec of WRITE_APIS) {
		if (typeof baseFs[spec.api] !== 'function') continue
		fsView[spec.api] = (...args) => {
			for (const at of spec.at) if (typeof args[at] === 'string' || Buffer.isBuffer(args[at])) record(spec.api, args[at])
			return baseFs[spec.api].apply(baseFs, args)
		}
	}
	return { fs: fsView, log, all, allow: allowRoots.map((p) => path.resolve(p)), reset: () => { log.length = 0 } }
}

/**
 * 一次写落在哪一类。
 * 先判**仓内**（那是最强约束：仓内写只许落在本卡写集里，且 ⊆ interfaces.md §6 并集），
 * 再判临时根（本卡唯一临时目录 / 本卡证据根）。两者都不命中 = 越界。
 */
function classifyWrite(guard, entry) {
	const abs = entry.abs
	if (abs.startsWith(REPO + path.sep)) {
		const rel = relPosix(abs)
		const inCard = CARD_WRITE_PREFIXES.some((p) => rel === p || rel.startsWith(p))
		return inCard ? { ok: true, where: 'card-writeset', rel } : { ok: false, where: 'repo-outside', rel }
	}
	for (const root of guard.allow) {
		if (abs === root || abs.startsWith(root + path.sep)) return { ok: true, where: 'allowed-root', root }
	}
	return { ok: false, where: 'outside-temp', abs }
}

/** §6 授权写集并集（现读 interfaces.md；不写死名单） */
function authorizedWriteUnion() {
	const file = path.join(REPO, 'docs', 'unify', 'interfaces.md')
	const text = readme(file)
	const start = text.indexOf('## 6.')
	const end = text.indexOf('## 7.')
	assert.ok(start > 0 && end > start, 'interfaces.md §6 找不到（基线被改过？）')
	const section = text.slice(start, end)
	const paths = new Set()
	for (const line of section.split('\n')) {
		if (!line.startsWith('| U')) continue
		const re = /`([^`]+)`/g
		let m
		while ((m = re.exec(line)) !== null) {
			const raw = m[1]
			// 反引号里除了路径还夹着说明文字（例：`audit-evidence/U05/ 下本次新建文件（…）`）
			// ⇒ 只取开头那一段像路径的字符，剥掉 `†` 之类的行首记号
			const trimmed = raw.replace(/^[^A-Za-z0-9_.\/-]+/, '')
			const head = /^[A-Za-z0-9_.\/-]+/.exec(trimmed)
			if (!head) continue
			const p = head[0]
			if (!(p.includes('/') || /\.(c|m)?js$|\.json$|\.md$/.test(p))) continue
			paths.add(p)
		}
	}
	return { file, paths }
}

/* ══════════════════════════════════════════════════════════════════════
 * 夹具（**自建**；形状逐条抄自真实课程包结构与模板）
 * ══════════════════════════════════════════════════════════════════════ */

function glossaryJs(entries) {
	const body = Object.entries(entries).map(([key, rec]) => [
		`    ${key}: {`,
		`      label: '${rec.label}',`,
		`      category: '${rec.category}',`,
		`      official: '${rec.official}',`,
		`      short: '${rec.short}',`,
		`      analogy: '${rec.analogy}',`,
		`      lesson: '${rec.lesson}'`,
		'    }',
	].join('\n')).join(',\n')
	return `/**
 * glossary-data.js — 名词解释的【唯一数据源】
 * 字段说明：label / category / official / short / analogy / lesson
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GLOSSARY = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
${body}
  };
});
`
}

function questionsJs(entries) {
	const body = entries.map((rec) => [
		`    '${rec.id}': {`,
		`      id: '${rec.id}',`,
		`      date: '${rec.date}',`,
		`      lesson: '${rec.lesson}',`,
		`      question: '${rec.question}',`,
		"      status: 'answered',",
		"      page: 'reference/NOTES.html',",
		`      anchor: 'q${rec.id}',`,
		`      section: '${rec.section}',`,
		`      answer: '${rec.answer}',`,
		'      terms: [],',
		`      answerHtml: '<p>${rec.answer}</p>'`,
		'    }',
	].join('\n')).join(',\n')
	return `/**
 * questions-data.js — 答疑台账（由答疑写回往里登记）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QUESTIONS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
${body}
  };
});
`
}

function practiceJs(data) {
	return `/**
 * practice-data.js — 课程页「实践区」的数据源（**由插件 whale_practice 生成**）
 * 本文件不含时间戳 —— 同样的工作区会产出逐字节相同的这份文件（可对拍、可判漂移）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PRACTICE_DATA = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return ${JSON.stringify(data, null, 2)};
});
`
}

/**
 * 基础夹具（只有**可写台账**；没有任何派生数据文件 ⇒ 计划零阻断）。
 * 课程结构：programming/spring-boot（0001,0002）· programming/vue（1001，fileBase 1000）
 */
function baseFiles() {
	const f = {}
	f['lessons/programming/halo.json'] = JSON.stringify({ id: 'programming', name: '编程', color: '#88bd', center: 'programming' }, null, 2) + '\n'
	f['lessons/programming/spring-boot/point.json'] = JSON.stringify({ point: 'spring-boot', label: '', fileBase: 0, requires: [] }, null, 2) + '\n'
	f['lessons/programming/spring-boot/0001-hello.html'] = '<!doctype html><html><body>第1课 Hello</body></html>\n'
	f['lessons/programming/spring-boot/0002-rest.html'] = '<!doctype html><html><body>第2课 REST</body></html>\n'
	f['lessons/programming/vue/point.json'] = JSON.stringify({ point: 'vue', label: 'Vue', fileBase: 1000, requires: [] }, null, 2) + '\n'
	f['lessons/programming/vue/1001-render.html'] = '<!doctype html><html><body>Vue 第1课 渲染</body></html>\n'
	f['lessons/src/programming/spring-boot/0001-hello.html'] = '<!doctype html><html><body>第1课 Hello（源）</body></html>\n'
	f['lessons/src/programming/spring-boot/0002-rest.html'] = '<!doctype html><html><body>第2课 REST（源）</body></html>\n'
	f['lessons/src/programming/vue/1001-render.html'] = '<!doctype html><html><body>Vue 第1课 渲染（源）</body></html>\n'
	f['code/proj/EXPECT.json'] = JSON.stringify({
		lessons: [
			{ id: 'spring-boot/0001', title: '第1课 Hello Spring Boot' },
			{ id: 'spring-boot/0002', title: '第2课 写一个 REST 接口' },
			{ id: 'vue/1001', title: 'Vue 第1课 把接口数据渲染成页面' },
		],
	}, null, 2) + '\n'

	// 摸底（裸 point + 复合 id + 学生原话/日期/顺序都要在迁移后逐字保留）
	f['learning-records/intake.jsonl'] = [
		JSON.stringify({
			point: 'spring-boot', topic: 'Spring Boot', level: '零基础', background: '写过一点 Java，没碰过框架',
			goal: '能独立写出一个带数据库的接口', time: '每周 6 小时', unknowns: '不知道从哪开始',
			prior: '看过两集视频教程', can: '能照着抄一个 hello world，写注解就卡住',
			stuck: '依赖注入最痛：不知道该把谁注给谁', start: { tier: 2, can: '能照抄' },
			answers: [{ q: 'prior', a: '看过两集视频教程' }, { q: 'can', a: '能照着抄一个 hello world' }], at: '2026-09-01',
		}),
		JSON.stringify({ point: 'programming/vue', topic: 'Vue', level: '认得', goal: '能改页面上的插值', at: '2026-09-02' }),
	].join('\n') + '\n'

	// 终点契约（同一知识点两条版本线：v1 → v2(replaces:1)，迁移后**不许合并/重排**）
	f['learning-records/goals.jsonl'] = [
		JSON.stringify({
			schema: 'whale-goal/1', point: 'spring-boot', pointPath: 'spring-boot', v: 1, tier: 2,
			artifact: { what: '一个能跑的 REST 接口', where: 'code/proj' }, acceptance: ['能 GET /hello 返回文本'],
			focus: [], from: { tier: 2 }, source: 'user', replaces: null, reason: null,
		}),
		JSON.stringify({
			schema: 'whale-goal/1', point: 'spring-boot', pointPath: 'programming/spring-boot', v: 2, tier: 3,
			artifact: { what: '带数据库的接口', where: 'code/proj' }, acceptance: ['能 GET /hello', '能 GET /users'],
			focus: [], from: { tier: 2 }, source: 'user', replaces: 1, reason: '学生把终点抬了一档',
		}),
		JSON.stringify({
			schema: 'whale-goal/1', point: 'vue', pointPath: 'programming/vue', v: 1, tier: 1,
			artifact: { what: '能渲染的页面', where: 'code/vue' }, acceptance: ['页面能看到接口数据'],
			focus: [], from: null, source: 'user', replaces: null, reason: null,
		}),
	].join('\n') + '\n'

	// 证据（point/课号 ← 历史形状；窄课号 / 宽课号 / 已是规范键各一条）
	f['learning-records/evidence.jsonl'] = [
		JSON.stringify({ date: '2026-09-25', lesson: 'spring-boot/0001', challenge: 1, kind: 'run', ref: 'run-0001', note: '第一次真跑起来' }),
		JSON.stringify({ date: null, lesson: 'programming/spring-boot/2', challenge: 2, kind: 'test', ref: null, note: null }),
		JSON.stringify({ date: '2026-09-26', lesson: 'programming/spring-boot/00001', challenge: 3, kind: 'explain', ref: 'q-0002', note: '把控制反转讲清了' }),
		JSON.stringify({ date: '2026-09-27', lesson: 'programming/vue/1001', challenge: 1, kind: 'verbal', ref: null, note: '口头确认' }),
	].join('\n') + '\n'

	// 课后调整（学生原话 + 时间戳字段 ts —— 原样保留，迁移不增删）
	f['learning-records/adjustments.jsonl'] = [
		JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', lesson: 'spring-boot/0002', title: '第2课', adjust: '接口写完了，但不知道 @RestController 和 @Controller 差在哪', lit: false, gaps: ['注解语义'] }),
	].join('\n') + '\n'

	// 教学参数（身份只有单段 circle，没有可迁移的历史形状）
	f['learning-records/teaching.jsonl'] = [
		JSON.stringify({ schema: 'whale-teaching/1', v: 1, replaces: null, reason: null, circle: '*', kind: 'values', tier: 2, params: null, freeText: ['讲慢一点'], source: 'user' }),
	].join('\n') + '\n'

	f['lesson.config.json'] = '{\n  "style": {\n    "source": "raw-html-v2",\n    "slug": "whale-sensei"\n  },\n  "title": "身份迁移夹具"\n}\n'
	f['GLOSSARY.md'] = '# 身份迁移夹具 名词速查笔记（GLOSSARY）\n'
	f['reference/NOTES.html'] = '<!doctype html><html><body>笔记</body></html>\n'
	f['progress.json'] = JSON.stringify({ learned: [], note: '夹具进度' }, null, 2) + '\n'
	return f
}

/** 把一份 {rel: text} 落到磁盘（用守卫 fs，写操作可归因） */
function materialize(rootAbs, files, io) {
	for (const rel of Object.keys(files).sort()) {
		const abs = path.join(rootAbs, ...rel.split('/'))
		io.mkdirSync(path.dirname(abs), { recursive: true })
		io.writeFileSync(abs, files[rel], 'utf8')
	}
}

function fixture(name, mutate) {
	const rootAbs = path.join(TMP, name)
	const files = baseFiles()
	if (typeof mutate === 'function') mutate(files)
	materialize(rootAbs, files, G.fs)
	return { root: rootAbs, files }
}

/* ══════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════ */

const TEMP_PARENT = path.resolve('E:\\Temp')
if (!fs.existsSync(TEMP_PARENT)) {
	// 缺料 → BLOCKED（exit 2），不伪装成 PASS/FAIL
	process.stdout.write(`BLOCKED U05 E:\\Temp 不存在（本卡临时夹具只许落在 E:\\Temp 下的本次唯一目录）：${TEMP_PARENT}\n`)
	process.exit(2)
}

// 证据根**先定、后建临时目录**：BLOCKED 路径不许留下一个空临时目录（拒绝时零残留）
const evidenceChoice = resolveEvidenceRoot(process.argv.slice(2), 'U05', { repoRoot: REPO })
if (!evidenceChoice.ok) {
	process.stdout.write(`BLOCKED U05 --evidence-root 越界：${evidenceChoice.error}\n`)
	process.exit(2)
}
const EVIDENCE = evidenceChoice.root
const TMP = fs.mkdtempSync(path.join(TEMP_PARENT, 'u05-'))
fs.mkdirSync(EVIDENCE, { recursive: true })

/** 进程内写守卫：允许 = 本卡临时目录（含子目录）/ 本卡证据根 / 仓内本卡写集 */
const G = createWriteGuard(fs, [TMP, EVIDENCE])
const io = G.fs

// 探针写自证守卫挂着（不是空壳）：写完立刻能在日志里看到它
io.writeFileSync(path.join(TMP, 'guard-probe.txt'), 'probe\n', 'utf8')
const probeHits = G.log.filter((e) => e.abs === path.join(TMP, 'guard-probe.txt'))
assert.equal(probeHits.length, 1, 'fs 写守卫没挂上（探针写没被记录）—— 可归因断言全部作废')

const requireLib = (rel) => requireCJS(path.join(REPO, ...rel.split('/')))
const M = requireLib(MIGRATION_REL)
const IDENTITY = requireLib('lib/unify/identity.cjs')

/** 依赖锚点（跑前） */
const DEPS_BEFORE = new Map(DEPENDENCY_ANCHORS.map((rel) => [rel, digestFile(path.join(REPO, ...rel.split('/')))]))

/* ══════════════════════════════════════════════════════════════════════
 * 固定八项
 * ══════════════════════════════════════════════════════════════════════ */

const cases = [

	/* ── A01 历史形状清单逐类识别：每类一条断言 + 歧义/孤儿/越界各一条阻断 ── */
	{
		id: 'A01',
		timeoutMs: 240000,
		async run() {
			const seen = []

			const planOf = (fx) => {
				const r = M.planIdentityMigration(fx.root, { fs: io })
				assert.equal(r.ok, true, `计划失败：${r.ok ? '' : r.error}`)
				return r.plan
			}
			const findChange = (plan, file, location, from, to) => plan.changes.find((c) => c.file === file && c.location === location && c.from === from && c.to === to)
			const findBlock = (plan, file, location, from) => plan.blocks.find((b) => b.file === file && b.location === location && (from === undefined || b.from === from))
			const classOf = (plan, id) => plan.classes.find((c) => c.id === id)

			trace('①')
			/* ① 裸 point（intake / goals 的 point 与 pointPath） */
			const fx1 = fixture('a01-bare-point')
			const p1 = planOf(fx1)
			assert.ok(findChange(p1, 'learning-records/intake.jsonl', 'L1:point', 'spring-boot', 'programming/spring-boot'), '裸 point 没被归一（intake.point）')
			assert.ok(findChange(p1, 'learning-records/goals.jsonl', 'L1:point', 'spring-boot', 'programming/spring-boot'), '裸 point 没被归一（goals.point）')
			assert.ok(findChange(p1, 'learning-records/goals.jsonl', 'L1:pointPath', 'spring-boot', 'programming/spring-boot'), '裸 pointPath 没被归一')
			assert.ok(findChange(p1, 'learning-records/goals.jsonl', 'L3:point', 'vue', 'programming/vue'), '裸 point（第二圆圈）没被归一')
			assert.ok(classOf(p1, 'bare-point') && classOf(p1, 'bare-point').verdict === 'normalize', 'classes 里没有 bare-point=normalize')
			assert.equal(p1.blocks.length, 0, `可写台账夹具不该有阻断，实得 ${p1.blocks.length}：${JSON.stringify(p1.blocks[0] || null)}`)
			seen.push('bare-point')

			trace('②')
			/* ② point/课号（缺圆圈） */
			assert.ok(findChange(p1, 'learning-records/evidence.jsonl', 'L1:lesson', 'spring-boot/0001', 'programming/spring-boot/0001'), 'point/课号 没被补齐圆圈')
			assert.ok(classOf(p1, 'point-lesson') && classOf(p1, 'point-lesson').verdict === 'normalize', 'classes 里没有 point-lesson=normalize')
			seen.push('point-lesson')

			trace('③')
			/* ③ 1–5 位历史课号：窄（1 位）/宽（5 位） */
			assert.ok(findChange(p1, 'learning-records/evidence.jsonl', 'L2:lesson', 'programming/spring-boot/2', 'programming/spring-boot/0002'), '窄课号（1 位）没被补零归一')
			assert.ok(classOf(p1, 'narrow-lesson-number') && classOf(p1, 'narrow-lesson-number').verdict === 'normalize', 'classes 里没有 narrow-lesson-number=normalize')
			assert.ok(findChange(p1, 'learning-records/evidence.jsonl', 'L3:lesson', 'programming/spring-boot/00001', 'programming/spring-boot/0001'), '宽课号（5 位）没被折算归一')
			assert.ok(classOf(p1, 'wide-lesson-number') && classOf(p1, 'wide-lesson-number').verdict === 'normalize', 'classes 里没有 wide-lesson-number=normalize')
			seen.push('narrow-lesson-number', 'wide-lesson-number')

			trace('④')
			/* ④ 已经是规范身份 → 不动（逐字节保留） */
			assert.equal(findChange(p1, 'learning-records/evidence.jsonl', 'L4:lesson', 'programming/vue/1001', undefined), undefined, '规范课次键被改动了')
			assert.ok(classOf(p1, 'canonical-lesson'), 'classes 里没有 canonical-lesson')
			assert.equal(p1.changes.filter((c) => c.file === 'learning-records/evidence.jsonl').length, 3, '证据台账应恰好 3 条变更（L4 是规范键）')
			seen.push('canonical-lesson')

			trace('⑤')
			/* ⑤ 两段点键落在课程位：点只有一门课时归一 */
			const fx2 = fixture('a01-point-in-lesson-slot', (files) => {
				files['learning-records/adjustments.jsonl'] = JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', lesson: 'programming/vue', title: 'Vue', adjust: '点键被写在课程位', lit: false, gaps: [] }) + '\n'
			})
			const p2 = planOf(fx2)
			assert.ok(findChange(p2, 'learning-records/adjustments.jsonl', 'L1:lesson', 'programming/vue', 'programming/vue/1001'), '点键落在课程位（唯一课程）没被归一')
			assert.ok(classOf(p2, 'point-in-lesson-slot') && classOf(p2, 'point-in-lesson-slot').verdict === 'normalize', 'classes 里没有 point-in-lesson-slot=normalize')
			seen.push('point-in-lesson-slot')

			trace('⑥')
			/* ⑥ 显示名（glossary/questions）→ 识别 + 阻断（派生重建缺失） */
			const fx3 = fixture('a01-display-name', (files) => {
				files['assets/glossary-data.js'] = glossaryJs({
					bean: { label: 'Bean', category: '容器', official: '由容器管理的对象', short: '容器替你 new 的东西', analogy: '像图书馆替你保管的书', lesson: '第1课' },
					di: { label: '依赖注入', category: '容器', official: '由容器把依赖传给你', short: '不用自己 new', analogy: '像外卖直接送到手上', lesson: 'Vue 第1课' },
				})
			})
			const p3 = planOf(fx3)
			const b3 = findBlock(p3, 'assets/glossary-data.js', 'bean.lesson', '第1课')
			assert.ok(b3, '显示名（glossary lesson）没被识别/阻断')
			assert.deepEqual(b3.candidates, ['programming/spring-boot/0001'], `显示名解析候选不对：${JSON.stringify(b3.candidates)}`)
			assert.match(b3.error, /blocked-rebuild-missing/, '显示名阻断没说明"派生重建缺失"')
			assert.ok(findBlock(p3, 'assets/glossary-data.js', 'di.lesson', 'Vue 第1课'), '带知识点前缀的显示名（Vue 第1课）没被识别')
			assert.equal(classOf(p3, 'display-name').verdict, 'block', 'classes 里 display-name 应是 block')
			seen.push('display-name')

			trace('⑦')
			/* ⑦ 旧平铺路径（practice-data.byFile）→ 识别 + 阻断 */
			const fx4 = fixture('a01-legacy-flat-path', (files) => {
				files['assets/practice-data.js'] = practiceJs({
					version: 2, keyScheme: 'lesson-id', source: 'learning-records/state.json',
					lessons: { 'spring-boot/0001': { id: 'spring-boot/0001', title: '第1课', summary: { achieved: 0, total: 2, needsReview: 0 }, challenges: [] } },
					byFile: { 'lessons/0001-hello.html': 'spring-boot/0001' },
				})
			})
			const p4 = planOf(fx4)
			const b4 = p4.blocks.filter((b) => b.file === 'assets/practice-data.js' && b.location === 'byFile[lessons/0001-hello.html]#path')
			assert.ok(b4.length >= 1, '旧平铺路径（byFile 键）没被识别')
			assert.ok(b4.some((b) => JSON.stringify(b.candidates) === JSON.stringify(['programming/spring-boot/0001'])), `旧平铺路径归属候选不对：${JSON.stringify(b4.map((b) => b.candidates))}`)
			assert.ok(classOf(p4, 'legacy-flat-path') && classOf(p4, 'legacy-flat-path').verdict === 'block', 'classes 里 legacy-flat-path 应是 block')
			assert.ok(findBlock(p4, 'assets/practice-data.js', 'lessons[spring-boot/0001]#key', 'spring-boot/0001'), 'practice-data 的课次键（point/NNNN）没被识别为待归一')
			seen.push('legacy-flat-path')

			trace('⑧')
			/* ⑧ 裸课号（practice-data v1 的键）→ 识别（唯一候选时可归一，但派生文件仍阻断） */
			const fx5 = fixture('a01-bare-lesson-number', (files) => {
				files['assets/practice-data.js'] = practiceJs({
					version: 1, source: 'learning-records/state.json',
					lessons: { 1: { id: 'spring-boot/0001', title: '第1课', summary: { achieved: 0, total: 2, needsReview: 0 }, challenges: [] } },
					byFile: {},
				})
			})
			const p5 = planOf(fx5)
			const b5 = findBlock(p5, 'assets/practice-data.js', 'lessons[1]#key', '1')
			assert.ok(b5, '裸课号（practice-data v1 的键）没被识别')
			assert.deepEqual(b5.candidates, ['programming/spring-boot/0001'], `裸课号候选不对：${JSON.stringify(b5.candidates)}`)
			assert.ok(classOf(p5, 'bare-lesson-number') && classOf(p5, 'bare-lesson-number').verdict === 'block', 'classes 里 bare-lesson-number 应是 block')
			seen.push('bare-lesson-number')

			trace('⑨')
			/* ⑨ 哨兵「未归课」不是身份 → 原样保留（不归一、不阻断） */
			const fx6 = fixture('a01-sentinel', (files) => {
				files['notes/notes.jsonl'] = [
					JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: '未归课', text: '没归到课的笔记' }),
				].join('\n') + '\n'
			})
			const p6 = planOf(fx6)
			assert.equal(p6.blocks.filter((b) => b.location === 'L1:anchor').length, 0, '未归课 哨兵被当成身份了（不应阻断）')
			assert.ok(classOf(p6, 'sentinel'), 'classes 里没有 sentinel')
			seen.push('sentinel')

			trace('⑩')
			/* ⑩ 阻断断言之一：歧义（同一知识点名在两个圆圈里都有） */
			const fx7 = fixture('a01-ambiguous', (files) => {
				files['lessons/frontend/halo.json'] = JSON.stringify({ id: 'frontend', name: '前端' }, null, 2) + '\n'
				files['lessons/frontend/vue/point.json'] = JSON.stringify({ point: 'vue', label: 'Vue', fileBase: 0 }, null, 2) + '\n'
				files['lessons/frontend/vue/0001-page.html'] = '<html>frontend vue</html>\n'
				files['learning-records/intake.jsonl'] = JSON.stringify({ point: 'vue', level: '认得', goal: '能改页面', at: '2026-09-03' }) + '\n'
			})
			const p7 = planOf(fx7)
			const b7 = p7.blocks.find((b) => /ambiguous/.test(b.error))
			assert.ok(b7, '歧义（裸知识点跨两个圆圈）没被阻断')
			assert.equal(b7.from, 'vue')
			assert.deepEqual(b7.candidates, ['frontend/vue', 'programming/vue'], `歧义候选不对：${JSON.stringify(b7.candidates)}`)
			seen.push('ambiguous')

			trace('⑪')
			/* ⑪ 阻断断言之二：孤儿引用（课次不存在） */
			const fx8 = fixture('a01-orphan', (files) => {
				files['learning-records/evidence.jsonl'] = JSON.stringify({ date: '2026-09-29', lesson: 'spring-boot/0009', challenge: 1, kind: 'run', ref: null, note: '孤儿' }) + '\n'
			})
			const p8 = planOf(fx8)
			const b8 = p8.blocks.find((b) => /orphan/.test(b.error))
			assert.ok(b8, '孤儿课次引用没被阻断')
			assert.equal(b8.from, 'spring-boot/0009')
			assert.deepEqual(b8.candidates, ['programming/spring-boot/0001', 'programming/spring-boot/0002'], `孤儿定位候选不对：${JSON.stringify(b8.candidates)}`)
			seen.push('orphan')

			trace('⑫')
			/* ⑫ 阻断断言之三：越界课号（>9999 / 0） */
			const fx9 = fixture('a01-out-of-range', (files) => {
				files['learning-records/evidence.jsonl'] = [
					JSON.stringify({ date: null, lesson: 'programming/spring-boot/10000', challenge: 1, kind: 'run', ref: null, note: '越界' }),
					JSON.stringify({ date: null, lesson: 'spring-boot/0', challenge: 1, kind: 'run', ref: null, note: '零课号' }),
				].join('\n') + '\n'
			})
			const p9 = planOf(fx9)
			const b9 = p9.blocks.filter((b) => /out-of-range/.test(b.error))
			assert.equal(b9.length, 2, `越界课号应各断一条（实得 ${b9.length}）：${JSON.stringify(p9.blocks.map((b) => b.error))}`)
			assert.ok(b9.some((b) => b.from === 'programming/spring-boot/10000'), '10000（五位但超上限）没被识别为越界')
			assert.ok(b9.some((b) => b.from === 'spring-boot/0'), '0（零课号）没被识别为越界')
			seen.push('out-of-range')

			trace('⑬')
			/* ⑬ 阻断断言之四：点键不能扩展成多门已学课程 */
			const fx10 = fixture('a01-point-many-lessons', (files) => {
				files['learning-records/adjustments.jsonl'] = JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', lesson: 'programming/spring-boot', title: 'x', adjust: '点键指向两门课', lit: false, gaps: [] }) + '\n'
			})
			const p10 = planOf(fx10)
			const b10 = p10.blocks.find((b) => /ambiguous-lesson/.test(b.error))
			assert.ok(b10, '点键扩展成多门课程没被阻断')
			assert.deepEqual(b10.candidates, ['programming/spring-boot/0001', 'programming/spring-boot/0002'], `多门课候选不对：${JSON.stringify(b10.candidates)}`)
			seen.push('point-many-lessons')

			trace('⑭')
			/* ⑭ 另外两个"派生重建缺失"的文件：notes.anchor 与 questions.lesson 各自被识别并阻断 */
			const fx11 = fixture('a01-blocked-derived', (files) => {
				files['notes/notes.jsonl'] = [
					JSON.stringify({ id: '0001', seq: 1, kind: '笔记', anchor: 'spring-boot/0001', text: '第1课记的笔记' }),
				].join('\n') + '\n'
				files['assets/questions-data.js'] = questionsJs([{
					id: '0001', date: '2026-09-25', lesson: '第1课', question: '组件扫描从哪开始？',
					section: '第1课 答疑', answer: '从启动类所在包往下扫。',
				}])
			})
			const p11 = planOf(fx11)
			const noteBlock = p11.blocks.find((b) => b.file === 'notes/notes.jsonl' && b.location === 'L1:anchor')
			assert.ok(noteBlock, 'notes.anchor（星图课次键）没被识别')
			assert.deepEqual(noteBlock.candidates, ['programming/spring-boot/0001'], `notes 候选不对：${JSON.stringify(noteBlock.candidates)}`)
			assert.match(noteBlock.error, /blocked-rebuild-missing/, 'notes 阻断没说明"派生重建缺失"')
			const qBlock = p11.blocks.find((b) => b.file === 'assets/questions-data.js' && b.location === '0001.lesson')
			assert.ok(qBlock, 'questions-data.lesson（显示名）没被识别')
			assert.deepEqual(qBlock.candidates, ['programming/spring-boot/0001'], `questions 候选不对：${JSON.stringify(qBlock.candidates)}`)
			// questions 里那些**不是**身份的位置必须原样忽略（页面锚点 q0001 / 路径 / 显示分段）
			assert.equal(
				p11.blocks.filter((b) => b.file === 'assets/questions-data.js' && /anchor|page|section/.test(b.location)).length,
				0, '把 questions-data 里的页面锚点/路径/显示分段当成身份了',
			)
			seen.push('notes-anchor', 'questions-display')

			trace('⑮')
			/* ⑮ 计划里的列形状：变更恰好 {file,location,from,to}；阻断恰好 {file,location,from,candidates,error} */
			for (const plan of [p1, p3, p4, p11]) {
				for (const c of plan.changes) assert.deepEqual(Object.keys(c), ['file', 'location', 'from', 'to'], `变更列的键集不对：${JSON.stringify(Object.keys(c))}`)
				for (const b of plan.blocks) assert.deepEqual(Object.keys(b), ['file', 'location', 'from', 'candidates', 'error'], `阻断列的键集不对：${JSON.stringify(Object.keys(b))}`)
				// 两列都必须按 file+location 升序去重（确定性：同一输入 → 同一计划）
				const keysOf = (list) => list.map((x) => `${x.file}\u0000${x.location}`)
				for (const list of [plan.changes, plan.blocks]) {
					const keys = keysOf(list)
					assert.deepEqual(keys, [...keys].sort(), '计划里的列没有按 file+location 升序排列')
					assert.equal(new Set(keys).size, keys.length, '计划里出现重复的 (file,location)')
				}
			}

			trace('⑯')
			/* ⑯ 只读核验台账（teaching.jsonl）坏行 → 用 U03 的五态读法判 invalid 并阻断整次 apply */
			const fx12 = fixture('a01-invalid-teaching', (files) => {
				files['learning-records/teaching.jsonl'] = '{"schema":"whale-teaching/1","circle":"*","kind":"values","v":1}\n{"circle": nope}\n'
			})
			const p12 = planOf(fx12)
			const b12 = p12.blocks.find((b) => b.file === 'learning-records/teaching.jsonl')
			assert.ok(b12, '坏 teaching.jsonl（第 2 行不是 JSON）没被阻断')
			assert.match(b12.error, /unparsable-ledger/, 'teaching 阻断原因不是 unparsable-ledger')
			assert.match(b12.error, /invalid/, 'teaching 阻断没走 U03 的五态（应报 invalid）')
			seen.push('invalid-readonly-ledger')

			trace('⑰')
			/* ⑰ 版本链不可证明同源 ⇒ 不许合并：不同原始 point 归一后撞在同一个 (point, v) 上 → 整次阻断 */
			const fx13 = fixture('a01-version-chain', (files) => {
				files['learning-records/goals.jsonl'] = [
					JSON.stringify({ schema: 'whale-goal/1', point: 'vue', pointPath: 'vue', v: 1, tier: 1, artifact: { what: '能改页面', where: 'code/vue' }, acceptance: ['页面能看到数据'], focus: [], from: null, source: 'user', replaces: null, reason: null }),
					JSON.stringify({ schema: 'whale-goal/1', point: 'programming/vue', pointPath: 'programming/vue', v: 1, tier: 2, artifact: { what: '能写组件', where: 'code/vue' }, acceptance: ['能拆组件'], focus: [], from: null, source: 'user', replaces: null, reason: null }),
				].join('\n') + '\n'
			})
			const p13 = planOf(fx13)
			const b13 = p13.blocks.find((b) => /version-chain-collision/.test(b.error))
			assert.ok(b13, '两条不可证明同源的版本链归一后相撞，没被阻断')
			assert.equal(b13.location, 'L2:point', `版本链相撞的定位不对：${b13.location}`)
			assert.deepEqual(b13.candidates, ['programming/vue'], `版本链相撞的候选不对：${JSON.stringify(b13.candidates)}`)
			assert.ok(p13.classes.find((c) => c.id === 'version-chain-collision' && c.verdict === 'block'), 'classes 里没有 version-chain-collision=block')
			seen.push('version-chain-collision')

			writeJson(path.join(EVIDENCE, 'a01-shapes.json'), { seen, classes: p1.classes, blocksP3: p3.blocks, blocksP4: p4.blocks, blocksP11: p11.blocks, blocksP12: p12.blocks })
			return { note: `classes=${seen.length} 类` }
		},
	},

	/* ── A02 plan 对夹具目录逐字节零修改 ─────────────────────────────────── */
	{
		id: 'A02',
		timeoutMs: 180000,
		async run() {
			const fx = fixture('a02-plan-zero-write', (files) => {
				files['assets/glossary-data.js'] = glossaryJs({
					bean: { label: 'Bean', category: '容器', official: '由容器管理的对象', short: '容器替你 new 的', analogy: '图书馆替你保管的书', lesson: '第1课' },
				})
			})
			const before = treeManifest(fx.root)
			const beforeDigest = manifestDigest(before)
			const dirsBefore = before.filter((r) => r.type === 'dir').length

			G.reset()
			const p = M.planIdentityMigration(fx.root, { fs: io })
			const writes = G.log.slice()
			assert.equal(p.ok, true, '计划失败')
			const after = treeManifest(fx.root)
			const afterDigest = manifestDigest(after)

			assert.equal(afterDigest, beforeDigest, `plan 改动了夹具目录：${JSON.stringify(firstManifestDiff(before, after))}`)
			assert.equal(after.filter((r) => r.type === 'dir').length, dirsBefore, 'plan 建了目录（计划必须零写）')
			assert.equal(writes.length, 0, `plan 期间出现了 ${writes.length} 次写调用：${JSON.stringify(writes.slice(0, 3))}`)
			assert.equal(fs.existsSync(path.join(fx.root, '.backup')), false, 'plan 建了 .backup（计划必须零写）')
			assert.equal(fs.existsSync(path.join(fx.root, '.whale-txn')), false, 'plan 建了 .whale-txn（计划必须零写）')
			assert.equal(fs.existsSync(path.join(fx.root, '.whale-write.lock')), false, 'plan 加了锁（计划必须零写）')
			assert.match(p.plan.planDigest, /^[0-9a-f]{64}$/, 'planDigest 不是 sha256 hex64')

			// 同一输入两次计划 → 逐字段相同（可复算）
			const again = M.planIdentityMigration(fx.root, { fs: io })
			assert.equal(again.plan.planDigest, p.plan.planDigest, '同一输入两次计划摘要不同（不可复算）')

			writeJson(path.join(EVIDENCE, 'a02-tree.json'), { beforeDigest, afterDigest, files: before.length, dirs: dirsBefore })
			return { note: `tree=${beforeDigest.slice(0, 12)} files=${before.length}` }
		},
	},

	/* ── A03 缺确认 / 缺摘要 / 过期摘要 三条独立拒绝 ────────────────────── */
	{
		id: 'A03',
		timeoutMs: 180000,
		async run() {
			const fx = fixture('a03-gates')
			const p = M.planIdentityMigration(fx.root, { fs: io })
			assert.equal(p.ok, true, '计划失败')
			assert.equal(p.plan.blocks.length, 0, 'A03 夹具不该有阻断')
			const digest = p.plan.planDigest
			const flipped = (digest[0] === 'a' ? 'b' : 'a') + digest.slice(1)
			assert.notEqual(flipped, digest, '摘要翻转失败（判据自身有问题）')
			const before = manifestDigest(treeManifest(fx.root))

			// ① 缺确认
			G.reset()
			const r1 = M.applyIdentityMigration(fx.root, { planDigest: digest, fs: io })
			assert.equal(r1.ok, false, '缺 confirm 却提交了')
			assert.equal(r1.code, 'CONFIRM_REQUIRED', `缺确认的码不是 CONFIRM_REQUIRED（实得 ${r1.code}）`)
			assert.equal(r1.state, 'rejected', '缺确认的回执状态不是 rejected')
			assert.equal(G.log.length, 0, `缺确认时发生了 ${G.log.length} 次写（前置闸必须零写）`)
			assert.equal(manifestDigest(treeManifest(fx.root)), before, '缺确认却改了字节')

			// ② 缺摘要
			G.reset()
			const r2 = M.applyIdentityMigration(fx.root, { confirm: true, fs: io })
			assert.equal(r2.ok, false, '缺 planDigest 却提交了')
			assert.equal(r2.code, 'PLAN_REQUIRED', `缺摘要的码不是 PLAN_REQUIRED（实得 ${r2.code}）`)
			assert.equal(G.log.length, 0, '缺摘要时发生了写（前置闸必须零写）')
			assert.equal(manifestDigest(treeManifest(fx.root)), before, '缺摘要却改了字节')

			// ③ 过期摘要
			G.reset()
			const r3 = M.applyIdentityMigration(fx.root, { confirm: true, planDigest: flipped, fs: io })
			assert.equal(r3.ok, false, '过期 planDigest 却提交了')
			assert.equal(r3.code, 'PLAN_STALE', `过期摘要的码不是 PLAN_STALE（实得 ${r3.code}）`)
			assert.equal(G.log.length, 0, '过期摘要时发生了写（前置闸必须零写）')
			assert.equal(manifestDigest(treeManifest(fx.root)), before, '过期摘要却改了字节')

			// 三个码必须互不相同（不是同一个闸重复报）
			assert.equal(new Set([r1.code, r2.code, r3.code]).size, 3, '三闸的拒绝码重复了（说明没分成三条独立断言）')

			// 正例对照：三条齐了才允许提交（证明上面的拒绝不是"永远拒"）
			const ok = M.applyIdentityMigration(fx.root, { confirm: true, planDigest: digest, fs: io })
			assert.equal(ok.ok, true, `三闸齐了仍然被拒：${ok.code} ${ok.error}`)
			assert.equal(ok.state, 'committed', '成功回执状态不是 committed')
			assert.notEqual(manifestDigest(treeManifest(fx.root)), before, '报告成功但字节没变（伪成功）')

			// ④ CLI 端到端：三种模式都走**参数数组**（plan / apply / rollback），且拒绝时退出码分层
			const fxCli = fixture('a03-cli')
			const planOut = runCli([`--root=${fxCli.root}`, '--plan'])
			assert.equal(planOut.error, null, `CLI 启动失败：${planOut.error}`)
			assert.equal(planOut.status, 0, `CLI --plan 退出码不是 0（${planOut.status}）：${planOut.stdout} ${planOut.stderr}`)
			const planned = /^PLAN ok=true digest=([0-9a-f]{64}) files=(\d+) changes=(\d+) blocks=(\d+)$/m.exec(planOut.stdout)
			assert.ok(planned, `CLI --plan 的 stdout 契约不符：${JSON.stringify(planOut.stdout)}`)
			assert.equal(Number(planned[4]), 0, 'CLI --plan 报告了阻断（A03 夹具不该有阻断）')
			const cliDigest = planned[1]

			const cliNoDigest = runCli([`--root=${fxCli.root}`, '--apply', '--confirm'])
			assert.equal(cliNoDigest.status, 2, `CLI 缺摘要应 exit 2（实得 ${cliNoDigest.status}）：${cliNoDigest.stdout}`)
			assert.match(cliNoDigest.stdout, /^FAIL /m, 'CLI 失败没有 FAIL 行')

			const cliStale = runCli([`--root=${fxCli.root}`, '--apply', '--confirm', `--plan-digest=${flipped}`])
			assert.equal(cliStale.status, 1, `CLI 过期摘要应 exit 1（实得 ${cliStale.status}）：${cliStale.stdout}`)
			assert.match(cliStale.stdout, /PLAN_STALE/, 'CLI 过期摘要没报 PLAN_STALE')

			const cliApply = runCli([`--root=${fxCli.root}`, '--apply', '--confirm', `--plan-digest=${cliDigest}`])
			assert.equal(cliApply.status, 0, `CLI --apply 失败（${cliApply.status}）：${cliApply.stdout} ${cliApply.stderr}`)
			const applied = /^APPLY ok=true digest=([0-9a-f]{64}) replaced=(\d+) backup=(\S+)$/m.exec(cliApply.stdout)
			assert.ok(applied, `CLI --apply 的 stdout 契约不符：${JSON.stringify(cliApply.stdout)}`)
			assert.equal(applied[1], cliDigest, 'CLI --apply 回显的摘要与计划不一致')
			assert.ok(Number(applied[2]) > 0, 'CLI --apply 报告 replaced=0（什么都没改）')
			const cliBackup = applied[3]
			assert.match(readme(path.join(fxCli.root, 'learning-records', 'intake.jsonl')), /"point":"programming\/spring-boot"/, 'CLI --apply 后 intake 的 point 没归一')

			const cliRollback = runCli([`--root=${fxCli.root}`, '--rollback', '--confirm', `--plan-digest=${cliDigest}`, `--backup=${cliBackup}`])
			assert.equal(cliRollback.status, 0, `CLI --rollback 失败（${cliRollback.status}）：${cliRollback.stdout} ${cliRollback.stderr}`)
			assert.match(cliRollback.stdout, /^ROLLBACK ok=true digest=[0-9a-f]{64} restored=\d+ backup=\S+$/m, `CLI --rollback 的 stdout 契约不符：${JSON.stringify(cliRollback.stdout)}`)
			assert.match(readme(path.join(fxCli.root, 'learning-records', 'intake.jsonl')), /"point":"spring-boot"/, 'CLI --rollback 后 intake 没回到写前')

			writeJson(path.join(EVIDENCE, 'a03-gates.json'), {
				refusal: [r1, r2, r3].map((r) => ({ code: r.code, state: r.state })),
				commitState: ok.state,
				cli: { plan: planned[0], apply: applied[0], rollback: cliRollback.stdout.trim() },
			})
			return { note: '3 拒绝 + 1 正例 + CLI 三模式' }
		},
	},

	/* ── A04 歧义 / 孤儿 / 越界 各挡整次 apply（一处坏 → 别的文件一个字节都不动） ── */
	{
		id: 'A04',
		timeoutMs: 240000,
		async run() {
			const report = []
			const runBlocked = (name, mutate, expectCode, expectPattern) => {
				const fx = fixture(name, mutate)
				const p = M.planIdentityMigration(fx.root, { fs: io })
				assert.equal(p.ok, true, `${name}：计划失败`)
				assert.ok(p.plan.blocks.length >= 1, `${name}：应该有阻断，实得 0`)
				const before = treeManifest(fx.root)
				const beforeDigest = manifestDigest(before)
				G.reset()
				const r = M.applyIdentityMigration(fx.root, { confirm: true, planDigest: p.plan.planDigest, fs: io })
				assert.equal(r.ok, false, `${name}：有阻断却提交成功了`)
				assert.equal(r.state, 'rejected', `${name}：阻断回执状态不是 rejected（实得 ${r.state}）`)
				assert.equal(r.code, expectCode, `${name}：阻断码不对（实得 ${r.code} / 期望 ${expectCode}）`)
				assert.match(String(r.error), expectPattern, `${name}：阻断原因不含 ${expectPattern}`)
				const after = treeManifest(fx.root)
				assert.equal(manifestDigest(after), beforeDigest, `${name}：阻断时改了字节：${JSON.stringify(firstManifestDiff(before, after))}`)
				assert.equal(G.log.length, 0, `${name}：阻断时发生了 ${G.log.length} 次写（必须在事务之外拒绝）`)
				report.push({ name, code: r.code, blocks: p.plan.blocks.length, changesPlanned: p.plan.changes.length })
			}

			// ① 歧义：裸知识点在两个圆圈里都有 ⇒ 整次阻断（可写台账本来有 6 条变更，一条都不许落）
			runBlocked('a04-ambiguous', (files) => {
				files['lessons/frontend/halo.json'] = JSON.stringify({ id: 'frontend', name: '前端' }, null, 2) + '\n'
				files['lessons/frontend/vue/point.json'] = JSON.stringify({ point: 'vue', label: 'Vue', fileBase: 0 }, null, 2) + '\n'
				files['lessons/frontend/vue/0001-page.html'] = '<html>frontend vue</html>\n'
			}, 'ID_AMBIGUOUS', /ambiguous/)

			// ② 孤儿引用
			runBlocked('a04-orphan', (files) => {
				files['learning-records/evidence.jsonl'] += JSON.stringify({ date: '2026-09-29', lesson: 'spring-boot/0009', challenge: 1, kind: 'run', ref: null, note: '孤儿' }) + '\n'
			}, 'MIGRATION_FAILED', /orphan/)

			// ③ 越界课号
			runBlocked('a04-out-of-range', (files) => {
				files['learning-records/evidence.jsonl'] += JSON.stringify({ date: null, lesson: 'programming/spring-boot/10000', challenge: 1, kind: 'run', ref: null, note: '越界课号' }) + '\n'
			}, 'MIGRATION_FAILED', /out-of-range/)

			writeJson(path.join(EVIDENCE, 'a04-blocks.json'), report)
			return { note: report.map((r) => `${r.name}:${r.code}`).join(' ') }
		},
	},

	/* ── A05 引用闭包完整 + 学生原话/日期/顺序/版本链逐字保留 ───────────── */
	{
		id: 'A05',
		timeoutMs: 240000,
		async run() {
			const fx = fixture('a05-closure')
			const beforeFiles = { ...fx.files }
			const p = M.planIdentityMigration(fx.root, { fs: io })
			assert.equal(p.ok, true, '计划失败')
			assert.equal(p.plan.blocks.length, 0, 'A05 夹具不该有阻断')
			const applied = M.applyIdentityMigration(fx.root, { confirm: true, planDigest: p.plan.planDigest, fs: io })
			assert.equal(applied.ok, true, `apply 失败：${applied.code} ${applied.error}`)

			const parseLines = (rel) => readme(path.join(fx.root, ...rel.split('/'))).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
			const beforeLines = (rel) => beforeFiles[rel].replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

			// ① 行数 / 顺序 / 键集不变
			for (const rel of ['learning-records/intake.jsonl', 'learning-records/goals.jsonl', 'learning-records/evidence.jsonl', 'learning-records/adjustments.jsonl']) {
				const a = beforeLines(rel)
				const b = parseLines(rel)
				assert.equal(b.length, a.length, `${rel} 行数变了（${a.length} → ${b.length}）`)
				for (let i = 0; i < a.length; i += 1) {
					assert.deepEqual(Object.keys(b[i]), Object.keys(a[i]), `${rel} 第 ${i + 1} 行的键集/键序变了`)
				}
			}

			// ② 学生原话 / 日期 / ts 逐字不动（只允许身份字段变）
			const intakeA = beforeLines('learning-records/intake.jsonl')
			const intakeB = parseLines('learning-records/intake.jsonl')
			const PROSE = ['topic', 'level', 'background', 'goal', 'time', 'unknowns', 'prior', 'can', 'stuck', 'start', 'answers', 'at']
			for (let i = 0; i < intakeA.length; i += 1) {
				for (const key of PROSE) {
					assert.deepEqual(intakeB[i][key], intakeA[i][key], `intake 第 ${i + 1} 行的 ${key} 被改动了（学生原话必须逐字保留）`)
				}
				assert.equal(intakeB[i].point, intakeA[i].point === 'spring-boot' ? 'programming/spring-boot' : 'programming/vue', `intake 第 ${i + 1} 行的 point 没归一`)
			}

			const goalsA = beforeLines('learning-records/goals.jsonl')
			const goalsB = parseLines('learning-records/goals.jsonl')
			for (let i = 0; i < goalsA.length; i += 1) {
				for (const key of ['schema', 'v', 'tier', 'artifact', 'acceptance', 'focus', 'from', 'source', 'replaces', 'reason']) {
					assert.deepEqual(goalsB[i][key], goalsA[i][key], `goals 第 ${i + 1} 行的 ${key} 被改动了（版本链不许合并/重排）`)
				}
			}
			// 版本链：spring-boot 的两条 v1/v2(replaces:1) 仍在，且顺序未变
			const sbVersions = goalsB.filter((g) => g.point === 'programming/spring-boot').map((g) => `${g.v}/${g.replaces}`)
			assert.deepEqual(sbVersions, ['1/null', '2/1'], `goals 版本链被破坏：${JSON.stringify(sbVersions)}`)

			const evA = beforeLines('learning-records/evidence.jsonl')
			const evB = parseLines('learning-records/evidence.jsonl')
			for (let i = 0; i < evA.length; i += 1) {
				for (const key of ['date', 'challenge', 'kind', 'ref', 'note']) {
					assert.deepEqual(evB[i][key], evA[i][key], `evidence 第 ${i + 1} 行的 ${key} 被改动了`)
				}
			}
			const adjA = beforeLines('learning-records/adjustments.jsonl')
			const adjB = parseLines('learning-records/adjustments.jsonl')
			for (const key of ['ts', 'title', 'adjust', 'lit', 'gaps']) {
				assert.deepEqual(adjB[0][key], adjA[0][key], `adjustments 的 ${key} 被改动了（学生原话/时间戳必须保留）`)
			}

			// ③ 引用闭包：迁移后每一条身份引用都是**规范形状**且能在课程结构里解析
			const allValues = []
			for (const rel of ['learning-records/intake.jsonl', 'learning-records/goals.jsonl', 'learning-records/adjustments.jsonl']) {
				for (const line of parseLines(rel)) {
					for (const key of ['point', 'pointPath', 'lesson']) {
						if (typeof line[key] === 'string' && line[key]) allValues.push({ rel, key, value: line[key] })
					}
				}
			}
			for (const line of parseLines('learning-records/evidence.jsonl')) allValues.push({ rel: 'learning-records/evidence.jsonl', key: 'lesson', value: line.lesson })
			for (const v of allValues) {
				const isLesson = v.key === 'lesson'
				const parsed = isLesson ? IDENTITY.parseLessonKey(v.value) : IDENTITY.parsePointKey(v.value)
				assert.equal(parsed.ok, true, `${v.rel} 的 ${v.key}=${JSON.stringify(v.value)} 迁移后仍不是规范身份：${parsed.ok ? '' : parsed.failure.error}`)
			}
			// 闭包的机器判据：再跑一次计划 → 0 变更 0 阻断（每条引用都已解析到唯一身份）
			const again = M.planIdentityMigration(fx.root, { fs: io })
			assert.equal(again.ok, true, '迁移后重跑计划失败')
			assert.equal(again.plan.changes.length, 0, `迁移后仍有 ${again.plan.changes.length} 条可归一（引用闭包不完整）`)
			assert.equal(again.plan.blocks.length, 0, `迁移后有 ${again.plan.blocks.length} 条阻断`)
			// 幂等：再次 apply 必须被拒（nothing to migrate，不许写字节）
			const manBefore = manifestDigest(treeManifest(fx.root))
			const twice = M.applyIdentityMigration(fx.root, { confirm: true, planDigest: again.plan.planDigest, fs: io })
			assert.equal(twice.ok, false, '迁移后再 apply 却"成功"了（伪成功）')
			assert.equal(manifestDigest(treeManifest(fx.root)), manBefore, '二次 apply 改了字节')

			// ④ 目标台账没有新增时间戳类字段（键集上面已逐行比对），备份清单也不含时间戳
			const manifestText = readme(path.join(fx.root, ...p.plan.manifest.file.split('/')))
			assert.equal(/"(createdAt|updatedAt|migratedAt|ts)"\s*:/.test(manifestText), false, '备份清单里出现了时间戳字段')

			writeJson(path.join(EVIDENCE, 'a05-closure.json'), {
				changes: p.plan.changes, closure: { changes: again.plan.changes.length, blocks: again.plan.blocks.length },
				backupDir: p.plan.backup.dir,
			})
			return { note: `changes=${p.plan.changes.length} 闭包=0` }
		},
	},

	/* ── A06 构建 / 备份 / 提交故障不留下伪成功；回滚拒绝覆盖后续修改 ───── */
	{
		id: 'A06',
		timeoutMs: 300000,
		async run() {
			// ① 备份写失败（注入 fs：写 .backup 下一律 EACCES）→ 不许替换既有产物
			const fx1 = fixture('a06-backup-fail')
			const p1 = M.planIdentityMigration(fx1.root, { fs: io })
			assert.equal(p1.ok, true, '计划失败')
			assert.equal(p1.plan.blocks.length, 0, 'A06 夹具不该有阻断')
			const before1 = treeManifest(fx1.root)
			const failingFs = { ...G.fs }
			// 只让"往 .backup/ 里**写内容**"失败（备份材料落不下去）；读写删除的其它能力照常，
			// 否则回滚路径自己也会被这个注入打死，判据就测不到"备份失败 → 不替换产物"
			for (const api of ['writeFileSync', 'appendFileSync']) {
				failingFs[api] = (...args) => {
					const target = String(args[0])
					if (target.includes(`${path.sep}.backup${path.sep}`) || target.includes('/.backup/')) {
						const e = new Error(`EACCES: 注入的备份写故障（${api}）`)
						e.code = 'EACCES'
						throw e
					}
					return G.fs[api].apply(G.fs, args)
				}
			}
			const r1 = M.applyIdentityMigration(fx1.root, { confirm: true, planDigest: p1.plan.planDigest, fs: failingFs })
			assert.equal(r1.ok, false, '备份写失败却报告成功（伪成功）')
			assert.ok(['rejected', 'rolled-back'].includes(r1.state), `备份写失败的态不对：${r1.state}`)
			const tolerated1 = assertTreeIntact(before1, treeManifest(fx1.root), { allowEmptyDirsUnder: p1.plan.backup.dir })

			// ② 构建故障（注入的受信重建 build 抛错）→ 一个字节都不动
			const fx2 = fixture('a06-build-fail')
			const p2 = M.planIdentityMigration(fx2.root, { fs: io })
			const before2 = manifestDigest(treeManifest(fx2.root))
			const r2 = M.applyIdentityMigration(fx2.root, {
				confirm: true, planDigest: p2.plan.planDigest, fs: io,
				build: () => { throw new Error('注入的受信重建故障：材料不齐') },
			})
			assert.equal(r2.ok, false, '构建故障却报告成功（伪成功）')
			assert.equal(r2.state, 'rejected', `构建故障的态不对：${r2.state}`)
			assert.match(String(r2.error), /注入的受信重建故障/, '构建故障的原因没透出来')
			assert.equal(manifestDigest(treeManifest(fx2.root)), before2, '构建故障却改了字节')

			// ③ 回滚拒绝覆盖后续修改
			const fx3 = fixture('a06-rollback-guard')
			const p3 = M.planIdentityMigration(fx3.root, { fs: io })
			const ok3 = M.applyIdentityMigration(fx3.root, { confirm: true, planDigest: p3.plan.planDigest, fs: io })
			assert.equal(ok3.ok, true, `apply 失败：${ok3.code} ${ok3.error}`)
			const targetRel = 'learning-records/evidence.jsonl'
			const targetAbs = path.join(fx3.root, ...targetRel.split('/'))
			io.appendFileSync(targetAbs, JSON.stringify({ date: '2026-10-01', lesson: 'programming/spring-boot/0002', challenge: 9, kind: 'run', ref: null, note: '迁移后又追加了一条' }) + '\n', 'utf8')
			const afterEdit = digestFile(targetAbs)
			const rb = M.rollbackIdentityMigration(fx3.root, {
				confirm: true, planDigest: p3.plan.planDigest, backupDir: p3.plan.backup.dir, fs: io,
			})
			assert.equal(rb.ok, false, '迁移后被改过，回滚却成功了（会覆盖后续修改）')
			assert.equal(rb.code, 'PLAN_STALE', `回滚拒绝的码不对：${rb.code}`)
			assert.match(String(rb.error + rb.failure?.error), /被改过|后续修改/, '回滚拒绝原因没说清"后续修改"')
			assert.equal(digestFile(targetAbs), afterEdit, '回滚被拒后仍然改了字节')

			// 正例对照：不改动时回滚成功，且逐字节回到写前
			const fx4 = fixture('a06-rollback-ok')
			const p4 = M.planIdentityMigration(fx4.root, { fs: io })
			const orig = readme(path.join(fx4.root, 'learning-records/intake.jsonl'))
			const ok4 = M.applyIdentityMigration(fx4.root, { confirm: true, planDigest: p4.plan.planDigest, fs: io })
			assert.equal(ok4.ok, true, `apply 失败：${ok4.error}`)
			const rb4 = M.rollbackIdentityMigration(fx4.root, { confirm: true, planDigest: p4.plan.planDigest, backupDir: p4.plan.backup.dir, fs: io })
			assert.equal(rb4.ok, true, `未被改动的回滚也失败了：${rb4.code} ${rb4.error}`)
			assert.equal(readme(path.join(fx4.root, 'learning-records/intake.jsonl')), orig, '回滚后没有逐字节回到写前')

			writeJson(path.join(EVIDENCE, 'a06-faults.json'), {
				backupFail: { state: r1.state, code: r1.code, toleratedDirs: tolerated1 }, buildFail: { state: r2.state, code: r2.code },
				rollbackRefused: { state: rb.state, code: rb.code }, rollbackOk: rb4.state,
			})
			return { note: '备份/构建故障 + 回滚双态' }
		},
	},

	/* ── A07 临时移除摘要核对后判据必须抓到（E:\Temp 副本；干净副本对照） ── */
	{
		id: 'A07',
		timeoutMs: 600000,
		async run() {
			// 子进程模式：不递归做变异，直接复演"过期摘要必须被拒"（变异移除的正是这条）
			if (CHILD) {
				const fx = fixture('a07-child-gate')
				const p = M.planIdentityMigration(fx.root, { fs: io })
				assert.equal(p.ok, true, '子进程：计划失败')
				const flipped = (p.plan.planDigest[0] === 'a' ? 'b' : 'a') + p.plan.planDigest.slice(1)
				const before = manifestDigest(treeManifest(fx.root))
				const r = M.applyIdentityMigration(fx.root, { confirm: true, planDigest: flipped, fs: io })
				assert.equal(r.ok, false, '子进程：过期摘要被放行了（摘要核对缺失）')
				assert.equal(r.code, 'PLAN_STALE', `子进程：过期摘要的码不对（${r.code}）`)
				assert.equal(manifestDigest(treeManifest(fx.root)), before, '子进程：过期摘要仍改了字节')
				return { note: 'child gate replay' }
			}

			const FILES = [
				'lib/unify/migration.cjs', 'lib/unify/identity.cjs', 'lib/unify/errors.cjs',
				'lib/unify/ledger-read.cjs', 'lib/unify/commit.cjs',
				'lib/pack-template/tools/ledger-transaction.cjs',
				'tools/migrate-pack.mjs', 'test/audit/U05.mjs', 'test/audit/unify-runner.mjs',
				'docs/unify/interfaces.md',
			]
			const copyInto = (dest) => {
				for (const rel of FILES) {
					const abs = path.join(dest, ...rel.split('/'))
					io.mkdirSync(path.dirname(abs), { recursive: true })
					io.copyFileSync(path.join(REPO, ...rel.split('/')), abs)
				}
			}
			const runChild = (dirAbs, label) => {
				const ev = path.join(TMP, `evidence-child-${label}`, `U05-${label}`)
				io.mkdirSync(ev, { recursive: true })
				const res = spawnSync(process.execPath, [path.join(dirAbs, 'test', 'audit', 'U05.mjs'), `--evidence-root=${ev}`], {
					cwd: dirAbs,
					env: { ...process.env, U05_A07_CHILD: '1' },
					encoding: 'utf8',
					timeout: 420000,
					maxBuffer: 32 * 1024 * 1024,
				})
				return { status: res.status, signal: res.signal, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), error: res.error ? String(res.error.message) : null }
			}

			const cleanDir = path.join(TMP, 'a07-clean')
			copyInto(cleanDir)
			const clean = runChild(cleanDir, 'clean')
			assert.equal(clean.error, null, `干净副本子进程启动失败：${clean.error}`)
			assert.equal(clean.status, 0, `干净副本必须 PASS（实得 exit=${clean.status} signal=${clean.signal}）：${clean.stdout.slice(-600)} ${clean.stderr.slice(-600)}`)
			assert.match(clean.stdout, /^PASS U05 checks=8 failed=0 skipped=0$/m, `干净副本判词不是 PASS U05：${clean.stdout.slice(-300)}`)

			// 变异：删掉"摘要必须与计划一致"这一条核对
			const mutDir = path.join(TMP, 'a07-mutated')
			copyInto(mutDir)
			const mutFile = path.join(mutDir, 'lib', 'unify', 'migration.cjs')
			const original = readme(mutFile)
			const needle = 'if (givenDigest !== plan.planDigest) {'
			const hits = original.split(needle).length - 1
			assert.equal(hits, 1, `变异点定位失败（命中 ${hits} 次，应恰好 1 次）—— A07 的变异不成立`)
			const mutated = original.replace(needle, 'if (false) {')
			assert.notEqual(mutated, original, '变异没写进去')
			io.writeFileSync(mutFile, mutated, 'utf8')
			assert.notEqual(fs.readFileSync(mutFile, 'utf8'), original, '变异文件没落盘')

			const bad = runChild(mutDir, 'mutated')
			assert.equal(bad.error, null, `变异副本子进程启动失败：${bad.error}`)
			assert.notEqual(bad.status, 0, `变异副本仍然 exit 0 —— 判据没抓到"摘要核对被移除"（A07 失效）：${bad.stdout.slice(-400)}`)
			assert.match(bad.stdout, /^FAIL U05 /m, `变异副本判词不是 FAIL U05：${bad.stdout.slice(-400)}`)
			assert.match(bad.stdout, /A0[37]/, `变异副本的失败项没指到摘要闸（A03/A07）：${bad.stdout.slice(-400)}`)

			// 主树里的判据文件一个字节都没动（变异只发生在 E:\Temp 副本里）
			const mainSource = readme(path.join(REPO, 'lib', 'unify', 'migration.cjs'))
			assert.equal(mainSource.split(needle).length - 1, 1, '主树的摘要核对被改动了（变异泄漏回主树）')

			writeJson(path.join(EVIDENCE, 'a07-mutation.json'), {
				mutation: { file: 'lib/unify/migration.cjs', needle, hits },
				clean: { status: clean.status, line: clean.stdout.trim().split('\n')[0] },
				mutated: { status: bad.status, line: bad.stdout.trim().split('\n')[0] },
			})
			return { note: `clean=${clean.status} mutated=${bad.status}` }
		},
	},

	/* ── A08 JS 数据不执行 + 临时目录与证据安全 + 写集可归因 ────────────── */
	{
		id: 'A08',
		timeoutMs: 240000,
		async run() {
			// ① 探针一：UMD 信封里塞会写文件的副作用语句（require 真执行就会落盘）
			const pwnedHead = path.join(TMP, 'PWNED-head.txt')
			const pwnedValue = path.join(TMP, 'PWNED-value.txt')
			const fx1 = fixture('a08-probe-head', (files) => {
				files['assets/glossary-data.js'] = `/**
 * glossary-data.js — 带副作用的探针（迁移**不许**执行它）
 */
(function (root, factory) {
  require('node:fs').writeFileSync(${JSON.stringify(pwnedHead)}, 'pwned-head');
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GLOSSARY = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    bean: {
      label: 'Bean',
      category: '容器',
      official: '由容器管理的对象',
      short: '容器替你 new 的',
      analogy: '图书馆替你保管的书',
      lesson: '第1课'
    }
  };
});
`
			})
			G.reset()
			const p1 = M.planIdentityMigration(fx1.root, { fs: io })
			assert.equal(p1.ok, true, 'A08 探针一：计划失败')
			const headBlocks = p1.plan.blocks.filter((b) => b.file === 'assets/glossary-data.js')
			assert.ok(headBlocks.length >= 1, 'A08 探针一：信封里的副作用代码没被识别为 js-shape-unsafe')
			assert.match(headBlocks[0].error, /js-shape-unsafe/, 'A08 探针一：阻断原因不是 js-shape-unsafe')
			assert.match(headBlocks[0].error, /require|writeFileSync|白名单外/, `A08 探针一：阻断原因没点出可疑标识符：${headBlocks[0].error}`)
			assert.equal(fs.existsSync(pwnedHead), false, 'A08 探针一：JS 数据被执行了（副作用文件落盘）')

			// ② 探针二：副作用藏在 return 的数据字面量里（IIFE）
			const fx2 = fixture('a08-probe-value', (files) => {
				files['assets/glossary-data.js'] = `/**
 * glossary-data.js — 数据字面量里的副作用探针
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GLOSSARY = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    bean: {
      label: 'Bean',
      category: '容器',
      official: '由容器管理的对象',
      short: '容器替你 new 的',
      analogy: '图书馆替你保管的书',
      lesson: (function () { require('node:fs').writeFileSync(${JSON.stringify(pwnedValue)}, 'pwned-value'); return '第1课'; })()
    }
  };
});
`
			})
			const p2 = M.planIdentityMigration(fx2.root, { fs: io })
			assert.equal(p2.ok, true, 'A08 探针二：计划失败')
			const valueBlocks = p2.plan.blocks.filter((b) => b.file === 'assets/glossary-data.js' && /js-shape-unsafe/.test(b.error))
			assert.ok(valueBlocks.length >= 1, 'A08 探针二：数据字面量里的表达式没被拒绝')
			assert.equal(fs.existsSync(pwnedValue), false, 'A08 探针二：JS 数据被执行了（副作用文件落盘）')
			assert.equal(fs.existsSync(pwnedHead), false, 'A08：副作用文件出现在临时目录里')

			// ③ 对照：同样的信封、干净的数据 → 能正常静态读（说明上面的阻断不是"一律拒"）
			const fx3 = fixture('a08-clean-js', (files) => {
				files['assets/glossary-data.js'] = glossaryJs({
					bean: { label: 'Bean', category: '容器', official: '由容器管理的对象', short: '容器替你 new 的', analogy: '图书馆替你保管的书', lesson: 'programming/spring-boot/0001' },
				})
			})
			const p3 = M.planIdentityMigration(fx3.root, { fs: io })
			assert.equal(p3.ok, true, 'A08 对照：干净数据文件计划失败')
			assert.equal(p3.plan.blocks.filter((b) => b.file === 'assets/glossary-data.js').length, 0, 'A08 对照：干净的数据文件被误拒了')
			assert.ok(p3.plan.classes.find((c) => c.id === 'canonical-lesson'), 'A08 对照：干净数据里的规范课次键没被识别为 canonical-lesson')

			// ④ 临时目录与证据安全：守卫拒绝越界删除 / 证据根拒绝越界路径
			const badCleanup = safeRemoveTree(path.join(REPO, 'lib'), { parent: TMP })
			assert.equal(badCleanup.removed, false, '清理守卫放行了仓内目录的递归删除')
			assert.match(String(badCleanup.error), /拒绝清理/, '清理守卫的拒绝理由不对')
			const badGuard = guardTempPath(TMP, { parent: path.dirname(TMP) })
			assert.equal(badGuard.ok, true, '合法临时根被清理守卫误拒')
			const badEvidence = resolveEvidenceRoot([`--evidence-root=${path.join(REPO, 'lib')}`], 'U05', { repoRoot: REPO })
			assert.equal(badEvidence.ok, false, '--evidence-root 放行了仓内 lib/ 目录')
			assert.match(String(badEvidence.error), /越界/, '--evidence-root 的拒绝理由不对')
			const goodEvidence = resolveEvidenceRoot([`--evidence-root=${path.join(TMP, 'U05-probe')}`], 'U05', { repoRoot: REPO })
			assert.equal(goodEvidence.ok, true, '合法的本卡临时证据根被误拒')

			// ⑤ 写集可归因：守卫记录里，仓内写只落在本卡写集，且 ⊆ interfaces.md §6 的并集
			const union = authorizedWriteUnion()
			const repoWrites = G.all.filter((e) => typeof e.rel === 'string' && e.abs.startsWith(REPO + path.sep))
			for (const w of repoWrites) {
				const cls = classifyWrite(G, w)
				assert.equal(cls.where, 'card-writeset', `仓内写越出本卡写集：${JSON.stringify(w)}（归类 ${cls.where}）`)
				const inUnion = [...union.paths].some((p) => cls.rel === p || cls.rel.startsWith(p))
				assert.ok(inUnion, `仓内写不在 interfaces.md §6 授权写集并集里：${cls.rel}`)
			}
			const outside = G.all.filter((e) => !classifyWrite(G, e).ok)
			assert.deepEqual(outside, [], `出现越界写：${JSON.stringify(outside.slice(0, 5))}`)
			assert.ok(G.all.length > 0, '守卫日志是空的（探针写都没记到 ⇒ 可归因断言作废）')
			// 证据根在仓里时，整轮必须真的出现过"仓内写"，否则上面那条写集断言就是空转
			const evidenceInsideRepo = EVIDENCE.startsWith(REPO + path.sep)
			if (evidenceInsideRepo) assert.ok(repoWrites.length > 0, '整轮判据里一次仓内写都没记到（证据落地也要走守卫 fs，否则这条断言是空的）')
			else assert.equal(repoWrites.length, 0, '证据根在仓外时不该出现仓内写')

			// ⑥ 依赖锚点：本卡消费的四个 U 模块 + 事务件在跑前/跑后逐字节不变
			for (const [rel, digest] of DEPS_BEFORE) {
				assert.equal(digestFile(path.join(REPO, ...rel.split('/'))), digest, `依赖 ${rel} 在本次判据期间被改了（锚点失效）`)
			}

			// ⑦ 临时目录清理守卫：确认绝对路径与归属后再删，删完真的没了
			const cleanupTarget = path.join(TMP, 'cleanup-probe')
			io.mkdirSync(cleanupTarget, { recursive: true })
			io.writeFileSync(path.join(cleanupTarget, 'x.txt'), 'x', 'utf8')
			const removed = safeRemoveTree(cleanupTarget, { parent: TMP })
			assert.equal(removed.removed, true, `临时子目录清理失败：${removed.error}`)
			assert.equal(fs.existsSync(cleanupTarget), false, '清理报告成功但目录还在')

			writeJson(path.join(EVIDENCE, 'a08-safety.json'), {
				probes: { head: p1.plan.blocks.filter((b) => b.file === 'assets/glossary-data.js').length, value: valueBlocks.length, clean: 0 },
				guard: { writes: G.all.length, windowWrites: G.log.length, repoWrites: repoWrites.map((w) => w.rel) },
				union: { file: union.file, paths: union.paths.size },
				deps: Object.fromEntries(DEPS_BEFORE),
			})
			return { note: `probes=2 guard=${G.log.length}` }
		},
	},
]

/* ══════════════════════════════════════════════════════════════════════
 * 跑判据 → 判词 → 证据 → 清理
 * ══════════════════════════════════════════════════════════════════════ */

// 排障用：U05_TRACE=1 时逐条打"开始/结束"到 stderr（不进判词行、不写证据）
if (process.env.U05_TRACE === '1') {
	for (const c of cases) {
		const orig = c.run
		c.run = async () => {
			process.stderr.write(`[U05] start ${c.id}\n`)
			const r = await orig()
			process.stderr.write(`[U05] done ${c.id}\n`)
			return r
		}
	}
}

const verdict = await runCard('U05', FIXED_IDS, cases, { evidenceDir: EVIDENCE, argv: process.argv.slice(2) })
writeRunEvidence(verdict, EVIDENCE)

// 临时目录清理：先核对绝对路径与归属（本卡唯一目录 + 父目录是 E:\Temp）
const cleanup = safeRemoveTree(TMP, { parent: TEMP_PARENT })
const summary = {
	card: 'U05',
	status: verdict.status,
	line: verdict.line,
	tmpRoot: TMP,
	evidenceRoot: EVIDENCE,
	cleanup,
	note: '本卡临时夹具只落在 E:\\Temp 下的本次唯一目录（u05- 前缀），删除前核对绝对路径与父目录',
}
io.writeFileSync(path.join(EVIDENCE, 'temp-cleanup.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
if (!cleanup.removed) {
	// 清理失败不掩盖判词，但要让它可见（不在判词行里，落 stderr 与证据）
	process.stderr.write(`[U05] 临时目录清理失败：${cleanup.error}\n`)
}

process.exitCode = printVerdict(verdict)
