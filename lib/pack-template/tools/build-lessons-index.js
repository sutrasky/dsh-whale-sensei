#!/usr/bin/env node
/**
 * 课程星清单生成器 —— `lessons/lessons.json`
 *
 * **为什么要有它**：离线包**不带 `lessons/src/`**，而课程元数据（`data-lesson-meta`）只写在
 * 源文件里 —— `build-lessons.js` 只在 `--extract` 分支把它写进产物页（`:703` 的 `serializeSource`
 * 由 `:790` 调用），**产物页里没有 meta**。于是离线端（无 src）重建星图时 `build-starmap.js`
 * 拿不到课程星数据，会静默退化成「课程 0、连线 0」。这份清单把 src 里的 meta 摘出来随包走，
 * 补上那个缺口（离线端 `build-starmap.js` 无 src 时改读它）。
 *
 * **清单条目 = `{ ...meta, rel, slug, halo, point }`** —— 与 src 里的 meta **同形** ⇒
 * `build-starmap.js` 可以直接把它当 meta 用，字段消费零分叉（`terms`/`source`/`flag` 原样带过去）。
 *
 * 用法（**在课程包根跑**）：
 *   node tools/build-lessons-index.js             # 生成/更新 lessons/lessons.json
 *   node tools/build-lessons-index.js --check     # 只对拍：磁盘上的清单与现算的是否逐字节一致（不写盘）
 *   node tools/build-lessons-index.js --print     # 把清单 JSON 打到 stdout（**不写盘**）
 *                                                 # —— 插件侧「导出这一节课」用它取条目，保证与包内同源
 *
 * 退出码：0 一致 / 1 不一致（`--check`）或出错；没有 `lessons/src` 时**报错退出**
 * （这个脚本只能在有源文件的机器上跑 —— 导出侧工具，离线端不跑它）。
 *
 * **MIRROR-OF: lib/pack-template/tools/build-lessons-index.js**（同源实现，逐字节同一份；
 * 改这里就必须同步改那一份，否则 `test/pack-scaffold.mjs` 的 FROM_PACK 逐文件核对会红）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LESSONS = path.join(ROOT, 'lessons');
const SRC = path.join(LESSONS, 'src');
const OUT = path.join(LESSONS, 'lessons.json');

const META_RE = /<script[^>]*data-lesson-meta[^>]*>([\s\S]*?)<\/script>/;
const SLUG_RE = /^(\d{4})-(.+)\.html$/;

const checkOnly = process.argv.includes('--check');
const warns = [];
const warn = (m) => warns.push(m);
const exists = (p) => fs.existsSync(p);

/** 递归收集 `lessons/src` 下的所有 .html（相对 SRC 的 posix 路径）—— 与 build-starmap.js:63-72 同口径 */
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

function build() {
  const lessons = [];
  for (const rel of walkSrc()) {
    const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const m = text.match(META_RE);
    if (!m) { warn(`${rel}: 没有 data-lesson-meta，跳过`); continue; }
    let meta;
    try { meta = JSON.parse(m[1]); } catch (e) { warn(`${rel}: meta 不是合法 JSON —— ${e.message}`); continue; }
    if (meta.number == null) { warn(`${rel}: meta 里没有 number，跳过`); continue; }

    const parts = rel.split('/');
    const base = parts[parts.length - 1];
    const slugMatch = SLUG_RE.exec(base);
    lessons.push({
      ...meta,
      rel,
      slug: slugMatch ? slugMatch[2] : base.replace(/\.html$/, ''),
      // 路径优先、meta 可覆盖 —— 与 build-starmap.js:186-187 同一口径
      // （反例：lessons/src/math/alge/0001-algebra-basics.html 的 meta 里没有 halo/point）
      halo: meta.halo || (parts.length >= 3 ? parts[0] : null),
      point: meta.point || (parts.length >= 3 ? parts[1] : null),
    });
  }
  lessons.sort((a, b) => a.rel.localeCompare(b.rel));
  return { v: 1, source: 'lessons/src', lessons };
}

/* ── 跑 ─────────────────────────────────────────────────────────────────── */
if (!exists(SRC)) {
  console.error('没有 lessons/src —— 课程星清单只能在**有源文件**的机器上生成（导出侧工具，离线端不跑它）');
  process.exit(1);
}

const index = build();

// --print：把清单 JSON 打到 stdout（**不写盘**）—— 插件侧「导出这一节课」用它取条目，
// 保证清单条目与包内 `build-starmap.js` 的清单模式**同源**（不在插件里抄第二份解析）。
// ⚠️ 这个分支**只许往 stdout 写 JSON**（其它信息一律 stderr），否则调用方解析不了。
if (process.argv.includes('--print')) {
  process.stdout.write(JSON.stringify(index) + '\n');
  for (const w of warns) console.warn(`  ⚠ ${w}`);
  process.exit(0);
}

const next = JSON.stringify(index, null, 2) + '\n';
const cur = exists(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
const same = cur === next;
const summary = `${index.lessons.length} 课 / ${new Set(index.lessons.map((l) => l.halo).filter(Boolean)).size} 个圆圈`;

if (checkOnly) {
  if (same) {
    console.log(`清单一致：lessons/lessons.json（${summary}）`);
  } else {
    console.error(`清单与现算不一致：lessons/lessons.json ${cur === null ? '不存在' : '内容不同'}`);
    console.error('  修法：node tools/build-lessons-index.js');
    process.exit(1);
  }
} else if (same) {
  console.log(`清单没变：lessons/lessons.json（${summary}）`);
} else {
  fs.writeFileSync(OUT, next);
  console.log(`写出 lessons/lessons.json：${summary}`);
}

for (const w of warns) console.warn(`  ⚠ ${w}`);
