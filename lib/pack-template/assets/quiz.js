/* ============================================================
   quiz.js — 选择题组件（可复用）
   依赖：styles.css 里的 .quiz / .quiz-option / .quiz-feedback / .quiz-retry

   课程页写法：
     <div class="quiz" data-explain="可选：答完后显示的解析">
       <div class="quiz-question">问题：……</div>
       <ul class="quiz-options">
         <li class="quiz-option">错误选项</li>
         <li class="quiz-option" data-correct="true">正确选项</li>
       </ul>
     </div>

   行为：点选后立即判定、标出正确答案、显示解析，并给一个「再做一次」按钮。
   答案顺序由 HTML 决定（保持复习时位置稳定）。

   注意：对错配色走 CSS 类（.is-correct / .is-wrong），不写内联颜色，
   否则深色模式下会看不清。
   ============================================================ */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var quizzes = document.querySelectorAll('.quiz');
    Array.prototype.forEach.call(quizzes, initQuiz);
  });

  function initQuiz(quiz) {
    var options = Array.prototype.slice.call(quiz.querySelectorAll('.quiz-option'));
    if (!options.length) return;

    var explainText = quiz.getAttribute('data-explain') || '';

    var feedback = document.createElement('p');
    feedback.className = 'quiz-feedback';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'quiz-retry';
    retry.textContent = '再做一次';
    retry.hidden = true;

    quiz.appendChild(feedback);
    quiz.appendChild(retry);

    function reset() {
      options.forEach(function (opt) {
        opt.classList.remove('correct', 'incorrect', 'locked');
        opt.style.cursor = 'pointer';
        opt.removeAttribute('aria-disabled');
      });
      feedback.textContent = '';
      feedback.classList.remove('is-correct', 'is-wrong');
      retry.hidden = true;
    }

    function answer(chosen) {
      options.forEach(function (opt) {
        opt.classList.add('locked');
        opt.style.cursor = 'default';
        opt.setAttribute('aria-disabled', 'true');
      });

      var isRight = chosen.getAttribute('data-correct') === 'true';
      var right = options.filter(function (o) {
        return o.getAttribute('data-correct') === 'true';
      })[0];

      if (isRight) {
        chosen.classList.add('correct');
        feedback.textContent = '正确！' + (explainText ? ' ' + explainText : '');
        feedback.classList.add('is-correct');
      } else {
        chosen.classList.add('incorrect');
        if (right) right.classList.add('correct');
        feedback.textContent = (right ? '正确答案是「' + right.textContent.trim() + '」。' : '再想想。')
          + (explainText ? ' ' + explainText : '');
        feedback.classList.add('is-wrong');
      }
      retry.hidden = false;
    }

    options.forEach(function (opt) {
      opt.setAttribute('role', 'button');
      opt.setAttribute('tabindex', '0');
      opt.addEventListener('click', function () {
        if (opt.classList.contains('locked')) return;
        answer(opt);
      });
      opt.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          opt.click();
        }
      });
    });

    retry.addEventListener('click', reset);
  }
})();
