#!/usr/bin/env node
/**
 * build-glossary-tree.js — 生成 `assets/glossary-tree.js`（名词地图用的层级树）
 * ==================================================================
 * 为什么要有这个生成物（而不是让地图页直接引 `starmap/content.js`）：
 *   `tools/build-public.js` 把星图**铺平到站点根**（产物里 `starmap/` 不复存在），
 *   所以地图页里写 `../starmap/content.js` 是**本地能跑、线上 404** —— 那种错只有上线才现形。
 *   住在 `assets/` 下的东西两个环境路径一致，所以这份树单独生成一份。
 *
 * 生成口径（**不复制、不重算**，只做一次 join）：
 *   · 圆圈        ← `lessons/<圆圈>/halo.json`（id / name / color / center）
 *   · 知识点      ← `lessons/<圆圈>/<知识点>/point.json`（point / name / label / requires）
 *   · 课程        ← `tools/lesson-map.js` 的 `lessonMap(root)`（包侧课次显示名的**唯一真源**，
 *                   与插件 `lib/pack-model.js` 有机械对拍钉住；别在这里就地拼 `第N课`）
 *   · 名词        ← `assets/glossary-data.js` 的 `lesson` 字段（**显示名**）反查课次
 *
 * 关键纪律：名词的 `lesson` 是显示名，拼错一个词它就会**凭空消失**在树上。
 * 所以本文件把拼不上的名词收进顶层 `unassigned`，闸门断言它必须是空的。
 *
 * 用法：
 *   node tools/build-glossary-tree.js           写产物（原子写）
 *   node tools/build-glossary-tree.js --check   只比对（漂移 → 非零退出）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LESSONS_DIR = path.join(ROOT, 'lessons');
const OUT_PATH = path.join(ROOT, 'assets', 'glossary-tree.js');
const { lessonMap } = require(path.join(__dirname, 'lesson-map.js'));

/* ── 技能包守卫：没有课程数据时**响亮跳过**（与 build-notes / build-starmap 同一约定） ── */
function anyHalo() {
  try {
    return fs.readdirSync(LESSONS_DIR, { withFileTypes: true })
      .some((e) => e.isDirectory() && e.name !== 'src' && fs.existsSync(path.join(LESSONS_DIR, e.name, 'halo.json')));
  } catch { return false; }
}
if (!anyHalo() || !fs.existsSync(path.join(ROOT, 'assets', 'glossary-data.js'))) {
  console.log('=== 跳过：本目录没有 lessons/<圆圈>/halo.json 或 assets/glossary-data.js ===');
  console.log('⚠️ 这是「跳过」，不是「通过」。在有课程数据的工作区里跑才有意义。');
  process.exit(0);
}

function writeAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

/* ── 整理 ────────────────────────────────────────────────────────────── */

const GLOSSARY = require(path.join(ROOT, 'assets', 'glossary-data.js'));
const MAP = lessonMap(ROOT);

/** 名词 key → 它声明的课次显示名 */
const termLesson = {};
for (const [key, g] of Object.entries(GLOSSARY)) {
  termLesson[key] = String(g.lesson || '').trim();
}

/** 显示名 → 该课的名词 key 列表（保持台账原顺序 → 产物确定） */
const termsByLabel = {};
for (const [key, label] of Object.entries(termLesson)) {
  if (!label) continue;
  (termsByLabel[label] = termsByLabel[label] || []).push(key);
}

const unassigned = [];
const assigned = new Set();

const halos = fs.readdirSync(LESSONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'src')
  .map((e) => e.name)
  .filter((id) => fs.existsSync(path.join(LESSONS_DIR, id, 'halo.json')))
  .sort()
  .map((haloId) => {
    const halo = readJson(path.join(LESSONS_DIR, haloId, 'halo.json'));
    const pointIds = fs.readdirSync(path.join(LESSONS_DIR, haloId), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(LESSONS_DIR, haloId, e.name, 'point.json')))
      .map((e) => e.name)
      .sort();

    const points = pointIds.map((pid) => {
      const pj = readJson(path.join(LESSONS_DIR, haloId, pid, 'point.json'));
      // 这一课次的知识点：lessonMap 是权威（它同时认 lessons/ 与 lessons/src/ 的分层布局）
      const lessons = Object.values(MAP.byKey)
        .filter((l) => l.point === pid)
        .sort((a, b) => a.displayNumber - b.displayNumber)
        .map((l) => {
          const keys = termsByLabel[l.label] || [];
          keys.forEach((k) => assigned.add(k));
          // EXPECT.json 的 title 自带课次前缀（「第1课 Hello Spring Boot」/「Vue 第1课 把接口数据渲染成页面」），
          // 而地图上那个六边形**自己就写着课次**，不剥掉前缀就是同一句话说两遍。
          let title = String(l.title || '').trim();
          if (title.startsWith(l.label)) title = title.slice(l.label.length).trim();
          return {
            key: l.key,
            label: l.label,
            title,
            number: l.displayNumber,
            page: l.page || '',                 // 包根相对路径（地图页自己加 ../ 前缀）
            terms: keys,
          };
        });
      return {
        id: pid,
        name: pj.name || pid,
        label: pj.label || '',
        requires: Array.isArray(pj.requires) ? pj.requires.slice() : [],
        lessons,
      };
    });

    return {
      id: haloId,
      name: halo.name || haloId,
      color: halo.color || '',
      center: halo.center || '',
      // 课程之间的连线（第2课的前置是第1课）—— **与星图同源**：都读 halo.json 的 edges.list。
      // 用户 2026-09-22 裁定：地图的连线逻辑按星图来（子连父 + 课程串课程），不是"全都连中心"。
      edges: ((halo.edges && halo.edges.list) || []).map((e) => ({
        from: e.from, to: e.to, kind: e.kind || '', note: e.note || '',
      })),
      points,
    };
  });

// 拼不上课次的名词：绝不静默（它们在图上会凭空消失）
for (const key of Object.keys(GLOSSARY)) {
  if (!assigned.has(key)) unassigned.push(key);
}

const termTotal = Object.keys(GLOSSARY).length;
const tree = {
  generated: 'tools/build-glossary-tree.js — 不要手改',
  termTotal,
  halos,
  unassigned,
};

const html = `// ${tree.generated}
// 数据源：lessons/<圆圈>/halo.json · lessons/<圆圈>/<知识点>/point.json · tools/lesson-map.js · assets/glossary-data.js
// 名词地图（glossary/index.html）读这一份；**别在页面里硬编码层级**。
(function (root) {
  'use strict';
  var TREE = ${JSON.stringify(tree, null, 2)};
  if (typeof module === 'object' && module.exports) module.exports = TREE;
  else root.GLOSSARY_TREE = TREE;
})(typeof self !== 'undefined' ? self : this);
`;

/* ── main ────────────────────────────────────────────────────────────── */

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT_PATH)) {
    console.error(`[check] ❌ ${path.relative(ROOT, OUT_PATH)} 不存在（忘了构建）`);
    process.exit(1);
  }
  if (fs.readFileSync(OUT_PATH, 'utf8') === html) {
    console.log(`[check] ✅ ${path.relative(ROOT, OUT_PATH)} 无漂移`);
  } else {
    console.error(`[check] ❌ ${path.relative(ROOT, OUT_PATH)} 磁盘与构建结果不一致（改了 halo/point/课次/名词台账？）`);
    process.exit(1);
  }
} else {
  writeAtomic(OUT_PATH, html);
  const counts = halos.map((h) => `${h.name}(${h.points.length} 知识点/${h.points.reduce((n, p) => n + p.lessons.length, 0)} 课)`).join(' · ');
  console.log(`[tree] ${path.relative(ROOT, OUT_PATH)}  ${html.length} 字符`);
  console.log(`[tree] 圆圈 ${halos.length} · ${counts} · 名词 ${termTotal}${unassigned.length ? ` · ⚠️ 拼不上课次 ${unassigned.length}：${unassigned.join(', ')}` : ''}`);
}
