/**
 * lib/visual-io.js — 视觉检查的 IO 薄壳：找浏览器、截图、取 DOM
 * ------------------------------------------------------------------
 * 依据（侦察报告 `_plugin-prep/visual-侦察.md` + 本机实测）：
 *   · 本机**没有**现成的 CDP 客户端/截图脚本（`a11y-print.test.mjs` 明说"没有浏览器工具可用"）
 *   · Edge / Chrome 都在
 *   · Chromium 单实例语义：**必须给独立的 `--user-data-dir`**，否则参数会被已有实例吞掉
 *   · 星图没有"渲染完成"事件（裸 rAF）⇒ 等一会儿再截
 *
 * ⚠️ 2026-09-24（队列④ B2）：截图机制**换掉了**
 *   旧法子是 `--headless=new --screenshot`，它**只截首屏** —— 长课程页等于没看。
 *   现在走 `lib/cdp.js` 的 `capturePng`（真 CDP）：`fullPage` 拿整页、`clip` 拿局部，
 *   视口由 `Emulation.setDeviceMetricsOverride` 定（不再用 `--window-size` 喂）。
 *   `dumpDom` 仍走 `--dump-dom`（取 DOM 不需要 CDP，别为了统一而绕远）。
 *
 * 判定逻辑在 `lib/visual.js`（纯）。这里只管起进程与拿字节。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** 常见安装位置（按顺序取第一个存在的） */
export const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** 找一个能用的浏览器；找不到返回 null（**不猜**、不改 PATH） */
export function findBrowser(candidates = BROWSER_CANDIDATES) {
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/** 每次跑用一个独立 profile 目录（Chromium 单实例语义：共用 profile 会把参数吞掉） */
export function makeProfileDir(tag = 'whale-visual') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
}

/**
 * 截一张图（走 CDP，见文件头说明）。
 *
 * @param {{exe:string, url:string, w:number, h:number, outPng:string, profileDir?:string,
 *          budgetMs?:number, fullPage?:boolean,
 *          clip?:{x:number,y:number,width:number,height:number}}} o
 * @returns {Promise<{code:number, stderr:string, size:{width:number,height:number}|null,
 *                    contentSize:{width:number,height:number}|null}>}
 *          `code` 沿用旧契约：0 = 截到了，-1 = 没截到（原因在 stderr，别丢它）
 */
export async function shoot({ exe, url, w, h, outPng, profileDir, budgetMs = 5000, fullPage = false, clip = null }) {
  const { capturePng } = await import('./cdp.js') // 动态导入：不截图就不必加载 CDP 客户端
  try {
    const r = await capturePng({
      exe, url, width: w, height: h, budgetMs,
      fullPage: fullPage === true,
      clip: clip || undefined,
      profileDir,
      outPng,
    })
    return { code: 0, stderr: '', size: r.size, contentSize: r.contentSize }
  } catch (e) {
    // 不吞：截图失败的真原因（连不上 CDP、尺寸与 clip 对不上…）必须能带出去
    return { code: -1, stderr: e?.message ?? String(e), size: null, contentSize: null }
  }
}

/**
 * 取渲染后的 DOM（`--dump-dom`）—— 这是**结构化证据**，比"看一眼截图"硬得多。
 * @returns {{code:number, html:string, stderr:string}}
 */
export function dumpDom({ exe, url, profileDir, budgetMs = 5000 }) {
  const args = [
    '--headless=new',
    '--use-gl=swiftshader',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,820',
    `--virtual-time-budget=${budgetMs}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--dump-dom',
    url,
  ]
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status === null ? -1 : r.status, html: r.stdout || '', stderr: `${r.stderr || ''}`.trim() }
}

/** 探一下服务在不在（只读 GET，不写任何东西） */
export async function probeBase(base, pathname = '/', timeoutMs = 4000) {
  const url = new URL(pathname, base).toString()
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const res = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    return { ok: true, status: res.status, url }
  } catch (e) {
    return { ok: false, status: 0, url, why: e?.message ?? String(e) }
  }
}
