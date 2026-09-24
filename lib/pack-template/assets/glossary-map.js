/**
 * glossary-map.js — 名词地图（六边形知识地图）
 * ==================================================================
 * 数据源：
 *   assets/glossary-data.js   名词台账（window.GLOSSARY）—— 三段式解释在这儿，**不复制**
 *   assets/glossary-tree.js   圆圈→知识点→课程（window.GLOSSARY_TREE，构建期生成）
 *   assets/glossary-map-layout.js  纯排布（几何全在那边，本文件一行坐标算式都没有）
 *
 * 两个视图（用户 2026-09-22 裁定：名词按课程包层级分层）：
 *   圆圈视图：中心 = 知识圆圈 → 一级 = 知识点 → 二级 = 课程
 *   知识点视图：中心 = 知识点 → 一级 = 课程 → 二级 = 名词
 * 钻取：点知识点进第二层；点中心回第一层；Esc 逐级退回。
 *
 * 硬约束（本仓契约）：
 *   · 颜色一律走令牌，本文件**不出现任何色值**；
 *   · 动效只碰 transform / opacity；
 *   · 节点位置/尺寸走 CSS 自定义属性 --gm-x / --gm-y / --gm-d，不用 top/left。
 */
(function () {
  'use strict';

  var DATA = window.GLOSSARY;
  var TREE = window.GLOSSARY_TREE;
  var LAYOUT = window.GMLayout;          // assets/glossary-map-layout.js（必须在本文件之前加载）
  var viewport = document.getElementById('gm-viewport');
  var world = document.getElementById('gm-world');
  var edges = document.getElementById('gm-edges');
  var tip = document.getElementById('gm-tip');
  var hint = document.getElementById('gm-hint');
  var circleBox = document.querySelector('[data-gm-circles]');
  var crumbBox = document.querySelector('[data-gm-crumb]');
  // 零静默降级：缺数据/缺 DOM 就**吭声**（静默 return 的表现是"空白页但控制台干净"，最难查）
  if (!DATA || !TREE || !LAYOUT || !viewport || !world || !edges || !tip) {
    if (window.console && console.error) {
      console.error('[glossary-map] 缺依赖，地图不画：'
        + (!DATA ? ' window.GLOSSARY' : '') + (!TREE ? ' window.GLOSSARY_TREE' : '')
        + (!LAYOUT ? ' window.GMLayout' : '')
        + (!viewport ? ' #gm-viewport' : '') + (!world ? ' #gm-world' : '')
        + (!edges ? ' #gm-edges' : '') + (!tip ? ' #gm-tip' : ''));
    }
    return;
  }

  var NS = 'http://www.w3.org/2000/svg';
  /** pointy-top 正六边形（viewBox 0 0 100 115.47，宽 100 / 高 100×2/√3） */
  var HEX_POINTS = '50,0 100,28.87 100,86.6 50,115.47 0,86.6 0,28.87';
  var HEX_VIEWBOX = '0 0 100 115.47';

  /* ── 常量 ─────────────────────────────────────────────────────────── */
  var DRAG_THRESHOLD = 4;      // 位移 > 4px 才算拖拽，否则拖拽结束会误弹 tooltip
  var LERP = 0.18;             // 逐帧逼近系数
  var FLING_DECAY = 0.92;      // 惯性衰减
  var WHEEL_K = 0.0015;        // scale *= exp(-deltaY * 0.0015)
  var SCALE_HARD_MIN = 0.3;
  var SCALE_MAX = 2.6;
  var LABEL_MIN_PX = 46;       // 二级节点屏幕宽度 < 46px 就藏标签（一级/中心常显）
                               // 46 = 四个汉字 @10px 的宽度；再高就等于"缩到最小全图没有名字"
  var RIPPLE_RING_MS = 70;
  var RIPPLE_STEP_MS = 10;
  var RIPPLE_SETTLE_MS = 1400;
  var HINT_MS = 3600;
  var TOOLTIP_OFFSET = 18;

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function clamp(v, lo, hi) { return LAYOUT.clamp(v, lo, hi); }
  function hrefOf(n) { return n && n.page ? '../' + n.page : ''; }

  /* ── 状态 ─────────────────────────────────────────────────────────── */
  var state = { haloId: (TREE.halos[0] || {}).id, pointId: null };
  var map = null;
  var nodeEls = [];

  /* ── 视图（平移/缩放）状态 ────────────────────────────────────────── */
  var view = { scale: 1, tx: 0, ty: 0, gScale: 1, gTx: 0, gTy: 0 };
  var SCALE_MIN = SCALE_HARD_MIN;
  var fling = null;
  var tween = null;
  var dragging = null;
  var D = 144;

  /* ── 建节点 DOM ───────────────────────────────────────────────────── */

  function ariaFor(n) {
    if (n.kind === 'term') return n.label + '（' + n.category + '）';
    if (n.kind === 'lesson') return n.label + ' ' + (n.title || '');
    if (n.kind === 'point') return '知识点 ' + n.label;
    return '知识圆圈 ' + n.label;
  }

  function buildDom() {
    nodeEls = [];
    focusLines = [];
    while (world.firstChild) world.removeChild(world.firstChild);
    // ⚠️ 连线 SVG 是从 world 里摘下来再插回去的，它**自己的子元素不会跟着消失** ——
    // 不显式清一遍，换视图时上一层的脊线会留在图上（2026-09-22 实测：3 条变 9 条）
    while (edges.firstChild) edges.removeChild(edges.firstChild);

    map.allNodes.forEach(function (n) {
      var node = el('div', 'gm-node');
      node.setAttribute('data-level', String(n.level));
      node.setAttribute('data-kind', n.kind);
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', ariaFor(n));
      node.style.setProperty('--gm-delay', (n.ring * RIPPLE_RING_MS + n.order * RIPPLE_STEP_MS) + 'ms');

      var hex = document.createElementNS(NS, 'svg');
      hex.setAttribute('class', 'gm-hex');
      hex.setAttribute('viewBox', HEX_VIEWBOX);
      hex.setAttribute('aria-hidden', 'true');
      var poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('class', 'gm-hex__shape');
      poly.setAttribute('points', HEX_POINTS);
      hex.appendChild(poly);

      var label = el('span', 'gm-label');
      var main = el('span', 'gm-label__main');
      main.textContent = n.label;
      label.appendChild(main);
      if (n.sub) {
        var sub = el('span', 'gm-label__sub');
        sub.textContent = n.sub;
        label.appendChild(sub);
      }

      node.appendChild(hex);
      node.appendChild(label);
      n.el = node;
      n.labelEl = label;
      world.appendChild(node);
      nodeEls.push(n);
    });

    // 连线层永远在所有节点之下
    world.insertBefore(edges, world.firstChild);

    // 入场涟漪：下一帧统一打开 data-in，让 CSS 的 transition-delay 生效
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        nodeEls.forEach(function (n) { n.el.setAttribute('data-in', '1'); });
        setTimeout(function () {
          nodeEls.forEach(function (n) { n.el.setAttribute('data-settled', '1'); });
        }, RIPPLE_SETTLE_MS);
      });
    });
  }

  function applyPositions(spacing) {
    viewport.style.setProperty('--gm-d', spacing + 'px');
    map.allNodes.forEach(function (n) {
      n.el.style.setProperty('--gm-x', n.x.toFixed(2));
      n.el.style.setProperty('--gm-y', n.y.toFixed(2));
      n.sizePx = spacing * LAYOUT.HEX_RATIO[n.level];
    });
  }

  /* ── 视图变换 ─────────────────────────────────────────────────────── */

  function applyView() {
    world.style.transform = 'translate3d(' + view.tx.toFixed(2) + 'px,' + view.ty.toFixed(2) + 'px,0) scale(' + view.scale.toFixed(4) + ')';
    // 标签字号**抗缩放**：世界被 scale 缩过一次，不补回来的话 11px 的标签在 s≈0.4 时只剩 4px
    viewport.style.setProperty('--gm-1over', (1 / view.scale).toFixed(4));
    refreshLabels();
  }

  /** 标签显隐：中心/一级常显（它们是"地标"），二级按屏幕宽度 */
  function refreshLabels() {
    nodeEls.forEach(function (n) {
      var px = n.sizePx * view.scale;
      var on = n.level <= 1 || px >= LABEL_MIN_PX;
      n.labelEl.setAttribute('data-shown', (on || n.state === 'focus') ? '1' : '0');
    });
  }

  function computeFit() {
    var vw = viewport.clientWidth || window.innerWidth;
    var vh = viewport.clientHeight || window.innerHeight;
    D = LAYOUT.spacingFor(vw);
    var extent = map.R * D + D;
    var s = Math.min((vw - 40) / (2 * extent), (vh - 40) / (2 * extent));
    SCALE_MIN = Math.min(SCALE_HARD_MIN, s * 0.9);
    return { scale: clamp(s, SCALE_MIN, 1), tx: vw / 2, ty: vh / 2 };
  }

  function resetView(animated) {
    var f = computeFit();
    map.place(D);
    applyPositions(D);
    if (!animated) {
      view.scale = view.gScale = f.scale;
      view.tx = view.gTx = f.tx;
      view.ty = view.gTy = f.ty;
      applyView();
      return;
    }
    tween = {
      t0: performance.now(), ms: 420,
      from: { scale: view.scale, tx: view.tx, ty: view.ty },
      to: f,
    };
    view.gScale = f.scale; view.gTx = f.tx; view.gTy = f.ty;
  }

  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }

  function frame(now) {
    if (tween) {
      var p = clamp((now - tween.t0) / tween.ms, 0, 1);
      var e = easeOutQuint(p);
      view.scale = tween.from.scale + (tween.to.scale - tween.from.scale) * e;
      view.tx = tween.from.tx + (tween.to.tx - tween.from.tx) * e;
      view.ty = tween.from.ty + (tween.to.ty - tween.from.ty) * e;
      if (p >= 1) tween = null;
    } else {
      if (fling) {
        view.gTx += fling.vx; view.gTy += fling.vy;
        fling.vx *= FLING_DECAY; fling.vy *= FLING_DECAY;
        if (Math.abs(fling.vx) < 0.05 && Math.abs(fling.vy) < 0.05) fling = null;
      }
      view.scale += (view.gScale - view.scale) * LERP;
      view.tx += (view.gTx - view.tx) * LERP;
      view.ty += (view.gTy - view.ty) * LERP;
    }
    applyView();
    requestAnimationFrame(frame);
  }

  /* ── 焦点 / 降亮 / 连线 ───────────────────────────────────────────── */

  var focusNode = null;
  var pinned = false;
  var focusLines = [];

  /**
   * 连线拓扑（用户 2026-09-22 裁定，与星图同源）：
   *   · **只有 圆圈 / 知识点 / 课程 这三层之间连线**；名词是叶子，**不连**
   *     （名词那一层靠扇区分组已经说清楚了，42 条线只会糊成一团）；
   *   · 子连父，不是"全都连中心" —— 中心只连它自己的一级；
   *   · 课程与课程按 halo.json 的 edges 串起来（第2课的前置是第1课）。
   */
  function linkable(n) { return !!n && n.kind !== 'term'; }

  function parentOf(n) {
    if (n.level === 2) return map.l1[n.group] || null;
    if (n.level === 1) return map.center;
    return null;
  }

  function byId(id) {
    for (var i = 0; i < map.allNodes.length; i++) if (map.allNodes[i].id === id) return map.allNodes[i];
    return null;
  }

  function neighboursOf(n) {
    if (!linkable(n)) return [];
    var out = [];
    var p = parentOf(n);
    if (linkable(p)) out.push(p);
    (n.chain || []).forEach(function (id) {
      var m = byId(id);
      if (linkable(m) && out.indexOf(m) < 0) out.push(m);
    });
    (n.children || []).forEach(function (c) { if (linkable(c)) out.push(c); });
    if (n === map.center) {
      map.l1.forEach(function (m) { if (linkable(m) && out.indexOf(m) < 0) out.push(m); });
    }
    return out;
  }

  /**
   * 圆心到**六边形边界**的距离（沿给定方向）。
   * 为什么需要它：线如果走圆心到圆心，就会**穿过六边形的内部**（截图里一眼就看出来，
   * 2026-09-22 实测），而且贴满时整条被压住。裁剪到边界后，线只占两个六边形之间那道缝。
   * pointy-top 六边形的平边法线在 0/60/120/…°，所以边界距离 = 内切圆半径 r / cos(δ)，
   * δ = 方向角到最近法线的夹角（0° 时 = r，30° 朝顶点时 = r/cos30° = 外接圆半径）。
   */
  function boundaryAt(n, dx, dy) {
    var r = (n.sizePx || 0) / 2;
    if (!r) return 0;
    var th = Math.atan2(dy, dx) * 180 / Math.PI;
    var d = ((th % 60) + 60) % 60;
    var delta = Math.min(d, 60 - d);                 // 到最近法线的夹角 ∈[0,30]
    return r / Math.cos(delta * Math.PI / 180);
  }

  function makeLine(a, b, cls) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var t1 = boundaryAt(a, dx, dy);
    var t2 = boundaryAt(b, -dx, -dy);
    if (t1 + t2 > len) { t1 = 0; t2 = 0; }           // 贴到一起了就退回圆心连线，别画反向线段
    var ux = dx / len, uy = dy / len;
    var line = document.createElementNS(NS, 'line');
    line.setAttribute('class', cls);
    line.setAttribute('x1', a.x + ux * t1); line.setAttribute('y1', a.y + uy * t1);
    line.setAttribute('x2', b.x - ux * t2); line.setAttribute('y2', b.y - uy * t2);
    edges.appendChild(line);
    requestAnimationFrame(function () { line.setAttribute('data-on', '1'); });
    return line;
  }

  /**
   * 连线**只在悬停/聚焦时出现**（用户 2026-09-22 裁定：线不常亮）。
   * 平时图上只有六边形，结构靠同心环表达；鼠标停到谁身上，才画谁的关系。
   */
  function drawEdges(n) {
    focusLines.forEach(function (l) { if (l.parentNode) l.parentNode.removeChild(l); });
    focusLines = [];
    if (!n) return;
    neighboursOf(n).forEach(function (m) { focusLines.push(makeLine(n, m, 'gm-edge')); });
  }

  function setFocus(n) {
    if (focusNode === n) return;
    if (focusNode) focusNode.el.removeAttribute('data-state');
    focusNode = n || null;
    var near = n ? neighboursOf(n) : [];
    nodeEls.forEach(function (m) {
      if (!n) { m.el.removeAttribute('data-state'); m.state = null; return; }
      if (m === n) { m.el.setAttribute('data-state', 'focus'); m.state = 'focus'; return; }
      if (near.indexOf(m) >= 0) { m.el.removeAttribute('data-state'); m.state = null; return; }
      m.el.setAttribute('data-state', 'dim'); m.state = 'dim';
    });
    drawEdges(n);
    if (n) showTip(n); else hideTip();
    refreshLabels();
  }

  /* ── 悬停小窗 ─────────────────────────────────────────────────────── */

  function row(key, text) {
    var p = el('p', 'gm-tip__row');
    var k = el('span', 'gm-tip__key');
    k.textContent = key;
    p.appendChild(k);
    p.appendChild(document.createTextNode(' ' + text));
    return p;
  }

  function showTip(n) {
    tip.textContent = '';
    var group = el('p', 'gm-tip__group');
    var title = el('p', 'gm-tip__title');
    title.textContent = n.label;
    tip.appendChild(group);
    tip.appendChild(title);

    if (n.kind === 'term') {
      group.textContent = n.category + ' · ' + (n.lessonLabel || '');
      if (n.official) tip.appendChild(row('官方定义：', n.official));
      if (n.short) tip.appendChild(row('大白话：', n.short));
      if (n.analogy) tip.appendChild(row('类比：', n.analogy));
      if (n.code) {
        var pre = el('pre', 'gm-tip__code');
        pre.textContent = n.code;
        tip.appendChild(pre);
      }
    } else if (n.kind === 'lesson') {
      group.textContent = n.terms ? (n.terms.length + ' 个名词') : '课程';
      if (n.title) tip.appendChild(row('这一课讲：', n.title));
      if (n.page) {
        var a = el('a', 'gm-tip__go');
        a.href = hrefOf(n);
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '打开这一课 →';
        tip.appendChild(a);
      }
    } else if (n.kind === 'point') {
      group.textContent = '知识点';
      tip.appendChild(row('含：', (n.children || []).length + ' 课'));
      var terms = 0;
      (n.children || []).forEach(function (c) { terms += (c.terms || []).length; });
      tip.appendChild(row('名词：', terms + ' 条'));
      tip.appendChild(el('p', 'gm-tip__row')).textContent = '点一下钻进去看这一族的课程与名词。';
    } else {
      group.textContent = '知识圆圈';
      if (n.sub) tip.appendChild(row('教什么：', n.sub));
      tip.appendChild(row('含：', map.l1.length + ' 个知识点'));
      var a2 = el('a', 'gm-tip__go');
      a2.href = '../reference/NOTES.html';
      a2.textContent = '答疑与我的笔记 →';
      tip.appendChild(a2);
    }
    tip.setAttribute('data-state', 'open');
  }

  function hideTip() { tip.removeAttribute('data-state'); }

  function moveTip(mx, my) {
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var x = mx + TOOLTIP_OFFSET, y = my + TOOLTIP_OFFSET;
    if (x + w > window.innerWidth - 8) x = mx - w - TOOLTIP_OFFSET;
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = y + 'px';
  }

  /* ── 指针交互 ─────────────────────────────────────────────────────── */

  function localPoint(e) {
    var r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function nodeFromEvent(e) {
    var t = e.target;
    while (t && t !== viewport) {
      if (t.classList && t.classList.contains('gm-node')) {
        var id = t.getAttribute('aria-label');
        for (var i = 0; i < nodeEls.length; i++) if (nodeEls[i].el === t) return nodeEls[i];
        void id;
      }
      t = t.parentNode;
    }
    return null;
  }

  /** 点一下节点 = 钻取 / 打开课程 / 钉住解释。
   *  ⚠️ 两条路都会走到这里：真实鼠标的 pointerup，以及**合成 click**（`el.click()`、
   *  浏览器自动化、读屏软件的"激活"）。合成 click **不会**发 pointerdown/up，
   *  只监听指针事件的话，自动化点一下就没反应（2026-09-22 实测踩过）。
   *  用时间戳去重，真实点击不会被执行两次。 */
  var lastActivate = 0;
  function activateOnce(n) {
    if (!n) return;
    var now = Date.now();
    if (now - lastActivate < 350) return;
    lastActivate = now;
    activate(n);
  }

  function activate(n) {
    if (!n) return;
    if (n === map.center) {
      if (map.view.pointId) setView({ haloId: map.view.haloId, pointId: null });
      return;
    }
    if (n.kind === 'point') { setView({ haloId: map.view.haloId, pointId: n.id }); return; }
    if (n.kind === 'lesson') {
      // 课程在任何一层都是"叶子"：点它就是打开那一课（两个视图里行为一致，
      // 否则同一张卡片上的「打开这一课 →」在圆圈视图里会变成"钻进去"，跟提示自相矛盾）
      var href = hrefOf(n);
      if (href) window.open(href, '_blank', 'noopener');
      return;
    }
    pinned = true;
    setFocus(n);
  }

  viewport.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    dragging = {
      x: e.clientX, y: e.clientY, moved: false, vx: 0, vy: 0, lx: e.clientX, ly: e.clientY,
      // ⚠️ 必须在 pointerdown 时就把命中的节点记下来：下面 setPointerCapture 之后，
      // pointerup 的 target 会被**重定向到捕获元素（viewport）**，那时再 nodeFromEvent(e) 永远是 null
      // —— 表现就是"点节点没反应"，而且控制台一片干净（2026-09-22 实测踩过）。
      node: nodeFromEvent(e),
    };
    fling = null;
    tween = null;
    viewport.setPointerCapture && viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener('pointermove', function (e) {
    if (dragging) {
      var dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
      if (!dragging.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging.moved = true;
        viewport.setAttribute('data-drag', '1');
        pinned = false;
        setFocus(null);
      }
      if (dragging.moved) {
        view.gTx += e.clientX - dragging.lx;
        view.gTy += e.clientY - dragging.ly;
        view.tx = view.gTx; view.ty = view.gTy;
        dragging.vx = e.clientX - dragging.lx;
        dragging.vy = e.clientY - dragging.ly;
      }
      dragging.lx = e.clientX; dragging.ly = e.clientY;
      return;
    }
    var n = nodeFromEvent(e);
    if (n) {
      if (n !== focusNode) { pinned = false; setFocus(n); }
      var p = localPoint(e);
      moveTip(p.x, p.y);
    } else if (!pinned && focusNode) {
      setFocus(null);
    }
  });

  function endDrag(e) {
    if (!dragging) return;
    var d = dragging;
    dragging = null;
    viewport.removeAttribute('data-drag');
    if (!d.moved) {
      // 用 pointerdown 时记下的那个节点（见 pointerdown 里的注释）
      activateOnce(d.node || nodeFromEvent(e));
      return;
    }
    if (Math.abs(d.vx) > 1 || Math.abs(d.vy) > 1) fling = { vx: d.vx * 0.9, vy: d.vy * 0.9 };
  }

  viewport.addEventListener('pointerup', endDrag);
  // 合成 click 的那条路（真实鼠标由 pointerup 那条负责，时间戳去重）
  viewport.addEventListener('click', function (e) {
    if (dragging) return;
    activateOnce(nodeFromEvent(e));
  });
  viewport.addEventListener('pointercancel', function () {
    dragging = null;
    viewport.removeAttribute('data-drag');
  });

  viewport.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = localPoint(e);
    var k = Math.exp(-e.deltaY * WHEEL_K);
    var next = clamp(view.gScale * k, SCALE_MIN, SCALE_MAX);
    // 锚点是鼠标位置（不是画布中心）：鼠标下的世界点保持不动
    var wx = (p.x - view.gTx) / view.gScale;
    var wy = (p.y - view.gTy) / view.gScale;
    view.gScale = next;
    view.gTx = p.x - wx * next;
    view.gTy = p.y - wy * next;
    tween = null; fling = null;
  }, { passive: false });

  viewport.addEventListener('dblclick', function (e) {
    if (nodeFromEvent(e)) return;      // 双击节点不算"双击空白"
    pinned = false;
    setFocus(null);
    resetView(true);
  });

  // 键盘：Tab 到节点即聚焦，Enter/Space 与点击同义，Esc 逐级退回
  viewport.addEventListener('focusin', function (e) {
    var n = nodeFromEvent(e);
    if (!n) return;
    setFocus(n);
    var r = n.el.getBoundingClientRect();
    moveTip(r.right, r.top + r.height / 2);
  });

  viewport.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { back(); return; }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      var n = nodeFromEvent(e);
      if (!n) return;
      e.preventDefault();
      activate(n);
    }
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') back();
  });

  function back() {
    if (pinned) { pinned = false; setFocus(null); return; }
    if (map.view.pointId) setView({ haloId: map.view.haloId, pointId: null });
    else { setFocus(null); resetView(true); }
  }

  /* ── 卡片：圆圈切换器 / 面包屑 / 计数 ─────────────────────────────── */

  function renderCard() {
    // 计数（全局，不随视图变）
    var counts = { halos: TREE.halos.length, points: 0, lessons: 0 };
    TREE.halos.forEach(function (h) {
      counts.points += h.points.length;
      h.points.forEach(function (p) { counts.lessons += p.lessons.length; });
    });
    Object.keys(counts).forEach(function (k) {
      var box = document.querySelector('[data-gm-count="' + k + '"]');
      if (box) box.textContent = String(counts[k]);
    });

    // 圆圈切换器（圆圈数量会变，按树生成）
    if (circleBox) {
      circleBox.textContent = '';
      TREE.halos.forEach(function (h) {
        var b = el('button', 'gm-circle');
        b.type = 'button';
        b.setAttribute('data-gm-circle', h.id);
        b.setAttribute('aria-pressed', String(h.id === state.haloId));
        var dot = document.createElementNS(NS, 'svg');
        dot.setAttribute('class', 'gm-circle__hex');
        dot.setAttribute('viewBox', HEX_VIEWBOX);
        dot.setAttribute('aria-hidden', 'true');
        var dotPoly = document.createElementNS(NS, 'polygon');
        dotPoly.setAttribute('points', HEX_POINTS);
        dot.appendChild(dotPoly);
        // 圆圈的身份色（halo.json 的 color）—— 星图那边用的就是它
        if (h.color) dot.style.setProperty('--gm-circle-color', h.color);
        var name = el('span', 'gm-circle__name');
        name.textContent = h.name;
        var n = el('span', 'gm-circle__n');
        var tc = 0;
        h.points.forEach(function (p) { p.lessons.forEach(function (l) { tc += l.terms.length; }); });
        n.textContent = h.points.length + ' 知识点 · ' + tc + ' 名词';
        b.appendChild(dot); b.appendChild(name); b.appendChild(n);
        b.addEventListener('click', function () {
          setView({ haloId: h.id, pointId: null });
        });
        circleBox.appendChild(b);
      });
    }

    // 面包屑：钻进去之后要有一条回去的路
    if (crumbBox) {
      crumbBox.textContent = '';
      var halo = null;
      TREE.halos.forEach(function (h) { if (h.id === map.view.haloId) halo = h; });
      var pName = '';
      if (map.view.pointId) {
        (halo ? halo.points : []).forEach(function (p) { if (p.id === map.view.pointId) pName = p.name; });
      }
      if (!pName) {
        crumbBox.textContent = '正在看：' + (halo ? halo.name : '') + ' 圆圈';
      } else {
        var a = el('a', 'gm-crumb__back');
        a.href = '#';
        a.textContent = halo ? halo.name : '';
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          setView({ haloId: map.view.haloId, pointId: null });
        });
        crumbBox.appendChild(a);
        crumbBox.appendChild(document.createTextNode(' / ' + pName));
      }
    }
  }

  /* ── 换视图（钻取 / 切圆圈）──────────────────────────────────────── */

  /** 视图写进 URL（`#圆圈/知识点`）—— 可分享、可回退、也能让自动化直接打开第二层。
   *  只 replaceState，不 push：钻取不是"新页面"，按浏览器后退键应该离开地图而不是退一层。 */
  function writeHash() {
    var h = '#' + state.haloId + (state.pointId ? '/' + state.pointId : '');
    if (window.location && window.location.hash !== h && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', h);
    }
  }

  /** 从 URL 读初始视图；读不出来就回圆圈视图（绝不因为一个坏 hash 就不画地图） */
  function readHash() {
    var h = String((window.location && window.location.hash) || '').replace(/^#/, '');
    if (!h) return null;
    var parts = h.split('/');
    var haloId = parts[0] || null;
    var ok = false;
    TREE.halos.forEach(function (x) { if (x.id === haloId) ok = true; });
    if (!ok) return null;
    return { haloId: haloId, pointId: parts[1] || null };
  }

  function setView(next) {
    var built = LAYOUT.build(DATA, TREE, next);
    if (built.error) {
      if (window.console && console.error) console.error('[glossary-map] ' + built.error);
      return;
    }
    map = built;
    if (built.warnings.length && window.console && console.warn) {
      console.warn('[glossary-map] ' + built.warnings.join('；'));
    }
    state = { haloId: map.view.haloId, pointId: map.view.pointId };
    focusNode = null;
    pinned = false;
    hideTip();
    buildDom();
    resetView(false);
    renderCard();
    writeHash();
  }

  /* ── 启动 ─────────────────────────────────────────────────────────── */

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      computeFit();
      map.place(D);
      applyPositions(D);
      view.gScale = clamp(view.gScale, SCALE_MIN, SCALE_MAX);
      view.scale = view.gScale;
      applyView();
      if (focusNode) drawEdges(focusNode);
    }, 200);
  });

  var start = readHash() || { haloId: state.haloId, pointId: null };
  setView(start);
  requestAnimationFrame(frame);

  if (hint) {
    hint.setAttribute('data-state', 'open');
    setTimeout(function () { hint.removeAttribute('data-state'); }, HINT_MS);
  }
})();
