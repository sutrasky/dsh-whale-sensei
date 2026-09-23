/**
 * tools/fingerprint.js — 项目目录的**内容指纹**（同源对：插件侧 lib/fingerprint.js）
 * ------------------------------------------------------------------
 * 干什么：给学生项目目录算一个 `sha256:` 开头的内容指纹，当**判据快照的新鲜度**用
 * （`learning-records/state.json` 的 `projects[].sourceDigest` ↔ 提交时现算值）。
 * 为什么不用 mtime / 时间戳：探针产物「内容没变就不重写」，学生改了又改回时 mtime
 * 永不前进 → mtime 比对会**永远报过期**（死锁）；内容指纹无此病 —— 内容相同即判新。
 *
 * 算法（包侧 / 插件侧 / 模板副本三份逐字同源 —— 一漂 = 永远 stale-snapshot = 点亮全废）：
 *   ① 递归枚举目录下全部**文件**（相对路径 POSIX `/`）；
 *   ② 跳过目录名（与插件 lib/state-scan.js 的 walkFiles 的 SKIP_DIR 同一份清单）：
 *      target / build / out / dist / node_modules / .git / .mvn / .idea / .vscode / .backup / .tmp*
 *      —— 清单一漂两侧指纹就对不上，改这里必须同步另一侧（对拍见 mirror-parity）；
 *   ③ 路径按**字节序**排序（Buffer.compare）；
 *   ④ 每文件一行 `path + '\0' + sha256(内容)`。内容取**原始字节**：换行编码变了指纹就变；
 *      唯一例外是 **BOM 归一**（剥文件头与每个行首的 U+FEFF）—— PowerShell 写盘的常态
 *      噪音、本仓 `stripBom`/`splitLines` 的同一纪律（bom-tolerance：带不带 BOM 必须同结果）；
 *   ⑤ 各行用 '\n' 拼起来，对整串再 sha256。
 * 同输入同字节同指纹；多一个文件 / 改一个字节（BOM 字节除外）→ 指纹必变（对拍的反空转条目）。
 *
 * 对拍：插件 `test/mirror-parity.mjs` 的指纹节（登记见本包 `_plugin-prep/同源实现-对拍登记表.md`）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 排除目录名：必须与插件 `lib/state-scan.js` 的 walkFiles（SKIP_DIR）逐字一致 */
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

module.exports = { digestTree };
