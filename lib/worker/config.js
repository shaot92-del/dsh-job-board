// 配置归一化：把 patch 行里的 config（以及 profile 覆盖后的形态）变成一份
// 带默认值、类型正确、可审计的配置对象。所有字段都给默认值——worker 是常驻
// 进程，最怕「少一个键就 undefined 一路传下去」。
//
// 支持两种写法（同时给时 worker.* 优先）：
//   扁平：boardUrl / token / machine / workerMode / pollMs / allowlist …
//   嵌套：worker: { pollMs, allowlist, … }        ← 推荐，配置面板按组展示
//
// 本文件不碰磁盘以外的东西（exists 可注入），方便单测。

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeAgentAllowlist, normalizeAgentPromptGate, normalizeAgentTools } from './agent-gate.js';
import { defaultStateDir } from './agent-budget.js';

export const DEFAULT_BOARD_PORT = 8965;
export const DEFAULT_LOOPBACK = 'http://127.0.0.1:8965';

export const WORKER_MODES = ['on', 'drain', 'off'];
export const APPROVAL_MODES = ['manual', 'auto'];
export const ORPHAN_POLICIES = ['blocked', 'requeue', 'ignore'];
// agent 任务的审批模式（milestone 2）：confirm = 需本机 worker_control action=approve 记录（绑提示词指纹）。
export const AGENT_APPROVAL_MODES = ['confirm', 'auto'];

export const CONFIG_LIMITS = Object.freeze({
  pollMs: { min: 200, max: 600000, def: 2000 },
  beatMs: { min: 1000, max: 600000, def: 30000 },
  leaseMinutes: { min: 1, max: 1440, def: 10 },
  maxConcurrent: { min: 1, max: 8, def: 1 },
  execTimeoutMs: { min: 1000, max: 24 * 3600 * 1000, def: 600000 },
  agentTimeoutMs: { min: 1000, max: 24 * 3600 * 1000, def: 1800000 },
  agentBudgetMaxPerDay: { min: 1, max: 1000, def: 20 },
  timeoutMs: { min: 500, max: 120000, def: 8000 },
  logLimit: { min: 20, max: 5000, def: 200 },
  backoffMs: { min: 200, max: 60000, def: 2000 },
  maxBackoffMs: { min: 1000, max: 600000, def: 60000 },
});

function str(v) {  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

function bool(v, def) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return true;
    if (t === 'false' || t === '0' || t === 'no' || t === 'off') return false;
  }
  // v2.6.27（安全审计 P2）：NaN !== 0 恒真 ⇒ 旧写法把 NaN 当 true（fail-open）。
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : def;
  return def;
}

function int(v, spec, warnings, label) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    if (v !== undefined && v !== null && v !== '') warnings.push(`${label}: 非法数字 ${JSON.stringify(v)}，用默认 ${spec.def}`);
    return spec.def;
  }
  const rounded = Math.round(n);
  if (rounded < spec.min || rounded > spec.max) {
    const clamped = Math.min(spec.max, Math.max(spec.min, rounded));
    warnings.push(`${label}: ${rounded} 超出 [${spec.min}, ${spec.max}]，夹到 ${clamped}`);
    return clamped;
  }
  return rounded;
}

function oneOf(v, allowed, def, warnings, label) {
  const t = str(v).toLowerCase();
  if (!t) return def;
  if (allowed.includes(t)) return t;
  warnings.push(`${label}: 只接受 ${allowed.join(' / ')}，收到 ${JSON.stringify(v)}，用默认 ${def}`);
  return def;
}

/** `C:\x` / `C:/x` / `\\server\share` 视为绝对路径。 */
export function isAbsolutePath(p) {
  const s = str(p);
  if (!s) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s) || s.startsWith('//');
}

export function normalizeSlashes(p) {
  return String(p || '').replace(/\//g, '\\');
}

/**
 * 白名单归一化：只留绝对路径；相对路径/通配符一律丢弃并记 warning
 * （相对路径的匹配基准会随 cwd 漂移，等于没有白名单）。
 */
export function strList(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [];
  const out = [];
  for (const item of list) {
    const s = str(item).replace(/\s+/g, '');
    if (!s) continue;
    if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) continue;
    out.push(s);
  }
  return out;
}
function normalizeAllowlist(entries, warnings = []) {
  const list = Array.isArray(entries) ? entries : typeof entries === 'string' && entries.trim() ? [entries] : [];
  const out = [];
  for (const raw of list) {
    const s = str(raw);
    if (!s) continue;
    if (!isAbsolutePath(s)) {
      warnings.push(`allowlist: 忽略非绝对路径 ${JSON.stringify(s)}（白名单只接受绝对路径）`);
      continue;
    }
    if (/[*?]/.test(s)) {
      warnings.push(`allowlist: 忽略通配符项 ${JSON.stringify(s)}（白名单只接受目录或文件）`);
      continue;
    }
    // 只去掉尾部分隔符，但别把盘根 `C:\` 削成 `C:` —— 那样 `isWithin` 会退化成
    // 「整个盘都在白名单里」。
    let normalized = normalizeSlashes(s);
    while (normalized.length > 3 && normalized.endsWith('\\')) normalized = normalized.slice(0, -1);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * 主机名 → 看板机器名。只做 best-effort：副机请显式配 machine，
 * 靠 hostname 猜只在改名/换机前成立。
 */
export function detectMachine(opts = {}) {
  const hostname = str(opts.hostname) || os.hostname();
  const env = opts.env || process.env;
  const forced = str(env.DSH_BOARD_MACHINE);
  if (forced) return forced;
  const h = hostname.toUpperCase();
  if (h.startsWith('GT14')) return 'GT14';
  if (h.startsWith('MB14')) return 'MB14';
  if (h.startsWith('PC2')) return 'PC2';
  if (h.startsWith('DESKTOP-')) return 'host';
  return hostname;
}

/**
 * boardUrl 解析：显式配置优先；留空按 machine 推断——host 走回环，其余走局域网。
 * 推断的意义：主机自己永远不需要为了「换 IP」改配置，副机也不会误连自己。
 */
export function resolveBoardUrl(rawBoardUrl, opts = {}) {
  const explicit = str(rawBoardUrl);
  if (explicit) return explicit.replace(/\/+$/, '');
  // v2.6.0：并入后 boardUrl 由宿主（lib/index.js）解析后传入。这里不再按 machine
  // 猜作者的内网地址——猜错时 worker 会静默连到别人的板子，且公开包里带着私网 IP。
  // 空值 = 未配置：worker 不启动主循环，只保留工具与状态（status 里如实显示空）。
  void opts;
  return '';
}

/** 只认「存在且是普通文件」：指向目录或丢失的路径一律当成解析失败。 */
function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * pwsh 可执行文件解析。顺序：显式配置 → 用户级安装目录 → 系统级 → PATH 里的 pwsh.exe。
 * 用户级优先是全局规范（pwsh 7 装在 %LOCALAPPDATA%\Programs\PowerShell\7）。
 *
 * 解析不到就返回空串、**不**回退成裸 `pwsh`：裸名字要靠 PATH/当前目录解析，
 * 等于把「执行哪个 exe」交给任务侧环境（PATH 劫持面）。空串会让 exec 直接失败并说明原因。
 */
export function resolvePwshPath(config = {}, opts = {}) {
  const exists = typeof opts.exists === 'function' ? opts.exists : fs.existsSync;
  const isFile = typeof opts.isFile === 'function' ? opts.isFile : isFileSync;
  const usable = (p) => {
    try {
      if (!exists(p)) return false;
      return isFile ? isFile(p) : true;
    } catch {
      return false;
    }
  };
  const explicit = str(config.pwshPath).replace(/^"|"$/g, '').trim();
  // 显式配置也要过闸：`pwsh`（靠 PATH 解析）、`.\pwsh.exe`（靠 cwd）、不存在的路径、
  // 指向目录的路径都不能直接交给 spawn —— 否则「不回退裸 pwsh」只对自动探测成立。
  if (explicit) return path.isAbsolute(explicit) && usable(explicit) ? explicit : '';
  const localAppData = str(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'Programs', 'PowerShell', '7', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ];
  const pathVar = str((opts.env && opts.env.PATH) || process.env.PATH);
  for (const dir of pathVar.split(path.delimiter)) {
    const clean = dir.replace(/^"|"$/g, '');
    // 相对 PATH 项会相对 DSH 进程 cwd 解析，等于让同一份配置在不同目录下跑不同 exe
    if (clean && path.isAbsolute(clean)) candidates.push(path.join(clean, 'pwsh.exe'));
  }
  for (const c of candidates) {
    // 用 usable 而不是 exists：目录名恰好叫 pwsh.exe 时 spawn 会失败，报错信息还会误导。
    if (usable(c)) return c;
  }
  return '';
}

/**
 * 从 token 文件里读第一行非注释内容（handoff 约定的 board-tokens.txt 形态）。
 * 读不到返回空串——不要因为 token 文件缺失就让插件加载失败。
 */
export function readTokenFile(file, opts = {}) {
  const fsImpl = opts.fs || fs;
  const p = str(file);
  if (!p) return '';
  try {
    const text = fsImpl.readFileSync(p, 'utf8');
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      return t;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * 主归一化入口。
 * @param {object} raw patch 行里的 config
 * @param {{hostname?: string, env?: object, exists?: Function, fs?: object}} [opts]
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw = {}, opts = {}) {
  const warnings = [];
  const flat = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const nested = flat.worker && typeof flat.worker === 'object' && !Array.isArray(flat.worker) ? flat.worker : {};
  const pick = (key) => (nested[key] !== undefined ? nested[key] : flat[key]);

  const hostname = str(opts.hostname) || os.hostname();
  const machine = str(flat.machine) || detectMachine({ hostname, env: opts.env });
  if (!str(flat.machine)) {
    warnings.push(`machine: 未显式配置，按 hostname 推断为 ${machine}（副机建议写死 machine）`);
  }

  let token = str(flat.token);
  if (!token) token = readTokenFile(flat.tokenFile, { fs: opts.fs });
  if (!token) warnings.push('token: 为空 —— 只适合对假看板/本地调试，真实看板会 401');

  const allowlist = normalizeAllowlist(pick('allowlist'), warnings);

  // milestone 2 的 agent 准入策略：白名单 / 提示词闸门 / preset 与工具策略。
  // 三者的 warning 直接并进 config.warnings，启动时能在 worker_status 里看到。
  const agentAllow = normalizeAgentAllowlist(pick('agentAllowlist'));
  warnings.push(...agentAllow.warnings);
  const agentGate = normalizeAgentPromptGate(pick('agentPromptGate'));
  warnings.push(...agentGate.warnings);
  const agentTools = normalizeAgentTools(pick('agentTools'));
  warnings.push(...agentTools.warnings);

  const config = {
    boardUrl: resolveBoardUrl(flat.boardUrl, { machine }),
    token,
    machine,
    // 稳定实例标识：重启后仍是同一个（孤儿任务接管靠它认领「自己的」任务）。
    // 留空 = 用 machine；同机想跑两个 worker 才需要手动区分。
    // workerId 会进 holder（`<workerId>/<pid>-<rand>`）与 note 前缀，含 `/` 会让
    // `holder.startsWith('PC2/')` 这类归属判断把 `PC2/x/…` 也认成自己。
    workerId: String(str(pick('workerId')) || machine).replace(/[\\/]+/g, '-'),
    hostname,
    workerMode: oneOf(pick('workerMode'), WORKER_MODES, 'off', warnings, 'workerMode'),
    pollMs: int(pick('pollMs'), CONFIG_LIMITS.pollMs, warnings, 'pollMs'),
    beatMs: int(pick('beatMs'), CONFIG_LIMITS.beatMs, warnings, 'beatMs'),
    leaseMinutes: int(pick('leaseMinutes'), CONFIG_LIMITS.leaseMinutes, warnings, 'leaseMinutes'),
    maxConcurrent: int(pick('maxConcurrent'), CONFIG_LIMITS.maxConcurrent, warnings, 'maxConcurrent'),
    execTimeoutMs: int(pick('execTimeoutMs'), CONFIG_LIMITS.execTimeoutMs, warnings, 'execTimeoutMs'),
    agentTimeoutMs: int(pick('agentTimeoutMs'), CONFIG_LIMITS.agentTimeoutMs, warnings, 'agentTimeoutMs'),
    timeoutMs: int(pick('timeoutMs'), CONFIG_LIMITS.timeoutMs, warnings, 'timeoutMs'),
    logLimit: int(pick('logLimit'), CONFIG_LIMITS.logLimit, warnings, 'logLimit'),
    backoffMs: int(pick('backoffMs'), CONFIG_LIMITS.backoffMs, warnings, 'backoffMs'),
    maxBackoffMs: int(pick('maxBackoffMs'), CONFIG_LIMITS.maxBackoffMs, warnings, 'maxBackoffMs'),
    allowlist,
    approvalMode: oneOf(pick('approvalMode'), APPROVAL_MODES, 'manual', warnings, 'approvalMode'),
    allowInline: bool(pick('allowInline'), false),
    orphanPolicy: oneOf(pick('orphanPolicy'), ORPHAN_POLICIES, 'blocked', warnings, 'orphanPolicy'),
    execCwd: str(pick('execCwd')),
    // 配了就要求任务 workspace 与 execCwd 的 realpath 落在该根内；不配则只接受有效绝对目录。
    execCwdRoot: str(pick('execCwdRoot')),
    // v2.6.27：未配 execCwdRoot / agentCwdRoot 时默认 fail-closed；
    // 显式 true 才恢复「cwd 由任务指定」的旧行为。
    allowUnscopedCwd: bool(pick('allowUnscopedCwd'), false),
    pwshPath: str(pick('pwshPath')),
    // agent 模式的默认模型（任务自带 model 时不看这两个）
    agentProvider: str(pick('agentProvider')),
    agentModel: str(pick('agentModel')),
    // agent 模式默认关闭：一条 mode=agent 的任务等于让看板把任意提示词送进本机
    // DSH 会话语境（宿主全部工具可用），必须显式打开（handoff §3.2 的里程碑 2）。
    agentEnabled: bool(pick('agentEnabled'), false),
    // 给了就要求任务的 workspace/cwd 落在该目录下（再挡一道"任意目录开会话"）
    agentCwdRoot: str(pick('agentCwdRoot')),
    // agent 会话用哪个 preset（决定工具集/权限）。agentEnabled=true 时与 agentCwdRoot 一起必填。
    agentPreset: str(pick('agentPreset')),
    // —— milestone 2：四层准入（全部 fail closed）——
    // ① 哪条任务能进（title/model/goal 前缀匹配，多条前缀同时给出时 AND）
    agentAllowlist: agentAllow.entries,
    // ② 提示词闸门（长度、base64 大块、敏感路径/私钥/环境变量/内联 shell 规则）
    agentPromptGate: agentGate.gate,
    // ③ preset 与工具策略（deny 非空即不可落实 ⇒ 拒绝）
    agentTools: agentTools.tools,
    // ④ 审批（confirm = 需本机 worker_control action=approve 记录，绑定提示词指纹）与每日预算
    agentApproval: oneOf(pick('agentApproval'), AGENT_APPROVAL_MODES, 'confirm', warnings, 'agentApproval'),
    agentBudgetMaxPerDay: int(
      pick('agentBudgetMaxPerDay'),
      CONFIG_LIMITS.agentBudgetMaxPerDay,
      warnings,
      'agentBudgetMaxPerDay',
    ),
    // agent 消息的 source.kind（DSH 内部协议；默认与 dsh-remote-agent 一致）
    agentSourceKind: str(pick('agentSourceKind')) || 'cordis-host-runner',
    // 预算计数落盘目录（缺省 %LOCALAPPDATA%\dsh-job-worker）
    stateDir: str(pick('stateDir')) || defaultStateDir(opts.env || process.env),
    // —— v2.6.12 维护通道（只读）——
    // 默认开：它不 spawn、不读任意路径，信息源只有进程内的 config/log/status，
    // 出厂关掉等于「远程排障永远要多跑一趟本机」。要禁写 maintenanceEnabled: false。
    maintenanceEnabled: bool(pick('maintenanceEnabled'), true),
    // 完整 payload（日志尾部等）落到这个目录；配成主控也能看到的共享盘
    // （如 Z:\_maintenance → L:\云盘\...\_maintenance）才能取回全文。
    maintenanceOutDir: str(pick('maintenanceOutDir')),
    // A2 写通道（v2.6.26 补：v2.6.20 只写了消费方，归一化层漏了这些键 ⇒ 写通道永远 maint-write-disabled）
    maintenanceWriteEnabled: bool(pick('maintenanceWriteEnabled'), false),
    maintenanceAllowRestart: bool(pick('maintenanceAllowRestart'), false),
    maintenancePkgDir: str(pick('maintenancePkgDir')),
    maintAuthPublicKeys: strList(pick('maintAuthPublicKeys')),
    dshExePath: str(pick('dshExePath')),
    maintAuthKeyFile: str(pick('maintAuthKeyFile')),
  };

  if (config.approvalMode === 'auto') {
    warnings.push('approvalMode=auto：非白名单脚本也会执行（包括看板侧任意任务），仅限受控实验室机器');
  }
  if (config.allowlist.length === 0) {
    warnings.push('allowlist 为空：所有 exec 任务都会被 blocked（fail closed）');
  }
  if (config.allowInline) {
    warnings.push('allowInline=true：接受 goal 里的内联 PowerShell 文本，绕过白名单（不推荐）');
  }
  if (config.maintenanceOutDir && !isAbsolutePath(config.maintenanceOutDir)) {
    warnings.push(`maintenanceOutDir 不是绝对路径（${config.maintenanceOutDir}）：维护通道不会写 payload 文件，只回板子摘要`);
  }
  if (config.agentEnabled) {
    warnings.push('agentEnabled=true：mode=agent 的任务会在本机开 DSH 会话（工具随 preset，**不是沙箱**）');
    const missing = [];
    if (!config.agentPreset) missing.push('agentPreset');
    if (!config.agentCwdRoot) missing.push('agentCwdRoot');
    if (missing.length) {
      warnings.push(`agentEnabled=true 但缺 ${missing.join(' / ')}：所有 agent 任务会被 blocked（agent-misconfigured）`);
    }
    if (config.agentAllowlist.length === 0) {
      warnings.push('agentAllowlist 为空：所有 agent 任务会被 blocked（agent-allowlist-empty）——白名单为空即 fail closed');
    }
    if (config.agentTools.deny.length) {
      warnings.push(
        'agentTools.deny 非空：0.2.0 不做「按预设运行时禁工具」⇒ agent 任务会被 blocked（agent-tools-unsupported）',
      );
    }
    if (config.agentApproval === 'confirm') {
      warnings.push(
        'agentApproval=confirm：任务第一次领到只会落 approval-request；本机执行 ' +
          'worker_control action=approve taskId=… 后才执行（审批绑定提示词指纹，24h 过期）',
      );
    }
    if (config.agentPromptGate && config.agentPromptGate.invalid) {
      warnings.push('agentPromptGate 有规则写错（extraRules 编不过/疑似 ReDoS）⇒ agent 一律不可用（agent-prompt-gate-invalid）');
    }
  }

  return { config, warnings };
}
