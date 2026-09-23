/**
 * build-glossary.js — 由名词数据源生成笔记文件
 * ------------------------------------------------------------------
 * 运行： node assets/build-glossary.js
 * 输入： assets/glossary-data.js   （唯一数据源）
 * 输出： GLOSSARY.md               （带目录，方便查找）
 *
 * 以后新增名词：只改 glossary-data.js，再运行一次本脚本即可。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'glossary-data.js');
const OUT = path.join(ROOT, 'GLOSSARY.md');

/**
 * 原子写入：先写临时文件再 rename 覆盖。
 * writeFileSync 会先截断再写，正好在窗口里打开这份笔记的人会看到半截文件。
 */
function writeAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

const GLOSSARY = require(SRC);

/** 生成 GitHub 风格的标题锚点：@GetMapping -> getmapping */
function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ---- 按数据顺序聚合分类 ----
const categories = [];
const byCategory = new Map();
const entries = [];

Object.keys(GLOSSARY).forEach((key, index) => {
  const item = GLOSSARY[key];
  const cat = item.category || '未分类';
  if (!byCategory.has(cat)) {
    byCategory.set(cat, []);
    categories.push(cat);
  }
  const entry = Object.assign({ key: key, no: index + 1, cat: cat }, item);
  byCategory.get(cat).push(entry);
  entries.push(entry);
});

// ---- 拼装 Markdown ----
const L = [];
const total = entries.length;

L.push('# Spring Boot 名词速查笔记（GLOSSARY）');
L.push('');
L.push('> 本文件是本工作区**所有专业名词的唯一记录处**，方便随时查找。');
L.push('>');
L.push('> 课程页里带虚线下划线的彩色名词，鼠标放上去就会显示一个小窗，');
L.push('> 里面按顺序给出三段：**① 官方定义**（正式术语 + 英文全称）→ **② 一句话大白话** → **③ 生活类比**。');
L.push('> 每个名词只在**第一次**出现时带下划线，');
L.push('> 之后再出现只保留颜色，不再重复弹窗。');
L.push('>');
L.push('> ⚙️ 本文件由 `assets/build-glossary.js` 自动生成，数据源是 `assets/glossary-data.js`。');
L.push('> 要新增或修改名词，请改数据源，然后运行 `node assets/build-glossary.js`。');
L.push('');
L.push(`**共 ${total} 个名词，分为 ${categories.length} 类。**`);
L.push('');

// 目录
L.push('## 目录');
L.push('');
L.push('| # | 名词 | 分类 | 一句话解释 | 首次出现 |');
L.push('|---|------|------|-----------|---------|');
entries.forEach((e) => {
  L.push(
    `| ${e.no} | [${e.label}](#${slug(e.label)}) | ${e.cat} | ${e.short} | ${e.lesson || '-'} |`
  );
});
L.push('');

// 分类跳转
L.push('## 按分类跳转');
L.push('');
categories.forEach((cat) => {
  L.push(`- [${cat}](#${slug(cat)}) —— ${byCategory.get(cat).length} 个`);
});
L.push('');
L.push('---');
L.push('');

// 正文
categories.forEach((cat) => {
  L.push(`## ${cat}`);
  L.push('');
  byCategory.get(cat).forEach((e) => {
    L.push(`### ${e.label}`);
    L.push('');
    L.push(`- **① 官方定义**：${e.official || '（待补）'}`);
    L.push(`- **② 一句话**：${e.short}`);
    L.push(`- **③ 类比**：${e.analogy}`);
    L.push(`- **首次出现**：${e.lesson || '-'}`);
    L.push(`- **数据键名**：\`${e.key}\`（课程页里写 \`<span data-term="${e.key}">${e.label}</span>\`）`);
    L.push('');
    // ④ 规范写法：注解类等「有用法规范」的名词才有。放在列表之后，
    // 否则围栏代码块会把 markdown 列表截断。
    if (e.code) {
      L.push('**④ 规范写法**');
      L.push('');
      L.push('```java');
      L.push(e.code);
      L.push('```');
      L.push('');
    }
  });
});

// 维护说明
L.push('---');
L.push('');
L.push('## 怎么加一个新名词');
L.push('');
L.push('1. 打开 `assets/glossary-data.js`，在合适分类下加一条：');
L.push('');
L.push('```js');
L.push('newword: {');
L.push("  label: '新名词',");
L.push("  category: 'Spring 注解',");
L.push("  official: '官方定义：正式术语 + 英文全称（如适用），一句话。',");
L.push("  short: '一句话大白话，让人一眼看懂。',");
L.push("  analogy: '一个生活化类比，用来记住它。',");
L.push("  lesson: '第3课'");
L.push('}');
L.push('```');
L.push('');
L.push('2. 运行 `node assets/build-glossary.js`，本文件会自动更新（目录也会刷新）。');
L.push('3. 在课程 HTML 正文里给名词加标记：`<span data-term="newword">新名词</span>`，');
L.push('   第一次出现的位置带下划线和小窗，后面的会自动只保留颜色。');
L.push('4. 运行 `node assets/check-terms.js` 自检：确认键名没拼错、没标进代码块。');
L.push('');
L.push('> 注意：不要在 `<pre><code>` 代码块里标名词，代码要保持原样可复制。');
L.push('');
L.push('## 相关文件');
L.push('');
L.push('| 文件 | 作用 |');
L.push('|------|------|');
L.push('| `assets/glossary-data.js` | 名词数据源（唯一需要手改的地方） |');
L.push('| `assets/glossary.css` | 名词下划线、彩色、悬停小窗的样式 |');
L.push('| `assets/glossary.js` | 悬停逻辑：只给第一次出现绑小窗，后续自动降级为仅颜色 |');
L.push('| `assets/quiz.js` | 选择题组件：点选即判、标出正确答案、可重做 |');
L.push('| `assets/build-glossary.js` | 生成 `GLOSSARY.md`（本文件） |');
L.push('| `assets/check-terms.js` | 自检课程页里的名词标记 |');
L.push('| `GLOSSARY.md` | 你在看的这份笔记 |');
L.push('');

writeAtomic(OUT, L.join('\n'));

console.log('[build-glossary] 已生成 ' + path.relative(ROOT, OUT));
console.log('[build-glossary] 名词 ' + total + ' 个，分类 ' + categories.length + ' 个');
categories.forEach((c) => console.log('  - ' + c + ': ' + byCategory.get(c).length));
