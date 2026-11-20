# upgrade-worker.ps1 —— 副机一键升级（双击 upgrade-worker.cmd 即走这里）
#
# 做五件事（每步可回滚）：
#   1. 找到本机装了 dsh-job-board 的 profile，读当前版本与 team 块配置
#   2. 检查 / 补 `machine` 名（副机必须写成自己的名字，否则看板上会显示成 host）
#   3. 装新包（旧目录备份成 .bak-<时间戳>）
#   4. 只插入缺失的 agent 配置键（不动其它行；改前备份 cordis.patch.yml）
#   5. 问你要不要立刻重启 DSH；重启后自动复查版本并弹窗告诉你结果
#
# 用法：
#   双击 upgrade-worker.cmd                    # 交互式，每步都问
#   pwsh -File upgrade-worker.ps1 -Yes         # 不问，直接装+重启
#   pwsh -File upgrade-worker.ps1 -NoRestart   # 装完不重启
#   pwsh -File upgrade-worker.ps1 -MachineName gt14

param(
  [string]$ProfileDir = '',
  [string]$Tarball = '',
  [string]$CwdRoot = '',
  [string]$MachineName = '',
  [string]$Preset = 'standard',
  [string]$GoalPrefix = '只回答',
  [ValidateSet('confirm', 'auto')][string]$Approval = 'confirm',
  [int]$BudgetPerDay = 20,
  [switch]$Yes,
  [switch]$NoRestart,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$HERE = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Tarball) { $Tarball = Join-Path $HERE 'wfcj-dsh-job-board-2.7.3.tgz' }
if (-not (Test-Path -LiteralPath $Tarball)) {
  $zip = [IO.Path]::ChangeExtension($Tarball, '.zip')
  if (Test-Path -LiteralPath $zip) { $Tarball = $zip } else { Write-Host "找不到安装包：$Tarball" -ForegroundColor Red; exit 1 }
}
$installer = Join-Path $HERE 'install-agent-worker.ps1'
if (-not (Test-Path -LiteralPath $installer)) { Write-Host "找不到 install-agent-worker.ps1（应与本文件同目录）" -ForegroundColor Red; exit 1 }

function Line($c = '-') { Write-Host ('-' * 68) -ForegroundColor DarkGray }
function Step($n, $t) { Line; Write-Host ("[$n/5] " + $t) -ForegroundColor Cyan }
function Info($m) { Write-Host ("      " + $m) -ForegroundColor Gray }
function Ok($m) { Write-Host ("      OK  " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("      !   " + $m) -ForegroundColor Yellow }
function Die($m) { Write-Host ("ERROR: " + $m) -ForegroundColor Red; exit 1 }
function Ask($q, $defaultYes = $true) {
  if ($Yes) { return $true }
  $hint = if ($defaultYes) { '[Y/n]' } else { '[y/N]' }
  $ans = Read-Host ("      " + $q + ' ' + $hint)
  if ([string]::IsNullOrWhiteSpace($ans)) { return $defaultYes }
  return ($ans -match '^(y|yes|是|好|确认)$')
}

Line
Write-Host '  dsh-job-board 副机升级' -ForegroundColor White
Info ("主机名：" + $env:COMPUTERNAME)
Info ("安装包：" + $Tarball)
Info ("执行者：" + $env:USERNAME)

# ── 1. 找 profile、读现状 ────────────────────────────────────────────────────
Step 1 '定位 profile 与当前版本'
$root = Join-Path $env:USERPROFILE '.dsh\profiles'
$hits = @()
if ($ProfileDir) {
  if (-not (Test-Path -LiteralPath $ProfileDir)) { Die "profile 目录不存在：$ProfileDir" }
  $hits = @(Get-Item -LiteralPath $ProfileDir)
} else {
  if (-not (Test-Path -LiteralPath $root)) { Die "找不到 $root" }
  $hits = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {
      $pj = Join-Path $_.FullName 'node_modules\@wfcj\dsh-job-board\package.json'
      $cp = Join-Path $_.FullName 'cordis.patch.yml'
      (Test-Path -LiteralPath $pj) -or ((Test-Path -LiteralPath $cp) -and (Select-String -LiteralPath $cp -Pattern 'dsh-job-board' -Quiet))
    })
}
if ($hits.Count -eq 0) { Die "没找到装了 dsh-job-board 的 profile，请用 -ProfileDir 指定" }
if ($hits.Count -gt 1) { Die ("找到多个 profile：" + (($hits | ForEach-Object { $_.Name }) -join ', ') + "，请用 -ProfileDir 指定一个") }
$ProfileDir = $hits[0].FullName
Ok ("profile：" + $ProfileDir)

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) { Die "找不到 $patchPath" }
$instPkg = Join-Path $ProfileDir 'node_modules\@wfcj\dsh-job-board\package.json'
$before = if (Test-Path -LiteralPath $instPkg) { (Get-Content -LiteralPath $instPkg -Raw | ConvertFrom-Json).version } else { '(未安装)' }
$newVer = (Get-Content -LiteralPath (Join-Path $HERE ([IO.Path]::GetFileName($Tarball))) -Raw -ErrorAction SilentlyContinue)
if ($Tarball -like '*.tgz') {
  # 从包里读版本，不依赖解包
  $tmpRead = Join-Path $env:TEMP ('jb-read-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmpRead | Out-Null
  & tar -xzf $Tarball -C $tmpRead package/package.json 2>$null
  $pj = Join-Path $tmpRead 'package\package.json'
  if (Test-Path -LiteralPath $pj) { $wantVer = (Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).version } else { $wantVer = '(未知)' }
  try { [IO.Directory]::Delete($tmpRead, $true) } catch { }
} else { $wantVer = '(见包)' }
Info ("当前版本：" + $before + "   目标版本：" + $wantVer)

# 运行中的 DSH 版本（能找到端口就看一眼）
$runVer = ''
try {
  $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object OwningProcess -in (Get-Process 'DeepSeek Harness' -ErrorAction Stop).Id |
      Where-Object LocalPort -gt 1000 | Sort-Object LocalPort)
  if ($ports.Count -gt 0) {
    $p = $ports[0].LocalPort
    $d = Invoke-RestMethod ("http://127.0.0.1:$p/api/board/ui/doctor") -TimeoutSec 5
    $runVer = "$($d.version)（机器名 $($d.machine)，角色 $($d.role)，端口 $p）"
    Info ("运行中 DSH：" + $runVer)
  } else { Info '运行中 DSH：未检测到' }
} catch { Info '运行中 DSH：未检测到（可能没开）' }

# ── 2. 检查 machine 名 ──────────────────────────────────────────────────────
Step 2 '检查 team 块的 machine 名'
$lines = @(Get-Content -LiteralPath $patchPath)
$teamIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*-\s*id:\s*team\s*$') { $teamIdx = $i; break } }
if ($teamIdx -lt 0) { Die ("$patchPath 里没有 `- id: team` 行。先在 profile 里加一行（至少 boardUrl/machine/token），再跑。" ) }
$endIdx = $lines.Count - 1
for ($j = $teamIdx + 1; $j -lt $lines.Count; $j++) { if ($lines[$j] -match '^- ') { $endIdx = $j - 1; break } }
$block = @($lines[$teamIdx..$endIdx])

$machineIdx = -1
for ($k = 0; $k -lt $block.Count; $k++) { if ($block[$k] -match '^\s+machine:\s*(.*)$') { $machineIdx = $k; break } }
$curMachine = if ($machineIdx -ge 0) { ($block[$machineIdx] -replace '^\s*machine:\s*', '').Trim().Trim("'", '"') } else { '' }

$suggest = if ($MachineName) { $MachineName } else { ($env:COMPUTERNAME -split '\.')[0].ToLower() }
if (-not $curMachine) {
  Warn 'machine 是空的（会按 hostname 猜，看板上可能显示成 host）'
  if (-not $DryRun) {
    if (Ask ("把 machine 写成 '" + $suggest + "' ?") ) {
      if ($machineIdx -ge 0) {
        # 已有 machine 行但值为空 → 原地替换，别插第二行（否则 YAML duplicate key）
        $block[$machineIdx] = ($block[$machineIdx] -replace 'machine:\s*.*$', ("machine: '" + $suggest + "'"))
        Ok ("machine 已就地改为 '" + $suggest + "'")
      } else {
        $cfgIdx = -1
        for ($k = 0; $k -lt $block.Count; $k++) { if ($block[$k] -match '^(\s+)config:\s*$') { $cfgIdx = $k; break } }
        if ($cfgIdx -lt 0) { Warn 'team 块里没有 config: 行，跳过 machine 写入（请手工补）' }
        else {
          $cfgIndent = ([regex]::Match($block[$cfgIdx], '^(\s+)config:')).Groups[1].Value
          $block = @($block[0..$cfgIdx]) + @($cfgIndent + '  machine: ' + "'" + $suggest + "'") + @($block[($cfgIdx + 1)..($block.Count - 1)])
          $machineIdx = $cfgIdx + 1
          Ok ("已在 config 下插入 machine: '" + $suggest + "'")
        }
      }
      $curMachine = $suggest
    } else { Warn '保持空值（后续 agent 任务仍可能因 machine 不符被拦）' }
  }} elseif ($curMachine -eq 'host') {
  Warn "machine 当前是 'host' —— 如果这台是副机，应该改成自己的名字"
  if (-not $DryRun) {
    if (Ask ("改成 '" + $suggest + "' ?") ) {
      $block[$machineIdx] = ($block[$machineIdx] -replace 'machine:\s*.*$', ("machine: '" + $suggest + "'"))
      $curMachine = $suggest
      Ok ("machine 已改为 '" + $suggest + "'")
    }
  }
} else {
  Ok ("machine = '" + $curMachine + "'")
}

if ($block -join "`n" -ne ($lines[$teamIdx..$endIdx] -join "`n")) {
  if ($DryRun) { Info '[dry] machine 改动不会写入' }
  else {
    $stamp0 = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $patchPath -Destination ("$patchPath.bak-machine-$stamp0") -Force
    $out = @()
    if ($teamIdx -gt 0) { $out += $lines[0..($teamIdx - 1)] }
    $out += $block
    if ($endIdx -lt $lines.Count - 1) { $out += $lines[($endIdx + 1)..($lines.Count - 1)] }
    [IO.File]::WriteAllText($patchPath, (($out -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Ok ("已写回 machine（备份 cordis.patch.yml.bak-machine-$stamp0）")
  }
}

# ── 3. 装包 ────────────────────────────────────────────────────────────────
Step 3 ("安装 " + $wantVer + "（当前 " + $before + "）")
if (-not (Ask '开始装包？')) { Info '已取消'; exit 0 }
$instArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-ProfileDir', $ProfileDir, '-Tarball', $Tarball, '-Preset', $Preset, '-GoalPrefix', $GoalPrefix, '-Approval', $Approval, '-BudgetPerDay', "$BudgetPerDay", '-SkipConfig')
if ($CwdRoot) { $instArgs += @('-CwdRoot', $CwdRoot) }
if ($DryRun) { $instArgs += '-DryRun' }
# v2.7.3: 装包走原子切换，由安装脚本代停 DSH（步骤 5 负责重启）
$instArgs += '-StopDsh'
$pw = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pw) { $pw = Get-Command powershell -ErrorAction SilentlyContinue }
if (-not $pw) { Die '找不到 pwsh / powershell' }
& $pw.Source @instArgs
if ($LASTEXITCODE -ne 0) { Die "装包失败（exit=$LASTEXITCODE）；旧目录备份在 <安装目录>.bak-* ，可手工还原" }
$verFile = Join-Path (Join-Path $ProfileDir 'node_modules\@wfcj\dsh-job-board') 'package.json'
$instNow = if (Test-Path -LiteralPath $verFile) { (Get-Content -LiteralPath $verFile -Raw | ConvertFrom-Json).version } else { '' }
if ($instNow -ne $wantVer) { Die ("装完版本不符：磁盘 $instNow / 期望 $wantVer（安装脚本应已回滚，检查 .bak-*）") }

# ── 4. 补配置 ──────────────────────────────────────────────────────────────
Step 4 '补齐 agent 配置（只插入缺失键）'
$cfgArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-ProfileDir', $ProfileDir, '-SkipPackage', '-Preset', $Preset, '-GoalPrefix', $GoalPrefix, '-Approval', $Approval, '-BudgetPerDay', "$BudgetPerDay")
if ($CwdRoot) { $cfgArgs += @('-CwdRoot', $CwdRoot) }
if ($DryRun) { $cfgArgs += '-DryRun' }
& $pw.Source @cfgArgs
if ($LASTEXITCODE -ne 0) { Die "改配置失败（exit=$LASTEXITCODE）；备份在同目录 cordis.patch.yml.bak-agent-*" }

$instVer = if (Test-Path -LiteralPath $instPkg) { (Get-Content -LiteralPath $instPkg -Raw | ConvertFrom-Json).version } else { '(未安装)' }
Line
Write-Host ("  装好了：$before -> $instVer") -ForegroundColor Green
Info ("profile：$ProfileDir")
Info ("备份：<安装目录>.bak-* 与 cordis.patch.yml.bak-agent-*")

# ── 5. 重启 ────────────────────────────────────────────────────────────────
Step 5 '重启 DSH 让新代码与配置生效'
if ($NoRestart) { Info '按 -NoRestart 跳过。之后自己重启 DSH 即可。'; exit 0 }
if (-not (Ask '现在重启 DSH？本窗口可能跟着关闭')) { Info '跳过重启。之后自己重启 DSH 即可。'; exit 0 }

# 重启前先记住「当前正在跑的 exe 路径」——副机安装位置不一定在 LOCALAPPDATA
$exe = $null
$proc = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc -and $proc.Path -and (Test-Path -LiteralPath $proc.Path)) { $exe = $proc.Path; Info ("将用当前进程路径重启：" + $exe) }
if (-not $exe) {
  foreach ($c in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
      (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
      (Join-Path $env:APPDATA 'DeepSeek Harness\DeepSeek Harness.exe'))) {
    if ($c -and (Test-Path -LiteralPath $c)) { $exe = $c; break }
  }
}
if (-not $exe) {
  # 开始菜单快捷方式兜底
  $sh = New-Object -ComObject WScript.Shell
  foreach ($dir in @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($l in @(Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'DeepSeek|Harness' })) {
      try { $tp = $sh.CreateShortcut($l.FullName).TargetPath; if ($tp -and (Test-Path -LiteralPath $tp)) { $exe = $tp; break } } catch { }
    }
    if ($exe) { break }
  }
}
if (-not $exe) {
  Warn '没找到 DSH 的 exe 路径 —— 关掉后可能起不来。'
  Warn '建议先取消重启，改双击同目录的 start-dsh.cmd（它会自己搜）。'
  if (-not (Ask '仍然继续重启？')) { Info '已取消重启'; exit 0 }
}
$resultFile = Join-Path $env:USERPROFILE ("dsh-upgrade-result-" + $env:COMPUTERNAME + ".txt")
$restartScript = @"
Start-Sleep -Seconds 3
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
`$exe = '$exe'
if ($exe -and (Test-Path -LiteralPath `$exe)) { Start-Process -LiteralPath `$exe }
`$ok = `$false; `$ver = ''; `$port = ''
for (`$i = 0; `$i -lt 45; `$i++) {
  Start-Sleep -Seconds 2
  try {
    `$ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { `$_.LocalPort -gt 1000 } | Where-Object { (Get-Process -Id `$_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'DeepSeek Harness' } | Sort-Object LocalPort)
    foreach (`$p in `$ports) {
      try {
        `$d = Invoke-RestMethod ("http://127.0.0.1:" + `$p.LocalPort + '/api/board/ui/doctor') -TimeoutSec 3
        if (`$d.version) { `$ok = `$true; `$ver = `$d.version; `$port = `$p.LocalPort; break }
      } catch { }
    }
  } catch { }
  if (`$ok) { break }
}
`$text = if (`$ok) { "重启完成：运行版本 v`$ver，GUI 端口 `$port" } else { "重启后 90 秒内没探到 DSH 的 doctor，请手工打开 DSH 并查看版本" }
`$text | Out-File -FilePath '$resultFile' -Encoding utf8
try { (New-Object -ComObject WScript.Shell).Popup(`$text, 12, 'dsh-job-board 升级', 64) | Out-Null } catch { }
"@
$tmp = Join-Path $env:TEMP ('jb-restart-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
[IO.File]::WriteAllText($tmp, $restartScript, (New-Object System.Text.UTF8Encoding($true)))
Start-Process -FilePath $pw.Source -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp) -WindowStyle Hidden
Write-Host ''
Write-Host '      已安排重启：3 秒后关闭 DSH，随后自动拉起；' -ForegroundColor Yellow
Write-Host ('      重启后会有弹窗报版本，结果也存在 ' + $resultFile) -ForegroundColor Yellow
Write-Host ''
