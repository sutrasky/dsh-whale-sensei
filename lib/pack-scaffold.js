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
  'tools/lesson-map.js',
  'tools/pack-text.js',
  'tools/title-classes.js',
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
| \`reference/NOTES.html\` | 笔记文档页（\`node tools/build-notes.js\` 生成） |

## 还缺什么（按需补）

- **星图**：本骨架**不含**星图（\`tools/build-starmap.js\`、\`starmap/\`）。插件设置页的星图相关行会显示"读不到"。
- **名词地图 / 页面拆分器 / 小测**等进阶前端件：同上，按需从课程包框架补。
- **闸门**：本骨架不含课程包闸门（\`tools/gate.mjs\`）；插件侧有自己的判据（\`whale_audit\`）。

## 空包的两个"看起来像坏了、其实没坏"

1. \`node tools/build-lessons.js\` 在没有课程源时会 **exit 1** 并说 \`没有找到源文件（lessons/src/*.html）\`
   —— 那是引擎在**拒绝空构建**（与本项目"跳过 ≠ 通过"同一条纪律），不是装坏了。写了第一节课的源文件之后就正常。
2. \`reference/NOTES.html\` 现在还不存在（\`build-notes.js\` 会跳过并说明原因）—— 等有第一节课再生成。

## 下一步

1. 在 DSH 里让 agent 用 \`whale_intake\` 摸底 → \`whale_author\` 生成第一节课的源文件骨架；
2. \`whale_build\` 渲染 → 起 \`tools/ask-server.js\` 在浏览器里看；
3. 学生提问 → \`/api/whale/ask\` 落到 \`questions/pending.jsonl\` → 你解答 → 写回并重建。
`
}

/** 骨架文件（内容生成，不从模板拷） */
export function skeletonFiles(dir) {
  const dirName = path.basename(path.resolve(dir)) || 'course'
  return [
    { path: 'assets/questions-data.js', content: emptyQuestionsJs() },
    { path: 'lesson.config.json', content: `{\n  "style": {\n    "source": "raw-html-v2",\n    "slug": "whale-sensei"\n  }\n}\n` },
    { path: 'styles/_INDEX.md', content: `# 风格索引（本包自带的只有一份内置基础）\n\n- whale-sensei — 鲸师 · 适用全部课程\n` },
    { path: 'questions/pending.jsonl', content: '' },
    { path: 'questions/processed.jsonl', content: '' },
    { path: 'notes/notes.jsonl', content: '' },
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
