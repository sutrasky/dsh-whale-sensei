#!/usr/bin/env node
/**
 * lesson-map.js — 课次映射表（**课程包侧的唯一入口**）
 * ------------------------------------------------------------------
 * 为什么课程包里还要有这么个文件：包侧的工具是 **CommonJS**、且要能脱离插件独立运行
 * （`build-notes.js:24-29` 的"技能包守卫"就是为这个）。插件的数据层
 * `lib/pack-model.js` 是 ESM，跨仓也不该被 require。
 *
 * ## U09：本文件**不再有第二份算法**，只做**委托**
 *
 * 算法（课次映射表 / 锚点解析 / 显示换算）已经收进 `lib/unify/pack.cjs` —— 那份是**唯一**实现，
 * 宿主 `lib/pack-model.js` 与这里 require 的是**同一份源码**（本包侧的
 * `tools/unify/pack.cjs` 由 U19 的 `tools/sync-unify-core.mjs` 逐字节生成，禁止手改）。
 *
 * 于是本文件从"必须与宿主逐条对拍的镜像实现"变成**薄包装**：
 *   · 导出面逐名保持：`lessonMap / labelOfAnchor / keyOfAnchor / labelAnchorId /
 *     lessonLabel / displayNumberOf / pointMeta`（既有调用方一行不用改）；
 *   · 每个导出**就是内核里的那个函数对象**（`lessonMap === unify/pack.cjs#lessonIndex`）——
 *     "宿主与包侧一致"因此不再靠对拍，而是同一个函数。
 *
 * ## 身份口径（U-SPEC §2，别再改回去）
 *
 *   · 课程身份 = `circle/point/NNNN`；知识点身份 = `circle/point`；
 *   · 台账里的 `anchor` 是**身份键**，不是显示名 —— 「课次键 → 显示名」的反推只有
 *     `labelOfAnchor()` 一处；「写法 → 身份」的归一只有 `keyOfAnchor()` 一处；
 *   · 运行态**拒绝**历史形状（裸点 / 两段课键 `point/课号` / 显示名 / 非四位课号），
 *     唯一的历史解码在 `lib/unify/migration.cjs`（U05，随包闭包里的迁移 CLI）。
 *
 * 用法：`const { lessonMap, labelOfAnchor } = require('./lesson-map.js')`
 */
'use strict';

const packCore = require('./unify/pack.cjs');

/** 建映射表：`{ byKey, byLabel, byNumber, conflicts }`（= 内核 `lessonIndex`） */
const lessonMap = packCore.lessonIndex;

/**
 * 台账的 `anchor`（身份键）→ 课次显示名（`第1课`）。解析不到（含历史形状）→ `null`。
 * **显式桶**：`未归课` 不在课次映射表里，但它是个**合法落点**（没归到课的记录都去那儿），
 * 所以认它 → 它自己。空 / 缺 anchor 仍然回 `null`（旧格式记录不该被错算到某课头上）。
 *
 * @param {string} anchor
 * @param {{byKey: object}} index `lessonMap(root)` 的返回值
 */
const labelOfAnchor = packCore.labelOfAnchor;

/**
 * 调用方写法 → **规范课次键**。只收身份（与哨兵 `未归课`）；其余一律 `null`。
 * 旧写入口 `ask-server.js` 的 `/note` 靠它把记录归一成与插件写入口**同形**的。
 *
 * @param {string} anchor
 * @param {{byKey: object}} index `lessonMap(root)` 的返回值
 */
const keyOfAnchor = packCore.keyOfAnchor;

/**
 * 课次引用的**严格解析**（内核唯一实现，本文件只转发）。
 *
 * 与 `keyOfAnchor` 的区别只在**可诊断性**：`keyOfAnchor` 只回答"行不行"（null / 键），
 * 这里把拒绝理由（`failure.reason` / `failure.error` / `failure.candidates`）一起交给调用方 ——
 * 写口要在 4xx 里说清"你是两段键 / 显示名 / 错圈 / 歧义"，而不是只说"解析不到"。
 * 它是**同一个** `resolveLessonRef`，不是第二份解析器。
 *
 * @param {string} value 引用
 * @param {{byKey: object}} index 课次映射表
 * @returns {{ok:true, key:string, sentinel?:boolean}|{ok:false, failure:object}}
 */
const resolveLessonRef = packCore.resolveLessonRef;

/** 课次显示名（`代数 第1课`）→ **HTML 锚点 id**（`代数-第1课`）—— 页面领域，不是课程身份 */
const labelAnchorId = packCore.labelAnchorId;

/** 第 0001 课 → '第1课' */
const lessonLabel = packCore.lessonLabel;

/** 编号折算：文件号（内部 ID）→ 显示号（fileBase 来自 point.json） */
const displayNumberOf = packCore.displayNumberOf;

/** 扫 `lessons/<halo>/<point>/point.json` → `point → { label, fileBase }`（既有导出面） */
const pointMeta = packCore.pointMeta;

module.exports = {
  lessonMap,
  labelOfAnchor,
  keyOfAnchor,
  resolveLessonRef,
  labelAnchorId,
  lessonLabel,
  displayNumberOf,
  pointMeta,
};
