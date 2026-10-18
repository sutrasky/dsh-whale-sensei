#!/usr/bin/env node
/**
 * offline-bootstrap.js — 离线阅读器的「**包骨架**」初始化
 * ------------------------------------------------------------------
 * 离线端的课程库是 `packs/<包名>/`，每个包就是一个**能独立起服务的课程包**。
 * 老师发来的单课 zip 只有几十 KB（`pack.json` + 圈/点结构 + 一节产物 + 单课清单），
 * **不带** `assets/`、`starmap/`、字体、three、`tools/` —— 那些由这里从**骨架源**铺进去。
 *
 * 骨架源 = 本脚本所在的课程包（开发期就是那个课程包目录；装成 exe 后就是安装目录）。
 * 于是「一份骨架 + N 个几十 KB 的课件包」= 离线端能看能重建，而每次发课件只发几十 KB。
 *
 * 用法：
 *   node tools/offline-bootstrap.js <目标目录>            # 把骨架铺进目标目录
 *   node tools/offline-bootstrap.js <目标目录> --check    # 只报告会铺什么，不写盘
 *
 * 判据：`tools/offline-server.test.mjs`（真建一个库、真导入、真起服务）。
 *
 * **MIRROR-OF: lib/pack-template/tools/offline-bootstrap.js**（同源实现，逐字节同一份；
 * 改这里就必须同步改那一份，否则 `test/pack-scaffold.mjs` 的 FROM_PACK 逐文件核对会红）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SKELETON_SRC = path.resolve(__dirname, '..');

/**
 * 骨架清单（**白名单**，不是黑名单）——
 * 与方案 `_board/14-...` §2 的「包骨架」一致：能看（页面/星图/字体/three）+ 能重建（tools 链）
 * + 能写（答疑/笔记/进度）。
 * ❌ 绝不带：`lessons/src/**`（作者态）、`code/**`、`_p0/**`、`_starmap-proto/**`、`.git/**`、
 *   `*.test.mjs`、`build-public.js`、`dist/**`、`demo/**`、`.backup/**`
 */
const SKELETON = [
  // 页面与资源
  'index.html',
  'GLOSSARY.md',
  'MISSION.md',
  'progress.json',
  'lesson.config.json',
  'assets',
  'starmap',
  'glossary',
  'reference',
  'presets',
  'templates',
  'math',
  'skills',
  // 可写台账（答疑 / 笔记 / 学习记录）—— 目录空着也要建
  'questions',
  'notes',
  'learning-records',
  // 服务闭包 + 重建链（包自己就是一个能起服务的课程包）
  'tools',
];

/** 骨架里**明确排除**的东西（tools/ 下那些只在作者机器上有意义的） */
const SKELETON_EXCLUDE = [
  /\.test\.mjs$/,
  /^build-public\.js$/,
  /^offline-server\.test\.mjs$/,
];

/**
 * 骨架里的**可写台账**目录：**只建目录，不铺内容**。
 * ------------------------------------------------------------------
 * 与上面 `SKELETON` 的注释同源：「可写台账（答疑 / 笔记 / 学习记录）—— **目录空着也要建**」。
 * 内容不是骨架：那是**学生自己的私人原账**（疑问队列 / 笔记 / 摸底 / 终点 / 教学 / 证据 /
 * state.json / 学习记录），发离线库或公开站时一件都不许跟着走（T20 / 报告 D05）。
 *
 * 病：原先这三个目录与 `assets/` 一样走 `walk()`，把**目录下每一个文件**都收进骨架清单
 * （只有 `tools/` 那一支有 `TOOLS_KEEP` 过滤）⇒ 离线 payload 的 `app/` 带着作者的全本台账
 * （实测：`app/questions/processed.jsonl`、`app/notes/fix-2026-09-20-summary.md`、
 * `app/learning-records/` 9 个文件全在）。
 */
const LEDGER_DIRS = ['questions', 'notes', 'learning-records'];

/** tools/ 下要带的脚本（白名单：服务闭包 + 重建链 + 离线端自己） */
const TOOLS_KEEP = [
  'app-server.js', 'ask-server.js', 'serve-static.js', 'lesson-map.js', 'pack-text.js', 'fingerprint.js',
  'build-starmap.js', 'build-starmap-svg.js', 'build-glossary-tree.js', 'circle-bands.js',
  'style-adapter.js', 'style-check.js', 'shape-render.js', 'title-classes.js', 'plan-map.js',
  'galaxy-shapes.cjs', 'build-lessons.js', 'build-lessons-index.js',
  'offline-server.js', 'offline-bootstrap.js',
  // ⚠️ 管理台页也算"引擎"：`offline-server.js` 的 `sendAdmin` 直接读它，
  //    漏了它 ⇒ `GET /` 500「管理台页面不在」（2026-09-26 打包实测踩到）
  'offline-admin.html',
  // ⚠️ T05 / 报告 D01：受控解压 helper 与共享路径策略**必须跟着走** ——
  //    `offline-server.js` 会 `require('./path-policy.cjs')` 并 shell-out `import-zip.ps1`；
  //    漏了它们，库自己那一份 `node <库>/tools/offline-server.js` 一启动就崩（或导入直接拒）。
  'path-policy.cjs', 'import-zip.ps1',
  // T06：静态读取的公开清单 —— `app-server.js` / `offline-server.js` 都 require 它，
  // 漏了它库自己那一份 app-server 起不来（预览直接 404）。
  'public-files.cjs',
  // T15：受信引擎闭包的那一份 —— `app-server.js` / `offline-server.js` 的 `/health` **身份信封**
  // 要 `digestOfManifest(buildManifest(包根).files)`，那份实现只住在 `tools/engine-policy.cjs`
  // （与宿主 `lib/engine.js` 是**同一个文件**；自己另写一份就是"一边堵、一边漏"）。
  // 漏了它：安装目录（`app/`，由 build-offline-payload.js 按本白名单铺）与库骨架里
  // `/api/health` 算不出 engineDigest ⇒ 如实回 500（`identityError: Cannot find module './engine-policy.cjs'`）
  // —— 管理台那行 liveness 自检（`offline-admin.html` 的 `loadHealth()`）会当场误报"本地服务没有正常响应"。
  // 规划者独立取证：`test/audit/T08.mjs` 的 `bootstrap-propagation` **不会**因此变红
  // （它只 require 两个服务、不请求 `/api/health`）；判据由规划者探针直接打 `/api/health` 取得
  // （有登记行 → 200 + 真身份；去掉登记行 → 500 + identityError）：`audit-evidence/T15/planner-closure-*.json`。
  'engine-policy.cjs',
  // T07：独立服务的授权件 —— `app-server.js` / `ask-server.js` / `offline-server.js` 都 require 它，
  // 漏了它库自己那一份服务一启动就 `Cannot find module './http-security.cjs'`。
  'http-security.cjs',
  'http-request.cjs',
  // T11：包级提交协议 —— `ask-server.js` / `drain-questions.js` 都 require 它，
  // 漏了它库自己那一份服务一启动就 `Cannot find module './ledger-transaction.cjs'`。
  'ledger-transaction.cjs',
];

const checkOnly = process.argv.includes('--check');
const destArg = process.argv.slice(2).find((a) => !a.startsWith('--'));

/** 递归列出一个目录下的所有文件（相对该目录的 posix 路径） */
function walk(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/** 骨架里的文件清单（相对骨架源） */
function planSkeleton(src = SKELETON_SRC) {
  const files = [];
  const dirs = [];
  for (const item of SKELETON) {
    const abs = path.join(src, item);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      dirs.push(item);
      // 可写台账：目录空着也要建，**内容一件都不铺**（学生的私人原账，见 LEDGER_DIRS）
      if (LEDGER_DIRS.includes(item)) continue;
      for (const rel of walk(abs)) {
        const sub = `${item}/${rel}`;
        if (item === 'tools') {
          if (!TOOLS_KEEP.includes(rel)) continue;
        } else if (SKELETON_EXCLUDE.some((re) => re.test(rel))) continue;
        files.push(sub);
      }
    } else {
      files.push(item);
    }
  }
  return { files, dirs };
}

/**
 * 把骨架铺进 `dest`（幂等：已存在的文件**不覆盖** —— 学生改过的东西不能被骨架冲掉）。
 * @param {string} dest 目标包目录
 * @param {{src?: string, log?: object}} [opts]
 */
function initSkeleton(dest, opts = {}) {
  const src = opts.src || SKELETON_SRC;
  const log = opts.log || {};
  /** `tools/` 是**引擎**不是学生数据 ⇒ 包已存在时也要刷新到当前版本（其余文件一律不覆盖） */
  const refreshTools = opts.refreshTools === true;
  const abs = path.resolve(dest);
  const { files, dirs } = planSkeleton(src);
  if (!files.length) {
    return { ok: false, error: `骨架源里一个文件都没有：${src}（这个目录还是课程包吗？）` };
  }
  if (checkOnly) return { ok: true, dryRun: true, dest: abs, files: files.length, dirs };

  try {
    for (const d of dirs) fs.mkdirSync(path.join(abs, d), { recursive: true });
    for (const d of ['questions', 'notes', 'learning-records']) fs.mkdirSync(path.join(abs, d), { recursive: true });
  } catch (e) {
    return { ok: false, error: `建目录失败：${e?.message ?? e}` };
  }

  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(abs, rel);
    const isEngine = rel.startsWith('tools/');
    // 幂等：不覆盖已有文件 —— **例外是 `tools/`**（引擎要能升级：离线阅读器更新后，
    // 老库里那些包还用着旧脚本，不刷新就会出现"新版修好的 bug 在老库里还在"）
    if (fs.existsSync(to) && !(refreshTools && isEngine)) { skipped++; continue; }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied++;
      bytes += fs.statSync(to).size;
    } catch (e) {
      return { ok: false, error: `铺骨架时失败（${rel}）：${e?.message ?? e}`, copied, skipped };
    }
  }
  log.info?.(`骨架已铺：${abs}（新铺 ${copied} 个 / 跳过 ${skipped} 个 / ${Math.round(bytes / 1024)} KB）`);
  return { ok: true, dest: abs, copied, skipped, bytes, dirs };
}

module.exports = { initSkeleton, planSkeleton, SKELETON, SKELETON_EXCLUDE, TOOLS_KEEP, LEDGER_DIRS, SKELETON_SRC };

if (require.main === module) {
  if (!destArg) {
    console.error('用法：node tools/offline-bootstrap.js <目标目录> [--check]');
    process.exit(2);
  }
  const r = initSkeleton(destArg, { log: console, refreshTools: process.argv.includes('--refresh-tools') });
  if (!r.ok) { console.error(`✗ ${r.error}`); process.exit(1); }
  if (r.dryRun) console.log(`会铺 ${r.files} 个文件 / ${r.dirs.length} 个目录 → ${r.dest}`);
  else console.log(`✓ 骨架就绪：${r.dest}（新铺 ${r.copied} / 跳过 ${r.skipped} / ${Math.round(r.bytes / 1024)} KB）`);
}
