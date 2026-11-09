param(
    [string]$TargetRoot = 'L:\云盘\gp_video_xfer\_tools',
    [string]$SourceRoot = '',
    [int]$Port = 8965,
    [string]$Bind = '0.0.0.0',
    [string]$TokenFile = (Join-Path $env:USERPROFILE '.dsh\board-tokens.txt'),
    [switch]$OnlyCheck,
    [switch]$DryRun
)

# 作业板部署/重启/自检一体化（v1.4.0）。
#
# 以前 board_server.py 只活在共享盘：没有版本历史、没有测试，改完靠手抄，
# 线上跑没跑上新代码只能靠 probe 猜（v1.3.11 就这样误报过一次"已生效"）。
# 现在源码在仓库 tools/board_server.py，这个脚本负责把它搬到目标机并真正拉起。
#
# 用法：
#   pwsh -File scripts/install-board.ps1                # 部署到本机 L: 并重启
#   pwsh -File scripts/install-board.ps1 -DryRun        # 只打印计划
#   pwsh -File scripts/install-board.ps1 -OnlyCheck      # 不部署，只自检当前进程
#   pwsh -File scripts/install-board.ps1 -TargetRoot Z:\_tools   # 副机上跑
#
# 退出码：0 成功；2 源文件缺失；3 读不到 token；4 停旧进程失败；5 新进程没起来/自检不过。

$ErrorActionPreference = 'Stop'

function Say([string]$Msg) { Write-Host $Msg }

if (-not $SourceRoot) {
    $SourceRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'tools'
}
$Source = Join-Path $SourceRoot 'board_server.py'
$Target = Join-Path $TargetRoot 'board_server.py'
$BoardDir = Join-Path (Split-Path $TargetRoot -Parent) '_board'
$LogFile = Join-Path $BoardDir 'install-board.log'
$StatePath = Join-Path $BoardDir 'state.json'
$LockFile = "$StatePath.$Port.lock"
$HealthUrl = "http://127.0.0.1:$Port/api/health"

function Write-Log([string]$Msg) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $Msg
    try {
        if (-not (Test-Path -LiteralPath $BoardDir)) { New-Item -ItemType Directory -Force -Path $BoardDir | Out-Null }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Get-BoardTokens {
    if (-not (Test-Path -LiteralPath $TokenFile)) { return @() }
    return @(Get-Content -LiteralPath $TokenFile -ErrorAction Stop |
        ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
}

function Get-Py {
    $c = @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'),
        (Join-Path $TargetRoot 'python\python.exe')
    )
    foreach ($p in $c) { if (Test-Path -LiteralPath $p) { return $p } }
    $g = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($g -and $g.Source -notlike '*WindowsApps*') { return $g.Source }
    return $null
}

function Invoke-Health([string]$Token) {
    $headers = @{}
    if ($Token) { $headers['x-board-token'] = $Token }
    try {
        return Invoke-RestMethod -Uri $HealthUrl -Headers $headers -TimeoutSec 5
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
            return [pscustomobject]@{ ok = $false; unauthorized = $true }
        }
        return $null
    }
}

function Wait-Healthy([string]$Token, [int]$ExpectTokens, [int]$TimeoutSec = 20) {
    $end = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $end) {
        $h = Invoke-Health $Token
        if ($h -and $h.ok) { return $h }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

if (-not (Test-Path -LiteralPath $Source)) {
    Say "[x] 找不到源文件：$Source（在仓库根目录跑，或显式给 -SourceRoot）"
    exit 2
}
$srcHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
# health 里的 build 与文件 sha256 前 12 位一致：部署后能确认"进程跑的就是这份代码"。
$srcBuild = $srcHash.Substring(0, 12).ToLower()

Say ("源: {0}  ({1} bytes, build={2})" -f $Source, (Get-Item -LiteralPath $Source).Length, $srcBuild)
Say ("目标: {0}" -f $Target)
Say ("端口: {0}  bind={1}  state={2}" -f $Port, $Bind, $StatePath)

$tokens = @(Get-BoardTokens)
if ($tokens.Count -eq 0) {
    Say "[x] 读不到板上 token（$TokenFile）。裸板子会把读写接口全敞开，拒绝重启。"
    Write-Log "abort: token 文件为空/不存在（$TokenFile）"
    exit 3
}
Say ("token: {0} 枚（首枚前缀 {1}…）" -f $tokens.Count, $tokens[0].Substring(0, [Math]::Min(8, $tokens[0].Length)))
$probe = $tokens[0]

if ($OnlyCheck) {
    $h = Invoke-Health $probe
    if (-not $h) { Say "[x] 板子没有响应：$HealthUrl"; exit 5 }
    Say ("当前进程: ok={0} version={1} authTokens={2} tasks={3} reconcileError='{4}'" -f `
        $h.ok, $h.version, $h.authTokens, $h.tasks, $h.reconcileError)
    if (-not $h.ok) { exit 5 }
    exit 0
}

if ($DryRun) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    Say ("[dry] 复制 {0} -> {1}（hash {2}）" -f $Source, $Target, $srcHash.Substring(0, 12))
    if ($listener) { Say ("[dry] 停掉监听 {0} 的 pid: {1}" -f $Port, (($listener | Select-Object -ExpandProperty OwningProcess -Unique) -join ',')) }
    else { Say "[dry] 端口空闲，直接启动" }
    Say ("[dry] 启动: <python> {0} --bind {1} --port {2} --state {3}" -f $Target, $Bind, $Port, $StatePath)
    exit 0
}

# 1) 复制（不同才覆盖，保留一份 .bak）
$needCopy = $true
if (Test-Path -LiteralPath $Target) {
    $needCopy = ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -ne $srcHash)
}
if ($needCopy) {
    if (Test-Path -LiteralPath $Target) {
        $bak = "$Target.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $Target -Destination $bak -Force
        Say "已备份旧文件: $bak"
        Write-Log "backup -> $bak"
    }
    Copy-Item -LiteralPath $Source -Destination $Target -Force
    $newHash = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
    if ($newHash -ne $srcHash) { Say "[x] 复制后 hash 不一致"; exit 5 }
    Say "已部署（hash 一致）"
    Write-Log "deployed $srcBuild -> $Target"
} else {
    Say "目标已是最新（hash 一致），仍会重启以装载进程内代码"
}

# 2) 停旧进程
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $pids = @($listener | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 4 })
    if ($pids.Count -gt 0) {
        Say ("停掉监听 {0} 的进程: {1}" -f $Port, ($pids -join ','))
        foreach ($p in $pids) {
            try { Stop-Process -Id $p -Force -ErrorAction Stop } catch { Say ("[!] 停 pid {0} 失败: {1}" -f $p, $_.Exception.Message) }
        }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline) {
            if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 300
        }
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
            Say "[x] 端口仍被占用，停旧进程失败"
            Write-Log "abort: port $Port still listening"
            exit 4
        }
    }
} else {
    Say "端口空闲，无需停进程"
}

# 3) 清陈旧锁（确认 pid 死了才删）
if (Test-Path -LiteralPath $LockFile) {
    $oldPid = 0
    try { $oldPid = [int]((Get-Content -LiteralPath $LockFile -ErrorAction Stop) -join '').Trim() } catch { $oldPid = 0 }
    $alive = $false
    if ($oldPid -gt 0) { $alive = [bool](Get-Process -Id $oldPid -ErrorAction SilentlyContinue) }
    if ($alive) {
        Say ("[x] 锁文件指向的 pid {0} 还活着，拒绝启动" -f $oldPid)
        Write-Log "abort: lock $LockFile held by pid $oldPid"
        exit 4
    }
    Remove-Item -LiteralPath $LockFile -Force
    Say ("已清理陈旧锁（原 pid={0} 已不在）" -f $oldPid)
}

# 4) 启动
$py = Get-Py
if (-not $py) { Say "[x] 找不到 python"; exit 5 }
$oldEnv = $env:GP_BOARD_TOKENS
$env:GP_BOARD_TOKENS = ($tokens -join ',')
try {
    $proc = Start-Process -FilePath $py `
        -ArgumentList @($Target, '--bind', $Bind, '--port', "$Port", '--state', $StatePath) `
        -WorkingDirectory $TargetRoot -WindowStyle Hidden -PassThru
    Say ("已启动 pid={0}（{1}）" -f $proc.Id, $py)
} finally {
    $env:GP_BOARD_TOKENS = $oldEnv
}

# 5) 自检
$h = Wait-Healthy $probe $tokens.Count 25
if (-not $h) {
    Say "[x] 启动后 25s 内 /api/health 没有 ok=true，检查 $LogFile 与进程输出"
    Write-Log "abort: healthy check failed after start"
    exit 5
}
Say ("自检: ok={0} version={1} authTokens={2} tasks={3} singleInstance={4} reconcileError='{5}'" -f `
    $h.ok, $h.version, $h.authTokens, $h.tasks, $h.singleInstance, $h.reconcileError)

$fails = @()
if ($h.version -ne 4) { $fails += "协议版本不对：$($h.version)" }
if ($h.build -ne $srcBuild) { $fails += "代码指纹不一致：进程 build=$($h.build) 源码=$srcBuild（很可能运行的是旧进程/旧文件）" }
if ($h.authTokens -ne $tokens.Count) { $fails += "token 枚数不一致：进程=$($h.authTokens) 文件=$($tokens.Count)" }
if ($h.singleInstance -ne $true) { $fails += "singleInstance 不为 true" }
if ($fails.Count -gt 0) {
    $fails | ForEach-Object { Say "[x] $_" }
    Write-Log ("fail: " + ($fails -join '; '))
    exit 5
}
Write-Log ("ok: version={0} pid={1} authTokens={2}" -f $h.version, $proc.Id, $h.authTokens)
Say "部署完成，自检通过。"
exit 0
