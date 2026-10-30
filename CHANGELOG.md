# 变更日志

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
