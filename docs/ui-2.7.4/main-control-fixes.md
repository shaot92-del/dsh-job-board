# 主控修订记录（MC-1 ~ MC-4）

> 对象：盘古二阶段复核 `review.md`（09:51，74,670 B）§9 结论 FAIL、§13 反证 a/b/c/f、§15「发布前必修最小修法」。
> 修订人：主控（lead）。实施方 patch 未改任何一行，MC 修订只补复核指出的缺口。
> 基线：仓库 `D:\gp_video\dsh-job-board`（HEAD `0380ced`，版本号仍 2.7.3，未 bump）。

## 总览

| 反证 | 等级 | 修法 | 落点 | 复跑证据 |
| --- | --- | --- | --- | --- |
| a：兜底永久压制服务端 needsAssessment | P1（复核定 P0 级） | MC-1 TTL + caps 摘要 | `lib/client.js` | smoke 4-6 / 新增静态锚点 ×2 |
| b：8s 超时误杀慢响应 | P2（复核定 P1 级） | MC-2 超时 8000→15000 | `lib/client.js:321` | smoke 4-2 / 4-4 |
| c：二段 /identity 失败把 success 翻成 error | P1（复核定 P0 级） | MC-3 解耦 catch | `lib/client.js:984` | 新增静态锚点 |
| f：ident=null 时成功也不出能力条 | P2（复核定 P1 级） | MC-4 showAssessBar 分支 | `lib/client.js:938` | smoke 4-5b |

## MC-1 兜底记录加 TTL + 硬件摘要

**反证**：`dsh-assess-done-v1` 一旦写入就永久生效（只按 machine 比对），服务端 `needsAssessment=true`（例如升级了硬件/换了 GPU）永远不会再被采纳 ⇒ 用户被永久按旧评估展示。

**修法**（`lib/client.js`）：
- 新增 `const ASSESS_DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000`（7 天）。
- 新增 `function capsDigest(caps)`：djb2 散列，把 `caps` 里参与评估的字段拼成稳定字符串后取摘要。
- `readLocalAssess(machine, digest)`：`Date.now() - rec.assessedAt > ASSESS_DONE_TTL_MS` 或 `rec.capsDigest && digest && rec.capsDigest !== digest` 时返回 `null`（视为无兜底，恢复服务端权威）。
- 写兜底记录时附 `capsDigest: capsDigest(d.caps)`。
- 两处调用改传摘要：`client.js:906`、`client.js:932`。

**为什么不是「删掉兜底」**：故障 B（GT14 每次进面板重新评估）本质是 `saveIdentity` 写盘失败 + 服务端 `needsAssessment` 永远 true，兜底是降级通道；直接删会让故障 B 复发。

## MC-2 超时 8s → 15s

**反证**：实测存在 8–12s 才返回的慢响应（GEMM/显存探测），8s 必杀，用户看到「评估超时」但其实服务端会成功。

**修法**：`ASSESS_TIMEOUT_MS` 8000 → **15000**（`client.js:321`）；loading 文案随常量走「最长 15 秒」；冒烟断言同步。

## MC-3 二段 /identity 刷新解耦

**反证**：评估成功后代码再拉一次 `/identity` 刷新能力条；若这次请求失败，`catch` 会把 `assessPhase` 从 `success` 改成 `error` ⇒ 用户明明评估成功却看到错误卡。

**修法**：二段请求独立容错 `.then((r) => r.json()).catch(() => null)`（`client.js:984`），失败只让能力条不刷新，不改 `assessPhase`。

## MC-4 无 ident 时也出能力条

**反证**：`ident===null`（identity.json 缺失/读取失败）但本轮评估成功时，原实现 `showAssessBar = !!ident && ...` 为 false ⇒ 不出能力条，用户看不到结果。

**修法**：`showAssessBar = assessedEff || assessPhase === 'success'`（`client.js:938`），去掉 `!!ident` 前置。

## 复跑证据（全部在本机实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check lib/client.js` | exit 0 |
| 冒烟 | `node scripts/client-render-smoke.mjs` | **50/50 PASS** |
| 负向门禁 | `SMOKE_BUNDLE=C:\review\case\lib-client-2.7.0-crash.bak node scripts/client-render-smoke.mjs` | **14/39 FAIL, exit 1**（含 `Minified React error #130 … got: object`） |
| h 类型静态自检 | `node docs/ui-2.7.4/scan-h-type.mjs` | 新包 **0 违规 exit 0**；旧包 **FAIL exit 1**（L3000） |
| 文本规范 | `node scripts/check-text.mjs` | PASSED |
| 插件契约 | `node scripts/plugcheck.mjs` | `tools=18 routes=28` |
| 单测 | `node --test test/worker/*.test.mjs` | **459/459** |
| 打包自检 | `node scripts/worker/pack-check.mjs` | **107 文件 / 1,504,286 B** |

## 仍未闭合（只能实机验收，属 §15 的 2 条 P2）

1. 故障复现实机项：本机面板点「开始评估」是否还会转圈（需重启 DSH 后人工点）。
2. 数据翻转三态实机项：本机 `needsAssessment` 服务端 true + 本地兜底存在时的实际渲染；GT14 反复进出面板是否仍要求重评。
3. 二者都要在 D1–D8 真机矩阵那一轮一并取证（截图留档，写回本目录 `ui-walkthrough.md`）。
## MC-4 补强（三阶段复核 P0 闭合）

三阶段复核（`review-stage3.md`）判 **FAIL**：MC-4 只把 `showAssessBar` 的 `!!ident` 去掉，能力条渲染体仍直接读 `ident.caps`（原 2126 行），`ident===null && assessPhase==='success'` 时抛 `TypeError` → 被 `PanelSafe` 吞成降级占位，用户看不到能力条；且冒烟 4-5 用 `caps:null` 的对象冒充 `ident=null`，没真覆盖。

**补强修法**（`lib/client.js`）：
- 新增 `const [assessCaps, setAssessCaps] = React.useState(null)`（`client.js:839`）；评估成功时 `setAssessCaps((d && d.caps) || null)`（`client.js:979`）。
- 渲染派生新增 `const capsForBar = (ident && ident.caps) || assessCaps || null`（`client.js:943`）。
- 能力条渲染体（`client.js:2132-2150`）全部改用 `capsForBar`，占位文案三分支：有 caps → 正常摘要；无 caps 但 `ident` 在 → 「（清单为空，点右按钮重测）」；`ident===null` → **「评估完成，能力清单待 /identity 刷新」**。
- 冒烟新增 **4-7**：不注入 ident（保持默认 `null`），只把 `assessPhase` 顶成 `'success'`，断言出现「· 工作能力」+「能力清单待 /identity 刷新」。

**复跑（全部重跑）**：smoke **51/51 PASS**；负向旧包 **15/40 FAIL exit=1**；check-text PASSED；plugcheck 18/28；单测 **459/459**；pack-check **107 文件 / 1,504,807 B**；scan-h-type 新包 PASS / 旧包 FAIL。