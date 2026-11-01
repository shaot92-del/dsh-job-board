# dsh-team 阶段性总结报告

- 报告日期：2026-11-01
- 覆盖范围：从「这个版本能不能上 GitHub」到 v1.1.3 发布、GT14 排障、三机派工跑通
- 仓库：[shaot92-del/dsh-team](https://github.com/shaot92-del/dsh-team)（public，MIT）
- 结论截止：`main` = `50baa4f`，tag `v1.1.3`，CI 全绿

---

## 一、一页结论

| 维度 | 现状 |
|---|---|
| 插件 | 已开源，v1.0.1 → v1.1.3 共 6 次发布，共 8 个提交 |
| 架构 | 派发与终态回写已从浏览器搬进 Host（v1.1 起），浏览器只负责建单 |
| 外部服务 | `board_server.py` 增加原子占位 `take/untake`；`dsh-remote-agent` 升级到 0.9.12，hub + 2 台 worker 在线 |
| 现场 | host / GT14 / MB14 三机在线；exec 任务端到端（建单 → 派发 → 执行 → 终态回写）跑通，探针 20 秒完成 |
| 待办 | Host 侧 v1.1.3 需重启 DSH 生效；副机无模型凭据只能跑 exec；板子默认无鉴权 |

一句话：**插件本身已经从「能装能用」变成「能自主派工、能自证」，剩下的风险主要在外围（板子安全、副机凭据、单点状态文件）。**

---

## 二、版本演进

| 版本 | 提交 | 核心内容 | 验证证据 |
|---|---|---|---|
| v1.0.1 | `c8136d7` | 首次开源：清理占位符与本机绝对路径（`<YOUR_GH>`、`D:/gp_video/...`），补 `assets/pet.png` 到 `files` | 从 GitHub 重新 clone 后 `plugcheck` PASS |
| v1.0.2 | `84efb0c` | 20 项复核报告里的 15 项热修：面板派工假成功、标题丢失、agent 层白名单失效、同毫秒 ID 冲突、token 明文落日志等 | `PASS tools=16 routes=10`；CI success |
| v1.1.0 | `ff374de` / `e15382a` | 派发与终态回写搬进 Host；`snapshot(0)` 全量；`dispose` 清 4 个定时器；caps 异步 + TTL；输出流式限流 | plugcheck 11 组；CI ubuntu + windows 双绿 |
| v1.1.1 | `3d1b2fd` | Host 调度器用 `connection.authenticatedUrl()` 换会话 cookie，穿过 DSH 的 401 鉴权围栏；nodeId 按 `MACHINE_BY_HOSTNAME` 归一 | 实机日志 `web session: cookie acquired (status 303)`；`remote nodes: desktop-2gh05s7→mb14, gt14→gt14` |
| v1.1.2 | `9b80cab` | 派发显式带 `approval:'auto'`（remote-agent 对 exec 默认 manual，任务会静默挂 30 分钟）；`pending_approval` 落板 note | 探针任务 20 秒 `done`；hub 审计无 `approval.pending` |
| v1.1.3 | `50baa4f` | `goal` 超 300 字当场拒绝（板子 `goal[:300]` 截断会把命令变半句）；终态 note 优先带副机最后一条 `[stdout]` | `PASS tools=16 routes=10`，断言扩到 14 组；CI success |

GitHub Releases：v1.0.1(429163598) / v1.0.2(429195798) / v1.1.0(429204756) / v1.1.1(429220394) / v1.1.2(429335126) / v1.1.3(430283797)。

发布过程中的两次事故记录在案：

- v1.0.1 的 Release 正文从聊天渲染视图复制，被截断成 192 字符、代码围栏未闭合 —— 之后改为手写正文文件再用 REST 提交。
- v1.1.0 的 CI 首跑红，原因是 `board_assess` 断言依赖本机 `~/.dsh-board/identity.json`，CI 上没有 —— 改成结构断言。

---

## 三、现在的真实架构

```
浏览器（GUI 面板）
   │  只做一件事：POST /api/board/ui/create { dispatch:'auto' }
   ▼
Host 插件 dsh-team（跑在 DSH 进程里，PID 16708）
   │  dispatchOnce() 每 4 秒
   ├─→ 板子  POST /api/take      { task_id, machine:host }   ← 原子占位，防多 Host 抢同一任务
   ├─→ DSH   POST /api/remote-agent/ui/dispatch { goal, node, mode, approval:'auto', workspace }
   │        （带会话 cookie；401 时重换 cookie 重试一次）
   └─→ 板子  POST /api/attach    { remote_id, machine }       失败则 POST /api/untake 回滚
   │
   │  syncRemote() 每 6 秒
   ├─→ DSH   GET  /api/remote-agent/ui/tasks
   └─→ 板子  POST /api/mark { status, note:'远程 done：<最后一条 stdout>' }
   ▼
板子服务 board_server.py（PID 25192，0.0.0.0:8965，state 落 L:\...\_board\state.json）
   ▲
   │  机器上报 caps / live / heartbeat（与 remote-agent 连接是两条独立链路）
   └─ GT14 / MB14 / (PC2 离线)
```

关键设计取舍：

- **派发权只归 Host**。浏览器不再自己 fetch remote-agent —— v1.0.x 就是浏览器派工，多标签页会重复派、关页面就停。
- **先 take 再 dispatch**。板子原地合并的 `claim` 会抹掉 goal/title/remote_id，所以新增了 `do_take`：只占位（taker + 租约），不动 `machine`，把"机器归属"和"调度器归属"分开。
- **cookie 换发而不是绕鉴权**。remote-agent 的 UI 路由每请求都问 `ctx.connection.requestRejection`，后台 fetch 必 401；正解是拿本进程 launch token 换 `dsh_session` cookie。

---

## 四、复核报告 20 项的收敛

来源：`L:\云盘\gp_video_xfer\_收件箱\手机传过来的\dsh-team-implementation-plan.md`（朋友用 GPT-6.1 Xhigh 扫的，434 行）。
我的复核结论：**20 项全部有真实依据，12 CONFIRMED / 8 PARTIAL / 0 WRONG**，其中 4 处表述需要纠正（#3 无副机时不炸、#8 读的是 15/17/19、#10 不是 console.log 而是 trace、#12 阈值是 200/60/12）。

| # | 问题 | 状态 |
|---|---|---|
| 1 | agent 层读 `cfg.allowedRoots` 等不存在的键 → 白名单变成不限 | v1.0.2 修（cfg 收三键，两处注册都传） |
| 2 | allowedRoots 是字符串前缀，不是沙箱 | v1.0.2 修 realpath + 大小写归一，README 同步澄清 |
| 3 | `busyN` 未定义 → 有副机时点派工必抛 ReferenceError | v1.0.2 修（`c.busyN`） |
| 4 | 面板派工调不存在的 `/api/board/ui/create`，结果全丢弃 | v1.0.2 补路由 + 三步判 `ok` |
| 5 | `clip()` 污染 goal（只影响 pending 派工链） | v1.0.2 改回原文 |
| 6 | 派发与终态同步在浏览器，多 GUI 重复派 | v1.1.0 搬到 Host |
| 7 | 子进程输出无界累积 | v1.1.0 在 data 回调里限流并继续 drain |
| 8 | 同毫秒 taskId 冲突 | v1.0.2 加 `randomUUID` 后缀 |
| 9 | release 丢弃真实执行机，归属记到 host | v1.0.2 改 `body.machine` 优先 |
| 10 | 整份 config（含 token）写进 `_runtime.log` | v1.0.2 `redactConfig` 打码 |
| 11 | Panel 内自动派工引用未定义 `resolveNodeId` | v1.0.2 删除该段（只走 Host） |
| 12 | snapshot 先 rank 排序再 slice，>200 条被截 | v1.1.0 `limit=0` 取全量 |
| 13 | dispose 只清 disposers，4 个定时器与订阅泄漏 | v1.1.0 全清 |
| 14 | 标题不用 `t.title`，无 note 的任务恒显示"(无标题)" | v1.0.2 修 |
| 15 | 产物/备注草稿跨任务串味 | v1.0.2 切任务时清空 |
| 16 | caps/metrics 把失败包装成空成功，面板静默失败 | v1.0.2 判 `ok` |
| 17 | 5 次串行 `spawnSync` 探测，最坏阻塞 15 秒 | v1.1.0 并发 + 10 分钟 TTL |
| 18 | 测试只校验形状、不调 execute、依赖作者机路径 | 部分（plugcheck 14 组 + 双平台 CI；acceptance 仍依赖本机素材） |
| 19 | 全局隐藏"[title=远程同事]"的选择器会误伤正文 | 部分（删全局 CSS + 还原内联 display；`!important` 语义仍在） |
| 20 | 字号读 15/17/19、写 16/18/20 | v1.0.2 统一到 `[16,18,20]` |

完整逐项判定与外部契约结论见 [`docs/review-response.md`](./review-response.md)。

---

## 五、板子服务改动（不在任何 git 仓库里）

文件：`L:\云盘\gp_video_xfer\_tools\board_server.py`；运行实例 PID 25192，监听 `0.0.0.0:8965`，状态文件 `L:\云盘\gp_video_xfer\_board\state.json`。

| 改动 | 说明 |
|---|---|
| 新增 `do_take` / `do_untake` | 带前置条件的原子占位：状态、`dispatch=='auto'`、taker 抢占、租约全部在 `STATE_LOCK` 里判定；`taker==machine` 时只续租（幂等） |
| `do_claim` 改原地合并 | 旧实现整条 dict 覆盖，goal/title/mode/remote_id/dispatch 全丢 —— 派工绝不能走 claim |
| `do_create` 收 `workspace` | 副机工作区可随任务下发 |
| `do_mark` 收 `note` | 终态回写能把副机输出带到板上 |
| `do_attach` 清 `taker` | 派出后占位归 remote-agent，不再被别的调度器误判 |
| 可选 `GP_BOARD_TOKEN` | 设置了就校验 `x-board-token`，GET 不拦 |
| `/api/health` 加 `auth` / `version:2` / `routes` | 便于排查"跑的是哪版" |

现场教训：**改完 `board_server.py` 必须重启进程**。曾经出现过"代码有 note 支持、接口返回 ok、但 note 不变"，原因是运行中的进程（23:36:54 启动）比文件修改（23:38:32）还老。

---

## 六、多机拓扑与运维

| 机器 | hostname | IP | 角色 | 现状 |
|---|---|---|---|---|
| host | DESKTOP-NJ6NG3V | 192.168.3.40 | 板子服务 + hub + GUI | DSH PID 16708，GUI 13899，hub 19387，板子 8965 |
| GT14 | 往返长江的GT14 | 192.168.3.73 | worker（exec 执行机） | 已连 hub，dsh-team 1.1.2 |
| MB14 | DESKTOP-2GH05S7 | 192.168.3.75 | worker（exec 执行机） | 已连 hub，dsh-team 1.1.2 |
| PC2 | DESKTOP-J1IP3OF | 192.168.3.126 | 备机 | 离线 72 小时+ |

共享盘：主机是 `L:`，其它机器 `net use Z: \\DESKTOP-NJ6NG3V\gp_xfer`。

### 排障中踩过的坑（都写成了脚本，放在 `L:\云盘\gp_video_xfer\_tools\`）

| 症状 | 真因 | 处置 |
|---|---|---|
| 启动弹窗 `web boot: 1 entry did not activate` | 两个生图插件（`@dickpy/dsh-imagegen` 与 `dsh-image-gen`）都注册 `generate_image`；桌面版把该冲突当启动失败 | 只留一个插件（`gt14-imagegen-swap.ps1`） |
| 仍崩 `desktop welcome: Web authentication failed` | 旧 Electron userData 损坏（`--user-data-dir=<新目录>` 启动即正常） | 改名 `%APPDATA%\@deepseek-ai\dsh-desktop` 为 `.bak-<stamp>`（`gt14-finalize.ps1`） |
| worker 一直不连 hub | 配对码分支没写 `transportMode`，schema 默认 `relay` → 发 `x-relay-token`，hub 只认 `x-dsh-token` → `close(1008,'bad token')` | 用 CLI 显式 `--hub-url --token` 生成 direct 配置（`gt14-modefix.ps1`） |
| exec 任务报 `profile "plu" does not exist` | 副机默认 cwd 是 UNC 路径，`cmd.exe` 不支持 → 参数被拆碎 | 脚本里先 `Push-Location $env:TEMP`（`upgrade-team.ps1`） |
| 升级脚本在 MB14 报 `Missing closing '}'` | PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1，中文注释解析崩 | 脚本保持纯 ASCII |
| `pnpm` 报 `Already up to date` 但版本没变 | `file:` 依赖不会因内容变化重装 | `remove` + `add` 强制重装 |
| 任务报 `ParserError … missing the terminator` | 板子 `goal[:300]` 截断把命令变半句 | v1.1.3 建单前拦截；长逻辑放共享盘脚本 |

### 重启顺序（改过 Host 侧代码时）

1. 板子服务：停 PID → `python.exe "L:\云盘\gp_video_xfer\_tools\board_server.py"`（工作目录 `_tools`）。
2. 主机 DSH：重启桌面版；确认 `_runtime.log` 出现 `host dispatcher started`、`web session: cookie acquired`、`remote nodes: ...`。
3. 副机 DSH：只有改了副机侧插件才需要重启。

---

## 七、验证证据

- **离线自检**：`node scripts/plugcheck.mjs` → `PASS name=dsh-team tools=16 routes=10`，14 组断言，全程 `stubFetch` 不连真板子；`node --check` 三个源文件 exit 0。
- **CI**：`plugcheck` workflow，ubuntu-latest + windows-latest，对 `3d1b2fd` / `e15382a` / `9b80cab` / `50baa4f` 均 success。
- **实机**：
  - 探针任务 `bd-va5mt6-bc1f` 从建单到 `done` 20 秒；
  - GT14 `bd-x4bmi5-439e` → `[stdout] GT14 team=1.1.2`；MB14 `bd-x4bo3a-8c94` → `[stdout] MB14 team=1.1.2`；
  - hub `nodes:2 online:2`；板子 `host/GT14/MB14` 三机 online；
  - 板子重启后 `POST /api/mark` 的 note 实测写入成功。
- **板子当前任务分布**：done 7 / failed 12 / superseded 1 —— failed 多为排障期故意留下的失败样本（审批挂起、UNC cwd、300 字截断），可作为回归素材。

---

## 八、已知限制与遗留工作

按优先级：

1. **Host 侧已加载 v1.1.3**（2026-11-01 09:01 重启后 apply pid=15836，16 工具 + 10 路由）；但**包含 attach 命名修复的那份代码仍需再重启主机 DSH 才生效**：`dispatchOnce()` 回执原来把 `nodeId` 当机器名写回（`machine: "desktop-2gh05s7"`），已改为 `machine: nodeMachine(node) || target`（三份副本：仓库 `D:\gp_video\dsh-team\lib\index.js`、profile 安装副本、共享盘 `L:\云盘\gp_video_xfer\_tools\dsh-team\lib\index.js`，均留 `.bak-20261101`）。历史 9 条 `machine=desktop-2gh05s7` 的任务不会改名。
2. ~~**副机没有模型凭据**~~ → **2026-11-01 已定位并修复，两台副机 agent 模式跑通**。实测并非没有凭据：两台副机的 `%USERPROFILE%\.dsh\.credentials.yaml` 与主机同结构（browser-session / device / `deepseek-account-platform/default` 64 字符令牌）。"派工正常但没有 API 调用"是两层原因叠加：
   (a) 副机 profile 缺 **`agent-default-model`** 段，agent 会话落到默认路由 `deepseek-official`（要 `DEEPSEEK_API_KEY`），首个 turn 在本地被拒：`llm-deepseek: no API key for provider route "deepseek-official"`；
   (b) 补上 (a) 后暴露真正拦路虎：`dsh-remote-agent` 0.9.12 的 `runner.js:797` 用 `agent.followup({ content, source })` 投递任务书，**缺 `role` 与 `id`**，无角色消息进历史后 `dsh-llm-deepseek` 的 `serialize()`（`lib/index.js:1699`）抛 `TypeError: Cannot read properties of undefined (reading 'content')`，再被 `generate()` 包成 `DeepSeek Messages transport failed`（TRANSPORT）—— 依旧零出网、且真实原因被藏了两层（`agent-loop/lib/index.js:1145` 重建 LlmError 时又丢掉 `cause`）。
   修法两处：副机 patch 追加 `agent-default-model`（`provider: deepseek-account` / `model: deepseek-flash`），以及给 followup 补 `role: 'user'` + `id: randomUUID()`（脚本 `Z:\_tools\patch-followup-role.ps1`，本机共享盘为 `L:\云盘\gp_video_xfer\_tools\`）。验证：两台 agent 任务均 `completed` 并带回真实模型输出。完整证据链见 `D:\gp_video\_docs\副机无API调用-诊断-20261101.md`。
3. **上游待修**：`dsh-remote-agent` 的 followup 缺 `role` 应按 §2 修法提 issue/PR；建议 `dsh-llm-deepseek` 把 `cause` 写进 TRANSPORT 的 message。
4. **板子安全**：默认 `GP_BOARD_TOKEN` 为空、绑定 `0.0.0.0`、CORS `*`。同一局域网内谁都能写。建议至少设 token 并改绑内网 IP。
5. **板子状态是单点**：`state.json` 只有一份、没有版本控制、没有备份。建议把 `board_server.py` 纳入仓库（或独立 repo），并对 `state.json` 做定时快照。
6. **MB14 没装 git**：只能用共享盘 `file:` 源升级；装个便携 git 就能用 `github:` 源。
7. **测试覆盖仍偏窄**：plugcheck 覆盖了插件侧契约，`acceptance.mjs` 仍依赖本机素材（`D:\gp_video\publish`、本机 python），CI 跑不了。
8. **远程任务日志只回一条**：v1.1.3 只把最后一条 `[stdout]` 写进 note，完整日志仍在副机 `_remote-logs\<machine>\tasks\*.json`。

---

## 九、附录

### 仓库结构

```
dsh-team/
├─ package.json          # v1.1.3，files 含 lib/、assets/pet.png、docs/review-response.md
├─ cordis.patch.yml      # 默认 profile patch（bundles 声明）
├─ lib/
│  ├─ index.js           # 1520 行：工具、路由、Host 调度器、caps/live 上报
│  ├─ client.js          # 1263 行：侧栏面板（渲染、建单、隐藏"远程同事"入口）
│  └─ shell.js           #  355 行：sh_run / sh_read / sh_write / sh_list
├─ assets/pet.png        # 桌宠立绘（753KB）
├─ scripts/plugcheck.mjs #  423 行：14 组离线断言
├─ docs/
│  ├─ review-response.md # 20 项复核逐项判定
│  └─ summary-report-2026-11-01.md  # 本报告
└─ .github/workflows/plugcheck.yml
```

### 常用命令

```powershell
# 本地自检
node scripts/plugcheck.mjs

# 装进 profile（注意 pnpm 的 "Already up to date" 坑，必要时 remove + add）
dsh plugin --profile desktop add 'file:D:\gp_video\dsh-team'

# 联网检查（本机需代理）
git -c http.proxy=http://127.0.0.1:7897 push origin main --tags

# 板子健康
Invoke-RestMethod http://127.0.0.1:8965/api/health

# hub 节点数（需 nodeToken）
Invoke-RestMethod http://192.168.3.40:19387/api/remote-agent/healthz -Headers @{ 'x-dsh-token' = '<nodeToken>' }
```

### 相关链接

- 仓库：https://github.com/shaot92-del/dsh-team
- Releases：https://github.com/shaot92-del/dsh-team/releases
- CI：https://github.com/shaot92-del/dsh-team/actions
