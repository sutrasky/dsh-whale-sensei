#!/usr/bin/env node
/**
 * build-lessons.js — 课程页构建器
 *
 * 课程页的"外壳"（head、样式表、theme-boot、名词引导条、新名词清单、导航、页脚、
 * 尾部脚本）每课都一模一样。手写一遍就是每课白花 ~3,500 token，还会抄错
 * （比如页面上写"全部 50 个名词"，数据源里其实有 60 个）。
 *
 * 这个脚本把外壳固定成 assets/_frame.html，作者只写 5 段内容。
 *
 * 用法：
 *   node tools/build-lessons.js                 构建 lessons/src/*.html → lessons/*.html
 *   node tools/build-lessons.js --check         构建到内存并与磁盘比对，有漂移就非零退出
 *   node tools/build-lessons.js --extract <页面…>  把已有课程页反向拆成 lessons/src/ 源文件
 *   node tools/build-lessons.js --extract --no-blocks  同上，但不动 lesson-blocks.css
 *
 * 零依赖。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'lessons', 'src');
const OUT_DIR = path.join(ROOT, 'lessons');
const ASSETS = path.join(ROOT, 'assets');
const FRAME_PATH = path.join(ASSETS, '_frame.html');
const BLOCKS_PATH = path.join(ASSETS, 'lesson-blocks.css');

/* ── 技能包守卫：缺课程数据时响亮跳过 ────────────────────────────────────── */
if (!fs.existsSync(path.join(ASSETS, 'questions-data.js'))) {
  console.log('=== 跳过：本目录没有 assets/questions-data.js（技能包只带引擎，课程数据由使用者创建）===');
  console.log('⚠️ 这是「跳过」，不是「通过」。在有课程数据的课程包根跑才有意义。');
  process.exit(0);
}

const GLOSSARY = require(path.join(ASSETS, 'glossary-data.js'));
const QUESTIONS = require(path.join(ASSETS, 'questions-data.js'));
const SHAPE = require('./shape-render.js');   // shape → 图型 DOM 的确定性映射器
const { withStaticTitles } = require('./title-classes.js');   // §3：h2/h3 静态流彩类
// 知识点地图（大纲）前沿：判据只在 plan-map.js 那一份里（= 插件 lib/plan.js 的镜像，两边对拍钉住），这里只 require、不重写
const { planFrontier } = require(path.join(__dirname, 'plan-map.js'));

const SECTION_NAMES = ['style', 'objective', 'review', 'body', 'reading', 'challenges'];

/* ── 图型（shape）管道 ──────────────────────────────────────────────────────
 * 数据在哪：源文件的 front-matter（`<script data-lesson-meta>` 里的 `figures` 数组）。
 * 怎么用：正文里写 `<!--figure:<id>-->` 占位符，构建时替换成映射器渲染的图型 DOM。
 * 为什么这样：**同一份数据每次生成都长成同一个结构** —— 图型不再由每次生成自由发挥。
 * 三条硬检查（任一不过就构建失败）：
 *   ① shape 合法 + 字段齐备（映射器的 validateBlock）
 *   ② 占位符必须已声明、声明必须被引用（不许悬空，也不许声明了不用）
 *   ③ id 不许重复
 */
const FIG_RE = /<!--\s*figure:\s*([A-Za-z0-9_-]+)\s*-->/g;
const FIG_ANY = /<!--\s*figure:/;

function figureMap(figures, file) {
  const byId = new Map();
  (figures || []).forEach((b, i) => {
    const errs = SHAPE.validateBlock(b, i);
    if (errs.length) throw new Error(`${file}: figures 第 ${i + 1} 项 —— ${errs.map((e) => `[${e.code}] ${e.msg}`).join('; ')}`);
    if (!b.id) throw new Error(`${file}: figures 第 ${i + 1} 项缺少 id`);
    if (byId.has(b.id)) throw new Error(`${file}: figures 里 id 重复：${b.id}`);
    byId.set(b.id, b);
  });
  return byId;
}

/** 把某个片段里的占位符替换成图型 DOM（顺带记下用过的 id） */
function substituteFigures(html, byId, used, file) {
  if (!byId.size) {
    if (FIG_ANY.test(html)) throw new Error(`${file}: 正文里有 <!--figure:…--> 占位符，但 meta.figures 是空的`);
    return html;
  }
  return html.replace(FIG_RE, (m, id) => {
    const b = byId.get(id);
    if (!b) throw new Error(`${file}: 引用了未声明的图型 <!--figure:${id}-->`);
    used.add(id);
    return SHAPE.renderBlock(b);
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

/** 构建期打印单调度体检（**先报告、不上闸**） */
function auditPages(pages) {
  const rows = pages.map((p) => ({
    id: `${p.label} ${p.meta.navTitle || p.meta.title || ''}`.trim(),
    blocks: pageSequence(p),
    // 内容匹配要用页面正文字（映射器会剥掉 HTML 标签）
    text: ['objective', 'review', 'body', 'reading', 'challenges'].map((n) => p.sections[n] || '').join('\n'),
    // 使用者已经拍板"保持纯文本"的知识点：写进 front-matter，构建时不再重复问
    optOut: (p.meta && p.meta.shapeOptOut) || [],
  }));
  const report = SHAPE.audit(rows);
  if (!report.length) return;
  console.log('\n[audit] 单调度体检（报告，不上闸）');
  console.log('  选型顺序：先按内容形态匹配（代码/技术内容尤其）→ 再考虑交互/练习 → 防单调只是兜底');
  for (const r of report) {
    console.log(`  ${r.ok ? '✅' : '▫️'} ${r.page}：${r.total} 块 · 结构 ${r.structureRatio}% / 纯文本 ${r.textRatio}%${r.notes.length ? ' → ' + r.notes.join('；') : ''}`);
    if (r.content && r.content.length) {
      console.log(`      内容形态候选：${r.content.map((c) => `${c.shape}(${c.score})`).join(' / ')}`);
      if (r.missing) {
        console.log(`      其中本页还没有的：${r.missing.length ? r.missing.map((c) => c.shape).join(' / ') : '（候选形态本页都已有）'}`);
      }
    }
    // 第 4 级兜底：内容无信号 + 结构单调 → 不擅自加图，列出来由使用者拍板
    if (r.asks && r.asks.length) {
      console.log(`      待你拍板（内容无信号 + 结构单调：${r.asks[0].reason.join(' / ')}）：`);
      for (const a of r.asks) {
        console.log(`        · 「${a.point}」→ 用 ${a.candidates.join(' / ')}，或保持纯文本`);
      }
    }
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖。
 *
 * 为什么不直接用 writeFileSync —— 它**先截断、再写**。浏览器要是在这个窗口里读那一页，
 * 拿到的就是空文件或半截文件：链不到样式表，页面渲染成没有样式的「纯文本」。
 * 这不是假想：2026-09-17 学生那边真的看到第2课变成纯文本，正是构建与刷新撞上了。
 */
function writeAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/* ── html helpers ───────────────────────────────────────────────────────── */

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

/* ── glossary (必须与 build-glossary.js 保持一致) ───────────────────────── */

function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const LABEL_TO_KEY = {};
for (const [k, v] of Object.entries(GLOSSARY)) LABEL_TO_KEY[v.label] = k;

const TERM_COUNT = Object.keys(GLOSSARY).length;
const termHref = (key) => `../GLOSSARY.md#${slug(GLOSSARY[key].label)}`;

/* ── 解析作者态源文件 ───────────────────────────────────────────────────── */

function parseSource(text, file) {
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
  const figures = figureMap(meta.figures, file);
  return { file, meta, sections, _figures: figures, _usedFigures: new Set() };
}

/* ── 源文件扫描 ──────────────────────────────────────────────────────────────
 * 支持两种布局，输出路径一律 = 源文件的相对路径（lessons/<rel>）：
 *   ① 「圆圈 / 知识点 / 课程」三层： lessons/src/programming/spring-boot/0001-*.html
 *   ② 历史平铺：                   lessons/src/0001-*.html  → lessons/0001-*.html（逐字节同旧行为）
 * 混用两种层级会**报错**（页面里回到根目录的相对前缀由层级推出，混用必错）。
 */
const LEGACY_HALO = 'programming';
const LEGACY_POINT = 'spring-boot';
/** 页面所在目录回到课程包根的前缀。由源文件层级推出，不手工维护。 */
let PAGE_UP = '../';

function walkSrc(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkSrc(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * 知识点的显示信息：lessons/<halo>/<point>/point.json 的 label、fileBase 与 plan（地图）。
 * label 空串 = 不前缀（显示「第N课」）；fileBase 是编号折算基准
 * （Vue 轨 fileBase 1000 → 文件号 1001 显示「Vue 第1课」）；
 * plan 是这个知识点的地图（goal + nodes），末课的"下一课"占位要用它派生真实课名。
 */
function pointInfo(halo, point) {
  const f = path.join(OUT_DIR, halo, point, 'point.json');
  if (!fs.existsSync(f)) return { label: '', fileBase: 0, plan: undefined };
  let d;
  try {
    d = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`${halo}/${point}/point.json 不是合法 JSON —— ${e.message}`);
  }
  return { label: d.label || '', fileBase: Number(d.fileBase) || 0, plan: d.plan };
}

/**
 * 圆圈的显示名：lessons/<halo>/halo.json 的 name（如 programming → 「编程」）。
 * 用途：页脚不许写死某一个知识点的名字 —— 写死了 Vue 课的页脚就会印成
 * 「Spring Boot 教学课程 | Vue 第1课」（2026-09-23 修；判据见 tools/check-lesson-content.js 的 R4）。
 * 读不到就退回圆圈 id，绝不编一个名字出来。
 */
function haloName(halo) {
  const f = path.join(OUT_DIR, halo, 'halo.json');
  if (!fs.existsSync(f)) return halo;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return d.name || halo;
  } catch {
    return halo;
  }
}

function loadSources() {
  const { displayNumberOf } = require(path.join(__dirname, 'lesson-map.js'));
  if (!fs.existsSync(SRC_DIR)) return [];
  const pages = walkSrc(SRC_DIR).map((rel) => {
    const base = rel.split('/').pop();
    // 旧实现用 /^\d{4}-/ 过滤：不合规的文件**静默消失**。这里改成直接报错。
    if (!/^\d{4}-.*\.html$/.test(base)) {
      throw new Error(`lessons/src/${rel}：文件名必须形如 NNNN-*.html（旧实现会静默跳过，所以这里直接报错）`);
    }
    const parts = rel.split('/');
    const page = parseSource(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'), base);
    // 真相顺序：**路径优先**（lessons/src/<圆圈>/<知识点>/NNNN-*.html），
    // meta 里的 halo / point 可以覆盖 —— 给测试桩与迁移期用（如星图增删查改的实验圈）。
    const halo = page.meta.halo || (parts.length >= 3 ? parts[0] : LEGACY_HALO);
    const point = page.meta.point || (parts.length >= 3 ? parts[1] : LEGACY_POINT);
    page.rel = rel;
    page.halo = halo;
    page.point = point;
    const { label, fileBase, plan } = pointInfo(halo, point);
    // 文件号是**内部 ID**（两轨不能撞号），显示号要按 fileBase 折算 ——
    // 规则只有一份实现，在 lesson-map.js（插件侧镜像在 lib/pack-model.js，两边对拍钉住）
    page.fileBase = fileBase;
    page.plan = plan;   // 知识点地图（point.json 的 plan）——末课"下一课"占位从它派生真实课名
    page.displayNumber = displayNumberOf(page.meta.number, fileBase);
    page.label = label ? `${label} 第${page.displayNumber}课` : `第${page.displayNumber}课`;
    return page;
  });
  const depths = new Set(pages.map((p) => p.rel.split('/').length - 1));
  if (depths.size > 1) {
    throw new Error(`源文件层级混用（${[...depths].sort().join(' 与 ')} 层）—— 平铺与分层不能同时存在，统一后再构建`);
  }
  PAGE_UP = '../'.repeat([...depths][0] + 1);
  return pages.sort((a, b) => a.rel.localeCompare(b.rel));
}

/* ── 笔记数据（封面卡三个数字）─────────────────────────────────────────── */

const NOTES_DIR = path.join(ROOT, 'notes');
const NOTES_JSONL = path.join(NOTES_DIR, 'notes.jsonl');
// 课次映射表：包侧唯一一份（`tools/lesson-map.js`），与插件 `lib/pack-model.js` 有一道对拍钉住
const { lessonMap, labelOfAnchor } = require(path.join(__dirname, 'lesson-map.js'));
const LESSON_MAP = lessonMap(ROOT);
// 逐行剥 BOM（坑位见 tools/pack-text.js）—— 不剥的话带 BOM 的那一行会被静默丢成 0 条
const { splitLines: splitNoteLines } = require(path.join(__dirname, 'pack-text.js'));

/** 读取 notes/notes.jsonl 里属于某课的笔记条数
 *  台账的 `anchor` 是**星图课次键**（写入口归一化）→ 反推只经 labelOfAnchor */
function countNotes(lesson) {
  try {
    const lines = splitNoteLines(fs.readFileSync(NOTES_JSONL, 'utf8')).filter((l) => l.trim());
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((n) => n && labelOfAnchor(n.anchor, LESSON_MAP) === lesson).length;
  } catch {
    return 0;
  }
}

/** 某课已解答的答疑条数 */
function countQA(lesson) {
  return Object.values(QUESTIONS).filter((q) => q.lesson === lesson && q.status === 'answered' && q.answerHtml).length;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── 渲染 ───────────────────────────────────────────────────────────────── */

function renderTermList(terms, file) {
  const keys = Object.keys(terms || {});
  if (!keys.length) throw new Error(`${file}: meta.terms 为空`);
  const missing = keys.filter((k) => !GLOSSARY[k]);
  if (missing.length) throw new Error(`${file}: meta.terms 里有未登记的名词 key：${missing.join(', ')}`);
  const items = keys.map(
    (k) => `        <li><a href="${termHref(k)}">${GLOSSARY[k].label}</a><span>${terms[k]}</span></li>`
  );
  return ['    <ul class="term-list">', ...items, '    </ul>'].join('\n');
}

/**
 * 末课导航里的"下一课"占位（整行 span）。
 * ------------------------------------------------------------------
 * 判据（`01:204`「后续进展都遵循这张地图」）：**地图优先于手写的 meta.nextPlaceholder** ——
 *   · 地图前沿（plan-map.js 的 planFrontier，判据只在那一份里）有下一课
 *     → 占位变真实课名 `下一课：${next.title}（待开课）`（title 逐字取地图原文），
 *     并给 span 打 `data-from-plan="1"` 标记；
 *   · 地图缺失 / 不合法 / 图上的课全建完（exhausted）→ **一个字都不改**，
 *     退回 `meta.nextPlaceholder || '下一课：待开课'`（不许编一个名字出来，也不许假装成功）。
 *
 * `data-from-plan="1"` 是给 --extract 看的：这句是**地图派生的快照**，
 * 抓回 meta.nextPlaceholder 写进源文件就成了同一件事两份事实（源里一份快照、地图一份），
 * 而且每次 extract 都产生无意义 diff。手写的占位（没有标记）照旧回写 —— 手工能力保留。
 *
 * 插件侧镜像：`lib/render.js` 的同名函数（两边由 test/render-parity.mjs 逐字节对拍）。
 */
function nextPlaceholderSpan(meta, plan, displayNumbers) {
  const f = planFrontier(plan, displayNumbers);
  const fromPlan = Boolean(f.ok && f.next);
  const text = fromPlan ? `下一课：${f.next.title}（待开课）` : (meta.nextPlaceholder || '下一课：待开课');
  const mark = fromPlan ? ' data-from-plan="1"' : '';
  return `        <span${mark} style="color:var(--dsw-alias-label-secondary);font-weight:bold">${text}</span>`;
}

function render(page, all) {
  const raw = fs.readFileSync(FRAME_PATH, 'utf8');
  // 丢掉 _frame.html 顶部的说明注释：那是给维护者看的，不该出现在每一张课程页里。
  const frame = raw.slice(raw.indexOf('<!DOCTYPE'));
  const { meta, sections } = page;
  // 导航只在**同一个知识点**内连 —— 知识圆圈里分叉的树枝各走各的，不串成一条长链
  const group = all.filter((p) => p.halo === page.halo && p.point === page.point);
  const gi = group.indexOf(page);
  const prev = gi > 0 ? group[gi - 1] : null;
  const next = gi >= 0 && gi + 1 < group.length ? group[gi + 1] : null;

  const navPrev = prev
    ? `        <a href="${prev.file}">← ${prev.label}：${prev.meta.navTitle}</a>`
    : `        <a href="${PAGE_UP}MISSION.md">← 课程目标</a>`;
  const navNext = next
    ? `        <a href="${next.file}">${next.label}：${next.meta.navTitle} →</a>`
    : nextPlaceholderSpan(meta, page.plan, group.map((p) => p.displayNumber));

  const pageStyle = sections.style
    ? `    <style>\n${sections.style}\n    </style>`
    : '';

  // 图型替换：正文各段里的 <!--figure:id--> → 映射器产出的 DOM
  const used = page._usedFigures || new Set();
  const fill = (html) => substituteFigures(html, page._figures || new Map(), used, page.file);
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
    PAGE_UP,                                  // 外壳里的 {{PAGE_UP}}assets/… 靠它改写（分层后深度不再是 1）
    PAGE_REL: `lessons/${page.rel}`,
    CIRCLE: page.halo,                        // §11：圆圈标识 —— assets/circle-bands.css 按 body[data-circle] 挑色带
    CIRCLE_NAME: haloName(page.halo),         // 页脚用：圆圈显示名（不写死某个知识点）
    LESSON_ID: `${page.point}/${String(meta.number).padStart(4, '0')}`,
    STARMAP_HREF: `${PAGE_UP}starmap/`,
    FILE: page.file,
    PAGE_STYLE: pageStyle,
    OBJECTIVE: filled.objective,
    REVIEW: filled.review,
    HINT_TERM: meta.hintTerm,
    HINT_TERM_LABEL: GLOSSARY[meta.hintTerm] ? GLOSSARY[meta.hintTerm].label : meta.hintTerm,
    TERM_COUNT: TERM_COUNT,
    BODY: filled.body,
    READING: filled.reading,
    CHALLENGES: filled.challenges,
    NAV_PREV: navPrev,
    NAV_NEXT: navNext,
    SOURCE_URL: meta.source.url,
    SOURCE_LABEL: meta.source.label,
    COVER_TERM_COUNT: Object.keys(meta.terms || {}).length,
    COVER_QA_COUNT: countQA(lesson),
    COVER_NOTE_COUNT: countNotes(lesson),
  };

  if (meta.hintTerm && !GLOSSARY[meta.hintTerm]) {
    throw new Error(`${page.file}: meta.hintTerm "${meta.hintTerm}" 未在 glossary-data.js 登记`);
  }

  const filledFrame = frame.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in slots)) throw new Error(`${page.file}: _frame.html 里的 {{${key}}} 没有对应实现`);
    return String(slots[key]);
  });
  // 第二趟，**只认 {{PAGE_UP}}**：槽位内容里的占位符不会被第一趟重扫（JS 的 replace 不回头），
  // 而作者态内容里的相对链接（如 reading 里指向 reference/ 的速查表）必须跟着目录深度走。
  // 只放行这一个键：其余槽位归外壳独有，免得课程正文里恰好写出 {{TERM_COUNT}} 被悄悄替换掉。
  const assembled = filledFrame.replace(/\{\{PAGE_UP\}\}/g, () => String(slots.PAGE_UP));
  // §3（2026-09-21）：h2/h3 直接静态上色（h1 的类写在 _frame.html 里；h4 不上）。
  // 这一趟改的是**生成物**，所以插件侧 lib/render.js 必须同步 —— 两边由 render-parity 逐字节对拍。
  return withStaticTitles(assembled);
}

/* ── 抽取：已有课程页 → 源文件 ─────────────────────────────────────────── */

const H2_TERMS = '本课新名词';
const H2_READING = '推荐阅读';
const H2_CHALLENGE = '课后挑战';
const H2_ASK = '有疑问';

function extractPage(text, file, navTitles) {
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
    const key = LABEL_TO_KEY[label];
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

  return {
    file: path.basename(file),
    meta: {
      title,
      number,
      navTitle: navTitles[path.basename(file)] || title,
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

/** 把各页内联样式合并成一份共享 CSS（同名选择器只留第一份） */
function emitBlocks(styles) {
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
  writeAtomic(BLOCKS_PATH, `${header}\n${body}\n`);
}

/* ── main ───────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const extractIdx = argv.indexOf('--extract');
const noBlocks = argv.includes('--no-blocks');

if (extractIdx >= 0) {
  const pages = argv.slice(extractIdx + 1).filter((a) => !a.startsWith('--'));
  if (!pages.length) {
    console.error('用法：node tools/build-lessons.js --extract lessons/0001-*.html [更多页面…]');
    process.exit(1);
  }
  const loaded = pages.map((p) => ({ file: p, text: fs.readFileSync(p, 'utf8') }));
  const navTitles = collectNavTitles(loaded);
  fs.mkdirSync(SRC_DIR, { recursive: true });

  const styles = [];
  for (const p of loaded) {
    const page = extractPage(p.text, p.file, navTitles);
    const outPath = path.join(SRC_DIR, page.file);
    writeAtomic(outPath, serializeSource(page));
    styles.push({ file: page.file, css: page._inlineStyle });
    const chars = Object.values(page.sections).reduce((n, s) => n + s.length, 0);
    console.log(`[extract] ${path.relative(ROOT, outPath)}  ← ${page.file}（正文 ${chars} 字符）`);
  }
  if (!noBlocks) {
    emitBlocks(styles.filter((s) => s.css.trim()));
    console.log(`[extract] ${path.relative(ROOT, BLOCKS_PATH)} 已合并 ${styles.length} 页的内联样式`);
  }
  console.log('[extract] 完成。现在运行 node tools/build-lessons.js 重建课程页。');
  process.exit(0);
}

/* 没有课程源（技能包只带引擎、或新课还没写）→ **响亮地跳过**，而不是报"忘了构建"退出 1。
   与其他工具**同一约定**（build-notes / shape-pipeline / strip-emoji / notes-card）：
   措辞要能被一眼认成"跳过，不是通过"。
   2026-09-24 改：原先这里是 `exit(1)`。后果是**新建的包每建一个圈都会弹一条
   "产物可能是旧的"** —— 建圈链里正串着本脚本，于是那条告警天天误报，把真正的失败淹掉。 */
const all = loadSources();
if (!all.length) {
  console.log(`=== 跳过：本目录没有课程源（${path.relative(ROOT, SRC_DIR)}/*.html）—— 技能包只带引擎，课程数据由使用者创建 ===`);
  console.log('⚠️ 这是「跳过」，不是「通过」。在有课程源的课程包根跑才有意义。');
  process.exit(0);
}

/* ---------- S4 主题合成：templates/contract.css + 当前预设 → assets/theme.css ----------
   换预设只改这一个产物，组件 CSS 一字不动。--check 会把"换过预设忘了重建"当场抓出来。 */
const styleAdapter = require('./style-adapter.js');
const themeRes = styleAdapter.sync({ checkOnly, log: (line) => console.log(line) });
const themeDrift = themeRes.drift ? 1 : 0;

let drift = 0;
for (const page of all) {
  const html = render(page, all);
  const outPath = path.join(OUT_DIR, page.rel);
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;

  if (checkOnly) {
    if (existing === html) {
      console.log(`[check] ✅ ${page.file}`);
    } else {
      drift++;
      console.log(`[check] ❌ ${page.file} —— 磁盘上的文件与构建结果不一致（忘了构建，或手改了生成物）`);
    }
    continue;
  }
  writeAtomic(outPath, html);
  console.log(`[build] ${page.file}  ${html.length} 字符${existing === html ? '（无变化）' : ''}`);
}

/* 单调度体检（**报告，不上闸**）：构建和 --check 都打印，攒够数据再考虑上闸 */
auditPages(all);

if (checkOnly && (drift || themeDrift)) {
  console.error(`[check] 漂移：页面 ${drift} 个 · 主题产物 ${themeDrift} 个。运行 node tools/build-lessons.js 修复。`);
  process.exit(1);
}

/* ---------- S2 风格断言（档位 B · 2026-09-19）----------
   五条：禁裸色值 / 令牌完备 / 对比度分级 / 跨页一致 / 封禁 {{PAGE_STYLE}} + 内联只许引用令牌。
   存量债务走 tools/style-check.js 里的 BASELINE（只减不增）。单跑： node tools/style-check.js */
if (checkOnly) {
  const styleCheck = require('./style-check.js');
  const okStyle = styleCheck.runChecks({ root: ROOT, log: (line) => console.log(line) });
  if (!okStyle) {
    console.error('[check] 风格断言未通过（详见上方）。单跑： node tools/style-check.js');
    process.exit(1);
  }
}

/* ---------- 星图数据跟着课程一起重建 ----------------------------------------
   为什么挂在这里：以前加一课要跑**两条**命令（build-lessons + build-starmap），
   全靠人记得 —— 迟早出现"课加了、星图没更新"。现在重建是一步。
   --check 模式下同样带 --check，所以漂移也会在这里红。 */
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build-starmap.js'), ...(checkOnly ? ['--check'] : [])], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[build] 星图数据未同步（详见上方）。修好后重跑本命令。');
    process.exit(1);
  }
}
