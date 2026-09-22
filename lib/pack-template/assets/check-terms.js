/**
 * check-terms.js — 名词标记 + 本地链接自检工具
 * ------------------------------------------------------------------
 * 运行： node assets/check-terms.js
 *
 * 检查 lessons/*.html 与 reference/*.html 里：
 *   1. 键名是否都在 glossary-data.js 里定义（防拼写错误 → 页面不弹窗）
 *   2. 有没有误标进 <pre><code> 代码块（代码必须保持可复制原样）
 *   3. 每个名词「第一次出现」落在哪里（决定谁弹小窗）
 *   4. 本地相对链接（href/src）是否指向真实存在的文件 —— 防死链
 *   5. 笔记库里有没有名词从未被任何课程使用
 *
 * 退出码：发现错误（未定义键名 / 误标代码块 / 死链）时返回 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GLOSSARY = require(path.join(__dirname, 'glossary-data.js'));

function htmlFilesIn(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  // 递归：分层布局后产物是 lessons/<圆圈>/<知识点>/NNNN-*.html —— 只扫一层会"一个页面都看不见"，
  // 那时所有检查都会假绿（比报错更糟），所以这里必须跟着目录结构走。
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      // ⚠️ 跳过 src/：那是**作者态**镜像（lessons/src/…），不是可发布的页面 ——
      // 扫进去会报一堆"死链/没引 theme.css"的假红（2026-09-21 分层重构时实测）。
      if (e.isDirectory()) { if (e.name === 'src') continue; walk(full); continue; }
      if (!e.name.endsWith('.html')) continue;
      out.push(path.posix.join(dir, path.relative(abs, full).split(path.sep).join('/')));
    }
  })(abs);
  return out.sort();
}

const pages = [].concat(htmlFilesIn('lessons'), htmlFilesIn('reference'));

/** 生成 GitHub 风格的标题锚点：@GetMapping -> getmapping、Spring Boot -> spring-boot */
function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** 读取一个 Markdown 文件里所有标题的锚点集合 */
const headingCache = new Map();
function headingSlugs(absFile) {
  if (headingCache.has(absFile)) return headingCache.get(absFile);
  const set = new Set();
  try {
    const lines = fs.readFileSync(absFile, 'utf8').split(/\r?\n/);
    lines.forEach((line) => {
      const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (m) set.add(slug(m[1]));
    });
  } catch (e) {
    // 读不到就当作空集合，下面的链接检查会报出来
  }
  headingCache.set(absFile, set);
  return set;
}

/** 检查页面里的本地相对链接与 Markdown 锚点是否存在 */
function checkLinks(relFile) {
  const html = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
  const dir = path.posix.dirname(relFile);
  const broken = [];
  const re = /(?:href|src)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (/^(https?:|mailto:|data:|javascript:)/i.test(raw)) continue; // 外部链接跳过
    if (raw.startsWith('#')) continue;                              // 页内锚点跳过
    const hashAt = raw.indexOf('#');
    const target = hashAt === -1 ? raw : raw.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : raw.slice(hashAt + 1);
    if (!target) continue;
    const resolved = path.posix.normalize(path.posix.join(dir, target));
    const abs = path.join(ROOT, resolved);

    if (!fs.existsSync(abs)) {
      broken.push({ raw: raw, resolved: resolved, why: '文件不存在' });
      continue;
    }
    // 指向 Markdown 的锚点，逐个核对标题是否存在
    if (fragment && /\.md$/i.test(resolved)) {
      if (!headingSlugs(abs).has(decodeURIComponent(fragment).toLowerCase())) {
        broken.push({ raw: raw, resolved: resolved + '#' + fragment, why: '锚点不存在' });
      }
    }
  }
  return broken;
}

let problems = 0;
const usedAnywhere = new Set();
// 每个词**首次**被标记的页面（用于和台账的 lesson 声明对账，见文件末尾那一段）
const firstPage = Object.create(null);
let termTotal = 0;

if (!pages.length) console.log('[check-terms] 没有找到课程或参考文档');

pages.forEach((relFile) => {
  const html = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
  console.log('\n=== ' + relFile + ' ===');

  // ---- 名词标记 ----
  const re = /data-term="([^"]+)"/g;
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(0, m.index);
    const openPre = (before.match(/<pre[\s>]/g) || []).length;
    const closePre = (before.match(/<\/pre>/g) || []).length;
    hits.push({ key: m[1], inCode: openPre > closePre, line: before.split('\n').length });
  }
  termTotal += hits.length;

  if (!hits.length) {
    console.log('  名词标记 0 处（该页尚未接入名词组件）');
  } else {
    console.log('  名词标记 ' + hits.length + ' 处');
    const unknown = [...new Set(hits.map((h) => h.key))].filter((k) => !GLOSSARY[k]);
    if (unknown.length) {
      problems += unknown.length;
      console.log('  ❌ 未在 glossary-data.js 中定义: ' + unknown.join(', '));
    } else {
      console.log('  ✅ 所有键名都已定义');
    }

    const inCode = hits.filter((h) => h.inCode);
    if (inCode.length) {
      problems += inCode.length;
      inCode.forEach((h) => console.log('  ❌ 第 ' + h.line + ' 行：' + h.key + ' 标进了 <pre> 代码块'));
    } else {
      console.log('  ✅ 代码块内无标记（代码保持原样）');
    }

    const seen = Object.create(null);
    const first = [];
    let laterCount = 0;
    hits.forEach((h) => {
      usedAnywhere.add(h.key);
      if (seen[h.key]) laterCount++;
      else { seen[h.key] = true; first.push(h.key); }
    });
    console.log('  ·  会弹小窗（首次出现）' + first.length + ' 个: ' +
      first.map((k) => GLOSSARY[k].label).join(' | '));
    console.log('  🎨 仅保留颜色（重复出现）' + laterCount + ' 处');

    // pages 顺序是 lessons 在前、reference 在后，所以第一个记到的就是最早课次
    first.forEach((k) => { if (!firstPage[k]) firstPage[k] = relFile; });
  }

  // ---- 本地链接与锚点 ----
  const broken = checkLinks(relFile);
  if (broken.length) {
    problems += broken.length;
    broken.forEach((b) => console.log('  ❌ 死链: ' + b.raw + '  →  ' + b.resolved + '（' + b.why + '）'));
  } else {
    console.log('  ✅ 本地链接与锚点全部有效');
  }

  // ---- 主题：必须引 theme.css，且不得残留硬编码颜色 ----
  const hasTheme = /href="[^"]*theme\.css"/.test(html);
  if (!hasTheme) {
    problems++;
    console.log('  ❌ 没有引入 theme.css（令牌都在那里，缺了会整体掉色）');
  } else {
    console.log('  ✅ 已引入 theme.css');
  }

  // 内联 <style> 里的硬编码颜色：深色模式下会变成刺眼的一块
  const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) || [];
  const hard = [];
  styleBlocks.forEach((block) => {
    const re2 = /#[0-9a-fA-F]{3,8}\b|(?<![\w-])white\b|(?<![\w-])black\b/g;
    let m2;
    while ((m2 = re2.exec(block)) !== null) {
      // 允许：#fff/#000 用于「固定深底」的代码块前景（两种主题下都成立）
      hard.push(m2[0]);
    }
  });
  if (hard.length) {
    console.log('  ⚠️  内联样式里的硬编码颜色 ' + hard.length + ' 处: ' +
      [...new Set(hard)].join(' ') + '（确认都是"两种主题下都成立"的固定色，否则改用令牌）');
  }
});

const unused = Object.keys(GLOSSARY).filter((k) => !usedAnywhere.has(k));
if (unused.length) {
  console.log('\n=== 笔记库中尚未被任何课程使用' + unused.length + ' 个 ===');
  console.log('  ' + unused.map((k) => GLOSSARY[k].label).join(' | '));
}

// ---- 数据完整性：三段式是否都写齐 ----
/* ── 课次一致性：台账 lesson 声明 ↔ 该词首次被标记的课次 ───────────────
   为什么需要：页↔台账的双向对账已有（上面「已定义」与「未被使用」两段），
   但**没有任何地方**拿台账的 lesson 字段和实际标记位置比对 ——
   一个词声明第1课、实际第2课才第一次出现，会完全静默地通过。
   注意前向引用是合法的：第1课正文可以提前提到第2课才讲的词
   （例：map 在第1课被标记、lesson 写「第2课」），所以：
     · 声明课次**早于**首次出现 → 失败（进 problems，退出码 1）
     · 声明课次 ≠ 首次出现（前向引用）→ 只警告，不影响退出码
   只有 lessons/NNNN-*.html 有课次；reference/ 页面没有编号，跳过。 */
// 文件号（内部 ID）→ 显示号：轨道机制下台账的 lesson 字段写的是**显示名**（Vue 第1课），
// 而页面路径里是文件号 1001 —— 直接拿数字比会把整条 Vue 轨判成"声明课次早于实际出现"。
// 映射表是唯一来源（tools/lesson-map.js），插件侧镜像在 lib/pack-model.js。
const { lessonMap } = require(path.join(__dirname, '..', 'tools', 'lesson-map.js'));
const DISPLAY_NO = {};
for (const e of Object.values(lessonMap(ROOT).byKey)) DISPLAY_NO[e.number] = e.displayNumber;

function lessonNoOf(p) {
  const m = /(\d{4})/.exec(String(p || ''));
  if (!m) return null;
  return Object.prototype.hasOwnProperty.call(DISPLAY_NO, m[1]) ? DISPLAY_NO[m[1]] : Number(m[1]);
}
const lessonEarly = [];
const lessonForward = [];
Object.keys(GLOSSARY).forEach((k) => {
  const rec = GLOSSARY[k] || {};
  const declared = /第(\d+)课/.exec(rec.lesson || '');
  const actual = lessonNoOf(firstPage[k]);
  if (!declared || !actual) return;   // 没声明、或页面上没出现过（后者由上一段报）
  const d = Number(declared[1]);
  if (d < actual) {
    lessonEarly.push(rec.label + '（' + k + '）声明第' + d + '课，但首次标记在第' + actual + '课：' + firstPage[k]);
  } else if (d !== actual) {
    lessonForward.push(rec.label + '（' + k + '）声明第' + d + '课，首次标记在第' + actual + '课');
  }
});
console.log('\n=== 课次一致性（台账 lesson ↔ 首次标记课次）===');
if (!lessonEarly.length && !lessonForward.length) {
  console.log('  ✅ 全部一致');
}
if (lessonEarly.length) {
  problems += lessonEarly.length;
  console.log('  ❌ 声明课次早于实际出现 ' + lessonEarly.length + ' 条：');
  lessonEarly.forEach((m) => console.log('      · ' + m));
}
if (lessonForward.length) {
  console.log('  ⚠️  前向引用 ' + lessonForward.length + ' 条（合法，不阻塞）：');
  lessonForward.forEach((m) => console.log('      · ' + m));
}

console.log('\n=== 名词数据完整性（三段式）===');
const incomplete = Object.keys(GLOSSARY).filter((k) => {
  const it = GLOSSARY[k];
  return !it.official || !it.short || !it.analogy || !it.label || !it.category;
});
if (incomplete.length) {
  problems += incomplete.length;
  incomplete.forEach((k) => {
    const it = GLOSSARY[k] || {};
    const missing = ['official', 'short', 'analogy', 'label', 'category']
      .filter((f) => !it[f]).join(', ');
    console.log('  ❌ ' + k + ' 缺少字段: ' + missing);
  });
} else {
  console.log('  ✅ ' + Object.keys(GLOSSARY).length + ' 个名词都写齐了 官方定义 / 大白话 / 类比');
}

// ---- 注解类名词必须给「④ 规范写法」----
// 学生卡住时最需要的就是能照抄的最小示例，所以 label 以 @ 开头的名词一律要有 code。
console.log('\n=== 注解类名词的规范写法（④）===');
const isAnnotation = (it) => /^@/.test(it.label || '');
const annoMissing = Object.keys(GLOSSARY).filter((k) => isAnnotation(GLOSSARY[k]) && !GLOSSARY[k].code);
const annoTotal = Object.keys(GLOSSARY).filter((k) => isAnnotation(GLOSSARY[k])).length;
if (annoMissing.length) {
  problems += annoMissing.length;
  annoMissing.forEach((k) =>
    console.log('  ❌ ' + k + '（' + GLOSSARY[k].label + '）是注解，但没写 code（规范写法）')
  );
} else {
  console.log('  ✅ ' + annoTotal + ' 个注解类名词都给了 ④ 规范写法');
}

// code 里混进 HTML 会原样显示成尖括号，而且小窗用 textContent 渲染，必须拦住。
// 注意别把 Java 泛型当标签：List<Task>、ResponseEntity<String> 都会命中朴素的正则，
// 所以只查「闭合标签」和已知的 HTML 标签名 —— Java 泛型从不产生 </。
const codeWithHtml = Object.keys(GLOSSARY).filter(
  (k) => GLOSSARY[k].code && /<\/[a-z]|<(div|span|pre|code|br|strong|em|ul|ol|li|table)\b/i.test(GLOSSARY[k].code)
);
if (codeWithHtml.length) {
  problems += codeWithHtml.length;
  codeWithHtml.forEach((k) => console.log('  ❌ ' + k + ' 的 code 里混进了 HTML 标签，只能写纯代码'));
}

// 代码行太宽会把小窗撑出横向滚动条（中文字按 2 列计）
const wideCodeLines = [];
Object.keys(GLOSSARY).forEach((k) => {
  const code = GLOSSARY[k].code;
  if (!code) return;
  code.split('\n').forEach((line, i) => {
    const w = [...line].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
    if (w > 64) wideCodeLines.push(`${k} 第 ${i + 1} 行（${w} 列）: ${line.trim()}`);
  });
});
if (wideCodeLines.length) {
  problems += wideCodeLines.length;
  wideCodeLines.forEach((l) => console.log('  ❌ code 行过宽（上限 64 列），小窗会横向滚动 → ' + l));
} else {
  console.log('  ✅ 规范写法没有超宽行（≤ 64 列，中文字按 2 列计）');
}

// ---- 主题令牌审计：引用了但没定义的 CSS 变量会静默失效 ----
console.log('\n=== 主题令牌（CSS 变量）审计 ===');
const declared = new Set();
const usages = [];

function collectVars(text, from) {
  const decl = /(--[a-zA-Z0-9-]+)\s*:/g;
  let m;
  while ((m = decl.exec(text)) !== null) declared.add(m[1]);

  const use = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  while ((m = use.exec(text)) !== null) usages.push({ name: m[1], from: from });
}

const assetsDir = path.join(ROOT, 'assets');
fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css')).forEach((f) => {
  collectVars(fs.readFileSync(path.join(assetsDir, f), 'utf8'), 'assets/' + f);
});
pages.forEach((rel) => {
  collectVars(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
});

const missing = usages.filter((u) => !declared.has(u.name));
if (missing.length) {
  problems += missing.length;
  const grouped = new Map();
  missing.forEach((u) => {
    if (!grouped.has(u.name)) grouped.set(u.name, new Set());
    grouped.get(u.name).add(u.from);
  });
  grouped.forEach((files, name) => {
    console.log('  ❌ ' + name + ' 被引用但未定义 —— 出现在: ' + [...files].join(', '));
  });
} else {
  console.log('  ✅ ' + declared.size + ' 个令牌已定义，' + usages.length + ' 处引用全部有着落');
}

// ---- 疑问解答框审计：每条已解答的疑问，其页面与锚点必须真实存在 ----
console.log('\n=== 疑问解答框审计 ===');
let questions = {};
try {
  questions = require(path.join(assetsDir, 'questions-data.js'));
} catch (e) {
  console.log('  ⚠️  读不到 assets/questions-data.js，跳过');
}

const qIds = Object.keys(questions);
let qChecked = 0;
if (!qIds.length) {
  console.log('  （还没有疑问记录）');
} else {
  qIds.forEach((id) => {
    const q = questions[id];
    if (q.status === 'answered' && q.page && q.anchor) {
      const abs = path.join(ROOT, q.page);
      if (!fs.existsSync(abs)) {
        problems++;
        console.log('  ❌ #' + id + ' 的页面不存在: ' + q.page);
        return;
      }
      const html = fs.readFileSync(abs, 'utf8');
      if (html.indexOf('id="' + q.anchor + '"') === -1) {
        problems++;
        console.log('  ❌ #' + id + ' 的解答框 id="' + q.anchor + '" 在 ' + q.page + ' 里找不到');
        return;
      }
      qChecked++;
    } else if (q.status === 'answered' && !q.page) {
      // 解答不落在课程页（例如只是缓存/操作说明），允许，但要有 answer
      if (!q.answer) {
        problems++;
        console.log('  ❌ #' + id + ' 标记为已解答，但没有 answer，也没有页面解答框');
      }
    } else if (q.status !== 'answered') {
      console.log('  ⏳ #' + id + ' 待解答：' + q.question);
    }
  });
  if (qChecked) {
    console.log('  ✅ ' + qChecked + ' 条已解答的疑问，其课程页与锚点都已核对通过');
  }
}

// ---- 知识检验（quiz）审计：每题必须【恰好一个】正确答案 ----
// 这条来自一个真实 bug：第1课问题2、问题3 都漏了 data-correct，
// 于是不管选哪个都被判错 —— 一道永远答不对的题，学生只能自己发现。
console.log('\n=== 知识检验（quiz）审计 ===');
let quizTotal = 0;
let quizBad = 0;
const quizWarn = [];

/** 视觉宽度：中文字算 2 列 */
const visualWidth = (s) =>
  [...s].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);

pages.forEach((p) => {
  const html = fs.readFileSync(p, 'utf8');
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  const blocks = html.match(/<div class="quiz"[\s\S]*?<\/ul>/g) || [];

  blocks.forEach((block, i) => {
    quizTotal++;
    const q = ((block.match(/quiz-question">([^<]*)/) || [])[1] || '(无题干)').trim();
    const label = rel + ' 第' + (i + 1) + '题「' + q.slice(0, 24) + '」';
    const correctCount = (block.match(/data-correct="true"/g) || []).length;
    const opts = block.match(/<li class="quiz-option"[^>]*>[\s\S]*?<\/li>/g) || [];

    if (correctCount === 0) {
      problems++; quizBad++;
      console.log('  ❌ ' + label + ' 没有 data-correct —— 学生选哪个都判错');
      return;
    }
    if (correctCount > 1) {
      problems++; quizBad++;
      console.log('  ❌ ' + label + ' 有 ' + correctCount + ' 个 data-correct —— 只允许一个');
      return;
    }
    if (opts.length < 2) {
      problems++; quizBad++;
      console.log('  ❌ ' + label + ' 只有 ' + opts.length + ' 个选项');
      return;
    }
    if (!/data-explain=/.test(block)) {
      quizWarn.push(label + ' 缺 data-explain（答完没有任何解释）');
    }

    // 正确答案不该明显比其它选项长（长度本身会变成提示）。
    // 留 4 列容差：中文选项差一两个字不算可利用的信号，否则全是噪音。
    const lens = opts.map((o) => visualWidth(o.replace(/<[^>]*>/g, '').trim()));
    const correctIdx = opts.findIndex((o) => o.includes('data-correct="true"'));
    const othersMax = Math.max(...lens.filter((_, i2) => i2 !== correctIdx));
    if (lens[correctIdx] - othersMax >= 4) {
      quizWarn.push(
        label + ' 的正确答案明显最长（' + lens[correctIdx] + ' 列，其余最长 ' + othersMax + ' 列）'
      );
    }
  });
});

if (quizTotal === 0) {
  console.log('  （还没有测验题）');
} else if (quizBad === 0) {
  console.log('  ✅ ' + quizTotal + ' 道题都恰好有一个正确答案');
} else {
  console.log('  ' + quizTotal + ' 道题里有 ' + quizBad + ' 道不可答');
}
if (quizWarn.length) {
  console.log('  ⚠️  ' + quizWarn.length + ' 处可改进（不阻塞）：');
  quizWarn.forEach((w) => console.log('      · ' + w));
}

console.log('\n[check-terms] 共扫描 ' + pages.length + ' 个页面、' + termTotal + ' 处名词标记');
console.log('[check-terms] ' + (problems ? '发现 ' + problems + ' 个问题 ❌' : '全部检查通过 ✅'));
process.exit(problems ? 1 : 0);
