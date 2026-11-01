#
# 让 remote-agent 的节点客户端在遇到 duplicate-node 类错误时“重连”而不是“停机”。
#
# 症状：副机明明在跑、看板 last_seen 正常，但主机 dispatcher 一直
#   dispatch skip ...: 没有匹配的在线节点（要 MB14）
# 原因：lib/node/transport.js 收到 duplicate-node / node-id-invalid /
#       unauthorized / revoked 会 this.stop()，stop() 之后 scheduleReconnect()
#       直接返回 —— 永久失联，只能人工重启副机。
#       而重启瞬间旧会话还挂在中继上，新进程就会被判 duplicate-node（重启即失联）。
#
# 改法：销毁旧连接 + 退避重连（scheduleReconnect 自带 60s 上限），
#       等中继回收旧会话后自动恢复。
#
# 幂等：文件里已有 [dsh-retry-patch] 标记则直接退出。
#
param(
  [string]$TransportPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $TransportPath) {
  $TransportPath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-remote-agent\lib\node\transport.js'
}

if (-not (Test-Path -LiteralPath $TransportPath)) {
  Write-Host ("MISSING {0}" -f $TransportPath)
  exit 1
}

$src = Get-Content -LiteralPath $TransportPath -Raw -Encoding utf8
if ($src.Contains('[dsh-retry-patch]')) {
  Write-Host 'ALREADY patched'
  exit 0
}

$marker = "if (code === 'duplicate-node' || code === 'node-id-invalid' || code === 'unauthorized' || code === 'revoked')"
$idx = $src.IndexOf($marker)
if ($idx -lt 0) {
  Write-Host 'ANCHOR not found —— transport.js 的 fatal-code 分支和预期不同，请人工确认后改脚本'
  exit 1
}

$stopCall = $src.IndexOf('this.stop()', $idx)
if ($stopCall -lt 0) {
  Write-Host 'ANCHOR not found —— 分支里没有 this.stop()'
  exit 1
}

$closeBrace = $src.IndexOf('}', $stopCall)
if ($closeBrace -lt 0) {
  Write-Host 'ANCHOR not found —— 找不到分支结束的 }'
  exit 1
}

# 保留原文件的缩进与换行风格
$lineStart = $src.LastIndexOf("`n", $idx) + 1
$indent = $src.Substring($lineStart, $idx - $lineStart)
$nl = if ($src.Contains("`r`n")) { "`r`n" } else { "`n" }
$lineEnd = $src.IndexOf("`n", $idx)
$ifLine = $src.Substring($idx, $lineEnd - $idx).TrimEnd("`r")

$inner = "$indent  "
$body = @(
  "$inner// [dsh-retry-patch] 这类错误在重启瞬间是常态（旧会话还没被 hub 判掉）。",
  "$inner// 原来直接 stop() 等于：副机重启一次就永久失联，只能人工再重启一次。",
  "$inner// 改为销毁当前连接 + 退避重连（scheduleReconnect 上限 60s），旧会话被回收后自动恢复。",
  "$inner" + "try { if (this.conn && !this.conn.closed) this.conn.destroy(new Error('relay error: ' + code)) } catch { /* ignore */ }",
  "$inner" + 'this.conn = undefined',
  "$inner" + 'this.online = false',
  "$inner" + 'this.scheduleReconnect()'
) -join $nl

$newBlock = $ifLine + $nl + $body + $nl + $indent + '}'

Copy-Item -LiteralPath $TransportPath -Destination ($TransportPath + '.bak-retry-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
$patched = $src.Substring(0, $idx) + $newBlock + $src.Substring($closeBrace + 1)
[IO.File]::WriteAllText($TransportPath, $patched, (New-Object Text.UTF8Encoding($false)))
Write-Host ("PATCHED {0} ({1} -> {2} chars)" -f $TransportPath, $src.Length, $patched.Length)

$node = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if ($node) {
  $tmp = Join-Path $env:TEMP ('check-transport-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.mjs')
  Copy-Item -LiteralPath $TransportPath -Destination $tmp -Force
  & $node --check $tmp 2>&1 | ForEach-Object { Write-Host ("check: {0}" -f $_) }
  Write-Host ("check-exit={0}" -f $LASTEXITCODE)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
} else {
  Write-Host 'no node found —— 跳过语法校验'
}

Write-Host '重启 DSH 后生效（restart-dsh.ps1）。'
