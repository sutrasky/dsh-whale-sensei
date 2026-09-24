/**
 * lesson-fs.js — 课程页的「默认全屏」（2026-09-21）
 * ------------------------------------------------------------------
 * 谁在用：从**星图**里打开的那一课 —— starmap 会给链接带 `?fs=1`
 *   （双击课程星、提示卡里的「进入这一课 →」、静态 SVG 里的课程星，三条路都带）。
 * 为什么不能"一开就全屏"：`requestFullscreen()` 需要**用户手势**，而被 `window.open`
 *   开出来的新文档自己没有激活态 → 首次调用一般会被拒。所以这里三级兜底：
 *     ① 有 `?fs=1` → 立刻试一次（部分环境允许）；
 *     ② 被拒 → 挂一次性 `pointerdown`/`keydown`：用户**第一次动鼠标**就进全屏
 *        （体感就是"打开就是全屏"，只是等一次点击）；
 *     ③ 一直没动静 → 右下角给一条**可点**的提示条（明说按 F 或点它）。
 * 另外：`F` 随时切换全屏；`Esc` 由浏览器自己退出（不拦）。控制台会打一行 `[lesson-fs] …`，
 *   排查时直接看它 —— 不许静默失败。
 * ⚠️ 只影响带 `?fs=1` 的打开方式：从文件树、书签、`file://` 直接开课程页**不受影响**。
 */
(function () {
  var want = false;
  try { want = new URLSearchParams(location.search).get('fs') === '1'; } catch (e) { want = false; }
  var root = document.documentElement;

  function log(msg) { try { console.log('[lesson-fs] ' + msg); } catch (e) {} }
  function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

  function enter() {
    if (root.requestFullscreen) return root.requestFullscreen();
    if (root.webkitRequestFullscreen) { root.webkitRequestFullscreen(); return Promise.resolve(); }
    return Promise.reject(new Error('这个浏览器没有全屏 API'));
  }
  function leave() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) { document.webkitExitFullscreen(); return Promise.resolve(); }
    return Promise.reject(new Error('这个浏览器没有退出全屏 API'));
  }
  function toggle() {
    return (isFs() ? leave() : enter()).then(function () {
      log(isFs() ? 'fullscreen=on' : 'fullscreen=off');
    });
  }

  var hinted = false;
  function hint() {
    if (hinted || isFs()) return;
    hinted = true;
    var bar = document.createElement('div');
    bar.setAttribute('role', 'note');
    // 令牌不写兜底色值（本项目铁律：组件层禁色值兜底）——令牌都在 theme.css 里，浅深各一份
    bar.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:60',
      'padding:8px 12px', 'border-radius:8px', 'cursor:pointer',
      'border:1px solid var(--dsw-alias-border-l2)',
      'background:var(--dsw-alias-bg-layer-1)',
      'color:var(--dsw-alias-label-primary)',
      'font:12px/1.6 system-ui,sans-serif',
    ].join(';');
    bar.textContent = '点这里（或按 F）全屏';
    bar.addEventListener('click', function () { bar.remove(); toggle().catch(function (e) { log('仍然被拒：' + e); }); });
    (document.body || root).appendChild(bar);
    log('被拒 → 已给出可点提示条');
  }

  if (want) {
    enter().then(function () { log('fullscreen=on（首次即成功）'); }).catch(function () {
      log('首次被拒（新窗口没有用户手势）→ 等第一次点击/按键');
      var once = function () {
        document.removeEventListener('pointerdown', once, true);
        document.removeEventListener('keydown', once, true);
        toggle().catch(function () { hint(); });
      };
      document.addEventListener('pointerdown', once, true);
      document.addEventListener('keydown', once, true);
      setTimeout(function () { if (!isFs()) hint(); }, 1200);   // 一直没动 → 明说怎么开
    });
  }

  document.addEventListener('fullscreenchange', function () { log(isFs() ? 'fullscreen=on' : 'fullscreen=off'); });
  document.addEventListener('webkitfullscreenchange', function () { log(isFs() ? 'fullscreen=on' : 'fullscreen=off'); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'f' && e.key !== 'F') return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;   // 别抢输入框里的 f
    e.preventDefault();
    toggle().catch(function () { hint(); });
  });
})();
