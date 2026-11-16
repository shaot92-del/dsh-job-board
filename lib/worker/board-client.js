// 看板 HTTP 客户端：只认 handoff 里那 6 个端点，不猜、不重试、不缓存。
//
// 设计要点：
//   · 所有方法返回 {ok, status, data, error}，**不抛异常**——主循环靠返回值分支，
//     抛异常会变成 unhandled rejection 把常驻进程带走。
//   · 409 是正常语义（被别人抢了 / 机器不匹配），不当错误打日志。
//   · token 只放 header，绝不进 error 文本、绝不进 URL。
//   · 超时用 AbortController（不用 AbortSignal.timeout：rc.3 某些宿主环境里
//     那个静态方法会在老运行时上不存在，GT14 窄问实测报过）。

export class BoardError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'BoardError';
    this.status = opts.status || 0;
    this.network = Boolean(opts.network);
  }
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const p = String(path || '');
  return `${base}${p.startsWith('/') ? p : '/' + p}`;
}

function describeError(data, status) {
  const detail = data && typeof data === 'object' ? data.error || data.message : '';
  if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 300);
  return `HTTP ${status}`;
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
export function createBoardClient(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').trim();
  if (!baseUrl) throw new BoardError('boardUrl 为空');
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 8000;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  const userAgent = String(opts.userAgent || 'dsh-job-board/2.6.5');
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
    timer.unref?.();

    try {
      const res = await fetchImpl(url, { method, headers, body: payload, signal: controller.signal });
      const text = await res.text();
      let data = null;
      if (text && text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: `非 JSON 响应：${text.slice(0, 160)}` };
        }
      }
      const ok = Boolean(res.ok) && !(data && typeof data === 'object' && data.ok === false);
      return {
        ok,
        status: Number(res.status) || 0,
        data,
        error: ok ? '' : describeError(data, res.status),
      };
    } catch (err) {
      const aborted = (err && (err.name === 'AbortError' || err.message === 'timeout')) || false;
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
    /** 是否带 token（只回布尔，绝不回 token 本身） */
    hasToken: Boolean(token),

    health: () => get('/api/health'),
    snapshot: () => get('/api/board'),

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
      if (params.result !== undefined) body.result = params.result;
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
