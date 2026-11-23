# v2.7.15 签核摘要（agent 默认 cwd 落在 agentCwdRoot）

> 事故来源：真机 2.7.14 上 D3–D7 全部 `agent-cwd-denied why=outside cwd=<家目录> root=<根>`。
> 根因不是 `%VAR%` 没展开（已用 `expandPathSpec` 单测证明展开正常），而是**默认 cwd 选错**。

## 1. 根因

`lib/worker/agent-runner.js` 旧实现：

```js
const cwdRaw = spec.cwd ? expandPathSpec(spec.cwd) : os.homedir();
const cwd = path.isAbsolute(cwdRaw) ? cwdRaw : os.homedir();
```

任务不带 `cwd` 时固定回落到 `os.homedir()`；而 `agentCwdRoot` 常配成 `<家目录>\Documents`（GT14 就是 `%USERPROFILE%\Documents`）⇒ 默认 cwd 天然落在根之外，**整类 agent 任务在 cwd 门被拒**，外面看起来像「配了根反而全被拦」。

## 2. 修法

```js
const rootSpec = config.agentCwdRoot ? expandPathSpec(config.agentCwdRoot) : '';
const cwdGiven = String(spec.cwd || '').trim();
const cwdRaw = cwdGiven ? expandPathSpec(cwdGiven) : (rootSpec || os.homedir());
const cwd = path.isAbsolute(cwdRaw) ? cwdRaw : (rootSpec || os.homedir());
```

- 不给 cwd：默认落在 `agentCwdRoot` 本身（展开后），取不到才回落家目录。
- 给了 cwd：行为不变（仍展开 + 绝对化）。
- cwd 门比较与回执 `root=` 改用 `rootSpec`（此前回执可能显示字面量 `%USERPROFILE%\Documents`，看起来像展开失败）。

## 3. 新增测试（`test/worker/agent-runner.test.mjs`）

1. `run：不给 cwd 时默认落在 agentCwdRoot 内（root=家目录\Documents 也放行）` — 断言 `reason !== 'agent-cwd-denied'`、`status=done`、真的 `start`。
2. `run：agentCwdRoot 含 %VAR% 时，默认 cwd 用展开后的根比较` — 用 `%DSB_AGENT_ROOT_PROBE%` 指向临时目录。

## 4. 门禁与产物（本机实测）

| 项 | 结果 |
| --- | --- |
| `node --test test/worker/agent-runner.test.mjs` | 36/36 pass（原 34） |
| `npm run gate` | 单测 **493/493**、smoke 65/65、plugcheck 18/28、check-text PASSED |
| pack-check | PASS — `@wfcj/dsh-job-board@2.7.15`，**109 文件 / 1,534,908 B**（unpacked 2,958,326 B） |

## 5. 尚未覆盖（诚实登记）

- **真机未验证**：需要 GT14 升到 2.7.15 后派 D3–D7，确认不再出现 `agent-cwd-denied why=outside`。
- 本轮没有再走盘古定向复审（用户要求「先把事情做好」，是否复审待定）。
