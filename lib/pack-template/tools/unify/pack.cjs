'use strict'
/**
 * lib/unify/pack.cjs —— 课程包读取 / 课次映射的**唯一**解析实现（U09 新建）
 * ======================================================================
 * 这个文件收掉的是两类"同一件事两份实现"：
 *
 *   ① **宿主 ↔ 课程包侧**：`lib/pack-model.js`（ESM，插件侧）与
 *      `lib/pack-template/tools/lesson-map.js`（CJS，包侧，要能脱离插件独立跑）
 *      曾经各自实现了 `lessonIndex()` / `lessonMap()` 与 `labelOfAnchor` / `keyOfAnchor` /
 *      `labelAnchorId`，靠 `test/mirror-parity.mjs` 与 `--selftest` 的对拍**钉住不漂**。
 *      本文件是那份算法**唯一**的实现：宿主与包侧都只委托这里（包侧经 U19 生成的
 *      `tools/unify/pack.cjs` 逐字节副本），于是"对拍"从"发现漂移"变成"同一份代码"。
 *
 *   ② **身份构造**：`pointKey` / `lessonKey` 的严格内核已经在 `./identity.cjs`（U02）。
 *      本文件**不复制**那条规则，一律经 `identity.*` 构造与解析；`lib/pack-model.js` 的
 *      既有公开导出也委托给它（U02 登记的 staging.dualImplementation，owner=U09，本卡兑现）。
 *
 * ## 课程身份（U-SPEC §2）
 *
 *   知识点键   `circle/point`
 *   课次键     `circle/point/NNNN`（课号 1–9999，四位十进制）
 *
 * 运行态**只认**规范形状。裸点、两段课键（`point/课号`）、显示名（`第1课` / `Vue 第1课`）、
 * 空段、路径逃逸、非四位课号一律**明确拒绝**（`resolveLessonRef` 给出可机器判读的 reason），
 * 不做隐式双读、不按环境/调用栈/测试目录改规则、不留长期别名。
 * 历史形状的唯一解码在 `./migration.cjs`（U05），本模块**不 require 它**。
 *
 * ## EXPECT.json 的 `lessons[].id` 是**声明**，不是身份引用（实测口径，别推）
 *
 * 基线里它是**两段** `point/NNNN`：`test/_fixture.mjs:379` 的合成夹具手写的就是这个形状；
 * U05 的迁移清单（`WRITABLE_FILES`）不含 EXPECT.json；任何 U 卡的写集也都没有它（学生工作区里
 * 手写的文件）。所以这里**不**把它当身份键来解析，而是按 (知识点, 课号) 对位到
 * `lessons/<circle>/<point>/NNNN-*.html` —— 圆圈由**目录结构**唯一确定：
 *   · 页面路径给出圆圈 → 直接对位；
 *   · 只有声明、没有路径圆圈 → 该知识点在 `lessons/` 里必须**恰好归一个圆圈**；
 *     0 个 = 缺归属 / ≥2 个 = **归属歧义**，都进 conflicts 并点名候选（**绝不按"第一个"猜**）。
 * 同理，`progress.json` 的 `learned` 是**进度引用**（不是声明）：只认规范 `circle/point/NNNN`，
 * 见 `resolveLearned()` —— 旧形状逐条点名、不计入已学，迁移归 U05 / 重算归 U17。
 *
 * ## 依赖纪律
 *
 * 纯 CJS；只依赖 Node 内置（`node:fs` / `node:path`）与同目录的 `./identity.cjs`。
 * 不 require 任何 ESM、不读环境变量、不用随机数、不看时钟、无可变模块状态 ——
 * 同一棵盘上的树永远给出同一个映射表（`--selftest` 的确定性判据就钉在这条上）。
 *
 * ## failure 形状
 *
 * 身份解析失败回 `{kind:'input', reason, field, value, error, candidates?}` ——
 * `reason` 是本模块**自己的**机器枚举（`REF_REASONS`），沿用 `identity.cjs` 的 failure 风格；
 * `candidates` 只在"歧义/可定位"时给（诊断用，**不是**自动迁移的入口）。
 * 全仓错误码仍只归 `./errors.cjs`（U03）；这里**不新增、不复用**任何码值。
 *
 * @see ./identity.cjs 身份构造与解析的唯一严格内核（U02）
 * @see ./migration.cjs 历史形状的唯一解码（U05，运行态不调用）
 */

const fs = require('node:fs')
const path = require('node:path')

const identity = require('./identity.cjs')

/** 历史平铺布局（`lessons/NNNN-*.html`）的兜底归属 —— 与 `readPack` / `build-lessons` / U05 **同值** */
const LEGACY_HALO = 'programming'
const LEGACY_POINT = 'spring-boot'

/** 没归到课的记录归到这个**显式的**桶（哨兵键，不是身份，原样保留既有语义） */
const UNLESSON = '未归课'

/** 课次页文件名：`NNNN-slug.html` */
const LESSON_FILE_RE = /^(\d{4})-(.+)\.html$/

/** EXPECT 两段声明：`point/NNNN`（见文件头"EXPECT 是声明"） */
const EXPECT_DECL_RE = /^(.+)\/(\d{4})$/

/** 显示名的形状（`第1课` / `Vue 第1课`）—— 它是**显示文字**，不是身份 */
const DISPLAY_NAME_RE = /第\s*\d+\s*课/

/**
 * 身份解析失败的机器枚举。**本模块私有语义**，不外溢成全仓错误码表（那是 `errors.cjs` 的事）。
 * 顺序即文档顺序。
 */
const REF_REASONS = Object.freeze({
  NOT_STRING: 'not-string',
  EMPTY: 'empty',
  WHITESPACE_ONLY: 'whitespace-only',
  UNTRIMMED: 'untrimmed',
  DISPLAY_NAME: 'display-name',
  HISTORICAL_LESSON_KEY: 'historical-lesson-key',
  POINT_KEY_IN_LESSON_SLOT: 'point-key-in-lesson-slot',
  BARE_POINT: 'bare-point',
  BARE_LESSON_NUMBER: 'bare-lesson-number',
  NARROW_LESSON_NUMBER: 'narrow-lesson-number',
  WIDE_LESSON_NUMBER: 'wide-lesson-number',
  OUT_OF_RANGE: 'out-of-range',
  UNKNOWN: 'unknown',
  AMBIGUOUS: 'ambiguous',
  MALFORMED: 'malformed',
})

/* ── 小工具（不读盘以外什么都不做） ─────────────────────────────────────── */

const readText = (p) => fs.readFileSync(p, 'utf8')
const relOf = (root, p) => path.relative(root, p).split(path.sep).join('/')

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 冻结一条解析失败（不可变；调用方既能读也能比对） */
function refFailure(reason, value, error, candidates) {
  const out = { kind: 'input', reason, field: 'value', value, error: error }
  if (Array.isArray(candidates)) out.candidates = Object.freeze(candidates.slice())
  return Object.freeze(out)
}

/** 一条课次页（`lessons[/src]/<circle>/<point>/NNNN-slug.html`） */
function lessonPage(circle, point, number, slug, fields) {
  const out = { circle, point, number, slug, src: null, page: null }
  return Object.assign(out, fields || {})
}

/* ══════════════════════════════════════════════════════════════════════
 * §1 显示换算（纯函数；fileBase 只做既有显示折算，**不减号/不取模**）
 * ══════════════════════════════════════════════════════════════════════ */

/** 第 0001 课 → '第1课'（本项目唯一的人类可读课次写法） */
function lessonLabel(number) {
  return '第' + Number(number) + '课'
}

/**
 * 编号折算：**文件号（内部 ID）→ 显示号**。fileBase 来自 point.json（缺省 0 = 不折算）。
 * 判定与 `readPack` / `build-starmap` 同一条：只影响**显示**，绝不改号。
 */
function displayNumberOf(number, fileBase) {
  return Number(number) - (Number(fileBase) || 0)
}

/**
 * 课次显示名（`代数 第1课`）→ **HTML 锚点 id**（`代数-第1课`）。
 *
 * 这是**页面领域**的函数（HTML 规范对 id 的唯一限制是不得含 ASCII 空白且非空），
 * 与课程身份无关：**不得**把页面锚点（含答疑页的 `q0001`）当课程键用（U-SPEC §2）。
 */
function labelAnchorId(label) {
  const id = String(label == null ? '' : label).trim().replace(/\s+/g, '-')
  if (!id) throw new Error(`课次锚点 id 为空（label=${JSON.stringify(label)}）—— 不许写出一个跳不到的锚点`)
  return id
}

/* ══════════════════════════════════════════════════════════════════════
 * §2 目录读取（point.json / 实践区 / 课次页）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 扫 `lessons/<circle>/<point>/point.json` → [{circle, dirPoint, point, label, fileBase}]。
 * **带圆圈**：跨圈同名知识点（`programming/vue` 与 `math/vue`）的 label/fileBase 绝不串。
 */
function pointDirs(abs) {
  const out = []
  const dir = path.join(abs, 'lessons')
  if (!fs.existsSync(dir)) return out
  for (const circle of fs.readdirSync(dir)) {
    const cirAbs = path.join(dir, circle)
    if (!isDir(cirAbs)) continue
    for (const pid of fs.readdirSync(cirAbs)) {
      const pf = path.join(cirAbs, pid, 'point.json')
      if (!fs.existsSync(pf)) continue
      let d
      try {
        d = JSON.parse(readText(pf))
      } catch {
        continue
      }
      out.push({
        circle,
        dirPoint: pid,
        point: d && (d.point || pid),
        label: (d && d.label) || '',
        fileBase: Number(d && d.fileBase) || 0,
      })
    }
  }
  return out
}

/**
 * `point → {label, fileBase}`（既有导出面：包侧 `lesson-map.pointMeta` 就是这个形状）。
 * ⚠️ 跨圈**同名知识点**时后遍历到的会覆盖前面的 —— 那是这个**旧导出**的形状限制；
 *    `lessonIndex()` 内部用的是 `pointDirs()`（带圆圈），不靠这张表定归属。
 */
function pointMeta(root) {
  const out = new Map()
  for (const p of pointDirs(path.resolve(root))) out.set(p.point, { label: p.label, fileBase: p.fileBase })
  return out
}

/**
 * 学生工作区目录（相对包根）—— **从课程包自己的判据快照读**（`learning-records/state.json`）。
 * 快照不在 / 没这个字段 / 读不动 → 退回 `['code']`（老包照旧，零回归）。
 * 与 `lib/state-scan.js#collectPracticeRoots`、包侧 `tools/lesson-map.js` 读**同一个源**。
 */
function readPracticeRoots(abs) {
  try {
    const doc = JSON.parse(readText(path.join(abs, 'learning-records', 'state.json')))
    const list = Array.isArray(doc && doc.practiceRoots)
      ? doc.practiceRoots.map((d) => String(d == null ? '' : d).trim()).filter(Boolean)
      : []
    if (list.length) return [...new Set(list)].sort()
    // 老快照（只有 codeDir、没有 practiceRoots）→ 当成单根，**零回归**
    const v = doc && typeof doc.codeDir === 'string' ? doc.codeDir.trim() : ''
    return [v || 'code']
  } catch {
    return ['code']
  }
}

/**
 * 收集课次页（源 `lessons/src/**` 与产物 `lessons/**`，递归，跳过任何名为 `src` 的目录）。
 *
 * 归属规则（与基线两份实现逐条对应，不发明新规则）：
 *   `lessons[/src]/<circle>/<point>/NNNN-*.html` → 圆圈/知识点就是路径上那两层；
 *   `lessons[/src]/<point>/NNNN-*.html`（两层）→ 知识点是那层，**圆圈待定**（交 §3 解析）；
 *   `lessons[/src]/NNNN-*.html`（旧平铺）→ 知识点 = `LEGACY_POINT`，圆圈待定。
 *
 * @returns {Map<string, object>} key = `circle\0point\0NNNN`（圆圈待定时 circle 为空串）
 */
function collectPages(abs) {
  const pages = new Map()

  const add = (field, parts, relPath) => {
    const file = parts[parts.length - 1]
    const m = LESSON_FILE_RE.exec(file)
    if (!m) return
    let circle = null
    let point = null
    if (parts.length >= 3) {
      circle = parts[0]
      point = parts[1]
    } else if (parts.length === 2) {
      point = parts[0]
    } else {
      point = LEGACY_POINT
    }
    const key = `${circle == null ? '' : circle}\u0000${point}\u0000${m[1]}`
    const prev = pages.get(key) || lessonPage(circle, point, m[1], m[2])
    prev[field] = relPath
    pages.set(key, prev)
  }

  const walk = (rootAbs, field, baseRel) => {
    if (!fs.existsSync(rootAbs)) return
    const step = (dirAbs, parts) => {
      let entries
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        // ⚠️ `src` 是作者态镜像，不是产物页：扫进产物集合会把 page 指到源文件上
        if (e.isDirectory()) {
          if (e.name === 'src') continue
          step(path.join(dirAbs, e.name), parts.concat(e.name))
          continue
        }
        if (!e.isFile()) continue
        const full = parts.concat(e.name)
        add(field, full, [baseRel].concat(full).join('/'))
      }
    }
    step(rootAbs, [])
  }

  walk(path.join(abs, 'lessons', 'src'), 'src', 'lessons/src')
  walk(path.join(abs, 'lessons'), 'page', 'lessons')
  return pages
}

/* ══════════════════════════════════════════════════════════════════════
 * §3 课次映射表（**唯一**实现）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 建唯一课次映射表。
 *
 * @param {string} root 课程包根
 * @returns {{byKey: object, byLabel: object, byNumber: object, conflicts: string[]}}
 *   `byKey` 的键是**规范课次键** `circle/point/NNNN`（跨圈同号不再串页）；
 *   `byLabel` 是显示名索引（**只**用于显示与"显示名撞车"检查，**不**用于身份解析）；
 *   `byNumber` 保留既有形状（`{number, slug, src, page}`，键是规范课次键），
 *   `conflicts` 是目录/源-产物/声明对位的**逐条**问题（不静默取其一）。
 */
function lessonIndex(root) {
  const abs = path.resolve(root)
  const pages = collectPages(abs)
  const points = pointDirs(abs)

  // point 名 → 候选圆圈（用于"路径没给圆圈"的归属判定；>1 = 歧义，0 = 缺归属）
  const circlesByPoint = new Map()
  for (const p of points) {
    const list = circlesByPoint.get(p.point) || []
    if (!list.includes(p.circle)) list.push(p.circle)
    circlesByPoint.set(p.point, list)
  }
  for (const [name, list] of circlesByPoint) circlesByPoint.set(name, list.slice().sort())

  const metaByKey = new Map()
  for (const p of points) if (!metaByKey.has(`${p.circle}/${p.point}`)) metaByKey.set(`${p.circle}/${p.point}`, p)

  const conflicts = []

  // ── ① 页 → 规范课次（圆圈待定的按唯一归属定；歧义/非法一律点名，不猜） ──
  const resolved = new Map() // 规范键 → {circle, point, number, slug, src, page}
  for (const [key, en] of pages) {
    let circle = en.circle
    if (circle == null) {
      const cands = circlesByPoint.get(en.point) || []
      if (cands.length > 1) {
        conflicts.push(
          `课次 ${en.point}/${en.number}（${en.page || en.src}）的圆圈有 ${cands.length} 个候选（${cands.join(' / ')}）`
            + ' —— 旧平铺布局的归属歧义，不猜'
        )
        continue
      }
      circle = cands.length === 1 ? cands[0] : LEGACY_HALO
    }
    let canon
    try {
      canon = identity.lessonKey(circle, en.point, Number(en.number))
    } catch (e) {
      conflicts.push(`课次 ${key.replace(/\u0000/g, '/')} 的身份不合法（${e && e.message ? e.message : e}）`)
      continue
    }
    const prev = resolved.get(canon)
    if (prev) {
      if (en.src) prev.src = en.src
      if (en.page) prev.page = en.page
      continue
    }
    resolved.set(canon, {
      circle, point: en.point, number: en.number, slug: en.slug, src: en.src || null, page: en.page || null,
    })
  }

  // ── ② EXPECT.json 的声明（point/NNNN 或规范三段的都有；后者顺带核对圆圈） ──
  const roots = readPracticeRoots(abs)
  const declared = new Map() // 声明 id → {id, title, expect}
  const readExpect = (exp) => {
    let doc
    try {
      doc = JSON.parse(readText(exp))
    } catch {
      return // 读不动就跳过，冲突检查会暴露
    }
    for (const l of doc.lessons || []) {
      if (!l || typeof l.id !== 'string') continue
      declared.set(l.id, { id: l.id, title: l.title, expect: relOf(abs, exp) })
    }
  }
  const walkExpect = (dir, depth) => {
    if (depth > 4) return
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    if (names.includes('EXPECT.json')) readExpect(path.join(dir, 'EXPECT.json'))
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue
      const p = path.join(dir, n)
      if (isDir(p)) walkExpect(p, depth + 1)
    }
  }
  for (const relRoot of roots) {
    const dir = path.isAbsolute(relRoot) ? relRoot : path.join(abs, relRoot)
    if (!fs.existsSync(dir)) continue
    // EXPECT.json 既可能在项目根，也可能在它的**上一层**（`<项目名>/<项目名>/` 的习惯）
    const up = path.join(path.dirname(dir), 'EXPECT.json')
    if (fs.existsSync(up)) readExpect(up)
    walkExpect(dir, 1)
  }

  const byKey = {}
  const byLabel = {}
  const byNumber = {}
  const consumed = new Set() // 已被声明对位掉的页面（剩下的要报"没声明"）

  for (const [id, d] of declared) {
    let point = null
    let number = null
    let circleHint = null
    const segs = String(id).split('/')
    if (segs.length === 3) {
      const parsed = identity.parseLessonKey(id)
      if (!parsed.ok) {
        conflicts.push('EXPECT 里的 id 形状不对：' + id)
        continue
      }
      circleHint = parsed.value.circle
      point = parsed.value.point
      number = parsed.value.number
    } else if (segs.length === 2) {
      const m = EXPECT_DECL_RE.exec(id)
      if (!m) {
        conflicts.push('EXPECT 里的 id 形状不对：' + id)
        continue
      }
      point = m[1]
      number = Number(m[2])
    } else {
      conflicts.push('EXPECT 里的 id 形状不对：' + id)
      continue
    }

    // 对位到页：给了圆圈就精确对位，没给就靠"该知识点在 lessons/ 里唯一归属的圆圈"
    const padded = String(number).padStart(4, '0')
    const candidates = [...resolved.entries()].filter(([, en]) => (
      en.point === point && Number(en.number) === number && (circleHint == null ? true : en.circle === circleHint)
    ))
    if (!candidates.length) {
      conflicts.push(id + ' 在 EXPECT 里声明了，但 lessons/ 与 lessons/src/ 里都没有 ' + padded + ' 的页面')
      continue
    }
    if (candidates.length > 1) {
      conflicts.push(
        id + ' 声明缺圆圈，而知识点 ' + point + ' 在 ' + candidates.length + ' 个圆圈里都有课程（候选：'
          + candidates.map(([k]) => k).join(' / ') + '）—— 归属歧义，不猜'
      )
      continue
    }
    const [key, e] = candidates[0]
    consumed.add(key)
    const info = metaByKey.get(`${e.circle}/${e.point}`) || { label: '', fileBase: 0 }
    const displayNumber = displayNumberOf(number, info.fileBase)
    const entry = {
      key,
      point,
      number: e.number,
      displayNumber,
      label: info.label ? `${info.label} 第${displayNumber}课` : `第${displayNumber}课`,
      pointLabel: info.label,
      fileBase: info.fileBase,
      title: d.title,
      expect: d.expect,
      src: e.src || null,
      page: e.page || null,
    }
    if (!entry.src) conflicts.push(key + ' 缺课程源（lessons/src/' + padded + '-*.html）')
    if (!entry.page) conflicts.push(key + ' 缺课程产物（lessons/' + padded + '-*.html）')
    byKey[key] = entry
    // 显示名撞车要**点名**（跨圈同号都叫「第1课」时，显示层就选不出唯一赢家；
    // 修法是给其中一个知识点加 label）。注意这是**显示层**冲突，不是身份解析。
    if (byLabel[entry.label]) {
      conflicts.push(`课次显示名撞车：${entry.label}（${byLabel[entry.label].key} 与 ${entry.key}）—— 给其中一个知识点的 point.json 加 label`)
    }
    byLabel[entry.label] = entry
  }

  // ── ③ 有页没声明（逐条点名，不静默） ──
  for (const [key, e] of resolved) {
    byNumber[key] = { number: e.number, slug: e.slug, src: e.src || null, page: e.page || null }
    if (!consumed.has(key)) {
      conflicts.push('lessons 里有 ' + key + '（' + (e.page || e.src) + '）但 EXPECT.json 没声明它')
    }
  }

  return { byKey, byLabel, byNumber, conflicts }
}

/* ══════════════════════════════════════════════════════════════════════
 * §4 课次引用的**规范解析**（运行态只认 circle/point/NNNN；历史形状明确拒绝）
 * ══════════════════════════════════════════════════════════════════════ */

/** 索引里的课次（按 point / 课号 建候选表，给拒绝理由用；不缓存、不写回索引） */
function lessonGroups(index) {
  // ⚠️ 两种等价视图都认：`lessonIndex().byKey` 的条目用 `key` 当规范键（**没有** `circle` 字段，
  //    既有返回形状不加），`readPack().lessons` 的条目用 `id`。圆圈一律从规范键自身取。
  const list = Object.values((index && index.byKey) || {})
    .map((l) => (l ? Object.assign({}, l, { key: l.key || l.id }) : null))
    .filter((l) => l && typeof l.key === 'string')
    .map((l) => ({ key: l.key, circle: l.key.split('/')[0], point: l.point, number: l.number, label: l.label }))
  const byPointName = new Map()
  const byNumber = new Map()
  for (const l of list) {
    const pl = byPointName.get(l.point) || []
    pl.push(l)
    byPointName.set(l.point, pl)
    const nl = byNumber.get(Number(l.number)) || []
    nl.push(l)
    byNumber.set(Number(l.number), nl)
  }
  return { list, byPointName, byNumber }
}

/**
 * 解析一个课次引用，**只认**规范形状 `circle/point/NNNN`（与哨兵 `未归课`）。
 *
 * 拒绝时给出可机器判读的 `reason`（`REF_REASONS`）与（能定位时）`candidates` ——
 * 但**绝不**返回"猜出来的规范键"：历史形状只在 `./migration.cjs`（U05）里解码。
 *
 * @param {string} value 引用（台账 anchor / 进度条目 / 调用方写法）
 * @param {{byKey: object}} index `lessonIndex(root)` 的返回值（只要有 byKey 就够）
 * @returns {{ok:true, key:string, sentinel?:boolean}|{ok:false, failure:object}}
 */
function resolveLessonRef(value, index) {
  if (value === UNLESSON) return { ok: true, key: UNLESSON, sentinel: true }
  if (typeof value !== 'string') {
    return { ok: false, failure: refFailure(REF_REASONS.NOT_STRING, value, `课次引用必须是字符串（实得 ${typeof value}）`) }
  }
  if (value === '') return { ok: false, failure: refFailure(REF_REASONS.EMPTY, value, '课次引用不能是空串') }
  if (value.trim() === '') {
    return { ok: false, failure: refFailure(REF_REASONS.WHITESPACE_ONLY, value, '课次引用不能只有空白') }
  }
  if (value !== value.trim()) {
    return { ok: false, failure: refFailure(REF_REASONS.UNTRIMMED, value, '课次引用前后不能带空白') }
  }

  const byKey = (index && index.byKey) || {}

  // ① 规范形状：命中就返回**原样**的键（不重建，逐字节保持）
  const parsed = identity.parseLessonKey(value)
  if (parsed.ok) {
    if (Object.prototype.hasOwnProperty.call(byKey, value)) return { ok: true, key: value }
    return {
      ok: false,
      failure: refFailure(
        REF_REASONS.UNKNOWN, value,
        `${JSON.stringify(value)} 是规范课次键形状，但课程包里没有这门课（不猜、不造课）`,
        []
      ),
    }
  }

  const { list, byPointName, byNumber } = lessonGroups(index)
  const segs = value.split('/')

  // ② 显示名：显示文字不是身份（哪怕映射表里只有一个同名课次）
  if (segs.length === 1 && DISPLAY_NAME_RE.test(value)) {
    const hits = Object.keys(byKey).filter((k) => byKey[k] && byKey[k].label === value)
    return {
      ok: false,
      failure: refFailure(
        REF_REASONS.DISPLAY_NAME, value,
        `${JSON.stringify(value)} 是**显示名**，不是课程身份：运行态只认 circle/point/NNNN`
          + '（显示名 → 身份的换算已从运行态删除；旧台账由迁移工具处理）',
        hits
      ),
    }
  }

  // ③ 三段但课号不合规：点名差在哪（1–5 位是历史形状；0 / >9999 越界）
  if (segs.length === 3) {
    const numText = segs[2]
    if (/^[0-9]+$/.test(numText)) {
      if (numText.length !== 4) {
        const reason = numText.length < 4 ? REF_REASONS.NARROW_LESSON_NUMBER : REF_REASONS.WIDE_LESSON_NUMBER
        const hits = list.filter((l) => l.circle === segs[0] && l.point === segs[1] && Number(l.number) === Number(numText))
          .map((l) => l.key)
        return {
          ok: false,
          failure: refFailure(reason, value, `课号段必须正好四位十进制（实得 ${JSON.stringify(numText)}）；${reason === REF_REASONS.NARROW_LESSON_NUMBER ? '1–3 位的历史写法' : '5 位及以上的写法'}不是身份`, hits),
        }
      }
      const n = Number(numText)
      if (n < identity.LESSON_NUMBER_MIN || n > identity.LESSON_NUMBER_MAX) {
        return {
          ok: false,
          failure: refFailure(REF_REASONS.OUT_OF_RANGE, value, `课号 ${numText} 越界（只认 ${identity.LESSON_NUMBER_MIN}–${identity.LESSON_NUMBER_MAX}，不截断、不取模、不自动减 fileBase）`),
        }
      }
    }
    return {
      ok: false,
      failure: refFailure(REF_REASONS.MALFORMED, value, `${JSON.stringify(value)} 不是规范课次键：${parsed.failure.error}`),
    }
  }

  // ④ 两段：`point/课号`（缺圆圈）或 `circle/point` 落在课程位 —— 都是运行态拒绝的历史形状
  if (segs.length === 2) {
    const [head, tail] = segs
    if (/^[0-9]+$/.test(tail)) {
      const hits = list.filter((l) => l.point === head && Number(l.number) === Number(tail)).map((l) => l.key)
      if (!hits.length) {
        return {
          ok: false,
          failure: refFailure(REF_REASONS.UNKNOWN, value, `两段课键 ${JSON.stringify(value)} 在课程包里找不到对应课次（历史形状一律不在运行态归一）`, []),
        }
      }
      if (hits.length > 1) {
        return {
          ok: false,
          failure: refFailure(REF_REASONS.AMBIGUOUS, value, `两段课键 ${JSON.stringify(value)} 在 ${hits.length} 个圆圈里都有（${hits.join(' / ')}）—— 归属歧义，不猜`, hits),
        }
      }
      return {
        ok: false,
        failure: refFailure(REF_REASONS.HISTORICAL_LESSON_KEY, value, `${JSON.stringify(value)} 是**两段课键**（point/课号，缺圆圈）—— 运行态只认 circle/point/NNNN；旧台账由迁移工具处理`, hits),
      }
    }
    const hits = list.filter((l) => l.circle === head && l.point === tail).map((l) => l.key)
    if (hits.length > 1) {
      return {
        ok: false,
        failure: refFailure(REF_REASONS.AMBIGUOUS, value, `点键 ${JSON.stringify(value)} 落在课程位，而该知识点有 ${hits.length} 门课程（${hits.join(' / ')}）—— 点键不能扩展成多门已学课程`, hits),
      }
    }
    return {
      ok: false,
      failure: refFailure(
        REF_REASONS.POINT_KEY_IN_LESSON_SLOT, value,
        `${JSON.stringify(value)} 是**两段点键**，却落在课程位：课程身份是 circle/point/NNNN，点键不能顶替课次`,
        hits
      ),
    }
  }

  // ⑤ 单段：裸课号 / 裸知识点 —— 都不是课程身份
  if (segs.length === 1) {
    if (/^[0-9]+$/.test(value)) {
      const hits = (byNumber.get(Number(value)) || []).map((l) => l.key)
      if (hits.length > 1) {
        return {
          ok: false,
          failure: refFailure(REF_REASONS.AMBIGUOUS, value, `裸课号 ${JSON.stringify(value)} 在 ${hits.length} 门课里都有（${hits.join(' / ')}）—— 不猜`, hits),
        }
      }
      if (!hits.length) {
        return { ok: false, failure: refFailure(REF_REASONS.UNKNOWN, value, `裸课号 ${JSON.stringify(value)} 在课程包里没有对应课程`, []) }
      }
      return {
        ok: false,
        failure: refFailure(REF_REASONS.BARE_LESSON_NUMBER, value, `${JSON.stringify(value)} 只有课号 —— 运行态只认 circle/point/NNNN`, hits),
      }
    }
    const circles = [...new Set((byPointName.get(value) || []).map((l) => l.circle))].sort()
    if (circles.length > 1) {
      return {
        ok: false,
        failure: refFailure(REF_REASONS.AMBIGUOUS, value, `裸知识点 ${JSON.stringify(value)} 在 ${circles.length} 个圆圈里都有（${circles.join(' / ')}）—— 必须给完整 circle/point，绝不猜`, circles.map((c) => `${c}/${value}`)),
      }
    }
    if (!circles.length) {
      return { ok: false, failure: refFailure(REF_REASONS.UNKNOWN, value, `裸知识点 ${JSON.stringify(value)} 在课程包里找不到（既不是课次键，也不是已知知识点）`, []) }
    }
    return {
      ok: false,
      failure: refFailure(REF_REASONS.BARE_POINT, value, `${JSON.stringify(value)} 是**裸知识点**（缺圆圈）—— 运行态只认 circle/point/NNNN`, circles.map((c) => `${c}/${value}`)),
    }
  }

  return {
    ok: false,
    failure: refFailure(REF_REASONS.MALFORMED, value, `${JSON.stringify(value)} 的段数（${segs.length}）不可判定为课次引用`),
  }
}

/**
 * 台账 anchor（**身份**）→ 课次显示名。解析不到（含历史形状）→ `null`，由调用方决定算 0 还是报警。
 *
 * 显式桶 `未归课` 是**合法落点**，认它 → 它自己（否则那个桶的笔记读不回）。
 * 显示名**不是**合法输入（那是写入口的旧职责，已从运行态删除）。
 */
function labelOfAnchor(anchor, index) {
  if (anchor === UNLESSON) return UNLESSON
  const r = resolveLessonRef(anchor, index)
  if (!r.ok) return null
  const entry = index && index.byKey ? index.byKey[r.key] : null
  return entry ? entry.label : null
}

/**
 * 调用方写法 → **规范课次键**。只收规范身份（与哨兵 `未归课`）；其余一律 `null`。
 * 写入口据此"当场拒写孤儿/历史锚点"，读点据此"读不回" —— 两种拒绝都只有一个出口：这里。
 */
function keyOfAnchor(anchor, index) {
  if (anchor === UNLESSON) return UNLESSON
  const r = resolveLessonRef(anchor, index)
  return r.ok ? r.key : null
}

/**
 * `progress.json` 的 `learned` → 已学课次集合（**规范身份**）。
 *
 * 逐条判定，**不静默**：
 *   · 规范且有对应课 → 计入；
 *   · 规范但没有课 → `幽灵条目`（既有措辞，保持）；
 *   · 历史形状（裸点 / 两段课键 / 显示名 / 裸课号 …）→ 逐条点名，**不计入已学**（不隐式归一）；
 *   · 歧义 → 列候选，**不计入已学**（点键不能扩展成多门已学课程）。
 *
 * @param {string[]} entries `progress.json` 的 `learned` 原样
 * @param {{byKey: object}} index `lessonIndex(root)` / `readPack(root).lessons` 的等价视图
 * @returns {{lit: string[], problems: string[]}} `lit` 是**去重后**的规范课次键（保持首次出现次序）
 */
function resolveLearned(entries, index) {
  const lit = []
  const problems = []
  const seen = new Set()
  for (const raw of Array.isArray(entries) ? entries : []) {
    const r = resolveLessonRef(raw, index)
    if (r.ok) {
      if (r.sentinel) {
        problems.push(`进度里的 ${JSON.stringify(raw)} 是「未归课」哨兵 —— 它不是一个课次，不计入已学`)
        continue
      }
      if (!seen.has(r.key)) {
        seen.add(r.key)
        lit.push(r.key)
      }
      continue
    }
    const reason = r.failure.reason
    const cands = Array.isArray(r.failure.candidates) ? r.failure.candidates : []
    if (reason === REF_REASONS.UNKNOWN) {
      problems.push(`进度里的 ${JSON.stringify(raw)} 找不到对应课程（幽灵条目）`)
    } else if (reason === REF_REASONS.AMBIGUOUS) {
      problems.push(`进度里的 ${JSON.stringify(raw)} 归属歧义（候选：${cands.join(' / ')}）—— 不猜，不计入已学`)
    } else {
      problems.push(
        `进度里的 ${JSON.stringify(raw)} 不是规范课次键（circle/point/NNNN）：${r.failure.error}`
          + ' —— 旧形状只由迁移工具处理，本条目不计入已学'
      )
    }
  }
  return { lit, problems }
}

module.exports = Object.freeze({
  // 课程映射（唯一实现）
  lessonIndex,
  // 身份解析（运行态只认规范形状）
  resolveLessonRef,
  resolveLearned,
  labelOfAnchor,
  keyOfAnchor,
  // 显示换算与页面锚点（各按自己的领域工作）
  lessonLabel,
  displayNumberOf,
  labelAnchorId,
  // 目录读取
  pointMeta,
  readPracticeRoots,
  // 常量
  UNLESSON,
  LEGACY_HALO,
  LEGACY_POINT,
  REF_REASONS,
})
