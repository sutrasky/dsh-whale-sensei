/**
 * page-splitter.js — 三个手柄：正文左右缘 + 左栏宽度
 * ------------------------------------------------------------------
 * 模式（data-mode）：
 *   · 'start' 正文左缘：只动左缘 —— 改 --content-left 与 --content-w，**右缘严格不动**
 *   · 'end'   正文右缘：只动右缘 —— 只改 --content-w，左缘不动
 *   · 'rail'  左栏右缘：只改 --lesson-notes-rail-w（左栏宽一变，可用区跟着变，正文会被夹）
 * 三种模式不是同一套逻辑：算式在 notes-width.js（可单测），本文件只管事件与写入。
 *
 * 夹子（用户 2026-09 改口 —— 可用区 = 离左栏 40px、离最右边 40px）：
 *   · **左缘下限 = 左栏右缘 + RAIL_GAP**（W.RAIL_GAP，40px）—— 不许压到固定左栏底下
 *   · **右缘上限 = 窗口右边 − WINDOW_GAP**（W.WINDOW_GAP，40px）—— 不许拖出视口
 *   · 两条都是视口坐标的约束 ⇒ 拖动时要把 `areaLeft + gap + winW` 都传给纯函数换算
 *   · 唯一一次"回夹"是安全网 rescueBox()：换窗口宽度 / 读缓存值之后，正文可能已经超出
 *     新可用区，把它拉回"左不压左栏、右不出视口"的位置。
 *
 * 命中（用户报过"向左推不动，像有东西挡住"）：
 *   ① 正文左缘手柄的命中区往左栏那侧的间隔里扩
 *   ② 手柄 z-index 高于固定左栏；左栏手柄又高于正文左缘手柄（两者可能重叠）
 *   ③ **边缘兜底**：正文列左右缘 14px 内按下也能起拖，不必精确命中 1px 细线
 *
 * 键盘：方向键推动的是"该手柄管的那条边"（左缘手柄按 ← 变宽；左栏手柄按 → 变宽）
 *       Enter / Home / 双击 = 复位（正文回居中 640px；左栏回到预设 clamp）
 * 持久化：lesson-content-box（正文 {left,w}）、lesson-rail-w（左栏宽）、旧键 lesson-content-w 兼容
 * URL 带 ?probe 时右下角显示现场读数（默认零痕迹）。
 */
(function () {
  'use strict';

  // 常量与纯计算来自 notes-width.js —— 单一真相，且那份能在 Node 里单测
  var W = (typeof window !== 'undefined') ? window.LESSON_WIDTH : null;
  if (!W) { console.warn('[page-splitter] 缺少 notes-width.js，宽度调整不可用'); return; }

  var BOX_KEY = 'lesson-content-box';
  var LEGACY_KEY = 'lesson-content-w';
  var RAIL_KEY = 'lesson-rail-w';
  var DEFAULT_W = W.DEFAULT;
  var MIN_W = W.MIN;
  var MAX_W = W.MAX;
  var STEP = W.STEP;
  var EDGE_PX = 14;
  var RAIL_MIN = 120;      // 再窄卡片就没法看；要更窄得先做"收起态"紧凑版
  var RAIL_MAX = 360;
  var RAIL_STEP = 16;

  var page = document.querySelector('[data-content]');
  var handles = Array.prototype.slice.call(document.querySelectorAll('.page-splitter'));
  var railHandle = document.querySelector('.rail-splitter');
  if (!page || (!handles.length && !railHandle)) return;

  /** 正文列（body 网格的第 2 列）在视口里的位置、宽度与 grid column-gap；非网格返回 null。
      可用区计算要拿 areaLeft（视口 x）+ gap（换算左缘下限用）。*/
  function gridArea() {
    var body = document.body;
    var cols = getComputedStyle(body).gridTemplateColumns;
    if (!cols || cols.indexOf('px') === -1) return null;
    var widths = cols.split(/\s+/).map(parseFloat).filter(function (n) { return isFinite(n); });
    if (widths.length < 2) return null;
    var gap = parseFloat(getComputedStyle(body).columnGap) || 0;
    var box = body.getBoundingClientRect();
    return { left: box.left + widths[0] + gap, width: widths[1], gap: gap };
  }

  /** 正文列左端在视口里的 x（拿不到就 0 —— 那是窄屏非网格，手柄本来就隐藏） */
  function areaLeftNow() {
    var area = gridArea();
    return area ? area.left : 0;
  }

  /** grid column-gap（px；拿不到就 0）—— 纯计算层把"左栏右缘 + RAIL_GAP"换算成 margin-left 时要用 */
  function areaGapNow() {
    var area = gridArea();
    return area ? area.gap : 0;
  }

  function currentW() {
    var w = Math.round(page.getBoundingClientRect().width);
    return w > 0 ? w : DEFAULT_W;
  }

  /**
   * 正文左缘相对正文列左端的偏移：优先读 margin-left 的计算值
   * （`margin-left: auto` 居中时浏览器会解析成实际 px），读不到才退回几何量。
   * 这里**不夹** —— 夹的规则只有一处真相（notes-width.js 的 dragLeft / moveBox / fitBox），
   * 读缓存值时再由 fitBox / rescueBox 兜一次脏数据。
   */
  function currentLeft() {
    var ml = parseFloat(getComputedStyle(page).marginLeft);
    if (isFinite(ml)) return Math.round(ml);
    var area = gridArea();
    if (!area) return 0;
    return Math.round(page.getBoundingClientRect().left - area.left);
  }

  function apply(box) {
    page.style.setProperty('--content-left', box.left + 'px');
    page.style.setProperty('--content-w', box.w + 'px');
  }

  /** 视口宽（拿不到就 NaN —— rescueBox 因此不动手，绝不让 NaN 流进 CSS 变量） */
  function viewportW() {
    if (typeof innerWidth === 'number' && innerWidth > 0) return innerWidth;
    var el = document.documentElement;
    return el && el.clientWidth ? el.clientWidth : NaN;
  }

  /**
   * 安全网：把正文拉回"左缘 ≥ 左栏右缘 + RAIL_GAP、右缘 ≤ winW − WINDOW_GAP"的位置 —— 唯一一次回夹。
   * 换窗口宽度 / 读缓存值之后跑：宽盒子可能卡在新可用区外。没越界就**一个字都不动**
   * （否则会把 `margin-left: auto` 的居中钉成具体 px，窗口再变宽就不居中了）。
   */
  function rescueContent() {
    var area = gridArea();
    if (!area) return;                        // 窄屏非网格：手柄都隐藏了，不必管
    var left = currentLeft();
    var w = currentW();
    var fixed = W.rescueBox(left, w, area.gap, area.left, viewportW());
    if (fixed.left === left && fixed.w === w) return;
    apply(fixed);
  }

  // ── 左栏宽度 ────────────────────────────────────────────────────────
  function currentRail() {
    var inline = document.documentElement.style.getPropertyValue('--lesson-notes-rail-w');
    if (inline) { var v = parseFloat(inline); if (isFinite(v)) return Math.round(v); }
    var cols = getComputedStyle(document.body).gridTemplateColumns.split(/\s+/).map(parseFloat).filter(function (n) { return isFinite(n); });
    return cols.length ? Math.round(cols[0]) : 172;
  }

  function setRail(px) {
    var w = Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, px)));
    document.documentElement.style.setProperty('--lesson-notes-rail-w', w + 'px');
    return w;
  }

  function saveRail(w) {
    try { localStorage.setItem(RAIL_KEY, String(w)); } catch (e) { /* 忽略 */ }
  }

  function resetRail() {
    document.documentElement.style.removeProperty('--lesson-notes-rail-w');
    try { localStorage.removeItem(RAIL_KEY); } catch (e) { /* 忽略 */ }
  }

  try {
    var rw = parseInt(localStorage.getItem(RAIL_KEY), 10);
    if (rw >= RAIL_MIN && rw <= RAIL_MAX) setRail(rw);
  } catch (e) { /* 隐私模式 / 脏数据 */ }

  // ── 现场探针（仅 ?probe）────────────────────────────────────────────
  var probe = null;
  if (typeof location !== 'undefined' && /[?&]probe\b/.test(location.search)) {
    probe = document.createElement('div');
    probe.setAttribute('data-split-probe', '');
    probe.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:999;font:12px/1.4 monospace;'
      + 'background:rgba(0,0,0,.82);color:#fff;padding:6px 8px;border-radius:6px;white-space:pre;pointer-events:none';
    document.body.appendChild(probe);
  }

  function showProbe(extra) {
    if (!probe) return;
    var area = gridArea();
    var cols = getComputedStyle(document.body).gridTemplateColumns.split(/\s+/).map(parseFloat).filter(function (n) { return isFinite(n); });
    var win = typeof innerWidth === 'number' ? innerWidth : NaN;
    var left = currentLeft();
    var w = currentW();
    var rightX = area ? area.left + left + w : NaN;
    var rightMax = isFinite(win) && area ? win - W.WINDOW_GAP : NaN;
    probe.textContent = 'left=' + left + '  w=' + w
      + '\navail=' + (area ? area.width : '?') + '  win=' + (isFinite(win) ? win : '?')
      + '\nrail=' + (cols.length ? cols[0] : '?') + '  gap=' + (area ? area.gap : '?')
      + '  margin-left=' + getComputedStyle(page).marginLeft
      + '\nareaLeft=' + (area ? Math.round(area.left) : '?')
      + '  左界(margin-left)=' + Math.round(W.minLeft(area ? area.gap : 0))
      + '  左缘视口 x=' + (area ? Math.round(area.left + left) : '?')
      + '\n右缘视口 x=' + (isFinite(rightX) ? Math.round(rightX) : '?')
      + '  右界(win-40)=' + (isFinite(rightMax) ? Math.round(rightMax) : '?')
      + (extra ? '\n' + extra : '');
  }
  showProbe('idle');

  function save() {
    try { localStorage.setItem(BOX_KEY, JSON.stringify({ left: currentLeft(), w: currentW() })); } catch (e) { /* 忽略 */ }
  }

  /** 正文复位：回到居中 + 默认宽（清掉 --content-left，CSS 的 margin-left:auto 接管居中） */
  function reset() {
    page.style.removeProperty('--content-left');
    page.style.setProperty('--content-w', DEFAULT_W + 'px');
    try { localStorage.removeItem(BOX_KEY); } catch (e) { /* 忽略 */ }
  }

  // ── 恢复上次的正文位置与宽度 ────────────────────────────────────────
  try {
    var raw = localStorage.getItem(BOX_KEY);
    if (raw) {
      var box = JSON.parse(raw);
      if (box && typeof box === 'object') apply(W.fitBox(box.left, box.w, areaGapNow()));
    } else {
      var legacy = parseInt(localStorage.getItem(LEGACY_KEY), 10);
      if (legacy >= MIN_W && legacy <= MAX_W) page.style.setProperty('--content-w', legacy + 'px');
    }
  } catch (e) { /* 隐私模式 / 脏数据 */ }
  rescueContent();   // 缓存里可能是上次被拖出可用区的坐标 —— 先保证在新窗口里仍在界内

  // ── 拖动状态（三个手柄 + 边缘兜底共用一份）──────────────────────────
  var dragging = false;
  var activeHandle = null;
  var activeMode = 'end';      // 'start' | 'end' | 'rail'
  var startX = 0;
  var startW = 0;
  var startLeft = 0;
  var startRail = 0;
  var startHandle = null;
  var endHandle = null;

  function beginDrag(mode, handle, e, via) {
    e.preventDefault();
    dragging = true;
    activeMode = mode;
    activeHandle = handle;
    if (handle) handle.setAttribute('data-dragging', '');
    startX = e.clientX;
    startW = currentW();
    startLeft = currentLeft();
    startRail = currentRail();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    var captureTarget = handle || page;
    if (captureTarget.setPointerCapture && e.pointerId != null) captureTarget.setPointerCapture(e.pointerId);
    showProbe('down  mode=' + mode + '  via=' + via + '  startLeft=' + startLeft + '  startW=' + startW);
  }

  function moveDrag(e) {
    if (!dragging) return;
    var dx = e.clientX - startX;
    var areaLeft = areaLeftNow();
    var gap = areaGapNow();
    var winW = viewportW();
    if (e.shiftKey) {
      // Shift + 拖 = **平移整列**（宽度不变）——"把这列搬到那片空地方"的动作；
      // 左缘 ≥ 左栏右缘 + RAIL_GAP，右缘 ≤ winW − WINDOW_GAP。
      apply(W.moveBox(startLeft, startW, dx, gap, areaLeft, winW));
    } else if (activeMode === 'rail') {
      setRail(startRail + dx);
    } else if (activeMode === 'start') {
      // 只动左缘，右缘钉住；下限 = 左栏右缘 + RAIL_GAP（视口坐标）
      apply(W.dragLeft(startLeft, startW, dx, gap));
    } else {
      // 只动右缘：右缘不许超过 winW − WINDOW_GAP（视口坐标）
      page.style.setProperty('--content-w',
        W.dragRight(startW, dx, areaLeft, winW, startLeft) + 'px');
    }
    showProbe('dx=' + Math.round(dx) + (e.shiftKey ? '  [平移]' : '') + (activeMode === 'start' ? '  → left=' + currentLeft() : ''));
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (activeHandle) activeHandle.removeAttribute('data-dragging');
    activeHandle = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (activeMode === 'rail') { saveRail(currentRail()); rescueContent(); }
    else { rescueContent(); save(); }   // 松手先过安全网（窗口可能又变了）再落盘
    showProbe('up  saved  mode=' + activeMode);
  }

  // ── 正文左右缘手柄 ──────────────────────────────────────────────────
  // 模式判定：优先看 CSS 命名 `.page-splitter--start`（_frame.html L54 的 class 约定，
  // 也是 CSS 命中区 .page-splitter--start { left: -26px } } 的依据），对偶兼容 `data-side`。
  // 这么写有两个好处：① 只要 .page-splitter--start 在，CSS / JS 不会脱节；
  //                ② 谁忘了写 data-side 也不会让左缘手柄退化成"和右缘一样只改宽度"（用户报的 bug）。
  handles.forEach(function (handle) {
    var mode;
    if (handle.classList && handle.classList.contains && handle.classList.contains('page-splitter--start')) {
      mode = 'start';
    } else if (handle.getAttribute('data-side') === 'start') {
      mode = 'start';
    } else {
      mode = 'end';
    }
    if (mode === 'start') startHandle = handle; else endHandle = handle;

    handle.addEventListener('pointerdown', function (e) { beginDrag(mode, handle, e, 'handle'); });
    handle.addEventListener('pointermove', moveDrag);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    handle.addEventListener('keydown', function (e) {
      var back = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
      var fwd = e.key === 'ArrowRight' || e.key === 'ArrowUp';
      if (!back && !fwd) {
        if (e.key === 'Enter' || e.key === 'Home') { e.preventDefault(); reset(); }
        return;
      }
      e.preventDefault();
      // 方向键推动的是"该手柄管的那条边"：左缘手柄按 ← 变宽，右缘手柄按 → 变宽
      var grow = mode === 'start' ? back : fwd;
      if (mode === 'start') {
        apply(W.dragLeft(currentLeft(), currentW(), grow ? -STEP : STEP, areaGapNow()));
      } else {
        page.style.setProperty('--content-w',
          W.dragRight(currentW(), grow ? STEP : -STEP,
                      areaLeftNow(), viewportW(), currentLeft()) + 'px');
      }
      save();
    });

    handle.addEventListener('dblclick', function () { reset(); });
  });

  // ── 边缘兜底：正文列左右缘 EDGE_PX 内按下也能起拖 ────────────────────
  page.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.closest && e.target.closest('.page-splitter')) return;   // 手柄自己处理
    var r = page.getBoundingClientRect();
    if (r.width <= 0) return;
    if (Math.abs(e.clientX - r.left) <= EDGE_PX) beginDrag('start', startHandle, e, 'edge');
    else if (Math.abs(r.right - e.clientX) <= EDGE_PX) beginDrag('end', endHandle, e, 'edge');
  });
  page.addEventListener('pointermove', moveDrag);
  page.addEventListener('pointerup', endDrag);
  page.addEventListener('pointercancel', endDrag);

  // ── 左栏手柄 ────────────────────────────────────────────────────────
  if (railHandle) {
    railHandle.addEventListener('pointerdown', function (e) { beginDrag('rail', railHandle, e, 'rail'); });
    railHandle.addEventListener('pointermove', moveDrag);
    railHandle.addEventListener('pointerup', endDrag);
    railHandle.addEventListener('pointercancel', endDrag);
    railHandle.addEventListener('dblclick', resetRail);

    railHandle.addEventListener('keydown', function (e) {
      var back = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
      var fwd = e.key === 'ArrowRight' || e.key === 'ArrowUp';
      if (!back && !fwd) {
        if (e.key === 'Enter' || e.key === 'Home') { e.preventDefault(); resetRail(); }
        return;
      }
      e.preventDefault();
      // 它管的是左栏的**右缘**：→ 把这条边往右推 = 左栏变宽
      saveRail(setRail(currentRail() + (fwd ? RAIL_STEP : -RAIL_STEP)));
    });
  }

  // ── 换窗口宽度：过一遍安全网（窗口变小可能把正文挤出可用区）────────────────
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rescueContent, 150);
  });
})();