// 2.7.11 复审修正（P0-1 / P1-1 / P1-2 / P2-1 / P2-2 / P3-2）的专项测试。
// 这里直接测「重启助手脚本」的构造与真实执行结果 —— 复审的 P0-1/P1-1 都是脚本层问题，
// 只测 JS 分支（queued=true）抓不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { buildRestartScript, createMaintVerbs } from '../../lib/worker/maint-verbs.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rs-'));
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function hasPwsh() {
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('buildRestartScript：换目录失败必须 Stop + 失败标记 + exit 1（P0-1 / P1-2）', () => {
  const s = buildRestartScript({
    delayMs: 6000,
    dshExe: 'C:\\x\\DSH.exe',
    pid: 1234,
    taskSlug: 't-1',
    moveFrom: 'C:\\stage\\pkg',
    moveTo: 'C:\\install\\pkg',
    expectFile: 'C:\\install\\pkg\\package.json',
  });
  // ① Remove-Item 必须 -ErrorAction Stop（否则失败被静默，Move 会把源挪成目标的子目录）
  assert.match(s, /Remove-Item -LiteralPath 'C:\\install\\pkg' -Recurse -Force -ErrorAction Stop/);
  assert.match(s, /Move-Item -LiteralPath 'C:\\stage\\pkg' -Destination 'C:\\install\\pkg' -ErrorAction Stop/);
  assert.match(s, /remove-left-target/);
  assert.match(s, /verify-missing/);
  assert.match(s, /restart-failed/);
  assert.match(s, /if \(\$fail\) \{ exit 1 \}/);
  assert.match(s, /restart-succeeded/);
  // ② 日志拼路径必须在单引号上下文（双引号里 $ 与 $(...) 会被展开/执行）
  assert.ok(!/L "swap /.test(s), '日志行不能用双引号拼路径');
  assert.match(s, /L \('swap ' \+ 'C:\\stage\\pkg' \+ ' -> ' \+ 'C:\\install\\pkg'\)/);
});

test('buildRestartScript：pid/delayMs 非有限数 → 归一（P2-2）', () => {
  const s = buildRestartScript({ delayMs: Number.NaN, dshExe: 'x', pid: 'oops', taskSlug: '' });
  assert.match(s, /Start-Sleep -Milliseconds 6000/);
  assert.match(s, /task=task/);
  assert.ok(!/Stop-Process -Id NaN/.test(s));
});

test('buildRestartScript：目标路径含 $ 与 $() → 真实执行时不展开（P1-1 实证）', { skip: !hasPwsh() }, () => {
  const dir = tmpDir();
  const fake = path.join(dir, "dsh'$(Get-Date -Format yyyy).exe");
  // 不存在的 exe：脚本会走 fallback pid=0 失败 → 最后 Start-Process 失败 → exit 1
  const s = buildRestartScript({ delayMs: 0, dshExe: fake, pid: 0, taskSlug: 't-2' });
  const logFile = path.join(process.env.TEMP || os.tmpdir(), 'dsh-maint-restart.log');
  try { fs.rmSync(logFile, { force: true }); } catch {}
  let code = 0;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', s], { stdio: 'ignore', timeout: 20000 });
  } catch (err) {
    code = err.status;
  }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  assert.ok(log.length > 0, '必须写日志');
  assert.ok(log.includes(fake), '路径必须原样出现在日志里（不被展开）');
  assert.ok(!/[0-9]{4}\.exe/.test(log), '不应出现被展开成的年份');
  assert.notEqual(code, 0, 'exe 不存在应 exit 1');
});

test('buildRestartScript：换目录失败时不动源目录（P0-1 真实执行：目标被占）', { skip: !hasPwsh() }, () => {
  const base = tmpDir();
  const stage = path.join(base, 'stage');
  const install = path.join(base, 'install');
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(stage, 'new.txt'), 'new');
  fs.writeFileSync(path.join(install, 'old.txt'), 'old');
  // 让 Remove-Item 的目标不可删：用只读属性 + 打开句柄不可行于跨平台，这里用「目标改成文件」不可用来保证 Move 失败
  // → 更稳的做法：moveTo 指向一个已存在的**文件**（Remove 会删掉它，Move 变成 dir→file 失败），
  //   断言失败后 stage 仍在（没有被挪到别处）。
  const toFile = path.join(base, 'blocker.txt', 'nested-target');
  fs.writeFileSync(path.join(base, 'blocker.txt'), 'not-a-dir');
  // 用一个不会运行中的假 exe（复制 ping.exe），绝不能传 process.execPath —— 那会把测试进程自己杀掉。
  const fakeExe = path.join(base, 'fake-dsh.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), fakeExe);
  const s = buildRestartScript({
    delayMs: 0,
    dshExe: fakeExe,
    pid: 0,
    taskSlug: 't-3',
    moveFrom: stage,
    moveTo: toFile,
    expectFile: toFile,
  });
  let code = 0;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', s], { stdio: 'ignore', timeout: 20000 });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 1, '目录/文件类型不匹配应 exit 1');
  assert.ok(fs.existsSync(path.join(stage, 'new.txt')), '失败时源目录必须还在（不许被挪成子目录）');
});

test('runRestart：回执 note 带日志路径（P2-1）', async () => {
  const calls = [];
  const v = createMaintVerbs({
    config: { maintenanceAllowRestart: true, dshExePath: process.execPath },
    log: quietLog,
    fs,
    spawnImpl: (exe, args, opts) => {
      calls.push({ exe, args, opts });
      return { pid: 1 };
    },
    pkgDir: tmpDir(),
    profileDir: tmpDir(),
    now: () => Date.now(),
  });
  const r = await v.run('restart', { delayMs: 3000 }, { taskId: 't-note' });
  assert.equal(r.ok, true);
  assert.match(r.note, /日志|log/i);
  assert.match(r.note, /dsh-maint-restart\.log|restart-/);
  assert.equal(calls.length, 1);
});

test('upgrade：排入重启失败时不抛 trace is not defined（P3-2）', async () => {
  const pkgDir = tmpDir();
  const installDir = tmpDir();
  fs.writeFileSync(path.join(installDir, 'old.txt'), 'old');
  const v = createMaintVerbs({
    config: { maintenanceAllowRestart: true, dshExePath: process.execPath },
    log: quietLog,
    fs,
    spawnImpl: () => {
      throw new Error('boom');
    },
    pkgDir: installDir,
    profileDir: tmpDir(),
    now: () => Date.now(),
  });
  // 走「upgrade 校验失败」分支即可覆盖 log.warn 调用（trace → log.warn）
  const r = await v.run('upgrade', { file: '../escape.tgz', sha256: 'a'.repeat(64) }, { taskId: 't-trace' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked');
  assert.ok(String(r.note).length > 0);
  assert.ok(pkgDir.length > 0);
});
