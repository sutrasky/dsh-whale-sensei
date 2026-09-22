#!/usr/bin/env node
/**
 * build-notes.js — 生成 reference/NOTES.html（笔记文档页）
 *
 * 纯函数、确定性、支持 --check（磁盘 vs 渲染，漂移非零退出）。
 *
 * 输入：assets/questions-data.js、notes/notes.jsonl
 * 输出：reference/NOTES.html（原子写入）
 *
 * **名词解释不在本页**（裁定：疑问与名词解释分开）——「名词」小节已整体搬走，
 * 名词解释住在 `glossary/index.html`（名词地图，圆形节点 + 蜂窝网格）。本页只留
 * 「答疑 + 我的笔记」，页头给一条去地图的入口。课程页小封面卡的「名词 N」也指向地图。
 *
 * 排序确定性：课按 track/number、答疑按 id、笔记按 id。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const REF_DIR = path.join(ROOT, 'reference');
const OUT_PATH = path.join(REF_DIR, 'NOTES.html');
const NOTES_DIR = path.join(ROOT, 'notes');
const NOTES_JSONL = path.join(NOTES_DIR, 'notes.jsonl');
// 课次映射表：包侧唯一一份（`tools/lesson-map.js`），与插件 `lib/pack-model.js` 的
// `lessonIndex()` 有一道机械对拍钉住 —— 别在这里就地拼 `第N课`
const { lessonMap, labelOfAnchor } = require(path.join(__dirname, 'lesson-map.js'));
const LESSON_MAP = lessonMap(ROOT);
// 逐行剥 BOM：PowerShell 写的文件会带 BOM，不剥那一行会被 catch 成 null → **静默丢掉一条真笔记**
// （坑位说明见 tools/pack-text.js；插件侧的对应物是 lib/text.js）
const { splitLines } = require(path.join(__dirname, 'pack-text.js'));
const { withStaticTitles } = require(path.join(__dirname, 'title-classes.js'));   // §3：h2/h3 静态流彩类

/** 读笔记台账的每一行（已剥 BOM、已剔空行） */
function readNoteLines() {
  return splitLines(fs.readFileSync(NOTES_JSONL, 'utf8')).filter((l) => l.trim());
}

/* ── 技能包守卫：缺课程数据时响亮跳过 ────────────────────────────────────── */
if (!fs.existsSync(path.join(ASSETS, 'questions-data.js'))) {
  console.log('=== 跳过：本目录没有 assets/questions-data.js（技能包只带引擎，课程数据由使用者创建）===');
  console.log('⚠️ 这是「跳过」，不是「通过」。在有课程数据的课程包根跑才有意义。');
  process.exit(0);
}

const QUESTIONS = require(path.join(ASSETS, 'questions-data.js'));

/* ── helpers ─────────────────────────────────────────────────────────── */

function writeAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** 读 notes/notes.jsonl 里属于某课的笔记，按 id 排序
 *  台账里的 `anchor` 是**星图课次键**（写入口归一化），不是 label —— 反推只经 labelOfAnchor */
function loadNotes(lesson) {
  try {
    return readNoteLines()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((n) => n && labelOfAnchor(n.anchor, LESSON_MAP) === lesson)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  } catch {
    return [];
  }
}

/* ── 整理数据 ────────────────────────────────────────────────────────── */

/** 从 questions-data 中提取已解答的答疑，按 lesson 分组 */
function questionsByLesson() {
  const byLesson = {};
  for (const q of Object.values(QUESTIONS)) {
    if (q.status !== 'answered' || !q.answerHtml) continue;
    const lesson = q.lesson;
    if (!byLesson[lesson]) byLesson[lesson] = [];
    byLesson[lesson].push(q);
  }
  // 按 id 排序
  for (const arr of Object.values(byLesson)) {
    arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return byLesson;
}

/** 解析 lesson 编号用于排序 */
function lessonNumber(lesson) {
  const m = /(\d+)/.exec(lesson);
  return m ? parseInt(m[1], 10) : 9999;
}

/* ── 渲染 ────────────────────────────────────────────────────────────── */

function renderNotesPage() {
  const qaByLesson = questionsByLesson();

  // 课次清单 = 课程包里**全部课**（LESSON_MAP 是权威；它的 label 与课程页小封面卡
  // `NOTES.html#<label>` 逐字一致 —— notes-card 闸门会红）+ 答疑台账里出现的课
  // + 笔记台账里出现的课（见下面的扫描）。
  // 为什么不能只取"有答疑的课"：第2课 / Vue第1课 目前 0 答疑 0 笔记，全靠名词撑章节；
  // 名词搬走后若不从课次表补齐，这两课的 `#第2课` 锚点会变成死链（课程页卡片指向空气）。
  const allLessons = new Set(Object.values(LESSON_MAP.byKey).map((e) => e.label));
  for (const l of Object.keys(qaByLesson)) allLessons.add(l);
  // 也扫描笔记台账里可能出现的课（anchor 是课次键 → 反推成显示名再加进来）
  try {
    for (const l of readNoteLines()) {
      try {
        const n = JSON.parse(l);
        const label = labelOfAnchor(n && n.anchor, LESSON_MAP);
        if (label) allLessons.add(label);
      } catch { /* skip */ }
    }
  } catch { /* no notes file */ }

  // 排序：先按轨道（point），再按**显示号** —— 两条轨道各有自己的第1课，
  // 只按数字排会把它们交错（spring-boot 第1课 / Vue 第1课 / spring-boot 第2课）
  const orderOf = (label) => {
    const e = LESSON_MAP.byLabel[label];
    return e ? [e.point, e.displayNumber] : ['~', lessonNumber(label)];
  };
  const lessons = [...allLessons].sort((a, b) => {
    const A = orderOf(a);
    const B = orderOf(b);
    return A[0] === B[0] ? A[1] - B[1] : String(A[0]).localeCompare(String(B[0]));
  });

  // 各课章节（每课用 <details open> 包裹，无 JS 也能折叠）
  const sections = lessons.map((lesson) => {
    // label 直接用映射表给出的显示名（含轨道前缀）—— 与课程页上的笔记卡链接
    // `NOTES.html#<label>` 逐字一致；自己拼 `第N课` 会让两处对不上（notes-card 闸门会红）
    const label = lesson;
    const qa = qaByLesson[lesson] || [];
    const notes = loadNotes(lesson);

    const lines = [];

    // 章节头（<details open> 让内容默认展开，<summary> 是折叠触发器）
    lines.push(`  <details open class="notes-doc" id="${label}">`);
    lines.push(`    <summary><h2>${label}</h2></summary>`);

    // 答疑
    lines.push(`    <h3 id="${label}-答疑">答疑</h3>`);
    if (qa.length) {
      lines.push('    <div class="notes-qa">');
      for (const q of qa) {
        lines.push(`      <article id="${q.anchor}">`);
        lines.push(`        <div class="notes-qa-q">问： ${escapeHtml(q.question)}</div>`);
        lines.push(`        <div class="notes-qa-a">`);
        lines.push(`          ${q.answerHtml}`);
        lines.push(`        </div>`);
        lines.push(`      </article>`);
      }
      lines.push('    </div>');
    } else {
      lines.push('    <p class="is-note">本课暂无答疑。</p>');
    }

    // 笔记
    lines.push(`    <h3 id="${label}-笔记">我的笔记</h3>`);
    lines.push(`    <div class="notes-mynotes">`);
    lines.push(`      <form data-note-form data-note-lesson="${escapeHtml(lesson)}">`);
    lines.push(`        <textarea data-note-input rows="3" placeholder="写点你自己的话…"></textarea>`);
    lines.push(`        <button type="submit">记下</button>`);
    lines.push(`        <ul data-note-list>`);
    for (const n of notes) {
      const date = n.at ? new Date(n.at).toLocaleString('zh-CN') : '';
      lines.push(`          <li><time>${escapeHtml(date)}</time>${escapeHtml(n.text)}</li>`);
    }
    lines.push(`        </ul>`);
    lines.push(`        <p data-note-status></p>`);
    lines.push(`      </form>`);
    lines.push(`    </div>`);

    lines.push('  </details>');
    return lines.join('\n');
  }).join('\n\n');

  // 生成左导航树条目（每个 lesson 一个 <details>，下挂两个链接带条目计数）
  const navItems = lessons.map((lesson) => {
    const label = lesson;
    const qa = qaByLesson[lesson] || [];
    const notes = loadNotes(lesson);
    return [
      `        <details open>`,
      `          <summary>${label}</summary>`,
      `          <ul>`,
      `            <li><a href="#${label}-答疑">答疑 <span class="notes-count">${qa.length}</span></a></li>`,
      `            <li><a href="#${label}-笔记">我的笔记 <span class="notes-count">${notes.length}</span></a></li>`,
      `          </ul>`,
      `        </details>`,
    ].join('\n');
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH 笔记</title>
  <link rel="stylesheet" href="../assets/theme.css">
  <link rel="stylesheet" href="../assets/styles.css">
  <link rel="stylesheet" href="../assets/notes-page.css">
  <noscript><style>.notes-search { display: none; }</style></noscript>
</head>
<body id="top" data-notes-page="all">
  <script src="../assets/theme-boot.js"></script>
  <header class="notes-top">
    <div class="notes-top__left">
      <h1 class="notes-top__title rainbow-title">DSH 笔记</h1>
      <p class="notes-top__sub rainbow-subtitle">答疑来自 questions-data.js / 笔记来自 notes.jsonl</p>
      <a class="notes-top__map" href="../glossary/">名词解释不在这里 · 去名词地图 →</a>
    </div>
    <div class="notes-top__search">
      <input type="search" class="notes-search" placeholder="搜索..." aria-label="搜索笔记">
      <button type="button" class="notes-search__go">搜索</button>
    </div>
  </header>
  <div class="notes-shell">
    <nav class="notes-nav" aria-label="笔记导航">
${navItems}
    </nav>
    <main class="notes-main" data-content>
      <!-- 拖动手柄：必须挂在 [data-content] 容器**里面**（否则绝对定位的包含块会变成
           body 网格区的整个第 2 列，right 会把人推到窗口最右侧）—— 与课程页同一套契约 -->
      <button class="page-splitter page-splitter--start" role="separator" aria-orientation="vertical"
              data-side="start" aria-label="拖动调整正文左缘（右缘不动）；按住 Shift 平移整列" title="拖动调整正文左缘；按住 Shift 平移整列" tabindex="0"></button>
      <button class="page-splitter" role="separator" aria-orientation="vertical"
              data-side="end" aria-label="拖动调整正文右缘（左缘不动）；按住 Shift 平移整列" title="拖动调整正文右缘；按住 Shift 平移整列" tabindex="0"></button>
${sections}
      <a class="notes-to-top" href="#top">回到顶部</a>
    </main>
  </div>
  <script src="../assets/theme.js"></script>
  <script src="../assets/notes.js"></script>
  <!-- 顺序不能反：page-splitter.js 依赖 notes-width.js 提供的 window.LESSON_WIDTH -->
  <script src="../assets/notes-width.js"></script>
  <script src="../assets/page-splitter.js"></script>
</body>
</html>`;

  // §3（2026-09-21）：h2/h3 直接静态上色（h1 与副标题的类已在上面模板里写明；h4 不上）
  return withStaticTitles(html);
}

/* ── main ────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');

/* 没有课程源（技能包只带引擎、或新课还没写）→ **响亮地跳过**，而不是报"忘了构建"退出 1。
   与其他工具同一约定（shape-pipeline / strip-emoji / notes-card）：措辞要能被一眼认成"跳过，不是通过"。 */
const SRC_DIR = path.join(ROOT, 'lessons', 'src');
// **递归**找课程源（分层布局后是 lessons/src/<圆圈>/<知识点>/NNNN-*.html）。
// 只扫一层会把"有课"误判成"没课" → 整个 NOTES 重建被**静默跳过**
// （2026-09-21 实测：答疑写进台账了，文档却一动不动 —— 正好是最难查的那种假绿）。
const hasCourse = fs.existsSync(SRC_DIR) && (function any(d) {
  let es = [];
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
  return es.some((e) => (e.isDirectory() ? any(path.join(d, e.name)) : /^\d{4}-.*\.html$/.test(e.name)));
})(SRC_DIR);
if (!hasCourse) {
  console.log('=== 跳过：本目录没有课程源 lessons/src/*.html（技能包只带引擎，课程数据由使用者创建）===');
  console.log('⚠️ 这是「跳过」，不是「通过」。在有课程数据的工作区里跑才有意义。');
  process.exit(0);
}

const html = renderNotesPage();

if (checkOnly) {
  if (!fs.existsSync(OUT_PATH)) {
    console.error(`[check] ❌ ${path.relative(ROOT, OUT_PATH)} 不存在（忘了构建）`);
    process.exit(1);
  }
  const existing = fs.readFileSync(OUT_PATH, 'utf8');
  if (existing === html) {
    console.log(`[check] ✅ ${path.relative(ROOT, OUT_PATH)} 无漂移`);
  } else {
    console.error(`[check] ❌ ${path.relative(ROOT, OUT_PATH)} 磁盘与构建结果不一致`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(REF_DIR, { recursive: true });
  writeAtomic(OUT_PATH, html);
  console.log(`[build] ${path.relative(ROOT, OUT_PATH)}  ${html.length} 字符`);
}