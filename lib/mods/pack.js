/**
 * lib/mods/pack.js — 选课程包：弹原生文件夹选择框 → 空目录就地建好课程包 → 设为 packRoot
 * ------------------------------------------------------------------
 * 挂一条 POST 路由：
 *
 *     POST /api/whale/pack/choose
 *        body: { dir?: string, dryRun?: boolean }
 *        · 不给 dir → 由**宿主**弹操作系统的原生文件夹选择框（浏览器拿不到绝对路径，见 lib/pick-folder.js）
 *        · 给 dir   → 直接用这个目录（脚本化 / 测试 / 手填路径时用）
 *
 * 三种结果（这是这个功能的核心语义，别改）：
 *   ① 目录已经是课程包（有 presets/whale-sensei.css 或 lessons/）→ **直接用它**，不建包、不动它一个字节
 *   ② 目录是**空的** → 把 lib/pack-template/ 的引擎件铺进去 + 生成空台账 → 用它
 *   ③ 其它（非空、又不是课程包）→ **拒绝**，并把"为什么"说清楚（不合并、不覆盖）
 *
 * 另挂一条（2026-09-25 · 场景 A：侧栏那一行叫**「课程中心」**，点它 = **进入课程包**）：
 *
 *     POST /api/whale/pack/open
 *        body: 不用（不读）
 *        → 确保**课程包自己的**预览服务在跑（**先探活**；没起就**在宿主进程内**起），
 *          回 `{ ok, url: 'http://127.0.0.1:3091/starmap/', port, started }`
 *        为什么走这条路（而不是插件自己托管课程包）见 `lib/pack-server.js` 的文件头。
 *
 * 再挂一条（2026-09-26 · 离线包：设置页「课程目录」里**每节课后面**那个「导出」按钮）：
 *
 *     POST /api/whale/pack/export
 *        body: { file: '<圈>/<点>/<课>.html', outDir?: string }
 *        · 不给 outDir → 由**宿主**弹操作系统的原生文件夹选择框
 *        → 产出 `鲸师课件-<课程名>.zip`（几十 KB：这一课的渲染产物 + 圈/点结构 + 单课清单）
 *        包里**不带** assets/starmap/字体 —— 那些由离线阅读器的「包骨架」提供（见 lib/pack-export.js）
 *
 * 生效方式两条腿：
 *   · **本次会话**：直接改 `hctx.paths.packRoot`（各路由/工具都是按请求读它）
 *   · **重启之后**：写进 profile 层 cordis.patch.yml（`lib/profile-packroot.js`）
 *     写配置失败**不算整件事失败** —— 返回里带 configError，界面照实显示"本次已生效，重启后要手工写"
 *     （本项目禁止静默降级：降级可以，但必须说出来）
 *
 * 跨站栅栏与浏览器认证由基座继承（路径挂在 /api 下），本模块不写 CORS。
 */

import path from 'node:path'
import { looksLikePack, planScaffold, writeScaffold } from '../pack-scaffold.js'
import { pickFolder, pickerSupported } from '../pick-folder.js'
import { writeProfilePackRoot } from '../profile-packroot.js'
import { ensurePackServer } from '../pack-server.js'
import { exportLesson } from '../pack-export.js'
import { ensurePresetForPack } from '../preset-install.js'

const CHOOSE_ROUTE = '/api/whale/pack/choose'
const OPEN_ROUTE = '/api/whale/pack/open'
const EXPORT_ROUTE = '/api/whale/pack/export'

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
})

/** 同一时刻只允许一个原生对话框（点了两次不该弹两个框） */
let picking = false

/**
 * 选目录 → 判定 → （必要时）建包 → 设为 packRoot。抽成函数，路由与测试共用。
 * @param {{dir?: string, dryRun?: boolean, fake?: string, dshHome?: string, env?: object}} body
 * @param {object} hctx
 */
export async function choosePack(body, hctx) {
  const b = body || {}
  const log = hctx?.log ?? {}

  let dir = b.dir ? String(b.dir).trim() : ''
  let dialog = null

  if (!dir) {
    if (!pickerSupported()) {
      return {
        ok: false,
        error: `当前平台（${process.platform}）还没有原生目录选择器 —— 请在请求里带 dir，或手工把 packRoot 写进配置`,
      }
    }
    if (picking) return { ok: false, error: '已经有一个选择框开着 —— 先在那边选完或关掉它' }
    picking = true
    try {
      const picked = pickFolder({ fake: b.fake })
      dialog = picked.dialog ?? null
      if (!picked.ok) return { ok: false, canceled: !!picked.canceled, error: picked.error }
      dir = picked.path
    } finally {
      picking = false
    }
  }

  const abs = path.resolve(dir)
  log.info?.(`选课程包：${abs}`)

  let mode = 'reused'
  let created = []
  let bytes = 0

  if (looksLikePack(abs)) {
    mode = 'reused'
  } else {
    const plan = planScaffold(abs)
    if (!plan.ok) return { ok: false, dir: abs, error: plan.error }
    if (b.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        mode: 'would-create',
        dir: abs,
        plan: { copies: plan.plan.copies.map((c) => c.path), writes: plan.plan.writes.map((w) => w.path), dirs: plan.plan.dirs },
      }
    }
    const built = writeScaffold(abs)
    if (!built.ok) {
      return { ok: false, dir: abs, created: built.created ?? [], error: built.error }
    }
    mode = 'created'
    created = built.created
    bytes = built.bytes
    log.info?.(`课程包已建好：${abs}（${created.length} 个文件 / ${bytes} 字节）`)
  }

  // —— 生效 ①：本次会话 ——
  if (hctx?.paths) hctx.paths.packRoot = abs

  // —— 生效 ③：**预设的技能目录跟着新课程包走**（2026-09-27）——
  // 预设是启动期装的，那时 packRoot 可能还没配 ⇒ `customSkillDirs` 是空的；
  // 选完/建完包不刷新的话，新用户第一次开会话看到的「鲸师模式」**0 个技能**
  // （老师拿不到 whale-system 的调度表与那四条纪律，等于只挂了个人设）。
  // 与 ①② 同一条纪律：本次会话立刻生效，重启后由启动期那次兜住。
  let preset = null
  try {
    if (hctx?.paths?.presetDir) {
      const r = ensurePresetForPack({
        dshHome: hctx.paths.dshHome,
        presetDir: hctx.paths.presetDir,
        packRoot: abs,
        log: (level, msg) => hctx?.log?.[level === 'warn' ? 'warn' : 'info']?.(msg),
      })
      preset = { action: r.action, dir: r.dir, skillsDir: r.skillsDir ?? null }
      if (r.action === 'created' || r.action === 'refreshed') {
        log.info?.(`「鲸师模式」预设已指向 ${r.skillsDir ?? '（这个课程包还没有 skills/）'}`)
      } else if (r.action === 'no-template' || r.action === 'failed') {
        log.warn?.(`「鲸师模式」预设没刷新成：${r.reason ?? r.action}`)
      }
    }
  } catch (e) {
    preset = { error: e?.message ?? e }
    log.warn?.(`刷新「鲸师模式」预设时异常：${e?.message ?? e}`)
  }

  // —— 生效 ②：重启之后（失败不掩盖，照实回报）——
  let config = null
  let configError = null
  try {
    const w = writeProfilePackRoot(abs, { dshHome: b.dshHome, env: b.env })
    if (w.ok) config = { file: w.file, changed: w.changed, note: w.note, backup: w.backup }
    else configError = w.error
  } catch (e) {
    configError = `写 profile 配置时异常：${e?.message ?? e}`
  }

  return {
    ok: true,
    mode,
    dir: abs,
    packRoot: abs,
    created,
    bytes,
    dialog,
    config,
    configError,
    preset,
    note: mode === 'created'
      ? `已在这个空目录里建好课程包（${created.length} 个文件）。下一步：让 agent 用 whale_intake 摸底 → whale_author 写第一节课。`
      : '这个目录已经是课程包，直接用它（一个字节都没动）。',
    restartHint: config ? '已写入 profile 配置，重启宿主后依然生效。' : '本次会话已生效；重启宿主后需要在 profile 配置里手工写上这个路径。',
  }
}

export const plugin = {
  id: 'pack',
  version: '0.1.0',
  tools: [], // 只提供一条写入口路由，不动工具面

  install(hctx) {
    const route = {
      path: CHOOSE_ROUTE,
      methods: ['POST'],
      // ⚠️ 必须显式写（见 lib/mods/status.js 的注释）：省略会被基座当 streaming，
      //    于是给 POST 装 body 的方式不对 ⇒ 400 空体 ⇒ 浏览器报 JSON 解析失败。
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
        let body
        try { body = await request.json() } catch { return json(400, { ok: false, error: 'body 不是合法 JSON' }) }
        try {
          const out = await choosePack(body, hctx)
          return json(out.ok ? 200 : 200, out)
        } catch (e) {
          hctx.log?.error?.(`选课程包失败：${e?.message ?? e}`)
          return json(200, { ok: false, error: `选课程包失败：${e?.message ?? e}` })
        }
      },
    }

    /**
     * 「进入课程包」：确保课程包自己的预览服务在跑，把星图地址回给界面。
     * **不读 body**（客户端只发一个空 `{}`）—— 少一个失败面；服务起不来的原因一律走 `error` 如实回。
     */
    const openRoute = {
      path: OPEN_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
        try {
          const out = await ensurePackServer(hctx.paths?.packRoot, { scope: hctx.scope })
          if (!out.ok) hctx.log?.warn?.(`进入课程包失败：${out.error}`)
          else hctx.log?.info?.(`进入课程包：${out.url}（${out.started ? '这次起的服务' : '复用了已在跑的服务'}）`)
          return json(200, out)
        } catch (e) {
          hctx.log?.error?.(`进入课程包失败：${e?.message ?? e}`)
          return json(200, { ok: false, error: `进入课程包失败：${e?.message ?? e}` })
        }
      },
    }

    /**
     * 「导出这一节课」：打一个小 zip 给离线阅读器导入（场景 B 的**导出侧**）。
     * 不弹框当 body 带 `outDir`（脚本化 / 测试）；否则弹宿主原生选择框。
     */
    const exportRoute = {
      path: EXPORT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return json(405, { ok: false, error: '只接受 POST' })
        let body
        try { body = await request.json() } catch { return json(400, { ok: false, error: 'body 不是合法 JSON' }) }
        try {
          const out = await exportLesson(body, hctx)
          if (!out.ok && !out.canceled) hctx.log?.warn?.(`导出课件包失败：${out.error}`)
          else if (out.ok) hctx.log?.info?.(out.note)
          return json(200, out)
        } catch (e) {
          hctx.log?.error?.(`导出课件包失败：${e?.message ?? e}`)
          return json(200, { ok: false, error: `导出课件包失败：${e?.message ?? e}` })
        }
      },
    }

    const routes = [route, openRoute, exportRoute]

    if (typeof hctx.inject === 'function') {
      hctx.inject(['connection'], (c, child) => {
        const conn = c.get('connection')
        if (!conn?.fetch?.register) {
          hctx.log?.warn?.(`connection 服务没有 fetch.register —— ${routes.map((r) => r.path).join('、')} 没挂上`)
          return
        }
        for (const r of routes) {
          try {
            const off = conn.fetch.register(r)
            if (typeof off === 'function') child?.add(off)
            const why = r.path === CHOOSE_ROUTE ? '（设置页「鲸师」里那个按钮靠它）'
              : r.path === OPEN_ROUTE ? '（侧栏「进入课程包」靠它）'
                : '（设置页「课程目录」每节课后面的「导出」靠它）'
            hctx.log?.info?.(`路由已挂 ${r.path}${why}`)
          } catch (e) {
            hctx.log?.error?.(`挂 ${r.path} 失败：${e?.message ?? e}`)
          }
        }
      })
    } else {
      hctx.log?.warn?.('宿主没有注入能力：课程包两条路由未注册')
    }
  },
}
