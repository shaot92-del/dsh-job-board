# 06 · 派工恢复状态机（#10 建议 1 的第一版实现）

> 对应 GitHub issue #10 建议 1：「把派工从一步式改成可恢复流程，结果未知先查询不重派」。
> 版本：v1.2.0（2026-11-08）。适用范围：`dsh-team` 的 Host 自动调度器。

## 1. 为什么需要它

一条自动任务的派工跨三个外部写操作：

| 步骤 | 调用 | 语义 |
| --- | --- | --- |
| ① 认领 | `POST /api/take`（板子） | 板上任务从 `queued` 变成「本机占着」 |
| ② 派出 | `POST /api/remote-agent/ui/dispatch`（hub） | 副机上真的建出一条任务 |
| ③ 回绑 | `POST /api/attach`（板子） | 把远程任务号写回板上 |

每一步都可能「请求发出去、回执没回来」：超时、连接被断、网关 5xx。
v1.1.x 的处理是**任何一步失败都 `untake` 后下一轮重来**。对 ① 和 ③ 尚可，
对 ② 是错的：超时的那一刻副机上可能已经开跑，重派 = 同一条任务跑两遍。

## 2. 状态与落盘

在途状态写在 `~/.dsh/dsh-team/dispatch-journal-<machine>-<boardTag>.json`
（与 `pending-attach-*.json` 同目录、同隔离维度），只留两个非终态相位：

```json
[{ "taskId": "bd-6muiyu-6f14", "nodeId": "desktop-2gh05s7", "machine": "MB14",
   "goal": "…", "mode": "agent", "workspace": "", "phase": "unknown",
   "at": 1794105381358, "lastError": "remote-agent 无响应（20000 毫秒超时）" }]
```

| 相位 | 含义 | 下一轮怎么处理 |
| --- | --- | --- |
| `claimed` | 板上已认领，`/dispatch` 还没发出（或 `take` 结果未知） | 按板上现状判定：`status=claimed/running` 或 `taker` 非空 ⇒ 直接补发；仍 `queued` ⇒ 重新 take |
| `unknown` | `/dispatch` 已发出，结果未知 | **先查询**：`/tasks` 里同 `goal`、`createdAt ≥ at−5s` 的任务就是它 ⇒ 只 `attach`；超过 `unknownGraceMs` 仍查不到 ⇒ `untake` 放回队列 |
| （无条目） | 已回绑 | `attach` 失败的那一支由 `pendingAttach` 负责，只重试 attach |

TTL 2 小时；`dispose` 时整体落盘，新实例 `apply` 时读回继续收尾（与 pendingAttach 一致）。

## 3. 判定「结果是否已知」

`isUnknownOutcome(res)`：

- 2xx → 已知成功
- 4xx → 已知失败（没做成，可以安全重派）
- `status === 0`（超时 / fetch 失败）或 5xx → **未知**

`take` 超时同样按未知处理：记 `claimed`，下一轮看板上 `taker` 再决定，不盲目重来。

## 4. 超时

写路径（所有 `POST`）默认 `max(cfg.timeoutMs, 20000)`，读路径保持 `cfg.timeoutMs`，
这样调度 tick 不会被慢写拖长。板子实测写路径 6.1 s（`/api/caps`）、快照 6–7 s / 110 KB，
20 s 是「够宽」而不是「求解」——真正的恢复语义在状态机里。

可配置项（默认值即生产值，后两项主要为隔离验证存在）：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `writeTimeoutMs` | `max(timeoutMs, 20000)` | 写路径超时 |
| `dispatchTickMs` | `4000` | 调度节拍 |
| `unknownGraceMs` | `30000` | 结果未知到判定「远端没有」的观察窗口 |

## 5. 日志（故障时按顺序看这几条）

```
dispatch resume bd-… : 上一轮已认领未发出，直接补发（不重新 take）
take unknown bd-… : <err>（下一轮按板上 taker 判定，不盲目重来）
dispatch unknown bd-… → <node> : <err>（先查远端再决定，不重派）
dispatch recovered bd-… remote=ui-…（结果未知 → 远端确有此任务，只补绑不重派）
dispatch unknown 已澄清 bd-…（远端无此任务，NNNms），已放回队列
dispatch journal restored: N 条在途（claimed/unknown）
```

## 6. 验证

`node scripts/dispatch-recovery-smoke.mjs`（假板子 + 假 hub，14 项断言，已并入 CI）：

- **R1**：`/dispatch` 超时但远端已建任务 → `/dispatch` 只调 1 次、`attach` 1 次、`untake` 0 次；
- **R2**：`/dispatch` 超时且远端确实没有 → `untake` 1 次、重派 1 次、远端仍只有 1 条任务；
- **R3**：已认领未发出（崩溃恢复）→ `take` 0 次、直接补发并回绑。

## 7. 尚未覆盖（下一步）

- `attach` 目前仍只重试、不做「远端任务是否还在」的校验；更完整的状态要加上
  `pending_approval`、`running`、终态的分类回读（`syncRemote` 已覆盖终态回写）。
- 跨 Host 收敛：同一板子上多个 Host 都可能建单，最终归档仍需板子侧校验（#10 建议 2）。
- 幂等键：remote-agent 0.9.x 的 `/dispatch` 不接受客户端任务号，本版只能用
  `goal + 创建时间` 反查。等上游支持传入关联 ID，应改成显式幂等键，
  反查降级为兜底。
