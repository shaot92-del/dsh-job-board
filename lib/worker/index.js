// dsh-job-board worker 半边（原 dsh-job-worker 0.2.0，v2.6.0 并入）。
//
// 职责边界（handoff）：worker 侧只做「认领 → 执行 → 回写」。看板本身、派工策略、
// 能力卡都留在 dsh-job-board 那边；两者之间只有 HTTP，没有跨包 import。
//
// 这里只做装配：
//   config → board 客户端 / exec runner / agent runner / worker 主循环 → 工具注册
// 任何一步失败都不许让整个插件崩掉——降级成「工具能查状态、说明为什么没跑」。

import os from 'node:os';
import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, resolvePwshPath } from './config.js';
import { createBoardClient } from './board-client.js';
import { createExecRunner } from './exec-runner.js';
import { createMaintenanceRunner, MAINTENANCE_VERBS } from './maintenance.js';
import { createAgentRunner, createDshAgentHost } from './agent-runner.js';
import { promptFingerprint } from './agent-approval.js';
import { createTaskExecutor } from './executor.js';
import { createWorker } from './worker.js';
import { createLogger } from './log.js';
import { VERSION } from './version.js';

export const name = 'dsh-job-board-worker';
export const shortHelp = '看板执行节点：认领任务 → 本机执行（exec 脚本 / agent 会话）→ 回写结果。';
// 版本只在 lib/worker/version.js 写一处（v2.6.13 起；传输层的 UA 也读它）。
// test/worker/version.test.mjs 会断言它与 package.json 一致，免得 worker_status
// 报旧版本（审计时被发现过：包 0.2.0、status 0.1.0）。
export { VERSION };

/** 工具返回：DSH 要求内容块数组，裸字符串会被判非法。 */
function toTextBlocks(lines) {
  const list = Array.isArray(lines) ? lines : [String(lines ?? '')];
  return list.filter((x) => typeof x === 'string' && x.length > 0).map((text) => ({ type: 'text', text }));
}

function renderWorkerStatus(value) {
  if (!value || typeof value !== 'object') return toTextBlocks([String(value)]);
  if (value.ok === false) return toTextBlocks([`worker 状态不可用：${value.error || '未知错误'}`]);
  const lines = [];
  lines.push(
    `worker ${value.machine} · ${value.running ? `运行中(${value.mode})` : `未运行(${value.mode})`} · ` +
      `board=${value.boardUrl}${value.hasToken ? ' (token 已配)' : ' (无 token)'}`,
  );
  lines.push(
    `并发 ${value.jobs ? value.jobs.length : 0}/${value.maxConcurrent} · ` +
      `已认领 ${value.stats?.claimed ?? 0} / 完成 ${value.stats?.done ?? 0} / 失败 ${value.stats?.failed ?? 0} / ` +
      `blocked ${value.stats?.blocked ?? 0}`,
  );
  if (Array.isArray(value.jobs) && value.jobs.length) {
    for (const j of value.jobs.slice(0, 6)) {
      lines.push(`· ${j.taskId} ${j.mode || ''} ${Math.round((j.elapsedMs || 0) / 1000)}s ${j.title || ''}`.trim());
    }
  }
  lines.push(`allowlist ${Array.isArray(value.allowlist) ? value.allowlist.length : 0} 项 · 审批 ${value.approvalMode} · pwsh=${value.pwshPath || '?'}`);
  // 维护通道：远程排障第一眼看这里（开着=主控能取回版本/配置/日志尾部）
  if (value.maintenance) {
    const m = value.maintenance;
    lines.push(
      m.enabled
        ? `维护通道 开启 · 动词 ${(m.verbs || []).join('/') || '—'} · payload 目录 ${m.outDir || '（未配置，只回板子摘要）'}`
        : `维护通道 关闭${m.error ? `（${m.error}）` : ''}`,
    );
  }
  if (value.agent) {
    lines.push(`agent 模式：${value.agent.ok ? '可用' : '不可用 — ' + (value.agent.reason || '')}`);
  }
  const budget = value.agentBudget;
  lines.push(
    `agent 审批记录 ${value.agentApprovals ?? 0} 条${value.agentApprovalsWriteFailed ? '（有写盘失败，仅内存生效）' : ''} · ` +
      `当日额度 ${budget ? `${budget.used}/${budget.limit}` : '—'} · ` +
      `准入规则 ${value.agentAllowlistSize ?? 0} 条` +
      (value.agentRestrictFailures ? ` · restrict 失败 ${value.agentRestrictFailures} 次` : ''),
          (value.agentRestrictBroken && value.agentRestrictNote ? ` · ${value.agentRestrictNote}` : ''),
  );
  if (value.lastError) lines.push(`最近错误：${value.lastError}`);
  if (Array.isArray(value.logs) && value.logs.length) {
    lines.push('最近日志：');
    for (const l of value.logs.slice(-6)) lines.push(`  ${l}`);
  }
  return toTextBlocks(lines);
}

/**
 * @param {import('cordis').Context} ctx
 * @param {object} rawConfig patch 行里的 config
 */
export function apply(ctx, rawConfig = {}) {
  const { config, warnings } = normalizeConfig(rawConfig || {});
  const log = createLogger({
    limit: config.logLimit,
    secrets: [config.token],
    home: os.homedir(),
  });
  for (const w of warnings) log.warn(w);

  const build = {};

  // ── 看板客户端 ────────────────────────────────────────────────────────
  try {
    build.board = createBoardClient({
      baseUrl: config.boardUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
    });
  } catch (err) {
    build.boardError = (err && err.message) || String(err);
    log.error(`看板客户端初始化失败：${build.boardError}`);
  }

  // ── 执行器 ────────────────────────────────────────────────────────────
  try {
    build.execRunner = createExecRunner({ config, log });
  } catch (err) {
    build.execError = (err && err.message) || String(err);
    log.error(`exec 执行器初始化失败：${build.execError}`);
  }

  try {
    // agent 关闭时不建 host：否则每次重载都会挂一个 agent/error 订阅、
    // 而这些订阅在没有 agent 任务的机器上纯属负担（审计第二遍发现未退订）。
    if (config.agentEnabled) {
      build.agentHost = createDshAgentHost({ ctx, config, log });
      build.agentRunner = createAgentRunner({ host: build.agentHost, config, log });
    }
  } catch (err) {
    build.agentError = (err && err.message) || String(err);
    log.error(`agent 执行器初始化失败：${build.agentError}`);
  }

  // ── 维护通道（v2.6.12，只读）────────────────────────────────────────
  // 没有它的时候，副机一旦开着 worker，主控就只剩「本机操作」这一条路：
  // 内联命令 fail closed、非白名单脚本 approval-required —— 闸门是对的，
  // 但排障与升级于是永远需要一次物理接触。维护通道把「看」这件事单独放行，
  // 执行面仍然是 0（不 spawn、不读任意路径）。
  // statusFn 用延迟绑定：它读的是 worker.status()，而 worker 在本函数后面才建。
  let workerRef = null;

  // ── 写动词实现（v2.7 A2）───────────────────────────────────────────────
  // apply() 是同步的，而 maint-verbs 模块里没有需要提前构造的状态，所以这里用
  // 「懒加载 + 代理」：加载成功后代理自动转发；模块不存在 / 加载失败时代理把
  // 所有写动词判成 maint-write-disabled（fail closed，不会因为缺模块就放行）。
  // 真正能不能写还取决于 worker.maintenanceWriteEnabled 与票据校验（都在 runner 里）。
  build.maintVerbs = null;
  const maintVerbsProxy = {
    supported: (verb) => Boolean(build.maintVerbs && typeof build.maintVerbs.supported === 'function' && build.maintVerbs.supported(verb)),
    run: async (verb, payload, ctx) => {
      if (!build.maintVerbs || typeof build.maintVerbs.run !== 'function') {
        return { ok: false, reason: 'maint-write-disabled', note: '写动词实现未加载（lib/worker/maint-verbs.js）' };
      }
      return build.maintVerbs.run(verb, payload, ctx);
    },
  };
  import('./maint-verbs.js')
    .then((mod) => {
      if (typeof mod.createMaintVerbs !== 'function') {
        log.warn('maint-verbs.js 已存在但没有导出 createMaintVerbs；写动词保持关闭');
        return;
      }
      // 写动词要两个目录：插件自己的安装目录（模板/包内文件）与 profile 目录
      // （cordis.patch.yml 所在处）。config 里没有这两项（它们是安装形态，不是用户配置），
      // 所以这里从 import.meta.url 推插件根、再按 node_modules 布局反推 profile，
      // 并允许 config.profileDir / DSH_PROFILE_DIR 覆盖（自定义安装目录时用）。
      const selfPkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      const derivedProfileDir = path.basename(path.dirname(path.dirname(selfPkgDir))) === 'node_modules'
        ? path.dirname(path.dirname(path.dirname(selfPkgDir)))
        : path.dirname(path.dirname(selfPkgDir));
      const profileDir = String(config.profileDir || process.env.DSH_PROFILE_DIR || derivedProfileDir || '').trim();
      // v2.6.27（盘古审计 P2）：restart 动词的进程启动点。
      // 契约要求 maint-verbs.js 自己不 import child_process，所以由这里注入；
      // 只用于「延迟重启」这一条固定模板，参数全部来自 config（不收任务输入）。
      const spawnImpl = (cmd, argv, opts) => spawnChild(cmd, argv, { ...opts, stdio: 'ignore' });
      build.maintVerbs = mod.createMaintVerbs({ config: { ...config, profileDir, pkgDir: selfPkgDir }, log, spawnImpl });
      log.info(`维护写动词已接线（machine=${String(config.machine || '?')} 写开关=${config.maintenanceWriteEnabled === true ? 'on' : 'off'}）`);
    })
    .catch(() => {
      // 模块未交付属正常状态（A2 还没合入）：保持关闭，不刷日志。
    });

  try {
    build.maintenanceRunner = createMaintenanceRunner({
      config,
      log,
      version: VERSION,
      warnings,
      verbs: maintVerbsProxy,
      statusFn: () => (workerRef && typeof workerRef.status === 'function' ? workerRef.status() : {}),
    });
  } catch (err) {
    build.maintenanceError = (err && err.message) || String(err);
    log.error(`维护通道执行器初始化失败：${build.maintenanceError}`);
  }

  // ── 主循环 ────────────────────────────────────────────────────────────
  if (build.board && build.execRunner) {
    try {
      const executeTask = createTaskExecutor({
        config,
        log,
        execRunner: build.execRunner,
        agentRunner: build.agentRunner || null,
        maintenanceRunner: build.maintenanceRunner || null,
      });
      build.worker = createWorker({ config, log, board: build.board, executeTask });
    } catch (err) {
      build.workerError = (err && err.message) || String(err);
      log.error(`worker 初始化失败：${build.workerError}`);
    }
  }

  const worker = build.worker || null;
  workerRef = worker;

  const statusValue = () => {
    const base = {
      ok: true,
      version: VERSION,
      machine: config.machine,
      workerId: config.workerId,
      boardUrl: config.boardUrl,
      hasToken: Boolean(build.board && build.board.hasToken),
      pwshPath: build.execRunner ? build.execRunner.pwshPath : resolvePwshPath(config),
      allowlist: config.allowlist,
      approvalMode: config.approvalMode,
      allowInline: Boolean(config.allowInline),
      agent: build.agentRunner
        ? build.agentRunner.available()
        : { ok: false, reason: build.agentError || (config.agentEnabled ? '未初始化' : 'agent-disabled') },
      // count() 而不是 list().length：list 有 20 条展示上限，超过会少报（审计 P3-4）
      agentApprovals: build.agentRunner && build.agentRunner.approvals ? build.agentRunner.approvals.count() : 0,
      agentApprovalsWriteFailed:
        Boolean(build.agentRunner && build.agentRunner.approvals && build.agentRunner.approvals.writeFailed()),
      agentBudgetMaxPerDay: config.agentBudgetMaxPerDay,
      // 用量也要暴露：只看上限看不出「今天还能不能派」（code review P2）
      agentBudget: build.agentRunner && build.agentRunner.budget ? build.agentRunner.budget.peek() : null,
      agentAllowlistSize: Array.isArray(config.agentAllowlist) ? config.agentAllowlist.length : 0,
      agentRestrictFailures: restrictFailures,
      agentRestrictBroken: restrictBroken,
      // 维护通道（v2.6.12）：开关、payload 落地目录、可用动词
      maintenance: build.maintenanceRunner
        ? {
            enabled: build.maintenanceRunner.enabled,
            outDir: build.maintenanceRunner.outDir || '',
            verbs: [...MAINTENANCE_VERBS],
          }
        : { enabled: false, outDir: '', verbs: [], error: build.maintenanceError || '未初始化' },
    agentRestrictNote: restrictBroken ? 'approval gate unavailable (tools.restrict missing/broken); control actions disabled except cancel' : '',
      agentApprovalMode: config.agentApproval,
      warnings,
      logs: log.tail(10),
    };
    if (!worker) {
      return {
        ...base,
        ok: false,
        running: false,
        mode: config.workerMode,
        error: build.workerError || build.boardError || build.execError || 'worker 未初始化',
        stats: {},
        jobs: [],
      };
    }
    return { ...base, ...worker.status(), hasToken: Boolean(build.board && build.board.hasToken) };
  };

  /**
   * 人工审批（approve / revoke）：只认本机 stateDir 里的记录。
   * 任务书取自看板当前快照——审批绑定的是「这条任务此刻的提示词」。
   */
  const approvalAction = async (action, args) => {
    if (!build.agentRunner || !build.agentRunner.approvals) {
      return { ok: false, error: build.agentError || 'agent 未启用（worker.agentEnabled=false）' };
    }
    const taskId = String((args && args.taskId) || '').trim();
    if (!taskId) return { ok: false, error: `${action} 需要 taskId` };

    // 撤销只看本机记录：任务被删/归档之后也要能撤（审计 P3-5）
    if (action === 'revoke') {
      const r = build.agentRunner.approvals.revoke(taskId);
      return {
        ok: r.ok,
        action,
        taskId,
        revoked: Boolean(r.revoked),
        ...(r.ok ? {} : { error: r.error, inMemoryOnly: true }),
        note: r.ok && r.revoked
          ? '撤销后该任务需要重新审批'
          : r.ok
          ? '没有找到这条任务的审批记录（可能已被重派成新 id）；请撤销其来源任务，或按指纹清理'
          : '撤销没写进磁盘：本次只在进程内生效，重启后记录可能还在——先解决 stateDir 写权限/磁盘空间。',
      };
    }

    // 批准要取「这条任务此刻的提示词」：没有看板就读不到，只能拒绝
    if (!build.board) return { ok: false, error: '看板客户端未初始化' };
    const snap = await build.board.snapshot();
    if (!snap || !snap.ok) {
      return { ok: false, error: `看板读取失败：${(snap && (snap.error || `HTTP ${snap.status}`)) || 'unknown'}` };
    }
    const tasks = (snap.data && snap.data.tasks) || {};
    const task = tasks[taskId];
    if (!task) return { ok: false, error: `看板里没有任务 ${taskId}` };
    const goal = String(task.goal || '');
    const r = build.agentRunner.approvals.record(taskId, goal);
    return {
      ok: r.ok,
      action,
      taskId,
      fingerprint: promptFingerprint(goal),
      stored: r.ok,
      ...(r.ok ? {} : { error: r.error, inMemoryOnly: true }),
      approvalMode: config.agentApproval,
      note: r.ok
        ? '已记录本机审批（绑定提示词指纹）。任务重新派发后会执行；提示词一改就要重新批。' +
          `额度按 UTC 日计：agentBudgetMaxPerDay=${config.agentBudgetMaxPerDay}`
        : '审批没写进磁盘：本次只在进程内生效，重启即失效——先解决 stateDir 写权限/磁盘空间。',
    };
  };

  const tools = [
    {
      name: 'worker_status',
      description:
        '查看本机 dsh-job-board worker 的实时状态：模式/并发/当前任务/认领与完成计数/白名单条目/最近日志。' +
        '排查「任务没被认领」「认领了但没回写」时先调它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => renderWorkerStatus(value),
      },
      execute: async () => statusValue(),
    },
    {
      name: 'worker_control',
      description:
        '控制本机 dsh-job-board worker：drain=不接新任务（升级前）、resume=恢复接单、' +
        'cancel=取消一个正在跑的任务（需 taskId）、tick=立刻拉一次看板、orphans=重跑孤儿任务检查、' +
        'approve=人工批准一条 agent 任务（需 taskId，只在本机有效、绑定提示词指纹）、revoke=撤销审批。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['drain', 'resume', 'cancel', 'tick', 'orphans', 'approve', 'revoke'] },
          taskId: { type: 'string', description: 'cancel / approve / revoke 时的任务 id' },
          timeoutMs: { type: 'number', description: 'drain 时可以等多久（毫秒，默认不等）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => toTextBlocks([JSON.stringify(value, null, 2)]),
      },
      execute: async (args = {}) => {
        // 审批是「本机操作者」的决定：只允许宿主层调用，不许会话里的 agent 自己批自己。
        const action = String(args.action || '');
        // 安全审计 P1：restrict 失效 = 审批门已不可信，除 cancel 外一律拒绝，
        // 否则会话可以自己 tick + approve 把「人工审批 → 认领」闭环走完。
        if (restrictBroken && action !== 'cancel') {
          return {
            ok: false,
            error: 'agent-restrict-broken',
            reason: 'approval gate unavailable; restart the plugin/DSH after fixing tools.restrict',
          };
        }
        if (action === 'approve' || action === 'revoke') return approvalAction(action, args);
        if (!worker) return { ok: false, error: build.workerError || 'worker 未初始化' };
        switch (args.action) {
          case 'drain':
            return worker.drain({ timeoutMs: Number(args.timeoutMs) || 0 });
          case 'resume':
            return worker.resume();
          case 'cancel':
            if (!args.taskId) return { ok: false, error: 'cancel 需要 taskId' };
            return worker.cancelTask(args.taskId);
          case 'tick':
            return worker.tick();
          case 'orphans':
            return worker.recoverOrphans();
          default:
            return { ok: false, error: `不认识的 action=${JSON.stringify(args.action)}` };
        }
      },
    },
  ];

  const disposers = [];
  /**
   * @param {object} targetCtx
   * @param {string} label
   * @param {string[]} [only] 只注册这些工具名（agent 层只给只读状态工具）
   */
  const registerToolsOn = (targetCtx, label, only) => {
    if (!targetCtx || !targetCtx.tools || typeof targetCtx.tools.register !== 'function') return 0;
    const picked = Array.isArray(only) ? tools.filter((t) => only.includes(t.name)) : tools;
    let n = 0;
    for (const tool of picked) {
      try {
        const dispose = targetCtx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: {
            schema: tool.output.schema,
            render: tool.output.render,
          },
          execute: async (args) => {
            const out = await tool.execute(args);
            if (out === undefined) return null;
            try {
              return JSON.parse(JSON.stringify(out));
            } catch {
              return { ok: false, error: '工具返回值不是合法 JSON' };
            }
          },
        });
        if (typeof dispose === 'function') disposers.push(dispose);
        n += 1;
      } catch (err) {
        log.warn(`工具注册失败 ${label}/${tool.name}: ${(err && err.message) || err}`);
      }
    }
    log.debug(`工具注册 ${n} 个 (${label})`);
    return n;
  };

  registerToolsOn(ctx, 'host');

  // 只在宿主层注册的话，会话里可能看不到（DSH 的模型可见工具面按 agent layer 解析）。
  // 跟着 dsh-job-board 的做法：每个 agent 创建时在自己的 ctx 上再注册一遍。
  const ported = new Set();
  // restrict 没成功的会话数：只有 0 才算「agent 侧控制工具已关」，status 里如实暴露。
  // v2.6.0 安全审计 P1：restrict 无法确认时不能继续接 agent 任务（会话可自批），
  // 这里直接 drain 主循环：不再认领新任务，靠人工处理已经起飞的会话。
  let restrictFailures = 0
  let restrictBroken = false
  const markRestrictBroken = (why) => {
    restrictFailures += 1
    if (restrictBroken) return
    restrictBroken = true
    log.error(`agent restrict 不可用，已停止认领新任务：${why}`);
    try {
      if (worker && typeof worker.drain === 'function') {
        worker.drain({ timeoutMs: 0 }).catch(() => {
          try { if (worker && typeof worker.stop === 'function') worker.stop({ waitMs: 0 }); } catch { /* ignore */ }
        });
      } else if (worker && typeof worker.stop === 'function') {
        worker.stop({ waitMs: 0 });
      }
    } catch {
      /* ignore */
    }
  };
  let agentUnsub = null;
  try {
    if (typeof ctx.on === 'function') {
      agentUnsub = ctx.on('agent/created', (event) => {
        try {
          const agent = event && event.agent;
          const id = agent && agent.id;
          if (!id || ported.has(id)) return;
          // 这个 listener 挂在宿主 ctx 上，收到的是**进程内每一个**新建会话（包括操作员自己的
          // 会话与子 agent）。worker_control 是本包唯一的审批写入口，不能把操作员的会话也遮掉——
          // 否则默认 agentApproval=confirm 时没有任何人能批（code review P1-1 实测）。
          // 只处理本插件自己拉起的会话：id 由 makeSessionId 生成，形如 worker-<safe48>-<hex6>。
          if (!/^worker-/.test(String(id))) return;
          const actx = agent.ctx;
          if (!actx || !actx.tools) return;
          // 两遍审计反复踩到的一点：DSH 的工具注册是**全局层**可继承，agent 视图默认
          // 继承宿主 ctx 注册的工具——只在 actx 上「少注册」并不能遮住 worker_control。
          // 真正遮住要用 rc.3 就有的 tools.restrict（第三遍审计实测：deny 之后视图里只剩
          // worker_status）。它挂在 actx 上，只影响这个会话。
          registerToolsOn(actx, `agent:${id}`, ['worker_status']);
          // 先 restrict、成功了才 ported.add：restrict 抛错时不能把 id 记成「已处理」，
          // 否则这个会话永远不会被再处理一次，等于静默 fail-open（第四遍审计实测：宿主注册
          // 瞬时失败 → restrict 抛 unknown global tool → 被 catch 吞掉 → 会话仍看得到 worker_control）。
          if (typeof actx.tools.restrict === 'function') {
            // DSH 每个 agent 只发一次 agent/created：等「下一次事件」重试等于不重试，
            // 所以失败时在这里立刻再试一次（宿主注册瞬时失败是常见诱因）。
            let lift;
            try {
              lift = actx.tools.restrict({ deny: ['worker_control'] });
            } catch (errFirst) {
              log.warn(`agent 会话 restrict 首次失败，立刻重试一次：${(errFirst && errFirst.message) || errFirst}`);
              lift = actx.tools.restrict({ deny: ['worker_control'] });
            }
            if (typeof lift === 'function') {
              // 挂在会话自己的 ctx 上：会话销毁时自动释放，不用全局数组长期持有
              // （第四遍审计 P3：disposers 里按会话数线性增长、并可能钉住已销毁的 scope）。
              if (typeof actx.effect === 'function') {
                try {
                  actx.effect(() => lift);
                } catch {
                  disposers.push(lift);
                }
              } else {
                disposers.push(lift);
              }
            } else {
              // restrict 返回了非函数：无法证明控制类工具被遮住，按失败记账
              markRestrictBroken('restrict 返回非函数，无法确认 worker_control 已被遮住');
            }
          } else {
            // 没有 restrict 就等于控制类工具对这个会话可见：必须留痕，不能让文档说「已关」
            markRestrictBroken('当前 DSH 没有 tools.restrict（审批门可能被会话自己绕过）');
          }
          ported.add(id);
        } catch (err) {
          markRestrictBroken(`agent/created 处理失败（该会话可能仍看得到 worker_control）：${(err && err.message) || err}`);
        }
      });
    }
  } catch (err) {
    markRestrictBroken(`agent/created 订阅失败（会话可能仍看得到 worker_control）：${(err && err.message) || err}`);
  }
  if (typeof ctx.on !== 'function') {
    markRestrictBroken('当前 DSH 没有 ctx.on，无法在会话创建时施加 restrict');
  }

  // ── 启动 / 收尾 ───────────────────────────────────────────────────────
  if (worker) {
    if (config.workerMode === 'off') {
      log.info('workerMode=off：不启动主循环（worker_control resume 需要重启或改配置）');
    } else {
      worker.start().catch((err) => log.error(`worker 启动失败：${(err && err.message) || err}`));
    }
  }

  const disposeAll = () => {
    const unsub = agentUnsub;
    agentUnsub = null;
    try {
      if (typeof unsub === 'function') unsub();
    } catch {
      /* ignore */
    }
    try {
      if (build.agentHost && typeof build.agentHost.dispose === 'function') build.agentHost.dispose();
    } catch {
      /* ignore */
    }
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    if (worker) {
      worker.stop({ waitMs: 2000 }).catch(() => {});
    }
  };

  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll);
    else if (typeof ctx.on === 'function') ctx.on('dispose', disposeAll);
  } catch (err) {
    log.warn(`生命周期钩子注册失败：${(err && err.message) || err}`);
  }

  return { worker, config, status: statusValue, dispose: disposeAll };
}
