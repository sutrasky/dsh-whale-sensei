/**
 * test/pack-template-rules.mjs — `lib/pack-template/` 的**来源与中性化规则**（唯一真源）
 * ------------------------------------------------------------------
 * 模板不是手写的，是**从课程包原件派生**的：
 *
 *     模板文件 = 课程包原件（或技能包的空台账骨架）经过下面 SANITIZE 的替换
 *
 * 为什么这份规则住在 `test/` 而不是 `lib/`：它**故意写着**那些机器专属字符串
 * （作者机器上的归档目录名、风格仓名 `dsh-raw-html-v2`）当搜索目标 —— 放进随包的 `lib/`
 * 会被 `alien-env` 的静态守卫当场判红（那正是这条守卫存在的意义）。
 * 运行时只需要文件清单，那份在 `lib/pack-scaffold.js` 的 `TEMPLATE_FILES`；
 * 本文件与它的**一致性由 test/pack-scaffold.mjs 断言**（两处列表不许漂）。
 *
 * 为什么要有这份规则而不是直接拷：
 *   ① 课程包原件里有**只对作者那台机器成立**的东西（归档目录的绝对路径、
 *      `..\dsh-raw-html-v2-master\styles` 这种"猜兄弟仓"的退路）—— 随包发出去就是
 *      把本机布局带进别人机器，`alien-env` 的静态守卫也会当场红。
 *   ② 课程页外壳的页脚写着作者那门课的名字（Spring Boot）—— 新用户的课不是那门课。
 *
 * 判据（`test/pack-scaffold.mjs`）：逐文件核 `sanitize(原件) === 模板`，
 * 并且**每条规则都必须真的命中**（原件改了、规则打空 → 当场红，不许静默失效）。
 */

/** 逐字节取自课程包的件（引擎 + 设计基底，都是当前在用的版本） */
export const FROM_PACK = [
  'index.html',
  'templates/contract.css',
  'presets/whale-sensei.css',
  'assets/theme.css',
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
  'assets/quiz.js',
  'assets/ask.js',
  'assets/lesson-blocks.js',
  'assets/notes.js',
  'assets/notes-width.js',
  'assets/page-splitter.js',
  'assets/adjust.js',
  'assets/check-terms.js',
  'tools/shape-render.js',
  'tools/style-adapter.js',
  'tools/style-check.js',
  'tools/build-lessons.js',
  'tools/build-notes.js',
  'tools/drain-questions.js',
  'tools/ask-server.js',
  // —— 上面几个的传递依赖（**漏一个就"建完跑不动"**，实测：build-notes 缺 lesson-map 直接
  //    `Cannot find module`；闭包用 E:\Temp\closure2.mjs 那种脚本重算，别靠眼看）——
  'tools/fingerprint.js',
  'tools/lesson-map.js',
  'tools/pack-text.js',
  'tools/title-classes.js',
  // —— 星图引擎（2026-09-24 批3：新包长出来就要有星图）；data-layer.js 是 build-starmap-svg
  //    的直接依赖（它 import starmap/data-layer.js 的 layout()），漏了重建链就断 ——
  'tools/build-starmap.js',
  'tools/plan-map.js',
  'tools/build-starmap-svg.js',
  'tools/galaxy-shapes.cjs',
  'starmap/data-layer.js',
  // —— **交互版**星图（2026-09-24 主人定「交互版星图随包」：插件要独立做到本机所有功能）——
  //    缺这四件时新包只有静态 SVG（旋转 / 点选 / 悬停面板全没有）。index.html 走下面的
  //    SANITIZE 规则把标记区换成「建第一个圈」引导 —— **绝不把作者包里的真图当假进度发出去**。
  //    字体与 favicon 是二进制，见 FROM_PACK_BINARY（utf8 文本管线会毁掉字节）。
  'starmap/main.js',
  'starmap/index.html',
  'starmap/vendor/three/three.module.js',
  'starmap/vendor/three/three.core.js',
  // —— 建圈三件（2026-09-24 主人选 a 方案）：缺了它们，新包**连第一个圈都建不出来**
  //    （没有冻结表 → 取色被拒），而且建圈五条链的第 1、4 条在包里不存在 ——
  'assets/circle-bands-data.js',
  'tools/circle-bands.js',
  'assets/build-glossary.js',
  // —— 2026-09-24 主人定：课程包在别人电脑上新建、每个人独立 → 框架的构建器全随包。
  //    这批原先只活在作者那台机器的包里（新包会 404 / 跑不动），四份**没有** SANITIZE 规则
  //    → 判据就是与课程包原件逐字节相等（所以别在原件里写机器路径，静态守卫会红）——
  'glossary/index.html',
  'assets/glossary-map.js',
  'assets/glossary-map.css',
  'assets/glossary-map-layout.js',
  'tools/build-glossary-tree.js',
  'assets/lesson-fs.js',
  'assets/practice.js',
  'assets/notes-page.css',
  'assets/build-questions.js',
  'tools/build-public.js',
  'tools/app-server.js',
  'tools/make-icon.js',
  // —— 2026-09-27：**五个教学技能**（`<packRoot>/skills`，预设的 customSkillDirs 指着它）。
  //    以前模板里没有这份 ⇒ 「图形界面建空课程包」的新用户预设里 0 个技能。
  //    五份**没有** SANITIZE 规则 → 判据就是与课程包原件逐字节相等（所以技能里也不许写机器路径）——
  'skills/whale-system/SKILL.md',
  'skills/whale-lesson/SKILL.md',
  'skills/whale-practice/SKILL.md',
  'skills/whale-qa/SKILL.md',
  'skills/whale-record/SKILL.md',
]

/** 取自课程包侧 `skill-draft/`（技能包）的件：**空台账骨架** —— 一个名词都没有 */
export const FROM_SKILL = ['assets/glossary-data.js']

/**
 * **只随插件发**的模板件：课程包里**没有对应原件**（不是从原件派生，所以不参与
 * `sanitize(原件) === 模板` 那条对拍）。
 *
 * 为什么必须有这一类（T03 / 报告 B01）：共享路径策略 `tools/path-policy.cjs` 是
 * **插件这一侧先有**的件 —— 它要跟着模板进每一个新建的课程包（否则新包里的
 * `tools/` 少一件，包侧将来 require 它就 404），而课程包原件里今天还没有它。
 * 硬塞进 `FROM_PACK` 会让"模板 == 原件经中性化"这条判据变成"课程包里没有原件"的红。
 */
export const FROM_PLUGIN = ['tools/path-policy.cjs']

/**
 * 逐字节取自课程包的**二进制**件（字体 / favicon）。
 * 为什么不进 FROM_PACK：那条链是 utf8 文本管线（sanitizeText / 逐字符对拍）——
 * 二进制过一趟 utf8 编解码就毁了。判据改为 **Buffer 逐字节相等**（pack-scaffold.mjs ①），
 * 同步也走字节拷贝（_p0/sync-template.mjs）。字体缺了页面会回落系统字（能跑），
 * 但「插件要独立做到本机所有功能」要求发出来 —— 所以照样进清单、照样有对拍。
 */
export const FROM_PACK_BINARY = [
  'starmap/fonts/Lanxi-JingHei.woff2',
  'starmap/fonts/Lanxi-HeiTiLight.woff2',
  'assets/starmap.ico',            // 星图页的 favicon（tools/make-icon.js 生成的那份）
]

/**
 * **派生件**（不是"原件 + 替换"，而是现场算出来的）：
 * `assets/theme.css` = `composeTheme(templates/contract.css + presets/whale-sensei.css)` 的结果。
 * 所以它**不参与** `sanitize(原件) === 模板` 的对拍，改由两条判据钉住：
 *   ① 模板里的 theme.css == 对模板目录现场合成的结果；
 *   ② 建出来的包里 `themeDrift.same === true`（模板内部自洽）。
 */
export const DERIVED = ['assets/theme.css']


/**
 * 中性化规则：`path` 里的 `find` 全部换成 `replace`。
 * `must` = 至少命中几次（反空转：打空必须红）。
 */
/** 空星图的「建第一个圈」引导（starmap/index.html 标记区的中性化替换物）：
 *  确定性星场（R2 序列，与 starmap/data-layer.js 同一条「全仓无 Math.random」的纪律）
 *  + 三行引导文字。作者包里的真图**不进模板** —— 那是内容，不是框架。 */
const EMPTY_GUIDE_SVG = (() => {
  const stars = []
  for (let i = 1; i <= 72; i++) {
    const x = (-400 + 800 * ((i * 0.7548776662466927) % 1)).toFixed(1)
    const y = (-225 + 450 * ((i * 0.5698402909980532) % 1)).toFixed(1)
    const r = (0.5 + 0.7 * ((i * 0.6180339887498949) % 1)).toFixed(2)
    const o = (0.22 + 0.38 * ((i * 0.3247179572447458) % 1)).toFixed(2)
    stars.push(`    <circle cx="${x}" cy="${y}" r="${r}" fill="#7c8aa5" opacity="${o}" />`)
  }
  return `<!--@static-map-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-400 -225 800 450" role="img" aria-label="知识星图（静态版）：0 个知识圆圈、0 个知识点、0 门课程（已点亮 0）；图还是空的 —— 建第一个圈" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
  <rect x="-400" y="-225" width="800" height="450" fill="#05070e" />
${stars.join('\n')}
  <text x="0" y="-16" text-anchor="middle" fill="#dbe4f5" font-size="18" font-family="system-ui, sans-serif">星图还是空的：还没有任何知识圆圈</text>
  <text x="0" y="14" text-anchor="middle" fill="#7c8aa5" font-size="12.5" font-family="system-ui, sans-serif">建第一个圈：用鲸师的建圈入口（DSH 设置页），或手写 lessons/&lt;圆圈&gt;/halo.json</text>
  <text x="0" y="36" text-anchor="middle" fill="#7c8aa5" font-size="12.5" font-family="system-ui, sans-serif">然后跑 node tools/build-starmap.js —— 这里会长出第一颗恒星</text>
</svg>
<!--/@static-map-->`
})()

export const SANITIZE = [
  {
    path: 'starmap/index.html',
    find: /<!--@static-map-->[\s\S]*?<!--\/@static-map-->/g,
    replace: EMPTY_GUIDE_SVG,
    must: 1,
    why: '标记区里是作者包的**真星图**（圆圈 / 课程名都是内容）—— 新包必须是「建第一个圈」引导，发真图 = 假进度',
  },
  {
    path: 'tools/style-adapter.js',
    find: /\/\*\* 风格成品库的位置：配置优先 → 环境变量 → 工作区旁边的 raw-html-v2 \*\//g,
    replace: '/** 风格成品库的位置：配置优先 → 环境变量 → **包内 styles/**（不猜兄弟仓：那只在某台机器的目录布局下成立） */',
    must: 1,
    why: '原件注释里点着作者那台机器上的兄弟仓名',
  },
  {
    path: 'tools/style-adapter.js',
    find: /\|\| path\.join\(ROOT, '\.\.', 'dsh-raw-html-v2-master', 'styles'\);/g,
    replace: "|| path.join(ROOT, 'styles');",
    must: 1,
    why: '「猜兄弟仓」的退路：换台机器必然读不到，且会静默降级（与 lib/style.js 的立场相反）',
  },
  {
    path: 'tools/style-adapter.js',
    find: /`dsh-raw-html-v2\/styles\/_INDEX\.md`/g,
    replace: '风格库目录里的 `_INDEX.md`',
    must: 1,
    why: '同上，注释里的机器专属仓名',
  },
  {
    path: 'tools/style-adapter.js',
    find: /这台机器上没有兄弟仓 dsh-raw-html-v2-master/g,
    replace: '这台机器上没有配风格库',
    must: 1,
    why: '同上，注释里还留着兄弟仓名',
  },
  {
    path: 'templates/contract.css',
    find: /字体文件出自 dsh-raw-html-v2\/assets\/fonts\/，拷到 assets\/fonts\/ 后离线可用。/g,
    replace: '字体文件随风格库分发，拷到 assets/fonts/ 后离线可用。',
    must: 1,
    why: '契约注释里点着风格仓名（它会随注入被带进 assets/theme.css）',
  },
  {
    path: 'presets/whale-sensei.css',
    find: /`E:\\workplace\\_title-bands\\[^`]*`/g,
    replace: '（包外归档，不随包分发）',
    must: 1,
    why: '色带校准归档的绝对路径只对作者那台机器成立',
  },
  {
    path: 'assets/theme.css',
    find: /`E:\\workplace\\_title-bands\\[^`]*`/g,
    replace: '（包外归档，不随包分发）',
    must: 1,
    why: '同上（theme.css 由 contract + preset 合成，所以这里也有一份）',
  },
  {
    path: 'assets/styles.css',
    find: /`E:\\workplace\\_title-bands\\[^`]*`/g,
    replace: '（包外归档，不随包分发）',
    must: 1,
    why: '同上',
  },
  // 2026-09-23 删掉一条：原规则是 `assets/_frame.html` 里的 `Spring Boot 教学课程` → `教学课程`
  // （「页脚写着作者那门课的名字」）。现在**结构上不需要了** —— 页脚改用 `{{CIRCLE_NAME}}` 槽位
  // （值来自 `halo.json` 的 name），随包模板与课程包原件在这一行已经**逐字节相同**。
  // 「页脚不许写死某个知识点的名字」这条规矩没有丢：改由课程包侧 `tools/check-lesson-content.js`
  // 的 R4 判据守着（它在真页面上比对页脚文本 vs 圆圈名/知识点名）。
]

/**
 * 按规则中性化一份文本。
 * @param {string} rel 模板内相对路径（POSIX）
 * @param {string} text 原件全文
 * @returns {{text: string, applied: number, missed: string[]}}
 */
export function sanitizeText(rel, text) {
  let out = String(text)
  let applied = 0
  const missed = []
  for (const r of SANITIZE) {
    if (r.path !== rel) continue
    const hits = (out.match(r.find) || []).length
    if (hits < (r.must ?? 1)) {
      missed.push(`${rel}: ${r.why}（规则打空：找不到要替换的文本）`)
      continue
    }
    out = out.replace(r.find, r.replace)
    applied += hits
  }
  return { text: out, applied, missed }
}

/** 模板里全部文件的相对路径（POSIX） */
export function templatePaths() {
  return [...FROM_PACK, ...FROM_SKILL, ...FROM_PACK_BINARY, ...FROM_PLUGIN]
}
