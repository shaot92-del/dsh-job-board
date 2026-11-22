# 三阶段复核结论（汇总）

| 阶段 | 文件 | 结论 | 关键内容 |
| --- | --- | --- | --- |
| stage1（基线） | `review.md`（09:02，32,715 B） | BLOCKED | patch 未交付，枚举 59 useState / 7 useEffect / 32 fetch / 31 分支；门禁基线全绿 |
| stage2（实施方 patch） | `review.md`（09:51，74,670 B） | **FAIL** | 2 P0 + 2 P1：a 兜底永久压制、c success 被 error 覆盖、b 8s 误杀、f ident=null 不出条 |
| stage3（MC-1~4） | `review-stage3.md`（10:00，20,993 B） | **FAIL** | MC-1/2/3 PASS；MC-4 半截修复（2126 `ident.caps` 无 null guard，ident=null+success 抛 TypeError 被 PanelSafe 吞）|
| stage3b（MC-4 补强） | `review-stage3b.md`（12:07，22,114 B） | **PASS** | 四问全 PASS：渲染体无一处直接访问 `ident.*`、四状态互斥完整、assessCaps 只在成功路径写、4-7 真覆盖 null-ident、MC-1/故障 B 未被破坏、6/6 复跑数字一致 |

**结论**：三阶段复核（含一次回退修复）**通过**，可以进入 D1–D8 真机矩阵与发布收口。

## 最终实现要点（改动仅两文件）

- `lib/client.js`（196,197 B）：`assessPhase` 四态状态机；`AbortController` + **15s** 超时；error 卡重试 / loading 卡取消；`dsh-assess-done-v1` 兜底（**7 天 TTL + capsDigest 硬件摘要**）；二段 `/identity` 解耦 catch；`assessCaps` + `capsForBar` 三分支占位（ident=null 时显示「评估完成，能力清单待 /identity 刷新」）。
- `scripts/client-render-smoke.mjs`（30,527 B）：严格假 React（非法 type 抛 #130、对象 child 抛 #31）；评估链路 4-1~4-7 七组用例；新增静态锚点（TTL、capsDigest、identity 解耦）。冒烟 **51/51**，负向旧包 **15/40 FAIL**。

## 门禁快照

`check-text` PASSED（含新文档）· `plugcheck` 18 工具 / 28 路由 · smoke **51/51** · 单测 **459/459** · pack-check **107 文件 / 1,504,807 B** · `scan-h-type` 新包 PASS / 旧包 FAIL。