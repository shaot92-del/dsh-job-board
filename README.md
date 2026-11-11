# dsh-job-board

把「团队 · 作业板」接进 DSH 的单包插件。一个包装齐四件事：

1. **12 个 `board_*` 工具** —— agent 能查板、建单、认领、续租、交付、打回、播报、派工、上报能力。
2. **4 个 `sh_*` 工具** —— `sh_run` / `sh_read` / `sh_write` / `sh_list`。副机 worker 会话默认没有
   pwsh / read / write，这四个把能力补上（这是从 dsh-shell 合并进来的部分）。
3. **GUI 面板** —— 侧栏「作业板」：任务表（筛选/搜索/展开详情/认领/交付/打回）、机器能力卡、
   一行派工、桌宠状态卡（可拖动、可拿捏尺寸）。
4. **Host 路由 + Host 调度器** —— `/api/board/ui/*`（浏览器不直接跨网访问板子服务），以及
   v1.1 起搬进 Host 后台的派发/终态回写（不再依赖浏览器开着）。

## 架构（v1.1）

派发权在 Host 一侧，浏览器只负责建单：

```
面板「派工」 ──POST /api/board/ui/create {dispatch:'auto'}──▶ 板子（queued）
                                                             │
Host 后台每 4 秒 dispatchOnce()：                             │
  1) POST /api/take   {task_id, machine:本机}   ← 原子占位，别的 Host 抢不到
  2) POST /api/remote-agent/ui/dispatch {goal,node,mode,workspace}
  3a) 成功 → POST /api/attach {task_id, remote_id, machine:执行机}
  3b) 失败 → POST /api/untake ← 放回队列，等下一轮或换机

Host 后台每 6 秒 syncRemote()：
  GET /api/remote-agent/ui/tasks → completed→done；failed/aborted/interrupted/rejected→failed
  POST /api/mark {task_id, status, note, remote_id}
```

这样做的原因：浏览器多开会重复派工、关页面就停，而 `remote-agent` 的 `/dispatch` 既不幂等
也不等副机受理，所以必须由 Host 串行地做「原子占位 → 派发 → 回绑」，才能保证一件任务只有一台
Host 派出、且板上记录与远程任务对得上。

> **v1.1.1 的鉴权细节**：`/api/remote-agent/ui/*` 跑在 DSH 的浏览器鉴权围栏后面（每请求问
> `connection.requestRejection`），后台进程直接 fetch 一定 401 —— v1.1.0 就卡在这里。现在
> Host 调度器先用 `connection.authenticatedUrl()` 把自己进程的 launch token 拼进一次 `/` 请求，
> 换到会话 cookie（10 分钟缓存；遇到 401 自动重换一次），之后带着它调 remote-agent。不需要
> 手工登录，也没有改动别人的插件。
>
> 副机的 `nodeId` 通常是 Windows 计算机名（`desktop2gh05s7`），而任务上写的是板子的别名
> （`MB14`）。调度器用插件里同一张 `MACHINE_BY_HOSTNAME` 表把两者对齐（忽略大小写与连字符），
> 第一次取到节点列表时会把 `nodeId→机器名` 的对应关系写进 `_runtime.log`。

## 装

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 本地开发版
& $dsh plugin --profile desktop add 'file:D:\gp_video\dsh-job-board'

# 从 GitHub（装别人的/你自己的这份）
& $dsh plugin --profile desktop add 'github:shaot92-del/dsh-job-board'
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 有 `dsh-job-board` 这一行，
然后重启 DSH（Host 半边改动只有重启才生效；只改 `lib/client.js` 的话刷新页面即可）。

> 要接入别人已经在跑的板子，不用手改 YAML：
> `pwsh -File scripts\set-team-config.ps1 -Profile desktop -BoardUrl 'http://<主机>:8965' -Token '<token>' -Machine '<本机名>' -Role observer`
> （写前自动备份，写后复核；`-List` 只看不写。）

> **板子有两种，按场景选。**
>
> - **单机 / 第一次用**：v1.5.0 起零配置会自动在 `127.0.0.1` 上起一个随包最小板子
>   （`lib/solo-board.mjs`，Node 实现、随机 token、只本机可访问），不需要 Python、不需要手填 token。
> - **多机团队**：用随包的 `tools/board_server.py`（Python 3）。启动前设置 `GP_BOARD_TOKEN`，
>   或直接用 `scripts/install-board.ps1` 部署 + 重启 + 自检；再把 `boardUrl` / `token` 指向它。
>
> v1.1 起板子还要支持 `/api/take`（原子占位）与 `/api/untake`（放回），否则 Host 调度器
> 会一直拿不到派发权、任务停在 `queued`（日志里会写 `take failed`）。只想要 v1.0 的行为，
> 把 `autoDispatch` 关掉即可。

## 工具

| 工具 | 干什么 |
|---|---|
| `board_status` | 总览：待办/进行/完成/打回计数、机器在线、最近事件 |
| `board_list` | 列任务，可按 `status` / `machine` 过滤；默认取全量（v1.1 起不再只给 200 条） |
| `board_claim` | 认领（挂到配置的 `machine` 名下） |
| `board_beat` | 续租 + 写进度备注 |
| `board_done` | 交付（可带 `artifact`） |
| `board_fail` | 打回（`blocked`）/ 失败（`failed`），必须写原因 |
| `board_say` | 往事件流播报一句 |
| `board_dispatch` | 选机 + 建单（`dryRun` 只预览）；v1.1 起建的单带 `dispatch:'auto'`，由 Host 自己派。**goal 必须 ≤ 300 字**（板子按 `goal[:300]` 存，超了会把 exec 命令截成半句；v1.1.3 起超限直接拒绝） |
| `board_attach` | 把远程任务号绑到板子任务，状态转 running |
| `board_caps` | 看某台机器上报的配置清单 |
| `board_assess` | 本机工作能力评估（写 `~/.dsh-board/identity.json` 并上报板子） |
| `board_metrics` | 各机器实时指标（内存/CPU/磁盘/运行时长） |
| `sh_run` | 执行命令（Windows 用 pwsh，失败回退 powershell）；输出按 `maxOutputBytes` 流式限流 |
| `sh_read` | 读文本文件 |
| `sh_write` | 写文本文件（UTF-8 无 BOM，自动建父目录） |
| `sh_list` | 列目录 |

## 面板

侧栏「作业板」→ 主面板。数据走 Host 半边的 `/api/board/ui/*`。

- 8 秒自动刷新；`A+` 调字号（16/18/20px，存 localStorage）
- 行可展开：状态/机器/更新时间/进度/产物；展开后可填产物路径与备注，直接「交付」或「打回」
- 机器卡：在线状态、能力徽章、内存/CPU/磁盘、最近上报时间
- 桌宠：可拖、双击换尺寸、右键折叠成小条；立绘由 `/api/board/ui/pet.png` 提供

## 配置

写在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: team
  config:
    boardUrl: 'http://127.0.0.1:8965'
    machine: 'host'          # 副机改成 gt14 / mb14 / pc2
    token: ''                # 板子开了 GP_BOARD_TOKEN 时填同一个值
    petImage: ''             # 留空=用随包立绘 assets/pet.png
    allowedRoots: []         # sh_* 只允许访问这些目录（realpath 比较）；空白名单默认拒绝，需 allowAllRoots: true 显式放行。
                             # 注意这是路径白名单，不是沙箱：命令内容本身不受限。
                             # 部署前请读 docs/issue-10/08-exec-policy.md（谁能在这几台
                             # 机器上跑命令、板子该怎么配 token）。
    shellTimeoutMs: 120000
    maxOutputBytes: 200000   # sh_run 流式保留的上限，超出只保留前 N 字节并标 truncated
    autoDispatch: true       # v1.1：Host 后台自动派发 + 终态回写；设 false 退回纯手动
    dispatchApproval: auto   # v1.1.2：派发时给 remote-agent 的审批策略。
                             # remote-agent 对 exec 任务默认 manual（挂起等 30 分钟超时）；
                             # 自动调度必须写 auto，要人工批就改成 manual
    dispatchRole: owner      # v1.3.0：同一块板子只让一台 Host 派工。
                             # 设成 observer 的 Host 只建单、不 take/untake，也不跑 reconcile
                             # （见 docs/issue-10/07-dispatch-roles.md）
```

## 自检

改完代码、装进 DSH 之前先跑：

```powershell
node scripts/plugcheck.mjs
```

断言 14 组：`apply()` 不抛异常、16 个工具齐备、每个 `output.render` 返回
`[{type:'text',text}]`（裸字符串会毒化会话历史 —— 2026-10-27 这么崩过两次）、四条 GUI 路由存在
（含面板派工用的 `/api/board/ui/create`）、任务标题取 `t.title` 且 `goal` 不被裁剪、agent 层工具与
主工具共享同一份 `allowedRoots`、板子不可达时 `board_caps` 返回 `ok:false`；以及 v1.1 的
`board_dispatch` 带 `dispatch:'auto'`、Host 调度器真的走 `take → dispatch → attach`、
`aborted` 折成 `failed`、`board_list` 能看到 230 条、`dispose()` 清掉 4 个定时器；
v1.1.1 的会话 cookie 换取与 401 重试、nodeId 别名；v1.1.2 派发带 `approval:'auto'`；
v1.1.3 的 goal 超 300 字被拒、终态 note 带副机最后一条 stdout。
全程 `stubFetch`，不连真板子。

真板子相关的验收（真派发、多机、桌宠）走 `scripts/acceptance.mjs`，需要板子服务和本机媒体素材。
产物报表落在 `%TEMP%\dsh-job-board-*\accept\验收矩阵-*.csv`。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/issue-10/05-deployment-notes-2026-11-08.md` | hub 与 profile 的部署姿势、踩过的坑 |
| `docs/issue-10/06-dispatch-recovery.md` | 三步派工与"结果未知"恢复日志（v1.2.0–v1.2.4） |
| `docs/issue-10/07-dispatch-roles.md` | 派工所有权、attach 校验、跨 Host 收敛、状态文件锁 |
| `docs/issue-10/08-exec-policy.md` | **部署级命令执行策略**：谁能在哪台机器上跑什么 |

## 许可

MIT。
