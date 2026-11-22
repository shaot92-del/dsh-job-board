# 2.7.11 定向复审任务书（只核「重启助手」这一处）

工作目录：C:\review\v2.7.11-final（v2.7.11，commit 7dc4d2d，无 .git）
对照：v2.7.10 = fa4169e；差异只有 lib/worker/maint-verbs.js、test/worker/maint-verbs.test.mjs、CHANGELOG.md、package.json、lib/worker/version.js、lib/client.js（版本号）、scripts/deploy/*.ps1（默认包名）。

## 背景
2.7.10 的「换包后自动重启」在真机没生效：helper 用 `Stop-Process -Id <pid> -Force` 被杀拒（权限/父子关系），脚本静默失败，DSH 没重启，但任务回执写「将在 N 秒后重启」——**回执与事实不符**。

## 2.7.11 做了什么
1. 新增 `buildRestartScript({ delayMs, dshExe, pid, moveFrom, moveTo })`（maint-verbs.js），三条路径共用：`restart` 动词、`queueRestartOnly`、`queueInstallThenRestart`。
2. 脚本逻辑：先 `Get-Process` 枚举、按 `$_.Path -eq $target` 精确匹配逐个 `Stop-Process -Force`；一个都没杀到才回退 pid；全过程写 `%TEMP%\dsh-maint-restart.log`；`Start-Process` 带 `-WorkingDirectory`。
3. 测试断言：脚本含 `Get-Process`、含 `dsh-maint-restart.log`、含 `$target`/`Start-Process -FilePath $target`、含 `Move-Item -LiteralPath`（安装路径）。

## 你要核什么（逐条给 PASS/FAIL）
1. 三个入口是否真的都走 `buildRestartScript`（`grep buildRestartScript lib/worker/maint-verbs.js`），有没有残留旧的 pid-only 脚本。
2. 按路径匹配的写法在 PowerShell 里是否成立（`$p.Path` 对无权限进程会抛异常——`try/catch` 是否兜住；`$ErrorActionPreference='SilentlyContinue'` 下行为）。
3. 字符串注入面：`q()` 的单引号加倍是否覆盖 `dshExe` 与 `moveFrom/moveTo`；helper 是拼成一行的 `;` 串，有没有漏引号/换行注入。
4. 安装路径（`moveFrom`/`moveTo`）在「杀进程 → 等 2 秒 → Remove-Item 旧目录 → Move-Item 新目录」顺序下是否安全；`Remove-Item` 失败会怎样（静默 Continue 时 `Move-Item -Force` 覆盖半旧目录的风险）。
5. 回执语义：`ok:true, queued:true` 是否仍可能骗人（例如 spawn 成功但 helper 内部失败）；日志是否足以事后取证。
6. 回归面：`restart` 动词的 `dshExePath` 不存在时是否仍返回 blocked 而不是排入 helper。

## 允许的命令
`node --check lib/worker/maint-verbs.js`、`node --test test/worker/maint-verbs.test.mjs`、`npm run gate`（可用）、`node scripts/check-text.mjs`。
禁止：改代码、git 操作、联网。

## 交付
写到 `docs/audit-2.7.11/review-2.7.11.md`：
- 结论 PASS / FAIL / BLOCKED（BLOCKED 需写明缺什么）
- 逐条核验表（上面 6 条）
- 新问题清单（P0–P3，每条带文件:行号 + 现象 + 建议）
- ≥5 条反证（你有没有试过「杀掉一半」「路径含空格/中文」「日志文件被占用」）
- 复跑数字对照