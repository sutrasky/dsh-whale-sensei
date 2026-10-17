/* ============================================================
   session.js — 页面侧的**会话能力**（T07 / 报告 D02）
   ------------------------------------------------------------
   为什么要有它：独立服务的写口（提问 / 笔记 / 进度 / 课后调整）现在要求
   `X-Whale-Capability`。页面必须**先开一次会话**（`POST /api/session`）拿到令牌，
   再把令牌挂到每一次写请求上。这不是"前端自己加的一道锁"——
   服务端**不看 CORS 响应头**做授权（那正是 D02：恶意 Origin + text/plain 以前照样写盘）。

   契约（与 `tools/http-security.cjs` 同一份口径）：
     · 端点：`POST <base>/api/session`，体 `{ scope: 'reader' }`（缺省就是 reader）
     · 响应：`{ ok: true, token, exp, header: 'x-whale-capability' }`
     · 请求头：`X-Whale-Capability: <token>`
     · 令牌**绑来源**：换一个来源（换端口 / 换 host）就用不了 ⇒ 403，重新开会话即可。

   降级（**绝不静默**）：拿不到令牌时 `token` 是 null，调用方照旧发请求 ——
   服务会如实回 403，页面走既有的"服务不可达 → 剪贴板"那条路（闭环不断）。

   用法：
     <script src="{{PAGE_UP}}assets/session.js"></script>   <!-- 在 ask.js / notes.js 之前 -->
     window.WhaleSession.headers()      -> { 'X-Whale-Capability': '…' } 或 {}
     window.WhaleSession.token()        -> '…' 或 null
     window.WhaleSession.ensure()       -> Promise<token|null>（同一个会话只开一次）
     window.WhaleSession.refresh()      -> Promise<token|null>（强制重开，403 之后用）
   ============================================================ */
(function () {
  'use strict';

  var HEADER = 'X-Whale-Capability';

  /** 候选基址（**顺序与写法与 assets/ask.js / adjust.js / notes.js 完全一致**，不另立一套）：
   *   ① 宿主插件路由（DSH 交付的页面）
   *   ② 独立应用（tools/app-server.js，3091）：同源
   *   ③ 双击（file://）打开：回落到独立的答疑服务（8788）
   *  `file://` 那条路默认拿不到令牌（服务端不盲信 `null`），页面照旧走剪贴板兜底。 */
  function bases() {
    if (window.LESSON_ASK_ENDPOINT) return [window.LESSON_ASK_ENDPOINT];
    if (location.protocol === 'file:') return ['http://127.0.0.1:8788'];
    return [location.origin];
  }

  var pending = null;          // 同一个会话只开一次（并发调用共享同一个 promise）
  var current = { token: null, exp: 0, base: '' };

  function openSession(base) {
    var payload = JSON.stringify({ scope: 'reader' });
    return fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      credentials: 'omit'
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || data.ok !== true || !data.token) throw new Error('服务没有给出令牌');
      current = { token: String(data.token), exp: Number(data.exp) || 0, base: base };
      return current.token;
    });
  }

  /** 逐个基址试；全都不通就**如实**回 null（不编一个假令牌） */
  function ensure(force) {
    if (!force && current.token) return Promise.resolve(current.token);
    if (!force && pending) return pending;
    var list = bases().slice();
    pending = (function tryNext() {
      var base = list.shift();
      if (!base) return Promise.resolve(null);
      return openSession(base).catch(function () {
        return tryNext();
      });
    })();
    // 失败**不留缓存**：下一次调用要能重试（页面可能是先离线后上线）
    pending = pending.then(function (t) {
      if (!t) pending = null;
      return t;
    });
    return pending;
  }

  /** 挂到 fetch 上的请求头；拿不到令牌就回 `{}`（让服务端如实 403，页面走降级） */
  function headers() {
    if (!current.token) return {};
    var out = {};
    out[HEADER] = current.token;
    return out;
  }

  window.WhaleSession = {
    headerName: HEADER,
    ensure: ensure,
    refresh: function () { return ensure(true); },
    headers: headers,
    token: function () { return current.token; },
    exp: function () { return current.exp; },
    base: function () { return current.base; }
  };

  // 进页就开一次（不等第一次写操作 —— 那样第一个疑问要多等一个来回）。
  // 失败**不报错、不刷屏**：ensure() 自己吞掉网络错，调用方在真正要写时还会再试。
  ensure();
})();
