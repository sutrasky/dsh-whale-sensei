#!/usr/bin/env node
/**
 * build-starmap.js — 星图数据生成器（课程包 → 星图数据）
 * ------------------------------------------------------------------
 * 用法： node tools/build-starmap.js [--check]
 *
 * 输入： lessons/<halo>/halo.json          圆圈（大恒星）+ 课程之间的连线
 *        lessons/<halo>/<point>/point.json 知识点（轨道）+ `plan` 地图（规划暗星的唯一来源）
 *        lessons/src/**\/*.html 的 data-lesson-meta   课程（小星星）
 *        progress.json                     哪几颗星已经点亮
 * 输出： starmap/content.js   window.STARMAP_REAL
 *
 * 规划暗星（`_board/01-鲸师.md:202-206`「地图作为方向标」）：每个知识点的地图前沿
 * （"下一颗该学的星"，支线分叉时两颗）以 `planned` 挂在 `halos[].points[]` 里 ——
 * **只带前沿**（tools/plan-map.js 的 planFrontier().stars），不是 plan.nodes 全量。
 * 前沿判断只用现成的 plan-map.js（= 插件 lib/plan.js 的镜像，两边有对拍），**不重写**。
 *
 * 为什么是"生成"而不是手写：加一课就自动多一颗星，星图与课程永不失同步；
 * 确定性（无时间戳、无随机、排序固定）→ --check 才有意义，才能进闸门。
 *
 * 三条硬规则（违反就大声说，绝不静默）：
 *   ① 每颗星都必须对应一个**真实存在的课程页**；构建产物缺失时报警。
 *   ② edges 的端点缺了就报警并跳过 —— 不许悄悄少画一条线。
 *   ③ lessons/src/ 根下的平铺课程是历史布局，归给 LEGACY_POINT，并在输出里点名。
 *
 * **MIRROR-OF: lib/pack-scaffold.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LESSONS = path.join(ROOT, 'lessons');
const SRC = path.join(LESSONS, 'src');
const OUT_DIR = path.join(ROOT, 'starmap');
const OUT = path.join(OUT_DIR, 'content.js');
const PROGRESS = path.join(ROOT, 'progress.json');
const GX = require('./galaxy-shapes.cjs');     // 星系形状字典（与测试共用同一份真相）

/** 历史平铺布局里的课归给这个圆圈 / 知识点（三层目录落地后这段会消失） */
const LEGACY_HALO = 'programming';
const LEGACY_POINT = 'spring-boot';

const checkOnly = process.argv.includes('--check');
const warns = [];
const warn = (m) => warns.push(m);
const notes = [];
const note = (m) => notes.push(m);

/* 规划地图（point.json 的 plan）：前沿"下一颗星"**只用现成的 tools/plan-map.js**
   （= 插件 lib/plan.js 的镜像，两边有对拍；这里绝不重写第二份判据）。
   它是本脚本的**直接依赖**，随包模板（lib/pack-template/tools/plan-map.js）一起发 ——
   缺了就当场炸（Cannot find module），不许静默降级成"没有暗星"。 */
const { planFrontier } = require(path.join(__dirname, 'plan-map.js'));

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

/** 递归收集 lessons/src 下的所有 .html（相对 SRC 的 posix 路径） */
function walkSrc(dir = SRC, prefix = '') {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkSrc(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

function lessonMeta(rel) {
  const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
  const m = text.match(/<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/);
  if (!m) { warn(`${rel}: 没有 data-lesson-meta，跳过`); return null; }
  try { return JSON.parse(m[1]); } catch (e) { warn(`${rel}: meta 不是合法 JSON —— ${e.message}`); return null; }
}

/* ── 圆圈（halo）与知识点（point）───────────────────────────────────────── */
const halos = [];
if (exists(LESSONS)) {
  for (const d of fs.readdirSync(LESSONS, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory()) continue;
    const haloFile = path.join(LESSONS, d.name, 'halo.json');
    if (!exists(haloFile)) continue;
    const halo = readJSON(haloFile);
    const points = [];
    for (const p of fs.readdirSync(path.join(LESSONS, d.name), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!p.isDirectory()) continue;
      const pf = path.join(LESSONS, d.name, p.name, 'point.json');
      if (!exists(pf)) continue;
      points.push({ ...readJSON(pf), id: p.name, halo: d.name });
    }
    halos.push({ ...halo, id: d.name, points });
  }
}
if (!halos.length) {
  console.error('没有找到任何 lessons/<halo>/halo.json —— 星图无从生成');
  process.exit(1);
}

/* ── 星系形状：硬校验 + 防单调审计 ─────────────────────────────────────
   形状字典在 tools/galaxy-shapes.cjs（白名单 + 使用判断 + 防单调），与图型系统同一套规矩。
   校验**失败即退出**（不静默降级成单星 —— 那样只会让人以为"配了没生效"）。 */
{
  const errsAll = [];
  for (const h of halos) {
    const errs = GX.validate(h, halos);
    if (errs.length) errsAll.push(`${h.id}：${errs.join('；')}`);
  }
  if (errsAll.length) {
    console.error('星系形状有问题（见 tools/galaxy-shapes.cjs）：');
    errsAll.forEach((e) => console.error(`  ✗ ${e}`));
    process.exit(1);
  }
  for (const w of GX.audit(halos)) warn(`形状审计：${w}`);
}

/* ── 知识点前置：解析 + 硬校验（悬空 / 自指 / 成环）────────────────────────
   前置是**知识点之间**的依赖（"学 Vue 之前先会 Spring Boot"），和"谁挂在恒星上"是两件事：
   Vue 仍然挂在恒星上（大分支），前置只是它额外的一条**航道** —— 渲染层画成弧线，不动枝干。
   一个知识点有几条前置，就有几条航道（用户要的"两个前置 = 两条上线"）。 */
const requiresOf = new Map();          // "haloId/pointId" → ["haloId/pointId", ...]
{
  const byKey = new Map();
  for (const h of halos) for (const p of h.points) byKey.set(`${h.id}/${p.id}`, { h, p });
  const errs = [];
  const pair = [];
  const resolve = (ref, haloId) => (String(ref).includes('/') ? String(ref) : `${haloId}/${ref}`);
  for (const h of halos) {
    for (const p of h.points) {
      const self = `${h.id}/${p.id}`;
      const list = [];
      for (const ref of p.requires || []) {
        const key = resolve(ref, h.id);
        if (!byKey.has(key)) { errs.push(`${self}: 前置「${ref}」找不到对应的知识点`); continue; }
        if (key === self) { errs.push(`${self}: 前置指向自己`); continue; }
        list.push(key);
        pair.push([key, self]);
      }
      if (list.length) requiresOf.set(self, list);
    }
  }
  // 成环检查：前置必须是 DAG（A 需要 B、B 又需要 A ⇒ 永远学不了）
  const adj = new Map();
  for (const [from, to] of pair) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const state = new Map();
  const dfs = (n, path) => {
    if (state.get(n) === 1) {
      const cut = path.slice(path.indexOf(n));
      errs.push(`前置成环：${cut.concat(n).join(' → ')}`);
      return;
    }
    if (state.get(n) === 2) return;
    state.set(n, 1);
    for (const m of adj.get(n) || []) dfs(m, path.concat(n));
    state.set(n, 2);
  };
  for (const n of adj.keys()) dfs(n, []);
  if (errs.length) {
    console.error('知识点前置有问题（point.json 的 requires）：');
    [...new Set(errs)].forEach((e) => console.error(`  ✗ ${e}`));
    process.exit(1);
  }
}

/* ── 课程（小星星）─────────────────────────────────────────────────────── */
const learned = exists(PROGRESS) ? new Set(readJSON(PROGRESS).learned || []) : new Set();
if (!exists(PROGRESS)) warn('没有 progress.json → 所有星都按"未点亮"处理');

const lessons = [];
const { displayNumberOf } = require(path.join(__dirname, 'lesson-map.js'));
/** "haloId/pointId" → 已建课的**显示号**数组（规划暗星的前沿判断要用它） */
const builtDisplay = new Map();
const legacy = [];
for (const rel of walkSrc()) {
  const meta = lessonMeta(rel);
  if (!meta || meta.number == null) continue;
  const parts = rel.split('/');
  // 真相顺序：路径优先；meta.halo / meta.point 可覆盖（测试桩与迁移期用）
  const haloId = meta.halo || (parts.length >= 3 ? parts[0] : LEGACY_HALO);
  const pointId = meta.point || (parts.length >= 3 ? parts[1] : LEGACY_POINT);
  if (!meta.halo && parts.length < 3) legacy.push(rel);
  const halo = halos.find((h) => h.id === haloId);
  if (!halo) { warn(`${rel}: meta.halo="${haloId}" 找不到对应圆圈，跳过`); continue; }
  const point = halo.points.find((p) => p.id === pointId);
  if (!point) { warn(`${rel}: 找不到知识点 ${haloId}/${pointId}，跳过`); continue; }

  // 构建产物与源**同构**（build-lessons 写 OUT_DIR/<源相对路径>）：分层布局后
  // rel = programming/vue/1001-*.html → 产物 lessons/programming/vue/1001-*.html。
  // 原来这里用 basename（注释还写着"当前仍平铺"）—— 分层后会找不到产物、href 也指向不存在的路径。
  const built = path.join(LESSONS, rel);
  if (!exists(built)) warn(`${rel}: 构建产物 lessons/${rel} 不存在 —— 先跑 node tools/build-lessons.js`);

  const id = `${pointId}/${String(meta.number).padStart(4, '0')}`;
  // 文件号（内部 ID）→ 显示号：按 point.json 的 fileBase 折算（轨道机制，规则在 lesson-map.js）
  const displayNumber = displayNumberOf(meta.number, point.fileBase);
  const dk = `${haloId}/${pointId}`;
  if (!builtDisplay.has(dk)) builtDisplay.set(dk, []);
  builtDisplay.get(dk).push(displayNumber);
  const label = point.label ? `${point.label} 第${displayNumber}课` : `第${displayNumber}课`;
  lessons.push({
    id, halo: haloId, point: pointId, pointName: point.name || pointId,
    number: meta.number, label, title: meta.title || '',
    navTitle: meta.navTitle || meta.title || '',
    href: `lessons/${rel}`, learned: learned.has(id),
    // 给悬浮面板用的：名词数、参考来源（都取自课程页 front-matter，不另立真相）
    termCount: Object.keys(meta.terms || {}).length,
    source: (meta.source && meta.source.label) || '',
    sourceUrl: (meta.source && meta.source.url) || '',
    // 人工异常标记（可选）：课页 front-matter 写 "flag": "red"|"yellow" → **优先覆盖**自动判定
    flag: (meta.flag === 'red' || meta.flag === 'yellow') ? meta.flag : null,
  });
}
lessons.sort((a, b) => a.point.localeCompare(b.point) || a.number - b.number);

/* ── 外观三段：#5 大小 / #6 亮度 / #7 异常 ──────────────────────────────
   全部由数据推（"名词数"就是我们的"行数"），公式与口径见
   `_plugin-prep/星图-对照-cosmos血缘规范.md` §七。三条都是逐课纯计算 → 测试查区间与单调性。 */
{
  const pointToHalo = new Map();
  for (const h of halos) for (const p of h.points) pointToHalo.set(p.id, h.id);

  // #7 自动红：这一课有几条**未解决**的答疑（append-only，按 lesson 聚合）
  const pendingBy = new Map();
  const PEND = path.join(ROOT, 'questions', 'pending.jsonl');
  if (fs.existsSync(PEND)) {
    for (const line of fs.readFileSync(PEND, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.lesson) pendingBy.set(r.lesson, (pendingBy.get(r.lesson) || 0) + 1);
      } catch (e) { /* 坏行忽略：答疑文件是追加写的，坏一行不该毁掉整张星图 */ }
    }
  }

  const wMax = Math.max(1, ...lessons.map((l) => l.termCount || 0));
  const lnW = Math.log(1 + wMax);
  const gm = new Map();                                     // 每个圆圈内的最大名词数
  for (const l of lessons) {
    const hid = pointToHalo.get(l.point) || l.halo;
    gm.set(hid, Math.max(gm.get(hid) || 0, l.termCount || 0));
  }
  const gMax = Math.max(1, ...gm.values());

  for (const l of lessons) {
    const w = l.termCount || 0;
    const ratio = lnW > 0 ? Math.log(1 + w) / lnW : 0;      // 对数压缩：防大课吞画面
    l.size = Number((0.62 + 0.50 * Math.pow(ratio, 1.1)).toFixed(4));

    const hid = pointToHalo.get(l.point) || l.halo;
    const g = gm.get(hid) || 0;
    const galScale = gMax > 0 ? 0.45 + 0.55 * (Math.log(1 + g) / Math.log(1 + gMax)) : 1;   // 圆圈间标定：防一家独大
    const relIn = g > 0 ? w / g : 0;
    l.bright = Number((galScale * (0.62 + 0.38 * relIn)).toFixed(4));

    l.pendingQ = pendingBy.get(l.id) || 0;
    l.flag = l.flag || (l.pendingQ ? 'red' : null);         // 人工优先覆盖自动
  }
}
if (legacy.length) warn(`历史平铺布局（归给 ${LEGACY_POINT}）：${legacy.join('、')} —— 目录重构后应消失`);

/* ── 连线 ─────────────────────────────────────────────────────────────── */
const byId = new Map(lessons.map((l) => [l.id, l]));
const edges = [];
for (const halo of halos) {
  for (const e of (halo.edges && halo.edges.list) || []) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) { warn(`连线 ${e.from} → ${e.to}（${e.kind}）端点还不存在，跳过`); continue; }
    edges.push({ from: e.from, to: e.to, kind: e.kind || '', note: e.note || '' });
  }
}

/* ── 序列化（确定性：固定键序、固定缩进、不含时间戳）───────────────────── */
// 「名词」那个数取**台账真源**（assets/glossary-data.js）—— 与 GLOSSARY.md、插件设置页同源。
// 原来渲染层是自己把各课 meta.terms 相加，于是同一个标签在星图显示 50、在设置页显示 71
// （2026-09-21 用户发现）。口径只能有一个：台账条数。
const GLOSSARY = require(path.join(__dirname, '..', 'assets', 'glossary-data.js'));

/** 全图规划暗星总数（只进生成日志，不进载荷 —— 载荷顶层键序不许漂） */
let plannedTotal = 0;
/**
 * 这个知识点该画哪几颗「规划中的暗星」= **地图前沿**（下一颗 + 紧随它的支线，至多两颗）。
 * 判据 `_board/01-鲸师.md:204-206`：上一课没学完 → 下一课的课页不生成 → 星图上只留这颗暗星。
 * 地图缺失 / 不合法 / 全建完 → **一颗都不画**，并在生成日志里点名说清（不许猜、不许编假星）。
 */
function plannedOf(h, p) {
  const at = `${h.id}/${p.id}`;
  const f = planFrontier(p.plan, builtDisplay.get(at) || []);
  if (!f.ok) {
    warn(`${at}: 地图缺失或不合法，规划暗星一颗都不画 —— ${f.problems.join('；')}`);
    return [];
  }
  if (f.exhausted) {
    note(`${at}: 地图 ${f.created} 课全建完了 —— 没有下一颗星，规划暗星 0 颗`);
    return [];
  }
  plannedTotal += f.stars.length;
  note(`${at}: 规划暗星 ${f.stars.map((n) => `第${n.no}课`).join(' + ')}（已建 ${f.created}／共 ${f.created + f.missing}）`);
  return f.stars.map((n) => ({
    no: n.no, title: n.title, deliverable: n.deliverable, criteria: n.criteria, branch: n.branch === true,
  }));
}

const payload = {
  termTotal: Object.keys(GLOSSARY).length,
  halos: halos.map((h) => {
    const shape = GX.pickShape(h);
    const def = GX.SHAPES[shape] || {};
    const circles = GX.circlesOf(h);
    // 恒星：单星就是本圆圈自己；双星是**两个知识圆圈**（引用各自的 halo id，名字从那边取）
    const coreList = def.coresFromCircle
      ? circles.map((cid) => {
        const o = halos.find((x) => x.id === cid);
        return { halo: cid, name: o ? o.name : cid, color: cid === h.id ? (o && o.hue) || null : null };
      })
      : [{ halo: h.id, name: h.name, color: null }];
    const coreIndexOf = (p) => {
      const i = coreList.findIndex((c) => c.halo === (p.circle || h.id));
      return i < 0 ? 0 : i;
    };
    return {
      id: h.id, name: h.name, center: h.center || '',
      // 圆圈身份色（halo.json 的 `color`）——**必须带出去**：data-layer 的 `hue` 优先读它。
      // 少了这一行，data-layer 那边的 `h.color` 永远是 undefined，回落按序号轮取 —— 而回落
      // 是"加一个圆圈就把已有圆圈的颜色挪一位"，静默漂色（2026-09-22 实测）。
      color: h.color || null,
      inside: h.inside || [], outside: h.outside || [],
      // 分组层（庚3 · 数据半）：圈 → 组 → 点 的中间层。**可选** —— 没声明时**不带这个键**，
      // 于是 content.js 与加这个功能之前**逐字节相同**（退化判据比的是产物，不是代码）。
      // 四条规则（可选 / id 存在 / 至多归一组 / 防丢）的**校验只在插件侧 `lib/pack-model.js`
      // 的 `normGroups`**（立项书 A-1 定的分工）；这里只做形状保护，不另做一份校验。
      // ⚠️ 挂在这里（不是顶层）→ window.STARMAP_REAL 的顶层键序不动（pack-scaffold.mjs:179 钉着）。
      ...(Array.isArray(h.groups) && h.groups.length ? { groups: h.groups } : {}),
      // 星系形状：渲染层据此决定长成一颗恒星还是两颗（交错）
      shape,
      orbit: def.orbit || 0,                       // 双星：核离质心多远
      lean: def.lean || 0,                         // 双星：枝条朝对面那颗倾多少（交错）
      branch: def.branch || 'branch',              // 枝条形态：branch 枝干 / cluster 花簇
      circles,                                     // 这个圆圈横跨了哪些知识圆圈
      cores: coreList,
      points: h.points.map((p) => ({
        id: p.id, name: p.name || p.id, label: p.label || '',
        circle: p.circle || h.id,
        core: coreIndexOf(p),
        // 前置（航道）：一个知识点几条前置，星图上就几条弧线
        requires: requiresOf.get(`${h.id}/${p.id}`) || [],
        // 规划暗星：**地图前沿**（至多两颗），不是 plan.nodes 全量 —— 其余规划节点与"没规划"
        // 一样不上图。挂在这里（不是顶层）→ window.STARMAP_REAL 的顶层键序不动。
        planned: plannedOf(h, p),
      })),
    };
  }),
  lessons, edges,
};
const body = JSON.stringify(payload, null, 2);
const content = `// 由 tools/build-starmap.js 生成 —— 不要手改。数据源：lessons/**/halo.json、point.json、课程页 meta、progress.json、assets/glossary-data.js */
window.STARMAP_REAL = ${body};\n`;

for (const n of notes) console.log(`· ${n}`);
for (const w of warns) console.log(`⚠️ ${w}`);
console.log(`[starmap] 圆圈 ${payload.halos.length} · 知识点 ${payload.halos.reduce((n, h) => n + h.points.length, 0)} · 课程 ${lessons.length}（已点亮 ${lessons.filter((l) => l.learned).length}）· 连线 ${edges.length} · 规划暗星 ${plannedTotal}`);

/** 静态版（M3）跟着一起重建 / 核对 —— 它读的正是 content.js，坐标来自 data-layer 的 layout() */
function buildStaticSvg() {
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'build-starmap-svg.js'), ...(checkOnly ? ['--check'] : [])],
    { cwd: ROOT, stdio: 'inherit' });
  // 子进程**没起来**（EPERM / ENOENT）时 r.status 是 null —— 别喊「未同步（见上）」：上方什么都没有
  if (r.error) {
    console.error(`[starmap] 起不了子进程：${r.error.code || r.error.message}（权限/沙箱边界）—— 这不是「命令没跑」也不是代码坏了。`
      + '出路：① 改 stdio:\'inherit\'（本处已是）② 结果写文件再读 ③ 在无沙箱环境跑。');
    process.exit(1);
  }
  if (r.status !== 0) { console.error('[starmap] 静态版未同步（见上）'); process.exit(1); }
}

if (checkOnly) {
  const cur = exists(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (cur === content) {
    console.log('[check] ✅ 星图数据与课程包一致');
    buildStaticSvg();
    process.exit(0);
  }
  console.error('[check] ❌ 星图数据有漂移：跑 node tools/build-starmap.js 重建');
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = `${OUT}.tmp-${process.pid}`;
fs.writeFileSync(tmp, content, 'utf8');
fs.renameSync(tmp, OUT);
console.log(`[starmap] 写出 ${path.relative(ROOT, OUT)}（${content.length} 字符）`);
buildStaticSvg();
