// 看板传输层统一出口。
// 主循环只认 createTransport；board-client.js 是本层的薄转发，避免两份
// request 实现漂移。
import { BoardError, createHttpTransport } from './http.js';

export { BoardError, createHttpTransport };

export function createTransport(opts = {}) {
  return createHttpTransport(opts);
}
