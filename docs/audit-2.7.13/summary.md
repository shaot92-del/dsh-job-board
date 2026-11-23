# 2.7.13 签核摘要（2.7.12 定向复审 FAIL 的逐条闭合）

- 复审报告：`C:\review\v2.7.12-final\docs\audit-2.7.12\review-2.7.12.md`（17,131 B，结论 **FAIL**）
- 本版目标：闭合复审 2 条 P1 + 3 条 P2 + 1 条 P3，并把「测试没有真的覆盖目标行」补掉。
- 提交：`153965e`（修正）→ `d9573fb`（安装脚本默认包名）；tag `v2.7.13` 已推（远端 `0756158`）。
- 产物：`L:\云盘\gp_video_xfer\_tools\dsh-job-board\wfcj-dsh-job-board-2.7.13.tgz`（**1,532,603 B**，sha256 `29e21df6ddc0e8860d1bcb10b7670faba7eba31b60e081edf0d39fb2a26ef74d`）；pack-check 109 文件 / 1,532,603 B。

## 逐条闭合

| 复审条目 | 原判 | 现在 | 证据 |
|---|---|---|---|
| P1 stateDir 下 hint 指向 JS 标记日志、helper 写 %TEMP%（不一致） | FAIL | 已修 | 新增 `restartLogPath(stateDir, taskSlug)`；helper、回执、JS 标记日志同源；helper 先建目录。测试 `runRestart：stateDir 设了时 hint 与 helper 实际日志路径一致` |
| P1 upgrade 回执无日志路径/无「spawn 成功 ≠ 重启成功」 | FAIL | 已修 | 两条 note 均追加免责 + 日志路径，回传 `logFile`。测试 `upgrade：回执带日志路径与免责` |
| P2 P1-1 真跑用例未生成 swap 行（测不到缺陷） | FAIL | 已修 | 补 `moveFrom/moveTo`；断言日志含 `swap `、`$()` 原样、无年份展开 |
| P2 P3-2 用例走不到 `log.warn` | FAIL | 已修 | 改为「合法包 → 装包成功 → spawn 抛错 → warn」；断言 warn 被调用 |
| P2 `scripts/deploy/upgrade-worker.ps1:274-305` 独立重启 here-doc 同类缺陷 | 新问题 | 已加固 | 杀进程后复核 + 结果写 `%TEMP%\dsh-upgrade-restart-*.log` + 结果文件附日志路径 |
| P3 CHANGELOG 声称 upgrade 回执也写日志（与代码不符） | 新问题 | 已修 | CHANGELOG 重写 2.7.13 段，逐条对上代码 |

## 门禁（本机）

- `npm run gate`：**491/491**、smoke 65/65、plugcheck 18/28、check-text PASSED、pack-check 109 文件 / 1,532,603 B。
- `test/worker/maint-verbs-restart-script.test.mjs`：**8/8 pass**（其中 2 条真跑 pwsh）。
- 负向门禁：UI 崩溃包仍 FAIL（含 #130 同型）、修复版 PASS；`SMOKE_BUNDLE` 行为不变。

## 仍未覆盖（诚实登记）

- 真机 upgrade→自动重启闭环未在本轮重跑（2.7.12 时代已在 GT14 验证过换包成功，重启助手按 exe 路径杀需在 2.7.13 上再验一次）。
- `scripts/deploy/upgrade-worker.ps1` 的重启加固只做静态与人工审读，未纳入单测。