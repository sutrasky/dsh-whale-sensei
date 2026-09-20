/**
 * lib/visual.js — 视觉检查的**纯函数层**：读 PNG 尺寸、判定"这张图算不算数"、查 DOM 标记
 * ------------------------------------------------------------------
 * 为什么要它：`a11y-print.test.mjs` 里明说"本机没有浏览器工具可用"，所以"星图/课程页在
 * 真实浏览器里渲染出来了吗"这件事一直是**人眼**在管。这里把可机器判的那部分钉住：
 *   · 截出来的图**真的是我们要求的那个尺寸**吗（不是 0 字节、不是旧图、不是别的尺寸）
 *   · 图里的 DOM **真的出现了关键标记**吗（星图有 canvas 或静态 SVG；课程页有答疑挂载点）
 * 「好看不好看」仍然是人眼的事 —— 这里只判"有没有渲染出来 / 是不是我要的那张"。
 *
 * 纯：不读盘、不起进程、不看时钟。
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 是不是 PNG（按签名判，不看扩展名） */
export function isPng(buf) {
  if (!buf || buf.length < 24) return false
  return PNG_SIG.every((b, i) => buf[i] === b)
}

/**
 * 从 PNG 头里读宽高（IHDR 是第一个 chunk：8 字节签名 + 4 长度 + 4 类型 + 宽4 + 高4）
 * @returns {{width:number,height:number}|null}
 */
export function pngSize(buf) {
  if (!isPng(buf)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 判定一张截图算不算数。
 * @param {{buf:Buffer, w:number, h:number, minBytes?:number}} p
 * @returns {{ok:boolean, why:string, bytes:number, dims:{width:number,height:number}|null}}
 */
export function checkShot({ buf, w, h, minBytes = 2048 }) {
  const bytes = buf?.length ?? 0
  if (!buf || bytes === 0) return { ok: false, why: '没有截到任何字节', bytes, dims: null }
  const dims = pngSize(buf)
  if (!dims) return { ok: false, why: `不是合法 PNG（头 ${buf.toString('hex', 0, 8)}）`, bytes, dims: null }
  if (dims.width !== w || dims.height !== h) {
    return { ok: false, why: `尺寸不对：要 ${w}×${h}，实得 ${dims.width}×${dims.height}`, bytes, dims }
  }
  if (bytes < minBytes) {
    return { ok: false, why: `图太小（${bytes} 字节 < ${minBytes}）—— 多半是白屏/没渲染出来`, bytes, dims }
  }
  return { ok: true, why: `${dims.width}×${dims.height} · ${bytes} 字节`, bytes, dims }
}

/**
 * 判定一张**整页**截图算不算数（2026-09-24 B2 新增）。
 *
 * 与 `checkShot` 的区别：整页的高度**本来就不该等于视口高度** —— 那正是换掉
 * `--screenshot` 的理由（它只截首屏，长课程页等于没看）。所以这里判的是：
 *   宽 = 请求宽（没被内容撑歪）、高 **> 视口高**（真的比首屏长）、字节数不像白屏。
 *
 * @param {{buf:Buffer, w:number, viewportH:number, minBytes?:number}} p
 * @returns {{ok:boolean, why:string, bytes:number, dims:{width:number,height:number}|null}}
 */
export function checkFullShot({ buf, w, viewportH, minBytes = 2048 }) {
  const bytes = buf?.length ?? 0
  if (!buf || bytes === 0) return { ok: false, why: '没有截到任何字节', bytes, dims: null }
  const dims = pngSize(buf)
  if (!dims) return { ok: false, why: `不是合法 PNG（头 ${buf.toString('hex', 0, 8)}）`, bytes, dims: null }
  if (dims.width !== w) return { ok: false, why: `整页宽度不对：要 ${w}，实得 ${dims.width}`, bytes, dims }
  if (dims.height <= viewportH) {
    return { ok: false, why: `整页高 ${dims.height} 没超过视口高 ${viewportH} —— 看着还是首屏（--screenshot 的老毛病）`, bytes, dims }
  }
  if (bytes < minBytes) {
    return { ok: false, why: `图太小（${bytes} 字节 < ${minBytes}）—— 多半是白屏/没渲染出来`, bytes, dims }
  }
  return { ok: true, why: `整页 ${dims.width}×${dims.height}（> 视口高 ${viewportH}）· ${bytes} 字节`, bytes, dims }
}

/** 各类页面"渲染出来了"的最小证据（宁可少而准，不要多而虚） */
export const MARKERS = {
  // 星图：WebGL 路子有 <canvas>，无 WebGL / 静态降级路子有 #staticmap 里内联的 SVG
  starmap: [
    { id: 'canvas', re: /<canvas\b/i, hint: 'WebGL 画布' },
    { id: 'static', re: /id="staticmap"|<svg\b/i, hint: '静态版 SVG' },
  ],
  // 课程页：答疑组件会读 <body data-ask-page>，页面壳里有 nav；标题必须非空
  lesson: [
    { id: 'ask-page', re: /data-ask-page\s*=/i, hint: '答疑挂载点（页面自报身份）' },
    { id: 'title', re: /<title>[^<]{2,}<\/title>/i, hint: '非空标题' },
  ],
  // 笔记文档页（reference/NOTES.html）：页面自报身份 + 非空标题 + **笔记表单**。
  // 表单是这一页的核心交互（没有它这页就只剩只读文档）—— 所以三条都要在，不是"有其一即可"。
  notes: [
    { id: 'notes-page', re: /data-notes-page\s*=/i, hint: '笔记页挂载点（页面自报身份）' },
    { id: 'title', re: /<title>[^<]{2,}<\/title>/i, hint: '非空标题' },
    { id: 'note-form', re: /data-note-form/i, hint: '笔记表单' },
  ],
}

/**
 * 在 DOM 里找标记。`any: true` 的组表示"这些里只要有一个"（星图两条路只需其一）。
 * @param {string} html --dump-dom 的输出
 * @param {'starmap'|'lesson'} kind
 */
export function checkDom(html, kind) {
  const groups = MARKERS[kind]
  if (!groups) return { ok: false, why: `不认识的 kind：${kind}`, hits: [], missing: [] }
  const text = String(html || '')
  const hits = []
  const missing = []
  for (const g of groups) {
    if (g.re.test(text)) hits.push(g.id)
    else missing.push(`${g.id}（${g.hint}）`)
  }
  // 星图两条路任一即可；课程页要求全中
  const ok = kind === 'starmap' ? hits.length > 0 : missing.length === 0
  return { ok, why: ok ? `命中 ${hits.join('、')}` : `缺 ${missing.join('、')}`, hits, missing }
}
