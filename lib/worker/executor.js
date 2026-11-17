// 任务执行总入口：task → spec → 对应的 runner。
//
// 为什么单独一层：worker 主循环不该知道 mode 契约的细节；单测也能在这里
// 用假 runner 精确断言「什么任务走哪条路、被拒的理由是什么」。

import { parseTaskSpec } from './task-spec.js';
import { createExecRunner } from './exec-runner.js';

export function createTaskExecutor(opts = {}) {
  const config = opts.config || {};
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  const execRunner = opts.execRunner || createExecRunner({ config, log });
  const agentRunner = opts.agentRunner || null;
  const maintenanceRunner = opts.maintenanceRunner || null;

  /**
   * @param {object} task
   * @param {{signal?: AbortSignal, onProgress?: Function}} [ctx]
   */
  return async function executeTask(task, ctx = {}) {
    const parsed = parseTaskSpec(task, {
      allowInline: Boolean(config.allowInline),
      maxTimeoutMs: Number(config.execTimeoutMs) || undefined,
    });

    if (parsed.kind === 'invalid') {
      log.warn(`任务 ${task && task.id} spec 非法：${parsed.reason} ${parsed.error}`);
      return {
        status: 'blocked',
        stage: 'exec',
        reason: parsed.reason,
        result: null,
        artifact: '',
        durationMs: 0,
        note: `stage=exec reason=${parsed.reason}（${parsed.error}）`,
      };
    }

    if (parsed.kind === 'agent') {
      if (!agentRunner) {
        // 两种不同的「没有 agent」要分开报：开关没开（agent-disabled，运维改配置即可）
        // 与开关开了但 host 没接起来（agent-unavailable）。合并成一个词会让 README/CHANGELOG
        // 承诺的 agent-disabled 在生产路径上根本不可达（code review P2）。
        const disabled = config.agentEnabled === false || config.agentEnabled === undefined;
        const reason = disabled ? 'agent-disabled' : 'agent-unavailable';
        return {
          status: 'blocked',
          stage: 'agent',
          reason,
          result: null,
          artifact: '',
          durationMs: 0,
          note: disabled
            ? 'stage=agent reason=agent-disabled（worker.agentEnabled=false，本机不接 agent 任务）'
            : 'stage=agent reason=agent-unavailable（开关已开但 agent host 未就绪）',
        };
      }
      const out = await agentRunner.run(parsed.spec, { task, taskId: task && task.id, signal: ctx.signal });
      if (parsed.reason) out.note = `${out.note} ${parsed.reason}`;
      return out;
    }

    // maintenance（只读通道）：不 spawn、不碰 allowlist —— 它没有命令面，
    // 所以拒绝理由与 exec 的 approval-required 完全无关（别混在一起排障）。
    if (parsed.kind === 'maintenance') {
      if (!maintenanceRunner) {
        return {
          status: 'blocked',
          stage: 'maint',
          reason: 'maint-unavailable',
          result: null,
          artifact: '',
          durationMs: 0,
          note: 'stage=maint reason=maint-unavailable（本机没有装配维护通道执行器）',
        };
      }
      return maintenanceRunner.run(parsed.spec, { task, taskId: task && task.id, signal: ctx.signal });
    }

    // exec / exec-legacy
    const out = await execRunner.run(parsed.spec, { task, taskId: task && task.id, signal: ctx.signal });
    if (parsed.reason === 'legacy-goal' && out.status !== 'blocked') {
      out.note = `${out.note} legacy-goal`;
    }
    return out;
  };
}
