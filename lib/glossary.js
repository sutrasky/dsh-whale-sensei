/**
 * lib/glossary.js — 名词台账 → GLOSSARY.md（**纯函数层**）
 * ------------------------------------------------------------------
 * 逐字搬运 `study/assets/build-glossary.js`（166 行）的生成逻辑，只把 IO 剥掉：
 *   原脚本第 29 行 `require(SRC)` → 改成参数 `ledger` 传进来；
 *   原脚本第 162-166 行的写盘与 console.log → 由 `lib/glossary-io.js` 负责。
 *
 * 为什么值得搬：那个脚本**没有 `--check`**，所以 GLOSSARY.md 一旦忘了重建，
 * 没有任何东西会发现它跟台账不一致 ✗（课程包自己的 gate 也抓不到）。搬进插件后
 * 就能"合成 → 与磁盘逐字节对拍"，跟 theme.css 那套一样。
 *
 * 判据：`test/glossary-verify.mjs` —— 插件合成出来的字符串必须与磁盘上那份
 * （也就是 CLI 生成的那份）**逐字节相同**。
 *
 * **MIRROR-OF: assets/build-glossary.js**（同源实现；对拍落在 `test/mirror-parity.mjs`，登记在
 * `_plugin-prep/同源实现-对拍登记表.md`）。改这里就必须同步改那一份，否则对拍会红。
 */

/** 生成 GitHub 风格的标题锚点：@GetMapping -> getmapping（搬运自 build-glossary.js:32-38，逐字） */
export function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * 按**数据顺序**聚合分类（搬运自 build-glossary.js:40-55）。
 * 顺序很重要：Markdown 里的目录与分类顺序都取决于它，乱一点就不是逐字节一致了。
 * @returns {{ categories: string[], byCategory: Map<string, object[]>, entries: object[] }}
 */
export function categorize(ledger) {
  const categories = [];
  const byCategory = new Map();
  const entries = [];
  Object.keys(ledger).forEach((key, index) => {
    const item = ledger[key];
    const cat = item.category || '未分类';
    if (!byCategory.has(cat)) {
      byCategory.set(cat, []);
      categories.push(cat);
    }
    const entry = Object.assign({ key: key, no: index + 1, cat: cat }, item);
    byCategory.get(cat).push(entry);
    entries.push(entry);
  });
  return { categories, byCategory, entries };
}

/**
 * 合成 GLOSSARY.md 全文（搬运自 build-glossary.js:57-161，逐字）。
 * 末尾**不带**换行：原脚本是 `L.join('\n')` 直接写盘，最后一项是空串，
 * 所以文件以 `\n` 收尾 —— 这个细节必须一致，否则逐字节对拍会差一个字节。
 *
 * @param {object} ledger glossary-data.js 导出的对象
 * @returns {string}
 */
/* ── 术语增改：对 UMD 数据源做**字符串手术**（纯函数，不碰盘）─────────────
 * 为什么不用 String.prototype.replace：替换串里的 `$&` / `$'` 会被当成反向引用，
 * 记录内容里一出现 `$` 就写飞（本机已踩过同类坑）。这里一律切片拼接。
 * 数据源形状（实测 assets/glossary-data.js）：
 *   (function (root, factory) { … }(this, function () {
 *     return {
 *       body: { 4 空格缩进
 *         label: '响应体',        6 空格缩进，单引号
 *         …
 *         lesson: '第1课'
 *       }                       末条记录**不带**逗号
 *     };
 *   }));
 * 所以插入点固定在顶层映射收尾 `\n  };` 之前，并给上一条补一个逗号。
 */

/** 顶层映射里已有的键名（按出现顺序） */
export function parseTermKeys(src) {
  const keys = [];
  const re = /^ {4}([A-Za-z_$][\w$]*): \{\s*$/gm;
  let m;
  while ((m = re.exec(String(src))) !== null) keys.push(m[1]);
  return keys;
}

/** 把 JS 值写成源码里的单引号字面量（换行转义，保持单行、值不变） */
function literal(v) {
  return "'" + String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n') + "'";
}

/** 一条记录的源码块（字段顺序与数据源一致；code 可选） */
export function termRecordSource(key, record) {
  const r = record || {};
  const lines = ['    ' + key + ': {'];
  for (const k of ['label', 'category', 'official', 'short', 'analogy']) {
    if (r[k] === undefined) throw new Error('记录缺少字段 ' + k);
    lines.push('      ' + k + ': ' + literal(r[k]) + ',');
  }
  if (r.code !== undefined) lines.push('      code: ' + literal(r.code) + ',');
  if (r.lesson === undefined) throw new Error('记录缺少字段 lesson');
  lines.push('      lesson: ' + literal(r.lesson));
  lines.push('    }');
  return lines.join('\n');
}

/**
 * 从 openIdx（指向 `{`）起找配对的花括号结束位置。
 * 必须跳过字符串/模板串/注释 —— 记录里的 `code` 常含 `{`（Java 代码块），
 * 朴素数括号会在这里断掉。
 */
function matchBraceEnd(src, openIdx) {
  let depth = 0;
  let mode = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode) {
      if (c === '\\') { i++; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); if (e === -1) return -1; i = e; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { mode = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 在数据源里插入或替换一条记录，返回新源码（纯函数）。
 * @param {string} src 源文件全文
 * @param {string} key 顶层键名（合法标识符）
 * @param {object} record { label, category, official, short, analogy, code?, lesson }
 * @param {{replace?: boolean}} [opts] replace=false 时键已存在就抛错（只追加不覆盖）
 */
export function upsertTermSource(src, key, record, opts = {}) {
  const replace = !!(opts && opts.replace);
  const text = String(src);
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) throw new Error('key 不是合法标识符: ' + key);

  const keys = parseTermKeys(text);
  const has = keys.indexOf(key) !== -1;
  if (has && !replace) throw new Error('台账里已有 ' + key + '：只追加不覆盖（要改请传 replace:true）');
  if (!has && replace) throw new Error('台账里没有 ' + key + '，无法 replace');
  const block = termRecordSource(key, record);

  if (has) {
    const startM = new RegExp('^ {4}' + key + ': \\{$', 'm').exec(text);
    if (!startM) throw new Error('定位不到 ' + key + ' 的记录头');
    const braceIdx = text.indexOf('{', startM.index);
    const end = matchBraceEnd(text, braceIdx);
    if (end === -1) throw new Error('找不到 ' + key + ' 记录的花括号配对');
    return text.slice(0, startM.index) + block + text.slice(end + 1);
  }

  const closeAt = text.lastIndexOf('\n  };');
  if (closeAt === -1) throw new Error('找不到顶层映射收尾（\\n  };）—— 数据结构变了？');
  const head = text.slice(0, closeAt);
  const next = text.slice(closeAt);
  // 上一条记录末尾补逗号（末条原本不带逗号）
  const patched = head.replace(/\}\s*$/, '},');
  if (patched === head) throw new Error('上一条记录末尾不是 `}`，插入点可疑');
  return patched + '\n' + block + next;
}

export function buildGlossaryMarkdown(ledger) {
  const { categories, byCategory, entries } = categorize(ledger);

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

  return L.join('\n');
}
