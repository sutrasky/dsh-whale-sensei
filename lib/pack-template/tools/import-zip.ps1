# import-zip.ps1 -- controlled ZIP extractor for the offline reader's course-data import
# ------------------------------------------------------------------------------------
# WHY THIS FILE EXISTS (report D01 / P1, task card T05):
#   The offline admin used to hand the uploaded .zip to `tar -xf` and *then* look at what
#   came out. That is "extract first, ask later": the archive could plant files we never
#   wanted (tools/**, lessons/src/**, any *.js), and the extractor itself was a black box
#   (no entry budget, no size budget, no link check, no path check).
#
#   This helper is the replacement. It is the ONLY process the importer starts, and it
#   never writes outside the staging directory it is told to use:
#     phase 1  scan EVERY entry: shape checks (absolute / `..` / backslash / drive /
#              control chars / device names / ADS), duplicate + case-collision checks,
#              link + special-file checks, entry budget, per-file budget, total budget,
#              compression-ratio budget, wall-clock budget -- and an ALLOWLIST of what
#              course data may look like at all.
#     phase 2  only if phase 1 found nothing: stream-write the allowed entries.
#   A rejected archive writes NOTHING (the staging tree stays empty), so the caller can
#   promise "the library tree does not change on rejection".
#
# WHY POWERSHELL / .NET ZipArchive (card decision, verbatim): use the Windows built-in
#   PowerShell/.NET ZipArchive to validate entry by entry and stream-write into a
#   self-built staging directory, instead of "untar first, verify later". On a platform
#   without it we FAIL HARD (code ZIP_NOT_SUPPORTED) -- there is deliberately NO silent
#   fallback to tar.
#
# CONTRACT
#   in : -Zip <file> -Staging <dir> -Result <json file>
#        -IdPattern / -MaxEntries / -MaxFile / -MaxTotal / -MaxRatio / -TimeoutSec
#        (defaults ARE the production limits; the caller passes nothing to weaken them)
#   out: JSON at -Result, ALWAYS written (also on rejection):
#        { ok, code, error, entries, files:[rel], decisions:[{rel,keep,reason}],
#          bytes, elapsedMs }
#        exit code is 0 whenever the receipt was written; 4 only if it could not be.
#        codes: OK | ZIP_NOT_SUPPORTED | ZIP_MISSING | ZIP_STAGING_NOT_EMPTY |
#               ZIP_OPEN_FAILED | ZIP_TOO_MANY_ENTRIES | ZIP_ENTRY_TOO_BIG |
#               ZIP_TOTAL_TOO_BIG | ZIP_RATIO | ZIP_TIMEOUT | ZIP_DANGEROUS_ENTRY |
#               ZIP_LINK_ENTRY | ZIP_DUPLICATE_ENTRY | ZIP_ENTRY_NOT_ALLOWED |
#               ZIP_IO_ERROR
#
# NOTE: this file must stay PURE ASCII -- Windows PowerShell 5.1 reads a .ps1 without a
#   BOM as ANSI/GBK, and non-ASCII comments would be mangled (same rule as the other
#   .ps1 files shipped with this pack).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [Parameter(Mandatory = $true)][string]$Staging,
  [Parameter(Mandatory = $true)][string]$Result,
  [string]$IdPattern = '^[a-z][a-z0-9-]*$',
  [int]$MaxEntries = 4096,
  [long]$MaxFile = 33554432,
  [long]$MaxTotal = 268435456,
  [int]$MaxRatio = 100,
  [int]$TimeoutSec = 30,
  [int]$MaxDecisions = 4096
)

$ErrorActionPreference = 'Stop'
$script:clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:decisions = New-Object System.Collections.ArrayList
$script:files = New-Object System.Collections.ArrayList
$script:entries = 0
$script:bytes = [long]0

# Segments that may never appear as a halo / point directory name. The allowlist already
# pins the file name at every depth, so `lessons/src/alpha/halo.json` cannot sneak in as
# a "point"; this list also keeps `lessons/src/**` and `lessons/tools/**` out by name.
$ReservedSegments = @('src', 'tools', 'node_modules')

function Write-Receipt {
  param([bool]$Ok, [string]$Code, [string]$Message)
  $payload = [ordered]@{
    ok         = $Ok
    code       = $Code
    error      = $Message
    entries    = [int]$script:entries
    files      = @($script:files)
    decisions  = @($script:decisions)
    bytes      = [long]$script:bytes
    elapsedMs  = [int]$script:clock.Elapsed.TotalMilliseconds
  }
  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Result, $json, $enc)
}

function Finish {
  param([bool]$Ok, [string]$Code, [string]$Message)
  Write-Receipt -Ok $Ok -Code $Code -Message $Message
  exit 0
}

# A rejection is a normal outcome, not a crash: carry the code inside the exception text.
function Reject {
  param([string]$Code, [string]$Message)
  throw ('__ZIPREJECT__' + $Code + '|' + $Message)
}

function Add-Decision {
  param([string]$Rel, [bool]$Keep, [string]$Reason)
  if ($script:decisions.Count -lt $MaxDecisions) {
    $script:decisions.Add([ordered]@{ rel = $Rel; keep = $Keep; reason = $Reason }) | Out-Null
  }
}

function Test-Timeout {
  if ($script:clock.Elapsed.TotalSeconds -gt $TimeoutSec) {
    Reject 'ZIP_TIMEOUT' ("processing exceeded the {0}s budget" -f $TimeoutSec)
  }
}

function Test-ReservedDevice {
  param([string]$Segment)
  $stem = $Segment
  $dot = $stem.IndexOf('.')
  if ($dot -ge 0) { $stem = $stem.Substring(0, $dot) }
  if ($stem -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') { return $true }
  return $false
}

# Shape check + normalization. Returns the POSIX relative path, or '' for the root dir
# entry. Throws a rejection for anything that must never reach the filesystem.
function Get-SafeRelative {
  param([string]$Raw)
  $n = $Raw
  while ($n.StartsWith('./')) { $n = $n.Substring(2) }
  if ($n -eq '' -or $n -eq '.') { return '' }
  if ($n -match '[\x00-\x1f\x7f]') { Reject 'ZIP_DANGEROUS_ENTRY' ("entry name has control characters: " + [System.BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes($Raw))) }
  if ($n.Contains('\')) { Reject 'ZIP_DANGEROUS_ENTRY' ("entry uses a backslash separator: " + $n) }
  if ($n.StartsWith('/')) { Reject 'ZIP_DANGEROUS_ENTRY' ("entry is an absolute path: " + $n) }
  if ($n -match '^[A-Za-z]:') { Reject 'ZIP_DANGEROUS_ENTRY' ("entry has a drive letter: " + $n) }
  if ($n.Contains(':')) { Reject 'ZIP_DANGEROUS_ENTRY' ("entry has a colon (drive / alternate data stream): " + $n) }
  $segs = $n.Split('/')
  foreach ($s in $segs) {
    if ($s -eq '') { Reject 'ZIP_DANGEROUS_ENTRY' ("entry has an empty path segment: " + $n) }
    if ($s -eq '.' -or $s -eq '..') { Reject 'ZIP_DANGEROUS_ENTRY' ("entry has a traversal segment: " + $n) }
    if ($s.EndsWith(' ') -or $s.EndsWith('.')) { Reject 'ZIP_DANGEROUS_ENTRY' ("entry segment ends with a space or dot (Windows would trim it): " + $n) }
    if (Test-ReservedDevice $s) { Reject 'ZIP_DANGEROUS_ENTRY' ("entry segment is a reserved device name: " + $n) }
  }
  return $n
}

function Test-IdSegment {
  param([string]$Segment)
  if (-not ($Segment -cmatch $IdPattern)) { return $false }
  if ($ReservedSegments -ccontains $Segment) { return $false }
  return $true
}

# The allowlist: what course data may look like. `$null` = not course data.
function Get-EntryKind {
  param([string]$Rel)
  $segs = $Rel.Split('/')
  $n = $segs.Count
  if ($n -eq 1) {
    if ($Rel -ceq 'pack.json') { return 'pack' }
    return $null
  }
  if ($segs[0] -cne 'lessons') { return $null }
  if ($n -eq 2) {
    if ($segs[1] -ceq 'lessons.json') { return 'index' }
    return $null
  }
  if ($n -eq 3) {
    if (($segs[2] -ceq 'halo.json') -and (Test-IdSegment ($segs[1]))) { return 'halo' }
    return $null
  }
  if ($n -eq 4) {
    # `lessons/<halo>/<point>/<name>` -- either the point structure or one lesson page.
    # Use case-SENSITIVE `-cmatch`: `0001-X.HTML` and `0001-x.html` are the SAME file on
    # Windows, so this allowlist must judge every entry exactly like the JS mirror does.
    if (-not ((Test-IdSegment ($segs[1])) -and (Test-IdSegment ($segs[2])))) { return $null }
    if ($segs[3] -ceq 'point.json') { return 'point' }
    $okName = ($segs[3] -cmatch '^[^\\/:*?"<>|]+\.html$') -and (-not $segs[3].StartsWith('.'))
    if ($okName) { return 'lesson' }
    return $null
  }
  return $null
}

# ---------------------------------------------------------------- platform capability
try {
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $null = [System.IO.Compression.ZipArchive]
} catch {
  Finish -Ok $false -Code 'ZIP_NOT_SUPPORTED' -Message ('this platform cannot provide System.IO.Compression.ZipArchive: ' + $_.Exception.Message)
}

# ---------------------------------------------------------------- inputs
$zipPath = [System.IO.Path]::GetFullPath($Zip)
if (-not [System.IO.File]::Exists($zipPath)) {
  Finish -Ok $false -Code 'ZIP_MISSING' -Message ('archive not found: ' + $zipPath)
}
$stagePath = [System.IO.Path]::GetFullPath($Staging)
if ([System.IO.Directory]::Exists($stagePath)) {
  $left = @([System.IO.Directory]::GetFileSystemEntries($stagePath))
  if ($left.Count -gt 0) {
    Finish -Ok $false -Code 'ZIP_STAGING_NOT_EMPTY' -Message ('staging directory is not empty: ' + $stagePath)
  }
} else {
  [System.IO.Directory]::CreateDirectory($stagePath) | Out-Null
}
$resultPath = [System.IO.Path]::GetFullPath($Result)
$resultDir = [System.IO.Path]::GetDirectoryName($resultPath)
if (-not [System.IO.Directory]::Exists($resultDir)) {
  [System.IO.Directory]::CreateDirectory($resultDir) | Out-Null
}

# ---------------------------------------------------------------- scan, then extract
# The archive handle stays open across BOTH phases (phase 2 re-reads the very entries
# phase 1 approved), so one try/finally owns it.
$plan = New-Object System.Collections.ArrayList
$failCode = $null
$failMsg = $null
$archive = $null
try {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  $all = @($archive.Entries)
  $script:entries = $all.Count
  if ($all.Count -gt $MaxEntries) {
    Reject 'ZIP_TOO_MANY_ENTRIES' ("archive has {0} entries; the budget is {1}" -f $all.Count, $MaxEntries)
  }
  $seen = @{}
  $declared = [long]0
  foreach ($e in $all) {
    Test-Timeout
    $raw = [string]$e.FullName
    $ext = [int64]$e.ExternalAttributes
    if ($ext -lt 0) { $ext += 4294967296 }
    $unix = [int](($ext -shr 16) -band 0xFFFF)
    $utype = $unix -band 0xF000
    $isDir = $raw.EndsWith('/') -or ($utype -eq 0x4000) -or (($ext -band 0x10) -ne 0)
    $isLink = ($utype -eq 0xA000)
    $isSpecial = ($utype -ne 0) -and ($utype -ne 0x8000) -and ($utype -ne 0x4000)

    # Directory entries carry a trailing '/' (`./lessons/`): that slash is the entry's
    # own marker, not an empty path segment -- strip exactly one before normalizing.
    $shape = $raw
    if ($isDir -and $shape.EndsWith('/')) { $shape = $shape.Substring(0, $shape.Length - 1) }
    $rel = ''
    try { $rel = Get-SafeRelative $shape } catch { $rel = $null }
    if ($null -eq $rel) {
      $code = 'ZIP_DANGEROUS_ENTRY'
      $msg = 'entry name rejected: ' + $raw
      Add-Decision $raw $false $code
      if (-not $failCode) { $failCode = $code; $failMsg = $msg }
      continue
    }
    if ($isDir) {
      if ($rel -ne '') {
        $key = $rel.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
          if ($seen[$key] -cne $rel) {
            Add-Decision $rel $false 'ZIP_DUPLICATE_ENTRY'
            if (-not $failCode) { $failCode = 'ZIP_DUPLICATE_ENTRY'; $failMsg = ('two entries differ only by case: ' + $rel) }
            continue
          }
        } else {
          $seen[$key] = $rel
        }
      }
      Add-Decision $rel $false 'dir'
      continue
    }
    if ($isLink) {
      Add-Decision $rel $false 'ZIP_LINK_ENTRY'
      if (-not $failCode) { $failCode = 'ZIP_LINK_ENTRY'; $failMsg = ('archive entry is a link, not a file: ' + $rel) }
      continue
    }
    if ($isSpecial) {
      Add-Decision $rel $false 'ZIP_LINK_ENTRY'
      if (-not $failCode) { $failCode = 'ZIP_LINK_ENTRY'; $failMsg = ('archive entry is not a regular file: ' + $rel) }
      continue
    }
    $key = $rel.ToLowerInvariant()
    if ($seen.ContainsKey($key)) {
      Add-Decision $rel $false 'ZIP_DUPLICATE_ENTRY'
      if (-not $failCode) {
        $failCode = 'ZIP_DUPLICATE_ENTRY'
        if ($seen[$key] -cne $rel) { $failMsg = ('two entries differ only by case: ' + $rel + ' vs ' + $seen[$key]) }
        else { $failMsg = ('entry appears twice: ' + $rel) }
      }
      continue
    }
    $seen[$key] = $rel
    $kind = Get-EntryKind $rel
    if ($null -eq $kind) {
      Add-Decision $rel $false 'ZIP_ENTRY_NOT_ALLOWED'
      if (-not $failCode) { $failCode = 'ZIP_ENTRY_NOT_ALLOWED'; $failMsg = ('this archive carries something that is not course data: ' + $rel) }
      continue
    }
    $len = [long]$e.Length
    $clen = [long]$e.CompressedLength
    if ($len -gt $MaxFile) {
      Add-Decision $rel $false 'ZIP_ENTRY_TOO_BIG'
      if (-not $failCode) { $failCode = 'ZIP_ENTRY_TOO_BIG'; $failMsg = ('entry is larger than the per-file budget: ' + $rel) }
      continue
    }
    if (($declared + $len) -gt $MaxTotal) {
      Add-Decision $rel $false 'ZIP_TOTAL_TOO_BIG'
      if (-not $failCode) { $failCode = 'ZIP_TOTAL_TOO_BIG'; $failMsg = ('unpacked total would exceed the budget: ' + $rel) }
      continue
    }
    if ($len -gt 0) {
      if (($clen -le 0) -or (($len / $clen) -gt $MaxRatio)) {
        Add-Decision $rel $false 'ZIP_RATIO'
        if (-not $failCode) { $failCode = 'ZIP_RATIO'; $failMsg = ('entry looks like a compression bomb (ratio over {0}:1): ' + $rel) -f $MaxRatio }
        continue
      }
    }
    $declared += $len
    $plan.Add([ordered]@{ entry = $e; rel = $rel; kind = $kind; len = $len }) | Out-Null
    Add-Decision $rel $true $kind
  }
  # -------------------------------------------------------------- phase 2: stream out
  # Reached ONLY when phase 1 found nothing: a rejected archive leaves the staging tree
  # empty (that is what lets the caller promise "the library tree does not change").
  if (-not $failCode) {
    foreach ($item in $plan) {
      Test-Timeout
      $rel = [string]$item.rel
      $target = [System.IO.Path]::Combine($stagePath, $rel.Replace('/', '\'))
      $parent = [System.IO.Path]::GetDirectoryName($target)
      if (-not [System.IO.Directory]::Exists($parent)) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
      }
      $in = $null
      $out = $null
      $written = [long]0
      try {
        $in = $item.entry.Open()
        $out = [System.IO.File]::Create($target)
        $buf = New-Object byte[] 65536
        while (($read = $in.Read($buf, 0, $buf.Length)) -gt 0) {
          Test-Timeout
          $out.Write($buf, 0, $read)
          $written += $read
          if ($written -gt $MaxFile) {
            Reject 'ZIP_ENTRY_TOO_BIG' ('entry wrote more than the per-file budget (forged header?): ' + $rel)
          }
          if (($script:bytes + $written) -gt $MaxTotal) {
            Reject 'ZIP_TOTAL_TOO_BIG' ('unpacked total exceeded the budget (forged header?): ' + $rel)
          }
        }
      } finally {
        if ($null -ne $out) { try { $out.Dispose() } catch { } }
        if ($null -ne $in) { try { $in.Dispose() } catch { } }
      }
      $script:bytes += $written
      $script:files.Add($rel) | Out-Null
    }
  }
} catch {
  $msg = [string]$_.Exception.Message
  if ($msg.StartsWith('__ZIPREJECT__')) {
    $parts = $msg.Substring(13).Split('|', 2)
    if (-not $failCode) { $failCode = $parts[0]; $failMsg = $parts[1] }
  } elseif (-not $failCode) {
    $failCode = 'ZIP_IO_ERROR'
    $failMsg = $msg
  }
} finally {
  if ($null -ne $archive) { try { $archive.Dispose() } catch { } }
}

if ($failCode) {
  Finish -Ok $false -Code $failCode -Message $failMsg
}
Finish -Ok $true -Code 'OK' -Message $null
