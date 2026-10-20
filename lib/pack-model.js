/**
 * lib/pack-model.js —— 数据层唯一入口（A1b 第 ①② 件）
 *
 * ① lessonIndex(root)：**唯一课次映射表** —— `第N课 ↔ point/NNNN ↔ 源/产物路径`
 *    来源：`code/*​/EXPECT.json` 的 `lessons[].id`（形如 `spring-boot/0001`，本次实测确认）
 *        + `lessons/src/NNNN-*.html`（源）+ `lessons/NNNN-*.html`（产物）
 *    判据：两侧都出现的课次才算成立；只在一边出现 → 报 conflict（不许静默取其一）
 *
 * ② scanTerms(root)：**唯一 data-term 扫描器** —— 语义与课程包自带的
 *    `assets/check-terms.js` 对齐：`<pre>` 代码块里的标记不算（那条检查自称
 *    「代码块内无标记」）。同时对两个数字**都对拍**（含 pre 的总数 / 去掉 pre 的数），
 *    因为本轮在别处量到 23/46 与 check-terms 报的 24/47 不一致 —— 差在哪必须查清，
 *    不许取平均、不许猜。
 *
 * 只读、无副作用。`node lib/pack-model.js --selftest [packRoot]` 自带原子断言。
 *
 * **唯一实现：`lib/unify/pack.cjs`**（U09）。课次映射表、身份解析（`labelOfAnchor` /
 * `keyOfAnchor`）与显示换算的实现都搬进了那份 CJS 内核；本文件只做**ESM 适配层**：
 *   · 导出面、参数、默认值、返回形状与本卡之前**逐字保持**（`export function` 改成
 *     `export const X = packCore.X` 的绑定 —— 名字/参数/返回都不变，且**函数同一性**成立）；
 *   · 课程包侧 `lib/pack-template/tools/lesson-map.js` 委托的是**同一份内核**的逐字节副本
 *     （U19 生成 `tools/unify/pack.cjs`）⇒ 宿主与包侧从"两实现 + 对拍"变成"一份实现"。
 * 所以这里**不再有**第二套映射算法；新增读法一律进 `lib/unify/pack.cjs`。
 *
 * ⚠️ 课程身份只认 `circle/point/NNNN`（U-SPEC §2）。运行态**拒绝**历史形状：裸点、
 * 两段课键（`point/课号`）、显示名（`第1课`）都不再被归一 —— 唯一的历史解码在
 * `lib/unify/migration.cjs`（U05），真实迁移后读取由 U17 实证。
 */
import fs from 'node:fs'
import { validateAdapters } from './adapters/jvm.js'
import path from 'node:path'
import { runSync } from './exec.js'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripBom } from './text.js'
import { planFrontier } from './plan.js'
import packCore from './unify/pack.cjs'
import identityCore from './unify/identity.cjs'

const readText = (p) => fs.readFileSync(p, 'utf8')
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/')

/**
 * 笔记台账的**唯一**路径定义（数据层在这里说一次，别处只许引用、不许再抄一个字面量）。
 * 为什么是 `notes/notes.jsonl` 而不是包根：课程包侧 7 个读者（build-notes / build-lessons /
 * render-inputs / state-scan / notes-card.test / ask-server / 规格文档）全都读这个路径 ——
 * 2026-09-24 裁定「正本 = `notes/notes.jsonl`」。A1b 早期写成包根，等于写进了一个没人读的文件，
 * 而 `notes/seq.txt` 又是两个写入口共用的 → 号会串。这类"两套口径"正是本项目在消灭的东西。
 */
export const NOTES_REL = path.join('notes', 'notes.jsonl')

/**
 * 证据台账的**唯一**路径定义（P0-4 戊1b，2026-09-25）。
 *
 * 为什么住 `learning-records/` 而不是包根：它是**学生侧的学习事实**（"我贴过这条证据"），
 * 与 intake / goals / adjustments 同一族，读者是插件的判定层与课程包的挑战卡。
 * 与 `NOTES_REL` 同规矩：字面量只在这里说一次，别处只许引用。
 */
export const EVIDENCE_REL = path.join('learning-records', 'evidence.jsonl')

/** 第 0001 课 → '第1课'（本项目唯一的人类可读课次写法，别在别处再造一个） */
export const lessonLabel = packCore.lessonLabel

/**
 * 编号折算：**文件号（内部 ID）→ 显示号**。fileBase 来自 point.json（缺省 0 = 不折算）。
 * 依据（用户 2026-09-21 裁定「轨道机制」）：`byNumber` 按文件名的 4 位号索引，两条轨道不能共用 0001 ——
 * Vue 第一课的文件号是 1001，而页面上显示「Vue 第1课」。
 * ⚠️ 实现只有一处（`lib/unify/pack.cjs`），包侧 `tools/lesson-map.js` 委托同一份内核。
 */
export const displayNumberOf = packCore.displayNumberOf

/** 扫 lessons/<halo>/<point>/point.json：point → { label, fileBase }（实现在内核，这里只借给自检） */
const pointMeta = packCore.pointMeta


/**
 * 归一 `practice: { dirs: [...] }` —— 圈级（`halo.json`）与点级（`point.json`）**同一形状**。
 * 缺失 / 非法一律折成 `{ dirs: [] }`（= 没声明），由探针回落兜底根，不在这里猜。
 *
 * @param {unknown} v 原始 `practice` 字段
 * @returns {{dirs: string[]}} 包根相对 POSIX 路径，已去首尾斜杠
 */
export function normPractice(v) {
	const dirs = Array.isArray(v?.dirs)
		? v.dirs
				.map((d) => String(d ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
				.filter(Boolean)
		: []
	return { dirs, adapters: validateAdapters(v?.adapters) }
}

// 旧平铺布局（`lessons/NNNN-*.html`）的兜底归属 —— 目录重构后应消失。
// 值与 `lib/unify/pack.cjs` / `tools/lesson-map.js` / `build-lessons` / U05 迁移**同值**（不另立一份）。
const LEGACY_HALO = packCore.LEGACY_HALO
const LEGACY_POINT = packCore.LEGACY_POINT

/**
 * 唯一课次映射表：`{ byKey, byLabel, byNumber, conflicts }`。
 *
 * **实现在 `lib/unify/pack.cjs`**（宿主与课程包侧共用同一份；U09）。要点：
 *   · `byKey` 的键是**规范课次键** `circle/point/NNNN` —— 跨圈同名点、同课号不再互相覆盖；
 *   · `byLabel` 只是**显示名索引**（给显示与"显示名撞车"检查用），**不参与身份解析**；
 *   · 源与产物的关系（`src` / `page` 两侧都要有）与目录校验（EXPECT 声明对位、平铺兜底）
 *     逐条保留，冲突仍逐条进 `conflicts`，不许静默取其一。
 *
 * @param {string} root 课程包根
 */
export const lessonIndex = packCore.lessonIndex

/**
 * 台账的 `anchor`（**规范课次键**，如 `programming/spring-boot/0001`）→ 课次显示名（`第1课`）。
 *
 * 方向要说清：台账只存**身份**；这里是**反向**那一步 —— 键 → 显示名，也**只在这一处**做。
 * 读点不许各自拼 `第N课`：label 在映射表里是 `lessonLabel(number)` + `fileBase` 折算的产物。
 *
 * ⚠️ **显示名不是合法输入**（U-SPEC §2：显示文字与实体身份分开）—— 传 `第1课` 会得到 `null`，
 *    旧台账里的显示名由迁移工具（U05）处理，运行态不猜。
 *
 * @param {string} anchor 台账里的 anchor
 * @param {{byKey: object}} index `lessonIndex(root)` 的返回值
 * @returns {string|null} 解析不到（孤儿锚点 / 历史形状）→ null，由调用方决定算 0 还是报警
 */
export const labelOfAnchor = packCore.labelOfAnchor

/** 没归到课的记录归到这个**显式的**桶（哨兵键；与 `lib/unify/pack.cjs` / 包侧同值） */
const UNLESSON = packCore.UNLESSON

/**
 * 调用方写法 → **规范课次键**（只收身份；与哨兵 `未归课`）。解析不到 → `null`。
 *
 * 这是写入口那一步的**唯一实现**：插件的 `lib/notes-io.js`（`appendNote`）与课程包侧的旧写入口
 * `tools/ask-server.js` 都走它 / 它在包侧的包装 `tools/lesson-map.js` —— 两边是**同一份内核**，
 * 不再靠对拍钉住两份。
 *
 * ⚠️ 运行态**只认** `circle/point/NNNN`：裸点、两段课键（`point/课号`）、显示名一律 `null`
 *    （原来"label 或 key 都归一"的职责已按 U-SPEC §2 从运行态删除；历史解码只在 U05）。
 *
 * @param {string} anchor
 * @param {{byKey: object}} index `lessonIndex(root)` 的返回值
 * @returns {string|null}
 */
export const keyOfAnchor = packCore.keyOfAnchor

// ⚠️ 判据需要"拒绝原因"级别的信息（`resolveLessonRef` / `resolveLearned`）时，直接从
//    `lib/unify/pack.cjs` 取 —— 那两个是**内核**的解析接口，不算本文件的既有导出面
//    （U01 §2 的 23 项导出锁逐名保持，不在这里多加一个同义 API）。

/**
 * 课次显示名（`代数 第1课`）→ **HTML 锚点 id**（`代数-第1课`）。
 * 实现只有一处（`lib/unify/pack.cjs`；包侧 `tools/lesson-map.js` 委托同一份内核）。
 *
 * 为什么只做「空白 → `-`」这一件事：HTML 规范对 `id` 的唯一限制是**不得含 ASCII 空白**
 * 且非空 —— 再多做（小写化 / 剥字符）那是 Markdown 标题锚点 `slug()` 的规则，作用域不同，别混。
 * 链接那一侧写 `#${encodeURIComponent(labelAnchorId(label))}`：浏览器按 **percent-decode 后**
 * 与 id 比对，所以「decode(fragment) === id」这条往返必须成立（判据在 test/mirror-parity.mjs）。
 * 为什么不能只编码 href：`id` 本身含空格就是非法 HTML，规范如此（2026-09-24 F 条）。
 *
 * ⚠️ 这是**页面领域**的函数：它产出的锚点 id **不是**课程身份，不许拿去当课次键（U-SPEC §2）。
 *
 * @param {string} label 课次显示名
 * @returns {string} 不含空白的锚点 id
 */
export const labelAnchorId = packCore.labelAnchorId

/** 把 <pre>…</pre> 摘掉（check-terms 的语义：代码块里的标记不算） */
function stripPre(html) {
  return html.replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
}

/** 单页统计：{ all, outsidePre, inPre: [...] } */
export function scanTermsInPage(html) {
  const grab = (s) => [...String(s).matchAll(/data-term="([^"]+)"/g)].map((m) => m[1])
  const all = grab(html)
  const outside = grab(stripPre(html))
  const inPre = all.slice()
  for (const k of outside) {
    const i = inPre.indexOf(k)
    if (i !== -1) inPre.splice(i, 1)
  }
  const tally = (arr) => arr.reduce((o, k) => { o[k] = (o[k] || 0) + 1; return o }, {})
  return { all: all.length, outsidePre: outside.length, inPre, byKey: tally(outside) }
}

/** 全包扫描：{ pages: [{page, all, outsidePre, inPre}], totalAll, totalOutside, byKey } */
export function scanTerms(root) {
  const abs = path.resolve(root)
  const idx = lessonIndex(abs)
  const pages = []
  const byKey = {}
  for (const entry of Object.values(idx.byKey)) {
    if (!entry.page) continue
    const p = path.join(abs, entry.page)
    if (!fs.existsSync(p)) continue
    const s = scanTermsInPage(readText(p))
    pages.push({ page: entry.page, key: entry.key, ...s })
    for (const [k, n] of Object.entries(s.byKey)) byKey[k] = (byKey[k] || 0) + n
  }
  return {
    pages,
    totalAll: pages.reduce((n, p) => n + p.all, 0),
    totalOutside: pages.reduce((n, p) => n + p.outsidePre, 0),
    inPre: pages.flatMap((p) => p.inPre.map((k) => p.page + ':' + k)),
    byKey,
  }
}

/* ── 规范 id 与下一课号（纯函数，不读盘） ────────────────────────────────
 *
 * **id 一律用 `/` 分层**（`programming/spring-boot`、`programming/spring-boot/0001`），
 * 因为 id 自身可能含 `-`（`spring-boot`），用 `-` 当分隔符会歧义；
 * `/` 也是唯一的路径分隔符，不会出现在目录名里。
 *
 * ⚠️ 这两个既有公开导出**就是** `lib/unify/identity.cjs` 的严格内核本身（U02 建、U09 委托，
 *    U-SPEC §2）：合法输入的返回值与基线**逐字节相同**（`circle/point`、
 *    `circle/point/四位课号`）；差别只在**非法输入** —— 旧实现照拼（`padStart` 无范围校验、
 *    任何类型都拼），现在对每个组成部分逐个校验、不合法抛 `IdentityError`。
 *    于是**同一件事只有一份实现**，`lib/point-ref.js` 的内联拆分不在本卡写集（见回执边界）。
 */

/**
 * 知识点的规范 id（= `lib/unify/identity.cjs#pointKey`，函数同一性）。
 *
 * @param {string} circle 圆圈 id（如 `programming`）
 * @param {string} point  知识点 id（如 `spring-boot`）
 * @returns {string} `programming/spring-boot`
 * @throws {import('./unify/identity.cjs').IdentityError} 组成部分不合法
 */
export const pointKey = identityCore.pointKey

/**
 * 课程的规范 id（= `lib/unify/identity.cjs#lessonKey`，函数同一性）。
 *
 * @param {string} circle 圆圈 id（如 `programming`）
 * @param {string} point  知识点 id（如 `spring-boot`）
 * @param {number} number 课号（1–9999 的整数，如 1）
 * @returns {string} `programming/spring-boot/0001`
 * @throws {import('./unify/identity.cjs').IdentityError} 组成部分或课号不合法
 */
export const lessonKey = identityCore.lessonKey

/**
 * 该知识点下一门课的课号 —— **文件号**。
 *
 * **有地图就按大纲**（`01:394` 的"③生成课程按大纲定下一课教什么"，**替代"文件名序 +1"**）：
 *   地图上还有没建的节点 → 返回该节点的号（`fileBase + no`）。于是"UI 提示的第几课"
 *   与"地图说该教哪一课"是**同一个答案**（`01:204`：后续进展都遵循这张地图）。
 *
 * ⚠️ 退回"现有最大号 + 1"只有两种情况，都**不是**静默降级：
 *    ① 地图缺失/不合法 —— 这时建课会被 `whale_author` 的**大纲闸**拦住（禁 force），
 *       这个号只影响显示；
 *    ② 地图上的课**全建完了** —— 地图对"下一课教什么"确实没有答案。
 *    两种情况都由 `whale_plan op=read` **明说**（"地图上 N 课全建完了"/逐条 problems），
 *    不靠这里猜。本函数只管**号怎么分配**，不管"该教什么"。
 *
 * ⚠️ 这是**文件号**不是显示号：显示号要按 `fileBase` 折算（见 `displayNumberOf`）。
 *    例：`vue` 的 `fileBase=1000`，文件号 1002 → 课页显示「第2课」。
 * ⚠️ 必须**按 `circle` + `point` 两个字段一起筛**：`vue` 这种 id 在不同圆圈里可能重名，
 *    只按 point 筛会把别的圆圈的课号算进来 → 下一课号凭空跳号。
 * ⚠️ 号只从 `pack.lessons` 算 —— 与 catalog 列出来的那批课**同一个来源**，不引第二份真相。
 * 没有课时返回该知识点的 `fileBase + 1`；
 * 找不到该知识点 → 返回 `null`（**不返回 0/1 冒充**）。
 *
 * @param {{ points: Array<{id: string, circle: string, fileBase?: number, plan?: object|null}>, lessons: Array<{circle: string, point: string, number: number, displayNumber?: number}> }} pack readPack 的返回值
 * @param {string} circle 圆圈 id
 * @param {string} point  知识点 id
 * @returns {number|null}
 */
export function nextNumber(pack, circle, point) {
  const p = pack.points?.find((pt) => pt.id === point && pt.circle === circle)
  if (!p) return null

  const fileBase = Number(p.fileBase) || 0
  const mine = (pack.lessons || []).filter((l) => l.circle === circle && l.point === point)

  // ① 有地图 → 按大纲（`01:394`）
  if (p.plan) {
    const f = planFrontier(p.plan, mine.map((l) => Number(l.displayNumber)))
    if (f.ok && !f.exhausted) return fileBase + f.next.no
  }

  // ② 退回号的分配（地图没有答案时；理由见上面的文档注释）
  const numbers = mine.map((l) => Number(l.number)).filter((n) => Number.isFinite(n))
  if (numbers.length > 0) return Math.max(...numbers) + 1

  // 没有课 → fileBase + 1
  return fileBase + 1
}

/**
 * 地图上**还差几课**（该知识点的 plan 前沿里 `missing` 的条数）。
 *
 * 与 `nextNumber()` 同源：两者都走 `planFrontier(p.plan, 已建的显示号)` ——
 * 「下一课是哪一课」与「还差几课」必须是**同一次判定**的两个字段，
 * 不许一处按地图、另一处按文件号序（那就是"同一事实两套口径"）。
 *
 * @param {{ points: Array<{id: string, circle: string, plan?: object|null}>, lessons: Array<{circle: string, point: string, displayNumber?: number}> }} pack
 * @param {string} circle
 * @param {string} point
 * @returns {number|null} 没有地图 / 地图不可用 / 找不到该知识点 → **null**（不返回 0 冒充"全建完了"）
 */
export function remainingLessons(pack, circle, point) {
  const p = pack.points?.find((pt) => pt.id === point && pt.circle === circle)
  if (!p || !p.plan) return null
  const mine = (pack.lessons || []).filter((l) => l.circle === circle && l.point === point)
  const f = planFrontier(p.plan, mine.map((l) => Number(l.displayNumber)))
  return f.ok ? f.missing : null
}

/** check-terms.js 自报的数字（对拍用；它同时会打印「代码块内无标记」） */
export function checkTermsReport(root) {  const abs = path.resolve(root)
  // 走 exec.js 的唯一入口。与原来的 execFileSync 等价：两者都拿 stdout/stderr，
  // 区别只是「非 0 是否抛」—— 这里只要输出文本，抛与不抛都归到同一句人话里。
  const r = runSync(process.execPath, [path.join(abs, 'assets', 'check-terms.js')], { cwd: abs, maxBuffer: 16 * 1024 * 1024 })
  let out = (r.stdout || '') + (r.stderr || '')
  if (r.error || r.hint) {
    // 子进程**没起来**时（EPERM 等）out 是空的 —— 光留空串等于静默：把话说出来
    out = [out, r.hint].filter(Boolean).join('\n')
  }
  const marks = [...out.matchAll(/名词标记 (\d+) 处/g)].map((m) => Number(m[1]))
  return { marks, saysNoMarkInCode: out.includes('代码块内无标记'), raw: out }
}

/* ── ③④ 三类 box 的装载与不变量 ────────────────────────────────────────
   box = { id, kind, anchor, payload }
     · 名词解释：id = 术语键(slug)     anchor = 记录的 lesson（'第1课'）
     · 疑问　　：id = 提问号('0004')   anchor = 记录的 anchor/lesson，另带 terms[]
     · 笔记　　：id + seq（notes.jsonl 可能还不存在 → 空数组，不报错）
   规矩（2026-09-24 定）：**只存 anchor**，课次显示名由映射表推导；
   `date` 保留字段但**不给默认值** —— 缺了就报出来，不许悄悄填"今天"。 */
export async function loadBoxes(root) {
  const abs = path.resolve(root)
  const { createRequire } = await import('node:module')
  const boxes = []
  const problems = []

  const loadJs = (file) => {
    const p = path.join(abs, file)
    if (!fs.existsSync(p)) return null
    const req = createRequire(p)
    delete req.cache[p]
    try { return req(p) } catch (e) { problems.push(file + ' 加载失败：' + e.message); return null }
  }

  const led = loadJs(path.join('assets', 'glossary-data.js'))
  for (const [slug, r] of Object.entries(led || {})) {
    boxes.push({
      id: slug, kind: '名词解释', anchor: r.lesson,
      payload: { label: r.label, official: r.official, short: r.short, analogy: r.analogy },
    })
  }

  const q = loadJs(path.join('assets', 'questions-data.js'))
  // 形状未知：数组 / {entries|questions|data} / **以 id 为键的映射**（实测就是这个）——三种都认
  const inner = q && (q.entries || q.questions || q.data)
  const qArr = Array.isArray(q)
    ? q
    : inner
      ? (Array.isArray(inner) ? inner : Object.values(inner))
      : Object.values(q || {}).filter((v) => v && typeof v === 'object' && ('id' in v || 'question' in v))
  for (const r of qArr) {
    if (!r || typeof r !== 'object') continue
    // `date: null` 是台账的**合法值**（T27：没给日期就写裸 null）——只有**没有**这个键
    // 或写成空串才算缺；真实日期字符串照旧通过。
    if (r.date === undefined || r.date === '') problems.push('疑问 ' + (r.id || '?') + ' 缺 date（不许默认今天）')
    // 实测：答疑台账的 `anchor` 是**页面锚点**（q0001，用于在 NOTES.html 里跳转），
    // 不是星图能解析的课次键 ✗ —— 同一个字段名被用了两种含义。
    // 这里把它保留为 pageAnchor，星图锚点改由 `lesson` 经映射表推导（不动既有数据）。
    // ⚠️ 判据只认**规范课次键**（circle/point/NNNN）：两段/显示名都不是身份（U-SPEC §2）。
    const rawAnchor = String(r.anchor || '')
    const looksLikeStarKey = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\d{4}$/.test(rawAnchor)
    boxes.push({
      id: String(r.id || ''), kind: '疑问',
      anchor: looksLikeStarKey ? rawAnchor : String(r.lesson || ''),
      pageAnchor: rawAnchor, terms: r.terms || [],
      payload: { question: r.question, answer: r.answer },
    })
  }

  const np = path.join(abs, NOTES_REL)
  if (fs.existsSync(np)) {
    const lines = fs.readFileSync(np, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      let o
      try { o = JSON.parse(s) } catch { problems.push('notes.jsonl 有一行不是合法 JSON：' + s.slice(0, 40)); continue }
      boxes.push({ id: String(o.id || ''), kind: '笔记', anchor: o.anchor, seq: o.seq, payload: { text: o.text } })
    }
  }
  return { boxes, problems }
}

/**
 * ④ 不变量：id 每类唯一、anchor 必须能在课次映射表里解析到（孤儿锚点要报出来）。
 *
 * ⚠️ 这里的"解析到"仍保留 `byLabel` 那一半（显示名也算找到）—— 这是**旧箱台账的自检**、
 * 不是身份解析：`assets/glossary-data.js` / `assets/questions-data.js` 的 `lesson` 至今是**显示名**
 * （U05 的 `BLOCKED_FILES` 明确把它们整类阻断，理由是改它们必须重建派生产物、归 U17）。
 * 把它们在这里判成"孤儿"只会把一份**已知的中间态**说成 62 条硬错误，而不是让人看见真问题。
 * 收紧到"只认规范身份"是 U17 迁移后验收的事（本卡回执 `unverified` 已登记）。
 */
export function validateBoxes(boxes, index) {
  const problems = []
  const seen = new Set()
  for (const b of boxes) {
    const k = b.kind + '/' + b.id
    if (!b.id) problems.push(b.kind + ' 缺 id')
    else if (seen.has(k)) problems.push('撞 id：' + k)
    else seen.add(k)
    if (!b.anchor) problems.push('缺 anchor：' + k)
    else if (!index.byKey[b.anchor] && !index.byLabel[b.anchor]) problems.push('孤儿锚点：' + k + ' → ' + b.anchor)
  }
  const counts = boxes.reduce((o, b) => { o[b.kind] = (o[b.kind] || 0) + 1; return o }, {})
  return { problems, counts }
}

/* ── ⑤ 课程包事实（原 `lib/pack.js`，2026-09-24 收进数据层唯一入口）─────────────
 *
 * 为什么搬进来：`whale_state` / `whale_brief` 的输出里有"圆圈 / 知识点 / 课程 / 已点亮"
 * 这些**课程包事实**，而它们原先来自另一个读取器 `lib/pack.js` 的 `readPack()` ——
 * 于是同一个包里出现两条独立的路径解析线（`lessonIndex()` 与 `readPack()`）。
 * 队列② 的口径是"数据层唯一入口"，所以这里把它收进来；`lib/pack.js` 退化成**再导出**，
 * 实现只剩这一份（不是两份实现 + 对拍，而是真的只有一份）。
 *
 * 搬动时**逐字保留**原实现，只在本地变量 `rel` 上改名 `relParts`（避免遮蔽本文件的 `rel()`）：
 * 验收判据是 `whale_state` / `whale_brief` 的输出**逐字节不变**。
 *
 * 原三条纪律照旧：root 由调用方给（绝不猜路径）；只读；读不动**不静默跳过**（记进 warnings）。
 * 这里只读**课程包本身**；星图那些派生量（shape / 坐标 / size / bright）仍不在这里。
 */
const LESSON_META_RE = /<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/
const LESSON_FILE_RE = /^\d{4}-.*\.html$/

/** 历史平铺布局（`lessons/src/NNNN-*.html`）里的课归给这个圆圈/知识点。
 *  **与 tools/build-lessons.js、tools/build-starmap.js 同一条兜底** —— 三处必须一致，
 *  否则 pack 与工具链就会对不上（这一条正是被 test/pack-parity.mjs 抓出来的 ✗→✓）。
 *  ⚠️ 常量定义已提到 `lessonIndex` 之前（建 byNumber 索引时就要用它），这里不再重复定义。 */

/** 递归找 `NNNN-*.html`（不跟软链，避免绕出去） */
function walkLessonFiles(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkLessonFiles(p, out)
    else if (e.isFile() && LESSON_FILE_RE.test(e.name)) out.push(p)
  }
  return out
}

function readJsonWarn(file, warnings, what) {
  try {
    // ⚠️ 剥 BOM：progress.json 常被手工/工具改，PowerShell 写出来会带 \uFEFF（见 lib/text.js）
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (e) {
    warnings.push(`${what} 读不动：${path.basename(file)}（${e.message}）`)
    return null
  }
}

/**
 * 归一 + 校验 `halo.json` 的 `groups[]`（庚3 · 数据半 —— 圈 → 组 → 点 的中间层）。
 *
 * **四条规则**（立项书 `_board/12:56-61`，每条都要机器可判）：
 *   ① **可选**：没有这个字段 ⇒ 回 `[]`（= 无中间层，渲染**逐字节退化成现状**）；
 *   ② `points[]` 的 id 必须是**本圈内已存在**的知识点 —— 不认识就记 warnings **并给修法**
 *      （不静默跳过：静默跳过的后果是"组悄悄少了一个点"，那正是这条规则要防的）；
 *   ③ 一个知识点**至多归一个组** —— 重复归组记 warnings；
 *   ④ **没被任何组收的点 ⇒ 直接挂在圈上**（防丢）：归一结果里不属于任何组的点**仍留在**
 *      调用方的 `points` 里（由调用方保证，判据在 `--selftest`）。
 *
 * 为什么记 warnings 而不抛错：`readPack` 的既有纪律是"读不动**不静默跳过**，记进 warnings"
 * （见下面那段注释），而它是**只读探针的入口** —— 抛错会让整个包读不出来，比"少一层分组"严重得多。
 *
 * @param {any} raw `halo.json` 的 `groups`
 * @param {Array<{id:string}>} points 本圈**已装配好**的知识点
 * @param {string} haloId 圆圈 id（进 warnings 文案用）
 * @param {string[]} warnings 收集口
 * @returns {Array<{id:string, name:string, points:string[]}>}
 */
export function normGroups(raw, points, haloId, warnings) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push(`圆圈 ${haloId} 的 groups 不是数组（实得 ${typeof raw}）—— 已忽略；改回数组或删掉这个字段`)
    return []
  }
  const known = new Set(points.map((p) => p.id))
  const seen = new Map()
  const out = []
  for (const [i, g] of raw.entries()) {
    const at = `圆圈 ${haloId} 的 groups[${i}]`
    if (!g || typeof g !== 'object') { warnings.push(`${at} 不是对象 —— 已忽略`); continue }
    const gid = String(g.id || '').trim()
    if (!gid) { warnings.push(`${at} 缺 id —— 已忽略（每个组都要有 id）`); continue }
    const kept = []
    for (const pid of (Array.isArray(g.points) ? g.points : [])) {
      const p = String(pid)
      if (!known.has(p)) {
        warnings.push(`${at}（${gid}）里的知识点 id「${p}」在本圈里不存在 —— 改成圈内已有的 id，或先把它建出来（可用的：${[...known].join(' / ') || '本圈还没有知识点'}）`)
        continue
      }
      if (seen.has(p)) {
        warnings.push(`知识点「${p}」同时归给了组「${seen.get(p)}」和「${gid}」—— 一个点至多归一个组，请二选一`)
        continue
      }
      seen.set(p, gid)
      kept.push(p)
    }
    out.push({ id: gid, name: String(g.name || gid), points: kept })
  }
  return out
}

/**
 * 读一个课程包。
 *
 * @param {string} root 课程包根目录（必须有 `lessons/`）
 * @returns {{root:string, circles:Array, points:Array, lessons:Array, learned:string[], warnings:string[]}}
 */
export function readPack(root) {
  const warnings = []
  const lessonsDir = path.join(root, 'lessons')
  const srcDir = path.join(lessonsDir, 'src')

  if (!fs.existsSync(lessonsDir)) {
    warnings.push(`不是课程包：找不到 ${path.join(root, 'lessons')}`)
    return { root, circles: [], points: [], lessons: [], learned: [], warnings }
  }

  // —— 圆圈 → 知识点 ——
  const circles = []
  const pointToCircle = new Map()
  for (const haloId of fs.readdirSync(lessonsDir).sort()) {
    const haloFile = path.join(lessonsDir, haloId, 'halo.json')
    if (!fs.existsSync(haloFile)) continue
    const halo = readJsonWarn(haloFile, warnings, '圆圈')
    if (!halo) continue
    const id = halo.halo || haloId
    const points = []
    for (const pid of fs.readdirSync(path.join(lessonsDir, haloId)).sort()) {
      const pf = path.join(lessonsDir, haloId, pid, 'point.json')
      if (!fs.existsSync(pf)) continue
      const p = readJsonWarn(pf, warnings, '知识点')
      if (!p) continue
      const point = {
        id: p.point || pid,
        circle: id,
        name: p.name || p.point || pid,
        label: p.label || '',
        fileBase: Number.isFinite(p.fileBase) ? p.fileBase : 0,
        requires: Array.isArray(p.requires) ? p.requires.slice() : [],
        // 点级实践区：与圈级取**并集**（圈级是范围、点级是具体落点），见 state-scan 的 collectPracticeRoots
        practice: normPractice(p.practice),
        // 知识点地图（大纲，2026-09-24 F2）：`point.json` 的 `plan` 字段**原样带出** ——
        // 校验与判据都在 `lib/plan.js`（纯函数），这里不另做一份归一，免得两套口径。
        plan: p.plan === undefined ? null : p.plan,
      }
      points.push(point)
      pointToCircle.set(point.id, id)
    }
    if (!points.length) warnings.push(`圆圈 ${id} 下一个知识点都没有`)
    const groups = normGroups(halo.groups, points, id, warnings)
    circles.push({
      id,
      name: halo.name || id,
      // 圆圈身份色（§11，2026-09-22 落盘）：标题配色与星图恒星色都读它。
      // 归一成小写，免得 `#FFF6E2` 与 `#fff6e2` 在冻结表（小写建的）里对不上。
      color: typeof halo.color === 'string' ? halo.color.toLowerCase() : null,
      center: halo.center || '',
      inside: Array.isArray(halo.inside) ? halo.inside.slice() : [],
      outside: Array.isArray(halo.outside) ? halo.outside.slice() : [],
      shape: halo.shape || null,
      // 圈级实践区（2026-09-24 主人定：**每个知识圆圈有各自对应的实践区域**）。
      // 探针据此定扫描根（与点级 `practice.dirs` 取并集）；一个都没声明才回落配置的 codeDir。
      practice: normPractice(halo.practice),
      // 分组层（庚3 · 数据半）：`halo.json` 的**可选**字段 —— 圈 → 组 → 点 的中间层。
      // **没声明 / 空数组时不带这个键** ⇒ 下游（`content.js`）与加这个功能之前**逐字节相同**。
      // 这就是"可选字段"不落空话的根据：退化判据比的是**产物**，不是代码。
      ...(groups.length ? { groups } : {}),
      points,
    })
  }

  // —— 进度（决定课程"学过 / 没学过"）——
  // `learned` 字段**原样保留**（返回形状不变：老调用方按 `.length` 数已学数）；
  // 判"哪几门课已学"走 `packCore.resolveLearned`：只认规范课次键 `circle/point/NNNN`，
  // 历史形状（裸点 / 两段课键 / 显示名）逐条点名、**不计入已学**（迁移归 U05，重算归 U17）。
  let learned = []
  const progressFile = path.join(root, 'progress.json')
  if (fs.existsSync(progressFile)) {
    const p = readJsonWarn(progressFile, warnings, '进度')
    learned = Array.isArray(p?.learned) ? p.learned.slice() : []
  } else {
    warnings.push('没有 progress.json —— 所有课程都按"没学过"处理')
  }

  // —— 课程：从 `lessons/src/**/NNNN-*.html` 的 meta 读 ——
  const lessons = []
  for (const file of walkLessonFiles(srcDir).sort()) {
    const relParts = path.relative(srcDir, file).split(path.sep)
    const name = relParts.pop()
    const base = name.replace(/\.html$/, '')
    const text = fs.readFileSync(file, 'utf8')
    const m = text.match(LESSON_META_RE)
    if (!m) { warnings.push(`${relParts.concat(name).join('/')} 没有 data-lesson-meta，跳过`); continue }
    let meta
    try { meta = JSON.parse(m[1]) } catch (e) { warnings.push(`${name} 的 meta 不是合法 JSON，跳过`); continue }

    // 归属：**路径优先，meta 可覆盖**；平铺布局走兜底（与两个 tools/ 脚本同一条规则）
    const legacy = relParts.length < 2
    const haloId = meta.halo || (legacy ? LEGACY_HALO : relParts[0])
    const pointId = meta.point || (legacy ? LEGACY_POINT : relParts[1])
    if (!pointToCircle.has(pointId)) { warnings.push(`${name} 指向不存在的知识点 ${haloId}/${pointId}，跳过`); continue }
    if (legacy) warnings.push(`${name} 是历史平铺布局（按 ${haloId}/${pointId} 归档）—— 目录重构后应消失`)

    const point = circles.find((c) => c.id === haloId)?.points.find((p) => p.id === pointId)
    const number = Number(meta.number) || 0
    // 课程身份 = **规范课次键** circle/point/NNNN（经严格内核构造；非法就点名跳过，不拼一个假 id）
    let id
    try {
      id = identityCore.lessonKey(haloId, pointId, number)
    } catch (e) {
      warnings.push(`${name} 的课次身份不合法（${e?.message ?? e}），跳过`)
      continue
    }
    // 显示号按 point.json 的 fileBase 折算（镜像 tools/build-starmap.js:180）
    const displayNumber = displayNumberOf(number, point?.fileBase)
    lessons.push({
      id,
      circle: haloId,
      point: pointId,
      pointName: point?.name || pointId,
      number,
      displayNumber,
      label: point?.label ? `${point.label} 第${displayNumber}课` : `第${displayNumber}课`,
      title: meta.title || '',
      navTitle: meta.navTitle || meta.title || '',
      href: `lessons/${relParts.concat(`${base}.html`).join('/')}`,
      learned: false,
      termCount: Object.keys(meta.terms || {}).length,
      source: meta.source?.label || '',
      sourceUrl: meta.source?.url || '',
      flag: (meta.flag === 'red' || meta.flag === 'yellow') ? meta.flag : null,
      file: `${relParts.concat(`${base}.html`).join('/')}`,
    })
  }
  lessons.sort((a, b) => a.point.localeCompare(b.point) || a.number - b.number)

  // —— 进度对位（规范身份）＋ 自查：进度里有没有"不存在的课程" ——
  //   幽灵条目会把星图点不亮还查不出原因；历史形状则要点名"它不是规范键"，两者措辞不同、都不静默。
  const learnedResolved = packCore.resolveLearned(learned, {
    byKey: Object.fromEntries(lessons.map((l) => [l.id, l])),
  })
  const litSet = new Set(learnedResolved.lit)
  for (const l of lessons) l.learned = litSet.has(l.id)
  for (const problem of learnedResolved.problems) warnings.push(problem)

  return { root, circles, points: circles.flatMap((c) => c.points), lessons, learned, warnings }
}

/**
 * 前置体检 —— 「要学这个知识点，前置还差哪些课？」
 * ------------------------------------------------------------------
 * 2026-09-23 用户裁定：**开课摸底时就要判前置**；没学会就先建议他去补那门课，
 * 而不是继续给他生成新课。这条规矩此前只写在 `_plugin-prep/LESSON-FLOW.md`
 * （「前置闭包」「不出现前置没教」），**没有任何机器判据**，所以 Vue 第1课能直接
 * 建在"学生连 HTML 都没学过"的地基上。
 *
 * 真源早就有了：`lessons/<圆圈>/<知识点>/point.json` 的 `requires`，
 * 由 `readPack()` 解析进 `points[].requires`。在此之前它只被课程包侧
 * `tools/build-starmap.js` 拿去画星图虚线航道 —— 数据一直在，缺的是"当闸用"这一步。
 *
 * 判定粒度 = **课**，不是点。点级只能问"这个知识点碰过没有"，学生碰过第 1 课
 * 就算碰过 —— 那恰好放过本机的真实情形（spring-boot 0001 已掌握、0002 一处未开始，
 * 却要开 Vue 第1课）。课级才拦得住。
 *
 * 悬空 / 成环由课程包侧 `tools/build-starmap.js` 硬闸拦（exit 1）；这里仍做防御：
 * 解析不到的 requires 进 `ghostRequires`，成环靠 visited 集合兜住（不会死循环）。
 *
 * @param {object} pack `readPack(root)` 的返回值
 * @param {string} pointId 要学的知识点 id（如 'vue'）
 * @returns {{
 *   ok: boolean,                       // **能不能往下走** —— 只被"真有可执行的缺口"置 false
 *   pointId: string,
 *   reason: 'ok'|'unknown-point'|'missing',
 *   closure: string[],
 *   missing: Array<object>,
 *   emptyPoints: string[],
 *   ghostRequires: string[],
 * }}
 */
export function prerequisiteGaps(pack, pointId) {
  const points = pack?.points ?? []
  const lessons = pack?.lessons ?? []
  const target = points.find((p) => p.id === pointId)
  if (!target) {
    // ⚠️ 找不到这个知识点 **不拦**（ok:true）。理由：课程包读不动、或这个知识点刚建还没写进
    //    point.json 时，我们**没有任何依据**说它的前置没学好 —— 拿"不知道"当"不合格"会误拦
    //    正在新建的第一课（本仓库的判据一律"没数据就不猜"，这里同理）。
    //    真有缺口的形状只有一种：reason === 'missing'。
    return { ok: true, pointId, reason: 'unknown-point', closure: [], missing: [], emptyPoints: [], ghostRequires: [] }
  }

  // 与包侧 build-starmap.js 同一条解析规则：ref 带 `/` 就是全路径，否则按**同圆圈**解析
  // （身份构造一律经 `lib/unify/identity.cjs` 严格内核 —— 本文件不许再内联拼 `circle/point`）
  const byQualified = new Map(points.map((p) => [identityCore.pointKey(p.circle, p.id), p]))
  const resolve = (ref, circle) => {
    const s = String(ref)
    return byQualified.get(s.includes('/') ? s : identityCore.pointKey(circle, s)) ?? null
  }

  const closure = []
  const ghostRequires = []
  const seen = new Set([identityCore.pointKey(target.circle, target.id)])
  const queue = [target]
  while (queue.length) {
    const cur = queue.shift()
    for (const ref of cur.requires ?? []) {
      const dep = resolve(ref, cur.circle)
      if (!dep) { ghostRequires.push(`${identityCore.pointKey(cur.circle, cur.id)} → ${ref}`); continue }
      const key = identityCore.pointKey(dep.circle, dep.id)
      if (seen.has(key)) continue
      seen.add(key)
      closure.push(dep.id)
      queue.push(dep)
    }
  }

  const closurePoints = closure.map((id) => points.find((p) => p.id === id))
  const emptyPoints = closurePoints.filter((p) => !lessons.some((l) => l.point === p.id)).map((p) => p.id)
  const missing = lessons
    .filter((l) => closure.includes(l.point) && !l.learned)
    .sort((a, b) => a.point.localeCompare(b.point) || a.number - b.number)

  const ok = missing.length === 0 && emptyPoints.length === 0 && ghostRequires.length === 0
  return { ok, pointId, reason: ok ? 'ok' : 'missing', closure, missing, emptyPoints, ghostRequires }
}

/**
 * 把 `prerequisiteGaps()` 的结果说成一句人话（工具输出与拒绝理由共用一份措辞）。
 * @param {object} gaps
 * @returns {string}
 */
export function describeGaps(gaps) {
  if (!gaps) return ''
  if (gaps.reason === 'unknown-point') return `课程包里找不到知识点 ${gaps.pointId} —— 没有已知前置，不拦`
  if (gaps.ok) return `${gaps.pointId} 的前置都已学过`
  const bits = []
  if (gaps.missing.length) {
    bits.push(`还没学的课：${gaps.missing.map((l) => `${l.label}（${l.title}）`).join('、')}`)
  }
  if (gaps.emptyPoints.length) bits.push(`前置知识点还没有课：${gaps.emptyPoints.join('、')}`)
  if (gaps.ghostRequires.length) bits.push(`悬空的前置：${gaps.ghostRequires.join('、')}`)
  return `先补齐 ${gaps.closure.join('、')} —— ${bits.join('；')}`
}

/** 一句话摘要（给工具的 render 用） */
export function packSummary(pack) {
  const lit = pack.lessons.filter((l) => l.learned).length
  return `${pack.circles.length} 个圆圈 · ${pack.points.length} 个知识点 · ${pack.lessons.length} 门课程（已点亮 ${lit}）`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv.includes('--selftest')) {
  const packArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  // 包路径：显式参数 → 环境变量 DSH_WHALE_PACK → 报错给用法。
  // **不猜「插件旁边那个 study」** —— 那是作者本机的布局，装到别人机器上（node_modules 里）一定不存在。
  const packBase = packArg ?? ((process.env.DSH_WHALE_PACK || '').trim() || null)
  if (!packBase) {
    console.error('用法：node lib/pack-model.js --selftest <课程包根>')
    console.error('  或：DSH_WHALE_PACK=<课程包根> node lib/pack-model.js --selftest')
    process.exit(2)
  }
  const ROOT = path.resolve(packBase)
  const failures = []
  const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures.push(msg) }

  console.log('包路径：' + ROOT)
  const idx = lessonIndex(ROOT)
  console.log('映射表：' + Object.keys(idx.byKey).join(' | '))
  // 4 课 = spring-boot 0001/0002 + vue 1001 + **alge 0001**（2026-09-24 补的判据）
  ok(Object.keys(idx.byKey).length === 4, '映射表覆盖 4 课（' + Object.keys(idx.byKey).length + '）')
  ok(Object.keys(idx.byKey).every((k) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\d{4}$/.test(k)), '每一课的键都是**规范课次键** circle/point/NNNN 形状（跨圈同号不再串页）')
  ok(Object.values(idx.byKey).every((e) => e.src && e.page), '每一课都同时有课程源与产物页')
  // 显示名必须**全局唯一**：跨圈同号（`programming/spring-boot/0001` 与 `math/alge/0001` 都叫「第1课」）
  // 会让显示层"看谁后遍历到"。alge 补了 label ⇒ 显示名成「代数 第1课」（2026-09-24）
  ok(
    idx.byLabel['第1课'] && idx.byLabel['第2课'] && idx.byLabel['Vue 第1课'] && idx.byLabel['代数 第1课'],
    '显示名索引查得到（含两条带 label 的轨道：「Vue 第1课」「代数 第1课」）—— 它只服务显示，不参与身份解析'
  )
  ok(idx.conflicts.length === 0, '无 conflict' + (idx.conflicts.length ? '（实得：' + idx.conflicts.join('；') + '）' : ''))

  // 反向那一步（课次键 → 显示名）只经 labelOfAnchor：往返必须回到同一个显示名，
  // 否则"写入口存键、读点反推名"这条链就断了（笔记会静默挂不上课）
  ok(Object.keys(idx.byKey).every((k) => labelOfAnchor(k, idx) === idx.byKey[k].label), 'labelOfAnchor 往返：每个 circle/point/NNNN 键都反推回自己的显示名')
  ok(labelOfAnchor('nope/9999', idx) === null, '解析不到的 anchor → null（不瞎猜一个课次）')
  ok(labelOfAnchor(undefined, idx) === null && labelOfAnchor('', idx) === null, '空 / 缺 anchor → null（旧格式记录不会被错算到某课头上）')
  // 显示名 / 两段课键**不是**身份：运行态不归一（U-SPEC §2；历史解码只在 U05）
  ok(labelOfAnchor('第1课', idx) === null, '显示名当 anchor → null（显示文字不是身份，运行态不再归一）')
  ok(labelOfAnchor('spring-boot/0001', idx) === null, '两段课键当 anchor → null（缺圆圈的历史形状不归一）')
  // 「未归课」是**显式桶**（没归到课的记录都去那儿）：它不在课次映射表里，但必须被认 ——
  // 否则那个桶的笔记读不回（`loadNotes` 的过滤条件正是 `labelOfAnchor`），表单还会 400 拒写。
  ok(labelOfAnchor('未归课', idx) === '未归课', '显式桶「未归课」→ 它自己（那个桶的笔记读得回）')
  ok(keyOfAnchor('未归课', idx) === '未归课', '显式桶「未归课」→ 哨兵键（写入口收下，不再 400 拒写）')

  // ── 宿主 ↔ 课程包侧：**同一份内核**（不再是两份实现 + 对拍） ──
  // 包侧工具是 CommonJS、且要能脱离插件独立运行 —— 它现在只 require `./unify/pack.cjs`
  // （U19 生成的逐字节副本），所以这里比的是"同一个模块"的行为，而不是"两套算法的输出"。
  let packMod = null
  try {
    packMod = createRequire(import.meta.url)(path.join(ROOT, 'tools', 'lesson-map.js'))
  } catch (e) {
    ok(false, '包侧课次映射表装载失败（' + (e?.message ?? e) + '）—— 路径应为 <包>/tools/lesson-map.js（它委托 tools/unify/pack.cjs，该副本由 U19 生成；U19 之前必缺）')
  }
  if (packMod) {
    const proj = (m) => Object.keys(m.byKey).sort().map((k) => {
      const e = m.byKey[k]
      return [k, e.label, e.point, e.number, e.title ?? null]
    })
    const pm = packMod.lessonMap(ROOT)
    ok(JSON.stringify(proj(pm)) === JSON.stringify(proj(idx)), '同一份内核：包侧 lesson-map.js 与 lessonIndex() 逐键一致（' + Object.keys(idx.byKey).length + ' 键 × label/point/number/title）')
    const both = (a) => [packMod.labelOfAnchor(a, pm), labelOfAnchor(a, idx)]
    ok(Object.keys(idx.byKey).every((k) => both(k)[0] === both(k)[1]), '同一份内核：labelOfAnchor 两边行为一致（每个真实键）')
    ok(both('nope/9999')[0] === both('nope/9999')[1] && both('nope/9999')[0] === null, '同一份内核：labelOfAnchor 解析不到时两边都 → null（不瞎猜一个课次）')
    ok(both('第1课')[0] === null && both('第1课')[1] === null, '同一份内核：显示名两边都不认（运行态只认规范身份）')
    ok(both('未归课')[0] === both('未归课')[1] && both('未归课')[0] === '未归课', '同一份内核：显式桶「未归课」两边都认（读侧一致）')
    // 写入口那一步（写法 → 键）也只走同一份内核
    const bothKey = (a) => [packMod.keyOfAnchor(a, pm), keyOfAnchor(a, idx)]
    ok(Object.keys(idx.byKey).every((k) => { const b = bothKey(k); return b[0] === k && b[1] === k }), '同一份内核：keyOfAnchor 把规范课次键还原成它自己（两边一致）')
    ok(Object.values(idx.byKey).every((e) => { const b = bothKey(e.label); return b[0] === null && b[1] === null }), '同一份内核：keyOfAnchor 不再把「第N课」归一成课次键（显示名 → 身份的职责已从运行态删除）')
    ok(bothKey('nope/9999')[0] === null && bothKey('nope/9999')[1] === null, '同一份内核：keyOfAnchor 解析不到时两边都 → null（孤儿锚点会被两个写入口同样拒掉）')
    ok(bothKey('未归课')[0] === bothKey('未归课')[1] && bothKey('未归课')[0] === '未归课', '同一份内核：显式桶的哨兵键两边一致（写侧一致）')
    // 课次锚点 id（HTML id 不许含空白）同样只有一份实现，且钉**往返一致**
    // （浏览器按 percent-decode 后比对 fragment 与 id；判据见 test/mirror-parity.mjs 的 F 条）
    if (typeof packMod.labelAnchorId === 'function') {
      const anchorCases = ['第1课', 'Vue 第1课', '代数 第1课', '带  多空格\t与制表', '第1课 ']
      ok(anchorCases.every((c) => packMod.labelAnchorId(c) === labelAnchorId(c)), '同一份内核：labelAnchorId 两边一致（空白压成 -、其余不动）')
      ok(anchorCases.every((c) => !/\s/.test(labelAnchorId(c))), 'labelAnchorId 产出的 id 一律不含空白（HTML 规范对 id 的硬限制）')
      ok(decodeURIComponent(encodeURIComponent(labelAnchorId('代数 第1课'))) === labelAnchorId('代数 第1课'),
        '往返一致：fragment percent-encode 再 decode 回到同一个 id（浏览器就是这么比的）')
      let threw = false
      try { labelAnchorId('   ') } catch { threw = true }
      ok(threw, '空 label → 当场抛错（不许写出一个跳不到的锚点，也不静默编一个）')
    } else {
      ok(false, '包侧 lesson-map.js 没有 labelAnchorId —— 导出面缺一项（它必须与宿主逐名一致）')
    }
  }

  // 包侧的 `tools/pack-text.js` 是 `lib/text.js` 的对应物：笔记读取的三个读点靠它剥 BOM。
  // 少了它，一行带 BOM 的笔记会被静默丢成 0 条（2026-09-24 实测出来的真 bug）—— 所以钉住它。
  try {
    const pt = createRequire(import.meta.url)(path.join(ROOT, 'tools', 'pack-text.js'))
    const bomLines = pt.splitLines('\uFEFF{"id":"0001"}\n{"id":"0002"}')
    const allParse = bomLines.every((l) => { try { JSON.parse(l); return true } catch { return false } })
    ok(bomLines.length === 2 && allParse, '包侧 pack-text.js 逐行剥 BOM：带 BOM 的首行仍能 JSON.parse（少了它笔记会被静默丢掉）')
    ok(pt.stripBom('\uFEFFx') === 'x', '包侧 stripBom 只剥开头那一个 BOM')
  } catch (e) {
    ok(false, '包侧 pack-text.js 装载失败（' + (e?.message ?? e) + '）—— 路径应为 <包>/tools/pack-text.js')
  }

  const s1 = scanTerms(ROOT)
  console.log('扫描器：含 pre ' + s1.totalAll + ' 处 / 去掉 pre ' + s1.totalOutside + ' 处' + (s1.inPre.length ? '；pre 内 ' + s1.inPre.join(',') : '；pre 内 0'))
  const s2 = scanTerms(ROOT)
  ok(JSON.stringify(s1) === JSON.stringify(s2), '确定性：同输入两次扫描结果逐字节相同')

  const rep = checkTermsReport(ROOT)
  console.log('check-terms 自报：' + JSON.stringify(rep.marks) + ' · 自称代码块内无标记=' + rep.saysNoMarkInCode)
  // check-terms 扫的是 lessons + reference（页序 lessons 在前），本扫描器只管课程页 →
  // 只能拿它的**课程页前缀**对拍。第一版拿总数对拍，于是把 reference 页那 1 处算进来，
  // 报出"72 vs 71"的假冲突 ✗ —— 这正是本项目要消灭的那类错：同一事实两套口径。
  const lessonsMarks = rep.marks.slice(0, s1.pages.length).slice().sort((a, b) => a - b)
  const mine = s1.pages.map((p) => p.all).sort((a, b) => a - b)
  ok(JSON.stringify(lessonsMarks) === JSON.stringify(mine), '逐页标记数对拍一致（check-terms ' + JSON.stringify(lessonsMarks) + ' vs 扫描器 ' + JSON.stringify(mine) + '）')
  ok(lessonsMarks.reduce((a, b) => a + b, 0) === s1.totalAll, '课程页合计一致（' + s1.totalAll + '）')
  console.log('非课程页另有 ' + (rep.marks.reduce((a, b) => a + b, 0) - s1.totalAll) + ' 处（reference/，本扫描器按设计不管）')
  ok(!rep.saysNoMarkInCode || s1.inPre.length === 0, 'check-terms 说"代码块内无标记"，扫描器也必须找不到 pre 内标记')

  const loaded = await loadBoxes(ROOT)
  const val = validateBoxes(loaded.boxes, idx)
  console.log('box 装载：' + JSON.stringify(val.counts))
  if (loaded.problems.length) console.log('  装载问题：' + loaded.problems.slice(0, 5).join('；'))
  ok(loaded.boxes.length >= 62, '三类 box 装进来了（' + loaded.boxes.length + ' 个）')
  ok((val.counts['名词解释'] || 0) >= 62, '名词解释 box 至少 62 条（台账 62 条）')
  ok(loaded.problems.length === 0, '装载无问题' + (loaded.problems.length ? '（' + loaded.problems.slice(0, 3).join('；') + '）' : ''))
  ok(val.problems.length === 0, '不变量通过：id 不撞、anchor 都能解析' + (val.problems.length ? '（实得 ' + val.problems.slice(0, 3).join('；') + '）' : ''))
  const again = await loadBoxes(ROOT)
  ok(JSON.stringify(again.boxes) === JSON.stringify(loaded.boxes), '确定性：两次装载逐字节相同')
  console.log('笔记 box：' + (val.counts['笔记'] || 0) + ' 个（台账 0 条 → 0 且不报错）')

  // ── 前置体检（2026-09-23）：判据用**合成包**钉住，不读盘。
  //    学生的进度天天变，拿真包断言"缺哪几课"第二天就红 —— 那是脆，不是严。
  //    真包只做结构烟测（找得到 vue、返回结构完整）。
  {
    const mk = (learned) => ({
      points: [
        { id: 'html', circle: 'programming', requires: [] },
        { id: 'js', circle: 'programming', requires: ['html'] },
        { id: 'spring-boot', circle: 'programming', requires: [] },
        { id: 'vue', circle: 'programming', requires: ['js', 'spring-boot'] },
      ],
      lessons: [
        { id: 'html/2001', point: 'html', number: 2001, label: 'HTML 第1课', title: '骨架', learned: learned.includes('html/2001') },
        { id: 'js/3001', point: 'js', number: 3001, label: 'JS 第1课', title: '语法', learned: learned.includes('js/3001') },
        { id: 'spring-boot/0001', point: 'spring-boot', number: 1, label: '第1课', title: 'hello', learned: learned.includes('spring-boot/0001') },
      ],
    })
    const g0 = prerequisiteGaps(mk([]), 'vue')
    ok(g0.closure.join(',') === 'js,spring-boot,html', '前置体检：闭包是传递的（vue → js,spring-boot,html）')
    ok(g0.missing.map((l) => l.id).join(',') === 'html/2001,js/3001,spring-boot/0001',
      '前置体检：闭包里没学过的课全列出来（按知识点 + 课号排）')
    const g1 = prerequisiteGaps(mk(['html/2001', 'js/3001', 'spring-boot/0001']), 'vue')
    ok(g1.ok && g1.reason === 'ok', '前置体检：前置都学过了 → ok（不拦）')
    const g2 = prerequisiteGaps(mk([]), 'html')
    ok(g2.ok && g2.closure.length === 0, '前置体检：没有 requires 的知识点 → 直接 ok（写它的第一课不该被自己拦住）')
    ok(prerequisiteGaps(mk([]), 'nope').reason === 'unknown-point', '前置体检：不认识的知识点 → unknown-point')
    ok(prerequisiteGaps(mk([]), 'nope').ok === true,
      '前置体检：**不知道就不拦**（拿"读不动/还没建"当"不合格"会误拦正在新建的第一课）')
    const g3 = prerequisiteGaps({
      points: [{ id: 'vue', circle: 'programming', requires: ['ghost-point'] }, { id: 'ghost-point', circle: 'programming', requires: [] }],
      lessons: [],
    }, 'vue')
    ok(!g3.ok && g3.emptyPoints.join(',') === 'ghost-point', '前置体检：前置知识点一门课都还没有 → 拦（否则学生会等一门不存在的课）')
    const cyc = { points: [{ id: 'a', circle: 'p', requires: ['b'] }, { id: 'b', circle: 'p', requires: ['a'] }], lessons: [] }
    ok(prerequisiteGaps(cyc, 'a').closure.join(',') === 'b', '前置体检：成环不死循环（visited 兜住）')
    ok(prerequisiteGaps({ points: [{ id: 'x', circle: 'p', requires: ['nope'] }], lessons: [] }, 'x').ghostRequires.length === 1,
      '前置体检：悬空 requires 进 ghostRequires 并判不 ok')

    const real = readPack(ROOT)
    const gv = prerequisiteGaps(real, 'vue')
    ok(gv.reason !== 'unknown-point', '真包：vue 这个知识点找得到')
    ok(typeof gv.ok === 'boolean' && Array.isArray(gv.missing) && Array.isArray(gv.closure), '真包：前置体检返回结构完整')
    console.log('真包前置体检：vue → ' + (gv.ok ? 'ok' : describeGaps(gv)))

    // ── 庚3 · 数据半：分组层（`halo.json` 的可选 `groups[]`）—— 四条规则各一条对拍 ──
    {
      // ① **可选 / 退化**：没声明的圈**不带这个键** ⇒ 下游 content.js 与加这功能之前逐字节相同
      const math = real.circles.find((c) => c.id === 'math')
      ok(math && !('groups' in math), '分组层①：没声明 groups 的圈**不带这个键**（可选字段的退化成立）')
      const prog = real.circles.find((c) => c.id === 'programming')
      ok(prog && Array.isArray(prog.groups) && prog.groups.length === 2,
        `分组层：programming 圈读到 ${prog && prog.groups ? prog.groups.length : 0} 个组`)
      ok(prog && prog.groups.every((g) => g.id && g.name && Array.isArray(g.points)),
        '分组层：每个组都归一成 {id, name, points[]}')

      // ② 坏 id ⇒ 记 warnings **并给修法**（不静默跳过）
      const w2 = []
      const bad = normGroups([{ id: 'g1', name: 'G', points: ['nope'] }], [{ id: 'a' }], 'demo', w2)
      ok(w2.length === 1 && /在本圈里不存在/.test(w2[0]) && /可用的：a/.test(w2[0]),
        `分组层②：坏 id 记 warnings 并给修法（${w2[0] || '没报 = 空转 ✗'}）`)
      ok(bad[0].points.length === 0, '分组层②：坏 id 不静默留在组里（那个组被归成空 points）')

      // ③ 重复归组 ⇒ 记 warnings
      const w3 = []
      normGroups([{ id: 'g1', points: ['a'] }, { id: 'g2', points: ['a'] }], [{ id: 'a' }], 'demo', w3)
      ok(w3.length === 1 && /至多归一个组/.test(w3[0]), `分组层③：重复归组记 warnings（${w3[0] || '没报 = 空转 ✗'}）`)

      // ④ **防丢**：没被任何组收的点**仍在 points 里**（归一不会把它从圈上摘掉）
      const w4 = []
      const g4 = normGroups([{ id: 'g1', points: ['a'] }], [{ id: 'a' }, { id: 'b' }], 'demo', w4)
      ok(w4.length === 0 && g4[0].points.join(',') === 'a' && !g4.some((g) => g.points.includes('b')),
        '分组层④：没归组的点不在任何组里 —— 防丢：它仍由 points[] 挂在圈上')

      // ⑤ 边界：不是数组 / 缺 id ⇒ 都不静默
      const w5 = []
      normGroups('nope', [], 'demo', w5)
      normGroups([{ name: '没 id' }], [], 'demo', w5)
      ok(w5.length === 2 && /不是数组/.test(w5[0]) && /缺 id/.test(w5[1]),
        `分组层⑤：不是数组 / 缺 id 都记 warnings（实得 ${w5.length} 条）`)
    }
  }

  console.log('\n=== selftest: ' + (failures.length ? failures.length + ' 失败' : '全部通过') + ' ===')
  process.exit(failures.length ? 1 : 0)
}
