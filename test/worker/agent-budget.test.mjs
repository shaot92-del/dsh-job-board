// agent-budget.test.mjs — 每日额度的计数、跨进程锁、fail-closed。
//
// 重点覆盖 v2.6.19 的 P1-3 修复（盘古审计）：consume 的 read-判-write 以前没有跨进程
// 互斥，同机多实例并发会丢计数、当日额度能超发。现在走 withFileLock，抢不到锁
// 就本次不放行（fail-closed，宁可少放也不超发）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAgentBudget,
  budgetDate,
  DEFAULT_MAX_PER_DAY,
  BUDGET_FILE,
} from '../../lib/worker/agent-budget.js';
import { withFileLock } from '../../lib/state-file.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-budget-'));
}

test('budgetDate：UTC 日（不受本地时区影响）', () => {
  assert.equal(budgetDate(Date.parse('2026-11-18T00:00:00Z')), '2026-11-18');
  assert.equal(budgetDate(Date.parse('2026-11-18T23:59:59Z')), '2026-11-18');
  assert.equal(budgetDate(Date.parse('2026-11-19T00:00:00Z')), '2026-11-19');
});

test('无 stateDir：退化成进程内计数，超限后 continue 被拒', () => {
  const b = createAgentBudget({ maxPerDay: 2 });
  assert.equal(b.consume().ok, true);
  assert.equal(b.consume().ok, true);
  const third = b.consume();
  assert.equal(third.ok, false);
  assert.equal(third.used, 2);
  assert.equal(third.limit, 2);
  assert.equal(b.peek().used, 2);
  assert.equal(b.peek().ok, false);
});

test('有 stateDir：计数落盘，第二个实例读到同一额度（锁路径）', () => {
  const dir = tmpDir();
  const now = () => Date.parse('2026-11-18T10:00:00Z');
  const a = createAgentBudget({ stateDir: dir, maxPerDay: 3, now });
  const b = createAgentBudget({ stateDir: dir, maxPerDay: 3, now });
  assert.equal(a.consume().ok, true);
  assert.equal(b.consume().ok, true);
  assert.equal(a.consume().ok, true);
  // 第三个额度已用完：两个实例都必须看到 used=3
  assert.equal(a.peek().used, 3);
  assert.equal(b.peek().used, 3);
  assert.equal(b.consume().ok, false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, BUDGET_FILE), 'utf8'));
  assert.equal(onDisk.used, 3);
  assert.equal(onDisk.date, '2026-11-18');
});

test('refund：退还后额度可用，且不写负值', () => {
  const dir = tmpDir();
  const now = () => Date.parse('2026-11-18T10:00:00Z');
  const b = createAgentBudget({ stateDir: dir, maxPerDay: 1, now });
  assert.equal(b.consume().ok, true);
  b.refund();
  b.refund(); // 多退一次不能把 used 写成负数
  assert.equal(b.peek().used, 0);
  assert.equal(b.consume().ok, true);
});

test('跨日：旧日期的计数不算今天的（UTC 边界）', () => {
  const dir = tmpDir();
  let t = Date.parse('2026-11-18T23:59:00Z');
  const b = createAgentBudget({ stateDir: dir, maxPerDay: 1, now: () => t });
  assert.equal(b.consume().ok, true);
  assert.equal(b.consume().ok, false);
  t = Date.parse('2026-11-19T00:01:00Z');
  assert.equal(b.peek().used, 0);
  assert.equal(b.consume().ok, true);
});

test('锁被占：consume fail-closed（本次不放行，且不写盘）', () => {
  const dir = tmpDir();
  const now = () => Date.parse('2026-11-18T10:00:00Z');
  const file = path.join(dir, BUDGET_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // 先占住锁（模拟另一个进程正在 consume）
  const held = withFileLock(file, () => 'held');
  assert.equal(held.ok, true);
  const order = [];
  // withFileLock 是同步的：在它内部的 fn 里再发起 consume 才能撞上「锁被占」
  let inner = null;
  const outer = withFileLock(file, () => {
    inner = createAgentBudget({ stateDir: dir, maxPerDay: 2, now }).consume();
    return 'done';
  });
  assert.equal(outer.ok, true);
  order.push(inner);
  assert.equal(inner.ok, false, '抢不到锁时不能放行');
  assert.ok(inner.error, '要说明原因（busy/stale-lock-*）');
  assert.equal(fs.existsSync(file), false, '抢锁失败不该写计数文件');
});

test('默认额度与常量', () => {
  assert.equal(DEFAULT_MAX_PER_DAY, 20);
  assert.equal(BUDGET_FILE, 'agent-budget.json');
  const b = createAgentBudget();
  assert.equal(b.peek().limit, DEFAULT_MAX_PER_DAY);
});
