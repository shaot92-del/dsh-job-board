// 票据 CLI（scripts/maint-ticket.mjs）的单元测试。
// 目的：签/验闭环、机器绑定、payload 绑定、时间窗与 nonce 形态都要有独立断言——
// 这些是「一次性授权」的全部安全性质，任何一条失守都等于票据可被复用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLOCK_SKEW_MS,
  keygen,
  loadPublicKeyB64,
  main,
  signGoal,
  splitGoal,
  verifyGoal,
} from '../../scripts/maint-ticket.mjs';
import { MAINT_TICKET_VERSION, MIN_NONCE_LEN, payloadSha256 } from '../../lib/worker/maint-ticket.js';

const PAYLOAD = '{"verb":"config-set","set":{"agentApproval":"auto"}}';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maint-cli-'));
}

function makeKey(dir) {
  const file = path.join(dir, 'key.json');
  keygen({ out: file });
  return file;
}

test('splitGoal：payload 与 ticket 分开，payload 原样保留', () => {
  const r = splitGoal(`${PAYLOAD}\nticket=abcDEF_123`);
  assert.equal(r.ok, true);
  assert.equal(r.payloadText, PAYLOAD);
  assert.equal(r.ticket, 'abcDEF_123');
});

test('splitGoal：容忍 CRLF 与尾部空行', () => {
  const r = splitGoal(`{"a":1}\r\nticket=xyz\r\n\r\n`);
  assert.equal(r.ok, true);
  assert.equal(r.payloadText, '{"a":1}');
  assert.equal(r.ticket, 'xyz');
});

test('splitGoal：没有 ticket 行 → 失败', () => {
  assert.equal(splitGoal(PAYLOAD).ok, false);
});

test('splitGoal：只有 ticket 行没有 payload → 失败', () => {
  assert.equal(splitGoal('ticket=abc').ok, false);
});

test('splitGoal：空串 → 失败', () => {
  assert.equal(splitGoal('   ').ok, false);
});

test('keygen：写出的 key 文件含公钥，且公钥可重新读出', () => {
  const dir = tmpDir();
  const file = makeKey(dir);
  const b64 = loadPublicKeyB64(file);
  assert.ok(b64.length > 20);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, MAINT_TICKET_VERSION);
  assert.ok(parsed.privateKeyB64.length > 20);
});

test('signGoal → verifyGoal：闭环通过', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const { goalText, fields } = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  const r = verifyGoal({ goalText, keyFile, machine: 'gt14' });
  assert.equal(r.ok, true, r.error);
  assert.equal(fields.payloadHash, payloadSha256(PAYLOAD));
  assert.equal(r.ticket.machine, 'gt14');
});

test('verifyGoal：机器不一致 → wrongmachine', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const { goalText } = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  assert.equal(verifyGoal({ goalText, keyFile, machine: 'pc2' }).error, 'wrongmachine');
});

test('verifyGoal：payload 被改 → payload-mismatch', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const { goalText } = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  const tampered = goalText.replace('"auto"', '"confirm"');
  assert.equal(verifyGoal({ goalText: tampered, keyFile, machine: 'gt14' }).error, 'payload-mismatch');
});

test('verifyGoal：票据字段被改（JSON 合法但签名不符）→ badsig', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const { goalText } = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  const [payloadLine, ticketLine] = goalText.split('\n');
  const ticket = JSON.parse(Buffer.from(ticketLine.slice('ticket='.length), 'base64url').toString('utf8'));
  ticket.nonce = `${ticket.nonce.slice(0, -1)}X`;
  const reencoded = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
  const r = verifyGoal({ goalText: `${payloadLine}\nticket=${reencoded}`, keyFile, machine: 'gt14' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'badsig');
});

test('verifyGoal：换一把私钥签的票据验不过（公钥不匹配）', () => {
  const dir = tmpDir();
  const keyA = makeKey(path.join(dir, 'a'));
  const keyB = makeKey(path.join(dir, 'b'));
  const { goalText } = signGoal({ keyFile: keyA, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  assert.equal(verifyGoal({ goalText, keyFile: keyB, machine: 'gt14' }).error, 'badsig');
});

test('verifyGoal：时间窗之外 → expired', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const now = Date.now();
  const { goalText } = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set', ttlSec: 60, now });
  assert.equal(verifyGoal({ goalText, keyFile, machine: 'gt14', now: now + 120_000 }).error, 'expired');
  assert.equal(verifyGoal({ goalText, keyFile, machine: 'gt14', now }).ok, true);
});

test('signGoal：ttl 夹在 30..3600 秒；notBefore 往前放时钟偏差', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const now = Date.now();
  const short = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set', ttlSec: 1, now });
  // 有效期从**签发这一刻**算（notAfter - now = ttl），notBefore 提前只放宽「生效」，
  // 所以 notAfter - notBefore 会多出 CLOCK_SKEW_MS，这是有意为之（副机时钟慢几秒不该假性过期）。
  assert.equal(short.fields.notAfter - now, 30_000);
  assert.equal(short.fields.notBefore, now - CLOCK_SKEW_MS);
  const long = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set', ttlSec: 99_999, now });
  assert.equal(long.fields.notAfter - now, 3_600_000);
  assert.equal(long.fields.notBefore, now - CLOCK_SKEW_MS);
});

test('signGoal：nonce 每次不同、长度达最小要求', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const a = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  const b = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: 'config-set' });
  assert.notEqual(a.fields.nonce, b.fields.nonce);
  assert.ok(a.fields.nonce.length >= MIN_NONCE_LEN);
  assert.ok(b.fields.nonce.length >= MIN_NONCE_LEN);
});

test('signGoal：缺 machine / verb 直接抛错', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  assert.throws(() => signGoal({ keyFile, payloadText: PAYLOAD, verb: 'config-set' }), /machine/);
  assert.throws(() => signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14' }), /verb/);
});
// ── v2.6.28（U-6 / U-7 / U-9）────────────────────────────────────────────

// v2.6.28（U-6）：签发票据不校验 payload.verb——空/错也能签出票，到副机才
// maint-verb-unknown，白跑一趟。signGoal 加 verb 白名单校验。
test('signGoal：空 verb 字符串 → 抛', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  assert.throws(
    () => signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: '' }),
    /upgrade\/config-set\/restart/,
  );
});

test('signGoal：合法 verb（upgrade / restart）通过并产出 ticket', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  for (const v of ['upgrade', 'restart']) {
    const { goalText, fields } = signGoal({ keyFile, payloadText: PAYLOAD, machine: 'gt14', verb: v });
    assert.equal(fields.verb, v);
    assert.ok(goalText.includes('ticket='), `合法 verb ${v} 应产出 ticket=`);
  }
});

// v2.6.28（U-7）：keygen 私钥不设 0600——权限跟随 umask，可能 0644。
// 写时给 0o600 + chmodSync 兜底（Windows 上 chmod 是 no-op，跳过权限断言）。
test('keygen：私钥文件存在且含 privateKeyB64，POSIX 上权限 0600', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'key.json');
  keygen({ out: file });
  assert.ok(fs.existsSync(file), '私钥文件应存在');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.privateKeyB64.length > 20, '文件内容含 privateKeyB64');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `私钥文件权限应为 0600，实际 ${mode.toString(8)}`);
  }
});

// v2.6.28（U-9）：sign 的 --payload 读文件没有友好错误——文件不存在/不是 JSON 时抛栈迹。
// try/catch 包住，输出友好错误 + return 2。
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { result: fn(), stderr: lines.join('') }; }
  finally { process.stderr.write = orig; }
}

test('main sign：payload 文件不存在 → 退出码 2 且 stderr 友好', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const { result, stderr } = captureStderr(() =>
    main(['sign', '--key', keyFile, '--payload', path.join(dir, 'nope.json')]),
  );
  assert.equal(result, 2, '不存在的 payload 路径应返回 2');
  assert.match(stderr, /payload 文件读不到/, `stderr 应友好说明读不到：${stderr}`);
});

test('main sign：payload 不是合法 JSON → 退出码 2 且 stderr 友好', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{not json', 'utf8');
  const { result, stderr } = captureStderr(() => main(['sign', '--key', keyFile, '--payload', badFile]));
  assert.equal(result, 2, '坏 JSON payload 应返回 2');
  assert.match(stderr, /不是合法 JSON/, `stderr 应友好说明不是合法 JSON：${stderr}`);
});

test('main sign：payload.verb 不在白名单 → 退出码 2 且 stderr 友好', () => {
  const dir = tmpDir();
  const keyFile = makeKey(dir);
  const badFile = path.join(dir, 'goal.json');
  fs.writeFileSync(badFile, JSON.stringify({ verb: 'reboot' }), 'utf8');
  const { result, stderr } = captureStderr(() => main(['sign', '--key', keyFile, '--payload', badFile]));
  assert.equal(result, 2, '非法 verb 应返回 2');
  assert.match(stderr, /upgrade\/config-set\/restart/, `stderr 应说明合法 verb：${stderr}`);
});
