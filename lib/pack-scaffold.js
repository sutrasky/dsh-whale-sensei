/**
 * pack-scaffold.js — 在**空目录**里「建好一个课程包」（引擎 + 骨架）
 * ------------------------------------------------------------------
 * 为什么要有它：插件装上了、`packRoot` 也选了，但使用者**手上没有课程包**——
 * `whale_style` 缺 `templates/contract.css` 与 `presets/whale-sensei.css` 会直接抛错；
 * `whale_build` 依赖包内 `tools/shape-render.js`；`whale_ask` 写回要 shell-out 到
 * `tools/drain-questions.js` / `tools/build-notes.js`。
 * 所以「建包」= 把**引擎件**铺进空目录 + 生成空台账，一步到位。
 *
 * 引擎件来自 `lib/pack-template/`（**内容-free**：`assets/glossary-data.js` 是空骨架，
 * 一个学生名词都没有）。模板与课程包侧 `skill-draft/` 的逐字节一致性由
 * `test/pack-template-parity.mjs` 钉住 —— 改一边必须同步另一边。
 *
 * 铁律：
 *   · **只往空目录里建**（非空一律拒绝：不合并、不覆盖、不猜）——
 *     删不掉的东西不猜，这是本项目对「不可恢复操作」的一贯立场。
 *   · 不读 cwd、不读环境变量：`dir` 由调用方给（路径单点计算）。
 *   · 落盘先写 `.tmp-<pid>` 再 rename；失败清理临时文件，**不留半成品**。
 *
 * 契约：
 *   looksLikePack(dir) -> boolean
 *   isEmptyDir(dir)    -> { ok, empty, error? }
 *   planScaffold(dir)  -> { ok, plan?, error? }   // 只算不写
 *   writeScaffold(dir) -> { ok, created[], bytes, error? }
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPracticeDataModule } from './practice.js'   // 空实践区骨架复用真生成器的序列化（同形不靠手抄）

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 随包发的模板目录（引擎件的唯一来源） */
export const TEMPLATE_DIR = path.join(HERE, 'pack-template')

/**
 * 模板文件清单（POSIX 相对路径，顺序即写入顺序）。
 *
 * ⚠️ 这里只放**清单**：每份件从课程包哪里来、做了哪些中性化替换，记在
 *    `test/pack-template-rules.mjs`（那份**故意**住 test/：它写着要替换掉的机器专属字符串，
 *    放进随包的 lib/ 会被 alien-env 的静态守卫判红）。两份清单的一致性由
 *    `test/pack-scaffold.mjs` 断言 —— 两处列表不许漂。
 */
export const TEMPLATE_FILES = [
  // —— 设计基底：whale_style 的两块输入 + 派生出来的产物 ——
  'templates/contract.css',
  'presets/whale-sensei.css',
  'assets/theme.css',
  // —— 课程页外壳引用的前端件（少一个页面就是坏的）——
  'assets/_frame.html',
  'assets/styles.css',
  'assets/glossary.css',
  'assets/ask.css',
  'assets/lesson-blocks.css',
  'assets/notes.css',
  'assets/a11y-print.css',
  'assets/theme-boot.js',
  'assets/theme.js',
  'assets/glossary.js',
  'assets/glossary-data.js',
  'assets/quiz.js',
  'assets/ask.js',
  'assets/lesson-blocks.js',
  'assets/notes.js',
  'assets/notes-width.js',
  'assets/page-splitter.js',
  'assets/adjust.js',
  // —— 引擎（插件会直接 require 或 shell-out 的那些）——
  'assets/check-terms.js',
  'tools/shape-render.js',
  'tools/style-adapter.js',
  'tools/style-check.js',
  'tools/build-lessons.js',
  'tools/build-notes.js',
  'tools/drain-questions.js',
  'tools/ask-server.js',
  // 上面几个的传递依赖（漏一个 = 建完跑不动）
  'tools/fingerprint.js',   // ask-server 判「快照新鲜度」要它（2026-09-24 ①点亮换钉子）
  'tools/lesson-map.js',
  'tools/pack-text.js',
  'tools/title-classes.js',
  // —— 星图引擎（2026-09-24 批3：新包长出来就要有星图，不能"建了圈没有任何星图可言"）——
  'tools/build-starmap.js',     // 星图数据生成器（lessons/** → starmap/content.js）
  'tools/plan-map.js',          // 知识点地图的判据（build-starmap.js 的直接依赖：算"规划中暗星"的前沿）
  'tools/build-starmap-svg.js', // 静态版 SVG（内联进 starmap/index.html 的标记区）
  'tools/galaxy-shapes.cjs',    // 星系形状字典（build-starmap.js 的直接依赖）
  'starmap/data-layer.js',      // 坐标与状态机（build-starmap-svg.js 的直接依赖）
  // —— **交互版**星图（2026-09-24 主人定「交互版星图随包」：插件要独立做到本机所有功能）——
  //    页面壳 starmap/index.html 也是模板件（经中性化：标记区换成「建第一个圈」引导，
  //    见 test/pack-template-rules.mjs 的 SANITIZE）—— 静态版/交互版从此一个壳。
  'starmap/main.js',                  // WebGL 星图渲染器（旋转 / 点选 / 悬停面板 / 规划暗星）
  'starmap/index.html',               // 页面壳（探针按需加载 main.js；无 WebGL 自动静态降级）
  'starmap/vendor/three/three.module.js', // three.js r186 核心（main.js 的直接依赖）
  'starmap/vendor/three/three.core.js',
  'starmap/fonts/Lanxi-JingHei.woff2',    // 星图界面字体（二进制件：字节级对拍，见 FROM_PACK_BINARY）
  'starmap/fonts/Lanxi-HeiTiLight.woff2',
  'assets/starmap.ico',               // 星图页 favicon（tools/make-icon.js 生成的那份）
  // —— 建包就能建圈（2026-09-24 主人选 a 方案）——
  //    新包原先缺这三件，后果是：① 没有圈色冻结表 → pickCircleColor 拒色 → **连第一个圈都建不出来**；
  //    ② 建圈五条链的第 1、4 条（circle-bands / build-glossary）在包里不存在，产物长不全。
  'assets/circle-bands-data.js', // 圈色冻结表（跨项目归档 freeze.mjs 冻出来的那份）
  'tools/circle-bands.js',       // 拿冻结表生成色带 CSS —— 建圈链第 1 条
  'assets/build-glossary.js',    // 术语产物生成器 —— 建圈链第 4 条
  // —— 2026-09-24 主人定：**课程包在别人电脑上新建、每个人独立**，所以框架的构建器
  //    必须全随包。下面这批原先只活在作者那台机器的包里 —— 新包建出来会 404 / 跑不动：
  //    · 课程页运行时缺 lesson-fs.js / practice.js → 每张课程页都在报 404（_frame.html 引用）
  //    · 名词地图缺页面壳 + 三份运行时 + 生成器 → 那整页是死的
  //    · 笔记文档页缺 notes-page.css → NOTES.html 裸奔
  //    · 缺预览服务器 → 学生没法在浏览器里看自己的课
  'glossary/index.html',           // 名词地图页面壳（**手写**，不是产物：没有任何生成器写它）
  'assets/glossary-map.js',        // 地图运行时（读 assets/glossary-tree.js）
  'assets/glossary-map.css',
  'assets/glossary-map-layout.js', // 蜂窝排布（glossary-map.test.mjs 的判据对象）
  'tools/build-glossary-tree.js',  // 生成 assets/glossary-tree.js —— 建圈链第 6 条
  'assets/lesson-fs.js',           // 课程页运行时（_frame.html 第 142 行引用）
  'assets/practice.js',            // 实践区运行时（_frame.html 第 134 行引用）
  'assets/notes-page.css',         // 笔记文档页 reference/NOTES.html 的样式
  'assets/build-questions.js',     // 答疑台账 → QUESTIONS.md
  'tools/build-public.js',         // 公开站构建器（白名单 + 中性化，待改清单 §13）
  'tools/app-server.js',           // 本地预览服务器（默认 3091）；它只 require ./ask-server.js
  'tools/make-icon.js',            // 画 assets/starmap.ico（favicon 的生成器，零依赖）
]

/** 需要建出来的空目录（相对路径） */
export const SCAFFOLD_DIRS = [
  'assets',
  'presets',
  'templates',
  'styles',
  'lessons',
  'lessons/src',
  'questions',
  'notes',
  'learning-records',
  'reference',
  'code',
  'starmap',   // 空星图的家（starmap/content.js 由 skeletonFiles 生成；index.html 从模板拷）
]

/** 一个目录「像课程包」的判据：有预设文件，或已经有 lessons/ */
export function looksLikePack(dir) {
  if (!dir) return false
  try {
    if (fs.existsSync(path.join(dir, 'presets', 'whale-sensei.css'))) return true
    return fs.existsSync(path.join(dir, 'lessons'))
  } catch {
    return false
  }
}

/** 目录是否**空**（不存在 / 读不动都算不空，并给出原因） */
export function isEmptyDir(dir) {
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return { ok: false, empty: false, error: `不是目录：${dir}` }
  } catch {
    return { ok: false, empty: false, error: `目录不存在：${dir}` }
  }
  try {
    return { ok: true, empty: fs.readdirSync(dir).length === 0 }
  } catch (e) {
    return { ok: false, empty: false, error: `读不动这个目录：${e?.message ?? e}` }
  }
}

/** 空答疑台账（UMD 形状与课程包那份一致，见 assets/questions-data.js 的注释） */
function emptyQuestionsJs() {
  return `/**
 * questions-data.js — 答疑台账（**建包时是空的**，由答疑写回往里登记）
 * ------------------------------------------------------------------
 * 浏览器：<script src="../assets/questions-data.js"></script> 之后用 window.QUESTIONS
 * Node  ：require('./questions-data.js') —— build-lessons.js / build-notes.js 读它
 *
 * 键名就是四位编号；字段含义见课程包侧 assets/questions-data.js 的注释。
 * 这个文件**不要手改**：写回走插件的 /api/whale/answer，归档走 tools/drain-questions.js。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QUESTIONS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    // 学生真实提出过的疑问按编号登记在这里
  };
});
`
}

/** 新包的 README —— 说清「这里有什么 / 还缺什么 / 下一步做什么」 */
function packReadme(dirName) {
  return `# 课程包：${dirName}

这个目录是**鲸师插件**在空文件夹里建好的课程包骨架：引擎已就位，**课程内容还是空的**。

## 现在就能用的

\`\`\`bash
# 起本地服务（课程页 / 笔记页 / 疑问箱都从这里看）
node tools/ask-server.js

# 重新渲染课程页（源文件在 lessons/src/，产物落在 lessons/）
node tools/build-lessons.js

# 重建笔记文档页（reference/NOTES.html）
node tools/build-notes.js

# 名词台账自检（键名 / 死链 / 注解规范写法）
node assets/check-terms.js

# 重建星图数据（建圈 / 建课之后跑；建包时已经生成好 0 圈的空星图，这一步不等第一次建圈）
node tools/build-starmap.js

# 主题合成（templates/contract.css + presets/whale-sensei.css → assets/theme.css）
node tools/style-adapter.js
\`\`\`

## 目录一览

| 路径 | 是什么 |
|---|---|
| \`lessons/src/\` | **课的源文件**（\`NNNN-*.html\`，你或 agent 写这里） |
| \`lessons/<圆圈>/<知识点>/\` | 圆圈 \`halo.json\` / 知识点 \`point.json\`（归属与显示名） |
| \`assets/\` | 页面外壳与组件（\`_frame.html\`、\`theme.css\`、\`styles.css\`…） |
| \`templates/contract.css\` + \`presets/whale-sensei.css\` | 主题的两块输入（**改样式先改这里**） |
| \`assets/glossary-data.js\` | 名词台账（**空骨架**，边写课边登记） |
| \`assets/questions-data.js\` | 答疑台账（空） |
| \`questions/pending.jsonl\` | 学生疑问队列（插件写、你答完归档） |
| \`notes/notes.jsonl\` | 学生笔记 |
| \`learning-records/\` | 学情摸底与学习记录 |
| \`code/\` | **学生自己的代码**（插件只读不写；\`EXPECT.json\` 声明期望） |
| \`starmap/\` | 星图（\`content.js\` 数据 / \`index.html\` 页面 / \`static.svg\` 构建期快照） |
| \`reference/NOTES.html\` | 笔记文档页（\`node tools/build-notes.js\` 生成） |

## 还缺什么（按需补）

- ~~星图的交互版~~（2026-09-24 起**已随包**）：打开 \`starmap/index.html\` 就是 WebGL 星图
  （旋转 / 点选 / 悬停面板 / 规划中暗星），无 WebGL 或系统开「减少动效」时**自动降级**
  成静态版（构建期快照 \`starmap/static.svg\`，页面里有降级说明与逃生门）。引擎与素材齐了：
  \`tools/build-starmap.js\` / \`build-starmap-svg.js\` / \`galaxy-shapes.cjs\` / \`tools/plan-map.js\` /
  \`starmap/data-layer.js\` / \`starmap/main.js\` / \`starmap/vendor/three/\` / \`starmap/fonts/\`。
- **名词地图 / 页面拆分器 / 小测**等进阶前端件：同上，按需从课程包框架补。
- **闸门**：本骨架不含课程包闸门（\`tools/gate.mjs\`）；插件侧有自己的判据（\`whale_audit\`）。

## 空包的三个"看起来像坏了、其实没坏"

1. \`node tools/build-lessons.js\` 在没有课程源时会 **exit 1** 并说 \`没有找到源文件（lessons/src/*.html）\`
   —— 那是引擎在**拒绝空构建**（与本项目"跳过 ≠ 通过"同一条纪律），不是装坏了。写了第一节课的源文件之后就正常。
2. \`reference/NOTES.html\` 现在还不存在（\`build-notes.js\` 会跳过并说明原因）—— 等有第一节课再生成。
3. \`node tools/build-starmap.js\` 在**一个圆圈都还没有**时会 **exit 1** 并说
   \`没有找到任何 lessons/<halo>/halo.json —— 星图无从生成\` —— 同一条纪律（拒绝空构建、
   **不塞默认圈假进度**）。建包时已经生成好 0 圈的空星图，那一步现在不用跑；建了第一个圆圈再跑就正常。

## 下一步

1. 在 DSH 里让 agent 用 \`whale_intake\` 摸底 → \`whale_author\` 生成第一节课的源文件骨架；
2. \`whale_build\` 渲染 → 起 \`tools/ask-server.js\` 在浏览器里看；
3. 学生提问 → \`/api/whale/ask\` 落到 \`questions/pending.jsonl\` → 你解答 → 写回并重建。
`
}

/**
 * 空星图的数据骨架 —— `window.STARMAP_REAL` 的**同一契约**（顶字段与键序
 * 与课程包侧 `tools/build-starmap.js` 的载荷一致；那条契约由 `test/mirror-parity.mjs`
 * 第 ④ 节对拍钉住，生成器加字段而这里没跟上会当场红）。
 *
 * 为什么是**建包时手写骨架**而不是"跑一次生成器"：`build-starmap.js` 对 0 个圆圈是
 * **拒绝生成**的（`没有找到任何 lessons/<halo>/halo.json —— 星图无从生成`，exit 1）——
 * 要让它跑起来只能塞一个默认圈当地基，那是**假进度**（比没有进度更伤），所以不干。
 * 这份骨架**纯空**：0 个圈、0 个知识点、0 门课程，只有底图。建了第一个圆圈跑
 * `node tools/build-starmap.js`，这个文件会被生成器接管。
 */
function emptyStarmapJs() {
  return `// 空星图（建包时生成的骨架）—— 0 个知识圆圈 / 0 个知识点 / 0 门课程，**纯空**。
// 不塞默认圈当地基（假进度比没有进度更伤）。键序与 tools/build-starmap.js 的载荷一致；
// 建了第一个圆圈跑 \`node tools/build-starmap.js\`，本文件会被那个生成器接管
// （它的头一行会写「由 tools/build-starmap.js 生成 —— 不要手改」）。
window.STARMAP_REAL = {
  "termTotal": 0,
  "halos": [],
  "lessons": [],
  "edges": []
};
`
}

/**
 * 空实践区的数据骨架 —— `assets/practice-data.js` 的**同一契约**（顶字段与键序跟
 * 插件 `whale_practice` 的真实产出一致；这里直接复用它的序列化器 `renderPracticeDataModule`，
 * 不手抄第二份 UMD —— 形状由代码保证，生成器加字段而这里没跟上会当场对不上）。
 *
 * 为什么必须建包就有：模板 `assets/_frame.html` 一进课就 `<script src=".../practice-data.js">`，
 * 没有它新包每张课程页都 404、实践区不渲染（要等跑过一次 `whale_practice write=true` 才有）。
 * 这份骨架**纯空**：0 项（`lessons` / `byFile` 都是空对象）—— 不塞假进度；
 * `practice.js` 消费它不报错、不猜（找不到这一课的条目就保持隐藏）。
 * 跑一次 `whale_practice write=true` 后本文件会被插件生成器接管（形状不变，只是长出内容）。
 */
function emptyPracticeDataJs() {
  const js = renderPracticeDataModule({
    version: 2,
    keyScheme: 'lesson-id',
    source: 'learning-records/state.json',
    lessons: {},
    byFile: {},
  })
  // 头上补一句「这是建包骨架」（锚点是头注释块的收尾 `*/`；万一生成器头变了，这句悄悄不生效，
  // 文件形状仍然对 —— 所以判据另有一条：骨架 payload 的顶字段与真产出同形）。
  return js.replace('\n */\n', '\n *\n * **建包骨架**：0 项（lessons / byFile 都空）—— 不塞假进度。\n * 跑一次 `whale_practice write=true` 后本文件会被插件生成器接管（形状不变，只是长出内容）。\n */\n')
}

/**
 * 空星图的页面骨架 —— **已退役**（2026-09-24「交互版星图随包」）：
 * 页面壳改从模板拷 `starmap/index.html`（静态 / 交互一个壳），标记区的「建第一个圈」
 * 引导由 test/pack-template-rules.mjs 的 SANITIZE 规则中性化出来 —— 全仓只有一份壳。
 */

/** 骨架文件（内容生成，不从模板拷） */
export function skeletonFiles(dir) {
  const dirName = path.basename(path.resolve(dir)) || 'course'
  return [
    { path: 'assets/questions-data.js', content: emptyQuestionsJs() },
    // —— 空实践区数据（照空星图的先例：建包就有，不等第一次跑 whale_practice）——
    //    `_frame.html` 进课就 <script> 它，缺了新包每张课程页 404、实践区不渲染。
    { path: 'assets/practice-data.js', content: emptyPracticeDataJs() },
    { path: 'lesson.config.json', content: `{\n  "style": {\n    "source": "raw-html-v2",\n    "slug": "whale-sensei"\n  }\n}\n` },
    { path: 'styles/_INDEX.md', content: `# 风格索引（本包自带的只有一份内置基础）\n\n- whale-sensei — 鲸师 · 适用全部课程\n` },
    { path: 'questions/pending.jsonl', content: '' },
    { path: 'questions/processed.jsonl', content: '' },
    { path: 'notes/notes.jsonl', content: '' },
    // —— 空星图（2026-09-24 批3）：建包时就生成，不等第一次建圈 ——
    //    页面壳 starmap/index.html **从模板拷**（2026-09-24 起）：静态 / 交互一个壳，
    //    标记区的「建第一个圈」引导由模板的中性化规则保证（test/pack-template-rules.mjs）。
    { path: 'starmap/content.js', content: emptyStarmapJs() },
    { path: '.gitattributes', content: `# 锁定字节：这个课程包参与逐字节对拍（产物 vs 源），一律不做行尾转换。\n* -text\n` },
    { path: '.gitignore', content: `node_modules/\ndist/\n` },
    { path: 'README.md', content: packReadme(dirName) },
  ]
}

/**
 * 算一份建包计划（**只算不写**）。
 * @param {string} dir 目标目录（必须是**空目录**）
 * @returns {{ok: boolean, plan?: object, error?: string}}
 */
export function planScaffold(dir) {
  if (!dir || !String(dir).trim()) return { ok: false, error: '没有给目录' }
  const abs = path.resolve(String(dir).trim())

  if (looksLikePack(abs)) return { ok: false, error: `这里已经是一个课程包，不需要建：${abs}` }
  const empty = isEmptyDir(abs)
  if (!empty.ok) return { ok: false, error: empty.error }
  if (!empty.empty) {
    return { ok: false, error: `这个目录不是空的（建包只往空目录里建，不合并、不覆盖）：${abs}` }
  }

  // 模板件必须在（缺一个就说明插件装坏了 —— 明确报错，不静默少建）
  const missing = TEMPLATE_FILES.filter((f) => !fs.existsSync(path.join(TEMPLATE_DIR, f)))
  if (missing.length) {
    return { ok: false, error: `插件模板不完整（缺 ${missing.length} 个文件）：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}` }
  }

  return {
    ok: true,
    plan: {
      dir: abs,
      dirs: [...SCAFFOLD_DIRS],
      copies: TEMPLATE_FILES.map((rel) => ({ from: path.join(TEMPLATE_DIR, rel), path: rel })),
      writes: skeletonFiles(abs).map((w) => ({ path: w.path, content: w.content })),
    },
  }
}

/** 原子写：先 .tmp-<pid> 再 rename */
function writeAtomic(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, abs)
    return { ok: true }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    return { ok: false, error: `写不动 ${abs}：${e?.message ?? e}` }
  }
}

/**
 * 真建。任何一步失败都**就地停下并报出已经建了什么**（不假装成功）。
 * @param {string} dir
 * @returns {{ok: boolean, dir?: string, created?: string[], bytes?: number, error?: string}}
 */
export function writeScaffold(dir) {
  const p = planScaffold(dir)
  if (!p.ok) return { ok: false, error: p.error }
  const { plan } = p
  const created = []
  let bytes = 0

  try {
    for (const d of plan.dirs) fs.mkdirSync(path.join(plan.dir, d), { recursive: true })
    for (const c of plan.copies) {
      const abs = path.join(plan.dir, c.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.copyFileSync(c.from, abs)
      created.push(c.path)
      bytes += fs.statSync(abs).size
    }
    for (const w of plan.writes) {
      const r = writeAtomic(path.join(plan.dir, w.path), w.content)
      if (!r.ok) return { ok: false, dir: plan.dir, created, bytes, error: r.error }
      created.push(w.path)
      bytes += Buffer.byteLength(w.content, 'utf8')
    }
  } catch (e) {
    return { ok: false, dir: plan.dir, created, bytes, error: `建包中途失败：${e?.message ?? e}` }
  }

  return { ok: true, dir: plan.dir, created, bytes }
}
