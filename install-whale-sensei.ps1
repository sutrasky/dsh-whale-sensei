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

    $idRe   = '^(?<ind>\s*)-\s*id:\s*whale-sensei\s*$'
    $nextRe = '^\s*-\s+\S'
    $idAt   = -1
    for ($i = 0; $i -lt $list.Count; $i++) {
        if ($list[$i] -match $idRe) { $idAt = $i; break }
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
#   Restore-InstallPlan The counterpart of the recorded writes: it turns the
#                       "original bytes / did not exist yet" material back into
#                       a restore list.  (Wiring restore to the command line is
#                       a later card; T21 only has to RECORD the material.)
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
#>
function Get-WriteRecord([string] $Path, [string] $Kind) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ path = $Path; existed = $false; bytes = 0; sha256 = ''; kind = $Kind }
    }
    $raw = [System.IO.File]::ReadAllBytes($Path)
    return @{
        path    = $Path
        existed = $true
        bytes   = $raw.Length
        sha256  = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        kind    = $Kind
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
    $presetYml = Join-Path $HomeDir '.agent-presets\whale-mode\agent.cordis.yml'
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

    if ($snapDir) {
        $ops.Add(@{ kind = 'snapshot'; path = $snapDir; why = '回滚材料：把 profile 的 package.json 拷进带时间戳的快照目录'; sideEffect = $true })
        $writes.Add(@{ path = $snapDir; existed = $false; bytes = 0; sha256 = ''; kind = 'snapshot' })
        $writes.Add(@{ path = (Join-Path $snapDir 'package.json'); existed = $false; bytes = 0; sha256 = ''; kind = 'snapshot' })
    }

    $backupPattern = ''
    if ($rootFull) {
        $backupPattern = "$patchYml.bak-whale-<ts>"
        $ops.Add(@{ kind = 'patch-write'; path = $patchYml; why = "把 packRoot '$rootFull' 写进 profile 级 cordis.patch.yml"; sideEffect = $true; backupPattern = $backupPattern })
        $writes.Add((Get-WriteRecord $patchYml 'patch-write'))
        if ($patchThere) {
            $writes.Add(@{ path = $backupPattern; existed = $false; bytes = 0; sha256 = ''; kind = 'patch-write' })
        }
    }

    if ($mode -eq 'install') {
        if (-not $SkipPre) {
            $ops.Add(@{ kind = 'preset-install'; path = $presetYml; why = '跑 lib\preset-install.js 把鲸师模式预设写进 .agent-presets'; sideEffect = $true })
            $writes.Add((Get-WriteRecord $presetYml 'preset-install'))
        }
        $ops.Add(@{ kind = 'plugin-add'; path = $pkgJson; why = "dsh plugin --profile $Prof add link:$pkgFull"; sideEffect = $true })
        $writes.Add((Get-WriteRecord $pkgJson 'plugin-add'))
        $ops.Add(@{ kind = 'dump-config'; path = ''; why = '只读判定：dump-config 里必须出现  - id: whale-sensei'; sideEffect = $true })
        if (-not $SkipPre) {
            $ops.Add(@{ kind = 'preset-verify'; path = $presetYml; why = '只读判定：预设文件必须已经落在磁盘上'; sideEffect = $false })
        }
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
        backupRoot         = $BackupRoot
        pkgJson            = $pkgJson
        patchYml           = $patchYml
        patchText          = $patchText
        patchExists        = $patchThere
        patchBackupPattern = $backupPattern
        presetYml          = $presetYml
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
                Say '== packRoot (profile-level cordis.patch.yml) ==' 'Cyan'
                if ($Plan.patchExists) {
                    $bak = "$($Plan.patchYml).bak-whale-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                    Copy-Item -LiteralPath $Plan.patchYml -Destination $bak -Force
                    $out.patchBackup = $bak
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
                    Say ('OK   wrote: ' + $hitLine.Trim()) 'Green'
                    Say '     -> RESTART DeepSeek Harness: packRoot is resolved once, at boot.' 'Green'
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
                        Say '     -> 开会话时选「鲸师模式」（不用等重启：宿主每次列预设都重读磁盘）' 'Green'
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
                    Say 'OK   dump-config contains:' 'Green'
                    $hit | Select-Object -First 3 | ForEach-Object { Say ("       " + $_.Trim()) 'Green' }
                    Say ''
                    Say 'Next: start DeepSeek Harness and check that boot.json got a version fingerprint,' 'Green'
                    Say '      then ask the agent to call the tool  whale_ping  (it should echo back).' 'Green'
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
                    Say 'OK   agent preset 鲸师模式 is on disk:' 'Green'
                    Say ("       {0}" -f $Plan.presetYml) 'Green'
                    Say '       -> 开会话时选它（宿主每次列预设都重读磁盘，不用重启）' 'Green'
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
        if ($out.aborted) { break }
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
}

<#
  The other half of the recorded writes: every target in $Plan.writes carries
  its original bytes (or "it did not exist yet"), so a restore can put the
  machine back.  This entry point exists so that material has exactly one
  consumer; wiring it to the command line is a later card's job.
#>
function Restore-InstallPlan {
    param([hashtable] $Plan)

    $items = New-Object System.Collections.Generic.List[hashtable]
    foreach ($w in $Plan.writes) {
        $items.Add(@{
            path    = $w.path
            existed = $w.existed
            bytes   = $w.bytes
            sha256  = $w.sha256
            kind    = $w.kind
        })
    }
    $backups = New-Object System.Collections.Generic.List[string]
    foreach ($op in $Plan.operations) {
        if ($op.ContainsKey('backupPattern') -and $op.backupPattern) { $backups.Add($op.backupPattern) }
    }
    return @{
        schema  = 'whale-install-restore/1'
        plan    = $Plan.schema
        home    = $Plan.home
        profile = $Plan.profile
        items   = $items.ToArray()
        backups = $backups.ToArray()
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

# A failed 'dsh plugin add' used to stop right there -- keep stopping there.
if ($Result.aborted) { exit 1 }

# A FAIL above must not look like success to a caller or to CI.
$script:softFail = $Result.softFail
if ($script:softFail) { exit 1 }
