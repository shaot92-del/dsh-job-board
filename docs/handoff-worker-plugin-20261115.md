# 交接：把「通信/执行层」拆成独立插件（dsh-worker）

> 交接时间：2026-11-15
> 范围：**只交接通信与执行层**，做成一个新的独立 DSH 插件。
> 不交接：`dsh-job-board` 本体（看板、UI、能力卡、调度策略）仍由原会话继续迭代。
> 代码基线：`D:\gp_video\dsh-job-board` HEAD `09c2624`（v2.5.8，工作区干净）

---

## 1. 边界（最重要，先看清）

### 交给新会话的
新建插件 **`dsh-worker`**（建议包名 `dsh-job-worker`，仓库另开）：
- 驻留在每台 worker 机器上，向作业板领任务、执行、回写。
- 支持两种任务：`exec`（本机跑脚本）与 `agent`（本机起 DSH agent 会话）。
- 自带心跳、租约续期、取消、超时、断线退避、并发上限、结果契约。
- **彻底不使用** `dsh-remote-agent`，不依赖 hub / 19387 / WebSocket。

### 留在原会话的
- `dsh-job-board`：看板服务（`tools/board_server.py`）、owner UI、能力卡、稳定性/压测、模型选择、调度策略。
- 看板侧为 worker 提供的 HTTP API 与任务字段。
- 发布门规则（`AGENTS.md`）与产品方向。

### 两者之间只有 HTTP 契约
worker 不 import job-board 的代码；job-board 不 import worker。只通过作业板 API 交互。

---

## 2. 契约（先定，后写代码）

### 2.1 作业板 API（已存在，直接用）

宿主：`http://192.168.3.40:8965`（本机 `127.0.0.1:8965`）
鉴权：请求头 `x-board-token: <token>`（token 在 `C:\Users\17827\.dsh\board-tokens.txt`，取第一枚非 `#` 行）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/board` | 全量快照（machines / tasks / events） |
| POST | `/api/claim` | 认领任务 `{task_id, machine, holder}` |
| POST | `/api/beat` | 续租 `{task_id, machine, holder, minutes?}` |
| POST | `/api/mark` | 写状态/结果 `{task_id, status, note, result?, artifact?, remote_id?, machine}` |
| POST | `/api/release` | 释放回队列 |
| POST | `/api/caps` | 上报能力卡 |
| POST | `/api/metrics` | 上报指标 |
| GET | `/api/health` | 健康检查 |

任务字段（关键）：

```
id, goal, title, machine, mode('exec'|'agent'), model,
status('queued'|'claimed'|'running'|'done'|'failed'|'blocked'|'superseded'),
dispatch('auto'|'manual'), remote, remote_id, taker, holder,
note, result, artifact, workspace, created_at, updated_at, lease_until
```

注意事项：
- `/api/board` 的 `tasks` 是**对象**（按 id 键），不是数组。
- `mark` 时必须带 `machine`（否则归属校验 409）；`holder` 用于同机多实例互斥。
- 终态由 worker 写；看板自己也会 reconcile 远端任务，但 native worker 不走 remote 字段。

### 2.2 结果契约（v2.5.8 已定）

脚本最后一行打印：

```
DSH_RESULT {"ok":true,"expected":30,"actual":30,"reasons":[]}
```

worker 解析最后一条 `DSH_RESULT`，写入 `mark` 的 `result`；看板 `_clean_result` 会校验（ok 布尔、数字 0–1e12、reasons ≤5×120 字）。

### 2.3 exec 输入契约（新，必须改）

**不再接受“一行脚本文本”作为 goal。** 任务里给：

```json
{ "mode": "exec", "scriptPath": "Z:\\_tools\\foo.ps1", "args": ["-Cases","30"], "timeoutMs": 120000 }
```

worker 执行：`pwsh -NoProfile -NonInteractive -File <scriptPath> <args...>`（绝对路径；`pwsh` 解析用 `%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe` 优先）。
旧的字符串 goal 可兼容一版：包成 `& <pwsh> -NoProfile -File <临时脚本>`，并在 note 标 `legacy-goal`。

### 2.4 agent 输入契约

```json
{ "mode": "agent", "goal": "...", "model": "deepseek-account/deepseek-flash", "cwd": "C:\\Users\\17827\\dsh-remote-work" }
```

worker 在 DSH 进程内用 host Service 起会话（见 §3.2），把 `goal` 作为任务书投递，等 idle 取最终文本；会话 id 写 `artifact`。

---

## 3. worker 插件实现要求

### 3.1 主循环

1. 每 `pollMs`（默认 2000）`GET /api/board`。
2. 选 `status=queued && dispatch=auto && machine=<本机>`，按 `created_at` 升序。
3. `claim`（holder 用实例唯一 id），失败退避 2s。
4. `mark running`，启动执行；每 30s `beat` 续租。
5. 完成/失败 `mark` + `result` + `artifact`；释放本地槽位。
6. 升级/卸载前 drain：不再 claim，等运行中任务结束（或超时取消）。

### 3.2 agent 路径（DSH 0.2.2-rc.3）

先查精确契约：

```
cordis_inspect_query(host, Service, listService, {service:'agentLoop'})
cordis_inspect_query(host, Service, listService, {service:'sessions'})
cordis_inspect_query(host, Service, listService, {service:'agents'})
```

参考行为（**只读，不复制代码**）：
`C:\Users\17827\.dsh\profiles\desktop\node_modules\dsh-remote-agent\lib\node\runner.js`
关注 `InProcessRunner.available`、`createAgent`、`followup`、`whenIdle`、`ownEvents` 的用法。

必须显式 `inject: ['agentLoop','sessions']`（不要靠 `ctx.get` 猜），避免重演 rc.3 下 remote-agent 的 in-process 判定失效。

### 3.3 安全（上线前必须）

- 每机独立 token（看板侧加 scope；这属于 job-board 的改动，和原会话协调）。
- exec 只允许 `scriptPath` 在 `worker.allowlist` 内；默认拒绝内联 `-Command`/`cmd /c`。
- 超时/取消杀整棵进程树（`%SystemRoot%\System32\taskkill.exe /F /T` 绝对路径）。
- `maxConcurrent` 默认 1；agent 默认超时 30 分钟。
- 不把 token 写日志；错误信息掩码路径/用户名。
- `dispatchApproval` 默认 manual，或白名单脚本免审批。

### 3.4 失败信息

`mark` 的 note 必须带：阶段（claim/exec/agent/mark）、exitCode、stderr 尾部（≤300 字）。禁止只写 `task failed`。

---

## 4. 测试标准（用户明确要求，必须执行）

### 第 1 步：GT14 本地模型走一遍代码

- GT14 网关：`http://127.0.0.1:8080/v1/chat/completions`（OpenAI 兼容），常用模型 `qwen35-9b`（32K）、`qwen36-35b`。
- 已有工具：`L:\云盘\gp_video_xfer\_tools\_review\gt14-qwen-review.ps1`，以及 q1–q6 片段文件。
- **必须窄问**：单段 ≤4–8KB、一次一问、强制 JSON、`temperature=0`、`max_tokens≥2500`、关闭思考（`chat_template_kwargs.enable_thinking=false`）。
- 宽范围 diff（>10KB）它会误报并漏 bug（实测：14KB diff 既误报 AbortSignal.timeout 不支持，又漏掉缺 `dispatch:'auto'`）；所以只审“本次改动的关键片段”。
- 记录：问题表（file/line/risk/why）+ 修复情况。

### 第 2 步：小模型安全审核走两遍

1. **第一遍**：安全审计师 persona 审完整 diff，输出 P0/P1/P2；P0/P1 必须修，P2 修或记录理由。
2. **第二遍**：只审“修复增量”，确认 P0/P1 闭环、没有新问题；两遍都 PASS 才能推送。
3. 建议同时做代码审查（发布门 `AGENTS.md` 的要求），但用户明确的最低标准是“安全两遍”。

### 第 3 步：主控自检

- `git grep` 秘密模式 0 命中；危险构造（eval/exec 拼接）人工过一遍。
- 全量测试绿；`git diff --check`；`npm pack --dry-run`。
- 部署一致性：profile 版本与 repo 一致。

### 测试套件（worker 新增）

- claim 成功/失败、租约过期、beat。
- exec 成功/失败/超时/取消/退出码。
- `DSH_RESULT` 解析与脏数据。
- allowlist 拒绝、内联命令拒绝。
- 断线退避、恢复后不重复执行。
- 并发上限。
- agent 路径：模型可用/不可用、取消、会话 id 回写。

---

## 5. 环境事实

| 机器 | 角色 | IP | DSH | 插件 |
|---|---|---|---|---|
| host | owner+看板 | 192.168.3.40 | 0.2.2-rc.3 | dsh-job-board 2.5.8 |
| GT14 | worker | 192.168.3.73 | 0.2.2-rc.3 | 2.5.6 |
| PC2 | worker | 192.168.3.126 | 0.2.2-rc.3 | 2.5.6 |

- 共享盘：宿主 `L:\云盘\gp_video_xfer`，副机 `Z:`，SMB `\\DESKTOP-NJ6NG3V\gp_xfer`（Guest 可读）。
- PC2 的 exec 工作区：`C:\Users\17827\dsh-remote-work`。
- DSH rc.3 下 remote-agent 的 agent 模式已坏（`spawn EINVAL` / headless 模型不支持）——这正是要替换它的原因。
- GT14 正在跑能力评估时不要派重任务。

---

## 6. 交付物与验收

- 新仓库/插件：`dsh-worker`（package `dsh-job-worker`），含 `lib/`、`cordis.patch.yml`、README、CHANGELOG、测试。
- 配置示例：`boardUrl`、`token`、`machine`、`workerMode`、`worker.*`。
- 在 PC2 上：卸载/停用 `dsh-remote-agent` 后，exec 任务能从看板领取并完成，结果带 exitCode。
- 在 GT14 上：agent 任务能指定模型跑通，会话 id 回写。
- 失败信息可定位（exitCode + stderr 尾部 + 阶段）。
- 测试全绿；安全两遍 PASS；GT14 小模型 review 记录附在 PR/CHANGELOG。

---

## 7. 已知坑（直接抄给新会话）

- goal 是脚本文本不是命令行；`%VAR%`、`&`、`()`、`"` 都会变语义。
- 看板 `tasks` 是对象；`mark` 必须带 `machine`。
- 别用 Windows PowerShell 5.1 写 JSON（BOM）；用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。
- 看板任务 note 只回 400 字，完整结果走 `result` 字段或文件。
- 改 `cordis.patch.yml` 会热重载，旧路由未回收会 duplicate route；必须重启 DSH。
- 不要复制 remote-agent 源码（许可/维护责任），按公开服务契约独立实现。
- 升级 worker 前先确认板上 `queued/claimed/running=0`；逐台、用户同意。

---

## 8. 新会话开场提示（可直接粘贴）

> 你要做的是一个新 DSH 插件 `dsh-worker`（包名 `dsh-job-worker`），用于替代 `dsh-remote-agent` 的通信/执行层。
> 先读 `D:\gp_video\dsh-job-board\docs\handoff-worker-plugin-20261115.md`，再读仓库根 `AGENTS.md`。
> 只做 worker 插件；不要改 `dsh-job-board` 本体。接口只通过作业板 HTTP API。
> 测试标准：① 先用 GT14 本地 `qwen35-9b` 窄问审一遍关键代码；② 再用小模型做安全审核两遍（第二遍只审修复增量），两遍 PASS 才能推送；③ 主控自检。
> 第一里程碑：PC2 上用假看板跑通 claim→exec→mark，不依赖 remote-agent。
