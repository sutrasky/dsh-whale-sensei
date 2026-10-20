#!/usr/bin/env node
/**
 * 课程星清单生成器 —— `lessons/lessons.json`：**薄委托包装器**
 *
 * **为什么要有它**：离线包**不带 `lessons/src/`**，而课程元数据（`data-lesson-meta`）只写在
 * 源文件里 —— `build-lessons.js` 只在 `--extract` 分支把它写进产物页，**产物页里没有 meta**。
 * 于是离线端（无 src）重建星图时 `build-starmap.js` 拿不到课程星数据，会静默退化成
 * 「课程 0、连线 0」。这份清单把 src 里的 meta 摘出来随包走，补上那个缺口
 * （离线端 `build-starmap.js` 无 src 时改读它）。
 *
 * **权威实现只有一份**：`lib/unify/content.cjs#projectLessonsIndex`（U-SPEC §5 的单一源码；
 * U19 会把它逐字节生成成课程包里的 `tools/unify/content.cjs`）。本文件**不含计算** ——
 * 条目形状（`{...meta, rel, slug, halo, point}`）、排序、告警文案、产物正文全从内核取。
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
 * ⚠️ 本文件从模板铺出来的包里 require `./unify/content.cjs` —— 那份副本由 **U19** 生成；
 *    之前（R1，U15 登记）新包跑它会 MODULE_NOT_FOUND。这不是本文件的第二个实现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./unify/content.cjs');

const ROOT = path.join(__dirname, '..');
const checkOnly = process.argv.includes('--check');
const printOnly = process.argv.includes('--print');

/** 内核文案里的占位符（路径与长度都是调用方才知道的事实） */
function fill(messages, ctx) {
  return messages.map((m) => ({
    stream: m.stream,
    line: m.line.replace(/%REL%/g, ctx.rel).replace(/%CHARS%/g, String(ctx.chars)).replace(/%CUR%/g, ctx.cur || ''),
  }));
}

let built = null;
try {
  built = core.buildCourseContent({
    root: ROOT,
    fs,
    sections: ['lessonsIndex'],
    loadData: (rel) => require(path.join(ROOT, rel)),
  });
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

const r = built.sections.lessonsIndex;
if (r.fatal) {
  for (const line of r.fatal.err) console.error(line);
  process.exit(r.fatal.code);
}

const abs = path.join(ROOT, r.artifact.rel);
const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
const text = r.artifact.text;
const warnings = r.warn || [];

// --print：把清单 JSON 打到 stdout（**不写盘**）—— 插件侧「导出这一节课」用它取条目，
// 保证清单条目与包内 `build-starmap.js` 的清单模式**同源**（不在插件里抄第二份解析）。
// ⚠️ 这个分支**只许往 stdout 写 JSON**（其它信息一律 stderr），否则调用方解析不了。
if (printOnly) {
  process.stdout.write(JSON.stringify(r.data.index) + '\n');
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  process.exit(0);
}

const say = (list) => {
  for (const m of list) (m.stream === 'err' ? console.error : console.log)(m.line);
};
const ctx = { rel: 'lessons/lessons.json', chars: text.length, cur: cur === null ? '不存在' : '内容不同' };

if (checkOnly) {
  if (cur === text) say(fill(r.messages.checkSame, ctx));
  else {
    say(fill(r.messages.checkDiff, ctx));
    process.exit(1);
  }
} else if (cur === text) {
  say(fill(r.messages.unchanged, ctx));
} else {
  core.writeArtifact({ fs, target: abs, content: text, mode: r.artifact.mode });
  say(fill(r.messages.write, ctx));
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);
