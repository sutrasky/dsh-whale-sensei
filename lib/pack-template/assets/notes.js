/**
 * notes.js — DSH 笔记前端交互（改版 v2）
 * ------------------------------------------------------------------
 * 渐进增强：
 *   ① 封面卡的 tilt/光泽效果（仅 hover:fine + pointer:fine 设备）
 *   ② 文档页笔记表单提交 → 优先 DSH 宿主的插件路由，回落 3091 独立应用的旧通道
 *      （候选顺序与写法同 assets/ask.js:31）
 *
 * 课程页不再有抽屉、不再有 Esc 关闭。
 * 文档页的 lesson 取自所在表单的 data-note-lesson（不再从 document.body 取）。
 *
 * 注意：前端**不做课次推导**：发出去的 `anchor` 就是 `data-note-lesson` 的显示名（`第N课`），
 *    归一成星图课次键是**写入口**的事（交接 §六 裁定）。两个入口都收同一个 body。
 */
(function () {
  'use strict';

  /* ── ① 封面卡 tilt/光泽 ──────────────────────────────────────────── */
  var inner = document.querySelector('.notes-card__inner');
  if (inner) {
    var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var hasFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    if (hasFinePointer && !prefersReducedMotion) {
      // 幅度加大：14 度（原 6 度）。参考物（爱丽丝的表情柜）hover 时还会抬升 6px、放大 3%、
      // 阴影加深 —— 这里一并补上抬升与缩放，让它读起来是"摇"而不是轻微倾斜。
      var maxTilt = 14;
      var LIFT = '-6px';
      var SCALE = '1.03';

      inner.addEventListener('pointermove', function (e) {
        var rect = inner.getBoundingClientRect();
        var x = (e.clientX - rect.left) / rect.width;
        var y = (e.clientY - rect.top) / rect.height;
        var rx = (0.5 - y) * maxTilt;
        var ry = (x - 0.5) * maxTilt;
        inner.style.setProperty('--tilt-rotate-x', rx + 'deg');
        inner.style.setProperty('--tilt-rotate-y', ry + 'deg');
        inner.style.setProperty('--tilt-glare-x', (x * 100) + '%');
        inner.style.setProperty('--tilt-glare-y', (y * 100) + '%');
        inner.style.setProperty('--tilt-glare-opacity', '1');
        inner.style.setProperty('--tilt-lift', LIFT);
        inner.style.setProperty('--tilt-scale', SCALE);
      });

      inner.addEventListener('pointerleave', function () {
        inner.style.setProperty('--tilt-rotate-x', '0deg');
        inner.style.setProperty('--tilt-rotate-y', '0deg');
        inner.style.setProperty('--tilt-glare-x', '50%');
        inner.style.setProperty('--tilt-glare-y', '50%');
        inner.style.setProperty('--tilt-glare-opacity', '0');
        inner.style.setProperty('--tilt-lift', '0px');
        inner.style.setProperty('--tilt-scale', '1');
      });
    }
  }

  /* ── ② 笔记提交（文档页表单）──────────────────────────────────────── */
  var noteForms = document.querySelectorAll('[data-note-form]');
  noteForms.forEach(function (form) {
    var noteInput = form.querySelector('[data-note-input]');
    var noteList = form.querySelector('[data-note-list]');
    var noteStatus = form.querySelector('[data-note-status]');
    var lesson = form.getAttribute('data-note-lesson') || '';

    if (!noteInput || !noteList) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = noteInput.value.trim();
      if (!text) return;

      // 先本地追加（乐观更新）
      var li = document.createElement('li');
      var time = document.createElement('time');
      time.textContent = new Date().toLocaleString('zh-CN');
      li.appendChild(time);
      li.appendChild(document.createTextNode(text));
      noteList.appendChild(li);

      noteInput.value = '';
      setStatus(noteStatus, '', '');

      // ── POST 到服务：候选**基址**，逐个试（写法与 assets/ask.js:27-31 逐行同形）──
      //   ① DSH 宿主的插件路由（跨站栅栏 + 认证由基座继承；台账正本 notes/notes.jsonl）
      //   ② 3091 独立应用的同源 /note（旧通道，记录形状已归一成与 ① 一致）
      //   ③ 双击（file://）打开页面 → 回落到独立的答疑服务 8788
      //
      // 注意 ③ 这条 ask.js:29-30 与 adjust.js:15-16 一直有，本文件 2026-09-24 接线时**漏了**：
      //    file:// 页面的 location.origin 是字符串 'null'，候选会变成 'null/api/whale/note'
      //    ⇒ 双击打开时答疑能用、**笔记用不了**。三条出口收的是同一个 body，不做形状分支。
      var BASES = window.LESSON_ASK_ENDPOINT
        ? [window.LESSON_ASK_ENDPOINT]
        : (location.protocol === 'file:'
          ? ['http://127.0.0.1:8788']
          : [location.origin + '/api/whale', location.origin]);
      var ENDPOINTS = BASES.map(function (b) { return { url: b + '/note', name: b + '/note' }; });
      var payload = JSON.stringify({ text: text, anchor: lesson });

      /* 会话能力（T07 / 报告 D02）：写口要 `X-Whale-Capability`（`assets/session.js` 开一次会话）。
         403（没令牌 / 令牌过期 / 来源变了）→ **重开一次会话**再发一遍 ——
         但**只在 403 上重试一次**：别的拒绝（400 等）绝不重试，否则会把同一条笔记写两遍。 */
      function sendOnce(i, retried) {
        return fetch(ENDPOINTS[i].url, {
          method: 'POST',
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            (window.WhaleSession && window.WhaleSession.headers) ? window.WhaleSession.headers() : {}
          ),
          body: payload
        }).then(function (r) {
          if (r.status === 403 && !retried && window.WhaleSession && window.WhaleSession.refresh) {
            return window.WhaleSession.refresh().then(function (token) {
              if (!token) return r;
              return sendOnce(i, true);
            });
          }
          return r;
        });
      }

      (function postNote(i) {
        if (i >= ENDPOINTS.length) {
          setStatus(noteStatus, '保存失败（服务不可达），笔记已保留在页面上', 'error');
          return;
        }
        sendOnce(i, false)
          .then(function (r) {
            if (!r.ok) {
              var e = new Error('HTTP ' + r.status);
              e.httpStatus = r.status;
              throw e;
            }
            return r.json();
          })
          .then(function (data) {
            if (data && data.ok) {
              setStatus(noteStatus, '已保存', '');
            } else {
              throw new Error((data && data.error) || '保存失败');
            }
          })
          .catch(function (err) {
            console.warn('[notes] ' + ENDPOINTS[i].name + ' 失败:', err);
            // 只在「这个入口不存在」时回落（网络不通 / 404 / 405）。
            // 后端**明确拒绝**（400 等）时绝不回落 —— 否则会把同一条笔记往下一个入口再写一遍
            var absent = !err || err.httpStatus === undefined || err.httpStatus === 404 || err.httpStatus === 405;
            if (absent) {
              postNote(i + 1);
            } else {
              setStatus(noteStatus, '保存失败：' + (err.message || '服务拒绝'), 'error');
            }
          });
      })(0);
    });
  });

  function setStatus(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.setAttribute('data-status', type || '');
  }
})();

/* ── 笔记页搜索 ───────────────────────────────────────────────────────────
   正文结构是 .notes-main > details.notes-doc（每课一个）> summary + h3 + 板块 + …，
   h3 不是 .notes-main 的直接子节点，所以按 h3 的**父容器**遍历。
   一条「条目」= 能独立命中的最小单元：名词 .notes-term / 答疑 .notes-qa；
   没有这类子条目的板块（我的笔记等）整块算一条 —— 只按 h3 切块的话，
   搜一个名词会把整个 19 条的名词表都留下，等于没筛。
   隐藏用内联 style.display 而不用 hidden 属性 —— hidden 会被 CSS 的
   display:flex/grid 覆盖。无 JS 时输入框由 <noscript> 隐藏，不留死控件。 */
(function () {
  var main = document.querySelector('.notes-main');
  var input = document.querySelector('.notes-search');
  if (!main || !input) return;

  var status = document.createElement('span');
  status.className = 'notes-search__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  input.parentNode.appendChild(status);

  var LEAF = '.notes-term, .notes-qa';
  var units = [];
  var total = 0;

  Array.prototype.forEach.call(main.querySelectorAll('h3'), function (head) {
    var groups = [];
    var n = head.nextElementSibling;
    while (n && !/^H[1-6]$/.test(n.tagName)) {
      var inner = (n.matches && n.matches(LEAF)) ? [n] : Array.prototype.slice.call(n.querySelectorAll(LEAF));
      var items = inner.length ? inner : [n];
      groups.push({ container: n, items: items });
      total += items.length;
      n = n.nextElementSibling;
    }
    units.push({ head: head, groups: groups, parent: head.parentElement });
  });

  function apply() {
    var q = (input.value || '').trim().toLowerCase();
    var hit = 0;
    units.forEach(function (u) {
      var kept = 0;
      u.groups.forEach(function (g) {
        var gKept = 0;
        g.items.forEach(function (it) {
          var ok = !q || it.textContent.toLowerCase().indexOf(q) !== -1;
          it.style.display = ok ? '' : 'none';
          if (ok) gKept++;
        });
        // 容器自己就是条目时不重复设置（结果一致）
        if (g.container !== g.items[0]) g.container.style.display = gKept ? '' : 'none';
        kept += gKept;
      });
      hit += kept;
      u.head.style.display = kept ? '' : 'none';
    });
    // 整课没有命中就把这一课（details）也收起，避免留下空壳
    var parents = [];
    units.forEach(function (u) { if (parents.indexOf(u.parent) === -1) parents.push(u.parent); });
    parents.forEach(function (p) {
      var any = false;
      units.forEach(function (u) { if (u.parent === p && u.head.style.display !== 'none') any = true; });
      if (p !== main) p.style.display = any ? '' : 'none';
    });
    status.textContent = q
      ? (hit ? '匹配 ' + hit + ' / ' + total + ' 条' : '没有匹配「' + input.value.trim() + '」')
      : '';
  }

  // 显式搜索：输入不再即时过滤，回车或点「搜索」才生效（避免"看着能点却没作用"）
  var bar = input.closest('.notes-top__search');
  var go = document.querySelector('.notes-search__go');
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { apply(); e.preventDefault(); }
    if (e.key === 'Escape') { input.value = ''; apply(); }
  });
  if (go) go.addEventListener('click', apply);

  // 搜索列的宽度与其右边界对齐主题切换浮层。浮层是 fixed、宽度随文案与断点变，
  // 只能在运行时实测写进内联 style；窄屏搜索独占整行，所以清掉宽度。
  function syncWidth() {
    var sw = document.querySelector('.theme-switch');
    if (!bar) return;
    if (sw && window.innerWidth > 900) {
      var w = Math.round(sw.getBoundingClientRect().width);
      bar.style.width = w ? w + 'px' : '';
    } else {
      bar.style.width = '';
    }
  }
  syncWidth();
  window.addEventListener('resize', syncWidth);
  // 首次调用可能早于字体就绪（.theme-switch 的宽度由中文按钮文案决定），
  // 那时量到的宽是 0 → 必须再在 load 和字体 ready 后各同步一次
  window.addEventListener('load', syncWidth);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncWidth);

  // 筛选生效时点导航链接会跳到被隐藏的标题上 → 先清筛选再让它跳
  var nav = document.querySelector('.notes-nav');
  if (nav) {
    nav.addEventListener('click', function (e) {
      if (!input.value) return;
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (a) { input.value = ''; apply(); }
    });
  }
})();