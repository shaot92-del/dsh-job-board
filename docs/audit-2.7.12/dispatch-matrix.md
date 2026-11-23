# 2.7.12 真机派工矩阵（D1–D8）

时间：2026-11-23 07:35–07:40（主机 2.7.12；GT14 文件已升 2.7.12 但**进程仍是 2.7.10**）

| 项 | 机器/模式/模型 | 结果 | 判读 |
|---|---|---|---|
| D1 | host / exec | board 派 host 永远排队（host 是 owner 不是 worker）；本机 `sh_run` 直跑 = `D1-OK`、exit 0 | **PASS** |
| D2 | GT14 / exec（`Z:\_tools\dsh-job-board\smoke-hello.ps1`） | blocked `approval-required（脚本不在 allowlist 内）` | 策略阻断，符合预期（`allowlist=0`） |
| D3 | GT14 / agent / 自动 | failed `has no provider/model`，`remote_id` 空 | 通道正确（落本机 worker）；空模型提示待改进 → P3 |
| D4 | GT14 / agent / `local-llama/qwen35-9b` | failed `503 acp-proxy: connect-refused 127.0.0.1:8080` | 通道正确；GT14 的 llama.cpp 没起（基础设施） |
| D5 | GT14 / agent / `deepseek-account/deepseek-flash` | **done** `text=2ch answer="收到"`、`remote_id` 空、1097ms | **PASS**：云模型走本机 worker |
| D6 | PC2 / agent / `local-llama/deepseek-v4-pro-qwen3.5-9b` | blocked `agent-cwd-denied … root=%USERPROFILE%/Documents` | PC2 仍 2.7.10（变量未展开）→ 待升 2.7.12 |
| D7 | GT14 / agent / `local-llama/no-such-model-9b` | failed `provider "local-llama" has no configured model "no-such-model-9b"` | 可操作错误，PASS |
| D8 | GT14 / maint version | done `plugin=2.7.10`、`inst=gt14/22560-f2a88a4c` | 版本仍旧 → 见文末 |

## 关键结论

1. **`canDispatchRemote` 生效**：D3/D4/D5 的 `remote_id` 全为空，全落 GT14 本机 worker，没有再被远程 headless 桥接。
2. **云模型真跑通**（D5）：`deepseek-account` 在副机 in-process 场景可用。
3. D2/D6 属副机本地策略：GT14 `allowlist=0`、PC2 仍 2.7.10 的 `%USERPROFILE%` 未展开。

## 遗留：GT14 装了包但没重启

`up-2712b-073248` → `已安装 v2.7.12（约 6 秒后自动重启）`，但 `maint version` 仍 `plugin=2.7.10`、实例号未变。
原因：**执行升级的是 GT14 上正在跑的 2.7.10**，它的重启助手还是「只按 pid 杀」（2.7.11 才改成按 exe 路径枚举）→ 被拒后静默失败。
⇒ bootstrap 问题，非 2.7.12 缺陷：**GT14 手动重启一次 DSH 即可**，之后远程升级才会用上新的助手。

## 追加：GT14 重启后（进程 2.7.12，inst `gt14/19452-630268a4`）

- `maint version` → **`plugin=2.7.12`**、`workerMode=on approvalMode=manual allowlist=0 agent=on agentAllowlist=1`。
- **D5 复跑 PASS**：`deepseek-account/deepseek-flash` → `answer="收到"`、`remote_id` 空、2.8s。
- **D3 复跑**：仍是 `has no provider/model`（空模型时的缺省行为，`remote_id` 空）→ P3 待改文案。
- **D4 复跑**：`503 connect-refused 127.0.0.1:8080` —— GT14 的 llama.cpp 没启动（基础设施，非插件）。
- D2/D6 未变（GT14 `allowlist=0`；PC2 仍 2.7.10）。