# dsh-whale-sensei（鲸师）

把 **课程包**变成可教、可判、可留痕的东西 —— 一个装进 DeepSeek Harness 工具面的插件：
**14 个能力模块 / 14 个工具**，覆盖教师端做课与学生端学·问两条线。

> 由 `dsh-plugin-kit` 脚手架起手。本插件**零运行时依赖**（只用 Node 内建）。
> 仓库：<https://gitee.com/bouyer/dsh-whale-sensei>

---

## 一句话

**课程内容住在课程包里，插件只做"教具"**：把课程包渲染成页、核验成一致、探测成状态、答疑并写回。
插件自己**不认识 Spring / Java** —— 在插件源码里 grep 到这些词就是串味了。

## 依赖

| 需要什么 | 说明 |
|---|---|
| DSH 宿主 | 插件跑在宿主里；提供 `connection`（HTTP 路由）与 `jobs`（原生唤醒）等能力 |
| Node | `>= 22.19`（见 `engines`） |
| 一个**课程包目录** | 含 `lessons/`、`code/`、`assets/`、`notes/`、`reference/` 等；插件不生成它，只读写它 |
| 运行时依赖 | **无** |

## 装

### 1) 把插件装进 profile

```bash
dsh plugin --profile web add link:E:/workplace/dsh-whale-sensei
```

⚠️ **用 `link:`，不要用 `file:`** —— `link:` 建的是 Junction，改源码重启即生效；
`file:` 在某些情况下会装成真实目录（拷贝），于是"改了源码、也重启了宿主，跑的还是旧代码"。

或者直接跑仓库里的脚本：`install-whale-sensei.ps1`。

### 2) **必须配 `packRoot`**（不配等于装了不能用）

`packRoot` 指向你的课程包根目录。它**故意不给默认值** —— 插件不猜路径、也不猜 cwd。
机器本地配置写在 **profile 那层**（`$DSH_HOME/profiles/web/cordis.patch.yml`），**不要**写进包内的
`cordis.patch.yml`（那个随包分发，重装会被覆盖）：

```yaml
- id: whale-sensei
  config:
    packRoot: 'E:/workplace/study'
```

> 行 id 必须逐字是 `whale-sensei`（等于 `lib/index.js` 的 `export const name`）。写错 = **静默不生效**。

**不配的症状**：所有 HTTP 路由一律返回

```
503 {"ok":false,"error":"插件没有配置 packRoot，定位不到课程包（不猜 cwd）"}
```

工具则报"没有课程包根目录：配置里写 packRoot，或给本工具传 root"。多数工具都接受
逐次调用覆盖的 `root` 入参，所以临时指到别的课程包不必改配置。

改完配置**必须重启宿主**（`packRoot` 在启动时解析一次，不按请求读）。

## 验

```bash
# ① 唯一可靠的装配判据：能抓到这一行才算真的挂上了
npx @deepseek-ai/dsh --profile web --dump-config
#   期望： # == dsh-whale-sensei, patched by …/cordis.patch.yml
#          - id: whale-sensei  …  config: { packRoot: ... }

# ② 插件自带判据（19 套：3091 没跑时 499 条断言；跑起来 512 条）
npm test

# ③ 课程包闸门（16 条）
node <你的课程包>/tools/gate.mjs
```

只读的两条**不能**当判据：`node_modules/` 里有目录、`profiles/web/package.json` 里有名字 ——
"装了但没启用"时这两处都可能看起来正常。

若 3091（课程包的本地服务）没在跑，`npm test` 的判词会写成"绿（含 2 套部分跳过）"**并点出是哪两套** ——
跳过 ≠ 通过。想跑满：先 `node <课程包>/tools/app-server.js`。

## 工具面

前缀统一 `whale_`。**每个工具都有判据**（对拍、坏样本或"别收得太紧"的回归）。

| 工具 | 干什么 |
|---|---|
| `whale_lessonpack` | 课程包数据层：圆圈 / 知识点 / 课程三层 |
| `whale_author` | 生成一节课骨架（五个槽位）；默认只返回文本，不落盘 |
| `whale_build` | 渲染课程页并落盘（默认只校验，`write:true` 才写）；与 CLI **逐字节相同** |
| `whale_style` | 合成 `assets/theme.css`（模板契约 + 预设） |
| `whale_mode` | 主题三态状态机（偏好 → 系统 → 深色块） |
| `whale_glossary` | 名词台账 → `GLOSSARY.md` 的合成与漂移检查 |
| `whale_audit` | 五条审计：死链 / id 重复 / 幽灵进度 / 缺产物 / 静默降级 |
| `whale_probe` | 路径分类器：一个路径属于课程包哪一类 |
| `whale_visual` | 真浏览器截图 + DOM 断言（4 种桌面尺寸；`fullPage` 整页 / `clip` 局部 / `kind=notes` 查笔记文档页） |
| `whale_state` | 学生状态探针：扫 `code/` → 与 `EXPECT.json` 对账 → **报"缺什么"** |
| `whale_practice` | 实践区：把静态事实对上课里的挑战判据，给出"达成 k / 共 n" |
| `whale_ask` | 答疑：提交 / 拉取 / **写回解答** / **原生监听唤醒**（有新提问才叫醒 agent） |
| `whale_brief` | 备课·答疑上下文包（七段 + **推出来的**下一步建议；`includeSession` 才读会话） |
| `whale_ping` | 存活探针 |

`lib/mods/note.js`（笔记路由）**刻意不注册工具** —— 它只是一层 HTTP 薄壳，见下。

## HTTP 路由

都挂在宿主的 `/api` 下。**跨站栅栏与浏览器认证是基座继承来的，本插件不写 CORS**：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/whale/ask` | `POST` / `GET` | 提交疑问 / 拉待答队列 |
| `/api/whale/answer` | `POST` | 写回解答（只追加台账 → 归档 → 重建产物） |
| `/api/whale/note` | `POST` | 追加一条笔记（`{ text, anchor, date? }`） |

`anchor` 可给课次显示名（`第1课`）或星图课次键（`point/0001`）—— **归一化在写入口做**，台账里只存键。

## 覆盖面与边界（重要，别误解）

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

## 客户端半边（现状：空壳）

`package.json` 里声明了 `dsh.client` 与 `exports["./client"]`，`lib/client.js` 也保留了装载点，
但 `mount()` **尚未实现** —— **装了不会多出任何界面**。这是已知缺口，不是隐藏行为。

## 卸载

```bash
dsh plugin --profile web remove dsh-whale-sensei
```

别忘了顺手删掉 profile 里那段 `- id: whale-sensei` 的 `config`（第 2 步加的那个）。

## 开发

```bash
node ../dsh-plugin-kit/kit/run-check.mjs .          # 静态契约检查
node ../dsh-plugin-kit/kit/run-check.mjs . --live   # 加装配检查（会写 profile，先备份）
```

**加一个能力 = 放一个模块文件 + 在 `lib/mods/index.js` 的表里加一行**（模块之间不许互相 import，
共享逻辑放 `lib/*.js`）。

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

## License

MIT（见 `LICENSE`）。
