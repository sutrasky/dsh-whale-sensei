/* ============================================================
   theme.js — 外观切换控件 + 系统偏好跟随（可复用）
   依赖：theme.css（样式）、theme-boot.js（首屏前已定好初始值）

   实现参照 DeepSeek Harness Web 客户端主题插件
   （@deepseek-ai/dsh-client-ui-theme）：
   · 偏好三态 light / dark / system，默认 system
   · system 由 matchMedia('(prefers-color-scheme: dark)') 解析
   · 结果写 documentElement.style.colorScheme 与 body[data-ds-dark-theme]
   · 选中态跟随「已保存的偏好」，不是解析后的实际明暗
   · 偏好为 system 时，监听系统明暗切换并实时跟随

   与 DSH 的唯一差别是持久化位置：DSH 写入宿主设置（settings.yaml），
   静态课程页用 localStorage（file:// 下每个页面各自保管，属预期行为）。
   ============================================================ */
(function () {
  'use strict';

  var boot = window.LESSON_THEME || {};
  var STORAGE_KEY = boot.storageKey || 'lesson-theme-preference';
  var VALID = boot.valid || ['light', 'dark', 'system'];

  var MEDIA_QUERY = '(prefers-color-scheme: dark)';
  var mq = typeof matchMedia !== 'undefined' ? matchMedia(MEDIA_QUERY) : null;

  /* ---------- 三态定义：与 DSH 的 CUBES 顺序一致（浅色 / 深色 / 跟随系统） ---------- */
  var OPTIONS = [
    {
      id: 'light',
      label: '浅色',
      icon: '<circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1"/>'
    },
    {
      id: 'dark',
      label: '深色',
      icon: '<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.9 5.9 0 1 0 7.1 7.1z"/>'
    },
    {
      id: 'system',
      label: '跟随系统',
      icon: '<rect x="1.6" y="2.6" width="12.8" height="8.6" rx="1.2"/><path d="M5.6 14.2h4.8M8 11.2v3"/>'
    }
  ];

  function readStored() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (VALID.indexOf(stored) !== -1) return stored;
    } catch (e) { /* 读不到就用默认 */ }
    return 'system';
  }

  function resolveDark(preference) {
    if (preference === 'dark') return true;
    if (preference === 'light') return false;
    return !!(mq && mq.matches);
  }

  /** 把偏好落到 DOM：两个字段的写法和 DSH 完全一致 */
  function applyTheme() {
    var dark = resolveDark(preference);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.body.toggleAttribute('data-ds-dark-theme', dark);
  }

  function persist(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* 存不了也不影响本次会话 */ }
  }

  var preference = boot.preference || readStored();

  /* ---------- 控件 ---------- */
  var buttons = [];

  function renderSwitch() {
    var wrap = document.createElement('div');
    wrap.className = 'theme-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', '外观');

    OPTIONS.forEach(function (option) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-switch__btn';
      btn.dataset.preference = option.id;
      btn.setAttribute('aria-pressed', String(option.id === preference));
      btn.title = option.label;
      btn.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true">' + option.icon + '</svg>' +
        '<span class="theme-switch__label">' + option.label + '</span>';
      btn.addEventListener('click', function () {
        // 点击后固定偏好：从此不再跟随系统，除非再点回「跟随系统」
        preference = option.id;
        persist(preference);
        applyTheme();
        syncSwitch();
      });
      buttons.push(btn);
      wrap.appendChild(btn);
    });

    document.body.insertBefore(wrap, document.body.firstChild);
  }

  /** 选中态只反映已保存的偏好，不反映当前实际明暗 */
  function syncSwitch() {
    buttons.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.preference === preference));
    });
  }

  /* ---------- 跟随系统：只在偏好为 system 时生效 ---------- */
  function watchSystem() {
    if (!mq) return;
    var onFlip = function () {
      if (preference === 'system') applyTheme();
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onFlip);
    else if (typeof mq.addListener === 'function') mq.addListener(onFlip); // 老浏览器
  }

  /* ---------- 同一个 origin 的多个页面之间同步 ---------- */
  function watchStorage() {
    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY) return;
      if (VALID.indexOf(e.newValue) === -1) return;
      preference = e.newValue;
      applyTheme();
      syncSwitch();
    });
  }

  function init() {
    applyTheme();          // boot 已经设过，这里覆盖「非首屏」场景（如 DOM 后加载）
    renderSwitch();
    watchSystem();
    watchStorage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 便于在控制台调试：LessonTheme.set('dark')
  window.LessonTheme = {
    get: function () { return preference; },
    resolved: function () { return resolveDark(preference) ? 'dark' : 'light'; },
    set: function (value) {
      if (VALID.indexOf(value) === -1) return false;
      preference = value;
      persist(preference);
      applyTheme();
      syncSwitch();
      return true;
    }
  };
})();
