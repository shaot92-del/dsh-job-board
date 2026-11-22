import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDshResult,
  sanitizeResult,
  cleanNumber,
  parseDshArtifact,
  formatResultSummary,
  RESULT_PREFIX,
  MAX_REASON_CHARS,
  MAX_REASON_INPUT_CHARS,
  MAX_REASONS,
  maskReasons,
  maskDetailText,
} from '../../lib/worker/result.js';

test('parseDshResult：取最后一条，忽略前面的旧结果', () => {
  const stdout = [
    'noise',
    'DSH_RESULT {"ok":false,"reasons":["第一次"]}',
    'more noise',
    'DSH_RESULT {"ok":true,"expected":30,"actual":30}',
    'tail',
  ].join('\r\n');
  const r = parseDshResult(stdout);
  assert.equal(r.found, true);
  assert.equal(r.error, '');
  assert.deepEqual(r.result, { ok: true, expected: 30, actual: 30 });
});

test('parseDshResult：没有 DSH_RESULT 行', () => {
  const r = parseDshResult('hello\nworld');
  assert.equal(r.found, false);
  assert.equal(r.error, 'not-found');
  assert.equal(r.result, null);
});

test('parseDshResult：前缀大小写与缩进都容忍，但必须在行首（trim 后）', () => {
  const r = parseDshResult('   dsh_result   {"ok":true}');
  assert.equal(r.found, true);
  assert.deepEqual(r.result, { ok: true });
});

test('parseDshResult：脏数据逐类报错而不是静默通过', () => {
  assert.equal(parseDshResult('DSH_RESULT').error, 'payload-empty');
  assert.equal(parseDshResult('DSH_RESULT true').error, 'payload-not-json-object');
  assert.equal(parseDshResult('DSH_RESULT [1,2]').error, 'payload-not-json-object');
  const bad = parseDshResult('DSH_RESULT {oops}');
  assert.equal(bad.found, true);
  assert.match(bad.error, /^invalid-json: /);
  // 合法 JSON 但不是对象 / 缺布尔 ok → shape-invalid
  assert.equal(parseDshResult('DSH_RESULT "x"').error, 'payload-not-json-object');
  assert.equal(parseDshResult('DSH_RESULT {"ok":"yes"}').error, 'shape-invalid');
  assert.equal(parseDshResult('DSH_RESULT {"expected":3}').error, 'shape-invalid');
});

test('cleanNumber：越界与非法值返回 undefined（不落成 0）', () => {
  assert.equal(cleanNumber(30), 30);
  assert.equal(cleanNumber('30'), 30);
  assert.equal(cleanNumber(1.23456), 1.235);
  assert.equal(cleanNumber(-1), undefined);
  assert.equal(cleanNumber(1e13), undefined);
  assert.equal(cleanNumber('abc'), undefined);
  assert.equal(cleanNumber(true), undefined);
});

test('sanitizeResult：ok 必须是布尔，reasons 只取前 5 条且不提前截断（脱敏后才截断）', () => {
  assert.equal(sanitizeResult(null), null);
  assert.equal(sanitizeResult([]), null);
  assert.equal(sanitizeResult({ ok: 1 }), null);

  const long = 'x'.repeat(MAX_REASON_CHARS + 40); // 160 字符，仍在净化输入上限内
  const reasons = Array.from({ length: 7 }, (_, i) => (i === 0 ? long : `r${i}`));
  const out = sanitizeResult({ ok: true, expected: 5, actual: 4, reasons: [...reasons, '  ', 123] });
  assert.equal(out.ok, true);
  assert.equal(out.expected, 5);
  assert.equal(out.actual, 4);
  assert.equal(out.reasons.length, MAX_REASONS);
  // 净化阶段不截断（否则跨 120 边界的 token 会被切成残片，maskResult 匹配不到）
  assert.equal(out.reasons[0].length, MAX_REASON_CHARS + 40);
  assert.equal(out.reasons[0], long);
  // 空串与非字符串被丢弃、接下来的条目顶上
  assert.equal(out.reasons[1], 'r1');
});

test('sanitizeResult：内部换行压成空格（note 必须单行）', () => {
  const out = sanitizeResult({ ok: false, reasons: ['a\nb\r\nc'] });
  assert.deepEqual(out.reasons, ['a b c']);
});

test('parseDshArtifact：取最后一条并截断', () => {
  assert.equal(parseDshArtifact('x\nDSH_ARTIFACT L:\\out\\a.html\n'), 'L:\\out\\a.html');
  assert.equal(parseDshArtifact('none'), '');
  assert.equal(parseDshArtifact(`DSH_ARTIFACT ${'p'.repeat(500)}`).length, 300);
});

test('formatResultSummary：单行摘要', () => {
  assert.equal(formatResultSummary(null), 'result=none');
  assert.equal(formatResultSummary({ ok: true, expected: 3, actual: 2, reasons: ['x'] }), 'result=ok expected=3 actual=2 reasons=1');
  assert.equal(formatResultSummary({ ok: false }), 'result=not-ok');
  assert.equal(RESULT_PREFIX, 'DSH_RESULT');
});

test('sanitizeResult：只做 4096 字符的内存上限，不做 120 字符最终截断', () => {
  const huge = 'y'.repeat(MAX_REASON_INPUT_CHARS + 500);
  const out = sanitizeResult({ ok: true, reasons: [huge] });
  assert.equal(out.reasons[0].length, MAX_REASON_INPUT_CHARS);
});

test('sanitizeResult：跨越 120 字符边界的 token 保持完整，交由 maskResult 打码', () => {
  const t_oken = 'tok_1234567890abcdef1234567890abcdef';
  const pad = 'z'.repeat(MAX_REASON_CHARS - 10); // token 从第 110 字符开始，跨过 120 边界
  const reason = pad + t_oken + 'tail';
  const out = sanitizeResult({ ok: false, reasons: [reason] });
  assert.ok(out.reasons[0].includes(t_oken), '净化阶段必须保留完整 token，否则下游打码必漏');
});

test('maskReasons（v2.7.7）：先打码再截 120，跨边界 token 不留残片', () => {
  const token = 'tok_1234567890abcdef1234567890abcdef';
  const pad = 'z'.repeat(MAX_REASON_CHARS - 10); // token 从第 110 字符开始，跨过 120 边界
  const out = maskReasons([pad + token + 'tail'], { secrets: [token] });
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= MAX_REASON_CHARS, '必须 ≤120');
  assert.ok(!out[0].includes(token), 'token 必须已被打码');
  assert.ok(!out[0].includes(token.slice(0, 12)), '跨边界的 token 前缀残片也不能落板');
});

test('maskReasons：最多 5 条、过滤空串、非数组返回空', () => {
  const many = ['a', '', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(maskReasons(many).length, MAX_REASONS);
  assert.deepEqual(maskReasons(null), []);
  assert.deepEqual(maskReasons('nope'), []);
});

test('maskReasons：家目录打码（note 上板前不能泄露用户名）', () => {
  const home = 'C:\\Users\\tester';
  const out = maskReasons(['读取 ' + home + '\\secret.txt 失败'], { home });
  assert.ok(!out[0].includes('tester'), '家目录必须被打码');
});

test('maskDetailText（v2.7.7）：打码 + 拉平 + 截断，token 跨 200 边界也不漏', () => {
  const token = 'board_token_abcdef1234567890';
  const line = 'x'.repeat(190) + token + 'y'.repeat(40);
  const out = maskDetailText(line, { secrets: [token], max: 200 });
  assert.ok(out.length <= 200);
  assert.ok(!out.includes(token));
  assert.ok(!out.includes(token.slice(0, 8)));
  assert.equal(maskDetailText('a\nb\r\nc', { max: 200 }), 'a b c');
});