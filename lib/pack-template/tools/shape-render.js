/**
 * shape-render.js —— 「shape 字段 → 图型 DOM」的确定性映射器
 * ==================================================================
 * 目的：把"用哪种图型"从每次生成的自由发挥，变成 数据 → DOM 的确定性映射。
 *   同一份 shape + 数据，永远渲染出同一串 HTML（纯函数、无随机、无时间）。
 *
 * 形状字典（白名单）与课程包的 front-matter 一一对应：
 *   hierarchy 树       nodes      （层级 / 继承 / 分类）
 *   sequence  链       steps      （顺序加工 / 责任链）
 *   lifo      栈       frames     （调用顺序，后进先出）
 *   timeline  时序     steps      （多方交互的时间顺序）
 *   state     状态流   states     （状态迁移）
 *   keyvalue  键值     pairs      （二维对照）
 *   matrix    表       head+rows  （两个正交维度）
 *
 * 这里只产 HTML 片段；样式一律用 lesson-blocks.css 里已定义的 .ds-* 类。
 */
'use strict';

const ESC = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SHAPES = {
  hierarchy: {
    need: ['nodes'],
    hint: '层级 / 继承 / 分类 → 树',
    render: (b) => `<div class="ds-tree">${treeList(b.nodes)}</div>`,
  },
  sequence: {
    need: ['steps'],
    hint: '顺序加工 / 责任链 → 链',
    render: (b) => `<div class="ds-chain">${b.steps.map((s, i) => `${i ? '<span class="ds-arrow">→</span>' : ''}${node(s)}`).join('')}</div>`,
  },
  lifo: {
    need: ['frames'],
    hint: '调用顺序（后进先出）→ 栈',
    render: (b) => `<div class="ds-stack">${b.frames.map((f) => node(f)).join('')}</div>`,
  },
  timeline: {
    need: ['steps'],
    hint: '多方交互的时间顺序 → 时序',
    render: (b) => `<div class="ds-seq">${b.steps.map((s, i) => `<span class="ds-step-no">T${i + 1}</span><span class="ds-step">${typeof s === 'string' ? s : ESC(s.text)}</span>`).join('')}</div>`,
  },
  state: {
    need: ['states'],
    hint: '状态迁移 → 状态流',
    render: (b) => `<div class="ds-state">${b.states.map((s, i) => `${i ? '<span class="ds-arrow">→</span>' : ''}${node(s)}`).join('')}</div>`,
  },
  keyvalue: {
    need: ['pairs'],
    hint: '二维对照 → 键值清单',
    render: (b) => `<dl class="ds-kv">${b.pairs.map(([k, v]) => `<dt>${ESC(k)}</dt><dd>${ESC(v)}</dd>`).join('')}</dl>`,
  },

  /* ---------- 呈现型 shape（防单调池 · 由用户选定：02/04/06/07）----------
     它们不表达"知识是什么形状"，而是表达"这段知识该怎么被看/被练/被追踪"。
     全部零 JS（exercise 需脚本，但自带 <details> 降级）。 */

  'multi-view': {   // 02 同一知识 · 三种看法（折叠而非切换：可打印、可搜索）
    need: ['views'],
    hint: '同一知识点多种看法 → 多视图',
    render: (b) => b.views.map((v, i) => {
      const errs = validateBlock(v, i);
      if (errs.length) throw new Error(errs.map((e) => `[${e.code}] multi-view 第 ${i + 1} 视图: ${e.msg}`).join('; '));
      return `<details><summary>${ESC(v.label || SHAPES[v.shape].hint)}</summary><div>${SHAPES[v.shape].render(v)}</div></details>`;
    }).join('\n'),
  },

  diff: {   // 04 与上一课对比，只点亮新增的那一枝
    need: ['before', 'after'],
    hint: '与上一课对比 → 差值高亮',
    render: (b) => `<section class="card-grid">
<article class="card"><header class="card__head">${ESC(b.beforeLabel || '上一课')}</header><div class="card__body"><div class="ds-tree">${treeList(b.before)}</div></div></article>
<article class="card"><header class="card__head">${ESC(b.afterLabel || '本课')}（新增处已点亮）</header><div class="card__body"><div class="ds-tree">${treeList(b.after)}</div></div></article>
</section>`,
  },

  exercise: {   // 06 图型即练习：点选排序 + 判定（零 JS 降级为折叠答案）
    need: ['items', 'answer'],
    hint: '排序/归属练习 → 练习',
    render: (b) => {
      const name = ESC(b.id || 'ex');
      const nodes = b.items.map((i) => {
        const o = typeof i === 'string' ? { key: i, label: i } : i;
        return `<span class="ds-node" data-key="${ESC(o.key)}">${ESC(o.label || o.key)}</span>`;
      }).join('');
      return `<div class="ds-ex" data-ex="${name}" data-answer="${ESC(b.answer.join(','))}">${nodes}</div>\n`
        + `<p><button class="quiz-retry" data-ex-check="${name}">检查顺序</button> <button class="quiz-retry" data-ex-reset="${name}">重来</button> <span class="is-note" data-ex-status="${name}"></span></p>\n`
        + `<details><summary>零 JS 降级：看答案</summary><div><p>正确顺序：<b>${ESC(b.answer.join(' → '))}</b></p></div></details>`;
    },
  },

  progress: {   // 07 知识结构进度树（学过的标"已学"、当前节点用强调色）
    need: ['nodes'],
    hint: '学习进度 → 进度树',
    render: (b) => `<div class="card"><header class="card__head">${ESC(b.title || '本课进度')}</header><div class="card__body"><div class="ds-tree">${treeList(b.nodes)}</div></div></div>`,
  },

  /* ---------- 交互型 shape（与 exercise 同族：判定 / 执行 / 探索 / 查表）----------
     共同约定：**没有 JS 时是可读的静态结构**（每个都自带 <details> 降级），
     JS 只把"判定与展开"变快。它们**不进防单调池** —— 它们是任务，不是文字块的替身。 */

  quiz: {   // 单选判定（复用 styles.css 里的 .quiz 系列，不另造一套）
    need: ['question', 'options'],
    hint: '单选判定 → 知识检验',
    check: (b) => (b.options.filter((o) => o && o.correct).length === 1
      ? []
      : [{ code: 'QUIZ_ANSWER', msg: `quiz 必须恰好一个 option 标 correct:true（现在 ${b.options.filter((o) => o && o.correct).length} 个）` }]),
    render: (b) => {
      const name = ESC(b.id || 'quiz');
      const idx = b.options.findIndex((o) => o && o.correct);
      const right = b.options[idx];
      const why = right.why || b.explain || '';
      const opts = b.options.map((o, i) => `<div class="quiz-option" data-opt="${i}">${ESC(o.text || o)}</div>`).join('');
      return `<div class="quiz" data-quiz="${name}" data-answer="${idx}" data-why="${ESC(why)}">
<div class="quiz-question">${ESC(b.question)}</div>
<div class="quiz-options">${opts}</div>
<div class="quiz-feedback" data-quiz-feedback="${name}"></div>
</div>
<details><summary>零 JS 降级：看答案与理由</summary><div><p>正确答案：<b>${ESC(right.text || right)}</b>${why ? ' —— ' + ESC(why) : ''}</p></div></details>`;
    },
  },

  trace: {   // 单步执行：调用栈按步推进（push/pop 真模拟，不是只把节点显示出来）
    need: ['steps'],
    hint: '单步执行（可点） → 执行轨迹',
    check: (b) => (b.steps.every((s) => s && (s.action === 'push' || s.action === 'pop'))
      ? []
      : [{ code: 'BAD_ACTION', msg: "trace.steps[].action 只能是 push / pop" }]),
    render: (b) => {
      const name = ESC(b.id || 'trace');
      // 逐步模拟：算每个 push 节点「第 k 步之后是否还在栈里」→ data-vis 位串
      const meta = [];
      const stack = [];
      b.steps.forEach((s, i) => {
        if (s.action === 'push') { meta.push({ label: s.label, vis: '' }); stack.push(meta.length - 1); }
        else stack.pop();
        meta.forEach((m, k) => { m.vis += stack.indexOf(k) >= 0 ? '1' : '0'; });
      });
      const nodes = meta.map((m) => `<span class="ds-node" data-vis="${m.vis}">${ESC(m.label)}</span>`).join('');
      const logs = b.steps.map((s, i) => `<li>${ESC(s.note || (s.action === 'push' ? '入栈 ' + s.label : '出栈 ' + s.label))}</li>`).join('');
      return `<div class="ds-trace" data-trace="${name}">
<div class="ds-trace__bar"><button class="quiz-retry" data-trace-next="${name}">下一步</button><button class="quiz-retry" data-trace-reset="${name}">重来</button><span class="is-note" data-trace-note="${name}"></span></div>
<div class="ds-stack">${nodes}</div>
<ol class="ds-trace__log">${logs}</ol>
</div>`;
    },
  },

  'state-explore': {   // 点状态看它允许 / 不允许的迁移
    need: ['states', 'transitions'],
    hint: '点状态看迁移（可点） → 状态探索',
    render: (b) => {
      const name = ESC(b.id || 'explore');
      const label = (s) => (typeof s === 'string' ? s : s.label);
      const rows = (from) => b.transitions.filter((t) => t.from === from)
        .map((t) => ({ legal: !!t.legal, text: `${t.legal ? '可以' : '不可以'} → ${t.to}${t.why ? '　' + t.why : ''}` }));
      const chips = b.states.map((s) => `<span class="ds-node" data-state="${ESC(label(s))}">${ESC(label(s))}</span>`).join('<span class="ds-arrow">→</span>');
      const tpl = b.states.map((s) => {
        const items = rows(label(s)).map((r) => `<li class="${r.legal ? 'is-legal' : 'is-illegal'}">${ESC(r.text)}</li>`).join('');
        return `<template data-from="${ESC(label(s))}"><ul>${items || '<li>（终态，没有出边）</li>'}</ul></template>`;
      }).join('');
      const fallback = b.states.map((s) => {
        const items = rows(label(s)).map((r) => `<li>${ESC(r.text)}</li>`).join('');
        return `<details><summary>零 JS 降级：从「${ESC(label(s))}」出发</summary><div><ul>${items || '<li>（终态）</li>'}</ul></div></details>`;
      }).join('\n');
      return `<div class="ds-explore" data-explore="${name}"><div class="ds-state">${chips}</div><p class="ds-explore__panel" data-explore-panel="${name}">点一个状态，看它允许的迁移。</p></div>
${tpl}
${fallback}`;
    },
  },

  'matrix-pick': {   // 二维查表：点行头 + 列头 → 交叉格（表格本身就是零 JS 的全部信息）
    need: ['head', 'rows'],
    hint: '二维查表（可点） → 选择器',
    render: (b) => {
      const name = ESC(b.id || 'pick');
      const head = `<tr><th></th>${b.head.slice(1).map((h, i) => `<th data-col="${i}">${ESC(h)}</th>`).join('')}</tr>`;
      const body = b.rows.map((r, ri) => `<tr><th data-row="${ri}">${ESC(r[0])}</th>${r.slice(1).map((c, ci) => `<td class="ds-pick__cell" data-r="${ri}" data-c="${ci}">${ESC(c)}</td>`).join('')}</tr>`).join('');
      return `<div class="ds-pick" data-pick="${name}"><p class="is-note" data-pick-note="${name}">先点左边的行，再点上方的列。</p><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    },
  },
  matrix: {
    need: ['head', 'rows'],
    hint: '两个正交维度 → 表',
    render: (b) => `<table>${b.head ? `<thead><tr>${b.head.map((h) => `<th>${ESC(h)}</th>`).join('')}</tr></thead>` : ''}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${ESC(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
  },
};

/* ---------- 内容形态 → shape（选型的主触发器）----------
   规则（2026-09-19 用户定）：**先看内容有没有匹配的形态**（代码/技术内容尤其 —— 技术知识本身就是结构化的：
   调用链、调用栈、生命周期、注解家族、方法×幂等…），**防单调只是兜底**。
   这张表让"按内容选"变成可检索、可机械检查的东西，而不是每次自由发挥。 */
const SHAPE_HINTS = {
  hierarchy: ['层级', '继承', '家族', '分类', '属于', '包结构', '注解家族', '父子'],
  sequence: ['顺序', '流程', '管线', '责任链', '过滤器', '拦截器', '中间件', '处理链', 'pipeline'],
  lifo: ['调用栈', '栈帧', '递归', '后进先出', '异常栈', '入栈'],
  timeline: ['时序', '时间顺序', '请求过程', '交互顺序', '先后', '第一步', 't1'],
  state: ['生命周期', '状态', '迁移', '状态机', 'lifecycle'],
  keyvalue: ['对照', '区别', '对比', '分别', '各自', '配置项', '键值'],
  matrix: ['矩阵', '维度', '组合', '交叉', '选型', '对比表'],
  'multi-view': ['多种看法', '换个角度', '横看', '多视角', '三种看法'],
  diff: ['新增', '上一课', '变化', '差异', '对比上一节'],
  exercise: ['排序', '排成', '练习', '顺序题'],
  progress: ['进度', '已学', '学习进度'],
  quiz: ['哪个', '下面哪', '判断对错', '选择题', '为什么'],
  trace: ['执行过程', '单步', '逐步', '出栈', '追踪'],
  'state-explore': ['允许', '不允许', '能不能', '合法', '非法'],
  'matrix-pick': ['查表', '选哪个', '怎么选'],
};

/**
 * 按内容挑 shape（确定性）：命中关键词 → 按"关键词长度×次数"打分排序。
 * 会先剥掉 HTML 标签，避免 `class="ds-stack"` 这类标记自我命中。
 */
function pickByContent(text, limit = 5) {
  const t = String(text == null ? '' : text).replace(/<[^>]*>/g, ' ');
  const hits = [];
  for (const shape of Object.keys(SHAPES)) {
    let score = 0;
    const matched = [];
    for (const k of SHAPE_HINTS[shape] || []) {
      const n = t.split(k).length - 1;
      if (n) { score += n * k.length; matched.push(k); }
    }
    if (score) hits.push({ shape, score, matched });
  }
  hits.sort((a, b) => b.score - a.score || a.shape.localeCompare(b.shape)); // 同分按名字 → 确定序
  return hits.slice(0, limit);
}

/** 单个节点：{ label|text, tag?, current?, dim? } 或纯字符串 */
function node(n) {
  const s = typeof n === 'string' ? { label: n } : n;
  const cls = ['ds-node'];
  if (s.current) cls.push('is-current');
  else if (s.dim) cls.push('is-dim');
  const tag = s.tag ? `<span class="ds-tag">${ESC(s.tag)}</span>` : '';
  return `<span class="${cls.join(' ')}">${ESC(s.label || s.text)}</span>${tag}`;
}

function treeList(nodes) {
  const items = (nodes || []).map((n) => {
    const cls = [];
    if (n.current) cls.push('is-current');
    if (n.new) cls.push('is-new');
    if (n.done) cls.push('is-done');
    const tag = n.tag ? `<span class="ds-tag">${ESC(n.tag)}</span>` : '';
    const fresh = n.new ? '<span class="ds-new-tag">新增</span>' : '';
    const kids = n.children && n.children.length ? treeList(n.children) : '';
    return `<li${cls.length ? ` class="${cls.join(' ')}"` : ''}><span>${ESC(n.label)}</span>${tag}${fresh}${kids}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

/** 断言①：shape 必须在白名单里，且所需字段齐全 */
function validateBlock(b, idx = 0) {
  const errs = [];
  const at = b && b.id ? `块 ${b.id}` : `第 ${idx + 1} 块`;
  if (!b || typeof b !== 'object') return [{ code: 'BLOCK_NOT_OBJECT', at, msg: '块必须是对象' }];
  if (!b.shape) errs.push({ code: 'MISSING_SHAPE', at, msg: '缺少 shape 字段' });
  else if (!SHAPES[b.shape]) errs.push({ code: 'UNKNOWN_SHAPE', at, msg: `shape「${b.shape}」不在白名单：${Object.keys(SHAPES).join(' / ')}` });
  else for (const f of SHAPES[b.shape].need) {
    const v = b[f];
    if (v == null || (Array.isArray(v) && !v.length)) errs.push({ code: 'MISSING_FIELD', at, msg: `shape「${b.shape}」需要字段 ${f}` });
  }
  // 形状自带的语义校验（如 quiz 必须恰好一个正确项、trace 的 action 白名单）
  if (b.shape && SHAPES[b.shape] && typeof SHAPES[b.shape].check === 'function' && !errs.length) {
    for (const e of SHAPES[b.shape].check(b)) errs.push({ ...e, at });
  }
  return errs;
}

/** 渲染一块（纯函数：同输入必同输出）
 *  `fold: true` + `detail` = 「结构优先阅读」（01）：结构在上面，讲解收进折叠。 */
function renderBlock(b, idx = 0) {
  const errs = validateBlock(b, idx);
  if (errs.length) throw new Error(errs.map((e) => `[${e.code}] ${e.at}: ${e.msg}`).join('; '));
  let html = SHAPES[b.shape].render(b);
  if (b.fold && b.detail) {
    html += `\n<details><summary>${ESC(b.summary || '展开讲解')}</summary><div><p>${ESC(b.detail)}</p></div></details>`;
  }
  return html;
}

/* ---------- 防单调池：单调时从这里挑，不许继续堆纯文字 ----------
   顺序 = 优先推荐顺序（内容型在前，呈现型在后）。pickFiller 是**确定性**的：
   同样的一串邻居，永远给出同一个建议（无随机）。 */
const FILLER_POOL = ['hierarchy', 'sequence', 'keyvalue', 'state', 'timeline', 'lifo', 'matrix', 'multi-view', 'diff', 'exercise', 'progress'];

function pickFiller(adjacent = []) {
  const used = new Set(adjacent);
  return FILLER_POOL.find((s) => !used.has(s)) || FILLER_POOL[0];
}

/** 渲染整页 */
function renderBlocks(blocks) {
  return blocks.map((b, i) => renderBlock(b, i)).join('\n');
}

/* ---------- 手写结构标记 → 它对应的 shape ----------
   课程里有些结构是**手写**的（`.quiz` / `.file-tree` / `<table>`…）。它们跟图型库是同一个形状
   （渲染器的 quiz 也复用 .quiz 系列，不另造一套）。体检时必须把它们算作「已有」，
   否则审计会把自己已经存在的内容当成缺口，建议你补一个重复的块。 */
const HANDWRITTEN_SHAPES = [
  [/class="quiz"/, 'quiz'],
  [/data-trace=/, 'trace'],
  [/data-explore=/, 'state-explore'],
  [/data-pick=/, 'matrix-pick'],
  [/class="file-tree"|class="ds-tree"/, 'hierarchy'],
  [/class="flow-diagram"|class="ds-chain"|class="step"/, 'sequence'],
  [/class="ds-kv"|<dl\b/, 'keyvalue'],
  [/class="ds-state"/, 'state'],
  [/class="ds-seq"/, 'timeline'],
  [/class="ds-stack"/, 'lifo'],
  [/<table[\s>]/i, 'matrix'],
];

/* ---------- 第 4 级兜底：内容无信号 + 结构单调 → 把选型交回使用者拍板 ----------
   规则（用户 2026-09 定）：P1 内容匹配、P2 交互/练习、P3 防单调都落空时，
   构建器**不擅自加图**，而是列一份「待拍板清单」由主线程转给使用者：
   每条给确定性候选（3 个，排除本页已用形态）+ 必带的「保持纯文本」选项。
   构建器照旧不阻塞 —— 先报告、不上闸。 */
const ASK_MAX_PER_PAGE = 2;    // 一次最多问 2 条：问多了等于没问
const ASK_CANDIDATES = 3;      // 每条给 3 个候选
const ASK_MIN_PROSE = 40;      // 正文太短（或整段是代码）就不问：没东西可图

/** 按 h2/h3 把页面切成知识点（确定性；返回 [{title, html}]） */
function splitPoints(html) {
  return String(html || '')
    .split(/(?=<h[23][\s>])/)
    .map((part) => {
      const m = part.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/);
      return { title: m ? m[1].replace(/<[^>]*>/g, '').trim() : '(开头)', html: part };
    })
    .filter((p) => p.html.trim());
}

/** 知识点的正文长度：剔除 <pre> 代码块与所有标签后再数 */
function proseLength(html) {
  return String(html || '')
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * 收集「待拍板」条目（纯函数、可单测）：单调 + 该知识点内容无信号 + 正文够长。
 * 三个条件缺一个都不产出 —— 这正是"只在内容匹配不上、单调太高时才调用"的落点。
 */
function collectAsks(html, already = new Set(), monotonous = false, reason = [], optOut = new Set()) {
  if (!monotonous || !html) return [];
  const pool = FILLER_POOL.filter((s) => !already.has(s)).slice(0, ASK_CANDIDATES);
  if (!pool.length) return [];
  const asks = [];
  for (const p of splitPoints(html)) {
    if (asks.length >= ASK_MAX_PER_PAGE) break;
    if (optOut.has(p.title)) continue;                   // 使用者已明确"保持纯文本"→ 不再问第二次
    if (proseLength(p.html) < ASK_MIN_PROSE) continue;   // 太短或整段是代码：没东西可图
    if (/<!--\s*figure:/.test(p.html)) continue;         // 已经有图型的知识点，不再问（避免重复加图）
    if (HANDWRITTEN_SHAPES.some(([re]) => re.test(p.html))) continue;  // 手写结构也算"已有"
    if (pickByContent(p.html, 1).length) continue;       // 内容有信号 → P1 说了算，不问
    asks.push({ point: p.title, candidates: pool.slice(), reason: reason.slice() });
  }
  return asks;
}

/**
 * 断言②（先报告、不上闸）：单调度体检。
 * 输入 = 每页的块序列（shape 或 'paragraph' 之类），输出 = 占比 + 最长同质连串 + 提示。
 */
function audit(pages) {
  const report = [];
  const longestRun = (seq, pred) => {
    let best = 0;
    let run = 0;
    for (const s of seq) {
      run = pred(s) ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  };
  for (const page of pages) {
    const seq = page.blocks.map((b) => (b && b.shape) || 'text');
    const total = seq.length;
    const counts = {};
    for (const s of seq) counts[s] = (counts[s] || 0) + 1;
    const shapes = Object.keys(counts).filter((s) => s !== 'text').length;
    const typeRun = longestRun(seq, (s) => s !== 'text');   // 图型连串才算单调
    const textRun = longestRun(seq, (s) => s === 'text');
    const structureCount = seq.filter((s) => s !== 'text').length;
    const structureRatio = total ? Math.round((structureCount / total) * 100) : 0;
    const textRatio = 100 - structureRatio;
    const content = page.text ? pickByContent(page.text, 3) : [];
    // 已有形态 = 图型块 + 手写结构标记（后者否则会被当成缺口，见 HANDWRITTEN_SHAPES）
    const already = new Set(seq.filter((s) => s !== 'text'));
    for (const [re, shape] of HANDWRITTEN_SHAPES) if (re.test(String(page.text || ''))) already.add(shape);
    const missing = content.filter((c) => !already.has(c.shape));
    // 单调判据（单一真源）：下面所有提示与「待拍板」都用它，避免两处走偏
    const mono = {
      noStructure: total >= 3 && structureCount === 0,
      sameTypeRun: typeRun >= 3,
      textRun: textRun >= 5,
      highTextRatio: textRatio > 60 && total >= 4,
      oneShape: total >= 4 && shapes === 1,
    };
    const monotonous = Object.values(mono).some(Boolean);

    const notes = [];
    if (mono.noStructure) notes.push('整页没有任何结构块：全是文字/列表 → 至少升格一个结构图');
    if (mono.sameTypeRun) notes.push(`连续 ${typeRun} 个同一图型 → 换一个，建议：${pickFiller([seq[0]])}`);
    if (mono.textRun) notes.push(`连续 ${textRun} 个纯文字块 → 从池里补一个结构，建议：${pickFiller([seq[0]])}`);
    if (mono.highTextRatio) notes.push(`纯文本占比 ${textRatio}% → 降一降（目标 ≤60%），建议补：${pickFiller(seq.filter((s) => s !== 'text'))}`);
    if (mono.oneShape) notes.push('全页只有一种图型 → 相邻节换一种结构');
    // 内容匹配优先于防单调：本页文字像哪种形态，就该优先用它
    if (missing.length) {
      notes.push(`内容形态更像 ${missing[0].shape}（命中：${missing[0].matched.slice(0, 3).join('、')}）→ 按内容优先选它，而不是等单调提示`);
    }

    // 第 4 级兜底：内容无信号 + 结构单调 → 不擅自加图，列「待拍板」交回使用者
    const asks = collectAsks(page.text, already, monotonous, Object.keys(mono).filter((k) => mono[k]), new Set(page.optOut || []));
    report.push({ page: page.id || page.file || '(未命名)', total, counts, typeRun, textRun, structureRatio, textRatio, content, missing, already: [...already], monotonous, asks, notes, ok: notes.length === 0 });
  }
  return report;
}

module.exports = { SHAPES, SHAPE_HINTS, HANDWRITTEN_SHAPES, FILLER_POOL, ASK_MAX_PER_PAGE, ASK_CANDIDATES, ASK_MIN_PROSE, pickFiller, pickByContent, splitPoints, proseLength, collectAsks, validateBlock, renderBlock, renderBlocks, audit, ESC, node, treeList };
