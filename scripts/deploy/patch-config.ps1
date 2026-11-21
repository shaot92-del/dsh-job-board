#requires -Version 7.0
<#
  patch-config.ps1 — 把 worker 配置安全地写进 cordis.patch.yml 的 team.config 内。
  设计目标（每一类都对应一次真实翻车）：
    1. worker 写错位置（config 兄弟键）→ 搬进 config
    2. worker: {} / worker: {k: v} 内联写法 → 展开成多行块
    3. 重复的 worker 行 / 重复子键 → 只保留一份
    4. 没有 config: 行 → 在 team 块内补一个
    5. 只插入缺失键；已有键（含用户手改的值）一律不动
    6. 写盘前留 .bak-agent-<ts>；写出 LF + UTF-8 无 BOM
  返回 [pscustomobject]@{ Changed; Lines; Notes; BackupPath }
#>

function Get-Indent([string]$s) { ([regex]::Match($s, '^(\s*)')).Groups[1].Value }

function Split-InlineMap([string]$inline) {
  # "{ k: v, k2: 'x, y' }" → @([pscustomobject]@{Key='k';Value='v'}, ...)
  $inner = $inline.Trim()
  if ($inner.StartsWith('{')) { $inner = $inner.Substring(1) }
  if ($inner.EndsWith('}')) { $inner = $inner.Substring(0, $inner.Length - 1) }
  $inner = $inner.Trim()
  $out = New-Object System.Collections.Generic.List[object]
  if (-not $inner) { return $out }
  $parts = [regex]::Split($inner, ',(?=\s*[A-Za-z_][A-Za-z0-9_-]*\s*:)')
  foreach ($p in $parts) {
    if (-not $p.Trim()) { continue }
    $m = [regex]::Match($p.Trim(), '^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$')
    if (-not $m.Success) { throw "内联 map 里这一项解析不了：$($p.Trim())" }
    $out.Add([pscustomobject]@{ Key = $m.Groups[1].Value; Value = $m.Groups[2].Value.Trim() })
  }
  return $out
}

function Update-BoardWorkerConfig {
  param(
    [Parameter(Mandatory)][string]$PatchPath,
    [Parameter(Mandatory)][hashtable]$Values,      # 键 → 值（字符串原样写，标量不加引号）
    [string[]]$ScalarKeys = @('agentEnabled', 'agentBudgetMaxPerDay', 'pollMs', 'autoDispatch'),
    [string[]]$AllowlistIds = @('dispatch-smoke'),
    [string]$GoalPrefix = '只回答',
    [switch]$DryRun
  )

  $notes = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $PatchPath)) { throw "找不到 $PatchPath" }
  $raw = [IO.File]::ReadAllText($PatchPath)
  $lines = New-Object System.Collections.Generic.List[string]
  ($raw -replace "`r`n", "`n").Split("`n") | ForEach-Object { $lines.Add($_) }
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }

  # ── 找 team 块 ─────────────────────────────────────────────────────────
  $teamIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*-\s*id:\s*team\s*$') { $teamIdx = $i; break } }
  if ($teamIdx -lt 0) { throw "$PatchPath 里没有 `- id: team` 行" }
  $endIdx = $lines.Count - 1
  for ($j = $teamIdx + 1; $j -lt $lines.Count; $j++) { if ($lines[$j] -match '^- ') { $endIdx = $j - 1; break } }
  $block = New-Object System.Collections.Generic.List[string]
  for ($k = $teamIdx; $k -le $endIdx; $k++) { $block.Add($lines[$k]) }

  $teamIndent = Get-Indent $block[0]
  $keyIndent = $teamIndent + '  '

  # ── 找 config:（没有就补）──────────────────────────────────────────────
  $cfgIdx = -1
  for ($k = 0; $k -lt $block.Count; $k++) { if ($block[$k] -match '^(\s+)config:\s*$') { $cfgIdx = $k; break } }
  if ($cfgIdx -lt 0) {
    $block.Insert(1, $keyIndent + 'config:')
    $cfgIdx = 1
    $notes.Add('add: config:（team 块内原来没有）')
  }
  $cfgIndent = Get-Indent $block[$cfgIdx]
  $childIndent = $cfgIndent + '  '

  # ── 收集已有 worker 的键值（含内联写法），并把所有 worker 相关行删掉 ──
  $existing = [ordered]@{}
  $drop = New-Object System.Collections.Generic.List[int]
  for ($k = 0; $k -lt $block.Count; $k++) {
    if ($k -eq $cfgIdx) { continue }
    $mw = [regex]::Match($block[$k], '^(\s+)worker:\s*(.*)$')
    if (-not $mw.Success) { continue }
    $drop.Add($k)
    $inline = $mw.Groups[2].Value.Trim()
    if ($inline) {
      if ($inline -ne '{}') {
        foreach ($kv in (Split-InlineMap $inline)) { if (-not $existing.Contains($kv.Key)) { $existing[$kv.Key] = $kv.Value } }
      }
      continue
    }
    # 多行块：往下吃子行
    $wm = $mw.Groups[1].Value
    for ($q = $k + 1; $q -lt $block.Count; $q++) {
      $ln = $block[$q]
      if ([string]::IsNullOrWhiteSpace($ln)) { break }
      $ind = Get-Indent $ln
      if ($ind.Length -le $wm.Length) { break }
      $drop.Add($q)
      $mk = [regex]::Match($ln, '^(\s+)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$')
      if ($mk.Success -and -not $existing.Contains($mk.Groups[2].Value)) { $existing[$mk.Groups[2].Value] = $mk.Groups[3].Value.Trim() }
    }
  }
  for ($i = $drop.Count - 1; $i -ge 0; $i--) { $block.RemoveAt($drop[$i]) }

  # ── 合并：只补缺失键 ──────────────────────────────────────────────────
  $merged = New-Object System.Collections.Generic.List[object]
  foreach ($k in $existing.Keys) { $merged.Add([pscustomobject]@{ Key = $k; Value = $existing[$k] }) }
  foreach ($k in $Values.Keys) {
    $hv = $false
    foreach ($m in $merged) { if ($m.Key -eq $k) { $hv = $true; break } }
    if ($hv) { $notes.Add("skip: $k（已存在，保留现值）"); continue }
    $v = [string]$Values[$k]
    if ($k -eq 'agentCwdRoot' -and -not $v) { $notes.Add('skip: agentCwdRoot（没给值）'); continue }
    if ($ScalarKeys -contains $k) { $merged.Add([pscustomobject]@{ Key = $k; Value = $v }) }
    else { $merged.Add([pscustomobject]@{ Key = $k; Value = "'" + $v + "'" }) }
    $notes.Add("add: $k = $v")
  }
  $hasAllow = $false
  foreach ($m in $merged) { if ($m.Key -eq 'agentAllowlist') { $hasAllow = $true } }
  if (-not $hasAllow) {
    $merged.Add([pscustomobject]@{ Key = '__allowlist__'; Value = '' })
    $notes.Add("add: agentAllowlist = [$($AllowlistIds -join ', ')]（goalPrefix=$GoalPrefix）")
  } else { $notes.Add('skip: agentAllowlist（已存在，保持原样；空列表=全拒）') }

  # ── 重建 config 子树：config: 行 + 其它既有子键（worker 之外）+ 新 worker 块 ──
  $cfgChildren = New-Object System.Collections.Generic.List[string]
  for ($k = $cfgIdx + 1; $k -lt $block.Count; $k++) {
    $ln = $block[$k]
    if ([string]::IsNullOrWhiteSpace($ln)) { continue }
    if ((Get-Indent $ln).Length -le $cfgIndent.Length) { break }
    $cfgChildren.Add($ln)
  }
  # 保留原顺序：把 worker 块放最后（先 remove 再 append）
  $body = New-Object System.Collections.Generic.List[string]
  for ($k = 0; $k -le $cfgIdx; $k++) { $body.Add($block[$k]) }
  foreach ($c in $cfgChildren) { $body.Add($c) }
  for ($k = $cfgIdx + 1; $k -lt $block.Count; $k++) {
    $ln = $block[$k]
    if ([string]::IsNullOrWhiteSpace($ln)) { continue }
    if ((Get-Indent $ln).Length -le $cfgIndent.Length) { $body.Add($ln) }
  }
  $body.Add($childIndent + 'worker:')
  foreach ($m in $merged) {
    if ($m.Key -eq '__allowlist__') {
      $body.Add($childIndent + '  agentAllowlist:')
      foreach ($id in $AllowlistIds) { $body.Add($childIndent + '    - id: ' + $id) }
      $body.Add($childIndent + "      goalPrefix: '" + $GoalPrefix + "'")
    } else {
      $body.Add($childIndent + '  ' + $m.Key + ': ' + $m.Value)
    }
  }

  $changed = -not (($block -join "`n") -eq ($body -join "`n"))
  $outLines = New-Object System.Collections.Generic.List[string]
  for ($k = 0; $k -lt $teamIdx; $k++) { $outLines.Add($lines[$k]) }
  foreach ($b in $body) { $outLines.Add($b) }
  for ($k = $endIdx + 1; $k -lt $lines.Count; $k++) { $outLines.Add($lines[$k]) }

  $backup = $null
  if ($changed -and -not $DryRun) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$PatchPath.bak-agent-$stamp"
    Copy-Item -LiteralPath $PatchPath -Destination $backup -Force
    [IO.File]::WriteAllText($PatchPath, (($outLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  }
  return [pscustomobject]@{ Changed = $changed; Lines = $body; Notes = $notes; BackupPath = $backup }
}
