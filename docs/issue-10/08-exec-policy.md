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
                   │ (DSH 进程内)   │  HTTP  │ 192.168.3.40:19387│
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

> 2026-11-08 实测：板子在 `192.168.3.40:8965` 对全网段开放、无 token；DSH Web 只
> 监听 `127.0.0.1`，所以"面板路由无鉴权"的实际暴露面是"本机任意进程"。

## 3. 威胁模型（按可能性排序）

1. **同网段任意设备建单** → 一条 `dispatch:auto` 的 `exec` 任务会真在 GT14/MB14 上
   跑。这是当前最高风险：板子无鉴权 + 默认 `dispatchApproval: auto`。
2. **误操作的 agent 会话** → agent 手里有 `board_dispatch` / `sh_run`，一句话就能把
   命令发到另一台机器；`allowedRoots: []`（默认）等于不限制目录。
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

- `allowedRoots` 从 `[]` 换成具体目录 —— 空数组是"不限制"，不是"不许"；
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
4. host 上 hub `192.168.3.40:19387` 有来自副机的 Established 连接。

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
   `iwr http://192.168.3.40:8965/api/board -Headers @{'x-board-token'=<运行时 token>}` 回 200。
3. **收窄板子**：`%USERPROFILE%\.dsh\board-tokens.txt` 只留新枚 → 重启 8965 →
   `health.authTokens == 1`，旧枚再打 `/api/board` 必须回 401。

顺序反了就是一次 401 空窗：板子只认新枚、而某台 Host 还在用旧枚。

### 9.2 重启副机 DSH 的可靠姿势

**不能**从 DSH 自己派的 exec 任务里 `Start-Process` 重启 —— 那个子进程在 DSH 的进程树里，
`taskkill` 会连坐，机器直接失联（2026-11-08 实测两台都这样，最后靠人工开机）。

可靠做法是让任务计划程序托管一个 VBS，脱离 DSH 进程树：

```powershell
# 共享盘上的 bounce-dsh.vbs：睡 N 毫秒 → taskkill DeepSeek Harness → 6 秒后重新拉起
schtasks /create /tn DSHBounce /tr 'wscript.exe \\DESKTOP-NJ6NG3V\gp_xfer\_tools\bounce-dsh.vbs 15000' /sc once /st 23:59 /it /f
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
| `DESKTOP-NJ6NG3V\17827` | 完全控制（本机所有者） |
| `DESKTOP-NJ6NG3V\xfer` | 修改（共享盘服务账号，副机经它读写） |
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
| 本机 `DESKTOP-NJ6NG3V` | hub | `nodeToken:`（带单引号） | `'nt_…'` |
| GT14 | worker | `token:`（**不带引号**） | `nt_…` |
| MB14 | worker | `token:`（带单引号） | `'nt_…'` |

还有两处容易踩：

- GT14 的 `hubUrl` 是 `ws://192.168.3.40:19387/api/remote-agent/node`（WebSocket），
  MB14 是 `http://192.168.3.40:19387`（direct）——轮换脚本不要按整块重写，只改 token 那一行。
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
2. `Get-NetTCPConnection -LocalPort 19387 -State Established` 来自 `192.168.3.73`、`192.168.3.75`。
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
| 重启 | 本机 DSH → hub 用新值；两台副机各自重启 DSH 后自动重连（`Established` 出现 `192.168.3.73`、`192.168.3.75`） |
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
