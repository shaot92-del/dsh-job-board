# UI 渲染事故复盘与强制审查规范

> 文档性质：知识库事故案例 + 发布审查规范  
> 规范状态：强制  
> 适用范围：本仓库所有浏览器端 UI、slot 组件、React 元素树及其数据渲染分支  
> 事故案例：`@wfcj/dsh-job-board v2.7.0` 派工后 React #130 白屏  
> 建立日期：2026-11-20  
> 关联报告：`docs/react130-crash-review-2026-11-20.md`

## 0. 强制执行条款

任何变更满足以下任一条件，就必须执行本规范：

- 修改 `lib/client.js` 或其他浏览器端 bundle；
- 新增或修改 React `createElement`、JSX、slot 注册、函数组件、Error Boundary；
- 修改 UI 状态、条件分支、接口字段映射或弹窗交互；
- 修改可能进入 React child、element type、props 的数据；
- 修复 UI 白屏、渲染异常、点击后崩溃或刷新后异常。

**以下证据不能单独作为 UI 审查通过依据：JavaScript 语法检查、源码字符串存在、默认首页能渲染、测试总数量、pack-check、安全审计无 P0/P1。**

缺少本规范要求的证据时，UI 审查结果必须是 `FAIL` 或 `BLOCKED`，不得写 `PASS`，不得发布。明确判定为“不适用”时，必须说明为什么变更不可能影响浏览器渲染。

---

## 1. 事故摘要

v2.7.0 在真实 DSH 生产宿主中打开派工流程后，main slot 整块白屏。控制台为：

```text
Minified React error #130
args[]=object&args[]=
slot entry crashed in 'main'
```

发布前曾进行多轮安全、代码和主控复查，且出现以下“全绿”证据：

- `client-render-smoke` 23/23；
- worker 单元测试 448/448；
- plugcheck、pack-check 全绿；
- 多轮安全与代码复审收口。

这些证据均未覆盖真实派工弹窗的 React 元素创建规则，因此没有检测到缺陷。

### 1.1 技术根因

`lib/client.js:3000` 附近的外层 `h()` 缺少真正的 `'div', null`，模型行又缺少一层 `h()`，造成参数整体错位：

```js
return h(
  h('div', /* ... */), // React element 对象被当成外层 type
  taskMode === 'maint' ? h('div', /* ... */) : null, // 错落到 props 位置
  'div', // 错落成文本 child
  { style: { /* ... */ } }, // 普通对象 child 风险
  // ...
)
```

React #130 的语义是：

```text
Element type is invalid: expected a string or class/function but got: object.
```

它不是“Objects are not valid as a React child”；后者为 React #31。本案例首先触发 #130，同时代码中还埋着 #31 风险。

### 1.2 已验证事实

严格渲染诊断脚本在 `ask=true` 且模型区可见时复现 #130，创建点栈定位到 `client.js:3000`；修正参数结构后，同一分支通过严格 type/child 校验。

这说明问题无需依赖服务端异常字段即可发生。事故排查时不能先被“448 全绿”或“2.6.x 没报过”带偏，应先验证实际元素创建调用。

---

## 2. 为什么多轮复查仍漏检

### 2.1 分支没有执行

默认测试状态为 `ask=false`、`data=null`，且 `useEffect()` 是空实现，无法取得 `defaultModel/nodeModels`。派工模型区因此完全没有进入渲染。

### 2.2 测试替身过于宽松

假 `createElement` 接受任意 type、props 和 child，只负责拼对象，不执行 React 合法性检查。因此 `h(h('div'))` 也能“通过”。

### 2.3 把源码存在误当行为正确

以下断言只能证明字符串存在：

```js
RAW.includes("'类型'")
RAW.includes("h('option', { value: 'maint' }")
```

它们不能证明弹窗会打开、组件能渲染、选项属于合法 select，更不能证明生产 React 不抛错。

### 2.4 测试数量制造了错误安全感

448 条测试主要来自 `test/worker/*.test.mjs`，覆盖 worker、安全闸门、票据、文件锁和执行器。它们不能替代浏览器 UI 测试。

### 2.5 审查范围偏向安全与增量业务语义

当轮复审重点为 worker 权限、审批、维护写通道、cwd、文档和打包，没有一条强制要求“以有模型数据的状态打开派工弹窗”。多轮复查使用相同材料和相同测试 oracle，属于相关性很高的重复检查，不是独立运行验证。

### 2.6 大型手写 `h()` 树降低了肉眼审查可靠性

错位后的代码仍是合法 JavaScript，括号可以配平，语法检查不会失败。跨版本在同一块嵌套调用中插入类型选择、票据和 diff 预览，增量 diff 很容易让审查者只读新增行，而忽略整个调用的参数结构。

### 2.7 缺少生产宿主端到端验收

真实 React 的 #130 只有在实际渲染该分支时才出现。发布证据中没有完整记录“打开派工弹窗 → 模型选择 → 确认 → summary 刷新 → 控制台无错误”的生产宿主操作结果。

### 2.8 复盘结论

**不是测试数量不足，而是缺少一个会在该缺陷上明确失败的检查点。** 复查次数不能弥补审查维度和测试 oracle 的缺失。

---

## 3. 审查角色与责任

### 3.1 主控 / 提交者

必须提供完整、可复现的证据，不得只写“本地正常”“测试全绿”。负责：

- 状态矩阵；
- 严格渲染测试；
- 行为断言；
- 生产宿主 click-through；
- 控制台与 Network 检查；
- 回归用例先入 gate，再申请发布。

### 3.2 代码审查工程师

必须核对测试是否真正执行变更分支，不能只看测试名和通过率。发现“源码字符串断言冒充行为断言”“假 React 不校验类型”时，必须阻断。

审计员保持只读、不执行仓库脚本时，应审查主控提供的命令、输出、测试代码与覆盖矩阵；证据不足必须返回 `BLOCKED`，不得代为推断已经执行。

### 3.3 安全审计师

安全 PASS 不替代 UI 功能 PASS。若改动涉及渲染不可信接口数据，还必须检查对象 child、敏感信息落日志、错误占位是否泄露 props、票据、目标文本和本机路径。

### 3.4 独立复审

公开发布前至少一名复审者不得只沿用上一轮结论。其任务是主动寻找“为什么现有测试即使全绿也可能漏掉本次改动”，并核对生产宿主证据。

---

## 4. 强制审查流程

### 第一步：标记实际受影响的渲染子树

审查输入必须包含：

- 变更文件全文；
- 受影响组件的完整函数，而不只是 diff 行；
- 组件注册和 Error Boundary 位置；
- 状态来源、接口字段和条件分支；
- 实际进入分支所需的 state/props 条件。

修改嵌套 `h()`/JSX 时，必须重新核对该调用的 type、props、children 和括号结构，不能只读新增文本。

### 第二步：列状态矩阵

至少列出：

| 维度 | 必查状态 |
|---|---|
| 主流程 | 初始、操作中、成功、失败、重试 |
| 弹窗 | 关闭、打开、提交中、提交成功、提交失败 |
| 数据 | 空、最小、正常、边界、畸形、缺字段 |
| 功能分支 | 每个 mode、每个远程/本地分支、每个新增条件 |
| 权限/能力 | 启用、禁用、未配置、接口失败 |
| 生命周期 | 首次挂载、状态刷新、卸载后迟到响应 |

不能只测试“默认空数据”。每个新增条件至少要有一个会进入 `true` 分支的用例；有条件涉及远端、错误、维护模式时，还要覆盖对应分支。

### 第三步：使用严格 React 约束

测试替身至少必须验证：

1. `type` 是合法标签、组件或受支持的 React 类型；
2. 第二参不是误传的 React element；
3. 普通对象不能作为 child，React element 和数组按规则处理；
4. 组件返回的元素树可遍历，且关键行为节点存在。

示例基线，可按项目支持的 React 类型扩展：

```js
function strictCreateElement(type, props, ...children) {
  const reactObjectType = type && typeof type === 'object' && type.$$typeof
  const validType = typeof type === 'string' || typeof type === 'function' ||
    typeof type === 'symbol' || (reactObjectType && type.$$typeof !== Symbol.for('react.element'))
  if (!validType) throw new Error('invalid element type: ' + typeof type)
  if (props && props.$$typeof === Symbol.for('react.element')) {
    throw new Error('React element passed as props')
  }
  const visit = (child) => {
    if (Array.isArray(child)) return child.forEach(visit)
    if (child && typeof child === 'object' && !child.__fakeReactElement) {
      throw new Error('plain object passed as React child')
    }
  }
  children.forEach(visit)
  return { type, props: props || {}, children, __fakeReactElement: true }
}
```

严格测试不是永久替代真实 React；它用于在离线 gate 中提前发现结构性错误，生产宿主验收仍是必需项。

### 第四步：把断言写在行为上

禁止把 `RAW.includes(...)` 作为“组件可渲染”的唯一证据。

正确做法：

- 真正设置 `ask=true`，渲染弹窗；
- 断言 select 的 type、option 数量、value 和事件；
- 断言 maint 输入框存在于正确分支；
- 断言本地/远程 diff 输出；
- 断言成功和失败后的状态变化；
- 对整棵树执行非法 type/child 扫描。

源码字符串断言可以用于版本号、样式钩子等辅助检查，但测试名必须准确描述其能力，不能命名为“弹窗渲染通过”。

### 第五步：先复现，再修复，再证明旧测试会失败

每个生产 UI 缺陷必须留下回归用例，并证明：

1. 未修复代码在该用例上失败；
2. 修复后同一用例通过；
3. 用例进入正式 gate，而不是只留在事故附件；
4. 测试失败信息能指向真实分支和表达式。

禁止只验证修复后的 happy path，然后把永远无法失败的测试加入仓库充数。

### 第六步：真实生产宿主验收

至少执行：

1. 使用生产 React 和实际 slot 加载方式；
2. 打开变更涉及的每个 UI 分支；
3. 完成一次主流程和一次失败流程；
4. 等待相关接口刷新与异步状态更新；
5. 检查控制台无 React error、未捕获异常和 slot crash；
6. 检查 Network 响应字段与 UI 假设一致；
7. 验证错误占位不会吞掉根因，也不会泄露敏感 props。

DevTools 必须开启 Preserve log。仅提供静态截图不足以证明异步刷新后没有崩溃。

---

## 5. 本项目派工面板最低回归矩阵

以下矩阵是 `lib/client.js` 派工相关变更的最低要求，可随功能增加，不得删减已有分支：

| 用例 | 必要初始状态 | 必须验证 |
|---|---|---|
| 默认面板 | `ask=false` | 标题、任务列表、机器卡正常 |
| agent 派工弹窗 | `ask=true`、有 `defaultModel` | 类型行、模型行合法渲染 |
| 正常模型池 | `ask=true`、有 `nodeModels` | 分组、选项、模型选择合法 |
| 空模型池 | 无模型、无默认模型 | 不进入模型区，其余弹窗可用 |
| exec 分支 | `taskMode='exec'` | 分支正确，无非法元素 |
| maint 只读 | `taskMode='maint'` | 票据区、说明和提交状态 |
| maint 本地 diff | `diffRes.remote=false` | `changesList`、空变化、错误输出 |
| maint 远程 diff | `diffRes.remote=true` | `note` 文本化和远程提示 |
| 创建成功 | `/create ok:true` | 弹窗关闭、tick 增加、summary 刷新 |
| 创建失败 | `/create ok:false` | 错误文本可见，面板不白屏 |
| 异常字段 | error/note/status 等为对象 | 被归一或拒绝，不产生 #31 |
| 生产宿主 | 实际 DSH + 生产 React | 完整 click-through，无 slot crash |

---

## 6. 发布阻断规则

出现以下任一情况，UI 审查必须 FAIL：

- 新增分支没有实际执行；
- 只提供源码字符串、语法检查或测试总数；
- 假 React 接受明显非法 type/child；
- 测试无法在未修复代码上失败；
- 生产主流程未跑，或控制台错误未解释；
- 用 Error Boundary 隐藏错误后宣称根因已修；
- 只看 diff，未检查受影响的完整渲染调用；
- 审查结论复制上一轮，未核对本轮状态矩阵；
- 失败错误文本直接渲染对象，可能引发二次 #31；
- 为记录崩溃把完整 props、票据或敏感任务内容写进全局日志。

### 严重级别

- 主面板、主流程或派工路径可稳定触发白屏：**P0，禁止发布**。
- 仅特定可选分支崩溃，但主流程可用：至少 **P1，默认禁止发布**；如确需带病发布，必须由用户明确接受并记录范围、回退和修复期限。
- Error Boundary 只能降低爆炸半径，不能降低缺陷级别。

---

## 7. 审查输出模板

每轮代码审查必须附以下块；不适用时给出理由：

```json
{
  "uiRenderReview": {
    "applicable": true,
    "affectedSubtree": "Panel > DispatchDialog > ModelSelect",
    "stateMatrix": [
      "ask=true + defaultModel",
      "ask=true + nodeModels",
      "taskMode=maint + remote diff",
      "create success + summary refresh"
    ],
    "strictRuntime": {
      "command": "npm run smoke:client",
      "invalidTypeChecked": true,
      "objectChildChecked": true,
      "result": "PASS"
    },
    "regressionProof": {
      "failsBeforeFix": true,
      "passesAfterFix": true,
      "test": "scripts/client-render-smoke.mjs / dispatch dialog matrix"
    },
    "productionHost": {
      "build": "DSH production React",
      "path": "open -> dispatch -> confirm -> refresh",
      "consoleErrors": 0,
      "result": "PASS"
    },
    "result": "PASS"
  }
}
```

`productionHost` 未执行时不得填 `PASS`。离线环境无法执行时填 `BLOCKED` 并写明需要谁补做，不能用推测替代。

---

## 8. 工程结构要求

为防止同类问题重复出现，后续修改必须遵守：

- 新增 UI 不得继续堆叠上百行、跨多个功能分支的单层 `h()` 调用；
- 派工弹窗应拆成 `DispatchDialog`、`TaskModeSelect`、`MaintTicket`、`ModelSelect` 等可独立测试的小组件；
- 每次嵌套调用修改后运行格式化、语法检查和严格渲染测试；
- 对接口文本字段统一归一，不把未知对象直接作为 React child；
- 主 slot 内保留局部 Error Boundary 和安全的崩溃诊断；
- 日志只记录 type 元数据、stack、componentStack 和 props key，不记录敏感值；
- UI 测试数量单独报告，不得混在 worker 测试总数中宣传覆盖率。

---

## 9. 落地清单

### 发布前必须完成

- [ ] 将严格派工弹窗矩阵并入 `scripts/client-render-smoke.mjs`；
- [ ] 证明新增用例能复现本次 #130，修复后通过；
- [ ] 将 UI 审查块加入代码审查输出；
- [ ] 主控完成生产宿主 click-through 并保存结果；
- [ ] `npm run gate` 全绿；
- [ ] Security、Engineering、主控分别给出本轮结论；
- [ ] 不以 Error Boundary 占位代替根因修复；
- [ ] 不发布未关闭的 P0/P1 UI 渲染问题。

### 资料库归档要求

- [ ] 保存事故现象、React 错误码语义、根因行号和修复 diff；
- [ ] 保存“为什么既有测试全绿仍漏检”的复盘；
- [ ] 保存复现脚本与修复前后输出；
- [ ] 保存本规范及后续修订记录；
- [ ] 后续每次漏检都反向补充状态矩阵，而不是只修当前一行。

---

## 10. 本次事故证据索引

- 事故详细诊断：`docs/react130-crash-review-2026-11-20.md`
- 原始案例：`CASE.md`
- 崩溃日志：`console-error.txt`
- 严格复现脚本：`case/verify-react130-fix.mjs`
- 缺陷位置：`lib/client.js:3000-3121`
- 盲区测试：`scripts/client-render-smoke.mjs`
- 原审计协议：`docs/review/auditor-protocol.md`
- 发布门：`AGENTS.md`

本规范的最终目标不是增加文档，而是保证：**下一次出现非法 element type、普通对象 child 或未执行的新 UI 分支时，发布门必须失败，而不是继续全绿。**
