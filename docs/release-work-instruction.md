# dsh-job-board 发版作业指导书（WI-001，v1.0）

> 依据：`docs/release-review-procedure.md`（规程 v1.2，§0–§10 + 附录 A/B/C）。
> 用途：把规程变成能照着做的一串动作。**发版当天从「一页速查」开始，卡住再翻对应阶段。**
> 适用：每一次发版（含 patch、含只改前端）。修订：事故每新增一条，就在 §8 速查表加一行。

---

## 0. 一句话判定

> **没有 `docs/audit-<ver>/` 目录、没跑完 D1–D8 真机派工、没在真副机装过一次、npm 包的 sha1 与本地 tgz 不等——这四种情况任一出现，就不许发。**

---

## 1. 角色与开工条件

| 角色 | 谁 | 职责 | 不能做 |
|---|---|---|---|
| 主控（Lead） | 我 | 写码、合并、跑门禁、发起发布、回滚决策 | 不能给自己签核 |
| 审计员 | 盘古 / GLM / Kimi（新会话） | 全量审计 + 反证 + 负向门禁 | 不改代码、不 push |
| UI 走查 | GLM | 截图证据链、七路径 × 三态 | 只看默认首页不算 |
| 发布人 | 用户（或持 bypass-2FA token 的我） | npm 2FA 授权、deprecate | — |

开工前必须确认：
- 工作树干净（`git status` 无未预期改动）；基线 tag 已定（如 `v2.7.0`）。
- 版本号三处一致：`package.json` / `lib/worker/version.js` / `lib/client.js` 的 `CLIENT_VERSION`。
- 变更清单已知（改了什么、影响哪几条路径）。

---

## 2. 阶段 A：开发自检（提交前 10 分钟）

```powershell
Set-Location D:\gp_video\dsh-job-board
node scripts/check-text.mjs                 # 文本卫生（LF/无 BOM/无控制字符）
node scripts/plugcheck.mjs                  # 包名三处一致、routes、工具数
node scripts/client-render-smoke.mjs        # 客户端渲染冒烟（严格模式）
node --test "test/worker/*.test.mjs"        # 单测
node scripts/worker/pack-check.mjs          # 打包清单
# 或一把梭：
npm run gate
```

判定：全绿才能提交。**注意**：传输类用例偶发 1 失败是端口竞争，重跑一次再判断；连续两次失败才算回归。

提交纪律：
- 提交信息写「修什么/为什么」；含引号的中文标题用 `git commit -F <file>`；
- 新增/修改的脚本一律 LF + UTF-8 无 BOM（PowerShell 用 `[IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false)))`）；
- 版本号只在主控这里 bump（审查员不许改）。

---

## 3. 阶段 B：全量审计（不是增量）

```powershell
# 一次性采集证据骨架（scope/coverage/commands/negative/counterproof）
node scripts/audit-collect.mjs --version 2.7.3 --base v2.7.0 --crash-bundle <旧版崩溃 client.js>
```

产出到 `docs/audit-<ver>/`：

| 文件 | 内容 | 判定 |
|---|---|---|
| `scope/` | base head、changed-files、`unified=0` diff | 范围底账存在 |
| `coverage/` | 单测/冒烟日志 | 命令 exit=0 |
| `commands/{commands.json,results.jsonl}` | 每条命令 + cwd + exit + 耗时 | 无失败 |
| `negative/README.md` | 旧版必须 FAIL、新版必须 PASS | 两侧都有输出 |
| `counterproof/{paths.json,summary.json}` | 四态清单（EXECUTED/UNEXECUTED/UNKNOWN/N/A） | **任一 UNKNOWN = BLOCKED** |

交给审计员（新会话、全量、不给「只审 N 条」的框）必须带：
1. 范围底账；2. 改动清单；3. 已跑命令与输出；4. 要它回答的三件事（能不能发 / 有无新问题 / 外部可用性五步走查）。

审计员返回 `PASS` / `FAIL` / `BLOCKED`：
- `FAIL` → 修完从阶段 A 重来；
- `BLOCKED` → 补齐证据再判，不许「口头通过」；
- `PASS` → 进阶段 C。

> 六类**不能**单独当通过证据的材料：语法检查、源码里搜到字符串、默认首页能开、测试总数、pack-check、安全「无 P0/P1」。

---

## 4. 阶段 C：可用性走查（UI）

必做三件事：

1. **数据翻转**：初始为空 → 数据到达 → 再清空，三态都截图。2.7.0 就是「空态让模型区 `return null`」，数据一来就走进坏分支。
2. **七条路径矩阵**：每条路径 × 正常/空/畸形数据，留截图或 DOM 证据。
3. **降级可见**：故意制造渲染异常，确认面板显示占位 + `window.__dsbCrash`（不是整槽白屏）。

负向门禁（证明你的测试**能抓住**这个 bug）：
```powershell
$env:SMOKE_BUNDLE = 'C:\path\to\case\lib-client-2.7.0-crash.bak'
node scripts/client-render-smoke.mjs      # 必须 FAIL（含 Minified React error #130），exit=1
Remove-Item Env:\SMOKE_BUNDLE
node scripts/client-render-smoke.mjs      # 必须 PASS，exit=0
```
两边输出都要贴进 `docs/audit-<ver>/ui-render.md`。

---

## 5. 阶段 D：真机安装 + 派工矩阵（本轮最容易漏）

### 5.1 安装（原子，绝不用 robocopy 覆盖运行中目录）

在**副机**上双击/执行 `Z:\_tools\dsh-job-board\upgrade-worker.cmd`（或 `install-agent-worker.ps1`）：
- 脚本会：解包 → 校验 → `.stage-<ts>` → 写 `install-manifest.json` → 旧目录改名 `.bak-<ts>` → 换名 → 复核（版本 / 文件数含清单 / 关键文件 SHA256）→ 失败回滚并**自动拉起 DSH**。
- 装完立刻验三件事：
```powershell
# 1) 版本探针（板上看 note，或本机 doctor）
Invoke-RestMethod http://127.0.0.1:<port>/api/board/ui/doctor | Select-Object version,installedVersion
# 2) DSH 确实在跑（进程 + 面板能开）
# 3) 插件无安装清单 warn（有 warn = 混合树，回滚）
```

### 5.2 派工矩阵 D1–D8（每格真派一次，板上看终态）

| # | 目标机 | mode | model | 期望 |
|---|---|---|---|---|
| D1 | 本机 | exec | — | done, `exit=0` |
| D2 | GT14 | exec | — | done, note 带 `worker:gt14` |
| D3 | GT14 | agent | 空（auto） | 走本机 worker；done 或明确 `agent-not-allowlisted` |
| D4 | GT14 | agent | 本机清单内模型 | done，且 **`remote_id` 为空** |
| D5 | GT14 | agent | 云模型 | done 或 **可操作 blocked**（说缺 provider/登录），不许沉默 failed |
| D6 | PC2 | agent | 同上 | 同上 |
| D7 | 任意 | agent | 清单里不存在的模型 | 秒级 blocked，note 含「不在 … 在线清单」 |
| D8 | 任意 | maint | version | done，`plugin=<ver>` |

取证：`L:\云盘\gp_video_xfer\_board\state.json` 里按 task_id 抓 `status / note / remote_id / 时间`。
副机配置前置（agent 派工）：`workerMode=on`、`agentEnabled=on`、`agentAllowlist` 至少一条能命中（受控机 `[{id:"any",matchAll:true}]`）、云模型需副机有同名 provider 且凭据就绪。

---

## 6. 阶段 E：发布

### 6.1 npm
```powershell
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''
npm publish .\wfcj-dsh-job-board-<ver>.tgz --access public --noproxy '*'   # 需 2FA 授权（人）
npm view '@wfcj/dsh-job-board' dist-tags --noproxy '*'                    # latest=<ver>
npm view '@wfcj/dsh-job-board@<ver>' dist.shasum,dist.fileCount --noproxy '*'
```
- **必须核对**：`dist.shasum` == 本地 tgz 的 SHA1；`fileCount` == pack-check 的数字。
- 发布失败类型：`EOTP`（需人授权 / bypass token）、TLS 失败（代理，加 `--noproxy '*'`）。

### 6.2 GitHub Release + tag
```powershell
git tag -a v<ver> <commit> -m "v<ver>: <一句话>"
git push origin main; git push origin v<ver>
git ls-remote --tags origin | Select-String "v<ver>"
```
再到 GitHub 建 Release（正文写：修什么 / 怎么验 / 已知限制 / 回滚方式）。**Releases 与 tag 必须同时存在**——客户端更新提示读 Releases。

### 6.3 商城（awesome-dsh-plugin）
- 条目已合并就不动；只在描述与实际能力不符、或维护者提了意见时更新。
- 维护者意见视为发版输入，处理完在 PR 里回一条并附 commit。

### 6.4 旧版本 deprecate（有问题的版本）
```powershell
npm deprecate "@wfcj/dsh-job-board@<旧版>" "<原因>，请升级到 <ver>"
```

---

## 7. 阶段 F：上线后观察与回滚

观察（首 24 小时）：
- 面板能开、点「派工」不白屏；
- 板上任务能进终态（`done` / 明确 `blocked`），不出现沉默 `failed`；
- 副机能领到任务（note 有 `worker:<machine>`）。

回滚（按代价从低到高）：
1. **配置回滚**：用最早的 `cordis.patch.yml.bak-maint-*` 覆盖；
2. **插件回滚**：`Z:\_tools\dsh-job-board\rollback-gt14.cmd`（把当前目录改名 `.broken-<ts>`，最近 `.bak-*` 换回）；
3. **npm**：发更高补丁版覆盖 `latest` + `deprecate` 坏版本（版本不可撤销）；
4. 任何回滚动作都要在板上 `board_say` 留一句，并写进 `docs/audit-<ver>/summary.md`。

---

## 8. 坑速查（全是这两天真踩过的）

| 症状 | 真实原因 | 正确做法 |
|---|---|---|
| 点「派工」整槽白屏、`React error #130 args[]=object` | `h(h(...))`，element type 是对象 | 外层补 `'div', null`；冒烟严格校验 type |
| 冒烟全绿但线上崩 | 冒烟只渲染默认态 | 加 `ask=true` + 数据翻转用例；用 `SMOKE_BUNDLE` 证明能抓住旧包 |
| GT14 装完 DSH 起不来，`does not provide an export named 'canDispatchRemote'` | 混合树（新 index + 旧 dispatch-filter） | 原子安装 + 清单校验；禁止 robocopy 覆盖运行中目录 |
| 装脚本报 `Warn is not recognized` | 调用了未定义函数 | 统一 `Say/Warn/Die` 三件套 |
| 复核「多了一个文件」108 vs 107 | `install-manifest.json` 被算进比对 | 比较 `$srcFiles.Count + 1` |
| `Cannot bind parameter 'RemainingScripts'` | `($x \| ForEach-Object { } -join ',')` 少括号 | `(((...) \| ForEach-Object { }) -join ',')` |
| 只改配置时 `Exit=1`、配置没写 | `-SkipPackage` 分支 `$tmp` 未赋值，收尾 `Test-Path` 抛异常 | 配置写入走 `patch-config.ps1`，失败也要拉起 DSH |
| 派工直接 failed「headless 后端不支持指定模型」 | 机器名大写命中远程桥 | 带 model 的 agent 不进远程桥（2.7.2 修）；D4 验 `remote_id` 空 |
| 派工 blocked `agent-not-allowlisted` | allowlist 条目只有 id、无 `matchAll`/前缀 | 受控机写 `[{id:"any",matchAll:true}]` |
| `npm publish` 报 `EOTP` | auth-and-writes 账号需人授权，URL 被脱敏 | 人授权 / bypass token；别反复重试 |
| npm 报 `ECONNRESET` | 7897 代理拦 TLS | `--noproxy '*'` + 清代理环境变量 |
| 客户端不提示更新 | 只推 tag 没建 Release | tag + Release 同步 |
| 票据 `maint-ticket-badsig` | 手抄票据串错 | 程序化 POST，或抄完比对长度（432 字符） |
| `config-set` 没写盘 | 默认 `dryRun=true` | 显式 `"dryRun": false` |

---

## 9. 一页速查（发版当天贴手边）

```
□ 工作树干净；版本号三处一致；基线 tag 已知
□ npm run gate 全绿（check-text/plugcheck/smoke/unit/pack-check）
□ node scripts/audit-collect.mjs --version <ver> --base <tag> --crash-bundle <bak>
□ 全量审计 PASS（新会话、全量、不给「只审 N 条」）
□ 反证清单无 UNKNOWN
□ 负向门禁：旧包 FAIL + 新版 PASS（两条输出都贴档）
□ UI：数据翻转三态 + 七路径 × 三态截图 + 降级占位可见
□ 真副机原子安装：版本 / 文件数 / SHA256 / 清单 warn 无
□ D1–D8 真派工，D4 remote_id 空，D5/D7 是可操作 blocked
□ npm publish 成功；dist.shasum == 本地 sha1；fileCount 对
□ tag 已推；Release 已建（正文含修什么/怎么验/回滚）
□ 有问题版本已 deprecate；回滚话术在手
□ docs/audit-<ver>/summary.md 写齐 C1–C8 适用性
```
