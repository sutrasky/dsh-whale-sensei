<#
  install-whale-sensei.ps1 -- install the course plugin (dsh-whale-sensei) into the `web` profile.

  RUN THIS WITH DEEPSEEK HARNESS CLOSED.
  The script refuses to proceed while the DSH web host is still listening on 3090.

  WHY `link:` AND NOT `file:` ------------------------------------------------
  With `file:` pnpm COPIES the package into the profile, so every code edit needs
  "close DSH -> reinstall -> restart".  With `link:` the profile points straight at
  the plugin checkout (this folder), so an edit only needs a restart.

  WHAT THIS SCRIPT DOES ------------------------------------------------------
    1) snapshots the profile package.json      (rollback is one command)
    2) dsh plugin --profile web add link:<this checkout>
    3) dsh --profile web --dump-config         (the ONLY reliable judge:
                                                it must contain  - id: whale-sensei)
    4) prints the rollback command

  OPTIONAL -PackRoot <dir> ---------------------------------------------------
  Installing is NOT enough: until packRoot is set, every whale_* tool answers
  "no course pack root" and the settings card shows a yellow hint.  With this
  switch the script also writes packRoot into the PROFILE-level cordis.patch.yml
  (the layer that survives reinstalls):
      - an existing  - id: whale-sensei  block  -> only its packRoot line is
        updated; every other config key is kept (a patch entry REPLACES the
        whole config object of that id)
      - no such block                           -> appends a commented block
      - the old file is backed up next to it    -> cordis.patch.yml.bak-whale-<ts>
      - -DryRun prints the result without writing anything
  Restart the host afterwards: packRoot is resolved once, at boot.

  ENCODING -- READ BEFORE EDITING --------------------------------------------
  This file is UTF-8 WITH BOM on purpose.  Windows PowerShell 5.1 reads a BOM-less
  .ps1 as ANSI: the Chinese literals below then decode into byte pairs that can
  eat a quote and break the PARSER (measured on this very file: 6 parse errors
  before a single line ran).  Either keep the BOM, or keep every literal ASCII --
  but never BOM-less together with non-ASCII.
#>
[CmdletBinding()]
param(
    [string] $PackageDir = '',          # '' -> the checkout this script lives in (see below)
    [string] $Profile    = 'web',
    [string] $PackRoot   = '',
    [int]    $HostPort   = 3090,
    [switch] $SkipHostCheck,
    [switch] $SkipSnapshot,
    [switch] $PackRootOnly,
    [switch] $SkipPreset,
    [switch] $Preflight,                 # report only: touch nothing, then exit
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# Default to the checkout this script sits in -- machine-independent, and identical
# to passing the plugin folder explicitly.  Override with -PackageDir for another copy.
if (-not $PackageDir) { $PackageDir = $PSScriptRoot }

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

# Rollback snapshots: under the user profile by default; override with DSH_PLUGIN_BACKUP.
$BackupRoot = if ($env:DSH_PLUGIN_BACKUP) { $env:DSH_PLUGIN_BACKUP } else { Join-Path $env:USERPROFILE '.dsh-plugin-backup' }

# --- locate DSH_HOME ---------------------------------------------------------
# A fresh machine usually HAS DeepSeek Harness installed but DSH_HOME unset (the
# npm-global installer does not set it), so refusing to guess used to block the
# install everywhere except the author's machine.  Probe the same fallbacks the
# plugin runtime uses (~/.dsh -- see lib/index.js, lib/profile-packroot.js), then
# the folders the `dsh` command itself sits in.  A candidate only wins when it
# really contains  profiles\<Profile>\package.json, so a stale or foreign
# DSH_HOME can never send this script into a dead tree.
$candHome = New-Object System.Collections.Generic.List[string]
if ($env:DSH_HOME)     { $candHome.Add($env:DSH_HOME) }
if ($env:USERPROFILE)  { $candHome.Add((Join-Path $env:USERPROFILE '.dsh')) }
if ($env:APPDATA)      { $candHome.Add((Join-Path $env:APPDATA 'dsh')) }
if ($env:LOCALAPPDATA) { $candHome.Add((Join-Path $env:LOCALAPPDATA 'dsh')) }
$dshOnPath = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshOnPath) {
    $probe = Split-Path -Parent $dshOnPath.Source
    foreach ($hop in 1..3) {
        if (-not $probe) { break }
        $candHome.Add($probe)
        $probe = Split-Path -Parent $probe
    }
}

$DshHome = ''
foreach ($c in ($candHome | Select-Object -Unique)) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c "profiles\$Profile\package.json"))) { $DshHome = $c; break }
}

if (-not $DshHome) {
    Say ''
    Say "Cannot locate DSH_HOME -- no  profiles\$Profile\package.json  under any candidate root." 'Red'
    $seen = @()
    foreach ($c in ($candHome | Select-Object -Unique)) {
        if (-not $c) { continue }
        $pdir = Join-Path $c 'profiles'
        if (-not (Test-Path -LiteralPath $pdir)) { continue }
        $names = @(Get-ChildItem -LiteralPath $pdir -Directory -ErrorAction SilentlyContinue |
                   Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } |
                   ForEach-Object { $_.Name })
        if ($names.Count -gt 0) { $seen += ("  {0}   (profiles with a package.json: {1})" -f $c, ($names -join ', ')) }
    }
    if ($seen.Count -gt 0) {
        Say 'DSH roots that DO exist on this machine:' 'Yellow'
        $seen | ForEach-Object { Say $_ 'Yellow' }
        Say 'Re-run with the right root and/or profile name:' 'Gray'
        Say '  $env:DSH_HOME = "<root from the list above>"' 'Gray'
        Say '  powershell -ExecutionPolicy Bypass -File install-whale-sensei.ps1 -Profile <name>' 'Gray'
    } else {
        Say 'Looked at: $env:DSH_HOME, ~\.dsh, %APPDATA%\dsh, %LOCALAPPDATA%\dsh, and next to the dsh command.' 'Yellow'
        Say 'Start DeepSeek Harness once (that creates the profile), or set DSH_HOME, then re-run.' 'Gray'
    }
    exit 3
}
Say "DSH_HOME : $DshHome" 'DarkGray'
if (-not $env:DSH_HOME) {
    Say 'NOTE: DSH_HOME is not set -- the root above was GUESSED.  If the host was started' 'Yellow'
    Say '      with a different DSH_HOME, set it (or pass -Profile <name>) and re-run, or the' 'Yellow'
    Say '      plugin lands in a profile the host never reads.' 'Yellow'
}

$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PkgJson    = Join-Path $ProfileDir 'package.json'
$PatchYml   = Join-Path $ProfileDir 'cordis.patch.yml'

# --- locate the dsh command --------------------------------------------------
# npm-global installs DO put `dsh` on PATH, but a terminal opened before that
# install does not see it -- and the docs themselves use `npx @deepseek-ai/dsh`.
# Resolve once here so every later call goes through $dshBin / $dshPre.
$dshBin = 'dsh'
$dshPre = @()
if (-not $dshOnPath) {
    if (Get-Command npx -ErrorAction SilentlyContinue) {
        $dshBin = 'npx'
        $dshPre = @('@deepseek-ai/dsh')
        Say 'NOTE: `dsh` is not on PATH -- falling back to  npx @deepseek-ai/dsh' 'Yellow'
    } else {
        Say ''
        Say 'FAIL: neither `dsh` nor `npx` is on PATH, so the plugin cannot be added.' 'Red'
        Say '      Install DeepSeek Harness (npm i -g @deepseek-ai/dsh), open a NEW' 'Red'
        Say '      terminal, then run this script again.' 'Red'
        exit 4
    }
}

# Set by any printed FAIL below; the script exits 1 at the end when it is true.
$script:softFail = $false


<#
  Update (or append) the packRoot of the  - id: whale-sensei  entry in a profile
  patch file.  Returns the new content as a single string; does not touch disk.
  Kept deliberately line-based: this file must stay dependency-free and readable.
#>
function Get-PatchedYml([string[]] $Lines, [string] $Root) {
    $yamlRoot = $Root.Replace('\', '/').Replace("'", "''")
    $list = New-Object System.Collections.Generic.List[string]
    if ($Lines) { foreach ($l in $Lines) { $list.Add($l) } }

    $idRe   = '^(?<ind>\s*)-\s*id:\s*(?<v>.*?)\s*$'
    $nextRe = '^\s*-\s+\S'
    $idAt   = -1
    for ($i = 0; $i -lt $list.Count; $i++) {
        if ($list[$i] -match $idRe) {
            # T22-R2 §3.4：同级 id 可能带引号（- id: 'whale-sensei' / "whale-sensei"）。
            # 只认**标量**且值就是这个 id 的那种，才叫"这一段"（否则那对引号会被吃进值里）。
            $v = [string]$Matches['v']
            if ($v.Length -ge 2 -and (($v[0] -eq "'" -and $v[$v.Length - 1] -eq "'") -or ($v[0] -eq '"' -and $v[$v.Length - 1] -eq '"'))) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            if ($v -eq 'whale-sensei') { $idAt = $i; break }
        }
    }

    if ($idAt -lt 0) {
        foreach ($l in @(
            '',
            '# --- dsh-whale-sensei: course pack root ------------------------------------',
            '# Installing the plugin is not enough -- without packRoot every whale_* tool',
            '# answers "no course pack root".  This is the PROFILE layer on purpose: the',
            '# copy inside the package is shipped and gets overwritten on reinstall.',
            '- id: whale-sensei',
            '  config:',
            "    packRoot: '$yamlRoot'"
        )) { $list.Add($l) }
        return ,$list.ToArray()
    }

    # end of this entry = next  "- something"  line (or EOF)
    $endAt = $list.Count
    for ($i = $idAt + 1; $i -lt $list.Count; $i++) {
        if ($list[$i] -match $nextRe) { $endAt = $i; break }
    }

    # packRoot already there? -> replace that one line, keep every other key
    for ($i = $idAt + 1; $i -lt $endAt; $i++) {
        if ($list[$i] -match '^(?<ind>\s*)packRoot\s*:') {
            $list[$i] = $Matches['ind'] + "packRoot: '$yamlRoot'"
            return ,$list.ToArray()
        }
    }

    # config: present but no packRoot -> insert right under it
    for ($i = $idAt + 1; $i -lt $endAt; $i++) {
        if ($list[$i] -match '^(?<ind>\s*)config\s*:\s*$') {
            $list.Insert($i + 1, $Matches['ind'] + "  packRoot: '$yamlRoot'")
            return ,$list.ToArray()
        }
    }

    # neither -> add config + packRoot right after the id line
    $ind = '  '
    if ($list[$idAt] -match '^(?<ind>\s*)') { $ind = $Matches['ind'] + '  ' }
    $list.Insert($idAt + 1, $ind + "  packRoot: '$yamlRoot'")
    $list.Insert($idAt + 1, $ind + 'config:')
    return ,$list.ToArray()
}


<#
  T22-R2 §3.1: shape check for the profile-level cordis.patch.yml.

  PURE READ -- same family as Get-PatchedYml: no disk, no child process.  It says
  whether the target block is one this installer is allowed to edit in place, so
  an unsupported shape is refused BEFORE anything is written (never "write a
  second `config:` key and hope").

  Returns @{ ok = $true|$false; rule = '<id>'; reason = '<one line>' }.
  rule is one of: '' (ok) / non-scalar-id / duplicate-id-sections /
  ambiguous-nesting / inline-target-config -- the SAME four ids, decided in the
  SAME order, as the JS twin lib/profile-packroot.js#checkPackRootYml, on the
  same table (test/audit/T22.mjs#YAML_SHAPE_TABLE).

  Only two things about the target block are judged here:
    · config: present, packRoot: present, and packRoot's indent is NOT deeper
      than config's  => ambiguous-nesting (packRoot is not inside config's map)
    · config: present and has something after the colon (an inline flow map)
      => inline-target-config
#>
function Test-PatchedYmlShape([string[]] $Lines) {
    $heads = New-Object System.Collections.Generic.List[hashtable]
    if ($Lines) {
        $idx = -1
        foreach ($line in @($Lines)) {
            $idx++
            if ($line -notmatch '^\s*-\s') { continue }
            if ($line -notmatch '^(?<ind>\s*)-\s*id:\s*(?<v>.*?)\s*$') { continue }
            # 先把 $Matches 里要的两样取出来：下面任何一次 -match 都会把它冲掉
            $ind = [string]$Matches['ind']
            $raw = [string]$Matches['v']
            $kind = 'scalar'
            $value = $raw
            $mentions = $false
            if ($raw.Length -gt 0 -and ($raw[0] -eq '[' -or $raw[0] -eq '{')) {
                $kind = 'non-scalar'
                if ($raw -match '(^|[^\w-])whale-sensei([^\w-]|$)') { $mentions = $true }
            } elseif ($raw.Length -ge 2) {
                $q = $raw[0]
                if (($q -eq "'" -or $q -eq '"') -and $raw[$raw.Length - 1] -eq $q) {
                    $value = $raw.Substring(1, $raw.Length - 2)
                }
            }
            $heads.Add(@{ at = $idx; ind = $ind; kind = $kind; value = $value; mentions = $mentions })
        }
    }

    $nonScalar = @($heads | Where-Object { $_.kind -eq 'non-scalar' -and $_.mentions })
    if ($nonScalar.Count -gt 0) {
        return @{ ok = $false; rule = 'non-scalar-id'; reason = '目标块的 id 值不是标量（id: [whale-sensei] / {..: whale-sensei}）—— 就地改哪一段都是猜' }
    }

    $scalar = @($heads | Where-Object { $_.kind -eq 'scalar' -and $_.value -eq 'whale-sensei' })
    if ($scalar.Count -gt 1) {
        return @{ ok = $false; rule = 'duplicate-id-sections'; reason = '文档里有多个 - id: whale-sensei 段，就地改哪一段都是猜' }
    }
    if ($scalar.Count -eq 0) {
        return @{ ok = $true; rule = ''; reason = '' }
    }

    $all = @($Lines)
    $at = [int]$scalar[0].at
    $end = $all.Count
    for ($i = $at + 1; $i -lt $all.Count; $i++) {
        if ($all[$i] -match '^\s*-\s+\S') { $end = $i; break }
    }

    $cfgInd = -1
    $cfgInline = $false
    $prFound = $false
    $prInd = -1
    for ($i = $at + 1; $i -lt $end; $i++) {
        if ($cfgInd -lt 0 -and $all[$i] -match '^(?<ind>\s*)config\s*:(?<rest>.*)$') {
            $cfgInd = ([string]$Matches['ind']).Length
            $rest = ([string]$Matches['rest']).Trim()
            if ($rest.Length -gt 0 -and -not $rest.StartsWith('#')) { $cfgInline = $true }
        }
        if (-not $prFound -and $all[$i] -match '^(?<ind>\s*)packRoot\s*:') {
            $prFound = $true
            $prInd = ([string]$Matches['ind']).Length
        }
    }

    # 顺序与 JS 侧 checkPackRootYml 逐字一致：先歧义嵌套，再 inline config
    if ($cfgInd -ge 0 -and $prFound -and ($prInd -le $cfgInd)) {
        return @{ ok = $false; rule = 'ambiguous-nesting'; reason = '目标块里的 packRoot: 缩进不比 config: 深 —— 它不在 config 的映射里，就地改会插出重复键' }
    }
    if ($cfgInd -ge 0 -and $cfgInline) {
        return @{ ok = $false; rule = 'inline-target-config'; reason = '目标块里的 config: 是 inline 流式映射 —— 就地改会插出第二个 config 键' }
    }
    return @{ ok = $true; rule = ''; reason = '' }
}

# ---------------------------------------------------------------------------
# The install PLAN and its ONE executor (report G01).
#
#   Get-InstallPlan     READ-ONLY.  Reports what WOULD change: which directories
#                       and files, what their bytes look like BEFORE the change,
#                       and which child processes would run.  It never creates a
#                       directory, never copies a file, never writes text and
#                       never starts a process.
#   Invoke-InstallPlan  The ONLY place in this file that creates a directory,
#                       copies a file, writes text or starts a process.  It
#                       walks $Plan.operations in order and does exactly those
#                       things -- no more.  -DryRun simply never calls it.
#   Restore-InstallPlan The counterpart of the recorded writes (T22 wires it to
#                       the command line): it puts every recorded target back --
#                       original bytes for what existed, delete for what did not,
#                       and it deletes the recovery material only when every
#                       target really was restored.  It moves files ONLY: it
#                       never talks to dsh or node.
#
# Why this shape: -DryRun used to still create ~\.dsh-plugin-backup and copy
# package.json, because the snapshot ran BEFORE any -DryRun check; and
# -PackRootOnly only bailed out half way -- after that very snapshot.  A plan
# computed first, plus a single executor that -DryRun does not call, is what
# makes "a preview writes nothing" and "the path-only mode touches only the
# patch file" mechanical facts instead of intentions.
# ---------------------------------------------------------------------------

<#
  Read-only "before" picture of ONE write target: its bytes right now, or
  "it did not exist yet".  This is the rollback material the plan carries.

  T22 adds the two fields the record was missing: `home` (which DSH root the
  target belongs to) and `installedVersion` (what the profile package.json says
  is installed right now; '' for every target that is not that package.json).
#>
function Get-WriteRecord([string] $Path, [string] $Kind, [string] $HomeRoot = '', [string] $InstalledVersion = '') {
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ path = $Path; existed = $false; bytes = 0; sha256 = ''; kind = $Kind; home = $HomeRoot; installedVersion = $InstalledVersion }
    }
    $raw = [System.IO.File]::ReadAllBytes($Path)
    return @{
        path             = $Path
        existed          = $true
        bytes            = $raw.Length
        sha256           = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        kind             = $Kind
        home             = $HomeRoot
        installedVersion = $InstalledVersion
    }
}

<#
  Read-only: the version the PROFILE package.json currently pins for
  dsh-whale-sensei.  Missing file / missing key / unparseable JSON => '' (never
  a guess).  Pure read: no disk write, no child process.
#>
function Get-InstalledVersion([string] $PkgJsonPath) {
    if (-not $PkgJsonPath) { return '' }
    if (-not (Test-Path -LiteralPath $PkgJsonPath)) { return '' }
    try {
        $obj = [System.IO.File]::ReadAllText($PkgJsonPath) | ConvertFrom-Json
        if ($obj -and $obj.dependencies -and $obj.dependencies.PSObject.Properties['dsh-whale-sensei']) {
            return [string]$obj.dependencies.'dsh-whale-sensei'
        }
    } catch { }
    return ''
}

<#
  Append one write record AND keep its original bytes in memory.  The record
  itself stays exactly the shape Get-WriteRecord documents (path / existed /
  bytes / sha256 / kind / home / installedVersion); the bytes live in a side
  table keyed by path, because "restore by original bytes" needs the bytes and
  the after-the-fact file no longer has them.
#>
function Add-WriteRecord($List, $Originals, $Rec) {
    $List.Add($Rec)
    if ($Rec.existed -and -not $Originals.ContainsKey([string]$Rec.path)) {
        $Originals[[string]$Rec.path] = [System.IO.File]::ReadAllBytes([string]$Rec.path)
    }
}

<#
  Build the plan.  PURE READ: Test-Path / Resolve-Path / ReadAllBytes /
  ReadAllText / Get-FileHash / Get-Command / Say.  Nothing here may touch the
  disk or start a child process -- that is Invoke-InstallPlan's whole job.
#>
function Get-InstallPlan {
    param(
        [string] $HomeDir,
        [string] $Prof,
        [string] $PkgDir,
        [string] $Root,
        [bool]   $SkipSnap,
        [bool]   $SkipPre,
        [bool]   $OnlyPackRoot,
        [bool]   $IsDryRun
    )

    $profDir   = Join-Path $HomeDir "profiles\$Prof"
    $pkgJson   = Join-Path $profDir 'package.json'
    $patchYml  = Join-Path $profDir 'cordis.patch.yml'
    $presetDir = Join-Path $HomeDir '.agent-presets\whale-mode'
    $presetYml = Join-Path $presetDir 'agent.cordis.yml'
    $presetTpl = Join-Path $PkgDir 'preset\whale-mode'
    $presetCli = Join-Path $PkgDir 'lib\preset-install.js'
    $mode      = if ($OnlyPackRoot) { 'packroot-only' } else { 'install' }

    $pkgFull = $PkgDir
    if (Test-Path -LiteralPath $PkgDir) { $pkgFull = (Resolve-Path -LiteralPath $PkgDir).Path }

    # --- packRoot: resolve it and compute the text that WOULD be written -------
    $rootFull   = ''
    $skillsDir  = ''
    $patchText  = ''
    $nl         = "`r`n"
    $patchThere = Test-Path -LiteralPath $patchYml
    # T22-R2：形状判定（纯读）。默认 ok —— 只有给了 -PackRoot、真的要写这份 patch 时才可能为 false。
    $patchShape = @{ ok = $true; rule = ''; reason = '' }
    if ($Root) {
        if (-not (Test-Path -LiteralPath $Root)) { throw "PackRoot does not exist: $Root" }
        $rootFull = (Resolve-Path -LiteralPath $Root).Path
        if (-not (Test-Path -LiteralPath (Join-Path $rootFull 'presets\whale-sensei.css'))) {
            Say "WARN: $rootFull has no presets\whale-sensei.css" 'Yellow'
            Say '      (that file is how a directory is recognised as a course pack)' 'DarkGray'
        }
        $cand = Join-Path $rootFull 'skills'
        if (Test-Path -LiteralPath $cand) {
            $skillsDir = $cand
        } else {
            Say "WARN: 课程包里没有 skills\（$cand）—— 预设先留空技能目录，补上后重启宿主会自动补" 'Yellow'
        }
        $lines = @()
        if ($patchThere) {
            $raw = [System.IO.File]::ReadAllText($patchYml)
            if ($raw -notmatch "`r`n") { $nl = "`n" }
            $lines = @($raw -split "`r?`n")
            if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
                $lines = @($lines[0..($lines.Count - 2)])
            }
        }
        # T22-R2 §3.1：写盘前先判形状（不支持的形状必须**写前拒绝**，不许用正则插第二个 config）
        $patchShape = Test-PatchedYmlShape $lines
        $patchText = ((Get-PatchedYml $lines $rootFull) -join $nl) + $nl
    }

    # --- the snapshot directory: the PLAN owns this path; only the executor
    #     creates it.  packroot-only never snapshots anything. ---
    $snapDir = ''
    if ($mode -eq 'install' -and -not $SkipSnap) {
        $snapDir = Join-Path $BackupRoot ("{0}-pre-whale-sensei" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }

    # --- operations, in execution order:
    #     snapshot -> patch-write -> preset-install -> plugin-add -> dump-config -> preset-verify
    #     (only the ones that apply; nothing is left as an empty placeholder) ---
    $ops    = New-Object System.Collections.Generic.List[hashtable]
    $writes = New-Object System.Collections.Generic.List[hashtable]
    $originals = @{}                       # path -> 原字节（回滚材料，见 Restore-InstallPlan）
    $installedVersion = Get-InstalledVersion $pkgJson
    $presetFiles = @()

    if ($snapDir) {
        $ops.Add(@{ kind = 'snapshot'; path = $snapDir; why = '回滚材料：把 profile 的 package.json 拷进带时间戳的快照目录'; sideEffect = $true })
        # 备份根自身也记一条：本次安装才建出来、且回滚后空了，就得连它一起收掉。
        # 它是**目录**：existed 只用来决定"能不能删"，不读字节（Add-WriteRecord 会读）。
        $writes.Add(@{ path = $BackupRoot; existed = [bool](Test-Path -LiteralPath $BackupRoot); bytes = 0; sha256 = ''; kind = 'snapshot'; home = $HomeDir; installedVersion = '' })
        Add-WriteRecord $writes $originals @{ path = $snapDir; existed = $false; bytes = 0; sha256 = ''; kind = 'snapshot'; home = $HomeDir; installedVersion = '' }
        Add-WriteRecord $writes $originals @{ path = (Join-Path $snapDir 'package.json'); existed = $false; bytes = 0; sha256 = ''; kind = 'snapshot'; home = $HomeDir; installedVersion = '' }
    }

    $backupPattern = ''
    if ($rootFull) {
        $backupPattern = "$patchYml.bak-whale-<ts>"
        $ops.Add(@{ kind = 'patch-write'; path = $patchYml; why = "把 packRoot '$rootFull' 写进 profile 级 cordis.patch.yml"; sideEffect = $true; backupPattern = $backupPattern })
        Add-WriteRecord $writes $originals (Get-WriteRecord $patchYml 'patch-write' $HomeDir '')
        if ($patchThere) {
            # 模式项：真时间戳只有执行时才知道，计划里先记模式（回滚时不许把它当字面路径）
            Add-WriteRecord $writes $originals @{ path = $backupPattern; existed = $false; bytes = 0; sha256 = ''; kind = 'patch-write'; home = $HomeDir; installedVersion = '' }
        }
    }

    if ($mode -eq 'install') {
        if (-not $SkipPre) {
            $ops.Add(@{ kind = 'preset-install'; path = $presetYml; why = '跑 lib\preset-install.js 把鲸师模式预设写进 .agent-presets'; sideEffect = $true })
            # 预设树**逐文件**进 writes（不是"整棵目录一句话带过"）：落盘面就是
            # lib/preset-install.js 会写的那几个 —— agent.cordis.yml 与（模板里有的）preset.yml。
            $presetNames = @('agent.cordis.yml')
            if (Test-Path -LiteralPath (Join-Path $presetTpl 'preset.yml')) { $presetNames += 'preset.yml' }
            foreach ($pn in $presetNames) {
                Add-WriteRecord $writes $originals (Get-WriteRecord (Join-Path $presetDir $pn) 'preset-install' $HomeDir '')
            }
            $presetFiles = $presetNames
        }
        $ops.Add(@{ kind = 'plugin-add'; path = $pkgJson; why = "dsh plugin --profile $Prof add link:$pkgFull"; sideEffect = $true })
        Add-WriteRecord $writes $originals (Get-WriteRecord $pkgJson 'plugin-add' $HomeDir $installedVersion)

        # `dsh plugin add` 到底会改动哪些目标：profile 侧的这几个文件是它可能碰的。
        # 存在的都要记原字节（回滚靠它），**读不动就说明目标集无法完整枚举**。
        $addTargets = New-Object System.Collections.Generic.List[string]
        $addTargets.Add($pkgJson)
        $addTargetsEnumerated = $true
        foreach ($tn in @('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'npm-shrinkwrap.json', 'package-lock.json', 'yarn.lock', 'node_modules\.modules.yaml')) {
            $tp = Join-Path $profDir $tn
            if (-not (Test-Path -LiteralPath $tp)) { continue }
            $addTargets.Add($tp)
            try { [void][System.IO.File]::ReadAllBytes($tp) } catch { $addTargetsEnumerated = $false; continue }
            Add-WriteRecord $writes $originals (Get-WriteRecord $tp 'plugin-add' $HomeDir '')
        }

        $ops.Add(@{ kind = 'dump-config'; path = ''; why = '只读判定：dump-config 里必须出现  - id: whale-sensei'; sideEffect = $true })
        if (-not $SkipPre) {
            $ops.Add(@{ kind = 'preset-verify'; path = $presetYml; why = '只读判定：预设文件必须已经落在磁盘上'; sideEffect = $false })
        }
    } else {
        $addTargets = New-Object System.Collections.Generic.List[string]
        $addTargetsEnumerated = $true
        $presetFiles = @()
    }

    return @{
        schema             = 'whale-install-plan/1'
        mode               = $mode
        dryRun             = [bool]$IsDryRun
        home               = $HomeDir
        profile            = $Prof
        profileDir         = $profDir
        packageDir         = $pkgFull
        snapshotDir        = $snapDir
        operations         = $ops.ToArray()
        writes             = $writes.ToArray()
        originalBytes      = $originals
        actualBackups      = @()
        addTargets         = $addTargets.ToArray()
        addTargetsEnumerated = [bool]$addTargetsEnumerated
        backupRoot         = $BackupRoot
        pkgJson            = $pkgJson
        patchYml           = $patchYml
        patchText          = $patchText
        patchShape         = $patchShape
        patchExists        = $patchThere
        patchBackupPattern = $backupPattern
        presetDir          = $presetDir
        presetYml          = $presetYml
        presetFiles        = $presetFiles
        presetCli          = $presetCli
        presetSkills       = $skillsDir
        presetNode         = [bool](Get-Command node -ErrorAction SilentlyContinue)
        dshBin             = $dshBin
        dshPre             = $dshPre
        packRoot           = $rootFull
        skipSnapshot       = [bool]$SkipSnap
        skipPreset         = [bool]$SkipPre
    }
}

<#
  The ONE executor: it runs exactly $Plan.operations, in order.  Every call in
  this file that creates a directory, copies a file or writes text -- and every
  call that starts a child process (dsh / node) -- lives in this body.
#>
function Invoke-InstallPlan {
    param([hashtable] $Plan)

    $dshBin = $Plan.dshBin
    $dshPre = $Plan.dshPre
    $out = @{
        snapshotDir   = ''
        patchBackup   = ''
        patchWritten  = $false
        presetRan     = $false
        presetSkipped = ''
        pluginAdded   = $false
        dumpHit       = $false
        presetOnDisk  = $false
        aborted       = $false
        softFail      = $false
        refused       = $false
        rolledBack    = $false
        restoreFailed = $false
        addTargets    = @()
        addTargetsEnumerated = $true
    }
    # 每一步的"成功"判词先攒着：整条事务没失败才打印 —— 失败/回滚的那次输出里
    # 不许出现任何"成功 / OK / 装好了"类字样（卡面 §3.4 / V04）。
    $okLines = New-Object System.Collections.Generic.List[string]

    # --- T22 §3.3：所有 dsh / node 子进程都在**同一个显式** DSH_HOME 下跑 ---
    # 先把调用者原来的值（连"原来有没有设"）记下来；无论正常返回、throw 还是 exit，
    # 都在 finally 里恢复。恢复必须发生在脚本退出之前，所以这里是 try/finally。
    $prevHadHome = Test-Path Env:\DSH_HOME
    $prevHomeVal = $env:DSH_HOME
    $env:DSH_HOME = $Plan.home
    try {

    # --- §3.6：执行前向 dsh 要一份"有效配置"，据它确认 `dsh add` 的目标集确实
    #     枚举得到。这一步在**任何写之前**；拿不到就以"无法完整枚举"为由拒绝，
    #     一个字节都不写（全树不变）。
    $out.addTargets = @($Plan.addTargets)
    $out.addTargetsEnumerated = [bool]$Plan.addTargetsEnumerated
    if ($Plan.mode -eq 'install') {
        $probeCode = -1
        $probeText = ''
        try {
            $probeText = (& $dshBin @dshPre --profile $Plan.profile --dump-config 2>&1 | Out-String)
            $probeCode = $LASTEXITCODE
        } catch {
            $probeCode = -1
            $probeText = ''
        }
        if ($probeCode -ne 0 -or -not $probeText.Trim()) { $out.addTargetsEnumerated = $false }
        if (-not $out.addTargetsEnumerated) {
            Write-Host ''
            Say '拒绝事务安装：无法完整枚举 `dsh add` 的目标。' 'Red'
            Say ("  dsh 有效配置探针：exit={0}，输出 {1} 字节 —— 拿不到它就没有可核对的改动面" -f $probeCode, $probeText.Length) 'DarkGray'
            Say ("  候选目标（profile 侧）：{0}" -f (@($Plan.addTargets) -join ', ')) 'DarkGray'
            Say '  一个字节都没写。' 'Red'
            $out.refused = $true
            return $out
        }
    }

    foreach ($op in $Plan.operations) {
        switch ($op.kind) {

            'snapshot' {
                New-Item -ItemType Directory -Force -Path $Plan.backupRoot | Out-Null
                New-Item -ItemType Directory -Force -Path $op.path | Out-Null
                Copy-Item $Plan.pkgJson (Join-Path $op.path 'package.json') -Force
                $out.snapshotDir = $op.path
                Say "snapshot : $($op.path)" 'DarkGray'
            }

            'patch-write' {
                Write-Host ''
                # T22-R2 §3.1：写盘前再判一次形状。不支持 ⇒ **这一笔都不写**（连那份 .bak-whale-* 也不建），
                # 该步失败 → 走下面的回滚 → 调用方非零退出。
                if ($Plan.ContainsKey('patchShape') -and -not $Plan.patchShape.ok) {
                    Say '== packRoot (profile-level cordis.patch.yml) ==' 'Cyan'
                    Say 'FAIL 这份 cordis.patch.yml 的形状不支持就地修改 -- 拒绝写入（一个字节都没写）。' 'Red'
                    Say ("     rule={0}" -f $Plan.patchShape.rule) 'Red'
                    Say ("     reason={0}" -f $Plan.patchShape.reason) 'Red'
                    Say ("     目标：{0}" -f $Plan.patchYml) 'DarkGray'
                    $out.softFail = $true
                    break
                }
                Say '== packRoot (profile-level cordis.patch.yml) ==' 'Cyan'
                if ($Plan.patchExists) {
                    $bak = "$($Plan.patchYml).bak-whale-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                    Copy-Item -LiteralPath $Plan.patchYml -Destination $bak -Force
                    $out.patchBackup = $bak
                    # 实际备份路径回填：回滚时按真路径处理，不拿模式去 Test-Path
                    $Plan.actualBackups = @($bak)
                    Say "backup   : $bak" 'DarkGray'
                } else {
                    Say "creating : $($Plan.patchYml)" 'DarkGray'
                }
                # UTF-8 without BOM, original newline style -- do not churn the whole file
                [System.IO.File]::WriteAllText($Plan.patchYml, $Plan.patchText, (New-Object System.Text.UTF8Encoding($false)))
                $after   = [System.IO.File]::ReadAllText($Plan.patchYml)
                $hitLine = ($after -split "`r?`n") | Where-Object { $_ -match '^\s*packRoot\s*:' } | Select-Object -First 1
                if ($hitLine) {
                    $out.patchWritten = $true
                    $okLines.Add('OK   wrote: ' + $hitLine.Trim())
                    $okLines.Add('     -> RESTART DeepSeek Harness: packRoot is resolved once, at boot.')
                } else {
                    Say 'FAIL packRoot did not land in cordis.patch.yml -- inspect it by hand.' 'Red'
                    $out.softFail = $true
                }
            }

            'preset-install' {
                Write-Host ''
                Say '== agent preset 鲸师模式 (.agent-presets/whale-mode) ==' 'Cyan'
                if (-not (Test-Path -LiteralPath $Plan.presetCli)) {
                    $out.presetSkipped = "SKIP: $($Plan.presetCli) 不在（这个包不完整？）"
                    Say "$($out.presetSkipped) —— 宿主启动时插件还会自己再试一次" 'Yellow'
                } elseif (-not $Plan.presetNode) {
                    $out.presetSkipped = 'SKIP: 找不到 node'
                    Say 'SKIP: 找不到 node —— 预设留给宿主启动时的插件自己装' 'Yellow'
                } else {
                    $cliArgs = @($Plan.presetCli, '--dsh-home', $Plan.home)
                    if ($Plan.presetSkills) { $cliArgs += @('--skills-dir', $Plan.presetSkills) }
                    & node @cliArgs
                    if ($LASTEXITCODE -ne 0) {
                        Say 'FAIL 预设没装上（见上面那几行）—— 宿主启动时插件还会自己再试一次' 'Red'
                        $out.softFail = $true
                    } else {
                        $out.presetRan = $true
                        $okLines.Add('     -> 开会话时选「鲸师模式」（不用等重启：宿主每次列预设都重读磁盘）')
                    }
                }
            }

            'plugin-add' {
                Write-Host ''
                Say ">> $dshBin $($dshPre -join ' ') plugin --profile $($Plan.profile) add link:$($Plan.packageDir)" 'Cyan'
                & $dshBin @dshPre plugin --profile $Plan.profile add "link:$($Plan.packageDir)"
                if ($LASTEXITCODE -ne 0) {
                    Say "FAILED: 'dsh plugin add' exited $LASTEXITCODE" 'Red'
                    $out.softFail = $true
                    $out.aborted  = $true
                } else {
                    $out.pluginAdded = $true
                }
            }

            'dump-config' {
                Write-Host ''
                Say ">> dsh --profile $($Plan.profile) --dump-config" 'Cyan'
                $dump = (& $dshBin @dshPre --profile $Plan.profile --dump-config 2>&1 | Out-String)
                $hit  = ($dump -split "`n") | Where-Object { $_ -match '-\s*id:\s*whale-sensei' }

                Write-Host ''
                if ($hit) {
                    $out.dumpHit = $true
                    $okLines.Add('OK   dump-config contains:')
                    $hit | Select-Object -First 3 | ForEach-Object { $okLines.Add('       ' + $_.Trim()) }
                    $okLines.Add('')
                    $okLines.Add('Next: start DeepSeek Harness and check that boot.json got a version fingerprint,')
                    $okLines.Add('      then ask the agent to call the tool  whale_ping  (it should echo back).')
                    if (-not $Plan.packRoot) {
                        Say ''
                        Say 'NOTE: packRoot was NOT configured -- the plugin is assembled but still cannot' 'Yellow'
                        Say '      find a course pack: every whale_* tool answers "no course pack root"' 'Yellow'
                        Say '      and the settings card shows a yellow hint.' 'Yellow'
                        Say '      Fix it either way (then restart the host):' 'Yellow'
                        Say '        - re-run this script with  -PackRoot <dir>   (or -PackRoot <dir> -PackRootOnly)' 'Yellow'
                        Say '        - or set the env var  DSH_WHALE_PACK=<dir>  before starting the host' 'Yellow'
                    }
                } else {
                    Say 'FAIL dump-config does NOT contain  `- id: whale-sensei`' 'Red'
                    $out.softFail = $true
                    Say '     => the plugin did NOT get assembled. Do not trust "installed".' 'Red'
                    Say '     roll back with the command below, then send me the dump-config output.' 'Red'
                }
            }

            'preset-verify' {
                Write-Host ''
                if (Test-Path -LiteralPath $Plan.presetYml) {
                    $out.presetOnDisk = $true
                    $okLines.Add('OK   agent preset 鲸师模式 is on disk:')
                    $okLines.Add(("       {0}" -f $Plan.presetYml))
                    $okLines.Add('       -> 开会话时选它（宿主每次列预设都重读磁盘，不用重启）')
                } else {
                    Say 'FAIL agent preset 鲸师模式 is NOT on disk:' 'Red'
                    Say ("       {0}" -f $Plan.presetYml) 'Red'
                    Say '     => 这次安装没带来预设。插件在宿主启动时还会自己装一次（见 lib/mods/preset.js），' 'Red'
                    Say '        但在那之前，别把这次安装当成成功。' 'Red'
                    $out.softFail = $true
                }
            }

            default {
                Say "FAIL: unknown plan operation '$($op.kind)' -- refusing to guess." 'Red'
                $out.softFail = $true
                $out.aborted  = $true
            }
        }
        # 第一步失败就停：后面的步骤只会多写东西，"全部恢复"反而更难兑现。
        if ($out.softFail -or $out.aborted) { break }
    }

    # --- 全成功才打印那些"成功"判词 ---
    if (-not $out.softFail -and -not $out.aborted) {
        foreach ($line in $okLines) { Say $line 'Green' }
    }

    # --- T22 §3.2/§3.4：任一步失败 ⇒ 按 $Plan.writes 的原字节/原不存在回滚 ---
    if ($out.softFail -or $out.aborted) {
        Write-Host ''
        Say '== 回滚（Restore-InstallPlan）==' 'Cyan'
        $rb = Restore-InstallPlan $Plan
        $out.restore = $rb
        if ($rb.ok) {
            # restore 成功 = 事务失败但机器已经还原，所以是"已回滚"而不是"成功"。
            $out.rolledBack = $true
            Say ("已回滚：{0} 个目标按原字节 / 原不存在恢复。" -f @($rb.restored).Count) 'Yellow'
            foreach ($rp in @($rb.restored)) { Say ("  已恢复 {0}" -f $rp) 'DarkGray' }
        } else {
            $out.restoreFailed = $true
            Say '恢复失败 —— 下面这些目标没能还原（恢复材料保留，别删）：' 'Red'
            foreach ($rf in @($rb.failed)) { Say ("  失败 {0}  :: {1}" -f $rf.path, $rf.error) 'Red' }
            foreach ($rk in @($rb.kept)) { Say ("  保留材料 {0}" -f $rk) 'Yellow' }
        }
    }

    # --- rollback hint: the last thing a full install prints ---
    if ($Plan.mode -eq 'install' -and -not $out.aborted) {
        Write-Host ''
        Say 'rollback (either one):' 'DarkGray'
        Say "  dsh plugin --profile $($Plan.profile) remove dsh-whale-sensei" 'DarkGray'
        if ($out.snapshotDir) { Say "  Copy-Item '$($out.snapshotDir)\package.json' '$($Plan.pkgJson)' -Force" 'DarkGray' }
        Write-Host ''
    }

    return $out
    } finally {
        # 无论正常返回、throw 还是 exit，调用者的 DSH_HOME 都在这里恢复原样
        # （原来没设 ⇒ 删掉这个变量，原来有值 ⇒ 写回原值）。
        if ($prevHadHome) { $env:DSH_HOME = $prevHomeVal } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
    }
}

<#
  删掉"因此变空"的目录：从 $Path 的父目录往上走，只要**确实空**、且**严格在
  $StopAt 之下**就收掉；非空目录一律不删（预设目录里可能还有别的文件）。
  $StopAt 自己与它上面的目录永远不碰。
#>
function Remove-EmptyParents([string] $Path, [string] $StopAt) {
    if (-not $Path) { return }
    $stop = ([string]$StopAt).TrimEnd('\')
    if (-not $stop) { return }
    $dir = Split-Path -Parent $Path
    while ($dir) {
        if (-not $dir.StartsWith($stop + '\', [System.StringComparison]::OrdinalIgnoreCase)) { break }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { break }
        $kids = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
        if ($kids.Count -gt 0) { break }
        Remove-Item -LiteralPath $dir -Force
        $dir = Split-Path -Parent $dir
    }
}

<#
  The other half of the recorded writes: every target in $Plan.writes carries
  "its original bytes" (side table $Plan.originalBytes) or "it did not exist
  yet", so this can put the machine back.

  Contract (T22):
    · existed=$true  -> 把**原字节**写回 path（WriteAllBytes，不是重新生成一遍）
    · existed=$false -> 删掉 path；只有它因此变空才连目录一起删（非空目录一律不删）
    · path 形如 …\cordis.patch.yml.bak-whale-<ts> 的**模式项**不按字面路径处理：
      真时间戳只有执行时才知道，改用执行时回填的 $Plan.actualBackups
    · 这里**只动文件**：不调 dsh、不调 node
    · 返回 @{ ok; restored; failed; kept }；恢复材料（快照树与 .bak-whale-*）
      只在**全部恢复成功**时才删，任一目标写不回就一份都不删并列进 kept。
#>
function Restore-InstallPlan {
    param([hashtable] $Plan)

    $restored = New-Object System.Collections.Generic.List[string]
    $failed   = New-Object System.Collections.Generic.List[hashtable]
    $kept     = New-Object System.Collections.Generic.List[string]

    $originals = @{}
    if ($Plan.ContainsKey('originalBytes') -and $Plan.originalBytes) { $originals = $Plan.originalBytes }
    $actualBackups = @()
    if ($Plan.ContainsKey('actualBackups') -and $Plan.actualBackups) { $actualBackups = @($Plan.actualBackups) }

    # writes -> 要恢复的条目。模式项跳过（见函数头注释）。
    $work = New-Object System.Collections.Generic.List[hashtable]
    $seen = @{}
    foreach ($w in $Plan.writes) {
        $p = [string]$w.path
        if (-not $p) { continue }
        if ($p.Contains('<ts>')) { continue }
        if ($seen.ContainsKey($p)) { continue }
        $seen[$p] = $true
        $work.Add(@{ path = $p; existed = [bool]$w.existed; kind = [string]$w.kind; isMaterial = $false })
    }
    foreach ($b in $actualBackups) {
        if (-not $b) { continue }
        $work.Add(@{ path = [string]$b; existed = $false; kind = 'patch-backup'; isMaterial = $true })
    }

    # 恢复材料 = 快照树（kind=snapshot）与执行时真造出来的 .bak-whale-*。
    foreach ($e in $work) {
        if ($e.kind -eq 'snapshot' -or $e.kind -eq 'patch-backup') { $e.isMaterial = $true }
    }

    $regular  = @($work | Where-Object { -not $_.isMaterial })
    $material = @($work | Where-Object { $_.isMaterial })
    $stopHome = [string]$Plan.home
    $stopBak  = [string]$Plan.backupRoot

    # ---- 第一遍：普通目标（原字节写回 / 原不存在删掉）----
    foreach ($e in $regular) {
        $p = $e.path
        try {
            $existsNow = Test-Path -LiteralPath $p
            $isDirNow  = $existsNow -and (Test-Path -LiteralPath $p -PathType Container)
            if ($e.existed) {
                if ($isDirNow) { throw "目标现在是个目录，写不回原字节" }
                if (-not $originals.ContainsKey($p)) { throw "计划里没有留下原字节，无法按字节恢复" }
                $parent = Split-Path -Parent $p
                if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) { throw "父目录不在：$parent" }
                [System.IO.File]::WriteAllBytes($p, [byte[]]$originals[$p])
                $restored.Add("$p （按原字节写回）")
            } else {
                if ($isDirNow) {
                    $kids = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)
                    if ($kids.Count -gt 0) { throw "非空目录不许删：$p（留着 $($kids.Count) 项）" }
                    Remove-Item -LiteralPath $p -Force
                    $restored.Add("$p （删掉空目录：本来没有）")
                } elseif ($existsNow) {
                    Remove-Item -LiteralPath $p -Force
                    $restored.Add("$p （删掉：本来没有）")
                } else {
                    $restored.Add("$p （本来就没有，未动）")
                }
                if ($e.kind -eq 'snapshot') { Remove-EmptyParents $p $stopBak } else { Remove-EmptyParents $p $stopHome }
            }
        } catch {
            $failed.Add(@{ path = $p; error = [string]$_.Exception.Message })
        }
    }

    # ---- 第二遍：恢复材料（快照树 / 实际备份）。有一项失败就一份都不删。----
    if ($failed.Count -eq 0) {
        $matSorted = @($material | Sort-Object -Property @{ Expression = { $_.path.Length } } -Descending)
        foreach ($e in $matSorted) {
            $p = $e.path
            try {
                if ($e.existed) { continue }   # 本来就有 → 一个字节一个目录都不动
                if (-not (Test-Path -LiteralPath $p)) { continue }
                if (Test-Path -LiteralPath $p -PathType Container) {
                    $kids = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)
                    if ($kids.Count -gt 0) { continue }      # 非空目录一律不删（可能还有别人的东西）
                    Remove-Item -LiteralPath $p -Force
                } else {
                    Remove-Item -LiteralPath $p -Force
                }
                Remove-EmptyParents $p $stopBak
            } catch {
                $failed.Add(@{ path = $p; error = [string]$_.Exception.Message })
            }
        }
    } else {
        foreach ($e in $material) {
            if (Test-Path -LiteralPath $e.path) { $kept.Add($e.path) }
        }
    }

    $ok = ($failed.Count -eq 0)
    if (-not $ok) {
        # 恢复失败：材料一份都不许删，全部列出来（调用方据此 exit 非零、不称成功）
        foreach ($e in $material) {
            if ((Test-Path -LiteralPath $e.path) -and -not $kept.Contains($e.path)) { $kept.Add($e.path) }
        }
    }

    return @{
        schema    = 'whale-install-restore/1'
        plan      = $Plan.schema
        home      = $Plan.home
        profile   = $Plan.profile
        ok        = $ok
        restored  = $restored.ToArray()
        failed    = $failed.ToArray()
        kept      = $kept.ToArray()
        backups   = @($actualBackups)
        material  = @($material | ForEach-Object { $_.path })
    }
}

Write-Host ''
Say "== install dsh-whale-sensei into profile '$Profile' ==" 'Cyan'
Say "   package : $PackageDir"
Say "   profile : $ProfileDir"
Write-Host ''

if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) { throw "not a package: $PackageDir" }
if (-not (Test-Path $PkgJson)) { throw "no profile package.json: $PkgJson" }

# --- the live-host probe -----------------------------------------------------
# Judge with a raw TCP connect, NOT Get-NetTCPConnection.  On some machines (and
# in any restricted shell) the CIM query returns NOTHING while the port really is
# listening -- measured on this very machine: netstat showed 127.0.0.1:3090
# LISTENING and TcpClient connected, while Get-NetTCPConnection answered empty.
# A false "free" here means editing the profile of a RUNNING host, so the direct
# probe is the one that decides.
function Test-PortOpen([int] $Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# --- 0a) -Preflight: report the environment, touch nothing -------------------
if ($Preflight) {
    Say ''
    Say '== preflight (this mode writes nothing) ==' 'Cyan'
    $bad = 0
    Say ("  DSH_HOME        : {0}" -f $DshHome) 'Green'
    Say ("  profile dir     : {0}" -f $ProfileDir) 'Green'
    Say ("  plugin checkout : {0}" -f $PackageDir) 'Green'
    if (Test-Path (Join-Path $PackageDir 'package.json')) {
        Say '  plugin manifest : found' 'Green'
    } else {
        Say ("  plugin manifest : MISSING -- {0}\package.json not found" -f $PackageDir) 'Red'
        $bad++
    }
    if ($dshPre.Count -gt 0) {
        Say '  dsh command     : npx @deepseek-ai/dsh   (dsh is NOT on PATH)' 'Yellow'
    } else {
        Say ("  dsh command     : {0}" -f $dshOnPath.Source) 'Green'
    }
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Say '  node            : NOT FOUND -- the host needs Node >= 22.19' 'Red'
        $bad++
    } else {
        $nv = (& node -v 2>$null)
        Say ("  node            : {0}   (host needs >= 22.19)" -f $nv) 'Green'
    }
    if (Test-Path -LiteralPath (Join-Path $PackageDir 'preset\whale-mode\agent.cordis.yml')) {
        Say '  preset template : found -- 1c installs 鲸师模式' 'Green'
    } else {
        # RED, not a warning (2026-09-27): this is exactly the state that made 鲸师模式
        # vanish on other machines -- the npm tarball shipped no preset/ at all. A package
        # without the template cannot deliver the preset, so "installable" is a lie.
        Say '  preset template : MISSING -- 鲸师模式 cannot be installed at all' 'Red'
        Say ("                    expected: {0}\preset\whale-mode\agent.cordis.yml" -f $PackageDir) 'DarkGray'
        Say '                    (this package is incomplete: rebuild it with  node preset/whale-mode/build-preset.mjs)' 'DarkGray'
        $bad++
    }
    if (Test-PortOpen $HostPort) {
        Say ("  port {0}        : LISTENING -- close DeepSeek Harness before installing" -f $HostPort) 'Yellow'
    } else {
        Say ("  port {0}        : free" -f $HostPort) 'Green'
    }
    Say ''
    if ($bad -gt 0) { Say 'preflight: NOT ready -- fix the red lines above first.' 'Red'; exit 1 }
    Say 'preflight: environment looks installable.' 'Green'
    exit 0
}

# --- 0) refuse to touch a LIVE host -----------------------------------------
if (-not $SkipHostCheck) {
    if (Test-PortOpen $HostPort) {
        Say "REFUSING: something is still listening on port $HostPort (the DSH web host?)." 'Yellow'
        Say "           Close DeepSeek Harness completely, then run this again." 'Yellow'
        Say "           (override with -SkipHostCheck ONLY if you know that port is something else.)" 'DarkGray'
        exit 2
    }
    Say "port $HostPort is free -- host looks closed, good." 'DarkGray'
}

# --- build the plan (READ-ONLY) ----------------------------------------------
# Everything from here on is reporting: the plan says what WOULD change, and
# Invoke-InstallPlan is the only thing that ever changes it.
$Plan = Get-InstallPlan -HomeDir $DshHome -Prof $Profile -PkgDir $PackageDir -Root $PackRoot `
                        -SkipSnap:([bool]$SkipSnapshot) -SkipPre:([bool]$SkipPreset) `
                        -OnlyPackRoot:([bool]$PackRootOnly) -IsDryRun:([bool]$DryRun)

# --- 1) -DryRun: print the plan, touch nothing, start nothing ------------------
# NOT "skip everything": the plan is still computed in full, only the executor
# is never called.  This is why no backup directory appears either.
if ($DryRun) {
    Write-Host ''
    Say '== DRY RUN -- plan only: nothing is written, no command is started ==' 'Yellow'
    Say ("PLAN schema={0} mode={1} dryRun={2}" -f $Plan.schema, $Plan.mode, $Plan.dryRun) 'Gray'
    Say ("PLAN home={0}" -f $Plan.home) 'Gray'
    Say ("PLAN profile={0}" -f $Plan.profile) 'Gray'
    Say ("PLAN profileDir={0}" -f $Plan.profileDir) 'Gray'
    Say ("PLAN packageDir={0}" -f $Plan.packageDir) 'Gray'
    Say ("PLAN snapshotDir={0}" -f $(if ($Plan.snapshotDir) { $Plan.snapshotDir } else { '-' })) 'Gray'
    foreach ($w in $Plan.writes) {
        Say ("PLAN writes path={0} existed={1} bytes={2} sha256={3}" -f $w.path, $w.existed, $w.bytes, $w.sha256) 'Gray'
    }
    # T22 的两个新字段另起一行：上面那行的形状被 T21 的用例钉死了，不许改。
    foreach ($w in $Plan.writes) {
        Say ("PLAN write-meta path={0} home={1} installedVersion={2}" -f $w.path, $w.home, $w.installedVersion) 'Gray'
    }
    # T22-R2：形状判定也如实进计划。-DryRun 只打印、本来就不写盘 ⇒ **绝不**因为形状不支持而让它非零退出。
    Say ("PLAN patch-shape ok={0} rule={1} reason={2}" -f $Plan.patchShape.ok, $Plan.patchShape.rule, $Plan.patchShape.reason) 'Gray'
    Say ("PLAN add-targets enumerated={0} :: {1}" -f $Plan.addTargetsEnumerated, (@($Plan.addTargets) -join '; ')) 'Gray'
    foreach ($op in $Plan.operations) {
        Say ("PLAN op kind={0} path={1} sideEffect={2}" -f $op.kind, $op.path, $op.sideEffect) 'Gray'
    }
    if ($Plan.patchText) {
        Say '-- cordis.patch.yml would become --' 'DarkGray'
        Write-Host $Plan.patchText
    }
    Say 'DRY RUN -- nothing written, no child process started.' 'Yellow'
    exit 0
}

# --- 2) execute the plan (the ONE executor) ----------------------------------
$Result = Invoke-InstallPlan $Plan

# --- 2b) -PackRootOnly: the narrowed mode ends here --------------------------
# Its plan never contained a snapshot, a preset step or a `dsh plugin add`, so
# the only thing that can have happened is the patch write (+ its own backup).
if ($Plan.mode -eq 'packroot-only') {
    Write-Host ''
    Say '(-PackRootOnly: plugin install skipped -- only packRoot was touched.)' 'DarkGray'
    Write-Host ''
    if ($Result.softFail) { exit 1 }
    exit 0
}

# §3.6：连 `dsh add` 的目标都枚举不出来 ⇒ 拒绝事务安装（这时一个字节都没写过）。
if ($Result.refused) { exit 5 }

# A failed 'dsh plugin add' used to stop right there -- keep stopping there.
if ($Result.aborted) { exit 1 }

# A FAIL above must not look like success to a caller or to CI.
$script:softFail = $Result.softFail
if ($script:softFail) { exit 1 }

# 恢复本身失败：exit 非零、材料保留、不称成功（判词已经在上面打过）。
if ($Result.restoreFailed) { exit 1 }
