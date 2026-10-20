/**
 * tools/plan-map.js —— 知识点地图（大纲）的**格式与判据**（课程包侧）：纯委托包装器
 * ------------------------------------------------------------------
 * **权威实现只有一份**：`lib/unify/plan.cjs`（U-SPEC §5 的单一源码；U19 会把它逐字节
 * 生成成课程包里的 `tools/unify/plan.cjs`）。本文件**不含任何计算**。
 *
 * 为什么包侧也要有这一件：架构上选了**甲方案**（包侧 `tools/` 必须能脱离插件独立跑），
 * 而包侧工具 require 的名字是 `tools/plan-map.js`（`build-starmap.js` 算"规划中暗星"的前沿、
 * `build-lessons.js` 排下一课），件名不能改，所以保留这一层壳。
 *
 * 导出面**与改前逐键相同**（7 个键）：`PLAN_KEYS` / `NODE_KEYS` / `validatePlan` /
 * `planFrontier` / `summarizePlan` / `summarizeFrontier` / `planNode`。
 * ⚠️ 内核多一个 `planGate`（大纲闸，**宿主独有**）—— 包侧从来没有它，这里也**不**转出来：
 *    "收成一份计算"不等于"扩大包侧 API"。
 */
'use strict';

const core = require('./unify/plan.cjs');

module.exports = {
  PLAN_KEYS: core.PLAN_KEYS,
  NODE_KEYS: core.NODE_KEYS,
  validatePlan: core.validatePlan,
  planFrontier: core.planFrontier,
  summarizePlan: core.summarizePlan,
  summarizeFrontier: core.summarizeFrontier,
  planNode: core.planNode,
};
