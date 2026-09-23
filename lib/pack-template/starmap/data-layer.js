/**
 * data-layer.js — 星图数据层（渲染器无关 · 确定性）
 * ------------------------------------------------------------------
 * 三条硬规则：
 *   1) 位置由「序号」算出来，不存文件、不用随机数 → 同一个 n 永远同一个坐标；
 *   2) 新增第 n 颗星时，前 n-1 颗的坐标一个字节都不变（test/ 里有断言）；
 *   3) 本文件不 import 任何渲染库 —— **WebGL 版（main.js）与静态 SVG 版（M3 的 static.js）共用它**，
 *      所以「同一份数据、两种渲染」的对比才是公平的，静态降级也才是同一份坐标。
 *
 * 两层：
 *   · **原语**：orbit / spherePoint / mulberry32 / starRadius（本文前半）
 *   · **布局**：layout(content, opts) —— 圆圈 / 知识点 / 课程三层摆到三维里（本文末尾）
 *
 * 布局：黄金角螺旋 phyllotaxis，角 = 137.5077°，半径 = r0 * sqrt(n)
 *   → 天然不重叠、前密后疏、像绕恒星公转；且加星不改旧星。
 *
 * ⚠️ 色值都是「示例基调」（色板待重定），只用来把两种渲染的差异看清楚。
 */

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.3999632297 rad ≈ 137.5077°

/** 确定性伪随机（mulberry32）—— 背景星尘用，固定种子 → 每次刷新完全一样 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 第 n 颗小星的轨道位（n 从 1 开始；中心恒星永远在原点）
 * @param {number} n 序号（1-based）
 * @param {{r0?:number, growth?:number, tilt?:number, phase?:number}} [opts]
 */
export function orbit(n, opts = {}) {
  const { r0 = 1.15, growth = 1, tilt = 0.14, phase = 0 } = opts;
  const angle = n * GOLDEN_ANGLE + phase;
  const r = r0 * Math.sqrt(n) * growth;
  return {
    n,
    angle,
    r,
    x: Math.cos(angle) * r,
    // 极小的离面偏移：让 3D 版真有"深度"可看，同时保持确定性（不是随机数）
    y: tilt * Math.sin(n * GOLDEN_ANGLE * 1.7),
    z: Math.sin(angle) * r,
  };
}

/**
 * 球面上的确定性均匀取点（R2 序列 · 两个无理数）—— 专治"全都在一个平面上"。
 *
 * 为什么不接着用 golden angle 螺旋：那是个**平面**螺旋，
 * 星系、分支、课全挤在同一层，铺出来永远是同一张盘的形状，看着重复。
 * 球面序列给每个序号一个**方向**：同一个 n 永远同一个方向，且相邻 n 尽量互相远离。
 *
 * @param {number} n 序号（1-based）
 * @returns {{n:number,x:number,y:number,z:number}} 单位向量
 */
export function spherePoint(n) {
  const G1 = 0.6180339887498949;   // 1/φ
  const G2 = 0.7548776662466927;   // 塑料数
  const y = 1 - 2 * ((n * G1) % 1);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = 2 * Math.PI * ((n * G2) % 1);
  return { n, x: r * Math.cos(th), y, z: r * Math.sin(th) };
}

/** 前 count 颗小星的位置（含序号） */
export function starPositions(count, opts) {
  const out = [];
  for (let n = 1; n <= count; n++) out.push(orbit(n, opts));
  return out;
}

/** 星点基础尺寸：越往外越小一点点（造深度感），确定性 */
export function starRadius(n) {
  return Math.max(0.55, 1.15 - 0.035 * n);
}

/** 知识圆圈 = 星系（原型只放一个；多星系就是各自的中心 + 各自的一圈星） */
export const GALAXY = { id: 'programming', name: '编程模式', hue: 0.6 };

/** 课程节点（真项目里来自课程包 json，不在代码里写死） */
export const NODES = [
  { id: 'l01', title: 'Spring Boot 起步' },
  { id: 'l02', title: 'REST API 与 CRUD' },
  { id: 'l03', title: '依赖注入与 Bean' },
  { id: 'l04', title: '配置与 Profile' },
  { id: 'l05', title: '参数校验' },
  { id: 'l06', title: '异常处理' },
  { id: 'l07', title: '日志与可观测' },
  { id: 'l08', title: '单元测试' },
  { id: 'l09', title: '数据库接入' },
  { id: 'l10', title: '事务' },
  { id: 'l11', title: '打包与运行' },
  { id: 'l12', title: '部署上线' },
];

/** 示例基调色（待你重定色板后整体替换） */
export const COLORS = {
  bg: 0x151517, // = DSH 深色画布 --dsw-static-neutral-bluish-950
  center: 0xfff0d2,
  learned: 0xa8c8ff,
  locked: 0x3b4252,
  link: 0x7f97c4,
};

/** 星图状态机：只管「已点亮几颗」。纯逻辑，可在 node 里直接测。 */
export class StarMapModel {
  constructor(nodes = NODES) {
    this.nodes = nodes;
    this.learned = 0;
  }
  get total() {
    return this.nodes.length;
  }
  canLearn() {
    return this.learned < this.total;
  }
  /** 学下一课 → 返回被点亮的第 n 颗星（1-based）；已学满返回 0 */
  learn() {
    if (!this.canLearn()) return 0;
    this.learned += 1;
    return this.learned;
  }
  reset() {
    this.learned = 0;
  }
  positions(opts) {
    return starPositions(this.learned, opts);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 布局：把课程包数据摆到三维里
 * ----------------------------------------------------------------------
 * **只依赖几何** —— 不 import three、不碰 DOM、不读全局常量。
 * 2026-09-20 从 main.js 搬到这里（M3 的前置重构）：目的是让 WebGL 版与静态 SVG 版
 * **共用同一份坐标** —— 否则 SVG 只能自己重算一遍，两份坐标迟早会漂。
 *
 * 搬过来时**只搬家、不改行为**：所有常量原样变成 opts 的默认值。
 * 返回的每个节点都带世界坐标 `pos`；圆圈还带 `radius`，知识点还带 `extent`（镜头按内容定视距用）。
 * ══════════════════════════════════════════════════════════════════════ */
export function layout(content, opts = {}) {
  const {
    POINT_R = 4.4,            // 大分支离恒星多远
    LESSON_R0 = 2.0,          // 首课离它所属分支多远
    LESSON_STEP = 1.6,        // 每往下一课再外推多远
    LESSON_TURN = 0.28,       // 每往下一课绕分支轴转多少弧度（枝条是**绕轴盘旋**的）
    LESSON_SPREAD = 0.95,     // 绕轴的偏移半径 —— 这一项才有"枝条的体积"
    HALO_Y_FLAT = 0.62,       // 圆圈之间的 y 向压扁（星系团是扁的，但不等于一个平面）
    HALO_GAP = 30,            // 两个圆圈之间的距离
    fovDeg = 45,              // 相机 fov（决定"刚好装满"的系数）
    defaultHaloId = 'programming',
    branchHues = ['#ffc978', '#7ee0c0', '#c9a0ff', '#ff9fb0'],
    haloHues = ['#fff6e2', '#bfe0ff', '#ffd9a8'],
  } = opts;

  const D = content || { halos: [], lessons: [], edges: [] };

  /* ── 圆圈（多星系）：摆在球面上，不是排成一条直线 ──────────────────── */
  const halos = (D.halos || []).map((h, i) => {
    const dir = spherePoint(i + 1);
    const cores = (h.cores && h.cores.length) ? h.cores : [{ name: '', color: null }];
    return {
      ...h, kind: 'halo', idx: i,
      pointDefs: h.points || [],                      // 原始定义另存 —— 下面的 points 会换成节点对象
      coreDefs: cores,
      coreCount: cores.length,
      orbit: h.orbit || 0,                            // 双星：核离质心多远（由 galaxy-shapes.cjs 决定）
      lean: h.lean || 0,                              // 双星：枝条朝对面那颗倾多少（交错，静态）
      pos: { x: dir.x * HALO_GAP, y: dir.y * HALO_GAP * HALO_Y_FLAT, z: dir.z * HALO_GAP },
      // 恒星色相：**优先读 halo.json 的 `color`**（hex），缺省才回落到按序号轮取。
      // 为什么必须能落盘：按序号轮取意味着"加一个圆圈就把已有圆圈的颜色挪一位" ——
      // 2026-09-22 实测：建一个 math 圈，programming 的恒星色就从 haloHues[0] 变成 [1]。
      // 圆圈颜色是身份，不该随别人增删而漂。
      hue: h.color || haloHues[i % haloHues.length],
      points: [],
    };
  });
  /** 第 ci 个核在 t=0 时相对质心的偏移（双星就是一边一个） */
  function coreOffset(h, ci) {
    if (h.coreCount < 2 || !h.orbit) return { x: 0, y: 0, z: 0 };
    const phase = (ci / h.coreCount) * Math.PI * 2;
    return { x: Math.cos(phase) * h.orbit, y: 0, z: Math.sin(phase) * h.orbit };
  }
  /** 双星交错：这个核的枝条要**朝对面那颗太阳**倾过去多少（单位方向） */
  function leanDir(h, ci) {
    if (h.coreCount < 2 || !h.orbit || !h.lean) return { x: 0, y: 0, z: 0 };
    const mine = coreOffset(h, ci);
    const other = coreOffset(h, (ci + 1) % h.coreCount);
    const dx = other.x - mine.x, dz = other.z - mine.z;
    const L = Math.hypot(dx, dz) || 1;
    return { x: dx / L, y: 0, z: dz / L };
  }

  /* ── 知识点：挂在各自圆圈的局部轨道上 ──────────────────────────────── */
  const pts = [];
  const haloById = new Map(halos.map((h) => [h.id, h]));
  halos.forEach((h) => {
    h.points = h.pointDefs.map((p, j) => {
      // 分支也走球面序列；**每个圆圈换一个相位**，否则两个星系会朝同一侧长，看着像复制粘贴
      const dir = spherePoint(j + 1 + h.idx * 3);
      const lean = leanDir(h, p.core || 0);
      // 双星：枝条在球面方向之外，**再朝对面那颗太阳倾一截** → 两边交错（静态，不靠转）
      const local = {
        x: dir.x * POINT_R + lean.x * POINT_R * h.lean,
        y: dir.y * POINT_R * 0.7,
        z: dir.z * POINT_R + lean.z * POINT_R * h.lean,
      };
      const c = coreOffset(h, p.core || 0);           // 双星：枝条挂在**自己那颗**恒星上
      const off = { x: c.x + local.x, y: c.y + local.y, z: c.z + local.z };
      const node = {
        ...p, kind: 'point', idx: j, haloNode: h, local, core: p.core || 0, off,
        // 色相按**本圆圈内的分支序号**取（j）—— 不是 (pts.length + j)：
        // 后者把"全局已入列的分支数"又加了一遍，第一条分支 0、第二条就跳到 2，
        // 于是 Vue 拿到 branchHues[2] 紫，而不是配色表写的 branch-2 青绿（2026-09-21 实测）。
        hue: branchHues[j % branchHues.length],
        pos: { x: h.pos.x + off.x, y: h.pos.y + off.y, z: h.pos.z + off.z },
        lessons: [],
      };
      pts.push(node);
      return node;
    });
  });
  const ptById = new Map(pts.map((p) => [p.id, p]));
  // 前置（航道）：把 "halo/point" 键解析成节点。前置只是**额外一条弧线**，不动枝干。
  for (const p of pts) {
    p.reqNodes = (p.requires || []).map((k) => ptById.get(String(k).split('/').pop())).filter(Boolean);
  }

  /* ── 课程：沿知识点的轴往外长（枝干）或堆成小簇（花簇）─────────────── */
  const nodes = [...halos, ...pts];                   // 所有可命中的节点（圆圈 + 知识点 + 课程）
  const lessonById = new Map();
  (D.lessons || [])
    .slice()
    .sort((a, b) => a.point.localeCompare(b.point) || a.number - b.number)
    .forEach((l) => {
      const p = ptById.get(l.point);
      if (!p) return;                          // 数据里没有这条分支：构建器已经报过警告
      const j = p.lessons.length;
      const hh = p.haloNode;
      let lessonLocal;
      if (hh.branch === 'cluster') {
        // 花簇：孩子围着知识点堆成一小簇（球面序列 → 不重叠），不是往外拖一条枝
        const cdir = spherePoint(j + 1 + p.idx * 5);
        const cr = LESSON_R0 * 0.55 + j * 0.42;
        lessonLocal = { x: cdir.x * cr, y: cdir.y * cr, z: cdir.z * cr };
      } else {
        // 枝干：沿**分支自己的轴**往外长，同时**绕轴盘旋**
        const ax = p.local;
        const L = Math.hypot(ax.x, ax.y, ax.z) || 1;
        const axis = { x: ax.x / L, y: ax.y / L, z: ax.z / L };
        const ref = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        let u = { x: ref.y * axis.z - ref.z * axis.y, y: ref.z * axis.x - ref.x * axis.z, z: ref.x * axis.y - ref.y * axis.x };
        const ul = Math.hypot(u.x, u.y, u.z) || 1;
        u = { x: u.x / ul, y: u.y / ul, z: u.z / ul };
        const v = { x: axis.y * u.z - axis.z * u.y, y: axis.z * u.x - axis.x * u.z, z: axis.x * u.y - axis.y * u.x };
        const outR = LESSON_R0 + j * LESSON_STEP;
        const spin = j * LESSON_TURN * 2.2;
        const cs = Math.cos(spin) * LESSON_SPREAD, sn = Math.sin(spin) * LESSON_SPREAD;
        lessonLocal = {
          x: axis.x * outR + u.x * cs + v.x * sn,
          y: axis.y * outR + u.y * cs + v.y * sn,
          z: axis.z * outR + u.z * cs + v.z * sn,
        };
      }
      lessonLocal.y += j * 0.6;                // 越学越高（×0.6）：让"进度"有物理方向
      const off = { x: p.off.x + lessonLocal.x, y: p.off.y + lessonLocal.y, z: p.off.z + lessonLocal.z };
      const node = {
        ...l, kind: 'lesson', pointNode: p, hue: p.hue, off,
        pos: { x: hh.pos.x + off.x, y: hh.pos.y + off.y, z: hh.pos.z + off.z },
      };
      p.lessons.push(node);
      nodes.push(node);
      lessonById.set(l.id, node);
    });

  /* ── 核星：每个圆圈 1 颗（单星）或 2 颗（双星）───────────────────────
     双星的两颗太阳各带自己的枝条（自旋在 2026-09-20 被用户否掉：静态更好）。 */
  halos.forEach((h) => {
    h._starNodes = h.coreDefs.map((c, ci) => {
      const o = coreOffset(h, ci);
      return {
        kind: 'core', haloNode: h, idx: ci, name: c.name || '', lessons: [],
        hue: c.color || (c.halo && c.halo !== h.id && haloById.get(c.halo) ? haloById.get(c.halo).hue : h.hue),
        off: { x: o.x, y: o.y, z: o.z },
        pos: { x: h.pos.x + o.x, y: h.pos.y + o.y, z: h.pos.z + o.z },
        _prog: 1,
      };
    });
  });

  /* ── 镜头"刚好装满"的系数 + 每个圆圈/分支的半径 ──────────────────────
     参考规范说 dist ≈ R×1.62 刚好填满、R×2.1 就空洞小气，但那个 1.62 是配**宽 fov** 的；
     我们是 fov 45°（半角 22.5°，tan = 0.4142），等价系数是 1/tan(22.5°) ≈ 2.41 ——
     照抄 1.62 会把最外圈的课切出画面。留 5% 边。 */
  const FIT = (1 / Math.tan((fovDeg / 2) * Math.PI / 180)) * 0.95;
  for (const h of halos) {
    let rr = 0;
    const scan = (n) => {
      rr = Math.max(rr, Math.hypot(n.pos.x - h.pos.x, n.pos.y - h.pos.y, n.pos.z - h.pos.z));
    };
    (h._starNodes || []).forEach(scan);
    h.points.forEach((p) => {
      scan(p);
      let pe = 0;
      p.lessons.forEach((l) => {
        scan(l);
        pe = Math.max(pe, Math.hypot(l.pos.x - p.pos.x, l.pos.y - p.pos.y, l.pos.z - p.pos.z));
      });
      p.extent = Math.max(2.2, pe + 1.2);      // 这条分支自己的半径（含一点留白）
    });
    h.radius = Math.max(3, rr);
  }
  const homeHalo = halos.find((h) => h.id === defaultHaloId) || halos[0];

  return { halos, pts, nodes, ptById, lessonById, haloById, homeHalo, FIT, coreOffset, leanDir };
}
