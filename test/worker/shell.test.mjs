// shell.js 安全边界测试：sh_list 的 lstat 与 denyMessage 的路径脱敏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerShellTools } from '../../lib/shell.js';

// v2.6.28（安全审计 S-4）：sh_list 对目录项 statSync 跟随符号链接，
// bytes/mtime 取自白名单外目标。改 lstat。
test('sh_list：lstat 不跟随 symlink（isDirectory 为 false）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-test-'));
  const realDir = path.join(root, 'realDir');
  const linkDir = path.join(root, 'linkDir');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'data.txt'), 'hello world', 'utf8');
  try {
    try {
      fs.symlinkSync(realDir, linkDir, 'junction');
    } catch {
      try {
        fs.symlinkSync(realDir, linkDir);
      } catch {
        return; // 无法创建 symlink 就跳过
      }
    }
    const lstat = fs.lstatSync(linkDir);
    const stat = fs.statSync(linkDir);
    assert.equal(lstat.isDirectory(), false, 'lstat 不应跟随 symlink');
    assert.equal(stat.isDirectory(), true, 'stat 应跟随 symlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// v2.6.28（安全审计 S-6）：denyMessage 把 roots 配置值拼进返回消息，
// 路径含敏感信息时上板。消息里只报数量，不拼全路径。
test('denyMessage：roots 配置值不拼进返回消息（只报数量）', async () => {
  const roots = ['C:\\Users\\Alice\\work', 'C:\\Users\\Bob\\proj'];
  const ctx = makeCtx();
  registerShellTools(ctx, { allowedRoots: roots });
  const shRead = ctx.registered.find((r) => r.name === 'sh_read');
  const r = await shRead.execute({ path: 'C:\\Windows\\secret.txt' });
  assert.equal(r.ok, false);
  assert.equal(r.message.includes('C:\\Users\\Alice\\work'), false, 'roots 路径不应出现在拒绝消息里');
  assert.equal(r.message.includes('C:\\Users\\Bob\\proj'), false, 'roots 路径不应出现在拒绝消息里');
  assert.match(r.message, /\d+ 条根/, '拒绝消息应报 roots 数量');
});

function makeCtx() {
  const registered = [];
  return {
    tools: {
      register(def) {
        registered.push(def);
      },
    },
    registered,
  };
}