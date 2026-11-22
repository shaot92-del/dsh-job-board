# 负向门禁（旧版必须 FAIL）

- bundle: `C:\review\case\lib-client-2.7.0-crash.bak`
- 命令: `$env:SMOKE_BUNDLE='C:\review\case\lib-client-2.7.0-crash.bak'; node scripts/client-render-smoke.mjs`
- 实际 exitCode: 1（期望非 0）
- 判定: PASS（旧版确实失败）
- 日志: `coverage\smoke-client-crash-bundle.log`
