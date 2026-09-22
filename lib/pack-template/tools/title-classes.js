/**
 * title-classes.js — 给正文标题加流彩类（§3，2026-09-21）
 * ==================================================================
 * 为什么单独一个模块：包侧有**两个**渲染器（`build-lessons.js` 出课程页、
 * `build-notes.js` 出笔记页），它们要给同一级标题加同一个类。写在两处就是两份实现，
 * 将来只改一处会表现成"有的页面有流彩、有的没有"，而且**没有任何闸门会红**。
 *
 * 分工（别在这里加策略）：
 *   · h1 的 `.rainbow-title`（动态）写在模板里（`assets/_frame.html` 与 build-notes 的模板）——
 *     一页只有一个大标题，位置固定，不需要扫。
 *   · h2/h3 的 `.rainbow-subtitle`（静态）由本模块扫出来加 —— 它们的数量和位置随课程内容变。
 *   · **h4 不加**（段内小标题，一页能有十几个；理由与实测对比度见 styles.css 的色带注释）。
 *
 * 两个刻意的保守设计：
 *   1. **只给没有 class 的标题加**：`<h2 class="notes-card__title">` 这种组件自己的标题不许动，
 *      否则课程页左栏卡片标题也会变成流彩。
 *   2. 只匹配真实的 `<h2` / `<h3` 标签。正文里讲 HTML 的代码块已经是 `&lt;h2&gt;`（转义过），
 *      所以不会被误伤 —— 这也是为什么不能先 unescape 再处理。
 */
'use strict';

const STATIC_CLASS = 'rainbow-subtitle';

/** 给没有 class 的 <h2>/<h3> 补上静态流彩类；有 class 的原样返回 */
function withStaticTitles(html) {
  return String(html).replace(/<(h2|h3)(\s[^>]*)?>/g, (whole, tag, attrs) => {
    attrs = attrs || '';
    if (/\bclass\s*=/.test(attrs)) return whole;
    return `<${tag}${attrs} class="${STATIC_CLASS}">`;
  });
}

module.exports = { withStaticTitles, STATIC_CLASS };
