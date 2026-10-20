/**
 * tools/fingerprint.js — 项目目录的**内容指纹**（课程包侧）：纯委托包装器
 * ------------------------------------------------------------------
 * **权威实现只有一份**：`lib/unify/fingerprint.cjs`（U-SPEC §5 的单一源码；U19 会把它
 * 逐字节生成成课程包里的 `tools/unify/fingerprint.cjs`）。本文件**不含任何计算、也不写第二份
 * 常量** —— `digestTree` 与 `PROBE_VERSION` 都从内核取。
 *
 * 为什么包侧也要有这一件：包侧 `tools/ask-server.js` 判「快照新鲜度」要它
 * （`judgeLightup` 先比 `probeVersion`、再比 `sourceDigest`），而它 require 的名字是
 * `tools/fingerprint.js`，件名不能改，所以保留这一层壳。
 *
 * ⚠️ 改前这一件里写着 `const PROBE_VERSION = 'p:…'` 的**第二份字面量**（与插件侧逐字同值，
 *    靠 `test/mirror-parity.mjs` 的 ③b 节逐字比较钉住）。U04 收成一份之后它只在内核里存在
 *    一次 —— "三份一漂"的成因被结构消除了。
 */
'use strict';

module.exports = require('./unify/fingerprint.cjs');
