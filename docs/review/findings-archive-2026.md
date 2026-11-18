# findings 归档 2026

> findings.json 超过 8 KB 时把已修复项按时间追加到这里（只追加，不删）。

- v266-claim-holder [P1] ；v2.6.9 补齐 solo-board 与 old+new 两条路径（undefined，fixed）
- v266-get-csrf [P1] undefined（undefined，fixed）
- v266-approve-retry [P2] undefined（undefined，fixed）
- v266-alias-cjk [P2] undefined（undefined，fixed）
- v266-release-ghost [P2] undefined（undefined，fixed）
- v266-corrupt-state [P2] undefined（undefined，fixed）
- v266-redact-trace [P2] undefined（undefined，fixed）
- v266-python-probe [P3] undefined（undefined，fixed）
- v266-stop-abort [P2] undefined（undefined，fixed）
- v266-beat-reset [P2] undefined（undefined，fixed）
- v269-solo-holder [P0] solo-board claim/beat 校验并落 holder；S11 回归（OpenPangu-2.1-Pro VULN-001，fixed）
- v269-oldnew-claim [P0] 板子无 cur_holder 时 409；V266b 回归（OpenPangu-2.1-Pro VULN-002，fixed）
- v269-ui-untake-holder [P1] UI untake 带 INSTANCE_HOLDER（OpenPangu-2.1-Pro VULN-003，fixed）
- v269-terminal-archive [P3] mark/release 对终态任务无 holder 放行，UI 透传 machine（OpenPangu-2.1-Pro VULN-004，fixed）
- v269-alias-space [P3] _alias_key 保留空白（OpenPangu-2.1-Pro VULN-005，fixed）
- v269-redact-env [P3] redactConfig 覆盖 envPassthrough/passEnv（OpenPangu-2.1-Pro VULN-006，fixed）
- v269-uiguard-write-routes [P3] ui-guard 16 条写型动作路由（13 循环+3 定向）GET 拒绝 38/38（OpenPangu-2.1-Pro VULN-007，fixed）
- v269-trace-rotation [P3] trace 归档名 pid+时间戳，不再 unlink 他进程归档（hy4 P3，fixed）
