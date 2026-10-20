#!/usr/bin/env node
/**
 * build-lessons.js — 课程页构建器（**包侧 CLI / IO 适配层**）
 *
 * 课程页的"外壳"（head、样式表、theme-boot、名词引导条、导航、页脚、尾部脚本）每课都
 * 一模一样。手写一遍就是每课白花 ~3,500 token，还会抄错（比如页面上写"全部 50 个名词"，
 * 数据源里其实有 60 个）。这个脚本把外壳固定成 assets/_frame.html，作者只写 5 段内容。
 *
 * 用法：
 *   node tools/build-lessons.js                 构建 lessons/src/*.html → lessons/*.html
 *   node tools/build-lessons.js --check         构建到内存并与磁盘比对，有漂移就非零退出
 *   node tools/build-lessons.js --extract <页面…>  把已有课程页反向拆成 lessons/src/ 源文件
 *   node tools/build-lessons.js --extract --no-blocks  同上，但不动 lesson-blocks.css
 *   node tools/build-lessons.js --extract --force-blocks  合并结果为 0 条规则时也强制覆盖 lesson-blocks.css
 *      （默认**不覆盖**：现行产物里没有内联 <style>，空合并写下去会把现存那份 CSS 毁掉）
 *
 * 零依赖（只用 Node 内置）。
 *
 * ⚠️ **渲染计算只有一份，不在本文件里**（U-SPEC §5 / U07）：唯一实现在
 * `./unify/render.cjs`（仓内权威源码 `lib/unify/render.cjs`，由 U19 的同步器逐字节生成
 * 到本目录；**禁止手改**）。本文件保留的全部是**包侧 CLI / IO**：
 *   · 路径推导（ROOT / SRC_DIR / OUT_DIR / ASSETS）、`__dirname` 相对解析；
 *   · 数据文件缓存（T17：按**确切 resolved 键**失效，代码缓存不动）；
 *   · 源文件扫描（walkSrc / pointInfo / haloName / loadSources）与 `displayNumberOf` 折算；
 *   · 定制层（coach）读取、笔记计数、答疑计数（→ 作为 ctx 注入内核）；
 *   · 原子写盘、`--extract` 的落盘与「合并结果为空不许覆盖」安全闸；
 *   · 主题合成（style-adapter）→ 单调度体检（报告，不上闸）→ 风格断言 → 星图重建；
 *   · 退出码与文案（`[build] … 字符` / `[check] ✅ …` / 「跳过 ≠ 通过」…）。
 * 谁想在渲染里加逻辑，改 `./unify/render.cjs`（以及仓内 `lib/unify/render.cjs` 的唯一源），
 * **不要**在本文件里另写一份 —— 那正是 U 系列要消灭的东西。
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

/* ── 引擎件（**在技能包守卫之后**才 require：没课程数据的包照旧 exit 0 跳过，不因缺件改语义）──
 * 渲染计算只有一份：唯一实现在 ./unify/render.cjs（仓内权威源码 lib/unify/render.cjs，由 U19 的
 * 同步器逐字节生成到本目录；**禁止手改**）。本文件只留包侧 CLI / IO。 */
const renderCore = require('./unify/render.cjs');
// 课次映射 / 锚点的包侧实现（与插件 lib/pack-model.js 有一道对拍钉住）
const { lessonMap, labelOfAnchor, labelAnchorId, displayNumberOf } = require(path.join(__dirname, 'lesson-map.js'));
// §3：h2/h3 静态流彩类（**两个渲染器共用**的一小段变换：本文件与 build-notes 都要它）
const { withStaticTitles, stripStaticTitles } = require('./title-classes.js');

/* ── 数据加载（T17）：按**确切 resolved 文件键**失效，代码缓存不动 ─────────────
 *
 * 数据文件（`assets/glossary-data.js` / `assets/questions-data.js`）是**产物级真源**：
 * 同一个进程里增/改/删之后再构建，必须读到新内容 —— 而 `require` 有模块缓存。
 * 所以每次加载前先按**确切的 resolved 文件键**比一次 `(mtimeMs, size, ino)`：
 *   没变 → 复用上一次的数据对象；变了 / 首次 → **只** `delete require.cache[那一个键]` 再 require。
 *
 * ⚠️ 三条不许破的边界（卡 T17）：
 *   ① **绝不** `Object.keys(require.cache).forEach(delete)` 式全局清扫；
 *   ② **执行代码**（`./shape-render.js`、`./title-classes.js`、`./unify/render.cjs` …）不在此列 ——
 *      它们是代码不是数据快照，照旧走 require 缓存（数据缓存与代码缓存**分开**）；
 *   ③ 加载失败（文件坏了 / 被删）**如实抛错**，**绝不**拿上一次成功的数据对象顶替。
 *
 * 口径与插件侧 `lib/render-inputs.js` 的同名逻辑一致（那份是 ESM + createRequire；实现可以
 * 不同 —— **行为**必须对拍，判据见 `test/audit/T17.mjs`）。
 */
const DATA_STAT = new Map();   // resolvedKey → { mtimeMs, size, ino }

/**
 * 按 resolved 键读一个数据文件。
 * @param {string} abs 数据文件的绝对路径
 */
function loadDataFile(abs) {
  // 确切 resolved 文件键 == require.cache 的键
  const key = require.resolve(abs);
  let st = null;
  try { st = fs.statSync(key); } catch { /* 取不到 → 下面必然重读；真读不到就如实抛错 */ }
  const prev = DATA_STAT.get(key);
  const unchanged = Boolean(st && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && prev.ino === st.ino);
  if (unchanged) return require(key);
  delete require.cache[key];     // ← 只动这一个键
  const fresh = require(key);    // 抛就抛：不复用旧成功结果
  DATA_STAT.set(key, st ? { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino } : null);
  return fresh;
}

const GLOSSARY = loadDataFile(path.join(ASSETS, 'glossary-data.js'));
const QUESTIONS = loadDataFile(path.join(ASSETS, 'questions-data.js'));
const SHAPE = require(path.join(__dirname, 'shape-render.js'));   // 执行代码：require 缓存照旧，图型 → 图型 DOM 的确定性映射器

/** 名词索引（唯一计算在核心里；这里只是把数据装一次递给它） */
const GLOSSARY_INDEX = renderCore.buildGlossaryIndex(GLOSSARY);

/** 递给渲染内核的三个能力（内核不自备第二份；详见 lib/unify/render.cjs 文件头） */
const RENDER_DEPS = Object.freeze({ labelAnchorId, withStaticTitles, stripStaticTitles });

/* ── 构建期体检（**报告，不上闸**）──────────────────────────────────────────
 * 为什么会在这里：这是"给人看的一份报告"，不是渲染计算 —— 数据来自 SHAPE.audit
 * （包侧执行代码），块序列来自内核的 pageSequence()。报告本身不写盘。 */
function auditPages(pages) {
  const rows = pages.map((p) => ({
    id: `${p.label} ${p.meta.navTitle || p.meta.title || ''}`.trim(),
    blocks: renderCore.pageSequence(p),
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
  // 产物目录可能**还不存在**：刚建完知识点、第一次构建时 `lessons/<圈>/<点>/` 是空的甚至没建 ——
  // 少这一句，临时文件直接 ENOENT，报出来像"构建脚本坏了"，其实是"目录还没长出来"。
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/* ── 源文件扫描 ──────────────────────────────────────────────────────────────
 * 支持两种布局，输出路径一律 = 源文件的相对路径（lessons/<rel>）：
 *   ① 「圆圈 / 知识点 / 课程」三层： lessons/src/programming/spring-boot/0001-*.html
 *   ② 历史平铺：                   lessons/src/0001-*.html  → lessons/0001-*.html（逐字节同旧行为）
 * 混用两种层级会**报错**（页面里回到根目录的相对前缀由层级推出，混用必错）。
 */
const LEGACY_HALO = 'programming';
const LEGACY_POINT = 'spring-boot';

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
  if (!fs.existsSync(SRC_DIR)) return [];
  const pages = walkSrc(SRC_DIR).map((rel) => {
    const base = rel.split('/').pop();
    // 旧实现用 /^\d{4}-/ 过滤：不合规的文件**静默消失**。这里改成直接报错。
    if (!/^\d{4}-.*\.html$/.test(base)) {
      throw new Error(`lessons/src/${rel}：文件名必须形如 NNNN-*.html（旧实现会静默跳过，所以这里直接报错）`);
    }
    const parts = rel.split('/');
    const page = renderCore.parseSource(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'), base, SHAPE);
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
  return pages.sort((a, b) => a.rel.localeCompare(b.rel));
}

/* ── 笔记数据（封面卡三个数字）─────────────────────────────────────────── */

const NOTES_DIR = path.join(ROOT, 'notes');
const NOTES_JSONL = path.join(NOTES_DIR, 'notes.jsonl');
// 课次映射表：包侧唯一一份（`tools/lesson-map.js`），与插件 `lib/pack-model.js` 有一道对拍钉住
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

/* ── 定制层（coach）：IO 在这里，注入契约在核心里 ────────────────────────────
 * 定制层（点评 / 下一步 / 答疑正文）**绝不并进源文件**，另存
 * `learning-records/coach/<point>/<NNNN>.jsonl`（append-only，每行 `{slot, html}`，最新一条生效）；
 * 渲染器**只在整行占位符处**注入它 —— 缺占位符就报错（核心里有那三道闸）。 */
const COACH_SLOTS = ['RECAP', 'NEXT', 'ASK'];   // 只用于读盘时过滤 slot 名（渲染契约在核心里）

/** 读某一课的定制层：{slot → html}。文件不存在 / 该 slot 没记录 = **空定制层**（不是错误）。 */
function readCoach(root, lessonId) {
  const out = {};
  try {
    const f = path.join(root, 'learning-records', 'coach', ...String(lessonId).split('/')) + '.jsonl';
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && COACH_SLOTS.includes(e.slot) && typeof e.html === 'string') out[e.slot] = e.html;
      } catch { /* 坏行跳过：不许因为它让整页崩 */ }
    }
  } catch { /* 没有这个文件 = 空定制层 */ }
  return out;
}

/** 课次键（`point/NNNN`）—— coach 台账的路径与封面卡槽位共用同一个写法 */
function lessonKeyOf(page) {
  return `${page.point}/${String(page.meta.number).padStart(4, '0')}`;
}

/**
 * 把一批页要用的 IO 数据**读一次**装成 ctx（渲染内核只吃数据，不读盘）。
 * 与插件侧 `lib/render-inputs.js#readRenderInputs` 同一份口径：frame 读一次、
 * 圆圈名建表、笔记计数建表、答疑台账原样递进去。
 */
function buildCtx(all) {
  // 丢掉 _frame.html 顶部的说明注释：那是给维护者看的（内核负责切，这里只把原文递进去）
  let frame = '';
  try {
    frame = fs.readFileSync(FRAME_PATH, 'utf8');
  } catch {
    frame = '';
  }
  const haloNames = new Map();
  const noteCounts = new Map();
  for (const p of all) {
    if (!haloNames.has(p.halo)) haloNames.set(p.halo, haloName(p.halo));
    noteCounts.set(p.label, countNotes(p.label));
  }
  return {
    frame,
    glossaryIndex: GLOSSARY_INDEX,
    haloNames,
    noteCounts,
    qa: QUESTIONS,
    shape: SHAPE,
  };
}

/** 渲染一张页：IO 部分（coach）在这里读，计算全在内核 */
function renderOne(page, all, ctx) {
  return renderCore.renderPage(page, all, {
    ...ctx,
    coach: readCoach(ROOT, lessonKeyOf(page)),
    deps: RENDER_DEPS,
  });
}

/* ── 抽取：已有课程页 → 源文件（计算在内核；本文件只管读写与安全闸）───────── */

/**
 * 把各页内联样式合并成一份共享 CSS 并落盘（同名选择器只留第一份）。
 * 合并算法在核心 `mergeBlockRules` / `formatBlocks`；本函数保留的是**安全闸**与写盘：
 *
 * 安全闸（2026-09-25）：合并结果 0 条规则 ⇒ **跳过写入**，lesson-blocks.css 原样不动。
 * 危险路径：现行产物里已没有内联 <style>，合并结果是空的 —— 写下去会把现存那份
 * （真包里 N 条规则）覆盖成只剩头注释的空壳。不是改抽取语义，是安全栏。
 * 照 build-notes.js 缺课源的先例：**响亮跳过、exit 0**（跳过 ≠ 通过，告警必须显眼）。
 * 规则数 > 0 时行为一字不改（照旧写）。要强制覆盖就显式传 --force-blocks。
 */
function emitBlocks(styles) {
  const { rules, conflicts } = renderCore.mergeBlockRules(styles);
  for (const c of conflicts) console.warn(`[build-lessons] ⚠️ 选择器 ${c.sel} 在 ${c.kept} 与 ${c.file} 里定义不同，保留前者`);
  if (!rules.length && !argv.includes('--force-blocks')) {
    const existing = fs.existsSync(BLOCKS_PATH) ? fs.readFileSync(BLOCKS_PATH, 'utf8') : '';
    const existingRules = [...existing.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].length;
    console.warn('');
    console.warn('⚠️⚠️⚠️ [build-lessons] 跳过写入 assets/lesson-blocks.css ⚠️⚠️⚠️');
    console.warn('① 发生了什么：本次 --extract 的页面里没有内联 <style>，合并结果为空（0 条规则）。');
    console.warn(`② 为什么跳过：写下去会把现存的 ${existingRules} 条规则覆盖成只剩头注释的空壳 —— 等于毁掉 lesson-blocks.css。`);
    console.warn('③ 怎么绕过：确实要强制覆盖就显式传 --force-blocks；本工具默认不提供静默覆盖，请手工处理。');
    console.warn('');
    return false;
  }
  if (!rules.length) {
    console.warn(`[build-lessons] ⚠️ --force-blocks：合并结果为 0 条规则，仍按显式开关覆盖 lesson-blocks.css`);
  }
  writeAtomic(BLOCKS_PATH, renderCore.formatBlocks(rules));
  return true;
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
  const navTitles = renderCore.collectNavTitles(loaded);
  fs.mkdirSync(SRC_DIR, { recursive: true });

  const styles = [];
  for (const p of loaded) {
    const page = renderCore.extractPage(p.text, p.file, navTitles, GLOSSARY_INDEX, RENDER_DEPS);
    const outPath = path.join(SRC_DIR, page.file);
    writeAtomic(outPath, renderCore.serializeSource(page));
    styles.push({ file: page.file, css: page._inlineStyle });
    const chars = Object.values(page.sections).reduce((n, s) => n + s.length, 0);
    console.log(`[extract] ${path.relative(ROOT, outPath)}  ← ${page.file}（正文 ${chars} 字符）`);
  }
  if (!noBlocks) {
    const wrote = emitBlocks(styles.filter((s) => s.css.trim()));
    if (wrote) console.log(`[extract] ${path.relative(ROOT, BLOCKS_PATH)} 已合并 ${styles.length} 页的内联样式`);
    else console.log(`[extract] ${path.relative(ROOT, BLOCKS_PATH)} 未写入 —— 合并结果为空，已跳过（见上方 ⚠️ 告警）`);
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

const ctx = buildCtx(all);
let drift = 0;
for (const page of all) {
  const html = renderOne(page, all, ctx);
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
  // 子进程**没起来**（EPERM / ENOENT）时 r.status 是 null —— 原来那句「未同步（详见上方）」
  // 会把人指向错的修法：上方**什么都没有**，因为脚本压根没跑。
  if (r.error) {
    console.error(`[build] 起不了子进程：${r.error.code || r.error.message}（权限/沙箱边界）—— 这不是「命令没跑」也不是代码坏了。`
      + '出路：① 改 stdio:\'inherit\'（本处已是）② 结果写文件再读 ③ 在无沙箱环境跑。');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[build] 星图数据未同步（详见上方）。修好后重跑本命令。');
    process.exit(1);
  }
}
