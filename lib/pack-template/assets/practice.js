/**
 * practice.js — 课程页的「实践区」：把完成度回显到页面上（学生侧只读）
 * ------------------------------------------------------------------
 * 设计要点（按 `_plugin-prep/practice-侦察.md` 的方案 ①）：
 *   · 课程页是**静态文件**，读不到插件的内存 ⇒ 数据必须落成一份文件 ——
 *     `assets/practice-data.js`（由插件工具 `whale_practice` 生成，跟 glossary-data.js 同一套路子）
 *   · 本脚本**运行时自渲染**：页面里就写着完整课 id（`<details class="adjust" data-lesson="…">`），
 *     拿它去 PRACTICE_DATA 里找这一课。**2026-09-24 D2-a 起键就是课 id** ——
 *     以前按"课号"查（`1`），两个圈各有 `0001` 时会串课
 *   · **找不到数据就不显示**（不猜、不占位）
 *   · 无 JS 时由 frame 里的 <noscript> 指路（去看 learning-records/state.json）
 *
 * 边界（照计划里的 A 方案）：插件**不执行学生代码**，这里只回显探针扫出来的静态事实结论。
 * 样式一律**复用现成类**（stack-xs / alert alert-info）—— 不新增 CSS 文件、不写死颜色
 * （否则要动 style-check / check-classes 那几处清单，改动面反而更大）。
 * 本文件里**不许出现 emoji**（课程包的 UI 层规则，详见 tools/a11y-print.test.mjs）。
 */
(function () {
  'use strict';

  /** 页面自报的完整课 id（`<details class="adjust" data-lesson="spring-boot/0001">`） */
  function lessonId() {
    var el = document.querySelector('[data-lesson]');
    return el ? String(el.getAttribute('data-lesson') || '') : '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 三态：done / todo / review —— 与插件输出一一对应 */
  var LABEL = { done: '已达成', todo: '未达成', review: '需人工确认' };

  function challengeLi(c) {
    var parts = ['<li><strong>第' + esc(c.no) + '题</strong>'];
    // 产出优先显示 —— 挑战本身就该有明确的产出（学生知道要做成什么，检查也容易）
    if (c.deliverable) {
      parts.push(' —— 产出：<strong>' + esc(c.deliverable) + '</strong>');
      if (c.hint) parts.push('　<span>（' + esc(c.hint) + '）</span>');
    } else if (c.hint) {
      parts.push('：' + esc(c.hint));
    }
    parts.push('　→ <strong>' + esc(LABEL[c.state] || c.state) + '</strong>');
    if (c.state === 'todo' && c.missing && c.missing.length) {
      parts.push('<br>还差：' + esc(c.missing.join('；')));
    } else if (c.state === 'review' && c.why && c.why !== c.hint && c.why !== c.deliverable) {
      parts.push('<br>' + esc(c.why));
    }
    parts.push('</li>');
    return parts.join('');
  }

  function render(zone, d) {
    var s = d.summary || { achieved: 0, total: 0, needsReview: 0 };
    var head =
      '<p><strong>实践区</strong>：这课的挑战' +
      '达成 ' + esc(s.achieved) + ' / 共 ' + esc(s.total) +
      (s.needsReview ? '（另有 ' + esc(s.needsReview) + ' 项需人工确认）' : '') +
      '。判定依据来自你机器上的代码（探针扫的静态事实），<strong>不跑你的代码</strong>。</p>';
    var lis = (d.challenges || []).map(challengeLi).join('');
    zone.innerHTML =
      '<div class="alert alert-info stack-xs">' +
      head +
      '<ul>' + lis + '</ul>' +
      '<p class="stack-xs">判据写在 <code>' + esc(d.expect || '该项目的 EXPECT.json') + '</code>；' +
      '学生现状的完整台账在 <code>learning-records/state.json</code>（由插件生成）。</p>' +
      '</div>';
    zone.hidden = false;
  }

  function boot() {
    var zone = document.getElementById('practice-zone');
    if (!zone) return;
    var all = window.PRACTICE_DATA;
    if (!all || !all.lessons) return; // 没有数据：保持隐藏，不猜
    // 数据是旧格式（按课号当键）就**明说**，不拿它猜 —— 旧格式下两个圈各有 0001 时会串课
    if (all.keyScheme !== 'lesson-id') {
      zone.innerHTML =
        '<div class="alert alert-info stack-xs">' +
        '<p><strong>实践区</strong>：数据是旧格式（没有 <code>keyScheme</code>），' +
        '按课号查会串课，所以这里先不显示。跑一次 <code>whale_practice write:true</code> 重新生成即可。</p>' +
        '</div>';
      zone.hidden = false;
      return;
    }
    // 主查法：键就是页面自报的完整课 id
    var lid = lessonId();
    var d = lid ? all.lessons[lid] : null;
    if (!d) {
      // 兜底：页面知道自己被构建成哪个文件（ask.js 读的就是 body 上的 data-ask-page）。
      // 分层布局下这个值是 lessons/<圆圈>/<知识点>/NNNN-*.html，而 byFile 的键是
      // <圆圈>/<知识点>/NNNN-*.html 与 NNNN-*.html 两种 —— 三种写法都试一遍（2026-09-21）。
      var page = document.body && document.body.getAttribute('data-ask-page');
      page = page ? String(page) : '';
      var base = page ? page.split('/').pop() : null;
      var noPrefix = page.replace(/^lessons\//, '');
      var byFile = all.byFile || {};
      var key = byFile[page] || byFile[noPrefix] || (base ? byFile[base] : null);
      d = key ? all.lessons[key] : null;
    }
    if (!d) return;
    render(zone, d);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
