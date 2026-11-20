// 看板 HTTP 传输层：只认 handoff 里那 6 个端点，不猜、不重试、不缓存。
//
// v2.6.12 从 lib/worker/board-client.js 抽出本层，使主循环的看板通信可替换。
// 行为与抽离前的 createBoardClient 逐字节等价（同 method、path、headers、
// body 字段、返回结构、error 文案）。board-client.js 现在是本层的薄转发。
//
// 设计要点：
//   · 所有方法返回 {ok, status, data, error}，**不抛异常**——主循环靠返回值分支，
//     抛异常会变成 unhandled rejection 把常驻进程带走。
//   · 409 = 正常语义（被别人抢了 / 机器不匹配），不当错误打日志。
//   · token 只放 header，绝不进 error 文本、绝不进 URL。
//   · 超时用 AbortController（不用 AbortSignal.timeout：rc.3 某些宿主环境里
//     那个静态方法会在老运行时上不存在，GT14 窄问实测报过）。

import { VERSION } from '../version.js';

export class BoardError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'BoardError';
    this.status = opts.status || 0;
    this.network = Boolean(opts.network);
  }
}

/**
 * 拼接 baseUrl 与 path。
 * v2.6.28（安全审计 C-20）：旧实现用字符串拼接 `base + path`，baseUrl 带路径前缀
 * （如 `http://host/prefix`）时行为不确定（前缀被吃或双斜杠）。改用 `new URL` 规范化。
 * 空 baseUrl 保持旧行为（返回以 / 开头的 path），不抛 Invalid URL。
 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').trim();
  const p = String(path || '');
  if (!base) return p.startsWith('/') ? p : '/' + p;
  const normalizedBase = base.endsWith('/') ? base : base + '/';
  const normalizedPath = p.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}

/** mark 的 result 尺寸上限（v2.6.28 安全审计 C-21）。 */
const MAX_MARK_RESULT_BYTES = 4096;

/**
 * mark 前裁剪 result：只保留 ok/expected/actual/reasons，JSON 序列化后超 4 KiB
 * 截断并标注 truncated: true（v2.6.28 安全审计 C-21）。
 */
function sanitizeMarkResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const filtered = {};
  if (typeof result.ok === 'boolean') filtered.ok = result.ok;
  for (const key of ['expected', 'actual']) {
    const n = Number(result[key]);
    if (Number.isFinite(n) && n >= 0 && n <= 1e12) filtered[key] = n;
  }
  if (Array.isArray(result.reasons)) {
    const reasons = result.reasons.filter((r) => typeof r === 'string' && r.trim()).slice(0, 5);
    if (reasons.length) filtered.reasons = reasons;
  }
  let json = JSON.stringify(filtered);
  if (Buffer.byteLength(json, 'utf8') > MAX_MARK_RESULT_BYTES) {
    filtered.truncated = true;
    while (Array.isArray(filtered.reasons) && filtered.reasons.length > 0) {
      json = JSON.stringify(filtered);
      if (Buffer.byteLength(json, 'utf8') <= MAX_MARK_RESULT_BYTES) break;
      filtered.reasons.pop();
    }
    json = JSON.stringify(filtered);
    if (Buffer.byteLength(json, 'utf8') > MAX_MARK_RESULT_BYTES) {
      const buf = Buffer.from(json, 'utf8');
      return buf.subarray(0, MAX_MARK_RESULT_BYTES).toString('utf8');
    }
  }
  return filtered;
}
function describeError(data, status) {
  const detail = data && typeof data === 'object' ? data.error || data.message : '';
  if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 300);
  return `HTTP ${status}`;
}

/**
 * 响应正文尺寸上限（v2.6.17）。
 *
 * 以前直接 `await res.text()`：被劫持 / 被替换的看板回一个 200 + 80 MiB 正文，
 * worker 会先把它整个读进内存再 JSON.parse —— 一次就够把 8 GB 的副机搞崩
 * （v2.6.16 独立审计实测「80 MiB 可读」）。正常看板快照是几百 KB 量级。
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function tooLargeMessage(limit, actual) {
  return `响应过大（${actual > 0 ? `${actual} 字节` : '正文'}，上限 ${limit} 字节）`;
}

/**
 * 带上限地读正文。优先按流读（content-length 可以撒谎或被省略），
 * 没有 body 流（少数 fetch 实现 / 测试桩）时退回 text() 再量字节。
 */
async function readTextCapped(res, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(tooLargeMessage(limit, declared));
  }
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // v2.6.28（安全审计 S-16）：fallback 也走流式/限长——旧实现先 `await res.text()`
    // 读全量再判大小，被劫持板子可打满宿主内存。这里用数组缓冲分块读，累计判上限。
    const chunks = [];
    let total = 0;
    const reader = body && typeof body[Symbol.asyncIterator] === 'function'
      ? body
      : null;
    if (reader) {
      try {
        for await (const value of reader) {
          const buf = Buffer.from(value);
          total += buf.length;
          if (total > limit) throw new Error(tooLargeMessage(limit, total));
          chunks.push(buf);
        }
        return Buffer.concat(chunks).toString('utf8');
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('响应过大')) throw err;
        // 流式读失败（不完整/已取消）：退回 text() 兜底，但 text() 仍可能读全量——
        // 这是最后手段，只在流迭代器不可用或抛非尺寸错误时走。
      }
    }
    const text = await res.text();
    const size = Buffer.byteLength(text, 'utf8');
    if (size > limit) throw new Error(tooLargeMessage(limit, size));
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      total += buf.length;
      if (total > limit) throw new Error(tooLargeMessage(limit, total));
      chunks.push(buf);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已经读完 / 已取消 */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {{
 *   baseUrl: string,
 *   token?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: Function,
 *   userAgent?: string,
 * }} opts
 */
export function createHttpTransport(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').trim();
  if (!baseUrl) throw new BoardError('boardUrl 为空');
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 8000;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  // v2.6.13：UA 不再写死版本号（以前发版漏改会一直报旧版本），统一取 version.js
  const userAgent = String(opts.userAgent || `dsh-job-board/${VERSION}`);
  if (typeof fetchImpl !== 'function') throw new BoardError('当前运行时没有 fetch（需要 Node 22+）');

  async function request(method, path, body) {
    const url = joinUrl(baseUrl, path);
    const headers = { accept: 'application/json', 'user-agent': userAgent };
    if (token) headers['x-board-token'] = token;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('timeout'));
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    // v2.6.13：去掉 timer.unref()。独立进程里只有这一条请求在飞时，unref 的定时器
    // 不参与保活，超时兜底可能在响应落地前就被事件循环丢掉。timer 在 finally 里清，
    // 不会泄漏。

    try {
      // v2.6.17：redirect:'error'。fetch 默认跟随 302，而 Node/undici 只剥
      // Authorization / Cookie，自定义的 x-board-token 会原样跟到新 origin ——
      // 被劫持或被替换的看板只要回一个 302 就能拿到看板全权 token
      // （v2.6.16 审计实测复现）。看板自己的端点不需要重定向。
      const res = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await readTextCapped(res);
      let data = null;
      // 解析失败要单独记：v2.6.12 起这里的 ok 只看 data.ok===false，而
      // `{error:'非 JSON 响应…'}` 没有 ok 字段 ⇒ 200 + 垃圾正文会被算成成功，
      // 主循环会拿一个空快照当「板子正常」（v2.6.12 修，transport.test 抓到）。
      let parseFailed = false;
      if (text && text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          parseFailed = true;
          data = { error: `非 JSON 响应：${text.slice(0, 160)}` };
        }
      }
      const ok = Boolean(res.ok) && !parseFailed && !(data && typeof data === 'object' && data.ok === false);
      return {
        ok,
        status: Number(res.status) || 0,
        data,
        error: ok ? '' : describeError(data, res.status),
      };
    } catch (err) {
      // v2.6.27（安全审计 P1，主代理实测 Node 24.22.2）：
      // controller.abort(new Error('timeout')) 之后 fetch 抛的是 TypeError: fetch failed，
      // 旧的 name/message 判定全落空，超时被文案成"请求失败"。
      // 这里把「信号已 abort」作为最可靠的判据（signal.aborted 在 abort 后恒真）。
      const signalAborted = Boolean(controller && controller.signal && controller.signal.aborted);
      const aborted = signalAborted
        || (err && (err.name === 'AbortError' || err.message === 'timeout' || (err.name === 'TypeError' && /fetch failed/i.test(String(err.message || '')) && signalAborted)))
        || false;
      const message = aborted
        ? `请求超时（${timeoutMs}ms）`
        : `请求失败：${(err && (err.code || err.message)) || err}`;
      return { ok: false, status: 0, data: null, error: message.slice(0, 300), network: true };
    } finally {
      clearTimeout(timer);
    }
  }

  const post = (path, body) => request('POST', path, body || {});
  const get = (path) => request('GET', path);

  return {
    baseUrl,
    hasToken: Boolean(token),
    health: () => get('/api/health'),

    /**
     * 看板快照。
     *
     * v2.6.13：空正文（204 / 空 200）不再算成功。request() 的 ok 只看
     * data.ok===false，data=null 时它是 true ⇒ 主循环会把「没有任何任务」当正常
     * （worker.js 的 snapshot 分支用 snap.data && snap.data.tasks）。快照必须是
     * JSON 对象，否则按失败处理，让主循环走 backoff 而不是空转。
     * 注意：tasks 允许是数组或 map（taskList 两种都吃），这里只卡「正文是不是对象」。
     */
    async snapshot() {
      const r = await get('/api/board');
      if (r.ok && (!r.data || typeof r.data !== 'object')) {
        return { ok: false, status: r.status, data: r.data, error: '看板快照为空（响应正文不是 JSON 对象）' };
      }
      return r;
    },

    /**
     * 认领任务。holder = 本实例唯一 id，用于同机多实例互斥。
     * 409 = 已被别人占了（正常竞态），不是错误。
     */
    claim(params = {}) {
      const body = { task_id: params.taskId, machine: params.machine };
      if (params.holder) body.holder = params.holder;
      if (Number.isFinite(params.minutes)) body.minutes = params.minutes;
      if (params.note) body.note = String(params.note).slice(0, 200);
      return post('/api/claim', body);
    },

    /** 续租；claimed→running 由 board 侧顺带完成。 */
    beat(params = {}) {
      const body = { task_id: params.taskId, machine: params.machine };
      if (params.holder) body.holder = params.holder;
      if (Number.isFinite(params.minutes)) body.minutes = params.minutes;
      if (params.progress) body.progress = String(params.progress).slice(0, 200);
      return post('/api/beat', body);
    },

    /**
     * 写状态/结果。result 必须是 sanitizeResult 产物（board 对非法 shape 会整份丢弃）。
     * status=queued 会连带清空 result/taker/holder/lease（用于 requeue）。
     */
    mark(params = {}) {
      const body = { task_id: params.taskId, machine: params.machine, status: params.status };
      if (params.holder) body.holder = params.holder;
      if (params.note !== undefined) body.note = String(params.note).slice(0, 500);
      if (params.result !== undefined) body.result = sanitizeMarkResult(params.result);
      if (params.artifact !== undefined) body.artifact = String(params.artifact).slice(0, 300);
      if (params.dispatch !== undefined) body.dispatch = params.dispatch;
      return post('/api/mark', body);
    },

    /** 释放认领（把任务放回可认领状态，board 侧实现为 status=queued）。 */
    release(params = {}) {
      const body = { task_id: params.taskId, machine: params.machine };
      if (params.holder) body.holder = params.holder;
      return post('/api/release', body);
    },

    /** 上报机器能力（可选；看板派工时用） */
    caps(params = {}) {
      const body = { machine: params.machine };
      if (params.caps && typeof params.caps === 'object') body.caps = params.caps;
      return post('/api/caps', body);
    },

    metrics(params = {}) {
      const body = { machine: params.machine };
      if (params.metrics && typeof params.metrics === 'object') body.metrics = params.metrics;
      return post('/api/metrics', body);
    },
  };
}
