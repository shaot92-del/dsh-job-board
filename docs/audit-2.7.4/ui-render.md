# 2.7.4 UI 渲染证据链（评估卡两故障）

结论：**旧包 FAIL / 新包 PASS**；两条渲染崩溃路径（React #130 与 ident=null 取值）都由严格冒烟钉住。

## 1. 负向门禁（旧包必须 FAIL）

```bash
SMOKE_BUNDLE="C:/review/case/lib-client-2.7.0-crash.bak" node scripts/client-render-smoke.mjs
# 实测：exit=1，15/40 FAIL，含
#   Minified React error #130: expected a string (for built-in components) or a class/function
#   (for composite components) but got: object
```

修复版：

```bash
node scripts/client-render-smoke.mjs
# 实测：exit=0，51/51 PASS
```

## 2. 静态锚点（scan-h-type）

```bash
node scripts/client-render-smoke.mjs --scan-only   # 新包：0 违规 exit 0
# 旧包（crash.bak）：1 违规（h(h(...)) 嵌套）exit 1
```

## 3. 本期 UI 改动（v2.7.1–v2.7.4）

| 项 | 内容 | 证据 |
|---|---|---|
| 故障 A（本机评估卡挂住） | 状态机 idle/loading/success/error；AbortController + 15s 超时；error 卡重试、loading 卡取消 | smoke 4-1..4-7；Pangu stage3b PASS |
| 故障 B（每次进面板重新评估） | localStorage `dsh-assess-done-v1` 兜底（7 天 TTL + capsDigest 比对） | smoke 静态锚点；MC-1 |
| ident=null 能力条 | `assessCaps` + `capsForBar` 派生，三分支占位 | smoke 4-7；MC-4 补强 |
| 二段 /identity 失败 | 不覆盖 success，静默保留兜底 | MC-3；smoke 断言 |

## 4. 外部复核链

`review.md`（stage1 BLOCKED）→ `review-stage2.md`（FAIL，2 P0 + 2 P1）→ `review-stage3.md`（FAIL，MC-4 半截）→ `review-stage3b.md`（**PASS**，四问全过、指纹 3/3 匹配）。