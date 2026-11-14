#requires -Version 7.0
<#
.SYNOPSIS
  给 dsh-remote-agent 的 PowerShell 解析器补上“用户级 pwsh 7”路径。
.DESCRIPTION
  remote-agent 的 exec.js 只查 Program Files / WindowsApps / PATH，
  而用户级安装（winget / Store 以外的官方 MSI 默认）在
  %LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe，于是会静默退回 5.1。
  本脚本做一件事：在候选列表里补这一行，幂等、可 -DryRun。
  改完需重启该机的 DSH 才生效。
.PARAMETER ProfileName
  DSH profile 名，默认 desktop。
.PARAMETER DryRun
  只检查并打印将要做的改动。
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$ProfileName = 'desktop',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $ProfileName + '\node_modules\dsh-remote-agent')
$file = Join-Path $root 'lib\node\exec.js'
if (-not (Test-Path $file)) {
  Write-Output "MISSING $file"
  exit 2
}

$text = [IO.File]::ReadAllText($file)
$marker = "localAppData ? path.join(localAppData, 'Programs', 'PowerShell', '7', 'pwsh.exe') : '',"
if ($text.Contains($marker)) {
  Write-Output "ALREADY $file"
  exit 0
}

$anchor = "    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : ''"
if (-not $text.Contains($anchor)) {
  Write-Output "ANCHOR-NOT-FOUND $file"
  exit 3
}

$eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$new = $text.Replace($anchor, "    " + $marker + $eol + $anchor)
if ($new -eq $text) {
  Write-Output "NO-CHANGE $file"
  exit 3
}

$linesBefore = ([regex]::Matches($text, "`n")).Count
$linesAfter = ([regex]::Matches($new, "`n")).Count

if ($DryRun) {
  Write-Output "DRYRUN would insert: $marker"
  Write-Output "lines $linesBefore -> $linesAfter"
  exit 0
}

$bak = $file + '.bak-psresolve-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
Copy-Item $file $bak -Force
try {
  [IO.File]::WriteAllText($file, $new, [Text.UTF8Encoding]::new($false))
  $check = [IO.File]::ReadAllText($file)
  if (-not $check.Contains($marker)) { throw 'verify-marker-missing' }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $null = & $node.Source --check $file 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'node-check-failed' }
  }
} catch {
  try { Copy-Item $bak $file -Force } catch {}
  Write-Output ("FAILED restored: " + $_)
  exit 4
}
Write-Output "PATCHED $file (backup $([IO.Path]::GetFileName($bak)), lines $linesBefore -> $linesAfter)"
