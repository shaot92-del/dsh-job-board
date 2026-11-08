#!/usr/bin/env node
/**
 * fake-board.mjs —— 仓库自带的作业板替身，只为验收/回归服务。
 *
 * 为什么要有它：`scripts/acceptance.mjs` 原来依赖一个**没入库**的
 * `board_server.py`（真实板子实现），找不到就整段跳过 —— 于是"故障验收随仓库
 * 启动"（#10 建议 5）一直没做到。这个文件实现了插件真正用到的那几个端点，
 * 让 acceptance 能在任何一台机器（含 CI）上从零跑起来。
 *
 * 用法：
 *   node scripts/fake-board.mjs --port 8977 --bind 127.0.0.1 --state <state.json>
 *
 * 语义刻意保持"够用且诚实"：
 *   - 认领/续租/交付/打回/放回都按 taker 校验，认领冲突回 409（插件据此判"不归我"）；
 *   - 支持 remote_id / attach / untake / create，覆盖派工三件套；
 *   - 状态落盘到 --state，进程重启后还能读回来（accepatance 会核对终态）。
 * 它**不是**生产板子：没有 token、没有 CORS、没有多进程锁，只监听 127.0.0.1。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const PORT = Number(flag('port', '8977'))
const BIND = String(flag('bind', '127.0.0.1'))
const STATE_FILE = path.resolve(String(flag('state', path.join(process.cwd(), 'fake-board-state.json'))))
// v1.3.5（复核 F11/F12）：验收要覆盖「派工链路」，所以这里也当一次 remote-agent hub。
// nodeId 默认取本机 machine 名，保证插件 pickNode 能按机器名选中它。
const NODE_ID = String(flag('node', process.env.GP_FAKE_NODE || 'host'))

const nowSec = () => Date.now() / 1000

function emptyState() {
  return { updated: Math.floor(nowSec()), tasks: {}, machines: {}, events: [], remote: {}, remoteSeq: 0 }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const state = emptyState()
    if (raw && typeof raw === 'object') {
      state.tasks = raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {}
      state.machines = raw.machines && typeof raw.machines === 'object' ? raw.machines : {}
      state.events = Array.isArray(raw.events) ? raw.events : []
      state.remote = raw.remote && typeof raw.remote === 'object' ? raw.remote : {}
      state.remoteSeq = Number(raw.remoteSeq) || 0
      state.updated = Number(raw.updated) || Math.floor(nowSec())
    }
    return state
  } catch {
    return emptyState()
  }
}

let state = loadState()

function save() {
  state.updated = Math.floor(nowSec())
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  const tmp = STATE_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

function event(kind, taskId, machine, note) {
  state.events.push({ at: nowSec(), kind, task_id: taskId || '', machine: machine || '', note: note || '' })
  if (state.events.length > 500) state.events = state.events.slice(-500)
}

function counts() {
  const c = { queued: 0, claimed: 0, running: 0, done: 0, blocked: 0, failed: 0, stale: 0 }
  for (const t of Object.values(state.tasks)) {
    const s = String(t.status || 'queued')
    if (c[s] !== undefined) c[s] += 1
  }
  return c
}

function boardPayload() {
  const machines = {}
  const now = nowSec()
  for (const [id, m] of Object.entries(state.machines)) {
    machines[id] = {
      ...m,
      online: now - Number(m.last_seen || 0) < 120,
      status: now - Number(m.last_seen || 0) < 120 ? 'online' : 'offline',
    }
  }
  return {
    ok: true,
    updated: Math.floor(now),
    counts: counts(),
    tasks: state.tasks,
    machines,
    events: state.events.slice(-120),
  }
}

const send = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

function touch(task) {
  task.updated_at = nowSec()
  save()
}

function leaseOf(minutes, fallback = 10) {
  const m = Number(minutes)
  return nowSec() + (Number.isFinite(m) && m > 0 ? m : fallback) * 60
}

/** 任务存在、且（无主 或 本来就是本机的）→ 拿到手；否则 409。
 *  v1.3.3：同机不同实例（holder 不同）不再当"自己的重入" —— 真的板子
 *  （board_server.py do_take）就是这么判的，这里必须同构，否则测试测不到双派。 */
function claimFor(task, machine, minutes, note, holder = '') {
  if (!task) return { ok: false, status: 404, error: 'no such task' }
  if (task.machine && String(task.machine).toLowerCase() !== String(machine).toLowerCase()) {
    return { ok: false, status: 409, error: 'held by ' + task.machine }
  }
  const mine = String(task.machine || '') !== ''
  const curHolder = String(task.holder || '')
  const askHolder = String(holder || '')
  if (mine && curHolder && askHolder && curHolder !== askHolder) {
    return { ok: false, status: 409, error: 'held-by-other-instance', holder: curHolder }
  }
  const wasQueued = String(task.status || 'queued') === 'queued'
  task.machine = machine
  if (askHolder) task.holder = askHolder
  task.status = task.status === 'running' ? 'running' : 'claimed'
  task.claimed_at = task.claimed_at || nowSec()
  task.lease_until = leaseOf(minutes)
  if (note) task.note = String(note)
  if (wasQueued) event('claim', task.id, machine, note)
  touch(task)
  return { ok: true, status: 200, task }
}

const ROUTES = {
  'GET /api/health': (req, res) => send(res, 200, { ok: true, board: 'fake' }),
  'GET /api/board': (req, res) => send(res, 200, boardPayload()),

  'POST /api/claim': async (req, res, b) => {
    const r = claimFor(state.tasks[b.task_id], b.machine, b.minutes, b.note)
    if (!r.ok) return send(res, r.status, { ok: false, error: r.error })
    return send(res, 200, { ok: true, task: r.task })
  },

  'POST /api/take': async (req, res, b) => {
    const r = claimFor(state.tasks[b.task_id], b.machine, b.minutes, b.note || '派工认领', b.holder)
    if (!r.ok) return send(res, r.status, { ok: false, error: r.error, holder: r.holder })
    return send(res, 200, { ok: true, task: r.task })
  },

  'POST /api/beat': async (req, res, b) => {
    const t = state.tasks[b.task_id]
    if (!t) return send(res, 404, { ok: false, error: 'no such task' })
    if (String(t.machine || '').toLowerCase() !== String(b.machine || '').toLowerCase()) {
      return send(res, 409, { ok: false, error: 'not yours' })
    }
    t.lease_until = leaseOf(b.minutes, 5)
    if (b.note) t.note = String(b.note)
    event('beat', t.id, b.machine, b.note)
    touch(t)
    return send(res, 200, { ok: true, task: t })
  },

  // board_done / board_fail 都走这里；mark 额外支持 remote_id（派工回绑）。
  'POST /api/release': async (req, res, b) => {
    const t = state.tasks[b.task_id]
    if (!t) return send(res, 404, { ok: false, error: 'no such task' })
    if (t.machine && b.machine && String(t.machine).toLowerCase() !== String(b.machine).toLowerCase()) {
      return send(res, 409, { ok: false, error: 'not yours' })
    }
    const next = String(b.status || 'done')
    if (!['queued', 'done', 'failed', 'blocked', 'claimed', 'running'].includes(next)) {
      return send(res, 400, { ok: false, error: 'bad status ' + next })
    }
    t.status = next
    if (b.note) t.note = String(b.note)
    if (b.artifact) t.artifact = String(b.artifact)
    if (b.remote_id) t.remote_id = String(b.remote_id)
    if (next === 'queued') {
      t.machine = ''
      t.lease_until = null
      // v1.3.3（复核 F8）：放回队列的任务不能带着 remote_id / holder，否则没人能再派它。
      delete t.remote_id
      delete t.holder
    }
    event(next, t.id, t.machine, b.note)
    touch(t)
    return send(res, 200, { ok: true, task: t })
  },

  'POST /api/mark': async (req, res, b) => {
    const t = state.tasks[b.task_id]
    if (!t) return send(res, 404, { ok: false, error: 'no such task' })
    if (b.status) t.status = String(b.status)
    if (b.note) t.note = String(b.note)
    if (b.remote_id) t.remote_id = String(b.remote_id)
    if (b.progress !== undefined) t.progress = String(b.progress)
    event('mark', t.id, b.machine, b.status || '')
    touch(t)
    return send(res, 200, { ok: true, task: t })
  },

  'POST /api/attach': async (req, res, b) => {
    const t = state.tasks[b.task_id]
    if (!t) return send(res, 404, { ok: false, error: 'no such task' })
    if (!b.remote_id) return send(res, 400, { ok: false, error: 'remote_id required' })
    t.remote_id = String(b.remote_id)
    if (b.machine) t.machine = String(b.machine)
    // v1.3.3：真板子 do_attach 会 pop('taker')；占位结束，holder 也一起清掉。
    delete t.holder
    event('attach', t.id, b.machine, t.remote_id)
    touch(t)
    return send(res, 200, { ok: true, task: t })
  },

  'POST /api/untake': async (req, res, b) => {
    const t = state.tasks[b.task_id]
    if (!t) return send(res, 404, { ok: false, error: 'no such task' })
    if (t.machine && b.machine && String(t.machine).toLowerCase() !== String(b.machine).toLowerCase()) {
      return send(res, 409, { ok: false, error: 'not yours' })
    }
    t.machine = ''
    t.status = 'queued'
    t.lease_until = null
    delete t.holder
    // v1.3.3（复核 F8）：回到队列却带着 remote_id，所有 Host 的队列过滤都会跳过它。
    delete t.remote_id
    if (b.note) t.note = String(b.note)
    event('untake', t.id, b.machine, b.note)
    touch(t)
    return send(res, 200, { ok: true, task: t })
  },

  'POST /api/create': async (req, res, b) => {
    const id = String(b.id || b.task_id || 'task-' + Math.random().toString(36).slice(2, 8))
    if (state.tasks[id]) return send(res, 409, { ok: false, error: 'duplicate id' })
    state.tasks[id] = {
      id,
      title: String(b.title || ''),
      goal: String(b.goal || ''),
      status: 'queued',
      // v1.3.5（复核 F11/F12）：真板子 do_create 会把 machine/owner/dispatch 一起落下，
      // 这里以前把 machine 写成空串，导致「指定机器建单」的语义和真板子不一致 ——
      // 派工链路一测就发现 pickNode 选不中任何节点。
      machine: String(b.machine || ''),
      owner: String(b.machine || ''),
      agent: 'board_dispatch',
      mode: String(b.mode || 'agent'),
      dispatch: String(b.dispatch || 'manual'),
      priority: Number(b.priority) || 5,
      note: '',
      remote_id: '',
      workspace: String(b.workspace || ''),
      created_at: nowSec(),
      updated_at: nowSec(),
      claimed_at: null,
      lease_until: null,
      progress: '',
      artifact: '',
    }
    event('create', id, b.machine, b.title)
    save()
    return send(res, 200, { ok: true, id, task: state.tasks[id] })
  },

  'POST /api/caps': async (req, res, b) => {
    const id = String(b.machine || 'host')
    const prev = state.machines[id] || {}
    state.machines[id] = {
      ...prev,
      last_seen: nowSec(),
      caps: b.caps || null,
      caps_at: nowSec(),
    }
    save()
    return send(res, 200, { ok: true })
  },

  'POST /api/metrics': async (req, res, b) => {
    const id = String(b.machine || 'host')
    const prev = state.machines[id] || {}
    state.machines[id] = { ...prev, last_seen: nowSec(), live: b.live || null, live_at: nowSec() }
    save()
    return send(res, 200, { ok: true })
  },

  'POST /api/say': async (req, res, b) => {
    event('say', '', b.machine, b.text)
    save()
    return send(res, 200, { ok: true })
  },

  /* ── v1.3.5（复核 F11/F12）：remote-agent hub 的最小替身 ──────────────
   * 以前 acceptance 只测工具链路，派工一段「零覆盖」，两个假板子对 taker /
   * dispatch 的建模也和真板子系统性偏差。这四个端点让验收能把
   * take → dispatch → attach → sync → done 整条链路真跑一遍。
   * 只实现插件真正用到的字段，不是 hub 的完整实现。 */

  'GET /api/remote-agent/ui/nodes': (req, res) =>
    send(res, 200, { ok: true, nodes: [{ nodeId: NODE_ID, online: true, machine: NODE_ID }] }),

  'GET /api/remote-agent/ui/tasks': (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const node = String(u.searchParams.get('node') || '')
    const tasks = Object.values(state.remote)
      .filter((t) => !node || String(t.nodeId) === node)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 200)
    return send(res, 200, { ok: true, tasks })
  },

  'GET /api/remote-agent/ui/task': (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const id = String(u.searchParams.get('taskId') || '')
    const t = state.remote[id]
    if (!t) return send(res, 404, { ok: false, error: 'task-unknown' })
    return send(res, 200, { ok: true, task: t })
  },

  'POST /api/remote-agent/ui/dispatch': async (req, res, b) => {
    state.remoteSeq = Number(state.remoteSeq || 0) + 1
    const id = 'ui-fake-' + state.remoteSeq
    const t = {
      taskId: id,
      nodeId: String(b.node || NODE_ID),
      mode: String(b.mode || 'agent'),
      approval: 'auto',
      goal: String(b.goal || ''),
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: '',
    }
    state.remote[id] = t
    event('dispatch', '', t.nodeId, t.goal)
    save()
    return send(res, 200, { ok: true, taskId: id, nodeId: t.nodeId, mode: t.mode, approval: 'auto' })
  },

  // 验收专用：把远端任务置成终态，模拟「副机干完了」，插件的 syncRemote 应当回写板子。
  'POST /api/_test/remote-complete': async (req, res, b) => {
    const t = state.remote[String(b.taskId || '')]
    if (!t) return send(res, 404, { ok: false, error: 'task-unknown' })
    t.status = String(b.status || 'completed')
    t.result = String(b.result || 'acceptance: 派工链路跑通')
    t.updatedAt = Date.now()
    save()
    return send(res, 200, { ok: true, task: t })
  },

  // 验收专用：统计假 hub 收到过多少次 /dispatch（复核 B3：只派一次必须被断言，
  // 光看 remote_id 非空抓不到「重复派工、只留最后一条」）。
  'GET /api/_test/stats': async (req, res) => {
    const remote = state.remote || {}
    return send(res, 200, {
      ok: true,
      dispatchCount: Number(state.remoteSeq || 0),
      remoteCount: Object.keys(remote).length,
      remoteIds: Object.keys(remote),
      tasks: Object.keys(state.tasks || {}).length,
    })
  },
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const key = req.method + ' ' + url.pathname
  const handler = ROUTES[key]
  if (!handler) return send(res, 404, { ok: false, error: 'no route ' + key })
  if (req.method === 'GET') return handler(req, res)
  return readBody(req).then((b) => handler(req, res, b))
})

server.listen(PORT, BIND, () => {
  console.log('fake-board listening on http://' + BIND + ':' + PORT + '  state=' + STATE_FILE)
})

const shutdown = () => {
  try {
    save()
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 800).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
