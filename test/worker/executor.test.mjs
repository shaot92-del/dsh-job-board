// executor 的分流：invalid / agent（disabled 与 unavailable 两种）/ exec。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskExecutor } from '../../lib/worker/executor.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const agentTask = { id: 'a1', mode: 'agent', goal: '写一份周报', title: '周报' };
const baseExec = { status: 'done', stage: 'exec', reason: 'completed', note: 'stage=exec exit=0', result: null, artifact: '', durationMs: 1 };

function make(overrides = {}) {
  const execRunner = { run: async () => ({ ...baseExec }) };
  return createTaskExecutor({ config: { agentEnabled: false }, log: quietLog, execRunner, agentRunner: null, ...overrides });
}

test('executor：agent 任务、开关关闭 → blocked/agent-disabled', async () => {
  const out = await make()(agentTask, {});
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'agent-disabled');
  assert.match(out.note, /agentEnabled=false/);
});

test('executor：agent 任务、开关打开但 host 未就绪 → blocked/agent-unavailable', async () => {
  const out = await make({ config: { agentEnabled: true } })(agentTask, {});
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'agent-unavailable');
  assert.match(out.note, /host 未就绪/);
});

test('executor：agent 任务、runner 在 → 走 runner 并带上 taskId', async () => {
  const calls = [];
  const agentRunner = {
    async run(spec, ctx) {
      calls.push({ spec, taskId: ctx.taskId });
      return { status: 'done', stage: 'agent', reason: 'completed', note: 'stage=agent session=worker-a1', result: { ok: true }, artifact: 'worker-a1', durationMs: 2 };
    },
  };
  const out = await make({ config: { agentEnabled: true }, agentRunner })(agentTask, {});
  assert.equal(out.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, 'a1');
  assert.equal(calls[0].spec.goal, '写一份周报');
});

test('executor：spec 非法（exec 空 goal）→ blocked 且不调用任何 runner', async () => {
  let called = 0;
  const execRunner = { run: async () => { called += 1; return { ...baseExec }; } };
  const out = await make({ execRunner })({ id: 'x', mode: 'exec', goal: '' }, {});
  assert.equal(out.status, 'blocked');
  assert.equal(called, 0);
});

test('executor：exec 任务透传 runner 结果', async () => {
  const out = await make()({ id: 'e1', mode: 'exec', goal: JSON.stringify({ scriptPath: 'C:\\tools\\job.ps1' }) }, {});
  assert.equal(out.status, 'done');
  assert.equal(out.stage, 'exec');
});
