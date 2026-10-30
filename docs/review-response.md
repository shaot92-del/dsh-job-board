# 对 20 项外部复核的回应（v1.0.2）

复核基线：`c4a106d`（v1.0.1）。复核共 20 项，我们逐条对照代码与两份外部组件（板子服务、
`dsh-remote-agent`）的契约核实，结论是 **12 项 CONFIRMED / 8 项 PARTIAL / 0 项 WRONG** ——
复核的事实基础是可靠的，其中几处表述与代码略有出入，下面标注。

v1.0.2 只修不依赖外部服务、能在本仓库内闭合的问题；需要动板子服务或 remote-agent 的部分留在 v1.1。

## 逐项判定

| # | 级别 | 判定 | 结论 | v1.0.2 |
|---|------|------|------|--------|
| 1 | P1 | CONFIRMED | agent 层 `sh_*` 读到 `cfg.allowedRoots`，但该键从未写进 `cfg` → 根目录白名单退化为「不限制」（fail-open）。命令内容本身也不受限 | 已修 |
| 2 | P1 | CONFIRMED | `allowedRoots` 是字符串前缀比较，不解析 realpath/junction；Windows 下 `t === rr` 反而不忽略大小写。README 称「沙箱」属过度宣称 | 已修（realpath + 文档） |
| 3 | P1 | CONFIRMED | `client.js` 用 `busyN` 而非 `c.busyN`；**有 ≥1 台非 host 机器**时点「派工」必抛 `ReferenceError`（无副机时该分支不进入，故复核的「必崩」需加前提） | 已修 |
| 4 | P1 | CONFIRMED | 面板派工调 `API + '/create'`，Host 没有这条路由；`create`/`attach` 的返回值全被丢弃 → 远程真派出、板子无记录、UI 当成功 | 已修（补路由 + 三步判结果） |
| 5 | PARTIAL | `clip()` 确实裁 `goal`，但只影响面板对 `dispatch=pending` 任务的自动派工；工具自身的派发用原文，且仓库内没有任何代码写 `dispatch=pending` → 潜伏链路 | 已修（snapshot 返回原文） |
| 6 | P1 | CONFIRMED（架构） | 派发与终态同步跑在浏览器（6s 轮询），关掉页面即停；多 GUI 会重复派工；`mark` 是读改写、非原子 | v1.1 |
| 7 | P1 | CONFIRMED | `sh_*` 输出无界累积（每块都 `push`，只在结束时截断）→ 跑 `yes`/大日志会打爆宿主 | v1.1 |
| 8 | P1 | CONFIRMED | 任务 ID 仅 `Date.now().toString(36).slice(-6)`，同毫秒必撞；板子对重复 ID 返 409 | 已修（+4 位 UUID） |
| 9 | P2 | CONFIRMED | Host 回写 `release` 固定用 `cfg.machine`，浏览器传来的真实执行机被丢弃 → 远程交付归属记到 host | 已修 |
| 10 | P2 | PARTIAL | 不是 `console.log`，但 `trace` 把整份配置（含 `token`）写进包根 `_runtime.log` | 已修（脱敏） |
| 11 | P2 | CONFIRMED | `resolveNodeId` 定义在 `apply()` 作用域内，Panel 里引用不到 → 抛错被 catch 成红字，该自动派工路径永不生效 | 已修（删除重复逻辑） |
| 12 | P2 | PARTIAL | `snapshot` 先排序再 `slice(limit)`，调用点 `limit` 是 200/60/12 而非统一 60；>200 条任务时 done/superseded 被切掉、`total` 封顶 | v1.1（`limit=0`） |
| 13 | P2 | CONFIRMED | 卸载只清路由/工具；两个 `setInterval`、`ctx.on('agent/created')` 的退订函数、`portedAgents` 都没清；重载会叠加定时器并继续上报 | v1.1 |
| 14 | P2 | CONFIRMED | `title` 从不读 `t.title`（板子确实存了），无 note 的任务恒显示「(无标题)」，note 又被当标题重复显示；按真标题搜不到 | 已修 |
| 15 | P2 | CONFIRMED | 产物/备注草稿是组件级 state，切任务不清 → A 的草稿被提交进 B | 已修 |
| 16 | P2 | PARTIAL | 共享请求层是诚实的（非 2xx / 网络错误都返回 `ok:false`）；静默的是 `board_caps`/`board_metrics` 不看快照失败、以及面板 `act()` 不看结果 | 已修 |
| 17 | P2 | CONFIRMED | `collectCaps` 串行 `spawnSync` 探测 5 个命令（含 Windows PowerShell 5.1），最坏阻塞 15s，每 10 分钟一次 | v1.1（异步/TTL） |
| 18 | P2 | CONFIRMED | `plugcheck` 只做浅检查且假 ctx 缺 `on`（订阅静默失败）；`pettest` 读作者机绝对路径；`acceptance` 依赖 D 盘素材与板子（本机 exit 2）；CI 只在 ubuntu 跑 plugcheck | 已修（plugcheck 重写） |
| 19 | P2 | CONFIRMED | 用全局属性选择器 + 每 1.5s 全页扫描隐藏「远程同事」，正文同名文字会被误藏，`!important` 压过开关，卸载不还原 | 已修（可还原 + 去 `!important`） |
| 20 | P3 | CONFIRMED | 字号读 15/17/19，写入循环却是 16/18/20 → 刷新必回档，15/17/19 是死分支 | 已修 |

## 复核需要修正的几处表述

- **#3**：不是无条件崩，需要至少一台非 host 在线机器（此时 `machines` 非空才走该分支）。
- **#8**：日志里出现的不是统一 60，`snapshot` 的调用点传 200 / 60 / 12。
- **#10**：不是 `console.log`，是 `trace()` 落盘到包根 `_runtime.log`。
- **#12**：「pending 永远不被消费」不成立 —— 只在 >60 条非终止任务时尾部 pending 饿死，且当前无生产者。
- **#16**：`call()`/`getJson()` 本身不吞错，问题在调用方不看 `ok`。
- **#5**：当前不可达（无 `dispatch=pending` 生产者，建单也不存 `mode`）。

## 外部组件契约（这是 v1.1 的卡点）

**板子服务** `board_server.py`（26984B，正在运行的 PID 1668，**不在任何 git 仓库里**）：

- 路由：GET 只有 `/`、`/index.html`、`/api/board`、`/api/health`；POST 见文件内路由表。
- `create` 对重复 `task_id` 返 **409**，不幂等；`claim` 在进程内锁里是原子的，但**整条记录覆盖**
  （`goal/title/owner/dispatch/mode/remote_id` 全丢）→ Host 派工绝不能走 `claim`。
- 无 CAS / 版本号 / 幂等键；`mark`、`attach` 无条件覆盖（能把 done 拉回 running）。
- `release` 只在「任务已有 machine 且与请求不一致」时 409；machine 为空时任何机器都能写终态。
- 无鉴权、`--bind 0.0.0.0`、CORS `*`；字段有长度截断（goal 300 / title 120 / note 500 等）。
- 机器名字典大小写不敏感 + 别名折叠，任务侧却是严格字符串比较 → `gt14` 与 `GT14` 会 409。
- 服务端每 15s 扫 `_remote-logs\<machine>\tasks\*.json` 自动回写终态（这是现成的"回写"通道）。

**`dsh-remote-agent` 0.9.11**（安装版 `lib/` 是唯一源码）：

- 没有 `ctx.provide`，兄弟插件拿不到它的 registry；可编程面只有 19 个 `remote_*` 工具 +
  `/api/remote-agent/ui/*` 的 HTTP 路由。
- 节点身份只有 `nodeId`；UI `/dispatch` 精确大小写匹配，未命中 404；节点视图里没有 id/label。
- **无幂等键**：taskId 由 hub 生成，复用即 `task-duplicate`；`awaitAccepted` 默认 60s，超时只把 id
  放在错误文本里。`GET /tasks` 返回上限 200、无分页；hub 视图 1h 清理。

**结论**：复核建议的「提交 C（Host 统一派工）」**不能只在本仓库内完成**。缺三件外部能力：
①板子侧带前置条件的原子占用（`do_take` + `/api/take`）；②remote-agent 的幂等键与「已受理」回执；
③Host 侧终态推送或增量查询。dsh-team 现在只能在浏览器里"尽力而为"，这正是它今天的样子。

## 版本分工

**v1.0.2（本版，已修）**：#1 #2 #3 #4 #5 #8 #9 #10 #11 #14 #15 #16 #18(plugcheck) #19 #20。

**v1.1（架构）**：

1. **#6 Host 统一派工**：需要先给板子加 `/api/take`（原子占用），再在 Host 侧跑调度器与终态回写；
   回写可先借服务端 `_remote-logs` 自动对账，不依赖 remote-agent 改动。
2. **#13 dispose 完整化 + #17 caps 异步化**：纯本仓库，可与 #6 同批做。
3. **#7 输出限流**：`sh_*` 边读边截断、超限后继续 drain。
4. **#12 snapshot 分页**：`limit=0` 全量 + 调用方自行过滤。
5. **#18 测试体系**：CI 加 Windows 矩阵；`acceptance` 改成可跳过、素材可用 `ffmpeg` 现场生成。

## 遗留风险（未在本版处理）

- 板子服务监听 `0.0.0.0` 且无鉴权：同一局域网内任何人都能建单/改单。在加 token 之前，建议限制
  监听地址或加防火墙规则。
- 多开 GUI 仍会重复派工（#6 修好前）。
