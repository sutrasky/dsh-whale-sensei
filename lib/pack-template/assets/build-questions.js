/**
 * build-questions.js — 由疑问数据源生成笔记
 * ------------------------------------------------------------------
 * 运行： node assets/build-questions.js
 * 输入： assets/questions-data.js   （唯一数据源）
 * 输出： QUESTIONS.md               （带目录，方便查找）
 *
 * 与 build-glossary.js 同构：只改数据源，再跑一次脚本。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'questions-data.js');
const OUT = path.join(ROOT, 'QUESTIONS.md');
const GLOSSARY = require(path.join(__dirname, 'glossary-data.js'));

/**
 * 原子写入：先写临时文件再 rename 覆盖。
 * writeFileSync 会先截断再写，正好在窗口里打开这份笔记的人会看到半截文件。
 */
function writeAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

const QUESTIONS = require(SRC);

/** 生成 GitHub 风格锚点，与课程页里的 id 对应 */
function pageAnchor(q) {
  if (!q.page || !q.anchor) return '（不落在课程页，见本笔记）';
  return '`' + q.page + '#' + q.anchor + '`';
}

const ids = Object.keys(QUESTIONS).sort();
const total = ids.length;
const pending = ids.filter((id) => QUESTIONS[id].status !== 'answered');

const L = [];
L.push('# 疑问与解答（QUESTIONS）');
L.push('');
L.push('> 本文件记录学生提出的每一个疑问及其解答，是**疑问的唯一台账**。');
L.push('>');
L.push('> 闭环：学生在课程页左栏「DSH 笔记」卡片里点「我有疑问 →」提交 → 问题落盘 `questions/pending.jsonl`');
L.push('> → 老师按 `lesson` 技能处理，在课程页插入**青紫色解答框**（带 `id="q-NNNN"`）');
L.push('> → 运行 `node assets/build-questions.js` 刷新本文件。');
L.push('>');
L.push('> ⚙️ 本文件由 `assets/build-questions.js` 自动生成，数据源是 `assets/questions-data.js`，请勿手改。');
L.push('');
L.push(`**共 ${total} 条疑问，待解答 ${pending.length} 条。**`);
L.push('');

// 还没有任何疑问时，给出明确指引，避免学生以为功能没生效
if (total === 0) {
  L.push('> 📭 **还没有疑问。** 你的第一条会记在这里。');
  L.push('>');
  L.push('> 提交方式：打开任意课程页，点左栏「DSH 笔记」卡片里的**「我有疑问 →」**按钮，');
  L.push('> 在弹层里写下问题提交（或按 `Ctrl`+`Enter`）。');
  L.push('> 老师会把解答做成**青紫色方框**插到你产生疑问的那个章节旁边，');
  L.push('> 并把位置写进下面的表格。');
  L.push('');
}

// ---- 目录 ----
L.push('## 目录');
L.push('');
L.push('| # | 疑问 | 课次 | 状态 | 解答位置 |');
L.push('|---|------|------|------|---------|');
ids.forEach((id) => {
  const q = QUESTIONS[id];
  const link = q.page && q.anchor
    ? `[${q.lesson} · ${q.section}](../${q.page}#${q.anchor})`
    : '本笔记';
  const status = q.status === 'answered' ? '✅ 已解答' : '⏳ 待解答';
  L.push(`| [${q.id}](#q${q.id}) | ${q.question} | ${q.lesson} | ${status} | ${link} |`);
});
L.push('');
L.push('---');
L.push('');

// ---- 正文 ----
ids.forEach((id) => {
  const q = QUESTIONS[id];
  L.push(`<a id="q${q.id}"></a>`);
  L.push('');
  L.push(`## ${q.id} · ${q.question}`);
  L.push('');
  L.push(`- **课次**：${q.lesson}`);
  L.push(`- **提出日期**：${q.date}`);
  L.push(`- **状态**：${q.status === 'answered' ? '✅ 已解答' : '⏳ 待解答'}`);
  L.push(`- **解答位置**：${pageAnchor(q)}${q.page ? '（' + q.section + '）' : ''}`);
  L.push('');
  if (q.status === 'answered') {
    L.push('**解答**');
    L.push('');
    L.push(q.answer);
  } else {
    L.push('**解答**');
    L.push('');
    L.push('（待解答）');
  }
  L.push('');
  if (q.terms && q.terms.length) {
    const links = q.terms
      .filter((t) => GLOSSARY[t])
      .map((t) => `[${GLOSSARY[t].label}](./GLOSSARY.md#${slug(GLOSSARY[t].label)})`);
    if (links.length) {
      L.push('**相关名词**：' + links.join(' · '));
      L.push('');
    }
  }
  L.push('---');
  L.push('');
});

function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ---- 维护说明 ----
L.push('## 怎么处理一条新疑问');
L.push('');
L.push('1. 读 `questions/pending.jsonl`，取最早一条待处理的。');
L.push('2. 判断这条疑问属于哪一课、该落在哪一节（挂在学生产生疑问的那个知识点旁边最自然）。');
L.push('3. 在那一节的课程页里插入解答框：');
L.push('');
L.push('```html');
L.push('<div class="qa-box" id="q0003">');
L.push('  <div class="qa-box__q"><span class="qa-box__tag">❓ 你的疑问 #0003</span>学生的原话</div>');
L.push('  <div class="qa-box__a"><span class="qa-box__tag">💡 解答</span>解答正文</div>');
L.push('</div>');
L.push('```');
L.push('');
L.push('4. 在 `assets/questions-data.js` 里登记这条疑问（id 与页面上的 `id` 对应），状态写 `answered`。');
L.push('5. 运行 `node assets/build-questions.js` 刷新本文件。');
L.push('6. 跑 `node assets/check-terms.js`，它会核对每个解答框的页面与锚点是否真实存在。');
L.push('7. 回复学生时给出**精确位置**：第几课 → 哪一节 → 解答框编号，并附可点链接。');
L.push('');

writeAtomic(OUT, L.join('\n'));

console.log('[build-questions] 已生成 ' + path.relative(ROOT, OUT));
console.log('[build-questions] 疑问 ' + total + ' 条（待解答 ' + pending.length + ' 条）');
