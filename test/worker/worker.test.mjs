import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createWorker, taskList, isClaimable, sortByCreatedAt } from '../../lib/worker/worker.js';

const BASE_CONFIG = {
  machine: 'PC2',
  workerId: 'PC2',
  boardUrl: 'http://127.0.0.1:8977',
  pollMs: 200,
  beatMs: 60000,
  backoffMs: 200,
  maxBackoffMs: 1000,
  leaseMinutes: 10,
  maxConcurrent: 1,
  allowlist: [],
  approvalMode: 'manual',
  orphanPolicy: 'blocked',
};

function makeBoard(tasks, opts = {}) {
  const calls = [];
  return {
    tasks,
    calls,
    opts,
    async snapshot() {
      if (opts.snapshotFailTimes && opts.snapshotFailTimes > 0) {
        opts.snapshotFailTimes -= 1;
        calls.push({ kind: 'snapshot', ok: false });
        return { ok: false, status: 0, error: 'ECONNREFUSED', network: true };
      }
      calls.push({ kind: 'snapshot', ok: true });
      return { ok: true, status: 200, data: { tasks } };
    },
    async claim(body) {
      calls.push({ kind: 'claim', ...body });
      const t = tasks[body.taskId];
      if (!t) return { ok: false, status: 404, error: '没有这个任务' };
      if (opts.claimConflict) return { ok: false, status: 409, error: '已被占用' };
      if (String(t.status) !== 'queued') return { ok: false, status: 409, error: '任务不在 queued' };
      t.status = 'claimed';
      t.machine = body.machine;
      t.holder = body.holder;
      return { ok: true, status: 200, data: { ok: true } };
    },
    async mark(body) {
      calls.push({ kind: 'mark', ...body });
      const t = tasks[body.taskId];
      if (t) {
        t.status = body.status;
        if (body.note !== undefined) t.note = body.note;
        if (body.result) t.result = body.result;
        if (body.artifact) t.artifact = body.artifact;
      }
      return { ok: true, status: 200, data: { ok: true } };
    },
    async beat(body) {
      calls.push({ kind: 'beat', ...body });
      if (opts.beatTerminal409) return { ok: false, status: 409, error: '终态任务不再接受 beat' };
      return { ok: true, status: 200, data: { ok: true } };
    },
  };
}

function task(id, over = {}) {
  return {
    id,
    title: `任务 ${id}`,
    status: 'queued',
    dispatch: 'auto',
    machine: 'PC2',
    mode: 'exec',
    goal: '{"scriptPath":"C:\\\\tools\\\\a.ps1"}',
    created_at: 1000,
    ...over,
  };
}

function doneOutcome(over = {}) {
  return { status: 'done', stage: 'exec', note: 'stage=exec exit=0 result=ok', result: { ok: true }, artifact: '', ...over };
}

function makeWorker(board, executeTask, configOver = {}, workerOpts = {}) {
  return createWorker({
    config: { ...BASE_CONFIG, ...configOver },
    board,
    executeTask,
    recoverOnStart: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...workerOpts,
  });
}

test('taskList / isClaimable / sortByCreatedAt：board 的 tasks 是对象不是数组', () => {
  const list = taskList({ a: { status: 'queued' }, b: null, c: { status: 'done' } });
  assert.deepEqual(list.map((t) => t.id).sort(), ['a', 'c']);

  assert.equal(isClaimable(task('x'), { machine: 'pc2' }), true);
  assert.equal(isClaimable(task('x'), { machine: 'GT14' }), false);
  assert.equal(isClaimable(task('x', { dispatch: 'manual' }), { machine: 'PC2' }), false);
  assert.equal(isClaimable(task('x', { status: 'claimed' }), { machine: 'PC2' }), false);
  assert.equal(isClaimable(task('x', { remote_id: 'hub-1' }), { machine: 'PC2' }), false);

  const sorted = [task('b', { created_at: 2 }), task('a', { created_at: 1 })].sort(sortByCreatedAt);
  assert.deepEqual(sorted.map((t) => t.id), ['a', 'b']);
});

test('tick：认领 → running → 执行 → 回写 done（note 带 worker 前缀与 stage）', async () => {
  const seen = [];
  const boards = makeBoard({ t1: task('t1') });
  const worker = makeWorker(boards, async (t) => {
    seen.push(t.id);
    return doneOutcome();
  });
  const res = await worker.tick();
  assert.deepEqual(res.claimed, ['t1']);
  await worker.waitForIdle({ timeoutMs: 2000 });

  assert.deepEqual(seen, ['t1']);
  assert.equal(boards.tasks.t1.status, 'done');
  assert.match(boards.tasks.t1.note, /^worker:PC2 inst:/);
  assert.match(boards.tasks.t1.note, /stage=exec exit=0/);

  const claim = boards.calls.find((c) => c.kind === 'claim');
  assert.equal(claim.machine, 'PC2');
  assert.equal(claim.holder, worker.instanceId);
  assert.match(claim.note, /^worker:PC2/);

  const marks = boards.calls.filter((c) => c.kind === 'mark').map((c) => c.status);
  assert.deepEqual(marks, ['running', 'done']);
  assert.equal(worker.status().stats.done, 1);
  assert.equal(worker.status().stats.claimed, 1);
  assert.equal(worker.jobs.size, 0);
});

test('tick：只认领 queued + auto + 本机 + 无 remote_id', async () => {
  const boards = makeBoard({
    manual: task('manual', { dispatch: 'manual' }),
    other: task('other', { machine: 'GT14' }),
    taken: task('taken', { remote_id: 'hub-7' }),
    done: task('done', { status: 'done' }),
    mine: task('mine'),
  });
  const checked = [];
  const worker = makeWorker(boards, async (t) => {
    checked.push(t.id);
    return doneOutcome();
  });
  await worker.tick();
  await worker.waitForIdle({ timeoutMs: 2000 });
  assert.deepEqual(checked, ['mine']);
  assert.equal(boards.calls.filter((c) => c.kind === 'claim').length, 1);
});

test('认领冲突（409）：不执行、不回写、计数进 claimErrors', async () => {
  const boards = makeBoard({ t1: task('t1') }, { claimConflict: true });
  let executed = 0;
  const worker = makeWorker(boards, async () => {
    executed += 1;
    return doneOutcome();
  });
  const res = await worker.tick();
  assert.deepEqual(res.claimed, []);
  assert.equal(executed, 0);
  assert.equal(boards.tasks.t1.status, 'queued');
  assert.equal(worker.status().stats.claimErrors, 1);
  assert.equal(boards.calls.filter((c) => c.kind === 'mark').length, 0);
});

test('看板不可达：tick 返回退避时长，连续失败指数增长，恢复后清零', async () => {
  const boards = makeBoard({}, { snapshotFailTimes: 2 });
  const worker = makeWorker(boards, async () => doneOutcome());
  const first = await worker.tick();
  assert.equal(first.skipped, 'board');
  assert.equal(first.backoffMs, 200);
  const second = await worker.tick();
  assert.equal(second.backoffMs, 400);
  const third = await worker.tick();
  assert.equal(third.skipped, undefined);
  assert.equal(worker.status().consecutiveFailures, 0);
});

test('并发上限：maxConcurrent=1 时第二个任务要等第一个做完', async () => {
  const boards = makeBoard({ a: task('a', { created_at: 1 }), b: task('b', { created_at: 2 }) });
  const releases = [];
  const started = [];
  const worker = makeWorker(boards, (t) =>
    new Promise((resolve) => {
      started.push(t.id);
      releases.push(() => resolve(doneOutcome()));
    }),
  );

  await worker.tick();
  assert.deepEqual(started, ['a']);
  const busy = await worker.tick();
  assert.equal(busy.skipped, 'busy');

  const jobA = [...worker.jobs.values()][0];
  releases.shift()();
  await jobA.promise;
  assert.equal(boards.tasks.a.status, 'done');

  await worker.tick();
  assert.deepEqual(started, ['a', 'b']);
  releases.shift()();
  await worker.waitForIdle({ timeoutMs: 2000 });
  assert.equal(boards.tasks.b.status, 'done');
});

test('取消：abort 后运行中的任务回写 blocked/canceled', async () => {
  const boards = makeBoard({ t1: task('t1') });
  const worker = makeWorker(
    boards,
    (t, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () =>
          resolve({ status: 'blocked', stage: 'exec', note: 'stage=exec reason=canceled', result: null, artifact: '' }),
        );
      }),
  );
  await worker.tick();
  assert.equal(worker.cancelTask('t1').ok, true);
  await worker.waitForIdle({ timeoutMs: 2000 });
  assert.equal(boards.tasks.t1.status, 'blocked');
  assert.match(boards.tasks.t1.note, /reason=canceled/);
  assert.equal(worker.cancelTask('nope').ok, false);
});

test('执行抛异常：兜底成 failed/internal-error，任务不会留在 running', async () => {
  const boards = makeBoard({ t1: task('t1') });
  const worker = makeWorker(boards, async () => {
    throw new Error('boom in executor');
  });
  await worker.tick();
  await worker.waitForIdle({ timeoutMs: 2000 });
  assert.equal(boards.tasks.t1.status, 'failed');
  assert.match(boards.tasks.t1.note, /reason=internal-error/);
  assert.match(boards.tasks.t1.note, /boom in executor/);
});

test('孤儿任务：holder 是我的、租约已过期 → 标 blocked 且绝不重放', async () => {
  const nowSec = Date.now() / 1000;
  const boards = makeBoard({
    orphan: {
      ...task('orphan', {
        status: 'claimed',
        note: 'worker:PC2 inst:PC2/9999-abcd stage=exec',
        lease_until: nowSec - 600,
        holder: 'PC2/9999-abcd',
      }),
    },
  });
  let executed = 0;
  const worker = makeWorker(boards, async () => {
    executed += 1;
    return doneOutcome();
  });

  const rec = await worker.recoverOrphans();
  assert.deepEqual(rec.adopted, ['orphan']);
  assert.equal(boards.tasks.orphan.status, 'blocked');
  assert.match(boards.tasks.orphan.note, /reason=orphan/);

  const mark = boards.calls.find((c) => c.kind === 'mark');
  assert.equal(mark.status, 'blocked');
  assert.equal(mark.holder, undefined, '孤儿接管不能带 holder（老实例 id 会 409）');

  await worker.tick();
  assert.equal(executed, 0, '孤儿任务绝不能被重新执行');
});

test('孤儿任务：归属看 holder 不看 note（note 谁都能写）', async () => {
  const nowSec = Date.now() / 1000;
  const expired = nowSec - 3600;
  const boards = makeBoard({
    // note 冒充我们的 workerId，但 holder 是别的 worker —— 不许接管
    forged: {
      ...task('forged', { status: 'running', note: 'worker:PC2 inst:PC2/1-aa', lease_until: expired }),
      holder: 'OTHER/9-zz',
    },
    // 真正的我们的孤儿（结构字段与 note 都对）
    real: {
      ...task('real', { status: 'running', note: 'worker:PC2 inst:PC2/2-bb', lease_until: expired }),
      holder: 'PC2/2-bb',
    },
  });
  const worker = makeWorker(boards, async () => doneOutcome());
  const rec = await worker.recoverOrphans();
  assert.deepEqual(rec.adopted, ['real']);
  assert.equal(boards.tasks.forged.status, 'running', '别人的任务不许动');
});

test('finishTask：note / artifact 落看板前要脱敏（token 与家目录）', async () => {
  const boards = makeBoard({ t1: task('t1') });
  const token = 'supersecret-token-abc123';
  const home = os.homedir();
  const worker = makeWorker(
    boards,
    async () => ({
      status: 'failed',
      stage: 'exec',
      note: `stage=exec exit=1 stderr=x-board-token: ${token} home ${home}\\x`,
      result: null,
      artifact: `${home}\\.dsh\\board-tokens.txt`,
    }),
    { ...BASE_CONFIG, token },
  );
  await worker.tick();
  await new Promise((r) => setTimeout(r, 30));
  const mark = boards.calls.find((c) => c.kind === 'mark' && c.status === 'failed');
  assert.ok(mark, '应该有 failed 回写');
  assert.ok(!mark.note.includes(token), `note 泄漏 token: ${mark.note}`);
  assert.ok(!mark.note.includes(home), `note 泄漏家目录: ${mark.note}`);
  assert.ok(!String(mark.artifact || '').includes(home), `artifact 泄漏家目录: ${mark.artifact}`);
});

test('孤儿任务：租约还没过期 → 不动（可能是同机另一个存活实例）', async () => {
  const nowSec = Date.now() / 1000;
  const boards = makeBoard({
    live: {
      ...task('live', { status: 'running', note: 'worker:PC2 inst:other', lease_until: nowSec + 600 }),
    },
  });
  const worker = makeWorker(boards, async () => doneOutcome());
  const rec = await worker.recoverOrphans();
  assert.deepEqual(rec.adopted, []);
  assert.equal(boards.calls.filter((c) => c.kind === 'mark').length, 0);
});

test('孤儿任务：workerId 不是我的就不碰', async () => {
  const nowSec = Date.now() / 1000;
  const boards = makeBoard({
    foreign: { ...task('foreign', { status: 'claimed', note: 'worker:MB14 inst:x', lease_until: nowSec - 600 }) },
  });
  const worker = makeWorker(boards, async () => doneOutcome());
  const rec = await worker.recoverOrphans();
  assert.equal(rec.checked, 0);
});

test('orphanPolicy=ignore 时完全不检查', async () => {
  const boards = makeBoard({});
  const worker = makeWorker(boards, async () => doneOutcome(), { orphanPolicy: 'ignore' });
  const rec = await worker.recoverOrphans();
  assert.equal(rec.skipped, 'policy');
  assert.equal(boards.calls.length, 0);
});

test('drain：不接新任务；resume 后恢复', async () => {
  const boards = makeBoard({ t1: task('t1') });
  const worker = makeWorker(boards, async () => doneOutcome());
  worker.drain();
  const res = await worker.tick();
  assert.equal(res.skipped, 'mode');
  assert.equal(boards.calls.filter((c) => c.kind === 'claim').length, 0);
  worker.resume();
  await worker.tick();
  await worker.waitForIdle({ timeoutMs: 2000 });
  assert.equal(boards.tasks.t1.status, 'done');
});

test('mode=off 时不启动主循环', async () => {
  const worker = makeWorker(makeBoard({}), async () => doneOutcome(), { workerMode: 'off' });
  const res = await worker.start();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'mode-off');
  await worker.stop({ waitMs: 10 });
});

test('start/stop：循环跑起来后 stop 能立刻返回', async () => {
  const boards = makeBoard({});
  const worker = makeWorker(boards, async () => doneOutcome());
  await worker.start();
  await new Promise((r) => setTimeout(r, 50));
  const stopped = await worker.stop({ waitMs: 1000 });
  assert.equal(stopped.ok, true);
  assert.equal(worker.status().running, false);
});

test('stop 后 tick 不再认领，resume 清掉 stopped', async () => {
  const boards = makeBoard({});
  const worker = makeWorker(boards, async () => doneOutcome());
  await worker.start();
  await worker.stop({ waitMs: 1000 });
  const claimsBefore = boards.calls.filter((c) => c.kind === 'claim').length;
  boards.tasks.t1 = task('t1');
  const blocked = await worker.tick();
  assert.equal(blocked.skipped, 'stopped');
  assert.equal(boards.calls.filter((c) => c.kind === 'claim').length, claimsBefore);
  worker.resume();
  await worker.tick();
  await worker.waitForIdle({ timeoutMs: 2000 });
  assert.equal(boards.tasks.t1.status, 'done');
});

test('finishTask：result.reasons 落看板前也要脱敏（stdout 通道，P1-1 残留）', async () => {
  const boards = makeBoard({ t1: task('t1') });
  const token = 'opaque-board-token-9f8e7d6c5b4a';
  const home = os.homedir();
  const worker = makeWorker(
    boards,
    async () => ({
      status: 'failed',
      stage: 'exec',
      note: 'stage=exec exit=1',
      result: { ok: false, expected: 30, actual: 0, reasons: ['token ' + token + ' expired', 'home ' + home] },
      artifact: '',
    }),
    { ...BASE_CONFIG, token },
  );
  await worker.tick();
  await new Promise((r) => setTimeout(r, 30));
  const mark = boards.calls.find((c) => c.kind === 'mark' && c.status === 'failed');
  assert.ok(mark, '应该有 failed 回写');
  const json = JSON.stringify(mark.result);
  assert.ok(!json.includes(token), `result 泄漏 token: ${json}`);
  assert.ok(!json.includes(home), `result 泄漏家目录: ${json}`);
  assert.equal(mark.result.ok, false);
  assert.equal(mark.result.expected, 30);
});

test('finishTask：result 里夹带的额外字段被丢掉', async () => {
  const boards = makeBoard({ t1: task('t1') });
  const worker = makeWorker(boards, async () => ({
    status: 'done',
    stage: 'exec',
    note: 'stage=exec exit=0',
    result: { ok: true, actual: 3, extra: 'should-not-survive', nested: { a: 1 } },
    artifact: '',
  }));
  await worker.tick();
  await new Promise((r) => setTimeout(r, 30));
  const mark = boards.calls.find((c) => c.kind === 'mark' && c.status === 'done');
  assert.deepEqual(Object.keys(mark.result).sort(), ['actual', 'ok']);
});

test('孤儿任务：没有 holder 的任务不自动接管（note 自称是我的也不认）', async () => {
  const nowSec = Date.now() / 1000;
  const tasks = {
    forged: task('forged', {
      status: 'running',
      machine: 'PC2',
      holder: '',
      note: 'worker:PC2 inst:PC2/9-zz stage=exec',
      lease_until: nowSec - 600,
    }),
    alsoForged: task('alsoForged', {
      status: 'claimed',
      machine: 'PC2',
      holder: '',
      note: 'hello worker:PC2 inst:PC2/7-aa',
      lease_until: nowSec - 600,
    }),
  };
  const boards = makeBoard(tasks);
  const worker = makeWorker(boards, async () => doneOutcome());
  const res = await worker.recoverOrphans();
  assert.deepEqual(res.adopted, [], '没有 holder 的任务一律不接管（归属不能靠 note 自由文本）');
  assert.equal(tasks.forged.status, 'running');
  assert.equal(tasks.alsoForged.status, 'claimed');
});

test('进度上行前也要脱敏（同一条 job.progress 会被 beat 与 status 读出）', async () => {
  let seen = '';
  let home = '';
  const boards = makeBoard({ t1: task('t1') });
  const worker = makeWorker(
    boards,
    async (t, { onProgress }) => {
      home = os.homedir();
      onProgress(`进度 token Tok-abcdef123456 at ${home}\\out.txt`);
      seen = String(worker.status().jobs[0].progress || '');
      return doneOutcome();
    },
    { token: 'Tok-abcdef123456' },
  );
  await worker.tick();
  await worker.waitForIdle({ timeoutMs: 3000 });
  assert.ok(seen.includes('进度'), `进度原文应保留（只脱敏凭证）：${seen}`);
  assert.ok(!seen.includes('Tok-abcdef123456'), `进度泄漏 token：${seen}`);
  assert.ok(!seen.includes(home), `进度泄漏家目录：${seen}`);
});


test('终态 beat 409：停止心跳并 abort 本地执行，不累计失败', async () => {
  let aborted = false;
  const boards = makeBoard({ t1: task('t1') }, { beatTerminal409: true });
  const worker = makeWorker(
    boards,
    async (t, { signal }) => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          resolve();
        });
      });
      return doneOutcome();
    },
    { beatMs: 20, pollMs: 10 },
  );
  await worker.start();
  await new Promise((r) => setTimeout(r, 150));
  await worker.stop({ waitMs: 200 });
  assert.equal(aborted, true, '终态 409 应 abort 本地执行');
  const beats = boards.calls.filter((c) => c.kind === 'beat').length;
  assert.ok(beats <= 2, '终态后不应继续心跳 beats=' + beats);
});
// v2.6.28（安全审计 C-2）：claimOne 非 409/400/404 错误只断循环不 backoff——
// 看板持续 500 时 worker 以 2s interval 打 claim，不退避。
test('claim 非 409/400/404 错误 → tick 返回 backoffMs（与 snapshot 失败同路径）', async () => {
  const boards = makeBoard({ t1: task('t1') }, { claimError500: true });
  // 让 claim 返回 500
  boards.claim = async (body) => { boards.calls.push({ kind: 'claim', ...body }); return { ok: false, status: 500, error: 'server error', network: true }; };
  const worker = makeWorker(boards, async () => doneOutcome(), { backoffMs: 200, maxBackoffMs: 1000 });
  const res = await worker.tick();
  assert.equal(res.claimed.length, 0);
  assert.ok(res.backoffMs > 0, `claim 500 应返回 backoffMs，got ${res.backoffMs}`);
  await worker.stop({ waitMs: 100 });
});
