#!/usr/bin/env node
// 假看板：给 dsh-worker 做离线联调用的最小 board 实现。
//
// 为什么不用 dsh-job-board 自带的 scripts/fake-board.mjs：那个带一堆
// remote-agent hub 的替身路由，而且**没有 token 校验**——worker 的鉴权路径
// 就永远测不到。这里只实现 worker 真正会调的 6 个端点，语义按
// tools/board_server.py 的真实 board 对齐（尤其是 409 的几种分支）。
//
// 用法：
//   node scripts/fake-board.mjs --port 8977 --token devtoken
//   node scripts/fake-board.mjs --port 8977 --bind 0.0.0.0 --state ./tmp/board.json
//
// 作为模块：
//   import { startFakeBoard } from './scripts/fake-board.mjs'
//   const board = await startFakeBoard({ token: 'devtoken' })

import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FAKE_BOARD_VERSION = '0.1.0';
const DEFAULT_MINUTES = 10;
const NOTE_MAX = 500;
const MAX_NUMBER = 1e12;

const STATUSES = new Set(['queued', 'claimed', 'running', 'done', 'failed', 'blocked', 'superseded', 'stale']);
const CREATE_FIELDS = ['task_id', 'goal', 'machine', 'title', 'note', 'dispatch', 'mode', 'workspace', 'model'];

function txt(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

function nowSec() {
  return Date.now() / 1000;
}

// 与 board_server.py:_clean_result 等价
export function cleanResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.ok !== 'boolean') return null;
  const out = { ok: value.ok };
  for (const key of ['expected', 'actual']) {
    const n = typeof value[key] === 'number' ? value[key] : Number(value[key]);
    if (!Number.isFinite(n) || n < 0 || n > MAX_NUMBER) continue;
    out[key] = Number.isInteger(n) ? n : Math.round(n * 1000) / 1000;
  }
  if (Array.isArray(value.reasons)) {
    const reasons = value.reasons
      .filter((x) => typeof x === 'string' && x.trim())
      .slice(0, 5)
      .map((x) => txt(x.trim(), 120));
    if (reasons.length) out.reasons = reasons;
  }
  return out;
}

function canonMachine(m) {
  return String(m || '').trim().toLowerCase();
}

export function createFakeBoard(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const state = {
    tasks: options.tasks && typeof options.tasks === 'object' ? options.tasks : {},
    machines: {},
    caps: {},
    metrics: {},
    events: [],
    updated: nowSec(),
    calls: { claim: 0, beat: 0, mark: 0, release: 0, create: 0, board: 0 },
  };

  const touch = (text, extra = {}) => {
    state.events.push({ at: nowSec(), text, ...extra });
    while (state.events.length > 30) state.events.shift();
    state.updated = nowSec();
  };

  const counts = () => {
    const out = {};
    for (const t of Object.values(state.tasks)) {
      const s = String(t.status || 'queued');
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  };

  function claim(body = {}) {
    const id = String(body.task_id || '');
    const machine = String(body.machine || '');
    if (!id || !machine) return { status: 400, body: { error: 'task_id 与 machine 必填' } };
    const task = state.tasks[id];
    if (!task) return { status: 404, body: { error: '没有这个任务' } };
    const holder = String(body.holder || machine);
    if (['claimed', 'running'].includes(String(task.status))) {
      if (String(task.holder || '') !== holder) {
        return {
          status: 409,
          body: { error: '已被占用', holder: task.holder || '', lease_until: task.lease_until || 0, note: task.note || '' },
        };
      }
    } else if (['done', 'failed', 'blocked', 'superseded', 'stale'].includes(String(task.status))) {
      return { status: 409, body: { error: `任务已结束（${task.status}）` } };
    }
    const minutes = Number(body.minutes) > 0 ? Number(body.minutes) : DEFAULT_MINUTES;
    task.status = 'claimed';
    task.machine = machine;
    task.holder = holder;
    task.owner = task.owner || 'board_dispatch';
    task.agent = task.agent || 'board_dispatch';
    task.claimed_at = nowSec();
    task.lease_until = nowSec() + minutes * 60;
    task.updated_at = nowSec();
    task.progress = '';
    task.artifact = task.artifact || '';
    if (body.note) task.note = txt(body.note, NOTE_MAX);
    delete task.taker;
    touch(`claim ${id} by ${machine}`);
    return { status: 200, body: { ok: true, task_id: id, lease_until: task.lease_until, holder } };
  }

  function beat(body = {}) {
    const id = String(body.task_id || '');
    const task = state.tasks[id];
    if (!task) return { status: 404, body: { error: '没有这个任务' } };
    if (body.machine && canonMachine(task.machine) && canonMachine(body.machine) !== canonMachine(task.machine)) {
      return { status: 409, body: { error: '不是你占的', machine: task.machine } };
    }
    const minutes = Number(body.minutes) > 0 ? Number(body.minutes) : DEFAULT_MINUTES;
    task.lease_until = nowSec() + minutes * 60;
    task.updated_at = nowSec();
    if (String(task.status) === 'claimed') task.status = 'running';
    if (body.progress !== undefined) task.progress = txt(body.progress, 200);
    return { status: 200, body: { ok: true, lease_until: task.lease_until, status: task.status } };
  }

  function mark(body = {}) {
    const id = String(body.task_id || '');
    const task = state.tasks[id];
    if (!task) return { status: 404, body: { error: '没有这个任务' } };
    const status = String(body.status || '');
    if (!STATUSES.has(status)) return { status: 400, body: { error: `非法 status=${status}` } };

    if (task.machine && !body.machine && !body.holder) {
      return { status: 400, body: { error: 'identity-required' } };
    }
    if (body.machine && task.machine && canonMachine(body.machine) !== canonMachine(task.machine)) {
      return { status: 409, body: { error: '不是你占的', holder: task.holder || '' } };
    }
    if (body.holder !== undefined && task.holder !== undefined && String(body.holder) !== String(task.holder)) {
      return { status: 409, body: { error: 'holder 不匹配', holder: task.holder || '' } };
    }

    task.status = status;
    task.updated_at = nowSec();
    if (body.note !== undefined) task.note = txt(body.note, NOTE_MAX);
    if (body.dispatch !== undefined) task.dispatch = txt(body.dispatch, 20) || task.dispatch;
    if (body.artifact !== undefined) task.artifact = txt(body.artifact, 300);
    if (Object.prototype.hasOwnProperty.call(body, 'result')) {
      const cleaned = body.result === null ? null : cleanResult(body.result);
      if (body.result === null) delete task.result;
      else if (cleaned) task.result = cleaned;
      // 形状非法就整份丢弃（与真实 board 一致）
    }
    if (status === 'queued') {
      delete task.result;
      delete task.taker;
      delete task.holder;
      task.dispatch = 'auto';
      task.claimed_at = 0;
      task.lease_until = 0;
      task.progress = '';
    }
    touch(`mark ${id} → ${status}`);
    return { status: 200, body: { ok: true, task_id: id, status, dispatch: task.dispatch || 'auto' } };
  }

  function release(body = {}) {
    const id = String(body.task_id || '');
    const task = state.tasks[id];
    if (!task) return { status: 404, body: { error: '没有这个任务' } };
    task.status = 'queued';
    task.dispatch = 'auto';
    task.claimed_at = 0;
    task.lease_until = 0;
    delete task.holder;
    delete task.result;
    task.updated_at = nowSec();
    touch(`release ${id}`);
    return { status: 200, body: { ok: true, task_id: id, status: 'queued' } };
  }

  function create(body = {}) {
    const id = String(body.task_id || `t-${Math.random().toString(16).slice(2, 8)}`);
    if (state.tasks[id]) return { status: 409, body: { error: '任务已存在' } };
    const task = {
      status: 'queued',
      machine: txt(body.machine, 40),
      owner: 'board_dispatch',
      agent: 'board_dispatch',
      title: txt(body.title, 120),
      goal: txt(body.goal, 300),
      note: txt(body.note, NOTE_MAX),
      dispatch: txt(body.dispatch, 20) || 'auto',
      mode: txt(body.mode, 10) || 'exec',
      workspace: txt(body.workspace, 300),
      model: txt(body.model, 160),
      claimed_at: 0,
      lease_until: 0,
      updated_at: nowSec(),
      created_at: nowSec(),
      progress: '',
      artifact: '',
      remote_id: '',
    };
    // 未知字段丢弃（真实 board 的白名单行为），只保留上面这些
    void CREATE_FIELDS;
    state.tasks[id] = task;
    touch(`create ${id} (${task.mode})`);
    return { status: 200, body: { ok: true, task_id: id } };
  }

  function boardSnapshot() {
    state.calls.board += 1;
    return {
      status: 200,
      body: {
        now: nowSec(),
        updated: state.updated,
        machines: state.machines,
        tasks: state.tasks,
        events: state.events.slice(-30),
        counts: counts(),
        version: FAKE_BOARD_VERSION,
      },
    };
  }

  function caps(body = {}) {
    const machine = String(body.machine || '');
    if (!machine) return { status: 400, body: { error: 'machine 必填' } };
    state.caps[machine] = body.caps || {};
    state.machines[machine] = nowSec();
    return { status: 200, body: { ok: true, machine } };
  }

  function metrics(body = {}) {
    const machine = String(body.machine || '');
    if (!machine) return { status: 400, body: { error: 'machine 必填' } };
    state.metrics[machine] = body.metrics || {};
    state.machines[machine] = nowSec();
    return { status: 200, body: { ok: true, machine } };
  }

  const routes = {
    'GET /api/health': () => ({ status: 200, body: { ok: true, version: FAKE_BOARD_VERSION } }),
    'GET /api/board': boardSnapshot,
    'POST /api/claim': (b) => {
      state.calls.claim += 1;
      return claim(b);
    },
    'POST /api/beat': (b) => {
      state.calls.beat += 1;
      return beat(b);
    },
    'POST /api/mark': (b) => {
      state.calls.mark += 1;
      return mark(b);
    },
    'POST /api/release': (b) => {
      state.calls.release += 1;
      return release(b);
    },
    'POST /api/create': (b) => {
      state.calls.create += 1;
      return create(b);
    },
    'POST /api/caps': caps,
    'POST /api/metrics': metrics,
    'GET /api/_test/stats': () => ({ status: 200, body: { ok: true, calls: state.calls, counts: counts() } }),
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
      };
      try {
        if (token) {
          const got = String(req.headers['x-board-token'] || '');
          if (got !== token) return send(401, { error: 'token 无效' });
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const key = `${req.method} ${url.pathname}`;
        const handler = routes[key];
        if (!handler) return send(404, { error: `没有这个端点：${key}` });
        let body = {};
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: '请求体不是 JSON' });
          }
        }
        const out = handler(body);
        return send(out.status, out.body);
      } catch (err) {
        return send(500, { error: (err && err.message) || String(err) });
      }
    });
  });

  return {
    server,
    state,
    counts,
    listen(port = 0, bind = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => {
          const addr = server.address();
          resolve({ port: addr.port, url: `http://${bind}:${addr.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { port: 8977, bind: '127.0.0.1', token: '', state: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--bind') out.bind = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--state') out.state = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/fake-board.mjs [--port 8977] [--bind 127.0.0.1] [--token devtoken] [--state file.json]');
    return;
  }
  let initial = {};
  if (args.state) {
    try {
      initial = { tasks: JSON.parse(fs.readFileSync(args.state, 'utf8')) };
    } catch {
      initial = {};
    }
  }
  const board = createFakeBoard({ token: args.token, tasks: initial.tasks });
  const { url } = await board.listen(args.port, args.bind);
  console.log(`fake-board listening ${url}${args.token ? ' (token 已启用)' : ''}`);
  const shutdown = async () => {
    if (args.state) {
      try {
        fs.writeFileSync(args.state, JSON.stringify(board.state.tasks, null, 2), 'utf8');
      } catch (err) {
        console.error('写 state 失败:', (err && err.message) || err);
      }
    }
    await board.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('fake-board 启动失败:', (err && err.stack) || err);
    process.exit(1);
  });
}
