# 2.7.12 负向门禁（重启助手脚本层）

## 1. UI 侧（沿用 2.7.4 的崩溃包）

```
$env:SMOKE_BUNDLE='C:\review\case\lib-client-2.7.0-crash.bak'; node scripts\client-render-smoke.mjs
→ exit=1，FAIL 24/51（含 Minimized React error #130 同型）
$env:SMOKE_BUNDLE 清空; node scripts\client-render-smoke.mjs
→ exit=0，PASS 65/65
```

## 2. 重启助手脚本（本轮 P0/P1 的对应负向用例）

`test/worker/maint-verbs-restart-script.test.mjs` 两条真跑 pwsh：

- **N-1 路径不展开**：exe 路径含 `'` 与 `$(Get-Date -Format yyyy)` → 日志必须原样记录，不得出现被替换的年份；exe 不存在 ⇒ `exit 1`。
- **N-2 换目录失败不动源**：目标父级是文件 ⇒ `Remove/Move` 失败 ⇒ `restart-failed` + `exit 1`，且 `<stage>/new.txt` 仍在（不许被挪成目标的子目录）。

旧实现（2.7.11 的 builder）在这两条上都会失败：N-1 日志里出现年份、N-2 源目录被挪走。

## 3. 常规门禁

`npm run gate` → check-text PASSED、plugcheck 18/28、smoke 65/65、单测 **489/489**、pack-check **109 文件 / 1,530,798 B**。