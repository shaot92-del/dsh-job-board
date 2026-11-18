// maint-ticket — 一次性写授权票据（v2.7 维护写通道的签名授权）。
//
// 背景：副机维护通道原来只有只读动词（version/status/config/logs），写动作
// （升级 / 重启 / 改配置）需要「签名一次性授权」—— 一张由主控签发、副机验签
// 后才放行的票据。本模块就是这张票据的签发与校验，是 A1 交付物。
//
// 安全约束（与 maintenance.js 同源，是这个通道「为什么安全」的全部理由）：
//   · 不 spawn 任何子进程（本文件不 import child_process，写动作也不许用命令拼串）；
//   · 不读任意路径：used-nonce 集合的落点由 stateDir 配置常量决定，不是任务书文本；
//   · 公钥是配置里的常量数组，不从任务书取，支持轮换（命中任一即通过）；
//   · sig / 公钥 / nonce 不进 note / result / 日志 —— 本模块不写日志，只返回 reason 常量。
//
// 票据形态（JSON，base64url 放进任务书 goal 的同级字段 ticket）：
//   { v:1, taskId, machine, verb, payloadHash, notBefore, notAfter, nonce, sig }
// sig = base64url( ed25519 签 over 上面 8 字段的规范化 JSON（键字典序、无 sig） )
//
// 校验 9 步序（任一步失败都返回 status:'blocked' + reason 常量，由 A2 的 maintenance.js
// 接力成板子结果）：1 配置关 → 2 无票/解析失败 → 3 公钥空 → 4 验签失败 → 5 错机器
// → 6 过期 → 7 重放 → 8 payload 不符 → 9 通过（调用方 recordNonce 后再执行写动作）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAINT_TICKET_VERSION = 1;

/** 校验失败的 reason 常量（与 maintenance.js 的 reason 同风格，板子侧按这些字符串分流） */
export const MAINT_TICKET_REASONS = Object.freeze({
  DISABLED: 'maint-write-disabled',
  INVALID: 'maint-ticket-invalid',
  UNTRUSTED: 'maint-ticket-untrusted',
  BADSIG: 'maint-ticket-badsig',
  WRONGMACHINE: 'maint-ticket-wrongmachine',
  EXPIRED: 'maint-ticket-expired',
  REPLAYED: 'maint-ticket-replayed',
  PAYLOAD_MISMATCH: 'maint-ticket-payload-mismatch',
});

/** 参与签名的字段（顺序无关，规范化时按字典序重排） */
const SIGNED_FIELDS = ['v', 'taskId', 'machine', 'verb', 'payloadHash', 'notBefore', 'notAfter', 'nonce'];
/** 字典序（lexicographic）—— 这是 canonical JSON 的键序，sign 与 verify 的同一消息 */
const CANONICAL_KEYS = [...SIGNED_FIELDS].sort();

export const USED_NONCES_FILE = 'maint-used-nonces.json';
/** 已用 nonce 集合上限：FIFO 淘汰，防 stateDir 无限增长 */
export const MAX_USED_NONCES = 1000;
/** nonce 最小长度（契约：16+ 字符随机） */
export const MIN_NONCE_LEN = 16;

// ── base64url 工具 ───────────────────────────────────────────────────────

function toBase64Url(buf) {
  return buf.toString('base64url');
}
function fromBase64Url(s) {
  return Buffer.from(String(s), 'base64url');
}

// ── 规范化 JSON（签名 / 验签的同一消息） ─────────────────────────────────

/**
 * 票据 8 个签名字段的规范化 JSON：键字典序、无 sig、无 whitespace。
 * 这是 sign 与 verify 的同一消息 —— 两边必须算出完全相同的字符串。
 * @param {object} ticket
 * @returns {string}
 */
export function canonicalTicketJson(ticket) {
  const obj = {};
  for (const k of CANONICAL_KEYS) {
    if (ticket[k] !== undefined) obj[k] = ticket[k];
  }
  return JSON.stringify(obj);
}

// ── 密钥导入 / 导出 / 生成 ───────────────────────────────────────────────

/**
 * 把配置里的 base64 SPKI 公钥还原成 KeyObject（ed25519）。
 * @param {string} b64spki
 * @returns {crypto.KeyObject}
 */
export function importPublicSpki(b64spki) {
  return crypto.createPublicKey({ key: Buffer.from(b64spki, 'base64'), format: 'der', type: 'spki' });
}

/**
 * 把 KeyObject 公钥导出成 base64 SPKI（放进 config.maintAuthPublicKeys 的形态）。
 * @param {crypto.KeyObject} publicKey
 * @returns {string}
 */
export function exportPublicSpkiB64(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

/** 生成 ed25519 密钥对（签发方用） */
export function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

// ── 签发 ─────────────────────────────────────────────────────────────────

/**
 * 签发一张票据。
 * @param {{v:number, taskId:string, machine:string, verb:string, payloadHash:string, notBefore:number, notAfter:number, nonce:string}} fields
 * @param {crypto.KeyObject} privateKey ed25519 私钥
 * @returns {object} 带 sig（base64url）的票据
 */
export function signTicket(fields, privateKey) {
  const ticket = { ...fields };
  const msg = Buffer.from(canonicalTicketJson(ticket), 'utf8');
  const sig = crypto.sign(null, msg, privateKey);
  ticket.sig = toBase64Url(sig);
  return ticket;
}

// ── 验签 ─────────────────────────────────────────────────────────────────

/**
 * 单张票据对单个公钥验签。
 * @param {object} ticket
 * @param {crypto.KeyObject} publicKey
 * @returns {boolean}
 */
export function verifySignature(ticket, publicKey) {
  const msg = Buffer.from(canonicalTicketJson(ticket), 'utf8');
  let sig;
  try {
    sig = fromBase64Url(ticket.sig);
  } catch {
    return false;
  }
  try {
    return crypto.verify(null, msg, publicKey, sig);
  } catch {
    return false;
  }
}

/** 对公钥数组逐一验签，命中任一即通过（支持轮换） */
function verifyAny(ticket, keys) {
  for (const b64 of keys) {
    try {
      const pub = importPublicSpki(b64);
      if (verifySignature(ticket, pub)) return true;
    } catch {
      // 某个公钥解析失败不致命 —— 轮换期可能混入旧格式，继续试下一个
    }
  }
  return false;
}

// ── payload 哈希 ──────────────────────────────────────────────────────────

/**
 * 任务书 payload 的 sha256 hex（与票据 payloadHash 比对）。
 * @param {string|Buffer} payload
 * @returns {string}
 */
export function payloadSha256(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── 已用 nonce 集合（落盘，跨进程） ──────────────────────────────────────

/**
 * 读回已用 nonce 集合。文件缺失 / 损坏一律返回 []（不抛 —— 维护通道的价值是
 * 尽量给点信息，不能因为状态文件坏了就整条写通道崩掉）。
 * @param {string} stateDir
 * @param {{fs?: object}} [opts]
 * @returns {string[]}
 */
export function readUsedNonces(stateDir, opts = {}) {
  const fsImpl = opts.fs || fs;
  const dir = String(stateDir || '').trim();
  if (!dir) return [];
  const file = path.join(dir, USED_NONCES_FILE);
  try {
    const text = fsImpl.readFileSync(file, 'utf8');
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 同步短睡眠（只用于 rename 退避，几十毫秒） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* 兜底自旋 */
    }
  }
}

/**
 * 原子写：同目录临时文件（带 pid，避免多实例互相踩）→ rename 覆盖。
 * 与 state-file.mjs 的 writeStateJson 同构 —— 这里不 import 它，保持本模块
 * 自洽，且 fs 可注入以便单测用假 fs 断言落盘内容。
 */
function atomicWriteJson(file, value, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const waits = [20, 50, 100];
  let lastErr = null;
  for (let i = 0; i <= waits.length; i += 1) {
    try {
      fsImpl.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (i < waits.length) sleepSync(waits[i]);
    }
  }
  try {
    fsImpl.rmSync(tmp, { force: true });
  } catch {
    /* 临时文件清不掉不影响主流程 */
  }
  throw lastErr || new Error('rename failed');
}

/**
 * 把 nonce 写进已用集合（步骤 9）。读回 → 追加 → FIFO 淘汰到上限 → 原子写。
 * @param {string} nonce
 * @param {string} stateDir
 * @param {{fs?: object}} [opts]
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function recordNonce(nonce, stateDir, opts = {}) {
  const fsImpl = opts.fs || fs;
  const dir = String(stateDir || '').trim();
  if (!dir) return { ok: false, error: 'stateDir 为空' };
  const file = path.join(dir, USED_NONCES_FILE);
  const list = readUsedNonces(dir, { fs: fsImpl });
  const n = String(nonce);
  // 集合语义：已存在不重复追加（防 A2 重试 / 抖动把 1000 条预算刷满，也保「集合」不退化成「列表」）
  if (!list.includes(n)) list.push(n);
  while (list.length > MAX_USED_NONCES) list.shift();
  try {
    atomicWriteJson(file, list, fsImpl);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  return { ok: true };
}

// ── 票据解码（任务书的 ticket 字段 → 对象） ────────────────────────────────

/**
 * 把任务书里的 ticket 字段（base64url JSON，或直接 JSON）解析成对象。
 * 解析失败返回 null。
 * @param {string} raw
 * @returns {object|null}
 */
function decodeTicketString(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  // 先按 base64url 解码再 JSON.parse（契约形态）
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    /* 不是 base64url JSON */
  }
  // 再按直接 JSON 解析（测试 / 调试形态）
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    /* 不是 JSON */
  }
  return null;
}

// ── 主校验（9 步顺序，任一步失败都返回 status:blocked + reason 常量） ─────

/**
 * 校验一张票据（步骤 1-8）。通过后由调用方 recordNonce 再执行写动作。
 *
 * @param {string|object} rawTicket 任务书 ticket 字段（base64url 串 / JSON 串 / 已解析对象）
 * @param {object} ctx
 * @param {object} ctx.config 归一化配置（maintenanceEnabled / maintAuthPublicKeys / machine）
 * @param {string|Buffer} ctx.payload 任务书 payload（goal 原文，算 sha256 比对）
 * @param {string} ctx.stateDir 已用 nonce 落盘目录
 * @param {Function} [ctx.now] 当前时间 ms（可注入，测过期）
 * @param {object} [ctx.fs] fs 实现（可注入，测落盘）
 * @returns {{ok: true, status: 'ok', reason: 'ok', ticket: object} | {ok: false, status: 'blocked', reason: string}}
 */
export function checkTicket(rawTicket, ctx) {
  const config = ctx.config || {};
  const stateDir = ctx.stateDir || '';
  const fsImpl = ctx.fs || fs;
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : Date.now();

  // 步骤 1：配置未开
  if (config.maintenanceEnabled === false) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.DISABLED };
  }

  // 步骤 2：无票据 / 解析失败
  let ticket = rawTicket;
  if (typeof rawTicket === 'string') {
    ticket = decodeTicketString(rawTicket);
  }
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.INVALID };
  }

  // 步骤 3：公钥列表为空
  const keys = Array.isArray(config.maintAuthPublicKeys) ? config.maintAuthPublicKeys : [];
  if (keys.length === 0) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.UNTRUSTED };
  }

  // 步骤 4：验签失败
  if (!verifyAny(ticket, keys)) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.BADSIG };
  }

  // 步骤 5：machine 不一致（大小写不敏感）
  const ticketMachine = String(ticket.machine || '').trim().toLowerCase();
  const localMachine = String(config.machine || '').trim().toLowerCase();
  if (ticketMachine !== localMachine) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.WRONGMACHINE };
  }

  // 步骤 6：当前时间不在 [notBefore, notAfter]
  const notBefore = Number(ticket.notBefore);
  const notAfter = Number(ticket.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || nowMs < notBefore || nowMs > notAfter) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.EXPIRED };
  }

  // 步骤 7：nonce 已用（从磁盘读回，新进程也看得到）
  const nonce = String(ticket.nonce || '');
  if (readUsedNonces(stateDir, { fs: fsImpl }).includes(nonce)) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.REPLAYED };
  }

  // 步骤 8：payloadHash 不符
  const expected = payloadSha256(ctx.payload);
  if (String(ticket.payloadHash || '').toLowerCase() !== String(expected).toLowerCase()) {
    return { ok: false, status: 'blocked', reason: MAINT_TICKET_REASONS.PAYLOAD_MISMATCH };
  }

  // 步骤 9：通过 —— 由调用方 recordNonce 后再执行写动作
  return { ok: true, status: 'ok', reason: 'ok', ticket };
}
