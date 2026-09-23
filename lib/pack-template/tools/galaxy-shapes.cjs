'use strict';
/**
 * galaxy-shapes.cjs — 星系形状字典（一个知识圆圈长成什么样）
 * ------------------------------------------------------------------
 * 与工作区既有的**图型系统**（`shape-render.js` / `shape-pipeline`）同一套规矩：
 *   ① 白名单字典：形状只有这里列出的几种，别的当场红
 *   ② 使用判断：从圆圈自身的数据能推出的**选形规则**（不是凭手感挑）
 *   ③ 防单调审计：`audit()` 只**警告**不上闸（内容匹配优先，防单调是兜底）
 *
 * ## 恒星是什么（2026-09-20 用户纠正）
 *   **一颗恒星 = 一个知识圆圈（大类）**。不是"圆圈内部的小类"。
 *   · 知识点**都在同一个知识圆圈内** → **一个恒星**（`single`，**主流**）
 *   · 这个圆圈是**跨两个知识圆圈**的交叉学科（如 编程 × 数学）→ **两颗恒星**（`binary`）
 *
 *   知识点属于哪个知识圆圈，写在 `point.json` 的 `"circle"` 里；不写就默认属于本圆圈。
 *   于是"该用几颗恒星"是**从数据推出来的**，不是手填的。
 */

const SHAPES = {
  single: {
    name: '单星 · 枝干',
    cores: 1,
    coresFromCircle: false,   // 恒星 = 这个圆圈自己
    branch: 'branch',         // 枝条形态：沿知识点自己的轴往外 + 绕轴盘旋
    lean: 0,
    desc: '一颗恒星 = 这个圆圈本身。**主流形状**：知识点都在同一个知识圆圈内就用它。',
  },
  binary: {
    name: '双星 · 交错枝干',
    cores: 2,
    coresFromCircle: true,    // 两颗恒星 = **两个知识圆圈**（交叉学科）
    branch: 'branch',
    orbit: 2.6,               // 两颗恒星离共同质心多远（世界单位）
    lean: 1.0,                // 枝条朝对面那颗倾多少（0=各长各的，1=明显交错）
    // ⚠️ 不做公转：2026-09-20 用户否掉了动态（"我不要这种动态的，之前静态就很好"）。
    desc: '两颗恒星 = **两个知识圆圈**（如"编程 × 数学"的交叉学科）。'
        + '只有当这个圆圈的知识点**跨越两个圆圈**时才用；两边的枝条彼此交错。',
  },
  cluster: {
    name: '单星 · 花簇',
    cores: 1,
    coresFromCircle: false,
    branch: 'cluster',        // 枝条形态：孩子围着知识点堆成一簇（球面小簇）
    lean: 0,
    desc: '一颗恒星 + 花簇：每个知识点挂一小簇。适合**归属型**内容'
        + '（"我的答疑/笔记落在哪节课上"），一眼就能和"知识结构"的枝干区分开。',
  },
};

const DEFAULT_SHAPE = 'single';

/** 使用判断：这个圆圈里的知识点横跨了哪些知识圆圈 */
function circlesOf(h) {
  return [...new Set(((h && h.points) || []).map((p) => p.circle || h.id))];
}

/**
 * 使用判断：从数据推出该用哪种形状。
 * 显式声明优先（`halo.json` 的 `shape`）；否则按"跨几个知识圆圈"推。
 */
function pickShape(h) {
  if (h && h.shape) return h.shape;
  const n = circlesOf(h).length;
  if (n === 2) return 'binary';
  if (n > 2) return 'multi';        // 不在字典里 → validate 会给一句人话
  return DEFAULT_SHAPE;
}

/** 硬校验：返回错误数组（构建器当场红，不静默降级） */
function validate(h, allHalos) {
  const errs = [];
  const s = pickShape(h);
  if (s === 'multi') {
    errs.push(`知识点跨了 ${circlesOf(h).length} 个知识圆圈 —— 字典里还没有支持那么多恒星的形状`
      + `（现有：${Object.keys(SHAPES).join(' / ')}）`);
    return errs;
  }
  const def = SHAPES[s];
  if (!def) {
    errs.push(`shape「${s}」不在字典里（可选：${Object.keys(SHAPES).join(' / ')}）`);
    return errs;
  }
  if (def.coresFromCircle) {
    const cs = circlesOf(h);
    if (cs.length !== def.cores) errs.push(`${def.name} 需要 ${def.cores} 颗恒星（= ${def.cores} 个知识圆圈），实际 ${cs.length}`);
    const byId = new Map((allHalos || []).map((x) => [x.id, x]));
    for (const cid of cs) {
      if (!byId.has(cid)) errs.push(`恒星指向的知识圆圈「${cid}」不存在 —— 是不是还没建那个圆圈？`);
      const cnt = ((h.points) || []).filter((p) => (p.circle || h.id) === cid).length;
      if (!cnt) errs.push(`知识圆圈「${cid}」在这个圆圈里一个知识点都没有 —— 那颗恒星会空转`);
    }
  }
  return errs;
}

/** 防单调审计（只警告）：形状全都一样、相邻相同、某一种占比过高 */
function audit(halos) {
  const ws = [];
  if (!halos || halos.length < 2) return ws;
  const shapes = halos.map((h) => pickShape(h));
  const known = shapes.filter((s) => SHAPES[s]);
  if (known.length && new Set(known).size === 1) {
    ws.push(`全部 ${known.length} 个圆圈都是「${SHAPES[known[0]].name}」—— 星图会显得单调`);
  }
  const sorted = halos.map((h) => ({ id: h.id, s: pickShape(h) })).sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].s === sorted[i - 1].s) ws.push(`相邻的「${sorted[i - 1].id}」与「${sorted[i].id}」形状相同`);
  }
  const cnt = {};
  known.forEach((s) => { cnt[s] = (cnt[s] || 0) + 1; });
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] / known.length > 2 / 3) {
    ws.push(`「${SHAPES[top[0]].name}」占了 ${top[1]}/${known.length}（> 2/3）`);
  }
  return ws;
}

module.exports = { SHAPES, DEFAULT_SHAPE, circlesOf, pickShape, validate, audit };
