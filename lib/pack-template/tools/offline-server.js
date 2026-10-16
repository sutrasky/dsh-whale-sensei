#!/usr/bin/env node
/**
 * offline-server.js — 鲸师「离线阅读器」的管理台服务（场景 B）
 * ------------------------------------------------------------------
 * 这是给**没有 DSH、没有 Node** 的人用的那一端（装成 exe 后自带一个 node.exe）。
 * 它自己不渲染课程，只做三件事：**管课程库 / 导入课件包 / 把包服务拉起来**。
 *
 *   启动： node tools/offline-server.js            （默认 127.0.0.1:3091）
 *          node tools/offline-server.js 3100
 *          node tools/offline-server.js --lib=<你的课件库目录>
 *
 * **唯一课程库**（主人 2026-09-26 定：「导入课程之后就在唯一的星图上面显示，而不是每次要我去加载、
 * 每次只能显示一门课」）：所有导入的课都合并进 `packs/library/`，**共用一张星图**。
 * 老版本留下的 `packs/<包名>/` 会在启动时自动合并进来（`migrateOldPacks`），原目录进 `.trash`。
 *
 * **为什么内部仍是"每包一个服务"，而对外只有一个端口**：
 *   课程包自己的 `tools/app-server.js` 与 `ask-server.js` 都是**单包**设计（ROOT = `__dirname/..`），
 *   页面里的相对引用（`../assets/…`、`./content.js`）也全都按"服务根 = 包根"成立 —— 所以内部
 *   照旧**按需**起一个包服务（3092 起，**真探测**空闲端口），但管理台用**反向代理**把
 *   `/<包名>/…` 转发过去（转发前**剥掉前缀**），于是主人看到的永远是**一个端口、一个地址**：
 *   `http://127.0.0.1:<管理台端口>/library/starmap/`。
 *
 * 路由：
 *   GET  /                     管理台页（tools/offline-admin.html）
 *   GET  /assets/*             同源静态资源（鲸师主题/字体 —— 管理台页穿的是课程包同一份）
 *   GET  /api/health           { ok, port, dir, lessons }
 *   GET  /api/library          唯一课程库现状（圆圈/知识点/课数 ＋ **课程清单**）
 *   POST /api/import?name=x.zip  body = **zip 原始字节** → 合并进库 → 自动重建
 *   POST /api/open             打开唯一星图（不给 id 默认就是库）
 *   POST /api/rebuild          跑重建链，逐步回报（不给 id 默认就是库）
 *   POST /api/clear            整库移进 .trash（可撤销）
 *   ANY  /<包名>/…             反向代理到该包的内部服务（懒启动）
 *   GET  /api/packs            兼容保留：列表里现在只有一个元素（库）
 *   POST /api/remove?id=       兼容保留（清空整库请用 /api/clear）
 *
 * 判据：`tools/offline-server.test.mjs`（真建库、真导入、真起服务、真打开页面）。
 *
 * **MIRROR-OF: lib/pack-template/tools/offline-server.js**（同源实现，逐字节同一份；
 * 改这里就必须同步改那一份，否则 `test/pack-scaffold.mjs` 的 FROM_PACK 逐文件核对会红）。
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { initSkeleton } = require('./offline-bootstrap.js');

const HOST = '127.0.0.1';
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const PORT = Number(argOf('port') || argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 3091);
const ADMIN_HTML = path.join(__dirname, 'offline-admin.html');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/** 离线端能安全跑的重建链（**没有** build-lessons：离线包不带 src，跑了是空转） */
const REBUILD_CHAIN = [
  // 清单模式（无 src 时读 lessons/lessons.json）+ 单课导入时前置可能还没到 ⇒ 悬空前置降级为告警
  { script: 'build-starmap.js', args: ['--allow-missing-requires'] },
  { script: 'build-starmap-svg.js' },
  { script: 'build-glossary-tree.js' },
  { script: 'circle-bands.js' },
  { script: 'style-adapter.js' },
];

/** 课程库根：`--lib=` > `WHALE_LIB` > `%LOCALAPPDATA%\鲸师课件\packs` */
function resolveLib() {
  const explicit = argOf('lib') || process.env.WHALE_LIB;
  if (explicit) return path.resolve(explicit);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, '鲸师课件', 'packs');
}
const LIB = resolveLib();
/** **唯一课程库**的目录名 —— 所有导入的课都合并进这一个包、共用一张星图
 *  （主人 2026-09-26 定：「导入课程之后就在唯一的星图上面显示，而不是每次要我去加载、每次只能显示一门课」） */
const LIBRARY_DIR = 'library';

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 子进程没起来时的人话（EPERM / 找不到 / 超时）—— 与包内其他 shell-out 同一套口径 */
function hintOf(err) {
  const code = err?.code;
  if (code === 'EPERM') return '起不来子进程（EPERM）：这个环境禁止创建进程 —— 换一个不受限的终端再跑';
  if (code === 'ENOENT') return '找不到这个命令（ENOENT）：检查路径，或它根本没装';
  if (code === 'ETIMEDOUT') return '超时了：命令跑了太久没回来';
  return `子进程失败：${err?.message ?? err}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个子进程真退出（kill 是异步的：不等它，Windows 上包里的文件还锁着，rename 会 EBUSY） */
function waitExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

const walk = (dir, prefix = '') => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
};

/* ── 课程库 ─────────────────────────────────────────────────────────────── */

/** 一个包里"有几节课"：lessons 下的 .html，去掉 src/ 那些作者态源文件 */
function countLessons(packDir) {
  return walk(path.join(packDir, 'lessons')).filter((r) => r.endsWith('.html') && !r.startsWith('src/')).length;
}

function dirBytes(dir) {
  let n = 0;
  for (const rel of walk(dir)) {
    try { n += fs.statSync(path.join(dir, rel)).size; } catch { /* 半路被删就当 0 */ }
  }
  return n;
}

/** 已经被合并进唯一课程库的老包名（迁移台账 `LIB/.migrated.json`）——
 *  它们不再作为"一个课程包"出现（移得动时已经进回收站，移不动时目录还在）。 */
function readMigrated() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(LIB, '.migrated.json'), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

function listPacks() {
  if (!fs.existsSync(LIB)) return [];
  const out = [];
  const migrated = readMigrated();
  for (const e of fs.readdirSync(LIB, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || migrated.includes(e.name)) continue;
    const dir = path.join(LIB, e.name);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')); } catch { /* 没有就用目录名 */ }
    const stat = fs.statSync(dir);
    const running = children.get(e.name);
    out.push({
      id: e.name,
      name: meta.name || meta.point || e.name,
      dir,
      lessons: countLessons(dir),
      bytes: dirBytes(dir),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      running: !!running,
      url: running ? `http://${HOST}:${running.port}/starmap/` : null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * **唯一课程库**的现状：圆圈/知识点/课数 ＋ 课程清单（直接读库自己的 `lessons/lessons.json`）。
 * 界面靠它渲染"每节课一行"，而不是"每个包一行" —— 因为库里只有一个包（所有课都在里面）。
 */
function libraryInfo() {
  const dir = path.join(LIB, LIBRARY_DIR);
  const exists = fs.existsSync(dir);
  const running = children.get(LIBRARY_DIR);
  let lessons = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'lessons', 'lessons.json'), 'utf8'));
    lessons = (idx.lessons || []).map((l) => ({
      rel: l.rel || '',
      title: l.title || '',
      number: l.number,
      circle: l.halo || '',
      point: l.point || '',
      slug: l.slug || '',
    }));
  } catch { /* 还没导入过 —— 空库 */ }
  const circles = new Set(lessons.map((l) => l.circle).filter(Boolean));
  const points = new Set(lessons.filter((l) => l.circle && l.point).map((l) => `${l.circle}/${l.point}`));
  return {
    ok: true,
    dir,
    exists,
    circles: circles.size,
    points: points.size,
    lessons,
    lessonCount: lessons.length,
    updatedAt: exists ? new Date(fs.statSync(dir).mtimeMs).toISOString() : null,
    running: !!running,
    url: running ? packUrl(LIBRARY_DIR) : null,
  };
}

/* ── 迁移：老版本"每包一个目录" → 唯一课程库 ────────────────────────────── */

/**
 * 把老版本留下的 `packs/<包名>/` 合并进唯一课程库 `packs/library/`，老包移进 `.trash`（可恢复）。
 * 幂等：合并过的老包已经不在原位置，下次不会再合并一遍。
 * @returns {string[]} 被合并的老包名
 */
function migrateOldPacks() {
  if (!fs.existsSync(LIB)) return [];
  const libraryDir = path.join(LIB, LIBRARY_DIR);
  const migrated = [];
  for (const e of fs.readdirSync(LIB, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === LIBRARY_DIR || e.name.startsWith('.')) continue;
    const src = path.join(LIB, e.name);
    const srcLessons = path.join(src, 'lessons');
    if (!fs.existsSync(srcLessons)) continue;

    if (!fs.existsSync(libraryDir)) {
      const s = initSkeleton(libraryDir, { refreshTools: true });
      if (!s.ok) break;
    }
    mergeTree(srcLessons, path.join(libraryDir, 'lessons'), new Set(['lessons.json']));
    mergeIndex(path.join(libraryDir, 'lessons', 'lessons.json'), path.join(srcLessons, 'lessons.json'));

    // 移得动就进回收站；移不动（多半是被上一个管理台留下的包服务占着）就**留着**，
    // 但**无论成败都记进 `.migrated.json`** —— 于是它不会再被当成"一个课程包"列出来、
    // 也不会被重复合并（既不静默丢数据，也不让主人看见一堆多余的包）。
    const trash = path.join(LIB, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    try {
      fs.renameSync(src, path.join(trash, `${e.name}-migrated-${Date.now()}`));
    } catch { /* 见上：留着，下次启动再试 */ }
    migrated.push(e.name);
  }
  if (migrated.length) {
    const mark = path.join(LIB, '.migrated.json');
    const known = readMigrated();
    const all = [...new Set([...known, ...migrated])];
    fs.writeFileSync(mark, `${JSON.stringify(all, null, 2)}\n`);
    rebuild(LIBRARY_DIR);
    console.log(`[离线阅读器] 已把 ${migrated.length} 个旧课程包合并进唯一课程库：${migrated.join('、')}`);
  }
  return migrated;
}

/* ── 导入：解 zip → 建库（骨架）→ 合并 → 重建 ───────────────────────────── */

/**
 * 把 `src` 下的整棵树覆盖进 `dest`（同路径覆盖；不删 dest 里多出来的文件）。
 * ⚠️ `skip` 里的相对路径**不覆盖**：`lessons/lessons.json` 必须走 `mergeIndex` 单独合并 ——
 *    否则第二节课导入时，它会把前一份清单**整个冲掉**（判据 [6] 抓到的就是这条）。
 */
function mergeTree(src, dest, skip = new Set()) {
  let n = 0;
  for (const rel of walk(src)) {
    if (skip.has(rel)) continue;
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    n++;
  }
  return n;
}

/** 合并课程星清单：按 `rel` 去重（新课追加，同课覆盖）—— 多节课分几次发也能累积成一张星图 */
function mergeIndex(destFile, srcFile) {
  const read = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const src = read(srcFile);
  if (!src || !Array.isArray(src.lessons)) return { ok: true, merged: 0, total: 0 };
  const dest = read(destFile) || { v: 1, source: 'lessons/src', lessons: [] };
  const byRel = new Map((dest.lessons || []).map((l) => [l.rel, l]));
  for (const l of src.lessons) if (l && l.rel) byRel.set(l.rel, l);
  const lessons = [...byRel.values()].sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, `${JSON.stringify({ v: 1, source: 'lessons/src', lessons }, null, 2)}\n`);
  return { ok: true, merged: src.lessons.length, total: lessons.length };
}

function importZip(buf, name) {
  if (!buf || !buf.length) return { ok: false, error: '收到的是空文件 —— 是不是没选到 zip？' };
  if (!/\.zip$/i.test(name || '')) return { ok: false, error: `只收 .zip 课件包（收到的是 ${name || '没有文件名'}）` };
  const tmpZip = path.join(os.tmpdir(), `whale-import-${process.pid}-${Date.now()}.zip`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-import-'));
  try {
    fs.writeFileSync(tmpZip, buf);
    const r = spawnSync(TAR, ['-xf', tmpZip, '-C', tmpDir], { encoding: 'utf8' });
    if (r.status !== 0) {
      return { ok: false, error: `解开课件包失败：${(`${r.stderr || r.stdout || ''}`).trim() || (r.error ? hintOf(r.error) : '（没有输出）')}` };
    }
    const metaFile = path.join(tmpDir, 'pack.json');
    if (!fs.existsSync(metaFile)) {
      return { ok: false, error: '这不是课件包（里面没有 pack.json）—— 请用插件里「导出」出来的那个 zip' };
    }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) {
      return { ok: false, error: `课件包的 pack.json 不是合法 JSON：${e?.message ?? e}` };
    }
    const rawId = String(meta.id || '').trim();
    if (!rawId) return { ok: false, error: '课件包的 pack.json 里没有 id —— 这份包不完整' };

    // ⚠️ **唯一课程库**：所有导入的课都合并进同一个包、共用一张星图。
    //    zip 里 `pack.json.id` 只作为**来源**记下来，不再决定目录 —— 这正是主人要的
    //    「导入完就在星图上看见」，而不是每包一张、还要手动打开。
    const dest = path.join(LIB, LIBRARY_DIR);
    migrateOldPacks();

    // 骨架：库不存在就整套铺；已存在则**只刷新 `tools/`（引擎）**，学生数据一个字节都不动。
    // ⚠️ 必须每次导入都刷新引擎：否则离线阅读器更新后，老库里那些包还在用旧脚本
    //    （用户 2026-09-26 实测踩到：新加的 `--allow-missing-requires` 在老包里不生效）。
    const skeleton = initSkeleton(dest, { refreshTools: true });
    if (!skeleton.ok) return { ok: false, error: `建库失败：${skeleton.error}` };

    const srcLessons = path.join(tmpDir, 'lessons');
    if (!fs.existsSync(srcLessons)) return { ok: false, error: '课件包里没有 lessons/ —— 这份包不完整' };
    // ⚠️ 清单**不跟着 mergeTree 走**（那会把它整个覆盖）—— 它由 mergeIndex 按 rel 合并
    const files = mergeTree(srcLessons, path.join(dest, 'lessons'), new Set(['lessons.json']));
    const idx = mergeIndex(path.join(dest, 'lessons', 'lessons.json'), path.join(srcLessons, 'lessons.json'));

    // 顶层标记文件（pack.json 覆盖、其余不覆盖）
    const destPack = path.join(dest, 'pack.json');
    if (!fs.existsSync(destPack)) fs.copyFileSync(metaFile, destPack);

    const rb = rebuild(LIBRARY_DIR);
    const stamp = new Date();
    fs.utimesSync(dest, stamp, stamp);
    return {
      ok: true,
      id: LIBRARY_DIR,
      source: rawId,                             // 这一课来自哪个包（来源信息，不决定目录）
      files,
      added: idx.merged,                         // 这次带进来几课
      lesson: meta.lesson || null,
      lessons: idx.total,                        // 库里现在共几课
      rebuilt: rb.ok,
      // ⚠️ 重建失败时**必须把原因带出去** —— 否则界面只能说"重建未成功"，人无从下手
      //    （用户 2026-09-26 实测反馈：导入了 vue 的课，重建失败但服务端没给 error）
      rebuildError: rb.ok ? null : (rb.error || '重建没跑通，但没有可读的原因'),
      steps: rb.steps,
      skeleton: { copied: skeleton.copied, skipped: skeleton.skipped },
      note: `已导入${meta.lesson?.title ? `「${meta.lesson.title}」` : ''}：这次加入 ${idx.merged} 课，`
        + `库里现在共 ${idx.total} 课${rb.ok ? '，星图已重建' : '，但重建没全过 —— 见 steps'}`,
    };
  } finally {
    try { fs.rmSync(tmpZip, { force: true }); } catch { /* 临时文件删不掉不致命 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}

/* ── 重建 ───────────────────────────────────────────────────────────────── */

function rebuild(id) {
  const dir = path.join(LIB, String(id || ''));
  if (!id || !fs.existsSync(dir)) return { ok: false, steps: [], error: `课程库里没有这个包：${id}` };
  const steps = [];
  for (const s of REBUILD_CHAIN) {
    const script = path.join(dir, 'tools', s.script);
    if (!fs.existsSync(script)) {
      steps.push({ script: s.script, code: -1, out: '（这个包里没有它 —— 如实报，不静默跳过）' });
      return { ok: false, steps, error: `包里缺 ${s.script} —— 骨架没铺全？` };
    }
    const r = spawnSync(process.execPath, [script, ...(s.args || [])], { cwd: dir, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    const code = r.status ?? 1;
    steps.push({ script: s.script, code, out: out.slice(-4000), hint: r.error ? hintOf(r.error) : undefined });
    if (code !== 0) {
      // ⚠️ 错误里**带上那一步输出的尾部** —— 光说"某某没跑通"等于没说（用户 2026-09-26 实测反馈）
      const tail = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 400);
      return { ok: false, steps, error: `${s.script} 没跑通（退出码 ${code}）${tail ? `：${tail}` : ''}` };
    }
  }
  return { ok: true, steps };
}

/* ── 包服务：按需起、复用、如实报 ────────────────────────────────────────── */

/** id → { port, child }（内存态：进程重启后要重新点「打开」） */
const children = new Map();

/** 对外的包地址 = **管理台自己的端口** + `/<包名>/` 前缀（内部端口不外露） */
const packUrl = (id) => `http://${HOST}:${PORT}/${encodeURIComponent(String(id))}/starmap/`;

/** 端口是不是**真的**空着 —— 必须真探测，不能只看自己记的 Map：
 *  别的程序占着某个端口时，光看 Map 会挑中它，表现就是「包服务起了但没答话」（主人 2026-09-26 实测踩到）。 */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}

async function freePort() {
  const used = new Set([...children.values()].map((c) => c.port));
  for (let p = 3092; p < 3142; p++) {
    if (p === PORT || used.has(p)) continue;
    if (await portFree(p)) return p;
  }
  return 0;
}

function probe(port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get({ host: HOST, port, path: '/healthz', timeout: 800 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 150);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tick();
  });
}

async function openPack(id) {
  const dir = path.join(LIB, String(id || ''));
  if (!id || !fs.existsSync(dir)) return { ok: false, error: `课程库里没有这个包：${id}` };
  const server = path.join(dir, 'tools', 'app-server.js');
  if (!fs.existsSync(server)) return { ok: false, error: `这个包里没有 tools/app-server.js —— 骨架没铺全，先重新导入一次` };

  const existing = children.get(id);
  if (existing && existing.child.exitCode === null) {
    return { ok: true, url: packUrl(id), port: PORT, started: false };
  }

  const port = await freePort();
  if (!port) return { ok: false, error: '端口不够用了（3092–3141 都被占着）—— 关掉一些再试' };
  const child = spawn(process.execPath, [server, String(port)], {
    cwd: dir,
    stdio: 'ignore',          // ⚠️ 必须 ignore：受限沙箱下 pipe 会 EPERM（本仓既有纪律）
    windowsHide: true,
  });
  children.set(id, { port, child });
  child.on('exit', () => { if (children.get(id)?.child === child) children.delete(id); });

  const alive = await probe(port);
  if (!alive) {
    try { child.kill(); } catch { /* 已经死了 */ }
    children.delete(id);
    return { ok: false, error: `包服务起了但没答话（内部端口 ${port}）—— 可能被别的程序占着；重开一次会自动换端口` };
  }
  // ⚠️ 回给界面的地址是**管理台自己的**地址（`/<包名>/starmap/`）—— 内部端口不外露：
  //    主人 2026-09-26 明确要求「每个课程怎么单独占一个端口，应该共用」。
  return { ok: true, url: packUrl(id), port: PORT, started: true };
}

/**
 * 移进回收站（可手工恢复）。
 * ⚠️ 包服务在跑时 Windows 会**锁住**包里的文件 ⇒ 必须先 kill **并等它真退出**，
 *    再 rename（还要退避重试：进程退出是异步的，立刻 rename 会 EBUSY / EPERM）。
 */
async function removePack(id) {
  const dir = path.join(LIB, String(id || ''));
  if (!id || !fs.existsSync(dir)) return { ok: false, error: `课程库里没有这个包：${id}` };
  const c = children.get(id);
  if (c) {
    try { c.child.kill(); } catch { /* 已经死了 */ }
    const exited = await waitExit(c.child, 5000);
    children.delete(id);
    if (!exited) return { ok: false, error: `包服务（端口 ${c.port}）没能在 5 秒内退出 —— 先手工关掉它再移除` };
  }
  const trash = path.join(LIB, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${id}-${Date.now()}`);
  for (let i = 0; i < 12; i++) {
    try {
      fs.renameSync(dir, dest);
      return { ok: true, moved: dest, note: `已移除（移进回收站，可手工恢复）：${dest}` };
    } catch (e) {
      if (i === 11) return { ok: false, error: `移进回收站失败（文件被占用？）：${e?.message ?? e}` };
      await sleep(250);
    }
  }
  return { ok: false, error: '移进回收站失败：重试次数用尽' };
}

/* ── HTTP ───────────────────────────────────────────────────────────────── */

/** 管理台页要穿**鲸师自己的主题与字体** —— 直接从课程包**同一份** `assets/` 取，不抄第二份令牌。
 *  （白名单扩展名 + 目录穿越防护；`assets/` 里没有可执行的东西） */
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const STATIC_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveAsset(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ''));
  const target = path.resolve(ASSETS_DIR, rel);
  if (!target.startsWith(ASSETS_DIR)) return json(res, { ok: false, error: '路径越界了' }, 403);
  const ext = path.extname(target).toLowerCase();
  if (!STATIC_MIME[ext]) return json(res, { ok: false, error: `不提供这种文件：${ext || '（没有扩展名）'}` }, 404);
  if (!fs.existsSync(target)) return json(res, { ok: false, error: `找不到：/assets/${rel}` }, 404);
  res.writeHead(200, { 'content-type': STATIC_MIME[ext], 'cache-control': 'no-store' });
  res.end(fs.readFileSync(target));
}

function sendAdmin(res) {
  if (!fs.existsSync(ADMIN_HTML)) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`管理台页面不在：${ADMIN_HTML} —— 这个安装不完整`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(ADMIN_HTML));
}

/**
 * 把 `/<包名>/…` 转发给那个包的**内部**服务。
 *
 * 为什么要有它（主人 2026-09-26 明确要求「每个课程怎么单独占一个端口，应该共用」）：
 * 课程包自己的 `tools/app-server.js` 是**单包**设计（`ROOT = 它自己的 __dirname/..`，
 * 页面里的 `../assets/…`、`./content.js` 也都按"服务根 = 包根"成立）——所以内部仍然是
 * 每包一个进程，但**对外只暴露管理台这一个端口**，用户看到的地址永远是
 * `http://127.0.0.1:<管理台端口>/<包名>/starmap/`。
 */
function proxyTo(req, res, targetPort) {
  // ⚠️ 必须**剥掉 `/<包名>` 那一段**再转发：包服务自己的静态根就是包根，
  //    原样转发会让它去找 `<包根>/<包名>/starmap/` ⇒ 404（第一版就是这么错的，判据当场抓到）。
  const raw = req.url || '/';
  const qIdx = raw.indexOf('?');
  const pathOnly = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const query = qIdx === -1 ? '' : raw.slice(qIdx);
  const segs = pathOnly.split('/');                    // ['', '<包名>', ...]
  const rest = `/${segs.slice(2).join('/')}`;
  const up = http.request({
    host: HOST,
    port: targetPort,
    path: (rest || '/') + query,
    method: req.method,
    headers: { ...req.headers, host: `${HOST}:${targetPort}` },
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (e) => json(res, { ok: false, error: `转发到包服务失败：${e?.message ?? e}` }, 502));
  req.pipe(up);
}

function collectBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 512 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks)));
  req.on('error', () => cb(Buffer.alloc(0)));
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return sendAdmin(res);
    if (p.startsWith('/assets/')) return serveAsset(res, p);
    if (p === '/api/health') {
      const info = libraryInfo();
      return json(res, { ok: true, port: PORT, dir: info.dir, lessons: info.lessonCount });
    }
    // 唯一课程库的现状（课程清单在这里 —— 界面按它渲染"每节课一行"）
    if (p === '/api/library') return json(res, libraryInfo());
    if (p === '/api/packs') return json(res, { ok: true, lib: LIB, packs: listPacks() });
    if (p === '/api/import') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '导入只接受 POST' }, 405);
      return collectBody(req, (buf) => json(res, importZip(buf, url.searchParams.get('name'))));
    }
    if (p === '/api/open') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      // 不给 id ⇒ 打开**唯一课程库**的星图（所有导入的课都在那一张上）
      return json(res, await openPack(url.searchParams.get('id') || LIBRARY_DIR));
    }
    if (p === '/api/remove') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      return json(res, await removePack(url.searchParams.get('id')));
    }
    // 清空课程库（整库进回收站，可手工恢复）
    if (p === '/api/clear') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      return json(res, await removePack(LIBRARY_DIR));
    }
    if (p === '/api/rebuild') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      return json(res, rebuild(url.searchParams.get('id') || LIBRARY_DIR));
    }
    // 课程包自己的页面与接口：`/<包名>/…` → 转发给它的内部服务（懒启动）。
    // 排在所有 `/api/*` 之后，包名绝不会和 api 抢路径。
    const seg = decodeURIComponent(p.split('/')[1] || '');
    if (seg && seg !== 'api' && seg !== 'assets' && !seg.includes('.')) {
      const running = children.get(seg);
      if (running && running.child.exitCode === null) return proxyTo(req, res, running.port);
      const opened = await openPack(seg);
      if (!opened.ok) return json(res, { ok: false, error: opened.error }, 404);
      const now = children.get(seg);
      if (!now) return json(res, { ok: false, error: '包服务没起来' }, 502);
      return proxyTo(req, res, now.port);
    }
    return json(res, { ok: false, error: `没有这个路径：${p}` }, 404);
  } catch (e) {
    return json(res, { ok: false, error: `服务端异常：${e?.message ?? e}` }, 200);
  }
}

const server = http.createServer(handler);

// 被 require 时不要自己 listen（判据要能直接驱动 handler）
if (require.main === module) {
  fs.mkdirSync(LIB, { recursive: true });
  migrateOldPacks();          // 老版本"每包一个目录"先合并进唯一课程库（幂等）
  // 退出时把包服务一并收走 —— 不然它们变成孤儿进程：占着端口、**锁着包里的文件**
  // （2026-09-26 实测：上一版留下的包服务，正是"老包移不进回收站"的原因）
  const bye = () => { for (const c of children.values()) { try { c.child.kill(); } catch { /* 已经死了 */ } } };
  process.on('exit', bye);
  process.on('SIGINT', () => { bye(); process.exit(0); });
  process.on('SIGTERM', () => { bye(); process.exit(0); });
  server.listen(PORT, HOST, () => {
    console.log(`[离线阅读器] http://${HOST}:${PORT}/`);
    console.log(`  课程库 ${LIB}`);
    console.log('  导入课件包：把老师发来的 .zip 拖到页面上');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[离线阅读器] 端口 ${PORT} 已被占用 —— 可能已经开着了。`);
      console.error(`[离线阅读器] 直接访问 http://${HOST}:${PORT}/ 即可；或换端口：node tools/offline-server.js 3100`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { handler, listPacks, importZip, rebuild, openPack, removePack, resolveLib, LIB, PORT, REBUILD_CHAIN };
