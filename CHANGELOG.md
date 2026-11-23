## v2.7.13 — 2026-11-23（2.7.12 复审修正：日志落点一致 + 回执补全 + 测试真覆盖）

> 2.7.12 的定向复审（`docs/audit-2.7.12/review-2.7.12.md`）判 FAIL：P2-1 只修了 `runRestart` 一半——`stateDir` 设了以后回执指向 JS 侧标记日志，而 helper 仍写 `%TEMP%`；`upgrade` 两条回执根本没写日志路径；另外两条新测试没有真的覆盖目标代码行（P1-1 的 swap 行、P3-2 的 `log.warn`）。

### 修复
- **P1（日志落点不一致）**：新增 `restartLogPath(stateDir, taskSlug)`，helper 与回执、JS 侧标记日志**三者用同一路径**（`<stateDir>/restart-<slug>.log` 或 `%TEMP%\dsh-maint-restart.log`）；helper 先 `New-Item -Force` 建目录再写日志。
- **P1（upgrade 回执缺日志与免责）**：`upgrade` 成功排入重启时，note 追加「spawn 成功 ≠ 重启成功，结果以助手日志为准：<路径>」并回传 `logFile`；未排入时明确「未排入自动重启；可手动重启或开 `maintenanceAllowRestart`」。
- **P2（测试覆盖）**：P1-1 真实执行用例补 `moveFrom/moveTo`（swap 行真的生成并执行，断言日志里 `$()` 原样保留、无年份展开）；P3-2 用例改为「合法包 → 装包成功 → spawn 抛错 → `log.warn('排入重启失败')`」真正覆盖目标行。
- **P2（部署脚本）**：`scripts/deploy/upgrade-worker.ps1` 的重启 here-doc 增加「杀进程后复核 + 结果写日志 + 失败在结果文件里明说」，不再静默。

### 新增测试（`test/worker/maint-verbs-restart-script.test.mjs`，8 条）
- 新增：`stateDir` 下回执 hint ↔ helper 日志路径一致；`upgrade` 回执含日志路径与免责声明；`upgrade` 排入失败真的走 `log.warn`。

### 验证
- `npm run gate`：单测 **491/491**、smoke 65/65、plugcheck 18/28、check-text PASSED、pack-check 109 文件 / 1,532,596 B。
- 负向门禁不变（UI 崩溃包 FAIL、修复版 PASS；`SMOKE_BUNDLE` 版本 0/29 照旧）。

## v2.7.12 — 2026-11-22（2.7.11 复审修正：重启助手脚本的 P0/P1）

> 2.7.11 的定向复审（`docs/audit-2.7.11/review-2.7.11.md`）判 FAIL：重启助手脚本有三处会在真机上把安装目录搞坏或让日志说谎。本版按复审条目逐条修掉，并把「脚本层」纳入测试。

### 修复
- **P0-1（换目录失败静默 → 源被挪成目标的子目录）**：`Remove-Item` 加 `-ErrorAction Stop` 并包 try/catch；删不掉立刻记 `$fail`、结束 `exit 1`；再加一道「删后仍在 → `remove-left-target`」；`Move-Item` 同样 `-ErrorAction Stop`。
- **P1-1（引号上下文错 → `$` 与 `$(...)` 被 PowerShell 展开/执行）**：日志行改为 `L ('swap ' + 'A' + ' -> ' + 'B')` 单引号拼接；路径一律 `q()` 转义（单引号加倍）。
- **P1-2（回执骗人）**：helper 自证——成功写 `restart-succeeded` + `exit 0`，任何失败写 `restart-failed <原因>` + `exit 1`；`Start-Process` 失败也算失败（不再 spawn 成功后就说「将重启」）。
- **P2-1（日志路径不在回执里）**：`runRestart`/`upgrade` 的回执 note 写明日志位置（`<stateDir>/restart-<slug>.log` 或 `%TEMP%\dsh-maint-restart.log`），并明确「spawn 成功 ≠ 重启成功，以日志为准」。
- **P2-2（pid/delayMs 未校验）**：非有限数归一（delay 缺省 6000ms、pid 缺省 0）。
- **P3-1（死代码）**：删除 `psQuoteStr` / `psQuote`。
- **P3-2（`trace` 未定义）**：`runUpgrade` 的 `trace(...)` 改 `log.warn(...)`，并把 `ctx` 正确传进 `runUpgrade(payload, ctx)`。

### 新增测试（`test/worker/maint-verbs-restart-script.test.mjs`，6 条）
- 脚本结构：`Remove-Item … -ErrorAction Stop`、`Move-Item … -ErrorAction Stop`、`restart-failed`、`verify-missing`、`exit 1`、`restart-succeeded`；日志行必须是单引号拼接。
- **真实执行**（不是只跑 JS 分支）：① 路径里含 `'$(Get-Date -Format yyyy)` 的 exe → 日志原样记录、不被展开；② 换目录失败（目标父级是文件）→ `exit 1` 且源目录仍在。
- 回执 note 含日志路径；`upgrade` 排入失败走 `log.warn` 不抛 `ReferenceError`。

### 验证
- `npm run gate`：**489/489**、smoke 65/65、plugcheck 18/28、check-text PASSED、pack-check 109 文件 / 1,529,689 B。
## v2.7.11 — 2026-11-22（重启助手改成「按 exe 路径杀 + 全程日志」）

**修复**
- 2.7.10 的「换包后自动重启」在真机没生效：helper 只按 `Stop-Process -Id <pid>` 杀进程，实测会被拒（权限/父子关系），
  脚本静默失败、DSH 根本没重启（任务回执却写「将在 N 秒后重启」）。
- 现在 helper 统一由 `buildRestartScript()` 生成：
  ① 先 `Get-Process` 枚举、按 `$_.Path -eq <dshExe>` 精确匹配后逐个 `Stop-Process -Force`；
  ② 一个都没杀到时才回退到 pid；
  ③ 全过程追加写 `%TEMP%\dsh-maint-restart.log`（helper start / kill path pid / kill failed / fallback / start / done）；
  ④ `Start-Process` 带上 `-WorkingDirectory`（exe 所在目录），避免以错误 cwd 启动。
- 三条路径共用同一构造：`restart` 动词、`queueRestartOnly`（换包后重启）、`queueInstallThenRestart`（EPERM 时停→换→拉起）。

**说明**
- 重启仍是「升级完成后立刻自动做」。若需要「装好但等人点重启」，见后续 2.8.x 的 UI 更新流程（机器卡显示版本 + 手动重启按钮）。

**怎么验证**
- `npm run gate` 全绿；`test/worker/maint-verbs.test.mjs` 断言脚本含路径枚举与重启日志。
- 本机夹具：起一个临时 exe 进程 → 跑生成的脚本 → 旧进程被杀、新进程拉起、日志三行落地。
## v2.7.10 — 2026-11-22（远程升级真正闭环：换包后自动重启）

**修复**
- `lib/worker/maint-verbs.js`：`swapIn()` 成功后 DSH 仍在跑旧代码，原来只回「需重启」，等于把最后一步推回给人。
  现在若已开维护重启许可（`maintenanceAllowRestart: true` + `dshExePath` 存在），直接排入 detached 助手：
  等 6 秒 → `Stop-Process` 旧进程 → 停 2 秒 → `Start-Process` 拉起；note 写明「约 6 秒后自动重启 DSH 生效」。
- 新增 `queueRestartOnly()`（只重启，不再动包目录）；EPERM 分支原有的「排入安装 → 停 → 换 → 拉起」保持不变。

**测试**
- `test/worker/maint-verbs.test.mjs` 新增 1 条：换名成功 + 已开重启许可 → `queued: true`、spawn 脚本含 `Stop-Process`/`Start-Process`、且不再含 `Move-Item`。

**怎么验证**
- `npm run gate`（单测、smoke、check-text、pack-check 全绿）
- 真机：`maint upgrade` 推同一版本 → note 出现「自动重启」→ 约 8 秒后 GT14 实例号变化、`plugin=2.7.10`
## v2.7.9 — 2026-11-22（派工体验回到「指派即跑」：审批默认 auto + 路径展开）

**体验修复（对齐加通讯插件之前的派工）**
- `agentApproval` 缺省从 `confirm` 改为 **`auto`**：主控派工 + 选机器 + 选模型之后，副机直接执行，
  不再要求「在那台机器上再点一次批准」。`confirm` 保留为实验机/高风险机器显式选项
  （`agentApproval: confirm` 时行为与 2.7.8 完全一致）。
  安全边界不变：`agentAllowlist` 前缀、`agentBudgetMaxPerDay`、提示词门（prompt gate）、
  `agentCwdRoot` 包含校验都仍是静默校验，不需要人工点。

**缺陷修复**
- 配置路径不展开环境变量：`agentCwdRoot` / `execCwdRoot` 配 `%USERPROFILE%\Documents` 会被原样
  送进 `statSync` ⇒ agent 任务恒报 `agent-cwd-denied why=unresolved`（真机 2026-11-22 复现）。
  现在统一展开 `%VAR%`、`$env:VAR` 与 `~`；任务的 `workspace` / `execCwd` 候选同样展开。

**测试**
- `test/worker/worker-payload-merge.test.mjs` 新增 2 条：路径展开、`agentApproval` 缺省为 auto。

**验证**：`npm run gate` 全绿（单测 482、smoke 65、plugcheck 18/28、pack-check 108 文件）。
## v2.7.8 — 2026-11-22（远程升级治本：DSH 运行时可停可换可拉起）

**修复（远程升级一直失败的真因）**
- `lib/worker/maint-verbs.js` 的 `upgrade` 原来在 DSH 运行时直接 `rename(pkgDir → .bak)` 再 `cp` 进去。
  Windows 上运行中的 DSH 占着包目录里的文件 ⇒ `EPERM`，远程升级**永远失败**（只能本机点脚本）。
- 现在分两步：
  1. 先复制到同卷 `staging` 目录（新目录没有锁，运行中也能写）；
  2. 尝试原子换名；若仍 `EPERM/EACCES/EBUSY` 且**允许重启**（`maintenanceAllowRestart: true` + `dshExePath` 存在），
     则排入 detached 重启助手：`停 DSH → 等 2 秒 → 换包 → 拉起 DSH`，任务回报 `queued: true`（约 6 秒后生效）。
  若不允许重启，报错改成可操作文案（提示先开维护重启许可或本机跑 `upgrade-worker.cmd`），不再只丢一个 EPERM。
- 换名失败一律回滚（旧内容原样恢复），staging 目录清理。

**`scripts/enable-maint-write.ps1`（一次本机运行，永久解锁自动升级）**
- 新增 `-DshExePath`（可自动探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`、Program Files、开始菜单快捷方式）。
- `-AllowRestart` 时同时写 `maintenanceAllowRestart: true` 与 `dshExePath`（这两个键**刻意不在远程可写白名单**，只能本机写）。
- `-PkgDir` 缺省自动探测 `Z:\_tools\dsh-job-board` / `L:\云盘\gp_video_xfer\_tools\dsh-job-board`（盘符未映射时安全跳过）。

**测试**
- `test/worker/maint-verbs.test.mjs` 新增 2 条：EPERM + 未开重启许可 → `maint-install-failed` 且旧内容回滚、提示含 `maintenanceAllowRestart`；
  EPERM + 已开重启许可 → `queued: true` 且 spawn 的脚本含 `Stop-Process` / `Move-Item` / `Start-Process`。

**验证**：`npm run gate` 全绿（单测 480、smoke 65、plugcheck 18/28、pack-check 108 文件）。
## v2.7.7 — 2026-11-22（Host 侧回板路径脱敏：远端 reasons / note 先打码后截断）

**安全（2.7.6 定向复审 §6 记录的既有同类缺陷，本版修复）**
- 复现链：副机任务结束后 Host 侧 `syncRemote` 读回 logs → `parseDshResult()` → `POST /api/mark` 写板。
  原实现 `lib/index.js` 把 `result.reasons` 直接 `String(x).slice(0, 120)`、把 note 用的 detail 直接 `slice(0, 200)`，
  **整条路径没有打码**——远端 stdout 里出现的 board token / 家目录会原样进板与面板。
- 修法：`lib/worker/result.js` 新增两个纯函数 `maskReasons(list, {secrets, home, max, chars})` 与
  `maskDetailText(text, {secrets, home, max})`，一律**先 mask 再截断**（顺序反了就会把跨边界 token 切成残片，
  与 v2.7.6 修的 worker 侧 P1-1 同一类问题）。
- `lib/index.js`：`parseDshResult(text, maskOpts)` 增加打码入参；`syncRemote` 调用处传 `{ secrets: [cfg.token], home: os.homedir() }`；
  detail 改走 `maskDetailText(..., { max: 200 })`。
- 新增测试（`test/worker/result.test.mjs` 4 条）：跨 120 边界 token 不留残片且 ≤120、最多 5 条且过滤空串、家目录打码、
  `maskDetailText` 打码+拉平+200 截断且 token 跨 200 边界不漏。

**未改行为**
- board `_clean_result` 契约不变（reasons ≤5 条、每条 ≤120）；note 长度上限不变（400 字符）。
- 仅 Host 侧回板路径受影响；worker 侧 v2.7.6 的修复保持原样。

**验证**
- `npm run gate`：check-text / plugcheck(18 tools, 28 routes) / client-render-smoke / 单测 / pack-check 全绿（见提交记录）。
## v2.7.6 — 2026-11-22（全量审查修正：result.reasons 脱敏链闭合 + 子块键收口 + 脚本/测试/文档）

**安全（审查 P1-1，唯一未闭合项）**
- `lib/worker/result.js`：净化阶段不再把 reason 截到 120 字符（新增 `MAX_REASON_INPUT_CHARS = 4096` 只防内存放大）。
  原先的 `t.slice(0, 120)` 发生在 `maskResult` 之前，token 跨越第 120 字符时会被切成残片、掩码匹配不到 → 残片落板。
  现在完整 reason 进入 `maskResult`，由它「先打码、后截 120」，与 board 的 `_clean_result` 契约不变。
- 新增测试：`test/worker/result.test.mjs`（跨 120 边界 token 保持完整、4096 上限）、`test/worker/worker.test.mjs`（跨边界 token 落板前必须打码且 ≤120）。

**正确性（审查 P3-1）**
- `lib/worker/config.js`：`mergeWorkerPayload()` 对 `worker:` 子块同样按 `WORKER_FORWARD_KEYS` 过滤。
  否则子块里残留的 `workerMode`/`machine`/`token` 会跟着 spread 进载荷，`normalizeConfig` 的 pick() 子块优先会把宿主值顶掉。
- 新增测试：`test/worker/worker-payload-merge.test.mjs`（子块宿主键不得顶掉宿主值 + normalizeConfig 复核）。

**脚本**
- `scripts/enable-maint-write.ps1`：公钥除 base64 形态外，再解 DER-SPKI 校验 Ed25519 OID（1.3.101.112），错公钥在配置阶段就失败。
- `scripts/install-board.ps1`：token 前缀固定显示 6 字符（原先 `Min(8, Length)` 在短 token 时会整枚打印）。

**测试 / 工具**
- `test/worker/maint-ticket-cli.test.mjs`：badsig 用例原先「把 nonce 末位换成 X」——末位本来就是 X 时票据未变，签名仍有效，约 1/64 概率偶发失败（本次采集器实测撞到）。改成翻首位、保证一定变化。
- `scripts/audit-collect.mjs`：`--base` 用注解标签时要解到 commit（`<ref>^{commit}`），否则 `git rev-parse v2.7.5` 返回 tag 对象、diff 得到「0 个变更文件」（本轮实测撞到）。

**测试**
- `test/worker/agent-gate.test.mjs`：硬上限内改为断言「不触发 `too-long`」（原先是「detail 不等于某个串」的弱断言）。
- `test/worker/exec-runner.test.mjs`：`//server/share` 改为断言 `reason === 'missing'`（原先是 `!== 'not-absolute'`）。

**文档 / 证据链**
- `docs/review/findings.json`：version → 2.7.6，补 2.7.5 审计 8 条窄记（含仍未修的 P2-8 标 open）。
- `docs/audit-2.7.4/`：统一三份不一致的 HEAD 到 `dee4e03`（审查 P3-3）。
- `docs/ui-2.7.4/patch.diff`：标注为 stage2 原始补丁（审查 P3-4），最终实现指向 `main-control-fixes.md`。
- `docs/operator-playbook.md`：修掉 exec 表格断裂行（审查 P3-5）。

**怎么验证**
- `npm run gate` 全绿；`node scripts/audit-collect.mjs --version 2.7.6 --base v2.7.5 --coverage` 在真实 git 检出上产出完整证据链（审查 P1-2 的闭合方式）。

## v2.7.5 — 2026-11-22（安全收口 + 自检横幅可收缩 + 派工弹窗守卫）

### 修什么

- **note 脱敏阈值对齐**（盘古全盘扫描 P0-1）：`agent-runner` / `exec-runner` 的 `noteSecrets` 阈值从 `>= 4` 改 `>= 1`，与 `log.js` 一致——3 位及以下 token 以前会原样写进任务 note 上板。
- **先脱敏后截断**（P0-2）：`agent-runner` / `exec-runner` 改为 `oneLine(noteMask(text))`；旧顺序是截断后再打码，token 跨 400 字符边界就漏出残片。
- **restart 日志文件名安全化**（P0-3）：`maint-verbs` 的 `restart-<taskId>.log` 先用白名单字符集清洗并做 stateDir 包含校验，杜绝 `..` 穿越。
- **额度退款失败可见**（P1-1）：`budget.refund()` 返回 `ok:false` 时打 warn，不再静默吞掉。
- **spawn 失败清理临时目录**（P1-2）：`exec-runner` 失败分支调用 `cleanupTmp()`。
- **config-set 支持多行块序列**（P1-3）：`upsertBlock` 替换键时连同其子行整块替换，不再留下孤儿 `- id:` 行破坏 YAML；插入位置也跳到最后一个键的子行之后。

### 改了什么（体验）

- **自检报警横幅可收缩**（用户需求 / U1）：默认按上次偏好（localStorage `dsh-doctor-collapsed-v1`）收缩成单行摘要「N 项待处理（x 错误 / y 警告）」，点击或 Enter/Space 展开；`ok=false`（自检不可用）强制展开且不提供收起。
- **派工弹窗守卫**（GLM 可用性 S1/S2）：没有在线副机时「确认派工」禁用并给出原因；离线机器卡不可选中（点击提示「当前离线，不能派工」）。
- **行内中文诊断**（S4）：任务行 note 命中闸门时直接显示「诊断：<中文说明>」，原始 reason 放 `title` 悬停查看。

### 怎么验证

`npm run gate`：check-text PASSED、plugcheck 18/28、smoke **65/65**、单测 **469/469**、pack-check 108 文件。
负向门禁 `SMOKE_BUNDLE=<2.7.0 崩溃包>` 仍必须 FAIL（含 `#130`）。
真机：GT14 装 2.7.5 后 `maint version` 报 `plugin=2.7.5`，写通道 `维护写动词已接线`，派工 D4 落本机 worker（`remote_id` 空）。

## v2.7.4 — 2026-11-22（治本：团队顶层键不再丢 + 写通道可观测 + 装完自检）

真机事故（GT14）：`maintenanceWriteEnabled` / `maintAuthPublicKeys` 写在团队行顶层时，宿主只把
`config.worker` 子块转交给 worker，顶层键在传入前就被丢掉 ⇒ worker 恒用默认值（写通道 off）。
而「打开写通道」本身只能走写通道 ⇒ 死锁：主机远程开 agent 永远 `maint-write-disabled`。

修（不是绕）：
- **`lib/worker/config.js` 新增 `mergeWorkerPayload()`**：团队行顶层键**兜底**、`worker:` 子块**优先**，
  只转发 worker 真正会读的键（boardUrl/token/machine 等宿主键不混入）。宿主 apply 载荷改用
  `worker: mergeWorkerPayload(config)` ⇒ 「写在顶层」和「写在子块里」从此等价。
- **启动自检进日志**：apply 时用插件自己的 `normalizeConfig()` 算出 worker 实际生效值，
  写通道没开就 `trace()` 出明确一行（含实际加载的 `cordis.patch.yml` 路径），不再出现
  「配置文件写着 true、worker 里是 false」而没人发现。
- **doctor 新增 `maint-write-off` 警告**：面板自检直接报「写通道未开，远程升级会失败」并附 profile 路径。
- **`upgrade-worker.ps1` 装完自检**：重启后读 doctor 的 `maint-write-off`，弹窗直接说「写通道已开/未开」。
- **`enable-maint-write.ps1`**：多 profile 时先打印「检测到/将修改哪些 profile」；扁平布局（无 `worker:` 子块）
  也支持，且重跑幂等（修掉曾会写重复键的查重区间 bug）。
- 回归：`test/worker/worker-payload-merge.test.mjs` 5 条（顶层生效/子块优先/宿主键不混入/向后兼容）。
  门禁 465/465、pack-check 108 文件。

升级后仍需重启 DSH 才生效；副机升级一次后，写通道/agent 开关就都能远程处理，不必再逐台手改缩进。
## v2.7.3 — 2026-11-21（安装不再敢覆盖运行中的目录：原子切换 + 校验 + 安装清单）

### 修的是什么
GT14 装 2.7.2 后 DSH 起不来（用户描述「插件冲突」）。复盘结论：**不是插件代码问题，是安装过程能装出一棵混合树**。

- 旧安装方式：`robocopy /E` 把新包直接覆盖到 `node_modules/@wfcj/dsh-job-board`，而 DSH 往往正在运行；只要有一个文件没覆盖成功（占用 / 杀软 / 中断），就会留下「新 `lib/index.js` + 旧 `lib/dispatch-filter.js`」。
- 2.7.2 恰好新增了一条跨文件具名导入：`lib/index.js` 里 `import { canDispatchRemote, ... } from './dispatch-filter.js'`，而 2.7.1 的 `dispatch-filter.js` 没有这个导出 ⇒ ESM 在**链接阶段**就抛
  `SyntaxError: The requested module './dispatch-filter.js' does not provide an export named 'canDispatchRemote'`，表现就是 DSH 起不来。
- 复核方式：`npm pack` 两版对比，2.7.1 与 2.7.2 差 7 个文件（含两个服务端文件），2.7.1 自身只有 `client.js` / 版本号 / CHANGELOG / 冒烟脚本变化 —— 客户端文件与宿主启动无关，所以「2.7.1 代码把 DSH 弄坏」不成立。

### 改了什么
- **安装改为原子切换**（`scripts/deploy/install-agent-worker.ps1`）：解包到 TEMP → 校验（版本 / 文件数 / 关键文件存在 / `node --check`）→ 复制到同目录 `.stage-<时间戳>` → 写 `install-manifest.json`（每个文件的字节数与 sha256）→ 旧目录改名 `.bak-<时间戳>` → 暂存目录换名就位 → **装完复核**（版本、文件数、关键文件），任何一步失败自动回滚。
- **运行中检测**：DSH 在跑时默认拒绝覆盖安装并给出提示；`-StopDsh` 由脚本代停（装完需重启），`-AllowRunning` 是显式冒险开关。
- **升级脚本**（`scripts/deploy/upgrade-worker.ps1`）装包时带 `-StopDsh`，并在装完核对磁盘版本，不符即报错（此时安装脚本已回滚）。
- **运行时自检**（`lib/install-manifest.js` + `lib/index.js`）：启动时校验清单，发现「清单版本与 `package.json` 不一致 / 关键文件大小不符 / 关键文件缺失」就 `console.warn` 一条可操作告警（只告警不阻断），把「装了一半」从「DSH 莫名其妙起不来」变成日志里能看懂的一句话。
- 部署脚本入库：`scripts/deploy/` 收录 `install-agent-worker.ps1`、`upgrade-worker.ps1`、`rollback-gt14.ps1/.cmd`、`fix-gt14-after-boot.ps1/.cmd`（此前只在共享盘上，无版本历史）。

### 怎么验证
- `node --test test/worker/install-manifest.test.mjs`：8 条（清单归一、坏 JSON、无清单、版本不一致、关键文件大小不符、关键文件缺失、package.json 坏掉）。
- 手工：对同目录跑两次安装（第二次应识别「已安装同版本」）／故意改一个关键文件大小后再启动，日志应出现 `安装完整性告警`。
## v2.7.2 — 2026-11-21（派工「选具体模型」不再被远程桥打回 + 远程桥不再塞 model）

### 修的是什么
v2.7.1 恢复「派工选模型」后，选具体模型派到副机仍会失败，实测两种失败：

- `machine="GT14"` → Host 把它交给 remote-agent（远程桥）→ `failed：远程 failed：headless 后端不支持指定模型（dsh headless 固定使用副机默认模型）`
- `machine="gt14"` → 副机自己的 worker 认领 → `blocked：agent-not-allowlisted`（配置问题，见下）

远程桥的 headless 后端固定用副机默认模型，**任何显式 model 都会被它拒绝**；而「派到副机时选具体模型」正是本插件的卖点。以前的派工循环不做区分，谁来认领就派给谁，于是选了模型的任务有一半概率被推到必败的远程桥。

### 改了什么
- 新增 `lib/dispatch-filter.js` 的 `canDispatchRemote(task)`：带 model 的 agent 任务**不进远程桥**，留给副机自己的 in-process worker（worker 支持 model）；exec 忽略 model 照旧放行；maint 永不走远程桥。
- `lib/index.js` 派工循环在 `pickNode()` 之前用它挡一道，并按任务只记一次 trace（`dispatch skip …：带 model 的 agent 任务留给副机 worker`），不刷日志。
- 远程派工请求**不再携带 model**（连 Host 的 `cfg.defaultModel` 也不塞）——headless 只认副机默认模型，塞了必被拒。
- 新增 3 条单元测试（`test/worker/dispatch-filter.test.mjs`）：带 model/空白 model、AGENT 大小写、exec 与 maint 的边界。

### 升级后仍需在副机做的一步（配置，不是代码）
`agentAllowlist` 必须至少有一条能匹配的条目（远程桥与 worker 都认这个配置）。最小可用写法：

```yaml
worker:
  agentAllowlist:
    - id: any
      matchAll: true
```

写完要重启副机 DSH 才生效（配置在插件启动时归一化）。
## v2.7.1 — 2026-11-20（修派工弹窗白屏 React #130 + 恢复派工选模型 + 渲染兜底；服务端零改动）

### 修复：派工弹窗白屏（React #130，v2.1.0 起就带着的括号错位）

- **根因**：派工弹窗模型区的外层 return h( 后面直接跟了内层 h(，外层 h 的「节点类型」收到的是
  **一个 React 元素对象**（#130 ... args[]=object）；「类型」行被挤成 props、「模型」行的
  'div', {style} 掉成普通对象 child。该分支仅在副机上报模型清单（pool.length > 0）时进入，
  v2.1.0 之后长期休眠，机器开始上报模型后首次暴露 ⇒ 点「派工」整槽白屏。
- 修法：补回外层 h('div', null, …)，并给模型行补回缺失的 h( 与右括号。
- v2.6.29 同代码同缺陷（回退验证过）⇒ 2.7.0 不是回归来源，但 2.7.0 是首个必然触发的版本。

### 修复：模型选择静默消失 → 恒渲染 + 自动档按机器分组

- 以前「没有交集也没有团队默认」时整行 return null 消失，表现就是「派工直接派出去、没法选本地/云模型」。
  现在**恒渲染**：无数据给置灰占位「该机器未上报模型清单（跟随默认）」。
- 「自动」档先列在线副机**交集**（按 location 分 云端 · 按量计费 / 局域网 · 免费 / 本机 · 免费 / 其他），
  再追加**各机专属模型**并按机器分组（<机器名> · 专属），选某台机器的本地模型无需先切机器。
- 交集项显示名取上报里的 name（以前只剩 provider/model 原串）。

### 新增：面板渲染兜底 PanelSafe + window.__dsbCrash

- slots.register('main', …) 改注册 PanelSafe：面板渲染抛错时在槽内降级成占位
  （「调度台渲染出错（已降级，未整槽白屏）」+ 消息 + window.__dsbCrash 提示），
  不再把异常抛给宿主 slot 错误边界。用函数包装器而非 class 边界（冒烟假 React 不支持 class 组件）。

### 新增：asText() 文本归一（防 React #31）

- 接口/状态来的 error、workerErr、t.note、s.why、f.error、diffRes.error/note 等
  统一经 asText() 转字符串再进渲染树，服务端原样透传对象时不再炸 #31。

### 测试：冒烟升级为严格模式（29 项）

- 假 React.createElement 严格校验：type 只接受 string/function/symbol（否则抛 #130 等价错误）、
  child 不接受普通对象（否则抛 #31 等价错误）。
- 新增派工弹窗用例：注入 ask=true + summary.nodeModels（GT14/PC2 真实形态）+ defaultModel，
  断言不抛错、模型行存在、本地与云模型都能渲出、团队默认提示可见。
- 新增负向用例：把历史缺陷形态 h(h('div', null), 'x') 喂给同一假 React，必须报 #130。

### 说明

- 服务端零改动，/api/board/ui/* 协议不变；升级后请重启 DSH。
- npm 上的 2.7.0 已 deprecate（点派工会白屏），请用 2.7.1。
## v2.7.0 — 2026-11-20（安全默认收口 + 维护写通道可用 + 面板余量；本版有 4 条行为变更）

> 从 v2.6.x 升上来的机器请先读 README「v2.7.0 起的行为变更」。本版不改协议，但改默认值。

- **P-1 出厂不再自动派工**：`autoDispatch` 默认 `false`。Host 调度器只在显式 `autoDispatch: true` 时启动；面板派工、人工认领、维护通道不受影响。
- **P-2 worker agent 会话收紧为只读**：`WORKER_SESSION_DENY` 10 项（`worker_control` + `board_dispatch/claim/beat/done/fail/retry/attach/say` + `sh_write`）。agent 任务需要写文件时改走 exec 白名单。读类（`worker_status`、`board_status/list/options/caps/metrics`、`sh_read/sh_list`）保留。
- **P-3 审批指纹 64 → 128 bit 并绑定 model/provider**：`promptFingerprint(goal, model, provider)`；旧 16 位记录按「只绑 goal」的旧算法前缀兼容，命中后在 `check()` 里就地升级重写；换模型/provider 需要重新审批。
- **P-4 cwd 根必配**：`execCwdRoot` / `agentCwdRoot` 未配置时任务被拒（`cwd-root-unset` / `agent-cwd-unset`）；恢复旧行为需显式 `worker.allowUnscopedCwd: true`（会持续挂警告）。
- **维护写通道可用性（U-3/U-4/U-8）**：面板 maint 派工新增 `POST /api/board/ui/config-diff` 预览（不建单 / 不写盘 / 不消耗 nonce，读本机 profile）；机器卡新增 worker 状态卡与 drain/resume（`/api/board/ui/worker-status`、`worker-control`，`agentRestrictBroken` 时 403 `agent-restrict-broken`）；新增 `scripts/remove-old-package.ps1` 清理旧 unscoped 包残留。
- **面板余量（W4）**：≤1100px 机器卡改单列纵向堆叠、容器 100%（`!important` 压 React 内联尺寸）；≤900px 隐藏任务行序号列（`dsb-col-id`），不压字号、不做横向滚动兜底。
- **doctor 三条新检查**：`hub-nodes` 探测延到 webServer 就绪（`ctx.on('ready')` / `server.on('listening')`，`getOrigin` 不可用降级为 `info` 并 3s 重试一次）；`config-restart-pending`（patch mtime 晚于进程启动 ⇒ warn）；`gate-open-presets` / `gate-match-all`（两条放宽项 warn，只提示不改行为）。
- **C 批加固（S-9/S-11/S-14/S-5/C-17）**：见上三条 P 项与 S-11（`HARD_MAX_PROMPT_CHARS = 256 KiB`，归一化前拒）、S-14（tar 逐段拦中段盘符与 UNC 变体）、C-17（`formatNumber()` 统一数字格式，`'020'` / `1e999` 直接 invalid）。
- **审计收口**：`docs/review/findings.json` 的 `open` 清零（fixed / mitigated / documented 三类，mitigated 与 documented 各附复验命令）。
- **测试与打包**：门禁 **448** 测试全绿、pack-check **105 文件**；`prep-upgrade-270.ps1/.cmd` 已生成（`$Expect='2.7.0'`，cmd 为 CRLF/ASCII）。
- **发版前复审修正（盘古 P0/P1/P2）**：
  - P0：补 `scripts/enable-maint-write.ps1` + `.cmd`。README 与面板错误提示引用的信任锚脚本此前不存在，外部用户无法开启维护写通道；脚本自动找 profile、只补缺失/不匹配的 `worker:` 子键（`maintenanceWriteEnabled` / `maintenanceOutDir` / `maintenancePkgDir` / `maintAuthPublicKeys` / 可选 `maintenanceAllowRestart`），写前备份、写后复核、失败回滚、幂等；DSH 在跑时默认拒绝写。
  - P1：`config-diff` 预览在多机场景读的是 Host 的 `cordis.patch.yml`，实际写的是目标副机；现按目标机器判定，远程目标返回 `remote:true` + `note`，面板展示说明而不是可能误导的 diff。
  - P2：`docs/operator-playbook.md` 基线升到 v2.7.0，新增「3.4 维护写通道」（keygen → 副机 enable-maint-write → 签票 → 派工 + 已知边界）；README 与面板提示改指真实脚本路径。
  - P1（二次复审）：`scripts/enable-maint-write.ps1` 遇到内联空 map（`worker: {}`）会把子键插到该行之后、写后复核又误判通过，标准 YAML 解析失败会让 DSH 起不来；现改为先把 `worker: {}` 展开成 `worker:` 空块再插键，写后复核加「worker 行仍是 `{}` 就判失败并回滚」；新增 `test/worker/enable-maint-write-script.test.mjs`（3 条，真跑 pwsh：内联空 map 展开、既有子块补键且幂等、缺 worker 块干净失败；无 pwsh 环境自动 skip），已进 pack-check required。
  - 门禁：**448** 测试全绿、pack-check **105 文件**。
## v2.6.29 — 2026-11-20（A2 批 17 条：UI 写路由闸、有界映射、可中断退避、URL 规范化）

- **A2a（9 条·用户/配置面）**：`U-1` 包内 `cordis.patch.yml` 的 `worker:` 子块补 `maintenanceEnabled` / `maintenanceOutDir`（与 README 对齐，照模板写不再丢键）；`U-2` `detectMachine` 补 `DESKTOP2` 前缀并把未知主机名统一小写返回（**这是副机永远 idle 的根因之一**：板子按小写归一，大写主机名对不上）；`U-5` 找 team 块的正则容忍可选引号与行尾注释（`- id: 'team'` / `- id: team # 注释` 不再报「未找到」）；`U-6` 签发票据时校验 `verb ∈ upgrade/config-set/restart`（错 verb 不再等副机才 `maint-verb-unknown`）；`U-7` keygen 私钥写盘 `mode 0o600` + chmod 兜底；`U-9` `sign --payload` 读文件/JSON 解析失败给友好提示并 `return 2`（不抛栈迹）；`U-10` `maskText` 打码阈值 6 → 1（4 位测试 token 不再原样泄露）；`S-15` `UI_WRITE_PATHS` 从 3 条补到 16 条（写型路由的 GET 被 uiGuard 以 `method` 提前 403，`ui-guard-smoke` 同步改 `403 || 405`）；`S-17` instanceId 随机后缀 `randomBytes(2) → (4)`。
- **A2b（8 条·正确性边界）**：`C-3` `agentAllowlist` 的校验与归一化统一口径（缺 id 允许，归一化补 `allow-<序号>`）；`C-5` `agentToSession` 改有界 Map（256 条，LRU 淘汰，长跑不再泄漏）；`C-11` `dryRun` 严格判 boolean（`0`/`'false'` 返回 `maint-config-invalid`，不再静默当 dry-run；缺省仍 fail-safe 不写盘）；`C-14` `resolveCwd` 越界判定改按路径段（`..foo` 目录不再被误拒）；`C-15` 无根告警标志从模块级 `let` 移进实例闭包（多实例各告警一次）；`C-16` `markWithRetry` 退避改可中断 sleep（每 100ms 查 stopped），`stop()` 先 abort 再 flush 待回写（3 秒兜底）；`C-20` `joinUrl` 改用 `new URL` 规范化（支持 baseUrl 带路径前缀/尾斜杠/查询串）；`C-21` `mark` 的 `result` 裁剪为 `ok/expected/actual/reasons` + 4 KiB 上限并标 `truncated`。
- **复核补丁（主控）**：`joinUrl` 空 `baseUrl` 保持旧行为（返回以 `/` 开头的 path，不抛 `Invalid URL`——未配 boardUrl 时由调用方给「未配置」错误）；新测试文件 CRLF 归一化为 LF。
- **测试**：新增 `test/worker/ui-write-paths.test.mjs`(2)；11 个既有测试文件补 34 条用例；`npm test` **424/424**。
- 本批同样由 IDE agent（码道 CodeArts Agent / OpenPangu-2.1-Pro）在一次性副本实现、主控逐条复核合并（两批共 17 条，含 2 处参数/换行修正）。
- 门禁：check-text PASSED（122 文件）、plugcheck `tools=18 routes=25`、client-render-smoke 18/18、pack-check 99 文件 1,458,126 B。
- 版本同步 2.6.29。
## v2.6.28 — 2026-11-20（A1 批 18 条：盘古审计 P2/P3 高值项落地）

- **命令与网络面（10 条）**：`S-1` 提示词闸门的 base64 检测改用归一化文本（零宽分隔不再漏检）；`S-2` `normalizePrompt` 补行首 `.\` 折叠（`.\dsh\profiles` 不再绕过 dsh-home 规则）；`S-4` `sh_list` 改 `lstatSync`（不跟随符号链接读白名单外文件）；`S-6` 拒绝消息不再拼根目录全路径（只报条数）；`S-7` 内联脚本 64 KiB 上限（`inline-too-large`）；`S-8` agent host 错误先脱敏再进 reason；`S-10` `maskText` 先替 secret 再替家目录（secret 含家目录子串时不再漏）；`S-13` restart 的 `dshExePath` 走 PowerShell 单引号加倍转义（**复核后改成转义而非黑名单**——黑名单会误伤中文用户名路径）；`S-16` `readTextCapped` 的无 `getReader` 回退也走流式限长；`S-18` 板子对 `mode=maint` 的 goal 不做 `_txt` 脱敏（写 payload 含 token 类子串时 hash 不再被改坏）。
- **正确性（8 条）**：`C-1` 绝对路径判定统一到 `config.isAbsolutePath`；`C-2` claim 遇到非 409/400/404 时累加失败并返回 `backoffMs`；`C-8` 文件锁 stale 判定加 pid 探活（`EPERM` 按存活处理），进程挂起不再被误抢；`C-9` 锁失败返回值加 `kind` 区分 `lock-error`/`fn-error`/`lock-timeout`；`C-10` 子进程已退出时 timer 回调直接返回（不再记超时）；`C-12` **复核后保留** `maintAuthKeyFile`——它是 `ensureMaintKeyPair()` 的读取点，不是死键，并加测试钉住；`C-13` `passEnv` 补归一化并接进 `buildChildEnv`；`C-18` 审批前校验任务 `mode=agent` 且仍在 `queued`。
- **测试**：新增 `test/worker/shell.test.mjs`(61) 与 `test/worker/state-file.test.mjs`(73)，另有 10 个既有测试文件补用例；`npm test` **390/390**。
- 本批由 IDE agent（码道 CodeArts Agent / OpenPangu-2.1-Pro）在一次性副本实现、主控逐条复核合并：改了 2 处判断（C-12 保留、S-13 改转义）、补了 3 条断言。
- 门禁：check-text PASSED（121 文件）、plugcheck `tools=18 routes=25`、client-render-smoke 18/18、pack-check 98 文件 1,447,956 B。
- 版本同步 2.6.28。
## v2.6.27 — 2026-11-20（盘古全量审计修复批：3 个 P0 + 安全/正确性 P1）

- **P0 面板维护通道可达**：派工弹窗新增「类型」选择（agent / exec / maint）与票据输入框，
  `/api/board/ui/create` 接受并透传 `maint_ticket`（以前面板用户永远打不出写动词，
  `window.__dsbTaskMode` 只有读取点没有写入点）。
- **P0 额度退还 fail-closed**：`agent-budget.refund()` 抢锁失败不再无锁回写（会把 used 写回旧值）。
- **P0 upgrade 回滚**：回滚条件原本恒假（pkgDir 刚 mkdir 过），安装失败会留下半装目录；
  现在有备份就整目录还原，没备份就清掉半装目录。
- **安全 P1 一批**：exec/agent 的 note 上板前统一走 `maskText`（stderr 尾部 / 回答原文 /
  hostError 以前原样进看板）；`sh_run` 与 exec 的环境变量过滤补 `access_key`/`*_KEY`；
  `recordNonce` 加跨进程锁且读写失败不再当「没用过」（fail-closed 按重放拒）；
  私钥文件权限不改历史 0600 就修回来；solo 板出站文本全量 redact；
  `execCwdRoot`/`agentCwdRoot` 未配时默认拒（`allowUnscopedCwd: true` 显式恢复旧行为）。
- **正确性 P1/P2**：beat 409 holder 冲突立即中止（原来要等 90s 双执行窗口）；`resume()`
  能真的重启主循环；Node 24 下超时不再被误判成"请求失败"；`bool(NaN)` 不再返 true；
  tar 目录条目也计入条目上限；restart 动词补上 `spawnImpl`（此前恒 `maint-spawn-failed`）。
- 文档与提示：README 去掉本机开发路径、写动词与票据流程说明；失败提示补 8 类闸门 reason；
  playbook 基线更新到 2.6.27。测试 368 条全绿（新增 refund fail-closed、note 脱敏、
  cwd fail-closed、面板 maint 入口 4 条渲染断言）。

版本同步 2.6.27
## v2.6.26 — 2026-11-19（写通道真正可用：归一化层补键 + 公钥路由）

- **修 v2.6.20 的真 bug**：\
ormalizeConfig()\ 从未读取 \maintenanceWriteEnabled\ / \maintenanceAllowRestart\ / \maintenancePkgDir\ / \maintAuthPublicKeys\ / \dshExePath\ / \maintAuthKeyFile\，于是 \
unWrite()\ 里 \config.maintenanceWriteEnabled !== true\ 永远成立 —— 写动词在任何配置下都返回 \maint-write-disabled\。单测直接构造 config 对象，所以一直没暴露；真机票据派工才把它打出来。现补 \strList()\ 与六个键（公钥支持数组/扁平字符串，脏值丢弃），并加 3 条回归测试。
- **新增只读路由 \GET /api/board/ui/maint-key\**：返回本机签名公钥 + 指纹 + 密钥文件路径；密钥文件缺省 \~/.dsh/maint/maint-key.json\，可用 \worker.maintAuthKeyFile\ 或 \DSH_MAINT_KEY_FILE\ 覆盖；首次访问惰性生成（ed25519，私钥 0600 落本机，公钥公开无害）。为「装包时一次性信任指纹」铺路（副机不再需要单独跑脚本）。
- 测试 362 → 365（+3 配置回归）。

版本同步 2.6.26
## v2.6.25 — 2026-11-19（agent 回答落到看板 note）

- **改**：agent 任务成功时，note 在 `text=Nch` 之外再带 `answer="…"`（单行化、截 160 字、
  走既有的 note 脱敏），看板上直接能读到回答，不用再去翻会话缓存。
- 2.6.24 起 GT14 真机复测：`done`、`text=1ch`（2+3 → 5）、`dur≈3.4s`、`budget 9/20`。
- 版本同步 2.6.25。
## v2.6.24 — 2026-11-19（agent 取文本：补 data.message.content 真实形状）

- **修**：2.6.23 的诊断把真实形状打出来了 —— `assistant/message` 的文本块在
  `data.message.content`，而 `textFromEvent()` 只看了 `data.blocks` / `message.content`。
  现在按候选列表逐层找：`blocks` → `message.content` → `content` → `data.blocks` →
  `data.content` → `data.message.content` → `data.message.blocks`，取第一个非空 text 块。
- **测试**：`textFromEvent` 导出以便单测；新增 3 条（真实形状取到 5、只有 reasoning 块返回空、
  老形状 blocks 仍兼容）。
- 版本同步 2.6.24。
## v2.6.23 — 2026-11-19（agent 取文本兜底 + 更细诊断）

- **修**：`assistant/message` 之外还有 `assistant/chunk`/`assistant/attempt` 等事件，文本块可能挂在
  `data.message.content` / `data.blocks` / `content` 上。`finalText()` 现在先按 `assistant/message` 找，
  找不到就**倒序扫所有非 user 事件**捞 text 块（避免把投进去的任务书当成回答）。
- **诊断**：空文本时写两行日志 —— 事件类型分布（最多 6 类）+ 最后一条 assistant 事件的
  `blockTypes`/`keys`，一眼能看出「是不是只有 reasoning 块 / 是不是 tool-call」。
- 版本同步 2.6.23。
## v2.6.22 — 2026-11-19（agent 排障：错误事件归位 + 空文本诊断）

- **修**：`agent/error` 事件可能只带 `agent.id`（与 `sessionId` 不同）。旧逻辑只认 `worker-` 前缀的 id，
  这类错误会被整条丢弃 —— 症状正是「任务 done、`text=0ch`、查不到原因」。现在 `start()` 会把
  `agent.id` / `session.id` 登记成到 `sessionId` 的映射，错误按映射回填。
- **诊断**：`finalText()` 取不到文本时写一条 `agent 无文本：session=yes/no events=N [类型×次数]` 到插件日志
  （维护通道 `logs` 可见），不再只能靠猜。
- **诊断**：被丢弃的 `agent/error` 也记一条 warn（60 秒节流），能看出是不是「别的会话在报错」。
- 单测：新增「错误事件只带 agent.id 也要归到本会话」用例。359 全绿。
- 版本同步 2.6.22。
## v2.6.21 — 2026-11-19（agent 派工真机打通：followup 必须是完整 UserMessage）

- **修**：`agentLoop` 的 `followup()` 收的是 DSH 的 UserMessage 实例（`{ id, role:'user', content, source }`，
  等价 `createUserMessage()` = `deepFreeze(structuredClone({...input, id, role}))`）。此前我们只传
  `{ content, source }`：inbox 收下了消息、但不进 driver —— 真机症状是**会话 2.5 秒就结束、没有任何模型请求、
  `text=0ch`、也不报错**（GT14 `bd-d-61924adc`/`bd-e-3be6293a` 两次复现，`budget` 各涨 1、`dur≈2.6s`）。
- **补**：`agent-runner.test.mjs` 把「投递必须是完整 UserMessage（role/id/content/source）」钉成断言，
  以后谁把消息体改回裸对象，单测先红。
- **排障沉淀**：正常一次 agent 调用应当是「秒级建会话 + 数秒到数十秒模型往返 + 有 text」；
  **2~3 秒完成且 text 为空 = 消息根本没进队列**，不要再往 provider/网络方向查。
- 版本同步 2.6.21。
# 变更日志
## v2.6.20 — 2026-11-19（维护写通道 A2：三个写动词 + 板子独立票据字段）

- **写动词落地**：`lib/worker/maint-verbs.js` 实现 `upgrade` / `config-set` / `restart` 三个动词的「检查 + 执行」层；`maintenance.js` 的 `runWrite` 负责闸门顺序（写开关 → 实现接线 → 票据九步校验 → **先落 nonce 再执行** → 摘要回板），票据/sig/nonce 不进 note、result 或落盘 payload。
- **票据走板子独立字段**：板子 `goal` 有 300 字上限，而一张 base64url 票据 430~450 字，塞进 goal 必然被截断成坏票。`tools/board_server.py` 新增 `maint_ticket` 字段（只允许 `mode=maint`、base64url 16~900 字符，**刻意不走 `_txt()` 脱敏**，否则长 base64 会被换成 `<redacted>` 把签名废掉）；插件 `board_dispatch` 新增 `ticket` 参数，副机 `task-spec` 把 `maint_ticket` 拼回「payload + 末行 ticket=」，三处同一套拼法。
- **升级包解包自带实现**：Node 没有内置 `node:tar`，契约又禁止依赖与 spawn，因此新增 `lib/worker/tar.js`（ustar 子集）。安全边界：拒绝绝对路径 / `..` / NUL、只收普通文件与目录（符号链接、硬链接、设备节点直接失败）、校验和、条目数与总字节上限；配 6 条回归测试（伪造符号链接与损坏头都要被拒）。
- **集成修正**：`createMaintVerbs` 的 `profileDir` / `pkgDir` 同时接受显式参数与配置字段（只认 opts 会让调用方按契约从 config 取时退化成相对路径 —— 实测会把仓库自己的 `cordis.patch.yml` 改掉）；`upgrade` 在 `maintenancePkgDir` 不存在时明确报 `maint-pkg-missing`，不再拖到读包文件才 ENOENT。
- **重派保护**：`board_retry` 遇到维护写动词（upgrade/config-set/restart）直接挡下并指向「重新签发票据」，不再等副机报 `maint-ticket-invalid`；只读动词不受影响。
- **测试**：新增 `test/worker/maint-verbs.test.mjs`（38 条，含「CLI 签发 → runner 消费 → 真写 config-set」端到端）、`test/worker/tar.test.mjs`（6 条）、`test/worker/task-spec.test.mjs` 增 4 条（票据拼回、尾空白还原、缺票据报错、只读回归）。全套 **358 条全绿**，pack-check 95 文件 / 1,423,583 B。

版本同步 2.6.20
## v2.6.19 — 2026-11-18（盘古审计四条：预算计数跨进程丢失、票据 nonce/版本校验、响应上限补两处、tmp 名带 pid）

- **修 P1：agent 每日预算的计数会丢**。`lib/worker/agent-budget.js` 的 `consume()` 是 read → 判 → write 三步，没有跨进程互斥；同机多实例（主控 + 副机 worker 同 stateDir、或两个 worker 进程）并发时会同时读到 `used=18`、各写 `19`，实际应到 `20` —— 连投任务能在额度打满后继续超发。现在整段用 `state-file.mjs` 的 `withFileLock` 包住，**抢不到锁 fail-closed**（本次不放行、不写盘，`error` 说明 busy/stale-lock-*）；`refund()` 同样包锁，失败退回无锁 apply 并 warn。注入 `fsImpl` 的测试路径不加锁。
- **修 P1：`checkTicket` 不校验 nonce 长度**。`MIN_NONCE_LEN=16` 早先只定义没使用，1 个字符的 nonce 也能签也能过 —— 重放窗口被人为放大。现在步骤 7 校验 `< MIN_NONCE_LEN` → `maint-ticket-invalid`。
- **修 P2：`checkTicket` 成功时把整张票据（含 `sig`）回给调用方**。A2 接力时很容易顺手写进 note/result/日志，等于把凭据留痕；现在只回 `{ ok, status, reason, nonce }`。
- **修 P2：`lib/index.js` 的 remote-agent 响应无上限**。`remoteUi()` 里 `res.json()` 未设限，本机 remote-agent 回超大正文同样能 OOM；改走与看板同一套 `readTextCapped()`（非 JSON 仍按 null，超限报「响应过大」）。
- **修 P2：能力探测的 stderr 无上限**。`runWorkloadProbe` 只给 stdout 加了 4 MiB、stderr 没有；现在两边都有上限并 kill。
- **修 P3：票据版本没校验**。签名正确但 `v` 不是当前版本的票据（未来 v2 / 旧票据）现在在验签之后显式拒绝（`maint-ticket-invalid`）；篡改 `v` 仍是 `maint-ticket-badsig`，语义不变。
- **修 P3：两个 tmp 文件名不带 pid**。`agent-approval.js` 与 `solo-board.mjs` 的 `*.tmp` 在并发写同一 stateDir 时会互相覆盖，改成 `<file>.<pid>.tmp`。
- **测试**：新增 `test/worker/agent-budget.test.mjs` 7 条（进程内计数、双实例共享 stateDir、refund 不负数、UTC 跨日、**锁被占时 fail-closed 且不写盘**、默认常量）；`maint-ticket.test.mjs` 33 → 35 条（短 nonce、签名正确但 v 不符、ok 结果不含 sig）。
- 门禁：`check-text` / `plugcheck` / `client-render-smoke` / `npm test`（**280 条**）/ `pack-check` 全绿。
- 版本同步 2.6.19。## v2.6.18 — 2026-11-18（家目录脱敏补正斜杠/file URL + 数字与 key 名边角 + 手册纠错）

- **修 P1：家目录只匹配反斜杠形态**。`maskText` 以前只替换 `C:\Users\X`；`C:/Users/X`（Node ESM 栈、部分工具输出就是这种）与 `file:///C:/Users/X` 都会原样漏出去，而 `exec-runner` 会把子进程 `stderrTail` 拼进 note、`worker.js` 用 `home: os.homedir()` 打码 —— 有生产路径。现在三种形态都替换，并加边界守卫（home 是 `C:\Users\Al` 时不吃掉 `C:\Users\Alice`）。
- **修 P2：key 名里的秘密漏打码**。JSON 序列化会把反斜杠/引号转义，外层 `maskText` 看到的是转义后的文本，原始串匹配不上；现在 `maskText` 同时替换 secret 的 JSON 转义形态，测试补了带 `\` 与 `"` 的 key。
- **修 P2：数字形态的秘密会把 JSON 打坏**。数字 `123456789` 作值再按全文替换会得到 `{"pin":***}`（非法 JSON）；改为在 replacer 里就地打码成字符串。
- **修 P2：日志兜底可能二次抛错**。序列化失败且对象自定义 `toString` 也抛错时，`log.info` 会抛；现在落 `[unserializable extra]`。
- **替换顺序**：secret 从长到短替换，重叠 secret 不再留 `***789` 后缀残渣；纯空白 secret 直接忽略。
- **手册纠错（`docs/operator-playbook.md`）**：exec 原因表补 `empty`、注明 `not-allowlisted` 在运行期 note 里显示为 `approval-required`；403 的 `why` 补全 `host/origin/header/content-type/method` 五种；`worker_control` 没有 `requeue`（打回用 `board_retry` 或看板 UI）；maint `config` 是白名单重建、token 键根本不出现；白名单是目录边界匹配而非朴素前缀；claim 阶段 note 只有 preamble；基线版本同步到 2.6.18。
- **测试**：`test/worker/log.test.mjs` 16 → 26 条（正斜杠/file URL/前缀边界/secret 长度边界/重叠/空白/转义 key/数字/toString 兜底）。版本同步 2.6.18。
## v2.6.17 — 2026-11-18（看板 token 不跟 302 走 + 响应正文上限 + 票据模块）

- **修 P1：token 会跟着 302 跑到别的域**。两处看板 fetch（`lib/index.js` 的 `call()` 与 `lib/worker/transport/http.js` 的 `request()`）都没传 `redirect`，Node/undici 只剥 `Authorization`/`Cookie`，自定义的 `x-board-token` 会原样跟到重定向目标 —— 被劫持/被替换的看板回一个 302 就能拿到看板全权凭据（独立审计用两个 loopback server 实测复现）。现在两处都显式 `redirect: 'error'`。
- **修 P1：响应正文无上限**。`res.text()` 以前不设限，恶意看板回 200 + 80 MiB 正文就能把副机内存打满。新增 `readTextCapped()`（按流读、不信 `content-length`、超限即取消并报「响应过大」），上限 8 MiB（正常快照几百 KB）。
- **新增 `lib/worker/maint-ticket.js`（A1，尚未接线）**：一次性写授权的票据校验模块 —— ed25519 签名覆盖 8 个字段、9 步校验序（配置关 → 票据形态 → 公钥 → 签名 → 机器 → 时间窗 → 重放 → payload 哈希），已用 nonce 集合落盘（FIFO 上限 1000），reason 常量与任务书约定一致。`test/worker/maint-ticket.test.mjs` 33 条（签名/篡改/过期/重放/payload/顺序/FIFO）。动词接线（A2）下个版本做，本版只入库。
- **`test/worker/transport.test.mjs` 补 3 条回归**：`redirect:'error'` 生效、声明超限、流式超限。
- 门禁：`check-text` / `plugcheck` / `client-render-smoke` / `npm test`（261 条）/ `pack-check` 全绿。
- 版本同步 2.6.17。

## v2.6.16 — 2026-11-18（日志脱敏漏掉 extra 里的路径 + 运维手册）

- **修一个真泄露：`extra` 里的路径从来没被打过码**。`createLogger` 以前是「先 `JSON.stringify(extra)` 再 `maskText`」，而 JSON 会把 Windows 路径的反斜杠转义成 `\\` —— 家目录 `C:\Users\<你>` 在序列化文本里变成 `C:\\Users\\<你>`，跟待替换的模式对不上，于是 **extra 字段里的用户名路径原样进日志、进而进共享看板**（note/日志是同一条通道）。现在改成「序列化时用 replacer 对每个字符串先打码、序列化后再兜一层」（key 名里出现秘密也挡）；Date / Buffer / toJSON 的语义不变（replacer 只动字符串），循环引用与 BigInt 不再让 logger 抛错（catch 兜底成 `String(extra)` 再打码）。
- **`lib/worker/log.js` 从零测试到 16 条**（新增 `test/worker/log.test.mjs`）：secret 打码与短 secret 不误伤、家目录大小写不敏感、正则元字符转义、环形缓冲上限、level 过滤、`child()` 前缀共用缓冲、`tail()` 时间来自注入的 `now()`、sink 抛错不影响主循环、**extra 路径打码（本次修复的回归用例）**、Date 仍序列化成 ISO。脱敏写错的后果是「看板上出现别人的路径」，以前这个模块一条测试都没有。
- **新增 `docs/operator-playbook.md`（运维手册）**：三角色最小配置、`file:` 依赖「改了仓库不生效」的部署真相与 doctor 自检、exec/agent/maint 三张错误码表（reason 直接照代码抄）、五类常见故障、安全边界（`sh_run` 不是沙箱 / `agent` 不是沙箱 / 白名单别写成盘根 / token 只在 header）、回滚四步、发版自检。同时把它加进 `package.json` 的 `files`。
- 门禁：`check-text` / `plugcheck` / `client-render-smoke` / `npm test`（225 条）/ `pack-check` 全绿。
- 版本同步 2.6.16。

## v2.6.15 — 2026-11-18（14 寸屏头部收容：三组各占一行、窄屏让位）

- **头部从「一串 flex 子元素平铺」改成三组语义容器**：`dsb-brand`（标题 + 版本 pill + 副标题）、`dsb-meta`（待办/进行/完成/打回 四个计数 pill）、`dsb-acts`（更新 pill + 9 个操作按钮，`margin-left:auto` 靠右）。DOM 顺序不变、按钮一个不少（smoke 里数着 9 个），只是把「该整体换行的东西」包成组，窄栏时按组折行，而不是每个按钮各自乱折。
- **两档窄屏收容**（纯 CSS，没有媒体查询之外的运行时逻辑）：
  - `≤1240px`：头部 padding 与按钮/pill 内边距收紧，行间距压到 6px——14 寸屏（125–150% 缩放下 CSS 宽度约 850–1150px）常见的第一档；
  - `≤980px`：副标题「dsh-job-board · N 台副机在线」让位隐藏（信息不丢：`title` 里仍在），操作组整行右对齐到第二行，品牌行独占第一行并可被压缩省略。
- **`dsb-sub` 用 ellipsis 收尾**：副标题在中等宽度下先省略、不挤版本 pill；版本 pill 用 `tabular-nums` + `nowrap` 保持稳定宽度，避免刷新时抖动。
- **smoke 覆盖收容前提**（`scripts/client-render-smoke.mjs` 10 → 14 项）：断言标题与版本 pill 同处 `dsb-brand`、四个计数 pill 同处 `dsb-meta`、9 个按钮都在 header 内的 `dsb-acts`、两条媒体查询与 `dsb-sub` 让位规则存在——以后谁把这层结构拆了会当场卡 gate。
- 版本同步 2.6.15。

## v2.6.14 — 2026-11-18（agent 派工的路障：补 inject agentLoop/sessions）

- **组合包补丁的 inject 补齐 agent 侧服务**：`cordis.patch.yml` 的插入行从 `['webServer', 'tools']` 改成 `['webServer', 'tools', 'agentLoop', 'sessions']`。`workerMode: 'on'` 且 `agentEnabled: true` 时 `lib/worker/index.js:117-127` 会建 `createDshAgentHost()`，而它要读 `ctx.agentLoop` / `ctx.sessions`（`lib/worker/agent-runner.js` 的 `readService`）；cordis 的规则是「行上没有声明 inject 就不能访问该服务（`cannot get property … without inject`）」，readService 的 try/catch 会把它变成 `null` ⇒ v2.6.13 及以前**副机即使把 `agentEnabled` / `agentPreset` / `agentCwdRoot` / `agentAllowlist` 全配齐，任务仍以 `reason=agent-unavailable` 被拦**（note：「agentLoop.createAgent 不可用 …」），看起来像配置写错，实际是补丁少声明两个服务。多声明的两个只在 agent 分支被访问，host 角色（不跑 worker）下无害，且本行会等这些服务就绪再激活（agentLoop / sessions 都是 DSH 核心服务）。agent 的 ctx 还继承本行的依赖声明，所以 `tools` 也必须留着。
- **新增 `test/worker/patch.test.mjs`**：断言插入行 inject 至少含 `webServer/tools/agentLoop/sessions`、`id: team` 与包名正确、默认仍是「只看板不执行」（`workerMode: 'off'` / `agentEnabled: false` / `approvalMode: manual`）——以后谁把 inject 收窄会当场卡 gate。
- 版本同步 2.6.14。

## v2.6.13 — 2026-11-18（面板常显版本号 + 三处小瑕疵）

- **面板标题旁常显版本 pill（handoff 待办 1，「UI 显示插件版本号」）**：`插件 v2.6.13`。以前版本号只在「自检横幅」里出现，而横幅的渲染条件是 `doctorIssues.length || doctor.ok === false`，`doctorIssues` 只收 `warn`/`error`（`info` 不算）⇒ doctor 全绿时**用户在任何界面都看不到自己在跑哪个版本**（这件事被问过 4 次）。现在：
  - 标题「多机调度台」右边常显版本 pill，doctor 已返回用 `doctor.version`，未返回/doctor 挂了用 `CLIENT_VERSION` 兜底；
  - 磁盘版本 ≠ 运行版本 ⇒ 追加黄色 `→ 磁盘 vX`（提示重启 DSH 后生效）；有新版 ⇒ 追加蓝色 `↑ vX`；
  - hover 汇总 `version / installedVersion / latestVersion / role`，点一下立刻重拉 doctor（不必等 30 秒轮询，也不用按「刷新」把整块面板重刷）。
- **版本号单一来源**：新增 `lib/worker/version.js`（`export const VERSION`），`lib/worker/index.js` 原样 re-export（对外 API 与 `worker_status` 输出不变）；`lib/worker/transport/http.js` 的默认 UA 改成 `dsh-job-board/${VERSION}`，不再写死 `'dsh-job-board/2.6.12'`（此前发版漏改会让远端看到的 UA 停在旧版本）。
- **空快照不再算成功**：`createHttpTransport().snapshot()` 在 204/空正文时拿到 `data = null`，而 `request()` 的 `ok` 只看 `data.ok === false` ⇒ 主循环会把「没有任何任务」当正常、无休止空转。现在正文不是 JSON 对象即 `ok:false`（error 为「看板快照为空（响应正文不是 JSON 对象）」），主循环照常走 backoff；`tasks` 仍允许数组或 map（`taskList` 两种都吃，不动既有契约）。
- **去掉 `timer.unref()`**：独立进程里只有这一条请求在飞时，unref 的超时兜底不参与保活，可能在响应落地前被事件循环丢掉；timer 仍在 `finally` 里 clear，不会泄漏。
- **门禁**：`scripts/plugcheck.mjs` 新增「三处版本号一致」断言（`package.json` / `lib/worker/version.js` / `lib/client.js` 的 `CLIENT_VERSION`），发版漏改会卡 gate；`test/worker/transport.test.mjs` 新增「204 空正文判失败」与「默认 UA 带版本」两例。
- 版本同步 2.6.13（worker VERSION / UA / 面板 CLIENT_VERSION）。

## v2.6.12 — 2026-11-17（含发布前独立安全审计的加固）

维护通道（handoff A 项的根因修复）+ 通信层抽出 + 一个真 bug。

**发布前安全审计（独立子 agent，只读复核，跑了两轮）：无 P0（无远程命令执行面、无 maint→exec 分流、无 token 直出）；第一轮 P1×2 + P2×5 + P3×8，第二轮只核 `git diff` 复核 P1 已关闭，另指出 3 处收尾，全部已修。**

- **审计加固 1（P1，路径穿越）**：`writePayload` 原来用 `path.join(outDir, machine)`，而 `safeName` 保留了 `.` ⇒ `machine: '..'` 能把 payload 写出 `maintenanceOutDir`（实测落到父目录）。现在 `safeName` 剥掉首尾 `[._]`、拒绝 `CON/PRN/NUL/COM1…` 保留名，并加第二道闸 `path.resolve(file).startsWith(rootPrefix)`；审计实测 15 类恶意输入（`..`/`....`/`../..`/`..\..\hack`/保留名/`C:`/任务号与动词穿越/带尾随空格）全部落在 root 内。回归测试覆盖其中「`..`、保留名、尾随点、任务号穿越、动词穿越」5 类；junction/symlink 不在覆盖内（预置软链可绕字符串判定，需本机写权限，见 `docs/issue-10/08-exec-policy.md` §43.12 残余边界）。
- **审计加固 2（P1，凭证泄漏）**：`config` 把 `boardUrl` 原样送上板子，而板子的 `redact()` 名单只有 `x-board-token|nodetoken|node_token|access_token|api_key`（`tools/board_server.py:99`）—— **裸 `?token=` 与 userinfo 都不在内** ⇒ `http://u:p@host`、`?token=xxx` 会进 board state 与面板 UI。新增 `sanitizeUrl()`：清 userinfo、按 `/(?:^|[_-])(?:token|key|secret|password|passwd|pwd|sig|signature|auth|…)(?:$|[_-])/` 打码 query 与 fragment 的值（不锚 `^…$`，所以 `x-board-token`、`X-Amz-Signature` 这类复合键名也命中）；解析不出 URL 或 `u:p@host` 被当成 scheme 时，按字面打码 `//user:pass@` 与 `k=v`；整段 fragment 是高熵裸票据时置 `#***`；**没有凭证要脱敏时原样返回**（不把 `http://h:8965` 规范成带斜杠的形式，免得和本机配置对不上）。
- **审计加固 3（P2，reasons 取反）**：`config` 的 reasons 原来 `slice(-5)` 取尾部，而 `allowlist` 排在行序最前、尾部固定被 `execCwd/pwshPath/orphanPolicy/warning` 占满 ⇒ 默认配置下「为什么被拒」永远回不到板子。改成按动词取：`config`/`version`/`status` 取头部，`logs` 取尾部。
- **审计加固 4（P2，Host/worker 判据不对称）**：板子 `mode[:10]` 截断 + Python `.strip()` 不吃 BOM，而 Host 侧直接 `startsWith`、worker 侧只 `trim()` ⇒ `mode:'\uFEFFmaint'` 会被 Host 当 agent 派、worker 当维护任务读。判据抽到 `lib/dispatch-filter.js`（`normalizeTaskMode`/`isMaintMode`/`shouldAutoDispatch`，纯函数 + 单测），Host、`task-spec.js`、`worker.js` 的 `taskModeStage`、`executor.js` 的 stage 全部共用这一份，不再有第 N 份手写拷贝。
- **审计加固 5（P2）**：`resume.concat(queue)` 那一支也补上 maint 过滤（`/api/board/ui/attach` 能手工给 maint 任务写 `remote_id`，重启后会被当 agent 续派）；`board_dispatch` 的返回文案对 maint 不再谎称「派给 remote-agent」，并提示「目标机 worker 不在跑就会停在 queued」。
- **审计加固 6（P3）**：`lines` 真的是整数校验了（`[50]`/`true`/`12.7`/`0x10` 全拒，之前 `Number()` 会悄悄接受）；maint 任务书非法时 `stage` 按任务 mode 报（原来写死 `exec`，把排查引到命令策略上）；Host 的唯一动词表改为 import `MAINTENANCE_VERBS`（原来是两份硬编码）；`version` 里的 `port=` 改 `pid=`；`result.js` 里板子行号漂移修正。
- **审计加固 7（P2，二轮，功能回归）**：第二道闸在 `maintenanceOutDir` 是**盘根**时误判（`path.resolve('Z:\\')` 已自带尾分隔符，再拼一个成 `Z:\\`，任何文件都不以其开头）⇒ 配置成共享盘根时 payload **静默不落盘**。改为 `rootPrefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep`，并加了盘根回归测试。
- **审计加固 8（P3，二轮）**：Host 的 maint 预检原来只比动词名，`{"verb":"logs","lines":12.7}` 在本机放行、到副机才 `maint-spec-invalid`（白跑一趟）。现在 Host 直接调副机同一个 `parseMaintenanceGoal`，校验只有一份。
- **审计加固 9（P3，二轮）**：二轮复核指出 `sanitizeUrl` 漏 fragment、复合键名、非 URL 串里的 userinfo 三种形态，已按「加固 2」的最终形态补齐，并加回归测试（fragment 带 `access_token`、`x-board-token`/`board_token`/`X-Amz-Signature`/`X-Amz-Security-Token`、`u:hunter2@host`、`//u:p@host`、裸票据 hash，以及「普通 hash 与无凭证地址必须原样」）。
- **审计加固 10（P2/P3，三轮）**：三轮复核确认前两处已关闭，`sanitizeUrl` 还漏四类**非 `k=v` 形态**，已补齐：`;` 分隔（`?a=1;token=x`，WHATWG 当它是 `a` 的值）、百分号编码的等号（`?token%3Dxxx`）、空格/`+` 分隔的键名（`?access%20token=`）、fragment 里的 JSON（`#{"token":"j1"}`）。做法是解析之外再走一次整串字面清扫（键名先把 `%20`/`+`/空格归一成 `_` 再判凭证；JSON 用 `"key": "value"` 规则；`%3D` 后整段打码）——**过度打码可接受，漏不可接受**，非凭证参数（`machine=PC2`）与无凭证地址仍原样。同一轮还补了三处：面板 `POST /api/board/ui/create` 也过 `parseMaintenanceGoal`（原来只有 `board_dispatch` 过，面板建 `mode=maint` + 坏 goal 要到副机才 blocked）、`task-spec.js` 的 mode 归一化改 import `normalizeTaskMode`（此前是手写第 4 份拷贝，声明与实现不符）、`writePayload` 的 `artifact` 回 `path.resolve(file)`（`outDir` 带 `..` 时不再像相对路径）。
- **审计加固 11（P3，四轮）**：三轮把 `maskLoose` 从「任何 `k=v` 都打」改成「键名命中才打」时带来一处回退 —— fragment 与「解析不了的整串」里**未知键名**的凭证（`#ticket=`、`#sessid=`、`#code=`、`#otp=`、`not a url ticket=…`）不再打码。现按用途分两档：fragment 与整串兜底走 `allPairs`（键名不认识也打），URL 已解析后的整串清扫保留键名门控（否则 `?machine=PC2` 这类排障信息全糊）。同轮确认 `sanitizeUrl` 全仓唯一调用点是 `redactConfig`（只进 `config` 动词展示，不参与连接/落盘）；四轮结论：**可 push / 可 publish，无 P0/P1**，剩余项只有「boardUrl 里带百分号编码的分隔符/键名」（`%3B`、`%26`、`%253D`、NUL、`#t%6Fken=`）这一类极不自然的写法，展示层、P3。

- **新增 maintenance 只读通道**（`board_dispatch mode: 'maint'`）：goal 写 `version` / `status` / `config` / `logs`（`logs` 可带行数 1..200，JSON 形态 `{"verb":"logs","lines":80}`）。
  - 为什么：worker 一开，`dispatch:auto` 的任务被 worker 抢走，内联命令被拒 `inline-command-not-allowed`、非白名单脚本被拒 `approval-required` —— 远程排障与升级被自己的安全闸门堵死，而闸门是对的。维护通道只把「看」单独放行，执行面仍然是 0：**不 spawn 子进程、不读任意路径**，信息源只有进程内 config / 日志环形缓冲 / `worker.status()`，动词是代码里的冻结常量表。写动作（升级/重启）留给 v2.7 的签名一次性授权。
  - 板子带宽有限（note 500 / reasons 5×120）：摘要进板子，完整 payload 落 `worker.maintenanceOutDir/<machine>/<taskId>-<verb>.json`（UTF-8 无 BOM），路径写进 `artifact`。
  - `config` 动词用白名单式重建输出（`redactConfig`）：token 类键永不出现，将来加字段的失败方向是「不出现」而不是「泄漏」。
  - 新配置 `maintenanceEnabled`（默认 `true`：只读，默认关会让远程排障永远需要一次物理接触）、`maintenanceOutDir`（默认空=只回板子摘要）。
  - 板子对 `mode` 有 `mode[:10]` 截断（"maintenance" → "maintenanc"），主控与 worker 都按 `maint` 前缀认，别改成精确匹配。
  - Host 调度器**不认领** `mode` 以 `maint` 开头的任务（跳过派发队列）：否则它会被当成 agent 任务推给 remote-agent，等于让一个会话去「读版本号」。这类任务只由副机 worker 自己认领。
- **通信层抽出**：看板 HTTP 请求从 `lib/worker/board-client.js` 移到 `lib/worker/transport/http.js`，`board-client` 变成薄转发（对外导出不变，`createBoardClient` 只是 `createHttpTransport` 的别名）。行为与 v2.6.11 逐项等价，唯一有意的差异见下一条。
- **修 `ok` 判定（真 bug，v2.6.11 及其之前一直存在）**：HTTP 200 + 非 JSON 正文曾被算成 `ok:true`——`{error:'非 JSON 响应…'}` 没有 `ok` 字段，逃过了 `data.ok === false` 检查，主循环会把一个空快照当成「板子正常」。现在解析失败即 `ok:false`。
- 测试：新增 `test/worker/maintenance.test.mjs`（22 例，覆盖解析/脱敏/落盘/执行器/分流）；`test/worker/transport.test.mjs`（11 例）为假看板加了 `after` 兜底关闭 —— 断言失败会跳过测试末尾的 `close()`，监听 socket 于是握着事件循环，`npm test` 表现为**卡住**而不是失败（v2.6.11 的 gate 就卡在这一条上）。
- 版本同步 2.6.12（worker VERSION / UA）。

## v2.6.11 — 2026-11-17

外部审查（OpenPangu 2.1 Pro，v2.6.10 基线）的 P0/P2/P3 修复。

- P0-1：`do_mark` 进入终态时清掉 `holder` 与 `lease_until`；`reconcile_once` 写回终态也清 `holder`；solo 同段清理的字段名从 `leaseUntil` 修正为 `lease_until`，solo `release` 进终态同样清 holder（v2.6.10 的声明在 mark/reconcile/release 路径未完整落实，本版补齐）。
- 终态守卫：两板 `beat` 对终态任务返回 409，迟到的租约回写不再复活终态。
- `seed` 的 `created_at` 按导入序号递增，worker 排序保持 seed 顺序；claim 自动建单也补 `created_at`。
- P3：删除 `do_claim` 死变量；`do_create` / `do_seed` / solo `create` 写入 `created_at`，worker 排序不再退化为按 id。
- P2-1：`solo-board-smoke` 的 `call` 仅对 GET 请求偶发连接失败重试一次（POST 不重放），降低批量串跑时 S12 的 status=0 抖动。
- 文档：修正 v2.6.9 关于 GET 拒绝覆盖范围的措辞（3 条 guard 403 + 15 条 handler 405）；handoff 文档标注最终形态为单包双角色（v2.6.0）。
- 测试：board smoke 增加「终态 mark 清 holder/lease」断言。
- 版本同步 2.6.11（worker VERSION/UA）。
## v2.6.10 — 2026-11-16

- 面板任务按钮按终态收敛：failed/blocked 不再渲染「完成」，交付/打回对 failed 禁用并提示先重派（P3）。
- release 进入终态时清掉 holder 与 lease_until；mark 路径于 v2.6.11 补齐（CR-P3-1）。
- 版本同步 2.6.10（worker VERSION/UA）。

## v2.6.9 — 2026-11-16

外部审查（多模型合并报告，OpenPangu 2.1 Pro 的 P0）复核后的修复。

- 板子 `claim`：`cur_holder` 为空且任务处于 claimed/running 时，一律 409（不再按 machine 回退）。旧实例不带 holder 的占位无法与新实例区分，只能等租约过期转 stale；杜绝"旧独立 worker + 新单包"同机双跑。
- `solo-board.claim`：读取并落 `holder`；已有 holder 的占位必须同一 holder 才能续 claim（旧占位无 holder → 409）；`beat` 对不一致的 holder 返回 409（不带 holder 的旧客户端仍可用）。
- `solo-board` 的 mark/release/untake/beat/take 对齐 Python 板：占位已有 holder 时省略 holder 一律 409；mark/release 保留"租约过期且同机"的孤儿回收例外；终态归档的省略只允许"当前与请求状态都是终态"；claim 的 holder 比较改为严格（不再忽略大小写）。
- 终态任务不能通过 mark/release 改到别的终态（只允许同状态或任意终态→superseded 归档），防复活/改写结论。
- 面板 release（完成/打回）回带 `task.holder`，UI 路由透传 holder，solo 板在跑任务的人工收尾不再 409。
- UI `/untake` 带上 `INSTANCE_HOLDER`，无 holder/本实例占位的面板清理不再 409；UI `mark/release` 透传 `machine`，板子对"终态任务 + 无 holder + 请求状态为终态"放行，远程板归档可用。
- 显示名归一保留空格（"主机 甲"与"主机甲"不再被折叠为同一 key）。
- `redactConfig` 覆盖 `envPassthrough/passEnv`；`trace` 轮转改用 `pid+时间戳` 归档名，不再 unlink 其它进程的归档。
- 写型路由全部拒绝 GET：3 条由 uiGuard 返回 403，15 条由 handler 返回 405（38/38）。
- 测试：solo smoke 增加 S11（claim/beat holder 归属）、S12（省略 holder 的 mark/release/untake/take、大小写、终态归档）；board smoke 增加 V266b（旧客户端先 claim、新实例再接 → 409）与终态复活守卫。
- 边界：升级前无 holder 的旧占位需等租约（默认 30min + 120s stale 宽限）才能接管；solo 板的"租约过期且同机"是 mark/release 的唯一无 holder 例外。
- 已知问题：面板对 failed/blocked 任务的「交付/完成/打回」按钮仍会渲染，点击返回 409（下一步修）。

## v2.6.8 — 2026-11-16

- 同一处 Windows 8.3 断言：`resolveCwd` 的 inside 用例两边都改用 `fs.realpathSync.native` 比较；代码不变。

## v2.6.7 — 2026-11-16

- 修 Windows CI 的 8.3 短路径断言：`resolveCwd` 的 root-default 用例改用 `fs.realpathSync.native` 比较；v2.6.6 的代码不变。

## v2.6.6 — 2026-11-16

外部审查（GLM-5.3 / DeepSeek-V4.1 / HY4，四份报告）后的主要修复：

- 板子：`claim` 在有 `holder` 时 fail-closed（省略 holder 不能接管在跑任务），并落 `t.holder`；`mark`/`release` 的 holder 不一致返回 409（缺 holder 时仅回环或同机租约过期回收例外）；`beat`/`untake` 一律要求同一 holder；空 machine 的 `beat`/`release` 不再造幽灵机；中文显示名保留 Han 字符；坏状态文件先备份 `.corrupt.<ts>` 再重建。
- Host：10 条写型 UI 路由全部只收 POST（先前仅 3 条），GET/HEAD 返回 403/405；`uiGuard` 与宿主同样用 `new URL().pathname` 归一；`redactConfig` 递归打码；`trace` 8 MiB 轮转；`probe` 回退 stderr（python）。
- worker：exec cwd 先 realpath，必须绝对、非 UNC 且落在 `execCwdRoot` 内，否则 `cwd-root-invalid`/`cwd-not-in-root` blocked（`execCwdRoot` 未配置时保留旧行为、启动打一次 warning，等于不做根约束；无 workspace 时落在 root）；审批按 goal 指纹复用并把记录迁到新 taskId（修复 retry 换 id 后审批/撤销不收敛）；心跳成功会重置连续失败计数，心跳失败 3 次仍 abort；`stop()` 同时 abort 在跑任务。
- 打包：`files` 增加 `docs/issue-10/`。
- 测试：worker 156/156；board smoke 60 项；ui-guard 35/35。

已知问题（本轮未修，见 findings.json）：`mark` 仍无状态 CAS（终态可被翻回）；`update-check` 为 GET 且无缓存；`solo-board` 出站未脱敏；`execCwdRoot` 未配置时等同旧行为（仅 warning）；按机器 RBAC 与单 token HTTP 仍属设计边界；agent 真机端到端未验证。

## v2.6.5 — 2026-11-16

- 补上一处漏删的 `timer.unref()`（exec 超时计时器 6 空格缩进版本）；现在超时/宽限/排空计时器都保持事件循环存活，CI 不会再出现「Promise still pending but loop resolved」。

## v2.6.4 — 2026-11-16

- exec-runner 超时/宽限/排空计时器不再 `unref()`：假子进程场景下事件循环会先清空，测试 Promise 永久 pending（CI Windows Node 24 直接判 cancelledByParent）。收尾路径本来就会 clearTimeout，不影响进程退出。

## v2.6.3 — 2026-11-16

- CI 跨平台：exec-runner 用例在非 Windows 跳过（exec 只支持 Windows PowerShell）；agent-cwd 用例用平台对应的越界目录；e2e stderr 改 ASCII 避免 Windows runner 代码页把中文变成 `??????`；argv 断言用 `realpathSync.native` 对齐长路径。

## v2.6.2 — 2026-11-16

- 修 CI：worker-merge-smoke 的 W3 不再写死 2.6.0，改读 package.json 版本。

## v2.6.1 — 2026-11-16

- 修 Linux CI 卡死：agent-runner 的 `handle.dispose()` 无上限等待，假宿主 dispose 永不 resolve 时 `run` 超时/取消用例挂住；改为 `disposeWithTimeout`（最多 1s，失败仅记日志）。
- worker VERSION 与 UA 同步 2.6.1。

## v2.6.0 — 2026-11-16

- **单包双角色**：原 `dsh-job-worker` 的 worker 半边并入 `@wfcj/dsh-job-board`，仍只有一条插件行（`id: team`）。`workerMode: 'off' | 'drain' | 'on'` 决定是否在同一个进程里跑「认领 → 执行 → 回写」；Host/面板/看板工具在三种模式下都照常。drain 启动仍会跑一次孤儿扫描（升级窗口注意）。
- 并入内容：`lib/worker/`（agent 审批/预算/提示词闸门/agent runner/exec runner/看板客户端/主循环等 13 个模块）、`test/worker/` 13 个测试文件、`scripts/worker/` 的 selftest/agent-selftest/fake-board/pack-check。
- 看板契约不变：仍走 `/api/claim`、`/api/beat`、`/api/mark`（mark 必带 `machine`）；holder = `<machine>/<pid>-<rand>`，归属只认 holder，不认 note。
- 安全默认不变：`workerMode` 默认 `off`；即使打开，`worker.allowlist` 为空时不接 exec 任务，`agentEnabled` 默认 `false`（agent 路径需显式打开并配 preset/cwdRoot）。
- 配置合并：`cordis.patch.yml` 的 `inject` 只保留 `webServer`/`tools`（默认 off 不再因缺 `agentLoop`/`sessions` 整行挂死）；agent 服务在激活时读取一次，缺失则 agent 任务 `agent-unavailable`，exec 不受影响。新增 `workerMode` 与 `worker:` 默认块；worker 顶层沿用 `boardUrl` / `machine` / `token` / `timeoutMs`。
- 迁移：旧 `dsh-job-worker` 的插件行由它自己的包内 patch 插入，删 profile 行无效。必须先 `dsh plugin remove dsh-job-worker`（或从 `dsh.profile.bundles` 移除），或在 profile patch 里给该行加 `disabled: true`；否则两个 worker 会抢同一任务。agent 状态目录保持 `%LOCALAPPDATA%\dsh-job-worker`，旧审批/预算计数不丢。
- 版本对齐：worker 内部 `VERSION` 随包版本走（`test/worker/version.test.mjs` 断言等于 `package.json`）；新增 `scripts/worker-merge-smoke.mjs`（W1–W5：off 不注册 worker 工具、on 注册 20 个工具、状态报 2.6.0、cleanup 摘净工具、自动探测路径回显真实 boardUrl）。
- 测试：`npm test`（worker 153 项）+ 原有全量 smoke；`npm pack` 包含 `test/`、`scripts/worker/`。

## v2.5.10 — 2026-11-15

- npm 包名改为 **`@wfcj/dsh-job-board`**：npm 判定 `dsh-job-board` 与已存在的 `dsh-jobboard` 名称过于相似而拒绝发布；产品名、仓库名、界面标题保持 `dsh-job-board` 不变，scope 只影响安装名。
- 四处名称同步到 scoped 包名：`package.json` 的 `name`、包内 `cordis.patch.yml` 的 `name`、`lib/client.js` 的 client bundle `id`，以及 `lib/index.js` 导出的插件 `name`。四处不一致会导致 client 模块找不到、面板起不来。
- 安装方式：`dsh plugin add '@wfcj/dsh-job-board'`；`dsh.profile.bundles` 对应行写 `@wfcj/dsh-job-board`。**已装旧版 unscoped 包的用户必须先移除旧包再装**，否则两份代码会同时注册 patch/工具/路由（duplicate route、client 面板起不来）。
- 发布到 npm 后，DSH 自带插件市场的索引（`awesome-dsh-plugin.com/index.json`，npm 驱动）才会收录；此前虽然 README/数据文件已合入 awesome 仓库，但索引里没有 npm 条目，搜 `dsh-job-board` 搜不到。
- 测试：`npm pack --dry-run` 包名/版本正确；plugcheck / reload / ui-guard / model-pick / check-text 全部重跑。

## v2.5.9 — 2026-11-15

- 新增 `scripts/check-text.mjs`（`npm run check:text`）：机械检查 UTF-8/UTF-16 BOM、CRLF（`.cmd` 除外）、孤立 CR、C0/DEL 控制字符、重复中文短语、常见英文拼写、Markdown 围栏配平、行尾空白（Markdown 恰好两空格的硬换行豁免），以及 `package.json` 与 `CHANGELOG.md` 顶部版本漂移。这些是过去几轮复审反复报的「拼写/格式」类问题，改为每次 CI 与发布门前自动拦截。
- 安全与稳健性：`lstat` 跳过符号链接、单文件 2 MiB 上限、NUL 二进制探测；无 `.git` 时跳过并以 exit 0 退出（npm 包内可运行）；`--root` 可指定扫描根目录；缺 `package.json` 或 0 文件 exit 2；`process.exitCode` 输出完整明细。
- 新增 `scripts/check-text-smoke.mjs` 自检：临时仓库造 BOM/CRLF/重复中文/拼写/版本漂移，断言 exit 1；干净目录 exit 0。
- 首次扫描实测修掉：`AGENTS.md`、`docs/issue-10/07-dispatch-roles.md`、`lib/shell.js` 的 CRLF；`docs/issue-10/07-dispatch-roles.md` 的行尾空白。新增 `.gitattributes`（`* text=auto eol=lf`，`*.cmd -text`）防止再次写回 CRLF。
- CI 在 `plugcheck` 之前新增 `check-text-smoke` 与 `check-text` 两步；`AGENTS.md` 的发布门第 3 步加入同一检查（必须 exit 0，WARN 不阻断）。
- 测试：`check-text` 扫描 59 个文件 PASS；`check-text-smoke` PASS；其余 smoke 发布前跑全量。


## v2.5.8 — 2026-11-15

- 更新检查改走 GitHub 标签：`latestReleaseVersion()` 读 `https://api.github.com/repos/shaot92-del/dsh-job-board/tags?per_page=100`，按语义版本排序取最高 `vX.Y.Z`，不再依赖未发布的 npm 包（此前 `latestNpmVersion()` 对所有用户恒 404）。成功缓存 10 分钟、失败 60 秒；错误不回显上游原文。
- exec 结果契约：脚本最后打印一行 `DSH_RESULT {"ok":true,"expected":30,"actual":30,"reasons":[]}`，插件从副机 `[stdout]` 日志里解析后随终态 `mark` 回写板子；板子只收 `ok`（布尔）、`expected/actual`（0–1e12）、`reasons`（≤5 条 ×120 字），脏数据丢弃。
- 面板任务详情新增「结果：通过 / 不符 · actual/expected · reasons」一行：状态仍是 `done`（命令返回了），旁边多一行「结果：通过/不符」；结果不符标黄，但不会把任务状态改成 failed。
- **升级提示：`tools/board_server.py` 不在插件进程内，升级后要重启看板进程，旧板子会静默丢弃 `result` 键（插件侧 mark 仍成功，只是看不到结果行）。**
- 测试：`dispatch-recovery-smoke` 增至 91 项（R31/R31b：hidden 与列表两条路径的 `DSH_RESULT` 都落板）；`board-server-smoke` 新增 F3b（result 落库/读回）、F3c（回队列清 result）、F3d（非法 result 保留旧结论）；`update-check-smoke` 改用假 GitHub 标签并验证 `v9.10.0 > v9.9.9` 的数值排序。

## v2.5.7 — 2026-11-15

- 机器卡区可收起/展开：窄屏（CSS 宽度 < 1420px，覆盖 1366×768 的 14 寸笔记本）默认收起为一行摘要，任务列表不再被三张能力卡挤出屏幕；选择写入 `localStorage['dsh-board-machines-collapsed']`。
- 机器区展开时最多占 min(46vh, 340px) 并在内部滚动，保证下方任务列表始终可见；收起摘要带「在跑 N / !注意 / ⚠风险 / ?未知」，任一机器 risky 时强制展开。
- 新增「详情」弹窗（对帽子字段做 String/对象兜底，caps 脏数据不会崩面板）：点开一台机器可看完整硬件、全部编码器、模型清单（名称/来源/位置/标签）与稳定性计数、上次压测。机器卡摘要仍只显示三行。

## v2.5.6 — 2026-11-14

- 能力自检结果面板改为三段式：标题栏（状态徽章「全部通过 / N 项待修」+ 重新检测）、可滚动内容区、固定底栏（取消 / 保存能力卡）；保存不再被 6 个模型顶出屏幕。
- 模型列表默认 3 行，展开/收起移到区段标题右侧，展开后列表独立滚动（264px）；行改为 grid（名称省略+title / 来源徽章 / 标签 / 位置），窄屏不再挤成 2–3 行。
- 折叠时补「另有 N 个模型未展示（含 X 个按名称推测/云端）」，避免勾了「允许高风险」却看不到被授权的模型。
- 机器卡：能力卡缺 `tools`/`models` 时显示「编码器未上报 / 模型未上报」，不再误报「无硬件编码 / 0 个模型」。
- doctor：`hub /nodes` 404 按本机 remote-agent 的实际角色判定——worker 降为 info；本机是 hub 仍报 error；角色未知时用 warn 并给出两种解释，不再用看板 `dispatchRole` 猜。

## v2.5.5 — 2026-11-14

- 修复稳定性自检在“没有某个事件 provider”的机器上误判读取失败：无 NVIDIA 卡时 `nvlddmkm` 查询会抛 E_INVALIDARG(0x80070057)，整块被标成 readFailed，GT14 因此一直显示「未知」。现在先做 System/Application 通道 canary（存在、可枚举且未禁用），且只有确实可能缺失的 `nvlddmkm` 允许把 E_INVALIDARG 按 0 条处理；通道异常、其它 provider 的参数级错误仍标 readFailed。
- 验证：GT14 修复后 `level=good`、`readFailed=false`、`confidence=measured`；主机仍为 `watch`（appCrash 228 噪声）、`readFailed=false`。

## v2.5.4 — 2026-11-14

- 能力探测弹窗补「完成态」：三类探测跑完后明确显示「已完成，结果已写入本机能力卡」，主按钮改为「完成」，并保留「重新探测」；不再让人误以为测试没跑完。
- 配置自检结果面板补「自检完成 · 确认角色与模型标签后保存」，保存按钮改为主按钮；关闭前不会再看起来像缺一个确认步骤。
- 关窗再打开保留上一轮探测结果；勾选项没跑完时横幅提示「还有 N 项未测」，不再把上次结果当成这次已完成。
- 已知问题：GT14 的 Windows 事件日志读取失败时稳定性显示「未知（读取失败）」；本次不改动该读取逻辑，单独排查。

## v2.5.3 — 2026-11-14

- 稳定性进入能力卡：配置自检时顺带跑一次**只读**的 30 天/7 天事件摘要（Kernel-Power 41、BugCheck、WHEA、TDR、磁盘/文件系统、应用与服务崩溃、热限制），加上 uptime、挂起重启、GPU 温度/驱动；写入 caps 的 `stability` 字段，机器卡显示「稳定性 稳定/注意/风险 · 30天 TDR n · 蓝屏 n · 上次压测 通过/未通过/未压测」。
- 新增**可选压测**（默认不做）：快速 3 分钟 / 标准 10 分钟 / 深度 60 分钟，跑 1080p NVENC 编码 + 多路补帧，采温度、NVML 降频、窗口内新增 WHEA/TDR/Kernel-Power、吞吐漂移与 CV；结果写 `stability.evidence.lastBurnIn`，可随时取消（服务端杀整棵进程树）。
- 隐私：只读事件计数与时间，不读正文/进程名/路径/用户名；不采序列号/UUID/MAC；必须用户点击；原始日志不落盘；每机“关掉共享”的开关尚未实现，能力卡目前仍随 caps 上报到板子。
- 附带 `board_dispatch` 的 exec 目标守卫：goal 含换行、`$`、管道/重定向、cd、powershell/cmd 语法或超过 300 字时给出警告，建议改用「绝对 pwsh + 共享盘脚本」写法（不拦截，只提示）。
- 附带 `scripts/patch-remote-agent.ps1`：给 dsh-remote-agent 的 PowerShell 解析器补 `%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe`（用户级安装不再落到 5.1）。
- 说明：压测是可选动作，不做也不影响派工；它只证明「这台机器在这段时间里扛住了我们的负载」，不等于长期稳定性认证。
- 复审修复：事件读取失败不再伪装成 `good/measured`，而是 `unknown + inferred`；压测异常只回稳定错误码，写回前 reason 仍做路径/用户掩码并截断；取消后回 200 `{cancelled:true}`（不再被报成「压测失败」），驱动挂死有 20s 硬兜底。能力卡保存改为**合并**旧卡（事件逐项取最大、上次压测取较新），面板回传探测快照不会抹掉压测证据；环境失败（无 ffmpeg、非 NVENC）只记 `error` 不写「未通过」，编码器自动降级**并让负载轮跟随 libx264**；NVML 降频改查 hw_slowdown/hw_thermal/sw_thermal 并纳入判据；结果区显示具体 `error`（如 encode-failed），不再笼统显示「未通过」。

### 已知问题（P2，不阻断）
- 事件阈值偏保守：30 天内应用崩溃（Application Error 1000）超过 5 次就报「注意」，桌面机日常噪声可能误报；后续按机器基线调整。
- 尚未做「重活前强制压测/拒绝」门控；当前只展示，选机仍看能力与负载。
- 压测占用本机 GPU/CPU，期间不建议再接重活；没有与调度器做自动互斥。
- CI runner 无 GPU/ffmpeg，压测路由只做 4xx/409 门测试，真实压测只在开发机覆盖。
## v2.5.2 — 2026-11-14

- 补帧探测增加**并发采样**：单流 2s（96 帧）+ 2–6 路 × 0.5s（每路 24 帧）并行，分别记录单流 `value`、`aggregate`（并发合计）、`perStream`、`maxStreams`。路数按 CPU 核数与空闲内存收敛，避免 8GB 机器被 6 路 ffmpeg 拖到换页。实测 Host 单流 4.65 fps、6 路合计 12.13 fps——单流快不代表并行也快，批处理 ETA 必须按合计吞吐估。
- caps 的 workload 条目新增 `aggregate` / `perStream` / `maxStreams`（可选，向后兼容）；`cleanWorkload` 校验范围。
- 能力探测弹窗显示「单流 X fps · N 路 Y fps」（N 是本次采样宽度，不代表容量上限）。
- 说明：多机拆分调度（按 wall 取 max）仍在 v2.5.3；本版先把「并发曲线」采集下来，避免以后用单流值估批处理。
- 复审修复：ffmpeg 启动改用 `ProcessStartInfo.ArgumentList`（路径含空格不再被拆开）；并发段失败只丢并发数据、保留已测单流值；路数按核数与空闲内存收敛（2–6）、并发样本 0.5s；`cleanWorkload` 增加交叉一致性（`perStream ≤ aggregate ≤ value × maxStreams × 1.05`），不一致的并发字段直接丢弃；`workload.streams` 纳入白名单。

### 已知问题（P2，不阻断）
- 路数只是按核数与空闲内存的粗估，不在探测前检查本机是否已有任务在跑；低内存机器仍可能感到卡顿。
- 并发样本只有 0.5s，初始化摊销偏重，`aggregate` 可能低估约 5%。
- `maxStreams` 是本次采样宽度，不是实测容量上限；按它做批处理拆分前应再加压测。
- ETA 仍按单流 `value` 估，同机并发跑多个任务时会偏乐观；多机拆分与并发上限留 v2.5.3。
- CI runner 没有 ffmpeg，A5/A7 在 CI 走「缺 ffmpeg」分支，真实探测只在开发机覆盖。
- 并发段一旦失败，已启动的 ffmpeg 不会被立刻杀掉（样本 ≤0.5s，最多跑完当前样本）；临时目录靠 2 小时清理。
- 降级探测（并发段失败或按资源跳过）会用只带单流 `value` 的结果整条替换旧条目，旧卡的 `aggregate/perStream/maxStreams` 会丢失；当前 ETA 只用 `value`，不影响选机，v2.5.3 让 aggregate 参与 ETA 前必须先修（保留旧并发字段或改为不写卡）。

## v2.5.1 — 2026-11-14

- CI 修复：`scripts/model-pick-smoke.mjs` 的 A5 真实探测改为环境感知。GitHub `windows-latest` 没有 ffmpeg，原断言硬要求 200 导致 windows CI 红；现在无 ffmpeg 时断言「返回 500 且错误点明缺 ffmpeg」，有 ffmpeg 时仍做完整实测。产品行为不变。

## v2.5.0 — 2026-11-14

能力路由第一版：把「哪台机器强」换成「这个任务预计多久跑完」。

### 1. 工作大类目录（8 类，先开 3 类）
- 目录：视频转码、视频补帧、合成渲染、图像生成、语音合成、文本/代码对话、视觉理解、数据搬运。
- 首版只开放 `video.transcode` / `video.interp` / `video.render` 三项探测；其余标注「v2.5.1 接入」。

### 2. 能力探测（独立入口，只测本机）
- 顶栏新增「能力探测」，与机器卡的能力卡配置分开。
- 每类跑固定小样本（转码 10s、补帧 2s、渲染 240 帧），结果 `confidence=measured`，写入本机能力卡 `workloads[]`。
- 实测耗时（Host，RTX 3070 Ti）：转码约 2s、渲染约 1s、补帧约 20s（生产口径 4.8 fps）；首版无取消，窗口可关闭但探测会跑完。

### 3. 数据与路由
- caps 升到 `schema: 2.1`，新增 `workloads[]`（id/unit/value/samples/confidence/workload/measuredAt/benchVersion）。
- `board_dispatch` 新增 `taskKind` 与 `size`：有实测能力时按 `ETA = size/value + 8s` 选机，15% 内不换机、取更闲；无实测回退「最闲」。
- 回执带 `workload`、`size`、`etaSeconds`，便于核对。

### 4. 测试
- plugcheck `tools=18 routes=22`；ui-guard 21/21；reload A/B/C；model-pick M1–M11 + R1–R4 + A1–A6（含 workloads 保存、ETA 选机、真实探测写卡、读卡失败不覆盖旧卡）。
- 全量回归见 docs §38。

### 已知限制
- 探测值来自合成样本，用于**横向比较**；绝对 ETA 会在有真实任务历史后校准（v2.5.2）。
- 只测运行插件的那台机器；远程机器探测放 v2.5.1。
- 探测脚本仍走 PATH 的 pwsh，带 `-ExecutionPolicy Bypass`（与 caps-probe 相同，非提权面）。
- 读旧卡失败时不写空值：探测直接 503；面板保存只有在用户本次显式提交 models/workloads 时才带这两个键，读卡失败时不会用空数组覆盖旧卡（A6 回归）。
- `taskKind` 的 ≤15% 容差与「计算时间 <2s 不跨机」已实现；<2s 阈值按扣除 8s 固定开销后的计算时间判断。15% 分支目前没有自动化用例（ETA 最小者胜已覆盖），v2.5.1 补。

## v2.4.3 — 2026-11-13

安全复审（v2.4.2）收口：无 P0/P1，修复 1 个 P2 与若干 P3。

- **能力卡预算口径**：板子侧 `json.dumps(ensure_ascii=False)` 比 `JSON.stringify` 多出分隔符空格，实测 **9.26%/9.32%/10.79%**（短字段越密越高）；原来 7600 字节的预算会让 7.0–7.6KB 的卡稳定被板子 413。预算降到 **7000**（客户端同步提示“约 7.0KB 上限”）。
- **写入口对齐**：`/api/board/ui/caps-apply` 非 POST 一律 405（与 caps-probe 一致），不再依赖「浏览器构造不出 GET+body」这层假设。
- **错误信息收敛**：探测失败只回「能力自检失败（详情见插件日志）」，stderr（含安装路径/用户名）只进 trace；失败后 10 秒冷却，避免串行拉起 pwsh。
- **探测脚本**：去掉多余的 UTF-8 BOM（`#requires` 仍可用），注释里的内网 IP 换占位、名称改「多机调度台」；`set-team-config.ps1` 不再打印 token 前缀，改回显长度与 sha256 前 8 位。
- **桌宠 404**：不再回 `cfg.petImage` 绝对路径。
- **浅色对比度（代码复审 P1-1/P2-1）**：浅色下 `.dsb-note`、`.dsb-lrow .s`、`.dsb-empty` 不再叠 `opacity`（原 2.88–4.16:1，低于 AA 4.5）。
- **宿主变量兜底（P2-2）**：`--dsw-alias-border-l1/l2` 一律带 `var(--dsb-bd)/var(--dsb-bd2)` 兜底，宿主变量缺失时边框不再整条失效。
- **provider 类别表统一（P2-3）**：新增 `providerKindOf()`，`capOf` 与下拉兜底共用同一张 local/cloud 名单（补 siliconflow/openrouter/azure/groq/xai/mistral/together/fireworks/perplexity/cohere），避免“判定 cloud 但守卫不认”导致 local/lan 模型并到云端。
- **截断计数（P2-4）**：`srcModels.slice(0,80)` 截掉的条数计入 `modelsDropped`，提示与实际丢弃一致。
- **能力卡字段保留（P3）**：`caps-apply` 先读本机旧卡，把 `features/os/cores/memGB`（以及 gpu 为空时的旧 gpu）补回，避免首次由面板保存后 `requires` 过滤失去事实源。
- **默认值（P3）**：重测保存沿用旧卡的角色（主职不再被降成副职）；位置缺省显示“未定”（`''`）而不是“本机”（下拉补了 `未定` 选项）。
- **复核 P3 收尾**：旧卡 `features` 只回填白名单键（shell/pwsh/powershell/ffmpeg/ffmpegHw/gpu/browsers/python/node，字符串值截 240 字）；`cfg.machine` 为空时跳过旧卡读取；`modelsDropped` 文案区分“最多 80 条 / 约 7.0KB”。
- 测试：全量回归（plugcheck 18/20、ui-guard 18/18、model-pick M1–M11+R1–R4+A1–A3、dispatch 88/88、board smoke 60、acceptance 10+1）。

已知未修（P3，记录触发前提）：
- `caps-probe` 仍带 `-ExecutionPolicy Bypass`：仅在 GPO 强制 AllSigned 的机器上有争议，未在目标机实测。
- caps 的 `identity/tools/limits` 无单字段长度上限：仅信任边界内的本机 UI 能写；病态 payload 理论可撞 8KB。
- `/assess` 仍是 GET 可触发（既有）：写板子 + identity，有 10 分钟缓存兜底，跨站不可读响应。
- `_runtime.log` 不轮转：长期运行会变大，日志已脱敏。
- 模型 provider 为自报字段：只影响下拉分组/标签，若将来按 location 计费需服务端事实源。

## v2.4.2 — 2026-11-13

看板 UI 第二片：模型用途、派工分型与主题。

### 1. 能力卡：模型与用途
- 自检结果面板新增模型清单：每个模型可编辑用途标签（逗号分隔）、显示来源（实测/已声明/按名称推测）与上下文。
- 重测时按模型 id 只保留旧卡里用户填过的标签（source/location 以本次实测为准）；保存仍走 `caps-apply` 的 8KB 预算。
- 标签输入改为本地草稿：键入时不拆词，失焦才归一，逗号/空格不会被受控回写吞掉；模型行新增「本机/局域网/云端」位置选择，服务端只接受**更贵方向**的覆盖（local<lan<cloud，云端端点不能被标成免费），其余以 endpoint 自动判定为准。

### 2. 派工：模型按来源分组
- `summary` 的 `nodeModels` 合并板子能力卡的 `location/tags/source`；派工弹窗的模型下拉按「云端 · 按量计费 / 局域网 · 免费 / 本机 · 免费 / 其他」分组，并显示前两个用途标签。
- 顶层仍是“自动（最闲的在线副机）”，选自动时只列所有在线副机清单的交集。

### 3. 主题与一致性
- `.dsb-root` 新增 `--dsb-*` 语义 token（背景/层级/边框/文字/强调/成功/警告/危险 + RGB 分量），主面板核心面与内联样式改用 token；桌宠气泡等装饰性配色未逐一校准。
- 顶部新增 ☾/☀ 主题开关，默认深色，选择写入 `localStorage`（`dsh-board-theme`）；浅色为独立调色板，不影响宿主主题。
- 品牌行加 `dsh-job-board · N 台在线` 副标题；任务行在机器之后显示模型，失败/打回/作废行标注「可重派」。

### 4. 测试与边界
- `plugcheck` 18/20、`ui-guard` 18/18、`model-pick` M1–M11 + R1–R4 + A1–A3（A3 断言 summary 真把 caps 的 location/tags 并进 nodeModels）、`dispatch` 88/88、board smoke 60、acceptance 10+1 全绿。
- 安全复审 3 条 P2 已修：模型元数据按机器建二级索引（不再跨机串味）、索引对象改 null-proto 并拒收 `__proto__/constructor/prototype`、tags/modalities 逐项 trim+截 24 字。
- 仍是“单面板 + 自检面板”，不是设计稿里的四步向导；云端价格、`taskKind` 自动选型与 eco/boost 留后续版本。
- 代码复审阻断已修：浅色主题的核心面（任务详情、派工弹窗、清理/自检弹窗）不再用宿主深色底或写死深色字；状态标签补浅色专用色，`data-theme="dark"` 显式生效，宿主浅色也不会串色；桌宠气泡等装饰性配色仍未逐一校准。
- 同时修：探测缓存保存后失效（60 秒内重测不再拿回旧标签）、**有未保存编辑时**才确认重测、自动池先吸收元数据（不再全落“其他”）、自动池与已选模型用同一判据（有在线副机没上报清单时不做跨机交集）、保存时提示被 8KB 预算截掉的模型数、能力卡保留 provider 且裸名兜底只认同 provider、同名节点模型合并去重、任务详情不再重复显示模型、副标题不计 host；`[::1]` 与严格 IPv4 私网判定；重测合卡先按机器 id 精确匹配，`identity.machine` 只做兜底。
- 安全复审 P2 已修：`nodeModels`/`nodeMap` 改 null-proto（`nodeId='__proto__'` 不再写 `Object.prototype`，A3 补回归）；模型位置以 endpoint 判定为底，自报值只能在更贵方向覆盖，URL 不可解析时按 cloud 处理。探测频率仍由面板「配置自检」触发（同源写权限才可调，45 秒上限），未加独立限速，记为低危。

## v2.4.0 — 2026-11-13

### 多机调度台 + 能力卡自检（第一片）

- 面板更名：标题、侧栏、错误页统一为「多机调度台」；包名与工具名不变。
- 新增 `scripts/probe-caps.ps1`：只读探测 CPU / 内存 / GPU / ffmpeg 硬件编码器 / 浏览器 / 本机模型端点，输出 `schema: 2` 的能力卡（不安装、不提权、不改系统）。
- 新路由 `POST /api/board/ui/caps-probe`（只在本机跑探测）与 `POST /api/board/ui/caps-apply`（确认后写板子；身份固定用 `cfg.machine`，不信请求体）。
- 机器卡新增「配置自检」按钮与结果面板：硬件摘要、编码器/本地模型数量、待修项、角色四选（主职/副职/仅空闲/不接）、「允许高风险任务使用未验证模型」开关、保存/取消；已上报 schema 2 能力卡的机器在卡上显示硬件/编码器/模型数与角色。
- 测试：plugcheck `tools=18 routes=20`；model-pick 增 A1（caps-apply 身份与字段清洗）/A2（本机探测）；全量回归绿。
- 未包含（设计稿后续片）：模型用途标签独立页、云端/局域网/本机三分组、浅色主题开关、按任务标签自动选模型。

## v2.3.1 — 2026-11-13

### 复审修复：重派派发权、更新提示可见性、供应链文案

两位审核员对 v2.3.0 给出 FAIL（2 个 P1），本版按发布门修复：

- **B1（阻断）**：`board_retry` 与 `/api/board/ui/retry` 漏传 `dispatch: 'auto'`，重派出的任务永久排队。两处改为共用一个 `retryBoardTask()`，建单显式带 `dispatch: 'auto'`，并补 R1 断言。
- **B2（阻断）**：更新提示挂 info 级、面板只渲染 error/warn，用户完全看不到。面板新增独立提示行「插件有新版本 vX（当前 vY）：在插件市场升级后重启 DSH」；doctor 保留 info 级与 `latestVersion`。
- **供应链**：doctor 提示不再打印 npm 安装命令（该包名尚未注册，避免被抢注后误导安装），改为插件市场 / GitHub Releases 离线包；registry 请求加 `redirect: 'error'`，错误只记日志、不回显原始文本。
- 其余：重派做活跃副本去重（409）、机器名归一；复制产物路径改为等待 Promise 再报成功；产物/标题裁剪上限对齐板子（300/120）；重派路由透传板子状态码；failureHint 收紧并只对 failed/blocked；update 缓存失败 60 秒、成功 10 分钟并做 in-flight 去重。

### 已知问题（P2，不阻断）

- 重派去重是「先查后建」，并发仍可能各建一份；`note` 被改写后去重会失效（建议后续用结构化 `retry_of`）。
- artifact 只是字符串，凡持 board token 者可见执行机本地路径；无下载/打开接口。
- npm 包名尚未注册；更新提示只指向插件市场 / GitHub Releases，不打印安装命令。
- `update-check` 是 GET，可被跨站触发一次外呼（3s 超时、失败 60s / 成功 10min 缓存），无 CORS、不可读响应。

### 测试

plugcheck 18/18、reload A/B/C、ui-guard 15/15、state-file 16/16、config-persist 11/11、solo/bootstrap/shell、model-pick M1–M11 + R1–R4、dispatch 88/88、board smoke 60、acceptance 10+1；新增 update-check 探针（npm 9.9.9 → updateAvailable=true、doctor info 检查存在）。

## v2.3.0 — 2026-11-13

### 新功能：失败重派、任务成果、更新提示

- 新增 `board_retry` 工具与 `/api/board/ui/retry` 路由：把 `failed` / `blocked` / `superseded` 的任务按原 `goal`、`machine`、`mode`、`model`、`workspace` 重新建单，note 写「重派自 <原 id>」；执行中的任务、找不到的任务直接拒绝。工具数 18、路由 18。
- 任务详情增加产物「复制路径」；失败任务按 note 给出诊断（模型未登录 / 上下文超限 / 工作目录不可达 / 超时 / 网络），并在详情里直接提供「重派」。
- 更新提示：doctor 增加 info 级 `update` 检查，`/api/board/ui/update-check` 只读查询 npm registry 的 `dsh-job-board@latest`（3 秒超时、10 分钟缓存、失败只记错误），发现新版本时提示在插件市场升级（或 GitHub Releases 离线包）并重启；不自动安装。

### 测试

- plugcheck `tools=18 routes=18`；reload 场景 A/B/C；ui-guard 15/15；state-file 16/16；config-persist 11/11；solo-board / solo-bootstrap / shell-guard 全过；model-pick M1–M11 + R1–R3；dispatch-recovery 88/88；board smoke 60 项；acceptance 10 绿 + acc-08 期望失败。
- 说明：npm 发布尚未执行（本机没有 npm 登录凭据）；包内容已通过 `npm pack --dry-run` 校验。

## v2.2.3 — 2026-11-13

### 修复：版本提示、幻影机器与移除反馈

- doctor 新增 `version-skew` 检查：运行版本与磁盘已安装版本不一致时提示「重启 DSH 后生效」，并在响应里返回 `installedVersion`；面板横幅直接显示「磁盘已装 vX，重启后生效」。这次截图里的 v2.1.0 横幅就是旧实例，2.2.2 的评估修复要重启才生效。
- `tools/board_server.py` 的 `do_say`：空机器名 / `?` 不再 `touch_machine`，不再生成永远离线的幻影机器（之前它把在线数算成 3/5）。已手动清掉现存的 `?` 与离线的 MB14。
- 面板机器列表过滤 `?` 占位；移除失败仍走顶部 notice，但会在确认框里写明「在线机器需先停那台的 DSH」。

## v2.2.2 — 2026-11-13

### 修复：评估卡点击后仍显示“未评估”

- 根因：面板 `runAssess` 的 `POST /api/board/ui/assess` 只带了自定义头 `x-dsh-team-ui`，没有 `content-type: application/json`，被 UI 闸门以 403 `forbidden` 挡下；旧逻辑不检查 `ok`，把 403 当成完成，卡片虽隐藏但评估结果从未写盘，重开仍是未评估。
- 修法：`lib/client.js` 的评估请求补 `content-type: application/json` 与空 JSON body；失败时保留卡片并提示（v2.2.1 已加）。
- 测试隔离：`scripts/ui-guard-smoke.mjs`、`scripts/reload-smoke.mjs` 除 `DSH_TEAM_STATE_DIR` 外，再隔离 `DSH_TEAM_IDENTITY_DIR` 到临时目录并在结束时删除，避免把真实 `~/.dsh-board/identity.json` 写成测试机名（本次真机就被写成了 `ui-guard-smoke`，导致 `needsAssessment` 恒为真）。
- 真机清理：真实身份文件已通过重新评估恢复为 `machine=host`；重启 DSH 后生效。

## v2.2.1 — 2026-11-12

三条通道复审后的修补：显示名所有权归板子、改名不再伪造心跳、面板的失败路径不再“报成功”。

### 1. 显示名以板子为准

- `do_caps` 不再用机器自己的 caps 覆盖看板侧已存的 `caps.alias`（首次上报仍可作种子）。
- 本机改名现在会**立即**推一次 `/api/alias`：撞名 409 会回滚本地配置并返回冲突，不再出现“本地成功、板子失败”的分叉。
- 唯一性统一到 `_alias_key`（去控制/零宽/bidi、只留字母数字、casefold），同时比对身份名与显示名；撞名只丢 alias，不让整条 caps 上报 409（否则机器会被判离线）。

### 2. 改名不是心跳

- `do_alias` 不再调 `touch_machine`，只写 `caps_at`；给离线机器改名不会把它“救活”，也不会让「移除」按钮消失。

### 3. 移除

- `force` 严格 `is True`（`{"force":"false"}` 不再能强删在线机器）。
- 确认文案写明“再次上报会重新出现”；返回附带指向它的任务数；补 `alias`/`forget` 审计事件。

### 4. 面板失败路径

- 评估失败（`ok:false`）不再收起评估卡、不再显示“完成”；保留可重试入口。
- 任务详情里的交付/打回按状态禁用，与行内规则一致。
- 复制 JSON 改为 await + catch + textarea 回退；失败会明确提示，不再无条件报成功。
- `cardBusy` 改成按机器的对象，A 卡操作结束不会解锁 B 卡；移除成功后清掉改名编辑态。
- `busyN` 把 `claimed` 也算进去；任务详情里的机器/占位走显示名。

### 5. 自检横幅

- `dispatch-paused` 恢复为 `warn`（暂停调度会让任务一直不动，不能藏进 info）。
- `/doctor` 返回非 JSON 且没有 checks 时，横幅显示“自检不可用”，不再静默消失。

### 测试

- `scripts/board-server-smoke.py` **48 项**：新增 caps 不覆盖改名、`force:"false"` 被拒；冲突用例改为“只丢 alias”。
- 全量回归保持全绿：plugcheck 17/16、ui-guard 15/15、dispatch 88/88、model-pick M1–M11、acceptance 10+1。

## v2.2.0 — 2026-11-12

看板操作补全：能移除离线机器、给别的机器改名、展开任务详情；顺手把两条“没事也弹”的自检项降噪。

### 1. 移除离线机器

- 机器卡片对**离线**机器显示「移除」；确认后 `POST /api/board/ui/forget-machine` → 板子 `/api/forget-machine`。
- 板子只移除 `last_seen` 已超过 `ONLINE_WINDOW` 的机器；在线机器需要显式 `force`（面板不提供，防误删）。任务记录不删，仍可在「全部」里查。

### 2. 给别的机器改名

- 卡片「改名」：自己的机器仍走本地 `/alias`（写 `cfg.machineAlias`，重启后仍生效）；**其他机器**走 `/api/board/ui/machine-alias` → 板子 `/api/alias`，只改 `caps.alias`，身份 `machine` 不变。
- 板子侧统一清洗（去控制字符、空白折叠、≤32 字），并与其它机器的身份名/显示名做唯一性比较（冲突 409 带 `conflict`）。

### 3. 任务详情可展开

- 展开行新增：模型、模式/派工方式、远端任务 id、占位（taker/holder）、目标全文、进度；另加「复制 JSON」，一键复制整条任务（排查时不用再翻板子）。

### 4. 评估卡完成后收起

- 评估成功后横幅自动收起，只留一句结果提示；工具栏新增「评估」，需要时再打开。

### 5. 自检横幅降噪

- `config-saved`、部分机器离线、调度器暂停、machine 为空降为 `info`（面板不再弹）。
- 仍保留 `error`：没有 token、板子连不上、hub 上没有 worker、调度器半死、路由降级。

### 6. 板子

- 新增 `/api/alias`、`/api/forget-machine`（都要 token；状态写入在 `STATE_LOCK` 内）。

### 测试

- `scripts/board-server-smoke.py` 38 → **45 项**：改显示名 200、快照出现新名、撞名 409、在线机器移除 409、`force` 200、移除后快照没有该机。
- `scripts/reload-smoke.mjs` 路由 14 → **16**（场景 D 13 → 15）；`plugcheck` 17 工具 / 16 路由。
- `model-pick` M1–M11、`dispatch` 88/88、`ui-guard` 15/15、`acceptance` 10+1 保持全绿。

## v2.1.0 — 2026-11-12

派工时选「机器 + 模型」。以前看板只有机器维度，模型一律跟随副机默认 —— PC2 上
正是这样把 62K tokens 的任务塞进 32K 上下文的模型，报错还回显成"派工失败"。
这一版把模型做成板子任务的正式字段，并让对话派工先问清楚。

### 1. 任务带 model，一路透传

- `board_server.py` 的 `create` / `claim` / `seed` 接受并保存 `model`（≤160 字），
  看板快照原样返回；
- 插件调度器派发时取 `task.model || cfg.defaultModel`，再交给 remote-agent 的
  `/dispatch`（服务端本来就有 `normalizeModelSelection`）；
- `lib/solo-board.mjs` 与 `scripts/fake-board.mjs` 同步存这个字段；
- 看板快照（`snapshot()`）补上 `model`，否则调度器读不到任务级模型（复核 P1）；
- `do_claim` 只在任务本来没有 `model` 时写入，认领方不能改写建单决策。

### 2. 新工具 board_options

汇总在线机器与每台上报的模型清单（`provider` / `model` / `name`）、副机默认模型、
team 的 `defaultModel`，供面板与对话选型。model 可写 `provider/model` 或裸名。

### 3. 对话派工先问「哪台机器、哪个模型」

`board_dispatch` 新增 `model` 参数；在 `dispatchAsk`（默认 true）下：

- 没选机器 → 返回 `needSelection: true` + 候选机器/模型，不建单；
- 机器上报了模型清单但没选模型 → 同样返回候选，不建单；
- 机器 + 模型都给了 → 先核对目标机是否上报过它，拼错/该机没有的模型返回
  `available` 并拒绝建单（不再等到副机才炸）；
- `model: "auto"` 表示跟随副机默认，跳过选型；`exec` 模式不需要模型，也不会
  把 `defaultModel` 发给副机；
- 显式 `machine: "host"` 只在 hub 节点列表确实有 host 时放行（否则任务会永远排队）。

`needSelection` 用 `ok: true` + `needSelection: true` 表达，调用方不会把它当成
失败（旧契约是 `ok: false`，容易被 agent 顺手报成"派工失败"）。

工具本身弹不了原生提问卡，所以契约是"返回候选 → 调用方用 ask_user_question 问人 →
带 machine/model 重调"。后台自动派工不经过这个工具，不会被拦住；想完全跳过可配
`dispatchAsk: false`。

- 对话派工先问机器；指定机器后只按该机清单决定是否要求选模型（无清单直接跟随机默认）。

### 4. 看板派工弹窗加模型下拉

面板从 `/api/board/ui/summary` 的 `nodeModels` 取每台机器的模型清单：选了机器就只列
那台的模型，选"自动"则列**在线非 host 机器的交集**（并集可能把 A 机模型派给 B 机）；
默认项是「跟随副机默认（团队默认 …）」。`nodeModels` 的键统一小写，与 `pick` 的
比较方式一致。机器清单变化后会清掉已不可用的 `model`，避免发一个不存在的模型出去。
任务建单时 `model` 原样进 `/api/create`；板子连不上时 `/create` 返回 502 而不是把
machine 盲写进去，板子还没有该机 caps 但 hub 已连着它时按 hub 身份接受。

### 5. 机器显示名：身份稳定，名字可改

- 身份（`machine`）仍是电脑名/显式配置，参与任务归属、账本与恢复日志，**改名不动它**；
- 新增 `machineAlias`：用户可给本机起一个显示名（≤32 字），随 caps 上报到板子，
  看板机器卡片、任务行、`board_options` 都显示它；留空回退电脑名；
- 面板工具栏新增「改名」，保存走 `/api/board/ui/alias`（同样过 UI 三闸门）；
- 显示名只能当**查找键**：面板派工、`board_dispatch`、`/api/board/ui/create`、
  `board_attach` 与 `/api/board/ui/attach` 都会先把它归一成身份 id；认不出来就 400，
  绝不把别名写进 `task.machine`（否则任务会静默卡在 queued，别名撞上别机身份名时还会
  派错机器）；板子侧 `_canon_machine` 也认 `caps.alias`，`do_attach` 对显示风格的名字
  直接 400（不造 ghost 机器）；
- 改名做唯一性校验（不能和别的机器的身份名/显示名相同），清洗 C0/C1、零宽与 bidi
  控制符，写档失败会直接报 500 而不是假装成功；板子 `do_caps` 对重复显示名返回 409，
  改名路由在板子不可达时返回 `unique: "unverified"` + warning（本地仍然生效，恢复后自动上报）；
- 去掉了 client 里写死的 `GT14/MB14/PC2/host` 对照表，改为按板子上报的
  `machine.name` 显示——别人装插件时不会再被我们的机器名带偏。

### 6. 配置与脚本

- team 配置新增 `defaultModel`（空=跟随副机默认）与 `dispatchAsk`，都进第二层存档；
- `scripts/set-team-config.ps1` 新增 `-DefaultModel`，用法示例改用占位符；
- doctor 的 `config-saved` 提示会带上这两个键。

### 测试

- 新增 `scripts/model-pick-smoke.mjs`（M1–M11）：board_options 汇总、未选机器/未选模型
  拦截（`ok:true` + `needSelection`）、只给模型仍先问机器、机器无清单不要求选模型、
  建单带 model、`model:auto` 放行、目标机没有的模型被拒、exec 忽略 model、传显示名
  派工时 `task.machine` 仍是身份名；`board_attach` 传显示名时 `/api/attach` 的 machine
  同样是身份名；
- `plugcheck` 期望工具数 16 → 17（新增 board_options）；`/api/board/ui/alias` 使路由
  数 13 → 14；
- 全量回归：plugcheck 17 工具/14 路由、reload A/B/C、ui-guard 15/15、state-file 16/16、
  config-persist 11/11、solo-board、solo-bootstrap、shell-guard、dispatch 88/88、
  board smoke 38 项（含 attach 显示名折回 / 未知显示名 400 / alias 全局唯一 409）、
  acceptance 11 项。

### 边界

- `model` 只对 agent 模式有意义；exec 忽略。
- 副机必须先注册 OpenAI 兼容 provider，模型才会出现在清单里（否则退化为手填/副机默认）。
- 模型本身的上下文上限仍是风险：小模型跑长任务会超窗，工具会在终态 note 里补提示，
  但不会自动换模型。

## v2.0.7 — 2026-11-12

第二轮代码审阅的最后三项（P1-5 / P2-9 / Python 终态不修剪），外加市场维护者提的
一条示例占位符建议。没有改看板/派工协议，也没有改任务字段语义。

### 1. 过期恢复日志会绑错远端（P1-5）

`escalateExpiredJournal` 以前用 `rows.find` 只按 goal + **时间下界**匹配：既没有上界，
也不排除已经被别的板任务占用的远端任务。一条 3 小时前的过期日志，可以"认领"另一条
板任务正在用的 `ui-new`，于是从未完成的任务借别人的结果变成假完成。

现在统一走 `dispatchMatchWindow(rec)` + `matchRemoteCandidates(...)`：

- 窗口同时有下界（`sentAt - SEND_SKEW_MS`）与上界（`at + SEND_SKEW_MS`）；
- 候选排除本轮已认领的（`matched`）与板上已被任何任务占用的 `remote_id`（`occupied`）；
- 板子上本任务已经回绑 → 只清日志，不再重复 attach；
- 候选 >1 → 推迟 60 秒（不猜），0 条且窗口覆盖 → 才标 blocked。

### 2. 终态同步只取 hub 最近 200 条（P2-9）

hub `/tasks` 是 `slice(0, 200)`。板上 running 的任务一旦被挤出窗口，`syncRemote`
以前直接 `continue`，板上永远显示"进行中"。

现在对列表里缺失的已知 `remote_id` 做**有限并发 4** 的 `/task?taskId=` 单条查询：

- 查得到 → 用单条结果正常回写终态；
- 明确 `task-unknown` → 板上标 `failed` 并说明"远端已不存在（可能被回收）"，不再永久 running；
- 查询失败/旧 hub 404 → 不动（不能把可能在跑的任务判死）。

顺带修掉一个前置问题：列表为空时以前在探测前就 `return 0`，整段逻辑永远走不到。

### 3. Python 终态任务不修剪（P2-9 尾部）

`MAX_TASKS` 统计的是全部任务，终态任务只增不减 —— 到 5000 后 create 与未知 claim
全部 413。新增 `prune_terminal_tasks()`：容量检查前清掉 **30 天前**的
`done/failed/blocked/superseded`，未终态一律不动。仍可用 `GP_BOARD_MAX_TASKS` 覆盖上限。

### 4. 市场建议：示例去掉真实值

`scripts/set-team-config.ps1` 的用法示例里还有内网 IP、截断 token 与具体机器名，
现在改成 `<board-host>` / `<board-token>` / `<machine-name>` 占位符。

### 测试

- `dispatch-recovery-smoke` 新增 **R27**（远端被 200 条窗口挤出，单条查询仍能收尾）
  与 **R28**（过期日志不抢别的任务占用的 remote）、以及 **R29/R29b**（通用 404 与
  查询断连都不能把在跑任务判死），**86/86**。
- `board-server-smoke` 新增 **P2-16**（3 条 40 天前终态 + 上限 2：先修剪再建单），
  全过。
- 其余回齐全绿：plugcheck 16/13、reload A/B/C、ui-guard 12/12、state-file 16/16、
  config-persist 9/9、solo-board、solo-bootstrap、shell-guard、acceptance 11 项。
- 测试钩子：fake hub 的 `/tasks` 支持 `hidden` 任务，便于模拟被挤出窗口。

## v2.0.6 — 2026-11-12

第二轮代码审阅（基线 `11f4d68`）里的 P2 七项。全部是边界行为，没有改协议，也没有改
看板/派工的既有语义。

### 1. Solo 机器字典的原型污染（P2-7）

`machines` 以前是普通对象：`caps`/`metrics` 用 `machine='__proto__'` 写一次，就会改到
`Object.prototype` 上；`task_id='__proto__'` 建的任务在快照里也看不见。现在 `emptyState`、
`loadState`、`snapshot` 都使用 `Object.create(null)`，读写统一走 `hasOwn`/`getTask`。

### 2. untake 不校验 holder（P2-8）

同一台机器上的两个实例都能 untake 对方的占位。现在与 take 一样比较 holder，
不同则 409「占位归另一个实例，拒绝 untake」。调用方**没有提供 holder** 时不比较
（面板与旧客户端只发 task_id + machine，不能因为升级就把它们的撤占位能力弄丢）。

### 3. Solo 异步启动与卸载竞争（P2-10）

`apply` 返回后立刻 `cleanup` 时，solo 的 `listen` 可能还没完成；以前会留下一个
没人关闭的监听。新增 `soloAbandoned`：卸载时置位，启动回调看到后立即 `close()`。

### 4. `uiAllowedHosts` 没接线（P2-11）

`uiGuard` 早就读 `cfg.uiAllowedHosts`，但配置里没有这个键。现在：
`cfg.uiAllowedHosts`（数组、去空、转字符串）→ `TEAM_CONFIG_KEYS` 持久化 → 存档合并
→ `uiGuard` 的白名单 Set。默认空数组 = 仍然只允许回环。

### 5. cwd 不存在时静默回退（P2-12）

`sh_run` 以前 spawn 失败才报错，或者干脆落到宿主进程的当前目录。现在先校验
`cwd` 是目录，否则直接返回「cwd 不存在或不是目录：…」，不再替用户猜目录。

### 6. 允许盘符根时子路径被误拒（P2-13）

`withinRoots` 以前用字符串前缀判断，`C:\` 这种根会算错。现在先 `realpath`，再用
`path.relative(root, target)` 判断「不以 `..` 开头且不是绝对路径」，盘符根、UNC 根、
POSIX `/` 都一致。

### 7. Python 板子的单实例与任务上限（P2-14 / P2-15）

- 锁从「state + 端口」改为只看 **state 的真实路径**：同一份 `state.json` 只能有一个
  写入者，换端口也起不来第二个；同端口仍由 `SO_EXCLUSIVEADDRUSE` 挡。
- `MAX_TASKS` 从只卡 `seed` 扩到 `create` 与「claim 未知任务时自动建单」，并支持
  `GP_BOARD_MAX_TASKS` 覆盖（测试用）。

### 测试

- `solo-board-smoke` 新增 S9（holder 不符 409）、S10（`__proto__` 不污染、任务可见）。
- `shell-guard-smoke` 新增 G6（cwd 不存在报错）、G7（盘符根白名单）。
- `ui-guard-smoke` 12/12（新增 uiAllowedHosts 名单内放行、名单外 403）。
- `board-server-smoke.py` 新增 P2-14、P2-15，共 23 项全过。
- 全量：plugcheck 16/13、reload A/B/C、ui-guard 12/12、state-file 16/16、
  config-persist 9/9、solo-board、solo-bootstrap、shell-guard、dispatch 80/80、
  board smoke、acceptance 全部通过。

### 这一版没做

- P1-5（过期恢复日志绑错远端，需要按轮次重建证据）与 P2-9（终态同步只看最近 200 条，
  需要分页接口）留到 v2.0.7。

## v2.0.5 — 2026-11-12

## v2.0.5 — 2026-11-12

PC2 的两个真实问题 + 首次安装的模型指引。这一版没有改协议，只让「坏掉时看得出下一步」。

### 1. 左侧又出现「远程同事」面板

不是作业板新增的 UI，而是 PC2 上的 `dsh-remote-agent` 处于**半旧状态**：`package.json`
写着 0.9.12，但 `lib/client.js` 里没有 `SHOW_REMOTE_PANEL = false` 这一段（0.9.12 才有），
于是它按旧代码注册了 `sidebar.panellist` 与 `main` 两个槽。

处置：用主机 0.9.12 的 `lib/client.js` 覆盖 PC2 的同名文件（原文件留 `.bak-panel`），
刷新页面后入口消失。作业板自己的 DOM 隐藏逻辑仍在，但它只在面板加载后每 1.5s 扫一次，
不能替代插件侧的开关。

### 2. 第一次安装「拉不起模型」

全新 profile 里常常没有 `agent-default-model` 块，DSH 会退回默认路由
`deepseek-official`；那台机器上又没有 API key，于是 agent 任务报
`no API key for provider route "deepseek-official"`。用户看到的是「装完就用不了」。

两处修：

- `pc2-onboard.ps1` 在写 team / remote-agent 之后补一个 `agent-default-model` 块
  （`provider: deepseek-account`、`model: deepseek-flash`、`reasoningEffort: max`）。
  账号仍要在那台机器的 DSH 里登录一次——脚本不代持凭据。
- 插件 `syncRemote` 在把副机失败写回看板时，识别 `no api key` / `no key for provider` /
  `transport failed` / 裸代码 `TRANSPORT`，追加「该副机模型不可用（未登录/未配置，或网络不通）：
  在那台机器上登录账号、检查代理后重试」。原始报错保留，只补一句提示；文案同时覆盖
  鉴权与网络两种可能，不替操作者下结论。

### 验证

- `dispatch-recovery-smoke` 新增 R26（message 形式）、R26b（只有 code=TRANSPORT）、
  R26c（远端状态为构造器名时不得当成终态写回），**80/80**。
- `plugcheck` 16 工具 / 13 路由；`ui-guard-smoke` 10/10。
- 主机与 PC2 均无需改协议；PC2 的 `client.js` 替换已实机执行并复核
  （`findstr "SHOW_REMOTE_PANEL = false"` 命中）。

## v2.0.4 — 2026-11-12

一次「测试污染 + 盲信配置」的修复。v2.0.3 重启后 doctor 报 `板子连不上：fetch failed`，
板子本身正常（127.0.0.1:8965 与 <board-host>:8965 都返回 200），根因是两件事叠加：

1. `scripts/plugcheck.mjs` 也 `apply` 插件，但没隔离 `DSH_TEAM_STATE_DIR`，把
   `boardUrl: http://127.0.0.1:1`（故意不可达）和测试 token 写进了真实
   `~/.dsh/dsh-team/config.json`；配置文件又比 patch 优先，重启后插件就拿着死地址。
2. `baseUrl()` 对 `config.boardUrl` 是**盲信**的（`if (boardBase) return boardBase`），
   不探活、不回落 —— 死地址会让整个插件永远连不上板子，面板只显示 fetch failed，
   看不出是配置问题。

### 改了什么

- `baseUrl()` 对来自配置的地址先 `probeBoard`，不可达就 trace 并重新探测（pin → 候选）。
- `plugcheck.mjs` 使用临时状态目录，并在结束时清理；同类 smoke（reload/ui-guard/
  config-persist/dispatch/solo/shell）此前已隔离，这次补齐最后一个漏网的。
- 已把宿主真实 `config.json` 的 `boardUrl` 从 `http://127.0.0.1:1` 修回
  `http://127.0.0.1:8965`。

### 测试

- plugcheck 16/13、reload A/B/C、ui-guard 10/10、state-file 16/16、config-persist 9/9、
  dispatch 76/76、solo 10+5、shell-guard 10 项、board smoke 19 项、acceptance 11 项。
- 重启后 doctor 应无 `board` error（MB14 离线仍会给 workers 警告）。

## v2.0.3 — 2026-11-12

两位复审专家（AI 生成代码安全审计师 / 代码审查工程师）对 v2.0.2 改动逐行复核后，
确认了 2 个高危、1 个中高、4 个中危和若干低级问题。这一版全部修掉，并**纠正 v2.0.2
里一条记错的结论**：Python 板子的 `do_claim` 本来就允许「认领未知任务时自动建单」
（Host 统一派工靠它占位），v2.0.2 改成 404 反而与它不一致，本版恢复自动建单。

### 改了什么

1. **solo 自举不再把存档降级成 `solo:false`（高）**——首次 `persistTeamConfig()` 在
   solo 启动前执行，旧写法 `snap.solo = !!soloBoard` 此刻恒为 false；只要 solo 启动
   失败、临时设置 `DSH_TEAM_SOLO=0`、或进程在 listen 前退出，存档就永久停在
   `solo:false` + 旧随机端口，下次启动判定「已配置」不再起板子，用户再也连不上。
   现在单独维护 `soloIntent`（存档意图，含 2.0.1 无 `solo` 键的兼容判定），
   只有「显式配置 token/boardUrl」才写 `solo:false`；启动失败只记日志，不改存档。
2. **`allowAllRoots` / `envPassthrough` 真正接进 apply（中高）**——这两个键以前只在
   `registerShellTools` 的参数里存在，`cfg` 与 `TEAM_CONFIG_KEYS` 都没有，写进 patch
   也不生效；`envPassthrough` 完全不可用。现在两者进入 `cfg` 与存档白名单，
   两处 `registerShellTools` 调用都显式传参；`shell-guard-smoke` 增加 G5/G5b，
   从 `apply` 一路测到 `sh_read`，不再绕开接线。
3. **claim 恢复自动建单**（中）——见上；`create` 校验 `TASK_ID_RE`，非法 id 返回 400。
4. **任务上限只算活跃任务**（中）——`MAX_TASKS` 改为 `MAX_ACTIVE_TASKS = 5000`
   （只计非终态），加载时清理 30 天前的终态任务（`pruneTerminal`），5000 条 done
   不再把新任务永久卡在 413。
5. **solo 任务的键安全**（低）——`tasks` 改为 `Object.create(null)`，`hasOwn`/`getTask`
   替换裸取键，`__proto__` / `constructor` 不会再造幻影任务或误报「已存在」。
6. **shell 拒绝文案分情况**（中）——空白名单时说「没有配置 allowedRoots」并给出两条
   放行路径，不再误报「路径不在白名单」。
7. **`set-team-config.ps1` 备份不覆盖**（低）——备份名精确到毫秒，重名自动加 `-1`、
   `-2`，`Copy-Item` 去掉 `-Force`。
8. **POSIX 环境变量补齐**（中）——`ENV_KEEP` 增加 `HOME`/`TMPDIR`/`USER`/`LOGNAME`/
   `PWD`/`LC_ALL`，以及代理变量与 `SSH_AUTH_SOCK`、`NODE_EXTRA_CA_CERTS` 等。
9. **文档纠正**——README 与 `docs/issue-10/08-exec-policy.md` 里「`allowedRoots` 空 =
   不限制」改为「空白名单默认拒绝，需显式 `allowAllRoots`」；`lib/index.js` 导出的
   `name` 改为 `dsh-job-board`；`package.json` 的 `files` 补 `scripts/ui-guard-smoke.mjs`。

### 测试

- `solo-board-smoke`：S3b/S3c 覆盖「未知任务自动建单」，S3d 原型键、S3e 非法 id，
  S7 预置 5001 条 done 仍可建单。
- `solo-bootstrap-smoke`：B6 断言 `solo:true` + 可达 + token 沿用 + 任务跨重启仍在；
  B7 覆盖「临时 `DSH_TEAM_SOLO=0` 不降级存档、恢复后仍起板子」。
- `shell-guard-smoke`：G5/G5b 走 `apply` 集成路径。
- 全量回归：plugcheck 16/13、reload A/B/C、ui-guard 10/10、state-file 16/16、
  config-persist 9/0、dispatch 76/76、board smoke 19 项、acceptance 11 项全过。

## v2.0.2 — 2026-11-12

一次「审计 + 事故」合并修复：1 个高危（solo 重启失联）、1 个改名遗留（PC2 起不来）、
3 个中危（任务凭空生成、脚本注入/半截写、shell 白名单 fail-open），外加一个环境变量收敛。

### 改了什么

1. **client bundle 的模块 id 改成包名**（`lib/client.js`）——这是 PC2「装完重启 DSH
   客户端起不来、要屏蔽插件才能启动」的原因。改名后 loader 按包名注册客户端模块，
   而 `id` 还是 `dsh-team`，客户端找不到模块就整个界面挂住。现在 `id: 'dsh-job-board'`，
   跟 `dsh-remote-agent` 的写法一致。
2. **solo 第二次启动不再失联**（`lib/index.js` + `persistTeamConfig`）——solo 板子用
   `port: 0` 随机端口，第一次启动把 `boardUrl` 写进 `config.json`；重启后 `cfg.token` /
   `cfg.boardUrl` 都有值，旧逻辑判定「已配置」就不起板子，结果指向一个已经死掉的端口。
   现在存档里带 `solo: true` 时视为自举用户，照样重新起板子、沿用存档 token、把新地址
   写回去（任务在 `solo-board.json` 里，不会丢）。
3. **`claim` 不再凭空造任务**（`lib/solo-board.mjs`）——对不存在的 `task_id` 返回 404，
   与 `tools/board_server.py` 对齐；`create` 增加 `MAX_TASKS = 5000` 上限。
4. **`set-team-config.ps1` 防注入 + 原子写**——值统一经 `YamlQuote`（拒绝换行、
   单引号转义成 `''`），写盘改为 `$path.tmp-setteam` + `Move-Item -Force`，
   避免写一半把 patch 截断（这个项目已经丢过两次配置）。
5. **shell 白名单 fail-closed + 环境变量收敛**（`lib/shell.js`）——`allowedRoots` 为空
   且没有显式 `allowAllRoots: true` 时，`sh_read` / `sh_write` / `sh_list` / `sh_run`
   的 `cwd` 一律拒绝（以前空白名单等于全盘放行）；子进程不再继承整个 `process.env`，
   只透传 `PATH`、`SystemRoot`、`TEMP` 等基础变量，需要别的用 `envPassthrough` 显式列。

### 测试

- 新增 `scripts/shell-guard-smoke.mjs`（G1–G4，8 项）：空白名单拒绝、显式放行、
  私密环境变量不外泄、`envPassthrough` 生效。
- `solo-board-smoke` 增加 S3b（claim 不存在 → 404）；`solo-bootstrap-smoke` 增加
  B6/B6b（同目录二次 apply 仍能起 solo、token 沿用存档）。
- 全量回归：plugcheck 16/13、reload A/B/C/D、ui-guard 10/10、state-file 16/16、
  config-persist 9/0、dispatch 76/76、board smoke 19 项、acceptance 11 项全过。

### 升级注意

- **PC2 / 从 git 安装的机器**：删掉旧的 `node_modules/dsh-team`（如果还在），
  重新 `dsh plugin add github:shaot92-del/dsh-job-board`，重启 DSH。
- 主机：本次也要重启 DSH 才会加载 2.0.2（旧进程里还是 1.4.1）。

## v2.0.1 — 2026-11-11

修 v2.0.0 漏掉的一处改名：**包内 `cordis.patch.yml` 的 `name` 还是 `dsh-team`**。

### 为什么会这样

`package.json` 的 `name` 只决定 npm 包名和安装目录；真正让 loader 去解析哪个模块的，是
包内 bundle patch 里 `- insert: - name: '...'` 这一行。v2.0.0 改了前者、漏了后者，于是：
- 本机：profile 里原来的 `dsh-team` 还在，旧实例继续跑，看不出问题；
- PC2：从 git 装了 `dsh-job-board`，但 patch 让 loader 去找 `dsh-team` 模块，
  找不到（或找到另一个同名 npm 包），表现就是「装了但名字还是旧的 / 起不来」。

### 改法

- `cordis.patch.yml` 的 `name: 'dsh-team'` → `name: 'dsh-job-board'`；
- 文件头注释同步改名；
- 版本 2.0.1。

### 验证

`npm pack --dry-run` 里 `cordis.patch.yml` 内容已更新；本地 profile 的 `- id: team`
覆盖块不受影响（它只覆盖 config，不声明 name）。装完仍需重启 DSH。

## v2.0.0 — 2026-11-11

改名：`dsh-team` → **`dsh-job-board`**（仓库同名）。功能不变，只动名字与安装方式。

### 为什么

- npm 上 `dsh-team` 已经被另一个无关的「Agent Teams」插件占用（0.2.11，周边还有
  `dsh-team-control` / `dsh-team-hub`）。从市场或 `dsh plugin add dsh-team` 装，
  解析到的是别人的包，版本对不上就装不上或装出四不像。
- 兼容名字里带 `team` 的候选也被占了：`dsh-ops-board` 对应 `ZJR24/dsh-ops-board`
  （11/06，项目看板）。`dsh-job-board` 在 npm 与 GitHub 都空着。

### 改了什么

- `package.json` 的 `name` → `dsh-job-board`，`repository` / `bugs` / `homepage`
  指向 `https://github.com/shaot92-del/dsh-job-board`；版本直接跳 **2.0.0**
  （包名变了，按 semver 算破坏性变更，装法也要跟着换）。
- GitHub 仓库已改名，旧地址 `shaot92-del/dsh-team` 由 GitHub 重定向；
  README 的安装命令、`dsh.profile.bundles` 说明同步改。
- 本机 profile：依赖 `dsh-job-board: file:D:/gp_video/dsh-job-board`，
  bundles 里把 `dsh-team` 换成 `dsh-job-board`；旧的 `node_modules/dsh-team`
  不再被任何东西引用（重启后可以删）。

### 没改什么（有意保留，避免老配置失效）

- 状态目录仍是 `~/.dsh/dsh-team`（journal、pendingAttach、config.json、solo 板子状态都在里面）；
- 环境变量仍是 `DSH_TEAM_*`（`DSH_TEAM_STATE_DIR`、`DSH_TEAM_SOLO`、`DSH_TEAM_BOARD_CANDIDATES` 等）；
- Cordis patch 的实例 id 仍是 `- id: team`，工具名仍是 `board_*` / `sh_*`；
- 板子服务、doctor、路由、面板行为与 v1.5.3 完全一致。

### 迁移

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add 'github:shaot92-del/dsh-job-board'
# 确认 profile package.json 的 dsh.profile.bundles 里是 dsh-job-board
# 重启 DSH
```

数据不会丢：token、机器名、派工记录都在原来的状态目录里，插件按同一套键读取。

## v1.5.3 — 2026-11-11

把 R21 从「看时序」改成「看结果」，并把 holder 语义补到真板子的 smoke 里。

### 修了什么

- **R21 在 ubuntu-latest 上偶发失败**（v1.5.2 的 CI）。断言原来是
  `holderConflict >= 1`，但两个实例的 tick 谁先谁后决定了第二个实例会不会真的
  发出第二次 take：A 先 take 成功后任务就是 `claimed`，B 的候选过滤只取
  `queued/stale`，会直接跳过、不产生 409。于是同一条正确行为有时 0 次冲突、
  有时 1 次。现在断言的是可观测结果：`dispatch === 1 && remoteTasks.length === 1`
  （只派一次、远端只有一条任务），时序细节只写进失败信息。
- **真板子 smoke 补 holder 用例**：同机两个实例（holder 不同）对同一条任务先后
  `/api/take`，第二个必须 409「已被同机的另一个实例占住」。这条以前只在
  fake-board 里测过，真板子没覆盖；R21 放软之后就由它来守 409 语义。
  用例里 `/api/create` 需要显式 `dispatch: 'auto'`，否则 `do_take` 会以
  「不是自动派发任务」拒绝（第一次跑就踩到了）。

### 验证

plugcheck 16/13、reload A/B/C、ui-guard 10/10、state-file 16/16、
config-persist 9/0、solo 10+5、dispatch **76/76**、board smoke 19 项全过、
acceptance 11/11。`windows-latest` 与 `ubuntu-latest` 双绿。

## v1.5.2 — 2026-11-11

市场复验的第一条收尾 + 配置脚本。

### 改动

- `lib/index.js` 的 `BOARD_CANDIDATES` 不再硬编码作者的局域网地址
  （`<host-pc>:8965`、`<board-host>:8965`）。默认只探 `127.0.0.1:8965`；
  内网/远程候选地址改用环境变量 `DSH_TEAM_BOARD_CANDIDATES`（逗号分隔）或
  `DSH_BOARD_URL` 指定。这是市场第一次复验留下的最后一条（「删掉两条内网候选地址」）。
- 新增 `scripts/set-team-config.ps1`：自动找 profile、upsert `team` 块、写前备份、
  写后复核。起因是手粘 YAML 时聊天工具会把 `'` 换成弯引号 `‘ ’`，PowerShell
  字符串永远不闭合，终端卡在 `>>` 续行——这种问题不该让人靠手改文件解决。
  - `-List` 只看各 profile 有没有/重不重复 team 块；
  - `-Profile desktop -BoardUrl ... -Token ... -Machine PC2 -Role observer` 写入；
  - `-DryRun` 只打印不落盘。

### 验证

`set-team-config.ps1` AST 解析通过；临时 profile 上实测两条路径（更新已有块、追加新块）
均通过，字段与其它条目保持不动。回归全绿：plugcheck 16/13、solo smoke 10+5、
dispatch 76/76、board smoke 17/17、acceptance 11/11。

## v1.5.1 — 2026-11-11

打包漏文件：`package.json` 的 `files` 里没有 `lib/state-file.mjs`。

### 为什么

`lib/index.js` 静态 import 了 `./state-file.mjs`，但 `files` 只列了 index/client/shell/solo-board
四个文件。`dsh plugin add github:...` 走 pnpm 的 git 安装，会按 `files` 打包（packlist），
装完 Host 半边会因缺模块加载失败——市场 review 也是因为这条打回的。npm 安装同理。

### 改动

- `files` 改成 `"lib/"`，整目录收进来，以后再加 `lib/` 下的文件不会再漏。
- README「装」一节改正：仓库现在**带** `tools/board_server.py`（多机用），单机则由
  v1.5.0 的 `lib/solo-board.mjs` 零配置自举；不再写「仓库不含该服务」。

### 验证

`npm pack --dry-run` 确认包含 `lib/state-file.mjs`；`node --check` 全过；回归全绿
（plugcheck 16/13、solo smoke 10+5、dispatch 76/76、board smoke 17/17、acceptance 11/11）。

## v1.5.0 — 2026-11-11

零配置也能用：第一次启用时，插件自己在 127.0.0.1 上起一个最小板子。

### 为什么

用户从插件市场装完 dsh-team 直接启用时，profile 里没有 `team` 配置（没有 token、
没有 boardUrl），过去的体验是**面板全空 + 板子 401**。要用起来得同时凑齐三样：
一台机器上跑着 Python 板子、拿到 board token、手改 `cordis.patch.yml`。这三道门槛
对「只想在一台机器上看看」的人完全不成立，PC2 上就是这样卡住的。

### 改动

- 新增 `lib/solo-board.mjs`：随包的 Node 最小板子，只做 solo 需要的子集——
  `create / claim / take / untake / attach / mark / beat / release / caps / metrics /
  say / seen`，语义对齐 `tools/board_server.py`（take 守 `dispatch=auto`、holder 冲突
  409、mark 的身份校验与状态白名单、release 归属、caps/metrics 大小上限）。
  **只绑 `127.0.0.1`**，token 默认 `randomBytes(24)` 随机生成，`timingSafeEqual` 比较；
  状态写 `<stateDir>/solo-board.json`（tmp+rename、0600）。
- `lib/index.js`：零配置（`!cfg.token && !cfg.boardUrl`）时自动 `startSoloBoard`，
  把生成的 token/boardUrl 写进第二层配置 `config.json` 并 trace
  `solo 板子已启动 …（仅 127.0.0.1，token 自动生成）`；`baseUrl()` 首次调用前 await 它
  就绪；cleanup 时关闭监听（状态文件留着，下次接着用）。
- doctor：新增 `solo` 信息项（显示地址与状态目录），响应带 `solo: true|false`；
  有 solo 板子时不再误报 `config-token`。
- 显式配了 token/boardUrl 的用户完全不受影响；`DSH_TEAM_SOLO=0` 或配置
  `solo: false` 可关掉自举。

### 边界

- solo 板子只能本机用（进程内、127.0.0.1、随机端口），**不能**替代多机作业板：
  接团队仍要用 `tools/board_server.py` + 共享 token。
- 邀请码 / 首次启用向导还没做（下一版）；现在要接入团队仍是手填 boardUrl+token。

### 验证

新增 `scripts/solo-board-smoke.mjs`（10 项：起板/无 token 只回 ok/401/建认领心路/
重启持久化/close 后不应答）与 `scripts/solo-bootstrap-smoke.mjs`（5 项：零配置自举、
config 写入、无 token 401、cleanup 关监听、显式配置不启 solo），全部通过；回归：
plugcheck `tools=16 routes=13`、reload A/B/C/D、ui-guard 10/10、state-file 16/16、
config-persist 9/9、dispatch-recovery 76/76、board-server-smoke 17/17、acceptance 11/11。

## v1.4.2 — 2026-11-11

doctor 的一个假警报。

### 修了什么

- `lib/index.js` 的 `doctor` 检查读的是 `cfg.boardToken`，而这个字段从来不存在（配置字段叫
  `token`）。后果：**即使 token 配好了，面板也永远报 `config-token 没有配置板子 token`**，
  v1.4.0 上线后一直被当成真的失联。改成 `cfg.token`。
- `scripts/ui-guard-smoke.mjs` 增加断言：apply 时传了 token，`doctor.checks` 里就不得出现
  `config-token`（发版前抓这个 bug 的回归测试）。

### 说明

- 这个 bug 只影响 doctor 的显示，不影响实际鉴权：板子读写、派工、同步一直用的是
  `cfg.token`，所以「面板报错但任务能跑」的怪状态就是它造成的。
- MB14 本轮未上线（板子 `last_seen` 约 9 小时前，hub 只有 GT14 一条 Established），
  与本版本无关，等那台机器恢复后重启 DSH 即可。

### 验证

plugcheck `tools=16 routes=13`；ui-guard 10/10；reload A/B/C/D；state-file 16/16；
config-persist 9/9；dispatch-recovery 76/76；board-server-smoke 17/17；acceptance 11/11。

## v1.4.1 — 2026-11-09

配置的第二层兜底：profile patch 被整份重写时，插件不再跟着失联。

### 为什么

2026-11-09 22:57，`C:\Users\17827\.dsh\profiles\desktop\cordis.patch.yml` 被外部重写成
889 B / 4 条，`- id: team` 与 `- id: remote-agent` 整块消失（当天第二次丢块）。后果不是
「面板报个错」，而是：team 没有 token → 板子 401；hub 退回默认只监听 `127.0.0.1:19387`
→ 两台副机全部掉线、队列排着不动。`dsh-remote-agent` 本来有 `instance.json` 兜底，
但那份文件从来没生成过；team 则完全没有兜底。

### 改动

- **`lib/index.js` 增加 `<stateDir>/config.json`**（`DSH_TEAM_STATE_DIR` 覆盖，默认
  `~/.dsh/dsh-team`）。白名单只存 9 个键：`token`、`boardUrl`、`machine`、`dispatchRole`、
  `allowedRoots`、`dispatchApproval`、`timeoutMs`、`shellTimeoutMs`、`maxOutputBytes`。
  规则：loader/patch 显式给了值 → 以它为准并回写存档（用户改配置仍然生效）；缺省 →
  用存档兜底。这样「谁把 patch 写坏了」不再等于「整机失联」。
- **doctor 更诚实**：新增 `config-saved` 警告（列出哪些键来自存档），响应增加
  `configSource: "patch" | "saved"`。看到这条就说明 patch 又被重写了。
- **`scripts/config-persist-smoke.mjs`**：9 项断言——C1 空配置全部走存档、C2 显式值覆盖
  存档、C3 混合（显式覆盖、缺省续用上一轮写回值）。
- **本机补了 `~/.dsh-remote-agent/instance.json`**（`role: hub`、`listenHost: 0.0.0.0`、
  `listenPort: 19387`、`nodeToken`，ACL 仅本人）：即使 patch 再次丢掉 remote-agent 块，
  hub 仍按存档起在 19387 并认副机的 token。

### 验证

`config-persist-smoke` 9/9；plugcheck `tools=16 routes=13`；reload-smoke A/B/C；state-file
16/16；ui-guard 9/9；dispatch-recovery 76/76；board-server-smoke 17/17；acceptance 11/11。

### 仍未做

- 没查清是哪个宿主组件在重写 patch。下一步：启动时与 canonical 副本对比，缺块就恢复并
  在 doctor 里报错（比「靠人记得恢复」可靠）。

## v1.4.0 — 2026-11-09

运维自愈第一批：让「装没装上、跑没跑对」这件事有据可查，并且撞车时不再整机重启。

### 板子（`tools/board_server.py`，第一次进仓库）

- **权威副本进 git**：以前板子只存在于共享盘 `_tools`，改动不进版本库、CI 也测不到。
  现在仓库里的 `tools/board_server.py` 是源，部署用 `scripts/install-board.ps1`。
- **`/api/health` 带 `build`**：取源文件 sha256 前 12 位。v1.3.11 曾出现「以为 M1 已生效、
  实际旧进程还在服务」的误判；以后先看 `build` 对不对，再谈行为。
- **`scripts/install-board.ps1`**：哈希比较后复制（旧文件留 `.bak-<时间戳>`）→ 停监听端口的
  进程 → 清陈旧锁（锁里的 pid 还活着就拒绝）→ 从 `_dsh/board-tokens.txt` 读 token 启动 →
  25 秒内等 health → 校验 `version=4`、`build` 与源一致、`authTokens` 枚数、
  `singleInstance=true`。日志写 `_board/install-board.log`；支持 `-OnlyCheck` / `-DryRun`。
- **CI 跑板子 smoke**：`board-server-smoke.py` 默认指向仓库副本，Actions 用 Python 3.12 执行。

### 插件（`lib/index.js` / `lib/client.js`）

- **doctor + 面板红条**：新增 `/api/board/ui/doctor`（回环 + 自定义头保护），每 30 秒检查
  配置 token/machine、板子连通与新鲜度（>120s）、在线 worker、hub `/nodes`、降级路由数、
  调度器心跳（>max(30s, tick×5)）、暂停/报错状态。面板在有 error 时显示红条、只有 warn 时
  黄条，逐条给 message 与 hint。
- **路由注册幂等化**：撞 `duplicate route` 时只跳过那一条并记入降级列表（trace + doctor
  上报），工具、定时器、调度器照常启动；非 duplicate 的注册失败仍然整插件回滚。
  以前一次撞名会把 16 个资源全 rollback，只能整机重启（这周发生过两次）。
- **D6 账本收尾**：板子自己的 `reconcile_once` 先把任务标成终态时，`syncRemote` 的终态
  分支不会执行，账本条目以前要等 12h TTL；现在同步时先扫一遍板上终态任务并清账。
- 版本号从 `package.json` 读取并随 doctor 返回，便于对照「部署版本 ≠ 运行版本」。

### 测试

- `board-server-smoke.py` **17/17**（仓库副本，health 含 `build`）。
- plugcheck `tools=16 routes=13`（新增 doctor）；ui-guard **9/9**（doctor 外部 Host 403、
  回环 200）。
- reload-smoke 场景 A/B/D 全过：B 改为「降级加载不抛错、旧路由仍在、cleanup 不误删」，
  新增 D「doctor 单条撞名，其余 12 条照常注册」。
- dispatch-recovery **76/76**：新增 R25（板上已终态 → 账本条目被清，其它条目保留）。
- state-file 16/16；acceptance（fixtures）11/11。

### 部署

- 板子已用 `install-board.ps1` 实跑：旧 pid 43092 → 新 pid 15840，`build` 与源一致，
  `authTokens=1`、`singleInstance=true`。
- 插件仍需重启 DSH 才装载；热重载不会再让整个插件回滚，但旧实例的路由仍优先，doctor 会
  报 `routes` 降级——看到它就该重启，而不是以为已经生效。

### 仍未做

- 板子进程仍由脚本/计划任务守护，没有做成 Windows 服务；`install-board.ps1` 重启期间
  有 1–2 秒不可用（面板会短暂报错）。
- doctor 只做诊断，不自动修复（例如不会自己重启板子或重读配置）。

## v1.3.11 — 2026-11-09

安全修补第三批（复核清单里的 D6 / M1 / M2 / M4 / L2 / F10）。板子改动同样只在本机共享盘
`_tools` 那份权威副本里，git 只记录插件与测试。

### 插件（`lib/index.js`）

- **D6 跨 Host 回写护栏不再是死代码**：板子 `do_attach` 会把 `taker`/`holder` pop 掉，
  旧护栏 `t.taker` 在真板上从来没成立过。新增本机「远端任务账本」
  `remote-owners-<machine>.json`（12 小时 TTL）：attach 成功记 `{taskId, remoteId}`，
  `syncRemote` 发现板上的 `remote_id` 与本机记的不一致 → 判定被别的 Host 重派，跳过回写；
  写回终态后清账。
- **M4 板子地址 pin**：自动探测只在第一次做，成功后写 `<state>/board-url.json`，以后启动
  先试 pin（不再广播式问 `<host-pc>` / `<board-host>` / `127.0.0.1`）。要重新探测
  就设 `DSH_TEAM_BOARD_REPIN=1` 启动一次（或在状态目录删掉 `board-url.json`）。
- **F10 注释修正**：在线判定的心跳来自插件（`remoteSyncMs=6s`），不是计划任务
  `gp_presence` —— 那个任务从来没装过，注释与文档都不该那么写。

### 板子（`board_server.py`，部署在共享盘 `_tools`）

- **M1 身份校验**：`do_mark` / `do_release` 在任务已有 `machine` 时，**非回环**调用必须带
  `machine`（执行机）或 `holder`，否则 400 `identity-required`。以前「双方都提供才比较」
  意味着省略字段就能绕过 —— 持 token 者可关掉任意任务。`do_POST` 注入 `__client`
  供判断，本机 GUI/插件走回环不受影响。
- **M2 抗打**：连接 `settimeout(15)`（半开连接最多占 15 秒）；并发槽
  `BoundedSemaphore`（`GP_BOARD_MAX_CONN`，默认 32），满了回 `503 Busy`。
- **L2 大小上限**：`caps` 8 KB、`metrics.live` 4 KB（超了 413）、`seed` 单次最多 200 条、
  任务总数最多 5000。合并后的 caps 也卡 2× 上限。

### 测试

- `dispatch-recovery-smoke` **74/74**：R19 改成账本语义（板上 `remote_id` 被改写 →
  `mark=0`、板上状态不被覆盖）。
- `board-server-smoke.py` **17 项**：新增 L1（无 token 的 health 只有 `ok`）、M1（局域网
  匿名 mark/release 400、带 machine 放行）、L2（caps/metrics/seed 三个 413）。
- plugcheck `tools=16 routes=12`；reload-smoke A/B/C；state-file 16/16；ui-guard 7/7；
  acceptance（fixtures）11/11。

### 仍未做

- D6 的账本只覆盖「本机派过的任务」；从未由本机派过的任务不追踪（这是预期：本机本来
  就不该回写它）。
- M2 只限并发、不排队；L2 的 seed 上限是条数不是字节。
- 板子改动需要重启进程才生效（`board_server.py` 不在 git 里，部署说明见
  `docs/issue-10/08-exec-policy.md` §13.3）。

## v1.3.10 — 2026-11-09

安全修补第二批（上一轮复核里"能当场改代码"的 7 项），外加两处测试保真修复。

### 插件（`lib/client.js`）

- **D3 暂停失败不再继续归档**：以前宿主回 `paused:false` 或暂停接口 404 时，`paused`
  恒为 false 却继续 release —— 副机在跑、板上已 superseded，同步器也不再 watch 它（幽灵
  任务）。现在两次暂停都没成功就**直接中止**并给出可读提示。
- **D4 `runCleanup` 补 try/catch/finally**：任何一步抛错都不会再把 `cleanBusy` 卡在 true
  （按钮永久变灰），`finally` 里统一 `setCleanBusy(false)` 并尽力 `pauseDispatch(0)`。

### 板子（`board_server.py`，部署在共享盘 `_tools`）

- **F1 单实例锁按端口隔离**：锁文件名从 `state.json.lock` 改成 `state.json.<port>.lock` ——
  只按 state 路径加锁时，换一个 `--state` 就能再起一个进程绑同一端口。另加
  `BoardServer(ThreadingHTTPServer)`：`allow_reuse_address=False` + Windows
  `SO_EXCLUSIVEADDRUSE`，绑定失败打印「绑定 xxx 失败」并以 1 退出。
- **F3 机器名大小写归一**：`do_mark` / `do_beat` / `do_release` 两侧都过 `_canon_machine`
  再比 —— 以前 `GT14` 认领的任务，`gt14` 永远 409，客户端再也更新不了自己的任务。
- **F9 reconcile 失败不再静默**：扫描异常写入 `RECONCILE_ERROR` 并在 `/api/health`
  的 `reconcileError` 回显、stderr 打一行；恢复后自动清空。

### 脚本

- **F5 `team-hardening.ps1` 键级 upsert**：只改自己负责的 9 个键，`writeTimeoutMs` /
  `dispatchTickMs` / `unknownGraceMs` 等未被管理的键与注释原样保留（以前整块重写会静默丢掉）。
- **F7 `自驱.ps1` release 失败不再带走守护进程**：四处 `Invoke-BoardAction '/api/release'`
  收敛成 `Release-Task`，失败写 `_pending-releases.jsonl`，下一轮 `Replay-PendingReleases`
  自动补报；不再以码表外的 exit 1 退出。

### 测试

- `scripts/fake-board.mjs` 的 `/api/mark` 补上归属校验（以前完全不校验，D2 那类 bug
  在 smoke 里永远测不出来）：machine 规范化比较、holder 精确比较，均只在双方给值时生效。
- `dispatch-recovery-smoke` 新增 **R24**：待补绑任务归执行机（MB14）、调度器是 host，
  远端任务已消失 → 必须按执行机名 mark 成 failed 并清掉待补绑记录（**74/74**）。
- 新增 `scripts/board-server-smoke.py`：真板子契约测试 —— ①同端口不同 state 的第二实例
  必须拒绝启动；②`GT14` 认领后 `gt14` 可 beat/mark/release、`MB14` 仍 409。找不到板子
  脚本（CI 的 Linux runner）时跳过并 exit 0。

### 仍未做（下一轮）

D6（`syncRemote` 的 taker 护栏是死代码）、M1（mark/release 省略字段绕过归属）、
M2（无 socket 超时/并发上限）、M4（boardUrl 自动探测）、L2（caps/metrics 无上限）、
F10（`gp_presence` 计划任务仍不存在）。

## v1.3.9 — 2026-11-08

安全修补第一批（三专家复审的必改项 + 共享盘秘密清理）。这一版的目标不是"再加功能"，而是把
上一轮审计里能当场关掉的洞关掉，并把"令牌被写进日志"这条路一起堵上。

### 插件（`lib/index.js`）

- **D1 修掉 `HUB_TASKS_LIMIT` 的作用域 bug**：它原来只在 `reconcileUnknownDispatches` 的
  IIFE 里声明，`escalateExpiredJournal` 引用它会抛 `ReferenceError`，而 `escalateExpiredJournal`
  排在队列循环之前 —— 每 tick 都会把整轮派工打断，且日志只有一句 `dispatch loop error`。
  现在 `HUB_TASKS_LIMIT` 提到模块级，两份内联的"反查窗口是否覆盖发出时刻"判断合并成
  `hubWindowCoversTime(rows, since)`（D5 判据不一致一并修掉）。
- **D2 修掉多机部署的 mark 归属错**：`attachTask` 与 `retryPendingAttach` 的
  `/api/mark {status:'failed'|'blocked'}` 原来传 `machine: cfg.machine`（调度器自己的名字），
  而板子比的是执行机名字 ⇒ 多机部署必然 409、任务卡在 claimed、待补绑记录清不掉。
  现在分别传 `machineName` 与 `info.machine || cfg.machine`。

### 板子（`board_server.py`，共享盘）

- **入站与出口双重脱敏**：新增 `_SECRET_RULES` / `redact()` / `redact_obj()`，覆盖
  `nt_…`、`ghp_…`、`github_pat_…`、`sk-…`、`AQ.…`、独立 40 位十六进制与
  `x-board-token` 一类键值行。`/api/board` 出口整体过滤；`reconcile_once` 拼 note 前过滤；
  `say`/`create`/`mark`/`release`/`claim` 的文本在**写入边界**就过滤 —— 明文不再落进
  `state.json`，也就不会被镜像同步出去。
- **`/api/health` 公开面收敛**：无 token 只回 `{"ok":true}`，任务数、令牌枚数、版本、路由表
  这些侦察信息要带 token 才给（守护脚本只判 `ok`，不受影响）。
- **请求体与租约收敛**：`MAX_BODY_BYTES = 1 MB`（超限直接读空，不再把线程挂住）；
  `_minutes()` 把租约夹到 1–1440 分钟（负数会让任务立刻过期，非数字会把异常回显成 500）。

### 运维

- 共享盘 `_keys/gemini.txt`（明文 Google key）已移出共享盘，改放本机
  `%USERPROFILE%\.dsh\secrets\gemini.txt`（ACL 只给当前用户）；`setup-modlens.ps1` 的默认
  密钥路径同步更新。**密钥本身仍需到上游撤销重建**。
- 共享盘里的旧 `nt_…` 已替换为 `<nodeToken>`；新增 `_tools\scan-share-secrets.ps1`
  做日常扫描（真实令牌形状 → ERROR，字段名/占位符 → INFO）。

### 验证

`node --check` / plugcheck `tools=16 routes=12` / reload-smoke A-B-C / dispatch-recovery 71/71 /
state-file 16/16 / ui-guard 7/7 / acceptance 11/11（acc-11 1.09s）。
运行时：无 token `/api/health` → `{"ok":true}`；含假令牌的 `say` 文本在 `/api/board` 里显示为
`<redacted>`，原始串不出现。

### 仍未做（需要窗口/重启）

- 副机 `dispatchApproval` 是否改 `manual`（会中断自动派工，等用户拍板）。
- 板子 8965 的防火墙收窄到三台机器。
- 第 2 层：分档 token、任务级 claimSecret、exec 白名单、日志走 hub 不走共享盘。

## v1.3.8 — 2026-11-08

CI 修红。v1.3.6 的 acc-11 在本机是绿的、在 GitHub Actions 两个平台都是红的，原因是**两者跑在
不同的"身份状态"上**：

- `reportCaps()` 有个前置闸门 `identityState().assessed` —— 本机没做过评估就跳过上报，以免把
  一台没评估过的机器写进板子。本机 `~/.dsh-board/identity.json` 是早前评估留下的，所以 acc-11
  等上线瞬间就成功（0.84s）；CI runner 上没有这个文件，caps 永不发出，10 秒后报
  `本机迟迟没在板子上线（caps 没上报）`。
- 同样的问题也意味着 **acc-11 在本机是假绿的**：它测的不是"插件会自己上报"，而是"这台机器
  以前评估过"。

### 改法

1. `lib/index.js`：身份目录支持 `DSH_TEAM_IDENTITY_DIR` 覆盖（默认仍是 `~/.dsh-board`），
   验收才能在一个干净的"未评估"状态下跑。
2. `scripts/acceptance.mjs`：acc-11 把 `DSH_TEAM_IDENTITY_DIR` 指到临时目录，并显式调用
   `board_assess { force: true }` —— 这正是真部署里"新机器第一次上线"的路径，比等一个
   历史文件更接近现实。
3. 等上线的轮询从 40 次放宽到 60 次（15 秒），给慢 runner 留余量。

### 验证

| 检查 | 结果 |
| --- | --- |
| 本机有 `identity.json` 时 `node scripts/acceptance.mjs` | 11/11，acc-11 0.78s |
| **把 `identity.json` 移走**再跑（等价 CI） | 11/11，acc-11 1.11s |
| `plugcheck` / `reload-smoke` / `dispatch-recovery` / `state-file` / `ui-guard` | PASS / A+B+C / 71/71 / 16/16 / 7/7 |

## v1.3.7 — 2026-11-08

三方复审里**不需要重启**的那批。两条都是"别人能替我动手"的口子，先关掉。

### 修好的

1. **安全 F1 — 插件 GUI 的写通道没闸门（Critical）**：`/api/board/ui/*` 只抓 Cookie，不校验
   Host / Origin / 自定义头。任何能打到 `127.0.0.1:<GUI 端口>` 的页面都能建一条
   `mode=exec, dispatch=auto` 的任务，等于在所有副机上执行 PowerShell。现在每个 handler 前
   过 `uiGuard(req)`：Host 必须回环或在 `uiAllowedHosts`、带 `Origin` 时必须同源、非 GET 必须
   带 `x-dsh-team-ui: 1` + JSON Content-Type。面板自己（`lib/client.js`）已统一带上。
2. **F3/F9 — TTL 升级会用截断列表断言"远端没有"**：`escalateExpiredJournal()` 补上
   `absenceProvable()`（`/tasks` 未截断，或最老一条 `updatedAt` 早于 `sentAt - 5s`）；否则只做
   `blockRetryAt = now + 60s` 并留日志。同轮刚补绑成功的任务（`attachedThisRound`）不再被
   escalate 误标 blocked。
3. **B4 — 假板子语义向真板子对齐**：`take` 写 `taker`、`attach` 置 `running` + 刷 240 分钟
   lease + 清 `taker/holder/dispatch`、`mark` 加状态白名单且 `queued` 时清 `remote_id`。
   这几条之前让 `holderIsUs` / `takerIsUs` / 跨 Host 回写守卫在验收里全是零覆盖。
4. **脚本卫生（安全 F2 的后续）**：`team-hardening.ps1` 输出打码（以前把含 token 的整块配置
   打进 stdout，而 stdout 会落进共享盘 `_remote-logs`）；`_remote-logs` 里已有的两条明文已替换。
   `board_guard_keepalive.ps1` 探活改 `/api/health`（`/api/board` 要 token，401 会让守护每
   10 分钟被误杀）；`board-presence.ps1`、`自驱.ps1` 的读写都带 `x-board-token`。
5. **ACL（安全 F4/F5）**：`_tools` / `_board` / `_remote-logs` 不再继承
   `Authenticated Users:(M)`，显式只留本机所有者与共享盘服务账号可写、`Users` 只读执行；
   `C:\Users\Public\gp_*_hidden.vbs` 的 `INTERACTIVE/SERVICE/BATCH` 降到只读；
   `D:\gp_video\_tools\gp-daemon.ps1` 去掉 `Authenticated Users` 写权。

### 没做的（F11，判定为非缺陷）

`syncRemote()` 读 `t.taker` 做归属护栏，而 `do_attach` 会 `pop("taker")` —— 但 attach 之后任务
本来就归本机，护栏只在任务被别的 Host 重新认领（taker 被重新写上）时才需要，所以不改。

### 验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/ui-guard-smoke.mjs` | 7/7 |
| `node scripts/plugcheck.mjs` | PASS tools=16 routes=12 |
| `node scripts/reload-smoke.mjs` | 场景 A/B/C 全部通过 |
| `node scripts/dispatch-recovery-smoke.mjs` | 71/71 |
| `node scripts/state-file-smoke.mjs` | 16/16 |
| `node scripts/acceptance.mjs`（fixtures + 默认素材） | 10/10 + acc-11 |

### 还要重启才能做的

hub nodeToken 轮换（旧值在公开 git 历史里）、board token 再轮换（当前枚在 `_remote-logs` 里
出现过）、仓库历史清 token（filter-repo 强推或转 private + 撤 PR）。

## v1.3.6 — 2026-11-08

三方复审（代码审查 / 遗留系统 / 安全审计）后的第一批修复。**派工与同步共用闸门**是本版最重的一条：
它让"远端跑完了、板上永远收不到"变成随机现象，而验收恰好跑在绿的半边。

### 修好的

1. **B1 派工与同步互相饿死（Critical）** — `dispatchState` 拆成 `dispatching` / `syncing` 两个闸门。
   以前共用一个 `busy`，语义还是"忙就丢弃"：`dispatchTickMs === remoteSyncMs` 时两个定时器落在同一
   timers phase，dispatch 在第一个 `await` 让出时 `busy` 仍为 true，同一轮里的 sync 回调直接
   `return` —— 远端终态永远不回写。实测修前 `node scripts/acceptance.mjs` 三次两红
   （`acc-11 … 16.39s 同步回写没发生（板子 status=claimed）`），修后三次全绿（0.83s）。
2. **B2 真板子模式不再跑派工用例** — acc-11 在真板子模式下默认 `跳过`：它会建一条 `dispatch:auto`
   的任务并让它跑在真机上，而测试本身没有收尾职责。要真跑必须显式 `GP_ACCEPT_ALLOW_DISPATCH=1`。
3. **B3 "只派一次"现在有断言** — 假 hub 加 `GET /api/_test/stats`（`dispatchCount`/`remoteCount`/
   `remoteIds`），acc-11 在 done 之外断言"只派了 1 次、远端只留 1 条"。以前只看 `remote_id` 非空，
   重复派工留下最后一条也能过。
4. **F2 接管者删不掉记录（High）** — `journalDrop` 以前死认 `rec.holder`：接管者按"崩溃处理"
   拿到了处理权，却在这里被否掉，记录一路留到 TTL；之后每一轮都命中远端并重新 attach，板上
   done 被翻回 running、lease 无限续期。现在与 `holderUsable` 同一口径：超 `INSTANCE_TAKEOVER_MS`
   未更新才允许接管删除，并留一行 trace。
5. **F1 认领/澄清不看归属（High）** — `reconcileUnknownDispatches` 循环头加 `holderUsable`，
   `/api/untake`、`/api/mark` 全部带上 `machine` + `holder`。以前 untake 不带 holder，板子那层
   "双方都提供才比较"的校验直接放行，同机第二个实例能把别人在飞的 claimed 任务放回队列再派一条。
6. **板子 do_mark 校验归属** — 与 untake/release 同口径：传了就比对（`machine`、`holder`），
   传了但不匹配回 409；旧版插件不带这两个字段，行为不变。

### 还没修（按复审顺序，另起版本）

- F3 escalate 缺 `absenceProvable` 截断保护；F9 retry/escalate 同 tick 竞态；F8 observer/pause 仍写板子；
  F11 syncRemote 的 taker 护栏在主窗口失效（`do_attach` 会 pop taker）。
- B4 假板子仍与真板子有系统性偏差（take 不写 taker、attach 不置 running、mark 无白名单、永不 stale）。
- 安全 P0：`/api/board/ui/*` 未鉴权（可被页面 XSS/CSRF 借道 RCE）、board token 曾出现在共享盘
  `_remote-logs`、hub nodeToken 仍等于公开历史值、共享盘 ACL 允许 worker 改守护脚本、
   仓库历史仍含旧 token。

### 验证

| 套件 | 结果 |
| --- | --- |
| `node scripts/plugcheck.mjs` | PASS tools=16 routes=12 |
| `node scripts/reload-smoke.mjs` | 场景 A/B/C 全部通过 |
| `node scripts/dispatch-recovery-smoke.mjs` | 71/71 |
| `node scripts/state-file-smoke.mjs` | 16/16 |
| `node scripts/acceptance.mjs`（fixtures） | 10/10 + acc-11 |
| `node scripts/acceptance.mjs`（默认素材） | 10/10 + acc-11 |
| acceptance 连跑三次 | 三次全绿（B1 修前 2/3 红） |

## v1.3.5 — 2026-11-08

第四轮复核的**测试保真**项（F11/F12）：验收与回归里那套「假板子」和真板子在
taker / dispatch / lease 上系统性偏差，派工链路从来没有被验收覆盖过。

**① 派工链路进验收（acc-11）**

`scripts/fake-board.mjs` 现在同时当 remote-agent hub 的最小替身：实现了插件真正
调用的四个端点 —— `/api/remote-agent/ui/nodes`、`/tasks`（按 `?node=` 过滤、
`updatedAt` 倒序、`slice(0,200)`）、`/task`（找不到回 `404 {error:'task-unknown'}`）、
`/dispatch`（生成 `ui-fake-N`，状态 running）。另加一个验收专用
`POST /api/_test/remote-complete`，用来模拟「副机干完了」。

`scripts/acceptance.mjs` 在原来 10 条用例之后新增 **acc-11 派工链路**：第二次
`apply()` 打开 `autoDispatch`（独立状态目录 + `dispatchTickMs/remoteSyncMs=300`），
`board_dispatch` 建单 → 等板上 `remote_id` 出现（take→dispatch→attach 走完）→
模拟远端 completed → 等板子 `status==='done'`（syncRemote 回写）。任一环没发生
就判失败，并把原因写进报表。

**② 假板子与真板子对齐**

- `do_create` 以前把 `machine` 写成空串，真板子会把 `machine/owner/dispatch` 一起
  落下 —— 于是「指定机器建单」在假板子上等于没指，派工链路一测就露馅。
- 保持 v1.3.3 的 holder 语义：同机不同实例 → `409 held-by-other-instance`；
  `attach/untake/release{queued}` 清 `holder`，`untake` 与 `release{queued}` 清
  `remote_id`（复核 F8）。

**验证**

- `node scripts/acceptance.mjs`（默认素材）：11/11，acc-11 走完整条派工链路。
- `GP_ACCEPT_FIXTURES=1 node scripts/acceptance.mjs`：11/11（CI 用的就是这条）。
- plugcheck `PASS tools=16 routes=12`；reload-smoke A/B/C；dispatch-recovery 71/71；
  state-file 16/16。

**仍未做**：hub `nodeToken` 轮换（旧值已公开，需三台一起重启）；仓库历史里
`1068cab` 仍留着旧 nodeToken（转 private 或 filter-repo 重写历史）。

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
  `remote-agent` 那一行（hub，`<board-host>:19387`）丢了，包还在但插件没被加载。
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
