#!/usr/bin/env node
/**
 * publish-policy.cjs — 发布（离线 payload / 公开站）的**唯一策略源**（T20 / 报告 D05）
 * ------------------------------------------------------------------
 * 病（报告 D05）："发布产物里哪些是私人面"原先在**两处各写一套**，谁也管不着谁：
 *
 *   · `tools/offline-bootstrap.js#planSkeleton()` 把 `questions/` `notes/` `learning-records/`
 *     整棵目录收进骨架清单（`SKELETON` 里只有 `tools/` 那一支有 `TOOLS_KEEP` 过滤）
 *     ⇒ 离线 payload 的 `app/` 带着作者的全本私人台账（实测：活包的
 *     `dist-offline/whale-reader/app/questions/processed.jsonl` 673 字节、
 *     `app/notes/fix-2026-09-20-summary.md` 5063 字节、`app/learning-records/` 9 个文件全在）。
 *   · `tools/build-public.js` 的 `WHITELIST` 含 `reference/`（私人派生页 `NOTES.html` 原样进
 *     `dist/`）、且 `NEUTRALIZE_PROGRESS = false`（进度原样发布）——
 *     实测活包 `dist/assets/questions-data.js` 与 `dist/reference/NOTES.html` 与源包逐字节相同。
 *
 * 本文件把那两边的判断**收成一份**（`PUBLISH_KINDS` / `PRIVATE_SURFACES` / 派生物表），
 * 两个构建器都只能从这里取：
 *
 *   ① `planPublication(root, {kind, includeProgress})` —— **只算不写**：
 *        产物文件全集 `files` + 被排掉的私人面 `excluded`（逐条给 why）+ 派生物 `derived`
 *        + `planDigest`（对规范 JSON 算 sha256；**不含 root、不含时间戳** ⇒ 同一输入恒同）。
 *   ② `applyPublication(root, plan, {confirm:true, ...})` —— **先建暂存再原子换上去**：
 *        核 `confirm`、当下**重算** `planDigest` 与提交的那份比对（不一致 ⇒ `PLAN_STALE`），
 *        验证产物文件全集与 `files` 逐项相等、跑调用方的 `verify()`，
 *        全过了才换；任何一步失败 ⇒ **既有产物逐字节不变**，**源包一个字节不改**。
 *   ③ 净化链：先在**临时副本**（`<root>/.tmp-publication-<pid>/input`）里把私人面
 *      **清空 / 中性化 / 用包内自己的生成器重建**，再按清单拷进产物。
 *      为什么必须是副本：`tools/build-notes.js` / `build-starmap-svg.js` 都**写包根**
 *      （`__dirname/..`），在源包上跑就等于改了源包 —— 那是本卡明令禁止的。
 *
 * 「排掉」的判据口径（D3）：**产物全文里零 canary 命中**，不是"文件名不在清单里"。
 * 所以 `reference/NOTES.html` / `assets/questions-data.js` / `assets/practice-data.js` /
 * `starmap/content.js` / `starmap/{index.html,static.svg}` **只从净化输入重建**，绝不原样拷。
 *
 * ── 依赖纪律（D1）──────────────────────────────────────────────────────────────
 * 只 require Node **内建**模块，不 require 任何包外 / 仓外文件：
 *   · `node:fs` / `node:path` —— 清单与净化；
 *   · `node:crypto` —— `planDigest` 要 sha256（D2 明写"对规范 JSON 算 sha256"）；
 *   · `node:child_process` —— 派生物必须由**包内自己的生成器真跑**重建成（D7：不许手工补件）；
 *     `stdio` 必须 `'inherit'`（本机沙箱下 piped stdio 的 spawnSync 会被 EPERM 拒，既有注释已写明），
 *     子进程 `status !== 0` **如实失败**，不吞。
 * 也不写机器专属路径 / 兄弟仓名（`test/pack-scaffold.mjs` ① 与 `test/alien-env.mjs` 都扫模板目录）。
 *
 * ── 接口（D1/D2 逐字）─────────────────────────────────────────────────────────
 *   planPublication(root, {kind:'reader'|'public', includeProgress?:boolean, withNode?:boolean})
 *     -> { schema, root, kind, includeProgress, files, excluded, derived, planDigest }
 *   applyPublication(root, plan, {confirm:true, outDir?, decorate?, verify?, withNode?})
 *     -> { ok:true, kind, planDigest, files, excluded, derived, outDir }
 *      |  { ok:false, code:'CONFIRM_REQUIRED'|'PLAN_REQUIRED'|'PLAN_STALE'|'STAGE_FAILED'|..., error }
 *   publicationPolicy({kind?, includeProgress?}) -> 生效策略（私人面表 / 白名单 / 派生物表 / 产物根）
 *   PUBLISH_KINDS = ['reader', 'public']
 *
 * `files` 的口径（**逐字**）：**产物里最终存在的文件全集**，POSIX 相对路径、升序、无重复。
 *   · `public` 档相对产物根 `dist/`（星图**铺平**到站点根 ⇒ `starmap/index.html` 记作 `index.html`）；
 *   · `reader` 档相对 payload 根 `dist-offline/whale-reader/`（包内容在 `app/**`，
 *     运行期与安装脚本同层）—— 这样 `files` 对两档都**字面等于**产物文件全集（A10 的判据）。
 *
 * `excluded` 只点名**源包里真实存在**的私人面（每条带 why），升序；目录与目录下的具体文件都点。
 * `derived` 是 `files` 的子集，逐条给 `from`（由谁重建）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/**
 * 共同提交守卫（U06）—— 三闸与七态/锁/日志的**唯一实现**（包侧同目录 `./unify/commit.cjs`，
 * 由 U19 逐字节生成；本文件**不建**第二套计划/日志/锁）。
 */
const COMMIT = require('./unify/commit.cjs');
/**
 * 包级事务件（**同目录**）。`commit.cjs` 的默认实现按**仓内布局**解析事务件
 * （`lib/unify/commit.cjs` → `../pack-template/tools/ledger-transaction.cjs`）；包侧副本落在
 * `<包>/tools/unify/commit.cjs` 时那条相对路径不成立，所以这里**显式注入**同目录的这份
 * （与插件侧同一个事务件、同一把锁、同一份 `whale-txn/1` 日志 —— 不是第二套）。
 */
const LEDGER_TXN = require('./ledger-transaction.cjs');

const SCHEMA = 'whale-publication/1';
const PUBLISH_KINDS = ['reader', 'public'];

/** 离线 payload 的包内容子目录（`app/tools/offline-server.js` 的 `__dirname/..` = `app/`） */
const READER_APP = 'app';

/** 公开站的顶层白名单（与 `tools/build-public.js#WHITELIST` **必须同值**，那边有判据钉住） */
const PUBLIC_TOP = ['lessons', 'assets', 'reference', 'glossary'];
/** 顶层单文件（名词地图的纯文本退路 + 课程页速查链接的落点） */
const PUBLIC_FILES = ['GLOSSARY.md'];
/** 白名单内部的排除（相对课程包根，posix）—— 与 `build-public.js#EXCLUDE_RULES` 同一条口径 */
const PUBLIC_DROP = [
  { re: /^lessons\/src(\/|$)/, why: '作者态源（含未填的 {{槽位}}，不是可发布页面）' },
  { re: /^assets\/_/, why: '内部模板与开发样例页（assets/_frame · _style-sample · _figure-lab）' },
  { re: /^starmap\/README\.md$/, why: '星图的开发文档（不是页面资源）' },
];

/** 公开站的两张生成页（由 `tools/build-public.js` 写；策略只登记**名字**，好让 files 精确） */
const PUBLIC_GENERATED = ['404.html', 'robots.txt'];
/** 离线 payload 的包装件（由 `tools/build-offline-payload.js` 写；同上，策略只登记名字） */
const READER_GENERATED = [
  'start.cmd', 'install.cmd', 'uninstall.cmd', 'install.ps1', 'uninstall.ps1', 'admin-source.json',
  // T28 / 报告 G03（T28-A1 + T28-A2 条件授权，只加登记行）：
  //   · 分发材料回执 —— 正式构建记 mode=public/verified=true，`--no-node` 记 mode=dev/verified=false；
  //   · 许可**聚合件** —— 正式构建把 manifest 里每项的许可正文按固定节头聚合进这一个固定名，
  //     不再往 payload 根拷**动态 basename**（那种名字不可能预先登记，必然撞 A10 的"产物全集 == plan.files"）。
  'distribution-receipt.json',
  'LICENSES.txt',
];
/** 自带运行期（`--no-node` 时不带） */
const READER_NODE = ['node.exe'];
/** Node 的 MIT 许可（可再分发要求；源包里没有那一份就不登记 —— 构建器会如实 warn） */
const READER_LICENSE = 'LICENSE-node.txt';

/**
 * 私人面（D3）—— **必须被排掉，且不许以任何形式留在产物里**（判据 = 产物全文零 canary 命中）。
 *
 * 这张表是私人面的**唯一真源**：`excluded` 报告、"净化输入"该跳过 / 中性化 / 重建哪一件、
 * 以及派生物表 —— **都只从 `mode` 派生**（表里挖掉一类，产物行为当场跟着变；这是 T20 的
 * 反空转判据，不是"只影响一份报告"）。
 *
 *   mode = 'drop'                —— 原样绝不出现（目录 / 本机配置 / 答疑文档）
 *          'empty-ledger'        —— 重建为**空台账**（答疑台账：条目是私人正文）
 *          'rebuild-notes'       —— 由包内生成器从**净化输入**重建（私人派生页）
 *          'neutralize-practice' —— 中性化完成度（进度载体）
 *          'neutralize-progress' —— 中性化 learned/pendingQ/flag（进度载体）
 *   dir:true   = 整棵目录
 *   progress   = 进度载体（`includeProgress:true` 时按 `keepWhenProgress` 处理）
 *   keepWhenProgress = 显式保留进度时**原样带上**（只对离线档的 `progress.json` 成立；
 *                      公开站结构上没有它）
 */
const PRIVATE_SURFACES = [
  { p: 'questions', dir: true, mode: 'drop', why: '私人原账（待答 / 已答 / seq.txt）' },
  { p: 'notes', dir: true, mode: 'drop', why: '私人原账（学生笔记原账 / seq.txt）' },
  { p: 'learning-records', dir: true, mode: 'drop', why: '私人原账（摸底 / 终点 / 教学 / 证据 / 调整 / state.json / 学习记录）' },
  { p: 'code', dir: true, mode: 'drop', why: '学生自己的代码与 EXPECT.json' },
  { p: 'progress.json', mode: 'drop', progress: true, keepWhenProgress: true, why: '学习进度（本机进度载体；公开站不带，离线档只在显式 --include-progress 时保留）' },
  { p: 'lesson.config.json', mode: 'drop', why: '本机配置' },
  { p: 'reference/QUESTIONS.md', mode: 'drop', why: '答疑文档（私人；本卡产物不带）' },
  { p: 'QUESTIONS.md', mode: 'drop', why: '答疑文档（私人；本卡产物不带）' },
  { p: 'assets/questions-data.js', mode: 'empty-ledger', why: '已答正文 / HTML 台账的产物级真源 —— 只能从净化输入重建为空台账' },
  { p: 'reference/NOTES.html', mode: 'rebuild-notes', why: '私人派生页（答疑 + 我的笔记）—— 只能从净化输入重建，不许原样拷' },
  { p: 'assets/practice-data.js', mode: 'neutralize-practice', progress: true, why: '实践完成度（本机进度载体）—— 只能从净化输入中性化' },
  { p: 'starmap/content.js', mode: 'neutralize-progress', progress: true, why: '星图载荷（learned / pendingQ / flag —— 本机进度载体）' },
];

/** 派生物表：`mode → 由谁重建`（`derived` 逐条给 `from`；也因此这张表只有一份） */
const DERIVED_FROM = {
  'empty-ledger': 'publish-policy.cjs:empty-ledger',
  'rebuild-notes': 'tools/build-notes.js',
  'neutralize-practice': 'publish-policy.cjs:neutralize-practice',
  'neutralize-progress': 'publish-policy.cjs:neutralize-progress',
};

/** 星图的**静态快照件**：内容里烘着"已点亮几颗"（`static.svg` 与内联了它的 `index.html`）——
 *  不是私人面（路径本身可以发布），但默认档必须由 `tools/build-starmap-svg.js` 从**中性化后**
 *  的 `content.js` 重跑一遍。 */
const STARMAP_SNAPSHOT = ['starmap/index.html', 'starmap/static.svg'];

/** 结构性排除（构建产物 / 版本库 / 事务落点）—— 顺带点名，让"哪天白名单被放宽"当场撞上 */
const STRUCTURAL_EXCLUDES = [
  { p: 'dist', why: '构建产物（公开站）' },
  { p: 'dist-offline', why: '构建产物（离线 payload）' },
  { p: '.backup', why: '备份目录' },
  { p: '.git', why: '版本库' },
  { p: '.trash', why: '回收站' },
  { p: '.whale-txn', why: '包级事务的日志落点' },
  { p: '.whale-write.lock', why: '包级写锁' },
  { p: 'node_modules', why: '依赖目录' },
];

/* ─────────────────────────────────────────────────────────────── 小工具 */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isUnder = (rel, p) => rel === p || rel.startsWith(p + '/');
const rmrf = (p) => { if (exists(p)) fs.rmSync(p, { recursive: true, force: true }); };

function walkFiles(dir, prefix = '') {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.slice().sort((a, b) => cmp(a.name, b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function writeFileAt(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

/**
 * 读一个**同目录**的 CommonJS 件并求值。
 * ------------------------------------------------------------------
 * 为什么不用 `require()`：`lib/pack-template/tools/*.js` 在**仓内**会被 Node 当成 ESM
 * （仓根 `package.json` 有 `"type": "module"`），`require('./offline-bootstrap.js')` 直接抛
 * `require is not defined in ES module scope`；而同一个文件躺在**课程包里**（没有那份
 * package.json）时它就是普通 CJS。同一个文件两种身份 —— 所以这里显式按 CJS 求值，
 * 两种环境下行为一致（骨架这块只用它 `module.exports` 上的纯函数）。
 */
function loadSiblingCjs(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);              // BOM
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);  // shebang（CJS loader 会剥，这里也要剥）
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', src);
  fn(m, m.exports, require, path.dirname(file), file);
  return m.exports;
}

function copyFileAt(srcRoot, destRoot, rel) {
  const to = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(srcRoot, rel), to);
}

/** 有没有"课程源"（`build-notes.js` 的 hasCourse 判据，**逐字同一口径**） */
function hasCourseSource(srcDir) {
  if (!exists(srcDir)) return false;
  const any = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    return es.some((e) => (e.isDirectory() ? any(path.join(d, e.name)) : /^\d{4}-.*\.html$/.test(e.name)));
  };
  return any(srcDir);
}

/* ─────────────────────────────────────────────────────── 参数与策略生效 */

function normalizeKind(raw) {
  const kind = raw === undefined || raw === null || raw === '' ? 'reader' : String(raw);
  if (!PUBLISH_KINDS.includes(kind)) {
    throw new Error(`planPublication：不认识的 kind（${kind}）—— 只认 ${PUBLISH_KINDS.join(' / ')}。绝不静默按 reader 办。`);
  }
  return kind;
}

/** 生效策略（私人面 / 白名单 / 派生物表 / 产物根）—— 只报事实，不读盘、不写盘 */
function publicationPolicy(opts = {}) {
  const kind = normalizeKind(opts.kind);
  const includeProgress = opts.includeProgress === true;
  return {
    schema: SCHEMA,
    kind,
    includeProgress,
    outDir: kind === 'public' ? 'dist' : path.posix.join('dist-offline', 'whale-reader'),
    appDir: kind === 'reader' ? READER_APP : null,
    publicTop: PUBLIC_TOP.slice(),
    publicFiles: PUBLIC_FILES.slice(),
    publicDrop: PUBLIC_DROP.map((r) => ({ why: r.why })),
    privateSurfaces: PRIVATE_SURFACES.map((s) => ({ path: s.p, why: s.why, dir: !!s.dir, progress: !!s.progress, mode: s.mode })),
    structuralExcludes: STRUCTURAL_EXCLUDES.map((s) => ({ path: s.p, why: s.why })),
    derivedProducers: { ...DERIVED_FROM, 'starmap/index.html': 'tools/build-starmap-svg.js', 'starmap/static.svg': 'tools/build-starmap-svg.js' },
  };
}

/** 这条私人面在当前档位**真的**被排掉了吗（进度载体在显式保留时不排） */
function isExcluded(policy, s) {
  if (!s.progress) return true;
  if (!policy.includeProgress) return true;
  // 显式保留进度：离线档可以带 `progress.json`；`content.js` / `practice-data.js` 两档都保留内容。
  if (s.keepWhenProgress) return policy.kind !== 'reader';
  return false;
}

/** 私人面表里的某一条（按源包相对路径）—— 表就是真源，净化 / 派生 / 报告都走它 */
const surfaceOf = (rel) => PRIVATE_SURFACES.find((s) => !s.dir && s.p === rel) || null;

/**
 * 计划身份里**不许**出现的瞬时件：包级写锁与事务日志的"在不在"取决于**此刻有没有人在写**。
 * 把它们算进 `excluded`（进而算进 `policyDigest` / `planDigest`），同一个计划的"持锁复核"
 * 就必然发现多出一条 `excluded` ⇒ 恒 `PLAN_STALE`（实测 public 档：计划 63 files / excluded 116，
 * 复核时 excluded 变成 117，多出来的正是 `.whale-write.lock`）。
 * 它们本来也不进任何产物清单（`isStructural` 先挡掉了），所以这里只是把"瞬时"从身份里摘出去。
 */
const TRANSIENT_EXCLUDES = new Set(['.whale-txn', '.whale-write.lock']);

function excludedFor(root, policy) {
  const out = [];
  for (const s of STRUCTURAL_EXCLUDES) {
    if (TRANSIENT_EXCLUDES.has(s.p)) continue;   // 瞬时件不进计划身份（见上面那条注释）
    if (exists(path.join(root, s.p))) out.push({ path: s.p, why: s.why });
  }
  for (const s of PRIVATE_SURFACES) {
    if (!isExcluded(policy, s)) continue;
    const abs = path.join(root, s.p);
    if (!exists(abs)) continue;
    out.push({ path: s.p, why: s.why });
    if (s.dir) {
      for (const rel of walkFiles(abs)) out.push({ path: `${s.p}/${rel}`, why: s.why });
    }
  }
  return out;
}

/** 结构性 / 临时目录（净化输入一律不拷；它们不在任何产物清单里） */
function isStructural(rel) {
  const top = rel.split('/')[0];
  if (STRUCTURAL_EXCLUDES.some((s) => s.p === top)) return true;
  if (top.startsWith('.') || top.startsWith('_')) return true;
  return false;
}

/* ───────────────────────────────────────────────────── 净化（在临时副本里） */

/** 读 `starmap/content.js`（它自己给 window.STARMAP_REAL 赋值） */
function loadStarmapContent(file) {
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function('window', fs.readFileSync(file, 'utf8'))(window);
  if (!window.STARMAP_REAL) throw new Error('读不到 window.STARMAP_REAL：' + file);
  return window.STARMAP_REAL;
}

/** 进度中性化 N1/N2：learned 全 false · pendingQ 全 0 · flag 全 null */
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
  const text = '// 由 tools/publish-policy.cjs 中性化生成 —— 不要手改。\n'
    + '// 发布产物不携带学习进度：learned 全 false · pendingQ 全 0 · flag 全 null。\n'
    + '// 未中性化的真源是课程包里的 starmap/content.js（由 tools/build-starmap.js 生成）。\n'
    + 'window.STARMAP_REAL = ' + JSON.stringify(D, null, 2) + ';\n';
  return { text, note: `learned ${wasLit}→0 · flag ${wasFlag}→null · pendingQ ${wasQ}→0` };
}

/** 读 practice-data.js —— 两种形态都要能读（UMD 走 module.exports；中性化版直接给 window 赋值） */
function loadPractice(file) {
  const m = { exports: {} };
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('module', 'globalThis', 'window', fs.readFileSync(file, 'utf8'))(m, win, win);
  const D = (m.exports && m.exports.lessons) ? m.exports : win.PRACTICE_DATA;
  if (!D || !D.lessons) throw new Error('读不到 PRACTICE_DATA：' + file);
  return D;
}

/** 进度中性化 N4：achieved / needsReview 归零、每题 state = todo（`total` / `missing` 是课程属性，保留） */
function neutralizePractice(srcFile) {
  const D = loadPractice(srcFile);
  let wasAchieved = 0, wasReview = 0, wasDone = 0;
  for (const key of Object.keys(D.lessons)) {
    const L = D.lessons[key];
    if (L.summary) {
      wasAchieved += L.summary.achieved || 0;
      wasReview += L.summary.needsReview || 0;
      L.summary.achieved = 0;
      L.summary.needsReview = 0;
    }
    for (const c of L.challenges || []) {
      if (c.state !== 'todo') wasDone++;
      c.state = 'todo';
    }
  }
  D.source = '发布产物：未开始版（进度已中性化；真源是 learning-records/state.json）';
  const text = '/**\n'
    + ' * practice-data.js —— 发布产物「未开始」版（由 tools/publish-policy.cjs 中性化生成）\n'
    + ' * ------------------------------------------------------------------\n'
    + ' * 真源由插件 `whale_practice` 从学生工作区扫出；发布产物不携带个人完成度，\n'
    + ' * 这里把 achieved / needsReview 归零、每题 state 一律 todo。\n'
    + ' * `missing` / `why` 保留 —— 那是**课程判据**（EXPECT.json 派生），不是个人数据。\n'
    + ' */\n'
    + 'window.PRACTICE_DATA = ' + JSON.stringify(D, null, 2) + ';\n';
  return { text, note: `achieved 合计 ${wasAchieved}→0 · needsReview ${wasReview}→0 · ${wasDone} 题由 done/review→todo` };
}

/**
 * 把答疑台账**清成空**：保留头注释、UMD 闭包与**收尾锚点**（写入口 `insertLedgerEntry` 靠它），
 * 只把条目整段拿掉。收尾锚点从**源文件自己**里取（不在这儿抄第二份锚点常量 —— 抄了就会漂）。
 */
function emptyLedgerSourceFrom(text) {
  const src = String(text);
  const anchor = '\n  };\n});';
  const at = src.lastIndexOf(anchor);
  if (at < 0) throw new Error('台账结构不认识：找不到收尾锚点 —— 不敢改（宁可不发布，也不原样带出去）');
  const head = src.slice(0, at);
  const r = head.lastIndexOf('return {');
  if (r < 0) throw new Error('台账结构不认识：连 `return {` 都找不到 —— 不敢改');
  return head.slice(0, r + 'return {'.length)
    + '\n    // 净化：私人答疑台账不进入发布产物（由 tools/publish-policy.cjs 重建为空台账）'
    + src.slice(at);
}

/* ───────────────────────────────────────────────────────────────── 清单 */

/** 表里说要"从净化输入重建"的那一件吗（没有表项 ⇒ 不重建 ⇒ 原样拷 ⇒ 泄露，判据当场红） */
function needsRebuild(policy, rel) {
  const s = surfaceOf(rel);
  return !!s && s.mode === 'rebuild-notes' && isExcluded(policy, s);
}
/** 表里说要"重建为空台账"的那一件吗 */
function needsEmptyLedger(policy, rel) {
  const s = surfaceOf(rel);
  return !!s && s.mode === 'empty-ledger' && isExcluded(policy, s);
}

function canRebuildNotes(root, policy) {
  return needsRebuild(policy, 'reference/NOTES.html')
    && exists(path.join(root, 'assets', 'questions-data.js'))
    && exists(path.join(root, 'tools', 'build-notes.js'))
    && hasCourseSource(path.join(root, 'lessons', 'src'));
}

function canRebuildStarmap(root, policy) {
  return !policy.includeProgress
    && exists(path.join(root, 'starmap', 'content.js'))
    && exists(path.join(root, 'starmap', 'index.html'))
    && exists(path.join(root, 'starmap', 'data-layer.js'))
    && exists(path.join(root, 'tools', 'build-starmap-svg.js'));
}

/** 这一件（**产物相对**，不带 reader 的 `app/` 前缀）在当前档位是不是"重建出来的" —— 只看私人面表 */
function derivedOf(rel, policy) {
  const s = surfaceOf(rel);
  if (s && s.mode !== 'drop') {
    if (!isExcluded(policy, s)) return null;            // 显式保留进度 ⇒ 原样带（不是派生物）
    return DERIVED_FROM[s.mode] || null;
  }
  if (STARMAP_SNAPSHOT.includes(rel) && !policy.includeProgress) return 'tools/build-starmap-svg.js';
  return null;
}

/**
 * 算布局：每条 = `{ rel, src, act, gen, from }`
 *   · rel —— 产物相对路径（POSIX）
 *   · src —— 净化输入里的源相对路径（`decorate` 条目没有 src）
 *   · act —— `copy`（从净化输入拷）/ `decorate`（由调用方在暂存目录里写）
 *   · gen / from —— 非 null 即"派生物"（进 `derived`）
 */
function layout(root, opts) {
  const policy = publicationPolicy(opts);
  const { kind } = policy;
  const withNode = opts.withNode !== false;
  const entries = [];
  const excluded = excludedFor(root, policy);
  /** reader 档要额外建出来的空目录（可写台账：目录在、内容空）—— 从骨架模块取，不抄第二份 */
  let ledgerDirs = ['questions', 'notes', 'learning-records'];
  const skip = (rel) => PUBLIC_DROP.some((r) => r.re.test(rel));
  const add = (rel, src, act, gen, from) => {
    if (entries.some((e) => e.rel === rel)) return;
    const srcRel = src === undefined ? rel : src;
    const g = gen === undefined ? (srcRel ? derivedOf(srcRel, policy) : null) : gen;
    entries.push({ rel, src: srcRel, act: act || 'copy', gen: g || null, from: from || g || null });
  };

  if (kind === 'public') {
    const smDir = path.join(root, 'starmap');
    if (!exists(smDir)) throw new Error('发布策略：公开站需要 starmap/（星图就是主页）—— 这个目录还是课程包吗？');
    const smFiles = walkFiles(smDir);
    if (!smFiles.length) throw new Error('发布策略：starmap/ 是空的 —— 星图无处铺');
    for (const rel of smFiles) {
      if (rel === 'README.md') continue;                       // PUBLIC_DROP 同一条口径
      add(rel, `starmap/${rel}`);                              // 铺平到站点根
    }
    if (policy.includeProgress) {
      // 显式保留进度：静态快照件**原样带**（一个字节都不许重跑生成器）
      if (exists(path.join(root, 'starmap', 'static.svg'))) add('static.svg', 'starmap/static.svg', 'copy', null);
    } else if (canRebuildStarmap(root, policy)) {
      add('static.svg', 'starmap/static.svg', 'copy', 'tools/build-starmap-svg.js');   // 生成器会写出来，可能源包里还没有
    } else {
      for (const rel of ['index.html', 'static.svg']) {
        const i = entries.findIndex((e) => e.rel === rel);
        if (i >= 0) {
          entries.splice(i, 1);
          excluded.push({ path: `starmap/${rel}`, why: '星图静态版含进度快照，且重建链不完整（缺 starmap/data-layer.js 或 tools/build-starmap-svg.js）⇒ 不发布' });
        }
      }
    }

    for (const top of policy.publicTop) {
      const abs = path.join(root, top);
      if (!exists(abs)) throw new Error('发布策略：白名单目录不存在：' + top);
      for (const rel of walkFiles(abs)) {
        const rootRel = `${top}/${rel}`;
        if (skip(rootRel)) continue;
        const s = surfaceOf(rootRel);
        if (s && isExcluded(policy, s)) {
          // 私人面（表说了算）：重建 / 空台账 / 中性化那三类**照旧进产物**（内容由净化输入重做）
          if (s.mode === 'rebuild-notes') {
            if (!canRebuildNotes(root, policy)) {
              excluded.push({ path: rootRel, why: '私人派生页，但重建前提不齐（缺 assets/questions-data.js 或 lessons/src 课程源）⇒ 宁可不发布，也不原样带出去' });
              continue;
            }
            add(rootRel, rootRel, 'copy', DERIVED_FROM['rebuild-notes']);
            continue;
          }
          if (s.mode === 'empty-ledger' || String(s.mode).startsWith('neutralize')) { add(rootRel, rootRel); continue; }
          continue;                                   // drop：不发布（excluded 已逐条点名）
        }
        add(rootRel);
      }
    }
    for (const rel of policy.publicFiles) {
      if (!exists(path.join(root, rel))) throw new Error(`发布策略：缺 ${rel}（名词地图的纯文本退路，拒绝静默少一份）`);
      add(rel, rel, 'copy', null);
    }
    for (const rel of PUBLIC_GENERATED) add(rel, null, 'decorate', 'tools/build-public.js');
  } else {
    // ── reader：包内容 = `offline-bootstrap.js#planSkeleton()` 的骨架清单（同一份白名单）
    const boot = loadSiblingCjs(path.join(__dirname, 'offline-bootstrap.js'));
    const { planSkeleton } = boot;
    ledgerDirs = Array.isArray(boot.LEDGER_DIRS) ? boot.LEDGER_DIRS.slice() : ledgerDirs;
    const sk = planSkeleton(root);
    if (!sk.files.length) throw new Error('发布策略：骨架清单是空的 —— 这个目录还是课程包吗？');
    const relOut = (rel) => `${READER_APP}/${rel}`;
    for (const rel of sk.files) {
      // 兜底（纵深防御）：骨架清单一向只列"目录空着也要建"的台账，但**表才是最终权威** ——
      // 清单里万一漏出一件私人面（清单被放宽 / 改了别的白名单），这里按表把它挡住。
      if (PRIVATE_SURFACES.some((x) => x.dir && isExcluded(policy, x) && isUnder(rel, x.p))) continue;
      const s = surfaceOf(rel);
      if (s) {
        if (s.mode === 'drop') {
          if (isExcluded(policy, s)) continue;                       // 已在 excluded 点名
          add(relOut(rel), rel, 'copy', null);                       // 显式保留进度（progress.json）
          continue;
        }
        if (s.mode === 'rebuild-notes') {
          if (!canRebuildNotes(root, policy)) {
            excluded.push({ path: rel, why: '私人派生页，但重建前提不齐（缺 assets/questions-data.js 或 lessons/src 课程源）⇒ 宁可不发布，也不原样带出去' });
            continue;
          }
          add(relOut(rel), rel, 'copy', DERIVED_FROM['rebuild-notes']);
          continue;
        }
        add(relOut(rel), rel);                                       // empty-ledger / neutralize-*（派生由 derivedOf 判）
        continue;
      }
      if (STARMAP_SNAPSHOT.includes(rel)) continue;                  // 下面统一处理
      add(relOut(rel), rel);
    }
    if (policy.includeProgress) {
      const sp = surfaceOf('progress.json');
      if (sp && !isExcluded(policy, sp) && exists(path.join(root, sp.p))) add(relOut(sp.p), sp.p, 'copy', null);
      for (const rel of STARMAP_SNAPSHOT) {
        if (exists(path.join(root, rel))) add(relOut(rel), rel, 'copy', null);
      }
    } else if (canRebuildStarmap(root, policy)) {
      for (const rel of STARMAP_SNAPSHOT) add(relOut(rel), rel, 'copy', 'tools/build-starmap-svg.js');
    } else {
      for (const rel of STARMAP_SNAPSHOT) {
        if (exists(path.join(root, rel))) {
          excluded.push({ path: rel, why: '星图静态版含进度快照，且重建链不完整（缺 starmap/data-layer.js 或 tools/build-starmap-svg.js）⇒ 不发布' });
        }
      }
    }
    for (const rel of READER_GENERATED) add(rel, null, 'decorate', 'tools/build-offline-payload.js');
    if (withNode) {
      for (const rel of READER_NODE) add(rel, null, 'decorate', 'tools/build-offline-payload.js');
      if (exists(path.join(root, 'tools', READER_LICENSE))) add(READER_LICENSE, null, 'decorate', 'tools/build-offline-payload.js');
    }
  }

  const dirs = kind === 'reader'
    ? ledgerDirs.map((d) => `${READER_APP}/${d}`)
    : [];
  return { policy, entries, excluded, dirs };
}

/** 净化输入的**取文件口径**（`sanitizeInput` 与 `inputManifest` 共用一份，不许各写一套）——
 *  完全由 `PRIVATE_SURFACES` 的 `mode` 派生：表里挖掉一类 ⇒ 那一类当场会被原样带出去。 */
function makeSanitizeSkip(policy) {
  const dropExact = [];
  const dropDirs = [];
  const rawOrRebuild = [];
  for (const s of PRIVATE_SURFACES) {
    if (!isExcluded(policy, s)) continue;                 // 显式保留 ⇒ 原样拷（不跳）
    if (s.mode === 'drop') { (s.dir ? dropDirs : dropExact).push(s.p); continue; }
    rawOrRebuild.push(s.p);                               // 中性化 / 空台账 / 重建：原样绝不拷
  }
  return (rel) => {
    if (isStructural(rel)) return true;
    for (const d of dropDirs) if (isUnder(rel, d)) return true;
    return dropExact.includes(rel) || rawOrRebuild.includes(rel);
  };
}

/** 净化输入里每件该怎么处置（'copy' | 'neutralize-practice' | 'neutralize-progress' | 'skip'） */
function sanitizePlan(root, policy) {
  const out = new Map();
  const keepProgress = (s) => !isExcluded(policy, s);
  for (const rel of walkFiles(root)) {
    if (isStructural(rel)) { out.set(rel, 'skip'); continue; }
    if (PRIVATE_SURFACES.some((s) => s.dir && isUnder(rel, s.p))) { out.set(rel, 'skip'); continue; }
    const s = surfaceOf(rel);
    if (!s) { out.set(rel, 'copy'); continue; }
    if (s.mode === 'drop') { out.set(rel, keepProgress(s) ? 'copy' : 'skip'); continue; }
    if (keepProgress(s)) { out.set(rel, 'copy'); continue; }
    if (s.mode === 'neutralize-practice' || s.mode === 'neutralize-progress') { out.set(rel, s.mode); continue; }
    out.set(rel, 'skip');                                 // empty-ledger / rebuild-notes：单独 materialize
  }
  return out;
}

/**
 * 净化输入的**机械指纹**（内容级）：对"净化链会读到的每个文件"取 `[rel, sha256]` 再算一次 sha256。
 *
 * 为什么要有它（D5/D02）：`planDigest`（D2 逐字钉死的那条式子）只覆盖**文件清单**——
 * 改一个字节而清单不变时，旧计划会被照单执行。D02 判的正是那件事（"计划算完之后改动源包"），
 * 所以这里给一个**内容级**指纹，`applyPublication` 把它一起核。
 * 它**不**混进 `planDigest`（那样别人按 D2 的式子独立重算就对不上了）；它是计划对象上的
 * 一个**附加键** `inputManifest`，缺失时退回"只核清单"（D5 的下限）。
 */
function inputManifest(root, policy) {
  const skip = makeSanitizeSkip(policy);
  const rows = [];
  for (const rel of walkFiles(root)) {
    if (skip(rel)) continue;
    rows.push([rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]);
  }
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** 净化输入：把私人面清空 / 中性化 / 用包内生成器重建（全部落在临时副本里） */
function sanitizeInput(root, inputDir, policy) {
  const notes = [];
  fs.mkdirSync(inputDir, { recursive: true });
  const plan = sanitizePlan(root, policy);
  for (const [rel, act] of plan) {
    if (act === 'skip') continue;
    if (act === 'copy') { copyFileAt(root, inputDir, rel); continue; }
    if (act === 'neutralize-practice') {
      const r = neutralizePractice(path.join(root, rel));
      writeFileAt(inputDir, rel, r.text);
      notes.push(`${rel}：${r.note}`);
      continue;
    }
    if (act === 'neutralize-progress') {
      const r = neutralizeContent(path.join(root, rel));
      writeFileAt(inputDir, rel, r.text);
      notes.push(`${rel}：${r.note}`);
      continue;
    }
    throw new Error(`净化计划里有不认识的处置：${rel} → ${act}`);
  }
  // 私人面里"重建 / 空台账"那两类：原样绝不拷，现场重做（**表说了算**：表里没有那一类就不重做）
  if (needsEmptyLedger(policy, 'assets/questions-data.js') && exists(path.join(root, 'assets', 'questions-data.js'))) {
    const empty = emptyLedgerSourceFrom(fs.readFileSync(path.join(root, 'assets', 'questions-data.js'), 'utf8'));
    writeFileAt(inputDir, 'assets/questions-data.js', empty);
    notes.push('assets/questions-data.js：已重建为空台账（条目整段拿掉，收尾锚点保留）');
  }
  // 空笔记台账（build-notes 读它；缺了也读得动，但显式建一份更像"净化输入"）
  fs.mkdirSync(path.join(inputDir, 'notes'), { recursive: true });
  writeFileAt(inputDir, 'notes/notes.jsonl', '');

  const runNode = (script, args) => {
    // ⚠️ stdio 必须 inherit：本机沙箱不允许子进程走管道（EPERM），捕获输出会让这一步直接失败。
    const r = spawnSync(process.execPath, [script, ...args], { cwd: inputDir, stdio: 'inherit' });
    // 子进程**没起来**（r.status === null）与"跑起来但失败"必须分两句说：
    // 前者的原因是权限/沙箱边界，喊「失败了」会把人指向错的修法。顺序不许反（反了等于没加）。
    if (r.error) {
      throw new Error(`起不了子进程 ${path.basename(script)}：${r.error.code || r.error.message}（权限/沙箱边界）—— 这不是「命令没跑」也不是代码坏了。出路：① 改 stdio:\'inherit\'（本处已是）② 结果写文件再读 ③ 在无沙箱环境跑。`);
    }
    if (r.status !== 0) throw new Error(`${path.basename(script)} 失败（exit ${r.status}）—— 派生物重建不过关，如实失败`);
  };
  if (canRebuildNotes(root, policy)) {
    runNode(path.join(inputDir, 'tools', 'build-notes.js'), []);
    notes.push('重建 reference/NOTES.html（净化输入：空答疑 + 空笔记 + 空实践）');
  }
  if (canRebuildStarmap(root, policy)) {
    runNode(path.join(inputDir, 'tools', 'build-starmap-svg.js'), ['--root=' + inputDir]);
    notes.push('重建 starmap/static.svg + 内联 SVG（净化输入：进度已中性化）');
  }
  return notes;
}

/* ─────────────────────────────────────────────────────── 产物装配与落盘 */

const STARLINK_RE = /href="([^"]*)starmap\/#([^"]*)"/g;

function assemble(inputDir, outDir, L) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of L.entries) {
    if (e.act === 'decorate') continue;                     // 由 decorate 在暂存目录里写
    copyFileAt(inputDir, outDir, e.src);
    if (e.src !== e.rel) {
      // 产物里的落点与源位置不同（公开站把星图**铺平**到站点根）—— 挪到 rel
      const to = path.join(outDir, e.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(path.join(outDir, e.src), to);
      const parent = path.dirname(path.join(outDir, e.src));
      if (parent !== outDir) { try { fs.rmdirSync(parent); } catch { /* 非空就留着 */ } }
    }
  }
  for (const d of L.dirs) fs.mkdirSync(path.join(outDir, d), { recursive: true });
  if (L.policy.kind === 'public') {
    // T1：课程页侧栏的星图链接 → 站点根深链（星图已铺平，`starmap/` 会 404）
    for (const rel of walkFiles(outDir)) {
      if (!rel.startsWith('lessons/') || !rel.endsWith('.html')) continue;
      const abs = path.join(outDir, rel);
      const before = fs.readFileSync(abs, 'utf8');
      const after = before.replace(STARLINK_RE, 'href="$1#$2"');
      if (after !== before) fs.writeFileSync(abs, after, 'utf8');
    }
  }
}

/* ─────────────────────────────────────────────────────────────── 对外接口 */

/* ───────────────────────────────────────────────── 共同三闸（U06 / U08）

 * 发布与引擎升级是同一类**显式危险写入**，所以共用同一套三闸（不再各写一份判定）：
 *
 *   ① 有效计划 —— 计划身份由 `planCommit()` 的 `whale-commit/1` 计划给出（本文件 `commit` 键）；
 *   ② 显式确认 —— `applyPublication` 先核 `confirm:true`（缺了就**一次都不调**共同协议）；
 *   ③ 锁内真实字节摘要 —— `applyCommit()` 在**包级锁内**重算「策略 + 净化输入字节」并逐字比对
 *      （任何一字节变了 ⇒ `PLAN_STALE`，一个字节都不写）。
 *
 * 锁 / 日志（`whale-txn/1`）/ 七态 / 离线恢复全部复用 `ledger-transaction.cjs`（经 `./unify/commit.cjs`）
 * —— 本文件**不建**第二套计划、第二份日志、第二把锁。发布产物的落位仍是既有的
 * 「暂存目录 → 原子换上去」：源包一个字节不改（T20 D04 钉死），而共同协议那笔台账是
 * **零写提交**（`files: []`），只借它的锁与锁内摘要复核。
 * ────────────────────────────────────────────────────────────────────────── */

/** 计划 operation：kind / includeProgress / 「策略 + 输入字节」摘要 —— 三类变化都能让计划摘要变 */
function publishOperation(kind, includeProgress, policyDigest) {
  return `publish:${kind}:${includeProgress ? 1 : 0}:${policyDigest}`;
}

/** 「策略 + 输入」摘要：产物清单 / 排除项 / 派生物 / 逐文件输入内容指纹，全放进一段规范 JSON */
function policyDigestOf(body) {
  return crypto.createHash('sha256').update(JSON.stringify({
    kind: body.kind,
    includeProgress: body.includeProgress,
    files: body.files,
    excluded: body.excluded,
    derived: body.derived,
    inputManifest: body.inputManifest,
  })).digest('hex');
}

/**
 * 锁内复核（共同协议闸③的 build）：**持锁后**重算一遍「策略 + 输入字节」，与计划逐字比。
 * 不符就抛 —— 事务件会因此中止，一个字节都不写。
 *
 * 本 build **不产出任何写项**（`files: []`）：发布产物由既有暂存/换位链落位，源包不改；
 * 这里只要共同协议的锁与「锁内真实字节摘要」这道闸。
 */
function makePublicationGuard({ kind, includeProgress, withNode, expectedDigest, expectedInput }) {
  return function build({ root }) {
    const again = planPublication(root, { kind, includeProgress, withNode });
    if (again.planDigest !== expectedDigest || again.inputManifest !== expectedInput) {
      throw new Error(`plan-stale: 锁内复核发现源包/策略已变（计划 ${String(expectedDigest).slice(0, 12)}…`
        + ` / 当下 ${String(again.planDigest).slice(0, 12)}…）`);
    }
    return { files: [], value: { planDigest: again.planDigest, inputManifest: again.inputManifest } };
  };
}

/** 共同协议的回执 → 发布侧**既有码值**（`CONFIRM_REQUIRED` / `PLAN_STALE` / `STAGE_FAILED` … 一个字不改） */
function mapGuardFailure(out) {
  const failure = out && out.failure ? out.failure : null;
  const code = String((failure && failure.code) || (out && out.code) || 'IO_ERROR');
  const error = String((failure && failure.error) || (out && out.error) || '提交被拒（共同协议没有给出原因）');
  if (code === 'PLAN_STALE' || /plan-stale/.test(error)) {
    return { ok: false, code: 'PLAN_STALE', error: `计划已陈旧（锁内复核）：${error} —— 一个字节都不动` };
  }
  if (code === 'CONFIRM_REQUIRED') return { ok: false, code: 'CONFIRM_REQUIRED', error };
  if (code === 'LOCK_BUSY') return { ok: false, code: 'LOCK_BUSY', error: `发布写入被包级写锁挡住：${error}` };
  if (code === 'RECOVERY_REQUIRED') return { ok: false, code: 'RECOVERY_REQUIRED', error };
  // 其余（暂存/回滚/IO）沿用发布侧最接近的既有码：STAGE_FAILED（不改名、不新增同义码）
  return { ok: false, code: 'STAGE_FAILED', error: `提交阶段失败（${code}）：${error}` };
}

/**
 * 只算不写。计划身份 `planDigest` 由共同协议 `planCommit()` 给出（`whale-commit/1`）：
 * operation 覆盖「kind + includeProgress + 策略摘要 + 净化输入内容指纹」——
 * 所以**策略变了、源包任意一个净化输入字节变了**，摘要都会变（D2 / A03 的判据）。
 * `policyDigest` 单独保留「策略 + 输入」那一半，便于对拍。
 * @param {string} root 课程包根
 * @param {{kind?:'reader'|'public', includeProgress?:boolean, withNode?:boolean, fs?:object}} [opts]
 */
function planPublication(root, opts = {}) {
  if (!root || !String(root).trim()) throw new Error('planPublication：没有给课程包根');
  const abs = path.resolve(String(root));
  if (!exists(abs)) throw new Error('planPublication：目录不存在：' + abs);
  const policy = publicationPolicy(opts);
  const L = layout(abs, { ...opts, kind: policy.kind, includeProgress: policy.includeProgress });
  const files = L.entries.map((e) => e.rel).sort(cmp);
  const dup = files.filter((r, i) => i > 0 && files[i - 1] === r);
  if (dup.length) throw new Error('planPublication：产物清单里有重复项：' + [...new Set(dup)].join('、'));
  const excluded = L.excluded.slice().sort((a, b) => cmp(a.path, b.path));
  const derived = L.entries.filter((e) => e.gen).map((e) => ({ path: e.rel, from: e.from })).sort((a, b) => cmp(a.path, b.path));
  // 附加键（D2 的 8 个键一字未动）：净化输入的**内容级**指纹，给锁内复核 / 对拍用。
  const inputDigest = inputManifest(abs, policy);
  const policyDigest = policyDigestOf({
    kind: policy.kind, includeProgress: policy.includeProgress, files, excluded, derived, inputManifest: inputDigest,
  });
  const planned = COMMIT.planCommit(abs, () => ({
    operation: publishOperation(policy.kind, policy.includeProgress, policyDigest),
    files: [],
  }), { fs: opts.fs });
  if (!planned || planned.ok !== true) {
    const why = String((planned && (planned.error || (planned.failure && planned.failure.error))) || '未知原因');
    throw new Error('planPublication：共同提交协议算不出计划（' + why + '）');
  }
  return {
    schema: SCHEMA, root: abs, kind: policy.kind, includeProgress: policy.includeProgress,
    files, excluded, derived,
    planDigest: planned.plan.planDigest,
    policyDigest,
    inputManifest: inputDigest,
    commit: planned.plan,
  };
}

/**
 * 正式写入：先建暂存、核摘要、验产物全集、跑 verify，**再在包级锁内复核输入字节**，
 * 全过了才**原子换上去**。失败绝不替换既有产物（旧产物逐字节不变），源包一个字节不改。
 *
 * 三闸落点：① `plan.commit`（共同协议的计划）② `confirm === true` 在本函数**前置**核
 * （缺了它 applyCommit 一次都不会被调用）③ 暂存完成之后由 `applyCommit` 在**锁内**重算
 * 「策略 + 净化输入字节」—— 不符即 `PLAN_STALE`，一个字节都不写（旧产物原样留着）。
 *
 * @param {string} root
 * @param {object} plan `planPublication()` 的返回值
 * @param {{confirm?:boolean, outDir?:string, decorate?:Function, verify?:Function, withNode?:boolean,
 *          fs?:object, transaction?:object}} [opts]
 *        `fs` / `transaction` 是**判据注入点**（既有调用不传也照旧）
 */
function applyPublication(root, plan, opts = {}) {
  if (!plan || typeof plan !== 'object' || !plan.planDigest) {
    return { ok: false, code: 'PLAN_REQUIRED', error: 'applyPublication 只认 planPublication() 的返回值（没有 planDigest 一律拒）' };
  }
  if (opts.confirm !== true) {
    return { ok: false, code: 'CONFIRM_REQUIRED', error: '正式写入必须显式 confirm:true —— 没有它一个字节都不动' };
  }
  const abs = path.resolve(String(root));
  let kind;
  try { kind = normalizeKind(plan.kind); } catch (e) { return { ok: false, code: 'PLAN_REQUIRED', error: String(e.message || e) }; }
  const includeProgress = plan.includeProgress === true;
  // ⚠️ `withNode` 的默认必须与 `layout()` **同一条口径**（`opts.withNode !== false` ⇒ 省略即 true）。
  //    旧实现从 `plan.files` 反推（清单里没有 node 就给 false），于是 applyPublication 自己重算出来的
  //    `planDigest` 与调用方提交的那份不一致 ⇒ **恒 PLAN_STALE**（public 档实测：计划 fe1f16f60b9f
  //    / 当下 4fc10b4e40b6）。判据强度不变：仍然是"同一份计划 + 同字节输入"才放行。
  const withNode = opts.withNode !== false;

  let fresh;
  let L;
  try {
    fresh = planPublication(abs, { kind, includeProgress, withNode, fs: opts.fs });
    if (fresh.planDigest !== plan.planDigest) {
      return {
        ok: false, code: 'PLAN_STALE',
        error: `计划已陈旧：提交的 planDigest=${plan.planDigest}，当下重算=${fresh.planDigest}（源包或策略在这之间变过）—— 一个字节都不动`,
      };
    }
    // 内容级陈旧（D02）：清单没变、但净化输入的内容变了 —— 旧计划同样不许照单执行
    if (plan.inputManifest && fresh.inputManifest !== plan.inputManifest) {
      return {
        ok: false, code: 'PLAN_STALE',
        error: `计划已陈旧：净化输入的内容变了（提交的 inputManifest=${plan.inputManifest}，当下=${fresh.inputManifest}）—— 一个字节都不动`,
      };
    }
    L = layout(abs, { kind, includeProgress, withNode });
  } catch (e) {
    return { ok: false, code: 'PLAN_REQUIRED', error: String(e && e.message ? e.message : e) };
  }

  const pol = publicationPolicy({ kind, includeProgress });
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.join(abs, pol.outDir);
  const work = path.join(abs, `.tmp-publication-${process.pid}`);
  const input = path.join(work, 'input');
  const out = path.join(work, 'out');
  const old = path.join(work, 'old');
  rmrf(work);
  try {
    fs.mkdirSync(work, { recursive: true });
    const notes = sanitizeInput(abs, input, pol);
    assemble(input, out, L);
    if (typeof opts.decorate === 'function') opts.decorate(out, { kind, plan: fresh, withNode });

    // 机械判据（A10）：产物文件全集必须与 files 逐项相等 —— 清单与实际不许两张皮
    const got = walkFiles(out).sort(cmp);
    const missing = fresh.files.filter((r) => !got.includes(r));
    const extra = got.filter((r) => !fresh.files.includes(r));
    if (missing.length || extra.length) {
      throw new Error('产物文件全集与 plan.files 不一致'
        + (missing.length ? `；缺 ${missing.length} 个：${missing.slice(0, 6).join('、')}` : '')
        + (extra.length ? `；多 ${extra.length} 个：${extra.slice(0, 6).join('、')}` : '')
        + `（净化记录：${notes.join('；')}）`);
    }
    if (typeof opts.verify === 'function') opts.verify(out);

    // ── 共同三闸之③：**锁内真实字节摘要**（零写提交；不符即 PLAN_STALE，一个字节都不写）──
    const guarded = COMMIT.applyCommit(abs, fresh.commit, {
      confirm: true,
      planDigest: plan.planDigest,
      build: makePublicationGuard({
        kind, includeProgress, withNode, expectedDigest: fresh.planDigest, expectedInput: fresh.inputManifest,
      }),
      fs: opts.fs,
      transaction: opts.transaction || LEDGER_TXN,
    });
    if (!guarded.ok) return mapGuardFailure(guarded);

    const had = exists(outDir);
    if (had) fs.renameSync(outDir, old);
    try {
      fs.renameSync(out, outDir);
    } catch (e) {
      if (had) { try { fs.renameSync(old, outDir); } catch { /* 尽力还原 */ } }
      throw e;
    }
    return {
      ok: true, kind, planDigest: fresh.planDigest,
      files: fresh.files, excluded: fresh.excluded, derived: fresh.derived, outDir,
    };
  } catch (e) {
    return { ok: false, code: 'STAGE_FAILED', error: String(e && e.message ? e.message : e) };
  } finally {
    rmrf(work);
  }
}

module.exports = { planPublication, applyPublication, publicationPolicy, PUBLISH_KINDS };
