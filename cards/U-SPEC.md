# U-SPEC · 修订执行契约（2026-10-20）

本版替代旧版的过期事实、并行/交接规则及勘误处置。U01–U20 卡面为自包含派发 Prompt；旧“已核实签名/行为”全部撤销，执行者必须在固定新基线上重新读取。† 一律指新增设计或待实现入口，绝不表示文件已存在。现有文件不再用含糊的行尾 † 标记。

## 1. 冻结事实与执行状态

- 工作树 E:\workplace\dsh-whale-sensei-unify；分支 refactor/unify-20261018。规划接管时 HEAD=12c782e6d0363abfd82981852dd6935bf393f8e3，分支上零 U 提交。
- 指定执行基线 2f57b1f2cec02e4128b69497e3b6819d36aa707b。规划者已先验证祖先关系、无 tracked 改动及未跟踪计划不冲突，再逐字执行 git -C E:\workplace\dsh-whale-sensei-unify checkout -B refactor/unify-20261018 2f57b1f2cec02e4128b69497e3b6819d36aa707b；已复核 HEAD/分支。此步骤已完成，不派执行者重复重切。计划改写不算实施 U 卡，没有 U 实施提交。
- 活包 E:\workplace\study 全程只读，仅 U01/U20 两窗口可使用；唯一全量命令：node test/all.mjs --pack=E:\workplace\study --mode=real 。两窗口间无第三方写入，U20 对拍四份逐文件摘要（U01 前/后与 U20 前/后），不以 mtime 证明字节一致，不在其他批次采样活包。
- T 线已完工冻结、6/6 签收：24 发现 closed 19 / blocked 4 / waived 1 / open 0；无批次 11；0.3.3；未 push、未发布。blocked 是终态：A01=T13,T16；D07=T16；E03=T25；F03=T23，缺真实宿主/浏览器证据，不属 U 范围。G03=T28 PASS + T29 用户 2026-10-19 waived。release.mjs 恒 exit 2 是设计。审计主树干净、HEAD 2f57b1f、两工作树、无门禁运行、活包静止 ≥1 小时是已给冻结交接事实，执行窗口只核是否被打破，不再等待 T 继续实施。
- 用户给定两基线间共 110 文件变化及其中 11 个重点 U 写集文件：lib/pack-model.js、lib/ask.js、lib/ask-io.js、lib/state.js、lib/state-scan.js、lib/fingerprint.js、lib/glossary.js、lib/glossary-io.js、lib/client.js、package.json、tools/upgrade-pack.mjs。U01 再以 Git 实际清单锁接口，不能把这 11 项视为所有调用者。另须读取新增 jvm、_suite-manifest、_t26-migrated-pack、check-contracts、check-distribution、distribution-license。U04/U08/U09/U11/U14/U16/U18/U19 与 T 的同时写冲突已由串行消除，不需再等 T。
- package.json 的 version=0.3.3、dsh.distribution.mode=private 必须保持；仅 U19 有写权。没有升版/发布/push 授权。

## 2. 身份边界与单一实现

知识点身份只写 circle/point，课程身份只写 circle/point/NNNN；课号 1–9999、四位十进制。显示文字、页面内部锚点（例如 q0001）和实体身份分开；未归课桶保留既有语义。fileBase 仅保持既有显示换算，不能自动减 fileBase、改号或截断/取模。

pointKey(circle,point)、lessonKey(circle,point,number) 已是 lib/pack-model.js 的公开导出；新 identity.cjs† 承接严格实现，不新增同义公开 API。U02 先建严格内核，U09 唯一负责旧导出委托；过渡期显式登记双实现，禁止第三份。合法 catalog 输入/输出保持；旧 padStart 无范围校验的差异登记，并补非法输入拒绝。构造函数自身也校验组成部分；具体失败表达在 U02 回执锁定，不伪称既有签名已支持。

新增解析接口设计†：parsePointKey(value) / parseLessonKey(value)，返回 {ok:true,value:{circle,point[,number]}} 或 {ok:false,failure}。运行态拒绝裸点、两段课键、显示名、空段、路径逃逸、非四位课号，不识别历史身份。已有 circle/point 分立参数经校验组合是构造，不能借此开裸身份字符串别名。

唯一历史解码在 lib/unify/migration.cjs†：裸 point、circle/point 被放在课程位、point/课号、circle/point/1–5 位课号、显示名、旧平铺路径均先核实真实结构/上下文。仅候选唯一、范围内且无目标冲突才映射；零/多候选或缺归属整次阻断。点键不能扩展成多门已学课程。运行态不调用迁移模块做隐式双读，不按环境/调用栈/测试目录改变规则，无长期兼容层。

## 3. 台账读取、失败与提交协议

新增 readLedger(file,{format,validate,fs})† 统一返回 {file,exists,status,entries,problems,errorCode?,failure?}；format=json/jsonl，validate 返回规范记录或抛结构错误。status 固定 missing/empty/ok/invalid/io-error：不存在才 missing；空文件或合法空集合 empty；坏 JSON/null/非法记录 invalid；目录/权限/其他读取故障 io-error，系统错误码保留。非法记录不进 entries/latest；有坏行时完整账本依赖的写入、门禁、版本计算拒绝。JS 正本保留格式，由适配层报告失败，不伪装 JSON、不在 plan 执行 JS。

新增 failure†={kind,code,error,file?,line?,errorCode?}；kind=input/confirmation/conflict/io/recovery。新增 makeFailure({kind,code,error,file,line,errorCode})† 是 U03 设计，不能当现存函数。现有顶层 error/code 与发布种类 kind 不被覆盖。旧文列过的 IO_ERROR、CONFIRM_REQUIRED、PLAN_STALE、MIGRATION_PLAN_REQUIRED、ID_NOT_ALLOWED、ID_REQUIRED、PLAN_REQUIRED、STAGE_FAILED、MIGRATION_NOT_CONFIRMED、MIGRATION_PLAN_STALE、MIGRATION_NOTHING、MIGRATION_DONE、MIGRATION_FAILED 只作检索种子，不冒称完整新基线码表；U01 逐项提取且发现其他值一并保留。拟新增 ID_AMBIGUOUS/MIGRATION_REQUIRED/LEDGER_INVALID/LOCK_BUSY/RECOVERY_REQUIRED† 必须查重名和语义冲突，有冲突阻断相关卡，不能改旧码。

领域归并保持：目标现行版本、证据最高档、队列既有生命周期；missing 的原业务回退不扩大。普通写入已有明确意图时由受信适配层生成计划，不加重复确认 UI；显式迁移/升级/发布不可代替用户确认。

三闸固定顺序：有效计划/目标/操作 → 显式确认 → 当前输入/目标/策略真实字节摘要（锁内复核）。设计接口†：planCommit(root,build,{fs})；applyCommit(root,plan,{confirm,planDigest,build,transaction,fs})。计划 schema='whale-commit/1'†，含 root/operation/files/planDigest；files 排序去重、只记内容摘要，不在控制台泄露私人正文。build 不写权威目标，字节在暂存重建。

回执设计† {ok,state,code?,error?,failure?,rollbackError?,journal?,value?}；保持 building/prepared/committed/rejected/busy/rolled-back/recovery-required 七态，复用现有包锁与 whale-txn/1 日志，不做第二锁/恢复系统。前置拒绝提交调用为零，待恢复拒普通写入；暂存/校验/备份失败不替换既有产物。多文件 rename 不宣传成对读者原子可见；恢复失败明确 recovery-required 并保留材料。

## 4. 显式迁移设计†

U05 交付：planIdentityMigration(root,{fs}) → 计划/失败；applyIdentityMigration(root,{confirm,planDigest,fs,build}) → 回执；rollbackIdentityMigration(root,{confirm,planDigest,backupDir,fs}) → 回执。CLI：

```text
node tools/migrate-pack.mjs --root=<自建夹具> --plan
node tools/migrate-pack.mjs --root=<自建夹具> --apply --confirm --plan-digest=<摘要>
node tools/migrate-pack.mjs --root=<自建夹具> --rollback --confirm --plan-digest=<摘要> --backup=<专属备份>
```

都是待实现入口，参数数组调用，不依赖 shell 续行。plan 对目标零写，不创建目录/日志/锁/备份；迁移摘要覆盖输入字节、映射、预期输出。成功回滚材料入该次 .backup/ 子目录†，回滚按当前产物摘要防止覆盖后改内容。仅支持已自证可安全静态读取的 JS 序列化形状，禁止 require/eval/Function/执行目标模块。变更列 {file,location,from,to}†，阻断列 {file,location,from,candidates,error}†。保留学生原话、正文、代码、日期、顺序，不删孤儿、不合并不可证明同源的版本链，不给目标台账加时间戳。只用受信重建路径在自建暂存包生成并验证；本计划不对活包 apply/rollback。

## 5. 权威源码、随包与写集

lib/unify/† 唯一手工源码：identity、errors、ledger-read、commit、text、plan、fingerprint、render、pack、stage、glossary、records、content、evidence 共十四 .cjs。migration.cjs† 是迁移专用，不能进运行态内核或日常读取。模块只依赖内置、同目录或显式注入能力；事务能力由适配层传入，不读取兄弟仓。

U19 独占 tools/sync-unify-core.mjs† 的 --write 与 --check，权威字节生成 lib/pack-template/tools/unify/† 十四副本，禁止手改。包 tools 用 ./unify/<模块>.cjs、assets 用 ../tools/unify/<模块>.cjs，宿主导入仓内 .cjs。新迁移 CLI 与传递依赖进入最终包清单，开发生成器不是运行依赖；所有登记、引擎闭包、复制规则只归 U19。test/pack-template-rules.mjs 按用户禁令恢复只读，不能借 U19 偷改旧断言。

U19 前包装器可能尚缺仓内生成件；各卡只在自己的 E:\Temp 包逐字复制已交付权威模块验证（记录复制清单与摘要），不修改仓内生成目录，不宣称随包完整。U19 负责无需手补的真包装，U17 负责最终迁移/构建闭环。前期专项 PASS 不是全工程绿，任何已发现新增回归均登记并阻断相应接线；U20 最终不容新增回归。

逐文件写集在各卡全文列出，无“等文件”。lib/pack-scaffold.js 与 package.json 只归 U19。B lane U18 之后才接 ask-server 到 U14 的 records；U14 不抢该文件。test/mirror-parity.mjs A 授权旧预期只归 U09，U14 只在新专项补拒绝/迁移断言。同 lane 顺序以批次表固定，不因阻断越过未处理卡；可以登记卡 BLOCKED 后继续下一卡的独立范围。

## 6. 证据、进仓交接与判词

仅允许各卡新增 audit-evidence/Uxx/ 内自己的运行文件，U01 必须显式 mkdir audit-evidence/U01。禁止修改任何既有审计证据、cards/T*.md、test/audit/T*.mjs、harness 和发布检查器。原始输出/退出码/信号/超时/用例明细被忽略不进仓；不靠聊天中转完整接口。

新增进仓出口†：U01 独占 docs/unify/interfaces.md 与 baseline.json，含真实源码锁/错误码/基线与原始证据索引及摘要，不含私人正文；每卡独占 docs/unify/receipts/Uxx.json，含依赖摘要、实际写集、接口消费版本、断言增量/失败差异、判词及未验证边界。回执在执行者交付时写，测试复跑不重写 tracked 回执。基线不因后续变化被覆盖或重新采集；用户 A/B 决定在首次执行的 U09/U10/U14 回执中逐字引用人类授权及来源，不代写授权。U20 提交后 hash 仅放忽略证据与对话。

所有 U 入口初始不存在，由责任卡新建。runner 新设计† runCard(card,ids,cases)，必须真正 await 后断言，不把同步 harness 当异步壳。严格固定 A01–A08，缺/多/重复、空用例、异常/截断/超时不得 PASS；A07 临时变异有效性、A08 范围/证据/清理守卫。统一成功 PASS Uxx checks=8 failed=0 skipped=0 + exit 0；断言失败 FAIL Uxx + exit 1；缺材料/授权/接口冲突 BLOCKED Uxx + exit 2。无法复现旧缺陷不是豁免测试，仍用有效现状/对拍断言验证。

runner 支持 --evidence-root=<绝对新运行目录>†，限本卡新目录或 U20 的复验目录；不覆盖既有原始证据。U01 默认仅验采集产物；--verify-baseline† 验固定提交对象与采集材料，不再用活包。U20 --precommit† 只在 A01–A07 与暂存准备证据通过时输出 READY U20 phase=precommit + exit 0（不是 PASS），缺项仍 FAIL/BLOCKED；最终默认入口在提交后重新验证保存证据及提交证明，八项全通过才 PASS。测试入口不自动采集全量、不自动提交，复验不会扩大窗口。

回执五项每卡内嵌。跨会话主持人亲验依赖；U01 只用验证模式，不能重跑全量；U19 复验只 --check。T 自动复验因原壳会写 T 证据，必须隔离到 E:\Temp 当前源码副本；不可在主树/unify 直接运行覆盖证据。U01 锁定实际入口及真实基线；没有 T29.mjs 时不能按卡号发明命令；终态 blocked/waived 原样保留。

## 7. 批次与共用资源

一个批次一个会话；会话内按 A/B/C/D 派子代理，同 lane 严格串行，跨批次完成交接后再派。最多四路 lane，实际子代理峰值还受宿主槽位约束。本环境总共四个并发槽含主持人，故最多三个子代理同时活动；S3/S4 四个 lane 任务分 3+1 波次，同一会话完成，不假称四个子代理同时运行。若将来宿主明确提供四个子代理槽才可峰值四，不改依赖/顺序。

S3 新增硬依赖 U05 → U10，用 U05 真迁移补 U10 的迁移断言；先并行 U05/U11/U08，等 U05 PASS 后再派 U10，同一会话峰值三。U14 同样显式依赖 U05。U09 在前批只实证严格映射/拒绝，真实迁移闭环不能伪造，留 U17。

每张卡独立判准入；某 lane BLOCKED 不阻断无依赖的其他 lane，不再使用旧“整批不许开工”规则。U09 被登记 BLOCKED 后，A lane 下一批可做不依赖它的 U05；这不是跳过卡或并发写 A。未裁决只做独立准备，不把它自动解释为 B。U19/U20 以及 U17 独占；普通卡不操作 index/分支/提交。禁止 worktree add/remove/prune、任何 gc、merge/rebase/push。只有 U20 最终显式 add + 一次 commit；规划重切是已完成的一次特许前置。

## 8. 全量基线与收口政策

f5f289b 的上一位实测及其后 2f57b1f 只改四非测试文件所作假定：38/38·51 套·2469 条·skipped=2·恰好原六红·exit 1。候选六红：challenge-gate / pack-model / brief / practice / parity-registry / pack-scaffold。此数字/名单全不是 U 判据；U01 完整有效实测才是本轮基线。实测不同就如实登记，不能为吻合假定而改测试/环境或反复重跑；无法解释的缺套/输入污染/机器结果不一致则阻断。

U20 以 U01 的逐套逐失败项、skip IDs/理由、退出码及断言量对账；不新增红套/原红内新失败、不新增 skip，不减少断言/套件。不要求 skipped=0 去改掉原有 2，也不把基线 skip 视为 PASS。只允许获 A 的同卡身份预期替换与已记录新增断言的增量，按真实发现器实际执行量计算 B+Δ；test/audit/U*.mjs 不凭空算入顶层 suite 数。原红变化/自然转绿必须列证并暂停接纳，不能静默重标定、伪造原红或扩授权。新专项不能替代旧套件或 T 自动回归。U20 卡含完整独立复验/窗口/提交流程；任一卡 BLOCKED 不提交“统一完成”。

## 9. 九项勘误的闭合处置

| 项 | 本版消解（卡面已落实） |
|---|---|
| 1 U06 错模板路径 | 只写真实仓根 tools/recover-ledgers.mjs，模板仅 ledger-transaction.cjs；不新造 recover 模板。 |
| 2 pointKey/lessonKey 既有接口 | U02 严格内核暂存、U09 唯一旧导出委托；新基线重读、合法 catalog 保持、边界拒绝实测；B 路径声明仍未接线。 |
| 3 U01 清单被忽略 | 另授 U01 两个 tracked 文档出口与每卡 tracked 回执，不再依赖跨聊天手抄，原始证据仍被忽略。 |
| 4 U11 未定义缺陷 | 删除无来源缺陷指令；A06 固定空集合/首条新增/重读重建的真实对拍断言；未复现不宣称修复。 |
| 5 镜像测试权限未入 U14 | U09 卡面写条件 A 唯一旧预期写权，U14 卡面明示不得动同一行，仅在新专项补断言/临时副本变异。 |
| 6 U08 upgrade 归属 | 卡面点明仓根 tools/upgrade-pack.mjs，不是模板副本。 |
| 7 标记/停止/六红未闭合 | † 只用于新增设计，所有现存路径执行时重读，无行尾作用域歧义；recover 与五个 mods 分项归属；U18 明列停止条件；U20 正文点名六候选再按实测对账。 |
| 8 文件与入口不存在 | lib/unify、U 入口均列为待建；U01 显式建 audit-evidence/U01，不能当现存运行报告。 |
| 9 不能只登记 | 本表逐项指向已改卡面/写集/断言/交接出口，废止旧“照抄即照办”规则。 |

附加执行矛盾已修正：U09 不前向依赖 U05；真实迁移后读取归 U17。前期模板在临时包补入已交付权威内核，真包装归 U19。U01 复验不再重开活包窗口。T 回归不再覆盖冻结证据。test/pack-template-rules 旧断言写权删除。独立 lane 可在其他 lane 阻断时继续。旧文四会话说法改为九批各一会话。没有新增批次 11。

## 12. 待用户裁决清单（执行范围仍未裁决）

1. 请选择且只可选 A 或 B；目前不代选，不因 T 先例推导 U 授权。

| 选项 | 明确授权/代价 |
|---|---|
| A 另立受控测试契约迁移授权 | 仅 U09/U10/U14 卡内，行为与旧身份输入/预期同卡原子替换；U09 独占 mirror-parity 旧锚点行及必要夹具输入，U10 独占 intake 裸 point/latest 预期，U14 新专项补拒绝/迁移断言且不重改 U09 行。保留非身份语义，补旧形状拒绝、歧义拒绝、显式迁移断言。代价：受控修改既有测试契约并逐条记真实 Δ，完整 20 卡路径才获准推进；不保证其他新发现冲突自动获授权。 |
| B 继续禁止任何旧断言变更 | U09/U10/U14 明确 BLOCKED，下游不实施；仅九张独立准备卡，止步共享内核/迁移工具；旧入口及随包尚未收敛，U19/U17/U20 不开工、不提交“统一完成”。代价：本轮不能完成统一身份接线、最终包装和全量收口。 |

冲突实据按用户逐行核对：test/mirror-parity.mjs:149 仍断言 a.anchor 与 b.anchor 均为 spring-boot/0001；test/intake.mjs:78/86/87 仍断言 read1.latest.vue / read2.latest.vue。行号仅作定位快照，执行时按断言原文搜索，不能把旧行号当永久定位。没有长期兼容层第三选项。授权在用户确认前不落成“已授权”。

2. 若 A 路径后续实测出现授权范围外旧测试冲突（例如只读 pack-template-rules 或其他裸身份测试），执行者列具体文件/旧预期/最小必要差异，相关卡 BLOCKED 后提交用户裁决；本计划不预先扩大授权。若 U20 出现未经授权的自然转绿/失败项变化，同样带实测差异裁决，不改 U01 基线。此项为条件性问题，目前没有虚构差异。
