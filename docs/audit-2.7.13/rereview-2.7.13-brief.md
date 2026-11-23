# 2.7.13 定向复审任务书（只核 2.7.12 复审报告里那 6 条）

你上一轮对 v2.7.12 的报告（`docs/audit-2.7.12/review-2.7.12.md`）判 FAIL，提了 2 条 P1 + 3 条 P2 + 1 条 P3。工作目录里就是据此修出来的 v2.7.13。

## 你要核的 6 条

1. **P1 日志落点不一致**：`stateDir` 设了时，回执 hint 指向 JS 标记日志，helper 却写 `%TEMP%\dsh-maint-restart.log`。
   看 `lib/worker/maint-verbs.js` 的 `restartLogPath()`、`buildRestartScript(... logFile ...)`、`runRestart`、`queueRestartOnly`、`queueInstallThenRestart`：三处是否真的同源？helper 是否先建目录？
2. **P1 upgrade 回执**：两条 note（排入成功 / 未排入）是否都写清日志路径与「spawn 成功 ≠ 重启成功」？
3. **P2 P1-1 真跑用例**：`test/worker/maint-verbs-restart-script.test.mjs` 里那条含 `$(Get-Date -Format yyyy)` 的用例，是否真的传了 `moveFrom/moveTo`、swap 行真的执行、断言「原样保留 + 无年份展开」？拿 2.7.12 的 builder 跑这条测试，应不应 FAIL？
4. **P2 P3-2 用例**：是否真的走到 `log.warn('排入重启失败')`（而不是在校验阶段就 blocked）？
5. **P2 部署脚本**：`scripts/deploy/upgrade-worker.ps1` 的重启 here-doc 是否加了「杀后复核 + 日志 + 结果文件带日志路径」？
6. **P3 CHANGELOG**：`CHANGELOG.md` 的 v2.7.13 段说法是否与代码一致（不许再出现「声称写了但没写」）。

## 必答的三个问题

- A. 这 6 条里有没有「修了 A 弄坏 B」的（尤其 `restartLogPath` 改动有没有破坏 2.7.12 已通过的 P0-1/P1-1/P1-2 行为）？
- B. 新增/改写的测试里，还有没有「只断言字符串、其实没走到目标行」的？
- C. `upgrade` 成功但重启失败时，用户从回执 + 日志能不能独立判断出「装成功/重启没成功」？

## 允许

- `node --check`、`node --test test/worker/*.test.mjs`、`node scripts/client-render-smoke.mjs`、`node scripts/plugcheck.mjs`、`node scripts/worker/pack-check.mjs`
- 自写一次性脚本放在工作目录外（`%TEMP%`），不许改仓库代码、不许 git、不许联网

## 交付

`docs/audit-2.7.13/review-2.7.13.md`：
① 结论（只写 PASS / FAIL / BLOCKED） ② 六条逐条核验表（判定 + 文件:行号 + 实跑证据） ③ A/B/C 回答 ④ ≥5 条反证（写清你怎么试图破坏它） ⑤ 新问题按 P0–P3 分级 ⑥ 复跑数字（对照：491/491、smoke 65/65、plugcheck 18/28、pack-check 109 文件 / 1,532,603 B）

写完停下，不要改代码。