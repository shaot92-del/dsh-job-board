# 派工所有权与跨 Host 收敛（#10-2）

这块板子允许"一台建单、多台 Host 在场"，于是有两个一直没答的问题：

1. **谁有权派**？以前每台 Host 的 `autoDispatch` 都是真跑：A 派出去的任务被 B 的
   调度器 untake 回来再派一遍——`take` 是原子的，但 `untake/reconcile` 不是。
2. **回写凭谁**？任务被板子/别的 Host 放回队列后重新认领（`taker` 换人），
   旧 Host 的 `syncRemote` 仍会把终态写回去，把别人正在跑的进度覆盖掉。

v1.3.0 用三条互相独立的护栏回答它们——都**不需要板子改协议**。

## 1. `dispatchRole`：先指定一台 owner

```yaml
# cordis.patch.yml 里这台 Host 的那一行
config:
  dispatchRole: observer   # 默认 owner
```

| 角色 | 建单 | take / dispatch | untake / reconcile | 回写自己派过的任务 |
| --- | --- | --- | --- | --- |
| `owner`（默认） | ✅ | ✅ | ✅ | ✅ |
| `observer` | ✅ | ❌ | ❌ | ✅ |

observer 的 `dispatchOnce()` 在第一行就返回，连 reconcile 都不跑——否则两台 Host
会互相把对方在跑的任务放回队列。启动日志会写一行：

```
dispatch role=observer（这台 Host 只建单、不派工；派工交给 owner 那台）
```

> 没有"自动选主"：多调度器的租约/版本令牌要板子配合，按 #10-2 的建议先用
> "人工指定一台"。


## 2. attach 前核实远端任务还在

`attach` 只是把 `remote_id` 写进板子，hub 不校验这条任务是否存在。远端任务被
`/purge` 或 hub 重启清掉之后，板子会永远停在"进行中"，`syncRemote` 也永远等不到
终态——最后变成一条谁都不敢动的 stale。

v1.3.0 在 `attachTask()` 里先 `GET /api/remote-agent/ui/task?taskId=…`：

- `200 {task}` → 照常 attach；
- `404 TASK_UNKNOWN` → **不写 remote_id**，把板子任务标 `failed`，note 写明
  "远端任务不存在（hub 上查不到 …）"，并清理待补绑记录；
- 超时 / 5xx（查不清）→ 不阻拦，保持原来的容错行为（attach 失败照样进待补绑）。

日志：

```
attach skipped bd-xxx: 远端任务 ui-yyy 不存在，已把板子任务标 failed
attach retry 停止 bd-xxx remote=ui-yyy：远端任务不存在，已清理待补绑记录
```


## 3. 回写前校验任务归属

`syncRemote()` 里，对每条"有 remote_id 且 running/claimed/stale"的任务：

```js
const holder = String(t.taker || '')
if (holder && machineAlias(holder) !== machineAlias(cfg.machine)) {
  trace('remote sync skip …: 板上已被 <holder> 认领（本机 …），不再回写')
  continue
}
```

被别的机器抢走的任务一律跳过——少写一次，胜过写错一次。日志每台机器只留一行
（同一任务被反复跳过的噪音没有价值）。


## 配置项汇总（v1.3.0 新增）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `dispatchRole` | `owner` | `observer` = 只建单、不派工、不 untake |
| `remoteSyncMs` | `6000` | 回写节拍（隔离 harness 压到 300ms） |


## 验证

`node scripts/dispatch-recovery-smoke.mjs` → **59/59**，其中新增：

| 用例 | 场景 | 断言 |
| --- | --- | --- |
| R17 | `dispatchRole: observer` + 一条 queued/auto | dispatch=0、take=0 |
| R18 | hub 回了 taskId，但 `/task` 404（远端已被回收） | attach=0、remote_id 为空、板子标 failed |
| R19 | 板上任务 `taker: mb-other`，远端已完成 | mark=0、板上状态仍为 running |

变异验证（临时改坏源码再跑）：

| 变异 | 结果 |
| --- | --- |
| 去掉 observer 闸门 | R17 挂（dispatch=1、take=1） |
| `probeRemoteTask` 直接跳过 | R18 挂（attach=1、remote_id 被写入） |
| 去掉归属校验 | R19 挂（板上被改成 done） |

M1–M7 七组变异全部按预期被抓住，恢复源码后 59/59。


## 4. 状态文件：跨进程锁（v1.3.1）

`dispatch-journal-*.json` 与 `pending-attach-*.json` 都是"读回磁盘 → 合并 → 原子写"。
原子写只保证单次写入不出现半个文件，挡不住两台 Host **同时**"读 → 合并 → 写"：
两边都读到 `[x]`，A 写 `[x,a]`，B 写 `[x,b]` —— a 就没了。反过来，两边各自删条目
也可能把对方刚清的记录写回来。

v1.3.1 把这段收进 `lib/state-file.mjs`：

- `withFileLock(file, fn, { waitMs = 400, staleMs = 30000 })` —— `<file>.lock` 用
  `O_EXCL` 抢占；持锁进程崩了留下的僵尸锁，超过 `staleMs` 直接抢占；等不到就返回
  `{ ok:false, busy:true }`，调用方保留内存里的墓碑，下一轮再来（**绝不"没拿到锁也
  照写"**，那正是丢更新的老路）。
- `writeStateJson()` 原子写（`<file>.<pid>.tmp` + rename，失败退避重试 20/50/100ms）。
- `sleepSync()` 同步短睡眠（重试退避用）。

`saveDispatchJournal()` / `savePendingAttach()` 的整段合并都在锁里；拿不到锁时日志
写清"被另一个实例锁着、内存里还有几条在途"。Journal 的 TTL 过期、墓碑清除这些
副作用仍留在锁外——它们只影响本实例内存，不需要互斥。

### 验证

- `node scripts/state-file-smoke.mjs` → **8/8**：4 个子进程 × 10 次并发读改写
  不丢更新（40/40）、僵尸锁可抢占、活锁返回 busy 且不写、锁释放后立刻能写、
  原子写无 `.tmp` 残留。
- `dispatch-recovery-smoke` 新增 **R20**：journal 旁边放着 5 分钟前的僵尸锁，
  派工照常完成（dispatch=1、attach=1、journal 清空）。
- 变异验证：把 `withFileLock` 换成直接执行 → 并发用例从 40 掉到 9（用例确实能抓）。
  注意第一版用例用 `spawnSync` 起子进程，串行跑出来照样全绿，已改成 `spawn` + 
  `Promise.all`。
## 还没做的

- **自动选主**：多 owner 时的租约/版本令牌要板子侧配合（#10-2 的后半段）。
- **跨 Host 最终归档校验**：本版只保证"不覆盖别人"，不保证"别人挂了之后有人接手
  把它归档"——那要板子提供 stale 的租约语义。
- **幂等键**：remote-agent 0.9.x 的 `/dispatch` 由服务端生成 taskId，客户端没有
  请求幂等键，所以"结果未知"仍然只能靠 `goal + 时间窗` 反查（见 06 号文档）。
