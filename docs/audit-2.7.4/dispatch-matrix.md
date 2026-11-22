# 2.7.4 真机派工矩阵 D1–D8（2026-11-22 12:10 起，重启后）

环境：host DSH 2.7.3+UI补丁（client `F5A102B2…`，GUI 端口 2315）；board HTTP 8965；GT14 `plugin=2.7.3`、PC2 在线。
取证：`L:\云盘\gp_video_xfer\_board\state.json`（task_id → status / note / remote_id）。

## 结果总表

| # | 目标 | mode | model | task_id | 终态 | 判据 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 本机 | exec | — | —（board 拒绝 host 目标） | **PASS（本机 shell 路径）** | `sh_run` exit=0；board 对 host 派工返回「host 是主控自己…派了会永远排队」= 设计如此 |
| D2 | GT14 | exec | — | —（不可派） | **BLOCKED（策略）** | GT14 `allowlist=0` + `allowInline=0` + 写通道关闭 ⇒ 远程无法执行任何脚本 |
| D3 | GT14 | agent | auto | `bd-rbq5va-c2aa` | **BLOCKED（agent-disabled）** | note `worker:gt14 … reason=agent-disabled（worker.agentEnabled=false）`，`remote_id` 空 ⇒ 通道正确 |
| D4 | GT14 | agent | `local-llama/qwen35-9b` | `bd-rbq8b6-3e20` | **BLOCKED（agent-disabled）** | 同上；**`remote_id` 为空 = 未进远程桥**（2.7.2 修复的关键判据 ✔） |
| D5 | GT14 | agent | `deepseek-account/deepseek-flash` | `bd-rbqbbd-8deb` | **BLOCKED（agent-disabled）** | 同上；仍是本机 worker 通道，note 可读、非沉默 failed ✔ |
| D6 | PC2 | agent | `local-llama/deepseek-v4-pro-qwen3.5-9b` | `bd-rbnkx7-af59` | **BLOCKED（agent-not-allowlisted）** | note `worker:pc2 … agentAllowlist 里没有匹配的条目`，`remote_id` 空 ✔ |
| D7 | GT14 | agent | `local-llama/no-such-model-9b` | 未上板 | **PASS（前置拦截）** | 派工前置直接拒绝：「这台机器没有上报模型「local-llama/no-such-model-9b」」⇒ 秒级拦、不进队列 |
| D8 | GT14 | maint | version | `bd-rbml1w-8049` | **PASS** | note `worker:gt14 … verb=version ok=1 plugin=2.7.3 node=v24.21.0 win32/x64 … allowlist=0 agent=off` |

## 逐条解读

- **D1**：宿主本机不能作为板子目标（设计如此），本机 exec 由 DSH 自己的 `sh_run` 覆盖：`Write-Output D1-OK` → `exit=0`，输出 `D1-OK`。
- **D2（未通）**：GT14 的 `worker.allowlist=0`（脚本白名单空）+ `allowInline=0`（禁内联命令）+ 维护写通道关闭 ⇒ 远程既不能跑内联也不能跑脚本，也改不了配置。这不是代码缺陷，是安全默认值。
- **D3/D4/D5（未到 done）**：三次派工 `remote_id` **全为空**、note 均带 `worker:gt14` ⇒ 带 model 的 agent 任务确实落在副机本机 worker，**没有再被 host 送进远程 headless 桥**（这正是 2.7.2 `canDispatchRemote` 要保证的行为）。卡点是 GT14 `agentEnabled=false`。
- **D6（未到 done）**：PC2 走了本机 worker（`worker:pc2`、`remote_id` 空），卡在 `agentAllowlist` 里没有能命中的条目（对象缺 `matchAll`/前缀，被 `agent-gate.js` 静默丢弃）。
- **D7**：前端/工具前置校验直接拦住不存在的模型，不需要上板 —— 比 WI 期望的「秒级 blocked」更早，属更好结果。
- **D8**：维护读通道正常，且带回 `plugin=2.7.3` 与整份配置摘要，可作后续版本核对基线。

## 结论

**代码侧 8 格判据全部符合预期**（通道正确性 D3–D6 全过、D1/D7/D8 通）；**D2–D6 差的是两台副机的本地配置**，不是 2.7.4 改动，也不是回归。

## 要把 D2–D6 推到 done，需要的副机本地动作（每台一条命令 + 重启）

GT14（缺：写通道 + exec 白名单 + agent 开关）：

```powershell
# 在 GT14 上：开维护写通道（之后主控可远程 config-set）
pwsh -NoProfile -ExecutionPolicy Bypass -File Z:\_tools\dsh-job-board\enable-maint-write.ps1 -PublicKey 'MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k='
# 再手工把 exec 白名单指向共享盘（allowlist 不在远程可写键里）
#   worker: { allowlist: ['Z:\_tools\dsh-job-board'] }
# 重启 DSH
```

PC2（缺：agentAllowlist 可命中条目）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File Z:\_tools\dsh-job-board\enable-maint-write.ps1 -PublicKey 'MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k='
# 或直接改 worker.agentAllowlist 加一条： { id: any, matchAll: true }
```

打开写通道后我可在几分钟内把 D2–D6 全部推到 `done` 并补拍 UI 截图。