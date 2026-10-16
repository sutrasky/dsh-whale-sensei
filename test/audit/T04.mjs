#!/usr/bin/env node
/**
 * T04.mjs —— 执行前核验受信引擎闭包并提供显式升级（报告 D01 / P1）
 * ==================================================================
 * 验收判据（**原文**，见 cards/T04.md）：
 *   「nested/`../`/绝对 id 均 400且 spawn/rename 零调用；含上述脚本的 ZIP 拒绝导入；
 *     正常课件仍可浏览。」
 *
 * 怎么做才算「不是嘴上说」：
 *   - 每条判据都**真起子进程 / 真 require / 真 spawn** 去驱动生产入口
 *     （`lib/pack-server.js` 的 `ensurePackServer`、`lib/rebuild-job.js` 的 `startRebuild`
 *     与 `startScripts`、`lib/ask-io.js` 的 `rebuildArtifacts`），看它真的执行了什么。
 *   - **零调用不是靠返回值断言**：桩包里的 `tools/ask-server.js` / 桩脚本一旦被
 *     require / spawn 就会**往盘上写一个标记文件** —— 标记不在 = 真的没执行。
 *   - **负向控制**：先在自建临时副本上跑**基线实现**（`ba22c94` 的 `lib/pack-server.js`，
 *     其余 lib/ 不变），留下它**真的 require 了**不匹配引擎的原始输出（标记文件真的出现）；
 *     再证明新实现对同一个包**零 require** 地拒绝。
 *   - 固定用例 ID 集合写在下面 `EXPECTED_IDS` 里：缺一条、多一条、重一条都算失败。
 *
 * ⚠️ 覆盖边界（如实写出来，不冒充 —— 这三条**不在本卡写范围**里，见卡面「落点/写范围」）：
 *   ① **判据里的「id → 400」**：全仓拿 `id` 拼路径后**起服务 / 移目录**的唯一落点是
 *      `lib/pack-template/tools/offline-server.js` 的 `openPack(id)`（:427-444，`spawn`）
 *      与 `removePack(id)`（:464-487，`renameSync`）。**该文件不在本卡写范围**，
 *      所以本卡无法在那里落判据；本卡在**写范围内**把同一套边界落在
 *      「宿主只执行注册表里的脚本」这条上（`T04-REGISTRY-*` + `T04-PATH-*`）。
 *   ② **「含脚本的 ZIP 拒绝导入」**：唯一实现同样在 `offline-server.js` 的 `importZip()`
 *      （:286-354），也不在本卡写范围。本卡**不假装测过它**。
 *   ③ 本卡只验**引擎部分**；D01 全量关闭另需 T05（卡面明写）。
 *
 * 用法：node E:/workplace/dsh-whale-sensei/test/audit/T04.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  createHarness, runChild, makeTempDir, cleanupTempDir, REPO, TEST_DIR, clip,
} from './harness.mjs'

/** 固定用例 ID 集合（**不许漂移**：改了这里就是改了验收面） */
const EXPECTED_IDS = [
  // ① 受信引擎闭包本身：清单覆盖传递依赖 / 与 TEMPLATE_FILES 不漂 / 注册表只引用清单内的件
  'T04-ENGINE-closure-complete',
  'T04-ENGINE-closure-matches-template',
  'T04-ENGINE-required-deps-present',
  'T04-ENGINE-registry-fixed',
  'T04-ENGINE-registry-scripts-in-manifest',
  'T04-ENGINE-trusted-manifest-readonly',
  'T04-ENGINE-manifest-in-template',
  // ② 判据一：执行前核验 —— 不匹配就**零 require / 零 spawn** 地拒绝
  'T04-PREVIEW-reject-untrusted-zero-require',
  'T04-PREVIEW-accept-trusted',
  'T04-PREVIEW-reject-empty-manifest',
  'T04-PREVIEW-reject-missing-file',
  'T04-SPAWN-reject-untrusted-zero-spawn',
  'T04-SPAWN-reject-traversal-path-zero-spawn',
  'T04-SPAWN-reject-absolute-path-zero-spawn',
  'T04-SPAWN-accept-trusted',
  'T04-ANSWER-reject-untrusted-zero-spawn',
  // ③ 拒绝面：nested / ../ / 绝对 id（路径边界）在写范围内可判的那一半
  'T04-PATH-nested-rejected',
  'T04-PATH-dotdot-rejected',
  'T04-PATH-absolute-rejected',
  'T04-PATH-control-char-rejected',
  'T04-PATH-backslash-rejected',
  'T04-PATH-reject-before-spawn-zero-calls',
  // ④ 升级：计划 / 提交 / 备份 / 回滚 / 软链
  'T04-UPGRADE-plan-readonly',
  'T04-UPGRADE-source-is-template-only',
  'T04-UPGRADE-plan-deterministic',
  'T04-UPGRADE-apply-requires-confirm',
  'T04-UPGRADE-apply-requires-digest',
  'T04-UPGRADE-stale-plan-rejected',
  'T04-UPGRADE-backup-before-replace',
  'T04-UPGRADE-backup-failure-no-replace',
  'T04-UPGRADE-apply-adds-missing',
  'T04-UPGRADE-apply-then-verify-ok',
  'T04-UPGRADE-symlink-target-rejected',
  'T04-UPGRADE-rollback-restores',
  'T04-UPGRADE-cli-plan-apply',
  'T04-UPGRADE-cli-apply-without-confirm-refused',
  // ⑤ 负向控制：基线真的执行了不匹配的引擎；新实现零调用
  'T04-NEGCTRL-baseline-requires-untrusted-engine',
  'T04-NEGCTRL-baseline-spawns-synthetic-script',
  'T04-NEGCTRL-new-rejects-what-baseline-executed',
  'T04-NEGCTRL-old-vs-new-marker-diff',
  // ⑥ 回归：写范围外的旧行为不被打破
  'T04-REG-selftest-still-passes',
  'T04-REG-rebuild-job-parity-kept',
  // ⑦ 覆盖边界（**不是通过**：如实记录"本卡没验这两条"，归 T05）
  'T04-BOUNDARY-d01-deferred-to-t05',
  // ⑧ T04-R2 裁定甲：旁路必须**默认严 / 静态可证 / 只落在测试夹具**
  'T04-BYPASS-default-strict-zero-calls',
  'T04-BYPASS-static-only-tests',
  'T04-BYPASS-visibility-list',
]

/** 基线 commit（cards/T04.md 钉的那一个）—— 负向控制取它的三个执行入口 */
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
/**
 * 基线的三个执行入口（本卡在这三处加引擎闸）：
 *   `pack-server.js`（预览 require）、`rebuild-job.js`（重建 spawn）、`ask-io.js`（答疑链 spawn）。
 * 其余 lib/ 与当前相同 —— 所以"旧实现"就是把这几个换回去。
 */
const BASE_FILES = ['lib/pack-server.js', 'lib/rebuild-job.js', 'lib/ask-io.js']
/** 基线只差这一个文件（其余 lib/ 与当前相同），所以"旧实现"就是把它换回去 */
const NODE = process.execPath

const h = createHarness({ card: 'T04', expectedIds: EXPECTED_IDS, root: REPO })
const CASE_DIR = path.join(REPO, 'audit-evidence', 'T04', 'cases')
fs.mkdirSync(CASE_DIR, { recursive: true })

// ---------------------------------------------------------------- 小工具
const both = (r) => String(r?.out ?? '') + String(r?.err ?? '')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const W = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8') }

/** 整棵树快照（内容 + 存在性）—— 比"返回值"硬 |
 *  快照要**跳过备份目录**：升级本来就会往包里写备份，那不是"偷偷改"。 */
function snapTree(root, { skip = /^\.engine-backup-/ } = {}) {
  const out = []
  const walk = (dir, rel) => {
    let es = []
    try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    es.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of es) {
      if (rel === '' && skip.test(e.name)) continue
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

/** 把模板整棵铺进一个目录（**逐字节拷**；与 `test/_fixture.mjs` 的 layTemplate 同一条规矩） */
function layTemplate(root) {
  const T = path.join(REPO, 'lib', 'pack-template')
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else {
        const dst = path.join(root, ...r.split('/'))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(path.join(dir, e.name), dst)
      }
    }
  }
  walk(T)
  return root
}

/** 铺一个"像课程包"的引擎包：模板整棵 + `lessons/` + `presets/`（判据件） */
function layPack(root) {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  layTemplate(root)
  fs.mkdirSync(path.join(root, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(root, 'presets'), { recursive: true })
  return root
}

/** 标记文件路径（桩件一旦被 require / spawn 就写它） */
const markerOf = (root, tag) => path.join(root, `.marker-${tag}`)

/** 把一个引擎件换成"一旦执行就写标记"的桩（同时让它的字节**不再受信**）
 *  ⚠️ 插桩必须插在 **shebang 之后**：`#!/usr/bin/env node` 必须在文件第一行，
 *     插到它前面会让整份文件语法错（基线那次就变成"加载失败"而不是"执行了"）。 */
function tamper(root, rel, marker) {
  const abs = path.join(root, ...rel.split('/'))
  const src = fs.readFileSync(abs, 'utf8')
  const stub = `require('fs').writeFileSync(${JSON.stringify(marker.replace(/\\/g, '/'))}, 'executed', 'utf8')\n`
  const lines = src.split('\n')
  const body = lines[0].startsWith('#!')
    ? [lines[0], stub.trimEnd(), ...lines.slice(1)].join('\n')
    : stub + src
  fs.writeFileSync(abs, body, 'utf8')
  return abs
}

/** 桩脚本：一旦被 spawn 就写标记（`startRebuild` 用） */
function stubScript(root, rel, marker) {
  const abs = path.join(root, ...rel.split('/'))
  W(abs, `require('fs').writeFileSync(${JSON.stringify(marker.replace(/\\/g, '/'))}, 'spawned', 'utf8')\n`)
  return abs
}

/**
 * 本机**能不能用管道 stdio spawn**（`lib/rebuild-job.js` 的 `runAsync` 走的就是它）。
 * 为什么必须探：受限沙箱下 piped stdio 会 EPERM（本仓既有纪律，见 `lib/exec.js`）——
 * 那样"桩脚本没写标记"就**不能**当成"没执行"，整条判据是空的。**如实记红，绝不记 PASS。**
 */
const PIPED_SPAWN = (() => {
  try {
    const r = spawnSync(NODE, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 30000 })
    return { ok: r.status === 0 && String(r.stdout).trim() === 'ok', status: r.status, error: r.error ? String(r.error.message ?? r.error) : null }
  } catch (e) {
    return { ok: false, status: null, error: String(e && e.message ? e.message : e) }
  }
})()

/** spawn 侧判据的**前置**：管道 stdio 不通就没法判"桩脚本有没有被执行" */
function requirePipedSpawn(id) {
  h.evidence(path.join('cases', `${id}-piped-spawn-precheck.txt`),
    `PIPED_SPAWN=${JSON.stringify(PIPED_SPAWN)}\n（受限沙箱下 piped stdio 会 EPERM —— 那时本判据为空，必须记红而不是记绿）\n`)
  h.assert(PIPED_SPAWN.ok, `本机必须能用管道 stdio spawn（否则"零 spawn"判不了）：${JSON.stringify(PIPED_SPAWN)}`)
}

// ---------------------------------------------------------------- 夹具（只在 os.tmpdir 下）
const SANDBOX = makeTempDir('dsh-whale-T04-sandbox')
const PACKS = path.join(SANDBOX, 'packs')
const PACK_OK = layPack(path.join(PACKS, 'ok'))            // 引擎受信（模板整棵）
const PACK_BAD = layPack(path.join(PACKS, 'tampered'))     // app-server 被换过（不可信）
const PACK_SPAWN = layPack(path.join(PACKS, 'spawn'))      // 引擎不可信 + 有桩脚本
const PACK_UP = layPack(path.join(PACKS, 'upgrade'))       // 升级用：先改坏再升回来
const BASE_PLUGIN = path.join(SANDBOX, 'plugin-baseline')
const MARKER_PREVIEW = markerOf(PACK_BAD, 'preview-required')
const MARKER_SPAWN = markerOf(PACK_SPAWN, 'spawned')
const STUB_REL = 'tools/build-notes.js'
const LINK_TARGET = path.join(SANDBOX, 'link-target')

// ① 引擎受信包：把 app-server 的 PORT 改成一个空端口（换端口 = 字节变了，所以另存一份"受信副本"）
const FREE_PORT = (() => {
  // 不真起服务，只挑一个大概率空的端口；真起失败会如实红
  return 32100 + (process.pid % 500)
})()
{
  // ⚠️ 端口要改，但**受信清单是按模板算的** —— 所以改端口的这一份必须**自己造一份清单**。
  //    这里另铺一个"受信包"专门给 `accept-trusted` 用：改端口之后**不动清单**会不可信，
  //    所以那条判据改用**模板原样**的包（端口是模板里的 3091，会被下面用 spawn 的方式避开）。
}

// ② 不可信包：app-server 头部插桩（一旦被 require 就写标记）
tamper(PACK_BAD, 'tools/app-server.js', MARKER_PREVIEW)
tamper(PACK_SPAWN, 'tools/app-server.js', MARKER_PREVIEW)
// ③ 桩脚本：`startRebuild` 会 spawn 的那条（同时让引擎不可信）
stubScript(PACK_SPAWN, STUB_REL, MARKER_SPAWN)

// ④ 升级用包：先改坏一件（再升回来）
tamper(PACK_UP, 'tools/ask-server.js', markerOf(PACK_UP, 'upgrade-tamper'))

// ⑤ 软链夹具：目标件换成目录联接（指向包外）
fs.mkdirSync(LINK_TARGET, { recursive: true })
W(path.join(LINK_TARGET, 'ask-server.js'), '// 包外的假件\n')

// ---------------------------------------------------------------- 基线插件副本（负向控制）
const BASE_READY = (() => {
  try {
    fs.cpSync(path.join(REPO, 'lib'), path.join(BASE_PLUGIN, 'lib'), { recursive: true })
    W(path.join(BASE_PLUGIN, 'package.json'), JSON.stringify({ name: 't04-baseline', type: 'module' }, null, 2) + '\n')
    for (const rel of BASE_FILES) {
      const r = runChild(['git', '-C', REPO, 'show', `${BASE_COMMIT}:${rel}`], { cwd: REPO, timeoutMs: 60000 })
      if (r.code !== 0 || !String(r.out).trim()) {
        return { ok: false, error: `git show ${BASE_COMMIT}:${rel} 失败（exit=${r.code}）：${clip(both(r), 400)}` }
      }
      W(path.join(BASE_PLUGIN, rel), r.out)
    }
    // 反空转：拿到的必须**真的是**旧实现（否则下面的负向控制是空的）
    const same = BASE_FILES.filter((rel) => fs.readFileSync(path.join(BASE_PLUGIN, rel), 'utf8') === fs.readFileSync(path.join(REPO, rel), 'utf8'))
    if (same.length) return { ok: false, error: `基线副本与当前实现逐字节相同（负向控制会打空）：${same.join('、')}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `造基线副本失败：${e && e.message ? e.message : String(e)}` }
  }
})()
if (!BASE_READY.ok) h.block(`负向控制需要基线实现：${BASE_READY.error}`)

// ---------------------------------------------------------------- 载入被测实现
let E = null
try { E = await import(pathToFileURL(path.join(REPO, 'lib', 'engine.js')).href) } catch (e) { h.block(`读不到 lib/engine.js：${e && e.message ? e.message : String(e)}`) }
let PS = null
try { PS = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-server.js')).href) } catch (e) { h.block(`读不到 lib/pack-server.js：${e && e.message ? e.message : String(e)}`) }
let RJ = null
try { RJ = await import(pathToFileURL(path.join(REPO, 'lib', 'rebuild-job.js')).href) } catch (e) { h.block(`读不到 lib/rebuild-job.js：${e && e.message ? e.message : String(e)}`) }
let AIO = null
try { AIO = await import(pathToFileURL(path.join(REPO, 'lib', 'ask-io.js')).href) } catch (e) { h.block(`读不到 lib/ask-io.js：${e && e.message ? e.message : String(e)}`) }
let SC = null
try { SC = await import(pathToFileURL(path.join(REPO, 'lib', 'pack-scaffold.js')).href) } catch (e) { h.block(`读不到 lib/pack-scaffold.js：${e && e.message ? e.message : String(e)}`) }
let RULES = null
try { RULES = await import(pathToFileURL(path.join(TEST_DIR, 'pack-template-rules.mjs')).href) } catch (e) { h.block(`读不到 test/pack-template-rules.mjs：${e && e.message ? e.message : String(e)}`) }

// ---------------------------------------------------------------- 驱动（现场生成，属于本次夹具）
const DRIVER_DIR = path.join(SANDBOX, 'driver')
const DRIVER_PREVIEW = path.join(DRIVER_DIR, 'driver-preview.mjs')
const DRIVER_BASE_PREVIEW = path.join(DRIVER_DIR, 'driver-baseline-preview.mjs')
const DRIVER_BASE_SPAWN = path.join(DRIVER_DIR, 'driver-baseline-spawn.mjs')
const SPY_FILE = path.join(DRIVER_DIR, 'spy.mjs')
const DRIVER_SPAWN = path.join(DRIVER_DIR, 'driver-spawn.mjs')
const DRIVER_ANSWER = path.join(DRIVER_DIR, 'driver-answer.mjs')
const REPO_URL = pathToFileURL(REPO).href
const BASE_URL = pathToFileURL(BASE_PLUGIN).href

/**
 * 预览驱动：`--root=<包根> [--port=N] [--manifest=trusted|self] [--start=1]`
 *   · `--port=N` 把包里 app-server 的 PORT 改掉（避开真服务），`--manifest=self` 按改后的字节
 *     重新造一份清单（这样"引擎受信的包"仍然受信 —— 判的是**字节一致**，不是"必须是模板那一份"）；
 *   · 调**被测实现**的 `ensurePackServer(root)`，把回执原样打出来；
 *   · `--start=1` 真起服务后探一次 `/health`。
 */
const DRIVER_PREVIEW_SRC = `#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const flag = (n) => { const p = '--' + n + '='; const hit = argv.find((a) => a.startsWith(p)); return hit === undefined ? null : hit.slice(p.length) }
const root = flag('root')
const port = flag('port') ? Number(flag('port')) : null
const manifestMode = flag('manifest') || 'trusted'
const wantStart = flag('start') === '1'
const REPO = ${JSON.stringify(REPO_URL)}

const E = await import(REPO + '/lib/engine.js')
const PS = await import(REPO + '/lib/pack-server.js')

if (port) {
  const f = path.join(root, 'tools', 'app-server.js')
  const src = fs.readFileSync(f, 'utf8')
  const next = src.replace(/\\bPORT\\s*=\\s*\\d+/, 'PORT = ' + port)
  fs.writeFileSync(f, next, 'utf8')
}

const manifest = manifestMode === 'self' ? E.buildManifest(root) : E.trustedManifest()
const v = E.verifyEngine(root, manifest)
process.stdout.write('<<<V>>>' + JSON.stringify({ ok: v.ok, missing: v.missing, mismatched: v.mismatched.map((m) => m.path), digest: v.digest }) + '\\n')

const out = await PS.ensurePackServer(root)
process.stdout.write('<<<R>>>' + JSON.stringify(out) + '\\n')

if (wantStart && out.ok) {
  const code = await new Promise((resolve) => {
    let req
    try {
      req = http.get({ host: '127.0.0.1', port: out.port, path: '/health', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode) })
    } catch { resolve(0); return }
    req.on('timeout', () => { try { req.destroy() } catch { /* 已断 */ } resolve(0) })
    req.on('error', () => resolve(0))
  })
  process.stdout.write('health=' + code + '\\n')
  PS.closePackServers()
}
`

/** 基线预览驱动：直接 import **基线副本**的 pack-server.js（负向控制用）
 *  ⚠️ 基线**没有**引擎闸 ⇒ 它会真的 require 并**真的 listen**（`app-server.js` 的 PORT 是 3091）
 *     —— 所以先把端口改成一个空端口，免得这个驱动一直挂着（`ETIMEDOUT`）。 */
const DRIVER_BASE_PREVIEW_SRC = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const BASE = ${JSON.stringify(BASE_URL)}
const root = process.argv[2]
const port = Number(process.argv[3] || 0)
if (port) {
  const f = path.join(root, 'tools', 'app-server.js')
  const src = fs.readFileSync(f, 'utf8')
  fs.writeFileSync(f, src.replace(/\\bPORT\\s*=\\s*\\d+/, 'PORT = ' + port), 'utf8')
}
const mod = await import(BASE + '/lib/pack-server.js')
const out = await mod.ensurePackServer(root)
process.stdout.write('<<<R>>>' + JSON.stringify(out) + '\\n')
mod.closePackServers()
`

/** 基线重建驱动：直接 import **基线副本**的 rebuild-job.js（负向控制用）
 *
 *  ⚠️ 本机（受限沙箱）**piped stdio 的 spawn 会被 EPERM 拒**（本仓既有纪律，见 `lib/exec.js`）——
 *     那时桩脚本**根本没被启动**，标记不会出现，"没写标记"就**不能**当成"没执行"。
 *     所以这个驱动**自报环境**：先探一次 `spawnSync` 管道 stdio；不通就以 **exit 3**
 *     明确说"环境不允许判定"，让判据**如实记红**，绝不记绿。 */
const DRIVER_BASE_SPAWN_SRC = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const BASE = ${JSON.stringify(BASE_URL)}
const root = process.argv[2]

const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 30000 })
const pipedOk = probe.status === 0 && String(probe.stdout).trim() === 'ok'
if (!pipedOk) {
  process.stdout.write('<<<E>>>' + JSON.stringify({
    pipedOk: false,
    status: probe.status,
    error: probe.error ? String(probe.error.message ?? probe.error) : null,
  }) + '\\n')
  process.exit(3)
}

const mod = await import(BASE + '/lib/rebuild-job.js')
const job = mod.startRebuild(root, ['tools/build-notes.js'], { subject: '夹具' })
await mod.waitRebuild(job.id)
process.stdout.write('<<<R>>>' + JSON.stringify({
  pipedOk: true,
  steps: job.steps.length,
  codes: job.steps.map((s) => s.code),
  tails: job.steps.map((s) => s.tail),
  engineError: job.engineError ?? null,
}) + '\\n')
`

W(DRIVER_PREVIEW, DRIVER_PREVIEW_SRC)
W(DRIVER_BASE_PREVIEW, DRIVER_BASE_PREVIEW_SRC)
W(DRIVER_BASE_SPAWN, DRIVER_BASE_SPAWN_SRC)

/**
 * **零调用探针**（`--import` 预加载）：把 `node:child_process` 的 `spawn` / `spawnSync`
 * 换成记账的替身 —— **绝不真起进程**，所以它在**受限沙箱**里也判得了
 * （那里 piped stdio 的 spawn 会被 EPERM 拒，靠"桩脚本有没有写标记"是判不了的）。
 *
 * 为什么用 `--import` 而不是在驱动里打补丁：`lib/rebuild-job.js` → `lib/exec.js` 是
 * **静态 import**，`exec.js` 在模块求值时就把 `spawn` 绑走了；只有**先于它**加载才拦得住。
 */
const SPY_SRC = `import Module from 'node:module'
import { EventEmitter } from 'node:events'

const log = []
const patched = new WeakSet()

/** 把一份 child_process 导出换成记账替身（**绝不真起进程**） */
function wrap(cp) {
  if (!cp || patched.has(cp)) return cp
  patched.add(cp)
  cp.spawn = (cmd, args, opts) => {
    log.push({ kind: 'spawn', cmd: String(cmd), args: (args || []).map(String) })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 0
    child.exitCode = null
    child.kill = () => {}
    process.nextTick(() => child.emit('close', 0))
    return child
  }
  cp.spawnSync = (cmd, args, opts) => {
    log.push({ kind: 'spawnSync', cmd: String(cmd), args: (args || []).map(String) })
    return { pid: 0, status: 0, signal: null, stdout: '', stderr: '', output: [null, '', ''], error: null }
  }
  return cp
}

// ⚠️ 必须在 **ESM 命名绑定被读走之前**就把替身装进 CJS 导出对象：
//    lib/exec.js 是 \`import { spawn, spawnSync } from 'node:child_process'\` ——
//    Node 对内置 CJS 的具名导出走**快照**（求值时就取走），所以只有拦在 \`Module._load\`
//    这一层（即 \`require('child_process')\` 的那一刻）才拦得住。
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const out = origLoad.apply(this, arguments)
  if (request === 'child_process' || request === 'node:child_process') return wrap(out)
  return out
}
wrap(origLoad.call(Module, 'child_process', null, false))

globalThis.__T04_SPAWN_LOG__ = log
globalThis.__T04_SPAWN_COUNT__ = () => log.length
globalThis.__T04_DUMP__ = () => ({ count: log.length, calls: log })
`

/** spawn 驱动：`--root=<包根> [--spy=1] [--pkg=base|new]`
 *  · `--spy=1` 时先加载探针（零真实进程），把调用次数打进回执；
 *  · `--pkg=base` 用**基线副本**的 rebuild-job.js，`new` 用当前实现。 */
const DRIVER_SPAWN_SRC = `#!/usr/bin/env node
const argv = process.argv.slice(2)
const flag = (n) => { const p = '--' + n + '='; const hit = argv.find((a) => a.startsWith(p)); return hit === undefined ? null : hit.slice(p.length) }
const root = flag('root')
const useSpy = flag('spy') === '1'
const pkg = flag('pkg') || 'new'
const BASE = ${JSON.stringify(BASE_URL)}
const REPO = ${JSON.stringify(REPO_URL)}
const SPY = ${JSON.stringify(pathToFileURL(path.join(SANDBOX, 'driver', 'spy.mjs')).href)}

if (useSpy) await import(SPY)
const mod = await import(pkg === 'base' ? BASE + '/lib/rebuild-job.js' : REPO + '/lib/rebuild-job.js')
const job = mod.startRebuild(root, ['tools/build-notes.js'], { subject: '夹具' })
await mod.waitRebuild(job.id)
process.stdout.write('<<<R>>>' + JSON.stringify({
  pkg,
  useSpy,
  steps: job.steps.length,
  codes: job.steps.map((s) => s.code),
  tails: job.steps.map((s) => s.tail),
  engineError: job.engineError ?? null,
  spawnCount: useSpy ? globalThis.__T04_SPAWN_COUNT__() : null,
  spawnCalls: useSpy ? globalThis.__T04_DUMP__() : null,
}) + '\\n')
`

/** 答疑链驱动：同一套探针，走 `lib/ask-io.js` 的 `rebuildArtifacts` */
const DRIVER_ANSWER_SRC = `#!/usr/bin/env node
const argv = process.argv.slice(2)
const flag = (n) => { const p = '--' + n + '='; const hit = argv.find((a) => a.startsWith(p)); return hit === undefined ? null : hit.slice(p.length) }
const root = flag('root')
const useSpy = flag('spy') === '1'
const REPO = ${JSON.stringify(REPO_URL)}
const SPY = ${JSON.stringify(pathToFileURL(path.join(SANDBOX, 'driver', 'spy.mjs')).href)}
if (useSpy) await import(SPY)
const mod = await import(REPO + '/lib/ask-io.js')
const out = mod.rebuildArtifacts(root, ['tools/build-notes.js'], { subject: '夹具' })
process.stdout.write('<<<R>>>' + JSON.stringify({
  steps: out.steps.length,
  engineError: out.engineError ?? null,
  warnings: out.warnings,
  spawnCount: useSpy ? globalThis.__T04_SPAWN_COUNT__() : null,
  spawnCalls: useSpy ? globalThis.__T04_DUMP__() : null,
}) + '\\n')
`

// 驱动与探针落盘（现场生成，属于本次夹具）
W(SPY_FILE, SPY_SRC)
W(DRIVER_SPAWN, DRIVER_SPAWN_SRC)
W(DRIVER_ANSWER, DRIVER_ANSWER_SRC)

/** 落一份子进程的**完整原始输出** */
function keepEvidence(id, r, extra = {}) {
  const text = [
    `# ${id}`,
    `exit=${r.code === null ? 'null(无退出码/崩溃)' : r.code} timedOut=${r.timedOut} ms=${r.ms}`,
    `spawnError=${r.spawnError ?? 'none'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    '--- stdout ---',
    String(r.out ?? ''),
    '--- stderr ---',
    String(r.err ?? ''),
    '',
  ].join('\n')
  h.evidence(path.join('cases', `${id}.txt`), clip(text, 30000))
}

// ================================================================ ① 受信引擎闭包本身
h.case('T04-ENGINE-closure-complete', 'pass', () => {
  // 闭包必须**涵盖传递 require / import 与构建子进程**：拿一组"少一件就跑不动"的关键件核。
  const REQUIRED = [
    'tools/app-server.js',        // 预览入口
    'tools/ask-server.js',        // app-server 的直接依赖
    'tools/lesson-map.js',        // ask-server / build-lessons / build-notes 的依赖
    'tools/pack-text.js',
    'tools/fingerprint.js',
    'tools/drain-questions.js',   // 答疑归档链
    'tools/build-notes.js',
    'tools/build-lessons.js',
    'tools/build-starmap.js',     // build-lessons 的**构建子进程**
    'tools/build-starmap-svg.js', // 重建链
    'tools/build-glossary-tree.js',
    'tools/circle-bands.js',
    'tools/style-adapter.js',
    'assets/build-glossary.js',
    'tools/plan-map.js',
    'tools/title-classes.js',
    'tools/shape-render.js',
    'tools/style-check.js',
    'tools/galaxy-shapes.cjs',
    'starmap/data-layer.js',      // build-starmap-svg 的动态 import
    'tools/engine-policy.cjs',    // 核验自己那一份
  ]
  const missing = REQUIRED.filter((r) => !E.ENGINE_FILES.includes(r))
  h.evidence(path.join('cases', 'T04-ENGINE-closure-complete.txt'), [
    `ENGINE_FILES 共 ${E.ENGINE_FILES.length} 件：\n  ${E.ENGINE_FILES.join('\n  ')}`,
    `关键件里缺的：${missing.join('、') || '（无）'}`,
    `清单里有重复？${new Set(E.ENGINE_FILES).size !== E.ENGINE_FILES.length}`,
    '',
  ].join('\n'))
  h.eq(missing.join('、'), '', `闭包必须涵盖这些关键件（实得缺 ${missing.join('、') || '无'}）`)
  h.eq(new Set(E.ENGINE_FILES).size, E.ENGINE_FILES.length, '清单里不许有重复项')
})

h.case('T04-ENGINE-closure-matches-template', 'pass', () => {
  // 清单里每一件都必须在**模板**里真的存在（清单是"仓内明确代码清单"，不是许愿池）
  const missing = E.ENGINE_FILES.filter((r) => !fs.existsSync(path.join(SC.TEMPLATE_DIR, ...r.split('/'))))
  h.evidence(path.join('cases', 'T04-ENGINE-closure-matches-template.txt'),
    `模板目录：${SC.TEMPLATE_DIR}\n清单 ${E.ENGINE_FILES.length} 件\n模板里缺的：${missing.join('、') || '（无）'}\n`)
  h.eq(missing.join('、'), '', `清单里的每一件都必须在模板里（实得缺 ${missing.join('、') || '无'}）`)
})

h.case('T04-ENGINE-required-deps-present', 'pass', () => {
  // 机械重算闭包：从入口出发跟 require / import（含 `require(path.join(__dirname,…))`、
  // `await import('file:///'+path.join(ROOT,…))`、`spawnSync(process.execPath,[path.join(__dirname,…)])`），
  // 断言算出来的**引擎件**都落在清单里（少一件 = 漏依赖，那正是 D01 的"执行前核验"要挡的）。
  const T = SC.TEMPLATE_DIR
  const ENTRIES = ['tools/app-server.js', 'tools/drain-questions.js', 'tools/build-notes.js',
    'tools/build-lessons.js', 'tools/build-starmap.js', 'tools/build-starmap-svg.js',
    'tools/build-glossary-tree.js', 'tools/circle-bands.js', 'tools/style-adapter.js',
    'assets/build-glossary.js']
  /** 包内数据件（不是引擎代码）：学生写课/加术语会让它们变，核验**故意不管** */
  const DATA = new Set(['assets/glossary-data.js', 'assets/questions-data.js', 'assets/circle-bands-data.js', 'assets/glossary-tree.js', 'starmap/content.js'])
  const depsOf = (src) => {
    const out = new Set()
    for (const re of [/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
      for (const m of src.matchAll(re)) out.add(m[1])
    }
    for (const m of src.matchAll(/path\.join\(\s*__dirname\s*,\s*([^)]*)\)/g)) {
      const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
      if (parts.length) out.add(`__dir__/${parts.join('/')}`)
    }
    for (const m of src.matchAll(/await\s+import\(\s*['"]file:\/\/\/['"]\s*\+\s*path\.join\(\s*[A-Za-z_$][\w$]*\s*,\s*([^)]*)\)/g)) {
      const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
      if (parts.length) out.add(`__root__/${parts.join('/')}`)
    }
    for (const m of src.matchAll(/spawnSync\(\s*process\.execPath\s*,\s*\[\s*path\.join\(\s*__dirname\s*,\s*([^)]*)\)/g)) {
      const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
      if (parts.length) out.add(`__dir__/${parts.join('/')}`)
    }
    return [...out]
  }
  const resolve = (fromRel, spec) => {
    let base = null
    if (spec.startsWith('__dir__/')) base = path.posix.join(path.posix.dirname(fromRel), spec.slice(8))
    else if (spec.startsWith('__root__/')) base = spec.slice(9)
    else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
    else return null
    base = path.posix.normalize(base)
    for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`]) {
      if (DATA.has(c)) return null
      const abs = path.join(T, ...c.split('/'))
      // ⚠️ 必须是**文件**：`path.join(__dirname, '..', 'assets')` 这种会命中一个目录
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return c
    }
    return null
  }
  const closure = new Set(ENTRIES)
  const queue = [...ENTRIES]
  while (queue.length) {
    const rel = queue.shift()
    const abs = path.join(T, ...rel.split('/'))
    if (!fs.existsSync(abs)) continue
    for (const spec of depsOf(fs.readFileSync(abs, 'utf8'))) {
      const dep = resolve(rel, spec)
      if (dep && !closure.has(dep)) { closure.add(dep); queue.push(dep) }
    }
  }
  const missing = [...closure].filter((r) => !E.ENGINE_FILES.includes(r))
  h.evidence(path.join('cases', 'T04-ENGINE-required-deps-present.txt'), [
    `机械重算的引擎闭包 ${closure.size} 件：\n  ${[...closure].sort().join('\n  ')}`,
    `不在 ENGINE_FILES 里的：${missing.join('、') || '（无）'}`,
    `清单里多出来的（不在闭包里）：${E.ENGINE_FILES.filter((r) => !closure.has(r)).join('、') || '（无）'}`,
    '',
  ].join('\n'))
  h.eq(missing.sort().join('、'), '', `重算闭包里的引擎件都必须在清单里（实得缺 ${missing.join('、') || '无'}）`)
})

h.case('T04-ENGINE-registry-fixed', 'pass', () => {
  const ids = E.ENTRY_REGISTRY.map((e) => e.id)
  const expect = ['preview', 'answer', 'notes', 'rebuild', 'glossary']
  h.evidence(path.join('cases', 'T04-ENGINE-registry-fixed.txt'),
    `入口注册表：\n${JSON.stringify(E.ENTRY_REGISTRY, null, 2)}\n`)
  h.eq(ids.join(','), expect.join(','), `入口注册表固定为这五条（实得 ${ids.join(',')}）`)
  for (const e of E.ENTRY_REGISTRY) {
    h.assert(e.kind === 'require' || e.kind === 'spawn', `${e.id} 的 kind 只能是 require/spawn（实得 ${e.kind}）`)
    h.assert(Array.isArray(e.scripts) && e.scripts.length > 0, `${e.id} 必须有脚本清单`)
  }
})

h.case('T04-ENGINE-registry-scripts-in-manifest', 'pass', () => {
  const c = E.checkRegistry()
  h.evidence(path.join('cases', 'T04-ENGINE-registry-scripts-in-manifest.txt'),
    `checkRegistry = ${JSON.stringify(c)}\n注册表引用到的脚本：\n  ${E.registryScripts().join('\n  ')}\n`)
  h.assert(c.ok === true, `注册表只许引用受信清单里的脚本（实得 ${JSON.stringify(c)}）`)
})

h.case('T04-ENGINE-trusted-manifest-readonly', 'pass', () => {
  const before = snapTree(SC.TEMPLATE_DIR)
  const m1 = E.trustedManifest()
  const m2 = E.trustedManifest()
  const after = snapTree(SC.TEMPLATE_DIR)
  h.evidence(path.join('cases', 'T04-ENGINE-trusted-manifest-readonly.txt'), [
    `受信清单 ok=${m1.ok} 件数=${m1.files.length} digest=${m1.digest}`,
    `两次算的 digest 相同？${m1.digest === m2.digest}`,
    `模板树前后相同？${before === after}`,
    `空清单会被拒？${JSON.stringify(E.verifyEngine(PACK_OK, { files: [] }))}`,
    '',
  ].join('\n'))
  h.assert(m1.ok === true, `模板自己必须是受信的（实得 missing=${m1.missing.join('、')}）`)
  h.eq(m1.digest, m2.digest, '同样的输入必须同样摘要（纯函数）')
  h.eq(after, before, '算清单**只读**：模板树一个字节都不许变')
  const empty = E.verifyEngine(PACK_OK, { files: [] })
  h.assert(empty.ok === false, '空清单必须被拒（不许"什么都不核验就放行"）')
})

h.case('T04-ENGINE-manifest-in-template', 'pass', () => {
  const rel = 'tools/engine-policy.cjs'
  const inRuntime = SC.TEMPLATE_FILES.includes(rel)
  const inRules = RULES.templatePaths().includes(rel)
  const a = [...SC.TEMPLATE_FILES].sort().join('\n')
  const b = [...RULES.templatePaths()].sort().join('\n')
  const text = fs.existsSync(path.join(SC.TEMPLATE_DIR, rel)) ? fs.readFileSync(path.join(SC.TEMPLATE_DIR, rel), 'utf8') : ''
  const DRIVE = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"`)]*/g
  const SYSTEM_OK = /^[A-Za-z]:\\{1,2}(Program|Windows)\b/i
  const driveHits = [...text.matchAll(DRIVE)].map((m) => m[0]).filter((m) => !SYSTEM_OK.test(m))
  h.evidence(path.join('cases', 'T04-ENGINE-manifest-in-template.txt'), [
    `TEMPLATE_FILES 里有？${inRuntime}（共 ${SC.TEMPLATE_FILES.length} 项）`,
    `templatePaths() 里有？${inRules}（共 ${RULES.templatePaths().length} 项）`,
    `两份清单一致？${a === b}`,
    `模板件里的机器专属路径：${driveHits.join('、') || '（无）'}`,
    `模板件里有 workplace / dsh-raw-html-v2？${/workplace|dsh-raw-html-v2/i.test(text)}`,
    '',
  ].join('\n'))
  h.assert(inRuntime, `运行时清单必须有 ${rel}`)
  h.assert(inRules, `规则清单必须有 ${rel}`)
  h.eq(a === b, true, '两份清单不许漂')
  h.eq(driveHits.length, 0, `模板件里不许有机器专属路径（实得 ${driveHits.join('、') || '无'}）`)
  h.eq(/workplace|dsh-raw-html-v2/i.test(text), false, '模板件里不许出现作者机器的目录名 / 兄弟仓名')
})

// ================================================================ ② 执行前核验（零调用）
h.case('T04-PREVIEW-reject-untrusted-zero-require', 'pass', () => {
  fs.rmSync(MARKER_PREVIEW, { force: true })
  const before = snapTree(PACK_BAD)
  const v = E.verifyEngine(PACK_BAD, E.trustedManifest())
  const r = runChild([NODE, DRIVER_PREVIEW, `--root=${PACK_BAD}`], { cwd: REPO, timeoutMs: 120000 })
  keepEvidence('T04-PREVIEW-reject-untrusted-zero-require', r, { pack: PACK_BAD, marker: MARKER_PREVIEW, verify: JSON.stringify({ ok: v.ok, mismatched: v.mismatched.map((m) => m.path) }) })
  const after = snapTree(PACK_BAD)
  h.assert(r.code === 0, `驱动子进程要正常收场（exit=${r.code}；${clip(String(r.err), 300)}）`)
  h.assert(v.ok === false, '前置：这个包的引擎必须**不可信**（否则这条判据是空的）')
  h.eq(fs.existsSync(MARKER_PREVIEW), false, '**零 require**：桩件一旦被 require 就会写标记，标记必须不存在')
  h.eq(after, before, '整棵树一个字节都不许变')
  const out = both(r)
  h.assert(/engine/.test(out) || /引擎/.test(out), `回执里必须说清是引擎不匹配（实得 ${clip(out, 300)}）`)
})

h.case('T04-PREVIEW-accept-trusted', 'pass', () => {
  // "正常课件仍可浏览"：引擎受信的包必须真的能起预览服务（`/health` 真答 200）
  // ⚠️ 端口要改（避开真服务），所以清单按**改后的字节**重新造一份 —— 判的是"字节一致"，
  //    不是"必须是模板那一份"（`--manifest=self`）。
  const tmp = path.join(SANDBOX, 'preview-ok')
  layPack(tmp)
  const port = 32100 + (process.pid % 300)
  const r = runChild([NODE, DRIVER_PREVIEW, `--root=${tmp}`, `--port=${port}`, '--manifest=self', '--start=1'], { cwd: REPO, timeoutMs: 180000 })
  keepEvidence('T04-PREVIEW-accept-trusted', r, { pack: tmp, port })
  h.eq(r.code, 0, `驱动要正常收场（exit=${r.code}；${clip(String(r.err), 400)}）`)
  const out = both(r)
  h.assert(/"ok":true/.test(out), `引擎受信的包必须能起预览服务（实得 ${clip(out, 400)}）`)
  h.assert(/health=200/.test(out), `/health 必须真的答 200（实得 ${clip(out, 400)}）`)
})

h.case('T04-PREVIEW-reject-empty-manifest', 'pass', () => {
  const empty = E.verifyEngine(PACK_OK, { files: [] })
  const noFiles = E.verifyEngine(PACK_OK, {})
  h.evidence(path.join('cases', 'T04-PREVIEW-reject-empty-manifest.txt'),
    `空 files：${JSON.stringify(empty)}\n没有 files：${JSON.stringify(noFiles)}\n`)
  h.assert(empty.ok === false && /空清单/.test(empty.error), `空清单必须拒（实得 ${JSON.stringify(empty)}）`)
  h.assert(noFiles.ok === false, '没有 files 的清单必须拒')
})

h.case('T04-PREVIEW-reject-missing-file', 'pass', () => {
  const tmp = path.join(SANDBOX, 'missing')
  layPack(tmp)
  fs.rmSync(path.join(tmp, 'tools', 'ask-server.js'), { force: true })
  const v = E.verifyEngine(tmp, E.trustedManifest())
  h.evidence(path.join('cases', 'T04-PREVIEW-reject-missing-file.txt'), JSON.stringify(v, null, 2) + '\n')
  h.assert(v.ok === false, '缺件必须拒')
  h.assert(v.missing.some((m) => m.startsWith('tools/ask-server.js')), `missing 要点名缺的那一件（实得 ${v.missing.join('、')}）`)
})

h.case('T04-SPAWN-reject-untrusted-zero-spawn', 'pass', () => {
  // 判"零 spawn"**不靠标记文件**（受限沙箱里 spawn 本身就 EPERM，标记根本不成立），
  // 而是**把 child_process.spawn 换成记账替身**（`--import` 预加载，先于 lib/exec.js 求值）——
  // 它记的是"这份实现有没有真的去 spawn"，与沙箱许不许 spawn 无关。
  fs.rmSync(MARKER_SPAWN, { force: true })
  const job = RJ.startRebuild(PACK_SPAWN, [STUB_REL], { subject: '夹具' })
  const r = runChild([NODE, DRIVER_SPAWN, `--root=${PACK_SPAWN}`, '--spy=1', '--pkg=new'], { cwd: REPO, timeoutMs: 120000 })
  const rec = (() => { const m = /<<<R>>>(\{.*\})/.exec(both(r)); try { return m ? JSON.parse(m[1]) : null } catch { return null } })()
  keepEvidence('T04-SPAWN-reject-untrusted-zero-spawn', r, { pack: PACK_SPAWN, marker: MARKER_SPAWN })
  h.evidence(path.join('cases', 'T04-SPAWN-reject-untrusted-zero-spawn-inproc.txt'), [
    `进程内（同一进程直接调 startRebuild）job=${JSON.stringify({ done: job.done, steps: job.steps.length, engineError: clip(job.engineError, 200) })}`,
    `子进程（探针）：spawnCount=${rec ? rec.spawnCount : 'n/a'} calls=${JSON.stringify(rec ? rec.spawnCalls : null)}`,
    `标记文件在？${fs.existsSync(MARKER_SPAWN)}`,
    '',
  ].join('\n'))
  h.eq(job.done, true, '被拒的作业要**立刻**是完成态（不排进程）')
  h.eq(job.steps.length, 0, '零 spawn：steps 必须为空')
  h.assert(typeof job.engineError === 'string' && job.engineError.length > 0, '必须给出 engineError（人话修法）')
  h.assert(rec != null, `要拿到探针回执（实得 ${clip(both(r), 300)}）`)
  h.eq(rec.spawnCount, 0, `**探针记账：spawn/spawnSync 零调用**（实得 ${JSON.stringify(rec.spawnCalls)}）`)
  h.eq(fs.existsSync(MARKER_SPAWN), false, '标记必须不存在（本机 spawn 通的话这条也成立）')
})

h.case('T04-SPAWN-reject-traversal-path-zero-spawn', 'pass', () => {
  fs.rmSync(MARKER_SPAWN, { force: true })
  const job = RJ.startRebuild(PACK_SPAWN, ['../../../evil.js'], { subject: '夹具' })
  h.evidence(path.join('cases', 'T04-SPAWN-reject-traversal-path-zero-spawn.txt'),
    `job=${JSON.stringify({ done: job.done, steps: job.steps.length, badPaths: job.badPaths, engineError: job.engineError })}\n标记在？${fs.existsSync(MARKER_SPAWN)}\n`)
  h.eq(job.steps.length, 0, '`../` 路径必须零 spawn')
  h.assert(job.badPaths && job.badPaths.some((b) => /\.\./.test(b)), `理由要点到目录穿越（实得 ${JSON.stringify(job.badPaths)}）`)
  h.eq(fs.existsSync(MARKER_SPAWN), false, '标记必须不存在')
})

h.case('T04-SPAWN-reject-absolute-path-zero-spawn', 'pass', () => {
  const job = RJ.startRebuild(PACK_SPAWN, ['C:/Windows/Temp/evil.js'], { subject: '夹具' })
  const job2 = RJ.startRebuild(PACK_SPAWN, ['/etc/evil.js'], { subject: '夹具' })
  h.evidence(path.join('cases', 'T04-SPAWN-reject-absolute-path-zero-spawn.txt'),
    `windows=${JSON.stringify({ steps: job.steps.length, badPaths: job.badPaths })}\nposix=${JSON.stringify({ steps: job2.steps.length, badPaths: job2.badPaths })}\n`)
  h.eq(job.steps.length, 0, '盘符绝对路径必须零 spawn')
  h.eq(job2.steps.length, 0, 'POSIX 绝对路径必须零 spawn')
  h.assert(job.badPaths.some((b) => /绝对路径/.test(b)), '理由要点到绝对路径')
})

h.case('T04-SPAWN-accept-trusted', 'pass', () => {
  // 引擎受信 → 闸**放行**，spawn 真的发生（探针记账 ≥ 1）。与上面那条"零调用"配成一对：
  // 一条证明"该跑的真的跑了"，一条证明"不该跑的零调用"——两条都在同一套探针下。
  const tmp = path.join(SANDBOX, 'spawn-ok')
  layPack(tmp)
  const r = runChild([NODE, DRIVER_SPAWN, `--root=${tmp}`, '--spy=1', '--pkg=new'], { cwd: REPO, timeoutMs: 120000 })
  const rec = (() => { const m = /<<<R>>>(\{.*\})/.exec(both(r)); try { return m ? JSON.parse(m[1]) : null } catch { return null } })()
  keepEvidence('T04-SPAWN-accept-trusted', r, { pack: tmp })
  h.assert(rec != null, `要拿到探针回执（实得 ${clip(both(r), 300)}）`)
  h.eq(rec.steps, 1, `受信包里那条脚本要被真的跑一遍（实得 steps=${rec.steps}）`)
  h.assert(rec.spawnCount >= 1, `引擎受信时必须真的 spawn（实得 spawnCount=${rec.spawnCount}）`)
  h.eq(rec.engineError, null, '受信时不该有 engineError')
  // 反向：把同一件换掉 → 立刻变不可信（证明闸判的是**字节**）
  stubScript(tmp, 'tools/build-notes.js', markerOf(tmp, 'ran'))
  const trusted = E.verifyEngine(tmp, E.trustedManifest())
  h.evidence(path.join('cases', 'T04-SPAWN-accept-trusted-bytes.txt'),
    `换掉 tools/build-notes.js 之后 verify.ok=${trusted.ok} mismatched=${trusted.mismatched.map((m) => m.path).join('、')}\n`)
  h.assert(trusted.ok === false, '换掉一件之后必须判不可信（否则"字节一致"这条判据是空的）')
  h.assert(trusted.mismatched.some((m) => m.path === 'tools/build-notes.js'), 'mismatched 要点名被换的那一件')
})

h.case('T04-ANSWER-reject-untrusted-zero-spawn', 'pass', () => {
  fs.rmSync(MARKER_SPAWN, { force: true })
  const out = AIO.rebuildArtifacts(PACK_SPAWN, [STUB_REL], { subject: '夹具' })
  const r = runChild([NODE, DRIVER_ANSWER, `--root=${PACK_SPAWN}`, '--spy=1'], { cwd: REPO, timeoutMs: 120000 })
  const rec = (() => { const m = /<<<R>>>(\{.*\})/.exec(both(r)); try { return m ? JSON.parse(m[1]) : null } catch { return null } })()
  keepEvidence('T04-ANSWER-reject-untrusted-zero-spawn', r, { pack: PACK_SPAWN })
  h.evidence(path.join('cases', 'T04-ANSWER-reject-untrusted-zero-spawn-inproc.txt'),
    `进程内 rebuild=${JSON.stringify(out.rebuild)} steps=${out.steps.length} engineError=${clip(out.engineError, 200)}\n子进程探针 spawnCount=${rec ? rec.spawnCount : 'n/a'}\n`)
  h.eq(out.steps.length, 0, '答疑归档链也必须零 spawn')
  h.assert(typeof out.engineError === 'string' && out.engineError.length > 0, '必须给出 engineError')
  h.assert(/重建没起/.test(out.warnings[0] || ''), `告警措辞要说明"重建没起"（实得 ${out.warnings[0]}）`)
  h.assert(rec != null, `要拿到探针回执（实得 ${clip(both(r), 300)}）`)
  h.eq(rec.spawnCount, 0, `**探针记账：答疑链 spawn/spawnSync 零调用**（实得 ${JSON.stringify(rec.spawnCalls)}）`)
  h.eq(fs.existsSync(MARKER_SPAWN), false, '标记必须不存在')
})

// ================================================================ ③ 路径边界（拒绝面）
h.case('T04-PATH-nested-rejected', 'pass', () => {
  const bad = ['tools/../tools/app-server.js', 'a/b/../../c.js', 'tools//../x.js']
  const rows = bad.map((s) => `${JSON.stringify(s)} → ${JSON.stringify(RJ.checkScriptPath(s))}`)
  h.evidence(path.join('cases', 'T04-PATH-nested-rejected.txt'), rows.join('\n') + '\n')
  for (const s of bad) h.assert(RJ.checkScriptPath(s).ok === false, `nested/.. 路径必须拒：${s}`)
})

h.case('T04-PATH-dotdot-rejected', 'pass', () => {
  const bad = ['../evil.js', '..\\evil.js', 'tools/../../evil.js', '..']
  const rows = bad.map((s) => `${JSON.stringify(s)} → ${JSON.stringify(RJ.checkScriptPath(s))}`)
  h.evidence(path.join('cases', 'T04-PATH-dotdot-rejected.txt'), rows.join('\n') + '\n')
  for (const s of bad) h.assert(RJ.checkScriptPath(s).ok === false, `含 .. 的路径必须拒：${s}`)
})

h.case('T04-PATH-absolute-rejected', 'pass', () => {
  const bad = ['/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '\\\\server\\share\\x.js']
  const rows = bad.map((s) => `${JSON.stringify(s)} → ${JSON.stringify(RJ.checkScriptPath(s))}`)
  h.evidence(path.join('cases', 'T04-PATH-absolute-rejected.txt'), rows.join('\n') + '\n')
  for (const s of bad) h.assert(RJ.checkScriptPath(s).ok === false, `绝对路径必须拒：${s}`)
})

h.case('T04-PATH-control-char-rejected', 'pass', () => {
  const s = 'tools/build\u0000notes.js'
  const r = RJ.checkScriptPath(s)
  h.evidence(path.join('cases', 'T04-PATH-control-char-rejected.txt'), `${JSON.stringify(s)} → ${JSON.stringify(r)}\n`)
  h.assert(r.ok === false && /控制字符/.test(r.error), `NUL 必须拒（实得 ${JSON.stringify(r)}）`)
})

h.case('T04-PATH-backslash-rejected', 'pass', () => {
  const s = 'tools\\build-notes.js'
  const r = RJ.checkScriptPath(s)
  h.evidence(path.join('cases', 'T04-PATH-backslash-rejected.txt'), `${JSON.stringify(s)} → ${JSON.stringify(r)}\n`)
  h.assert(r.ok === false && /反斜杠/.test(r.error), `反斜杠必须拒（实得 ${JSON.stringify(r)}）`)
})

h.case('T04-PATH-reject-before-spawn-zero-calls', 'pass', () => {
  // 零调用要**能证明**：桩脚本 + 不可信引擎，两种拒绝理由各跑一次，标记都不许出现
  fs.rmSync(MARKER_SPAWN, { force: true })
  const a = RJ.startScripts(PACK_SPAWN, [STUB_REL], { subject: '夹具' })
  const b = AIO.rebuildArtifacts(PACK_SPAWN, [STUB_REL], { subject: '夹具' })
  const c = RJ.startRebuild(PACK_SPAWN, [STUB_REL], { subject: '夹具' })
  h.evidence(path.join('cases', 'T04-PATH-reject-before-spawn-zero-calls.txt'), [
    `startScripts → job=${a.job === null ? 'null' : a.job.id} engineError=${a.engineError}`,
    `rebuildArtifacts → steps=${b.steps.length} engineError=${b.engineError}`,
    `startRebuild → steps=${c.steps.length} engineError=${c.engineError}`,
    `标记文件在？${fs.existsSync(MARKER_SPAWN)}`,
    '',
  ].join('\n'))
  h.eq(a.job, null, 'startScripts 必须不起作业')
  h.eq(b.steps.length, 0, 'rebuildArtifacts 必须零 spawn')
  h.eq(c.steps.length, 0, 'startRebuild 必须零 spawn')
  h.eq(fs.existsSync(MARKER_SPAWN), false, '**三处都零调用**：标记必须不存在')
})

// ================================================================ ④ 升级
h.case('T04-UPGRADE-plan-readonly', 'pass', () => {
  const tmp = path.join(SANDBOX, 'plan-ro')
  layPack(tmp)
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  const before = snapTree(tmp)
  const plan = E.planEngineUpgrade(tmp)
  const after = snapTree(tmp)
  h.evidence(path.join('cases', 'T04-UPGRADE-plan-readonly.txt'),
    `plan=${JSON.stringify({ ok: plan.ok, files: plan.files.map((f) => f.path), digest: plan.planDigest })}\n树前后相同？${before === after}\n`)
  h.assert(plan.ok === true, `计划要算得出来（实得 ${plan.error}）`)
  h.eq(after, before, '算计划**只读**：包树一个字节都不许变')
  h.assert(plan.files.some((f) => f.path === 'tools/ask-server.js'), '计划要点名被改坏的那一件')
})

h.case('T04-UPGRADE-source-is-template-only', 'pass', () => {
  const plan = E.planEngineUpgrade(PACK_UP)
  const src = fs.readFileSync(path.join(REPO, 'tools', 'upgrade-pack.mjs'), 'utf8')
  // "不接受任意来源路径"的结构证据：只认 `--root` / `--plan` / `--apply` / `--confirm` /
  // `--plan-digest` / `--json` / `--help` 这几个开关，**没有** `--from=<路径>` 这类入口。
  const FLAGS = [...src.matchAll(/args\[['"]([^'"]+)['"]\]/g)].map((m) => m[1])
  const FROMISH = FLAGS.filter((f) => /^(from|source|src|origin|template|tpl|input)$/i.test(f))
  h.evidence(path.join('cases', 'T04-UPGRADE-source-is-template-only.txt'), [
    `plan.source=${plan.source}`,
    `模板目录=${SC.TEMPLATE_DIR}`,
    `CLI 读的开关：${[...new Set(FLAGS)].join('、')}`,
    `"任意来源"类开关：${FROMISH.join('、') || '（无）'}`,
    `CLI 里有 --from= / --source= 这种字面量吗？${/--from=|--source=/.test(src)}`,
    '',
  ].join('\n'))
  h.eq(path.resolve(plan.source), path.resolve(SC.TEMPLATE_DIR), '升级源只能是插件模板')
  h.eq(FROMISH.join('、'), '', `CLI 不许有"任意来源路径"的开关（实得 ${FROMISH.join('、') || '无'}）`)
})

h.case('T04-UPGRADE-plan-deterministic', 'pass', () => {
  const a = E.planEngineUpgrade(PACK_UP)
  const b = E.planEngineUpgrade(PACK_UP)
  const tmp = path.join(SANDBOX, 'plan-det')
  layPack(tmp)
  const c = E.planEngineUpgrade(tmp)
  h.evidence(path.join('cases', 'T04-UPGRADE-plan-deterministic.txt'),
    `同包两次：${a.planDigest === b.planDigest}\n受信包 digest=${c.planDigest} upToDate=${c.upToDate}\n不可信包 digest=${a.planDigest}\n`)
  h.eq(a.planDigest, b.planDigest, '同一个包两次算的摘要必须相同')
  h.assert(a.planDigest !== c.planDigest, '不同状态的两个包摘要必须不同（否则摘要没覆盖现况）')
  h.eq(c.upToDate, true, '受信包的 upToDate 必须是 true')
})

h.case('T04-UPGRADE-apply-requires-confirm', 'pass', () => {
  const plan = E.planEngineUpgrade(PACK_UP)
  const before = snapTree(PACK_UP)
  const r = E.applyEngineUpgrade(PACK_UP, { confirm: false, planDigest: plan.planDigest })
  const after = snapTree(PACK_UP)
  h.evidence(path.join('cases', 'T04-UPGRADE-apply-requires-confirm.txt'), `result=${JSON.stringify(r)}\n树前后相同？${before === after}\n`)
  h.assert(r.ok === false && /确认/.test(r.error), `没 confirm 必须拒（实得 ${JSON.stringify(r)}）`)
  h.eq(after, before, '没 confirm 时一个字节都不许动')
})

h.case('T04-UPGRADE-apply-requires-digest', 'pass', () => {
  const before = snapTree(PACK_UP)
  const r = E.applyEngineUpgrade(PACK_UP, { confirm: true, planDigest: '' })
  const after = snapTree(PACK_UP)
  h.evidence(path.join('cases', 'T04-UPGRADE-apply-requires-digest.txt'), `result=${JSON.stringify(r)}\n树前后相同？${before === after}\n`)
  h.assert(r.ok === false && /计划摘要/.test(r.error), `没 digest 必须拒（实得 ${JSON.stringify(r)}）`)
  h.eq(after, before, '没 digest 时一个字节都不许动')
})

h.case('T04-UPGRADE-stale-plan-rejected', 'pass', () => {
  const tmp = path.join(SANDBOX, 'stale')
  layPack(tmp)
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't1'))
  const plan = E.planEngineUpgrade(tmp)
  // 计划算完之后包又变了（学生/别的进程动了引擎件）→ 提交必须拒
  fs.appendFileSync(path.join(tmp, 'tools', 'build-notes.js'), '\n// 计划算完之后又改了\n', 'utf8')
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest })
  h.evidence(path.join('cases', 'T04-UPGRADE-stale-plan-rejected.txt'),
    `plan.digest=${plan.planDigest}\nresult=${JSON.stringify(r)}\n当下重算=${E.planEngineUpgrade(tmp).planDigest}\n`)
  h.assert(r.ok === false && /过期|对不上/.test(r.error), `过期计划必须拒（实得 ${JSON.stringify(r)}）`)
})

h.case('T04-UPGRADE-backup-before-replace', 'pass', () => {
  const tmp = path.join(SANDBOX, 'backup')
  layPack(tmp)
  const origAsk = fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js'))
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  const tampered = fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js'))
  const plan = E.planEngineUpgrade(tmp)
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest })
  const backupAsk = r.backupDir ? path.join(r.backupDir, 'tools', 'ask-server.js') : null
  const backupBytes = backupAsk && fs.existsSync(backupAsk) ? fs.readFileSync(backupAsk) : null
  h.evidence(path.join('cases', 'T04-UPGRADE-backup-before-replace.txt'), [
    `result=${JSON.stringify({ ok: r.ok, replaced: r.replaced, added: r.added, backupDir: r.backupDir })}`,
    `备份里的 ask-server.js 与"升级前"逐字节相同？${backupBytes ? backupBytes.equals(tampered) : '（没有备份）'}`,
    `备份里的 ask-server.js 与"原始模板"相同？${backupBytes ? backupBytes.equals(origAsk) : '（没有备份）'}`,
    `升级后包里的 ask-server.js 与模板相同？${fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js')).equals(origAsk)}`,
    '',
  ].join('\n'))
  h.assert(r.ok === true, `升级要成功（实得 ${r.error}）`)
  h.assert(backupAsk && fs.existsSync(backupAsk), '必须先备份被替换的件')
  h.assert(backupBytes.equals(tampered), '备份的必须是**升级前**的字节（不是模板那份）')
  h.assert(fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js')).equals(origAsk), '替换后的字节必须就是模板那份')
})

h.case('T04-UPGRADE-backup-failure-no-replace', 'pass', () => {
  // 备份失败**不得替换**：把"备份目录的落点"占成一个**同名文件**，`mkdirSync` 就会失败
  const tmp = path.join(SANDBOX, 'backup-fail')
  layPack(tmp)
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  const plan = E.planEngineUpgrade(tmp)
  const before = snapTree(tmp)
  // 把计划摘要钉死，然后用一个**固定的 now** 去撞那个同名文件
  const stamp = '9999999999999'
  const blocker = path.join(tmp, `.engine-backup-${stamp}`)
  W(blocker, '这个文件故意占着备份目录的落点\n')
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest, now: () => Number(stamp) })
  const after = snapTree(tmp)
  h.evidence(path.join('cases', 'T04-UPGRADE-backup-failure-no-replace.txt'), [
    `result=${JSON.stringify({ ok: r.ok, error: r.error, replaced: r.replaced, added: r.added, rolledBack: r.rolledBack })}`,
    `树前后相同？${before === after}`,
    `被替换的件还是"升级前"的字节？${fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js'), 'utf8').includes('writeFileSync')}`,
    '',
  ].join('\n'))
  h.assert(r.ok === false, `备份失败必须如实拒绝（实得 ${JSON.stringify(r)}）`)
  h.eq(after, before, '备份失败时**一件都不许替换**（树一个字节不变）')
})

h.case('T04-UPGRADE-apply-adds-missing', 'pass', () => {
  const tmp = path.join(SANDBOX, 'add-missing')
  layPack(tmp)
  fs.rmSync(path.join(tmp, 'tools', 'engine-policy.cjs'), { force: true })
  const plan = E.planEngineUpgrade(tmp)
  const isAdd = plan.files.find((f) => f.path === 'tools/engine-policy.cjs')
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest })
  h.evidence(path.join('cases', 'T04-UPGRADE-apply-adds-missing.txt'),
    `plan 项=${JSON.stringify(isAdd)}\nresult=${JSON.stringify({ ok: r.ok, added: r.added, replaced: r.replaced })}\n文件在？${fs.existsSync(path.join(tmp, 'tools', 'engine-policy.cjs'))}\n`)
  h.assert(isAdd && isAdd.action === 'add', '缺件在计划里必须是 add')
  h.assert(r.ok === true && r.added.includes('tools/engine-policy.cjs'), `升级要把缺的补上（实得 ${JSON.stringify(r.added)}）`)
  h.assert(fs.existsSync(path.join(tmp, 'tools', 'engine-policy.cjs')), '补完之后文件必须真的在')
})

h.case('T04-UPGRADE-apply-then-verify-ok', 'pass', () => {
  const tmp = path.join(SANDBOX, 'apply-verify')
  layPack(tmp)
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  fs.rmSync(path.join(tmp, 'tools', 'engine-policy.cjs'), { force: true })
  const v0 = E.verifyEngine(tmp, E.trustedManifest())
  const plan = E.planEngineUpgrade(tmp)
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest })
  const v1 = E.verifyEngine(tmp, E.trustedManifest())
  h.evidence(path.join('cases', 'T04-UPGRADE-apply-then-verify-ok.txt'),
    `升级前 ok=${v0.ok}（mismatched=${v0.mismatched.map((m) => m.path).join('、')} missing=${v0.missing.join('、')}）\n升级 ok=${r.ok}\n升级后 ok=${v1.ok}（missing=${v1.missing.join('、')} mismatched=${v1.mismatched.map((m) => m.path).join('、')}）\n`)
  h.assert(v0.ok === false, '前置：升级前必须不可信')
  h.assert(r.ok === true, `升级要成功（实得 ${r.error}）`)
  h.assert(v1.ok === true, `升级后必须核验通过（实得 missing=${v1.missing.join('、')} mismatched=${v1.mismatched.map((m) => m.path).join('、')}）`)
})

h.case('T04-UPGRADE-symlink-target-rejected', 'pass', () => {
  const tmp = path.join(SANDBOX, 'symlink')
  layPack(tmp)
  const target = path.join(tmp, 'tools', 'ask-server.js')
  const linkTargetDir = path.join(SANDBOX, 'link-target')
  fs.rmSync(target, { recursive: true, force: true })
  let linkMade = false
  try {
    fs.symlinkSync(linkTargetDir, target, 'junction')
    linkMade = fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()
  } catch { linkMade = false }
  if (!linkMade) {
    // 造不出目录联接 → 这条判据在**本机**是空的：如实报 BLOCKED（绝不记 PASS）
    h.evidence(path.join('cases', 'T04-UPGRADE-symlink-target-rejected.txt'), '本机造不出目录联接（junction）—— 判据为空\n')
    h.block('本机造不出目录联接（Windows junction），软链目标拒绝这条判据无法执行')
  }
  const plan = E.planEngineUpgrade(tmp)
  const rejected = plan.files.find((f) => f.path === 'tools/ask-server.js')
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest })
  const stillLink = fs.lstatSync(target).isSymbolicLink()
  h.evidence(path.join('cases', 'T04-UPGRADE-symlink-target-rejected.txt'), [
    `linkMade=${linkMade}`,
    `plan 项=${JSON.stringify(rejected)}`,
    `apply=${JSON.stringify({ ok: r.ok, error: r.error })}`,
    `升级后仍是软链？${stillLink}`,
    '',
  ].join('\n'))
  h.assert(rejected && rejected.action === 'reject', '软链目标在计划里必须标 reject')
  h.assert(r.ok === false && /软链/.test(r.error), `软链目标必须拒（实得 ${JSON.stringify(r)}）`)
  h.assert(stillLink, '被拒之后那个链接不许被动过')
  fs.rmSync(target, { recursive: true, force: true })
})

h.case('T04-UPGRADE-rollback-restores', 'pass', () => {
  const tmp = path.join(SANDBOX, 'rollback')
  layPack(tmp)
  const origAsk = fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js'))
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  const tampered = fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js'))
  const plan = E.planEngineUpgrade(tmp)
  const r = E.applyEngineUpgrade(tmp, { confirm: true, planDigest: plan.planDigest })
  const rb = E.rollbackEngineUpgrade(tmp, { confirm: true, backupDir: r.backupDir })
  const back = fs.readFileSync(path.join(tmp, 'tools', 'ask-server.js'))
  h.evidence(path.join('cases', 'T04-UPGRADE-rollback-restores.txt'), [
    `apply=${JSON.stringify({ ok: r.ok, backupDir: r.backupDir })}`,
    `rollback=${JSON.stringify(rb)}`,
    `回滚后与"升级前"逐字节相同？${back.equals(tampered)}`,
    `回滚后与模板相同？${back.equals(origAsk)}`,
    '',
  ].join('\n'))
  h.assert(r.ok === true, '前置：升级要成功')
  h.assert(rb.ok === true, `回滚要成功（实得 ${JSON.stringify(rb)}）`)
  h.assert(back.equals(tampered), '回滚后必须是**升级前**的字节')
})

h.case('T04-UPGRADE-cli-plan-apply', 'pass', () => {
  const tmp = path.join(SANDBOX, 'cli')
  layPack(tmp)
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  const p = runChild([NODE, path.join(REPO, 'tools', 'upgrade-pack.mjs'), `--root=${tmp}`, '--plan'], { cwd: REPO, timeoutMs: 120000 })
  const m = /digest=([0-9a-f]{64})/.exec(both(p))
  const digest = m ? m[1] : ''
  const a = runChild([NODE, path.join(REPO, 'tools', 'upgrade-pack.mjs'), `--root=${tmp}`, '--apply', '--confirm', `--plan-digest=${digest}`], { cwd: REPO, timeoutMs: 120000 })
  keepEvidence('T04-UPGRADE-cli-plan-apply-plan', p, { digest })
  keepEvidence('T04-UPGRADE-cli-plan-apply-apply', a, { digest })
  h.eq(p.code, 0, `--plan 要成功（exit=${p.code}；${clip(both(p), 300)}）`)
  h.assert(/^PLAN ok=true digest=[0-9a-f]{64} files=\d+$/m.test(both(p)), `--plan 的 stdout 契约（实得 ${clip(both(p), 200)}）`)
  h.eq(a.code, 0, `--apply 要成功（exit=${a.code}；${clip(both(a), 300)}）`)
  h.assert(/^APPLY ok=true digest=[0-9a-f]{64}/m.test(both(a)), `--apply 的 stdout 契约（实得 ${clip(both(a), 200)}）`)
  h.assert(E.verifyEngine(tmp, E.trustedManifest()).ok === true, 'CLI 跑完必须核验通过')
})

h.case('T04-UPGRADE-cli-apply-without-confirm-refused', 'pass', () => {
  const tmp = path.join(SANDBOX, 'cli-noconfirm')
  layPack(tmp)
  tamper(tmp, 'tools/ask-server.js', markerOf(tmp, 't'))
  const before = snapTree(tmp)
  const r = runChild([NODE, path.join(REPO, 'tools', 'upgrade-pack.mjs'), `--root=${tmp}`, '--apply', '--plan-digest=deadbeef'], { cwd: REPO, timeoutMs: 120000 })
  const after = snapTree(tmp)
  keepEvidence('T04-UPGRADE-cli-apply-without-confirm-refused', r, {})
  h.assert(r.code === 1, `缺 --confirm 必须 exit 1（实得 ${r.code}）`)
  h.assert(/^FAIL /m.test(both(r)), `必须打 FAIL 一行（实得 ${clip(both(r), 200)}）`)
  h.eq(after, before, '被拒时一个字节都不许动')
})

// ================================================================ ⑤ 负向控制
h.case('T04-NEGCTRL-baseline-requires-untrusted-engine', 'pass', () => {
  // 基线（ba22c94 的 pack-server.js）会**直接 require** 包里的 app-server.js —— 桩件写标记
  const tmp = path.join(SANDBOX, 'neg-preview')
  layPack(tmp)
  const marker = markerOf(tmp, 'baseline-required')
  tamper(tmp, 'tools/app-server.js', marker)
  const r = runChild([NODE, DRIVER_BASE_PREVIEW, tmp, String(32200 + (process.pid % 200))], { cwd: REPO, timeoutMs: 120000 })
  keepEvidence('T04-NEGCTRL-baseline-requires-untrusted-engine', r, { pack: tmp, marker })
  h.eq(r.code, 0, `基线驱动要正常收场（exit=${r.code}；${clip(String(r.err), 300)}）`)
  h.eq(fs.existsSync(marker), true, '**基线必须真的执行了**不匹配的引擎（标记文件必须出现）—— 这正是 D01 要挡的')
})

h.case('T04-NEGCTRL-baseline-spawns-synthetic-script', 'pass', () => {
  // 基线没有任何引擎核验 ⇒ 桩脚本会被真的 spawn。用**同一套探针**记账（不依赖沙箱许不许 spawn）：
  // 基线的 spawnCount 必须 ≥ 1，新实现的必须是 0 —— 差异就是"核验"本身。
  const tmp = path.join(SANDBOX, 'neg-spawn')
  layPack(tmp)
  const marker = markerOf(tmp, 'baseline-spawned')
  stubScript(tmp, 'tools/build-notes.js', marker)
  const rb = runChild([NODE, DRIVER_SPAWN, `--root=${tmp}`, '--spy=1', '--pkg=base'], { cwd: REPO, timeoutMs: 120000 })
  const rn = runChild([NODE, DRIVER_SPAWN, `--root=${tmp}`, '--spy=1', '--pkg=new'], { cwd: REPO, timeoutMs: 120000 })
  const pick = (r) => { const m = /<<<R>>>(\{.*\})/.exec(both(r)); try { return m ? JSON.parse(m[1]) : null } catch { return null } }
  const base = pick(rb); const neu = pick(rn)
  keepEvidence('T04-NEGCTRL-baseline-spawns-synthetic-script-baseline', rb, { pack: tmp, marker })
  keepEvidence('T04-NEGCTRL-baseline-spawns-synthetic-script-new', rn, { pack: tmp })
  h.evidence(path.join('cases', 'T04-NEGCTRL-baseline-spawns-synthetic-script.txt'), [
    `基线（探针）=${JSON.stringify(base)}`,
    `新实现（探针）=${JSON.stringify(neu)}`,
    `标记文件（本机 spawn 通的话才有）在？${fs.existsSync(marker)}`,
    '',
  ].join('\n'))
  h.assert(base != null && neu != null, `两次都要拿到探针回执（base=${clip(both(rb), 200)} / new=${clip(both(rn), 200)}）`)
  h.assert(base.spawnCount >= 1, `**基线必须真的去 spawn**（实得 spawnCount=${base.spawnCount}；调用=${JSON.stringify(base.spawnCalls)}）`)
  h.eq(base.engineError, null, '基线没有引擎闸（不该有 engineError）')
  h.eq(neu.spawnCount, 0, `新实现必须零调用（实得 ${neu.spawnCount}）`)
})

h.case('T04-NEGCTRL-new-rejects-what-baseline-executed', 'pass', () => {
  // 同一批输入换成新实现：零调用地拒（标记不许出现），且树一个字节不变
  const tmp = path.join(SANDBOX, 'neg-new')
  layPack(tmp)
  const markerP = markerOf(tmp, 'new-preview')
  const markerS = markerOf(tmp, 'new-spawn')
  tamper(tmp, 'tools/app-server.js', markerP)
  stubScript(tmp, 'tools/build-notes.js', markerS)
  const before = snapTree(tmp)
  const job = RJ.startRebuild(tmp, ['tools/build-notes.js'], { subject: '夹具' })
  const art = AIO.rebuildArtifacts(tmp, ['tools/build-notes.js'], { subject: '夹具' })
  const after = snapTree(tmp)
  h.evidence(path.join('cases', 'T04-NEGCTRL-new-rejects-what-baseline-executed.txt'), [
    `startRebuild steps=${job.steps.length} engineError=${clip(job.engineError, 200)}`,
    `rebuildArtifacts steps=${art.steps.length} engineError=${clip(art.engineError, 200)}`,
    `标记（preview）在？${fs.existsSync(markerP)}`,
    `标记（spawn）在？${fs.existsSync(markerS)}`,
    `树前后相同？${before === after}`,
    '',
  ].join('\n'))
  h.eq(job.steps.length, 0, '新实现：零 spawn')
  h.eq(art.steps.length, 0, '新实现：零 spawn（答疑链）')
  h.eq(fs.existsSync(markerP), false, '新实现：零 require')
  h.eq(fs.existsSync(markerS), false, '新实现：零 spawn')
  h.eq(after, before, '新实现跑完树一个字节不变')
})

h.case('T04-NEGCTRL-old-vs-new-marker-diff', 'pass', () => {
  // 一条**对照**判据：同一个桩包，基线写标记、新实现不写 —— 差异就是"核验"本身
  const tmp = path.join(SANDBOX, 'neg-diff')
  layPack(tmp)
  const marker = markerOf(tmp, 'diff')
  tamper(tmp, 'tools/app-server.js', marker)
  const rb = runChild([NODE, DRIVER_BASE_PREVIEW, tmp, String(32400 + (process.pid % 200))], { cwd: REPO, timeoutMs: 120000 })
  const baseWrote = fs.existsSync(marker)
  fs.rmSync(marker, { force: true })
  const rn = runChild([NODE, DRIVER_PREVIEW, `--root=${tmp}`], { cwd: REPO, timeoutMs: 120000 })
  const newWrote = fs.existsSync(marker)
  keepEvidence('T04-NEGCTRL-old-vs-new-marker-diff-baseline', rb, { baseWrote })
  keepEvidence('T04-NEGCTRL-old-vs-new-marker-diff-new', rn, { newWrote })
  h.eq(baseWrote, true, '基线写标记（它执行了）')
  h.eq(newWrote, false, '新实现不写标记（它没执行）')
})

// ================================================================ ⑥ 回归
h.case('T04-REG-selftest-still-passes', 'pass', () => {
  const r = runChild([NODE, path.join(TEST_DIR, 'all.mjs'), '--selftest'], { cwd: REPO, timeoutMs: 300000 })
  keepEvidence('T04-REG-selftest-still-passes', r, {})
  h.eq(r.code, 0, `all.mjs --selftest 必须仍全绿（exit 0），实际 ${r.code}`)
  h.assert(/selftest: 17 通过 \/ 0 失败/.test(both(r)), 'selftest 仍是 17/17（判据面不许悄悄少几条）')
})

h.case('T04-REG-rebuild-job-parity-kept', 'pass', () => {
  // 双实现对拍的**措辞**必须仍然同源：引擎闸拒掉时，同步版与异步版给的是同一句告警
  const tmp = path.join(SANDBOX, 'parity')
  layPack(tmp)
  const sync_ = AIO.rebuildArtifacts(tmp, ['tools/build-notes.js'], { subject: '圆圈' })
  const job = RJ.startRebuild(tmp, ['tools/build-notes.js'], { subject: '圆圈' })
  h.evidence(path.join('cases', 'T04-REG-rebuild-job-parity-kept.txt'),
    `同步版 warnings=${JSON.stringify(sync_.warnings)}\n异步版 warnings=${JSON.stringify(job.warnings)}\n`)
  h.eq(JSON.stringify(job.warnings), JSON.stringify(sync_.warnings), '引擎闸拒掉时两份实现的告警必须**逐字相同**')
})

h.case('T04-BOUNDARY-d01-deferred-to-t05', 'pass', () => {
  // ⚠️ T04-R1（裁定 B）：**覆盖边界归档** —— 判据原文里有两条**不在本卡写范围**里，
  //    本卡**没有验证**它们，归 **T05**（它的落点就是 offline-server.js，判据原文完全相同）。
  //    这一节**不计入"通过"**（它是边界声明，不是判据），也不让判词假绿：
  //    它只断言"边界声明确实存在、且点名了正确的落点与行号"，以及"那两条判据在本卡写范围内没有落点"。
  const OFF = path.join(SC.TEMPLATE_DIR, 'tools', 'offline-server.js')
  const src = fs.existsSync(OFF) ? fs.readFileSync(OFF, 'utf8') : ''
  const hasImportZip = /function\s+importZip\s*\(/.test(src)
  const hasOpenPack = /async\s+function\s+openPack\s*\(/.test(src)
  const hasRemovePack = /async\s+function\s+removePack\s*\(/.test(src)
  const spawnNear = /spawn\(process\.execPath/.test(src)
  const renameNear = /fs\.renameSync\(/.test(src)
  // 本卡写范围内（落点清单）有没有这两条判据的落点？
  // ⚠️ 只看**真正实现 ZIP 导入**的写法（`importZip` / 解压子进程），不看注释里提一句 `.zip`
  const IN_SCOPE = ['lib/pack-server.js', 'lib/rebuild-job.js', 'lib/ask-io.js', 'lib/pack-scaffold.js',
    'test/pack-template-rules.mjs', 'lib/engine.js', 'lib/pack-template/tools/engine-policy.cjs',
    'tools/upgrade-pack.mjs', 'test/audit/T04.mjs']
  const zipHits = []
  for (const rel of IN_SCOPE) {
    const p = path.join(REPO, ...rel.split('/'))
    if (!fs.existsSync(p)) continue
    const t = fs.readFileSync(p, 'utf8')
    if (/function\s+importZip\s*\(/.test(t) || /spawnSync\(\s*TAR\b/.test(t) || /'-\s*xf'/.test(t)) zipHits.push(rel)
  }
  const zipInScope = zipHits.length > 0
  const boundary = [
    '# T04 覆盖边界（T04-R1 裁定 B）：D01 的这两条**不在本卡写范围**，归 T05',
    '',
    '## 判据原文（cards/T04.md）',
    '「nested/`../`/绝对 id 均 400且 spawn/rename 零调用；含上述脚本的 ZIP 拒绝导入；正常课件仍可浏览。」',
    '',
    '## 结论：T04 **未验证**下面两条（不冒充、不计入 passed）',
    '1. 「含引擎脚本的 ZIP 拒绝导入」',
    '2. 「nested / `../` / 绝对 id → 400 且 spawn / rename 零调用」',
    '',
    '## 为什么（实测落点）',
    `- ZIP 导入的唯一实现：lib/pack-template/tools/offline-server.js 的 importZip()（在？${hasImportZip}）—— **不在 T04 写范围**。`,
    `- 拿 id 拼路径后**起服务 / 移目录**的唯一实现：同文件的 openPack()（在？${hasOpenPack}，内部 spawn：${spawnNear}）与 removePack()（在？${hasRemovePack}，内部 renameSync：${renameNear}）—— 同样**不在 T04 写范围**。`,
    `- 本卡写范围内存在 ZIP 导入实现？${zipInScope}（false = 这两条在本卡里确实没有落点）。`,
    '',
    '## 归谁',
    '- 归 **T05**：它的落点就是 lib/pack-template/tools/offline-server.js，判据原文与 T04 这两条完全相同。',
    '- D01 的**全量关闭以 T05 为准**（cards/T04.md 自己写着「本卡只验证引擎部分，D01 全量关闭另需 T05」）。',
    '',
    '## T04 在写范围内做到的那一半',
    '- 引擎闭包核验（预览 require 前 / 重建与答疑 spawn 前）—— 见本文件 ①②③ 节；',
    '- 「宿主只执行注册表里的脚本」+ 共享路径边界（绝对 / `..` / 反斜杠 / 控制字符一律拒）—— 见 ③ 节；',
    '- 「正常课件仍可浏览」—— 见 T04-PREVIEW-accept-trusted。',
    '',
  ].join('\n')
  h.evidence('coverage-boundary-T05.md', boundary)
  h.evidence(path.join('cases', 'T04-BOUNDARY-d01-deferred-to-t05.txt'), [
    `offline-server.js 在？${fs.existsSync(OFF)}`,
    `importZip 在？${hasImportZip} / openPack 在？${hasOpenPack} / removePack 在？${hasRemovePack}`,
    `spawn 在？${spawnNear} / renameSync 在？${renameNear}`,
    `本卡写范围内有 ZIP 导入实现？${zipInScope}`,
    `边界声明落盘：audit-evidence/T04/coverage-boundary-T05.md`,
    '',
  ].join('\n'))
  h.assert(fs.existsSync(OFF), `判据落点必须在（${OFF}）`)
  h.assert(hasImportZip && hasOpenPack && hasRemovePack, 'ZIP 导入与 openPack/removePack 必须仍在 offline-server.js（那是 T05 的落点）')
  h.eq(zipInScope, false, '本卡写范围内**没有** ZIP 导入实现（所以这条判据在本卡没有落点）')
  h.assert(/T05/.test(boundary) && /offline-server\.js/.test(boundary) && /未验证/.test(boundary),
    '边界声明必须点名 T05 / offline-server.js / "未验证"')
})

// ================================================================ ⑧ T04-R2：旁路必须默认严
/** 递归收集 `dir` 下的源码文件（跳过 node_modules / .git） */
function walkSources(dir, rel = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkSources(path.join(dir, e.name), r))
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(r)
  }
  return out
}

h.case('T04-BYPASS-default-strict-zero-calls', 'pass', () => {
  // 裁定甲的硬约束 ④：**不传该开关时，桩包必须被拒、且 spawn/require 零调用**
  // —— 旁路不得把默认路径的判据冲掉。用 ② 节那套"记账探针"再证一次（不传开关）。
  const tmp = path.join(SANDBOX, 'bypass-default')
  layPack(tmp)
  const marker = markerOf(tmp, 'bypass-default')
  stubScript(tmp, 'tools/build-notes.js', marker)
  fs.rmSync(marker, { force: true })
  // ① 进程内：不传开关 → 被拒、零 spawn
  const job = RJ.startRebuild(tmp, ['tools/build-notes.js'], { subject: '夹具' })
  const art = AIO.rebuildArtifacts(tmp, ['tools/build-notes.js'], { subject: '夹具' })
  // ② 子进程探针：不传开关 → spawnCount 必须 0（`driver-spawn.mjs` 默认 pkg=new、不传旁路）
  const r = runChild([NODE, DRIVER_SPAWN, `--root=${tmp}`, '--spy=1', '--pkg=new'], { cwd: REPO, timeoutMs: 120000 })
  const rec = (() => { const m = /<<<R>>>(\{.*\})/.exec(both(r)); try { return m ? JSON.parse(m[1]) : null } catch { return null } })()
  keepEvidence('T04-BYPASS-default-strict-zero-calls', r, { pack: tmp, marker })
  h.evidence(path.join('cases', 'T04-BYPASS-default-strict-zero-calls-inproc.txt'), [
    `不传开关：startRebuild steps=${job.steps.length} engineError=${clip(job.engineError, 160)}`,
    `不传开关：rebuildArtifacts steps=${art.steps.length} engineError=${clip(art.engineError, 160)}`,
    `不传开关（子进程探针）：spawnCount=${rec ? rec.spawnCount : 'n/a'}`,
    `标记文件在？${fs.existsSync(marker)}`,
    '',
  ].join('\n'))
  h.eq(job.steps.length, 0, '**默认严**：不传开关时零 spawn')
  h.assert(typeof job.engineError === 'string' && job.engineError.length > 0, '不传开关时必须给出 engineError')
  h.eq(art.steps.length, 0, '**默认严**：答疑链不传开关时零 spawn')
  h.assert(rec != null, `要拿到探针回执（实得 ${clip(both(r), 200)}）`)
  h.eq(rec.spawnCount, 0, `**默认严**：子进程探针 spawnCount 必须 0（实得 ${rec && rec.spawnCount}）`)
  h.eq(fs.existsSync(marker), false, '标记必须不存在')
})

h.case('T04-BYPASS-static-only-tests', 'pass', () => {
  // 裁定甲的硬约束 ③：全仓 `lib/**` 里 `trustedEngine` 只许出现在
  //   ① 参数声明 / 默认值处；② `hctx` 透传那一行；**没有任何生产调用点传 false**。
  const libDir = path.join(REPO, 'lib')
  const files = walkSources(libDir, 'lib')
  const hits = []
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/trustedEngine/.test(line)) return
      hits.push({ rel, line: i + 1, text: line.trim() })
    })
  }
  // 允许的形状（**只有这几类**）：
  //   ① 参数声明 / 默认值 / 文档注释：`trustedEngine = true` / `@param ... trustedEngine` / 行注释
  //   ② hctx 透传那一行：`trustedEngine: hctx?.trustedEngine !== false`（create / author / note 各一处）
  //   ③ **闸内部的判断**：`if (trustedEngine === false) return ...`（那是旁路的实现，不是调用点传 false）
  //   ④ **模块自带 `--selftest` 的合成包上下文**：`trustedEngine: false`（它跑的是合成包，不是真包）
  const isDecl = (t) => /trustedEngine\s*=\s*true/.test(t) || /^\s*(\*|\/\/)/.test(t) || /@param/.test(t)
  /** hctx 透传那一行（键值形 `trustedEngine: hctx?...` 或位置实参形 `..., hctx?.trustedEngine !== false)`） */
  const isPassthrough = (t) => /trustedEngine:\s*hctx\?\.trustedEngine\s*!==\s*false/.test(t) || /,\s*hctx\?\.trustedEngine\s*!==\s*false\s*\)/.test(t)
  /** `startScripts` 把 opts 里的开关原样转发给闸（也是"透传"，不是"传 false"） */
  const isOptsForward = (t) => /trustedEngine:\s*opts\.trustedEngine\s*!==\s*false/.test(t)
  const isGuard = (t) => /if\s*\(\s*trustedEngine\s*===\s*false\s*\)/.test(t)
  const isForward = (t) => /trustedEngine[,}\s]*$/.test(t) || /trustedEngine\s*\}/.test(t) || /trustedEngine\s*\)/.test(t) || /\{\s*trustedEngine\s*\}/.test(t) || /trustedEngine:\s*trustedEngine/.test(t)
  /** `lib/mods/note.js` 的 `--selftest` 合成包上下文（**该文件自带的自检**，不是生产调用点） */
  const isSelftestCtx = (t, rel) => rel === 'lib/mods/note.js' && /^\s*trustedEngine:\s*false,\s*$/.test(t)
  const offenders = hits.filter((h) => !(isDecl(h.text) || isPassthrough(h.text) || isOptsForward(h.text) || isGuard(h.text) || isForward(h.text) || isSelftestCtx(h.text, h.rel)))
  const passthroughFiles = [...new Set(hits.filter((h) => isPassthrough(h.text)).map((h) => h.rel))]
  // ⚠️ "生产调用点传 false" 只数**传参**（`trustedEngine: false`）且**不是注释**的行；
  //    另外排除 `lib/mods/note.js` 的 `--selftest` 合成包上下文（那是该文件自带的自检，
  //    不是生产 hctx —— 生产 hctx 上没有这个字段，见上面的 hctx 透传那一行）。
  const isComment = (t) => /^\s*(\*|\/\/|\/\*)/.test(t)
  const falseInProd = hits.filter((h) => /trustedEngine\s*:\s*false/.test(h.text) && !isComment(h.text) && !isSelftestCtx(h.text, h.rel))
  h.evidence(path.join('cases', 'T04-BYPASS-static-only-tests.txt'), [
    `lib/** 里提到 trustedEngine 的行（${hits.length} 条）：`,
    ...hits.map((h) => `  ${h.rel}:${h.line}  ${h.text}`),
    '',
    `hctx 透传那一行出现在：${passthroughFiles.join('、') || '（无）'}`,
    `生产代码里**传参** false 的行：${falseInProd.length ? falseInProd.map((h) => `${h.rel}:${h.line}`).join('、') : '（无）'}`,
    `不合形状的行：${offenders.length ? offenders.map((h) => `${h.rel}:${h.line}`).join('、') : '（无）'}`,
    '',
  ].join('\n'))
  h.eq(falseInProd.length, 0, `**生产调用点一个都不许传 false**（实得 ${falseInProd.map((h) => `${h.rel}:${h.line}`).join('、') || '无'}）`)
  h.eq(offenders.length, 0, `lib/** 里的 trustedEngine 只许出现在参数声明 / 默认值 / hctx 透传 / 闸内判断 / 自带 --selftest（实得 ${offenders.map((h) => `${h.rel}:${h.line}`).join('、') || '无'}）`)
  h.eq(passthroughFiles.sort().join('、'), 'lib/mods/author.js、lib/mods/create.js、lib/mods/note.js', `hctx 透传只许在这三个文件各一处（实得 ${passthroughFiles.join('、')}）`)
})

h.case('T04-BYPASS-visibility-list', 'pass', () => {
  // 裁定甲的硬约束 ⑦：列出"哪些文件传了这个开关"，缺一即红（防以后滥用）。
  const LIST = [
    'test/rebuild-job.mjs',
    'test/rebuild-wiring.mjs',
    'test/circle-delete.mjs',
    'test/ask-answer.mjs',
    // `lib/mods/note.js` 的**自带 --selftest**（合成包，不是真包）—— 不是测试文件，但要登记
    'lib/mods/note.js',
  ]
  const rows = []
  for (const rel of LIST) {
    const p = path.join(REPO, ...rel.split('/'))
    const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    const n = (t.match(/trustedEngine\s*:\s*false/g) || []).length
    rows.push(`${rel}  trustedEngine:false × ${n}`)
  }
  // 反向：全仓还有谁传了 false（不许有清单外的）。
  // ⚠️ 本文件自己会**提到**这个开关（判据与清单），所以排除 `test/audit/T04.mjs` 自身。
  const all = []
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'audit-evidence') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue }
      if (!/\.(js|cjs|mjs)$/.test(e.name)) continue
      if (r === 'test/audit/T04.mjs') continue
      const t = fs.readFileSync(path.join(dir, e.name), 'utf8')
      // 只看**代码行**（注释里写"trustedEngine:false = 旁路"不算传参）
      const code = t.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      if (/trustedEngine\s*:\s*false/.test(code)) all.push(r)
    }
  }
  walk(REPO)
  const outside = all.filter((r) => !LIST.includes(r))
  h.evidence(path.join('cases', 'T04-BYPASS-visibility-list.txt'), [
    '清单（本卡授权传 trustedEngine:false 的文件）：',
    ...rows,
    '',
    `全仓实际传 false 的文件（${all.length}）：${all.join('、') || '（无）'}`,
    `清单外的：${outside.join('、') || '（无）'}`,
    '',
  ].join('\n'))
  for (const rel of LIST) {
    h.assert(all.includes(rel), `${rel} 必须在清单里且真的传了 trustedEngine:false`)
  }
  h.eq(outside.join('、'), '', `清单外不许有人传这个开关（实得 ${outside.join('、') || '无'}）`)
})

// ---------------------------------------------------------------- 收尾：清理夹具
{
  const notes = []
  const c = cleanupTempDir(SANDBOX, 'T04-sandbox')
  notes.push(`${SANDBOX} removed=${c.removed}${c.error ? ` err=${c.error}` : ''}`)
  h.note(notes.join('\n'))
}

process.exit(h.run())
