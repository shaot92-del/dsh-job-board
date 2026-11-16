// exec 执行器：白名单闸门 → spawn 子进程 → 超时/取消杀进程树 → 解析 DSH_RESULT。
//
// 安全边界（handoff §3.3，全部在这里落地）：
//   · 只跑绝对路径的 .ps1，必须存在且是普通文件；
//   · 必须落在 allowlist 内（目录前缀或文件全等，比较前先 realpath，防 .. 与符号链接逃逸）；
//   · approvalMode=manual 时非白名单一律 blocked，绝不"先跑了再说"；
//   · 超时/取消用绝对路径的 taskkill /F /T 杀整棵进程树（child.kill 在 Windows
//     上只杀直接子进程，孙进程会活下来继续写文件）；
//   · 输出只留尾部（64KB/路），避免一个刷屏脚本把宿主内存吃满。
//
// 可注入依赖（spawnImpl/fsImpl/now）是为了让单测不用真起 pwsh。

import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSlashes, resolvePwshPath } from './config.js';
import { formatResultSummary, parseDshArtifact, parseDshResult } from './result.js';

// 上限比「只看最后一行」实际需要的多很多：DSH_RESULT 是脚本最后一行，
// 但脚本可能在前面打很多日志（尤其 verbose 的批量任务），64KB 会把结果行挤掉。
export const MAX_STREAM_BYTES = 256 * 1024;
export const STDERR_TAIL_CHARS = 300;
export const NOTE_BUDGET = 500;
export const DEFAULT_TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
/** note 里我们这半边最多占多少字符（worker 还要加 worker:/inst: 前缀） */
export const NOTE_TEXT_BUDGET = 400;
/** kill 之后等子进程真正退出的宽限；超过就按「杀不掉」收尾，不再占着并发槽。 */
export const KILL_GRACE_MS = 5000;
/**
 * exit 之后等 close 的窗口。有的孙进程会继承 stdout/stderr 句柄，父进程已经 exit 0，
 * 管道却迟迟不关 —— 只靠 close 结算会把「成功」拖成「超时」。exit 后给一小段
 * drain 取残留输出，超时就用 exit code 结算。
 */
export const EXIT_DRAIN_MS = 250;

export function normalizeForCompare(p) {
  const s = normalizeSlashes(String(p || ''));
  // 盘根 `C:\` 去尾斜杠会变成 `C:`，那样前缀比较等于「整盘」。根目录保留分隔符。
  if (/^[A-Za-z]:\\$/.test(s)) return s.toLowerCase();
  return s.replace(/\\+$/, '').toLowerCase();
}

/** child 是否在 parent 目录/文件之内（大小写不敏感，按分隔符边界）。 */
export function isWithin(childPath, parentPath) {
  const child = normalizeForCompare(childPath);
  const parent = normalizeForCompare(parentPath);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith('\\') ? parent : parent + '\\');
}

/**
 * 白名单闸门。返回 {allowed, reason, resolvedPath, scriptPath}。
 * reason ∈ allowed | not-allowlisted-auto | not-absolute | bad-path | bad-extension | missing | not-file | not-allowlisted
 *
 * 裁决只用 **realpath 后的结果** 与 **realpath 后的白名单项** 比较：
 * 早先版本额外允许「原始串也在白名单里」作为兜底，那会被 `allow\..\outside\x.ps1`
 * 或 allow 目录下的 junction 骗过（安全审计 P0-1）。realpath 失败一律拒绝。
 */
export function checkScriptAccess(input, opts = {}) {
  const fsImpl = opts.fs || fs;
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : [];
  const approvalMode = opts.approvalMode === 'auto' ? 'auto' : 'manual';
  const scriptPath = String(input || '').trim().replace(/^"|"$/g, '');

  if (!scriptPath) return { allowed: false, reason: 'empty', scriptPath };
  if (!/^[A-Za-z]:[\\/]/.test(scriptPath) && !/^\\\\[^\\]/.test(scriptPath)) {
    return { allowed: false, reason: 'not-absolute', scriptPath };
  }
  if (/^\\\\[.?]\\/.test(scriptPath) || /^\\\\/.test(scriptPath)) {
    // UNC / \\?\ / \\.\ 一律不认：这些形态的 realpath 与白名单前缀语义都不可靠
    return { allowed: false, reason: 'bad-path', scriptPath };
  }
  const segments = scriptPath.split(/[\\/]+/);
  if (segments.includes('..') || segments.includes('.')) {
    return { allowed: false, reason: 'bad-path', scriptPath };
  }
  if (!/\.ps1$/i.test(scriptPath)) return { allowed: false, reason: 'bad-extension', scriptPath };

  let stat = null;
  try {
    stat = fsImpl.statSync(scriptPath);
  } catch {
    return { allowed: false, reason: 'missing', scriptPath };
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    return { allowed: false, reason: 'not-file', scriptPath };
  }

  let resolvedPath = '';
  try {
    // realpathSync.native 才按 Win32 语义展开 8.3 短名/junction；JS 版会把短名原样返回，
    // 于是「白名单写长名、任务写短名」这种合法配置会被静默拒掉（实测）。
    resolvedPath = (fsImpl.realpathSync.native || fsImpl.realpathSync)(scriptPath) || '';
  } catch {
    /* 落到下面按失败处理 */
  }
  if (!resolvedPath) return { allowed: false, reason: 'missing', scriptPath };

  const matched = allowlist.some((entry) => {
    let realEntry = '';
    try {
      realEntry = (fsImpl.realpathSync.native || fsImpl.realpathSync)(entry) || '';
    } catch {
      /* 白名单项不存在 → 不匹配（fail closed），不退回字面比较 */
      realEntry = '';
    }
    if (!realEntry) return false;
    return isWithin(resolvedPath, realEntry);
  });

  if (matched) return { allowed: true, reason: 'allowed', scriptPath, resolvedPath };
  if (approvalMode === 'auto') {
    // 实验模式：非白名单也放行，但调用方必须在日志里留痕
    return { allowed: true, reason: 'not-allowlisted-auto', scriptPath, resolvedPath };
  }
  return { allowed: false, reason: 'not-allowlisted', scriptPath, resolvedPath };
}

/** 只保留尾部 max 字符，超了就从头丢。 */
export function appendTail(current, chunk, max = MAX_STREAM_BYTES) {
  const next = String(current || '') + String(chunk || '');
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

/** 单行化 + 截断，用于 note。 */
export function oneLine(text, max = STDERR_TAIL_CHARS) {
  const t = String(text || '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length <= max ? t : t.slice(0, max) + '…';
}

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
let GBK_DECODER = null;

/**
 * 解码子进程输出。编码并不恒定：从 pwsh 终端里直接跑是 UTF-8，
 * 从 Node 里 spawn（无控制台）时 pwsh 会退回系统 ANSI 代码页（中文机器 = GBK）。
 * 所以先按 UTF-8 严格解码，失败再按 GBK 严格解码，最后兜底带替换符的 utf8。
 */
export function decodeOutput(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    return UTF8_FATAL.decode(buf);
  } catch {
    /* 不是合法 UTF-8，继续试系统代码页 */
  }
  try {
    if (!GBK_DECODER) GBK_DECODER = new TextDecoder('gbk', { fatal: true });
    return GBK_DECODER.decode(buf);
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

/** 累积子进程流字节，只保留末尾 limit 字节（DSH_RESULT / stderr 尾部都在末尾）。 */
function pushBuffer(chunks, buf, limit) {
  if (!buf || buf.length === 0) return;
  chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
  let total = chunks.reduce((n, b) => n + b.length, 0);
  while (total > limit && chunks.length > 1) {
    total -= chunks.shift().length;
  }
}

/** 环境变量白名单：不把宿主的 DSH_ 前缀变量与 token 类变量带进子进程。 */
export function buildChildEnv(baseEnv = process.env, extra = []) {
  const keep = [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'HOMEDRIVE',
    'HOMEPATH',
    'NUMBER_OF_PROCESSORS',
    'COMPUTERNAME',
    'PROCESSOR_ARCHITECTURE',
    'PATH',
  ];
  const env = {};
  for (const key of keep) {
    if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  }
  // 额外透传：只允许「非敏感」名字。passEnv 是配置面的开关，但配错一个
  // DSH_BOARD_TOKEN 就等于把凭证交给任务脚本，所以这里再按名字筛一遍。
  const SENSITIVE_ENV = /(token|secret|pass(word|wd)?|credential|api[-_]?key|private[-_]?key|dsh_)/i;
  for (const key of Array.isArray(extra) ? extra : []) {
    if (typeof key !== 'string') continue;
    if (SENSITIVE_ENV.test(key)) continue;
    if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  }
  return env;
}

export function killTree(child, opts = {}) {
  const taskkill = opts.taskkillPath || DEFAULT_TASKKILL;
  const spawnImpl = opts.spawnImpl || spawnChild;
  const log = opts.log || null;
  const pid = child && child.pid;
  if (!pid) return;
  try {
    const killer = spawnImpl(taskkill, ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    // 失败必须留痕：杀不掉会有 kill-grace 兜底收尾，但原因要能查到
    killer?.on?.('error', (err) => {
      log?.warn?.(`taskkill 不可用 pid=${pid}: ${(err && err.message) || err}`);
    });
    // taskkill 自己也可能失败（权限/进程已消失/参数），退出码非 0 要留痕：
    // 否则就只能从「kill=uneffective」倒推，查不出是谁没杀掉。
    killer?.on?.('exit', (code) => {
      if (code !== 0) log?.warn?.(`taskkill exit=${code} pid=${pid}`);
    });
  } catch (err) {
    log?.warn?.(`taskkill 启动失败 pid=${pid}: ${(err && err.message) || err}`);
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function resolveCwd(candidates, fsImpl) {
  for (const c of candidates) {
    const p = String(c || '').trim();
    if (!p) continue;
    if (!path.isAbsolute(p)) continue;
    try {
      if (fsImpl.statSync(p).isDirectory()) return p;
    } catch {
      /* next */
    }
  }
  return os.homedir();
}

/**
 * @param {object} opts
 * @param {object} opts.config normalizeConfig 的产物
 * @param {object} [opts.log]
 * @param {Function} [opts.spawnImpl]
 * @param {object} [opts.fsImpl]
 * @param {Function} [opts.now]
 * @param {string} [opts.taskkillPath]
 * @param {string} [opts.tmpRoot]
 */
export function createExecRunner(opts = {}) {
  const config = opts.config || {};
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  const spawnImpl = opts.spawnImpl || spawnChild;
  const fsImpl = opts.fsImpl || fs;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  // 注意用 !== undefined 而不是 ||：显式传空串是「我自己没有 pwsh」的意思，
  // 退回自动解析会把 fail-closed 变成 fail-open。
  const pwshPath = opts.pwshPath !== undefined ? opts.pwshPath : resolvePwshPath(config, { exists: (p) => fsImpl.existsSync(p) });
  const taskkillPath = opts.taskkillPath || DEFAULT_TASKKILL;
  const execTimeoutMs = Number(config.execTimeoutMs) > 0 ? Number(config.execTimeoutMs) : 600000;
  const killGraceMs = Number(opts.killGraceMs) > 0 ? Number(opts.killGraceMs) : KILL_GRACE_MS;

  function gate(scriptPath) {
    return checkScriptAccess(scriptPath, {
      allowlist: config.allowlist || [],
      approvalMode: config.approvalMode || 'manual',
      fs: fsImpl,
    });
  }

  function blocked(reason, note, startedAt) {
    return {
      status: 'blocked',
      stage: 'exec',
      reason,
      exitCode: null,
      canceled: false,
      timedOut: false,
      durationMs: now() - startedAt,
      result: null,
      artifact: '',
      note: oneLine(note, NOTE_TEXT_BUDGET),
      stdoutTail: '',
      stderrTail: '',
    };
  }

  /**
   * 跑一个 exec spec。
   * @param {object} spec {scriptPath, args?, timeoutMs?, inline?}
   * @param {{task?: object, taskId?: string, signal?: AbortSignal}} [runOpts]
   */
  async function run(spec = {}, runOpts = {}) {
    const startedAt = now();
    const taskId = String(runOpts.taskId || (runOpts.task && runOpts.task.id) || '');
    const timeoutMs = Number(spec.timeoutMs) > 0 ? Math.min(Number(spec.timeoutMs), execTimeoutMs) : execTimeoutMs;
    const legacy = Boolean(spec.inline);
    let stdout = '';
    let stderr = '';
    const stdoutChunks = [];
    const stderrChunks = [];

    // ── 1. 闸门 ────────────────────────────────────────────────────────
    let scriptPath = '';
    let tmpDir = '';
    if (legacy) {
      if (!config.allowInline) {
        return blocked('inline-command-not-allowed', 'stage=exec reason=inline-command-not-allowed（内联命令默认拒绝）', startedAt);
      }
      try {
        tmpDir = fsImpl.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'dsh-job-worker-'));
        scriptPath = path.join(tmpDir, 'inline.ps1');
        fsImpl.writeFileSync(scriptPath, String(spec.inline || ''), 'utf8');
      } catch (err) {
        return blocked('inline-temp-failed', `stage=exec reason=inline-temp-failed ${oneLine((err && err.message) || err)}`, startedAt);
      }
      log.warn(`legacy-goal 内联脚本 task=${taskId} 长度=${String(spec.inline || '').length}`);
    } else {
      scriptPath = String(spec.scriptPath || '').trim().replace(/^"|"$/g, '');
      const checked = gate(scriptPath);
      if (!checked.allowed) {
        const reason = checked.reason;
        const note =
          reason === 'not-allowlisted'
            ? `stage=exec reason=approval-required（脚本不在 allowlist 内：${oneLine(scriptPath, 160)}）`
            : `stage=exec reason=${reason}（${oneLine(scriptPath, 160)}）`;
        log.warn(`闸门拒绝 task=${taskId} reason=${reason} path=${scriptPath}`);
        return blocked(reason, note, startedAt);
      }
      scriptPath = checked.resolvedPath || scriptPath;
      if (checked.reason === 'not-allowlisted-auto') {
        log.warn(`approvalMode=auto 放行非白名单脚本 task=${taskId} path=${scriptPath}`);
      }
    }

    // ── 2. spawn ──────────────────────────────────────────────────────
    if (!pwshPath) {
      const note =
        'stage=exec reason=pwsh-missing（找不到 pwsh.exe：配 worker.pwshPath，或把 PowerShell 7 装到 ' +
        '%LOCALAPPDATA%\\Programs\\PowerShell\\7\\pwsh.exe）';
      log.error(`pwsh 不可用 task=${taskId}`);
      return { ...blocked('pwsh-missing', note, startedAt), status: 'failed' };
    }
    const args = legacy ? [] : Array.isArray(spec.args) ? spec.args.map((x) => String(x)) : [];
    const argv = ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args];
    const cwd = resolveCwd([(runOpts.task && runOpts.task.workspace) || '', config.execCwd || ''], fsImpl);
    const env = buildChildEnv(process.env, config.passEnv || []);

    let child;
    try {
      child = spawnImpl(pwshPath, argv, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        status: 'failed',
        stage: 'exec',
        exitCode: null,
        canceled: false,
        timedOut: false,
        durationMs: now() - startedAt,
        result: null,
        artifact: '',
        note: oneLine(`stage=exec reason=spawn-failed ${(err && err.message) || err}`, NOTE_TEXT_BUDGET),
        stdoutTail: '',
        stderrTail: '',
      };
    }

    let timedOut = false;
    let canceled = false;
    let settled = false;

    const cleanupTmp = () => {
      if (!tmpDir) return;
      try {
        fsImpl.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    const outcome = await new Promise((resolve) => {
      let timer = null;
      let onAbort = null;
      let graceTimer = null;
      let drainTimer = null;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (runOpts.signal && onAbort) {
          try {
            runOpts.signal.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
        }
        cleanupTmp();
        resolve(payload);
      };

      // taskkill + SIGKILL 之后进程仍不退出（卡在不可杀状态/父进程拖着）时，
      // 不能一直等 close —— 否则任务永远停在 running，并发槽也放不回来。
      const scheduleGrace = () => {
        if (graceTimer || settled) return;
        graceTimer = setTimeout(() => {
          if (settled) return;
          log.error(`子进程 kill 后 ${killGraceMs}ms 仍未退出，按未退出收尾 task=${taskId} pid=${child.pid}`);
          finish({ code: null, signalName: '', hardSettled: true });
        }, killGraceMs);
        };

      onAbort = () => {
        if (settled) return;
        canceled = true;
        killTree(child, { taskkillPath, spawnImpl, log });
        scheduleGrace();
      };

      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        log.warn(`exec 超时 task=${taskId} ${timeoutMs}ms，杀进程树 pid=${child.pid}`);
        killTree(child, { taskkillPath, spawnImpl, log });
        scheduleGrace();
      }, timeoutMs);

      if (runOpts.signal) {
        if (runOpts.signal.aborted) onAbort();
        else {
          try {
            runOpts.signal.addEventListener('abort', onAbort, { once: true });
          } catch {
            /* ignore */
          }
        }
      }

      child.on('error', (err) => {
        finish({ spawnError: (err && err.message) || String(err) });
      });
      child.stdout?.on('data', (buf) => {
        pushBuffer(stdoutChunks, buf, MAX_STREAM_BYTES);
      });
      child.stderr?.on('data', (buf) => {
        pushBuffer(stderrChunks, buf, MAX_STREAM_BYTES);
      });
      child.on('close', (code, signalName) => {
        finish({ code, signalName: signalName || '' });
      });
      // close 只在所有 stdio 句柄关闭后才来：孙进程继承管道时它可能永远不来。
      // exit 一到就先记下真实退出码，给一小段 drain 取残留输出，然后照常结算。
      child.on('exit', (code, signalName) => {
        if (settled || drainTimer) return;
        const payload = { code, signalName: signalName || '' };
        drainTimer = setTimeout(() => {
          drainTimer = null;
          if (settled) return;
          log.debug(`子进程 exit 后 ${EXIT_DRAIN_MS}ms 仍无 close，按 exit 结算 task=${taskId} pid=${child.pid}`);
          finish(payload);
        }, EXIT_DRAIN_MS);
      });
    });

    const durationMs = now() - startedAt;
    stdout = decodeOutput(Buffer.concat(stdoutChunks));
    stderr = decodeOutput(Buffer.concat(stderrChunks));

    // ── 3. 结果 ───────────────────────────────────────────────────────
    if (outcome.spawnError) {
      return {
        status: 'failed',
        stage: 'exec',
        exitCode: null,
        canceled: false,
        timedOut: false,
        durationMs,
        result: null,
        artifact: '',
        reason: 'spawn-failed',
        note: oneLine(`stage=exec reason=spawn-failed ${outcome.spawnError}`, NOTE_TEXT_BUDGET),
        stdoutTail: stdout,
        stderrTail: stderr,
      };
    }

    const exitCode = typeof outcome.code === 'number' ? outcome.code : null;
    const stderrTail = oneLine(stderr, STDERR_TAIL_CHARS);
    const killNote = outcome.hardSettled ? ' kill=uneffective' : '';

    if (canceled) {
      return {
        status: 'blocked',
        stage: 'exec',
        exitCode,
        canceled: true,
        timedOut: false,
        durationMs,
        result: null,
        artifact: '',
        reason: 'canceled',
        note: oneLine(`stage=exec reason=canceled exit=${exitCode ?? '?'} dur=${durationMs}ms${killNote}`, NOTE_TEXT_BUDGET),
        stdoutTail: stdout,
        stderrTail: stderr,
      };
    }
    if (timedOut) {
      const note =
        `stage=exec reason=timeout timeoutMs=${timeoutMs} exit=${exitCode ?? '?'} dur=${durationMs}ms` +
        killNote +
        (stderrTail ? ` stderr=${stderrTail}` : '');
      return {
        status: 'failed',
        stage: 'exec',
        exitCode,
        canceled: false,
        timedOut: true,
        durationMs,
        result: null,
        artifact: '',
        reason: 'timeout',
        note: oneLine(note, NOTE_TEXT_BUDGET),
        stdoutTail: stdout,
        stderrTail: stderr,
      };
    }

    const parsed = parseDshResult(stdout);
    const artifact = parseDshArtifact(stdout);

    if (exitCode !== 0) {
      const note =
        `stage=exec exit=${exitCode ?? '?'} dur=${durationMs}ms` +
        (outcome.signalName ? ` signal=${outcome.signalName}` : '') +
        (stderrTail ? ` stderr=${stderrTail}` : '') +
        (parsed.found && parsed.error ? ` dsh-result=${parsed.error}` : '');
      return {
        status: 'failed',
        stage: 'exec',
        exitCode,
        canceled: false,
        timedOut: false,
        durationMs,
        result: parsed.result,
        artifact,
        reason: 'exit-nonzero',
        note: oneLine(note, NOTE_TEXT_BUDGET),
        stdoutTail: stdout,
        stderrTail: stderr,
      };
    }

    const summary = formatResultSummary(parsed.result);
    let note = `stage=exec exit=0 dur=${durationMs}ms ${summary}`;
    if (!parsed.found) note += ' dsh-result=missing';
    else if (!parsed.result) note += ` dsh-result=${parsed.error}`;
    if (parsed.found && !parsed.result) log.warn(`DSH_RESULT 无法解析 task=${taskId} error=${parsed.error}`);

    return {
      status: 'done',
      stage: 'exec',
      exitCode,
      canceled: false,
      timedOut: false,
      durationMs,
      result: parsed.result,
      artifact,
      reason: parsed.result ? 'completed' : parsed.found ? 'result-invalid' : 'result-missing',
      note: oneLine(note, NOTE_TEXT_BUDGET),
      stdoutTail: stdout,
      stderrTail: stderr,
    };
  }

  return { run, gate, pwshPath, execTimeoutMs };
}
