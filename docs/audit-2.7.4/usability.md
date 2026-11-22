# 2.7.4 可用性走查（七条路径 × 三态 × 数据翻转）

> 状态说明：真点截图由用户在面板上完成（本机 UI 无法脚本点击仪表盘侧栏）。命令与查询方式在本文件内可直接复现。

| # | 路径 | 空 / 正常 / 畸形 | 数据翻转 | 状态 |
|---|---|---|---|---|
| 1 | 打开「多机调度台」 | 无机器 / 三机在线 / 一台离线 | 评估后数据从无到有 | 待用户截图（UI 走查） |
| 2 | 点「开始评估」 | 无 caps / 正常 caps / 超时 | success→error→重试 | 待用户截图 |
| 3 | 切「对话」再回面板 | 引导卡是否重现 | 兜底记录命中 | 待用户截图 |
| 4 | 派工弹窗（选机器/模型） | 空池 / 有交集 / 每机专属 | model 列表刷新 | D3–D6 已实测（见 dispatch-matrix.md） |
| 5 | 任务详情（note 可操作） | 空 note / 长 note / 对象 note | 失败→重试 | D5/D7 实测 |
| 6 | 配置预览（config-diff） | solo / 多机 / 无权限 | 远程早返回 | 2.7.1 已修，本版未改 |
| 7 | worker 状态卡（drain/resume） | 未开 / 已开 / agentRestrictBroken | 状态切换 | 本版未改 |

## 可复现查询（无需点 UI）

```powershell
# 机器与模型清单（需要 token，见 desktop patch:86）
$h = @{ 'x-board-token' = '<board-token>' }
Invoke-RestMethod 'http://127.0.0.1:<port>/api/board/ui/summary' -Headers $h | ConvertTo-Json -Depth 4
# 期望 nodeModels.gt14/pc2 均非空；defaultModel 可为空
```

## 数据翻转点（本期改动相关）

1. `ident=null` → 评估成功 → 能力条出现（原：抛 TypeError → PanelSafe 降级占位）。
2. 兜底记录存在但 TTL 过期 → 必须重新渲染引导卡（原：永久压制）。
3. caps 变化（换硬件）→ capsDigest 不匹配 → 触发重评（原：永久压制）。