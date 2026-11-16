// milestone 2 的准入策略：白名单、提示词闸门、preset/工具、审批、每日预算。
// 这些都是纯函数（预算/审批只有一个 JSON 文件），逐条测比端到端测更能说明「拒的是什么」。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkAgentPreset,
  checkAgentPrompt,
  matchAgentAllowlist,
  normalizeAgentAllowlist,
  normalizeAgentPromptGate,
  normalizeAgentTools,
  normalizePrompt,
} from '../../lib/worker/agent-gate.js';
import { createAgentBudget, budgetDate } from '../../lib/worker/agent-budget.js';
import { createAgentApprovals, promptFingerprint, APPROVAL_TTL_MS } from '../../lib/worker/agent-approval.js';

test('normalizeAgentPromptGate：默认值 + 自定义正则/灾难性回溯形态要判配置无效（fail closed）', () => {
  const plain = normalizeAgentPromptGate(undefined);
  assert.equal(plain.gate.maxChars, 4000);
  assert.equal(plain.gate.maxBase64Run, 2048);
  assert.equal(plain.gate.invalid, false);
  assert.ok(plain.gate.rules.length >= 5);
  assert.deepEqual(plain.warnings, []);

  // 规则写错不再是「忽略这一条、其余照用」——那是 fail open
  const bad = normalizeAgentPromptGate({
    maxChars: 120,
    extraRules: [{ id: 'no-eval', pattern: '(' }, { id: '', pattern: 'x' }, { id: 'ok', pattern: 'eval\\(' }],
  });
  assert.equal(bad.gate.maxChars, 120);
  assert.equal(bad.gate.invalid, true);
  assert.equal(bad.warnings.filter((w) => /正则无效/.test(w)).length, 1);
  assert.equal(bad.warnings.filter((w) => /缺 id 或 pattern/.test(w)).length, 1);
  assert.ok(bad.gate.rules.some((r) => r.id === 'ok' && r.re.test('eval(1)')));
  // 无效配置下 checkAgentPrompt 直接拒
  assert.equal(checkAgentPrompt('正常任务', bad.gate).rule, 'gate-invalid');

  // 灾难性回溯形态（ReDoS 形态）同样判无效
  const redos = normalizeAgentPromptGate({ extraRules: [{ id: 'boom', pattern: '^(a+)+$' }] });
  assert.equal(redos.gate.invalid, true);
  assert.ok(redos.warnings.some((w) => /灾难性回溯形态/.test(w)));
});

test('normalizeAgentPromptGate：Infinity / 负数 / 超上限都夹回有限区间', () => {
  const inf = normalizeAgentPromptGate({ maxChars: Infinity, maxBase64Run: 1e999 });
  assert.equal(inf.gate.maxChars, 4000);
  assert.equal(inf.gate.maxBase64Run, 2048);
  assert.equal(inf.gate.invalid, false);
  assert.equal(inf.warnings.filter((w) => /不是有效数值/.test(w)).length, 2);
  // Infinity 值本身：长度上限被夹回 4000，3000 个 A 仍会先命中 base64 规则
  assert.equal(checkAgentPrompt('A'.repeat(3000), inf.gate).ok, false);

  const huge = normalizeAgentPromptGate({ maxChars: 1e9, maxBase64Run: 1e9 });
  assert.equal(huge.gate.maxChars, 100000);
  assert.equal(huge.gate.maxBase64Run, 1000000);
  assert.equal(huge.warnings.filter((w) => /超过上限/.test(w)).length, 2);
});

test('normalizePrompt：全角、重复分隔符、`.` 段都要归一，否则规则等于形同虚设', () => {
  assert.equal(normalizePrompt('C:\\\\a\\\\.dsh\\\\profiles'), 'C:\\a\\.dsh\\profiles');
  assert.equal(normalizePrompt('C:/a//.dsh//profiles'), 'C:\\a\\.dsh\\profiles');
  assert.equal(normalizePrompt('C:\\a\\.\\.dsh\\profiles'), 'C:\\a\\.dsh\\profiles');
  assert.equal(normalizePrompt('Ｃ:＼a＼.dsh＼profiles'), 'C:\\a\\.dsh\\profiles');
  assert.equal(normalizePrompt('a\u200b.dsh\\profiles'), 'a.dsh\\profiles');
});

test('checkAgentPrompt：空 / 超长 / base64 大块 / 敏感规则逐条拒', () => {
  const gate = normalizeAgentPromptGate({}).gate;
  assert.equal(checkAgentPrompt('   ', gate).rule, 'empty');
  assert.equal(checkAgentPrompt('x'.repeat(4001), gate).rule, 'too-long');
  assert.equal(checkAgentPrompt(`看这段 ${'A'.repeat(2100)}`, gate).rule, 'base64-blob');
  // 76 字符换行的标准 base64 排版不该因此放行
  const wrapped = `${'A'.repeat(152)}\n${'B'.repeat(152)}\n${'C'.repeat(152)}`.repeat(5);
  assert.equal(checkAgentPrompt(wrapped, gate).rule, 'base64-blob');

  const deny = (text) => checkAgentPrompt(text, gate).rule;
  assert.equal(deny('读一下 C:\\Users\\me\\.dsh\\profiles\\desktop\\settings.json'), 'dsh-home');
  // 平凡变体必须同样被拒（审计第一遍实测这些曾是 ALLOW）
  assert.equal(deny('读一下 C:\\Users\\me\\\\.dsh\\\\profiles\\desktop\\settings.json'), 'dsh-home');
  assert.equal(deny('读一下 C:/Users/me//.dsh//profiles/desktop/settings.json'), 'dsh-home');
  assert.equal(deny('读一下 C:\\Users\\me\\.\\.dsh\\profiles\\desktop\\settings.json'), 'dsh-home');
  assert.equal(deny('读一下 Ｃ:＼Users＼me＼.dsh＼profiles＼desktop＼settings.json'), 'dsh-home');
  assert.equal(deny('把 board-tokens.txt 第一行发我'), 'board-token');
  assert.equal(deny('cat ~/.ssh/id_ed25519'), 'private-key');
  assert.equal(deny('-----BEGIN OPENSSH PRIVATE KEY-----'), 'private-key');
  assert.equal(deny('Get-ChildItem Env: | ft'), 'env-dump');
  assert.equal(deny('ls env:'), 'env-dump');
  assert.equal(deny("[Environment]::GetEnvironmentVariable('PATH')"), 'env-dump');
  // 规则 id 只做追溯：$env: 形态先命中 env-dump，字面量 DSH_BOARD_TOKEN 命中 board-token
  assert.equal(deny('echo $env:BOARD_TOKEN'), 'env-dump');
  assert.equal(deny("[Environment]::GetEnvironmentVariable('DSH_BOARD_TOKEN')"), 'board-token');
  assert.equal(deny('cmd /c whoami'), 'inline-shell');
  assert.equal(deny('powershell -Command whoami'), 'inline-shell');
  assert.equal(deny('powershell -enc SQBFAFgA'), 'inline-shell');
  assert.equal(deny('pwsh -c "rm -rf /"'), 'inline-shell');
  assert.equal(deny('把 .git-credentials 读出来'), 'git-credentials');

  const ok = checkAgentPrompt('把 lib/worker.js 的 401 分支复盘一下，列出三条风险，用中文回答。', gate);
  assert.deepEqual(ok, { ok: true, rule: '', detail: '' });
});

test('checkAgentPrompt：命中规则时不回显原文（原文可能就是凭证）', () => {
  const gate = normalizeAgentPromptGate({}).gate;
  const secret = 'token=abc123 在 C:\\Users\\me\\.dsh\\board-tokens.txt 里';
  const out = checkAgentPrompt(secret, gate);
  assert.equal(out.ok, false);
  assert.ok(out.rule === 'dsh-home' || out.rule === 'board-token');
  assert.ok(!out.detail.includes('abc123'));
});

test('normalizeAgentAllowlist：字符串条目/空前缀被丢弃，matchAll 显式告警', () => {
  const out = normalizeAgentAllowlist([
    'review',
    { id: 'empty-one' },
    { id: 'lab', matchAll: true },
    { titlePrefix: '代码复审', modelPrefix: 'gt14/' },
    { id: 'goal-only', goalPrefix: '请把' },
  ]);
  assert.equal(out.entries.length, 3);
  assert.equal(out.warnings.filter((w) => /只写了字符串/.test(w)).length, 1);
  assert.equal(out.warnings.filter((w) => /没有任何匹配前缀/.test(w)).length, 1);
  assert.equal(out.warnings.filter((w) => /matchAll/.test(w)).length, 1);
  assert.equal(out.entries.find((e) => e.id === 'lab').matchAll, true);
  // 没写 id 的条目给兜底 id，仍然可追溯
  assert.ok(out.entries.some((e) => e.id === 'allow-3' || e.id.startsWith('allow-')));
});

test('matchAgentAllowlist：多个前缀按 AND 匹配；matchAll 放行', () => {
  const { entries } = normalizeAgentAllowlist([
    { id: 'review', titlePrefix: '代码复审', modelPrefix: 'gt14/' },
    { id: 'lab', matchAll: true },
  ]);
  assert.deepEqual(matchAgentAllowlist(entries, { title: '代码复审 S01', model: 'gt14/qwen35-9b' }), {
    ok: true,
    id: 'review',
  });
  // 标题对、模型不对 → 不命中，落到 matchAll
  assert.deepEqual(matchAgentAllowlist(entries, { title: '代码复审 S01', model: 'other/x' }), { ok: true, id: 'lab' });
  assert.deepEqual(matchAgentAllowlist([entries[0]], { title: '别的事', model: 'gt14/x' }), { ok: false, id: '' });
  assert.deepEqual(matchAgentAllowlist([], { title: '代码复审' }), { ok: false, id: '' });
});

test('normalizeAgentTools + checkAgentPreset：deny 不可落实即拒；allowedPresets 之外即拒', () => {
  const deny = normalizeAgentTools({ deny: ['shell', 'write'] });
  assert.equal(deny.tools.deny.length, 2);
  assert.equal(deny.warnings.filter((w) => /0.2.0 不做「按预设运行时禁工具」/.test(w)).length, 1);
  const verdict = checkAgentPreset('narrow', deny.tools);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /^agent-tools-unsupported:/);

  const listed = normalizeAgentTools({ allowedPresets: ['narrow', 'review'] }).tools;
  assert.deepEqual(checkAgentPreset('NARROW', listed), { ok: true, reason: '' });
  assert.equal(checkAgentPreset('wide', listed).reason, 'agent-preset-denied:wide');

  // 不给 allowedPresets 时不额外限制（preset 仍由 agentPreset 必填保证）
  assert.deepEqual(checkAgentPreset('anything', normalizeAgentTools({}).tools), { ok: true, reason: '' });
});

test('promptFingerprint：稳定、按提示词区分、不泄漏原文', () => {
  const a = promptFingerprint('写周报');
  assert.equal(a, promptFingerprint('写周报'));
  assert.notEqual(a, promptFingerprint('写日报'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes('周报'));
});

test('createAgentApprovals：没有记录就不批；记了才批；换提示词/过期都要重批', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  let clock = Date.parse('2026-11-15T09:00:00Z');
  const ap = createAgentApprovals({ stateDir: dir, now: () => clock, fsImpl: fs });

  assert.deepEqual(ap.check('t1', '写周报'), { ok: false, approved: false, required: true, reason: 'no-record' });
  assert.equal(ap.record('t1', '写周报').ok, true);
  assert.equal(ap.check('t1', '写周报').ok, true);
  assert.equal(ap.check('t1', '写日报').reason, 'fingerprint-mismatch');
  // v2.6.6：重派会生成新 taskId，同一提示词指纹在 TTL 内可复用审批。
  assert.equal(ap.check('t2', '写周报').reason, 'approved-fingerprint');
  assert.equal(ap.check('t2', '写日报').reason, 'fingerprint-mismatch');

  // 重启后仍有效（落盘）
  const again = createAgentApprovals({ stateDir: dir, now: () => clock, fsImpl: fs });
  assert.equal(again.check('t1', '写周报').ok, true);

  // 过期
  clock += APPROVAL_TTL_MS + 1000;
  assert.equal(again.check('t1', '写周报').reason, 'expired');

  // 撤销：同一指纹一起撤（重派后的新 id 不再继承）
  assert.equal(ap.revoke('t2').revoked, true);
  assert.equal(ap.check('t2', '写周报').reason, 'no-record');
  assert.equal(ap.check('t9', '写周报').reason, 'no-record');

  // 撤销
  ap.record('t3', '写周报');
  assert.equal(ap.revoke('t3').ok, true);
  assert.equal(ap.check('t3', '写周报').reason, 'no-record');
  // 重复撤销：无记录可撤是无操作成功（revoked=false），不是错误
  assert.deepEqual(ap.revoke('t3'), { ok: true, taskId: 't3', revoked: false });
  assert.equal(ap.list().length, 0);
});

test('createAgentApprovals：损坏/不可读的审批文件当作「没有任何审批」（fail closed）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-bad-'));
  fs.writeFileSync(path.join(dir, 'agent-approvals.json'), '{not json', 'utf8');
  const ap = createAgentApprovals({ stateDir: dir, now: () => Date.parse('2026-11-15T09:00:00Z'), fsImpl: fs });
  assert.equal(ap.check('t1', '写周报').ok, false);
  assert.equal(ap.list().length, 0);
});

test('budgetDate：按 UTC 切日', () => {
  assert.equal(budgetDate(Date.parse('2026-11-15T23:59:59Z')), '2026-11-15');
  assert.equal(budgetDate(Date.parse('2026-11-16T00:00:01Z')), '2026-11-16');
});

test('createAgentBudget：占额度、超限拒绝、跨日重置、落盘可续', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  let clock = Date.parse('2026-11-15T09:00:00Z');
  const budget = createAgentBudget({ stateDir: dir, maxPerDay: 2, now: () => clock, fsImpl: fs });
  assert.deepEqual(budget.peek(), { date: '2026-11-15', used: 0, limit: 2, ok: true });
  assert.equal(budget.consume().ok, true);
  assert.equal(budget.consume().ok, true);
  const third = budget.consume();
  assert.equal(third.ok, false);
  assert.equal(third.used, 2);
  // 计数文件是原子写的：临时文件不该残留
  assert.equal(fs.existsSync(path.join(dir, 'agent-budget.json.tmp')), false);

  // 重启（新实例）后仍记得已用 2
  const again = createAgentBudget({ stateDir: dir, maxPerDay: 2, now: () => clock, fsImpl: fs });
  assert.equal(again.peek().used, 2);

  // 次日自动重置
  clock = Date.parse('2026-11-16T00:10:00Z');
  assert.deepEqual(again.peek(), { date: '2026-11-16', used: 0, limit: 2, ok: true });
  assert.equal(again.consume().ok, true);
});

test('createAgentBudget：写盘失败时用进程内计数（不退回到旧值，也不无限放行）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ro-'));
  const clock = Date.parse('2026-11-15T09:00:00Z');
  const brokenFs = {
    readFileSync: () => {
      throw Object.assign(new Error('EACCES: 读不动'), { code: 'EACCES' });
    },
    writeFileSync: () => {
      throw Object.assign(new Error('EACCES: 写不动'), { code: 'EACCES' });
    },
    mkdirSync: () => {},
    renameSync: () => {},
  };
  const budget = createAgentBudget({ stateDir: dir, maxPerDay: 2, now: () => clock, fsImpl: brokenFs });
  assert.equal(budget.consume().ok, true);
  assert.equal(budget.consume().ok, true);
  // 关键：第三次必须被拒（审计第一遍实测：写失败后每次 consume 都返回 used=1、永不增长）
  const third = budget.consume();
  assert.equal(third.ok, false);
  assert.equal(third.used, 2);
  assert.equal(budget.peek().used, 2);
});

test('createAgentBudget：stateDir 读不到/文件损坏时按 0 计（不因读不到就锁死）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-bad-'));
  fs.writeFileSync(path.join(dir, 'agent-budget.json'), '{not json', 'utf8');
  const clock = Date.parse('2026-11-15T09:00:00Z');
  const budget = createAgentBudget({ stateDir: dir, maxPerDay: 5, now: () => clock, fsImpl: fs });
  assert.equal(budget.peek().used, 0);
  assert.equal(budget.consume().ok, true);
  // 没有 stateDir 时退化成进程内计数
  const mem = createAgentBudget({ maxPerDay: 1, now: () => clock, fsImpl: fs });
  assert.equal(mem.consume().ok, true);
  assert.equal(mem.consume().ok, false);
});

test('normalizeAgentPromptGate：重复的择一分支判 invalid（ReDoS）', () => {
  const { gate, warnings } = normalizeAgentPromptGate({ extraRules: [{ id: 'alt', pattern: '(a|aa)+$' }] });
  assert.equal(gate.invalid, true);
  assert.equal(gate.rules.some((r) => r.id === 'alt'), false);
  assert.ok(warnings.some((w) => w.includes('灾难性回溯')), warnings.join(' | '));
});
test('createAgentApprovals：写盘失败要报 ok:false，但进程内仍生效（既不假装成功，也不静默失效）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-fail-'));
  const failing = {
    mkdirSync: () => {},
    writeFileSync: () => {
      throw new Error('EACCES');
    },
    renameSync: () => {},
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  const approvals = createAgentApprovals({ stateDir: dir, fsImpl: failing, log: { warn() {} } });
  const r = approvals.record('t1', '写周报');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /写盘失败/);
  assert.equal(r.inMemoryOnly, true);
  // 同进程：批完立刻能通过，否则操作者以为批了、任务却一直 blocked
  assert.equal(approvals.check('t1', '写周报').reason, 'approved');
  assert.equal(approvals.writeFailed(), true);
});

test('promptFingerprint：首尾空白/换行不影响指纹（看板 raw goal 与执行时 trim 后的 goal）', () => {
  assert.equal(promptFingerprint('写一份报告\n'), promptFingerprint('写一份报告'));
  assert.equal(promptFingerprint('  写  一份 报告  '), promptFingerprint('写 一份 报告'));
  assert.notEqual(promptFingerprint('写一份报告'), promptFingerprint('写两份报告'));
});

test('createAgentApprovals：count() 不受 list() 的 20 条展示上限影响', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-count-'));
  const approvals = createAgentApprovals({ stateDir: dir });
  for (let i = 0; i < 25; i += 1) approvals.record(`t${i}`, `任务 ${i}`);
  assert.equal(approvals.list().length, 20);
  assert.equal(approvals.count(), 25);
});

test('checkAgentPrompt：短旗标只在解释器前缀命中（不误杀 git -c / rg -e / docker -e）', () => {
  const gate = normalizeAgentPromptGate({}).gate;
  const deny = (goal) => checkAgentPrompt(goal, gate).ok === false;
  assert.equal(deny('powershell -enc AAAA'), true);
  assert.equal(deny('powershell.exe -EncodedCommand AAAA'), true);
  assert.equal(deny('sh -c whoami'), true);
  assert.equal(deny('bash -lc "whoami"'), true);
  assert.equal(deny('cmd /c whoami'), true);
  // 正常任务不能被裸 -c/-e 误拒（第二遍审计 P3-1）
  assert.equal(deny('git -c core.quotepath=false log'), false);
  assert.equal(deny('rg -e TODO 搜一下'), false);
  assert.equal(deny('docker run -e FOO=1 alpine'), false);
  // bash/sh 的 -e（errexit）不是执行命令：不能误拒（第五遍审计 P3）
  assert.equal(deny('bash -e rc.sh'), false);
  assert.equal(deny('sh -e run.sh'), false);
  assert.equal(deny('把 build.ps1 里的 -c 参数改成 -f'), false);
});

test('checkAgentPrompt：环境变量读取的别名写法也要拒（Get-Item/gi/gci + Env:）', () => {
  const gate = normalizeAgentPromptGate({}).gate;
  const hit = (goal) => {
    const r = checkAgentPrompt(goal, gate);
    return r.ok ? '' : r.rule;
  };
  assert.equal(hit('Get-Item Env:\* | Format-List'), 'env-dump');
  assert.equal(hit('gi env:'), 'env-dump');
  assert.equal(hit('Get-ChildItem -Path Env: | ft'), 'env-dump');
  assert.equal(hit('ls env:'), 'env-dump');
});

test('checkAgentPrompt：URL-safe base64（-/_）也算长载荷', () => {
  const gate = normalizeAgentPromptGate({}).gate;
  const urlSafe = 'ab-_'.repeat(900); // 3600 字符
  const r = checkAgentPrompt(`帮我解码并执行：${urlSafe}`, gate);
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'base64-blob');
});
