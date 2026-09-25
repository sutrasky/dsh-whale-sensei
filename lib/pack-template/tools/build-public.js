#!/usr/bin/env node
/**
 * build-public.js — 公开站产物 `dist/`（`lessons.sutrasky.com`）
 * ------------------------------------------------------------------
 * 用法：node tools/build-public.js           写 dist/（原子：建到暂存目录，断言全过才换上去）
 *       node tools/build-public.js --verify  只验**构建器**（闸门用）：不碰 dist/
 *       node tools/build-public.js --check   与 dist/ **逐字节对拍**（发布前用；dist/ 不在即红）
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
 * **进度原样发布**（`NEUTRALIZE_PROGRESS = false`）：用户要「效果要和我本地一样」
 * 且「我上传再同步」—— 上传快照即本地状态。要退回"公开站不显示个人进度"，
 * 把它翻成 `true`（N1/N2/N4 一起生效）。
 *
 * 三条铁律，改这个文件前先读：
 *   1. **白名单，不是黑名单** —— 只有 WHITELIST（+ 星图）会进公开站。
 *      以后新增目录**默认不发布**（安全侧默认）。FORBIDDEN 只是"反空转"断言：
 *      白名单被谁悄悄放宽了，它立刻红。
 *   2. **裁剪只落在 dist/，源目录一个字节不改** —— 否则插件侧 `render-parity`
 *      与包侧 `gate.mjs` 的对拍契约会连带失效。
 *   3. **确定性**：同一份输入产出逐字节相同的 dist/（无时间戳、无随机、排序固定）。
 *      `--check` 的实现就是"重建到临时目录再逐字节对拍"，所以这条不是口号。
 *
 * 变换面（**只动 dist/ 拷贝**）：
 *   T1  课程页侧栏 `…starmap/#<id>` → `…#<id>`（星图已在站点根，`starmap/` 不存在）
 *   N1/N2  content.js 的 learned/pendingQ/flag          （仅 NEUTRALIZE_PROGRESS）
 *   N3     由中性化 content.js 重跑 build-starmap-svg.js（仅 NEUTRALIZE_PROGRESS）
 *   N4     practice-data.js 的完成度                    （仅 NEUTRALIZE_PROGRESS）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, '.tmp-public-build');
const TMP = path.join(ROOT, '.tmp-public-check');
const CHECK = process.argv.includes('--check');
const VERIFY = process.argv.includes('--verify');

const SITE = 'lessons.sutrasky.com';

/** **进度原样发布**（像本地一样）；`true` = 退回"公开站不显示个人进度"
 *  （用户 2026-09-22 之前选过「中性化」；现在改回原样，见文件头）。 */
const NEUTRALIZE_PROGRESS = false;

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
 *  `README.md` 是开发文档，漏进产物就是上面那条排除规则失效。 */
const FORBIDDEN = [
  'code', 'learning-records', 'questions', 'notes', 'tools', '_plugin-prep',
  'demo', 'skill-draft', '_starmap-proto', '.backup', '.git', '.agent-teams',
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

/** 把 srcDir 的文件拷进 destDir（保留相对结构），跳过 EXCLUDE_RULES。
 *  relPrefix 用来给排除规则判"相对课程包根"的路径。返回拷了几个文件。 */
function copyTreeInto(srcDir, destDir, relPrefix) {
  let n = 0;
  for (const rel of walkFiles(srcDir)) {
    const relRoot = relPrefix ? relPrefix + '/' + rel : rel;
    if (isExcluded(relRoot)) continue;
    const dst = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), dst);
    n++;
  }
  return n;
}

/** 把 srcDir 的每个条目**上提一层**到 destDir，然后删掉 srcDir。
 *  用在这儿：`target/starmap/*` → `target/*`（星图就是主页）。 */
function flattenUp(srcDir, destDir) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true }).sort(byName)) {
    fs.renameSync(path.join(srcDir, e.name), path.join(destDir, e.name));
  }
  fs.rmdirSync(srcDir);
}

/* ------------------------------------------------------- T1：星图链接改写 */

/** 星图已在站点根 —— 课程页侧栏那句「在星图中查看这一课 →」原本是
 *      href="../../../starmap/#spring-boot/0001"
 *  现在 `starmap/` 不存在了（会 404），改指站点根的深链
 *      href="../../../#spring-boot/0001"      （= `/#spring-boot/0001`）
 *  `main.js` 的 deepLink() 读 `location.hash`，语义一字不变。
 *  实测三张课程页各一处。**只动 dist/ 拷贝，源文件一字不改**。 */
const STARLINK_RE = /href="([^"]*)starmap\/#([^"]*)"/g;

function rewriteStarmapLinks(html) { return html.replace(STARLINK_RE, 'href="$1#$2"'); }

/* ------------------------------------------------------------ 中性化 N1/N2 */

/** 读 starmap/content.js（它自己给 window.STARMAP_REAL 赋值） */
function loadStarmapContent(file) {
  const window = {};
  new Function('window', fs.readFileSync(file, 'utf8'))(window);
  if (!window.STARMAP_REAL) throw new Error('读不到 window.STARMAP_REAL：' + file);
  return window.STARMAP_REAL;
}

function neutralizeContent(srcFile) {
  const D = loadStarmapContent(srcFile);
  let wasLit = 0, wasFlag = 0, wasQ = 0;
  for (const l of D.lessons || []) {
    if (l.learned) wasLit++;
    if (l.flag) wasFlag++;
    if (l.pendingQ) wasQ++;
    l.learned = false;
    l.pendingQ = 0;
    l.flag = null;
  }
  const text = '// 由 tools/build-public.js 中性化生成 —— 不要手改。\n'
    + '// 公开站不发布学习进度：learned 全 false · pendingQ 全 0 · flag 全 null。\n'
    + '// 未中性化的真源是课程包里的 starmap/content.js（由 tools/build-starmap.js 生成）。\n'
    + 'window.STARMAP_REAL = ' + JSON.stringify(D, null, 2) + ';\n';
  return { text, note: `learned ${wasLit}→0 · flag ${wasFlag}→null · pendingQ ${wasQ}→0` };
}

/* -------------------------------------------------------------- 中性化 N4 */

/** 读 practice-data.js —— 两种形态都要能读：
 *    ① 真源是 UMD（走 module.exports 分支）
 *    ② 中性化版直接给 window.PRACTICE_DATA 赋值
 */
function loadPractice(file) {
  const m = { exports: {} };
  const win = {};
  new Function('module', 'globalThis', 'window', fs.readFileSync(file, 'utf8'))(m, win, win);
  const D = (m.exports && m.exports.lessons) ? m.exports : win.PRACTICE_DATA;
  if (!D || !D.lessons) throw new Error('读不到 PRACTICE_DATA：' + file);
  return D;
}

function neutralizePractice(srcFile) {
  const D = loadPractice(srcFile);
  let wasAchieved = 0, wasReview = 0, wasDone = 0;
  for (const key of Object.keys(D.lessons)) {
    const L = D.lessons[key];
    if (L.summary) {
      wasAchieved += L.summary.achieved || 0;
      wasReview += L.summary.needsReview || 0;
      L.summary.achieved = 0;
      L.summary.needsReview = 0;   // total 不动 —— 那是课程属性，不是学生进度
    }
    for (const c of L.challenges || []) {
      if (c.state !== 'todo') wasDone++;
      c.state = 'todo';            // 未开始版：每题一律"未达成"
    }
  }
  D.source = '公开站：未开始版（进度已中性化；真源是 learning-records/state.json）';
  const text = '/**\n'
    + ' * practice-data.js —— 公开站「未开始」版（由 tools/build-public.js 中性化生成）\n'
    + ' * ------------------------------------------------------------------\n'
    + ' * 真源由插件 `whale_practice` 从学生工作区扫出；公开站不发布个人完成度，\n'
    + ' * 这里把 achieved / needsReview 归零、每题 state 一律 todo。\n'
    + ' * `missing` / `why` 保留 —— 那是**课程判据**（EXPECT.json 派生），不是个人数据。\n'
    + ' */\n'
    + 'window.PRACTICE_DATA = ' + JSON.stringify(D, null, 2) + ';\n';
  return { text, note: `achieved 合计 ${wasAchieved}→0 · needsReview ${wasReview}→0 · ${wasDone} 题由 done/review→todo` };
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
 *  NEUTRALIZE_PROGRESS 时 `content.js` / `static.svg` / `index.html` 允许不同（那是有意的中性化）。 */
function assertStarmapByteIdentical(target) {
  const src = path.join(ROOT, 'starmap');
  const mutable = new Set(['content.js', 'static.svg', 'index.html']);
  const bad = [];
  let same = 0;
  for (const rel of walkFiles(src)) {
    if (isExcluded('starmap/' + rel)) continue;
    const a = fs.readFileSync(path.join(src, rel));
    const b = fs.readFileSync(path.join(target, rel));
    if (a.equals(b)) { same++; continue; }
    if (NEUTRALIZE_PROGRESS && mutable.has(rel)) continue;      // 有意改的
    bad.push(rel);
  }
  if (bad.length) {
    throw new Error('星图铺平后与课程包那份不一致（应当逐字节相同）：\n  ' + bad.join('\n  '));
  }
  return `星图 ${same} 个文件逐字节与本地相同`
    + (NEUTRALIZE_PROGRESS ? '（+ content.js / static.svg / index.html 按中性化有意改过）' : '');
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

/** 中性化断言 —— 只在 NEUTRALIZE_PROGRESS 时有意义 */
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

/** 把产物建到 target（**不是 dist**）—— 断言全在里面，抛错就什么都不算数 */
function buildInto(target) {
  rmrf(target);
  fs.mkdirSync(target, { recursive: true });
  const notes = [];

  // 1) 星图 → 站点根：先按 `starmap/` 形状建（好让 build-starmap-svg.js 的 `--root` 契约能用），
  //    中性化完再**铺平**到 target 根。
  const sm = path.join(target, 'starmap');
  const nSm = copyTreeInto(path.join(ROOT, 'starmap'), sm, 'starmap');
  notes.push(`星图 ${nSm} 个文件 → 站点根（index.html 即主页）`);

  if (NEUTRALIZE_PROGRESS) {
    const c = neutralizeContent(path.join(sm, 'content.js'));
    fs.writeFileSync(path.join(sm, 'content.js'), c.text, 'utf8');
    notes.push('content.js：' + c.note);
    // ⚠️ stdio 必须 inherit：本机沙箱不允许子进程走管道（EPERM），捕获输出会让这一步
    //    直接失败（status=null / error.code=EPERM）。子进程自己会打印它的结论。
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-starmap-svg.js'), '--root=' + target], {
      cwd: ROOT, stdio: 'inherit',
    });
    // 子进程**没起来**（EPERM / ENOENT）时 status 是 null —— 说「脚本失败（exit null）」会把人指向错的修法
    if (r.error) {
      throw new Error('起不了子进程：' + (r.error.code || r.error.message)
        + '（权限/沙箱边界）—— 这不是「命令没跑」也不是代码坏了。'
        + '出路：① 改 stdio:\'inherit\'（本处已是）② 结果写文件再读 ③ 在无沙箱环境跑。');
    }
    if (r.status !== 0) {
      throw new Error('build-starmap-svg.js 失败（exit ' + r.status + '）');
    }
    notes.push('重跑 build-starmap-svg.js（--root=产物目录）→ static.svg + index.html 内联 SVG');
  } else {
    notes.push('进度**原样发布**（像本地一样）—— content.js / static.svg / index.html 逐字节不动');
  }

  flattenUp(sm, target);
  notes.push('星图铺平到站点根（`starmap/` 不复存在）');

  // 2) 其余白名单（排序固定 → 确定性）
  let copied = 0;
  for (const top of WHITELIST) {
    const abs = path.join(ROOT, top);
    if (!fs.existsSync(abs)) throw new Error('白名单目录不存在：' + top);
    copied += copyTreeInto(abs, path.join(target, top), top);
  }
  notes.push(`白名单拷贝 ${copied} 个文件（${WHITELIST.join(' · ')}；排除 ${EXCLUDE_RULES.length} 类）`);

  // 2b) 顶层**单文件**：GLOSSARY.md 是名词地图 <noscript> 的纯文本退路，也是课程页正文里
  //     「名词速查笔记 GLOSSARY.md」那几个链接的落点。它不在任何白名单**目录**里，
  //     漏掉就是线上 404 —— 而本地因为文件就在包根，怎么点都好好的（只有线上才现形）。
  {
    const rel = 'GLOSSARY.md';
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) throw new Error('缺 ' + rel + '（名词地图的纯文本退路，拒绝静默少一份）');
    fs.copyFileSync(src, path.join(target, rel));
    notes.push('顶层单文件 ' + rel + '（名词退路 + 课程页里的速查链接落点）');
  }

  // 3) T1：课程页侧栏的星图链接 → 站点根深链
  let rewritten = 0;
  for (const rel of walkFiles(target)) {
    if (!rel.startsWith('lessons/') || !rel.endsWith('.html')) continue;
    const abs = path.join(target, rel);
    const before = fs.readFileSync(abs, 'utf8');
    const after = rewriteStarmapLinks(before);
    if (after !== before) {
      fs.writeFileSync(abs, after, 'utf8');
      rewritten += (before.match(STARLINK_RE) || []).length;
    }
  }
  notes.push(`课程页侧栏星图链接改写 ${rewritten} 处：…starmap/#<id> → …#<id>（星图已在站点根）`);

  // 4) N4：practice 中性化（仅 NEUTRALIZE_PROGRESS）
  if (NEUTRALIZE_PROGRESS) {
    const p = neutralizePractice(path.join(ROOT, 'assets', 'practice-data.js'));
    write(target, 'assets/practice-data.js', p.text);
    notes.push('practice-data.js：' + p.note);
  } else {
    notes.push('practice-data.js 原样发布（与星图的点亮状态保持一致）');
  }

  // 5) 生成页
  write(target, '404.html', notFoundPage());
  write(target, 'robots.txt', robotsTxt());
  notes.push('404.html · robots.txt（主页是星图本身，不另生成）');

  // 6) 断言
  assertNoForbidden(target);
  notes.push(`反空转断言：产物里零 FORBIDDEN 路径（${FORBIDDEN.length} 条）`);
  notes.push('星图引用断言：' + assertNoStarmapRefs(target));
  notes.push('星图逐字节断言：' + assertStarmapByteIdentical(target));
  notes.push('星图深链断言：' + assertStarLinksRewritten(target));
  if (NEUTRALIZE_PROGRESS) notes.push('中性化断言：' + assertNeutralized(target));

  return notes;
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
  // ① --verify：只验构建器（闸门用）。与 dist/ 存不存在、陈不陈旧都无关。
  if (VERIFY) {
    let notes;
    try { notes = buildInto(TMP); } finally { rmrf(TMP); }
    console.log('[public] ✅ 构建器自检通过（白名单 + 逐字节 + 深链断言）—— 未与 dist/ 对拍');
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

  // ③ 默认：**原子发布** —— 先建到暂存目录，断言全过了才换上去。
  // 为什么较这个真：半成品 dist/ 是能被 rsync 直接推上生产的 ——
  // 构建中途失败（白名单被放宽、断言没过、子进程挂了）绝不许留下它。
  try {
    const notes = buildInto(STAGE);
    rmrf(DIST);
    fs.renameSync(STAGE, DIST);
    console.log('[public] 产出 dist/（' + treeMap(DIST).size + ' 个文件）');
    for (const n of notes) console.log('  · ' + n);
    console.log('[public] 发布：node tools/build-public.js --check && 上传 dist/（见 nginx-lessons.conf 头部）');
  } finally {
    rmrf(STAGE);
  }
})();
