# dsh-job-board UI 2.7.4 —— 三轮自审

- 自审对象：`lib/client.js`（改后 3555 行）、`scripts/client-render-smoke.mjs`（改后 588 行）、`docs/ui-2.7.4/*`
- 基线：v2.7.3（commit `0380ced`）
- 行号约定：未标注者为**改后**行号；标注「基线」者为 2.7.3 改前行号
- 结论先行：**自审 PASS，可交付**。发现并在本轮内修正 1 处文档与实现不一致（success 态呈现方式，见 R2-①）；遗留 1 条无法在客户端消除的边界（双存储同时失败，见 R2-④），已列为服务端后续建议。

---

## 第一轮：逐分支枚举（新增/改动代码全部分支）

### 1.1 模块级工具（client.js:311-358）

| 分支 | 行号 | 判定 |
|---|---|---|
| `lsGet`：localStorage 可用 / 抛异常 | 323-329 | ✅ 异常返回 null，不向外抛 |
| `lsSet`：写入成功 / 抛异常（隐私模式、配额满） | 331-338 | ✅ 返回 false，静默降级 |
| `lsDel`：删除 / 抛异常 | 340-347 | ✅ 静默 |
| `readLocalAssess`：raw 为空 / JSON 坏 / machine 不匹配 / assessedAt≤0 / 正常 | 348-357 | ✅ 前四种一律返回 null（换机不冒充），仅完全匹配才返回记录 |
| `ASSESS_TIMEOUT_MS=8000`（:319）、两把 key（:320-321） | — | ✅ 与冒烟 S1/S4/S5 断言一一对应 |

### 1.2 /identity 轮询合并（client.js:871-903，原基线 818-833）

| 分支 | 行号 | 判定 |
|---|---|---|
| 组件已卸载（`!alive`） | 877 | ✅ 与基线一致，不 setState |
| 响应非 ok | 877 | ✅ 不动 ident（基线行为） |
| `needsAssessment=true` + 本机兜底 + **未提示过** | 880-888 | ✅ 提示一次（885）→ 写「已提示」标记（884）→ 合并为已评估（887）→ return（888） |
| `needsAssessment=true` + 本机兜底 + **已提示过** | 880-888 | ✅ 跳过 883-886，直接合并 —— 满足「第一次提示、之后不重复弹」 |
| `needsAssessment=true` + 无兜底（首次使用/换机/无 localStorage） | 880,889-894 | ✅ 原样 `setIdent(d)`，引导卡照弹（评估没做过就该弹） |
| `needsAssessment=false`（档案恢复正常） | 890-893 | ✅ 清「已提示」标记：下次写盘再失败还能提示一次，不是永久静音 |

### 1.3 渲染期派生（client.js:905-912）

| 派生量 | 因子 | 判定 |
|---|---|---|
| `assessLocal`（:907） | ident 为 null → null | ✅ 空态不查 localStorage |
| `needsAssessEff`（:908） | needsAssessment ∧ ¬assessHidden ∧ ¬稍后(按机器) ∧ ¬兜底 | ✅ 四个否决因子各自独立，任意一个成立就不弹卡 |
| `assessedEff`（:909） | (服务端 assessed ∨ 兜底) ∧ ¬assessHidden | ✅ |
| `assessAtShown`（:910） | 服务端 assessedAt 优先，兜底次之 | ✅ 显示时间在两种来源下都成立 |
| `showAssessBar`（:912） | assessedEff ∨ (phase=success ∧ ident) | ✅ success 是过渡态，能力条立即可见（success 期间忽略 assessHidden —— 见 R2-①） |

### 1.4 runAssess / cancelAssess（client.js:914-994）

| 分支 | 行号 | 判定 |
|---|---|---|
| loading 中重复触发 | 917 | ✅ 直接 return，无并发请求 |
| 服务端明确拒绝（`d.ok===false`，含 HTTP 502 的 JSON body） | 941-946 | ✅ error 卡 + 原因 + 「重试」文案；`setAssessHidden(false)` 让卡可见 |
| 成功 | 947-952 | ✅ phase=success（947）、notice=summary（948）、**写兜底**（950，仅 `d.machine` 存在时）、能力条可见（951 + 912 的 success 分支） |
| 成功后二段 /identity 失败（`i.ok` false） | 954-960 | ✅ 不覆盖 ident，只 `setTick`；能力条由 success 分支 + 950 的兜底维持 |
| 成功后 /identity 返回 needsAssessment=false | 956-957 | ✅ 清「已提示」标记 + 刷新 ident（档案真的写进去了） |
| catch：**主动取消** | 961-967 | ✅ `aborted && assessCancelRequested` → 静默返回，不进错误卡 |
| catch：**8s 超时**（AbortError） | 968-974 | ✅ 错误卡，文案含「评估超时（8 秒）」+「可点重试」 |
| catch：网络错 / 非 JSON / 其他异常 | 968-974 | ✅ 错误卡，原文信息透出 |
| 收尾（成功/失败/超时/取消都走） | 976-979 | ✅ `clearTimeout`（不泄漏定时器）+ `assessAbortCtl=null` |
| cancelAssess | 981-994 | ✅ 置取消标记 → abort → 置 idle/清错/清 notice；timer 回调里 `assessAbortCtl` 已为 null，二次 abort 无害 |
| AbortController 不存在（老宿主） | 922,937 | ⚠️ 退化为无超时（=2.7.3 行为），不抛错。现代浏览器/Node 16+ 均有，可接受 |

### 1.5 评估卡渲染（client.js:1978-2117）

| 分支 | 行号 | 判定 |
|---|---|---|
| loading 卡 | 1980-2002 | ✅ 明示「最长 8 秒 / 超时会自动停下」+「取消」按钮（`dsb-assess-cancel`） |
| error 卡 | 2003-2037 | ✅ 标题「评估没有完成」+ 原因 + 「重试」（`dsb-assess-retry`）+「关闭」（回 idle） |
| 引导卡（idle） | 2038-2069 | ✅ 原文案保留；「开始评估」disabled 接 phase；「稍后」**按机器记**（2058-2062） |
| 能力条 | 2070-2117 | ✅ 原结构保留；评估时间取 `assessAtShown`（2109，兜底来源也显示）；「重新评估」disabled 接 phase |
| null（其余） | 2118 | ✅ ident 未拉到/区域收起 → 整块不渲染（空态语义与基线一致） |

### 1.6 冒烟脚本（client-render-smoke.mjs）

| 改动 | 行号 | 判定 |
|---|---|---|
| 假 React setter 真实生效 + `__resetHooks` | 81-99 | ✅ 首渲行为与旧版一致（`i >= states.length` 才取 init） |
| 沙箱 opts（fetch/deferTimeouts/localStorage/AbortController） | 94-176 | ✅ 不传 opts 时与旧行为逐字段一致（默认 fetch 桩、setTimeout 立即执行、localStorage 空表） |
| `renderOnce` 返回 `rerender/flushTimers` | 200-271 | ✅ |
| 6 条静态断言 S1-S6 | 457-462 | ✅ 无条件执行 —— 旧包必 FAIL |
| 交互用例 4-4/4-5 | 511-578 | ✅ fetch 桩模拟真 abort 语义（517-522：`signal.aborted ⇒ reject(AbortError)`），否则测不出超时 |

---

## 第二轮：反证（假设自己是错的，找反例）

### R2-① 「success 收起区域」与「能力条常显」哪个对？——发现并修正文档

反证尝试：假设 design.md 最初写的「success → 收起区域」正确。反例：成功后能力条消失，用户看不到刚测出的 CPU/内存/GPU 清单，只能凭 notice 一行字 —— 与「评估结果立即可见」的 UI 目标矛盾；且 2.2.0 引入的 `assessHidden` 语义是「用户主动收起」，评估成功不等于用户想收起。**结论：实现（能力条常显，client.js:912）是对的，文档错了** —— design.md §3.2/§3.3/§4 三处已同步修正。这是本轮自审抓出的唯一实质性不一致。

### R2-② 8s 定时器会不会误杀慢而成功的响应？

反例构造：服务端 t=7.9s 返回。链路：resolve → `.then` 设 success → 收尾 `clearTimeout`（977）在定时器触发前执行 → 定时器不再 fire。若恰在 t=8s 边界：响应先 resolve，abort 作用于已 settled 的 controller，无任何效果（AbortController 规范保证）。**无反例，PASS。**

### R2-③ 取消会不会仍弹错误卡？

反例构造：t=1s 点「取消」→ abort → catch 里 `aborted=true` 且 `assessCancelRequested=true`（982 早于 abort 执行）→ 静默（964-967）。反例二：点「取消」时响应已到达（cancel 与 then 竞态）→ then 继续走 success —— 评估确实成功了，呈现 success 能力条，语义成立。**PASS**（竞态结果语义合理，已记录）。

### R2-④ localStorage 与服务端写盘**同时**失败 → 故障 B 是否复发？

是。两个存储都不可用时客户端无第二事实源可退（诚实边界）。触发条件为「隐私/受限模式 + 服务端 identity 写盘失败」同时发生，概率极低，且此时行为退化为 2.7.3（引导卡弹出，可评估可「稍后」，无崩溃）。**根治只能靠服务端**（见第三轮「遗留建议」）。**已知限制，不阻塞交付。**

### R2-⑤ 换机/改名后旧兜底冒充新机器的评估？

`readLocalAssess`（348-357）machine 严格 `String` 全等比对，不匹配返回 null → 引导卡正确弹出。反例不成立。**PASS。**

### R2-⑥ 「一次性提示」会不会变成「永不提示」或「每次都提示」？

- 每次都提示？不会：883 行 `lsGet` 命中标记就跳过 setNotice。
- 永不提示？不会：890-893 在服务端档案恢复（needsAssessment=false）时清标记，下一次写盘失败重新获得一次提示机会。**两个反例都被代码否定，PASS。**

### R2-⑦ 15s 轮询会不会把 success 能力条打回引导卡？

两条保险：轮询合并路径（880-888）把 needsAssessment 合并掉；即使合并路径没跑（标记丢失等），`showAssessBar` 的 success 分支（912）兜住。4-6 用例覆盖此翻转。**PASS。**

### R2-⑧ 可重渲染假 React 会不会 hooks 错位？

Panel 的 useState 全部在函数体顶层无条件调用（与真实 React 的规则同源，否则真浏览器也会崩）；`__resetHooks` 按调用序复用槽位。实测 47/47 通过、旧包渲染不抛错。**PASS。**

### R2-⑨ AbortError 跨 realm 判定失效？

vm context 里的 Error 与宿主不同 realm，`e.name` 仍是字符串属性可比；再加 `msg.indexOf('abort') >= 0` 双判（963）。4-4c 用宿主真 AbortController 实测通过。**PASS。**

### R2-⑩ 版本号/禁改文件被误动？

`git diff --stat` 仅 2 个文件（lib/client.js、scripts/client-render-smoke.mjs）；`grep CLIENT_VERSION` 仍为 `2.7.3`（client.js:42）；package.json / CHANGELOG.md / lib/index.js 零改动。**PASS。**

### R2-⑪ patch.diff 会不会应用不上或应用错？

独立临时目录：从 D 盘 pristine 源（同 commit `0380ced`）复制两个文件 → `git apply patch.diff` exit 0 → SHA256 与工作副本**逐字节一致**（client.js 与 smoke.mjs 均 identical=True）。**PASS。**

### R2-⑫ 复核方确认的两处机制，修复是否同时覆盖三项要求？

针对复核确认的 ① `assessHidden` 局部 state 重置（基线 `client.js:759`）与 ② `runAssess` 链尾 finally 在 /assess 无响应时不执行（基线 `:835-857`），逐项核验（完整映射表见 design.md §2.5）：

- **超时兜底**：8s 定时器 `abort()` 强制链落定 ⇒ 链尾清理段（改后 `client.js:976-979`）在全部五条路径（成功/服务端拒绝/超时/取消/网络错）必然执行；phase 机不存在无出口的 loading。反例尝试：构造「abort 与 resolve 竞态」「取消与超时竞态」——分别被 AbortController settled 无副作用语义（R2-②）与 `assessCancelRequested` 仲裁（R2-③）否定。**PASS**。
- **成功后两个 state 都落定**：`needsAssessment` 走三重保证（兜底 `:950` + 二段 /identity `:952-958` + 合并派生 `:880-888`/`:907-912`）；`assessHidden` 成功路径显式 `setAssessHidden(true)`（`:951`），且其重挂重置（复核①）被兜底机制消化——重挂后 `assessHidden=false` 但渲染派生产出能力条而非引导卡（smoke 4-5b、4-6 实测）。**PASS**。
- **轮询不顶回**：轮询回调入口先查兜底（`:880-888`），`needsAssessment=true && marker 匹配` ⇒ 合并后 return，原始值不透传；渲染派生（`:907-912`）为第二保险。**PASS**（R2-⑦ 反证亦覆盖）。

---

## 第三轮：回归（改 A 有没有弄坏 B）

### 3.1 全量门禁实测（2026-11-22，均在本机实际执行）

| 命令 | 结果 |
|---|---|
| `node scripts/client-render-smoke.mjs`（新包） | **PASS 47/47，exit 0** —— 原有 30 项断言（版本 pill、header 收容、worker 卡、媒体查询、doctor 三态、派工弹窗、负向 #130 同型）全部保留且通过 |
| `$env:SMOKE_BUNDLE=<旧崩溃包>; node scripts/client-render-smoke.mjs` | **FAIL 11/36，exit 1** —— #130 原崩溃仍被抓（第 3 轮）+ 6 条新静态断言全 FAIL + 4-6（旧包无兜底，引导卡照弹）+ phase 锚点 |
| `node docs/ui-2.7.4/scan-h-type.mjs`（新包） | PASS：336 处 h(...) 全字符串字面量，exit 0 |
| `node docs/ui-2.7.4/scan-h-type.mjs <旧崩溃包>` | FAIL exit 1：唯一违规 L3000 = `h(h('div',…))`，即 2.7.0 #130 真实崩溃点（扫描器负向验证） |
| `git apply --check`（独立 pristine 树） | exit 0，应用后 SHA256 逐字节一致 |
| `node --check lib/client.js` | exit 0 |

### 3.2 改 A（评估卡四态/超时）对 B 及其余功能的影响排查

| 排查点 | 结论 |
|---|---|
| `assessing` 布尔被 `assessPhase` 取代 | 全文件 grep 无残留引用（仅 2 处注释提及历史）；原引用点仅 runAssess（基线 835-857）与两处按钮（基线 1863/1903），全部迁移到 phase |
| header 九按钮计数（冒烟第 1.5 轮 `dsb-btn 数量=9`） | 新增按钮全在评估卡内，不在 `dsb-acts` 子树 → 计数不变（实测 ok） |
| `assessHidden`/「评估」重开按钮（client.js:1757 一带） | 语义未动；success 能力条常显后该按钮仍有用（用户主动收起后重开） |
| 「稍后」行为变化 | 基线：点稍后 15s 内被轮询翻回（缺陷）；改后：按机器记一轮保持隐藏。属顺带修复，对故障 B 用例（4-6）无干扰 |
| notice 的其他使用点 | 仅增三处（成功 summary、降级提示、error 清空），其余 20+ 处未动 |
| 15s 轮询周期（client.js:898） | 未动 |
| `getJson`/其他 fetch | 未动（评估 fetch 是独立调用点） |
| 服务端 `lib/index.js` | 零改动（路由 `/api/board/ui/assess` 行为不变；客户端 8s 超时只影响前端等待窗口） |

### 3.3 改 B（needsAssessment 兜底）对 A 及其余功能的影响排查

| 排查点 | 结论 |
|---|---|
| 兜底合并只发生在「needsAssessment=true 且 machine 匹配」时 | 已评估机器（needsAssessment=false）走 890-893 清标记 + 原样 setIdent，渲染路径与基线一致 |
| localStorage 键名带 `v1` 后缀 | 与插件既有键风格一致（`dsh-board-pet-pos` 等），升级不撞旧数据 |
| 降级提示会不会打扰正常流程 | 只在「评估过 + 写盘失败」组合下出现一次；正常评估成功后 956 清标记，下次写盘失败才再提示 |

### 3.4 遗留建议（本版不做，移交后续）

1. **服务端（lib/index.js，本版禁改）**：`saveIdentity`（基线 817-827）写盘失败只 `trace` 后返回 null，建议后续版本：a) 失败时重试 2 次（临时文件 + rename 原子写）；b) 在 `/identity` 响应里带 `identityWriteFailed:true`，客户端即可精确提示而非推断。2.7.4 的客户端兜底在服务端修复后天然变成冗余双保险，无冲突。
2. **AbortController 缺失的宿主**（1.5.4 描述）：无超时降级。如需覆盖更老宿主，可在后续版本加 `setTimeout + 手动 reject` 的 fallback。
3. **一次性提示跨机器**：`dsh-assess-degrade-notified-v1` 未带 machine 维度；单面板实例只对应一台机器，无实际影响，如未来支持多机同面板再扩展。

### 3.5 交付清单自检

| 硬要求 | 状态 |
|---|---|
| 评估卡四态齐全 | ✅ idle/loading/success/error 显式比较存在于渲染链（client.js:1980/2003/912/2038），S6 断言把关 |
| 超时 8s 给可重试提示，绝不永久转圈 | ✅ ASSESS_TIMEOUT_MS=8000（:319），超时 → error 卡 + 「重试」（:972,2024）；4-4a/b/c 交互链全程实测 |
| 成功后清 needsAssessment（客户端与服务端一致） | ✅ 成功写兜底（:950）+ 轮询合并（:880-888）+ 渲染派生（:907-912）三重保证 |
| identity 写盘失败降级：第一次提示、之后不重复弹 | ✅ :883-886 提示一次并落标记；:890-893 恢复后清标记 |
| 新冒烟用例抓住旧 bug（旧包必须 FAIL） | ✅ 旧包 11/36 FAIL exit 1（smoke-cases.md §3.2） |
| h(...) 首参静态扫描（一次性脚本） | ✅ docs/ui-2.7.4/scan-h-type.mjs，新包 0 违规 / 旧包命中 L3000 |
| 结论带真实行号 | ✅ 全文行号均已实测核对（改前行号基线 0380ced，改后行号来自当前文件） |
| UTF-8 无 BOM + LF | ✅ 见最终校验记录 |
| 不改 lib/index.js / CHANGELOG / package.json / 版本号 | ✅ git diff --stat 仅 2 个允许文件 |
