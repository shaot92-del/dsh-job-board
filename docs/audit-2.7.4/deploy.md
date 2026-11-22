# 2.7.4 部署与安装记录

- 目标版本：**2.7.4**（HEAD `c8e7597`，tag `v2.7.4` 已推）
- 包：`wfcj-dsh-job-board-2.7.4.tgz`，**1,510,274 B**，SHA256 `3E84204333A49A3AA7D4DCA6A0B8FB063D72D0360B78383780F6FE076DE0250F`（`L:\云盘\gp_video_xfer\_tools\dsh-job-board\`）
- 包内容：108 文件（含 `install-manifest.json`），unpacked 2,882,398 B（`pack-check` 实测）

## 本机 profile（desktop / zzc）

| profile | installed | 运行态 | 需要 |
|---|---|---|---|
| desktop | 2.7.4 | 2.7.3 | **重启 DSH** |
| zzc | 2.7.4 | — | 下次启动即 2.7.4 |

验证命令：

```powershell
# 端口以实际监听为准
$p = 2315
Invoke-RestMethod "http://127.0.0.1:$p/api/board/ui/doctor" | Select version, installedVersion
# 期望：version=2.7.4 installedVersion=2.7.4 updateAvailable=false
```

## GT14 升级（U-1 闭合）

在 GT14 上双击 `Z:\_tools\dsh-job-board\upgrade-worker.cmd`：代停 DSH → 原子装 2.7.4 → 自动重启 → 弹窗报「版本 + 写通道已开/未开」。

装完核对：

```powershell
Invoke-RestMethod "http://127.0.0.1:<port>/api/board/ui/doctor" | Select version
```

## 回滚

1. 上一版：`v2.7.3`（tag 已推，tgz 在共享盘）。
2. 本机回退：`rollback-gt14.ps1`（改目录名 + 恢复配置）；或重新解包上一版 tgz 覆盖 `node_modules/@wfcj/dsh-job-board` 后重启 DSH。
3. npm 若已发布：`npm deprecate "@wfcj/dsh-job-board@2.7.4" "<原因>"`，再发 2.7.5 覆盖 `latest`。