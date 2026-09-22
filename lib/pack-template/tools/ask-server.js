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
 *   POST /ask     { question, lesson, page, title } → 追加到 questions/pending.jsonl
 *                 返回 { ok: true, id: "0003" }
 *   GET  /health  → { ok: true, pending: N, port: N }
 *   OPTIONS *     → CORS 预检（file:// 页面的 Origin 是 null，必须放行）
 *
 * 文件：
 *   questions/pending.jsonl  一行一条待处理疑问（append-only，不覆盖）
 *   questions/seq.txt        已发号，保证编号不重复
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'questions');
const PENDING = path.join(DIR, 'pending.jsonl');
const SEQ = path.join(DIR, 'seq.txt');
const NOTES_DIR = path.join(ROOT, 'notes');
const NOTES_JSONL = path.join(NOTES_DIR, 'notes.jsonl');
// 课次映射表：包侧唯一一份（`tools/lesson-map.js`），与插件 `lib/pack-model.js` 有一道对拍钉住
const { lessonMap, labelOfAnchor, keyOfAnchor } = require(path.join(__dirname, 'lesson-map.js'));
// 逐行剥 BOM（坑位见 tools/pack-text.js）—— 不剥的话带 BOM 的那一行会被静默滤掉
const { splitLines: splitNoteLines, stripBom } = require(path.join(__dirname, 'pack-text.js'));
const PROGRESS = path.join(ROOT, 'progress.json');                 // 学习进度（星图据此点亮）
const ADJUST_DIR = path.join(ROOT, 'learning-records');
const ADJUST = path.join(ADJUST_DIR, 'adjustments.jsonl');         // 课后调整（append-only）

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg !== -1 && args[portArg + 1] ? Number(args[portArg + 1]) : 8788;
const HOST = '127.0.0.1';
const MAX_BODY = 16 * 1024;      // 单条疑问上限 16KB，防滥用

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
function writeProgress(p) {
  fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2) + '\n', 'utf8');
}

function nextId() {
  let n = 0;
  try {
    // 必须剥掉 BOM：Number('\uFEFF1') 是 NaN，会掉进 || 0 把编号重置成 0001，
    // 于是下一个疑问跟已解答的撞号。
    n = Number(fs.readFileSync(SEQ, 'utf8').replace(/^\uFEFF/, '').trim()) || 0;
  } catch (e) { /* 第一次运行 */ }
  n += 1;
  fs.writeFileSync(SEQ, String(n), 'utf8');
  return String(n).padStart(4, '0');
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
const NOTE_SEQ = path.join(NOTES_DIR, 'seq.txt');

function readNoteSeq() {
  let n = 0;
  try {
    // 必须剥 BOM：Number('\uFEFF3') 是 NaN → 会掉进 || 0 把编号重置，与已写的撞号
    n = Number(fs.readFileSync(NOTE_SEQ, 'utf8').replace(/^\uFEFF/, '').trim()) || 0;
  } catch (e) { /* first run */ }
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeNoteSeq(n) {
  fs.writeFileSync(NOTE_SEQ, String(n) + '\n', 'utf8');   // 与 notes-io 的写法一致（带换行）
}

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function handleRequest(req, res) {
  decideCors(req, res);   // 入口定一次：谁有资格拿 CORS 头（见上面那段）
  const url = new URL(req.url, 'http://' + HOST);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, pending: countPending(), port: PORT });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/progress') {
    const p = readProgress();
    json(res, 200, { ok: true, learned: p.learned, lit: p.learned.length });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/progress') {
    let body = '';
    let tooBig = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (tooBig) {
        json(res, 413, { ok: false, error: '内容太长了，请精简到 16KB 以内' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        json(res, 400, { ok: false, error: 'JSON 解析失败' });
        return;
      }

      const lesson = String(payload.lesson || '').trim();
      if (!lesson) {
        json(res, 400, { ok: false, error: '缺 lesson（进度要记在哪一课上）' });
        return;
      }

      const adjust = String(payload.adjust || '').trim();
      const p = readProgress();
      if (payload.done !== false && p.learned.indexOf(lesson) === -1) p.learned.push(lesson);
      writeProgress(p);

      if (adjust) {
        fs.appendFileSync(ADJUST, JSON.stringify({
          ts: new Date().toISOString(),
          lesson,
          title: String(payload.title || ''),
          adjust,
        }) + '\n', 'utf8');
      }

      json(res, 200, { ok: true, learned: p.learned, lit: p.learned.length, adjustSaved: !!adjust });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ask') {
    let body = '';
    let tooBig = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (tooBig) {
        json(res, 413, { ok: false, error: '问题太长了，请精简到 16KB 以内' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (e) {
        json(res, 400, { ok: false, error: 'JSON 解析失败' });
        return;
      }

      const question = String(payload.question || '').trim();
      if (!question) {
        json(res, 400, { ok: false, error: '疑问内容为空' });
        return;
      }

      const id = nextId();
      const record = {
        id: id,
        at: new Date().toISOString(),
        lesson: String(payload.lesson || '').slice(0, 60),
        page: String(payload.page || '').slice(0, 200),
        title: String(payload.title || '').slice(0, 200),
        question: question.slice(0, 4000),
        status: 'pending'
      };

      fs.appendFileSync(PENDING, JSON.stringify(record) + '\n', 'utf8');
      console.log('[ask] 收到 #' + id + ' · ' + record.lesson + ' · ' +
        question.slice(0, 40).replace(/\s+/g, ' ') + (question.length > 40 ? '…' : ''));

      json(res, 200, { ok: true, id: id });
    });

    return;
  }

  if (req.method === 'POST' && url.pathname === '/note') {
    let body = '';
    let tooBig = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (tooBig) {
        json(res, 413, { ok: false, error: '笔记太长了，请精简到 16KB 以内' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(stripBom(body) || '{}');
      } catch (e) {
        json(res, 400, { ok: false, error: '请求体不是 JSON' });
        return;
      }

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

      const seq = readNoteSeq() + 1;
      const id = String(seq).padStart(4, '0');

      // 只追加不覆盖：id 撞车就拒（与 appendNote 同规矩）
      let cur = '';
      try { cur = fs.readFileSync(NOTES_JSONL, 'utf8'); } catch (e) { /* 台账还不存在 */ }
      const clash = splitNoteLines(cur).filter((l) => l.trim()).some((l) => {
        try { return String(JSON.parse(l).id) === id; } catch (e) { return false; }
      });
      if (clash) {
        json(res, 400, { ok: false, error: 'id ' + id + ' 已存在（seq.txt 落后于台账？）：只追加不覆盖' });
        return;
      }

      const record = { id: id, seq: seq, kind: '笔记', anchor: key, text: text };
      if (date !== undefined) record.date = String(date);

      // 上一行没有收尾换行就先补一个（与 notes-io 的 `had` 逻辑一致，免得两条粘成一行）
      const prefix = cur.length > 0 && !cur.endsWith('\n') ? '\n' : '';
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      fs.appendFileSync(NOTES_JSONL, prefix + JSON.stringify(record) + '\n', 'utf8');
      writeNoteSeq(seq);
      console.log('[note] 收到 #' + id + ' · ' + key + ' · ' +
        text.slice(0, 40).replace(/\s+/g, ' ') + (text.length > 40 ? '…' : ''));

      json(res, 200, { ok: true, id: id, seq: seq, hasDate: date !== undefined });
    });

    return;
  }

  if (req.method === 'GET' && url.pathname === '/notes') {
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
   CORS 的决定只许住在**这一处**，别的文件沿用，不许再写一份。 */
module.exports = { handleRequest, readProgress, writeProgress, countPending, decideCors, cors, PORT };
