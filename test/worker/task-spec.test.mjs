import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaskSpec,
  validateExecSpec,
  findForbiddenArg,
  looksLikeScriptPath,
} from '../../lib/worker/task-spec.js';

const EXEC_GOAL = JSON.stringify({ scriptPath: 'C:\\tools\\job.ps1', args: ['-Cases', '30'], timeoutMs: 120000 });

test('parseTaskSpec：新契约（goal 内 JSON）', () => {
  const r = parseTaskSpec({ mode: 'exec', goal: EXEC_GOAL });
  assert.equal(r.kind, 'exec');
  assert.equal(r.error, '');
  assert.deepEqual(r.spec, { scriptPath: 'C:\\tools\\job.ps1', args: ['-Cases', '30'], timeoutMs: 120000 });
});

test('parseTaskSpec：裸绝对 .ps1 路径被接受，并标记 inferred-from-path', () => {
  const r = parseTaskSpec({ mode: 'exec', goal: '  "C:\\tools\\job.ps1"  ' });
  assert.equal(r.kind, 'exec');
  assert.equal(r.reason, 'inferred-from-path');
  assert.equal(r.spec.scriptPath, 'C:\\tools\\job.ps1');
});

test('parseTaskSpec：mode 留空时按形态推断为 exec', () => {
  const r = parseTaskSpec({ goal: EXEC_GOAL });
  assert.equal(r.kind, 'exec');
});

test('parseTaskSpec：内联命令默认 fail closed', () => {
  const r = parseTaskSpec({ mode: 'exec', goal: 'Get-Date; Remove-Item C:\\x -Recurse' });
  assert.equal(r.kind, 'invalid');
  assert.equal(r.reason, 'inline-command-not-allowed');
  assert.match(r.error, /allowInline=false/);
});

test('parseTaskSpec：显式 allowInline=true 才走 legacy', () => {
  const r = parseTaskSpec({ mode: 'exec', goal: 'Write-Output hi' }, { allowInline: true });
  assert.equal(r.kind, 'exec-legacy');
  assert.equal(r.reason, 'legacy-goal');
  assert.equal(r.spec.inline, 'Write-Output hi');
});

test('parseTaskSpec：空 goal 与未知 mode 都是 invalid', () => {
  assert.equal(parseTaskSpec({ mode: 'exec', goal: '   ' }).reason, 'goal-empty');
  assert.equal(parseTaskSpec({ mode: 'shell', goal: EXEC_GOAL }).reason, 'unknown-mode');
});

test('parseTaskSpec：agent 模式', () => {
  const ok = parseTaskSpec({
    mode: 'agent',
    goal: '把报告整理成 md',
    workspace: 'C:\\Users\\<you>\\dsh-remote-work',
    model: 'deepseek-account/deepseek-flash',
  });
  assert.equal(ok.kind, 'agent');
  assert.equal(ok.spec.goal, '把报告整理成 md');
  assert.equal(ok.spec.cwd, 'C:\\Users\\<you>\\dsh-remote-work');
  assert.equal(ok.spec.model, 'deepseek-account/deepseek-flash');

  assert.equal(parseTaskSpec({ mode: 'agent', goal: '' }).reason, 'agent-spec-invalid');
  assert.equal(
    parseTaskSpec({ mode: 'agent', goal: 'x', workspace: 'relative\\dir' }).reason,
    'agent-spec-invalid',
  );
});

test('validateExecSpec：路径与参数约束', () => {
  assert.equal(validateExecSpec({ scriptPath: 'relative\\a.ps1' }).ok, false);
  assert.equal(validateExecSpec({ scriptPath: 'C:\\a\\b.psm1' }).ok, false);
  assert.equal(validateExecSpec({ scriptPath: 'C:\\a\\b.ps1', args: 'not-array' }).ok, false);
  assert.equal(validateExecSpec({ scriptPath: 'C:\\a\\b.ps1', args: ['a\nb'] }).ok, false);
  assert.equal(validateExecSpec({ scriptPath: 'C:\\a\\b.ps1', args: Array(65).fill('x') }).ok, false);
  assert.equal(validateExecSpec({ scriptPath: 'C:\\a\\b.ps1', timeoutMs: 10 }).ok, false);
  assert.equal(validateExecSpec({ scriptPath: 'C:\\a\\b.ps1', timeoutMs: 120000 }).ok, true);
});

test('validateExecSpec：拒绝 -Command / cmd / /c 这类转调入口', () => {
  const base = { scriptPath: 'C:\\a\\b.ps1' };
  // -c / -e / -ec / -com 是 pwsh 的短别名：脚本若把 $args 原样转给 pwsh 就是真 RCE，
  // 所以宁可误伤也要拦（业务参数里用短别名的脚本改成写全名即可）。
  for (const bad of ['-Command', '-encodedcommand', '-Enc:x', 'cmd', 'cmd.exe', '/c', '/k', '-c', '-e', '-ec', '-com']) {
    const r = validateExecSpec({ ...base, args: [bad, 'whoami'] });
    assert.equal(r.ok, false, `应拒绝 ${bad}`);
    assert.match(r.errors.join(' '), /不允许出现/);
  }
  // 业务参数不该被误伤
  for (const okArg of ['-File', '-ExecutionPolicy', '-Cases', 'Bypass', '-NoProfile', '-Config']) {
    assert.equal(validateExecSpec({ ...base, args: [okArg] }).ok, true, `不应拒绝 ${okArg}`);
  }
});

test('findForbiddenArg：只看 token 头部，忽略空白与大小写', () => {
  assert.equal(findForbiddenArg(['  CMD  ']), 'CMD');
  assert.equal(findForbiddenArg([' -command ']), '-command');
  assert.equal(findForbiddenArg(['-Cases']), '');
  assert.equal(findForbiddenArg(null), '');
});

test('looksLikeScriptPath', () => {
  assert.equal(looksLikeScriptPath('C:\\a\\b.ps1'), true);
  assert.equal(looksLikeScriptPath('C:\\a\\b.txt'), false);
  assert.equal(looksLikeScriptPath('b.ps1'), false);
  assert.equal(looksLikeScriptPath('C:\\a\\b.ps1\nsomething'), false);
});
