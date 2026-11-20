// apply() 的工具面：宿主层给全部工具，agent 会话只给 worker_status，并用 tools.restrict 遮掉
// worker_control（第三遍审计 P1-NEW：DSH 的工具注册是全局层可继承，只「少注册」遮不住）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { apply, WORKER_SESSION_DENY } from '../../lib/worker/index.js';

function makeCtx() {
  const handlers = {};
  const registered = [];
  const defs = {};
  const ctx = {
    tools: {
      register(def) {
        registered.push(def.name);
        defs[def.name] = def;
        return () => {};
      },
    },
    on(event, handler) {
      handlers[event] = handler;
      return () => {
        delete handlers[event];
      };
    },
    effect() {},
  };
  return { ctx, handlers, registered, defs };
}

function makeAgentCtx(opts = {}) {
  const registered = [];
  const restricts = [];
  const actx = {
    tools: {
      register(def) {
        registered.push(def.name);
        return () => {};
      },
    },
  };
  if (opts.withRestrict !== false) {
    actx.tools.restrict = (filter) => {
      restricts.push(filter);
      return () => {};
    };
  }
  return { actx, registered, restricts };
}

const CONFIG = {
  machine: 'PC2',
  workerMode: 'off',
  worker: { workerMode: 'off', stateDir: path.join(os.tmpdir(), 'dsh-worker-apply-test') },
};

test('apply：宿主层注册全部工具，agent 会话只注册 worker_status 并 restrict 掉 worker_control', () => {
  const { ctx, handlers, registered } = makeCtx();
  apply(ctx, CONFIG);
  assert.ok(registered.includes('worker_status'));
  assert.ok(registered.includes('worker_control'));

  const { actx, registered: agentTools, restricts } = makeAgentCtx();
  assert.equal(typeof handlers['agent/created'], 'function');
  handlers['agent/created']({ agent: { id: 'worker-abc', ctx: actx } });

  assert.deepEqual(agentTools, ['worker_status']);
  assert.equal(restricts.length, 1);
  assert.deepEqual(restricts[0], { deny: WORKER_SESSION_DENY });
});

test('apply：没有 tools.restrict 时停主循环，并在 status 里如实报 agentRestrictBroken', async () => {
  const { ctx, handlers, defs } = makeCtx();
  apply(ctx, CONFIG);
  const { actx, registered, restricts } = makeAgentCtx({ withRestrict: false });
  assert.doesNotThrow(() => handlers['agent/created']({ agent: { id: 'worker-def', ctx: actx } }));
  assert.deepEqual(registered, ['worker_status']);
  assert.equal(restricts.length, 0);
  const status = await defs.worker_status.execute({});
  assert.equal(status.agentRestrictBroken, true, 'restrict 不可用必须置 agentRestrictBroken');
  assert.ok(status.agentRestrictFailures >= 1);
  for (const action of ['tick', 'drain', 'resume', 'approve', 'revoke', 'orphans']) {
    const r = await defs.worker_control.execute({ action });
    assert.equal(r.ok, false, `restrictBroken 时 ${action} 必须被拒绝`);
    assert.equal(r.error, 'agent-restrict-broken');
  }
});

test('apply：同一个 agent 只处理一次（ported 去重）', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, CONFIG);
  const first = makeAgentCtx();
  const event = { agent: { id: 'worker-dup', ctx: first.actx } };
  handlers['agent/created'](event);
  handlers['agent/created'](event);
  assert.equal(first.restricts.length, 1);
});

test('apply：agent 层拿到的工具名集合恰为只读的 worker_status', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, CONFIG);
  const { actx, registered, restricts } = makeAgentCtx();
  handlers['agent/created']({ agent: { id: 'worker-x', ctx: actx } });
  assert.deepEqual(registered, ['worker_status']);
  assert.equal(registered.includes('worker_control'), false);
  assert.deepEqual(restricts, [{ deny: WORKER_SESSION_DENY }]);
});

test('apply：非 worker 会话（操作员自己/子 agent）不注册、不 restrict', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, CONFIG);
  for (const id of ['sess-operator-1', 'subagent-xyz', 'agent-42']) {
    const agent = makeAgentCtx();
    handlers['agent/created']({ agent: { id, ctx: agent.actx } });
    assert.deepEqual(agent.registered, [], `${id} 不该注册工具`);
    assert.deepEqual(agent.restricts, [], `${id} 不该被 restrict（否则没人能批审批）`);
  }
});

test('apply：restrict 首次抛错会当场重试一次（DSH 只发一次 agent/created）', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, CONFIG);
  let attempts = 0;
  const agent = makeAgentCtx();
  agent.actx.tools.restrict = () => {
    attempts += 1;
    if (attempts === 1) throw new Error('unknown global tool: worker_control');
    return () => {};
  };
  const event = { agent: { id: 'worker-retry', ctx: agent.actx } };
  assert.doesNotThrow(() => handlers['agent/created'](event));
  assert.equal(attempts, 2, '首个失败后应立刻重试一次');
  // 重试成功后已 ported.add，再投同一事件不再处理
  assert.doesNotThrow(() => handlers['agent/created'](event));
  assert.equal(attempts, 2);
});

test('apply：restrict 连续两次失败 → 不标记已处理（status 计数 +1，可再次重试）', () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, CONFIG);
  let attempts = 0;
  const agent = makeAgentCtx();
  agent.actx.tools.restrict = () => {
    attempts += 1;
    throw new Error('unknown global tool: worker_control');
  };
  const event = { agent: { id: 'worker-fail', ctx: agent.actx } };
  assert.doesNotThrow(() => handlers['agent/created'](event));
  assert.equal(attempts, 2, '失败后立刻重试一次');
  // 两次都失败 => 没有 ported.add，再投同一事件还会再试
  assert.doesNotThrow(() => handlers['agent/created'](event));
  assert.equal(attempts, 4);
});

test('apply：有 actx.effect 时 lift 挂到会话 ctx，不进全局 disposers', () => {
  const disposers = [];
  const effects = [];
  const lift = () => disposers.push('lift-called');
  const agent = makeAgentCtx();
  agent.actx.effect = (cb) => {
    effects.push(cb);
  };
  agent.actx.tools.restrict = () => lift;
  const { ctx, handlers } = makeCtx();
  apply(ctx, CONFIG);
  handlers['agent/created']({ agent: { id: 'worker-eff', ctx: agent.actx } });
  assert.equal(effects.length, 1, '应当用 actx.effect 托管 lift');
  assert.equal(typeof effects[0](), 'function');
});
// v2.6.28（安全审计 C-18）：approve 动作不校验任务是否 agent 模式/已终态。
// 补两条校验：mode 必须是 agent，status 必须是 queued。
test('apply：worker_control approve 非 agent 模式任务 → 拒绝', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tasks: { t1: { id: 't1', mode: 'exec', status: 'queued', goal: 'do something' } } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const { ctx, defs } = makeCtx();
    apply(ctx, {
      machine: 'PC2',
      workerMode: 'off',
      boardUrl: `http://127.0.0.1:${port}`,
      agentEnabled: true,
      agentPreset: 'default',
      agentCwdRoot: os.homedir(),
      stateDir: path.join(os.tmpdir(), 'dsh-c18-test'),
    });
    const wc = defs['worker_control'];
    const r = await wc.execute({ action: 'approve', taskId: 't1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /不是 agent 模式/);
  } finally {
    server.close();
  }
});

test('apply：worker_control approve 非 queued 状态任务 → 拒绝', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tasks: { t1: { id: 't1', mode: 'agent', status: 'done', goal: 'do something' } } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const { ctx, defs } = makeCtx();
    apply(ctx, {
      machine: 'PC2',
      workerMode: 'off',
      boardUrl: `http://127.0.0.1:${port}`,
      agentEnabled: true,
      agentPreset: 'default',
      agentCwdRoot: os.homedir(),
      stateDir: path.join(os.tmpdir(), 'dsh-c18-test2'),
    });
    const wc = defs['worker_control'];
    const r = await wc.execute({ action: 'approve', taskId: 't1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /已不是 queued 状态/);
  } finally {
    server.close();
  }
});
