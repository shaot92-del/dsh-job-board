# 变更日志

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

