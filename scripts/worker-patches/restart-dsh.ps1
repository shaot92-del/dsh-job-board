#
# 安全重启副机上的 DSH：交给计划任务执行，能活过「被杀的宿主进程」。
#
# 为什么不能直接 先杀再起：
#   在 exec 任务里杀掉宿主 → 执行器跟着死 → 任务变孤儿、机器失联；
#   而 Electron 冷启动要 4~6 分钟，短超时判“失败”还会把正在启动的实例再杀一次。
#
# 做法：生成一个内层 ps1（杀 → 等 30s → 启动 → 每 10s 探测进程 → 失败再拉一次），
#       再用 schtasks 起它，外层脚本打印日志位置就退出。
#
# 用法：pwsh -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1
#
param(
  [int]$WaitSeconds = 360,
  [switch]$KeepTask
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  Write-Host ("MISSING {0}" -f $exe)
  exit 1
}

# 找 pwsh：优先用户安装目录，其次 PATH，最后退回 Windows PowerShell
$pwshCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\PowerShell\7\pwsh.exe'),
  (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
  'C:\Program Files\PowerShell\7\pwsh.exe'
)
$pwsh = $null
foreach ($c in $pwshCandidates) { if (Test-Path -LiteralPath $c) { $pwsh = $c; break } }
if (-not $pwsh) {
  $cmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($cmd) { $pwsh = $cmd.Source }
}
if (-not $pwsh) { $pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $env:TEMP ("dsh-restart-$stamp.log")
$innerPath = Join-Path $env:TEMP ("dsh-restart-inner-$stamp.ps1")
$cmdPath = Join-Path $env:TEMP ("dsh-restart-$stamp.cmd")

$inner = @'
$ErrorActionPreference = 'Continue'
$exe = '__EXE__'
$log = '__LOG__'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' ' + $m) }

L 'begin'
Start-Sleep -Seconds 10
$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
L ('procs before=' + $procs.Count)
$procs | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 30
L ('after stop procs=' + @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count)

Start-Process -FilePath $exe
L 'launched'
$ok = $false
for ($i = 0; $i -lt __TRIES__; $i++) {
  Start-Sleep -Seconds 10
  $n = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
  L ('t+' + (($i + 1) * 10) + 's procs=' + $n)
  if ($n -ge 3) { $ok = $true; break }
}
if (-not $ok) {
  L 'first launch did not settle, relaunching once'
  Start-Process -FilePath $exe
  for ($j = 0; $j -lt 12; $j++) {
    Start-Sleep -Seconds 10
    $n = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
    L ('retry t+' + (($j + 1) * 10) + 's procs=' + $n)
    if ($n -ge 3) { $ok = $true; break }
  }
}
L ('final ok=' + $ok)
'@

$inner = $inner.Replace('__EXE__', $exe).Replace('__LOG__', $logPath).Replace('__TRIES__', [string][Math]::Max(12, [int]($WaitSeconds / 10)))
[IO.File]::WriteAllText($innerPath, $inner, (New-Object Text.UTF8Encoding($false)))

$launcher = "@echo off`r`n`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$innerPath`"`r`n"
[IO.File]::WriteAllText($cmdPath, $launcher, (New-Object Text.UTF8Encoding($false)))

$taskName = 'DshRestart'
$tr = '"' + $cmdPath + '"'
$create = & schtasks /Create /TN $taskName /TR $tr /SC ONCE /ST 23:59 /F /IT 2>&1
Write-Host ("schtasks create: {0}" -f (($create | Out-String).Trim()))
if ($LASTEXITCODE -ne 0) {
  Write-Host '计划任务创建失败 —— 退回到「直接后台启动」模式（可能被宿主退出带崩）'
  Start-Process -FilePath $cmdPath -WindowStyle Hidden
} else {
  $run = & schtasks /Run /TN $taskName 2>&1
  Write-Host ("schtasks run: {0}" -f (($run | Out-String).Trim()))
}

Write-Host ''
Write-Host ("log     {0}" -f $logPath)
Write-Host ("inner   {0}" -f $innerPath)
Write-Host '冷启动约 4~6 分钟；用下面这句看进度（或等作业板这台机器重新变绿）：'
Write-Host ("  Get-Content '{0}' -Tail 20 -Wait" -f $logPath)
if (-not $KeepTask) {
  Write-Host ''
  Write-Host '（结束后可删任务：schtasks /Delete /TN DshRestart /F；本次不自动删，方便重复使用）'
}
