/**
 * lib/unify/render.cjs — 课程页渲染的**唯一计算**（U07）
 * ==================================================================
 * 为什么住 `lib/unify/`（U-SPEC §5）：课程页渲染曾经有**两份逐字同源的实现** ——
 * 插件 `lib/render.js`（ESM）与课程包 `tools/build-lessons.js`（CJS），靠
 * `test/render-parity.mjs` 的"插件渲染 == CLI 渲染 == 磁盘产物"逐字节对拍钉住。
 * 对拍只能**发现**漂移，不能**防止**漂移；U 系列把它收成一份：
 *
 *   · 本文件 = 唯一手工源码（CommonJS；**纯函数** —— 不读磁盘、不读环境、不看时钟、不用随机）；
 *   · `lib/render.js` = ESM 适配层（导出面逐字保留；把宿主侧的三个能力**注入**进来）；
 *   · `lib/pack-template/tools/build-lessons.js` = 包侧 CLI 适配层（CLI / IO / 缓存全留着，
 *     只把渲染计算换成 `require('./unify/render.cjs')`）。
 *
 * 三条注入（不做第二份实现，也不写默认值兜底）：
 *   · `deps.labelAnchorId`      课次显示名 → 笔记页锚点 id（宿主 `lib/pack-model.js`、
 *                               包侧 `tools/lesson-map.js` 是既有的受控镜像对，由
 *                               `lib/pack-model.js --selftest` 对拍钉住。两处都已有实现，
 *                               在这里再写一份就是**第三份**）；
 *   · `deps.withStaticTitles`   h2/h3 静态流彩类（包侧 `tools/title-classes.js` 是**两个渲染器
 *                               共用**的一小段变换：build-lessons 与 build-notes 都要它，
 *                               所以它不能搬进这里 —— 搬了就会在包里长出第二份）；
 *   · `deps.stripStaticTitles`  它的反向（反向抽取用）。
 *   `ctx.shape`（图型 → DOM）本来就是注入的：`tools/shape-render.js` 是包侧执行代码，
 *   宿主也 require 它 —— 与上面三个是同一类"渲染子能力由适配层递进来"的边界。
 *   **缺注入就抛错**（`缺渲染依赖…`）：静默留白/静默降级正是这些契约要堵的洞。
 *
 * 语义基准（A01 已用改前快照逐字节钉住，见 `audit-evidence/U07/pre-change.json`）：
 *   · 渲染（`renderPage`）两侧改前**逐字节相同**，本内核 = 两者的公共部分，一个字都不许漂；
 *   · 反向抽取（`extractPage`）两侧改前**有分歧**：包侧吸收过 2026-09-24/25 的四个修复
 *     （`<h1 class=…>` 带属性、文件号取自文件名、`.term-list` 缺失不抛、段落收尾取
 *     nav/页脚/`</body>` 边界、`meta.halo/point` 从路径回填）。收成一份时**取产品侧语义**
 *     （`node tools/build-lessons.js --extract` 是真正在用的那条路；宿主那份搬运版连现行
 *     产物都抽不动）。宿主 `planExtract` 因此在这四处变了 —— Δ 登记在
 *     `docs/unify/receipts/U07.json`，并被 A01 用"改后 == 改前**包侧**字节"钉住。
 *
 * 纪律：本文件不许出现 `node:fs` / `process` / `Date` / `Math.random` / `__dirname` / `import`
 * （A04 有源码静态扫描 + 行为断言：篡改 `process.env` / 时钟 / 随机源之后，同输入同输出）。
 */
'use strict';

/** 知识点地图前沿的判据只有一份（U04 已交付的 `lib/unify/plan.cjs`）；本文件只 require。 */
const { planFrontier } = require('./plan.cjs');

/* ── 段名常量 ───────────────────────────────────────────────────────────── */
const SECTION_NAMES = ['style', 'objective', 'review', 'body', 'reading', 'challenges'];

/** 修饰后 title 的静态类名（与包侧 `tools/title-classes.js` 的 STATIC_CLASS 同一字面量） */
const STATIC_CLASS = 'rainbow-subtitle';

/* ── 抽取段落标题常量 ───────────────────────────────────────────────────── */
const H2_TERMS = '本课新名词';
const H2_READING = '推荐阅读';
const H2_CHALLENGE = '课后挑战';
const H2_ASK = '有疑问';

/** 定制层（coach）的三个**整行**占位符（P1-6 契约） */
const COACH_SLOTS = ['RECAP', 'NEXT', 'ASK'];

/* ── 依赖注入的守卫 ─────────────────────────────────────────────────────── */

/**
 * 取渲染依赖。缺一个就**明确失败**（A03：缺依赖如实失败，不许静默降级成空实现）。
 * @param {{deps?: object}|undefined} ctx
 * @param {string} where 报错时点名哪一页
 */
function renderDeps(ctx, where) {
  const deps = ctx && ctx.deps;
  const missing = ['labelAnchorId', 'withStaticTitles'].filter((k) => typeof (deps && deps[k]) !== 'function');
  if (missing.length) {
    throw new Error(`${where}: 缺渲染依赖 deps.${missing.join(' / deps.')} —— 渲染内核不读盘，也不自备第二份实现；`
      + '适配层（宿主 lib/render.js / 包侧 tools/build-lessons.js）必须把它注入进来');
  }
  return deps;
}

/** 取图型映射器（包侧执行代码 `tools/shape-render.js`，由适配层注入） */
function shapeOf(ctx, where) {
  const shape = ctx && ctx.shape;
  if (!shape || typeof shape.validateBlock !== 'function' || typeof shape.renderBlock !== 'function') {
    throw new Error(`${where}: 缺图型映射器 ctx.shape（validateBlock / renderBlock）—— 它是包侧执行代码，必须由适配层 require 后注入`);
  }
  return shape;
}

/* ── 图型（shape）管道 ─────────────────────────────────────────────────── */

/**
 * figureMap — 校验 meta.figures 数组，返回 id→figure Map。
 * 三条硬检查（任一不过就构建失败）：shape 合法 + 字段齐备 / id 不许缺 / id 不许重复。
 *
 * @param {object[]} figures `meta.figures`
 * @param {string} file 报错时点名的文件
 * @param {{validateBlock: Function}} shape 图型映射器
 */
function figureMap(figures, file, shape) {
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
function substituteFigures(html, byId, used, file, shape) {
  const figRe = /<!--\s*figure:\s*([A-Za-z0-9_-]+)\s*-->/g;
  if (!byId.size) {
    if (/<!--\s*figure:/.test(html)) throw new Error(`${file}: 正文里有 <!--figure:…--> 占位符，但 meta.figures 是空的`);
    return html;
  }
  return html.replace(figRe, (m, id) => {
    const b = byId.get(id);
    if (!b) throw new Error(`${file}: 引用了未声明的图型 <!--figure:${id}-->`);
    used.add(id);
    return shape.renderBlock(b);
  });
}

/** 页面的块序列（文字块 / 图型块交替）—— 给单调度体检用 */
function pageSequence(page) {
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

/* ── html helpers ──────────────────────────────────────────────────────── */

/** 平衡标签匹配：<div …> … </div>（支持任意标签名、嵌套） */
function balancedEl(src, start) {
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
function indexOfMarkup(src, marker, from = 0) {
  let at = src.indexOf(marker, from);
  while (at >= 0) {
    const inStyle = src.lastIndexOf('<style', at) > src.lastIndexOf('</style>', at);
    const inScript = src.lastIndexOf('<script', at) > src.lastIndexOf('</script>', at);
    if (!inStyle && !inScript) return at;
    at = src.indexOf(marker, at + 1);
  }
  return -1;
}

function elByClass(src, cls) {
  const at = indexOfMarkup(src, `class="${cls}"`);
  if (at < 0) return null;
  const tagStart = src.lastIndexOf('<', at);
  const { from, to } = balancedEl(src, tagStart);
  return { from, to, text: src.slice(from, to) };
}

/** <h2>…marker…</h2> 结束后的偏移 */
function afterH2(src, marker) {
  const at = indexOfMarkup(src, marker);
  if (at < 0) return -1;
  const m = src.indexOf('</h2>', at);
  return m < 0 ? -1 : m + '</h2>'.length;
}

/** <h2> 元素的起始偏移。切段必须切在标签之前，切在 marker 文字上会把 <h2> 劈成两半 */
function h2Start(src, marker) {
  const at = indexOfMarkup(src, marker);
  return at < 0 ? -1 : src.lastIndexOf('<h2', at);
}

function trimBlankLines(s) {
  const lines = s.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

/* ── glossary helpers ──────────────────────────────────────────────────── */

/**
 * buildGlossaryIndex — 从 GLOSSARY 对象构建索引
 *
 * @returns {{glossary: object, labelToKey: Record<string,string>, termCount: number}}
 */
function buildGlossaryIndex(glossary) {
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

/* ── 解析作者态源文件 ───────────────────────────────────────────────────── */

/** parseSource(text, file, shape) → { file, meta, sections, _figures, _usedFigures } */
function parseSource(text, file, shape) {
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

/* ── escapeHtml ────────────────────────────────────────────────────────── */
// 「本课新名词」清单的渲染函数 2026-09-24 两侧一起删了（包侧 build-lessons.js 同名那份同批）：
// 两处定义零调用、槽位表里从来没有它的键，且现行产物**明令禁止**正文出现 `.term-list`
// （课程包 tools/notes-card.test.mjs 闸门 3 的 STALE 清单里就写着它）——
// 笔记卡改版把清单搬进卡片时，函数忘了删。meta.terms 没删：封面卡的名词计数还在用它。

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── 末课导航的"下一课"占位 ─────────────────────────────────────────────── */

/**
 * 末课导航里的"下一课"占位（整行 span）。
 * ------------------------------------------------------------------
 * 判据（`01:204`「后续进展都遵循这张地图」）：**地图优先于手写的 meta.nextPlaceholder** ——
 *   · 地图前沿（plan.cjs 的 planFrontier）有下一课
 *     → 占位变真实课名 `下一课：${next.title}（待开课）`（title 逐字取地图原文），
 *     并给 span 打 `data-from-plan="1"` 标记；
 *   · 地图缺失 / 不合法 / 图上的课全建完（exhausted）→ **一个字都不改**，
 *     退回 `meta.nextPlaceholder || '下一课：待开课'`（不许编一个名字出来，也不许假装成功）。
 *
 * `data-from-plan="1"` 是给 extractPage 看的：那句是**地图派生的快照**，
 * 抓回 meta.nextPlaceholder 写进源文件就成了同一件事两份事实（源里一份快照、地图一份），
 * 而且每次 extract 都产生无意义 diff。手写的占位（没有标记）照旧回写 —— 手工能力保留。
 */
function nextPlaceholderSpan(meta, plan, displayNumbers) {
  const f = planFrontier(plan, displayNumbers);
  const fromPlan = Boolean(f.ok && f.next);
  const text = fromPlan ? `下一课：${f.next.title}（待开课）` : (meta.nextPlaceholder || '下一课：待开课');
  const mark = fromPlan ? ' data-from-plan="1"' : '';
  return `        <span${mark} style="color:var(--dsw-alias-label-secondary);font-weight:bold">${text}</span>`;
}

/* ── renderPage 核心 ───────────────────────────────────────────────────── */

/**
 * 渲染一张课程页。**纯函数**：所有外部数据（外壳 / 名词索引 / 标签 / 笔记计数 / 答疑 /
 * 图型映射器 / 定制层）都由 `ctx` 注入；`deps` 见文件头。
 *
 * ctx 形状：
 *   { frame, glossaryIndex, haloNames, noteCounts, qa, shape, coach?, deps }
 *   frame         = _frame.html 原始全文（本函数负责切掉 `<!DOCTYPE` 之前的维护者注释）
 *   glossaryIndex = buildGlossaryIndex(GLOSSARY) 的返回值
 *   haloNames     = Map，halo 标识 → 圆圈显示名（读不到就退回 halo id）
 *   noteCounts    = Map，键是课程显示名（page.label），值是整数
 *   qa            = QUESTIONS 对象，可能为 undefined → 缺失时按原语义降级成 0
 *   coach         = 定制层 {RECAP?, NEXT?, ASK?} → html；缺省 = 空定制层
 *   deps          = { labelAnchorId, withStaticTitles }（见文件头）
 *
 * @param {object} page 解析后的页对象（parseSource 的返回值 + rel/halo/point/plan/label/displayNumber）
 * @param {object[]} all 同一批页（导航只在同一 halo+point 内连）
 * @param {object} ctx 见上
 * @returns {string} 页面 HTML
 */
function renderPage(page, all, ctx) {
  const where = page && page.file ? page.file : '页面';
  const deps = renderDeps(ctx, where);
  const shape = shapeOf(ctx, where);
  const glossaryIndex = ctx.glossaryIndex;
  if (!glossaryIndex || typeof glossaryIndex !== 'object' || !glossaryIndex.glossary) {
    throw new Error(`${where}: 缺 ctx.glossaryIndex（buildGlossaryIndex 的返回值）—— 名词计数与 hintTerm 校验都靠它`);
  }
  const noteCounts = ctx.noteCounts;
  if (!noteCounts || typeof noteCounts.get !== 'function') {
    throw new Error(`${where}: 缺 ctx.noteCounts（Map：课程显示名 → 笔记条数）—— 封面卡的数字不许凭空编`);
  }

  const raw = String(ctx.frame == null ? '' : ctx.frame);
  // 丢掉 _frame.html 顶部的说明注释：那是给维护者看的，不该出现在每一张课程页里。
  const frame = raw.slice(raw.indexOf('<!DOCTYPE'));
  const { meta, sections } = page;
  const haloNames = ctx.haloNames;
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
  const fill = (html) => substituteFigures(html, page._figures || new Map(), used, page.file, shape);
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
    LESSON_ANCHOR: encodeURIComponent(deps.labelAnchorId(page.label)),
    PAGE_UP: pageUp,                          // 外壳里的 {{PAGE_UP}}assets/… 靠它改写（分层后深度不再是 1）
    PAGE_REL: `lessons/${page.rel}`,
    CIRCLE: page.halo,                        // §11：圆圈标识 —— assets/circle-bands.css 按 body[data-circle] 挑色带
    CIRCLE_NAME: (haloNames && haloNames.get(page.halo)) || page.halo,
    LESSON_ID: lessonKeyOf(page),
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
  // 第二趟（只认 {{PAGE_UP}}）—— 槽位内容里的占位符不会被第一趟重扫（JS 的 replace 不回头），
  // 而作者态内容里的相对链接（如 reading 里指向 reference/ 的速查表）必须跟着目录深度走。
  // 只放行这一个键：其余槽位归外壳独有，免得课程正文里恰好写出 {{TERM_COUNT}} 被悄悄替换掉。
  const assembled = filledFrame.replace(/\{\{PAGE_UP\}\}/g, () => String(slots.PAGE_UP));

  // ── 定制层（coach）注入（P1-6）──
  // 三个整行占位符必须都在 `_frame.html` 里，缺一个就报错（静默留白正是这条契约要堵的洞）；
  // 空 coach 时占位符整行消失（连同换行）⇒ 产物与"没有占位符"时逐字节相同。
  for (const slot of COACH_SLOTS) {
    if (!new RegExp(`^[ \\t]*<!--\\s*@WHALE:${slot}\\s*-->$`, 'm').test(frame)) {
      throw new Error(`${page.file}: _frame.html 缺整行占位符 <!-- @WHALE:${slot} --> —— 定制层不许静默缺席`);
    }
  }
  const coach = ctx.coach || {};
  const withCoach = assembled.replace(/^[ \t]*<!--\s*@WHALE:(RECAP|NEXT|ASK)\s*-->\r?\n?/gm, (m, k) => (coach[k] ? coach[k] + '\n' : ''));

  // 第三趟（§3，2026-09-21）：给**没有 class** 的 h2/h3 补静态流彩类 —— 注入的
  // withStaticTitles 与课程包 `tools/title-classes.js` 是同一份实现（build-notes 也用它）。
  // 只有 h2/h3：h1 的类写在 _frame.html 模板里，h4 不上（段内小标题太密）。
  // 正文里讲 HTML 的代码块是 `&lt;h2&gt;` 转义过的，所以不会被误伤（也正因如此不能先 unescape）。
  return deps.withStaticTitles(withCoach);
}

/**
 * 课次键（`point/NNNN`，**页面域**写法）—— coach 台账与页面槽位共用。
 * 页面域的键保持两段（决-11：build-lessons.js / render.cjs 输出不动）；运行态身份是
 * `circle/point/NNNN`，两者在 `lib/verify.js` 里显式搭桥比对，不在这里混用。
 */
function lessonKeyOf(page) {
  return `${page.point}/${String(page.meta.number).padStart(4, '0')}`;
}

/* ── 抽取：已有课程页 → 源文件 ──────────────────────────────────────────── */

/**
 * 反向抽取（产物页 → 作者态源文件）。语义 = **产品侧**（见文件头"语义基准"）。
 *
 * @param {string} text 产物页全文
 * @param {string} file 产物页路径（用于文件名/归属推导，报错也点它）
 * @param {Record<string,string>} navTitles 从别的页反查出来的课次短标题
 * @param {{labelToKey: Record<string,string>}} glossaryIndex 名词反查
 * @param {{stripStaticTitles: Function}} deps 见文件头
 */
function extractPage(text, file, navTitles, glossaryIndex, deps) {
  if (!deps || typeof deps.stripStaticTitles !== 'function') {
    throw new Error(`${file}: 缺渲染依赖 deps.stripStaticTitles —— 反向抽取要剥掉生成侧加的静态流彩类（适配层注入）`);
  }
  if (!glossaryIndex || typeof glossaryIndex.labelToKey !== 'object') {
    throw new Error(`${file}: 缺 glossaryIndex.labelToKey —— 名词清单反查要用它`);
  }
  // 先反剥生成侧加的**静态流彩类** —— 抽取是它的反向操作：不剥的话写回源文件就会凭空
  // 多出一个类，而源文件里本来没有。
  text = deps.stripStaticTitles(text);
  // <h1> 带属性（现行产物是 `<h1 class="rainbow-title">`），所以标签名后面必须放 `[^>]*`
  // 吃掉属性 —— 写死 `<h1>` 就永远匹配不到。
  const h1 = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) throw new Error(`${file}: 找不到 <h1>`);
  const numM = h1[1].match(/第\s*(\d+)\s*课/);
  if (!numM) throw new Error(`${file}: <h1> 里找不到"第N课"`);
  // 文件号从**文件名**取（`NNNN-*.html`）—— 与 h1 那句「第N课」**不是一回事**：
  // vue 的 fileBase=1000 ⇒ 文件是 1001、页面写「Vue 第1课」。从 h1 取会抽成 1，
  // 写回源文件就把课号改错了（真源是 number:1001）。h1 那句只用来校验页面形状。
  const base = basenameOf(file);
  const fileNumM = /^(\d{4})-/.exec(base);
  const number = fileNumM ? Number(fileNumM[1]) : Number(numM[1]);
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

  // 名词清单：链接文字 → key（按 label 反查），<span> 是助记。
  // 2026-09-24 清单渲染器两侧删净后，**产物里已经零 `.term-list`** —— 这里改成 optional：
  // 有就照旧解析回 meta.terms，没有就留空（硬要求它 = 永远抛，抽取一跑就死）。
  const terms = {};
  const ulAt = indexOfMarkup(text, 'class="term-list"');
  const ulBal = ulAt < 0 ? null : balancedEl(text, text.lastIndexOf('<', ulAt));
  const ul = ulBal ? text.slice(ulBal.from, ulBal.to) : '';
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
  // 收尾边界候选（都在页面末尾）：nav / 页脚 / </body>。
  // ⚠️ 取的时候必须**限定在段起点之后** —— 顶栏 nav、更早的「参考：」链接都会落在段起点**之前**，
  //    取全页最早那个会把边界取到段前面去（第一版就这么错了，0002 页当场报"边界反了"）。
  const tailBounds = [nav ? nav.from : -1, footerM.index, text.indexOf('</body>')].filter((v) => v >= 0);
  const askDiv = ask ? ask.from : text.length;

  const pTerms = h2Start(text, H2_TERMS);
  const pReading = h2Start(text, H2_READING);
  const pChallenge = h2Start(text, H2_CHALLENGE);
  const pAsk = h2Start(text, H2_ASK);

  /** 从 pos 之后，最近的另一个段落起点；都没有就取**在 pos 之后**的收尾边界。
   *
   *  ⚠️ 兜底为什么不能是 `text.length`（2026-09-25 修）：`ask-guide` 区块自 2026-09-24 起
   *  **已不在产物里** ⇒ 兜底退化成「一路吞到 EOF」：practice-zone / nav-links / 页脚 /
   *  一堆 `<script>` / `</body></html>` 全被吃进最后一段 —— **不抛，但产物不能用**。 */
  const stopAfter = (pos, others) => {
    const rest = others.filter((p) => p > pos).sort((a, b) => a - b);
    if (rest.length) return rest[0];
    const tail = [askDiv, ...tailBounds].filter((b) => b > pos).sort((a, b) => a - b)[0];
    return tail !== undefined ? tail : text.length;
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

  // halo / point 从**路径**取（页面就住在 `lessons/<圆圈>/<知识点>/NNNN-*.html` 下）。
  // 抽取器原来不产出它们 ⇒ 写回源文件就丢了归属，而真源里这两个字段是有的。
  // 路径不够深（老布局 / 平铺页）就不写这两个键 —— 宁缺勿错。
  const seg = String(file).split(/[\\/]/);
  const li = seg.lastIndexOf('lessons');
  const haloPoint = (li >= 0 && seg.length - li >= 4) ? { halo: seg[li + 1], point: seg[li + 2] } : {};

  return {
    file: base,
    meta: {
      title,
      number,
      navTitle: navTitles[base] || title,
      hintTerm,
      askLead,
      ...haloPoint,
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

/** 文件名的最后一段（POSIX / Windows 分隔符都认；不引 fs/process） */
function basenameOf(file) {
  const seg = String(file).split(/[\\/]/);
  return seg[seg.length - 1];
}

/** 从别的页面的导航里反查本课的短标题 */
function collectNavTitles(pages) {
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

function serializeSource(page) {
  const meta = JSON.stringify(page.meta, null, 2).replace(/^\uFEFF/gm, '');
  const out = ['<script type="application/json" data-lesson-meta>', meta, '</script>', ''];
  for (const name of SECTION_NAMES) {
    if (name === 'style') continue;
    const body = page.sections[name];
    if (!body) continue;
    out.push(`<!--@${name}-->`, body, `<!--/@${name}-->`, '');
  }
  return out.join('\n');
}

/* ── 内联样式合并成共享 CSS ─────────────────────────────────────────────── */

const BLOCKS_HEADER = (count) => [
  '/* assets/lesson-blocks.css — 课程页共享块样式',
  ' *',
  ' * 由 node tools/build-lessons.js --extract 从各课程页的内联 <style> 合并而来。',
  ' * 以前每课在自己的 <style> 里各写一份（.term-list、.real-path 甚至两页重复定义），',
  ' * 改一处漏一处就会两页样式不一致。现在只有这一份。',
  ' *',
  ' * 规则：只允许用 theme.css 的令牌，不写死颜色（check-terms.js 会查）。',
  ` * 含 ${count} 条规则。`,
  ' */',
  '',
].join('\n');

/**
 * 合并算法（**只算**，不打印、不写盘）：同名选择器只留第一份，冲突单独列出来。
 * @param {{file: string, css: string}[]} styles
 * @returns {{rules: {sel: string, body: string, file: string}[], conflicts: {sel: string, kept: string, file: string}[]}}
 */
function mergeBlockRules(styles) {
  const seen = new Map();
  const conflicts = [];
  for (const { file, css } of styles) {
    for (const m of String(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].replace(/\s+/g, ' ').trim();
      const body = m[2].trim();
      if (!sel) continue;
      if (seen.has(sel)) {
        if (seen.get(sel).body !== body) conflicts.push({ sel, kept: seen.get(sel).file, file });
        continue;
      }
      seen.set(sel, { sel, body, file });
    }
  }
  return { rules: [...seen.values()], conflicts };
}

/** 规则表 → lesson-blocks.css 全文（头注释 + 每条规则四空格缩进） */
function formatBlocks(rules) {
  const body = [...rules]
    .map((r) => `${r.sel} {\n${r.body.split('\n').map((l) => (l.trim() ? '    ' + l.trim() : l)).join('\n')}\n}`)
    .join('\n\n');
  return `${BLOCKS_HEADER(rules.length)}\n${body}\n`;
}

/**
 * 把各页内联样式合并成一份共享 CSS。**只做计算，不写盘** —— 落盘在适配层。
 * 冲突照旧打告警（原样沿用 `[build-lessons] ⚠️ 选择器 …` 那句文案）。
 *
 * @param {{file: string, css: string}[]} styles
 * @param {{warn?: (msg: string) => void}} [opts] 告警出口；缺省 console.warn
 */
function mergeBlocks(styles, opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : (msg) => console.warn(msg);
  const { rules, conflicts } = mergeBlockRules(styles);
  for (const c of conflicts) warn(`[build-lessons] ⚠️ 选择器 ${c.sel} 在 ${c.kept} 与 ${c.file} 里定义不同，保留前者`);
  return formatBlocks(rules);
}

module.exports = {
  SECTION_NAMES,
  STATIC_CLASS,
  figureMap,
  substituteFigures,
  pageSequence,
  balancedEl,
  indexOfMarkup,
  elByClass,
  afterH2,
  h2Start,
  trimBlankLines,
  buildGlossaryIndex,
  parseSource,
  escapeHtml,
  nextPlaceholderSpan,
  renderPage,
  extractPage,
  collectNavTitles,
  serializeSource,
  mergeBlockRules,
  formatBlocks,
  mergeBlocks,
};
