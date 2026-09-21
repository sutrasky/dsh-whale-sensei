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

/* ── glossary helpers（搬运 build-lessons.js 206-240）────────────────────── */

export function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

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

export function termHref(glossaryIndex, key) {
  return `../GLOSSARY.md#${slug(glossaryIndex.glossary[key].label)}`;
}

/* ── 解析作者态源文件（搬运 build-lessons.js 224-240）────────────────────── */

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

/* ── escapeHtml / renderTermList（搬运 build-lessons.js 325-340）─────────── */

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderTermList(terms, glossaryIndex, file) {
  const keys = Object.keys(terms || {});
  if (!keys.length) throw new Error(`${file}: meta.terms 为空`);
  const missing = keys.filter((k) => !glossaryIndex.glossary[k]);
  if (missing.length) throw new Error(`${file}: meta.terms 里有未登记的名词 key：${missing.join(', ')}`);
  const items = keys.map(
    (k) => `        <li><a href="${termHref(glossaryIndex, k)}">${glossaryIndex.glossary[k].label}</a><span>${terms[k]}</span></li>`
  );
  return ['    <ul class="term-list">', ...items, '    </ul>'].join('\n');
}

/* ── renderPage 核心（搬运 build-lessons.js 342-412，改名 renderPage）────── */

export function renderPage(page, all, ctx) {
  const raw = ctx.frame;
  // 丢掉 _frame.html 顶部的说明注释：那是给维护者看的，不该出现在每一张课程页里。
  const frame = raw.slice(raw.indexOf('<!DOCTYPE'));
  const { meta, sections } = page;
  const glossaryIndex = ctx.glossaryIndex;
  const labels = ctx.labels;
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
    : `        <span style="color:var(--dsw-alias-label-secondary);font-weight:bold">${meta.nextPlaceholder || '下一课：待开课'}</span>`;

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
    PAGE_UP: pageUp,                          // 外壳里的 {{PAGE_UP}}assets/… 靠它改写（分层后深度不再是 1）
    PAGE_REL: `lessons/${page.rel}`,
    CIRCLE: page.halo,                        // §11：与课程包 tools/build-lessons.js 逐字对应（否则 render-parity 红）
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

  // 导航里"下一课"占位文字
  const nav = elByClass(text, 'nav-links');
  let nextPlaceholder = '';
  if (nav) {
    const sp = /<span[^>]*>([\s\S]*?)<\/span>/.exec(nav.text);
    if (sp) nextPlaceholder = sp[1].trim();
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
