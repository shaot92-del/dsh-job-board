// agent 任务的**本机**人工审批（milestone 2 第 4 层）。
//
// 为什么不用「任务 note 里带一个标记」：看板的 note 是提交者能写、worker 回写时也会写的
// 同一个字段。于是任何能提交/重派任务的人，只要把 marker 抄进 note 就能自己批自己
// （第一遍审计实测：第一次 blocked 的 note 原样当新任务 note 再派一次 → done）。
//
// 真正的边界是「谁在这台机器上」：审批记录只落在本机 stateDir，由本机操作者通过
// `worker_control action=approve taskId=…` 写下，并且**绑定提示词指纹**——
// 批准过 A 提示词，换成 B 提示词要重新批。看板侧的提交者拿不到这个文件。
//
// 指纹归一化必须与执行侧一致：执行用的是任务书 trim 后的文本，而看板快照里的 goal
// 可能带首尾空白/换行——两边不一致会让合法任务永远 `fingerprint-mismatch`
// （第二遍审计 P2-A 实测）。所以 promptFingerprint 自己先做 trim + 空白折叠。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APPROVALS_FILE = 'agent-approvals.json';

/** 审批有效期：批过 24 小时没派来的任务要重新批（避免一条旧批准被反复利用）。 */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** 最多保留多少条记录（超出按时间淘汰最旧的）。 */
export const MAX_APPROVALS = 200;

/** 指纹用的提示词归一化：与执行侧一致（trim + 折叠内部空白）。 */
export function normalizeGoalForFingerprint(goal) {
  const text = typeof goal === 'string' ? goal : goal === undefined || goal === null ? '' : String(goal);
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * 提示词指纹：审批绑定的是「这条任务书」，不是「这个 task id」。
 * 换成别的提示词必须重新审批。
 */
export function promptFingerprint(goal) {
  return crypto.createHash('sha256').update(normalizeGoalForFingerprint(goal), 'utf8').digest('hex').slice(0, 16);
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {{stateDir?: string, now?: Function, fsImpl?: object, log?: object, ttlMs?: number}} opts
 * @returns {{record: Function, revoke: Function, check: Function, list: Function, count: Function, file: string, writeFailed: Function}}
 */
export function createAgentApprovals(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const log = opts.log || { warn() {}, debug() {} };
  const ttlMs = Number(opts.ttlMs) > 0 ? Math.floor(Number(opts.ttlMs)) : APPROVAL_TTL_MS;
  const dir = asString(opts.stateDir).trim();
  const file = dir ? path.join(dir, APPROVALS_FILE) : '';
  // 没有 stateDir 就只在进程内记（重启即失效）：审批本来就该是「本机、当下」的决定
  let memory = {};
  // 写盘失败过：此后读以内存为准（否则「批准成功了但 check 还是 no-record」）
  let dirty = false;
  // 写盘失败时被删掉的 taskId：文件里还留着旧记录，读的时候必须遮掉（否则撤销静默失效）
  const tombstones = new Set();

  function readFileAll() {
    if (!file) return {};
    try {
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out = {};
      for (const key of Object.keys(raw)) {
        const item = raw[key];
        if (!item || typeof item !== 'object') continue;
        const at = Number(item.at);
        const fp = asString(item.fp);
        if (!Number.isFinite(at) || !fp) continue;
        out[key] = { at: Math.floor(at), fp };
      }
      return out;
    } catch {
      // 读不到/损坏：当作「没有任何审批」。这是 fail closed 的方向（少批比多批安全）。
      return {};
    }
  }

  function readAll() {
    const fromFile = readFileAll();
    for (const id of tombstones) delete fromFile[id];
    if (!file || !dirty) return fromFile;
    // 写盘失败过：内存里的记录是新的，文件里可能是旧的——按 at 取新的那条
    const out = { ...fromFile };
    for (const [id, item] of Object.entries(memory)) {
      const prev = out[id];
      if (!prev || (item && item.at >= prev.at)) out[id] = item;
    }
    return out;
  }

  function writeAll(all) {
    // 只保留最近 MAX_APPROVALS 条，按 at 降序
    const entries = Object.entries(all)
      .sort((a, b) => (b[1] && b[1].at ? b[1].at : 0) - (a[1] && a[1].at ? a[1].at : 0))
      .slice(0, MAX_APPROVALS);
    const next = Object.fromEntries(entries);
    memory = next;
    if (!file) {
      dirty = false;
      tombstones.clear();
      return { ok: true, file: '' };
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8');
      fsImpl.renameSync(tmp, file);
      dirty = false;
      tombstones.clear();
      return { ok: true, file };
    } catch (err) {
      // 不能假装成功：操作者会以为批过了，而重启后记录消失（第二遍审计 P2-C）。
      log.warn(`agent 审批写盘失败（本次仅在进程内生效，重启即失效）：${(err && err.message) || err}`);
      dirty = true;
      // 对外只回错误码：err.message 里带本机绝对路径（第三遍审计 N2 实测 ENOTDIR 泄漏 stateDir）
      const code = err && err.code ? String(err.code) : '';
      return { ok: false, file, error: code ? `写盘失败（${code}）` : '写盘失败（原因见本机日志）' };
    }
  }

  /** 记一条审批：taskId + 该任务的提示词指纹。 */
  function record(taskId, goal) {
    const id = asString(taskId).trim();
    if (!id) return { ok: false, reason: 'task-id-empty' };
    const all = readAll();
    all[id] = { at: now(), fp: promptFingerprint(goal) };
    tombstones.delete(id);
    const written = writeAll(all);
    return {
      ok: written.ok,
      taskId: id,
      fingerprint: all[id].fp,
      file: written.file,
      ...(written.ok ? {} : { error: written.error, inMemoryOnly: true }),
    };
  }

  /** 撤销：直接按 taskId 删本地记录（不依赖看板里任务还在不在）。 */
  function revoke(taskId) {
    const id = asString(taskId).trim();
    const all = readAll();
    const had = Boolean(all[id]);
    if (!had) {
      // 之前撤销写盘失败时留了 tombstone：内存里没有、文件里可能还在，不能回「已处理」
      if (tombstones.has(id)) {
        return {
          ok: false,
          taskId: id,
          revoked: false,
          inMemoryOnly: true,
          error: '撤销未写进磁盘（重启后记录可能还在）',
        };
      }
      return { ok: true, taskId: id, revoked: false };
    }
    // v2.6.6 复审 M5：同一指纹的记录一起撤 —— 否则 revoke(重派后的新 id)
    // 只删一条，其它同 goal 记录仍会把新任务放行。
    const fp = all[id].fp;
    const removed = Object.keys(all).filter((k) => k === id || (fp && all[k] && all[k].fp === fp));
    for (const k of removed) delete all[k];
    const written = writeAll(all);
    // 写盘失败：记录只在内存里删了，文件里还在——用 tombstone 遮住它们（撤销仍然立即生效）
    if (!written.ok) for (const k of removed) tombstones.add(k);
    // 与 record 对齐：写盘失败不能报成功，否则重启后记录又回来（第三遍审计 P2-C / N3）
    return {
      ok: written.ok,
      taskId: id,
      revoked: true,
      file: written.file,
      ...(written.ok ? {} : { error: written.error, inMemoryOnly: true }),
    };
  }

  /**
   * 审批是否成立：taskId 有记录、未过期、且提示词指纹一致。
   * @returns {{ok: boolean, approved: boolean, required: boolean, reason: string}}
   */
  function check(taskId, goal) {
    const id = asString(taskId).trim();
    const all = readAll();
    const item = id ? all[id] : null;
    if (!item) {
      // v2.6.6：重派会生成新 taskId，审批按“提示词指纹”复用仍有效的记录，
      // 否则 approve → board_retry → 新 id 无记录 → 永远 blocked。
      const fp = promptFingerprint(goal);
      const hit = Object.entries(all).find(([, rec]) => {
        if (!rec || rec.fp !== fp) return false;
        return now() - Number(rec.at || 0) <= ttlMs;
      });
      if (hit) {
        // v2.6.6 复审 M5：把记录迁到新 taskId，使 revoke(新 id) 真的生效；
        // 同时保留原 id 的旧记录（TTL 内仍可复用）。
        if (id && !all[id]) {
          all[id] = { at: Number(hit[1].at || now()), fp };
          writeAll(all);
        }
        return { ok: true, approved: true, required: true, reason: 'approved-fingerprint', viaTaskId: hit[0] };
      }
      return { ok: false, approved: false, required: true, reason: 'no-record' };
    }
    if (now() - item.at > ttlMs) return { ok: false, approved: false, required: true, reason: 'expired' };
    if (item.fp !== promptFingerprint(goal)) {
      return { ok: false, approved: false, required: true, reason: 'fingerprint-mismatch' };
    }
    return { ok: true, approved: true, required: true, reason: 'approved' };
  }

  /**
   * 列出仍然有效的审批（过期的不算：worker_status 里列出「已过期」会让人以为还能派）。
   */
  function list() {
    const all = readAll();
    const at = now();
    return Object.keys(all)
      .filter((id) => at - all[id].at <= ttlMs)
      .map((id) => ({ taskId: id, at: all[id].at, fingerprint: all[id].fp }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 20);
  }

  /** 有效审批的总条数（list 有 20 条展示上限，不能拿来当计数）。 */
  function count() {
    const all = readAll();
    const at = now();
    return Object.keys(all).filter((id) => at - all[id].at <= ttlMs).length;
  }

  return { record, revoke, check, list, count, file, writeFailed: () => dirty };
}
