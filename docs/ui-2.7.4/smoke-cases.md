# dsh-job-board UI 2.7.4 —— 冒烟用例清单与断言

- 对象：`scripts/client-render-smoke.mjs`（新增第 4 轮，改后共 47 项断言）
- 运行：`node scripts/client-render-smoke.mjs`（exit 0 = 全过；exit 1 = 存在 FAIL）
- 负向门禁：`SMOKE_BUNDLE=<旧包路径>` 跑同一脚本，**必须 exit 1**
- 全部行号为改后行号：`client.js:NNN` / `client-render-smoke.mjs:NNN`

---

## 1. 新增用例总表

### 1.1 无条件静态断言（smoke.mjs:457-462）——负向门禁的爪子

对任意 bundle 都执行。旧 bundle（`case/lib-client-2.7.0-crash.bak`）在这 6 条上 **全部 FAIL**（2026-11-22 实测，见 §3）。

| # | 用例名 | 断言 | 抓什么 |
|---|---|---|---|
| S1 | 评估请求有 8s 客户端超时 | `RAW.includes('const ASSESS_TIMEOUT_MS = 8000')` | 旧包裸 fetch 无超时（故障 A 根因） |
| S2 | 评估 fetch 带 AbortController | `RAW.includes('new AbortController()') && RAW.includes('signal: assessAbortCtl')` | 超时必须真的能中止请求，不只是文案 |
| S3 | 超时/失败有专属错误卡且给「重试」出口 | `RAW.includes('dsb-assess-retry') && RAW.includes('评估超时')` | 永久转圈无出口（故障 A 症状） |
| S4 | 评估成功写本机兜底记录 | `RAW.includes("ASSESS_DONE_KEY = 'dsh-assess-done-v1'")` | 旧包评估结果零本机记忆（故障 B 根因） |
| S5 | 写盘失败降级只提示一次 | `RAW.includes("ASSESS_DEGRADE_NOTIFIED_KEY = 'dsh-assess-degrade-notified-v1'") && RAW.includes('不再重复弹出')` | 硬要求「第一次提示、之后不重复弹」 |
| S6 | 评估卡按 phase 四态渲染 | `['loading','error','success','idle']` 四个比较都存在于 RAW | 四态齐全（硬要求） |

### 1.2 渲染态用例（smoke.mjs:478-509）

锚点注入（ident / assessPhase / assessErr 初始 state），每条独立渲染一棵元素树后对 `flattenText` 断言。

| # | 用例（smoke.mjs 行号） | 注入 | 断言 |
|---|---|---|---|
| A0 | 评估卡测试锚点存在（:480） | — | `IDENT_ANCHOR` 可注入（旧包此处 FAIL 会被记录） |
| 4-1 | 引导态（:485） | `ident={machine:'GT14', needsAssessment:true, assessed:false}` | 树里有「开始评估」按钮 + 「还没做过工作能力评估」文案 |
| 4-6 | **本机兜底 / 数据翻转（:491，故障 B 主场景）** | 同上 + localStorage 种子 `dsh-assess-done-v1={"machine":"GT14","assessedAt":1763712000000}` | 树里**没有**「还没做过工作能力评估」，**有**「· 工作能力」能力条 ⇒ 面板重挂不再要求重评 |
| P0 | 评估 phase 锚点存在（:497） | — | `PHASE_ANCHOR` 可注入（旧包必 FAIL） |
| 4-2 | loading 态（:502） | `assessPhase='loading'` | 有「最长 8 秒」文案（转圈有时限承诺）+ 有「取消」按钮 |
| 4-3 | error 态（:509） | `assessPhase='error'`, `assessErr='评估超时（8 秒），可重试'` | 有「评估没有完成」标题 + 「重试」按钮 |

### 1.3 交互链用例（可重渲染假 React，smoke.mjs:511-578）

假 React 升级：`useState` setter 真实写入状态槽位（smoke.mjs:81-93），`rerender()` 重调组件复用 hook 状态（smoke.mjs:253-257），`flushTimers()` 手动触发 deferTimeouts 排队的定时器（smoke.mjs:258-268）。沙箱注入 `AbortController`（smoke.mjs:117），fetch 桩模拟真 fetch 的 abort 行为：`signal.aborted ⇒ reject(AbortError)`（smoke.mjs:517-522）。

| # | 用例（smoke.mjs 行号） | 场景 | 断言 |
|---|---|---|---|
| 4-4a | 交互链起点（:537） | ident=needsAssessment:true；`fetch('/assess') 永不返回`（故障 A 场景） | 能找到「开始评估」按钮 |
| 4-4b | 点评估进 loading（:541） | 调 `btn.onClick()` 后 rerender | 有「不会一直转圈」文案（loading 卡承诺） |
| 4-4c | **超时出口（:546，故障 A 主场景）** | flushTimers() 触发 8s 定时器 → AbortController.abort() → 桩 reject(AbortError) → catch | `flushed>=1` 且树里有「重试」按钮 + 「评估超时」文案 ⇒ **旧版此处永久转圈，新版必然停机并给出口** |
| 4-5a | 成功链起点（:567） | fetch 桩：assess 返回 `{ok:true,machine:'GT14',summary:'首次评估完成 GT14'}` | 能找到「开始评估」按钮 |
| 4-5b | 成功反馈（:572） | 点击后等微任务链落定 rerender | notice 出现「首次评估完成 GT14」+ 引导卡消失 |
| 4-5c | **成功写兜底（:574，故障 B 客户端补丁）** | 同上 | `localStorage['dsh-assess-done-v1']` 含 `"machine":"GT14"` |

---

## 2. 用例 ↔ 边界态 ↔ 故障 映射

| 边界态（design.md §4） | 用例 | 对应故障 |
|---|---|---|
| loading（8s 硬顶 + 可取消） | 4-2、4-4b | A |
| timeout（超时给可重试提示） | 4-4a→4-4b→4-4c 全链 | A |
| error（服务端拒绝/网络/非 JSON） | 4-3 | A |
| success | 4-5a→4-5b | — |
| success 后本机兜底 | 4-5c | B |
| 数据翻转 needsAssessment true→false→true | 4-6 | B |
| 引导态（empty 分支） | 4-1 | — |
| 静态防线（四态齐全/超时常量/一次性提示） | S1–S6 | A、B |

回归保障：第 1–3 轮原有断言（版本 pill、header 收容、doctor 三态、派工弹窗 #130 回归、负向 #130 同型）全部保留且继续通过（47 项里占 30 项）。

---

## 3. 实测记录（2026-11-22）

### 3.1 新 bundle：PASS，exit 0

```
PASS  client-render-smoke：47/47 项（插件 v2.7.3 常显于面板标题区）
```

新增 13 项（S1–S6、A0、4-1、4-2、4-3、4-4a/b/c、4-5a/b/c、4-6、P0）全部 ok。

### 3.2 旧 bundle（case/lib-client-2.7.0-crash.bak）：FAIL，exit 1（负向门禁达成）

```
FAIL  派工弹窗渲染不抛错（2.7.0 此处 #130）  — Minified React error #130 …
FAIL  评估请求有 8s 客户端超时（ASSESS_TIMEOUT_MS=8000）
FAIL  评估 fetch 带 AbortController（signal 传入，超时可中止）
FAIL  超时/失败有专属错误卡且给「重试」出口
FAIL  评估成功写本机兜底记录（dsh-assess-done-v1）
FAIL  写盘失败降级只提示一次（dsh-assess-degrade-notified-v1 + 「不再重复弹出」）
FAIL  评估卡按 phase 四态渲染（idle/loading/success/error）
FAIL  4-6 本机兜底：服务端 needsAssessment=true 但有兜底 ⇒ 显示「工作能力」条而非引导卡（重挂不再要求重评）
FAIL  评估 phase 锚点存在（v2.7.4 才有；旧 bundle 此处必 FAIL）
FAIL  client-render-smoke：11/36 项不通过
```

- 11/36 不通过：含 #130 原崩溃（第 3 轮）+ **全部 6 条新静态断言** + 兜底用例 4-6（旧包没有兜底派生 ⇒ 引导卡照样弹出，正是故障 B 的行为）+ phase 锚点。
- 结论：新用例既能抓旧故障（A：无超时/无出口；B：无兜底），也保留了对 #130 的原有抓捕。

### 3.3 h() 首参静态扫描（docs/ui-2.7.4/scan-h-type.mjs）

| 对象 | 结果 |
|---|---|
| `lib/client.js`（新） | 336 处 `h(...)`，全部 string-literal，**0 违规，PASS exit 0** |
| `case/lib-client-2.7.0-crash.bak`（旧崩溃包） | 312 处中 **1 违规：L3000 `h(h('div',…))`** —— 正是 2.7.0 派工弹窗 #130 白屏的真实崩溃点，exit 1 |
