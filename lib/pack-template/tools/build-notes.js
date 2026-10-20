#!/usr/bin/env node
/**
 * build-notes.js — 生成 reference/NOTES.html（笔记文档页）：**薄委托包装器**
 *
 * 纯函数、确定性、支持 --check（磁盘 vs 渲染，漂移非零退出）。
 *
 * 输入：assets/questions-data.js、notes/notes.jsonl
 * 输出：reference/NOTES.html（原子写入）
 *
 * **权威实现只有一份**：`lib/unify/content.cjs#projectNotes`（U-SPEC §5；U19 生成随包副本）。
 * 本文件只剩 CLI / IO / 退出码 / 「跳过 ≠ 通过」的措辞取自内核。
 *
 * **名词解释不在本页**（裁定：疑问与名词解释分开）—— 名词住在 `glossary/index.html`（名词地图）。
 *
 * 排序确定性：课按 track/number、答疑按 id、笔记按 id。
 * 课次锚点走 `./unify/pack.cjs#labelAnchorId`（与课程页小封面卡同一条公式）；
 * 台账 `anchor` 是**身份键**，显示名由身份派生（`第1课` / `Vue 第1课`），不就地拼。
 *
 * ⚠️ 本文件从模板铺出来的包里 require `./unify/content.cjs` —— 那份副本由 **U19** 生成；
 *    之前（R1，U15 登记）新包跑它会 MODULE_NOT_FOUND。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./unify/content.cjs');
const { withStaticTitles } = require(path.join(__dirname, 'title-classes.js'));   // §3：h2/h3 静态流彩类

const ROOT = path.join(__dirname, '..');
const checkOnly = process.argv.slice(2).includes('--check');

let built = null;
try {
  built = core.buildCourseContent({
    root: ROOT,
    fs,
    sections: ['notes'],
    loadData: (rel) => require(path.join(ROOT, rel)),
    deps: { withStaticTitles },
  });
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

const r = built.sections.notes;
if (r.fatal) {
  for (const line of r.fatal.err) console.error(line);
  process.exit(r.fatal.code);
}
if (r.skip) {
  for (const line of r.skip.log) console.log(line);
  process.exit(r.skip.code);
}
for (const w of r.warn || []) console.warn(`  ⚠ ${w}`);

const abs = path.join(ROOT, r.artifact.rel);
const text = r.artifact.text;
const rel = path.relative(ROOT, abs);
const say = (list) => {
  for (const m of list) {
    const line = m.line.replace(/%REL%/g, rel).replace(/%CHARS%/g, String(text.length));
    (m.stream === 'err' ? console.error : console.log)(line);
  }
};

if (checkOnly) {
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
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  core.writeArtifact({ fs, target: abs, content: text, mode: r.artifact.mode });
  say(r.messages.write);
}
