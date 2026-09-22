# dsh-whale-sensei（鲸师）

把 **课程包**变成可教、可判、可留痕的东西 —— 一个装进 DeepSeek Harness 工具面的插件：
**17 个能力模块 / 15 个工具（`whale_` 前缀）/ 5 条 HTTP 路由 / 3 个客户端坐位**，
覆盖教师端做课与学生端学·问两条线。

> 由 `dsh-plugin-kit` 脚手架起手。本插件**零运行时依赖**（只用 Node 内建）。
> 仓库：<https://gitee.com/bouyer/dsh-whale-sensei>

---

## 这是什么

**课程内容住在课程包里，插件只做"教具"**：把课程包渲染成页、核验成一致、探测成状态、答疑并写回。
插件自己**不认识 Spring / Vue / Java** —— 在插件源码里 grep 到这些词就是串味了。

两条线，各司其职：

| 线 | 做什么 | 谁干 |
|---|---|---|
| **教师端·做课** | 摸底 → 查资料 → 生课 → 渲染 → 过闸门 → 截图自检 | agent 调工具，插件读写课程包 |
| **学生端·学·问** | 课程页阅读 / 星图导航 / 提问 / 笔记 / 写回 | 浏览器走静态 HTML + 本地服务 |

边界清楚：插件不生成课程包本身（那是技能/agent 的事），不执行学生代码，不跑 Maven/构建器。
课程包能独立打开、能被别的工具消费 —— 插件不在也不影响阅读。

为什么值得用：把"开一门课"从**凭自觉**变成**机械可判** —— 每一步要么进闸门、要么留台账，"做了但没留痕"不算做完。

---

## 5 分钟上手

> 想知道**每一步点哪里、这一步干了什么、卡住了看哪里** → [ONBOARDING.md](./ONBOARDING.md)（新人指北，逐屏文案与真实症状表都在那儿）。

### ① 装插件

**普通使用者（从 npm 装）**：

```bash
dsh plugin --profile web add dsh-whale-sensei
```

**改源码的人（从本仓装）**（在插件仓根目录里执行）：

```bash
dsh plugin --profile web add link:.
```

⚠️ 这条**用 `link:`，不要用 `file:`** —— `link:` 建的是 Junction，改源码重启即生效；
`file:` 在某些情况下会装成真实目录（拷贝），于是"改了源码、也重启了宿主，跑的还是旧代码"。

或者直接跑仓库里的脚本（它要求宿主**先关掉**，会顺带做装配验证与备份）：

```powershell
powershell -ExecutionPolicy Bypass -File install-whale-sensei.ps1
```

> **想一步到位**：加上 `-PackRoot "<你的课程包根目录>"`，脚本会把 `packRoot` 一起写进 profile 层
> （已有 `- id: whale-sensei` 就只改那一行、其余字段保留；没有才追加；改前先备份）。
> 只想改课程包路径、不重装插件：再加 `-PackRootOnly`。加 `-DryRun` 则只打印不写盘。
> **装完必须配 `packRoot`，否则插件装上了也不能用**（见 ②）。

> 诚实标注：本机一直在用 `link:` 那条；**npm 那条未在本机实测**（装了它会把这个 link 顶掉）。
> 两条除"代码从哪来"以外没有别的差别。

### ② 配 `packRoot`（不配等于装了不能用）

`packRoot` 指向你的课程包根目录。它**故意不给默认值** —— 插件不猜路径、也不猜 cwd。
解析顺序：**配置里的 `packRoot` → 环境变量 `DSH_WHALE_PACK` → 都没有就明确报错**。

**路线 A（一步到位，推荐）**：设环境变量，不碰任何 YAML。

```powershell
setx DSH_WHALE_PACK "<你的课程包根目录>"     # 永久（之后要重开终端）
$env:DSH_WHALE_PACK = "<你的课程包根目录>"   # 只对当前终端会话
```

```bash
export DSH_WHALE_PACK="<你的课程包根目录>"   # bash：写进 ~/.bashrc 即永久
```

**路线 B（长期用，推荐写进 profile）**：机器本地配置写在 **profile 那层**
（`$DSH_HOME/profiles/web/cordis.patch.yml`），**不要**写进包内的 `cordis.patch.yml`（那个随包分发，重装会被覆盖）：

```yaml
- id: whale-sensei
  config:
    packRoot: '<你的课程包根目录>'
```

> 行 id 必须逐字是 `whale-sensei`（等于 `lib/index.js` 的 `export const name`）。写错 = **静默不生效**。
> ⚠️ 补丁行会**整体替换**该 id 的 `config` —— 以后加字段（如 `stylesDir`）要把已有的都留着。

> **换台机器只需要配 `packRoot`**（或设环境变量 `DSH_WHALE_PACK`）。
> 风格库是可选的，要接就配 `stylesDir`（或设 `DSH_RAW_HTML_STYLES`），**不配也能用**（只是少一层 slug 校验）。
> 用安装脚本的 `-PackRoot` 参数可以跳过手写：它就地更新上面那段，并且**先备份**。

**路线 C（图形界面，推荐给不想碰 YAML 的人）**：宿主起来之后，进设置页 →「鲸师」一节 →
点 **「选择课程包目录…」** → 在系统文件夹选择框里挑一个目录：

- 挑**空文件夹** → 插件会**就地建好一个课程包**（引擎件 + 空台账），并自动把 `packRoot` 指过去；
- 挑**已经是课程包**的目录 → 直接用它，不动它一个字节；
- 挑其它目录 → 会被拒绝（建包只往空目录里建）。

这条路线**本次会话立刻生效**，同时会写进 profile 配置（重启后依然生效）。

### ③ 重启宿主

`packRoot` 在启动时解析一次，不按请求读。改了配置必须重启宿主才能生效。

### ④ 验

```bash
# 装配判据：能抓到这一行才算真的挂上了
npx @deepseek-ai/dsh --profile web --dump-config
#   期望： # == dsh-whale-sensei, patched by …/cordis.patch.yml
#          - id: whale-sensei  …  config: { packRoot: ... }
```

重启后在浏览器里打开设置页（齿轮图标），左侧导航栏应出现「鲸师」一节。
若没出现：**刷新页面**（客户端改了要刷新才生效）。
卡片里没有黄色警告框、且 `packRoot` 显示为你的课程包绝对路径，才算真的配好了。

**不配 `packRoot` 的症状**（各路由处理方式不同，别只盯 503）：

| 位置 | 现象 |
|---|---|
| 设置页「鲸师」卡 | 黄色提示框（那条路由**没配也回 200**，刻意的），文案以 `未配置 packRoot` 开头并给出修法 |
| `GET /api/whale/status`、`GET/POST /api/whale/starter` | **200**（POST 不写盘，照拼） |
| `GET /api/whale/catalog`、`/api/whale/circle*`、`/api/whale/point` | **200** + `{ok:false, error:"未配置 packRoot …"}` |
| `POST /api/whale/ask`、`POST /api/whale/note` | **503** `插件没有配置 packRoot，定位不到课程包（不猜 cwd）` |
| 绝大多数 `whale_*` 工具 | `没有课程包根目录：配置里写 packRoot，或给本工具传 root` |

> 逐屏走查、症状→原因对照表见 [ONBOARDING.md](./ONBOARDING.md) 第 8、9 节。

---

## 怎么用

### A. 开一门新课（点侧栏「新课程」→ 弹窗 → 发送）

左侧边栏紧贴「新建会话」下方有一个**「新课程」**按钮。点一下**弹出官方弹窗**，问你五件事：

| 字段 | 必填 | 例 |
|---|---|---|
| 要学什么 | ✔ | `Vue 3 组合式 API` |
| 学完要能做出什么 | ✔ | `能独立写一个小型前端应用` |
| 期望篇幅与深度 | | `3 节，能上手写 CRUD` |
| 指定资料 / 参考 | | 官方链接、书名、仓库地址 |
| 其它要求 | | 风格、语言 / 版本、时间安排 |

弹窗里**不问摸底**（"你现在会什么"是发出去之后 agent 单独问的那一轮）。点**「发送」**才是启动键：
正文由宿主拼好（`POST /api/whale/starter`）→ 塞进输入框 → **回车发出去**，然后 agent 按四步协议接手。

四步协议（协议全文由宿主侧 `lib/starter.js` 计算，客户端里没有第二份）：

```
开一门新课。严格按下面四步走，别跳步：

① 先问我学什么：要学哪个知识点/主题、想拿它解决什么问题。
   （我这条消息里已经说清了就直接用，不要再问一遍。）

② 先查资料，再动笔：查官方文档 / 规范 / 源码，把出处逐条落到课程包的 RESOURCES.md。
   禁止凭记忆写课。

③ 问我掌握程度 —— 这一步必须有，而且要在写课之前完成：
   用 whale_intake op=plan 拿问题清单，逐条问我（以前用过什么 / 现在能独立写出什么 /
   卡在哪一步最痛 / 学完想达到什么水平 / 每周能投入多少），拿到回答后
   whale_intake op=record 落盘。没落盘之前 whale_author 会被闸门拦下 ——
   那是刻意的，别用 force 绕过去。

④ 回答拿到之后，先把这一课的大纲给我过一眼（教什么、前置是什么、分几节），
   我说行再写正文：whale_author 生成五槽位源文件 → 写内容 → whale_build 渲染 →
   课程包 tools/gate.mjs 过闸门 → 重建星图与笔记 → whale_visual 截图自检。
```

为什么第③步要机械拦：2026-09-21 实测"新建 Vue 课"时漏掉了问掌握程度这一步 ——
契约只写在文档里、没有落盘格式与闸门，就会漏。

### B. 学生提问 → 答疑写回

1. agent 调 `whale_ask action=watch` 启动监听（宿主侧原生 job，不需要子进程）。
2. 学生在课程页的疑问箱里提交问题 → 本地服务 `POST /ask` → 追加到 `questions/pending.jsonl`。
3. 监听 job 发现新提问 → 宿主唤醒 agent。
4. agent 读 pending → 把解答 graft 进 `lessons/src/` 对应章节（`.qa-box`）→
   登记 `assets/questions-data.js` → 重建课程页 + 笔记文档 → 归档（`drain-questions.js`）→ 重启监听。
5. 回复精确位置：课次、区块、box id。

### C. 看学生进度与课程包状态

| 场景 | 用什么 | 产物/效果 |
|---|---|---|
| 学生代码写了什么、缺什么 | `whale_state` | 扫 `code/` 对照 `EXPECT.json`，报"实现了几项 / 缺几项" |
| 挑战做完了没 | `whale_practice` | 静态事实对挑战判据，"达成 k / 共 n（另有 m 项需人工确认）" |
| 备课/答疑的完整上下文 | `whale_brief` | 七段合一（包状态 + 学生状态 + 待答队列 + 台账 + 笔记 + 记录 + 学情摸底），含推出来的建议 |
| 设置页快速查看 | 设置页「鲸师」卡片 | 只读，显示课程包概况 + 一致性 + 审计 + 台账 + 学生工作区 + 插件版本 |

---

## 工具面

前缀统一 `whale_`。**每个工具都有判据**（对拍、坏样本或回归）。

| 工具 | 干什么 | 什么时候用它 |
|---|---|---|
| `whale_lessonpack` | 课程包数据层：圆圈 / 知识点 / 课程三层 | 需要读课程包结构时（星图、统计、选课次） |
| `whale_author` | 生成一节课骨架（五个槽位）；默认只返回文本，`commit:true` 才落盘 | 开一门新课的第④步 |
| `whale_build` | 渲染课程页并落盘（默认只校验，`write:true` 才写）；与 CLI **逐字节相同** | 写完内容后构建 |
| `whale_style` | 合成 `assets/theme.css`（模板契约 + 预设） | 初始化或更新课程包主题时 |
| `whale_mode` | 主题三态状态机（偏好 → 系统 → 深色块） | 调试主题切换问题时 |
| `whale_glossary` | 名词台账 → `GLOSSARY.md` 的合成与漂移检查 | 加/改术语后重建笔记 |
| `whale_audit` | 五条审计：死链 / id 重复 / 幽灵进度 / 缺产物 / 静默降级 | 自检或排查课程包健康时 |
| `whale_probe` | 路径分类器：一个路径属于课程包哪一类 | 不确定某个文件归谁管时 |
| `whale_visual` | 真浏览器截图 + DOM 断言（4 种桌面尺寸；`fullPage` 整页 / `clip` 局部 / `kind=notes` 查笔记文档页） | 交付前视觉自检 |
| `whale_state` | 学生状态探针：扫 `code/` → 与 `EXPECT.json` 对账 → **报"缺什么"** | 备课前 / 答疑前了解学生现状 |
| `whale_practice` | 实践区：把静态事实对上课里的挑战判据，给出"达成 k / 共 n" | 检查学生挑战完成度 |
| `whale_ask` | 答疑：提交 / 拉取 / **写回解答** / **原生监听唤醒**（有新提问才叫醒 agent） | 管理学生提问 |
| `whale_brief` | 备课·答疑上下文包（七段 + **推出来的**下一步建议；`includeSession` 才读会话） | 每次开课或答疑前先读一页全貌 |
| `whale_intake` | 学情摸底：`op=plan`（出 5 条问题）/ `op=record`（落盘 + 回读校验）/ `op=read`（读回 + 报缺口） | 开课前第③步 |
| `whale_ping` | 存活探针 | 确认插件活没活着 |

`lib/mods/note.js`（笔记路由）**刻意不注册工具** —— 它只是一层 HTTP 薄壳，见下。

---

## 摸底（intake）契约

`whale_intake` 是开课流程第③步的机械保障。

**台账**：`<packRoot>/learning-records/intake.jsonl`（append-only，一行一次摸底，`point` 必填；`latest` 按 point 取最后一条）。

**三个操作**：

| op | 必填参数 | 干什么 |
|---|---|---|
| `plan` | `point` 或 `topic` | 出 5 条具体问题（prior / can / stuck / goal / time）+ 查资料要求 |
| `record` | `point` + `level` | 落盘 + 回读校验，不一致回滚 |
| `read` | （无） | 读回所有知识点的摸底状态 + 报缺口 |

**5 条问题**（固定 id，对所有知识点通用）：

1. `prior` — 以前用过或看过相关的东西吗？（摸清起点）
2. `can` — 现在能独立写出一个小功能吗？写到哪一步会卡住？（判断能力上限）
3. `stuck` — 学习或使用中卡在哪一步最痛？（痛点 = 教学重点）
4. `goal` — 学完想达到什么水平？（决定深度）
5. `time` — 每周能花多少时间？（决定节奏）

**闸门**：`whale_author({commit:true})` 当该知识点没有 intake 记录 → **拒绝落盘**并返回要问的问题；
`force:true` 可覆盖（会留痕，不该用）。

`whale_brief` 在摸底未完成时会多出「学情摸底」一节，并在建议动作里给 `intake-course`。

---

## HTTP 路由

都挂在宿主的 `/api` 下。**跨站栅栏与浏览器认证是基座继承来的，本插件不写 CORS**：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/whale/ask` | `POST` / `GET` | 提交疑问 / 拉待答队列 |
| `/api/whale/answer` | `POST` | 写回解答（只追加台账 → 归档 → 重建产物） |
| `/api/whale/note` | `POST` | 追加一条笔记（`{ text, anchor, date? }`） |
| `/api/whale/status` | `GET` | **只读状态**（给设置页那一节用）。⚠️ 这条**在没配 `packRoot` 时也回 200** 并附带修法 —— 它的职责就是把"没配"显示出来 |
| `/api/whale/starter` | `GET` / `POST` | 开课入口：`GET` 发**弹窗的字段表与模板 + 四步协议**（没配 `packRoot` 也回 200）；`POST { values }` 把学生填的回答拼成「开课请求」正文（**不写盘**，必填缺了回 400 + 缺哪几项） |
| `/api/whale/catalog` | `GET` | **只读目录**（设置页三级目录 + 开课向导第一屏用）：圆圈 / 知识点 / 课程的规范 id（`圈/点/NNNN`）+ 下一课号 + 圆圈建议（`?topic=`）。没配 `packRoot` 也回 200 并指路 |
| `/api/whale/circle` | `POST` | 新建圆圈：`{ name, id }` → `lessons/<id>/halo.json`。原子写 + 拒覆盖 + 坏 id 拒绝；回 `needsRebuild` 那 4 条命令 |
| `/api/whale/point` | `POST` | 新建知识点：`{ circle, name, id }` → `point.json`，`fileBase` = 该圈现有最大值 + 1000（空圈从 0 起） |
| `/api/whale/circle/rename` | `POST` | 圆圈改名：`{ id, name }`。**外科式**替换 `halo.json` 里的 `name`，其余逐字节保留；`"name"` 匹配数 ≠ 1 就拒绝 |
| `/api/whale/circle/delete` | `POST` | 删除圆圈：**必须显式 `confirm: true`**。先用 `{ id, dryRun: true }` 拿清单（目录 / 文件数 / 几门课 / 进度里要清哪几条），确认后删 `lessons/<id>` + `lessons/src/<id>`，并清 `progress.json` 里属于它的课次。**学生代码 `code/` 只报不删**；目标匹配 0 或 ≥2 个一律拒绝 |
| `/api/whale/pack/choose` | `POST` | **选课程包**：`{}` → 宿主弹原生文件夹选择框；`{ dir }` → 直接用这个目录（脚本化用）。空目录 → 铺引擎件**就地建包**；已经是课程包 → 直接用它；其它 → 拒绝。成功后同时改内存路径与 profile 配置（写配置失败会照实回报，不静默） |

`anchor` 可给课次显示名（`第1课`）或星图课次键（`point/0001`）—— **归一化在写入口做**，台账里只存键。

⚠️ 所有路由必须显式声明 `requestBody: 'buffered'` —— 省略它会被基座当 streaming，给 GET 装 body 导致 400 空体。
客户端那侧报的是"JSON 解析失败"，真因在这里。

---

## 客户端半边：两个坐位

### ① 设置页里的「鲸师」一节（`settings.section`）

`lib/client.js` 在设置页里注册一节，与「通用设置 / 模型 / 插件 / Agent 预设 / 表情包 / 插件市场」**并列**（同一层）。

它显示：课程包根目录配没配（没配就当场给出修法）、课程包概况（圆圈/知识点/课程/已点亮）、
产物一致性、审计结果、台账状态、学生工作区扫描、插件版本。
数据来自 `GET /api/whale/status` —— 浏览器半边拿不到 Agent 工具，只能走 HTTP。

卡片右上角有 **「选择课程包目录…」** 按钮（没配 `packRoot` 时，黄色提示框里也有一个）：
点它 → **宿主**弹操作系统的原生文件夹选择框 → 三种结果由服务端判定：

| 你选的目录 | 会发生什么 |
|---|---|
| **空文件夹** | 把 `lib/pack-template/` 的引擎件铺进去 + 生成空台账，**就地建好一个课程包**，并设为 `packRoot` |
| 已经是课程包（有 `presets/whale-sensei.css` 或 `lessons/`） | 直接用它，**一个字节都不动** |
| 其它（非空、又不是课程包） | **拒绝**，并说清原因（建包只往空目录里建，不合并、不覆盖） |

生效两条腿：**本次会话**直接改内存里的路径（立刻可用）；同时写进 profile 层
`cordis.patch.yml`（重启后依然生效，改前留备份、其它字段一个不丢）。

> ⚠️ **这条路由是宿主侧的**：客户端改了只要刷新页面，但**宿主改了必须重启宿主**。
> 没重启就点按钮，宿主会对这条没注册的路由回一句纯文本 `not found`，卡片上会说清这件事
> （"宿主里还没有这条路由 —— 客户端改了只要刷新页面，宿主那半边改了必须重启宿主"）；
> 设置页「插件」块里也会多出一行 **「模块表」**（磁盘 N 个 / 内存 M 个）提示宿主是旧的。

**这是设置页里唯一的写操作**（别的行仍是只读）；它只写「选中的目录」和「profile 配置」两处，
不碰课程内容。

### ② 侧栏「新课程」按钮 + 开课弹窗（`shell.overlay`）

侧栏那行：DSH 侧栏没有对外可注册的 slot，所以与「技能中心」（skill-explorer）同做法 ——
往侧栏 DOM 里（`[data-pane="sidebar"]`）插入一个纯 DOM 按钮，紧跟原生「新建会话」下方。
用 `MutationObserver` 自愈（React 重渲染把它冲掉时立刻插回，且**每次都断言位置**：别的插件行插到我上面就挪回来）。
样式照抄原生「新建会话」的几何：38px 高、圆角 12、`.5px` 边框、`--dsw-alias-button-elevated-fill` 底、
14px/500、图标+文字；侧栏收起时变成 36×36 的图标按钮。

**点一下开的是官方弹窗**（`primitives.Modal`，注册在 `shell.overlay` —— 官方"整帧浮层"缝，当前零占用）。
弹窗问的是**做课必要信息**（要学什么 / 学完要能做出什么 / 期望篇幅 / 指定资料 / 其它要求），
**不问摸底** —— 摸底是「发送」之后 agent 按四步协议第③步单独问的那一轮。字段表与模板来自宿主
（`GET /api/whale/starter`），客户端只负责画与收集。

**「发送」才是启动键**：POST 拼装 → `inputActions.setDraft(正文)` → 下一帧 `inputActions.submit()`
（进程里就是回车那一下）。`inputActions` 从 `conversation.input.left` 坐位取得 ——
该坐位**不渲染任何可见元素**，只把注入的 `inputActions` 接出来。拿不到就退化成复制到剪贴板。

**生效条件**（2026-09-21 实测，两半不一样）：
- **客户端半边（侧栏那行 + 弹窗）**：改完 `lib/client.js` **只需刷新页面** —— 宿主每次页面加载都从磁盘取模块，不必重启。
- **宿主半边（工具 / 路由 / 字段表与协议文本）**：必须**重启宿主进程**（`lib/*.js` 在启动时装配，改完不重启就是跑旧代码）。

> ⚠️ **诚实边界**：客户端**长什么样**（像素级对齐、弹窗渲染出来好不好看）没有自动化判据。`test/panel.mjs` 判到的是：
> 路由形状对、没配也回 200 并指路、注册格式与官方缝对齐、组件没在渲染回调里现造，
> **用一个最小假 DOM 真跑一遍侧栏注入**（插在「新建会话」正下方 / 被别的插件行挤下去要挪回来 / 侧栏晚出现要补插），
> 以及**用 40 行 mini-React 真跑一遍整条流程**（点侧栏 → 弹窗开 → 拉载荷 → 填字段 → 点发送 →
> `setDraft` + `submit` → 弹窗关上）。像素级对齐只能人眼 —— 2026-09-21 现场量到过"差 4px"
> （`width:100%` 加上左右外边距），修完是 x=14 / w=252 / h=38，与原生逐值相同。

---

## 课程包那半边怎么起

课程包自带静态服务 + 工具脚本，不依赖插件也能独立跑：

```bash
# 启动本地服务（默认 http://127.0.0.1:3091）
node <你的课程包根>\tools\app-server.js

# 课程页 / 星图 / 笔记文档页都从这儿看
# 星图：http://127.0.0.1:3091/starmap/
# 笔记：http://127.0.0.1:3091/reference/NOTES.html
```

星图独立窗口脚本（会先关掉浏览器手势）：

```powershell
<你的课程包根>\tools\starmap-app.ps1
```

### ⚠️ 常见坑

1. **`lessons/src/**.html` 是作者态源文件**（没有外壳，直接打开会"完全没样式"）。
   要看课程页请开 `lessons/<halo>/<point>/NNNN-*.html`。
2. **插件改了 `packRoot` 必须重启宿主**，客户端改了要**再刷新页面**。

---

## 验

### 课程包闸门（16 条）

```bash
node <你的课程包根>\tools\gate.mjs
```

### 插件套件（20+ 套，600+ 条断言）

```bash
cd <插件仓>
node test/all.mjs
```

课程包服务 3091 没跑时 visual/practice 会跳过，判词会写"含 N 套部分跳过"。
**跳过 ≠ 通过**。想跑满：先 `node <你的课程包根>\tools\app-server.js`。

### 装配判据（唯一靠得住的）

```bash
npx @deepseek-ai/dsh --profile web --dump-config
#   期望： # == dsh-whale-sensei, patched by …/cordis.patch.yml
#          - id: whale-sensei  …  config: { packRoot: ... }
```

只读的两条**不能**当判据：`node_modules/` 里有目录、`profiles/web/package.json` 里有名字 ——
"装了但没启用"时这两处都可能看起来正常。

---

## 常见故障

| 症状 | 原因 | 修法 |
|---|---|---|
| 所有路由返回 `503 "插件没有配置 packRoot"` | `cordis.patch.yml` 里没写 `config.packRoot` | 在 profile 那层加 `- id: whale-sensei` + `config: { packRoot: … }`，重启宿主 |
| 改了配置/代码没生效 | 宿主没重启，或客户端没刷新 | **重启宿主 + 刷新页面** |
| 打开课程页"完全没样式" | 开的是 `lessons/src/` 里的源文件 | 开 `lessons/<halo>/<point>/NNNN-*.html` |
| `whale_visual` / `whale_practice` 测试跳过 | 课程包本地服务 3091 没起 | 先 `node <你的课程包根>\tools\app-server.js` |
| `dump-config` 里查不到 `whale-sensei` | 行 id 写错了（如 `dsh-whale-sensei`） | 行 id 必须逐字是 `whale-sensei` |
| 设置页「鲸师」卡片没出现 | 客户端没刷新 / 插件没加载 | 刷新页面；若仍无，检查 `dump-config` |
| 侧栏「新课程」按钮没出现 | 同上 + 可能是 DOM 选择器变了 | 检查浏览器控制台有没有 `[dsh-whale-sensei]` 开头的报错 |
| `whale_author commit` 被拒 | 该知识点没有 intake 记录 | 先 `whale_intake op=plan` → 问学生 → `op=record` 落盘 |

---

## 覆盖面与边界

- **`whale_build` 只产出 `lessons/**.html`**。以下**不由本插件产出**，仍归课程包自带脚本：
  `assets/theme.css`（→ `whale_style`）、`starmap/**`（星图构建）、`reference/NOTES.html`（`build-notes`）、
  `assets/lesson-blocks.css`（只有反向抽取才产出）。
- **`ask` 的归档与重建走 shell-out**：调用课程包自带的 `tools/drain-questions.js` 与 `tools/build-notes.js`，
  插件**不复制它们的语义**。这是有意为之（避免同一件事两份实现）。
- **包侧 `tools/` 仍是"能脱离插件独立跑"的引擎** —— 这是架构选择，代价是有几处**两侧各一份实现**。
  弥补方式不是删掉一份，而是**每对都有对拍**：`render-parity`（课程页逐字节）、
  `mirror-parity`（文本助手 + 两个笔记写入口共用一本台账）、`pack-model --selftest`
  （课次映射表 / 术语扫描器 / 课程包事实）。**加一份实现，就要加一条对拍。**
- **课程包自洽**：课程包本身能独立打开、能被别的工具消费；插件不在也不影响阅读。
- **判据落盘**：每个动作要么进闸门、要么留台账 —— "做了但没留痕"不算做完。
- **插件里没有课程领域知识**：grep 不到 Spring / Vue / Bean 就对了，串味了就要查。

---

## 卸载

```bash
dsh plugin --profile web remove dsh-whale-sensei
```

别忘了顺手删掉 profile 里那段 `- id: whale-sensei` 的 `config`（第 2 步加的那个）。

---

## 开发

```bash
node ../dsh-plugin-kit/kit/run-check.mjs .          # 静态契约检查
node ../dsh-plugin-kit/kit/run-check.mjs . --live   # 加装配检查（会写 profile，先备份）
```

**加一个能力 = 放一个模块文件 + 在 `lib/mods/index.js` 的表里加一行**（模块之间不许互相 import，
共享逻辑放 `lib/*.js`）。

### 要动界面？先看 [docs/dsh-native-style.md](./docs/dsh-native-style.md)

那里面是**从 DSH 实现仓逐字抽出来的原生风格速查**：令牌表、面板/分区/行/选择器胶囊/按钮四档的
逐字 CSS、组件库 `Button`/`Modal` 的 API、设置页挂载契约，以及本插件已经落地的那份配方
（`lib/client.js` 的 `btn` / `actionBtn` / `Row` / `Section`）。
**照它做出来的才像宿主原生的**；DSH 升级后按那份文档最后一节核对三处真源。

### 装载缝（改名字时四处一起改）

| 处 | 值 | 改错的症状 |
|---|---|---|
| `package.json` 的 `name` | `dsh-whale-sensei` | 客户端半边加载不到 |
| `cordis.patch.yml` 的行 `id` | `whale-sensei` | **静默不生效**，`dump-config` 里查不到 |
| `lib/index.js` 的 `export const name` | `whale-sensei` | 同上 |
| `lib/client.js` 的 `__ModuleLoader__.load({ id })` | `dsh-whale-sensei`（**是包名**） | 浏览器半边不出现 |

### 硬规则

1. 名字四处对齐（上表）；
2. `inject` 只写硬依赖，软依赖用 `ctx.inject([...], cb)`；
3. 每个注册都 `track()` 收 disposer；
4. 路径只从一个地方算（`createPaths()`）；
5. patch 保持 plain-insert，不写 `!!js`，不把机器本地配置写进包里；
6. **改完插件必须重启宿主，再现场点一遍** —— 宿主侧的契约（返回值形状、文本拼接、注册要求）
   单测看不见。

---

## License

MIT（见 `LICENSE`）。
