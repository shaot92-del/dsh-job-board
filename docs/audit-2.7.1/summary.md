# 2.7.1 发版审查记录

> 状态：**进行中**（等三方规范章节合并后补 §2 全量审计与 §3 UI 矩阵）
> 版本：`2.7.1`　commit `76c50e6`　tag `v2.7.1`（已 push，**npm 未发布**）

## 结论

尚未签核。当前已完成项见下表；未完成项标 ⏳。

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 1 | 全量审计（新会话） | ⏳ 待合并三方规范后执行 | `full-audit.md` |
| 2 | UI 渲染证据链 | 部分（严格冒烟 29/29；“修复前 FAIL”已取证） | `negative-gate.txt` |
| 3 | 可用性走查（七条路径 + 数据翻转） | ⏳ | `usability.md` |
| 4 | 门禁全绿 | ✅ 2026-11-20 23:59 | `gate.log` |
| 5 | 三处版本一致 | ✅ plugcheck PASS（tools=18 routes=28） | `gate.log` |
| 6 | 包内容核对 | ✅ 105 文件 / 1,490,543 B | `gate.log` |
| 7 | 部署一致性 | ✅ desktop/zzc 已装 2.7.1（**需重启 DSH**） | `deploy.md` |
| 8 | 重启提示 | ✅ 已告知用户 | 会话记录 |
| 9 | 回滚路径 | ✅ 目标 2.7.0 → 回 2.6.29 或修到 2.7.1 | `deploy.md` |

## 门禁摘要（2026-11-20 23:59）

```
check-text   PASSED（128 文件）
plugcheck    PASS name=@wfcj/dsh-job-board tools=18 routes=28
smoke:client PASS 29/29
npm test     448/448  pass，fail 0，duration 6902 ms
pack-check   PASS — @wfcj/dsh-job-board@2.7.1，105 文件 / 1490543 B
```

## 负向门禁摘要

| 变体 | 结果 | 关键输出 |
|---|---|---|
| 崩溃版 `case/lib-client-2.7.0-crash.bak` | **FAIL 3/26，exit=1** | `Minified React error #130: … but got: object` |
| 修复版 `lib/client.js`（2.7.1） | PASS 29/29，exit=0 | — |

完整命令与输出见 `negative-gate.txt`。

## 未决项

1. 三方规范章节合并（§2 盘古/Kimi、§3§5 GLM、§4 盘古）→ 合并后跑一次全量审计并回填 `full-audit.md`。
2. 生产宿主 click-through（重启 DSH 后由用户或主控执行，DevTools 开 Preserve log）。
3. `npm deprecate @wfcj/dsh-job-board@2.7.0` 与 2.7.1 发布待用户点头。

## 复跑方式（一条命令）

```powershell
node scripts/audit-collect.mjs --version 2.7.1 --base v2.7.0 --crash-bundle 'C:\Users\17827\Documents\dsh-job-board-2.7.0-crashcase\case\lib-client-2.7.0-crash.bak'
```

产出：scope/（base/HEAD、变更文件、零上下文 diff）、coverage/*.log（逐命令输出）、commands/{commands.json,results.jsonl}（命令+退出码）、
egative/README.md（崩溃版必须 FAIL 的判定）、counterproof/{paths.json,summary.json}（反证清单骨架，需人工逐条填 status）。
加 --coverage 额外产出 V8 coverage（coverage/raw/）。