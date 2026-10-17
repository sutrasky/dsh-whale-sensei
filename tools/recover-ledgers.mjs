#!/usr/bin/env node
'use strict'
/**
 * recover-ledgers.mjs — **独占离线恢复** CLI（T09 / 报告 C01）
 * ------------------------------------------------------------------
 * 为什么要有它：`ledger-transaction.cjs` 的提交协议在"回滚也失败"时**故意**留着日志
 * （`.whale-txn/<uuid>/`）与写锁（`.whale-write.lock`），并让**下一次普通写被拒** ——
 * 那是对的（不许静默宣称已恢复），但必须有一条**离线**的路把残骸收干净：
 * 回到「原状态」或「完整已提交状态」，没有半提交。
 *
 * 用法：
 *   node tools/recover-ledgers.mjs <课程包根> --offline --confirm --owner=<令牌>
 *   node tools/recover-ledgers.mjs <课程包根> --check        # 只看有没有待恢复的日志（只读）
 *
 * 语义（与 `recoverPack` 逐条一致，本文件只是薄壳）：
 *   · `--offline` 与 `--confirm` **两个都要给** —— 恢复会改写台账，缺一个就拒（exit 2）
 *   · `--owner=<令牌>` 必填：恢复要**显式接管**写锁（那是唯一的强抢路径）
 *   · `journal.state === 'committed'` → 保留现状；否则按备份还原（**原状态**）
 *   · 恢复本身失败 → 日志与锁都保留，exit 1（下次普通写仍被拒，别当"已经好了"）
 *
 * 退出码：0 = 恢复完成 / 没有残骸；1 = 恢复没做完；2 = 用法或材料缺失（**不是** PASS）。
 *
 * 位置（T09-A1 归位）：本文件建在**仓根** `tools/recover-ledgers.mjs`（与 `tools/upgrade-pack.mjs`
 * 同层的运维工具，**不随包发**）；它解析的事务件 `lib/pack-template/tools/ledger-transaction.cjs`
 * 才是随包件。所以 `lib/pack-template/**` 里没有本文件，`TEMPLATE_FILES` / `FROM_PLUGIN` 里也没有它。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 事务件的位置**相对本脚本**解析（不用 cwd、不写绝对路径 —— 谁从哪儿把它调起来都不该影响它）：
 *   · 本脚本 = 仓根 `tools/recover-ledgers.mjs`（运维工具，**不随包**）
 *   · 事务件 = `lib/pack-template/tools/ledger-transaction.cjs`（**随包**发的那一件）
 *
 * 两件必须来自**同一次插件安装**：找不到就如实报错并 exit 2（退出码语义里"不是 PASS"那一档），
 * 不做"去别处猜一个事务件"的降级 —— 猜错了跑的是另一套协议，比不恢复更坏。
 */
function loadTxn() {
  const local = path.join(HERE, '..', 'lib', 'pack-template', 'tools', 'ledger-transaction.cjs')
  if (fs.existsSync(local)) return require(local)
  throw new Error(`找不到事务件：${path.resolve(local)} —— 本 CLI 在仓根 tools/、事务件在 lib/pack-template/tools/，`
    + '这两个文件必须来自同一个插件安装（缺了事务件就不恢复，别去别处猜一个来跑）')
}

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')))
const ownerArg = argv.find((a) => a.startsWith('--owner='))
const root = argv.find((a) => !a.startsWith('--'))

function usage(why) {
  process.stderr.write(`recover-ledgers：${why}\n`
    + '用法：node tools/recover-ledgers.mjs <课程包根> --offline --confirm --owner=<令牌>\n'
    + '      node tools/recover-ledgers.mjs <课程包根> --check\n')
  process.exit(2)
}

if (!root) usage('没有给课程包根目录')
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) usage(`课程包根不是一个目录：${root}`)

let T
try {
  T = loadTxn()
} catch (e) {
  usage(e && e.message ? e.message : String(e))
}

// ── --check：只读地报告有没有待恢复的日志（不改任何字节）─────────────────────
if (flags.has('--check')) {
  const pending = T.pendingRecovery(fs, path.resolve(root))
  const all = T.listJournals(fs, path.resolve(root))
  const lock = fs.existsSync(T.txnPaths(root).lock)
  if (!all.length) {
    process.stdout.write(`OK recover-ledgers：${path.resolve(root)} 没有事务残骸（锁：${lock ? '在' : '无'}）\n`)
    process.exit(0)
  }
  process.stdout.write(`PENDING recover-ledgers：${all.length} 条残骸，其中 ${pending.length} 条等离线恢复；`
    + `锁：${lock ? '在' : '无'}（--check 只读，不改任何字节）\n`)
  for (const j of all) {
    process.stdout.write(`  - ${j.id} state=${j.journal ? j.journal.state : '(没有 journal)'} files=${j.journal && Array.isArray(j.journal.files) ? j.journal.files.length : 0}\n`)
  }
  process.exit(pending.length ? 1 : 0)
}

const r = T.recoverPack(path.resolve(root), {
  offline: flags.has('--offline'),
  confirm: flags.has('--confirm'),
  ownerToken: ownerArg ? ownerArg.slice('--owner='.length) : '',
  fs,
})

if (r.state === 'rejected' || r.state === 'busy') {
  process.stderr.write(`FAIL recover-ledgers：${r.error}\n`)
  process.exit(2)
}
const line = `recovered=${r.restored.length} keptCommitted=${r.keptCommitted.length} discarded=${r.discarded.length} swept=${r.swept ? r.swept.length : 0}`
if (!r.ok) {
  process.stderr.write(`FAIL recover-ledgers：${r.error}\n  ${line}\n`)
  process.exit(1)
}
process.stdout.write(`PASS recover-ledgers：${path.resolve(root)} ${line}${r.error ? `（提示：${r.error}）` : ''}\n`)
process.exit(0)
