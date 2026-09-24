/* ============================================================
   ask.js — 疑问箱（可复用）
   依赖：ask.css、theme.css

   学生在这里写下疑问并提交。送达方式两条路（A+B 混合）：
     A. 本地收集服务：POST http://127.0.0.1:8788/ask
        问题直接落盘 questions/pending.jsonl，老师随即能读到
     B. 剪贴板降级：服务不在时，自动把疑问格式化成一段话复制到剪贴板，
        学生粘贴到对话里发给老师即可

   页面接入：
     <link rel="stylesheet" href="../assets/ask.css">
     ...
     <script src="../assets/ask.js"></script>

   可选：在 <body> 上写 data-ask-lesson="第1课" 显式指定课次；
        不写则从 <title> 里推断（"第1课：…" → "第1课"）。

   入口（§1 改造后）：页面里放一个 button[data-ask-open] 就行 —— ask.js 不再自己造
   右下角漂浮壳，只创建居中弹层（.ask-layer）并绑定页面上所有 data-ask-open 按钮。
   课程页那个按钮在左栏「DSH 笔记」卡片里（assets/_frame.html）。
   ============================================================ */
(function () {
  'use strict';

  // 端点**按序尝试**，两条部署路子都要能用：
  //   1) 宿主插件路由（DSH 交付的页面）：同源 /api/whale/ask —— 跨站栅栏与认证由基座继承
  //   2) 独立应用（tools/app-server.js，3091）：同源 /ask
  //   3) 用 file:// 直接开页面：回落到独立的答疑服务（8788）
  // 只写死一个的话，另一种部署方式会静默掉进剪贴板兜底（本仓库同时支持这两种跑法）。
  var ENDPOINTS = window.LESSON_ASK_ENDPOINT
    ? [window.LESSON_ASK_ENDPOINT]
    : (location.protocol === 'file:'
      ? ['http://127.0.0.1:8788']
      : [location.origin + '/api/whale', location.origin]);
  var DRAFT_KEY = 'lesson-ask-draft';
  var HISTORY_KEY = 'lesson-ask-history';

  // 页面自报身份优先：通过 GUI / 预览器打开时 location.pathname 会是路由 id（一串 UUID），
  // 记下来就没法定位是哪个文件。所以由页面在 <body data-ask-page> 上写死自己的路径。
  var pagePath = document.body.getAttribute('data-ask-page')
    || location.pathname.replace(/^.*[\\/]/, '');   // 退回文件名，便于老师定位
  var pageTitle = document.title || '';

  /** 课次：优先读 body[data-ask-lesson]，否则从标题 "第N课：xxx" 里取 */
  function lessonLabel() {
    var attr = document.body.getAttribute('data-ask-lesson');
    if (attr) return attr;
    var m = /第\s*[0-9一二三四五六七八九十]+\s*课/.exec(pageTitle);
    return m ? m[0].replace(/\s+/g, '') : '未标注课次';
  }

  /* ---------- 剪贴板：优先 clipboard API，退回 execCommand ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** 降级时给老师看的一段话，直接粘贴即可执行 */
  function formatForChat(question) {
    return [
      '【课程疑问提交】',
      '课次：' + lessonLabel(),
      '页面：' + pagePath,
      '标题：' + pageTitle,
      '疑问：' + question,
      '',
      '请按 lesson 技能处理：',
      '1) 把疑问登记到 assets/questions-data.js',
      '2) 在相关章节插入青紫色解答框（id="qNNNN"）',
      '3) 跑 build-questions.js 与 check-terms.js',
      '4) 告诉我解答在第几课哪一节'
    ].join('\n');
  }

  /* ---------- 本地留档：草稿 + 已提交记录 ---------- */
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 入口角标：本课「新答复」未读数（2026-09-24 主人定）----------
     数据源是**构建期烘进页面**的已答条数（卡片数字上那个 data-qa-count，由
     tools/build-lessons.js 的 countQA 填）。所以它不联网、不读台账：老师答完重建，
     数字一变角标就出现 —— 离线（双击 file:// 打开）也照样看得见，这正是
     "不必另开一页才知道有答复"的落点。

     "已读"由**学生的动作**定义：点卡片里那条去笔记页的链接即清零。
     不猜服务器状态（没有任何端点会返回"已答"条目），也不拿历史当新答复报账：
     第一次见到这一课只静默对齐水位，不弹数字。 */
  var SEEN_KEY = 'lesson-qa-seen';
  var NOTES_LINK = 'a.notes-card__link[href*="reference/NOTES.html"]';

  function badgeEl() {
    // 用 querySelectorAll 而不是 querySelector：Node 侧的 DOM 桩（ask-entry.test.mjs）只实现了前者
    return document.querySelectorAll('[data-ask-badge]')[0] || null;
  }

  /** 页面里烘着的已答条数；页面没有这个数字（老页面 / 别的页）→ null */
  function qaCountNow() {
    var el = document.querySelectorAll('[data-qa-count]')[0];
    if (!el) return null;
    var n = parseInt(el.getAttribute('data-qa-count'), 10);
    return isFinite(n) ? n : null;
  }

  /** 已读水位按**页面路径**记账：课次标签（第1课）在不同圆圈里会重名，路径才唯一 */
  function seenKey() { return pagePath || lessonLabel(); }

  function setBadge(n) {
    var el = badgeEl();
    if (!el) return;
    if (!n) { el.hidden = true; el.textContent = ''; return; }
    var tip = '本课有 ' + n + ' 条新答复 —— 点「打开完整笔记」查看';
    el.textContent = String(n);
    el.hidden = false;
    el.setAttribute('title', tip);
    el.setAttribute('aria-label', tip);
  }

  function markSeen() {
    var now = qaCountNow();
    if (now === null) return;
    var seen = readJSON(SEEN_KEY, {});
    seen[seenKey()] = now;
    writeJSON(SEEN_KEY, seen);
    setBadge(0);
  }

  function initBadge() {
    var now = qaCountNow();
    if (now === null) return;
    var seen = readJSON(SEEN_KEY, {});
    var was = seen[seenKey()];
    if (typeof was !== 'number' || was > now) {
      // 第一次见到这一课（或条目被删后重建）：静默对齐，不把历史当"新答复"报给学生
      seen[seenKey()] = now;
      writeJSON(SEEN_KEY, seen);
      setBadge(0);
    } else {
      setBadge(now - was);
    }
    Array.prototype.forEach.call(document.querySelectorAll(NOTES_LINK), function (a) {
      a.addEventListener('click', markSeen);
    });
  }

  /* ---------- 控件 ---------- */
  function build() {
    var layer = document.createElement('div');
    layer.className = 'ask-layer';
    layer.hidden = true;

    var backdrop = document.createElement('div');
    backdrop.className = 'ask-layer__backdrop';

    var panel = document.createElement('div');
    panel.className = 'ask-panel';
    panel.id = 'ask-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '提交疑问');
    // 问号用内联 SVG，不用装饰性 emoji（S5 补齐：S3 换页头时漏了这个控件）
    var ASK_ICON = '<svg class="ask-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.4"/>'
      + '<circle cx="12" cy="16.4" r=".9" fill="currentColor" stroke="none"/></svg>';
    panel.innerHTML =
      '<div class="ask-panel__head">' +
        '<span class="ask-panel__title">' + ASK_ICON + ' 有疑问？</span>' +
        '<span class="ask-panel__context"></span>' +
      '</div>' +
      '<textarea class="ask-panel__input" placeholder="写下你不懂的地方，越具体越好。例如：Bean 和 @Service 是什么关系？"></textarea>' +
      '<div class="ask-panel__foot">' +
        '<span class="ask-panel__hint">Ctrl + Enter 提交</span>' +
        '<button type="button" class="ask-panel__submit">提交</button>' +
      '</div>' +
      '<div class="ask-panel__status"></div>';

    layer.appendChild(backdrop);
    layer.appendChild(panel);
    document.body.appendChild(layer);

    var input = panel.querySelector('.ask-panel__input');
    var submit = panel.querySelector('.ask-panel__submit');
    var status = panel.querySelector('.ask-panel__status');
    var context = panel.querySelector('.ask-panel__context');

    context.textContent = lessonLabel();
    input.value = readJSON(DRAFT_KEY, '') || '';

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'ask-panel__status' + (kind ? ' is-' + kind : '');
    }

    var lastOpener = null;

    function open(from) {
      lastOpener = from || null;
      layer.hidden = false;
      if (lastOpener) lastOpener.setAttribute('aria-expanded', 'true');
      input.focus();
    }
    function close() {
      layer.hidden = true;
      if (lastOpener) {
        lastOpener.setAttribute('aria-expanded', 'false');
        lastOpener.focus();      // 焦点回到入口，键盘用户不丢位置
        lastOpener = null;
      }
    }

    // 入口是声明式的：页面写 button[data-ask-open]，ask.js 是唯一写状态的一方
    Array.prototype.forEach.call(document.querySelectorAll('[data-ask-open]'), function (btn) {
      btn.setAttribute('aria-controls', 'ask-panel');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () {
        if (layer.hidden) open(btn); else close();
      });
    });

    // 点遮罩、或点弹层四周留白 → 关闭
    backdrop.addEventListener('click', close);
    layer.addEventListener('click', function (e) {
      if (e.target === layer) close();
    });

    input.addEventListener('input', function () {
      writeJSON(DRAFT_KEY, input.value);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !layer.hidden) close();
    });

    input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });

    submit.addEventListener('click', send);

    function remember(question, how) {
      var history = readJSON(HISTORY_KEY, []);
      history.push({ at: new Date().toISOString(), lesson: lessonLabel(), page: pagePath, question: question, how: how });
      writeJSON(HISTORY_KEY, history.slice(-50));
    }

    function send() {
      var question = (input.value || '').trim();
      if (!question) {
        setStatus('先写点什么再提交吧。', 'warn');
        input.focus();
        return;
      }

      submit.disabled = true;
      setStatus('正在提交…');

      var payload = JSON.stringify({
        question: question,
        lesson: lessonLabel(),
        page: pagePath,
        title: pageTitle
      });

      var posted = false;
      // 依次尝试 ENDPOINTS：前一跳不通（404/网络错）就换下一跳；全都不通才走剪贴板
      var tries = ENDPOINTS.slice();
      function postOnce() {
        var base = tries.shift();
        return fetch(base + '/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).catch(function (err) {
          if (tries.length) return postOnce();
          throw err;
        });
      }
      var request = postOnce().then(function (data) {
        posted = true;
        submit.disabled = false;
        input.value = '';
        writeJSON(DRAFT_KEY, '');
        remember(question, 'server');
        setStatus('已提交' + (data && data.id ? '，编号 ' + data.id : '') +
          '。\n老师会在下一轮读取并解答；解答收在左栏「DSH 笔记」的答疑栏里（同步到文档页 reference/NOTES.html），按所属章节分组。', 'ok');
      }).catch(function () {
        // A 路不通 → B 路：复制到剪贴板
        return copyText(formatForChat(question)).then(function (ok) {
          submit.disabled = false;
          remember(question, 'clipboard');
          if (ok) {
            setStatus('本地收集服务没在运行，已把疑问复制到剪贴板。\n请直接粘贴到对话里发给我，我会照常解答。', 'warn');
          } else {
            setStatus('服务没在运行，剪贴板也不可用。请手动复制下面的内容发给我：\n\n' + formatForChat(question), 'warn');
          }
        });
      });

      return request;
    }

    return { open: open };
  }

  function init() {
    // 课程页才挂疑问箱；其它页面（如纯索引页）可用 data-ask="off" 关掉
    if (document.body.getAttribute('data-ask') === 'off') return;
    build();
    initBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
