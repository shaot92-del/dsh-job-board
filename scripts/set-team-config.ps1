# set-team-config.ps1 — 给某个 profile 的 cordis.patch.yml 写入/更新 team 块
#
# 为什么需要它：手粘 YAML 很容易被聊天工具换成弯引号（‘ ’ “ ”），PowerShell 会把
# 它们当普通字符、字符串永远不闭合，终端一直停在 ">>" 续行提示。用脚本就不碰引号。
#
# 用法（在要配置的那台机器上跑，普通用户即可）：
#   # 只看有哪些 profile、各自有没有 team 块
#   pwsh -File set-team-config.ps1 -List
#
#   # 配置某个 profile 接入团队板子（把占位符换成你自己的值）
#   pwsh -File set-team-config.ps1 -Profile desktop `
#     -BoardUrl 'http://<board-host>:8965' -Token '<board-token>' -Machine '<machine-name>' -Role observer
#
#   # 可选：给这台机器指定派工默认模型（空=跟随副机默认）
#   pwsh -File set-team-config.ps1 -Profile desktop -DefaultModel 'deepseek-account/deepseek-flash'
#
# 不传 -Profile 时：只有一个 profile 就直接用它，多个则要求显式指定。
# 写前会备份成 cordis.patch.yml.bak-setteam-<时间戳>；写完会复核 team 块数量与字段。
param(
  [string]$Profile = '',
  [string]$BoardUrl = '',
  [string]$Token = '',
  [string]$Machine = '',
  [ValidateSet('owner', 'observer', '')]
  [string]$Role = '',
  [string]$DefaultModel = '',
  [switch]$List,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'

function Get-Profiles {
  if (-not (Test-Path $profilesRoot)) { return @() }
  Get-ChildItem $profilesRoot -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'cordis.patch.yml'
    [pscustomobject]@{
      Name = $_.Name
      Path = $p
      Exists = (Test-Path $p)
      Size = if (Test-Path $p) { (Get-Item $p).Length } else { 0 }
      TeamBlocks = if (Test-Path $p) { @(Select-String -Path $p -Pattern '^- id: team\s*$').Count } else { 0 }
    }
  }
}

$all = @(Get-Profiles)
if ($List -or (-not $Profile -and $all.Count -ne 1)) {
  if ($all.Count -eq 0) { Write-Host "[!] 没找到 $profilesRoot，DSH 装过并至少启动过一次吗？" -ForegroundColor Red; exit 2 }
  Write-Host "profiles（$profilesRoot）："
  foreach ($a in $all) {
    $flag = if ($a.TeamBlocks -eq 1) { 'ok' } elseif ($a.TeamBlocks -eq 0) { '缺 team' } else { '重复 team!' }
    Write-Host ("  {0,-16} {1,-10} {2,7} B  {3}" -f $a.Name, $flag, $a.Size, $a.Path)
  }
  if ($List) { exit 0 }
  if (-not $Profile) { Write-Host "[!] 有多个 profile，请用 -Profile 指定一个。" -ForegroundColor Red; exit 2 }
}

if (-not $Profile) { $Profile = $all[0].Name }
$target = $all | Where-Object { $_.Name -eq $Profile } | Select-Object -First 1
if (-not $target) { Write-Host "[!] 没有这个 profile：$Profile" -ForegroundColor Red; exit 2 }
if (-not $target.Exists) { Write-Host "[!] 缺少文件：$($target.Path)" -ForegroundColor Red; exit 2 }

$path = $target.Path
$lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $path)

# 找 team 块范围（'- id: team' 顶格，到下一个顶格 '- id:' 为止）
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^- id: team\s*$') { $start = $i; break }
}
$end = $lines.Count
if ($start -ge 0) {
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^- id:') { $end = $i; break }
  }
}

function YamlQuote([string]$v) {
  # v2.0.2：值直接塞进单引号会被 ' 或换行破坏（轻则 YAML 解析失败，重则注入别的键）。
  if ($v -match "[\r\n]") { throw "值里不能有换行：$v" }
  return "'" + $v.Replace("'", "''") + "'"
}

function Set-Field {
  param([System.Collections.Generic.List[string]]$Block, [string]$Key, [string]$Value)
  if (-not $Value) { return }
  $line = "    ${Key}: $(YamlQuote $Value)"
  for ($i = 0; $i -lt $Block.Count; $i++) {
    if ($Block[$i] -match "^\s{2,4}${Key}:") { $Block[$i] = $line; return }
  }
  # 没有这个键：插到 config: 后面（没有 config: 就插在 id 行后）
  $at = 1
  for ($i = 0; $i -lt $Block.Count; $i++) { if ($Block[$i] -match '^\s{2}config:\s*$') { $at = $i + 1; break } }
  $Block.Insert($at, $line)
}

if ($start -ge 0) {
  $block = [System.Collections.Generic.List[string]]($lines.GetRange($start, $end - $start))
  Set-Field -Block $block -Key 'boardUrl' -Value $BoardUrl
  Set-Field -Block $block -Key 'machine' -Value $Machine
  Set-Field -Block $block -Key 'token' -Value $Token
  Set-Field -Block $block -Key 'dispatchRole' -Value $Role
  Set-Field -Block $block -Key 'defaultModel' -Value $DefaultModel
  $lines.RemoveRange($start, $end - $start)
  $lines.InsertRange($start, $block)
  $action = "更新已有 team 块（第 $($start + 1) 行）"
} else {
  if (-not $BoardUrl) { Write-Host "[!] 没有 team 块，新建时必须给 -BoardUrl。" -ForegroundColor Red; exit 2 }
  $block = [System.Collections.Generic.List[string]]@(
    '- id: team',
    '  config:',
    "    boardUrl: $(YamlQuote $BoardUrl)"
  )
  if ($Machine) { $block.Add("    machine: $(YamlQuote $Machine)") }
  if ($Token) { $block.Add("    token: $(YamlQuote $Token)") }
  if ($Role) { $block.Add("    dispatchRole: $(YamlQuote $Role)") }
  if ($DefaultModel) { $block.Add("    defaultModel: $(YamlQuote $DefaultModel)") }
  $lines.Add('')
  $lines.AddRange($block)
  $action = '追加新 team 块'
}

if ($DryRun) {
  Write-Host "== DryRun：$action（未写盘）" -ForegroundColor Yellow
  $lines | Select-Object -Last 12 | ForEach-Object { Write-Host "  $_" }
  exit 0
}

# v2.0.3（复核 L3）：备份名精确到毫秒且不覆盖已有文件 —— 它可能是唯一能恢复原状的副本。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$bak = "$path.bak-setteam-$stamp"
$n = 1
while (Test-Path -LiteralPath $bak) { $bak = "$path.bak-setteam-$stamp-$n"; $n++ }
Copy-Item -LiteralPath $path -Destination $bak
# v2.0.2：先写临时文件再原子替换，避免写一半崩溃把 patch 截断（这个项目已经丢过两次配置）。
$tmp = "$path.tmp-setteam"
Set-Content -LiteralPath $tmp -Value $lines -Encoding utf8
Move-Item -LiteralPath $tmp -Destination $path -Force

# 复核
$check = Get-Content -LiteralPath $path
$teamCount = @($check | Select-String -Pattern '^- id: team\s*$').Count
$ok = $teamCount -eq 1
foreach ($need in @(@('boardUrl', $BoardUrl), @('machine', $Machine), @('token', $Token), @('dispatchRole', $Role), @('defaultModel', $DefaultModel))) {
  if ($need[1]) {
    $hit = @($check | Select-String -Pattern ("^\s{2,4}" + $need[0] + ":")).Count
    if ($hit -lt 1) { $ok = $false }
  }
}
Write-Host "== $action → $path"
Write-Host "   备份：$bak"
Write-Host ("   team 块数量：{0}" -f $teamCount)
  if ($Token) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hx = [System.BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))).Replace('-','').ToLowerInvariant().Substring(0,8) }
    finally { $sha.Dispose() }
    Write-Host ("   token：已写入（{0} 字符，sha256 {1}）" -f $Token.Length, $hx)
  }
if ($ok) {
  Write-Host '   复核通过。下一步：完全退出 DSH 再启动（热重载会撞 duplicate route）。' -ForegroundColor Green
} else {
  Write-Host '   [!] 复核没通过，从备份恢复：Copy-Item <备份> <原文件> -Force' -ForegroundColor Red
  exit 3
}
