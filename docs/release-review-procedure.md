# 发版审查操作规程（v1.2，三方合稿已整篇并入 + 事故注入条款）

> 状态：**v1.1（2026-11-21 01:00 冻结）**。组装方式：§0/§1/§7/附录A 主控起草；§1.4 + §3 + §5 = GLM 合稿；§2 + §4 = 盘古合稿；§2A + §6 + §8 = Kimi 合稿（均整篇并入，未做删改，仅标题降级；两处冲突已裁决见附录 B）。
> 来源文件：`_外部评估\2026-11-20-派工白屏\{盘古-全量审计模板, Kimi-react130复核报告, GLM-派工弹窗修复spec}.md`、`C:\Users\17827\codearts\DSH\crashcase-2.7.0\docs\review\release-review-§2-§6-§8.md`。
> 目标：**换谁跑都能跑好**——每一节都必须给「可复制命令 + 预期输出 + 判定规则」，不接受“建议关注”“应该检查”。
> 结论只有三种：`PASS` / `FAIL` / `BLOCKED`。**证据不足一律 BLOCKED**，不得写 PASS。

---

## §0 适用范围与触发条件

任何一次「push / 打 tag / 提交插件市场 / 发布 npm / 通知副机升级」之前，按改动类型**至少**跑下列章节；标记「全」的为强制全量，不看改动面。

| 改动类型 | §1 留痕 | §2 全量审计（全） | §3 UI 渲染 | §4 配置编辑 | §5 可用性走查 | §6 负向门禁 | §7 签核 |
|---|---|---|---|---|---|---|---|
| 浏览器端 bundle / React / slot / UI 状态分支 | 必 | 必 | 必 | 按需 | 必 | 必 | 必 |
| 配置编辑脚本（patch / cordis / YAML 就地编辑） | 必 | 必 | 按需 | 必 | 按需 | 必 | 必 |
| worker / 传输 / 票据 / 调度 / 权限 | 必 | 必 | 按需 | 按需 | 按需 | 必 | 必 |
| 文档 / 注释 / CHANGELOG | 必 | 必（可精简证据） | 不适用需说明 | 不适用需说明 | 不适用需说明 | 按需 | 必 |
| 依赖 / 打包 / 发布链 | 必 | 必 | 按需 | 按需 | 按需 | 必 | 必 |

**判定**：表内「必」而缺证据 = `BLOCKED`；标「按需」的，用一句话说明为什么不可能影响 → 写进审计报告的 `applicable:false` 理由。

---

## §1 角色与留痕

### 1.1 角色

| 角色 | 谁 | 职责 | 只读 |
|---|---|---|---|
| 主控 | 我 | 出证据、跑门禁、落盘、部署、发布 | 否 |
| 安全审计师 | reviewer-sec | 审 diff 的安全面，给 P0–P3 | 是 |
| 代码审查工程师 | reviewer-code | 审正确性 + UI 证据链，给 PASS/FAIL + 阻断项 | 是 |
| 独立复审 | 另起新会话的强模型 | **每次发版必做**，任务是「为什么现有门禁即使全绿也可能漏掉本次改动」 | 是 |
| 用户签核 | 用户 | 决定是否发布、是否带 P2 发布 | — |

### 1.2 留痕目录

每次发版建 `docs/audit-<version>/`，至少含：

```
docs/audit-2.7.1/
├── summary.md          # 结论 + 未决项 + 发布决定
├── full-audit.md       # §2 全量审计（含反证清单、最危险三条）
├── ui-render.md        # §3 状态矩阵 + 严格渲染输出 + 修复前 FAIL / 修复后 PASS
├── usability.md        # §5 七条路径走查，每条一幅截图
├── negative-gate.txt   # §6 旧版 FAIL / 新版 PASS 的命令与输出（含 exit code）
├── gate.log            # npm run gate 完整输出
└── deploy.md           # 部署目标 profile、版本核对、重启提示、回滚命令
```

### 1.3 不能单独作为「通过」证据的六类材料

1. 语法检查通过（`node --check`）；
2. 源码字符串存在（`RAW.includes(...)`）；
3. 默认首页/主面板能渲染；
4. 测试总数量（448 条全绿）；
5. pack-check / check-text 通过；
6. 安全审计无 P0/P1。

> 这六条我们在 2.7.0 上全有，仍然发布了白屏版本。它们只证明“看起来像做过了”。

---

## §1.4 三方共用口径（GLM 起草，全篇适用）

### 0. 共用口径约定（本文件内有效）

#### 0.1 结论三分法

本规程两节的每个检查项、每个画面、每条证据，结论**只允许**取以下三值之一：

| 结论 | 含义 |
|---|---|
| **PASS** | 检查项已实际执行，证据齐备且与预期一致 |
| **FAIL** | 检查项已实际执行，实测与预期相反（缺陷成立） |
| **BLOCKED** | 检查项**未能实际执行**：证据缺失、命令无法运行、依赖能力未落地、环境不可用 |

**缺证据判 BLOCKED，不得判 PASS。** "应该没问题"、"上次跑过"、"代码看过了没问题" 均不构成证据。

#### 0.2 无效替代证据清单（禁止项）

以下四类结果**不得**作为本两节任何检查项的实质证据，出现即判 BLOCKED（当作没提供证据）：

1. **"语法检查通过"** —— 无效。2.7.0 案例中，外层 `h()` 首参传入内层 `h('div',…)` 返回的元素对象是完全合法的 JavaScript 表达式，语法检查不可能报错，运行时才崩 React #130。
2. **"测试全绿"** —— 无效。2.7.0 发布时 448 条单测全绿，但测试不覆盖「弹窗停留期数据翻转后的重渲染」路径，缺陷照样漏检。
3. **"源码字符串存在"** —— 无效。文案字符串存在于源码 ≠ 渲染路径真实走到该分支 ≠ 该条件分支取过 true。必须以渲染探针 / 冒烟断言 / 走查实测证明分支被执行过。
4. **"默认首页能渲染"** —— 无效。2.7.0 面板初始态一直正常，崩溃发生在「点确认派工 → POST 发出 → 重拉 summary → 数据翻转 → 弹窗重渲染」之后。只测初始态等于没测本次缺陷路径。

#### 0.3 能力状态标注：SMOKE_BUNDLE（已落地，全文有效）

本规程将 `SMOKE_BUNDLE=<path> node scripts/client-render-smoke.mjs` 作为**历史 bundle 对照的标准门禁入口**引用。

**能力现状（主控实测，2026-11-21 00:00，已由主控补实现并验证）：**

- `scripts/client-render-smoke.mjs` 顶部已支持：`const CLIENT = process.env.SMOKE_BUNDLE ? path.resolve(process.env.SMOKE_BUNDLE) : path.join(root, "lib", "client.js")`；
- 崩溃版实测：`SMOKE_BUNDLE=<crashcase>\case\lib-client-2.7.0-crash.bak node scripts/client-render-smoke.mjs` → **FAIL 3/26，exit=1**，含 `Minified React error #130: expected a string (for built-in components) or a class/function (for composite components) but got: object`；
- 修复版实测：不设该环境变量 → **PASS 29/29，exit=0**；
- 采集器已封装该入口：`node scripts/audit-collect.mjs --version <ver> --base <prev-tag> --crash-bundle <path>`（崩溃版记 `expectedFail`，旧版意外 PASS 即整体失败）。

因此 §3-E2/E3/E4、§3-C3/C4、§5.4.3 中凡依赖该入口的检查项**不再因能力缺失判 BLOCKED**，按实测结果判定；执行记录必须附命令、退出码与日志路径（禁止只写"已跑过"）。

#### 0.4 冲突裁决：模型选择区恒渲染（有意为之）

历史文档（含缺陷休眠态的历史形态描述）写的是 **"空模型池不进模型区"**（对应旧代码 `lib/client.js:2998` 的 `if (pool.length === 0 && !(data && data.defaultModel)) return null` —— 模型行整体消失）。

本规程**一律以恒渲染为准**：模型选择区**恒渲染**，nodeModels 与 defaultModel 均为空（或选中机器无清单）时显示置灰项，文案逐字固定为 **「该机器未上报模型清单（跟随默认）」**，禁止 `return null` 静默消失。

**此裁决是有意为之**：模型行静默消失正是 2.7.0 缺陷的休眠形态，置灰项取代 return null 是 2.7.1 的确定性规则（spec 5.1 规则 2）。走查中若发现模型行整行消失（无论是否有清单），按 §5 判 **FAIL**（恒渲染违规），不得按旧文档判 PASS。

---

## §2 全量审计清单（含反证清单）

### §2.1 目的

发版前对本次变更做全量审计：把**需求规格 × 代码路径 × 测试 × 错误码 × 数据字段 × 分支 × 交叉 × 反证**八维度逐条核对，输出逐条批注 + 反证清单 + 缺口清单，给出 PASS/FAIL/BLOCKED 判定。核心原则：**漏 = 有分支无测试；无测试 = 从未执行 = 漏**。

### §2.2 触发条件

满足任一即触发：

1. 公开发布前（per `AGENTS.md` 发布门）；
2. 每 5 个版本（per `docs/review/auditor-protocol.md` 会话生命周期）；
3. 任何 P0/P1 修复后复审。

### §2.3 必须提供的证据

（本仓库无 `.git`，`git diff` 不可用；以下证据由主控按 `auditor-protocol.md`「每轮输入」提供，或由 §2.4 命令现场采集）

1. 本次变更文件清单 + 全文 + SHA256 哈希（替代 `git diff`）；
2. `docs/review/findings.json`（窄记唯一事实源）；
3. `docs/review/context.md`、`docs/review/decisions.md`；
4. 全量测试结果摘要（`npm test` 输出）；
5. `node scripts/check-text.mjs` 结果（含版本一致性）；
6. `node scripts/plugcheck.mjs` 结果；
7. `node scripts/worker/pack-check.mjs` 结果；
8. `node scripts/client-render-smoke.mjs` 结果；
9. `CHANGELOG.md`（版本一致性 + 已知问题登记）。

### §2.4 可复制命令

（在仓库根运行；均为只读；`<feature>` 为被审计特性名，评审员填入）

```powershell
# 1. 全量测试
npm test
# 等价：node --test test/worker/*.test.mjs

# 2. 文本卫生 + 版本一致性（package.json vs CHANGELOG）
node scripts/check-text.mjs

# 3. 插件检查（包名三处一致、routes、工具数等）
node scripts/plugcheck.mjs

# 4. 客户端渲染冒烟
node scripts/client-render-smoke.mjs

# 5. worker 打包检查
node scripts/worker/pack-check.mjs

# 6. 测试文件清单数（覆盖矩阵分母，不硬编码）
Get-ChildItem test\worker\*.test.mjs | Measure-Object | Select-Object -ExpandProperty Count

# 7. error code 提取（D4 错误码覆盖）
Select-String -Path lib\worker\*.js -Pattern 'MAINT_VERB_REASONS|reason:' | Select-Object LineNumber,Line

# 8. 变更文件哈希（替代 git diff，主控提供清单后逐个核验）
Get-FileHash <变更文件> -Algorithm SHA256

# 9. 窄记未关闭项（R2.8 用）
node -e "const f=require('./docs/review/findings.json');const open=f.entries.filter(e=>!['fixed','mitigated'].includes(e.status));console.log(JSON.stringify(open.map(e=>({id:e.id,sev:e.severity,status:e.status})),null,1))"
```
### §2.5 判定规则

（每条规则给：跑什么命令 / 看什么输出 / 怎么判。判定只有 PASS/FAIL/BLOCKED。不硬编码测试数、响应时间等数值——以实际输出为准。）

**R2.1 测试全绿**
- 跑什么命令：`npm test`
- 看什么输出：末尾 `tests N pass M fail K skipped S`，以及进程退出码
- 怎么判：退出码 0 且 `fail 0` → PASS；退出码非 0 或 `fail > 0` → FAIL；命令不存在/无法运行 → BLOCKED（不硬编码 N/M/S，以实际输出为准）

**R2.2 文本卫生 + 版本一致**
- 跑什么命令：`node scripts/check-text.mjs`
- 看什么输出：`check-text PASSED` 或 `check-text FAILED: N error(s)`；退出码
- 怎么判：退出码 0 → PASS；退出码 1 → FAIL；退出码 2（不像仓库根）→ BLOCKED

**R2.3 插件检查**
- 跑什么命令：`node scripts/plugcheck.mjs`
- 看什么输出：门结果与退出码
- 怎么判：退出码 0 → PASS；退出码非 0 → FAIL；脚本不存在 → BLOCKED

**R2.4 客户端渲染冒烟**
- 跑什么命令：`node scripts/client-render-smoke.mjs`
- 看什么输出：门结果与退出码
- 怎么判：退出码 0 → PASS；退出码非 0 → FAIL；脚本不存在 → BLOCKED

**R2.5 worker 打包检查**
- 跑什么命令：`node scripts/worker/pack-check.mjs`
- 看什么输出：门结果与退出码
- 怎么判：退出码 0 → PASS；退出码非 0 → FAIL；脚本不存在 → BLOCKED

**R2.6 八维度覆盖（D1–D8，反证清单核心）**
- 跑什么命令：
  - D1 正向规则：`Select-String -Path specs\<feature>\spec.md -Pattern '必须'` → 规则集 R；`Select-String -Path test\worker\*.test.mjs -Pattern '^test\('` → 测试集 T；求 R 中无对应测试的差集
  - D2 禁止项：`Select-String -Path specs\<feature>\spec.md -Pattern '禁止'` → 禁止项集 F；求 F 中无违规测试的差集
  - D3 异常场景：从 spec 异常场景章节提取编号集 E；求 E 中无测试的差集
  - D4 错误码：`Select-String -Path lib\worker\*.js -Pattern 'MAINT_VERB_REASONS|reason:'` → error code 集 C；求 C 中无测试的差集
  - D5 数据字段：从 spec 数据约束章节提取字段集 D；求 D 中字段合法/边界/非法值测试 <3 的差集
  - D6 分支：从 spec 时序图提取 alt/else 分支集 B；求 B 中无测试的差集
  - D7 交叉：规则对交互测试集 X；求每对交叉规则无测试的差集
  - D8 反证：同 D6 分支集 B；无测试 = 从未执行 = 漏
- 看什么输出：每个维度的差集（无测试覆盖的规则/禁止/异常/错误码/字段/分支/交叉条目列表）
- 怎么判：D1–D8 差集全空 → PASS；任一维度差集非空 → FAIL（漏 = 有分支无测试）

**R2.7 反证清单（从未执行分支）**
- 跑什么命令：同 R2.6 的 D6/D8 差集输出
- 看什么输出：从未执行分支列表（分支ID | 描述 | 触发条件 | 来源规则/异常编号 | 风险等级 | 后果）
- 怎么判：从未执行分支列表为空 → PASS；非空 → FAIL。另输出「最危险三条分支」排序表（排序原则：后果严重度 × 被漏掉概率；被漏掉概率 = 触发条件在测试环境是否常见）

**R2.8 窄记一致性（findings.json）**
- 跑什么命令：`node -e "const f=require('./docs/review/findings.json');const open=f.entries.filter(e=>!['fixed','mitigated'].includes(e.status));console.log(JSON.stringify(open.map(e=>({id:e.id,sev:e.severity,status:e.status})),null,1))"`
- 看什么输出：未关闭 finding 列表（status 非 fixed/mitigated）
- 怎么判：开放项为空 → PASS；开放项中有 P0/P1 → **主控须逐条确认已在 `docs/review/decisions.md` 或 `CHANGELOG.md` 登记为已接受风险**；全部登记 → PASS，有未登记 → FAIL（未决 P0/P1 阻断，per `AGENTS.md` 发布门）；P2 开放项 → 须在 `CHANGELOG.md`「已知问题」或 docs 登记，全部登记 → PASS，有未登记 → FAIL（per `AGENTS.md`「P2 必须写进 CHANGELOG 已知问题或 docs」）；findings.json 不存在 → BLOCKED

**R2.9 变更文件完整性（无 .git 适配）**
- 跑什么命令：`git rev-parse --is-inside-work-tree`；失败则对主控提供的变更文件清单逐个 `Get-FileHash <变更文件> -Algorithm SHA256` 与主控提供哈希比对
- 看什么输出：git 可用 → diff 可用；git 不可用 → 哈希比对一致/不一致
- 怎么判：git 可用且 diff 与变更清单一致 → PASS；git 不可用且哈希全部一致 → PASS；哈希不一致 → BLOCKED（证据不可信，变更范围未定）；无变更清单 → BLOCKED

**R2.10 缺口清单闭合**
- 跑什么命令：汇总 R2.6 差集 + R2.7 从未执行分支 + R2.8 未登记项，输出缺口清单（缺口编号 | 类型（需求/测试/分支/数据/交叉） | 描述 | 影响 | 建议）
- 看什么输出：缺口清单
- 怎么判：缺口清单为空 → PASS；非空 → FAIL（每个缺口 = 一个未闭合项）

**§2.5 节判定合成**：R2.1–R2.10 全 PASS → §2 = PASS；任一 FAIL → §2 = FAIL；无 FAIL 但任一 BLOCKED → §2 = BLOCKED。

### §2.6 失败处置

- **FAIL**：列出全部阻断项（FAIL 规则 + 对应命令输出摘录），不发版；按 `AGENTS.md` 发布门，阻断项清零后重跑本节。
- **BLOCKED**：证据不足（脚本缺失 / 变更清单未定 / findings.json 缺失 / 无 .git 且哈希未比对）；补证据后重判，**不得在证据不足时写 PASS**。
- **PASS**：本节证据齐备且全绿；进入下一发布门环节。

### §2.7 模板

（审计输出模板，基于 `.codeartsdoer\audit-template.md`）

```markdown
# 全量审计清单 — <feature> — <版本>

## 0. 审计覆盖八维度自检
| 维度 | 问题 | 覆盖判据 | 差集 |
|------|------|----------|------|
| D1 正向规则 | 每条"必须"有正向测试？ | 每规则 ≥1 正向+≥1 负向 | <差集> |
| D2 禁止项 | 每条"禁止"有违规测试？ | 每禁止 ≥1 触发测试 | <差集> |
| D3 异常场景 | 每个异常有测试？ | 每异常 ≥1 测试 | <差集> |
| D4 错误码 | 每个错误码有测试？ | 每码 ≥1 测试 | <差集> |
| D5 数据字段 | 每字段有合法/边界/非法测试？ | 每字段 ≥3 值测试 | <差集> |
| D6 分支 | 时序图每个 alt/else 有测试？ | 每分支 ≥1 测试 | <差集> |
| D7 交叉 | 规则间交互有测试？ | 每对交叉 ≥1 测试 | <差集> |
| D8 反证 | 每个分支有测试证明可达？ | 无测试=从未执行=漏 | <差集> |

## 1. 覆盖矩阵
### 1.1 需求 × 代码路径覆盖表
| 需求编号 | 摘要 | 代码分支 | 测试用例 | 覆盖状态 |
### 1.2 需求 × 错误码覆盖表
| 错误码 | 触发条件 | 来源需求 | 测试用例 | 覆盖状态 |
### 1.3 需求 × 数据字段覆盖表
| 字段 | 约束 | 合法 | 边界 | 非法 | 状态 |

## 2. 反证清单
### 2.1 分支执行状态表
| 分支ID | 描述 | 触发条件 | 来源 | 测试用例 | 执行状态 | 风险等级 |
### 2.2 从未执行分支列表
| 分支ID | 描述 | 触发条件 | 风险等级 | 后果 |
### 2.3 最危险三条分支
| 排名 | 分支ID | 描述 | 为什么最危险 | 后果 |

## 3. 逐条批注表
### 3.1 同意项 / 3.2 要改项 / 3.3 要加项

## 4. 追溯矩阵（需求 → 验收 → 测试 → 代码分支）

## 5. 负向测试清单

## 6. 边界测试清单

## 7. 交叉冲突清单

## 8. §2 判定
| 规则 | 结论 | 证据（命令输出摘录） |
| R2.1 测试全绿 | PASS/FAIL/BLOCKED | <输出> |
| R2.2 文本卫生+版本 | ... | ... |
| R2.3 插件检查 | ... | ... |
| R2.4 客户端渲染冒烟 | ... | ... |
| R2.5 worker 打包检查 | ... | ... |
| R2.6 八维度覆盖 | ... | ... |
| R2.7 反证清单 | ... | ... |
| R2.8 窄记一致性 | ... | ... |
| R2.9 变更文件完整性 | ... | ... |
| R2.10 缺口清单闭合 | ... | ... |
| **§2 合成判定** | **PASS/FAIL/BLOCKED** | |
```
---

## §2A 反证清单（Kimi 合稿；§2 的增量，不替代 §2）

### 目的

用可核验证据回答一句话：**这次改动里，哪些代码路径从来没有被任何测试执行过？**

本节不是覆盖率建议，也不是让审查者根据测试名称猜测。输出必须逐条列出本次变更的全部可执行路径，并把每条路径判定为：

- `EXECUTED`：至少一条测试实际进入并离开该路径；异常路径必须观察到预期异常或返回结果；
- `UNEXECUTED`：路径存在，但现有测试、覆盖率、浏览器 Coverage 或探针均没有执行证据；
- `UNKNOWN`：无法建立路径清单，或现有证据不足以判断是否执行；
- `NOT_APPLICABLE`：仅用于注释、纯文档、非执行数据等不可执行内容，必须给出理由。

最终回答保存在 `counterproof/summary.json` 和 `counterproof/paths.json`；不允许只写“已覆盖”“看起来都跑过”。

### 触发条件

每次发版必须执行。以下情况不得豁免：

- 只改一行、只改默认值、只改条件表达式；
- 既有 `npm run gate`、单元测试或冒烟全部通过；
- 常驻审计已经审过相同 diff；
- 修改被认为“不影响逻辑”；
- 没有新增测试。

重点范围：变更函数、条件分支、异常分支、提前 return、异步回调、弹窗状态、远程/本地分支、错误占位、卸载清理，以及由接口字段决定的分支。

### 必须提供的证据

每次发版必须同时具备以下四类材料，缺一类即为证据不足：

1. **路径底账**
   - `scope/base-head.txt`：base、HEAD 和提交范围；
   - `scope/changed-files.txt`：变更文件；
   - `scope/changed-paths.diff`：零上下文 diff，用于定位变更行和分支；
   - `counterproof/paths.json`：逐路径判定，不能只登记已有测试的路径。

2. **动态执行证据**
   - Node：`coverage/unit-test.log`、`coverage/coverage-summary.log`、`coverage/raw/` 中的 V8 coverage；
   - 客户端离线渲染：`coverage/client-smoke.log`；
   - 浏览器 UI：生产宿主 Coverage 导出，或审查用分支进入/退出探针日志。默认首页渲染不能证明弹窗、错误和远程分支已执行。

3. **命令与退出码**
   - `commands/commands.json`：命令、工作目录、日志路径、退出码和结果；
   - 日志必须来自本次执行，不得复制上一版本。

4. **未执行清单与结论**
   - `counterproof/summary.json`：各状态数量及 `PASS / FAIL / BLOCKED`；
   - `UNEXECUTED` 项必须含文件、行号、分支条件和为何未执行；
   - `UNKNOWN` 项必须含缺失证据和补证责任人。

判定约束：函数被调用不等于每个分支被执行；源码字符串断言、测试文件存在、测试总数和截图不能作为路径执行证据。

### 可复制命令

在仓库根目录、PowerShell 中执行。先替换 `$Version` 和 `$BaseRef`：

```powershell
$Version = '2.7.1'
$BaseRef = 'v2.7.0'
$Root = (Get-Location).Path
$Audit = Join-Path $Root "docs/audit-$Version"
$Dirs = @(
  (Join-Path $Audit 'scope'),
  (Join-Path $Audit 'coverage\raw'),
  (Join-Path $Audit 'counterproof'),
  (Join-Path $Audit 'commands')
)
New-Item -ItemType Directory -Force -Path $Dirs | Out-Null

git rev-parse "$BaseRef" | Set-Content -Encoding utf8 (Join-Path $Audit 'scope\base.txt')
git rev-parse HEAD | Set-Content -Encoding utf8 (Join-Path $Audit 'scope\head.txt')
git diff --name-only "$BaseRef...HEAD" -- lib scripts test | Set-Content -Encoding utf8 (Join-Path $Audit 'scope\changed-files.txt')
git diff --unified=0 "$BaseRef...HEAD" -- lib scripts test | Set-Content -Encoding utf8 (Join-Path $Audit 'scope\changed-paths.diff')
@("base=$BaseRef", "head=$(git rev-parse HEAD)") | Set-Content -Encoding utf8 (Join-Path $Audit 'scope\base-head.txt')

$env:NODE_V8_COVERAGE = Join-Path $Audit 'coverage\raw'
node --test --experimental-test-coverage "test/worker/*.test.mjs" *> (Join-Path $Audit 'coverage\coverage-summary.log')
$UnitExit = $LASTEXITCODE
npm.cmd test *> (Join-Path $Audit 'coverage\unit-test.log')
$NpmExit = $LASTEXITCODE
npm.cmd run smoke:client *> (Join-Path $Audit 'coverage\client-smoke.log')
$SmokeExit = $LASTEXITCODE
Remove-Item Env:NODE_V8_COVERAGE -ErrorAction SilentlyContinue

@{
  unitCoverageExitCode = $UnitExit
  npmTestExitCode = $NpmExit
  clientSmokeExitCode = $SmokeExit
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Audit 'coverage\exit-codes.json')

if ($UnitExit -ne 0 -or $NpmExit -ne 0 -or $SmokeExit -ne 0) {
  throw '测试命令失败：先按 §6 区分缺陷复现与环境失败；反证清单不得判 PASS。'
}
```

执行后必须根据 diff、V8 coverage、客户端日志及浏览器证据填写 `counterproof/paths.json`。上述命令只采集证据，**不会自动把路径标成 EXECUTED**。

### 判定规则

按以下顺序判定，不得跳级：

1. `BLOCKED`
   - 任一必需材料缺失；base/HEAD 不明；coverage 未生成；命令没有退出码；
   - 路径底账未覆盖全部变更可执行路径；
   - 任一路径为 `UNKNOWN`；
   - 只有测试名称、测试数量或人工描述，无法映射到具体路径；
   - UI 只提供离线结果，却需要生产宿主才能证明该分支。

2. `FAIL`
   - 路径底账完整且证据可读，但至少一条变更可执行路径为 `UNEXECUTED`；
   - 审查者声称已执行，但日志、Coverage 或探针反证其未执行；
   - 用 `NOT_APPLICABLE` 标记实际可执行代码以规避测试。

3. `PASS`
   - 路径底账完整；所有变更可执行路径均为 `EXECUTED`；
   - 非执行内容才有 `NOT_APPLICABLE`，且理由成立；
   - 无 `UNEXECUTED`、无 `UNKNOWN`，命令和退出码齐全。

`summary.json` 必须直接回答：`unexecuted` 的数量和 ID 列表。为 0 才能 PASS；无法确定为 0 时判 BLOCKED，不得当作 0。

### 失败处置

- `FAIL`：停止发版。为每条 `UNEXECUTED` 增加能实际进入该路径的测试或生产宿主用例；缺陷修复同时进入 §6 负向门禁。补证后重新生成整份反证清单，不能只删除未执行项。
- `BLOCKED`：停止发版。先补 coverage、日志、退出码、路径映射或新会话全量审计；不得把 UNKNOWN 当成“没有风险”。
- 测试本身失败：若是预期复现旧缺陷，转 §6；若是环境、依赖、路径或脚本错误，保持 BLOCKED；若是新版非预期失败，判 FAIL。
- 所有补跑必须产生新日志和新退出码，禁止覆盖后伪造“首次即通过”。

### 模板

#### §2-A `docs/audit-<version>/counterproof/paths.json`

```json
{
  "version": "<version>",
  "baseRef": "<base-ref>",
  "headRef": "<head-sha>",
  "result": "FAIL",
  "paths": [
    {
      "id": "PATH-001",
      "file": "lib/client.js",
      "lines": "2998-3121",
      "path": "ask === true && (pool.length > 0 || data.defaultModel)",
      "status": "EXECUTED",
      "evidence": {
        "commandId": "CMD-UI-001",
        "log": "docs/audit-<version>/coverage/client-smoke.log",
        "coverage": "docs/audit-<version>/coverage/browser-dispatch.json",
        "marker": "dispatch-model-select:exit"
      },
      "note": "严格渲染与生产宿主均进入并退出"
    },
    {
      "id": "PATH-002",
      "file": "lib/client.js",
      "lines": "3070-3078",
      "path": "diffRes.ok === false",
      "status": "UNEXECUTED",
      "evidence": null,
      "note": "现有用例只有成功 diff，没有错误 diff"
    }
  ]
}
```

#### §2-B `docs/audit-<version>/counterproof/summary.json`

```json
{
  "version": "<version>",
  "result": "FAIL",
  "counts": {
    "total": 2,
    "executed": 1,
    "unexecuted": 1,
    "unknown": 0,
    "notApplicable": 0
  },
  "unexecutedPathIds": ["PATH-002"],
  "unknownPathIds": [],
  "answer": "PATH-002（lib/client.js:3070-3078，diffRes.ok === false）从未被任何测试执行过。",
  "evidence": "docs/audit-<version>/counterproof/paths.json",
  "reviewedBy": "<new-full-audit-session-id>",
  "reviewedAt": "<ISO-8601>"
}
```

无未执行路径时，`unexecutedPathIds` 必须为 `[]`，`answer` 必须写“本次变更可执行路径均有测试执行证据”；但不能用这句话替代逐条 `paths.json`。

---

## §3 UI 渲染证据链

### §3.1 目的

证明：修复版 client bundle 的渲染树在**任意 summary 数据形态**下元素类型合法、模型选择区恒渲染，且**每一条渲染条件分支**都有真实执行的证据链覆盖——而不是仅靠"语法合法 / 测试全绿 / 初始态正常"推定安全。

本节回答的发版问题：**"这个 bundle 在最坏的数据形态下会不会把对象当节点交给 React？"** 2.7.0 的答案曾经是"会"（`lib/client.js:3000-3001` 外层 `h()` 首参传入内层 `h('div',…)` 返回的元素对象，宿主压缩生产版报 `Minified React error #130 … args[]=object`，随后 `client.js:22` slot 错误边界输出 `slot entry crashed in 'main'`，主槽位白屏），本节确保它从此永远是否。

### §3.2 触发条件

以下任一情况发生时，本节必须完整执行：

1. 每次发版门启动（向仓库 push / 向插件市场提交更新 / 发布 npm 包之前）；
2. 修复任何渲染类缺陷的补丁版（本规程因 2.7.0 白屏案例而设，渲染类改动是它的主战场）；
3. 本次 diff 新增了任何渲染条件分支（新增 if / 三元式 / 守卫路径，无论大小）；
4. 全量审计触发（**[主控裁决]** 每次发版；原文"每 5 个版本或公开发布前"不适用于本仓库）时，本节随全量审计范围重跑。

### §3.3 必须提供的证据

| 编号 | 证据 | 内容要求 | 当前可执行性 |
|---|---|---|---|
| E1 | 渲染冒烟正向记录 | 修复版 bundle 全场景 PASS 输出全文；**必须含「弹窗开启 + 模型数据非空」场景断言**（当前 23 项断言无此场景，正是 2.7.0 假阴性缺口）；断言总数 > 23 | ✅ 命令现存在（§3.4 C1），场景待编码阶段补入 |
| E2 | 渲染冒烟负向记录 | 崩溃版 bundle（`case/lib-client-2.7.0-crash.bak`，SHA256 见 §3.4 C2）实测 **FAIL**，输出含 **#130 同型错误特征**（`args[]=object` 或 `Element type is invalid … got: object`）；此为发版**硬验收项**，不得降级为文档声明 | ✅ 依赖 SMOKE_BUNDLE（已落地），按实测结果判定 |
| E3 | 历史 bundle 对照记录 | 同一断言集、同一场景注入，仅 bundle 不同：旧版（crash.bak）FAIL + 新版（修复版）PASS **两条**实测记录，命令与输出全文留档 | ⛔ 同上，落地前 BLOCKED |
| E4 | 元素类型断言代码证据 | 假 React 对每次节点构造校验元素类型（string / function 之外拒绝）的断言落点说明；对象作为节点类型的调用必须被判 FAIL | 随 E1/E2 编码阶段交付，交付时留代码位置 |
| E5 | 控制台报错实录（案例基线） | 2.7.0 崩溃的两段同源报错存档（`console-error.txt` 已含）：`index-Ciz7DZxv.js:59 Error: Minified React error #130 … args[]=object&args[]=`（React 内部压缩栈 qc→N→X→ge→vt→Vt→Tm→Nm→Ux→Kc）+ `client.js:22 slot entry crashed in 'main'`；以及复现时序：面板正常 → 点「派工」弹确认框（正常）→ 点「确认派工」POST `/api/board/ui/create` 发出 → 主槽位立刻白屏；F5 恢复、再点必现；换回 2.6.29 client（服务端进程仍 2.7.0）仍白屏 → 触发点是数据翻转后的重渲染而非 bundle 版本 | ✅ 已留档（console-error.txt / CASE.md），作为负向断言的错误特征基准 |

**每条证据必须注明：** 执行时间、执行人、命令全文、输出摘要（FAIL/PASS 行逐字保留）、bundle 身份（SHA256）、结论（PASS / FAIL / BLOCKED）。

#### §3.3.1 状态矩阵（渲染条件分支枚举）

下表枚举弹窗渲染的全部条件分支。**规则：每新增一个渲染条件分支，矩阵必须新增一行让该条件取 true，且该行必须有断言/走查证据覆盖**——没有 true 分支用例的新条件，视同该分支从未被验证，发版判定按 BLOCKED 处理（缺证据）。

| 编号 | 弹窗 | nodeModels | defaultModel | 场景要点 | 新增条件（true 分支） | 旧版 2.7.0 预期 | 新版修复版预期 | 证据归属 |
|---|---|---|---|---|---|---|---|---|
| M1 | 关 | 任意 | 任意 | 面板初始态（计数/机器卡/任务列表） | —（基线） | PASS | PASS | E1 + §5 走查 |
| M2 | 开 | 非空 | 任意 | 选中具体机器，该机有清单，分组下拉渲染 | 条件 A：nodeModels 非空 → 分组下拉 | **FAIL（崩溃型 #130）** | PASS | E1/E3 + §5 走查 |
| M3 | 开 | 空 | 非空 | 默认模型提示渲染（旧代码此路径必进外层 `h(`，即 #130 崩溃路径） | 条件 B：defaultModel 非空 → 默认提示 | **FAIL（崩溃型 #130）** | PASS | E1/E3 |
| M4 | 开 | 空 | 空 | 双空 → 置灰项「该机器未上报模型清单（跟随默认）」 | 条件 C：无清单 → 置灰项恒渲染 | **FAIL（违规型：模型行整行消失，return null）** | PASS | E1/E3 + §5 走查 |
| M5 | 开 | 畸形条目 | 任意 | 条目缺 models 数组 / 含非对象项 | 条件 D：畸形按空清单处理，不抛异常 | FAIL（崩溃型或违规型至少其一，以实测为准） | PASS | E1/E3 |
| M6 | 开 | 该机器无条目 | 任意 | 选中机器无清单 → 置灰项，确认按钮保持可用 | 条件 E：选中机器无清单 → 置灰项 | FAIL（违规型） | PASS | E1/E3 + §5 走查 |
| M7 | 开 | 翻转 | 任意 | 弹窗停留期 summary 由无变有 / 由有变无，原地重渲染（2.7.0 实际崩溃时序：点确认派工 → POST 发出 → 重拉 → nodeModels 翻转非空 → 崩） | 条件 F：翻转重渲染不抛错 | **FAIL（崩溃型 #130）** | PASS | E1/E3 + §5 走查 |
| M8 | 开 | 非空多机 | 任意 | 选「自动」：首组「各在线副机共有（N 个）」+ 按机器分组追加 + 全下拉不重复 | 条件 G：共有组与去重逻辑 | FAIL（崩溃型） | PASS | E1 + §5 走查 |
| M9 | 开 | 非空 | 任意 | 模型条目 location 缺失 / 无法识别 → 归「其他」组，组序固定：云端 · 按量计费 → 局域网 · 免费 → 本机 · 免费 → 其他 | 条件 H：location 兜底归组 | FAIL（崩溃型） | PASS | E1 + §5 走查 |
| M10 | 开 | 任意 | 任意 | maint 模式票据输入区渲染（既有条件，非本次新增，覆盖行） | — | PASS | PASS | E1（现 23 项已含） |
| M11 | 任意 | 任意 | 任意 | config-diff 预览弹层渲染（既有条件，覆盖行） | — | PASS | PASS | E1 |
| M12 | 关 | 任意 | 任意 | worker 状态卡 enabled=false 整卡不渲染（既有守卫，覆盖行） | — | PASS | PASS | E1（现 23 项已含） |

**失败形态两分法**（判定旧版 FAIL 时必须区分并逐字记录）：

- **崩溃型 FAIL**：slot 白屏，输出含 #130 同型特征（`args[]=object` / `got: object`）——对应 E2/E5 错误特征基准；
- **违规型 FAIL**：不崩溃但恒渲染断言失败（模型行整行消失、置灰项文案缺失/不一致）——对应 §3.3.1 中旧代码 `return null` 形态。

### §3.4 可复制命令与预期输出

> 以下命令在 Windows PowerShell（pwsh）下逐字可复制；仓库根目录 = `dsh-job-board-2.7.0-crashcase`。每条注明当前可执行性。

**C1. 渲染冒烟正向（修复版 bundle）** ✅ 当前可执行

```powershell
node scripts/client-render-smoke.mjs; echo "exit=$LASTEXITCODE"
```

预期输出（形态实测自当前仓库，修复版交付后断言总数必须 **> 23**，且含 M2~M9 场景断言行）：

```text
ok    渲染不抛错，拿到 dsb-head
ok    标题旁出现「插件 v2.7.0」  — ["插件 v2.7.0"]
…（逐条 ok 行，逐字保留）
ok    maint 模式有票据输入框  — ticket textarea
…（修复版新增场景 ok 行：弹窗开启 + nodeModels 非空 / defaultModel 非空 / 双空置灰项 …）
PASS  client-render-smoke：N/N 项（插件 v2.7.0 常显于面板标题区）    ← N > 23
exit=0
```

判定锚点：末行以 `PASS` 开头且 `exit=0`；新增场景（M2~M9）各行以 `ok` 开头。若出现 `FAIL` 行或 `exit≠0` → 该证据判 FAIL。

**C2. 对照样本身份固定** ✅ 当前可执行

```powershell
certutil -hashfile case/lib-client-2.7.0-crash.bak SHA256
```

预期输出（实测）：

```text
SHA256 的 case/lib-client-2.7.0-crash.bak 哈希:
1ed59af6d5baa3e19ffdee66a6e0e0c53d7117d4cfec105e6420219441dfc0ef
CertUtil: -hashfile 命令成功完成。
```

判定锚点：哈希必须逐字等于上值——证明 E2/E3 对照跑的就是 2.7.0 出事 bundle（179,013 B）。哈希不一致 → 证据作废，重取样本，判 BLOCKED 直到 identity 固定。

**C3. 历史 bundle 对照——旧版必须 FAIL** （SMOKE_BUNDLE 已落地）

```powershell
# PowerShell 写法
$env:SMOKE_BUNDLE='case/lib-client-2.7.0-crash.bak'; node scripts/client-render-smoke.mjs; echo "exit=$LASTEXITCODE"
# bash 写法（等价）：SMOKE_BUNDLE=case/lib-client-2.7.0-crash.bak node scripts/client-render-smoke.mjs
```

预期输出（目标状态）：

```text
（场景注入：弹窗开启 + 模型数据非空 → 命中旧代码 lib/client.js:3000-3001 缺陷路径）
FAIL  client-render-smoke：崩溃版 bundle 判 FAIL — Element type is invalid … got: object（#130 同型，args[]=object）
exit=1
```

判定锚点：`FAIL` 行 + 输出含 `got: object` 或 `args[]=object`（与 E5 实录同型）+ `exit≠0`。**执行前必须核对 C2 哈希一致。**

**C4. 历史 bundle 对照——新版必须 PASS** （SMOKE_BUNDLE 已落地）

```powershell
$env:SMOKE_BUNDLE='lib/client.js'; node scripts/client-render-smoke.mjs; echo "exit=$LASTEXITCODE"
# bash 写法（等价）：SMOKE_BUNDLE=lib/client.js node scripts/client-render-smoke.mjs
```

预期输出（目标状态）：与 C1 同型，末行 `PASS … N/N 项`，`exit=0`，无任何 FAIL 行。

**C5. 文本门禁（辅助证据）** ✅ 当前可执行

```powershell
node scripts/check-text.mjs; echo "exit=$LASTEXITCODE"
```

预期输出（实测）：`check-text: 不在 git 工作区，跳过（npm 包内没有 .git）`，`exit=0`。判定锚点：`exit=0`（WARN 不阻断）。

> **执行顺序**：C2（固定样本身份）→ C3（旧版 FAIL）→ C4（新版 PASS）→ C1（正向全量）。C3 与 C4 是"旧版会 FAIL、新版会 PASS"的证明主体，二者必须**同一断言集、同一场景注入、仅 bundle 不同**（单变量对照），缺任一条即硬验收未完成。

### §3.5 判定规则

| 结论 | 触发条件 |
|---|---|
| **PASS** | E1~E5 全部齐备且判定一致：C1 全绿（含 M2~M9 新增场景）、C3 旧版崩溃型 FAIL 含 #130 同型、C4 新版 PASS、C2 哈希一致、E5 实录在档 |
| **FAIL** | 任一实测与预期相反：修复版在 M2/M3/M7 任一行 FAIL（#130）；旧版在 C3 被误判 PASS（断言假阴性——2.7.0 漏检形态，性质最恶劣）；M4/M6 行修复版模型行整行消失（恒渲染违规，见 §0.4） |
| **BLOCKED** | 任一证据缺失或命令无法运行；SMOKE_BUNDLE 未落地（当前状态，影响 E2/E3/C3/C4）；crash.bak 缺失且无法按 §3.6 注入构造；C2 哈希不一致 |

**硬验收条款**：E2（旧版崩溃 FAIL + #130 同型）与 E3 的两条对照记录为发版硬验收项——不可跳过、不可降级为文档声明，必须真实运行并留档命令与输出；两条留档缺失任一条，本节整体不得判 PASS，发布动作阻断。

### §3.6 失败处置

1. **修复版 FAIL（C1/C4）**：阻断发布，缺陷按发版流程修复后重跑全链（C2→C3→C4→C1）；禁止只修不重跑。
2. **旧版未 FAIL（C3 误判 PASS）**：断言假阴性成立，禁止发布；先修断言（元素类型校验未生效），再重跑对照。这正是 2.7.0 漏检（冒烟 23/23 PASS 仍白屏）的复刻形态，性质等同 P0。
3. **SMOKE_BUNDLE 未落地（当前常态）**：相关检查项判 BLOCKED 并登记为编码阶段交付项（落 `scripts/client-render-smoke.mjs`，白名单内）；**禁止**在未落地期间用"测试全绿/语法通过"宣布 §3 PASS。
4. **crash.bak 缺失或哈希不符**：按既有规则改用「源码锚点注入」构造坏 bundle（在白名单内脚本能力范围内，注入点复刻 `lib/client.js:3000-3001` 外层 `h(` 首参对象形态），落临时文件后仍走 SMOKE_BUNDLE 入口跑 C3/C4；禁止因样本缺失跳过负向断言。
5. **处置记录**：每次 FAIL/BLOCKED 的处置（修复提交、复检命令、复检输出）必须追加进证据链留档，保持链条连续。

### §3.7 模板：§3 证据链留档

```markdown
## §3 UI 渲染证据链留档 — <版本号> — <YYYY-MM-DD HH:mm> — 执行人 <姓名/会话>

| 证据编号 | 命令全文 | bundle 身份（SHA256 / 文件） | 输出摘要（PASS/FAIL 行逐字） | 判定 | 备注 |
|---|---|---|---|---|---|
| E1 | `node scripts/client-render-smoke.mjs; echo "exit=$LASTEXITCODE"` | lib/client.js <hash> | `PASS client-render-smoke：N/N 项` / exit=0；含 M2~M9 场景 ok 行 | PASS/FAIL/BLOCKED | |
| E2 | `$env:SMOKE_BUNDLE='case/lib-client-2.7.0-crash.bak'; node scripts/client-render-smoke.mjs` | case/lib-client-2.7.0-crash.bak <hash> | `FAIL … #130 同型（args[]=object）` / exit=1 | PASS/FAIL/BLOCKED | 硬验收 |
| E3 | C3 + C4 两条记录（旧 FAIL + 新 PASS，单变量对照） | 见上 | 见上 | PASS/FAIL/BLOCKED | 缺任一条=硬验收未完成 |
| E4 | 元素类型断言落点：<脚本/行号> | — | 对象节点类型实测被拒 | PASS/FAIL/BLOCKED | |
| E5 | console-error.txt / CASE.md 案例基线在档 | — | 两段同源报错 + 复现时序 | PASS | 案例存档 |

状态矩阵执行：M1~M12 各行 true 分支用例覆盖情况：<逐行标注证据编号或 BLOCKED 原因>
本节整体结论：PASS / FAIL / BLOCKED（含理由）
```

---

## §4 配置编辑守卫（YAML 就地编辑安全）

### §4.0 相对上一版 `yaml_edit_guard` spec v1.0 的 5 处修正对照

（上一版 = `.codeartsdoer\specs\yaml_edit_guard\spec.md` v1.0；本节按用户约束修正后写入操作规程。）

| # | 修正点 | v1.0 旧文 | v1 修正 | 证据 / 约束 |
|---|--------|-----------|---------|-------------|
| 1 | js-yaml 依赖 | §3.2 把 js-yaml 列为外部系统；§5.3「真实 YAML 解析复核为唯一权威」 | **运行时零外部依赖**；js-yaml **仅作 CI 验收工具（devDependency）**，不得进 `lib/` 或 `scripts/` 守卫路径 | `package.json` `dependencies={}` `devDependencies={}`；`lib/` 仅 `import node:*` + `./tar.js`；测试未 import js-yaml（`_handoff-2628\_pangu-rereview2-270.md`） |
| 2 | 性能条款 | §4.1「500ms 内完成」「1 秒内完成」 | **删除拍定的数字**；性能红线标「需主控确认」，由主控按真实实现补定 | 未在副机 PowerShell 实测（不拍数字） |
| 3 | 备份命名 | §5.4.1「`<原文件>.bak-guard-<时间戳>`」 | 实现证据为 `.bak-maint-<yyyyMMdd-HHmmss>`；**前缀标「需主控确认」**由主控按真实实现补定 | `enable-maint-write.ps1` L151；`maint-verbs.js` L603；`stamp()`= `yyyyMMdd-HHmmss`（L71-75） |
| 4 | 路径限定 | §4.3「不得接受任意路径」 | 默认限定 `~/.dsh/profiles/<profile>/cordis.patch.yml`；**必须保留 `-PatchPath` 逃生门**供测试与副机用；`-PatchPath` 传入仍校验目标为 `cordis.patch.yml` 且不落系统关键目录 | 当前 `enable-maint-write.ps1` **无 `-PatchPath`**（路径=`Join-Path $profilesRoot $Profile 'cordis.patch.yml'`；测试经 `USERPROFILE` env 重定向）→ 本规则对当前实现判 FAIL |
| 5 | `worker: {} # comment` | §5.1.3 异常2「不展开；写后复核用 js-yaml 解析，若解析失败则回滚」 | 该形态**不被识别为 worker 行**（正则要求 `worker:` + 可选 `{}` + 行尾，无尾随注释），故**不展开、写前干净失败**（不写盘、无需回滚） | `enable-maint-write.ps1` L85/L96 正则 `^\s*worker:\s*(\{\})?\s*$` / `^\s*worker:\s*\{\}\s*$` |

### §4.1 目的

验证 YAML 就地编辑守卫在发版前：不产出无效 YAML、失败不留下半成品、不引入运行时依赖、不丢失备份与逃生门。覆盖两条路径：操作员脚本 `scripts/enable-maint-write.ps1` 与运行时 `lib/worker/maint-verbs.js`（`upsertTeamConfig` / `runConfigSet`）。

### §4.2 触发条件

任何涉及 `cordis.patch.yml` 就地编辑的代码变更进入发布门时：

1. `scripts/enable-maint-write.ps1`、`scripts/set-team-config.ps1` 变更；
2. `lib/worker/maint-verbs.js` 的 `upsertTeamConfig` / `runConfigSet` 变更；
3. `cordis.patch.yml` 结构（worker 子块）变更。

### §4.3 必须提供的证据

1. 守卫源码全文（`enable-maint-write.ps1` / `set-team-config.ps1` / `lib/worker/maint-verbs.js`）；
2. 写后复核逻辑与回滚逻辑；
3. 备份文件样例（在 fixture 上跑守卫后采集）；
4. `test/worker/enable-maint-write-script.test.mjs` 结果；
5. `package.json` 依赖声明；
6. 性能红线数值（「需主控确认」由主控补）。

### §4.4 可复制命令

（在仓库根运行；均为只读；fixture 命令在临时目录构造，不改仓库代码）

```powershell
# A. 零运行时依赖（修正1）
Get-ChildItem -Path lib -Recurse -Filter *.js | Select-String -Pattern 'js-yaml'
Get-ChildItem -Path scripts -Recurse -Filter *.ps1 | Select-String -Pattern 'js-yaml'
node -e "const p=require('./package.json');console.log('deps=',JSON.stringify(p.dependencies||{}),'dev=',JSON.stringify(p.devDependencies||{}))"

# B. 内联空 map 展开正则（修正5 相关）
Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'inlineEmptyMap' | Select-Object LineNumber,Line

# C. 备份命名（修正3）
Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'bak-maint' | Select-Object LineNumber,Line
Select-String -Path lib\worker\maint-verbs.js -Pattern 'bak-maint' | Select-Object LineNumber,Line

# D. 路径限定 / -PatchPath 逃生门（修正4）
Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'PatchPath' | Select-Object LineNumber,Line
Select-String -Path lib\worker\maint-verbs.js -Pattern 'PatchPath|profileDir' | Select-Object LineNumber,Line

# E. 写后复核 + 回滚 + 原子写
Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'problems|Copy-Item \$backup|WriteAllText' | Select-Object LineNumber,Line
Select-String -Path lib\worker\maint-verbs.js -Pattern 'writeFileSync|renameSync|bak-maint' | Select-Object LineNumber,Line

# F. lib/ 运行时 config-set 是否独立处理 worker: {}
Select-String -Path lib\worker\maint-verbs.js -Pattern 'findTeamSubBlocks|config\|worker' | Select-Object LineNumber,Line

# G. 守卫回归测试
node --test test/worker/enable-maint-write-script.test.mjs
```

> R4.3（带注释 `worker: {} # comment` 不展开）的 fixture+pwsh 命令见 §4.5 R4.3 条目，不在上方 A–G 内。
### §4.5 判定规则

（每条规则给：跑什么命令 / 看什么输出 / 怎么判。判定只有 PASS/FAIL/BLOCKED。不拍数字；标「需主控确认」的项由主控补定前不得写 PASS。）

**R4.1 零运行时依赖（修正1：js-yaml 依赖）**
- 跑什么命令：
  ```powershell
  Get-ChildItem -Path lib -Recurse -Filter *.js | Select-String -Pattern 'js-yaml'
  Get-ChildItem -Path scripts -Recurse -Filter *.ps1 | Select-String -Pattern 'js-yaml'
  node -e "const p=require('./package.json');console.log('deps=',JSON.stringify(p.dependencies||{}),'dev=',JSON.stringify(p.devDependencies||{}))"
  ```
- 看什么输出：前两条无匹配行；第三条 `deps= {} dev= {}`（或 dev 含 js-yaml 但 deps 不含）
- 怎么判：`lib/` 与 `scripts/` 守卫路径零 js-yaml 引用 **且** `package.json` `dependencies` 不含 js-yaml → PASS；`lib/` 或 `scripts/` 出现 js-yaml 引用 **或** `dependencies` 含 js-yaml → FAIL（运行时依赖违规）；命令无法运行 → BLOCKED。js-yaml 仅允许作为 devDependency 出现在 `package.json` 或 CI 配置（CI 验收对账用），不得进入运行时 import/require。

**R4.2 内联空 map 展开（修正5 相关）**
- 跑什么命令：`Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'inlineEmptyMap' | Select-Object LineNumber,Line`
- 看什么输出：L96 `$inlineEmptyMap = $lines[$workerIdx] -match '^\s*worker:\s*\{\}\s*$'` 与 L97-100 展开分支
- 怎么判：展开正则存在且要求 `{}` 在行尾（`\{\}\s*$`）→ PASS（只展开 `worker: {}` / `worker:{}` / `worker: {}   `）；正则缺失或不要求行尾 → FAIL

**R4.3 带注释 `worker: {} # comment` 不展开（修正5）**
- 跑什么命令（在临时目录构造 fixture 跑 pwsh，不改仓库代码）：
  ```powershell
  $root = Join-Path $env:TEMP 'dshjb-guard-comment'
  $null = New-Item -ItemType Directory -Path (Join-Path $root '.dsh\profiles\desktop\node_modules\@wfcj\dsh-job-board') -Force
  Set-Content -Path (Join-Path $root '.dsh\profiles\desktop\node_modules\@wfcj\dsh-job-board\package.json') -Value '{"name":"@wfcj/dsh-job-board","version":"2.7.0"}' -Encoding utf8
  $patch = Join-Path $root '.dsh\profiles\desktop\cordis.patch.yml'
  Set-Content -Path $patch -Value @('- id: team','  config:','    worker: {} # comment','- id: other','') -Encoding utf8
  $before = Get-Content -LiteralPath $patch -Raw
  $env:USERPROFILE = $root
  $r = pwsh -NoLogo -NoProfile -File scripts\enable-maint-write.ps1 -Profile desktop -PublicKey 'MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k=' -Force
  $after = Get-Content -LiteralPath $patch -Raw
  Write-Output "exit=$($r.ExitCode)"
  Write-Output "changed=$($before -ne $after)"
  ```
- 看什么输出：`exit=2`（非 0），`changed=False`（文件与写前一致）
- 怎么判：退出码非 0 **且** 文件未变（未展开、未写盘、无需回滚）→ PASS；退出码 0 或文件被改 → FAIL。预期依据：L85 正则 `^\s*worker:\s*(\{\})?\s*$` 不匹配 `worker: {} # comment`（`#` 非空白，`\s*$` 不满足）→ `$workerIdx` 保持 -1 → L88-90 干净失败（代码静态追踪；评审员以实跑为准）

**R4.4 写后复核 + 回滚 + 原子写**
- 跑什么命令：
  ```powershell
  Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'problems|Copy-Item \$backup|WriteAllText' | Select-Object LineNumber,Line
  Select-String -Path lib\worker\maint-verbs.js -Pattern 'writeFileSync|renameSync|bak-maint' | Select-Object LineNumber,Line
  ```
- 看什么输出：ps1 有 `$problems` 汇总、`Copy-Item $backup $patch` 回滚、`[IO.File]::WriteAllText` 写盘；`maint-verbs.js` 有 `writeFileSync(tmp,...)` + `renameSync(tmp, patchFile)` 原子写 + 备份
- 怎么判：两条路径均有写后自检 + 失败回滚 + 原子写（临时文件再替换）→ PASS；缺任一 → FAIL

**R4.5 备份命名（修正3：需主控确认）**
- 跑什么命令：
  ```powershell
  Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'bak-maint' | Select-Object LineNumber,Line
  Select-String -Path lib\worker\maint-verbs.js -Pattern 'bak-maint' | Select-Object LineNumber,Line
  ```
- 看什么输出：ps1 L151 `$backup = "$patch.bak-maint-$stamp"`；`maint-verbs.js` L603 `` `${patchFile}.bak-maint-${stamp(now())}` ``；`stamp` 格式 `yyyyMMdd-HHmmss`（`maint-verbs.js` L71-75）
- 怎么判：备份名 = `.bak-maint-<yyyyMMdd-HHmmss>` 且与实现证据一致 → 该子项结论 = **BLOCKED（需主控确认）**：命名前缀 `.bak-maint-` 标「需主控确认」，由主控按真实实现补定（上一版 `.bak-guard-` 与实现不符，已废弃）。主控确认前缀后按确认值重判；**确认前不得写 PASS**。

**R4.6 路径限定 + `-PatchPath` 逃生门（修正4）**
- 跑什么命令：
  ```powershell
  Select-String -Path scripts\enable-maint-write.ps1 -Pattern 'PatchPath' | Select-Object LineNumber,Line
  Select-String -Path lib\worker\maint-verbs.js -Pattern 'PatchPath|profileDir' | Select-Object LineNumber,Line
  ```
- 看什么输出：`PatchPath` 匹配行（当前实现：ps1 无匹配；`maint-verbs.js` 仅 `profileDir` 无 `PatchPath`）
- 怎么判：守卫默认路径 = `~/.dsh/profiles/<profile>/cordis.patch.yml` **且** 存在 `-PatchPath` 参数（逃生门）**且** `-PatchPath` 传入时仍校验目标为 `cordis.patch.yml` 且不落系统关键目录 → PASS；缺 `-PatchPath` → FAIL（逃生门缺失，测试/副机无逃生通道；上一版「不得接受任意路径」已修正为保留逃生门）；有 `-PatchPath` 但无校验 → FAIL。当前实现证据：ps1 无 `-PatchPath`（路径 = `Join-Path $profilesRoot $Profile 'cordis.patch.yml'`，测试经 `USERPROFILE` env 重定向）→ 评审员据此判 FAIL。

**R4.7 性能红线（修正2：需主控确认）**
- 跑什么命令：无（本规则不拍数字）
- 看什么输出：无
- 怎么判：**BLOCKED（需主控确认）**。上一版 §4.1「500ms 内完成」「1 秒内完成」未在副机 PowerShell 实测，已删除；性能红线（写后复核响应时间、全链路编辑响应时间上限）由主控按真实实现补定，标「需主控确认」。主控补定数值后按补定值重判（判据：在 fixture 上跑守卫，测得响应时间 ≤ 补定上限 → PASS，否则 FAIL）。**补定前不得写 PASS**。

**R4.8 lib/ 运行时 config-set 独立处理 `worker: {}`（防御性深度）**
- 跑什么命令：`Select-String -Path lib\worker\maint-verbs.js -Pattern 'findTeamSubBlocks|config\|worker' | Select-Object LineNumber,Line`
- 看什么输出：L498 `const m = line.match(/^(\s*)(config|worker):\s*$/)` —— 要求 `worker:` 在行尾，不匹配 `worker: {}`
- 怎么判：lib/ 运行时 config-set 独立处理 `worker: {}`（展开或拒绝）→ PASS；不处理（`findTeamSubBlocks` 要求 `worker:\s*$`，遇 `worker: {}` 则 workerIdx=-1 → L540-549 插入新 `worker:` 块 → 产生重复 worker 键）→ FAIL（防御性深度缺口）。注：正常流程下 `enable-maint-write.ps1` 已展开 `worker: {}`，config-set 不会遇到；但作为独立守卫应自行处理。

**§4.5 节判定合成**：R4.1–R4.8 全 PASS → §4 = PASS；任一 FAIL → §4 = FAIL；无 FAIL 但任一 BLOCKED → §4 = BLOCKED。

### §4.6 失败处置

- **FAIL**：列出全部阻断项（FAIL 规则 + 对应命令输出摘录），不发版；按 `AGENTS.md` 发布门，阻断项清零后重跑本节。
  - R4.6 当前实现判 FAIL（缺 `-PatchPath` 逃生门）→ **阻断项**：须为守卫补 `-PatchPath` 参数并校验，或由主控裁定豁免后重判。
  - R4.8 当前实现判 FAIL（lib/ 不独立处理 `worker: {}`）→ **阻断项**：须为 `upsertTeamConfig` 补 `worker: {}` 展开/拒绝，或由主控裁定为已知边界后重判。
- **BLOCKED**：R4.5（备份命名前缀）、R4.7（性能红线）标「需主控确认」→ 主控补定后重判；**补定前不得写 PASS**。
- **PASS**：本节证据齐备且全绿（含主控已补定 R4.5/R4.7、R4.6/R4.8 已修复或裁定豁免）→ 进入下一发布门环节。

### §4.7 模板

```markdown
# 配置编辑守卫审计 — <版本>

## §4.5 判定
| 规则 | 结论 | 证据（命令输出摘录） |
| R4.1 零运行时依赖 | PASS/FAIL/BLOCKED | <输出> |
| R4.2 内联空 map 展开 | ... | ... |
| R4.3 注释 worker: {} # comment 不展开 | ... | ... |
| R4.4 写后复核+回滚+原子写 | ... | ... |
| R4.5 备份命名 | BLOCKED（需主控确认） | <bak-maint 证据> |
| R4.6 路径限定 + -PatchPath 逃生门 | ... | ... |
| R4.7 性能红线 | BLOCKED（需主控确认） | — |
| R4.8 lib/ 运行时独立处理 worker: {} | ... | ... |
| **§4 合成判定** | **PASS/FAIL/BLOCKED** | |

## 需主控确认项
| 项 | 当前证据 | 待主控补定 |
|----|----------|------------|
| 备份命名前缀 | `.bak-maint-<yyyyMMdd-HHmmss>`（ps1 L151 / maint-verbs L603） | 确认前缀（上一版 `.bak-guard-` 已废弃） |
| 性能红线 | 未实测 | 补写后复核响应时间上限、全链路编辑响应时间上限 |

## 阻断项（FAIL 规则）
| 规则 | 现状 | 处置 |
| R4.6 | 当前无 -PatchPath 逃生门 | 补参数+校验 或 主控裁定豁免 |
| R4.8 | lib/ 不独立处理 worker: {} | 补展开/拒绝 或 主控裁定为已知边界 |
```

## §5 可用性走查

### §5.1 目的

证明：修复版在**真实生产宿主**（DSH 桌面版 + 压缩生产 React + slot 错误边界在场）中，全部关键画面与状态形态可用——尤其是**数据翻转 / 边界形态**（弹窗停留期 summary 空翻非空、由有变无、畸形清单、选中机器无清单）。**禁止只覆盖初始态**：2.7.0 缺陷恰好处在「数据翻转后弹窗重渲染」的画面路径上，而当时的冒烟只测了初始态。

本节与 §3 的分工：§3 在探针环境证明"渲染树结构安全"；本节在生产宿主证明"真人从入口点进去不白屏、画面符合确定性规则"。两者互补，不可互相替代。

### §5.2 触发条件

1. 每次发版门启动（与 §3.2 同步触发）；
2. 本次 diff 新增或改动任何画面 / 画面状态形态时，必须补充对应走查行；
3. 全量审计触发时，本节随全量审计范围重跑；
4. §3 状态矩阵（§3.3.1）中任何标注"§5 走查"的行，必须在生产宿主按本节执行。

### §5.3 必须提供的证据

| 编号 | 证据 | 内容要求 |
|---|---|---|
| W1 | 六画面走查记录 | §5.4 画面清单 P1~P6 逐项：结论 + 证据（截图或控制台输出摘要），缺一判 BLOCKED |
| W2 | 数据翻转形态记录 | 至少一组「空 ↔ 非空」翻转形态的画面走查记录（M7 行）；仅有初始态记录视为走查未完成，判 BLOCKED |
| W3 | 生产宿主 click-through 实录 | §5.4.2 清单 T1~T11 逐步执行记录，含控制台全文（DevTools Preserve log 在场）；核心验收行：全程 **零** `slot entry crashed in 'main'`、**零** React error #130 |
| W4 | 状态矩阵走查覆盖表 | §3.3.1 矩阵中标注"§5 走查"的行（M1/M2/M4/M6/M7/M8/M9/M10），逐行注明走查结论与证据编号 |
| W5 | 恒渲染专项确认 | M4/M6 行：模型行存在且置灰项文案**逐字**为「该机器未上报模型清单（跟随默认）」；模型行整行消失 = FAIL（见 §0.4，有意为之的裁决） |

**每条证据必须注明：** 走查时间、执行人、宿主环境（端口 / 插件安装位置 / bundle 版本）、结论。

### §5.4 可复制命令与可执行清单

#### §5.4.1 画面清单（最低六项，缺一判 BLOCKED）

| 画面 | 数据形态 | 验收要点 |
|---|---|---|
| P1 面板初始态 | summary 正常 | 计数 pill、机器卡、任务列表齐全，无白屏 |
| P2 派工确认弹窗 | 输入目标后打开 | 机器卡 / 类型选择器 / 票据框 / 确认按钮全部可用 |
| P3 模型选择区分组下拉 | nodeModels 非空 | 组名与组序固定：云端 · 按量计费 → 局域网 · 免费 → 本机 · 免费 → 其他；「自动」首组「各在线副机共有（N 个）」，全下拉任一模型不重复 |
| P4 置灰空态 | 无清单 / 选中机器无清单 | 置灰项文案逐字「该机器未上报模型清单（跟随默认）」，模型行恒渲染，确认按钮可用 |
| P5 worker 状态卡 | worker-status 任意 | 卡片渲染正常；enabled=false 时整卡不渲染 |
| P6 错误占位降级态 | 注入渲染异常 | 占位出现在 slot 'main' 内（含重试入口），宿主边界不接管、不白屏 |

#### §5.4.2 生产宿主 click-through 可执行清单（逐步执行，逐步留证）

环境事实（执行前逐项确认，不符项记入 W3 备注并按实际环境调整端口）：

- DSH 桌面版运行中；宿主 GUI 端口形如 `http://127.0.0.1:8734`（实际以 DSH 启动日志为准）；
- 插件以 `file:` 安装在 profile：`C:\Users\17827\.dsh\profiles\desktop\node_modules\@wfcj\dsh-job-board`；
- 板子服务 `127.0.0.1:8965`；
- 宿主 React 为压缩生产版（`index-*.js`，无 sourcemap）——报错只给压缩码，控制台验收以**错误码与特征行**为准。

| 步骤 | 操作 | 看什么 | 预期（修复版） | 缺陷版表现（对照，来自 2.7.0 案例） |
|---|---|---|---|---|
| T1 | 打开宿主入口 `http://127.0.0.1:8734` | 页面加载 | 宿主 UI 正常 | — |
| T2 | F12 打开 DevTools → 齿轮（Settings）→ Preferences → Console 勾选 **Preserve log** | 设置项 | **Preserve log 必须勾选**（否则 F5 / 重载会清掉崩溃日志，证据链断裂） | — |
| T3 | 侧栏点「多机调度台」 | P1 初始态 | 面板渲染：计数 / 机器卡 / 任务列表 | 正常（2.7.0 初始态也正常，勿误判为通过依据） |
| T4 | 底部输入框输入一句目标 → 点「派工」 | P2 弹窗 | 确认弹窗弹出，各控件可用 | 正常 |
| T5 | 观察弹窗「模型」行 | P3 / P4 恒渲染判定点 | 分组下拉 **或** 置灰项「该机器未上报模型清单（跟随默认）」，二者必居其一 | 缺陷版此行在数据翻转后崩溃，白屏 |
| T6 | 点「确认派工」 | Network 面板 | `POST /api/board/ui/create` 发出、返回 ok，**主槽位不白屏** | POST 发出后主槽位**立刻白屏** |
| T7 | 切到 Console 面板 | 错误特征行 | **零** `slot entry crashed in 'main'`、**零** `React error #130` | 两段同源报错：`index-Ciz7DZxv.js:59 Error: Minified React error #130 … args[]=object&args[]=` + `client.js:22 slot entry crashed in 'main'`（栈 qc→N→X→ge→vt→Vt→Tm→Nm→Ux→Kc） |
| T8 | F5 刷新 → 重复 T4~T7 | 复现性 | 面板恢复、再次派工**不**复现白屏 | F5 恢复、再点必现（稳定复现） |
| T9 | 弹窗保持开启，等待 ≥8 秒轮询周期（或操作 Hub 使 nodeModels 翻转） | P3↔P4 数据翻转 | 模型行原地平滑切换（下拉 ↔ 置灰项），无白屏、无闪烁、控制台无新错误 | 由无变有翻转 → #130 白屏（2.7.0 实际触发时序） |
| T10 | 选一台未上报清单的机器 | P4 置灰文案 | 置灰项出现且文案逐字一致；点「确认派工」按默认模型行为建单成功 | 缺陷版模型行消失（return null）或崩溃 |
| T11 | 走查收尾 | W3 汇总 | 全部步骤结论落表；控制台全文导出留档（右键 Save as… 或逐段复制） | — |

**采证硬性要求**：T7 的控制台内容必须随 W3 留档原文；任何一步与预期不符，立即停止走查、按 §5.6 处置，不得"带病走完"。

#### §5.4.3 状态矩阵走查驱动 （SMOKE_BUNDLE 已落地）

矩阵 M2~M9 的翻转/边界形态在探针环境复跑时，使用与 §3.4 C3/C4 相同的 SMOKE_BUNDLE 入口（状态声明见 §0.3）：

```powershell
$env:SMOKE_BUNDLE='lib/client.js'; node scripts/client-render-smoke.mjs; echo "exit=$LASTEXITCODE"
```

预期输出（目标状态）：M2~M9 各场景 `ok` 行齐备，末行 `PASS … N/N 项`，`exit=0`。该能力落地前，凡仅能靠此命令覆盖的矩阵行判 BLOCKED（对应画面若能在生产宿主走查覆盖，以 W1/W2 实录为准）。

### §5.5 判定规则

| 结论 | 触发条件 |
|---|---|
| **PASS** | P1~P6 六画面全部走查且留证；W2 翻转形态记录在档；T1~T11 click-through 全部符合预期列；控制台零 `slot entry crashed`、零 #130；M4/M6 恒渲染专项确认通过 |
| **FAIL** | 任一步骤出现主槽位白屏 / `slot entry crashed in 'main'` / React #130；P4 置灰项缺失或模型行整行消失（恒渲染违规，按 §0.4 裁决）；P3 组名/组序偏离固定序列；置灰态下「确认派工」被阻断 |
| **BLOCKED** | 宿主环境不可用（DSH 未运行 / 端口无法确定 / 插件未装 / 板子服务不通）；任一画面或步骤缺证据；Preserve log 未开启导致的日志缺失；依赖 SMOKE_BUNDLE 的矩阵行未覆盖且生产宿主也未走查 |

### §5.6 失败处置

1. **白屏复现（T6~T8 出现 slot crash / #130）**：立即判 FAIL 并阻断发布；采证三件套——控制台全文（含 Preserve log 保住的历史）、复现时序逐步记录、当前 bundle 身份（`certutil -hashfile <profile 下的 lib/client.js> SHA256`）；按发版流程修复后**整条 T1~T11 重跑**。
2. **恒渲染违规（模型行消失 / 置灰项文案不符）**：判 FAIL；该形态是 2.7.0 缺陷的休眠形态回流，按 P0 性质处置，不得以"不崩溃"为由降级。
3. **环境不可用（BLOCKED）**：记录实际环境差异（实际端口、插件安装路径、bundle 版本）后修复环境重跑；禁止跳过走查宣布 PASS。
4. **走查发现新画面缺陷**：阻断发布，新增矩阵行（M 编号顺延）并补 true 分支用例，缺陷修复后复检。
5. **处置记录**：FAIL/BLOCKED 的处置与复检输出追加进 W3 留档。

### §5.7 模板：§5 画面走查记录

```markdown
## §5 可用性走查留档 — <版本号> — <YYYY-MM-DD HH:mm> — 执行人 <姓名/会话>

环境：DSH 桌面版 @ http://127.0.0.1:<实际端口>；插件 <路径> @ <bundle 版本 / SHA256>；板子服务 <地址>；Preserve log：<已开启/未开启>

| 画面 | 数据形态 | 操作步骤（T 编号） | 预期 | 实际 | 结论 | 证据（截图/控制台摘要） |
|---|---|---|---|---|---|---|
| P1 | 初始态 | T1~T3 | 六画面清单对应行 | | PASS/FAIL/BLOCKED | |
| P2 | 弹窗开 | T4 | | | | |
| P3 | nodeModels 非空 | T5 | 组序：云端 · 按量计费 → 局域网 · 免费 → 本机 · 免费 → 其他 | | | |
| P4 | 无清单 / 选中机器无清单 | T10 | 置灰项文案逐字 | | | |
| P5 | worker-status 任意 | P5 专项 | | | | |
| P6 | 注入异常 | P6 专项 | 占位 + 重试入口，不白屏 | | | |
| 翻转 | 空↔非空（M7） | T9 | 原地切换无异常 | | | |

click-through 汇总（T1~T11）：全部符合预期列？ Y/N
控制台特征行验收：slot entry crashed = <N 次>；React #130 = <N 次>（均必须为 0）
矩阵走查覆盖（M1/M2/M4/M6/M7/M8/M9/M10）：逐行标注 W 编号或 BLOCKED 原因
本节整体结论：PASS / FAIL / BLOCKED（含理由）
```

---

*本文件为《发版审查操作规程 v1》§3、§5 两节认领稿；结论三分法、无效证据清单（§0.2）、SMOKE_BUNDLE 能力状态（§0.3）、恒渲染裁决（§0.4）为两节共用口径。只含规格与操作步骤，不含任何代码改动。*

## §6 负向门禁

### 目的

证明每个已修缺陷都有一条**同一个回归用例在旧版 FAIL、新版 PASS**的可执行证据，防止“测试没有复现缺陷”“只验证新版 happy path”“旧版其实因环境错误失败”。

每个缺陷必须形成闭环：缺陷 ID、旧版提交、新版提交、同一用例、两条命令、两份输出、两个 exit code、失败签名、通过签名和最终判定。

### 触发条件

适用于本次发版中每一个标记为 `fixed`、`closed`、`mitigated` 的缺陷，以及审查过程中新修复的缺陷。

- 无旧版可运行代码：BLOCKED，并说明缺失的 tag/commit/包；
- 无回归用例：FAIL；
- 只跑新版：FAIL；
- 旧版 PASS：FAIL，因为用例没有复现缺陷；
- 旧版 FAIL 但失败原因是缺依赖、路径不存在、语法不支持或测试文件不存在：BLOCKED，不算复现；
- 纯文档修复也必须用旧版缺失/错误、新版存在/正确的机械断言完成负向验证。

### 必须提供的证据

每个缺陷在 `docs/audit-<version>/negative/<finding-id>/` 下保存：

```text
<finding-id>.command.ps1   # 同一测试入口，显式接收 old/new target
<finding-id>.runner.mjs    # 两版共享的同一测试逻辑，显式读取 target
<finding-id>.old.log       # 旧版 stdout + stderr，含预期缺陷签名
<finding-id>.new.log       # 新版 stdout + stderr，含通过签名
<finding-id>.result.json   # 两版 ref、命令、log、exitCode、签名、PASS/FAIL/BLOCKED
```

并满足：

1. 两版运行同一测试逻辑；测试必须支持显式 target，防止“旧 worktree 里运行了新版代码”；
2. 旧版 exit code 非 0，且日志匹配缺陷签名；
3. 新版 exit code 为 0，且日志匹配修复后的通过签名；
4. 两版命令、ref、时间和环境写入 `result.json`；
5. 汇总写入 `negative/index.json`；每个缺陷都能独立定位证据。

禁止将“测试文件不存在”“module not found”“依赖安装失败”“语法解析失败”当作旧版缺陷 FAIL。

### 可复制命令

以下示例创建旧版 worktree，并对同一 `F-001` 用例运行旧版和新版。**[主控裁决 2026-11-21]** 本仓库允许用「上一版崩溃 bundle + SMOKE_BUNDLE 注入」替代 git worktree（须注明 bundle 路径与 SHA256）；二者不得同时缺。先把变量替换为实际版本、缺陷 ID、旧版 ref 和签名正则。共享 runner 保存在 `$CaseDir/<id>.runner.mjs`，确保两版执行的是同一份测试逻辑：

```powershell
$Version = '2.7.1'
$Id = 'F-001'
$OldRef = 'v2.7.0'
$OldSignature = 'Element type is invalid.*client\.js:3000'
$NewSignature = 'dispatch dialog strict render PASS'
$Root = (Get-Location).Path
$Old = Join-Path $Root ".audit-old-$Version"
$CaseDir = Join-Path $Root "docs/audit-$Version/negative/$Id"
$Command = Join-Path $CaseDir "$Id.command.ps1"
$OldLog = Join-Path $CaseDir "$Id.old.log"
$NewLog = Join-Path $CaseDir "$Id.new.log"
New-Item -ItemType Directory -Force -Path $CaseDir | Out-Null

git worktree add --detach "$Old" "$OldRef"
$OldSha = git rev-parse "$OldRef"
$NewSha = git rev-parse HEAD

& $Command -Id $Id -Target "$Old" -Phase old -CaseDir "$CaseDir"
$OldExit = $LASTEXITCODE
& $Command -Id $Id -Target "$Root" -Phase new -CaseDir "$CaseDir"
$NewExit = $LASTEXITCODE

$OldSignatureMatched = (Test-Path $OldLog) -and (Select-String -Path $OldLog -Pattern $OldSignature -Quiet)
$NewSignatureMatched = (Test-Path $NewLog) -and (Select-String -Path $NewLog -Pattern $NewSignature -Quiet)
$Result = 'BLOCKED'
if ($OldExit -eq 0 -or $NewExit -ne 0) {
  $Result = 'FAIL'
} elseif (-not $OldSignatureMatched -or -not $NewSignatureMatched) {
  $Result = 'BLOCKED'
} elseif ($OldExit -ne 0 -and $NewExit -eq 0) {
  $Result = 'PASS'
}

@{
  id = $Id
  result = $Result
  old = @{
    ref = $OldSha; command = "$Command -Id $Id -Target $Old -Phase old -CaseDir $CaseDir"
    log = "$CaseDir/$Id.old.log"; exitCode = $OldExit
    expectedSignature = $OldSignature; signatureMatched = $OldSignatureMatched
  }
  new = @{
    ref = $NewSha; command = "$Command -Id $Id -Target $Root -Phase new -CaseDir $CaseDir"
    log = "$CaseDir/$Id.new.log"; exitCode = $NewExit
    expectedSignature = $NewSignature; signatureMatched = $NewSignatureMatched
  }
  checkedAt = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $CaseDir "$Id.result.json")

if ($Result -ne 'PASS') { throw "$Id 负向门禁为 $Result，禁止发版。" }
```

每个 `<finding-id>.command.ps1` 使用以下统一接口；`runner.mjs` 必须读取 `$Target` 指向的代码，而不是隐式读取当前新版目录：

```powershell
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('old', 'new')][string]$Phase,
  [Parameter(Mandatory = $true)][string]$CaseDir
)

$Log = Join-Path $CaseDir "$Id.$Phase.log"
$Runner = Join-Path $CaseDir "$Id.runner.mjs"
Push-Location $Target
try {
  & node $Runner --target $Target *> $Log
  $Code = $LASTEXITCODE
} catch {
  $_ | Out-String | Add-Content -Encoding utf8 $Log
  $Code = 1
} finally {
  Pop-Location
}
exit $Code
```

外层只根据 exit code 和签名做初步判定；审查者仍须检查旧版失败是否来自目标缺陷。环境、依赖、路径或语法失败即使非零，也必须判 BLOCKED。

### 判定规则

1. `PASS`
   - 同一用例、同一参数口径，仅 target 不同；
   - 旧版非 0 + 缺陷签名匹配；新版 0 + 通过签名匹配；
   - 两版 ref、命令、输出和 exit code 全部落盘；
   - 汇总 `negative/index.json` 中该缺陷为 PASS。

2. `FAIL`
   - 旧版 0：用例未复现缺陷；
   - 新版非 0：缺陷未修复或引入回归；
   - 两版使用了不同测试逻辑却声称是同一负向验证；
   - 旧版确实因目标缺陷失败，但新版没有预期通过签名；
   - 任一已修缺陷没有负向用例。

3. `BLOCKED`
   - 缺旧版、缺日志、缺 exit code、缺 result.json 或无法确认 target；
   - 旧版失败由环境、依赖、路径、权限、语法、测试文件缺失引起；
   - 失败/通过签名未定义或无法核验；
   - 命令根本没有执行。

任何已修缺陷为 FAIL 或 BLOCKED，整版负向门禁不得 PASS。

### 失败处置

- 旧版 PASS：重写用例直到能稳定复现旧缺陷；不得删除断言或降低旧版失败标准。
- 旧版环境失败：保持 BLOCKED，隔离并修复测试环境后重跑；不得把非零退出码直接当复现。
- 新版 FAIL：退回修复，保持发版阻断；不能用 Error Boundary、重试或吞异常伪装通过。
- 缺用例：先补用例并证明旧版 FAIL，再允许修复关闭。
- 所有重跑保存新的时间戳或明确覆盖记录；最终报告引用最后一次可复核结果，同时保留早期失败材料。

### 模板

#### §6-A `docs/audit-<version>/negative/<finding-id>/<finding-id>.result.json`

```json
{
  "id": "F-001",
  "title": "派工弹窗把 React element 当作 element type",
  "result": "PASS",
  "case": "dispatch-dialog-invalid-element-type",
  "old": {
    "ref": "<old-sha>",
    "target": "<old-worktree>",
    "command": "docs/audit-<version>/negative/F-001/F-001.command.ps1 -Id F-001 -Target <old-worktree> -Phase old -CaseDir docs/audit-<version>/negative/F-001",
    "log": "docs/audit-<version>/negative/F-001/F-001.old.log",
    "exitCode": 1,
    "expectedSignature": "Element type is invalid.*client.js:3000",
    "signatureMatched": true
  },
  "new": {
    "ref": "<new-sha>",
    "target": "<new-worktree>",
    "command": "docs/audit-<version>/negative/F-001/F-001.command.ps1 -Id F-001 -Target <new-worktree> -Phase new -CaseDir docs/audit-<version>/negative/F-001",
    "log": "docs/audit-<version>/negative/F-001/F-001.new.log",
    "exitCode": 0,
    "expectedSignature": "dispatch dialog strict render PASS",
    "signatureMatched": true
  },
  "checkedAt": "<ISO-8601>",
  "checkedBy": "<new-full-audit-session-id>"
}
```

#### §6-B `docs/audit-<version>/negative/index.json`

```json
{
  "version": "<version>",
  "result": "PASS",
  "requiredFixedDefects": ["F-001"],
  "completed": [
    {
      "id": "F-001",
      "result": "PASS",
      "evidence": "docs/audit-<version>/negative/F-001/F-001.result.json",
      "oldExitCode": 1,
      "newExitCode": 0
    }
  ],
  "missing": [],
  "blocked": [],
  "failed": []
}
```

---

## §7 发布签核表（DoD）— 主控起草

发布前逐项打勾，任一未勾 = 不发布。命令按仓库现状（`package.json` scripts）给：

| # | 项目 | 命令 / 做法 | 判定 | 证据 |
|---|---|---|---|---|
| 1 | 全量审计 | 新会话全量审 + 反证清单 | 无未决 P0/P1 | `full-audit.md` |
| 2 | UI 渲染证据链 | 严格冒烟 + 崩溃版对照 | 旧 FAIL / 新 PASS | `ui-render.md`、`negative-gate.txt` |
| 3 | 可用性走查 | 七条路径真点 + 截图 | 全部可用，控制台干净 | `usability.md` |
| 4 | 门禁全绿 | `npm run gate` | exit 0；smoke 严格模式全绿 | `gate.log` |
| 5 | 三处版本一致 | `node scripts/plugcheck.mjs` | PASS（`plugins=… tools=18 routes=28`） | `gate.log` |
| 6 | 包内容核对 | `npm pack --dry-run` → 文件数/字节；`npm view` 比对 | 与预期一致 | `deploy.md` |
| 7 | 部署一致性 | 覆盖 profile 后查 `GET /api/board/ui/doctor` | `version == installedVersion == 目标版本` | `deploy.md` |
| 8 | 重启提示 | 明确告知“需重启 DSH 生效” | 已告知 | 会话记录 |
| 9 | 回滚路径 | 上一版 tag + 回退命令 + `npm deprecate` 话术 | 成文可执行 | `deploy.md` |

**回滚话术模板**：

```bash
# 打回上一版（示例：2.7.0 有白屏，回 2.6.29）
npm deprecate '@wfcj/dsh-job-board@2.7.0' "点「派工」白屏（React #130），请升级 2.7.1"
# 本机回退：把 profile 的 node_modules/@wfcj/dsh-job-board 覆盖为上一版 tgz 解包内容，然后重启 DSH
```

**P2 带病发布**：允许，但必须写进 CHANGELOG「已知问题」+ 用户明确接受并记录范围与修复期限。

---

## §8 模板区

### 目的

提供可直接粘贴的 `uiRenderReview` 证据块、findings 窄记 JSON、审计报告骨架和命令清单，统一证据路径、结论词汇和签署口径，避免不同审查者用不同格式或把描述当证据。

### 触发条件

- 每次发版的全量审计必须使用 §8-C 报告骨架和 §8-D 命令清单；
- UI 相关变更必须附加 §8-A；
- findings 新增、关闭、回归或状态变化必须使用 §8-B；
- 每次发版均使用新会话全量审计；常驻增量审计仅作辅助输入，不得减少本节要求的材料。

### 必须提供的证据

模板本身不是证据。合稿与签署前必须提供：

1. 填写完成且引用了真实文件的 `uiRenderReview.json`（适用时）；
2. 主控落盘的 `findings.json`，且每个 fixed/closed 项链接到 §6 负向证据；
3. `release-review.md` 审计报告，结论只有 PASS/FAIL/BLOCKED；
4. `commands/commands.json` 或 `commands/results.jsonl`，含实际命令、cwd、日志、exit code 和结果；
5. 新会话全量审计的会话 ID、时间、base/HEAD 和整包重扫范围；
6. 所有占位符均已替换，所有引用文件存在且能从仓库根目录读取。

### 可复制命令

初始化本规程证据目录；模板文件可按下列路径落盘：

```powershell
$Version = '2.7.1'
$Audit = Join-Path (Get-Location).Path "docs/audit-$Version"
$Dirs = @(
  'scope', 'commands', 'coverage\raw', 'counterproof', 'negative', 'review'
) | ForEach-Object { Join-Path $Audit $_ }
New-Item -ItemType Directory -Force -Path $Dirs | Out-Null

@{
  version = $Version
  auditMode = 'FULL'
  sessionIsolation = 'NEW'
  incrementalReview = 'AUXILIARY'
  result = 'BLOCKED'
  createdAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Audit 'review\meta.json')
```

检查 JSON 模板和证据引用是否可读：

```powershell
$Version = '2.7.1'
$Audit = Join-Path (Get-Location).Path "docs/audit-$Version"
$JsonFiles = Get-ChildItem -Recurse -File $Audit -Filter *.json
foreach ($File in $JsonFiles) {
  try {
    Get-Content -Raw -Encoding utf8 $File.FullName | ConvertFrom-Json | Out-Null
    "PASS JSON $($File.FullName)"
  } catch {
    "FAIL JSON $($File.FullName): $($_.Exception.Message)"
    exit 1
  }
}
```

### 判定规则

- `PASS`：模板已填写为实际证据；JSON 可解析；命令、输出、exit code、会话和路径均可复核；所有必做项完成。
- `FAIL`：证据显示负向门禁不成立、存在未执行路径、存在未关闭 P0/P1，或审查结论与实际证据矛盾。
- `BLOCKED`：模板仍有 `<...>` 占位、JSON 不可解析、证据文件缺失、命令未执行、没有新会话全量审计，或只有模板没有实际输出。

不得使用 `PASS*`、`基本 PASS`、`有条件 PASS`、`N/A PASS`。非适用项写 `applicable: false` 和理由，整版结论仍只能是三种之一。

### 失败处置

- 模板未填写或引用失效：BLOCKED，退回主控补证；
- findings 标记 fixed 但没有 §6 证据：FAIL，撤销关闭状态并补负向门禁；
- 审计报告与原始日志矛盾：FAIL，重新核对并保留更正记录；
- 使用常驻会话替代新会话全量审计：BLOCKED，重新发起全量审计；
- 命令清单缺 exit code：BLOCKED，重跑并落盘，不得手工猜 0/1。

### 模板

#### §8-A `docs/audit-<version>/review/uiRenderReview.json`

```json
{
  "uiRenderReview": {
    "applicable": true,
    "result": "BLOCKED",
    "version": "<version>",
    "baseRef": "<base-ref>",
    "headRef": "<head-sha>",
    "auditMode": "FULL",
    "reviewedBy": "<new-full-audit-session-id>",
    "affectedSubtree": [
      "Panel > DispatchDialog > ModelSelect"
    ],
    "stateMatrix": [
      {
        "id": "UI-001",
        "state": "ask=true + defaultModel",
        "expected": "类型行与模型行合法渲染",
        "actual": "<observed-result>",
        "status": "BLOCKED",
        "evidence": "docs/audit-<version>/coverage/client-smoke.log"
      },
      {
        "id": "UI-002",
        "state": "taskMode=maint + remote diff",
        "expected": "远程提示显示且无对象 child",
        "actual": "<observed-result>",
        "status": "BLOCKED",
        "evidence": "<path-or-empty>"
      }
    ],
    "counterproof": {
      "result": "BLOCKED",
      "unexecutedPathIds": [],
      "evidence": "docs/audit-<version>/counterproof/summary.json"
    },
    "strictRuntime": {
      "commandId": "CMD-UI-001",
      "invalidTypeChecked": true,
      "elementAsPropsChecked": true,
      "objectChildChecked": true,
      "log": "docs/audit-<version>/coverage/client-smoke.log",
      "exitCode": 0,
      "result": "PASS"
    },
    "negativeGate": {
      "result": "BLOCKED",
      "defectIds": ["F-001"],
      "evidence": "docs/audit-<version>/negative/index.json"
    },
    "productionHost": {
      "applicable": true,
      "hostBuild": "<DSH-build>",
      "reactMode": "production",
      "path": "open -> dispatch -> confirm -> summary refresh",
      "consoleLog": "docs/audit-<version>/review/production-console.log",
      "networkEvidence": "docs/audit-<version>/review/production-network.har",
      "consoleErrors": 0,
      "result": "BLOCKED"
    },
    "notes": "证据未齐时保持 BLOCKED，不得预填 PASS。"
  }
}
```

#### §8-B `docs/review/findings.json` 窄记格式

```json
{
  "version": "<version>",
  "updated": "<YYYY-MM-DD>",
  "entries": [
    {
      "id": "F-001",
      "kind": "new",
      "severity": "P0",
      "status": "fixed",
      "where": "lib/client.js:3000-3121",
      "summary": "派工模型区 h() 参数错位，React element 被当作 type。",
      "evidence": [
        "lib/client.js:3000",
        "docs/audit-<version>/negative/F-001/F-001.old.log"
      ],
      "tests": [
        "scripts/client-render-smoke.mjs / dispatch dialog matrix"
      ],
      "negativeGate": {
        "result": "PASS",
        "oldExitCode": 1,
        "newExitCode": 0,
        "evidence": "docs/audit-<version>/negative/F-001/F-001.result.json"
      },
      "firstSeen": "<version-or-date>",
      "fixedIn": "<version-or-sha>",
      "updated": "<YYYY-MM-DD>"
    }
  ]
}
```

窄记约束：单条 summary 不超过 120 字；不存对话、不存长报告；`kind` 使用 `new|regression|closed|confirm`；`status` 使用现有项目状态词；凡 `fixed/closed/mitigated` 必须有 `negativeGate.result=PASS`，否则整版不得 PASS。

#### §8-C `docs/audit-<version>/review/release-review.md` 审计报告骨架

```markdown
# <version> 发版全量审计报告

- 结论：BLOCKED
- 版本：<version>
- Base / HEAD：<base-ref> / <head-sha>
- 审计方式：FULL（整包重扫）
- 新会话 ID：<new-full-audit-session-id>
- 常驻增量材料：仅作辅助，路径：<path-or-none>
- 审计时间：<ISO-8601>
- 审计人 / 角色：<name-or-agent / role>

## 1. 范围与反证

- 整包文件清单：<path>
- 变更文件与完整组件：<path>
- 反证清单：<path>
- 未执行路径数量：<number>
- 未执行路径 ID：<list-or-empty>
- 结论：PASS / FAIL / BLOCKED

## 2. 负向门禁

| 缺陷 | 旧版 ref / exit | 新版 ref / exit | 旧失败签名 | 新通过签名 | 证据 | 结论 |
|---|---|---|---|---|---|---|
| F-001 | <old-sha> / 1 | <new-sha> / 0 | <signature> | <signature> | <result.json> | PASS |

- 已修缺陷总数：<number>
- 旧 FAIL / 新 PASS 完整闭环数：<number>
- 缺用例 / 缺证据：<list-or-empty>
- 结论：PASS / FAIL / BLOCKED

## 3. UI 渲染证据

- uiRenderReview：<path>
- 状态矩阵结果：<summary>
- 严格 type/child 校验：<summary>
- 生产宿主与控制台：<summary>
- UI 是否适用：<true-or-false>；不适用理由：<reason-or-empty>
- 结论：PASS / FAIL / BLOCKED

## 4. Findings

| ID | 级别 | 状态 | 文件:行 | 一句话 | 负向证据 |
|---|---|---|---|---|---|
| F-001 | P0 | fixed | lib/client.js:3000 | <summary> | <path> |

## 5. 命令与输出

- 命令清单：<commands.json-or-results.jsonl>
- 测试失败命令：<list-or-empty>
- 缺 exit code 命令：<list-or-empty>
- 结论：PASS / FAIL / BLOCKED

## 6. 风险、处置与签署

- 未关闭 P0/P1：<list-or-empty>
- 残余风险：<list>
- 回退方案：<path-or-description>
- 发布建议：PASS / FAIL / BLOCKED
- Security 签署：<name + conclusion + evidence>
- Engineering 签署：<name + conclusion + evidence>
- 主控签署：<name + conclusion + evidence>
```

#### §8-D `docs/audit-<version>/commands/commands.json` 命令清单

```json
{
  "version": "<version>",
  "result": "BLOCKED",
  "commands": [
    {
      "id": "CMD-UNIT-001",
      "purpose": "worker 单元测试与 coverage",
      "cwd": "<repo-root>",
      "command": "node --test --experimental-test-coverage \"test/worker/*.test.mjs\"",
      "log": "docs/audit-<version>/coverage/coverage-summary.log",
      "exitCode": 0,
      "expected": "zero",
      "result": "PASS",
      "executedAt": "<ISO-8601>"
    },
    {
      "id": "CMD-UI-001",
      "purpose": "严格客户端状态矩阵",
      "cwd": "<repo-root>",
      "command": "npm.cmd run smoke:client",
      "log": "docs/audit-<version>/coverage/client-smoke.log",
      "exitCode": 0,
      "expected": "zero",
      "result": "PASS",
      "executedAt": "<ISO-8601>"
    },
    {
      "id": "CMD-NEG-F001-OLD",
      "purpose": "F-001 旧版复现",
      "cwd": "<old-worktree>",
      "command": "F-001.command.ps1 -Id F-001 -Target <old-worktree> -Phase old -CaseDir docs/audit-<version>/negative/F-001",
      "log": "docs/audit-<version>/negative/F-001/F-001.old.log",
      "exitCode": 1,
      "expected": "nonzero + defect signature",
      "result": "PASS",
      "executedAt": "<ISO-8601>"
    },
    {
      "id": "CMD-NEG-F001-NEW",
      "purpose": "F-001 新版验证",
      "cwd": "<new-worktree>",
      "command": "F-001.command.ps1 -Id F-001 -Target <new-worktree> -Phase new -CaseDir docs/audit-<version>/negative/F-001",
      "log": "docs/audit-<version>/negative/F-001/F-001.new.log",
      "exitCode": 0,
      "expected": "zero + pass signature",
      "result": "PASS",
      "executedAt": "<ISO-8601>"
    },
    {
      "id": "CMD-GATE-001",
      "purpose": "完整项目门禁",
      "cwd": "<repo-root>",
      "command": "npm.cmd run gate",
      "log": "docs/audit-<version>/review/npm-gate.log",
      "exitCode": 0,
      "expected": "zero",
      "result": "PASS",
      "executedAt": "<ISO-8601>"
    }
  ]
}
```

#### §8-E `docs/audit-<version>/commands/results.jsonl` 逐命令结果

每行一个独立 JSON 对象；命令未执行不得补写：

```json
{"id":"CMD-GATE-001","cwd":"<repo-root>","command":"npm.cmd run gate","log":"docs/audit-<version>/review/npm-gate.log","exitCode":0,"result":"PASS","executedAt":"<ISO-8601>"}
{"id":"CMD-NEG-F001-OLD","cwd":"<old-worktree>","command":"F-001.command.ps1 -Id F-001 -Target <old-worktree> -Phase old -CaseDir docs/audit-<version>/negative/F-001","log":"docs/audit-<version>/negative/F-001/F-001.old.log","exitCode":1,"result":"PASS","executedAt":"<ISO-8601>"}
```

注意：旧版负向用例的预期结果是非零，因此 `result=PASS` 表示“按预期复现缺陷”，不是旧版软件通过。所有非预期失败必须标 FAIL；无法执行或无法核验必须标 BLOCKED。
---

## 附录 B 合稿冲突裁决（2026-11-21，主控）

> **v1.2 变更**：新增 §9（部署与安装审查）、§10（发布通道审查）、附录 C（事故注入台账，8 条）。这些条款全部来自 2026-11-20~21 的六个真实事故，每条都能指到一次翻车。

| # | 冲突点 | 各方原文 | 裁决 | 理由 |
|---|---|---|---|---|
| 1 | 全量审计频率 | GLM §5.4.1 规则 2 / Kimi auditor-protocol：「每 5 个版本或公开发布前」 | **每次发版都全量**；常驻增量仅作辅助 | 用户明确口径：每次上架前必须全量审计；2.7.0 正是「只审改动面」漏掉休眠分支 |
| 2 | SMOKE_BUNDLE 能力状态 | GLM §0.3：仓库未实现，相关项一律 BLOCKED | **已落地**（主控 2026-11-21 00:00 实现并实测 FAIL/PASS），按实测判定 | 实测：崩溃版 FAIL 3/26 exit=1；修复版 PASS 29/29 exit=0 |
| 3 | 模型区渲染 | 旧文档：空池不进模型区（return null） | **恒渲染 + 置灰项**（与 GLM §0.4 同口径） | 静默消失即 2.7.0 缺陷休眠形态 |
| 4 | 负向门禁旧版 target | Kimi §6：必须独立 worktree | **bundle 或 worktree 二选一**，须写明路径/ref + SHA256 | 仓库零依赖、客户端单文件 bundle 可注入；worktree 在 Windows 下成本高 |
| 5 | 运行时 js-yaml | 盘古早期 spec：复核依赖 js-yaml | **运行时零依赖**（自写结构校验器），js-yaml 仅 devDependency/CI 交叉验证 | 副机部署是复制文件、不 npm install；tgz 体积零增长 |
| 6 | 路径限定 | 盘古 §4.3：限定 ~/.dsh/profiles/ | 保留限定，**保留 -PatchPath 逃生门**（测试/副机） | 与既有实现一致，避免锁死排障路径 |

> 裁决生效后，正文中与之冲突的措辞以上表为准；下一版合稿由章节作者自行收敛，主控不再逐条改。

---

## §9 部署与安装审查（v1.2 新增，硬门）

> 背景：2.7.1 装到 GT14 后 DSH 起不来。根因不是代码写错，而是**安装方式**——`robocopy /E` 覆盖正在运行的目录，留下「新 `lib/index.js` + 旧 `lib/dispatch-filter.js`」的混合树，ESM 链接期抛 `does not provide an export named 'canDispatchRemote'`。
> 结论：**安装本身就是一次发版面**，必须像代码一样被审查。

### 9.1 安装必须原子
| 要求 | 判定 |
|---|---|
| 解包到 `.stage-<ts>`，不直接写目标目录 | 目标目录在切换前字节不变 |
| 写 `install-manifest.json`（版本 + 关键文件 SHA256） | 清单存在且 `package.json` 版本一致 |
| 旧目录改名 `.bak-<ts>` 后再换名 | 失败可换回，用户数据不丢 |
| 装完自检：版本 / 文件数 / 关键文件 SHA256 / 清单 | 任一不符 → 自动回滚并报错 |
| 目标 DSH 在跑时先停，装完自动拉起 | 失败分支也必须拉起（不许把用户机器留在关机态） |
| **禁止** `robocopy /E` 覆盖运行中目录 | 出现即 FAIL |

关键文件至少含：`lib/index.js`、`lib/dispatch-filter.js`、`lib/client.js`、`lib/worker/version.js`。

### 9.2 装完必须在真副机验三件事
1. `maint version` 或 `plugin=<ver>` 探针回报新版本；
2. DSH 能起来（进程在、面板可开、`doctor` 有返回）；
3. 插件 `apply()` 的安装清单自检没有 warn（有 warn 就是混合树，直接回滚）。

> 只在本机 fixture 验过不算过。**2.7.2 的教训**：本机 fixture 全绿、真副机起不来，差别在「运行中目录 + 部分文件」这个真实条件。

### 9.3 脚本自身也要过门禁
装机脚本这几类 bug 都真实发生过，必须写进用例：
- 调用了不存在的函数（`Warn` 未定义）；
- 复核计数把自生成文件算漏/算多（`install-manifest.json` off-by-one）；
- 参数拼接被 PowerShell 解析成别的参数（`ForEach-Object { } -join`）；
- 只改配置分支里 `$tmp` 未赋值，收尾 `Test-Path` 抛异常（`-SkipPackage`）；
- YAML 形状假设（`worker: {}` 内联、worker 位置错放、重复键）。

用例矩阵（fixture 上跑，必须全绿）：5 种 YAML 形状 × （装包 / 只改配置）× （成功 / 故意失败）+ 幂等重跑一次。

---

## §10 发布通道审查（v1.2 新增）

> 背景：① npm 发布被 `EOTP` 挡住——账号是 auth-and-writes，CLI 拿不到可用授权 URL（日志里被脱敏）；② 代理 `127.0.0.1:7897` 让 registry TLS 握手失败（`ECONNRESET`）；③ 自动更新通道哑火——插件读 GitHub Releases，而 Releases 停在 `v2.5.10`，2.6.x/2.7.x 全部没建 Release。

### 10.1 npm 发布
| 项 | 要求 |
|---|---|
| 网络 | `--noproxy '*'` 且清空 `HTTP(S)_PROXY`（Registry 直连） |
| 身份 | 先 `npm whoami` 打印账号；**发布权限**要么 Automation/Granular token（勾 Bypass 2FA），要么人在场用浏览器 Authorize |
| 产物校验 | 发布后 `npm view <pkg>@<ver> dist.shasum` **必须等于**本地 tgz 的 SHA1；`fileCount` 与 pack-check 一致 |
| 失败回滚 | 版本不可撤销 → 只能用 `deprecate` + 更高版本覆盖 `latest`；签核表必须写 deprecate 话术 |
| 记录 | 发布人、时间、sha1、`_npmUser`、`dist-tags` 截图/输出留档 |

### 10.2 GitHub Release 与 tag
- **tag 与 Release 必须同时存在**：`v2.7.x` 起每次发版都要建 Release（名称含版本 + 一段「修什么/怎么验」），否则客户端更新提示读不到。
- tag 用 annotated tag；`git ls-remote --tags` 核验远端有 `^{}` 解引用提交。
- Release 正文模板：版本、npm 包名与版本、修复清单、验证命令与数字、回滚方式。

### 10.3 商城条目（awesome-dsh-plugin）
- 条目描述里的工具数/能力必须与代码一致（当前 14 `board_*` + 4 `sh_*` = 18）。
- 平台维护者意见（占位符、命名、清单完整性）视为**发版输入**，处理后在 PR 里回一条说明并附 commit。
- 条目本身不随版本变化；npm `latest` 才是用户装到的版本 ⇒ **npm 没发成功，商城条目就等于没更新**。

---

## 附录 C 事故注入台账（v1.2，2026-11-20 ~ 11-21）

| # | 事故 | 根因（机制） | 由哪条兜住 |
|---|---|---|---|
| C1 | 2.7.0 点「派工」整槽白屏（React #130） | `lib/client.js:3000` 嵌套 `h(h(...))`，element type 变成对象；空池/无默认模型时 `return null` 让分支休眠 | §3 严格渲染 + §3.3 数据翻转 + §5 D3/D4 真派工 |
| C2 | 指定模型派工必失败（三层） | Host `take` 4s 与 worker `claim` 2s 抢同一 queued 任务；远程桥 headless 拒 model 且 note 不可操作；allowlist 条目缺 `matchAll`/前缀被静默丢弃 | §5 派工矩阵（D4 `remote_id` 必须空、D5/D7 必须可操作 blocked）+ §10 配置就绪检查 |
| C3 | GT14 装 2.7.2 后 DSH 起不来 | 跨文件具名导入 + robocopy 覆盖运行中目录 → 混合树 → ESM 链接期 `does not provide an export` | §9.1 原子安装 + §9.2 真副机验证 |
| C4 | 装机脚本 5 个自身 bug | `Warn` 未定义 / 文件数 off-by-one / pid join 括号 / `-SkipPackage` 下 `$tmp` 未赋值 / YAML 形状假设 | §9.3 脚本用例矩阵 |
| C5 | npm 发布 EOTP + 代理 TLS 失败 | auth-and-writes 账号 CLI 需 OTP，授权 URL 被脱敏；7897 代理拦 TLS | §10.1 网络与权限条款 |
| C6 | 自动更新通道哑火 | 只推 tag 与 npm，没建 GitHub Release | §10.2 tag/Release 同步 |
| C7 | 审查口径被裁成「只审改动面」 | 审查员按「改了 N 条审 N 条」，全量审计与可用性缺位 | §1 六类无效证据 + §2/§2A 全量 + 本规程「每次发版全量」 |
| C8 | 主控误判「机器名大小写导致通道分裂」 | 拿现象对照当机制证据，没先查资料库 `10-模型路由与派工.md` | §2A 反证四态 + 方法约束（先查库、区分现象与机制、结果字段≠原因字段） |

**使用方式**：每次发版在 `docs/audit-<ver>/summary.md` 里逐条写 C1–C8 的适用性（`PASS` / `N/A` / `FAIL` + 证据路径）。出现新的翻车，就新增 C9 并补一条能兜住它的门。
