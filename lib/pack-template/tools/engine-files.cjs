/**
 * engine-files.cjs — 「随包引擎件」的**单一名单**（scaffold / export / reader 三处同源）
 * ------------------------------------------------------------------
 * 病（报告 D06）：`lib/pack-export.js` shell-out 到**包内** `tools/build-lessons-index.js`，
 * 而那一件只活在 `lib/pack-template/tools/` 里、**没登记进** `lib/pack-scaffold.js#TEMPLATE_FILES`
 * ⇒ `writeScaffold` 建出来的新包缺它 ⇒ `exportLesson` 永远停在「生成课程星清单失败」。
 *
 * 那种缺口的形状是「模板目录里有、随包清单里没有」。靠人眼比对两张表堵不住：
 * 三处（建包 / 导出 / 读取）各写一份「我需要哪些件」，任何一处加件都可能漏掉另一处。
 * 所以这里只做一件事：**一处算、多处用**。
 *
 *   · `engineFiles()` / `{profile:'pack'}` —— 模板目录里的**随包代码闭包**（机械走目录，
 *     不是手抄第二份表）。`lib/pack-scaffold.js#planScaffold` 拿它当闸：模板里多一个
 *     没登记的脚本件 ⇒ 建包**当场报错**（不静默少建一个包）。
 *   · `{profile:'export'}` —— `lib/pack-export.js` 真正要 shell-out 的包内脚本。
 *     那个文件**不再自己写脚本名**（同一事实的第二份表达正是 D06 的成因）。
 *   · `{profile:'reader'}` —— 插件侧的课程包**读取链** require 的包内脚本。
 *
 * 为什么本文件住在 `lib/pack-template/tools/` 却**不进** `TEMPLATE_FILES`：它**描述**模板，
 * 不是模板件本身 —— 与 `offline-bootstrap.js` / `offline-server.js` 那几件同性质
 * （那几件是**离线库安装器**通道的件，同样不随课程包模板走；依据见下面的 CODE_EXCLUDE）。
 *
 * 纪律：本文件是**插件侧**模块（不随包），但照样不许写机器专属路径 ——
 * `test/pack-scaffold.mjs` ① 与 `test/alien-env.mjs` 的静态守卫都会扫模板目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 本模块自己的位置：`lib/pack-template/tools/` */
const HERE = __dirname;
/** 默认模板根：`lib/pack-template` */
const TEMPLATE_DIR = path.join(HERE, '..');
/** 什么算「代码件」（`CODE_EXCLUDE` 之外的都要登记） */
const CODE_RE = /\.(js|cjs|mjs)$/;

/**
 * 模板目录里**故意不随课程包模板**的代码件（逐条有据，不是"顺手排除"）：
 *
 *   · 前四件是**离线库安装器**那条链的件 —— 进不进离线骨架由
 *     `tools/offline-bootstrap.js#TOOLS_KEEP` 决定，它们从来不在 `TEMPLATE_FILES` 里；
 *   · 最后一件是本清单自己的实现（插件侧模块，见文件头）。
 *
 * 排除表本身也有判据（`test/audit/T18.mjs` 的 L06）：每个排除项必须在模板里**真的存在**、
 * 且**不许**出现在 `TEMPLATE_FILES` 里 —— 排除表不许烂掉，也不许拿它藏起一件已登记的件。
 */
const CODE_EXCLUDE = [
  'tools/offline-bootstrap.js',
  'tools/offline-server.js',
  'tools/build-offline-installer.js',
  'tools/build-offline-payload.js',
  'tools/engine-files.cjs',
];

/**
 * export 档：`lib/pack-export.js`「导出这一节课」真正要 shell-out 的包内脚本。
 * 依据：`lib/pack-export.js#readIndexEntries` 在 `cwd` = 包根下跑 `node <这条> --print`
 * 取课程星清单（导出侧不在插件里抄第二份 meta 解析）。
 *
 * ⚠️ 判据**不是"表比表"**：`test/audit/T18.mjs` 真建空包 → 加最小课程 → 真导出（`ok:true`），
 * 再把这一件移走复现旧缺口（**必红**），并把 `lib/pack-export.js` 源码里对包内脚本的一切
 * 引用独立抽出来对账（L04 / L08）。
 */
const EXPORT_SCRIPTS = ['tools/build-lessons-index.js'];

/**
 * reader 档：插件侧的课程包**读取链** require 的包内脚本。
 * 依据：`lib/pack-model.js` 里的 `createRequire(import.meta.url)(path.join(ROOT, 'tools', <名>))`
 * —— `lesson-map.js` 是课次映射表的**包侧那一份**（与插件 `lessonIndex()` 逐键对拍），
 * `pack-text.js` 是笔记读取的**剥 BOM 那一份**（少了它带 BOM 的首行会被静默丢成 0 条）。
 *
 * ⚠️ 读取链的**接线**在 `lib/pack-model.js`（不在本卡写范围），所以这一档今天由
 * `test/audit/T18.mjs` 从那个文件的**源码**独立重算后对上（L05），不改产品侧那个文件。
 */
const READER_SCRIPTS = ['tools/lesson-map.js', 'tools/pack-text.js'];

/** 递归列出一个目录下的全部文件（POSIX 相对路径，名字序 —— 确定性） */
function walk(dir, prefix = '', out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
    else out.push(rel);
  }
  return out;
}

/**
 * 随包引擎件的**代码闭包**（POSIX 相对路径）。
 * @param {{profile?: 'pack'|'scaffold'|'export'|'reader', templateDir?: string}} [opts]
 *   · 不传 / `pack` / `scaffold`：模板目录里全部代码件减去 `CODE_EXCLUDE`（机械走目录）
 *   · `export` / `reader`：上面那两档
 * @returns {string[]} **每次都是新数组**（调用方改它不会污染别人）
 */
function engineFiles(opts = {}) {
  const raw = opts.profile;
  const profile = raw === undefined || raw === null || raw === '' ? 'pack' : String(raw);
  if (profile === 'pack' || profile === 'scaffold') {
    const templateDir = opts.templateDir ? String(opts.templateDir) : TEMPLATE_DIR;
    return walk(templateDir).filter((rel) => CODE_RE.test(rel) && !CODE_EXCLUDE.includes(rel));
  }
  if (profile === 'export') return EXPORT_SCRIPTS.slice();
  if (profile === 'reader') return READER_SCRIPTS.slice();
  // 不认识的档**当场报错**：静默回落到"全档"会把闸变成恒真的
  throw new Error(`engineFiles：不认识的 profile（${profile}）—— 只认 pack / scaffold / export / reader`);
}

/**
 * 闸：三档闭包并起来，挑出**没登记进随包清单**的件。
 * @param {string[]} templateFiles 随包清单（`lib/pack-scaffold.js#TEMPLATE_FILES`）
 * @param {{templateDir?: string}} [opts]
 * @returns {string[]} 缺登记的件（稳定排序）；空数组 = 门窗都关好了
 */
function requiredButNotRegistered(templateFiles, opts = {}) {
  const registered = new Set(Array.isArray(templateFiles) ? templateFiles : []);
  const need = [
    ...engineFiles({ profile: 'pack', templateDir: opts.templateDir }),
    ...engineFiles({ profile: 'export' }),
    ...engineFiles({ profile: 'reader' }),
  ];
  return [...new Set(need)].filter((rel) => !registered.has(rel)).sort();
}

module.exports = {
  engineFiles,
  requiredButNotRegistered,
  EXPORT_SCRIPTS,
  READER_SCRIPTS,
  CODE_EXCLUDE,
  TEMPLATE_DIR,
};
