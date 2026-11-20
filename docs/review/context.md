# 架构锚点（窄记上下文，≤ 80 行）

- 包名三处必须一致：`package.json.name`、`cordis.patch.yml` 的 `name`、`lib/client.js` 的 client bundle id；当前 `@wfcj/dsh-job-board`。`scripts/plugcheck.mjs` 有断言。
- 四条通道：板子 `:8965`（`x-board-token`）；hub `:19387`（`nodeToken`）；GUI 路由（回环 + `uiGuard` 自定义头）；`sh_*`（`allowedRoots` 只约束 cwd，不是沙箱）。
- 板子状态：`L:\云盘\gp_video_xfer\_board\state.json`；单实例锁；`/api/board`、`/api/create`、`/api/mark`、`/api/attach`、`/api/release`、`/api/caps`、`/api/alias`、`/api/forget-machine`。
- 派工身份：`machine` 是身份键（电脑名/显式配置），显示名 alias 只用于展示与查找；`normalizeBoardMachine`、`_canon_machine` 负责折回。
- 恢复：`dispatchJournal` + holder + `INSTANCE_HOLDER`；未知结果按 goal + 时间窗对账；多候选不自动绑定。
- 远端传输：当前 `dsh-remote-agent`（hub 19387）；规划中的 `dsh-job-worker` 只走板子 HTTP，先在局域网仓库开发，exec-only 稳定后并入本包，不单独发 npm。
- 发布门：`AGENTS.md`；常驻审计协议：`docs/review/auditor-protocol.md`。
- UI 渲染专项门：浏览器 bundle、React/JSX/createElement、slot、UI 状态分支或接口渲染字段变更，强制执行 `docs/review/ui-render-review-standard.md`；证据不足为 BLOCKED。