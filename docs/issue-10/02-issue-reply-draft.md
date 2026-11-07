# #10 回复稿（中英双语）/ Reply draft

> **草稿 · 不要直接发布**。发布前核对三处状态：
> 1. 第 1、2 条的实际分支进度（下面按「已开始实现、未合并」写；若已合并请改成「已合并，随 v1.1.11」）。
> 2. 是否要同时贴出 `docs/issue-10/01-acceptance-criteria.md` 的链接（建议贴，方便逐条勾选）。
> 3. v1.1.10 的运行时验证状态：CHANGELOG 目前只写了 `plugcheck` PASS，回复里不要扩大成「已在三机验证」。
>
> 粘贴范围：分割线之间的中文段 + 英文段；两段都可独立阅读，不必删减。

---

感谢这份复核，五条都指向真实缺口，第 1、2 条也确实是当前最薄的地方。先同步一下状态。

**#8 / #9 已在 v1.1.10 关闭**（`8cb7108`）。

- #8：`dispatchOnce` 在循环内、每条任务开始前重新检查 `pausedUntil`，中途暂停立即停手；暂停接口等 `inFlight` 归零（最多 3 秒）才返回，回执带 `inFlight` / `waitedMs`。
- #9：待回绑记录从全用户共享文件改为 `pending-attach-<machine>-<boardTag>.json`，写入改为「读盘合并 → 剔除已补绑 → tmp + rename」；升级时回退读旧文件，不丢 v1.1.9 的记录。
- 验证：`plugcheck` PASS（16 工具 / 12 路由）。运行时复验还在补，补完会更新到发布说明。

**#10 的 1、2 正在推进**，保持单包，不拆微服务。

- **第 1 条（可恢复派工）**：先落「写前日志 + 结果未知态 + 限时对账」。take 之前记录 attempt（请求 ID、目标机、时间、阶段）；dispatch 超时/断连不再直接 `untake`，而是进入 unknown，先查 `GET /api/remote-agent/ui/tasks` 是否已受理，确认未受理才退回队列；重启后先对账再派发。这里有个硬前提：**稳定请求 ID 的去重/查询必须和 remote-agent 约定**。当前 0.9.x 的 `/dispatch` 不回显请求 ID，`/tasks` 也没有可按请求 ID 检索的字段，所以本插件单方面生成 UUID 不构成幂等——我们按「可查则查、不可查则短窗对账 + 板上留痕」降级，并明确标注这不是强幂等；这一条要上游配合才算真正完成。
- **第 2 条（调度所有权）**：先把约定做成「可观测 + 可检测」，而不只是 README 一句话：一个板子只指定一台 Host `autoDispatch: true`，其余只建单展示；启动日志和 `/api/board/ui/summary` 暴露派工身份。另外补充一个核对时发现的事实，供你判断优先级：板子的 take 实现把「任务已 claimed 且 taker 与 machine 同名」当作续租、返回 200，所以两台 Host 只要配了同一个 `machine` 名，就会双双拿到派发权——`/api/take` 的原子性只在 machine 名唯一时成立，README 现在「别的 Host 抢不到」的说法需要修正。因此第 2 条的最小修法是给 take 增加独立于 machine 名的 dispatcher 身份并拒绝跨实例续租；所有权租约 + fencing token 留到确需多调度器时再做（那一层还需要 remote-agent 校验令牌）。
- **第 3 条**：按「先模型、后拆文件」渐进。先统一机器身份（稳定 ID 与展示别名分离，去掉 `client.js` 里第二份映射）和任务状态转换（建单/选机/回绑/终态的单一入口），让面板与工具走同一业务操作；适配器分层只约束「新代码不再往 `index.js` 堆协议细节」，不做一次性拆包、不换加载方式。
- **第 4 条**：文档先行。补「部署与权限模型」：`allowedRoots` 只约束 cwd/路径、不约束命令内容、不是沙箱；给「可信 worker 自动执行」和「需审批 worker」两档 YAML；隔离需求走受限账户/独立环境。不改默认行为，也不加常驻 UI 警告。
- **第 5 条**：排在 1、2 之后。用 Node 写一个随仓库启动的 HTTP 板子替身（不依赖仓库外的 Python 板子服务），加故障注入（受理后丢响应、超时、断网、重复回执、暂停、重启），断言「不重复执行、不丢绑定、旧实例不回写」，并把 #8/#9 的复现收进同一套；CI 在 windows + ubuntu 双跑。

顺序上同意你的建议：先「单调度器约定 + 响应丢失→查询→恢复」，再谈多调度器所有权；第 3 条只在重复逻辑真的挡住 1、2 时推进，第 4、5 条跟随。验收标准我们已经拆成可勾选清单（每条带代码位置与工作量），整理后会补在本帖里，方便逐条打勾。

---

Thanks for the review — all five points land on real gaps, and items 1 and 2 are indeed the thinnest parts of the current design. Status first.

**#8 / #9 are closed in v1.1.10** (`8cb7108`).

- #8: `dispatchOnce` now re-checks `pausedUntil` before each task inside the loop, so a pause takes effect mid-round; the pause endpoint waits for `inFlight` to drain (max 3s) and returns `inFlight` / `waitedMs`.
- #9: pending-attach records moved from one shared file to `pending-attach-<machine>-<boardTag>.json`, written via read-merge-drop-bound-then-rename; on upgrade it falls back to the legacy file so v1.1.9 records are not lost.
- Verified with `plugcheck` PASS (16 tools / 12 routes). Runtime re-verification is still being completed and will be reflected in the release notes.

**Items 1 and 2 of #10 are in progress**, staying single-package — no microservices.

- **Item 1 (resumable dispatch)**: landing "write-ahead journal + dispatch-unknown + bounded reconciliation" first. An attempt record (request id, target machine, timestamp, phase) is persisted before `take`; on timeout/disconnect we no longer `untake` immediately — the task enters `dispatch-unknown`, we query `GET /api/remote-agent/ui/tasks` to see whether it was accepted, and only untake once non-acceptance is confirmed; after a restart, reconciliation runs before any new dispatch. One hard prerequisite: **a stable request id for dedupe/lookup must be agreed with remote-agent**. The current 0.9.x `/dispatch` does not echo a request id and `/tasks` has no field to look one up, so a locally generated UUID is not idempotency. We are shipping the fallback (query when possible, short-window reconciliation plus a board note otherwise) and labelling it explicitly as best-effort, not exactly-once; the strong version needs upstream cooperation.
- **Item 2 (dispatch ownership)**: making the convention observable and detectable rather than a README sentence: exactly one Host per board runs `autoDispatch: true`, the rest create and display only; startup logs and `/api/board/ui/summary` expose the dispatcher identity. One finding worth weighing for priority: the board's take implementation treats "already claimed and taker equals machine" as a lease renewal and returns 200, so two Hosts configured with the same `machine` name both win the take — the atomicity of `/api/take` only holds when the machine name is unique, and the README's current "other Hosts cannot grab it" wording needs correcting. The minimal fix is therefore a dispatcher identity independent of the machine name, with cross-instance renewal rejected; an ownership lease plus fencing token is deferred until multiple schedulers are actually needed (and that layer also needs remote-agent to validate the token).
- **Item 3**: incremental, model first, files later. Unify machine identity (stable id vs display alias, removing the second mapping in `client.js`) and task transitions (one entry point for create/pick/attach/terminal), with the panel and the tools calling the same operation; adapter layering only enforces "no new protocol details in `index.js`" — no big-bang split, no loader change.
- **Item 4**: documentation first. A "deployment and permission model" section: `allowedRoots` constrains cwd/paths only, not command content, and is not a sandbox; two YAML profiles (trusted auto-exec vs approval-required); isolation via restricted accounts or isolated environments. No default changes and no persistent UI warning.
- **Item 5**: after 1 and 2. A Node HTTP board double that starts with the repo (no external Python board service), with fault injection (dropped response after acceptance, timeout, network partition, duplicate receipt, pause, restart), asserting no duplicate execution, no lost binding, and no writes from a stale instance; the #8/#9 repros join the same suite, and CI runs it on windows + ubuntu.

On sequencing I agree with your suggestion: single-dispatcher convention plus "response lost → query → recover" first, multi-scheduler ownership later; item 3 only when duplicated logic actually blocks 1–2, with 4 and 5 following. We have turned the acceptance criteria into a checkable list (code locations and effort per row) and will add it to this thread so each item can be ticked off.
