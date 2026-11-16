// agent 路径的准入策略（milestone 2）。
//
// exec 路径有四道固定闸门：绝对路径、扩展名、realpath 白名单、参数黑名单。
// agent 路径以前一道都没有——任务书直接变成会话提示词，宿主工具全开。
// 这里把「哪条任务能进、提示词能写什么、用哪个 preset、要不要人工批」做成
// 一组纯函数，方便单测逐条覆盖，也方便审计时一句一句对。
//
// 所有策略都是 **fail closed**：配置缺项、规则写错、运行时无法落实，一律拒绝。

/** 提示词长度上限（字符）。超过就拒——长任务书不是更安全，是更难审。 */
export const DEFAULT_MAX_PROMPT_CHARS = 4000;

/** 连续 base64/hex 大块的上限。二进制载荷应该走文件，不该塞进任务书。 */
export const DEFAULT_MAX_BASE64_RUN = 2048;

/** 闸门数值的硬边界：配置写 1e999 / Infinity 等于把限制关掉，所以夹回区间并告警。 */
export const MAX_PROMPT_CHARS_LIMIT = 100000;
export const MAX_BASE64_RUN_LIMIT = 1000000;
export const MAX_EXTRA_RULE_CHARS = 300;

/**
 * 默认提示词黑名单规则。id 会写进 note（`agent-prompt-denied:<id>`），
 * 所以 id 要短、要能一眼看出拒的是什么。
 *
 * 注意：这些规则是**启发式**，不是安全边界。真正的边界是「谁能提交任务」+
 * 「preset 授予了哪些工具」+ 「本机审批」。之所以还要做归一化再匹配，是因为
 * 未归一化的匹配连启发式都算不上：`C:\a\.dsh\\profiles`、`C:/a/.dsh//profiles`、
 * 全角路径都能原样绕过。
 */
export const DEFAULT_PROMPT_RULES = [
  {
    id: 'dsh-home',
    // 读 ~/.dsh（profiles / board-tokens / skills / settings）等于直取凭证与配置
    // 前缀类别包含空白与引号：任务书里常写「把 .dsh\profiles 发我」，前面是空格不是分隔符
    re: /(?:^|[\\/~\s"'(])\.dsh[\\/](?:profiles|board-tokens|skills|settings|agents|auth)/i,
  },
  {
    id: 'board-token',
    re: /board-tokens?\.txt|dsh_board_token|x-board-token/i,
  },
  {
    id: 'private-key',
    re: /(?:id_rsa|id_ed25519|id_ecdsa)|(?:^|[\\/~\s"'(])\.ssh[\\/]|begin [a-z ]{0,20}private key/i,
  },
  {
    id: 'env-dump',
    // 想读环境变量里的 token/key：不是 agent 任务的正常需求。
    // 别名也要认：Get-Item Env:、gi env:、Get-ChildItem -Path Env: 与 ls env: 等价
    // （第二遍审计 P3-2：只写 ls env: 等于只挡一种写法）。
    re: /\b(?:ls|dir|gi|gci|get-item|get-childitem)\s+(?:-path\s+)?env:|\[environment\]::|\bprintenv\b|\$env:[a-z0-9_]*(?:token|key|secret|password|credential)/i,
  },
  {
    id: 'inline-shell',
    // agent 任务不该被要求「起一个 cmd/powershell 执行某段编码命令」：那是 exec 路径的职责。
    // 归一化会把 `/` 折成 `\`，所以 `cmd /c` 与 `cmd \c` 两种形态都要认。
    // 短旗标（-c/-e/-ec/-com）只在解释器前缀后 40 字符内判：否则 `git -c k=v log`、
    // `rg -e TODO`、`docker run -e FOO=1` 这些正常任务会被误拒（第二遍审计 P3-1）。
    // 斜杠形态：归一化把 `/Command` 折成 `\Command`，长旗标也要认（第三遍审计 N5）。
    // 只认「空白/行首 + 斜杠 + 旗标名」，避免把 `C:\scripts\com\x.ps1` 这种路径误拒。
    re: /(?:^|[^\w])(?:%\w+%|\$env:[A-Za-z_]\w*|\$\{[^}\n]{1,80}\}|\$[A-Za-z_]\w*)(?:\s+["']?[\/\\][A-Za-z]{1,10}){0,3}?\s*["']?[\/\\][ckr]\b|\bcmd(?:\.exe)?\s*["']?[\/\\][ckr]\b|(?:^|\s)["']?[\/\\](?:command|encodedcommand|enc|ec|com)(?![\/\\])\b|-(?:command|encodedcommand)\b|\b(?:sh|bash|zsh|dash)(?:\.exe)?\s+-[a-z]{0,3}c\b/i,
  },
  {
    id: 'git-credentials',
    re: /(?:^|[\\/~\s"'(])\.git-credentials|credential\.helper\s*=\s*store|git_askpass/i,
  },
];

/** 非字符串一律按空串处理：不把对象/数字变成可匹配文本。 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 把任务书归一化成「规则真正能看懂的形态」：
 *   NFKC（全角→半角）→ 去零宽 → 折叠连续分隔符 → 反复吃掉 `.` 段。
 * 返回的文本只用于规则匹配，不用于展示或执行。
 */
export function normalizePrompt(text) {
  let s = asString(text);
  try {
    s = s.normalize('NFKC');
  } catch {
    /* 极老的运行时没有 normalize：保持原样，规则仍按原文本匹配 */
  }
  // 零宽/方向控制字符：肉眼看不见，却能把 `.dsh` 切成两半
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '');
  // 连续分隔符折叠成一个 `\`：`C:\\a` 与 `C:/a` 归一后再谈规则
  s = s.replace(/[\\/]+/g, '\\');
  // 水平空白压成单个空格：否则 `pwsh` 后面塞 2000 个空格就能把旗标挤出扫描范围
  // （第七遍审计 P2-1）。
  s = s.replace(/[ \t\u00a0]{2,}/g, ' ');
  // `.` 段（`\a\.\b`、`\a\.\.\b` 的 `.` 段）折叠掉，最多迭代 8 轮防病态输入
  for (let i = 0; i < 8; i += 1) {
    const next = s.replace(/\\(\.\\)/g, '\\').replace(/\\(\.)$/g, '\\');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** base64 大块判定：先去掉所有空白（76 字符换行是标准 base64 排版，不该因此放行）。 */
function base64Blob(text, minRun) {
  const flat = text.replace(/\s+/g, '');
  // URL-safe base64（`-`/`_` 代替 `+`/`/`）同样是可解码载荷，一起算（第二遍审计 P3-3）
  return new RegExp(`[A-Za-z0-9+/=_-]{${minRun},}`).test(flat);
}

/**
 * 归一化 `worker.agentPromptGate`：
 *   { maxChars?, maxBase64Run?, extraRules?: [{id, pattern}] }
 * 自定义规则用字符串 pattern（配置里写 JS 正则会带来 eval 风险）。
 * 规则写错时 **不静默丢弃**：标 `invalid`，由 `available()` 把 agent 报成不可用。
 */
export function normalizeAgentPromptGate(raw) {
  const warnings = [];
  let invalid = false;
  const src = raw && typeof raw === 'object' ? raw : {};

  const rawChars = Number(src.maxChars);
  let maxChars = DEFAULT_MAX_PROMPT_CHARS;
  if (src.maxChars !== undefined) {
    if (!Number.isFinite(rawChars) || rawChars < 1) {
      warnings.push(`agentPromptGate.maxChars 不是有效数值（${rawChars}），已回落到默认 ${DEFAULT_MAX_PROMPT_CHARS}`);
    } else {
      maxChars = Math.min(MAX_PROMPT_CHARS_LIMIT, Math.floor(rawChars));
      if (maxChars !== Math.floor(rawChars)) {
        warnings.push(`agentPromptGate.maxChars 超过上限 ${MAX_PROMPT_CHARS_LIMIT}，已夹到上限`);
      }
    }
  }

  const rawBase64 = Number(src.maxBase64Run);
  let maxBase64Run = DEFAULT_MAX_BASE64_RUN;
  if (src.maxBase64Run !== undefined) {
    if (!Number.isFinite(rawBase64) || rawBase64 < 64) {
      warnings.push(`agentPromptGate.maxBase64Run 不是有效数值（${rawBase64}），已回落到默认 ${DEFAULT_MAX_BASE64_RUN}`);
    } else {
      maxBase64Run = Math.min(MAX_BASE64_RUN_LIMIT, Math.floor(rawBase64));
      if (maxBase64Run !== Math.floor(rawBase64)) {
        warnings.push(`agentPromptGate.maxBase64Run 超过上限 ${MAX_BASE64_RUN_LIMIT}，已夹到上限`);
      }
    }
  }

  const rules = DEFAULT_PROMPT_RULES.slice();
  const extra = Array.isArray(src.extraRules) ? src.extraRules : [];
  for (const item of extra) {
    if (!item || typeof item !== 'object') continue;
    const id = asString(item.id).trim().slice(0, 24);
    const pattern = asString(item.pattern).trim();
    if (!id || !pattern) {
      warnings.push('agentPromptGate.extraRules 里有条目缺 id 或 pattern，已按配置无效处理');
      invalid = true;
      continue;
    }
    if (pattern.length > MAX_EXTRA_RULE_CHARS) {
      warnings.push(`agentPromptGate.extraRules「${id}」的 pattern 超过 ${MAX_EXTRA_RULE_CHARS} 字符，已按配置无效处理`);
      invalid = true;
      continue;
    }
    // ReDoS 的两种经典形态，同步正则一旦回溯会卡住整个 worker：
    // ① 嵌套量词 `(a+)+`；② 重复的择一分支 `(a|aa)+$`（GT14 窄问 s10 指出的 P1）
    // 残余风险：规则只跑在长度 ≤ maxChars（默认 4000、硬上限 100000）的文本上，
    // 形态拒绝 + 长度上限共同把回溯成本压在可接受范围；没有做正则超时隔离。
    if (/\([^()]*[+*][^()]*\)\s*[+*]/.test(pattern) || /\([^()]*\|[^()]*\)\s*[+*{]/.test(pattern)) {
      warnings.push(`agentPromptGate.extraRules「${id}」疑似灾难性回溯形态（ReDoS 风险），已按配置无效处理`);
      invalid = true;
      continue;
    }
    try {
      rules.push({ id, re: new RegExp(pattern, 'i') });
    } catch (err) {
      warnings.push(`agentPromptGate.extraRules「${id}」的正则无效：${(err && err.message) || err}`);
      invalid = true;
    }
  }
  return { gate: { maxChars, maxBase64Run, rules, invalid }, warnings };
}

/**
 * 检查一条任务书能不能进 agent 会话。
 * 长度按原文判（归一化会改变长度），规则与 base64 按归一化文本判。
 * @returns {{ok: boolean, rule: string, detail: string}}
 */
const SHELL_INTERPRETER = /\b(?:powershell|pwsh|powershell_ise|cmd|wsl|sh|bash|zsh|dash)(?:\.exe)?\b/gi;
const POSIX_SHELL = /^(?:sh|bash|zsh|dash)$/i;
const DANGEROUS_FLAGS = ['command', 'encodedcommand'];
// 一条语句到哪儿结束：分号、管道、`&&` 都算（换行不算：任务书里常把旗标写在下一行）
const SEGMENT_END = /[;|&]/;
const MAX_SEGMENT = 4000;

/**
 * PowerShell 的参数按「无歧义前缀」绑定：-Comman、-comm、-en、-encoded 都能执行；
 * bash/sh 则是 -c（以及 -lc / -ce 这类单字母串里带 c）。穷举缩写不现实，也不该只看
 * 「解释器后 N 个字符」（空格/换行能撑破窗口），所以改成：
 *   1. 找到解释器 token；
 *   2. 取到这条语句结束（换行 / ; / | / &），最多 2000 字符；
 *   3. 扫该段里的每个旗标 token（空白、逗号、括号、引号之后），
 *      PowerShell 族：凡 command / encodedcommand 的前缀即拒；
 *      POSIX shell：单字母串里带 c（-c / -lc / -ce）即拒，-e 不拒。
 * 逗号也是分隔符，是为了 `Start-Process pwsh -ArgumentList '-Comman',...` 这种间接调用。
 * `C:\com\x.ps1` 不会被当成旗标：旗标前必须是分隔符，不是冒号。
 */
const ENV_CALL = /(?:^|[^\w])(?:%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_]\w*|\$\{[^}\n]{1,80}\}|\$[A-Za-z_]\w*)/g;

function checkEnvCallSite(normalized) {
  ENV_CALL.lastIndex = 0;
  let hit;
  while ((hit = ENV_CALL.exec(normalized)) !== null) {
    const rest = normalized.slice(hit.index + hit[0].length);
    const stop = rest.search(SEGMENT_END);
    const segment = rest.slice(0, stop < 0 ? rest.length : Math.min(stop, MAX_SEGMENT));
    const tokenRe = /(?:^|[\s,;(=])["']?(?:[\/\\])["']?([A-Za-z][A-Za-z]{0,24})\b/g;
    let token;
    while ((token = tokenRe.exec(segment)) !== null) {
      const word = token[1].toLowerCase();
      // 环境变量后面出现 cmd 的执行开关（/c /k /r）就等于起了一个 shell
      if (/^[ckr]$/.test(word)) return { ok: false, rule: "inline-shell", detail: `-${word}` };
      if (/^e(xec)?$/.test(word)) return { ok: false, rule: "inline-shell", detail: "--exec" };
      for (const full of DANGEROUS_FLAGS) {
        if (word.length <= full.length && full.startsWith(word)) {
          return { ok: false, rule: "inline-shell", detail: full };
        }
      }
    }
  }
  return { ok: true, rule: "", detail: "" };
}

function checkShellFlagAbbrev(normalized) {
  const env = checkEnvCallSite(normalized);
  if (!env.ok) return env;
  SHELL_INTERPRETER.lastIndex = 0;
  let hit;
  while ((hit = SHELL_INTERPRETER.exec(normalized)) !== null) {
    const name = hit[0].replace(/\.exe$/i, "");
    // 路径段不是解释器：C:\repo\sh\run.ps1、C:\tools\cmd\notes.md
    // （归一化把 / 折成 \，所以只看下一个字符是不是分隔符；真正的 .exe 调用除外）
    const nextChar = normalized.charAt(hit.index + hit[0].length);
    if (!/\.exe$/i.test(hit[0]) && (nextChar === "\\" || nextChar === "/")) continue;
    const rest = normalized.slice(hit.index + hit[0].length);
    const stop = rest.search(SEGMENT_END);
    const segment = rest.slice(0, Math.min(stop < 0 ? rest.length : stop, MAX_SEGMENT));
    const tokenRe = /(?:^|[\s,;(=])["']?(?:-{1,2}|\/|\\)["']?([A-Za-z][A-Za-z]{0,24})\b/g;
    let token;
    while ((token = tokenRe.exec(segment)) !== null) {
      const word = token[1].toLowerCase();
      if (POSIX_SHELL.test(name)) {
        if (/^[a-z]{0,4}c[a-z]{0,3}$/.test(word)) return { ok: false, rule: "inline-shell", detail: "-c" };
        continue;
      }
      if (name === "cmd") {
        // cmd 只有 /c /k /r 三种执行开关；/q /d /v 这些是开关修饰，夹在中间也要认。
        if (/^[ckr]$/.test(word)) return { ok: false, rule: "inline-shell", detail: `-${word}` };
        continue;
      }
      if (name === "wsl") {
        // wsl --exec / -e 等价于直接在 Linux 里起进程
        if (/^e(xec)?$/.test(word)) return { ok: false, rule: "inline-shell", detail: "--exec" };
      }
      for (const full of DANGEROUS_FLAGS) {
        if (word.length <= full.length && full.startsWith(word)) {
          return { ok: false, rule: "inline-shell", detail: full };
        }
      }
    }
  }
  return { ok: true, rule: "", detail: "" };
}

export function checkAgentPrompt(goal, gate) {
  const text = asString(goal);
  const g = gate || {
    maxChars: DEFAULT_MAX_PROMPT_CHARS,
    maxBase64Run: DEFAULT_MAX_BASE64_RUN,
    rules: DEFAULT_PROMPT_RULES,
    invalid: false,
  };
  if (g.invalid) return { ok: false, rule: 'gate-invalid', detail: '' };
  if (!text.trim()) return { ok: false, rule: 'empty', detail: '' };
  if (text.length > g.maxChars) return { ok: false, rule: 'too-long', detail: `${text.length}>${g.maxChars}` };
  if (base64Blob(text, g.maxBase64Run)) return { ok: false, rule: 'base64-blob', detail: `>=${g.maxBase64Run}` };
  const normalized = normalizePrompt(text);
  for (const item of g.rules) {
    if (item.re.test(normalized)) {
      // 只报规则 id，不回显命中的原文（原文可能本身就是凭证）
      return { ok: false, rule: item.id, detail: '' };
    }
  }
  const abbrev = checkShellFlagAbbrev(normalized);
  if (!abbrev.ok) return abbrev;
  return { ok: true, rule: '', detail: '' };
}

/**
 * 归一化 `worker.agentAllowlist`：
 *   [{ id, titlePrefix?, modelPrefix?, goalPrefix? }]
 * 至少给一个匹配前缀；全部为空 = 匹配一切，那不是白名单，直接丢弃该条。
 */
export function normalizeAgentAllowlist(raw) {
  const warnings = [];
  const list = Array.isArray(raw) ? raw : [];
  const entries = [];
  let auto = 0;
  for (const item of list) {
    if (typeof item === 'string') {
      const id = item.trim().slice(0, 40);
      if (!id) continue;
      warnings.push(`agentAllowlist「${id}」只写了字符串：缺匹配前缀，已忽略（应写 {id, titlePrefix|modelPrefix|goalPrefix}）`);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    auto += 1;
    const id = (asString(item.id).trim() || `allow-${auto}`).slice(0, 40);
    // 显式 matchAll 只给受控实验室用：它等价于「放行所有 agent 任务」，
    // 不给它一个开关的话，单测与冒烟环境只能靠编造 title 前缀。
    const matchAll = item.matchAll === true;
    const titlePrefix = asString(item.titlePrefix).trim();
    const modelPrefix = asString(item.modelPrefix).trim();
    const goalPrefix = asString(item.goalPrefix).trim();
    if (!matchAll && !titlePrefix && !modelPrefix && !goalPrefix) {
      warnings.push(`agentAllowlist「${id}」没有任何匹配前缀（titlePrefix/modelPrefix/goalPrefix 全空），已忽略`);
      continue;
    }
    if (matchAll) {
      warnings.push(`agentAllowlist「${id}」用了 matchAll：等价于放行所有 agent 任务，仅限受控实验室机器`);
    }
    entries.push({ id, matchAll, titlePrefix, modelPrefix, goalPrefix });
  }
  return { entries, warnings };
}

/**
 * 任务是否命中白名单。多个前缀同时给出时要求全部命中（AND）——
 * 「标题像复审 且 模型是 gt14 系」这种组合才有约束力。
 * @returns {{ok: boolean, id: string}}
 */
export function matchAgentAllowlist(entries, task = {}) {
  const title = asString(task.title);
  const model = asString(task.model);
  const goal = asString(task.goal);
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (!entry) continue;
    if (entry.matchAll) return { ok: true, id: entry.id };
    if (entry.titlePrefix && !title.toLowerCase().startsWith(entry.titlePrefix.toLowerCase())) continue;
    if (entry.modelPrefix && !model.toLowerCase().startsWith(entry.modelPrefix.toLowerCase())) continue;
    if (entry.goalPrefix && !goal.toLowerCase().startsWith(entry.goalPrefix.toLowerCase())) continue;
    return { ok: true, id: entry.id };
  }
  return { ok: false, id: '' };
}

/**
 * 归一化 `worker.agentTools`：
 *   { allowedPresets?: string[], deny?: string[] }
 * allowedPresets 是**可落实**的那部分（preset 由运维在 DSH 侧固定为窄权限）；
 * deny 表达「运行时按预设禁掉某些工具」。0.2.0 不做这件事（不承诺做不到的能力）⇒ 非空即不可用（fail closed）。
 */
export function normalizeAgentTools(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const allowedPresets = (Array.isArray(src.allowedPresets) ? src.allowedPresets : [])
    .map((v) => asString(v).trim())
    .filter(Boolean)
    .slice(0, 20);
  const deny = (Array.isArray(src.deny) ? src.deny : []).map((v) => asString(v).trim()).filter(Boolean).slice(0, 20);
  if (deny.length) {
    warnings.push(
      `agentTools.deny 非空（${deny.join(',')}）：0.2.0 不做「按预设运行时禁工具」，` +
        '本插件无法落实这条策略 ⇒ agent 任务会被 blocked（agent-tools-unsupported）',
    );
  }
  return { tools: { allowedPresets, deny }, warnings };
}

/** preset 闸门：先判「按预设运行时禁工具」是否在 0.2.0 的交付面内，再判 preset 是否在白名单内。 */
export function checkAgentPreset(preset, tools = {}) {
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  if (deny.length) return { ok: false, reason: `agent-tools-unsupported:${deny.join(',')}` };
  const allowed = Array.isArray(tools.allowedPresets) ? tools.allowedPresets : [];
  const name = asString(preset).trim();
  if (allowed.length && !allowed.some((p) => p.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: `agent-preset-denied:${name || '(空)'}` };
  }
  return { ok: true, reason: '' };
}

export { asString };
