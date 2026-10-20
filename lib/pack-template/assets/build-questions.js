/**
 * build-questions.js — 由疑问数据源生成笔记：**薄委托包装器**
 * ------------------------------------------------------------------
 * 运行： node assets/build-questions.js
 * 输入： assets/questions-data.js   （唯一数据源）
 * 输出： QUESTIONS.md               （带目录，方便查找）
 *
 * **权威实现只有一份**：`lib/unify/content.cjs#projectQuestions`（U-SPEC §5；U19 生成随包副本
 * `tools/unify/content.cjs`，本文件还在 `..` 下所以路径是 `../tools/unify/`）。
 * 本文件不含任何计算：条目顺序、表格、锚点、名词链接与输出文案全部从内核取。
 *
 * 与 build-glossary.js 同构：只改数据源，再跑一次脚本。
 * （名词锚点 slug 也不再是本文件的第二份 —— 走 `./unify/glossary.cjs#slug`。）
 *
 * ⚠️ 本文件从模板铺出来的包里 require `../tools/unify/content.cjs` —— 那份副本由 **U19** 生成；
 *    之前（R1，U15 登记）新包跑它会 MODULE_NOT_FOUND。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../tools/unify/content.cjs');

const ROOT = path.resolve(__dirname, '..');

let built = null;
try {
  built = core.buildCourseContent({
    root: ROOT,
    fs,
    sections: ['questions'],
    loadData: (rel) => require(path.join(ROOT, rel)),
  });
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

const r = built.sections.questions;
if (r.fatal) {
  for (const line of r.fatal.err) console.error(line);
  process.exit(r.fatal.code);
}

const abs = path.join(ROOT, r.artifact.rel);
core.writeArtifact({ fs, target: abs, content: r.artifact.text, mode: r.artifact.mode });
for (const line of r.log) console.log(line);
