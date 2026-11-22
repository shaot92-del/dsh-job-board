# GLM 可用性全量测评（v2.7.4）任务书

> 目标：以**真实使用者**视角把「多机调度台」面板用一遍，找出所有让人卡住、误解、白屏、数据不刷新、说明缺失的地方。**不计 token、不计成本**，宁可多报。

## 0 材料
- 仓库：`D:\gp_video\dsh-job-board`（tag `v2.7.4`）。UI 代码在 `lib/client.js`，UI 评审历史在 `docs/ui-2.7.4/`（design.md / patch.diff / main-control-fixes.md / review-summary.md）。
- 规程：`docs/release-review-procedure.md` §3（UI 渲染证据链）、§5（可用性走查）、`docs/release-work-instruction.md` WI-001 的 D1–D8 真机矩阵。
- 现状事实：本机 DSH `doctor version=2.7.4`；GT14 已 2.7.4 且写通道已开；面板入口是侧栏「多机调度台」。

## 1 要走完的路径（每条都要写期望 vs 实际）
1. 首次打开面板（有无引导卡 / 能力条 / 加载态）
2. 点「开始评估」（进度、超时、失败重试、取消）
3. 评估成功后切走再回来（是否重复引导）
4. 派工弹窗：选机器、选模型（自动/每机专属/不在清单）、提交
5. 任务列表：待办/进行/完成/打回筛选，note 可读性（尤其 `agent-approval-required`、`agent-not-allowlisted`、`maint-write-disabled`）
6. worker 状态卡：drain/resume、agentRestrictBroken
7. 配置预览 config-set（同机 / 跨机 / 无权限）
8. 窄屏（≤1100px / ≤900px）布局与折叠

## 2 每条都要判断三种状态
空数据 / 正常数据 / 畸形数据（字段缺失、数组为空、对象被字符串化、note 超长、模型清单为空）。

## 3 交付
写到 `docs/audit-2.7.4/glm-usability.md`：
1. 总评（可用 / 有阻塞 / 不可用）+ 一句话结论
2. 路径 × 状态矩阵表（期望 / 实际 / 判定 可用or问题）
3. 问题清单：按「阻断使用 / 严重困惑 / 体验瑕疵」三档，每条给：出现在哪个组件与行号、用户会怎么误解、建议改法
4. 针对 2.7.5 的最小改进清单（≤10 条，按性价比排序）
5. 你认为**必须补的 UI 冒烟用例**（具体断言）

## 4 纪律
- 不设想不存在的功能；只评当前 v2.7.4 行为。
- 结论必须可核对：引用真实行号或真实返回字段。
- 写文件用 LF、UTF-8 无 BOM。