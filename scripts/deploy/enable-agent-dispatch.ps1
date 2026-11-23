# enable-agent-dispatch.ps1 — 让副机能接 agent 任务（workerMode=on + agentAllowlist 放行）
# 用法（在要开的机器上跑，本机或副机都行）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\enable-agent-dispatch.ps1            # 预览
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\enable-agent-dispatch.ps1 -Force     # 写盘
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\enable-agent-dispatch.ps1 -Force -MatchAll:$false -AllowGoalPrefix 'smoke'
# 说明：只改本机 profile 的 cordis.patch.yml，写前备份，输出恒 LF/UTF-8 无 BOM。

param(
  [switch]$Force,
  [switch]$DryRun,
  [string[]]$ProfileDir,
  [switch]$MatchAll = $true,
  [string]$AllowGoalPrefix = '',
  [string]$AllowModelPrefix = ''
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Say($m) { Write-Host $m }
function Die($m) { Write-Host ("错误：" + $m) -ForegroundColor Red; exit 1 }

# ---- 1. 找 profile ----
if (-not $ProfileDir -or $ProfileDir.Count -eq 0) {
  $root = Join-Path $env:USERPROFILE '.dsh\profiles'
  if (-not (Test-Path -LiteralPath $root)) { Die "找不到 profiles 目录：$root" }
  $ProfileDir = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {
      $p = Join-Path $_.FullName 'cordis.patch.yml'
      (Test-Path -LiteralPath $p) -and ((Get-Content -LiteralPath $p -Raw) -match 'dsh-job-board')
    } | ForEach-Object { $_.FullName })
}
if ($ProfileDir.Count -eq 0) { Die '没有找到含 dsh-job-board 的 profile' }
Say ("检测到 " + $ProfileDir.Count + " 个 profile：`n  " + ($ProfileDir -join "`n  "))

# ---- 2. 构造要写的内容 ----
$allowLines = @()
if ($MatchAll) {
  $allowLines += '  - id: any'
  $allowLines += '    matchAll: true'
} else {
  $allowLines += '  - id: dispatch'
  if ($AllowGoalPrefix)  { $allowLines += ('    goalPrefix: ' + $AllowGoalPrefix) }
  if ($AllowModelPrefix) { $allowLines += ('    modelPrefix: ' + $AllowModelPrefix) }
  if (-not $AllowGoalPrefix -and -not $AllowModelPrefix) { $allowLines += '    matchAll: true' }
}

$anyWritten = $false
foreach ($dir in $ProfileDir) {
  $patch = Join-Path $dir 'cordis.patch.yml'
  $text = [IO.File]::ReadAllText($patch)
  $lines = @($text -split "`n")
  $orig = $text

  # ---- 3. 找 - id: team 的 config: 块 ----
  $teamIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*-\s*id:\s*team\s*$') { $teamIdx = $i; break } }
  if ($teamIdx -lt 0) { Say ("跳过 $dir：没有 - id: team"); continue }
  $teamIndent = ([regex]::Match($lines[$teamIdx], '^\s*')).Length
  $cfgIdx = -1
  for ($i = $teamIdx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '') { continue }
    $ind = ([regex]::Match($lines[$i], '^\s*')).Length
    if ($ind -le $teamIndent) { break }
    if ($lines[$i] -match '^\s*config:\s*$') { $cfgIdx = $i; break }
  }
  if ($cfgIdx -lt 0) { Say ("跳过 $dir：team 没有 config: 块"); continue }
  $cfgIndent = ([regex]::Match($lines[$cfgIdx], '^\s*')).Length
  # config 块结束行
  $cfgEnd = $lines.Count
  for ($i = $cfgIdx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '') { continue }
    if (([regex]::Match($lines[$i], '^\s*')).Length -le $cfgIndent) { $cfgEnd = $i; break }
  }

  # ---- 4. worker: 子块范围 ----
  $wIdx = -1
  for ($i = $cfgIdx + 1; $i -lt $cfgEnd; $i++) { if ($lines[$i] -match '^\s*worker:\s*(\{\s*\})?\s*$') { $wIdx = $i; break } }
  if ($wIdx -lt 0) {
    # 没有 worker 子块：就在 config 末尾建一个
    $wIndent = (' ' * ($cfgIndent + 2))
    $newWorker = @($wIndent + 'worker:', $wIndent + "  workerMode: 'on'", $wIndent + '  agentApproval: auto', $wIndent + '  agentAllowlist:') + ($allowLines | ForEach-Object { $wIndent + $_ })
    $lines = @($lines[0..($cfgEnd - 1)]) + $newWorker + @($lines[$cfgEnd..($lines.Count - 1)])
    Say ("$dir ：新增 worker 子块")
  } else {
    $wIndentLen = ([regex]::Match($lines[$wIdx], '^\s*')).Length
    # 展开内联空 map
    if ($lines[$wIdx] -match '\{\s*\}\s*$') { $lines[$wIdx] = $lines[$wIdx] -replace '\{\s*\}\s*$', '' }
    $wEnd = $cfgEnd
    for ($i = $wIdx + 1; $i -lt $cfgEnd; $i++) {
      if ($lines[$i].Trim() -eq '') { continue }
      if (([regex]::Match($lines[$i], '^\s*')).Length -le $wIndentLen) { $wEnd = $i; break }
    }
    # 先处理 agentAllowlist：删掉旧的（键行 + 更深缩进的列表项）
    for ($i = $wIdx + 1; $i -lt $wEnd; $i++) {
      if ($lines[$i] -match '^\s*agentAllowlist:\s*.*$') {
        $kIndent = ([regex]::Match($lines[$i], '^\s*')).Length
        $j = $i + 1
        while ($j -lt $wEnd -and ($lines[$j].Trim() -eq '' -or ([regex]::Match($lines[$j], '^\s*')).Length -gt $kIndent)) { $j++ }
        $lines = @($lines[0..($i - 1)]) + @($lines[$j..($lines.Count - 1)])
        $wEnd = $wEnd - ($j - $i)
        $cfgEnd = $cfgEnd - ($j - $i)
        break
      }
    }
    # 在 worker 子块末尾插 agentAllowlist（保持缩进 = worker 子键缩进）
    $childIndent = ' ' * ($wIndentLen + 2)
    # config 块里缺 workerMode / agentApproval 时，一并补进 worker 子块
    $hasMode = $false; $hasAppr = $false
    for ($i = $cfgIdx + 1; $i -lt $cfgEnd; $i++) {
      if ($lines[$i] -match '^\s*workerMode:\s*') { $hasMode = $true }
      if ($lines[$i] -match '^\s*agentApproval:\s*') { $hasAppr = $true }
    }
    $ins = @()
    if (-not $hasMode) { $ins += ($childIndent + "workerMode: 'on'") }
    if (-not $hasAppr) { $ins += ($childIndent + 'agentApproval: auto') }
    $ins += @($childIndent + 'agentAllowlist:') + ($allowLines | ForEach-Object { $childIndent + $_ })
    $lines = @($lines[0..($wEnd - 1)]) + $ins + @($lines[$wEnd..($lines.Count - 1)])
    # workerMode / agentApproval：config 块里（无论平铺还是 worker 子块内）都归一到 on/auto
    $cfgEnd2 = $cfgEnd
    for ($i = $cfgIdx + 1; $i -lt [Math]::Min($cfgEnd2 + 40, $lines.Count); $i++) {
      if ($lines[$i].Trim() -eq '') { continue }
      $ind2 = ([regex]::Match($lines[$i], '^\s*')).Length
      if ($ind2 -le $cfgIndent) { break }
      if ($lines[$i] -match '^\s*workerMode:\s*') { $lines[$i] = (' ' * $ind2) + "workerMode: 'on'" }
      elseif ($lines[$i] -match '^\s*agentApproval:\s*') { $lines[$i] = (' ' * $ind2) + 'agentApproval: auto' }
    }
    Say ("$dir ：worker 子块已处理")
  }

  $new = ($lines -join "`n")
  if ($new -eq $orig) { Say ("$dir ：无需改动"); continue }

  Say ("--- 变更预览（前后各 15 行）---")
  $dl = Compare-Object ($orig -split "`n") ($new -split "`n") -SyncWindow 200 |
        Select-Object -First 30 | ForEach-Object { "  $($_.SideIndicator) $($_.InputObject)" }
  if ($dl) { Say ($dl -join "`n") }

  if ($DryRun -or -not $Force) {
    Say ("$dir ：预览模式，未写盘（加 -Force 写盘）")
    continue
  }
  $bak = "$patch.bak-agent-$(Get-Date -f yyyyMMdd-HHmmss)"
  Copy-Item -LiteralPath $patch -Destination $bak -Force
  [IO.File]::WriteAllText($patch, $new, $utf8)
  # 写后复核
  $chk = [IO.File]::ReadAllText($patch)
  $okMode = $chk -match "(?m)^\s*workerMode:\s*'?on'?\s*$"
  $okAllow = $chk -match '(?m)^\s*agentAllowlist:\s*$' -and $chk -match '(?m)^\s*matchAll:\s*true\s*$'
  if (-not ($okMode -and $okAllow)) {
    Copy-Item -LiteralPath $bak -Destination $patch -Force
    Say ("$dir ：复核失败，已回滚（备份 $bak）") -ForegroundColor Red
    continue
  }
  $anyWritten = $true
  Say ("$dir ：已写盘（备份 $bak）") -ForegroundColor Green
}

if ($anyWritten) {
  Say ''
  Say '下一步：重启这台机器上的 DSH（桌面版关掉重开），然后 worker 心跳里 workerMode 应显示 on、agentAllowlist 至少 1 条。'
  Say '验证（在主机面板）：派工到这台机器、选一个模型，应能直接跑起来，不再报 agent-not-allowlisted。'
}
