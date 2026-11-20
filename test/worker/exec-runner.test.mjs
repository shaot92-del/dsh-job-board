import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  checkScriptAccess,
  createExecRunner,
  isWithin,
  oneLine,
  buildChildEnv,
  normalizeForCompare,
} from '../../lib/worker/exec-runner.js';
import { resolvePwshPath } from '../../lib/worker/config.js';
import { resolveCwd } from '../../lib/worker/exec-runner.js';

const wt = process.platform === 'win32' ? test : (name, fn) => test(name, { skip: 'exec-runner 是 Windows PowerShell 专用' }, fn);

// ── 测试用临时目录 ─────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-test-'));
const allowedDir = path.join(root, 'allowed');
const outsideDir = path.join(root, 'outside');
fs.mkdirSync(allowedDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
const insideScript = path.join(allowedDir, 'job.ps1');
const outsideScript = path.join(outsideDir, 'job.ps1');
fs.writeFileSync(insideScript, "Write-Output 'hi'\n", 'utf8');
fs.writeFileSync(outsideScript, "Write-Output 'hi'\n", 'utf8');

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 假子进程：让超时/取消/退出码测试不依赖真 pwsh ──────────────────────────
function fakeChild({ stdout = '', stderr = '', code = 0, closeOnKill = true, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    if (closeOnKill) {
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
    }
    return true;
  };
  if (autoClose) {
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      setImmediate(() => child.emit('close', code, null));
    });
  }
  return child;
}

function spawnReturning(childOrFn, captured) {
  return (file, args, opts) => {
    if (String(file).toLowerCase().includes('taskkill')) return { on() {} };
    if (captured) captured.push({ file, args, opts });
    return typeof childOrFn === 'function' ? childOrFn(file, args, opts) : childOrFn;
  };
}

const baseConfig = {
  allowlist: [allowedDir],
  approvalMode: 'manual',
  execTimeoutMs: 5000,
  // v2.6.6: exec 不再默认回退到 home；测试显式给一个合法 cwd。
  execCwd: os.homedir(),
  // v2.6.27：未配 execCwdRoot 默认 fail-closed；这些用例测的是 exec 主流程，
  // 显式打开旧行为（fail-closed 本身由 resolveCwd 的新用例覆盖）。
  allowUnscopedCwd: true,
};

wt('checkScriptAccess：白名单命中的脚本放行', () => {
  const r = checkScriptAccess(insideScript, { allowlist: [allowedDir], approvalMode: 'manual' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'allowed');
});

wt('checkScriptAccess：目录内的后缀边界不能被糊弄（allowed-evil）', () => {
  const sibling = `${allowedDir}-evil`;
  fs.mkdirSync(sibling, { recursive: true });
  const p = path.join(sibling, 'x.ps1');
  fs.writeFileSync(p, '', 'utf8');
  assert.equal(checkScriptAccess(p, { allowlist: [allowedDir] }).allowed, false);
});

wt('checkScriptAccess：`..` 段与 junction 都不能白名单逃逸（安全审计 P0-1）', () => {
  // 形态层：`..` 直接拒
  const dotted = `${allowedDir}\\..\\outside\\job.ps1`;
  const r = checkScriptAccess(dotted, { allowlist: [allowedDir], approvalMode: 'manual' });
  assert.equal(r.allowed, false);
  assert.ok(['bad-path', 'missing'].includes(r.reason), `意外 reason=${r.reason}`);

  // 语义层：allowed 目录下挂一个指向 outside 的 junction —— realpath 会解析到 outside
  const link = path.join(allowedDir, 'link-out');
  let made = false;
  try {
    fs.symlinkSync(outsideDir, link, 'junction');
    made = true;
  } catch {
    /* 无权限建 junction 就跳过这一段（CI/受限账户） */
  }
  if (made) {
    const viaLink = path.join(link, 'job.ps1');
    const r2 = checkScriptAccess(viaLink, { allowlist: [allowedDir], approvalMode: 'manual' });
    assert.equal(r2.allowed, false, 'junction 指向白名单外的脚本必须被拒');
    assert.equal(r2.reason, 'not-allowlisted');
  }

  // UNC / \\?\ 形态也不认
  assert.equal(checkScriptAccess('\\\\server\\share\\x.ps1', { allowlist: [allowedDir] }).reason, 'bad-path');
  assert.equal(checkScriptAccess('\\\\?\\C:\\x.ps1', { allowlist: [allowedDir] }).reason, 'bad-path');
});

wt('run：pwsh 解析不到 → failed/pwsh-missing（不回退裸名，避免 PATH 劫持）', async () => {
  const runner = createExecRunner({ config: baseConfig, pwshPath: '', spawnImpl: spawnReturning(fakeChild()) });
  const out = await runner.run({ scriptPath: insideScript, timeoutMs: 2000 });
  assert.equal(out.status, 'failed');
  assert.equal(out.reason, 'pwsh-missing');
  assert.match(out.note, /pwsh-missing/);
});

wt('checkScriptAccess：各类拒绝原因', () => {
  assert.equal(checkScriptAccess('', {}).reason, 'empty');
  assert.equal(checkScriptAccess('relative\\x.ps1', { allowlist: [allowedDir] }).reason, 'not-absolute');
  assert.equal(checkScriptAccess(path.join(allowedDir, 'x.txt'), { allowlist: [allowedDir] }).reason, 'bad-extension');
  assert.equal(checkScriptAccess(path.join(allowedDir, 'nope.ps1'), { allowlist: [allowedDir] }).reason, 'missing');
  assert.equal(checkScriptAccess(allowedDir, { allowlist: [allowedDir] }).reason, 'bad-extension');
  assert.equal(checkScriptAccess(outsideScript, { allowlist: [allowedDir] }).reason, 'not-allowlisted');
});

wt('checkScriptAccess：allowlist 可以是单个文件（全等匹配）', () => {
  assert.equal(checkScriptAccess(insideScript, { allowlist: [insideScript] }).allowed, true);
  assert.equal(checkScriptAccess(outsideScript, { allowlist: [insideScript] }).allowed, false);
});

wt('checkScriptAccess：approvalMode=auto 放行非白名单并标记来源', () => {
  const r = checkScriptAccess(outsideScript, { allowlist: [allowedDir], approvalMode: 'auto' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'not-allowlisted-auto');
});

wt('isWithin / normalizeForCompare：大小写与分隔符不敏感', () => {
  assert.equal(isWithin('C:\\Tools\\A\\x.ps1', 'c:/tools/a'), true);
  assert.equal(isWithin('C:\\Tools\\AB\\x.ps1', 'C:\\Tools\\A'), false);
  assert.equal(normalizeForCompare('C:\\A\\\\'), 'c:\\a');
});

wt('oneLine：压成单行并截断', () => {
  assert.equal(oneLine('a\r\nb   c'), 'a b c');
  assert.equal(oneLine('x'.repeat(400)).length, 301);
});

wt('buildChildEnv：只透传白名单变量', () => {
  const env = buildChildEnv({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', DSH_TOKEN: 'secret', RANDOM_VAR: 'x' });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.DSH_TOKEN, undefined);
  assert.equal(env.RANDOM_VAR, undefined);
});

wt('run：成功路径——argv 形态、DSH_RESULT/DSH_ARTIFACT 解析', async () => {
  const captured = [];
  const stdout = 'building...\nDSH_RESULT {"ok":true,"expected":30,"actual":30,"reasons":[]}\nDSH_ARTIFACT L:\\out\\r.html\n';
  const runner = createExecRunner({
    config: baseConfig,
    spawnImpl: spawnReturning(fakeChild({ stdout }), captured),
  });
  const out = await runner.run({ scriptPath: insideScript, args: ['-Cases', '30'] }, { taskId: 't1' });
  assert.equal(out.status, 'done');
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.result, { ok: true, expected: 30, actual: 30 });
  assert.equal(out.artifact, 'L:\\out\\r.html');
  assert.match(out.note, /stage=exec exit=0/);
  assert.match(out.note, /result=ok/);
  const argv = captured[0].args;
  const realScript = fs.realpathSync.native ? fs.realpathSync.native(insideScript) : fs.realpathSync(insideScript);
  assert.deepEqual(argv.slice(0, 4), ['-NoProfile', '-NonInteractive', '-File', realScript]);
  assert.deepEqual(argv.slice(4), ['-Cases', '30']);
});

wt('run：退出码非零 → failed，note 带 exitCode 与 stderr 尾部', async () => {
  const runner = createExecRunner({
    config: baseConfig,
    spawnImpl: spawnReturning(fakeChild({ code: 3, stderr: 'boom: 文件不存在' })),
  });
  const out = await runner.run({ scriptPath: insideScript }, { taskId: 't2' });
  assert.equal(out.status, 'failed');
  assert.equal(out.exitCode, 3);
  assert.match(out.note, /stage=exec exit=3/);
  assert.match(out.note, /stderr=boom/);
});

wt('run：exit 0 但没有 DSH_RESULT → done + dsh-result=missing（不是失败）', async () => {
  const runner = createExecRunner({ config: baseConfig, spawnImpl: spawnReturning(fakeChild({ stdout: 'nothing\n' })) });
  const out = await runner.run({ scriptPath: insideScript });
  assert.equal(out.status, 'done');
  assert.equal(out.result, null);
  assert.match(out.note, /dsh-result=missing/);
});

wt('run：exit 0 但 DSH_RESULT 是脏数据 → done + 具体错误', async () => {
  const runner = createExecRunner({
    config: baseConfig,
    spawnImpl: spawnReturning(fakeChild({ stdout: 'DSH_RESULT {"ok":"yes"}\n' })),
  });
  const out = await runner.run({ scriptPath: insideScript });
  assert.equal(out.status, 'done');
  assert.equal(out.result, null);
  assert.match(out.note, /dsh-result=shape-invalid/);
});

wt('run：超时 → failed/timedOut，并杀掉进程树', async () => {
  // 子进程不自动退出，只有 kill 时才 close —— 模拟卡住的脚本
  const child = fakeChild({ autoClose: false, closeOnKill: true });
  const runner = createExecRunner({ config: baseConfig, spawnImpl: spawnReturning(child) });
  const out = await runner.run({ scriptPath: insideScript, timeoutMs: 40 });
  assert.equal(out.status, 'failed');
  assert.equal(out.timedOut, true);
  assert.match(out.note, /reason=timeout/);
  assert.equal(child.killCalls, 1);
});

wt('run：kill 不掉（进程不退出）→ 宽限期后收尾，不把并发槽拖死', async () => {
  // 完全不理会 kill：既不 emit close，也不报错
  const child = fakeChild({ autoClose: false, closeOnKill: false });
  const runner = createExecRunner({
    config: baseConfig,
    spawnImpl: spawnReturning(child),
    killGraceMs: 40,
  });
  const started = Date.now();
  const out = await runner.run({ scriptPath: insideScript, timeoutMs: 20 });
  assert.equal(out.status, 'failed');
  assert.equal(out.timedOut, true);
  assert.match(out.note, /kill=uneffective/);
  assert.ok(Date.now() - started < 2000, '不应该等到天荒地老');
  assert.ok(child.killCalls >= 1);
});

wt('run：取消 → blocked/canceled', async () => {
  const child = fakeChild({ autoClose: false, closeOnKill: true });
  const runner = createExecRunner({ config: baseConfig, spawnImpl: spawnReturning(child) });
  const controller = new AbortController();
  const p = runner.run({ scriptPath: insideScript }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  const out = await p;
  assert.equal(out.status, 'blocked');
  assert.equal(out.canceled, true);
  assert.match(out.note, /reason=canceled/);
});

wt('run：spawn 抛错 → failed/spawn-failed', async () => {
  const runner = createExecRunner({
    config: baseConfig,
    spawnImpl: () => {
      throw new Error('ENOENT pwsh');
    },
  });
  const out = await runner.run({ scriptPath: insideScript });
  assert.equal(out.status, 'failed');
  assert.match(out.note, /reason=spawn-failed/);
});

wt('run：白名单外 → blocked/approval-required，且不 spawn', async () => {
  const captured = [];
  const runner = createExecRunner({ config: baseConfig, spawnImpl: spawnReturning(fakeChild(), captured) });
  const out = await runner.run({ scriptPath: outsideScript });
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'not-allowlisted');
  assert.match(out.note, /approval-required/);
  assert.equal(captured.length, 0);
});

wt('run：内联命令在 allowInline=false 时被拒', async () => {
  const runner = createExecRunner({ config: { ...baseConfig, allowInline: false }, spawnImpl: spawnReturning(fakeChild()) });
  const out = await runner.run({ inline: 'Get-Date' });
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'inline-command-not-allowed');
});

wt('真机：用真 pwsh 跑一个脚本（有 pwsh 才跑）', async (t) => {
  const pwsh = resolvePwshPath({}, { exists: (p) => fs.existsSync(p) });
  if (!pwsh) return t.skip('没有 pwsh');
  const script = path.join(allowedDir, 'real.ps1');
  fs.writeFileSync(script, 'Write-Output \'DSH_RESULT {"ok":true,"actual":7}\'\n', 'utf8');
  const runner = createExecRunner({ config: baseConfig, pwshPath: pwsh });
  const out = await runner.run({ scriptPath: script });
  assert.equal(out.status, 'done', out.note);
  assert.deepEqual(out.result, { ok: true, actual: 7 });
});

// ── 第二轮安全审计（修复增量）留下的回归 ────────────────────────────────────
wt('run：exit 到了但 close 一直不来（孙进程占着管道）→ 按 exit 结算，不拖到超时', async () => {
  const child = fakeChild({ autoClose: false });
  const runner = createExecRunner({
    config: { ...baseConfig },
    spawnImpl: spawnReturning(child),
    fsImpl: fs,
    pwshPath: 'C:\\fake\\pwsh.exe',
  });
  const p = runner.run({ scriptPath: insideScript, args: [] }, { taskId: 't-exit-only' });
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from('DSH_RESULT {"ok":true,"actual":1}\n', 'utf8'));
    child.emit('exit', 0, null);
  }, 10);
  const out = await p;
  assert.equal(out.status, 'done');
  assert.equal(out.exitCode, 0);
  assert.equal(out.result.actual, 1);
});

wt('resolvePwshPath：显式值也要过闸（裸名 / 不存在 / 目录 → 空串）', () => {
  const okFs = { exists: () => true, isFile: () => true };
  assert.equal(resolvePwshPath({ pwshPath: 'pwsh' }, okFs), '', '裸名字不能靠 PATH 解析');
  assert.equal(resolvePwshPath({ pwshPath: '.\\pwsh.exe' }, okFs), '', '相对路径不能靠 cwd 解析');
  assert.equal(resolvePwshPath({ pwshPath: 'C:\\nope\\pwsh.exe' }, { exists: () => false }), '');
  assert.equal(resolvePwshPath({ pwshPath: 'C:\\Windows' }, { exists: () => true, isFile: () => false }), '');
  assert.equal(
    resolvePwshPath({ pwshPath: 'C:\\ok\\pwsh.exe' }, okFs),
    'C:\\ok\\pwsh.exe',
    '合法绝对路径必须原样返回',
  );
});

wt('resolvePwshPath：PATH 里的相对项不参与候选', () => {
  const env = { PATH: 'relbin;C:\\Tools' };
  const calls = [];
  const r = resolvePwshPath(
    {},
    {
      env,
      exists: (p) => {
        calls.push(p);
        return false;
      },
    },
  );
  assert.equal(r, '');
  assert.ok(!calls.some((p) => p.toLowerCase().startsWith('relbin')), `相对 PATH 项被当候选用: ${calls.join(', ')}`);
});


wt('resolvePwshPath：显式值带引号要去掉引号再判（否则合法路径被误拒）', () => {
  const fsOk = { exists: () => true, isFile: () => true };
  assert.equal(resolvePwshPath({ pwshPath: '"C:\\Tools\\pwsh.exe"' }, fsOk), 'C:\\Tools\\pwsh.exe');
});


test('resolveCwd：配了 root 就 fail-closed（根无效/候选越界都 blocked，不静默回落）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-outside-'));
  try {
    const missingRoot = path.join(root, 'no-such-root');
    let r = resolveCwd([root], fs, missingRoot);
    assert.equal(r.cwd, '');
    assert.equal(r.reason, 'cwd-root-invalid');

    r = resolveCwd([outside], fs, root);
    assert.equal(r.cwd, '');
    assert.equal(r.reason, 'cwd-not-in-root');

    r = resolveCwd([''], fs, root);
    assert.equal(r.cwd, fs.realpathSync.native(root));
    assert.equal(r.reason, 'cwd-root-default');

    const inside = fs.mkdtempSync(path.join(root, 'inner-'));
    r = resolveCwd([inside], fs, root);
    assert.equal(r.reason, '');
    assert.equal(fs.realpathSync.native(r.cwd), fs.realpathSync.native(inside));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveCwd：未配 root 且未开 allowUnscopedCwd ⇒ fail-closed', () => {
  const r = resolveCwd([os.homedir()], fs, '');
  assert.equal(r.cwd, '');
  assert.equal(r.reason, 'cwd-root-unset');
});

test('resolveCwd：未配 root 但显式 allowUnscopedCwd=true ⇒ 旧的家目录回退', () => {
  const r = resolveCwd([], fs, '', { allowUnscoped: true });
  assert.equal(r.reason, 'cwd-home-default');
  assert.ok(r.cwd);
});

wt('note 上板前必须脱敏：stderr 里复述 token / 家目录不能原样落回看板（v2.6.27 安全 P1）', async () => {
  const token = 'board-token-SECRET-abcdef123456';
  const home = os.homedir();
  const child = fakeChild({ stderr: `failed for ${token} under ${home}\\proj\n`, code: 2 });
  const runner = createExecRunner({ config: { ...baseConfig, token }, spawnImpl: spawnReturning(child) });
  const out = await runner.run({ scriptPath: insideScript }, { taskId: 't-mask' });
  assert.equal(out.status, 'failed');
  assert.equal(out.note.includes(token), false, 'token 不能出现在 note');
  assert.equal(out.note.includes(home), false, '家目录不能原样出现在 note');
  assert.ok(out.note.includes('%USERPROFILE%') || out.note.includes('***'), '脱敏要留下痕迹');
});

// v2.6.28（安全审计 S-7）：内联脚本 spec.inline 无长度上限，可写满磁盘。
wt('run：内联脚本超过 64KB 上限 → blocked/inline-too-large', async () => {
  const runner = createExecRunner({ config: { ...baseConfig, allowInline: true }, spawnImpl: spawnReturning(fakeChild()) });
  const hugeInline = 'x'.repeat(64 * 1024 + 1);
  const out = await runner.run({ inline: hugeInline });
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'inline-too-large');
  assert.match(out.note, /reason=inline-too-large/);
});

// v2.6.28（安全审计 C-1）：isAbsolutePath 统一用 config.js 的 helper——
// `//server/share` 在 config 侧判绝对路径、旧闸门侧判 not-absolute，两套判定不一致。
test('checkScriptAccess：//server/share 判绝对路径（与 config.isAbsolutePath 同源）', () => {
  const r = checkScriptAccess('//server/share/foo.ps1', { allowlist: [allowedDir] });
  // 新实现：isAbsolutePath 认 // → 不是 not-absolute；UNC 检查只认 \\ → // 不拦；
  // statSync 失败 → missing。关键是 reason 不再是 not-absolute。
  assert.notEqual(r.reason, 'not-absolute', `//server/share 不应被判 not-absolute（reason=${r.reason}）`);
});

// v2.6.28（安全审计 C-10）：exit 后 250ms drain 窗口内若 timeoutMs 更小，
// 已退出进程被记 timeout。drain 优先于 timeout。
wt('run：exit 后 drain 优先于 timeout（timeoutMs < EXIT_DRAIN_MS 不误记 timeout）', async () => {
  // 子进程立即 exit（autoClose=false，手动 emit exit），不 emit close
  const child = fakeChild({ autoClose: false, closeOnKill: false });
  const runner = createExecRunner({ config: baseConfig, spawnImpl: spawnReturning(child) });
  // timeoutMs=10 < EXIT_DRAIN_MS=250：旧实现 timer 先 fire 记 timeout
  const p = runner.run({ scriptPath: insideScript, timeoutMs: 10 });
  // 立即 emit exit（模拟子进程在 timeoutMs 之前退出）
  setImmediate(() => child.emit('exit', 0, null));
  const out = await p;
  assert.equal(out.timedOut, false, 'exit 后不应记 timeout');
  assert.equal(out.status, 'done');
});
// v2.6.28（安全审计 C-14）：resolveCwd 用 `rel.startsWith('..')` 误拒 `..foo` 目录
// （目录名以 .. 开头不是越界）。改按路径段判断：`rel === '..'` 或 `rel.startsWith('..' + path.sep)`。
test('resolveCwd：..foo 目录不被误拒（v2.6.28 C-14）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-dotfoo-'));
  try {
    const dotfoo = path.join(root, '..foo');
    fs.mkdirSync(dotfoo, { recursive: true });
    const r = resolveCwd([dotfoo], fs, root);
    assert.equal(r.reason, '', `..foo 目录应在 root 内不被误拒（reason=${r.reason}）`);
    assert.ok(r.cwd, '应返回有效 cwd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCwd：../x 仍被拒（v2.6.28 C-14）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-dotdot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-outside-'));
  try {
    const outsideChild = path.join(outside, 'child');
    fs.mkdirSync(outsideChild, { recursive: true });
    const r = resolveCwd([outsideChild], fs, root);
    assert.equal(r.reason, 'cwd-not-in-root', `../x 仍被拒（reason=${r.reason}）`);
    assert.equal(r.cwd, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// v2.6.28（安全审计 C-15）：warnedNoCwdRoot 原为模块级 let，多个 runner 实例共享，
// 第二个实例不再告警。移入 createExecRunner 闭包后每个实例独立告警一次。
test('createExecRunner：两个实例各自告警一次（v2.6.28 C-15）', async () => {
  const writes = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const cfg = { ...baseConfig, execCwdRoot: '' };
    const r1 = createExecRunner({ config: cfg, pwshPath: 'C:\\fake\\pwsh.exe', spawnImpl: spawnReturning(fakeChild()) });
    await r1.run({ scriptPath: insideScript });
    const r2 = createExecRunner({ config: cfg, pwshPath: 'C:\\fake\\pwsh.exe', spawnImpl: spawnReturning(fakeChild()) });
    await r2.run({ scriptPath: insideScript });
  } finally {
    process.stderr.write = origWrite;
  }
  const warnings = writes.filter((w) => w.includes('execCwdRoot 未配置'));
  assert.equal(warnings.length, 2, `两个实例各自告警一次，实际 ${warnings.length} 次`);
});
