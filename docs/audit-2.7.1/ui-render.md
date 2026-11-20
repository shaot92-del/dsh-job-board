# 2.7.1 UI 渲染证据链

> 触发原因：2.7.0 派工弹窗外层 `h()` 缺 `'div', null`、模型行缺一层 `h()` ⇒ React #130 整槽白屏。
> 判定依据：`docs/review/ui-render-review-standard.md`（Kimi 版本，合并中）。

## 1. 受影响子树

```
main slot → Panel → DispatchDialog（ask===true）
  ├─ 类型行（agent / exec / maint）
  ├─ maint 票据区（diffRes：本地 / 远程）
  ├─ 模型行（pool 非空 / 空池置灰项 / 自动档分组）
  └─ 提交按钮 + 错误提示（asText 归一）
```

## 2. 状态矩阵（必须实测，不得只算默认态）

| # | 用例 | 初始状态 | 断言 | 结果 |
|---|---|---|---|---|
| UI-01 | 默认面板 | `ask=false` | 标题/版本 pill/机器卡/任务列表正常 | ✅ 冒烟覆盖 |
| UI-02 | 派工弹窗（有默认模型） | `ask=true`、`defaultModel` 非空 | 类型行 + 模型行合法渲染 | ✅ 冒烟（29 项内） |
| UI-03 | 正常模型池 | `ask=true`、`nodeModels` 双机 | 交集项 + 各机专属分组 | ✅ 冒烟 |
| UI-04 | 空模型池 | 无清单、无默认 | 模型行显示置灰项「该机器未上报模型清单（跟随默认）」 | ✅ 冒烟（恒渲染断言） |
| UI-05 | exec 分支 | `taskMode='exec'` | 分支正确、无非法元素 | ⏳ 待补用例 |
| UI-06 | maint 本地 diff | `diffRes.remote=false` | `changesList` 渲染 | ⏳ 待补用例 |
| UI-07 | maint 远程 diff | `diffRes.remote=true` | `note` 文本化 + 远程提示 | ⏳ 待补用例 |
| UI-08 | 创建失败 | `/create` 返回 `ok:false` + 对象 `error` | `asText` 归一，面板不白屏 | ⏳ 待补用例 |
| UI-09 | 异常字段 | error/note/why 为对象 | 不产生 #31 | ✅ `asText` 9 处 + 假 React 严格校验 |
| UI-10 | 生产宿主 | 真实 DSH + 生产 React | click-through 无 slot crash | ⏳ 需重启 DSH 后执行 |

## 3. 严格渲染证据（离线门禁）

```text
$ npm run smoke:client
ok  client-render-smoke：29/29 项通过    exit=0
```

假 React 规则：`type` 只接受 string/function/symbol，对象一律抛 `#130`；普通对象作 child 抛 `#31`。

## 4. 负向证明（旧版必须 FAIL）

```text
$ $env:SMOKE_BUNDLE='…\case\lib-client-2.7.0-crash.bak'; node scripts/client-render-smoke.mjs
FAIL  派工弹窗渲染不抛错（2.7.0 此处 #130）
      Minified React error #130: expected a string … but got: object
exit=1（3/26 项不通过）
```

完整输出见 `negative-gate.txt`。

## 5. 生产宿主 click-through（待执行）

1. 重启 DSH（当前进程 2.6.29，磁盘 2.7.1）。
2. DevTools → Console 勾 Preserve log。
3. 打开面板 → 点「派工」→ 选机器 → 选模型 → 确认 → 等 summary 刷新。
4. 记录：弹窗是否正常、模型下拉是否有内容、确认后是否关窗并刷新、控制台错误数。
5. 截图 + 控制台导出存 `docs/audit-2.7.1/shots/`。

**未执行前本节结论为 `BLOCKED`，不得写 PASS。**
