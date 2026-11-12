## v2.2.2 — 2026-11-13

### 修复：评估卡点击后仍显示“未评估”

- 根因：面板 `runAssess` 的 `POST /api/board/ui/assess` 只带了自定义头 `x-dsh-team-ui`，没有 `content-type: application/json`，被 UI 闸门以 403 `forbidden` 挡下；旧逻辑不检查 `ok`，把 403 当成完成，卡片虽隐藏但评估结果从未写盘，重开仍是未评估。
- 修法：`lib/client.js` 的评估请求补 `content-type: application/json` 与空 JSON body；失败时保留卡片并提示（v2.2.1 已加）。
- 测试隔离：`scripts/ui-guard-smoke.mjs`、`scripts/reload-smoke.mjs` 除 `DSH_TEAM_STATE_DIR` 外，再隔离 `DSH_TEAM_IDENTITY_DIR` 到临时目录并在结束时删除，避免把真实 `~/.dsh-board/identity.json` 写成测试机名（本次真机就被写成了 `ui-guard-smoke`，导致 `needsAssessment` 恒为真）。
- 真机清理：真实身份文件已通过重新评估恢复为 `machine=host`；重启 DSH 后生效。

# 变更日志

## v2.2.1 — 2026-11-12

三条通道复审后的修补：显示名所有权归板子、改名不再伪造心跳、面板的失败路径不再“报成功”。

### 1. 显示名以板子为准

- `do_caps` 不再用机器自己的 caps 覆盖看板侧已存的 `caps.alias`（首次上报仍可作种子）。
- 本机改名现在会**立即**推一次 `/api/alias`：撞名 409 会回滚本地配置并返回冲突，不再出现“本地成功、板子失败”的分叉。
- 唯一性统一到 `_alias_key`（去控制/零宽/bidi、只留字母数字、casefold），同时比对身份名与显示名；撞名只丢 alias，不让整条 caps 上报 409（否则机器会被判离线）。

### 2. 改名不是心跳

- `do_alias` 不再调 `touch_machine`，只写 `caps_at`；给离线机器改名不会把它“救活”，也不会让「移除」按钮消失。

### 3. 移除

- `force` 严格 `is True`（`{"force":"false"}` 不再能强删在线机器）。
- 确认文案写明“再次上报会重新出现”；返回附带指向它的任务数；补 `alias`/`forget` 审计事件。

### 4. 面板失败路径

- 评估失败（`ok:false`）不再收起评估卡、不再显示“完成”；保留可重试入口。
- 任务详情里的交付/打回按状态禁用，与行内规则一致。
- 复制 JSON 改为 await + catch + textarea 回退；失败会明确提示，不再无条件报成功。
- `cardBusy` 改成按机器的对象，A 卡操作结束不会解锁 B 卡；移除成功后清掉改名编辑态。
- `busyN` 把 `claimed` 也算进去；任务详情里的机器/占位走显示名。

### 5. 自检横幅

- `dispatch-paused` 恢复为 `warn`（暂停调度会让任务一直不动，不能藏进 info）。
- `/doctor` 返回非 JSON 且没有 checks 时，横幅显示“自检不可用”，不再静默消失。

### 测试

- `scripts/board-server-smoke.py` **48 项**：新增 caps 不覆盖改名、`force:"false"` 被拒；冲突用例改为“只丢 alias”。
- 全量回归保持全绿：plugcheck 17/16、ui-guard 15/15、dispatch 88/88、model-pick M1–M11、acceptance 10+1。

## v2.2.0 — 2026-11-12

看板操作补全：能移除离线机器、给别的机器改名、展开任务详情；顺手把两条“没事也弹”的自检项降噪。

### 1. 移除离线机器

- 机器卡片对**离线**机器显示「移除」；确认后 `POST /api/board/ui/forget-machine` → 板子 `/api/forget-machine`。
- 板子只移除 `last_seen` 已超过 `ONLINE_WINDOW` 的机器；在线机器需要显式 `force`（面板不提供，防误删）。任务记录不删，仍可在「全部」里查。

### 2. 给别的机器改名

- 卡片「改名」：自己的机器仍走本地 `/alias`（写 `cfg.machineAlias`，重启后仍生效）；**其他机器**走 `/api/board/ui/machine-alias` → 板子 `/api/alias`，只改 `caps.alias`，身份 `machine` 不变。
- 板子侧统一清洗（去控制字符、空白折叠、≤32 字），并与其它机器的身份名/显示名做唯一性比较（冲突 409 带 `conflict`）。

### 3. 任务详情可展开

- 展开行新增：模型、模式/派工方式、远端任务 id、占位（taker/holder）、目标全文、进度；另加「复制 JSON」，一键复制整条任务（排查时不用再翻板子）。

### 4. 评估卡完成后收起

- 评估成功后横幅自动收起，只留一句结果提示；工具栏新增「评估」，需要时再打开。

### 5. 自检横幅降噪

- `config-saved`、部分机器离线、调度器暂停、machine 为空降为 `info`（面板不再弹）。
- 仍保留 `error`：没有 token、板子连不上、hub 上没有 worker、调度器半死、路由降级。

### 6. 板子

- 新增 `/api/alias`、`/api/forget-machine`（都要 token；状态写入在 `STATE_LOCK` 内）。

### 测试

- `scripts/board-server-smoke.py` 38 → **45 项**：改显示名 200、快照出现新名、撞名 409、在线机器移除 409、`force` 200、移除后快照没有该机。
- `scripts/reload-smoke.mjs` 路由 14 → **16**（场景 D 13 → 15）；`plugcheck` 17 工具 / 16 路由。
- `model-pick` M1–M11、`dispatch` 88/88、`ui-guard` 15/15、`acceptance` 10+1 保持全绿。

## v2.1.0 — 2026-11-12

派工时选「机器 + 模型」。以前看板只有机器维度，模型一律跟随副机默认 —— PC2 上
正是这样把 62K tokens 的任务塞进 32K 上下文的模型，报错还回显成"派工失败"。
这一版把模型做成板子任务的正式字段，并让对话派工先问清楚。

### 1. 任务带 model，一路透传

- `board_server.py` 的 `create` / `claim` / `seed` 接受并保存 `model`（≤160 字），
  看板快照原样返回；
- 插件调度器派发时取 `task.model || cfg.defaultModel`，再交给 remote-agent 的
  `/dispatch`（服务端本来就有 `normalizeModelSelection`）；
- `lib/solo-board.mjs` 与 `scripts/fake-board.mjs` 同步存这个字段；
- 看板快照（`snapshot()`）补上 `model`，否则调度器读不到任务级模型（复核 P1）；
- `do_claim` 只在任务本来没有 `model` 时写入，认领方不能改写建单决策。

### 2. 新工具 board_options

汇总在线机器与每台上报的模型清单（`provider` / `model` / `name`）、副机默认模型、
team 的 `defaultModel`，供面板与对话选型。model 可写 `provider/model` 或裸名。

### 3. 对话派工先问「哪台机器、哪个模型」

`board_dispatch` 新增 `model` 参数；在 `dispatchAsk`（默认 true）下：

- 没选机器 → 返回 `needSelection: true` + 候选机器/模型，不建单；
- 机器上报了模型清单但没选模型 → 同样返回候选，不建单；
- 机器 + 模型都给了 → 先核对目标机是否上报过它，拼错/该机没有的模型返回
  `available` 并拒绝建单（不再等到副机才炸）；
- `model: "auto"` 表示跟随副机默认，跳过选型；`exec` 模式不需要模型，也不会
  把 `defaultModel` 发给副机；
- 显式 `machine: "host"` 只在 hub 节点列表确实有 host 时放行（否则任务会永远排队）。

`needSelection` 用 `ok: true` + `needSelection: true` 表达，调用方不会把它当成
失败（旧契约是 `ok: false`，容易被 agent 顺手报成"派工失败"）。

工具本身弹不了原生提问卡，所以契约是"返回候选 → 调用方用 ask_user_question 问人 →
带 machine/model 重调"。后台自动派工不经过这个工具，不会被拦住；想完全跳过可配
`dispatchAsk: false`。

- 对话派工先问机器；指定机器后只按该机清单决定是否要求选模型（无清单直接跟随机默认）。

### 4. 看板派工弹窗加模型下拉

面板从 `/api/board/ui/summary` 的 `nodeModels` 取每台机器的模型清单：选了机器就只列
那台的模型，选"自动"则列**在线非 host 机器的交集**（并集可能把 A 机模型派给 B 机）；
默认项是「跟随副机默认（团队默认 …）」。`nodeModels` 的键统一小写，与 `pick` 的
比较方式一致。机器清单变化后会清掉已不可用的 `model`，避免发一个不存在的模型出去。
任务建单时 `model` 原样进 `/api/create`；板子连不上时 `/create` 返回 502 而不是把
machine 盲写进去，板子还没有该机 caps 但 hub 已连着它时按 hub 身份接受。

### 5. 机器显示名：身份稳定，名字可改

- 身份（`machine`）仍是电脑名/显式配置，参与任务归属、账本与恢复日志，**改名不动它**；
- 新增 `machineAlias`：用户可给本机起一个显示名（≤32 字），随 caps 上报到板子，
  看板机器卡片、任务行、`board_options` 都显示它；留空回退电脑名；
- 面板工具栏新增「改名」，保存走 `/api/board/ui/alias`（同样过 UI 三闸门）；
- 显示名只能当**查找键**：面板派工、`board_dispatch`、`/api/board/ui/create`、
  `board_attach` 与 `/api/board/ui/attach` 都会先把它归一成身份 id；认不出来就 400，
  绝不把别名写进 `task.machine`（否则任务会静默卡在 queued，别名撞上别机身份名时还会
  派错机器）；板子侧 `_canon_machine` 也认 `caps.alias`，`do_attach` 对显示风格的名字
  直接 400（不造 ghost 机器）；
- 改名做唯一性校验（不能和别的机器的身份名/显示名相同），清洗 C0/C1、零宽与 bidi
  控制符，写档失败会直接报 500 而不是假装成功；板子 `do_caps` 对重复显示名返回 409，
  改名路由在板子不可达时返回 `unique: "unverified"` + warning（本地仍然生效，恢复后自动上报）；
- 去掉了 client 里写死的 `GT14/MB14/PC2/host` 对照表，改为按板子上报的
  `machine.name` 显示——别人装插件时不会再被我们的机器名带偏。

### 6. 配置与脚本

- team 配置新增 `defaultModel`（空=跟随副机默认）与 `dispatchAsk`，都进第二层存档；
- `scripts/set-team-config.ps1` 新增 `-DefaultModel`，用法示例改用占位符；
- doctor 的 `config-saved` 提示会带上这两个键。

### 测试

- 新增 `scripts/model-pick-smoke.mjs`（M1–M11）：board_options 汇总、未选机器/未选模型
  拦截（`ok:true` + `needSelection`）、只给模型仍先问机器、机器无清单不要求选模型、
  建单带 model、`model:auto` 放行、目标机没有的模型被拒、exec 忽略 model、传显示名
  派工时 `task.machine` 仍是身份名；`board_attach` 传显示名时 `/api/attach` 的 machine
  同样是身份名；
- `plugcheck` 期望工具数 16 → 17（新增 board_options）；`/api/board/ui/alias` 使路由
  数 13 → 14；
- 全量回归：plugcheck 17 工具/14 路由、reload A/B/C、ui-guard 15/15、state-file 16/16、
  config-persist 11/11、solo-board、solo-bootstrap、shell-guard、dispatch 88/88、
  board smoke 38 项（含 attach 显示名折回 / 未知显示名 400 / alias 全局唯一 409）、
  acceptance 11 项。

### 边界

- `model` 只对 agent 模式有意义；exec 忽略。
- 副机必须先注册 OpenAI 兼容 provider，模型才会出现在清单里（否则退化为手填/副机默认）。
- 模型本身的上下文上限仍是风险：小模型跑长任务会超窗，工具会在终态 note 里补提示，
  但不会自动换模型。

## v2.0.7 — 2026-11-12

第二轮代码审阅的最后三项（P1-5 / P2-9 / Python 终态不修剪），外加市场维护者提的
一条示例占位符建议。没有改看板/派工协议，也没有改任务字段语义。

### 1. 过期恢复日志会绑错远端（P1-5）

`escalateExpiredJournal` 以前用 `rows.find` 只按 goal + **时间下界**匹配：既没有上界，
也不排除已经被别的板任务占用的远端任务。一条 3 小时前的过期日志，可以"认领"另一条
板任务正在用的 `ui-new`，于是从未完成的任务借别人的结果变成假完成。

现在统一走 `dispatchMatchWindow(rec)` + `matchRemoteCandidates(...)`：

- 窗口同时有下界（`sentAt - SEND_SKEW_MS`）与上界（`at + SEND_SKEW_MS`）；
- 候选排除本轮已认领的（`matched`）与板上已被任何任务占用的 `remote_id`（`occupied`）；
- 板子上本任务已经回绑 → 只清日志，不再重复 attach；
- 候选 >1 → 推迟 60 秒（不猜），0 条且窗口覆盖 → 才标 blocked。

### 2. 终态同步只取 hub 最近 200 条（P2-9）

hub `/tasks` 是 `slice(0, 200)`。板上 running 的任务一旦被挤出窗口，`syncRemote`
以前直接 `continue`，板上永远显示"进行中"。

现在对列表里缺失的已知 `remote_id` 做**有限并发 4** 的 `/task?taskId=` 单条查询：

- 查得到 → 用单条结果正常回写终态；
- 明确 `task-unknown` → 板上标 `failed` 并说明"远端已不存在（可能被回收）"，不再永久 running；
- 查询失败/旧 hub 404 → 不动（不能把可能在跑的任务判死）。

顺带修掉一个前置问题：列表为空时以前在探测前就 `return 0`，整段逻辑永远走不到。

### 3. Python 终态任务不修剪（P2-9 尾部）

`MAX_TASKS` 统计的是全部任务，终态任务只增不减 —— 到 5000 后 create 与未知 claim
全部 413。新增 `prune_terminal_tasks()`：容量检查前清掉 **30 天前**的
`done/failed/blocked/superseded`，未终态一律不动。仍可用 `GP_BOARD_MAX_TASKS` 覆盖上限。

### 4. 市场建议：示例去掉真实值

`scripts/set-team-config.ps1` 的用法示例里还有内网 IP、截断 token 与具体机器名，
现在改成 `<board-host>` / `<board-token>` / `<machine-name>` 占位符。

### 测试

- `dispatch-recovery-smoke` 新增 **R27**（远端被 200 条窗口挤出，单条查询仍能收尾）
  与 **R28**（过期日志不抢别的任务占用的 remote）、以及 **R29/R29b**（通用 404 与
  查询断连都不能把在跑任务判死），**86/86**。
- `board-server-smoke` 新增 **P2-16**（3 条 40 天前终态 + 上限 2：先修剪再建单），
  全过。
- 其余回齐全绿：plugcheck 16/13、reload A/B/C、ui-guard 12/12、state-file 16/16、
  config-persist 9/9、solo-board、solo-bootstrap、shell-guard、acceptance 11 项。
- 测试钩子：fake hub 的 `/tasks` 支持 `hidden` 任务，便于模拟被挤出窗口。

## v2.0.6 — 2026-11-12

第二轮代码审阅（基线 `11f4d68`）里的 P2 七项。全部是边界行为，没有改协议，也没有改
看板/派工的既有语义。

### 1. Solo 机器字典的原型污染（P2-7）

`machines` 以前是普通对象：`caps`/`metrics` 用 `machine='__proto__'` 写一次，就会改到
`Object.prototype` 上；`task_id='__proto__'` 建的任务在快照里也看不见。现在 `emptyState`、
`loadState`、`snapshot` 都使用 `Object.create(null)`，读写统一走 `hasOwn`/`getTask`。

### 2. untake 不校验 holder（P2-8）

同一台机器上的两个实例都能 untake 对方的占位。现在与 take 一样比较 holder，
不同则 409「占位归另一个实例，拒绝 untake」。调用方**没有提供 holder** 时不比较
（面板与旧客户端只发 task_id + machine，不能因为升级就把它们的撤占位能力弄丢）。

### 3. Solo 异步启动与卸载竞争（P2-10）

`apply` 返回后立刻 `cleanup` 时，solo 的 `listen` 可能还没完成；以前会留下一个
没人关闭的监听。新增 `soloAbandoned`：卸载时置位，启动回调看到后立即 `close()`。

### 4. `uiAllowedHosts` 没接线（P2-11）

`uiGuard` 早就读 `cfg.uiAllowedHosts`，但配置里没有这个键。现在：
`cfg.uiAllowedHosts`（数组、去空、转字符串）→ `TEAM_CONFIG_KEYS` 持久化 → 存档合并
→ `uiGuard` 的白名单 Set。默认空数组 = 仍然只允许回环。

### 5. cwd 不存在时静默回退（P2-12）

`sh_run` 以前 spawn 失败才报错，或者干脆落到宿主进程的当前目录。现在先校验
`cwd` 是目录，否则直接返回「cwd 不存在或不是目录：…」，不再替用户猜目录。

### 6. 允许盘符根时子路径被误拒（P2-13）

`withinRoots` 以前用字符串前缀判断，`C:\` 这种根会算错。现在先 `realpath`，再用
`path.relative(root, target)` 判断「不以 `..` 开头且不是绝对路径」，盘符根、UNC 根、
POSIX `/` 都一致。

### 7. Python 板子的单实例与任务上限（P2-14 / P2-15）

- 锁从「state + 端口」改为只看 **state 的真实路径**：同一份 `state.json` 只能有一个
  写入者，换端口也起不来第二个；同端口仍由 `SO_EXCLUSIVEADDRUSE` 挡。
- `MAX_TASKS` 从只卡 `seed` 扩到 `create` 与「claim 未知任务时自动建单」，并支持
  `GP_BOARD_MAX_TASKS` 覆盖（测试用）。

### 测试

- `solo-board-smoke` 新增 S9（holder 不符 409）、S10（`__proto__` 不污染、任务可见）。
- `shell-guard-smoke` 新增 G6（cwd 不存在报错）、G7（盘符根白名单）。
- `ui-guard-smoke` 12/12（新增 uiAllowedHosts 名单内放行、名单外 403）。
- `board-server-smoke.py` 新增 P2-14、P2-15，共 23 项全过。
- 全量：plugcheck 16/13、reload A/B/C、ui-guard 12/12、state-file 16/16、
  config-persist 9/9、solo-board、solo-bootstrap、shell-guard、dispatch 80/80、
  board smoke、acceptance 全部通过。

### 这一版没做

- P1-5（过期恢复日志绑错远端，需要按轮次重建证据）与 P2-9（终态同步只看最近 200 条，
  需要分页接口）留到 v2.0.7。

## v2.0.5 — 2026-11-12

## v2.0.5 — 2026-11-12

PC2 的两个真实问题 + 首次安装的模型指引。这一版没有改协议，只让「坏掉时看得出下一步」。

### 1. 左侧又出现「远程同事」面板

不是作业板新增的 UI，而是 PC2 上的 `dsh-remote-agent` 处于**半旧状态**：`package.json`
写着 0.9.12，但 `lib/client.js` 里没有 `SHOW_REMOTE_PANEL = false` 这一段（0.9.12 才有），
于是它按旧代码注册了 `sidebar.panellist` 与 `main` 两个槽。

处置：用主机 0.9.12 的 `lib/client.js` 覆盖 PC2 的同名文件（原文件留 `.bak-panel`），
刷新页面后入口消失。作业板自己的 DOM 隐藏逻辑仍在，但它只在面板加载后每 1.5s 扫一次，
不能替代插件侧的开关。

### 2. 第一次安装「拉不起模型」

全新 profile 里常常没有 `agent-default-model` 块，DSH 会退回默认路由
`deepseek-official`；那台机器上又没有 API key，于是 agent 任务报
`no API key for provider route "deepseek-official"`。用户看到的是「装完就用不了」。

两处修：

- `pc2-onboard.ps1` 在写 team / remote-agent 之后补一个 `agent-default-model` 块
  （`provider: deepseek-account`、`model: deepseek-flash`、`reasoningEffort: max`）。
  账号仍要在那台机器的 DSH 里登录一次——脚本不代持凭据。
- 插件 `syncRemote` 在把副机失败写回看板时，识别 `no api key` / `no key for provider` /
  `transport failed` / 裸代码 `TRANSPORT`，追加「该副机模型不可用（未登录/未配置，或网络不通）：
  在那台机器上登录账号、检查代理后重试」。原始报错保留，只补一句提示；文案同时覆盖
  鉴权与网络两种可能，不替操作者下结论。

### 验证

- `dispatch-recovery-smoke` 新增 R26（message 形式）、R26b（只有 code=TRANSPORT）、
  R26c（远端状态为构造器名时不得当成终态写回），**80/80**。
- `plugcheck` 16 工具 / 13 路由；`ui-guard-smoke` 10/10。
- 主机与 PC2 均无需改协议；PC2 的 `client.js` 替换已实机执行并复核
  （`findstr "SHOW_REMOTE_PANEL = false"` 命中）。

## v2.0.4 — 2026-11-12

一次「测试污染 + 盲信配置」的修复。v2.0.3 重启后 doctor 报 `板子连不上：fetch failed`，
板子本身正常（127.0.0.1:8965 与 <board-host>:8965 都返回 200），根因是两件事叠加：

1. `scripts/plugcheck.mjs` 也 `apply` 插件，但没隔离 `DSH_TEAM_STATE_DIR`，把
   `boardUrl: http://127.0.0.1:1`（故意不可达）和测试 token 写进了真实
   `~/.dsh/dsh-team/config.json`；配置文件又比 patch 优先，重启后插件就拿着死地址。
2. `baseUrl()` 对 `config.boardUrl` 是**盲信**的（`if (boardBase) return boardBase`），
   不探活、不回落 —— 死地址会让整个插件永远连不上板子，面板只显示 fetch failed，
   看不出是配置问题。

### 改了什么

- `baseUrl()` 对来自配置的地址先 `probeBoard`，不可达就 trace 并重新探测（pin → 候选）。
- `plugcheck.mjs` 使用临时状态目录，并在结束时清理；同类 smoke（reload/ui-guard/
  config-persist/dispatch/solo/shell）此前已隔离，这次补齐最后一个漏网的。
- 已把宿主真实 `config.json` 的 `boardUrl` 从 `http://127.0.0.1:1` 修回
  `http://127.0.0.1:8965`。

### 测试

- plugcheck 16/13、reload A/B/C、ui-guard 10/10、state-file 16/16、config-persist 9/9、
  dispatch 76/76、solo 10+5、shell-guard 10 项、board smoke 19 项、acceptance 11 项。
- 重启后 doctor 应无 `board` error（MB14 离线仍会给 workers 警告）。

## v2.0.3 — 2026-11-12

两位复审专家（AI 生成代码安全审计师 / 代码审查工程师）对 v2.0.2 改动逐行复核后，
确认了 2 个高危、1 个中高、4 个中危和若干低级问题。这一版全部修掉，并**纠正 v2.0.2
里一条记错的结论**：Python 板子的 `do_claim` 本来就允许「认领未知任务时自动建单」
（Host 统一派工靠它占位），v2.0.2 改成 404 反而与它不一致，本版恢复自动建单。

### 改了什么

1. **solo 自举不再把存档降级成 `solo:false`（高）**——首次 `persistTeamConfig()` 在
   solo 启动前执行，旧写法 `snap.solo = !!soloBoard` 此刻恒为 false；只要 solo 启动
   失败、临时设置 `DSH_TEAM_SOLO=0`、或进程在 listen 前退出，存档就永久停在
   `solo:false` + 旧随机端口，下次启动判定「已配置」不再起板子，用户再也连不上。
   现在单独维护 `soloIntent`（存档意图，含 2.0.1 无 `solo` 键的兼容判定），
   只有「显式配置 token/boardUrl」才写 `solo:false`；启动失败只记日志，不改存档。
2. **`allowAllRoots` / `envPassthrough` 真正接进 apply（中高）**——这两个键以前只在
   `registerShellTools` 的参数里存在，`cfg` 与 `TEAM_CONFIG_KEYS` 都没有，写进 patch
   也不生效；`envPassthrough` 完全不可用。现在两者进入 `cfg` 与存档白名单，
   两处 `registerShellTools` 调用都显式传参；`shell-guard-smoke` 增加 G5/G5b，
   从 `apply` 一路测到 `sh_read`，不再绕开接线。
3. **claim 恢复自动建单**（中）——见上；`create` 校验 `TASK_ID_RE`，非法 id 返回 400。
4. **任务上限只算活跃任务**（中）——`MAX_TASKS` 改为 `MAX_ACTIVE_TASKS = 5000`
   （只计非终态），加载时清理 30 天前的终态任务（`pruneTerminal`），5000 条 done
   不再把新任务永久卡在 413。
5. **solo 任务的键安全**（低）——`tasks` 改为 `Object.create(null)`，`hasOwn`/`getTask`
   替换裸取键，`__proto__` / `constructor` 不会再造幻影任务或误报「已存在」。
6. **shell 拒绝文案分情况**（中）——空白名单时说「没有配置 allowedRoots」并给出两条
   放行路径，不再误报「路径不在白名单」。
7. **`set-team-config.ps1` 备份不覆盖**（低）——备份名精确到毫秒，重名自动加 `-1`、
   `-2`，`Copy-Item` 去掉 `-Force`。
8. **POSIX 环境变量补齐**（中）——`ENV_KEEP` 增加 `HOME`/`TMPDIR`/`USER`/`LOGNAME`/
   `PWD`/`LC_ALL`，以及代理变量与 `SSH_AUTH_SOCK`、`NODE_EXTRA_CA_CERTS` 等。
9. **文档纠正**——README 与 `docs/issue-10/08-exec-policy.md` 里「`allowedRoots` 空 =
   不限制」改为「空白名单默认拒绝，需显式 `allowAllRoots`」；`lib/index.js` 导出的
   `name` 改为 `dsh-job-board`；`package.json` 的 `files` 补 `scripts/ui-guard-smoke.mjs`。

### 测试

- `solo-board-smoke`：S3b/S3c 覆盖「未知任务自动建单」，S3d 原型键、S3e 非法 id，
  S7 预置 5001 条 done 仍可建单。
- `solo-bootstrap-smoke`：B6 断言 `solo:true` + 可达 + token 沿用 + 任务跨重启仍在；
  B7 覆盖「临时 `DSH_TEAM_SOLO=0` 不降级存档、恢复后仍起板子」。
- `shell-guard-smoke`：G5/G5b 走 `apply` 集成路径。
- 全量回归：plugcheck 16/13、reload A/B/C、ui-guard 10/10、state-file 16/16、
  config-persist 9/0、dispatch 76/76、board smoke 19 项、acceptance 11 项全过。

## v2.0.2 — 2026-11-12

一次「审计 + 事故」合并修复：1 个高危（solo 重启失联）、1 个改名遗留（PC2 起不来）、
3 个中危（任务凭空生成、脚本注入/半截写、shell 白名单 fail-open），外加一个环境变量收敛。

### 改了什么

1. **client bundle 的模块 id 改成包名**（`lib/client.js`）——这是 PC2「装完重启 DSH
   客户端起不来、要屏蔽插件才能启动」的原因。改名后 loader 按包名注册客户端模块，
   而 `id` 还是 `dsh-team`，客户端找不到模块就整个界面挂住。现在 `id: 'dsh-job-board'`，
   跟 `dsh-remote-agent` 的写法一致。
2. **solo 第二次启动不再失联**（`lib/index.js` + `persistTeamConfig`）——solo 板子用
   `port: 0` 随机端口，第一次启动把 `boardUrl` 写进 `config.json`；重启后 `cfg.token` /
   `cfg.boardUrl` 都有值，旧逻辑判定「已配置」就不起板子，结果指向一个已经死掉的端口。
   现在存档里带 `solo: true` 时视为自举用户，照样重新起板子、沿用存档 token、把新地址
   写回去（任务在 `solo-board.json` 里，不会丢）。
3. **`claim` 不再凭空造任务**（`lib/solo-board.mjs`）——对不存在的 `task_id` 返回 404，
   与 `tools/board_server.py` 对齐；`create` 增加 `MAX_TASKS = 5000` 上限。
4. **`set-team-config.ps1` 防注入 + 原子写**——值统一经 `YamlQuote`（拒绝换行、
   单引号转义成 `''`），写盘改为 `$path.tmp-setteam` + `Move-Item -Force`，
   避免写一半把 patch 截断（这个项目已经丢过两次配置）。
5. **shell 白名单 fail-closed + 环境变量收敛**（`lib/shell.js`）——`allowedRoots` 为空
   且没有显式 `allowAllRoots: true` 时，`sh_read` / `sh_write` / `sh_list` / `sh_run`
   的 `cwd` 一律拒绝（以前空白名单等于全盘放行）；子进程不再继承整个 `process.env`，
   只透传 `PATH`、`SystemRoot`、`TEMP` 等基础变量，需要别的用 `envPassthrough` 显式列。

### 测试

- 新增 `scripts/shell-guard-smoke.mjs`（G1–G4，8 项）：空白名单拒绝、显式放行、
  私密环境变量不外泄、`envPassthrough` 生效。
- `solo-board-smoke` 增加 S3b（claim 不存在 → 404）；`solo-bootstrap-smoke` 增加
  B6/B6b（同目录二次 apply 仍能起 solo、token 沿用存档）。
- 全量回归：plugcheck 16/13、reload A/B/C/D、ui-guard 10/10、state-file 16/16、
  config-persist 9/0、dispatch 76/76、board smoke 19 项、acceptance 11 项全过。

### 升级注意

- **PC2 / 从 git 安装的机器**：删掉旧的 `node_modules/dsh-team`（如果还在），
  重新 `dsh plugin add github:shaot92-del/dsh-job-board`，重启 DSH。
- 主机：本次也要重启 DSH 才会加载 2.0.2（旧进程里还是 1.4.1）。

## v2.0.1 — 2026-11-11

修 v2.0.0 漏掉的一处改名：**包内 `cordis.patch.yml` 的 `name` 还是 `dsh-team`**。

### 为什么会这样

`package.json` 的 `name` 只决定 npm 包名和安装目录；真正让 loader 去解析哪个模块的，是
包内 bundle patch 里 `- insert: - name: '...'` 这一行。v2.0.0 改了前者、漏了后者，于是：
- 本机：profile 里原来的 `dsh-team` 还在，旧实例继续跑，看不出问题；
- PC2：从 git 装了 `dsh-job-board`，但 patch 让 loader 去找 `dsh-team` 模块，
  找不到（或找到另一个同名 npm 包），表现就是「装了但名字还是旧的 / 起不来」。

### 改法

- `cordis.patch.yml` 的 `name: 'dsh-team'` → `name: 'dsh-job-board'`；
- 文件头注释同步改名；
- 版本 2.0.1。

### 验证

`npm pack --dry-run` 里 `cordis.patch.yml` 内容已更新；本地 profile 的 `- id: team`
覆盖块不受影响（它只覆盖 config，不声明 name）。装完仍需重启 DSH。

## v2.0.0 — 2026-11-11

改名：`dsh-team` → **`dsh-job-board`**（仓库同名）。功能不变，只动名字与安装方式。

### 为什么

- npm 上 `dsh-team` 已经被另一个无关的「Agent Teams」插件占用（0.2.11，周边还有
  `dsh-team-control` / `dsh-team-hub`）。从市场或 `dsh plugin add dsh-team` 装，
  解析到的是别人的包，版本对不上就装不上或装出四不像。
- 兼容名字里带 `team` 的候选也被占了：`dsh-ops-board` 对应 `ZJR24/dsh-ops-board`
  （11/06，项目看板）。`dsh-job-board` 在 npm 与 GitHub 都空着。

### 改了什么

- `package.json` 的 `name` → `dsh-job-board`，`repository` / `bugs` / `homepage`
  指向 `https://github.com/shaot92-del/dsh-job-board`；版本直接跳 **2.0.0**
  （包名变了，按 semver 算破坏性变更，装法也要跟着换）。
- GitHub 仓库已改名，旧地址 `shaot92-del/dsh-team` 由 GitHub 重定向；
  README 的安装命令、`dsh.profile.bundles` 说明同步改。
- 本机 profile：依赖 `dsh-job-board: file:D:/gp_video/dsh-job-board`，
  bundles 里把 `dsh-team` 换成 `dsh-job-board`；旧的 `node_modules/dsh-team`
  不再被任何东西引用（重启后可以删）。

### 没改什么（有意保留，避免老配置失效）

- 状态目录仍是 `~/.dsh/dsh-team`（journal、pendingAttach、config.json、solo 板子状态都在里面）；
- 环境变量仍是 `DSH_TEAM_*`（`DSH_TEAM_STATE_DIR`、`DSH_TEAM_SOLO`、`DSH_TEAM_BOARD_CANDIDATES` 等）；
- Cordis patch 的实例 id 仍是 `- id: team`，工具名仍是 `board_*` / `sh_*`；
- 板子服务、doctor、路由、面板行为与 v1.5.3 完全一致。

### 迁移

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add 'github:shaot92-del/dsh-job-board'
# 确认 profile package.json 的 dsh.profile.bundles 里是 dsh-job-board
# 重启 DSH
```

数据不会丢：token、机器名、派工记录都在原来的状态目录里，插件按同一套键读取。

## v1.5.3 — 2026-11-11

把 R21 从「看时序」改成「看结果」，并把 holder 语义补到真板子的 smoke 里。

### 修了什么

- **R21 在 ubuntu-latest 上偶发失败**（v1.5.2 的 CI）。断言原来是
  `holderConflict >= 1`，但两个实例的 tick 谁先谁后决定了第二个实例会不会真的
  发出第二次 take：A 先 take 成功后任务就是 `claimed`，B 的候选过滤只取
  `queued/stale`，会直接跳过、不产生 409。于是同一条正确行为有时 0 次冲突、
  有时 1 次。现在断言的是可观测结果：`dispatch === 1 && remoteTasks.length === 1`
  （只派一次、远端只有一条任务），时序细节只写进失败信息。
- **真板子 smoke 补 holder 用例**：同机两个实例（holder 不同）对同一条任务先后
  `/api/take`，第二个必须 409「已被同机的另一个实例占住」。这条以前只在
  fake-board 里测过，真板子没覆盖；R21 放软之后就由它来守 409 语义。
  用例里 `/api/create` 需要显式 `dispatch: 'auto'`，否则 `do_take` 会以
  「不是自动派发任务」拒绝（第一次跑就踩到了）。

### 验证

plugcheck 16/13、reload A/B/C、ui-guard 10/10、state-file 16/16、
config-persist 9/0、solo 10+5、dispatch **76/76**、board smoke 19 项全过、
acceptance 11/11。`windows-latest` 与 `ubuntu-latest` 双绿。

## v1.5.2 — 2026-11-11

市场复验的第一条收尾 + 配置脚本。

### 改动

- `lib/index.js` 的 `BOARD_CANDIDATES` 不再硬编码作者的局域网地址
  （`<host-pc>:8965`、`<board-host>:8965`）。默认只探 `127.0.0.1:8965`；
  内网/远程候选地址改用环境变量 `DSH_TEAM_BOARD_CANDIDATES`（逗号分隔）或
  `DSH_BOARD_URL` 指定。这是市场第一次复验留下的最后一条（「删掉两条内网候选地址」）。
- 新增 `scripts/set-team-config.ps1`：自动找 profile、upsert `team` 块、写前备份、
  写后复核。起因是手粘 YAML 时聊天工具会把 `'` 换成弯引号 `‘ ’`，PowerShell
  字符串永远不闭合，终端卡在 `>>` 续行——这种问题不该让人靠手改文件解决。
  - `-List` 只看各 profile 有没有/重不重复 team 块；
  - `-Profile desktop -BoardUrl ... -Token ... -Machine PC2 -Role observer` 写入；
  - `-DryRun` 只打印不落盘。

### 验证

`set-team-config.ps1` AST 解析通过；临时 profile 上实测两条路径（更新已有块、追加新块）
均通过，字段与其它条目保持不动。回归全绿：plugcheck 16/13、solo smoke 10+5、
dispatch 76/76、board smoke 17/17、acceptance 11/11。

## v1.5.1 — 2026-11-11

打包漏文件：`package.json` 的 `files` 里没有 `lib/state-file.mjs`。

### 为什么

`lib/index.js` 静态 import 了 `./state-file.mjs`，但 `files` 只列了 index/client/shell/solo-board
四个文件。`dsh plugin add github:...` 走 pnpm 的 git 安装，会按 `files` 打包（packlist），
装完 Host 半边会因缺模块加载失败——市场 review 也是因为这条打回的。npm 安装同理。

### 改动

- `files` 改成 `"lib/"`，整目录收进来，以后再加 `lib/` 下的文件不会再漏。
- README「装」一节改正：仓库现在**带** `tools/board_server.py`（多机用），单机则由
  v1.5.0 的 `lib/solo-board.mjs` 零配置自举；不再写「仓库不含该服务」。

### 验证

`npm pack --dry-run` 确认包含 `lib/state-file.mjs`；`node --check` 全过；回归全绿
（plugcheck 16/13、solo smoke 10+5、dispatch 76/76、board smoke 17/17、acceptance 11/11）。

## v1.5.0 — 2026-11-11

零配置也能用：第一次启用时，插件自己在 127.0.0.1 上起一个最小板子。

### 为什么

用户从插件市场装完 dsh-team 直接启用时，profile 里没有 `team` 配置（没有 token、
没有 boardUrl），过去的体验是**面板全空 + 板子 401**。要用起来得同时凑齐三样：
一台机器上跑着 Python 板子、拿到 board token、手改 `cordis.patch.yml`。这三道门槛
对「只想在一台机器上看看」的人完全不成立，PC2 上就是这样卡住的。

### 改动

- 新增 `lib/solo-board.mjs`：随包的 Node 最小板子，只做 solo 需要的子集——
  `create / claim / take / untake / attach / mark / beat / release / caps / metrics /
  say / seen`，语义对齐 `tools/board_server.py`（take 守 `dispatch=auto`、holder 冲突
  409、mark 的身份校验与状态白名单、release 归属、caps/metrics 大小上限）。
  **只绑 `127.0.0.1`**，token 默认 `randomBytes(24)` 随机生成，`timingSafeEqual` 比较；
  状态写 `<stateDir>/solo-board.json`（tmp+rename、0600）。
- `lib/index.js`：零配置（`!cfg.token && !cfg.boardUrl`）时自动 `startSoloBoard`，
  把生成的 token/boardUrl 写进第二层配置 `config.json` 并 trace
  `solo 板子已启动 …（仅 127.0.0.1，token 自动生成）`；`baseUrl()` 首次调用前 await 它
  就绪；cleanup 时关闭监听（状态文件留着，下次接着用）。
- doctor：新增 `solo` 信息项（显示地址与状态目录），响应带 `solo: true|false`；
  有 solo 板子时不再误报 `config-token`。
- 显式配了 token/boardUrl 的用户完全不受影响；`DSH_TEAM_SOLO=0` 或配置
  `solo: false` 可关掉自举。

### 边界

- solo 板子只能本机用（进程内、127.0.0.1、随机端口），**不能**替代多机作业板：
  接团队仍要用 `tools/board_server.py` + 共享 token。
- 邀请码 / 首次启用向导还没做（下一版）；现在要接入团队仍是手填 boardUrl+token。

### 验证

新增 `scripts/solo-board-smoke.mjs`（10 项：起板/无 token 只回 ok/401/建认领心路/
重启持久化/close 后不应答）与 `scripts/solo-bootstrap-smoke.mjs`（5 项：零配置自举、
config 写入、无 token 401、cleanup 关监听、显式配置不启 solo），全部通过；回归：
plugcheck `tools=16 routes=13`、reload A/B/C/D、ui-guard 10/10、state-file 16/16、
config-persist 9/9、dispatch-recovery 76/76、board-server-smoke 17/17、acceptance 11/11。

## v1.4.2 — 2026-11-11

doctor 的一个假警报。

### 修了什么

- `lib/index.js` 的 `doctor` 检查读的是 `cfg.boardToken`，而这个字段从来不存在（配置字段叫
  `token`）。后果：**即使 token 配好了，面板也永远报 `config-token 没有配置板子 token`**，
  v1.4.0 上线后一直被当成真的失联。改成 `cfg.token`。
- `scripts/ui-guard-smoke.mjs` 增加断言：apply 时传了 token，`doctor.checks` 里就不得出现
  `config-token`（发版前抓这个 bug 的回归测试）。

### 说明

- 这个 bug 只影响 doctor 的显示，不影响实际鉴权：板子读写、派工、同步一直用的是
  `cfg.token`，所以「面板报错但任务能跑」的怪状态就是它造成的。
- MB14 本轮未上线（板子 `last_seen` 约 9 小时前，hub 只有 GT14 一条 Established），
  与本版本无关，等那台机器恢复后重启 DSH 即可。

### 验证

plugcheck `tools=16 routes=13`；ui-guard 10/10；reload A/B/C/D；state-file 16/16；
config-persist 9/9；dispatch-recovery 76/76；board-server-smoke 17/17；acceptance 11/11。

## v1.4.1 — 2026-11-09

配置的第二层兜底：profile patch 被整份重写时，插件不再跟着失联。

### 为什么

2026-11-09 22:57，`C:\Users\17827\.dsh\profiles\desktop\cordis.patch.yml` 被外部重写成
889 B / 4 条，`- id: team` 与 `- id: remote-agent` 整块消失（当天第二次丢块）。后果不是
「面板报个错」，而是：team 没有 token → 板子 401；hub 退回默认只监听 `127.0.0.1:19387`
→ 两台副机全部掉线、队列排着不动。`dsh-remote-agent` 本来有 `instance.json` 兜底，
但那份文件从来没生成过；team 则完全没有兜底。

### 改动

- **`lib/index.js` 增加 `<stateDir>/config.json`**（`DSH_TEAM_STATE_DIR` 覆盖，默认
  `~/.dsh/dsh-team`）。白名单只存 9 个键：`token`、`boardUrl`、`machine`、`dispatchRole`、
  `allowedRoots`、`dispatchApproval`、`timeoutMs`、`shellTimeoutMs`、`maxOutputBytes`。
  规则：loader/patch 显式给了值 → 以它为准并回写存档（用户改配置仍然生效）；缺省 →
  用存档兜底。这样「谁把 patch 写坏了」不再等于「整机失联」。
- **doctor 更诚实**：新增 `config-saved` 警告（列出哪些键来自存档），响应增加
  `configSource: "patch" | "saved"`。看到这条就说明 patch 又被重写了。
- **`scripts/config-persist-smoke.mjs`**：9 项断言——C1 空配置全部走存档、C2 显式值覆盖
  存档、C3 混合（显式覆盖、缺省续用上一轮写回值）。
- **本机补了 `~/.dsh-remote-agent/instance.json`**（`role: hub`、`listenHost: 0.0.0.0`、
  `listenPort: 19387`、`nodeToken`，ACL 仅本人）：即使 patch 再次丢掉 remote-agent 块，
  hub 仍按存档起在 19387 并认副机的 token。

### 验证

`config-persist-smoke` 9/9；plugcheck `tools=16 routes=13`；reload-smoke A/B/C；state-file
16/16；ui-guard 9/9；dispatch-recovery 76/76；board-server-smoke 17/17；acceptance 11/11。

### 仍未做

- 没查清是哪个宿主组件在重写 patch。下一步：启动时与 canonical 副本对比，缺块就恢复并
  在 doctor 里报错（比「靠人记得恢复」可靠）。

## v1.4.0 — 2026-11-09

运维自愈第一批：让「装没装上、跑没跑对」这件事有据可查，并且撞车时不再整机重启。

### 板子（`tools/board_server.py`，第一次进仓库）

- **权威副本进 git**：以前板子只存在于共享盘 `_tools`，改动不进版本库、CI 也测不到。
  现在仓库里的 `tools/board_server.py` 是源，部署用 `scripts/install-board.ps1`。
- **`/api/health` 带 `build`**：取源文件 sha256 前 12 位。v1.3.11 曾出现「以为 M1 已生效、
  实际旧进程还在服务」的误判；以后先看 `build` 对不对，再谈行为。
- **`scripts/install-board.ps1`**：哈希比较后复制（旧文件留 `.bak-<时间戳>`）→ 停监听端口的
  进程 → 清陈旧锁（锁里的 pid 还活着就拒绝）→ 从 `_dsh/board-tokens.txt` 读 token 启动 →
  25 秒内等 health → 校验 `version=4`、`build` 与源一致、`authTokens` 枚数、
  `singleInstance=true`。日志写 `_board/install-board.log`；支持 `-OnlyCheck` / `-DryRun`。
- **CI 跑板子 smoke**：`board-server-smoke.py` 默认指向仓库副本，Actions 用 Python 3.12 执行。

### 插件（`lib/index.js` / `lib/client.js`）

- **doctor + 面板红条**：新增 `/api/board/ui/doctor`（回环 + 自定义头保护），每 30 秒检查
  配置 token/machine、板子连通与新鲜度（>120s）、在线 worker、hub `/nodes`、降级路由数、
  调度器心跳（>max(30s, tick×5)）、暂停/报错状态。面板在有 error 时显示红条、只有 warn 时
  黄条，逐条给 message 与 hint。
- **路由注册幂等化**：撞 `duplicate route` 时只跳过那一条并记入降级列表（trace + doctor
  上报），工具、定时器、调度器照常启动；非 duplicate 的注册失败仍然整插件回滚。
  以前一次撞名会把 16 个资源全 rollback，只能整机重启（这周发生过两次）。
- **D6 账本收尾**：板子自己的 `reconcile_once` 先把任务标成终态时，`syncRemote` 的终态
  分支不会执行，账本条目以前要等 12h TTL；现在同步时先扫一遍板上终态任务并清账。
- 版本号从 `package.json` 读取并随 doctor 返回，便于对照「部署版本 ≠ 运行版本」。

### 测试

- `board-server-smoke.py` **17/17**（仓库副本，health 含 `build`）。
- plugcheck `tools=16 routes=13`（新增 doctor）；ui-guard **9/9**（doctor 外部 Host 403、
  回环 200）。
- reload-smoke 场景 A/B/D 全过：B 改为「降级加载不抛错、旧路由仍在、cleanup 不误删」，
  新增 D「doctor 单条撞名，其余 12 条照常注册」。
- dispatch-recovery **76/76**：新增 R25（板上已终态 → 账本条目被清，其它条目保留）。
- state-file 16/16；acceptance（fixtures）11/11。

### 部署

- 板子已用 `install-board.ps1` 实跑：旧 pid 43092 → 新 pid 15840，`build` 与源一致，
  `authTokens=1`、`singleInstance=true`。
- 插件仍需重启 DSH 才装载；热重载不会再让整个插件回滚，但旧实例的路由仍优先，doctor 会
  报 `routes` 降级——看到它就该重启，而不是以为已经生效。

### 仍未做

- 板子进程仍由脚本/计划任务守护，没有做成 Windows 服务；`install-board.ps1` 重启期间
  有 1–2 秒不可用（面板会短暂报错）。
- doctor 只做诊断，不自动修复（例如不会自己重启板子或重读配置）。

## v1.3.11 — 2026-11-09

安全修补第三批（复核清单里的 D6 / M1 / M2 / M4 / L2 / F10）。板子改动同样只在本机共享盘
`_tools` 那份权威副本里，git 只记录插件与测试。

### 插件（`lib/index.js`）

- **D6 跨 Host 回写护栏不再是死代码**：板子 `do_attach` 会把 `taker`/`holder` pop 掉，
  旧护栏 `t.taker` 在真板上从来没成立过。新增本机「远端任务账本」
  `remote-owners-<machine>.json`（12 小时 TTL）：attach 成功记 `{taskId, remoteId}`，
  `syncRemote` 发现板上的 `remote_id` 与本机记的不一致 → 判定被别的 Host 重派，跳过回写；
  写回终态后清账。
- **M4 板子地址 pin**：自动探测只在第一次做，成功后写 `<state>/board-url.json`，以后启动
  先试 pin（不再广播式问 `<host-pc>` / `<board-host>` / `127.0.0.1`）。要重新探测
  就设 `DSH_TEAM_BOARD_REPIN=1` 启动一次（或在状态目录删掉 `board-url.json`）。
- **F10 注释修正**：在线判定的心跳来自插件（`remoteSyncMs=6s`），不是计划任务
  `gp_presence` —— 那个任务从来没装过，注释与文档都不该那么写。

### 板子（`board_server.py`，部署在共享盘 `_tools`）

- **M1 身份校验**：`do_mark` / `do_release` 在任务已有 `machine` 时，**非回环**调用必须带
  `machine`（执行机）或 `holder`，否则 400 `identity-required`。以前「双方都提供才比较」
  意味着省略字段就能绕过 —— 持 token 者可关掉任意任务。`do_POST` 注入 `__client`
  供判断，本机 GUI/插件走回环不受影响。
- **M2 抗打**：连接 `settimeout(15)`（半开连接最多占 15 秒）；并发槽
  `BoundedSemaphore`（`GP_BOARD_MAX_CONN`，默认 32），满了回 `503 Busy`。
- **L2 大小上限**：`caps` 8 KB、`metrics.live` 4 KB（超了 413）、`seed` 单次最多 200 条、
  任务总数最多 5000。合并后的 caps 也卡 2× 上限。

### 测试

- `dispatch-recovery-smoke` **74/74**：R19 改成账本语义（板上 `remote_id` 被改写 →
  `mark=0`、板上状态不被覆盖）。
- `board-server-smoke.py` **17 项**：新增 L1（无 token 的 health 只有 `ok`）、M1（局域网
  匿名 mark/release 400、带 machine 放行）、L2（caps/metrics/seed 三个 413）。
- plugcheck `tools=16 routes=12`；reload-smoke A/B/C；state-file 16/16；ui-guard 7/7；
  acceptance（fixtures）11/11。

### 仍未做

- D6 的账本只覆盖「本机派过的任务」；从未由本机派过的任务不追踪（这是预期：本机本来
  就不该回写它）。
- M2 只限并发、不排队；L2 的 seed 上限是条数不是字节。
- 板子改动需要重启进程才生效（`board_server.py` 不在 git 里，部署说明见
  `docs/issue-10/08-exec-policy.md` §13.3）。

## v1.3.10 — 2026-11-09

安全修补第二批（上一轮复核里"能当场改代码"的 7 项），外加两处测试保真修复。

### 插件（`lib/client.js`）

- **D3 暂停失败不再继续归档**：以前宿主回 `paused:false` 或暂停接口 404 时，`paused`
  恒为 false 却继续 release —— 副机在跑、板上已 superseded，同步器也不再 watch 它（幽灵
  任务）。现在两次暂停都没成功就**直接中止**并给出可读提示。
- **D4 `runCleanup` 补 try/catch/finally**：任何一步抛错都不会再把 `cleanBusy` 卡在 true
  （按钮永久变灰），`finally` 里统一 `setCleanBusy(false)` 并尽力 `pauseDispatch(0)`。

### 板子（`board_server.py`，部署在共享盘 `_tools`）

- **F1 单实例锁按端口隔离**：锁文件名从 `state.json.lock` 改成 `state.json.<port>.lock` ——
  只按 state 路径加锁时，换一个 `--state` 就能再起一个进程绑同一端口。另加
  `BoardServer(ThreadingHTTPServer)`：`allow_reuse_address=False` + Windows
  `SO_EXCLUSIVEADDRUSE`，绑定失败打印「绑定 xxx 失败」并以 1 退出。
- **F3 机器名大小写归一**：`do_mark` / `do_beat` / `do_release` 两侧都过 `_canon_machine`
  再比 —— 以前 `GT14` 认领的任务，`gt14` 永远 409，客户端再也更新不了自己的任务。
- **F9 reconcile 失败不再静默**：扫描异常写入 `RECONCILE_ERROR` 并在 `/api/health`
  的 `reconcileError` 回显、stderr 打一行；恢复后自动清空。

### 脚本

- **F5 `team-hardening.ps1` 键级 upsert**：只改自己负责的 9 个键，`writeTimeoutMs` /
  `dispatchTickMs` / `unknownGraceMs` 等未被管理的键与注释原样保留（以前整块重写会静默丢掉）。
- **F7 `自驱.ps1` release 失败不再带走守护进程**：四处 `Invoke-BoardAction '/api/release'`
  收敛成 `Release-Task`，失败写 `_pending-releases.jsonl`，下一轮 `Replay-PendingReleases`
  自动补报；不再以码表外的 exit 1 退出。

### 测试

- `scripts/fake-board.mjs` 的 `/api/mark` 补上归属校验（以前完全不校验，D2 那类 bug
  在 smoke 里永远测不出来）：machine 规范化比较、holder 精确比较，均只在双方给值时生效。
- `dispatch-recovery-smoke` 新增 **R24**：待补绑任务归执行机（MB14）、调度器是 host，
  远端任务已消失 → 必须按执行机名 mark 成 failed 并清掉待补绑记录（**74/74**）。
- 新增 `scripts/board-server-smoke.py`：真板子契约测试 —— ①同端口不同 state 的第二实例
  必须拒绝启动；②`GT14` 认领后 `gt14` 可 beat/mark/release、`MB14` 仍 409。找不到板子
  脚本（CI 的 Linux runner）时跳过并 exit 0。

### 仍未做（下一轮）

D6（`syncRemote` 的 taker 护栏是死代码）、M1（mark/release 省略字段绕过归属）、
M2（无 socket 超时/并发上限）、M4（boardUrl 自动探测）、L2（caps/metrics 无上限）、
F10（`gp_presence` 计划任务仍不存在）。

## v1.3.9 — 2026-11-08

安全修补第一批（三专家复审的必改项 + 共享盘秘密清理）。这一版的目标不是"再加功能"，而是把
上一轮审计里能当场关掉的洞关掉，并把"令牌被写进日志"这条路一起堵上。

### 插件（`lib/index.js`）

- **D1 修掉 `HUB_TASKS_LIMIT` 的作用域 bug**：它原来只在 `reconcileUnknownDispatches` 的
  IIFE 里声明，`escalateExpiredJournal` 引用它会抛 `ReferenceError`，而 `escalateExpiredJournal`
  排在队列循环之前 —— 每 tick 都会把整轮派工打断，且日志只有一句 `dispatch loop error`。
  现在 `HUB_TASKS_LIMIT` 提到模块级，两份内联的"反查窗口是否覆盖发出时刻"判断合并成
  `hubWindowCoversTime(rows, since)`（D5 判据不一致一并修掉）。
- **D2 修掉多机部署的 mark 归属错**：`attachTask` 与 `retryPendingAttach` 的
  `/api/mark {status:'failed'|'blocked'}` 原来传 `machine: cfg.machine`（调度器自己的名字），
  而板子比的是执行机名字 ⇒ 多机部署必然 409、任务卡在 claimed、待补绑记录清不掉。
  现在分别传 `machineName` 与 `info.machine || cfg.machine`。

### 板子（`board_server.py`，共享盘）

- **入站与出口双重脱敏**：新增 `_SECRET_RULES` / `redact()` / `redact_obj()`，覆盖
  `nt_…`、`ghp_…`、`github_pat_…`、`sk-…`、`AQ.…`、独立 40 位十六进制与
  `x-board-token` 一类键值行。`/api/board` 出口整体过滤；`reconcile_once` 拼 note 前过滤；
  `say`/`create`/`mark`/`release`/`claim` 的文本在**写入边界**就过滤 —— 明文不再落进
  `state.json`，也就不会被镜像同步出去。
- **`/api/health` 公开面收敛**：无 token 只回 `{"ok":true}`，任务数、令牌枚数、版本、路由表
  这些侦察信息要带 token 才给（守护脚本只判 `ok`，不受影响）。
- **请求体与租约收敛**：`MAX_BODY_BYTES = 1 MB`（超限直接读空，不再把线程挂住）；
  `_minutes()` 把租约夹到 1–1440 分钟（负数会让任务立刻过期，非数字会把异常回显成 500）。

### 运维

- 共享盘 `_keys/gemini.txt`（明文 Google key）已移出共享盘，改放本机
  `%USERPROFILE%\.dsh\secrets\gemini.txt`（ACL 只给当前用户）；`setup-modlens.ps1` 的默认
  密钥路径同步更新。**密钥本身仍需到上游撤销重建**。
- 共享盘里的旧 `nt_…` 已替换为 `<nodeToken>`；新增 `_tools\scan-share-secrets.ps1`
  做日常扫描（真实令牌形状 → ERROR，字段名/占位符 → INFO）。

### 验证

`node --check` / plugcheck `tools=16 routes=12` / reload-smoke A-B-C / dispatch-recovery 71/71 /
state-file 16/16 / ui-guard 7/7 / acceptance 11/11（acc-11 1.09s）。
运行时：无 token `/api/health` → `{"ok":true}`；含假令牌的 `say` 文本在 `/api/board` 里显示为
`<redacted>`，原始串不出现。

### 仍未做（需要窗口/重启）

- 副机 `dispatchApproval` 是否改 `manual`（会中断自动派工，等用户拍板）。
- 板子 8965 的防火墙收窄到三台机器。
- 第 2 层：分档 token、任务级 claimSecret、exec 白名单、日志走 hub 不走共享盘。

## v1.3.8 — 2026-11-08

CI 修红。v1.3.6 的 acc-11 在本机是绿的、在 GitHub Actions 两个平台都是红的，原因是**两者跑在
不同的"身份状态"上**：

- `reportCaps()` 有个前置闸门 `identityState().assessed` —— 本机没做过评估就跳过上报，以免把
  一台没评估过的机器写进板子。本机 `~/.dsh-board/identity.json` 是早前评估留下的，所以 acc-11
  等上线瞬间就成功（0.84s）；CI runner 上没有这个文件，caps 永不发出，10 秒后报
  `本机迟迟没在板子上线（caps 没上报）`。
- 同样的问题也意味着 **acc-11 在本机是假绿的**：它测的不是"插件会自己上报"，而是"这台机器
  以前评估过"。

### 改法

1. `lib/index.js`：身份目录支持 `DSH_TEAM_IDENTITY_DIR` 覆盖（默认仍是 `~/.dsh-board`），
   验收才能在一个干净的"未评估"状态下跑。
2. `scripts/acceptance.mjs`：acc-11 把 `DSH_TEAM_IDENTITY_DIR` 指到临时目录，并显式调用
   `board_assess { force: true }` —— 这正是真部署里"新机器第一次上线"的路径，比等一个
   历史文件更接近现实。
3. 等上线的轮询从 40 次放宽到 60 次（15 秒），给慢 runner 留余量。

### 验证

| 检查 | 结果 |
| --- | --- |
| 本机有 `identity.json` 时 `node scripts/acceptance.mjs` | 11/11，acc-11 0.78s |
| **把 `identity.json` 移走**再跑（等价 CI） | 11/11，acc-11 1.11s |
| `plugcheck` / `reload-smoke` / `dispatch-recovery` / `state-file` / `ui-guard` | PASS / A+B+C / 71/71 / 16/16 / 7/7 |

## v1.3.7 — 2026-11-08

三方复审里**不需要重启**的那批。两条都是"别人能替我动手"的口子，先关掉。

### 修好的

1. **安全 F1 — 插件 GUI 的写通道没闸门（Critical）**：`/api/board/ui/*` 只抓 Cookie，不校验
   Host / Origin / 自定义头。任何能打到 `127.0.0.1:<GUI 端口>` 的页面都能建一条
   `mode=exec, dispatch=auto` 的任务，等于在所有副机上执行 PowerShell。现在每个 handler 前
   过 `uiGuard(req)`：Host 必须回环或在 `uiAllowedHosts`、带 `Origin` 时必须同源、非 GET 必须
   带 `x-dsh-team-ui: 1` + JSON Content-Type。面板自己（`lib/client.js`）已统一带上。
2. **F3/F9 — TTL 升级会用截断列表断言"远端没有"**：`escalateExpiredJournal()` 补上
   `absenceProvable()`（`/tasks` 未截断，或最老一条 `updatedAt` 早于 `sentAt - 5s`）；否则只做
   `blockRetryAt = now + 60s` 并留日志。同轮刚补绑成功的任务（`attachedThisRound`）不再被
   escalate 误标 blocked。
3. **B4 — 假板子语义向真板子对齐**：`take` 写 `taker`、`attach` 置 `running` + 刷 240 分钟
   lease + 清 `taker/holder/dispatch`、`mark` 加状态白名单且 `queued` 时清 `remote_id`。
   这几条之前让 `holderIsUs` / `takerIsUs` / 跨 Host 回写守卫在验收里全是零覆盖。
4. **脚本卫生（安全 F2 的后续）**：`team-hardening.ps1` 输出打码（以前把含 token 的整块配置
   打进 stdout，而 stdout 会落进共享盘 `_remote-logs`）；`_remote-logs` 里已有的两条明文已替换。
   `board_guard_keepalive.ps1` 探活改 `/api/health`（`/api/board` 要 token，401 会让守护每
   10 分钟被误杀）；`board-presence.ps1`、`自驱.ps1` 的读写都带 `x-board-token`。
5. **ACL（安全 F4/F5）**：`_tools` / `_board` / `_remote-logs` 不再继承
   `Authenticated Users:(M)`，显式只留本机所有者与共享盘服务账号可写、`Users` 只读执行；
   `C:\Users\Public\gp_*_hidden.vbs` 的 `INTERACTIVE/SERVICE/BATCH` 降到只读；
   `D:\gp_video\_tools\gp-daemon.ps1` 去掉 `Authenticated Users` 写权。

### 没做的（F11，判定为非缺陷）

`syncRemote()` 读 `t.taker` 做归属护栏，而 `do_attach` 会 `pop("taker")` —— 但 attach 之后任务
本来就归本机，护栏只在任务被别的 Host 重新认领（taker 被重新写上）时才需要，所以不改。

### 验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/ui-guard-smoke.mjs` | 7/7 |
| `node scripts/plugcheck.mjs` | PASS tools=16 routes=12 |
| `node scripts/reload-smoke.mjs` | 场景 A/B/C 全部通过 |
| `node scripts/dispatch-recovery-smoke.mjs` | 71/71 |
| `node scripts/state-file-smoke.mjs` | 16/16 |
| `node scripts/acceptance.mjs`（fixtures + 默认素材） | 10/10 + acc-11 |

### 还要重启才能做的

hub nodeToken 轮换（旧值在公开 git 历史里）、board token 再轮换（当前枚在 `_remote-logs` 里
出现过）、仓库历史清 token（filter-repo 强推或转 private + 撤 PR）。

## v1.3.6 — 2026-11-08

三方复审（代码审查 / 遗留系统 / 安全审计）后的第一批修复。**派工与同步共用闸门**是本版最重的一条：
它让"远端跑完了、板上永远收不到"变成随机现象，而验收恰好跑在绿的半边。

### 修好的

1. **B1 派工与同步互相饿死（Critical）** — `dispatchState` 拆成 `dispatching` / `syncing` 两个闸门。
   以前共用一个 `busy`，语义还是"忙就丢弃"：`dispatchTickMs === remoteSyncMs` 时两个定时器落在同一
   timers phase，dispatch 在第一个 `await` 让出时 `busy` 仍为 true，同一轮里的 sync 回调直接
   `return` —— 远端终态永远不回写。实测修前 `node scripts/acceptance.mjs` 三次两红
   （`acc-11 … 16.39s 同步回写没发生（板子 status=claimed）`），修后三次全绿（0.83s）。
2. **B2 真板子模式不再跑派工用例** — acc-11 在真板子模式下默认 `跳过`：它会建一条 `dispatch:auto`
   的任务并让它跑在真机上，而测试本身没有收尾职责。要真跑必须显式 `GP_ACCEPT_ALLOW_DISPATCH=1`。
3. **B3 "只派一次"现在有断言** — 假 hub 加 `GET /api/_test/stats`（`dispatchCount`/`remoteCount`/
   `remoteIds`），acc-11 在 done 之外断言"只派了 1 次、远端只留 1 条"。以前只看 `remote_id` 非空，
   重复派工留下最后一条也能过。
4. **F2 接管者删不掉记录（High）** — `journalDrop` 以前死认 `rec.holder`：接管者按"崩溃处理"
   拿到了处理权，却在这里被否掉，记录一路留到 TTL；之后每一轮都命中远端并重新 attach，板上
   done 被翻回 running、lease 无限续期。现在与 `holderUsable` 同一口径：超 `INSTANCE_TAKEOVER_MS`
   未更新才允许接管删除，并留一行 trace。
5. **F1 认领/澄清不看归属（High）** — `reconcileUnknownDispatches` 循环头加 `holderUsable`，
   `/api/untake`、`/api/mark` 全部带上 `machine` + `holder`。以前 untake 不带 holder，板子那层
   "双方都提供才比较"的校验直接放行，同机第二个实例能把别人在飞的 claimed 任务放回队列再派一条。
6. **板子 do_mark 校验归属** — 与 untake/release 同口径：传了就比对（`machine`、`holder`），
   传了但不匹配回 409；旧版插件不带这两个字段，行为不变。

### 还没修（按复审顺序，另起版本）

- F3 escalate 缺 `absenceProvable` 截断保护；F9 retry/escalate 同 tick 竞态；F8 observer/pause 仍写板子；
  F11 syncRemote 的 taker 护栏在主窗口失效（`do_attach` 会 pop taker）。
- B4 假板子仍与真板子有系统性偏差（take 不写 taker、attach 不置 running、mark 无白名单、永不 stale）。
- 安全 P0：`/api/board/ui/*` 未鉴权（可被页面 XSS/CSRF 借道 RCE）、board token 曾出现在共享盘
  `_remote-logs`、hub nodeToken 仍等于公开历史值、共享盘 ACL 允许 worker 改守护脚本、
   仓库历史仍含旧 token。

### 验证

| 套件 | 结果 |
| --- | --- |
| `node scripts/plugcheck.mjs` | PASS tools=16 routes=12 |
| `node scripts/reload-smoke.mjs` | 场景 A/B/C 全部通过 |
| `node scripts/dispatch-recovery-smoke.mjs` | 71/71 |
| `node scripts/state-file-smoke.mjs` | 16/16 |
| `node scripts/acceptance.mjs`（fixtures） | 10/10 + acc-11 |
| `node scripts/acceptance.mjs`（默认素材） | 10/10 + acc-11 |
| acceptance 连跑三次 | 三次全绿（B1 修前 2/3 红） |

## v1.3.5 — 2026-11-08

第四轮复核的**测试保真**项（F11/F12）：验收与回归里那套「假板子」和真板子在
taker / dispatch / lease 上系统性偏差，派工链路从来没有被验收覆盖过。

**① 派工链路进验收（acc-11）**

`scripts/fake-board.mjs` 现在同时当 remote-agent hub 的最小替身：实现了插件真正
调用的四个端点 —— `/api/remote-agent/ui/nodes`、`/tasks`（按 `?node=` 过滤、
`updatedAt` 倒序、`slice(0,200)`）、`/task`（找不到回 `404 {error:'task-unknown'}`）、
`/dispatch`（生成 `ui-fake-N`，状态 running）。另加一个验收专用
`POST /api/_test/remote-complete`，用来模拟「副机干完了」。

`scripts/acceptance.mjs` 在原来 10 条用例之后新增 **acc-11 派工链路**：第二次
`apply()` 打开 `autoDispatch`（独立状态目录 + `dispatchTickMs/remoteSyncMs=300`），
`board_dispatch` 建单 → 等板上 `remote_id` 出现（take→dispatch→attach 走完）→
模拟远端 completed → 等板子 `status==='done'`（syncRemote 回写）。任一环没发生
就判失败，并把原因写进报表。

**② 假板子与真板子对齐**

- `do_create` 以前把 `machine` 写成空串，真板子会把 `machine/owner/dispatch` 一起
  落下 —— 于是「指定机器建单」在假板子上等于没指，派工链路一测就露馅。
- 保持 v1.3.3 的 holder 语义：同机不同实例 → `409 held-by-other-instance`；
  `attach/untake/release{queued}` 清 `holder`，`untake` 与 `release{queued}` 清
  `remote_id`（复核 F8）。

**验证**

- `node scripts/acceptance.mjs`（默认素材）：11/11，acc-11 走完整条派工链路。
- `GP_ACCEPT_FIXTURES=1 node scripts/acceptance.mjs`：11/11（CI 用的就是这条）。
- plugcheck `PASS tools=16 routes=12`；reload-smoke A/B/C；dispatch-recovery 71/71；
  state-file 16/16。

**仍未做**：hub `nodeToken` 轮换（旧值已公开，需三台一起重启）；仓库历史里
`1068cab` 仍留着旧 nodeToken（转 private 或 filter-repo 重写历史）。

## v1.3.4 — 2026-11-08

第三轮复核（代码审查 + 遗留系统 + AI 安全审计）的**不重启可做项**：同机双实例的
journal 串账、升级 blocked 的时序与判据、状态文件的守卫与看板的鉴权加固。

**① 同机两个 Host 共用一份 journal，会互相删凭据（🔴）**

journal 文件名只由 `machine + boardUrl` 决定，同机两个 DSH 进程写同一份。B 实例
`journalSet(taking)` 把 A 的 `unknown` 覆盖掉，take 拿到 409 之后再 `journalDrop` ——
删掉的是 **A 的记录**。A 崩在 dispatch/attach 之间时，板上停在 claimed、本地一条凭据
都不剩，12 分钟租约过期后被重派，同一条任务在副机上跑两遍。

- 条目带 `holder`（`<machine>#<pid>-<rand>`）：`journalSet` 自动盖章；
  `journalDrop` 只删自己的；别人的记录超过 90 秒没更新才允许接管（`dispatch journal takeover`）。
- resume 侧同样按 holder 过滤（resume 不过 `/api/take`，没有板子那层护栏），
  队列认领前也先看这条记录是不是别人正在处理。
- 面板/工具可见 `holder` 与 `leaseUntil`（`snapshot()` 以前不映射这两个字段）。

**② 补绑与升级 blocked 的时序（🔴/N1）**

- `escalateExpiredJournal()` 跳过 `pendingAttach` 里正在补绑的任务 —— 同 tick 刚补绑
  成功就被标 blocked，会出现"板上 blocked、副机上还在跑"。
- 反查 `/tasks` 失败时不再往下标 blocked：查不到 ≠ 没有，推迟 60 秒再判。
- `released` 相位到 TTL 只清账，不再被无条件标 blocked（它已经放回队列，由队列重派）。

**③ 观测与细节**

- take 返回 401/403 时打一行 `dispatch 认领被拒（HTTP 401）：板子鉴权不通过…` ——
  以前被 `isUnknownOutcome` 归为"已知失败"，只退避不记日志，板上零痕迹。
- `dispatchRole` 拼错（`Observer`/`readonly`）按 owner 跑但会明确告警；
  `dispatchTickMs`/`remoteSyncMs` 用有限性判断，不再让 `Number(0) || 6000` 吞掉 0。
- `heldTraced`/`revokedTraced`/`pendingNoted` 改成有界集合（`rememberOnce`），不再只增不减。
- `retryPendingAttach` 的失败分支加 60 秒退避（以前 `tries % 20 === 0` 恒真，每 4 秒
  打一次 `/api/mark` + 一行日志）；补绑放弃前先反查远端，命中就只补绑不标 blocked。
- dispose 的每一步都包 `safeStep`：某一步抛异常不会连带跳过 disposers/定时器清理。

**④ 测试**

- 新增 **R22**（同机另一实例的在途记录：不补发、不删除、holder 不变）、
  **R23**（反查接口 500 时不许标 blocked、凭据保留、板上状态不改）。
- `state-file-smoke` 用例 5 改成**确定断言**（锁是目录 → 必须是 `wait-timeout` 且内容不改写），
  并新增 5b「真僵尸锁（utimes 老化）→ rename 抢占 → 拿到锁并写入」：**16/16**。
- 变异验证：去掉 holder 护栏 → R22 挂（dispatch=1）；把反查失败当"没有" → R23 挂
  （mark=1、板上 blocked）。全套 71/71。

**⑤ 板子与守护脚本（不重启 DSH 就能生效的部分）**

- `board_server.py` v4：无 token **拒绝启动**（fail-closed）、单实例锁（Windows 上用
  `OpenProcess` + `GetExitCodeProcess` 判存活，`os.kill(pid,0)` 在 Windows 上会误判僵尸）、
  Origin 白名单（`GP_BOARD_ORIGINS`）、`Content-Type: application/json` 校验、看板 HTML
  全量 `html.escape`、token 按 bytes 比较（非 ASCII 不再抛 TypeError）。
- `do_release`/`do_mark`/`do_untake` 增加 holder 校验；`release{queued}` 恢复 `dispatch`；
  `mark{queued}` 清 `taker/holder/remote_id`；`remote_id:''` 改成 `pop`。
- `board_guard.ps1` / `启动作业板.bat` 改 fail-closed：探活看公开的 `/api/health`（以前
  探 `/api/board`，401 被当成"挂了"→ 拉起无 token 的裸板子）、token 从
  `%USERPROFILE%\.dsh\board-tokens.txt` 读，读不到就只告警不启动。
- `host_watch.ps1` / `进度播报.ps1` 读板子时带 `x-board-token`。
- 明文 token 洗地：仓库里 `docs/issue-10/05-*` 的 nodeToken 真值已改为 `<nodeToken>`
  （commit `0fd2043`）；共享盘 25 个文件里的 hub token / 旧 board token 已替换为占位符；
  板子改为双 token 过渡（`GP_BOARD_TOKENS`），旧枚等三台 Host 换完再撤。

**尚未做（需要重启 DSH）**：轮换 hub `nodeToken`（旧值已公开，必须换）、给 GT14/MB14
换新 board token、板子撤旧 token、清 `%TEMP%` 与共享盘的 token 文件与会话残留、
仓库历史清 token（改 private 或 filter-repo）。


## v1.3.3 — 2026-11-08

上一轮复核（代码审查 + 遗留系统）剩下的 7 组问题。三组会真的做错事，先修这三组。

**① 状态文件锁可能把 Host 主线程卡死（🔴）**

`withFileLock()` 在"僵尸锁抢不掉"时走 `continue`，把 `waitMs` 预算整个绕过了；
锁路径又恰好是个目录时（`rmSync` 报 EISDIR 被吞、`openSync('wx')` 在 Windows 上
仍回 EEXIST），循环永不退出。探针里子进程 4019ms 被 SIGTERM 才停 —— 在真 Host 里
就是主线程永久阻塞，而且一行日志都没有。

- 任何分支都必须过预算：`outOfBudget()` 在循环末尾统一判，超时返回
  `{ ok:false, busy:true, error:'wait-timeout' }`。
- 抢僵尸锁改用原子 `renameSync`（`<lock>.stale-<pid>` 抢到再删），不再 `rm + open`
  两手；（复核 F9 的 TOCTOU 一并消掉）。
- 抢锁失败连续 40 次 → `stale-lock-stuck`；成功抢占连续 5 次 → `stale-lock-churn`
  —— 两种病态都如实返回，不硬写也不空转。
- `fn()` 抛异常转成 `{ ok:false, why:'fn threw' }`，不逃到 `dispatchOnce` / `dispose`。
- `dispose()` 的每一步改成 `safeStep(name, fn)`：某一步失败只 trace，不影响后面
  释放 disposers 与定时器。

**② 同一台机器上两个 DSH 进程会重复派工（复核 F1）**

板子 `do_take` 对"同一个 machine"是幂等续租（200 + reentrant），于是同机的第二个
进程会把第一个的占位当成自己的重入，两边都往下 `/dispatch` —— 同一条板上任务在
副机上跑两遍。

- 插件每次 apply 生成实例身份 `INSTANCE_HOLDER = <machine>#<pid>-<随机>`，
  `/api/take` 一并上报 `holder`。
- 板子 `do_take`：同 machine 但 holder 不同 → `409 已被同机的另一个实例占住`；
  attach / untake / release(queued) 清 holder。
- 顺带修 F8：untake / release(queued) 把任务放回队列时清掉 `remote_id` ——
  否则带着 remote_id 回 queued 的任务会被所有 Host 的 `!t.remote` 过滤跳过，
  永远派不出去。
- ⚠️ 需要重启板子服务（8965）才生效；旧板子会忽略 `holder` 字段，插件侧行为不变。

**③ observer / probe / 退避 / TTL 四处逻辑错位**

- observer 闸门原来在 `dispatchOnce` 最前面，把 `retryPendingAttach()` 与
  `escalateExpiredJournal()` 一起跳过 —— 在途任务无人收尾。现在先做收尾，再闸门。
- `dispatchRole` 拼错（`Observer` / `readonly`）原来静默变 owner，现在归一化后
  仍认不出的值会在 ready 时 trace 配置值，并按 owner 运行。
- `probeRemoteTask()` 原来把任何 404 都当"远端没有这条任务"并直接标 failed；
  现在只认 `task-unknown`（hub 的真实契约），其它 404 归 `known:null` 继续观察。
- `retryPendingAttach()` 标 blocked 失败后 `tries` 不再增长，`tries % 20 === 0`
  恒真 → 每 4 秒一次 /api/mark + 一条日志；现在失败后 60 秒再试
  （`pendingAttachRetryAt`），成功或清理时删除。
- TTL 过期条目原来先从盘上抹掉、下一 tick 才升级 blocked，中间崩溃即永久丢凭据；
  现在过期条目带 `expired:true` 留在盘上，升级成功才 `journalDrop()`。

**④ 细节与测试保真**

- `Number(x) || 6000` / `|| 4000` 会吞 0：`dispatchTickMs` / `remoteSyncMs` 改
  `Number.isFinite` 判断；`bumpBackoff` 的指数上限 4 → 5，与注释的 5 分钟一致。
- `heldTraced` / `revokedTraced` / `pendingNoted` 换成 `rememberOnce()`（上限 2000，
  超了按插入顺序淘汰），长跑不再只增不减。
- `state-file-smoke` 补两条负向用例：锁路径是目录、状态目录的父路径是文件。
- `reload-smoke` 场景 B 原来只 `console.log`，现在断言"旧实例未 cleanup 时第二次
  apply 必须因路由撞名失败、且旧路由不动"，并计入失败。
- `dispatch-recovery-smoke` 的假板子开始建模 taker/holder（`/api/take` 不再硬编码
  `taker='host'`，同机异实例回 409；attach 清 taker/holder；untake 清 remote_id），
  新增 **R21**：同机两实例并发只允许派一次。
- `acceptance.mjs`：`autoDispatch:false`、状态目录走临时 `DSH_TEAM_STATE_DIR`、
  `GP_BOARD_PY` 指向真板子时必须显式 `--allow-live-board`，否则拒绝运行。

验证：`plugcheck PASS tools=16 routes=12`；`reload-smoke` A/B/C 全过；
`dispatch-recovery-smoke` **65/65**（R1–R21）；`state-file-smoke` **12/12**；
`acceptance` fixtures 10/10 + 真板子模式拒绝运行（退出码 2）。
变异验证：去掉 `holder: INSTANCE_HOLDER` → R21 挂（dispatch=2、远端两条）。
## v1.3.2 — 2026-11-08

文档：新增 `docs/issue-10/08-exec-policy.md`（#10-4）—— 部署级命令执行策略。

写清四件事：

- `sh_*` 的真实能力边界：`allowedRoots` 只对路径参数做 realpath 前缀比较，
  **不限制命令内容**；超时只 kill 直接子进程；执行账号就是 DSH 当前用户。
- 四条通道的默认状态与守卫：板子 8965（默认无 token、绑 0.0.0.0）、remote-agent
  hub 19387（nodeToken + TOFU pin）、插件 GUI 路由（无鉴权但只监听 127.0.0.1）、
  `sh_*`（路径白名单）。
- 按可能性排序的威胁模型 + 四台机的推荐配置表（owner/observer、allowedRoots 别留空、
  需要把关的机器把 dispatchApproval 设 manual）。
- 明确不做的事：不做沙箱、不做 RBAC、不做审计合规、不清理孙进程。

README 增加"文档索引"表，并在 `allowedRoots` 注释里指向这份文档。

## v1.3.1 — 2026-11-08


复核里剩下的「多实例并发写 journal」：`dispatch-journal` / `pending-attach` 都是
"读回磁盘 → 合并 → 原子写"，原子写挡不住两台 Host 同时读改写（A 写 [x,a]、B 写
[x,b]，a 就没了；同理两边各自删也可能把对方刚清的记录写回来）。

- 新增 `lib/state-file.mjs`：`withFileLock()`（`<file>.lock` + O_EXCL，僵尸锁超时
  抢占，等不到返回 busy 而不是硬写）、`writeStateJson()`（tmp+rename、退避重试）、
  `sleepSync()`。原 index.js 里的本地副本删除，避免两套实现漂移。
- `saveDispatchJournal()` / `savePendingAttach()` 的读-合并-写整段进锁；拿不到锁时
  trace 写明"被另一个实例锁着、内存里还有几条在途，下一轮再试"，墓碑保留。
- 新增 `scripts/state-file-smoke.mjs`（8 项）：4 个子进程 × 10 次并发读改写不丢
  更新、僵尸锁可抢占、活锁返回 busy 且不写、锁释放后立刻能写、原子写无残留。
  用例必须用 `spawn` 真并发（`spawnSync` 会退化成串行，变异验证时踩过）。
- `dispatch-recovery-smoke` 新增 R20：journal 旁放 5 分钟前的僵尸锁，派工照常完成。
- CI 增加 `node scripts/state-file-smoke.mjs` 一步。

验证：state-file-smoke 8/8；dispatch-recovery-smoke **61/61**；plugcheck
`PASS tools=16 routes=12`、reload-smoke、acceptance 不受影响。变异验证：去掉锁 →
并发用例 40 掉到 9。

## v1.3.0 — 2026-11-08


#10-2 说"先明确谁有 autoDispatch 权"，另外复核里一直挂着「attach 不校验远端仍在」
这件事（v1.2.2 交付时故意没做，因为单看"查不到"会把好任务误标 blocked）。这一版
把三件事一起做了，都不需要板子改协议：

- **`dispatchRole`: owner / observer**（默认 owner）。observer 的 `dispatchOnce()`
  第一行就返回 —— 它连 reconcile 都不跑，否则同一块板子上的两台 Host 会互相把对方
  在跑的任务 untake 回队列。observer 仍会回写自己历史上派出去的任务终态。
- **attach 前核实远端任务还在**：`attachTask()` 先 `GET /api/remote-agent/ui/task`，
  404 就不写 `remote_id`，把板子任务标 failed（note 写清原因），并清掉待补绑记录。
  查不清（超时/5xx）时照旧容错，不阻拦 attach。
- **回写前校验任务归属**：`syncRemote()` 发现板上 `taker` 已经不是本机就不再写终态
  （日志每任务一行 `remote sync skip …`）——被别的机器抢走的任务不再被旧 Host 覆盖。
- 新增配置 `remoteSyncMs`（回写节拍，默认 6000ms；隔离 harness 压到 300ms）。

验证：`dispatch-recovery-smoke` 新增 R17（observer 不派工）、R18（远端查不到 →
不 attach、remote_id 为空、板子 failed）、R19（任务被别的机器认领后不回写），
共 **59/59** 通过；变异验证 M5/M6/M7 三组分别被 R17/R18/R19 抓住（连旧的 M1–M4
一起，七组全中，恢复后复跑全绿）。plugcheck 仍 `PASS tools=16 routes=12`，
reload-smoke 场景 A/C、acceptance 10/10 不受影响。

文档：`docs/issue-10/07-dispatch-roles.md`。

## v1.2.4 — 2026-11-08


v1.2.3 把「反查不到 ⇒ 放回队列」这类误判按 goal 与时间窗口收紧了，但还剩一条：
**反查列表本身会被截断**。hub 的 `/tasks` 是 `tasks.slice(0, 200)`、按 `updatedAt`
倒序 —— 节点上任务攒到 200 条以后，我们这条在途任务会被切到窗口外，"查不到"就变成了
"远端没有"，于是 untake 再派一条：**又是一次重复执行**。

- **截断时不判定"没有"**：`/tasks` 返回正好 200 条、且可见窗口里最老的一条还比
  发出时刻新 ⇒ 无法确认远端有没有这条任务。此时保持 `unknown`，记 `unresolved`
  次数，不再 untake、不再重派。
- **有界收尾**：`unresolved` 到 3 轮仍无法确认 ⇒ 走同一套 blocked 升级（标板子、
  写清"远端任务列表被截断，请人工确认"），不会无限挂着。
- **反面同样要成立**：窗口确实覆盖到发出时刻（可见最老记录早于 `sentAt`）时，
  "没有"是可判定的，照常放回队列 —— 否则一个永久卡住的节点会把所有任务都锁死。

验证：`dispatch-recovery-smoke.mjs` 扩到 **52 项**，新增
R16（200 条全比发出时刻新 → untake=0、dispatch=0）、
R16b（窗口跨过发出时刻 → 照常澄清 untake=1）。
变异验证：把截断判定退回"一律可以判定没有" → R16 立刻挂（untake=1、dispatch=1）。
`plugcheck` `PASS tools=16 routes=12`、`reload-smoke` 场景 A/C、`node --check` 均通过。

## v1.2.3 — 2026-11-08

代码审查工程师用 5 个探针把 v1.2.0–v1.2.2 又打穿了一遍：**修住的都是"理想路径"，
剩下的漏洞全在"远端那条任务到底建没建"这个中间态**。这一版按复核给的顺序补齐。

- **D3 reconcile 抢在快照之前**：原来 reconcile 拿不到板上 `remote_id`，崩在
  "attach 成功、删 journal 之前"时会把**正在跑**的任务 untake 再派一条，而且 untake
  之后 `syncRemote` 不再盯它（watched 只含 running/claimed/stale），旧任务的结果
  永远回写不了。现在 `dispatchOnce()` 先取快照再 reconcile；板上已有 `remote` → 只清账
  不动板子；板上 `running` → 一律不允许 untake。
- **D4 同 goal 的两条板子任务认领同一条远端任务**：`matched` 只排除"本轮已分配"的，
  不排除板上**其它任务已经引用**的 `remote_id`。现在建 `occupied` 集合参与候选过滤，
  且**只有唯一候选才认领**（多候选宁可不猜）。
- **D2 goal 全等比较 + 5 s 跨机窗口**：板子存原文，remote-agent `hub/ui-routes.js`
  落库前会 `body.goal.trim()`，两边空格不同就判"远端没有"→ 重派。探针实测 4 秒内
  副机真建了 7 条同名任务、板上 `remote_id` 仍为空。现在两侧都走 `normGoal()`
  （合并连续空白、去首尾）。
- **D1 attempts 上限永远到不了**：untake 成功就删条目，下一轮 `attempts` 从 0 起算，
  `MAX_DISPATCH_ATTEMPTS` 和 2 h TTL 都是死代码（探针 9 秒内 dispatch=15 / untake=14）。
  现在澄清后写 `phase:'released'` 并**保留 attempts**，只有 attach 成功或 mark 确认
  成功才删条目；同时加 `taking` 相位（take 成功、请求还没发出去时就崩的场景，防 S7 孤儿）。
- **S2 永久 4xx 无退避**：探针 6 秒内 dispatch=29。现在 `dispatchBackoff` 指数退避
  （15 s 起、翻倍、封顶 5 min），日志写明"多少秒后再试"。
- **D5 墓碑清得太早**：`journalRemoved.clear()` 跑在写盘之前，写盘一失败，已删条目
  会被下一次"读回-合并"复活（探针 P5）。现在写成功后才清墓碑；`writeStateJson` 的
  rename 重试带 20/50/100 ms 退避。
- **D6 mark blocked 失败仍删凭据**：板上留永久 `claimed` 却没人再管（探针 P3）。
  现在只有 `marked.ok` 才删，失败保留并 `blockRetryAt = +60s`。
- **S3 journalSet 写盘失败仍继续发**：现在"发请求前那次 unknown 写"失败就 untake
  回来并跳过本轮（宁可晚一轮，也不在状态没落盘时发不可撤回的请求）。
- **S5 TTL 升级前先查远端**：可能把"其实已经建好、只是回执丢了"的任务标成 blocked，
  而 blocked 不在 `syncRemote` 的 watched 里。现在升级前按 `normGoal` + `sentAt` 反查，
  命中就只补绑。**S4** `retryPendingAttach` 加了 20 次上限，到顶标 blocked。
- **S1 暂停假成功**：`dispatch-pause` 只等 3 s，写超时 20 s，超时仍回 `paused:true`，
  面板据此把在途任务 release 成 superseded。现在返回体多一个 `stopped` 字段，面板
  `runCleanup()` 会二次确认；仍停不住就**不归档任何任务**并提示稍后再点。

验证：`dispatch-recovery-smoke.mjs` 扩到 **48 项**（R1–R15，含 R12b），新增
R9（goal 空白差异仍能反查）、R10（mark 恒 500 时凭据不丢）、R11（在跑的任务绝不 untake）、
R12/R12b（同 goal 不共享远端任务、不抢别人已占用的）、R13（写盘失败后被删条目不许复活）、
R14（永久 4xx 有退避）、R15（结果永远未知 → attempts 有界、最终 blocked）。
变异验证三组：`normGoal` 退回裸比较 → R9 挂；去掉 `occupied` → R12b 挂；
`released` 退回直接删条目 → R15 挂（dispatch=8）。恢复后 48/48 全绿，
`plugcheck` `PASS tools=16 routes=12`、`reload-smoke` 场景 A/C、`node --check` 均通过。

## v1.2.2 — 2026-11-08

v1.2.1 修完会"双跑"的两条之后，接着补复核清单里剩下的状态文件纪律与暂停竞态。
这一版不改派工决策，只让**在途状态不再丢、暂停真的停得住**。

- **H6 journal 整文件覆盖**：`saveDispatchJournal()` 以前只按内存内容整文件重写，
  同一台机器上第二个 Host 实例刚写进去的在途条目会被抹掉。现在与 `pendingAttach`
  同一套纪律：**先读回磁盘 → 合并（内存覆盖）→ 原子写**，本实例删掉的条目留
  墓碑（`journalRemoved`），避免被合并"复活"。临时文件名也从共用的 `<file>.tmp`
  改成 `<file>.<pid>.tmp`（两个实例同时写会互相踩临时文件）。
- **H7 写盘失败静默**：原来 `save failed` 只打一句 message，读的人无从判断后果。
  现在带文件路径、错误码、内存里还剩几条，并说明"下一次状态变化会再试"。
  `writeStateJson()` 对 `renameSync` 做 3 次重试（Windows 上偶发 `EPERM`）。
- **reconcile 未受暂停/inFlight 保护**：reconcile 里有 `untake`/`mark` 两个远端写，
  以前既不计入 `inFlight` 也不看 `pausedUntil` —— 面板"暂停 → 读快照 → 归档"期间
  它仍可能在改板子。现在整段包进 `inFlight`，且每条开始前复检暂停。
- **每个 unknown 条目各打一次 `/tasks`**：改为按 `nodeId` 缓存，同一节点本轮只查一次；
  失败结果也缓存（否则 20 s 写超时会把整轮 busy 拖满）。

验证：`dispatch-recovery-smoke.mjs` 加到 **27 项**，新增
R8（另一个实例在启动后写入一条在途记录，本实例派工落盘时必须保留它）。
变异验证：把合并逻辑退回"只按内存写"，R8 立刻失败（`[]`，记录被抹掉）。
`plugcheck` `PASS tools=16 routes=12`、`reload-smoke` 场景 A/C、`node --check` 均通过。

## v1.2.1 — 2026-11-08

v1.2.0 的派工恢复在两位复核者（遗留系统工程师 / 代码审查工程师）手里被打穿了两处，
而且失效方式都是**同一条任务跑两遍**。这一版修的是"状态机本身能不能表达「已发出、结果未知」"。

- **B1 `claimed` 相位混用**：v1.2.0 是「先写 `claimed` → 再 POST → 成功后才删」，
  于是 `claimed` 同时表示"肯定没发出"和"可能已发出"。POST 在飞（最长 20 s）时崩掉，
  恢复路径不 take、不查询、直接补发 → 副机上已有的任务被派第二遍。
  现在 `claimed` **只表示 dispatch 一次都没发出**；真正发请求之前先落盘
  `phase=unknown` + `sentAt` + `attempts`。旧版本遗留的 `claimed`（无 `attempts`）
  在加载时按 `unknown` 处理，`sentAt` 取 `at - 20 s` 保守回退。
- **B2 反查窗口用错时间点**：v1.2.0 用 `since = at - 5 s`，而 `at` 是**失败那一刻**，
  已包含整段请求耗时（写超时可达 20 s）—— 远端任务的 `createdAt` 恒在窗口外，
  于是每次都误判"没发出去"再重派一次。现在下界按**发出时刻** `sentAt - 5 s` 算，
  并加 `until = at + 5 s` 上界；同一轮内用 `matched` 集合防止两条板子任务绑到同一条远端。
- **B3 字段名写错**：drop 分支读 `t.remote_id`，而 `snapshot()` 映射出来的是 `remote`，
  导致"板上已回绑"的分支永远不成立，残留 `claimed` 会被直接补发、`remote_id` 被覆盖。
- **H3 attach 与 journal 的先后**：以前先删 journal 再 attach，崩在中间会留下
  "板上 claimed、无 remote_id、无 pendingAttach、无 journal" 的孤儿任务。现在
  journal 活到 attach 有结论为止（失败那一路由 `pendingAttach` 接管）。
- **H4/H5 无界重派 + 静默丢弃**：新增 `MAX_DISPATCH_ATTEMPTS = 3`，到上限后把任务
  标 `blocked` 并写明原因（不再无限 untake 重派；也不再让 2 小时 TTL 把未决条目
  静默扔掉，过期条目改为逐条升级 `blocked`）。
- **中档三条**：板上 taker 是别的机器时不再当成本机"已认领未发出"补发；
  `untake` 只有成功或 409 才清条目（超时/5xx 保留，下一轮再试）；
  `unknownGraceMs: 0` 不再被 `|| 30000` 吃掉。
- **测试**：`dispatch-recovery-smoke.mjs` 从 14 项加到 **25 项**，新增
  R4（慢请求窗口：`sentAt=now-15s`、`at=now`，必须认出远端那条任务）、
  R5（板上已回绑 → 不补发、`remote_id` 不被覆盖）、
  R6（taker 是别的机器 → 不抢单）、R7（attempts 到上限 → 标 blocked、不再派工）。
  并做了变异验证：把 B2/B3 的旧写法改回去，R4/R5 会各自失败（`dispatch=1`、
  `remote_id` 被新号覆盖），证明用例真的能抓住这两个缺陷。
- **回归**：`plugcheck` `PASS tools=16 routes=12`；`reload-smoke` 场景 A/C 全过；
  `node --check lib/index.js` 通过。

## v1.2.0 — 2026-11-08

派工恢复（GitHub issue #10 建议 1）的第一版实现。v1.1.13 把写路径超时抬到 20 s
只是"多等一会"，这一版回答的是**超时之后到底发没发出去**。

- **问题**：一条任务的派工要跨三步 —— `take`（板子认领）→ `POST /api/remote-agent/ui/dispatch`
  （真正派出）→ `attach`（回绑远程任务号）。任何一步只要"发出去却没收到回执"（超时、
  连接被断、5xx），v1.1.x 都是 `untake` 之后下一轮重来。对 `take`/`attach` 尚可，
  对 `dispatch` 是错的：超时那一刻副机上可能已经开跑，重派就是同一条任务跑两遍。
- **做法**：把在途派工的状态持久化到
  `~/.dsh/dsh-team/dispatch-journal-<machine>-<boardTag>.json`，只留三个相位：
  - `claimed` —— 板子已认领、dispatch 还没发出。崩在这里（或认领结果未知），
    下一轮按板上 `taker/status` 判定：确实占着就直接补发，**不重新 take**；
  - `unknown` —— dispatch 已发出但结果未知。下一轮**先查询**：拿 `goal` + 创建时间
    去 `/tasks` 反查，远端确有这条任务就只补绑定、绝不重派；确认没有（超过
    `unknownGraceMs`，默认 30 s）才 `untake` 放回队列重派一次；
  - 回绑失败的那一支不进这里，仍由 `pendingAttach` 负责（只重试 attach）。
- **超时**：写路径（POST）默认 `max(cfg.timeoutMs, 20000)`，读路径保持 `cfg.timeoutMs`
  —— 调度 tick 不会被慢写拖长；`writeTimeoutMs` / `dispatchTickMs` / `unknownGraceMs`
  可配，仅用于隔离验证。
- **观测**：新增四条日志，故障时直接看得见走到了哪一步：
  `dispatch resume …（不重新 take）`、`take unknown …（下一轮按板上 taker 判定）`、
  `dispatch unknown …（先查远端再决定，不重派）`、
  `dispatch recovered …（结果未知 → 远端确有此任务，只补绑不重派）`。
- **验证**：新增 `scripts/dispatch-recovery-smoke.mjs`（假板子 + 假 hub，14 项断言）：
  - R1 结果未知但远端已建任务 → `/dispatch` 只调 1 次、`attach` 1 次、`untake` 0 次；
  - R2 结果未知且远端确实没有 → 澄清后 `untake` 1 次、重派 1 次、最终只建 1 条远端任务；
  - R3 已认领未发出（崩溃恢复）→ `take` 0 次、直接补发并回绑。
  另外 `plugcheck`（`PASS tools=16 routes=12`）与 `reload-smoke`（场景 A/C）无回归。

## v1.1.13 — 2026-11-08

派工恢复当天顺手修掉的一个"看起来只是面板不刷新"的问题。

- **现象**：DSH 重启后第一次 `caps` 上报打出 `caps reported ok=false machine=host shell=true`，
  但机器明明是好的，下一个 10 分钟周期又可能自己好起来。
- **根因**：板子写路径比读路径慢——实测 `POST /api/caps` 用 **6111 ms**，
  而 `call()` 对所有请求共用 `cfg.timeoutMs = 8000 ms`，启动瞬间（板子还在处理
  `/api/board` 的 110 KB 快照）就容易贴边触发 AbortError，被记成 `ok=false`。
- **修法**：
  - `call(method, path, body, opts)` 支持按调用覆盖超时；`caps` 上报用
    `Math.max(cfg.timeoutMs, 20000)` 的独立超时，不再和读路径抢同一根橡皮筋。
  - `caps reported ok=… took=NNNms`：加上实际耗时；失败时再补 `status=` / `error=`，
    以后一眼能分清是超时（`status=0`）、4xx 还是 5xx，不必手工复现。
- 副作用范围：只动了 `call` 的可选参数与 `reportCaps`，其余调用点超时行为不变。
- 说明：板子 `/api/board` 单次约 6–7 s / ~110 KB 仍是真的慢，根治在板子侧
  （增量查询或缓存）；插件侧这次只是把写路径从读路径的超时里摘出来。

## v1.1.12 — 2026-11-08

派工停机 8 小时才被发现，问题不在派工逻辑，而在**它停下来的方式**。

- **现象**：2026-11-07 深夜建的两条 `dispatch: auto` 任务（MB14 agent / GT14 exec）一直
  停在 `queued`，板子上没有任何报错，`_runtime.log` 里也找不到一条 take / dispatch / skip。
- **根因（环境）**：11-07 晚 profile 重建时 `cordis.patch.yml` 被截断过，
  `remote-agent` 那一行（hub，`<board-host>:19387`）丢了，包还在但插件没被加载。
  `GET /api/remote-agent/ui/nodes` 落到通用鉴权围栏上返回 401 ⇒ dsh-team 拿到的节点表为空。
- **根因（代码）**：`dispatchOnce()` 在「节点表为空」和「读板子失败」两处都是
  `return 0` —— 一句话都不记。于是故障表现成"任务永远排队"，而非"派工通道断了"。
- **修法**：这两处各补一条限流日志（60 秒最多一条）：
  - `dispatch idle: remote-agent 没有在线节点（nodes 请求失败: …/nodes=0），检查 hub 是否加载、19387 是否在听、worker 是否连上`
  - `dispatch idle: 读板子失败 <error>（<hint>）`
- 判据：只要 hub 挂了，日志一分钟内就会自证，不必再靠"任务为什么不动"反推。

## v1.1.11 — 2026-11-07

受控重载实测（DSH `0.2.2-rc.1`）暴露的问题与修法：

- **现象**：面板「禁用 → 启用」dsh-team 之后，新实例在第一条路由上抛
  `webserver: duplicate exact route "/api/board/ui/summary"`，整插件 `failed`，面板与工具全部僵住，
  只能重启 DSH 才能装回来。日志里 apply 跑到第 5 行就断了，没有任何 dispose 记录，
  而旧实例的 caps 心跳还在继续刷（`caps reported ok=true`）。
- **根因判定**（用新增的 `scripts/reload-smoke.mjs` 隔离复现，不碰真实 DSH）：
  插件自己的 cleanup 是干净的 —— apply → cleanup → apply 到同一个 webserver，
  12 条路由清空后重新注册不撞名。这次是**宿主没有调用插件的 cleanup 就再次 mount**，
  属于宿主侧热重载限制；插件侧能做的是"失败时别留半套、并且说清楚原因"。
- **sh_\* 四个工具的 disposer 没收进回收清单**（`lib/shell.js` 只注册不返回，`lib/index.js` 也没接）：
  cleanup 之后工具表里还留着 4 个 `sh_*`，重载一次多一套。现在 `registerShellTools` 外面包一层
  只转发 `tools.register` 的收集器，和 12 条路由一起回收（reload-smoke A5 用例）。
  - 收集器第一版写成 `Object.create(ctx)` 再赋值 `.tools`，在真宿主上直接抛
    `cannot set property "tools" in multiple fibers` —— cordis 的 ctx 是带服务 setter 的代理，
    派生对象上再赋值等于重复声明服务。整个 apply 停在这一行之前，插件 entry 变 `failed`，
    面板桌宠只剩 🐟 占位（`<img>` 取不到 `/api/board/ui/pet.png` 时的 fallback）。
    改为普通转发对象后正常；reload-smoke 的假 ctx 也加了同样的 setter 保护，防止再犯。
- **半装载整体回滚**（`lib/index.js`）：路由注册中途抛错时，把已经注册的工具/路由/事件订阅全部摘掉
  再抛，日志 `apply aborted before ready, rolling back N resource(s)`；撞上 `duplicate ... route`
  时额外打一条提示：上次实例没被卸载，热重载不安全，需要重启 DSH。
- **卸载路径补日志**（`lib/index.js`）：`dispose start resources=N` → `dispose released resources=N`
  → `dispose done`。以前卸载路径一行日志都没有，排障时无法判断"到底有没有人调过 cleanup"。
- **新增 `scripts/reload-smoke.mjs`**：假 webserver 复刻 `dsh-host-webserver` 的语义
  （同路径第二次注册即 `throw`，disposer 只删自己那条），跑三个场景 ——
  A 正常重载必须全绿、B 旧实例没 cleanup 时的失败形态（只记录）、C 注册到一半失败的整轮回滚必须全绿。

验证：`node --check lib/index.js` 0 错、`node scripts/reload-smoke.mjs` A/C 全过、`plugcheck` PASS（16 工具 / 12 路由）。

## v1.1.10 — 2026-11-01

朋友复核 #8 / #9（基线 v1.1.9 / `3cb8753`，均已复现）的最小修法：

- **#9 待回绑记录按身份隔离 + 合并写入**（`lib/index.js`）：
  - 文件从全用户共享的 `~/.dsh/dsh-team/pending-attach.json` 改为
    `pending-attach-<machine>-<boardTag>.json`（machine 取本机身份，boardTag 取配置的 boardUrl
    的 sha1 前 8 位），同一系统用户下的多个 Host/profile 不再互相覆盖。
  - 写入改为"先读回磁盘 → 按 taskId 合并（本实例内存优先）→ 剔除已补绑成功的条目 → 写临时文件再 rename"
    的原子流程，另一个实例补绑成功也不会把本进程尚未恢复的记录整文件抹掉。
  - 首次升级会回退读旧的全用户共享文件，日志 `pending attach migrated from legacy file`，
    不丢 v1.1.9 已记录的待补绑任务。
- **#8 暂停要真的停手**（`lib/index.js`）：
  - `dispatchOnce` 的循环内、每条任务开始前重新检查 `pausedUntil`，中途设暂停会立即 `break`，
    不再出现"暂停已确认、本轮仍 take/dispatch"。
  - `dispatchState.inFlight` 包住 take→dispatch→attach；`/api/board/ui/dispatch-pause` 设置暂停后
    等 inFlight 归零（最多 3 秒）才返回，回执新增 `inFlight` / `waitedMs`。

验证：`node --check` 0 错、`plugcheck` PASS（16 工具 / 12 路由）；运行时验证见 v1.1.11
（面板「禁用→启用」重载实测 + `scripts/reload-smoke.mjs` 隔离复现，证据见
`docs/issue-10/04-reload-smoke-2026-11-07.md`）。

## v1.1.9 — 2026-11-01

待补绑记录的读回路径加固（#4 的收尾，受控重载测试发现的两处）：

- **兼容单个对象**（`lib/index.js` `loadPendingAttach()`）：`savePendingAttach()` 写的是数组，
  但手工编辑/旧格式可能是单个对象，原来 `Array.isArray()` 判假就静默跳过 ——
  "记录明明在、却一条都没补绑"。现在统一归一成数组再读。
- **读取失败留痕**：`loadPendingAttach()` 的 catch 不再吞掉异常，非 `ENOENT`
  会记 `pending attach load failed: …`，避免同类问题再次变成查不出来的静默 bug。

验证（受控重载）：先写入一条指向假远程号的记录 → 重启 → 日志出现
`pending attach restored: 1 条待补绑`，随后 `attach retried ok bd-pendattach2-191950
remote=ui-pendprobe-191950`，板子任务转 `running` 且 `remote_id` 已写，文件回到 `[]`。

## v1.1.8 — 2026-11-01

复核遗留的三处调度器健壮性缺口（对应 issue #2 / #4 / #7 的二次复核意见）：

- **#2 批量派工不回加负载**（`lib/index.js`）：`load` 只在每轮轮询开始时按 running 任务算一次，
  循环里派出成功后不回加，导致同一轮的多条「自动派工」全压到第一台机器
  （两台空闲时 4 条空 machine 任务全给 GT14）。现在每派出成功一条就 `load[机器] += 1`。
- **#4 待回绑记录只存内存**（`lib/index.js`）：`pendingAttach` 原来只在内存、`dispose` 时直接清空，
  插件热重载后新实例拿不到「板子任务号 → 远程任务号」的映射，板上那条永远卡在 `claimed`。
  现在落盘到 `~/.dsh/dsh-team/pending-attach.json`（TTL 6 小时），apply 时读回，
  由 `retryPendingAttach()` 补绑 —— 只补绑，绝不重派（否则远程会跑两遍）。
- **#7 syncRemote 生命周期复查**（`lib/index.js`）：原来只在入口检查 `disposed`，
  等待 snapshot / 远程任务列表返回之后、逐条写板子之前没有复查，
  卸载瞬间挂起的请求返回后旧实例仍会写板子。现在每个 await 之后与循环每条之前都复查。

## v1.1.7 — 2026-11-01

作业板面板的三处可用性问题 + 清理任务与调度器的竞态：

- **「已完成」视图**（`lib/client.js`）：原先只有「未完成 / 全部 / 打回」三个视图，
  完成的任务只能去「全部」里翻。新增 `done` 视图，按 `updated_at` 倒序，
  每行显示「完成于 X 前」+ 完整时间 tooltip + 结果摘要；四个 tab 都带计数。
  顺手修了「全部」把已完成任务也算进「进行 0」的问题。
- **清理未完成的历史任务**（`lib/client.js` + `lib/index.js`）：新增「清理 N」入口，
  只对 `queued / stale / failed / blocked` 生效（`running / claimed` 双保险不碰）。
  板子不支持物理删除，所以「清理」= 用 `/api/release` 归档成 `superseded`，
  确认弹窗里写清楚这一点、列出待清理条目、支持备注、逐条报进度与失败原因。
  宿主侧 release 白名单补上 `superseded` 并给默认 note（以前会被静默改写成 `done`，
  等于把失败任务伪造成完成）。
- **nodeId 与机器别名归一**（`lib/client.js` + `lib/index.js`）：面板上的「远程同事」
  行、任务行、机器卡、派工弹窗以前混着 `desktop-2gh05s7` 和 `MB14` 两种写法。
  现在 `/api/board/ui/summary` 附带 `nodeMap`（nodeId → 板子机器名），面板统一按
  机器名显示，nodeId 只留在 tooltip 里。
- **派工弹窗 / 清理弹窗的对比度**：副标题、卡片正文、徽章、选中态、离线卡在暗色
  主题下都在 0.45~0.85 的透明度里叠，几乎读不清。改为实色层级（正文 `#e6edf3`、
  次要 `#c9d1d9`、徽章浅底 `#21262d`），选中态加左侧亮条，离线卡用虚线边框 +
  红点而不是整卡降透明。
- **清理与调度器的竞态**：清理是「读快照 → 逐条归档」，这几秒里调度器可能把某条
  `queued` 任务 `take` 走并派到副机，随后的 release 会把正在跑的任务作废。
  现在清理前先 `POST /api/board/ui/dispatch-pause` 让宿主调度器停手（上限 10 分钟、
  会自然过期），开跑前再拉一次最新快照；若某条已是 `queued` 且带 `taker`，
  先走新增的 `/api/board/ui/untake` 退占位再归档，409 时按最新状态判「跳过」而不是硬归档。
  跳过与失败分开统计，不再把「被别的机器抢走」算成失败。
- **`call()` 保留错误响应体**（`lib/index.js`）：板子非 200 时以前只留 `error` 字符串，
  现在带上 `status` 与 `body`，面板能区分「被别人抢走了（409）」和真正的故障。

## v1.1.6 — 2026-11-01

修掉外部扫描报的 7 条问题（shaot92-del/dsh-team #1~#7）和派工弹窗的可读性：

- **#1 `sh_write` 可经 junction 绕过 `allowedRoots`**（`lib/shell.js`）：`realPath()`
  以前把所有 `realpath` 错误都当"路径不存在"，退回字面路径，于是
  `allowed\link\new.txt`（link 指向白名单外、文件还没建）能通过白名单。
  现在只对 `ENOENT` 向上找最近存在的祖先再拼回剩余段，其它错误上抛，
  `withinRoots()` 遇到异常一律判"不在白名单"（fail-closed）。
- **#2 两台以上副机在线时"自动派工"始终 queued**（`lib/index.js`）：`pickNode()`
  以前只在恰好一台在线副机时兜底。现在按板子上 running 的任务数挑最闲的那台。
- **#3 nodeId / 机器别名转换不完整**：新增 `machineAlias()`，任务里写
  `desktop-2gh05s7` 或 `MB14` 都能选中同一台；`/api/board/ui/summary` 附带
  `nodeMap`（nodeId → 机器名），面板把两者合成一张卡。
- **#4 dispatch 成功但 attach 失败会丢失 remote taskId**：新增 `pendingAttach`
  与 `retryPendingAttach()`，每轮 dispatch 前只重试回绑（绝不重复派发），
  只有 attach 成功才计入 `dispatched`。
- **#5 面板交付/打回没带 `task.machine`**（`lib/client.js`）：release 请求体补上
  machine，多机在跑时不再用本机身份释放别人的占位。
- **#6 `pendingNoted` 写入失败后阻止重试**：改成 `/api/mark` 成功后才记入集合。
- **#7 dispose 只清定时器**：新增 `disposed` 标志，dispose 时先置位并清空
  `pendingAttach`；在飞的 dispatch/sync 会提前退出，认领后未派发的任务会
  `/api/untake` 放掉。
- **派工弹窗对比度**：卡片改用实体底色（`#1c2129`）、文字 `#e6edf3`/`#adbac7`、
  徽章浅底描边、选中态 `rgba(88,166,255,0.22)` + 2px 亮边 + 左侧亮条，
  离线卡改虚线不再整卡半透明。

## v1.1.5 — 2026-11-01

不含运行时代码改动，只把当天的现场修复沉淀成可复用脚本 `scripts/worker-patches/`：

- `fix-agent-model.ps1`：给副机 profile 补 `agent-default-model`
  （provider `deepseek-account` / model `deepseek-flash`）。缺这段时副机 agent
  会话会落到 `deepseek-official` 路由，本地报 `no API key for provider route`，
  一次模型请求都不会发出。
- `patch-followup-role.ps1`：修 `dsh-remote-agent` 的 `runner.js` —— `agent.followup`
  投递任务书时缺 `role`/`id`，导致每条无角色消息在 `serialize()` 里抛
  `TypeError: Cannot read properties of undefined (reading 'content')`，
  再被包成 `DeepSeek Messages transport failed / TRANSPORT`。
- `patch-transport-retry.ps1`（可选）：把节点传输层遇到 `duplicate-node` 等错误时的
  `this.stop()` 改成 `destroy + scheduleReconnect`，避免被顶下线后永久失联。
- `restart-dsh.ps1` / `start-dsh-now.cmd`：通过计划任务或手动双击重启副机 DSH，
  能活过被杀的进程本身（不要在 exec 任务里杀了宿主原地拉起）。
- 四个 ps1 均用真实原始文件做过端到端演练与幂等复测；`transport.js` 补丁产出
  `26372 -> 26709 chars`，与副机上实际打出的结果一致。

## v1.1.4 — 2026-11-01

- **看板 machine 列被 nodeId 覆盖**：`dispatchOnce()` 回执时把 remote-agent 的
  `nodeId`（`desktop-2gh05s7`）当成机器名写给 `/api/attach`，于是板子上同一台
  MB14 一会儿叫 `MB14`、一会儿叫 `desktop-2gh05s7`（历史 9 条任务已留下这个写法）。
  现在回执统一走 `boardMachineName(nodeMachine(node))`，折回规范名
  `host / GT14 / MB14 / PC2`；认领、心跳、回执三处口径一致。
  只影响新派出的任务，历史任务不改名。
- 附当日现场报告 `docs/summary-report-2026-11-01.md`。

## v1.1.3 — 2026-11-01

两个在真机上反复咬人的问题：

- **goal 超 300 字被板子截断**：`board_server.py` 的 `do_create` 存的是 `goal[:300]`，
  exec 命令被截成半句后会在副机上炸出 `ParserError … The string is missing the
  terminator`（2026-11-01 现场踩了两次）。`board_dispatch` 与 `/api/board/ui/create`
  现在建单前就拒绝，并把「长逻辑写成共享盘脚本、这里只传一句调用」写进 hint。
- **终态 note 只有「远程 completed」**：`syncRemote` 改为优先把副机最后一条
  `[stdout]` 日志写进板子 note，交付信息一眼可见；对象型 error 也能读出来了。
  注意这条依赖板子的 `do_mark` 支持 `note` 字段 —— 运行中的板子进程要重启才会加载。

## v1.1.2 — 2026-10-31

修 v1.1.1 之后暴露的**静默卡住**：任务真的派出去了，却永远停在副机审批里。

- 根因：remote-agent 的 `validateTaskStart` 对 `mode: exec` 的任务默认
  `approval: 'manual'`（`protocol.js:433-438`）——hub 挂起任务等面板批准，
  超时 30 分钟自动拒绝。Host 调度器派发时没传 `approval`，于是命令类任务
  一律挂 `pending_approval`；而 `syncRemote` 只认终态，板上就一直显示 running。
- 修法一：Host 调度器派发时显式带 `approval`。新配置项 `dispatchApproval`
  （默认 `'auto'`，设成 `'manual'` 可退回人工审批）。
- 修法二：`syncRemote` 遇到 `pending_approval` 时在板子上标一次 note
  （"等待副机审批…"），不再无声无息。
- 现场验证：GT14 修好 `transportMode` 之后两条 exec 任务 4 秒内被 Host 派给
  remote-agent（`dispatched … remote=ui-…`），随后在副机侧挂审批 —— 本版就是
  为这一步补的。

## v1.1.1 — 2026-10-30

修复 v1.1.0 的致命一步：Host 调度器派不出去。

v1.1.0 把派发搬进 Host 之后，`POST /api/remote-agent/ui/dispatch` 在真实宿主上一直 401 ——
remote-agent 的 UI 路由每个请求都过 DSH 的浏览器鉴权围栏（`connection.requestRejection`），
后台进程没有会话 cookie 就不放行，于是任务永远停在 `queued`（plugcheck 用假 fetch，没暴露）。

- Host 调度器改用 `connection.authenticatedUrl()` 把本进程的 launch token 拼进一次 `/` 请求，
  换会话 cookie；缓存 10 分钟，遇到 401 自动重换一次并重试
- 副机 `nodeId`（Windows 计算机名，如 `desktop2gh05s7`）与板子机器别名（`MB14`）按
  `MACHINE_BY_HOSTNAME` 对齐，忽略大小写/连字符；首次拿到节点列表时把映射写进 `_runtime.log`
- 调度器新增可诊断日志：`take skip` / `dispatch skip`（没有匹配的在线节点）/ `dispatch failed`
- plugcheck 增补一组断言：换 cookie、401 后重试、`nodeId` 别名匹配

## v1.1.0 — 2026-10-30

架构升级版：把「派发」和「终态回写」从浏览器搬进 Host 进程，补上 v1.0.2 遗留的
5 项 P1/P2（复核第 6/7/12/13/17 项）。20 项复核的逐条状态见 `docs/review-response.md`。

### 架构：Host 侧调度器（复核 #6）

- 新增 Host 后台 `dispatchOnce()`（4 秒）：对 `dispatch:'auto'` 且 `queued/stale` 的任务，
  先 `POST /api/take` 原子占位，再 `POST /api/remote-agent/ui/dispatch`，成功后
  `POST /api/attach` 回绑；失败 `POST /api/untake` 放回队列并写明原因
- 新增 Host 后台 `syncRemote()`（6 秒）：拉 `/api/remote-agent/ui/tasks`，把
  `completed → done`、`failed/aborted/interrupted/rejected → failed` 回写板子
- 浏览器不再轮询 remote-agent（删掉约 5.4 KB 的 `bgDispatch` 整段）：多开不再重复派工，
  关掉页面任务也不会停；面板「派工」只负责建单（`dispatch:'auto'`）
- 新配置 `autoDispatch`（默认 `true`），设 `false` 可退回「建单后手动 `remote_task`」的旧流程

### 板子协议（服务端需同步升级）

- 调用 `POST /api/take {task_id, machine, minutes?}` 原子占位：`dispatch` 必须为 `auto`、
  状态必须是 `queued`/过期 `claimed`、且没有被别人占住；`machine` 仍记真正执行机，
  占位者单独记 `taker`；同一 `taker` 重复调用是续租（`reentrant:true`）
- 新增 `POST /api/untake {task_id, machine}`：放回队列（`status=queued`、`dispatch=auto`）
- `POST /api/claim` 改为**原地合并**：旧实现整条覆盖会抹掉 `goal/title/mode/workspace/remote_id`
- `POST /api/create` 支持 `workspace` 字段；`POST /api/mark` 支持 `note`；`POST /api/attach` 清 `taker`
- 可选鉴权：服务端设 `GP_BOARD_TOKEN` 后，写请求必须带 `x-board-token` 头（本插件用配置里的
  `token` 自动带上）；不设则行为不变
- `/api/health` 增加 `auth` / `version` / `routes`，方便确认对面装的是哪个版本

### 修复（复核 #7 #12 #13 #17）

- **`sh_run` 输出流式限流**：`runOnce` 在 `data` 回调里就按 `maxOutputBytes` 截断（继续 drain
  管道，不阻塞子进程），不再把整段输出攒进内存最后才裁；超限体现在 `truncated`
- **`snapshot(limit)` 支持 `limit=0` 取全量**：`board_list` 改用全量快照，`limit` 上限提到 500，
  不再因为先裁 200 条导致 `total` 封顶、`done/superseded` 被切掉
- **`dispose()` 完整卸载**：清掉 `caps/live/dispatch/sync` 四个定时器、退订 `agent/created`、
  清 `portedAgents`；插件重载不再叠加定时器继续上报
- **能力探测不再阻塞**：`collectCaps` 改 async，5 个版本探测用 `execFile` 并发 + 10 分钟 TTL
  （原先串行 `spawnSync`，最坏阻塞 15 秒，还包含一次 Windows PowerShell 5.1 启动）

### 测试

- `scripts/plugcheck.mjs` 扩到 11 组断言：新增「建单带 `dispatch:'auto'`」「Host 调度器
  `take → dispatch → attach`」「`aborted` 折成 `failed`」「230 条任务不被截断」「`dispose()`
  清掉 4 个定时器」；定时器用 `setInterval` 打桩捕获后手动触发，不真跑、不挂住进程

## v1.0.2 — 2026-10-30

外部复核（20 项）后的热修版。判定与逐项证据见 `docs/review-response.md`；本次只修不依赖外部服务、
能在本仓库内闭合的问题。

### 修复（严重）

- **面板「派工」不再假成功**：`doDispatch` 先建板子任务（此前调的是根本不存在的 `/api/board/ui/create`），
  再回绑远程任务；任何一步失败都会在面板上报错并返回 `false`，不再出现「远程真派出、板子无记录」
- **有副机时点「派工」不再抛 `ReferenceError`**（`busyN` → `c.busyN`）
- **agent 层 `sh_*` 工具找回 `allowedRoots` / 超时 / 输出上限**：配置原先只挂在 `cfg` 上，
  agent 会话拿到的却是 `undefined`，导致根目录白名单退化成「不限制」
- **任务 ID 冲突**：`bd-` 前缀后追加 4 位 UUID，同毫秒建单不再撞板子的 409
- **`allowedRoots` 改为 realpath 比较**（Windows 忽略大小写），符号链接/junction 绕不过去；
  README 同步说明它只是路径白名单、拦不住命令内容本身

### 修复（一般）

- 面板任务标题改取 `t.title`（此前恒显示「(无标题)」或把备注当标题）；`goal` 不再被裁到 160 字
- 派工回写板子时保留真实执行机（`machine` 取请求体，缺省才用本机配置）
- `board_caps` / `board_metrics` 在板子不可达时返回 `ok:false`，不再回「没有匹配的机器」
- 面板认领/交付/打回失败会在面板上报错（此前 409 静默）
- 切任务时清空产物与备注草稿，不再把 A 的草稿提交进 B
- `apply()` 日志里的配置已脱敏（`token` 等键打码），不再把明文密钥写进 `_runtime.log`
- 删除 Panel 内引用未定义 `resolveNodeId` 的重复派工逻辑（改由 Host 侧 `bgDispatch` 统一负责）
- 「远程同事」入口的隐藏改为可还原（记录/恢复原内联 `display`，卸载时还原），并去掉全局
  `!important` 属性选择器
- 字号循环修正为读 16/18/20（此前读 15/17/19，刷新后必然回档）

### 测试

- `scripts/plugcheck.mjs` 重写：16 工具契约、`render` 返回文本块、四条 GUI 路由、标题/`goal` 不被裁、
  agent 层共享 `allowedRoots`、板子不可达时 `board_caps` 返回 `ok:false`；全程 `stubFetch`，不连真板子

## v1.0.1 — 2026-10-30

首个公开发布版。

### 功能

- **12 个 `board_*` 工具**：`board_status` / `board_list` / `board_claim` / `board_beat` /
  `board_done` / `board_fail` / `board_say` / `board_attach` / `board_dispatch` /
  `board_caps` / `board_assess` / `board_metrics`
- **4 个 `sh_*` 工具**：`sh_run` / `sh_read` / `sh_write` / `sh_list`（副机 worker 会话默认没有
  pwsh / read / write，这四个补上；从 dsh-shell 合并进来）
- **侧栏「作业板」面板**：任务表（筛选/搜索/展开/认领/交付/打回）、机器能力卡、一行派工、桌宠
- **Host 路由** `/api/board/ui/*`：浏览器不直接跨网访问板子服务

### 修复

- 桌宠立绘不再回退到本机绝对路径（`D:/gp_video/pet/大肥鱼.png`）；包内 `assets/pet.png`
  缺失时返回可读的 404，而不是拿空路径去 `readFile`
- `sh_run` 工具描述里的示例路径改为 `notes.txt`，不再指向作者机器上的目录
- `package.json` 的 `files` 补上 `assets/pet.png`，从 npm/打包安装时不再缺立绘

### 文档

- 补齐 `repository` / `bugs` / `homepage` / `author` 与 LICENSE 署名
- README 安装示例换成真实仓库地址；配置段 `petImage` 改为留空用随包立绘
- `scripts/plugcheck.mjs` 注释修正为 16 个工具（12 个 `board_*` + 4 个 `sh_*`）


