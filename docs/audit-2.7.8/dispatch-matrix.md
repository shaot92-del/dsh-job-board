# D1–D8 真机派工矩阵 · v2.7.8

- 时间：2026-11-22 20:19
- 主机：`doctor` → `version=2.7.8 / installedVersion=2.7.8`（GUI 6660，板子 8965）
- GT14：`maint version` → `plugin=2.7.8`、`maintenanceEnabled=1`、`agentEnabled=1 agentAllowlist=1`
- PC2：在线（未升级，留给官方渠道更新验证）

| 编号 | 场景 | 结果 | 判据 | 证据 |
|---|---|---|---|---|
| D1 | 本机 exec | PASS | exit=0，`pwsh 7.6.9` / `D1-OK-278` | 主机直接执行 |
| D2 | GT14 exec（远程脚本） | BLOCKED(策略) | `allowlist=0 allowInline=0` | 需副机本机开 allowlist |
| D3 | GT14 agent auto（空 model） | BLOCKED(设计) | `agent-approval-required allow=any fp=a76e77f1…`，`remote` 空 ⇒ 落本机 worker | `d3-201746` |
| D4 | GT14 agent 本机模型 `local-llama/qwen35-9b` | BLOCKED(设计) | `agent-approval-required fp=384d6658…`，`remote` 空 ⇒ 带 model 仍走 worker（2.7.2 判据成立） | `d4-201746` |
| D5 | GT14 agent 云模型 `deepseek-account/deepseek-flash` | BLOCKED(可操作) | `agent-approval-required fp=c4e671ca…`，`remote` 空（未进远程 headless） | `d5-201746` |
| D6 | PC2 agent 云模型 | BLOCKED(配置) | `agent-cwd-denied why=outside cwd=%USERPROFILE% root=%USERPROFILE%/Documents` | `d6-201746` |
| D7 | 不存在模型 `local-llama/no-such-model-9b` | BLOCKED(设计) | 先命中审批门 `fp=09d5975c…`，note 可操作 | `d7-201746` |
| D8 | GT14 maint version | PASS | `plugin=2.7.8 node=v24.21.0 workerMode=on maintenanceEnabled=1` | `probe-201614` |

## 结论
- 代码侧判据成立：**带 model 的 agent 任务全部落本机 worker（`remote` 为空）**，不再被远程 headless 桥拒；maint 通道正常；2.7.8 真机生效。
- 未到 `done` 的项都是**配置/审批**，不是代码缺陷：
  - 审批门（D3/D4/D5/D7）：`approvalMode=manual` 的设计行为，note 已给 `worker_control action=approve taskId=…`。
  - D2：GT14 `allowlist=0`（远程脚本白名单为空）。
  - D6：PC2 `agentCwdRoot=%USERPROFILE%\Documents`，任务 cwd 在 `%USERPROFILE%`。

## 待办
- D4 补一做：GT14 本机 `worker_control action=approve taskId=d4-201746` 后看是否 `done`。
- PC2 待升级 2.7.8 后再校准 cwd/allowlist。