# 盘古全盘根治扫描（v2.7.4）任务书

> 目标：**不设范围、不计成本**地把 dsh-job-board v2.7.4 从入口到出口读一遍，找出所有真实缺陷与风险，给出根治建议。

## 0 环境
- 仓库：`D:\gp_video\dsh-job-board`（HEAD `dee4e03`，tag `v2.7.4`），Node 24 / ESM / **零运行时依赖**。
- 入口：`lib/index.js`（宿主半边）、`lib/worker/index.js`（worker 半边）、`lib/client.js`（浏览器侧）、`scripts/**`（发布与安装工具链）。
- 可以跑：`node --test test\worker\*.test.mjs`、`node scripts/plugcheck.mjs`、`node scripts/client-render-smoke.mjs`、`node scripts/worker/pack-check.mjs`、`node scripts/check-text.mjs`。
- 禁止：git commit/push、改版本号、改 CHANGELOG、改 `lib/**`（发现问题写报告，不要动手）。

## 1 扫描方式（不要给自己设限）
1. **逐文件通读**：`lib/**`、`scripts/**`、`test/**`、`docs/**` 全部读完再判断；不要只看 diff、不要按「改动面」抽审。
2. **逐入口追踪**：从每个 HTTP 路由、每个工具（`board_*`/`sh_*`/`worker_*`）、每个 worker 状态机分支、每个 UI 交互路径出发，走到最末端。
3. **不计 token**：不要因为「文件大 / 已经看过 / 成本高」跳过；需要反复读同一文件就反复读。
4. 已知事故只作**重点回访区**（不是范围限定）：2.7.0 点派工白屏 React #130、2.7.2 混合树装坏 DSH、2.7.4 团队顶层键被宿主丢弃导致写通道死锁。

## 2 必须回答
- **能不能发**（npm 2.7.4 现在可不可发）；若不可发，列出阻断项。
- **根因链**：每条问题写到「哪个函数 + 哪一行 + 为什么」。
- **反证**：对你给出的每条「没问题」结论，也要写「如果它有问题会表现成什么样、我怎么排除的」。
- **漏网点**：哪些路径你认为**没有测试覆盖且无法被现有门禁抓出来**（这类最有价值）。

## 3 交付
写到 `docs/audit-2.7.4/pangu-full-scan.md`：
1. 结论（可发 / 修完再发 / 阻断）
2. 问题清单：按 P0–P3 分级，每条 = 文件:行号 + 现象 + 复现命令或推理链 + 修法 + 证据类型（已证实/推测）
3. 反证清单
4. 已排除项（列你查过但认为没问题的区域，并给理由）
5. 建议补的测试（具体到用例名）

## 4 纪律
- 结论词汇只用：PASS / FAIL / BLOCKED。
- 区分「已证实」与「推测」；推测必须标注。
- 写文件用 LF、UTF-8 无 BOM。