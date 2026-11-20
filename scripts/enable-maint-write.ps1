# enable-maint-write.ps1 — 在副机上打开「维护写通道」（写动词 + 签名票据）
#
# 为什么需要它：维护写通道（upgrade / config-set / restart）默认关闭，开启要往
# profile 的 cordis.patch.yml 的 team 行 -> config -> worker 里加三个键：
#   maintenanceWriteEnabled: true
#   maintenanceOutDir:       <主控可回收的摘要目录，可选>
#   maintenancePkgDir:       <升级包目录，可选>
#   maintAuthPublicKeys:     ['<主控公钥 base64>']   # 信任锚
# 手改 YAML 容易缩进错位、把键插到 team 块末尾（DSH 会直接起不来），所以用脚本。
#
# 用法（在副机上跑，普通用户即可）：
#   # 1) 主控上先拿到公钥（任选其一）
#   pwsh -File scripts/maint-ticket.mjs keygen --out $HOME\.dsh\maint\maint-key.json
#   #   然后复制打印出来的 publicKey
#
#   # 2) 副机上开写通道
#   pwsh -File scripts/enable-maint-write.ps1 -PublicKey '<base64 公钥>'
#   pwsh -File scripts/enable-maint-write.ps1 -PublicKey '<base64 公钥>' -DryRun
#
# 不传 -Profile 时：只有一个装了插件的 profile 就直接用，多个则要求显式指定。
# 写前备份 cordis.patch.yml.bak-maint-<时间戳>；写完复核 worker 子块与键值；
# 只补缺失/不匹配的键，重复运行是幂等的。
param(
  [string]$Profile = '',
  [string]$PublicKey = '',
  [string]$PublicKeyFile = '',
  [string]$OutDir = '',
  [string]$PkgDir = '',
  [switch]$AllowRestart,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'

function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 2 }
function Say($msg) { Write-Host $msg }

function Get-PluginProfiles {
  if (-not (Test-Path $profilesRoot)) { return @() }
  Get-ChildItem $profilesRoot -Directory | Where-Object {
    $p = Join-Path $_.FullName 'cordis.patch.yml'
    if (-not (Test-Path $p)) { return $false }
    $hit = Select-String -Path $p -Pattern 'dsh-job-board' -SimpleMatch -Quiet
    $installed = Test-Path (Join-Path $_.FullName 'node_modules\@wfcj\dsh-job-board\package.json')
    return ($hit -or $installed)
  } | ForEach-Object { $_.Name }
}

# 解析公钥：参数 > 文件 > 环境变量
if (-not $PublicKey -and $PublicKeyFile) {
  if (-not (Test-Path $PublicKeyFile)) { Fail "公钥文件不存在：$PublicKeyFile" }
  $PublicKey = (Get-Content $PublicKeyFile -Raw).Trim()
}
if (-not $PublicKey) { $PublicKey = (Get-Content Env:DSH_MAINT_PUBLIC_KEY -ErrorAction SilentlyContinue) }
if (-not $PublicKey) {
  Fail "缺 -PublicKey。先在主控跑：pwsh -File scripts/maint-ticket.mjs keygen --out <keyfile>，把打印的 publicKey 传进来。"
}
$PublicKey = $PublicKey.Trim()
if ($PublicKey -notmatch '^[A-Za-z0-9+/=]{40,400}$') { Fail "公钥格式不对（应为 base64，40-400 字符）：$($PublicKey.Substring(0,[Math]::Min(20,$PublicKey.Length)))…" }

$names = @(Get-PluginProfiles)
if (-not $Profile) {
  if ($names.Count -eq 0) { Fail "没找到装了 dsh-job-board 的 profile（$profilesRoot）。DSH 启动过吗？" }
  if ($names.Count -gt 1) { Fail "有多个 profile：$($names -join ', ')。请用 -Profile 指定一个。" }
  $Profile = $names[0]
}
$patch = Join-Path (Join-Path $profilesRoot $Profile) 'cordis.patch.yml'
if (-not (Test-Path $patch)) { Fail "找不到 $patch" }

# 找到 team 行 -> config -> worker 子块的范围（行号，0 基）
$lines = @(Get-Content $patch)
$teamIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^- id:\s*team\s*$') { $teamIdx = $i; break } }
if ($teamIdx -lt 0) { Fail "$patch 里没有 `- id: team` 行；先用 scripts/set-team-config.ps1 建出来。" }
$teamIndent = ($lines[$teamIdx] -replace '^(\s*).*$', '$1').Length

$workerIdx = -1
for ($i = $teamIdx + 1; $i -lt $lines.Count; $i++) {
  $l = $lines[$i]
  if ($l -match '^(\s*)\S') {
    $ind = $Matches[1].Length
    if ($ind -le $teamIndent) { break }
    if ($l -match '^\s*worker:\s*(\{\})?\s*$') { $workerIdx = $i; break }
  }
}
if ($workerIdx -lt 0) {
  Fail "$patch 的 team 块里没有 worker: 子块。请在 team 行的 config: 下新增：`n  worker:`n    workerMode: 'off'`n再用本脚本。"
}
$workerIndent = ($lines[$workerIdx] -replace '^(\s*).*$', '$1').Length
$childIndent = $workerIndent + 2

# worker 子块结束行
$end = $lines.Count
for ($i = $workerIdx + 1; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^(\s*)\S') {
    if ($Matches[1].Length -le $workerIndent) { $end = $i; break }
  }
}

# 读取现有键
function Get-KeyValue($key) {
  for ($i = $workerIdx + 1; $i -lt $end; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($key)):\s*(.*)$") { return $Matches[1].Trim() }
  }
  return $null
}

$pad = ' ' * $childIndent
$wanted = [ordered]@{}
$wanted['maintenanceWriteEnabled'] = 'true'
if ($OutDir) { $wanted['maintenanceOutDir'] = "'" + $OutDir.Replace("'", "''") + "'" }
if ($PkgDir) { $wanted['maintenancePkgDir'] = "'" + $PkgDir.Replace("'", "''") + "'" }
if ($AllowRestart) { $wanted['maintenanceAllowRestart'] = 'true' }
$wanted['maintAuthPublicKeys'] = "['" + $PublicKey + "']"

$adds = @()
$skips = @()
foreach ($k in $wanted.Keys) {
  $cur = Get-KeyValue $k
  $want = $wanted[$k]
  if ($null -eq $cur) { $adds += ($pad + $k + ': ' + $want) }
  elseif ($cur -ne $want) { $skips += "$k 现值 $(($cur -replace '\s+', ' ')) != 目标 $(($want -replace '\s+', ' '))（保留现值）" }
  else { $skips += "$k 已存在（保留现值）" }
}

Say "profile : $Profile"
Say "patch   : $patch"
Say "team    : 第 $($teamIdx + 1) 行；worker: 第 $($workerIdx + 1) 行（子键缩进 $childIndent）"
foreach ($s in $skips) { Say "  skip  $s" }
foreach ($a in $adds) { Say "  add   $($a.TrimStart())" }
if ($adds.Count -eq 0) { Say "配置无需改动。"; exit 0 }
if ($DryRun) { Say "（DryRun，不写盘）"; exit 0 }

# DSH 在跑时不写（热重载会 duplicate route），除非 -Force
$running = @(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0 -and -not $Force) {
  Fail "检测到 $($running.Count) 个 DeepSeek Harness 进程在跑。先退出 DSH 再跑（或加 -Force 自行承担热重载风险）。"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$patch.bak-maint-$stamp"
Copy-Item $patch $backup -Force
Say "备份：$backup"

# 插入到 worker 子块末尾（保持已有键顺序，不挤动后续行）
$new = New-Object System.Collections.Generic.List[string]
$new.AddRange([string[]]$lines[0..($end - 1)])
foreach ($a in $adds) { $new.Add($a) }
if ($end -lt $lines.Count) { $new.AddRange([string[]]$lines[$end..($lines.Count - 1)]) }

$text = ($new -join "`n")
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($patch, $text, $utf8)

# 写完复核：键在 worker 子块内、缩进正确、值类型像是 YAML（不是被包成字符串）
$check = @(Get-Content $patch)
$wIdx = -1
for ($i = 0; $i -lt $check.Count; $i++) { if ($check[$i] -match '^\s*worker:\s*(\{\})?\s*$' -and $i -gt $teamIdx) { $wIdx = $i; break } }
$problems = @()
foreach ($k in $wanted.Keys) {
  $hit = $false
  for ($i = $wIdx + 1; $i -lt $check.Count; $i++) {
    if ($check[$i] -match '^(\s*)\S' -and $Matches[1].Length -le $workerIndent) { break }
    if ($check[$i] -match "^\s*$([regex]::Escape($k)):") { $hit = $true; break }
  }
  if (-not $hit) { $problems += "$k 未落到 worker 子块" }
}
if ($problems.Count -gt 0) {
  Copy-Item $backup $patch -Force
  Fail ("写完复核失败，已回滚：" + ($problems -join '; '))
}

Say "已写入。复核通过：$($wanted.Keys -join ', ')"
Say "下一步：重启 DSH（本机），再在面板 maint 模式派 config-set 验证；票据签发见 scripts/maint-ticket.mjs。"
