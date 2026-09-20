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

  NOTE: keep every literal in this file ASCII -- Windows PowerShell 5.1 reads a
  BOM-less .ps1 as ANSI and mangles non-ASCII, which can even break the parser.
#>
[CmdletBinding()]
param(
    [string] $PackageDir = 'E:\workplace\dsh-whale-sensei',
    [string] $Profile    = 'web',
    [int]    $HostPort   = 3090,
    [switch] $SkipHostCheck,
    [switch] $SkipSnapshot
)

$ErrorActionPreference = 'Stop'
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { 'E:\App\dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PkgJson    = Join-Path $ProfileDir 'package.json'
$BackupRoot = 'E:\workplace\_dsh-plugin-backup'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

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

# --- 2) add as link: ---------------------------------------------------------
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
