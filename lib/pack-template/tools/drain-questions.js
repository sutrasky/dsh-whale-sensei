#!/usr/bin/env node
/**
 * drain-questions.js — 把处理完的疑问从待办队列移到归档
 *
 * 为什么需要它：tools/ask-server.js 把每条提交**追加**到 questions/pending.jsonl，
 * 从不覆盖（这是对的 —— 不能弄丢学生的提问）。但答题之后如果不清队列，
 * `GET /health` 的 pending 数会只增不减，老师每轮都会看到同一批老问题。
 *
 * 只归档**已经登记进 questions-data.js 的**疑问，其余原样留在队列里 ——
 * 没登记就是还没处理完，绝不能因为清队列把它丢掉。
 *
 *   node tools/drain-questions.js
 *
 * 零依赖。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'questions');
const PENDING = path.join(DIR, 'pending.jsonl');
const PROCESSED = path.join(DIR, 'processed.jsonl');

const lines = fs.existsSync(PENDING)
  ? fs
      .readFileSync(PENDING, 'utf8')
      .replace(/^\uFEFF/, '')          // PowerShell 建的文件会带 BOM，不剥掉第一条 JSON 永远解析失败
      .split('\n')
      .map((l) => l.replace(/^\uFEFF/, ''))
      .filter((l) => l.trim())
  : [];

if (!lines.length) {
  console.log('[drain] 待办队列是空的，无需处理');
  process.exit(0);
}

const ledger = require(path.join(ROOT, 'assets', 'questions-data.js'));
const registered = new Set(Object.values(ledger).map((q) => String(q.id)));

const drained = [];
const kept = [];
for (const line of lines) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    kept.push(line);                       // 解析不了的一律留下，人工看
    continue;
  }
  if (registered.has(String(rec.id))) drained.push(line);
  else kept.push(line);
}

if (drained.length) fs.appendFileSync(PROCESSED, drained.join('\n') + '\n', 'utf8');
fs.writeFileSync(PENDING, kept.length ? kept.join('\n') + '\n' : '', 'utf8');

console.log(`[drain] 归档 ${drained.length} 条 → ${path.relative(ROOT, PROCESSED)}`);
if (kept.length) {
  console.log(`[drain] ⚠️ 保留 ${kept.length} 条在待办队列 —— 它们还没登记进 questions-data.js`);
  console.log(`[drain]    台账里已登记的编号: ${[...registered].join(', ') || '(空)'}`);
  for (const line of kept) {
    let id = '(解析失败)';
    try {
      id = JSON.stringify(JSON.parse(line).id);
    } catch (e) { /* 保持原样 */ }
    console.log(`[drain]    队列里这条的 id: ${id}   ← ${line.slice(0, 60)}…`);
  }
  console.log('[drain]    先解答并登记，再重新跑本脚本');
}
