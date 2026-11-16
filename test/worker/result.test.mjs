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
  MAX_REASONS,
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

test('sanitizeResult：ok 必须是布尔，reasons 截断到 5 条 ×120 字符', () => {
  assert.equal(sanitizeResult(null), null);
  assert.equal(sanitizeResult([]), null);
  assert.equal(sanitizeResult({ ok: 1 }), null);

  const long = 'x'.repeat(MAX_REASON_CHARS + 40);
  const reasons = Array.from({ length: 7 }, (_, i) => (i === 0 ? long : `r${i}`));
  const out = sanitizeResult({ ok: true, expected: 5, actual: 4, reasons: [...reasons, '  ', 123] });
  assert.equal(out.ok, true);
  assert.equal(out.expected, 5);
  assert.equal(out.actual, 4);
  assert.equal(out.reasons.length, MAX_REASONS);
  assert.equal(out.reasons[0].length, MAX_REASON_CHARS);
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
