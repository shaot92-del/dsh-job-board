#
# 给副机 profile 补 agent-default-model —— 让远程 agent 会话走「登录令牌」路由。
#
# 症状：板上 agent 任务 1 秒内 failed，note 里是
#   llm-deepseek: no API key for provider route "deepseek-official"
# 原因：副机 profile 没有默认模型，createAgent() 落到 DSH 缺省路由 deepseek-official，
#       它要 DEEPSEEK_API_KEY；而副机只有 deepseek-account-platform 的登录令牌。
#
# 幂等：已有 `agent-default-model` 段则直接退出。
#
param(
  [string]$Provider = 'deepseek-account',
  [string]$Model = 'deepseek-flash',
  [string]$Effort = 'max',
  [string]$PatchPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $PatchPath) {
  $PatchPath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
}

if (-not (Test-Path -LiteralPath $PatchPath)) {
  Write-Host ("MISSING {0}" -f $PatchPath)
  Write-Host '提示：先在这台机器上装好 DSH profile（dsh web 起过一次就会有）。'
  exit 1
}

$src = Get-Content -LiteralPath $PatchPath -Raw -Encoding utf8
if ($src -match '(?m)^\s*-\s*id:\s*agent-default-model\s*$') {
  Write-Host 'ALREADY patched (agent-default-model exists)'
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$PatchPath.bak-$stamp"
Copy-Item -LiteralPath $PatchPath -Destination $bak -Force

$block = @"

# --- added by scripts/worker-patches/fix-agent-model.ps1 on $(Get-Date -Format 'yyyy-MM-dd') ---
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: $Provider
    model: $Model
    reasoningEffort: $Effort
"@

$newText = $src.TrimEnd() + "`r`n" + $block + "`r`n"
[IO.File]::WriteAllText($PatchPath, $newText, (New-Object Text.UTF8Encoding($false)))

Write-Host ("PATCHED {0}" -f $PatchPath)
Write-Host ("backup   {0}" -f (Split-Path $bak -Leaf))
Write-Host '--- tail ---'
Get-Content -LiteralPath $PatchPath -Tail 9
Write-Host '重启 DSH 后生效（restart-dsh.ps1）。'
