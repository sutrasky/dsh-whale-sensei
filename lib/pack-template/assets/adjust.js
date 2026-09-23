/**
 * adjust.js — 课后调整 → 判据提交（零依赖）
 * ------------------------------------------------------------------
 * 学生在这一课末尾写下"哪里要改"，点一下「记录并完成本课」：
 *   ① 调整内容追加到 learning-records/adjustments.jsonl（老师随即能读到）
 *   ② 提交作品判据 → **判据过了才点亮**（progress.json 的 learned 由服务先判后写）
 *
 * 两条失败路径**必须分开说**（说混了就是误报）：
 *   · 服务判据拒绝（HTTP 200 + ok:false + code）= 作品还没过判据 → 照实说差什么；
 *   · 服务真不可达（fetch 挂了）→ 降级成"把这段文字放进剪贴板"，并明确告诉学生怎么办
 *     （与 assets/ask.js 同一套降级思路：闭环不能断，也绝不静默）。
 */
(function () {
  'use strict';

  // 同源优先（tools/app-server.js 一个端口时）；file:// 才回落到独立服务
  var ENDPOINT = window.LESSON_ASK_ENDPOINT
    || (location.protocol === 'file:' ? 'http://127.0.0.1:8788' : location.origin);
  var box = document.querySelector('.adjust');
  if (!box) return;

  var lesson = box.getAttribute('data-lesson') || '';
  var text = document.getElementById('adjust-text');
  var btn = document.getElementById('adjust-done');
  var status = document.getElementById('adjust-status');
  if (!text || !btn || !status) return;

  function say(msg, bad) {
    status.textContent = msg;
    status.className = 'adjust__status' + (bad ? ' is-bad' : ' is-ok');
  }

  // 判据拒绝的分支文案：每种 code 都要说清"差什么、怎么办"（不许静默降级）
  function hintOf(j) {
    if (j.code === 'criteria-not-met') {
      var gaps = [];
      for (var i = 0; i < (j.gaps || []).length; i++) {
        var g = j.gaps[i];
        gaps.push('第' + g.no + '题：' + g.deliverable + '（缺：' + ((g.missing || []).join('、') || '未过') + '）');
      }
      return '判据还没全过，这一课暂不点亮：' + (gaps.join('；') || '（服务没给明细）');
    }
    if (j.code === 'no-snapshot') return '判据快照还没有（先跑 whale_state write:true 生成判据快照），这一课暂不点亮。';
    if (j.code === 'no-criteria') return '这门课还没声明挑战判据（EXPECT.json challenges）—— 先补判据，这一课暂不点亮。';
    if (j.code === 'stale-snapshot') return '代码在快照之后又变了：先跑 whale_state write:true 刷新判据快照，这一课暂不点亮。';
    return (j.hint || j.code) + '（这一课暂不点亮）';
  }

  // L3：auto:false 的题不阻塞点亮，但必须显式告诉学生"还要老师点头"
  function reviewNote(j) {
    var nr = (j && j.needsReview) || [];
    return nr.length ? '；另有 ' + nr.length + ' 项需老师确认（第' + nr.join('、') + '题）' : '';
  }

  btn.addEventListener('click', function () {
    var adjust = (text.value || '').trim();
    say('提交中…', false);
    btn.disabled = true;

    fetch(ENDPOINT + '/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lesson: lesson, done: true, adjust: adjust, title: document.title }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // 服务回的是**判据回执**：ok:false + code = 作品还没过判据 —— 这跟"服务没开"
        // 是两码事，必须分开说（别降级成剪贴板，那是误报）
        if (j && j.ok) {
          say('已记录' + (j.adjustSaved ? '（含课后调整）' : '')
            + (j.code === 'not-requested' ? '（本次没请求点亮）' : ' · 星图已点亮 ' + j.lit + ' 课')
            + reviewNote(j), false);
          text.value = '';
          return;
        }
        if (j && j.code) {
          say(hintOf(j) + (j.adjustSaved ? '（课后调整已记录）' : ''), true);
          return;
        }
        throw new Error((j && j.error) || '服务返回失败');
      })
      .catch(function () {
        // 降级：别让学生白写一段话（只在**服务真不可达**时才走这里）
        var payload = '【课后调整】' + lesson + '\n' + (adjust || '(无)');
        var copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(payload);
            copied = true;
          }
        } catch (e) { copied = false; }
        say('本地服务没开（先跑 node tools/ask-server.js）。'
          + (copied ? '已把这段文字放进剪贴板，直接贴给老师即可。' : '请手动复制这段文字交给老师。'), true);
      })
      .then(function () { btn.disabled = false; });
  });
})();
