/**
 * lib/unify/fingerprint.cjs — 项目目录的**内容指纹**：权威实现（唯一一份计算）
 * ==================================================================
 * 为什么住 `lib/unify/`（U-SPEC §5）：指纹算法曾经有三份逐字同源的实现 ——
 * 插件 `lib/fingerprint.js`（ESM）、课程包 `tools/fingerprint.js`（CJS）、
 * 随包模板 `lib/pack-template/tools/fingerprint.js`（CJS）—— 一漂 = 永远 `stale-snapshot`
 * = 点亮全废（R13）。U 系列收成一份：
 *
 *   · 本文件 = 唯一手工源码（CommonJS；只用内置 `node:fs` / `node:path` / `node:crypto`，
 *     **不读环境变量、不看时钟、不联网**）；
 *   · `lib/fingerprint.js` = ESM 适配层（导出面逐字保留；`PROBE_SOURCES` 是**插件侧**清单，
 *     只住那一件，本文件不携带 —— 包侧旧的 `module.exports` 里也从来没有它）；
 *   · `lib/pack-template/tools/fingerprint.js` = 包侧包装器（纯委托 `./unify/fingerprint.cjs`）。
 *
 * 干什么：给学生项目目录算一个 `sha256:` 开头的内容指纹，当**判据快照的新鲜度**用
 * （`learning-records/state.json` 的 `projects[].sourceDigest` ↔ 提交时现算值）。
 * 为什么不用 mtime / 时间戳：探针产物「内容没变就不重写」，学生改了又改回时 mtime
 * 永不前进 → mtime 比对会**永远报过期**（死锁）；内容指纹无此病 —— 内容相同即判新。
 *
 * 算法（宿主 / 包侧 / 随包副本三处**同源同一份字节** —— 一漂 = 永远 stale-snapshot）：
 *   ① 递归枚举目录下全部**文件**（相对路径 POSIX `/`）；
 *   ② 跳过目录名（与 `lib/state-scan.js` 的 walkFiles 的 SKIP_DIR 同一份清单）：
 *      target / build / out / dist / node_modules / .git / .mvn / .idea / .vscode / .backup / .tmp*
 *      —— 清单一漂两侧指纹就对不上，改这里必须同步另一侧（对拍见 mirror-parity）；
 *   ③ 路径按**字节序**排序（Buffer.compare）；
 *   ④ 每文件一行 `path + '\0' + sha256(内容)`。内容取**原始字节**：换行编码变了指纹就变；
 *      唯一例外是 **BOM 归一**（剥文件头与每个行首的 U+FEFF）—— PowerShell 写盘的常态
 *      噪音、本仓 `stripBom`/`splitLines` 的同一纪律（bom-tolerance：带不带 BOM 必须同结果）；
 *   ⑤ 各行用 '\n' 拼起来，对整串再 sha256。
 * 同输入同字节同指纹；多一个文件 / 改一个字节（BOM 字节除外）→ 指纹必变（对拍的反空转条目）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 排除目录名：必须与 `lib/state-scan.js` 的 walkFiles（SKIP_DIR）逐字一致 */
const SKIP_DIR = /^(target|build|out|dist|node_modules|\.git|\.mvn|\.idea|\.vscode|\.backup|\.tmp.*)$/;
const LF_BUF = Buffer.from([0x0a]);

function walk(dir, prefix, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      walk(path.join(dir, e.name), rel, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** 剥 BOM（文件头 + 每个行首的 EF BB BF）；其余字节原样保留 */
function stripBomBytes(buf) {
  const pieces = [];
  const push = (from, to) => {
    let s = from;
    if (to - s >= 3 && buf[s] === 0xef && buf[s + 1] === 0xbb && buf[s + 2] === 0xbf) s += 3;
    pieces.push(buf.subarray(s, to));
  };
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    push(start, i);
    pieces.push(LF_BUF);
    start = i + 1;
  }
  push(start, buf.length);
  return Buffer.concat(pieces);
}

/** 项目目录的内容指纹 → `sha256:<hex>`（算法见文件头；三份逐字同源） */
function digestTree(dir) {
  const files = walk(dir, '', []);
  files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const lines = files.map((rel) => {
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(path.join(dir, rel)); } catch (e) { /* 读不动按空内容计（两侧同规） */ }
    return rel + '\0' + crypto.createHash('sha256').update(stripBomBytes(buf)).digest('hex');
  });
  return 'sha256:' + crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/* ── 探针版本（PROBE_VERSION）：快照新鲜度的**第二把尺子**，全仓唯一字面量在这里 ─────
 * 为什么需要（2026-09-24 实测缺陷）：`learning-records/state.json` 的挑战判定是**探针算出来的**，
 * 而门禁判新鲜只比学生代码树的 `projects[].sourceDigest` —— 探针实现改了、快照还是旧判词时，
 * 指纹照样"新鲜" ⇒ 门禁拿**旧判词**拦人（现场：端点解析刚扩完、重启宿主后 `challengeGate`
 * 仍回 criteria-not-met「缺：有 PATCH …/complete」，手动 `whale_state write:true` 刷一次
 * 立刻放行 —— 中间没有任何东西告诉人"该刷新了"）。所以快照顶层带 `probeVersion`，
 * 判定先比它：不等 / 缺失 → `stale-snapshot` → `lib/gate.js` 的 `challengeGate`（probe:true）
 * 走它**本来就有的**「stale-snapshot → 自动重判一次 + 原子写回」自愈路（v3 §4.1）
 * ⇒ 改完探针不用手动刷新，第一次调用就自愈。
 *
 * 为什么住这个文件（U 系列之后）：三份同源文件已收成一份计算，**这个字面量只能留一份**；
 * 宿主 `lib/fingerprint.js` 与包侧 `tools/fingerprint.js` 都从这里取（U19 的随包生成器把这个
 * 文件逐字节复制成 `tools/unify/fingerprint.cjs`）。清单 `PROBE_SOURCES` 是**插件侧**的东西
 * （它是"探针导入闭包"的清单，包侧从来没有），只住 `lib/fingerprint.js`。
 *
 * ⚠️ 必须是**字面量常量**，不许运行时读自己的源码来算：插件是 junction 加载、还要在
 *    "别人机器"上跑，运行期取自身路径不可靠。值 = 下面算法**预计算**的结果；改探针源 →
 *    手动改这里（改了它，所有旧快照自动判过期、自愈路重判一次 —— 代价只是重刷，宁多勿漏）。
 *
 * 算法（与钉子逐字复算同一套，见 `lib/fingerprint.js` 的 PROBE_SOURCES 注释块）：
 *   sha256(Buffer.concat([readFileSync(PROBE_SOURCES[0]), Buffer.from('\0'),
 *                         readFileSync(PROBE_SOURCES[1]), Buffer.from('\0'), …]))
 *   取前 16 位 hex，冠 'p:'。文件间以 '\0' 分隔（首尾不留）；内容取**原始字节** ——
 *   不做 digestTree 那套 BOM 归一（这里比的是**我们自己的源码**：改了就该重算，BOM 也是改动）。
 *   拼接顺序 = PROBE_SOURCES 的数组顺序：入口两件在前，其余按字节序。
 *
 * 值的历史（P1，2026-10-20 重算；授权 = 用户的「选A和授权p1和p2」，落账见
 * `docs/unify/authorization.json` 的 scope.P1 与 `docs/unify/receipts/P1-P2.json`）：
 *   · 旧值 e3472ea71c33181c 是 U 系列改动**之前**那九个探针源字节的指纹；
 *   · U04/U09/U18 合法改了其中六个（lib/text.js、lib/plan.js、lib/pack-model.js、lib/state.js、
 *     lib/evidence.js、lib/evidence-io.js），旧值不再等于重算值（钉子 challenge-gate ⑧① 会红）；
 *   · P1 时的值 hex 为 45a70ecdc10f03d4（前缀 p:），是上面那套算法对**当时**九个源（按
 *     PROBE_SOURCES 顺序、原始字节、'\0' 分隔，合计 160695 字节）的 sha256 前 16 位。
 *     旧→新只换**这一个**常量，算法与清单条目一个没动。
 *
 * 值的历史（决-4，2026-10-20 重算；授权 = 用户的「全按推荐」，落账见
 * `docs/unify/authorization.json` 的 decisions 决-4 与 `docs/unify/receipts/P1-P2.json`）：
 *   · 原因：`lib/pack-model.js` 现在 `import` 了 `lib/unify/identity.cjs` 与 `lib/unify/pack.cjs`
 *     ⇒ 探针导入闭包已是 **11** 件，而 `PROBE_SOURCES` 还停在 9 件（闭包 != 清单 ⇒
 *     challenge-gate ⑧② / T26 F01 红，且这两个内核改动不会让旧快照过期 —— 正是本机制要防的）；
 *   · 动作：把这两件补进 `lib/fingerprint.js` 的 `PROBE_SOURCES`（顺序仍「入口两件在前、其余按字节序」：
 *     都排在 lib/text.js 之后，identity 在 pack 之前），9 → 11；**其余九条一条没动、没重排**；
 *   · 值：P1 的 45a70ecdc10f03d4 → 本次新值 = 下一行那个唯一字面量（hex 为 051afdd22ab1b6cb）。
 *     同一套算法对当前十一个源（原始字节、'\0' 分隔，合计 205618 字节 = 文件字节 205608 + 10 个 '\0'）。
 *     这是**把清单与真实闭包对齐**，不是 P1 notAuthorized 里说的「为了凑值而增删条目」：
 *     算法、分隔符、取位、前缀一个没改。
 *   · 本注释里**故意不复写**完整值串：`test/audit/U07.mjs` A08 与 `test/audit/U04.mjs` A04 ④
 *     都是**原文扫描** `p:<16 位 hex>`，注释里复写一次就会被数成"第二份字面量"。值只在下一行。
 */
const PROBE_VERSION = 'p:1035fda92c4139d2';

module.exports = { digestTree, PROBE_VERSION };
