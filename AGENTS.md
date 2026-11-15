# 项目守则

## 发布门（2026-11-13 用户定下，强制）

任何一次「向仓库 push / 向插件市场提交更新 / 发布 npm 包」之前，必须依次完成：

1. **AI 生成代码安全审计师**（Security）审 `git diff`，给 P0/P1/P2 结论与证据；
2. **代码审查工程师**（Engineering / Code Reviewer）审同一份 diff，给 PASS / FAIL 与阻断项；
3. **主控自己再扫一遍**：`node scripts/check-text.mjs`（BOM / CRLF / 控制字符 / 重复中文短语 / 常见拼写 / 围栏 / 版本漂移；必须 exit 0，WARN 不阻断）、secrets、危险构造（eval / 动态执行）、测试全量、部署一致性；
4. 只有三者都没有未决的 P0/P1 项，才允许提交、打 tag、push、提交市场更新或发 npm；
5. 审核用**常驻审计 + 窄记**：两位审计员各自保持会话，每轮只给增量 diff + 变更文件全文 + `docs/review/findings.json`；结论按 `docs/review/auditor-protocol.md` 回写窄记。每 5 个版本或公开发布前，另起新会话做一次全量审计。

P2 可以带着发布，但必须写进 CHANGELOG 的「已知问题」或 docs；两位审核员的结论要写进提交说明或对应 docs 小节，便于追溯。

这条门适用于补丁版本；紧急修复也不例外，只能压缩审核范围（例如只审本次 diff），不能跳过。
