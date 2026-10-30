# 变更日志

## v1.1.0 — 2026-10-30

架构升级版：把「派发」和「终态回写」从浏览器搬进 Host 进程，补上 v1.0.2 遗留的
5 项 P1/P2（复核第 6/7/12/13/17 项）。20 项复核的逐条状态见 `docs/review-response.md`。

### 架构：Host 侧调度器（复核 #6）

- 新增 Host 后台 `dispatchOnce()`（4 秒）：对 `dispatch:'auto'` 且 `queued/stale` 的任务，
  先 `POST /api/take` 原子占位，再 `POST /api/remote-agent/ui/dispatch`，成功后
  `POST /api/attach` 回绑；失败 `POST /api/untake` 放回队列并写明原因
- 新增 Host 后台 `syncRemote()`（6 秒）：拉 `/api/remote-agent/ui/tasks`，把
  `completed → done`、`failed/aborted/interrupted/rejected → failed` 回写板子
- 浏览器不再轮询 remote-agent（删掉约 5.4 KB 的 `bgDispatch` 整段）：多开不再重复派工，
  关掉页面任务也不会停；面板「派工」只负责建单（`dispatch:'auto'`）
- 新配置 `autoDispatch`（默认 `true`），设 `false` 可退回「建单后手动 `remote_task`」的旧流程

### 板子协议（服务端需同步升级）

- 调用 `POST /api/take {task_id, machine, minutes?}` 原子占位：`dispatch` 必须为 `auto`、
  状态必须是 `queued`/过期 `claimed`、且没有被别人占住；`machine` 仍记真正执行机，
  占位者单独记 `taker`；同一 `taker` 重复调用是续租（`reentrant:true`）
- 新增 `POST /api/untake {task_id, machine}`：放回队列（`status=queued`、`dispatch=auto`）
- `POST /api/claim` 改为**原地合并**：旧实现整条覆盖会抹掉 `goal/title/mode/workspace/remote_id`
- `POST /api/create` 支持 `workspace` 字段；`POST /api/mark` 支持 `note`；`POST /api/attach` 清 `taker`
- 可选鉴权：服务端设 `GP_BOARD_TOKEN` 后，写请求必须带 `x-board-token` 头（本插件用配置里的
  `token` 自动带上）；不设则行为不变
- `/api/health` 增加 `auth` / `version` / `routes`，方便确认对面装的是哪个版本

### 修复（复核 #7 #12 #13 #17）

- **`sh_run` 输出流式限流**：`runOnce` 在 `data` 回调里就按 `maxOutputBytes` 截断（继续 drain
  管道，不阻塞子进程），不再把整段输出攒进内存最后才裁；超限体现在 `truncated`
- **`snapshot(limit)` 支持 `limit=0` 取全量**：`board_list` 改用全量快照，`limit` 上限提到 500，
  不再因为先裁 200 条导致 `total` 封顶、`done/superseded` 被切掉
- **`dispose()` 完整卸载**：清掉 `caps/live/dispatch/sync` 四个定时器、退订 `agent/created`、
  清 `portedAgents`；插件重载不再叠加定时器继续上报
- **能力探测不再阻塞**：`collectCaps` 改 async，5 个版本探测用 `execFile` 并发 + 10 分钟 TTL
  （原先串行 `spawnSync`，最坏阻塞 15 秒，还包含一次 Windows PowerShell 5.1 启动）

### 测试

- `scripts/plugcheck.mjs` 扩到 11 组断言：新增「建单带 `dispatch:'auto'`」「Host 调度器
  `take → dispatch → attach`」「`aborted` 折成 `failed`」「230 条任务不被截断」「`dispose()`
  清掉 4 个定时器」；定时器用 `setInterval` 打桩捕获后手动触发，不真跑、不挂住进程

## v1.0.2 — 2026-10-30

外部复核（20 项）后的热修版。判定与逐项证据见 `docs/review-response.md`；本次只修不依赖外部服务、
能在本仓库内闭合的问题。

### 修复（严重）

- **面板「派工」不再假成功**：`doDispatch` 先建板子任务（此前调的是根本不存在的 `/api/board/ui/create`），
  再回绑远程任务；任何一步失败都会在面板上报错并返回 `false`，不再出现「远程真派出、板子无记录」
- **有副机时点「派工」不再抛 `ReferenceError`**（`busyN` → `c.busyN`）
- **agent 层 `sh_*` 工具找回 `allowedRoots` / 超时 / 输出上限**：配置原先只挂在 `cfg` 上，
  agent 会话拿到的却是 `undefined`，导致根目录白名单退化成「不限制」
- **任务 ID 冲突**：`bd-` 前缀后追加 4 位 UUID，同毫秒建单不再撞板子的 409
- **`allowedRoots` 改为 realpath 比较**（Windows 忽略大小写），符号链接/junction 绕不过去；
  README 同步说明它只是路径白名单、拦不住命令内容本身

### 修复（一般）

- 面板任务标题改取 `t.title`（此前恒显示「(无标题)」或把备注当标题）；`goal` 不再被裁到 160 字
- 派工回写板子时保留真实执行机（`machine` 取请求体，缺省才用本机配置）
- `board_caps` / `board_metrics` 在板子不可达时返回 `ok:false`，不再回「没有匹配的机器」
- 面板认领/交付/打回失败会在面板上报错（此前 409 静默）
- 切任务时清空产物与备注草稿，不再把 A 的草稿提交进 B
- `apply()` 日志里的配置已脱敏（`token` 等键打码），不再把明文密钥写进 `_runtime.log`
- 删除 Panel 内引用未定义 `resolveNodeId` 的重复派工逻辑（改由 Host 侧 `bgDispatch` 统一负责）
- 「远程同事」入口的隐藏改为可还原（记录/恢复原内联 `display`，卸载时还原），并去掉全局
  `!important` 属性选择器
- 字号循环修正为读 16/18/20（此前读 15/17/19，刷新后必然回档）

### 测试

- `scripts/plugcheck.mjs` 重写：16 工具契约、`render` 返回文本块、四条 GUI 路由、标题/`goal` 不被裁、
  agent 层共享 `allowedRoots`、板子不可达时 `board_caps` 返回 `ok:false`；全程 `stubFetch`，不连真板子

## v1.0.1 — 2026-10-30

首个公开发布版。

### 功能

- **12 个 `board_*` 工具**：`board_status` / `board_list` / `board_claim` / `board_beat` /
  `board_done` / `board_fail` / `board_say` / `board_attach` / `board_dispatch` /
  `board_caps` / `board_assess` / `board_metrics`
- **4 个 `sh_*` 工具**：`sh_run` / `sh_read` / `sh_write` / `sh_list`（副机 worker 会话默认没有
  pwsh / read / write，这四个补上；从 dsh-shell 合并进来）
- **侧栏「作业板」面板**：任务表（筛选/搜索/展开/认领/交付/打回）、机器能力卡、一行派工、桌宠
- **Host 路由** `/api/board/ui/*`：浏览器不直接跨网访问板子服务

### 修复

- 桌宠立绘不再回退到本机绝对路径（`D:/gp_video/pet/大肥鱼.png`）；包内 `assets/pet.png`
  缺失时返回可读的 404，而不是拿空路径去 `readFile`
- `sh_run` 工具描述里的示例路径改为 `notes.txt`，不再指向作者机器上的目录
- `package.json` 的 `files` 补上 `assets/pet.png`，从 npm/打包安装时不再缺立绘

### 文档

- 补齐 `repository` / `bugs` / `homepage` / `author` 与 LICENSE 署名
- README 安装示例换成真实仓库地址；配置段 `petImage` 改为留空用随包立绘
- `scripts/plugcheck.mjs` 注释修正为 16 个工具（12 个 `board_*` + 4 个 `sh_*`）
