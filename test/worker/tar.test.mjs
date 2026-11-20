// tar.test.mjs — 极简 tar 读写器的回归（维护升级唯一用到的解包路径）。
//
// 这一层的价值全在「解包不能变成写入跳板」：绝对路径、`..`、符号链接、损坏头
// 都必须明确失败，而不是忽略。测试用 createTarGz 造包（它支持伪造 type/linkname），
// 再用 extractTarGz 解到临时目录检查行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTarGz, extractTarGz, TAR_LIMITS } from '../../lib/worker/tar.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tar-lite-'));
}

test('往返：普通文件 + 子目录原样还原', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'p.tgz');
  await createTarGz(tgz, [
    { name: 'package/', dir: true },
    { name: 'package/package.json', data: JSON.stringify({ name: '@wfcj/dsh-job-board' }) },
    { name: 'package/lib/a.js', data: 'export const a = 1;\n' },
  ]);
  const out = path.join(dir, 'out');
  const r = await extractTarGz(tgz, out);
  // v2.6.27（安全审计 P2）：目录条目也计入 entries 上限 ⇒ 这里 3 条（1 目录 + 2 文件）
  assert.equal(r.entries, 3);
  assert.equal(fs.readFileSync(path.join(out, 'package/package.json'), 'utf8').includes('@wfcj/dsh-job-board'), true);
  assert.equal(fs.readFileSync(path.join(out, 'package/lib/a.js'), 'utf8'), 'export const a = 1;\n');
});

test('拒绝绝对路径条目', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'abs.tgz');
  await createTarGz(tgz, [{ name: 'C:/Windows/evil.txt', data: 'x' }]);
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /绝对路径/);
});

test('拒绝 .. 段', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'dotdot.tgz');
  await createTarGz(tgz, [{ name: '../../evil.txt', data: 'x' }]);
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /可疑路径段/);
});

test('拒绝符号链接条目（typeflag=2）', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'link.tgz');
  await createTarGz(tgz, [{ name: 'package/evil', type: '2', linkname: '/etc/passwd' }]);
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /不支持的条目类型/);
});

test('拒绝校验和损坏的头', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'bad.tgz');
  await createTarGz(tgz, [{ name: 'package/a.txt', data: 'hello' }]);
  // 解开 gzip、改一个字节、再压回去 —— 头校验和必然不符
  const zlib = await import('node:zlib');
  const raw = zlib.gunzipSync(fs.readFileSync(tgz));
  raw[5] ^= 0xff;
  fs.writeFileSync(tgz, zlib.gzipSync(raw));
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /校验和不符/);
});

test('条目数超上限即失败（压缩炸弹防线）', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'many.tgz');
  const entries = [];
  for (let i = 0; i < 6; i += 1) entries.push({ name: `package/f${i}.txt`, data: 'x' });
  await createTarGz(tgz, entries);
  await assert.rejects(
    () => extractTarGz(tgz, path.join(dir, 'out'), { maxEntries: 3 }),
    /条目超过上限/,
  );
  assert.equal(TAR_LIMITS.MAX_ENTRIES > 0, true);
});

// v2.7.0（安全审计 S-14）：中段盘符 / UNC 段 / `..` 后接盘符。
test('拒绝中段盘符条目（a/C:/Windows/x）', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'middrive.tgz');
  await createTarGz(tgz, [{ name: 'a/C:/Windows/evil.txt', data: 'x' }]);
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /盘符段/);
});

test('拒绝 UNC 段条目（a/\\\\server\\share\\x）', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'unc.tgz');
  await createTarGz(tgz, [{ name: 'a/\\\\server\\share\\evil.txt', data: 'x' }]);
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /UNC|绝对化/);
});

test('拒绝 .. 后接盘符（a/../C:/x）', async () => {
  const dir = tmpDir();
  const tgz = path.join(dir, 'dotdotdrive.tgz');
  await createTarGz(tgz, [{ name: 'a/../C:/evil.txt', data: 'x' }]);
  await assert.rejects(() => extractTarGz(tgz, path.join(dir, 'out')), /盘符段|可疑路径段/);
});
