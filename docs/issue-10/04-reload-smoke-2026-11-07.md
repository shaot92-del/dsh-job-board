# 受控热重载冒烟记录（2026-11-07 22:45–22:48）

对应 issue #10 第 1 条前置：v1.1.10 声称已修「重载时旧实例残留」，但发布说明写的是"运行时验证见下一条发布说明"。本记录就是那次运行时验证。

## 环境

- DSH：`@deepseek-ai/dsh-desktop 0.2.2-rc.1`，GUI `http://127.0.0.1:11202`
- dsh-team：v1.1.10（commit 8cb7108），以 bundle 方式安装（`profile.package.json` → `bundles: [… "dsh-team" …]`，依赖 `dsh-team: file:D:/gp_video/dsh-team`）
- 宿主进程 pid=26320，插件日志 `C:\Users\17827\.dsh\profiles\desktop\node_modules\dsh-team\_runtime.log`
- 观察前基线：3249 行、237426 B、`duplicate exact route` 计数 = 5（全为 11-01 的历史记录）

## 操作

1. GUI/plugin_manager 把 `include:team` 置为 disabled。
   - 回执：`application: restart-required`，`restartReason: unmanaged-plugin`
   - 插件日志**零新增**（size/lines/mtime 全未变），说明旧实例没有被卸载、也没有走 dispose。
2. 再置回 enabled。
   - 回执：`application: failed`，`1 entry did not activate`，`Error: webserver: duplicate exact route "/api/board/ui/summary"`
   - 插件日志新增 5 行（14:46:14Z = 22:46:14 +08）：在同一个宿主进程里**真的又执行了一次 apply()**

## 日志证据

```
2026-11-07T14:46:14.936Z apply start pid=26320 config={…"allowedRoots":[],…}
2026-11-07T14:46:14.937Z shell tools registered (4)
2026-11-07T14:46:14.938Z tools registered 12
2026-11-07T14:46:14.939Z agent/created 订阅完成
2026-11-07T14:46:14.939Z route register FAILED: webserver: duplicate exact route "/api/board/ui/summary"
```

- 失败点就是第一条路由 `/api/board/ui/summary`（注册顺序里它排第一），apply 在 `ready` 之前中止：无 `route registered` 批量行、无 `ready`、无 `host dispatcher started`、无 `caps reported`（新实例的）。
- 旧实例仍然活着：`2026-11-07T14:48:15.651Z caps reported ok=true machine=host shell=true`（10 分钟一次的 caps 心跳，14:38:15 → 14:48:15 准时接上），并且 `GET /api/board/ui/summary` 仍返回 200（97187 B）。
- 全程日志里 `dispose|detach|stale` 出现次数 = **0**。

## 结论

1. **重载在 0.2.2-rc.1 上可稳定复现**：新实例在注册第一条路由时撞上旧实例留在 webserver 路由表里的
   `/api/board/ui/summary` → 整个 entry `fiberPhase: failed`。
2. **根因在宿主侧，不在本插件的 cleanup**（2026-11-07 22:58 用 `scripts/reload-smoke.mjs` 隔离复核，
   推翻了本文档初稿的判断）：给一个复刻了 `dsh-host-webserver` 语义的假 webserver 时，
   `apply → cleanup → apply` 8 项全绿（12 条路由清空后重新注册不撞名，工具与事件订阅也归零）。
   也就是说插件返回的 cleanup 只要被调用，路由是能摘干净的；这次是**宿主没有调用 cleanup 就再次 mount**，
   日志里 `dispose|detach|stale` 计数为 0 正说明这一点（连一次卸载都没发生）。
3. 仍存在的真实问题（已修，见 v1.1.11）：
   - `sh_*` 四个工具的 disposer 从来没被收集，cleanup 之后工具表还留着 4 个（reload-smoke A5 用例）；
   - 路由注册中途失败会留下半套工具/订阅在宿主上，现在整体回滚；
   - 卸载路径零日志 —— 初稿只能靠"有没有 dispose 行"推测，现在有 `dispose start/released/done` 三行。
4. 状态不一致仍然成立：loader 认为 team 没挂上（`failed` + diagnostic），实际旧实例的工具、路由、
   caps 定时器、调度器全在跑，面板/工具照常工作，直到下一次重载再次失败。
5. 恢复：重启 DSH（新进程路由表为空，entry 会正常走到 ready）。不重启也能继续用，但 loader 状态是错的，
   再点一次启用只会再失败一次；v1.1.11 起这条失败会在日志里直接写明"宿主没卸载旧实例，需要重启"。

## 隔离复现（scripts/reload-smoke.mjs）

```
— 场景 A：apply → cleanup → apply（正常重载）
✅ A1 apply 返回 cleanup 函数        ✅ A5 cleanup 后工具清空（16 → 0）
✅ A2 首次注册 12 条路由             ✅ A6 cleanup 后事件订阅退订（剩 0）
✅ A3 工具已注册（16 个）            ✅ A7 重载到同一 webserver 不撞名
✅ A4 cleanup 后路由清空（12 → 0）   ✅ A8 新实例注册 12 条路由

— 场景 B：旧实例未 cleanup 就再 apply（DSH 重载实测形态）
ℹ️ 第二次 apply 抛出：webserver: duplicate exact route "/api/board/ui/summary"
ℹ️ 路由表里现在 12 条（12 = 旧实例仍在提供服务）

— 场景 C：注册第 5 条路由时抛错（半装载回滚）
✅ C1 半装载如实抛错  ✅ C2 已注册路由回滚（4 → 0）  ✅ C3 工具回滚  ✅ C4 订阅退订
```

## 修复方向与落地

- 不再改路由注册形态（`ctx.effect` 不解决"宿主不调 cleanup"这一层），改为：
  - 收集 `sh_*` 的 disposer，和路由一起进 `disposers`（v1.1.11）；
  - 半装载整体回滚（工具/路由/订阅），失败后不在宿主上留残骸（v1.1.11）；
  - 卸载路径三行日志 + 撞名时给出"需重启 DSH"的可操作提示（v1.1.11）。
- 宿主侧问题（未调 cleanup 就 remount）建议反馈给 DSH：`dsh-hmr` 的 `reconcileProfile` 对
  `unmanaged-plugin` 只返回 restart-required，而面板"启用"这条路径仍会当场 mount 一次。

