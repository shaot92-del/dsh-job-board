// doctor-hub-nodes.test.mjs —— v2.7.0（W4）：doctor 的 hub /nodes 探测时序。
//
// 现象：DSH 刚启动时宿主 webServer 还没 listen，getOrigin() 会抛，doctor 于是把
// 「探测早于 listen」误报成 error（「hub /nodes 不可用：webServer.getOrigin() 不可用」），
// 几秒后刷新又消失。功能本身没坏。
//
// 三条断言：
//   1) getOrigin 前两次抛错（listen 前）后成功 ⇒ 最终 checks 里没有 error 级 hub-nodes；
//   2) getOrigin 一直不可用 ⇒ hub-nodes 降级为 info 且带「启动早期探测」提示，不是 error；
//   3) cordis.patch.yml 的 mtime 晚于本进程启动 ⇒ config-restart-pending 给 warn。
//
// 不联网：fetch 被替换成假实现，boardUrl 指向不可达端口；state/identity 目录隔离到临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../../lib/index.js';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-hub-'));
process.env.DSH_TEAM_STATE_DIR = STATE_DIR;
const IDENTITY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-hub-id-'));
process.env.DSH_TEAM_IDENTITY_DIR = IDENTITY_DIR;

const TEMP_DIRS = [STATE_DIR, IDENTITY_DIR];

/** 假 fetch：/nodes 与板子快照都回同一份「看起来正常」的 JSON。 */
function stubFetch() {
  const original = globalThis.fetch;
  const body = JSON.stringify({
    ok: true,
    nodes: [{ nodeId: 'desk-1', url: 'http://127.0.0.1:19387' }],
    machines: {},
    tasks: {},
    counts: {},
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
  });
  return () => {
    globalThis.fetch = original;
  };
}

function makeCtx(getOrigin) {
  const routes = new Map();
  const ctx = {
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
      getOrigin,
    },
    get: () => null,
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
  return { routes, ctx };
}

/** 调 doctor handler，拿解析后的 JSON。 */
async function readDoctor(handler) {
  const out = await new Promise((resolve) => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/api/board/ui/doctor';
    req.headers = { host: '127.0.0.1:2980' };
    const res = {
      status: 0,
      writeHead(code) {
        this.status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      end(buf) {
        resolve({ status: this.status, body: String(buf || '') });
      },
    };
    handler(req, res);
  });
  assert.equal(out.status, 200, 'doctor 应返回 200，实际 ' + out.status + ' body=' + out.body.slice(0, 120));
  return JSON.parse(out.body);
}

function baseConfig(extra) {
  return Object.assign(
    {
      boardUrl: 'http://127.0.0.1:1',
      machine: 'doc-hub-test',
      token: 'x',
      timeoutMs: 300,
      writeTimeoutMs: 300,
      autoDispatch: false,
      petImage: '',
    },
    extra || {},
  );
}

test('getOrigin 前两次抛错后成功 ⇒ 最终 checks 里没有 error 级 hub-nodes', async () => {
  const restoreFetch = stubFetch();
  let originCalls = 0;
  const { routes, ctx } = makeCtx(() => {
    originCalls += 1;
    // 模拟「Host 还没 listen」：前两次 getOrigin() 抛，之后正常。
    if (originCalls <= 2) throw new Error('webServer 还没 listen');
    return 'http://127.0.0.1:9999';
  });
  const cleanup = apply(ctx, baseConfig({ doctorHubRetryMs: 20 }));
  await new Promise((r) => setTimeout(r, 150));
  try {
    const handler = routes.get('/api/board/ui/doctor');
    assert.ok(handler, 'doctor 路由未注册');
    const json = await readDoctor(handler);
    const hub = (json.checks || []).filter((c) => c.id === 'hub-nodes');
    assert.ok(originCalls >= 3, 'getOrigin 至少要被问 3 次（首次 + 等待 + 重试），实际 ' + originCalls);
    assert.equal(
      hub.filter((c) => c.level === 'error').length,
      0,
      'hub-nodes 不应出现 error：' + JSON.stringify(hub),
    );
  } finally {
    cleanup();
    restoreFetch();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('getOrigin 一直不可用 ⇒ hub-nodes 降级为 info（不是 error）', async () => {
  const restoreFetch = stubFetch();
  const { routes, ctx } = makeCtx(() => {
    throw new Error('webServer 还没 listen');
  });
  const cleanup = apply(ctx, baseConfig({ doctorHubRetryMs: 10 }));
  await new Promise((r) => setTimeout(r, 150));
  try {
    const handler = routes.get('/api/board/ui/doctor');
    assert.ok(handler, 'doctor 路由未注册');
    const json = await readDoctor(handler);
    const hub = (json.checks || []).filter((c) => c.id === 'hub-nodes');
    assert.equal(hub.filter((c) => c.level === 'error').length, 0, 'listen 前的探测不应是 error：' + JSON.stringify(hub));
    const info = hub.find((c) => c.level === 'info');
    assert.ok(info, '应有 info 级 hub-nodes：' + JSON.stringify(hub));
    assert.ok(
      String(info.hint || '').includes('启动早期探测'),
      'info 记录应带「启动早期探测」提示，实际 hint=' + String(info.hint || ''),
    );
  } finally {
    cleanup();
    restoreFetch();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('cordis.patch.yml 比进程启动还新 ⇒ config-restart-pending 给 warn', async () => {
  const restoreFetch = stubFetch();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-profile-'));
  TEMP_DIRS.push(profileDir);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, '- id: team\n');
  const future = new Date(Date.now() + 60 * 1000);
  fs.utimesSync(patchFile, future, future);

  const { routes, ctx } = makeCtx(() => 'http://127.0.0.1:9999');
  const cleanup = apply(ctx, baseConfig({ profileDir }));
  await new Promise((r) => setTimeout(r, 120));
  try {
    const handler = routes.get('/api/board/ui/doctor');
    assert.ok(handler, 'doctor 路由未注册');
    const json = await readDoctor(handler);
    const pending = (json.checks || []).filter((c) => c.id === 'config-restart-pending');
    assert.equal(pending.length, 1, '应有一条 config-restart-pending：' + JSON.stringify(pending));
    assert.equal(pending[0].level, 'warn', 'config-restart-pending 应为 warn：' + JSON.stringify(pending[0]));
    assert.ok(/重启/.test(String(pending[0].hint || '')), 'hint 应提示重启 DSH：' + String(pending[0].hint || ''));
  } finally {
    cleanup();
    restoreFetch();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('没有 cordis.patch.yml ⇒ 不报 config-restart-pending', async () => {
  const restoreFetch = stubFetch();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-profile-empty-'));
  TEMP_DIRS.push(profileDir);
  const { routes, ctx } = makeCtx(() => 'http://127.0.0.1:9999');
  const cleanup = apply(ctx, baseConfig({ profileDir }));
  await new Promise((r) => setTimeout(r, 120));
  try {
    const handler = routes.get('/api/board/ui/doctor');
    assert.ok(handler, 'doctor 路由未注册');
    const json = await readDoctor(handler);
    const pending = (json.checks || []).filter((c) => c.id === 'config-restart-pending');
    assert.equal(pending.length, 0, '没有 patch 文件时不应误报：' + JSON.stringify(pending));
  } finally {
    cleanup();
    restoreFetch();
    await new Promise((r) => setTimeout(r, 50));
  }
});

process.on('exit', () => {
  for (const d of TEMP_DIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});