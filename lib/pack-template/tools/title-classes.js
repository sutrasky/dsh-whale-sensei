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

/**
 * `withStaticTitles` 的**反向**：把恰好等于 `STATIC_CLASS` 的那个 class 剥掉。
 *
 * 为什么需要它：反向抽取（`build-lessons.js --extract`，页面 → 源文件）是生成侧的反向操作 ——
 * 不剥的话写回源文件就会**凭空多出一个类**，而源文件里本来没有（下一轮构建再加一次，
 * 表面看是幂等的，但源文件已经与"人写的源"不是一回事了）。
 *
 * ⚠️ **只剥恰好等于** `STATIC_CLASS` 的那个：`withStaticTitles` 从不给已有 class 的标题加，
 * 所以带别的 class 的组件标题（`notes-card__title` 之类）本来就不该动。
 */
function stripStaticTitles(html) {
  const exact = new RegExp(`\\bclass="${STATIC_CLASS}"`);
  const drop = new RegExp(`\\s*\\bclass="${STATIC_CLASS}"`);
  return String(html).replace(/<(h2|h3)(\s[^>]*)?>/g, (whole, tag, attrs) => {
    attrs = attrs || '';
    if (!exact.test(attrs)) return whole;
    return `<${tag}${attrs.replace(drop, '')}>`;
  });
}

module.exports = { withStaticTitles, stripStaticTitles, STATIC_CLASS };
