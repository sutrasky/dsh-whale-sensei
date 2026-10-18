/**
 * test/audit/T22.mjs — 安装配置修改可逆 + 始终同一 home + YAML 形状（报告 G02 · P1 · T22-R1 + T22-R2）
 * ==========================================================================================
 * 卡面判据（**原文**）：「嵌套/引号/inline样例不产生重复键；patch后、preset后、add后分别故障，
 * 所有目标存在性与内容恢复；fake dsh与patch/preset用同一个home。」
 * 本卡（T22-R1）把范围收在**事务可逆 + 同一 home**：YAML 形状那半边归 T22-R2。
 *
 * 本壳只做一件事：把这条判据变成**能失败**的机械检查。所以它：
 *   ① 夹具全在 `E:\Temp\whale-T22-R1-*`：临时 home（`profiles\web-t22r1\package.json` +
 *      `cordis.patch.yml` + `pnpm-lock.yaml`）、临时 `DSH_PLUGIN_BACKUP`、临时 PATH 上的
 *      fake `dsh.cmd` / `node.cmd`（各把 DSH_HOME 环境值、收到的 `--dsh-home`、argv、cwd
 *      **追加**进同一份 JSONL 日志）。fake 命令**先被单独调用一次**，证明"日志为空"不是空转（K04）。
 *      夹具 profile 名故意**不是** `web`：安装器的候选表会去 `~\.dsh` 找 `profiles\<name>`，
 *      叫 `web` 时它会撞上真 profile —— 那是本卡明令零改动的东西。
 *   ② 每次跑安装器都走 **PowerShell 5.1**，并经夹具内一个包装脚本把重定向 stdout 固定成 UTF-8，
 *      并在安装器返回后打印**外层**看到的 `DSH_HOME`（H03 的判据就是外层那个值）。
 *   ③ fake `node` 就是 `lib/preset-install.js` 的替身：按收到的 `--dsh-home` 把模板落成
 *      `<home>\.agent-presets\whale-mode\{agent.cordis.yml,preset.yml}`（H04 才核得到"真落盘"），
 *      并受 `FAKE_NODE_FAIL` 控制；fake `dsh` 受 `FAKE_DSH_FAIL` / `FAKE_DSH_TARGETS_INCOMPLETE` /
 *      `FAKE_DSH_OCCUPY_TARGET` 控制，`plugin add` 会**真的**改 profile `package.json` 与
 *      `pnpm-lock.yaml`（否则"恢复字节"就是空转）。
 *      ⚠️ 假命令有一根**保险丝**：解析出来的 home 不在本次夹具根之下就拒绝动手（绝不碰真 home）。
 *   ④ "恢复没恢复"用**内容差分**判（相对路径 + 类型 + 字节哈希），不靠 stdout 说了什么；
 *      V05 再把 `Restore-InstallPlan` 打桩成空操作跑一遍，证明 V01–V03 真的会红（反空转）。
 *   ⑤ `R11`/`R12` 直接 import 两个模块并**与 T22 之前那次提交（钉死的 revision，不是会漂移的 HEAD）的字节对拍** —— 本批一个字节都没改它们。
 *
 * 一行判词：`PASS T22 checks=32 failed=0 skipped=0` / `FAIL T22 …` exit1 / `BLOCKED T22 …` exit2。
 * 固定用例 ID 集合见 EXPECTED_IDS（T22-R1 的 25 条 + T22-R2 新增的 7 条 Y01–Y07 = 32；缺 / 多 / 重都算失败）。
 *
 * T22-R2（第二批，只做 YAML 形状）：`YAML_SHAPE_TABLE` 是两侧**唯一权威**形状表 ——
 * PS 侧 `install-whale-sensei.ps1#Test-PatchedYmlShape` ↔ JS 侧 `lib/profile-packroot.js#checkPackRootYml`；
 * 接受 ⇒ 就地改（replace/insert/append），拒绝 ⇒ **写前**一个字节都不写。
 * ⚠️ 为满足卡面 §3.2/§3.4（同一文件新增导出 + 修 id 识别），R11 里"整份 profile-packroot.js
 *    与 HEAD 逐字节相同"被换成**逐函数更严**的表述 —— 详见 R11 的注释，没有任何判据被放宽。
 *
 * ⚠️ 风险如实记录（卡面自带）：本批"同一 home"的结论是在**夹具 + fake 命令**下得出的，
 *    **不是**真机 `dsh plugin add` 的现场结论；真实宿主集成验证仍是**未做项**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHarness, REPO, EVIDENCE_DIR, clip } from './harness.mjs'

const CARD = 'T22'
/**
 * 卡面写集里的证据目录是 `audit-evidence/T22-R1/**`（本批是修正卡 T22-R1）——
 * 不写 `audit-evidence/T22/`（那是**原卡**的落点，里面还放着派发文档，本批不许碰）。
 */
const CARD_EVIDENCE = path.join(EVIDENCE_DIR, 'T22-R1')
const TMP_BASE = 'E:\\Temp'
const INSTALLER = path.join(REPO, 'install-whale-sensei.ps1')
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const LIVE_PACK = 'E:\\workplace\\study'
const SNAPSHOT_DIR = 'C:\\Users\\bouyer\\Documents\\deepseek-harness\\default-workspace\\audit-handoff\\dsh-whale-sensei\\extracted\\dsh-whale-sensei'
/** 夹具 profile 名：**不能**叫 web（会撞上真 `~\.dsh\profiles\web`） */
const PROF = 'web-t22r1'

const EXPECTED_IDS = [
  'K01 parse-5.1-after-t22',
  'K02 bom-and-lf-preserved',
  'K03 patch-write-no-bom',
  'K04 fixture-shape',
  'K05 normal-install-target-entry-via-config',
  'K06 normal-install-not-a-second-config-key',
  'R01 writes-carry-home-and-version',
  'R02 restore-plan-restores-bytes',
  'R03 restore-plan-removes-not-existed',
  'R04 recovery-failed-keeps-material-and-exits-nonzero',
  'R05 add-targets-unenumerable-refuses-transaction',
  'R06 preset-tree-in-writes',
  'H01 same-home-dsh-and-node',
  'H02 same-home-when-caller-home-differs',
  'H03 finally-restores-caller-environment',
  'H04 preset-lands-in-same-home',
  'V01 failure-after-patch-restores',
  'V02 failure-after-preset-restores',
  'V03 failure-after-add-restores',
  'V04 no-success-claim-on-failure',
  'V05 restore-failure-keeps-material',
  'R11 profile-packroot-return-shapes-intact',
  'R12 preset-install-actions-intact',
  'R13 existing-suites-green',
  'C03 fixture-discipline',
  'Y01 yaml-shape-table-accept-cases',
  'Y02 yaml-quoted-id-recognised',
  'Y03 yaml-reject-inline-target-config',
  'Y04 yaml-reject-ambiguous-nesting',
  'Y05 yaml-reject-duplicate-id-sections',
  'Y06 yaml-reject-non-scalar-id',
  'Y07 ps1-and-js-same-verdicts',
]

const h = createHarness({ card: CARD, evidenceDir: CARD_EVIDENCE, expectedIds: EXPECTED_IDS, root: LIVE_PACK })
const ev = (name, text) => h.evidence(path.join('cases', `${name}.txt`), String(text).endsWith('\n') ? String(text) : `${text}\n`)

h.note(
  'ID 集合：派发文档 §E 与卡面 §4 的**正文**都写"26 条"，但 §4 的代码块与 §4.1 逐条列举实为 **25** 条' +
    '（K01–K06 六条 + R01–R06 六条 + H01–H04 四条 + V01–V05 五条 + R11/R12/R13 三条 + C03 一条 = 25）。' +
    '按"固定用例 ID 全集不许漂移 / 逐字照做"实现那 25 条，判词 checks=25。' +
    '**规划者已在收口时追认 25 为正确口径**（卡面与专属事实 §E 标题已就地更正，不追补第 26 条）：' +
    '与 T21 同一种算术落差（那里正文写 32、实列 31，同样按 31 收口）。既没有多造 ID，也没有把任何一条并进别的用例。'
)

h.note(
  'T22-R2（第二批）把同一个入口从 25 条**追加**到 32 条（新增 Y01–Y07；T22-R1 的 25 条一条都没删、没并、没改 ID）。'
    + '其中 R11 的"整份 profile-packroot.js 与 HEAD 逐字节相同"一条，因卡面 §3.2/§3.4 明令改那个文件，'
    + '改成**逐函数更严**的表述（不是放宽：另外两个函数的函数体仍必须与 HEAD 逐字节相同，'
    + 'patchPackRootYml 的签名/返回形状/行为照旧逐条判）。'
)

// ───────────────────────────────────────────────────────── 通用小工具
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const shaFile = (f) => sha(fs.readFileSync(f))
const readText = (f) => fs.readFileSync(f, 'utf8')
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s)

function decode (buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '')
  return stripBom(s).replace(/\r\n/g, '\n')
}

function runProc (cmd, args, opts = {}) {
  const started = Date.now()
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO,
    env: opts.env ?? process.env,
    encoding: 'buffer',
    timeout: opts.timeoutMs ?? 240000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: typeof r.status === 'number' ? r.status : null,
    out: decode(r.stdout),
    err: decode(r.stderr),
    raw: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ''), 'utf8'),
    ms: Date.now() - started,
    signal: r.signal ?? null,
    error: r.error ? String(r.error.message ?? r.error) : null,
  }
}

/** `process.env` 在 Windows 上大小写不敏感：先清干净 Path，夹具的 fake PATH 才是确定的 */
function childEnv (extra = {}) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
  return { ...env, ...extra }
}

const RUNS = []
function logRun (label, r, extra = '') {
  RUNS.push({ label, code: r.code, out: r.out, err: r.err })
  ev(path.join('runs', label), `# ${label}\n# exit=${r.code}  signal=${r.signal}  error=${r.error}\n# ${extra}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`)
  return r
}

// ───────────────────────────────────────────────────────── 全树内容指纹 / 差分
/** 相对路径 -> 'dir' 或 'sha:<hash>'（只看**存在性与字节**，不看 mtime：恢复会重写文件） */
function contentMap (root) {
  const out = new Map()
  const seen = new Set()
  const go = (d, rel) => {
    let real = ''
    try { real = fs.realpathSync(d) } catch { return }
    if (seen.has(real)) return
    seen.add(real)
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) { out.set(r, 'link'); continue }
      if (e.isDirectory()) { out.set(r, 'dir'); go(p, r) } else out.set(r, `sha:${shaFile(p)}`)
    }
  }
  if (root && fs.existsSync(root)) go(root, '')
  return out
}

/** 内容差分（before -> after）：变化的 / 新增的 / 消失的 */
function contentDiff (a, b) {
  const out = []
  for (const [k, v] of b) {
    if (!a.has(k)) out.push(`+${k}`)
    else if (a.get(k) !== v) out.push(`~${k}`)
  }
  for (const k of a.keys()) if (!b.has(k)) out.push(`-${k}`)
  return out.sort()
}

/** 真东西的守卫指纹：相对路径 + 大小 + 哈希（不含 mtime；真宿主自己的 mtime 抖动不是"改动"） */
function fpTree (root) {
  if (!fs.existsSync(root)) return 'absent'
  return sha([...contentMap(root)].map(([k, v]) => `${k} ${v}`).join('\n'))
}

/** 活包太大（5836 文件 / 364MB）：用便宜的守卫 —— 文件数、总字节、最新 mtime、顶层条目 */
function fpPack (root) {
  if (!fs.existsSync(root)) return 'absent'
  let files = 0
  let bytes = 0
  let newest = 0
  const walk = (d) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        files++
        bytes += st.size
        if (st.mtimeMs > newest) newest = st.mtimeMs
      }
    }
  }
  walk(root)
  const top = fs.readdirSync(root).sort().join(',')
  return `files=${files} bytes=${bytes} newest=${Math.round(newest)} top=[${top}]`
}

function cleanupOwn () {
  const abs = path.resolve(String(SESSION ?? ''))
  if (path.dirname(abs) !== path.resolve(TMP_BASE)) return { removed: false, error: `拒绝清理：${abs} 不在 ${TMP_BASE} 下` }
  if (!path.basename(abs).startsWith('whale-T22-R1-')) return { removed: false, error: `拒绝清理：${path.basename(abs)} 前缀不是 whale-T22-R1-` }
  try { fs.rmSync(abs, { recursive: true, force: true }); return { removed: true, error: null } } catch (e) { return { removed: false, error: `清理失败：${e && e.message ? e.message : String(e)}` } }
}

// ───────────────────────────────────────────────────────── 环境闸（缺料一律 BLOCKED）
if (!fs.existsSync(TMP_BASE)) h.block(`本机没有 ${TMP_BASE}（本卡规定临时夹具一律落这里）`)
if (!fs.existsSync(PS51)) h.block(`本机没有 PowerShell 5.1：${PS51}（K01/K02 判据要 5.1 的解析器）`)
else {
  const v = runProc(PS51, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeoutMs: 60000 })
  h.note(`PowerShell 5.1 探针：${PS51} → ${JSON.stringify(v.out.trim())} (exit=${v.code})`)
  if (!/^5\./.test(v.out.trim())) h.block(`那个 powershell.exe 报的版本不是 5.x：${JSON.stringify(v.out.trim())}`)
}
if (!fs.existsSync(INSTALLER)) h.block(`没有安装器：${INSTALLER}`)

let SESSION = null
try {
  SESSION = fs.mkdtempSync(path.join(TMP_BASE, 'whale-T22-R1-'))
} catch (e) {
  h.block(`建不了临时夹具根：${e && e.message ? e.message : String(e)}`)
}

// ───────────────────────────────────────────────────────── 夹具：fake dsh / fake node
/**
 * fake 命令：读 `FAKE_*` 开关 → 把调用追加进同一份 JSONL 日志 → 按开关答话。
 * 安装器**不需要**知道这些开关的存在（D4）：它只看子进程退出码与 dump 内容。
 */
const FAKE_CLI = `
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG = process.env.WHALE_T22_FAKE_LOG || ''
const tool = process.argv[2]
const argv = process.argv.slice(3)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const rec = {
  tool,
  argv,
  cwd: process.cwd(),
  dshHomeEnv: process.env.DSH_HOME ?? null,
  dshHomeArg: argOf('--dsh-home'),
  profileArg: argOf('--profile'),
}
if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + '\\n', 'utf8')

function resolveHome () {
  // 与真 dsh 同一套退路：$DSH_HOME → ~/.dsh（所以"安装器有没有显式设 home"在这里看得出来）
  const env = process.env.DSH_HOME
  return env && env.trim() ? path.resolve(env.trim()) : path.join(os.homedir(), '.dsh')
}
function guard (home) {
  const allow = process.env.WHALE_T22_FAKE_ALLOW || ''
  const abs = path.resolve(home)
  const root = path.resolve(allow).toLowerCase()
  const low = abs.toLowerCase()
  if (!allow || !(low === root || low.startsWith(root + path.sep))) {
    process.stdout.write('fake ' + tool + ': refusing to touch ' + abs + ' (not under ' + allow + ')\\n')
    process.exit(9)
  }
}

if (tool === 'node') {
  if (argv.includes('-v') || argv.includes('--version')) { process.stdout.write('v22.19.0\\n'); process.exit(0) }
  const home = argOf('--dsh-home') || resolveHome()
  guard(home)
  if (process.env.FAKE_NODE_FAIL === '1') {
    process.stdout.write('fake node: preset-install failed (injected)\\n')
    process.exit(4)
  }
  const src = process.env.WHALE_T22_PRESET_SRC || ''
  const dir = path.join(home, '.agent-presets', 'whale-mode')
  fs.mkdirSync(dir, { recursive: true })
  const body = fs.readFileSync(path.join(src, 'agent.cordis.yml'), 'utf8')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), '# fake-generated-by-T22-fixture\\n' + body, 'utf8')
  const meta = path.join(src, 'preset.yml')
  if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(dir, 'preset.yml'))
  process.stdout.write('OK   已安装（fake preset-install）：' + dir + '\\n')
  process.exit(0)
}

const profile = argOf('--profile') || 'web'
const home = resolveHome()

if (argv.includes('--dump-config')) {
  guard(home)
  if (process.env.FAKE_DSH_TARGETS_INCOMPLETE === '1') {
    // "拿不到可核对的有效配置" —— 安装器据此拒绝事务安装（R05）
    process.stdout.write('fake dsh: cannot enumerate plugin targets\\n')
    process.exit(3)
  }
  const profDir = path.join(home, 'profiles', profile)
  let hasWhale = false
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8'))
    hasWhale = Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'dsh-whale-sensei')
  } catch { /* 读不到就是没有 */ }
  let patchText = null
  try { patchText = fs.readFileSync(path.join(profDir, 'cordis.patch.yml'), 'utf8') } catch { /* 没有 patch 文件 */ }
  // "合并后的有效配置"：whale-sensei 那一段**逐字**抄 profile 的 cordis.patch.yml
  // —— 安装器往那段里插了什么（包括插出第二个 config 键 / 第二行 packRoot），这里就照原样出现在
  //    有效配置里，K05/K06 才真的在核安装器的写入面，而不是在核夹具自己编的文本。
  const entryLines = (text, id) => {
    const lines = String(text).split(/\\r?\\n/)
    const at = lines.findIndex((l) => new RegExp('^-\\\\s*id:\\\\s*' + id + '\\\\s*$').test(l))
    if (at < 0) return null
    const out = [lines[at]]
    for (let i = at + 1; i < lines.length; i++) {
      if (/^-\\s/.test(lines[i])) break
      out.push(lines[i])
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop()
    return out
  }
  const lines = ['# fake dsh --dump-config (merged effective config)', '- id: baode', '  config:', "    token: 'fixture-token'"]
  if (hasWhale && process.env.FAKE_DSH_FAIL !== 'dump') {
    const block = entryLines(patchText, 'whale-sensei')
    if (block) lines.push(...block)
    else lines.push('- id: whale-sensei', '  config:', "    packRoot: ''")
  }
  process.stdout.write(lines.join('\\n') + '\\n')
  process.exit(0)
}

if (argv[0] === 'plugin' && argv.includes('add')) {
  guard(home)
  const profDir = path.join(home, 'profiles', profile)
  if (process.env.FAKE_DSH_FAIL === 'add') {
    if (process.env.FAKE_DSH_OCCUPY_TARGET === '1') {
      // "拿文件占住目录名"的同类：把目标文件换成**目录**，恢复就写不回原字节（R04）
      const t = path.join(profDir, 'package.json')
      try { fs.rmSync(t, { force: true, recursive: true }) } catch { /* 不在就算了 */ }
      fs.mkdirSync(t)
    }
    process.stdout.write('fake dsh: plugin add failed (injected)\\n')
    process.exit(7)
  }
  const pkgFile = path.join(profDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  pkg.dependencies['dsh-whale-sensei'] = 'link:' + String(argv[argv.length - 1] || '').replace(/^link:/, '')
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\\n', 'utf8')
  const lock = path.join(profDir, 'pnpm-lock.yaml')
  if (fs.existsSync(lock)) fs.appendFileSync(lock, '  dsh-whale-sensei:\\n    specifier: link:..\\n', 'utf8')
  process.stdout.write('fake dsh: added dsh-whale-sensei (link:)\\n')
  process.exit(0)
}

process.stdout.write('fake dsh: unknown argv ' + JSON.stringify(argv) + '\\n')
process.exit(0)
`

const WRAPPER_SRC = (installerPath) => [
  '# T22 fixture wrapper: pin the redirected stdout to UTF-8 (for the evidence file, not for the',
  '# installer behaviour), run the installer with exactly the arguments received, then print what',
  '# the OUTER PowerShell now sees in DSH_HOME (H03 judges exactly that line).',
  "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }",
  `& '${installerPath}' @args`,
  '$code = $LASTEXITCODE',
  'if ($null -eq $code) { $code = if ($?) { 0 } else { 1 } }',
  'Write-Output ("WHALE_OUTER_HAS=" + [bool](Test-Path Env:\\DSH_HOME))',
  'Write-Output ("WHALE_OUTER_DSH_HOME=[" + $env:DSH_HOME + "]")',
  'exit $code',
  '',
].join('\n')

const PROFILE_PKG = `${JSON.stringify({ name: 'web-profile', version: '0.0.0', private: true }, null, 2)}\n`
const PROFILE_PKG_INSTALLED = `${JSON.stringify({ name: 'web-profile', version: '0.0.0', private: true, dependencies: { 'dsh-whale-sensei': '9.9.9' } }, null, 2)}\n`
const PATCH_BEFORE = [
  '# profile patch (fixture)',
  '- id: whale-sensei',
  '  config:',
  '    announceOnBoot: true',
  '- id: baode',
  '  config:',
  "    token: 'keep-me-byte-for-byte'",
  '',
].join('\n')

function mkFixture (tag, opts = {}) {
  // T22-R2：第二批的夹具落在**自己的**临时根（`whale-T22-R2-*`）—— R1 的 C03 收的是它那份
  // `whale-T22-R1-*`，两批各收各的。既有调用不传 baseDir ⇒ 行为与第一批一字不差。
  const base = path.join(opts.baseDir ?? SESSION, tag)
  const home = path.join(base, 'home')
  const profDir = path.join(home, 'profiles', PROF)
  fs.mkdirSync(profDir, { recursive: true })
  fs.writeFileSync(path.join(profDir, 'package.json'), opts.pkg ?? PROFILE_PKG)
  if (opts.noPatch !== true) fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), PATCH_BEFORE)
  if (opts.noLock !== true) fs.writeFileSync(path.join(profDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  // fake bin **放在 home 里面**：DSH_HOME 没设时，安装器的候选表会顺着 `dsh` 命令往上找，
  // 于是它照样找得到本夹具的 home（H03(b) 要的正是"原来没设 ⇒ 结束时也没设"）。
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const cli = path.join(base, 'fake-cli.mjs')
  fs.writeFileSync(cli, FAKE_CLI, 'utf8')
  fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" dsh %*\r\nexit /b %ERRORLEVEL%\r\n`)
  fs.writeFileSync(path.join(bin, 'node.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" node %*\r\nexit /b %ERRORLEVEL%\r\n`)
  const backup = path.join(base, 'backup')
  const caller = path.join(base, 'caller')
  fs.mkdirSync(caller, { recursive: true })
  fs.writeFileSync(path.join(caller, 'junk.txt'), 'the caller home is NOT a DSH root\n')
  const pack = path.join(base, 'pack')
  fs.mkdirSync(path.join(pack, 'presets'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'presets', 'whale-sensei.css'), '/* course pack marker (fixture) */\n')
  fs.mkdirSync(path.join(pack, 'skills'), { recursive: true })
  const log = path.join(base, 'fake-calls.log')
  const wrapper = path.join(base, 'run-installer.ps1')
  fs.writeFileSync(wrapper, WRAPPER_SRC(opts.installer ?? INSTALLER), 'utf8')
  return { tag, base, home, profDir, bin, backup, caller, pack, log, wrapper, installer: opts.installer ?? INSTALLER }
}

const logOf = (fx) => {
  if (!fs.existsSync(fx.log)) return []
  return readText(fx.log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

function fixtureEnv (fx, extra = {}) {
  return childEnv({
    DSH_PLUGIN_BACKUP: fx.backup,
    WHALE_T22_FAKE_LOG: fx.log,
    WHALE_T22_FAKE_ALLOW: fx.base,
    WHALE_T22_PRESET_SRC: path.join(REPO, 'preset', 'whale-mode'),
    PATH: `${fx.bin};${process.env.PATH ?? process.env.Path ?? ''}`,
    ...extra,
  })
}

function runInstaller (fx, args, env, label) {
  const r = runProc(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fx.wrapper, ...args], { env })
  return logRun(label, r, `argv: ${args.join(' ')}\nfixture: ${fx.base}\ninstaller: ${fx.installer}`)
}

/** 一个空闲端口（真宿主可能还在 3090/其它端口上；-SkipHostCheck 属于回避，不用它） */
const FREE_PORT = await new Promise((res) => {
  const s = net.createServer()
  s.on('error', () => res(0))
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const baseArgs = () => ['-HostPort', String(FREE_PORT), '-Profile', PROF]

// ───────────────────────────────────────────────────────── 真机守卫（真 profile / 真备份根 / 只读快照 / 活包）
const REAL_HOME = os.homedir()
const REAL_DSH = path.join(REAL_HOME, '.dsh')
const REAL_PROFILES = path.join(REAL_DSH, 'profiles')
const REAL_BACKUP = path.join(REAL_HOME, '.dsh-plugin-backup')
const REAL_PRESETS = path.join(REAL_DSH, '.agent-presets')
const fpFocus = () => [path.join(REAL_PROFILES, 'web', 'package.json'), path.join(REAL_PROFILES, 'web', 'cordis.patch.yml')]
  .map((f) => (fs.existsSync(f) ? `${f} ${fs.statSync(f).size} ${Math.round(fs.statSync(f).mtimeMs)} ${shaFile(f)}` : `${f} absent`))
  .join('\n')

const GUARD = {
  profiles: fpTree(REAL_PROFILES),
  backup: fpTree(REAL_BACKUP),
  focus: fpFocus(),
  presets: fs.existsSync(REAL_PRESETS),
  snapshot: fpTree(SNAPSHOT_DIR),
  pack: fpPack(LIVE_PACK),
}

// ───────────────────────────────────────────────────────── 基线（T22 之前那份）
// ⚠️ 这里**必须钉死一个固定 revision**，不能用 `HEAD`：候选一旦被提交，`HEAD` 就变成"修好之后的自己"，
//    负向控制会去对照一份**没有 bug** 的基线，于是"基线确实落错了 home / 确实写出重复键"这类断言
//    反而变红（实测：提交后 `H02` 立刻从绿翻红）。`c1e9aaa` = 本卡两个批次开始之前的那次提交
//    （批次 8 的 T21），也就是"T22 之前的实现"。
const T22_BASELINE_REV = 'c1e9aaa'
{
  const g = runProc('git', ['rev-parse', '--verify', `${T22_BASELINE_REV}^{commit}`], { timeoutMs: 60000 })
  if (g.code !== 0 || !/^[0-9a-f]{40}$/.test(String(g.out).trim())) h.block(`拿不到本卡的基线 revision ${T22_BASELINE_REV}：${g.err}`)
}
const BASELINE_PS1 = SESSION ? path.join(SESSION, 'baseline-install-whale-sensei.ps1') : null
let BASELINE_OK = false
if (SESSION) {
  const g = runProc('git', ['show', `${T22_BASELINE_REV}:install-whale-sensei.ps1`], { timeoutMs: 60000 })
  if (g.code === 0 && g.out.length > 1000) {
    fs.writeFileSync(BASELINE_PS1, g.raw)   // **按字节写**：基线那份的 UTF-8 BOM 必须原样留着
    BASELINE_OK = true
  }
  logRun('baseline-git-show', g, `git show ${T22_BASELINE_REV}:install-whale-sensei.ps1 → ${BASELINE_OK ? BASELINE_PS1 : 'FAILED'}`)
}

// ───────────────────────────────────────────────────────── R11/R12 要 import 的两个模块（本批一个字节都不许改）
const PACKROOT_REL = 'lib/profile-packroot.js'
const PRESET_REL = 'lib/preset-install.js'
const PACKROOT_FILE = path.join(REPO, PACKROOT_REL)
const PRESET_FILE = path.join(REPO, PRESET_REL)
const GIT_HEAD_FILE = {}
for (const rel of [PACKROOT_REL, PRESET_REL]) {
  // 同一理由：对照的是"T22 之前那份"，钉死 revision，不用会随提交漂移的 HEAD。
  const g = runProc('git', ['show', `${T22_BASELINE_REV}:${rel}`], { timeoutMs: 60000 })
  GIT_HEAD_FILE[rel] = { ok: g.code === 0, sha: g.code === 0 ? sha(g.raw) : null, err: g.err }
}
const packrootMod = await import(pathToFileURL(PACKROOT_FILE).href)
const presetMod = await import(pathToFileURL(PRESET_FILE).href)

// ───────────────────────────────────────────────────────── PS 5.1 AST 探针（K01 用）
const AST_PROBE = SESSION ? path.join(SESSION, 'ast-probe.ps1') : null
if (SESSION) {
  fs.writeFileSync(AST_PROBE, [
    'param([string] $Path)',
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
    '$tok = $null; $errs = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tok, [ref]$errs)',
    'Write-Output ("AST_PARSE_ERRORS=" + $errs.Count)',
    'foreach ($e in $errs) { Write-Output ("AST_ERR|" + $e.Extent.StartLineNumber + "|" + $e.Message) }',
    'foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Write-Output ("AST_FUNC|" + $f.Name + "|" + $f.Extent.StartLineNumber + "|" + $f.Extent.EndLineNumber) }',
    '',
  ].join('\n'), 'utf8')
}

function parseWith51 (file, label) {
  const r = logRun(label, runProc(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AST_PROBE, file]), `ParseFile ${file}`)
  const m = /AST_PARSE_ERRORS=(\d+)/.exec(r.out)
  const errs = [...r.out.matchAll(/^AST_ERR\|(\d+)\|(.*)$/gm)].map((x) => ({ line: Number(x[1]), message: x[2] }))
  const funcs = {}
  for (const x of r.out.matchAll(/^AST_FUNC\|([^|]+)\|(\d+)\|(\d+)$/gm)) funcs[x[1]] = { start: Number(x[2]), end: Number(x[3]) }
  return { run: r, code: r.code, errors: m ? Number(m[1]) : null, parseErrors: errs, funcs }
}

// ───────────────────────────────────────────────────────── 计划解析（dry-run 的机器可读面）
const planWrites = (out) => out.split('\n').filter((l) => l.startsWith('PLAN writes path='))
const planMetas = (out) => out.split('\n').filter((l) => l.startsWith('PLAN write-meta '))
const planHome = (out) => (/^PLAN home=(.*)$/m.exec(out) ?? [])[1] ?? null
/**
 * `PLAN write-meta path=<p> home=<h> installedVersion=<v>`
 * 上面那行 `PLAN writes …` 的形状被 T21 的用例钉死，所以 T22 的两个新字段另起一行（见安装器注释）。
 */
function metaOf (line) {
  const m = /^PLAN write-meta path=(.*) home=(.*) installedVersion=(.*)$/.exec(line)
  if (!m) return null
  return { path: m[1], home: m[2], installedVersion: m[3] }
}
function writesOf (line) {
  const m = /^PLAN writes path=(.*) existed=(True|False) bytes=(\d+) sha256=([0-9a-f]*)$/.exec(line)
  if (!m) return null
  return { path: m[1], existed: m[2] === 'True', bytes: Number(m[3]), sha256: m[4] }
}

/** 最小块映射解析器（K06 用；**不引 YAML 库** —— 本仓零依赖纪律，test/preset.mjs#L17 已写明） */
function blockMapScan (text) {
  const lines = []
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    lines.push(line)
  }
  const topItems = lines.filter((l) => /^-\s/.test(l))
  const entries = []
  let cur = null
  for (const line of lines) {
    if (/^-\s/.test(line)) {
      cur = { head: line, body: [] }
      entries.push(cur)
      continue
    }
    if (cur) cur.body.push(line)
  }
  const scanEntry = (entry) => {
    const map = new Map()
    const dup = []
    const stack = []
    for (const line of [entry.head, ...entry.body]) {
      const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(\s|$)/.exec(line)
      if (!m) continue
      const indent = m[1].length
      const key = m[2]
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      const full = [...stack.map((s) => s.key), key].join('.')
      stack.push({ indent, key })
      const arr = map.get(full) ?? []
      arr.push(line)
      map.set(full, arr)
      if (arr.length > 1) dup.push(full)
    }
    return { map, dup }
  }
  return {
    lines,
    topItems,
    entries: entries.map((e) => ({ ...e, ...scanEntry(e) })),
    // 顶层条目里 id 值的序号（用来判"恰好一个"）
    ids: entries.map((e) => (/-\s*id:\s*(\S+)/.exec(e.head) ?? [])[1]).filter(Boolean),
  }
}

/** "成功判词"：只看那些**不带否定/失败字样**的行 —— 失败输出里"别把这次安装当成成功"不算判词 */
function successClaims (out) {
  return String(out).split('\n')
    .filter((l) => !/不|别|没|NOT|\bnot\b|FAIL|fail/.test(l))
    .filter((l) => /^\s*OK\b|\bOK\b|成功|装好了|已成功/.test(l))
}

// ══════════════════════════════════════════════════════ K：脚本静态面与夹具自检
h.case('K01 parse-5.1-after-t22', 'pass', () => {
  h.assert(fs.existsSync(PS51), `没有 PowerShell 5.1：${PS51}`)
  const cur = parseWith51(INSTALLER, 'k01-ast-installer')
  h.eq(cur.code, 0, 'PS 5.1 解析探针进程必须退出 0')
  h.assert(cur.errors !== null, '探针没有报告 AST_PARSE_ERRORS')
  h.eq(cur.errors, 0, `改后的安装器用 5.1 解析必须 0 错：${JSON.stringify(cur.parseErrors.slice(0, 4))}`)
  for (const fn of ['Get-InstallPlan', 'Invoke-InstallPlan', 'Restore-InstallPlan', 'Get-WriteRecord', 'Get-InstalledVersion']) {
    h.assert(Object.prototype.hasOwnProperty.call(cur.funcs, fn), `5.1 解析出来的函数表里必须有 ${fn}：${JSON.stringify(Object.keys(cur.funcs))}`)
  }
  h.assert(BASELINE_OK, `基线安装器（git show ${T22_BASELINE_REV}）拿得到，才能拿它对照同一解析器`)
  const bl = parseWith51(BASELINE_PS1, 'k01-ast-baseline')
  h.eq(bl.errors, 0, '基线安装器用 5.1 解析也必须 0 错（同一判据改前改后都成立）')
  ev('K01-parse', `current: exit=${cur.code} parse-errors=${cur.errors}\nfuncs=${JSON.stringify(cur.funcs)}\nbaseline(HEAD): exit=${bl.code} parse-errors=${bl.errors}\n\n-- current raw --\n${clip(cur.run.out, 6000)}`)
})

h.case('K02 bom-and-lf-preserved', 'pass', () => {
  const b = fs.readFileSync(INSTALLER)
  h.eq(b.subarray(0, 3).toString('hex'), 'efbbbf', '安装器前三字节必须仍是 UTF-8 BOM（PS 5.1 否则按 ANSI 读中文注释）')
  const text = b.toString('utf8')
  const crlf = (text.match(/\r\n/g) || []).length
  h.eq(crlf, 0, '安装器必须全 LF（CRLF 计数）')
  const lf = (text.match(/\n/g) || []).length
  h.assert(lf > 700, `安装器还是那份长脚本（LF 计数 ${lf}）`)
  h.assert(/\[CmdletBinding\(\)\]/.test(text), '脚本头 [CmdletBinding()] 还在')
  const params = /param\(([\s\S]*?)\n\)/.exec(text)
  h.assert(params, 'param( ... ) 块还在')
  const names = [...new Set([...params[1].matchAll(/\$([A-Za-z][A-Za-z0-9]*)/g)].map((x) => x[1]))].sort()
  h.eq(names.join(','), ['DryRun', 'HostPort', 'PackageDir', 'PackRoot', 'PackRootOnly', 'Preflight', 'Profile', 'SkipHostCheck', 'SkipPreset', 'SkipSnapshot'].sort().join(','), '命令行参数全集不许多也不许少（T21 R02 的判据）')
  ev('K02-bytes', `file=${INSTALLER}\nbytes=${b.length}\nfirst3=${b.subarray(0, 3).toString('hex')}\ncrlf=${crlf}\nlf=${lf}\nparams=${names.join(',')}`)
})

h.case('K03 patch-write-no-bom', 'pass', () => {
  const src = readText(INSTALLER)
  const writeLines = src.split('\n').filter((l) => /\[System\.IO\.File\]::WriteAllText\(/.test(l))
  h.eq(writeLines.length, 1, `写盘语句恰好一条（实得 ${writeLines.length}）`)
  h.assert(/New-Object System\.Text\.UTF8Encoding\(\$false\)/.test(writeLines[0]), `写 cordis.patch.yml 必须仍用 UTF8Encoding($false)：${writeLines[0].trim()}`)
  h.assert(!/UTF8Encoding\(\s*\$true\s*\)/.test(src), '安装器里不许出现带 BOM 的 UTF8Encoding($true)')
  const fx = mkFixture('k03')
  const r = runInstaller(fx, [...baseArgs(), '-PackRootOnly', '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home }), 'k03-packrootonly')
  h.eq(r.code, 0, `-PackRootOnly 退出码（实得 ${r.code}）：\n${clip(r.out + r.err, 1200)}`)
  const pb = fs.readFileSync(path.join(fx.profDir, 'cordis.patch.yml'))
  h.assert(pb.subarray(0, 3).toString('hex') !== 'efbbbf', `真跑出来的 cordis.patch.yml 不得带 BOM（前三字节 ${pb.subarray(0, 3).toString('hex')}）`)
  h.assert(pb.toString('utf8').includes(`packRoot: '${fx.pack.split('\\').join('/')}'`), `patch 里落下了期望的 packRoot：\n${pb.toString('utf8')}`)
  ev('K03-patch-bytes', `源码里的写盘语句：\n${writeLines[0]}\n\n真跑后 written first3=${pb.subarray(0, 3).toString('hex')} bytes=${pb.length}\n--- content ---\n${pb.toString('utf8')}`)
})

h.case('K04 fixture-shape', 'pass', () => {
  const fx = mkFixture('k04')
  h.assert(fs.existsSync(path.join(fx.profDir, 'package.json')), '临时 home 里真有 profiles\\web-t22r1\\package.json')
  h.assert(fs.existsSync(path.join(fx.profDir, 'cordis.patch.yml')), '临时 home 里真有 profiles\\web-t22r1\\cordis.patch.yml')
  h.assert(!fs.existsSync(fx.backup), '夹具开始时 DSH_PLUGIN_BACKUP 目录**不存在**（"回滚收掉了材料"才有意义）')
  h.assert(fs.existsSync(path.join(fx.bin, 'dsh.cmd')), '临时 PATH 上有 fake dsh.cmd')
  h.assert(fs.existsSync(path.join(fx.bin, 'node.cmd')), '临时 PATH 上有 fake node.cmd')
  h.assert(!fs.existsSync(fx.log), '跑之前 fake-calls.log 不存在')
  const env = fixtureEnv(fx, { DSH_HOME: fx.home })
  const r1 = logRun('k04-fake-node', runProc('cmd.exe', ['/c', path.join(fx.bin, 'node.cmd'), '-v'], { env }), 'fake node 单独调用')
  const r2 = logRun('k04-fake-dsh', runProc('cmd.exe', ['/c', path.join(fx.bin, 'dsh.cmd'), '--profile', PROF, '--dump-config'], { env }), 'fake dsh 单独调用')
  h.eq(r1.code, 0, 'fake node 单独调用退出码')
  h.eq(r2.code, 0, 'fake dsh 单独调用退出码')
  h.assert(fs.existsSync(fx.log), 'fake 命令被单独调用后 fake-calls.log 必须出现（否则"日志为空"是空转）')
  const calls = logOf(fx)
  h.eq(calls.length, 2, `两次单独调用各记一条（实得 ${calls.length}）`)
  for (const key of ['tool', 'argv', 'cwd', 'dshHomeEnv', 'dshHomeArg', 'profileArg']) {
    h.assert(Object.prototype.hasOwnProperty.call(calls[0], key), `日志每条都要有 ${key} 字段：${JSON.stringify(calls[0])}`)
  }
  h.assert(calls.some((c) => c.tool === 'node' && c.argv.join(' ') === '-v'), 'fake node 那条记到了 argv')
  h.assert(calls.some((c) => c.tool === 'dsh' && c.profileArg === PROF), 'fake dsh 那条记到了 --profile')
  // 保险丝自检：假命令**绝不**允许碰夹具外的 home
  const outside = runProc('cmd.exe', ['/c', path.join(fx.bin, 'dsh.cmd'), '--profile', PROF, '--dump-config'], { env: fixtureEnv(fx, { DSH_HOME: path.join(fx.base, '..', 'not-a-fixture-home') }) })
  h.eq(outside.code, 9, `夹具保险丝：DSH_HOME 指到夹具外时 fake dsh 必须拒绝（实得 ${outside.code}）：${JSON.stringify(outside.out)}`)
  ev('K04-fixture', `fixture=${fx.base}\ncalls=${JSON.stringify(calls, null, 2)}\nfuse: exit=${outside.code} out=${JSON.stringify(outside.out)}`)
})

// ══════════════════════════════════════════════════════ 正常安装（K05/K06/H01/H04/R06 共用）
const NORMAL = {
  fx: null, r: null, dump: null, dshDump: null, planOut: null,
  configText: null, configRun: null,
}
const dumpArgs = (fx) => [...baseArgs(), '-DryRun', '-PackRoot', fx.pack]

h.case('K05 normal-install-target-entry-via-config', 'pass', () => {
  const fx = mkFixture('normal')
  NORMAL.fx = fx
  const dry = runInstaller(fx, dumpArgs(fx), fixtureEnv(fx, { DSH_HOME: fx.home }), 'k05-dryrun')
  h.eq(dry.code, 0, `-DryRun 退出码（实得 ${dry.code}）`)
  NORMAL.planOut = dry.out
  h.eq(planHome(dry.out), fx.home, '计划里的 home 必须就是夹具 home')
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home }), 'k05-normal-install')
  NORMAL.r = r
  h.eq(r.code, 0, `正常安装必须 exit 0（实得 ${r.code}）：\n${clip(r.out + r.err, 2000)}`)
  // 用**同一份 fake dsh 的有效配置输出**核对目标 entry（不只 grep packRoot 行）
  const cfg = runInstaller2(fx, ['--profile', PROF, '--dump-config'], fixtureEnv(fx, { DSH_HOME: fx.home }), 'k05-fake-dump-config')
  NORMAL.configRun = cfg
  NORMAL.configText = cfg.out
  const parsed = blockMapScan(cfg.out)
  h.assert(parsed.lines.length >= 4, `有效配置输出不是空的：\n${cfg.out}`)
  h.assert(parsed.topItems.length >= 2, `顶层必须是列表（实得 ${parsed.topItems.length} 条顶层条目）：\n${cfg.out}`)
  const whaleIds = parsed.ids.filter((x) => x === 'whale-sensei')
  h.eq(whaleIds.length, 1, `恰好一个 id: whale-sensei（实得 ${JSON.stringify(parsed.ids)}）`)
  const entry = parsed.entries.find((e) => /-\s*id:\s*whale-sensei\s*$/.test(e.head))
  h.assert(entry, `找得到 whale-sensei 那一段：\n${cfg.out}`)
  h.eq((entry.map.get('config') ?? []).length, 1, `该段恰好一个 config 键：${JSON.stringify(entry.map.get('config'))}`)
  const roots = entry.map.get('config.packRoot') ?? []
  h.eq(roots.length, 1, `该段的 config 里 packRoot 只出现一次：${JSON.stringify(roots)}`)
  const want = fx.pack.split('\\').join('/')
  h.eq((/packRoot:\s*'?([^'\n]*)'?/.exec(roots[0]) ?? [])[1], want, `packRoot 的值就是期望路径（${want}）`)
  ev('K05-config-entry', `fixture=${fx.base}\ninstall exit=${r.code}\nplan home=${planHome(dry.out)}\n--- fake dsh --dump-config ---\n${cfg.out}\n--- parsed ---\nids=${JSON.stringify(parsed.ids)}\nentry.map=${JSON.stringify([...entry.map].map(([k, v]) => [k, v.length]))}`)
})

h.case('K06 normal-install-not-a-second-config-key', 'pass', () => {
  h.assert(NORMAL.configText, 'K05 的配置文本在（用例顺序错了？）')
  const parsed = blockMapScan(NORMAL.configText)
  const entry = parsed.entries.find((e) => /-\s*id:\s*whale-sensei\s*$/.test(e.head))
  h.assert(entry, '找得到 whale-sensei 那一段')
  h.eq(entry.dup.join(','), '', `同一段里不许出现重复键（实得 ${JSON.stringify(entry.dup)}）`)
  h.eq((entry.map.get('config') ?? []).length, 1, '只有一个 config 键（没有插第二个 config）')
  h.eq((entry.map.get('config.packRoot') ?? []).length, 1, 'config 里只有一个 packRoot')
  // 链条自证：fake dsh 的有效配置里那一段是**逐字**抄磁盘上安装器写出的 cordis.patch.yml，
  // 所以上面那两条"没有重复键"核的是安装器的写入面，不是夹具自己编的文本。
  const patchText = readText(path.join(NORMAL.fx.profDir, 'cordis.patch.yml'))
  const patchLines = patchText.split('\n')
  const at = patchLines.findIndex((l) => /^-\s*id:\s*whale-sensei\s*$/.test(l))
  h.assert(at >= 0, `磁盘上的 patch 里要有 whale-sensei 那一段：\n${patchText}`)
  const diskBlock = [patchLines[at]]
  for (let i = at + 1; i < patchLines.length; i++) {
    if (/^-\s/.test(patchLines[i])) break
    diskBlock.push(patchLines[i])
  }
  while (diskBlock.length && diskBlock[diskBlock.length - 1].trim() === '') diskBlock.pop()
  h.assert(diskBlock.length >= 3, `磁盘上那段至少有 id + config + packRoot 三行：${JSON.stringify(diskBlock)}`)
  for (const l of diskBlock) h.assert(NORMAL.configText.includes(l), `有效配置里必须逐字带着磁盘上那行：${JSON.stringify(l)}`)
  h.eq([entry.head, ...entry.body].slice(0, diskBlock.length).join('\n'), diskBlock.join('\n'), '有效配置里那一段与磁盘上的那段逐字一致')
  // 顺带一条独立事实：磁盘上那一段里 config 只出现一次、packRoot 只出现一次
  const diskMap = blockMapScan(diskBlock.join('\n'))
  h.eq(diskMap.entries[0].dup.join(','), '', `磁盘上那段也不许有重复键：${JSON.stringify(diskMap.entries[0].dup)}`)
  // 解析器自身的两个自检（负向控制 + 正向控制）：**不引 YAML 库**
  const badText = ['- id: whale-sensei', '  config:', "    packRoot: '/a'", '  config:', "    packRoot: '/b'", "    packRoot: '/c'"].join('\n')
  const bad = blockMapScan(badText)
  h.assert(bad.entries[0].dup.includes('config'), `自检①：故意含重复 config 的文本必须被报出来（实得 ${JSON.stringify(bad.entries[0].dup)}）`)
  h.assert(bad.entries[0].dup.includes('config.packRoot'), `自检①：重复的 packRoot 也必须被报出来（实得 ${JSON.stringify(bad.entries[0].dup)}）`)
  const good = blockMapScan(['- id: whale-sensei', '  config:', "    packRoot: '/a'", '    announceOnBoot: true', '- id: baode', '  config:', "    token: 'x'"].join('\n'))
  h.eq(good.entries[0].dup.join(','), '', '自检②：正确文本不许被误报')
  h.eq(good.entries[0].dup.length, 0, '自检②：正确文本的重复键集合为空')
  ev('K06-block-map', `--- config text (fake dsh --dump-config，含逐字抄来的 patch 段) ---\n${NORMAL.configText}\n--- 磁盘上 patch 的那一段 ---\n${diskBlock.join('\n')}\n--- dup(entry) ---\n${JSON.stringify(entry.dup)}\n--- 磁盘段的 dup ---\n${JSON.stringify(diskMap.entries[0].dup)}\n--- 自检① dup ---\n${JSON.stringify(bad.entries[0].dup)}\n--- 自检① text ---\n${badText}\n--- 自检② dup ---\n${JSON.stringify(good.entries[0].dup)}`)
})

/** 单独跑一次 fake 命令（不经安装器），用于 K05 的"有效配置输出" */
function runInstaller2 (fx, args, env, label) {
  const r = runProc('cmd.exe', ['/c', path.join(fx.bin, 'dsh.cmd'), ...args], { env })
  return logRun(label, r, `fake dsh ${args.join(' ')}`)
}

// ══════════════════════════════════════════════════════ R：writes / 恢复
h.case('R01 writes-carry-home-and-version', 'pass', () => {
  const fx = mkFixture('r01', { pkg: PROFILE_PKG_INSTALLED })
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home }), 'r01-dryrun')
  h.eq(r.code, 0, `-DryRun 退出码（实得 ${r.code}）`)
  const wl = planWrites(r.out).map(writesOf)
  const ml = planMetas(r.out).map(metaOf)
  h.assert(wl.length > 0 && wl.every(Boolean), `每条 PLAN writes 都要解析得出来：\n${planWrites(r.out).join('\n')}`)
  h.assert(ml.length > 0 && ml.every(Boolean), `每条 PLAN write-meta 都要解析得出来：\n${planMetas(r.out).join('\n')}`)
  h.eq(ml.length, wl.length, 'PLAN writes 与 PLAN write-meta 必须一一对应（同数同序）')
  for (let i = 0; i < ml.length; i++) {
    h.eq(ml[i].path, wl[i].path, `第 ${i} 条的 path 要对得上`)
    h.eq(ml[i].home, fx.home, `第 ${i} 条的 home 必须是计划里的 home：${ml[i].path}`)
  }
  const pkgMeta = ml.find((m) => m.path === path.join(fx.profDir, 'package.json'))
  h.assert(pkgMeta, `profile package.json 要进 writes：${JSON.stringify(ml.map((m) => m.path))}`)
  h.eq(pkgMeta.installedVersion, '9.9.9', `installedVersion 就是 profile package.json 里 dependencies['dsh-whale-sensei']（实得 ${JSON.stringify(pkgMeta.installedVersion)}）`)
  for (const m of ml) {
    if (m.path === path.join(fx.profDir, 'package.json')) continue
    h.eq(m.installedVersion, '', `非 profile package.json 的目标 installedVersion 必须是空串：${m.path}`)
  }
  // "原不存在"的目标：existed=false / bytes=0 / sha256=''
  const notExist = wl.filter((w) => !w.existed)
  h.assert(notExist.length > 0, `夹具里要有"原不存在"的目标（预设树 / 那份备份）：${JSON.stringify(wl)}`)
  for (const w of notExist) {
    h.eq(w.bytes, 0, `原不存在的目标 bytes 必须是 0：${w.path}`)
    h.eq(w.sha256, '', `原不存在的目标 sha256 必须是空串：${w.path}`)
  }
  const presetRec = wl.find((w) => w.path === path.join(fx.home, '.agent-presets', 'whale-mode', 'agent.cordis.yml'))
  h.assert(presetRec && presetRec.existed === false, `预设组合文件本来不存在 ⇒ existed=false：${JSON.stringify(presetRec)}`)
  ev('R01-writes', `--- PLAN writes ---\n${planWrites(r.out).join('\n')}\n--- PLAN write-meta ---\n${planMetas(r.out).join('\n')}\nnotExist=${JSON.stringify(notExist.map((w) => w.path))}`)
})

h.case('R02 restore-plan-restores-bytes', 'pass', () => {
  const fx = mkFixture('r02')
  const patchFile = path.join(fx.profDir, 'cordis.patch.yml')
  const pkgFile = path.join(fx.profDir, 'package.json')
  const before = { patch: shaFile(patchFile), pkg: shaFile(pkgFile) }
  const dry = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home }), 'r02-dryrun')
  h.eq(dry.code, 0, `-DryRun 退出码（实得 ${dry.code}）`)
  const planPatch = planWrites(dry.out).map(writesOf).find((w) => w.path === patchFile)
  h.assert(planPatch, '计划里要有目标 patch 的原哈希')
  h.eq(planPatch.sha256, before.patch, '计划里记的 sha256 就是磁盘原文的哈希')
  // 故障注入：patch 之后再失败 ⇒ 必须按原字节把 patch 还原
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home, FAKE_NODE_FAIL: '1' }), 'r02-fail-after-patch')
  h.assert(r.code !== 0, `注入故障后必须退出非零（实得 ${r.code}）`)
  h.assert(/回滚|已恢复/.test(r.out), `输出里要有回滚/已恢复判词：\n${clip(r.out, 1500)}`)
  h.eq(shaFile(patchFile), before.patch, `patch 的字节必须回到计划里那份原哈希：\n${readText(patchFile)}`)
  h.eq(shaFile(pkgFile), before.pkg, 'profile package.json 的字节必须回到跑之前')
  h.assert(fs.existsSync(patchFile), 'patch 本来就在 ⇒ 恢复后仍在')
  ev('R02-restore-bytes', `fixture=${fx.base}\nbefore patch sha=${before.patch}\nplan patch sha=${planPatch.sha256}\nafter  patch sha=${shaFile(patchFile)}\nbefore pkg sha=${before.pkg}\nafter  pkg sha=${shaFile(pkgFile)}\n\n-- stdout --\n${r.out}`)
})

h.case('R03 restore-plan-removes-not-existed', 'pass', () => {
  const fx = mkFixture('r03', { noPatch: true })
  const patchFile = path.join(fx.profDir, 'cordis.patch.yml')
  h.assert(!fs.existsSync(patchFile), '夹具开始时**没有** cordis.patch.yml')
  const before = contentMap(fx.home)
  // 故障点选"add 失败"：这样预设**真的**落过盘，回滚要连它建出来的空目录一起收掉
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home, FAKE_DSH_FAIL: 'add' }), 'r03-fail-after-preset')
  h.assert(r.code !== 0, `注入故障后必须退出非零（实得 ${r.code}）`)
  h.assert(fs.existsSync(path.join(fx.profDir, 'cordis.patch.yml.bak-whale-20200101-000000')) === false, '夹具里不该有别的备份')
  h.assert(!fs.existsSync(patchFile), `本来没有的 patch ⇒ 恢复后必须不存在：${patchFile}`)
  h.assert(!fs.existsSync(path.join(fx.home, '.agent-presets', 'whale-mode')), 'whale-mode 空目录也要收掉')
  h.assert(!fs.existsSync(path.join(fx.home, '.agent-presets')), '预设那两层空目录都要一起收掉')
  h.assert(!fs.existsSync(fx.backup), `快照目录与备份根都要收掉：${fx.backup}`)
  const d = contentDiff(before, contentMap(fx.home))
  h.eq(d.join(', '), '', `全树（存在性 + 字节）必须回到跑之前；差异：${JSON.stringify(d)}`)
  ev('R03-not-existed', `fixture=${fx.base}\npatchExists=${fs.existsSync(patchFile)}\npresetsExists=${fs.existsSync(path.join(fx.home, '.agent-presets'))}\nbackupExists=${fs.existsSync(fx.backup)}\ndiff=${JSON.stringify(d)}\n\n-- stdout --\n${r.out}`)
})

h.case('R04 recovery-failed-keeps-material-and-exits-nonzero', 'pass', () => {
  const fx = mkFixture('r04')
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home, FAKE_DSH_FAIL: 'add', FAKE_DSH_OCCUPY_TARGET: '1' }), 'r04-restore-fails')
  h.assert(r.code !== 0, `恢复失败必须退出非零（实得 ${r.code}）`)
  h.assert(/恢复失败/.test(r.out), `输出里要有"恢复失败"判词：\n${clip(r.out, 2000)}`)
  h.assert(/保留材料/.test(r.out), `输出里要列出保留的材料（kept）：\n${clip(r.out, 2000)}`)
  h.eq(successClaims(r.out).join(' | '), '', `恢复失败的那次输出不许出现成功判词：${JSON.stringify(successClaims(r.out))}`)
  // 材料：备份根 + 快照目录 + 快照里的 package.json + 那份 .bak-whale-*
  h.assert(fs.existsSync(fx.backup), `备份根必须保留：${fx.backup}`)
  const snaps = fs.readdirSync(fx.backup).filter((n) => n.endsWith('-pre-whale-sensei'))
  h.eq(snaps.length, 1, `快照目录必须保留（实得 ${JSON.stringify(snaps)}）`)
  h.assert(fs.existsSync(path.join(fx.backup, snaps[0], 'package.json')), '快照里的 package.json 必须保留')
  const baks = fs.readdirSync(fx.profDir).filter((n) => n.startsWith('cordis.patch.yml.bak-whale-'))
  h.eq(baks.length, 1, `那份 .bak-whale-* 必须保留（实得 ${JSON.stringify(baks)}）`)
  for (const p of [fx.backup, path.join(fx.backup, snaps[0]), path.join(fx.backup, snaps[0], 'package.json'), path.join(fx.profDir, baks[0])]) {
    h.assert(r.out.includes(p), `保留材料 ${p} 必须**出现在输出里**（stdout 是调用方唯一的依据）`)
  }
  h.assert(r.out.includes('目标现在是个目录，写不回原字节') || /失败 /.test(r.out), `输出里要说清哪一项没还原：\n${clip(r.out, 2000)}`)
  ev('R04-restore-failed', `fixture=${fx.base}\nexit=${r.code}\nbackup entries=${JSON.stringify(snaps)}\nbak files=${JSON.stringify(baks)}\nsuccessClaims=${JSON.stringify(successClaims(r.out))}\n\n-- stdout --\n${r.out}`)
})

h.case('R05 add-targets-unenumerable-refuses-transaction', 'pass', () => {
  const fx = mkFixture('r05')
  const dry = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home }), 'r05-dryrun')
  h.eq(dry.code, 0, `-DryRun 退出码（实得 ${dry.code}）`)
  const line = (/^PLAN add-targets enumerated=(\w+) :: (.*)$/m.exec(dry.out) ?? [])
  h.assert(line.length === 3, `计划里要有"dsh add 可能改动的目标"清单：\n${clip(dry.out, 2500)}`)
  h.eq(line[1], 'True', '正常夹具里这份清单是可枚举的')
  h.assert(line[2].includes(path.join(fx.profDir, 'package.json')), `清单里要有 profile package.json：${line[2]}`)
  h.assert(line[2].includes(path.join(fx.profDir, 'pnpm-lock.yaml')), `清单里要有 pnpm-lock.yaml：${line[2]}`)
  const before = contentMap(fx.home)
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home, FAKE_DSH_TARGETS_INCOMPLETE: '1' }), 'r05-refuse')
  h.assert(r.code !== 0, `无法完整枚举 ⇒ 必须退出非零（实得 ${r.code}）`)
  h.assert(/无法完整枚举/.test(r.out), `输出里要有说明文案：\n${clip(r.out, 2000)}`)
  h.assert(/拒绝事务安装/.test(r.out), `输出里要有"拒绝事务安装"：\n${clip(r.out, 2000)}`)
  const d = contentDiff(before, contentMap(fx.home))
  h.eq(d.join(', '), '', `拒绝之后**一个字节都没写**（全树不变）；差异：${JSON.stringify(d)}`)
  h.assert(!fs.existsSync(fx.backup), `拒绝事务安装时连备份根都不许建出来：${fx.backup}`)
  h.eq(successClaims(r.out).join(' | '), '', `拒绝的那次输出不许出现成功判词：${JSON.stringify(successClaims(r.out))}`)
  ev('R05-refuse', `fixture=${fx.base}\nplan line=${JSON.stringify(line)}\nexit=${r.code}\ndiff=${JSON.stringify(d)}\nbackupExists=${fs.existsSync(fx.backup)}\n\n-- stdout --\n${r.out}`)
})

h.case('R06 preset-tree-in-writes', 'pass', () => {
  h.assert(NORMAL.fx, 'K05 的正常安装在（用例顺序错了？）')
  const presetDir = path.join(NORMAL.fx.home, '.agent-presets', 'whale-mode')
  h.assert(fs.existsSync(presetDir), `正常安装后预设树真的落在夹具 home：${presetDir}`)
  const landed = fs.readdirSync(presetDir).filter((n) => fs.statSync(path.join(presetDir, n)).isFile()).sort()
  h.assert(landed.length >= 2, `预设树里确实有多个文件（实得 ${JSON.stringify(landed)}）`)
  const wl = planWrites(NORMAL.planOut).map(writesOf)
  const presetRecords = wl.filter((w) => w.path.startsWith(presetDir + path.sep))
  h.eq(presetRecords.length, landed.length, `预设树里**每个文件**各有一条 writes（实得 ${presetRecords.length} 条 vs ${landed.length} 个文件）：${JSON.stringify(presetRecords.map((w) => w.path))}`)
  for (const name of landed) {
    const rec = presetRecords.find((w) => w.path === path.join(presetDir, name))
    h.assert(rec, `预设文件 ${name} 必须**逐条**出现在 writes 里：${JSON.stringify(presetRecords.map((w) => w.path))}`)
    h.eq(rec.existed, false, `${name} 本来不存在 ⇒ existed=false（不是"整棵目录一句话带过"）`)
  }
  h.assert(!wl.some((w) => w.path === presetDir), 'writes 里不许只记那层目录（要逐文件）')
  ev('R06-preset-writes', `presetDir=${presetDir}\nlanded=${JSON.stringify(landed)}\nwrites=${JSON.stringify(presetRecords)}\n\n-- PLAN writes --\n${planWrites(NORMAL.planOut).join('\n')}`)
})

// ══════════════════════════════════════════════════════ H：同一个显式 home
h.case('H01 same-home-dsh-and-node', 'pass', () => {
  h.assert(NORMAL.fx && NORMAL.r, 'K05 的正常安装在（用例顺序错了？）')
  const fx = NORMAL.fx
  h.eq(NORMAL.r.code, 0, '正常安装 exit 0（H01 才有意义）')
  const calls = logOf(fx)
  const dshCalls = calls.filter((c) => c.tool === 'dsh')
  const nodeCalls = calls.filter((c) => c.tool === 'node')
  h.assert(dshCalls.length >= 2, `正常安装至少两次 dsh 调用（plugin add 与 dump-config）：${dshCalls.length}`)
  h.eq(nodeCalls.length, 1, `正常安装恰好一次 node 调用（preset-install）：${nodeCalls.length}`)
  for (const c of dshCalls) h.eq(c.dshHomeEnv, fx.home, `fake dsh 看到的 DSH_HOME 必须是夹具 home：${JSON.stringify(c.argv)}`)
  const node = nodeCalls[0]
  h.eq(node.dshHomeArg, fx.home, 'fake node 收到的 --dsh-home 必须是夹具 home')
  h.eq(node.dshHomeEnv, fx.home, 'fake node 看到的 DSH_HOME 也必须是夹具 home')
  h.eq(planHome(NORMAL.planOut), fx.home, '计划里的 home 与上面三者一致')
  h.assert(dshCalls.some((c) => c.argv.includes('add')), '两次 dsh 里有一次是 plugin add')
  h.assert(dshCalls.some((c) => c.argv.includes('--dump-config')), '两次 dsh 里有一次是 --dump-config')
  ev('H01-same-home', `fixture=${fx.home}\nplan home=${planHome(NORMAL.planOut)}\ndash calls=${JSON.stringify(dshCalls, null, 2)}\nnode call=${JSON.stringify(node, null, 2)}`)
})

h.case('H02 same-home-when-caller-home-differs', 'pass', () => {
  const fx = mkFixture('h02')
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.caller }), 'h02-caller-other-home')
  h.eq(r.code, 0, `调用者环境故意设另一个 DSH_HOME（${fx.caller}）时，安装仍必须成功（实得 ${r.code}）：\n${clip(r.out + r.err, 2500)}`)
  const calls = logOf(fx).filter((c) => c.tool === 'dsh')
  h.assert(calls.length >= 2, `至少两次 dsh 调用（实得 ${calls.length}）`)
  for (const c of calls) h.eq(c.dshHomeEnv, fx.home, `调用者 DSH_HOME 是另一个目录时，dsh 调用**仍**必须落在夹具 home：${JSON.stringify(c.argv)}`)
  const node = logOf(fx).find((c) => c.tool === 'node')
  h.eq(node.dshHomeArg, fx.home, 'node 收到的 --dsh-home 仍是夹具 home')
  h.eq(node.dshHomeEnv, fx.home, 'node 看到的 DSH_HOME 仍是夹具 home')
  h.eq(planHome((runInstaller(fx, dumpArgs(fx), fixtureEnv(fx, { DSH_HOME: fx.caller }), 'h02-dryrun')).out), fx.home, 'H01 的三者一致仍成立（计划 home == 夹具 home）')
  // 负向控制：T22 **之前**那份（`${T22_BASELINE_REV}`，钉死的 revision，不用会随提交漂移的 HEAD）在同一夹具上，dsh 调用会落在调用者那个 home 上
  h.assert(BASELINE_OK, '拿不到基线实现 —— 负向控制做不了')
  const bl = mkFixture('h02-baseline', { installer: BASELINE_PS1 })
  const blArgs = [...baseArgs(), '-PackageDir', REPO, '-PackRoot', bl.pack]
  const blr = runInstaller(bl, blArgs, fixtureEnv(bl, { DSH_HOME: bl.caller }), 'h02-baseline-caller-other-home')
  const blCalls = logOf(bl).filter((c) => c.tool === 'dsh')
  h.assert(blCalls.length > 0, `基线那次也要真的起 dsh（否则负向控制是空转）：${JSON.stringify(logOf(bl))}`)
  h.assert(blCalls.some((c) => c.dshHomeEnv === bl.caller) || blr.code !== 0, `基线（${T22_BASELINE_REV}）在调用者 home 不同时确实落错了 home 或直接失败：exit=${blr.code} calls=${JSON.stringify(blCalls.map((c) => c.dshHomeEnv))}`)
  h.assert(!blCalls.some((c) => c.dshHomeEnv === bl.home) || blr.code !== 0, '基线那次不该出现"两条调用都落在夹具 home 且装成功"')
  ev('H02-caller-differs', `fixture home=${fx.home}\ncaller home=${fx.caller}\nexit=${r.code}\ndash calls=${JSON.stringify(calls, null, 2)}\n--- baseline（HEAD）负向控制 ---\nexit=${blr.code}\ndash calls=${JSON.stringify(blCalls.map((c) => ({ argv: c.argv, dshHomeEnv: c.dshHomeEnv })), null, 2)}`)
})

h.case('H03 finally-restores-caller-environment', 'pass', () => {
  // (a) 调用者设了另一个 DSH_HOME ⇒ 跑完仍是那个值
  const fx = mkFixture('h03a')
  const r1 = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.caller }), 'h03a-caller-set')
  h.eq(r1.code, 0, `退出码（实得 ${r1.code}）：\n${clip(r1.out + r1.err, 2000)}`)
  const has1 = /^WHALE_OUTER_HAS=(True|False)$/m.exec(r1.out)
  const val1 = /^WHALE_OUTER_DSH_HOME=\[(.*)\]$/m.exec(r1.out)
  h.assert(has1 && val1, `外层 PowerShell 的值要打得出来：\n${clip(r1.out, 1500)}`)
  h.eq(has1[1], 'True', '调用者原来设了 ⇒ 结束时仍要设着')
  h.eq(val1[1], fx.caller, `结束时 DSH_HOME 必须仍是调用者原值（实得 ${JSON.stringify(val1[1])}）`)
  // (b) 调用者**没设** DSH_HOME ⇒ 跑完仍是"没设"
  const fx2 = mkFixture('h03b')
  const env2 = fixtureEnv(fx2, {})
  delete env2.DSH_HOME
  const r2 = runInstaller(fx2, [...baseArgs(), '-PackRoot', fx2.pack], env2, 'h03b-caller-unset')
  h.eq(r2.code, 0, `DSH_HOME 没设时也要装成功（说明 home 是从 dsh 命令上溯找出来的）（实得 ${r2.code}）：\n${clip(r2.out + r2.err, 2500)}`)
  const has2 = /^WHALE_OUTER_HAS=(True|False)$/m.exec(r2.out)
  h.assert(has2, `外层 PowerShell 的值要打得出来：\n${clip(r2.out, 1500)}`)
  h.eq(has2[1], 'False', '调用者原来没设 ⇒ 结束时也必须是"没设"（finally 删掉了它）')
  h.assert(r2.out.includes('DSH_HOME is not set'), '这一段确实是"猜出来的 home"那一路（不是靠 DSH_HOME 撞上的）')
  const calls2 = logOf(fx2).filter((c) => c.tool === 'dsh')
  h.assert(calls2.length >= 2, `那个夹具也要真的起 dsh（实得 ${calls2.length}）`)
  for (const c of calls2) h.eq(c.dshHomeEnv, fx2.home, `临时设的那个 home 必须就是夹具 home：${JSON.stringify(c.argv)}`)
  ev('H03-finally', `(a) caller set: exit=${r1.code} outer has=${has1[1]} outer value=${JSON.stringify(val1[1])} expected=${JSON.stringify(fx.caller)}\n(b) caller unset: exit=${r2.code} outer has=${has2[1]}\nunity calls=${JSON.stringify(calls2.map((c) => ({ argv: c.argv, dshHomeEnv: c.dshHomeEnv })), null, 2)}\n\n-- (a) stdout --\n${r1.out}\n-- (b) stdout --\n${r2.out}`)
})

h.case('H04 preset-lands-in-same-home', 'pass', () => {
  const fx = mkFixture('h04')
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.caller }), 'h04-preset-home')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）：\n${clip(r.out + r.err, 2000)}`)
  const want = path.join(fx.home, '.agent-presets', 'whale-mode', 'agent.cordis.yml')
  h.assert(fs.existsSync(want), `预设必须真的落在夹具 home：${want}`)
  h.assert(!fs.existsSync(path.join(fx.caller, '.agent-presets')), `预设**不许**落在调用者那个不同的 DSH_HOME 下：${fx.caller}`)
  h.assert(!fs.existsSync(path.join(fx.caller, '.agent-presets', 'whale-mode')), '调用者 home 下不许出现 whale-mode')
  const node = logOf(fx).find((c) => c.tool === 'node')
  h.eq(node.dshHomeArg, fx.home, 'fake node 收到的 --dsh-home 证明了它是要往夹具 home 装')
  ev('H04-preset-home', `fixture home=${fx.home}\ncaller home=${fx.caller}\nlanded=${fs.existsSync(want)}\ncallerPresets=${fs.existsSync(path.join(fx.caller, '.agent-presets'))}\nnode call=${JSON.stringify(node)}`)
})

// ══════════════════════════════════════════════════════ V：三次故障注入
const INJECTIONS = [
  { id: 'V01', tag: 'v01', label: 'failure-after-patch（patch 写完之后 preset 那一步失败）', env: { FAKE_NODE_FAIL: '1' } },
  { id: 'V02', tag: 'v02', label: 'failure-after-preset（preset 装完之后 plugin add 失败）', env: { FAKE_DSH_FAIL: 'add' } },
  { id: 'V03', tag: 'v03', label: 'failure-after-add（add 之后 dump-config 判定失败）', env: { FAKE_DSH_FAIL: 'dump' } },
]
const V = {}

function injectionRun (spec) {
  const fx = mkFixture(spec.tag)
  const patchFile = path.join(fx.profDir, 'cordis.patch.yml')
  const pkgFile = path.join(fx.profDir, 'package.json')
  const lockFile = path.join(fx.profDir, 'pnpm-lock.yaml')
  const before = {
    map: contentMap(fx.home),
    patch: shaFile(patchFile),
    pkg: shaFile(pkgFile),
    lock: shaFile(lockFile),
    backupExists: fs.existsSync(fx.backup),
  }
  const r = runInstaller(fx, [...baseArgs(), '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home, ...spec.env }), `${spec.tag}-injected`)
  const after = { map: contentMap(fx.home), patch: shaFile(patchFile), pkg: shaFile(pkgFile), lock: shaFile(lockFile) }
  const d = contentDiff(before.map, after.map)
  ev(`V-${spec.tag}`, `injection=${spec.label}\nenv=${JSON.stringify(spec.env)}\nfixture=${fx.base}\nexit=${r.code}\nbackupExistsBefore=${before.backupExists} backupExistsAfter=${fs.existsSync(fx.backup)}\nbefore patch=${before.patch} after patch=${after.patch}\nbefore pkg  =${before.pkg} after pkg  =${after.pkg}\nbefore lock =${before.lock} after lock =${after.lock}\nfullTreeDiff=${JSON.stringify(d)}\n\n-- stdout --\n${r.out}\n-- stderr --\n${r.err}`)
  return { fx, r, before, after, diff: d }
}

for (const spec of INJECTIONS) {
  h.case(`${spec.id} ${spec.id === 'V01' ? 'failure-after-patch-restores' : spec.id === 'V02' ? 'failure-after-preset-restores' : 'failure-after-add-restores'}`, 'pass', () => {
    const x = injectionRun(spec)
    V[spec.id] = x
    h.assert(x.r.code !== 0, `${spec.label}：注入故障后必须退出非零（实得 ${x.r.code}）`)
    h.assert(/回滚|已恢复/.test(x.r.out), `输出里要有回滚/已恢复判词：\n${clip(x.r.out, 1800)}`)
    h.eq(x.diff.join(', '), '', `全树（存在性 + 字节）必须回到跑之前；差异：${JSON.stringify(x.diff)}`)
    h.eq(x.after.patch, x.before.patch, 'cordis.patch.yml 的字节回到原状')
    h.eq(x.after.pkg, x.before.pkg, 'profile package.json 的字节回到原状（fake plugin add 真的改过它）')
    h.eq(x.after.lock, x.before.lock, 'pnpm-lock.yaml 的字节回到原状（fake plugin add 真的改过它）')
    h.assert(!fs.existsSync(x.fx.backup), `恢复成功后那份快照/备份根也必须收掉（回到跑之前）：${x.fx.backup}`)
    h.assert(!fs.existsSync(path.join(x.fx.home, '.agent-presets', 'whale-mode', 'agent.cordis.yml')) || spec.id === 'V01', 'V02/V03 里预设确实被装过，所以它必须被删掉')
    h.assert(x.before.backupExists === false, '夹具开始时备份根不存在')
  })
}

h.case('V04 no-success-claim-on-failure', 'pass', () => {
  for (const spec of INJECTIONS) {
    h.assert(V[spec.id], `${spec.id} 的注入记录在（用例顺序错了？）`)
  }
  const report = []
  for (const spec of INJECTIONS) {
    const x = V[spec.id]
    const claims = successClaims(x.r.out)
    report.push(`${spec.id}: exit=${x.r.code} claims=${JSON.stringify(claims)}`)
    h.assert(x.r.code !== 0, `${spec.id} 必须退出非零（实得 ${x.r.code}）`)
    h.eq(claims.join(' | '), '', `${spec.id} 的输出里不许出现"成功 / OK / 装好了"类判词：${JSON.stringify(claims)}`)
    h.assert(/回滚|已恢复/.test(x.r.out), `${spec.id} 要明确说它回滚了`)
    h.assert(!/^\s*OK\b/m.test(x.r.out), `${spec.id} 的输出里不许有以 OK 开头的行`)
  }
  ev('V04-no-success-claim', `三次故障各自的成功判词扫描：\n${report.join('\n')}\n\n-- 扫描规则 --\n先滤掉含 不/别/没/NOT/FAIL 的行，再找 /^OK\\b|\\bOK\\b|成功|装好了/。`)
})

h.case('V05 restore-failure-keeps-material', 'pass', () => {
  // 反空转（卡面 §4.1）：把 Restore-InstallPlan 打桩成**空操作**再跑同一批故障 ⇒
  // 目标**不会**回到原状 ⇒ 证明 V01–V03 核的是"字节恢复"而不是 stdout 说了什么。
  const src = stripBom(readText(INSTALLER))
  const lines = src.split('\n')
  const at = lines.findIndex((l) => l.startsWith('function Restore-InstallPlan'))
  h.assert(at >= 0, '找得到 Restore-InstallPlan 的定义开头')
  let end = -1
  for (let i = at + 1; i < lines.length; i++) { if (lines[i] === '}') { end = i; break } }
  h.assert(end > at, `找得到 Restore-InstallPlan 的收尾大括号（实得 ${end}）`)
  const stub = [
    'function Restore-InstallPlan {',
    '    param([hashtable] $Plan)',
    '    # V05 变异：空操作，恒报 ok=$true —— 用它证明 V01–V03 不是空转。',
    '    return @{ schema = "whale-install-restore/1"; plan = $Plan.schema; home = $Plan.home; profile = $Plan.profile; ok = $true; restored = @(); failed = @(); kept = @() }',
    '}',
  ]
  const mutated = [...lines.slice(0, at), ...stub, ...lines.slice(end + 1)].join('\n')
  const stubPath = path.join(SESSION, 'install-whale-sensei.stub-restore.ps1')
  fs.writeFileSync(stubPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(mutated, 'utf8')]))
  const st = parseWith51(stubPath, 'v05-ast-stub')
  h.eq(st.errors, 0, `打桩后的副本也必须能被 5.1 解析（实得 ${st.errors}）`)

  const report = []
  for (const spec of INJECTIONS) {
    const fx = mkFixture(`${spec.tag}-stub`, { installer: stubPath })
    const before = contentMap(fx.home)
    // 副本不在仓里 ⇒ 必须显式 -PackageDir，否则 $PSScriptRoot 会指到临时目录
    const r = runInstaller(fx, [...baseArgs(), '-PackageDir', REPO, '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home, ...spec.env }), `${spec.tag}-stub-restore`)
    const after = contentMap(fx.home)
    const d = contentDiff(before, after)
    const material = fs.existsSync(fx.backup)
    report.push(`${spec.id}(stub): exit=${r.code} treeChanged=${d.length > 0} diff=${JSON.stringify(d)} materialKept=${material}`)
    h.assert(r.code !== 0, `${spec.id}(stub)：任务失败仍必须退出非零（实得 ${r.code}）`)
    h.assert(d.length > 0, `${spec.id}(stub)：Restore-InstallPlan 成了空操作 ⇒ 目标**必须**没回到原状，否则 V01–V03 是空转。treeDiff=${JSON.stringify(d)}`)
    h.assert(d.some((x) => /package\.json$/.test(x)) || d.some((x) => /pnpm-lock\.yaml$/.test(x)) || d.some((x) => /cordis\.patch\.yml/.test(x)), `${spec.id}(stub)：至少一个被改过的目标留在原地：${JSON.stringify(d)}`)
    h.assert(material, `${spec.id}(stub)：空操作不删材料 ⇒ 恢复材料保留（这正是本用例名字里的那半条）`)
  }
  // 再证明：同一条注入在**真**实现上会让树回到原样（对照组，与 V01–V03 同一结论）
  const control = []
  for (const spec of INJECTIONS) {
    h.assert(V[spec.id], `${spec.id} 的真实现记录在（用例顺序错了？）`)
    control.push(`${spec.id}(real): exit=${V[spec.id].r.code} treeChanged=${V[spec.id].diff.length > 0}`)
    h.eq(V[spec.id].diff.length, 0, `${spec.id}(real)：真实现下全树必须回到原样`)
  }
  ev('V05-anti-vacuity', `打桩副本：${stubPath}（Restore-InstallPlan 恒返回 ok=true，不写任何东西）\n\n-- 打桩后的三次注入 --\n${report.join('\n')}\n\n-- 同三次注入走真实现（对照）--\n${control.join('\n')}`)
})

// ══════════════════════════════════════════════════════ R11/R12/R13：既有面不许动
h.case('R11 profile-packroot-return-shapes-intact', 'pass', () => {
  const head = GIT_HEAD_FILE[PACKROOT_REL]
  h.assert(head.ok, `git show ${T22_BASELINE_REV}:${PACKROOT_REL} 要拿得到：${JSON.stringify(head.err?.slice(0, 200))}`)
  // ⚠️ T22-R2（第二批）**被迫**改写了这一条：卡面 §3.2 明令在同一个文件里**新增导出**
  //    checkPackRootYml，§3.4 又明令把 patchPackRootYml 的 id 识别修成"带引号的也算"，
  //    所以 R1 那句"整份文件与 HEAD 逐字节相同"在本批**不可能**成立。
  //    这里既没有放宽、也没有藏红：换成了**更严**的逐函数表述 ——
  //    · findProfileDir / writeProfilePackRoot 的**函数体**仍必须与 HEAD 逐字节相同
  //    · patchPackRootYml 的签名一字不动
  //    · 三个既有导出的形参、返回形状、行为（下面那段真跑）照旧逐条判
  const headText = stripBom(runProc('git', ['show', `${T22_BASELINE_REV}:${PACKROOT_REL}`], { timeoutMs: 60000 }).raw.toString('utf8'))
  const workText = readText(PACKROOT_FILE)
  const blockOf = (text, name) => {
    const ls = String(text).split('\n')
    const at = ls.findIndex((l) => new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l))
    if (at < 0) return null
    for (let i = at + 1; i < ls.length; i++) if (ls[i] === '}') return ls.slice(at, i + 1).join('\n')
    return null
  }
  for (const name of ['findProfileDir', 'writeProfilePackRoot']) {
    const a = blockOf(headText, name)
    const b = blockOf(workText, name)
    h.assert(a && b, `两侧都要能切出 ${name} 的函数体（HEAD=${!!a} work=${!!b}）`)
    h.eq(b, a, `${name} 的**函数体**必须与 HEAD 逐字节相同（本批只许新增 checkPackRootYml / 修 patchPackRootYml 的 id 识别）`)
  }
  h.assert(/^export function patchPackRootYml\(text, packRoot\) \{$/m.test(workText), 'patchPackRootYml 的签名一字不动（卡面 §3.2）')
  const names = Object.keys(packrootMod).sort()
  h.eq(names.join(','), ['checkPackRootYml', 'findProfileDir', 'patchPackRootYml', 'writeProfilePackRoot'].join(','), `导出名集合 = R1 那三个 + T22-R2 明令新增的 checkPackRootYml（实得 ${names.join(',')}）`)
  h.eq(packrootMod.patchPackRootYml.length, 2, 'patchPackRootYml(text, packRoot) 的形参数')
  h.eq(packrootMod.findProfileDir.length, 0, 'findProfileDir(opts = {}) 的形参数')
  h.eq(packrootMod.writeProfilePackRoot.length, 1, 'writeProfilePackRoot(packRoot, opts = {}) 的形参数')
  h.eq(packrootMod.checkPackRootYml.length, 1, 'checkPackRootYml(text) 的形参数（T22-R2 新增导出）')
  h.eq(JSON.stringify(packrootMod.checkPackRootYml('')), JSON.stringify({ ok: true, rule: '', reason: '' }), "checkPackRootYml 的返回形状恰好 {ok,rule,reason}，且空文本 ⇒ ok=true / rule='' / reason=''")
  // 返回形状（在夹具上真跑）
  const dir = path.join(SESSION, 'r11')
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), PATCH_BEFORE, 'utf8')
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), PROFILE_PKG, 'utf8')
  const patched = packrootMod.patchPackRootYml(PATCH_BEFORE, 'E:\\x\\pack')
  h.eq(Object.keys(patched).sort().join(','), 'changed,note,text', `patchPackRootYml 的返回字段集（实得 ${Object.keys(patched).sort().join(',')}）`)
  h.assert(['replace', 'insert', 'append'].includes(patched.changed), `changed 取值域：${patched.changed}`)
  const found = packrootMod.findProfileDir({ dshHome: home })
  h.eq(found.ok, true, `findProfileDir 在这份夹具上要 ok：${JSON.stringify(found)}`)
  h.assert(Object.prototype.hasOwnProperty.call(found, 'name') && Object.prototype.hasOwnProperty.call(found, 'dir'), `findProfileDir 的 {ok,name,...} 形状还在：${JSON.stringify(Object.keys(found))}`)
  const w = packrootMod.writeProfilePackRoot(path.join(dir, 'pack'), { dshHome: home })
  h.eq(w.ok, true, `writeProfilePackRoot 要 ok：${JSON.stringify(w)}`)
  for (const k of ['ok', 'file', 'changed', 'note', 'backup']) {
    h.assert(Object.prototype.hasOwnProperty.call(w, k), `writeProfilePackRoot 的 {ok,file,changed,note,backup} 形状还在，缺 ${k}：${JSON.stringify(w)}`)
  }
  h.assert(w.backup && /\.bak-whale-\d{8}-\d{6}$/.test(w.backup), `备份名形状还在：${w.backup}`)
  ev('R11-packroot-shapes', `file=${PACKROOT_FILE}\nhead sha=${head.sha}\nwork sha=${shaFile(PACKROOT_FILE)}（T22-R2 明令新增导出 + 修 id 识别 ⇒ 与本批之前不同，按**逐函数**判）\nexports=${names.join(',')}\n函数体与 HEAD 逐字节相同的：findProfileDir, writeProfilePackRoot\ncheckPackRootYml('') = ${JSON.stringify(packrootMod.checkPackRootYml(''))}\npatchPackRootYml keys=${Object.keys(patched).sort().join(',')}\nfindProfileDir keys=${Object.keys(found).sort().join(',')}\nwriteProfilePackRoot=${JSON.stringify(w)}`)
})

h.case('R12 preset-install-actions-intact', 'pass', () => {
  const head = GIT_HEAD_FILE[PRESET_REL]
  h.assert(head.ok, `git show ${T22_BASELINE_REV}:${PRESET_REL} 要拿得到`)
  h.eq(shaFile(PRESET_FILE), head.sha, `${PRESET_REL} 必须与本批之前（${T22_BASELINE_REV}）逐字节相同 —— 本批明令一个字节都不许动它`)
  const names = Object.keys(presetMod).sort()
  h.eq(names.join(','), ['MARKER', 'PRESET_ID', 'PRESET_ROOT_DIR', 'SKILLS_PLACEHOLDER', 'defaultSrcDir', 'ensurePresetForPack', 'installPreset', 'presetDirFor', 'presetStatus', 'renderComposition', 'resolveDshHome'].sort().join(','), `导出名集合不许变（实得 ${names.join(',')}）`)
  const tmp = path.join(SESSION, 'r12')
  const srcDir = path.join(tmp, 'template')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'agent.cordis.yml'), ['- name: cordis:builtin', '  config:', 'customSkillDirs:', `  - ${presetMod.SKILLS_PLACEHOLDER}`, ''].join('\n'), 'utf8')
  fs.writeFileSync(path.join(srcDir, 'preset.yml'), 'name: 鲸师模式\norder: 1\n', 'utf8')
  const dir = path.join(tmp, 'presets', 'whale-mode')
  const seen = {}
  const reach = (a) => { seen[a] = true }
  reach(presetMod.installPreset({ srcDir, dir }).action)                                   // created
  reach(presetMod.installPreset({ srcDir, dir }).action)                                   // unchanged
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), 'hand written, no marker\n', 'utf8')
  reach(presetMod.installPreset({ srcDir, dir }).action)                                   // kept-hand-edited
  const rendered = presetMod.renderComposition(fs.readFileSync(path.join(srcDir, 'agent.cordis.yml'), 'utf8'), undefined)
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), rendered.split('\n').slice(1).join('\n'), 'utf8')
  reach(presetMod.installPreset({ srcDir, dir }).action)                                   // refreshed（认领旧格式）
  reach(presetMod.installPreset({ srcDir: path.join(tmp, 'nope'), dir: path.join(tmp, 'x') }).action)   // no-template
  const badSrc = path.join(tmp, 'bad-template')
  fs.mkdirSync(badSrc, { recursive: true })
  fs.writeFileSync(path.join(badSrc, 'agent.cordis.yml'), '- name: cordis:builtin\n  config:\n    other: true\n', 'utf8')
  reach(presetMod.installPreset({ srcDir: badSrc, dir: path.join(tmp, 'y') }).action)       // failed
  const actions = Object.keys(seen).sort()
  h.eq(actions.join(','), ['created', 'failed', 'kept-hand-edited', 'no-template', 'refreshed', 'unchanged'].sort().join(','), `installPreset 的六个 action 都要仍可达（实得 ${actions.join(',')}）`)
  ev('R12-preset-actions', `file=${PRESET_FILE}\nhead sha=${head.sha}\nwork sha=${shaFile(PRESET_FILE)}\nexports=${names.join(',')}\nactions reached=${actions.join(',')}`)
})

h.case('R13 existing-suites-green', 'pass', () => {
  const out = []
  const suites = [
    { label: 'preset', argv: [process.execPath, path.join(REPO, 'test', 'preset.mjs')], pass: 76, fail: 0, code: 0, timeoutMs: 300000 },
    { label: 'pack-scaffold', argv: [process.execPath, path.join(REPO, 'test', 'pack-scaffold.mjs'), '--pack=E:\\workplace\\study'], pass: 99, fail: 1, code: 1, timeoutMs: 600000 },
    { label: 'T21', argv: [process.execPath, path.join(REPO, 'test', 'audit', 'T21.mjs')], head: 'PASS T21 checks=31 failed=0 skipped=0', code: 0, timeoutMs: 900000 },    { label: 'all-selftest', argv: [process.execPath, path.join(REPO, 'test', 'all.mjs'), '--selftest'], pass: 17, fail: 0, code: 0, timeoutMs: 600000 },
  ]
  for (const s of suites) {
    const r = logRun(`r13-${s.label}`, runProc(s.argv[0], s.argv.slice(1), { timeoutMs: s.timeoutMs }), `node ${s.argv.slice(1).join(' ')}`)
    out.push(`### ${s.label}: exit=${r.code}\n${clip(r.out + (r.err ? `\n--stderr--\n${r.err}` : ''), 6000)}`)
    if (s.head) {
      const m = new RegExp(`^${s.head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(r.out)
      h.assert(m, `${s.label} 的判词必须逐字是「${s.head}」：\n${clip(r.out + r.err, 2500)}`)
    } else {
      // 各套件的汇总行形状不完全一样（`=== 76 通过 / 0 失败 ===` / `=== selftest: 17 通过 / 0 失败 ===`）：
      // 取**最后一条**"N 通过 / M 失败"，那才是总结论。
      const ms = [...r.out.matchAll(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/g)]
      h.assert(ms.length > 0, `${s.label} 没找到汇总行：\n${clip(r.out.slice(-2500) + r.err, 2500)}`)
      const m = ms[ms.length - 1]
      h.eq(Number(m[1]), s.pass, `${s.label} 通过数`)
      h.eq(Number(m[2]), s.fail, `${s.label} 失败数（既有红不许改绿也不许藏）`)
    }
    h.eq(r.code, s.code, `${s.label} 退出码必须仍是 ${s.code}（实得 ${r.code}）`)
  }
  ev('R13-suites', out.join('\n\n'))
})

// ══════════════════════════════════════════════════════ C：夹具纪律
h.case('C03 fixture-discipline', 'pass', () => {
  let removed = null
  try {
    h.eq(path.resolve(path.dirname(SESSION)), path.resolve(TMP_BASE), `夹具根必须在 ${TMP_BASE} 下`)
    h.assert(path.basename(SESSION).startsWith('whale-T22-R1-'), `夹具根名前缀必须是 whale-T22-R1-（实得 ${path.basename(SESSION)}）`)
    const kids = fs.readdirSync(SESSION)
    h.assert(kids.length >= 8, `夹具里确实建了东西（实得 ${kids.length} 个：${kids.join(', ')}）`)
    h.eq(fpTree(REAL_PROFILES), GUARD.profiles, `真 profiles 树（${REAL_PROFILES}）零改动`)
    h.eq(fpTree(REAL_BACKUP), GUARD.backup, `真 ${REAL_BACKUP} 树零改动`)
    h.eq(fpFocus(), GUARD.focus, '真 profile 的 package.json / cordis.patch.yml 零改动（大小+哈希+mtime）')
    h.eq(fs.existsSync(REAL_PRESETS), GUARD.presets, `真 ${REAL_PRESETS} 的存在性没变`)
    h.assert(!fs.existsSync(REAL_PRESETS) === !GUARD.presets, '真 .agent-presets 的存在性没变')
    h.eq(fpTree(SNAPSHOT_DIR), GUARD.snapshot, `只读快照（${SNAPSHOT_DIR}）零改动`)
    h.eq(fpPack(LIVE_PACK), GUARD.pack, `活包 ${LIVE_PACK} 零改动（文件数/总字节/最新 mtime/顶层条目）`)
    const w = logRun('c03-worktree', runProc('git', ['worktree', 'list'], { timeoutMs: 60000 }))
    const wLines = w.out.split('\n').filter((l) => l.trim())
    h.assert(wLines.some((l) => l.includes('dsh-whale-sensei')), `git worktree list 里必须有本仓主工作树：\n${w.out}`)
    h.assert(!wLines.some((l) => /E:[\\/]Temp/i.test(l)), `本卡不许留下任何 E:\\Temp 下的 worktree：\n${w.out}`)
    ev('C03-discipline', [
      `SESSION=${SESSION}`,
      `real profiles=${REAL_PROFILES} fingerprint=${GUARD.profiles}`,
      `real backup=${REAL_BACKUP} fingerprint=${GUARD.backup}`,
      `focus before:\n${GUARD.focus}`,
      `focus after:\n${fpFocus()}`,
      `snapshot fingerprint=${GUARD.snapshot}`,
      `live pack before=${GUARD.pack}\nlive pack after =${fpPack(LIVE_PACK)}`,
      `fixture children: ${kids.join(', ')}`,
      `worktree list:\n${w.out}`,
    ].join('\n'))
  } finally {
    removed = cleanupOwn()
    ev('C03-cleanup', `${SESSION} removed=${removed.removed} error=${removed.error}\nstillExists=${fs.existsSync(SESSION)}`)
  }
  h.assert(removed.removed, `清理夹具（核实过绝对路径属于本次夹具）：${JSON.stringify(removed)}`)
  h.assert(!fs.existsSync(SESSION), '夹具根已删除')
})

// ══════════════════════════════════════════════════════ Y：YAML 形状（T22-R2 第二批）
/**
 * T22-R2 §3/§4：让**两侧**对同一份 `cordis.patch.yml` 文本给出**相同的接受/拒绝**判定。
 *   PS 侧：`install-whale-sensei.ps1#Test-PatchedYmlShape`（会写盘的路径上，写前拒绝）
 *   JS 侧：`lib/profile-packroot.js#checkPackRootYml`（纯函数）
 * 两边**只按下面这一张表**判（`YAML_SHAPE_TABLE`）—— 禁止各写一套样例或用"看着差不多"比对。
 *
 * 本节的夹具落在**自己的**临时根 `E:\Temp\whale-T22-R2-*` 里（第一批的 C03 收的是它自己那份
 * `whale-T22-R1-*`），收尾同样先核实绝对路径属于本次夹具再删。
 * 原始证据落 `audit-evidence/T22-R2/`（第一批的证据目录是 `T22-R1/`，本批一个字节都不往里写）。
 */
const R2_EVIDENCE = path.join(EVIDENCE_DIR, 'T22-R2')

/** 本批自己的证据写入（UTF-8 带 BOM，给人看；与 harness.evidence 同一约定） */
function ev2 (name, text) {
  const s = String(text)
  const file = path.join(R2_EVIDENCE, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '\uFEFF' + (s.endsWith('\n') ? s : `${s}\n`), 'utf8')
  return file
}

/**
 * T22-R2 §3/§4.1 的**唯一权威形状表**（≥9 例；两边都只用它）。
 * 每例 `{ id, name, text, expect:'accept'|'reject', rule? }`；`rule` 逐字取自
 * §3.1/§3.2 的取值域：inline-target-config / ambiguous-nesting / duplicate-id-sections / non-scalar-id。
 * 接受类里必须含：块映射（无 packRoot）/ 已有 packRoot 就地替换 / 没有这一段（追加）/
 * **别的 id** 下面的 inline config（原样保留，不是拒绝理由）。
 */
const YAML_SHAPE_TABLE = [
  {
    id: 'accept-block-config-no-packroot',
    name: '块 config、还没有 packRoot（就地插一行）',
    expect: 'accept',
    text: ['- id: whale-sensei', '  config:', '    announceOnBoot: true', ''].join('\n'),
  },
  {
    id: 'accept-packroot-inside-config',
    name: 'packRoot 已经在 config 的映射里（就地替换那一行）',
    expect: 'accept',
    text: ['- id: whale-sensei', '  config:', "    packRoot: 'D:/old/pack'", '    announceOnBoot: true', ''].join('\n'),
  },
  {
    id: 'accept-packroot-among-siblings',
    name: 'packRoot 在 config 映射中、前后还有别的键',
    expect: 'accept',
    text: ['- id: whale-sensei', '  config:', "    stylesDir: 'D:/styles'", "    packRoot: 'D:/old/pack'", '    announceOnBoot: false', ''].join('\n'),
  },
  {
    id: 'accept-no-section-append',
    name: '文档里根本没有这一段（追加整段）',
    expect: 'accept',
    text: ['top: 1', '- id: baode', '  config:', "    dataDir: 'D:/baode'", ''].join('\n'),
  },
  {
    id: 'accept-other-id-inline-config',
    name: '**别的 id** 下面是 inline config —— 不是拒绝理由，照旧保留',
    expect: 'accept',
    text: ['- id: whale-sensei', '  config:', '    announceOnBoot: true', '- id: baode', "  config: { dataDir: 'D:/baode' }", ''].join('\n'),
  },
  {
    id: 'accept-single-quoted-id',
    name: "同级 id 带单引号（- id: 'whale-sensei'）",
    expect: 'accept',
    text: ["- id: 'whale-sensei'", '  config:', "    packRoot: 'D:/old/pack'", '    announceOnBoot: true', ''].join('\n'),
  },
  {
    id: 'accept-double-quoted-id',
    name: '同级 id 带双引号（- id: "whale-sensei"）',
    expect: 'accept',
    text: ['- id: "whale-sensei"', '  config:', '    announceOnBoot: true', ''].join('\n'),
  },
  {
    id: 'reject-inline-target-config',
    name: '**目标块里**的 config 是 inline 流式映射',
    expect: 'reject',
    rule: 'inline-target-config',
    text: ['- id: whale-sensei', '  config: { announceOnBoot: true }', ''].join('\n'),
  },
  {
    id: 'reject-ambiguous-nesting',
    name: 'packRoot 与 config 同级（不在 config 的映射里，§3.3 的样例）',
    expect: 'reject',
    rule: 'ambiguous-nesting',
    text: ['- id: whale-sensei', "  packRoot: 'D:/old/pack'", '  config:', '    announceOnBoot: true', ''].join('\n'),
  },
  {
    id: 'reject-duplicate-id-sections',
    name: '文档里两个 - id: whale-sensei 段',
    expect: 'reject',
    rule: 'duplicate-id-sections',
    text: ['- id: whale-sensei', '  config:', '    announceOnBoot: true', '- id: whale-sensei', '  config:', "    packRoot: 'D:/old/pack'", ''].join('\n'),
  },
  {
    id: 'reject-non-scalar-id',
    name: 'id 值是流式序列（非标量）',
    expect: 'reject',
    rule: 'non-scalar-id',
    text: ['- id: [whale-sensei]', '  config:', '    announceOnBoot: true', ''].join('\n'),
  },
]

const Y_KEY_LINE_RE = /(announceOnBoot|baode|dataDir|token|stylesDir)/
const countDashIds = (s) => (String(s).match(/^\s*-\s*id:/gm) ?? []).length
const countIdToken = (s) => (String(s).match(/whale-sensei/g) ?? []).length
/** "这个 id 出现了几次" —— 只数**落在 id 位置上**的那些（追加整段的注释里有 dsh-whale-sensei，不算 id） */
const countWhaleHeads = (s) => (String(s).match(/^\s*-\s*id:\s*['"]?whale-sensei['"]?\s*$/gm) ?? []).length
const hasPlainWhaleHead = (s) => /^\s*-\s*id:\s*['"]?whale-sensei['"]?\s*$/m.test(String(s))

// ── T22-R2 自己的临时夹具根（前缀 whale-T22-R2-；收尾核实绝对路径后删） ──
let YSESSION = null
try {
  YSESSION = fs.mkdtempSync(path.join(TMP_BASE, 'whale-T22-R2-'))
} catch (e) {
  h.block(`建不了 T22-R2 的临时夹具根：${e && e.message ? e.message : String(e)}`)
}

function cleanupY () {
  const abs = path.resolve(String(YSESSION ?? ''))
  if (path.dirname(abs) !== path.resolve(TMP_BASE)) return { removed: false, error: `拒绝清理：${abs} 不在 ${TMP_BASE} 下` }
  if (!path.basename(abs).startsWith('whale-T22-R2-')) return { removed: false, error: `拒绝清理：${path.basename(abs)} 前缀不是 whale-T22-R2-` }
  try { fs.rmSync(abs, { recursive: true, force: true }); return { removed: true, error: null } } catch (e) { return { removed: false, error: `清理失败：${e && e.message ? e.message : String(e)}` } }
}

/** profile 层的 cordis.patch.yml 换成表里那一份，其余夹具照第一批 */
const yFixture = (tag, text) => {
  const fx = mkFixture(tag, { baseDir: YSESSION })
  if (text !== undefined) fs.writeFileSync(path.join(fx.profDir, 'cordis.patch.yml'), text)
  return fx
}

/** 本批专用跑法：原始输出落 `audit-evidence/T22-R2/runs/`（不往 T22-R1 里写），但计入同一个运行索引 */
function runInstallerR2 (fx, args, env, label) {
  const r = runProc(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fx.wrapper, ...args], { env })
  RUNS.push({ label, code: r.code, out: r.out, err: r.err })
  ev2(path.join('runs', `${label}.txt`), `# ${label}\n# exit=${r.code}  signal=${r.signal}  error=${r.error}\n# argv: ${args.join(' ')}\n# fixture: ${fx.base}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`)
  return r
}

/** 真跑一次安装器（-PackRootOnly：唯一会动的就是那份 cordis.patch.yml），读回判定与字节 */
function runShapeOnce (tag, text) {
  const fx = yFixture(tag, text)
  const patchFile = path.join(fx.profDir, 'cordis.patch.yml')
  const before = shaFile(patchFile)
  const r = runInstallerR2(fx, [...baseArgs(), '-PackRootOnly', '-PackRoot', fx.pack], fixtureEnv(fx, { DSH_HOME: fx.home }), `y-${tag}`)
  const exists = fs.existsSync(patchFile)
  const after = exists ? shaFile(patchFile) : 'ABSENT'
  const m = /rule=([a-z][a-z-]*)/.exec(r.out)
  const baks = fs.readdirSync(fx.profDir).filter((n) => n.startsWith('cordis.patch.yml.bak-whale-'))
  return { fx, r, before, after, rule: m ? m[1] : null, text: exists ? readText(patchFile) : null, baks }
}

h.case('Y01 yaml-shape-table-accept-cases', 'pass', () => {
  const chk = packrootMod.checkPackRootYml
  h.eq(typeof chk, 'function', 'profile-packroot.js 必须新增导出 checkPackRootYml（卡面 §3.2）')
  const accepts = YAML_SHAPE_TABLE.filter((c) => c.expect === 'accept')
  h.assert(accepts.length >= 4, `接受类至少 4 例（实得 ${accepts.length}）`)
  // 卡面 §4.1：接受类里必须真的含这四种（缺一种 ⇒ 表被悄悄缩水了）
  for (const need of ['accept-block-config-no-packroot', 'accept-packroot-inside-config', 'accept-no-section-append', 'accept-other-id-inline-config']) {
    h.assert(YAML_SHAPE_TABLE.some((c) => c.id === need && c.expect === 'accept'), `形状表的接受类里必须有 ${need}`)
  }
  const report = []
  for (const c of accepts) {
    const res = chk(c.text)
    h.eq(res.ok, true, `${c.id} 必须被接受：${JSON.stringify(res)}`)
    h.eq(res.rule, '', `${c.id} 接受时 rule 必须是空串（逐字口径）`)
    h.eq(res.reason, '', `${c.id} 接受时 reason 必须是空串`)
    const patched = packrootMod.patchPackRootYml(c.text, 'D:/new/pack')
    h.assert(['replace', 'insert', 'append'].includes(patched.changed), `${c.id} changed 取值域（实得 ${patched.changed}）`)
    h.assert(patched.text.includes("packRoot: 'D:/new/pack'"), `${c.id} 新 packRoot 必须写进去了`)
    // 其它键（announceOnBoot / stylesDir）与**别的 id**（baode、它的 inline config）逐字保留
    const mustKeep = c.text.split('\n').filter((l) => Y_KEY_LINE_RE.test(l) && !/^\s*packRoot\s*:/.test(l))
    for (const l of mustKeep) h.assert(patched.text.includes(l), `${c.id} 其它键/别的 id 必须逐字保留：${JSON.stringify(l)}`)
    // 不许多出 `- id:` 段（"没有这一段就追加"是唯一允许 +1 的情形）
    h.eq(countDashIds(patched.text), countDashIds(c.text) + (hasPlainWhaleHead(c.text) ? 0 : 1), `${c.id} 不许凭空多出 - id: 段`)
    h.eq(countWhaleHeads(patched.text), countWhaleHeads(c.text) + (hasPlainWhaleHead(c.text) ? 0 : 1), `${c.id} whale-sensei 这个 id 不许重复出现（id 位置计数）`)
    // 「嵌套/引号/inline样例不产生重复键」：目标段补丁后仍只有一个 config、config 里只有一个 packRoot
    const pm = blockMapScan(patched.text)
    const ent = pm.entries.find((e) => /-\s*id:\s*['"]?whale-sensei['"]?\s*$/.test(e.head))
    h.assert(ent, `${c.id} 补丁后要能找到 whale-sensei 那一段：\n${patched.text}`)
    h.eq(ent.dup.join(','), '', `${c.id} 补丁后目标段不许有重复键：${JSON.stringify(ent.dup)}`)
    h.eq((ent.map.get('config') ?? []).length, 1, `${c.id} 只能有一个 config 键（不许用正则插第二个 config）`)
    h.eq((ent.map.get('config.packRoot') ?? []).length, 1, `${c.id} config 里只能有一个 packRoot`)
    report.push(`${c.id} [${c.name}] js.ok=${res.ok} changed=${patched.changed} mustKeep=${mustKeep.length}\n--- patched ---\n${patched.text}`)
  }
  ev2(path.join('cases', 'Y01-accept.txt'), report.join('\n\n'))
})

h.case('Y02 yaml-quoted-id-recognised', 'pass', () => {
  const chk = packrootMod.checkPackRootYml
  const variants = [
    { name: 'single-quoted(replace)', text: ["- id: 'whale-sensei'", '  config:', "    packRoot: 'D:/old/pack'", '    announceOnBoot: true', ''].join('\n'), changed: 'replace' },
    { name: 'double-quoted(replace)', text: ['- id: "whale-sensei"', '  config:', "    packRoot: 'D:/old/pack'", '    announceOnBoot: true', ''].join('\n'), changed: 'replace' },
    { name: 'double-quoted(insert)', text: ['top: 1', '- id: "whale-sensei"', '  config:', '    announceOnBoot: false', ''].join('\n'), changed: 'insert' },
  ]
  const report = []
  for (const v of variants) {
    const res = chk(v.text)
    h.eq(res.ok, true, `${v.name}：JS 侧必须接受（卡面 §3.4 要认出带引号的 id）`)
    const before = countDashIds(v.text)
    const patched = packrootMod.patchPackRootYml(v.text, 'D:/new/pack')
    h.eq(patched.changed, v.changed, `${v.name}：必须**就地**改（replace/insert），不是"没有这一段"去追加`)
    h.eq(countIdToken(patched.text), 1, `${v.name}：写出来的文本里 whale-sensei 这个 id 只许出现一次（实得 ${countIdToken(patched.text)}）`)
    h.eq(countWhaleHeads(patched.text), 1, `${v.name}：id 位置上恰好一次 whale-sensei（实得 ${countWhaleHeads(patched.text)}）`)
    h.eq(countDashIds(patched.text), before, `${v.name}：不许多出第二个 - id: 段（${before} → ${countDashIds(patched.text)}）`)
    h.assert(patched.text.includes("packRoot: 'D:/new/pack'"), `${v.name}：新 packRoot 落下去了`)
    h.assert(!patched.text.includes('D:/old/pack'), `${v.name}：旧的 packRoot 值没了`)
    h.assert(patched.text.includes('announceOnBoot'), `${v.name}：其它键保留`)
    report.push(`${v.name}: changed=${patched.changed} whaleToken=${countIdToken(patched.text)} dashIds=${before}->${countDashIds(patched.text)}\n--- ${patched.changed} ---\n${patched.text}`)
  }
  ev2(path.join('cases', 'Y02-quoted-id.txt'), report.join('\n\n'))
})

// ── Y03–Y06：四种"写前拒绝"（零字节 + rule + reason） ──
const Y_REJECTS = [
  ['Y03 yaml-reject-inline-target-config', 'inline-target-config'],
  ['Y04 yaml-reject-ambiguous-nesting', 'ambiguous-nesting'],
  ['Y05 yaml-reject-duplicate-id-sections', 'duplicate-id-sections'],
  ['Y06 yaml-reject-non-scalar-id', 'non-scalar-id'],
]

for (const [cid, rule] of Y_REJECTS) {
  h.case(cid, 'pass', () => {
    const c = YAML_SHAPE_TABLE.find((x) => x.rule === rule)
    h.assert(c && c.expect === 'reject', `形状表里要有 rule='${rule}' 的拒绝例（实得 ${JSON.stringify(YAML_SHAPE_TABLE.filter((x) => x.rule === rule).map((x) => x.id))}）`)
    const js = packrootMod.checkPackRootYml(c.text)
    h.eq(js.ok, false, `JS 侧必须拒绝 ${c.id}：${JSON.stringify(js)}`)
    h.eq(js.rule, rule, `${c.id}（JS 侧）rule 逐字`)

    const run = runShapeOnce(rule, c.text)
    h.assert(run.r.code !== 0, `${c.id}：**写前拒绝** ⇒ 安装器必须退出非零（实得 ${run.r.code}）：\n${clip(run.r.out + run.r.err, 2500)}`)
    h.eq(run.after, run.before, `${c.id}：目标文件 sha256 必须与调用前相同（一个字节都没写）before=${run.before} after=${run.after}`)
    h.eq(run.rule, rule, `${c.id}：安装器文案里给出的 rule`)
    h.assert(run.r.out.includes(`rule=${rule}`), `${c.id}：文案里必须给出 rule=${rule}：\n${clip(run.r.out, 2000)}`)
    h.assert(run.r.out.includes(js.reason), `${c.id}：文案里的 reason 要与 JS 侧同一句\nwant: ${JSON.stringify(js.reason)}\n--- 实得 ---\n${clip(run.r.out, 2000)}`)
    h.assert(/拒绝写入|写前拒绝/.test(run.r.out), `${c.id}：文案要说清"拒绝写入"：\n${clip(run.r.out, 2000)}`)
    h.eq(run.baks.length, 0, `${c.id}：写前拒绝 ⇒ 连那份 .bak-whale-* 都还没建（实得 ${JSON.stringify(run.baks)}）`)
    ev2(path.join('cases', `${cid.split(' ')[0]}-${rule}.txt`), [
      `case=${c.id} [${c.name}]`,
      `table text:\n${c.text}`,
      `JS: ${JSON.stringify(js)}`,
      `fixture=${run.fx.base}`,
      `installer exit=${run.r.code}`,
      `sha256 before=${run.before}\nsha256 after =${run.after}`,
      `parsed rule=${JSON.stringify(run.rule)}`,
      `bak files=${JSON.stringify(run.baks)}`,
      `--- installer stdout ---\n${run.r.out}`,
      `--- installer stderr ---\n${run.r.err}`,
    ].join('\n'))
  })
}

// ── Y07：口径一致（本批最关键的一条） ──
h.case('Y07 ps1-and-js-same-verdicts', 'pass', () => {
  const chk = packrootMod.checkPackRootYml
  const report = []
  let removed = { removed: false, error: '未跑到清理' }
  try {
    // 反空转：表里必须真的既有接受也有拒绝（否则"两边都恒绿"也会过）
    const acc = YAML_SHAPE_TABLE.filter((c) => c.expect === 'accept').length
    const rej = YAML_SHAPE_TABLE.filter((c) => c.expect === 'reject').length
    h.assert(YAML_SHAPE_TABLE.length >= 9, `形状表至少 9 例（实得 ${YAML_SHAPE_TABLE.length}）`)
    h.assert(acc > 0, `表里要有接受例（实得 ${acc}）`)
    h.assert(rej > 0, `表里要有拒绝例（实得 ${rej}）—— 否则"两侧恒绿"也会过`)
    h.assert(rej >= 4, `拒绝例数必须 ≥ 4（实得 ${rej}）`)

    let agree = 0
    for (let i = 0; i < YAML_SHAPE_TABLE.length; i++) {
      const c = YAML_SHAPE_TABLE[i]
      const want = c.expect === 'accept'
      const js = chk(c.text)
      const jsOk = js.ok === true
      h.eq(jsOk, want, `${c.id}（JS 侧）判定：${JSON.stringify(js)}`)
      if (!want) h.eq(js.rule, c.rule, `${c.id}（JS 侧）rule`)

      const run = runShapeOnce(`y07-${String(i).padStart(2, '0')}`, c.text)
      const psOk = run.r.code === 0
      report.push(`${c.id} expect=${c.expect} js.ok=${jsOk} ps.exit=${run.r.code} ps.rule=${JSON.stringify(run.rule)} shaUnchanged=${run.before === run.after}`)
      h.eq(psOk, want, `${c.id}（PS 侧）：安装器 exit=${run.r.code}，期望 ${want ? '接受（0）' : '拒绝（非零）'}\n${clip(run.r.out + run.r.err, 2500)}`)
      h.eq(psOk, jsOk, `${c.id}：两侧 ok 必须相同（JS=${jsOk} PS=${psOk}）`)
      if (psOk === jsOk) agree++

      if (want) {
        h.assert(run.after !== run.before, `${c.id} 接受 ⇒ 目标文件必须真的被改写（before=${run.before} after=${run.after}）`)
        h.assert(run.text && /^\s*packRoot\s*:/m.test(run.text), `${c.id} 接受 ⇒ 写出来的 patch 里必须有 packRoot 行：\n${run.text}`)
        // 真跑出来的文本也不许"多出第二个 config / 多出第二个 - id: 段"（卡面判据原文）
        h.eq(countDashIds(run.text), countDashIds(c.text) + (hasPlainWhaleHead(c.text) ? 0 : 1), `${c.id} 真跑结果不许凭空多出 - id: 段`)
        const pm = blockMapScan(run.text)
        const ent = pm.entries.find((e) => /-\s*id:\s*['"]?whale-sensei['"]?\s*$/.test(e.head))
        h.assert(ent, `${c.id} 真跑结果里要能找到 whale-sensei 那一段：\n${run.text}`)
        h.eq(ent.dup.join(','), '', `${c.id} 真跑结果的目标段不许有重复键：${JSON.stringify(ent.dup)}`)
        h.eq((ent.map.get('config') ?? []).length, 1, `${c.id} 真跑结果里只能有一个 config 键`)
        h.eq((ent.map.get('config.packRoot') ?? []).length, 1, `${c.id} 真跑结果里 config 只能有一个 packRoot`)
        // 别的 id 下面的 inline config 必须原样保留
        for (const l of c.text.split('\n')) {
          if (/^\s*-\s*id:\s*baode\s*$/.test(l) || /dataDir/.test(l)) h.assert(run.text.includes(l), `${c.id} 别的 id 那一段必须原样保留：${JSON.stringify(l)}`)
        }
      } else {
        h.eq(run.after, run.before, `${c.id} 拒绝 ⇒ 目标文件 sha256 必须一字节未动（before=${run.before} after=${run.after}）`)
        h.eq(run.rule, c.rule, `${c.id}（PS 侧）rule 必须与 JS 侧逐字相同`)
        h.assert(run.r.out.includes(`rule=${c.rule}`), `${c.id} 拒绝的文案里要给出 rule=${c.rule}`)
        h.assert(run.r.out.includes(js.reason), `${c.id} 拒绝的文案里要给出与 JS 侧同一句 reason：${JSON.stringify(js.reason)}`)
        h.eq(run.baks.length, 0, `${c.id} 写前拒绝 ⇒ 不出备份文件`)
      }
    }
    h.eq(agree, YAML_SHAPE_TABLE.length, '逐例两边判定一致')

    // Y 跑在 C03 之后 —— 真机守卫在这里再守一次
    h.eq(fpTree(REAL_PROFILES), GUARD.profiles, `真 profiles 树（${REAL_PROFILES}）零改动`)
    h.eq(fpTree(REAL_BACKUP), GUARD.backup, `真 ${REAL_BACKUP} 树零改动`)
    h.eq(fpFocus(), GUARD.focus, '真 profile 的 package.json / cordis.patch.yml 零改动')
    h.eq(fpTree(SNAPSHOT_DIR), GUARD.snapshot, `只读快照（${SNAPSHOT_DIR}）零改动`)
    ev2(path.join('cases', 'Y07-verdicts.txt'), `${report.join('\n')}\n\n-- 表 --\n${JSON.stringify(YAML_SHAPE_TABLE.map((c) => ({ id: c.id, expect: c.expect, rule: c.rule ?? '' })), null, 2)}\n`)
  } finally {
    removed = cleanupY()
    ev2(path.join('cases', 'Y07-cleanup.txt'), `YSESSION=${YSESSION}\nremoved=${removed.removed}\nerror=${removed.error}\nstillExists=${fs.existsSync(YSESSION)}\n`)
  }
  h.assert(removed.removed, `清理 T22-R2 夹具（核实过绝对路径属于本次夹具）：${JSON.stringify(removed)}`)
  h.assert(!fs.existsSync(YSESSION), 'T22-R2 夹具根已删除')
})

// ══════════════════════════════════════════════════════ 收尾
ev('_index-runs', `共 ${RUNS.length} 次子进程：\n${RUNS.map((r) => `  ${r.label} exit=${r.code}`).join('\n')}\n\n完整 stdout/stderr 逐条落在 cases/runs/<label>.txt（同目录，未裁剪）。`)
ev('_index-note', [
  `CARD=${CARD}（T22-R1 第一批：事务可逆 + 同一 home；YAML 形状归 T22-R2）`,
  `INSTALLER=${INSTALLER}`,
  `PS51=${PS51}`,
  `SESSION=${SESSION}（C03 已按路径核实后清理）`,
  '固定用例 ID 集合：§4 代码块 / §4.1 逐条列举的 **25 条**（正文写 26 条，是 6+6+4+5+3+1 的算术落差，',
  '与 T21 同一类：那里正文写 32、实列 31）。没有多造第 26 个 ID，也没有合并任何一条。',
  '⚠️ 风险如实记录：本批"同一 home"的结论是在**夹具 + fake 命令**下得出的，不是真机 dsh plugin add 的现场结论；',
  '   真实宿主集成验证仍是未做项（属发布阻断条件，不由本卡关闭）。',
].join('\n'))

process.exit(h.run())
