/**
 * lib/plan.js — 知识点地图（大纲）的**格式与判据**：ESM 适配层（权威实现在 `lib/unify/plan.cjs`）
 * ------------------------------------------------------------------
 * U 系列（U-SPEC §5）把三类确定性计算收为**单一源码**；大纲判据的唯一计算在
 * `lib/unify/plan.cjs`。本文件只做桥：`createRequire(import.meta.url)` 拿 CJS 内核，
 * **具名再导出**，导出面与改前逐字相同：
 *   `PLAN_KEYS` / `NODE_KEYS` / `validatePlan` / `planGate` / `summarizePlan` / `planNode` /
 *   `planFrontier` / `summarizeFrontier`
 * （`planGate` 是宿主独有导出 —— 包侧 `tools/plan-map.js` 从来没有它，包装器也不加。）
 *
 * 依据 `01-鲸师.md:83`：一个知识点 = 一串「能力单元」，每个单元必须带三样 ——
 *   **可交付物 / 通过判据 / 「它让终点更近了什么」**（缺第三样的，就是可以在路线里砍掉的）。
 *
 * **落点**：`lessons/<圆圈>/<知识点>/point.json` 的 `plan` 字段。
 *   为什么挂这儿：点级元数据本来就住这个文件（`point.json` 已经有 label / fileBase / requires /
 *   practice），`readPack` 已经在读它 —— 零新 IO 路径，插件侧与包侧工具天然认同一个源。
 *
 * **为什么要有闸**（`01:385`）："建点入口随点生成地图 + `whale_author` 加大纲闸 —— 没大纲不许建课"。
 *   没有地图时"下一课教什么"只能靠**文件名序 +1**，那是**假进度** ——
 *   撞板子自己的硬规矩第 6 条（"假进度比没有进度更伤"）。
 *
 * **同源实现（历史）**：包侧曾是 `tools/plan-map.js` 的第二份实现，对拍落在
 * `test/mirror-parity.mjs` 的 ⑥ 节。U04 起包侧只是 `require('./unify/plan.cjs')` 的薄包装器。
 */
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const core = require_('./unify/plan.cjs')

/** 地图对象允许的顶层键 */
export const PLAN_KEYS = core.PLAN_KEYS

/** 每个节点允许的键（`no/title/deliverable/criteria/why` 必填，其余可选） */
export const NODE_KEYS = core.NODE_KEYS

/**
 * 校验一张地图。**纯函数**，所以可离线判（工具、闸门、测试共用同一份判据）。
 * @type {(raw: unknown, where?: string) => {ok: boolean, problems: string[], nodes: object[]}}
 */
export const validatePlan = core.validatePlan

/**
 * 大纲闸的判据：这个知识点的地图能不能拿来建课（**禁 force 绕**，`01:385`）。
 * @type {(raw: unknown, where?: string) => {ok: boolean, problems: string[], hint: string, nodes: object[], goal: string}}
 */
export const planGate = core.planGate

/** 给人看的一行摘要（工具输出 / 拒建课时用） */
export const summarizePlan = core.summarizePlan

/** 地图里第 N 课（`no === n`）的节点；没有 → null（"照大纲排下一课"要用） */
export const planNode = core.planNode

/**
 * **地图前沿**：这个知识点"下一颗该点亮的星星"是哪几颗（依据 `01:205`）。
 * @type {(raw: unknown, existingNumbers?: Iterable<number>) => object}
 */
export const planFrontier = core.planFrontier

/** 前沿的一行摘要（工具输出 / ③段用）：没有下一课时如实说"地图上全建完了" */
export const summarizeFrontier = core.summarizeFrontier
