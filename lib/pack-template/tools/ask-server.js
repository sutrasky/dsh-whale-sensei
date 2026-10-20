#!/usr/bin/env node
/**
 * ask-server.js — 课程疑问的本地收集服务（零依赖）
 * ------------------------------------------------------------------
 * 启动： node tools/ask-server.js            （默认 127.0.0.1:8788）
 *        node tools/ask-server.js --port 9000
 *
 * 为什么需要它：课程页是 file:// 静态页面，浏览器不允许网页直接写硬盘，
 * 所以开一个只监听本机的小服务，把学生提交的疑问落成文件，老师随即能读到。
 * 服务不在时，页面会自动降级为「复制到剪贴板」，闭环不会断。
 *
 * 接口：
 *   POST /api/session  { scope?: 'reader' } → { ok, token, exp, header }
 *   POST /ask     { question, lesson, page, title } → 追加到 questions/pending.jsonl
 *                 返回 { ok: true, id: "0003" }（**要能力令牌**，见下）
 *   GET  /health  → { ok: true, pending: N, port: N }
 *   OPTIONS *     → CORS 预检（file:// 页面的 Origin 是 null，必须放行）
 *
 * ⚠️ **授权（T07 / 报告 D02）**：`/ask` `/note` `/notes` `/progress` 是**写 / 私人读**口，
 *    跨源请求必须带 `X-Whale-Capability`（先 `POST /api/session` 开一次会话）。
 *    **CORS 响应头不是授权**：恶意 Origin + `text/plain` 的跨站 POST 以前照样写盘（实测 200）。
 *    判定一律走 `tools/http-security.cjs`（全仓只此一份），本文件不自己写第二套判断。
 *    `file://` 页面（`Origin: null`）默认**不认** —— 要用那条路显式开 `--allow-file-origin`。
 *
 * 文件：
 *   questions/pending.jsonl  一行一条待处理疑问（append-only，不覆盖）
 *   questions/seq.txt        已发号，保证编号不重复
 *
 * ⚠️ **写口统一事务（T11 / 报告 C01）**：`/ask` `/note` `/progress`（含课后调整）**全部**经
 *    `tools/ledger-transaction.cjs` 的 `withPackTransaction()` 提交 —— 序号与记录是**同一个写集**，
 *    序号在**锁内**算。原先"先写 seq 再 append 记录"的两步里，第二步失败会留下
 *    "序号已前进、记录没落盘"的半提交（C01 原文）；现在崩溃恢复只有两种合法终态：
 *    原状态 / 完整已提交状态。
 *    **不另起锁协议**（卡面 outOfScope）：互斥、日志、回滚都由那一份事务件负责；本文件只提供
 *    "读当前字节 → 算新内容"的 build，绝不自己写盘。
 *
 * **MIRROR-OF: lib/notes-io.js, lib/gate.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'questions');
const PENDING = path.join(DIR, 'pending.jsonl');
const NOTES_DIR = path.join(ROOT, 'notes');
const NOTES_JSONL = path.join(NOTES_DIR, 'notes.jsonl');
// 课次映射表：包侧唯一一份（`tools/lesson-map.js`），与插件 `lib/pack-model.js` 有一道对拍钉住
const { lessonMap, labelOfAnchor, keyOfAnchor, resolveLessonRef } = require(path.join(__dirname, 'lesson-map.js'));
// 逐行剥 BOM（坑位见 tools/pack-text.js）—— 不剥的话带 BOM 的那一行会被静默滤掉
const { splitLines: splitNoteLines, stripBom } = require(path.join(__dirname, 'pack-text.js'));
const PROGRESS = path.join(ROOT, 'progress.json');                 // 学习进度（星图据此点亮）
const ADJUST_DIR = path.join(ROOT, 'learning-records');            // 课后调整（adjustments.jsonl，见 REL）
const STATE = path.join(ADJUST_DIR, 'state.json');                 // 判据快照（whale_state write:true 产出）
// 内容指纹（同源三份逐字一致）：点亮前核对「快照之后代码又变了没」（新鲜度不用 mtime）
const { digestTree, PROBE_VERSION } = require(path.join(__dirname, 'fingerprint.js'));
// 独立服务的授权件（T07 / 报告 D02）—— 与 app-server / offline-server **同一份**实现
const httpSecurity = require('./http-security.cjs');
const { readJsonObject, sessionReadBody, requestUrl, withRequestBoundary } = require('./http-request.cjs');
// 唯一的跨进程提交协议（T09 交付的随包件）。**不复制第二份锁协议**：本文件只算内容，
// 互斥 / 日志 / 回滚 / 恢复全在那一份里（卡面 outOfScope 明写"复制第二份锁协议"不许）。
const ledgerTxn = require('./ledger-transaction.cjs');

/**
 * U18：**普通记录写口**（笔记 / 疑问）的记录形状、序号发号、写后自检与「台账 + seq 同一个写集」
 * 的提交，只有一个出处 —— 权威内核 `tools/unify/records.cjs`（U14 交付，内部走 U06 的
 * `./unify/commit.cjs` 三闸提交）。宿主侧（插件 `lib/notes-io.js` / `lib/ask-io.js`）用的是
 * **同一份**内核 ⇒ 两个入口共用一本台账与一个计数器（`notes/seq.txt` / `questions/seq.txt`）。
 *
 * ⚠️ **R1（已知中间态，登记不修）**：`tools/unify/*.cjs` 这些副本由 U19 生成；只铺了模板、
 * 还没生成副本的夹具里，下面的 require 会 `MODULE_NOT_FOUND`。**不许**为了躲它把记录形状抄回
 * 本文件 —— 那就又成了两份口径，正是 U14/U18 要收掉的东西。
 */
let recordsCore = null;
function records() {
  if (!recordsCore) {
    try {
      recordsCore = require(path.join(__dirname, 'unify', 'records.cjs'));
    } catch (e) {
      const err = new Error(
        '记录内核不可用（tools/unify/records.cjs 缺失 —— 模板副本由 U19 生成，登记为 R1）：'
        + (e && e.message ? e.message : e),
      );
      err.code = 'UNIFY_CORE_MISSING';
      throw err;
    }
  }
  return recordsCore;
}

/**
 * U18：证据档位 / 五态 / 「缺证据失败关闭」的**唯一实现**是 `tools/unify/evidence.cjs`
 * （宿主侧 `lib/evidence.js` → 同一个内核）。判词两侧（插件 `lib/gate.js` 的 `judgeSnapshot`
 * 与这里的 `judgeLightup`）都调它，不再各写一套"哪一态算阻断"的分支。
 */
let evidenceCore = null;
function evidenceKernel() {
  if (!evidenceCore) {
    try {
      evidenceCore = require(path.join(__dirname, 'unify', 'evidence.cjs'));
    } catch (e) {
      const err = new Error(
        '证据内核不可用（tools/unify/evidence.cjs 缺失 —— 模板副本由 U19 生成，登记为 R1）：'
        + (e && e.message ? e.message : e),
      );
      err.code = 'UNIFY_CORE_MISSING';
      throw err;
    }
  }
  return evidenceCore;
}

/** 事务件认的包根相对落点（本文件**只**通过这些 rel 提交，绝不拼绝对路径去改盘） */
const REL = {
  pending: 'questions/pending.jsonl',
  questionSeq: 'questions/seq.txt',
  notes: 'notes/notes.jsonl',
  noteSeq: 'notes/seq.txt',
  progress: 'progress.json',
  adjustments: 'learning-records/adjustments.jsonl',
  evidence: 'learning-records/evidence.jsonl',
};
/** 锁元数据里的持有者标识（只给人看；真正的互斥是事务件的 mkdir） */
const OWNER_TOKEN = 'ask-server:' + process.pid;
/** 拿不到锁时的重试窗口：服务是常驻进程，忙一会儿该等，不该把学生的提问直接丢掉 */
const LOCK_RETRY_MS = 4000;

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg !== -1 && args[portArg + 1] ? Number(args[portArg + 1]) : 8788;
const HOST = '127.0.0.1';
const MAX_BODY = 16 * 1024;      // 单条疑问上限 16KB，防滥用

/**
 * 可信来源（T07）：`--origin=<来源>` / `WHALE_TRUSTED_ORIGIN`（逗号分隔）**加上**
 * 本次请求自己的来源（由 Host 推，且 Host 必须是本机回环 —— 见 http-security.cjs）。
 * 之所以还要"自己的来源"：服务可能被反代在别的端口 / 前缀下，写死端口会在换端口时失效。
 */
function trustedOriginsFromEnv() {
  const out = [];
  const argHit = args.find((a) => a.startsWith('--origin='));
  if (argHit) out.push(argHit.slice('--origin='.length));
  for (const piece of String(process.env.WHALE_TRUSTED_ORIGIN || '').split(',')) {
    if (piece.trim()) out.push(piece.trim());
  }
  return out;
}

/** `file://` 那条路要**显式**开（不盲信 null：null 不专属于 file:// 页面） */
const ALLOW_FILE_ORIGIN = args.includes('--allow-file-origin') || process.env.WHALE_ALLOW_FILE_ORIGIN === '1';

/**
 * 本包的能力集（**唯一一份**）。`tools/app-server.js` require 本文件时会**复用它** ——
 * 一个进程里两个服务各建一份能力集，就等于同一件事有两份口径。
 */
const capabilities = httpSecurity.createCapabilities({
  packId: path.basename(ROOT),
  adminOrigin: trustedOriginsFromEnv(),
  readerOrigin: trustedOriginsFromEnv(),
  // 本服务是**课程包自己的**服务 ⇒ 它自己的来源只服务 `reader`（管理能力住在 offline-server）
  selfScope: 'reader',
  trustFileOrigin: ALLOW_FILE_ORIGIN,
});

/**
 * 授权闸（**先授权后读体**）：返回 `true` = 放行，`false` = 已经回过 403 了。
 *
 * ⚠️ 放在**读请求体之前**：拒绝路径上一个字节都不读、更不写盘 —— 卡面「无权限跨源写入零副作用」。
 *
 * @param {object} req
 * @param {object} res
 * @param {{scope?:string}} [opts]
 */
function gate(req, res, opts = {}) {
  const verdict = capabilities.authorize(req, { scope: opts.scope || 'reader' });
  if (verdict.ok) return true;
  json(res, 403, httpSecurity.denyBody(verdict));
  return false;
}

fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(NOTES_DIR, { recursive: true });
fs.mkdirSync(ADJUST_DIR, { recursive: true });

/**
 * 读学习进度。progress.json 是**人和星图共读**的文件 ——
 * 只动 learned 数组，其它字段（`_` 说明 / `note`）原样保留，免得把注释写丢。
 */
function readProgress() {
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
    if (!Array.isArray(p.learned)) p.learned = [];
    return p;
  } catch (e) {
    return { learned: [] };
  }
}
/**
 * 事务用的 fs：**append-only 台账**（pending / processed / notes / adjustments）的新内容
 * 落到暂存件时走 `appendFileSync`。
 *
 * 为什么不是多此一举：暂存件是**本次新建的路径**（`.tmp-txn-<uuid>`），append 与 write
 * 对它语义等价；但这样台账内容**从来不是靠"原地 truncate 再写"**产生的 —— 与卡面
 * "不直接 truncate 别人的写入"同一条纪律。另一个后果是：追加失败（EACCES / ENOSPC）
 * 会在事务层如实冒出来并触发回滚，而不是被静默吞掉。
 */
const APPEND_ONLY_STAGING = [
  /(^|\/)questions\/pending\.jsonl\.tmp-txn-/,
  /(^|\/)questions\/processed\.jsonl\.tmp-txn-/,
  /(^|\/)notes\/notes\.jsonl\.tmp-txn-/,
  /(^|\/)learning-records\/adjustments\.jsonl\.tmp-txn-/,
];
function txnFs() {
  return {
    ...fs,
    writeFileSync(p, data, opts) {
      const s = String(p).replace(/\\/g, '/');
      if (APPEND_ONLY_STAGING.some((re) => re.test(s))) return fs.appendFileSync(p, data, opts);
      return fs.writeFileSync(p, data, opts);
    },
  };
}

/** 异步小睡（服务是常驻进程：拿不到锁时让出事件循环，不空转 CPU） */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把一次写口动作交给**同一个**事务件；`busy`（锁被另一个进程占着）在窗口内重试，
 * 其余终端状态原样返回。build 是同步的，只负责 "读当前字节 → 返回要写的文件"。
 *
 * ⚠️ 只服务 `/progress`（进度 + 课后调整是同一个写集）。`/ask` `/note` 的提交边界在
 * `tools/unify/records.cjs` → `./unify/commit.cjs`（U18 接线），**不**走这里 ——
 * 本文件的发号/记录形状都被收掉了（`seqFromText` / `pad4` 已随 U18 删除，不许再长回来）。
 * @returns {Promise<object>} withPackTransaction 的回执
 */
async function commitWithRetry(build, opts = {}) {
  const deadline = Date.now() + (opts.retryMs === undefined ? LOCK_RETRY_MS : opts.retryMs);
  for (;;) {
    const r = ledgerTxn.withPackTransaction(ROOT, build, {
      ownerToken: OWNER_TOKEN,
      fs: opts.fs || txnFs(),
      timeoutMs: opts.timeoutMs === undefined ? ledgerTxn.DEFAULT_TIMEOUT_MS : opts.timeoutMs,
    });
    if (r.state !== 'busy') return r;
    if (Date.now() >= deadline) return r;
    await sleepMs(5 + Math.floor(Math.random() * 15));
  }
  /* end commitWithRetry */
}

/**
 * U18：把一次「记录追加」交给 records 内核（记录形状 / 发号 / 写后自检 / 三闸提交都在那儿），
 * 锁忙（`LOCK_BUSY` / 提交状态 busy）在窗口内重试 —— 与原来 `commitWithRetry` 的
 * "服务是常驻进程，忙一会儿该等，不该把学生的东西直接丢掉"**同一语义**。
 * @param {Function} fn 同步调用 records 的 append* 并返回回执
 * @param {{retryMs?:number}} [opts]
 */
async function appendViaRecords(fn, opts = {}) {
  const deadline = Date.now() + (opts.retryMs === undefined ? LOCK_RETRY_MS : opts.retryMs);
  for (;;) {
    const r = fn();
    if (!r || r.ok === true) return r;
    const retryable = r.code === 'LOCK_BUSY' || r.state === 'busy';
    if (!retryable) return r;
    if (Date.now() >= deadline) return r;
    await sleepMs(5 + Math.floor(Math.random() * 15));
  }
}

/**
 * 事务失败 → HTTP 回执。**底层错误原文只进服务日志**，不进响应体：
 * 它可能带真实路径 / 注入标记（T08 的"不泄漏内部异常"契约），对客户端也只说"没落盘、可重试"。
 * 忙（busy）是**可重试**的，501/500 会诱导客户端以为写坏了，所以单独给 503。
 */
function replyWriteFailure(res, r) {
  const detail = `[ask] 写盘失败：state=${r && r.state} ${r && r.error ? r.error : ''}`;
  try { console.error(detail); } catch { /* 日志坏了不许影响回执 */ }
  if (r && r.state === 'busy') {
    json(res, 503, { ok: false, code: 'WRITE_BUSY', error: '台账正被另一个写者占用，请稍后重试' });
    return;
  }
  json(res, 500, { ok: false, code: 'WRITE_FAILED', error: '写盘失败，本次改动没有落盘，请稍后重试' });
}

/**
 * 学习进度的直接写口（保留旧接口）。内部同样走事务件 —— 不再有绕过锁的写路径。
 * 失败时抛出（调用方原本就期待它抛），错误上带 `state` 供调用点判定。
 */
function writeProgress(p) {
  const r = ledgerTxn.withPackTransaction(ROOT, () => [
    { rel: REL.progress, content: JSON.stringify(p, null, 2) + '\n' },
  ], { ownerToken: OWNER_TOKEN, fs: txnFs() });
  if (!r.ok) {
    const e = new Error(`progress 写失败（事务状态：${r.state}）`);
    e.state = r.state;
    e.txnError = r.error || null;
    throw e;
  }
  return r;
}

/**
 * 判据快照（learning-records/state.json）——容错读。
 * 缺失 / 解析失败 / 没有 projects 一律 { ok:false }（分支 B，失败关闭）。
 */
function readSnapshot() {
  let raw;
  try {
    raw = fs.readFileSync(STATE, 'utf8');
  } catch (e) {
    return { ok: false };
  }
  let doc;
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.projects)) return { ok: false };
  return { ok: true, doc };
}

/**
 * 证据台账的**现读**（U18 / T12-C02）：`learning-records/evidence.jsonl`。
 *
 * 读法镜像插件 `lib/evidence-io.js`（同一个落点、同一套五态），但**"算什么态"与"算不算阻断"
 * 一律交给内核** `tools/unify/evidence.cjs`（`validateEvidence` / `ledgerStatusOf`）——
 * 包侧不自己写第二份分支，否则两侧一漂就是"插件拦住、包侧点亮"。
 *
 * @returns {{file:string, exists:boolean, status:string, entries:object[], problems:string[], errorCode?:string}}
 */
function readEvidenceLedger() {
  const file = path.join(ROOT, ...REL.evidence.split('/'));
  const core = evidenceKernel();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = String((e && e.code) || 'IO_ERROR');
    // ⚠️ **只有真 ENOENT 才算"不存在"**：EISDIR / EACCES 是读取故障，不许伪装成"没贴过证据"
    if (code === 'ENOENT') return { file, exists: false, status: 'missing', entries: [], problems: [], errorCode: 'ENOENT' };
    const msg = String((e && e.message) || e);
    return {
      file,
      exists: true,
      status: 'io-error',
      entries: [],
      problems: ['证据台账读不动（' + code + '）：' + msg],
      errorCode: code,
      error: msg,
    };
  }
  const entries = [];
  const problems = [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch (e) {
      problems.push('第 ' + (i + 1) + ' 行不是 JSON：' + (e && e.message ? e.message : e));
      continue;
    }
    try {
      entries.push(core.validateEvidence(row, '第 ' + (i + 1) + ' 行'));
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { file, exists: true, status: core.ledgerStatusOf({ exists: true, entries, problems }), entries, problems };
}

/**
 * 课次身份对位（U18 / C6）：页面给的是**规范形状** `circle/point/NNNN`，
 * 判据快照里是 `EXPECT.json` 的**声明形状** `point/NNNN` —— 两种形状的同一门课必须能认成同一门。
 * 只做逐字相等的话，U09 收成规范键之后每一次点亮都会掉进 `unknown-lesson`（点不亮）。
 *
 * @returns {{hit:object|null, project:object|null, ambiguous:boolean, ids:string[]}}
 */
function findSnapshotLesson(projects, lesson) {
  const list = Array.isArray(projects) ? projects : [];
  for (const pr of list) {
    const l = pr && Array.isArray(pr.lessons) ? pr.lessons.find((x) => x && x.id === lesson) : null;
    if (l) return { hit: l, project: pr, ambiguous: false, ids: [lesson] };
  }
  let core;
  try {
    core = evidenceKernel();
  } catch (e) {
    return { hit: null, project: null, ambiguous: false, ids: [] };
  }
  const hits = [];
  for (const pr of list) {
    for (const l of (pr && Array.isArray(pr.lessons) ? pr.lessons : [])) {
      if (l && core.sameLesson(l.id, lesson)) hits.push({ hit: l, project: pr, id: String(l.id) });
    }
  }
  if (hits.length === 1) return { hit: hits[0].hit, project: hits[0].project, ambiguous: false, ids: [hits[0].id] };
  if (hits.length > 1) {
    return { hit: null, project: null, ambiguous: true, ids: [...new Set(hits.map((h) => h.id))].sort() };
  }
  return { hit: null, project: null, ambiguous: false, ids: [] };
}

/**
 * 点亮判定（**先判后写**）：只做「查表 + 比指纹」，判定词汇一行都不在这儿
 * （判定真源 = 插件 lib/state.js 的 judgeChallenges，快照就是它的产物）。
 * 判决分支表（契约 §2.2；拒绝一律 200 + ok:false + code，让前端走判据回执分支）：
 *   B 快照缺失/读不懂                    → no-snapshot
 *   C 课次 id 在快照里找不到              → unknown-lesson（id 写错 / 快照旧了 —— 不是"没写判据"）
 *   C2 无判据（challenges 为空/结构不合法）→ no-criteria
 *   D 快照过期（探针版本对不上，或内容指纹对不上；老快照没有指纹字段也算）→ stale-snapshot
 *   E 判据未全过                          → criteria-not-met + gaps
 *   F 通过                                → ok:true（唯一写盘点在调用方）
 *   （A 缺 lesson → 400；G 显式 done:false → 连判都不判；都在调用方处理）
 * 失败一律关闭：不写 learned，但回执要说清差什么（不静默）。
 * L3 口径：`auto:false`（机器判不了）的题**不阻塞**点亮，题号显式走 needsReview[] ——
 * 否则带「需老师确认」题的课永远点不亮 = 死锁（真包 spring-boot/0001 第 4 题就是）。
 */
function judgeLightup(lesson) {
  const snap = readSnapshot();
  if (!snap.ok) {
    return { ok: false, code: 'no-snapshot', hint: '先跑 whale_state write:true 生成判据快照', gapText: [] };
  }
  const found = findSnapshotLesson(snap.doc.projects, lesson);
  let hit = found.hit;
  let project = found.project;
  // 多门同名课分不出是哪一门 → **不猜**（U18：跨圈同名课次的判据不许互相顶替）
  if (found.ambiguous) {
    return {
      ok: false,
      code: 'unknown-lesson',
      hint: '课次 id 在判据快照里对应多门同名课（' + found.ids.join(' / ') + '）—— 分不出是哪一门（跨圈同名），'
        + '**不猜**；先把课次写成规范身份 circle/point/NNNN 并重刷快照（whale_state write:true）再试',
      gapText: [],
    };
  }
  const chs = hit ? hit.challenges : undefined;
  const usable = Array.isArray(chs) && chs.length > 0
    && chs.every((c) => c && Number.isSafeInteger(c.no) && c.no > 0
      && typeof c.deliverable === 'string'
      && (c.done === true || c.done === false || c.done === null));
  // 对位键（P1-11）：「课次 id 在快照里找不到」与「这门课没声明判据」是**两种病、两句 hint** ——
  // 混成一句就把 id 写错的人指去"先补判据"（修法指错了，2026-09-24 实测）。顺序即契约：
  // unknown-lesson 排在 no-snapshot 之后、no-criteria 之前（都在新鲜度两把尺子之前）——
  // 与插件 lib/gate.js 的 judgeSnapshot **同一顺序、同一句 hint**，改一处必须改两处。
  if (hit === null) {
    return { ok: false, code: 'unknown-lesson', hint: '课次 id 不认识：' + lesson + '（判据快照里没有这门课）—— 要么 id 写错了，要么快照是旧的；先跑 whale_state write:true 刷新一次再试', gapText: [] };
  }
  if (!usable) {
    return { ok: false, code: 'no-criteria', hint: '这门课还没声明挑战判据（EXPECT.json challenges）—— 先补判据', gapText: [] };
  }
  // 新鲜度有**两把尺子**，顺序不能反、更不能合成一条 —— 先比探针版本，再比代码树的内容指纹
  // （与插件 lib/gate.js 的 judgeSnapshot **同一顺序、同一句 hint**，改一处必须改两处）：
  // ① probeVersion：这份判词是**哪个版本的探针**算的（缺 / 不等 = 判定口径变过，旧判词不可信；
  //    2026-09-24 实测缺陷：只比代码指纹时，探针升级后的旧快照照样"新鲜"，拿旧判词拦人）；
  // ② sourceDigest：学生代码树变没变（原有判定，一行没动）。
  // ⚠️ 两种过期原因必须**两句话**（hint 各写各的）：探针升级 = 学生什么都不用改、刷新一次就好；
  //    代码又改了 = 你刚改的还没重判。混成一句就把人指向错的修法。
  if (snap.doc.probeVersion !== PROBE_VERSION) {
    return {
      ok: false,
      code: 'stale-snapshot',
      hint: '判据快照是旧版探针算出来的（探针升级、判定口径变过）：不用改代码，跑 whale_state write:true 刷新一次即可',
      gapText: [],
    };
  }
  // 新鲜度 = 内容指纹（不是 mtime）：老快照缺字段 / 项目目录读不动 → 一律判过期
  const saved = typeof project.sourceDigest === 'string' ? project.sourceDigest : '';
  let now = '';
  try {
    // `project.dir` 是**包根相对**路径（2026-09-24 起：探针按声明的实践区多根扫描，
    // 根相对写法在多根下会撞名，所以项目身份一律以包根为准）。绝对路径也照样吃（path.resolve 认）。
    // 老快照的 `dir` 恰好也是包根相对（当年单根 ⇒ 根相对 == 包根相对），所以**零回归**。
    now = digestTree(path.resolve(ROOT, String(project.dir || '')));
  } catch (e) {
    now = '';
  }
  if (!saved || now !== saved) {
    return { ok: false, code: 'stale-snapshot', hint: '代码在快照之后又变了：先跑 whale_state write:true 刷新', gapText: [] };
  }
  const needsReview = [];
  const gaps = [];
  const gapText = [];
  const evidenceGaps = [];
  // ── T12（C02）/ U18：**现读一次证据台账** ──────────────────────────────────
  // 证据台账不在 `sourceDigest` 里（那个指纹只算学生代码树），所以台账在快照之后坏掉 /
  // 读不动 / 变空时，快照里"证据够档"那句判词仍然"新鲜" —— 必须在这里复核，且与插件
  // `lib/gate.js` 的 `judgeSnapshot` 走**同一台**判定（`liveLedgerVerdict`）。
  // ⚠️ 只对**声明了 minEvidence 的题**生效；`missing` 不在此列（防死锁回退是既定策略）。
  let liveBroken = null;
  if (chs.some((c) => c && c.evidence && c.evidence.min)) {
    const verdict = evidenceKernel().liveLedgerVerdict(readEvidenceLedger(), { needsEvidence: true });
    if (verdict.broken) liveBroken = verdict;
  }
  for (const c of chs) {
    // ── 证据档（P0-4 戊1b，2026-09-25）：**阻塞**，所以必须排在 needsReview 那条"不阻塞"快路之前 ──
    // 口径与回执那句话**都由判据快照给**（插件 `lib/state.js` 的 judgeChallenges 算好、
    // 存进 `challenges[].evidence`）—— 本侧只是**转述同一句**，不自己再拼一份（拼两份必然漂）。
    // U18：快照里的证据判词可能是**旧的**（台账不在 sourceDigest 里）→ liveBroken 时按证据不够拦。
    if (liveBroken && c.evidence && c.evidence.min) {
      evidenceGaps.push({
        no: c.no,
        deliverable: c.deliverable,
        min: c.evidence.min,
        have: c.evidence.have === undefined ? null : c.evidence.have,
        hint: `第${c.no}题还差一档证据（${liveBroken.why}）—— ${liveBroken.hint}`,
      });
      continue;
    }
    if (c.evidence && c.evidence.ok === false) {
      evidenceGaps.push({
        no: c.no,
        deliverable: c.deliverable,
        min: c.evidence.min,
        have: c.evidence.have,
        hint: c.evidence.hint || '',
      });
      continue;
    }
    // L3：auto:false（机器判不了）→ 不阻塞点亮，但题号必须显式回执
    if (c.done === null || c.needsReview === true) { needsReview.push(c.no); continue; }
    if (c.done !== true) {
      const miss = (Array.isArray(c.missing) ? c.missing : [])
        .map((m) => String((m && (m.hint || m.evidence || m.id)) || ''))
        .filter(Boolean);
      gaps.push({ no: c.no, deliverable: c.deliverable, missing: miss });
      gapText.push('第' + c.no + '题：' + c.deliverable + '（缺：' + (miss.join('、') || '未过') + '）');
    }
  }
  // 判定顺序**即契约**（与插件 lib/gate.js 的 judgeSnapshot 同一顺序，改一处必须改两处）：
  //   ① criteria-not-met（机器判据的缺口，最具体）→ ② evidence-insufficient（证据档不够）→ ③ ok
  // 两者都缺时**一次回执全说**（criteria-not-met 里也带 evidenceGaps）—— 不然学生要修两轮。
  if (gaps.length) return { ok: false, code: 'criteria-not-met', gaps, gapText, evidenceGaps };
  if (evidenceGaps.length) {
    return {
      ok: false,
      code: 'evidence-insufficient',
      evidenceGaps,
      gapText: evidenceGaps.map((g) => g.hint),
      needsReview,
      evidenceFallback: hit.evidenceFallback === true,
    };
  }
  // Q2 欠账（2026-09-24）：**判词只看 challenges**，不要求 `lessons[].done === true` ——
  // 要求 done 会把「required 里也有机器判不了的项」变成新的死锁（挑完 challenges 又挑 required，
  // 等于把刚拆掉的死锁搬了个地方）。但**该说的必须说**：本课 required 还缺着的，
  // 作为**不阻塞**的提示回给调用方，别让学生以为"全过、万事大吉"。
  const requiredGaps = (Array.isArray(hit.missing) ? hit.missing : [])
    .map((m) => String((m && (m.hint || m.value || m.id)) || ''))
    .filter(Boolean);
  return {
    ok: true, needsReview, gapText: [], requiredGaps,
    // 判据 ④：证据台账还没建立 → 声明了 minEvidence 的题**这一档没判**。必须说出来（不许静默变松）。
    evidenceFallback: hit.evidenceFallback === true,
  };
}

function countPending() {
  try {
    return fs.readFileSync(PENDING, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch (e) {
    return 0;
  }
}

/* ── 笔记台账：与插件写入口（lib/notes-io.js 的 appendNote）**同形** ──────────
 *
 * 台账正本 `notes/notes.jsonl` 与计数器 `notes/seq.txt` 是**两个写入口共用**的
 * （另一个是插件的 `POST /api/whale/note`）。既然共用一本账，记录就必须逐字段对齐，
 * 否则同一文件里两种写法 —— 正是本项目在消灭的那类东西。
 *
 * 2026-09-24 归一（此前这里是 6 位 id + `at` 时间戳 + `lesson`/`page`）：
 *   · id 四位零填充，来自 `notes/seq.txt` 单调计数器
 *   · 字段 `{ id, seq, kind:'笔记', anchor, text }`（`date` 可选，只在显式给时写）
 *   · **不写时间戳** —— 写时间戳会让"同一输入两次写"产出不同文件，--check 的逐字节对拍就废了
 *   · `anchor` 一律**归一成星图课次键**（keyOfAnchor），孤儿锚点当场拒
 *   · 只追加不覆盖：id 撞车就拒
 */
/**
 * CORS：**只放行 file:// 页面**（2026-09-24 收窄；原先是无条件 `Access-Control-Allow-Origin: *`）。
 *
 * 为什么原来那条是错的：`*` 等于「**你访问的任何网站**都能往你本地课程包写笔记 / 疑问 / 进度」——
 * 服务只绑 127.0.0.1 挡的是远程，挡不住本机浏览器里别的页面。
 *
 * 为什么不能直接删：`assets/ask.js:29-30` 有一条真实的第三条路 —— **双击（file://）打开的页面**
 * 会回落到 `http://127.0.0.1:8788`（本服务）。浏览器给 file:// 页面送的 `Origin` 是字符串 `"null"`，
 * 那是跨源 ⇒ **必须**回 `Access-Control-Allow-Origin: null` 才放行。
 *
 * 判据：**有 Origin 且不等于 `"null"` → 一个头都不给**（浏览器自己拦下）；
 * 无 Origin（同源 / curl 之类非浏览器调用）→ 也不需要给（同源本来就不看 CORS）。
 * 决定在**入口做一次**并挂在 res 上，`json()` 照旧只管写 —— 十几个调用点一个都不用改。
 */
const ALLOWED_ORIGIN = 'null';

function decideCors(req, res) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  res._allowOrigin = origin !== undefined && String(origin) === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
}

function cors(res) {
  if (!res._allowOrigin) return;   // 不在放行名单 → 不给任何 CORS 头
  res.setHeader('Access-Control-Allow-Origin', res._allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  // 授权头（T07）：跨源要带 `X-Whale-Capability`，预检必须放行它 ——
  // 注意这是**传输层**的放行（浏览器肯不肯发这个头），**不是**授权判断（判断在 http-security.cjs）。
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Whale-Capability');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

function json(res, code, body) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  if ((code === 400 || code === 413) && body && body.ok === false && !body.code) {
    body.code = code === 413 ? 'BODY_TOO_BIG' : 'BAD_REQUEST';
  }
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

async function requestHandler(req, res) {
  decideCors(req, res);   // 入口定一次：谁有资格拿 CORS 头（见上面那段）
  const url = requestUrl(req);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── 会话：可信来源换一个能力令牌（T07）─────────────────────────────────
  // 令牌只发给可信来源；不可信来源（evil / 默认的 null）在这里就被拒，且**不动盘**。
  if (url.pathname === httpSecurity.SESSION_PATH) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: '开会话只接受 POST' });
      return;
    }
    const trust = capabilities.canMint(req, 'reader');
    const adminTrust = capabilities.canMint(req, 'admin');
    if (!trust.ok && !adminTrust.ok) return json(res, 403, httpSecurity.denyBody(trust));
    return httpSecurity.sessionHandler(req, res, capabilities, { readBodyImpl: sessionReadBody });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, pending: countPending(), port: PORT });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/progress') {
    // ⚠️ **读口不设闸**（T07 的边界，写清楚了再改）：D02 的病是"**副作用**在无授权时发生了" ——
    //    读口没有副作用，而跨源读**读不到正文**（不给不可信来源任何 CORS 头，浏览器自己拦）。
    //    真给读口也上闸，课程入口页（`index.html` 的"已点亮"）与星图（`starmap/main.js`）
    //    就必须都带令牌 —— 那要改**落点外**的 `lib/pack-template/index.html`。
    //    本卡只授权了落点内的文件，所以读口保持开放；写口一个不漏（下面三处）。
    const p = readProgress();
    json(res, 200, { ok: true, learned: p.learned, lit: p.learned.length });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/progress') {
    if (!gate(req, res)) return;      // **先授权后读体**：拒绝路径上不读体、不写盘
    const payload = await readJsonObject(req, { maxBytes: MAX_BODY }).catch((err) => {
      if (err.status === 413) err.message = '内容太长了，请精简到 16KB 以内';
      throw err;
    });

      // ── 身份闸（写前、判据前、事务前）：lesson 必须是**本包**的规范课次键 ────────
      // 2026-10-20 独立审查实测的真缺陷：这里原先只判"非空"，于是页面发来的**两段**课键
      // `spring-boot/0001` 被原样写进 `progress.json` 的 learned、写进 adjustments，
      // 还回 200/ok:true —— 而读侧（`readPack` → `resolveLearned`）只认 `circle/point/NNNN`，
      // 于是"提示成功但模型不计已学"，学生永远点不亮。更糟的是判据那一步靠快照的模糊对位
      // 也能"对上"（跨圈同名时更会张冠李戴）。
      //
      // 规矩：**写盘之前**就要么拿到唯一的规范键、要么拒。拒绝分得开（非法 / 旧形状 / 错圈 /
      // 歧义 / 本包没有这门课），且拒绝路径**一个字节都不写**（与 gate 拒绝同一条纪律）。
      const rawLesson = String(payload.lesson || '').trim();
      if (!rawLesson) {
        json(res, 400, { ok: false, error: '缺 lesson（进度要记在哪一课上）' });
        return;
      }
      const lessonMapNow = lessonMap(ROOT);
      const lessonRef = resolveLessonRef(rawLesson, lessonMapNow);
      if (!lessonRef.ok || lessonRef.sentinel) {
        const why = lessonRef.ok
          ? '「未归课」不是课次：它只是笔记 / 答疑的落桶，不能用来点亮进度'
          : lessonRef.failure.error;
        json(res, 400, {
          ok: false,
          code: 'ID_NOT_ALLOWED',   // 既有码（含义本来就是"这个 id 不允许"），不新增码值
          error: 'lesson 不是本包的规范课次键（circle/point/NNNN）：' + why,
          hint: '页面上的 course 页会把规范课次键烘进 .adjust[data-lesson]；手写调用请给完整 circle/point/NNNN',
          lesson: rawLesson,
        });
        return;
      }
      // 事务、判据、learned、adjustments、回执**全部**只用这一个已验证的 key
      const lesson = lessonRef.key;

      const adjust = String(payload.adjust || '').trim();
      // ── 先判后写（分支表 A–G，见 judgeLightup）────────────────────────────
      // G：显式 done:false = 不请求点亮 → 连判都不判（但 adjust 照落）
      const wantsLight = payload.done !== false;
      // 判定只读快照 / 代码树（**不写盘**），必须在事务之前算完 —— 别把 judge 的 IO
      // 拖进锁里（锁窗口越短，并发写口的 busy 越少）。
      const verdict = wantsLight ? judgeLightup(lesson) : { ok: true, code: 'not-requested', gapText: [] };

      // 进度与课后调整是**同一个写集**：任一写不下去，两个都回到写前（T11 卡面）。
      // 序号不涉及这里；点亮幂等（已含则不动）在锁内按**当前** progress 判，而不是按判定时的旧快照。
      const r = await commitWithRetry(({ files }) => {
        const progressBefore = files[REL.progress] === undefined ? null : files[REL.progress];
        let p;
        try { p = JSON.parse(progressBefore); } catch (e) { p = { learned: [] }; }
        if (!p || typeof p !== 'object') p = { learned: [] };
        if (!Array.isArray(p.learned)) p.learned = [];

        const plan = [];
        let lit = false;
        if (wantsLight && verdict.ok) {
          // F：**唯一写盘点**（幂等：已含则不动）
          if (p.learned.indexOf(lesson) === -1) {
            p.learned.push(lesson);
            plan.push({ rel: REL.progress, content: JSON.stringify(p, null, 2) + '\n' });
          }
          lit = true;
        }

        // adjust 文本**无论点没点亮都**落账（带 lit / gaps 留痕；拒绝也不许静默丢话）
        let adjustSaved = false;
        if (adjust) {
          // 上一行没有收尾换行就先补一个（照插件 lib/ask-io.js 的 appendPending 同款，
          // 与本文件 /ask、/note 两处一致）—— 旧台账末尾缺 \n 就直接 append，两条会粘成
          // 一行坏 JSON。那正是今天在 questions/pending.jsonl 上踩过的坑，别在这条上重演。
          const adjustCur = files[REL.adjustments] === undefined || files[REL.adjustments] === null
            ? '' : String(files[REL.adjustments]);
          const adjustPrefix = adjustCur.length > 0 && !adjustCur.endsWith('\n') ? '\n' : '';
          plan.push({
            rel: REL.adjustments,
            content: adjustCur + adjustPrefix + JSON.stringify({
              ts: new Date().toISOString(),
              lesson,
              title: String(payload.title || ''),
              adjust,
              lit,
              gaps: verdict.gapText || [],
            }) + '\n',
          });
          adjustSaved = true;
        }
        return { files: plan, value: { p, lit, adjustSaved } };
      });
      if (!r.ok || !r.value) return replyWriteFailure(res, r);
      const p = r.value.p;
      const adjustSaved = r.value.adjustSaved;

      // 回执里的 `lesson` 是**这一个**已验证的规范键（learned / adjustments / 回执同一个 key）
      const out = { ok: verdict.ok, lesson, learned: p.learned, lit: p.learned.length, adjustSaved };
      if (verdict.code) out.code = verdict.code;
      if (verdict.hint) out.hint = verdict.hint;
      if (verdict.gaps) out.gaps = verdict.gaps;
      if (verdict.needsReview) out.needsReview = verdict.needsReview;
      // 证据档（P0-4）：逐条说清"还差哪一档"；`evidenceFallback` 说明台账还没建立、这一档没判
      if (verdict.evidenceGaps && verdict.evidenceGaps.length) out.evidenceGaps = verdict.evidenceGaps;
      if (verdict.evidenceFallback) out.evidenceFallback = true;
      // 不阻塞的"还有没做到的"：本课 required 的缺口（见 judgeLightup 尾注）
      if (verdict.requiredGaps && verdict.requiredGaps.length) out.requiredGaps = verdict.requiredGaps;
      // 拒绝也一律 200 + ok:false + code：让 adjust.js 走**判据回执**分支，而不是网络降级
      json(res, 200, out);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ask') {
    // 读口不设闸（见 `/progress` 上面那段边界说明）：就地反馈的轮询没有副作用
    // 就地反馈（P1-8）：学生交完疑问后，页面**轮询这一条** —— 答好了就把答案推回那一屏
    // （疑问页退成归档索引）。只读、幂等；查不到就如实说「还没答」，**不编**。
    const id = String(url.searchParams.get('id') || '').trim();
    if (!/^\d{4}$/.test(id)) {
      json(res, 400, { ok: false, error: 'id 必须是四位编号（如 0004）' });
      return;
    }
    try {
      const ledgerPath = path.join(ROOT, 'assets', 'questions-data.js');
      // 台账是 JS 模块：require 有缓存 ⇒ 答完再读会拿到旧值，必须先清缓存（这是个真坑）
      delete require.cache[require.resolve(ledgerPath)];
      const ledger = require(ledgerPath);
      const rec = ledger && ledger[id] ? ledger[id] : null;
      const answered = Boolean(rec && rec.status === 'answered' && (rec.answerHtml || rec.answer));
      json(res, 200, answered
        ? {
            ok: true, id, answered: true,
            lesson: rec.lesson || '', section: rec.section || '',
            answer: rec.answer || '', answerHtml: rec.answerHtml || '',
          }
        : { ok: true, id, answered: false });
    } catch (e) {
      // 台账读不到（文件缺 / require 不过）→ 如实说不，不假装"答了"
      json(res, 200, { ok: true, id, answered: false, note: '台账读不到（assets/questions-data.js）' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ask') {
    if (!gate(req, res)) return;      // **先授权后读体**
    const payload = await readJsonObject(req, { maxBytes: MAX_BODY }).catch((err) => {
      if (err.status === 413) err.message = '问题太长了，请精简到 16KB 以内';
      throw err;
    });

      const question = String(payload.question || '').trim();
      if (!question) {
        json(res, 400, { ok: false, error: '疑问内容为空' });
        return;
      }

      // 序号（`questions/seq.txt`）与队列记录（`questions/pending.jsonl`）**同一个写集**，
      // 序号在锁内按当前字节发 —— 记录形状、发号、写后自检与三闸提交都在
      // `tools/unify/records.cjs`（U14）+ `./unify/commit.cjs`（U06）里（U18 接线）。
      // 宿主侧 `lib/ask-io.js` 用的是**同一份**内核 ⇒ 两个入口共用一本台账与一个计数器。
      const at = new Date().toISOString();
      const r = await appendViaRecords(() => records().appendAskRecord(ROOT, {
        lesson: String(payload.lesson || ''),
        page: String(payload.page || ''),
        title: String(payload.title || ''),
        question: question,
      }, {
        at: at,
        transaction: ledgerTxn,
        ownerToken: OWNER_TOKEN,
        timeoutMs: ledgerTxn.DEFAULT_TIMEOUT_MS,
      }));
      if (!r || r.ok !== true) return replyWriteFailure(res, r);
      const record = r.value.record;
      const id = r.value.id;
      console.log('[ask] 收到 #' + id + ' · ' + record.lesson + ' · ' +
        question.slice(0, 40).replace(/\s+/g, ' ') + (question.length > 40 ? '…' : ''));

      json(res, 200, { ok: true, id: id });

    return;
  }

  if (req.method === 'POST' && url.pathname === '/note') {
    if (!gate(req, res)) return;      // **先授权后读体**
    const payload = await readJsonObject(req, { maxBytes: MAX_BODY }).catch((err) => {
      if (err.status === 413) err.message = '笔记太长了，请精简到 16KB 以内';
      throw err;
    });

      const text = String(payload.text || '');
      if (!text.trim()) {
        json(res, 400, { ok: false, error: '缺 text（空笔记不写）' });
        return;
      }

      const date = payload.date;
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        json(res, 400, { ok: false, error: 'date 给就必须是 YYYY-MM-DD（不许默认"今天"）' });
        return;
      }

      // `lesson` 是旧客户端的写法，当 anchor 的别名收下 —— 两者归一成**同一个**星图课次键，
      // 所以这不构成"第二套口径"（写法可以宽容，落盘只有一种）
      const rawAnchor = payload.anchor || payload.lesson || '';
      const map = lessonMap(ROOT);
      const key = keyOfAnchor(rawAnchor, map);
      if (!key) {
        json(res, 400, {
          ok: false,
          error: '孤儿锚点：' + rawAnchor + ' 在课次映射表里解析不到（现有：' + Object.keys(map.byKey).join(' / ') + '）',
        });
        return;
      }

      // 序号（notes/seq.txt）与笔记记录（notes/notes.jsonl）**同一个写集**：
      // 两个都是共用台账（另一个写入口是插件 `lib/notes-io.js` 的 `appendNote`），
      // 所以撞号检查与发号都必须在**锁内**按当前台账判 —— 锁外先读后写会被并发写者穿透。
      // U18：记录形状 / 发号 / 写后自检 / 三闸提交全在 `tools/unify/records.cjs`（U14）+
      // `./unify/commit.cjs`（U06）；宿主侧 `lib/notes-io.js` 用的是**同一份**内核
      // ⇒ 宿主与包侧共用**一本台账（notes/notes.jsonl）与一个计数器（notes/seq.txt）**。
      const r = await appendViaRecords(() => records().appendNoteRecord(ROOT, {
        text: String(text),
        anchorKey: key,
        date: date === undefined ? undefined : String(date),
      }, {
        transaction: ledgerTxn,
        ownerToken: OWNER_TOKEN,
        timeoutMs: ledgerTxn.DEFAULT_TIMEOUT_MS,
      }));
      if (!r || r.ok !== true) {
        // 撞号（seq.txt 落后于台账）：保留既有 400 与逐字文案（只追加不覆盖）
        const why = String((r && (r.error || r.buildError)) || '');
        if (/已存在/.test(why)) {
          json(res, 400, { ok: false, error: why });
          return;
        }
        return replyWriteFailure(res, r);
      }
      const id = r.value.id;
      const seq = r.value.seq;
      console.log('[note] 收到 #' + id + ' · ' + key + ' · ' +
        text.slice(0, 40).replace(/\s+/g, ' ') + (text.length > 40 ? '…' : ''));

      json(res, 200, { ok: true, id: id, seq: seq, hasDate: date !== undefined });

    return;
  }

  if (req.method === 'GET' && url.pathname === '/notes') {
    // 读口不设闸（见 `/progress` 上面那段边界说明）
    const lesson = url.searchParams.get('lesson') || '';
    try {
      // 台账的 `anchor` 是星图课次键 → 反推只经 labelOfAnchor（别在这里比 n.lesson）
      const map = lessonMap(ROOT);
      const lines = splitNoteLines(fs.readFileSync(NOTES_JSONL, 'utf8')).filter((l) => l.trim());
      const notes = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((n) => n && (!lesson || labelOfAnchor(n.anchor, map) === lesson))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      json(res, 200, notes);
    } catch {
      json(res, 200, []);
    }
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}

const handleRequest = withRequestBoundary(requestHandler);

/* 被 tools/app-server.js 复用时（require）**不要自己 listen** —— 一个端口原则。
   单独跑（node tools/ask-server.js）时行为完全不变。 */
if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log('[ask-server] 已启动: http://' + HOST + ':' + PORT);
    console.log('[ask-server] 待处理疑问: ' + countPending() + ' 条 (' +
      path.relative(ROOT, PENDING) + ')');
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[ask-server] 端口 ' + PORT + ' 已被占用。换一个：node tools/ask-server.js --port 8789');
      process.exit(1);
    }
    console.error('[ask-server] 启动失败:', err.message);
    process.exit(1);
  });
}

/* `decideCors` / `cors` 也导出：`tools/app-server.js` 把两个服务拼在一个端口上，
   它的 `/health` 由**它自己**答 —— 2026-09-24 收窄 CORS 时那里就是漏掉的第二处
   （原先硬编码 `access-control-allow-origin: '*'`，被现场 HTTP 探针抓出来）。
   CORS 的决定只许住在**这一处**，别的文件沿用，不许再写一份。
   ⚠️ T07：`capabilities` / `gate` / `httpSecurity` 一并导出 —— `app-server.js` 复用
   **同一份**能力集与**同一个**授权闸（同一个进程里两套口径 = 一边堵一边漏）。 */
module.exports = {
  handleRequest, readProgress, writeProgress, countPending, decideCors, cors, PORT,
  capabilities, gate, httpSecurity, trustedOriginsFromEnv, ALLOW_FILE_ORIGIN,
};
