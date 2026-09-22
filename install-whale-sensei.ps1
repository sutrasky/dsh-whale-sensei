<#
  install-whale-sensei.ps1 -- install the course plugin (dsh-whale-sensei) into the `web` profile.

  RUN THIS WITH DEEPSEEK HARNESS CLOSED.
  The script refuses to proceed while the DSH web host is still listening on 3090.

  WHY `link:` AND NOT `file:` ------------------------------------------------
  With `file:` pnpm COPIES the package into the profile, so every code edit needs
  "close DSH -> reinstall -> restart".  With `link:` the profile points straight at
  E:\workplace\dsh-whale-sensei, so an edit only needs a restart.

  WHAT THIS SCRIPT DOES ------------------------------------------------------
    1) snapshots the profile package.json      (rollback is one command)
    2) dsh plugin --profile web add link:E:/workplace/dsh-whale-sensei
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

  NOTE: keep every literal in this file ASCII -- Windows PowerShell 5.1 reads a
  BOM-less .ps1 as ANSI and mangles non-ASCII, which can even break the parser.
#>
[CmdletBinding()]
param(
    [string] $PackageDir = 'E:\workplace\dsh-whale-sensei',
    [string] $Profile    = 'web',
    [string] $PackRoot   = '',
    [int]    $HostPort   = 3090,
    [switch] $SkipHostCheck,
    [switch] $SkipSnapshot,
    [switch] $PackRootOnly,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { 'E:\App\dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PkgJson    = Join-Path $ProfileDir 'package.json'
$PatchYml   = Join-Path $ProfileDir 'cordis.patch.yml'
$BackupRoot = 'E:\workplace\_dsh-plugin-backup'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

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

Write-Host ''
Say "== install dsh-whale-sensei into profile '$Profile' ==" 'Cyan'
Say "   package : $PackageDir"
Say "   profile : $ProfileDir"
Write-Host ''

if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) { throw "not a package: $PackageDir" }
if (-not (Test-Path $PkgJson)) { throw "no profile package.json: $PkgJson" }

# --- 0) refuse to touch a LIVE host -----------------------------------------
if (-not $SkipHostCheck) {
    $live = Get-NetTCPConnection -LocalPort $HostPort -State Listen -ErrorAction SilentlyContinue
    if ($live) {
        Say "REFUSING: something is still listening on port $HostPort (the DSH web host?)." 'Yellow'
        Say "           Close DeepSeek Harness completely, then run this again." 'Yellow'
        Say "           (override with -SkipHostCheck ONLY if you know that port is something else.)" 'DarkGray'
        exit 2
    }
    Say "port $HostPort is free -- host looks closed, good." 'DarkGray'
}

# --- 1) snapshot -------------------------------------------------------------
$snap = ''
if (-not $SkipSnapshot) {
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    $snap = Join-Path $BackupRoot ("{0}-pre-whale-sensei" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force -Path $snap | Out-Null
    Copy-Item $PkgJson (Join-Path $snap 'package.json') -Force
    Say "snapshot : $snap" 'DarkGray'
}

# --- 1b) packRoot -> PROFILE-level cordis.patch.yml --------------------------
# Why here and not in the package patch: the shipped cordis.patch.yml is replaced
# on every reinstall, so machine-local values must live in the profile layer.
if ($PackRoot) {
    Write-Host ''
    Say '== packRoot (profile-level cordis.patch.yml) ==' 'Cyan'
    if (-not (Test-Path -LiteralPath $PackRoot)) { throw "PackRoot does not exist: $PackRoot" }
    $rootFull = (Resolve-Path -LiteralPath $PackRoot).Path
    if (-not (Test-Path -LiteralPath (Join-Path $rootFull 'presets\whale-sensei.css'))) {
        Say "WARN: $rootFull has no presets\whale-sensei.css" 'Yellow'
        Say '      (that file is how a directory is recognised as a course pack)' 'DarkGray'
    }

    $nl    = "`r`n"
    $lines = @()
    if (Test-Path -LiteralPath $PatchYml) {
        $raw = [System.IO.File]::ReadAllText($PatchYml)
        if ($raw -notmatch "`r`n") { $nl = "`n" }
        $lines = @($raw -split "`r?`n")
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
            $lines = @($lines[0..($lines.Count - 2)])
        }
    } else {
        Say "creating : $PatchYml" 'DarkGray'
    }

    $newText = ((Get-PatchedYml $lines $rootFull) -join $nl) + $nl

    if ($DryRun) {
        Say 'DRY RUN -- nothing written. Content would become:' 'Yellow'
        Write-Host $newText
    } else {
        if (Test-Path -LiteralPath $PatchYml) {
            $bak = "$PatchYml.bak-whale-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item -LiteralPath $PatchYml -Destination $bak -Force
            Say "backup   : $bak" 'DarkGray'
        }
        # UTF-8 without BOM, original newline style -- do not churn the whole file
        [System.IO.File]::WriteAllText($PatchYml, $newText, (New-Object System.Text.UTF8Encoding($false)))
        $after   = [System.IO.File]::ReadAllText($PatchYml)
        $hitLine = ($after -split "`r?`n") | Where-Object { $_ -match '^\s*packRoot\s*:' } | Select-Object -First 1
        if ($hitLine) {
            Say ('OK   wrote: ' + $hitLine.Trim()) 'Green'
            Say '     -> RESTART DeepSeek Harness: packRoot is resolved once, at boot.' 'Green'
        } else {
            Say 'FAIL packRoot did not land in cordis.patch.yml -- inspect it by hand.' 'Red'
        }
    }
}

# --- 2) add as link: ---------------------------------------------------------
if ($PackRootOnly) {
    Write-Host ''
    Say '(-PackRootOnly: plugin install skipped -- only packRoot was touched.)' 'DarkGray'
    Write-Host ''
    exit 0
}

Write-Host ''
Say ">> dsh plugin --profile $Profile add link:$PackageDir" 'Cyan'
& dsh plugin --profile $Profile add "link:$PackageDir"
if ($LASTEXITCODE -ne 0) {
    Say "FAILED: 'dsh plugin add' exited $LASTEXITCODE" 'Red'
    exit 1
}

# --- 3) dump-config: the only reliable judge ---------------------------------
Write-Host ''
Say ">> dsh --profile $Profile --dump-config" 'Cyan'
$dump = (& dsh --profile $Profile --dump-config 2>&1 | Out-String)
$hit = ($dump -split "`n") | Where-Object { $_ -match '-\s*id:\s*whale-sensei' }

Write-Host ''
if ($hit) {
    Say 'OK   dump-config contains:' 'Green'
    $hit | Select-Object -First 3 | ForEach-Object { Say ("       " + $_.Trim()) 'Green' }
    Say ''
    Say 'Next: start DeepSeek Harness and check that boot.json got a version fingerprint,' 'Green'
    Say '      then ask the agent to call the tool  whale_ping  (it should echo back).' 'Green'
    if (-not $PackRoot) {
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
    Say '     => the plugin did NOT get assembled. Do not trust "installed".' 'Red'
    Say '     roll back with the command below, then send me the dump-config output.' 'Red'
}

# --- 4) rollback -------------------------------------------------------------
Write-Host ''
Say 'rollback (either one):' 'DarkGray'
Say "  dsh plugin --profile $Profile remove dsh-whale-sensei" 'DarkGray'
if ($snap) { Say "  Copy-Item '$snap\package.json' '$PkgJson' -Force" 'DarkGray' }
Write-Host ''
