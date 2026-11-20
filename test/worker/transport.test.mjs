// 看板 HTTP 传输层契约测试。
// 用 node:http 起本地假看板，只测 createHttpTransport 的对外行为，不测
// 主循环。运行：node --test test/worker/transport.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { test, after } from 'node:test';

import { createHttpTransport, BoardError } from '../../lib/worker/transport/index.js';
import { createBoardClient } from '../../lib/worker/board-client.js';
import { VERSION } from '../../lib/worker/version.js';

// 假看板必须无论如何都被关掉：断言失败会跳过测试末尾的 `await fb.close()`，
// 于是监听中的 server 一直握着事件循环，`node --test` 永远不退出
// （v2.6.11 的 gate 就是被这一条卡住的：测试挂了却表现为「卡住」）。
// 这里用 after 钩子兜底：任何一个测试抛错，跑完剩下的用例后统一关闭。
const openBoards = new Set();
after(async () => {
  for (const fb of openBoards) await fb.close();
});

function startFakeBoard(handler) {
  const last = { req: null };
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      last.req = { method: req.method, url: req.url, headers: req.headers, body };
      try {
        handler(req, res, body);
      } catch {
        /* ignore */
      }
    });
    req.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const board = {
        url: `http://127.0.0.1:${port}`,
        last,
        close: () => new Promise((r) => {
          openBoards.delete(board);
          server.closeAllConnections();
          server.close(r);
        }),
      };
      openBoards.add(board);
      resolve(board);
    });
  });
}

function jsonRes(res, status, obj) {
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(body);
  } catch {
    /* socket closed */
  }
}

test('snapshot 成功：200 + JSON → ok:true, status:200, data 原样', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 200, { tasks: { a: 1 } }));
  const t = createHttpTransport({ baseUrl: fb.url, token: '' });
  const r = await t.snapshot();
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { tasks: { a: 1 } });
  await fb.close();
});

test('有 token：请求头出现 x-board-token', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 200, {}));
  const t = createHttpTransport({ baseUrl: fb.url, token: 'tok-abc' });
  await t.snapshot();
  assert.equal(fb.last.req.headers['x-board-token'], 'tok-abc');
  await fb.close();
});

test('无 token：请求头没有 x-board-token', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 200, {}));
  const t = createHttpTransport({ baseUrl: fb.url });
  await t.snapshot();
  assert.equal(fb.last.req.headers['x-board-token'], undefined);
  await fb.close();
});

test('非 JSON 响应：ok:false, error 含「非 JSON 响应」', async () => {
  const fb = await startFakeBoard((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    res.end('not json');
  });
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.match(r.error, /非 JSON 响应/);
  await fb.close();
});

// v2.6.28（安全审计 S-16）：readTextCapped 的 res.text() fallback 先读全量再判大小。
// 这里用注入的 fetchImpl 返回无 getReader 的 body 但有 asyncIterator 的响应，
// 验证 fallback 走流式分块读并判上限，不把整个正文读进内存。
test('响应过大（fallback 无 getReader、有 asyncIterator、流式超限）→ ok:false, error 含「响应过大」', async () => {
  const chunk = 'x'.repeat(256 * 1024);
  const totalBytes = 9 * 1024 * 1024;
  let produced = 0;
  const asyncIterableBody = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (produced >= totalBytes) return Promise.resolve({ done: true });
          const take = Math.min(chunk.length, totalBytes - produced);
          produced += take;
          return Promise.resolve({ done: false, value: chunk.slice(0, take) });
        },
      };
    },
  };
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: asyncIterableBody,
    text: async () => { throw new Error('text() should not be called when asyncIterator is available'); },
  });
  const t = createHttpTransport({ baseUrl: 'http://127.0.0.1:1', fetchImpl: fakeFetch });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.match(r.error, /响应过大/);
});

test('204 空正文：snapshot 判失败，不再当「板子正常」（v2.6.13）', async () => {
  const fb = await startFakeBoard((req, res) => {
    res.writeHead(204, { connection: 'close' });
    res.end();
  });
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.match(r.error, /快照为空/);
  await fb.close();
});

test('默认 UA 带插件版本（v2.6.13 起不写死字面量）', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 200, { tasks: [] }));
  const t = createHttpTransport({ baseUrl: fb.url });
  await t.snapshot();
  assert.equal(fb.last.req.headers['user-agent'], `dsh-job-board/${VERSION}`);
  await fb.close();
});

test('HTTP 401 + {error:unauthorized}：ok:false, status:401, error=unauthorized', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 401, { error: 'unauthorized' }));
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.error, 'unauthorized');
  await fb.close();
});

test('200 + {ok:false,error:nope}：ok:false, error=nope', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 200, { ok: false, error: 'nope' }));
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'nope');
  await fb.close();
});

test('409 原样保留：ok:false, status:409, 不改写成网络错误', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 409, { error: 'conflict' }));
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.claim({ taskId: 't1', machine: 'm1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error, 'conflict');
  assert.notEqual(r.network, true);
  await fb.close();
});

test('超时：timeoutMs:50 + 不响应 → ok:false, network:true, error 含「请求超时」', async () => {
  const fb = await startFakeBoard((req, res) => {
    // 不响应，让客户端超时；closeAllConnections 会关掉这个连接。
  });
  const t = createHttpTransport({ baseUrl: fb.url, timeoutMs: 50 });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.equal(r.network, true);
  assert.match(r.error, /请求超时/);
  await fb.close();
});

test('createBoardClient 与 createHttpTransport 公开方法集合一致（>=7 方法）', () => {
  const t = createHttpTransport({ baseUrl: 'http://127.0.0.1:1' });
  const c = createBoardClient({ baseUrl: 'http://127.0.0.1:1' });
  const tk = Object.keys(t).sort();
  const ck = Object.keys(c).sort();
  assert.deepEqual(tk, ck);
  assert.ok(tk.length >= 7, `方法数 ${tk.length} < 7`);
});

test('body 字段裁剪：claim note 200 / mark note 500 / mark artifact 300 / beat progress 200', async () => {
  const fb = await startFakeBoard((req, res) => jsonRes(res, 200, {}));
  const t = createHttpTransport({ baseUrl: fb.url });

  await t.claim({ taskId: 't', machine: 'm', note: 'x'.repeat(300) });
  assert.equal(JSON.parse(fb.last.req.body).note.length, 200);

  await t.mark({ taskId: 't', machine: 'm', status: 'done', note: 'x'.repeat(600) });
  assert.equal(JSON.parse(fb.last.req.body).note.length, 500);

  await t.mark({ taskId: 't', machine: 'm', status: 'done', artifact: 'x'.repeat(400) });
  assert.equal(JSON.parse(fb.last.req.body).artifact.length, 300);

  await t.beat({ taskId: 't', machine: 'm', progress: 'x'.repeat(300) });
  assert.equal(JSON.parse(fb.last.req.body).progress.length, 200);

  await fb.close();
});

test('BoardError：空 baseUrl 抛 BoardError', () => {
  assert.throws(() => createHttpTransport({ baseUrl: '' }), BoardError);
  assert.throws(() => createBoardClient({ baseUrl: '' }), BoardError);
});

test("redirect: 'error'：令牌不跟 302 走（审计 P1-1 回归）", async () => {
  // 用注入的 fetchImpl 断言选项：真 server 上无法观察到「fetch 是否跟随」。
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = opts;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"ok":true}',
    };
  };
  const t = createHttpTransport({ baseUrl: 'http://127.0.0.1:9', token: 'tok-secret', fetchImpl: fakeFetch });
  const r = await t.snapshot();
  assert.equal(r.ok, true);
  assert.equal(seen.redirect, 'error', '必须显式禁止跟随重定向');
  assert.equal(seen.headers['x-board-token'], 'tok-secret');
});

test('响应过大（content-length 声明超限）→ ok:false, error 含「响应过大」', async () => {
  const fb = await startFakeBoard((req, res) => {
    try {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(9000000), connection: 'close' });
      res.end('{}');
    } catch {
      /* socket closed */
    }
  });
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.match(r.error, /响应过大/);
  await fb.close();
});

test('响应过大（无 content-length、流式超限）→ ok:false, 不把正文整个读进来', async () => {
  const fb = await startFakeBoard((req, res) => {
    try {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      const chunk = 'x'.repeat(256 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 9 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    } catch {
      /* socket closed */
    }
  });
  const t = createHttpTransport({ baseUrl: fb.url });
  const r = await t.snapshot();
  assert.equal(r.ok, false);
  assert.match(r.error, /响应过大/);
  await fb.close();
});