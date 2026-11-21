# 运维手册（operator playbook）

> 面向「要用它、要排障、要回滚」的人。讲的是这台插件在真实机器上的行为，不是设计意图。
> 版本基线：v2.7.0（文档可能滞后于代码，以代码里的 reason 常量为准）。

## 1. 三个角色，一条链路

| 角色 | 配置 | 干什么 | 不该干什么 |
| --- | --- | --- | --- |
| **owner / hub**（主控机） | `dispatchRole: owner`、`boardUrl` 指向本机看板 | 建单、派工、看板 HTTP 服务（默认 `0.0.0.0:8965`）、提供浏览器面板 | 不跑 worker 循环（`workerMode: off`） |
| **worker**（副机） | `workerMode: on`、`boardUrl` 指向主控机、`machine` 唯一 | 轮询领任务，执行 `exec`（PowerShell）或 `agent`（本机起 DSH 会话） | 不要把 `approvalMode` 设成 `auto` 除非是受控实验室机器 |
| **solo**（独立模式） | `solo: true`、不连外部看板 | 单机自用：本机起一个看板 + 面板，一个进程两副面孔 | 不要和 owner 混跑同一个状态目录 |

最小可用组合：

```yaml
# 主控机（profile 的 cordis.patch.yml，按行 id 覆盖）
- id: team
  config:
    boardUrl: 'http://127.0.0.1:8965'
    machine: 'host'
    dispatchRole: owner
    workerMode: 'off'
```

```yaml
# 副机
- id: team
  config:
    boardUrl: 'http://<主控机 IP>:8965'
    machine: '<this-machine-name>'
    workerMode: 'on'
    approvalMode: 'manual'
    allowlist:
      - 'C:\path\to\scripts\'        # exec 只跑这个目录下的 .ps1
    execCwdRoot: 'C:\Users\you\Documents'
    worker:
      agentEnabled: true
      agentPreset: 'standard'
      agentCwdRoot: 'C:\Users\you\Documents'
      agentApproval: 'confirm'       # 人审；auto 等于不审
      agentAllowlist:
        - id: 'dispatch-smoke'
          goalPrefix: '只回答'
      agentBudgetMaxPerDay: 20
```

> 注意：profile 的 `config:` 是**整块替换**，不是深合并。改之前把整块抄全，否则漏掉的键会回到插件默认值。

## 2. 部署：为什么改了仓库不生效

- profile 里装的是 `file:D:/...` 依赖，但 pnpm 装出来的是**普通复制副本**，不是软链、不是硬链。
- 所以部署 = 把仓库的 `lib/` 复制进 `C:\Users\<你>\.dsh\profiles\<profile>\node_modules\@wfcj\dsh-job-board\lib\`，再覆盖 `package.json`（+ `CHANGELOG.md`、需要的 `scripts/`）。
- **客户端**（`lib/client.js`）刷新页面即可生效；**服务端**（`lib/index.js`、`lib/worker/*`）要**重启 DSH** 才换代码。
- 部署后自检：`GET http://127.0.0.1:<DSH端口>/api/board/ui/doctor`，看 `version`（运行中）与 `installedVersion`（磁盘上）。两者不一致 = 还没重启。
- DSH 的 Web 端口**每次重启可能变**。查端口：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object OwningProcess -in (Get-Process 'DeepSeek Harness').Id |
  Select-Object LocalAddress, LocalPort
```

## 3. 任务状态与错误码（排障先看 `note` / `reasons`）

板子上多数任务的 `note` 带 `stage=<阶段> reason=<原因>` 前缀；**claim 阶段的 note 只有 `preamble`（不含 stage/reason）**，别拿它当错误码找。按阶段分：

**claim / 领任务**
- `claim 409`：别人已经抢到（正常并发，不是错误）。
- `claim: <error>`：看板不通 / token 错 / 超时。

**exec（跑脚本）**
| reason | 含义 | 处置 |
| --- | --- | --- |
| `empty` | 任务里没给脚本路径 | 补 `script` 参数 |`n| `not-allowlisted` | 脚本不在白名单内，且 `approvalMode=manual`（**运行期 note 里显示为 `approval-required`**） | 加白名单，或人工审批 |
| `not-allowlisted-auto` | **放行**了非白名单脚本（`approvalMode=auto`） | 你开的是自动放行，确认机器受控 |
| `not-absolute` / `bad-path` / `bad-extension` | 路径不是绝对路径 / 含 `..` / 不是 `.ps1` | 修正任务参数 |
| `missing` / `not-file` | 脚本不存在 / 是目录 | 检查副机上文件是否真的在 |
| `inline-command-not-allowed` | 内联命令被拒（未开 `allowInline`） | 写成 `.ps1` 再派 |
| `pwsh-missing` | 找不到 pwsh 7 | 配 `worker.pwshPath` 或装 PowerShell 7 |
| `cwd-root-invalid` / `cwd-not-in-root` | `execCwdRoot` 无效或任务 cwd 不在其中 | 修配置或任务 `workspace` |

**agent（起 DSH 会话）**
| reason | 含义 | 处置 |
| --- | --- | --- |
| `agent-disabled` | `worker.agentEnabled=false` | 设 true |
| `agent-misconfigured:<缺什么>` | 缺 `agentPreset` / `agentCwdRoot` | 补齐 |
| `agent-unavailable` | 拿不到 `agentLoop` / `sessions` 服务 | 插件版本 < 2.6.14 时 inject 缺声明；升级并重启 |
| `agent-not-allowlisted` | 白名单为空或不匹配 | 加白名单条目 |
| `agent-preset-denied` / `agent-tools-unsupported` | preset 被 `agentTools` 拒 / `deny` 非空 | 改 `agentTools` |
| `agent-prompt-denied` | 提示词闸门拒 | 看 `agentPromptGate` 规则 |
| `agent-approval-required` | `confirm` 模式待人审 | 本机 `worker_control action=approve taskId=…` |
| `agent-cwd-denied` | cwd 越界（unc/dots/not-dir/unresolved/outside） | 修 `agentCwdRoot` 或任务 `workspace` |
| `agent-budget-exceeded` | 当日预算用尽 | 等次日或调 `agentBudgetMaxPerDay` |
| `agent-start-failed` / `agent-error` / `agent-run-failed` | 起会话失败 / 运行报错 / 异常退出 | 看 `agent/error` 事件与副机日志 |

**maint（只读维护通道）**：`stage=maint verb=version|status|config|logs`。它不 spawn、不跑任意命令；`config` 按白名单重建（token / nodeToken 这类键**根本不出现**在输出里，不是打「已配置」占位）。

### 3.4 维护写通道（v2.7.0，默认关闭）

写动词 `upgrade` / `config-set` / `restart` 与只读通道是两个开关：只读默认开，写动作要显式打开并落公钥（信任锚）。

**第一步：主控生成密钥对（只做一次）**

```powershell
pwsh -File scripts/maint-ticket.mjs keygen --out "$HOME\.dsh\maint\maint-key.json"
# 输出里 publicKey 就是要发到副机的那串；私钥留在主控，不要拷走
```

**第二步：副机打开写开关 + 落公钥**

```powershell
# 在副机上跑（退出 DSH 后跑，或加 -Force 自担热重载风险）
pwsh -File scripts/enable-maint-write.ps1 -PublicKey '<主控 publicKey>' `
  -OutDir 'C:\maint-out' -PkgDir 'C:\maint-pkgs'
# 只看会改什么：加 -DryRun；允许远程重启：再加 -AllowRestart
```

它只补缺失/不匹配的键，重复跑是幂等的；写前备份 `cordis.patch.yml.bak-maint-<时间戳>`，写后复核键是否落在 `worker:` 子块内，失败自动回滚。**写完重启副机 DSH**。

**第三步：签发票据并派工**

```powershell
# 1) 写 payload（必须是单行 JSON，ticket 行由 sign 追加）
'{"verb":"config-set","set":{"agentBudgetMaxPerDay":21},"dryRun":true}' | Set-Content $env:TEMP\payload.json -Encoding utf8
# 2) 签票（ttl 30..3600 秒；-machine 必须与目标副机的 machine 名一致）
pwsh -File scripts/maint-ticket.mjs sign --key "$HOME\.dsh\maint\maint-key.json" `
  --payload $env:TEMP\payload.json --machine gt14 --ttl 600 --out $env:TEMP\goal.txt
# 3) 派工（票据走独立字段，不塞进 goal —— goal 有 300 字上限）
```

面板里也可以：派工弹窗选 `maint` + 贴票据 + 点「预览改动」。

**已知边界（v2.7.0）**

- **预览只反映本机配置**：多机场景下 `config-diff` 读的是 Host 的 `cordis.patch.yml`，而实际 `config-set` 写的是**目标副机**的配置；面板对远程目标会直接给出这条提示、不展示可能误导的 diff。要精确预览请在副机本机看。
- 票据一次性：`recordNonce` 落盘后同票重放返回 `maint-ticket-replayed`；`board_retry` 对写动词直接拒绝（需重新签票）。
- 写动作结果摘要落在副机的 `maintenanceOutDir`，note 里只带 `reason`，不含票据与签名。


## 4. 常见故障

1. **面板 403 `forbidden`**：`uiGuard` 拒了，看返回体里的 `why`：`host`（Host 不是 loopback、也不在 `uiAllowedHosts`）、`origin`（Origin 与 Host 不一致，反代改写 Host 时常见）、`header`（写请求缺 `x-dsh-team-ui: 1`）、`content-type`（写请求不是 `application/json`）、`method`（对写型路由发了 GET/HEAD）。返回体形如 `{ok:false,error:'forbidden',why}`。
2. **面板转圈、任务列表空**：看板服务没起（`8965` 不通）、或 `boardUrl` 写成了 `127.0.0.1` 但你是从别的机器访问。
3. **副机一直 idle**：`workerMode` 不是 `on`；或 `boardUrl` 指向的错误；或 `machine` 与看板上的注册名不同（`worker_status` 会显示 machine）。
4. **任务卡在 running**：副机崩了/断网。租约（`leaseMinutes`，默认 10 分钟）过期后按 `orphanPolicy` 处理：`blocked`（默认，保守）/`requeue`/`ignore`。
5. **agent 任务全部 blocked**：先看 `worker_status` 的 `agent` 字段——它直接给 `available()` 的 reason。

## 5. 安全边界（写清楚，别误解）

- **`sh_run` 不是沙箱**：它只管「文件路径必须在 `allowedRoots` 内」，**命令内容本身不受限**。它是给受信任的 in-process 会话用的，不是给不可信任务用的。
- **`exec` 才是远程任务的执行面**：绝对路径 + `.ps1` + realpath 白名单 + 审批模式，才是给「看板上任意任务」准备的闸门。
- **`agent` 不是沙箱**：agent 会话里的工具随 preset 决定，能读写就是能读写。`confirm` 审批是唯一的人审口。
- **白名单按目录边界匹配，不是朴素字符串前缀**：`C:\scripts\` 不会放行 `C:\scripts-evil\x.ps1` —— 比较前两边都 realpath 成规范路径、再按目录边界（`isWithin`）比。但**条目本身别写成盘根**（`C:\`），那等于全放行。
- **token 只在 header 里**：`x-board-token`。板子返回、note、日志不该出现它；看到就是 bug。

## 6. 回滚

1. 代码层：`git -C D:\gp_video\dsh-job-board checkout <上一个 tag>`，重新复制 `lib/` 到 profile，重启 DSH。
2. 配置层：改 `cordis.patch.yml` 前先备份（`.bak-<时间戳>`），回滚就是换回备份再重启。
3. 任务层：状态写坏的条目用 `board_retry`（工具）或看板 UI 的「重试 / 打回」。`worker_control` 的动作只有 `drain / resume / cancel / tick / orphans / approve / revoke`，**没有 requeue**。
4. 插件层：`plugin_manager` 里先 `disable` 再 `enable` 拿回干净实例——注意它不会替你清状态目录。

## 7. 发版前自检（给维护者）

```powershell
cd D:\gp_video\dsh-job-board
npm run gate     # check-text → plugcheck → client-render-smoke → 全量测试 → pack-check
git tag vX.Y.Z && git push origin main --tags
```

版本号是**四处同步**：`package.json`、`lib/worker/version.js` 的 `VERSION`、`lib/client.js` 的 `CLIENT_VERSION`、`CHANGELOG.md` 顶部标题。`plugcheck` 会断言前三者一致，`check-text` 断言 CHANGELOG 与 package.json 一致。
