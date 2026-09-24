/**
 * glossary-map-layout.js — 名词地图的**纯排布**（无 DOM、无动画、无事件）
 * ==================================================================
 * 为什么单独一个文件：这里是"几何"。几何错了，在图上看只是"感觉不对"
 * （上一版外轮廓成了海胆、剩余节点堆在同一点重叠），但在断言里是数字 ——
 * `tools/glossary-map.test.mjs` 在 Node 里直接 require 本文件，逐条断言。
 * 浏览器里挂 `window.GMLayout`，Node 里 `module.exports`，**同一份源码**。
 *
 * ── 两个视图（用户 2026-09-22 裁定：名词按课程包层级分层）────────────────
 *   圆圈视图（pointId=null）：中心 = 知识圆圈 → 一级 = 知识点 → 二级 = 课程
 *   知识点视图（pointId=…）： 中心 = 知识点   → 一级 = 课程   → 二级 = 名词
 * 两层的排布算法**同一套**：中心占环 0，一级按角度钉在环 1，二级在自己那一族的
 * 扇区里向外铺（详见 place()）。
 *
 * ── 坐标与形状（pointy-top 六边形网格）────────────────────────────────
 * a = 六边形外接圆半径（中心→顶点）；最近邻圆心距 D = √3·a。
 *   x = √3·a·(q + r/2)     y = 1.5·a·r
 * 环 r 的格点数 = 6r（六边形网格的"环"就是六条边，每边长 r）。
 * 节点**尺寸**是"六边形的宽"（平边到平边 = √3·a = D），所以 size = D × ratio。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GMLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SQRT3 = Math.sqrt(3);

  /**
   * 每层的宽度系数（占最近邻距 D 的比例）。
   * 两头都有约束：贴 1（0.96/0.92/0.88）时相邻缝只有 3px，悬停时的连线整条被压在六边形底下
   * 等于没画；拉太开（0.84/0.78/0.74）又"像散布的气泡、不像蜂窝"（两次都是 2026-09-22 实测）。
   * 取 0.92/0.88/0.84：缝 = D×(1-ratio) ≈ 8~16%，既是蜂窝，也留得下一条 2px 的线。
   */
  var HEX_RATIO = [0.92, 0.88, 0.84];

  /** 环 1 上六个格点的角度，从正上方偏左（240°）起顺时针 —— 与网格的六个角对齐 */
  var RING1_ORDER = [240, 300, 0, 60, 120, 180];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function norm360(d) { return ((d % 360) + 360) % 360; }
  function hexDist(q, r) { return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2; }

  /** 第 rad 环的全部格点（pointy-top 六边形网格） */
  function ringCells(rad, a) {
    var cells = [];
    for (var q = -rad; q <= rad; q++) {
      for (var r = -rad; r <= rad; r++) {
        if (hexDist(q, r) !== rad) continue;
        var x = SQRT3 * a * (q + r / 2);
        var y = 1.5 * a * r;
        var deg = norm360(Math.atan2(y, x) * 180 / Math.PI);
        cells.push({ x: x, y: y, deg: deg });
      }
    }
    return cells;
  }

  /** 从 arr 里均匀取 k 个（k <= arr.length），保持原有顺序 */
  function pickEven(arr, k) {
    if (k <= 0) return [];
    if (k >= arr.length) return arr.slice();
    if (k === 1) return [arr[Math.floor((arr.length - 1) / 2)]];
    var out = [];
    for (var j = 0; j < k; j++) out.push(arr[Math.round(j * (arr.length - 1) / (k - 1))]);
    return out;
  }

  /**
   * 解「各族的扇区起点」那一个自由度。
   * 族 i 的角宽 ∝ 它的子节点条数（角宽**不等**），但它在环 1 上的锚点角度是**钉死的**
   * （环 1 只有 6 个格点），锚点必须落在自己的扇区里。锚是死的、角宽和恰为 360°，
   * 于是只剩整体旋转 s 一个未知量 —— 按 0.25° 扫一遍，取「锚到扇区边缘的最小余量」
   * 最大的那个 s（余量为负 = 锚跑到别人扇区里了）。确定性、可复现。
   */
  function solveWedges(anchors, widths) {
    var best = 0, bestScore = -Infinity;
    for (var s = 0; s < 360; s += 0.25) {
      var acc = s, worst = Infinity;
      for (var i = 0; i < widths.length; i++) {
        var rel = norm360(anchors[i] - acc);
        var m = rel <= widths[i] ? Math.min(rel, widths[i] - rel)
                                 : -Math.min(rel - widths[i], 360 - rel);
        if (m < worst) worst = m;
        acc += widths[i];
      }
      if (worst > bestScore) { bestScore = worst; best = s; }
    }
    return { start: best, margin: bestScore };
  }

  /** 按可用宽度算最近邻距 D（六边形的"宽"）。所有尺寸从它派生 —— 换屏幕比例不变 */
  function spacingFor(widthPx) {
    return clamp(widthPx * 0.135, 96, 176);
  }

  /* ── 建视图 ─────────────────────────────────────────────────────────── */

  function findHalo(TREE, haloId) {
    var list = (TREE && TREE.halos) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === haloId) return list[i];
    return list[0] || null;
  }

  function findPoint(halo, pointId) {
    if (!halo) return null;
    for (var i = 0; i < halo.points.length; i++) if (halo.points[i].id === pointId) return halo.points[i];
    return null;
  }

  /** 名词 key → 节点（label / 三段式都从台账取，**不复制**） */
  function termNode(key, DATA, lessonLabel) {
    var t = DATA[key] || {};
    return {
      kind: 'term', level: 2, key: key, lessonLabel: lessonLabel,
      label: t.label || key, category: t.category || '',
      official: t.official, short: t.short, analogy: t.analogy, code: t.code,
    };
  }

  /**
   * 按 view 造节点、定环数、解扇区；`place(D)` 可反复调用（改视口宽就重算 D）。
   *
   * @param {object} DATA  window.GLOSSARY
   * @param {object} TREE  window.GLOSSARY_TREE（tools/build-glossary-tree.js 生成）
   * @param {object} view  { haloId, pointId } —— pointId 为空 = 圆圈视图
   */
  function build(DATA, TREE, view) {
    var warnings = [];
    if (!TREE || !TREE.halos || !TREE.halos.length) {
      return { error: '没有圆圈数据（assets/glossary-tree.js 是空的？）', warnings: warnings };
    }
    var halo = findHalo(TREE, view && view.haloId);
    if (!halo) return { error: '找不到圆圈 ' + (view && view.haloId), warnings: warnings };

    var point = (view && view.pointId) ? findPoint(halo, view.pointId) : null;
    if (view && view.pointId && !point) {
      warnings.push('圆圈「' + halo.name + '」里没有知识点 ' + view.pointId + ' —— 回退到圆圈视图');
    }

    var center, groups;
    if (point) {
      center = {
        kind: 'point', level: 0, id: point.id, label: point.name,
        sub: (point.lessons.length + ' 课 · ' +
              point.lessons.reduce(function (n, l) { return n + l.terms.length; }, 0) + ' 名词'),
        circleName: halo.name, color: halo.color, href: '',
      };
      groups = point.lessons.map(function (l) {
        return {
          id: l.key, label: l.label, sub: l.terms.length + ' 名词',
          title: l.title, page: l.page,
          children: l.terms.map(function (k) { return termNode(k, DATA, l.label); }),
        };
      });
    } else {
      center = {
        kind: 'halo', level: 0, id: halo.id, label: halo.name,
        sub: halo.center || '', circleName: halo.name, color: halo.color, href: '',
      };
      groups = halo.points.map(function (p) {
        return {
          id: p.id, label: p.name, sub: (p.lessons.length + ' 课'),
          title: p.name, page: '',
          children: p.lessons.map(function (l) {
            return {
              kind: 'lesson', level: 2, id: l.key, label: l.label,
              sub: l.terms.length + ' 名词',
              title: l.title, page: l.page, terms: l.terms,
            };
          }),
        };
      });
    }

    var l1 = [], l2 = [];
    groups.forEach(function (g, gi) {
      var node = {
        kind: (point ? 'lesson' : 'point'), level: 1, group: gi,
        id: g.id, label: g.label, sub: g.sub, title: g.title, page: g.page,
        terms: g.terms, children: g.children,
      };
      l1.push(node);
      (g.children || []).forEach(function (c) { c.group = gi; l2.push(c); });
    });

    // 课程之间的连线：**与星图同源**（都读 halo.json 的 edges.list）。布局只负责说清
    // "谁跟谁相连"，画成什么样由地图决定。挂在课程节点上，两种视图里的 id 都是课次键。
    var edgeList = halo.edges || [];
    function chainOf(id) {
      var out = [];
      edgeList.forEach(function (e) {
        if (e.from === id && e.to) out.push(e.to);
        else if (e.to === id && e.from) out.push(e.from);
      });
      return out;
    }
    l1.concat(l2).forEach(function (n) {
      if (n.kind === 'lesson') n.chain = chainOf(n.id);
    });

    var allNodes = [center].concat(l1).concat(l2);

    // 环 1 装不下就顺延（本项目 n1 很小，但别让它静默丢节点）
    var l1Rings = Math.max(1, Math.ceil(l1.length / 6));
    var R = l1Rings + 1;
    // 二级层要装得下：环 (l1Rings+1)..R 的总容量 = Σ 6k ≥ 二级条数（多给 6 格余量吸收取整）
    while ((3 * (R * (R + 1) - (l1Rings * (l1Rings + 1)))) < l2.length + 6 && R < 12) R++;

    // 角宽 ∝ 族内条数；锚点 = 该族在环 1 上的格点角度
    var sizes = l1.map(function (n) { return (n.children || []).length || 1; });
    var totalSub = sizes.reduce(function (p, q) { return p + q; }, 0);
    var widths = sizes.map(function (n) {
      return totalSub ? 360 * n / totalSub : 360 / Math.max(1, sizes.length);
    });
    var anchors = l1.map(function (n, i) {
      return RING1_ORDER[Math.round(i * 6 / Math.max(1, l1.length)) % 6];
    });
    var wedge = l1.length ? solveWedges(anchors, widths) : { start: 0, margin: 0 };
    var s0 = wedge.start;
    if (wedge.margin < 0) {
      warnings.push('扇区起点解不干净（最小余量 ' + wedge.margin.toFixed(2) + '°）：各知识点条数差距过大');
    }

    /** 重算所有坐标（D 变了就重跑） */
    function place(D) {
      var a = D / SQRT3;

      // 环 0：中心
      center.x = 0; center.y = 0; center.ring = 0; center.deg = 270;

      // 环 1..l1Rings：一级节点。环 1 按"从正上方偏左起顺时针"排，其余环按角度排
      var l1cells = [];
      for (var rr = 1; rr <= l1Rings; rr++) {
        var cs = (rr === 1)
          ? ringCells(1, a).sort(function (p, q) { return RING1_ORDER.indexOf(p.deg) - RING1_ORDER.indexOf(q.deg); })
          : ringCells(rr, a).sort(function (p, q) { return p.deg - q.deg; });
        l1cells = l1cells.concat(cs);
      }
      var l1pick = pickEven(l1cells, l1.length);
      l1.forEach(function (n, i) {
        var c = l1pick[i] || l1cells[i] || { x: 0, y: 0, deg: 0 };
        n.x = c.x; n.y = c.y; n.ring = Math.min(l1Rings, Math.floor(i / 6) + 1);
        n.deg = c.deg;
      });

      // 环 l1Rings+1 .. R 的格点，按「相对楔子原点 s0 的角度」排好，后面按扇区切片
      var cellsOf = {};
      for (var r2 = l1Rings + 1; r2 <= R; r2++) {
        cellsOf[r2] = ringCells(r2, a).map(function (c) {
          return { x: c.x, y: c.y, deg: c.deg, th: norm360(c.deg - s0) };
        }).sort(function (p, q) { return p.th - q.th; });
      }

      // 逐环落位：内环尽量填满，最外环放剩余；每族在内环都留 1 条给最外环
      // —— 每个方向都够得到最外环，外轮廓才是规整六边形。
      var remaining = sizes.slice();
      // 「每族留 1 条给最外环」是为了让**多族**时每个方向都够到最外环（外轮廓才是六边形）。
      // 只有一族时这个保留没有意义 —— 反而会把最后一条甩到空荡荡的外环上。
      var reserve = l1.length > 1 ? 1 : 0;
      var cursorOf = l1.map(function () { return 0; });
      for (var r3 = l1Rings + 1; r3 <= R; r3++) {
        var cells = cellsOf[r3];
        var sliceFrom = 0;
        var slices = l1.map(function (n, i) {
          var from = sliceFrom, to = from + widths[i];
          sliceFrom = to;
          return cells.filter(function (c) {
            var lo = norm360(from), hi = norm360(to);
            // ⚠️ `to` 可能正好等于 360（角宽之和），此时 norm360(to)=0，
            // 写成 `to > 360` 会让最后一族的切片变成空区间
            // （上一版就踩过：内环少 1 格 → 剩余节点堆在同一点重叠）
            if (to >= 360) return c.th >= lo || c.th < hi;
            return c.th >= lo && c.th < hi;
          });
        });
        l1.forEach(function (n, i) {
          var want = r3 < R ? Math.max(0, remaining[i] - reserve) : remaining[i];
          var picked = pickEven(slices[i], Math.min(want, slices[i].length));
          for (var k = 0; k < picked.length; k++) {
            var child = (n.children || [])[cursorOf[i]++];
            if (!child) break;
            child.x = picked[k].x; child.y = picked[k].y; child.ring = r3;
            child.deg = picked[k].deg;
          }
          remaining[i] -= picked.length;
        });
      }

      // 兜底：容量万一不够，绝不丢节点、也绝不堆在同一点 —— 摊到再外一环的扇区里
      l1.forEach(function (n, i) {
        var left = (n.children || []).length - cursorOf[i];
        var k2 = 0;
        for (; cursorOf[i] < (n.children || []).length; cursorOf[i]++, k2++) {
          var child = n.children[cursorOf[i]];
          var ang = norm360(anchors[i] - widths[i] / 2 + widths[i] * (k2 + 0.5) / Math.max(1, left)) * Math.PI / 180;
          var rad = (R + 1 + Math.floor(k2 / 6)) * D;
          child.x = Math.cos(ang) * rad; child.y = Math.sin(ang) * rad;
          child.ring = R + 1; child.deg = norm360(ang * 180 / Math.PI);
          warnings.push('容量不足，节点「' + child.label + '」被放到最外环之外');
        }
      });

      // 涟漪顺序：同环内按角度顺时针
      var byRing = {};
      allNodes.forEach(function (n) { (byRing[n.ring] = byRing[n.ring] || []).push(n); });
      Object.keys(byRing).forEach(function (k) {
        byRing[k].sort(function (p, q) { return (p.deg || 0) - (q.deg || 0); });
        byRing[k].forEach(function (n, i) { n.order = i; });
      });
      return allNodes;
    }

    return {
      error: null, warnings: warnings, view: { haloId: halo.id, pointId: point ? point.id : null },
      halo: halo, center: center, l1: l1, l2: l2, allNodes: allNodes,
      R: R, l1Rings: l1Rings, sizes: sizes, widths: widths, anchors: anchors, wedgeStart: s0,
      place: place,
    };
  }

  return {
    build: build, ringCells: ringCells, solveWedges: solveWedges, pickEven: pickEven,
    clamp: clamp, norm360: norm360, spacingFor: spacingFor,
    HEX_RATIO: HEX_RATIO, RING1_ORDER: RING1_ORDER, SQRT3: SQRT3,
  };
});
