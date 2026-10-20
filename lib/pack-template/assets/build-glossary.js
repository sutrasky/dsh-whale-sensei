/**
 * build-glossary.js — 由名词数据源生成笔记文件（课程包侧）：**薄委托包装器**
 * ------------------------------------------------------------------
 * 运行： node assets/build-glossary.js
 * 输入： assets/glossary-data.js   （唯一数据源）
 * 输出： GLOSSARY.md               （带目录，方便查找）
 *
 * **权威实现只有一份**：`lib/unify/glossary.cjs`（U-SPEC §5 的单一源码；U19 会把它逐字节
 * 生成成课程包里的 `tools/unify/glossary.cjs`）。本文件**一行计算都没有** —— 合成、
 * 标题规范化、原子写、输出文案全部从内核取；所以"包侧与插件侧会不会漂"这件事从结构上
 * 消失了（以前靠 `test/glossary-verify.mjs` 拿 CLI 当 oracle 对拍发现）。
 *
 * 保留这一层壳的原因：包侧脚本是 CommonJS、且要能脱离插件独立跑；名字
 * `assets/build-glossary.js`（建圈链第 4 条、`rebuild` 脚本清单）不能改。
 *
 * **MIRROR-OF（历史）**：包侧曾是 `lib/glossary.js` 的第二份实现。U11 起两侧共用内核。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../tools/unify/glossary.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(__dirname, path.basename(core.GLOSSARY_LEDGER_REL));
const OUT = path.join(ROOT, core.GLOSSARY_OUT_REL);
const CONFIG = path.join(ROOT, core.LESSON_CONFIG_REL);

const loaded = core.loadLedger({ abs: SOURCE, fs: fs, requireFrom: require });
if (loaded.status !== 'ok' && loaded.status !== 'empty') throw core.ledgerLoadError(loaded);

core.atomicWrite({
  target: OUT,
  content: core.buildGlossaryMarkdown(loaded.ledger, {
    title: core.readGlossaryTitle({ configPath: CONFIG, fs: fs }),
  }),
  fs: fs,
});

core.emitGlossaryCli({ ledger: loaded.ledger, outRel: path.relative(ROOT, OUT), log: console.log });
