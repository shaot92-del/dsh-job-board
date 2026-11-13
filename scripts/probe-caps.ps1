#requires -Version 7.0
<#
  多机调度台 · 能力自检（只读）
  输出 JSON 到 stdout；不安装、不提权、不写系统。
  用法：pwsh -NoProfile -File probe-caps.ps1 [-Pretty]
#>
[CmdletBinding()]
param(
  [int[]]$ModelPorts = @(8080, 8088, 11434, 1234),
  # 可选：显式列出局域网里的推理端点主机（如 <lan-host>），命中私网地址的模型会标 location='lan'。
  [string[]]$ModelHosts = @(),
  [switch]$Pretty
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Get-Cmd([string]$Name) {
  $c = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return ''
}

# 路径里带用户名时不外传（板子可能被同网段访问）。
function Mask-Path([string]$PathValue) {
  if (-not $PathValue) { return '' }
  $p = [string]$PathValue
  if ($env:USERPROFILE) { $p = $p.Replace($env:USERPROFILE, '<home>') }
  return $p
}

# ── 身份 ─────────────────────────────────────────────
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1

$gpus = @()
foreach ($g in @(Get-CimInstance Win32_VideoController)) {
  $vram = $null
  if ($g.AdapterRAM) {
    # Win32_VideoController.AdapterRAM 是 uint32，>4GB 会溢出；先给近似值，下面再用 nvidia-smi 校正。
    $vram = [math]::Round([double]$g.AdapterRAM / 1GB, 1)
  }
  $gpus += [ordered]@{ name = $g.Name; driver = $g.DriverVersion; adapterRAMGB = $vram }
}
$nvidiaSmi = Get-Cmd 'nvidia-smi'
if ($nvidiaSmi) {
  try {
    $mem = (& $nvidiaSmi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    if ($mem -match '^\d+') {
      $vramGB = [math]::Round([double]$matches[0] / 1024, 1)
      for ($i = 0; $i -lt $gpus.Count; $i++) {
        if ($gpus[$i].name -match 'NVIDIA') { $gpus[$i].adapterRAMGB = $vramGB; break }
      }
    }
  } catch {}
}

# ── 工具 ─────────────────────────────────────────────
$ffmpeg = Get-Cmd 'ffmpeg'
$ffmpegInfo = $null
$hwEncoders = @()
if ($ffmpeg) {
  $ff = & $ffmpeg -hide_banner -encoders 2>&1 | Out-String
  $all = [regex]::Matches($ff, '(?m)^\s*[A-Z.]{6}\s+(\S+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  $hwEncoders = @($all | Where-Object { $_ -match 'nvenc|qsv|amf|vaapi|videotoolbox|libx264|libx265' })
  $vv = (& $ffmpeg -hide_banner -version 2>&1 | Select-Object -First 1)
  $ffmpegInfo = [ordered]@{
    path     = Mask-Path $ffmpeg
    version  = [string]$vv
    encoders = $hwEncoders
  }
}

$browsers = @()
foreach ($b in @(
    @{ kind = 'edge'; path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" },
    @{ kind = 'chrome'; path = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe" },
    @{ kind = 'chrome'; path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
  )) {
  if (Test-Path $b.path) {
    $v = (Get-Item $b.path).VersionInfo.FileVersion
    $browsers += [ordered]@{ kind = $b.kind; path = (Mask-Path $b.path); version = [string]$v; headless = $true }
  }
}

$python = Get-Cmd 'python'
$pythonOk = [bool]($python -and $python -notmatch 'WindowsApps')
$pythonVersion = ''
if ($pythonOk) { $pythonVersion = [string](& $python --version 2>&1 | Select-Object -First 1) }
$node = Get-Cmd 'node'
$nodeVersion = ''
if ($node) { $nodeVersion = [string](& $node --version 2>$null | Select-Object -First 1) }

# ── 本地模型端点（只读，最多 80 条） ──────────────────
$models = @()
function Get-ModelLocation([string]$HostName) {
  $h = $HostName.Trim().ToLowerInvariant().Trim('[', ']')
  if ($h -eq 'localhost') { return 'local' }
  $ip = $null
  if ([System.Net.IPAddress]::TryParse($h, [ref]$ip)) {
    if ([System.Net.IPAddress]::IsLoopback($ip)) { return 'local' }
    if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
      $b = $ip.GetAddressBytes()
      if ($b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and $b[1] -eq 168)) { return 'lan' }
    } else {
      if ($ip.IsIPv6LinkLocal -or $ip.IsIPv6SiteLocal -or ($ip.GetAddressBytes()[0] -band 0xFE) -eq 0xFC) { return 'lan' }
    }
    return 'cloud'
  }
  return 'cloud'
}
$modelTargets = @('127.0.0.1') + @($ModelHosts | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
$modelTargets = @($modelTargets | Select-Object -Unique)
$seenModels = @{}
foreach ($mh in $modelTargets) {
  foreach ($port in $ModelPorts) {
    try {
      $r = Invoke-RestMethod -Uri ("http://{0}:{1}/v1/models" -f $mh, $port) -TimeoutSec 1 -MaximumRedirection 0
      foreach ($m in @($r.data)) {
        if ($m.id -and $models.Count -lt 80) {
          $key = ('{0}|{1}|{2}' -f $mh, $port, [string]$m.id)
          if ($seenModels.ContainsKey($key)) { continue }
          $seenModels[$key] = $true
          $loc = Get-ModelLocation $mh
          $models += [ordered]@{
            id = ([string]$m.id).Substring(0, [Math]::Min(120, ([string]$m.id).Length))
            endpoint = ("http://{0}:{1}/v1" -f $mh, $port)
            location = $loc
            provider = $(if ($loc -eq 'local') { 'local' } elseif ($loc -eq 'lan') { 'lan' } else { '' })
            ctx = $null
            modalities = @('text')
            tags = @()
            source = 'guessed'
            loaded = $false
          }
        }
      }
    } catch {}
  }
}

# ── 权限 / 磁盘 ───────────────────────────────────────
$isAdmin = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
$diskFree = $null
try { $diskFree = [math]::Round((Get-PSDrive C).Free / 1GB, 1) } catch {}

$ramGB = if ($cs -and $cs.TotalPhysicalMemory) { [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } else { $null }
$ramFreeGB = if ($os -and $os.FreePhysicalMemory) { [math]::Round($os.FreePhysicalMemory / 1MB, 1) } else { $null }
$osText = if ($os) { ("{0} {1}" -f $os.Caption, $os.Version).Trim() } else { '' }
$cpuName = if ($cpu -and $cpu.Name) { ([string]$cpu.Name).Trim() } else { '' }
$cores = if ($cpu -and $cpu.NumberOfCores) { [int]$cpu.NumberOfCores } else { 0 }
$threads = if ($cpu -and $cpu.NumberOfLogicalProcessors) { [int]$cpu.NumberOfLogicalProcessors } else { 0 }

# ── 缺口 ─────────────────────────────────────────────
$gaps = @()
if (-not $ffmpeg) { $gaps += [ordered]@{ tool = 'ffmpeg'; why = '未找到 ffmpeg'; install = '安装 ffmpeg 并加入 PATH' } }
if (-not $pythonOk) { $gaps += [ordered]@{ tool = 'python'; why = '未安装或只有 WindowsApps 存根'; install = '安装 Python 3.12（用户级）' } }
if (-not $browsers.Count) { $gaps += [ordered]@{ tool = 'chromium'; why = '未找到 Edge/Chrome'; install = '安装 Edge 或 Chrome' } }

# ── 输出（schema 2 + 旧扁平字段，供既有能力协商直接读） ──
$out = [ordered]@{
  schema   = 2
  identity = [ordered]@{
    machine = $env:COMPUTERNAME
    os      = $osText
    arch    = $env:PROCESSOR_ARCHITECTURE
    cpu     = $cpuName
    cores   = $cores
    threads = $threads
    ramGB   = $ramGB
  }
  # 旧字段：lib/index.js 的 judge()/planRows 仍读这些，保持兼容
  os       = $osText
  cores    = $cores
  memGB    = $ramGB
  features = [ordered]@{
    shell    = $true
    ffmpeg   = [bool]$ffmpeg
    ffmpegHw = [bool]($hwEncoders.Count -gt 0)
    gpu      = [bool]($gpus.Count -gt 0)
    browsers = [bool]($browsers.Count -gt 0)
    python   = $pythonOk
    node     = [bool]$node
  }
  gpu      = $gpus
  tools    = [ordered]@{
    ffmpeg   = $ffmpegInfo
    browsers = $browsers
    node     = $nodeVersion
    python   = $pythonVersion
    pwsh     = $PSVersionTable.PSVersion.ToString()
  }
  models   = $models
  limits   = [ordered]@{
    ramFreeGB    = $ramFreeGB
    workDiskGB   = $diskFree
    admin        = $isAdmin
    maxConcurrent = 2
    quietHours   = ''
  }
  gaps       = $gaps
  detectedAt = (Get-Date).ToString('o')
}

if ($Pretty) { $out | ConvertTo-Json -Depth 10 } else { $out | ConvertTo-Json -Depth 10 -Compress }
