# 三阶段定向复核任务书（给盘古）

> 目的：只核主控修订 MC-1 ~ MC-4 是否真正闭合你的 §13 反证 a/b/c/f，以及修订本身有没有引入新问题。
> 不改代码、不重跑全量审查（一、二阶段结论沿用）。

## 工作目录

- `C:\review\after`：已含实施方 patch + 主控修订（当前状态见 `docs\ui-2.7.4\STATUS.md`）
- `C:\review\case\lib-client-2.7.0-crash.bak`：负向门禁旧包（SHA256 `1ED59AF6…DFC0EF`）
- 你上一轮报告：`C:\review\after\docs\ui-2.7.4\review.md`（§13 反证、§15 最小修法）
- 主控修订记录：`C:\review\after\docs\ui-2.7.4\main-control-fixes.md`
- 指纹：`C:\review\fingerprints.txt`（`lib/client.js` = `920CA5F1…518352`、smoke = `12F6FBD8…DEDC2C1`）

## 四问（逐条给 PASS/FAIL + 行号证据）

1. **反证 a（兜底永久压制）**：`readLocalAssess(machine, digest)` 是否真的在「超过 7 天」或「caps 摘要不一致」时返回 null？`capsDigest` 覆盖的字段是否足以反映硬件变化？写记录时是否确实带 `capsDigest`？两处调用（`client.js:906`/`932`）是否都传了摘要？
2. **反证 b（8s 误杀）**：`ASSESS_TIMEOUT_MS` 是否 15000，且所有引用它的文案/定时器都跟着变（含 loading 文案「最长 15 秒」）？有没有别处硬编码 8000 残留？
3. **反证 c（success 被 error 覆盖）**：二段 `/identity` 失败路径是否只影响能力条、不会再改 `assessPhase`？给出该 fetch 的完整语句与它前后的 setState 清单。
4. **反证 f（ident=null 不出条）**：`showAssessBar` 新表达式是否在 `ident===null && assessPhase==='success'` 时渲染能力条？有没有副作用（例如 `ident` 为 null 时访问 `ident.caps` 抛错）？

## 另外三件事

- **新引入检查**：MC 修订是否破坏「故障 B 客户端侧补丁」（localStorage 兜底）？是否让 4-6 数据翻转用例变成「必然走服务端」而失去降级能力？
- **自证可信度**：`main-control-fixes.md` 里「复跑证据」表的数字是否与你自己跑出来的一致（冒烟 50/50、负向 14/39 FAIL、单测 459/459、pack-check 107 文件 1,504,286 B、scan-h-type 新 0 违规/旧 FAIL）？
- **结论口径**：只允许 `PASS` / `FAIL` / `BLOCKED`；任何一项 `UNKNOWN` 判 `BLOCKED`。若判 FAIL，必须给出「最小修法 + 行号 + 复跑命令」。

## 交付

写到 `C:\review\after\docs\ui-2.7.4\review-stage3.md`：结论 + 四问核验表 + 新问题（如有）+ 与一、二阶段结论的差异说明。