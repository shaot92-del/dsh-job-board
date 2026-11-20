import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKER_SESSION_DENY } from '../../lib/worker/index.js';

// v2.7.0（P-2）：worker 会话只读。这条测试钉住「写类工具必须被遮」与
// 「读类工具不许误伤」，两边任何一侧被改都会在这里炸。
const MUST_DENY = [
  'worker_control',
  'board_dispatch',
  'board_claim',
  'board_beat',
  'board_done',
  'board_fail',
  'board_retry',
  'board_attach',
  'board_say',
  'sh_write',
];
const MUST_ALLOW = [
  'worker_status',
  'board_status',
  'board_list',
  'board_options',
  'board_caps',
  'board_metrics',
  'sh_read',
  'sh_list',
];

test('P-2：worker 会话的 deny 列表含全部写类工具', () => {
  assert.equal(WORKER_SESSION_DENY.length, MUST_DENY.length);
  for (const name of MUST_DENY) assert.ok(WORKER_SESSION_DENY.includes(name), `${name} 必须被遮`);
});

test('P-2：读类工具不在 deny 列表里（不许误伤只读能力）', () => {
  for (const name of MUST_ALLOW) assert.ok(!WORKER_SESSION_DENY.includes(name), `${name} 不该被遮`);
});

test('P-2：deny 列表冻结，运行期不能被改写', () => {
  assert.ok(Object.isFrozen(WORKER_SESSION_DENY));
});