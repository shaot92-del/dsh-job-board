// agent 模式执行器：在**本进程内**起一个 DSH 会话，把任务书投进去，等它空闲，
// 取最后一段助手文本写回 board。替代 dsh-remote-agent 的 agent 模式（rc.3 上
// 那条路是 spawn EINVAL —— 它去起子进程了，而宿主里本来就能直接开会话）。
//
// 分两层：
//   createAgentRunner({ host })      —— 与 DSH 无关的编排（超时/取消/notes）
//   createDshAgentHost({ ctx })      —— 唯一碰 DSH 服务的地方（agentLoop/sessions）
// 这样单测用假 host 就能覆盖全部分支，等 GT14 上真机验证时只改 host 这一层。
//
// ⚠ 状态：milestone 1 只交付 exec 路径，本文件的 DSH host 适配层**尚未真机验证**。
//   已知不确定点写在 docs/REVIEW.md，别当成已验证结论引用。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oneLine, NOTE_TEXT_BUDGET, isWithin } from './exec-runner.js';
import { maskText } from './log.js';
import { checkAgentPreset, checkAgentPrompt, matchAgentAllowlist } from './agent-gate.js';
import { createAgentBudget } from './agent-budget.js';
import { createAgentApprovals, promptFingerprint } from './agent-approval.js';

export const AGENT_NOTE_BUDGET = NOTE_TEXT_BUDGET;
export const MAX_SESSION_ID = 80;

export function makeSessionId(taskId, random = () => crypto.randomBytes(3).toString('hex')) {
  const safe = String(taskId || 'task')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `worker-${safe}-${random()}`.slice(0, MAX_SESSION_ID);
}

/** "provider/model" → {provider, model}；只有 model 时 provider 走默认。 */
export function parseModelRef(modelRef, fallback = {}) {
  const raw = String(modelRef || '').trim();
  if (!raw) {
    return { provider: String(fallback.provider || ''), model: String(fallback.model || '') };
  }
  const slash = raw.indexOf('/');
  if (slash > 0) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
  return { provider: String(fallback.provider || ''), model: raw };
}

export function textFromEvent(event) {
  // 实测形状（GT14 2.6.23 诊断）：{ type:'assistant/message', data:{ turn, step, message, usage, stream } }
  // —— 文本块在 data.message.content 里；早期的 message/event.content 形态也一并兼容。
  const candidates = [
    event && event.blocks,
    event && event.message && event.message.content,
    event && event.content,
    event && event.data && event.data.blocks,
    event && event.data && event.data.content,
    event && event.data && event.data.message && event.data.message.content,
    event && event.data && event.data.message && event.data.message.blocks,
  ];
  for (const blocks of candidates) {
    if (!Array.isArray(blocks)) continue;
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    const text = parts.join('\n').trim();
    if (text) return text;
  }
  return '';
}

/**
 * agent 会话目录闸门：词法先拒 `..`/`.` 段，再 realpath 两边比较。
 * 目标必须真实存在且是目录——`root\nope` 这种「现在不存在、以后可能被换掉」的路径
 * 不能靠前缀判断放过去。
 */
export function checkAgentCwd(cwd, root, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  // UNC 与设备前缀（\\srv\share、//srv/share、\\.\、\\?\）会让 statSync 去摸网络：不可达时实测阻塞 21s。
  // 这些形态在本插件里没有合法用途，直接拒——判在 stat 之前，别让一条任务把事件循环钉住。
  // Windows 上 `//host/share` 与 `\\host\share` 等价，所以正斜杠形态必须一并拒
  // （第二遍审计 P2-D：之前只拒了反斜杠形态，实测 statSync 仍收到 `//host/share/dir`）。
  if (/^[\\/]{2}/.test(String(cwd || ''))) return { ok: false, reason: 'unc' };
  // v2.6.27（安全审计 P1）：root 自身是 UNC 时 realpathSync 会在不可达共享上阻塞 20s+，
  // exec 侧 resolveCwd 早有同款拦截，agent 侧一直缺。
  if (/^[\\/]{2}/.test(String(root || ''))) return { ok: false, reason: 'unc-root' };
  const segs = String(cwd || '').split(/[\\/]+/);
  if (segs.includes('..') || segs.includes('.')) return { ok: false, reason: 'dots' };
  let realCwd = '';
  let realRoot = '';
  try {
    if (!fsImpl.statSync(cwd).isDirectory()) return { ok: false, reason: 'not-dir' };
    realCwd = (fsImpl.realpathSync.native || fsImpl.realpathSync)(cwd) || '';
    realRoot = (fsImpl.realpathSync.native || fsImpl.realpathSync)(root) || '';
  } catch {
    return { ok: false, reason: 'unresolved' };
  }
  if (!realCwd || !realRoot) return { ok: false, reason: 'unresolved' };
  return isWithin(realCwd, realRoot) ? { ok: true, realCwd, realRoot } : { ok: false, reason: 'outside' };
}

/**
 * @param {{host: object, config?: object, log?: object, now?: Function}} opts
 */
export function createAgentRunner(opts = {}) {
  // v2.6.27（安全审计 P1）：agent 的 note 里有回答原文 / hostError / err.message，
  // 旧版直接 oneLine 上板，回答里复述 token 或家目录路径就原样进看板。这里统一打码。
  const host = opts.host || null;
  const config = opts.config || {};
  const noteSecrets = [config && config.token].filter((s) => typeof s === 'string' && s.length >= 4);
  const noteMask = (s) => maskText(String(s == null ? '' : s), { secrets: noteSecrets, home: os.homedir() });
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const agentTimeoutMs = Number(config.agentTimeoutMs) > 0 ? Number(config.agentTimeoutMs) : 1800000;
  // 每日预算：落在 worker.stateDir（缺省 %LOCALAPPDATA%\dsh-job-worker）。
  const budget = createAgentBudget({
    stateDir: config.stateDir,
    maxPerDay: config.agentBudgetMaxPerDay,
    now,
    fsImpl: opts.fs,
    log,
  });
  // 本机人工审批：同样落 stateDir，与预算一样不接受任务输入。
  const approvals = createAgentApprovals({
    stateDir: config.stateDir,
    now,
    fsImpl: opts.fs,
    log,
  });

  function available() {
    // agent 模式被开关关掉时，「服务在不在」并不代表「能不能跑 agent 任务」：
    // 对外一律说不可用，免得台账（worker_status）谎报可用、排障走错方向。
    if (!config.agentEnabled) return { ok: false, reason: 'agent-disabled' };
    // 打开开关不等于配置完整：0.1.0 起要求 preset 与 cwd 白名单同时给出，
    // 否则任务书就是裸提示词、目录也不受限——配置不全直接 fail closed。
    const misconfigured = missingAgentConfig(config);
    if (misconfigured) return { ok: false, reason: `agent-misconfigured:${misconfigured}` };
    // milestone 2 的策略层：白名单为空 / 工具策略无法落实，都等于「没有准入」。
    const policy = missingAgentPolicy(config);
    if (policy) return { ok: false, reason: policy };
    if (!host || typeof host.available !== 'function') return { ok: false, reason: 'host-missing' };
    try {
      const r = host.available();
      return r && typeof r === 'object' ? r : { ok: Boolean(r), reason: '' };
    } catch (err) {
      return { ok: false, reason: `host-error: ${(err && err.message) || err}` };
    }
  }

  /**
   * 准入拦截的统一出口：形状与 run() 其它分支一致，免得每个分支各写一份。
   * noteFn 收 `stage=agent reason=<reason>` 前缀，调用方在后面补 why/rule/额度等细节。
   */
  function gateBlocked(reason, startedAt, noteFn, extra = {}) {
    const detail = extra && extra.detail ? ` ${extra.detail}` : '';
    return {
      status: 'blocked',
      stage: 'agent',
      reason,
      result: null,
      artifact: (extra && extra.artifact) || '',
      durationMs: now() - startedAt,
      note: noteMask(oneLine(noteFn(`stage=agent reason=${reason}${detail}`), AGENT_NOTE_BUDGET)),
      text: '',
      sessionId: '',
    };
  }

  /**
   * @param {{goal: string, model?: string, cwd?: string}} spec
   * @param {{task?: object, taskId?: string, signal?: AbortSignal}} [runOpts]
   */
  const disposeWithTimeout = async (handle, ms = 1000) => {
    try {
      await Promise.race([
        Promise.resolve(handle.dispose()),
        new Promise((resolve) => setTimeout(resolve, ms)),
      ]);
    } catch {
      /* ignore */
    }
  };

  async function run(spec = {}, runOpts = {}) {
    const startedAt = now();
    const taskId = String(runOpts.taskId || (runOpts.task && runOpts.task.id) || '') || `t-${startedAt}`;
    // agent 模式默认关闭：一条 mode=agent 的任务 = 看板把任意提示词送进本机会话语境
    // （宿主工具全开）。开关不在就 fail closed，而不是"能用就跑"。
    if (!config.agentEnabled) {
      return {
        status: 'blocked',
        stage: 'agent',
        reason: 'agent-disabled',
        result: null,
        artifact: '',
        durationMs: 0,
        note: noteMask(oneLine(
          'stage=agent reason=agent-disabled（agent 模式未启用：配 worker.agentEnabled=true 才会执行 mode=agent 的任务）',
          AGENT_NOTE_BUDGET,
        )),
        text: '',
        sessionId: '',
      };
    }
    const avail = available();
    if (!avail.ok) {
      const why = String(avail.reason || '未知');
      // 把策略层的具体原因透出去（agent-allowlist-empty / agent-tools-unsupported / agent-misconfigured…），
      // 只有「说不清的原因」才归到 agent-unavailable。
      const tag = /^agent-[a-z-]+/.test(why) ? why.split(':')[0] : 'agent-unavailable';
      return {
        status: 'blocked',
        stage: 'agent',
        reason: tag,
        result: null,
        artifact: '',
        durationMs: 0,
        note: noteMask(oneLine(`stage=agent reason=${tag}（${why}）`, AGENT_NOTE_BUDGET)),
        text: '',
        sessionId: '',
      };
    }

    const task = runOpts.task && typeof runOpts.task === 'object' ? runOpts.task : {};
    // 已经在调用前被取消（例如 drain 或人工 cancel）：一步都别走，尤其别开会话。
    if (runOpts.signal && runOpts.signal.aborted) {
      return gateBlocked('canceled', startedAt, (head) => `${head}（任务在开工前已被取消）`);
    }
    const allow = matchAgentAllowlist(config.agentAllowlist, task);
    if (!allow.ok) {
      return gateBlocked('agent-not-allowlisted', startedAt, (head) =>
        `${head}（agentAllowlist 里没有匹配的条目；title/model/goal 前缀至少要命中一条）`,
      );
    }
    const presetVerdict = checkAgentPreset(config.agentPreset, config.agentTools);
    if (!presetVerdict.ok) {
      return gateBlocked(presetVerdict.reason.split(':')[0], startedAt, (head) => `${head}（${presetVerdict.reason}）`, {
        detail: `preset=${oneLine(config.agentPreset, 60)}`,
      });
    }
    const promptVerdict = checkAgentPrompt(spec.goal, config.agentPromptGate);
    if (!promptVerdict.ok) {
      // 不把命中的原文写进 note：那一行本身可能就是凭证。
      return gateBlocked('agent-prompt-denied', startedAt, (head) =>
        `${head} rule=${promptVerdict.rule}${promptVerdict.detail ? ` detail=${promptVerdict.detail}` : ''}`,
      );
    }
    // 人工审批只认**本机**记录（taskId + 提示词指纹），不认任务 note 里的任何标记：
    // note 是提交者能写、worker 也会写的同一字段，认它就等于让提交者自己批自己。
    // 审批由本机操作者用 `worker_control action=approve taskId=…` 写入 stateDir。
    if (config.agentApproval !== 'auto') {
      const approval = approvals.check(taskId, spec.goal);
      if (!approval.ok) {
        const fp = promptFingerprint(spec.goal);
        return gateBlocked(
          'agent-approval-required',
          startedAt,
          (head) =>
            `${head} allow=${allow.id} preset=${config.agentPreset} why=${approval.reason} fp=${fp}` +
            `（需本机审批：worker_control action=approve taskId=${taskId}；审批绑定提示词指纹）`,
          { artifact: 'approval-request' },
        );
      }
    }
    // 预算在这里**预占**（不是等跑完再记）：额度语义是「开始的会话数」。
    // 超时/取消/宿主报错的会话同样烧了额度，如果只在成功时计数，30 分钟的超时任务就白烧。
    // consume 内部是同步的 read→check→write，同一进程内不会两条任务同时通过。
    // 注意：预占放在所有**准入检查**（白名单/提示词/审批/cwd）之后——准入失败时会话
    // 根本没起来，不能白扣额度（第二遍审计 P2-B：否则连投 20 条 cwd 非法任务即可打满当日额度）。
    const sessionId = makeSessionId(taskId);
    const { provider, model } = parseModelRef(spec.model, {
      provider: config.agentProvider,
      model: config.agentModel,
    });
    const cwd = spec.cwd && path.isAbsolute(spec.cwd) ? spec.cwd : os.homedir();
    // workspace 由看板任务书提供：给了 agentCwdRoot 就要求会话目录落在其下，
    // 否则等于让任务自己挑一个目录开会话（可能落在别人的项目里）。
    // 只比词法前缀是不够的：`root\sub\..\..\Windows` 与 root 下的 junction 都能躲过去，
    // 所以先拒 `..`/`.` 段，再 realpath 两边比较，并要求目标真实存在且是目录。
    if (!config.agentCwdRoot && config.allowUnscopedCwd !== true) {
      // v2.6.27（安全审计 P1）：与 exec 侧对齐 —— 未配根就不许任务自带任意 cwd。
      return gateBlocked('agent-cwd-unset', startedAt, (head) =>
        `${head} reason=agent-cwd-unset（未配 worker.agentCwdRoot；配好根目录，或显式 allowUnscopedCwd=true）`);
    }
    if (config.agentCwdRoot) {
      const verdict = checkAgentCwd(cwd, config.agentCwdRoot, { fsImpl: opts.fs || fs });
      if (!verdict.ok) {
        return {
          status: 'blocked',
          stage: 'agent',
          reason: 'agent-cwd-denied',
          result: null,
          artifact: '',
          durationMs: now() - startedAt,
          note: noteMask(oneLine(
            `stage=agent reason=agent-cwd-denied why=${verdict.reason} cwd=${oneLine(cwd, 160)} root=${oneLine(config.agentCwdRoot, 120)}`,
            AGENT_NOTE_BUDGET,
          )),
          text: '',
          sessionId: '',
        };
      }
    }

    const quota = budget.consume();
    if (!quota.ok) {
      return gateBlocked('agent-budget-exceeded', startedAt, (head) =>
        `${head} used=${quota.used}/${quota.limit} date=${quota.date}（提高 worker.agentBudgetMaxPerDay 或等次日）`,
      );
    }

    const trace = `allow=${allow.id} preset=${oneLine(config.agentPreset, 60)} budget=${Math.max(0, quota.used - 1)}/${quota.limit}`;

    let handle = null;
    let timedOut = false;
    let canceled = false;
    let timer = null;
    const controller = new AbortController();
    const onAbort = () => {
      canceled = true;
      try {
        if (handle) host.cancel(handle.agent);
      } catch {
        /* ignore */
      }
    };
    if (runOpts.signal) {
      if (runOpts.signal.aborted) onAbort();
      else {
        try {
          runOpts.signal.addEventListener('abort', onAbort, { once: true });
        } catch {
          /* ignore */
        }
      }
    }

    try {
      handle = await host.start({ sessionId, cwd, provider, model, signal: controller.signal });
    } catch (err) {
      // 会话没起来：退还预占的额度，并摘掉 abort 监听（否则失败任务会留一个 listener）
      const refunded = budget.refund();
      try {
        if (runOpts.signal) runOpts.signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
      return {
        status: 'failed',
        stage: 'agent',
        reason: 'agent-start-failed',
        result: null,
        artifact: '',
        durationMs: now() - startedAt,
        note: noteMask(oneLine(
          `stage=agent reason=agent-start-failed budget=refunded:${refunded.used}/${refunded.limit} ${(err && err.message) || err}`,
          AGENT_NOTE_BUDGET,
        )),
        text: '',
        sessionId,
      };
    }

    // 会话刚建好就被取消（signal 在 start 期间触发）：不要投任务，直接收尾。
    if (canceled) {
      try {
        host.cancel(handle.agent);
      } catch {
        /* ignore */
      }
      // 审计 P2：start 成功但未投任务就被取消时，句柄与 abort 监听都要释放，
      // 否则反复取消会累积未 dispose 的会话。
      try {
        if (runOpts.signal) runOpts.signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
      try {
        if (handle && typeof handle.dispose === 'function') await disposeWithTimeout(handle);
      } catch {
        /* ignore */
      }
      return {
        status: 'blocked',
        stage: 'agent',
        reason: 'canceled',
        result: null,
        artifact: sessionId,
        durationMs: now() - startedAt,
        note: noteMask(oneLine(`stage=agent session=${sessionId} ${trace} reason=canceled（start 后即取消，未投任务）`, AGENT_NOTE_BUDGET)),
        text: '',
        sessionId,
      };
    }

    try {
      // 先投任务、再等空闲：whenIdle 在 turn 还没登记时会立刻 resolve，
      // 顺序反了就会拿到「还没开始就结束」的假完成。
      await host.deliver(handle.agent, String(spec.goal || ''));
      const waitIdle = Promise.resolve().then(() => host.waitIdle(handle.agent));
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            host.cancel(handle.agent);
          } catch {
            /* ignore */
          }
          resolve('timeout');
        }, agentTimeoutMs);
        timer.unref?.();
      });

      await Promise.race([waitIdle, timeoutPromise]);

      const durationMs = now() - startedAt;
      const text = typeof host.finalText === 'function' ? String(host.finalText(handle.agent, sessionId) || '') : '';
      const hostError = typeof host.popError === 'function' ? host.popError(sessionId) : '';
      const base = `stage=agent session=${sessionId} ${trace} dur=${durationMs}ms`;

      if (canceled) {
        return {
          status: 'blocked',
          stage: 'agent',
          reason: 'canceled',
          result: null,
          artifact: sessionId,
          durationMs,
          note: noteMask(oneLine(`${base} reason=canceled`, AGENT_NOTE_BUDGET)),
          text,
          sessionId,
        };
      }
      if (timedOut) {
        return {
          status: 'failed',
          stage: 'agent',
          reason: 'timeout',
          result: null,
          artifact: sessionId,
          durationMs,
          note: noteMask(oneLine(`${base} reason=timeout timeoutMs=${agentTimeoutMs}`, AGENT_NOTE_BUDGET)),
          text,
          sessionId,
        };
      }
      if (hostError) {
        return {
          status: 'failed',
          stage: 'agent',
          reason: 'agent-error',
          result: null,
          artifact: sessionId,
          durationMs,
          note: noteMask(oneLine(`${base} error=${hostError}`, AGENT_NOTE_BUDGET)),
          text,
          sessionId,
        };
      }
      // 额度已在准入层预占（语义是「开始的会话数」），成功路径不再重复计数。
      return {
        status: 'done',
        stage: 'agent',
        reason: '',
        // agent 任务没有脚本断言，`result.ok` 语义是「会话正常结束」；
        // reasons 里留准入轨迹（哪条白名单、哪个 preset、工具策略快照大小），便于审计追溯。
        result: {
          ok: true,
          reasons: [
            `allow:${allow.id}`,
            `preset:${oneLine(config.agentPreset, 60)}`,
            `tools:${(config.agentTools && config.agentTools.allowedPresets ? config.agentTools.allowedPresets.length : 0)}`,
            `budget:${Math.max(0, quota.used - 1)}/${quota.limit}`,
          ],
        },
        artifact: sessionId,
        durationMs,
        note: noteMask(oneLine(`${base} text=${text ? text.length : 0}ch${text ? '' : ' no-text'}${text ? ' answer="' + oneLine(text, 160) + '"' : ''}`, AGENT_NOTE_BUDGET)),
        text,
        sessionId,
      };
    } catch (err) {
      return {
        status: 'failed',
        stage: 'agent',
        reason: 'agent-run-failed',
        result: null,
        artifact: sessionId,
        durationMs: now() - startedAt,
        note: noteMask(oneLine(`stage=agent session=${sessionId} reason=agent-run-failed ${(err && err.message) || err}`, AGENT_NOTE_BUDGET)),
        text: '',
        sessionId,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (runOpts.signal) {
        try {
          runOpts.signal.removeEventListener('abort', onAbort);
        } catch {
          /* ignore */
        }
      }
      try {
        if (handle && typeof handle.dispose === 'function') await disposeWithTimeout(handle);
      } catch (err) {
        log.warn(`agent dispose 失败 session=${sessionId} ${(err && err.message) || err}`);
      }
    }
  }

  return { run, available, approvals, budget, get host() { return host; } };
}

/**
 * agent 模式下必须同时配置的项；返回缺失的键名（逗号分隔），齐全或未开启返回空串。
 * 0.1.0 不支持 agent 交付，这里的用途是：即便有人手动打开开关，也不允许裸配置运行
 * （没有 preset = 任务书即提示词；没有 cwd 白名单 = 会话目录不受限）。
 */
export function missingAgentConfig(config = {}) {
  if (!config.agentEnabled) return '';
  const missing = [];
  if (!String(config.agentPreset || '').trim()) missing.push('agentPreset');
  if (!String(config.agentCwdRoot || '').trim()) missing.push('agentCwdRoot');
  return missing.join(',');
}

/**
 * milestone 2 的策略层是否就绪。返回空串表示通过，否则是 worker_status / 任务 note
 * 里的原因码。两条都是 fail closed：
 *   - 白名单为空：没有条目能匹配，等于「什么都能进」，不如什么都别进；
 *   - 工具策略要求按预设运行时禁工具：0.2.0 不做这件事，说了做不到就只能拒绝。
 */
export function missingAgentPolicy(config = {}) {
  if (!config.agentEnabled) return '';
  const list = Array.isArray(config.agentAllowlist) ? config.agentAllowlist : [];
  if (list.length === 0) return 'agent-allowlist-empty';
  const tools = config.agentTools || {};
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  if (deny.length) return `agent-tools-unsupported:${deny.join(',')}`;
  // preset 白名单：可用性判定必须和 run() 用同一个 checkAgentPreset，
  // 否则 worker_status 会说「可用」，而每个任务都被 agent-preset-denied 拒（审计第二遍实测过）。
  const preset = checkAgentPreset(config.agentPreset, tools);
  if (!preset.ok) return preset.reason;
  // 提示词闸门自己写错（extraRules 编不过 / 疑似 ReDoS）：这不是「少一条规则」，是配置无效
  const gate = config.agentPromptGate || {};
  if (gate.invalid) return 'agent-prompt-gate-invalid';
  return '';
}

/**
 * DSH 适配层：唯一直接使用 agentLoop / sessions 的地方。
 * 失败时全部返回可读 reason，不抛异常（抛了会把主循环带走）。
 */
export function createDshAgentHost(opts = {}) {
  const ctx = opts.ctx;
  const config = opts.config || {};
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  const errors = new Map();
  /** errors Map 的上界：只留最近 200 条，避免长跑进程里无界增长。 */
  const MAX_ERRORS = 200;
  /**
   * 我们自己起过的会话 id（含 agent 侧 id）。
   * v2.6.22：agent/error 的 payload 不一定带 session.id —— 有的版本只给 agent.id，
   * 而 agent.id 与 sessionId 未必相同。旧逻辑只认 `worker-` 前缀，
   * 这类错误会被整条丢掉，症状是「任务 done、无文本、也没有失败原因」。
   */
  const ownSessionIds = new Set();
  const MAX_OWN = 500;
  /** agent.id → 我们自己的 sessionId：错误事件的键未必等于 sessionId，统一回填。 */
  const agentToSession = new Map();
  let lastDroppedTrace = 0;
  const rememberSession = (id) => {
    const key = String(id || '');
    if (!key) return;
    ownSessionIds.add(key);
    if (ownSessionIds.size > MAX_OWN) {
      const oldest = ownSessionIds.values().next().value;
      if (oldest !== undefined) ownSessionIds.delete(oldest);
    }
  };
  let unsubscribe = null;

  const readService = (key) => {
    try {
      return ctx && ctx[key] ? ctx[key] : null;
    } catch {
      return null;
    }
  };
  const agentLoop = readService('agentLoop');
  const sessions = readService('sessions');

  // rc.3 的坑：kick() 会把 turn 里的异常吞掉，症状是「任务 20ms 就完成、没有任何输出」。
  // 唯一能看见错误的是 agent/error 事件 —— 必须订阅，否则失败看起来像成功。
  try {
    if (ctx && typeof ctx.on === 'function') {
      const off = ctx.on('agent/error', (payload) => {
        try {
          const id =
            (payload && payload.session && payload.session.id) ||
            (payload && payload.agent && payload.agent.id) ||
            (payload && payload.sessionId) ||
            '';
          const msg = (payload && (payload.error && (payload.error.message || payload.error))) || 'agent/error';
          // 只收我们自己起的会话（sessionId 以 worker- 开头）：否则任何会话的报错
          // 都会被塞进这张表，既会串到别人任务上，Map 也会无界增长。
          // v2.6.22：除了前缀，也认我们登记过的 id（含 agent.id）—— 见 ownSessionIds 注释。
          const rawId = String(id || '');
          const mapped = agentToSession.get(rawId) || '';
          const isOwn = Boolean(rawId) && (rawId.startsWith('worker-') || ownSessionIds.has(rawId));
          if (isOwn) {
            const key = mapped || rawId;
            errors.set(key, String(msg).slice(0, 300));
            if (mapped) errors.set(rawId, String(msg).slice(0, 300));
            if (errors.size > MAX_ERRORS) {
              const oldest = errors.keys().next().value;
              if (oldest !== undefined) errors.delete(oldest);
            }
          } else if (rawId) {
            // 诊断用：被丢弃的错误留一条痕迹，避免「完全查不到原因」。节流到 60 秒一条。
            const nowTs = Date.now();
            if (nowTs - lastDroppedTrace > 60000) {
              lastDroppedTrace = nowTs;
              log.warn(`agent/error 丢弃（非本插件会话）id=${rawId.slice(0, 60)} msg=${String(msg).slice(0, 160)}`);
            }
          }
        } catch {
          /* ignore */
        }
      });
      // ctx.on 的返回值是退订函数（cordis 约定）：留着，dispose 时调用，
      // 否则插件重载会把同一个 handler 越挂越多。
      if (typeof off === 'function') unsubscribe = off;
    }
  } catch (err) {
    log.warn(`agent/error 订阅失败：${(err && err.message) || err}`);
  }

  return {
    /** 退订 + 清表：插件 dispose 时调用（index.js 的 disposeAll 会调它）。 */
    dispose() {
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
      errors.clear();
    },

    available() {
      if (!agentLoop || typeof agentLoop.createAgent !== 'function') {
        return { ok: false, reason: 'agentLoop.createAgent 不可用（DSH 需在插件激活前提供 agentLoop；晚注册要重载插件）' };
      }
      if (!sessions || typeof sessions.get !== 'function') {
        return { ok: false, reason: 'sessions 服务不可用（DSH 需在插件激活前提供 sessions；晚注册要重载插件）' };
      }
      return { ok: true, reason: '' };
    },

    async start({ sessionId, cwd, provider, model, signal } = {}) {
      const meta = {};
      if (cwd) meta.cwd = cwd;
      // preset 决定会话能用哪些工具/权限（0.1.0 起 agent 模式要求显式配置）。
      if (config.agentPreset) meta.agentPreset = config.agentPreset;
      const agentOptions = {};
      if (provider) agentOptions.provider = provider;
      if (model) agentOptions.model = model;
      const handle = await agentLoop.createAgent(ctx, {
        sessionId,
        meta: Object.keys(meta).length ? meta : undefined,
        agentOptions: Object.keys(agentOptions).length ? agentOptions : undefined,
        signal,
      });
      // v2.6.22：把 agent 侧 id 记下来。错误事件的 payload.session.id 与 agent.id
      // 未必都等于 sessionId，不登记就会把「本会话的错误」当成别人的丢弃。
      try {
        rememberSession(sessionId);
        const aid = handle && handle.agent && handle.agent.id;
        const sid2 = handle && handle.agent && handle.agent.session && handle.agent.session.id;
        for (const cand of [aid, sid2]) {
          const key = String(cand || '');
          if (!key) continue;
          rememberSession(key);
          agentToSession.set(key, String(sessionId));
        }
      } catch {
        /* ignore */
      }
      return handle;
    },

    async deliver(agent, text) {
      // v2.6.21：followup() 收的是 **UserMessage 实例**，不是随手拼的对象。
      // DSH 的 createUserMessage() = deepFreeze(structuredClone({ ...input, id, role:'user' }))；
      // 少了 role/id，inbox 会收下但不进 driver —— 症状是「会话 2.5 秒就结束、
      // 没有任何模型请求、取不到文本、也不报错」（GT14 实测 budget 涨了 1、text=0ch）。
      // source 仍必须是「插件来源」：省略会被当成人类输入（rc.3 实测）。
      const message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(text || '') }],
        source: { kind: config.agentSourceKind || 'cordis-host-runner' },
      };
      await agent.followup(message);
    },

    async waitIdle(agent) {
      await agent.whenIdle();
    },

    cancel(agent) {
      try {
        if (agent && typeof agent.cancel === 'function') agent.cancel();
      } catch {
        /* ignore */
      }
    },

    finalText(agent, sessionId) {
      let session = null;
      try {
        session = (agent && agent.session) || (sessions && sessions.get ? sessions.get(sessionId) : null);
      } catch {
        session = null;
      }
      const events = session && typeof session.ownEvents === 'function' ? session.ownEvents() : [];
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || ev.type !== 'assistant/message') continue;
        const text = textFromEvent(ev);
        if (text) return text;
      }
      // v2.6.23 兜底：事件类型/字段形状不止一种（assistant/message 之外还有 chunk/attempt，
      // 数据可能挂在 data.message / data.blocks / content 上）。倒序扫一遍所有事件，
      // 只要能捞到 text 块就返回 —— 拿不到再走诊断日志。
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev) continue;
        // 别把「我们自己投进去的任务书」当成回答：user/* 事件里有同样的 text 块。
        if (String(ev.type || '').startsWith('user/')) continue;
        const text = textFromEvent(ev);
        if (text) return text;
      }
      // 诊断：把「有没有会话 / 事件类型分布 / 最后一条 assistant 事件的块类型」写进日志，
      // 免得每次只能靠猜（GT14 那两次就是 done + text=0ch，日志里什么都没有）。
      try {
        const types = new Map();
        for (const ev of events) {
          const t = String((ev && ev.type) || '?');
          types.set(t, (types.get(t) || 0) + 1);
        }
        const brief = [...types.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([t, n]) => `${t}×${n}`)
          .join(' ');
        log.warn(`agent 无文本：session=${session ? 'yes' : 'no'} events=${events.length} ${brief}`.slice(0, 180));
        let last = null;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i] && String(events[i].type || '').startsWith('assistant/')) {
            last = events[i];
            break;
          }
        }
        if (last) {
          const raw = last.data || last;
          const blocks = raw.blocks || (raw.message && raw.message.content) || raw.content || [];
          const blockTypes = Array.isArray(blocks) ? blocks.map((b) => String((b && b.type) || '?')).slice(0, 6).join(',') : typeof blocks;
          const keys = Object.keys(raw).slice(0, 8).join(',');
          log.warn(`agent 无文本：lastType=${last.type} blockTypes=[${blockTypes}] keys=[${keys}]`.slice(0, 180));
        }
      } catch {
        /* ignore */
      }
      return '';
    },

    popError(sessionId) {
      const key = String(sessionId || '');
      const msg = errors.get(key) || '';
      if (msg) errors.delete(key);
      return msg;
    },
  };
}
