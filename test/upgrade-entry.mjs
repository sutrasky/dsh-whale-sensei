#!/usr/bin/env node
/**
 * test/upgrade-entry.mjs —— 升级引擎这条命令，**npm 装出来的包里也真能跑**（Bug4）
 * ------------------------------------------------------------------
 * 跑：node test/upgrade-entry.mjs
 *
 * 病（2026-10-19 修）：所有拒绝提示都写 `node tools/upgrade-pack.mjs --root=<包根> --plan`，
 * 而 `tools/` 不在 `package.json` 的 `files` 里 —— **npm 装出来的包里根本没有那个文件**。
 * 于是提示里的"修法"在用户机器上逐字是 ENOENT：给了条路，路的尽头是墙。
 *
 * 本套件**不做源码文本断言**，全是真东西：
 *   ① `npm pack` 真打 tarball（读它的 `files` 清单：`tools/upgrade-pack.mjs` 在不在）；
 *   ② 把 tarball 解到 `<隔离>/site/node_modules/dsh-whale-sensei/` —— 一个**没有源码仓库**、
 *      没有仓根 `tools/` 的目录；从**这份安装产物**里 import 三个模块，取它们算出来的提示语；
 *   ③ 把提示里的 `--plan` 命令**逐字**当真子进程跑（cwd 也故意放在没有仓库的地方），
 *      看退出码与 stdout 契约（`PLAN ok=true digest=… files=…`）；
 *   ④ `--plan` 只算不写（升级前后目标包引擎件字节摘要不变）；
 *   ⑤ 两步机制还在：`--apply` 少了 `--confirm` / digest 不对 → 非零退出且一个字节都不动；
 *      给了对的 digest 才真的升上去，**升完引擎核验 ok**；
 *   ⑥ 四个提示点（ask-io / rebuild-job / pack-server ×2）用真函数算出来**逐字相同**，
 *      且都指向**同一个可解析且真的存在**的入口。
 *
 * 临时目录只在 `E:\Temp\ws-e2e-20261019`（或 `os.tmpdir()`）下：用环境变量
 * `WHALE_ISO_BASE` 指一个已有的父目录即可（不给就落 os.tmpdir()）。
 * 跑完不删隔离目录 —— 它是本套件的物证（路径打在摘要前面）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './_pack.mjs'

let pass = 0
const fails = []
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m) } else { fails.push(m); console.log('FAIL ' + m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`)

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ISO_BASE = process.env.WHALE_ISO_BASE
  ? path.resolve(process.env.WHALE_ISO_BASE)
  : path.join(os.tmpdir(), 'whale-iso')
fs.mkdirSync(ISO_BASE, { recursive: true })
const ISO = fs.mkdtempSync(path.join(ISO_BASE, 'iso-'))
/** 隔离的"安装产物"：node_modules 下只有这个包，**没有源码仓库** */
const SITE = path.join(ISO, 'site')
const PKG_DIR = path.join(SITE, 'node_modules', 'dsh-whale-sensei')
/** 目标课程包（待升级的旧包） */
const PACKS = path.join(ISO, 'packs')
const TARGET = path.join(PACKS, 'target')

const run = (cmd, { cwd = ISO, timeout = 180000 } = {}) => {
  const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, timeout, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? ''), all: String(r.stdout ?? '') + String(r.stderr ?? '') }
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
/** 整棵树的指纹（rel → sha256）；用来证明"只算不写" */
function snapTree(root) {
  const out = new Map()
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p, r); continue }
      if (e.isFile()) out.set(r, sha256(fs.readFileSync(p)))
    }
  }
  walk(root)
  return out
}
const treeDigest = (root) => sha256([...snapTree(root)].map(([k, v]) => `${k}\t${v}`).sort().join('\n'))
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name)
    if (e.isDirectory()) copyTree(src, dst)
    else if (e.isFile()) fs.copyFileSync(src, dst)
  }
}

console.log('\n[upgrade-entry] npm 装出来的包里，升级命令真能跑')
console.log(`  （隔离目录：${ISO}）`)

/* ══════════ ① npm pack：真 tarball，读它的 files 清单 ══════════ */
const packRes = run(`npm pack --pack-destination "${ISO}" --json`, { cwd: PLUGIN })
ok(packRes.code === 0, `npm pack 成功（exit ${packRes.code}）${packRes.code === 0 ? '' : '：' + packRes.all.slice(0, 400)}`)
let meta = null
try { meta = JSON.parse(packRes.out)[0] } catch { /* 落到下面那条断言 */ }
ok(!!meta && typeof meta.filename === 'string', 'npm pack --json 给出包元数据（filename）')
const TARBALL = meta ? path.join(ISO, meta.filename) : ''
ok(!!TARBALL && fs.existsSync(TARBALL), `tarball 真落盘了：${TARBALL ? path.basename(TARBALL) : '（无）'}`)
const packedPaths = new Set((meta?.files ?? []).map((f) => f.path))
ok(packedPaths.has('tools/upgrade-pack.mjs'),
  `tarball 里**有** tools/upgrade-pack.mjs（旧 files 不含 tools/ ⇒ 提示里的相对路径在 npm 安装里是死的）`)
ok(packedPaths.has('lib/engine.js') && packedPaths.has('lib/adapters/jvm.js'),
  '它 import 的 ../lib/engine.js 与 ../lib/adapters/jvm.js 都随包发')
ok(!packedPaths.has('test/upgrade-entry.mjs'), '证明这不是"从源码仓库跑"：tarball 里没有 test/')

/* ══════════ ② 解到 node_modules：没有源码仓库的隔离安装 ══════════ */
fs.mkdirSync(PKG_DIR, { recursive: true })
const untar = run(`tar -xzf "${TARBALL}" -C "${PKG_DIR}" --strip-components=1`)
ok(untar.code === 0, `tar 解包成功（exit ${untar.code}）${untar.code === 0 ? '' : '：' + untar.err.slice(0, 300)}`)
const ENTRY = path.join(PKG_DIR, 'tools', 'upgrade-pack.mjs')
ok(fs.existsSync(ENTRY), `安装产物里入口真的在：${ENTRY}`)
ok(fs.existsSync(path.join(PKG_DIR, 'lib', 'engine.js')) && fs.existsSync(path.join(PKG_DIR, 'lib', 'adapters', 'jvm.js')),
  '安装产物里 lib/engine.js 与 lib/adapters/jvm.js 都在（入口的两条 import 解析得到）')
ok(!fs.existsSync(path.join(PKG_DIR, 'test')) && !fs.existsSync(path.join(PKG_DIR, 'tools', 'app-server.js')),
  '这个目录里没有源码仓库（无 test/、tools/ 下只有随包发的那一个文件）')

const pkgPath = path.join(PKG_DIR, 'package.json')
ok(fs.existsSync(pkgPath), '安装产物里有 package.json')
const pkgJson = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {}
eq(pkgJson.bin?.['dsh-whale-pack'], 'tools/upgrade-pack.mjs', 'package.json 里 bin 名 dsh-whale-pack 指向随包发的那个文件')
ok(!!pkgJson.bin?.['dsh-whale-pack'] && fs.existsSync(path.join(PKG_DIR, pkgJson.bin['dsh-whale-pack'])), 'bin 指的文件在安装产物里真的存在')
eq(pkgJson.dsh?.distribution?.mode, 'private', 'dsh.distribution.mode 仍是 "private"（本轮不许动）')
ok((pkgJson.files ?? []).includes('tools/upgrade-pack.mjs'), 'package.json 的 files 里点名了这一件')

/* ══════════ ③ 目标课程包：用**安装产物里的模板**造，再改坏一件引擎件 ══════════ */
copyTree(path.join(PKG_DIR, 'lib', 'pack-template'), TARGET)
ok(fs.existsSync(path.join(TARGET, 'presets', 'whale-sensei.css')), '目标包看起来像课程包（presets/whale-sensei.css 在）')
const VICTIM = path.join(TARGET, 'tools', 'build-notes.js')
fs.appendFileSync(VICTIM, '\n// 2026-10-19 夹具：故意改坏一个字节（引擎与受信版本不一致）\n', 'utf8')

/* ══════════ ④ 四个提示点：真函数算出来，逐字同源且指向同一可解析入口 ══════════ */
const url = (p) => pathToFileURL(p).href
const AIO = await import(url(path.join(PKG_DIR, 'lib', 'ask-io.js')))
const RJ = await import(url(path.join(PKG_DIR, 'lib', 'rebuild-job.js')))
const PS = await import(url(path.join(PKG_DIR, 'lib', 'pack-server.js')))
ok(typeof AIO.upgradePackHint === 'function' && typeof RJ.upgradePackHint === 'function' && typeof PS.upgradePackHint === 'function',
  '三个模块各导出了 upgradePackHint（pack-server 的两处提示走同一个函数）')

const hAio = typeof AIO.upgradePackHint === 'function' ? AIO.upgradePackHint(TARGET) : ''
const hJob = typeof RJ.upgradePackHint === 'function' ? RJ.upgradePackHint(TARGET) : ''
const hSrv = typeof PS.upgradePackHint === 'function' ? PS.upgradePackHint(TARGET) : ''
ok(hAio.length > 20 && hJob.length > 20 && hSrv.length > 20, '三处都算得出提示语（不是空串）')
eq(hAio, hJob, '提示语：ask-io 与 rebuild-job **逐字相同**')
eq(hSrv, hJob, '提示语：pack-server（两处共用）与 rebuild-job **逐字相同**')
ok(!/node tools\//.test(hJob), '提示里不再出现仓根相对的 `node tools/…`（那是 npm 用户不存在的路径）')
ok(hJob.includes(ENTRY), `提示里给的入口就是安装产物里那个绝对路径`)
const mEntry = /node "([^"]*upgrade-pack\.mjs)"/.exec(hJob)
const hintEntry = mEntry ? path.resolve(mEntry[1]) : ''
eq(hintEntry, path.resolve(ENTRY), '提示里的入口解析出来 = 安装产物里的入口')
ok(!!hintEntry && fs.existsSync(hintEntry), '提示里的入口**真的存在**（可解析，不是空指路）')
ok(hJob.includes(TARGET), '提示里把课程包根换成了真实绝对路径（不是 <包根> 占位）')
ok(hJob.includes('--plan') && hJob.includes('--apply --confirm --plan-digest='),
  '提示里保住了两步机制（先 --plan，再 --apply --confirm --plan-digest=<digest>）')
ok(/dsh-whale-pack/.test(hJob) && /dsh-whale-pack/.test(pkgJson.bin ? Object.keys(pkgJson.bin).join(',') : ''),
  '提示里提到的 bin 名与 package.json 的 bin 是同一个名字')

/* ── 真实拒绝里真的带这段提示（不是只有那个函数会说）── */
{
  const g1 = RJ.verifyEngineForScripts(TARGET, ['tools/build-lessons.js'])
  ok(g1.ok === false && /不一致/.test(String(g1.error)), '引擎闸真拒（不一致）')
  ok(hJob.length > 20 && String(g1.error).includes(hJob), 'rebuild-job 的拒绝文案里逐字带上了同一段提示')

  const g2 = AIO.verifyScriptsTrusted(TARGET, ['tools/build-lessons.js'])
  ok(g2.ok === false && /不一致/.test(String(g2.error)), 'ask-io 的引擎闸真拒（同一份判词）')
  ok(hAio.length > 20 && String(g2.error).includes(hAio), 'ask-io 的拒绝文案里逐字带上了同一段提示')

  const s = await PS.ensurePackServer(TARGET)
  ok(s.ok === false, 'pack-server 打不开这个包（引擎核验不过）')
  ok(hSrv.length > 20 && String(s.error).includes(hSrv), 'pack-server 的拒绝文案里逐字带上了同一段提示（它的第二处共用同一函数）')
  ok(!/node tools\//.test(String(s.error) + String(g1.error) + String(g2.error)),
    '三处拒绝文案里都没有那种相对路径了')
}

/* ══════════ ⑤ 提示里的 `--plan` 命令：真子进程、真退出码、真输出 ══════════ */
const PLAN_CMD = `node "${ENTRY}" --root="${TARGET}" --plan`
{
  const before = treeDigest(TARGET)
  const r = run(PLAN_CMD)   // cwd = ISO（没有仓库的地方）
  ok(r.code === 0, `提示里的 --plan 命令真跑起来了（exit ${r.code}）：${PLAN_CMD.slice(0, 60)}…`)
  const m = /^PLAN ok=true digest=([0-9a-f]{64}) files=(\d+)$/m.exec(r.out)
  ok(!!m, `--plan 的 stdout 契约对得上（PLAN ok=true digest=<hex> files=<n>）：${r.out.split('\n')[0]}`)
  ok(m && Number(m[2]) >= 1, `--plan 列出了要动的引擎件（files=${m ? m[2] : '?'}）`)
  eq(treeDigest(TARGET), before, '--plan **只算不写**：目标包引擎件字节摘要一个字都没变')
  globalThis.__planDigest = m ? m[1] : ''
}

/* ══════════ ⑥ 两步机制：少了 confirm / digest 对不上 ⇒ 非零且不动一个字节 ══════════ */
{
  const before = treeDigest(TARGET)
  const noConfirm = run(`node "${ENTRY}" --root="${TARGET}" --apply --plan-digest=${globalThis.__planDigest}`)
  ok(noConfirm.code === 1 && /--confirm/.test(noConfirm.all), `少了 --confirm ⇒ exit 1 且说清缺什么（exit ${noConfirm.code}）`)
  const badDigest = run(`node "${ENTRY}" --root="${TARGET}" --apply --confirm --plan-digest=${'f'.repeat(64)}`)
  ok(badDigest.code === 1, `digest 对不上 ⇒ exit 1（不是"尽力升一半"，exit ${badDigest.code}）`)
  eq(treeDigest(TARGET), before, '两种拒绝都没动目标包一个字节')
}

/* ══════════ ⑦ 显式 apply：真升级，升完引擎核验 ok ══════════ */
{
  const r = run(`node "${ENTRY}" --root="${TARGET}" --apply --confirm --plan-digest=${globalThis.__planDigest}`)
  ok(r.code === 0, `显式 apply 成功（exit ${r.code}）${r.code === 0 ? '' : '：' + r.all.slice(0, 400)}`)
  ok(/^APPLY ok=true digest=[0-9a-f]{64} replaced=\d+ added=\d+/m.test(r.out), `APPLY 的 stdout 契约对得上：${r.out.split('\n')[0]}`)
  const g = RJ.verifyEngineForScripts(TARGET, ['tools/build-lessons.js'])
  ok(g.ok === true, `升完引擎核验通过（verifyEngineForScripts ok=true）${g.ok ? '' : '：' + String(g.error).slice(0, 200)}`)
  const after = run(`node "${ENTRY}" --root="${TARGET}" --plan`)
  ok(after.code === 0 && /PLAN ok=true/.test(after.out) && /files=0/.test(after.out),
    `再算一次计划：已经一致（files=0）—— 第二次不该再动它`)
}

/* ══════════ ⑧ bin / --help：也是真子进程，指向同一个绝对入口 ══════════ */
{
  const r = run(`node "${ENTRY}" --help`)
  ok(r.code === 0, `--help 真跑得起来（exit ${r.code}）`)
  ok(r.out.includes(ENTRY), '--help 里打的入口也是绝对路径（装到哪都成立）')
  ok(r.out.includes('dsh-whale-pack'), '--help 里给出全局安装时的 bin 名')
  ok(r.out.includes('--apply --confirm --plan-digest='), '--help 里保住两步机制')
  ok(!/node tools\//.test(r.out), '--help 里同样不再出现仓根相对路径')
}

console.log(`\n隔离安装目录：${PKG_DIR}`)
console.log(`目标课程包：  ${TARGET}`)
console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ npm 装出来的包里，提示给的入口真能跑 · --plan 只读 · apply 两步 · 四点文案同源')
