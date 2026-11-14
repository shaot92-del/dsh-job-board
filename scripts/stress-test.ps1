#requires -Version 7.0
<#
.SYNOPSIS
  可选的重活压测（混合负载），只在本机运行，结果只输出摘要。
.DESCRIPTION
  负载组成：NVENC 1080p 编码（主线程，逐轮计时）+ N 路 minterpolate 补帧（后台）。
  监控：GPU 温度、降频原因、每轮编码 fps、压测窗口内新增 WHEA/TDR/Kernel-Power。
  判定：崩/掉驱动/温度过高/吞吐漂移 >20%/变异系数 >15% → ok=false。
  隐私：不读取用户文件、不采集路径/用户名；临时文件只放 %TEMP%，结束即删。
.PARAMETER Mode
  quick=3 分钟，standard=10 分钟，deep=60 分钟。
.PARAMETER DurationSec
  覆盖档位时长（调试用）。
.PARAMETER InterpStreams
  补帧并发路数，默认 min(4, 核数-1)。
.PARAMETER Out
  可选：JSON 写到该文件。
#>
[CmdletBinding()]
param(
  [ValidateSet('quick', 'standard', 'deep')]
  [string]$Mode = 'standard',
  [int]$DurationSec = 0,
  [int]$InterpStreams = 0,
  [string]$Out
)

$ErrorActionPreference = 'Stop'

# 顶层兜底：异常文本可能带路径/用户名，绝不能原样透给调用方；任何未预期错误都回合法 JSON。
trap {
  $fallback = [ordered]@{
    ok = $false; schema = 'stress/1'; mode = $Mode; durationSec = 0; plannedSec = 0
    encRounds = 0; encAvgFps = 0; encFirstFps = 0; encLastFps = 0; driftPct = 0; cvPct = 0
    maxTempC = $null; throttle = ''; interpStreams = 0
    newEvents = [ordered]@{ whea = 0; tdr = 0; kernelPower = 0 }
    reasons = @('stress-failed'); error = 'stress-failed'; encoder = ''
    tool = 'stress-test.ps1'
  }
  Write-Output ($fallback | ConvertTo-Json -Depth 5 -Compress)
  exit 0
}
$ProgressPreference = 'SilentlyContinue'

function Find-FFmpeg {
  $cands = @()
  $cmd = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  $cands += (Join-Path $env:LOCALAPPDATA 'ffmpeg\bin\ffmpeg.exe')
  $cands += 'C:\ffmpeg\bin\ffmpeg.exe'
  $cands += 'C:\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe'
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return ''
}

function New-ProcInfo([string]$exe, [string[]]$argv, [string]$cwd) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $exe
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  if ($cwd) { $psi.WorkingDirectory = $cwd }
  foreach ($a in $argv) { $psi.ArgumentList.Add($a) }
  return $psi
}

function Invoke-FFmpeg([string]$ff, [string[]]$argv, [int]$timeoutSec = 0) {
  $psi = New-ProcInfo $ff $argv $null
  $p = [System.Diagnostics.Process]::Start($psi)
  $errTask = $p.StandardError.ReadToEndAsync()
  $outTask = $p.StandardOutput.ReadToEndAsync()
  if ($timeoutSec -gt 0 -and -not $p.WaitForExit($timeoutSec * 1000)) {
    try { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /F /T /PID $p.Id | Out-Null } catch {}
    return [pscustomobject]@{ code = -1; err = 'timeout'; dur = $timeoutSec }
  }
  $p.WaitForExit()
  return [pscustomobject]@{ code = $p.ExitCode; err = $errTask.Result; out = $outTask.Result; dur = 0 }
}

function Get-GpuSample {
  try {
    # 只看会真正影响性能的三条降频原因；通用的 .active 在本机常态是 Not Active，记不到热降频。
    $line = & nvidia-smi --query-gpu=temperature.gpu,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown --format=csv,noheader 2>$null | Select-Object -First 1
    if (-not $line) { return $null }
    $p = @(($line -split ',') | ForEach-Object { $_.Trim() })
    $active = @()
    $names = @('hw_slowdown', 'hw_thermal', 'sw_thermal')
    for ($i = 1; $i -le 3 -and $i -lt $p.Count; $i++) {
      # 新驱动给 "Active"/"Not Active"；旧驱动给十六进制位掩码。
      if ($p[$i] -eq 'Active' -or $p[$i] -match '^0x0*[1-9a-fA-F]') { $active += $names[$i - 1] }
    }
    return [pscustomobject]@{ tempC = [int]$p[0]; throttle = ($active -join '|') }
  } catch { return $null }
}

function Count-Events([string[]]$providers, [int[]]$ids, [datetime]$since) {
  try {
    $e = Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since; ProviderName = $providers; Id = $ids } -ErrorAction SilentlyContinue
    if ($null -eq $e) { return 0 }
    return @($e).Count
  } catch { return 0 }
}

$ff = Find-FFmpeg
if (-not $ff) { Write-Output '{"ok":false,"error":"ffmpeg-not-found"}'; exit 2 }

$durations = @{ quick = 180; standard = 600; deep = 3600 }
$dur = if ($DurationSec -gt 0) { $DurationSec } else { $durations[$Mode] }
$cores = [Environment]::ProcessorCount
$streams = if ($InterpStreams -gt 0) { $InterpStreams } else { [Math]::Max(2, [Math]::Min(4, $cores - 1)) }

# 被杀/硬超时将跳过 finally；顺手清 24 小时前的同类残留（含约 4MB src.mp4）。
try {
  Get-ChildItem $env:TEMP -Directory -Filter 'dsh-stress-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-24) } |
    ForEach-Object { try { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue } catch {} }
} catch {}
$tmp = Join-Path $env:TEMP ('dsh-stress-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$src = Join-Path $tmp 'src.mp4'
$started = Get-Date
$children = @()
$rounds = @()
$maxTemp = $null
$throttle = ''
$errorText = ''

# 编码器能力探测：无 NVENC（AMD/Intel/旧驱动/无 GPU）不应当把“环境不支持”记成“机器不稳”。
$enc = 'h264_nvenc'
$encPreset = 'p5'
try {
  $encList = (& $ff -hide_banner -encoders 2>$null | Out-String)
  if ($encList -notmatch '(?m)^\s*V\S*\s+h264_nvenc\b') { $enc = 'libx264'; $encPreset = 'veryfast' }
} catch { $enc = 'libx264'; $encPreset = 'veryfast' }
try {
  $gen = Invoke-FFmpeg $ff @(
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-t', '10', '-c:v', $enc, '-preset', $encPreset, '-b:v', '8M',
    '-pix_fmt', 'yuv420p', $src
  ) 300
  if ($gen.code -ne 0 -or -not (Test-Path $src)) {
    # 首次 nvenc 失败：先把负载轮也切到 libx264，再重生成素材。
    # 不能等 $gen 被第二次调用覆盖后再判断——那样只看得到降级那次的返回码。
    $enc = 'libx264'
    $encPreset = 'veryfast'
    $encoderFallback = $true
    $gen = Invoke-FFmpeg $ff @(
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-t', '10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', $src
    ) 300
    if ($gen.code -ne 0 -or -not (Test-Path $src)) { throw 'source-generate-failed' }
  }

  # 后台补帧负载（N 路）
  for ($i = 0; $i -lt $streams; $i++) {
    $psi = New-ProcInfo $ff @(
      '-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-i', $src,
      '-t', "$dur", '-vf', 'minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc:me_mode=bidir',
      '-an', '-f', 'null', '-'
    ) $tmp
    $p = [System.Diagnostics.Process]::Start($psi)
    $children += $p
    [void]$p.BeginErrorReadLine()
  }

  $roundSec = [Math]::Min(30, [Math]::Max(10, [int]($dur / 6)))
  $deadline = (Get-Date).AddSeconds($dur)
  $idx = 0
  while ((Get-Date) -lt $deadline) {
    $idx++
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-FFmpeg $ff @(
      '-hide_banner', '-nostats', '-stream_loop', '-1', '-i', $src,
      '-t', "$roundSec", '-an', '-c:v', $enc, '-preset', $encPreset, '-b:v', '8M',
      '-f', 'null', '-'
    ) ($roundSec + 60)
    $sw.Stop()
    $fps = $null
    if ($r.err -match 'frame=\s*(\d+).*?fps=\s*([\d.]+)') { $fps = [double]$Matches[2] }
    $rounds += [pscustomobject]@{ i = $idx; sec = [Math]::Round($sw.Elapsed.TotalSeconds, 2); fps = $fps; code = $r.code }
    $g = Get-GpuSample
    if ($g) {
      if ($g.tempC -ne $null -and ($maxTemp -eq $null -or $g.tempC -gt $maxTemp)) { $maxTemp = $g.tempC }
      if ($g.throttle) { $throttle = $g.throttle }
    }
    if ($r.code -eq -1) { $errorText = 'encode-timeout'; break }
    if ($r.code -ne 0) { $errorText = 'encode-failed'; break }
  }
} catch {
  # 隐私：异常文本可能带临时目录/用户名，不能写进能力卡，也不回显给面板。
  $errorText = 'stress-failed'
} finally {
  foreach ($c in $children) {
    try { if (-not $c.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /F /T /PID $c.Id | Out-Null } } catch {}
  }
  try { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } catch {}
}

$finished = Get-Date
$fpsList = @($rounds | Where-Object { $_.fps } | ForEach-Object { [double]$_.fps })
$avg = if ($fpsList.Count) { ($fpsList | Measure-Object -Average).Average } else { 0 }
$firstAvg = 0; $lastAvg = 0; $drift = 0; $cv = 0
if ($fpsList.Count -ge 3) {
  $third = [Math]::Max(1, [int]($fpsList.Count / 3))
  $firstAvg = ($fpsList[0..($third - 1)] | Measure-Object -Average).Average
  $lastAvg = ($fpsList[($fpsList.Count - $third)..($fpsList.Count - 1)] | Measure-Object -Average).Average
  if ($firstAvg -gt 0) { $drift = [Math]::Round((($firstAvg - $lastAvg) / $firstAvg) * 100, 1) }
  $sd = [Math]::Sqrt((($fpsList | ForEach-Object { [Math]::Pow($_ - $avg, 2) } | Measure-Object -Sum).Sum) / $fpsList.Count)
  if ($avg -gt 0) { $cv = [Math]::Round(($sd / $avg) * 100, 1) }
}

$newWhea = Count-Events @('Microsoft-Windows-WHEA-Logger') @(17, 18, 19, 47) $started
$newTdr = Count-Events @('Display') @(4101) $started
$newPower = Count-Events @('Microsoft-Windows-Kernel-Power') @(41) $started

$ok = $true
$reasons = @()
if ($errorText) { $ok = $false; $reasons += $errorText }
if ($maxTemp -ne $null -and $maxTemp -ge 95) { $ok = $false; $reasons += 'temp>=95C' }
if ($drift -gt 20) { $ok = $false; $reasons += 'drift>20%' }
if ($cv -gt 15) { $ok = $false; $reasons += 'cv>15%' }
if ($newWhea -gt 0 -or $newTdr -gt 0 -or $newPower -gt 0) { $ok = $false; $reasons += 'new-critical-event' }
if ($fpsList.Count -eq 0) { $ok = $false; $reasons += 'no-samples' }
if ($throttle) { $ok = $false; $reasons += ('throttle:' + $throttle) }

$result = [ordered]@{
  ok              = $ok
  schema          = 'stress/1'
  mode            = $Mode
  durationSec     = [Math]::Round(($finished - $started).TotalSeconds, 1)
  plannedSec      = $dur
  encRounds       = $rounds.Count
  encAvgFps       = [Math]::Round($avg, 2)
  encFirstFps     = [Math]::Round($firstAvg, 2)
  encLastFps      = [Math]::Round($lastAvg, 2)
  driftPct        = $drift
  cvPct           = $cv
  maxTempC        = $maxTemp
  throttle        = $throttle
  interpStreams   = $streams
  newEvents       = [ordered]@{ whea = $newWhea; tdr = $newTdr; kernelPower = $newPower }
  reasons         = $reasons
  error           = $errorText
  startedAt       = $started.ToUniversalTime().ToString('o')
  finishedAt      = $finished.ToUniversalTime().ToString('o')
  encoder         = $enc
  encoderFallback = ($encoderFallback -eq $true)
  tool            = 'stress-test.ps1'
}

$json = $result | ConvertTo-Json -Depth 5 -Compress
if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Out, $json, [Text.UTF8Encoding]::new($false))
}
Write-Output $json
