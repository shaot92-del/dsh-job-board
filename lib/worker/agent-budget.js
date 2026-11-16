// agent 任务的每日预算（milestone 2 第 4 层的一部分）。
//
// 为什么需要它：agent 任务是「开一个会话让它自己干活」，单任务成本与 exec 完全不是一个量级，
// 而看板侧的 dispatch 是自动的——一次误配就可能把当天额度烧光。
// 这里按 **UTC 日** 计数，计数文件落在 `worker.stateDir`（默认 `%LOCALAPPDATA%\dsh-job-worker`），
// 没有 stateDir 就退化成进程内计数（重启即清零，够单测与临时机器用）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MAX_PER_DAY = 20;
export const BUDGET_FILE = 'agent-budget.json';

/** 2026-11-15T10:00:00Z → '2026-11-15'（UTC，避免本地时区/DST 让「当天」忽长忽短） */
export function budgetDate(nowMs) {
  return new Date(Number(nowMs) || Date.now()).toISOString().slice(0, 10);
}

/**
 * @param {{stateDir?: string, maxPerDay?: number, now?: Function, fsImpl?: object, log?: object}} opts
 */
export function createAgentBudget(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const log = opts.log || { warn() {}, debug() {} };
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const limit = Number(opts.maxPerDay) > 0 ? Math.floor(Number(opts.maxPerDay)) : DEFAULT_MAX_PER_DAY;
  const dir = typeof opts.stateDir === 'string' ? opts.stateDir.trim() : '';
  const file = dir ? path.join(dir, BUDGET_FILE) : '';
  let memory = { date: '', used: 0 };

  function read() {
    const date = budgetDate(now());
    // 跨到新的一天：进程内计数同步清零（文件那边按 date 判，读到旧日期也视为 0）
    if (memory.date !== date) memory = { date, used: 0 };
    if (!file) return { date, used: memory.used };
    try {
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      const used = Number(raw && raw.used);
      const stored = typeof (raw && raw.date) === 'string' ? raw.date : '';
      const fileUsed = stored === date && Number.isFinite(used) && used >= 0 ? Math.floor(used) : 0;
      // 写盘失败过时文件比 memory 旧：取较大值，否则「文件可读不可写」会让额度永远停在旧值
      const usedNow = Math.max(fileUsed, memory.used || 0);
      memory = { date, used: usedNow };
      return { date, used: usedNow };
    } catch {
      // 文件不存在/损坏/读不动：用进程内计数（可能为 0，但至少写失败后不会倒退回 0）
      return { date, used: memory.used };
    }
  }

  function write(state) {
    if (!file) {
      memory = state;
      return;
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      // 先写临时文件再原子替换：写到一半被 kill/断电时，旧的计数文件仍然完整可读，
      // 不会出现「JSON 被截断 → 读取失败 → 当作 0 → 额度凭空恢复」。
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, `${JSON.stringify({ date: state.date, used: state.used })}\n`, 'utf8');
      fsImpl.renameSync(tmp, file);
      memory = state;
    } catch (err) {
      log.warn(`agent 预算写盘失败（按进程内计数继续）：${(err && err.message) || err}`);
      memory = state;
    }
  }

  /** 只看不动。 */
  function peek() {
    const state = read();
    return { date: state.date, used: state.used, limit, ok: state.used < limit };
  }

  /** 占一个额度；超限时不写盘、返回 ok:false。 */
  function consume() {
    const state = read();
    if (state.used >= limit) return { ok: false, date: state.date, used: state.used, limit };
    const next = { date: state.date, used: state.used + 1 };
    write(next);
    return { ok: true, date: next.date, used: next.used, limit };
  }

  /**
   * 退还一个已预占的额度：会话根本没起来时不能白扣（第二遍审计 P2-B——
   * 否则看板侧只要连投 20 条 cwd 非法的任务就能把当日额度打满，合法任务全天被拒）。
   * 只在同一天内退还；跨日不回滚（新的一天本来就清零了）。
   */
  function refund() {
    const state = read();
    const used = Math.max(0, state.used - 1);
    const next = { date: state.date, used };
    write(next);
    return { date: next.date, used: next.used, limit };
  }

  return { peek, consume, refund, limit, file };
}

/** 默认 stateDir：`%LOCALAPPDATA%\dsh-job-worker`（Windows），其它平台落到 homedir。 */
export function defaultStateDir(env = process.env) {
  const local = env && env.LOCALAPPDATA;
  if (local) return path.join(local, 'dsh-job-worker');
  return path.join(os.homedir(), '.dsh-job-worker');
}
