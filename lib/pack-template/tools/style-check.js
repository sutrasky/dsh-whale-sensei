#!/usr/bin/env node
/**
 * style-check.js —— S2 风格断言层（档位 B · 2026-09-19）
 * ==================================================================
 * 五条规则（对应 _plugin-prep/HTML-STYLE-INVENTORY.md 的 S2 行）：
 *   ① R1 禁裸色值 —— 范围严格限定在「CSS 声明」与「内联 style 内部」
 *      （**不能扫 HTML 正文**：`#0001` 这种疑问编号会被粗正则当成 hex，实测踩过）
 *   ② R2 令牌完备 —— 每个 var(--x) 都要有声明，且颜色类令牌浅/深一一配对
 *   ③ R3 对比度分级 —— 正文/次要文字 ≥4.5；弱文字 ≥3.0；DSH 继承来的已知例外冻结留档
 *   ④ R4 跨页一致 —— 同名选择器只允许定义一次；跨文件重复定义同一个类 = 漂移
 *   ⑤ R5 封禁 {{PAGE_STYLE}}（src 里出现 <style> 即红）；内联 style 允许但只许引用令牌
 *      （禁色值字面量、禁 font-size；间距只记录不判死 —— 见「观察项」）
 *
 * 用法：
 *   node tools/style-check.js              # 跑全部规则
 *   node tools/style-check.js --selftest   # 只用固定样例验证规则本身（2 红 2 绿）
 *   node tools/style-check.js --quiet      # 只留结论
 *
 * 存量债务：BASELINE 里登记的是「S2 上线前就存在」的问题，只减不增。
 * 清掉一条就把对应数字下调 —— 下调后会提示你「债务已减少」，不视为失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSS_FILES = ['theme.css', 'styles.css', 'lesson-blocks.css', 'glossary.css', 'ask.css', 'notes.css', 'notes-page.css', 'a11y-print.css'];
const COLOR_RE = /(?:^|[\s,:(])(#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|rgba?\(|hsla?\()/;

/** 存量债务（只减不增）。数字 = 当前实际值，清完一条就把数字改小。 */
const BASELINE = {
  // ① 组件 CSS 里的裸色值处数（注释里的不算；theme.css 的令牌块不算）
  // S3（2026-09-19）已全部清零：lesson-blocks 3→0、glossary 10→0、ask 4→0（全部令牌化）。
  // 表清空后不再有"存量额度" —— 任何新增裸色值都会被直接拦下。
  rawColors: {},
  // ④ 跨文件重复定义同一个类 / 完全相同的选择器重复出现
  duplicateClasses: [],
  // ④ 页面里用到、但 5 个 CSS 里都没有定义的类
  orphanClasses: [],
};

/* ============================ 纯函数（可被 selftest 直接用） ============================ */

/** 用空格替换注释，保留行号与列位 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 抽出一段 CSS 里的「令牌块」行号区间（theme.css 的 :root 与深色块，值允许裸色） */
function tokenBlockRanges(css) {
  const ranges = [];
  const re = /(:root|body\[data-ds-dark-theme\])\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const start = m.index;
    const end = css.indexOf('}', start); // 单行 :root{} 也要能收（之前只找 \n}，单行样例会漏）
    if (end > 0) ranges.push([start, end]);
  }
  return ranges;
}

/** 找流彩标题规则块（§3：h1 动态 `.rainbow-title` + h2/h3 静态 `.rainbow-subtitle`）。
 *  色带值本身**不在这里豁免** —— 它已做成主题令牌（`--lesson-rainbow-band`，住在 presets →
 *  theme.css 的令牌块里），由 tokenBlockRanges() 放行：那才是令牌该在的地方。 */
function rainbowRanges(css) {
  return [...css.matchAll(/\.rainbow-(?:title|subtitle)[^{]*\{[^}]*\}/g)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * 抽 @media print 块的字符区间。打印是**另一个介质**：那里要的是绝对黑白，
 * 不该跟着主题令牌走（深色主题下打印出黑纸是错的）。所以 R1 对 print 块放行，
 * 但另有闸门限定块内只许黑白灰。
 * 块内有嵌套花括号，必须配平扫描 —— 正则数不过来。
 */
function printRanges(css) {
  const out = [];
  const re = /@media\s+print\b[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out.push([m.index, i]);
    re.lastIndex = i;
  }
  return out;
}

const inRanges = (idx, ranges) => ranges.some(([a, b]) => idx >= a && idx <= b);

/** var(--tok, 兜底) —— 兜底值本身不违规；但**色值兜底**会把预设钉死，见 R1b */
const VAR_FALLBACK_RE = /var\(\s*(--[a-z0-9-]+)\s*,\s*([^)]+)\)/g;
const stripVarFallbacks = (text) => text.replace(VAR_FALLBACK_RE, 'var($1)');
/** 取完整的兜底文本（不只 hex —— rgb()/hsl() 也要能被 R1b 看见） */
function collectVarFallbacks(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const m of String(line).matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*([^)]+)\)/g)) {
      out.push({ line: i + 1, token: m[1], fallback: m[2].trim() });
    }
  });
  return out;
}

const COLORISH = /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/;
/**
 * R1b 判据（纯函数）：写出**色值兜底**的 var()。
 * 为什么算违规：`var(--tok, #4176e6)` 把当前预设的颜色抄进了组件 CSS —— 换预设时它就过期，
 * 而 S4 的判据要求"换预设时组件 CSS 一字不改"。令牌存在性改由 R2 在构建期保证。
 */
function colorFallbacks(text) {
  return collectVarFallbacks(text).filter((x) => COLORISH.test(x.fallback));
}

/**
 * R1：CSS 里的裸色值。
 * @param {string} css 原始 CSS
 * @param {{allowTokenBlocks?:boolean, allowRainbow?:boolean, allowPrint?:boolean}} [opts]
 */
function scanCssColors(css, opts = {}) {
  const { allowTokenBlocks = false, allowRainbow = true, allowPrint = false } = opts;
  const clean = stripVarFallbacks(stripComments(css)); // 兜底色值归 R1b 管，这里剥掉
  const skip = [];
  if (allowTokenBlocks) skip.push(...tokenBlockRanges(clean));
  if (allowRainbow) skip.push(...rainbowRanges(clean));
  if (allowPrint) skip.push(...printRanges(clean));
  const hits = [];
  const lines = clean.split('\n');
  let offset = 0;
  lines.forEach((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (!COLOR_RE.test(line)) return;
    if (inRanges(lineStart, skip)) return;
    hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

/**
 * R5：内联 style 的检查（只解析 style="..." 内部，绝不碰正文文字 —— 这条边界就是为 `#0001` 设的）。
 */
function scanInlineStyles(html) {
  const bad = [];
  const observations = [];
  const re = /style\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const line = html.slice(0, m.index).split('\n').length;
    if (COLOR_RE.test(body)) bad.push({ line, rule: '内联 style 含色值字面量', text: body.trim() });
    if (/(^|;)\s*font-size\s*:/.test(body)) bad.push({ line, rule: '内联 style 设 font-size', text: body.trim() });
    for (const mm of body.matchAll(/(margin|padding)[a-z-]*\s*:\s*([^;]+)/g)) {
      observations.push({ line, text: `${mm[1]}: ${mm[2].trim()}` });
    }
  }
  return { bad, observations };
}

/** R5：src 里是否出现 <style>（= 想用 PAGE_STYLE 槽位） */
function scanPageStyle(html) {
  return /<style[\s>]/i.test(html) ? [{ line: 1, rule: 'src 里出现 <style>（PAGE_STYLE 槽位已封禁）' }] : [];
}

/** 解析 theme.css 的浅/深令牌表 */
function parseTokens(css) {
  const grab = (sel) => {
    const m = new RegExp(sel + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(css);
    const out = {};
    if (!m) return out;
    for (const line of m[1].split('\n')) {
      const d = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+)/.exec(line);
      if (d) out[d[1]] = d[2].trim();
    }
    return out;
  };
  return { light: grab(':root'), dark: grab('body\\[data-ds-dark-theme\\]') };
}

/**
 * 解开令牌里的别名（`--a: var(--b)`）—— 对比度计算必须拿到**具体色值**。
 * 为什么要它：新令牌常写成"指向既有层色"的别名；不穿透的话整对对比度会被判"跳过"，
 * 那条断言就等于没上闸（真实发生过：`--lesson-notes-bg` 指向 `--dsw-alias-bg-layer-1`）。
 * 带环保护：最多 4 层，没有变化就停。
 */
function resolveAliases(tokens, depth = 4) {
  const out = { light: { ...tokens.light }, dark: { ...tokens.dark } };
  for (const mode of ['light', 'dark']) {
    const other = mode === 'light' ? 'dark' : 'light';
    for (let i = 0; i < depth; i++) {
      let changed = false;
      for (const [k, v] of Object.entries(out[mode])) {
        const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(String(v).trim());
        if (!m) continue;
        const next = out[mode][m[1]] != null ? out[mode][m[1]] : out[other][m[1]];
        if (next != null && next !== v) { out[mode][k] = next; changed = true; }
      }
      if (!changed) break;
    }
  }
  return out;
}

/** R2：引用与声明的比对 */function checkTokens(css, allText) {
  const { light, dark } = parseTokens(css);
  const declaredLight = Object.keys(light);
  const refs = [...allText.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
  const uniq = [...new Set(refs)];
  // 组件级常量（几何量 / 布局量）不进 theme.css，不参与令牌完备性检查
  const MODE_INVARIANT = ['--dsw-corner-shape', '--dsw-font-family', '--dsw-font-family-mono', '--dsw-font-family-title', '--tilt-rotate-x', '--tilt-rotate-y', '--tilt-glare-x', '--tilt-glare-y', '--tilt-glare-opacity', '--tilt-lift', '--tilt-scale', '--content-w', '--content-left', '--content-min', '--content-max'];
  const missing = uniq.filter((r) => !declaredLight.includes(r) && !MODE_INVARIANT.includes(r));
  const unpaired = declaredLight.filter((t) => !(t in dark) && !MODE_INVARIANT.includes(t));
  const orphans = Object.keys(dark).filter((t) => !(t in light));
  return { declaredLight, declaredDark: Object.keys(dark), uniq, missing, unpaired, orphans, MODE_INVARIANT };
}

/* ---------------------------------- 对比度 ---------------------------------- */

const CONTRAST_PAIRS = [
  ['--dsw-alias-label-primary', '--dsw-alias-bg-base', 4.5, '正文 / 画布'],
  ['--dsw-alias-label-secondary', '--dsw-alias-bg-base', 4.5, '次要文字 / 画布'],
  ['--dsw-alias-label-primary', '--dsw-alias-bg-layer-1', 4.5, '正文 / 卡面'],
  ['--dsw-alias-label-secondary', '--dsw-alias-bg-layer-2', 4.5, '次要文字 / 二层底'],
  ['--dsw-alias-label-primary', '--dsw-alias-markdown-code-block', 4.5, '代码块 字 / 底'],
  ['--dsw-alias-label-primary', '--dsw-alias-markdown-inline-code', 4.5, '行内代码 字 / 底'],
  ['--dsw-alias-label-primary', '--dsw-alias-state-success-tertiary', 4.5, '告示文字 / 成功底'],
  ['--dsw-alias-label-primary', '--dsw-alias-state-warn-tertiary', 4.5, '告示文字 / 警告底'],
  ['--dsw-alias-label-primary', '--dsw-alias-bg-layer-2', 4.5, '告示文字 / 中性告示底'],
  ['--dsw-alias-state-error-primary', '--lesson-danger-bg', 4.5, 'danger 文字 / 底'],
  ['--dsw-alias-link', '--dsw-alias-bg-base', 4.5, '链接 / 画布'],
  ['--lesson-qa-accent', '--lesson-qa-bg', 4.5, '答疑标记 / 答疑底'],
  ['--lesson-review-accent', '--dsw-alias-bg-layer-2', 4.5, '复习标记 / 中性底'],
  ['--dsw-alias-label-tertiary', '--dsw-alias-bg-base', 3.0, '弱文字 / 画布（AA 大字号档）'],
  ['--dsw-alias-label-tertiary', '--dsw-alias-bg-layer-1', 3.0, '弱文字 / 卡面'],
  ['--dsw-alias-label-primary', '--lesson-notes-bg', 4.5, '正文 / 笔记卡底'],
  ['--dsw-alias-label-secondary', '--lesson-notes-bg', 4.5, '次要文字 / 笔记卡底'],
  ['--dsw-alias-label-primary', '--dsw-specific-sidebar-fill', 4.5, '正文 / 侧栏底'],
  ['--dsw-alias-label-secondary', '--dsw-specific-sidebar-fill', 4.5, '次要文字 / 侧栏底'],
];

/**
 * 已知例外（冻结留档）。这些值是 DSH 真值或 DSH+自定的组合，低于阈值但不允许偏离。
 * 规则：低于阈值却不在本表 → 失败；本表里的项若实测值变了（±0.02 外）→ 也失败（该重新评估了）。
 * `preset` 是**归属**：例外台账属于登记它的那个预设（S4）。换到别的预设时不追究本表 ——
 * 别家预设既不能被本表牵连（它的配色不同，债务自然可能消失），也不能偷偷欠债：
 * 低于阈值又没有对应条目，照样失败。
 */
const CONTRAST_DEVIATIONS = [
  { preset: 'whale-sensei', token: '--dsw-alias-link', bg: '--dsw-alias-bg-base', mode: 'light', ratio: 4.23, why: 'DSH deepseek-500 真值，浅色链接 on 白' },
  { preset: 'whale-sensei', token: '--dsw-alias-state-error-primary', bg: '--lesson-danger-bg', mode: 'light', ratio: 4.11, why: 'DSH red-600 + 自定 danger 底' },
  { preset: 'whale-sensei', token: '--dsw-alias-state-error-primary', bg: '--lesson-danger-bg', mode: 'dark', ratio: 4.36, why: 'DSH red-400 + 自定 danger 底' },
];

/** 过期例外（纯函数）：本预设登记过、但这次没被用上 —— 说明值变了，该删条目 */
function staleDeviations(used, preset) {
  return CONTRAST_DEVIATIONS.filter((d) => !used.has(d) && d.preset === preset);
}

function hexLum(hex) {
  let h = normHex(hex).replace('#', '');
  if (h.length !== 6) return null;
  const ch = (i) => {
    const v = parseInt(h.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/** 归一化 hex（#fff → #ffffff，小写）—— 兜底值比较必须归一化，否则 #fff ≠ #ffffff 会误报 */
function normHex(v) {
  let s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
  return s;
}

function ratio(a, b) {
  const la = hexLum(a);
  const lb = hexLum(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function checkContrast(tokens, opts = {}) {
  const preset = opts.preset || 'whale-sensei';
  const results = [];
  const used = new Set();
  for (const mode of ['light', 'dark']) {
    const T = tokens[mode];
    for (const [fg, bg, threshold, label] of CONTRAST_PAIRS) {
      // 配对里的令牌必须存在：删了令牌却留着配对 = 配置腐坏，必须报错（不能静默跳过）
      if (T[fg] == null || T[bg] == null) {
        results.push({ mode, fg, bg, label, threshold, r: null, status: 'missing' });
        continue;
      }
      const r = ratio(T[fg], T[bg]);
      if (r === null) { results.push({ mode, fg, bg, label, threshold, r, status: 'skip' }); continue; }
      const dev = CONTRAST_DEVIATIONS.find((d) => d.token === fg && d.bg === bg && d.mode === mode);
      if (r >= threshold) results.push({ mode, fg, bg, label, threshold, r, status: 'pass' });
      else if (dev && Math.abs(dev.ratio - r) <= 0.02) { used.add(dev); results.push({ mode, fg, bg, label, threshold, r, status: 'deviation', why: dev.why }); }
      else results.push({ mode, fg, bg, label, threshold, r, status: 'fail' });
    }
  }
  return { results, stale: staleDeviations(used, preset) };
}

/* ---------------------------------- 跨页一致 ---------------------------------- */

/** 抽出「规则头」：一条规则一条记录（classes 数组 + 是否在 @media 内）—— 大括号深度扫描 */
function classSubjects(css) {
  const clean = stripComments(css);
  const out = [];
  let depth = 0;
  let bufStart = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      const sel = clean.slice(bufStart, i).trim().replace(/\s+/g, ' ');
      if (sel && !sel.startsWith('@')) {
        const line = clean.slice(0, bufStart).split('\n').length;
        out.push({ sel, line, inAtRule: depth > 0, classes: [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]) });
      }
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) bufStart = i + 1;
    }
  }
  return out;
}

/* ================================ 编排 ================================ */

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function runChecks({ root, log = console.log } = {}) {
  const assets = path.join(root, 'assets');
  const srcDir = path.join(root, 'lessons', 'src');
  const failed = [];
  const css = {};
  for (const f of CSS_FILES) {
    const t = readIf(path.join(assets, f));
    if (t === null) { failed.push(`缺少样式表 assets/${f}`); continue; }
    css[f] = t;
  }
  const theme = css['theme.css'] || '';
  // 当前预设（S4）：例外台账按预设归属，换预设时不去追究别家登记的债务
  let activeSlug = 'whale-sensei';
  try {
    const conf = require('./style-adapter.js').readConfig();
    if (conf && conf.style && conf.style.slug) activeSlug = conf.style.slug;
  } catch { /* 适配器不在（单跑本文件）→ 用默认预设名 */ }

  // ---- R1 ----
  log('\n[R1] 禁裸色值（范围：CSS 声明 + 内联 style）');
  const rawByFile = {};
  for (const f of CSS_FILES) {
    const hits = scanCssColors(css[f] || '', { allowTokenBlocks: f === 'theme.css', allowPrint: true });
    rawByFile[f] = hits;
  }
  let newRaw = 0;
  for (const f of CSS_FILES) {
    const n = rawByFile[f].length;
    const base = BASELINE.rawColors[f] || 0;
    if (n > base) {
      newRaw += n - base;
      log(`  ❌ assets/${f}: 裸色值 ${n} 处 > 基线 ${base}`);
      rawByFile[f].slice(base).forEach((h) => log(`       L${h.line}: ${h.text.slice(0, 90)}`));
    } else if (n < base) {
      log(`  ⚠️  assets/${f}: 债务已减少（${base} → ${n}），把 BASELINE.rawColors 下调到 ${n}`);
    } else if (n) {
      log(`  ▫️  assets/${f}: ${n} 处存量裸色值（在基线内，S3 清理）`);
    }
  }
  if (newRaw) failed.push(`R1 新增裸色值 ${newRaw} 处`);

  // ---- R1b：组件层禁写色值兜底（S4 改判 · 2026-09）----
  // 旧规则是「兜底值必须等于令牌真值」—— 那等于把预设色抄进组件 CSS：换预设就得改组件 CSS，
  // 与 S4 判据（换预设时组件 CSS 一字不改）直接冲突。新规则：色值兜底一律不许写。
  // 安全网没减：令牌存在性由 R2 在**构建期**保证，且 theme.css 是构建产物、--check 会抓到手改。
  log('\n[R1b] 组件层禁写色值兜底（令牌存在性由 R2 在构建期保证）');
  const colorFb = [];
  for (const f of CSS_FILES) colorFallbacks(css[f] || '').forEach((x) => colorFb.push({ ...x, file: f }));
  if (colorFb.length) {
    failed.push(`R1b 色值兜底 ${colorFb.length} 处`);
    colorFb.forEach((x) => log(`  ❌ ${x.file}:L${x.line} ${x.token} 写了色值兜底 ${x.fallback} —— 换预设时它会过期`));
  } else {
    log(`  ✅ 无色值兜底（非色值兜底不受限）`);
  }

  // ---- R2 ----
  log('\n[R2] 令牌完备（引用都有声明 + 浅/深配对）');
  const allText = Object.values(css).join('\n') + collectLessonText(srcDir);
  const tk = checkTokens(theme, allText);
  log(`  浅色声明 ${tk.declaredLight.length} · 深色声明 ${tk.declaredDark.length} · 被引用 ${tk.uniq.length}`);
  if (tk.missing.length) { failed.push(`R2 未声明的令牌：${tk.missing.join(' ')}`); log(`  ❌ 引用了但未声明：${tk.missing.join(' ')}`); }
  else log('  ✅ 所有 var() 引用都有声明');
  if (tk.unpaired.length) { failed.push(`R2 未配对：${tk.unpaired.join(' ')}`); log(`  ❌ 浅色有、深色没有：${tk.unpaired.join(' ')}`); }
  else log('  ✅ 颜色类令牌浅/深一一配对');
  if (tk.orphans.length) { failed.push(`R2 孤儿令牌：${tk.orphans.join(' ')}`); log(`  ❌ 深色有、浅色没有：${tk.orphans.join(' ')}`); }

  // ---- R3 ----
  log('\n[R3] 对比度分级（正文/次要 ≥4.5 · 弱文字 ≥3.0 · 已知例外冻结）');
  const { light, dark } = parseTokens(theme);
  // 对比度要算具体色值：先把 `var(--x)` 别名穿透，否则别名令牌组成的配对会被判"跳过"= 闸门空转
  const ct = checkContrast(resolveAliases({ light, dark }), { preset: activeSlug });
  log(`  ▫️  当前预设：${activeSlug}（只追究本预设登记的例外台账）`);
  for (const r of ct.results) {
    if (r.status === 'missing') {
      failed.push(`R3 配对的令牌不存在：${r.mode} ${r.fg} / ${r.bg}`);
      log(`  ❌ R3 配对的令牌不存在（删了令牌要同步删配对）：${r.fg} / ${r.bg}`);
      continue;
    }
    if (r.status === 'skip') { log(`  ▫️  ${r.label} 跳过（非纯 hex）`); continue; }
    const tag = r.status === 'pass' ? '✅' : r.status === 'deviation' ? '▫️' : '❌';
    const extra = r.status === 'deviation' ? `  ← 已知例外：${r.why}` : '';
    log(`  ${tag} ${r.mode === 'light' ? '浅' : '深'} ${r.label.padEnd(22)} ${String(r.r).padStart(5)} / ${r.threshold}${extra}`);
    if (r.status === 'fail') failed.push(`R3 对比度不足：${r.mode} ${r.label} = ${r.r} < ${r.threshold}`);
  }
  if (ct.stale.length) {
    failed.push(`R3 例外记录过期 ${ct.stale.length} 条`);
    ct.stale.forEach((d) => log(`  ❌ 例外已不成立（值变了就该删）：${d.mode} ${d.token} / ${d.bg}`));
  }

  // ---- R4 ----
  log('\n[R4] 跨页一致（同一类不许跨文件重复定义；同文件内重复只记录）');
  const byFile = {};
  const clsFiles = new Map();
  for (const f of CSS_FILES) {
    byFile[f] = classSubjects(css[f]);
    for (const s of byFile[f]) {
      for (const c of s.classes) {
        if (!clsFiles.has(c)) clsFiles.set(c, new Set());
        clsFiles.get(c).add(f);
      }
    }
  }
  // 同文件内同一选择器出现多次：CSS 层叠是合法写法（@media 覆盖、渐进增强），只记录不判死
  const dupSameFile = [];
  for (const f of CSS_FILES) {
    const seen = new Map();
    for (const s of byFile[f]) if (!s.inAtRule) seen.set(s.sel, (seen.get(s.sel) || 0) + 1);
    for (const [sel, n] of seen) if (n > 1) dupSameFile.push(`${sel}（${f} ×${n}）`);
  }
  // 跨文件重复定义同一个类 = 漂移本尊（历史上 `.term-list` 就是这么裂成两份的）
  // 例外：`.is-*` 是**状态/工具词汇**（.is-current / .is-done / .is-ok …），
  //       按设计允许各组件在自己的上下文里分别着色；组件类没有这个豁免。
  const isStateClass = (c) => c.startsWith('is-');
  const crossFile = [...clsFiles.entries()]
    .filter(([c, s]) => s.size > 1 && !isStateClass(c))
    .map(([c, s]) => `.${c}（${[...s].join(' + ')}）`);
  const stateVocab = [...clsFiles.keys()].filter(isStateClass).sort();
  const dupNew = crossFile.filter((d) => !BASELINE.duplicateClasses.includes(d));
  if (dupNew.length) { failed.push(`R4 跨文件重复定义 ${dupNew.length} 处`); dupNew.slice(0, 12).forEach((d) => log(`  ❌ ${d}`)); }
  else log(`  ✅ 无跨文件重复定义${BASELINE.duplicateClasses.length ? `（存量 ${BASELINE.duplicateClasses.length} 处在基线内）` : ''}`);
  if (stateVocab.length) log(`  ▫️  状态/工具词汇（.is-*，允许跨文件按上下文着色）：${stateVocab.map((c) => '.' + c).join(' ')}`);
  if (dupSameFile.length) {
    log(`  ▫️  同文件内同一选择器出现多次（层叠合法，仅记录）：${dupSameFile.length} 处`);
    dupSameFile.slice(0, 6).forEach((d) => log(`       ${d}`));
  }

  // ---- R5 ----
  log('\n[R5] 封禁 PAGE_STYLE · 内联 style 只许引用令牌');
  const srcFiles = listSrcPages(srcDir);
  let inlineBad = 0;
  const obs = [];
  for (const f of srcFiles) {
    const html = fs.readFileSync(path.join(srcDir, f), 'utf8');
    const ps = scanPageStyle(html);
    const { bad, observations } = scanInlineStyles(html);
    ps.forEach((h) => { inlineBad++; log(`  ❌ ${f}: ${h.rule}`); });
    bad.forEach((h) => { inlineBad++; log(`  ❌ ${f}:L${h.line} ${h.rule} —— ${h.text.slice(0, 70)}`); });
    observations.forEach((o) => obs.push(`${f}:L${o.line} ${o.text}`));
  }
  if (!srcFiles.length) log('  ▫️  没有 lessons/src/*.html 可查');
  if (!inlineBad) log(`  ✅ ${srcFiles.length} 个源文件：无 <style>、内联 style 无裸色值/无 font-size`);
  else failed.push(`R5 命中 ${inlineBad} 处`);
  if (obs.length) {
    log(`  ▫️  观察项（不判死）：内联间距 ${obs.length} 处 —— 8 基数节奏的漂移入口，S3 补工具类后清`);
    obs.slice(0, 8).forEach((o) => log(`       ${o}`));
  }

  // ---- 收尾 ----
  log('\n' + '='.repeat(60));
  if (failed.length) {
    log(`❌ 风格断言未通过：${failed.length} 条`);
    failed.forEach((f) => log(`   · ${f}`));
    return false;
  }
  log('✅ 风格断言全部通过');
  return true;
}

/**
 * 列出作者态源页（递归）：分层布局后是 lessons/src/<圆圈>/<知识点>/NNNN-*.html。
 * 只扫一层会返回 0 个 → R5 与"课内文本合并"都会**假绿**（2026-09-21 实测）。
 * @returns {string[]} 相对 srcDir 的 posix 路径
 */
function listSrcPages(srcDir) {
  if (!fs.existsSync(srcDir)) return [];
  const out = [];
  (function walk(d, prefix = '') {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(d, e.name), rel); continue; }
      if (e.name.endsWith('.html')) out.push(rel);
    }
  })(srcDir);
  return out;
}

function collectLessonText(srcDir) {
  return listSrcPages(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
}

/* ============================== 自检（对照用例） ============================== */

function selftest(log = console.log) {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, expect) => {
    if (cond === expect) { pass++; log(`  ✅ ${name}`); }
    else { fail++; log(`  ❌ ${name} —— 期望 ${expect}，实际 ${cond}`); }
  };

  log('=== style-check 自检（规则本身对不对）===');

  log('\n1) R1 红的样例：CSS 声明里写死颜色');
  const cssBad = '.card { background: #ff0000; }\n.ok { color: var(--dsw-alias-link); }';
  check('裸 hex 被抓到', scanCssColors(cssBad).length === 1, true);

  log('\n2) R1 绿的样例：注释与令牌块里的颜色不算违规，且 `#0001` 不误报');
  const cssOk = '/* 硬编码 #f8f9fa 之类 */\n:root { --dsw-alias-bg-base: #ffffff; }';
  check('注释被剥掉、令牌块被豁免', scanCssColors(cssOk, { allowTokenBlocks: true }).length === 0, true);
  check('正文里的疑问编号 #0001 不误报', scanInlineStyles('<p>你的疑问 #0001</p>').bad.length === 0, true);
  // @media print 是另一个介质：那里要绝对黑白，不该跟主题令牌走（深色下打印出黑纸是错的）
  check('@media print 内的黑白放行', scanCssColors('@media print { body { background: #ffffff; color: #000000; } }', { allowPrint: true }).length === 0, true);
  check('@media print 外照样抓', scanCssColors('@media print { body { color: #000000; } }\n.x { color: #ff0000; }', { allowPrint: true }).length === 1, true);
  check('嵌套花括号的 print 块也能配平', scanCssColors('@media print { .a { color: #111111; } @page { margin: 1cm; } .b { color: #222222; } }', { allowPrint: true }).length === 0, true);

  log('\n3) R5 红的样例：src 里出现 <style>');
  check('<style> 被抓到', scanPageStyle('<style>.x{color:#fff}</style>').length === 1, true);

  log('\n4) R5 绿的样例：内联只引用令牌（B 档的关键，合法需求不能被误杀）');
  const inlineOk = '<p style="margin-top: 1rem; color: var(--dsw-alias-label-secondary);">x</p>';
  check('var() + 间距 → 通过', scanInlineStyles(inlineOk).bad.length === 0, true);
  const inlineBad2 = '<p style="color:#8a6d3b">x</p>';
  check('内联裸色值 → 被抓到', scanInlineStyles(inlineBad2).bad.length === 1, true);

  log('\n5) R1b：色值兜底必须拦下（换预设会过期），非色值兜底放行');
  check('hex 兜底 → 命中', colorFallbacks('.card { color: var(--dsw-alias-link, #4176e6); }').length === 1, true);
  check('rgb() 兜底 → 命中（旧实现只认 hex，会漏）', colorFallbacks('.card { color: var(--x, rgba(0,0,0,.5)); }').length === 1, true);
  check('非色值兜底 → 放行', colorFallbacks('.card { padding: var(--x, 8px); border-radius: var(--y, 1.5); }').length === 0, true);
  check('无色值兜底 → 全清', colorFallbacks(':root { --a: 1; }\n.card { color: var(--dsw-alias-link); }').length === 0, true);

  log('\n6) R3 例外台账按预设归属（别家预设不被牵连，也不能偷偷欠债）');
  check('本预设下例外没用上 → 算过期', staleDeviations(new Set(), 'whale-sensei').length === 3, true);
  check('别的预设 → 不追究本台账', staleDeviations(new Set(), 'probe-x').length === 0, true);

  log('\n7) 令牌别名可穿透（否则别名配对会被判"跳过"，闸门空转）');
  check('一层别名被解开', resolveAliases({ light: { '--a': 'var(--b)', '--b': '#ffffff' }, dark: {} }).light['--a'] === '#ffffff', true);
  check('自引用不死循环', resolveAliases({ light: { '--a': 'var(--a)' }, dark: {} }).light['--a'] === 'var(--a)', true);

  log(`\n=== 自检：${pass} 通过 / ${fail} 失败 ===`);
  return fail === 0;
}

/* ================================== CLI ================================== */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ok = argv.includes('--selftest')
    ? selftest()
    : runChecks({ root: path.join(__dirname, '..'), log: argv.includes('--quiet') ? () => {} : console.log });
  if (argv.includes('--quiet') && !argv.includes('--selftest')) {
    console.log(ok ? '✅ style-check 通过' : '❌ style-check 未通过（去掉 --quiet 看明细）');
  }
  process.exit(ok ? 0 : 1);
}

module.exports = { runChecks, selftest, scanCssColors, scanInlineStyles, scanPageStyle, parseTokens, resolveAliases, checkTokens, checkContrast, staleDeviations, classSubjects, colorFallbacks, printRanges, BASELINE };
