// maint-ticket.test.mjs — 一次性写授权票据的签发 / 校验 / 重放防护。
//
// 断言的重点：9 步校验序的顺序与 reason 常量、签名覆盖全部 8 字段、
// 重放落盘后跨「新进程」仍拒、payload 哈希比对、used-nonce 集合的 FIFO 淘汰。
// 不联网、不依赖机器状态：临时目录用 fs.mkdtempSync(os.tmpdir() + '/…')。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  MAINT_TICKET_VERSION,
  MAINT_TICKET_REASONS,
  MAX_USED_NONCES,
  canonicalTicketJson,
  signTicket,
  verifySignature,
  exportPublicSpkiB64,
  generateEd25519KeyPair,
  payloadSha256,
  readUsedNonces,
  recordNonce,
  checkTicket,
} from '../../lib/worker/maint-ticket.js';

// ── 测试夹具 ────────────────────────────────────────────────────────────

const DEFAULT_PAYLOAD = '{"file":"pkg.zip","sha256":"deadbeef","restart":true}';

function keyPair() {
  return generateEd25519KeyPair();
}

function b64pub(kp) {
  return exportPublicSpkiB64(kp.publicKey);
}

/**
 * 构造一张合法票据。overrides 可覆盖字段（含 payload —— payload 变了 payloadHash 跟着重算）。
 * @param {{privateKey: crypto.KeyObject}} kp
 * @param {object} overrides
 */
function makeTicket(kp, overrides = {}) {
  const payload = overrides.payload ?? DEFAULT_PAYLOAD;
  const fields = {
    v: MAINT_TICKET_VERSION,
    taskId: 'task-1',
    machine: 'gt14',
    verb: 'upgrade',
    payloadHash: payloadSha256(payload),
    notBefore: 1000,
    notAfter: 2000,
    nonce: 'nonce-0000000000000001',
    ...overrides,
  };
  return signTicket(fields, kp.privateKey);
}

/**
 * 构造 checkTicket 的 ctx。overrides.config 合并进默认配置；其余字段直接覆盖。
 */
function makeCtx(kp, overrides = {}) {
  const config = {
    maintenanceEnabled: true,
    maintAuthPublicKeys: [b64pub(kp)],
    machine: 'gt14',
    ...overrides.config,
  };
  return {
    config,
    payload: overrides.payload ?? DEFAULT_PAYLOAD,
    stateDir: overrides.stateDir ?? '',
    now: overrides.now ?? (() => 1500),
  };
}

/** 真临时目录（落盘测试用，不依赖机器状态） */
function tmpDir() {
  return fs.mkdtempSync(os.tmpdir() + '/maint-ticket-');
}

// ── 常量与规范化 JSON ───────────────────────────────────────────────────

test('MAINT_TICKET_VERSION = 1', () => {
  assert.equal(MAINT_TICKET_VERSION, 1);
});

test('MAINT_TICKET_REASONS：8 个 reason 常量与冻结', () => {
  assert.equal(MAINT_TICKET_REASONS.DISABLED, 'maint-write-disabled');
  assert.equal(MAINT_TICKET_REASONS.INVALID, 'maint-ticket-invalid');
  assert.equal(MAINT_TICKET_REASONS.UNTRUSTED, 'maint-ticket-untrusted');
  assert.equal(MAINT_TICKET_REASONS.BADSIG, 'maint-ticket-badsig');
  assert.equal(MAINT_TICKET_REASONS.WRONGMACHINE, 'maint-ticket-wrongmachine');
  assert.equal(MAINT_TICKET_REASONS.EXPIRED, 'maint-ticket-expired');
  assert.equal(MAINT_TICKET_REASONS.REPLAYED, 'maint-ticket-replayed');
  assert.equal(MAINT_TICKET_REASONS.PAYLOAD_MISMATCH, 'maint-ticket-payload-mismatch');
  assert.throws(() => {
    MAINT_TICKET_REASONS.BADSIG = 'x';
  }, TypeError);
});

test('canonicalTicketJson：键字典序、无 sig、无 whitespace', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const json = canonicalTicketJson(t);
  const keys = Object.keys(JSON.parse(json));
  // 字典序（lexicographic）—— 这是 sign 与 verify 的同一消息
  assert.deepEqual(keys, ['machine', 'nonce', 'notAfter', 'notBefore', 'payloadHash', 'taskId', 'v', 'verb']);
  assert.equal(json.includes('"sig"'), false, 'sig 不参与签名消息');
  assert.equal(json.includes(' '), false, '无 whitespace');
  assert.equal(json.includes('\n'), false, '无换行');
});

// ── 签发 / 验签 ─────────────────────────────────────────────────────────

test('signTicket → verifySignature：签发后验签通过', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  assert.equal(t.sig.length > 0, true);
  assert.equal(verifySignature(t, kp.publicKey), true);
});

test('checkTicket：合法票据 → ok', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const r = checkTicket(t, makeCtx(kp));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.reason, 'ok');
  assert.equal(r.ticket, t);
});

test('checkTicket：base64url 编码的票据串 → 解码后校验', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const raw = Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
  const r = checkTicket(raw, makeCtx(kp));
  assert.equal(r.ok, true);
  assert.equal(r.ticket.nonce, t.nonce);
  assert.equal(r.ticket.machine, t.machine);
});

test('checkTicket：直接 JSON 串票据 → 解析后校验', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const r = checkTicket(JSON.stringify(t), makeCtx(kp));
  assert.equal(r.ok, true);
});

// ── 验签：篡改任一签名字段 → badsig ──────────────────────────────────────

test('checkTicket：篡改任一签名字段（8 个）全部 → maint-ticket-badsig', () => {
  const kp = keyPair();
  const base = {
    v: 1,
    taskId: 'task-1',
    machine: 'gt14',
    verb: 'upgrade',
    payloadHash: payloadSha256(DEFAULT_PAYLOAD),
    notBefore: 1000,
    notAfter: 2000,
    nonce: 'nonce-0000000000000001',
  };
  // v 与 notBefore 也在签名覆盖内 —— 契约列了 6 个，这里 8 个全测
  const tamper = {
    v: () => 2,
    taskId: () => 'task-2',
    machine: () => 'gt15',
    verb: () => 'restart',
    payloadHash: () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    notBefore: () => 999,
    notAfter: () => 9999,
    nonce: () => 'nonce-0000000000000002',
  };
  for (const f of Object.keys(tamper)) {
    const t = signTicket(base, kp.privateKey);
    t[f] = tamper[f]();
    const r = checkTicket(t, makeCtx(kp));
    assert.equal(r.ok, false, `字段 ${f} 篡改后应该被拒`);
    assert.equal(r.status, 'blocked', `字段 ${f} 篡改后 status=blocked`);
    assert.equal(r.reason, MAINT_TICKET_REASONS.BADSIG, `字段 ${f} 篡改后应为 badsig`);
  }
});

test('checkTicket：缺 sig → maint-ticket-badsig', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  delete t.sig;
  const r = checkTicket(t, makeCtx(kp));
  assert.equal(r.reason, MAINT_TICKET_REASONS.BADSIG);
});

test('checkTicket：公钥不匹配（签名为另一把钥匙） → maint-ticket-badsig', () => {
  const signer = keyPair();
  const other = keyPair();
  const t = makeTicket(signer);
  const ctx = makeCtx(other); // 配置里放的是 other 的公钥
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.BADSIG);
});

test('checkTicket：公钥轮换 —— 票据用旧钥签，配置里新旧钥都在 → ok', () => {
  const old = keyPair();
  const fresh = keyPair();
  const t = makeTicket(old);
  const ctx = makeCtx(old, { config: { maintAuthPublicKeys: [b64pub(fresh), b64pub(old)] } });
  const r = checkTicket(t, ctx);
  assert.equal(r.ok, true);
});

// ── 过期 ────────────────────────────────────────────────────────────────

test('checkTicket：notAfter 已过 → maint-ticket-expired', () => {
  const kp = keyPair();
  const t = makeTicket(kp); // notAfter=2000
  const r = checkTicket(t, makeCtx(kp, { now: () => 3000 }));
  assert.equal(r.reason, MAINT_TICKET_REASONS.EXPIRED);
});

test('checkTicket：notBefore 未到 → maint-ticket-expired', () => {
  const kp = keyPair();
  const t = makeTicket(kp); // notBefore=1000
  const r = checkTicket(t, makeCtx(kp, { now: () => 500 }));
  assert.equal(r.reason, MAINT_TICKET_REASONS.EXPIRED);
});

test('checkTicket：时间正好在 [notBefore, notAfter] 边界 → ok（闭区间）', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  assert.equal(checkTicket(t, makeCtx(kp, { now: () => 1000 })).ok, true); // notBefore
  assert.equal(checkTicket(t, makeCtx(kp, { now: () => 2000 })).ok, true); // notAfter
});

// ── 重放（真临时目录，落盘后新进程读回仍拒） ─────────────────────────────

test('checkTicket：同一票据第二次 → maint-ticket-replayed（落盘后新进程读回仍拒）', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const dir = tmpDir();
  const ctx = makeCtx(kp, { stateDir: dir });

  // 第一次：通过
  const first = checkTicket(t, ctx);
  assert.equal(first.ok, true);

  // 步骤 9：记录 nonce（A2 接力执行前必做）
  const rec = recordNonce(t.nonce, dir);
  assert.equal(rec.ok, true);

  // 第二次：重放被拒
  const second = checkTicket(t, ctx);
  assert.equal(second.ok, false);
  assert.equal(second.reason, MAINT_TICKET_REASONS.REPLAYED);

  // 「新进程」：readUsedNonces 直接从文件读，不走内存缓存 —— 落盘必须真的落了
  const reloaded = readUsedNonces(dir);
  assert.ok(reloaded.includes(t.nonce), 'nonce 必须落盘，新进程读回才看得到');

  // 新的一次 checkTicket（模拟新进程，仍从磁盘读）→ 仍拒
  const third = checkTicket(t, ctx);
  assert.equal(third.reason, MAINT_TICKET_REASONS.REPLAYED);
});

test('checkTicket：不同 nonce 的票据 → 不被重放误拒', () => {
  const kp = keyPair();
  const dir = tmpDir();
  // 先用掉 nonce-a
  const a = makeTicket(kp, { nonce: 'nonce-aaaaaaaaaaaaaaaa' });
  assert.equal(checkTicket(a, makeCtx(kp, { stateDir: dir })).ok, true);
  assert.equal(recordNonce(a.nonce, dir).ok, true);
  // 换 nonce-b 的合法票据 → 仍通过
  const b = makeTicket(kp, { nonce: 'nonce-bbbbbbbbbbbbbbbb' });
  const rb = checkTicket(b, makeCtx(kp, { stateDir: dir }));
  assert.equal(rb.ok, true, '不同 nonce 不应被重放误拒');
});

// ── 错机器 ──────────────────────────────────────────────────────────────

test('checkTicket：machine 不一致 → maint-ticket-wrongmachine', () => {
  const kp = keyPair();
  const t = makeTicket(kp, { machine: 'pc2' }); // 票据写 pc2
  const ctx = makeCtx(kp); // 本机 config.machine = 'gt14'
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.WRONGMACHINE);
});

test('checkTicket：machine 大小写不同但同名 → ok（大小写不敏感）', () => {
  const kp = keyPair();
  const t = makeTicket(kp, { machine: 'GT14' }); // 票据大写
  const ctx = makeCtx(kp, { config: { machine: 'gt14' } }); // 本机小写
  const r = checkTicket(t, ctx);
  assert.equal(r.ok, true);
});

// ── payload 篡改 ─────────────────────────────────────────────────────────

test('checkTicket：payloadHash 与 payload 不符 → maint-ticket-payload-mismatch', () => {
  const kp = keyPair();
  const payloadA = '{"file":"a.zip","sha256":"aaa","restart":false}';
  const payloadB = '{"file":"b.zip","sha256":"bbb","restart":true}';
  const t = makeTicket(kp, { payload: payloadA }); // 票据 hash 是 A
  const ctx = makeCtx(kp, { payload: payloadB }); // 用 B 校验
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.PAYLOAD_MISMATCH);
});

test('checkTicket：payload 一致 → ok', () => {
  const kp = keyPair();
  const p = '{"file":"a.zip","sha256":"aaa","restart":false}';
  const t = makeTicket(kp, { payload: p });
  const ctx = makeCtx(kp, { payload: p });
  const r = checkTicket(t, ctx);
  assert.equal(r.ok, true);
});

// ── 配置关 ──────────────────────────────────────────────────────────────

test('checkTicket：maintenanceEnabled=false → maint-write-disabled', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const ctx = makeCtx(kp, { config: { maintenanceEnabled: false } });
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.DISABLED);
});

test('checkTicket：maintAuthPublicKeys 为空数组 → maint-ticket-untrusted', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const ctx = makeCtx(kp, { config: { maintAuthPublicKeys: [] } });
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.UNTRUSTED);
});

test('checkTicket：maintAuthPublicKeys 缺失 → maint-ticket-untrusted', () => {
  const kp = keyPair();
  const t = makeTicket(kp);
  const ctx = makeCtx(kp, { config: { maintAuthPublicKeys: undefined } });
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.UNTRUSTED);
});

// ── 解析失败 ────────────────────────────────────────────────────────────

test('checkTicket：无票据（null / undefined / 空串） → maint-ticket-invalid', () => {
  const kp = keyPair();
  const ctx = makeCtx(kp);
  assert.equal(checkTicket(null, ctx).reason, MAINT_TICKET_REASONS.INVALID);
  assert.equal(checkTicket(undefined, ctx).reason, MAINT_TICKET_REASONS.INVALID);
  assert.equal(checkTicket('', ctx).reason, MAINT_TICKET_REASONS.INVALID);
});

test('checkTicket：票据串不是合法 base64url JSON 也不是合法 JSON → maint-ticket-invalid', () => {
  const kp = keyPair();
  const ctx = makeCtx(kp);
  assert.equal(checkTicket('@@@@@', ctx).reason, MAINT_TICKET_REASONS.INVALID);
  assert.equal(checkTicket('{bad json', ctx).reason, MAINT_TICKET_REASONS.INVALID);
  assert.equal(checkTicket('12345', ctx).reason, MAINT_TICKET_REASONS.INVALID); // 数字不是对象
});

// ── 校验顺序（步骤 1 先于 2，步骤 3 先于 4） ───────────────────────────

test('checkTicket：顺序 —— 配置关优先于票据无效', () => {
  const kp = keyPair();
  const ctx = makeCtx(kp, { config: { maintenanceEnabled: false } });
  // 票据是 null（本应是 invalid），但配置关应先命中（步骤 1 先于步骤 2）
  const r = checkTicket(null, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.DISABLED);
});

test('checkTicket：顺序 —— 公钥空优先于验签失败', () => {
  const kp = keyPair();
  const t = makeTicket(kp); // 签名合法
  const ctx = makeCtx(kp, { config: { maintAuthPublicKeys: [] } });
  // 票据签名合法，但公钥空应先命中（步骤 3 先于步骤 4）
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.UNTRUSTED);
});

test('checkTicket：顺序 —— 错机器优先于过期', () => {
  const kp = keyPair();
  const t = makeTicket(kp, { machine: 'pc2' }); // 错机器 + 时间在窗口内
  const ctx = makeCtx(kp, { now: () => 1500 });
  // 步骤 5 先于步骤 6 → 应是 wrongmachine 不是 expired
  const r = checkTicket(t, ctx);
  assert.equal(r.reason, MAINT_TICKET_REASONS.WRONGMACHINE);
});

// ── used-nonce 集合管理 ─────────────────────────────────────────────────

test('recordNonce / readUsedNonces：写入后读回，含该 nonce', () => {
  const dir = tmpDir();
  const rec = recordNonce('nonce-a', dir);
  assert.equal(rec.ok, true);
  const list = readUsedNonces(dir);
  assert.ok(list.includes('nonce-a'));
});

test('recordNonce：stateDir 为空 → 不抛，返回 error', () => {
  const rec = recordNonce('nonce-a', '');
  assert.equal(rec.ok, false);
  assert.ok(rec.error.length > 0);
});

test('readUsedNonces：文件缺失 / 损坏 → []，不抛', () => {
  const dir = tmpDir();
  assert.deepEqual(readUsedNonces(dir), []);
  // 写入损坏内容
  fs.writeFileSync(path.join(dir, 'maint-used-nonces.json'), 'not json{', 'utf8');
  assert.deepEqual(readUsedNonces(dir), []);
});

test('recordNonce：超过 1000 条 → FIFO 淘汰，只留最后 1000', () => {
  const dir = tmpDir();
  for (let i = 0; i < MAX_USED_NONCES + 5; i += 1) {
    recordNonce(`nonce-${String(i).padStart(4, '0')}`, dir);
  }
  const list = readUsedNonces(dir);
  assert.equal(list.length, MAX_USED_NONCES);
  // 最旧的 5 条（0000-0004）被淘汰，保留 0005-1004
  assert.ok(!list.includes('nonce-0000'), '最旧的应被 FIFO 淘汰');
  assert.ok(!list.includes('nonce-0004'), '第 5 条也应被淘汰');
  assert.ok(list.includes('nonce-0005'), '第 6 条起应保留');
  assert.ok(list.includes('nonce-1004'), '最新的一条应保留');
});

test('recordNonce：幂等 —— 同一 nonce 写两次，集合里只出现一次', () => {
  const dir = tmpDir();
  assert.equal(recordNonce('nonce-dup', dir).ok, true);
  assert.equal(recordNonce('nonce-dup', dir).ok, true);
  const list = readUsedNonces(dir);
  const count = list.filter((x) => x === 'nonce-dup').length;
  assert.equal(count, 1, '同一 nonce 不应重复进集合');
});
