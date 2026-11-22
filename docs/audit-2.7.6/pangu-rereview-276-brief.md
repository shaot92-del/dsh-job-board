# dsh-job-board v2.7.6 定向复审任务书（只核 2.7.5→2.7.6 的修正）

> 复审对象：`C:\review\v2.7.6-final`（v2.7.6 / commit `c7e34c2` / 293 文件 / `package.json`=2.7.6）
> 基线：`v2.7.5` / `db94810`（上一轮你判 FAIL 的那一版）
> 性质：**定向复审**——只核「上一轮 17 条里我改的 7 条是否真修好 + 修正过程有没有引入新问题」。
> 不设范围上限、不计 token。结论词汇只用 PASS / FAIL / BLOCKED；推测必须标注「推测」。

## 1 上一轮你判 FAIL 的原因（要闭环的两条）

- **P1-1** `result.reasons` 先截断后打码：`lib/worker/result.js:94` 的 `t.slice(0, MAX_REASON_CHARS)`（120）发生在 `worker.js:304` 的 `mask(...)` **之前**，token 跨 120 边界被切成残片 → 掩码匹配不到 → 残片落板。
- **P1-2** 证据链全空：审查环境无 `.git`，`audit-collect` exit 2，`docs/audit-2.7.5/{scope,coverage,commands,counterproof,negative}` 全空 → 按规程 BLOCKED。

## 2 我这轮声称改了什么（逐条核）

| 审查条目 | 声称的改法 | 你要核什么 |
| --- | --- | --- |
| **P1-1** | `lib/worker/result.js`：新增 `MAX_REASON_INPUT_CHARS = 4096`；`reasons.push(t.slice(0, MAX_REASON_INPUT_CHARS))` 取代原来的 120 预截断；最终 120 截断交给 `worker.js` 的 `maskResult`（先 mask 后 slice） | ① 120 截断是否真的只剩一处且在 mask 之后；② 4096 上限会不会让 board `_clean_result` 契约变化；③ 新增的两条测试是否真能抓住「跨 120 边界」这个缺陷（拿旧版 result.js 跑应当 FAIL） |
| **P3-1** | `lib/worker/config.js`：`mergeWorkerPayload()` 对 `worker:` 子块也按 `WORKER_FORWARD_KEYS` 过滤，避免子块残留 `workerMode`/`machine`/`token` 顶掉宿主值 | ① 宿主键（boardUrl/token/machine/workerMode/timeoutMs）是否真的不会进 `worker` 块；② 子块里白名单内的键是否仍优先于顶层；③ `normalizeConfig` 的 `pick()` 子块优先语义有没有被破坏 |
| P2-3 | `scripts/enable-maint-write.ps1`：公钥除 base64 形态外，再解 DER 并查 Ed25519 OID（0x06 0x03 0x2B 0x65 0x70） | ① 合法公钥仍能过；② `'A'*44`（合法 base64、非 SPKI）必须被拒；③ 这段新增代码会不会让正常流程多做无用功或误拒真实公钥（拿 `keygen` 生成的公钥试） |
| P2-5 | `scripts/install-board.ps1:106`：`Substring(0, Min(6, Max(0, Length - 1)))` | ① 长度 1–6 的短 token 不再整枚打印；② 长度 0 不会抛异常 |
| P2-9 | `test/worker/agent-gate.test.mjs`：改成断言 `rule !== 'too-long'` | ① 这个断言是否仍能覆盖「硬上限内不该因 too-long 被拒」；② 是否过分宽松（例如 ok=false 且 rule 是别的也放过——那是否本该如此） |
| P2-10 | `test/worker/exec-runner.test.mjs`：改成 `assert.equal(r.reason, 'missing')` | ① `//server/share` 在 Windows 上是否真的落到 `missing`（可实跑）；② 这条断言会不会把平台差异写死 |
| P3-2..P3-5 | `findings.json` 2.7.6 + 8 条窄记；`audit-2.7.4` HEAD 统一 `dee4e03`；`patch.diff` 加注；`playbook` 表格拆行 | 文档一致性即可，不必逐字 |
| 额外 1 | `test/worker/maint-ticket-cli.test.mjs` badsig 用例：原写法「nonce 末位换 X」在末位本来就是 X 时票据未变（约 1/64 偶发），改成翻首位 | ① 是否确实消除了偶发；② 新写法是否真的破坏了签名（不是改成别的字段） |
| 额外 2 | `scripts/audit-collect.mjs`：`--base` 用 `<ref>^{commit}` 解到 commit | ① 注解标签（v2.7.5）现在是否正确解到 `db94810`；② 变更集是否非空 |

## 3 P1-2 的闭合方式（需要你判它够不够）

- 我在**真实 git 检出**（`D:\gp_video\dsh-job-board`）上重跑了采集器：
  `node scripts/audit-collect.mjs --version 2.7.6 --base v2.7.5 --coverage --crash-bundle C:\review\case\lib-client-2.7.0-crash.bak`
- 结果：基线 `v2.7.5(db94810)` → `c7e34c2`，**13 个变更文件**，**7 条命令 0 失败**（含崩溃包负向门禁 exit=1）。
- 证据在 `docs/audit-2.7.6/`：`scope/`、`coverage/`、`commands/results.jsonl`、`counterproof/paths.json`（我填了 **19/19 EXECUTED**）、`counterproof/summary.json`（PASS）、`negative/negative-gate.md`、`summary.md`（九项签核表，第 8 项 npm 发布标 BLOCKED——需用户 2FA，属外部依赖）。
- **请你判**：这些证据是否足以支撑 PASS；我填的 19 条 EXECUTED 里有没有「证据不足以证明该路径被执行」的。

## 4 交付

写到 `C:\review\v2.7.6-final\docs\audit-2.7.6\review-276.md`：

1. **结论**：PASS / FAIL / BLOCKED + 一句话能不能装/发
2. **逐条核验表**：上表每行 → 成立 / 不成立 / 部分成立（带行号与复跑输出）
3. **新问题**：P0–P3（如果修正过程引入）
4. **反证**：至少 5 条「如果我判它没问题，它会怎么表现，我怎么排除的」
5. **复跑数字对照**：你跑出来的 单测/smoke/pack-check/负向门禁 数字，与 `docs/audit-2.7.6/commands/results.jsonl` 是否一致

## 5 允许/不允许

- 允许跑：`node --test test/worker/*.test.mjs`、`node scripts/plugcheck.mjs`、`node scripts/client-render-smoke.mjs`、`node scripts/worker/pack-check.mjs`、`node scripts/check-text.mjs`；允许用旧版 bundle 做负向对照（`case/lib-client-2.7.0-crash.bak` 在 `C:\review\case\`）。
- 允许写：你自己的复审报告。
- 不允许：改代码、commit、改版本号、git 操作、联网拉依赖。
