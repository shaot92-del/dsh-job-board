// worker-payload-merge.test.mjs —— v2.7.4 治本回归
//
// 真机事故（GT14，2026-11-22）：宿主只把 `config.worker` 子块转发给 worker，
// 写在团队行**顶层**的 maintenanceWriteEnabled / maintAuthPublicKeys / agentEnabled /
// allowlist 全部被丢掉 ⇒ worker 用默认值（写通道 off），而「开写通道」又只能走写通道，
// 形成死锁。这里钉住修法：顶层兜底、子块优先、宿主键不混入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerPayload, maintWriteWarning, mergeWorkerPayload } from '../../lib/worker/config.js';
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
// ---- v2.7.4 追加：宿主载荷组装 / 启动自检文案 ----
test('buildWorkerPayload：宿主键在顶层、worker 里只有转发键', () => {
  const p = buildWorkerPayload(ROW, {
    boardUrl: 'http://host:8965',
    machine: 'host',
    token: 'h-tok',
    timeoutMs: 5000,
    workerMode: 'on',
  });
  assert.equal(p.boardUrl, 'http://host:8965');
  assert.equal(p.machine, 'host');
  assert.equal(p.token, 'h-tok');
  assert.equal(p.timeoutMs, 5000);
  assert.equal(p.workerMode, 'on');
  assert.equal('boardUrl' in p.worker, false, '宿主 boardUrl 不得进 worker');
  assert.equal('machine' in p.worker, false, '宿主 machine 不得进 worker（否则子块会覆盖机器名）');
  assert.equal(p.worker.maintenanceWriteEnabled, true, '顶层写通道键必须被带进 worker');
});

test('buildWorkerPayload：缺省宿主键安全（空 boardUrl、workerMode 默认 on）', () => {
  const p = buildWorkerPayload({}, {});
  assert.equal(p.boardUrl, '');
  assert.equal(p.workerMode, 'on');
  assert.deepEqual(p.worker, {});
});

test('maintWriteWarning：开启时为 null，关闭时给出 patch 路径与修法', () => {
  assert.equal(maintWriteWarning({ maintenanceWriteEnabled: true }, 'C:\\p\\cordis.patch.yml'), null);
  const msg = maintWriteWarning({}, 'C:\\Users\\x\\.dsh\\profiles\\desktop\\cordis.patch.yml');
  assert.match(msg, /maintenanceWriteEnabled=false/);
  assert.match(msg, /cordis\.patch\.yml/);
  assert.match(msg, /enable-maint-write\.ps1/);
  assert.match(maintWriteWarning(null, ''), /未解析到 profile 路径/);
});
test('mergeWorkerPayload：null/数组/非对象入参不抛错、返回空对象', () => {
  assert.deepEqual(mergeWorkerPayload(null), {});
  assert.deepEqual(mergeWorkerPayload([]), {});
  assert.deepEqual(mergeWorkerPayload('x'), {});
  assert.deepEqual(mergeWorkerPayload({ worker: null }), {});
  assert.deepEqual(mergeWorkerPayload({ worker: [] }), {});
});
test('mergeWorkerPayload：子块里的宿主键（workerMode/machine/token）不得顶掉宿主值（v2.7.6，P3-1）', () => {
  const payload = buildWorkerPayload(
    { workerMode: 'off', machine: 'should-not-leak', token: 'nested-token', worker: { workerMode: 'off', machine: 'should-not-leak', token: 'nested-token', agentEnabled: true } },
    { workerMode: 'on', machine: 'gt14', token: 'host-token' },
  );
  assert.equal(payload.workerMode, 'on', '宿主 workerMode 必须留在顶层');
  assert.equal(payload.machine, 'gt14', '宿主 machine 不得被子块覆盖');
  assert.equal(payload.token, 'host-token', '宿主 token 不得被子块覆盖');
  assert.equal(payload.worker.workerMode, undefined, 'workerMode 不是转发键，不得进 worker 块');
  assert.equal(payload.worker.machine, undefined, 'machine 不得进 worker 块');
  assert.equal(payload.worker.token, undefined, 'token 不得进 worker 块');
  assert.equal(payload.worker.agentEnabled, true, '白名单内的子块键仍生效');
  const eff = normalizeConfig(payload);
  assert.equal(eff.config.workerMode, 'on', 'normalizeConfig 不得被残留子块键改回 off');
});

test('v2.7.9：路径配置展开 %VAR% 与 ~（agentCwdRoot / execCwdRoot）', () => {
  const prev = process.env.DSB_TEST_HOME_LIKE;
  process.env.DSB_TEST_HOME_LIKE = 'C:\\Users\\probe';
  try {
    const out = normalizeConfig({
      worker: { agentCwdRoot: '%DSB_TEST_HOME_LIKE%\\Documents', execCwdRoot: '%DSB_TEST_HOME_LIKE%\\Work' },
      agentApproval: 'auto',
    });
    assert.equal(out.config.agentCwdRoot, 'C:\\Users\\probe\\Documents');
    assert.equal(out.config.execCwdRoot, 'C:\\Users\\probe\\Work');
  } finally {
    if (prev === undefined) delete process.env.DSB_TEST_HOME_LIKE;
    else process.env.DSB_TEST_HOME_LIKE = prev;
  }
});

test('v2.7.9：agentApproval 缺省为 auto（与加通讯插件前的派工体验对齐）', () => {
  const out = normalizeConfig({ worker: { agentEnabled: true, agentCwdRoot: 'C:\\work' } });
  assert.equal(out.config.agentApproval, 'auto');
});