# 副机补丁脚本（worker patches）

这三件事在 2026-11-01 的现场排查里必须做，否则**副机的 agent 模式会 100% 失败，而且一次模型请求都不会发出去**（表现为“派工正常、看板有任务，但副机没有任何 API 调用”）。

| 脚本 | 解决什么 | 改哪个文件 | 幂等 |
| --- | --- | --- | --- |
| `fix-agent-model.ps1` | 副机没有默认模型 → agent 会话落到 `deepseek-official` 路由，要求 `DEEPSEEK_API_KEY`，首个 turn 本地被拒 | `<profile>\cordis.patch.yml` 追加 `agent-default-model` 段 | 是 |
| `patch-followup-role.ps1` | `dsh-remote-agent` 投递任务书时缺 `role`，该消息进历史后 `serialize()` 抛 `TypeError`，被包装成 `DeepSeek Messages transport failed`（TRANSPORT） | `dsh-remote-agent/lib/node/runner.js` | 是 |
| `patch-transport-retry.ps1` | 中继判 `duplicate-node` 等错误时节点客户端直接 `stop()` 且不再重连 → 看板“在线”但派工永远 skip | `dsh-remote-agent/lib/node/transport.js` | 是 |
| `restart-dsh.ps1` | 安全重启：交给计划任务执行（能活过被杀的进程），冷启动要等 4~6 分钟 | 不改代码 | 是 |
| `start-dsh-now.cmd` | 手动恢复：机器被搞成离线、远程通道全断时，到机器前双击 | 不改代码 | 是 |

## 顺序

```text
fix-agent-model.ps1          # 补配置
patch-followup-role.ps1      # 补任务书 role（不修这个，补了配置也发不出请求）
restart-dsh.ps1              # 重启一次让上面两个生效
# 可选：patch-transport-retry.ps1 后再重启，避免 duplicate-node 之后永久失联
```

三个 `patch-*.ps1` 都会**先备份**（`.bak-<时间戳>` 或固定后缀），并用 `node --check` 校验语法；重复执行只会打印 `ALREADY`。

## 怎么下发

拷到副机能访问的共享目录（副机侧通常映射成 `Z:`），然后从主机的作业板派一条 exec 任务：

```text
pwsh -NoProfile -ExecutionPolicy Bypass -File "Z:\_tools\patch-followup-role.ps1"
```

或在副机上直接跑。脚本自己找 `$env:USERPROFILE\.dsh\profiles\desktop\node_modules\...`，不写死用户名（副机用户名和主机不同是最常见的坑）。

## 注意

- **路径一律用正斜杠**：`NODE_OPTIONS=--require "D:\a\b.cjs"` 会被 Node 当转义吃掉，变成 `D:ab.cjs`（2026-11-01 因此把 GT14 搞到起不来）。
- **不要在 exec 任务里“杀掉宿主再原地拉起”**：宿主一死执行器跟着死，任务记录变孤儿、机器直接失联。用 `restart-dsh.ps1`（计划任务）或到机器前双击 `start-dsh-now.cmd`。
- Electron 冷启动要 4~6 分钟，中途别按“失败”再杀一次。
- 这些补丁改的是**已安装的 npm 包**，重装 `dsh-remote-agent` 会被覆盖，需要重跑。

## 上游

`patch-followup-role.ps1` 修的是 `dsh-remote-agent` 0.9.12 的真实缺陷（`runner.js:797` 的 `agent.followup({ content, source })` 缺 `role`/`id`）。如果上游修了，这个脚本就可以删掉；症状是 `serialize()` 里 `previous.content` 的 `TypeError`。
