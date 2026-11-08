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
- GT14/MB14 换新 board token（用 `Z:\_tools\team-hardening.ps1 -TokenFile`），
  两台重启后确认 `caps reported ok=true`；
- 板子撤旧 token（`GP_BOARD_TOKENS` 只留新枚）→ `health.authTokens == 1`；
- 清 `%TEMP%\board-token*.txt`、共享盘 `_tools/board-token.txt`、DSH 会话残留；
- 仓库历史清 token：改 private 或 `git filter-repo`（历史里仍有真值）。

