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
 * ⚠️ **同一个事务（T11 / 报告 C01）**：`pending.jsonl` 与 `processed.jsonl` 是**同一个写集** ——
 *    "把归档行写进 processed" 与 "把已归档行从 pending 去掉" 一起提交、一起回滚。
 *    旧实现是 `appendFileSync(processed)` 之后再 `writeFileSync(pending)`：第二步失败 / 进程被杀，
 *    归档行已经在 processed 里、pending 却还是**旧的整份**（重复归档）；更糟的是两个进程
 *    同时跑时，drain 用**读到的旧快照**重写 pending，会把并发新写入的提问整段抹掉（C01）。
 *    现在两者走 `tools/ledger-transaction.cjs` 的 `withPackTransaction()`：
 *      · 读 pending 在**锁内**发生，重写出去的就是"锁内那份 + 本次归档结果"；
 *      · 中途失败 / 中断 → 回滚到写前，或（提交点后）完整已提交，没有第三种终态。
 *    **不另起锁协议**、**不 truncate 别人的写入**（未答问题保留策略一字未改）。
 *
 * 导出 `drainPending(root) -> {drained, kept, state}`（T11 卡面接口）：
 *   `drained` / `kept` 是条数，`state` 是事务终态（`committed` / `busy` / `rolled-back` / …）。
 * 直接运行（`node tools/drain-questions.js`）时行为与旧 CLI 相同。
 *
 * 零依赖（除了随包发的 `tools/ledger-transaction.cjs`）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ledgerTxn = require('./ledger-transaction.cjs');

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
 * 读队列行：**逐行剥 BOM**（PowerShell 建的文件会带 BOM，不剥掉第一条 JSON 永远解析失败）。
 * 与旧实现**逐字同口径**：只按 `\n` 切、只留非空行、每行 strip 一次行首 BOM。
 */
function pendingLines(text) {
  if (text === null || text === undefined) return [];
  return String(text)
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/^\uFEFF/, ''))
    .filter((l) => l.trim());
}

/**
 * 台账里已登记的编号。**在锁内、且只在真的有队列行时读**（空队列不该要求台账存在 ——
 * 旧 CLI 也是在"队列为空"分支直接退出、根本没 require 台账；新建包跑一次不报错）。
 * 台账读不动（缺 / 语法坏）→ 抛错让事务拒写：**判不了"哪些已登记"就不许归档**，
 * 否则会把没处理完的问题当已处理搬走（比旧 CLI 的崩溃更明确，方向相同：失败关闭）。
 */
function registeredIds(root) {
  const ledgerPath = path.join(root, 'assets', 'questions-data.js');
  // require 有缓存：同一进程里答完再归档必须看到新台账（与 ask-server 的 GET /ask 同一条）
  delete require.cache[require.resolve(ledgerPath)];
  const ledger = require(ledgerPath);
  return new Set(Object.values(ledger).map((q) => String(q.id)));
}

/**
 * 归档一次（**pending 与 processed 同事务**）。
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
  let r;
  for (;;) {
    r = ledgerTxn.withPackTransaction(abs, ({ files }) => {
      // 事务件会先空跑一次（`files:{}`）问"打算写哪些 rel"，再按那份清单读写前字节、
      // 带着真实字节回调第二次。**第一次必须点名两个目标**：否则它不会去读 pending，
      // 第二次拿到的 files 还是空的，归档永远看见空队列（T11 自测抓到的真坑）。
      // 第二次（keys 已就位）才按真实内容决定到底写不写。
      if (!files || Object.keys(files).length === 0) {
        return {
          files: [{ rel: PENDING_REL, content: '' }, { rel: PROCESSED_REL, content: '' }],
          value: { drained: 0, kept: 0, empty: true, keptLines: [], registered: [] },
        };
      }
      const pendingBefore = files[PENDING_REL] === undefined ? null : files[PENDING_REL];
      const lines = pendingLines(pendingBefore);
      if (!lines.length) {
        // 空队列/只有空行 = 没有可归档的，**一个字节都不写**（旧 CLI 同行为）
        return { files: [], value: { drained: 0, kept: 0, empty: true, keptLines: [], registered: [] } };
      }

      const registered = registeredIds(abs);
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

      const plan = [];
      if (drained.length) {
        const processedBefore = files[PROCESSED_REL] === undefined ? null : files[PROCESSED_REL];
        plan.push({
          rel: PROCESSED_REL,
          content: (processedBefore === null ? '' : String(processedBefore)) + drained.join('\n') + '\n',
        });
      }
      plan.push({ rel: PENDING_REL, content: kept.length ? kept.join('\n') + '\n' : '' });
      return {
        files: plan,
        value: { drained: drained.length, kept: kept.length, empty: false, keptLines: kept, registered: [...registered] },
      };
    }, { ownerToken });

    if (r.state !== 'busy' || Date.now() >= deadline) break;
    sleepSync(5 + Math.floor(Math.random() * 10));
  }

  const v = r.value || {};
  return {
    drained: v.drained || 0,
    kept: v.kept || 0,
    state: r.state,
    ok: r.ok === true,
    error: r.error || null,
    empty: v.empty === true,
    keptLines: Array.isArray(v.keptLines) ? v.keptLines : [],
    registered: Array.isArray(v.registered) ? v.registered : [],
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
    console.log(`[drain] ⚠️ 保留 ${r.kept} 条在待办队列 —— 它们还没登记进 questions-data.js`);
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
