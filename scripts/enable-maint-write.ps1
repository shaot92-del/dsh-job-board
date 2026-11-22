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
  [string]$DshExePath = '',
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
# v2.7.6（审查 P2-3）：只验 base64 形态会把「长得像公钥的垃圾」写进配置，等到副机验签时才失败。
# 这里再解一次 DER-SPKI，确认里面带 Ed25519 的算法 OID（1.3.101.112 = 06 03 2B 65 70）。
try {
  $pubDer = [Convert]::FromBase64String($PublicKey)
} catch {
  Fail "公钥不是合法 base64：$($PublicKey.Substring(0,[Math]::Min(20,$PublicKey.Length)))…"
}
$hasEd25519Oid = $false
for ($i = 0; $i -le ($pubDer.Length - 5); $i++) {
  if ($pubDer[$i] -eq 0x06 -and $pubDer[$i + 1] -eq 0x03 -and $pubDer[$i + 2] -eq 0x2B -and $pubDer[$i + 3] -eq 0x65 -and $pubDer[$i + 4] -eq 0x70) { $hasEd25519Oid = $true; break }
}
if (-not $hasEd25519Oid) { Fail "公钥不是 Ed25519 SPKI（DER 里找不到 OID 1.3.101.112）。请用 maint-ticket.mjs keygen 生成的 publicKey。" }

$allProfileDirs = @()
if (Test-Path $profilesRoot) { $allProfileDirs = @(Get-ChildItem $profilesRoot -Directory | ForEach-Object { $_.Name }) }
$names = @(Get-PluginProfiles)
if (-not $Profile -and $allProfileDirs.Count -gt 1) {
  # v2.7.4：多 profile 的机器最容易「改了一份、DSH 加载另一份」——真机上排查过一整轮。
  # 这里显式把「有哪些 profile / 哪些会被改」打出来，免得又白跑。
  Say "检测到多个 profile：$($allProfileDirs -join ', ')"
  Say "其中含本插件/键位的：$($names -join ', ')（将按顺序补键）"
}$names = @(Get-PluginProfiles)
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
# 扁平布局兼容（v2.7.4 起）：有些机器把 worker 配置**直接平铺**在 team -> config 下
# （workerMode / pollMs / allowlist … 没有嵌套 worker: 块）。插件两种布局都读，本脚本也要两种都能写。
$flatMode = $false
$insertAt = -1
$flatConfigIdx = -1
$flatConfigEnd = -1
if ($workerIdx -lt 0) {
  $configIdx = -1
  for ($i = $teamIdx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*config:\s*$') { $configIdx = $i; break }
    if ($lines[$i] -match '^(\s*)\S' -and $Matches[1].Length -le $teamIndent) { break }
  }
  if ($configIdx -ge 0) {
    $configIndent = ($lines[$configIdx] -replace '^(\s*).*$', '$1').Length
    $lastKey = -1
    $keyIndent = -1
    for ($i = $configIdx + 1; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '^(\s*)\S' -and $Matches[1].Length -le $configIndent) { break }
      if ($lines[$i] -match '^(\s*)(workerMode|pollMs|allowlist|allowAllRoots|allowedRoots|shellTimeoutMs|maxOutputBytes|agentEnabled|agentAllowlist|agentPreset|execCwdRoot|approvalMode|allowInline)\s*:') {
        $lastKey = $i
        $keyIndent = $Matches[1].Length
      }
    }
    if ($lastKey -ge 0) {
      $flatMode = $true
      $workerIdx = $lastKey
      $workerIndent = $keyIndent
      # config 块结束行：新键统一追加到 config 末尾（而不是紧贴最后一个 worker 键），
      # 这样 Get-KeyValue 的扫描区间才能覆盖已有的 maintenance* 键（否则重跑会写重复键）。
      $cfgEnd = $lines.Count
      for ($i = $configIdx + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^(\s*)\S' -and $Matches[1].Length -le $configIndent) { $cfgEnd = $i; break }
      }
      $flatConfigIdx = $configIdx
      $flatConfigEnd = $cfgEnd
      $insertAt = $cfgEnd
    }
  }
}
if ($workerIdx -lt 0) {
  Fail "$patch 的 team 块里既没有 worker: 子块、也没有平铺的 workerMode 等键。请先在 team 的 config: 下建 worker 配置（可跑 scripts/set-team-config.ps1），再用本脚本。"
}
$workerIndent = ($lines[$workerIdx] -replace '^(\s*).*$', '$1').Length
$childIndent = if ($flatMode) { $workerIndent } else { $workerIndent + 2 }
if ($flatMode) { Say "检测到扁平布局：worker 键平铺在 config 下（缩进 $workerIndent），新键按同级追加" }

# 内联空 map（worker: {}）必须展开成 worker: 空块，否则子键挂不到 worker 上，
# 标准 YAML 解析会失败（DSH 起不来）。v2.7.0 二次复审 P1。
$inlineEmptyMap = $lines[$workerIdx] -match '^\s*worker:\s*\{\}\s*$'
if ($inlineEmptyMap) {
  $lines[$workerIdx] = ($lines[$workerIdx] -replace '\{\}\s*$', '').TrimEnd()
  Say "worker: {} 为内联空 map，已展开为 worker: 空块再插入子键"
}

# 插入位置：嵌套布局 = worker 子块结束行；扁平布局 = 最后一个 worker 键的下一行
$end = $lines.Count
if ($flatMode) {
  $end = $insertAt
} else {
  for ($i = $workerIdx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^(\s*)\S') {
      if ($Matches[1].Length -le $workerIndent) { $end = $i; break }
    }
  }
}

# 读取现有键
function Get-KeyValue($key) {
  $from = if ($flatMode) { $flatConfigIdx + 1 } else { $workerIdx + 1 }
  $to = if ($flatMode) { $flatConfigEnd } else { $end }
  for ($i = $from; $i -lt $to; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($key)):\s*(.*)$") { return $Matches[1].Trim() }
  }
  return $null
}

$pad = ' ' * $childIndent

# v2.7.8：升级包目录缺省自动探测（副机共享盘映射的常用位置），省得每次手传。
if (-not $PkgDir) {
  foreach ($cand in @('Z:\_tools\dsh-job-board', 'L:\云盘\gp_video_xfer\_tools\dsh-job-board')) {
    # 盘符可能没映射（Join-Path 会抛「找不到驱动器」）⇒ 先确认卷在
    try { if (-not (Test-Path -LiteralPath (Split-Path -Qualifier $cand))) { continue } } catch { continue }
    try {
      if (Test-Path -LiteralPath $cand -PathType Container) { $PkgDir = $cand; break }
    } catch { continue }
  }
}

# v2.7.8：-AllowRestart 时同时写 dshExePath（远程升级要「停 DSH→换包→拉起」）。
# 这两个键刻意不在远程可写白名单里，只能本机写一次。
if ($AllowRestart -and -not $DshExePath) {
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c -PathType Leaf) { $DshExePath = $c; break } }
  if (-not $DshExePath) {
    $lnkRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    if (Test-Path $lnkRoot) {
      $lnk = Get-ChildItem $lnkRoot -Recurse -Filter '*DeepSeek*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($lnk) {
        try {
          $sh = New-Object -ComObject WScript.Shell
          $target = $sh.CreateShortcut($lnk.FullName).TargetPath
          if ($target -and (Test-Path $target -PathType Leaf)) { $DshExePath = $target }
        } catch { /* 拿不到就跳过 */ }
      }
    }
  }
}

$wanted = [ordered]@{}
$wanted['maintenanceWriteEnabled'] = 'true'
if ($OutDir) { $wanted['maintenanceOutDir'] = "'" + $OutDir.Replace("'", "''") + "'" }
if ($PkgDir) { $wanted['maintenancePkgDir'] = "'" + $PkgDir.Replace("'", "''") + "'" }
if ($AllowRestart) {
  $wanted['maintenanceAllowRestart'] = 'true'
  if ($DshExePath) { $wanted['dshExePath'] = "'" + $DshExePath.Replace("'", "''") + "'" }
  else { Say "[!] -AllowRestart 已给但找不到 DSH 可执行文件；远程升级仍会因无权重启而失败（用 -DshExePath 显式指定）" }
}
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
if ($wIdx -ge 0 -and $check[$wIdx] -match '\{\}') { $problems += "worker: {} 仍是内联空 map，子键挂不到 worker 上" }
foreach ($k in $wanted.Keys) {
  $hit = $false
  if ($flatMode) {
    $cfgIdx2 = -1
    for ($i = $teamIdx + 1; $i -lt $check.Count; $i++) { if ($check[$i] -match '^\s*config:\s*$') { $cfgIdx2 = $i; break } }
    $cfgIndent2 = if ($cfgIdx2 -ge 0) { ($check[$cfgIdx2] -replace '^(\s*).*$', '$1').Length } else { $workerIndent - 2 }
    for ($i = $cfgIdx2 + 1; $i -lt $check.Count; $i++) {
      if ($check[$i] -match '^(\s*)\S' -and $Matches[1].Length -le $cfgIndent2) { break }
      if ($check[$i] -match "^\s*$([regex]::Escape($k)):") { $hit = $true; break }
    }
  } else {
    for ($i = $wIdx + 1; $i -lt $check.Count; $i++) {
      if ($check[$i] -match '^(\s*)\S' -and $Matches[1].Length -le $workerIndent) { break }
      if ($check[$i] -match "^\s*$([regex]::Escape($k)):") { $hit = $true; break }
    }
  }
  if (-not $hit) { $problems += "$k 未落到 worker 配置里" }
}
if ($problems.Count -gt 0) {
  Copy-Item $backup $patch -Force
  Fail ("写完复核失败，已回滚：" + ($problems -join '; '))
}

Say "已写入。复核通过：$($wanted.Keys -join ', ')"
Say "下一步：重启 DSH（本机），再在面板 maint 模式派 config-set 验证；票据签发见 scripts/maint-ticket.mjs。"
