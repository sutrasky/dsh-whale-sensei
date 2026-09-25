/**
 * lib/fingerprint.js — 项目目录的**内容指纹**（同源对：课程包侧 tools/fingerprint.js）
 * ------------------------------------------------------------------
 * 干什么：给学生项目目录算一个 `sha256:` 开头的内容指纹，当**判据快照的新鲜度**用
 * （`learning-records/state.json` 的 `projects[].sourceDigest` ↔ 提交时现算值）。
 * 为什么不用 mtime / 时间戳：探针产物「内容没变就不重写」，学生改了又改回时 mtime
 * 永不前进 → mtime 比对会**永远报过期**（死锁）；内容指纹无此病 —— 内容相同即判新。
 *
 * 算法（插件侧 / 包侧 / 模板副本三份逐字同源 —— 一漂 = 永远 stale-snapshot = 点亮全废）：
 *   ① 递归枚举目录下全部**文件**（相对路径 POSIX `/`）；
 *   ② 跳过目录名（与本目录 state-scan.js 的 walkFiles 的 SKIP_DIR 同一份清单）：
 *      target / build / out / dist / node_modules / .git / .mvn / .idea / .vscode / .backup / .tmp*
 *      —— 清单一漂两侧指纹就对不上，改这里必须同步另一侧（对拍见 mirror-parity）；
 *   ③ 路径按**字节序**排序（Buffer.compare）；
 *   ④ 每文件一行 `path + '\0' + sha256(内容)`。内容取**原始字节**：换行编码变了指纹就变；
 *      唯一例外是 **BOM 归一**（剥文件头与每个行首的 U+FEFF）—— PowerShell 写盘的常态
 *      噪音、本仓 `stripBom`/`splitLines` 的同一纪律（bom-tolerance：带不带 BOM 必须同结果）；
 *   ⑤ 各行用 '\n' 拼起来，对整串再 sha256。
 * 同输入同字节同指纹；多一个文件 / 改一个字节（BOM 字节除外）→ 指纹必变（对拍的反空转条目）。
 *
 * 对拍：`test/mirror-parity.mjs` 的指纹节（登记见课程包 `_plugin-prep/同源实现-对拍登记表.md`）；
 * 文件尾部另有 **PROBE_VERSION**（探针版本）—— 三份同源文件里它的值必须逐字相同（同套对拍）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 排除目录名：必须与 `lib/state-scan.js` 的 walkFiles（SKIP_DIR）逐字一致 */
const SKIP_DIR = /^(target|build|out|dist|node_modules|\.git|\.mvn|\.idea|\.vscode|\.backup|\.tmp.*)$/
const LF_BUF = Buffer.from([0x0a])

function walk(dir, prefix, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const e of entries) {
    const rel = prefix ? prefix + '/' + e.name : e.name
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue
      walk(path.join(dir, e.name), rel, out)
    } else if (e.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/** 剥 BOM（文件头 + 每个行首的 EF BB BF）；其余字节原样保留 */
function stripBomBytes(buf) {
  const pieces = []
  const push = (from, to) => {
    let s = from
    if (to - s >= 3 && buf[s] === 0xef && buf[s + 1] === 0xbb && buf[s + 2] === 0xbf) s += 3
    pieces.push(buf.subarray(s, to))
  }
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue
    push(start, i)
    pieces.push(LF_BUF)
    start = i + 1
  }
  push(start, buf.length)
  return Buffer.concat(pieces)
}

/** 项目目录的内容指纹 → `sha256:<hex>`（算法见文件头；三份逐字同源） */
export function digestTree(dir) {
  const files = walk(dir, '', [])
  files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const lines = files.map((rel) => {
    let buf = Buffer.alloc(0)
    try { buf = fs.readFileSync(path.join(dir, rel)) } catch (e) { /* 读不动按空内容计（两侧同规） */ }
    return rel + '\0' + crypto.createHash('sha256').update(stripBomBytes(buf)).digest('hex')
  })
  return 'sha256:' + crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

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
 * 为什么住这个文件：它是「插件 lib/fingerprint.js / 包 tools/fingerprint.js /
 * 模板 lib/pack-template/tools/fingerprint.js」三份同源、且有对拍登记的文件
 * （登记表 `study/_plugin-prep/同源实现-对拍登记表.md` 第 20 行；算法说明第 40 行起；
 * 对拍 = `test/mirror-parity.mjs` 的指纹节 + PROBE_VERSION 三份逐字同值条目）——
 * 版本号搭现成的镜像与对拍机器，**不新造一套**。
 *
 * ⚠️ 必须是**字面量常量**，不许运行时读自己的源码来算：插件是 junction 加载、还要在
 *    "别人机器"上跑，运行期取自身路径不可靠。值 = 下面算法**预计算**的结果；改探针源 →
 *    手动改这里（改了它，所有旧快照自动判过期、自愈路重判一次 —— 代价只是重刷，宁多勿漏）。
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
 */
export const PROBE_SOURCES = [
  // lib/state.js —— 判定真源住这儿：detectFacts（类 / 注解 / 端点 / 配置键的事实抽取，
  //   **端点解析就在这一层**）与 judgeChallenges（挑战三态判定）直接决定快照里的 done / missing。
  'lib/state.js',
  // lib/state-scan.js —— 扫描与组装：找项目 / 找 EXPECT.json / 算 projects[].sourceDigest /
  //   writeState 的落盘形态。它一变，快照里"有什么、长什么样"就变 ⇒ 判词可能变。
  'lib/state-scan.js',
  // lib/exec.js —— 机械闭包进来的（pack-model.js 吃它的 spawnFailureHint）。
  //   它只影响**失败时怎么说**，影响不到判词；但闭包按「谁被 import」机械算、**不靠眼看删减**
  //   —— 2026-09-25 新1（EPERM 人话）落地时，正是这条钉子逼着把它加进来的。
  'lib/exec.js',
  // lib/pack-model.js —— state-scan 吃它的 NOTES_REL（笔记台账的相对路径）：
  //   路径口径一变，快照里的 notes / signals 计数就变 ⇒ 判词可能变。
  'lib/pack-model.js',
  // lib/plan.js —— 机械闭包进来的（pack-model.js 吃它的 planFrontier）。眼下探针链只消费
  //   NOTES_REL，它的内容影响不到判词；但闭包按「谁被 import」机械算、**不靠眼看删减** ——
  //   多算的代价只是旧快照过期一次（自愈路自动重判），漏算的代价就是本缺陷本身。
  'lib/plan.js',
  // lib/text.js —— stripBom / splitLines：扫描时怎么剥 BOM、怎么切文件内容。
  //   切法一变，detectFacts 看到的文本就变（CRLF / BOM 处理漂了会直接改判词）。
  'lib/text.js',
]
// ⚠️ **故意排除 lib/fingerprint.js**（闭包里有它：state-scan.js 吃 digestTree）——
//    它就是**新鲜度机制本身**：它一变 sourceDigest 自会对不上、老快照自己就过期了，
//    不能自己吃自己（算进来 = 调整新鲜度机制会误伤所有快照的 probeVersion 判定）。

/** 探针版本：这份快照是哪个版本的探针算出来的（算法与清单见上面注释块；三份同源文件里值逐字相同） */
export const PROBE_VERSION = 'p:679d5760bcb2f380'
