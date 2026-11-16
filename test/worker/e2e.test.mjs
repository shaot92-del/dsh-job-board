// 端到端：真 HTTP 假看板 + 真 pwsh 子进程 + 真 worker 主循环。
// 这是 milestone 1 的验收形态（PC2 上用真看板跑的就是这条路径）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeBoard } from '../../scripts/worker/fake-board.mjs';
import { createBoardClient } from '../../lib/worker/board-client.js';
import { createExecRunner } from '../../lib/worker/exec-runner.js';
import { createTaskExecutor } from '../../lib/worker/executor.js';
import { createWorker } from '../../lib/worker/worker.js';
import { resolvePwshPath } from '../../lib/worker/config.js';

const TOKEN = 'e2e-token';
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('claim → exec → mark：结果/产物/note 全部落回看板；token 生效', async (t) => {
  const pwsh = resolvePwshPath({}, { exists: (p) => fs.existsSync(p) });
  if (!pwsh) return t.skip('没有 pwsh，跳过端到端');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-e2e-'));
  const scriptPath = path.join(tmp, 'job.ps1');
  fs.writeFileSync(
    scriptPath,
    [
      "Write-Output 'starting'",
      `Write-Output 'DSH_RESULT {"ok":true,"expected":30,"actual":30,"reasons":[]}'`,
      `Write-Output 'DSH_ARTIFACT ${path.join(tmp, 'report.html')}'`,
      '',
    ].join('\n'),
    'utf8',
  );

  const board = createFakeBoard({ token: TOKEN });
  const { url } = await board.listen(0, '127.0.0.1');
  const client = createBoardClient({ baseUrl: url, token: TOKEN, timeoutMs: 3000 });

  let worker = null;
  try {
    // 1. 任务通过 /api/create 进看板（goal 是字符串化的 exec spec）
    const created = await fetch(`${url}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': TOKEN },
      body: JSON.stringify({
        task_id: 'e2e-1',
        machine: 'host',
        mode: 'exec',
        dispatch: 'auto',
        title: '端到端任务',
        goal: JSON.stringify({ scriptPath, timeoutMs: 30000 }),
      }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).ok, true);

    // 2. 无 token / 错 token 必须被拒
    const anon = createBoardClient({ baseUrl: url, token: '', timeoutMs: 2000 });
    const denied = await anon.snapshot();
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);

    // 3. 起 worker
    const config = {
      machine: 'host',
      workerId: 'host',
      boardUrl: url,
      token: TOKEN,
      pollMs: 200,
      beatMs: 60000,
      backoffMs: 200,
      maxBackoffMs: 1000,
      leaseMinutes: 5,
      maxConcurrent: 1,
      allowlist: [tmp],
      approvalMode: 'manual',
      execTimeoutMs: 30000,
      orphanPolicy: 'blocked',
      boardTimeoutMs: 3000,
    };
    const execRunner = createExecRunner({ config, log: quietLog });
    const executeTask = createTaskExecutor({ config, log: quietLog, execRunner, agentRunner: null });
    worker = createWorker({ config, board: client, executeTask, log: quietLog, recoverOnStart: true });
    await worker.start();

    const finished = await waitFor(async () => {
      const snap = await client.snapshot();
      const task = snap.ok ? snap.data.tasks['e2e-1'] : null;
      return task && ['done', 'failed', 'blocked'].includes(task.status) ? task : null;
    });
    assert.ok(finished, '任务在 20s 内没有进入终态');
    assert.equal(finished.status, 'done', finished.note);
    assert.deepEqual(finished.result, { ok: true, expected: 30, actual: 30 });
    assert.match(finished.artifact, /report\.html$/);
    assert.match(finished.note, /^worker:host inst:/);
    assert.match(finished.note, /stage=exec exit=0/);

    // 4. 心跳路径被走过（running → 终态），且 claim 带上了 holder
    const marks = board.state.calls.mark;
    assert.ok(marks >= 2, `mark 次数不足：${marks}`);
    assert.equal(board.counts().done, 1);

    // 5. 终态任务不会被再次认领
    await worker.tick();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(board.state.calls.claim, 1);
  } finally {
    if (worker) await worker.stop({ waitMs: 500 });
    await board.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('失败任务也要把 exitCode + stderr 尾部 + stage 写回看板', async (t) => {
  const pwsh = resolvePwshPath({}, { exists: (p) => fs.existsSync(p) });
  if (!pwsh) return t.skip('没有 pwsh，跳过端到端');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-e2e-fail-'));
  const scriptPath = path.join(tmp, 'bad.ps1');
  fs.writeFileSync(scriptPath, "[Console]::Error.WriteLine('upstream failure')\nexit 7\n", 'utf8');

  const board = createFakeBoard({});
  const { url } = await board.listen(0, '127.0.0.1');
  const client = createBoardClient({ baseUrl: url, timeoutMs: 3000 });

  let worker = null;
  try {
    board.state.tasks['bad-1'] = {
      status: 'queued',
      machine: 'host',
      mode: 'exec',
      dispatch: 'auto',
      title: '失败任务',
      goal: JSON.stringify({ scriptPath }),
      created_at: 1,
    };

    const config = {
      machine: 'host',
      workerId: 'host',
      boardUrl: url,
      pollMs: 200,
      beatMs: 60000,
      leaseMinutes: 5,
      maxConcurrent: 1,
      allowlist: [tmp],
      approvalMode: 'manual',
      execTimeoutMs: 30000,
      orphanPolicy: 'blocked',
    };
    const execRunner = createExecRunner({ config, log: quietLog });
    const executeTask = createTaskExecutor({ config, log: quietLog, execRunner, agentRunner: null });
    worker = createWorker({ config, board: client, executeTask, log: quietLog, recoverOnStart: false });
    await worker.start();

    const finished = await waitFor(async () => {
      const snap = await client.snapshot();
      const task = snap.ok ? snap.data.tasks['bad-1'] : null;
      return task && ['done', 'failed', 'blocked'].includes(task.status) ? task : null;
    });
    assert.ok(finished, '任务没有进入终态');
    assert.equal(finished.status, 'failed');
    assert.match(finished.note, /stage=exec/);
    assert.match(finished.note, /exit=7/);
    assert.match(finished.note, /upstream failure/);
  } finally {
    if (worker) await worker.stop({ waitMs: 500 });
    await board.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
