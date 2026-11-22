# v2.7.7 变更与签核（Host 侧回板路径脱敏）

> 基线：v2.7.6 / `f7e5f47`（定向复审 PASS 的那一版，未部署）。
> 本版只修 2.7.6 定向复审 §6「已排除项 #1」记录的既有同类缺陷：**Host 侧回板路径没有打码**。

## 1. 缺陷与修法

| 项 | 内容 |
|---|---|
| 路径 | 副机任务终态 → Host `syncRemote` 读回 `logs` → `parseDshResult()` → `POST /api/mark` |
| 原状（v2.7.6） | `lib/index.js:202` `j.reasons.slice(0,5).map(x => String(x).slice(0,120))` —— **无 mask**；`:3000` note 的 `detail` 直接 `slice(0,200)` —— 同样无 mask |
| 后果 | 副机 stdout 里出现的 board token / 家目录原样进 `mark.result.reasons` 与 `mark.note` ⇒ 看板与面板可见 |
| 修法 | `lib/worker/result.js` 新增 `maskReasons()` / `maskDetailText()`：**先 mask 再截断**（顺序反了会把跨边界 token 切成残片，与 2.7.6 修的 worker 侧同类缺陷同因）；`parseDshResult(text, maskOpts)` 透传 `{secrets:[cfg.token], home:os.homedir()}`，detail 改走 `maskDetailText(..., {max:200})` |
| 不变 | board `_clean_result` 契约（reasons ≤5、每条 ≤120）、note ≤400 字符；worker 侧 2.7.6 修复原样 |

## 2. 测试（新增 4 条，`test/worker/result.test.mjs`）

1. 跨 120 边界 token：打码后 ≤120，且 token 与其 12 字符前缀残片都不出现。
2. 最多 5 条、过滤空串、非数组返回 `[]`。
3. 家目录打码（`C:\Users\<name>` 不落板）。
4. `maskDetailText`：打码 + 换行拉平 + 200 截断，token 跨 200 边界不漏。

## 3. 门禁

- `npm run gate`：check-text PASSED、plugcheck `18 tools / 28 routes`、client-render-smoke 65/65、单测 **478/478**、pack-check **108 文件 / 1,520,198 B**。
- 产物：`wfcj-dsh-job-board-2.7.7.tgz`（1,520,198 B，sha256 `4ef3503599a47e8cd1af5aee63ebdae224da6219d59241844d460bf489ef9801`）。
- 提交：`90ed9d1`（修复）→ `5ef3abd`（安装脚本默认包名 2.7.7）；tag `v2.7.7` 指向 `5ef3abd`。

## 4. 部署状态

| 位置 | 状态 |
|---|---|
| desktop / zzc profile | **已装 2.7.7**（109 文件，安装器复核通过），`doctor` 显示 `installedVersion=2.7.7`、`version=2.7.5`（**待重启生效**） |
| GT14 | 仍 2.7.4（本轮未动），待跑 `Z:\_tools\dsh-job-board\upgrade-worker.cmd`（默认包名已指 2.7.7） |
| npm | **未发布**（等用户点头 / 2FA） |
| GitHub | main=`5ef3abd`、tag `v2.7.7` 已推 |

## 5. 已知未覆盖

- 本版未做独立第三方复审（2.7.6 的 PASS 只覆盖到 `f7e5f47`）；如需，按 `docs/audit-2.7.6/pangu-rereview-276-brief.md` 的同一格式只核本版 delta（3 个文件 + 1 个测试文件）。
- `scripts/deploy/` 不在 npm 包 `files` 里（安装/升级脚本走共享盘分发），因此 tgz 内不含这两个脚本的默认包名改动。