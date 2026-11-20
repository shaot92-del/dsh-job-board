param([switch]$DryRun)
# GT14 一键回滚（2026-11-21 01:20）：插件目录回到最近一次 .bak-*，配置回到最早的 .bak-maint-*
# 用法：双击 rollback-gt14.cmd（会先打印计划，确认后再改）
$ErrorActionPreference = "Stop"

$profilesRoot = Join-Path $env:USERPROFILE ".dsh\profiles"
$pkgs = Get-ChildItem -Path $profilesRoot -Recurse -Directory -Filter "dsh-job-board" -ErrorAction SilentlyContinue | Where-Object { $_.Parent.Name -eq "@wfcj" }
if (-not $pkgs) { Write-Host "没找到已安装的 @wfcj/dsh-job-board" -ForegroundColor Red; exit 1 }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($pkg in $pkgs) {
  $parent = $pkg.Parent.FullName
  $cur = $pkg.FullName
  $ver = "?"
  $pj = Join-Path $cur "package.json"
  if (Test-Path -LiteralPath $pj) { try { $ver = (Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).version } catch { } }
  Write-Host ("== " + $cur + "  (当前 " + $ver + ")")
  $baks = Get-ChildItem -Path $parent -Directory -Filter "dsh-job-board.bak-*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  if (-not $baks) { Write-Host "   没有 .bak-* 备份，跳过（用 tgz 重装更稳）" -ForegroundColor Yellow; continue }
  $bak = $baks[0]
  $bv = "?"
  $bpj = Join-Path $bak.FullName "package.json"
  if (Test-Path -LiteralPath $bpj) { try { $bv = (Get-Content -LiteralPath $bpj -Raw | ConvertFrom-Json).version } catch { } }
  Write-Host ("   回滚到 " + $bak.Name + " (" + $bv + ")")
  if ($DryRun) { Write-Host "   [dry] 只打印，不改" ; continue }
  Rename-Item -LiteralPath $cur -NewName ("dsh-job-board.broken-" + $stamp)
  Rename-Item -LiteralPath $bak.FullName -NewName "dsh-job-board"
  Write-Host ("   完成：现在版本 " + $bv + "；坏的那份在 dsh-job-board.broken-" + $stamp) -ForegroundColor Green
}

# 配置：优先用最早的 .bak-maint-*（我改配置前的状态），否则用最近的 .bak-machine-*
$patches = Get-ChildItem -Path $profilesRoot -Recurse -Filter "cordis.patch.yml" -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike "*node_modules*" }
foreach ($pf in $patches) {
  $dir = Split-Path -Parent $pf.FullName
  # 取最早的一份备份（最接近「上次还能跑」的状态）：bak-maint / bak-agent / bak-machine 都算
  $cands = @()
  foreach ($pat in @("cordis.patch.yml.bak-maint-*","cordis.patch.yml.bak-agent-*","cordis.patch.yml.bak-machine-*")) {
    $cands += Get-ChildItem -Path $dir -Filter $pat -File -ErrorAction SilentlyContinue
  }
  $cands = @($cands | Sort-Object LastWriteTime)
  if (-not $cands.Count) { continue }
  $pick = $cands[0]
  Write-Host ("配置回滚：" + $pf.FullName + " <- " + $pick.Name)
  if (-not $DryRun) {
    Copy-Item -LiteralPath $pf.FullName -Destination ($pf.FullName + ".before-rollback-" + $stamp) -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $pick.FullName -Destination $pf.FullName -Force
  }
}

Write-Host ""
Write-Host "回滚完成。现在双击桌面 DSH 图标启动；如果还起不来，把弹出窗口的报错文字发我。" -ForegroundColor Cyan