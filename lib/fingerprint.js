/**
 * lib/fingerprint.js — 项目目录的**内容指纹** + 探针版本：ESM 适配层
 * ------------------------------------------------------------------
 * U 系列（U-SPEC §5）把三类确定性计算收为**单一源码**：指纹算法的唯一计算在
 * `lib/unify/fingerprint.cjs`。本文件做两件事：
 *   ① 桥：`createRequire(import.meta.url)` 拿 CJS 内核，**具名再导出** `digestTree` 与
 *      `PROBE_VERSION`（导出面与改前逐字相同：`digestTree` / `PROBE_SOURCES` / `PROBE_VERSION`）；
 *   ② 保留**插件侧独有**的东西：`PROBE_SOURCES`（探针导入闭包清单）与它的算法说明 ——
 *      包侧 `tools/fingerprint.js` 从来没有这个清单，所以它不进内核（内核只放两侧都要的计算）。
 *
 * 干什么：给学生项目目录算一个 `sha256:` 开头的内容指纹，当**判据快照的新鲜度**用
 * （`learning-records/state.json` 的 `projects[].sourceDigest` ↔ 提交时现算值）。
 * 为什么不用 mtime / 时间戳：探针产物「内容没变就不重写」，学生改了又改回时 mtime
 * 永不前进 → mtime 比对会**永远报过期**（死锁）；内容指纹无此病 —— 内容相同即判新。
 *
 * 算法（插件侧 / 包侧 / 模板副本三份**同一份字节** —— 一漂 = 永远 stale-snapshot = 点亮全废；
 * 完整算法说明见 `lib/unify/fingerprint.cjs` 的文件头）：
 *   递归枚举文件 → 跳过 SKIP_DIR → 路径按字节序排序 → 每文件一行 `path\0sha256(去BOM内容)`
 *   → 各行以 '\n' 拼接 → 整串 sha256。
 *
 * 对拍：`test/mirror-parity.mjs` 的指纹节 + PROBE_VERSION 条目（登记见课程包
 * `_plugin-prep/同源实现-对拍登记表.md`）。U04 起两侧只剩**一份**计算，对拍照跑（它判的是行为）。
 */
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const core = require_('./unify/fingerprint.cjs')

/** 项目目录的内容指纹 → `sha256:<hex>`（算法见 `lib/unify/fingerprint.cjs`） */
export const digestTree = core.digestTree

/* ── 探针版本（PROBE_VERSION）：快照新鲜度的**第二把尺子** ─────────────────────────
 * 为什么需要（2026-09-24 实测缺陷）：`learning-records/state.json` 的挑战判定是**探针算出来的**，
 * 而门禁判新鲜只比学生代码树的 `projects[].sourceDigest` —— 探针实现改了、快照还是旧判词时，
 * 指纹照样"新鲜" ⇒ 门禁拿**旧判词**拦人（现场：端点解析刚扩完、重启宿主后 `challengeGate`
 * 仍回 criteria-not-met「缺：有 PATCH …/complete」，手动 `whale_state write:true` 刷一次
 * 立刻放行 —— 中间没有任何东西告诉人"该刷新了"）。所以快照顶层带 `probeVersion`，
 * 判定先比它：不等 / 缺失 → `stale-snapshot` → `lib/gate.js` 的 `challengeGate`（probe:true）
 * 走它**本来就有的**「stale-snapshot → 自动重判一次 + 原子写回」自愈路（v3 §4.1）
 * ⇒ 改完探针不用手动刷新，第一次调用就自愈。
 *
 * ⚠️ **唯一字面量在 `lib/unify/fingerprint.cjs`**（U04 起）：三份同源文件已收成一份计算，
 *    `PROBE_VERSION` 只能在权威内核里写一次，本文件与包侧包装器都从那儿取 ——
 *    不许在这里再写第二份字面量（那正是"两处一漂"的成因）。
 *    值 = 探针源指纹的**预计算**结果；改探针源 → 手动改内核里那一个值（改了它，所有旧快照
 *    自动判过期、自愈路重判一次 —— 代价只是重刷，宁多勿漏）。
 *    钉子在 `test/challenge-gate.mjs`「探针版本」节：当场按同一算法重算并逐字比 ——
 *    **改了探针却没改这个值 → 红**，失败消息里把该贴的新值打出来给人贴。
 *
 * 算法（与钉子逐字复算同一套）：
 *   sha256(Buffer.concat([readFileSync(PROBE_SOURCES[0]), Buffer.from('\0'),
 *                         readFileSync(PROBE_SOURCES[1]), Buffer.from('\0'), …]))
 *   取前 16 位 hex，冠 'p:'。文件间以 '\0' 分隔（首尾不留）；内容取**原始字节** ——
 *   不做 digestTree 那套 BOM 归一（这里比的是**我们自己的源码**：改了就该重算，BOM 也是改动）。
 *   拼接顺序 = PROBE_SOURCES 的数组顺序：入口两件在前，其余按字节序。
 *
 * PROBE_SOURCES = 探针的**导入闭包**（从 lib/state.js + lib/state-scan.js 出发、只跟 './'
 * 相对导入）—— **脚本机械算的**，不是眼看的（生成与钉子同一条 walk 规则：探针长了新依赖
 * 而清单没跟上 → 钉子红，逼人把它加进清单）。
 *
 * 现为 **11 件**：决-4（授权 = 用户的「全按推荐」，落账见 `docs/unify/authorization.json` 的
 * decisions 决-4）把 `lib/pack-model.js` 现已在用的两个内核 —— `lib/unify/identity.cjs` 与
 * `lib/unify/pack.cjs` —— 补进清单（此前停在 9 件，与真实闭包 11 件不符：内核改动不会让旧快照
 * 过期）。插入位置按本文件的排序规则：都在 `lib/text.js` 之后（字节序 t < u），identity 在 pack 之前。
 *
 * 本清单**只属于插件侧**（包侧没有探针，也就没有这份闭包）—— 所以它留在本文件，不进
 * `lib/unify/fingerprint.cjs`；这是 U04 回执里登记的归属决定。
 */
export const PROBE_SOURCES = [
  "lib/state.js",
  "lib/state-scan.js",
  "lib/adapters/jvm.js",
  "lib/evidence-io.js",
  "lib/evidence.js",
  "lib/exec.js",
  "lib/pack-model.js",
  "lib/plan.js",
  "lib/text.js",
  "lib/unify/identity.cjs",
  "lib/unify/pack.cjs"
]
// ⚠️ **故意排除 lib/fingerprint.js**（闭包里有它：state-scan.js 吃 digestTree）——
//    它就是**新鲜度机制本身**：它一变 sourceDigest 自会对不上、老快照自己就过期了，
//    不能自己吃自己（算进来 = 调整新鲜度机制会误伤所有快照的 probeVersion 判定）。

/** 探针版本：这份快照是哪个版本的探针算出来的（唯一字面量在 `lib/unify/fingerprint.cjs`） */
export const PROBE_VERSION = core.PROBE_VERSION
