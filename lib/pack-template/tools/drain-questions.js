#!/usr/bin/env node
/**
 * drain-questions.js — 把处理完的疑问从待办队列移到归档
 *
 * 为什么需要它：tools/ask-server.js 把每条提交**追加**到 questions/pending.jsonl，
 * 从不覆盖（这是对的 —— 不能弄丢学生的提问）。但答题之后如果不清队列，
 * `GET /health` 的 pending 数会只增不减，老师每轮都会看到同一批老问题。
 *
 * 只归档**确实已经答完的**疑问，其余原样留在队列里 ——
 * 没答完就是还没处理完，绝不能因为清队列把它丢掉。
 * 「确实已答」的判据在 `tools/unify/records.cjs`：台账里有这条 **且** `status === 'answered'`
 * （登记过但状态不是 answered 的记录仍然留在队列里）。
 *
 *   node tools/drain-questions.js
 *
 * ⚠️ **同一个写集（T11 / 报告 C01）**：`pending.jsonl` 与 `processed.jsonl` 是**同一个写集** ——
 *    "把归档行写进 processed" 与 "把已归档行从 pending 去掉" 一起提交、一起回滚。
 *    旧实现是 `appendFileSync(processed)` 之后再 `writeFileSync(pending)`：第二步失败 / 进程被杀，
 *    归档行已经在 processed 里、pending 却还是**旧的整份**（重复归档）；更糟的是两个进程
 *    同时跑时，drain 用**读到的旧快照**重写 pending，会把并发新写入的提问整段抹掉（C01）。
 *
 * ## U14 起：归档计算与提交**只有一个出处**
 *
 * 本文件不再自己拿锁、自己算"哪些行该搬"、自己回滚 —— 那些全部委托
 * `tools/unify/records.cjs` 的 `archiveAnswered()`：
 *   · 它走 U06 的 `planCommit`/`applyCommit`（三闸 + 真实字节摘要），底下是**同一份**
 *     `tools/ledger-transaction.cjs`（本文件显式注入，不另造事务系统）；
 *   · 队列里没有可归档的行时**零写**；空队列不进事务；
 *   · 已答台账缺失/坏掉 → **拒**（判不了"哪些已答"就不许归档），队列一个字节都不动。
 * 本文件保留的是 CLI 输出与导出接口（`drainPending` / `PENDING_REL` / `PROCESSED_REL`）。
 *
 * ⚠️ **已知中间态 R1（登记，不在这里绕开）**：`tools/unify/*.cjs` 的随包副本只由 U19 生成；
 *    本仓库的模板树里还没有那份副本，所以在仓内**直接**跑本文件会 MODULE_NOT_FOUND。
 *    这是已登记的 R1，解除点唯一是 U19 —— 不为了躲它在这里保留第二份计算。
 *
 * 零依赖（除了随包发的 `tools/ledger-transaction.cjs` 与 `tools/unify/records.cjs`）。
 */

'use strict';

const path = require('path');
const ledgerTxn = require('./ledger-transaction.cjs');
const RECORDS = require('./unify/records.cjs');

const ROOT = path.join(__dirname, '..');
const PROCESSED_REL = 'questions/processed.jsonl';
const PENDING_REL = 'questions/pending.jsonl';
const PROCESSED = path.join(ROOT, PROCESSED_REL);
/** 拿不到锁时的重试窗口（归档进程和新提问进程并行时，忙一会儿该等，不该把归档直接失败） */
const LOCK_RETRY_MS = 5000;

/** 同步小睡（CLI 是同步流程；`Atomics.wait` 才是真让出 CPU） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}

/**
 * 归档一次（**pending 与 processed 同一写集**）。
 *
 * 提交与归档判定全在 `tools/unify/records.cjs` 的 `archiveAnswered()`；本函数只负责
 * **等锁**（锁忙 / 计划过期时在 LOCK_RETRY_MS 窗口内重试 —— 等待策略需要时钟，
 * 所以它留在这层，内核保持无时钟、可复算）。
 *
 * @param {string} [root] 课程包根（缺省 = 本文件所在包）
 * @param {{ownerToken?:string, retryMs?:number}} [opts]
 * @returns {{drained:number, kept:number, state:string, ok:boolean, error:string|null,
 *            empty:boolean, keptLines:string[], registered:string[]}}
 */
function drainPending(root, opts = {}) {
  const abs = path.resolve(String(root == null ? '' : root).trim() || ROOT);
  const deadline = Date.now() + (Number.isSafeInteger(opts.retryMs) ? opts.retryMs : LOCK_RETRY_MS);
  const ownerToken = opts.ownerToken === undefined ? `drain-questions:${process.pid}` : String(opts.ownerToken);
  let res;
  for (;;) {
    res = RECORDS.archiveAnswered(abs, {
      // 包侧注入**自己的**那份事务件（同一份实现，不是第二套事务系统）
      transaction: ledgerTxn,
      ownerToken,
    });
    if (res.ok === true || !res.retryable || Date.now() >= deadline) break;
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
  return {
    drained: res.drained || 0,
    kept: res.kept || 0,
    state: res.state,
    ok: res.ok === true,
    error: res.error || null,
    empty: res.empty === true,
    keptLines: Array.isArray(res.keptLines) ? res.keptLines : [],
    registered: Array.isArray(res.registered) ? res.registered : [],
  };
}

/** 旧 CLI 的输出（一行都没改：ask-answer / 技能包都照旧 grep 这些句子） */
function runCli() {
  const r = drainPending(ROOT);
  if (r.state !== 'committed') {
    console.error('[drain] 归档失败（事务状态：' + r.state + '）：' + (r.error || '（没有更多信息）'));
    console.error('[drain] 台账没有被改动；先跑 node tools/recover-ledgers.mjs <包根> --check 看看有没有残骸');
    process.exit(1);
  }
  if (r.empty) {
    console.log('[drain] 待办队列是空的，无需处理');
    return;
  }
  console.log(`[drain] 归档 ${r.drained} 条 → ${path.relative(ROOT, PROCESSED)}`);
  if (r.kept) {
    console.log(`[drain] ⚠️ 保留 ${r.kept} 条在待办队列 —— 它们还没登记进 questions-data.js 或还没答完`);
    console.log(`[drain]    台账里已登记的编号: ${r.registered.join(', ') || '(空)'}`);
    for (const line of r.keptLines) {
      let id = '(解析失败)';
      try {
        id = JSON.stringify(JSON.parse(line).id);
      } catch (e) { /* 保持原样 */ }
      console.log(`[drain]    队列里这条的 id: ${id}   ← ${line.slice(0, 60)}…`);
    }
    console.log('[drain]    先解答并登记，再重新跑本脚本');
  }
}

if (require.main === module) runCli();

module.exports = { drainPending, PENDING_REL, PROCESSED_REL };
