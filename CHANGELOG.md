# 变更日志

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
  `remote-agent` 那一行（hub，`192.168.3.40:19387`）丢了，包还在但插件没被加载。
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

