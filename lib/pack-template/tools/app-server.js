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
 *   /ask /note /notes /progress /health  → 交给 ask-server 的处理器
 *   其余                                 → 静态文件（带目录穿越防护）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./ask-server.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 3091);
const HOST = '127.0.0.1';

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

const API_PATHS = new Set(['/ask', '/note', '/notes', '/progress']);

/** /health 由本文件自己答 —— ask-server 里那个会报**它自己的**端口（8788），在这个组合里是错的 */
function health(res) {
  const body = JSON.stringify({ ok: true, port: PORT, pending: api.countPending() });
  // ⚠️ CORS 头**不许在这里再写一份**：原先是硬编码 `access-control-allow-origin: '*'`，
  //    2026-09-24 收窄 CORS 时它就是漏掉的第二处（被现场 HTTP 探针抓出来的）。
  //    决定只住在 ask-server.js 的 decideCors，这里沿用同一条；注意 setHeader 必须在 writeHead 之前。
  api.cors(res);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://' + HOST);
  const rel = decodeURIComponent(url.pathname);
  if (rel === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  let target = path.join(ROOT, rel);
  if (rel.endsWith('/')) target = path.join(target, 'index.html');
  if (!path.resolve(target).startsWith(ROOT)) {          // 目录穿越防护
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  // 作者态源文件（lessons/src/*.html）**不是课程页**：外壳（head / 样式表 / 导航 / 笔记卡）
  // 由 tools/build-lessons.js 生成，所以浏览器里直接打开它只有纯文本 —— 这是预期，不是坏了。
  // 2026-09-21 实测：`/lessons/src/1001-vue-render-http-data.html` 被当成课程页打开 →
  // "风格完全没加载"的假故障。这里不 404、也不再原样吐它，改为给一张**指路页**，
  // 把这个坑变成自动纠正（产物不存在时明说先构建）。
  const srcAuthor = /^\/lessons\/src\/([^/]+\.html)$/.exec(rel);
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
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',                       // 本地工具：永远拿最新的
    });
    res.end(buf);
  });
}

/** 请求处理器（导出出来是为了**能行为化地测**它，不是只给 node 直接跑用） */
function handler(req, res) {
  const url = new URL(req.url, 'http://' + HOST);
  api.decideCors(req, res);   // CORS 的决定只住在 ask-server.js 一处，本文件沿用同一条
  if (url.pathname === '/health') return health(res);
  if (API_PATHS.has(url.pathname)) return api.handleRequest(req, res);
  return serveStatic(req, res);
}

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

module.exports = { handler, health, API_PATHS, PORT };
