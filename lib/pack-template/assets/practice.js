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

  /** 三态 + 证据不够（P0-4 戊1b 加的那一态）—— 与插件输出一一对应 */
  var LABEL = { done: '已达成', todo: '未达成', review: '需人工确认', evidence: '证据不够' };

  /** 档位（强→弱）——与插件 `lib/evidence.js` 的 `EVIDENCE_KINDS` 同一顺序同一套词 */
  var KINDS = ['run', 'test', 'explain', 'verbal'];
  var KIND_LABEL = {
    run: '运行结果（真的跑起来 / 跑过的输出）',
    test: '学生自己写的测试（测试代码与它的输出）',
    explain: '解释能力（把为什么讲清楚）',
    verbal: '口头确认（只说了「我做完了」）'
  };

  /**
   * 贴证据的**出口**（候选基址逐个试，照 `assets/notes.js:92-97` 的写法）：
   *   ① 页面里显式给了 LESSON_ASK_ENDPOINT → 用它
   *   ② 同源（页面由 DSH 宿主 / 预览服务供着）→ `location.origin + '/api/whale'`
   *   ③ 双击（`file://`）或从别处供着 → 回落到 DSH 宿主 3090（插件路由在那边）
   * 三条收的是同一个 body，不做形状分支。
   */
  function evidenceBases() {
    if (window.LESSON_ASK_ENDPOINT) return [window.LESSON_ASK_ENDPOINT];
    if (location.protocol === 'file:') return ['http://127.0.0.1:3090/api/whale'];
    return [location.origin + '/api/whale', 'http://127.0.0.1:3090/api/whale'];
  }

  /** 贴证据小表单：只给**有档位要求**的那道题显示（没要求的题不塞空壳） */
  function evidenceForm(lid, c) {
    var min = c.evidence.min;
    var opts = KINDS.filter(function (k) { return KINDS.indexOf(k) <= KINDS.indexOf(min); })
      .map(function (k) { return '<option value="' + k + '">' + esc(KIND_LABEL[k]) + '</option>'; })
      .join('');
    var have = c.evidence.have
      ? '现在最强的一档：<strong>' + esc(KIND_LABEL[c.evidence.have] || c.evidence.have) + '</strong>'
      : '还没贴过证据';
    return '<div class="stack-xs" data-evidence="' + esc(c.no) + '">' +
      '<p class="stack-xs">这道题要求的最低证据档：<strong>' + esc(KIND_LABEL[min] || min) + '</strong> —— ' + have + '</p>' +
      '<label>贴哪一档 <select data-ev-kind>' + opts + '</select></label> ' +
      '<label>出处（可选）<input type="text" data-ev-ref placeholder="文件名 / 命令 / 答疑编号"></label> ' +
      '<button type="button" data-ev-send>贴上去</button>' +
      '<span data-ev-status></span>' +
      '</div>';
  }

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
    } else if (c.state === 'evidence' && c.evidence && c.evidence.hint) {
      parts.push('<br>' + esc(c.evidence.hint));
    } else if (c.state === 'review' && c.why && c.why !== c.hint && c.why !== c.deliverable) {
      parts.push('<br>' + esc(c.why));
    }
    parts.push('</li>');
    return parts.join('');
  }

  /** 贴证据的提交：POST → 就地刷新这一段（成功/失败都说人话，不静默） */
  function wireEvidence(zone, lid) {
    var boxes = zone.querySelectorAll('[data-evidence]');
    Array.prototype.forEach.call(boxes, function (box) {
      var btn = box.querySelector('[data-ev-send]');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var no = Number(box.getAttribute('data-evidence'));
        var kind = box.querySelector('[data-ev-kind]').value;
        var ref = box.querySelector('[data-ev-ref]').value;
        var st = box.querySelector('[data-ev-status]');
        var body = { lesson: lid, challenge: no, kind: kind };
        if (ref) body.ref = ref;
        btn.disabled = true;
        st.textContent = '正在贴…';
        var bases = evidenceBases();
        (function post(i) {
          if (i >= bases.length) {
            st.textContent = '贴不上（服务不可达）—— 跟老师说一声，他能替你记一条';
            btn.disabled = false;
            return;
          }
          fetch(bases[i] + '/evidence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
            .then(function (r) {
              if (!r.ok) { var e = new Error('HTTP ' + r.status); e.httpStatus = r.status; throw e; }
              return r.json();
            })
            .then(function (data) {
              if (data && data.ok) {
                st.textContent = '已记下（' + (data.haveLabel || kind) + '）—— 刷新页面看判定';
                btn.disabled = false;
                return;
              }
              st.textContent = '没记下：' + ((data && data.error) || '宿主拒绝了');
              btn.disabled = false;
            })
            .catch(function () { post(i + 1); });
        })(0);
      });
    });
  }

  function render(zone, d) {
    var s = d.summary || { achieved: 0, total: 0, needsReview: 0 };
    var head =
      '<p><strong>实践区</strong>：这课的挑战' +
      '达成 ' + esc(s.achieved) + ' / 共 ' + esc(s.total) +
      (s.needsReview ? '（另有 ' + esc(s.needsReview) + ' 项需人工确认）' : '') +
      '。判定依据来自你机器上的代码（探针扫的静态事实），<strong>不跑你的代码</strong>。</p>';
    var lis = (d.challenges || []).map(challengeLi).join('');
    // 贴证据小表单：只给**声明了最低证据档**的那几道题（P0-4 戊1b）
    var forms = (d.challenges || [])
      .filter(function (c) { return c.evidence && c.evidence.min; })
      .map(function (c) { return evidenceForm(d.id, c); })
      .join('');
    // 台账还没建立 ⇒ 声明了档位的题**这一档没判**。必须说出来（判据 ④：不许静默变松）。
    var fallback = d.evidenceFallback
      ? '<p class="stack-xs"><strong>注意</strong>：证据台账还没建立，所以声明了最低证据档的题**这一档还没判**' +
        '（先按"需人工确认、不阻塞"走）。贴一条证据即启用这一档。</p>'
      : '';
    zone.innerHTML =
      '<div class="alert alert-info stack-xs">' +
      head +
      '<ul>' + lis + '</ul>' +
      fallback +
      forms +
      '<p class="stack-xs">判据写在 <code>' + esc(d.expect || '该项目的 EXPECT.json') + '</code>；' +
      '学生现状的完整台账在 <code>learning-records/state.json</code>（由插件生成）。</p>' +
      '</div>';
    zone.hidden = false;
    if (forms) wireEvidence(zone, d.id);
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
