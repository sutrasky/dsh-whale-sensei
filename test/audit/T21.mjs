/**
 * test/audit/T21.mjs — DryRun 零副作用，PackRootOnly 先收窄计划（报告 G01 · P1）
 * ========================================================================
 * 卡面判据（**原文**）：「fake dsh/node记录调用，DryRun前后profile/备份/预设全树不变且无安装调用；
 * PackRootOnly只允许目标patch及其明确备份变化。**本次没有运行该安装器。**」
 *
 * 本壳只做一件事：把这条判据变成**能失败**的机械检查。所以它：
 *   ① 夹具全在 `E:\Temp\whale-T21-*`：临时 home（`profiles\web\package.json` + `cordis.patch.yml`）、
 *      临时 `DSH_PLUGIN_BACKUP`、临时 PATH 上的 fake `dsh.cmd` / `node.cmd`（各自把调用追加到
 *      `fake-calls.log`）。fake 命令先被**单独调用一次**，证明"日志为空"这条判据不是空转（S04）。
 *   ② 每次跑安装器都走 **PowerShell 5.1**（`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
 *      —— 判据要的就是 5.1 那个解析器），并经夹具内一个包装脚本把**重定向 stdout 固定成 UTF-8**：
 *      那不是改行为，只是别让证据落成乱码。
 *   ③ "有没有副作用"用**全树差分**判（相对路径 + 大小 + 哈希；目录另算），不靠"看着像"。
 *   ④ 源码级判据走 **PS 5.1 的 AST**（`CommandAst` / `InvokeMemberExpressionAst`），
 *      所以注释与字符串里的同名字样不会被误判；另做一遍源码正则交叉核对并留证。
 *   ⑤ **负向控制 N01/N02** 把基线实现（`git show ba22c94:install-whale-sensei.ps1`）拿回来、用同一夹具
 *      跑 `-DryRun` / `-PackRootOnly`，证明旧行为**真的**会建出备份根并拷走 `package.json`。
 *   ⑥ 全程不碰真 profile（`$env:USERPROFILE\.dsh`）、真 `.dsh-plugin-backup`、真只读快照（N03）。
 *
 * 一行判词：`PASS T21 checks=N failed=0 skipped=0` / `FAIL T21 …` exit1 / `BLOCKED T21 …` exit2。
 * 固定用例 ID 集合见 EXPECTED_IDS（逐字照派发文档 §E 的 31 条；缺 / 多 / 重都算失败，
 * 由 createHarness 的 expectedIds 自检兜底）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createHarness, REPO, clip } from './harness.mjs'

const CARD = 'T21'
const BASE_COMMIT = 'ba22c948016142482f92d054f033c7dec25f2f83'
const TMP_BASE = 'E:\\Temp'
const INSTALLER = path.join(REPO, 'install-whale-sensei.ps1')
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const LIVE_PACK = 'E:\\workplace\\study'

const EXPECTED_IDS = [
  'S01 parse-5.1-current-and-edited',
  'S02 bom-and-lf-preserved',
  'S03 patch-write-no-bom',
  'S04 plan-first-fixture-shape',
  'S05 dryrun-zero-write-full',
  'S06 dryrun-zero-calls-full',
  'S07 dryrun-zero-write-packroot-only',
  'S08 dryrun-zero-calls-packroot-only',
  'S09 dryrun-still-lists-plan',
  'P01 packroot-only-diff-only-patch-and-backup',
  'P02 packroot-only-no-snapshot-dir',
  'P03 packroot-only-profile-package-json-untouched',
  'P04 packroot-only-preset-tree-untouched',
  'P05 packroot-only-no-subprocess',
  'P06 packroot-only-patch-bytes-valid-and-no-bom',
  'P07 packroot-only-without-packroot-noop',
  'O01 dryrun-snapshot-combo-plan-only',
  'O02 dryrun-skip-snapshot-combo',
  'O03 dryrun-skippreset-combo-no-node',
  'O04 normal-install-plan-has-all-steps',
  'O05 skipsnapshot-removes-snapshot-op',
  'O06 packroot-only-ignores-skipsnapshot',
  'R01 single-executor-source-shape',
  'R02 old-params-unchanged',
  'R03 preset-install-callpoint-kept',
  'R04 preflight-behaviour-unchanged',
  'R05 existing-suite-preset-76',
  'C01 restore-plan-entry-shape',
  'N01 negative-control-baseline-dryrun-writes-snapshot',
  'N02 negative-control-baseline-packrootonly-writes-snapshot',
  'N03 fixture-discipline',
]

const h = createHarness({ card: CARD, expectedIds: EXPECTED_IDS, root: LIVE_PACK })
const ev = (name, text) => h.evidence(path.join('cases', `${name}.txt`), String(text).endsWith('\n') ? String(text) : `${text}\n`)

// ───────────────────────────────────────────────────────── 通用小工具
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const readText = (f) => fs.readFileSync(f, 'utf8')
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s)

function decode(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '')
  return stripBom(s).replace(/\r\n/g, '\n')
}

function runProc(cmd, args, opts = {}) {
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

/**
 * 子进程环境：`process.env` 在 Windows 上是**大小写不敏感**的，直接 `{...process.env, PATH: ...}`
 * 会同时留下 `Path` 与 `PATH` 两份（哪份生效看谁先被取到）—— 先清干净再设一份，夹具的 fake PATH 才是确定的。
 */
function childEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
  return { ...env, ...extra }
}

const RUNS = []
function logRun(label, r, extra = '') {
  RUNS.push({ label, code: r.code, out: r.out, err: r.err })
  ev(path.join('runs', label), `# ${label}\n# exit=${r.code}  signal=${r.signal}  error=${r.error}\n# ${extra}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`)
  return r
}

// ───────────────────────────────────────────────────────── 环境闸（缺料一律 BLOCKED）
if (!fs.existsSync(TMP_BASE)) h.block(`本机没有 ${TMP_BASE}（本卡规定临时夹具一律落这里）`)
if (!fs.existsSync(PS51)) h.block(`本机没有 PowerShell 5.1：${PS51}（S01/R01 判据要 5.1 的解析器）`)
else {
  const v = runProc(PS51, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeoutMs: 60000 })
  h.note(`PowerShell 5.1 探针：${PS51} → ${JSON.stringify(v.out.trim())} (exit=${v.code})`)
  if (!/^5\./.test(v.out.trim())) h.block(`那个 powershell.exe 报的版本不是 5.x：${JSON.stringify(v.out.trim())}`)
}

let SESSION = null
try {
  SESSION = fs.mkdtempSync(path.join(TMP_BASE, 'whale-T21-'))
} catch (e) {
  h.block(`建不了临时夹具根：${e && e.message ? e.message : String(e)}`)
}

h.note(
  'ID 集合：派发文档 §E 标题与执行 brief 写"32 条"，但 §E 代码块与 §E1 逐条列举实为 31 条（9+7+6+5+1+3）。' +
    '按"固定用例 ID 全集不许漂移"实现 §E 列举的 31 条，判词 checks=31；规划者复跑请传 --checks=31。'
)

// ───────────────────────────────────────────────────────── 夹具
const PROFILE_PKG = `${JSON.stringify({ name: 'web-profile', version: '0.0.0', private: true }, null, 2)}\n`
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

const WRAPPER_SRC = [
  '# T21 fixture wrapper: pin the redirected stdout to UTF-8 (that is for the evidence file,',
  '# not for the installer behaviour), then run the installer with exactly the arguments this',
  '# wrapper received, and pass its exit code through.',
  "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }",
  "& '__INSTALLER__' @args",
  '$code = $LASTEXITCODE',
  'if ($null -eq $code) { $code = if ($?) { 0 } else { 1 } }',
  'exit $code',
  '',
].join('\n')

const fakeCmdSrc = (name) => {
  const lines = ['@echo off', `echo ${name} %* >> "%WHALE_T21_FAKE_LOG%"`]
  if (name === 'dsh') {
    // 真 dsh 在 --dump-config 时会打印合成后的配置；假命令也照这个形状答一句，
    // 免得"安装器跑到一半因为假命令答空而红"变成夹具假象（T21 本来也不跑真安装路径）。
    lines.push('if "%1"=="plugin" echo   - id: whale-sensei   (fake plugin-add)')
    lines.push('if "%1"=="--profile" if "%3"=="--dump-config" echo   - id: whale-sensei')
  }
  lines.push('exit /b 0', '')
  return lines.join('\r\n')
}

function mkFixture(tag, installerPath = INSTALLER) {
  const base = path.join(SESSION, tag)
  const home = path.join(base, 'home')
  const profDir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profDir, { recursive: true })
  fs.writeFileSync(path.join(profDir, 'package.json'), PROFILE_PKG)
  fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), PATCH_BEFORE)
  const backup = path.join(base, 'backup')
  const bin = path.join(base, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'dsh.cmd'), fakeCmdSrc('dsh'))
  fs.writeFileSync(path.join(bin, 'node.cmd'), fakeCmdSrc('node'))
  const log = path.join(base, 'fake-calls.log')
  const pack = path.join(base, 'pack')
  fs.mkdirSync(path.join(pack, 'presets'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'presets', 'whale-sensei.css'), '/* course pack marker (fixture) */\n')
  const wrapper = path.join(base, 'run-installer.ps1')
  fs.writeFileSync(wrapper, WRAPPER_SRC.split('__INSTALLER__').join(installerPath), 'utf8')
  return { tag, base, home, profDir, backup, bin, log, pack, wrapper, installer: installerPath }
}

function runInstaller(fx, args, label) {
  const env = childEnv({
    DSH_HOME: fx.home,
    DSH_PLUGIN_BACKUP: fx.backup,
    WHALE_T21_FAKE_LOG: fx.log,
    PATH: `${fx.bin};${process.env.PATH ?? process.env.Path ?? ''}`,
  })
  const r = runProc(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fx.wrapper, ...args], { env })
  return logRun(label, r, `argv: ${args.join(' ')}\nfixture: ${fx.base}\ninstaller: ${fx.installer}`)
}

const logText = (fx) => (fs.existsSync(fx.log) ? readText(fx.log) : '')

// ───────────────────────────────────────────────────────── 全树快照 / 差分
function walkTree(root) {
  const out = []
  const seen = new Set() // 逐个解析真路径：junction 绕圈/重复走进同一棵树时立刻停
  const walk = (d, rel) => {
    let real = ''
    try { real = fs.realpathSync(d) } catch { return }
    if (seen.has(real)) return
    seen.add(real)
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) { out.push({ rel: r, kind: 'l' }); continue } // junction/符号链接不跟进去、也不当文件读
      if (e.isDirectory()) { out.push({ rel: r, kind: 'd' }); walk(p, r) }
      else { const st = fs.statSync(p); out.push({ rel: r, kind: 'f', size: st.size, mtimeMs: Math.round(st.mtimeMs), sha: sha(fs.readFileSync(p)) }) }
    }
  }
  if (root && fs.existsSync(root)) walk(root, '')
  return out
}
const onlyFiles = (t) => t.filter((x) => x.kind === 'f')
const onlyDirs = (t) => t.filter((x) => x.kind === 'd').map((x) => x.rel)

function diffTree(a, b) {
  const A = new Map(a.map((x) => [x.rel, x]))
  const B = new Map(b.map((x) => [x.rel, x]))
  const out = []
  for (const [k, v] of B) {
    if (!A.has(k)) out.push(`+${k}`)
    else if (JSON.stringify(A.get(k)) !== JSON.stringify(v)) out.push(`~${k}`)
  }
  for (const k of A.keys()) if (!B.has(k)) out.push(`-${k}`)
  return out.sort()
}

function cleanupOwn() {
  const abs = path.resolve(String(SESSION ?? ''))
  if (path.dirname(abs) !== path.resolve(TMP_BASE)) return { removed: false, error: `拒绝清理：${abs} 不在 ${TMP_BASE} 下` }
  if (!path.basename(abs).startsWith('whale-T21-')) return { removed: false, error: `拒绝清理：${path.basename(abs)} 前缀不是 whale-T21-` }
  try { fs.rmSync(abs, { recursive: true, force: true }); return { removed: true, error: null } } catch (e) { return { removed: false, error: `清理失败：${e && e.message ? e.message : String(e)}` } }
}

// ───────────────────────────────────────────────────────── 真机守卫（真 profile / 真备份根）
const REAL_HOME = os.homedir()
const REAL_DSH = path.join(REAL_HOME, '.dsh')
const REAL_BACKUP = path.join(REAL_HOME, '.dsh-plugin-backup')
const REAL_PRESETS = path.join(REAL_DSH, '.agent-presets')

/** 全树内容指纹：相对路径 + 大小 + 哈希（**不含 mtime**：活宿主的 mtime 抖动不是"改动"） */
function fpTree(root) {
  if (!fs.existsSync(root)) return 'absent'
  return sha(walkTree(root).map((x) => `${x.kind} ${x.rel} ${x.size ?? ''} ${x.sha ?? ''}`).join('\n'))
}
/** 重点文件指纹：大小 + 哈希 + mtime（这里是**本卡最可能误伤**的东西，mtime 也算改动） */
function fpFocus() {
  return [path.join(REAL_DSH, 'profiles', 'web', 'package.json'), path.join(REAL_DSH, 'profiles', 'web', 'cordis.patch.yml')]
    .map((f) => {
      if (!fs.existsSync(f)) return `${f} absent`
      const st = fs.statSync(f)
      return `${f} ${st.size} ${Math.round(st.mtimeMs)} ${sha(fs.readFileSync(f))}`
    })
    .join('\n')
}
const GUARD = {
  dsh: fpTree(REAL_DSH),
  backup: fpTree(REAL_BACKUP),
  focus: fpFocus(),
  presets: fs.existsSync(REAL_PRESETS),
}

// ───────────────────────────────────────────────────────── 基线实现（负向控制用）
const BASELINE_PS1 = SESSION ? path.join(SESSION, 'baseline-install-whale-sensei.ps1') : null
let BASELINE_OK = false
if (SESSION) {
  const g = runProc('git', ['show', `${BASE_COMMIT}:install-whale-sensei.ps1`], { timeoutMs: 60000 })
  if (g.code === 0 && g.out.length > 1000) {
    fs.writeFileSync(BASELINE_PS1, g.raw) // **按字节写**：基线那份的 UTF-8 BOM 必须原样留着
    BASELINE_OK = true
  }
  logRun('baseline-git-show', g, `git show ${BASE_COMMIT}:install-whale-sensei.ps1 → ${BASELINE_OK ? BASELINE_PS1 : 'FAILED'}`)
}

// ───────────────────────────────────────────────────────── 一个空闲端口（别撞上真宿主 3090）
const FREE_PORT = await new Promise((res) => {
  const s = net.createServer()
  s.on('error', () => res(0))
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const baseArgs = () => ['-HostPort', String(FREE_PORT)]
h.note(`夹具用空闲端口 -HostPort ${FREE_PORT}（真宿主可能还在 3090 上，-SkipHostCheck 属于回避，不用它）`)

// ───────────────────────────────────────────────────────── PS 5.1 AST 探针（S01 / R01 共用）
const AST_PROBE = SESSION ? path.join(SESSION, 'ast-probe.ps1') : null
const AST_PROBE_SRC = [
  'param([string] $Path)',
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
  '$tok = $null; $errs = $null',
  '$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tok, [ref]$errs)',
  'Write-Output ("AST_PARSE_ERRORS=" + $errs.Count)',
  'foreach ($e in $errs) { Write-Output ("AST_ERR|" + $e.Extent.StartLineNumber + "|" + $e.Message) }',
  'function Get-EnclosingFunc($n) { $p = $n; while ($p) { if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $p.Name }; $p = $p.Parent }; return "-" }',
  'foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Write-Output ("AST_FUNC|" + $f.Name + "|" + $f.Extent.StartLineNumber + "|" + $f.Extent.EndLineNumber) }',
  'foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {',
  '    $els = $c.CommandElements; $first = ""; if ($els.Count -gt 0) { $first = $els[0].Extent.Text }',
  '    $first = $first.Replace("`t", " ").Replace("`n", " ").Replace("|", "/")',
  '    $nm = [string]$c.GetCommandName()',
  '    Write-Output ("AST_CMD|" + $c.Extent.StartLineNumber + "|" + $c.InvocationOperator + "|" + $nm + "|" + $first + "|" + (Get-EnclosingFunc $c))',
  '}',
  'foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) { Write-Output ("AST_MEMBER|" + $m.Extent.StartLineNumber + "|" + $m.Member.Extent.Text + "|" + (Get-EnclosingFunc $m)) }',
  '',
].join('\n')

if (SESSION) fs.writeFileSync(AST_PROBE, AST_PROBE_SRC, 'utf8')

/** 用 5.1 解析一个文件，把 AST 事实结构化（只读，不执行它） */
function parseWith51(file, label) {
  const r = logRun(label, runProc(PS51, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AST_PROBE, file]), `ParseFile ${file}`)
  const m = /AST_PARSE_ERRORS=(\d+)/.exec(r.out)
  const errs = [...r.out.matchAll(/^AST_ERR\|(\d+)\|(.*)$/gm)].map((x) => ({ line: Number(x[1]), message: x[2] }))
  const funcs = {}
  for (const x of r.out.matchAll(/^AST_FUNC\|([^|]+)\|(\d+)\|(\d+)$/gm)) funcs[x[1]] = { start: Number(x[2]), end: Number(x[3]) }
  const cmds = [...r.out.matchAll(/^AST_CMD\|(\d+)\|(\w+)\|([^|]*)\|([^|]*)\|([^|]*)$/gm)].map((x) => ({ line: Number(x[1]), op: x[2], name: x[3], first: x[4], func: x[5] }))
  const members = [...r.out.matchAll(/^AST_MEMBER\|(\d+)\|([^|]*)\|([^|]*)$/gm)].map((x) => ({ line: Number(x[1]), member: x[2], func: x[3] }))
  return { run: r, code: r.code, errors: m ? Number(m[1]) : null, parseErrors: errs, funcs, cmds, members }
}
const astFacts = () => parseWith51(INSTALLER, 'ast-installer')

// ══════════════════════════════════════════════════════ S：脚本静态面
h.case('S01 parse-5.1-current-and-edited', 'pass', () => {
  h.assert(fs.existsSync(PS51), `没有 PowerShell 5.1：${PS51}`)
  const cur = astFacts()
  h.assert(cur.code === 0, 'PS 5.1 解析探针进程必须退出 0')
  h.assert(cur.errors !== null, '探针没有报告 AST_PARSE_ERRORS')
  h.eq(cur.errors, 0, `磁盘上的（已改）安装器用 5.1 解析必须 0 错：${JSON.stringify(cur.parseErrors.slice(0, 3))}`)
  h.assert(BASELINE_OK, '基线安装器（git show）拿得到，才能拿它对照同一解析器')
  const bl = parseWith51(BASELINE_PS1, 'ast-baseline')
  h.eq(bl.errors, 0, `基线安装器用 5.1 解析也必须 0 错（同一解析器、同一判据在改前改后都成立）`)
  ev('S01-parse-5.1', `current: exit=${cur.code} parse-errors=${cur.errors}\nbaseline(${BASE_COMMIT}): exit=${bl.code} parse-errors=${bl.errors}\n\n-- current raw --\n${clip(cur.run.out, 8000)}`)
})

h.case('S02 bom-and-lf-preserved', 'pass', () => {
  const b = fs.readFileSync(INSTALLER)
  h.eq(b.subarray(0, 3).toString('hex'), 'efbbbf', '安装器前三字节必须仍是 UTF-8 BOM（PS 5.1 否则按 ANSI 读中文注释）')
  const text = b.toString('utf8')
  const crlf = (text.match(/\r\n/g) || []).length
  h.eq(crlf, 0, '安装器必须全 LF（CRLF 计数）')
  const lf = (text.match(/\n/g) || []).length
  h.assert(lf > 400, `安装器还是那份长脚本（LF 计数 ${lf}）`)
  h.assert(/\[CmdletBinding\(\)\]/.test(text), '脚本头 [CmdletBinding()] 还在')
  ev('S02-bytes', `file=${INSTALLER}\nbytes=${b.length}\nfirst3=${b.subarray(0, 3).toString('hex')}\ncrlf=${crlf}\nlf=${lf}`)
})

h.case('S03 patch-write-no-bom', 'pass', () => {
  const src = readText(INSTALLER)
  const writeLines = src.split('\n').filter((l) => /\[System\.IO\.File\]::WriteAllText\(/.test(l))
  h.eq(writeLines.length, 1, `写盘语句恰好一条（实得 ${writeLines.length}）`)
  h.assert(/New-Object System\.Text\.UTF8Encoding\(\$false\)/.test(writeLines[0]), `写 cordis.patch.yml 必须仍用 UTF8Encoding($false)：${writeLines[0].trim()}`)
  h.assert(!/UTF8Encoding\(\s*\$true\s*\)/.test(src), '安装器里不许出现带 BOM 的 UTF8Encoding($true)')
  const fx = mkFixture('s03')
  const r = runInstaller(fx, [...baseArgs(), '-PackRootOnly', '-PackRoot', fx.pack], 's03-packrootonly')
  h.eq(r.code, 0, `PackRootOnly 退出码（实得 ${r.code}）`)
  const pb = fs.readFileSync(path.join(fx.profDir, 'cordis.patch.yml'))
  h.assert(pb.subarray(0, 3).toString('hex') !== 'efbbbf', `真跑出来的 cordis.patch.yml 不得带 BOM（前三字节 ${pb.subarray(0, 3).toString('hex')}）`)
  ev('S03-patch-bytes', `源码里的写盘语句：\n${writeLines[0]}\n\n真跑后 written first3=${pb.subarray(0, 3).toString('hex')} bytes=${pb.length}\n--- content ---\n${pb.toString('utf8')}`)
})

h.case('S04 plan-first-fixture-shape', 'pass', () => {
  const fx = mkFixture('s04')
  h.assert(fs.existsSync(path.join(fx.profDir, 'package.json')), '临时 home 里真有 profiles\\web\\package.json')
  h.assert(fs.existsSync(path.join(fx.profDir, 'cordis.patch.yml')), '临时 home 里真有 profiles\\web\\cordis.patch.yml')
  h.assert(!fs.existsSync(fx.backup), '夹具开始时 DSH_PLUGIN_BACKUP 目录**不存在**（S05/P02 的判据才有意义）')
  h.assert(fs.existsSync(path.join(fx.bin, 'dsh.cmd')), '临时 PATH 上有 fake dsh.cmd')
  h.assert(fs.existsSync(path.join(fx.bin, 'node.cmd')), '临时 PATH 上有 fake node.cmd')
  h.assert(!fs.existsSync(fx.log), '跑之前 fake-calls.log 不存在')
  const env = childEnv({ WHALE_T21_FAKE_LOG: fx.log, PATH: `${fx.bin};${process.env.PATH ?? process.env.Path ?? ''}` })
  const r1 = logRun('s04-fake-node', runProc('cmd.exe', ['/c', path.join(fx.bin, 'node.cmd'), '-v'], { env }), 'fake node 单独调用')
  const r2 = logRun('s04-fake-dsh', runProc('cmd.exe', ['/c', path.join(fx.bin, 'dsh.cmd'), 'plugin', '--help'], { env }), 'fake dsh 单独调用')
  h.eq(r1.code, 0, 'fake node 单独调用退出码')
  h.eq(r2.code, 0, 'fake dsh 单独调用退出码')
  h.assert(fs.existsSync(fx.log), 'fake 命令被单独调用后 fake-calls.log 必须出现（否则"日志为空"是空转）')
  const t = readText(fx.log)
  h.assert(/node -v/.test(t), `fake node 把调用写进了日志：${JSON.stringify(t)}`)
  h.assert(/dsh plugin --help/.test(t), `fake dsh 把调用写进了日志：${JSON.stringify(t)}`)
  ev('S04-fixture', `fixture=${fx.base}\nlog=${JSON.stringify(t)}\nnode exit=${r1.code} dsh exit=${r2.code}`)
})

h.case('S05 dryrun-zero-write-full', 'pass', () => {
  const fx = mkFixture('s05')
  const before = walkTree(fx.home)
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 's05-dryrun-full')
  const after = walkTree(fx.home)
  h.eq(r.code, 0, `-DryRun 退出码（实得 ${r.code}）`)
  const d = diffTree(before, after)
  h.eq(d.join(','), '', `-DryRun 前后 profile 全树（path+size+mtime+sha）必须逐字节不变；差异：${d.join(', ')}`)
  h.assert(!fs.existsSync(fx.backup), `${fx.backup} 目录在 -DryRun 之后**必须不存在**（G01 病根就是这个）`)
  ev('S05-tree', `fixture=${fx.base}\nbackupExists=${fs.existsSync(fx.backup)}\ndiff=${JSON.stringify(d)}\nbefore=${before.length} after=${after.length}\n\nstdout:\n${r.out}`)
})

h.case('S06 dryrun-zero-calls-full', 'pass', () => {
  const fx = mkFixture('s06')
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 's06-dryrun-calls')
  const calls = logText(fx)
  h.eq(calls, '', `-DryRun 不得起任何 dsh/node 子进程；fake-calls.log = ${JSON.stringify(calls)}`)
  h.eq(r.code, 0, `-DryRun 退出码（实得 ${r.code}）`)
  ev('S06-calls', `logExists=${fs.existsSync(fx.log)}\nlog=${JSON.stringify(calls)}\nexit=${r.code}\n\nstdout:\n${r.out}`)
})

h.case('S07 dryrun-zero-write-packroot-only', 'pass', () => {
  const fx = mkFixture('s07')
  const before = walkTree(fx.home)
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRootOnly', '-PackRoot', fx.pack], 's07-dryrun-packrootonly')
  const after = walkTree(fx.home)
  const d = diffTree(before, after)
  h.eq(d.join(','), '', `-DryRun -PackRootOnly 前后全树必须不变；差异：${d.join(', ')}`)
  h.assert(!fs.existsSync(fx.backup), 'DSH_PLUGIN_BACKUP 目录不许存在')
  h.eq(logText(fx), '', 'fake 调用日志必须为空')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  ev('S07-tree', `diff=${JSON.stringify(d)} backupExists=${fs.existsSync(fx.backup)}\n\nstdout:\n${r.out}`)
})

h.case('S08 dryrun-zero-calls-packroot-only', 'pass', () => {
  const fx = mkFixture('s08')
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRootOnly', '-PackRoot', fx.pack], 's08-dryrun-packrootonly-calls')
  const calls = logText(fx)
  h.eq(calls, '', `零子进程（fake-calls.log = ${JSON.stringify(calls)}）`)
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  ev('S08-calls', `log=${JSON.stringify(calls)} exit=${r.code}\n\nstdout:\n${r.out}`)
})

h.case('S09 dryrun-still-lists-plan', 'pass', () => {
  const fx = mkFixture('s09')
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 's09-dryrun-stdout')
  h.assert(/^PLAN schema=whale-install-plan\/1 mode=install dryRun=True$/m.test(r.out), `stdout 里要有一行计划头：\n${clip(r.out, 2000)}`)
  h.assert(r.out.includes('kind=snapshot'), '计划里要看得到 snapshot 这个 kind')
  h.assert(r.out.includes('kind=patch-write'), '计划里要看得到 patch-write 这个 kind')
  h.assert(r.out.includes(path.join(fx.profDir, 'cordis.patch.yml')), '计划里要看得到目标 patch 的绝对路径')
  h.assert(r.out.includes(fx.pack.split('\\').join('/')), '计划里要看得到 packRoot 的新值（不是"什么都没打印"）')
  ev('S09-stdout', r.out)
})

// ══════════════════════════════════════════════════════ P：PackRootOnly 的真实副作用面
const P = { fx: null, before: null, after: null, r: null, pkgBefore: null, presetBefore: null, diff: null }

h.case('P01 packroot-only-diff-only-patch-and-backup', 'pass', () => {
  P.fx = mkFixture('p01')
  P.pkgBefore = fs.readFileSync(path.join(P.fx.profDir, 'package.json'))
  P.presetBefore = walkTree(path.join(P.fx.home, '.agent-presets'))
  P.before = walkTree(P.fx.home)
  P.r = runInstaller(P.fx, [...baseArgs(), '-PackRootOnly', '-PackRoot', P.fx.pack], 'p01-packrootonly')
  P.after = walkTree(P.fx.home)
  h.eq(P.r.code, 0, `-PackRootOnly 退出码（实得 ${P.r.code}）：\n${clip(P.r.out + P.r.err, 1500)}`)
  const newDirs = onlyDirs(P.after).filter((d) => !onlyDirs(P.before).includes(d))
  h.eq(newDirs.join(','), '', `-PackRootOnly 不许新建任何目录（新建了：${newDirs.join(', ')}）`)
  const files = diffTree(onlyFiles(P.before), onlyFiles(P.after))
  P.diff = files
  h.eq(files.length, 2, `全树差分必须**恰好两项**（实得 ${JSON.stringify(files)}）`)
  const changed = files.filter((x) => x.startsWith('~'))
  const added = files.filter((x) => x.startsWith('+'))
  h.eq(changed.join(','), '~profiles/web/cordis.patch.yml', `被改的恰好是目标 patch（实得 ${JSON.stringify(changed)}）`)
  h.eq(added.length, 1, `新增的恰好一份备份（实得 ${JSON.stringify(added)}）`)
  h.assert(/^\+profiles\/web\/cordis\.patch\.yml\.bak-whale-\d{8}-\d{6}$/.test(added[0] ?? ''), `备份名形如 .bak-whale-<yyyyMMdd-HHmmss>（实得 ${added[0]}）`)
  ev('P01-diff', `fixture=${P.fx.base}\nbefore-tree=${P.before.length} after-tree=${P.after.length}\nfile-diff=${JSON.stringify(files)}\nnew-dirs=${JSON.stringify(newDirs)}\n\nstdout:\n${P.r.out}`)
})

h.case('P02 packroot-only-no-snapshot-dir', 'pass', () => {
  h.assert(P.fx, 'P01 的夹具在（用例顺序错了？）')
  h.assert(!fs.existsSync(P.fx.backup), `${P.fx.backup} 跑完 -PackRootOnly 之后**仍必须不存在**（-SkipSnapshot 没给也一样）`)
  const stray = P.after.filter((x) => /pre-whale-sensei/.test(x.rel))
  h.eq(stray.length, 0, `全树里不许出现任何 *-pre-whale-sensei 快照物：${JSON.stringify(stray)}`)
  ev('P02-no-snapshot-dir', `backupExists=${fs.existsSync(P.fx.backup)}\nstray=${JSON.stringify(stray)}`)
})

h.case('P03 packroot-only-profile-package-json-untouched', 'pass', () => {
  h.assert(P.fx, 'P01 的夹具在')
  const now = fs.readFileSync(path.join(P.fx.profDir, 'package.json'))
  h.eq(sha(now), sha(P.pkgBefore), 'profiles\\web\\package.json 必须逐字节相同（旧行为就是把它拷进快照的）')
  const st = fs.statSync(path.join(P.fx.profDir, 'package.json'))
  ev('P03-package-json', `before sha=${sha(P.pkgBefore)} bytes=${P.pkgBefore.length}\nafter  sha=${sha(now)} bytes=${now.length}\nmtime=${st.mtime.toISOString()}`)
})

h.case('P04 packroot-only-preset-tree-untouched', 'pass', () => {
  h.assert(P.fx, 'P01 的夹具在')
  const dir = path.join(P.fx.home, '.agent-presets')
  const now = walkTree(dir)
  h.eq(JSON.stringify(now), JSON.stringify(P.presetBefore), `.agent-presets 树跑前跑后必须一致（不存在就一直不存在）`)
  h.assert(!fs.existsSync(dir), '这个夹具里 .agent-presets 本来就不存在，跑完也不许出现')
  ev('P04-preset-tree', `exists=${fs.existsSync(dir)} before=${JSON.stringify(P.presetBefore)} after=${JSON.stringify(now)}`)
})

h.case('P05 packroot-only-no-subprocess', 'pass', () => {
  h.assert(P.fx, 'P01 的夹具在')
  h.eq(logText(P.fx), '', '-PackRootOnly 零子进程：fake-calls.log 必须为空')
  ev('P05-calls', `logExists=${fs.existsSync(P.fx.log)} log=${JSON.stringify(logText(P.fx))}`)
})

h.case('P06 packroot-only-patch-bytes-valid-and-no-bom', 'pass', () => {
  h.assert(P.fx, 'P01 的夹具在')
  const pb = fs.readFileSync(path.join(P.fx.profDir, 'cordis.patch.yml'))
  h.assert(pb.subarray(0, 3).toString('hex') !== 'efbbbf', `写出来的 patch 不许带 BOM（前三字节 ${pb.subarray(0, 3).toString('hex')}）`)
  const text = pb.toString('utf8')
  const expectedRoot = P.fx.pack.split('\\').join('/')
  h.assert(text.includes(`packRoot: '${expectedRoot}'`), `patch 里要有新的 packRoot 行：packRoot: '${expectedRoot}'\n--- content ---\n${text}`)
  const oldLines = PATCH_BEFORE.replace(/\n$/, '').split('\n')
  const newLines = text.replace(/\n$/, '').split('\n')
  let idx = -1
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) if (oldLines[i] !== newLines[i]) { idx = i; break }
  h.assert(idx >= 0, 'patch 内容确实变了（否则这条判据没意义）')
  const rest = newLines.slice(0, idx).concat(newLines.slice(idx + 1))
  h.eq(rest.join('\n'), oldLines.join('\n'), '除插入的那一行外，其余每行必须**逐字节不变**（announceOnBoot / baode 段都在里面）')
  h.assert(/^\s*packRoot: '/.test(newLines[idx]), `插入的恰好是一行 packRoot（实得 ${JSON.stringify(newLines[idx])}）`)
  h.assert(newLines.some((l) => l.trim() === 'announceOnBoot: true'), 'announceOnBoot: true 仍在')
  h.assert(newLines.some((l) => l.includes("token: 'keep-me-byte-for-byte'")), "baode 那一段逐字节仍在")
  ev('P06-patch', `first3=${pb.subarray(0, 3).toString('hex')} bytes=${pb.length} inserted-line=${JSON.stringify(newLines[idx])}\n--- content ---\n${text}`)
})

h.case('P07 packroot-only-without-packroot-noop', 'pass', () => {
  const fx = mkFixture('p07')
  const before = walkTree(fx.home)
  const r = runInstaller(fx, [...baseArgs(), '-PackRootOnly'], 'p07-real-noop')
  const after = walkTree(fx.home)
  h.eq(r.code, 0, `没给 -PackRoot 时 -PackRootOnly 仍应 exit 0（实得 ${r.code}）`)
  h.eq(diffTree(before, after).join(','), '', '不给 -PackRoot ⇒ 零写')
  h.assert(!fs.existsSync(fx.backup), '不给 -PackRoot 也不许建备份根')
  h.eq(logText(fx), '', '不给 -PackRoot ⇒ 零子进程')
  const fx2 = mkFixture('p07-dry')
  const r2 = runInstaller(fx2, [...baseArgs(), '-DryRun', '-PackRootOnly'], 'p07-dry-noop')
  h.eq(r2.code, 0, `-DryRun -PackRootOnly 不给 -PackRoot 的退出码（实得 ${r2.code}）`)
  h.assert(!/^PLAN writes /m.test(r2.out), `计划里的 writes 必须是空的：\n${clip(r2.out, 1200)}`)
  h.assert(!/^PLAN op /m.test(r2.out), `计划里不该有任何操作：\n${clip(r2.out, 1200)}`)
  ev('P07-noop', `real: exit=${r.code} log=${JSON.stringify(logText(fx))}\ndry: exit=${r2.code}\n\n-- dry stdout --\n${r2.out}`)
})

// ══════════════════════════════════════════════════════ O：组合与计划形状
const planKinds = (out) => [...out.matchAll(/^PLAN op kind=(\S+) /gm)].map((m) => m[1])
const planWrites = (out) => out.split('\n').filter((l) => l.startsWith('PLAN writes path='))

h.case('O01 dryrun-snapshot-combo-plan-only', 'pass', () => {
  const fx = mkFixture('o01')
  const before = walkTree(fx.home)
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-SkipSnapshot', '-PackRoot', fx.pack], 'o01-dryrun-skipsnapshot')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  h.assert(!planKinds(r.out).includes('snapshot'), `-SkipSnapshot 的计划里不许有 snapshot 操作：${JSON.stringify(planKinds(r.out))}`)
  h.eq(diffTree(before, walkTree(fx.home)).join(','), '', '零写')
  h.assert(!fs.existsSync(fx.backup), '备份根不存在')
  h.eq(logText(fx), '', '零调用')
  ev('O01-plan', `kinds=${JSON.stringify(planKinds(r.out))}\nbackupExists=${fs.existsSync(fx.backup)}\n\nstdout:\n${r.out}`)
})

h.case('O02 dryrun-skip-snapshot-combo', 'pass', () => {
  const fx = mkFixture('o02')
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 'o02-dryrun-with-snapshot')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  h.assert(planKinds(r.out).includes('snapshot'), `不跳过快照时计划里**必须**有 snapshot：${JSON.stringify(planKinds(r.out))}`)
  h.assert(!fs.existsSync(fx.backup), '计划 ≠ 执行：磁盘上 $BackupRoot 仍不许存在')
  h.assert(!fs.existsSync(fx.log), '零调用（连日志文件都不该被建出来）')
  ev('O02-plan-not-executed', `kinds=${JSON.stringify(planKinds(r.out))}\nbackupExists=${fs.existsSync(fx.backup)} logExists=${fs.existsSync(fx.log)}`)
})

h.case('O03 dryrun-skippreset-combo-no-node', 'pass', () => {
  const fx = mkFixture('o03')
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-SkipPreset', '-PackRoot', fx.pack], 'o03-dryrun-skippreset')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  h.assert(!planKinds(r.out).includes('preset-install'), `-SkipPreset ⇒ preset-install 不在计划里：${JSON.stringify(planKinds(r.out))}`)
  h.eq(logText(fx), '', '零 node 调用')
  ev('O03-plan', `kinds=${JSON.stringify(planKinds(r.out))}\nlog=${JSON.stringify(logText(fx))}\n\nstdout:\n${r.out}`)
})

h.case('O04 normal-install-plan-has-all-steps', 'pass', () => {
  const fx = mkFixture('o04')
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 'o04-plan-full')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  h.eq(planKinds(r.out).join(','), 'snapshot,patch-write,preset-install,plugin-add,dump-config,preset-verify', 'install 模式计划的操作全集与顺序')
  const wl = planWrites(r.out)
  h.assert(wl.length >= 4, `writes 要覆盖 snapshot / patch（+备份）/ preset / profile package.json 这些目标（实得 ${wl.length} 条）`)
  for (const l of wl) h.assert(/^PLAN writes path=.+ existed=(True|False) bytes=\d+ sha256=([0-9a-f]{64})?$/.test(l), `writes 元素形状不对：${l}`)
  ev('O04-plan', `kinds=${JSON.stringify(planKinds(r.out))}\nwrites=${wl.length}\n\nstdout:\n${r.out}`)
})

h.case('O05 skipsnapshot-removes-snapshot-op', 'pass', () => {
  const fx = mkFixture('o05')
  const withSnap = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 'o05-with-snapshot')
  const noSnap = runInstaller(fx, [...baseArgs(), '-DryRun', '-SkipSnapshot', '-PackRoot', fx.pack], 'o05-without-snapshot')
  const k1 = planKinds(withSnap.out)
  const k2 = planKinds(noSnap.out)
  h.assert(k1.includes('snapshot'), `不给 -SkipSnapshot 时要有 snapshot：${JSON.stringify(k1)}`)
  h.assert(!k2.includes('snapshot'), `-SkipSnapshot 时 snapshot 操作要从计划里**消失**（不是执行时跳过）：${JSON.stringify(k2)}`)
  h.eq(k2.join(','), 'patch-write,preset-install,plugin-add,dump-config,preset-verify', '少掉的恰好是 snapshot 一条')
  ev('O05-kinds', `with=${JSON.stringify(k1)}\nwithout=${JSON.stringify(k2)}`)
})

h.case('O06 packroot-only-ignores-skipsnapshot', 'pass', () => {
  const fx = mkFixture('o06')
  const a = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRootOnly', '-PackRoot', fx.pack], 'o06-a')
  const b = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRootOnly', '-SkipSnapshot', '-PackRoot', fx.pack], 'o06-b')
  const norm = (s) => s.split('\n').filter((l) => l.startsWith('PLAN ')).join('\n')
  h.eq(norm(b.out), norm(a.out), '加不加 -SkipSnapshot，packroot-only 的计划必须一模一样（收窄是模式决定的）')
  h.eq(planKinds(a.out).join(','), 'patch-write', `packroot-only 的计划只许有 patch-write（实得 ${JSON.stringify(planKinds(a.out))}）`)
  h.eq(planWrites(a.out).length, 2, `packroot-only 的 writes 恰好是"目标 patch + 它那份备份"（实得 ${planWrites(a.out).length} 条）`)
  ev('O06-plan-compare', `a kinds=${JSON.stringify(planKinds(a.out))} writes=${planWrites(a.out).length}\nb kinds=${JSON.stringify(planKinds(b.out))} writes=${planWrites(b.out).length}\n\n-- a --\n${norm(a.out)}`)
})

// ══════════════════════════════════════════════════════ R：单执行器 / 既有行为不许动
h.case('R01 single-executor-source-shape', 'pass', () => {
  const facts = astFacts()
  h.eq(facts.code, 0, 'AST 探针进程退出码')
  h.eq(facts.errors, 0, 'PS 5.1 解析错误必须为 0（不然行号对不上）')
  const ex = facts.funcs['Invoke-InstallPlan']
  const gp = facts.funcs['Get-InstallPlan']
  h.assert(ex && gp, `两个内部函数都要在：Invoke-InstallPlan=${JSON.stringify(ex)} Get-InstallPlan=${JSON.stringify(gp)}`)

  const src = stripBom(readText(INSTALLER))
  const lines = src.split('\n')
  const at = (n) => (lines[n - 1] ?? '').trim()

  // ① 用 AST 找**真调用**（注释/字符串里的同名文本不会进来）
  const hits = []
  for (const c of facts.cmds) {
    let kind = null
    if (c.name === 'New-Item' || c.name === 'Copy-Item') kind = c.name
    else if (c.op === 'Ampersand' && c.first === '$dshBin') kind = '& $dshBin'
    else if (c.op === 'Ampersand' && (c.name === 'node' || c.first === 'node')) kind = '& node'
    if (kind) hits.push({ kind, line: c.line, func: c.func, text: at(c.line) })
  }
  for (const m of facts.members) if (m.member === 'WriteAllText') hits.push({ kind: 'WriteAllText', line: m.line, func: m.func, text: at(m.line) })

  const preStart = lines.findIndex((l) => l.startsWith('if ($Preflight) {')) + 1
  const preEnd = lines.findIndex((l) => l.startsWith('# --- 0) refuse to touch a LIVE host'))
  h.assert(preStart > 0 && preEnd > preStart, '找得到 -Preflight 块的行区间（例外只许落在这里面）')

  const inside = hits.filter((x) => x.func === 'Invoke-InstallPlan')
  const outside = hits.filter((x) => x.func !== 'Invoke-InstallPlan')
  const excused = outside.filter((x) => x.kind === '& node' && x.line >= preStart && x.line <= preEnd && /&\s*node\s+-v\b/.test(x.text))
  const bad = outside.filter((x) => !excused.includes(x))
  h.eq(bad.map((x) => `${x.kind}@${x.line}(${x.func})`).join(', '), '', '副作用调用只许出现在 Invoke-InstallPlan 函数体内')
  h.eq(excused.length, 1, `函数体外允许的唯一例外是 -Preflight 里那处既有的 & node -v（实得 ${excused.length}）—— R04/D5.4 明写它不算安装调用`)
  h.eq(facts.cmds.filter((c) => c.func === 'Get-InstallPlan' && /^(New-Item|Copy-Item)$/.test(c.name)).length, 0, 'Get-InstallPlan 体内不许有 New-Item / Copy-Item')
  h.eq(facts.cmds.filter((c) => c.func === 'Get-InstallPlan' && c.op === 'Ampersand').length, 0, 'Get-InstallPlan 体内不许起任何子进程')
  h.eq(facts.members.filter((m) => m.func === 'Get-InstallPlan' && m.member === 'WriteAllText').length, 0, 'Get-InstallPlan 体内不许写盘')

  // ② 反空转：执行器体内**真的**有这些调用（不是把调用删光来"通过"）
  for (const k of ['New-Item', 'Copy-Item', 'WriteAllText', '& $dshBin', '& node']) {
    h.assert(inside.some((x) => x.kind === k), `Invoke-InstallPlan 体内必须真的有 ${k}（否则"副作用只在这里"是空话）`)
  }

  // ③ 源码正则交叉核对（连注释/字符串一起搜）：函数体外只应剩上面那一处例外
  const reTokens = [/New-Item/, /Copy-Item/, /WriteAllText/, /&\s*\$dshBin/, /&\s*node/]
  const regexOut = []
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1
    if (ln >= ex.start && ln <= ex.end) continue
    if (reTokens.some((re) => re.test(lines[i]))) regexOut.push(`${ln}: ${at(ln)}`)
  }
  h.eq(regexOut.length, 1, `不做 AST 的源码正则（含注释/字符串）在执行器外也只应剩那处 & node -v；实得 ${regexOut.length} 处：${JSON.stringify(regexOut)}`)

  ev('R01-source-shape', [
    `Invoke-InstallPlan lines ${ex.start}-${ex.end}；Get-InstallPlan lines ${gp.start}-${gp.end}`,
    `-Preflight block lines ${preStart}-${preEnd}`,
    `AST hits (${hits.length}):`,
    ...hits.map((x) => `  ${x.kind} line=${x.line} func=${x.func} :: ${x.text}`),
    `excused (outside): ${JSON.stringify(excused)}`,
    `regex residuals outside the executor: ${JSON.stringify(regexOut)}`,
    '',
    facts.run.out,
  ].join('\n'))
})

h.case('R02 old-params-unchanged', 'pass', () => {
  const src = readText(INSTALLER)
  const m = /param\(([\s\S]*?)\n\)/.exec(src)
  h.assert(m, '找得到 param( ... ) 块')
  const block = m[1]
  const want = [
    [/\[string\]\s*\$PackageDir\s*=\s*''/, "-PackageDir = ''"],
    [/\[string\]\s*\$Profile\s*=\s*'web'/, "-Profile = 'web'"],
    [/\[string\]\s*\$PackRoot\s*=\s*''/, "-PackRoot = ''"],
    [/\[int\]\s*\$HostPort\s*=\s*3090/, '-HostPort = 3090'],
    [/\[switch\]\s*\$SkipHostCheck\b/, '-SkipHostCheck'],
    [/\[switch\]\s*\$SkipSnapshot\b/, '-SkipSnapshot'],
    [/\[switch\]\s*\$PackRootOnly\b/, '-PackRootOnly'],
    [/\[switch\]\s*\$SkipPreset\b/, '-SkipPreset'],
    [/\[switch\]\s*\$Preflight\b/, '-Preflight'],
    [/\[switch\]\s*\$DryRun\b/, '-DryRun'],
  ]
  for (const [re, label] of want) h.assert(re.test(block), `param 里 ${label} 必须原样还在`)
  const names = [...new Set([...block.matchAll(/\$([A-Za-z][A-Za-z0-9]*)/g)].map((x) => x[1]))].sort()
  h.eq(names.join(','), ['DryRun', 'HostPort', 'PackageDir', 'PackRoot', 'PackRootOnly', 'Preflight', 'Profile', 'SkipHostCheck', 'SkipPreset', 'SkipSnapshot'].sort().join(','), '参数名全集不许多也不许少')
  ev('R02-param-block', block)
})

h.case('R03 preset-install-callpoint-kept', 'pass', () => {
  const src = readText(INSTALLER)
  h.assert(/lib\\preset-install\.js/.test(src), '安装器文本里必须留着 lib\\preset-install.js 这个调用点（test/preset.mjs#L323 靠它）')
  h.assert(!/__WHALE_SKILLS__/.test(src), '安装器里不许出现 __WHALE_SKILLS__（test/preset.mjs#L324 靠它）')
  const lines = src.split('\n').filter((l) => /lib\\preset-install\.js/.test(l))
  ev('R03-callpoint', lines.join('\n'))
})

h.case('R04 preflight-behaviour-unchanged', 'pass', () => {
  const fx = mkFixture('r04')
  const before = walkTree(fx.home)
  const r = runInstaller(fx, [...baseArgs(), '-Preflight'], 'r04-preflight')
  h.eq(r.code, 0, `环境 OK 时 -Preflight 应 exit 0（有红行才 exit 1）：\n${clip(r.out + r.err, 2000)}`)
  h.eq(diffTree(before, walkTree(fx.home)).join(','), '', '-Preflight 只报不改：磁盘全树必须不变')
  h.assert(!fs.existsSync(fx.backup), '-Preflight 不许建备份根')
  const calls = logText(fx)
  h.assert(/node/.test(calls), `-Preflight 本来就会调 node -v（既有语义，**不算**安装调用）⇒ 假命令日志里应记到它：${JSON.stringify(calls)}`)
  ev('R04-preflight', `exit=${r.code}\ncalls=${JSON.stringify(calls)}\n\nstdout:\n${r.out}\nstderr:\n${r.err}`)
})

h.case('R05 existing-suite-preset-76', 'pass', () => {
  const r = logRun('r05-test-preset', runProc(process.execPath, [path.join(REPO, 'test', 'preset.mjs')], { timeoutMs: 300000 }), 'node test/preset.mjs')
  h.eq(r.code, 0, `test/preset.mjs 退出码应为 0：\n${clip(r.out + r.err, 2500)}`)
  const m = /===\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*===/.exec(r.out)
  h.assert(m, `没找到汇总行：\n${clip(r.out.slice(-2000), 2000)}`)
  h.eq(Number(m[1]), 76, 'test/preset.mjs 通过数必须仍是 76')
  h.eq(Number(m[2]), 0, 'test/preset.mjs 失败数必须仍是 0')
  ev('R05-preset-suite', r.out + (r.err ? `\n--stderr--\n${r.err}` : ''))
})

// ══════════════════════════════════════════════════════ C：写入材料的形状（T22 的接口）
h.case('C01 restore-plan-entry-shape', 'pass', () => {
  const src = readText(INSTALLER)
  const facts = astFacts()
  h.assert(Object.prototype.hasOwnProperty.call(facts.funcs, 'Restore-InstallPlan'), `安装器里必须存在 Restore-InstallPlan 的**入口**（T22 要用）：${JSON.stringify(Object.keys(facts.funcs))}`)
  h.assert(/\[System\.IO\.File\]::ReadAllBytes\(/.test(src), '"原字节"是真读出来记下的（ReadAllBytes）')
  const fx = mkFixture('c01')
  const patchFile = path.join(fx.profDir, 'cordis.patch.yml')
  const realSha = sha(fs.readFileSync(patchFile))
  const r = runInstaller(fx, [...baseArgs(), '-DryRun', '-PackRoot', fx.pack], 'c01-material')
  h.eq(r.code, 0, `退出码（实得 ${r.code}）`)
  const wl = planWrites(r.out)
  const patchRec = wl.find((l) => /cordis\.patch\.yml existed=/.test(l))
  const bakRec = wl.find((l) => /cordis\.patch\.yml\.bak-whale-<ts> existed=False bytes=0 sha256=$/.test(l))
  h.assert(patchRec, `已存在的目标 patch 要进 writes 并带原字节/哈希：${JSON.stringify(wl)}`)
  h.assert(bakRec, `"那份备份"的原状态（不存在）也要记：${JSON.stringify(wl)}`)
  h.assert(patchRec.includes(`sha256=${realSha}`), `writes 里的 sha256 必须就是磁盘原文的哈希\nplan: ${patchRec}\nreal: ${realSha}`)
  h.eq(Number(/bytes=(\d+)/.exec(patchRec)[1]), fs.statSync(patchFile).size, 'writes 里的 bytes 是原字节数')
  h.eq(/(existed=)(\w+)/.exec(patchRec)[2], 'True', 'patch 存在 ⇒ existed=True')
  const callSites = facts.cmds.filter((c) => c.name === 'Restore-InstallPlan').length
  ev('C01-material', `writes=${wl.length}\npatchRec=${patchRec}\nbackupRec=${bakRec}\nrealSha=${realSha}\nRestore-InstallPlan 的调用点数量（T21 不假装实现完整恢复，T22 才接线）：${callSites}\n\nstdout:\n${r.out}`)
})

// ══════════════════════════════════════════════════════ N：负向控制 + 夹具纪律
h.case('N01 negative-control-baseline-dryrun-writes-snapshot', 'pass', () => {
  h.assert(BASELINE_OK, `拿不到基线实现（git show ${BASE_COMMIT}:install-whale-sensei.ps1）—— 负向控制做不了`)
  const fx = mkFixture('n01', BASELINE_PS1)
  h.assert(!fs.existsSync(fx.backup), '基线跑之前备份根不存在')
  const r = runInstaller(fx, [...baseArgs(), '-PackageDir', REPO, '-DryRun', '-PackRoot', fx.pack], 'n01-baseline-dryrun')
  h.assert(fs.existsSync(fx.backup), `基线在 -DryRun 下也**真的**建出了 ${fx.backup}（这就是 G01：S05 抓的是真行为）`)
  const snaps = fs.readdirSync(fx.backup).filter((n) => n.endsWith('-pre-whale-sensei'))
  h.eq(snaps.length, 1, `基线建出一个快照目录（实得 ${JSON.stringify(snaps)}）`)
  const copy = path.join(fx.backup, snaps[0] ?? 'x', 'package.json')
  h.assert(fs.existsSync(copy), `基线把 package.json 拷进了快照：${copy}`)
  h.eq(sha(fs.readFileSync(copy)), sha(fs.readFileSync(path.join(fx.profDir, 'package.json'))), '快照里那份就是 profile 的 package.json')
  const patched = readText(path.join(fx.profDir, 'cordis.patch.yml'))
  h.assert(!/packRoot\s*:/.test(patched), '基线的 -DryRun 不写 patch（这个 bug 只关于快照）')
  const calls = logText(fx)
  h.assert(fs.existsSync(fx.log) && calls.length > 0, `基线的 -DryRun **还真的起了子进程**：${JSON.stringify(calls)}`)
  h.assert(/plugin --profile web add link:/.test(calls), `基线 -DryRun 甚至真的调了 dsh plugin add（比快照那条更严重）：${JSON.stringify(calls)}`)
  h.eq(r.code, 0, `基线 -DryRun 退出码（实得 ${r.code}）：\n${clip(r.out + r.err, 1500)}`)
  ev('N01-baseline-dryrun', `backupExists=${fs.existsSync(fx.backup)}\nsnapshot=${snaps[0]}\ncopySha=${sha(fs.readFileSync(copy))}\ncalls=${JSON.stringify(calls)}\nexit=${r.code}\n\nstdout:\n${r.out}`)
})

h.case('N02 negative-control-baseline-packrootonly-writes-snapshot', 'pass', () => {
  h.assert(BASELINE_OK, '拿不到基线实现 —— 负向控制做不了')
  const fx = mkFixture('n02', BASELINE_PS1)
  const r = runInstaller(fx, [...baseArgs(), '-PackageDir', REPO, '-PackRootOnly', '-PackRoot', fx.pack], 'n02-baseline-packrootonly')
  h.eq(r.code, 0, `基线 -PackRootOnly 退出码（实得 ${r.code}）`)
  h.assert(fs.existsSync(fx.backup), `基线 -PackRootOnly 也建出备份根（P02 的负向对照）：${fx.backup}`)
  const snaps = fs.readdirSync(fx.backup).filter((n) => n.endsWith('-pre-whale-sensei'))
  h.eq(snaps.length, 1, `基线建出一个快照目录（实得 ${JSON.stringify(snaps)}）`)
  h.assert(fs.existsSync(path.join(fx.backup, snaps[0] ?? 'x', 'package.json')), '基线把 package.json 拷进了快照')
  h.assert(/packRoot\s*:/.test(readText(path.join(fx.profDir, 'cordis.patch.yml'))), '基线的 packRoot 写入本身是对的 —— 错的只有那份快照')
  ev('N02-baseline-packrootonly', `backupExists=${fs.existsSync(fx.backup)}\nsnapshot=${snaps[0]}\nexit=${r.code}\n\nstdout:\n${r.out}`)
})

h.case('N03 fixture-discipline', 'pass', () => {
  let removed = null
  try {
    h.eq(path.resolve(path.dirname(SESSION)), path.resolve(TMP_BASE), `夹具根必须在 ${TMP_BASE} 下`)
    h.assert(path.basename(SESSION).startsWith('whale-T21-'), `夹具根名前缀必须是 whale-T21-（实得 ${path.basename(SESSION)}）`)
    const kids = fs.readdirSync(SESSION)
    h.assert(kids.length >= 10, `夹具里确实建了东西（实得 ${kids.length} 个：${kids.join(', ')}）`)

    h.eq(fpTree(REAL_DSH), GUARD.dsh, `真 profile 树（${REAL_DSH}）零改动`)
    h.eq(fpTree(REAL_BACKUP), GUARD.backup, `真 ${REAL_BACKUP} 树零改动`)
    h.eq(fpFocus(), GUARD.focus, '真 profile 的 package.json / cordis.patch.yml 零改动（大小+哈希+mtime）')
    h.eq(fs.existsSync(REAL_PRESETS), GUARD.presets, `真 ${REAL_PRESETS} 的存在性没变`)
    h.assert(!fs.existsSync(REAL_PRESETS), '真 .agent-presets 本来就不存在，跑完也不许被建出来')

    const w = logRun('n03-worktree', runProc('git', ['worktree', 'list'], { timeoutMs: 60000 }))
    // The invariant that belongs to THIS card is "the fixture/mutation worktrees are gone", not
    // "this machine has exactly one worktree" — another checkout can legitimately exist (one did,
    // `dsh-whale-sensei-unify`, created by a concurrent session at 14:31), and a judge that fails on
    // that is flaky, not strict. Same intent, stated precisely: no E:\Temp worktree may survive.
    const wLines = w.out.split('\n').filter((l) => l.trim())
    h.assert(wLines.length >= 1 && wLines.some((l) => l.includes('dsh-whale-sensei')), `git worktree list 里必须有本仓主工作树：\n${w.out}`)
    h.assert(!wLines.some((l) => /E:[\\/]Temp/i.test(l)), `本卡不许留下任何 E:\\Temp 下的 worktree（收尾必须清干净）：\n${w.out}`)

    ev('N03-discipline', [
      `SESSION=${SESSION}`,
      `real profile=${REAL_DSH} fingerprint=${GUARD.dsh}`,
      `real backup=${REAL_BACKUP} fingerprint=${GUARD.backup}`,
      `focus before:\n${GUARD.focus}`,
      `focus after:\n${fpFocus()}`,
      `fixture children: ${kids.join(', ')}`,
      `worktree list:\n${w.out}`,
    ].join('\n'))
  } finally {
    // 清理放在 finally 里：前面任何一条断言炸了，夹具也必须被收掉（核实过绝对路径属于本次夹具）
    removed = cleanupOwn()
    ev('N03-cleanup', `${SESSION} removed=${removed.removed} error=${removed.error}\nstillExists=${fs.existsSync(SESSION)}`)
  }
  h.assert(removed.removed, `清理夹具（核实过绝对路径属于本次夹具）：${JSON.stringify(removed)}`)
  h.assert(!fs.existsSync(SESSION), '夹具根已删除')
})

// ══════════════════════════════════════════════════════ 收尾：落运行索引（每次子进程的完整原文已在 cases/runs/<label>.txt）
ev('_index-runs', `共 ${RUNS.length} 次子进程：\n${RUNS.map((r) => `  ${r.label} exit=${r.code}`).join('\n')}\n\n完整 stdout/stderr 逐条落在 cases/runs/<label>.txt（同目录，未裁剪）。`)
ev('_index-note', [
  `CARD=${CARD}  BASE_COMMIT=${BASE_COMMIT}`,
  `INSTALLER=${INSTALLER}`,
  `PS51=${PS51}`,
  `SESSION=${SESSION}（N03 已按路径核实后清理）`,
  `固定用例 ID 集合来自派发文档 §E：**31 条**（§E 标题写 32，是 9+7+6+5+1+3 的算术落差）`,
].join('\n'))

process.exit(h.run())
