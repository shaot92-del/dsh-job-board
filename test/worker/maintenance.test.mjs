// maintenance 只读通道（v2.6.12）：解析 / 脱敏 / 落盘 / 执行器 / 分流。
// 断言的重点不是「能跑」，而是它**不可能**变成第二条 exec 通路。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  MAINTENANCE_VERBS,
  MAX_LOG_LINES,
  DEFAULT_LOG_LINES,
  NOTE_MAX,
  parseMaintenanceGoal,
  redactConfig,
  sanitizeUrl,
  writePayload,
  createMaintenanceRunner,
} from '../../lib/worker/maintenance.js';
import { parseTaskSpec } from '../../lib/worker/task-spec.js';
import { createTaskExecutor } from '../../lib/worker/executor.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {}, tail: () => [] };

function makeRunner(overrides = {}, opts = {}) {
  return createMaintenanceRunner({
    config: { machine: 'PC2', workerMode: 'on', ...overrides },
    log: quietLog,
    version: '2.6.12',
    statusFn: () => ({ mode: 'on', running: true, maxConcurrent: 1, stats: { claimed: 3, done: 2 }, jobs: [] }),
    ...opts,
  });
}

// ── 任务书解析 ──────────────────────────────────────────────────────────

test('parseMaintenanceGoal：裸动词与大小写归一', () => {
  assert.deepEqual(parseMaintenanceGoal('version').spec, { verb: 'version' });
  assert.deepEqual(parseMaintenanceGoal('  LOGS  ').spec, { verb: 'logs', lines: DEFAULT_LOG_LINES });
});

test('parseMaintenanceGoal：JSON 形态给 logs 带行数', () => {
  assert.deepEqual(parseMaintenanceGoal('{"verb":"logs","lines":80}').spec, { verb: 'logs', lines: 80 });
  // 纯数字字符串是自然写法（工具参数常被序列化成字符串），照收
  assert.equal(parseMaintenanceGoal('{"verb":"logs","lines":"120"}').spec.lines, 120);
});

test('parseMaintenanceGoal：只认整数——数组/布尔/小数/十六进制都拒（README 说「纯数字」）', () => {
  // 审计 P3：`Number([50])`=50、`Number(true)`=1、`Number('0x10')`=16 会让
  // 「纯数字」这句承诺变成谎话，也会让日志行数凭空翻倍。
  for (const bad of [[50], true, 12.7, '0x10', '12.7', {}, ' 80x']) {
    const r = parseMaintenanceGoal(JSON.stringify({ verb: 'logs', lines: bad }));
    assert.equal(r.ok, false, `lines=${JSON.stringify(bad)} 应该被拒`);
    assert.match(r.error, /整数/);
  }
});

test('parseMaintenanceGoal：动词表外的输入一律拒绝', () => {
  assert.equal(parseMaintenanceGoal('').ok, false);
  assert.equal(parseMaintenanceGoal('reboot').ok, false);
  assert.equal(parseMaintenanceGoal('upgrade-2.6.12').ok, false);
  assert.equal(parseMaintenanceGoal('{"verb":"sh"}').ok, false);
  // 以 { 开头但不是 JSON：不能悄悄退回「当裸动词」再被拒成 verb-unknown
  assert.match(parseMaintenanceGoal('{"verb":').error, /不是合法 JSON/);
});

test('parseMaintenanceGoal：logs 行数越界即拒（不接受 0 / 负数 / 超大）', () => {
  for (const bad of [0, -1, MAX_LOG_LINES + 1, 'abc']) {
    const r = parseMaintenanceGoal(JSON.stringify({ verb: 'logs', lines: bad }));
    assert.equal(r.ok, false, `lines=${bad} 应该被拒`);
  }
});

test('parseMaintenanceGoal：动词表是冻结常量，不接受注入', () => {
  assert.deepEqual([...MAINTENANCE_VERBS], ['version', 'status', 'config', 'logs']);
  assert.throws(() => MAINTENANCE_VERBS.push('exec'), TypeError);
});

// ── 配置脱敏 ────────────────────────────────────────────────────────────

test('redactConfig：token 永不出现，白名单式重建', () => {
  const red = redactConfig({
    boardUrl: 'http://192.168.3.40:8965',
    machine: 'PC2',
    token: 'super-secret-token',
    npmToken: 'npm_x',
    someFutureSecret: 'leak-me',
  });
  const json = JSON.stringify(red);
  assert.equal(json.includes('super-secret-token'), false);
  assert.equal(json.includes('npm_x'), false);
  // 白名单式重建：没写进 out 的键默认不出现（加字段时安全的失败方向）
  assert.equal(json.includes('leak-me'), false);
  assert.equal(red.boardUrl, 'http://192.168.3.40:8965');
});

test('redactConfig：boardUrl 里的 userinfo 与 query 凭证必须打码（板子的 redact 不管这些）', () => {
  // 审计 P1-#2：板子侧 redact() 只认 `x-board-token` / `token=` 之类，裸 userinfo 不管；
  // 而 config 动词是把 boardUrl 原样送上板子的 —— 不打码就等于把凭证写进 state 和面板。
  const red = redactConfig({ boardUrl: 'http://u:hunter2@10.0.0.5:8965/?token=abc123&machine=PC2' });
  assert.equal(red.boardUrl.includes('hunter2'), false);
  assert.equal(red.boardUrl.includes('abc123'), false);
  assert.match(red.boardUrl, /machine=PC2/, '非凭证的 query 要保住，排障要看');
  assert.equal(sanitizeUrl('not a url?a=1&token=zzz').includes('zzz'), false);
  assert.equal(sanitizeUrl(''), '');
});

test('sanitizeUrl：fragment / 复合键名 / 非 URL 串里的 userinfo 也必须关掉（审计二轮）', () => {
  // ① fragment：OAuth 隐式流把凭证放 `#access_token=…`，旧版只看 searchParams
  const frag = sanitizeUrl('http://h:8965/#access_token=frag-secret-1');
  assert.equal(frag.includes('frag-secret-1'), false, `fragment 里的 token 漏了：${frag}`);
  assert.equal(sanitizeUrl('http://h:8965/#/cb?access_token=at-secret-2').includes('at-secret-2'), false);
  // 裸票据（整段 hash 就是一张高熵串）
  assert.equal(sanitizeUrl('http://h:8965/#deadbeefcafe12345678').includes('deadbeefcafe12345678'), false);
  // 不带凭证的 hash 要保住（前端路由）
  assert.match(sanitizeUrl('http://h:8965/#/settings'), /#\/settings/);

  // ② 复合键名：锚死的 `^token$` 挡不住线上真实写法
  for (const url of [
    'http://h:8965/?x-board-token=bt-secret',
    'http://h:8965/?board_token=bt-secret',
    'http://h:8965/?X-Amz-Signature=sig-secret',
    'http://h:8965/?X-Amz-Security-Token=sts-secret',
  ]) {
    const out = sanitizeUrl(url);
    assert.equal(/bt-secret|sig-secret|sts-secret/.test(out), false, `复合键名漏了：${out}`);
  }

  // ③ 非 URL 串：`u:p@host` 被当成 scheme `u:` 时 userinfo 仍在字面里
  assert.equal(sanitizeUrl('u:hunter2@10.0.0.5:8965/x?token=1').includes('hunter2'), false);
  assert.equal(sanitizeUrl('//u:hunter2@host/x').includes('hunter2'), false);
  assert.equal(sanitizeUrl('not a url token=zzz').includes('zzz'), false);

  // 不带凭证的地址必须原样（排障时 config 输出要能和本机配置对上）
  assert.equal(sanitizeUrl('http://h:8965'), 'http://h:8965');
});

test('redactConfig：白名单原样给出（这正是远程被拒的答案）', () => {
  const red = redactConfig({ allowlist: ['C:\\tools\\a.ps1'], agentAllowlist: ['C:\\tools\\b.ps1'] });
  assert.deepEqual(red.allowlist, ['C:\\tools\\a.ps1']);
  assert.deepEqual(red.agentAllowlist, ['C:\\tools\\b.ps1']);
});

// ── payload 落盘 ────────────────────────────────────────────────────────

test('writePayload：没配目录就不写，配了相对路径就报错（不抛）', () => {
  assert.deepEqual(writePayload('', { a: 1 }), { path: '', error: '' });
  const rel = writePayload('relative\\dir', { a: 1 });
  assert.equal(rel.path, '');
  assert.match(rel.error, /不是绝对路径/);
});

test('writePayload：绝对路径 → <root>/<machine>/<task>-<verb>.json，UTF-8 无 BOM', () => {
  const writes = [];
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(file, body) {
      writes.push({ file, body });
    },
  };
  const root = path.join(path.parse(process.cwd()).root, 'maint-out');
  const out = writePayload(root, { ok: true, verb: 'logs' }, { fs: fakeFs, machine: 'PC2', taskId: 'bd-abc-123', verb: 'logs' });
  assert.equal(out.error, '');
  assert.equal(out.path, path.join(root, 'PC2', 'bd-abc-123-logs.json'));
  assert.equal(writes.length, 1);
  const body = writes[0].body;
  assert.equal(body.charCodeAt(0), '{'.charCodeAt(0), '不许带 BOM');
  assert.equal(JSON.parse(body).verb, 'logs');
});

test('writePayload：盘根（`Z:\`）不能因为多拼一个分隔符就静默不落盘（审计二轮）', () => {
  // `path.resolve('Z:\\')` 已自带尾分隔符，旧代码再 + path.sep 得到 `Z:\\` ⇒ 任何文件都不匹配，
  // 配置成共享盘根（这功能的目标场景）就一条 payload 都不落，只留一句 warn。
  const writes = [];
  const fakeFs = { mkdirSync() {}, writeFileSync(file) { writes.push(file); } };
  const root = path.parse(process.cwd()).root; // 本机就是某个盘根，如 `C:\`
  assert.ok(root.endsWith(path.sep), '前提：盘根自带尾分隔符');
  const out = writePayload(root, { ok: true }, { fs: fakeFs, machine: 'PC2', taskId: 'bd-9', verb: 'logs' });
  assert.equal(out.error, '');
  assert.equal(out.path, path.join(root, 'PC2', 'bd-9-logs.json'));
  assert.equal(writes.length, 1, '盘根下必须真的写一次');
});

test('writePayload：`..` / 保留名 / 尾随点都不许把文件写出 maintenanceOutDir', () => {
  const root = path.join(path.parse(process.cwd()).root, 'maint-out');
  const cases = [
    { machine: '..', taskId: 'bd-1', verb: 'logs', expect: path.join(root, 'machine', 'bd-1-logs.json') },
    { machine: '....', taskId: 'bd-2', verb: 'logs', expect: path.join(root, 'machine', 'bd-2-logs.json') },
    { machine: 'CON', taskId: 'bd-3', verb: 'logs', expect: path.join(root, 'machine', 'bd-3-logs.json') },
    { machine: 'PC2', taskId: '../../evil', verb: 'logs', expect: path.join(root, 'PC2', 'evil-logs.json') },
    { machine: 'PC2', taskId: 'bd-4', verb: '..', expect: path.join(root, 'PC2', 'bd-4-payload.json') },
  ];
  for (const c of cases) {
    const fakeFs = { mkdirSync() {}, writeFileSync() {} };
    const out = writePayload(root, { ok: true }, { fs: fakeFs, machine: c.machine, taskId: c.taskId, verb: c.verb });
    assert.equal(out.error, '', `不应报错：${JSON.stringify(c)}`);
    assert.equal(out.path, c.expect);
    assert.ok(path.resolve(out.path).startsWith(path.resolve(root) + path.sep), '不许跑出 root');
  }
});

test('writePayload：写盘失败只回错误，不抛（盘没映射不该让整条任务失败）', () => {
  const fakeFs = {
    mkdirSync() {
      throw new Error('EPERM');
    },
  };
  const root = path.join(path.parse(process.cwd()).root, 'maint-out');
  const out = writePayload(root, { ok: true }, { fs: fakeFs, machine: 'PC2', taskId: 't1', verb: 'logs' });
  assert.equal(out.path, '');
  assert.match(out.error, /EPERM/);
});

// ── 执行器 ──────────────────────────────────────────────────────────────

test('runner：开关关闭 → blocked/maint-disabled，不出任何数据', async () => {
  const r = makeRunner({ maintenanceEnabled: false });
  assert.equal(r.enabled, false);
  const out = await r.run({ verb: 'version' }, { taskId: 't1' });
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'maint-disabled');
  assert.equal(out.payload, undefined);
});

test('runner：version → 自报版本/平台/开关，artifact 为空（没配 outDir）', async () => {
  const out = await makeRunner().run({ verb: 'version' }, { taskId: 't1' });
  assert.equal(out.status, 'done');
  assert.equal(out.stage, 'maint');
  assert.equal(out.payload.data.plugin, '2.6.12');
  assert.equal(out.artifact, '');
  assert.match(out.note, /^stage=maint verb=version ok=1 plugin=2\.6\.12/);
  assert.ok(out.note.length <= NOTE_MAX);
});

test('runner：status 取自 statusFn（延迟绑定），并算 board 心跳年龄', async () => {
  const now = () => 10_000;
  const r = makeRunner({}, { now, statusFn: () => ({ mode: 'on', running: true, lastBoardOkAt: 4_000, stats: { claimed: 7 } }) });
  const out = await r.run({ verb: 'status' }, {});
  assert.equal(out.payload.data.running, true);
  assert.equal(out.payload.data.lastBoardOkAgeSec, 6);
  assert.equal(out.payload.data.stats.claimed, 7);
});

test('runner：config 的 reasons 必须包含 allowlist（取头部，不是尾部）', async () => {
  // 审计 P2：原来 slice(-5) 取尾部，而 allowlist 排在行序最前、尾部固定被
  // execCwd/pwshPath/orphanPolicy/warning 占满 ⇒ 默认配置下「为什么被拒」永远不回板子。
  const allow = ['C:\\a.ps1', 'C:\\b.ps1', 'C:\\c.ps1', 'C:\\d.ps1'];
  const out = await makeRunner({ allowlist: allow, token: 'secret-token' }, { statusFn: () => ({}) }).run({ verb: 'config' }, {});
  assert.equal(out.status, 'done');
  assert.equal(JSON.stringify(out.payload).includes('secret-token'), false);
  assert.deepEqual(out.payload.data.allowlist, allow);
  assert.ok(out.result.reasons.length <= 5);
  assert.ok(out.result.reasons.some((r) => r.includes('allowlist[0]=C:\\a.ps1')), 'allowlist 必须在 reasons 里');
});

test('runner：logs 的 reasons 取尾部（最新几行），config/version 取头部', async () => {
  const log = { ...quietLog, tail: (n) => Array.from({ length: n }, (_, i) => `line-${i + 1}`) };
  const r = makeRunner({}, { log });
  const out = await r.run({ verb: 'logs', lines: 20 }, {});
  assert.deepEqual(out.result.reasons, ['line-16', 'line-17', 'line-18', 'line-19', 'line-20']);
  assert.equal(out.payload.data.got, 20);
});

test('runner：logs 按请求行数向环形缓冲要，超长行被压成一行', async () => {
  const asked = [];
  const log = { ...quietLog, tail: (n) => (asked.push(n), ['line1', 'line2\nnext', 'x'.repeat(300)]) };
  const out = await makeRunner({}, { log }).run({ verb: 'logs', lines: 3 }, {});
  assert.deepEqual(asked, [3]);
  assert.equal(out.payload.data.lines.length, 3);
  assert.equal(out.payload.data.lines[1], 'line2 next');
  assert.ok(out.payload.data.lines[2].length <= 120);
});

test('runner：配了 outDir 时 artifact 指向落盘文件，payload 完整', async () => {
  const root = path.join(path.parse(process.cwd()).root, 'maint-out2');
  const writes = [];
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(file, body) {
      writes.push({ file, body });
    },
  };
  const out = await makeRunner({ maintenanceOutDir: root }, { fs: fakeFs }).run({ verb: 'version' }, { taskId: 'bd-t-1' });
  assert.equal(out.artifact, path.join(root, 'PC2', 'bd-t-1-version.json'));
  assert.equal(writes.length, 1);
});

test('runner：采集抛错 → failed/maint-internal（不让主循环崩）', async () => {
  const r = makeRunner({}, {
    statusFn: () => {
      throw new Error('boom');
    },
  });
  const out = await r.run({ verb: 'status' }, {});
  assert.equal(out.status, 'failed');
  assert.equal(out.reason, 'maint-internal');
  assert.match(out.note, /boom/);
});

test('runner：未知动词 → blocked/maint-verb-unknown', async () => {
  const out = await makeRunner().run({ verb: 'reboot' }, {});
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'maint-verb-unknown');
});

// ── 契约与分流 ──────────────────────────────────────────────────────────

test('parseTaskSpec：mode=maintenance → kind=maintenance（板子把 mode 截到 10 字符也能认）', () => {
  for (const mode of ['maintenance', 'maint', 'maintenanc', 'MAINT']) {
    const parsed = parseTaskSpec({ id: 'm1', mode, goal: 'version' });
    assert.equal(parsed.kind, 'maintenance', `mode=${mode}`);
    assert.deepEqual(parsed.spec, { verb: 'version' });
  }
});

test('parseTaskSpec：维护任务书非法 → invalid / maint-spec-invalid', () => {
  const parsed = parseTaskSpec({ id: 'm2', mode: 'maint', goal: 'reboot' });
  assert.equal(parsed.kind, 'invalid');
  assert.equal(parsed.reason, 'maint-spec-invalid');
});

test('executor：maintenance 任务交给 maintenanceRunner，不带 signal 之外的 exec 上下文', async () => {
  const seen = [];
  const maintenanceRunner = {
    async run(spec, ctx) {
      seen.push({ spec, taskId: ctx.taskId });
      return { status: 'done', stage: 'maint', reason: 'collected', note: 'ok', result: null, artifact: '', durationMs: 1 };
    },
  };
  const execute = createTaskExecutor({ config: {}, log: quietLog, execRunner: { run: async () => ({}) }, maintenanceRunner });
  const out = await execute({ id: 'm3', mode: 'maint', goal: JSON.stringify({ verb: 'logs', lines: 10 }) }, {});
  assert.equal(out.status, 'done');
  assert.deepEqual(seen[0].spec, { verb: 'logs', lines: 10 });
  assert.equal(seen[0].taskId, 'm3');
});

test('executor：没装配维护执行器 → blocked/maint-unavailable（不是 exec 的理由）', async () => {
  const execute = createTaskExecutor({ config: {}, log: quietLog, execRunner: { run: async () => ({}) } });
  const out = await execute({ id: 'm4', mode: 'maint', goal: 'version' }, {});
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'maint-unavailable');
  assert.equal(out.stage, 'maint');
});
