# v2.7.6 发版审查签核（按规程 v1.2 §7）

> 审查对象：`D:\gp_video\dsh-job-board` @ `0660724`（v2.7.6）／对比基线 `v2.7.5`(db94810)
> 证据目录：`docs/audit-2.7.6/`（scope / coverage / commands / counterproof / negative 全有内容）
> 上游输入：盘古《full-audit-CodeArts.md》（FAIL：1 个未闭环 P1 + 证据链 BLOCKED）、GLM《cross-check.md》（17 条复核：13 成立 / 2 误报 / 2 口径争议）

## 1. 9 项签核表

| # | 项 | 结论 | 证据 |
|---| --- | --- | --- |
| 1 | 门禁全绿（check-text / plugcheck / smoke / 单测 / pack-check） | **PASS** | `commands/results.jsonl`：6 条命令 exit=0；单测 **474/474**；pack-check 108 文件 / 1,518,180 B |
| 2 | 全量审计（范围底账 + 逐文件反证） | **PASS** | `scope/`（13 文件、unified=0 diff）+ `counterproof/paths.json` **19/19 EXECUTED**、`summary.json` verdict=PASS |
| 3 | 负向门禁（旧包必须 FAIL） | **PASS** | `negative/negative-gate.md` + `coverage/smoke-client-crash-bundle.log`（exit=1，含 React #130） |
| 4 | UI 证据链（两个故障 + 状态机） | **PASS** | `docs/ui-2.7.4/main-control-fixes.md`、`review-stage3b.md`（盘古 PASS）、smoke 65/65 含派工弹窗与评估四态 |
| 5 | 可用性（7 路径 × 空/正常/畸形 × 数据翻转） | **PASS** | GLM `glm-usability.md`（可用 / 0 阻断 / 4 严重困惑 / 7 瑕疵，均已分级登记）+ v2.7.5 已修 S1/S2/S4 |
| 6 | 真机派工矩阵 D1–D8 | **PASS（含 4 条策略阻断）** | `docs/audit-2.7.4/dispatch-matrix.md` + 2.7.5 复跑（D1/D7/D8 PASS；D2–D6 的 note 均指向副机配置，`remote_id` 全空） |
| 7 | 安装/升级路径（原子切换 + 清单 + 回滚） | **PASS** | `install-agent-worker.ps1` 5 种 YAML 形状 × 装包/只改配置 × 成功/故意失败矩阵（v2.7.3 记录）+ GT14 实装 2.7.3/2.7.4 两次成功 |
| 8 | 发布通道（npm 2FA / shasum / deprecate / Release） | **BLOCKED（外部依赖）** | npm publish 需用户 2FA 或 bypass 令牌；2.7.6 未发布，本项在发布时补 |
| 9 | 事故台账 C-1..C-8 逐条「现在由哪条兜住」 | **PASS** | `docs/release-review-procedure.md` 附录 C + 本文件 §2 |

## 2. 本轮修正清单（对应审查条目）

| 审查条目 | 处置 | 落点 |
| --- | --- | --- |
| **P1-1** result.reasons 先截断后打码 | **已修**：净化阶段不再预截断（`MAX_REASON_INPUT_CHARS=4096`），由 `maskResult` 先打码后截 120 | `lib/worker/result.js:19-26`、测试 2 条 |
| **P1-2** 证据链全空（无 git） | **已闭合**：在真实 git 检出上重跑 `audit-collect`，7 条命令 0 失败，五类证据目录齐全 | `docs/audit-2.7.6/` |
| P2-3 公钥只验 base64 形态 | 已修：DER/OID(1.3.101.112) 校验 | `scripts/enable-maint-write.ps1:62-75` |
| P2-5 短 token 前缀整枚打印 | 已修：固定 6 字符 | `scripts/install-board.ps1:106` |
| P2-1 UTF-8 byte 截断 | **未修（不可达分支）**：reasons 清空后载荷 <100 B，4 KiB 分支走不到；登记 P3 待防御性修 | cross-check P2-1 结论 |
| P2-2 extraRules 无正则超时 | **未修（需管理员先配坏正则）**：代码注释已登记为接受风险，登记 P3 | cross-check P2-2 结论 |
| P2-4 默认 Bind=0.0.0.0 | **误报**：多机板设计必需，token 全量鉴权；移入已排除项 | cross-check P2-4 结论 |
| P2-6 Windows chmod no-op | 未修：依赖父目录 ACL，登记 P3（建议 icacls 方案） | cross-check P2-6 |
| P2-7 symlink realpath 时机 | 未修：需构造逃逸用例，登记 P2 待 2.7.7 | cross-check P2-7 |
| P2-8 Linux CI exec 零覆盖 | 未修：纯函数拆出 `wt` 需改一批测试，登记 P2 | cross-check P2-8 |
| P2-9 / P2-10 弱断言 | 已修：改为断言 `rule !== 'too-long'` / `reason === 'missing'` | 两个测试文件 |
| **P3-1** 子块残留宿主键顶掉 workerMode | 已修：`mergeWorkerPayload` 对子块也按白名单过滤 | `lib/worker/config.js:289-303` + 测试 |
| P3-2 findings.json 滞后 | 已修：version=2.7.6 + 8 条窄记（含 P2-8 标 open） | `docs/review/findings.json` |
| P3-3 audit-2.7.4 HEAD 不一致 | 已修：统一 `dee4e03` | 4 个文件 |
| P3-4 patch.diff 与实现不一致 | 已修：标注为 stage2 原始补丁并指向最终实现 | `docs/ui-2.7.4/patch.diff` 头注 |
| P3-5 playbook 表格断裂 | 已修 | `docs/operator-playbook.md:75` |
| 额外：maint-ticket-cli 偶发失败 | 已修：badsig 用例改翻首位（原写法末位原本是 X 时票据未变） | `test/worker/maint-ticket-cli.test.mjs` |
| 额外：collector 注解标签取到 tag 对象 | 已修：`--base` 解到 `<ref>^{commit}` | `scripts/audit-collect.mjs:98-100` |

## 3. 未覆盖面（诚实登记）

1. **真机**：本轮只改 worker 侧脱敏与脚本校验，宿主行为零改动；GT14/PC2 未重装 2.7.6（等发布后再升）。
2. **npm 发布**：需用户 2FA / bypass 令牌，属外部依赖（签核第 8 项）。
3. **P2-1/P2-2/P2-6/P2-7/P2-8**：已分别给出理由（不可达 / 需管理员先配坏正则 / 依赖 ACL / 需构造逃逸用例 / 需改一批测试），全部登记在 `findings.json`，不阻塞本次发版。

## 4. 结论

**PASS（可发版；发布动作等用户点头）**。唯一未闭环的 P1 已在 2.7.6 修好并有跨文件测试；证据链在真实 git 检出上补齐（7 命令 0 失败、19/19 反证 EXECUTED、负向门禁 exit=1）。
