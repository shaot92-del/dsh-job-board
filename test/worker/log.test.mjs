// 日志脱敏与环形缓冲：worker 侧唯一的「事后现场」。
//
// 为什么值得单测：maskText 是 token / 家目录泄露的最后一道闸。它的行为错在
// 「少打了一个码」这种方向上时，出错现场就是看板上的 note —— 而看板是共享的。
// 反过来，打得太狠（把普通文本也吃了）会把排障现场抹掉，同样是缺陷。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger, LEVELS, maskText } from '../../lib/worker/log.js';

test('maskText：配置里的 secret 一律打码（阈值降到 1 字符）', () => {
  const secrets = ['tok_abcdef123456', 'abc'];
  assert.equal(maskText('use tok_abcdef123456 here', { secrets }), 'use *** here');
  // v2.6.28（U-10）：阈值从 6 降到 1——3 字符的 secret 也要打码（短 token 原样泄露是漏洞）
  assert.equal(maskText('abc def', { secrets }), '*** def');
});

test('maskText：同一个 secret 出现多次全部打码', () => {
  const secrets = ['s3cretvalue'];
  assert.equal(
    maskText('a=s3cretvalue b=s3cretvalue', { secrets }),
    'a=*** b=***',
  );
});

test('maskText：家目录按大小写不敏感替换成 %USERPROFILE%', () => {
  const home = 'C:\\Users\\Alice';
  assert.equal(maskText('at c:\\users\\alice\\proj', { home }), 'at %USERPROFILE%\\proj');
  assert.equal(maskText('at C:\\Users\\Alice', { home }), 'at %USERPROFILE%');
});

test('maskText：家目录里的正则元字符要被转义，不会当成模式', () => {
  const home = 'C:\\Users\\a.b(c)';
  assert.equal(maskText('x C:\\Users\\a.b(c) y', { home }), 'x %USERPROFILE% y');
});

test('maskText：没有秘密也没有家目录时原样返回，且 null/undefined 不炸', () => {
  assert.equal(maskText('plain text'), 'plain text');
  assert.equal(maskText(null), '');
  assert.equal(maskText(undefined), '');
  assert.equal(maskText(42), '42');
});

test('createLogger：低于 minLevel 的日志不进环形缓冲', () => {
  const log = createLogger({ level: 'warn' });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(log.recent().map((x) => x.level), ['warn', 'error']);
});

test('createLogger：环形缓冲按 limit 裁掉最旧的', () => {
  const log = createLogger({ limit: 3 });
  for (const t of ['a', 'b', 'c', 'd', 'e']) log.info(t);
  assert.deepEqual(log.recent().map((x) => x.text), ['c', 'd', 'e']);
  assert.deepEqual(log.recent(2).map((x) => x.text), ['d', 'e']);
});

test('createLogger：secrets 与 home 在写入时就打码（含 extra 对象）', () => {
  const log = createLogger({
    secrets: ['tok_abcdef123456'],
    home: 'C:\\Users\\Alice',
  });
  log.info('cwd C:\\Users\\Alice\\p token tok_abcdef123456', { path: 'C:\\Users\\Alice\\x', token: 'tok_abcdef123456' });
  const [entry] = log.recent();
  assert.ok(!entry.text.includes('Alice'), entry.text);
  assert.ok(!entry.text.includes('tok_abcdef123456'), entry.text);
  assert.ok(!entry.extra.includes('Alice'), entry.extra);
  assert.ok(!entry.extra.includes('tok_abcdef123456'), entry.extra);
  assert.ok(entry.text.includes('%USERPROFILE%'));
  assert.ok(entry.text.includes('***'));
});

test('createLogger：child() 的前缀进 text，且共用同一个环形缓冲', () => {
  const log = createLogger({ level: 'debug' });
  const sub = log.child('exec');
  sub.info('started');
  log.info('parent');
  const texts = log.recent().map((x) => x.text);
  assert.deepEqual(texts, ['exec started', 'parent']);
  // child 的 tail/recent 必须看到父缓冲（副机现场往往只有 child 引用）
  assert.deepEqual(sub.recent().map((x) => x.text), texts);
});

test('createLogger：tail() 每行带 HH:MM:SS 与级别，时间来自注入的 now()', () => {
  const log = createLogger({ now: () => Date.UTC(2026, 10, 18, 12, 34, 56) });
  log.warn('careful');
  const [line] = log.tail(1);
  assert.match(line, /^12:34:56 WARN careful$/);
});

test('createLogger：sink 抛错不能影响主循环', () => {
  const log = createLogger({ sink: () => { throw new Error('sink boom'); } });
  assert.doesNotThrow(() => log.info('still fine'));
  assert.equal(log.recent().length, 1);
});

test('LEVELS 常量顺序：debug→info→warn→error（level 过滤依赖它）', () => {
  assert.deepEqual(LEVELS, ['debug', 'info', 'warn', 'error']);
});

test('createLogger：extra 里的路径要打码（v2.6.16 修复：序列化前打码，反斜杠转义不再漏）', () => {
  const log = createLogger({ home: 'C:\\Users\\Alice' });
  log.info('x', { cwd: 'C:\\Users\\Alice\\proj', nested: { p: 'C:\\Users\\Alice\\a.txt' } });
  const [entry] = log.recent();
  assert.ok(!entry.extra.includes('Alice'), entry.extra);
  // JSON 里反斜杠被转义成 \\，仍然不该出现 Alice
  assert.equal(entry.extra.includes('%USERPROFILE%'), true);
});

test('createLogger：secret 出现在 key 名里也要打码（外层兜底）', () => {
  const log = createLogger({ secrets: ['tok_abcdef123456'] });
  log.info('x', { 'tok_abcdef123456': 1 });
  assert.ok(!log.recent()[0].extra.includes('tok_abcdef123456'));
});

test('createLogger：循环引用的 extra 不能让日志抛错', () => {
  const log = createLogger();
  const a = { name: 'a' };
  a.self = a;
  assert.doesNotThrow(() => log.info('cycle', a));
  assert.equal(log.recent().length, 1);
});

test('createLogger：extra 里的 Date 仍序列化成 ISO（replacer 只动字符串）', () => {
  const log = createLogger();
  log.info('t', { at: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) });
  assert.equal(log.recent()[0].extra, '{"at":"2026-01-02T03:04:05.000Z"}');
});

// ── v2.6.18：独立审查指出的脱敏边角 ────────────────────────────────────────────

test('maskText：家目录的正斜杠形态也要打码（Node 栈 / 工具输出常见）', () => {
  assert.equal(maskText('C:/Users/Alice/proj', { home: 'C:\\Users\\Alice' }), '%USERPROFILE%/proj');
});

test('maskText：file:/// 前缀的家目录也要打码', () => {
  assert.equal(
    maskText('at file:///C:/Users/Alice/proj/a.mjs:3', { home: 'C:\\Users\\Alice' }),
    'at file:///%USERPROFILE%/proj/a.mjs:3',
  );
});

test('maskText：家目录只做前缀不能过度匹配（Al 不该吃掉 Alice）', () => {
  assert.equal(maskText('C:\\Users\\Alice', { home: 'C:\\Users\\Al' }), 'C:\\Users\\Alice');
});

test('maskText：secret 长度边界 1 字符打码、空串跳过', () => {
  // v2.6.28（U-10）：阈值降到 1——1 字符 secret 也要打码
  assert.equal(maskText('va=ab', { secrets: ['a'] }), 'v***=***b');
  // 2 字符 secret 打码
  assert.equal(maskText('v=ab!', { secrets: ['ab'] }), 'v=***!');
});

test('maskText：重叠 secret 从长到短替换，不留后缀残渣', () => {
  assert.equal(
    maskText('abcdef123456789', { secrets: ['abcdef123456', 'abcdef123456789'] }),
    '***',
  );
});

test('maskText：纯空白 secret 被忽略，不误伤正文空格', () => {
  assert.equal(maskText('hello       world', { secrets: ['      '] }), 'hello       world');
});

test('createLogger：带反斜杠/引号的 secret 出现在 key 名里也要打码且 JSON 仍有效', () => {
  const tricky = ['tok\\abc123456', 'tok"abc123456'];
  const log = createLogger({ secrets: tricky });
  log.info('x', { 'tok\\abc123456': 1, 'tok"abc123456': 2 });
  const [entry] = log.recent();
  for (const secret of tricky) assert.equal(entry.extra.includes(secret), false, entry.extra);
  assert.doesNotThrow(() => JSON.parse(entry.extra), entry.extra);
});

test('createLogger：数字形态的 secret 不会把 JSON 打坏', () => {
  const log = createLogger({ secrets: ['123456789'] });
  log.info('x', { pin: 123456789, note: 'ok' });
  const [entry] = log.recent();
  const parsed = JSON.parse(entry.extra);
  assert.equal(entry.extra.includes('123456789'), false, entry.extra);
  assert.equal(parsed.note, 'ok');
});

test('createLogger：序列化失败且 toString 也抛错时，落占位而不抛错', () => {
  const log = createLogger();
  const evil = { name: 'x' };
  evil.self = evil; // 循环引用 → JSON.stringify 抛
  evil.toString = () => { throw new Error('tostring boom'); };
  assert.doesNotThrow(() => log.info('evil', evil));
  assert.equal(log.recent()[0].extra, '[unserializable extra]');
});

test('createLogger：普通对象（toString 是默认的）仍按 JSON 输出', () => {
  const log = createLogger();
  log.info('plain', { a: 1 });
  assert.equal(log.recent()[0].extra, '{"a":1}');
});
// v2.6.28（安全审计 S-10）：secret 替换必须先于 home 替换。旧顺序先做 home
// 替换，secret 含家目录子串时该子串已变 %USERPROFILE%，split(secret) 匹配不上，
// 该 secret 原样漏出。先 secret 后 home 保证两种形态都能打码。
test('maskText：secret 含家目录子串时仍被打码（secret 先于 home 替换）', () => {
  const home = 'C:\\Users\\Alice';
  const secret = 'C:\\Users\\Alice\\token';
  const out = maskText(`use ${secret} here`, { secrets: [secret], home });
  assert.equal(out.includes(secret), false, 'secret 原样漏出');
  assert.equal(out.includes('***'), true, 'secret 应被打码为 ***');
  // home 是 secret 的前缀，secret 被替换后 home 子串也一并消失
  assert.equal(out.includes(home), false, 'home 子串也不应原样出现');
});
// ── v2.6.28（U-10）────────────────────────────────────────────
// maskText 只打码 ≥6 字符的 secret——短 token（如 4 位测试 key）原样泄露。
// 阈值降到 1 字符；空串特判跳过（避免把整段文本打成 ***）。
test('maskText：4 字符 secret 被打码（阈值降到 1）', () => {
  assert.equal(maskText('key=abcd', { secrets: ['abcd'] }), 'key=***');
});

test('maskText：空 secret 不影响输出', () => {
  assert.equal(maskText('hello world', { secrets: [''] }), 'hello world');
  assert.equal(maskText('hello world', { secrets: ['   ', ''] }), 'hello world');
});