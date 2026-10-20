#!/usr/bin/env node
/**
 * pack-text.js — 读文本时的**本机已知坑位**（课程包侧）：纯委托包装器
 * ------------------------------------------------------------------
 * **权威实现只有一份**：`lib/unify/text.cjs`（U-SPEC §5 的单一源码；U19 会把它逐字节
 * 生成成课程包里的 `tools/unify/text.cjs`）。本文件**不含任何计算**，只把它 require 出来 ——
 * 所以"包侧与插件侧会不会漂"这件事从结构上消失了（以前靠 `test/mirror-parity.mjs` 对拍发现）。
 *
 * 为什么包侧也要有这一件：包侧工具是 CommonJS、且要能脱离插件独立跑，它们 require 的
 * 名字是 `tools/pack-text.js`（`ask-server.js` / `build-notes.js` / `build-lessons.js` 的
 * 传递依赖），件名不能改，所以保留这一层壳。
 *
 * 这条坑本身：PowerShell 用 `Set-Content` / `Add-Content -Encoding utf8` 写出来的文件
 * **开头会带 BOM**（`EF BB BF`），于是 `JSON.parse` 直接抛、而逐行解析时那一行会被
 * `catch` 成 null → **静默丢掉一条真数据**（比抛更坏 ✗）。用法与逐行剥的口径见权威内核。
 */
'use strict';

module.exports = require('./unify/text.cjs');
