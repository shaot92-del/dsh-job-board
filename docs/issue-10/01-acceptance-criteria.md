# Issue #10 验收标准 / Acceptance Criteria

> 草稿 · Draft — 仅供 #10 讨论，未提交、未发布。
> 基线 / Baseline: `8cb7108`（v1.1.10）。文中所有行号均指该 commit。
> 对应 issue: [#10 \[架构改进\] 优先明确派工恢复与调度所有权，再补协议边界和故障验收](https://github.com/shaot92-del/dsh-team/issues/10)

---

## 0. 怎么用这份清单 / How to use

- 每条标准都有编号（`E1-1`…`E5-7`），可直接在 issue 里引用、逐条勾选。
- **勾选口径**：代码 + 测试 + 文档三样齐才算 `[x]`；只有文档没有行为的条目，写明 `docs-only`。
- 工作量口径：1 名熟悉本仓库的开发者，按 6 小时/天折算，**不含**上游（`remote-agent` / 板子服务）评审与排期等待；区间为 P50–P80，不是承诺。
- 优先级沿用 issue 作者定性：**先 1、2，3/4/5 渐进**；不拆包、不引入微服务、不做泛化重构。

术语 / Glossary：

| 中文 | English | 含义 |
|---|---|---|
| 派工 / 派发 | dispatch | Host 把板子任务交给 remote-agent 执行 |
| 认领占位 | claim / take | 板子上的单次原子占位（`/api/take`） |
| 结果未知 | dispatch-unknown | 请求可能已送达、但本地没拿到受理结果 |
| 待回绑 | pending attach | 远程任务已建、板子任务号尚未写回 |
| 对账 | reconcile | 用远端任务列表反查本地不确定的派发 |
| 调度所有权 | dispatch ownership | 谁有权自动派工；多实例时如何互斥 |
| 栅栏令牌 | fencing token | 单调递增的版本号，用于拒绝旧实例的写入 |
| 协议替身 | protocol double | 测试用的内存板子/假服务 |

### 总览 / Summary

| 建议 | 目标版本 | 仓库内/外 | 剩余工作量（人日） | 外部阻塞 |
|---|---|---|---|---|
| 1 可恢复派工 | v1.1.11（降级版）→ v1.2（强幂等） | 内 + 外 | 2.5–4（+0.5–1 上游） | remote-agent 关联 ID 契约 |
| 2 调度所有权 | v1.1.11（约定 + 守卫） | 内 + 板子小改 | 1.5–2.5（+3–5 多调度器） | 板子 `dispatcher` 字段；多调度器另需 remote-agent |
| 3 统一业务操作 | v1.2 起分片 | 内 | 3–5.5 | 无 |
| 4 部署执行策略 | v1.1.11（docs-only） | 内 | 0.5–1 | 无 |
| 5 故障验收 | v1.2（依赖 1、2 的形状） | 内 | 3.5–5 | 无（替身替代 `board_server.py`） |

建议顺序（与 issue 一致）：**2 的部署约定 → 1 的「响应丢失→查询→恢复」→ 5 的替身与故障用例 → 2 的多调度器（按需）→ 3 的分片**。

---

## 1. 把跨步骤派工变成可恢复流程 / Resumable dispatch

### 现状（v1.1.10）

- `dispatchOnce`（`lib/index.js:838-952`）串行执行 take → dispatch → attach，三步之间没有持久化边界。
- 只有 attach 失败会落盘重试（`lib/index.js:800-836`、`lib/index.js:688-796`）；dispatch 一旦网络错误、超时或响应丢失，代码在 `lib/index.js:913-918`、`lib/index.js:919-926` 直接 `untake`，任务回到 `queued`，下一轮会再次被 take 并重新派发。
- `remoteUi`（`lib/index.js:593-620`）把所有异常折叠成 `{ ok: false, error }`，不区分「请求没发出去」「发出去了但没响应」「远端已受理」。这是重复执行的根因。
- 板子侧 `create` 对重复 `task_id` 返 409（不幂等），`attach`/`mark` 无条件覆盖，没有 CAS；remote-agent 0.9.x 的 `/dispatch` 不返回请求 ID，`GET /api/remote-agent/ui/tasks` 也没有按请求 ID 检索的字段。

### 目标状态

一条任务在任何一次崩溃/断网/重启后，只有两种结局：**被确认未受理（安全重派）** 或 **被确认已受理（补绑，不重派）**。做不到区分时，宁可停在 `dispatch-unknown` 等人/对账，也不重派。

### 验收标准 / Acceptance criteria

- [ ] **E1-1 写前日志**：调用 `/dispatch` **之前**落盘一条 attempt 记录，至少含 `task_id`、`attempt_id`、目标 `machine`/`nodeId`、开始时间、阶段；只存恢复所需字段，不复制 goal 全文。  
      EN: A write-ahead attempt record (task id, attempt id, target machine/node, started-at, phase) is persisted **before** the `/dispatch` call; no full goal copy.  
      代码位置：`lib/index.js:838-952`（插入点 `lib/index.js:892` 之后、`lib/index.js:902` 之前）；存储可复用 `lib/index.js:688-796` 的原子写模式。
- [ ] **E1-2 显式状态机**：内部区分 `claimed → dispatching → (dispatch-unknown | dispatched) → attached → running → terminal`，且**不新增板子状态值**——板子仍只看到现有 `queued/claimed/running/done/failed/blocked/superseded`，细状态只存在于本地 attempt 日志。  
      EN: Internal states are explicit, while the board schema is unchanged; fine-grained states live only in the local attempt journal.  
      代码位置：状态写入点 `lib/index.js:892`、`lib/index.js:931-940`；状态映射 `lib/index.js:954-958`。
- [ ] **E1-3 不确定不 untake**：dispatch 发生超时/连接重置/无响应时，**不得**立即 `untake`；任务进入 `dispatch-unknown` 并启动限时对账（默认 ≤ 30 秒，可配）。  
      EN: On timeout / reset / no response, the task is **not** immediately untaken; it enters `dispatch-unknown` with a bounded reconciliation window.  
      代码位置：改写 `lib/index.js:913-918`；需要 `remoteUi` 暴露「请求是否已发出」的判据（`lib/index.js:593-620`）。
- [ ] **E1-4 先查后派**：对账优先调用远端任务列表（现成轮询在 `lib/index.js:960-1028`），命中则直接 `attach` 并结束 attempt；只有**确认未受理**（窗口内无匹配）才允许 `untake` 回队列；不允许「先重派再查」。  
      EN: Reconcile queries the remote task list first; a match is adopted via attach, and only a confirmed absence allows untake. Never re-dispatch before querying.
- [ ] **E1-5 关联键是契约，不是本地 UUID**：去重/查询所用的关联键必须与 remote-agent **书面约定并验证**（响应回显请求 ID，或提供按请求 ID 查询的端点）。仅本插件生成 UUID、远端不回显，**不满足**本条；缺失时只能实现 E1-3/E1-4 的降级对账，且必须标注「best-effort，非强幂等」。  
      EN: The correlation key is a verified contract with remote-agent (echoed request id or a lookup endpoint). A locally generated UUID alone does **not** satisfy this row.
      外部依赖：`dsh-remote-agent` 0.9.x；见 `docs/review-response.md` 的外部契约表。
- [ ] **E1-6 重启先对账**：进程启动/插件 apply 时，先处理 `dispatch-unknown` 与 `pending-attach`，再允许对同一 task 发起新派发；`dispose` 只做持久化，不做新的网络写。  
      EN: On startup, unknown attempts and pending attaches are reconciled before any new dispatch for the same task; dispose persists and stops writing.  
      代码位置：`lib/index.js:1920-1948`（dispose）、`lib/index.js:847`（现有 retry 入口）。
- [ ] **E1-7 有界**：attempt 日志有 TTL（建议 ≤ 24h）与条数上限；超过对账窗口仍无结论的记录不得静默丢弃，要转为板上 note 或 `blocked`，交人工处理。  
      EN: The journal is bounded (TTL + cap); unresolved attempts escalate to a board note/blocked state instead of being dropped silently.  
      代码位置：TTL 模式可参照 `lib/index.js:694`（待回绑 6h）。
- [ ] **E1-8 故障测试**：模拟「远端已受理但响应丢失」时，**恰好 1 个**远程任务、板子最终 `running`/`done`、无重复执行；模拟「确实未受理」时，任务回到队列并可被再次派发。  
      EN: With a dropped response after remote acceptance, exactly one remote task exists and the board task converges without duplicate execution; a confirmed non-delivery is retried exactly once per round.  
      代码位置：新增用例，可挂在 #5 的替身上（`scripts/`）；现有 `scripts/plugcheck.mjs` 的 `stubFetch` 只覆盖成功路径。
- [ ] **E1-9 可观测**：日志与 `/api/board/ui/summary` 至少暴露最近一次 attempt 的 `attempt_id`、`remote_id`、`dispatch-unknown` 计数与最近对账时间，便于部署侧判断「卡住」还是「在查」。  
      EN: Logs and the summary route expose the latest attempt id, remote id, unknown count, and last reconcile time.  
      代码位置：`lib/index.js:521-530`（dispatchState）、`lib/index.js:1659-1693`（pause 回执可参考）。

### 依赖与风险

- **强幂等被上游阻塞**：没有 E1-5，E1-3/E1-4 只能把重复窗口从「必然」压到「小概率」，不能宣称 exactly-once。issue 里这句话要保留。
- 对账窗口过短会在慢网下误判「未受理」→ 重复派发；建议默认 30 秒并允许按机器配置。
- 若 remote-agent 的 `/tasks` 只返回最近 200 条（0.9.x 上限），大量并发时对账可能漏匹配，需要在文档里写明并优先按时间窗+node 过滤。

### 剩余工作量

| 项 | 人日 |
|---|---|
| 状态机 + attempt 日志 + dispose/启动接入 | 1–1.5 |
| 对账逻辑（复用 `/tasks` 轮询） | 0.5–1 |
| 故障用例（依赖 #5 替身） | 0.5–1 |
| 与 remote-agent 约定并验证关联键 | 0.5–1（外部） |
| **合计** | **2.5–4 内 + 0.5–1 外** |

置信度：中低（强幂等部分取决于上游）。

---

## 2. 明确谁有自动派工权 / Single-dispatcher ownership

### 现状（v1.1.10）

- `autoDispatch` 默认 `true`（`lib/index.js:124`），每个 Host 各自启动 4 秒派发定时器（`lib/index.js:1902-1916`）；没有任何跨实例互斥。
- `/api/take` 只带 `machine`（`lib/index.js:892`），板子 `do_take` 在「任务已 claimed 且 `taker == machine`」时返回 **200 续租**（`board_server.py:337-343`）。因此**两台 Host 只要配置同一个 `machine` 名，就会双双拿到派发权**，同一任务可能被派两次。README 第 21 行「原子占位，别的 Host 抢不到」在跨实例场景下不成立。
- `attach`（`board_server.py:284-311`）与 `mark`（`board_server.py:386-407`）都是无条件覆盖，旧实例可以在 `dispose` 之后仍把 `done` 写回 `running`。

### 目标状态（分两阶段）

- **Phase A（现在做）**：一个板子只有一台 Host 开自动派工；这件事既写进部署文档，也做成启动可见 + 冲突可检测；`take` 引入独立于 machine 名的 dispatcher 身份。
- **Phase B（确需多调度器时）**：所有权租约 + fencing token；板子拒绝过期令牌的 attach/mark，remote-agent 拒绝过期令牌的 dispatch。

### 验收标准 / Acceptance criteria

Phase A：

- [ ] **E2-1 部署约定成文**：README 新增「调度所有权」一节，明确「同一 `boardUrl` 只允许一台 Host `autoDispatch: true`」，其余 Host 设 `false` 只建单/展示；附一张示例机器表（host=派工，gt14/mb14=仅执行）。  
      EN: README states one-dispatcher-per-board and shows an example host table.  
      代码位置：`README.md:97-116` 之后新增；`README.md:112` 的注释同步指向该节。
- [ ] **E2-2 派工身份可见**：启动日志与 `/api/board/ui/summary` 暴露 `dispatcher: active|disabled`、`machine`、进程启动时间；两台 Host 同时开着时，运维能立刻看出来。现有 `trace('host dispatcher started …')`（`lib/index.js:1915`）只在上线时打印，需补 `disabled` 侧与身份字段。  
      EN: Startup log and summary expose dispatcher role, machine, and start time.  
      代码位置：`lib/index.js:1902-1916`（启动点）、`lib/index.js:1620-1623`（summary 路由）。
- [ ] **E2-3 冲突守卫**：检测到同一板子已有新鲜派工者时，后启动的实例**拒绝派工并降级为只读建单**，日志给出明确原因；不得静默双派。  
      EN: A second instance detecting a fresh dispatcher refuses to dispatch and degrades to create-only, with an explicit log line.
      实现选项：(a) 板子新增 `dispatcher` 心跳字段（推荐，跨机器也有效）；(b) 同机用文件锁 + 跨机靠约定。**仅靠文档不满足本条**，因为 issue 的诉求是「不能靠人记得」。
- [ ] **E2-4 take 身份与 machine 名解耦**：`/api/take` 带 `dispatcher`（`machine + pid + startedAt` 或稳定实例 ID），板子只在 `taker == dispatcher` 时允许 reentrant 续租；不同 dispatcher 对同一任务的第二次 take 返回 409。  
      EN: Take carries a dispatcher identity distinct from the machine name; reentrant renewal is scoped to that identity, and a second dispatcher gets 409.  
      代码位置：`lib/index.js:892`；`board_server.py:314-359`（约 15–30 行改动，板子不在本仓库）。
- [ ] **E2-5 双实例验收**：同一板子起两个 Host（相同 machine 名 / 不同 machine 名各一组），一条任务 → 远端只出现 1 个任务；输家日志为 `dispatcher conflict` 或 409，且板上任务不被回退。  
      EN: Two Hosts against one board produce exactly one remote task; the loser logs a conflict/409 and does not roll the board task back.
      依赖：E5-1 的板子替身（可先手工复现，再固化为用例）。
- [ ] **E2-6 旧实例不回写**（Phase A 最小版）：`dispose` 之后不再发起 attach/mark；若因在途请求晚到，板子侧应有条件（`remote_id` 匹配或状态版本）拒绝把终态拉回 running。  
      EN: After dispose, no attach/mark is issued; late in-flight writes cannot pull a terminal task back to running.  
      代码位置：`lib/index.js:1920-1948`；`board_server.py:386-407`。
- [ ] **E2-7 修正现有表述**：README 第 21 行「别的 Host 抢不到」改为准确表述（同一 machine 名下不重复、跨实例依赖 E2-4），避免部署者据此推断安全。  
      EN: Fix the README claim so it matches take's actual semantics.
- [ ] **E2-8 不改默认行为**：`autoDispatch` 默认值不变（`lib/index.js:124`），单机用户升级后行为不变；不新增常驻 UI 警告。  
      EN: Defaults unchanged; no persistent UI warning.

Phase B（deferred，不阻塞本 issue 关闭）：

- [ ] **E2-9 租约 + 栅栏令牌**：板子发放带单调版本的所有权租约；`attach`/`mark` 携带令牌，过期令牌 → 409；remote-agent 在 `/dispatch` 校验令牌后才受理（最后一项需上游支持）。  
      EN: Ownership lease with a monotonic fencing token; stale tokens are rejected by the board and, once supported, by remote-agent.
- [ ] **E2-10 租约失效可恢复**：派工者崩溃后租约到期，另一台 Host 能在 ≤ 2 个 tick 内接管，且旧实例即使复活也无法写入。  
      EN: Failover within two ticks; a resurrected stale instance cannot write.

### 依赖与风险

- E2-3/E2-4 需要改板子服务（不在本仓库、当前无鉴权）；若短期不能改，只能做到「文档 + 启动可见 + 单机文件锁」，跨机双派风险仍在，必须在 README 写明。
- 给 `machine` 加唯一性约束会与现有「机器别名」模型冲突（`lib/index.js:636-655`），E2-4 用独立 dispatcher 字段可以绕开。
- Phase B 没有 remote-agent 配合时只能防「回写」，防不住「派发」，收益有限——这也是 issue 建议先做约定的原因。

### 剩余工作量

| 项 | 人日 |
|---|---|
| 文档 + 启动/摘要可观测 | 0.5–1 |
| 板子 `dispatcher` 字段 + take 语义（含联调） | 1–1.5 |
| 双实例用例 | 0.5（依赖 #5） |
| Phase B（租约 + 令牌 + 上游） | 3–5 + 上游 |
| **Phase A 合计** | **1.5–2.5** |

---

## 3. 统一业务操作、逐步隔离协议细节 / One task model, incremental protocol isolation

### 现状（v1.1.10）

- `lib/index.js`（1955 行）同时承载：板子 HTTP、remote-agent 会话鉴权与 cookie（`lib/index.js:553-620`）、调度循环（`lib/index.js:838-1028`）、16 个工具、12 条 GUI 路由（`lib/index.js:1650-1810`）。
- 机器名映射有两份：Host 端 `lib/index.js:626-655`，前端 `lib/client.js:145-175`；任一处新增机器都要改两遍。
- 建单在路由（`lib/index.js:1750-1780`）与工具（`board_dispatch`）各有一份编排，状态转换散落在 attach/mark/untake 多处。

### 目标状态

面板和 agent 工具调用**同一个业务操作**；机器与任务只有一份模型；协议细节退到适配器后面，但**不要求一次性拆文件**。

### 验收标准 / Acceptance criteria

- [ ] **E3-1 机器模型单一来源**：`nodeId ↔ 板子别名 ↔ 展示名` 只有一份实现（共享纯模块或生成表），Host 与 `lib/client.js` 都引用它；新增机器只改一处。  
      EN: A single machine-identity source is shared by host and client bundle; adding a machine touches one place.  
      代码位置：`lib/index.js:626-655`、`lib/client.js:145-175`。
- [ ] **E3-2 奇偶校验测试**：同一组 `nodeId`/别名输入，工具输出与面板标签完全一致（大小写、连字符、未知机器的回退规则都覆盖）。  
      EN: A parity test proves tool output and panel labels agree for the same inputs, including unknown-host fallback.
- [ ] **E3-3 任务状态转换单一入口**：create / pick / attach / mark / release / 终态映射收敛为一组函数；路由与工具不再各自拼状态。  
      EN: Task transitions live in one module; routes and tools no longer assemble state changes independently.  
      代码位置：`lib/index.js:800-836`、`lib/index.js:954-958`、`lib/index.js:1650-1810`。
- [ ] **E3-4 面板与工具同操作**：面板「派工」与 `board_dispatch` 走同一 Host 操作（同一入参校验、同一选机、同一 goal≤300 规则），差异只在传输层。  
      EN: Panel dispatch and the `board_dispatch` tool share one host operation; only the transport differs.  
      代码位置：`lib/index.js:1750-1780` 与 `lib/index.js:1032+` 的工具注册。
- [ ] **E3-5 协议边界**：板子 HTTP 与 remote-agent 鉴权各自一个适配模块；工具/面板只接触领域对象，不直接读板子原始 JSON 字段（现有字段名在 UI 里出现的要有映射层）。  
      EN: Board HTTP and remote-agent auth sit behind adapters; tools/UI consume domain objects, not raw board JSON.
- [ ] **E3-6 复用既有读取路径**：面板、工具、对账统一走现有 `snapshot()` 读取与订阅，不新增第二套轮询/查询；新增字段先加到 snapshot 再消费。  
      EN: Panel, tools, and reconciliation reuse the existing `snapshot()` path; no second polling/query path is introduced.
- [ ] **E3-7 分片纪律**：每片单独可回滚，`plugcheck` 保持 PASS，工具名/入参/`output.render` 不变；**不更换插件加载方式、不拆包**。  
      EN: Each slice is independently revertible, keeps plugcheck green, and preserves tool contracts; no loader change, no package split.
- [ ] **E3-8 增量规则**：新代码不得再往 `lib/index.js` 添加协议/状态转换逻辑（可作为 review checklist，而非硬门禁）；以「重复逻辑是否真的挡住 1、2」为推进依据。  
      EN: New protocol/transition logic must not land in `lib/index.js`; progress is driven by real duplication blocking items 1–2.

### 依赖与风险

- 纯重构，无外部依赖；风险是回归面大而 `plugcheck` 只覆盖浅层契约 → 必须先补特征测试（E3-2/E3-3 即是）。
- `lib/client.js` 是浏览器 bundle，共享模块必须无 Node 内置依赖；若打包链路不便，退化为「生成表 + 校验脚本」，不要为此改加载方式。

### 剩余工作量

| 项 | 人日 |
|---|---|
| 机器模型 + parity 测试 | 0.5–1 |
| 任务状态转换收敛 | 1.5–2.5 |
| 适配器分层（可选，分片） | 1–2 |
| **合计** | **3–5.5** |

---

## 4. 部署级命令执行策略 / Deployment-level command policy

### 现状（v1.1.10）

- `sh_run` 只校验 `cwd` 是否在 `allowedRoots` 内（`lib/shell.js:238-256`），随后直接执行命令（`lib/shell.js:245`）；命令内容、子进程、网络访问均不受限。`withinRoots` 用 realpath + 大小写归一（`lib/shell.js:89-107`），只解决路径前缀判断。
- README 第 108-109 行已声明「不是沙箱」，但没有给出部署档位与示例；`dispatchApproval` 的 `auto/manual` 差异只写在配置注释里（`README.md:113-115`），没有说明「什么时候该用哪档」。

### 目标状态

部署者读完 README 能回答三个问题：这台机器允许 agent 跑什么？审批在哪一层？需要更强隔离时用什么？

### 验收标准 / Acceptance criteria

- [ ] **E4-1 信任模型成文**：新增「部署与权限模型」一节，第一段明确「agent 可在白名单 cwd 内执行任意命令；`allowedRoots` 不是沙箱」。  
      EN: A deployment section states plainly that the agent can run arbitrary commands inside the allowed cwd, and that allowedRoots is not a sandbox.  
      代码位置：`README.md:97-116` 之后；引用 `lib/shell.js:89-107`、`lib/shell.js:238-256`。
- [ ] **E4-2 两档部署示例**：给出「可信 worker（自动执行）」与「需审批 worker」两份 YAML，含 `autoDispatch`、`dispatchApproval`、`allowedRoots` 的取值理由。  
      EN: Two copy-paste YAML profiles: trusted auto-exec and approval-required, each with rationale.
- [ ] **E4-3 审批语义说清**：`manual` 时 remote-agent 对 exec 任务默认挂起（约 30 分钟超时即失败），审批发生在 remote-agent 侧，不在本插件面板；避免「设了 manual 以为板上点一下就行」。  
      EN: Explain where approval actually happens and the timeout behavior.
- [ ] **E4-4 隔离指引**：需要隔离的 worker 用受限 OS 账户 / 独立 VM / 容器；不要以管理员运行 Host；网络共享目录注意 ACL 与 realpath 语义。  
      EN: Isolation guidance: restricted account, VM, or container; never run the host elevated.
- [ ] **E4-5 不改行为**：`autoDispatch` 默认值、工具定位、UI 均不变；不新增常驻警告（符合 issue 明确要求）。  
      EN: No default changes and no persistent warning banner.
- [ ] **E4-6 一致性核对**：文档里的每个默认值都能在代码中找到（`lib/index.js:120-127`），并在 PR checklist 里加一条「改默认值必须同步 README」。  
      EN: Every documented default is traceable to code, with a checklist item to keep them in sync.

工作量为 docs-only，0.5–1 人日（含中英对照与一次代码核对）。无外部依赖。

---

## 5. 让故障验收能随仓库启动 / Fault acceptance that runs from the repo

### 现状（v1.1.10）

- CI 只有一个 job（`.github/workflows/plugcheck.yml:1-23`），跑 `scripts/plugcheck.mjs`；它是 `stubFetch` 离线自检，覆盖工具/路由契约，不覆盖多实例、断网、重启。
- `scripts/acceptance.mjs:191-208` 依赖环境变量 `GP_BOARD_PY` 指向仓库外的 `board_server.py`，缺失时直接 `exit 2`（`scripts/acceptance.mjs:193-198`）；部分素材是本机路径。也就是说：**新克隆仓库的人跑不了故障验收**。

### 目标状态

`git clone` 后一条命令跑完故障场景，不需要 Python、不需要真板子、不依赖作者机器上的文件。

### 验收标准 / Acceptance criteria

- [ ] **E5-1 板子替身**：新增 `scripts/test-board.mjs`，用 Node 内存实现插件实际用到的端点（create/list/claim/beat/take/untake/attach/mark/health/caps/metrics），随机端口、临时目录、进程退出即清理；语义对齐 `board_server.py`（含 take 的 reentrant 分支与 409 条件）。  
      EN: An in-memory Node board implements the endpoints the plugin actually uses, on an ephemeral port, with semantics matching the real board.
- [ ] **E5-2 故障注入**：替身支持按脚本注入「受理后丢响应」「500」「超时」「断网（连接拒绝 / 半开连接）」「重复回执」「暂停」「重启后状态保留」。  
      EN: The double can inject dropped-response-after-commit, 500, timeout, duplicate delivery, pause, and restart-with-state.
- [ ] **E5-3 场景覆盖**：两个调度器（同名/不同 machine）、worker 掉线、超时→unknown→对账恢复、暂停中途生效、重启后补绑、重复回执；并把 #8/#9 的复现脚本收进同一套。  
      EN: Scenarios cover two dispatchers, worker loss, timeout→unknown→recover, pause mid-round, restart with pending attach, duplicate receipts, and the #8/#9 repros.
- [ ] **E5-4 行为断言**：断言「每个板子任务最多一个远程任务」「已派发任务不丢绑定」「dispose 后旧实例零写入」「终态不被拉回 running」，而不是只断言请求形状。  
      EN: Assertions are behavioral: at most one remote task per board task, no lost binding, zero writes from a disposed instance, no terminal regression.
- [ ] **E5-5 CI 接入**：新增独立 job（或在现有 job 加一步），windows-latest + ubuntu-latest 双跑，全程离线，单次 < 120 秒；`plugcheck` 保留。  
      EN: A CI job runs the harness on both OSes, offline, under 120s; plugcheck stays.
- [ ] **E5-6 真板子路径可选**：`acceptance.mjs` 缺 `GP_BOARD_PY` 时给出可操作提示并按「跳过」处理（退出码语义要明确，不能与失败混淆）；仓库内提供临时素材，去掉个人绝对路径。  
      EN: The real-board path becomes optional with an explicit skip; fixtures move into the repo and personal absolute paths disappear.
- [ ] **E5-7 一条命令**：`package.json` 增加 `scripts.test` / `scripts.test:faults`，README 写明跑法；当前 `package.json` 没有 `scripts` 字段。  
      EN: One documented command; package.json currently has no scripts field.

### 依赖与风险

- 替身语义漂移是最大风险：必须有一份「与 `board_server.py` 的差异清单」并在 CI 里对关键语义（take 409 条件、attach 覆盖行为）做显式断言。
- E5-3 的部分场景依赖 E1/E2 的实现形状，建议先落 E5-1/E5-2，再随 1、2 的落地补场景。
- 时长控制：故障用例用假定时器/可注入时钟，不要真的 sleep 30 秒。

### 剩余工作量

| 项 | 人日 |
|---|---|
| 板子替身 | 1–1.5 |
| 故障注入 + 场景 | 2–3 |
| CI + 文档 + `acceptance.mjs` 收口 | 0.5–1 |
| **合计** | **3.5–5** |

---

## 6. 明确不在范围内 / Explicitly out of scope

- 拆包、微服务化、替换 Cordis 插件加载方式。
- 给板子加鉴权 / CORS 收紧（属独立安全议题，issue 未要求）。
- 改变 `autoDispatch` 默认值或给 UI 加常驻安全警告。
- 一次性重写 `lib/index.js`；第 3 条只做「新代码不加剧耦合 + 分片收敛」。
- 强 exactly-once 承诺：在 E1-5 落地前，对外只描述为「有界重复窗口 + 可对账」。

## 7. 建议的落地顺序与验收口径

1. **第 2 条 Phase A**（约定 + 可观测 + take 身份）：1.5–2.5 人日，可与第 4 条文档同批发布。
2. **第 1 条降级版**（写前日志 + unknown + 对账）：2.5–4 人日，依赖第 5 条替身做验收。
3. **第 5 条**（替身 + 故障用例 + CI）：3.5–5 人日，与 1、2 交错进行。
4. **第 3 条**分片：3–5.5 人日，按重复逻辑是否挡路推进。
5. **第 2 条 Phase B / 第 1 条强幂等**：需上游配合，单独立项。

「完成」的判定：对应条目的全部 checkbox 为 `[x]`，且 CI 能在干净克隆上复现；仅代码合并、无故障用例的，不算完成。
