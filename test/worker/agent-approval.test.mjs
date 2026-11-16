// 审批记录：写盘失败时的返回值与「只回错误码」约束（第三遍审计 N2 / P2-C / N3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentApprovals, promptFingerprint } from '../../lib/worker/agent-approval.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-'));
}

function quietLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(String(m)), debug() {} };
}

test('record：写盘失败返回 ok:false 且错误里不带本机路径', () => {
  const dir = tmpDir();
  const log = quietLog();
  const fsImpl = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    renameSync: () => {
      const err = new Error(`ENOTDIR: not a directory, mkdir '${dir}\\blocker\\sub'`);
      err.code = 'ENOTDIR';
      throw err;
    },
  };
  const approvals = createAgentApprovals({ stateDir: dir, fsImpl, log });
  const r = approvals.record('t1', '写周报');
  assert.equal(r.ok, false);
  assert.equal(r.inMemoryOnly, true);
  assert.match(r.error, /写盘失败/);
  assert.match(r.error, /ENOTDIR/);
  assert.ok(!r.error.includes(dir), '错误里不能带本机 stateDir 路径');
  assert.equal(approvals.writeFailed(), true);
  // 同进程内仍然生效（dirty 时内存优先）
  assert.equal(approvals.check('t1', '写周报').reason, 'approved');
  // 日志里保留完整原因，便于本机排查
  assert.ok(log.warns.join('\n').includes(dir));
});

test('revoke：写盘失败不再假装成功，且内存里已撤销', () => {
  const dir = tmpDir();
  const approvals = createAgentApprovals({ stateDir: dir, log: quietLog() });
  assert.equal(approvals.record('t2', '写周报').ok, true);
  assert.equal(approvals.check('t2', '写周报').reason, 'approved');

  const fsImpl = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    renameSync: () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  // 复用同一 stateDir，但换一个会失败的 fs：新建实例读的是同一份文件
  const failing = createAgentApprovals({ stateDir: dir, fsImpl, log: quietLog() });
  const r = failing.revoke('t2');
  assert.equal(r.revoked, true);
  assert.equal(r.ok, false);
  assert.equal(r.inMemoryOnly, true);
  assert.match(r.error, /EACCES/);
  assert.equal(failing.check('t2', '写周报').reason, 'no-record');
});

test('revoke：没有记录时是无操作成功（不报错）', () => {
  const approvals = createAgentApprovals({ stateDir: tmpDir(), log: quietLog() });
  const r = approvals.revoke('nope');
  assert.equal(r.ok, true);
  assert.equal(r.revoked, false);
});

// 第四遍审计 N7：撤销写盘失败后（tombstone 状态）再次撤销，不能回「已处理」——
// 内存里确实没有记录，但文件里还在，重启后仍会 approved。
test('revoke：tombstone 状态下二次撤销要如实说「还没写进磁盘」', () => {
  const dir = tmpDir();
  const ok = createAgentApprovals({ stateDir: dir, log: quietLog() });
  assert.equal(ok.record('t9', '写周报').ok, true);

  const failingFs = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    renameSync: () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  const failing = createAgentApprovals({ stateDir: dir, fsImpl: failingFs, log: quietLog() });
  assert.equal(failing.revoke('t9').ok, false);

  const again = failing.revoke('t9');
  assert.equal(again.ok, false, '文件里还有记录，不能报成功');
  assert.equal(again.revoked, false);
  assert.equal(again.inMemoryOnly, true);
  assert.match(again.error, /还没写进磁盘|未写进磁盘/);
});

test('指纹：首尾空白与内部连续空白等价', () => {
  assert.equal(promptFingerprint('写一份报告\n'), promptFingerprint('写一份报告'));
  assert.equal(promptFingerprint('  写  一份  报告  '), promptFingerprint('写 一份 报告'));
});
