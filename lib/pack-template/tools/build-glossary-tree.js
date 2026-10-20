#!/usr/bin/env node
/**
 * build-glossary-tree.js — 生成 `assets/glossary-tree.js`（名词地图用的层级树）：**薄委托包装器**
 * ==================================================================
 * 为什么要有这个生成物（而不是让地图页直接引 `starmap/content.js`）：
 *   `tools/build-public.js` 把星图**铺平到站点根**（产物里 `starmap/` 不复存在），
 *   所以地图页里写 `../starmap/content.js` 是**本地能跑、线上 404** —— 那种错只有上线才现形。
 *   住在 `assets/` 下的东西两个环境路径一致，所以这份树单独生成一份。
 *
 * 生成口径（**不复制、不重算**，只做一次 join）：
 *   · 圆圈        ← `lessons/<圆圈>/halo.json`（id / name / color / center）
 *   · 知识点      ← `lessons/<圆圈>/<知识点>/point.json`（point / name / label / requires）
 *   · 课程        ← 课次映射表（`./unify/pack.cjs#lessonIndex`，包侧 `tools/lesson-map.js` 就是它）
 *   · 名词        ← `assets/glossary-data.js` 的 `lesson` 字段（**显示名**）→ 身份 → 课次
 *
 * **权威实现只有一份**：`lib/unify/content.cjs#projectGlossaryTree`（U-SPEC §5；U19 生成随包副本）。
 * 本文件只剩 CLI / IO / 退出码。
 *
 * 关键纪律：名词的 `lesson` 是显示名，拼错一个词它就会**凭空消失**在树上 ——
 * 所以拼不上（含显示名撞车）的名词收进顶层 `unassigned`，闸门断言它必须是空的；
 * 课程归属一律按**圆圈 + 知识点**两条一起对（跨圈同名知识点不会互相串课）。
 *
 * 用法：
 *   node tools/build-glossary-tree.js           写产物（原子写）
 *   node tools/build-glossary-tree.js --check   只比对（漂移 → 非零退出）
 *
 * ⚠️ 本文件从模板铺出来的包里 require `./unify/content.cjs` —— 那份副本由 **U19** 生成；
 *    之前（R1，U15 登记）新包跑它会 MODULE_NOT_FOUND。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./unify/content.cjs');

const ROOT = path.join(__dirname, '..');

let built = null;
try {
  built = core.buildCourseContent({
    root: ROOT,
    fs,
    sections: ['glossaryTree'],
    loadData: (rel) => require(path.join(ROOT, rel)),
  });
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

const r = built.sections.glossaryTree;
if (r.fatal) {
  for (const line of r.fatal.err) console.error(line);
  process.exit(r.fatal.code);
}
if (r.skip) {
  for (const line of r.skip.log) console.log(line);
  process.exit(r.skip.code);
}

const abs = path.join(ROOT, r.artifact.rel);
const text = r.artifact.text;
const rel = path.relative(ROOT, abs);
const say = (list) => {
  for (const m of list) {
    const line = m.line.replace(/%REL%/g, rel).replace(/%CHARS%/g, String(text.length));
    (m.stream === 'err' ? console.error : console.log)(line);
  }
};

if (process.argv.includes('--check')) {
  if (!fs.existsSync(abs)) {
    say(r.messages.checkMissing);
    process.exit(1);
  }
  if (fs.readFileSync(abs, 'utf8') === text) say(r.messages.checkSame);
  else {
    say(r.messages.checkDiff);
    process.exit(1);
  }
} else {
  core.writeArtifact({ fs, target: abs, content: text, mode: r.artifact.mode });
  say(r.messages.write);
}
