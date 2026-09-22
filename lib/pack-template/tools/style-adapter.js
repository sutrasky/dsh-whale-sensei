/**
 * style-adapter.js —— 风格适配器（S4 · LESSON-PLUGIN-PLAN §7 / §12）
 * ==============================================================
 * 唯一接口：课程包在 `lesson.config.json` 里锁**一个** slug。
 *   ① 校验 slug：存在性以 风格库目录里的 `_INDEX.md` 为准（约 200 个成品）
 *   ② 变更提示：记录风格文档指纹 `docHash`；文档变了 → 提示（§7 明确是"变更提示"，不上闸）
 *   ③ 合成产物：`templates/contract.css` 的注入位 ← `presets/<slug>.css` → `assets/theme.css`
 *   ④ 退路：读不到索引 / slug 名不对 / 预设文件缺失 → 退回**内置基础**（DSH 真值令牌集，同时是默认预设）
 *      并响亮警告；连内置基础都不在 → 直接抛错（准则 10：零兜底 = 静默失效）
 *
 * 「不做」（§7 明确）：不复制风格文档、不解析它的 hex 落库、不实现渲染层。
 * 组件 CSS（styles / lesson-blocks / glossary / ask）**不参与合成** —— 换预设只换令牌值。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'lesson.config.json');
const CONTRACT = path.join(ROOT, 'templates', 'contract.css');
const PRESET_DIR = path.join(ROOT, 'presets');
const THEME = path.join(ROOT, 'assets', 'theme.css');
const MARK = '/* @preset-values */';
const DEFAULT_SLUG = 'whale-sensei';   // 内置基础：DSH 真值令牌集，同时也是默认预设
const INDEX = '_INDEX.md';

/** 风格成品库的位置：配置优先 → 环境变量 → **包内 styles/**（不猜兄弟仓：那只在某台机器的目录布局下成立） */
function stylesDir(style) {
  return (style && style.stylesDir) || process.env.DSH_RAW_HTML_STYLES
    || path.join(ROOT, 'styles');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

/** 索引里的 slug 集合（条目格式：`- <slug> — 名称 · 适用…`）；索引不存在返回 null */
function slugsFromIndex(dir) {
  const p = path.join(dir, INDEX);
  if (!fs.existsSync(p)) return null;
  const set = new Set();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^-\s+([a-z0-9][a-z0-9-]*)\s+—/);
    if (m) set.add(m[1]);
  }
  return set;
}

/** 注入位替换（用函数形式，避免值里的 $ 被当成替换模式） */
function compose(contract, values) {
  if (!contract.includes(MARK)) throw new Error(`契约 ${path.relative(ROOT, CONTRACT)} 里找不到注入位 ${MARK}`);
  return contract.replace(MARK, () => values);
}

const presetPath = (slug) => path.join(PRESET_DIR, `${slug}.css`);

/** 读预设值（去掉尾随空白，保证合成可逐字节复现）；不存在返回 null */
function readValues(slug) {
  const p = presetPath(slug);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\s+$/, '') : null;
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 解析当前该用哪套值，并把该说的话都说出来（永远不静默） */
function load() {
  const warnings = [];
  const conf = readConfig();
  if (!conf || !conf.style) warnings.push(`⚠️ 风格适配器：lesson.config.json 缺失或没有 style 段 → 退回内置基础「${DEFAULT_SLUG}」`);
  const style = (conf && conf.style) || {};
  const slug = style.slug || DEFAULT_SLUG;
  const dir = stylesDir(style);

  const slugs = slugsFromIndex(dir);
  if (!slugs) {
    // 索引读不到（多半是"这台机器上没有配风格库"）。
    // §9（2026-09-22，用户裁「乙」）：**只对内置基础放行** —— 内置基础（DSH 真值令牌集）
    // 自带全部值，不需要索引；但**明确要了非内置 slug 却没法校验它**时，硬失败。
    // 原来这里只 push 一条 warning 就"按内置基础渲染"⇒ 用户以为在用 A 风格、实际拿到 B：
    // 正是本清单一直在消灭的静默降级。判据见 tools/preset-switch.test.mjs 的 ⑦。
    if (slug !== DEFAULT_SLUG) {
      throw new Error(
        `风格适配器：要了非内置 slug「${slug}」，但读不到风格索引 ${path.join(dir, INDEX)} —— 无法校验，拒绝静默降级。\n`
        + `  修法（三选一）：① 在 lesson.config.json 的 style.stylesDir 里显式写风格库目录；`
        + `② 设环境变量 DSH_RAW_HTML_STYLES；③ 只想用内置基础，就把 slug 写成「${DEFAULT_SLUG}」。`,
      );
    }
    warnings.push(`⚠️ 风格适配器：读不到风格索引 ${path.join(dir, INDEX)} → 跳过 slug 校验，按内置基础渲染（slug 本来就是内置基础，无歧义）`);
  } else if (!slugs.has(slug)) {
    warnings.push(`⚠️ 风格适配器：slug「${slug}」不在 _INDEX.md 里 → 仍按内置基础渲染，请检查拼写`);
  }

  let used = slug;
  let fallback = false;
  let values = readValues(used);
  if (values == null) {
    if (used !== DEFAULT_SLUG) {
      warnings.push(`⚠️ 风格适配器：预设 presets/${used}.css 不存在 → 退回内置基础「${DEFAULT_SLUG}」`);
      used = DEFAULT_SLUG;
      fallback = true;
      values = readValues(used);
    }
    if (values == null) throw new Error(`风格适配器：连内置基础 presets/${DEFAULT_SLUG}.css 都不在 —— 拒绝静默降级`);
  }

  let docChanged = false;
  let docHashNow = null;
  if (style.docHash) {
    const md = path.join(dir, `${slug}.md`);
    if (fs.existsSync(md)) {
      docHashNow = sha256(fs.readFileSync(md));
      if (docHashNow !== style.docHash) {
        docChanged = true;
        warnings.push(`ℹ️ 风格文档已变更：「${slug}.md」指纹 ${style.docHash.slice(0, 12)}… → ${docHashNow.slice(0, 12)}…（§7 变更提示，不上闸；确认无碍后把 lesson.config.json 的 docHash 更新为 ${docHashNow}）`);
      }
    }
  }

  const contract = fs.readFileSync(CONTRACT, 'utf8');
  return { config: conf, slug, used, fallback, values, contract, css: compose(contract, values), warnings, docChanged, docHashNow, stylesDir: dir };
}

/** 构建期同步：写产物；`--check` 只比对（漂移 = 非零退出） */
function sync(opts = {}) {
  const log = opts.log || (() => {});
  const r = load();
  for (const w of r.warnings) log(w);
  const existing = fs.existsSync(THEME) ? fs.readFileSync(THEME, 'utf8') : null;
  const same = existing === r.css;
  if (opts.checkOnly) {
    if (same) log(`[check] ✅ 主题产物 assets/theme.css（预设 ${r.used}${r.fallback ? ' · 退路' : ''}）`);
    else log(`[check] ❌ 主题产物 assets/theme.css —— 与「${r.used}」的合成结果不一致（换过预设忘了重建？）`);
    return { ...r, wrote: false, drift: !same };
  }
  if (!same) {
    atomicWrite(THEME, r.css);
    log(`[theme] assets/theme.css ← 契约 + 预设 ${r.used}  ${r.css.length} 字符`);
  }
  return { ...r, wrote: !same, drift: false };
}

/* ---------- 命令行 ----------
   node tools/style-adapter.js            看当前预设、slug 校验与变更提示
   node tools/style-adapter.js --stamp    确认风格文档变更：把当前指纹写回 lesson.config.json
   node tools/style-adapter.js --check    只比对产物（漂移则非零退出） */
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--stamp')) {
    const conf = readConfig();
    if (!conf || !conf.style) { console.error('[stamp] 没有 lesson.config.json 或缺少 style 段，不盖章'); process.exit(1); }
    const r = load();
    if (!r.docHashNow) { console.error(`[stamp] 取不到风格文档指纹（${path.join(r.stylesDir, `${r.slug}.md`)} 不存在？），不盖章`); process.exit(1); }
    conf.style.docHash = r.docHashNow;
    atomicWrite(CONFIG, `${JSON.stringify(conf, null, 2)}\n`);
    console.log(`[stamp] docHash 已更新为 ${r.docHashNow.slice(0, 12)}…（${r.slug}.md）`);
    process.exit(0);
  }
  if (argv.includes('--check')) {
    const r = sync({ checkOnly: true, log: (l) => console.log(l) });
    process.exit(r.drift ? 1 : 0);
  }
  const r = load();
  for (const w of r.warnings) console.log(w);
  console.log(`[style] 预设 ${r.used}${r.fallback ? '（退路）' : ''} · 合成 ${r.css.length} 字符 · 文档指纹${r.docChanged ? '已变更（跑 --stamp 盖章）' : '一致'}`);
}

module.exports = {
  ROOT, CONFIG, CONTRACT, PRESET_DIR, THEME, MARK, DEFAULT_SLUG, INDEX,
  stylesDir, sha256, readConfig, slugsFromIndex, compose, presetPath, readValues, atomicWrite, load, sync,
};
