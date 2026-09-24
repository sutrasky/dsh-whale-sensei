#!/usr/bin/env node
/**
 * serve-static.js —— 课程工作区静态预览（零依赖）
 * ------------------------------------------------------------------
 * 用法:  node tools/serve-static.js [port]        默认 3098
 * 用途:  预览风格实物 assets/_style-sample.html、课程页 lessons/*.html、参考页 reference/*.html
 * 说明:  只是**开发用预览器**。上线走插件宿主的 route（见 LESSON-PLUGIN-PLAN §6），
 *        届时本文件退役；它不复用已搁置的 _starmap-proto/serve.mjs，因为那个根目录是别的。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 3098);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname);
  if (rel === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }
  let target = path.join(ROOT, rel);
  if (rel.endsWith('/')) target = path.join(target, 'index.html');
  if (!path.resolve(target).startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found: ' + rel);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('[serve-static] http://127.0.0.1:' + PORT + '/');
  console.log('  风格实物  http://127.0.0.1:' + PORT + '/assets/_style-sample.html');
  console.log('  课程页    http://127.0.0.1:' + PORT + '/lessons/0002-rest-api-crud.html');
});
