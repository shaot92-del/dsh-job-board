# v2.7.15 真机验证（GT14，agentCwdRoot=%USERPROFILE%\Documents）

> 环境：GT14 升级到 2.7.15（实例 `gt14/32900-82ef37ba` → `gt14/32900-137b0279`），
> `maint config` 读回 `agentCwdRoot=%USERPROFILE%\Documents`、`agent=on`、`agentAllowlist=1`。
> 派工走 `POST http://127.0.0.1:8965/api/create`（`x-board-token`）。

## 1. 正例：任务不带 cwd（旧版必被拦，2.7.15 放行）

| 项 | 值 |
| --- | --- |
| task_id | `d2715-default-cwd` |
| mode / model | `agent` / `deepseek-account/deepseek-flash` |
| 结果 | **done** |
| note | `worker:gt14 inst:gt14/32900-137b0279 stage=agent session=worker-d2715-default-cwd-5c7aef allow=any preset=standard budget=7/20 dur=862ms text=8ch answer="D2715-OK"` |

结论：默认 cwd 落在 `agentCwdRoot` 内，**不再出现** `agent-cwd-denied why=outside`；会话真的起来并回了答案。

## 2. 反例：显式 cwd 在根之外（fail-closed 必须仍然拦）

| 项 | 值 |
| --- | --- |
| task_id | `d2715-outside-cwd` |
| workspace | `C:\Windows` |
| 结果 | **blocked** |
| note | `worker:gt14 inst:gt14/32900-137b0279 stage=agent reason=agent-cwd-denied why=outside cwd=C:\Windows root=%USERPROFILE%\Documents` |

结论：显式越界仍被拒（安全边界没被削弱）。**但 note 里的 `root=` 是字面量 `%USERPROFILE%\Documents`** ⇒ 说明 GT14 的 DSH 进程环境里没有 `USERPROFILE`，`expandPath()` 原样保留了变量串；默认 cwd 也因此落成字面量（能被放行是因为两侧同串）。

## 3. 由此产生的 2.7.16

- `expandPath()`：`%USERPROFILE%` / `$env:USERPROFILE` / `%HOME%` 取不到环境变量时回落 `os.homedir()`。
- `agent-runner`：根展开后仍含 `%VAR%` 或非绝对路径 ⇒ `blocked / agent-cwd-root-unresolved`（可操作提示），不再伪装成 `why=outside`。

## 4. 尚未覆盖

- 2.7.16 的真机验证（需 GT14 升到 2.7.16 后重跑本节两条）。
- `maint restart` 在 GT14 上「回执 ok 但实例号不变」的问题（helper 日志读不到）——待 `logs` 动词支持读重启日志后再定位。
