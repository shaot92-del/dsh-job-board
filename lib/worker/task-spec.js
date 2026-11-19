// 任务契约解析：把 board 上的一个 task 变成可执行的 spec。
//
// 背景（handoff §2.3 / §7）：board 的 /api/create 只收白名单字段，
// **未知字段会被丢弃**，所以 exec 的新契约只能塞在 goal 里（goal ≤300 字符）：
//
//   goal = {"scriptPath":"Z:\\_tools\\foo.ps1","args":["-Cases","30"],"timeoutMs":120000}
//
// 为了兼容手写任务，也接受「goal 就是一条绝对 .ps1 路径」。
// 旧的内联命令形态（goal 是一整段 PowerShell 文本）默认拒绝：它绕过白名单，
// 是实打实的注入面（handoff §3.3）。只有显式 allowInline=true 才走 legacy 路径。
//
// mode=maint 是 v2.6.12 的**只读维护通道**（version/status/config/logs）：它不 spawn、
// 不读任意路径，见 maintenance.js 顶部；动词表在代码里，不从任务书取命令。
//
// 本文件纯函数，不碰 fs —— 存在性/白名单校验在 exec-runner 里做。

import { isAbsolutePath } from './config.js';
import { normalizeTaskMode } from '../dispatch-filter.js';
import { parseMaintenanceGoal } from './maintenance.js';

export const MAX_ARGS = 64;
export const MAX_ARG_CHARS = 2000;
export const MAX_ARGS_TOTAL_CHARS = 6000;
export const MAX_SPEC_CHARS = 300; // board 的 goal 上限
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 24 * 3600 * 1000;

// 这些参数出现在 args 里等于把白名单脚本变成了任意命令执行入口：
// `-Command` / `-EncodedCommand` 会再解析一段代码，`cmd /c`、`pwsh -File x.ps1`
// 则能转调别的脚本。注意 pwsh 的 `-File <script> <args...>` 形态下 -File 之后的
// 内容都是脚本参数、不会被 pwsh 再解析，所以这里是**纵深防御**而不是唯一闸门；
// 但仍然把 pwsh 的全部短别名（-c / -e / -ec / -com）都算进来：白名单脚本若把
// $args 原样转给 pwsh，这些别名就变成真的代码执行入口。
const FORBIDDEN_ARG_PATTERNS = [
  /^-command$/i,
  /^-encodedcommand$/i,
  /^-enc$/i,
  /^-ec$/i,
  /^-com$/i,
  /^-e$/i,
  /^-c$/i,
];

const FORBIDDEN_ARG_VALUES = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', '/c', '/k', '/ce', '/ck']);

/** 检查 args 是否试图注入额外命令。返回第一条命中的参数或空串。 */
export function findForbiddenArg(args) {
  for (const raw of Array.isArray(args) ? args : []) {
    const a = String(raw ?? '');
    const t = a.trim();
    if (!t) continue;
    if (FORBIDDEN_ARG_VALUES.has(t.toLowerCase())) return t;
    // 只按第一个 token 判断：`-Command:xxx` 这种紧凑写法也要拦
    const head = t.split(/[:\s=]/)[0].toLowerCase();
    if (FORBIDDEN_ARG_PATTERNS.some((re) => re.test(head) || re.test(t.toLowerCase()))) return t;
  }
  return '';
}

/** 路径形态的 goal（裸 .ps1 绝对路径，允许被引号包起来） */
export function looksLikeScriptPath(text) {
  const t = String(text || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!t) return false;
  if (/[\r\n]/.test(t)) return false;
  if (!isAbsolutePath(t)) return false;
  return /\.ps1$/i.test(t);
}

/**
 * 校验 exec spec（结构层面；不动磁盘）。
 * @returns {{ok: boolean, errors: string[], spec?: object}}
 */
export function validateExecSpec(spec = {}, opts = {}) {
  const errors = [];
  const maxTimeoutMs = Number.isFinite(opts.maxTimeoutMs) ? opts.maxTimeoutMs : MAX_TIMEOUT_MS;
  const scriptPath = String(spec.scriptPath || '').trim().replace(/^"|"$/g, '');

  if (!scriptPath) errors.push('scriptPath 不能为空');
  else {
    if (!isAbsolutePath(scriptPath)) errors.push('scriptPath 必须是绝对路径');
    if (!/\.ps1$/i.test(scriptPath)) errors.push('scriptPath 只接受 .ps1 脚本');
    if (/[\r\n]/.test(scriptPath)) errors.push('scriptPath 不能包含换行');
    // 结构层先挡一道：`..` 段、`.` 段、UNC/\\?\ 前缀都不接受。
    // （allowlist 用 realpath 比对做真正的裁决，这里只是把明显越界的值提早拒掉，
    //   免得把解释责任全压在 realpath 上。）
    if (/^\\\\/.test(scriptPath)) errors.push('scriptPath 不接受 UNC 或 \\\\?\\ 前缀');
    const segments = scriptPath.split(/[\\/]+/);
    if (segments.includes('..')) errors.push('scriptPath 不能包含 .. 段');
    if (segments.includes('.')) errors.push('scriptPath 不能包含 . 段');
  }

  const args = Array.isArray(spec.args) ? spec.args.map((x) => String(x ?? '')) : spec.args === undefined || spec.args === null ? [] : null;
  if (args === null) errors.push('args 必须是字符串数组');
  const safeArgs = args || [];
  if (safeArgs.length > MAX_ARGS) errors.push(`args 最多 ${MAX_ARGS} 个`);
  let total = 0;
  for (const a of safeArgs) {
    total += a.length;
    if (a.length > MAX_ARG_CHARS) errors.push(`单个参数超过 ${MAX_ARG_CHARS} 字符`);
    if (/[\r\n]/.test(a)) errors.push('参数不能包含换行');
  }
  if (total > MAX_ARGS_TOTAL_CHARS) errors.push(`args 总长度超过 ${MAX_ARGS_TOTAL_CHARS} 字符`);

  const forbidden = findForbiddenArg(safeArgs);
  if (forbidden) errors.push(`参数里不允许出现 ${JSON.stringify(forbidden)}（会把白名单脚本变成任意命令执行）`);

  let timeoutMs;
  if (spec.timeoutMs !== undefined && spec.timeoutMs !== null && spec.timeoutMs !== '') {
    const n = Number(spec.timeoutMs);
    if (!Number.isFinite(n)) errors.push('timeoutMs 必须是数字');
    else if (n < MIN_TIMEOUT_MS || n > Math.min(MAX_TIMEOUT_MS, maxTimeoutMs)) {
      errors.push(`timeoutMs 必须在 ${MIN_TIMEOUT_MS}..${Math.min(MAX_TIMEOUT_MS, maxTimeoutMs)} 之间`);
    } else timeoutMs = Math.round(n);
  }

  if (errors.length) return { ok: false, errors };
  const out = { scriptPath };
  if (safeArgs.length) out.args = safeArgs;
  if (timeoutMs) out.timeoutMs = timeoutMs;
  return { ok: true, errors: [], spec: out };
}

/**
 * 任务 → spec。
 * @param {object} task board 任务
 * @param {{allowInline?: boolean, maxTimeoutMs?: number}} [opts]
 * @returns {{kind: 'exec'|'exec-legacy'|'agent'|'maintenance'|'invalid', spec: object, reason: string, error: string}}
 */
export function parseTaskSpec(task = {}, opts = {}) {
  // 归一化只有一份（lib/dispatch-filter.js）：板子落 mode 用的是 Python `.strip()`，
  // 它**不**认 BOM，带 BOM 的 `\uFEFFmaint` 会一路存进 state；Host 的 isMaintMode 与这里
  // 必须同规则，否则同一条任务 Host 当 agent 派、这里当维护任务读。
  const mode = normalizeTaskMode(task.mode);
  const goal = String(task.goal ?? '');
  const goalTrim = goal.trim();

  if (mode === 'agent') {
    const errors = [];
    if (!goalTrim) errors.push('goal 不能为空');
    const cwd = String(task.workspace || '').trim();
    if (cwd && !isAbsolutePath(cwd)) errors.push('workspace 必须是绝对路径');
    if (errors.length) return { kind: 'invalid', spec: {}, reason: 'agent-spec-invalid', error: errors.join('；') };
    const spec = { goal: goalTrim };
    if (cwd) spec.cwd = cwd;
    if (task.model) spec.model = String(task.model).trim();
    return { kind: 'agent', spec, reason: '', error: '' };
  }

  // maintenance（v2.6.12）：只读通道。板子的 mode 字段上限 10 字符（board_server.py
  // 的 `mode[:10]`），所以「maintenance」落板会被截成「maintenanc」——这里按前缀认，
  // mode=maint / maintenance / maintenanc 都能进同一条路。
  if (mode.startsWith('maint')) {
    // v2.6.20：票据走板子的独立字段 `maint_ticket`（goal 只有 300 字上限，而 base64url
    // 票据 430~450 字，塞进 goal 必然被截断成一张坏票）。这里把它拼回「payload + 末行
    // ticket=」的约定形态，与 `scripts/maint-ticket.mjs` 的 signGoal / splitGoal、
    // 以及 Host 侧 board_dispatch 的校验用的是同一套拼法。
    // 注意 goal 不能二次 trim：板子写入时已经 strip 过，payload 哈希按逐字节算，
    // 这里只补一个换行，不改 payload 本体。
    const ticket = String(task.maint_ticket ?? '').trim();
    const goalText = ticket ? String(goal).replace(/\s+$/, '') + '\nticket=' + ticket : goal;
    const parsed = parseMaintenanceGoal(goalText);
    if (!parsed.ok) {
      return { kind: 'invalid', spec: {}, reason: 'maint-spec-invalid', error: parsed.error };
    }
    return { kind: 'maintenance', spec: parsed.spec, reason: '', error: '' };
  }

  if (mode && mode !== 'exec') {
    return { kind: 'invalid', spec: {}, reason: 'unknown-mode', error: `不认识的 mode=${JSON.stringify(task.mode)}` };
  }

  // exec（含 mode 留空时按形态推断）
  let candidate = null;
  let inferred = false;
  if (goalTrim.startsWith('{')) {
    try {
      const obj = JSON.parse(goalTrim);
      if (obj && typeof obj === 'object' && typeof obj.scriptPath === 'string') candidate = obj;
    } catch {
      /* 落下面按内联/路径处理 */
    }
  }
  if (!candidate && looksLikeScriptPath(goalTrim)) {
    candidate = { scriptPath: goalTrim.replace(/^"|"$/g, '') };
    inferred = true;
  }

  if (candidate) {
    const checked = validateExecSpec(candidate, opts);
    if (!checked.ok) {
      return { kind: 'invalid', spec: candidate, reason: 'exec-spec-invalid', error: checked.errors.join('；') };
    }
    return { kind: 'exec', spec: checked.spec, reason: inferred ? 'inferred-from-path' : '', error: '' };
  }

  if (mode === 'exec' && !goalTrim) {
    return { kind: 'invalid', spec: {}, reason: 'goal-empty', error: 'mode=exec 但 goal 为空' };
  }

  // 内联命令：默认拒绝（fail closed）
  if (!opts.allowInline) {
    return {
      kind: 'invalid',
      spec: { inline: goalTrim },
      reason: 'inline-command-not-allowed',
      error:
        'goal 既不是 {scriptPath,args,timeoutMs} 也不是绝对 .ps1 路径；内联命令默认拒绝（allowInline=false）。' +
        '请把脚本放到白名单目录并改用 scriptPath 契约。',
    };
  }

  if (!goalTrim) return { kind: 'invalid', spec: {}, reason: 'goal-empty', error: 'goal 为空' };
  if (goalTrim.length > 8000) return { kind: 'invalid', spec: {}, reason: 'goal-too-long', error: '内联命令超过 8000 字符' };
  return { kind: 'exec-legacy', spec: { inline: goalTrim }, reason: 'legacy-goal', error: '' };
}
