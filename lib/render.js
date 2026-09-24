/**
 * render.js — 课程页纯函数层（从 build-lessons.js 搬运）
 *
 * 纯变换模块：不 import fs / child_process / 环境变量 / cwd。
 * 所有外部数据通过参数或 ctx 对象注入。
 *
 * glossaryIndex 结构（由 buildGlossaryIndex 返回）：
 *   {
 *     glossary:   <原始 GLOSSARY 对象>,
 *     labelToKey: <{ [label]: key } 反查表>,
 *     termCount:  <名词总数>
 *   }
 *
 * ctx 形状（renderPage 专用）：
 *   { frame, glossaryIndex, labels, noteCounts, qa }
 *   frame         = _frame.html 原始全文
 *   glossaryIndex = buildGlossaryIndex(GLOSSARY) 的返回值
 *   labels        = Map，键是 halo/point 或单独 point，值是 label 字符串
 *   noteCounts    = Map，键是课程 id（label 字符串），值是整数
 *   qa            = QUESTIONS 对象，可能为 undefined → 缺失时按原语义降级
 *
 * 起草：mimo（搬运 build-lessons.js 的行号区间）；收口：主线程（接口 / 判据 / 对拍）
 */

'use strict';

// 知识点地图（大纲）前沿：判据只在 lib/plan.js 那一份里（= 课程包 tools/plan-map.js 的镜像，
// 两边由 test/mirror-parity.mjs 对拍钉住），这里只 import、不重写第二份判据。
// 本模块照旧不 import fs / child_process / 环境变量 / cwd（render-parity 有断言）。
import { planFrontier } from './plan.js';
// 课次锚点 id 的**唯一实现**（插件侧）：课程包侧镜像是 tools/lesson-map.js 的同名函数，
// 两份由 `node lib/pack-model.js --selftest` 对拍钉住（登记表第 4 对）。别在本文件再写一份。
import { labelAnchorId } from './pack-model.js';

/* ── 段名常量 ───────────────────────────────────────────────────────────── */
const SECTION_NAMES = ['style', 'objective', 'review', 'body', 'reading', 'challenges'];

/* ── 图型（shape）正则 ────────────────────────────────────────────────────── */
const FIG_RE = /<!--\s*figure:\s*([A-Za-z0-9_-]+)\s*-->/g;
const FIG_ANY = /<!--\s*figure:/;

/* ── 抽取段落标题常量 ───────────────────────────────────────────────────── */
const H2_TERMS = '本课新名词';
const H2_READING = '推荐阅读';
const H2_CHALLENGE = '课后挑战';
const H2_ASK = '有疑问';

/* ── 图型（shape）管道（搬运 build-lessons.js 58-96）────────────────────── */

/**
 * figureMap — 校验 meta.figures 数组，返回 id→figure Map
 * 注意：SHAPE.validateBlock / SHAPE.renderBlock 由调用方在 figureMap/substituteFigures
 *       之外通过 shape 参数注入（原 build-lessons.js 第 61、80 行引用 SHAPE 模块）。
 *       本模块不 import shape-render.js，shape 参数须由调用方传入。
 *
 * shape = { validateBlock(b, i) → errs[], renderBlock(b) → string }
 */
export function figureMap(figures, file, shape) {
  const byId = new Map();
  (figures || []).forEach((b, i) => {
    const errs = shape.validateBlock(b, i);
    if (errs.length) throw new Error(`${file}: figures 第 ${i + 1} 项 —— ${errs.map((e) => `[${e.code}] ${e.msg}`).join('; ')}`);
    if (!b.id) throw new Error(`${file}: figures 第 ${i + 1} 项缺少 id`);
    if (byId.has(b.id)) throw new Error(`${file}: figures 里 id 重复：${b.id}`);
    byId.set(b.id, b);
  });
  return byId;
}

/** 把某个片段里的占位符替换成图型 DOM（顺带记下用过的 id） */
export function substituteFigures(html, byId, used, file, shape) {
  if (!byId.size) {
    if (FIG_ANY.test(html)) throw new Error(`${file}: 正文里有 <!--figure:…--> 占位符，但 meta.figures 是空的`);
    return html;
  }
  return html.replace(FIG_RE, (m, id) => {
    const b = byId.get(id);
    if (!b) throw new Error(`${file}: 引用了未声明的图型 <!--figure:${id}-->`);
    used.add(id);
    return shape.renderBlock(b);
  });
}

/** 页面的块序列（文字块 / 图型块交替）—— 给单调度体检用 */
export function pageSequence(page) {
  const byId = page._figures || new Map();
  const seq = [];
  for (const name of ['objective', 'review', 'body', 'reading', 'challenges']) {
    const parts = String(page.sections[name] || '').split(/<!--\s*figure:\s*([A-Za-z0-9_-]+)\s*-->/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { if (parts[i].trim()) seq.push({}); }
      else { const f = byId.get(parts[i]); seq.push({ shape: f ? f.shape : 'text' }); }
    }
  }
  return seq;
}

/* ── html helpers（搬运 build-lessons.js 146-204）─────────────────────────── */

/** 平衡标签匹配：<div …> … </div>（支持任意标签名、嵌套） */
export function balancedEl(src, start) {
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(start));
  if (!m) return { from: start, to: src.length };
  const tag = m[1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  let mm;
  while ((mm = re.exec(src))) {
    if (mm[0].slice(0, 2) === '</') {
      depth--;
      if (depth === 0) return { from: start, to: mm.index + mm[0].length };
    } else {
      depth++;
    }
  }
  return { from: start, to: src.length };
}

/** 只在正文标记里找（跳过 <style>/<script> 体，避免命中 CSS 选择器） */
export function indexOfMarkup(src, marker, from = 0) {
  let at = src.indexOf(marker, from);
  while (at >= 0) {
    const inStyle = src.lastIndexOf('<style', at) > src.lastIndexOf('</style>', at);
    const inScript = src.lastIndexOf('<script', at) > src.lastIndexOf('</script>', at);
    if (!inStyle && !inScript) return at;
    at = src.indexOf(marker, at + 1);
  }
  return -1;
}

export function elByClass(src, cls) {
  const at = indexOfMarkup(src, `class="${cls}"`);
  if (at < 0) return null;
  const tagStart = src.lastIndexOf('<', at);
  const { from, to } = balancedEl(src, tagStart);
  return { from, to, text: src.slice(from, to) };
}

/** <h2>…marker…</h2> 结束后的偏移 */
export function afterH2(src, marker) {
  const at = indexOfMarkup(src, marker);
  if (at < 0) return -1;
  const m = src.indexOf('</h2>', at);
  return m < 0 ? -1 : m + '</h2>'.length;
}

/** <h2> 元素的起始偏移。切段必须切在标签之前，切在 marker 文字上会把 <h2> 劈成两半 */
export function h2Start(src, marker) {
  const at = indexOfMarkup(src, marker);
  return at < 0 ? -1 : src.lastIndexOf('<h2', at);
}

export function trimBlankLines(s) {
  const lines = s.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

/* ── glossary helpers（搬运 build-lessons.js）────────────────────────────── */

/**
 * buildGlossaryIndex — 从 GLOSSARY 对象构建索引
 *
 * 返回值结构：
 *   {
 *     glossary:   <原始 GLOSSARY 对象>,
 *     labelToKey: <{ [label]: key } 反查表（对应原 LABEL_TO_KEY）>,
 *     termCount:  <名词总数（对应原 TERM_COUNT）>
 *   }
 */
export function buildGlossaryIndex(glossary) {
  const labelToKey = {};
  for (const [k, v] of Object.entries(glossary)) labelToKey[v.label] = k;
  return {
    glossary,
    labelToKey,
    termCount: Object.keys(glossary).length,
  };
}

/* 名词页锚点的 slug helper 与名词页链接函数：2026-09-24 两侧一起删了（课程包侧
 * `tools/build-lessons.js` 同批）。判定链：它们唯一服务的「本课新名词」清单渲染函数零调用
 * → 先删清单函数；删完这两个也零调用 → 一起删。
 * ⚠️ 顺带记下：旧写法本来也是错的 —— 它把 `../GLOSSARY.md` 写死，只在平铺旧布局
 * （`lessons/NNNN-*.html`）下碰巧成立，分层布局（`lessons/<圆圈>/<知识点>/`）会解析到
 * 不存在的 `lessons/<圆圈>/GLOSSARY.md`。课程页去名词页的**活链接**只有外壳里那条
 * `{{PAGE_UP}}GLOSSARY.md`（assets/_frame.html），它一直是对的。
 * 判据：test/render-parity.mjs（源码级 —— 这三个符号不许回来）。 */

/* ── 解析作者态源文件（搬运 build-lessons.js）────────────────────────────── */

export function parseSource(text, file, shape) {
  const metaM = text.match(/<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/);
  if (!metaM) throw new Error(`${file}: 缺少 <script data-lesson-meta>`);
  let meta;
  try {
    meta = JSON.parse(metaM[1]);
  } catch (e) {
    throw new Error(`${file}: data-lesson-meta 不是合法 JSON —— ${e.message}`);
  }
  const sections = {};
  for (const name of SECTION_NAMES) {
    const m = text.match(new RegExp(`<!--@${name}-->([\\s\\S]*?)<!--/@${name}-->`));
    sections[name] = m ? trimBlankLines(m[1]) : '';
  }
  const figures = figureMap(meta.figures, file, shape);
  return { file, meta, sections, _figures: figures, _usedFigures: new Set() };
}

/* ── escapeHtml（搬运 build-lessons.js）────────────────────────────────── */
// 「本课新名词」清单的渲染函数 2026-09-24 两侧一起删了（包侧 build-lessons.js 同名那份同批）：
// 两处定义零调用、槽位表里从来没有它的键，且现行产物**明令禁止**正文出现 `.term-list`
// （课程包 tools/notes-card.test.mjs 闸门 3 的 STALE 清单里就写着它）——
// 笔记卡改版把清单搬进卡片时，函数忘了删。meta.terms 没删：封面卡的名词计数还在用它。

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── renderPage 核心（搬运 build-lessons.js 342-412，改名 renderPage）────── */

/**
 * 末课导航里的"下一课"占位（整行 span）。
 * ------------------------------------------------------------------
 * 判据（`01:204`「后续进展都遵循这张地图」）：**地图优先于手写的 meta.nextPlaceholder** ——
 *   · 地图前沿（plan.js 的 planFrontier，判据只在那一份里）有下一课
 *     → 占位变真实课名 `下一课：${next.title}（待开课）`（title 逐字取地图原文），
 *     并给 span 打 `data-from-plan="1"` 标记；
 *   · 地图缺失 / 不合法 / 图上的课全建完（exhausted）→ **一个字都不改**，
 *     退回 `meta.nextPlaceholder || '下一课：待开课'`（不许编一个名字出来，也不许假装成功）。
 *
 * `data-from-plan="1"` 是给 extractPage 看的：这句是**地图派生的快照**，
 * 抓回 meta.nextPlaceholder 写进源文件就成了同一件事两份事实（源里一份快照、地图一份），
 * 而且每次 extract 都产生无意义 diff。手写的占位（没有标记）照旧回写 —— 手工能力保留。
 *
 * 课程包侧镜像：`tools/build-lessons.js` 的同名函数（两边由 test/render-parity.mjs 逐字节对拍）。
 */
export function nextPlaceholderSpan(meta, plan, displayNumbers) {
  const f = planFrontier(plan, displayNumbers);
  const fromPlan = Boolean(f.ok && f.next);
  const text = fromPlan ? `下一课：${f.next.title}（待开课）` : (meta.nextPlaceholder || '下一课：待开课');
  const mark = fromPlan ? ' data-from-plan="1"' : '';
  return `        <span${mark} style="color:var(--dsw-alias-label-secondary);font-weight:bold">${text}</span>`;
}

export function renderPage(page, all, ctx) {
  const raw = ctx.frame;
  // 丢掉 _frame.html 顶部的说明注释：那是给维护者看的，不该出现在每一张课程页里。
  const frame = raw.slice(raw.indexOf('<!DOCTYPE'));
  const { meta, sections } = page;
  const glossaryIndex = ctx.glossaryIndex;
  const labels = ctx.labels;
  const haloNames = ctx.haloNames;
  const noteCounts = ctx.noteCounts;
  const qa = ctx.qa;
  // 导航只在**同一个知识点**内连 —— 知识圆圈里分叉的树枝各走各的，不串成一条长链
  const group = all.filter((p) => p.halo === page.halo && p.point === page.point);
  const gi = group.indexOf(page);
  const prev = gi > 0 ? group[gi - 1] : null;
  const next = gi >= 0 && gi + 1 < group.length ? group[gi + 1] : null;

  // PAGE_UP 由源文件层级推出：page.rel = "halo/point/0001-*.html" 时 depth=2，PAGE_UP = '../../'
  const pageUp = '../'.repeat(page.rel.split('/').length);

  const navPrev = prev
    ? `        <a href="${prev.file}">← ${prev.label}：${prev.meta.navTitle}</a>`
    : `        <a href="${pageUp}MISSION.md">← 课程目标</a>`;
  const navNext = next
    ? `        <a href="${next.file}">${next.label}：${next.meta.navTitle} →</a>`
    : nextPlaceholderSpan(meta, page.plan, group.map((p) => p.displayNumber));

  const pageStyle = sections.style
    ? `    <style>\n${sections.style}\n    </style>`
    : '';

  // 图型替换：正文各段里的 <!--figure:id--> → 映射器产出的 DOM
  const used = page._usedFigures || new Set();
  // ⚠️ shape 走 ctx，不挂在 page 上：parseSource 返回的对象里没有 _shape（搬运时的接口分歧，
  //    主线程缝合 —— 原来挂 page._shape 会静默传 undefined，然后在 renderBlock 处炸）。
  const fill = (html) => substituteFigures(html, page._figures || new Map(), used, page.file, ctx.shape);
  const filled = {
    objective: fill(sections.objective),
    review: fill(sections.review),
    body: fill(sections.body),
    reading: fill(sections.reading),
    challenges: fill(sections.challenges),
  };
  const unused = [...(page._figures || new Map()).keys()].filter((id) => !used.has(id));
  if (unused.length) throw new Error(`${page.file}: meta.figures 声明了但正文没引用：${unused.join(', ')}`);

  const lesson = page.label;
  const slots = {
    TITLE: meta.title,
    NUMBER: page.displayNumber,
    LESSON_LABEL: page.label,
    // 笔记页锚点：id 侧（reference/NOTES.html）= labelAnchorId(label)，**不含空白**（HTML 对 id 的
    // 硬限制）；这里给的是**已 percent-encode 的 fragment** —— 浏览器按 decode 后与 id 比对，
    // 往返必须一致（判据：test/mirror-parity.mjs 的 F 条）。别再拿 LESSON_LABEL 直接当锚点。
    LESSON_ANCHOR: encodeURIComponent(labelAnchorId(page.label)),
    PAGE_UP: pageUp,                          // 外壳里的 {{PAGE_UP}}assets/… 靠它改写（分层后深度不再是 1）
    PAGE_REL: `lessons/${page.rel}`,
    CIRCLE: page.halo,                        // §11：与课程包 tools/build-lessons.js 逐字对应（否则 render-parity 红）
    CIRCLE_NAME: (haloNames && haloNames.get(page.halo)) || page.halo,   // 页脚用：圆圈显示名，读不到就退回 id
    LESSON_ID: `${page.point}/${String(meta.number).padStart(4, '0')}`,
    STARMAP_HREF: `${pageUp}starmap/`,
    FILE: page.file,
    PAGE_STYLE: pageStyle,
    OBJECTIVE: filled.objective,
    REVIEW: filled.review,
    HINT_TERM: meta.hintTerm,
    HINT_TERM_LABEL: glossaryIndex.glossary[meta.hintTerm] ? glossaryIndex.glossary[meta.hintTerm].label : meta.hintTerm,
    TERM_COUNT: glossaryIndex.termCount,
    BODY: filled.body,
    READING: filled.reading,
    CHALLENGES: filled.challenges,
    NAV_PREV: navPrev,
    NAV_NEXT: navNext,
    SOURCE_URL: meta.source.url,
    SOURCE_LABEL: meta.source.label,
    COVER_TERM_COUNT: Object.keys(meta.terms || {}).length,
    COVER_QA_COUNT: qa ? Object.values(qa).filter((q) => q.lesson === lesson && q.status === 'answered' && q.answerHtml).length : 0,
    COVER_NOTE_COUNT: noteCounts.get(lesson) || 0,
  };

  if (meta.hintTerm && !glossaryIndex.glossary[meta.hintTerm]) {
    throw new Error(`${page.file}: meta.hintTerm "${meta.hintTerm}" 未在 glossary-data.js 登记`);
  }

  const filledFrame = frame.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in slots)) throw new Error(`${page.file}: _frame.html 里的 {{${key}}} 没有对应实现`);
    return String(slots[key]);
  });
  // 第二趟（只认 {{PAGE_UP}}）—— 与课程包 tools/build-lessons.js 逐字对应，否则 render-parity 会红：
  // 槽位内容里的占位符不会被第一趟重扫（JS 的 replace 不回头），而作者态内容里的相对链接
  // （如 reading 里指向 reference/ 的速查表）必须跟着目录深度走。
  const assembled = filledFrame.replace(/\{\{PAGE_UP\}\}/g, () => String(slots.PAGE_UP));

  // 第三趟（§3，2026-09-21）：给**没有 class** 的 h2/h3 补静态流彩类 —— 与课程包
  // `tools/title-classes.js` 的 withStaticTitles() **逐字同源**，否则 render-parity 逐字节对拍会红。
  // 只有 h2/h3：h1 的类写在 _frame.html 模板里，h4 不上（段内小标题太密）。
  // 正文里讲 HTML 的代码块是 `&lt;h2&gt;` 转义过的，所以不会被误伤（也正因如此不能先 unescape）。
  return assembled.replace(/<(h2|h3)(\s[^>]*)?>/g, (whole, tag, attrs) => {
    attrs = attrs || '';
    if (/\bclass\s*=/.test(attrs)) return whole;
    return `<${tag}${attrs} class="rainbow-subtitle">`;
  });
}

/* ── 抽取：已有课程页 → 源文件（搬运 build-lessons.js 421-569）────────────── */

export function extractPage(text, file, navTitles, glossaryIndex) {
  const h1 = text.match(/<h1>([\s\S]*?)<\/h1>/);
  if (!h1) throw new Error(`${file}: 找不到 <h1>`);
  const numM = h1[1].match(/第\s*(\d+)\s*课/);
  if (!numM) throw new Error(`${file}: <h1> 里找不到"第N课"`);
  const number = Number(numM[1]);
  const title = h1[1].replace(/^[^第]*/, '').replace(/第\s*\d+\s*课[：:]\s*/, '').trim();

  const hint = elByClass(text, 'glossary-hint');
  const review = elByClass(text, 'review-box');
  const ask = elByClass(text, 'ask-guide');
  const hintTerm = hint ? (/data-term="([^"]+)"/.exec(hint.text) || [])[1] : '';

  let askLead = '';
  if (ask) {
    const s = /<strong>([\s\S]*?)<\/strong>/.exec(ask.text);
    if (s) askLead = s[1];
  }

  const footerM = text.match(/参考：<a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
  if (!footerM) throw new Error(`${file}: 页脚里找不到"参考：<a …>"`);

  // 名词清单：链接文字 → key（按 label 反查），<span> 是助记
  const terms = {};
  const ulAt = indexOfMarkup(text, 'class="term-list"');
  if (ulAt < 0) throw new Error(`${file}: 找不到 .term-list`);
  const ulBal = balancedEl(text, text.lastIndexOf('<', ulAt));
  const ul = text.slice(ulBal.from, ulBal.to);
  for (const li of ul.match(/<li>[\s\S]*?<\/li>/g) || []) {
    const a = /<a[^>]*>([\s\S]*?)<\/a>/.exec(li);
    if (!a) continue;
    const label = a[1].trim();
    const key = glossaryIndex.labelToKey[label];
    if (!key) throw new Error(`${file}: 名词清单里的「${label}」在 glossary-data.js 里没有同 label 的词条`);
    const sp = /<span>([\s\S]*?)<\/span>/.exec(li);
    terms[key] = sp ? sp[1].trim() : '';
  }

  // 导航里"下一课"占位文字。**来自地图的不回写**（span 带 data-from-plan="1"）：
  // 那句是地图派生的课名快照，写回 meta.nextPlaceholder 就是同一件事两份事实，
  // 而且每次 extract 都白产生 diff。没有标记的手写占位照旧回写（手工能力保留，别删）。
  const nav = elByClass(text, 'nav-links');
  let nextPlaceholder = '';
  if (nav) {
    const sp = /<span([^>]*)>([\s\S]*?)<\/span>/.exec(nav.text);
    if (sp && !/\bdata-from-plan=/.test(sp[1])) nextPlaceholder = sp[2].trim();
  }

  // 段落边界。
  // 注意：不要把块顺序写死 —— 第1课是"课后挑战 → 新名词 → 推荐阅读"，
  // 第2课是"新名词 → 推荐阅读 → 课后挑战"。每段按自己的 <h2> 定位，
  // 结束于"下一个属于别的段的 <h2>"，与顺序无关。
  const h1End = text.indexOf('</h1>') + '</h1>'.length;
  const bodyStart = hint ? hint.to : h1End;
  const askDiv = ask ? ask.from : text.length;

  const pTerms = h2Start(text, H2_TERMS);
  const pReading = h2Start(text, H2_READING);
  const pChallenge = h2Start(text, H2_CHALLENGE);
  const pAsk = h2Start(text, H2_ASK);

  /** 从 pos 之后，最近的另一个段落起点 */
  const stopAfter = (pos, others) => {
    const rest = others.filter((p) => p > pos).sort((a, b) => a - b);
    return rest.length ? rest[0] : askDiv;
  };

  const objectiveEnd = review ? review.from : hint ? hint.from : h1End;
  // 正文结束于"最早出现的那个段落标题" —— 不能写死成新名词标题：
  // 第1课把"课后挑战"放在"新名词"之前，写死就会把挑战连同标题一起吞进正文。
  const bodyEnd = [pTerms, pReading, pChallenge, pAsk]
    .filter((p) => p > bodyStart)
    .sort((a, b) => a - b)[0];
  const readingStart = pReading < 0 ? -1 : afterH2(text, H2_READING);
  const readingEnd = pReading < 0 ? -1 : stopAfter(pReading, [pTerms, pChallenge, pAsk]);
  const challengeStart = pChallenge < 0 ? -1 : afterH2(text, H2_CHALLENGE);
  const challengeEnd = pChallenge < 0 ? -1 : stopAfter(pChallenge, [pTerms, pReading, pAsk]);

  for (const [name, v] of [
    ['objectiveEnd', objectiveEnd], ['bodyEnd', bodyEnd],
    ['readingStart', readingStart], ['readingEnd', readingEnd],
    ['challengeStart', challengeStart], ['challengeEnd', challengeEnd],
  ]) {
    if (v < 0) throw new Error(`${file}: 段落边界 ${name} 定位失败 —— 页面结构与框架预期不符`);
  }
  for (const [name, a, b] of [
    ['reading', readingStart, readingEnd],
    ['challenges', challengeStart, challengeEnd],
    ['objective', h1End, objectiveEnd],
    ['body', bodyStart, bodyEnd],
  ]) {
    if (b <= a) throw new Error(`${file}: 段落 ${name} 的边界反了（${a} → ${b}）`);
  }

  const styleM = text.match(/<style>([\s\S]*?)<\/style>/);

  // 注意：原 build-lessons.js 第 516 行用 path.basename(file)，
  // 但本模块不 import path。file 参数在原版里就是 basename（如 "0001-*.html"），
  // 调用方已在 IO 薄壳里传入 basename，这里直接用 file 即可。
  const basename = file.includes('/') ? file.split('/').pop() : file;
  return {
    file: basename,
    meta: {
      title,
      number,
      navTitle: navTitles[basename] || title,
      hintTerm,
      askLead,
      source: { label: footerM[2].trim(), url: footerM[1] },
      terms,
      ...(nextPlaceholder ? { nextPlaceholder } : {}),
    },
    sections: {
      style: '',                        // 内联样式已归入 lesson-blocks.css
      objective: trimBlankLines(text.slice(h1End, objectiveEnd)),
      // 从行首切，否则首行会丢掉 4 空格缩进（切片起点是 '<' 而不是行首）
      review: review ? trimBlankLines(text.slice(text.lastIndexOf('\n', review.from) + 1, review.to)) : '',
      body: trimBlankLines(text.slice(bodyStart, bodyEnd)),
      reading: trimBlankLines(text.slice(readingStart, readingEnd)),
      challenges: trimBlankLines(text.slice(challengeStart, challengeEnd)),
    },
    _inlineStyle: styleM ? styleM[1] : '',
  };
}

/** 从别的页面的导航里反查本课的短标题 */
export function collectNavTitles(pages) {
  const titles = {};
  for (const p of pages) {
    const nav = elByClass(p.text, 'nav-links');
    if (!nav) continue;
    for (const a of nav.text.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g) || []) {
      const m = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(a);
      const target = m[1];
      if (!/^\d{4}-/.test(target)) continue;
      let label = m[2].replace(/<[^>]*>/g, '').trim();
      label = label.replace(/^←\s*/, '').replace(/\s*→$/, '');
      label = label.replace(/^下一课[：:]\s*/, '').replace(/^第\s*\d+\s*课[：:]\s*/, '');
      if (!titles[target]) titles[target] = label;
    }
  }
  return titles;
}

export function serializeSource(page) {
  const meta = JSON.stringify(page.meta, null, 2).replace(/^/gm, '');
  const out = ['<script type="application/json" data-lesson-meta>', meta, '</script>', ''];
  for (const name of SECTION_NAMES) {
    if (name === 'style') continue;
    const body = page.sections[name];
    if (!body) continue;
    out.push(`<!--@${name}-->`, body, `<!--/@${name}-->`, '');
  }
  return out.join('\n');
}

/* ── mergeBlocks 计算部分（搬运 build-lessons.js 572-602，不含 writeAtomic）─ */

/** 把各页内联样式合并成一份共享 CSS（同名选择器只留第一份）。
 *  只做计算，不写盘——原 emitBlocks 最后一行 writeAtomic 不搬。 */
export function mergeBlocks(styles) {
  const seen = new Map();
  for (const { file, css } of styles) {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].replace(/\s+/g, ' ').trim();
      const body = m[2].trim();
      if (!sel) continue;
      if (seen.has(sel)) {
        if (seen.get(sel).body !== body) {
          console.warn(`[build-lessons] ⚠️ 选择器 ${sel} 在 ${seen.get(sel).file} 与 ${file} 里定义不同，保留前者`);
        }
        continue;
      }
      seen.set(sel, { sel, body, file });
    }
  }
  const header = [
    '/* assets/lesson-blocks.css — 课程页共享块样式',
    ' *',
    ' * 由 node tools/build-lessons.js --extract 从各课程页的内联 <style> 合并而来。',
    ' * 以前每课在自己的 <style> 里各写一份（.term-list、.real-path 甚至两页重复定义），',
    ' * 改一处漏一处就会两页样式不一致。现在只有这一份。',
    ' *',
    ' * 规则：只允许用 theme.css 的令牌，不写死颜色（check-terms.js 会查）。',
    ` * 含 ${seen.size} 条规则。`,
    ' */',
    '',
  ].join('\n');
  const body = [...seen.values()]
    .map((r) => `${r.sel} {\n${r.body.split('\n').map((l) => (l.trim() ? '    ' + l.trim() : l)).join('\n')}\n}`)
    .join('\n\n');
  return `${header}\n${body}\n`;
}
