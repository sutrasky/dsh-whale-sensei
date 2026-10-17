/**
 * lib/pack-export.js — 导出**一节课**的离线课件包（zip）
 * ------------------------------------------------------------------
 * 场景 B（离线阅读器）的**导出侧**：老师在设置页「课程目录」里点某节课后面的「导出」，
 * 这里把这一节课打成一个小 zip（几十 KB），发给没有 DSH、没有 Node 的人导入。
 *
 * **包里装什么**（不带 `assets/`、`starmap/`、字体、three —— 那些由离线阅读器的「包骨架」提供）：
 *
 *     pack.json                       包标识（id = `<圈>/<点>`）+ 这一课的号/标题
 *     lessons/<圈>/halo.json          圆圈结构（groups / edges）
 *     lessons/<圈>/<点>/point.json    知识点结构（课次表 plan.nodes / requires / 地图）
 *     lessons/<圈>/<点>/<课>.html     这一节课的**渲染产物**
 *     lessons/lessons.json            **课程星清单**（只含这一课）—— 离线端无 src 时重建星图靠它
 *
 * **为什么清单只带这一课**：离线端导入时把它**合并**进自己的 `lessons/lessons.json`（幂等），
 * 于是多节课分几次发也能累积成一张完整星图；同一课重发 = 覆盖同一条，不会长出两颗星。
 *
 * **清单条目从哪来**：跑**包内**脚本 `node tools/build-lessons-index.js --print`，再按 `rel` 筛出这一课
 * —— 与包内 `build-starmap.js` 的清单模式**同源**，插件里不抄第二份 meta 解析。
 *
 * **导出是纯读**：只读课程包，一个字节都不改（判据 `test/export-pack.mjs` 会核这一点）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runSync, spawnFailureHint } from './exec.js'
import { pickFolder } from './pick-folder.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireCJS = createRequire(import.meta.url)

/**
 * 导出真正要哪些**包内**引擎件 —— **单一名单**在 `lib/pack-template/tools/engine-files.cjs`
 * （与建包侧同源，T18 / 报告 D06）。这里**不再自己写脚本名**：
 * 同一事实写两份，就会一边加、一边漏（D06 就是那么来的：模板里有那件、随包清单里没有，
 * 于是新包建出来永远导不出去）。
 */
const { engineFiles } = requireCJS(path.join(HERE, 'pack-template', 'tools', 'engine-files.cjs'))
const EXPORT_SCRIPTS = engineFiles({ profile: 'export' })
/** 课程星清单生成器：导出侧唯一 shell-out 的那一件（从闭包里按名字取，取不到就是插件装坏了） */
const INDEX_SCRIPT = EXPORT_SCRIPTS.find((rel) => /(^|\/)build-lessons-index\.js$/.test(rel)) || null

/** bsdtar（Windows 10+ 自带）——`-a` 按扩展名自动选格式，`-C` 定打包根 */
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

/**
 * 文件名净化：Windows 非法字符换成空格、压空白、去首尾点、截断。
 * 课程名是给人看的（用户 2026-09-26 定：zip 名字用课程名字，不带版本号），
 * 唯一性由 `pack.json` 里的层级 id 保证 —— 所以这里**只管安全**，不管唯一。
 * @param {string} raw
 * @param {string} fallback
 */
export function safeName(raw, fallback = '课程') {
  const s = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
  const cut = s.length > 60 ? s.slice(0, 60).trim() : s
  return cut || fallback
}

/** 跑包内清单生成器，拿全量清单（不写盘） */
function readIndexEntries(packRoot, script) {
  const r = runSync(process.execPath, [script, '--print'], { cwd: packRoot, encoding: 'utf8' })
  if (r.status !== 0) {
    const why = `${r.stderr || r.stdout || ''}`.trim() || spawnFailureHint(r) || '（没有输出）'
    return { ok: false, error: `生成课程星清单失败：${why}` }
  }
  try {
    return { ok: true, index: JSON.parse(`${r.stdout}`) }
  } catch (e) {
    return { ok: false, error: `课程星清单不是合法 JSON：${e?.message ?? e}` }
  }
}

/** 读一个知识点的 `point.json`（读不到就 null —— 调用方按"这个前置不在作者包里"处理） */
function readPoint(packRoot, halo, point) {
  const p = path.join(packRoot, 'lessons', halo, point, 'point.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * 收集这一课**前置链**上的所有知识点（递归、去重、防环）。
 *
 * **为什么必须带**：老师一次只发一节课时，前置知识点不在收件人的库里 ⇒
 * `build-starmap.js` 的悬空前置硬校验会拒绝整次重建（2026-09-26 主人真机实测踩到：
 * `programming/vue` 的前置是 `spring-boot`，库里没有它 ⇒ 导入成功但「重建未成功」）。
 *
 * 带上的是**结构**（`point.json` ＋ 所在圈的 `halo.json`），**不是前置的课** ——
 * 没发给学生的内容一页都不会漏出去，但星图上那条"前置航道"是完整的、知识点是立着的。
 * 前置自己的 `requires` 也递归跟上（链有多长就跟多长）。
 *
 * @returns {Map<string, {halo: string, point: string}>} 键 = `halo/point`
 */
export function collectPrereqs(packRoot, circle, point) {
  const out = new Map()
  const seen = new Set([`${circle}/${point}`])
  const queue = [{ halo: circle, point }]
  while (queue.length) {
    const cur = queue.shift()
    const doc = readPoint(packRoot, cur.halo, cur.point)
    if (!doc) continue
    for (const ref of doc.requires || []) {
      // 与 build-starmap.js 同一条解析规则：带 `/` 的是全名，否则按同圈补
      const target = String(ref).includes('/') ? String(ref) : `${cur.halo}/${ref}`
      const [h, p] = target.split('/')
      if (!h || !p || seen.has(target)) continue
      seen.add(target)
      if (!readPoint(packRoot, h, p)) continue      // 前置在作者包里就不存在 ⇒ 跳过（离线端会如实告警）
      out.set(target, { halo: h, point: p })
      queue.push({ halo: h, point: p })
    }
  }
  return out
}

/**
 * 导出这一节课。
 * @param {{file?: string, outDir?: string, fake?: string}} body
 *   · `file`：课在**源侧**的相对路径（形如 `programming/vue/1001-vue-render-http-data.html`）
 *   · `outDir`：不弹框，直接写到这里（脚本化 / 测试用）
 * @param {object} hctx
 */
export async function exportLesson(body, hctx) {
  const b = body || {}
  const log = hctx?.log ?? {}

  const packRoot = hctx?.paths?.packRoot
  if (!packRoot) return { ok: false, error: '还没有配置课程包（packRoot）—— 先在设置里选一个课程包' }
  const abs = path.resolve(String(packRoot))

  const file = String(b.file || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!file) return { ok: false, error: '要导出哪一节课？请给 file（形如 programming/vue/1001-xxx.html）' }
  if (file.includes('..') || path.isAbsolute(file)) {
    return { ok: false, error: `file 必须是课程包内的相对路径：${file}` }
  }
  const parts = file.split('/')
  if (parts.length < 3) {
    return { ok: false, error: `课路径要形如 <圆圈>/<知识点>/<课>.html：${file}` }
  }
  const [circle, point] = parts

  const built = path.join(abs, 'lessons', file)
  if (!fs.existsSync(built)) {
    return { ok: false, error: `找不到这一节课的渲染产物：lessons/${file} —— 先在插件里重建一次课程页` }
  }

  // —— 导出闭包必须件件在包里（T18 / 报告 D06）——
  // 缺件时**说清缺哪一件**，别把它变成一句 `Cannot find module`（旧行为：新包建出来就永远导不出去，
  // 而报错指向 node 的模块解析，看不出"是这个包建自缺件的模板"）。
  if (!INDEX_SCRIPT) {
    return { ok: false, error: '插件的导出闭包坏了（lib/pack-template/tools/engine-files.cjs 的 export 档里没有课程星清单生成器）—— 请重装插件' }
  }
  const missingClosure = EXPORT_SCRIPTS.filter((rel) => !fs.existsSync(path.join(abs, ...rel.split('/'))))
  if (missingClosure.length) {
    return {
      ok: false,
      error: `这个课程包缺少导出必需的引擎件：${missingClosure.join('、')} —— 用插件重建或升级这个课程包（它建自缺件的旧模板）`,
    }
  }

  // —— 清单条目（与包内 build-starmap.js 的清单模式同源）——
  const got = readIndexEntries(abs, INDEX_SCRIPT)
  if (!got.ok) return { ok: false, error: got.error }
  const entry = (got.index?.lessons || []).find((l) => l && l.rel === file)
  if (!entry) {
    return {
      ok: false,
      error: `课程星清单里没有这一课（${file}）—— 源文件 lessons/src/${file} 还在吗？（导出要有源才能摘元数据）`,
    }
  }

  // —— 落点：给了 outDir 就不弹框（脚本化 / 测试），否则弹原生选择框 ——
  let outDir = b.outDir ? path.resolve(String(b.outDir)) : ''
  let dialog = null
  if (!outDir) {
    const picked = pickFolder({ title: '导出到哪个文件夹', fake: b.fake })
    dialog = picked.dialog ?? null
    if (!picked.ok) return { ok: false, canceled: !!picked.canceled, error: picked.error }
    outDir = picked.path
  }
  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `建不了导出目录：${outDir}（${e?.message ?? e}）` }
  }

  // —— 造 staging（临时目录），再打包 ——
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-export-'))
  try {
    const put = (rel, content) => {
      const p = path.join(tmp, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    }
    const copyFromPack = (rel) => {
      const from = path.join(abs, rel)
      if (!fs.existsSync(from)) return false
      const to = path.join(tmp, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      return true
    }

    // 前置链的**结构**（`point.json` ＋ 所在圈 `halo.json`）—— 不带它，收件人那边星图上的
    // 「前置航道」会缺一条，而且 `build-starmap` 的悬空前置校验会让整次重建失败
    const prereqs = collectPrereqs(abs, circle, point)

    const carried = []
    const packJson = {
      v: 1,
      id: `${circle}/${point}`,
      name: entry.pointName || point,
      circle,
      point,
      lesson: { number: entry.number, slug: entry.slug, title: entry.title || '' },
      // 带上的是**结构**不是课：没发给学生的内容一页都不会漏出去
      prereqs: [...prereqs.keys()],
    }
    put('pack.json', `${JSON.stringify(packJson, null, 2)}\n`)
    carried.push('pack.json')

    if (copyFromPack(`lessons/${circle}/halo.json`)) carried.push(`lessons/${circle}/halo.json`)
    if (copyFromPack(`lessons/${circle}/${point}/point.json`)) carried.push(`lessons/${circle}/${point}/point.json`)
    for (const dep of prereqs.values()) {
      if (copyFromPack(`lessons/${dep.halo}/halo.json`)) carried.push(`lessons/${dep.halo}/halo.json`)
      if (copyFromPack(`lessons/${dep.halo}/${dep.point}/point.json`)) carried.push(`lessons/${dep.halo}/${dep.point}/point.json`)
    }
    copyFromPack(`lessons/${file}`)
    carried.push(`lessons/${file}`)

    put('lessons/lessons.json', `${JSON.stringify({ v: 1, source: 'lessons/src', lessons: [entry] }, null, 2)}\n`)
    carried.push('lessons/lessons.json')

    // —— 文件名：`鲸师课件-<课程名>.zip`；同名时**加课号**（不覆盖、不静默）——
    const base = safeName(entry.title || entry.navTitle, `第${entry.number}课`)
    let zip = path.join(outDir, `鲸师课件-${base}.zip`)
    if (fs.existsSync(zip)) {
      const alt = path.join(outDir, `鲸师课件-${base}-${String(entry.number).padStart(4, '0')}.zip`)
      if (fs.existsSync(alt)) {
        return {
          ok: false,
          error: `导出目录里已经有「${path.basename(alt)}」了 —— 换个目录，或先把旧的那份移走`,
        }
      }
      zip = alt
    }

    const r = runSync(TAR, ['-a', '-c', '-f', zip, '-C', tmp, '.'], { encoding: 'utf8' })
    if (r.status !== 0 || !fs.existsSync(zip)) {
      const why = `${r.stderr || r.stdout || ''}`.trim() || spawnFailureHint(r) || '（没有输出）'
      return { ok: false, error: `打包失败：${why}` }
    }

    const bytes = fs.statSync(zip).size
    log.info?.(`导出课件包：${zip}（${bytes} 字节 / ${carried.length} 个文件）`)
    const files = [...new Set(carried)]
    return {
      ok: true,
      zip,
      name: path.basename(zip),
      bytes,
      files,
      circle,
      point,
      prereqs: [...prereqs.keys()],
      number: entry.number,
      title: entry.title || '',
      dialog,
      note: `已导出「${entry.title || file}」：${path.basename(zip)}（${Math.round(bytes / 1024)} KB）`
        + (prereqs.size ? `，含前置结构 ${prereqs.size} 个` : ''),
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
