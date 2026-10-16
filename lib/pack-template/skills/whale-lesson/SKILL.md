---
name: whale-lesson
description: 写一节课：动笔前读什么与少读什么、先审学生的产出、挑这一课、研究先行出处落 RESOURCES.md、五槽位课程源、主题、术语标记与登记、交付前自检与交付。
disable-model-invocation: true
user-invocable: false
---

# whale-lesson · 写一节课

一节课 = `lessons/src/NNNN-dash-case.html` 里的一页自洽 HTML：教一件紧口的事，给学生一个拿得到手的赢。挑战与判据见 `whale-practice`，答疑见 `whale-qa`，留痕见 `whale-record`，边界见 `whale-system`。开课流程的先后顺序只在**插件仓**的 `lib/starter.js` 的 `protocolLines()` 定义，本技能不复述它。

## 0. 动笔前读什么（读的顺序就是判断的顺序）
1. `MISSION.md` —— 学生为什么学这个；每一课都要能追溯到它。
2. `NOTES.md` —— 教学偏好与真实环境（含难度偏好）。
3. `learning-records/*` —— 已会什么，这决定地板。
4. `lessons/src/` 与 `reference/` —— 已有什么，好定下一个编号、往回链什么。
5. `questions/pending.jsonl` 的未答条目 —— 新内容之前先答疑（走 `whale-qa`）。
6. 然后挂 `whale_ask action=watch`：宿主原生后台 job，新提问高于高水位时宿主叫醒你。**这是第一轮就要做的事，不是一次性安装** —— 不挂，提问只能等用户下次开口才被看见。

少读（一节课的开销里读比写贵几倍）：**契约已写在技能里的文件不再读**；**生成物不读，读它的源**。
| 别读 | 改成 | 判据 |
| --- | --- | --- |
| `GLOSSARY.md` | `grep "<key>:" assets/glossary-data.js` | 它是 `build-glossary.js` 的生成物，还可能是旧的 |
| `assets/*.css` | `grep '^\.' assets/styles.css` | 类名抄进文档必漂 |
| `assets/glossary.js` `quiz.js` `ask.js` `theme.js` | 用本技能的标记契约 | 你只需要会跑它们 |
| `check-terms.js` 这类检查脚本 | 直接跑；红了 grep 它报的那行 | 打开整份脚本找一个错误最贵 |
| 上一课整页 HTML | 只 grep 它的挑战与测验段 | 复审只要「他们被要求做什么」 |
| `questions-data.js` / `pending.jsonl` 全量 | 只读未答尾部 | 台账永远在长 |

## 1. 先看学生的产出（写课之前；教学纪律第一条）
**产出随学科而定**：编程是代码、数学是解题过程、写作是稿子 —— 所以「**怎么看**」是**这个圆圈自己的做法**，
不写在这里（写进来就是把某个学科的特化塞进全范围）。开工前先
`whale_teaching op=read circle=<这个圆圈>` 看它的**固定做法**（`kind=guide`）：
那一套就是"这个学科动笔前看什么、按什么顺序看、找哪几类信号"。

下面四条**所有学科都一样**：

1. 只看**真凭据**：学生实际交出来的东西，不是他说的。按上一课的目标**逐条如实报**判定，然后落记录（`whale-record`）。
2. 上一课的活压根没动过 → 直说，把它当这次的活。**从不在没做完的课上盖新课。**
3. 从不悄悄「帮他们改」：摆出发现，让他们自己决定。
4. **把判定放上页面**：下一课开头的 `.review-box` 点名强项与缺陷。留在笔记里的复审到不了能用它的人手里，
   而「你的产出没问题」是你要告诉一个即将往上盖楼的人最有用的一句话。

> 圆圈还没有固定做法时：**先问学生**这个学科动笔前该看什么，再用 `whale_teaching kind=guide` 落一版
> （先 `op=propose` 给他看预览，他点头才 `op=write`）。那正是"每个圆圈有自己独立教学方法"的落点。

## 2. 挑这一课
一课只教一件事，落在最近发展区：选下一个拿得到手的赢，扣回 `MISSION.md`，尊重 `NOTES.md` 里的难度偏好。**动笔之前用一句话跟他确认范围**（这课教什么、不教什么），确认完再动笔。

## 3. 研究先行，出处必落
知识从高信源来 —— 官方文档、规范、第一方 API —— **绝不凭记忆**，版本相关的事实尤其不行。出处课内就地标注，并加一行进 `RESOURCES.md` 说明什么时候该翻它。

## 4. 课程文件的五槽位
**外壳是固定的，永不手写**：`assets/_frame.html` 拥有每页相同的一切（head 与样式链接、`<body>` 首元素的 `theme-boot.js`、`.glossary-hint` 横幅、四个标题、术语表横幅、`.ask-guide`、导航、页脚、五个尾部脚本）。你只写承载教学的五段。
```html
<script type="application/json" data-lesson-meta>
{ "title": "构建完整的 RESTful API", "number": 2, "navTitle": "构建 RESTful API",
  "hintTerm": "patch", "askLead": "本课内容多，卡住很正常。",
  "source": { "label": "Spring 官方指南", "url": "https://spring.io/guides/gs/rest-service/" },
  "terms": { "rest": "接口设计风格", "get": "我要看，不要改" } }
</script>

<!--@objective-->   目标、预计时间、前置课
<!--@review-->      上一课产出审视（第一课整段省略）
<!--@body-->        全部教学正文
<!--@reading-->     推荐阅读
<!--@challenges-->  课后挑战（写法与判据 → whale-practice）
```
```bash
node tools/build-lessons.js          # lessons/src/*.html → lessons/*.html
node tools/build-lessons.js --check  # 非零 = 忘了构建，或有人手改了生成物
```
渲染一致性另有 `whale_build`（默认只校验；`write:true` 才落盘、只写课程页；同一输入逐字节同输出）。

各槽位必须装什么：
- **objective** —— 目标、预计时间、前置课。
- **review** —— `.review-box`，**页面第一块内容，在任何新教学之前**。两列 `✅ 做得好的` / `⚠️ 需要改的`（每条缺陷给具体修法），末尾一行说清动笔前先做什么。用他们真实的文件名与标识符 —— 对不上自己那棵树的复审什么都没教。第一课整段省略。
- **body** —— 编号 `.step` 块；先讲知识，每个概念配一个具体例子；示例要能在**他们的**环境里落地（他们自己的名字、版本、路径）；验证段给确切命令 + 预期输出 + 结果不对意味着什么；`.quiz` 块每块**恰好一个** `data-correct="true"`，块上带 `data-explain`（0 个或多个正确项 = 这题没法答，`check-terms.js` 判红）。
- **reading** —— 主源在前，辅助在后。
- **challenges** —— 三到四道、难度递增；怎么写与判据见 `whale-practice`。

规矩：
- `lessons/NNNN-*.html` 是构建产物，**只改 `lessons/src/` 再重建**。
- 源文件里槽位顺序无所谓 —— 构建器按各自标题定位，不按位置。
- **每个数字都活在 `meta` 里**：术语表、术语数、导航、页脚署名、提示里的示例词都是生成的；手写一句「全部 50 个名词」就会与数据源里的 60 个打架。
- 页级 CSS 放 `<!--@style-->`，只给真一次性的东西；可复用块样式进 `assets/lesson-blocks.css`（每页已加载）。
- 参考页不带提问区：顶部给一行 `.ask-hint-line` 即可。
- 版式照 Tufte：留白、单一强调色、不为装饰花工作记忆。

## 5. 主题（浅 / 深 / 跟随系统）
三个偏好 `light` / `dark` / `system`，**默认 `system`**；CSS 自己绝不查媒体查询 —— 两个脚本解析后把结果发布到 DOM，样式表因此只有一个选择器。DOM 契约（与 DSH 客户端主题插件一致）：`document.documentElement.style.colorScheme = dark ? 'dark' : 'light'`；`document.body.toggleAttribute('data-ds-dark-theme', dark)`。接线全在 `assets/_frame.html`，一页都不要重造：`theme.css` 在 `styles.css` 与 `glossary.css` **之前**（令牌在它那儿）；`theme-boot.js` 是 `<body>` 里**第一个元素**（同步不 defer，首屏前写完两个字段；挪到页尾就闪色）；`theme.js` 在末尾挂三态开关。
- **不许硬编码颜色**（`<!--@style-->` 与 `lesson-blocks.css` 都不行）：字面 `#f8f9fa` 在深色模式里刺眼。这是破主题最常见的方式，`check-terms.js` 会警告。
- 深色值只在 `body[data-ds-dark-theme]` 里声明一次；遗留别名（`--primary-color` 等）必须 `:root` 与深色块**各声明一次** —— `var()` 取的是声明处的值，别名只在 `:root` 就永远不跟随深色。
- 只链 `styles.css` 不链 `theme.css` 的页面丢掉所有颜色，自检判红；主题要罩住参考页，别只罩新课。
- 开关标记不手写（`theme.js` 挂）；高亮跟随**保存的偏好**而非解析结果（`system` + 系统深色 ⇒ 按下的是「跟随系统」）；`localStorage` 按源隔离，`file://` 打开的页各记各的，是预期行为。
- 两主题都刻意深色的面（`<pre>` 块的着色）可以留字面颜色 —— 注释里写明为什么，防下一个人「修好」它。
验证：`node assets/theme.test.js`（最小 DOM 驱动两个脚本，断言上面的契约）。

## 6. 术语标记（让名词自己解释自己）
正文里用 `<span data-term="key">标签</span>` 包住术语：组件把悬浮解释给**第一个**标记处，之后的静默降为只上色 —— 想上色就都标，别手管「第一个 vs 后面」。
- **绝不标进 `<pre><code>`**：那一块要原样可复制。自检直接判红。
- body 之上只许两处标记：提示横幅**恰好一个**（那句就是让学生去悬的那个，它是演示本身）；目标框仅当目标确实是该术语首次被提及处。其余一律不行，`.review-box` 永不标记（它讲的是他们的产出，不是本课词汇）。原因：提示总落在文档顺序的**第一个**标记上，多标一处就悄悄偷走了教这个术语那一节的解释。
- 行内 `<code>` 里标可以（`code.term` 保留等宽）；标题里的术语保持标题色，改标它的首个正文出现处。

## 7. 术语登记（名词台账）
`assets/glossary-data.js` 是**唯一真源**，也是唯一要开的文件：查重 `grep "<key>:" assets/glossary-data.js`；绝不打开 `GLOSSARY.md`（生成物）。每条字段：`label`（页面上的样子）/ `category`（分组与目录）/ `official`（一句正式定义，有英文全名就给：超文本传输协议（HyperText Transfer Protocol））/ `short`（一句大白话，**这一行里不许再出现别的术语**）/ `analogy`（生活意象，如「像隔着玻璃看展品：看多少遍，展品都不会变。」）/ `code`（最小可照抄片段）/ `lesson`（首次出现的课次）。
- `code` 对 **`label` 以 `@` 开头的术语必填** —— 定义加比喻没告诉他们注解怎么写；`check-terms.js` 强制。
- `code` 里不许 HTML（Java 泛型如 `List<Task>` 没问题，检查只看 `</` 与已知标签名）；单行不超 64 列（CJK 算 2），否则悬浮框横滚。注解类术语把属性放在 `<code>` 元素**上**：`<code data-term="pathvariable">@PathVariable</code>`。
- 改完重建笔记文件，永不手改：`node assets/build-glossary.js`。页面与台账**同一次改完**再跑自检 —— 分两趟改，「首次出现」规则当场破。

## 8. 交付前自检
```bash
node tools/build-lessons.js --check
node assets/build-glossary.js
node assets/build-questions.js
node assets/check-terms.js
node assets/theme.test.js
```
**跑它们，别读它们**：它们是检查，不是规格。红了就 grep 报错信息点名的那行，只开那一段。每页必须全绿：所有 `data-term` 键已定义、`<pre>` 块里无标记、无死链与 `GLOSSARY.md` 锚点、术语三段数据齐全、`theme.css` 已链、每个 `var(--token)` 都解析得到；答疑审计确认已答问题的页面与锚点真存在；**测验审计确认每个 `.quiz` 恰好一个正确项**（0 个没法答、多于一个有歧义；正确项是肉眼最长项时给警告）；主题测试断言全过。**非零退出 = 这课没写完**，修完重跑。补充检查：`whale_audit`（死链 / id 重复 / 幽灵进度 / 缺产物 / 静默降级；这五条之外的它明说不查）与 `whale_visual`（真浏览器截图，断言渲染出来了、不是白屏）。

## 9. 交付
Windows 用 `Start-Process`、别的系统用 `open` 打开文件给他，然后简短报告：这课加了什么、他现在**确切**该做的下一步、再给一个可选的具体下一步。产出复审若发现上一课练习没做完，先说那件事。

## 10. 坑
- 复审只列问题 → 强项那列才是告诉学生保留哪些习惯；一堵抱怨墙读起来就是「你不行」。
- 复审没证据 → 「产出很干净」和「这里错了」都要给文件与行；悬空判定既查不了也不可信。
- 把真缺陷软化成夸奖 → 错了就直说并给修法，绕开重点的表扬让学生丢了纠正。
- 复审沉在页底 → 它是页面第一块内容；放在新内容后面，学生已经在没看过的地基上盖楼。
- 链到还不存在的课 → 用不可点的占位（`下一课：<title>（待开课）`），不留死链。
- 测验丢了正确项 → 复制或改写选项时最容易丢，且无声失败：学生每选都「答错了」，试完全部才知道。
- 测验被排版泄题 → 选项同形状，正确项不能肉眼最长（审计允许 4 列差才警告）。
- 测验没解释 → 缺 `data-explain` 学生只知道错了不知道为什么（审计给警告）。
- 依赖名跨大版本漂移 → 一律抄学生自己的清单（这是"清单文件是版本真源"的一个实例，该圆圈的固定做法里写着）。
- 把生成物算进产出复审 → 生成物里可能是已经删掉的东西的旧拷贝；判源。
- 悄悄改学生的产出 → 摆发现，让他自己动手。
- 修外壳只修一页 → 别的课不会有这个改动，`--check` 判为漂移；外壳在 `assets/_frame.html`，在那儿改一次。
- `color-scheme` 被删 → 深色页里滚动条和表单控件还是浅的；引导脚本设了它，别删。

## 11. 工作区部件
首次使用时从本技能的 `assets/` 拷进课程包 `assets/`、`tools/` 拷进 `tools/`。零依赖零构建，双击 `file://` 也必须能用 —— 所以不上打包器、不上 CDN、不 `fetch` 本地 JSON（`file://` 会拦；术语因此是 JS 全局而不是 `.json`）。
| 文件 | 角色 |
| --- | --- |
| `theme.css` `theme-boot.js` `theme.js` `theme.test.js` | 令牌源（`:root` 浅 / `body[data-ds-dark-theme]` 深 / 遗留别名 / 开关样式）· 首屏前引导 · 三态开关与同源同步 · 零依赖逻辑测试 |
| `styles.css` `lesson-blocks.css` `lesson-blocks.js` | 课程排版与 `.step` `.quiz` `.alert` `.review-box` 打印规则 · 共享块样式（`.code-tabs` `.api-table` `.term-list` `.real-path` `.concept-card` `.error-box` 等）· `showTab` 交互 |
| `_frame.html` | 固定外壳，`{{SLOTS}}` 由构建器填；页面家具在这儿改一次 |
| `glossary-data.js` `glossary.css` `glossary.js` | 术语唯一真源 · 术语色与悬浮框 · 绑定首个标记并降级其余 |
| `quiz.js` | 选择题：`data-correct` / `data-explain`、即时反馈、重试；颜色走 CSS 类不走内联 |
| `questions-data.js` `ask.css` `ask.js` | 问答台账唯一真源 · 提问框与青紫 `.qa-box` · 提交 + 剪贴板兜底 + 本地草稿与提交历史 |
| `build-glossary.js` `build-questions.js` `check-terms.js` | 重建 `GLOSSARY.md` · 重建 `QUESTIONS.md` · 自检（含 quiz 唯一正确项、硬编码色、未解析占位符） |
| `tools/build-lessons.js` `tools/ask-server.js` `tools/drain-questions.js` | 构建器（`--check` 判漂移、`--extract` 反抽源文件）· 本地收集服务（`POST /ask`、`GET /health`，CORS 开给 `file://`）· 归档已登记的提问 |
| `tools/lesson-budget.js` | 每课成本体检（各区字符 / 占比、可复用样板占比），`--cost` 折成钱 —— 只报告，不设闸 |
