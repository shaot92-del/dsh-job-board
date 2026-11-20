param([string]$Version = "2.7.0")
# GT14 开机后的一键恢复（2026-11-21 凌晨）：回滚配置备份 -> 装指定版本（默认 2.7.0，已知可跑）-> 重启 DSH
# 用法：双击 fix-gt14-after-boot.cmd；或 pwsh -File fix-gt14-after-boot.ps1 -Version 2.7.2
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$profiles = Join-Path $env:USERPROFILE ".dsh\profiles"
if (-not (Test-Path -LiteralPath $profiles)) { Write-Host "找不到 profile 目录：$profiles" -ForegroundColor Red; exit 1 }

$patches = Get-ChildItem -Path $profiles -Recurse -Filter "cordis.patch.yml" -File -ErrorAction SilentlyContinue
if (-not $patches) { Write-Host "找不到 cordis.patch.yml" -ForegroundColor Red; exit 1 }

foreach ($p in $patches) {
  Write-Host ("profile: " + $p.FullName)
  $dir = Split-Path -Parent $p.FullName
  $baks = Get-ChildItem -Path $dir -Filter "cordis.patch.yml.bak-maint-*" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
  if ($baks) {
    $oldest = $baks[0]
    Copy-Item -LiteralPath $oldest.FullName -Destination $p.FullName -Force
    Write-Host ("  已用最早的维护备份回滚：" + $oldest.Name) -ForegroundColor Yellow
  } else {
    Write-Host "  没有 .bak-maint-* 备份（配置没被改过，跳过）"
  }
}

$tgz = Join-Path $here ("wfcj-dsh-job-board-" + $Version + ".tgz")
if (-not (Test-Path -LiteralPath $tgz)) { Write-Host ("找不到包：" + $tgz) -ForegroundColor Red; exit 1 }
Write-Host ""
Write-Host ("下一步：安装 " + $Version + " 并重启 DSH") -ForegroundColor Cyan
& (Join-Path $here "upgrade-worker.ps1") -Yes -Tarball $tgz

Write-Host ""
Write-Host "完成。回到主机面板确认 GT14 在线、插件版本对应。" -ForegroundColor Green