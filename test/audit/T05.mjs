#!/usr/bin/env node
/**
 * T05.mjs —— 离线导入只收课程数据，运行 id 只认固定库（报告 D01 / P1）
 * ==================================================================
 * 验收判据（**原文**，见 cards/T05.md）：
 *   「nested/`../`/绝对 id 均 400且 spawn/rename 零调用；含上述脚本的 ZIP 拒绝导入；
 *     正常课件仍可浏览。」
 *
 * 怎么做才算「不是嘴上说」：
 *   - **真驱动生产入口**：把仓内模板整棵拷进临时副本（仓里 `package.json` 是 `type: module`，
 *     直接 require 那份 `.js` 会被当成 ESM —— 副本带一份 `{"type":"commonjs"}`），
 *     再 `require` 副本里的 `tools/offline-server.js`，调 `openPack/rebuild/removePack/importZip/
 *     planLegacyMigration/applyLegacyMigration`，并**真起 HTTP 服务**走 `handler`（含反向代理）。
 *   - **零调用不是靠返回值断言**：驱动进程用 `--import <spy.mjs>` 预加载记账探针，把
 *     `child_process.spawn/spawnSync` 与 `fs.renameSync/rename` 换成**只记账**的替身
 *     （spawn 绝不真起进程 —— 受限沙箱里 piped stdio 的 spawn 会被 EPERM 拒，靠"桩脚本有没有
 *     写标记"判不了，本仓既有纪律）。每条动作**单独** arm/disarm，回执里带该动作的调用清单。
 *     ⚠️ T05-M1：假子进程**代持**产品要用的那个端口（`tools/app-server.js` + 端口号时，
 *     在驱动进程里 `listen(127.0.0.1)` 并 destroy 连接）—— 因为 spawn 被换成假的了，
 *     光把桩文件改成真服务器**不会被执行**，`probe` 仍可能收到别的进程的 200。
 *     假子进程的 `kill()` 会把代持的端口关掉（与真桩进程退出一致）。
 *   - **负向控制**：先在自建临时副本上跑**基线实现**（`ba22c94` 的 `tools/offline-server.js`，
 *     其余模板不变），留下它**真的越库 spawn / 真的把 `lessons/**.js` 并进库 / 真的启动时自动
 *     合并旧包**的原始输出；再证明新实现对同一批输入**零调用**地拒绝、库树一个字节不变。
 *   - 固定用例 ID 集合写在下面 `EXPECTED_IDS` 里：缺一条、多一条、重一条都算失败。
 *
 * ⚠️ 覆盖边界（如实写出来，不冒充）：
 *   · 「受控解压」的**逐条校验**发生在 `tools/import-zip.ps1`（PowerShell/.NET ZipArchive）里 ——
 *     本卡的判据**直接驱动那个 helper**（它就是要随包发的那一件），并把它对每个条目的判决与
 *     JS 侧 `classifyImportEntry` **逐条对拍**（`T05-IMPORT-allowlist-parity`），防止两份口径漂。
 *   · 「处理 ≤30 秒」用 `-TimeoutSec 0` 证明**预算机制是活的**（生产默认值 30 由
 *     `T05-IMPORT-limits-are-production-constants` 静态钉住）—— 不假装跑满 30 秒。
 *   · 「非支持平台明确拒绝」只做**静态**证明（源码里那条 `ZIP_NOT_SUPPORTED` 硬失败 +
 *     没有 tar 回退）；本机是 Windows，没法在真机上跑别的平台。
 *   · 上传的课程 HTML 本身**可以**带内联脚本（那是课程内容）—— 「不执行上传的任何脚本」
 *     是本卡明确的 outOfScope，本文件不声称验证了它。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T05.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 运行 id 只认固定库（纯函数 / 驱动 / HTTP 400 / 零调用）
  'T05-ID-resolve-fixed-library',
  'T05-ID-reject-nested',
  'T05-ID-reject-dotdot',
  'T05-ID-reject-absolute',
  'T05-ID-reject-backslash',
  'T05-ID-reject-control-char',
  'T05-ID-reject-case-variant',
  'T05-ID-open-rejects-zero-spawn',
  'T05-ID-remove-rejects-zero-rename',
  'T05-ID-rebuild-rejects-zero-spawn',
  'T05-ID-http-open-400',
  'T05-ID-http-remove-400',
  'T05-ID-http-rebuild-400',
  'T05-ID-library-still-accepted',
  // ② 受控解压：只收课程数据（白名单 / 危险条目 / 上限）
  'T05-IMPORT-accept-normal',
  'T05-IMPORT-reject-tools-js',
  'T05-IMPORT-reject-lessons-js',
  'T05-IMPORT-reject-src-subtree',
  'T05-IMPORT-reject-traversal-entry',
  'T05-IMPORT-reject-absolute-entry',
  'T05-IMPORT-reject-backslash-entry',
  'T05-IMPORT-reject-symlink-entry',
  'T05-IMPORT-reject-duplicate-entry',
  'T05-IMPORT-reject-case-collision',
  'T05-IMPORT-reject-ads-entry',
  'T05-IMPORT-reject-device-name',
  'T05-IMPORT-reject-too-many-entries',
  'T05-IMPORT-reject-entry-too-big',
  'T05-IMPORT-reject-total-too-big',
  'T05-IMPORT-reject-ratio-bomb',
  'T05-IMPORT-reject-forged-actual-bytes',
  'T05-IMPORT-reject-timeout-budget',
  'T05-IMPORT-library-untouched-on-reject',
  'T05-IMPORT-allowlist-parity',
  'T05-IMPORT-no-tar-fallback',
  'T05-IMPORT-limits-are-production-constants',
  'T05-IMPORT-helper-source-integrity',
  // ③ 正常课件仍可浏览
  'T05-BROWSE-library-lists-lesson',
  'T05-BROWSE-starmap-page-200',
  'T05-BROWSE-lesson-page-200',
  'T05-BROWSE-library-tools-self-contained',
  // ④ 旧库迁移：显式（计划只读 / 摘要确定 / 启动不自动合并 / 三道门）
  'T05-MIG-plan-readonly',
  'T05-MIG-plan-deterministic-and-stale',
  'T05-MIG-no-auto-merge-on-startup',
  'T05-MIG-apply-requires-confirm',
  'T05-MIG-apply-requires-digest',
  'T05-MIG-apply-stale-plan-rejected',
  'T05-MIG-apply-migrates',
  'T05-MIG-http-plan-and-apply',
  // ⑤ 负向控制：基线真的被击穿；新实现零调用
  'T05-NEGCTRL-baseline-open-dotdot-spawns',
  'T05-NEGCTRL-baseline-open-nested-spawns',
  'T05-NEGCTRL-baseline-remove-dotdot-renames',
  'T05-NEGCTRL-baseline-imports-js-subtree',
  'T05-NEGCTRL-baseline-startup-auto-merges',
  'T05-NEGCTRL-old-vs-new-diff',
  // ⑥ 回归与夹具纪律
  'T05-REG-selftest-still-passes',
  'T05-REG-t03-t04-still-green',
  'T05-FIXTURE-cleanup-guard',
]

/** 基线 commit（cards/T05.md 钉的那一个）—— 负向控制取它的 `offline-server.js` */
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
const REL_SERVER = 'lib/pack-template/tools/offline-server.js'
const REL_HELPER = 'lib/pack-template/tools/import-zip.ps1'
const NODE = process.execPath
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
/** 生产上限（与 cards/T05.md 的「解压决定」逐条对应） */
const PROD_LIMITS = {
  maxUpload: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxFile: 32 * 1024 * 1024,
  maxTotal: 256 * 1024 * 1024,
  maxRatio: 100,
  timeoutSec: 30,
}
/** 冻结表里**真实存在**的圆圈色（`assets/circle-bands-data.js`）—— 用它重建链才会全绿 */
const HALO_COLOR = '#bfe0ff'
const LESSON_HTML = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>你好</title></head>\n'
  + '<body><h1>你好</h1><p>T05 夹具课程页。</p></body></html>\n'

/**
 * 白名单对拍样本：`import-zip.ps1`（PowerShell 侧）与 `classifyImportEntry`（JS 侧）必须**逐条同判**。
 * 覆盖：允许的形状 / 大小写 / 深度 / 保留段 / id 形状 / 点开头 / 危险条目（绝对、穿越、反斜杠、
 * 冒号、尾点、尾空格、设备名、空段、控制字符）。
 * ⚠️ **不含**重复与大小写碰撞（那是"同一批条目之间"的关系，不是单条名字能判的）——
 *    它们由 `T05-IMPORT-reject-duplicate-entry` / `-case-collision` 单独驱动生产入口。
 */
const PARITY_SAMPLES = [
  'pack.json',
  'lessons/lessons.json',
  'lessons/demo/halo.json',
  'lessons/demo/alpha/point.json',
  'lessons/demo/alpha/0001-hello.html',
  'lessons/programming/spring-boot/1001-x.html',
  './lessons/demo/alpha/0002-ok.html',
  'lessons/demo/alpha/0003-upper.HTML',
  'lessons/demo/alpha/0001-hello.js',
  'lessons/demo/alpha/evil.exe',
  'lessons/demo/alpha/sub/x.html',
  'lessons/demo/alpha/halo.json',
  'lessons/demo/point.json',
  'lessons/src/demo/halo.json',
  'lessons/tools/demo/point.json',
  'lessons/Upper/halo.json',
  'lessons/demo-/halo.json',
  'lessons/1demo/halo.json',
  'lessons/demo/alpha/.hidden.html',
  'lessons/demo/alpha/x.html.bak',
  'lessons/demo/alpha/x.htm',
  'tools/evil.js',
  'assets/x.js',
  'pack.json/evil.js',
  '/abs.js',
  'C:/evil.js',
  'lessons/../../evil.js',
  'lessons/demo/../demo/halo.json',
  'lessons\\demo\\halo.json',
  'pack.json:evil',
  'lessons/demo./halo.json',
  'lessons/demo/CON.json',
  'lessons/demo/alpha/x.html ',
  'lessons//demo/halo.json',
]

const h = createHarness({ card: 'T05', expectedIds: EXPECTED_IDS, root: REPO })
const CASE_DIR = path.join(REPO, 'audit-evidence', 'T05', 'cases')
fs.mkdirSync(CASE_DIR, { recursive: true })
const SANDBOX = makeTempDir('t05')
const W = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8') }
const WJ = (file, obj) => W(file, `${JSON.stringify(obj, null, 2)}\n`)
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const both = (r) => String(r?.out ?? '') + String(r?.err ?? '')
const rnd = (n = 8) => crypto.randomBytes(n).toString('hex')

/** 整棵树快照（内容 + 存在性）—— 比"返回值"硬 */
function snapTree(root, { skip = null } = {}) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      if (skip && skip.test(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { out.push(`${r}|dir`); walk(abs, r) } else {
        let digest = 'unreadable'
        try { digest = sha(fs.readFileSync(abs)).slice(0, 16) } catch { /* 读不动如实标 */ }
        out.push(`${r}|file|${digest}`)
      }
    }
  }
  walk(root, '')
  return out.join('\n')
}

/** 落一份子进程的**完整原始输出** */
function keepEvidence(id, r, extra = {}) {
  const text = [
    `# ${id}`,
    `exit=${r && r.code === null ? 'null(无退出码/崩溃)' : (r ? r.code : 'n/a')} timedOut=${r ? r.timedOut : 'n/a'} ms=${r ? r.ms : 'n/a'}`,
    `spawnError=${(r && r.spawnError) || 'none'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    '--- stdout ---',
    String(r?.out ?? ''),
    '--- stderr ---',
    String(r?.err ?? ''),
    '',
  ].join('\n')
  h.evidence(path.join('cases', `${id}.txt`), clip(text, 60000))
}

// ================================================================ 最小 ZIP 写入器
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
/**
 * 造一个 zip（store / deflate 都支持；`mode` 写进 ExternalAttributes —— 用来伪造**符号链接**；
 * `declaredLen` 用来伪造"声明的大小"）。条目名原样写进 zip —— 危险条目就是这么造出来的。
 */
function makeZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8')
    const mode = e.mode === undefined ? 0x81a4 : e.mode           // 0o100644
    const ext = ((mode & 0xffff) << 16) >>> 0
    const store = e.store === true
    const comp = store ? data : zlib.deflateRawSync(data)
    const crc = crc32(data)
    const nameBuf = Buffer.from(e.name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x2821, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(e.declaredLen === undefined ? data.length : e.declaredLen, 22)
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10)
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x2821, 14)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(e.declaredLen === undefined ? data.length : e.declaredLen, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36); ch.writeUInt32LE(ext, 38); ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, end])
}

/** 正常课件包的条目（5 个数据件 ＋ 目录条目；`extra` 用来塞"不该有的东西"） */
function goodEntries(extra = []) {
  return [
    { name: './', mode: 0x41ed, data: Buffer.alloc(0) },
    { name: './pack.json', data: `${JSON.stringify({ v: 1, id: 'demo/alpha', name: '演示', circle: 'demo', point: 'alpha', lesson: { number: 1, slug: 'hello', title: '你好' } }, null, 2)}\n` },
    { name: './lessons/', mode: 0x41ed, data: Buffer.alloc(0) },
    { name: './lessons/lessons.json', data: `${JSON.stringify({ v: 1, source: 'lessons/src', lessons: [{ rel: 'demo/alpha/0001-hello.html', title: '你好', number: 1, halo: 'demo', point: 'alpha', slug: 'hello' }] }, null, 2)}\n` },
    { name: './lessons/demo/', mode: 0x41ed, data: Buffer.alloc(0) },
    { name: './lessons/demo/halo.json', data: `${JSON.stringify({ halo: 'demo', name: '演示圈', color: HALO_COLOR }, null, 2)}\n` },
    { name: './lessons/demo/alpha/', mode: 0x41ed, data: Buffer.alloc(0) },
    { name: './lessons/demo/alpha/point.json', data: `${JSON.stringify({ point: 'alpha', name: '演示点', fileBase: 0 }, null, 2)}\n` },
    { name: './lessons/demo/alpha/0001-hello.html', data: LESSON_HTML },
    ...extra,
  ]
}
const ZIP_DIR = path.join(SANDBOX, 'zips')
let zipSeq = 0
function zipFile(tag, entries) {
  const p = path.join(ZIP_DIR, `${String(++zipSeq).padStart(2, '0')}-${tag}.zip`)
  fs.mkdirSync(ZIP_DIR, { recursive: true })
  fs.writeFileSync(p, makeZip(entries))
  return p
}

// ================================================================ 模板副本（新 / 基线）
const TMPL_NEW = path.join(SANDBOX, 'tmpl-new')
const TMPL_BASE = path.join(SANDBOX, 'tmpl-base')
function layTemplateCopy(dest) {
  fs.cpSync(path.join(REPO, 'lib', 'pack-template'), dest, { recursive: true })
  // 仓里 package.json 是 `"type": "module"`；副本必须是 CJS，否则 require 那份 .js 会被当成 ESM
  W(path.join(dest, 'package.json'), '{"type":"commonjs"}\n')
  return dest
}

// ================================================================ 驱动与探针（现场生成）
const DRIVER_DIR = path.join(SANDBOX, 'driver')
const SPY_FILE = path.join(DRIVER_DIR, 'spy.mjs')
const DRIVER_FILE = path.join(DRIVER_DIR, 'driver.cjs')

/**
 * **零调用探针**（`--import` 预加载）：把 `child_process.spawn/spawnSync` 换成**只记账**的替身
 * （绝不真起进程 —— 受限沙箱里 piped stdio 的 spawn 会被 EPERM 拒），把 `fs.renameSync/rename`
 * 换成"记账后照原样执行"的替身（rename 真要能观察到，所以不能吞掉它）。
 * 每条动作单独 arm/disarm，回执里带该动作的调用清单。
 */
const SPY_SRC = `import Module from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import { EventEmitter } from 'node:events'

const calls = []
let armed = false
const push = (o) => { if (armed) calls.push(o) }

// —— 负向控制的端口确定性（T05-M1）——
// spawn 仍是"只记账、不起进程"的替身 ⇒ 桩脚本不会被真正执行；而基线 openPack 会在 spawn
// 之后用 probe(port) 轮询**同一个**端口 6 秒。只要那个端口被别的进程答了 200，负向控制就假红
// （端口在 0.0.0.0 / :: 上被监听时，基线只试 127.0.0.1 的 portFree 会误判为空闲）。
// 所以假子进程**代持**产品要用的端口：本进程 listen(127.0.0.1, port) 并 destroy 连接，
// kill() 时关掉。绑定失败不吭声 —— 让 probe 照实看见现实，不冒充。
const holders = new Map()
function holdPort(port) {
  if (!Number.isInteger(port) || port <= 0 || holders.has(port)) return
  const srv = net.createServer((sock) => sock.destroy())
  srv.on('error', () => { /* 抢不到：如实让 probe 看见真实情况 */ })
  srv.listen(port, '127.0.0.1')
  holders.set(port, srv)
}
function releasePort(port) {
  const srv = holders.get(port)
  if (!srv) return
  holders.delete(port)
  try { srv.close() } catch { /* 已关 */ }
}

const origRenameSync = fs.renameSync
fs.renameSync = function (from, to) {
  push({ kind: 'renameSync', from: String(from), to: String(to) })
  return origRenameSync.apply(fs, arguments)
}
const origRename = fs.rename
fs.rename = function (from, to, cb) {
  push({ kind: 'rename', from: String(from), to: String(to) })
  return origRename.apply(fs, arguments)
}

const patched = new WeakSet()
function wrap(cp) {
  if (!cp || patched.has(cp)) return cp
  patched.add(cp)
  cp.spawn = (cmd, args, opts) => {
    const argv = (args || []).map(String)
    push({ kind: 'spawn', cmd: String(cmd), args: argv })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 0
    child.exitCode = null
    // 越库 id 的落点就是带 tools/app-server.js 的目录（../esc-open、a/b、/abs 同一个桩）
    const heldPort = /tools[\\\\/]app-server\\.js$/.test(String(argv[0] || '')) ? Number(argv[1]) : null
    if (heldPort !== null) holdPort(heldPort)
    child.kill = () => {
      if (heldPort !== null) releasePort(heldPort)
    }
    process.nextTick(() => { child.emit('exit', 0, null); child.emit('close', 0) })
    return child
  }
  cp.spawnSync = (cmd, args, opts) => {
    push({ kind: 'spawnSync', cmd: String(cmd), args: (args || []).map(String) })
    return { pid: 0, status: 0, signal: null, stdout: '', stderr: '', output: [null, '', ''], error: null }
  }
  return cp
}

// ⚠️ 必须拦在 Module._load：offline-server.js 在模块求值时就把 spawn/spawnSync 绑走了
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const out = origLoad.apply(this, arguments)
  if (request === 'child_process' || request === 'node:child_process') return wrap(out)
  return out
}
wrap(origLoad.call(Module, 'child_process', null, false))

globalThis.__T05__ = {
  arm() { calls.length = 0; armed = true; return true },
  disarm() { armed = false; return true },
  summary() {
    const spawnCount = calls.filter((c) => c.kind === 'spawn' || c.kind === 'spawnSync').length
    const renameCount = calls.filter((c) => c.kind === 'renameSync' || c.kind === 'rename').length
    return { total: calls.length, spawnCount, renameCount, calls: calls.slice(0, 20) }
  },
}
`

/** 驱动：`--tmpl=<模板副本> --lib=<课程库根> --plan=<动作清单 JSON>` */
const DRIVER_SRC = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const http = require('http')

const argv = process.argv.slice(2)
const flag = (n) => { const p = '--' + n + '='; const hit = argv.find((a) => a.startsWith(p)); return hit === undefined ? null : hit.slice(p.length) }
const tmpl = flag('tmpl')
const lib = flag('lib')
const planFile = flag('plan')
process.env.WHALE_LIB = lib

const OS = require(path.join(tmpl, 'tools', 'offline-server.js'))
const probe = globalThis.__T05__ || null

const KEEP = ['ok', 'code', 'error', 'id', 'source', 'files', 'added', 'lessons', 'lessonCount', 'circles', 'points',
  'exists', 'running', 'rebuilt', 'rebuildError', 'lesson', 'count', 'digest', 'migrated', 'note', 'moved', 'started',
  'url', 'port', 'libraryExists', 'library', 'plan', 'steps', 'status', 'json', 'text', 'omitted', 'kind', 'limits',
  'support', 'libraryDir', 'name', 'rel', 'title', 'number', 'circle', 'point', 'slug']
function trim(res) {
  if (res === null || res === undefined) return res
  if (Array.isArray(res)) return res.map(trim)
  if (typeof res !== 'object') return res
  const out = {}
  for (const k of KEEP) {
    if (!(k in res)) continue
    const v = res[k]
    if (k === 'steps') { out.steps = Array.isArray(v) ? v.map((s) => ({ script: s && s.script, code: s && s.code })) : v; continue }
    if (k === 'plan') { out.plan = Array.isArray(v) ? v.map((p) => ({ id: p && p.id, lessons: p && p.lessons, bytes: p && p.bytes })) : v; continue }
    out[k] = (typeof v === 'string' && v.length > 400) ? v.slice(0, 400) + '…' : v
  }
  return out
}

function httpOnce(method, urlPath, body) {
  return new Promise((resolve) => {
    const srv = http.createServer(OS.handler)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout: 30000, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          let json = null
          try { json = JSON.parse(text) } catch { /* 不是 JSON 就原样带文本 */ }
          try { OS.closePackServers() } catch { /* 忽略 */ }
          srv.close(() => resolve({ status: res.statusCode, json: trim(json), text: json ? null : text.slice(0, 400) }))
        })
      })
      req.on('error', (e) => { try { OS.closePackServers() } catch { } srv.close(() => resolve({ status: 0, error: String(e && e.message ? e.message : e) })) })
      req.on('timeout', () => { req.destroy(); try { OS.closePackServers() } catch { } srv.close(() => resolve({ status: 0, error: 'timeout' })) })
      if (body) req.write(body)
      req.end()
    })
  })
}

const ACTIONS = JSON.parse(fs.readFileSync(planFile, 'utf8'))

async function run(action) {
  if (probe) probe.arm()
  let result
  try {
    if (action.kind === 'resolve') result = action.ids.map((x) => OS.resolveRunId(x))
    else if (action.kind === 'classify') result = action.names.map((x) => OS.classifyImportEntry(x))
    else if (action.kind === 'limits') result = { limits: OS.IMPORT_LIMITS, support: OS.importHelperSupport(), libraryDir: OS.LIBRARY_DIR, lib: OS.LIB }
    else if (action.kind === 'open') result = await OS.openPack(action.id)
    else if (action.kind === 'remove') result = await OS.removePack(action.id)
    else if (action.kind === 'rebuild') result = OS.rebuild(action.id)
    else if (action.kind === 'import') result = OS.importZip(fs.readFileSync(action.zip), action.name || path.basename(action.zip))
    else if (action.kind === 'plan') result = OS.planLegacyMigration()
    else if (action.kind === 'apply') result = OS.applyLegacyMigration(action.body || {})
    else if (action.kind === 'libraryInfo') result = OS.libraryInfo()
    else if (action.kind === 'http') result = await httpOnce(action.method || 'GET', action.path, action.body || null)
    else throw new Error('unknown action kind: ' + action.kind)
  } finally {
    if (probe) probe.disarm()
  }
  return { action: action.kind + ':' + (action.id !== undefined ? String(action.id) : (action.path ? String(action.path) : (action.zip ? path.basename(action.zip) : ''))), result: trim(result), probe: probe ? probe.summary() : null }
}

;(async () => {
  const results = []
  for (const a of ACTIONS) {
    try { results.push(await run(a)) } catch (e) {
      results.push({ action: a.kind + ':' + (a.id !== undefined ? String(a.id) : ''), error: String(e && e.message ? e.message : e) })
    }
  }
  try { OS.closePackServers() } catch { /* 忽略 */ }
  process.stdout.write('<<<R>>>' + JSON.stringify({ lib, tmpl, results }) + '\\n')
  process.exit(0)
})().catch((e) => {
  process.stdout.write('<<<E>>>' + JSON.stringify({ error: String(e && e.stack ? e.stack : e) }) + '\\n')
  process.exit(3)
})
`

// ================================================================ 夹具
const LIB_INPROC = path.join(SANDBOX, 'lib-inproc')     // 只读纯函数用（绝不写）
const LIB_ID = path.join(SANDBOX, 'lib-id')             // 越库 id 的落点
const LIB_REJECT = path.join(SANDBOX, 'lib-reject')     // 拒绝导入（库必须一个字节都不出现）
const LIB_GOOD = path.join(SANDBOX, 'lib-good')         // 正常导入 + 浏览
const LIB_MIG_PLAN = path.join(SANDBOX, 'lib-mig-plan') // 迁移计划（只读 + 摘要）
const LIB_MIG_APPLY = path.join(SANDBOX, 'lib-mig-apply') // 三道门 + 真迁移
const LIB_MIG_HTTP = path.join(SANDBOX, 'lib-mig-http')   // HTTP 计划 + 确认迁移
const LIB_START_NEW = path.join(SANDBOX, 'lib-start-new')
const LIB_START_BASE = path.join(SANDBOX, 'lib-start-base')
const LIB_NEG = path.join(SANDBOX, 'lib-neg')           // 基线导入负向控制

/** 造一个"老版本每包一个目录"的旧课程包（`packs/<id>/lessons/…`） */
function layLegacyPack(libRoot, id) {
  const dir = path.join(libRoot, id)
  WJ(path.join(dir, 'lessons', 'lessons.json'), {
    v: 1,
    source: 'lessons/src',
    lessons: [{ rel: `${id}/alpha/0001-x.html`, title: `旧课 ${id}`, number: 1, halo: id, point: 'alpha', slug: 'x' }],
  })
  WJ(path.join(dir, 'lessons', id, 'halo.json'), { halo: id, name: `旧圈 ${id}`, color: HALO_COLOR })
  WJ(path.join(dir, 'lessons', id, 'alpha', 'point.json'), { point: 'alpha', name: '旧点', fileBase: 0 })
  W(path.join(dir, 'lessons', id, 'alpha', '0001-x.html'), `<!doctype html><html lang="zh-CN"><body>旧课 ${id}</body></html>\n`)
  return dir
}

/**
 * 给"越库 id"造落点：基线的 `path.join(LIB, id)` 必须真的指到一个带 tools/app-server.js 的目录。
 *
 * ⚠️ T05-M1：这个 app-server 桩**真的占住端口、但永不回 HTTP**（旧版是
 * `setTimeout(() => {}, 60000)`，什么都不占）。基线 openPack 会 freePort() 选 3092–3141 里
 * 一个"自认为空闲"的端口，spawn 这个桩，再 probe(port) 轮询 6 秒。只要桩占住那个端口，
 * probe 就不可能从**别的**进程拿到 200（本机实测：127.0.0.1 的具体绑定会压过
 * 0.0.0.0 / :: 上的通配监听，连接一律被 destroy）。端口绑定失败就立刻非零退出。
 * 三个越库落点（../esc-open、a/b、/abs）用**同一个**桩；remove 用的落点不需要。
 */
function layEscapeTargets() {
  const stub = [
    '#!/usr/bin/env node',
    "const net = require('node:net')",
    'const port = Number(process.argv[2])',
    'if (!Number.isInteger(port) || port <= 0) process.exit(2)',
    "const srv = net.createServer((sock) => sock.destroy())",
    'srv.once(\'error\', () => process.exit(3))',
    "srv.listen(port, '127.0.0.1')",
    '',
  ].join('\n')
  // `../esc-open` → LIB/../esc-open
  W(path.join(LIB_ID, '..', 'esc-open', 'tools', 'app-server.js'), stub)
  // `a/b` → LIB/a/b
  W(path.join(LIB_ID, 'a', 'b', 'tools', 'app-server.js'), stub)
  // `/abs` → path.join(LIB, '/abs') = LIB/abs（Windows 上 path.join 不吃绝对段的根）
  W(path.join(LIB_ID, 'abs', 'tools', 'app-server.js'), stub)
  // remove 用（不需要 app-server）—— **新实现**与**基线**各一套：基线那套真的会被搬走，
  // 而"新实现拒绝后落点还在原处"那条判据不能受基线影响（两者的夹具必须互不踩）
  W(path.join(LIB_ID, '..', 'esc-rm', 'lessons', 'keep.txt'), 'x')
  W(path.join(LIB_ID, 'a', 'brm', 'lessons', 'keep.txt'), 'x')
  W(path.join(LIB_ID, 'absrm', 'lessons', 'keep.txt'), 'x')
  W(path.join(LIB_ID, '..', 'esc-rm-base', 'lessons', 'keep.txt'), 'x')
  return LIB_ID
}

/** 跑一次驱动（可选带探针），拿回执 */
function runDriver(tag, tmplDir, libDir, actions, { spy = false, timeoutMs = 300000 } = {}) {
  const planFile = path.join(DRIVER_DIR, `plan-${tag}.json`)
  W(planFile, `${JSON.stringify(actions, null, 2)}\n`)
  const argv = [NODE]
  if (spy) argv.push('--import', pathToFileURL(SPY_FILE).href)
  argv.push(DRIVER_FILE, `--tmpl=${tmplDir}`, `--lib=${libDir}`, `--plan=${planFile}`)
  const r = runChild(argv, { cwd: SANDBOX, timeoutMs })
  let rec = null
  const m = /<<<R>>>(\{[\s\S]*\})/.exec(both(r))
  if (m) { try { rec = JSON.parse(m[1]) } catch { rec = null } }
  const err = /<<<E>>>(\{[\s\S]*\})/.exec(both(r))
  return { r, rec, driverError: err ? err[1] : null }
}

/** 直接驱动受信 helper（与 `importZip` 里那条命令行同一套参数） */
function runHelper(zipBuf, extraArgs = []) {
  const tag = rnd(6)
  const zip = path.join(SANDBOX, 'helper', `${tag}.zip`)
  const staging = path.join(SANDBOX, 'helper', `${tag}-staging`)
  const result = path.join(SANDBOX, 'helper', `${tag}-result.json`)
  fs.mkdirSync(path.dirname(zip), { recursive: true })
  fs.writeFileSync(zip, zipBuf)
  const r = runChild([PS_EXE, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(REPO, REL_HELPER), '-Zip', zip, '-Staging', staging, '-Result', result, ...extraArgs],
  { cwd: REPO, timeoutMs: 300000 })
  let receipt = null
  try { receipt = JSON.parse(fs.readFileSync(result, 'utf8')) } catch { receipt = null }
  const written = []
  const walk = (d, rel = '') => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) { const r2 = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r2); else written.push(r2) }
  }
  walk(staging)
  return { r, receipt, written, zip, staging, result }
}

/** 起一次真服务（`require.main` 那条启动路径），等它答话再收走 —— 看启动期到底动没动盘 */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(0))
    s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)) })
    s.listen(0, '127.0.0.1')
  })
}
function waitHttp(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', () => { if (Date.now() - started > timeoutMs) return resolve(0); setTimeout(tick, 200) })
      req.on('timeout', () => req.destroy())
    }
    tick()
  })
}
async function runStartup(tag, tmplDir, libDir) {
  const port = await freePort()
  const logFile = path.join(SANDBOX, 'startup', `${tag}.log`)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(NODE, [path.join(tmplDir, 'tools', 'offline-server.js'), `--lib=${libDir}`, String(port)], {
    stdio: ['ignore', fd, fd], windowsHide: true, detached: false,
  })
  const status = await waitHttp(port, '/api/health', 25000)
  try { child.kill() } catch { /* 已经死了 */ }
  await new Promise((resolve) => { const t = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(t); resolve() }) })
  try { fs.closeSync(fd) } catch { /* 忽略 */ }
  const log = (() => { try { return fs.readFileSync(logFile, 'utf8') } catch { return '' } })()
  return { port, status, log, logFile }
}

// ================================================================ 现场准备（先建副本与夹具）
let FIX = null
try {
  layTemplateCopy(TMPL_NEW)
  layTemplateCopy(TMPL_BASE)
  const baseServer = runChild(['git', '-C', REPO, 'show', `${BASE_COMMIT}:${REL_SERVER}`], { cwd: REPO, timeoutMs: 60000 })
  if (baseServer.code !== 0 || !String(baseServer.out).trim()) {
    throw new Error(`git show ${BASE_COMMIT}:${REL_SERVER} 失败（exit=${baseServer.code}）：${clip(both(baseServer), 300)}`)
  }
  W(path.join(TMPL_BASE, 'tools', 'offline-server.js'), baseServer.out)
  const sameAsNew = fs.readFileSync(path.join(TMPL_BASE, 'tools', 'offline-server.js'), 'utf8')
    === fs.readFileSync(path.join(TMPL_NEW, 'tools', 'offline-server.js'), 'utf8')
  if (sameAsNew) throw new Error('基线副本与当前实现逐字节相同（负向控制会打空）')
  W(SPY_FILE, SPY_SRC)
  W(DRIVER_FILE, DRIVER_SRC)
  layEscapeTargets()
  layLegacyPack(LIB_MIG_PLAN, 'olda')
  layLegacyPack(LIB_MIG_PLAN, 'oldb')
  layLegacyPack(LIB_MIG_APPLY, 'olda')
  layLegacyPack(LIB_MIG_APPLY, 'oldb')
  layLegacyPack(LIB_MIG_HTTP, 'olda')
  layLegacyPack(LIB_START_NEW, 'olda')
  layLegacyPack(LIB_START_BASE, 'olda')
  FIX = { ok: true, baseCommit: BASE_COMMIT }
} catch (e) {
  FIX = { ok: false, error: `${e && e.message ? e.message : e}` }
}
if (!FIX.ok) h.block(`夹具/基线副本建不起来：${FIX.error}`)
const need = () => { if (!FIX.ok) throw new Error(`夹具没就绪：${FIX.error}`) }

const hasPs = fs.existsSync(PS_EXE) && fs.existsSync(path.join(REPO, REL_HELPER))
if (!hasPs) h.block(`受信解压 helper / PowerShell 不在（${PS_EXE}）—— 受控解压判不了`)

// ================================================================ 跑驱动（一次跑一批动作）
const RUN = {}
try {
  need()
  // ① 纯函数 + 上限常量（只读，不碰库）
  RUN.pure = runDriver('pure', TMPL_NEW, LIB_INPROC, [
    { kind: 'resolve', ids: [undefined, '', 'library', 'a/b', '../x', '/abs', 'C:/x', 'a\\b', 'Library', 'library/x', '..', 'x\u0000y'] },
    { kind: 'limits' },
    { kind: 'classify', names: ['pack.json', 'lessons/lessons.json', 'lessons/demo/halo.json', 'tools/x.js'] },
  ])
  // ② 非法 id：三个入口 + HTTP 三条路由（探针记账；每条动作单独 arm/disarm）
  RUN.ids = runDriver('ids', TMPL_NEW, LIB_ID, [
    { kind: 'open', id: 'a/b' },
    { kind: 'open', id: '../esc-open' },
    { kind: 'open', id: '/abs' },
    { kind: 'rebuild', id: '../esc-open' },
    { kind: 'remove', id: 'a/brm' },
    { kind: 'remove', id: '../esc-rm' },
    { kind: 'remove', id: '/absrm' },
    { kind: 'http', method: 'POST', path: '/api/open?id=' + encodeURIComponent('../esc-open') },
    { kind: 'http', method: 'POST', path: '/api/remove?id=' + encodeURIComponent('a/brm') },
    { kind: 'http', method: 'POST', path: '/api/rebuild?id=' + encodeURIComponent('/abs') },
    { kind: 'open', id: 'library' },
  ], { spy: true })
  // ③ 正常课件：真导入（真起 helper）→ 真浏览（真起包服务 + 反向代理）
  RUN.importGood = runDriver('import-good', TMPL_NEW, LIB_GOOD, [
    { kind: 'import', zip: zipFile('good', goodEntries()), name: 'good.zip' },
  ])
  RUN.browse = runDriver('browse', TMPL_NEW, LIB_GOOD, [
    { kind: 'libraryInfo' },
    { kind: 'http', method: 'GET', path: '/library/starmap/' },
    { kind: 'http', method: 'GET', path: '/library/lessons/demo/alpha/0001-hello.html' },
  ])
  // ④ 拒绝面：每一条一个 zip，走生产入口 importZip
  const rejects = {
    toolsJs: goodEntries([{ name: './tools/evil.js', data: 'module.exports = 1\n' }]),
    lessonsJs: goodEntries([{ name: './lessons/demo/alpha/evil.js', data: 'alert(1)\n' }]),
    srcSubtree: goodEntries([{ name: './lessons/src/demo/alpha/0001-hello.html', data: '<html>src</html>' }]),
    traversal: goodEntries([{ name: './lessons/../../evil.js', data: 'x' }]),
    absolute: goodEntries([{ name: '/abs-evil.js', data: 'x' }]),
    backslash: goodEntries([{ name: './lessons\\demo\\evil.js', data: 'x' }]),
    symlink: goodEntries([{ name: './lessons/demo/alpha/link.js', data: '/etc/passwd', mode: 0xa1ff }]),
    duplicate: goodEntries([{ name: './pack.json', data: '{"v":1,"id":"x/y"}' }]),
    caseCollision: goodEntries([{ name: './PACK.json', data: '{"v":1,"id":"x/y"}' }]),
    ads: goodEntries([{ name: './pack.json:evil', data: 'x' }]),
    device: goodEntries([{ name: './lessons/demo/CON.json', data: 'x' }]),
    ratioBomb: goodEntries([{ name: './lessons/demo/alpha/0002-bomb.html', data: Buffer.alloc(5 * 1024 * 1024) }]),
    entryTooBig: goodEntries([{ name: './lessons/demo/alpha/0003-big.html', data: Buffer.alloc(33 * 1024 * 1024) }]),
    forgedActual: goodEntries([{ name: './lessons/demo/alpha/0004-forged.html', data: Buffer.alloc(40 * 1024 * 1024), declaredLen: 1024 }]),
  }
  // 总量超限：9 × 声明 30 MiB（每个都 ≤32 MiB）＝ 270 MiB > 256 MiB；
  // ⚠️ 用 store ＋ 1 MiB 随机字节，让**膨胀比 ~30**（低于 100）—— 否则会先撞 RATIO，测不到总量那条
  const totalEntries = goodEntries()
  for (let i = 0; i < 9; i++) {
    totalEntries.push({ name: `./lessons/demo/alpha/1${String(i).padStart(3, '0')}-tot.html`, data: crypto.randomBytes(1024 * 1024), declaredLen: 30 * 1024 * 1024, store: true })
  }
  rejects.totalTooBig = totalEntries
  // 条目数超限：4097 个（预算 4096）
  const manyEntries = goodEntries()
  for (let i = 0; i < 4092; i++) manyEntries.push({ name: `./lessons/demo/alpha/2${String(i).padStart(4, '0')}-n.html`, data: 'x' })
  rejects.tooMany = manyEntries

  const rejectPlan = []
  const rejectZip = {}
  for (const [k, entries] of Object.entries(rejects)) {
    rejectZip[k] = zipFile(`rej-${k}`, entries)
    rejectPlan.push({ kind: 'import', zip: rejectZip[k], name: `${k}.zip` })
  }
  RUN.rejects = runDriver('rejects', TMPL_NEW, LIB_REJECT, rejectPlan, { timeoutMs: 600000 })
  // ⑤ helper 直接驱动：白名单逐条对拍 + 超时预算
  RUN.parity = runHelper(makeZip(PARITY_SAMPLES.map((n) => ({ name: n, data: 'x' }))))
  RUN.timeout = runHelper(makeZip(goodEntries()), ['-TimeoutSec', '0'])
  // ⑥ 迁移：计划（只读 / 摘要）→ 三道门 → 真迁移 → HTTP
  RUN.migPlan = runDriver('mig-plan', TMPL_NEW, LIB_MIG_PLAN, [
    { kind: 'plan' }, { kind: 'plan' },
  ])
  RUN.migApply = runDriver('mig-apply', TMPL_NEW, LIB_MIG_APPLY, [
    { kind: 'apply', body: {} },
    { kind: 'apply', body: { confirm: true } },
  ])
  RUN.migHttp = runDriver('mig-http', TMPL_NEW, LIB_MIG_HTTP, [
    { kind: 'http', method: 'GET', path: '/api/migration' },
    { kind: 'http', method: 'POST', path: '/api/migrate', body: JSON.stringify({}) },
  ])
  // ⑦ 负向控制：基线（`ba22c94` 的 offline-server.js）
  RUN.baseIds = runDriver('base-ids', TMPL_BASE, LIB_ID, [
    { kind: 'open', id: '../esc-open' },
    { kind: 'open', id: 'a/b' },
    { kind: 'remove', id: '../esc-rm-base' },
  ], { spy: true })
  RUN.baseImport = runDriver('base-import', TMPL_BASE, LIB_NEG, [
    { kind: 'import', zip: zipFile('neg-js', goodEntries([{ name: './lessons/demo/alpha/evil.js', data: 'alert(1)\n' }])), name: 'neg.zip' },
  ], { timeoutMs: 600000 })
  RUN.newImportSame = runDriver('new-import-same', TMPL_NEW, path.join(SANDBOX, 'lib-neg-new'), [
    { kind: 'import', zip: zipFile('neg-js-2', goodEntries([{ name: './lessons/demo/alpha/evil.js', data: 'alert(1)\n' }])), name: 'neg.zip' },
  ], { timeoutMs: 600000 })
  RUN.startNew = await runStartup('new', TMPL_NEW, LIB_START_NEW)
  RUN.startBase = await runStartup('base', TMPL_BASE, LIB_START_BASE)
} catch (e) {
  RUN.error = `${e && e.message ? e.message : e}`
}

/** 从驱动回执里按动作下标取一条 */
function actionOf(run, idx) {
  if (!run || !run.rec || !Array.isArray(run.rec.results)) return null
  return run.rec.results[idx] || null
}
const act = (run, idx) => {
  const a = actionOf(run, idx)
  if (!a) throw new Error(`驱动回执里没有第 ${idx} 条动作（run=${run ? clip(both(run.r), 300) : 'n/a'}）`)
  if (a.error) throw new Error(`第 ${idx} 条动作抛异常：${a.error}`)
  return a
}
const actRes = (run, idx) => act(run, idx).result
const actProbe = (run, idx) => (act(run, idx).probe || { spawnCount: -1, renameCount: -1, calls: [] })
/** 按动作标签取一条（拒绝面那批用 `import:<…>-rej-<tag>.zip` 定位，免得靠下标数数） */
const byLabel = (run, label) => {
  const list = (run && run.rec && Array.isArray(run.rec.results)) ? run.rec.results : []
  const hit = list.find((x) => x.action === label)
  if (!hit) throw new Error(`驱动回执里没有动作 ${label}（${run ? clip(both(run.r), 300) : 'n/a'}）`)
  if (hit.error) throw new Error(`动作 ${label} 抛异常：${hit.error}`)
  return hit
}
const rejectOf = (tag) => {
  const list = (RUN.rejects && RUN.rejects.rec && Array.isArray(RUN.rejects.rec.results)) ? RUN.rejects.rec.results : []
  const hit = list.find((x) => x.action === `import:${tag}.zip` || x.action.endsWith(`-rej-${tag}.zip`))
  if (!hit) throw new Error(`驱动回执里没有 rej-${tag}（${RUN.rejects ? clip(both(RUN.rejects.r), 300) : 'n/a'}）`)
  if (hit.error) throw new Error(`rej-${tag} 抛异常：${hit.error}`)
  return hit
}

// ================================================================ ① 运行 id 只认固定库
h.case('T05-ID-resolve-fixed-library', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.evidence(path.join('cases', 'T05-ID-resolve.txt'), `${JSON.stringify(r, null, 2)}\n`)
  h.eq(r[0].ok, true, '省略 id ⇒ 既有默认仍是 library')
  h.eq(r[0].id, 'library', '省略 id 解成 library')
  h.eq(r[1].ok, true, "空串 id ⇒ 也算省略（老行为：`|| LIBRARY_DIR`）")
  h.eq(r[2].ok, true, '显式 library 接受')
  h.eq(r[2].id, 'library', '显式 library 解成 library')
})

h.case('T05-ID-reject-nested', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.eq(r[3].ok, false, '`a/b`（nested）必须拒')
  h.eq(r[3].code, 'ID_NOT_ALLOWED', 'nested 的 code')
  h.eq(r[9].ok, false, '`library/x` 也拒（不是"以 library 开头"就算）')
})

h.case('T05-ID-reject-dotdot', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.eq(r[4].ok, false, '`../x` 必须拒')
  h.eq(r[4].code, 'ID_NOT_ALLOWED', 'dotdot 的 code')
  h.eq(r[10].ok, false, '`..` 必须拒')
})

h.case('T05-ID-reject-absolute', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.eq(r[5].ok, false, '`/abs`（POSIX 绝对）必须拒')
  h.eq(r[5].code, 'ID_NOT_ALLOWED', '绝对路径的 code')
  h.eq(r[6].ok, false, '`C:/x`（盘符）必须拒')
  h.eq(r[6].code, 'ID_NOT_ALLOWED', '盘符的 code')
})

h.case('T05-ID-reject-backslash', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.eq(r[7].ok, false, '`a\\b`（反斜杠）必须拒')
  h.eq(r[7].code, 'ID_NOT_ALLOWED', '反斜杠的 code')
})

h.case('T05-ID-reject-control-char', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.eq(r[11].ok, false, '带 NUL 的 id 必须拒')
  h.eq(r[11].code, 'ID_NOT_ALLOWED', '控制字符的 code')
})

h.case('T05-ID-reject-case-variant', 'pass', () => {
  need()
  const r = actRes(RUN.pure, 0)
  h.eq(r[8].ok, false, '`Library`（大小写变体）必须拒 —— Windows 上它和 library 是同一个目录')
  h.eq(r[8].code, 'ID_NOT_ALLOWED', '大小写变体的 code')
})

h.case('T05-ID-open-rejects-zero-spawn', 'pass', () => {
  need()
  const ids = RUN.ids
  for (const idx of [0, 1, 2]) {
    const res = actRes(ids, idx)
    const p = actProbe(ids, idx)
    keepEvidence(`T05-ID-open-rejects-zero-spawn-${idx}`, ids.r, { result: JSON.stringify(res), probe: JSON.stringify(p) })
    h.eq(res.ok, false, `openPack 第 ${idx} 条必须拒`)
    h.eq(res.code, 'ID_NOT_ALLOWED', `openPack 第 ${idx} 条的 code`)
    h.eq(p.spawnCount, 0, `openPack 第 ${idx} 条：spawn 零调用（实得 ${p.spawnCount}）`)
    h.eq(p.renameCount, 0, `openPack 第 ${idx} 条：rename 零调用（实得 ${p.renameCount}）`)
  }
})

h.case('T05-ID-remove-rejects-zero-rename', 'pass', () => {
  need()
  const ids = RUN.ids
  for (const idx of [4, 5, 6]) {
    const res = actRes(ids, idx)
    const p = actProbe(ids, idx)
    keepEvidence(`T05-ID-remove-rejects-zero-rename-${idx}`, ids.r, { result: JSON.stringify(res), probe: JSON.stringify(p) })
    h.eq(res.ok, false, `removePack 第 ${idx} 条必须拒`)
    h.eq(res.code, 'ID_NOT_ALLOWED', `removePack 第 ${idx} 条的 code`)
    h.eq(p.renameCount, 0, `removePack 第 ${idx} 条：rename 零调用（实得 ${p.renameCount}）`)
    h.eq(p.spawnCount, 0, `removePack 第 ${idx} 条：spawn 零调用（实得 ${p.spawnCount}）`)
  }
  // 落点必须**原封不动**（拒绝 ≠ 偷偷搬走）
  h.eq(fs.existsSync(path.join(LIB_ID, 'a', 'brm')), true, '`a/brm` 还在原处（没被搬走）')
  h.eq(fs.existsSync(path.join(LIB_ID, '..', 'esc-rm')), true, '`../esc-rm` 还在原处（没被搬走）')
  h.eq(fs.existsSync(path.join(LIB_ID, 'absrm')), true, '`/absrm` 还在原处（没被搬走）')
})

h.case('T05-ID-rebuild-rejects-zero-spawn', 'pass', () => {
  need()
  const res = actRes(RUN.ids, 3)
  const p = actProbe(RUN.ids, 3)
  keepEvidence('T05-ID-rebuild-rejects-zero-spawn', RUN.ids.r, { result: JSON.stringify(res), probe: JSON.stringify(p) })
  h.eq(res.ok, false, 'rebuild 非法 id 必须拒')
  h.eq(res.code, 'ID_NOT_ALLOWED', 'rebuild 的 code')
  h.eq(p.spawnCount, 0, `rebuild：spawn 零调用（实得 ${p.spawnCount}）`)
  h.eq((res.steps || []).length, 0, 'rebuild 被拒时零步骤')
})

h.case('T05-ID-http-open-400', 'pass', () => {
  need()
  const a = act(RUN.ids, 7)
  const p = a.probe
  keepEvidence('T05-ID-http-open-400', RUN.ids.r, { result: JSON.stringify(a.result), probe: JSON.stringify(p) })
  h.eq(a.result.status, 400, 'POST /api/open?id=../esc-open 必须 400')
  h.eq(a.result.json && a.result.json.code, 'ID_NOT_ALLOWED', 'HTTP 回执里带 code')
  h.eq(p.spawnCount, 0, `HTTP 拒绝时 spawn 零调用（实得 ${p.spawnCount}）`)
})

h.case('T05-ID-http-remove-400', 'pass', () => {
  need()
  const a = act(RUN.ids, 8)
  keepEvidence('T05-ID-http-remove-400', RUN.ids.r, { result: JSON.stringify(a.result), probe: JSON.stringify(a.probe) })
  h.eq(a.result.status, 400, 'POST /api/remove?id=a/brm 必须 400')
  h.eq(a.result.json && a.result.json.code, 'ID_NOT_ALLOWED', 'HTTP 回执里带 code')
  h.eq(a.probe.renameCount, 0, `HTTP 拒绝时 rename 零调用（实得 ${a.probe.renameCount}）`)
})

h.case('T05-ID-http-rebuild-400', 'pass', () => {
  need()
  const a = act(RUN.ids, 9)
  keepEvidence('T05-ID-http-rebuild-400', RUN.ids.r, { result: JSON.stringify(a.result), probe: JSON.stringify(a.probe) })
  h.eq(a.result.status, 400, 'POST /api/rebuild?id=/abs 必须 400')
  h.eq(a.result.json && a.result.json.code, 'ID_NOT_ALLOWED', 'HTTP 回执里带 code')
  h.eq(a.probe.spawnCount, 0, `HTTP 拒绝时 spawn 零调用（实得 ${a.probe.spawnCount}）`)
})

h.case('T05-ID-library-still-accepted', 'pass', () => {
  need()
  const res = actRes(RUN.ids, 10)
  const p = actProbe(RUN.ids, 10)
  keepEvidence('T05-ID-library-still-accepted', RUN.ids.r, { result: JSON.stringify(res), probe: JSON.stringify(p) })
  // 这个库里还没有 `library/`（夹具只造了越库落点）⇒ 不是 ID_NOT_ALLOWED，而是"库里还没有"
  h.eq(res.code, 'NO_LIBRARY', '`library` 必须过 id 闸（这里只是库还没建）')
  h.assert(!/ID_NOT_ALLOWED/.test(String(res.error)), '`library` 不许被判成非法 id')
})

// ================================================================ ② 受控解压：只收课程数据
const assertReject = (id, tag, code) => {
  const a = rejectOf(tag)
  keepEvidence(id, RUN.rejects.r, { result: JSON.stringify(a.result) })
  h.eq(a.result.ok, false, `${id}：必须拒绝`)
  h.eq(a.result.code, code, `${id}：拒绝码`)
}

h.case('T05-IMPORT-accept-normal', 'pass', () => {
  need()
  const res = actRes(RUN.importGood, 0)
  keepEvidence('T05-IMPORT-accept-normal', RUN.importGood.r, { result: JSON.stringify(res) })
  h.eq(res.ok, true, `正常课件包必须导入成功（error=${res.error || '无'}）`)
  h.eq(res.code, 'OK', '成功回执带 code=OK')
  h.eq(res.source, 'demo/alpha', '来源 id 记进回执（不决定目录）')
  h.eq(res.id, 'library', '落点永远是唯一课程库')
  h.eq(res.rebuilt, true, `重建链必须全绿（steps=${JSON.stringify(res.steps || [])}）`)
})

h.case('T05-IMPORT-reject-tools-js', 'pass', () => assertReject('T05-IMPORT-reject-tools-js', 'toolsJs', 'ZIP_ENTRY_NOT_ALLOWED'))
h.case('T05-IMPORT-reject-lessons-js', 'pass', () => assertReject('T05-IMPORT-reject-lessons-js', 'lessonsJs', 'ZIP_ENTRY_NOT_ALLOWED'))
h.case('T05-IMPORT-reject-src-subtree', 'pass', () => assertReject('T05-IMPORT-reject-src-subtree', 'srcSubtree', 'ZIP_ENTRY_NOT_ALLOWED'))
h.case('T05-IMPORT-reject-traversal-entry', 'pass', () => assertReject('T05-IMPORT-reject-traversal-entry', 'traversal', 'ZIP_DANGEROUS_ENTRY'))
h.case('T05-IMPORT-reject-absolute-entry', 'pass', () => assertReject('T05-IMPORT-reject-absolute-entry', 'absolute', 'ZIP_DANGEROUS_ENTRY'))
h.case('T05-IMPORT-reject-backslash-entry', 'pass', () => assertReject('T05-IMPORT-reject-backslash-entry', 'backslash', 'ZIP_DANGEROUS_ENTRY'))
h.case('T05-IMPORT-reject-symlink-entry', 'pass', () => assertReject('T05-IMPORT-reject-symlink-entry', 'symlink', 'ZIP_LINK_ENTRY'))
h.case('T05-IMPORT-reject-duplicate-entry', 'pass', () => assertReject('T05-IMPORT-reject-duplicate-entry', 'duplicate', 'ZIP_DUPLICATE_ENTRY'))
h.case('T05-IMPORT-reject-case-collision', 'pass', () => assertReject('T05-IMPORT-reject-case-collision', 'caseCollision', 'ZIP_DUPLICATE_ENTRY'))
h.case('T05-IMPORT-reject-ads-entry', 'pass', () => assertReject('T05-IMPORT-reject-ads-entry', 'ads', 'ZIP_DANGEROUS_ENTRY'))
h.case('T05-IMPORT-reject-device-name', 'pass', () => assertReject('T05-IMPORT-reject-device-name', 'device', 'ZIP_DANGEROUS_ENTRY'))
h.case('T05-IMPORT-reject-too-many-entries', 'pass', () => assertReject('T05-IMPORT-reject-too-many-entries', 'tooMany', 'ZIP_TOO_MANY_ENTRIES'))
h.case('T05-IMPORT-reject-entry-too-big', 'pass', () => assertReject('T05-IMPORT-reject-entry-too-big', 'entryTooBig', 'ZIP_ENTRY_TOO_BIG'))
h.case('T05-IMPORT-reject-total-too-big', 'pass', () => assertReject('T05-IMPORT-reject-total-too-big', 'totalTooBig', 'ZIP_TOTAL_TOO_BIG'))
h.case('T05-IMPORT-reject-ratio-bomb', 'pass', () => assertReject('T05-IMPORT-reject-ratio-bomb', 'ratioBomb', 'ZIP_RATIO'))
h.case('T05-IMPORT-reject-forged-actual-bytes', 'pass', () => {
  // 声明 1 KiB、实际写出 40 MiB：phase 1 看声明放行，phase 2 的**实写字节**闸必须拦住
  assertReject('T05-IMPORT-reject-forged-actual-bytes', 'forgedActual', 'ZIP_ENTRY_TOO_BIG')
  const res = rejectOf('forgedActual').result
  h.assert(/forged header|per-file budget/.test(String(res.error)), `拒绝原因要点明是实写字节超限：${res.error}`)
})

h.case('T05-IMPORT-reject-timeout-budget', 'pass', () => {
  need()
  keepEvidence('T05-IMPORT-reject-timeout-budget', RUN.timeout.r, { receipt: JSON.stringify(RUN.timeout.receipt) })
  h.assert(RUN.timeout.receipt != null, `helper 必须留下回执（${clip(both(RUN.timeout.r), 200)}）`)
  h.eq(RUN.timeout.receipt.code, 'ZIP_TIMEOUT', '`-TimeoutSec 0` ⇒ 预算机制是活的（不是死代码）')
  h.eq(RUN.timeout.written.length, 0, '超时拒绝时暂存树是空的（一个字节都没写）')
})

h.case('T05-IMPORT-library-untouched-on-reject', 'pass', () => {
  need()
  // 拒绝路径上**目标库根本不该出现**（连目录都不建）—— 这是"完成全部验证才接触目标库"的硬证据
  h.eq(fs.existsSync(LIB_REJECT), false, `拒绝导入后目标库根不该存在：${LIB_REJECT}`)
  // 再证一次"库树一个字节不变"：先正常导入建库，再拿一个带 JS 的包去撞
  const snapBefore = snapTree(LIB_GOOD)
  const z = zipFile('untouched', goodEntries([{ name: './lessons/demo/alpha/evil.js', data: 'x' }]))
  const r = runDriver('untouched', TMPL_NEW, LIB_GOOD, [{ kind: 'import', zip: z, name: 'evil.zip' }])
  const res = (r.rec && r.rec.results[0] && r.rec.results[0].result) || null
  const snapAfter = snapTree(LIB_GOOD)
  keepEvidence('T05-IMPORT-library-untouched-on-reject', r.r, { result: JSON.stringify(res), same: String(snapBefore === snapAfter) })
  h.assert(res != null, `要拿到拒绝回执（${clip(both(r.r), 200)}）`)
  h.eq(res.ok, false, '带 JS 的包必须拒')
  h.eq(snapAfter, snapBefore, '拒绝导入后库树一个字节不变（连 tools/ 都不许刷新）')
})

h.case('T05-IMPORT-allowlist-parity', 'pass', () => {
  need()
  const { receipt } = RUN.parity
  keepEvidence('T05-IMPORT-allowlist-parity', RUN.parity.r, { receipt: JSON.stringify(receipt && receipt.decisions ? receipt.decisions : receipt) })
  h.assert(receipt != null, `helper 必须留下回执（${clip(both(RUN.parity.r), 200)}）`)
  const decisions = Array.isArray(receipt.decisions) ? receipt.decisions.filter((d) => d.reason !== 'dir') : []
  h.eq(decisions.length, PARITY_SAMPLES.length, '每个条目都要有一条判决（对拍才不是空转）')
  // JS 侧同一批名字
  const jsRun = runDriver('parity-js', TMPL_NEW, LIB_INPROC, [{ kind: 'classify', names: PARITY_SAMPLES }])
  const jsVerdicts = (jsRun.rec && jsRun.rec.results[0] && jsRun.rec.results[0].result) || null
  h.assert(jsVerdicts != null, `要拿到 JS 侧判决（${clip(both(jsRun.r), 200)}）`)
  const mismatches = []
  for (let i = 0; i < PARITY_SAMPLES.length; i++) {
    const d = decisions[i]
    const j = jsVerdicts[i]
    const helperVerdict = d.keep ? `keep:${d.reason}` : `reject:${d.reason}`
    const jsVerdict = j.ok ? `keep:${j.kind}` : `reject:${j.code}`
    if (helperVerdict !== jsVerdict) mismatches.push(`${PARITY_SAMPLES[i]} → helper=${helperVerdict} / js=${jsVerdict}`)
  }
  h.evidence(path.join('cases', 'T05-IMPORT-allowlist-parity-table.txt'),
    PARITY_SAMPLES.map((n, i) => {
      const d = decisions[i]; const j = jsVerdicts[i]
      return `${n}\thelper=${d.keep ? 'keep:' + d.reason : 'reject:' + d.reason}\tjs=${j.ok ? 'keep:' + j.kind : 'reject:' + j.code}`
    }).join('\n') + '\n')
  h.eq(mismatches.join(' | '), '', `helper 与 JS 的白名单口径必须逐条同判（实得 ${mismatches.length} 处不一致）`)
})

h.case('T05-IMPORT-no-tar-fallback', 'pass', () => {
  need()
  const src = fs.readFileSync(path.join(REPO, REL_SERVER), 'utf8')
  const helper = fs.readFileSync(path.join(REPO, REL_HELPER), 'utf8')
  const tarHits = [
    /spawnSync\(\s*TAR\b/.test(src) ? 'spawnSync(TAR' : null,
    /'-xf'|"-xf"/.test(src) ? "'-xf'" : null,
    /tar\.exe/.test(src) ? 'tar.exe' : null,
    /tar\.exe/.test(helper) ? 'helper 里出现 tar.exe' : null,
  ].filter(Boolean)
  const support = actRes(RUN.pure, 1)
  h.evidence(path.join('cases', 'T05-IMPORT-no-tar-fallback.txt'), [
    `offline-server.js 里的 tar 痕迹：${tarHits.join('、') || '（无）'}`,
    `引用受信 helper？${/import-zip\.ps1/.test(src)}`,
    `用共享路径策略？${/path-policy\.cjs/.test(src)}`,
    `helper 里有平台硬失败（ZIP_NOT_SUPPORTED）？${/ZIP_NOT_SUPPORTED/.test(helper)}`,
    `本机 helper 支持探测：${JSON.stringify(support && support.support)}`,
    '',
  ].join('\n'))
  h.eq(tarHits.length, 0, '导入路径上不许再有 tar（不静默回退）')
  h.assert(/import-zip\.ps1/.test(src), '导入必须走受信 helper')
  h.assert(/ZIP_NOT_SUPPORTED/.test(helper), 'helper 必须有"平台不支持就硬失败"那条（不静默降级）')
  h.eq(support.support.ok, true, '本机受信 helper 必须可用（否则判据无从谈起）')
  h.assert(fs.existsSync(support.support.helper), 'helper 路径必须真实存在')
})

h.case('T05-IMPORT-limits-are-production-constants', 'pass', () => {
  need()
  const got = actRes(RUN.pure, 1)
  const src = fs.readFileSync(path.join(REPO, REL_SERVER), 'utf8')
  const helper = fs.readFileSync(path.join(REPO, REL_HELPER), 'utf8')
  h.evidence(path.join('cases', 'T05-IMPORT-limits.txt'), [
    `IMPORT_LIMITS=${JSON.stringify(got.limits)}`,
    `期望=${JSON.stringify(PROD_LIMITS)}`,
    '',
  ].join('\n'))
  h.eq(JSON.stringify(got.limits), JSON.stringify(PROD_LIMITS), '生产上限必须逐条等于卡面那一套数')
  // helper 的**默认值**也必须是同一套数（判据直接用 helper 时不许悄悄更松）
  for (const [flag, value] of [['MaxEntries', PROD_LIMITS.maxEntries], ['MaxFile', PROD_LIMITS.maxFile], ['MaxTotal', PROD_LIMITS.maxTotal], ['MaxRatio', PROD_LIMITS.maxRatio], ['TimeoutSec', PROD_LIMITS.timeoutSec]]) {
    h.assert(new RegExp(`\\[\\w+\\]\\$${flag}\\s*=\\s*${value}\\b`).test(helper), `helper 默认 ${flag} 必须是 ${value}`)
  }
  h.assert(new RegExp(`maxUpload:\\s*64 \\* 1024 \\* 1024\\b`).test(src), '上传上限 64 MiB 必须写在源码里')
  h.eq(got.libraryDir, 'library', '固定库名就是 library')
})

/**
 * helper 的**源码完整性**（T05 实测踩到的真坑，写下来防止再犯）：
 * 本机 shell 是 Windows PowerShell 5.1，它把**没有 BOM 的 .ps1 当 ANSI/GBK 解码**。
 * 我第一版在 helper 里写了中文注释 —— UTF-8 字节被 GBK 解码后，某一行**末尾变成了反引号**，
 * 而 PowerShell 把"注释行末尾的反引号"当成**续行**：那一行注释于是吞掉了后面两行，
 * 其中一行正是 `lessons/<halo>/<point>/<name>` 的保留段判断 —— 代码静默消失，
 * 表现是 `lessons/tools/**`、`lessons/node_modules/**` 被当成合法课程数据放行。
 * 所以这条判据钉两件事：① helper 必须**纯 ASCII**；② 解析器不许把任何注释跨行吞并。
 */
h.case('T05-IMPORT-helper-source-integrity', 'pass', () => {
  need()
  const buf = fs.readFileSync(path.join(REPO, REL_HELPER))
  const nonAscii = []
  for (let i = 0; i < buf.length; i++) if (buf[i] > 127) nonAscii.push(i)
  const probeFile = path.join(SANDBOX, 'helper', 'ast-probe.ps1')
  W(probeFile, [
    `$p = '${path.join(REPO, REL_HELPER).replace(/'/g, "''")}'`,
    '$tokens = $null; $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errors)',
    '$multi = @($tokens | Where-Object { $_.Kind -eq \'Comment\' -and $_.Text -match "`n" }).Count',
    '$lines = @(Get-Content -LiteralPath $p).Count',
    '$maxLine = ($tokens | ForEach-Object { $_.Extent.EndLineNumber } | Measure-Object -Maximum).Maximum',
    'if ($null -eq $maxLine) { $maxLine = -1 }',
    'Write-Output ("ERRORS=" + @($errors).Count)',
    'Write-Output ("MULTILINE_COMMENTS=" + $multi)',
    'Write-Output ("PHYSICAL_LINES=" + $lines)',
    'Write-Output ("MAX_TOKEN_LINE=" + $maxLine)',
    '',
  ].join('\n'))
  const r = runChild([PS_EXE, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probeFile], { cwd: REPO, timeoutMs: 120000 })
  const out = String(r.out || '')
  const num = (k) => { const m = new RegExp(`${k}=(\\d+)`).exec(out); return m ? Number(m[1]) : -1 }
  keepEvidence('T05-IMPORT-helper-source-integrity', r, { nonAsciiBytes: nonAscii.length, firstNonAscii: nonAscii.slice(0, 5).join(',') })
  h.eq(nonAscii.length, 0, `helper 必须是纯 ASCII（BOM-less .ps1 会被 PS 5.1 按 GBK 解码）—— 实得 ${nonAscii.length} 个非 ASCII 字节`)
  h.eq(num('ERRORS'), 0, `helper 必须零语法错（实得 ${num('ERRORS')}）`)
  h.eq(num('MULTILINE_COMMENTS'), 0, `不许有跨行吞并的注释（末尾反引号会吞掉下一行代码）—— 实得 ${num('MULTILINE_COMMENTS')}`)
  // ⚠️ 这条要**真断言到数**：探针打不出数（-1）就当场红 —— 否则又是"恒真的空转判据"
  h.assert(num('PHYSICAL_LINES') > 0, `探针必须报出物理行数（实得 ${num('PHYSICAL_LINES')}；stderr=${clip(String(r.err), 200)}）`)
  h.assert(num('MAX_TOKEN_LINE') >= num('PHYSICAL_LINES') - 1 && num('MAX_TOKEN_LINE') <= num('PHYSICAL_LINES') + 2,
    `解析器必须一路看见文件末尾（物理 ${num('PHYSICAL_LINES')} 行 / 最大记号行 ${num('MAX_TOKEN_LINE')}）—— 差得多就是有行被注释吞了`)
})

// ================================================================ ③ 正常课件仍可浏览
h.case('T05-BROWSE-library-lists-lesson', 'pass', () => {
  need()
  const info = actRes(RUN.browse, 0)
  keepEvidence('T05-BROWSE-library-lists-lesson', RUN.browse.r, { result: JSON.stringify(info) })
  h.eq(info.ok, true, '库现状要读得出来')
  h.eq(info.lessonCount, 1, '库里正好 1 课（导入的那一节）')
  h.eq(info.lessons[0].rel, 'demo/alpha/0001-hello.html', '清单里的 rel 对得上')
  h.eq(info.circles, 1, '圆圈数 = 1')
})

h.case('T05-BROWSE-starmap-page-200', 'pass', () => {
  need()
  const a = act(RUN.browse, 1)
  keepEvidence('T05-BROWSE-starmap-page-200', RUN.browse.r, { status: a.result.status, text: a.result.text })
  h.eq(a.result.status, 200, `GET /library/starmap/ 必须 200（实得 ${a.result.status}）`)
  h.assert(/知识星图|<html/i.test(String(a.result.text || '')), '拿到的必须是真页面（不是 404 文本）')
})

h.case('T05-BROWSE-lesson-page-200', 'pass', () => {
  need()
  const a = act(RUN.browse, 2)
  keepEvidence('T05-BROWSE-lesson-page-200', RUN.browse.r, { status: a.result.status, text: a.result.text })
  h.eq(a.result.status, 200, `GET /library/lessons/demo/alpha/0001-hello.html 必须 200（实得 ${a.result.status}）`)
  h.assert(/T05 夹具课程页|你好/.test(String(a.result.text || '')), '拿到的必须是导入的那一页')
})

h.case('T05-BROWSE-library-tools-self-contained', 'pass', () => {
  need()
  const tools = path.join(LIB_GOOD, 'library', 'tools')
  const rows = ['import-zip.ps1', 'path-policy.cjs', 'offline-server.js', 'offline-admin.html', 'app-server.js']
    .map((f) => `${f}=${fs.existsSync(path.join(tools, f))}`)
  h.evidence(path.join('cases', 'T05-BROWSE-library-tools-self-contained.txt'), rows.join('\n') + '\n')
  for (const f of ['import-zip.ps1', 'path-policy.cjs', 'offline-server.js', 'offline-admin.html', 'app-server.js']) {
    h.eq(fs.existsSync(path.join(tools, f)), true, `库里自带 ${f}（库自己那一份也能跑）`)
  }
})

// ================================================================ ④ 旧库迁移：显式
h.case('T05-MIG-plan-readonly', 'pass', () => {
  need()
  const before = snapTree(LIB_MIG_PLAN)
  const plan = actRes(RUN.migPlan, 0)
  const after = snapTree(LIB_MIG_PLAN)
  keepEvidence('T05-MIG-plan-readonly', RUN.migPlan.r, { plan: JSON.stringify(plan), same: String(before === after) })
  h.eq(plan.ok, true, '计划要读得出来')
  h.eq(plan.count, 2, '夹具里正好 2 个旧课程包')
  h.eq(plan.plan.map((p) => p.id).join(','), 'olda,oldb', '计划里的 id 按字母序')
  h.assert(typeof plan.digest === 'string' && plan.digest.length >= 16, '计划要带摘要')
  h.eq(after, before, '**只读**：看计划不许动盘')
  h.eq(fs.existsSync(path.join(LIB_MIG_PLAN, '.migrated.json')), false, '看计划不许写迁移台账')
  h.eq(fs.existsSync(path.join(LIB_MIG_PLAN, '.trash')), false, '看计划不许建回收站')
  h.eq(fs.existsSync(path.join(LIB_MIG_PLAN, 'library')), false, '看计划不许建库')
})

h.case('T05-MIG-plan-deterministic-and-stale', 'pass', () => {
  need()
  const first = actRes(RUN.migPlan, 0)
  const second = actRes(RUN.migPlan, 1)
  h.eq(second.digest, first.digest, '同一份计划两次算出的摘要必须逐字相同（可复算）')
  // 动一下旧包（mtime 变）⇒ 摘要必须变（这就是 stale 判据的依据）
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(LIB_MIG_PLAN, 'oldb'), t, t)
  const after = runDriver('mig-plan-after', TMPL_NEW, LIB_MIG_PLAN, [{ kind: 'plan' }])
  const third = (after.rec && after.rec.results[0] && after.rec.results[0].result) || null
  keepEvidence('T05-MIG-plan-deterministic-and-stale', after.r, { first: first.digest, second: second.digest, third: third && third.digest })
  h.assert(third != null, `要拿到第三次计划（${clip(both(after.r), 200)}）`)
  h.assert(third.digest !== first.digest, '现状变了摘要就得变（否则 stale 判据是空的）')
})

h.case('T05-MIG-no-auto-merge-on-startup', 'pass', () => {
  need()
  const r = RUN.startNew
  const before = fs.existsSync(path.join(LIB_START_NEW, 'library'))
  keepEvidence('T05-MIG-no-auto-merge-on-startup', { code: 0, out: r.log, err: '', ms: 0, timedOut: false },
    { port: r.port, health: r.status, libraryExists: String(before) })
  h.assert(r.status === 200, `新实现的启动路径必须真的起来了（health=${r.status}）`)
  h.eq(before, false, '**启动时不再自动合并**：库里不该长出 library/')
  h.eq(fs.existsSync(path.join(LIB_START_NEW, '.migrated.json')), false, '启动时不该写迁移台账')
  h.eq(fs.existsSync(path.join(LIB_START_NEW, 'olda')), true, '旧包必须还在原处（没被搬走）')
  h.assert(/旧课程包/.test(r.log) && /不再自动合并/.test(r.log), `启动日志要如实报告"发现旧包、不再自动合并"：${clip(r.log, 200)}`)
})

h.case('T05-MIG-apply-requires-confirm', 'pass', () => {
  need()
  const before = snapTree(LIB_MIG_APPLY)
  const res = actRes(RUN.migApply, 0)
  const after = snapTree(LIB_MIG_APPLY)
  keepEvidence('T05-MIG-apply-requires-confirm', RUN.migApply.r, { result: JSON.stringify(res), same: String(before === after) })
  h.eq(res.ok, false, '不确认必须拒')
  h.eq(res.code, 'MIGRATION_NOT_CONFIRMED', '拒绝码')
  h.eq(after, before, '不确认时树一个字节不变')
})

h.case('T05-MIG-apply-requires-digest', 'pass', () => {
  need()
  const before = snapTree(LIB_MIG_APPLY)
  const res = actRes(RUN.migApply, 1)
  const after = snapTree(LIB_MIG_APPLY)
  keepEvidence('T05-MIG-apply-requires-digest', RUN.migApply.r, { result: JSON.stringify(res), same: String(before === after) })
  h.eq(res.ok, false, '没带计划摘要必须拒')
  h.eq(res.code, 'MIGRATION_PLAN_REQUIRED', '拒绝码')
  h.eq(after, before, '没带摘要时树一个字节不变')
})

h.case('T05-MIG-apply-stale-plan-rejected', 'pass', () => {
  need()
  // 自包含的"过期计划"场景：先拿一份**新鲜**计划，再动一下库里的现状，然后拿旧摘要去确认
  const planRun = runDriver('mig-stale-plan', TMPL_NEW, LIB_MIG_APPLY, [{ kind: 'plan' }])
  const plan = (planRun.rec && planRun.rec.results[0] && planRun.rec.results[0].result) || null
  h.assert(plan != null, `要拿到计划（${clip(both(planRun.r), 200)}）`)
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(LIB_MIG_APPLY, 'olda'), t, t)
  const before = snapTree(LIB_MIG_APPLY)
  const stale = runDriver('mig-stale', TMPL_NEW, LIB_MIG_APPLY, [
    { kind: 'apply', body: { confirm: true, planDigest: plan.digest } },
  ])
  const res = (stale.rec && stale.rec.results[0] && stale.rec.results[0].result) || null
  const after = snapTree(LIB_MIG_APPLY)
  keepEvidence('T05-MIG-apply-stale-plan-rejected', stale.r, { result: JSON.stringify(res), same: String(before === after) })
  h.assert(res != null, `要拿到回执（${clip(both(stale.r), 200)}）`)
  h.eq(res.ok, false, '现状变了之后拿旧摘要确认必须拒')
  h.eq(res.code, 'MIGRATION_PLAN_STALE', '拒绝码')
  h.eq(after, before, '过期计划被拒时树一个字节不变')
})

h.case('T05-MIG-apply-migrates', 'pass', () => {
  need()
  const plan = runDriver('mig-fresh', TMPL_NEW, LIB_MIG_APPLY, [{ kind: 'plan' }])
  const fresh = (plan.rec && plan.rec.results[0] && plan.rec.results[0].result) || null
  h.assert(fresh != null, `要拿到计划（${clip(both(plan.r), 200)}）`)
  h.eq(fresh.count, 2, '这时库里还有 2 个旧包')
  const applied = runDriver('mig-do', TMPL_NEW, LIB_MIG_APPLY, [
    { kind: 'apply', body: { confirm: true, planDigest: fresh.digest } },
  ])
  const res = (applied.rec && applied.rec.results[0] && applied.rec.results[0].result) || null
  keepEvidence('T05-MIG-apply-migrates', applied.r, { result: JSON.stringify(res) })
  h.assert(res != null, `要拿到回执（${clip(both(applied.r), 200)}）`)
  h.eq(res.ok, true, `确认 + 摘要齐了必须真迁移（error=${res.error || '无'}）`)
  h.eq(res.code, 'MIGRATION_DONE', '回执码')
  h.eq((res.migrated || []).join(','), 'olda,oldb', '两个旧包都并进来了')
  // 合并结果：课进了唯一课程库、旧包进了回收站、台账写上了
  const libLessons = path.join(LIB_MIG_APPLY, 'library', 'lessons')
  h.eq(fs.existsSync(path.join(libLessons, 'olda', 'alpha', '0001-x.html')), true, 'olda 的课进了库')
  h.eq(fs.existsSync(path.join(libLessons, 'oldb', 'alpha', '0001-x.html')), true, 'oldb 的课进了库')
  h.eq(fs.existsSync(path.join(LIB_MIG_APPLY, 'olda')), false, 'olda 原目录已让位')
  h.eq(fs.existsSync(path.join(LIB_MIG_APPLY, 'oldb')), false, 'oldb 原目录已让位')
  h.eq(fs.existsSync(path.join(LIB_MIG_APPLY, '.trash')), true, '回收站建起来了（可手工恢复）')
  const mark = (() => { try { return JSON.parse(fs.readFileSync(path.join(LIB_MIG_APPLY, '.migrated.json'), 'utf8')) } catch { return null } })()
  h.eq(JSON.stringify(mark), JSON.stringify(['olda', 'oldb']), '迁移台账如实记下两个旧包')
  // 幂等：再算一次计划 ⇒ 没有可迁移的了
  const again = runDriver('mig-again', TMPL_NEW, LIB_MIG_APPLY, [{ kind: 'plan' }])
  const p2 = (again.rec && again.rec.results[0] && again.rec.results[0].result) || null
  h.eq(p2 && p2.count, 0, '迁移过的不再出现在计划里（幂等）')
})

h.case('T05-MIG-http-plan-and-apply', 'pass', () => {
  need()
  const planRes = actRes(RUN.migHttp, 0)
  const noConfirm = actRes(RUN.migHttp, 1)
  h.eq(planRes.status, 200, 'GET /api/migration 要 200')
  h.eq(planRes.json.count, 1, '这个库里 1 个旧包')
  h.eq(noConfirm.status, 200, 'POST /api/migrate 不带确认：回执要可读（不是 500）')
  h.eq(noConfirm.json.code, 'MIGRATION_NOT_CONFIRMED', 'HTTP 路径同样要过"确认"那道门')
  const digest = planRes.json.digest
  const doRes = runDriver('mig-http-do', TMPL_NEW, LIB_MIG_HTTP, [
    { kind: 'http', method: 'POST', path: '/api/migrate', body: JSON.stringify({ confirm: true, planDigest: digest }) },
  ])
  const done = (doRes.rec && doRes.rec.results[0] && doRes.rec.results[0].result) || null
  keepEvidence('T05-MIG-http-plan-and-apply', doRes.r, { plan: JSON.stringify(planRes), noConfirm: JSON.stringify(noConfirm), done: JSON.stringify(done) })
  h.assert(done != null, `要拿到回执（${clip(both(doRes.r), 200)}）`)
  h.eq(done.status, 200, '带确认 + 摘要的 POST 要 200')
  h.eq(done.json.code, 'MIGRATION_DONE', 'HTTP 路径也能真迁移')
  h.eq(fs.existsSync(path.join(LIB_MIG_HTTP, 'library', 'lessons', 'olda', 'alpha', '0001-x.html')), true, '课真的进了库')
})

// ================================================================ ⑤ 负向控制
h.case('T05-NEGCTRL-baseline-open-dotdot-spawns', 'pass', () => {
  need()
  const a = act(RUN.baseIds, 0)
  keepEvidence('T05-NEGCTRL-baseline-open-dotdot-spawns', RUN.baseIds.r, { result: JSON.stringify(a.result), probe: JSON.stringify(a.probe) })
  h.eq(a.result.ok, false, '基线那条路最后也是失败的（它起的服务没人答话）—— 但**它是真去起了**')
  h.assert(a.result.code === undefined, '基线回执里**没有** code 字段（那是新实现才有的形状）')
  h.assert(a.probe.spawnCount >= 1, `**基线必须真的越库 spawn**（实得 spawnCount=${a.probe.spawnCount}；调用=${JSON.stringify(a.probe.calls)}）`)
})

h.case('T05-NEGCTRL-baseline-open-nested-spawns', 'pass', () => {
  need()
  const a = act(RUN.baseIds, 1)
  keepEvidence('T05-NEGCTRL-baseline-open-nested-spawns', RUN.baseIds.r, { result: JSON.stringify(a.result), probe: JSON.stringify(a.probe) })
  h.assert(a.probe.spawnCount >= 1, `基线对 nested id 也照样 spawn（实得 ${a.probe.spawnCount}）`)
})

h.case('T05-NEGCTRL-baseline-remove-dotdot-renames', 'pass', () => {
  need()
  const a = act(RUN.baseIds, 2)
  keepEvidence('T05-NEGCTRL-baseline-remove-dotdot-renames', RUN.baseIds.r, { result: JSON.stringify(a.result), probe: JSON.stringify(a.probe) })
  h.assert(a.probe.renameCount >= 1, `**基线必须真的把库外目录搬走**（实得 renameCount=${a.probe.renameCount}；调用=${JSON.stringify(a.probe.calls)}）`)
  h.eq(fs.existsSync(path.join(LIB_ID, '..', 'esc-rm-base')), false, '基线真的把 `../esc-rm-base` 搬走了（越库写）')
})

h.case('T05-NEGCTRL-baseline-imports-js-subtree', 'pass', () => {
  need()
  const a = act(RUN.baseImport, 0)
  const planted = path.join(LIB_NEG, 'library', 'lessons', 'demo', 'alpha', 'evil.js')
  keepEvidence('T05-NEGCTRL-baseline-imports-js-subtree', RUN.baseImport.r,
    { result: JSON.stringify(a.result), planted: String(fs.existsSync(planted)) })
  if (a.result && !a.result.ok && /EPERM|子进程|spawn/i.test(String(a.result.error))) {
    h.block(`基线要 tar 子进程才能解包，本机不让（${a.result.error}）—— 这条负向控制判不了`)
  }
  h.eq(a.result.ok, true, `**基线必须真的把带 JS 的包导进来**（error=${a.result.error || '无'}）`)
  h.eq(fs.existsSync(planted), true, '**基线真的把 `lessons/demo/alpha/evil.js` 并进了库** —— 这正是 D01 要挡的"可执行子树"')
})

h.case('T05-NEGCTRL-baseline-startup-auto-merges', 'pass', () => {
  need()
  const r = RUN.startBase
  keepEvidence('T05-NEGCTRL-baseline-startup-auto-merges', { code: 0, out: r.log, err: '', ms: 0, timedOut: false },
    { port: r.port, health: r.status })
  h.assert(r.status === 200, `基线启动路径必须真的起来了（health=${r.status}）`)
  h.eq(fs.existsSync(path.join(LIB_START_BASE, 'library', 'lessons', 'olda', 'alpha', '0001-x.html')), true,
    '**基线启动时无条件自动合并**：课已经被静默并进库')
  h.eq(fs.existsSync(path.join(LIB_START_BASE, 'olda')), false, '基线把旧包原目录搬走了（没问过任何人）')
})

h.case('T05-NEGCTRL-old-vs-new-diff', 'pass', () => {
  need()
  const newIds = runDriver('diff-new-ids', TMPL_NEW, LIB_ID, [
    { kind: 'open', id: '../esc-open' }, { kind: 'open', id: 'a/b' },
  ], { spy: true })
  const n0 = (newIds.rec && newIds.rec.results[0]) || null
  const n1 = (newIds.rec && newIds.rec.results[1]) || null
  const b0 = act(RUN.baseIds, 0)
  const b1 = act(RUN.baseIds, 1)
  const a = act(RUN.newImportSame, 0)
  const summary = [
    '# 负向控制：旧实现 vs 新实现（同一批输入）',
    '',
    `openPack('../esc-open')  基线 spawn=${b0.probe.spawnCount} code=${b0.result.code} ｜ 新 spawn=${n0 ? n0.probe.spawnCount : 'n/a'} code=${n0 && n0.result.code}`,
    `openPack('a/b')          基线 spawn=${b1.probe.spawnCount} code=${b1.result.code} ｜ 新 spawn=${n1 ? n1.probe.spawnCount : 'n/a'} code=${n1 && n1.result.code}`,
    `removePack('../esc-rm')  基线 rename=${act(RUN.baseIds, 2).probe.renameCount}`,
    `importZip(带 lessons/**.js) 基线 ok=${act(RUN.baseImport, 0).result.ok}（并进库=${fs.existsSync(path.join(LIB_NEG, 'library', 'lessons', 'demo', 'alpha', 'evil.js'))}）`,
    `                            新   ok=${a.result.ok} code=${a.result.code}`,
    `启动时旧包            基线 自动合并=${fs.existsSync(path.join(LIB_START_BASE, 'library'))} ｜ 新 自动合并=${fs.existsSync(path.join(LIB_START_NEW, 'library'))}`,
    '',
  ].join('\n')
  h.evidence('negative-controls.md', summary)
  h.evidence(path.join('cases', 'T05-NEGCTRL-old-vs-new-diff.txt'), summary)
  h.eq(n0 && n0.probe.spawnCount, 0, '新实现：`../` id 零 spawn')
  h.eq(n1 && n1.probe.spawnCount, 0, '新实现：nested id 零 spawn')
  h.assert(b0.probe.spawnCount >= 1 && b1.probe.spawnCount >= 1, '基线：两种 id 都真的 spawn（差异就是那道闸）')
  h.eq(a.result.ok, false, '新实现：带 JS 的包拒收')
  h.eq(a.result.code, 'ZIP_ENTRY_NOT_ALLOWED', '新实现的拒绝码')
})

// ================================================================ ⑥ 回归与夹具纪律
h.case('T05-REG-selftest-still-passes', 'pass', () => {
  const r = runChild([NODE, path.join(TEST_DIR, 'all.mjs'), '--selftest'], { cwd: REPO, timeoutMs: 300000 })
  keepEvidence('T05-REG-selftest-still-passes', r, {})
  h.eq(r.code, 0, `all.mjs --selftest 必须仍全绿（exit 0），实际 ${r.code}`)
  h.assert(/selftest: 17 通过 \/ 0 失败/.test(both(r)), 'selftest 仍是 17/17（判据面不许悄悄少几条）')
})

h.case('T05-REG-t03-t04-still-green', 'pass', () => {
  const r3 = runChild([NODE, path.join(TEST_DIR, 'audit', 'T03.mjs')], { cwd: REPO, timeoutMs: 600000 })
  const r4 = runChild([NODE, path.join(TEST_DIR, 'audit', 'T04.mjs')], { cwd: REPO, timeoutMs: 600000 })
  keepEvidence('T05-REG-t03-t04-still-green-T03', r3, {})
  keepEvidence('T05-REG-t03-t04-still-green-T04', r4, {})
  h.eq(r3.code, 0, `T03 必须仍绿（exit=${r3.code}）：${clip(both(r3), 300)}`)
  h.assert(/PASS T03 checks=31 failed=0 skipped=0/.test(both(r3)), 'T03 判词仍是 31/0/0')
  h.eq(r4.code, 0, `T04 必须仍绿（exit=${r4.code}）：${clip(both(r4), 300)}`)
  h.assert(/PASS T04 checks=46 failed=0 skipped=0/.test(both(r4)), 'T04 判词仍是 46/0/0')
})

h.case('T05-FIXTURE-cleanup-guard', 'pass', () => {
  // 铁律 7：清理前核实绝对路径属于本次夹具 —— 先把这条纪律本身验一遍
  const notOurs = path.join(os.tmpdir(), 'not-our-fixture-t05')
  fs.mkdirSync(notOurs, { recursive: true })
  W(path.join(notOurs, 'x.txt'), 'x')
  const refused = cleanupTempDir(notOurs, 't05')
  const ours = makeTempDir('t05-cleanup')
  const removed = cleanupTempDir(ours, 't05-cleanup')
  h.evidence(path.join('cases', 'T05-FIXTURE-cleanup-guard.txt'),
    `非本次夹具：${JSON.stringify(refused)}\n本次夹具：${JSON.stringify(removed)}\n`)
  h.eq(refused.removed, false, '不属于本次夹具的目录必须拒绝清理')
  h.assert(/拒绝清理/.test(String(refused.error)), '拒绝时要说明原因')
  h.eq(fs.existsSync(notOurs), true, '被拒绝的目录还在（没被误删）')
  h.eq(removed.removed, true, '本次夹具要能删掉')
  fs.rmSync(notOurs, { recursive: true, force: true })
})

// ================================================================ 收尾（夹具清理 + 一行判词）
{
  const c = cleanupTempDir(SANDBOX, 't05')
  h.note(`夹具清理：${JSON.stringify(c)}（sandbox=${SANDBOX}）`)
  h.evidence('fixture-cleanup.txt', `sandbox=${SANDBOX}\n${JSON.stringify(c, null, 2)}\n`)
}
process.exit(h.run())
