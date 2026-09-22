/**
 * notes-width.js — 正文宽度/位置的**纯计算**（浏览器与 Node 都能用，可脱离浏览器单测）
 * ==================================================================
 * 模型（用户 2026-09 定：编辑器式 + 可用区）：
 *   · 拖**右缘**手柄：只动右缘 —— 左缘（--content-left）保持不变，宽度 = 起始宽 + Δx
 *   · 拖**左缘**手柄：只动左缘 —— **右缘严格不动**，左缘 = 起始左 + Δx，宽度 = 右缘 − 左缘
 * "右缘不动"可以机械断言（left + w 恒等于常数），所以这两条能在这里单测，不靠肉眼。
 *
 * 2026-09 用户改口（这条以"可用区 = 离左栏 40px、离最右边 40px"为准）：
 *   · **可用区恢复** ⇒ 左缘下限 = 左栏右缘 + `RAIL_GAP = 40px`，右缘上限 = 窗口右边 − `WINDOW_GAP = 40px`
 *     ⇒ 拖右缘不能出视口，拖左缘不能压到左栏底下（手柄 z-index 仍高于左栏 50，留作冗余）
 *   · 左缘下限是**视口坐标**的约束 ⇒ 算式要拿到 `gap`（grid column-gap）才能把
 *     "左栏右缘 + RAIL_GAP"换算成 margin-left 坐标；当 gap 未知（窄屏非网格）按 0 算 —— 那时手柄隐藏。
 *   · 右缘上限也是视口坐标 ⇒ dragRight / moveBox / rescueBox 都要拿到 `areaLeft + winW + startLeft`。
 *   · 不再有"右边只露出一部分也留着"那种软约束 —— 一顶到 winW − WINDOW_GAP 就拖不动。
 *     rescueBox 还在，但**只**用于"换窗口宽度、读缓存值"之后：窗口变窄让可用区变窄，
 *     宽盒子可能被卡在视口外，要把它拉回新可用区。
 *
 * 约定：
 *   - 宽度范围 [MIN, MAX]，默认 DEFAULT；MIN/MAX/DEFAULT/STEP/RAIL_GAP/WINDOW_GAP 只在**这一处**定义
 *   - 脏输入（''、null、NaN、'abc'）一律回落默认 —— 绝不让 NaN 流进 CSS 变量
 */
(function (root) {
  'use strict';

  var MIN = 370;           // 2026-09 用户要求"范围两端各加 50"：420/2000 → 370/2050
  var MAX = 8192;          // 只是**防 NaN/离谱值**的护栏：2560 宽的屏上 2050 会把右缘
                          // 提前 390px 卡住（用户 2026-09 报"左右搞反了"就是它），故抬高
  var DEFAULT = 640;
  var STEP = 40;
  var RAIL_GAP = 40;       // 正文左缘离**左栏右缘**的最小距离（视口坐标；用户 2026-09 定 40px）
  var WINDOW_GAP = 40;     // 正文右缘离**窗口右边**的最大距离（视口坐标；用户 2026-09 定 40px）

  function clamp(v) {
    if (v === '' || v == null) return DEFAULT;
    var n = Math.round(Number(v));
    if (!isFinite(n)) return DEFAULT;
    return Math.max(MIN, Math.min(MAX, n));
  }

  /** 把任意输入变成有限数（脏值 → 兜底值）。rescueBox 里 `null` 会被 Number() 吃成 0，只能靠它挡 */
  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /**
   * 左缘下限，换算成"相对正文列左端的 margin-left"：
   * 视口约束 `areaLeft + left ≥ (areaLeft − gap) + RAIL_GAP` ⇒ `left ≥ RAIL_GAP − gap`。
   * 当前 CSS 的 grid column-gap = 2.5rem = 40px、RAIL_GAP 也 = 40px ⇒ minLeft = 0，
   * 即"正文左缘贴在正文列左端"，等价于"离左栏右缘 40px"。
   * gap 未知（窄屏非网格）按 0 算 —— 那时手柄本来就隐藏。
   */
  function minLeft(gap) {
    return RAIL_GAP - num(gap, 0);
  }

  /**
   * 拖右缘：宽度 = 起始宽 + Δx，但右缘不许超过 `winW − WINDOW_GAP`（视口坐标），
   * 所以宽度上限 = `winW − WINDOW_GAP − areaLeft − startLeft`。
   * 任何参数拿不到就只夹 [MIN, MAX]，绝不写 NaN。
   */
  function dragRight(startW, dx, areaLeft, winW, startLeft) {
    var w = num(startW, DEFAULT) + num(dx, 0);
    var limit = num(winW, NaN) - WINDOW_GAP - num(areaLeft, NaN) - num(startLeft, 0);
    if (isFinite(limit) && limit > 0) w = Math.min(w, limit);
    if (w < MIN) w = MIN;
    if (w > MAX) w = MAX;
    return Math.round(w);
  }

  /**
   * 拖左缘：**右缘钉住** ⇒ 左缘 = 起始左 + Δx，宽度 = 右缘 − 左缘。
   * 左缘下限见 minLeft()：正文左缘停在"左栏右缘 + RAIL_GAP"处（视口坐标），不再压左栏底下。
   */
  function dragLeft(startLeft, startW, dx, gap) {
    var l = num(startLeft, 0);
    var right = l + clamp(startW);
    var left = Math.max(minLeft(gap), Math.min(right - MIN, l + num(dx, 0)));
    var w = right - left;
    if (w > MAX) { w = MAX; left = right - MAX; }
    if (w < MIN) { w = MIN; left = right - MIN; }
    return { left: Math.round(left), w: Math.round(w) };
  }

  /** 平移整列（Shift + 拖）：**只改左缘、宽度不变**。
      左缘 ≥ 左栏右缘 + RAIL_GAP；右缘 ≤ winW − WINDOW_GAP。*/
  function moveBox(left, w, dx, gap, areaLeft, winW) {
    var width = clamp(w);
    var l = Math.max(minLeft(gap), num(left, 0) + num(dx, 0));
    // 右缘上限 ⇒ l ≤ winW − WINDOW_GAP − areaLeft − width
    var rightMaxL = num(winW, NaN) - WINDOW_GAP - num(areaLeft, NaN) - width;
    if (isFinite(rightMaxL)) l = Math.min(l, rightMaxL);
    return { left: Math.round(l), w: width };
  }

  /**
   * 安全网：把盒子拉回"左缘 ≥ 左栏右缘 + RAIL_GAP、右缘 ≤ winW − WINDOW_GAP"的位置。
   * 拖动过程中已经夹到位，安全网主要在**换窗口宽度、读缓存值**之后跑：窗口变窄后可用区
   * 跟着变窄，得保证宽盒子还在新可用区里。拿不到视口宽就只做左边那条约束，绝不写 NaN。
   */
  function rescueBox(left, w, gap, areaLeft, winW) {
    var width = clamp(w);
    var l = Math.max(minLeft(gap), num(left, 0));
    var v = num(winW, NaN);
    if (isFinite(v) && v > 0) {
      // 右缘 ≤ winW − WINDOW_GAP ⇒ l ≤ winW − WINDOW_GAP − areaLeft − width
      var rightMaxL = v - WINDOW_GAP - num(areaLeft, NaN) - width;
      if (isFinite(rightMaxL) && l > rightMaxL) l = rightMaxL;
    }
    return { left: Math.round(l), w: width };
  }

  /** 键盘微调：dir > 0 变宽，否则变窄（左缘手柄反向调用，见 page-splitter.js） */
  function step(currentW, dir) {
    return clamp(clamp(currentW) + (dir >= 0 ? STEP : -STEP));
  }

  /**
   * 规范化一组 {left, w}：夹宽度上下限、夹左缘下限（离左栏右缘 + RAIL_GAP）、挡 NaN；
   * 不夹右缘 —— 右边那一条交给 rescueBox 做（窗口变窄时它会重新算）。
   */
  function fitBox(left, w, gap) {
    return { left: Math.max(minLeft(gap), Math.round(num(left, 0))), w: clamp(w) };
  }

  /** 居中盒子：可用区间内水平居中（复位与首屏默认） */
  function centeredBox(avail, w) {
    var width = clamp(w == null ? DEFAULT : w);
    var a = Number(avail);
    if (!isFinite(a) || a <= width) return { left: 0, w: width };
    return { left: Math.round((a - width) / 2), w: width };
  }

  var api = {
    MIN: MIN, MAX: MAX, DEFAULT: DEFAULT, STEP: STEP,
    RAIL_GAP: RAIL_GAP, WINDOW_GAP: WINDOW_GAP,
    clamp: clamp, dragRight: dragRight, dragLeft: dragLeft, moveBox: moveBox, step: step,
    minLeft: minLeft, rescueBox: rescueBox, fitBox: fitBox, centeredBox: centeredBox,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node：可 require
  if (root) root.LESSON_WIDTH = api;                                          // 浏览器：window.LESSON_WIDTH
})(typeof window !== 'undefined' ? window : null);