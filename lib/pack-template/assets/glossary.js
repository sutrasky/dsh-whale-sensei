/* ============================================================
   glossary.js — 名词悬停解释组件（可复用）
   依赖：glossary-data.js（window.GLOSSARY）+ glossary.css

   课程页写法：
     1) <link rel="stylesheet" href="../assets/glossary.css">
     2) 正文里给名词加 data-term="键名"：
          <span data-term="get">GET</span>
        同一个名词可以标很多次，本脚本会自动判断：
        · 文档中【第一个】带 data-term="get" 的元素 → 带下划线 + 悬停小窗
        · 【之后】的 → 自动降级为只有颜色（.term-ref），不再弹窗
     3) 页面底部引入：
          <script src="../assets/glossary-data.js"></script>
          <script src="../assets/glossary.js"></script>

   交互：鼠标放上去就弹出（默认 0.15 秒延迟，避免扫读时误触；按住 Ctrl 可跳过延迟）；
   键盘 Tab 聚焦也弹出。
   注意：不要在 <pre><code> 代码块里标名词，代码保持原样。
   ============================================================ */
(function () {
  'use strict';

  var DATA = window.GLOSSARY || {};
  var HOVER_DELAY = 150;   // 普通悬停延迟（毫秒）
  var HIDE_DELAY = 200;    // 离开名词后的宽限时间，够鼠标移进小窗

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var seen = Object.create(null);
    var marked = document.querySelectorAll('[data-term]');

    // ---- 1. 区分「第一次出现」和「后续出现」----
    Array.prototype.forEach.call(marked, function (el) {
      var key = el.getAttribute('data-term');
      if (!DATA[key]) {
        // 数据里没有这个词：退化成普通文本，避免出现"半成品"样式
        console.warn('[glossary] 未在 glossary-data.js 中定义的名词:', key);
        return;
      }
      if (seen[key]) {
        el.classList.add('term-ref');      // 后续出现：仅颜色
        el.removeAttribute('data-term');
        return;
      }
      seen[key] = true;
      el.classList.add('term');            // 第一次出现：下划线 + 小窗
      el.setAttribute('tabindex', '0');    // 键盘也能聚焦
      bindTooltip(el, DATA[key]);
    });

    // ---- 2. 小窗本体（全局只创建一个）----
    var tip = document.createElement('div');
    tip.id = 'glossary-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.innerHTML =
      '<div class="tip-head">' +
        '<span class="tip-label"></span>' +
        '<span class="tip-category"></span>' +
      '</div>' +
      '<p class="tip-official"></p>' +
      '<p class="tip-short"></p>' +
      '<p class="tip-analogy"></p>' +
      '<pre class="tip-code" hidden><code></code></pre>';
    document.body.appendChild(tip);

    var showTimer = null;
    var hideTimer = null;
    var current = null;

    function fill(info) {
      tip.querySelector('.tip-label').textContent = info.label;
      tip.querySelector('.tip-category').textContent = info.category || '';
      tip.querySelector('.tip-official').textContent = info.official || '';
      tip.querySelector('.tip-short').textContent = info.short || '';
      tip.querySelector('.tip-analogy').textContent = info.analogy || '';

      // ④ 规范写法：只有注解类等「有用法规范」的名词才有，没有就整块隐藏。
      // 用 textContent 而不是 innerHTML —— 代码里的 < > 必须原样显示。
      var codeWrap = tip.querySelector('.tip-code');
      codeWrap.querySelector('code').textContent = info.code || '';
      codeWrap.hidden = !info.code;
    }

    function place(anchor) {
      var a = anchor.getBoundingClientRect();
      var t = tip.getBoundingClientRect();
      var gap = 10;

      // 默认放在名词下方，下方空间不够就放到上方
      var top = a.bottom + gap;
      if (top + t.height > window.innerHeight - 8) {
        top = a.top - t.height - gap;
      }
      if (top < 8) top = 8;

      // 水平居中对齐名词，并夹在视口内
      var left = a.left + a.width / 2 - t.width / 2;
      var maxLeft = window.innerWidth - t.width - 10;
      if (left < 10) left = 10;
      if (left > maxLeft) left = maxLeft;

      tip.style.top = Math.round(top) + 'px';
      tip.style.left = Math.round(left) + 'px';
    }

    function show(anchor, info) {
      clearTimeout(hideTimer);
      fill(info);
      tip.classList.add('visible');
      anchor.classList.add('tip-open');
      place(anchor);
      current = anchor;
    }

    function hide() {
      tip.classList.remove('visible');
      if (current) current.classList.remove('tip-open');
      current = null;
    }

    function scheduleHide() {
      clearTimeout(showTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY);
    }

    function bindTooltip(el, info) {
      el.addEventListener('mouseenter', function (e) {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        // 按住 Ctrl 可跳过延迟；默认延迟一点点，避免扫读时"闪窗"
        var delay = e.ctrlKey || e.metaKey ? 0 : HOVER_DELAY;
        if (delay === 0) {
          show(el, info);
        } else {
          showTimer = setTimeout(function () { show(el, info); }, delay);
        }
      });

      el.addEventListener('mouseleave', scheduleHide);
      el.addEventListener('blur', scheduleHide);

      // 键盘可访问：聚焦即显示
      el.addEventListener('focus', function () { show(el, info); });

      // 名词本身被点击时不跳转，只保底显示一次
      el.addEventListener('click', function () { show(el, info); });
    }

    // 小窗自身被划过时不消失（方便阅读长句）
    tip.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    tip.addEventListener('mouseleave', scheduleHide);

    // 窗口变化时若小窗开着，重新定位
    window.addEventListener('resize', function () {
      if (current) place(current);
    });
    window.addEventListener('scroll', function () {
      if (current) place(current);
    }, true);

    // Esc 关掉
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hide();
    });
  });
})();
