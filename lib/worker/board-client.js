// 看板 HTTP 客户端（薄转发层）。
//
// v2.6.12：通信实现已抽到 lib/worker/transport/http.js，这里只保留对外导出
// （createBoardClient / BoardError）并转发到 transport 层，避免两份 request
// 实现漂移。行为与 transport 层逐字节等价（同 method、path、headers、body
// 字段、返回结构、error 文案）。
//
// 设计要点（与 transport/http.js 一致）：
//   · 所有方法返回 {ok, status, data, error}，**不抛异常**——主循环靠返回值分支，
//     抛异常会变成 unhandled rejection 把常驻进程带走。
//   · 409 = 正常语义（被别人抢了 / 机器不匹配），不当错误打日志。
//   · token 只放 header，绝不进 error 文本、绝不进 URL。
//   · 超时用 AbortController（不用 AbortSignal.timeout：rc.3 某些宿主环境里
//     那个静态方法会在老运行时上不存在，GT14 窄问实测报过）。

import { BoardError, createHttpTransport } from './transport/index.js';

export { BoardError };

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
  return createHttpTransport(opts);
}
