# 2.7.4 发布审计摘要（规程 v1.2 / WI-001）

- 版本：**2.7.4**　HEAD `c8e7597`　tag `v2.7.4`（已推）
- 基线：`v2.7.3`（`63a18f08`）
- 采集：`node scripts/audit-collect.mjs --version 2.7.4 --base v2.7.3 --coverage --crash-bundle "C:\review\case\lib-client-2.7.0-crash.bak"`
  → **7 条命令 0 失败**（崩溃包 exit=1 属预期，见 `negative-gate.txt`）
- 反证清单：`counterproof/paths.json`（**16 EXECUTED / 4 UNEXECUTED / 0 UNKNOWN**）
  → `counterproof/summary.json` verdict **BLOCKED**：4 条宿主/真机调用点待闭合

## §7 发布签核表（9 项）

| # | 项目 | 判定 | 证据 |
|---|---|---|---|
| 1 | 全量审计 | **BLOCKED**（待 4 条 closure） | `counterproof/paths.json`、`independent-review.md` |
| 2 | UI 渲染证据链 | PASS（旧 FAIL 15/40 · 新 PASS 51/51） | `ui-render.md`、`negative-gate.txt` |
| 3 | 可用性走查 | 部分（真点截图待用户） | `usability.md` |
| 4 | 门禁全绿 | PASS（gate exit 0；单测 **468/468**） | `gate.log` |
| 5 | 三处版本一致 | PASS（plugcheck `tools=18 routes=28`） | `gate.log` |
| 6 | 包内容核对 | PASS（108 文件 / 1,510,274 B） | `deploy.md` |
| 7 | 部署一致性 | 待重启（installed=2.7.4，运行 2.7.3） | `deploy.md` |
| 8 | 重启提示 | 已告知 | 会话记录 |
| 9 | 回滚路径 | PASS（tag v2.7.3 + rollback 脚本 + deprecate 话术） | `deploy.md` |

## 待闭合（4 条，全在真机侧）

| id | 路径 | closure |
|---|---|---|
| I-1 | `startWorker` 载荷走 `buildWorkerPayload` | 宿主重启后 `doctor version=2.7.4` |
| I-2 | 启动自检 trace 写通道未开 | 重启后 grep 日志；GT14 装 2.7.4 后该行应消失 |
| I-3 | doctor `maint-write-off` warn | 重启后 `/doctor` 看 warn；GT14 装后消失 |
| U-1 | `upgrade-worker.ps1` 装完读 doctor 报写通道 | GT14 双击 `upgrade-worker.cmd` 的弹窗输出 |

## 事故台账核对（附录 C）

| id | 事故 | 本期兜住 |
|---|---|---|
| C-1 | 2.7.0 点派工白屏 #130 | 严格冒烟 + 负向门禁（旧包必须 FAIL） |
| C-2 | 2.7.2 装完 DSH 起不来（混合树） | 原子安装 + install-manifest + 真副机三验 |
| C-3 | 安装脚本 Warn 未定义 / 复核 108≠107 / pid join | 脚本用例矩阵（5 形状 × 装包/改配置 × 成功/失败） |
| C-4 | 团队顶层键被宿主丢弃（写通道死锁） | `mergeWorkerPayload` + 启动自检 + doctor warn（本期治本） |
| C-5 | 扁平布局脚本报「没有 worker 子块」 | 扁平布局支持 + 幂等用例 |
| C-6 | 2.7.3 已发布但 GitHub Release 缺失 | §10 发布通道审查（tag↔Release 同步） |
| C-7 | 只做「改动面审计」漏全量 | 每次发版全量审计（附录 B 裁决①） |
| C-8 | 冒烟假 React 不校验 → 全绿仍崩 | 严格假 React + `SMOKE_BUNDLE` 负向门禁 |