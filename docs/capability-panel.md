# 能力卡与双模式派工（v2.4 设计稿）

- 状态：草案（2026-11-13），未发布
- 范围：看板机器能力卡、派工模式（eco / boost）、成本可见
- 非目标：本文不改变现有派工协议；不改 `dsh-remote-agent`

## 1. 要解决的问题

现在看板只报“配置”（CPU/内存/磁盘/系统/ffmpeg/python/GPU），有三个缺口：

1. **看不出能干什么**：有 ffmpeg 不等于有 NVENC；装了 Chromium 不等于能无头渲染。
2. **Agent 不会用**：派工时只看到“机器 + 在线”，没有能力/模型信息，只能凭记忆猜。
3. **缺口不可见**：缺 Chromium、缺中文字体、缺 NVENC，要等失败才发现。

目标：每台机器一张结构化能力卡，供人、Agent、板子三方使用。

## 2. 能力卡 caps v2

### 2.1 schema

```jsonc
{
  "schema": 2,
  "identity": { "machine": "<worker-2>", "os": "Windows 11 26100", "cpu": "i5-14490F", "cores": 10, "threads": 16, "ramGB": 32 },
  "gpu": [{ "name": "GTX 1080", "vramGB": 8, "cuda": true, "tensorCore": false, "nvenc": ["h264", "hevc"] }],
  "tools": {
    "ffmpeg": { "version": "6.1.1", "path": "G:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
                "encoders": ["h264_nvenc", "hevc_nvenc", "libx264"] },
    "chromium": { "kind": "edge", "version": "157.0.4341.46", "headless": true, "webgl2": true },
    "node": "24.22.1", "python": "", "pwsh": "7.6.9"
  },
  "roles": [
    { "id": "transcode",       "level": "primary",          "bench": { "1080p_nvenc_fps": 282, "4k_nvenc_x": 2.34 } },
    { "id": "render-chromium", "level": "secondary",        "bench": { "fps_per_instance_1080p": 246, "parallel4_aggregate": 454 } },
    { "id": "model-inference", "level": "limited",          "note": "显存被常驻 llama-server 占用 7.5/8GB，不参与 eco 解析" }
  ],
  "models": [],
  "limits": { "vramFreeGB": 0.4, "ramFreeGB": 11, "workDiskGB": 1355, "netMBps": 104,
              "admin": false, "maxConcurrent": 3, "quietHours": "00:00-08:00" },
  "gaps": [
    { "tool": "python", "why": "只有 WindowsApps 存根", "install": "使用 DSH 便携 Python 或用户级安装" },
    { "tool": "cuda-toolkit", "why": "无 nvcc", "install": "如需编译 CUDA 扩展才装" }
  ],
  "bench": { "updatedAt": "2026-11-13T21:15:35+08:00" }
}
```

规则：

- `roles.level`：`primary` / `secondary` / `secondary-if-idle` / `limited` / `none`。`none` 必须写 `note` 说明原因。
- `limits` 是“能不能马上接活”的硬约束；`vramFreeGB`、`ramFreeGB`、`admin` 直接参与路由。
- `gaps` 是“缺什么 + 为什么 + 怎么补”，面板直接显示。
- `bench` 只放实测数字；没测就是空，不填估计值。
- 旧 caps 缺字段时按空处理，面板降级，不报错。

### 2.2 <worker-2> 已填（来源：`<worker-2>自答-20261113.md`）

- GPU：GTX 1080 8G，Pascal，无 Tensor Core；**NVENC 可用**（旧结论“no capable devices”已证伪）。
- 主职：ffmpeg 批处理/转码/硬编（1080p 9.3x、4K 2.3x、3 路并发）。
- 副职：无头 Chromium 逐帧渲染（Edge 157，WebGL2 走 ANGLE/D3D11，246fps/实例）。
- 限制：llama-server 常驻占 7.5/8GB 显存；1Gbps 链路（104MB/s）；非管理员；无 Python。
- 不接：模型推理派工（可手动停 8088 腾显存，需授权）。

### 2.3 <worker-1> 待补

需要一次只读“能力面试”：GPU 型号/显存、ffmpeg 编码器、Chromium/WebGL、磁盘、模型延迟与并发、空闲判定阈值。

### 2.4 空卡与“配置自检”

发布给别人的第一形态是**空卡**，不是手填表单：

1. 机器注册后只有身份（电脑名）与在线状态，能力卡为空；
2. 用户点「配置自检」，只读探测硬件/工具/模型端点，自动填卡；
3. 用户只做确认：角色（主职/副职/空闲可接/不接）、限制（并发/时段）、模型用途标签；
4. 高级用户仍可「手动填写」，但这是入口之一，不是默认路径。

约束：探测只读、不提权、不安装、单步超时；任何一项失败都不阻塞保存（见 2.7）。

### 2.5 模型清单与用途标签（独立一页）

模型多起来后（<worker-1> 已有 6 个），把“模型与用途”从确认页拆成独立一步：

```jsonc
"models": [
  {
    "id": "qwen35-9b",
    "endpoint": "http://127.0.0.1:8080/v1",
    "ctx": 32768,
    "modalities": ["text"],
    "tags": ["code-review", "summarize", "fast-chat"],
    "measured": { "tps": 18, "firstTokenMs": 900 },
    "source": "bench",          // bench | declared | guessed
    "loaded": false,
    "note": ""
  }
]
```

- 标签是**给对话 Agent 看的**：`code-review` / `code-gen` / `vision` / `summarize` / `fast-chat` / `embedding` / `translate`，可增删；
- 标签来源：端点元数据 > 名称保守猜测 > 最小 smoke；分别标 `bench / declared / guessed`；
- 用户可改标签、可手动加“端点 + 模型 id”，必须探活通过才生效（标 `declared`）；
- 同一张卡同一时间通常只能加载一个模型：记 `loaded` 与显存余量，派工前检查。

### 2.6 对话 Agent 的契约（最重要）

看板工具必须让对话 Agent 直接看懂“哪台机器、哪个模型适合什么”：

- `board_options` 返回每台机器的 `models: [{ id, tags, ctx, source, loaded }]`，并给 `recommendedFor` 摘要；
- `board_dispatch` 支持 `taskKind`（`review` / `vision` / `summarize` / `chat` / `transcode`…）：
  - 用户没说模型时，按 `taskKind → tags → ctx/loaded` 自动选，并把 `routeReason` 写回任务；
  - 用户指定了就用用户的，但仍校验模型存在与探活状态；
- 对话里默认**少问**：能自动选就自动选；只有“高风险 + 目标机只有未验证模型”这种冲突才让用户拍板。

### 2.7 部分失败：允许先保存，标红待修

自检不要求全绿：

- 探测失败的项写 `status: "missing"` + `error`，卡片标红/标黄；
- 用户仍可「保存并发布」，但该机器在对应角色上**不参与派工**（fail-closed）；
- 面板显示「待修：N 项」，点开是修复建议（装 Python / 启动模型端点 / 加白名单）；
- 只有“身份/必需工具”缺失（例如 ffmpeg 都没有却声明转码主职）才阻止保存，并说明原因。

### 2.8 自主权与覆盖

1. 自动探测结果**全字段可改**；改过的字段标 `source: "manual"`，探测原值保留，可「恢复为探测值」；
2. 高风险任务默认只认 `bench` / `declared` 且角色匹配；
3. 每台机器有显式开关「允许高风险任务使用未验证/自建模型」，默认关闭；
4. 打开开关需一次风险确认；之后走该开关的任务写 `policy: "user-override"`，可追溯；
5. 边界不放开：不自动安装/提权；eco 不可达暂停让用户选；发布门强制 boost 双审，不受该开关影响。

## 3. 面板

四个步骤，前两步自动，后两步只做确认：

1. **空卡**：身份 + 在线状态 + 「配置自检」/「手动填写」；
2. **自检中/结果**：逐项打勾，失败项标红并给修复建议，进度可见；
3. **角色与限制**：主职/副职/空闲可接/不接；并发、可跑时段；高风险开关放在本页底部（不收起）；
4. **模型与用途**（独立页）：模型清单、标签、实测值/来源、手动加端点；标签可改。

发布后机器卡显示：显示名 + 身份名、角色徽章、能力行、模型摘要（前 3 个 + 总数）、待修项、改名/移除/重新自检。

Agent 读同一份数据（`board_caps` / `board_options` 扩展），不另建一套。

## 4. 双模式派工（eco / boost）

### 4.1 定义

- `eco`（低 Token）：优先本地模型，用于低风险、窄范围检查；
- `boost`（高效）：云端强模型，用于发布门与高风险任务。

任务只存 `mode`，派工时按目标机模型清单**解析**成具体 `provider/model`，并把结果与理由写回任务（`model`、`routeReason`）。

### 4.2 硬规则

1. **发布门强制 boost**：安全审计、代码审查、发布前复审一律 `boost`，调用方不能覆盖。这是硬编码规则，不依赖默认值。
2. **eco 端点不可达 → 暂停并给用户选择**（重试 / 改 boost / 取消），不静默切云。
3. **eco 仅限窄检查**：单函数/单文件 diff、密钥扫描、文档摘要；超出范围提示升级 boost。
4. **决策入任务**：`mode`、`model`、`routeReason` 落库，便于追责与成本统计。

### 4.3 eco 的实测边界（2026-11-13）

同一台 <worker-1>（qwen35-9b / qwen36-35b）、同一段有 bug 的 v2.3.0 代码：

- **宽范围**（14KB diff，问“审这段代码”）：qwen35-9b 报了一个误报（`AbortSignal.timeout` 不被 Node 支持），**漏掉真 bug**；结论不可用。
- **窄范围**（3.3KB 片段，只问“新任务能被派发吗、缺什么字段”）：9B 与 35B **都正确**指出缺 `dispatch:'auto'`，9B 置信度 1.0。

结论：eco 可用，但必须满足：

- 一次只问一个问题；上下文 ≤ 8KB，超了先切分；
- 明确要求 JSON 输出；`temperature=0`；`max_tokens ≥ 2500`；
- 关闭思考（`chat_template_kwargs.enable_thinking=false`），否则 token 会耗在 reasoning 上；
- 结果必须可机检（字段/枚举），不采信自由文本结论。

## 5. 落地计划

| 版本 | 内容 | 验收 |
|---|---|---|
| v2.4.0 | caps v2（含 models/roles/limits/gaps）、空卡 + 配置自检探测（硬件/工具/模型端点）、四步面板（空卡→自检→角色限制+高风险开关→模型与用途独立页）、部分失败可保存标红、`board_caps`/`board_options` 返回模型标签与 `recommendedFor` | <worker-2>/<worker-1> 空卡能自动填；<worker-1> 六个模型标签正确；失败项可保存但该角色不派工；旧数据不报错 |
| v2.4.1 | `taskKind` 路由 + eco/boost 双模式 + 发布门强制 boost + 不可达暂停 + `routeReason` 入任务 | 单测覆盖四种分支；发布门 eco 被拒；对话 Agent 不指定模型也能按标签选中正确模型 |
| v2.4.2 | `board_bench`（ffmpeg 10s、Chromium 30 帧、模型 tokens/s、视觉 smoke）+ 成本/耗时入账 + `bench` TTL 过期降级 | 面板显示实测值与“未测”；30 天后自动降级并提示复测 |

每一步仍走发布门：安全审计 → 代码审查 → 自检 → 才可推。

## 6. 未决

- <worker-1> 是否安装 `@deepseek-ai/dsh-llm-pi-ai`（装则需重启）。当前选 A：先不装，eco 用脚本直连网关。
- <worker-2> 的 llama-server 是否允许在批处理前临时停掉（腾 7.5GB 显存）。
- 成本口径：云按 usage token 估算，本地按耗时 × 折算系数，二者如何统一展示。
- 标签词表是否再扩（目前 7 类），以及“多标签冲突”时的优先级。
- 手动加端点的探活超时与重试次数（默认 3 秒 / 1 次）。
- 空卡首次进入是否强制自检：当前设计为“可跳过、但保存前提示”，是否改为强制。
