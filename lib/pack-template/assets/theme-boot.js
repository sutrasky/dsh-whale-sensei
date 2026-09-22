/* ============================================================
   theme-boot.js — 首屏前的主题引导（防闪白）
   用法：作为 <body> 里的【第一个】元素同步引入，不能加 defer/async：

       <body>
       <script src="../assets/theme-boot.js"></script>
       ...页面内容...
       <script src="../assets/glossary-data.js"></script>
       <script src="../assets/glossary.js"></script>
       <script src="../assets/quiz.js"></script>
       <script src="../assets/theme.js"></script>
       </body>

   为什么必须内联在 body 开头：它在浏览器画出第一帧【之前】就把调色板定好。
   放到页面底部（和 theme.js 一起）会先按浅色画一帧再切深色，也就是常说的"闪白"。

   这段逻辑对应 DSH 主题插件的 bootThemeScript：
   解析 system、写 colorScheme 与 data-ds-dark-theme 两个字段。
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'lesson-theme-preference';   // 对应 DSH 的 ui-theme.preference
  var VALID = ['light', 'dark', 'system'];

  var preference = 'system';
  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (VALID.indexOf(stored) !== -1) preference = stored;
  } catch (e) {
    // 隐私模式等场景读不到 localStorage：退回默认 system，不影响渲染
  }

  var dark = preference === 'dark' || (preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  if (document.body) document.body.toggleAttribute('data-ds-dark-theme', dark);

  // 改版 v2：笔记卡改为小封面卡 + 文档页，不再有窄屏抽屉。
  // 旧版的 JS 标记（控制抽屉可见性）已不再需要，已删除。

  // 交给 theme.js 复用，避免两处各写一份存储键
  window.LESSON_THEME = {
    storageKey: STORAGE_KEY,
    valid: VALID,
    preference: preference,
    dark: dark
  };
})();