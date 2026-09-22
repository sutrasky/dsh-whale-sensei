/* assets/lesson-blocks.js — 课程页共享交互
 *
 * 这段 showTab 以前是内联在每一个用到代码页签的课程页尾的（第2课页尾 508 字符），
 * 每写一课就复制一遍。现在只有这一份，页面靠 assets/_frame.html 统一加载。
 *
 * 页面里的用法不变（内联 onclick 依赖全局函数）：
 *   <div class="code-tab active" onclick="showTab('curl', event)">cURL</div>
 *   <div class="code-content active" id="curl"> … </div>
 */
function showTab(tabName, evt) {
    document.querySelectorAll('.code-content').forEach(function (el) {
        el.classList.remove('active');
    });
    document.querySelectorAll('.code-tab').forEach(function (el) {
        el.classList.remove('active');
    });
    document.getElementById(tabName).classList.add('active');
    if (evt && evt.currentTarget) evt.currentTarget.classList.add('active');
}

/* ============================================================
   交互型 shape 的行为（与 S3.7 的样式配套）
   约定：所有交互都只在**有 JS** 时增强；没有 JS 时页面里的 <details> 就是答案。
   · data-quiz / data-quiz-feedback      知识检验（单选判定）
   · data-trace / data-trace-next|reset  单步执行（调用栈按步推进）
   · data-explore / data-explore-panel   状态探索（点状态看迁移）
   · data-pick / data-pick-note          二维查表（行头 + 列头）
   · data-ex / data-ex-check|reset|status 点选排序练习（判定 + 重来）
   ============================================================ */
(function () {
    'use strict';

    /* ---------- 知识检验：点选项即判定 ---------- */
    document.querySelectorAll('[data-quiz]').forEach(function (box) {
        var name = box.getAttribute('data-quiz');
        var opts = Array.prototype.slice.call(box.querySelectorAll('.quiz-option[data-opt]'));
        var out = document.querySelector('[data-quiz-feedback="' + name + '"]');
        var right = box.getAttribute('data-answer') || '0';
        opts.forEach(function (o) {
            o.addEventListener('click', function () {
                var ok = o.getAttribute('data-opt') === right;
                opts.forEach(function (p) { p.classList.remove('correct', 'incorrect'); });
                o.classList.add(ok ? 'correct' : 'incorrect');
                if (out) {
                    out.textContent = (ok ? '答对了。' : '答错了。') + (box.getAttribute('data-why') || '');
                    out.classList.toggle('is-correct', ok);
                    out.classList.toggle('is-wrong', !ok);
                }
            });
        });
    });

    /* ---------- 单步执行：把"未到的步"压暗 ---------- */
    document.querySelectorAll('[data-trace]').forEach(function (box) {
        var name = box.getAttribute('data-trace');
        var nodes = Array.prototype.slice.call(box.querySelectorAll('.ds-stack .ds-node'));
        var logs = Array.prototype.slice.call(box.querySelectorAll('.ds-trace__log li'));
        var note = document.querySelector('[data-trace-note="' + name + '"]');
        var at = 0;
        function render() {
            nodes.forEach(function (n) {
                var vis = n.getAttribute('data-vis') || '';
                n.classList.toggle('is-on', vis.charAt(at - 1) === '1');
            });
            logs.forEach(function (l, i) { l.classList.toggle('is-on', i === at - 1); });
            if (note) note.textContent = at ? '第 ' + at + ' / ' + logs.length + ' 步' : '点「下一步」开始';
        }
        var next = document.querySelector('[data-trace-next="' + name + '"]');
        if (next) next.addEventListener('click', function () { at = Math.min(logs.length, at + 1); render(); });
        var reset = document.querySelector('[data-trace-reset="' + name + '"]');
        if (reset) reset.addEventListener('click', function () { at = 0; render(); });
        render();
    });

    /* ---------- 状态探索：点状态列出迁移 ---------- */
    document.querySelectorAll('[data-explore]').forEach(function (box) {
        var name = box.getAttribute('data-explore');
        var chips = Array.prototype.slice.call(box.querySelectorAll('.ds-state .ds-node[data-state]'));
        var panel = document.querySelector('[data-explore-panel="' + name + '"]');
        chips.forEach(function (c) {
            c.addEventListener('click', function () {
                chips.forEach(function (p) { p.classList.remove('is-picked'); });
                c.classList.add('is-picked');
                var list = box.querySelector('template[data-from="' + c.getAttribute('data-state') + '"]');
                if (panel && list) panel.innerHTML = list.innerHTML;
            });
        });
    });

    /* ---------- 二维查表：行头 + 列头 → 交叉格 ---------- */
    document.querySelectorAll('[data-pick]').forEach(function (box) {
        var name = box.getAttribute('data-pick');
        var note = document.querySelector('[data-pick-note="' + name + '"]');
        var row = null;
        var col = null;
        function apply() {
            box.querySelectorAll('.ds-pick__cell').forEach(function (c) {
                c.classList.toggle('is-picked', c.getAttribute('data-r') === row && c.getAttribute('data-c') === col);
            });
            if (note) note.textContent = (row === null || col === null)
                ? '先点左边的行，再点上方的列。'
                : '选中：' + (box.querySelector('th[data-row="' + row + '"]').textContent || '') + ' × ' + (box.querySelector('th[data-col="' + col + '"]').textContent || '');
        }
        box.querySelectorAll('th[data-row]').forEach(function (th) {
            th.addEventListener('click', function () {
                row = th.getAttribute('data-row');
                box.querySelectorAll('th[data-row]').forEach(function (p) { p.classList.remove('is-picked'); });
                th.classList.add('is-picked');
                apply();
            });
        });
        box.querySelectorAll('th[data-col]').forEach(function (th) {
            th.addEventListener('click', function () {
                col = th.getAttribute('data-col');
                box.querySelectorAll('th[data-col]').forEach(function (p) { p.classList.remove('is-picked'); });
                th.classList.add('is-picked');
                apply();
            });
        });
    });

    /* ---------- 练习：点选排序 + 判定（没有 JS 时 <details> 里就是答案） ----------
       搬自 figure-lab.js：那里只有实验室页加载，真课页只加载本文件，
       所以留在那边 = 课上的「检查顺序」是个哑弹。此处为**唯一实现**。
       与实验室版的区别：标签与 key 允许不同，先把原始标签存进 data-label，
       否则点一下就把 label 覆写成 key（渲染器支持 label ≠ key）。 */
    document.querySelectorAll('[data-ex]').forEach(function (box) {
        var name = box.getAttribute('data-ex');
        var answer = (box.getAttribute('data-answer') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var picked = [];

        function nodes() { return Array.prototype.slice.call(box.querySelectorAll('[data-key]')); }
        function status(text) {
            var el = document.querySelector('[data-ex-status="' + name + '"]');
            if (el) el.textContent = text;
        }
        function label(n) {
            if (!n.hasAttribute('data-label')) n.setAttribute('data-label', n.textContent.trim());
            return n.getAttribute('data-label');
        }

        nodes().forEach(function (n) {
            n.addEventListener('click', function () {
                var key = n.getAttribute('data-key');
                var at = picked.indexOf(key);
                if (at >= 0) {
                    picked.splice(at, 1);
                    n.textContent = label(n);
                    n.classList.remove('is-ok', 'is-bad');
                    status('');
                    return;
                }
                picked.push(key);
                n.textContent = picked.length + '. ' + label(n);
            });
        });

        var checkBtn = document.querySelector('[data-ex-check="' + name + '"]');
        if (checkBtn) checkBtn.addEventListener('click', function () {
            if (picked.length !== answer.length) { status('还没选完（' + picked.length + '/' + answer.length + '）'); return; }
            var right = 0;
            nodes().forEach(function (n) {
                var ok = picked.indexOf(n.getAttribute('data-key')) === answer.indexOf(n.getAttribute('data-key'));
                n.classList.toggle('is-ok', ok);
                n.classList.toggle('is-bad', !ok);
                if (ok) right++;
            });
            status(right === answer.length ? '顺序正确，全部命中' : '对 ' + right + '/' + answer.length + '，红色节点位置不对');
        });

        var resetBtn = document.querySelector('[data-ex-reset="' + name + '"]');
        if (resetBtn) resetBtn.addEventListener('click', function () {
            picked = [];
            nodes().forEach(function (n) { n.textContent = label(n); n.classList.remove('is-ok', 'is-bad'); });
            status('');
        });
    });
})();
