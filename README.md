# dsh-job-board

把「多机调度台」接进 DSH 的单包插件。一个包装齐四件事：

1. **14 个 `board_*` 工具** —— agent 能查板、建单、认领、续租、交付、打回、播报、派工、上报能力。
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

# 本地开发版（改成你自己的仓库路径，别照抄）
& $dsh plugin --profile desktop add 'file:<你的仓库路径>'

# 从 GitHub（装别人的/你自己的这份）
& $dsh plugin --profile desktop add 'github:shaot92-del/dsh-job-board'

# 从 npm（包名带 scope；产品名仍是 dsh-job-board）
& $dsh plugin --profile desktop add '@wfcj/dsh-job-board'
```

**已经装过旧版（unscoped `dsh-job-board`）的，先移除再装**，否则两份代码会同时注册同一批
patch / 工具 / 路由，热重载会报 duplicate route 或让客户端面板起不来：

```powershell
& $dsh plugin --profile desktop remove dsh-job-board
# 然后检查 profile 的 package.json：dsh.profile.bundles 里应已无 "dsh-job-board"（有则删掉），
# dependencies 里也不应再有 dsh-job-board；node_modules\dsh-job-board 若仍存在也一并删掉
& $dsh plugin --profile desktop add '@wfcj/dsh-job-board'
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 有 `@wfcj/dsh-job-board` 这一行
（现在所有安装方式都以 package.json 的 scoped 包名为准），
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
| `board_dispatch` | 选机 + 建单（`dryRun` 只预览）；v1.1 起建的单带 `dispatch:'auto'`，由 Host 自己派。**goal 必须 ≤ 300 字**（板子按 `goal[:300]` 存，超了会把 exec 命令截成半句；v1.1.3 起超限直接拒绝）。v2.6.12 起 `mode: 'maint'` 走维护通道：只读 `version`/`status`/`config`/`logs`；v2.6.20 起三个写动词 `upgrade`/`config-set`/`restart` **必须带 `ticket` 参数**（签名一次性授权，见 `scripts/maint-ticket.mjs`） |
| `board_options` | 列在线机器的模型清单（派工选机 + 选模型用） |
| `board_retry` | 重派失败/打回的任务（复制原 goal/machine/mode/model/workspace） |
| `board_attach` | 把远程任务号绑到板子任务，状态转 running |
| `board_caps` | 看某台机器上报的配置清单 |
| `board_assess` | 本机工作能力评估（写 `~/.dsh-board/identity.json` 并上报板子） |
| `board_metrics` | 各机器实时指标（内存/CPU/磁盘/运行时长） |
| `sh_run` | 执行命令（Windows 用 pwsh，失败回退 powershell）；输出按 `maxOutputBytes` 流式限流 |
| `sh_read` | 读文本文件 |
| `sh_write` | 写文本文件（UTF-8 无 BOM，自动建父目录） |
| `sh_list` | 列目录 |
| `worker_status` | （v2.6.0，`workerMode: on` 才注册）本机 worker 状态：模式/并发/当前任务/计数/白名单/最近日志 |
| `worker_control` | （v2.6.0，`workerMode: on` 才注册）drain（升级前不接新任务）/ resume / 手动触发一次轮询 |

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
    machine: 'host'          # v2.6.28（U-2）：不在已知前缀表（GT14/MB14/PC2/DESKTOP-/DESKTOP2）的主机名会原样小写上报，
                             # 副机请显式配 machine，否则副机 machine 与板上不一致会永远 idle。
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
    workerMode: 'off'        # v2.6.0：单包双角色。off=只做 Host/面板（默认）；drain=起工具但暂不认领（升级窗口）；
                             # on=同一进程里再跑 worker：认领 → 执行 → 回写。
```

### 副机模式（v2.6.0，原 dsh-job-worker 并入）

**最低 DSH 版本**：插件本体只依赖 `webServer`/`tools`；agent 模式另需 DSH 提供 `agentLoop` 与 `sessions`（0.2.2+）。缺这两个服务时 exec 路径仍可用，agent 任务会以 `agent-unavailable` 失败（服务在插件激活时读取一次，晚注册需重载插件）。

副机不再需要第二个插件包。同一行配置里打开 `workerMode: on`，并给出 worker 参数：

```yaml
- id: team
  config:
    boardUrl: 'http://<board-host>:8965'
    machine: 'GT14'          # 身份键：用电脑名/固定名，不要用显示名
    token: '<board-token>'
    dispatchRole: observer   # 副机不派工，只认领
    workerMode: 'on'
    worker:
      pollMs: 2000
      beatMs: 30000
      maxConcurrent: 1
      execCwd: 'C:/work'
      allowlist: []          # 空 = 不接任何 exec 任务（fail-closed）
      agentEnabled: false    # 默认只跑 exec；agent 需显式打开并配 preset/cwdRoot
      # v2.6.28（U-1）：以下两键也可写在 worker 子块（包内 cordis.patch.yml 模板已含这两行）
      maintenanceEnabled: true      # v2.6.12 只读维护通道（见下节）；只读，默认开
      maintenanceOutDir: ''         # 完整 payload 落盘目录，建议填共享盘（如 Z:/_maintenance）
```

**v2.7.0 起的行为变更（从旧版升级请先读这段）**

1. **`execCwdRoot` / `agentCwdRoot` 不配 = 任务被拒**（`cwd-root-unset` / `agent-cwd-unset`）。
   v2.6.27 起 cwd 根是 fail-closed：之前「不配就退回用户主目录」的行为已经删掉——那条路径等于让任务书自己指定工作目录。
   迁移做法（推荐）：把允许的工作根目录写进 `worker.execCwdRoot`（如 `'C:/work'`）与 `worker.agentCwdRoot`（如 `'C:/Users/<你>/Documents'`）。
   确需恢复旧行为：显式写 `worker.allowUnscopedCwd: true`（会在 `worker_status` 里一直挂着警告，不建议长期开）。
2. **Host 调度器默认关**：`autoDispatch` 默认已是 `false`。需要「自动抢队列并派给 remote-agent」的机器必须显式写 `autoDispatch: true`；否则只保留人工认领 / 面板派工。
3. **worker 拉起的 agent 会话是只读的**：`board_*` 写类（dispatch/claim/beat/done/fail/retry/attach/say）+ `sh_write` + `worker_control` 全部对该会话隐藏，只留 `worker_status`、`board_status/list/options/caps/metrics`、`sh_read/sh_list`。agent 任务需要写文件时请改用 exec 模式（白名单脚本）。
4. **审批指纹改为 128 bit 并绑定 model/provider**：升级后旧的 64 bit 审批记录仍可命中一次（按前缀比对），命中后自动升级重写；换了模型或 provider 需要重新审批。

- 认领只用看板 HTTP：`/api/claim` → `/api/beat` → `/api/mark`；holder 形如 `<machine>/<pid>-<rand>`，归属只认 holder，不认 note。
- 从旧版升级：旧 `dsh-job-worker` 的插件行是**它自己包内 patch 插入的**，删 profile 里的行没用（下次启动还会回来）。必须二选一：
  1. `dsh plugin remove dsh-job-worker`（或从 `dsh.profile.bundles` 移除该包）；
  2. 在 profile patch 里给 `- id: dsh-job-worker` 加 `disabled: true`，并在启动日志确认没有第二个 worker。
  否则两个 worker 会同时认领同一块板的任务。
- agent 模式的预算/审批状态目录沿用 `%LOCALAPPDATA%\dsh-job-worker`（兼容旧版迁移，不丢已有审批与预算计数）。

### 维护通道（v2.6.12，只读）

**为什么要有它**：worker 一开，`dispatch:auto` 的任务就被 worker 抢走 —— 内联命令被 fail closed（`inline-command-not-allowed`）、非白名单脚本被拒（`approval-required`）。闸门是对的，但「远程排障 / 远程升级」于是永远需要一次物理接触。维护通道只把**看**这一件事单独放行。

```powershell
board_dispatch({ machine: 'GT14', mode: 'maint', goal: 'version' })
board_dispatch({ machine: 'GT14', mode: 'maint', goal: '{"verb":"logs","lines":80}' })
```

| 动词 | 回什么 |
|---|---|
| `version` | 插件版本、node 版本、平台、machine、workerMode、approvalMode、白名单条数、agent 开关 |
| `status` | worker 运行态：并发、当前任务、计数、最近错误、看板心跳年龄、孤儿恢复 |
| `config` | **生效配置**（白名单条目原样列出——它就是「远程为什么被拒」的答案）；token 类键永不出现，`boardUrl` 里的 userinfo、query **与 fragment** 里的 `token`/`key`/`secret`/`sig`/`auth` 类参数都打码（复合键名如 `x-board-token`/`X-Amz-Signature` 一样命中；不带凭证的地址原样输出） |
| `logs` | 日志环形缓冲尾部（行数 1..200，缺省 40） |

安全边界（这就是它为什么不需要审批门）：

- **不 spawn 任何子进程**，也就不存在命令注入面；
- **不读任意路径**：信息源只有进程内 `config` / 日志环形缓冲 / `worker.status()`；
- 动词是代码里的冻结常量表（`MAINTENANCE_VERBS`），不从任务书取命令；
- 唯一入参是 `logs` 的行数（整数 1..200；`[50]`/`true`/`12.7`/`0x10` 一律拒，越界即拒）；
- 板子带宽有限（`note` 500 字 / `reasons` 5×120），所以配了 `maintenanceOutDir` 时完整 payload 另外落 `<dir>/<machine>/<taskId>-<verb>.json`（UTF-8 无 BOM），路径写进 `artifact`；不配就只回摘要。

写动作（`upgrade` / `config-set` / `restart`）v2.6.20 起已可用，但**必须带签名票据**：
主控机 `pwsh -File scripts/maint-ticket.mjs sign --machine <机器> --payload <payload.json>` 签发，
把票据传给 `board_dispatch` 的 `ticket` 参数（面板派工在「类型」选 maint 后填票据框）。
副机侧要先开写开关并落公钥，这是信任锚，首次必须本地做一次：
`pwsh -File scripts/enable-maint-write.ps1 -PublicKey '<主控 publicKey>'`（脚本在仓库 `scripts/` 下，写前备份、写完复核、幂等；详见 `docs/operator-playbook.md` 第 3.4 节）。

板上只看得到 5 条 `reasons`，所以取哪 5 条是按动词定的：`config` 取**头部**（`allowlist[...]` 在最前 —— 那才是「为什么被拒」的答案），`logs` 取**尾部**（最新几行）。`artifact` 路径写进板子前会跟着 `note` 一起脱敏（`%USERPROFILE%` 之类的替换），所以从板子上取的路径不一定能直接打开，配了共享盘时以 `maintenanceOutDir` 下的真实路径为准。


## 自检

改完代码、装进 DSH 之前先跑：

```powershell
node scripts/plugcheck.mjs
```

断言 14 组：`apply()` 不抛异常、18 个工具齐备、每个 `output.render` 返回
`[{type:'text',text}]`（裸字符串会毒化会话历史 —— 2026-10-27 这么崩过两次）、四条 GUI 路由存在
（含面板派工用的 `/api/board/ui/create`）、任务标题取 `t.title` 且 `goal` 不被裁剪、agent 层工具与
主工具共享同一份 `allowedRoots`、板子不可达时 `board_caps` 返回 `ok:false`；以及 v1.1 的
`board_dispatch` 带 `dispatch:'auto'`、Host 调度器真的走 `take → dispatch → attach`、
`aborted` 折成 `failed`、`board_list` 能看到 230 条、`dispose()` 清掉 4 个定时器；
v1.1.1 的会话 cookie 换取与 401 重试、nodeId 别名；v1.1.2 派发带 `approval:'auto'`；
v1.1.3 的 goal 超 300 字被拒、终态 note 带副机最后一条 stdout；
v2.6.12 的 `mode:'maint'` 建单（mode 原样进板子、不带模型）与动词笔误在本地被拒。
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
