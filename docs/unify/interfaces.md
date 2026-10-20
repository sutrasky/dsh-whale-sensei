# U 系列 · 接口锁与错误码基线（U01）

> 由 `audit-evidence/U01/build-interfaces-doc.mjs` 从采集结果生成；固定基线 **2f57b1f2cec02e4128b69497e3b6819d36aa707b**（分支 `refactor/unify-20261018`）。
> 本文件**只**含路径、签名、默认值、返回形状、错误码、模板登记与落点清单 —— 不含学生正文/私人数据。
> 后继卡据此核对；**发生差异即暂停相关卡**（改接口必须先改这里的锁，不能在卡内静默漂）。

## 0. 这份文件是什么、不是什么

| 是 | 不是 |
|---|---|
| 固定基线上**真实导出**的清单（名字 + 签名 + 常量值） | 新设计的定稿 —— 带 † 的接口一律还没实现 |
| 既有**错误码**逐项提取（形状扫描，不局限于旧文种子） | 一份"允许新增码"的白名单 |
| 模板随包登记的现状（U19 独占写权） | 本卡对模板做了任何改动的证据 |
| T 线自动复验入口/参数与隔离方式的登记 | T 卡的重新判定（T 已冻结，本卡不重开审计） |

判词与证据：`docs/unify/baseline.json`（数字）、`docs/unify/receipts/U01.json`（回执）、
`audit-evidence/U01/`（原始证据，已 gitignore）。复验入口 `node test/audit/U01.mjs`。

## 1. 事实来源与锁

- 执行基线：`2f57b1f2cec02e4128b69497e3b6819d36aa707b`，分支 `refactor/unify-20261018`，`git worktree list` 共 2 条（两棵都停在 2f57b1f）。
- 规划接管时 HEAD：`12c782e6d0363abfd82981852dd6935bf393f8e3`。两基线之间实测 **108** 个文件变化
  （U-SPEC §1 写的是「110 文件」—— 按 git 实测 108 登记；差 2 属规划期口径，不影响本锁，见 baseline.json `measuredDiff`）。
- 用户点名的 **11 个重点变化文件**全部在这份 diff 里（`11/11`）。
- 未跟踪计划文件：23 个 `cards/U*.md`（计划文件，不 add、不删）。tracked 改动 = 0。

源文件锁（sha256 是**内容**锁，不是 mtime）。完整 29 条见 `audit-evidence/U01/source-lock.json`；
下面 11 条是用户点名的重点文件，另 18 条是 U01 必须另读的落点（§3）。

| 文件 | 字节 | sha256 |
|---|---:|---|
| `lib/pack-model.js` | 61085 | `d342cc0c5a6cce0e42fab9b82c332fbebf5bf5181dd74941a0919b22f1d14c8e` |
| `lib/ask.js` | 14455 | `9872646513dc68eef9b420ca5fd1b86d88214f2946fe1ba38073e6800ac4ebf8` |
| `lib/ask-io.js` | 33165 | `0bda2a688fae011cc7eaba93c48937027935ee1ee47ad35c200dd575491cd589` |
| `lib/state.js` | 34089 | `d8d9b07df1405204aff0531b8b53957fda2c1eed50253c15b693468b798c7afe` |
| `lib/state-scan.js` | 19051 | `2cdb2387c456438a9a9c1d7e05aaed704f61443d0a645f8391106aa6f6c07629` |
| `lib/fingerprint.js` | 7901 | `65a6a10c0ecf74d0d9eec118632df5d9af8c43be4980f6c0bfeca626de8bab23` |
| `lib/glossary.js` | 14444 | `2d40daa1d46bb6a8b350353d11218edd20870d3f7c9e3e8918d7b965db9a3003` |
| `lib/glossary-io.js` | 4320 | `cccaf35a1a205261fc077d0228676d6bb18875a409f7f8a88eca2d0401c6641a` |
| `lib/client.js` | 180596 | `582add7cdb8719aa58ed03fbb6d1602712d3d049857802024e6096b4094a5730` |
| `package.json` | 1569 | `25a6e767eda8ed9363b60f11b1db236e04e0e50453745bd189f13e6d704c4b6b` |
| `tools/upgrade-pack.mjs` | 13300 | `8f45b14c8241ddf57c8093ba6224435e7168a30e8cacdfbe0e8877e5966cc403` |

## 2. 11 个重点文件的接口锁

### `lib/pack-model.js`

- 字节：61085；sha256：`d342cc0c5a6cce0e42fab9b82c332fbebf5bf5181dd74941a0919b22f1d14c8e`
- 导出面（23 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 39 | `export const NOTES_REL = path.join('notes', 'notes.jsonl')` |
| 48 | `export const EVIDENCE_REL = path.join('learning-records', 'evidence.jsonl')` |
| 51 | `export function lessonLabel(number) {` |
| 61 | `export function displayNumberOf(number, fileBase) {` |
| 123 | `export function normPractice(v) {` |
| 139 | `export function lessonIndex(root) {` |
| 275 | `export function labelOfAnchor(anchor, index) {` |
| 293 | `export function keyOfAnchor(anchor, index) {` |
| 313 | `export function labelAnchorId(label) {` |
| 325 | `export function scanTermsInPage(html) {` |
| 339 | `export function scanTerms(root) {` |
| 375 | `export function pointKey(circle, point) {` |
| 387 | `export function lessonKey(circle, point, number) {` |
| 418 | `export function nextNumber(pack, circle, point) {` |
| 451 | `export function remainingLessons(pack, circle, point) {` |
| 460 | `export function checkTermsReport(root) {  const abs = path.resolve(root)` |
| 480 | `export async function loadBoxes(root) {` |
| 543 | `export function validateBoxes(boxes, index) {` |
| 622 | `export function normGroups(raw, points, haloId, warnings) {` |
| 661 | `export function readPack(root) {` |
| 818 | `export function prerequisiteGaps(pack, pointId) {` |
| 869 | `export function describeGaps(gaps) {` |
| 883 | `export function packSummary(pack) {` |

### `lib/ask.js`

- 字节：14455；sha256：`9872646513dc68eef9b420ca5fd1b86d88214f2946fe1ba38073e6800ac4ebf8`
- 导出面（14 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 15 | `export const ASK_MAX_BYTES = 16 * 1024;` |
| 25 | `export function parseAskBody(raw) {` |
| 67 | `export function formatSeq(n) {` |
| 79 | `export function nextSeq(lastSeqText) {` |
| 94 | `export function toQueueLine(entry) {` |
| 109 | `export function serializeRecord(payload, seq, now) {` |
| 129 | `export function parsePending(text) {` |
| 155 | `export function summarizePending(entries) {` |
| 190 | `export function validateAnswerBody(raw) {` |
| 263 | `export function serializeLedgerEntry(e, indent = '    ') {` |
| 289 | `export const LEDGER_ANCHOR = '\n  };\n});'` |
| 302 | `export const LEDGER_MARKER = '    // 学生真实提出过的疑问按编号登记在这里'` |
| 311 | `export function emptyLedgerSource(headComment) {` |
| 326 | `export function insertLedgerEntry(src, key, block) {` |

### `lib/ask-io.js`

- 字节：33165；sha256：`0bda2a688fae011cc7eaba93c48937027935ee1ee47ad35c200dd575491cd589`
- 导出面（19 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 53 | `export function askPaths(root) {` |
| 70 | `export function readSeq(root) {` |
| 115 | `export function readPendingText(root) {` |
| 138 | `export async function handleAsk(root, { raw, now, txn } = {}) {` |
| 234 | `export function readQueue(root) {` |
| 243 | `export function ledgerPath(root) {` |
| 248 | `export function loadLedger(root) {` |
| 294 | `export function lookupAnswer(root, { id }) {` |
| 327 | `export function verifyOrRollback({ root, abs, src, before, key, load }) {` |
| 359 | `export function findQuestion(root, id) {` |
| 377 | `export function queueHighWater(root) {` |
| 406 | `export const SYNC_TIMEOUT_MS = 60000` |
| 407 | `export const SYNC_MAX_OUTPUT_BYTES = 1024 * 1024` |
| 410 | `export function runScript(root, script, { timeoutMs = SYNC_TIMEOUT_MS, maxOutputBytes = SYNC_MAX_OUTPUT_BYTES } = {}) {` |
| 479 | `export function upgradePackHint(root) {` |
| 496 | `export function verifyScriptsTrusted(root, scripts, { trustedEngine = true } = {}) {` |
| 548 | `export function engineBlockedWarning(gate) {` |
| 552 | `export function rebuildArtifacts(root, scripts, { subject = '写入', trustedEngine = true, timeoutMs, maxOutputBytes } = {}) {` |
| 596 | `export async function handleAnswer(root, { raw, now, rebuild = true, resolveLesson, trustedEngine = true, txn } = {}) {` |

### `lib/state.js`

- 字节：34089；sha256：`d8d9b07df1405204aff0531b8b53957fda2c1eed50253c15b693468b798c7afe`
- 导出面（20 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 25 | `export const STATE_KINDS = ['file', 'dir', 'annotation', 'endpoint', 'configKey', 'configValue', 'pomDependency', 'classSuffix']` |
| 45 | `export function isStudentFile(rel) {` |
| 53 | `export function isReadable(rel) {` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 58 | `export { parseAnnotations, stripJavaNoise, joinEndpointPath, parseEndpoints, parseConfigKeys, parseConfigPairs, parsePomArtifacts } from './adapters/jvm.js'` |
| 61 | `export function detectFacts(dir, allFiles, contents, { adapters = [] } = {}) {` |
| 73 | `export function validateExpect(doc, where = 'EXPECT.json') {` |
| 149 | `export function checkRequirement(facts, req) {` |
| 205 | `export const EVIDENCE_STATUSES = Object.freeze(['missing', 'empty', 'ok', 'invalid', 'io-error'])` |
| 257 | `export function judgeChallenges(facts, challenges, opts = {}) {` |
| 379 | `export function checkChallengeAlignment(lessonId, challenges, src) {` |
| 407 | `export function computeGaps(facts, expectDoc, lessonSources = {}, opts = {}) {` |
| 454 | `export function buildState({ pack = {}, projects = [], signals = {}, expects = new Map(), codeDir = 'code', practiceRoots = [], digests = new Map(), lessonSources = {}, evidence = undefined }) {` |
| 516 | `export function assertLosslessJson(value, where = 'value') {` |
| 550 | `export function summarizeState(state) {` |

### `lib/state-scan.js`

- 字节：19051；sha256：`2cdb2387c456438a9a9c1d7e05aaed704f61443d0a645f8391106aa6f6c07629`
- 导出面（10 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 51 | `export function walkFiles(dir, prefix = '') {` |
| 73 | `export function findProjects(rootAbs, rootRel) {` |
| 99 | `export function scanProject(abs, dir, { adapters = [] } = {}) {` |
| 119 | `export function findExpect(abs) {` |
| 156 | `export function readChallengeLiCounts(root, doc) {` |
| 218 | `export function scanSignals(root) {` |
| 261 | `export function collectPracticeRoots(pack, fallback) {` |
| 283 | `export function scanWorkspace(root, opts = {}) {` |
| 353 | `export function writeState(root, state, rel = 'learning-records/state.json') {` |
| 371 | `export function probeState(root, pack, opts = {}) {` |

### `lib/fingerprint.js`

- 字节：7901；sha256：`65a6a10c0ecf74d0d9eec118632df5d9af8c43be4980f6c0bfeca626de8bab23`
- 导出面（3 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 70 | `export function digestTree(dir) {` |
| 114 | `export const PROBE_SOURCES = [` |
| 130 | `export const PROBE_VERSION = 'p:e3472ea71c33181c'` |

### `lib/glossary.js`

- 字节：14444；sha256：`2d40daa1d46bb6a8b350353d11218edd20870d3f7c9e3e8918d7b965db9a3003`
- 导出面（6 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 20 | `export function slug(label) {` |
| 33 | `export function categorize(ledger) {` |
| 76 | `export function parseTermKeys(src) {` |
| 93 | `export function termRecordSource(key, record) {` |
| 168 | `export function upsertTermSource(src, key, record, opts = {}) {` |
| 207 | `export function buildGlossaryMarkdown(ledger, { title = '课程' } = {}) {` |

### `lib/glossary-io.js`

- 字节：4320；sha256：`cccaf35a1a205261fc077d0228676d6bb18875a409f7f8a88eca2d0401c6641a`
- 导出面（7 条，行号为基线源码行号）：

| 行 | 导出 |
|---:|---|
| 21 | `export function glossaryFiles(root) {` |
| 29 | `export function loadGlossaryLedger(root) {` |
| 36 | `export function expectedGlossaryMarkdown(root) {` |
| 43 | `export function firstDiff(a, b) {` |
| 56 | `export function glossaryDrift(root) {` |
| 76 | `export function writeGlossary(root) {` |
| 93 | `export function glossarySummary(ledger) {` |

### `lib/client.js`

- 字节：180596；sha256：`582add7cdb8719aa58ed03fbb6d1602712d3d049857802024e6096b4094a5730`
- 导出面：**无 ESM 导出**（不是漏采）。结构标记：

  懒 CJS 浏览器半边：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须逐字等于 `package.json#name`（`dsh-whale-sensei`），模块体只能 `require` 冻结基座；对外是 `exports.apply` / `exports.inject = ['slots']`；**不许出现 ESM 语法**；改它必须重启宿主 + 刷新页面。

### `package.json`

- 字节：1569；sha256：`25a6e767eda8ed9363b60f11b1db236e04e0e50453745bd189f13e6d704c4b6b`
- 导出面：**无 ESM 导出**（不是漏采）。结构标记：

  `"name": "dsh-whale-sensei"`、`"version": "0.3.3"`、`"type": "module"`、`"main": "lib/index.js"`；`exports` 只开 `.`/`./client`/`./cordis.patch.yml`/`./package.json`；`files` 决定随包闭包（含 `tools/upgrade-pack.mjs` 与 `docs`）；`bin.dsh-whale-pack` → `tools/upgrade-pack.mjs`；`dsh.distribution.mode = "private"`；`engines.node >= 22.19`。**version 与 distribution.mode 只归 U19 改**。

### `tools/upgrade-pack.mjs`

- 字节：13300；sha256：`8f45b14c8241ddf57c8093ba6224435e7168a30e8cacdfbe0e8877e5966cc403`
- 导出面：**无 ESM 导出**（不是漏采）。结构标记：

  仓根 CLI（不是模板副本）：`--root=<包根> --plan` / `--apply --confirm --plan-digest=<digest>` / `--adapters=jvm` / `--json`；stdout 契约 `PLAN ok=true digest=<hex> files=<n>` 与 `APPLY ok=true digest=<hex> replaced=<n> added=<n> backup=<path>`；失败一律 `FAIL <一句话>`（stderr 同内容）。退出码：0 成功 / 1 拒绝或失败 / 2 用法错或材料缺失。拒绝软链根与链接目标；备份失败不得替换。

### pointKey / lessonKey —— 既有公开导出，谁都不许再造第三份

```js
// lib/pack-model.js:375  —— 既有公开导出，签名不变
export function pointKey(circle, point) { return `${circle}/${point}` }
// lib/pack-model.js:387  —— 既有公开导出，签名不变（padStart(4) 且**没有范围校验**）
export function lessonKey(circle, point, number) { return `${circle}/${point}/${String(number).padStart(4, '0')}` }
```

**现状（本基线实测，不是设计愿望）**：

1. 规范构造点在 `lib/pack-model.js`：`pointKey(circle, point)` / `lessonKey(circle, point, number)` —— 公开导出，`test/catalog.mjs` 直接 import 并断言。
2. **第二处构造点已经存在**：`lib/point-ref.js` 的 `qualified(p)` 内联写着 `` `${p.circle}/${p.id}` ``，注释明说"不 import 它：那是纯字符串拼接"；同一文件还有 `splitQualified(ref)` 在反解 `circle/id`。
3. 解析接口 `parsePointKey(value)` / `parseLessonKey(value)`（U-SPEC §2 设计†）**尚不存在** —— 全仓搜不到实现。

**责任与边界（写进卡面，本卡只登记）**：

- **U02** 只在 `lib/unify/identity.cjs`（†）建**严格内核**，并**暂存**为双实现；它**不改** `lib/pack-model.js`，也不把严格规则塞进现有导出。
- **U09** 是**唯一**负责把旧导出（`pointKey`/`lessonKey` + `point-ref.js` 的内联构造/拆分）委托到严格内核的卡；`test/mirror-parity.mjs` 的旧预期写权也在 U09（条件 A）。
- **禁止第三份实现**：任何卡都不许新增第三份同义实现；过渡期的双实现必须在本文件登记，收敛后把这条改成"唯一实现"。
- `lessonKey` 现有 `padStart` **不做范围校验**（`5` → `0005`、`10000` → `10000` 五位、负数/非整数照样拼）；这条差异由 U02 回执锁定、U09 收敛，**不许在本轮被当成既有签名已支持严格校验**。

## 3. U01 另读的落点（新增/相关文件）

| 文件 | 字节 | sha256 | 作用 |
|---|---:|---|---|
| `lib/adapters/jvm.js` | 11687 | `45a5ddb7beb61715ad425053745d4a0f6854242ed96bb57b57873081853b11de` | 唯一学科适配器；`state.js` 再导出它的解析器（`detectFacts` 由适配器注入） |
| `test/_suite-manifest.mjs` | 922 | `4bea52efad459cd66e855523f07f648951cef3e99e2ef2fedf6df92491b0246d` | 套件发现器：顶层 `test/*.mjs`、排除 `_` 前缀与 5 个入口；**发现器是套件集合的唯一真相**（56 套就是这么来的） |
| `test/_t26-migrated-pack.mjs` | 4476 | `89366905eb194e1d1cd491ab9f27f8995512b173bd1483661bd886d9a18b90d0` | T26 迁移夹具：`inputTreeHash` / `migratedPack` / `declareAdapters` |
| `tools/check-contracts.mjs` | 17787 | `c43d598b756c3e5663289abd76e37da07fb88e6681663b21752624e42979c459` | 能力清单/manifest 版本/技能边界契约；`--check` 0/1/2，`--write` 只改两处 |
| `tools/check-distribution.mjs` | 5961 | `3670314e3733a91b91801f666ea33599e080b97b1f7dd316dcad343af110a288` | 分发材料唯一 CLI 入口；`--mode=private` 恒 exit 2（未做再分发合规核验），`--no-node` 也 exit 2 |
| `lib/pack-template/tools/distribution-license.cjs` | 12872 | `36f4ae392139acc05f36d705663ba799fdb717dc077983d90aaadab427951d6d` | CJS 硬校验器：导出 `MANIFEST_SCHEMA`/`RECEIPT_SCHEMA`/`verifyDistributionMaterials`/`modeOf`；不联网、不随课程包模板发 |
| `lib/pack-scaffold.js` | 28263 | `ec83bad62bf741046b43c6ca171f4eeeb3225d0ff9f83cfdbd35e141eac8a23e` | `TEMPLATE_FILES`（126 行）/`SCAFFOLD_DIRS`（12）—— 随包清单的单一只读源，写权归 U19 |
| `lib/pack-template/tools/engine-files.cjs` | 7389 | `3a1b189cd12077d937847f37b190070b3f79556b6d151c25f59f83dd2190ab41` | 受信引擎闭包清单（`requiredButNotRegistered` 用它拦"模板有、清单无"） |
| `lib/pack-template/tools/engine-policy.cjs` | 12968 | `a3c01f050d184d3082f81b258154704aba6fd6b6277dbf97d3827246d51f1ea0` | 引擎件逐字节受信核验（执行前拒绝旧包），插件与包读同一份 |
| `lib/pack-template/tools/path-policy.cjs` | 10133 | `f18915a5c9726ddebbefb1321983a116980351b1ed15a30b30b8a7f78a1d5714` | 圆圈/知识点 id 形状与根内边界的唯一实现；`lib/author.js` 再导出 |
| `lib/pack-template/tools/ledger-transaction.cjs` | 35601 | `0361593f96ca0a940c0b34aef94ca7f74541b18568723a3d79c8c2436b1f8e2f` | 包级跨进程事务件（`withPackTransaction`/`recoverPack`），U06 重读后沿用 |
| `test/audit/harness.mjs` | 12728 | `bd3762103453fcace8a0a08a5ae74849a50c48dc538a42eece33afbaa0dd3289` | T 卡同步壳：`case(id, expected, body)` 是**同步**的 —— 这正是 U 系列另建 unify-runner 的原因 |
| `test/all.mjs` | 14198 | `c9bb111d1dc7c24a417454bfd4aefa2a9290b9247391867397d311cfdbadf339` | 全量总入口：两本账 + 严格 adapter；`DSH_WHALE_RESULT` 决定 run-all 机器结果落点 |
| `test/run-all.mjs` | 17259 | `83ebf874b83694c9100079528cd47b31b4025f2232aaeb278655d2ace102d409` | 逐套跑：每套一个子进程，落在 `<结果文件>.children-*/` 的 execution.json 是逐套证据 |
| `test/_result.mjs` | 17006 | `c3f6a4e695c14dcd62dcbdb813abe87cfad42eaa26034b33e3bb4a66a0315c9c` | 机器结果七项协议 + 旧文本严格 adapter（摘要唯一/红行逐条/执行量非零/退出码 0） |
| `test/_pack.mjs` | 12119 | `2fad52b82618afe2406523221b6d7b6fd3fcfa28b2968ce0e6c594d2670d2054` | 测试上下文解析（`--pack=` / `--mode=`），参数优先于 env |
| `test/audit/release.mjs` | 11496 | `b216fe524297c224b406961c34de116a23bc8026deda23ca913a353bb6e31653` | 发布检查器：**exit 2 是设计**（私有分发/终态阻断），缺审计材料引起的 open 不许冒充预期终态 |
| `test/audit/release-exit-code.mjs` | 4514 | `95111523ba36ac243904dc5c992b377a6143b8a8bd7c9cfa972abd7cfe2a565d` | release 退出码回归（node:test，11 条，夹具全在 os.tmpdir 自建自清） |

## 4. 模板登记（随包闭包的单一名单，写权只归 U19）

- 清单源：`lib/pack-scaffold.js` 的 `TEMPLATE_FILES` —— 实测 **126** 行（顺序即写入顺序）。
- 目录骨架：`SCAFFOLD_DIRS` —— 实测 **12** 个空目录。
- 闭包核验：`lib/pack-template/tools/engine-files.cjs` 的清单 + `requiredButNotRegistered()`；
  模板里有、清单里没有 → `planScaffold`/`writeScaffold` 当场拒。
- 两处清单必须**成对**：`TEMPLATE_FILES` ↔ `test/pack-template-rules.mjs` 的 `FROM_PACK`/`SANITIZE`
  （`test/pack-scaffold.mjs` 断言"两份清单一致"）。`test/pack-template-rules.mjs` 本轮**只读**。
- 关键件（少了新包就跑不动）：`tools/path-policy.cjs`、`tools/public-files.cjs`、`tools/http-security.cjs`、
  `tools/http-request.cjs`、`tools/ledger-transaction.cjs`、`tools/engine-policy.cjs`、`tools/fingerprint.js`、
  `tools/build-lessons*.js`、`tools/build-notes.js`、`tools/build-starmap*.js`、`tools/build-glossary-tree.js`、
  `tools/app-server.js`、`tools/ask-server.js`、`starmap/main.js`、五份 `skills/*/SKILL.md`。
- **U19** 独占 `tools/sync-unify-core.mjs`（†）与 `lib/pack-template/tools/unify/` 十四副本的生成；
  `lib/unify/`（†）是唯一手工源码。本卡不改任何模板/生成件。

## 5. 错误码清单（逐项提取，不局限于旧文种子）

提取方式：对 `lib/**`、`tools/**`、`preset/**` 的 `.js/.mjs/.cjs` 做形状扫描 ——
`code:`/`errorCode:`/`code=` 位置的字面量 + 出现 `code` 关键字的整行里的大写串（三元/查表也抓）。
种子 13 个全部命中；真实码表 **86** 个不同值、共 224 处。

### 5.1 大写码（`UPPER_SNAKE`）

| 码 | 出现次数 | 代表落点 |
|---|---:|---|
| `ADMIN_REFERER_BAD` | 2 | `lib/pack-template/tools/http-security.cjs:385` |
| `ADMIN_REFERER_NOT_ADMIN` | 2 | `lib/pack-template/tools/http-security.cjs:389` |
| `BAD_ACTION` | 2 | `lib/pack-template/tools/shape-render.js:129` |
| `BAD_PACK_JSON` | 2 | `lib/pack-template/tools/offline-server.js:700` |
| `BAD_REQUEST` | 1 | `lib/pack-template/tools/ask-server.js:449` |
| `BLOCK_NOT_OBJECT` | 2 | `lib/pack-template/tools/shape-render.js:260` |
| `BODY_STREAM_ERROR` | 2 | `lib/pack-template/tools/http-security.cjs:564` |
| `BODY_TOO_BIG` | 3 | `lib/pack-template/tools/ask-server.js:449` |
| `BUSY` | 2 | `lib/pack-template/tools/offline-server.js:934` |
| `CAP_BAD_SCOPE` | 2 | `lib/pack-template/tools/http-security.cjs:306` |
| `CAP_BAD_SIGNATURE` | 2 | `lib/pack-template/tools/http-security.cjs:301` |
| `CAP_EXPIRED` | 2 | `lib/pack-template/tools/http-security.cjs:304` |
| `CAP_MALFORMED` | 6 | `lib/pack-template/tools/http-security.cjs:292` |
| `CAP_MISSING` | 4 | `lib/pack-template/tools/http-security.cjs:289` |
| `CAP_WRONG_ORIGIN` | 2 | `lib/pack-template/tools/http-security.cjs:492` |
| `CAP_WRONG_PACK` | 2 | `lib/pack-template/tools/http-security.cjs:486` |
| `CAP_WRONG_SCOPE` | 2 | `lib/pack-template/tools/http-security.cjs:489` |
| `CONFIRM_REQUIRED` | 8 | `lib/pack-template/tools/http-security.cjs:475` |
| `DENIED` | 3 | `lib/pack-template/tools/http-security.cjs:456` |
| `EACCES` | 3 | `lib/pack-template/tools/ledger-transaction.cjs:141` |
| `EADDRINUSE` | 3 | `lib/pack-template/tools/app-server.js:228` |
| `EBUSY` | 2 | `lib/pack-template/tools/ledger-transaction.cjs:141` |
| `ECONNREFUSED` | 1 | `lib/pack-server.js:190` |
| `ECONNRESET` | 1 | `lib/pack-server.js:190` |
| `EEXIST` | 2 | `lib/pack-template/tools/ledger-transaction.cjs:200` |
| `EHOSTUNREACH` | 1 | `lib/pack-server.js:190` |
| `EISDIR` | 1 | `lib/evidence-io.js:251` |
| `EMPTY_BODY` | 2 | `lib/pack-template/tools/offline-server.js:628` |
| `ENETUNREACH` | 1 | `lib/pack-server.js:190` |
| `ENOENT` | 5 | `lib/evidence-io.js:124` |
| `EPERM` | 5 | `lib/pack-template/tools/ledger-transaction.cjs:141` |
| `ERR` | 2 | `lib/pack-template/tools/http-security.cjs:157` |
| `ERR_SERVER_NOT_RUNNING` | 1 | `lib/pack-server.js:392` |
| `ETIMEDOUT` | 5 | `lib/exec.js:51` |
| `HOST_NOT_LOCAL` | 6 | `lib/pack-template/tools/http-security.cjs:463` |
| `ID_NOT_ALLOWED` | 3 | `lib/pack-template/tools/offline-server.js:153` |
| `ID_REQUIRED` | 2 | `lib/pack-template/tools/offline-server.js:141` |
| `INTERNAL_ERROR` | 1 | `lib/pack-template/tools/http-request.cjs:87` |
| `IO_ERROR` | 23 | `lib/evidence-io.js:121` |
| `JSON_OBJECT_REQUIRED` | 4 | `lib/ask.js:41` |
| `METHOD_NOT_ALLOWED` | 4 | `lib/pack-template/tools/ask-server.js:475` |
| `MIGRATION_DONE` | 1 | `lib/pack-template/tools/offline-server.js:520` |
| `MIGRATION_FAILED` | 1 | `lib/pack-template/tools/offline-server.js:520` |
| `MIGRATION_NOT_CONFIRMED` | 2 | `lib/pack-template/tools/offline-server.js:505` |
| `MIGRATION_NOTHING` | 2 | `lib/pack-template/tools/offline-server.js:515` |
| `MIGRATION_PLAN_REQUIRED` | 2 | `lib/pack-template/tools/offline-server.js:508` |
| `MIGRATION_PLAN_STALE` | 2 | `lib/pack-template/tools/offline-server.js:512` |
| `MISSING_FIELD` | 2 | `lib/pack-template/tools/shape-render.js:265` |
| `MISSING_SCRIPT` | 2 | `lib/pack-template/tools/offline-server.js:768` |
| `MISSING_SERVER` | 2 | `lib/pack-template/tools/offline-server.js:861` |
| `MISSING_SHAPE` | 2 | `lib/pack-template/tools/shape-render.js:261` |
| `NO_ANSWER` | 2 | `lib/pack-template/tools/offline-server.js:907` |
| `NO_FREE_PORT` | 2 | `lib/pack-template/tools/offline-server.js:870` |
| `NO_LESSONS` | 2 | `lib/pack-template/tools/offline-server.js:705` |
| `NO_LIBRARY` | 6 | `lib/pack-template/tools/offline-server.js:761` |
| `NO_PACK_ID` | 2 | `lib/pack-template/tools/offline-server.js:703` |
| `NO_PACK_JSON` | 2 | `lib/pack-template/tools/offline-server.js:696` |
| `NOT_ZIP` | 2 | `lib/pack-template/tools/offline-server.js:629` |
| `OK_NO_ORIGIN` | 2 | `lib/pack-template/tools/http-security.cjs:477` |
| `ORIGIN_BAD` | 2 | `lib/pack-template/tools/http-security.cjs:399` |
| `ORIGIN_OPAQUE_DENIED` | 2 | `lib/pack-template/tools/http-security.cjs:402` |
| `ORIGIN_OPAQUE_NOT_FETCH` | 2 | `lib/pack-template/tools/http-security.cjs:406` |
| `ORIGIN_SCOPE_MISMATCH` | 4 | `lib/pack-template/tools/http-security.cjs:409` |
| `ORIGIN_UNTRUSTED` | 2 | `lib/pack-template/tools/http-security.cjs:440` |
| `PLAN_REQUIRED` | 8 | `lib/pack-template/tools/offline-server.js:508` |
| `PLAN_STALE` | 7 | `lib/pack-template/tools/offline-server.js:512` |
| `POST` | 1 | `lib/pack-template/tools/offline-server.js:1097` |
| `QUIZ_ANSWER` | 2 | `lib/pack-template/tools/shape-render.js:108` |
| `RENAME_FAILED` | 4 | `lib/pack-template/tools/offline-server.js:944` |
| `SCOPE_UNKNOWN` | 6 | `lib/pack-template/tools/http-security.cjs:458` |
| `SKELETON_FAILED` | 2 | `lib/pack-template/tools/offline-server.js:717` |
| `SPAWN_FAILED` | 4 | `lib/pack-template/tools/offline-server.js:905` |
| `STAGE_FAILED` | 3 | `lib/pack-template/tools/publish-policy.cjs:49` |
| `STEP_FAILED` | 2 | `lib/pack-template/tools/offline-server.js:777` |
| `UNKNOWN_SHAPE` | 2 | `lib/pack-template/tools/shape-render.js:262` |
| `UNSUPPORTED_PLATFORM` | 6 | `lib/pack-template/tools/offline-server.js:299` |
| `UPLOAD_TOO_BIG` | 2 | `lib/pack-template/tools/offline-server.js:633` |
| `WRITE_BUSY` | 2 | `lib/pack-template/tools/ask-server.js:223` |
| `WRITE_FAILED` | 2 | `lib/pack-template/tools/ask-server.js:226` |
| `ZIP_HELPER_NO_RECEIPT` | 2 | `lib/pack-template/tools/offline-server.js:670` |
| `ZIP_IO_ERROR` | 2 | `lib/pack-template/tools/offline-server.js:683` |
| `ZIP_LINK_ENTRY` | 4 | `lib/pack-template/tools/offline-server.js:684` |
| `ZIP_PATH_ESCAPE` | 2 | `lib/pack-template/tools/offline-server.js:687` |
| `ZIP_REJECTED` | 1 | `lib/pack-template/tools/offline-server.js:673` |
| `ZIP_STAGING_MISMATCH` | 2 | `lib/pack-template/tools/offline-server.js:691` |
| `ZIP_TIMEOUT` | 2 | `lib/pack-template/tools/offline-server.js:664` |

> 说明：`ENOENT`/`EACCES`/`EPERM`/`ETIMEDOUT` 这类是**系统错误码**（`errorCode` 保留原值，不改成业务码）；
> `CAP_*`/`ORIGIN_*`/`HOST_NOT_LOCAL` 属会话与来源安全族；`ZIP_*` 属离线包族；两者都是既有值，不许改名。
> 旧文种子 `MIGRATION_DONE`/`MIGRATION_FAILED` 住在包模板的 `offline-server.js` 三元表达式里 ——
> 只按 `code:` 形状扫会漏，本表把"整行含 code 的大写串"也算进来，才没漏。

### 5.2 小写 / kebab 码族（另一套既有码，不能视而不见）

| 码 | 落点 | 语义 |
|---|---|---|
| `stale-snapshot` | `lib/gate.js`, `lib/pack-template/tools/ask-server.js` | 快照过期（probeVersion/sourceDigest 变了）→ 自愈重判一次 |
| `no-snapshot` | `lib/gate.js`, ask-server | 还没有快照 |
| `unknown-lesson` | `lib/gate.js`, ask-server | 课次不认识 |
| `no-criteria` | `lib/gate.js`, ask-server | 该课没有挑战判据 |
| `criteria-not-met` | `lib/gate.js`, ask-server | 判据未满足 |
| `evidence-insufficient` | `lib/gate.js`, ask-server | 证据档不够（只贴口头确认不算过） |
| `first-lesson` | `lib/gate.js` | 第一课特例 |
| `missing-ref` | `lib/point-ref.js` | 没给知识点引用 |
| `unknown` | `lib/point-ref.js` | 引用对不上任何知识点 |
| `ambiguous` | `lib/point-ref.js` | 引用有多个候选 |
| `halo-mismatch` | `lib/point-ref.js` | 圆圈与引用不匹配 |
| `busy` | `lib/rebuild-job.js` | 按包串行：该包已有作业在跑 |
| `engine-blocked` | `lib/rebuild-job.js` | 引擎不受信 → 不写 |
| `owner-disposed` | `lib/rebuild-job.js` | 作业所有者已卸载 |
| `missing-script` | `lib/rebuild-job.js` | 包里缺重建脚本 |
| `gate-error` | `lib/mods/author.js` | 门禁自身出错 |
| `not-requested` | ask-server | 本次没要求这个动作 |

### 5.3 U-SPEC 拟新增码的查重结论

查重口径：① 上面的形状扫描有没有同名值；② 全仓字面搜索有没有同名串（含注释与文档）。

| 拟新增码 | 现有同名码值 | 全仓字面命中 | 结论 |
|---|---|---|---|
| `ID_AMBIGUOUS` | 无 | 无 | 可用（新增，不改旧码） |
| `MIGRATION_REQUIRED` | 无 | 无 | 可用（新增，不改旧码） |
| `LEDGER_INVALID` | 无 | 无 | 可用（新增，不改旧码） |
| `LOCK_BUSY` | 无 | 无 | 可用（新增，不改旧码） |
| `RECOVERY_REQUIRED` | 无 | 无 | 可用（新增，不改旧码） |

结论：5 个拟新增码在固定基线上**都不存在**，没有语义冲突；它们只在 `lib/unify/errors.cjs`（†，U03）里新增，
**不许**改动或复用既有码。若实现时发现同名/同义冲突 → 相关卡 BLOCKED，不许改旧码迁就。

## 6. U01–U20 写集落点（哪些已存在、哪些待建 †）

`✅` = 该路径在**固定基线提交 2f57b1f** 里已存在；`†` = 基线提交里没有（卡面标「新增设计」，或本卡刚新建）。
判定方式 = `git cat-file -e <base>:<path>` —— 不看当前工作树，否则本卡刚写出来的文件会被读成「本来就有」。
既有路径的真实内容一律以卡执行时的重读为准 —— 本表只回答"有没有这个落点"。

| 卡 | 写集落点（✅ 已存在 / † 待建） |
|---|---|
| U01 | † `test/audit/unify-runner.mjs`<br>† `test/audit/U01.mjs`<br>† `docs/unify/interfaces.md`<br>† `docs/unify/baseline.json`<br>† `docs/unify/receipts/U01.json`<br>✅ `test/audit/T26.mjs`（仅 P1/P2 授权面：F01 内 PROBE_VERSION 字面量断言改为「内核一份字面量 + 宿主/包侧导出同值、不再各自持有字面量」；该断言的对象归 U04 交付的内核，但 T26 不是 U04 的卡面写集，而 U04 行的 §6 落点被 U04 自己的 A08 与卡面写集逐条锁死，故落点行登记在 U01（账本并集本就是 U01 的 A01 判据核心）；依据见 docs/unify/authorization.json 的 scope.P2 与 derivedConsequences.C2）<br>✅ `test/audit/T03.mjs`（仅 decisions 决-1/决-2 授权面：challengeGate({...point:…}) 那一行源码字面量随调用点传规范身份同步）<br>✅ `test/audit/T12.mjs`（仅 decisions 决-5 授权面：负向夹具复制清单补 lib/adapters/jvm.js）<br>✅ `test/audit/T10.mjs`（仅 decisions 决-6 授权面：T10-source-wired 的 withPackTransaction( 源码字面量改为等价更强的接线断言）<br>（以上三项均为账本登记：三张 T 卡不是任何 U 卡的卡面写集，落点行记在 U01 —— A01 的允许面就是 §6 全部 U 卡写集并集；判据强度未变，真越界仍红。出处见 docs/unify/authorization.json 的 decisions.quoteVerbatim「全按推荐」与 decisions.approvedChanged 的 决-1、决-2、决-5、决-6）<br>`audit-evidence/U01/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U02 | † `lib/unify/identity.cjs`<br>† `test/audit/U02.mjs`<br>† `docs/unify/receipts/U02.json`<br>`audit-evidence/U02/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U03 | † `lib/unify/errors.cjs`<br>† `lib/unify/ledger-read.cjs`<br>† `test/audit/U03.mjs`<br>† `docs/unify/receipts/U03.json`<br>`audit-evidence/U03/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U04 | † `lib/unify/text.cjs`<br>† `lib/unify/plan.cjs`<br>† `lib/unify/fingerprint.cjs`<br>✅ `lib/text.js`<br>✅ `lib/plan.js`<br>✅ `lib/fingerprint.js`<br>✅ `lib/pack-template/tools/pack-text.js`<br>✅ `lib/pack-template/tools/plan-map.js`<br>✅ `lib/pack-template/tools/fingerprint.js`<br>† `test/audit/U04.mjs`<br>† `docs/unify/receipts/U04.json`<br>`audit-evidence/U04/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U05 | † `lib/unify/migration.cjs`<br>† `tools/migrate-pack.mjs`<br>† `test/audit/U05.mjs`<br>† `docs/unify/receipts/U05.json`<br>`audit-evidence/U05/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U06 | † `lib/unify/commit.cjs`<br>✅ `lib/pack-template/tools/ledger-transaction.cjs`<br>✅ `tools/recover-ledgers.mjs`<br>† `test/audit/U06.mjs`<br>† `docs/unify/receipts/U06.json`<br>`audit-evidence/U06/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U07 | † `lib/unify/render.cjs`<br>✅ `lib/render.js`<br>✅ `lib/render-inputs.js`<br>✅ `lib/pack-template/tools/build-lessons.js`<br>† `test/audit/U07.mjs`<br>† `docs/unify/receipts/U07.json`<br>`audit-evidence/U07/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U08 | ✅ `lib/engine.js`<br>✅ `tools/upgrade-pack.mjs`<br>✅ `lib/pack-template/tools/publish-policy.cjs`<br>† `test/audit/U08.mjs`<br>† `docs/unify/receipts/U08.json`<br>`audit-evidence/U08/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U09 | † `lib/unify/pack.cjs`<br>✅ `lib/pack-model.js`<br>✅ `lib/pack.js`<br>✅ `lib/pack-template/tools/lesson-map.js`<br>✅ `lib/point-ref.js`（主持人裁决 C4 的最小写集扩张：依据 U-SPEC §2 与本文件 §2「U09 唯一负责旧导出委托」；只把 qualified / splitQualified 两个内部调用改走严格身份内核，导出面与返回语义逐字不变；落账见 docs/unify/authorization.json 的 derivedConsequences.C4）<br>✅ `test/mirror-parity.mjs`（仅 §12 A 授权面：课程身份所需的夹具输入 + 第 149 行一带的旧身份预期与说明；其余非身份断言不许动；落账见 docs/unify/authorization.json 的 scope.A）<br>† `test/audit/U09.mjs`<br>† `docs/unify/receipts/U09.json`<br>`audit-evidence/U09/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。`<br>† `A01`<br>† `A02`<br>† `A03`<br>† `A04`<br>† `A05`<br>† `A06`<br>† `A07`<br>† `A08` |
| U10 | † `lib/unify/stage.cjs`<br>✅ `lib/intake.js`<br>✅ `lib/goal-io.js`<br>✅ `lib/teaching-io.js`<br>✅ `test/intake.mjs`（仅 §12 A 授权面：裸 point 夹具与 latest.vue 等身份预期；其余版本/日期/学生原话/键序等非身份断言不许动；落账见 docs/unify/authorization.json 的 scope.A）<br>† `test/audit/U10.mjs`<br>† `docs/unify/receipts/U10.json`<br>`audit-evidence/U10/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。`<br>† `A01`<br>† `A02`<br>† `A03`<br>† `A04`<br>† `A05`<br>† `A06`<br>† `A07`<br>† `A08` |
| U11 | † `lib/unify/glossary.cjs`<br>✅ `lib/glossary.js`<br>✅ `lib/glossary-io.js`<br>✅ `lib/glossary-edit-io.js`<br>✅ `lib/pack-template/assets/build-glossary.js`<br>† `test/audit/U11.mjs`<br>† `docs/unify/receipts/U11.json`<br>`audit-evidence/U11/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U12 | ✅ `lib/pack-template/tools/offline-server.js`<br>† `test/audit/U12.mjs`<br>† `docs/unify/receipts/U12.json`<br>`audit-evidence/U12/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U13 | ✅ `lib/author.js`<br>✅ `lib/rebuild-job.js`<br>✅ `lib/mods/author.js`<br>✅ `lib/mods/create.js`<br>✅ `lib/mods/plan.js`<br>† `test/audit/U13.mjs`<br>† `docs/unify/receipts/U13.json`<br>`audit-evidence/U13/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U14 | † `lib/unify/records.cjs`<br>✅ `lib/ask.js`<br>✅ `lib/ask-io.js`<br>✅ `lib/notes-io.js`<br>✅ `lib/adjust-io.js`<br>✅ `lib/pack-template/tools/drain-questions.js`<br>† `test/audit/U14.mjs`<br>† `docs/unify/receipts/U14.json`<br>`audit-evidence/U14/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。`<br>† `A01`<br>† `A02`<br>† `A03`<br>† `A04`<br>† `A05`<br>† `A06`<br>† `A07`<br>† `A08` |
| U15 | † `lib/unify/content.cjs`<br>✅ `lib/pack-template/tools/build-starmap.js`<br>✅ `lib/pack-template/tools/build-lessons-index.js`<br>✅ `lib/pack-template/tools/build-glossary-tree.js`<br>✅ `lib/pack-template/tools/build-notes.js`<br>✅ `lib/pack-template/assets/build-questions.js`<br>† `test/audit/U15.mjs`<br>† `docs/unify/receipts/U15.json`<br>`audit-evidence/U15/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U16 | ✅ `lib/client.js`<br>✅ `lib/starter.js`<br>✅ `lib/mods/catalog.js`<br>✅ `lib/mods/goal.js`<br>✅ `lib/mods/intake.js`<br>✅ `lib/mods/starter.js`<br>✅ `lib/mods/pack.js`<br>✅ `lib/mods/lessonpack.js`<br>✅ `lib/pack-export.js`（决策 决-3 收编：导出链路的身份构造/解析归本卡；见 docs/unify/authorization.json 的 decisions.approvedChanged）<br>✅ `lib/pack-template/assets/ask.js`<br>✅ `lib/pack-template/assets/notes.js`<br>✅ `lib/pack-template/assets/adjust.js`<br>✅ `lib/pack-template/starmap/main.js`<br>† `test/audit/U16.mjs`<br>† `docs/unify/receipts/U16.json`<br>`audit-evidence/U16/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U17 | † `test/audit/U17.mjs`<br>† `docs/unify/receipts/U17.json`<br>`audit-evidence/U17/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U18 | † `lib/unify/evidence.cjs`<br>✅ `lib/evidence.js`<br>✅ `lib/evidence-io.js`<br>✅ `lib/state.js`<br>✅ `lib/state-scan.js`<br>✅ `lib/gate.js`<br>✅ `lib/pack-template/tools/ask-server.js`<br>† `test/audit/U18.mjs`<br>† `docs/unify/receipts/U18.json`<br>`audit-evidence/U18/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U19 | ✅ `lib/pack-scaffold.js`<br>✅ `package.json`<br>✅ `lib/pack-template/tools/engine-policy.cjs`<br>✅ `lib/pack-template/tools/offline-bootstrap.js`<br>† `tools/sync-unify-core.mjs`<br>† `docs/unify-mirrors.md`<br>† `lib/pack-template/tools/unify/identity.cjs`<br>† `lib/pack-template/tools/unify/errors.cjs`<br>† `lib/pack-template/tools/unify/ledger-read.cjs`<br>† `lib/pack-template/tools/unify/commit.cjs`<br>† `lib/pack-template/tools/unify/text.cjs`<br>† `lib/pack-template/tools/unify/plan.cjs`<br>† `lib/pack-template/tools/unify/fingerprint.cjs`<br>† `lib/pack-template/tools/unify/render.cjs`<br>† `lib/pack-template/tools/unify/pack.cjs`<br>† `lib/pack-template/tools/unify/stage.cjs`<br>† `lib/pack-template/tools/unify/glossary.cjs`<br>† `lib/pack-template/tools/unify/records.cjs`<br>† `lib/pack-template/tools/unify/content.cjs`<br>† `lib/pack-template/tools/unify/evidence.cjs`<br>† `test/audit/U19.mjs`<br>† `docs/unify/receipts/U19.json`<br>✅ `test/pack-template-rules.mjs`（仅 §4 决-B1 / decisions 决-9 授权面：`FROM_PLUGIN` **只追加 14 行登记项** `tools/unify/<模块>.cjs`，**不改任何判据强度**、不删不放宽既有断言；出处 = 交接文件 `E:/Temp/HANDOFF-U-SERIES-20261020.md` §4 决-B1（用户第三批授权原文「确认」）+ 交接文件 `E:/Temp/HANDOFF-U-SERIES-20261020.md` §4 决-B1（用户第三批授权原文「确认」）+ authorization.json 的 decisions 决-9「预授权 test/pack-template-rules.mjs 只加登记项（不改判据强度），供 U19 使用」。这是**账本登记**，不是"任何卡都能改它"：该文件的全仓唯一写者仍是 U19 的登记动作）<br>`lib/pack-template/tools/unify/ 仅上述十四文件；不得手改，唯一生成写者是本卡。`<br>`audit-evidence/U19/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |
| U20 | † `test/audit/U20.mjs`<br>† `docs/unify/receipts/U20.json`<br>✅ `lib/verify.js`（仅深链判据的**跨域搭桥**：页面域键是 point/NNNN（决-11 不动），运行态身份是 circle/point/NNNN（U-SPEC §2），拿后者去页面里找恒不成立；改成用页面域键比对，判据强度不变，判词同步点名该键）<br>✅ `test/_t26-migrated-pack.mjs`（仅 U20 的**集成修正面**：T26 迁移夹具在"活包整棵拷贝 + 覆盖两个包装器"之后，必须再带上插件模板的 `tools/unify/*.cjs` 传递依赖 —— U04/U11 之后那两个包装器都委托 `tools/unify/**`，而旧活包没有该目录，夹具在准备阶段就 `Cannot find module`。**零断言改动**，只补输入准备；与 decisions 决-5（T12 负向夹具复制清单补 lib/adapters/jvm.js）同一类）<br>✅ `test/style-mode-author.mjs`<br>✅ `test/ask-answer.mjs`<br>✅ `test/circle-delete.mjs`（以上三份**仅身份形状口径**：U-SPEC §12.2「授权范围外旧测试冲突」经用户裁决后做同卡原子替换 —— `readPack().lessons[].id` 与删除计划的课次键已是规范三段、显示名不再被 `keyOfAnchor` 解析；保留全部非身份断言。逐条旧预期与最小差异见 audit-evidence/U20/unblock/f-c-collisions.json）<br>✅ `test/render-parity.mjs`（仅 1 行反空转样本：parseSource 在 U07 之后已不在包侧 build-lessons.js 里，样本换成 renderOne，射程不变）<br>`audit-evidence/U20/ 下本次新建文件（忽略的 U 原始证据；不得覆盖旧证据）。` |

> 读表要点：`lib/unify/*.cjs` 十四个、`tools/sync-unify-core.mjs`、`tools/migrate-pack.mjs`、
> 全部 `test/audit/U*.mjs` 与 `docs/unify/*` 在本基线**都不存在**（†）—— 缺目录不是"实现已通过"。
> `lib/pack-scaffold.js` 与 `package.json` 只归 U19；`lib/client.js` 只归 U16；`tools/upgrade-pack.mjs` 归 U08。

## 7. T 线自动复验清单（登记，不重开审计）

T 线已完工冻结：24 张卡 6/6 签收，closed 19 / blocked 4 / waived 1 / open 0。
下表回答的是"**哪些卡有可执行的自动入口**、参数是什么、基线判词是什么、确实触达了哪些用例、能不能安全隔离复验"。
判词取自 `audit-evidence/planner-acceptance-summary.json`（审计主树，只读）；用例取自各卡冻结的 `result.json`。

| T 卡 | 整卡入口 | 自动入口（真实参数） | 基线判词 | 冻结用例数 | 隔离方式 |
|---|---|---|---|---:|---|
| T01 | `node test/audit/T01.mjs` | （无） | PASS / exit 0 | 27 | — 无自动入口（不发明命令） |
| T02 | `node test/audit/T02.mjs` | （无） | PASS / exit 0 | 34 | — 无自动入口（不发明命令） |
| T03 | `node test/audit/T03.mjs` | （无） | PASS / exit 0 | 31 | — 无自动入口（不发明命令） |
| T04 | `node test/audit/T04.mjs` | （无） | PASS / exit 0 | 46 | — 无自动入口（不发明命令） |
| T05 | `node test/audit/T05.mjs` | （无） | PASS / exit 0 | 58 | — 无自动入口（不发明命令） |
| T06 | `node test/audit/T06.mjs` | （无） | PASS / exit 0 | 36 | — 无自动入口（不发明命令） |
| T07 | `node test/audit/T07.mjs` | （无） | PASS / exit 0 | 38 | — 无自动入口（不发明命令） |
| T08 | `node test/audit/T08.mjs` | （无） | PASS / exit 0 | 0 | — 无自动入口（不发明命令） |
| T09 | `node test/audit/T09.mjs` | （无） | PASS / exit 0 | 24 | — 无自动入口（不发明命令） |
| T10 | `node test/audit/T10.mjs` | （无） | PASS / exit 0 | 48 | — 无自动入口（不发明命令） |
| T11 | `node test/audit/T11.mjs` | （无） | PASS / exit 0 | 22 | — 无自动入口（不发明命令） |
| T12 | `node test/audit/T12.mjs` | （无） | PASS / exit 0 | 26 | — 无自动入口（不发明命令） |
| T13 | `node test/audit/T13.mjs` | `node test/audit/T13.mjs --automated-only` | BLOCKED / exit 2 | 0 | ✅ 副本可跑 |
| T14 | `node test/audit/T14.mjs` | （无） | PASS / exit 0 | 0 | — 无自动入口（不发明命令） |
| T15 | `node test/audit/T15.mjs` | （无） | PASS / exit 0 | 0 | — 无自动入口（不发明命令） |
| T16 | `node test/audit/T16.mjs` | `node test/audit/T16.mjs --automated-only` | BLOCKED / exit 2 | 0 | ✅ 副本可跑 |
| T17 | `node test/audit/T17.mjs` | （无） | PASS / exit 0 | 18 | — 无自动入口（不发明命令） |
| T18 | `node test/audit/T18.mjs` | （无） | PASS / exit 0 | 17 | — 无自动入口（不发明命令） |
| T19 | `node test/audit/T19.mjs` | （无） | PASS / exit 0 | 22 | — 无自动入口（不发明命令） |
| T20 | `node test/audit/T20.mjs` | （无） | PASS / exit 0 | 27 | — 无自动入口（不发明命令） |
| T21 | `node test/audit/T21.mjs` | （无） | PASS / exit 0 | 31 | — 无自动入口（不发明命令） |
| T22 | `node test/audit/T22.mjs` | （无） | PASS / exit 0 | 0 | — 无自动入口（不发明命令） |
| T23 | `node test/audit/T23.mjs` | `node test/audit/T23.mjs --auto` | BLOCKED / exit 2 | 34 | ⛔ 硬编码活包 → 不执行 |
| T24 | `node test/audit/T24.mjs` | （无） | PASS / exit 0 | 17 | — 无自动入口（不发明命令） |
| T25 | `node test/audit/T25.mjs` | `node test/audit/T25.mjs --auto` | BLOCKED / exit 2 | 14 | ⛔ 硬编码活包 → 不执行 |
| T26 | `node test/audit/T26.mjs` | （无） | PASS / exit 0 | 20 | — 无自动入口（不发明命令） |
| T27 | `node test/audit/T27.mjs` | （无） | PASS / exit 0 | 23 | — 无自动入口（不发明命令） |
| T28 | `node test/audit/T28.mjs` | （无） | PASS / exit 0 | 20 | — 无自动入口（不发明命令） |

汇总：28 张有源码入口的 T 卡里，**4 张**有自动入口；其中 **2 张**（T13 `--automated-only`、T16 `--automated-only`）
没有活包/git 引用，已在 `E:\Temp` 的仓源副本里**真跑**（结果见下）；另外 **2 张**（T23 `--auto`、T25 `--auto`）
源码里硬编码了 `workplace/study`，会读活包 —— 本卡**不执行**，登记为阻断，不把 blocked 改成绿。

- **T29 没有同名入口**（`test/audit/T29.mjs` 不存在）—— 不按卡号发明命令。冻结判词是 **WAIVED**
  （用户 2026-10-19 裁定：不公开发布，离线包分发许可核验整条跳过）。**弃权不是 PASS。**
- **`test/audit/release.mjs` 恒 exit 2 是设计**：私有分发模式（`dsh.distribution.mode=private`）下未做再分发合规核验；
  缺审计材料导致的 `open` 也走 exit 2。**不许**把它当"预期终态已达成"。回归入口：`node --test test/audit/release-exit-code.mjs`（11 条，已复验 exit 0）。
- 隔离办法：把仓源（无 `.git`）+ 冻结证据只读复制到 `E:\Temp\u01-s0-dlane\tree`，在副本里跑；
  证据落在**副本自己的** `audit-evidence/` 下。主树的冻结 T 证据一个字节都没动（见 baseline 的 `mainTreeTEvidence`）。

副本里真实复验结果（`audit-evidence/U01/t-reverify-runs.json`）：

| 入口 | 退出码 | 判词行 |
|---|---:|---|
| `node test/audit/T13.mjs --automated-only` | 0 | `AUTO-ONLY T13-AUTO checks=37 failed=0 skipped=0` |
| `node test/audit/T16.mjs --automated-only` | 0 | `AUTO-ONLY T16-AUTO checks=25 failed=0 skipped=0` |

> 自动层判词是 `AUTO-ONLY <卡>-AUTO`，**不是**整卡 PASS —— 真实宿主/浏览器证据仍缺（T13/T16 整卡冻结在 BLOCKED）。

## 8. 全量基线（本轮唯一一次，红也如实记）

- 命令：`node test/all.mjs --pack=E:\workplace\study --mode=real` → 退出码 **1**（红），用时 303.8s，无信号、无超时。
- 课程包闸门：**35 / 38**（失败 3：`tools/offline-server.test.mjs`、`tools/skill-draft-sync.test.mjs`、`tools/notes-card.test.mjs`）。
- 插件套件：**56 套 · 2883 条断言**（run-all 自报）；逐套摘要相加 2980 通过 / 36 失败。
- 红套件（7）：`brief`、`challenge-gate`、`pack-model`、`pack-scaffold`、`parity-registry`、`practice`、`settings-teaching`。
- skipped：2（`practice:practice:026`、`visual:visual:030`，理由：没起 3091 预览服务/浏览器）。

红套件逐条失败项名与退出码见 `docs/unify/baseline.json` 的 `fullGate.redSuites`，原始 stdout/stderr 与
逐套 `execution.json` 在 `audit-evidence/U01/full-gate/`。**七红不含在假定六红里的一条（`settings-teaching`）如实登记。**

## 9. §12 未裁决：两处旧测试冲突

**授权状态：unresolved（未裁决）。** 本卡不代选 A/B，也不把"准备"解释成"已授权"。

| # | 文件 | 旧断言原文（执行时按原文搜索，不认死行号） | 影响 |
|---|---|---|---|
| ① | `test/mirror-parity.mjs` | `a.anchor` 与 `b.anchor` 均为 `spring-boot/0001` | 条件 A 下由 **U09** 独占替换（含必要夹具输入） |
| ② | `test/intake.mjs` | `read1.latest.vue` / `read2.latest.vue` | 条件 A 下由 **U10** 独占替换裸 point 预期 |

- 只有 **A**（受控测试契约迁移授权）才允许在 U09/U10/U14 卡内**同卡原子替换**这些旧预期并逐条记真实 Δ；
- **B**（继续禁止任何旧断言变更）下 U09/U10/U14 明确 **BLOCKED**，下游不实施；
- U14 不得重改 U09 那一行，只在新专项补拒绝/迁移断言；
- 没有"长期兼容层"这个第三选项。

## 10. 变更纪律

1. 任何卡发现本文件某条与基线源码不符 → **暂停该卡**，先带证据报差异（路径 + 真实签名/字节），不许静默适配。
2. 本文件只由 U01 写；`baseline.json` 同理。每卡只写自己的 `docs/unify/receipts/Uxx.json`。
3. 基线不因后续变化被覆盖或重新采集；`base.sha` 是**固定提交对象**，不是"今天的工作树"。
4. 双实现（`pointKey`/`lessonKey` + `point-ref.js` 内联）在 U09 收敛前必须一直登记在这里。
