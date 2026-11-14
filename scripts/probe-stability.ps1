#requires -Version 7.0
<#
.SYNOPSIS
  只读采集本机稳定性摘要（聚合计数，不读取事件正文）。
.DESCRIPTION
  给“机械调度台/多机调度台”能力卡用：
  - 30 天 / 7 天窗口内的异常事件计数（蓝屏、意外关机、WHEA、TDR、磁盘、应用崩溃、热限制）
  - uptime、上次启动、挂起重启、显卡驱动日期、GPU 温度
  隐私：只输出计数与时间，不输出事件消息、进程名、路径、用户名、SID。
  不安装、不改配置、不写系统位置；只读 + 可选写出 JSON 到指定路径。
.PARAMETER Days
  历史窗口天数，默认 30。
.PARAMETER Out
  可选：把 JSON 写到该文件（UTF-8 无 BOM）。
#>
[CmdletBinding()]
param(
  [int]$Days = 30,
  [string]$Out
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:readFailed = $false

# 顶层兜底：任何未预期错误也必须输出合法 JSON，否则消费端拿到空 stdout 只会在卡上静默缺 stability。
trap {
  $fallback = [ordered]@{
    ok = $false; schema = 'stability/1'; windowDays = [Math]::Abs($Days); events = @{}
    level = 'unknown'; confidence = 'inferred'; readFailed = $true
    uptimeHours = $null; lastBoot = ''; pendingReboot = $false; gpu = @{}
    detectedAt = (Get-Date).ToUniversalTime().ToString('o'); tool = 'probe-stability.ps1'; error = 'probe-failed'
  }
  Write-Output ($fallback | ConvertTo-Json -Depth 5 -Compress)
  exit 0
}

function Get-EventCount {
  param(
    [string]$LogName,
    [string[]]$Provider,
    [int[]]$Id,
    [datetime]$Start
  )
  try {
    $filter = @{ LogName = $LogName; StartTime = $Start; Id = $Id }
    if ($Provider -and $Provider.Count -gt 0) { $filter['ProviderName'] = $Provider }
    $events = Get-WinEvent -FilterHashtable $filter -ErrorAction SilentlyContinue
    if ($null -eq $events) { return 0 }
    return @($events).Count
  } catch {
    $script:readFailed = $true
    return 0
  }
}


function Get-GpuInfo {
  $out = @{ name = ''; driver = ''; tempC = $null }
  try {
    $line = & nvidia-smi --query-gpu=name,driver_version,temperature.gpu --format=csv,noheader 2>$null | Select-Object -First 1
    if ($line) {
      $parts = ($line -split ',') | ForEach-Object { $_.Trim() }
      if ($parts.Count -ge 3) {
        $out.name = $parts[0]
        $out.driver = $parts[1]
        if ($parts[2] -match '^\d+$') { $out.tempC = [int]$parts[2] }
      }
    }
  } catch {}
  return $out
}

$now = Get-Date
$start30 = $now.AddDays(-[Math]::Abs($Days))
$start7 = $now.AddDays(-7)

$ev = [ordered]@{
  kernelPower       = Get-EventCount 'System' @('Microsoft-Windows-Kernel-Power') @(41) $start30
  kernelPower7      = Get-EventCount 'System' @('Microsoft-Windows-Kernel-Power') @(41) $start7
  bugcheck          = Get-EventCount 'System' @('Microsoft-Windows-WER-SystemErrorReporting') @(1001) $start30
  bugcheck7         = Get-EventCount 'System' @('Microsoft-Windows-WER-SystemErrorReporting') @(1001) $start7
  unexpectedShutdown = Get-EventCount 'System' @('EventLog') @(6008) $start30
  whea              = Get-EventCount 'System' @('Microsoft-Windows-WHEA-Logger') @(17, 18, 19, 47) $start30
  whea7             = Get-EventCount 'System' @('Microsoft-Windows-WHEA-Logger') @(17, 18, 19, 47) $start7
  tdr               = Get-EventCount 'System' @('Display') @(4101) $start30
  tdr7              = Get-EventCount 'System' @('Display') @(4101) $start7
  nvlddmkm          = Get-EventCount 'System' @('nvlddmkm') @(13, 14, 153) $start30
  disk              = Get-EventCount 'System' @('disk') @(7, 11, 51) $start30
  ntfs              = Get-EventCount 'System' @('Ntfs') @(55) $start30
  appCrash          = Get-EventCount 'Application' @('Application Error') @(1000) $start30
  serviceCrash      = Get-EventCount 'System' @('Service Control Manager') @(7031, 7034) $start30
  thermal           = Get-EventCount 'System' @('Microsoft-Windows-Kernel-Processor-Power') @(37) $start30
}

$level = 'good'
if ($script:readFailed) {
  $level = 'unknown'
} elseif ($ev.tdr7 -gt 0 -or $ev.whea7 -gt 0 -or $ev.bugcheck7 -gt 0 -or $ev.kernelPower -ge 2 -or $ev.disk -gt 0 -or $ev.ntfs -gt 0) {
  $level = 'risky'
} elseif ($ev.kernelPower -eq 1 -or $ev.unexpectedShutdown -gt 0 -or $ev.appCrash -gt 5 -or $ev.serviceCrash -gt 5) {
  $level = 'watch'
}

$uptimeHours = $null
$lastBoot = ''
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os -and $os.LastBootUpTime) {
    $lastBoot = ([datetime]$os.LastBootUpTime).ToString('s')
    $uptimeHours = [Math]::Round((($now) - [datetime]$os.LastBootUpTime).TotalHours, 1)
  }
} catch {}

$pendingReboot = $false
foreach ($k in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
  )) {
  if (Test-Path $k) { $pendingReboot = $true; break }
}

$gpu = Get-GpuInfo
$result = [ordered]@{
  ok             = $true
  schema         = 'stability/1'
  windowDays     = [Math]::Abs($Days)
  events         = $ev
  level          = $level
  confidence     = $(if ($script:readFailed) { 'inferred' } else { 'measured' })
  readFailed     = $script:readFailed
  uptimeHours    = $uptimeHours
  lastBoot       = $lastBoot
  pendingReboot  = $pendingReboot
  gpu            = $gpu
  detectedAt     = $now.ToUniversalTime().ToString('o')
  tool           = 'probe-stability.ps1'
}

$json = $result | ConvertTo-Json -Depth 5 -Compress
if ($Out) {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Out, $json, [Text.UTF8Encoding]::new($false))
}
Write-Output $json
