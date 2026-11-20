# 2.7.1 部署与回滚记录

## 1. 部署目标与核对（2026-11-20 23:59）

| profile | 路径 | package.json | `lib/client.js` |
|---|---|---|---|
| desktop | `C:\Users\17827\.dsh\profiles\desktop\node_modules\@wfcj\dsh-job-board` | **2.7.1** | 183,915 B |
| zzc | `C:\Users\17827\.dsh\profiles\zzc\node_modules\@wfcj\dsh-job-board` | **2.7.1** | 183,915 B |

**运行态核对**（`GET http://127.0.0.1:4939/api/board/ui/doctor`，2026-11-20 23:59）：

```json
{"ok":true,"version":"2.6.29","installedVersion":"2.7.1","latestVersion":"2.7.1",
 "role":"owner","machine":"host","board":"http://127.0.0.1:8965",
 "checks":[{"id":"version-skew","level":"warn","message":"运行 v2.6.29，磁盘已安装 v2.7.1"}]}
```

⇒ **磁盘已是 2.7.1，进程内仍跑 2.6.29；必须重启 DSH 才生效。** 面板上会看到「插件 v2.6.29 → 磁盘 v2.7.1」的 skew 提示，属预期。

端口现状：`4939`（DSH GUI/板子路由，PID 28120）、`8965`（板子 HTTP，PID 19804）、`19387`（hub，PID 28120，监听 192.168.3.40）。DSH 每次重启 GUI 端口会变，**核对时先找 4939/新端口，不要写死**。

## 2. 生效步骤（用户操作）

1. 完全退出 DSH（含托盘/后台进程）。
2. 重新启动 DSH。
3. 打开「多机调度台」面板，确认顶部 pill 显示 **v2.7.1** 且无 skew 提示。
4. 点一次「派工」：应弹出派工框、**模型下拉可见**（自动档按 location 分组；单机档只列该机模型），不再白屏。
5. 控制台（DevTools，先开 Preserve log）应无 `React #130` / `slot entry crashed`。

## 3. 回滚路径

### 3.1 回滚到 2.6.29（稳定版）

```powershell
# 用上一版 tgz 解包内容覆盖两个 profile（示例路径按实际包名调整）
$tgz = 'L:\云盘\gp_video_xfer\_tools\dsh-job-board\wfcj-dsh-job-board-2.6.29.tgz'
$tmp = Join-Path $env:TEMP 'rollback-2629'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
& C:\Windows\System32\tar.exe -xf $tgz -C $tmp
foreach ($p in @('C:\Users\17827\.dsh\profiles\desktop','C:\Users\17827\.dsh\profiles\zzc')) {
  $dst = Join-Path $p 'node_modules\@wfcj\dsh-job-board'
  & C:\Windows\System32\robocopy.exe (Join-Path $tmp 'package') $dst /MIR /NFL /NDL /NJH /NJS | Out-Null
}
# 重启 DSH 后核对：doctor 的 version 应为 2.6.29
```

### 3.2 回滚到 2.7.0（不建议：带 #130 缺陷）

```bash
npm deprecate '@wfcj/dsh-job-board@2.7.0' "点「派工」白屏（React #130），请使用 2.7.1"
```

### 3.3 仅回退 client（保留服务端新版）

把 `node_modules\@wfcj\dsh-job-board\lib\client.js` 换回上一版同名文件即可；`lib/client.js.270-crash.bak` 是 2.7.0 崩溃版备份，**不要**用它回退。

## 4. npm 侧状态

| 项 | 值 |
|---|---|
| `dist-tags.latest` | `2.7.0`（**有 #130 缺陷，待 deprecate**） |
| `2.7.1` | 已在仓库打 tag 并推送，**未发布** |
| 发布命令（待用户点头） | `npm publish --noproxy '*' --userconfig "$env:TEMP\npmrc-271"` |
