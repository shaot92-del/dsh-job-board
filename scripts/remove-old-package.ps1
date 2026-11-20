<#
.SYNOPSIS
  一键清理「旧版 unscoped 包（dsh-job-board）」残留。

.DESCRIPTION
  旧版插件包名是 `dsh-job-board`（无 scope），新版是 `@wfcj/dsh-job-board`。
  两份同时存在时，同一批 patch / 工具 / 路由会被注册两次，热重载会报
  `webserver: duplicate exact route`，面板也可能起不来。

  本脚本把 README 里的三步手工流程做成一步（默认 DryRun，只打印不改）：
    1) profile package.json 的 dependencies 里去掉 `dsh-job-board`
    2) profile package.json 的 dsh.profile.bundles 里去掉 `dsh-job-board`
    3) node_modules\dsh-job-board 目录改名备份（不直接删）

  改完会提示重启 DSH —— 插件模块在 DSH 启动时加载，热重载清不掉旧实例的路由。

.PARAMETER Profile
  profile 名（对应 %USERPROFILE%\.dsh\profiles\<name>），默认 desktop。

.PARAMETER ProfileDir
  直接给 profile 目录（优先级高于 -Profile）。

.PARAMETER Apply
  真正落盘（不加就是 DryRun）。

.EXAMPLE
  pwsh -File scripts\remove-old-package.ps1
  pwsh -File scripts\remove-old-package.ps1 -Profile zzc -Apply
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$ProfileDir = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Say($msg) { Write-Host $msg }
function Warn($msg) { Write-Host "WARN  $msg" -ForegroundColor Yellow }

if (-not $ProfileDir) {
  $ProfileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
}
if (-not (Test-Path -LiteralPath $ProfileDir)) {
  throw "profile 目录不存在：$ProfileDir（用 -Profile 指定名字，或 -ProfileDir 直接给路径）"
}
$pkgPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) {
  throw "找不到 $pkgPath —— 这个 profile 里没有 package.json"
}

Say "profile : $ProfileDir"
Say "mode    : $(if ($Apply) { 'APPLY（会改文件）' } else { 'DryRun（只打印）' })"

$raw = [IO.File]::ReadAllText($pkgPath)
$pkg = $raw | ConvertFrom-Json
if (-not $pkg -or -not $pkg.PSObject.Properties['name']) {
  throw "package.json 解析失败：$pkgPath"
}
Say "profile pkg: $($pkg.name)"

$oldName = 'dsh-job-board'
$newName = '@wfcj/dsh-job-board'
$actions = New-Object System.Collections.Generic.List[string]

# 1) dependencies
$deps = $null
if ($pkg.PSObject.Properties['dependencies']) { $deps = $pkg.dependencies }
$hasDep = $deps -and $deps.PSObject.Properties[$oldName]
if ($hasDep) { $actions.Add("dependencies 去掉 $oldName（现值：$($deps.$oldName)）") }

# 2) dsh.profile.bundles
$bundles = $null
if ($pkg.PSObject.Properties['dsh'] -and $pkg.dsh -and $pkg.dsh.PSObject.Properties['profile'] -and $pkg.dsh.profile) {
  if ($pkg.dsh.profile.PSObject.Properties['bundles']) { $bundles = $pkg.dsh.profile.bundles }
}
$bundleIdx = -1
if ($bundles) {
  for ($i = 0; $i -lt @($bundles).Count; $i++) {
    if ([string](@($bundles)[$i]) -eq $oldName) { $bundleIdx = $i; break }
  }
}
if ($bundleIdx -ge 0) { $actions.Add("dsh.profile.bundles 去掉第 $($bundleIdx + 1) 项 $oldName") }

# 3) node_modules 目录
$oldDir = Join-Path $ProfileDir 'node_modules\dsh-job-board'
$hasDir = Test-Path -LiteralPath $oldDir
if ($hasDir) { $actions.Add("node_modules\$oldName 改名备份（目录存在）") }

# 顺带体检：新包是否在位
$newPkg = Join-Path $ProfileDir 'node_modules\@wfcj\dsh-job-board\package.json'
$newVer = $null
if (Test-Path -LiteralPath $newPkg) {
  try { $newVer = (Get-Content -LiteralPath $newPkg -Raw | ConvertFrom-Json).version } catch { $newVer = '?' }
}

Say ''
if ($actions.Count -eq 0) {
  Say '没有发现旧包残留，无需清理。'
  if ($newVer) { Say "当前新包版本：$newName@$newVer" } else { Warn "新包不在位：$newName 未装在 $ProfileDir" }
  return
}

Say '将执行：'
$i = 0
foreach ($a in $actions) { $i++; Say "  $i) $a" }

if (-not $Apply) {
  Say ''
  Say '这是 DryRun。确认无误后加 -Apply 真正执行。'
  return
}

# 备份 + 写回
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$pkgPath.bak-oldpkg-$stamp"
Copy-Item -LiteralPath $pkgPath -Destination $bak -Force
Say ''
Say "已备份 package.json -> $bak"

if ($hasDep) {
  $pkg.dependencies.PSObject.Properties.Remove($oldName) | Out-Null
}
if ($bundleIdx -ge 0) {
  $list = @(@($bundles) | Where-Object { [string]$_ -ne $oldName })
  $pkg.dsh.profile.bundles = $list
}

$json = $pkg | ConvertTo-Json -Depth 20
# 保持 LF，避免仓库/工具的 CRLF 归一化检查报错
[IO.File]::WriteAllText($pkgPath, ($json -replace "`r`n", "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
Say "已写回 package.json"

if ($hasDir) {
  $dirBak = "$oldDir.bak-$stamp"
  Move-Item -LiteralPath $oldDir -Destination $dirBak
  Say "已把旧包目录改名为：$dirBak（确认无影响后可自行删除）"
}

Say ''
if ($newVer) { Say "新包在位：$newName@$newVer" } else { Warn "新包不在位，清完旧包后请重新安装：plugin add '$newName'" }
Say '请重启 DSH —— 旧实例的路由只有重启才会释放（热重载会报 duplicate exact route）。'
