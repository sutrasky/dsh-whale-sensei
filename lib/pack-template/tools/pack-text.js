#!/usr/bin/env node
/**
 * pack-text.js — 读文本时的**本机已知坑位**，收在一处（课程包侧）
 * ------------------------------------------------------------------
 * 与插件侧 `lib/text.js` 同名同义。为什么包侧也要有一份：包侧工具是 CommonJS、
 * 且要能脱离插件独立跑，所以那一份 require 不进来。
 *
 * 这条坑在本仓被踩过不止一次：PowerShell 用 `Set-Content` / `Add-Content -Encoding utf8`
 * 写出来的文件**开头会带 BOM**（`EF BB BF`），于是：
 *   · `JSON.parse` 直接抛（"Unexpected token \uFEFF"）
 *   · 逐行解析时那一行被 `catch` 成 null → **静默丢掉一条真数据**（比抛更坏 ✗）
 * 包侧原本只有 `tools/drain-questions.js:30-32` 与 `tools/ask-server.js:70,93` 各自就地剥，
 * 而 `build-notes.js` / `build-lessons.js` / `ask-server.js` 的**笔记读取**没剥 ——
 * 2026-09-24 实测：一行带 BOM 的笔记会被它们静默当成不存在（NOTES.html 与封面上都是 0 条）。
 *
 * 用法：`JSON.parse(stripBom(fs.readFileSync(f, 'utf8')))`
 * 逐行解析时**每行都要剥**：PowerShell 的追加会把 BOM 写进中间某一行。
 *
 * **MIRROR-OF: lib/text.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */
'use strict';

/** 剥掉字符串开头的 BOM（只剥开头；中间出现的 BOM 由逐行调用者各自剥） */
function stripBom(s) {
  return String(s === null || s === undefined ? '' : s).replace(/^\uFEFF/, '');
}

/** 逐行剥 BOM 并切行（空行由调用方决定要不要跳） */
function splitLines(text) {
  return stripBom(text).split('\n').map(stripBom);
}

/** JSON.parse，但先剥 BOM。抛错时点明"可能是 BOM / 编码问题" */
function parseJsonLoose(text, what) {
  try {
    return JSON.parse(stripBom(text));
  } catch (e) {
    throw new Error((what || 'JSON') + ' 不是合法 JSON —— ' + e.message + '（本机常见原因：文件带 BOM 或编码不是 UTF-8）');
  }
}

module.exports = { stripBom, splitLines, parseJsonLoose };
