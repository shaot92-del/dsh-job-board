// maint-verbs — 维护通道写动词（v2.7 维护写通道的执行层）。
//
// 背景：A1（maint-ticket.js）提供了「一次性写授权票据」的签发/校验/重放防护，
// 本文件是 A2 —— 三个写动词（upgrade / config-set / restart）的「检查 + 执行」层。
//
// 顺序约束（契约 §4，盘古 P2-6 的正解）：本模块的 run() 只做「检查 + 执行」，
// **不负责记 nonce**。nonce 落盘（recordNonce）由调用方在 run() 之前完成——
// 先落盘，再执行；崩了也只是票据被烧掉，不会重放。
//
// 安全约束（与 maintenance.js / maint-ticket.js 同源）：
//   · 不 import child_process（restart 走注入的 spawnImpl，生产实现由调用方注入）；
//   · 不联网、不读 payload 指定路径（upgrade 的 file 只取文件名，基准目录是
//     config.maintenancePkgDir 配置常量，不是任务书文本）；
//   · 票据内容（sig/公钥/nonce）不进 note/日志 —— 本模块只 reason 常量 + 具体
//     原因描述（如「hash 不符」），不含任何票据字段；
//   · 不放宽既有闸门（exec 白名单、agent 白名单、只读通道动词表）—— 本模块是
//     维护写通道的独立层，不碰那些表。
//
// 契约：_a2-contract.md（主控定，本文件严格遵循）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { extractTarGz } from './tar.js';

export const WRITE_VERBS = Object.freeze(['upgrade', 'config-set', 'restart']);

/** 写动词的 reason 常量（契约 §5，全部以 maint- 开头） */
export const MAINT_VERB_REASONS = Object.freeze({
  PAYLOAD_INVALID: 'maint-payload-invalid',
  VERB_UNKNOWN: 'maint-verb-unknown',
  PKG_MISSING: 'maint-pkg-missing',
  PKG_OUTSIDE: 'maint-pkg-outside',
  PKG_HASH: 'maint-pkg-hash',
  PKG_NAME: 'maint-pkg-name',
  INSTALL_FAILED: 'maint-install-failed',
  CONFIG_KEY_DENIED: 'maint-config-key-denied',
  CONFIG_INVALID: 'maint-config-invalid',
  CONFIG_WRITE_FAILED: 'maint-config-write-failed',
  RESTART_DISABLED: 'maint-restart-disabled',
  RESTART_PATH: 'maint-restart-path',
  SPAWN_FAILED: 'maint-spawn-failed',
});

/** note 上限：与 maintenance.js 的 NOTE_MAX 同量级（worker 还要加前缀，总 480） */
const NOTE_BUDGET = 400;

/**
 * v2.7.0（安全审计 C-17）：数字型配置值的统一格式。
 * 整数用 String(Math.trunc(n))（20 不会写成 020，1e2 也不会写成 1e+2）；
 * 非整数保留原值；NaN/Infinity/非 number 一律返回 null —— 调用方按
 * maint-config-invalid 处理，绝不把 Infinity 写进 cordis.patch.yml。
 */
export function formatNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(Math.trunc(n)) : String(n);
}

/** 单行化 + 截断（与 maintenance.js 的 oneLine 同构，自实现保持模块自洽） */
function oneLine(text, max = NOTE_BUDGET) {
  const t = String(text ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/** 时间戳 yyyyMMdd-HHmmss（备份目录/文件名用） */
function stamp(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 路径是否在根内（realpath 后，按分隔符边界，大小写不敏感） */
function isWithin(child, parent) {
  const c = String(child || '').replace(/\\+$/, '').toLowerCase();
  const p = String(parent || '').replace(/\\+$/, '').toLowerCase();
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p + '\\');
}

/** 真实路径（解析 symlink/junction；目标不存在时从最近已存在祖先拼回） */
function realPath(p, fsImpl) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fsImpl.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** sha256 hex */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── 1. 任务书解析（契约 §1）────────────────────────────────────────────

/**
 * 解析写动词任务书。
 * 格式：第一段单行 JSON + 第二行 `ticket=<base64url>`。
 * @param {string} raw 任务书 goal 文本
 * @returns {{ok: true, payloadText: string, payload: object, ticket: string} | {ok: false, error: string}}
 */
export function parseWriteGoal(raw) {
  const text = String(raw ?? '');
  const lines = text.split(/\r?\n/);
  // 找最后一条非空行，若以 ticket= 开头 → 票据行
  let ticketLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].trim().startsWith('ticket=')) ticketLineIdx = i;
    break;
  }
  // 没有 ticket 行 → 不是写动词请求（走原有只读逻辑）
  if (ticketLineIdx < 0) return { ok: false, error: 'maint-no-ticket' };
  // payload 行 = 票据行之前的所有行，去掉末尾空行（不 trim 内部空白）
  const payloadLines = lines.slice(0, ticketLineIdx);
  while (payloadLines.length && payloadLines[payloadLines.length - 1].trim() === '') payloadLines.pop();
  const payloadText = payloadLines.join('\n');
  // payload 必须原样 JSON 解析（不 trim 内部空白、不重新序列化）
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { ok: false, error: MAINT_VERB_REASONS.PAYLOAD_INVALID };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: MAINT_VERB_REASONS.PAYLOAD_INVALID };
  }
  // verb 校验
  const verb = String(payload.verb || '').trim().toLowerCase();
  if (!verb || !WRITE_VERBS.includes(verb)) {
    return { ok: false, error: MAINT_VERB_REASONS.VERB_UNKNOWN };
  }
  const ticket = lines[ticketLineIdx].trim().slice('ticket='.length).trim();
  return { ok: true, payloadText, payload, ticket };
}

// ── 2. 写动词执行层 ─────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object} opts.config 归一化配置（含 maintenancePkgDir / maintenanceAllowRestart / dshExePath / stateDir / pwshPath / machine）
 * @param {object} [opts.log] 日志（只记 reason 级，不含票据内容）
 * @param {Function} [opts.now] 当前时间 ms
 * @param {object} [opts.fs] fs 实现（注入测试）
 * @param {Function} [opts.spawnImpl] spawn 实现（restart 用，注入测试）
 * @param {string} opts.pkgDir 插件自己的安装目录（调用方用 fileURLToPath 推）
 * @param {string} opts.profileDir DSH profile 目录（cordis.patch.yml 所在处）
 */
export function createMaintVerbs(opts = {}) {
  const config = opts.config || {};
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fsImpl = opts.fs || fs;
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : null;
  // v2.6.20 集成修正：这两项目录既支持显式传参，也支持从归一化配置里取（配置层本来
  // 就有 profileDir / pkgDir 字段）。只认 opts 会让「调用方按契约从 config 取」悄悄退化成
  // 相对路径 —— 后果是 config-set 去改 cwd 下的 cordis.patch.yml（读到了就别处报错，读不到
  // 就 ENOENT），upgrade 把包装进错误的目录。
  const pkgDir = String(opts.pkgDir || config.pkgDir || '').trim();
  const profileDir = String(opts.profileDir || config.profileDir || '').trim();

  function supported(verb) {
    return WRITE_VERBS.includes(verb);
  }

  function blocked(reason, note) {
    return { ok: false, status: 'blocked', reason, note: oneLine(note) };
  }

  function done(reason, note, extra = {}) {
    return { ok: true, status: 'done', reason, note: oneLine(note), ...extra };
  }

  // v2.7.8：远程升级在 DSH 运行时必须「先停 DSH 再换名」，否则 Windows 报 EPERM。
  // 这个许可（maintenanceAllowRestart + dshExePath）刻意不在远程可写白名单里 ——
  // 否则一张票据就能把副机的重启能力开出去。
  function restartAllowed() {
    if (config.maintenanceAllowRestart !== true) return false;
    const exe = String(config.dshExePath || '').trim();
    if (!exe) return false;
    try { return fsImpl.existsSync(exe); } catch { return false; }
  }

  function psQuoteStr(v) {
    return "'" + String(v).replace(/'/g, "''") + "'";
  }

  /** 排入「停 DSH → 换包 → 拉起」的 detached 脚本（staging 已在同卷，rename 是原子的）。 */
  // v2.7.11：重启助手脚本统一构造。
  // 旧实现只按 pid 杀，真机实测 Stop-Process 会被拒（权限/父子关系）→ 静默失败、DSH 没重启。
  // 现在先按可执行文件路径枚举（同 exe 的所有进程），再把 pid 作为兜底；全过程写日志便于取证。
  function buildRestartScript({ delayMs, dshExe, pid, moveFrom, moveTo }) {
    const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = Join-Path $env:TEMP 'dsh-maint-restart.log'`,
      `function L($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }`,
      `L 'helper start pid=${pid} delay=${delayMs}'`,
      `Start-Sleep -Milliseconds ${delayMs}`,
      `$target = ${q(dshExe)}`,
      `$killed = 0`,
      `foreach ($p in (Get-Process)) { $pp = $null; try { $pp = $p.Path } catch {}; if ($pp -and ($pp -eq $target)) { L ("kill path pid=" + $p.Id); try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed++ } catch { L ("kill path failed: " + $_.Exception.Message) } } }`,
      `if ($killed -eq 0) { L 'path match none, fallback pid'; try { Stop-Process -Id ${pid} -Force -ErrorAction Stop; $killed = 1; L 'fallback killed' } catch { L ("fallback failed: " + $_.Exception.Message) } }`,
      `Start-Sleep -Seconds 2`,
    ];
    if (moveFrom && moveTo) {
      lines.push(`L "swap ${q(moveFrom)} -> ${q(moveTo)}"`);
      lines.push(`Remove-Item -LiteralPath ${q(moveTo)} -Recurse -Force`);
      lines.push(`Move-Item -LiteralPath ${q(moveFrom)} -Destination ${q(moveTo)} -Force`);
    }
    lines.push(`L ("start " + $target)`);
    lines.push(`Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target)`);
    lines.push(`L 'done'`);
    return lines.filter(Boolean).join('; ');
  }
  // v2.7.10：只重启（包已换好，不需要再动目录）。
  function queueRestartOnly({ dshExe }) {
    if (!spawnImpl) return { ok: false, note: 'restart: spawnImpl 未注入（不能排入重启）' };
    const delayMs = 6000;
    const pid = Number(process.pid) || 0;
    const script = buildRestartScript({ delayMs, dshExe, pid });
    const pwsh = String(config.pwshPath || '').trim() || 'pwsh.exe';
    try {
      spawnImpl(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      return { ok: true, delayMs };
    } catch (err) {
      return { ok: false, note: `restart: 排入失败（${(err && err.message) || err}）` };
    }
  }

  function queueInstallThenRestart({ stageDir, installDir, dshExe }) {
    if (!spawnImpl) return { ok: false, note: 'upgrade: spawnImpl 未注入（不能排入安装）' };
    const delayMs = 6000;
    const pid = Number(process.pid) || 0;
    const script = buildRestartScript({ delayMs, dshExe, pid, moveFrom: stageDir, moveTo: installDir });
    const pwsh = String(config.pwshPath || '').trim() || 'pwsh.exe';
    try {
      spawnImpl(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      return { ok: true, delayMs };
    } catch (err) {
      return { ok: false, note: `upgrade: 排入安装失败（${(err && err.message) || err}）` };
    }
  }
  // ── 3.1 upgrade（async：解包用 node:tar，await）──────────────────────

  async function runUpgrade(payload) {
    // 1. file 只取文件名（拒绝含路径分隔符 / ..）
    const rawFile = String(payload.file || '').trim();
    if (!rawFile) return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, 'upgrade: file 必填');
    if (/[\\/]/.test(rawFile)) {
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: file 含路径分隔符（${rawFile}）`);
    }
    const segs = rawFile.split(/[\\/]+/);
    if (segs.includes('..') || segs.includes('.')) {
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, 'upgrade: file 含 .. 或 . 段');
    }
    const fileName = path.basename(rawFile);
    if (!fileName || fileName !== rawFile) {
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, 'upgrade: file 必须是纯文件名');
    }
    // 基准目录 = config.maintenancePkgDir（不从任务书取路径）
    const pkgDirCfg = String(config.maintenancePkgDir || '').trim();
    if (!pkgDirCfg) return blocked(MAINT_VERB_REASONS.PKG_MISSING, 'upgrade: maintenancePkgDir 未配置');
    if (!path.isAbsolute(pkgDirCfg)) return blocked(MAINT_VERB_REASONS.PKG_MISSING, 'upgrade: maintenancePkgDir 非绝对路径');
    // 2. realpath 后必须仍在 pkgDir 内
    // realPath 对「不存在的路径」会退回 resolve 后的字面量（它不是 stat），所以必须
    // 显式确认目录真的在 —— 否则后面读包文件才 ENOENT，报成 install-failed 掩盖了
    // 真正的原因（配置指错目录）。
    let pkgDirExists = false;
    try { pkgDirExists = fsImpl.statSync(pkgDirCfg).isDirectory(); } catch { pkgDirExists = false; }
    if (!pkgDirExists) {
      return blocked(MAINT_VERB_REASONS.PKG_MISSING, `upgrade: maintenancePkgDir 不存在或不是目录（${pkgDirCfg}）`);
    }
    let realPkgDir;
    try {
      realPkgDir = realPath(pkgDirCfg, fsImpl);
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.PKG_MISSING, `upgrade: maintenancePkgDir 不可解析（${(err && err.code) || err}）`);
    }
    const srcPath = path.join(pkgDirCfg, fileName);
    let realSrc;
    try {
      realSrc = realPath(srcPath, fsImpl);
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.PKG_OUTSIDE, `upgrade: 包文件不可解析（${(err && err.code) || err}）`);
    }
    if (!isWithin(realSrc, realPkgDir)) {
      return blocked(MAINT_VERB_REASONS.PKG_OUTSIDE, 'upgrade: 包文件不在 maintenancePkgDir 内');
    }
    // 3. sha256 校验
    const expectedHash = String(payload.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      return blocked(MAINT_VERB_REASONS.PKG_HASH, 'upgrade: sha256 不是 64 位 hex');
    }
    let fileBuf;
    try {
      fileBuf = fsImpl.readFileSync(realSrc);
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: 包文件读不到（${(err && err.code) || err}）`);
    }
    const actualHash = sha256Hex(fileBuf);
    if (actualHash !== expectedHash) {
      return blocked(MAINT_VERB_REASONS.PKG_HASH, `upgrade: sha256 不符（期望 ${expectedHash.slice(0, 12)}…，实际 ${actualHash.slice(0, 12)}…）`);
    }
    // 4. 解包到临时目录，读 package.json（tgz 用 node:tar，不 spawn、不 shell 拼接）
    const isTgz = /\.(tgz|tar\.gz)$/i.test(fileName);
    if (!isTgz) {
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: 只接受 .tgz（${fileName}）；zip 解包需 spawn，本通道不许 spawn`);
    }
    let tmpDir;
    try {
      tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'maint-upgrade-'));
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: 临时目录建失败（${(err && err.code) || err}）`);
    }
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { fsImpl.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    try {
      // Node 没有内置 node:tar：用 lib/worker/tar.js 的极简解包器（不 spawn、无依赖，
      // 自带路径校验与条目/字节上限；符号链接等非普通条目一律拒绝）。
      await extractTarGz(String(realSrc), tmpDir, { fsImpl });
    } catch (err) {
      cleanup();
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: 解包失败（${(err && err.message) || err}）`);
    }
    // 找 package.json（npm pack 的 tgz 顶层是 package/，也可能直接在根）
    let pkgJsonPath = path.join(tmpDir, 'package.json');
    if (!fsImpl.existsSync(pkgJsonPath)) {
      pkgJsonPath = path.join(tmpDir, 'package', 'package.json');
    }
    if (!fsImpl.existsSync(pkgJsonPath)) {
      cleanup();
      return blocked(MAINT_VERB_REASONS.PKG_NAME, 'upgrade: tgz 内找不到 package.json');
    }
    let pkgJson;
    try {
      pkgJson = JSON.parse(fsImpl.readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      cleanup();
      return blocked(MAINT_VERB_REASONS.PKG_NAME, `upgrade: package.json 解析失败（${(err && err.message) || err}）`);
    }
    if (!pkgJson || typeof pkgJson !== 'object' || pkgJson.name !== '@wfcj/dsh-job-board') {
      cleanup();
      return blocked(MAINT_VERB_REASONS.PKG_NAME, `upgrade: 包名不是 @wfcj/dsh-job-board（${pkgJson && pkgJson.name}）`);
    }
    const newVersion = String(pkgJson.version || '?');
    // 5. v2.7.8：先落 staging（新目录没有文件锁，DSH 在跑也写得进去），再原子换名。
    //    旧实现在 DSH 运行时直接 rename/cp pkgDir ⇒ Windows 报 EPERM（远程升级永远失败）。
    //    允许重启时（maintenanceAllowRestart=true + dshExePath 存在）改为「排入安装 →
    //    停 DSH → 换名 → 自动拉起」；不允许则给出可操作的报错，不再只丢一个 EPERM。
    const srcRoot = path.dirname(pkgJsonPath);
    // v2.7.9：安装目标必须是**插件自身目录**（config.pkgDir），不是放 tgz 的 maintenancePkgDir。
    // 旧实现把 tgz 目录当成安装目标（等于要覆盖共享盘上的包目录），真机必然 EPERM。
    if (!pkgDir || !path.isAbsolute(pkgDir)) {
      cleanup();
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, 'upgrade: 拿不到插件安装目录（config.pkgDir 为空或非绝对路径）');
    }
    const stageDir = `${pkgDir}.stage-${stamp(now())}`;
    const backup = `${pkgDir}.bak-${stamp(now())}`;
    try {
      try { fsImpl.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
      fsImpl.mkdirSync(stageDir, { recursive: true });
      fsImpl.cpSync(srcRoot, stageDir, { recursive: true });
    } catch (err) {
      cleanup();
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: 暂存失败（${(err && err.code) || err}）`);
    }

    const swapIn = () => {
      if (fsImpl.existsSync(pkgDir)) {
        try { fsImpl.rmSync(backup, { recursive: true, force: true }); } catch { /* 旧备份 */ }
        fsImpl.renameSync(pkgDir, backup);
      }
      fsImpl.renameSync(stageDir, pkgDir);
    };

    try {
      swapIn();
    } catch (err) {
      const code = String((err && err.code) || '');
      // 回滚：把 backup 改回目标（stage 留着，下面视情况清理或交给重启助手）
      try {
        if (fsImpl.existsSync(backup) && !fsImpl.existsSync(pkgDir)) fsImpl.renameSync(backup, pkgDir);
      } catch { /* ignore */ }
      const locked = /EPERM|EACCES|EBUSY/.test(code);
      if (locked && restartAllowed()) {
        const q = queueInstallThenRestart({ stageDir, installDir: pkgDir, dshExe: String(config.dshExePath || '').trim() });
        cleanup();
        if (!q.ok) return blocked(MAINT_VERB_REASONS.SPAWN_FAILED, q.note);
        return done('ok', `已排入安装 v${newVersion}（约 ${Math.round(q.delayMs / 1000)} 秒后停 DSH → 换包 → 自动拉起）`, {
          needsRestart: true,
          queued: true,
          version: newVersion,
        });
      }
      cleanup();
      try { fsImpl.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (locked) {
        return blocked(
          MAINT_VERB_REASONS.INSTALL_FAILED,
          'upgrade: DSH 正在运行、包目录被占用（EPERM）。请在副机开维护重启许可（maintenanceAllowRestart: true + dshExePath）后重试，或本机跑 upgrade-worker.cmd',
        );
      }
      return blocked(MAINT_VERB_REASONS.INSTALL_FAILED, `upgrade: 安装失败（${code || err}）`);
    }
    cleanup();
    // v2.7.10：换名成功后 DSH 仍在跑旧代码，必须重启才生效。
    // 允许重启时直接排入「停 → 拉起」，把「装了还要人去点」这个尾巴去掉。
    if (restartAllowed()) {
      const q = queueRestartOnly({ dshExe: String(config.dshExePath || '').trim() });
      if (q.ok) {
        return done('ok', `已安装 v${newVersion}（约 ${Math.round(q.delayMs / 1000)} 秒后自动重启 DSH 生效）`, {
          needsRestart: true,
          queued: true,
          version: newVersion,
        });
      }
      trace(`upgrade: 已安装 v${newVersion}，但排入重启失败（${q.note}）`);
    }
    return done('ok', `已安装 v${newVersion} → 需重启`, { needsRestart: true, version: newVersion });
  }

  // ── 3.2 config-set ──────────────────────────────────────────────────

  // 白名单键 → 目标位置（'config' 或 'worker'）
  const CONFIG_KEY_LOC = Object.freeze({
    workerMode: 'config',
    allowedRoots: 'config',
    allowAllRoots: 'config',
    shellTimeoutMs: 'config',
    maxOutputBytes: 'config',
    autoDispatch: 'config',
    dispatchApproval: 'config',
    maintenanceEnabled: 'config',
    maintenanceOutDir: 'config',
    maintenancePkgDir: 'config',
    agentEnabled: 'worker',
    agentPreset: 'worker',
    agentCwdRoot: 'worker',
    agentAllowlist: 'worker',
    agentApproval: 'worker',
    agentBudgetMaxPerDay: 'worker',
    agentTimeoutMs: 'worker',
  });

  function validateConfigValue(key, value) {
    switch (key) {
      case 'workerMode':
      case 'dispatchApproval':
      case 'agentApproval':
      case 'agentPreset':
      case 'agentCwdRoot':
      case 'maintenanceOutDir':
      case 'maintenancePkgDir':
        return typeof value === 'string';
      case 'allowedRoots':
        return Array.isArray(value) && value.every((x) => typeof x === 'string');
      case 'allowAllRoots':
      case 'maintenanceEnabled':
      case 'autoDispatch':
      case 'agentEnabled':
        return typeof value === 'boolean';
      case 'shellTimeoutMs':
      case 'maxOutputBytes':
      case 'agentBudgetMaxPerDay':
      case 'agentTimeoutMs':
        // v2.7.0（C-17）：统一走 formatNumber（NaN/Infinity 在这里就被拒）。
        return typeof value === 'number' && value >= 0 && formatNumber(value) !== null;
      case 'agentAllowlist':
        // v2.6.28（安全审计 C-3）：与归一化层 normalizeAgentAllowlist 统一口径——
        // 归一化允许缺 id（自动补 allow-<序号>），validateConfigValue 不再要求 id。
        if (!Array.isArray(value)) return false;
        return value.every((item) => item && typeof item === 'object' && !Array.isArray(item));
      default:
        return false;
    }
  }

  // YAML 值序列化（JSON 是 YAML 超集；字符串用单引号）
  function yamlValue(v) {
    if (typeof v === 'string') {
      const inner = v.replace(/'/g, "''");
      return `'${inner}'`;
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      const s = formatNumber(v);
      // validateConfigValue 已拦非有限数；这里兜底成 'null'，绝不把 Infinity 写进配置。
      return s === null ? 'null' : s;
    }
    if (v === null || v === undefined) return 'null';
    return JSON.stringify(v);
  }

  // 解析 YAML 标量值 → JS 值（幂等比较用）
  function parseYamlScalar(s) {
    const t = (s ?? '').trim();
    if (t === '' || t === "''" || t === '""') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      const inner = t.slice(1, -1);
      return t[0] === "'" ? inner.replace(/''/g, "'") : JSON.parse(t);
    }
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      try { return JSON.parse(t); } catch { return t; }
    }
    return t;
  }

  function normalizeValue(v) {
    if (Array.isArray(v)) return v.map(normalizeValue);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = normalizeValue(v[k]);
      return out;
    }
    return v;
  }
  function sameValue(a, b) {
    return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
  }

  // 子块结束位置（下一个缩进 <= blockIndent 的非空行之前，或文件结束）
  function findBlockEnd(lines, blockIdx) {
    const blockIndent = lines[blockIdx].match(/^(\s*)/)[1].length;
    for (let i = blockIdx + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      const indent = lines[i].match(/^(\s*)/)[1].length;
      if (indent <= blockIndent) return i - 1;
    }
    return lines.length - 1;
  }

  // 在子块内 upsert 键行；返回 { changed, error }
  // v2.7.5（盘古全盘扫描 P1-3）：判断键行后面是否跟着「多行块 / 块序列」子行。
  // 旧实现替换键行时只换那一行，`key:` 下面的 `- id: a` 会残留 ⇒ YAML 结构破坏。
  function childEndOf(lines, idx, keyIndent) {
    let last = idx;
    for (let i = idx + 1; i < lines.length; i += 1) {
      const ln = lines[i];
      if (String(ln).trim() === '') continue;          // 空行不武断结束（后面可能还是子行）
      const ind = ln.match(/^(\s*)/)[1].length;
      if (ind <= keyIndent) break;
      last = i;
    }
    return last;
  }

  function upsertBlock(lines, blockIdx, updates) {
    if (!updates.length) return { changed: false };
    const blockIndent = lines[blockIdx].match(/^(\s*)/)[1].length;
    const keyIndent = blockIndent + 2;
    const keyIndentStr = ' '.repeat(keyIndent);
    const end = findBlockEnd(lines, blockIdx);
    // 收集子块内现有键行（key: 值 形态，缩进 = keyIndent）
    const keyLineIdx = {};
    // v2.6.29（U-3）：同时记下改前的解析值，dryRun 预览要拿它算 from。
    const existing = {};
    for (let i = blockIdx + 1; i <= end; i += 1) {
      const m = lines[i].match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m && m[1].length === keyIndent) {
        keyLineIdx[m[2]] = { idx: i, val: m[3], childEnd: childEndOf(lines, i, keyIndent) };
        if (!Object.prototype.hasOwnProperty.call(existing, m[2])) existing[m[2]] = parseYamlScalar(m[3]);
      }
    }
    let changed = false;
    // 行数会变，逐个处理时用「从后往前」或重查 end。这里用从后往前避免索引漂移。
    for (let k = updates.length - 1; k >= 0; k -= 1) {
      const u = updates[k];
      const existing = keyLineIdx[u.key];
      if (existing !== undefined) {
        // 幂等：值相同且无子行才不改（子行残留也算不一致）
        if (sameValue(parseYamlScalar(existing.val), u.value) && existing.childEnd === existing.idx) continue;
        if (existing.childEnd > existing.idx) {
          // 多行块 / 块序列：连子行一起替换，避免留下孤儿 `- id: a`
          lines.splice(existing.idx + 1, existing.childEnd - existing.idx);
        }
        lines[existing.idx] = `${keyIndentStr}${u.key}: ${yamlValue(u.value)}`;
        changed = true;
      } else {
        // 插入：在子块最后一个键行之后
        let insertAt = end;
        for (let i = end; i > blockIdx; i -= 1) {
          if (/^\s*[A-Za-z_][\w-]*:\s/.test(lines[i]) && lines[i].match(/^(\s*)/)[1].length === keyIndent) {
            insertAt = Math.max(i, childEndOf(lines, i, keyIndent)); break;
          }
        }
        lines.splice(insertAt + 1, 0, `${keyIndentStr}${u.key}: ${yamlValue(u.value)}`);
        changed = true;
      }
    }
    return { changed, existing };
  }

  // 找 team 块内的 config: / worker: 子块行（插入键行后索引会漂移，调用方可重算）
  function findTeamSubBlocks(lines, teamIdx) {
    const teamIndent = lines[teamIdx].match(/^(\s*)-/)[1].length;
    let configIdx = -1, workerIdx = -1;
    for (let i = teamIdx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= teamIndent && /^\s*-\s*id:/.test(line)) break; // 下一个 team 块
      const m = line.match(/^(\s*)(config|worker):\s*$/);
      if (m) {
        if (m[2] === 'config') configIdx = i;
        if (m[2] === 'worker') workerIdx = i;
      }
    }
    return { configIdx, workerIdx };
  }

  // 在 team 块的 config/worker 子块 upsert；返回 { changed, newText, error }
  function upsertTeamConfig(yamlText, updates) {
    const lines = yamlText.split('\n');
    // 找 - id: team 行
    // v2.6.28（U-5）：正则容忍可选引号与行尾注释——只匹配 `- id: team` 时，遇到
    // `- id: 'team'` 或 `- id: team # 注释` 就报「未找到 team 块」，config-set 写不进去。
    let teamIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*-\s*id:\s*['"]?team['"]?\s*(?:#.*)?$/.test(lines[i])) { teamIdx = i; break; }
    }
    if (teamIdx < 0) return { changed: false, error: '未找到 - id: team 块' };
    // 找 config: 和 worker: 行（team 块内，缩进 > teamIndent）
    const found = findTeamSubBlocks(lines, teamIdx);
    const configIdx = found.configIdx;
    let workerIdx = found.workerIdx;
    if (configIdx < 0) return { changed: false, error: 'team 块内无 config: 子块' };
    const byLoc = { config: [], worker: [] };
    for (const u of updates) byLoc[u.loc].push(u);
    let changed = false;
    const existing = {};
    const configRes = upsertBlock(lines, configIdx, byLoc.config);
    if (configRes.error) return { changed: false, error: configRes.error };
    if (configRes.changed) changed = true;
    if (configRes.existing) Object.assign(existing, configRes.existing);
    if (byLoc.worker.length) {
      // config 子块可能刚插入了键行 ⇒ workerIdx 会漂移，重新定位后再写。
      // （只改 config 不动 worker 时这里也重扫一次，成本可忽略。）
      if (workerIdx >= 0) workerIdx = findTeamSubBlocks(lines, teamIdx).workerIdx;
      if (workerIdx >= 0) {
        const workerRes = upsertBlock(lines, workerIdx, byLoc.worker);
        if (workerRes.error) return { changed: false, error: workerRes.error };
        if (workerRes.changed) changed = true;
        if (workerRes.existing) Object.assign(existing, workerRes.existing);
      } else {
        // 无 worker: 子块但有 worker 键 → 在 config: 子块后插入 worker: 子块
        const insertIdx = findBlockEnd(lines, configIdx);
        const configIndent = lines[configIdx].match(/^(\s*)/)[1].length;
        const workerIndentStr = ' '.repeat(configIndent);
        const keyIndentStr = ' '.repeat(configIndent + 2);
        const newLines = [`${workerIndentStr}worker:`];
        for (const u of byLoc.worker) newLines.push(`${keyIndentStr}${u.key}: ${yamlValue(u.value)}`);
        lines.splice(insertIdx + 1, 0, ...newLines);
        changed = true;
      }
    }
    return { changed, newText: lines.join('\n'), existing };
  }

  function runConfigSet(payload) {
    const set = payload.set || {};
    if (!set || typeof set !== 'object' || Array.isArray(set)) {
      return blocked(MAINT_VERB_REASONS.CONFIG_INVALID, 'config-set: set 必须是对象');
    }
    // 白名单 + 类型校验
    const updates = [];
    for (const key of Object.keys(set)) {
      const loc = CONFIG_KEY_LOC[key];
      if (!loc) return blocked(MAINT_VERB_REASONS.CONFIG_KEY_DENIED, `config-set: 键 ${key} 不在白名单`);
      if (!validateConfigValue(key, set[key])) {
        return blocked(MAINT_VERB_REASONS.CONFIG_INVALID, `config-set: 键 ${key} 值类型不合法`);
      }
      updates.push({ key, value: set[key], loc });
    }
    if (!updates.length) return blocked(MAINT_VERB_REASONS.CONFIG_INVALID, 'config-set: set 为空');
    // 读 profileDir/cordis.patch.yml
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    let yamlText;
    try {
      yamlText = fsImpl.readFileSync(patchFile, 'utf8');
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.CONFIG_WRITE_FAILED, `config-set: cordis.patch.yml 读不到（${(err && err.code) || err}）`);
    }
    // 幂等 + 生成新文本
    const res = upsertTeamConfig(yamlText, updates);
    if (res.error) return blocked(MAINT_VERB_REASONS.CONFIG_WRITE_FAILED, `config-set: ${res.error}`);
    if (!res.newText) return blocked(MAINT_VERB_REASONS.CONFIG_WRITE_FAILED, 'config-set: 生成失败');
    // v2.6.29（U-3）：dryRun 预览要「只列实际会变的键」并带 from/to。
    // 口径与 upsertBlock 的幂等判定一致：不存在 → from=null；存在且 sameValue → 不算变化。
    const before = res.existing || {};
    const changedList = updates
      .filter((u) => !Object.prototype.hasOwnProperty.call(before, u.key) || !sameValue(before[u.key], u.value))
      .map((u) => ({ key: u.key, from: Object.prototype.hasOwnProperty.call(before, u.key) ? before[u.key] : null, to: u.value }));
    // 幂等：值全部相同 → 不改文件，不产备份，返回 note:'无变化'
    if (!res.changed) {
      return done('ok', 'config-set: 无变化', payload.dryRun === false ? {} : { changesList: [] });
    }
    // v2.6.28（安全审计 C-11）：dryRun 严格判定——存在但非 boolean → maint-config-invalid
    // （不静默）；默认 dryRun（fail-safe）：仅显式 true 或缺失才不写盘，显式 false 才写盘。
    if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
      return blocked(MAINT_VERB_REASONS.CONFIG_INVALID, `config-set: dryRun 必须是 boolean（收到 ${JSON.stringify(payload.dryRun)}）`);
    }
    if (payload.dryRun === true || payload.dryRun === undefined) {
      const changes = updates.map((u) => `${u.key}=${yamlValue(u.value)}`).join(', ');
      return done('ok', `config-set: dryRun 将改 ${changes}`, { dryRun: true, changes, changesList: changedList });
    }
    // 写盘前备份
    const backup = `${patchFile}.bak-maint-${stamp(now())}`;
    try {
      fsImpl.writeFileSync(backup, yamlText, 'utf8');
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.CONFIG_WRITE_FAILED, `config-set: 备份失败（${(err && err.code) || err}）`);
    }
    // 原子写
    try {
      const tmp = `${patchFile}.tmp`;
      fsImpl.writeFileSync(tmp, res.newText, 'utf8');
      fsImpl.renameSync(tmp, patchFile);
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.CONFIG_WRITE_FAILED, `config-set: 写盘失败（${(err && err.code) || err}）`);
    }
    return done('ok', 'config-set: 已写盘');
  }

  // ── 3.3 restart ─────────────────────────────────────────────────────

  function runRestart(payload, ctx) {
    if (config.maintenanceAllowRestart !== true) {
      return blocked(MAINT_VERB_REASONS.RESTART_DISABLED, 'restart: maintenanceAllowRestart 未开');
    }
    const dshExePath = String(config.dshExePath || '').trim();
    if (!dshExePath) return blocked(MAINT_VERB_REASONS.RESTART_PATH, 'restart: dshExePath 未配置');
    // v2.6.28（安全审计 S-13）：dshExePath 会直接插进 PowerShell 单引号串，路径里一个 '
    // 就能闭合引号注入命令。用「单引号加倍」转义（PowerShell 转义规则）而不是黑名单——
    // 黑名单会连带拒掉中文/Unicode 用户名路径（C:\Users\张三\...）。
    const psQuote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    let exists = false;
    try { exists = fsImpl.existsSync(dshExePath); } catch { /* ignore */ }
    if (!exists) return blocked(MAINT_VERB_REASONS.RESTART_PATH, `restart: dshExePath 不存在`);
    // delayMs 缺省 8000，夹 3000..60000
    let delayMs = Number(payload.delayMs);
    if (!Number.isFinite(delayMs)) delayMs = 8000;
    delayMs = Math.min(60000, Math.max(3000, Math.floor(delayMs)));
    // spawnImpl 起 detached pwsh 脚本（不 import child_process）
    if (!spawnImpl) return blocked(MAINT_VERB_REASONS.SPAWN_FAILED, 'restart: spawnImpl 未注入');
    const pid = process.pid;
    const taskId = String((ctx && ctx.taskId) || 'task').trim() || 'task';
    // v2.7.5（盘古全盘扫描 P0-3）：taskId 来自任务单，必须安全化后才能进文件名，
    // 否则 `..`/`/` 段可让 restart 日志穿越 stateDir 写任意位置。
    const taskSlug = String(taskId).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').replace(/[._]+$/, '') || 'task';
    const stateDir = String(config.stateDir || '').trim();
    // 固定脚本模板（不从任务取，只插 delay/dshExePath/pid）
    if (!fsImpl.existsSync(dshExePath)) return blocked(MAINT_VERB_REASONS.RESTART_PATH, 'restart: dshExePath 不存在');
    const script = buildRestartScript({ delayMs, dshExe: dshExePath, pid });
    // 写 log 到 <stateDir>/restart-<taskId>.log（log 失败不影响重启）
    if (stateDir) {
      const stateRoot = path.resolve(stateDir);
      const logFile = path.resolve(stateRoot, `restart-${taskSlug}.log`);
      const logLine = `restart at ${new Date().toISOString()} delay=${delayMs} pid=${pid} dshExe=${dshExePath}`;
      if (logFile.startsWith(stateRoot + path.sep)) {
        try {
          fsImpl.mkdirSync(path.dirname(logFile), { recursive: true });
          fsImpl.appendFileSync(logFile, logLine + '\n', 'utf8');
        } catch { /* log 失败不影响重启 */ }
      }
    }
    try {
      // pwsh 路径：config.pwshPath 优先，否则 pwsh.exe（PATH）
      const pwsh = String(config.pwshPath || '').trim() || 'pwsh.exe';
      spawnImpl(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      return blocked(MAINT_VERB_REASONS.SPAWN_FAILED, `restart: spawn 失败（${(err && err.message) || err}）`);
    }
    return done('ok', `将在 ${Math.round(delayMs / 1000)} 秒后重启`);
  }

  // ── 主 run ──────────────────────────────────────────────────────────

  /**
   * 执行一个写动词。**不记 nonce**（调用方在 run 前 recordNonce，契约 §4）。
   * @param {'upgrade'|'config-set'|'restart'} verb
   * @param {object} payload 已解析的 payload 对象
   * @param {object} ctx { taskId }
   * @returns {Promise<{ok, status, reason, note, ...}>}
   */
  async function run(verb, payload, ctx = {}) {
    if (!supported(verb)) return blocked(MAINT_VERB_REASONS.VERB_UNKNOWN, `未知动词 ${verb}`);
    if (verb === 'upgrade') return runUpgrade(payload);
    if (verb === 'config-set') return runConfigSet(payload);
    if (verb === 'restart') return runRestart(payload, ctx);
    return blocked(MAINT_VERB_REASONS.VERB_UNKNOWN, `未知动词 ${verb}`);
  }

  return { supported, run };
}