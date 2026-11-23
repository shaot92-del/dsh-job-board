// 2.7.11 复审修正（P0-1 / P1-1 / P1-2 / P2-1 / P2-2 / P3-2）的专项测试。
// 这里直接测「重启助手脚本」的构造与真实执行结果 —— 复审的 P0-1/P1-1 都是脚本层问题，
// 只测 JS 分支（queued=true）抓不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import { buildRestartScript, createMaintVerbs, restartLogPath } from '../../lib/worker/maint-verbs.js';
import { createTarGz } from '../../lib/worker/tar.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rs-'));
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

// 造一个真实 tgz（npm pack 结构：package/package.json），放在 maintenancePkgDir 里当升级包。
async function makeTgzFixture(version = '9.9.9') {
  const src = tmpDir();
  const pkg = path.join(src, 'package');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@wfcj/dsh-job-board', version }), 'utf8');
  const pkgRoot = tmpDir();
  const tgzPath = path.join(pkgRoot, 'pkg.tgz');
  const entries = [
    { name: 'package/', dir: true },
    { name: 'package/package.json', data: fs.readFileSync(path.join(pkg, 'package.json')) },
  ];
  await createTarGz(tgzPath, entries);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(tgzPath)).digest('hex');
  return { pkgRoot, tgzPath, hash };
}

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
  const stage = path.join(dir, "stage'$(Get-Date -Format yyyy)");
  const install = path.join(dir, "install'$(Get-Date -Format yyyy)");
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(stage, 'new.txt'), 'new');
  // 必须传 moveFrom/moveTo —— 否则 swap 行根本不生成，测不到 P1-1 那条双引号拼接。
  const fake = path.join(dir, "dsh'$(Get-Date -Format yyyy).exe");
  const logFile = path.join(dir, 'restart-test.log');
  const s = buildRestartScript({
    delayMs: 0,
    dshExe: fake,
    pid: 0,
    taskSlug: 't-2',
    moveFrom: stage,
    moveTo: install,
    logFile,
  });
  let code = 0;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', s], { stdio: 'ignore', timeout: 20000 });
  } catch (err) {
    code = err.status;
  }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  assert.ok(log.length > 0, '必须写日志到指定文件');
  assert.ok(log.includes(fake), 'dshExe 路径必须原样出现在日志里（不被展开）');
  assert.ok(log.includes('swap '), 'swap 行必须真的执行到（否则测不到 P1-1）');
  assert.ok(log.includes('$(Get-Date -Format yyyy)'), '路径里的 $() 必须原样保留在日志里');
  // P2（2.7.13 复审）：原断言 !/[0-9]{4}\.exe/ 是空断言——年份展开在目录名里、不在 .exe 前。
  // 改为直接检查「当前年份」没有出现在日志里，且 swap 行两侧路径都保留字面量 $()。
  const swapRaw = (log.split('\n').find((l) => l.includes('swap ')) || '');
  // 去掉行首时间戳（时间戳里也有年份，会干扰「未展开」判断）
  const swapLine = swapRaw.slice(swapRaw.indexOf('swap '));
  assert.ok(!swapLine.includes(String(new Date().getFullYear())), 'swap 行里的 $() 不能被展开成当前年份');
  assert.ok((swapLine.match(/\$\(Get-Date -Format yyyy\)/g) || []).length >= 2, 'swap 行两侧路径（from/to）都必须保留 $() 字面量');
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

test('runRestart：stateDir 设了时 hint 与 helper 实际日志路径一致（复审 P1）', async () => {
  const stateDir = tmpDir();
  const calls = [];
  const v = createMaintVerbs({
    config: { maintenanceAllowRestart: true, dshExePath: process.execPath, stateDir },
    log: quietLog,
    fs,
    spawnImpl: (exe, args) => { calls.push(args); return { pid: 1 }; },
    pkgDir: tmpDir(),
    profileDir: tmpDir(),
    now: () => Date.now(),
  });
  const r = await v.run('restart', { delayMs: 3000 }, { taskId: 't-hint' });
  assert.equal(r.ok, true);
  const expectLog = path.join(path.resolve(stateDir), 'restart-t-hint.log');
  assert.ok(r.note.includes(expectLog), `note 必须给出与 helper 一致的日志路径，实际：${r.note}`);
  const script = calls[0][calls[0].length - 1];
  assert.ok(script.includes(expectLog), 'helper 脚本必须写同一个日志文件');
});

test('upgrade：回执带日志路径与「spawn 成功 ≠ 重启成功」免责（复审 P2）', async () => {
  const { pkgRoot, tgzPath, hash } = await makeTgzFixture();
  const installDir = tmpDir();
  const stateDir = tmpDir();
  fs.writeFileSync(path.join(installDir, 'old.txt'), 'old');
  const v = createMaintVerbs({
    config: {
      maintenanceAllowRestart: true,
      dshExePath: process.execPath,
      maintenancePkgDir: pkgRoot,
      stateDir,
    },
    log: quietLog,
    fs,
    spawnImpl: () => ({ pid: 1 }),
    pkgDir: installDir,
    profileDir: tmpDir(),
    now: () => Date.now(),
  });
  const r = await v.run('upgrade', { file: 'pkg.tgz', sha256: hash }, { taskId: 't-up-note' });
  assert.equal(r.ok, true, '实际 note='+r.note);
  assert.match(r.note, /助手日志/, 'note 必须指向助手日志');
  assert.match(r.note, /spawn 成功 ≠ 重启成功/, 'note 必须说明 spawn 成功不等于重启成功');
  assert.ok(r.note.includes(path.join(path.resolve(stateDir), 'restart-t-up-note.log')));
  assert.ok(fs.existsSync(tgzPath));
});

test('upgrade：排入重启失败时走 log.warn（真的覆盖目标行，P3-2）', async () => {
  const { pkgRoot, hash } = await makeTgzFixture();
  const installDir = tmpDir();
  fs.writeFileSync(path.join(installDir, 'old.txt'), 'old');
  const warns = [];
  const v = createMaintVerbs({
    config: { maintenanceAllowRestart: true, dshExePath: process.execPath, maintenancePkgDir: pkgRoot },
    log: { info() {}, warn: (m) => warns.push(String(m)), error() {}, debug() {} },
    fs,
    spawnImpl: () => { throw new Error('boom'); },
    pkgDir: installDir,
    profileDir: tmpDir(),
    now: () => Date.now(),
  });
  const r = await v.run('upgrade', { file: 'pkg.tgz', sha256: hash }, { taskId: 't-warn' });
  assert.equal(r.ok, true, '装包本身成功，只是重启没排上；实际 note='+r.note);
  assert.match(r.note, /需重启/);
  assert.ok(warns.some((m) => m.includes('排入重启失败')), `应记录 log.warn，实际：${JSON.stringify(warns)}`);
});
