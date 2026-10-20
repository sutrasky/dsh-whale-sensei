# 运行内核的随包副本：权威来源、生成、对拍与登记（U19）

> 本文件是 **U19** 的 tracked 交付之一（`docs/unify/interfaces.md` §6 的 U19 行点名它）。
> 它回答四件事：副本**从哪来**、**怎么生成**、**怎么对拍**、**怎么登记进随包清单**。
> 判词与原始证据：`test/audit/U19.mjs`、`docs/unify/receipts/U19.json`、`audit-evidence/U19/`。

## 1. 一句话规则

`lib/unify/*.cjs` 是**唯一手工源码**；`lib/pack-template/tools/unify/*.cjs` 是它的**逐字节生成物**。
**改计算只改权威源码，然后跑生成器；永远不要手改副本。**

```bash
node tools/sync-unify-core.mjs --check   # 对拍（只读，exit 0/1）
node tools/sync-unify-core.mjs --write   # 生成（唯一写者）
```

## 2. 权威来源（十四份，顺序即登记顺序）

权威目录：`lib/unify/`。迁移专用件 `migration.cjs` **不在**这份清单里（见 §5）。

| # | 模块 | 权威源码 | 随包副本 |
|--:|---|---|---|
| 1 | identity | `lib/unify/identity.cjs` | `lib/pack-template/tools/unify/identity.cjs` |
| 2 | errors | `lib/unify/errors.cjs` | `lib/pack-template/tools/unify/errors.cjs` |
| 3 | ledger-read | `lib/unify/ledger-read.cjs` | `lib/pack-template/tools/unify/ledger-read.cjs` |
| 4 | commit | `lib/unify/commit.cjs` | `lib/pack-template/tools/unify/commit.cjs` |
| 5 | text | `lib/unify/text.cjs` | `lib/pack-template/tools/unify/text.cjs` |
| 6 | plan | `lib/unify/plan.cjs` | `lib/pack-template/tools/unify/plan.cjs` |
| 7 | fingerprint | `lib/unify/fingerprint.cjs` | `lib/pack-template/tools/unify/fingerprint.cjs` |
| 8 | render | `lib/unify/render.cjs` | `lib/pack-template/tools/unify/render.cjs` |
| 9 | pack | `lib/unify/pack.cjs` | `lib/pack-template/tools/unify/pack.cjs` |
| 10 | stage | `lib/unify/stage.cjs` | `lib/pack-template/tools/unify/stage.cjs` |
| 11 | glossary | `lib/unify/glossary.cjs` | `lib/pack-template/tools/unify/glossary.cjs` |
| 12 | records | `lib/unify/records.cjs` | `lib/pack-template/tools/unify/records.cjs` |
| 13 | content | `lib/unify/content.cjs` | `lib/pack-template/tools/unify/content.cjs` |
| 14 | evidence | `lib/unify/evidence.cjs` | `lib/pack-template/tools/unify/evidence.cjs` |

**消费形态**（U-SPEC §5）：

- 包侧 `tools/<工具>.js` —— `require('./unify/<模块>.cjs')`；
- 包侧 `assets/<工具>.js` —— `require('../tools/unify/<模块>.cjs')`；
- 宿主（插件）—— 直接 `import/require` 仓内的 `lib/unify/<模块>.cjs`（**不**经副本）。

## 3. 生成语令（`tools/sync-unify-core.mjs`）

| 参数 | 作用 | 退出码 |
|---|---|---|
| `--check`（缺省） | 只读对拍；不写盘 | 0 = 全同；1 = 有差异 |
| `--write` | 逐字节写 14 份副本；清掉镜像目录里**清单外**的件 | 0 = 成功；1 = 拒写 |
| `--root=<仓根>` | 对另一个仓根做同一件事（夹具 / 副本 / 沙箱用） | 同上 |
| `--json` | stdout 一行 JSON（机器判据用） | 同上 |

实现纪律（判据就在生成器里，不靠人记）：

- 只依赖 `node:` 内置；不读时钟、不读环境变量、不写时间戳 —— 同样的输入产出同样的字节；
- `--write` 与 `--check` 共用同一份 `plan()`，所以"写进去的"和"查出来的"是同一套判据；
- 出现**子目录 / 非常规件**时 `--write` **整次拒写**（不递归删别人的东西）；
- **开发用生成器不是运行依赖**：它不进 `package.json#files`、不进 `bin`。

## 4. `--check` 的判据（四条同时成立才算 `ok=true`）

1. 权威目录里十四个模块**全都在**（缺一个 ⇒ 生成器自己不可信）；
2. 镜像目录里十四份**全都在**；
3. 每一份与权威**逐字节相同** —— 长度、`sha256`、`Buffer.equals` 三重一致；
4. 镜像目录里**没有多出来的件**（含 `migration.cjs`、`stray.cjs`、任何非清单文件）。

红的时候判词必须能照着改（**点名** + 给出实得字节的 sha256 前缀）：

```
UNIFY-CORE ok=false mode=check files=14 same=13 missing=0 changed=1 extra=0 bytes=331054 \
  mirror=lib/pack-template/tools/unify :: 镜像字节不一致 1 件：render.cjs（期望 1a2b… / 实得 9f8e…）
UNIFY-CORE ok=true  mode=check files=14 same=14 missing=0 changed=0 extra=0 bytes=367560 mirror=lib/pack-template/tools/unify
```

> ⚠️ **上面是 U19 交付当时（2026-10-20 交点）的实跑输出，属历史样例，不是当前值。**
> `bytes=331054` / `bytes=367560` 这两个总数只在那一刻成立：之后 `render.cjs` 与 `content.cjs`
> 都被改过（U07/U15 的后续接线 + 2026-10-20 的身份修补），总数随之变化。
> **当前值一律以当场 `node tools/sync-unify-core.mjs --check` 打印的那一行为准**
> （2026-10-20 修补后实测 `files=14 same=14 bytes=374883`）——本文件不维护第二份会漂的副本。

`--check` 必须拒绝的五种状态（`test/audit/U19.mjs` 的 A02 逐条真跑）：
**缺件 / 改字节 / 多件 / 空镜像 / 权威缺件**；`migration.cjs` 落在镜像里同样算 `extra`。

## 5. `migration.cjs` 为什么不随包

`lib/unify/migration.cjs` 是**一次性身份迁移**（U05）的实现，只由显式迁移 CLI
`tools/migrate-pack.mjs`（`--plan` / `--apply --confirm` / `--rollback`）按需加载。
U-SPEC §2/§5 明令：**运行态不调用迁移模块做隐式双读**。所以：

- 生成器的模块清单里**没有**它；
- 没有一份运行态内核 `require('./migration.cjs')`（A05 逐份扫描字节）；
- 它出现在镜像目录里 ⇒ `--check` 报 `extra`（不是"多一份也无所谓"）。

## 6. 登记：三处清单必须同时对齐（**当前被只读面挡住，见 §7**）

| 清单位置 | 内容 | 写权 |
|---|---|---|
| `lib/pack-scaffold.js#TEMPLATE_FILES` | 随包文件清单（顺序即写入顺序） | **U19** |
| `lib/pack-template/tools/engine-files.cjs#requiredButNotRegistered` | 反空转闸：模板里有、清单里没有 ⇒ **建包当场拒** | 只读（U19 登记后自动满足） |
| `test/pack-template-rules.mjs#FROM_PLUGIN` | 规则清单的「只随插件发」桶 | **只读（本轮）** |
| `lib/pack-template/tools/engine-policy.cjs#ENGINE_FILES` | 受信引擎闭包（执行前逐字节核验） | **U19** |
| `lib/pack-template/tools/offline-bootstrap.js#TOOLS_KEEP` | 离线骨架的 `tools/` 白名单 | **U19** |

两处**成对**判据（都不归 U19 写）会同时检查「运行时清单 == 规则清单」：

- `test/pack-scaffold.mjs`「运行时清单与规则清单一致」（U01 全量基线里是 `ok …（各 75 项）`）；
- `test/audit/T18.mjs` 与 `test/audit/T20.mjs` 的成对断言。

## 7. 当前状态：登记被三处只读/frozen 判据挡住（BLOCKED，不猜不绕）

本卡（U19）**没有**把副本落进仓库、也**没有**改任何清单 —— 因为登记是"成套"的，
而其中三处不在本卡写集里（或明确只读），实测冲突如下：

| # | 冲突 | 位置 | 最小必要差异 |
|--:|---|---|---|
| R-U19-1 | 登记后两份清单不再成对 | `test/pack-template-rules.mjs` 的 `FROM_PLUGIN` | 追加 14 行 `'tools/unify/<模块>.cjs'`（实测：加完后 `TEMPLATE_FILES` 89 项 ≠ `templatePaths()` 75 项） |
| R-U19-2 | 生成镜像目录会顶红 U07 | `test/audit/U07.mjs` 的 A08 ④（`eq(fs.existsSync(mirrorDir), false, …)`） | 由 U07 的授权面把该断言改成「U19 之后允许存在」 |
| R-U19-3 | 显式迁移 CLI 进发布清单要改 `package.json#files` | `test/audit/U08.mjs` 的 A06 ⑥（`package.json 与基线逐字节相同`） | `files` 追加 `"tools/migrate-pack.mjs"`；与 U08 的冻结断言一并裁决 |

**为什么不能"先写上再说"**：不补 R-U19-1 ⇒ `test/pack-scaffold.mjs` 那条断言由 `ok` 变 `FAIL`
（U20 明令「原红内新失败」也不许），T18/T20 同断言同红；补了 ⇒ 越过
`docs/unify/authorization.json` 的 `scope.A.notAuthorized` 与 U10/U12/U13/U15 的 A08 永不面。
两侧都是硬约束，所以本卡按卡面停止条件 **BLOCKED**，把最小必要差异交回裁决。

机械面已证明**只差授权**：`E:\Temp` 副本里补上上述三处（外加 `ENGINE_FILES` / `TOOLS_KEEP` 各 +14 行）后，
`sync --write` / `--check` 全绿、登记成对（89 == 89）、引擎闸空、**从空目录建出来的包**里
14 份副本逐字节等于权威、包侧 `require('./unify/*.cjs')` 全通、`assets/build-glossary.js` 真出产物。
命令与原始输出：`audit-evidence/U19/sandbox/`。

## 8. 授权补齐后的操作顺序（一次成型）

1. 在 `lib/pack-scaffold.js#TEMPLATE_FILES` 追加 14 行（`tools/unify/…`）；
2. 在 `test/pack-template-rules.mjs#FROM_PLUGIN` 追加同样 14 行；
3. 在 `engine-policy.cjs#ENGINE_FILES`、`offline-bootstrap.js#TOOLS_KEEP` 各追加 14 行
   （`TOOLS_KEEP` 的项形如 `'unify/identity.cjs'`，相对 `tools/`）；
4. `node tools/sync-unify-core.mjs --write`；
5. `node tools/sync-unify-core.mjs --check` && `node test/audit/U19.mjs`（八项全绿）；
6. `package.json#files` 追加 `"tools/migrate-pack.mjs"`（与 U08 的冻结断言同批裁决）。

> ⚠️ 第 3 步的后果要说清：`ENGINE_FILES` 一加，**既有课程包**（还没铺副本的那些）会被
> `verifyEngine` 判成"缺引擎件"——那是 U17 的活（迁移/构建闭环），不是 U19 能代劳的。
