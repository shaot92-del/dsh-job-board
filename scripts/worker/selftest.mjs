#!/usr/bin/env node
// 离线自检：不装 DSH、不起真看板，直接在进程里跑通 milestone 1 的
// claim → exec → mark 全链路。用于：
//   · 本机回归（npm run selftest）
//   · 部署到 PC2 之后先跑一遍，确认「脚本、白名单、pwsh、回写」都通，再去动真看板
//
// 退出码 0 = 全通；1 = 有失败。每一步都打印实际观测值，失败时能直接看出卡在哪。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeBoard } from './fake-board.mjs';
import { createBoardClient } from '../../lib/worker/board-client.js';
import { createExecRunner } from '../../lib/worker/exec-runner.js';
import { createTaskExecutor } from '../../lib/worker/executor.js';
import { createWorker } from '../../lib/worker/worker.js';
import { resolvePwshPath } from '../../lib/worker/config.js';

const TOKEN = 'selftest-token';
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
let failures = 0;

function ok(name, detail = '') {
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  failures += 1;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 100) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  const pwsh = resolvePwshPath({}, { exists: (p) => fs.existsSync(p) });
  console.log('dsh-job-board worker selftest');
  console.log(`  node ${process.version} · ${os.platform()} · pwsh=${pwsh || '(未找到)'}`);
  if (!pwsh) {
    bad('找到 pwsh', '没有任何可用的 pwsh 7');
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-selftest-'));
  const scriptPath = path.join(tmp, 'case.ps1');
  fs.writeFileSync(
    scriptPath,
    [
      '$sum = 1..5 | Measure-Object -Sum | Select-Object -ExpandProperty Sum',
      "$line = 'DSH_RESULT {\"ok\":true,\"expected\":15,\"actual\":' + $sum + ',\"reasons\":[]}'",
      'Write-Output $line',
      `Write-Output 'DSH_ARTIFACT ${path.join(tmp, 'out.txt')}'`,
      '',
    ].join('\n'),
    'utf8',
  );

  const board = createFakeBoard({ token: TOKEN });
  const { url } = await board.listen(0, '127.0.0.1');
  const client = createBoardClient({ baseUrl: url, token: TOKEN, timeoutMs: 3000 });
  let worker = null;

  try {
    console.log(`\n[1/5] 起假看板 ${url}`);
    const health = await client.health();
    check('看板可达', health.ok, `status=${health.status}`);
    const denied = await createBoardClient({ baseUrl: url, token: 'wrong', timeoutMs: 2000 }).snapshot();
    check('错误 token 被拒', denied.ok === false && denied.status === 401, `status=${denied.status}`);

    console.log('\n[2/5] 写入任务（goal = exec spec JSON）');
    const created = await fetch(`${url}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': TOKEN },
      body: JSON.stringify({
        task_id: 'selftest-1',
        machine: 'host',
        mode: 'exec',
        dispatch: 'auto',
        title: '自检任务',
        goal: JSON.stringify({ scriptPath, timeoutMs: 30000 }),
      }),
    });
    check('任务已创建', created.status === 200, `status=${created.status}`);

    console.log('\n[3/5] 起 worker（allowlist = 脚本所在目录）');
    const config = {
      machine: 'host',
      workerId: 'host',
      boardUrl: url,
      token: TOKEN,
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
    worker = createWorker({ config, board: client, executeTask, log: quietLog, recoverOnStart: true });
    await worker.start();
    check('worker 已启动', worker.status().running === true, `instanceId=${worker.instanceId}`);

    console.log('\n[4/5] 等任务进入终态');
    const finished = await waitFor(async () => {
      const snap = await client.snapshot();
      const task = snap.ok ? snap.data.tasks['selftest-1'] : null;
      return task && ['done', 'failed', 'blocked'].includes(task.status) ? task : null;
    });
    if (!finished) {
      bad('任务进入终态', '30s 超时（看板没收到 mark？）');
    } else {
      check('状态 = done', finished.status === 'done', `status=${finished.status} note=${finished.note}`);
      check('result.ok = true', Boolean(finished.result && finished.result.ok === true), JSON.stringify(finished.result));
      check(
        'DSH_RESULT 数值被正确采信',
        Boolean(finished.result && finished.result.expected === 15 && finished.result.actual === 15),
        JSON.stringify(finished.result),
      );
      check('artifact 已回写', /out\.txt$/.test(String(finished.artifact || '')), String(finished.artifact || ''));
      check('note 带 worker 前缀与 stage', /^worker:host inst:/.test(finished.note) && /stage=exec exit=0/.test(finished.note));
    }

    console.log('\n[5/5] 不重复执行 + 白名单闸门');
    const claimsBefore = board.state.calls.claim;
    await worker.tick();
    await new Promise((r) => setTimeout(r, 300));
    check('终态任务不会被再次认领', board.state.calls.claim === claimsBefore, `claim 次数 ${board.state.calls.claim}`);

    const outside = path.join(os.tmpdir(), 'not-allowed.ps1');
    fs.writeFileSync(outside, "Write-Output 'nope'\n", 'utf8');
    const gate = await execRunner.run({ scriptPath: outside });
    check('白名单外脚本被拒', gate.status === 'blocked' && gate.reason === 'not-allowlisted', `status=${gate.status} reason=${gate.reason}`);

    const inline = await execRunner.run({ inline: 'Get-Date' });
    check(
      '内联命令默认拒绝',
      inline.status === 'blocked' && inline.reason === 'inline-command-not-allowed',
      `status=${inline.status} reason=${inline.reason}`,
    );
    try {
      fs.unlinkSync(outside);
    } catch {
      /* ignore */
    }

    const stats = worker.status().stats;
    console.log(
      `\n统计：claimed=${stats.claimed} done=${stats.done} failed=${stats.failed} blocked=${stats.blocked} beats=${stats.beats}`,
    );
  } catch (err) {
    bad('未捕获异常', (err && err.stack) || String(err));
  } finally {
    if (worker) await worker.stop({ waitMs: 500 });
    await board.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL（${failures} 项）`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('selftest 崩溃:', (err && err.stack) || err);
  process.exit(1);
});
