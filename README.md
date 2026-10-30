# dsh-team

把「团队 · 作业板」接进 DSH 的单包插件。一个包装齐四件事：

1. **12 个 `board_*` 工具** —— agent 能查板、建单、认领、续租、交付、打回、播报、派工、上报能力。
2. **4 个 `sh_*` 工具** —— `sh_run` / `sh_read` / `sh_write` / `sh_list`。副机 worker 会话默认没有
   pwsh / read / write，这四个把能力补上（这是从 dsh-shell 合并进来的部分）。
3. **GUI 面板** —— 侧栏「作业板」：任务表（筛选/搜索/展开详情/认领/交付/打回）、机器能力卡、
   一行派工、桌宠状态卡（可拖动、可拿捏尺寸）。
4. **Host 路由** —— `/api/board/ui/*`，浏览器不直接跨网访问板子服务。

## 装

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 本地开发版
& $dsh plugin --profile desktop add 'file:D:\gp_video\dsh-team'

# 从 GitHub（装别人的/你自己的这份）
& $dsh plugin --profile desktop add 'github:shaot92-del/dsh-team'
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 有 `dsh-team` 这一行，
然后重启 DSH（Host 半边改动只有重启才生效；只改 `lib/client.js` 的话刷新页面即可）。

> **它需要一个板子服务。** 本插件是客户端，数据来自一个 HTTP 任务板
> （`GET /api/board`、`POST /api/claim|beat|release|create|attach|seen|mark` …）。
> 仓库不含该服务；默认地址 `http://127.0.0.1:8965`，可用 `boardUrl` 指向你自己的实现。
>
> **远程派工还依赖 `dsh-remote-agent`。** 本包负责「建单/选机/绑定/回写状态」，
> 真正的传输、回执、产物清单是 remote-agent 的职责。

## 工具

| 工具 | 干什么 |
|---|---|
| `board_status` | 总览：待办/进行/完成/打回计数、机器在线、最近事件 |
| `board_list` | 列任务，可按 `status` / `machine` 过滤 |
| `board_claim` | 认领（挂到配置的 `machine` 名下） |
| `board_beat` | 续租 + 写进度备注 |
| `board_done` | 交付（可带 `artifact`） |
| `board_fail` | 打回（`blocked`）/ 失败（`failed`），必须写原因 |
| `board_say` | 往事件流播报一句 |
| `board_dispatch` | 选机 + 建单（`dryRun` 只预览），返回下一步给 `remote_task` 的参数 |
| `board_attach` | 把远程任务号绑到板子任务，状态转 running |
| `board_caps` | 看某台机器上报的配置清单 |
| `board_assess` | 本机工作能力评估（写 `~/.dsh-board/identity.json` 并上报板子） |
| `board_metrics` | 各机器实时指标（内存/CPU/磁盘/运行时长） |
| `sh_run` | 执行命令（Windows 用 pwsh，失败回退 powershell） |
| `sh_read` | 读文本文件 |
| `sh_write` | 写文本文件（UTF-8 无 BOM，自动建父目录） |
| `sh_list` | 列目录 |

## 面板

侧栏「作业板」→ 主面板。数据走 Host 半边的 `/api/board/ui/*`。

- 8 秒自动刷新；`A+` 调字号（16/18/20px，存 localStorage）
- 行可展开：状态/机器/更新时间/进度/产物；展开后可填产物路径与备注，直接「交付」或「打回」
- 机器卡：在线状态、能力徽章、内存/CPU/磁盘、最近上报时间
- 桌宠：可拖、双击换尺寸、右键折叠成小条；立绘由 `/api/board/ui/pet.png` 提供

## 配置

写在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: team
  config:
    boardUrl: 'http://127.0.0.1:8965'
    machine: 'host'          # 副机改成 gt14 / mb14 / pc2
    token: ''                # 板子加鉴权时填
    petImage: ''              # 留空=用随包立绘 assets/pet.png
    allowedRoots: []         # sh_* 的沙箱根目录，空=不限制
    shellTimeoutMs: 120000
    maxOutputBytes: 200000
```

## 自检

改完代码、装进 DSH 之前先跑：

```powershell
node scripts/plugcheck.mjs
```

断言：`apply()` 不抛异常、16 个工具齐备、每个 `output.render` 返回 `[{type:'text',text}]`
（裸字符串会毒化会话历史 —— 2026-10-27 这么崩过两次）、三条 GUI 路由存在。

## 许可

MIT。
