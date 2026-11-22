# 三阶段二次定向复核（stage3b，只核 MC-4 补强）

> 上一轮你判 FAIL，唯一阻断项是「MC-4 半截修复：`ident.caps` 无 null guard，ident=null + success 时 TypeError 被 PanelSafe 吞掉」。主控已按你的最小修法补强。本轮只核这一处，以及补强有没有引入新问题。

## 环境

- `C:\review\after`（已同步补强后的文件）
- 最新指纹：`lib/client.js` = `F5A102B27B00DC8BF3705BC2F7AF56BA5B33F49379075B8365273D5EF3417E16`
  `scripts/client-render-smoke.mjs` = `CF11D19193BD90A56BC2B29BFFC08DD3E33A6376A01138CC0508F53405482919`
  崩溃包不变：`1ED59AF6D5BAA3E19FFDEE66A6E0E0C53D7117D4CFEC105E6420219441DFC0EF`
- 修订记录：`docs/ui-2.7.4/main-control-fixes.md`（末尾「MC-4 补强」一节）

## 补强内容（供你定位，不代替你自己的核验）

1. 新增 `const [assessCaps, setAssessCaps] = React.useState(null)`；评估成功路径 `setAssessCaps((d && d.caps) || null)`。
2. 渲染派生新增 `const capsForBar = (ident && ident.caps) || assessCaps || null`。
3. 能力条渲染体全部改用 `capsForBar`，占位三分支：有 caps → 正常；无 caps 但 `ident` 非 null → 「（清单为空，点右按钮重测）」；`ident === null` → 「评估完成，能力清单待 /identity 刷新」。
4. 冒烟新增 4-7：不注入 ident（默认 null）+ phase 顶成 `success`，断言出现「· 工作能力」与上述占位文案。

## 四问（逐条 PASS/FAIL + 行号）

1. `ident === null && assessPhase === 'success'` 这条路径，现在**是否真的不再抛 TypeError**？把渲染体的表达式与分支逐行列出，证明没有任何一处仍直接访问 `ident.*`。
2. 占位三分支是否互斥且覆盖完整？有没有第四种状态（例如 `ident` 非 null 但 `caps` 与 `assessCaps` 都为 null）会掉进错误分支或空白？
3. `assessCaps` 的写入时机是否只在成功路径？失败/取消/超时会不会把旧 caps 顶成新值（陈旧数据）？切换机器后 `assessCaps` 是否会在 `ident` 换人时造成串台（拿 A 机 caps 显示在 B 机名下）？
4. 新增 4-7 用例是不是真的覆盖了「ident=null」而不是又拿对象冒充？断言是否可能被无关文案误命中？

## 另外两条

- 补强有没有破坏 MC-1（TTL/capsDigest）与故障 B 的兜底合并路径？
- 复跑数字是否一致：smoke **51/51**、负向旧包 **15/40 FAIL exit=1**、单测 **459/459**、pack-check **107 文件 / 1,504,807 B**、scan-h-type 新包 PASS / 旧包 FAIL。

## 结论口径与交付

只允许 `PASS` / `FAIL` / `BLOCKED`（任一 UNKNOWN 即 BLOCKED）；判 FAIL 必须给最小修法 + 行号 + 复跑命令。
写到 `C:\review\after\docs\ui-2.7.4\review-stage3b.md`。写完停下，不要改代码。