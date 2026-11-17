// Host 侧派工判定的单测（v2.6.12）。
// 审计 P2 指出：`dispatchOnce()` 里那段「maint 不该派给 remote-agent」的过滤
// 原本是内联 filter，零断言 —— 改坏了（把 maint 放回去当 agent 派）没有任何测试会响。
// 判定抽到 lib/dispatch-filter.js 后在这里锁住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { isMaintMode, normalizeTaskMode, shouldAutoDispatch } from '../../lib/dispatch-filter.js';

const base = { dispatch: 'auto', status: 'queued', mode: '', remote: undefined };

test('isMaintMode：前缀认 maint（板子把 mode 截到 10 字符，`maintenanc` 也算）', () => {
  assert.equal(isMaintMode('maint'), true);
  assert.equal(isMaintMode('maintenanc'), true);
  assert.equal(isMaintMode('maintenance'), true);
  assert.equal(isMaintMode('MAINT'), true);
  assert.equal(isMaintMode('  Maint  '), true);
  // 板子落库走 Python .strip()，它不吃 BOM —— BOM 必须在这里被剥掉，否则两边判据分叉
  assert.equal(isMaintMode('\uFEFFmaint'), true);
});

test('isMaintMode：agent / exec / 空 / 其他前缀都不算', () => {
  for (const mode of ['agent', 'exec', 'Agent', '', null, undefined, 'mainmenu']) {
    assert.equal(isMaintMode(mode), false, `mode=${JSON.stringify(mode)}`);
  }
  // 前缀判据的已知边界：`maintain` / `maintenance-x` 也会被认成 maint。
  // 这方向是**安全**的（副机随后按未知动词挡住，任务变 blocked 而不是被当 agent 派出去），
  // 反过来漏认才会让 maint 落到 remote-agent 手里。
  assert.equal(isMaintMode('maintain'), true);
  assert.equal(isMaintMode('maintenance-x'), true);
});

test('normalizeTaskMode：去 BOM、去空白、小写', () => {
  assert.equal(normalizeTaskMode('\uFEFF  EXEC '), 'exec');
  assert.equal(normalizeTaskMode(null), '');
  assert.equal(normalizeTaskMode(undefined), '');
});

test('shouldAutoDispatch：queued/stale + auto + 无 remote 才派', () => {
  assert.equal(shouldAutoDispatch({ ...base }), true);
  assert.equal(shouldAutoDispatch({ ...base, status: 'stale' }), true);
  assert.equal(shouldAutoDispatch({ ...base, status: 'running' }), false);
  assert.equal(shouldAutoDispatch({ ...base, status: 'done' }), false);
  assert.equal(shouldAutoDispatch({ ...base, dispatch: 'manual' }), false);
  assert.equal(shouldAutoDispatch({ ...base, dispatch: undefined }), false);
  assert.equal(shouldAutoDispatch({ ...base, remote: 'r-1' }), false);
  assert.equal(shouldAutoDispatch(null), false);
  assert.equal(shouldAutoDispatch(undefined), false);
});

test('shouldAutoDispatch：maint 任务永不被 Host 派给 remote-agent', () => {
  for (const mode of ['maint', 'maintenanc', 'MAINTENANCE', '\uFEFFmaint']) {
    assert.equal(shouldAutoDispatch({ ...base, mode }), false, `mode=${JSON.stringify(mode)}`);
  }
  // 对照：同一条件换成 agent/exec 就该派 —— 否则上面的 false 可能来自别的条件
  assert.equal(shouldAutoDispatch({ ...base, mode: 'agent' }), true);
  assert.equal(shouldAutoDispatch({ ...base, mode: 'exec' }), true);
});
