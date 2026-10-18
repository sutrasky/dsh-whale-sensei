#!/usr/bin/env node
/**
 * build-public.js — 公开站产物 `dist/`（`lessons.sutrasky.com`）
 * ------------------------------------------------------------------
 * 用法：node tools/build-public.js [--include-progress]   写 dist/（原子：建到暂存目录，断言全过才换上去）
 *       node tools/build-public.js --plan                 只打印发布计划（一行 JSON），**不写盘**
 *       node tools/build-public.js --confirm --plan-digest=<digest>   核同一份计划后写 dist/
 *       node tools/build-public.js --verify               只验**构建器**（闸门用）：不碰 dist/
 *       node tools/build-public.js --check                与 dist/ **逐字节对拍**（发布前用；dist/ 不在即红）
 *
 * 为什么是三个开关而不是一个：
 *   · `--verify` 与 dist/ 无关 —— 闸门要的是"这个构建器还对不对"。
 *     若闸门用 `--check`，那么**改一门课**就会让 dist/ 陈旧、闸门变红，
 *     而"忘了重建 dist"是**发布**时的问题，不该让日常闸门红。
 *   · `--check` 是**发布前**的那道闸：它保证要传上去的字节，就是构建器此刻的产物。
 *
 * **星图就是主页**（用户 2026-09-22 指令：「把我的星图搬上去覆盖在 lessons 主页，效果要和我本地一样」）：
 * `starmap/*` **铺平到站点根**，于是 `dist/index.html` **就是** `starmap/index.html`，
 * 由断言守着**逐字节相同**。
 *
 * 铺平之所以成立（实测真浏览器已验证：theme.css / 两个 woff2 / main.js / three 全部 200）：
 *   · `starmap/index.html` 里的 `../assets/…` —— 在站点根 `..` 会被 RFC 3986 的
 *     remove_dot_segments 折叠掉，仍指向 `/assets/…`（与在 `/starmap/` 下**同一个 URL**）。
 *   · `./content.js` `./fonts/…` `./vendor/three/…` —— 同名文件也都在根。
 *   · `starmap/main.js:22` 的 `const PREFIX = '../'` 把课程链接拼成 `../lessons/…` ——
 *     同样折叠成 `/lessons/…`，所以**双击课程星进课这条路在根下照常**。
 *   · `deepLink()` 读 `location.hash`、`syncProgress()` 取 `location.origin + '/progress'`
 *     （拿不到就静默保持快照）—— 正好是用户要的「不实时同步，我上传再同步」。
 *
 * **进度默认中性化**（T20 / 报告 D05）：产物是"发给别人"的东西，默认**不携带**作者/学生的
 * 进度载体（`starmap/content.js` 的 learned/pendingQ/flag、`assets/practice-data.js` 的
 * achieved/needsReview/每题 state）。要"效果和我本地一样"就**显式**加 `--include-progress` ——
 * 那是源码里明示的产品选择，不是默认。原先这里是 `NEUTRALIZE_PROGRESS = false`（原样发布）。
 *
 * 三条铁律，改这个文件前先读：
 *   1. **白名单，不是黑名单** —— 只有 WHITELIST（+ 星图）会进公开站。
 *      以后新增目录**默认不发布**（安全侧默认）。FORBIDDEN 只是"反空转"断言：
 *      白名单被谁悄悄放宽了，它立刻红。
 *   2. **裁剪只落在 dist/，源目录一个字节不改** —— 否则插件侧 `render-parity`
 *      与包侧 `gate.mjs` 的对拍契约会连带失效。（T20 起这条由
 *      `tools/publish-policy.cjs` 机械保证：清理与重建全在临时副本里做，跑完源包 path+size+mtime 全同。）
 *   3. **确定性**：同一份输入产出逐字节相同的 dist/（无时间戳、无随机、排序固定）。
 *      `--check` 的实现就是"重建到临时目录再逐字节对拍"，所以这条不是口号。
 *
 * 私人面与"该排谁"的判断**不在这里**（T20 / 报告 D05）：清单、排除、净化、重建、原子换上去
 * 全部住在 `tools/publish-policy.cjs` —— 本文件只负责"验构建器 / 对拍 / 生成那两张小页 /
 * 跑这套断言"。这样公开站与离线 payload 用**同一份**策略，不会再一边堵一边漏。
 *
 * 变换面（**只动产物拷贝**，全部在 publish-policy.cjs 的净化链里）：
 *   T1  课程页侧栏 `…starmap/#<id>` → `…#<id>`（星图已在站点根，`starmap/` 不存在）
 *   N1/N2  content.js 的 learned/pendingQ/flag          （仅默认档）
 *   N3     由中性化 content.js 重跑 build-starmap-svg.js（仅默认档）
 *   N4     practice-data.js 的完成度                    （仅默认档）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const PUB = require('./publish-policy.cjs');   // 发布策略的唯一真源（T20 / 报告 D05）

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, '.tmp-public-check');
const CHECK = process.argv.includes('--check');
const VERIFY = process.argv.includes('--verify');
const PLAN_ONLY = process.argv.includes('--plan');
const CONFIRM = process.argv.includes('--confirm');
const DIGEST_ARG = (process.argv.find((a) => a.startsWith('--plan-digest=')) || '').slice('--plan-digest='.length);
/** 进度**默认中性化**：只有显式 `--include-progress` 才保留进度载体（T20 / D4 · D6）。 */
const INCLUDE_PROGRESS = process.argv.includes('--include-progress');

const SITE = 'lessons.sutrasky.com';

/** 白名单：只有这四个目录会进公开站（星图另走"铺平到根"，见 buildInto）。
 *  `glossary` = 名词地图（名词解释的家）。疑问与名词解释分开之后，课程页笔记卡的
 *  「名词地图 →」直接指向它 —— 漏了它会线上 404（本地却好好的）。 */
const WHITELIST = ['lessons', 'assets', 'reference', 'glossary'];

/** 白名单内部的排除（相对课程包根，posix） */
const EXCLUDE_RULES = [
  { why: '作者态源（含未填的 {{槽位}}，不是可发布页面）', match: (rel) => rel === 'lessons/src' || rel.startsWith('lessons/src/') },
  { why: '内部模板与开发样例页（assets/_frame · _style-sample · _figure-lab）', match: (rel) => rel.startsWith('assets/_') },
  { why: '星图的开发文档（不是页面资源）', match: (rel) => rel === 'starmap/README.md' },
];

/** 反空转断言：这些**一律不许**出现在产物里。
 *  `starmap` 是因为星图**铺平到根**了 —— 产物里若出现 `starmap/` 目录，说明铺平漏了或白名单被放宽。
 *  `README.md` 是开发文档，漏进产物就是上面那条排除规则失效。
 *  `.whale-txn` / `.whale-write.lock`（T09 / 报告 C01）：包级事务的日志与锁 ——
 *  它们**不进学习产物、不进发布物**是卡面明写的边界；白名单结构上已经进不去（它们住在包根），
 *  这里再点一次名，好让"哪天白名单被放宽"当场撞上反空转断言。 */
const FORBIDDEN = [
  'code', 'learning-records', 'questions', 'notes', 'tools', '_plugin-prep',
  'demo', 'skill-draft', '_starmap-proto', '.backup', '.git', '.agent-teams',
  '.whale-txn', '.whale-write.lock',
  'lessons/src', 'templates', 'presets', 'starmap', 'README.md',
];

/* ------------------------------------------------------------------ 工具 */

const byName = (a, b) => a.name.localeCompare(b.name);

/** 递归列文件，返回**相对传入目录**的 posix 路径（排序固定 → 确定性） */
function walkFiles(dir) {
  const out = [];
  (function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort(byName)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { w(full); continue; }
      out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  })(dir);
  return out;
}

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

function write(target, rel, text) {
  const abs = path.join(target, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function isExcluded(rel) { return EXCLUDE_RULES.some((r) => r.match(rel)); }

/* 产物装配（净化拷贝 / 星图铺平 / 派生物重建 / T1 链接改写）**都不在这里**了（T20）：
   它们和"该排谁"是同一个判断，住在 `tools/publish-policy.cjs` —— 公开站与离线 payload
   必须用同一份，否则就是报告 D05 那条"一边堵、一边漏"。本文件只在 `--verify` / `--check`
   里调它把产物建到临时目录，然后跑下面这套断言。 */

/* ---------------------------------------------------------------- 断言用读取 */

/** 读 starmap/content.js（它自己给 window.STARMAP_REAL 赋值）—— 断言比对用，**不改内容** */
function loadStarmapContent(file) {
  const window = {};
  new Function('window', fs.readFileSync(file, 'utf8'))(window);
  if (!window.STARMAP_REAL) throw new Error('读不到 window.STARMAP_REAL：' + file);
  return window.STARMAP_REAL;
}

/** 读 practice-data.js —— 两种形态都要能读：
 *    ① 真源是 UMD（走 module.exports 分支）
 *    ② 中性化版直接给 window.PRACTICE_DATA 赋值
 *  （中性化的**写出**在 `publish-policy.cjs`；这里读回来只为断言。）
 */
function loadPractice(file) {
  const m = { exports: {} };
  const win = {};
  new Function('module', 'globalThis', 'window', fs.readFileSync(file, 'utf8'))(m, win, win);
  const D = (m.exports && m.exports.lessons) ? m.exports : win.PRACTICE_DATA;
  if (!D || !D.lessons) throw new Error('读不到 PRACTICE_DATA：' + file);
  return D;
}

/* ---------------------------------------------------------------- 生成页 */

/** 只有 404 用得上外壳（主页是星图本身，逐字节不动）。
 *  观感一律吃 `assets/theme.css` + `assets/styles.css`，所以这里**不写任何样式**。 */
function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <link rel="icon" type="image/x-icon" href="assets/starmap.ico">
    <link rel="stylesheet" href="assets/theme.css">
    <link rel="stylesheet" href="assets/styles.css">
</head>
<body>
    <script src="assets/theme-boot.js"></script>
    <main id="main">
${bodyHtml}
    </main>
</body>
</html>
`;
}

function notFoundPage() {
  return shell('404 · ' + SITE,
    `      <h1 class="rainbow-title">404 · 没有这一页</h1>\n`
    + `      <p>地址可能写错了，或者这一课还没发布。</p>\n`
    + `      <p><a href="/">回到知识星图</a></p>`);
}

function robotsTxt() {
  return `User-agent: *\nAllow: /\n`;
}

/* ---------------------------------------------------------------- 断言 */

function assertNoForbidden(target) {
  const bad = [];
  for (const rel of walkFiles(target)) {
    for (const f of FORBIDDEN) {
      if (rel === f || rel.startsWith(f + '/')) bad.push(`${rel}  ← 命中「${f}」`);
    }
  }
  if (bad.length) {
    throw new Error('公开站里出现了不该发布的路径（白名单被放宽了？）：\n  ' + bad.join('\n  '));
  }
}

/** 产物里**不许有任何会 404 的 `starmap/` 引用**（星图已铺平到根）。
 *  只看"真能变成请求"的地方：
 *    · `.html` —— 只查 `href=` / `src=` 属性（正文里提到"星图"两个字无所谓）
 *    · `.js` / `.css` —— **不看全文**：`starmap/main.js` 的注释里就写着
 *      "starmap/data-layer.js"（`:64` `:465`），那是散文不是链接，扫全文必然误报。
 *  favicon `assets/starmap.ico` 也不算 —— 它没有斜杠，且课程页本来就用它。 */
function assertNoStarmapRefs(target) {
  const bad = [];
  for (const rel of walkFiles(target)) {
    if (!rel.endsWith('.html')) continue;
    const m = fs.readFileSync(path.join(target, rel), 'utf8').match(/(?:href|src)="[^"]*starmap\/[^"]*"/g);
    if (m) bad.push(`${rel}  ← ${m[0]}`);
  }
  if (bad.length) {
    throw new Error('星图已铺平到根、`starmap/` 不存在，但产物里仍有指向它的引用（访问会 404）：\n  ' + bad.join('\n  '));
  }
  return '产物里零 starmap/ 引用（html 的 href/src；favicon starmap.ico 不算）';
}

/** 铺平是**纯拷贝** —— 星图的每个文件在产物里必须与课程包里那份**逐字节相同**。
 *  这就是"效果要和我本地一样"的机械保证。
 *  默认档（进度中性化）`content.js` / `static.svg` / `index.html` 允许不同（那是有意的中性化）；
 *  `--include-progress` 时**一个都不许不同**（那正是"和我本地一样"）。 */
function assertStarmapByteIdentical(target) {
  const src = path.join(ROOT, 'starmap');
  const mutable = new Set(INCLUDE_PROGRESS ? [] : ['content.js', 'static.svg', 'index.html']);
  const bad = [];
  let same = 0;
  for (const rel of walkFiles(src)) {
    if (isExcluded('starmap/' + rel)) continue;
    const a = fs.readFileSync(path.join(src, rel));
    const b = fs.readFileSync(path.join(target, rel));
    if (a.equals(b)) { same++; continue; }
    if (mutable.has(rel)) continue;      // 有意改的
    bad.push(rel);
  }
  if (bad.length) {
    throw new Error('星图铺平后与课程包那份不一致（应当逐字节相同）：\n  ' + bad.join('\n  '));
  }
  return `星图 ${same} 个文件逐字节与本地相同`
    + (INCLUDE_PROGRESS ? '（--include-progress：一个都不许不同）' : '（+ content.js / static.svg / index.html 按中性化有意改过）');
}

/** T1 闭环：每张课程页的星图链接都已改写成根深链，且那个 `<id>` 在 content.js 里**查得到** */
function assertStarLinksRewritten(target) {
  const ids = new Set((loadStarmapContent(path.join(ROOT, 'starmap', 'content.js')).lessons || []).map((l) => l.id));
  const re = /href="([^"]*)#([^"]*)"[^>]*>\s*在星图中查看这一课/g;
  const bad = [];
  let n = 0;
  for (const rel of walkFiles(target)) {
    if (!rel.startsWith('lessons/') || !rel.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(target, rel), 'utf8');
    for (const m of html.matchAll(re)) {
      n++;
      if (m[1].includes('starmap')) bad.push(`${rel}  ← 没改写：${m[0].slice(0, 60)}`);
      else if (!ids.has(m[2])) bad.push(`${rel}  ← 深链 id「${m[2]}」在 content.js 里查不到`);
    }
  }
  if (!n) throw new Error('一张课程页里都没找到「在星图中查看这一课」链接 —— T1 断言空转了？');
  if (bad.length) throw new Error('课程页侧栏星图链接改写有问题：\n  ' + bad.join('\n  '));
  return `课程页侧栏星图链接 ${n} 处已改写成根深链，且深链 id 都能在 content.js 里查到`;
}

/** 中性化断言 —— 只在默认档（不带 `--include-progress`）有意义 */
function assertNeutralized(target) {
  const errs = [];
  const cj = path.join(target, 'content.js');
  const D = loadStarmapContent(cj);
  const lit = (D.lessons || []).filter((l) => l.learned).length;
  const flagged = (D.lessons || []).filter((l) => l.flag).length;
  const pending = (D.lessons || []).reduce((n, l) => n + (l.pendingQ || 0), 0);
  if (lit) errs.push(`content.js 仍有 ${lit} 课 learned=true`);
  if (flagged) errs.push(`content.js 仍有 ${flagged} 课带 flag`);
  if (pending) errs.push(`content.js pendingQ 合计 ${pending} ≠ 0`);
  if (fs.readFileSync(cj, 'utf8').includes('"learned": true')) errs.push('content.js 文本里仍出现 "learned": true');

  const page = fs.readFileSync(path.join(target, 'index.html'), 'utf8');
  const m = /aria-label="知识星图（静态版）：[^"]*已点亮\s*(\d+)/.exec(page);
  if (!m) errs.push('index.html 里找不到静态版 SVG 的 aria-label（标记区被动了？）');
  else if (m[1] !== '0') errs.push(`静态版 SVG 仍写「已点亮 ${m[1]}」`);

  const P = loadPractice(path.join(target, 'assets', 'practice-data.js'));
  const achieved = Object.values(P.lessons || {}).reduce((n, L) => n + ((L.summary && L.summary.achieved) || 0), 0);
  const notTodo = Object.values(P.lessons || {}).flatMap((L) => L.challenges || []).filter((c) => c.state !== 'todo').length;
  if (achieved) errs.push(`practice-data.js achieved 合计 ${achieved} ≠ 0`);
  if (notTodo) errs.push(`practice-data.js 有 ${notTodo} 题 state ≠ todo`);

  if (errs.length) throw new Error('中性化断言没过：\n  ' + errs.join('\n  '));
  return 'learned=0 · flag=null · pendingQ=0 · SVG 已点亮 0 · practice achieved=0';
}

/* ------------------------------------------------------------------ 构建 */

/** 本文件这一轮的断言结论（给控制台看；`verify` 的返回值过不去，所以落在模块作用域） */
let ASSERT_NOTES = [];

/** 最近一次发布的计划（断言里要报"排掉了多少私人面"） */
let LAST_PLAN = null;

function makePlan() {
  return PUB.planPublication(ROOT, { kind: 'public', includeProgress: INCLUDE_PROGRESS });
}

/** 断言全套。**全在产物换上去之前跑**（由 `applyPublication` 的 `verify` 钩子调用）——
 *  半成品 dist/ 是能被 rsync 直接推上生产的，所以"断言没过"绝不许把产物留下。 */
function assertProduct(target) {
  const notes = [];
  assertNoForbidden(target);
  notes.push(`反空转断言：产物里零 FORBIDDEN 路径（${FORBIDDEN.length} 条）`);
  notes.push('星图引用断言：' + assertNoStarmapRefs(target));
  notes.push('星图逐字节断言：' + assertStarmapByteIdentical(target));
  notes.push('星图深链断言：' + assertStarLinksRewritten(target));
  if (!INCLUDE_PROGRESS) notes.push('中性化断言：' + assertNeutralized(target));
  else notes.push('进度**显式保留**（--include-progress）：content.js / practice-data.js / static.svg / index.html 逐字节不动');

  // 反空转（T20）：本文件的白名单声明必须与发布策略**同值** —— 两处各写一份就是 D05 的病根
  const pol = PUB.publicationPolicy({ kind: 'public', includeProgress: INCLUDE_PROGRESS });
  if (JSON.stringify(WHITELIST) !== JSON.stringify(pol.publicTop)) {
    throw new Error('WHITELIST 与发布策略的白名单不一致：' + JSON.stringify(WHITELIST) + ' vs ' + JSON.stringify(pol.publicTop));
  }
  notes.push(`白名单与发布策略同值（${pol.publicTop.join(' · ')}）`);
  if (LAST_PLAN) {
    notes.push(`净化：排掉 ${LAST_PLAN.excluded.length} 项私人面 · 派生物 ${LAST_PLAN.derived.length} 件（planDigest ${LAST_PLAN.planDigest.slice(0, 12)}…）`);
  }
  ASSERT_NOTES = notes;
  return true;
}

/** 把产物建到 target（**不是 dist**）：净化拷贝 + 重建 + 断言都在里面，抛错就什么都不算数 */
function buildInto(target) {
  rmrf(target);
  const plan = makePlan();
  LAST_PLAN = plan;
  const r = PUB.applyPublication(ROOT, plan, {
    confirm: true,
    outDir: target,
    decorate: (dir) => {
      write(dir, '404.html', notFoundPage());
      write(dir, 'robots.txt', robotsTxt());
    },
    verify: assertProduct,
  });
  if (!r.ok) throw new Error(`发布失败（${r.code}）：${r.error}`);
  return ASSERT_NOTES;
}

/* -------------------------------------------------------------- 树对拍 */

function treeMap(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const rel of walkFiles(dir)) out.set(rel, fs.readFileSync(path.join(dir, rel)));
  return out;
}

function compareTrees(expectedDir, actualDir) {
  const e = treeMap(expectedDir), a = treeMap(actualDir);
  return {
    expected: e.size,
    actual: a.size,
    missing: [...e.keys()].filter((k) => !a.has(k)),
    extra: [...a.keys()].filter((k) => !e.has(k)),
    diff: [...e.keys()].filter((k) => a.has(k) && !e.get(k).equals(a.get(k))),
  };
}

/* ---------------------------------------------------------------- 入口 */

(function main() {
  // ⓪ --plan：只打印发布计划（一行 JSON），**不写盘**（T20 / D6）
  if (PLAN_ONLY) {
    const plan = makePlan();
    process.stdout.write(JSON.stringify(plan) + '\n');
    return;
  }

  // ① --verify：只验构建器（闸门用）。与 dist/ 存不存在、陈不陈旧都无关。
  if (VERIFY) {
    let notes;
    try { notes = buildInto(TMP); } finally { rmrf(TMP); }
    console.log('[public] ✅ 构建器自检通过（白名单 + 逐字节 + 深链 + 中性化断言）—— 未与 dist/ 对拍');
    for (const n of notes) console.log('  · ' + n);
    return;
  }

  // ② --check：与 dist/ 逐字节对拍（**发布前**用）。dist/ 不在就是没构建，直接红。
  if (CHECK) {
    if (!fs.existsSync(DIST)) {
      console.error('[public] ❌ dist/ 不存在 —— 先跑 node tools/build-public.js');
      process.exit(1);
    }
    // ⚠️ process.exit() 会跳过 finally —— 退出必须放在 try/finally **外面**，
    //    否则每次报漂移都会把临时目录留在工作区（已实测踩到）。
    let notes, d;
    try {
      notes = buildInto(TMP);
      d = compareTrees(TMP, DIST);
    } finally {
      rmrf(TMP);
    }
    if (d.missing.length || d.extra.length || d.diff.length) {
      console.error('[public] ❌ dist/ 与重建结果有漂移 —— 跑 node tools/build-public.js');
      if (d.missing.length) console.error('  产物里缺 ' + d.missing.length + ' 个：' + d.missing.slice(0, 8).join('、'));
      if (d.extra.length) console.error('  产物里多 ' + d.extra.length + ' 个：' + d.extra.slice(0, 8).join('、'));
      if (d.diff.length) console.error('  内容不同 ' + d.diff.length + ' 个：' + d.diff.slice(0, 8).join('、'));
      process.exit(1);
    }
    console.log('[public] ✅ dist/ 与重建结果逐字节一致（' + d.actual + ' 个文件）');
    for (const n of notes) console.log('  · ' + n);
    return;
  }

  // ③ 默认：**原子发布** —— 先建到暂存目录，断言全过了才换上去（换上去的原子性由
  //    `publish-policy.cjs#applyPublication` 保证：旧产物先挪走，新产物 rename 上去，
  //    失败就把旧的挪回来 ⇒ dist/ 逐字节不变）。
  // 为什么较这个真：半成品 dist/ 是能被 rsync 直接推上生产的 ——
  // 构建中途失败（白名单被放宽、断言没过、子进程挂了）绝不许留下它。
  const plan = makePlan();
  LAST_PLAN = plan;
  if (DIGEST_ARG && DIGEST_ARG !== plan.planDigest) {
    console.error(`[public] ❌ --plan-digest 与当下这份计划不符：给的是 ${DIGEST_ARG}，现在是 ${plan.planDigest}`);
    console.error('  先跑 node tools/build-public.js --plan 拿当下那一个。一个字节都没写。');
    process.exit(2);
  }
  if (CONFIRM) console.log(`[public] 已确认：planDigest ${plan.planDigest.slice(0, 12)}…`);
  const r = PUB.applyPublication(ROOT, plan, {
    confirm: true,
    outDir: DIST,
    decorate: (dir) => {
      write(dir, '404.html', notFoundPage());
      write(dir, 'robots.txt', robotsTxt());
    },
    verify: assertProduct,
  });
  if (!r.ok) {
    console.error(`[public] ❌ 发布失败（${r.code}）：${r.error}`);
    console.error('  dist/ **逐字节未变**（原子：先建暂存，断言全过了才换上去）。');
    process.exit(1);
  }
  console.log('[public] 产出 dist/（' + treeMap(DIST).size + ' 个文件）');
  for (const n of ASSERT_NOTES) console.log('  · ' + n);
  console.log('[public] 发布：node tools/build-public.js --check && 上传 dist/（见 nginx-lessons.conf 头部）');
})();
