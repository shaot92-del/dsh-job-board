// maintenance 只读通道（v2.6.12）：让主控在不打开任意 exec 的前提下，
// 从副机取回「版本 / 状态 / 配置 / 日志尾部」。
//
// 为什么需要它（handoff A 项根因）：副机 worker 一开，`dispatch:auto` 的任务
// 会被 worker 抢走；内联命令被 fail closed（inline-command-not-allowed），
// 非 allowlist 脚本被拒（approval-required）。于是「远程升级 / 远程排障」这条路
// 被自己的安全闸门堵死 —— 而闸门本身是对的，不能为了通路把它拆掉。
//
// 设计约束（这就是它为什么安全）：
//   · **不 spawn 任何子进程**：没有 pwsh、没有外部命令，也就没有可注入的命令面；
//   · **不读任意路径**：信息源只有进程内的 config / log 环形缓冲 / worker.status()，
//     任务书里的任何字符串都不会被当成路径或命令；
//   · **动词是代码里的常量表**（version/status/config/logs），不从任务书取命令；
//   · 唯一的入参是 `logs` 的行数（1..200），纯数字，越界即拒；
//   · token 永不入 payload（redactConfig 显式剔除），note/result 再经 worker 的 maskText 脱敏。
//
// 写动作（升级 / 重启 / 改配置）**不在本通道内**：那需要「签名一次性授权」，
// 属于 v2.7 的设计（handoff B 项），本版本只交付只读子类型。
//
// 回传带宽：板子的 note 上限 500 字、result.reasons 上限 5 条 ×120 字，
// 都不是拉大段日志的地方。所以除了这份「摘要进板子」，配了 maintenanceOutDir 时
// 还会把完整 payload 写成 JSON（UTF-8 无 BOM）并把路径放进 artifact；
// 主控与副机都能看到同一个共享盘（如 Z: → L:）时，这就是完整日志的取回路径。

import fs from 'node:fs';
import path from 'node:path';

export const MAINTENANCE_VERBS = Object.freeze(['version', 'status', 'config', 'logs']);
export const MIN_LOG_LINES = 1;
export const MAX_LOG_LINES = 200;
export const DEFAULT_LOG_LINES = 40;
/** 单条 reason 的上限：与板子侧 sanitizeResult 的 120 字一致 */
export const REASON_MAX = 120;
export const MAX_REASONS = 5;
/** note 留出余量：worker 还要加 `worker:<id> inst:<id> ` 前缀，总上限 480 */
export const NOTE_MAX = 420;

function oneLine(text, max = REASON_MAX) {
  const t = String(text ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/**
 * 解析维护任务书。goal 既可以是裸动词（`version`），也可以是 JSON
 * （`{"verb":"logs","lines":80}`）——后者是为了给 logs 带行数。
 * @returns {{ok: boolean, spec?: {verb: string, lines?: number}, verb?: string, error?: string}}
 */
export function parseMaintenanceGoal(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, verb: '', error: 'goal 为空' };

  let verb = text;
  let params = {};
  if (text.startsWith('{')) {
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, verb: '', error: 'goal 以 { 开头但不是合法 JSON' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, verb: '', error: 'goal JSON 必须是对象' };
    }
    params = obj;
    verb = obj.verb ?? obj.maintenance ?? '';
  }

  const v = String(verb ?? '').trim().toLowerCase();
  if (!MAINTENANCE_VERBS.includes(v)) {
    return {
      ok: false,
      verb: v,
      error: `不认识的 verb=${JSON.stringify(v)}；只支持 ${MAINTENANCE_VERBS.join(' / ')}`,
    };
  }

  const spec = { verb: v };
  if (v === 'logs') {
    const raw = params.lines;
    if (raw === undefined || raw === null || raw === '') {
      spec.lines = DEFAULT_LOG_LINES;
    } else {
      // **只认整数**：`Number([50])`=50、`Number(true)`=1、`Number('0x10')`=16 都会让
      // 「纯数字」这句承诺变成谎话。数字或纯数字字符串才收，其余一律拒。
      const asNum = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
      if (!Number.isInteger(asNum) || asNum < MIN_LOG_LINES || asNum > MAX_LOG_LINES) {
        return { ok: false, verb: v, error: `lines 必须是 ${MIN_LOG_LINES}..${MAX_LOG_LINES} 的整数（纯数字）` };
      }
      spec.lines = asNum;
    }
  }
  return { ok: true, spec };
}

/** config 里绝不许出板子的键：token 一类的凭证。其余都是排障必需的。 */
const SECRET_KEYS = new Set(['token', 'boardToken', 'npmToken', 'secret', 'password']);

/**
 * query/fragment 参数里算凭证的键名：`?token=` / `?api_key=` / `?sig=` 这类都不许原样外泄。
 * 不锚 `^…$`：线上真实键名常带前缀（`x-board-token`、`X-Amz-Signature`、
 * `X-Amz-Security-Token`），锚死只能挡住「恰好就叫 token」的那一个。
 */
const URL_SECRET_KEY = /(?:^|[_-])(?:token|key|secret|password|passwd|pwd|sig|signature|auth|authorization|credential|session|jwt|bearer)(?:$|[_-])/i;

/**
 * 字面兜底：解析不了或解析得不老实（`u:p@host` 被当成 scheme）时，按字面打码。
 * 分隔符收 `;` 与空白（WHATWG 只认 `&`，`?a=1;token=x` 在 searchParams 里是键 `a`、
 * 值 `1;token=x`，只有字面扫才抓得住）；键名里的 `%20`/`+`/空格先归一成 `_` 再判是不是凭证。
 */
function maskLoose(text) {
  return String(text)
    .replace(/(\/\/)[^/@\s]*:[^/@\s]*@/g, '$1***:***@')
    .replace(/(^|[?#&;\s])([^=&#;\s]+)=([^&#;\s]*)/g, (whole, sep, key) => {
      const normalized = key.replace(/%20|%2B|[+\s]+/gi, '_');
      return URL_SECRET_KEY.test(key) || URL_SECRET_KEY.test(normalized) ? `${sep}${key}=***` : whole;
    });
}

/**
 * boardUrl 脱敏：URL 里可能藏着 userinfo（`http://u:p@host`）或 query token。
 * 板子的 redact() 只认 `x-board-token` / `token=xxx` 那种「键名带 token」的形式，
 * 裸 userinfo 与 `?token=` 它都不管 ⇒ 不在这里脱敏，凭证会进板子 state 和面板 UI。
 * 解析失败（相对路径、垃圾串）就整串打码 query，宁可看不清也不要漏。
 */
export function sanitizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let u;
  try {
    u = new URL(text);
  } catch {
    return maskLoose(text);
  }
  // `new URL()` 会把 `http://h:8965` 规范成 `http://h:8965/`；没东西要脱敏时原样返回，
  // 免得 config 输出的 boardUrl 跟本机配置对不上（排障时会被当成另一个地址）。
  let changed = false;
  if (u.username || u.password) {
    u.username = '***';
    u.password = '***';
    changed = true;
  }
  for (const k of Array.from(u.searchParams.keys())) {
    if (URL_SECRET_KEY.test(k)) {
      u.searchParams.set(k, '***');
      changed = true;
    }
  }
  // fragment 也会带凭证：OAuth 隐式流的 `#access_token=…`，或干脆整段就是一张裸票据。
  const hash = String(u.hash || '').replace(/^#/, '');
  if (hash) {
    const masked = maskLoose(hash);
    if (masked !== hash) {
      u.hash = `#${masked}`;
      changed = true;
    } else if (/^[A-Za-z0-9._~+/=-]{16,}$/.test(hash)) {
      u.hash = '#***';
      changed = true;
    }
  }
  let out = changed ? u.toString() : text;
  // 整串再过一遍字面清扫。为什么整串：`?a=1;token=x`（分号分隔）、`?access token=abc`
  // （空格键名）、`?token%3Dxxx`（百分号编码的等号）、`#{"token":"j1"}`（fragment 里的
  // JSON）都不是 WHATWG 眼里的 `k=v`，只有按字面扫才抓得住。宁可变糊，不许漏。
  const scrubbed = maskLoose(out)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:)[^/@\s:]+@/g, '$1***@')
    .replace(/(["']?[A-Za-z0-9_-]*(?:token|key|secret|sig|signature|auth|password|pwd)[A-Za-z0-9_-]*["']?\s*:\s*["']?)[^"',;}\s]+/gi, '$1***')
    .replace(/%3D[^&#;\s]*/gi, '%3D***');
  return scrubbed !== text ? scrubbed : text;
}

/**
 * 把 normalizeConfig 的产物变成可展示对象：剔除凭证、把白名单压成字符串数组。
 * 注意这里是**白名单式重建**而不是「深拷贝后删字段」——将来给 config 加新字段时，
 * 漏写在这里的字段默认不出现，而不是默认泄漏。
 */
export function redactConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const out = {
    boardUrl: sanitizeUrl(c.boardUrl),
    machine: String(c.machine || ''),
    workerId: String(c.workerId || ''),
    workerMode: String(c.workerMode || ''),
    approvalMode: String(c.approvalMode || ''),
    allowInline: Boolean(c.allowInline),
    allowlist: Array.isArray(c.allowlist) ? c.allowlist.map((x) => String(x)) : [],
    execCwd: String(c.execCwd || ''),
    execCwdRoot: String(c.execCwdRoot || ''),
    pwshPath: String(c.pwshPath || ''),
    orphanPolicy: String(c.orphanPolicy || ''),
    agentEnabled: Boolean(c.agentEnabled),
    agentPreset: String(c.agentPreset || ''),
    agentCwdRoot: String(c.agentCwdRoot || ''),
    agentApproval: String(c.agentApproval || ''),
    agentAllowlist: Array.isArray(c.agentAllowlist) ? c.agentAllowlist.map((x) => String(x)) : [],
    agentBudgetMaxPerDay: Number(c.agentBudgetMaxPerDay) || 0,
    maintenanceEnabled: c.maintenanceEnabled !== false,
    maintenanceOutDir: String(c.maintenanceOutDir || ''),
  };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.has(k)) delete out[k];
  }
  return out;
}

/** Windows 设备名：即使不带扩展名也会被解析成设备，不能当文件名 */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 目录/文件名安全化：只留字母数字与 `._-`，且**首尾的点一律剥掉**。
 * 为什么剥点：`.` 和 `..` 是路径穿越的入口 —— `machine: '..'` 会让
 * `path.join(outDir, '..')` 直接跳出 maintenanceOutDir；`a.` 在 Windows 上
 * 会被规范化成 `a`，两个不同任务就撞同一个文件。剥掉首尾点后不可能再是 `.`/`..`。
 * 保留名（CON/PRN/NUL/COM1…）退回 fallback。
 */
function safeName(text, fallback) {
  const t = String(text ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '');
  if (!t || RESERVED_NAMES.test(t)) return fallback;
  return t;
}

/**
 * 把完整 payload 落到 maintenanceOutDir（可选）。
 * 写不成不抛错：维护通道的价值是「尽量给点信息」，不能因为盘没映射就整条失败。
 * @returns {{path: string, error: string}}
 */
export function writePayload(outDir, payload, opts = {}) {
  const fsImpl = opts.fs || fs;
  const root = String(outDir || '').trim();
  if (!root) return { path: '', error: '' };
  try {
    if (!path.isAbsolute(root)) return { path: '', error: 'maintenanceOutDir 不是绝对路径' };
    const machine = safeName(opts.machine, 'machine');
    const taskId = safeName(opts.taskId, 'task');
    const verb = safeName(opts.verb, 'payload');
    const dir = path.join(root, machine);
    const file = path.join(dir, `${taskId}-${verb}.json`);
    // 第二道闸：safeName 已经堵掉 `..`，这里再按解析后的真实路径复核一次。
    // 两道都要，因为 safeName 是「按字符猜」，resolve 是「按文件系统规则算」——
    // 将来谁改了 safeName（或 Windows 又加奇怪规则），这条仍然是硬边界。
    const rootAbs = path.resolve(root);
    // 盘根（`Z:\`）resolve 后已自带分隔符，再拼一个就成 `Z:\\`，任何文件都不以其开头 —— 静默不落盘。
    const rootPrefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
    if (!path.resolve(file).startsWith(rootPrefix)) {
      return { path: '', error: 'payload 路径越界（不在 maintenanceOutDir 内）' };
    }
    fsImpl.mkdirSync(dir, { recursive: true });
    // UTF-8 **无 BOM**：BOM 会让下游 JSON.parse/ConvertFrom-Json 报「意外字符」（交接单硬约束）
    fsImpl.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
    // 回 artifact 用解析后的真实路径：`outDir` 里带 `..` 时，原始拼接串看起来像相对路径。
    return { path: path.resolve(file), error: '' };
  } catch (err) {
    return { path: '', error: oneLine((err && err.message) || err, 160) };
  }
}

/**
 * @param {{
 *   config: object,
 *   log?: object,
 *   version?: string,
 *   statusFn?: Function,
 *   warnings?: string[],
 *   now?: Function,
 *   fs?: object,
 * }} opts
 */
export function createMaintenanceRunner(opts = {}) {
  const config = opts.config || {};
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  const version = String(opts.version || '');
  const statusFn = typeof opts.statusFn === 'function' ? opts.statusFn : () => ({});
  const warnings = Array.isArray(opts.warnings) ? opts.warnings.map((w) => String(w)) : [];
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fsImpl = opts.fs || fs;
  const enabled = config.maintenanceEnabled !== false;
  const outDir = String(config.maintenanceOutDir || '');

  function blocked(reason, note, startedAt) {
    return {
      status: 'blocked',
      stage: 'maint',
      reason,
      exitCode: null,
      canceled: false,
      timedOut: false,
      durationMs: now() - startedAt,
      result: null,
      artifact: '',
      note: oneLine(note, NOTE_MAX),
      stdoutTail: '',
      stderrTail: '',
    };
  }

  /** 收集某个动词的完整数据。返回 {summary: string, lines: string[], data: object} */
  function collect(spec) {
    const verb = spec.verb;

    if (verb === 'version') {
      const data = {
        plugin: version,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        machine: String(config.machine || ''),
        workerId: String(config.workerId || ''),
        workerMode: String(config.workerMode || ''),
        approvalMode: String(config.approvalMode || ''),
        allowlistCount: Array.isArray(config.allowlist) ? config.allowlist.length : 0,
        agentEnabled: Boolean(config.agentEnabled),
        agentAllowlistCount: Array.isArray(config.agentAllowlist) ? config.agentAllowlist.length : 0,
        maintenanceEnabled: enabled,
      };
      return {
        data,
        summary:
          `plugin=${data.plugin || '?'} node=${data.node} ${data.platform} machine=${data.machine || '?'}` +
          ` workerMode=${data.workerMode} approvalMode=${data.approvalMode}` +
          ` allowlist=${data.allowlistCount} agent=${data.agentEnabled ? 'on' : 'off'}` +
          ` agentAllowlist=${data.agentAllowlistCount}`,
        lines: [
          `plugin=${data.plugin || '?'} node=${data.node} ${data.platform}`,
          `machine=${data.machine || '?'} workerId=${data.workerId || '?'} workerMode=${data.workerMode}`,
          `approvalMode=${data.approvalMode} allowlist=${data.allowlistCount}`,
          `agentEnabled=${data.agentEnabled ? 1 : 0} agentAllowlist=${data.agentAllowlistCount}`,
          `maintenanceEnabled=${data.maintenanceEnabled ? 1 : 0} pid=${process.pid}`,
        ],
      };
    }

    if (verb === 'status') {
      const st = statusFn() || {};
      const jobs = Array.isArray(st.jobs) ? st.jobs : [];
      const stats = st.stats && typeof st.stats === 'object' ? st.stats : {};
      const lastOkAge = Number(st.lastBoardOkAt) > 0 ? Math.max(0, Math.round((now() - Number(st.lastBoardOkAt)) / 1000)) : -1;
      const data = {
        mode: String(st.mode || ''),
        running: Boolean(st.running),
        jobs: jobs.map((j) => ({ taskId: j.taskId, mode: j.mode, elapsedMs: j.elapsedMs, title: j.title })),
        maxConcurrent: Number(st.maxConcurrent) || 0,
        stats,
        lastError: String(st.lastError || ''),
        lastBoardOkAgeSec: lastOkAge,
        consecutiveFailures: Number(st.consecutiveFailures) || 0,
        allowlistCount: Array.isArray(st.allowlist) ? st.allowlist.length : 0,
        approvalMode: String(st.approvalMode || ''),
        agent: st.agent && typeof st.agent === 'object' ? { ok: Boolean(st.agent.ok), reason: String(st.agent.reason || '') } : null,
        orphanRecovery: String(st.orphanRecovery || ''),
      };
      return {
        data,
        summary:
          `mode=${data.mode} running=${data.running ? 1 : 0} jobs=${data.jobs.length}/${data.maxConcurrent}` +
          ` boardOkAgoSec=${lastOkAge < 0 ? '?' : lastOkAge}` +
          ` claimed=${stats.claimed ?? 0} done=${stats.done ?? 0} failed=${stats.failed ?? 0} blocked=${stats.blocked ?? 0}` +
          (data.lastError ? ` lastError=${oneLine(data.lastError, 100)}` : ''),
        lines: [
          `mode=${data.mode} running=${data.running ? 1 : 0} jobs=${data.jobs.length}/${data.maxConcurrent} boardOkAgoSec=${lastOkAge < 0 ? '?' : lastOkAge}`,
          `claimed=${stats.claimed ?? 0} done=${stats.done ?? 0} failed=${stats.failed ?? 0} blocked=${stats.blocked ?? 0} claimErrors=${stats.claimErrors ?? 0}`,
          `allowlist=${data.allowlistCount} approval=${data.approvalMode} agent=${data.agent ? (data.agent.ok ? 'ready' : `unavailable:${data.agent.reason}`) : 'n/a'}`,
          `consecutiveFailures=${data.consecutiveFailures} orphanRecovery=${data.orphanRecovery || 'none'}`,
          data.lastError ? `lastError=${data.lastError}` : '',
        ].filter(Boolean),
      };
    }

    if (verb === 'config') {
      const red = redactConfig(config);
      return {
        data: red,
        summary:
          `machine=${red.machine || '?'} workerMode=${red.workerMode} approvalMode=${red.approvalMode}` +
          ` allowInline=${red.allowInline ? 1 : 0} allowlist=${red.allowlist.length}` +
          ` agentEnabled=${red.agentEnabled ? 1 : 0} agentAllowlist=${red.agentAllowlist.length}` +
          ` agentPreset=${red.agentPreset || '-'} agentCwdRoot=${red.agentCwdRoot || '-'}` +
          ` execCwdRoot=${red.execCwdRoot || '-'} warn=${warnings.length}`,
        // 白名单条目就是「远程为什么被拒」的答案，必须原样给出来
        lines: [
          ...red.allowlist.map((p, i) => `allowlist[${i}]=${p}`),
          ...red.agentAllowlist.map((p, i) => `agentAllowlist[${i}]=${p}`),
          `boardUrl=${red.boardUrl}`,
          `agentApproval=${red.agentApproval || '-'} agentBudgetMaxPerDay=${red.agentBudgetMaxPerDay}`,
          `execCwd=${red.execCwd || '-'} pwshPath=${red.pwshPath || '-'} orphanPolicy=${red.orphanPolicy || '-'}`,
          ...warnings.map((w, i) => `warning[${i}]=${w}`),
        ],
      };
    }

    // logs
    const n = Number(spec.lines) > 0 ? Number(spec.lines) : DEFAULT_LOG_LINES;
    const tail = typeof log.tail === 'function' ? log.tail(n) : [];
    const lines = (Array.isArray(tail) ? tail : []).map((l) => oneLine(l, REASON_MAX));
    return {
      data: { lines, requested: n, got: lines.length },
      summary: lines.length ? lines.slice(-1)[0] : '(日志为空)',
      lines,
    };
  }

  /**
   * @param {{verb: string, lines?: number}} spec
   * @param {{task?: object, taskId?: string, signal?: AbortSignal}} [runOpts]
   */
  async function run(spec = {}, runOpts = {}) {
    const startedAt = now();
    const taskId = String(runOpts.taskId || (runOpts.task && runOpts.task.id) || '');

    if (!enabled) {
      return blocked(
        'maint-disabled',
        'stage=maint reason=maint-disabled（worker.maintenanceEnabled=false，本机不接受维护任务）',
        startedAt,
      );
    }
    const verb = String(spec.verb || '').toLowerCase();
    if (!MAINTENANCE_VERBS.includes(verb)) {
      return blocked('maint-verb-unknown', `stage=maint reason=maint-verb-unknown verb=${JSON.stringify(verb)}`, startedAt);
    }

    let picked;
    try {
      picked = collect(spec);
    } catch (err) {
      const msg = oneLine((err && err.message) || err, 200);
      log.error(`维护通道采集失败 task=${taskId} verb=${verb} ${msg}`);
      return {
        ...blocked('maint-internal', `stage=maint reason=maint-internal verb=${verb} ${msg}`, startedAt),
        status: 'failed',
      };
    }

    const payload = {
      ok: true,
      verb,
      machine: String(config.machine || ''),
      plugin: version,
      at: new Date(now()).toISOString(),
      data: picked.data,
    };
    const written = writePayload(outDir, payload, { fs: fsImpl, machine: config.machine, taskId, verb });
    if (written.error) log.warn(`维护通道 payload 写盘失败 task=${taskId}：${written.error}`);

    const note = oneLine(`stage=maint verb=${verb} ok=1 ${picked.summary}`, NOTE_MAX);
    // reasons 只有 5 条（板子侧再截 120 字）。取哪 5 条很关键：
    // config 的答案是 allowlist（行序在最前），取尾部会把「远程为什么被拒」吃掉；
    // logs 相反 —— 最旧的 5 行没人要，要的是最新 5 行。所以按动词选头/尾。
    const allReasons = picked.lines.filter(Boolean);
    const reasons = verb === 'logs' ? allReasons.slice(-MAX_REASONS) : allReasons.slice(0, MAX_REASONS);
    return {
      status: 'done',
      stage: 'maint',
      reason: 'collected',
      exitCode: 0,
      canceled: false,
      timedOut: false,
      durationMs: now() - startedAt,
      // 只给 reasons（板子对 result 的形状有校验：ok/expected/actual/reasons）
      result: { ok: true, reasons },
      artifact: written.path,
      note,
      payload,
      stdoutTail: picked.lines.join('\n'),
      stderrTail: '',
    };
  }

  return { run, enabled, outDir };
}
