// worker-payload-merge.test.mjs —— v2.7.4 治本回归
//
// 真机事故（GT14，2026-11-22）：宿主只把 `config.worker` 子块转发给 worker，
// 写在团队行**顶层**的 maintenanceWriteEnabled / maintAuthPublicKeys / agentEnabled /
// allowlist 全部被丢掉 ⇒ worker 用默认值（写通道 off），而「开写通道」又只能走写通道，
// 形成死锁。这里钉住修法：顶层兜底、子块优先、宿主键不混入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkerPayload } from '../../lib/worker/config.js';
import { normalizeConfig } from '../../lib/worker/config.js';

const ROW = {
  workerMode: 'on',
  boardUrl: 'http://192.168.3.40:8965',
  machine: 'GT14',
  token: 'tok',
  timeoutMs: 8000,
  maintenanceWriteEnabled: true,
  maintAuthPublicKeys: ['K'],
  allowlist: ['C:\\tools'],
  agentEnabled: true,
  agentAllowlist: [{ id: 'any', matchAll: true }],
  worker: { pollMs: 2000, beatMs: 30000, agentEnabled: false, allowlist: [] },
};

function effective(row) {
  return normalizeConfig({
    boardUrl: row.boardUrl,
    machine: row.machine,
    token: row.token,
    timeoutMs: row.timeoutMs,
    workerMode: row.workerMode,
    worker: mergeWorkerPayload(row),
  }).config;
}

test('团队顶层写通道键必须进到 worker 生效值', () => {
  const cfg = effective(ROW);
  assert.equal(cfg.maintenanceWriteEnabled, true, '顶层 maintenanceWriteEnabled 必须生效');
  assert.deepEqual(cfg.maintAuthPublicKeys, ['K']);
});

test('子块优先：worker 里显式 false 压过顶层 true', () => {
  const cfg = effective({ ...ROW, worker: { ...ROW.worker, maintenanceWriteEnabled: false } });
  assert.equal(cfg.maintenanceWriteEnabled, false);
});

test('子块里已有的 agent 闸门不被顶层覆盖（仍是 false）', () => {
  const cfg = effective(ROW);
  assert.equal(cfg.agentEnabled, false, 'worker.agentEnabled=false 必须压过顶层 true');
  assert.deepEqual(cfg.allowlist, [], 'worker.allowlist=[] 必须压过顶层数组');
});

test('宿主键不得混进 worker 块（boardUrl/token/machine 不转发）', () => {
  const m = mergeWorkerPayload(ROW);
  assert.equal('boardUrl' in m, false);
  assert.equal('token' in m, false);
  assert.equal('machine' in m, false);
  assert.equal(m.pollMs, 2000);
});

test('完全没有顶层键时行为不变（老配置向后兼容）', () => {
  const cfg = effective({ workerMode: 'on', worker: { pollMs: 2000 } });
  assert.equal(cfg.maintenanceWriteEnabled, false);
  assert.deepEqual(cfg.maintAuthPublicKeys, []);
});