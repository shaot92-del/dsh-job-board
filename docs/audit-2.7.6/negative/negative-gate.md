# 负向门禁（v2.7.6）

## N-1 旧版崩溃 bundle 必须 FAIL（UI 渲染严格化不回退）
命令：
  SMOKE_BUNDLE=C:\review\case\lib-client-2.7.0-crash.bak node scripts/client-render-smoke.mjs
结果：exit=1，FAIL（含 Minified React error #130）。证据：coverage/smoke-client-crash-bundle.log

## N-2 公钥必须是 Ed25519 SPKI（P2-3）
命令：
  pwsh -File scripts/enable-maint-write.ps1 -PublicKey ('A' * 44)
结果：exit=2，输出「公钥不是 Ed25519 SPKI（DER 里找不到 OID 1.3.101.112）」——不再接受“长得像公钥的垃圾”。

## N-3 合法公钥仍能进入写入计划（同一脚本）
命令：
  pwsh -File scripts/enable-maint-write.ps1 -Profile desktop -PublicKey 'MCowBQYDK2VwAyEA…'
结果：exit=2（因为本机 DSH 正在运行，脚本拒绝热改），但已打印计划：
  add maintenanceWriteEnabled: true
  add maintAuthPublicKeys: ['MCowBQYDK2VwAyEA…']
⇒ 校验层通过、写盘层按安全默认值拒绝，符合设计。

## N-4 票据验签负向（去偶发后仍可复现）
命令：node --test test/worker/maint-ticket-cli.test.mjs
结果：21/21 通过，含 badsig / wrongmachine / payload-mismatch / expired 四类负向用例。