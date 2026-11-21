<#
  install-agent-worker.ps1 —— 把 dsh-job-board 升到指定版本，并在该机 profile 的
  `- id: team` 行里补上 agent 派工所需的最小配置（幂等，可重复跑）。

  为什么要它：agent 派工要三件事同时成立 ——
    ① 插件 ≥ v2.6.14（组合包补丁的 inject 必须含 agentLoop / sessions）；
    ② profile 里 `team` 行的 **config 内部** worker 配置含 agentEnabled / agentPreset /
       agentCwdRoot / agentAllowlist（这些键不在「存档兜底」名单里，只能写在 profile patch）；
    ③ 重启 DSH 后新代码与新配置才生效。

  注意 worker: 的正确位置是 **config 里面**，与 boardUrl / machine / token 同级；
  写成 config 的兄弟键不会被 pick() 读到（v2.6.25 修正，旧版脚本位置写错过）。

  用法（在目标机器上跑）：
    pwsh -NoProfile -ExecutionPolicy Bypass -File <本文件> `
      -ProfileDir C:\Users\17827\.dsh\profiles\desktop -CwdRoot C:\Users\17827\Documents
  先加 -DryRun 看它准备改成什么，确认后再真跑。
#>
param(
  [string]$ProfileDir = '',
  [string]$Tarball = 'L:\云盘\gp_video_xfer\_tools\dsh-job-board\wfcj-dsh-job-board-2.7.0.tgz',
  [string]$CwdRoot = '',
  [string]$Preset = 'standard',
  [string]$GoalPrefix = '只回答',
  [ValidateSet('confirm', 'auto')][string]$Approval = 'confirm',
  [int]$BudgetPerDay = 20,
  [switch]$SkipPackage,
  [switch]$SkipConfig,
  [switch]$DryRun,
  [switch]$StopDsh,
  [switch]$AllowRunning
)

$ErrorActionPreference = 'Stop'

function Say($msg) { Write-Host $msg }
function Warn($msg) { Write-Host ($msg) -ForegroundColor Yellow }
function Die($msg) { Write-Host ("ERROR: " + $msg) -ForegroundColor Red; exit 1 }

function Resolve-Profile {
  param([string]$Given)
  if ($Given) {
    if (-not (Test-Path -LiteralPath $Given)) { Die "profile 目录不存在：$Given" }
    return (Resolve-Path -LiteralPath $Given).Path
  }
  $root = Join-Path $env:USERPROFILE '.dsh\profiles'
  if (-not (Test-Path -LiteralPath $root)) { Die "找不到 $root，请用 -ProfileDir 指定" }
  $hits = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {
      $pj = Join-Path $_.FullName 'node_modules\@wfcj\dsh-job-board\package.json'
      $cp = Join-Path $_.FullName 'cordis.patch.yml'
      (Test-Path -LiteralPath $pj) -or ((Test-Path -LiteralPath $cp) -and (Select-String -LiteralPath $cp -Pattern 'dsh-job-board' -Quiet))
    })
  if ($hits.Count -eq 0) { Die "在 $root 下没找到装了 dsh-job-board 的 profile，请用 -ProfileDir 指定" }
  if ($hits.Count -gt 1) { Die ("找到多个 profile：" + (($hits | ForEach-Object { $_.Name }) -join ', ') + "，请用 -ProfileDir 指定一个") }
  Say ("自动识别 profile：{0}" -f $hits[0].FullName)
  return $hits[0].FullName
}

$ProfileDir = Resolve-Profile $ProfileDir
if (-not $CwdRoot) {
  $cand = Join-Path $env:USERPROFILE 'Documents'
  if (Test-Path -LiteralPath $cand) { $CwdRoot = $cand; Say ("未给 -CwdRoot，默认用 {0}" -f $cand) }
}
if ($Tarball -match '^https?://') {
  $dl = Join-Path $env:TEMP ('jb-' + [IO.Path]::GetFileName(([uri]$Tarball).AbsolutePath))
  Say ("下载 {0}" -f $Tarball)
  Invoke-WebRequest -Uri $Tarball -OutFile $dl -UseBasicParsing -TimeoutSec 300
  $Tarball = $dl
}
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not $SkipConfig -and -not (Test-Path -LiteralPath $patchPath)) { Die "找不到 $patchPath" }

# ── 1. 装包（v2.7.3：原子切换 + 校验 + 安装清单）────────────────────────────
# 为什么改（2026-11-21 GT14 起不来）：旧实现是 robocopy 覆盖**正在运行的**安装目录，
# 既不原子也不校验。只要有一个文件没覆盖成功（占用/杀软/中断），就会留下
# 「新 lib/index.js + 旧 lib/dispatch-filter.js」的混合树 —— ESM 链接期直接抛
# "does not provide an export named ..."，用户看到的是 DSH 起不来。
# 现在：解到暂存目录 → 校验（版本/文件数/node --check/关键文件）→ 写清单 → 换名切换，
# 装完再复核一遍，任何一步失败自动回滚到旧目录。
$instDir = Join-Path $ProfileDir 'node_modules\@wfcj\dsh-job-board'
if (-not $SkipPackage) {
  if (-not (Test-Path -LiteralPath $Tarball)) { Die "包不存在：$Tarball" }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $parent = Split-Path -Parent $instDir
  $stage  = Join-Path $parent ('.stage-' + $stamp)
  $bakDir = "$instDir.bak-$stamp"
  $tmp    = Join-Path $env:TEMP ("dsh-jb-" + $stamp)

  Say "解包 $Tarball → $tmp"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  if ($Tarball -like '*.zip') {
    Expand-Archive -LiteralPath $Tarball -DestinationPath $tmp -Force
  } else {
    & tar -xzf $Tarball -C $tmp
    if ($LASTEXITCODE -ne 0) { Die "tar 解包失败（exit=$LASTEXITCODE）" }
  }
  $srcPkg = Join-Path $tmp 'package'
  if (-not (Test-Path -LiteralPath (Join-Path $srcPkg 'package.json'))) {
    if (Test-Path -LiteralPath (Join-Path $tmp 'package.json')) { $srcPkg = $tmp }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $srcPkg 'package.json'))) { Die "包里没有 package.json（既不在 package/ 也不在根）" }
  $newVer = (Get-Content -LiteralPath (Join-Path $srcPkg 'package.json') -Raw | ConvertFrom-Json).version
  $srcFiles = @(Get-ChildItem -LiteralPath $srcPkg -Recurse -File)
  Say ("包内容：v{0}，{1} 个文件" -f $newVer, $srcFiles.Count)
  foreach ($rel in @('lib\index.js','lib\client.js','lib\worker\version.js','package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $srcPkg $rel))) { Die "包不完整：缺 $rel" }
  }
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeExe) {
    foreach ($rel in @('lib\index.js','lib\client.js','lib\install-manifest.js')) {
      $fp = Join-Path $srcPkg $rel
      if (-not (Test-Path -LiteralPath $fp)) { continue }
      & $nodeExe --check $fp 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Die "包里 $rel 语法检查未通过（打包有问题，先别装）" }
    }
    Say "包语法检查：OK"
  } else { Warn '没找到 node，跳过包语法检查' }

  $running = @(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    if ($StopDsh) {
      Say ("检测到 DSH 在运行（pid {0}），先停掉再装（装完由调用方重启）" -f ((($running | ForEach-Object { $_.Id }) -join ',')))
      $running | Stop-Process -Force -ErrorAction SilentlyContinue
      for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (-not (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break } }
    } else {
      Warn 'DSH 正在运行：覆盖安装可能因文件占用而只装一半（2.7.2 事故原因）。'
      Warn '建议先关掉 DSH，或给本脚本加 -StopDsh（会代停，装完需自己重启）。'
      if (-not $AllowRunning) { Die '已阻止覆盖安装。确认要冒险请加 -AllowRunning' }
    }
  }

  if ($DryRun) {
    Say ("[dry] 会把 v{0} 安装到 {1}（暂存 {2}，旧目录备份 {3}）" -f $newVer, $instDir, $stage, $bakDir)
    try { [IO.Directory]::Delete($tmp, $true) } catch { }
    return
  }

  # 1) 复制到暂存目录（不碰正在使用的安装目录）
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  & robocopy $srcPkg $stage /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "复制到暂存目录失败（robocopy exit=$LASTEXITCODE）" }
  $staged = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
  if ($staged.Count -ne $srcFiles.Count) { Die ("暂存目录文件数不符（{0} != {1}），放弃安装" -f $staged.Count, $srcFiles.Count) }

  # 2) 写安装清单（版本 + 每个文件的字节数与 sha256）
  $entries = foreach ($f in $staged) {
    $rel = $f.FullName.Substring($stage.Length + 1) -replace '\\', '/'
    [pscustomobject]@{ path = $rel; bytes = $f.Length; sha256 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower() }
  }
  $manifest = [pscustomobject]@{
    version     = $newVer
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    files       = @($entries | Sort-Object path)
  }
  $manifestPath = Join-Path $stage 'install-manifest.json'
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  Say ("安装清单已写：{0} 个文件" -f $entries.Count)

  # 3) 原子切换：旧目录换名 → 暂存目录换名就位
  if (Test-Path -LiteralPath $instDir) {
    Move-Item -LiteralPath $instDir -Destination $bakDir -Force
    Say ("旧安装已备份：{0}" -f $bakDir)
  }
  try {
    Move-Item -LiteralPath $stage -Destination $instDir -Force
  } catch {
    if ((Test-Path -LiteralPath $bakDir) -and -not (Test-Path -LiteralPath $instDir)) { Move-Item -LiteralPath $bakDir -Destination $instDir -Force }
    Die ("切换安装目录失败：{0}（已尝试回滚）" -f $_.Exception.Message)
  }

  # 4) 装完复核：版本 + 文件数 + 关键文件在
  $gotVer = ''
  try { $gotVer = (Get-Content -LiteralPath (Join-Path $instDir 'package.json') -Raw | ConvertFrom-Json).version } catch { }
  $gotVerJs = ''
  try { $gotVerJs = (Select-String -LiteralPath (Join-Path $instDir 'lib\worker\version.js') -Pattern "VERSION\s*=\s*'([^']+)'" | Select-Object -First 1).Matches.Groups[1].Value } catch { }
  $gotFiles = @(Get-ChildItem -LiteralPath $instDir -Recurse -File)
  $bad = @()
  if ($gotVer -ne $newVer) { $bad += "package.json=$gotVer（期望 $newVer）" }
  if ($gotVerJs -and $gotVerJs -ne $newVer) { $bad += "lib/worker/version.js=$gotVerJs（期望 $newVer）" }
  if ($gotFiles.Count -ne ($srcFiles.Count + 1)) { $bad += "文件数=$($gotFiles.Count)（期望 $($srcFiles.Count + 1)，含 install-manifest.json）" }
  foreach ($rel in @('lib\index.js','lib\client.js','lib\worker\version.js','install-manifest.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $instDir $rel))) { $bad += "缺 $rel" }
  }
  if ($bad.Count -gt 0) {
    try { Remove-Item -LiteralPath $instDir -Recurse -Force } catch { }
    if (Test-Path -LiteralPath $bakDir) { Move-Item -LiteralPath $bakDir -Destination $instDir -Force }
    Die ("安装复核不通过：{0}；已回滚" -f ($bad -join '；'))
  }
  Say ("已安装 v{0} → {1}（{2} 文件，复核通过）" -f $gotVer, $instDir, $gotFiles.Count)
  try { [IO.Directory]::Delete($tmp, $true) } catch { }
}
if ($tmp -and (Test-Path -LiteralPath $tmp)) { try { [IO.Directory]::Delete($tmp, $true) } catch { } }
function Write-CfgLog($msg) {
  try {
    $f = "$patchPath.cfglog"
    [IO.File]::AppendAllText($f, ("[{0}] {1}`n" -f (Get-Date -Format 'HH:mm:ss'), $msg), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
# ── 2. 改配置（交给 patch-config.ps1：位置/内联/去重/只补缺失键都在那里统一处理）──
if (-not $SkipConfig) {
  $modPath = Join-Path $PSScriptRoot 'patch-config.ps1'
  if (-not (Test-Path -LiteralPath $modPath)) { Die "缺 patch-config.ps1（应与 install-agent-worker.ps1 同目录）" }
  . $modPath

  $vals = [ordered]@{
    agentEnabled         = 'true'
    agentPreset          = $Preset
    agentApproval        = $Approval
    agentBudgetMaxPerDay = [string]$BudgetPerDay
  }
  if ($CwdRoot) { $vals['agentCwdRoot'] = $CwdRoot }

  try {
    $r = Update-BoardWorkerConfig -PatchPath $patchPath -Values $vals `
      -ScalarKeys @('agentEnabled', 'agentBudgetMaxPerDay', 'pollMs', 'autoDispatch') `
      -AllowlistIds @('dispatch-smoke') -GoalPrefix $GoalPrefix -DryRun:$DryRun
  } catch {
    Die ("改配置失败：{0}" -f $_.Exception.Message)
  }
  foreach ($n in $r.Notes) { Say $n }
  if (-not $r.Changed) {
    Say '配置无需改动。'
  } elseif ($DryRun) {
    Say '── [dry] team 块将变成 ──'
    $r.Lines | ForEach-Object { Say ('  ' + $_) }
  } else {
    Say ("已写回 {0}（备份 {1}）" -f $patchPath, $r.BackupPath)
  }
}
# ── 3. 收尾提示 ────────────────────────────────────────────────────────────
Say ''
Say '下一步：'
Say '  1) 重启 DSH（配置与插件代码都只在启动时加载）；'
Say '  2) 复查：GET http://127.0.0.1:<webPort>/api/board/ui/doctor —— version 应为新版；'
Say '  3) 在主控机派一条窄任务验证 agent：mode=agent、goal 只回答 1+1、且命中 agentAllowlist 前缀；'
Say '  4) 若被拦，按 note 里的 reason 对照 ERROR 表（见 agent-dispatch-report.md）。'
