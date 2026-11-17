// worker 主循环：轮询 → 认领 → 执行 → 回写，外加心跳、租约、退避、并发上限、
// 取消，以及「重启后绝不重放」的孤儿任务处理。
//
// 这一层不含任何 DSH / HTTP 细节：board 客户端与 executeTask 都是注入的，
// 所以单测可以完全离线地覆盖 claim 竞态、租约过期、断线退避、并发上限这些
// 靠人工点不出来的场景。
//
// 状态机（一台机器一次最多 maxConcurrent 个任务）：
//   idle ──tick──▶ claiming ──claim ok──▶ running ──mark──▶ idle
//                      └─claim 409（别人抢到）→ idle
//   mode: on（接单）/ drain（做完手上的，不接新的）/ off（不接也不跑）
//
// 绝不重放：重启后遇到「自己名下、租约已过期、还停在 claimed/running」的任务，
// 按 orphanPolicy 标 blocked（默认）或 requeue —— 不会重新执行一遍。

import crypto from 'node:crypto';
import os from 'node:os';
import { createLogger, maskText } from './log.js';

export const TERMINAL_STATUSES = new Set(['done', 'failed', 'blocked']);
export const NOTE_LIMIT = 480;
/** 租约还剩多久算「另一个活着的实例在跑」，不要碰 */
export const ORPHAN_GRACE_MS = 60_000;
export const TICK_IN_FLIGHT = 'tick-in-flight';

/** 机器名比较键：board 侧 `_canon_machine` 归一化过大小写，我们也按小写比。 */
export function machineKey(m) {
  return String(m ?? '').trim().toLowerCase();
}

/** board 的 tasks 是「以 id 为键的对象」，不是数组——这里统一成数组。 */
export function taskList(tasks) {
  if (Array.isArray(tasks)) return tasks.filter((t) => t && typeof t === 'object');
  if (tasks && typeof tasks === 'object') {
    return Object.entries(tasks)
      .filter(([, t]) => t && typeof t === 'object')
      .map(([id, t]) => ({ id, ...t }));
  }
  return [];
}

/** 这个任务现在可以被我认领吗？ */
export function isClaimable(task, opts = {}) {
  if (!task || !task.id) return false;
  if (String(task.status || '') !== 'queued') return false;
  if (String(task.dispatch || '') !== 'auto') return false;
  if (machineKey(task.machine) !== machineKey(opts.machine)) return false;
  // remote_id 非空 = 曾被 dsh-remote-agent / 网关接管过，我们不抢（避免双执行）
  if (task.remote_id) return false;
  if (opts.jobs && opts.jobs.has(task.id)) return false;
  if (opts.skipIds && opts.skipIds.has(task.id)) return false;
  return true;
}

export function sortByCreatedAt(a, b) {
  const ca = Number((a && a.created_at) || 0);
  const cb = Number((b && b.created_at) || 0);
  if (ca !== cb) return ca - cb;
  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
}

function clampNote(text, limit = NOTE_LIMIT) {
  const t = String(text || '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= limit ? t : t.slice(0, limit - 1) + '…';
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   config: object,
 *   board: object,
 *   executeTask: Function,
 *   log?: object,
 *   now?: Function,
 *   sleep?: Function,
 *   randomId?: Function,
 *   recoverOnStart?: boolean,
 * }} opts
 */
export function createWorker(opts = {}) {
  const config = opts.config || {};
  const board = opts.board;
  const executeTask = opts.executeTask;
  if (!board || typeof board.snapshot !== 'function') throw new Error('createWorker: 缺少 board 客户端');
  if (typeof executeTask !== 'function') throw new Error('createWorker: 缺少 executeTask');

  const log = opts.log || createLogger({ limit: config.logLimit });
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const randomId = typeof opts.randomId === 'function' ? opts.randomId : () => crypto.randomBytes(2).toString('hex');
  const recoverOnStart = opts.recoverOnStart !== false;

  const machine = String(config.machine || '').trim();
  if (!machine) throw new Error('createWorker: config.machine 为空');
  const workerId = String(config.workerId || machine).trim();
  const instanceId = `${workerId}/${process.pid}-${randomId()}`;
  const preamble = `worker:${workerId} inst:${instanceId}`;
  const maxConcurrent = Math.max(1, Number(config.maxConcurrent) || 1);
  const pollMs = Math.max(200, Number(config.pollMs) || 2000);
  const beatMs = Math.max(1000, Number(config.beatMs) || 30000);
  const leaseMinutes = Math.max(1, Number(config.leaseMinutes) || 10);
  const backoffMs = Math.max(200, Number(config.backoffMs) || 2000);
  const maxBackoffMs = Math.max(backoffMs, Number(config.maxBackoffMs) || 60000);

  const jobs = new Map();
  const stats = { claimed: 0, done: 0, failed: 0, blocked: 0, claimErrors: 0, tickErrors: 0, beats: 0 };
  let mode = config.workerMode === 'off' ? 'off' : config.workerMode === 'drain' ? 'drain' : 'on';
  let running = false;
  let stopped = false;
  let loopPromise = null;
  let wake = null;
  let tickInFlight = false;
  let consecutiveFailures = 0;
  let lastTickAt = 0;
  let lastBoardOkAt = 0;
  let lastError = '';
  let orphanRecovery = null;

  // ── 可中断 sleep：stop() 要立刻返回，而不是等一个 pollMs ────────────────
  function sleepInterruptible(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve('timeout');
      }, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve('wake');
      };
    });
  }

  function backoffDelay() {
    const exp = Math.min(consecutiveFailures, 6);
    return Math.min(maxBackoffMs, backoffMs * 2 ** Math.max(0, exp - 1));
  }

  // ── 认领 ────────────────────────────────────────────────────────────────
  async function claimOne(task) {
    const res = await board.claim({
      taskId: task.id,
      machine,
      holder: instanceId,
      minutes: leaseMinutes,
      note: preamble,
    });
    if (!res.ok) {
      stats.claimErrors += 1;
      // 409 = 被别人抢了 / holder 冲突，正常竞态，下一轮再说
      if (res.status === 409 || res.status === 400 || res.status === 404) {
        log.debug(`认领未成功 task=${task.id} status=${res.status} ${res.error}`);
        return { started: false };
      }
      lastError = `claim: ${res.error}`;
      log.warn(`认领失败 task=${task.id} ${res.error}`);
      return { started: false, stop: true };
    }
    stats.claimed += 1;
    log.info(`已认领 task=${task.id} title=${oneLineSafe(task.title, 40)}`);
    startJob(task);
    return { started: true };
  }

  function oneLineSafe(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
  }

  // ── 任务生命周期 ────────────────────────────────────────────────────────
  function startJob(task) {
    const controller = new AbortController();
    const job = {
      taskId: task.id,
      title: String(task.title || ''),
      mode: String(task.mode || ''),
      startedAt: now(),
      controller,
      progress: '',
      beats: 0,
      beatErrors: 0,
      timer: null,
      done: false,
      promise: null,
    };
    jobs.set(task.id, job);

    const promise = (async () => {
      try {
        await markRunning(task, job);
        scheduleBeat(job);
        let outcome;
        try {
          outcome = await executeTask(task, {
            signal: controller.signal,
            onProgress: (text) => {
              // 进度会随 beat 上行到看板，落板前先脱敏（与 note/artifact 同一条通道）。
              // 先脱敏再截断：反过来会把跨边界的 token 截成半截，掩码就匹配不到了。
              job.progress = maskText(String(text || ''), {
                secrets: [config.token],
                home: os.homedir(),
              }).slice(0, 200);
            },
          });
        } catch (err) {
          const msg = (err && err.message) || String(err);
          log.error(`执行异常 task=${task.id} ${msg}`);
          outcome = {
            status: 'failed',
            stage: taskModeStage(task),
            note: `stage=${taskModeStage(task)} reason=internal-error ${oneLineSafe(msg, 200)}`,
            result: null,
            artifact: '',
          };
        }
        await finishTask(task, job, outcome || {});
      } catch (err) {
        log.error(`任务收尾异常 task=${task.id} ${(err && err.message) || err}`);
      } finally {
        job.done = true;
        stopBeat(job);
        jobs.delete(task.id);
      }
    })();
    job.promise = promise;
    // 兜底：任何漏网 rejection 都不许变成 unhandled 把常驻进程带走，但也不能静默吞掉
    promise.catch((err) => {
      log.error(`任务 promise 异常 task=${task.id} ${(err && err.message) || err}`);
    });
    return promise;
  }

  async function markRunning(task, job) {
    const stage = taskModeStage(task);
    const res = await board.mark({
      taskId: task.id,
      machine,
      holder: instanceId,
      status: 'running',
      note: `${preamble} stage=${stage} title=${oneLineSafe(task.title, 60)}`,
    });
    if (!res.ok) {
      // 认领已经成功、心跳还会把 claimed→running，所以这里失败只记日志
      log.warn(`标记 running 失败 task=${task.id} ${res.error}`);
      job.markRunningError = res.error;
    }
  }

  /**
   * result 只允许契约里的四个字段，且 reasons 逐条脱敏、截断到板子的上限。
   * 重建而不是「深拷贝后改」：脚本塞进来的额外字段本来也过不了板子的 _clean_result，
   * 与其让它夹带，不如在这里就丢掉。
   */
  function maskResult(result, mask) {
    if (!result || typeof result !== 'object') return null;
    if (typeof result.ok !== 'boolean') return null;
    const out = { ok: result.ok };
    for (const key of ['expected', 'actual']) {
      const n = Number(result[key]);
      if (Number.isFinite(n) && n >= 0 && n <= 1e12) out[key] = n;
    }
    if (Array.isArray(result.reasons)) {
      const reasons = result.reasons
        .filter((r) => typeof r === 'string' && r.trim())
        .slice(0, 5)
        .map((r) => mask(String(r).trim()).slice(0, 120));
      if (reasons.length) out.reasons = reasons;
    }
    return out;
  }

  async function finishTask(task, job, outcome) {
    const status = TERMINAL_STATUSES.has(outcome.status) ? outcome.status : 'failed';
    const stage = String(outcome.stage || taskModeStage(task));
    // note / artifact 会落到看板上（UI、日志、备份都看得到），出去之前必须脱敏：
    // 脚本完全可能把 token 或家目录打到 stderr，而 exec-runner 只做截断不做脱敏。
    const mask = (text) => maskText(String(text || ''), { secrets: [config.token], home: os.homedir() });
    const note = clampNote(mask(`${preamble} ${outcome.note || `stage=${stage} status=${status}`}`));
    const body = { status, note };
    // result 的 reasons 完全由脚本 stdout 控制（DSH_RESULT），看板侧只做形状校验、
    // 不做脱敏 —— 不在这里过一遍 mask，脚本把 token 塞进 reasons 就能原样落板。
    if (outcome.result) body.result = maskResult(outcome.result, mask);
    if (outcome.artifact) body.artifact = mask(String(outcome.artifact)).slice(0, 300);

    const res = await markWithRetry(task.id, body);
    const durationMs = now() - job.startedAt;
    if (res.ok) {
      stats[status] = (stats[status] || 0) + 1;
      log.info(`任务结束 task=${task.id} status=${status} dur=${durationMs}ms`);
    } else if (
      res.status === 409
      && (TERMINAL_STATUSES.has(String((res.data || {}).status || '')) || /终态/.test(String(res.error || '')))
    ) {
      log.info(`任务已在板上终结，跳过收尾回写 task=${task.id} status=${status}`);
    } else {
      stats.tickErrors += 1;
      lastError = `mark: ${res.error}`;
      log.error(`回写失败 task=${task.id} status=${status} ${res.error}（任务会停在 running，等租约过期后由孤儿策略接管）`);
    }
  }

  /** 只在网络/5xx/429 上重试：4xx 是语义错误，重试无意义（board 的 409 也是一样）。 */
  async function markWithRetry(taskId, body, attempts = 3) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      last = await board.mark({ taskId, machine, holder: instanceId, ...body });
      if (last.ok) return last;
      const retryable = last.network || last.status === 429 || last.status >= 500;
      if (!retryable) return last;
      if (i < attempts - 1) await sleep(Math.min(5000, 400 * 2 ** i));
    }
    return last;
  }

  function scheduleBeat(job) {
    if (job.done || !running) return;
    job.timer = setTimeout(async () => {
      job.timer = null;
      if (job.done) return;
      try {
        const res = await board.beat({
          taskId: job.taskId,
          machine,
          holder: instanceId,
          minutes: leaseMinutes,
          progress: job.progress || '',
        });
        if (res.ok) {
          job.beats += 1;
          job.beatErrors = 0;
          stats.beats += 1;
        } else if (
          res.status === 409
          && (TERMINAL_STATUSES.has(String((res.data || {}).status || '')) || /终态任务/.test(String(res.error || '')))
        ) {
          // v2.6.11（sec-v2611 P3-B）：板子已把任务标成终态，这是语义拒绝而非网络故障；
          // 停止心跳与本地执行，不累计 beatErrors，也不把日志写成“任务会停在 running”。
          log.info(`任务已是终态，停止心跳与本地执行 task=${job.taskId}`);
          try {
            job.controller.abort();
          } catch {
            /* ignore */
          }
          return;
        } else {
          job.beatErrors += 1;
          log.warn(`心跳失败 task=${job.taskId} status=${res.status} ${res.error}`);
        }
      } catch (err) {
        job.beatErrors += 1;
        log.warn(`心跳异常 task=${job.taskId} ${(err && err.message) || err}`);
      }
      // v2.6.6（外部审查 S-6）：连续 3 次心跳失败就本地取消，避免租约过期后
      // 任务被别的实例重新认领、同一 allowlist 脚本双跑。
      if (!job.done && job.beatErrors >= 3) {
        log.error(`心跳连续失败 ${job.beatErrors} 次，本地取消 task=${job.taskId}`);
        try {
          job.controller.abort();
        } catch {
          /* ignore */
        }
      }
      if (!job.done) scheduleBeat(job);
    }, beatMs);
    job.timer.unref?.();
  }

  function stopBeat(job) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  function taskModeStage(task) {
    const mode = String((task && task.mode) || '').toLowerCase();
    if (mode === 'agent') return 'agent';
    if (mode.startsWith('maint')) return 'maint';
    return 'exec';
  }

  // ── 一轮轮询 ────────────────────────────────────────────────────────────
  async function tick() {
    if (stopped) return { skipped: 'stopped', claimed: [] };
    if (tickInFlight) return { skipped: TICK_IN_FLIGHT };
    tickInFlight = true;
    lastTickAt = now();
    try {
      if (mode !== 'on') return { skipped: 'mode', mode };
      if (jobs.size >= maxConcurrent) return { skipped: 'busy', running: jobs.size };

      const snap = await board.snapshot();
      if (!snap.ok) {
        consecutiveFailures += 1;
        stats.tickErrors += 1;
        lastError = `snapshot: ${snap.error}`;
        log.warn(`拉取看板失败（连续 ${consecutiveFailures} 次）：${snap.error}`);
        return { skipped: 'board', error: snap.error, backoffMs: backoffDelay() };
      }
      consecutiveFailures = 0;
      lastBoardOkAt = now();
      lastError = '';

      const tasks = taskList(snap.data && snap.data.tasks);
      const candidates = tasks.filter((t) => isClaimable(t, { machine, jobs })).sort(sortByCreatedAt);
      const started = [];
      for (const task of candidates) {
        if (jobs.size >= maxConcurrent) break;
        if (mode !== 'on') break;
        const res = await claimOne(task);
        if (res.started) started.push(task.id);
        else if (res.stop) break;
      }
      if (started.length) log.info(`本轮认领 ${started.length} 个：${started.join(', ')}`);
      return { claimed: started, candidates: candidates.length };
    } finally {
      tickInFlight = false;
    }
  }

  // ── 孤儿任务：重启后接管，但绝不重放 ────────────────────────────────────
  async function recoverOrphans() {
    if (config.orphanPolicy === 'ignore') return { skipped: 'policy' };
    const snap = await board.snapshot();
    if (!snap.ok) {
      log.warn(`孤儿检查跳过（看板不可达）：${snap.error}`);
      return { error: snap.error };
    }
    const tasks = taskList(snap.data && snap.data.tasks);
    const holderPrefix = `${workerId}/`;
    const mine = tasks.filter((t) => {
      if (!['claimed', 'running'].includes(String(t.status || ''))) return false;
      if (machineKey(t.machine) !== machineKey(machine)) return false;
      if (jobs.has(t.id)) return false;
      // 归属只看结构化字段 holder（`<workerId>/<pid>-<rand>`）。
      // 没有 holder 的任务**不自动接管**：note 是任务书作者可写的自由文本，靠它判归属
      // 等于把「接管谁的任务」交给对方。这类任务留给人工/看板处理（0.1.0 明确不支持）。
      const holder = String(t.holder || '');
      return Boolean(holder) && holder.startsWith(holderPrefix);
    });
    const adopted = [];
    for (const task of mine) {
      const leaseUntilMs = Number(task.lease_until || 0) * 1000;
      if (leaseUntilMs && leaseUntilMs > now() - ORPHAN_GRACE_MS) {
        // 租约还在：可能是同机另一个活着的实例，别抢
        log.debug(`孤儿检查跳过 task=${task.id}（租约未过期）`);
        continue;
      }
      const status = config.orphanPolicy === 'requeue' ? 'queued' : 'blocked';
      const note =
        status === 'queued'
          ? `${preamble} stage=claim reason=orphan-requeue（重启接管，重新排队）`
          : `${preamble} stage=claim reason=orphan（重启接管，未重放执行，请人工确认）`;
      // 不带 holder：老实例 id 已失效，带上会 409
      const res = await board.mark({ taskId: task.id, machine, status, note });
      if (res.ok) {
        adopted.push(task.id);
        log.warn(`孤儿任务 task=${task.id} → ${status}`);
      } else {
        log.warn(`孤儿任务接管失败 task=${task.id} ${res.error}`);
      }
    }
    return { adopted, checked: mine.length };
  }

  // ── 主循环 ──────────────────────────────────────────────────────────────
  async function loop() {
    while (running) {
      let delay = pollMs;
      try {
        const res = await tick();
        if (res && res.backoffMs) delay = res.backoffMs;
      } catch (err) {
        stats.tickErrors += 1;
        consecutiveFailures += 1;
        lastError = `tick: ${(err && err.message) || err}`;
        log.error(`轮询异常：${(err && err.message) || err}`);
        delay = backoffDelay();
      }
      if (!running) break;
      await sleepInterruptible(delay);
    }
  }

  async function start() {
    if (running) return { ok: true, already: true };
    if (mode === 'off') return { ok: false, reason: 'mode-off' };
    running = true;
    stopped = false;
    if (recoverOnStart) {
      orphanRecovery = recoverOrphans().catch((err) => {
        log.warn(`孤儿检查异常：${(err && err.message) || err}`);
        return { error: (err && err.message) || String(err) };
      });
    }
    loopPromise = loop();
    loopPromise.catch((err) => log.error(`主循环退出：${(err && err.message) || err}`));
    log.info(
      `worker 启动 machine=${machine} board=${config.boardUrl} mode=${mode} maxConcurrent=${maxConcurrent} allowlist=${(config.allowlist || []).length}`,
    );
    return { ok: true, machine, instanceId };
  }

  async function stop(options = {}) {
    running = false;
    stopped = true;
    if (wake) wake();
    const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 0;
    if (loopPromise) {
      await Promise.race([loopPromise.catch(() => {}), sleep(Math.max(1, waitMs === 0 ? 1 : waitMs || 1500))]);
    }
    for (const job of jobs.values()) {
      stopBeat(job);
      // v2.6.6 复审 P2-5：停止心跳但子进程还在跑，租约过期会被别的实例重认领 → 双执行。
      try { job.controller.abort(); } catch { /* ignore */ }
    }
    log.info('worker 停止');
    return { ok: true, running: jobs.size };
  }

  /** 把手上的任务做完，但不接新的（升级前用）。 */
  async function drain(options = {}) {
    mode = 'drain';
    log.info('worker 进入 drain：不再接新任务');
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
    if (!timeoutMs) return { ok: true, mode };
    const drained = await waitForIdle({ timeoutMs });
    return { ok: drained, mode, running: jobs.size };
  }

  function resume() {
    mode = 'on';
    stopped = false;
    if (wake) wake();
    log.info('worker 恢复接单');
    return { ok: true, mode, running };
  }

  async function waitForIdle(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
    const startedAt = now();
    while (jobs.size > 0) {
      if (now() - startedAt >= timeoutMs) return false;
      await sleep(50);
    }
    return true;
  }

  function cancelTask(taskId) {
    const job = jobs.get(String(taskId || ''));
    if (!job) return { ok: false, error: 'not-running', taskId };
    try {
      job.controller.abort();
    } catch {
      /* ignore */
    }
    log.warn(`取消任务 task=${taskId}`);
    return { ok: true, taskId };
  }

  function status() {
    return {
      ok: true,
      machine,
      workerId,
      instanceId,
      mode,
      running,
      boardUrl: config.boardUrl,
      maxConcurrent,
      pollMs,
      beatMs,
      leaseMinutes,
      approvalMode: config.approvalMode,
      allowInline: Boolean(config.allowInline),
      allowlist: config.allowlist || [],
      orphanPolicy: config.orphanPolicy,
      jobs: [...jobs.values()].map((j) => ({
        taskId: j.taskId,
        title: j.title,
        mode: j.mode,
        startedAt: j.startedAt,
        elapsedMs: now() - j.startedAt,
        beats: j.beats,
        beatErrors: j.beatErrors,
        progress: j.progress,
      })),
      stats: { ...stats },
      consecutiveFailures,
      lastTickAt,
      lastBoardOkAt,
      lastError,
      orphanRecovery: orphanRecovery ? 'scheduled' : 'none',
      now: now(),
    };
  }

  return {
    start,
    stop,
    drain,
    resume,
    tick,
    status,
    cancelTask,
    waitForIdle,
    recoverOrphans,
    get instanceId() {
      return instanceId;
    },
    get workerId() {
      return workerId;
    },
    get machine() {
      return machine;
    },
    get jobs() {
      return jobs;
    },
    get mode() {
      return mode;
    },
  };
}
