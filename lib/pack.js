/**
 * pack.js — 【已退化为再导出】课程包事实现在住在数据层唯一入口 `lib/pack-model.js`
 * ------------------------------------------------------------------
 * 2026-09-24（交接队列②）：`readPack()` / `packSummary()` 的**实现**搬进了
 * `lib/pack-model.js` 的 ⑤ 段。原因：`whale_state` / `whale_brief` 要"只从 packModel 读"，
 * 而它们的输出里有"圆圈 / 知识点 / 课程 / 已点亮"这些课程包事实 —— 原先那些事实由
 * 另一个读取器（本文件）独立解析，于是同一个包里出现两条路径解析线。
 *
 * 现在这里**一行实现都没有**：只有再导出。所以不是"两份实现 + 对拍"，是真的只有一份。
 * 保留本文件只是为了让仍在 `import ... from '../pack.js'` 的模块（build / probe / audit /
 * visual / lessonpack / 若干测试）不必同步改动；它们可以随时迁到 `pack-model.js`。
 *
 * ⚠️ 不要在**本文件**里再加任何读取逻辑 —— 那会把刚消灭的第二条解析线请回来。
 *    新读法一律进 `lib/pack-model.js`。
 */

export { readPack, packSummary } from './pack-model.js'
