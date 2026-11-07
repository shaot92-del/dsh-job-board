# README / CHANGELOG 补充段落（草案）/ Proposed sections

> 草稿 · Draft — 只给文本，不改仓库里的 `README.md` / `CHANGELOG.md`，不提交。
> 插入位置按 v1.1.10（`8cb7108`）的现有结构标注；行号会随编辑漂移，以标题锚点为准。

## 目录

1. [README 新增章节（中文，可直接插入）](#1-readme-新增章节中文可直接插入)
2. [README 既有表述的两处修正](#2-readme-既有表述的两处修正)
3. [CHANGELOG 结构与条目草案](#3-changelog-结构与条目草案)
4. [English version（可选，供英文 README/CHANGELOG 使用）](#4-english-version可选供英文-readmechangelog-使用)

---

## 1. README 新增章节（中文，可直接插入）

**插入位置**：`## 配置` 之后、`## 自检` 之前（当前 `README.md:116` 与 `README.md:118` 之间）。

````markdown
## 部署与权限模型

这一节回答三个问题：这台机器允许 agent 跑什么、审批在哪一层、需要更强隔离时用什么。
它不是安全承诺——默认配置面向「自有机器 + 可信任务」。

### 命令执行策略：`allowedRoots` 只是工作目录白名单

`sh_run` 会真的执行命令。`allowedRoots` 只校验 `cwd` 是否落在白名单内
（见 `lib/shell.js` 的 `sh_run`；路径判断用 realpath + 大小写归一），
**不解析、不限制命令内容**：命令里 `cd` 到别处、调用任意程序、访问网络，都不受它约束。
`sh_read` / `sh_write` / `sh_list` 同理，只校验传入路径。

所以：

- 它不是沙箱，不能用来隔离不可信任务；
- 真正的隔离要在进程之外做：受限 OS 账户、独立 VM 或容器，并在账户权限层面限制可写目录；
- 不要以管理员身份运行 Host。

### 两种部署档位

| 档位 | `dispatchApproval` | 适用 | 代价 |
|---|---|---|---|
| 可信 worker（自动执行） | `auto` | 自有机器、任务来源可控、出问题能回滚 | agent 可以直接改文件/跑命令，靠账户权限兜底 |
| 需人工审批 | `manual` | 共享机器、命令有外部副作用、需要人看一眼 | remote-agent 对 exec 任务默认挂起等审批，约 30 分钟超时即失败；审批在 remote-agent 侧，不在作业板面板 |

可信 worker 示例（只有一台 Host 开自动派工，见下一节）：

```yaml
- id: team
  config:
    boardUrl: 'http://127.0.0.1:8965'
    machine: 'gt14'
    autoDispatch: false       # 派工权在 host 那台；这台只执行
    dispatchApproval: auto
    allowedRoots:
      - 'D:\gp_video'
    shellTimeoutMs: 120000
    maxOutputBytes: 200000
```

需要审批的 worker 只改一行：

```yaml
    dispatchApproval: manual
```

`manual` 不会在作业板面板弹出审批按钮；派工请求会停在 remote-agent 侧等人工处理，
超时后任务以失败回写。把它用在「跑错代价高」的机器上，而不是用来替代权限隔离。

## 调度所有权：一个板子只有一台 Host 自动派工

**约定：同一个 `boardUrl` 只允许一台 Host 设 `autoDispatch: true`。**
其余 Host 一律 `false`，只建单、看板、手工认领；它们仍然可以执行被派过来的任务。

| 机器 | 角色 | `autoDispatch` |
|---|---|---|
| host | 派工 + 终态回写 | `true` |
| gt14 / mb14 / pc2 | 只执行 | `false` |

为什么必须写死这条：

- `/api/take` 只保证**单次**原子占位，`dispatchOnce` 是 take → dispatch → attach 三步，
  中间没有事务；进程在第二步崩溃时，板子无法自行判断任务是否已经派出。
- 板子的 take 实现把「任务已 claimed 且 `taker == machine`」当作续租、返回 200。
  也就是说，两台 Host 只要配了**同一个 `machine` 名**，
  就会双双通过 take —— 同一任务可能被派两次。
- `attach` / `mark` 目前是无条件覆盖，旧实例在 `dispose` 之后仍可能把终态写回去。

新增一台 Host 时的检查清单：

1. 它的 `autoDispatch` 是 `false`；
2. 它的 `machine` 与其它 Host **不重名**（板子按名字区分执行机）；
3. 启动日志里是 `dispatcher: disabled`，全队只有一台显示 `dispatcher: active`；
4. 面板 `/api/board/ui/summary` 的派工身份与预期一致。

出问题时的排查顺序：

- 任务停在 `claimed` 且有 `remote_id`：看重启日志有没有 `pending attach restored`，
  等一轮补绑（TTL 6 小时）；不要手工改 `state.json`。
- 任务停在 `queued` 且日志反复 `take failed`：板子不支持 `/api/take`，或另一台
  Host 正持有该任务；先 `POST /api/board/ui/dispatch-pause` 停手再查。
- 怀疑重复派发：对照 remote-agent 的 `/tasks` 与板子上的 `remote_id`，
  同一 `goal` 出现两个远程任务即为双派，按上面的清单收掉多余的派工 Host。

**多调度器（未实现）**：确需多台 Host 同时派工时，再引入所有权租约 + 单调 fencing token：
板子拒绝过期令牌的 `attach` / `mark`，remote-agent 在 `/dispatch` 校验令牌后才受理。
在那之前，多开 `autoDispatch` 属于不受支持的配置。
````

## 2. README 既有表述的两处修正

| 位置 | 现状 | 建议改为 |
|---|---|---|
| `README.md:21` | `1) POST /api/take {task_id, machine:本机} ← 原子占位，别的 Host 抢不到` | `1) POST /api/take {task_id, machine:本机} ← 单次原子占位；同一 machine 名下的重复 take 会被当作续租（见「调度所有权」）` |
| `README.md:112` | `autoDispatch: true # v1.1：Host 后台自动派发 + 终态回写；设 false 退回纯手动` | 追加一行注释：`# 同一 boardUrl 只允许一台 Host 为 true，见「调度所有权」` |
| `README.md:136` | 真板子验收一句带过 | 追加：`板子替身与故障用例见 #10 / scripts/test-board.mjs（落地后）` |

## 3. CHANGELOG 结构与条目草案

### 3.1 先修结构

当前最新条目在标题之上：`CHANGELOG.md:1-19` 是 v1.1.10，`CHANGELOG.md:20` 才是 `# 变更日志`。
建议把 `# 变更日志` 移到第 1 行，条目按版本倒序排在下面；否则 GitHub 渲染时首个版本没有标题层级。

### 3.2 新条目草案（占位，按实际合并内容删减）

> 规则：**只写已合并的内容**。下面用 `<!-- -->` 标出的条目若本版没合，整条删除，不要把计划写进 CHANGELOG。
> v1.1.10 条目末尾承诺了「运行时验证见下一条发布说明」，这一版要把它兑现。

```markdown
## v1.1.11 — 2026-11-XX

派工恢复与调度所有权的最小一步（issue #10 的第 1、2 条），以及部署级命令执行策略文档。

- **派工可恢复（#10-1，降级版）**（`lib/index.js`）：`dispatchOnce` 在调用 remote-agent
  之前落盘 attempt 记录（请求 ID、目标机、阶段、时间）；dispatch 超时/断连不再立即 `untake`，
  任务进入 `dispatch-unknown`，先查 `GET /api/remote-agent/ui/tasks` 对账，确认未受理才退回队列；
  进程重启后先对账再派发。日志与摘要路由暴露 `attempt_id`、`remote_id` 与 unknown 计数。
  - 限制：remote-agent 0.9.x 的 `/dispatch` 不回显请求 ID，`/tasks` 也没有按请求 ID 检索的字段，
    本版只能做到「有界重复窗口 + 可对账」，**不是 exactly-once**；强幂等需上游提供关联键后另做。
- **调度所有权（#10-2）**（`lib/index.js` + 板子）：`/api/take` 增加独立于 machine 名的
  dispatcher 身份（machine + pid + 启动时间），板子只对同一 dispatcher 允许 reentrant 续租；
  启动日志与 `/api/board/ui/summary` 暴露 `dispatcher: active|disabled`；README 新增
  「一个板子一台派工 Host」约定、机器表与新增 Host 检查清单。
  - 原因：`do_take` 对同 machine 名的重复 take 返回 200 续租，两台 Host 会同时拿到派发权。
- **部署文档（#10-4）**（`README.md`，docs-only）：新增「部署与权限模型」——`allowedRoots`
  只约束 cwd/路径、不约束命令内容、不是沙箱；可信 worker / 需审批 worker 两档 YAML；
  隔离需求走受限账户或独立环境。`autoDispatch` 默认值与工具行为不变。
- <!-- 若本版包含 --> **板子替身与故障用例（#10-5）**（`scripts/test-board.mjs`）：
  Node 内存板子复刻 take/untake/attach 语义，注入「受理后丢响应 / 超时 / 重复回执 / 重启」，
  断言不重复执行、不丢绑定、旧实例不回写；#8/#9 的复现纳入同一套。
- 验证：`node --check` 0 错；`plugcheck` PASS（16 工具 / 12 路由）；
  <!-- 若已跑 --> 故障用例 X/Y 通过；v1.1.10 的运行时复验：<补齐三机结果与探针耗时>。
```

### 3.3 如果本版只发文档

只保留「部署文档」与「README 修正」两条，版本号用 `v1.1.11` 或 `v1.2.0` 均可，
但**不要**在 CHANGELOG 里出现未合并的实现描述；README 的「调度所有权」一节可以先落地，
它描述的是部署约定与当前限制，不依赖 E2-3/E2-4 的代码。

## 4. English version（可选，供英文 README/CHANGELOG 使用）

### 4.1 Deployment and permission model

````markdown
## Deployment and permission model

This section answers three questions: what the agent may run on this machine, where approval
happens, and what to use when you need real isolation. It is not a security guarantee — the
default configuration targets trusted tasks on machines you own.

### Command execution: `allowedRoots` is a working-directory allowlist

`sh_run` really executes commands. `allowedRoots` only checks that `cwd` resolves inside the
allowlist (the `sh_run` implementation in `lib/shell.js`; the path check uses realpath plus
case-normalisation). It does **not** parse or restrict the command itself: changing directory,
calling arbitrary programs, and network access are all outside its scope. `sh_read`, `sh_write`
and `sh_list` likewise only validate the paths they are given.

Therefore:

- it is not a sandbox and must not be used to contain untrusted tasks;
- real isolation belongs outside the process: a restricted OS account, a dedicated VM, or a
  container, with writable directories limited by account permissions;
- never run the host elevated.

### Two deployment profiles

| Profile | `dispatchApproval` | Use when | Cost |
|---|---|---|---|
| Trusted worker (auto-exec) | `auto` | Machines you own, task source controlled, rollback possible | The agent can edit files and run commands directly; account permissions are the backstop |
| Approval required | `manual` | Shared machines, commands with external side effects | remote-agent holds exec tasks for approval and fails them after roughly 30 minutes; approval happens on the remote-agent side, not in the board panel |

Trusted worker (only one host dispatches — see the next section):

```yaml
- id: team
  config:
    boardUrl: 'http://127.0.0.1:8965'
    machine: 'gt14'
    autoDispatch: false       # dispatch authority lives on the host machine
    dispatchApproval: auto
    allowedRoots:
      - 'D:\gp_video'
```

For an approval-required worker, change one line to `dispatchApproval: manual`. It does not add
an approval button to the board panel; the request waits on the remote-agent side and fails on
timeout. Use it where a wrong command is expensive, not as a substitute for permission isolation.

## Dispatch ownership: one host per board

**Convention: exactly one host per `boardUrl` sets `autoDispatch: true`.** Every other host sets
it to `false` and only creates tasks, displays the board, and claims manually; it can still
execute work dispatched to it.

| Machine | Role | `autoDispatch` |
|---|---|---|
| host | dispatch + terminal write-back | `true` |
| gt14 / mb14 / pc2 | execute only | `false` |

Why this must be explicit:

- `/api/take` guarantees a **single** atomic claim, while `dispatchOnce` is take → dispatch →
  attach with no transaction across the three steps; if the process dies after step two, the
  board cannot tell whether the task was dispatched.
- The board's take implementation returns 200 as a lease renewal when the task is already
  claimed and `taker == machine`. Two hosts sharing the same `machine` name both
  pass the take, so one task can be dispatched twice.
- `attach` and `mark` currently overwrite unconditionally, so a stale instance can still write a
  terminal state back after `dispose`.

Checklist when adding a host:

1. `autoDispatch` is `false`;
2. its `machine` name differs from every other host (the board keys execution machines by name);
3. startup logs show `dispatcher: disabled`, and exactly one host shows `dispatcher: active`;
4. the dispatcher identity in `/api/board/ui/summary` matches expectations.

Troubleshooting order:

- Task stuck in `claimed` with a `remote_id`: look for `pending attach restored` after restart
  and wait one attach-retry round (6h TTL). Do not hand-edit `state.json`.
- Task stuck in `queued` with repeated `take failed`: the board lacks `/api/take`, or another
  host holds the task. Pause first with `POST /api/board/ui/dispatch-pause`, then investigate.
- Suspected double dispatch: compare remote-agent `/tasks` with the board's `remote_id`. Two
  remote tasks for one goal means a double dispatch; remove the extra dispatching host per the
  checklist above.

**Multiple schedulers (not implemented):** if several hosts must dispatch concurrently, add an
ownership lease with a monotonic fencing token: the board rejects `attach`/`mark` carrying a stale
token, and remote-agent validates the token before accepting `/dispatch`. Until then, running more
than one `autoDispatch: true` host is an unsupported configuration.
````

### 4.2 CHANGELOG entry (English, only if the repo keeps an English changelog)

```markdown
## v1.1.11 — 2026-11-XX

First step on dispatch recovery and dispatch ownership (issue #10, items 1 and 2), plus
deployment-level command-execution documentation.

- **Resumable dispatch (#10-1, degraded)** (`lib/index.js`): an attempt record (request id,
  target machine, phase, timestamp) is persisted before calling remote-agent; a timeout or
  disconnect no longer untakes immediately — the task enters `dispatch-unknown`, reconciles
  against `GET /api/remote-agent/ui/tasks`, and is only requeued once non-acceptance is
  confirmed. Reconciliation runs before dispatch after a restart. Logs and the summary route
  expose `attempt_id`, `remote_id`, and the unknown count.
  - Limitation: remote-agent 0.9.x does not echo a request id and `/tasks` cannot be searched by
    one, so this release provides a bounded duplicate window with reconciliation — **not
    exactly-once**. Strong idempotency needs an upstream correlation key.
- **Dispatch ownership (#10-2)** (`lib/index.js` + board): `/api/take` carries a dispatcher
  identity independent of the machine name; the board only allows reentrant renewal for the same
  dispatcher. Startup logs and `/api/board/ui/summary` expose `dispatcher: active|disabled`.
  README documents the one-dispatcher-per-board convention, a machine table, and an onboarding
  checklist. Reason: `do_take` renews on `taker == machine`, so two hosts sharing a machine name
  both win the take.
- **Deployment documentation (#10-4)** (docs-only): a "deployment and permission model" section —
  `allowedRoots` constrains cwd/paths only, not command content, and is not a sandbox; two YAML
  profiles (trusted vs approval-required); isolation via restricted accounts or isolated
  environments. Defaults and tool behaviour unchanged.
- Verification: `node --check` clean; `plugcheck` PASS (16 tools / 12 routes); fault suite
  (placeholder) and the v1.1.10 runtime re-verification (placeholder).
```
