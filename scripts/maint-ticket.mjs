#!/usr/bin/env node
// 维护通道（v2.7）票据 CLI：给写动词签发一次性票据。
//
// 用法：
//   node scripts/maint-ticket.mjs keygen --out .\maint-key.json
//   node scripts/maint-ticket.mjs sign --key .\maint-key.json --payload .\goal.json --machine gt14 --ttl 600
//   node scripts/maint-ticket.mjs verify --key .\maint-key.json --goal .\goal.txt --machine gt14
//
// 约定（与 lib/worker/maint-ticket.js 保持一致）：
//   · 任务书 = 第一段单行 JSON payload + 末尾一行 `ticket=<base64url>`
//   · payloadHash = sha256(payload 文本，去 ticket 行、去尾部空行) 的十六进制
//   · 票据字段：v / taskId / machine / verb / payloadHash / notBefore / notAfter / nonce
//   · 私钥只留在主控机；副机 profile 里只放公钥（worker.maintAuthPublicKeys）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  MAINT_TICKET_VERSION,
  canonicalTicketJson,
  exportPublicSpkiB64,
  importPublicSpki,
  generateEd25519KeyPair,
  payloadSha256,
  signTicket,
  verifySignature,
} from '../lib/worker/maint-ticket.js';

const TICKET_LINE = /^ticket=([A-Za-z0-9_-]+)\s*$/;

/** 把任务书拆成 payload 文本与票据串；没有票据行时 ticket 为 null。 */
export function splitGoal(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (last < 0) return { ok: false, error: 'goal 为空' };
  const m = TICKET_LINE.exec(lines[last].trim());
  if (!m) return { ok: false, error: '末尾没有 ticket= 行' };
  const payloadText = lines.slice(0, last).join('\n').trimEnd();
  if (!payloadText) return { ok: false, error: 'ticket= 之前没有 payload' };
  return { ok: true, payloadText, ticket: m[1] };
}

export function keygen({ out }) {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  const privateKeyB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const publicKeyB64 = exportPublicSpkiB64(publicKey);
  const body = { version: MAINT_TICKET_VERSION, privateKeyB64, publicKeyB64 };
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }
  return body;
}

function loadPrivateKey(keyFile) {
  const raw = fs.readFileSync(keyFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.privateKeyB64) throw new Error('key 文件里没有 privateKeyB64');
  return crypto.createPrivateKey({ key: Buffer.from(parsed.privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
}

export function loadPublicKeyB64(keyFile) {
  const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (!parsed.publicKeyB64) throw new Error('key 文件里没有 publicKeyB64');
  return parsed.publicKeyB64;
}

/** 允许的时钟偏差：签发时把 notBefore 往前放这么多毫秒（只放宽生效，不放宽过期）。 */
export const CLOCK_SKEW_MS = 60_000;

/**
 * 签一张票据并把整份任务书返回来。
 *
 * `notBefore` 往前放 60 秒：主控与副机是两台机器，时钟差个几秒是常态；
 * 如果按「签发这一刻」当 notBefore，副机时钟稍慢就会把刚签的票判成 expired
 * （而且提示语会是「过期」，看起来像 TTL 配错了，极难排查）。往前的这 60 秒
 * 只放宽「还没到生效时间」，不延长 notAfter —— 有效期不被放大。
 * @param {{keyFile:string,payloadText:string,machine:string,verb:string,taskId?:string,ttlSec?:number,now?:number}} opts
 */
export function signGoal(opts) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttlSec = Number.isFinite(opts.ttlSec) ? Number(opts.ttlSec) : 600;
  const ttl = Math.max(30, Math.min(3600, ttlSec));
  const fields = {
    v: MAINT_TICKET_VERSION,
    taskId: String(opts.taskId || `maint-${now.toString(36)}`),
    machine: String(opts.machine || '').trim(),
    verb: String(opts.verb || '').trim(),
    payloadHash: payloadSha256(opts.payloadText),
    notBefore: now - CLOCK_SKEW_MS,
    notAfter: now + ttl * 1000,
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  if (!fields.machine) throw new Error('缺 --machine');
  if (!fields.verb) throw new Error('缺 --verb');
  const ticket = signTicket(fields, loadPrivateKey(opts.keyFile));
  const b64 = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
  return { fields, ticket, goalText: `${opts.payloadText}\nticket=${b64}` };
}

/** 本地校验一份任务书（不写 nonce、只看签名/机器/时间/payload）。 */
export function verifyGoal(opts) {
  const split = splitGoal(opts.goalText);
  if (!split.ok) return { ok: false, error: split.error };
  let ticket;
  try {
    ticket = JSON.parse(Buffer.from(split.ticket, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'ticket 不是合法 base64url JSON' };
  }
  const publicKeyB64 = opts.publicKeyB64 || loadPublicKeyB64(opts.keyFile);
  if (!verifySignature(ticket, importPublicSpki(publicKeyB64))) return { ok: false, error: 'badsig' };
  if (Number(ticket.v) !== MAINT_TICKET_VERSION) return { ok: false, error: '版本不符' };
  if (String(ticket.machine || '').toLowerCase() !== String(opts.machine || '').toLowerCase()) {
    return { ok: false, error: 'wrongmachine' };
  }
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (now < Number(ticket.notBefore) || now > Number(ticket.notAfter)) return { ok: false, error: 'expired' };
  if (String(ticket.payloadHash) !== payloadSha256(split.payloadText)) return { ok: false, error: 'payload-mismatch' };
  return { ok: true, ticket, payloadText: split.payloadText, canonical: canonicalTicketJson(ticket) };
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : 'true';
      args[key] = val;
      if (val !== 'true') i += 1;
    }
  }
  if (cmd === 'keygen') {
    const body = keygen({ out: args.out });
    process.stdout.write(`publicKeyB64: ${body.publicKeyB64}\n`);
    if (args.out) process.stdout.write(`已写 ${args.out}（私钥只留在主控机）\n`);
    return 0;
  }
  if (cmd === 'sign') {
    const payloadText = args.payload
      ? fs.readFileSync(args.payload, 'utf8').replace(/\r\n/g, '\n').trim()
      : String(args.text || '').trim();
    if (!payloadText) {
      process.stderr.write('缺 --payload <文件> 或 --text <单行 JSON>\n');
      return 2;
    }
    const payload = JSON.parse(payloadText);
    const { goalText, fields } = signGoal({
      keyFile: args.key,
      payloadText,
      machine: args.machine,
      verb: payload.verb,
      taskId: args['task-id'],
      ttlSec: args.ttl ? Number(args.ttl) : 600,
    });
    if (args.out) fs.writeFileSync(args.out, `${goalText}\n`, 'utf8');
    process.stdout.write(`${goalText}\n`);
    process.stderr.write(
      `\n[ticket] task=${fields.taskId} machine=${fields.machine} verb=${fields.verb} ` +
        `window=${new Date(fields.notBefore).toISOString()}..${new Date(fields.notAfter).toISOString()}\n`,
    );
    return 0;
  }
  if (cmd === 'verify') {
    const goalText = fs.readFileSync(args.goal, 'utf8');
    const r = verifyGoal({ goalText, keyFile: args.key, machine: args.machine });
    process.stdout.write(`${JSON.stringify(r.ok ? { ok: true, ticket: r.ticket } : r, null, 2)}\n`);
    return r.ok ? 0 : 1;
  }
  process.stdout.write(
    [
      '用法：',
      '  node scripts/maint-ticket.mjs keygen --out .\\maint-key.json',
      '  node scripts/maint-ticket.mjs sign --key .\\maint-key.json --payload .\\goal.json --machine gt14 --ttl 600 [--out goal.txt]',
      '  node scripts/maint-ticket.mjs verify --key .\\maint-key.json --goal .\\goal.txt --machine gt14',
      '',
      'goal.json 示例：{"verb":"config-set","set":{"agentApproval":"auto"}}',
    ].join('\n') + '\n',
  );
  return cmd ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = main();
}
