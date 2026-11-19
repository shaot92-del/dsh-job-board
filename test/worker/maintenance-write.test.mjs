// maintenance 写动词接线（v2.7 A2 主控侧）：票据校验 → 落 nonce → 执行 → 结果回板。
//
// 这里用**注入的假实现**（opts.verbs）来测接线本身，不依赖 lib/worker/maint-verbs.js
// 有没有落盘 —— 那是盘古并行在写的模块。契约一旦对齐，换掉这个假实现即可。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseMaintenanceGoal,
  splitTicketLine,
  createMaintenanceRunner,
  MAINT_WRITE_VERBS,
} from '../../lib/worker/maintenance.js';
import {
  MAINT_TICKET_VERSION,
  generateEd25519KeyPair,
  exportPublicSpkiB64,
  importPublicSpki,
  readUsedNonces,
  payloadSha256,
  signTicket,
} from '../../lib/worker/maint-ticket.js';
import { CLOCK_SKEW_MS, keygen, signGoal } from '../../scripts/maint-ticket.mjs';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jb-maint-${tag}-`));
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, tail: () => [] };

function makeKeys() {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  return { privateKey, pubB64: exportPublicSpkiB64(importPublicSpki(exportPublicSpkiB64(publicKey))) };
}

/** 签一张票并拼出完整的 goal 文本（payload + 末行 ticket=） */
function makeGoal({ payload, privateKey, machine = 'gt14', verb = 'config-set', ttlSec = 600, nonce, notBefore }) {
  const payloadText = JSON.stringify(payload);
  const now = Date.now();
  const ticket = signTicket(
    {
      v: MAINT_TICKET_VERSION,
      taskId: 'task-1',
      machine,
      verb,
      payloadHash: payloadSha256(payloadText),
      notBefore: notBefore ?? now - 1000,
      notAfter: now + ttlSec * 1000,
      nonce: nonce || crypto.randomBytes(12).toString('hex'),
    },
    privateKey,
  );
  const ticketStr = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
  return { goal: `${payloadText}\nticket=${ticketStr}`, ticket, payloadText };
}

function makeRunner({ config = {}, verbs } = {}) {
  const stateDir = config.stateDir || tmpDir('state');
  const outDir = tmpDir('out');
  const keys = makeKeys();
  const cfg = {
    machine: 'gt14',
    maintenanceEnabled: true,
    maintenanceWriteEnabled: true,
    maintAuthPublicKeys: [keys.pubB64],
    stateDir,
    maintenanceOutDir: outDir,
    ...config,
  };
  const runner = createMaintenanceRunner({ config: cfg, log: noopLog, version: '2.7.0-test', verbs });
  return { runner, cfg, keys, stateDir, outDir };
}

// ── 解析 ────────────────────────────────────────────────────────────────

test('splitTicketLine：切出末行票据，payload 原文保持逐字节', () => {
  const { text, ticket } = splitTicketLine('{"verb":"restart"}\nticket=abc123');
  assert.equal(text, '{"verb":"restart"}');
  assert.equal(ticket, 'abc123');
  assert.deepEqual(splitTicketLine('no ticket here'), { text: 'no ticket here', ticket: '' });
  // 只认最后一行；中间出现的 ticket= 不算
  const multi = splitTicketLine('{"a":1}\nticket=x\nticket=zzz');
  assert.equal(multi.text, '{"a":1}\nticket=x');
  assert.equal(multi.ticket, 'zzz');
});

test('parseMaintenanceGoal：只读动词行为不变', () => {
  assert.deepEqual(parseMaintenanceGoal('version'), { ok: true, spec: { verb: 'version' } });
  assert.equal(parseMaintenanceGoal('{"verb":"logs","lines":80}').spec.lines, 80);
  assert.equal(parseMaintenanceGoal('').ok, false);
  assert.equal(parseMaintenanceGoal('nope').ok, false);
});

test('parseMaintenanceGoal：写动词要 JSON + 票据，verb 必须自洽', () => {
  assert.equal(MAINT_WRITE_VERBS.includes('config-set'), true);

  const bare = parseMaintenanceGoal('upgrade');
  assert.equal(bare.ok, false);
  assert.match(bare.error, /必须带 JSON payload/);

  const noTicket = parseMaintenanceGoal('{"verb":"config-set","set":{}}');
  assert.equal(noTicket.ok, false);
  assert.match(noTicket.error, /缺少票据/);

  // payload 里没有 verb 字段 ⇒ 根本认不出是写动词，按未知动词拒
  const noVerb = parseMaintenanceGoal('{"set":{}}\nticket=abc');
  assert.equal(noVerb.ok, false);
  assert.match(noVerb.error, /不认识的 verb/);

  const ok = parseMaintenanceGoal('{"verb":"config-set","set":{"agentApproval":"auto"}}\nticket=abc');
  assert.equal(ok.ok, true);
  assert.equal(ok.spec.verb, 'config-set');
  assert.equal(ok.spec.ticket, 'abc');
  assert.equal(ok.spec.payloadText, '{"verb":"config-set","set":{"agentApproval":"auto"}}');
  assert.deepEqual(ok.spec.payload.set, { agentApproval: 'auto' });
});

// ── 闸门顺序 ─────────────────────────────────────────────────────────────

test('写动词默认关闭：未开 maintenanceWriteEnabled 一律 maint-write-disabled', async () => {
  const { runner, keys } = makeRunner({ config: { maintenanceWriteEnabled: false }, verbs: { run: async () => ({ ok: true }) } });
  const { goal } = makeGoal({ payload: { verb: 'config-set', set: {} }, privateKey: keys.privateKey });
  const r = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'maint-write-disabled');
});

test('没接线实现：同样 maint-write-disabled，且不会消费票据', async () => {
  const { runner, keys, stateDir } = makeRunner({ verbs: null });
  const { goal } = makeGoal({ payload: { verb: 'config-set', set: {} }, privateKey: keys.privateKey });
  const r = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(r.reason, 'maint-write-disabled');
  assert.deepEqual(readUsedNonces(stateDir), []);
});

test('缺票据 / 坏票据：走 maint-ticket-* reason，且不执行', async () => {
  let called = 0;
  const verbs = {
    run: async () => {
      called += 1;
      return { ok: true };
    },
  };
  const { runner, keys } = makeRunner({ verbs });

  const noTicket = await runner.run({ verb: 'config-set', payload: { verb: 'config-set' }, payloadText: '{"verb":"config-set"}', ticket: '' }, { taskId: 't' });
  assert.equal(noTicket.reason, 'maint-ticket-invalid');

  const { goal } = makeGoal({ payload: { verb: 'config-set', set: {} }, privateKey: keys.privateKey });
  const spec = parseMaintenanceGoal(goal).spec;
  const tampered = await runner.run({ ...spec, payloadText: '{"evil":true}' }, { taskId: 't' });
  assert.equal(tampered.reason, 'maint-ticket-payload-mismatch');
  assert.equal(called, 0);
});

test('错机器 / 过期：reason 精确', async () => {
  const { runner, keys } = makeRunner({ verbs: { run: async () => ({ ok: true }) } });

  const wrong = makeGoal({ payload: { verb: 'restart', delayMs: 5000 }, privateKey: keys.privateKey, machine: 'pc2', verb: 'restart' });
  const r1 = await runner.run(parseMaintenanceGoal(wrong.goal).spec, { taskId: 't' });
  assert.equal(r1.reason, 'maint-ticket-wrongmachine');

  const expired = makeGoal({
    payload: { verb: 'restart', delayMs: 5000 },
    privateKey: keys.privateKey,
    verb: 'restart',
    notBefore: Date.now() - 7200_000,
    ttlSec: -3600,
  });
  const r2 = await runner.run(parseMaintenanceGoal(expired.goal).spec, { taskId: 't' });
  assert.equal(r2.reason, 'maint-ticket-expired');
});

// ── 顺序与结果 ───────────────────────────────────────────────────────────

test('先落 nonce 再执行（TOCTOU 顺序）', async () => {
  let seen = null;
  const verbs = {
    supported: (v) => v === 'config-set',
    run: async () => {
      // 执行时 nonce 必须已经在盘上：否则「执行中失败 → 重试」就能重放
      seen = readUsedNonces(stateDirRef.value);
      return { ok: true, reason: 'ok' };
    },
  };
  const stateDirRef = { value: '' };
  const { runner, keys, stateDir } = makeRunner({ verbs });
  stateDirRef.value = stateDir;

  const { goal } = makeGoal({ payload: { verb: 'config-set', set: { agentApproval: 'auto' } }, privateKey: keys.privateKey });
  const r = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'ok');
  assert.equal(seen.length, 1, '执行时 nonce 应已落盘');
});

test('成功路径：回板摘要不含票据/sig，payload 落盘只有结果', async () => {
  const verbs = {
    supported: () => true,
    run: async () => ({ ok: true, reason: 'config-written', note: '写了 2 个键', data: { keys: ['agentEnabled', 'agentPreset'] } }),
  };
  const { runner, keys, outDir } = makeRunner({ verbs });
  const { goal, ticket } = makeGoal({ payload: { verb: 'config-set', set: { agentEnabled: true } }, privateKey: keys.privateKey });
  const r = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });

  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'config-written');
  assert.match(r.note, /stage=maint verb=config-set ok=1 reason=config-written/);
  assert.doesNotMatch(r.note, new RegExp(ticket.sig.slice(0, 12)), 'note 不许出现签名');
  assert.doesNotMatch(JSON.stringify(r.payload), /sig|ticket/i);
  assert.doesNotMatch(JSON.stringify(r.result), /sig/i);

  const file = path.join(outDir, 'gt14', 'tool-config-set.json');
  assert.equal(fs.existsSync(file), true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.ok, true);
  assert.equal(written.verb, 'config-set');
});

test('实现拒绝：ok=false 的 reason 原样透传，状态 blocked', async () => {
  const verbs = { supported: () => true, run: async () => ({ ok: false, reason: 'maint-pkg-not-found', note: '包不在这台机器上' }) };
  const { runner, keys } = makeRunner({ verbs });
  const { goal } = makeGoal({ payload: { verb: 'upgrade', file: 'x.tgz', sha256: 'deadbeef' }, privateKey: keys.privateKey, verb: 'upgrade' });
  const r = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'maint-pkg-not-found');
  assert.equal(r.result.ok, false);
});

test('实现抛错：转 maint-internal + failed（不把异常当成功）', async () => {
  const verbs = { supported: () => true, run: async () => { throw new Error('boom'); } };
  const { runner, keys } = makeRunner({ verbs });
  const { goal } = makeGoal({ payload: { verb: 'restart', delayMs: 5000 }, privateKey: keys.privateKey, verb: 'restart' });
  const r = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'maint-internal');
  assert.match(r.note, /boom/);
});

test('重放：同一张票第二次必被拒（replayed），且不再执行', async () => {
  let calls = 0;
  const verbs = { supported: () => true, run: async () => { calls += 1; return { ok: true, reason: 'ok' }; } };
  const { runner, keys } = makeRunner({ verbs });
  const { goal } = makeGoal({ payload: { verb: 'config-set', set: { a: 1 } }, privateKey: keys.privateKey });

  const first = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(first.status, 'done');
  const second = await runner.run(parseMaintenanceGoal(goal).spec, { taskId: 'tool' });
  assert.equal(second.reason, 'maint-ticket-replayed');
  assert.equal(calls, 1);
});

test('只读动词不受写通道开关影响（回归）', async () => {
  const { runner } = makeRunner({ config: { maintenanceWriteEnabled: false }, verbs: null });
  const r = await runner.run({ verb: 'version' }, { taskId: 'tool' });
  assert.equal(r.status, 'done');
  assert.match(r.note, /stage=maint verb=version/);
});

test('redactConfig：写通道三项排障信息可见，公钥只报数量', async () => {
  const { redactConfig } = await import('../../lib/worker/maintenance.js');
  const red = redactConfig({
    machine: 'gt14',
    maintenanceWriteEnabled: true,
    maintenanceAllowRestart: false,
    maintenancePkgDir: 'C:\\pkgs',
    maintAuthPublicKeys: ['AAAA', 'BBBB'],
    token: 'secret-token',
  });
  assert.equal(red.maintenanceWriteEnabled, true);
  assert.equal(red.maintenanceAllowRestart, false);
  assert.equal(red.maintenancePkgDir, 'C:\\pkgs');
  assert.equal(red.maintAuthPublicKeyCount, 2);
  assert.equal(JSON.stringify(red).includes('secret-token'), false);
  assert.equal(JSON.stringify(red).includes('AAAA'), false, '公钥不整串进 payload');
});

// ── 端到端：CLI 签发 → 副机 runner 消费 ────────────────────────────────────

test('端到端：CLI 签发的票据能被 runner 消费（副机时钟慢 30 秒也算有效）', async () => {
  const dir = tmpDir('e2e');
  const keyFile = path.join(dir, 'maint-key.json');
  const { publicKeyB64 } = keygen({ out: keyFile });

  const payloadText = JSON.stringify({ verb: 'config-set', set: { agentEnabled: true, agentPreset: 'standard' } });
  const issuedAt = Date.now();
  const { goalText } = signGoal({ keyFile, payloadText, machine: 'gt14', verb: 'config-set', ttlSec: 300, now: issuedAt });

  // 副机时钟比主控慢 30 秒：notBefore 若不往前放，这里就会假性 expired
  const slaveNow = () => issuedAt - 30_000;
  const runner = createMaintenanceRunner({
    config: {
      machine: 'gt14',
      maintenanceEnabled: true,
      maintenanceWriteEnabled: true,
      maintAuthPublicKeys: [publicKeyB64],
      stateDir: dir,
    },
    log: noopLog,
    version: '2.7.0-test',
    now: slaveNow,
    verbs: { supported: () => true, run: async () => ({ ok: true, reason: 'config-written', note: 'ok' }) },
  });

  const spec = parseMaintenanceGoal(goalText).spec;
  const r = await runner.run(spec, { taskId: 'e2e' });
  assert.equal(r.status, 'done', r.note);
  assert.equal(r.reason, 'config-written');
  assert.ok(CLOCK_SKEW_MS >= 30_000);
});