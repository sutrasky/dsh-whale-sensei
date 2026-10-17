#!/usr/bin/env node
/**
 * app-server.js — 课程包"一个端口"服务（默认 3091）
 * ------------------------------------------------------------------
 * 启动： node tools/app-server.js            （默认 127.0.0.1:3091）
 *        node tools/app-server.js 3092
 *
 * 它 = **静态页**（课程页 / 参考页 / 星图）+ **答疑·笔记·进度 API**，同源同端口。
 *
 * 为什么合并（2026-09-20）：
 *   ① 计划里就是"D-SH 课程服务跑 3091，与 DSH 的 3090 并行"；
 *   ② 合并后页面与接口**同源** → 页面里的 ask/progress 直接用 `location.origin`：
 *      不用绝对 URL、不用 CORS、不用两套降级；
 *   ③ "独立窗口（像 DSH 的 --app）"要一个稳定的入口 URL，两个端口不好指。
 *
 * 旧的两个工具**仍然可用**（`tools/serve-static.js` / `tools/ask-server.js`）——
 * 走 `file://` 直接开页面时还要靠它们；本文件只是把两者拼在一个端口上。
 *
 * 路由：
 *   /api/session /ask /note /notes /progress /health  → 交给 ask-server 的处理器
 *   其余                                             → 静态文件（**只读公开资源**，见下）
 *
 * `/health`（T15 / 报告 A03）：由**本文件**自己答（ask-server 那个会报它自己的端口 8788），
 *   响应带**身份信封** `protocol` / `packId` / `engineDigest` —— 宿主只认"同包 + 同协议 + 同引擎"
 *   的服务，**不许**拿"有东西答 200"当身份。见下面的常量段。
 *
 * 授权（T07 / 报告 D02）：写 / 私人读口（`/ask` `/note` `/notes` `/progress`）跨源要
 *   `X-Whale-Capability`；会话口 `POST /api/session` 只给可信来源发令牌。
 *   判定**不在这里**：一律走 `tools/http-security.cjs`（`api.capabilities` 是**同一个**能力集，
 *   `api.gate()` 是**同一个**闸 —— 一个进程里两套口径就是一边堵一边漏）。
 *
 * 静态边界（T06 / 报告 D03）：一律走 `tools/public-files.cjs` 的 `resolvePublicFile()` ——
 * 只解一次百分号编码、公开清单（受信资源清单 + 课程产物索引）、字面分量 + realpath 真身边界。
 * 原先那两道 `path.join` + `startsWith(ROOT)` 字符串判断**已经删掉**：它们挡不住同名前缀兄弟目录、
 * 编码分隔符和软链 / 目录联接，而且把整个包根当成了公开根（源课 / 学生代码 / 私人原账都能读走）。
 * 判据：`test/audit/T06.mjs`。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const api = require('./ask-server.js');
const { requestUrl, withRequestBoundary } = require('./http-request.cjs');
const { resolvePublicFile } = require('./public-files.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 3091);
const HOST = '127.0.0.1';

/* ── 健康响应里的**身份信封**（T15 / 报告 A03）────────────────────────────────
 *
 * 为什么要有它：宿主「进入课程包」原本只探「`GET /health` 答 200 吗」——
 * 于是**任何一个**在 3091 上答 200 的东西（别的包的服务、随便一个桩、上一版留下的
 * 老服务）都会被当成"这个包的服务"直接复用：地址栏指向 A，页面却是 B 的内容。
 * 200 只是"有东西在答"，**不是身份**。
 *
 * 信封三字段（与既有字段 `ok`/`port`/`pending` **并存**，一个都不删）：
 *   · `protocol`  —— 信封协议版本，整数；宿主只认 `1`
 *   · `packId`    —— `sha256(realpath(ROOT)).slice(0,16)`：**按包根的真身路径**算，
 *                    **不是** `path.basename(ROOT)` —— 两台机器上同名的两个包会撞
 *                    （`ask-server.js` 那份 basename 口径只服务能力令牌，别动它）
 *   · `engineDigest` —— 引擎闭包摘要：`digestOfManifest(buildManifest(ROOT).files)`，
 *                    与宿主 `lib/engine.js#verifyEngine(root, trustedManifest()).digest`
 *                    **同一口径**（同一份 `tools/engine-policy.cjs`）。
 *
 * 反空转：三个字段都必须是**真值** —— 任何一件算不出来就**不许**回 `ok:true` 的假身份
 * （如实回 500 + `identityError`），由调用方按"没有合法身份"处理。
 */
const WHALE_HEALTH_PROTOCOL = 1;

/** 包身份：**真身路径**的 SHA-256 前 16 位（算不出来就是空串 —— 别编一个） */
const PACK_ID = (() => {
  try {
    return crypto.createHash('sha256').update(fs.realpathSync(ROOT), 'utf8').digest('hex').slice(0, 16);
  } catch (e) {
    return '';
  }
})();

/**
 * 引擎闭包摘要：进程内**算一次并缓存**（`/health` 每次回同一个值）。
 * 算不出来（比如包里没有 `tools/engine-policy.cjs` —— 离线骨架里就没有）时**不缓存失败**，
 * 返回 `{digest:'', error:'…'}` 让调用方如实回"没有合法身份"。
 * @returns {{digest:string, error:string}}
 */
let engineDigestCache = null;
function engineIdentity() {
  if (engineDigestCache) return engineDigestCache;
  try {
    const policy = require('./engine-policy.cjs');
    const digest = policy.digestOfManifest(policy.buildManifest(ROOT).files);
    if (!digest) return { digest: '', error: '引擎闭包摘要算出来是空的' };
    engineDigestCache = { digest, error: '' };
    return engineDigestCache;
  } catch (e) {
    return { digest: '', error: `算不出引擎闭包摘要（${e && e.message ? e.message : e}）` };
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const API_PATHS = new Set(['/ask', '/note', '/notes', '/progress', '/api/session']);

/** /health 由本文件自己答 —— ask-server 里那个会报**它自己的**端口（8788），在这个组合里是错的
 *
 * T15：响应里带**身份信封**（`protocol` / `packId` / `engineDigest`，见文件头）。
 * 身份不全（算不出真身路径 / 算不出引擎摘要）⇒ **500 + `ok:false` + `identityError`**：
 * 绝不拿"有东西在答 200"冒充"这个包的服务"。
 */
function health(res) {
  const ident = engineIdentity();
  const identity = { protocol: WHALE_HEALTH_PROTOCOL, packId: PACK_ID, engineDigest: ident.digest };
  const okIdentity = PACK_ID !== '' && ident.digest !== '';
  const body = JSON.stringify(okIdentity
    ? { ok: true, port: PORT, pending: api.countPending(), ...identity }
    : {
      ok: false,
      port: PORT,
      ...identity,
      identityError: PACK_ID === '' ? '算不出包根的真身路径（packId）' : ident.error,
    });
  // ⚠️ CORS 头**不许在这里再写一份**：原先是硬编码 `access-control-allow-origin: '*'`，
  //    2026-09-24 收窄 CORS 时它就是漏掉的第二处（被现场 HTTP 探针抓出来的）。
  //    决定只住在 ask-server.js 的 decideCors，这里沿用同一条；注意 setHeader 必须在 writeHead 之前。
  api.cors(res);
  res.writeHead(okIdentity ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * 静态分支：**只读公开资源**（T06 / 报告 D03）。
 *
 * 原先这里是 `path.join(ROOT, rel)` + `path.resolve(target).startsWith(ROOT)` 两道字符串判断 ——
 * 那两条都不够（同名前缀兄弟目录能过、软链 / 目录联接能过、包根整个被当公开根）。
 * 现在边界只有一处：`tools/public-files.cjs` 的 `resolvePublicFile()` ——
 * 只解一次百分号编码 → 公开清单（受信资源清单 + 课程产物索引）→
 * 字面分量边界 + realpath 真身边界（T03 的共享路径策略）。
 */
async function serveStatic(req, res) {
  const url = requestUrl(req, false);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  const hit = resolvePublicFile(ROOT, url.pathname, { profile: 'reader' });
  if (hit.status !== 200) {
    // 作者态源文件（lessons/src/*.html）**不是课程页**：外壳（head / 样式表 / 导航 / 笔记卡）
    // 由 tools/build-lessons.js 生成，所以浏览器里直接打开它只有纯文本 —— 这是预期，不是坏了。
    // 2026-09-21 实测：`/lessons/src/1001-vue-render-http-data.html` 被当成课程页打开 →
    // "风格完全没加载"的假故障。这里不 404、也不再原样吐它，改为给一张**指路页**，
    // 把这个坑变成自动纠正（产物不存在时明说先构建）。
    // ⚠️ 这张指路页**不读源文件**（它由本文件现场拼出来）：源课一个字节都不出网。
    // ⚠️ 只在**整段形状**对得上时给（`/lessons/src/<一个文件名>.html`）—— 嵌套 / 编码过的
    //    路径一律走下面的拒绝分支，不靠"看起来像"放行。
    const srcAuthor = /^\/lessons\/src\/([^/]+\.html)$/.exec(url.pathname);
    if (srcAuthor) {
      const built = `/lessons/${srcAuthor[1]}`
      const hasBuilt = fs.existsSync(path.join(ROOT, 'lessons', srcAuthor[1]))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        [
          '<!DOCTYPE html>',
          '<html lang="zh-CN"><head><meta charset="UTF-8">',
          '<title>这是作者态源文件，不是课程页</title></head><body>',
          '<h1>这是作者态源文件（lessons/src/），不是课程页</h1>',
          '<p>课程页的外壳（head / 样式表 / 导航 / 笔记卡）由 <code>tools/build-lessons.js</code> 生成 —— ',
          '所以浏览器里直接打开这个文件只有纯文本、没有样式，这是<strong>预期</strong>的，不是页面坏了。</p>',
          hasBuilt
            ? `<p>要看渲染好的课程页：<a href="${built}">${built}</a></p>`
            : `<p>构建产物还不存在：先跑 <code>node tools/build-lessons.js</code>。</p>`,
          '</body></html>',
        ].join('\n')
      )
      return
    }
    const code = hit.status === 403 ? 403 : 404
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end((code === 403 ? 'forbidden: ' : 'not found: ') + (hit.error || url.pathname));
    return;
  }
  const buf = await fs.promises.readFile(hit.file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(hit.file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/** 请求处理器（导出出来是为了**能行为化地测**它，不是只给 node 直接跑用） */
function requestHandler(req, res) {
  const url = requestUrl(req, false);
  api.decideCors(req, res);   // CORS 的决定只住在 ask-server.js 一处，本文件沿用同一条
  // T06 static resolver retains its 403 rejection contract; API encoding errors are 400.
  if (url.pathname === '/health') { requestUrl(req); return health(res); }
  if (API_PATHS.has(url.pathname)) { requestUrl(req); return api.handleRequest(req, res); }
  return serveStatic(req, res);
}

const handler = withRequestBoundary(requestHandler);
const server = http.createServer(handler);

// 被 require 时**不要自己 listen**（与 ask-server.js 同一条约定）—— 测试要能驱动 handler
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('[app-server] 已启动: http://' + HOST + ':' + PORT);
    console.log('  星图     http://' + HOST + ':' + PORT + '/starmap/');
    console.log('  课程页   http://' + HOST + ':' + PORT + '/lessons/0002-rest-api-crud.html');
    console.log('  风格实物 http://' + HOST + ':' + PORT + '/assets/_style-sample.html');
    console.log('  接口     /ask /note /notes /progress /health（与页面同源）');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[app-server] 端口 ' + PORT + ' 已被占用 —— 可能已经开着了。');
      console.error('[app-server] 直接访问 http://' + HOST + ':' + PORT + '/ 即可；或换端口：node tools/app-server.js 3092');
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { handler, health, API_PATHS, PORT, capabilities: api.capabilities, gate: api.gate };
