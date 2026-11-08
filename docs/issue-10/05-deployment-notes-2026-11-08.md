# 部署备忘：本机 profile 里两处「不在仓库里」的状态

> 记录时间：2026-11-08
> 触发事件：2026-11-07 深夜两条 `auto` 任务在板上挂了 8 小时没被派出去，根因是本机 profile
> 重建时丢了 remote-agent hub 的两处登记；2026-11-08 上午已修复并验证派工恢复。
> 本文的作用：**profile 再重建一次时，照着做完这两步，别又静默停摆。**

## 一、症状与判定（下次先看这三条）

```powershell
# 1) hub 有没有在监听（本机 LAN IP 192.168.3.40 是这台机的以太网地址）
Get-NetTCPConnection -LocalPort 19387 -State Listen

# 2) hub 健康检查
Invoke-WebRequest http://192.168.3.40:19387/api/remote-agent/healthz -UseBasicParsing   # 期望 200 {"ok":true}

# 3) dsh-team 的日志会自己点名（v1.1.12 起）
Select-String -Path "$HOME\.dsh\profiles\desktop\node_modules\dsh-team\_runtime.log" -Pattern 'dispatch idle|remote nodes|dispatched' | Select-Object -Last 10
```

- 出现 `dispatch idle: remote-agent 没有在线节点（nodes 请求失败: HTTP 404），检查 hub 是否加载、19387 是否在听、worker 是否连上`
  ⇒ **hub 没加载**（不是任务本身有问题）。
- 出现 `dispatch idle: 读板子失败 …` ⇒ 板子（`DESKTOP-NJ6NG3V:8965`）不可达或超时，与 hub 无关。
- 一切正常时的形态：`remote nodes: desktop-2gh05s7→mb14, gt14→gt14` → `dispatched <taskId> → <node> remote=<remoteId>`。

> 注意：板上 GT14 / MB14 显示「在线」来自它们各自的 dsh-team `caps` 心跳（板子 8965），
> 与 hub（19387）是**两条独立通道**。所以「板子上机器都在线」不能证明 hub 活着。

## 二、必须同时存在的两处 profile 状态

profile 目录：`C:\Users\17827\.dsh\profiles\desktop`

### 1) `package.json` → `dsh.profile.bundles` 必须包含 `dsh-remote-agent`

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      // …其它 bundle…
      "dsh-team",
      "dsh-remote-agent"     // ← 少这一项，包自带的 cordis.patch.yml 不会被展开
    ]
  }
}
```

为什么关键：`node_modules/dsh-remote-agent/cordis.patch.yml` 第 82 行是
`- insert:`，它负责**插入** id 为 `remote-agent` 的插件行。只有该包被列进 `bundles`
时，这一层 patch 才会被 loader 展开。

### 2) `cordis.patch.yml` 里要有同 id 的**覆盖**行

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: [ 'webServer', 'tools', 'systemPrompt' ]
  config:
    role: hub
    listenHost: '192.168.3.40'      # 必须填本机某个具体网卡地址，不能是 0.0.0.0
    listenPort: 19387
    nodeToken: 'nt_32fcd1cb4dd54bd9883f7ba40ebecaa8'
    systemPrompt: true
```

`config` 是**整体替换**而不是深合并，所以要写全——少一个字段就等于把它清空。

### 只做其中一半会怎样（本次事故）

只保留 2) 而 1) 丢了 ⇒ 覆盖行「目标不存在」⇒ 按
《cordis-composition-reference》的 Loader 方言规则，loader **warn 后静默跳过**：
启动不报错、插件不出现在列表、19387 无监听、`remote_*` 工具缺席，只有 dsh-team 的派工在默默空转。
这也是为什么当时「板上一切正常、日志里一条 take/dispatch 都没有」。

依赖本身（`dependencies.dsh-remote-agent`）在不在**无关**——包装着不等于行被加载。本次事故里
`dependencies` 有 `0.9.12`，但 `bundles` 没有，于是完全没生效。

## 三、改完怎么让它生效

`bundles` 与 `cordis.patch.yml` 都**只在启动时读**，没有热重载：改完必须重启 DSH。
重启后按第一节的三条命令验收，再确认板上 `queued` 能往前走。

## 四、副机（worker）侧对应状态

- worker 自己的 profile 里，`remote-agent` 行是 `role: worker` + `hubUrl`（或 relay），
  `inject` 为 `['tools','agentLoop','sessions']`；`roots` 决定它允许在哪些目录跑命令。
- 它连上 hub 后会在 `C:\Users\<用户>\.dsh-remote-agent\` 写
  `hub-pin.json`（TOFU：首次连接的 hub 指纹 + endpoint，之后要求一致）与 `audit.jsonl`。
- 本机（hub）侧同一目录的 `audit.jsonl` 可用来核对派发与执行事件。

## 五、顺带记下的两个已知小坑（不阻塞派工）

1. **`caps` 上报可能 `ok=false`**：板子 `/api/caps` 实测 6111 ms 返回，而插件
   `cfg.timeoutMs` 是 8000 ms，启动瞬间容易贴边超时；表现是面板上 host 的配置卡时间戳不刷新。
   派工走 remote-agent 节点表，不受影响。
2. **板子 `/api/board` 单次约 6–7 s / ~110 KB**：`snapshot` 与派工轮询共用同一超时，
   板子变慢时两者会一起退化。真实修法在板子侧（增量查询/缓存），插件侧只能加超时隔离。
