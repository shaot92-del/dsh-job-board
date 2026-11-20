// state-file.mjs 测试：withFileLock 的 stale 心跳校验与 error 分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock, writeStateJson } from '../../lib/state-file.mjs';

// v2.6.28（安全审计 C-8）：withFileLock 的 stale 只看 mtime，进程挂起时锁被误抢。
// 加 pid/心跳校验——读锁文件里的 pid，若该 pid 仍存活则不抢。
test('withFileLock：stale 但 pid 存活时不抢锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-c8-'));
  const file = path.join(dir, 'state.json');
  const lockFile = `${file}.lock`;
  try {
    // 手动创建锁文件（模拟另一个进程持锁），pid = 当前进程（存活），mtime 已 stale
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 100000 }), 'utf8');
    // staleMs=1 → mtime 远超 stale → stale=true
    // 但 pid = 当前进程（存活）→ 不抢 → busy
    const r = withFileLock(file, () => 'should-not-run', { waitMs: 50, staleMs: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// v2.6.28（安全审计 C-9）：withFileLock 的 fn 抛异常时返回不区分「锁失败」与「业务失败」。
// error 分类：lock-timeout vs fn-error。
test('withFileLock：fn 抛异常时 kind=fn-error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-c9-'));
  const file = path.join(dir, 'state.json');
  try {
    const r = withFileLock(file, () => { throw new Error('business boom'); }, { waitMs: 100 });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'fn-error', `fn 抛错应归类为 fn-error，got kind=${r.kind}`);
    assert.match(r.error, /business boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withFileLock：锁超时时 kind=lock-timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-c9b-'));
  const file = path.join(dir, 'state.json');
  try {
    // 先拿锁（不释放——fn 持有锁不返回）
    // withFileLock 是同步的，fn 执行完就释放。要模拟锁被占用，
    // 我们用一个子进程持锁。但这里更简单：直接验证 wait-timeout 的 kind。
    // 用 staleMs 很大 + waitMs 很小，让锁被占时超时
    // 先拿锁
    const r1 = withFileLock(file, () => {
      // 持有锁不返回——但 withFileLock 是同步的，fn 必须返回
      // 所以这里用另一个方式：直接创建锁文件
      return 'held';
    }, { waitMs: 100 });
    assert.equal(r1.ok, true);
    // r1 已释放锁。要模拟锁被占，手动创建锁文件
    const lockFile = `${file}.lock`;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    // 现在锁文件存在，pid = 当前进程（存活），staleMs 很大 → 不 stale → 等 waitMs 超时
    const r2 = withFileLock(file, () => 'should-not-run', { waitMs: 50, staleMs: 60000 });
    assert.equal(r2.ok, false);
    assert.equal(r2.kind, 'lock-timeout', `锁超时应归类为 lock-timeout，got kind=${r2.kind}`);
    assert.equal(r2.busy, true);
    // 清理手动创建的锁文件
    fs.rmSync(lockFile, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});