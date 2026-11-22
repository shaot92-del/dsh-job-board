// DSH_RESULT 结果契约（board v2.5.8）
//
// 脚本最后一行打印：
//   DSH_RESULT {"ok":true,"expected":30,"actual":30,"reasons":[]}
//
// worker 取「最后一条」，净化后写进 mark.result。净化规则必须和 board 的
// _clean_result 一致，否则 board 会静默丢弃整份 result（现象：任务完成，看板上
// 却没有指标）。board 侧规则（tools/board_server.py:575-601）：
//   · ok 必须是布尔，缺失 = 整份结果无效
//   · expected/actual 只接受 0..1e12 的数字：整数保留，小数四舍五入到 3 位
//   · reasons 取前 5 条非空字符串，每条截到 120 字符
//
// 另外支持一条可选的产物行（本 worker 的扩展，board 不解析）：
//   DSH_ARTIFACT L:\out\report.html

export const RESULT_PREFIX = 'DSH_RESULT';
export const ARTIFACT_PREFIX = 'DSH_ARTIFACT';
export const MAX_REASONS = 5;
/** 最终落板长度（与 board 侧 120 字符规则一致，由 worker.js 的 maskResult 执行截断）。 */
export const MAX_REASON_CHARS = 120;
/**
 * 净化阶段的输入上限：只防内存放大，**不做最终截断**。
 * 脱敏（maskResult）必须拿到完整的 reason 才能匹配跨边界的 token，
 * 所以这里不能先截到 120 —— 否则 token 跨越边界时被切成残片、掩码匹配失败。
 */
export const MAX_REASON_INPUT_CHARS = 4096;
export const MAX_NUMBER = 1e12;
export const MAX_ARTIFACT_CHARS = 300;

/** 把多行输出拆成行：容忍 \r\n、\r、BOM、空行。 */
export function splitLines(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  return s.split(/\r\n|\r|\n/);
}

function stripPrefix(line, prefix) {
  const t = line.trim();
  if (!t.toUpperCase().startsWith(prefix)) return null;
  return t.slice(prefix.length).trim();
}

/**
 * 解析最后一条 DSH_RESULT。
 * @param {string} stdout
 * @returns {{ found: boolean, raw: string, result: object|null, error: string }}
 */
export function parseDshResult(stdout) {
  const lines = splitLines(stdout);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rest = stripPrefix(lines[i], RESULT_PREFIX);
    if (rest === null) continue;
    const raw = rest;
    if (!raw) return { found: true, raw: '', result: null, error: 'payload-empty' };
    if (!raw.startsWith('{')) {
      return { found: true, raw: raw.slice(0, 200), result: null, error: 'payload-not-json-object' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { found: true, raw: raw.slice(0, 200), result: null, error: `invalid-json: ${(err && err.message) || err}` };
    }
    const result = sanitizeResult(parsed);
    return {
      found: true,
      raw: raw.slice(0, 2000),
      result,
      error: result ? '' : 'shape-invalid',
    };
  }
  return { found: false, raw: '', result: null, error: 'not-found' };
}

/** 数字净化：与 board 的 0..1e12 规则对齐；非法返回 undefined（而不是 0）。 */
export function cleanNumber(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > MAX_NUMBER) return undefined;
  return Number.isInteger(n) ? n : Math.round(n * 1000) / 1000;
}

/**
 * 净化结果对象，规则与 board `_clean_result` 一致；不合法返回 null。
 * @param {unknown} raw
 * @returns {{ok: boolean, expected?: number, actual?: number, reasons?: string[]} | null}
 */
export function sanitizeResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.ok !== 'boolean') return null;
  const out = { ok: raw.ok };
  const expected = cleanNumber(raw.expected);
  if (expected !== undefined) out.expected = expected;
  const actual = cleanNumber(raw.actual);
  if (actual !== undefined) out.actual = actual;
  if (Array.isArray(raw.reasons)) {
    const reasons = [];
    for (const item of raw.reasons) {
      if (typeof item !== 'string') continue;
      const t = item.trim().replace(/[\r\n]+/g, ' ');
      if (!t) continue;
      reasons.push(t.slice(0, MAX_REASON_INPUT_CHARS));
      if (reasons.length >= MAX_REASONS) break;
    }
    if (reasons.length) out.reasons = reasons;
  }
  return out;
}

/** 解析最后一条 DSH_ARTIFACT（可选产物路径/标识）。 */
export function parseDshArtifact(stdout) {
  const lines = splitLines(stdout);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rest = stripPrefix(lines[i], ARTIFACT_PREFIX);
    if (rest === null) continue;
    const t = rest.replace(/[\r\n]+/g, ' ').trim();
    if (!t) return '';
    return t.slice(0, MAX_ARTIFACT_CHARS);
  }
  return '';
}

/** 给 note 用的一行摘要（不含换行，长度可控）。 */
export function formatResultSummary(result) {
  if (!result) return 'result=none';
  const parts = [`result=${result.ok ? 'ok' : 'not-ok'}`];
  if (result.expected !== undefined) parts.push(`expected=${result.expected}`);
  if (result.actual !== undefined) parts.push(`actual=${result.actual}`);
  if (Array.isArray(result.reasons) && result.reasons.length) {
    parts.push(`reasons=${result.reasons.length}`);
  }
  return parts.join(' ');
}
