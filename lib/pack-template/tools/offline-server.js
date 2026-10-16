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
 * 老版本留下的 `packs/<包名>/` **不再在启动时自动合并**（T05 / 报告 D01：无条件动盘不可审计）——
 * 改为管理台里**显式**迁移：`GET /api/migration` 看计划，`POST /api/migrate` 带确认与计划摘要才动盘。
 *
 * **两条硬边界**（T05 / 报告 D01，判据落在 `test/audit/T05.mjs`）：
 *   ① **运行 id 只认固定库**：`openPack(id)` / `rebuild(id)` / `removePack(id)` 只接受 `library`，
 *      别的 id（`a/b`、`../x`、`/x`、盘符路径、反斜杠、控制字符…）一律**在碰盘与起子进程之前**拒掉，
 *      HTTP 侧回 **400**。省略 id 的既有默认仍是 `library`（`/api/remove` 没有默认：它要明说）。
 *   ② **导入只收课程数据**：上传的 zip 交给**受信 helper** `tools/import-zip.ps1`
 *      （Windows 自带 PowerShell/.NET ZipArchive，逐条校验 + 流写自建暂存目录）——
 *      只收 `pack.json` / 课程清单 / 合法层级 `halo.json`·`point.json` / 课程 HTML；
 *      `tools/**`、`lessons/src/**`、任何 `*.js`、链接、重复或大小写碰撞路径、危险条目一律拒。
 *      **全部验证通过才碰目标库**（拒绝时库树一个字节不变）。非支持平台**明确拒绝**，不静默回退 tar。
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
 *   GET  /api/migration        旧课程包的**只读**普查（计划 ＋ 计划摘要；不动盘）
 *   POST /api/import?name=x.zip  body = **zip 原始字节** → 受信 helper 校验/解压 → 合并进库 → 自动重建
 *   POST /api/open             打开唯一星图（不给 id 默认就是库；**别的 id 一律 400**）
 *   POST /api/rebuild          跑重建链，逐步回报（不给 id 默认就是库；别的 id 400）
 *   POST /api/migrate          body/query：{confirm:true, planDigest} → 显式迁移旧课程包
 *   POST /api/clear            整库移进 .trash（可撤销）
 *   ANY  /library/…            反向代理到唯一课程库的内部服务（懒启动）
 *   GET  /api/packs            兼容保留：列表里现在只有一个元素（库）
 *   POST /api/remove?id=       兼容保留（只认 library；清空整库请用 /api/clear）
 *
 * 判据：`test/audit/T05.mjs`（固定库 id / 受控解压 / 显式迁移）；旧行为回归见
 * `test/pack-open.mjs`、`test/rebuild-job.mjs`、`test/rebuild-wiring.mjs`。
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
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { initSkeleton } = require('./offline-bootstrap.js');
const { validateId, looksAbsolute, resolveInside } = require('./path-policy.cjs');

const HOST = '127.0.0.1';
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const PORT = Number(argOf('port') || argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 3091);
const ADMIN_HTML = path.join(__dirname, 'offline-admin.html');
/** 受信解压 helper（**只跑它一个**；与 offline-server.js 同目录 = 安装目录那一份，不是库里的） */
const IMPORT_HELPER = path.join(__dirname, 'import-zip.ps1');

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

/* ── 运行 id：**只认固定库**（T05 / 报告 D01）───────────────────────────── */

/**
 * 把一个"运行 id"解成**唯一允许的库目录名**。
 *
 * 为什么要有这一步：`openPack` / `rebuild` / `removePack` 都拿 id 拼路径，然后
 * **起子进程 / 移目录**。以前 id 原样进 `path.join(LIB, id)`：`../x` 能落到库外、
 * `a/b` 能落到别的层级、`/x` 与盘符路径能落成"看着绝对其实被拼进库"的怪路径 ——
 * 报告 D01 要挡的就是这一条。现在**唯一**允许的值就是 `library`，别的在**碰盘之前**拒。
 *
 * ⚠️ 判据要求"非法 id 在任何子进程前即拒绝"：所以这里**只做字符串判断**（不 fs.existsSync，
 *    也不 spawn）—— 返回 `{ok:false}` 时调用方必须**立刻**返回。
 *
 * @param {unknown} rawId 请求里的 id（`undefined` / `null` / `''` = 省略）
 * @param {{omitted?: string|null}} [opts] 省略 id 时的既有默认（`null` = 这个入口本来就没有默认）
 * @returns {{ok:true, id:string, omitted:boolean}|{ok:false, code:string, error:string}}
 */
function resolveRunId(rawId, opts = {}) {
  const omitted = opts.omitted === undefined ? LIBRARY_DIR : opts.omitted;
  if (rawId === undefined || rawId === null || rawId === '') {
    if (omitted === null) {
      return { ok: false, code: 'ID_REQUIRED', error: `这个入口要一个 id，而且只认唯一课程库「${LIBRARY_DIR}」` };
    }
    return { ok: true, id: omitted, omitted: true };
  }
  const s = String(rawId);
  if (s === LIBRARY_DIR) return { ok: true, id: LIBRARY_DIR, omitted: false };
  // 拒绝理由尽量说人话（口径仍来自共享路径策略 path-policy.cjs，不在这里另写一套判断）
  const why = looksAbsolute(s) ? '绝对路径'
    : (s.includes('/') || s.includes('\\')) ? '层级 / 反斜杠'
      : (validateId(s) ? '不是唯一课程库' : '不是合法 id');
  return {
    ok: false,
    code: 'ID_NOT_ALLOWED',
    error: `运行 id 只认唯一课程库「${LIBRARY_DIR}」（收到 ${JSON.stringify(s)}：${why}）—— `
      + '别的包名 / 层级 / 绝对路径一律不认',
  };
}

/* ── 导入白名单：只收课程数据（T05 / 报告 D01）──────────────────────────── */

/**
 * 导入的**硬上限**（与 `tools/import-zip.ps1` 的默认值同一套数）。
 * 上传 ≤64 MiB、条目 ≤4096、单文件 ≤32 MiB、展开合计 ≤256 MiB、膨胀比 ≤100、处理 ≤30 秒。
 */
const IMPORT_LIMITS = {
  maxUpload: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxFile: 32 * 1024 * 1024,
  maxTotal: 256 * 1024 * 1024,
  maxRatio: 100,
  timeoutSec: 30,
};

/** 不许当 halo / point 目录名的分段（与 helper 里那份同名清单**同一串**） */
const IMPORT_RESERVED_SEGMENTS = ['src', 'tools', 'node_modules'];
/** halo / point id 的形状：与共享路径策略 `path-policy.cjs` 的 `ID_RE` **同一份**（不抄第二串正则） */
const IMPORT_ID_RE = /^[a-z][a-z0-9-]*$/;
const IMPORT_ID_PATTERN = IMPORT_ID_RE.source;
/** 课程页文件名（产品件，形如 `0001-vue-render-http-data.html`） */
const IMPORT_LESSON_RE = /^[^\\/:*?"<>|]+\.html$/;

/**
 * 判断一个 zip 条目（**已规范化的 POSIX 相对路径**）算不算课程数据。
 *
 * ⚠️ 这是 `import-zip.ps1` 里那份 allowlist 的 **JS 镜像**：helper 是子进程、它按同一套
 *    规则逐条判；这里再判一次是**纵深**（helper 被换掉 / 版本漂了也不会放进来）。
 *    两份**不许漂** —— 判据 `T05-IMPORT-allowlist-parity` 用同一批边界条目逐条对拍。
 *
 * @param {string} rel
 * @returns {{ok:true, kind:'pack'|'index'|'halo'|'point'|'lesson'}|{ok:false, code:string, error:string}}
 */
function classifyImportEntry(rel) {
  const bad = (code, error) => ({ ok: false, code, error });
  if (typeof rel !== 'string' || !rel) return bad('ZIP_DANGEROUS_ENTRY', `条目名不是字符串：${JSON.stringify(rel)}`);
  let n = rel;
  while (n.startsWith('./')) n = n.slice(2);
  if (!n || n === '.') return bad('ZIP_DANGEROUS_ENTRY', `条目指向根：${JSON.stringify(rel)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return bad('ZIP_DANGEROUS_ENTRY', `条目名里有控制字符：${JSON.stringify(rel)}`);
  if (n.includes('\\')) return bad('ZIP_DANGEROUS_ENTRY', `条目用了反斜杠分隔符：${n}`);
  if (n.startsWith('/')) return bad('ZIP_DANGEROUS_ENTRY', `条目是绝对路径：${n}`);
  if (/^[A-Za-z]:/.test(n)) return bad('ZIP_DANGEROUS_ENTRY', `条目带盘符：${n}`);
  if (n.includes(':')) return bad('ZIP_DANGEROUS_ENTRY', `条目里有冒号（盘符 / 数据流）：${n}`);
  const segs = n.split('/');
  for (const s of segs) {
    if (s === '') return bad('ZIP_DANGEROUS_ENTRY', `条目有空的分段：${n}`);
    if (s === '.' || s === '..') return bad('ZIP_DANGEROUS_ENTRY', `条目有穿越分段：${n}`);
    if (/[ .]$/.test(s)) return bad('ZIP_DANGEROUS_ENTRY', `条目分段以空格或点结尾（Windows 会裁掉）：${n}`);
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s.split('.')[0])) {
      return bad('ZIP_DANGEROUS_ENTRY', `条目分段是保留设备名：${n}`);
    }
  }
  const notAllowed = () => bad('ZIP_ENTRY_NOT_ALLOWED', `这个包里带着不属于课程数据的东西：${n}`);
  const idOk = (s) => IMPORT_ID_RE.test(s) && !IMPORT_RESERVED_SEGMENTS.includes(s);
  if (segs.length === 1) return n === 'pack.json' ? { ok: true, kind: 'pack' } : notAllowed();
  if (segs[0] !== 'lessons') return notAllowed();
  if (segs.length === 2) return segs[1] === 'lessons.json' ? { ok: true, kind: 'index' } : notAllowed();
  if (segs.length === 3) {
    return (segs[2] === 'halo.json' && idOk(segs[1])) ? { ok: true, kind: 'halo' } : notAllowed();
  }
  if (segs.length === 4) {
    if (!(idOk(segs[1]) && idOk(segs[2]))) return notAllowed();
    if (segs[3] === 'point.json') return { ok: true, kind: 'point' };
    if (IMPORT_LESSON_RE.test(segs[3]) && !segs[3].startsWith('.')) return { ok: true, kind: 'lesson' };
    return notAllowed();
  }
  return notAllowed();
}

/** 受信 helper 能不能跑：平台 + 脚本 + PowerShell 都得在，缺一个就**明确拒绝**（不静默回退 tar） */
function importHelperSupport() {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED_PLATFORM', error: '这个平台没有受信的 zip 解压 helper（只有 Windows 自带 PowerShell/.NET ZipArchive 那一份）—— 明确拒绝，不回退 tar' };
  }
  if (!fs.existsSync(IMPORT_HELPER)) {
    return { ok: false, code: 'UNSUPPORTED_PLATFORM', error: `受信解压 helper 不在：${IMPORT_HELPER} —— 这个安装不完整` };
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
  for (const exe of candidates) {
    if (exe === 'powershell.exe' || fs.existsSync(exe)) return { ok: true, exe, helper: IMPORT_HELPER };
  }
  return { ok: false, code: 'UNSUPPORTED_PLATFORM', error: '找不到 PowerShell —— 受信解压 helper 跑不起来（明确拒绝，不回退 tar）' };
}

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

/* ── 迁移：老版本"每包一个目录" → 唯一课程库（**显式**，不再启动时自动合并）──── */

/**
 * 旧课程包的**只读**普查：谁需要迁移、各带几课、多大。**一个字节都不写盘**。
 *
 * 为什么要有"计划"这一步（T05 / 报告 D01）：老实现是**启动时无条件合并** ——
 * 谁在 `packs/` 下放一个带 `lessons/` 的目录，就会在下次开管理台时被静默并进库、
 * 原目录被改名进 `.trash`。那是"自动猜旧目录归属"，既不可审计也不可撤销。
 * 现在改成：先看计划（本函数），人点头（`applyLegacyMigration({confirm:true, planDigest})`）才动盘。
 *
 * @returns {{ok:true, lib:string, library:string, libraryExists:boolean, plan:object[], count:number, digest:string, note:string}}
 */
function planLegacyMigration() {
  const libraryDir = path.join(LIB, LIBRARY_DIR);
  const migrated = readMigrated();
  const plan = [];
  if (fs.existsSync(LIB)) {
    for (const e of fs.readdirSync(LIB, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === LIBRARY_DIR || e.name.startsWith('.')) continue;
      if (migrated.includes(e.name)) continue;
      const dir = path.join(LIB, e.name);
      const lessonsDir = path.join(dir, 'lessons');
      if (!fs.existsSync(lessonsDir)) continue;          // 不像课程包 —— 不猜
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { /* 半路被删就当 0 */ }
      plan.push({ id: e.name, dir, lessons: countLessons(dir), bytes: dirBytes(dir), mtimeMs });
    }
  }
  plan.sort((a, b) => a.id.localeCompare(b.id));
  const digest = migrationDigest(plan);
  return {
    ok: true,
    lib: LIB,
    library: libraryDir,
    libraryExists: fs.existsSync(libraryDir),
    plan,
    count: plan.length,
    digest,
    note: plan.length
      ? `发现 ${plan.length} 个旧课程包（${plan.map((p) => p.id).join('、')}）—— 确认后才会合并进唯一课程库，原目录进 .trash`
      : '没有需要迁移的旧课程包',
  };
}

/**
 * 计划摘要：同一份计划**永远同一串**（逐字节可复算），计划一变摘要就变 ——
 * 于是"看的是旧计划、点的是新现状"会被 `applyLegacyMigration` 当场拒掉（stale plan）。
 * ⚠️ 绝不把"现在几点"混进去：那样同一份计划两次算出来的摘要就不同，判据没法复算。
 */
function migrationDigest(plan) {
  const canonical = plan
    .map((p) => `${p.id}|${p.lessons}|${p.bytes}|${Math.round(p.mtimeMs)}`)
    .join('\n');
  return crypto.createHash('sha256').update(`whale-legacy-migration/v1\n${canonical}\n`).digest('hex').slice(0, 32);
}

/**
 * **显式**迁移：把老版本留下的 `packs/<包名>/` 合并进唯一课程库 `packs/library/`，
 * 老包移进 `.trash`（可恢复）。幂等：合并过的老包已经不在原位置，下次不会再合并一遍。
 *
 * 三道门（缺一不动盘）：`confirm === true`、带 `planDigest`、且摘要与**刚算的**计划一致。
 *
 * @param {{confirm?:boolean, planDigest?:string}} [body]
 * @returns {{ok:boolean, code:string, migrated?:string[], plan?:object[], digest?:string, rebuild?:object, error?:string}}
 */
function applyLegacyMigration(body = {}) {
  const b = body || {};
  if (b.confirm !== true) {
    return { ok: false, code: 'MIGRATION_NOT_CONFIRMED', error: '迁移旧课程包要显式确认（confirm: true）才动盘 —— 先看一眼计划' };
  }
  if (!b.planDigest) {
    return { ok: false, code: 'MIGRATION_PLAN_REQUIRED', error: '迁移要带上一份计划摘要（planDigest）—— 那是"人看过的就是这一份"的凭据' };
  }
  const fresh = planLegacyMigration();
  if (String(b.planDigest) !== fresh.digest) {
    return { ok: false, code: 'MIGRATION_PLAN_STALE', error: '这份计划已经过期（库里的现状变了）—— 重新看一眼再确认', plan: fresh.plan, digest: fresh.digest };
  }
  if (!fresh.count) {
    return { ok: true, code: 'MIGRATION_NOTHING', migrated: [], plan: [], digest: fresh.digest, rebuild: null, note: '没有需要迁移的旧课程包' };
  }
  const done = migrateOldPacks();
  return {
    ok: done.ok,
    code: done.ok ? 'MIGRATION_DONE' : 'MIGRATION_FAILED',
    migrated: done.migrated,
    plan: fresh.plan,
    digest: fresh.digest,
    rebuild: done.rebuild,
    error: done.error,
    note: `已把 ${done.migrated.length} 个旧课程包合并进唯一课程库：${done.migrated.join('、')}`,
  };
}

/**
 * 真正动盘的那一半（**只许被 `applyLegacyMigration` 调用**；启动路径不许再无条件跑它）。
 * @returns {{ok:boolean, migrated:string[], rebuild:object|null, error?:string}}
 */
function migrateOldPacks() {
  const empty = { ok: true, migrated: [], rebuild: null };
  if (!fs.existsSync(LIB)) return empty;
  const libraryDir = path.join(LIB, LIBRARY_DIR);
  const migrated = [];
  let error;
  for (const e of fs.readdirSync(LIB, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === LIBRARY_DIR || e.name.startsWith('.')) continue;
    const src = path.join(LIB, e.name);
    const srcLessons = path.join(src, 'lessons');
    if (!fs.existsSync(srcLessons)) continue;

    if (!fs.existsSync(libraryDir)) {
      const s = initSkeleton(libraryDir, { refreshTools: true });
      if (!s.ok) { error = `建库失败：${s.error}`; break; }
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
  let rb = null;
  if (migrated.length) {
    const mark = path.join(LIB, '.migrated.json');
    const known = readMigrated();
    const all = [...new Set([...known, ...migrated])];
    fs.writeFileSync(mark, `${JSON.stringify(all, null, 2)}\n`);
    rb = rebuild(LIBRARY_DIR);
    console.log(`[离线阅读器] 已把 ${migrated.length} 个旧课程包合并进唯一课程库：${migrated.join('、')}`);
  }
  return { ok: !error, migrated, rebuild: rb, error };
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

/**
 * 导入一个课件包 zip。
 *
 * 流程（顺序即契约 —— **全部验证通过才碰目标库**）：
 *   ① 便宜的门：非空 / `.zip` / 上传 ≤64 MiB / 平台与 helper 在；
 *   ② 把字节落成临时 zip，交给**受信 helper** `import-zip.ps1`：它逐条校验（形状 / 链接 /
 *      重复与大小写碰撞 / 上限 / 白名单）并**只把课程数据**流写进自建暂存目录；
 *      helper 拒绝 → 原样带回 `{ok:false, code, error}`，**暂存树与库树都不变**；
 *   ③ 纵深复验：把暂存树**逐条**按同一份白名单再判一次（`classifyImportEntry`），
 *      并用共享路径策略 `resolveInside` 确认每个落点都在暂存根内、且不是链接；
 *   ④ 只有到这里才动库：铺骨架（刷新 `tools/`）→ 合并 `lessons/` → 合并清单 → 重建。
 *
 * @param {Buffer} buf 原始 zip 字节
 * @param {string} name 上传的文件名（要 `.zip`）
 * @returns {{ok:boolean, code:string, error?:string, ...}}
 */
function importZip(buf, name) {
  if (!buf || !buf.length) return { ok: false, code: 'EMPTY_BODY', error: '收到的是空文件 —— 是不是没选到 zip？' };
  if (!/\.zip$/i.test(name || '')) return { ok: false, code: 'NOT_ZIP', error: `只收 .zip 课件包（收到的是 ${name || '没有文件名'}）` };
  if (buf.length > IMPORT_LIMITS.maxUpload) {
    return {
      ok: false,
      code: 'UPLOAD_TOO_BIG',
      error: `上传的包太大（${(buf.length / 1024 / 1024).toFixed(1)} MiB）—— 上限 ${IMPORT_LIMITS.maxUpload / 1024 / 1024} MiB`,
    };
  }
  const sup = importHelperSupport();
  if (!sup.ok) return sup;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-import-'));
  const tmpZip = path.join(work, 'upload.zip');
  const staging = path.join(work, 'staging');
  const resultFile = path.join(work, 'result.json');
  try {
    fs.writeFileSync(tmpZip, buf);
    fs.mkdirSync(staging, { recursive: true });
    const r = spawnSync(sup.exe, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sup.helper,
      '-Zip', tmpZip, '-Staging', staging, '-Result', resultFile,
      '-IdPattern', IMPORT_ID_PATTERN,
      '-MaxEntries', String(IMPORT_LIMITS.maxEntries),
      '-MaxFile', String(IMPORT_LIMITS.maxFile),
      '-MaxTotal', String(IMPORT_LIMITS.maxTotal),
      '-MaxRatio', String(IMPORT_LIMITS.maxRatio),
      '-TimeoutSec', String(IMPORT_LIMITS.timeoutSec),
    ], {
      // ⚠️ `ignore` 而不是 pipe：受限沙箱下 piped stdio 的 spawn 会被 EPERM 拒（本仓既有纪律）。
      //     helper 的回执走 `-Result` 那个文件，不靠 stdout。
      stdio: 'ignore',
      windowsHide: true,
      timeout: (IMPORT_LIMITS.timeoutSec + 15) * 1000,
    });
    if (r.error?.code === 'ETIMEDOUT' || r.signal) {
      return { ok: false, code: 'ZIP_TIMEOUT', error: `解压 helper 超过 ${IMPORT_LIMITS.timeoutSec} 秒没回来 —— 已中止，库没有动` };
    }
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { receipt = null; }
    if (!receipt || typeof receipt !== 'object') {
      const why = r.error ? hintOf(r.error) : `退出码 ${r.status === null ? 'null（崩溃 / 被杀）' : r.status}`;
      return { ok: false, code: 'ZIP_HELPER_NO_RECEIPT', error: `解压 helper 没有留下回执（${why}）—— 库没有动` };
    }
    if (receipt.ok !== true) {
      return { ok: false, code: String(receipt.code || 'ZIP_REJECTED'), error: String(receipt.error || '这个包被拒绝导入') };
    }

    // ── ③ 纵深复验：不信 helper 的清单，走一遍**真实**暂存树 ────────────────
    const walked = walk(staging);
    for (const rel of walked) {
      const cls = classifyImportEntry(rel);
      if (!cls.ok) return { ok: false, code: cls.code, error: `暂存树里有不该有的条目：${cls.error}` };
      const abs = path.join(staging, ...rel.split('/'));
      let lst = null;
      try { lst = fs.lstatSync(abs); } catch { return { ok: false, code: 'ZIP_IO_ERROR', error: `暂存树里的条目读不动：${rel}` }; }
      if (lst.isSymbolicLink()) return { ok: false, code: 'ZIP_LINK_ENTRY', error: `暂存树里出现了链接：${rel}` };
      if (!lst.isFile()) return { ok: false, code: 'ZIP_LINK_ENTRY', error: `暂存树里出现了非普通文件：${rel}` };
      const inside = resolveInside(staging, rel, { mustExist: true });
      if (!inside.ok) return { ok: false, code: 'ZIP_PATH_ESCAPE', error: `暂存树的落点越界：${rel}（${inside.error}）` };
    }
    const declared = Array.isArray(receipt.files) ? receipt.files.map(String).sort() : [];
    if (JSON.stringify(declared) !== JSON.stringify([...walked].sort())) {
      return { ok: false, code: 'ZIP_STAGING_MISMATCH', error: '解压 helper 的回执与暂存树对不上 —— 拒绝导入（库没有动）' };
    }

    const metaFile = path.join(staging, 'pack.json');
    if (!fs.existsSync(metaFile)) {
      return { ok: false, code: 'NO_PACK_JSON', error: '这不是课件包（里面没有 pack.json）—— 请用插件里「导出」出来的那个 zip' };
    }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) {
      return { ok: false, code: 'BAD_PACK_JSON', error: `课件包的 pack.json 不是合法 JSON：${e?.message ?? e}` };
    }
    const rawId = String(meta.id || '').trim();
    if (!rawId) return { ok: false, code: 'NO_PACK_ID', error: '课件包的 pack.json 里没有 id —— 这份包不完整' };
    const srcLessons = path.join(staging, 'lessons');
    if (!fs.existsSync(srcLessons)) return { ok: false, code: 'NO_LESSONS', error: '课件包里没有 lessons/ —— 这份包不完整' };

    // ── ④ 到这里才碰目标库 ────────────────────────────────────────────────
    // ⚠️ **唯一课程库**：所有导入的课都合并进同一个包、共用一张星图。
    //    zip 里 `pack.json.id` 只作为**来源**记下来，不再决定目录 —— 这正是主人要的
    //    「导入完就在星图上看见」，而不是每包一张、还要手动打开。
    const dest = path.join(LIB, LIBRARY_DIR);

    // 骨架：库不存在就整套铺；已存在则**只刷新 `tools/`（引擎）**，学生数据一个字节都不动。
    // ⚠️ 必须每次导入都刷新引擎：否则离线阅读器更新后，老库里那些包还在用旧脚本
    //    （用户 2026-09-26 实测踩到：新加的 `--allow-missing-requires` 在老包里不生效）。
    const skeleton = initSkeleton(dest, { refreshTools: true });
    if (!skeleton.ok) return { ok: false, code: 'SKELETON_FAILED', error: `建库失败：${skeleton.error}` };

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
      code: 'OK',
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
    // 临时 zip 与暂存树都在同一个临时根下 —— 一次删干净（拒绝路径也走这里）
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录删不掉不致命 */ }
  }
}

/* ── 重建 ───────────────────────────────────────────────────────────────── */

function rebuild(id) {
  const rid = resolveRunId(id);
  if (!rid.ok) return { ok: false, code: rid.code, steps: [], error: rid.error };
  const dir = path.join(LIB, rid.id);
  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'NO_LIBRARY', steps: [], error: `课程库里还没有唯一课程库（${LIBRARY_DIR}）—— 先导入一个课件包` };
  }
  const steps = [];
  for (const s of REBUILD_CHAIN) {
    const script = path.join(dir, 'tools', s.script);
    if (!fs.existsSync(script)) {
      steps.push({ script: s.script, code: -1, out: '（这个包里没有它 —— 如实报，不静默跳过）' });
      return { ok: false, code: 'MISSING_SCRIPT', steps, error: `包里缺 ${s.script} —— 骨架没铺全？` };
    }
    const r = spawnSync(process.execPath, [script, ...(s.args || [])], { cwd: dir, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    const code = r.status ?? 1;
    steps.push({ script: s.script, code, out: out.slice(-4000), hint: r.error ? hintOf(r.error) : undefined });
    if (code !== 0) {
      // ⚠️ 错误里**带上那一步输出的尾部** —— 光说"某某没跑通"等于没说（用户 2026-09-26 实测反馈）
      const tail = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 400);
      return { ok: false, code: 'STEP_FAILED', steps, error: `${s.script} 没跑通（退出码 ${code}）${tail ? `：${tail}` : ''}` };
    }
  }
  return { ok: true, code: 'OK', steps };
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

/**
 * 打开唯一课程库的星图（按需起一个包服务）。
 *
 * ⚠️ **id 只认 `library`**，而且非法 id 在**任何子进程之前**就被拒（`resolveRunId` 只做字符串判断）——
 *    这是报告 D01 要挡的那条：以前 `id` 原样进 `path.join(LIB, id)`，`../x` 能起库外的服务。
 */
async function openPack(id) {
  const rid = resolveRunId(id);
  if (!rid.ok) return rid;
  const dir = path.join(LIB, rid.id);
  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'NO_LIBRARY', error: `课程库里还没有唯一课程库（${LIBRARY_DIR}）—— 先导入一个课件包` };
  }
  const server = path.join(dir, 'tools', 'app-server.js');
  if (!fs.existsSync(server)) {
    return { ok: false, code: 'MISSING_SERVER', error: '这个库里没有 tools/app-server.js —— 骨架没铺全，先重新导入一次' };
  }

  const existing = children.get(rid.id);
  if (existing && existing.child.exitCode === null) {
    return { ok: true, code: 'OK', url: packUrl(rid.id), port: PORT, started: false };
  }

  const port = await freePort();
  if (!port) return { ok: false, code: 'NO_FREE_PORT', error: '端口不够用了（3092–3141 都被占着）—— 关掉一些再试' };
  const child = spawn(process.execPath, [server, String(port)], {
    cwd: dir,
    stdio: 'ignore',          // ⚠️ 必须 ignore：受限沙箱下 pipe 会 EPERM（本仓既有纪律）
    windowsHide: true,
  });
  children.set(rid.id, { port, child });
  child.on('exit', () => { if (children.get(rid.id)?.child === child) children.delete(rid.id); });

  const alive = await probe(port);
  if (!alive) {
    try { child.kill(); } catch { /* 已经死了 */ }
    children.delete(rid.id);
    return { ok: false, code: 'NO_ANSWER', error: `包服务起了但没答话（内部端口 ${port}）—— 可能被别的程序占着；重开一次会自动换端口` };
  }
  // ⚠️ 回给界面的地址是**管理台自己的**地址（`/library/starmap/`）—— 内部端口不外露：
  //    主人 2026-09-26 明确要求「每个课程怎么单独占一个端口，应该共用」。
  return { ok: true, code: 'OK', url: packUrl(rid.id), port: PORT, started: true };
}

/**
 * 移进回收站（可手工恢复）。
 *
 * ⚠️ **id 只认 `library`**，非法 id 在**任何 rename 之前**就被拒（报告 D01 的 `renameSync` 那条）。
 *    这个入口**没有"省略 id"的默认**（老行为也没有）：要动整库请显式说 `id=library`，或用 `/api/clear`。
 * ⚠️ 包服务在跑时 Windows 会**锁住**包里的文件 ⇒ 必须先 kill **并等它真退出**，
 *    再 rename（还要退避重试：进程退出是异步的，立刻 rename 会 EBUSY / EPERM）。
 */
async function removePack(id) {
  const rid = resolveRunId(id, { omitted: null });
  if (!rid.ok) return rid;
  const dir = path.join(LIB, rid.id);
  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'NO_LIBRARY', error: `课程库里还没有唯一课程库（${LIBRARY_DIR}）` };
  }
  const c = children.get(rid.id);
  if (c) {
    try { c.child.kill(); } catch { /* 已经死了 */ }
    const exited = await waitExit(c.child, 5000);
    children.delete(rid.id);
    if (!exited) return { ok: false, code: 'BUSY', error: `包服务（端口 ${c.port}）没能在 5 秒内退出 —— 先手工关掉它再移除` };
  }
  const trash = path.join(LIB, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${rid.id}-${Date.now()}`);
  for (let i = 0; i < 12; i++) {
    try {
      fs.renameSync(dir, dest);
      return { ok: true, code: 'OK', moved: dest, note: `已移除（移进回收站，可手工恢复）：${dest}` };
    } catch (e) {
      if (i === 11) return { ok: false, code: 'RENAME_FAILED', error: `移进回收站失败（文件被占用？）：${e?.message ?? e}` };
      await sleep(250);
    }
  }
  return { ok: false, code: 'RENAME_FAILED', error: '移进回收站失败：重试次数用尽' };
}

/** 收走所有包服务（退出时用；也导出给判据 —— 不然它会留下孤儿进程占着端口、锁着库里的文件） */
function closePackServers() {
  const killed = [];
  for (const [id, c] of children) {
    try { c.child.kill(); killed.push(id); } catch { /* 已经死了 */ }
  }
  children.clear();
  return killed;
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
    // 旧课程包的**只读**普查（T05）：只报计划与摘要，一个字节都不动
    if (p === '/api/migration') return json(res, planLegacyMigration());
    if (p === '/api/import') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '导入只接受 POST' }, 405);
      return collectBody(req, (buf) => json(res, importZip(buf, url.searchParams.get('name'))));
    }
    if (p === '/api/open') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      // 不给 id ⇒ 打开**唯一课程库**的星图（所有导入的课都在那一张上）；
      // 给了 id ⇒ 只认 `library`，别的**当场 400**（而且那时还没碰盘、没起子进程）
      const rid = resolveRunId(url.searchParams.get('id'));
      if (!rid.ok) return json(res, rid, 400);
      return json(res, await openPack(rid.id));
    }
    if (p === '/api/remove') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      // 兼容保留入口：**没有**"省略 id"的默认（老行为也没有）—— 要动整库请显式 id=library 或用 /api/clear
      const rid = resolveRunId(url.searchParams.get('id'), { omitted: null });
      if (!rid.ok) return json(res, rid, 400);
      return json(res, await removePack(rid.id));
    }
    // 清空课程库（整库进回收站，可手工恢复）
    if (p === '/api/clear') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      return json(res, await removePack(LIBRARY_DIR));
    }
    if (p === '/api/rebuild') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      const rid = resolveRunId(url.searchParams.get('id'));
      if (!rid.ok) return json(res, rid, 400);
      return json(res, rebuild(rid.id));
    }
    // 显式迁移旧课程包：`{confirm:true, planDigest}`（body 或 query 都收）—— 不确认不动盘
    if (p === '/api/migrate') {
      if (req.method !== 'POST') return json(res, { ok: false, error: '只接受 POST' }, 405);
      return collectBody(req, (buf) => {
        let body = {};
        try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { body = {}; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
        const q = url.searchParams;
        const confirm = body.confirm === true || q.get('confirm') === '1' || q.get('confirm') === 'true';
        const planDigest = body.planDigest || q.get('digest') || '';
        return json(res, applyLegacyMigration({ confirm, planDigest }));
      });
    }
    // 课程包自己的页面与接口：`/library/…` → 转发给唯一课程库的内部服务（懒启动）。
    // 排在所有 `/api/*` 之后，包名绝不会和 api 抢路径。
    const seg = decodeURIComponent(p.split('/')[1] || '');
    if (seg && seg !== 'api' && seg !== 'assets' && !seg.includes('.')) {
      // ⚠️ 只有唯一课程库这一个段能转发（别的段 `openPack` 会以 ID_NOT_ALLOWED 拒掉）
      const running = children.get(seg);
      if (running && running.child.exitCode === null) return proxyTo(req, res, running.port);
      const opened = await openPack(seg);
      if (!opened.ok) return json(res, { ok: false, code: opened.code, error: opened.error }, 404);
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
  // ⚠️ **不再**在启动时无条件合并旧课程包（T05 / 报告 D01）：只**报**，不动盘。
  //    真迁移走 `POST /api/migrate`（要 confirm + planDigest）—— 见 applyLegacyMigration()。
  try {
    const legacy = planLegacyMigration();
    if (legacy.count) {
      console.log(`[离线阅读器] 发现 ${legacy.count} 个旧课程包（${legacy.plan.map((x) => x.id).join('、')}）`);
      console.log('  —— 已不再自动合并。到管理台里点「迁移旧课程包」显式确认（计划摘要会一并带上）。');
    }
  } catch (e) {
    console.error(`[离线阅读器] 旧课程包普查失败（不影响启动）：${e?.message ?? e}`);
  }
  // 退出时把包服务一并收走 —— 不然它们变成孤儿进程：占着端口、**锁着包里的文件**
  // （2026-09-26 实测：上一版留下的包服务，正是"老包移不进回收站"的原因）
  const bye = () => { closePackServers(); };
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

module.exports = {
  handler,
  listPacks,
  libraryInfo,
  importZip,
  rebuild,
  openPack,
  removePack,
  closePackServers,
  resolveRunId,
  classifyImportEntry,
  planLegacyMigration,
  applyLegacyMigration,
  importHelperSupport,
  resolveLib,
  LIB,
  LIBRARY_DIR,
  PORT,
  REBUILD_CHAIN,
  IMPORT_LIMITS,
};
