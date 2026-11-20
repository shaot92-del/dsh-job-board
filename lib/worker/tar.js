// tar.js — 极简 tar.gz 读写（只为本插件的维护升级用）。
//
// 为什么自己写：Node 没有 `node:tar` 这个内置模块（那是 npm 包 `tar` 的 API），
// 而契约禁止给插件加依赖、维护通道也不许 spawn `tar.exe`。upgrade 动词需要
// 「解开 npm pack 出来的 .tgz → 读 package.json → 装进 pkgDir」，所以这里只实现
// 够用的一个子集：ustar 头、普通文件与目录、不支持符号链接/硬链接/设备节点
// （遇到直接失败 —— 升级包不该包含它们，静默忽略等于给了个绕过点）。
//
// 安全边界（与 maint-verbs 的路径校验互补，双重保险）：
//   · 拒绝绝对路径、盘符、`..` 段、NUL；
//   · 解出来的目标路径必须落在 destDir 之内（resolve 后再比前缀）；
//   · 入口数与总字节数都设上限，压缩炸弹直接失败。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function octal(buf, start, len) {
  const raw = buf.subarray(start, start + len);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0 || raw[end - 1] === 0x20)) end -= 1;
  if (end === 0) return 0;
  const text = raw.subarray(0, end).toString('ascii').trim();
  if (!/^[0-7]+$/.test(text)) return NaN;
  return parseInt(text, 8);
}

function isZeroBlock(buf, offset) {
  for (let i = 0; i < BLOCK; i += 1) if (buf[offset + i] !== 0) return false;
  return true;
}

function tarChecksumOk(block) {
  const stored = octal(block, 148, 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === stored;
}

function decodeString(buf, start, len) {
  const raw = buf.subarray(start, start + len);
  let end = raw.indexOf(0);
  if (end < 0) end = raw.length;
  return raw.subarray(0, end).toString('utf8');
}

/** 解一个 tar 头，返回 {name, size, type, linkname} 或 null（结束） */
function parseHeader(buf, offset) {
  if (offset + BLOCK > buf.length) return null;
  if (isZeroBlock(buf, offset)) return null;
  const block = buf.subarray(offset, offset + BLOCK);
  if (!tarChecksumOk(block)) throw new Error('tar 头校验和不符（包损坏或被改写）');
  const prefix = decodeString(block, 345, 155);
  const base = decodeString(block, 0, 100);
  const name = prefix ? prefix.replace(/\/+$/, '') + '/' + base : base;
  const size = octal(block, 124, 12);
  if (!Number.isFinite(size)) throw new Error('tar 头的 size 不是八进制');
  const type = String.fromCharCode(block[156] || 0x30);
  const linkname = decodeString(block, 157, 100);
  return { name, size, type, linkname };
}

/** 把 entry 名归一并确认落在 destDir 之内；返回绝对路径 */
function safeJoin(destDir, name) {
  const raw = String(name || '');
  if (!raw) throw new Error('tar 里有空文件名');
  if (raw.includes('\0')) throw new Error('tar 文件名含 NUL');
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) throw new Error(`tar 里有绝对路径：${raw}`);
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  // v2.7.0（安全审计 S-14）：逐段拦「中段盘符 / 绝对化变体」。
  // 旧检查只看整串开头，`a/C:/Windows/x`、`a/../C:/x` 都能混过去，解包后就写到目标目录外。
  if (parts.some((p) => /^[A-Za-z]:/.test(p))) throw new Error(`tar 条目含盘符段：${raw}`);
  // UNC / 双分隔符变体（`a/\\server\share\x`、`\\\\?\\C:\\x`）：段切分会把分隔符吃掉，
  // 所以按「原串里任意位置出现连续两个分隔符」判。正常 tar 条目不会有这种形态。
  if (/[\\/]{2}/.test(raw)) throw new Error(`tar 条目含 UNC/绝对化路径段：${raw}`);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error(`tar 里有可疑路径段：${raw}`);
  const target = path.resolve(destDir, ...parts);
  const base = path.resolve(destDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`tar 条目越出目标目录：${raw}`);
  }
  return target;
}

/**
 * 解开 .tar.gz 到 destDir。
 * @param {string} file tgz 路径
 * @param {string} destDir 目标目录（不存在会创建）
 * @param {{fsImpl?: object, maxEntries?: number, maxTotalBytes?: number}} [opts]
 * @returns {Promise<{entries: number, bytes: number, files: string[]}>}
 */
export async function extractTarGz(file, destDir, opts = {}) {
  const io = opts.fsImpl || fs;
  const maxEntries = opts.maxEntries || MAX_ENTRIES;
  const maxTotalBytes = opts.maxTotalBytes || MAX_TOTAL_BYTES;
  const gz = await io.promises.readFile(file);
  const buf = zlib.gunzipSync(gz);
  await io.promises.mkdir(destDir, { recursive: true });

  let offset = 0;
  let entries = 0;
  let bytes = 0;
  const files = [];
  for (;;) {
    const head = parseHeader(buf, offset);
    if (!head) break;
    offset += BLOCK;
    const dataLen = head.size;
    if (dataLen < 0 || offset + dataLen > buf.length) throw new Error('tar 数据截断');
    const data = buf.subarray(offset, offset + dataLen);
    offset += Math.ceil(dataLen / BLOCK) * BLOCK;

    // 只收普通文件与目录：符号链接/硬链接/设备节点会让「解包」变成任意读写的跳板。
    if (head.type === '5') {
      // v2.6.27（安全审计 P2）：目录条目也要计数，否则 10 万条目录能绕过 MAX_ENTRIES。
      entries += 1;
      if (entries > maxEntries) throw new Error(`tar 条目超过上限 ${maxEntries}`);
      await io.promises.mkdir(safeJoin(destDir, head.name), { recursive: true });
      continue;
    }
    if (head.type !== '0' && head.type !== '\0') {
      throw new Error(`tar 里有不支持的条目类型 ${JSON.stringify(head.type)}（${head.name}）`);
    }
    entries += 1;
    if (entries > maxEntries) throw new Error(`tar 条目超过上限 ${maxEntries}`);
    bytes += dataLen;
    if (bytes > maxTotalBytes) throw new Error(`解包总字节超过上限 ${maxTotalBytes}`);
    const target = safeJoin(destDir, head.name);
    await io.promises.mkdir(path.dirname(target), { recursive: true });
    await io.promises.writeFile(target, data);
    files.push(head.name);
  }
  return { entries, bytes, files };
}

function writeOctal(buf, value, start, len) {
  const text = value.toString(8).padStart(len - 1, '0') + '\0';
  buf.write(text, start, len, 'ascii');
}

/**
 * 造一个 .tar.gz（只为测试/自检用：不需要 GNU 扩展）。
 * @param {string} file 输出 tgz 路径
 * @param {Array<{name: string, data?: Buffer|string, dir?: boolean}>} entries
 * @param {{fsImpl?: object}} [opts]
 */
export async function createTarGz(file, entries, opts = {}) {
  const io = opts.fsImpl || fs;
  const blocks = [];
  for (const entry of entries) {
    const name = String(entry.name || '');
    if (!name || name.length > 100) throw new Error('入口名必须 1..100 字节');
    // entry.type 只在测试里用（伪造符号链接等危险条目，验证解包器会拒绝）。
    const isDir = Boolean(entry.dir) || entry.type === '5';
    const data = isDir ? Buffer.alloc(0) : Buffer.from(entry.data == null ? '' : entry.data);
    const header = Buffer.alloc(BLOCK, 0);
    header.write(name, 0, 100, 'utf8');
    writeOctal(header, isDir ? 0o755 : 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, data.length, 124, 12);
    writeOctal(header, Math.floor(Date.now() / 1000), 136, 12);
    header.write(entry.type ? String(entry.type)[0] : isDir ? '5' : '0', 156, 1, 'ascii');
    if (entry.linkname) header.write(String(entry.linkname).slice(0, 100), 157, 100, 'utf8');
    header.write('ustar\0' + '00', 257, 8, 'ascii');
    // checksum：先把字段填成空格，再算和，最后写回（八进制 + NUL + 空格）
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);
    if (!isDir && data.length) {
      blocks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  const tarBuf = Buffer.concat(blocks);
  await io.promises.mkdir(path.dirname(file), { recursive: true });
  await io.promises.writeFile(file, zlib.gzipSync(tarBuf));
  return { file, entries: entries.length };
}

export const TAR_LIMITS = Object.freeze({ MAX_ENTRIES, MAX_TOTAL_BYTES });
