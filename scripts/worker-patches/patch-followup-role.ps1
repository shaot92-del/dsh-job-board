#
# 修 dsh-remote-agent 投递任务书时缺 role 的问题。
#
# 症状（补了 agent-default-model 之后才会暴露）：
#   远程 failed：{"turn":1,"step":1,"error":{"message":"DeepSeek Messages transport failed",
#                 "code":"TRANSPORT","name":"LlmError"}}
# 真相：runner.js 用 agent.followup({ content, source }) 投递任务书，没给 role/id。
#       该消息被原样 append 成 user/message 事件，历史里出现无角色条目，
#       dsh-llm-deepseek 的 serialize() 在 previous.content 上抛
#       TypeError: Cannot read properties of undefined (reading 'content')，
#       再被 generate() 包成 TRANSPORT —— 请求根本没出网。
#
# 幂等：文件里已有 __dsh_followup_role_fix__ 标记则直接退出。
#
param(
  [string]$RunnerPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RunnerPath) {
  $RunnerPath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-remote-agent\lib\node\runner.js'
}

if (-not (Test-Path -LiteralPath $RunnerPath)) {
  Write-Host ("MISSING {0}" -f $RunnerPath)
  Write-Host '提示：副机要先装好 dsh-remote-agent（worker 角色）。'
  exit 1
}

$src = Get-Content -LiteralPath $RunnerPath -Raw -Encoding utf8
if ($src.Contains('__dsh_followup_role_fix__')) {
  Write-Host 'ALREADY patched'
  exit 0
}

$old = @'
      agent.followup({
        content: [{ type: 'text', text: goal }],
        source: PLUGIN_SOURCE,
      })
'@

$new = @'
      // __dsh_followup_role_fix__
      // agent-loop 会把 inbox 消息原样 append 成 user/message；缺 role 的条目会让
      // llm-deepseek 的 serialize() 在 previous.content 上抛 TypeError（被包成 TRANSPORT）。
      // 这里补齐与 createUserMessage 一致的字段：id / role / content / source。
      agent.followup({
        id: process.getBuiltinModule('node:crypto').randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: goal }],
        source: PLUGIN_SOURCE,
      })
'@

$oldCrlf = $old -replace "`n", "`r`n"
if ($src.Contains($old)) {
  $patched = $src.Replace($old, $new)
} elseif ($src.Contains($oldCrlf)) {
  $patched = $src.Replace($oldCrlf, ($new -replace "`n", "`r`n"))
} else {
  Write-Host 'ANCHOR not found —— runner.js 的 followup 调用和预期不同，请人工确认后改脚本'
  exit 1
}

Copy-Item -LiteralPath $RunnerPath -Destination ($RunnerPath + '.bak-followuprole') -Force
[IO.File]::WriteAllText($RunnerPath, $patched, (New-Object Text.UTF8Encoding($false)))
Write-Host ("PATCHED {0}" -f $RunnerPath)

# 语法校验：用 DSH 自带的 node，找不到再退回 PATH 里的
$node = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if ($node) {
  $tmp = Join-Path $env:TEMP ('check-followuprole-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.mjs')
  Copy-Item -LiteralPath $RunnerPath -Destination $tmp -Force
  & $node --check $tmp 2>&1 | ForEach-Object { Write-Host ("check: {0}" -f $_) }
  Write-Host ("check-exit={0}" -f $LASTEXITCODE)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
} else {
  Write-Host 'no node found —— 跳过语法校验'
}

Write-Host '重启 DSH 后生效（restart-dsh.ps1）。'
