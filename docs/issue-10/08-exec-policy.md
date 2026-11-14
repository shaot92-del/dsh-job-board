# 部署级命令执行策略（#10-4）

> 一句话：**这块板子能在这几台机器上用当前账号执行命令，`allowedRoots` 只是路径
> 白名单，不是沙箱。** 这份文档写清"谁能让哪台机器跑什么"，以及部署时该关掉什么。

## 1. 能力边界：`sh_*` 到底能干什么

`sh_run` / `sh_write` / `sh_read` / `sh_list` 由 Host 插件在**本机**执行：

| 检查 | 实际行为 | 不是什么 |
| --- | --- | --- |
| `allowedRoots` | 只对"路径参数"做 realpath 前缀比较，越界即拒绝（fail-closed） | 不限制命令内容：`sh_run` 的 `command` 原样交给 pwsh |
| `shellTimeoutMs` | 超时只 kill 直接子进程 | 不 kill 子进程树（`Start-Process` 拉起的孙进程会活下来） |
| `maxOutputBytes` | 保留前 N 字节并标 `truncated` | 不影响命令本身的副作用 |
| 执行账号 | DSH 进程的当前用户（无提权） | 不是隔离账号，不是容器 |

结论：**能建单的人 ≈ 能在这些机器上以你的账号执行命令的人**。板子的信任边界就是
"谁能访问 8965 端口 + 谁能访问 remote-agent hub"。

## 2. 四条通道与各自的守卫

```
                   ┌───────────────┐
   建单/认领 ──────►│ 板子 :8965     │◄──── caps 心跳（每台机器）
                   │ board_server  │
                   └──────┬────────┘
                          │ 调度器 take/dispatch/attach
                   ┌──────▼────────┐        ┌──────────────────┐
                   │ Host 插件      │───────►│ remote-agent hub  │
                   │ (DSH 进程内)   │  HTTP  │ <board-host>:19387│
                   └──────┬────────┘        └───────┬──────────┘
                          │ sh_* 在本机执行           │ 派发到副机
                          ▼                          ▼
                    当前 Windows 账号            GT14 / MB14 上的 DSH
```

| 通道 | 默认状态 | 守卫 |
| --- | --- | --- |
| 板子 `:8965` | 绑 `0.0.0.0`，**默认无 token**，CORS `*` | 无（要自己开 `GP_BOARD_TOKEN`） |
| remote-agent hub `:19387` | 绑 LAN IP，带 `nodeToken` | 节点身份 + TOFU pin（`hub-pin.json`） |
| 插件 GUI 路由 `/api/board/ui/*` | 无鉴权，但只监听 DSH Web 的本地端口 | 靠"DSH Web 只绑 127.0.0.1" |
| `sh_*` 工具 | 任何拿到工具的人都能调 | `allowedRoots`（路径级） |

> 2026-11-08 实测：板子在 `<board-host>:8965` 对全网段开放、无 token；DSH Web 只
> 监听 `127.0.0.1`，所以"面板路由无鉴权"的实际暴露面是"本机任意进程"。

## 3. 威胁模型（按可能性排序）

1. **同网段任意设备建单** → 一条 `dispatch:auto` 的 `exec` 任务会真在 GT14/MB14 上
   跑。这是当前最高风险：板子无鉴权 + 默认 `dispatchApproval: auto`。
2. **误操作的 agent 会话** → agent 手里有 `board_dispatch` / `sh_run`，一句话就能把
   命令发到另一台机器；`allowedRoots: []`（默认）在 v2.0.2 起等于拒绝所有路径，需 `allowAllRoots: true` 才放行。
3. **副机凭据** → 副机的 DSH 以自己的账号跑 remote-agent worker；派工给它的任务
   与"在那台机器上手敲"等价。
4. **状态文件** → `state.json`（板子）、`pending-attach-*.json`、`dispatch-journal-*.json`
   都可被同账号进程篡改；v1.3.1 只解决并发一致性，不解决认证。

## 4. 部署清单（四台机的推荐值）

| 机器 | `dispatchRole` | `allowedRoots` | `dispatchApproval` | 说明 |
| --- | --- | --- | --- | --- |
| host（本机） | `owner` | 只列真正要动的目录，如 `["D:\\gp_video"]` | 保持 `auto` | 唯一派工的那台 |
| GT14 | 不装插件也可 | —— | —— | 只跑 remote-agent worker |
| MB14 | 同上 | —— | —— | 同上 |
| 第二台 Host | `observer` | 同上 | —— | 只建单、不派工 |

板子侧（`board_server.py`）：

- 设置 `GP_BOARD_TOKEN=<随机串>`，所有 Host 的 `token` 配同一值；
- 只在需要的网段开放 8965；不要把它暴露到公网；
- `state.json` 定时备份（单点，损坏即丢全部历史）。

Host 侧：

- `allowedRoots` 从 `[]` 换成具体目录 —— v2.0.2 起空数组是"拒绝"，不是"不限制"；
- 需要人工把关的机器把 `dispatchApproval` 设 `manual`：exec 任务会在副机上挂起
  等待批准（remote-agent 的默认行为），而不是直接跑；
- 一台机器只跑一个 DSH 实例（v1.3.1 的锁解决并发写，不解决两个调度器抢任务）。

## 5. 明确不做的（别期望这些）

- **不做沙箱**：没有容器/虚拟机/受限账号隔离；`sh_run` 的 `command` 不受
  `allowedRoots` 约束。
- **不做 RBAC**：板子不知道"是谁"建的单；谁能连上板子谁就能建。
- **不做审计合规**：可回溯的只有 Host 的 `_runtime.log`、板子的 events 与
  remote-agent 的 `audit.jsonl`，都不防篡改。
- **不清理孙进程**：超时只 kill 直接子进程。

## 6. 排查用三连

怀疑"有人从别处使唤了这几台机器"时：

1. 板子 `GET /api/board` 的 `events`：谁在什么时候 create / take / dispatch；
2. 副机 `C:\Users\<user>\.dsh-remote-agent\audit.jsonl`：每条 `task.dispatch` 的
   goal / workspace / 时间；
3. Host `_runtime.log`：`dispatched <id> → <node> remote=<taskId>`、`apply start
   config=…`（看那台机器的 `allowedRoots` 到底是什么）。

## 7. 已实施的加固（2026-11-08 实测）

三台 Host 与板子在这一天按本文档落地，踩到的坑按原样记下来，别再踩。

**板子**（`L:\云盘\gp_video_xfer\_tools\board_server.py`）：

- 设 `GP_BOARD_TOKEN`（40 位随机串，存本机 `%TEMP%\board-token.txt`，不进仓库）；
  所有 Host 的 `token` 配同一值。
- 重启方式：停掉 8965 监听进程 → 在**同一个** PowerShell 进程里
  `$env:GP_BOARD_TOKEN = <token>` → `Start-Process python board_server.py --port 8965
  --bind 0.0.0.0`。
- 验证：`GET /api/health` 的 `auth` 必须是 `true`；无 token 的 `POST /api/say` 必须
  401，带 `x-board-token` 必须 200。**只启动成功不代表鉴权生效** —— 本次第一次
  重启时子进程没继承到环境变量，health 回 `auth:false`、无 token 写入居然成功，
  必须实测这两条才算开成。

**三台 Host**（都写在各机 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 的
`- id: team` 覆盖行里，`config` 整体替换）：

| 机器 | `dispatchRole` | `allowedRoots` | `token` |
| --- | --- | --- | --- |
| host | `owner` | `["D:\\gp_video","C:\\Users\\<user>\\Documents\\deepseek-harness"]` | 同一枚 |
| GT14 | `observer` | 同上 | 同一枚 |
| MB14 | `observer` | `["D:\\gp_video"]` | 同一枚 |

改之前先备份（本次备份名 `cordis.patch.yml.bak-hardening-<时间戳>`），改完用
`js-yaml` 解析一遍确认 entry 数与 `config`。

**生效方式与两个坑**：

1. 改 `cordis.patch.yml` 会触发热重载，而宿主**不会**先调本插件的 `cleanup` →
   `webserver: duplicate exact route "/api/board/ui/summary"` → 该 entry 变
   `failed`。v1.1.11 起插件会整体回滚并打一行提示，但配置只有在**完整重启
   DSH** 后才真正生效。
2. **不要从 DSH 自己的执行会话里重启 DSH**。`Stop-Process -Name 'DeepSeek
   Harness'` 会把执行这条命令的进程一起杀掉；紧接着 `Start-Process` 拉起的 GUI
   进程落不到交互桌面会话，机器直接失联（本次 GT14 与 MB14 都这样，ping、SMB
   445 全不通，WOL 魔包也没唤醒），只能到机器前手动登录重启。远程重启只能交给
   登录时运行的脚本或计划任务，在用户会话内执行。

**重启后逐台核对**（顺序照做，别跳）：

1. `Get-Process -Name 'DeepSeek Harness' | Select StartTime` —— 确实是新进程；
2. `_runtime.log` 的 `apply start config={…"token":"***","allowedRoots":[…]}` 与
   `route registered …ready`；
3. `caps reported ok=true machine=<名> shell=true`（10 分钟一拨；token 没带上时
   会看到该台 caps 401、板子上 `last_seen` 变陈旧）；
4. host 上 hub `<board-host>:19387` 有来自副机的 Established 连接。

关闭 token 同样要重启板子进程（环境变量只在启动时读一次）。

## 8. 安全复审后的加固（2026-11-08 晚，不重启 DSH 的部分）

第三轮复审（AI 安全审计）报了三件事，其中两件当场修掉，一件必须等重启。

### 8.1 明文 token 泄露（已止血）

`docs/issue-10/05-deployment-notes-2026-11-08.md` 曾把 hub 的 `nodeToken`
真值写进正文，并已推到 **public** 仓库（暴露约 8.5 小时）。同一枚还散在：
板子 `state.json` 的 task note、`_remote-logs/**/tasks/*.json` 的 stdout、
共享盘若干 `_tools/*.ps1` 与旧备份。

- 仓库：真值已改成 `<nodeToken>`（commit `0fd2043`），`git grep` 复扫无残留。
- 共享盘：脚本按字节替换（兼容任意编码），25 个文件里的 hub token / 旧 board token
  换成 `<nodeToken>` / `<board-token-old>`。
- **但旧 nodeToken 仍然有效** —— 它写在 hub 进程内存里，换掉必须重启 DSH。
  重启时把 profile `cordis.patch.yml` 里 `- id: remote-agent` 的 `nodeToken` 换成新值，
  并把三台副机的 `hub-pin.json` / `~/.dsh-remote-agent` 里钉住的旧指纹一并换掉。

### 8.2 板子 v4（已生效）

`board_server.py` 这一版把 fail-open 全关掉：

- **没有 token 拒绝启动**（以前裸板子照样起、照样绑 0.0.0.0）；
- **单实例锁**：Windows 上 `os.kill(pid, 0)` 判不出存活（会抛异常 → 被当僵尸 → 第二个
  进程照样启动、两个进程同写一份 state.json），改用 `OpenProcess` +
  `GetExitCodeProcess == STILL_ACTIVE`；
- **Origin 白名单**（`GP_BOARD_ORIGINS`）+ 不再回 `Access-Control-Allow-Origin: *`：
  挡住"任意网页 simple POST 建 exec 单"的 CSRF 链；
- `do_POST` 要求 `Content-Type: application/json`（缺省放行，其余 415）；
- 看板 HTML 全量 `html.escape`（存储型 XSS）；token 用 bytes 比较
  （非 ASCII 头不再抛 `TypeError`）；
- `do_release` / `do_mark` / `do_untake` 增加 holder 校验；`release{queued}` 恢复
  `dispatch`；`mark{queued}` 清 `taker/holder/remote_id`；`remote_id:''` 改 `pop`。

### 8.3 守护脚本改 fail-closed（已生效）

`board_guard.ps1` 以前探 `/api/board`，板子一开鉴权就 401，被当成"板子挂了"，
于是 `Start-Process` 拉起一个**没有 token、绑 0.0.0.0** 的裸板子。现在：

- 探活只打公开的 `/api/health`（200 且 `"ok":true` 才算活）；
- token 从 `%USERPROFILE%\.dsh\board-tokens.txt`（一行一枚，双 token 过渡期两行）读；
- 读不到 token 就**只告警、不启动**；`启动作业板.bat` 同规则；
- `host_watch.ps1` / `进度播报.ps1` 读板子时带 `x-board-token`。

### 8.4 仍然待办（都要重启）

- 轮换 hub `nodeToken`（旧值已公开）；
- 仓库历史清 token：改 private 或 `git filter-repo`（历史里仍有真值）。

> 2026-11-08 19:40 更新：GT14/MB14 已换新 board token 并重启（19:33、19:35），
> 两台用运行时 token 打 `/api/board` 均 `200`；板子已撤旧枚（`authTokens:1`，旧枚 401）；
> `%TEMP%` 与共享盘的 token 文本已删。剩下 hub `nodeToken` 与仓库历史两件。

## 9. board token 轮换实操（2026-11-08 实测）

### 9.1 顺序（三步，最后一步才收窄板子）

1. **各 Host 换 token**：`pwsh -File Z:\_tools\team-hardening.ps1 -Machine <M> -TokenFile <token 文件> -Roots <...> -Role <owner|observer>`。
   脚本从文件读 token，命令行与 goal 里都不出现真值。
2. **各 Host 重启 DSH**，让运行时真的用上新 token；重启后逐台核对
   `iwr http://<board-host>:8965/api/board -Headers @{'x-board-token'=<运行时 token>}` 回 200。
3. **收窄板子**：`%USERPROFILE%\.dsh\board-tokens.txt` 只留新枚 → 重启 8965 →
   `health.authTokens == 1`，旧枚再打 `/api/board` 必须回 401。

顺序反了就是一次 401 空窗：板子只认新枚、而某台 Host 还在用旧枚。

### 9.2 重启副机 DSH 的可靠姿势

**不能**从 DSH 自己派的 exec 任务里 `Start-Process` 重启 —— 那个子进程在 DSH 的进程树里，
`taskkill` 会连坐，机器直接失联（2026-11-08 实测两台都这样，最后靠人工开机）。

可靠做法是让任务计划程序托管一个 VBS，脱离 DSH 进程树：

```powershell
# 共享盘上的 bounce-dsh.vbs：睡 N 毫秒 → taskkill DeepSeek Harness → 6 秒后重新拉起
schtasks /create /tn DSHBounce /tr 'wscript.exe \\<host-pc>\gp_xfer\_tools\bounce-dsh.vbs 15000' /sc once /st 23:59 /it /f
schtasks /run /tn DSHBounce
```

`/it` 保证在交互桌面会话里运行，GUI 才能真起来。实测 GT14（19:35:33）、MB14（19:33:17）
都换成了新进程，hub 连接与 caps 心跳随后自动恢复。

就地 `explorer.exe Z:\_tools\bounce-dsh.vbs` **不生效**（实测进程启动时间没变）——不要用。

### 9.3 验证三连

| 检查 | 命令/口径 | 期望 |
| --- | --- | --- |
| 配置已换 | 副机读 `cordis.patch.yml` 的 `token:` 与 `Z:\_tools\board-token.txt` 比对 | `same=True` |
| 运行时已换 | 副机用配置里的 token `iwr /api/board` | `200` |
| 板子已收窄 | 旧枚打 `/api/board` | `401` |

补一条：`board_server.py` 的 `/api/health` 是公开的，`authTokens` 会直接告诉你板子当前认几枚。

## 10. v1.3.7：不做重启的那批（2026-11-08）

三方复审（代码审查 / 遗留系统 / 安全审计）之后，这一批全部**不需要重启 DSH 或板子**就能落地。
需要重启的（hub nodeToken、board token 再轮换、仓库历史清 token）留在 §11。

### 10.1 插件 GUI 的写通道（安全 F1，已关）

`/api/board/ui/*` 以前只抓 Cookie，不校验来源——任何能打到 `127.0.0.1:<GUI 端口>` 的页面
或进程都能 `POST /api/board/ui/create` 建一条 `mode=exec, dispatch=auto` 的任务，等于在你
所有副机上以你的账号执行 PowerShell。现在每个路由进 handler 前都过 `uiGuard(req)`：

| 检查 | 规则 | 失败返回 |
| --- | --- | --- |
| Host | 必须是回环（`127.0.0.1` / `localhost` / `[::1]`）或在 `uiAllowedHosts` 里 | 403 `why:"host"` |
| Origin | 带 `Origin` 时必须与 Host 同源 | 403 `why:"origin"` |
| 写请求 | 非 GET 必须带 `x-dsh-team-ui: 1` 且 `content-type: application/json` | 403 `why:"token"` 或 `"content-type"` |

面板自己（`lib/client.js`）已经统一带上这两个头；第三方脚本要调这几个路由，也得照做。
`uiAllowedHosts` 只在"用别的域名反代到本机 GUI"时才需要配，默认空。

回归：`node scripts/ui-guard-smoke.mjs`（7 个用例：回环放行、外部 Host 拒、跨站 Origin 拒、
同源放行、缺头拒、非 JSON 拒、合规写放行）。

### 10.2 脚本卫生：token 不再出现在 stdout / 日志里

| 文件 | 改法 |
| --- | --- |
| `team-hardening.ps1` | 不再把整块配置打到 stdout（那里面有 `token:`），改成逐行打码 `token: '<redacted>'` |
| `board_guard_keepalive.ps1` | 探活从 `/api/board` 改 `/api/health`（前者要 token，401 会被当成"板子挂了"，每 10 分钟误杀守护） |
| `board-presence.ps1` | 报到带 `x-board-token`（从 `~/.dsh/board-tokens.txt` 读，缺则 exit 2） |
| `自驱.ps1` | 读 `/api/board` 与写动作都带 `x-board-token`；`Get-BoardToken` / `Get-BoardHeaders` 必须定义在 `Get-Board` 之前 |
| `启动作业板.bat` | 提示改成"浏览器直接打开会 401，这是正常的" |

共享盘 `_remote-logs` 里 2026-11-08 两条 hardening 任务（`ui-mw7r2zq4zf` / `ui-mw7r2zop1uu`）
的 stdout 曾含 board token 明文，已按实际值原地替换成 `<board-token>`。

### 10.3 ACL：代码目录不再允许"任意已认证用户"改写

`_tools` / `_board` / `_remote-logs` 原先继承 `Authenticated Users:(M)` —— 任何一台副机上的
任何账号（只要能连 SMB）都能改 `board_server.py`、`board_guard.ps1`，而被改过的代码下次会被
拉起执行。现在三个目录已 `/inheritance:d`，显式只留：

| 主体 | 权限 |
| --- | --- |
| `<host-pc>\17827` | 完全控制（本机所有者） |
| `<host-pc>\xfer` | 修改（共享盘服务账号，副机经它读写） |
| `BUILTIN\Users` | 读取与执行 |
| `SYSTEM` / `Administrators` | 完全控制 |

`C:\Users\Public\gp_board_guard_hidden.vbs`、`gp_daemon_hidden.vbs` 把 `INTERACTIVE` /
`SERVICE` / `BATCH` 从"修改"降到"读取与执行"；`D:\gp_video\_tools\gp-daemon.ps1` 同样去掉
`Authenticated Users` 的修改权。

> 注意：已存在的日志/数据文件里仍有继承下来的旧 ACE（在用的文件改不动，`icacls` 会报
> Access denied）。它们不影响"代码目录不可被改"这一条，但如果你想彻底清一遍，要停掉板子
> 与日志写入再跑 `icacls <dir> /remove:g "NT AUTHORITY\Authenticated Users" /T /C`。

改完的验证：板子照常写 `state.json`（`/api/create` 200、`state.json` mtime 前进）、副机照常
读 `Z:\_tools`（派一条 exec 读文件即证）。

## 11. hub `nodeToken` 轮换（2026-11-08 实操）

背景：`docs/issue-10/05-deployment-notes-2026-11-08.md` 曾把 hub 的 `nodeToken` 真值写进公开
仓库（commit `1068cab`，暴露约 8 小时后由 `0fd2043` 移除）。二进制/明文出现在历史里之后，
**唯一真正安全的动作是换掉它**——旧值一旦作废，历史里的字符串就是废纸。

### 11.1 三台各自的字段名不一样

| 机器 | 角色 | `- id: remote-agent` 里的字段 | 取值示例 |
| --- | --- | --- | --- |
| 本机 `<host-pc>` | hub | `nodeToken:`（带单引号） | `'nt_…'` |
| GT14 | worker | `token:`（**不带引号**） | `nt_…` |
| MB14 | worker | `token:`（带单引号） | `'nt_…'` |

还有两处容易踩：

- GT14 的 `hubUrl` 是 `ws://<board-host>:19387/api/remote-agent/node`（WebSocket），
  MB14 是 `http://<board-host>:19387`（direct）——轮换脚本不要按整块重写，只改 token 那一行。
- 副机块里 `inject: []` 是刻意的（非空会永远 PENDING）；本机 hub 块是
  `inject: [ 'webServer', 'tools', 'systemPrompt' ]`。

### 11.2 正确顺序（缺一条就会有一段"连不上"的窗口）

1. **生成**新值：`nt_` + 32 位十六进制（和旧值同形状，长度 35）。
2. **写三台配置文件**：`Z:\_tools\rotate-hub-token.ps1`（只改 `- id: remote-agent` 块里的
   `nodeToken|token` 行，保留缩进/引号风格/行尾注释，写前备份、写后复核新旧值）。副机用
   `-TokenFile Z:\_tools\_ratoken.txt`，避免令牌出现在命令行与任务 goal 里。
3. **重启两台副机**（它们才会用新值去连 hub）。
4. **最后重启本机 DSH**（hub 才会用新值校验）。

> 顺序反了会怎样：只改文件不重启 → hub 仍用旧值内存态，副机已用新值 → 连接被拒、
> `19387 Established = 0`，派工停摆，直到 hub 重启。

### 11.3 热重载会打断回执（不是失败）

副机的 `cordis.patch.yml` 一改，loader 立刻热重载 `dsh-remote-agent`；exec 任务就在这个插件
里跑，于是**任务回执丢失**（板上停在 `running`），但脚本写文件发生在回执之前，配置通常已经
写好了。判断办法：重启后重新 dump 一次块内容（`Z:\_tools\_dump-ra.ps1`，token 只打
`len` 与前 6 位），或看备份文件时间。

### 11.4 重启后的验收四条

1. `Get-NetTCPConnection -LocalPort 19387 -State Listen` 有监听、`healthz` 回 `{"ok":true}`。
2. `Get-NetTCPConnection -LocalPort 19387 -State Established` 来自 `<worker-1-host>`、`<worker-2-host>`。
3. hub 的节点表 `nodes:2, online:2`。
4. 板子 `health` 仍 `authTokens:1`，三台 `last_seen` 在 15 秒内；随手派一条 exec 能 done。

### 11.5 轮换完成后要做的清理

- 共享盘令牌暂存文件 `Z:\_tools\_ratoken.txt` 用完即删。
- 旧值可能残留在 `_board\state.json`、`~/.dsh-remote-agent/audit.jsonl`、`board.log`：
  按字节替换成 `<nodeToken>`（本次实测 `state.json` 命中 1 处，另两个文件干净）。
- `cordis.patch.yml.bak-ratoken-*` 备份含旧值，轮换确认后删掉。

### 11.6 为什么不清 git 历史

历史里留着的是**已作废**的值：能读到它的人拿不到任何权限。清历史只有两条路——
`git filter-repo` 强推（全部 SHA 改写、tag 重建、PR 需重开、别人的克隆失效）或仓库转
private（PR 与市场投稿一并消失）。除非决定"不再公开发布"，否则不值得付这个代价；
真要清，等市场投稿审完再统一做。


### 11.7 本次轮换的实测记录（2026-11-08 21:17–21:45）

| 阶段 | 事实 |
| --- | --- |
| 生成 | `nt_21a48471…`（35 位），暂存 `Z:\_tools\_ratoken.txt`（ACL 只给本机账号全权 + 共享账号读） |
| 本机 | `cordis.patch.yml:158` 的 `nodeToken:` 换成新值，写后复核「新值在、旧值无」 |
| GT14 | exec 任务 `bd-7uxi7x-7586` 回执 `ok: 已写入并复核`（第 35 行、无引号写法） |
| MB14 | 脚本写到一半插件热重载、回执丢失（任务停在 running）。**配置其实已写好** —— 重启后 dump 确认 `token: '<len=35 prefix=nt_21a>'` |
| 过渡态 | 副机已用新值、hub 仍用旧值 → `19387 Established = 0`。顺序反了就必然出现这一段 |
| 重启 | 本机 DSH → hub 用新值；两台副机各自重启 DSH 后自动重连（`Established` 出现 `<worker-1-host>`、`<worker-2-host>`） |
| 验收 | `19387` LISTEN + `healthz {"ok":true}`；两台 worker 重连；派工自检 `bd-7vwgns-c417` → MB14 `done` |

两个补充教训：

- **dump 脚本也要掩码**：`_dump-ra.ps1` 第一版只匹配带引号的 `token: '...'`，而 GT14 是无引号写法，
  于是新值被原样写进了共享盘 `_diag`。已改成 `('?)([^'#\s]+)\4` 兼容两种写法，并把
  `_diag`、`_remote-logs` 里命中的 4 个文件按实际值替换为 `<nodeToken>`。
- **旧值会顺着探针日志外溢**：`_remote-logs` 里早期"打印配置块"的探针任务是令牌明文的最大来源。
  以后探针一律只打 `len` 与前 6 位，不再整块回显。

## 12. 第 1 层安全修补（2026-11-08 实施）

三专家复审（v1.3.8）后按"当天能关的洞先关"落地这一批，清单与证据如下。

### 12.1 秘密清理

| 位置 | 处理 |
| --- | --- |
| `L:\云盘\gp_video_xfer\_keys\gemini.txt`（明文 Google key） | 移到 `%USERPROFILE%\.dsh\secrets\gemini.txt`，`icacls /inheritance:r` 只给当前用户；共享盘 `_keys` 目录删除；`setup-modlens.ps1` 默认路径同步改 |
| `_board\state.json` 里的旧 `nt_…` | 替换为 `<nodeToken>`（替换前先停板子，否则内存里的旧值会写回） |
| `_remote-logs` 里的旧 `nt_…` | 已替换；**注意**：这几个文件在写入后约 15 秒会被外部镜像还原，属于托管目录，不能当"可删除的存储"用 |
| 仓库 `docs/issue-10/05-deployment-notes-2026-11-08.md` | 已在 `0fd2043` 里改成 `<nodeToken>` |

> 密钥搬到本机只解决了"共享盘可见"，**泄露过的 key 仍然要上游撤销重建**。

### 12.2 板子（`board_server.py`）

- 写入边界脱敏：`say` / `create` / `mark` / `release` / `claim` 的文本先过 `redact()` 再落盘；
  出口 `/api/board` 再整体 `redact_obj()` 一遍（双保险）。
- `/api/health`：无 token 只回 `{"ok": true}`；带 token 才给 `tasks/authTokens/version/routes`。
- `MAX_BODY_BYTES = 1 MB`：超限直接读空，不把线程挂住。
- `_minutes()`：租约夹到 1–1440 分钟。

### 12.3 日常扫描（`_tools\scan-share-secrets.ps1`）

- 规则：`nt_[0-9a-f]{32}`、`ghp_…`、`github_pat_…`、`sk-…{32,}`、`AQ.…`、独立 40 位十六进制。
- 分级：真实形状 → `ERROR`（脚本 `exit 3`）；文档/代码里的字段名与占位符 → `INFO`。
- 日志追加到 `_board\secrets-scan.log`；建议注册为每天跑一次的计划任务。
- 已知例外：`_remote-logs` 里三个被镜像托管的文件仍含**已作废**的旧世代 `nt_32fcd1c…`，脚本记为 INFO。

### 12.4 这一层还不解决什么

- 一把 token 仍然同时是"看板读写"和"让副机执行命令"的凭证 —— 真正分权是第 2 层（分档 token、
  任务级 claimSecret、exec 白名单）。
- 板子仍绑 `0.0.0.0:8965`（防火墙收窄需要管理员权限，尚未做）。
- 明文 HTTP；events 与 state 仍同库。

---

## §13 第二批：D3/D4/F1/F3/F5/F7/F9（v1.3.10，2026-11-09）

### 13.1 这一批改了什么

| 编号 | 位置 | 触发条件 | 影响 | 修法 |
| --- | --- | --- | --- | --- |
| D3 | `lib/client.js` `runCleanup` | 暂停接口 404 / 宿主回 `paused:false` | 继续 release，副机在跑、板上作废且不再被 watch（幽灵任务） | 两次暂停都失败即中止，只提示不动数据 |
| D4 | `lib/client.js` `runCleanup` | fetch 抛错 | `cleanBusy` 卡 true（按钮永久变灰）、调度器停 2 分钟 | 整段 try/catch/finally，finally 复位并尽力恢复调度 |
| F1 | `board_server.py` 单实例锁 | 同一端口、不同 `--state` 起第二实例 | Windows `SO_REUSEADDR` 允许双 bind，两份内存态互相覆盖 | 锁名带端口 + `SO_EXCLUSIVEADDRUSE` + `allow_reuse_address=False` |
| F3 | `do_mark`/`do_beat`/`do_release` | 机器名大小写不同（`GT14` vs `gt14`） | 409「不是你占的」，客户端再也更新不了自己的任务 | 两侧都过 `_canon_machine` 再比 |
| F5 | `team-hardening.ps1` | 跑加固脚本 | 整块重写，`writeTimeoutMs`/`dispatchTickMs`/`unknownGraceMs` 静默丢失 | 键级 upsert，只改自己管理的 9 个键 |
| F7 | `自驱.ps1` 四处 release | 板子抖动 / 网络失败 | 以码表外的 exit 1 退出，任务永远 claimed | `Release-Task` 捕获 + `_pending-releases.jsonl` 补报 |
| F9 | `reconcile_once` | `listdir` 异常 | 静默 `return 0`，远端跑完的任务在板上永远 running | 写 `RECONCILE_ERROR`，health 回显 + stderr 一行 |

### 13.2 测试

- `dispatch-recovery-smoke` 新增 **R24**（待补绑任务归执行机 MB14、调度器 host、远端已消失 →
  必须按执行机名 mark 成 failed 并清掉记录）：**74/74**。
- `fake-board.mjs` 的 `/api/mark` 补归属校验 —— 没有它，D2 这类"传错机器名"的 bug 在
  smoke 里永远测不出来。
- 新增 `scripts/board-server-smoke.py`：真板子契约（同端口第二实例必须拒绝；`GT14` 认领后
  `gt14` 可 beat/mark/release、`MB14` 仍 409）。无板子脚本时跳过。

### 13.3 板子补丁的部署方式（重要）

`board_server.py` 不在 git 仓库里，唯一权威副本是
`L:\云盘\gp_video_xfer\_tools\board_server.py`（副机 `Z:\_tools\board_server.py`）。这一批改了
4 处：锁名/`BoardServer` 独占绑定、`RECONCILE_ERROR`、`_canon_machine` 三处比较、health 的
`reconcileError`。改完必须重启板子进程，旧进程不会热加载。

### 13.4 事故记录：profile 管理插件重写了 cordis.patch.yml

2026-11-09 20:10 左右，`@hyzyn/dsh-profile` 重写了
`C:\Users\17827\.dsh\profiles\desktop\cordis.patch.yml`，把 `- id: remote-agent` 与
`- id: team` 两个块**整块丢掉**（文件从 ~7 KB 变成 2 KB）。运行中的实例还是旧配置，所以当时
没立刻断；插件在 20:21 热重载后按新 patch 启动，于是 `_runtime.log` 出现
`读板子失败 unauthorized` / `caps ... status=401`，调度器空转，hub 也没有 `nodeToken`。

处置与教训：
1. 恢复时从 `cordis.patch.yml.bak-1794226190114`（11-08 22:54，含两块）取回，只把 token 行
   换成当前值（team = gen3、remote-agent = `nt_21a48471…`），其余键原样保留。
2. **任何 profile 级操作之后都要检查这两块还在不在**：
   `Select-String cordis.patch.yml -Pattern '^- id: (team|remote-agent)$'`。
3. 这两个块丢了不会在界面上报错，只会表现成"板子 401 / 副机不连"。

### 13.5 重启验收（v1.3.10 上线后实测）

热重载装不回 dsh-team（`route register FAILED: duplicate exact route "/api/board/ui/summary"`
→ `apply aborted before ready, rolling back 16 resource(s)`），必须整机重启。20:36 重启后实测：

- `_runtime.log`：`apply start` → 12 条 `route registered` → `ready` → `host dispatcher started tick=4000ms`，
  随后 `caps reported ok=true machine=host`、`board auto-detected`，不再出现 `unauthorized`。
- hub：`19387` 由新进程监听，**服务端视角** `LocalPort=19387` 有 `<worker-1-host>`、`<worker-2-host>`
  两条 Established（别用 `-RemotePort 19387` 查，那是客户端视角，会误判为 0）。
- 板子：host / GT14 / MB14 的 `last_seen` 都在 20 秒内（PC2 与 `?` 是历史条目）。
- 端到端派工：建一条 MB14 任务，4 秒内被派给 `desktop-2gh05s7`，回 `v1.3.10 alive 20:39:36`。

恢复用的 patch 副本另存在 `C:\Users\17827\.dsh\cordis-patch-good-20261109.yml`。

### 13.6 `team-hardening.ps1` 的第二个丢配置点（已修）

13.1 的 F5 修掉了"整块重写丢未知键"，但合成 YAML 复验又发现：**受管键里的数值也会被重置**。
`timeoutMs` / `shellTimeoutMs` / `maxOutputBytes` / `remoteSyncMs` 没有参数入口，旧实现一律返回
硬编码默认值，于是 `timeoutMs: 9000` 跑一次加固就变回 `8000`。

修法：解析旧块时把受管键现值收进 `$oldValues`，`Keep-Or(key, fallback)` 有旧值就沿用；
`dispatchRole` 只显式传 `-Role` 时才覆盖。另把 `"$key: ..."` 改成 `"${key}: ..."`（`$key:` 会被
当成作用域引用，直接 ParserError）。

复验（合成文件，不碰 live patch）：未知键 + `timeoutMs: 9500` 全保留、`allowedRoots` 更新；
不给 `-Machine`/`-Role` 时 `MB14`/`observer` 保留；无 team 块时追加整块、其它块不动。

### 13.7 共享盘令牌扫描：从 41 条告警到 0

`GPShareSecretScan`（每天 09:30）首跑（2026-11-09 09:30）结果 `files=1984 errors=41`，逐条看下来
全是两类误报，没有一条是有效凭据：

1. `_remote-logs\{gt14,mb14}\tasks\*.json` 里的 `6e247852…` / `23aa47ef…` —— 早期两代板子令牌，
   早已轮换作废。这些文件由镜像层托管，**写进去约 15 秒就被还原**（`*.bak-scrub` 不在镜像范围，
   所以只有它们能被真正清掉），没法作为"可删除"的对象处理。
2. `_收件箱\手机传过来的\dsh-team-implementation-plan.md` 里的 `c4a106dc…` —— GitHub 链接里的
   commit sha（`/tree/`、`/blob/`、`/commit/`）。

改法：扫描器加两个豁免 —— 已作废世代令牌列表（`$retired`，命中记 INFO）、以及 GitHub URL 里的
commit sha。重跑（20:41:22）：**`files=1989 errors=0 infos=40`，exit 0**。

> 记住这个判断口径：ERROR 只该在"有效凭据"上出现；把作废值和 URL 指纹也当 ERROR，会让每天的
> 告警变成噪音，真出事时没人看。

## 14. 第三批修补（v1.3.11）：D6 / M1 / M2 / M4 / L2 / F10

### 14.1 触发条件 → 影响 → 修法

| 项 | 触发条件 | 影响 | 修法 |
| --- | --- | --- | --- |
| D6 | 板子任务被另一个 Host 重新派过 | 旧 Host 仍按自己的 hub 结果回写终态，覆盖别人正在跑的进度；原护栏读 `t.taker`，而 `do_attach` 会 pop 掉它，等于死代码 | 新增 `remote-owners-<machine>.json` 账本（attach 记 `{taskId, remoteId}`，12h TTL）；`syncRemote` 比对板上 `remote_id`，不一致就跳过；写回终态清账 |
| M1 | 任务已有 `machine`，调用方省略 `machine`/`holder` | `if t.get("machine") and ...` 短路成放行（板子源码 `do_mark`/`do_release`），持 token 者可关闭/改写任意任务 | 非回环调用必须带 `machine`（按 `_canon_machine` 比对）或 `holder`，否则 400 `identity-required`；`do_POST` 注入 `__client` |
| M2 | 半开连接 / 并发打满 | 无限线程，默认 `0.0.0.0` 可达 | 连接 15 秒超时；`BoundedSemaphore`（`GP_BOARD_MAX_CONN`，默认 32）满则 503 |
| M4 | 插件启动时自动探测板子地址 | 按候选名单广播式发问，同网段可抢答并拿到 board token | 探测成功即 pin 到 `<state>/board-url.json`；`DSH_TEAM_BOARD_REPIN=1` 才重探 |
| L2 | `caps` / `metrics.live` / `seed` 无上限 | 可把 `state.json` 撑大、读板子越来越慢 | caps 8 KB、metrics 4 KB、seed 200 条/次、任务总数 5000（超限 413） |
| F10 | 注释声称「四台已装 5 分钟心跳 gp_presence」 | 与事实不符（计划任务从不存在），排障时指错方向 | 代码注释改为插件的 `remoteSyncMs=6s` 心跳；文档核对无同样说法 |

### 14.2 测试与验收

- `dispatch-recovery-smoke` 74/74（R19 改为账本语义：`mark=0` 且板上状态不被覆盖）。
- `board-server-smoke.py` 17 项全过，其中 M1 用非回环地址（本机 LAN IP）模拟局域网调用：
  匿名 `mark`/`release` → 400 `identity-required`，带 `machine` → 200。
- plugcheck 16/12、reload A/B/C、state-file 16/16、ui-guard 7/7、acceptance 11/11。

### 14.3 部署注意

`board_server.py` 不在 git 里，权威副本是 `L:\云盘\gp_video_xfer\_tools\board_server.py`。
改完必须重启板子进程（`Stop-Process` 旧 pid 后重新拉起，`GP_BOARD_TOKENS` 从
`~/.dsh/board-tokens.txt` 读）。插件侧改动（D6/M4/F10）要重启 DSH 才生效 —— 本轮 DSH 的
热重载已知会撞 `duplicate exact route "/api/board/ui/summary"`，别指望它。

## 15. 第四批（v1.4.0）：运维自愈

### 15.1 为什么先做这个

前一阶段的事故不是「功能不够」，而是「跑起来之后没人替它看着」：

- v1.3.11 板子补丁写完了，但进程还是旧的，我却报告「已生效」——因为没有任何东西能证明
  运行中的进程就是磁盘上那份源码；
- 改 `cordis.patch.yml` 触发一次热重载，撞 `duplicate exact route "/api/board/ui/summary"`，
  16 个资源整体回滚，插件半死，只能整机重启。这种情况一周发生了两次。

所以 v1.4.0 做四件事：板子进仓库、部署脚本自检、doctor 把状态讲出来、撞名时降级而不是
整体回滚。外加 D6 账本的一个收尾。

### 15.2 板子进仓库与 `build` 指纹

- 源：`tools/board_server.py`（git 跟踪）；部署目标仍是
  `L:\云盘\gp_video_xfer\_tools\board_server.py`。
- `/api/health`（带 token）新增 `build`：启动时对 `__file__` 取 sha256 前 12 位。判断
  「跑的是不是新代码」只看这一项，不要再看行为猜。
- 部署：`pwsh -File scripts/install-board.ps1`；参数 `-OnlyCheck`（只校验不重启）、
  `-DryRun`（只打印计划）。退出码：0 成功、2 源缺失、3 无 token、4 停旧失败、5 启动或
  自检失败；日志在 `_board/install-board.log`。
- 脚本会：哈希比较 → 备份旧文件 `.bak-<时间戳>` → 停监听端口的进程 → 清陈旧锁（锁里
  pid 还活着就拒绝，避免误清）→ 用 `GP_BOARD_TOKENS` 环境变量启动 → 25 秒内等 health →
  校验 `version=4`、`build` 与源一致、`authTokens` 枚数、`singleInstance=true`。

### 15.3 doctor 与面板红条

`GET /api/board/ui/doctor`（回环 + `x-dsh-team-ui` 头）返回
`{ok, version, role, machine, board, checks[], checkedAt}`。检查项：

| id | level | 触发 |
| --- | --- | --- |
| `config-token` | error | team 配置里没有 token |
| `config-machine` | warn | machine 为空，多机归属会写成空 |
| `board` | error | 板子连不上或返回异常 |
| `board-stale` | warn | 板子快照超过 120 秒没更新 |
| `workers` | warn | 没有在线 worker；部分离线也是 warn |
| `hub` | warn/error | hub `/nodes` 不可用（error）或 0 个 worker（warn） |
| `routes` | warn | 有路由被旧实例占用（降级加载） |
| `dispatch` | error | 距上次 tick 超过 `max(30s, dispatchTickMs*5)` |
| `dispatch-paused` | warn | 调度器被暂停 |
| `dispatch-error` | error | 最近一次 tick 抛错 |

面板每 30 秒拉一次，有 error 显示红条、只有 warn 显示黄条，逐条给 `message → hint`。

### 15.4 路由注册的降级语义

- 每条路由单独 try/catch；错误信息匹配 `duplicate ... route` → 跳过这一条、记进
  `degradedRoutes`、trace `route SKIPPED …`，其余照常注册，插件正常 ready。
- 非 duplicate 的失败（例如路由表本身坏了）仍 rethrow，走原有整体回滚——降级只针对
  「旧实例还没卸载」这一种已知形态。
- 代价：降级实例的 UI 路由仍由旧实例应答（旧代码），doctor 会报 `routes`。看到这条
  就安排重启，不要以为热重载已经换上新代码。

### 15.5 D6 账本收尾

板子自己的 `reconcile_once` 会先把任务标成 done/failed/blocked/superseded；这时插件的
`syncRemote` 走不到「写回终态」分支，`forgetRemoteOwner` 不触发，账本条目要等 12 小时
TTL。现在 `syncRemote` 在拿到快照后先扫一遍板上终态任务，命中账本就清掉（其它条目保留）。

### 15.6 测试

- `board-server-smoke.py` 17/17（默认跑仓库副本，health 含 `build`）。
- plugcheck `tools=16 routes=13`；ui-guard 9/9（doctor 外部 Host 403、回环 200）。
- reload-smoke：A/B/D 覆盖正常装载、降级装载、单条撞名；C 仍验证非 duplicate 失败时整体回滚。
- dispatch-recovery 76/76（新增 R25：板上终态 → 账本清理）。
- state-file 16/16；acceptance（fixtures）11/11。

### 15.7 部署顺序

1. `scripts/install-board.ps1` 部署并重启板子；核对 health 的 `build` 与源文件 sha256 前 12 位一致。
2. 重启 DSH 装载插件（热重载现在不会回滚，但旧路由仍在，等于没换）。
3. 打开面板看 doctor：`routes` 消失、`board-stale` 正常刷新、`dispatch` 不报错。
4. 派一条 e2e 任务确认三类都活着（host 派 → 副机跑 → 板子终态）。

## 16. v1.4.1：配置第二层兜底（2026-11-09）

### 16.1 触发

2026-11-09 22:57，profile 的 `cordis.patch.yml` 被外部重写成 889 B / 4 条，
`- id: team` 与 `- id: remote-agent` 整块消失（当天第二次；第一次在 20:10）。
后果：team 没有 token → 板子 401；hub 退回默认 `127.0.0.1:19387` → 两台副机全掉线。
`dsh-remote-agent` 本有 `~/.dsh-remote-agent/instance.json` 兜底，但该文件从未生成；
team 则完全没有兜底。

### 16.2 机制

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 第一层（原有） | `cordis.patch.yml` 的 `- id: team` 块 | 用户/设置页显式配置 |
| 第二层（新增） | `<stateDir>/config.json` | 白名单 9 键；loader 显式给值则以它为准并回写存档，缺省用存档 |

- `stateDir`：`DSH_TEAM_STATE_DIR` 覆盖，否则 `~/.dsh/dsh-team`（与 journal/账本同目录）。
- 白名单：`token`、`boardUrl`、`machine`、`dispatchRole`、`allowedRoots`、
  `dispatchApproval`、`timeoutMs`、`shellTimeoutMs`、`maxOutputBytes`。
- doctor 增加 `config-saved`（warn，列出哪些键来自存档）与 `configSource: patch|saved`。
  看到这条 = patch 又被重写了，恢复 patch 后警告消失。
- remote-agent 侧补了 `~/.dsh-remote-agent/instance.json`
  （`role: hub`、`listenHost: 0.0.0.0`、`listenPort: 19387`、`nodeToken`，ACL 仅本人），
  即使 patch 丢了 `remote-agent` 块，hub 也会按存档起在 19387。

### 16.3 测试

- `scripts/config-persist-smoke.mjs` 9/9：C1 空配置全走存档、C2 显式值覆盖、C3 混合。
- dispatch-recovery 76/76（该脚本改用临时状态目录，避免场景间继承 `dispatchRole`）。
- 其余同 15.6：plugcheck 16/13、reload A/B/C/D、state-file 16/16、ui-guard 9/9、
  board-server-smoke 17/17、acceptance 11/11。

### 16.4 仍未做

- 没查清是哪个宿主组件在重写 patch。下一步：启动时对比 canonical 副本
  （`~/.dsh/cordis-patch-good-*.yml`），缺块即恢复并在 doctor 报 error。

## 17. v1.4.2：doctor 假警报与测试隔离（2026-11-11）

### 17.1 触发

v1.4.1 重启后 doctor 一直报 `config-token 没有配置板子 token`，但板子读写、派工、同步都正常；patch 与 `~/.dsh/dsh-team/config.json` 里 token 都在。

### 17.2 根因

doctor 的检查写的是 `if (!cfg.boardToken)`，而配置字段一直叫 `token`（全仓库仅此一处 `boardToken`）。所以这是**纯显示层 bug**：配好了也永远报错，实际鉴权走的是 `cfg.token`。

### 17.3 修法

- `lib/index.js`：`cfg.boardToken` → `cfg.token`。
- `scripts/ui-guard-smoke.mjs`：apply 传了 token 后，断言 `doctor.checks` 不含 `config-token`（回归测试）。

### 17.4 同时修掉的测试污染

`reload-smoke.mjs` / `ui-guard-smoke.mjs` 会 `apply` 插件，插件把有效配置写回 state dir；这两个脚本此前没设 `DSH_TEAM_STATE_DIR`，于是把 `token: 'x'`、`machine: 'ui-guard-smoke'` 写进了真实 `~/.dsh/dsh-team/config.json`，下一次启动的兜底会读到脏值。现在两者都在 apply 前 `mkdtemp` 一个临时目录并设 `DSH_TEAM_STATE_DIR`。

### 17.5 验证

plugcheck 16/13；ui-guard 10/10；reload A/B/C；state-file 16/16；config-persist 9/9；dispatch-recovery 76/76；board-server-smoke 17/17；acceptance 11/11（fixtures）。


## 18. v1.5.0：Solo 自举（2026-11-11）

### 18.1 触发

用户从插件市场装完 dsh-team 直接启用，profile 里没有 team 配置（市场安装不带配置），面板全空、板子 401。要跑起来得同时凑齐三样：一台机器跑 Python 板子、拿到 board token、手改 `cordis.patch.yml`。PC2 上就是这样卡住的——不是用户操作错，是首次启用路径不存在。

### 18.2 设计：两档板子

| 场景 | 板子 | 启动方式 |
| --- | --- | --- |
| 单机 / 第一次用 | `lib/solo-board.mjs`（随包 Node） | 插件零配置时自动起在 `127.0.0.1:<随机端口>` |
| 多机团队 | `tools/board_server.py` | 宿主机常驻进程 + 共享 token（`scripts/install-board.ps1`） |

solo 只实现 solo 需要的子集（create/claim/take/untake/attach/mark/beat/release/caps/metrics/say/seen），语义对齐 Python 板子（`take` 守 `dispatch=auto`、holder 冲突 409、mark 身份校验与状态白名单、release 归属、caps 8KB / metrics 4KB 上限）。**只绑 127.0.0.1**，token 随机生成并 `timingSafeEqual` 比较，状态写 `<stateDir>/solo-board.json`（tmp+rename、0600）。

### 18.3 行为

- 触发条件：`!cfg.token && !cfg.boardUrl`；`DSH_TEAM_SOLO=0` 或配置 `solo: false` 可关。
- 启动后把 token/boardUrl 写进第二层配置 `~/.dsh/dsh-team/config.json`（v1.4.1 的兜底机制），并 trace `solo 板子已启动 …`。
- doctor 增加 `solo` 信息项与响应字段 `solo`；有 solo 板子时不再报 `config-token`。
- cleanup 关闭监听；状态文件保留，下次启动任务还在。

### 18.4 测试

`solo-board-smoke.mjs` 10 项、`solo-bootstrap-smoke.mjs` 5 项全过；回归 plugcheck 16/13、reload A/B/C/D、ui-guard 10/10、state-file 16/16、config-persist 9/9、dispatch-recovery 76/76、board-server-smoke 17/17、acceptance 11/11。

### 18.5 边界与下一步

- solo 只在进程内、只本机可用，**不能**替代多机作业板；接团队仍要 Python 板子 + token。
- 邀请码（打包 boardUrl+token+hubUrl+nodeToken）与首次启用向导尚未做，下一版再做。
- 已知限制：同一台机器多个 DSH 实例各起一个 solo 板子，任务互不可见（solo 的定位就是单实例）。

### 18.6 部署

插件改动需重启 DSH 才装载（热重载会撞 duplicate route）；solo 板子随插件启停，无需额外进程或 Python。

## 19. v1.5.2：内网候选地址下线 + set-team-config（2026-11-11）

### 19.1 触发

市场第一次复验还留了一条：`lib/index.js` 的 `BOARD_CANDIDATES` 硬编码了作者的局域网地址（`<host-pc>:8965`、`<board-host>:8965`）。公开包里不该带作者内网信息；自动探测也不该把请求打到别人家网段。

### 19.2 修法

默认候选只剩 `http://127.0.0.1:8965`；内网/远程地址用 `DSH_TEAM_BOARD_CANDIDATES`（逗号分隔）或 `DSH_BOARD_URL` 指定。显式 `boardUrl` 仍然最优先，行为对已配置的机器无变化。

### 19.3 set-team-config.ps1

手粘 YAML 时聊天工具会替换引号（直引号变弯引号），PowerShell 字符串不闭合，终端卡在 `>>`。脚本改为按行 upsert：

- `-List`：列 profile、team 块数量（0/1/重复）；
- `-Profile foo -BoardUrl ... -Token ... -Machine PC2 -Role observer`：更新已有块或追加新块，写前 `*.bak-setteam-*`，写后复核；
- `-DryRun`：只打印。

### 19.4 验证

AST 解析通过；临时 profile 上「更新已有块」「追加新块」两条路径实测通过；回归 16/13、10+5、76/76、17/17、11/11。

## 20. v1.5.3：R21 的时序依赖与 holder 语义的真板子覆盖

### 20.1 现象

v1.5.2 的 CI 只有 `ubuntu-latest` 红，失败点是 `dispatch-recovery-smoke` 的 R21：
`FAIL R21 第二个实例被 holder 挡住 — holderConflict=0 take=1`。本地 Windows 复跑多为绿，
所以它不是「代码坏了」，而是**测试断言绑在时序上**。

### 20.2 根因

R21 起两个实例 A/B 抢同一条 queued 任务，断言「B 必须拿到 409」。但 A 先 `take` 成功后，
任务状态变成 `claimed`；插件派工候选过滤只取 `queued/stale`（`lib/index.js` 的
`(t.status === 'queued' || t.status === 'stale') && !t.remote`），B 直接跳过这条任务，
根本不会发第二次 `take`——于是 `holderConflict` 是 0 而不是 1。两个 tick 的相对快慢
决定了走哪条分支，runner 越快越容易跳过。

### 20.3 改法

- 断言改成可观测结果：`dispatch === 1 && remoteTasks.length === 1`（只派一次、
  远端只有一条），时序值只放进失败信息里。
- 把「同机不同 holder 的 409」搬到真板子的 `board-server-smoke.py`：create 一条
  `dispatch: "auto"` 的任务，实例 A `take` 成功，实例 B `take` 必须 409
  「已被同机的另一个实例占住」。fake-board 早就有这条，真板子此前没覆盖。
  注意 `/api/create` 不传 `dispatch` 时默认不是自动派发，`do_take` 会先以
  「不是自动派发任务」拒绝——用例必须显式写 `dispatch: "auto"`。

### 20.4 验证

dispatch 76/76；board smoke 19 项全过（含新增两条）；其余回归见 CHANGELOG v1.5.3。

## 21. v2.0.0：改名 dsh-job-board（以及 PC2 装不上的原因）

### 21.1 为什么改名

npm 上的 `dsh-team` 已被另一个「Agent Teams」插件占用（0.2.11），`dsh plugin add dsh-team`
或市场按名字解析时拿到的不是这份代码；PC2 上「卡着装不上」很可能就是这一步没有明确报错、
但装出来的包名/版本对不上。`dsh-ops-board` 在 GitHub 也有同名项目，最后选 `dsh-job-board`。

### 21.2 改了什么

- 仓库 `shaot92-del/dsh-team` → `shaot92-del/dsh-job-board`（GitHub 会重定向旧地址）；
- `package.json`：`name`、`repository`、`bugs`、`homepage` 全部改到新名字，版本 **2.0.0**；
- README 的安装命令、bundles 说明跟着改；profile 依赖改成
  `dsh-job-board: file:D:/gp_video/dsh-job-board`。

### 21.3 有意没改

`~/.dsh/dsh-team` 状态目录、`DSH_TEAM_*` 环境变量、patch 实例 id `team`、工具名
`board_*`/`sh_*` 全部保留——它们不是安装标识，改了只会让老配置与历史数据失效。

### 21.4 PC2

改名后重新按 `github:shaot92-del/dsh-job-board` 装；装前把旧的 `dsh-team` bundle 从
profile 的 `dsh.profile.bundles` 与 dependencies 里去掉，避免两个包同时加载抢同一批路由。

### 21.5 v2.0.1：漏改的 bundle patch name

`package.json` 的 `name` 决定 npm 包名与安装目录；**loader 决定加载哪个模块，看的是包内
`cordis.patch.yml` 里 `- insert: - name: '...'`**。v2.0.0 只改了前者，后者仍是 `dsh-team`：
- 本机看不出问题，是因为 profile 里原来就装着 `dsh-team`，旧实例继续跑；
- PC2 从 git 装了 `dsh-job-board`，patch 却让 loader 去找 `dsh-team`，于是「装上了但名字
  还是旧的 / 起不来」。

v2.0.1 把这一行改成 `dsh-job-board`。判断一个包到底会被哪个名字加载，看
`node_modules/<包>/cordis.patch.yml` 的 `name`，不是看目录名。

## 22. v2.0.2：审计修复与 PC2 启动事故

### 22.1 事故：改名后客户端起不来

`lib/client.js` 的 client bundle `id` 仍是 `dsh-team`。DSH 客户端按包名解析 client 模块，
`dsh-job-board` 这个包注册了 `dsh-team` 的 id，重启后界面挂住，只有屏蔽插件才能启动。
主机一直跑着 11 号加载的旧实例，所以没暴露；PC2 全新安装立刻踩到。

修法：`id: 'dsh-job-board'`，与 `dsh-remote-agent` 的写法一致。教训：**改名要同时改三处**
——`package.json.name`、`cordis.patch.yml` 的 `- name`、client bundle 的 `id`。

### 22.2 solo 重启失联

solo 板子 `port: 0` 随机端口，第一次启动把地址写进 `config.json`；重启后旧逻辑看到
`cfg.token` / `cfg.boardUrl` 就认为「已配置」，不再起板子，面板指向死端口。

修法：`persistTeamConfig` 写 `solo: true`；`soloRequested` 在存档 `solo` 为真时仍然成立，
并沿用存档 token 重新起板子、回写新地址。判据优先级：loader 显式 `token`/`boardUrl`
> 存档 `solo:true` > 空配置。回归：`solo-bootstrap-smoke` 的 B6/B6b（同一状态目录二次 apply）。

### 22.3 其余三处

- `solo-board.mjs`：`claim` 对不存在的任务返回 404（以前 `|| {status:'queued'}` 造任务）；
  `create` 增加 `MAX_TASKS = 5000`。
- `set-team-config.ps1`：`YamlQuote` 拒绝换行、转义单引号；写盘改 tmp + `Move-Item -Force`。
- `shell.js`：空白名单从 fail-open 改 fail-closed（需显式 `allowAllRoots: true`）；
  子进程环境变量改为白名单透传（`ENV_KEEP` + `envPassthrough`），不再带出模型 key / 板子 token。

### 22.4 测试

新增 `scripts/shell-guard-smoke.mjs`（G1–G4）；`solo-board-smoke` 增加 S3b；
`solo-bootstrap-smoke` 增加 B6/B6b。全量：plugcheck 16/13、reload A/B/C/D、ui-guard 10/10、
state-file 16/16、config-persist 9/0、dispatch 76/76、board smoke 19 项、acceptance 11 项全过。

### 22.5 PC2 的恢复路径

1. 先在**不启动 DSH** 的情况下改 profile（或直接删掉旧包）：
   `C:\Users\17827\.dsh\profiles\<名字>\node_modules\dsh-team` 整个删掉；
   profile 的 `package.json` 里 `dsh.profile.bundles` / `dependencies` 去掉 `dsh-team`。
2. `dsh plugin add github:shaot92-del/dsh-job-board`（2.0.2 起 client id 正确）。
3. 启动 DSH，打开面板看 doctor：应显示 `version=2.0.2`，没有 `config-token` 报错（solo 自举）。
4. 若仍起不来，把 `%LOCALAPPDATA%\DeepSeek Harness\logs` 或 `_runtime.log` 的最后 80 行发我。

### 22.6 仍未做

- `install-board.ps1` 按端口杀进程、带空格路径的处理（低危，下一批）。
- solo 快照未脱敏、`say '?'` 幻影机器（低危）。

## 23. v2.0.3：专家复审后的修复

两位专家对 v2.0.2 的复核结论集中在「自举状态机」和「配置接线」两处：

- solo 意图不能靠运行时的 `!!soloBoard` 推断（首次写档时板子还没起来），否则一次
  启动失败就把存档永久降级成 `solo:false`。现在存档里单独记 `solo` 意图，
  兼容 2.0.1 的「有 token + 回环 boardUrl、无 solo 键」旧档。
- `allowAllRoots` / `envPassthrough` 加了 `cfg` 与 `TEAM_CONFIG_KEYS`，但忘了传给
  `registerShellTools` —— 配置写了也不生效。测试改为从 `apply` 走完整链路（G5/G5b），
  不再直接调 `registerShellTools` 绕过接线。
- v2.0.2 把 solo 的 `claim` 改成 404 是错的：Python `do_claim` 允许认领未知任务并建单，
  这是 Host 统一派工占位用的。本版恢复自动建单，并对 `create` 增加 id 格式与活跃数上限。
- 终态任务不再占任务上限：加载时清理 30 天前终态，`MAX_ACTIVE_TASKS` 只算活跃。
- 任务表用 null 原型 + `hasOwn`，避免 `__proto__`/`constructor` 造幻影任务。

## §24 v2.0.5：PC2 的两个现场问题

2026-11-12 凌晨，PC2（<worker-3-host>）作为副机接入后暴露两个问题。结论先写在这里，
以后遇到「刚装好的机器不对劲」先按这两条排查。

### 24.1 左侧「远程同事」入口又出现了

- 作业板没有新增这个面板。它来自 `dsh-remote-agent` 的 client bundle：
  `lib/client.js` 里 `SHOW_REMOTE_PANEL` 为 true 时会注册 `sidebar.panellist` 与 `main`。
- 0.9.12 的这份文件里是 `const SHOW_REMOTE_PANEL = false`。PC2 上 `package.json`
  写着 0.9.12，但 `lib/client.js` 没有这一段 —— 典型的「只换了一半的文件」。
- 处置：用主机的 `node_modules/dsh-remote-agent/lib/client.js` 覆盖 PC2 同名文件
  （原文件留 `client.js.bak-panel`），刷新页面即消失；不需要重启 DSH。
- 作业板自己的 DOM 隐藏（每 1.5s 扫一次 + MutationObserver）只是兜底，不能替代
  插件侧开关：bundle 没加载或 DOM 结构变了它就失效。

### 24.2 第一次安装「拉不起模型」

- 全新 profile 的 `cordis.patch.yml` 往往只有几条 client UI 配置，没有
  `agent-default-model` 块。DSH 于是退回默认路由 `deepseek-official`；那台机器上
  没有 API key，agent 任务就报 `no API key for provider route "deepseek-official"`。
- `pc2-onboard.ps1` 现在会在写完 team / remote-agent 后补一个
  `agent-default-model` 块（`provider: deepseek-account`、`model: deepseek-flash`、
  `reasoningEffort: max`）。账号仍要在这台机器的 DSH 里登录一次，脚本不代持凭据。
- 只补块不登录时，报错会从 `no API key` 变成 `DeepSeek Messages transport failed`
  （PC2 实测 443 可达，所以更像鉴权/登录问题，不是网络）。
- 插件 v2.0.5 起，`syncRemote` 把副机失败写回看板时会识别
  `no api key` / `no key for provider` / `transport failed` / 裸代码 `TRANSPORT`，
  在原始报错后追加一句「该副机模型不可用（未登录/未配置，或网络不通）……」。
  提示文案故意同时覆盖鉴权与网络两种可能，不替操作者下结论。
- 回归：R26（message 形式）、R26b（只有 code=TRANSPORT）、R26c（未知状态不写回）。

### 24.3 这一版没做什么

- 没有自动替副机登录账号，也没有跨机复制凭据 —— 凭据走 DSH 自己的 credential store，
  跨机复制既不安全也不一定可用。
- 没有把 `pc2-onboard.ps1` 收进仓库：它含 board token 与 nodeToken，只应存在于
  受控共享目录；仓库里只保留说明与 `set-team-config.ps1` 这类不含秘密的工具。

## §25 v2.0.6：第二轮审阅的 P2 批次

### 25.1 七项与修法

| # | 问题 | 修法 |
|---|------|------|
| P2-7 | Solo `machines` 可被 `__proto__` 污染；`__proto__` 任务在快照里消失 | `Object.create(null)` + `hasOwn`/`getTask` |
| P2-8 | untake 不校验 holder，同机另一实例可抢回 | untake 比较 holder，不同则 409；未提供 holder 时保持兼容 |
| P2-10 | solo 的 listen 还没完成就被 cleanup，留下孤儿监听 | `soloAbandoned` 置位，回调里 close |
| P2-11 | `uiAllowedHosts` 只在 guard 里读，配置没这个键 | cfg + 持久化 + 合并 + guard 的 Set |
| P2-12 | `sh_run` 的 cwd 不存在时静默回退 | 先 statSync 校验，直接报错 |
| P2-13 | 白名单是盘符根时子路径被误拒 | realpath + path.relative 判定 |
| P2-14 | 同 state 不同端口可双开 | 锁名只按 state 的 realpath |
| P2-15 | `MAX_TASKS` 只对 seed 生效 | create 与 claim 建单都检查，支持环境变量覆盖 |

### 25.2 测试

- S9/S10、G6/G7、ui-guard 12/12、board smoke 23 项（新增 P2-14/P2-15）。
- 全量回归同 v2.0.5 清单。

### 25.3 留到 v2.0.7

- P1-5：过期恢复日志按轮次重建，需要把 `dispatchJournal` 的 `attempts` 与远端 `remote_id`
  一起入档，并在 reconciler 里按轮次比对；这一版没有动，避免把恢复语义改坏。
- P2-9：终态同步只取 hub 最近 200 条，需要给 hub 加分页/时间窗参数。

### 25.4 这一版没做什么

- 没有改 `uiAllowedHosts` 的默认值：空数组仍然只允许回环，内网访问必须显式配置。
- 没有把 `MAX_TASKS` 的默认值调小：5000 是总量，solo 的终态清理逻辑在 v2.0.3 已有。

## §26 v2.0.7：P1-5 / P2-9 / 终态修剪

### 26.1 三项与修法

| # | 问题 | 修法 |
|---|------|------|
| P1-5 | 过期恢复日志按 goal + 时间下界匹配，会绑定同 goal 的新任务或已被占用 remote | 统一 `dispatchMatchWindow` + `matchRemoteCandidates`：上下界、排除 matched/occupied、已回绑只清账、多候选推迟 |
| P2-9 | hub `/tasks` 只回最近 200 条，被挤出窗口的任务永远 running | 缺失项做有限并发 4 的单条 `/task?taskId=` 查询；`task-unknown` 才标 failed，查询失败不动 |
| P2-9b | Python `MAX_TASKS` 统计全部任务，终态不回收 | 容量检查前 `prune_terminal_tasks()` 清 30 天前 `done/failed/blocked/superseded` |

### 26.2 为什么 P1-5 不按轮次重建

审阅建议把 `attempts` 与远端 `remote_id` 一起入档、reconciler 按轮次比对。实际实现里
journal 的 `attempts` 只增不减，远端任务不携带"第几次派发"字段，按轮次比对需要改
remote-agent 协议。当前实现用**时间窗 + 占用集合 + 唯一性**达到同样目的：宁可推迟
（60 秒后重判）也不猜一条。

### 26.3 测试

- R27：`hidden` 远端任务（列表里没有）仍能通过单条查询收尾。
- R28：同 goal、时间在 3 小时前，但 remote 已被 `bd-other` 占用 → 不 attach、不改绑。
- R29/R29b：单条查询返回「非 task-unknown 的 404」或连接被掐断 → 不允许判死，
  板上仍 running、无 mark（对应 `probeRemoteTask` 的三态契约）。
- P2-16：3 条 40 天前终态 + `GP_BOARD_MAX_TASKS=2` → 先修剪，create 200。
- 其余回齐全绿。

### 26.4 已知边界

- 单条查询的并发是 4；`watched` 很长时会串行多轮，但每轮最多 4 个请求。
- `prune_terminal_tasks` 以 `updated_at` 为准；老状态文件没有该字段的任务不会被清。
- 被标 failed 的"远端已不存在"依赖 hub 明确回 `task-unknown`；旧 hub 的通用 404 不动。

---

## §27 v2.1.0：派工时的机器 + 模型选择

### 27.1 为什么做

看板以前只有机器维度，模型一律跟随副机默认。PC2 上出现过 62K tokens 的任务被塞进
32K 上下文的模型，报 `request exceeds the available context size`，在板上只表现为
"派工失败"。模型必须成为可选择的派工参数，而不是碰运气。

`dsh-remote-agent` 的 `/dispatch` 早就支持 `model`（`normalizeModelSelection` 接受
`provider/model`、裸名或对象）；缺的是看板侧：任务表没有字段、工具没有参数、面板没有下拉。

### 27.2 数据流

1. 任务：`/api/create`、`/api/claim`、`/api/seed` 接受 `model`（≤160 字），板子原样保存；
2. 派发：插件调度器取 `task.model || cfg.defaultModel`，写进 `/dispatch` 的 `model`；
3. 选型：`board_options` 汇总在线节点上报的 `models` / `defaultModel`，面板的派工弹窗
   与对话都可以用它；
4. 对话：`board_dispatch` 在 `dispatchAsk`（默认 true）下，机器或模型没选全时返回
   `needSelection: true` + 候选，不建单；调用方用 `ask_user_question` 问人后带
   `machine` + `model` 重调。

### 27.3 配置

| 键 | 默认 | 作用 |
|----|------|------|
| `defaultModel` | 空 | 派发时的兜底模型；空=跟随副机默认 |
| `dispatchAsk` | true | 对话派工未选全时先返回候选；false=跳过检查 |

两者都进第二层配置存档（`~/.dsh/dsh-team/config.json`），`set-team-config.ps1` 支持
`-DefaultModel`。

### 27.4 边界

- `exec` 模式与模型无关：不要求选模型，也不会把 model（含 `defaultModel`）传给 remote-agent。
- 副机必须注册 OpenAI 兼容 provider，模型才会出现在清单里；没有清单时退化为
  「跟随副机默认」或手填。
- 模型上下文上限不会被自动规避：小模型跑长任务仍可能超窗，插件只在终态 note 里补提示。
- 对话派工**先问机器**：`dispatchAsk` 打开时没给 `machine` 一律返回候选（给了模型也一样）；
  指定机器后，只有该机上报了模型清单才要求选模型，没清单的机器直接跟随副机默认。
- 给了机器 + 具体模型时**会**在插件侧核对目标机清单（拼错/该机没有的模型直接拒绝并
  返回 `available`）；`model: "auto"` 跳过选型、跟随副机默认。清单取不到时只给 warning，
  不阻断（避免 hub 抖动导致派不出去）。
- `needSelection` 用 `ok: true` 表达；调用方看到它应当发问，而不是报失败。
- `dispatchAsk` 只挡对话里的 `board_dispatch`；后台自动派工（队列里的 `dispatch=auto`）
  不经过它，不会被半夜卡住。

### 27.5 机器显示名（v2.1.0 追加）

- 身份键 `machine` 不随显示名变化：任务归属、`remote-owners-*.json`、`pending-attach-*.json`、
  恢复日志都以它为准；改显示名不会让在跑的任务"换机器"。
- 新增 `machineAlias`（≤32 字，空=电脑名），随 caps 一起上报；板子机器表里以
  `caps.alias` 保存，快照额外给 `name`，`board_options` 与面板都用 `name` 显示。
- 显示名只用于**查找与展示**：`/api/board/ui/create`、`board_dispatch`、`board_attach`、
  `/api/board/ui/attach` 都先按身份名精确匹配，再按显示名匹配，最终写进任务的永远是
  身份 id；未知名字返回 400 而不是静默入库。板子侧 `_canon_machine` 同样认 `caps.alias`，
  `do_attach` 对看起来像显示名的未知值直接 400（不会 `touch_machine` 出 ghost）。
- 改名做唯一性校验（与别的机器的身份名/显示名比较），写档失败返回 500；C0/C1、零宽、
  bidi 控制符在入口与存档回读时都会清掉。板子 `do_caps` 也做唯一性校验（409）；
  板子不可达时改名仍生效，但返回 `unique:"unverified"` + warning。
- 改名走 `POST /api/board/ui/alias`（JSON `{alias}`，同样过 Host/Origin/自定义头/JSON 闸门），
  成功后立即 `reportCaps({force:true})` 刷新板子；失败不影响改名本身（只在返回里 reported=false）。
- 删除 client 里写死的机器名对照表；未知机器名按板子上报的名字显示，不再被本机固定表改写。
- 边界：两台机器同名仍会被板子当成同一台（身份键相同）；要区分必须改 `machine`（配置），
  改之前先停派工并清空未完成任务。

### 27.6 测试

- `scripts/model-pick-smoke.mjs` M1–M11：options 汇总、未选机器/未选模型拦截（`ok:true`
  + `needSelection`）、只给模型仍先问机器、机器无清单不要求选模型、建单带 model、
  `model:auto` 放行且不写 model、目标机没有的模型被拒并返回 available、exec 忽略 model、传显示名派工时 `task.machine` 仍是身份名、`board_attach` 传显示名时 `/api/attach` 的 machine 也是身份名。
- `scripts/dispatch-recovery-smoke.mjs` **R30**：任务带 `model` 时 `/dispatch` 的 body
  必须带 `model`（直接抓 `snapshot()` 漏字段这类回归）；当前 **88/88**。
- `plugcheck` 工具数 16 → 17；测试配置显式 `dispatchAsk: false`。
- `scripts/board-server-smoke.py` 新增 B1：显示名折回身份、任务 machine 落身份、无 ghost、
  未知显示名 attach 400、重复显示名 409；当前 **38 项**。
- 全量回归见 CHANGELOG；`board_options` 的返回在 27.2 的数据流图里。

## 28. v2.2.0 看板操作补全

### 28.1 触发

用户在使用面板时提出五件事：移除不在线的机器、给别的机器改名、展开任务详情、评估完把评估卡收起来、自检横幅没事不要弹。都属于“面板能用”而不是协议层的改动，单独发一版。

### 28.2 行为

| 操作 | 入口 | 后端 | 约束 |
|---|---|---|---|
| 移除离线机器 | 机器卡片「移除」 | `POST /api/board/ui/forget-machine` → 板子 `/api/forget-machine` | 仅 `last_seen` 超过 `ONLINE_WINDOW`；在线需 `force`（面板不给）；任务记录不删 |
| 改别的机器显示名 | 机器卡片「改名」 | `/api/board/ui/machine-alias` → 板子 `/api/alias` | 清洗 + ≤32 字 + 跨机唯一；只写 `caps.alias`，身份 `machine` 不变 |
| 改本机显示名 | 顶部「改名」 | 本地 `/alias`（写 `cfg.machineAlias`） | 重启后仍生效；板子侧 caps 上报覆盖 |
| 任务详情 | 点任务标题展开 | 无 | 模型/模式/远端 id/占位/目标/进度 + 复制 JSON |
| 评估卡 | 完成后自动收起；工具栏「评估」重开 | `/assess` | 成功才收；失败保留 |
| 自检横幅 | 只渲染 error/warn | `/doctor` | `config-saved`、部分离线、暂停、machine 为空降为 `info` |

### 28.3 为什么移除要限制离线

机器条目同时承载 `last_seen`、`caps`、`current`。在线机器被移除后，下一次心跳会重新建条目，看起来“删了又回来”，还会丢掉 `current` 的占用状态。所以默认只允许删离线；在线必须显式 `force`，面板不提供这个入口。

### 28.4 测试

- `scripts/board-server-smoke.py` **45 项**（新增：改显示名 200、快照出现新名、撞名 409、在线移除 409、`force` 200、移除后快照没有该机）。
- `scripts/reload-smoke.mjs` 路由 **16**（场景 D 15）；`plugcheck` 17 工具 / 16 路由。
- 其余套件见 CHANGELOG v2.2.0。

## 29. v2.2.1 复审修补

### 29.1 显示名所有权

板子是显示名的唯一真相源：`do_caps` 只在目标机还没有显示名时接受它作为种子，之后不再覆盖；本机改名走 `/alias` → 板子 `/api/alias`，撞名回滚本地。唯一性比较统一为 `_alias_key`（去控制/零宽/bidi、只留字母数字、casefold），身份名与显示名一起比。

### 29.2 改名不当心跳

`do_alias` 只写 `caps_at`，不调 `touch_machine`；否则给离线机器改名会让它在线 20 分钟，期间「移除」按钮消失、接口 409，正好卡死要清理的僵尸卡。

### 29.3 失败路径

评估失败保留评估卡；终端任务禁用交付/打回；复制 JSON await + 回退；`cardBusy` 按机器记录；`force` 严格布尔；改名/移除补审计事件。

### 29.4 仍未做

- 面板反馈仍在顶部 notice（长列表时可能滚出视口）；
- 本机改名输入行仍在面板顶部，部分场景需要滚动才能看到；
- 任务详情展开仍是 `<span onClick>`，键盘可达性未补；
- 32 字符上限在 UTF-16 code unit 与 Python 码点之间仍有边界差异；
- 板子没有按机器/角色的授权，持共享 token 仍可改任意机器（能力扩张，记录在案）。


## §30 v2.2.2 评估卡修复（2026-11-13）

### 30.1 现象与根因

- 面板点“开始评估”后卡片消失，但重开仍是“未评估”。
- `POST /api/board/ui/assess` 缺 `content-type: application/json`，被 `uiGuard` 以 403 `{"error":"forbidden","why":"content-type"}` 拒绝；客户端未检查 `ok`，误当成功。
- 真实身份文件 `C:\Users\17827\.dsh-board\identity.json` 曾被 `ui-guard-smoke` 写成 `machine=ui-guard-smoke`，与运行配置的 `host` 不一致，`needsAssessment` 恒真。

### 30.2 修法与验证

- 请求补 JSON 内容类型与空对象 body；失败保留卡片。
- 两个 UI 冒烟脚本隔离 `DSH_TEAM_IDENTITY_DIR`，跑完删除。
- 真机重新评估后 `identity` 返回 `assessed:true, needsAssessment:false`；重启 DSH 后以新客户端为准。

### 30.3 边界

- 评估结果仍只写本机；多机各自的评估互不影响。
- 测试隔离只覆盖 UI/reload 两个脚本，`acceptance` 已用独立 identity 目录。

## §31 v2.2.3 版本提示与幻影机器（2026-11-13）

### 31.1 现象

- 面板横幅仍显示「插件 v2.1.0」，而磁盘已部署 2.2.x；评估修复、移除、改名都要重启 DSH 才生效。
- 板子上出现一台 `?` 的永远离线机器，把在线数从 3/3 算成 3/5。
- 旧实例没有 `/api/board/ui/forget-machine`，面板移除自然失败。

### 31.2 修法

- doctor 增加 `version-skew` 检查并返回 `installedVersion`；面板横幅显示「磁盘已装 vX，重启后生效」。
- `do_say` 对空机器名/`?` 不再建机器；面板列表防御性过滤 `?`。
- 现存 `?` 与离线 MB14 已从板子移除，在线数恢复 3/3。

### 31.3 边界

- 版本提示同样只在**新版本加载后**才出现；当前这一轮仍需要一次重启才能进入 2.2.x。
- 幻影机器移除后若旧实例再次 `say`，会再次出现；板子重启后由新代码拦住。

## 32. v2.3.0：失败重派、任务成果与更新提示

### 32.1 触发

失败任务过去只能人工重新描述一遍；远端其实已有产物与错误信息，但面板只显示一行 note。v2.3.0 把「看清楚为什么失败」和「按原参数重派」做成闭环。

### 32.2 重派语义

| 任务状态 | board_retry |
| --- | --- |
| failed / blocked / superseded | 允许，复制 goal/title/machine/mode/model/workspace，note 写「重派自 <原 id>」 |
| queued / claimed / running / done | 拒绝（409），避免重复执行或重复交付 |
| 不存在 | 404 |

重派会新建任务 id（`rt<base36>-<随机>`），原任务保留可追溯；模型留空时继续跟随副机默认。

### 32.3 任务成果

任务详情新增产物「复制路径」；note 命中常见失败模式时给出诊断提示（模型未登录、上下文超限、工作目录不可达、超时、网络）。诊断只做提示，不改写原始 note。

### 32.4 更新提示

`/api/board/ui/update-check` 只读 npm registry 的 `dsh-job-board@latest`，3 秒超时、10 分钟缓存，失败只记录错误；doctor 以 info 级呈现「有新版本」。不自动安装、不下载、不执行远端脚本。实际发布仍需维护者本机 `npm login`，本次版本未发布到 npm。

### 32.5 测试与边界

plugcheck 18 工具 / 18 路由；model-pick M1–M11 + R1–R4；dispatch 88/88；board smoke 48 项；acceptance 10+1。边界：重派不校验目标机当前是否在线（由板子派工阶段决定）；更新检查在离线环境静默失败；重派不复制远端产物的物理文件。

## 33. 发布门（2026-11-13 用户定）

从 v2.3.0 之后开始，任何推仓库 / 市场更新 / npm 发布前必须先过两道外部审核，再由主控自检：

1. AI 生成代码安全审计师审 diff；
2. 代码审查工程师审 diff；
3. 主控自检（secrets、危险构造、全量测试、部署一致性）。

只有无未决 P0/P1 才允许发布。审核结论要落进提交说明或 docs。v2.3.0 在规则确立前已推送，按新规则补做追溯审核；如发现问题进 v2.3.1。

## 34. v2.3.1：发布门后的复审修复

### 34.1 复审结论

v2.3.0（8aad59e）在发布门确立后被追溯审核：安全审计 0 P0 / 2 P1 / 5 P2，代码审查 FAIL（2 个 P1）。P1-A 是重派漏 `dispatch:auto`，P1-B 是更新提示把用户引向未注册的 npm 包名；代码审查另指出更新提示在面板不可见。

### 34.2 修法

- 重派抽成 `retryBoardTask()`，工具与路由共用；建单 `dispatch:'auto'`，活跃副本去重，机器名归一，状态码透传。
- 面板新增更新提示行；doctor 保留 info 与 `latestVersion`。
- 去掉 npm 安装命令文案；registry 请求 `redirect:'error'`，错误只落日志。
- 复制产物路径等待 Promise；产物/标题裁剪对齐板子；failureHint 收紧。

### 34.3 边界

`update-check` 仍是 GET，可被跨站 `<img>` 触发一次外呼（3 秒超时、失败 60 秒 / 成功 10 分钟缓存），不构成 SSRF；artifact 只是字符串，没有下载/打开接口。board token 仍是单信任域，per-machine 授权留 v2.4 的安全层。

## 35. v2.4.0 —— 机械调度台与能力卡自检（第一片）

### 35.1 改了什么

- 面板中文名统一为「机械调度台」（标题、侧栏、错误页）；包名、工具名、板子协议都不变。
- 新增只读探测脚本 `scripts/probe-caps.ps1`：CPU / 内存 / GPU / ffmpeg 硬件编码器 / 浏览器 / 本机模型端点，输出 `schema: 2`，不安装、不提权。
- 新路由 `POST /api/board/ui/caps-probe`（本机探测）与 `POST /api/board/ui/caps-apply`（确认后写板子，身份固定 `cfg.machine`）。
- 机器卡新增「配置自检」与结果面板：硬件摘要、待修项、角色四选、高风险未验证模型开关；已有 schema 2 能力卡的机器显示摘要。

### 35.2 边界

- 第一片只做「探测 → 确认 → 保存 → 展示」，不是设计稿里的四步向导；模型用途标签页、云端/局域网/本机三分组、浅色主题、按任务标签自动选型都留后续片。
- 探测结果由本机脚本生成后原样交给板子；板子只存 caps，不执行脚本。caps 中的 alias 仍以板子侧为准，identity.machine 由插件覆写为 cfg.machine。
- `roles` 与 `allowUnverifiedHighRisk` 目前只记录/展示，不参与派工或授权判断。

### 35.3 测试

- 测试：plugcheck `tools=18 routes=20`；model-pick 增 A1（caps-apply 身份固定、字段清洗、角色/模型透传）与 A2（本机探测返回 identity.cpu）；reload/ui-guard（18/18，含 caps-probe 三例）/state/config/solo/shell/dispatch/board smoke/acceptance 全绿。

## 36. v2.4.2 —— 看板 UI 第二片：模型用途、派工分组与主题（2026-11-13）

- **能力卡模型用途**：自检结果面板可编辑每个模型的标签与位置（本机/局域网/云端）；位置只能在**更贵方向**覆盖（local<lan<cloud，防止把云端端点标成免费），其余以 endpoint 自动判定为准（`[::1]` 剥括号、私网只按 IPv4 八位组判断）；重测只保留用户标签，来源/位置用新实测值。
- **派工模型分组**：summary 的 `nodeModels` 按机器二级索引合并 caps 的 `location/tags/source`，下拉分「云端 / 局域网 / 本机 / 其他」；选“自动”只列在线副机交集，且带元数据，不再全落“其他”。
- **主题**：`.dsb-root` 语义 token（bg/bg1/bg2、bd/bd2、fg/fg2、accent/ok/warn/bad + RGB），主面板与内联样式统一改用 token；浅色为独立调色板，默认深色，开关写 `localStorage`。
- **复审修复**：代码复审 1 阻断（浅色核心面不可读，含状态标签浅色专用色与显式 `data-theme="dark"`）+ 4 中（标签草稿、dot/hover token、自动池元数据、缓存失效/重测确认）已处理；低项处理了 `modelsDropped` 提示、能力卡 provider 保留与跨 provider 裸名防护、同名节点合并、详情去重、副标题不计 host；装饰性配色与 `-ModelHosts` 接线未做（已记录）。
- **测试**：plugcheck 18/20、ui-guard 18/18、model-pick M1–M11+R1–R4+A1–A3、dispatch 88/88、board smoke 48、acceptance 10+1。
- **追加修复（代码复审 P1/P2/P3）**：浅色 `.dsb-note/.dsb-lrow .s/.dsb-empty` 取消 opacity；宿主 `--dsw-alias-border-*` 加 fallback；`providerKindOf()` 统一 local/cloud 名单；80 条截断计入 `modelsDropped`；`caps-apply` 保留旧卡 features/os/cores/memGB/gpu；角色沿用旧卡、位置缺省“未定”。
- **未做**：四步向导、`taskKind` 自动选型、eco/boost、云端价格；装饰性配色（桌宠气泡等）未逐一校准；`-ModelHosts` 未接线（接线时需 host 白名单/端口限制/结果长度上限）。

## 37. v2.4.3：安全复审收口（2026-11-13）

### 37.1 背景
v2.4.2 推送后补做安全审计（只读 `b2a4a67..045dafa`）：**PASS WITH FIXES，无 P0/P1**，1 个 P2 + 若干 P3。P2 是能力卡字节预算口径不一致（可复现的 413），其余为硬化项。

### 37.2 修复项
| 项 | 修法 |
|---|---|
| 预算口径（P2） | 板子 `json.dumps(ensure_ascii=False)` 比 `JSON.stringify` 多出分隔符空格，实测 9.26–10.79%，预算 7600 → **7000** |
| `/caps-apply` 无 method 检查（P3） | 非 POST → 405 |
| 探测失败回显 stderr（P3） | 浏览器只收固定文案，detail 进 trace；失败 10s 冷却 |
| `probe-caps.ps1` 多 BOM（P3） | 改回 utf8 no BOM，`#requires` 验证可用 |
| 注释内网 IP（P3） | `<lan-host>` 占位 |
| token 前缀回显（P3） | 改长度 + sha256 前 8 位 |
| `/pet.png` 404 泄露绝对路径（P3） | 固定文案 |

### 37.3 记录但未做
- `-ExecutionPolicy Bypass`：GPO 强制 AllSigned 时行为需目标机实测；未在本轮改。
- caps 单字段长度上限、`/assess` 的 GET 门（既存）、`_runtime.log` 轮转、模型 provider 自报（若将来按 location 计费需服务端事实源）。

## §38 v2.5.0 能力路由第一版（2026-11-14）

### 38.1 改了什么
- 工作大类目录 8 类（`lib/index.js` 的 `WORKLOAD_CATALOG`），首版 open 三项视频工作。
- `scripts/probe-workload.ps1`：固定小样本探测，输出 `{id,unit,value,confidence:measured,workload,measuredAt}`；只读、只写 %TEMP%、不安装不提权。
- 路由：`GET /api/board/ui/workload-catalog`、`POST /api/board/ui/workload-probe`（强制 POST、只测本机、单飞、240s 超时）；结果以旧卡为底合并进 `workloads[]` 后 POST `/api/caps`。
- caps `schema: 2.1`；`caps-apply` 接受并清洗 `workloads[]`，与旧卡合并（同 id 覆盖）。
- `board_dispatch` 加 `taskKind` / `size`：有实测能力时按 `ETA = size/value + 8s` 选机；≤15% 内不换机、取更闲；计算时间（扣 8s 开销）<2s 时不跨机；无实测回退最闲。
- 面板顶栏新增「能力探测」独立入口（与机器卡能力卡配置分开），勾选类别、顺序跑、显示每项结果；只测本机。

### 38.2 边界
- 探测样本是合成的，绝对值不能直接当生产 ETA；首版只用于横向比较，真实历史校准放 v2.5.2。
- 只测运行插件的主机；远程探测（在 GT14/PC2 上跑）需要副机也装 2.5.0，放 v2.5.1。
- 探测不发版、不改系统、不提权；失败只影响该项。
- 读不到旧卡（板子超时/卡不在快照里）时：探测回 503 不写；面板保存会显式让 `snapshot` 失败（不再把 `prevKnown` 当 true），只有用户本次显式提交 models/workloads 时才带这两个键，避免浅合并用空数组清空已有实测（A6 回归）。

### 38.3 测试
plugcheck `18/22`、ui-guard `21/21`、reload A/B/C、model-pick `M1–M11 + R1–R4 + A1–A6`、dispatch `88/88`、board smoke `48`、acceptance `10+1`、state/config/solo/bootstrap/shell 全绿。

### 38.3b CI 环境差异

GitHub `windows-latest` 没有 ffmpeg：A5 真实探测在 CI 里断言「500 + 明确缺 ffmpeg」，本地/有 ffmpeg 的机器仍做实测（v2.5.1）。

### 38.3c 补帧并发采样（v2.5.2）

补帧受内存带宽限制：单流约 4.7–5.0 fps，6 路合计约 11.5–12.1 fps（每流约 2），8 路几乎不涨（报告实测 9.25 vs 9.45）。因此 workload 存 `value`（单流，单个任务用）、`aggregate`（合计，批处理估 wall 用）、`perStream`、`maxStreams`。
- 路数按 `ProcessorCount-1` 收敛到 2–6；并发样本 0.5s；并发段失败只丢并发数据，保留单流值。
- 写入边界做交叉一致性：`perStream ≤ aggregate ≤ value × maxStreams`（5% 余量），不满足就丢弃并发字段。
- 多机拆分仍按 `wall = max(各机 wall)`，留 v2.5.3。

### 38.4 发布门复审后的补丁（安全审计）
- 探测路由改用 `spawn` + 240s 超时 `taskkill /F /T` 杀进程树，避免只杀 pwsh 留下 ffmpeg 孤儿；脚本启动时清 `%TEMP%/dsh-probe-*` 超过 2 小时的残留。
- 探测写卡**不发 `models`**（板子浅合并会保留旧模型清单），只写 `workloads`；仍然过 **7000 字节**预算，超预算回 413，不再跑完 240s 才发现板子 413。
- `pwsh` 用绝对路径（`C:\Program Files\PowerShell\7\pwsh.exe`，找不到才回退 PATH），cwd 固定为包目录，降低 cwd 同名 exe 劫持面。
- 读侧 `etaOf` 只接受有限正数（≤1e6）。
