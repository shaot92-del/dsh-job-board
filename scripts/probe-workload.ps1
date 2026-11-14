#requires -Version 7.0
<#
  能力探测：用固定小样本测一个工作大类，输出 JSON（stdout + -Out 文件）。
  只读、只写 %TEMP%、不安装、不提权、不改系统设置。
  v2.5.0 首版只支持三类视频工作；结果 confidence=measured。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('video.transcode', 'video.interp', 'video.render')]
  [string]$Workload,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$benchVersion = 1

# 超时/被杀时 finally 来不及跑，会在 %TEMP% 留下 dsh-probe-*；启动时清掉 2 小时前的残留。
Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'dsh-probe-*' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-2) } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

function Find-FFmpeg {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($p in @(
      (Join-Path $env:LOCALAPPDATA 'ffmpeg\bin\ffmpeg.exe'),
      'C:\ffmpeg\bin\ffmpeg.exe'
    )) { if (Test-Path -LiteralPath $p) { return $p } }
  return ''
}

function Invoke-FFmpeg([string]$ff, [string[]]$argv) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $ff -ArgumentList $argv -NoNewWindow -Wait -PassThru `
    -RedirectStandardError (Join-Path $tmp 'ff.err.txt') -RedirectStandardOutput (Join-Path $tmp 'ff.out.txt')
  $sw.Stop()
  return [pscustomobject]@{ code = $p.ExitCode; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
}

function Has-Encoder([string]$ff, [string]$name) {
  try {
    $enc = & $ff -hide_banner -encoders 2>$null | Out-String
    return ($enc -match ('\s' + [regex]::Escape($name) + '\s'))
  } catch { return $false }
}

$result = [ordered]@{
  ok         = $false
  id         = $Workload
  unit       = 'fps'
  value      = 0
  samples    = 1
  confidence = 'measured'
  workload   = @{}
  measuredAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  benchVersion = $benchVersion
  seconds    = 0
  tool       = 'ffmpeg'
  error      = ''
}

$tmp = Join-Path $env:TEMP ('dsh-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $ff = Find-FFmpeg
  if (-not $ff) { throw 'ffmpeg 不在 PATH，也没有找到常见安装位置' }
  $result.tool = $ff

  switch ($Workload) {
    'video.transcode' {
      # 10s 1080p30 testsrc2 → H.264；优先 NVENC，失败回退 libx264。测编码 fps。
      $src = Join-Path $tmp 'src.mp4'
      & $ff -y -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=1920x1080:rate=30:duration=10' `
        -c:v libx264 -preset ultrafast -crf 28 $src 2>$null
      $frames = 300
      $enc = if (Has-Encoder $ff 'h264_nvenc') { 'h264_nvenc' } else { 'libx264' }
      $r = if ($enc -eq 'h264_nvenc') {
        Invoke-FFmpeg $ff @('-y', '-hide_banner', '-loglevel', 'error', '-i', $src, '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '6M', (Join-Path $tmp 'out.mp4'))
      } else {
        Invoke-FFmpeg $ff @('-y', '-hide_banner', '-loglevel', 'error', '-i', $src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', (Join-Path $tmp 'out.mp4'))
      }
      # 编译进来 ≠ 这台机器能用（无 NVIDIA 卡 / NVENC 会话占满）；失败就换 CPU 重测一次。
      if ($r.code -ne 0 -and $enc -eq 'h264_nvenc') {
        $enc = 'libx264'
        $r = Invoke-FFmpeg $ff @('-y', '-hide_banner', '-loglevel', 'error', '-i', $src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', (Join-Path $tmp 'out.mp4'))
      }
      if ($r.code -ne 0) { throw ('转码失败（' + $enc + '，exit ' + $r.code + '）') }
      $result.workload = @{ width = 1920; height = 1080; fpsIn = 30; codec = $enc; secondsIn = 10 }
      $result.seconds = $r.seconds
      $result.value = [math]::Round($frames / [math]::Max($r.seconds, 0.001), 2)
    }
    'video.interp' {
      # 2s 1080p30 → 48fps（minterpolate mci），测输出 fps。
      $src = Join-Path $tmp 'src.mp4'
      & $ff -y -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=1920x1080:rate=30:duration=2' `
        -c:v libx264 -preset ultrafast -crf 26 $src 2>$null
      $r = Invoke-FFmpeg $ff @('-y', '-hide_banner', '-loglevel', 'error', '-i', $src,
        '-vf', 'minterpolate=fps=48', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', (Join-Path $tmp 'out.mp4'))
      if ($r.code -ne 0) { throw ('补帧失败（exit ' + $r.code + '）') }
      $framesOut = 96
      $result.workload = @{ width = 1920; height = 1080; fpsIn = 30; fpsOut = 48; secondsIn = 2 }
      $result.seconds = $r.seconds
      $result.value = [math]::Round($framesOut / [math]::Max($r.seconds, 0.001), 2)
    }
    'video.render' {
      # 240 帧 1080p 滤镜合成（scale+drawbox+overlay），作为无头渲染的代理指标。
      $r = Invoke-FFmpeg $ff @('-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=8',
        '-f', 'lavfi', '-i', 'color=c=black@0.4:s=640x360:rate=30:duration=8',
        '-filter_complex', '[0:v]scale=1920:1080,drawbox=x=40:y=40:w=520:h=120:color=white@0.25:t=fill[bg];[bg][1:v]overlay=1200:600',
        '-frames:v', '240', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', (Join-Path $tmp 'out.mp4'))
      if ($r.code -ne 0) { throw ('渲染失败（exit ' + $r.code + '）') }
      $result.workload = @{ width = 1920; height = 1080; frames = 240; kind = 'ffmpeg-filter-composite' }
      $result.seconds = $r.seconds
      $result.value = [math]::Round(240 / [math]::Max($r.seconds, 0.001), 2)
    }
  }
  $result.ok = $true
} catch {
  $result.error = [string]$_.Exception.Message
} finally {
  try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllText($Out, $json, [Text.UTF8Encoding]::new($false))
}
Write-Output $json
if (-not $result.ok) { exit 1 }
