'use strict'
/**
 * lib/unify/glossary.cjs —— 术语计算与源码序列化的**唯一实现**（U11 新建）
 * ==================================================================
 * 收的是什么：名词台账（`assets/glossary-data.js`，UMD 形状的 JS 序列化数据源）
 *   → `GLOSSARY.md` 的**全部计算**，以及术语记录的**源码序列化**。
 * 改前这件事有两份逐字同源的实现：
 *   · 插件 `lib/glossary.js`（ESM，纯函数层）
 *   · 课程包 `assets/build-glossary.js`（CJS，脚本自带写盘与 console.log）
 * 靠 `MIRROR-OF` 注释 + `test/glossary-verify.mjs` 拿 CLI 当 oracle 对拍钉住。
 * 对拍只能**发现**漂移，不能**防止**漂移 —— 本文件把它收成一份（U-SPEC §5）：
 *
 *   · 本文件 = 唯一手工源码（CommonJS；只 require 内置模块与**同目录**内核）；
 *   · `lib/glossary.js` / `lib/glossary-io.js` / `lib/glossary-edit-io.js` = ESM 适配层（导出面逐字保留）；
 *   · `lib/pack-template/assets/build-glossary.js` = 包侧薄委托（`require('../tools/unify/glossary.cjs')`）。
 *
 * ## 这个文件**不做 IO**
 *
 * 读文件、写文件、`require` 数据源、`console.log` 全部由调用方**显式注入**
 * （`{fs}` / `{requireFrom}` / `{log}`），内核里没有一处直接用 `node:fs`。
 * 为什么这么设计：分类（`missing/empty/ok/invalid/io-error`）本身就是**语义**，
 * 如果留在 IO 层，宿主与包侧就有了两份"读失败算哪一种"的判断 —— 那正是本卡要消掉的东西。
 * 唯一的环境接触是 `process.pid`（临时文件名后缀，改前两侧都是这么写的）；
 * 不看时钟、不用随机数、不读环境变量、不联网、不起子进程。
 *
 * ## 失败口径（与 U03 的 `ledger-read.cjs` 同一套五态）
 *
 *   `missing`  只有真 `ENOENT`（台账文件确实不存在）—— 不是失败（归领域决定要不要抛）
 *   `empty`    台账存在且是合法空集合（出厂骨架就是这种）—— **不是失败**，是合法空集合
 *   `ok`       至少一条记录
 *   `invalid`  加载不出来 / 不是记录对象 / 记录不是对象 → `failure.code='LEDGER_INVALID'`
 *   `io-error` 目录 / 权限 / 其它读取故障 → `failure.code='IO_ERROR'` + 系统码原样保留
 *
 * ⚠️ **读取失败绝不许伪装成空词表**：`invalid` / `io-error` 一律 `ledger:null`，
 *    上层要么抛（`ledgerLoadError`），要么明确报错；只有 `empty` 才会拿到 `{}`。
 */

const path = require('node:path')
const { makeFailure } = require('./errors.cjs')
const { stripBom } = require('./text.cjs')

/* ══════════════════════════════════════════════════════════════════════
 * 常量（宿主与包侧的**同一份**）
 * ══════════════════════════════════════════════════════════════════════ */

/** 台账落点（包根相对，posix 分隔符）—— `LEDGER_REL` / `glossaryFiles()` 都从这儿派生 */
const GLOSSARY_LEDGER_REL = 'assets/glossary-data.js'

/** 产物落点（包根相对） */
const GLOSSARY_OUT_REL = 'GLOSSARY.md'

/** 课程包标题配置（包根相对） */
const LESSON_CONFIG_REL = 'lesson.config.json'

/** 标题缺省值（改前两侧都是这个字面量） */
const TITLE_DEFAULT = '课程'

/** 记录的必要字段（顺序即序列化顺序；`code` 可选、`lesson` 必填且排在最后） */
const TERM_TEXT_FIELDS = Object.freeze(['label', 'category', 'official', 'short', 'analogy'])
const TERM_LESSON_FIELD = 'lesson'
const TERM_OPTIONAL_FIELDS = Object.freeze(['code'])

/** 逐字段比对用的清单（= 改前 `glossary-edit-io.js` 的 FIELDS；`code` 单独比） */
const TERM_COMPARE_FIELDS = Object.freeze([...TERM_TEXT_FIELDS, TERM_LESSON_FIELD])

/** 合法术语键：JS 标识符形状（改前 `upsertTermSource` 里的那条正则） */
const TERM_KEY_RX = /^[A-Za-z_$][\w$]*$/

/** 台账读取五态（顺序即文档顺序；与 U03 `ledger-read.cjs` 同集合） */
const LOAD_STATUSES = Object.freeze(['missing', 'empty', 'ok', 'invalid', 'io-error'])

/** 既有业务码：读取故障（不改名，不新增同义码） */
const IO_ERROR_CODE = 'IO_ERROR'

/** U-SPEC §3 拟新增码（U01 §5.3 查重 0 冲突；只在 `errors.cjs` 落地） */
const LEDGER_INVALID_CODE = 'LEDGER_INVALID'

/* ══════════════════════════════════════════════════════════════════════
 * 纯工具
 * ══════════════════════════════════════════════════════════════════════ */

/** 给错误信息用的值描述：只说形状，不带正文 */
function describeValue(v) {
	if (v === null) return 'null'
	if (Array.isArray(v)) return 'array'
	if (typeof v === 'string') return `string(${v.length})`
	return typeof v
}

function errMessage(e) {
	return String((e && e.message) || e)
}

/** 术语键是不是合法标识符 */
function isTermKey(key) {
	return typeof key === 'string' && TERM_KEY_RX.test(key)
}

/** 合法性断言（消息与改前逐字相同） */
function assertTermKey(key) {
	if (!isTermKey(key)) throw new Error('key 不是合法标识符: ' + key)
	return key
}

/** 记录的分类（缺省「未分类」）—— 目录与分组顺序都取决于它 */
function categoryOf(record) {
	const it = record || {}
	return it.category || '未分类'
}

/** 标题规范化：非空字符串就 trim，其余一律落到缺省值 */
function normalizeTitle(raw) {
	return typeof raw === 'string' && raw.trim() ? raw.trim() : TITLE_DEFAULT
}

/* ══════════════════════════════════════════════════════════════════════
 * 一、台账 → GLOSSARY.md 的合成
 * ══════════════════════════════════════════════════════════════════════ */

/** 生成 GitHub 风格的标题锚点：@GetMapping -> getmapping */
function slug(label) {
	return String(label)
		.toLowerCase()
		.replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
}

/**
 * 按**数据顺序**聚合分类。顺序很重要：Markdown 里的目录与分类顺序都取决于它，
 * 乱一点就不是逐字节一致了。
 * @returns {{ categories: string[], byCategory: Map<string, object[]>, entries: object[] }}
 */
function categorize(ledger) {
	const categories = []
	const byCategory = new Map()
	const entries = []
	Object.keys(ledger).forEach((key, index) => {
		const item = ledger[key]
		const cat = categoryOf(item)
		if (!byCategory.has(cat)) {
			byCategory.set(cat, [])
			categories.push(cat)
		}
		const entry = Object.assign({ key: key, no: index + 1, cat: cat }, item)
		byCategory.get(cat).push(entry)
		entries.push(entry)
	})
	return { categories, byCategory, entries }
}

/**
 * 合成 GLOSSARY.md 全文（改前 `build-glossary.js:57-161` 与 `lib/glossary.js:207-316` 逐字同一份）。
 * 末尾**不带**换行：改前是 `L.join('\n')` 直接写盘，最后一项是空串，
 * 所以文件以 `\n` 收尾 —— 这个细节必须一致，否则逐字节对拍会差一个字节。
 *
 * @param {object} ledger glossary-data.js 导出的对象
 * @param {{title?: string}} [opts]
 * @returns {string}
 */
function buildGlossaryMarkdown(ledger, opts) {
	const title = normalizeTitle(opts === undefined || opts === null ? undefined : opts.title)
	const { categories, byCategory, entries } = categorize(ledger)

	const L = []
	const total = entries.length

	L.push(`# ${title} 名词速查笔记（GLOSSARY）`)
	L.push('')
	L.push('> 本文件是本工作区**所有专业名词的唯一记录处**，方便随时查找。')
	L.push('>')
	L.push('> 课程页里带虚线下划线的彩色名词，鼠标放上去就会显示一个小窗，')
	L.push('> 里面按顺序给出三段：**① 官方定义**（正式术语 + 英文全称）→ **② 一句话大白话** → **③ 生活类比**。')
	L.push('> 每个名词只在**第一次**出现时带下划线，')
	L.push('> 之后再出现只保留颜色，不再重复弹窗。')
	L.push('>')
	L.push('> ⚙️ 本文件由 `assets/build-glossary.js` 自动生成，数据源是 `assets/glossary-data.js`。')
	L.push('> 要新增或修改名词，请改数据源，然后运行 `node assets/build-glossary.js`。')
	L.push('')
	L.push(`**共 ${total} 个名词，分为 ${categories.length} 类。**`)
	L.push('')

	// 目录
	L.push('## 目录')
	L.push('')
	L.push('| # | 名词 | 分类 | 一句话解释 | 首次出现 |')
	L.push('|---|------|------|-----------|---------|')
	entries.forEach((e) => {
		L.push(
			`| ${e.no} | [${e.label}](#${slug(e.label)}) | ${e.cat} | ${e.short} | ${e.lesson || '-'} |`
		)
	})
	L.push('')

	// 分类跳转
	L.push('## 按分类跳转')
	L.push('')
	categories.forEach((cat) => {
		L.push(`- [${cat}](#${slug(cat)}) —— ${byCategory.get(cat).length} 个`)
	})
	L.push('')
	L.push('---')
	L.push('')

	// 正文
	categories.forEach((cat) => {
		L.push(`## ${cat}`)
		L.push('')
		byCategory.get(cat).forEach((e) => {
			L.push(`### ${e.label}`)
			L.push('')
			L.push(`- **① 官方定义**：${e.official || '（待补）'}`)
			L.push(`- **② 一句话**：${e.short}`)
			L.push(`- **③ 类比**：${e.analogy}`)
			L.push(`- **首次出现**：${e.lesson || '-'}`)
			L.push(`- **数据键名**：\`${e.key}\`（课程页里写 \`<span data-term="${e.key}">${e.label}</span>\`）`)
			L.push('')
			// ④ 规范写法：注解类等「有用法规范」的名词才有。放在列表之后，
			// 否则围栏代码块会把 markdown 列表截断。
			if (e.code) {
				L.push('**④ 规范写法**')
				L.push('')
				L.push('```java')
				L.push(e.code)
				L.push('```')
				L.push('')
			}
		})
	})

	// 维护说明
	L.push('---')
	L.push('')
	L.push('## 怎么加一个新名词')
	L.push('')
	L.push('1. 打开 `assets/glossary-data.js`，在合适分类下加一条：')
	L.push('')
	L.push('```js')
	L.push('newword: {')
	L.push("  label: '新名词',")
	L.push("  category: 'Spring 注解',")
	L.push("  official: '官方定义：正式术语 + 英文全称（如适用），一句话。',")
	L.push("  short: '一句话大白话，让人一眼看懂。',")
	L.push("  analogy: '一个生活化类比，用来记住它。',")
	L.push("  lesson: '第3课'")
	L.push('}')
	L.push('```')
	L.push('')
	L.push('2. 运行 `node assets/build-glossary.js`，本文件会自动更新（目录也会刷新）。')
	L.push('3. 在课程 HTML 正文里给名词加标记：`<span data-term="newword">新名词</span>`，')
	L.push('   第一次出现的位置带下划线和小窗，后面的会自动只保留颜色。')
	L.push('4. 运行 `node assets/check-terms.js` 自检：确认键名没拼错、没标进代码块。')
	L.push('')
	L.push('> 注意：不要在 `<pre><code>` 代码块里标名词，代码要保持原样可复制。')
	L.push('')
	L.push('## 相关文件')
	L.push('')
	L.push('| 文件 | 作用 |')
	L.push('|------|------|')
	L.push('| `assets/glossary-data.js` | 名词数据源（唯一需要手改的地方） |')
	L.push('| `assets/glossary.css` | 名词下划线、彩色、悬停小窗的样式 |')
	L.push('| `assets/glossary.js` | 悬停逻辑：只给第一次出现绑小窗，后续自动降级为仅颜色 |')
	L.push('| `assets/quiz.js` | 选择题组件：点选即判、标出正确答案、可重做 |')
	L.push('| `assets/build-glossary.js` | 生成 `GLOSSARY.md`（本文件） |')
	L.push('| `assets/check-terms.js` | 自检课程页里的名词标记 |')
	L.push('| `GLOSSARY.md` | 你在看的这份笔记 |')
	L.push('')

	return L.join('\n')
}

/** 台账概览（给工具输出用）：条数 / 分类数 / 缺字段的条目 */
function glossarySummary(ledger) {
	const keys = Object.keys(ledger)
	const cats = new Set()
	const missing = []
	for (const k of keys) {
		const it = ledger[k] || {}
		cats.add(categoryOf(it))
		const lack = ['label', 'short', 'analogy'].filter((f) => !it[f])
		if (lack.length) missing.push(`${k} 缺 ${lack.join('/')}`)
	}
	return { count: keys.length, categories: cats.size, missing }
}

/** 首个差异的位置（行/列 + 两侧长度）—— 报"不一致"必须能落到具体位置 */
function firstDiff(a, b) {
	const n = Math.min(a.length, b.length)
	let i = 0
	while (i < n && a[i] === b[i]) i++
	const line = a.slice(0, i).split('\n').length
	const col = i - (a.lastIndexOf('\n', i - 1) + 1)
	return `第 ${line} 行第 ${col} 列（磁盘 ${a.length} 字符 / 合成 ${b.length} 字符）`
}

/**
 * 包侧 CLI 的输出行（**唯一实现**：改前 build-glossary.js:170-172 的三段 console.log）。
 * 抽出来是为了让包侧包装器一行计算都不留，同时把"输出文案"也变成单一来源。
 * @param {{ledger: object, outRel: string}} opts
 * @returns {string[]}
 */
function glossaryCliLines(opts) {
	const o = opts || {}
	const { categories, byCategory, entries } = categorize(o.ledger)
	const lines = [
		'[build-glossary] 已生成 ' + String(o.outRel),
		'[build-glossary] 名词 ' + entries.length + ' 个，分类 ' + categories.length + ' 个',
	]
	for (const c of categories) lines.push('  - ' + c + ': ' + byCategory.get(c).length)
	return lines
}

/** 逐行打出去（`log` 由调用方注入：包侧 CLI 传 `console.log`） */
function emitGlossaryCli(opts) {
	const o = opts || {}
	const log = typeof o.log === 'function' ? o.log : () => {}
	const lines = glossaryCliLines(o)
	for (const l of lines) log(l)
	return lines
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、术语记录的源码序列化 + 字符串手术（纯函数，不碰盘）
 * ──────────────────────────────────────────────────────────────────────
 * 为什么不用 String.prototype.replace：替换串里的 `$&` / `$'` 会被当成反向引用，
 * 记录内容里一出现 `$` 就写飞（本机已踩过同类坑）。这里一律切片拼接。
 * 数据源形状（实测 assets/glossary-data.js）：
 *   (function (root, factory) { … }(this, function () {
 *     return {
 *       body: { 4 空格缩进
 *         label: '响应体',        6 空格缩进，单引号
 *         …
 *         lesson: '第1课'
 *       }                       末条记录**不带**逗号
 *     };
 *   }));
 * 所以插入点固定在顶层映射收尾 `\n  };` 之前，并给上一条补一个逗号。
 * ══════════════════════════════════════════════════════════════════════ */

/** 顶层映射里已有的键名（按出现顺序） */
function parseTermKeys(src) {
	const keys = []
	const re = /^ {4}([A-Za-z_$][\w$]*): \{\s*$/gm
	let m
	while ((m = re.exec(String(src))) !== null) keys.push(m[1])
	return keys
}

/** 把 JS 值写成源码里的单引号字面量（换行转义，保持单行） */
function termLiteral(v) {
	return "'" + String(v)
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\r?\n/g, '\\n') + "'"
}

/** 一条记录的源码块（字段顺序与数据源一致；code 可选） */
function termRecordSource(key, record) {
	const r = record || {}
	const lines = ['    ' + key + ': {']
	for (const k of TERM_TEXT_FIELDS) {
		if (r[k] === undefined) throw new Error('记录缺少字段 ' + k)
		lines.push('      ' + k + ': ' + termLiteral(r[k]) + ',')
	}
	if (r.code !== undefined) lines.push('      code: ' + termLiteral(r.code) + ',')
	if (r[TERM_LESSON_FIELD] === undefined) throw new Error('记录缺少字段 ' + TERM_LESSON_FIELD)
	lines.push('      ' + TERM_LESSON_FIELD + ': ' + termLiteral(r[TERM_LESSON_FIELD]))
	lines.push('    }')
	return lines.join('\n')
}

/**
 * 从 openIdx（指向 `{`）起找配对的花括号结束位置。
 * 必须跳过字符串/模板串/注释 —— 记录里的 `code` 常含 `{`（Java 代码块），
 * 朴素数括号会在这里断掉。
 */
function matchBraceEnd(src, openIdx) {
	let depth = 0
	let mode = null
	for (let i = openIdx; i < src.length; i++) {
		const c = src[i]
		const n = src[i + 1]
		if (mode) {
			if (c === '\\') { i++; continue }
			if (c === mode) mode = null
			continue
		}
		if (c === '/' && n === '/') { const e = src.indexOf('\n', i); if (e === -1) return -1; i = e; continue }
		if (c === '/' && n === '*') { const e = src.indexOf('*/', i); if (e === -1) return -1; i = e + 1; continue }
		if (c === "'" || c === '"' || c === '`') { mode = c; continue }
		if (c === '{') depth++
		else if (c === '}') { depth--; if (depth === 0) return i }
	}
	return -1
}

/**
 * 判「顶层映射体里真的什么都没有」。
 *
 * 只在"`parseTermKeys` 一个键都没认出来"时调用 —— 那时我们会**不加逗号**地插在收尾之前，
 * 所以必须确认对象体里确实没有别的东西（空白 + 注释除外）。否则就是：台账里有一条**认不出**
 * 的记录（缩进从 4 空格变成 2 空格、键名写成 `'a-b'`、`key:{` 少个空格…）——
 * 这时在后面插一条就是**写出语法错的源码**（上一条记录末尾没补逗号）。
 *
 * 这一条与「上一条记录末尾不是 `}`」是同一条纪律的两面：判不准就**拒写并点名**，
 * 绝不猜、绝不写出坏文件。出厂骨架的注释（`// 在这里按分类顺序添加名词……`）在这里
 * 会被正常跳掉，所以新包的第一个术语不受影响。
 */
function assertEmptyObjectBody(text, closeAt) {
	const OPEN = '\n  return {'
	const openAt = text.lastIndexOf(OPEN, closeAt)
	if (openAt === -1) throw new Error('找不到顶层映射开头（\\n  return {）—— 数据结构变了？')
	const body = text.slice(openAt + OPEN.length, closeAt)
	const rest = body
		.replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
		.replace(/\/\/[^\n]*/g, '')         // 行注释
		.trim()
	if (rest) {
		throw new Error(
			'台账里没认出任何记录，但顶层映射体里还有内容（' + JSON.stringify(rest.slice(0, 48))
			+ (rest.length > 48 ? '…' : '') + '）—— 插入点可疑，拒写'
		)
	}
}

/**
 * 在数据源里插入或替换一条记录，返回新源码（纯函数）。
 * @param {string} src 源文件全文
 * @param {string} key 顶层键名（合法标识符）
 * @param {object} record { label, category, official, short, analogy, code?, lesson }
 * @param {{replace?: boolean}} [opts] replace=false 时键已存在就抛错（只追加不覆盖）
 */
function upsertTermSource(src, key, record, opts) {
	const replace = !!(opts && opts.replace)
	const text = String(src)
	assertTermKey(key)

	const keys = parseTermKeys(text)
	const has = keys.indexOf(key) !== -1
	if (has && !replace) throw new Error('台账里已有 ' + key + '：只追加不覆盖（要改请传 replace:true）')
	if (!has && replace) throw new Error('台账里没有 ' + key + '，无法 replace')
	const block = termRecordSource(key, record)

	if (has) {
		const startM = new RegExp('^ {4}' + key + ': \\{$', 'm').exec(text)
		if (!startM) throw new Error('定位不到 ' + key + ' 的记录头')
		const braceIdx = text.indexOf('{', startM.index)
		const end = matchBraceEnd(text, braceIdx)
		if (end === -1) throw new Error('找不到 ' + key + ' 记录的花括号配对')
		return text.slice(0, startM.index) + block + text.slice(end + 1)
	}

	const closeAt = text.lastIndexOf('\n  };')
	if (closeAt === -1) throw new Error('找不到顶层映射收尾（\\n  };）—— 数据结构变了？')
	const head = text.slice(0, closeAt)
	const next = text.slice(closeAt)
	// 上一条记录末尾补逗号（末条原本不带逗号）。
	// ⚠️ 「空台账」不能靠 `/\breturn\s*\{\s*$/` 判：出厂骨架的空对象里留了一行注释
	// （`// 在这里按分类顺序添加名词……`），`\s*$` 匹配不到它，于是**新包的第一个术语**
	// 必然走到「上一条记录末尾不是 `}`，插入点可疑」—— 而 hintTerm 查不到术语会让
	// render 直接失败，等于新包第一课永远建不出来（2026-10-19 隔离环境实测）。
	// 判据改成"有没有上一个记录"：`keys` 为空就没有记录可补逗号，插入点就在 `return {` 之后。
	const hasPrevRecord = keys.length > 0
	// 反过来也要判：**没有上一条记录**不等于"对象体是空的"—— 认不出的记录必须拦下，
	// 否则这里会不加逗号地插进去，写出语法错的源码（静默写坏，比拒写坏得多）。
	if (!hasPrevRecord) assertEmptyObjectBody(text, closeAt)
	const patched = hasPrevRecord ? head.replace(/\}\s*$/, '},') : head
	if (hasPrevRecord && patched === head) throw new Error('上一条记录末尾不是 `}`，插入点可疑')
	return patched + '\n' + block + next
}

/**
 * 逐字段比对"加载回来的记录"与"要写入的记录"（消息与改前 `verifyLoadedTerm` 逐字相同）。
 * 为什么自检要用"加载"而不是"再看一眼文本"：文本看着对、加载后字段错
 * （引号/转义/模板串写坏）是最容易漏的一类，只有真加载一次才知道。
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function compareTermRecord(key, got, record) {
	if (!got) return { ok: false, error: '加载后找不到键 ' + key }
	for (const f of TERM_COMPARE_FIELDS) {
		if (got[f] !== record[f]) {
			return { ok: false, error: '字段 ' + f + ' 不一致：期望 ' + JSON.stringify(record[f]) + '，实得 ' + JSON.stringify(got[f]) }
		}
	}
	if (record.code !== undefined && got.code !== record.code) {
		return { ok: false, error: '字段 code 不一致' }
	}
	return { ok: true }
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、台账读取的**唯一**五态实现（IO 由调用方注入）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把一次加载故障分成五态里的两种"故障"：
 *   `ENOENT` → `missing`（只有真不存在才算"没有台账"）
 *   其余（EISDIR 路径是目录 / EACCES / EPERM / EMFILE…）→ `io-error`
 * 系统码**原样**保留，绝不把 `EACCES` 折成 `IO_ERROR` 把原值丢掉。
 */
function classifyLoadError(e) {
	const errorCode = e && e.code !== undefined && e.code !== null ? String(e.code) : null
	return {
		status: errorCode === 'ENOENT' ? 'missing' : 'io-error',
		errorCode,
		message: errMessage(e),
	}
}

/** `invalid` / `io-error` 的统一失败结构（`missing` 不是失败，不给 failure） */
function loadFailureOf(status, file, error, errorCode) {
	if (status === 'invalid') {
		return makeFailure({ kind: 'input', code: LEDGER_INVALID_CODE, error, file })
	}
	return makeFailure({
		kind: 'io',
		code: IO_ERROR_CODE,
		error,
		file,
		...(errorCode === null || errorCode === undefined ? {} : { errorCode }),
	})
}

/**
 * 纯函数：一个**已经加载出来的值**是哪一态。
 *   null / 数组 / 原始值 → `invalid`（改前这种情况下 `Object.keys` 会抛，或把数组当空词表；
 *                                数组尤其危险：它会合成出一份"0 个名词"的 GLOSSARY.md）
 *   每个记录不是对象          → `invalid`（不许把坏记录混进账）
 *   空对象                    → `empty`（出厂骨架就是这种，**合法**）
 *   有记录                    → `ok`
 * @returns {{status:string, file:string, ledger:object|null, problems:string[], failure?:object}}
 */
function ledgerValueFacts(value, opts) {
	const o = opts || {}
	const file = String(o.file == null ? '' : o.file)
	const bad = (problems) => ({
		status: 'invalid',
		file,
		ledger: null,
		problems,
		failure: loadFailureOf('invalid', file, `术语台账不可信（${problems.length} 处）：${problems[0]}`),
	})
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return bad([`台账不是一个记录对象（实得 ${describeValue(value)}）`])
	}
	const problems = []
	const keys = Object.keys(value)
	for (const k of keys) {
		const rec = value[k]
		if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
			problems.push(`键 ${k} 的记录不是对象（实得 ${describeValue(rec)}）`)
		}
	}
	if (problems.length) return bad(problems)
	return { status: keys.length ? 'ok' : 'empty', file, ledger: value, problems: [] }
}

/**
 * 清掉 `require` 缓存里这一条，再加载 —— **同进程改了台账再读必须拿到新的**。
 * ⚠️ 这是 A07 的**变异落点**：把 `clearModuleCache` 换成不做事（"返回旧缓存"），
 *    同进程重读的判据必须红。所以它单独成一个函数，不散落在几处。
 * @param {object} cache `require.cache`
 * @param {Function} requireFrom 一个 require（可带 `.resolve`）
 * @param {string} abs 台账绝对路径
 */
function clearModuleCache(cache, requireFrom, abs) {
	delete cache[abs]
	try {
		if (typeof requireFrom.resolve === 'function') {
			const resolved = requireFrom.resolve(abs)
			if (resolved) delete cache[resolved]
		}
	} catch {
		// 解析不了就只清字面键 —— 与改前 `delete requireCJS.cache[ledger]` 同口径
	}
}

/** 无缓存的加载（JS 正本保留格式：真 require 一次，不假装是 JSON） */
function requireFresh(requireFrom, abs) {
	const cache = requireFrom && requireFrom.cache
	if (cache) clearModuleCache(cache, requireFrom, abs)
	return requireFrom(abs)
}

/**
 * 读一本术语台账（五态）。**IO 全部由调用方注入**：内核不 require `node:fs`。
 *
 * @param {{abs: string, fs: object, requireFrom: Function}} options
 *   - `abs` 台账绝对路径
 *   - `fs` 至少要有 `readFileSync`（只用于**分类**：能不能读、是不是目录、有没有权限）
 *   - `requireFrom(p)` 真加载数据源（宿主传 `createRequire(...)`，包侧传自己的 `require`）
 * @returns {{file:string, exists:boolean, status:string, ledger:(object|null), problems:string[],
 *            errorCode?:string, failure?:object}}
 */
function loadLedger(options) {
	const o = options === null || options === undefined ? {} : options
	const abs = path.resolve(String(o.abs === null || o.abs === undefined ? '' : o.abs))
	const io = o.fs
	if (!io || typeof io.readFileSync !== 'function') {
		throw new TypeError('glossary.loadLedger：注入的 fs 必须至少提供 readFileSync()')
	}
	if (typeof o.requireFrom !== 'function') {
		throw new TypeError('glossary.loadLedger：注入的 requireFrom 必须是函数')
	}

	// ① 读：一次 readFileSync。它同时把"文不存在/是目录/没权限"分出来。
	let text
	try {
		text = io.readFileSync(abs, 'utf8')
	} catch (e) {
		const c = classifyLoadError(e)
		if (c.status === 'missing') {
			return {
				file: abs,
				exists: false,
				status: 'missing',
				ledger: null,
				problems: [`台账不存在（${c.errorCode || 'ENOENT'}）：${c.message}`],
				errorCode: c.errorCode || 'ENOENT',
			}
		}
		const msg = `台账读不动（${c.errorCode || IO_ERROR_CODE}）：${c.message}`
		return {
			file: abs,
			exists: true,
			status: 'io-error',
			ledger: null,
			problems: [msg],
			errorCode: c.errorCode === null ? IO_ERROR_CODE : c.errorCode,
			failure: loadFailureOf('io-error', abs, msg, c.errorCode),
		}
	}

	// ② 真加载（不伪装 JSON、不进 plan 执行）—— 加载抛错就是坏账，不许当空集合
	let value
	try {
		value = requireFresh(o.requireFrom, abs)
	} catch (e) {
		const msg = `台账加载失败（require 抛错）：${errMessage(e)}`
		return {
			file: abs,
			exists: true,
			status: 'invalid',
			ledger: null,
			problems: [msg],
			...(e && e.code !== undefined ? { errorCode: String(e.code) } : {}),
			failure: loadFailureOf('invalid', abs, msg),
		}
	}

	// ③ 分态（纯函数那一段）
	const facts = ledgerValueFacts(value, { file: abs })
	const out = { file: abs, exists: true, status: facts.status, ledger: facts.ledger, problems: facts.problems }
	if (facts.failure) out.failure = facts.failure
	return out
}

/**
 * 把一次失败的五态结果变成**会抛的 Error**（保留 status / failure / errorCode）。
 * 上层（宿主适配层、包侧 CLI）读不到台账时都走这里 —— 绝不返回 `{}` 冒充空词表。
 */
function ledgerLoadError(result) {
	const r = result || {}
	const status = String(r.status || 'invalid')
	const errorCode = r.errorCode || (r.failure && r.failure.code) || null
	const first = (r.problems && r.problems[0]) || '术语台账读不动'
	const e = new Error(`术语台账 ${status}（${errorCode || IO_ERROR_CODE}）：${first}`)
	e.status = status
	e.errorCode = errorCode
	e.ledger = null
	if (r.failure) e.failure = r.failure
	return e
}

/**
 * 读课程包的标题（`lesson.config.json` 的 `title`）：缺文件、坏 JSON、非字符串一律按改前口径处理。
 * 改前这段逻辑在宿主 `glossary-io.js` 与包侧 `build-glossary.js` 里**各写了一遍**，此处收成一份。
 * @param {{configPath: string, fs: object}} options
 * @returns {string}
 */
function readGlossaryTitle(options) {
	const o = options || {}
	const io = o.fs
	if (!io || typeof io.readFileSync !== 'function') {
		throw new TypeError('glossary.readGlossaryTitle：注入的 fs 必须提供 readFileSync()')
	}
	const configPath = String(o.configPath === null || o.configPath === undefined ? '' : o.configPath)
	if (typeof io.existsSync === 'function' && !io.existsSync(configPath)) return TITLE_DEFAULT
	const doc = JSON.parse(stripBom(String(io.readFileSync(configPath, 'utf8'))))
	return normalizeTitle(doc && doc.title)
}

/**
 * 原子写（先写 `.tmp-<pid>` 再 rename）：`writeFileSync` 会先截断再写，
 * 正好在窗口里打开这份笔记的人会看到半截文件。
 * 改前宿主 `writeGlossary` 与包侧 `writeAtomic` 各写了一遍，此处收成一份。
 * @param {{target: string, content: string, fs: object}} options
 * @returns {{target: string, tmp: string, bytes: number}}
 */
function atomicWrite(options) {
	const o = options || {}
	const io = o.fs
	if (!io || typeof io.writeFileSync !== 'function' || typeof io.renameSync !== 'function') {
		throw new TypeError('glossary.atomicWrite：注入的 fs 必须提供 writeFileSync() / renameSync()')
	}
	const target = String(o.target)
	const content = String(o.content)
	const tmp = `${target}.tmp-${process.pid}`
	io.writeFileSync(tmp, content, 'utf8')
	io.renameSync(tmp, target)
	return { target, tmp, bytes: Buffer.byteLength(content, 'utf8') }
}

module.exports = {
	// 常量
	GLOSSARY_LEDGER_REL,
	GLOSSARY_OUT_REL,
	LESSON_CONFIG_REL,
	TITLE_DEFAULT,
	TERM_TEXT_FIELDS,
	TERM_LESSON_FIELD,
	TERM_OPTIONAL_FIELDS,
	TERM_COMPARE_FIELDS,
	LOAD_STATUSES,
	IO_ERROR_CODE,
	LEDGER_INVALID_CODE,
	// 合成与派生
	slug,
	categorize,
	categoryOf,
	normalizeTitle,
	buildGlossaryMarkdown,
	glossarySummary,
	firstDiff,
	glossaryCliLines,
	emitGlossaryCli,
	// 序列化与手术
	termLiteral,
	termRecordSource,
	parseTermKeys,
	isTermKey,
	assertTermKey,
	matchBraceEnd,
	upsertTermSource,
	compareTermRecord,
	// 读取（五态，IO 注入）
	classifyLoadError,
	ledgerValueFacts,
	clearModuleCache,
	requireFresh,
	loadLedger,
	ledgerLoadError,
	readGlossaryTitle,
	atomicWrite,
}
