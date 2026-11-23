// maint-verbs-restart-spawn.test.mjs — 验证远程重启助手的 spawn 确认、pwsh 兜底解析、无 detached 静默退出与真实端到端执行。
//
// 覆盖场景：
//   1. 真实 child_process.spawn 对不存在可执行文件触发异步 ENOENT → 必须 blocked/maint-spawn-failed，不得返回 ok；
//   2. 真实 child_process.spawn 成功启动 → 返回 ok，写入选中 shell 路径，且 spawnOpts 不含 detached:true；
//   3. pwsh 解析兜底顺序：pwsh.exe → %LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe → %ProgramFiles%\PowerShell\7\pwsh.exe → powershell.exe；
//      显式配置 config.pwshPath 时不静默回退；最终选中的路径写入回执 note 与 restart-*.log；
//   4. spawn 挂起超时（4 秒机制，测试内缩短超时）→ blocked/maint-spawn-failed + ETIMEDOUT，且晚到 error 不崩进程；
//   5. buildRestartScript 助手脚本第一件事写 "helper start" 到日志（在 Start-Sleep 之前）；
//   6. 兼容只记录参数不返回 EventEmitter 的旧单测桩；
//   7. Windows 真机端到端（真实 cp.spawn + 真实 pwsh/powershell，delayMs=300）：断言日志先后出现 helper start 与 restart-succeeded。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAINT_VERB_REASONS,
  SPAWN_CONFIRM_TIMEOUT_MS,
  buildRestartScript,
  createMaintVerbs,
  resolvePwshCandidates,
} from '../../lib/worker/maint-verbs.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-maint-restart-spawn-'));
}

function makeFakeExe(dir, name = 'dsh.exe') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'stub', 'utf8');
  return p;
}

function makeFakeChild(behavior) {
  const child = new EventEmitter();
  child.pid = 42424;
  child.unreffed = false;
  child.unref = () => { child.unreffed = true; };
  queueMicrotask(() => behavior(child));
  return child;
}

async function waitForLogMatch(logFile, regex, timeoutMs = 15000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(logFile)) {
      lastText = fs.readFileSync(logFile, 'utf8');
      if (regex.test(lastText)) return lastText;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  assert.fail(`超时 ${timeoutMs}ms 未在 ${logFile} 中匹配 ${regex}；当前日志内容：\n${lastText}`);
}

test('restart：真实 child_process.spawn 遇 ENOENT 时不得返回 ok，必须返回 blocked/maint-spawn-failed', async () => {
  const dir = makeTempDir();
  const stateDir = path.join(dir, 'state');
  const dshExe = makeFakeExe(dir);
  const missingPwsh = path.join(dir, 'pwsh-does-not-exist.exe');

  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: dshExe,
      pwshPath: missingPwsh,
      stateDir,
    },
    log: quietLog,
    spawnImpl: spawn,
  });

  const r = await v.run('restart', { delayMs: 3000 }, { taskId: 'maint-enoent-1' });
  assert.equal(r.ok, false, 'ENOENT 绝不能返回 ok=true');
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, MAINT_VERB_REASONS.SPAWN_FAILED);
  assert.match(r.note, /ENOENT/);
  assert.match(r.note, /PowerShell 7|worker\.pwshPath/);

  const logFile = path.join(stateDir, 'restart-maint-enoent-1.log');
  assert.ok(fs.existsSync(logFile), '失败时也应落盘排障日志');
  assert.match(fs.readFileSync(logFile, 'utf8'), /spawn-failed/);
});

test('restart：真实 child_process.spawn 成功启动时返回 ok，不传 detached:true，并写入选中 shell 路径', async () => {
  const dir = makeTempDir();
  const stateDir = path.join(dir, 'state');
  const dshExe = makeFakeExe(dir);
  let capturedOpts = null;

  // 用当前 node 进程验证真实 ChildProcess 的 'spawn' 事件确认链路与 spawnOpts
  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: dshExe,
      pwshPath: process.execPath,
      stateDir,
    },
    log: quietLog,
    spawnImpl: (cmd, _args, opts) => {
      capturedOpts = opts;
      return spawn(cmd, ['-e', 'process.exit(0)'], opts);
    },
  });

  const r = await v.run('restart', { delayMs: 3000 }, { taskId: 'maint-ok-real' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'ok');
  assert.equal(r.pwsh, process.execPath);
  assert.notEqual(capturedOpts.detached, true, '不得传 detached:true（Windows 下会导致 pwsh 立即 exit 0）');
  assert.equal(capturedOpts.stdio, 'ignore');
  assert.equal(capturedOpts.windowsHide, true);
  assert.ok(r.note.includes(process.execPath), '回执 note 应包含最终选中的 shell 路径');

  const logText = fs.readFileSync(path.join(stateDir, 'restart-maint-ok-real.log'), 'utf8');
  assert.ok(logText.includes(`pwsh=${process.execPath}`), '日志应记录最终选中的 shell 路径');
});

test('resolvePwshCandidates：未配置 pwshPath 时按约定顺序返回兜底候选；显式配置时只尝试配置值', () => {
  assert.equal(SPAWN_CONFIRM_TIMEOUT_MS, 4000);

  const fallback = resolvePwshCandidates({}, {
    LOCALAPPDATA: 'C:\\Users\\gt14\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  });
  assert.deepEqual(fallback, [
    'pwsh.exe',
    'C:\\Users\\gt14\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'powershell.exe',
  ]);

  const explicit = resolvePwshCandidates(
    { pwshPath: 'D:\\Custom\\pwsh.exe' },
    { LOCALAPPDATA: 'C:\\Users\\gt14\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
  );
  assert.deepEqual(explicit, ['D:\\Custom\\pwsh.exe']);
});

test('restart：pwsh.exe 不在 PATH 时依次兜底，命中后把最终路径写入 note 与日志并调用 unref()', async () => {
  const dir = makeTempDir();
  const stateDir = path.join(dir, 'state');
  const dshExe = makeFakeExe(dir);
  const tried = [];
  let succeededChild = null;
  const targetCmd = 'C:\\Users\\gt14\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe';

  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: dshExe,
      stateDir,
    },
    env: {
      LOCALAPPDATA: 'C:\\Users\\gt14\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    },
    log: quietLog,
    spawnImpl: (cmd) => {
      tried.push(cmd);
      if (cmd === targetCmd) {
        succeededChild = makeFakeChild((c) => c.emit('spawn'));
        return succeededChild;
      }
      return makeFakeChild((c) => {
        const err = new Error(`spawn ${cmd} ENOENT`);
        err.code = 'ENOENT';
        c.emit('error', err);
      });
    },
  });

  const r = await v.run('restart', { delayMs: 4000 }, { taskId: 'maint-fallback-1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(r.pwsh, targetCmd);
  assert.deepEqual(tried, ['pwsh.exe', targetCmd]);
  assert.equal(succeededChild.unreffed, true, '确认 spawn 后必须调用 child.unref()');
  assert.ok(r.note.includes(targetCmd), 'note 应记录最终选中的路径');

  const logText = fs.readFileSync(path.join(stateDir, 'restart-maint-fallback-1.log'), 'utf8');
  assert.ok(logText.includes(`pwsh=${targetCmd}`), '日志应记录最终选中的路径');
});

test('restart：所有兜底候选均 ENOENT 时返回 blocked/maint-spawn-failed 并给出可操作提示', async () => {
  const dir = makeTempDir();
  const dshExe = makeFakeExe(dir);
  const tried = [];

  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: dshExe,
    },
    env: {
      LOCALAPPDATA: 'C:\\Users\\gt14\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    },
    log: quietLog,
    spawnImpl: (cmd) => {
      tried.push(cmd);
      return makeFakeChild((c) => {
        const err = new Error(`spawn ${cmd} ENOENT`);
        err.code = 'ENOENT';
        c.emit('error', err);
      });
    },
  });

  const r = await v.run('restart', {}, { taskId: 'maint-all-fail' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, MAINT_VERB_REASONS.SPAWN_FAILED);
  assert.equal(tried.length, 4);
  assert.equal(tried[3], 'powershell.exe');
  assert.match(r.note, /ENOENT/);
  assert.match(r.note, /已尝试 4 个候选均失败/);
  assert.match(r.note, /PowerShell 7/);
  assert.match(r.note, /worker\.pwshPath/);
});

test('restart：spawn 超时未收到 spawn/error 事件 → blocked/maint-spawn-failed + ETIMEDOUT，晚到 error 不崩溃', async () => {
  const dir = makeTempDir();
  const dshExe = makeFakeExe(dir);
  let hungChild = null;

  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: dshExe,
      pwshPath: 'C:\\hung\\pwsh.exe',
    },
    log: quietLog,
    spawnTimeoutMs: 60,
    spawnImpl: () => {
      hungChild = new EventEmitter();
      hungChild.unref = () => {};
      return hungChild;
    },
  });

  const r = await v.run('restart', {}, { taskId: 'maint-timeout' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, MAINT_VERB_REASONS.SPAWN_FAILED);
  assert.match(r.note, /ETIMEDOUT/);

  // 晚到的 error 事件必须被安全吞掉，不得触发 Unhandled 'error' event
  assert.doesNotThrow(() => hungChild.emit('error', Object.assign(new Error('late'), { code: 'ENOENT' })));
});

test('buildRestartScript：助手脚本第一件事写 "helper start" 到日志（早于 Start-Sleep）', () => {
  const script = buildRestartScript({
    delayMs: 8000,
    dshExe: 'C:\\Users\\gt14\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    pid: 33328,
    taskSlug: 'maint-abc',
    logFile: 'C:\\Users\\gt14\\AppData\\Local\\dsh-job-worker\\restart-maint-abc.log',
  });
  const helperStartIdx = script.indexOf('helper start');
  const sleepIdx = script.indexOf('Start-Sleep -Milliseconds 8000');
  assert.ok(helperStartIdx > 0, '脚本应包含 helper start 日志输出');
  assert.ok(sleepIdx > helperStartIdx, 'helper start 必须在 Start-Sleep 之前写入');
});

test('restart：兼容无 EventEmitter 的旧单测桩（同步返回 undefined）', async () => {
  const dir = makeTempDir();
  const dshExe = makeFakeExe(dir);
  let recorded = null;

  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: dshExe,
      pwshPath: 'C:\\pwsh.exe',
    },
    log: quietLog,
    spawnImpl: (cmd, args, opts) => { recorded = { cmd, args, opts }; },
  });

  const r = await v.run('restart', { delayMs: 5000 }, { taskId: 'maint-legacy-stub' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(recorded.cmd, 'C:\\pwsh.exe');
});

test('端到端（Windows）：真实 cp.spawn + 真实 pwsh 执行重启助手，日志先后出现 helper start 与 restart-succeeded', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = makeTempDir();
  const stateDir = path.join(dir, 'state');
  // 假 DSH 可执行文件（.cmd 在 %TEMP% 下无副作用退出，供 Start-Process 拉起验收）
  const fakeDshCmd = path.join(dir, 'fake-dsh.cmd');
  fs.writeFileSync(fakeDshCmd, '@echo off\r\nexit /b 0\r\n', 'utf8');

  // 起一个一次性子进程作为「待重启目标 PID」，避免杀掉测试 runner 自身
  const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    dummy.once('spawn', resolve);
    dummy.once('error', reject);
  });

  try {
    const v = createMaintVerbs({
      config: {
        maintenanceAllowRestart: true,
        dshExePath: fakeDshCmd,
        stateDir,
      },
      log: quietLog,
      spawnImpl: spawn,
      minDelayMs: 0,
      pid: dummy.pid,
    });

    const r = await v.run('restart', { delayMs: 300 }, { taskId: 'maint-e2e-real' });
    assert.equal(r.ok, true, `预期 spawn 成功，实际：${JSON.stringify(r)}`);
    assert.equal(r.status, 'done');

    const logFile = path.join(stateDir, 'restart-maint-e2e-real.log');
    // 1) 证明 pwsh 助手脚本真正启动执行（未因 detached:true 静默 exit 0）
    await waitForLogMatch(logFile, /helper start task=maint-e2e-real/, 8000);
    // 2) 证明完成杀目标进程 → 复核退出 → 拉起 fake-dsh.cmd → 自证成功
    const finalLog = await waitForLogMatch(logFile, /restart-succeeded/, 12000);
    assert.match(finalLog, /pwsh=/);
  } finally {
    try { dummy.kill('SIGKILL'); } catch { /* 已由重启助手杀掉 */ }
  }
});
