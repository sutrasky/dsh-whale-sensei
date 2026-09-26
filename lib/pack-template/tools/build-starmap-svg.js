#!/usr/bin/env node
/**
 * build-starmap-svg.js — 构建期生成「静态版星图」（内联 SVG）
 * ------------------------------------------------------------------
 * 用法：node tools/build-starmap-svg.js          写 starmap/static.svg + 内联进 index.html
 *       node tools/build-starmap-svg.js --check  只比对，不写（漂移即非 0 退出）
 *       node tools/build-starmap-svg.js --root=<目录>   换根目录（**可选**，默认仍是课程包根）
 *         —— 公开站构建器 `tools/build-public.js` 用它把「中性化后的星图」生成进 dist/：
 *            先中性化 dist/starmap/content.js，再拿这个开关重跑本脚本。
 *            不给这个参数时行为与本开关存在之前**逐字节相同**。
 *
 * **为什么是构建期而不是运行期**：要求是"**无 JS 时星图仍能看、能点**" ——
 * 那只能把 SVG 直接写进 HTML；等运行期 fetch 的话，JS 一关就什么都没有了。
 * 课程星包在 `<a href>` 里 → **无 JS 也能点进课程**（这是"点"的落点）。
 *
 * **坐标来自 `starmap/data-layer.js` 的 `layout()`** —— 与 WebGL 版同一份坐标，
 * 这正是 M3 前置重构（把布局搬进数据层）的目的。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 根目录：默认课程包根（与本开关存在之前逐字节同行为）；--root=<目录> 才换根
const ROOT_ARG = (process.argv.find((a) => a.startsWith('--root=')) || '').slice('--root='.length);
const ROOT = ROOT_ARG ? path.resolve(ROOT_ARG) : path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'starmap', 'content.js');
const PAGE = path.join(ROOT, 'starmap', 'index.html');
const OUT_SVG = path.join(ROOT, 'starmap', 'static.svg');
const MARK_A = '<!--@static-map-->';
const MARK_B = '<!--/@static-map-->';
const CHECK = process.argv.includes('--check');

// 与页面 :root 的令牌同值（构建期读不到 CSS，只能同值；改令牌时这里要一起改）
const C = {
  void: '#05070e', label: '#dbe4f5', dim: '#7c8aa5', link: '#ffe066',
  red: '#ff3b4e', yellow: '#ffd633',
};
// 与 WebGL 版默认相机一致（theta/phi/fov）—— 只是投影成 2D，仍然确定性
const CAM = { theta: 0.7, phi: 0.92 };

function loadContent() {
  const window = {};
  new Function('window', fs.readFileSync(SRC, 'utf8'))(window);
  return window.STARMAP_REAL;
}

/** 与 WebGL 版同参数的等距投影（确定性；不引 three） */
function projector(L) {
  const h0 = L.homeHalo || L.halos[0];
  const cx = h0.pos.x, cy = 0, cz = h0.pos.z;
  const ct = Math.cos(CAM.theta), st = Math.sin(CAM.theta);
  const cp = Math.cos(CAM.phi), sp = Math.sin(CAM.phi);
  return (p) => {
    const x = p.x - cx, y = p.y - cy, z = p.z - cz;
    const x1 = x * ct + z * st;
    const z1 = -x * st + z * ct;
    const y1 = y * cp - z1 * sp;
    return { x: x1, y: -y1, d: z1 };
  };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function renderSVG(D, L) {
  const proj = projector(L);
  const scale = 26;                                    // 世界单位 → 像素
  const lessons = L.nodes.filter((n) => n.kind === 'lesson');   // layout 只给 nodes，课程在这里筛

  const items = [];
  const push = (kind, node, r, fill, extra) => {
    const q = proj(node.pos);
    items.push({ kind, node, r, fill, extra: extra || '', x: q.x * scale, y: q.y * scale, d: q.d });
  };

  for (const h of L.halos) {
    for (const core of h._starNodes || []) push('core', core, 9, core.hue);
  }
  /* 知识组（大知识点 · 圈与知识点之间的那一层）—— **只有声明了 groups 的圈才有**；
     没声明的包这里空转 ⇒ 产物与改动前逐字节相同（退化对拍）。半径 6.0：恒星 9 > 组 6 > 点 4.2 */
  const groups = L.grps || [];
  for (const g of groups) push('group', g, 6.0, g.hue || C.label);
  for (const p of L.pts) push('point', p, 4.2, p.hue);
  for (const l of lessons) {
    // 未学过的压暗（与 WebGL 版同一套判断）；异常色是**唯一的高饱和**
    const fill = l.flag === 'red' ? C.red : (l.flag === 'yellow' ? C.yellow : (l.learned ? l.hue : C.dim));
    push('lesson', l, l.learned ? 3.0 : 2.0, fill, l.learned ? '' : ' opacity="0.55"');
  }

  /* 连线：恒星→组→知识点（**没归组的点照旧从恒星直连** —— 防丢）；知识点→首课；课→课（按 edges）；前置（虚线弧） */
  const seg = [];
  const line = (a, b, dash) => {
    const p1 = proj(a), p2 = proj(b);
    seg.push(`<line x1="${(p1.x * scale).toFixed(1)}" y1="${(p1.y * scale).toFixed(1)}" x2="${(p2.x * scale).toFixed(1)}" y2="${(p2.y * scale).toFixed(1)}" stroke="${C.link}" stroke-width="0.9"${dash ? ' stroke-dasharray="3 3" opacity="0.55"' : ' opacity="0.42"'} />`);
  };
  for (const h of L.halos) for (const p of h.points) line(h.pos, p.pos, false);
  for (const p of L.pts) if (p.lessons.length) line(p.pos, p.lessons[0].pos, false);
  for (const e of D.edges || []) {
    const a = L.lessonById.get(e.from), b = L.lessonById.get(e.to);
    if (a && b) line(a.pos, b.pos, false);
  }
  /* 前置（航道）：**弧线**，控制点抬离中点 —— 与 WebGL 版同一套（直线会从别的星身上穿过去） */
  const arc = (a, b) => {
    const p1 = proj(a), p2 = proj(b);
    const x1 = p1.x * scale, y1 = p1.y * scale, x2 = p2.x * scale, y2 = p2.y * scale;
    const d = Math.hypot(x2 - x1, y2 - y1) || 1;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2 - d * 0.36;   // 屏幕坐标 y 向下 → 抬高要减
    seg.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${C.link}" stroke-width="0.9" stroke-dasharray="3 3" opacity="0.55" />`);
  };
  for (const p of L.pts) for (const up of p.reqNodes || []) arc(up.pos, p.pos);

  /* 包围盒 → viewBox（留 12% 边） */
  const xs = items.map((i) => i.x), ys = items.map((i) => i.y);
  const pad = 40;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;

  const lit = lessons.filter((l) => l.learned).length;
  const summary = `知识星图（静态版）：${L.halos.length} 个知识圆圈、`
    + (groups.length ? `${groups.length} 个知识组、` : '')        // 没组就不写这一句（退化对拍）
    + `${L.pts.length} 个知识点、${lessons.length} 门课程（已点亮 ${lit}）；点课程星可进入那一课`;

  const body = [
    `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${C.void}" />`,
    `<g fill="none">${seg.join('')}</g>`,
  ];
  // 核星的光晕（径向渐变；静态版不追 Bloom，一层柔光够了）
  body.unshift('<defs>' + L.halos.map((h, i) => `<radialGradient id="g${i}"><stop offset="0%" stop-color="${h.hue}" stop-opacity="0.55"/><stop offset="100%" stop-color="${h.hue}" stop-opacity="0"/></radialGradient>`).join('') + '</defs>');
  for (const h of L.halos) {
    const q = proj(h.pos), i = h.idx;
    body.push(`<circle cx="${(q.x * scale).toFixed(1)}" cy="${(q.y * scale).toFixed(1)}" r="${(9 * 3.4).toFixed(1)}" fill="url(#g${i})" />`);
  }
  for (const it of items) {
    const title = `<title>${esc(it.node.label || it.node.name || it.node.id)}</title>`;
    const dot = `<circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="${it.r}" fill="${it.fill}"${it.extra}>${title}</circle>`;
    // 课程星包成链接 → **无 JS 也能点进课程**
    if (it.kind === 'lesson' && it.node.href) {
      // ?fs=1 = 打开即全屏（assets/lesson-fs.js）。静态版也不能例外：三种打开方式体验要一致。
      body.push(`<a href="../${esc(it.node.href)}?fs=1" aria-label="进入 ${esc(it.node.label)}：${esc(it.node.title)}">${dot}</a>`);
    } else {
      body.push(dot);
    }
  }

  const w = (maxX - minX).toFixed(0), hgt = (maxY - minY).toFixed(0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${w} ${hgt}" `
    + `role="img" aria-label="${esc(summary)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`
    + body.join('') + '</svg>';
}

(async () => {
  const D = loadContent();
  const { layout } = await import('file:///' + path.join(ROOT, 'starmap', 'data-layer.js').replace(/\\/g, '/'));
  const L = layout(D, {});
  const svg = renderSVG(D, L);

  const page = fs.readFileSync(PAGE, 'utf8');
  const a = page.indexOf(MARK_A), b = page.indexOf(MARK_B);
  if (a < 0 || b < 0) {
    console.error('[starmap-svg] index.html 里找不到 ' + MARK_A + ' / ' + MARK_B + ' 标记区');
    process.exit(1);
  }
  const next = page.slice(0, a + MARK_A.length) + '\n' + svg + '\n' + page.slice(b);

  if (CHECK) {
    const sameSvg = fs.existsSync(OUT_SVG) && fs.readFileSync(OUT_SVG, 'utf8') === svg;
    const samePage = next === page;
    if (sameSvg && samePage) { console.log('[starmap-svg] ✅ 静态版与课程包一致'); process.exit(0); }
    console.error('[starmap-svg] ❌ 静态版有漂移（' + (sameSvg ? '' : 'static.svg ') + (samePage ? '' : 'index.html') + '）—— 跑 node tools/build-starmap-svg.js');
    process.exit(1);
  }

  fs.writeFileSync(OUT_SVG, svg, 'utf8');
  fs.writeFileSync(PAGE, next, 'utf8');
  const kb = (Buffer.byteLength(svg, 'utf8') / 1024).toFixed(1);
  console.log('[starmap-svg] starmap/static.svg ' + kb + ' KB（' + L.nodes.length + ' 个节点 / ' + (D.edges || []).length + ' 条边）· 已内联进 index.html');
})();
