// ui-write-paths.test.mjs —— v2.6.28（S-15）：UI_WRITE_PATHS 必须覆盖全部写型 UI 路由。
//
// 背景：uiGuard 在 GET/HEAD 打到写型路径时直接以 'method' 拒绝（< img> 型 CSRF
// 不能触发写操作）。旧版只列 3 条，其余写型路由靠 handler 各自 405 —— 少一道纵深。
// 这里把「清单里每个路径 GET 返回 403 且 why=method（既有语义）」钉成断言。
//
// 不联网：apply 用不可达 boardUrl + 假 ctx，只捕获注册进来的 handler 打 GET。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../../lib/index.js';

// v2.6.28：apply 会写 state dir / identity dir，必须隔离到临时目录，不污染本机。
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-wp-'));
process.env.DSH_TEAM_STATE_DIR = STATE_DIR;
const IDENTITY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-wp-id-'));
process.env.DSH_TEAM_IDENTITY_DIR = IDENTITY_DIR;

// 与 lib/index.js 的 UI_WRITE_PATHS 一致（S-15 补齐后的完整清单）。
// 验收要求：对清单里每个路径，GET 返回 403 且 why: 'write-path' 或既有语义（'method'）。
const WRITE_PATHS = [
  '/api/board/ui/assess',
  '/api/board/ui/dispatch-pause',
  '/api/board/ui/say',
  '/api/board/ui/claim',
  '/api/board/ui/release',
  '/api/board/ui/retry',
  '/api/board/ui/untake',
  '/api/board/ui/create',
  '/api/board/ui/attach',
  '/api/board/ui/mark',
  '/api/board/ui/alias',
  '/api/board/ui/machine-alias',
  '/api/board/ui/forget-machine',
  '/api/board/ui/caps-apply',
  '/api/board/ui/stress-test',
  '/api/board/ui/stress-cancel',
  '/api/board/ui/config-diff',
  '/api/board/ui/worker-control',
];

test('UI_WRITE_PATHS：清单里每个路径 GET 返回 403 且 why=method（既有语义）', async () => {
  const routes = new Map();
  const ctx = {
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
      getOrigin: () => 'http://127.0.0.1:9999',
    },
    get: () => null,
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  // boardUrl 不可达：通过闸门后 handler 会自己失败，但不会返回 403。
  const cleanup = apply(ctx, {
    boardUrl: 'http://127.0.0.1:1',
    machine: 'ui-wp-test',
    token: 'x',
    timeoutMs: 300,
    writeTimeoutMs: 300,
    autoDispatch: false,
    petImage: '',
  });
  await new Promise((r) => setTimeout(r, 250));

  try {
    for (const p of WRITE_PATHS) {
      const handler = routes.get(p);
      assert.ok(handler, `路由 ${p} 未注册`);
      const out = await new Promise((resolve) => {
        const req = Readable.from([]);
        req.method = 'GET';
        req.url = p;
        req.headers = { host: '127.0.0.1:2980' };
        const res = {
          status: 0,
          writeHead(code) { this.status = code; return this; },
          setHeader() { return this; },
          end(buf) { resolve({ status: this.status, body: String(buf || '') }); },
        };
        handler(req, res);
      });
      assert.equal(
        out.status,
        403,
        `GET ${p} 应返回 403，实际 ${out.status} body=${out.body.slice(0, 80)}`,
      );
      // 既有语义：uiGuard 对 GET 写路径返回 why='method'（不引入新的 'write-path' 值）。
      assert.ok(
        out.body.includes('method'),
        `GET ${p} 拒绝原因应是 method（既有语义），body=${out.body}`,
      );
    }
  } finally {
    cleanup();
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('UI_WRITE_PATHS：只读路径 GET 不被方法闸拒绝（回归）', async () => {
  const routes = new Map();
  const ctx = {
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
      getOrigin: () => 'http://127.0.0.1:9999',
    },
    get: () => null,
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  const cleanup = apply(ctx, {
    boardUrl: 'http://127.0.0.1:1',
    machine: 'ui-wp-test-2',
    token: 'x',
    timeoutMs: 300,
    writeTimeoutMs: 300,
    autoDispatch: false,
    petImage: '',
  });
  await new Promise((r) => setTimeout(r, 250));

  try {
    // summary 是只读路由，GET 不应被 uiGuard 方法闸挡（会走到 handler，板子不可达 → 非 403）
    const p = '/api/board/ui/summary';
    const handler = routes.get(p);
    assert.ok(handler, `路由 ${p} 未注册`);
    const out = await new Promise((resolve) => {
      const req = Readable.from([]);
      req.method = 'GET';
      req.url = p;
      req.headers = { host: '127.0.0.1:2980' };
      const res = {
        status: 0,
        writeHead(code) { this.status = code; return this; },
        setHeader() { return this; },
        end(buf) { resolve({ status: this.status, body: String(buf || '') }); },
      };
      handler(req, res);
    });
    assert.notEqual(out.status, 403, `只读路由 ${p} 的 GET 不应被方法闸拒绝（403），实际 ${out.status}`);
  } finally {
    cleanup();
    await new Promise((r) => setTimeout(r, 100));
  }
});

fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.rmSync(IDENTITY_DIR, { recursive: true, force: true });