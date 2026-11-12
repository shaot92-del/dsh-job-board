/**
 * solo-board.mjs —— 插件自带的「本机板子」（v1.5.0）。
 *
 * 背景：从插件市场装完 dsh-team 的用户，第一次启用时既没有板子进程、也没有 token，
 * 面板只会一片空白（PC2 就是这么卡住的）。这个模块让插件在**零配置**下也能自举：
 * 没有 token/boardUrl 时，在 127.0.0.1 上起一个最小板子，随机生成 token，状态落在
 * 插件自己的状态目录里。用户不需要装 Python、不需要改 cordis.patch.yml。
 *
 * 它只实现 solo 需要的子集（12 条路由），语义与 tools/board_server.py 对齐：
 *   GET  /api/health          无 token 只回 {ok:true}
 *   GET  /api/board           快照（需要 token）
 *   POST /api/create|claim|take|untake|attach|mark|beat|release|caps|metrics|say|seen
 *
 * 刻意的边界：
 *   · 只监听 127.0.0.1，不对外网开放；多机团队仍用 Python 板子（功能全、已加固）。
 *   · 每次写都落盘（tmp + rename），崩溃后任务不丢。
 *   · token 只接受精确匹配（timingSafeEqual），不做「空 token 放行」。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_BODY_BYTES = 1024 * 1024
// v2.0.2：与 Python 板子对齐，避免 solo 的 tasks 无上限增长 / 可被无限造任务。
const MAX_ACTIVE_TASKS = 5000
const TERMINAL_TTL_SEC = 30 * 24 * 3600
const TERMINAL_STATUS = new Set(['done', 'failed', 'blocked', 'superseded'])
const TASK_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const getTask = (state, id) => (hasOwn(state.tasks, id) ? state.tasks[id] : null)
const activeCount = (state) =>
  Object.keys(state.tasks).filter((id) => !TERMINAL_STATUS.has(str((state.tasks[id] || {}).status))).length
function pruneTerminal(state) {
  // v2.0.3：终态任务不参与上限，但也不能无限长；加载时剪掉 30 天前的终态记录。
  for (const id of Object.keys(state.tasks)) {
    const t = state.tasks[id]
    if (TERMINAL_STATUS.has(str(t.status)) && now() - Number(t.updated_at || t.claimed_at || 0) > TERMINAL_TTL_SEC) {
      delete state.tasks[id]
    }
  }
}
const ONLINE_WINDOW = 120
const DEFAULT_MINUTES = 30
const STALE_GRACE = 120
const STATUS_WHITELIST = new Set(['queued', 'claimed', 'running', 'done', 'failed', 'blocked', 'superseded', 'stale'])
const RELEASE_STATUS = new Set(['done', 'blocked', 'failed', 'queued', 'superseded'])

const now = () => Math.floor(Date.now() / 1000)
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const clip = (v, n) => str(v).trim().slice(0, n)

function emptyState() {
  return { updated: 0, machines: {}, tasks: Object.create(null), events: [] }
}

export function startSoloBoard({ stateDir, host = '127.0.0.1', port = 0, token } = {}) {
  if (!stateDir) throw new Error('startSoloBoard 需要 stateDir')
  const dir = path.resolve(stateDir)
  fs.mkdirSync(dir, { recursive: true })
  const stateFile = path.join(dir, 'solo-board.json')
  const authToken = str(token) || randomBytes(24).toString('hex')
  const expected = Buffer.from(authToken, 'utf8')

  let state = emptyState()
  const loadState = () => {
    const next = emptyState()
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (j && typeof j === 'object') {
        next.updated = Number(j.updated) || 0
        next.machines = j.machines && typeof j.machines === 'object' ? j.machines : {}
        // v2.0.3（复核 L1）：用无原型对象，`tasks['constructor']` 不会再命中原型成员。
        next.tasks = Object.assign(Object.create(null), j.tasks && typeof j.tasks === 'object' ? j.tasks : {})
        next.events = Array.isArray(j.events) ? j.events.slice(-200) : []
        pruneTerminal(next)
      }
    } catch {
      /* 没有存档就从头开始 */
    }
    return next
  }
  state = loadState()

  const save = () => {
    state.updated = now()
    const tmp = `${stateFile}.tmp`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, stateFile)
    } catch (e) {
      // 复核（v2.0.6，P1-6）：落盘失败不能当成功。回滚内存到磁盘上的上一版，
      // 再把错误抛给请求层 —— 否则 create/claim 返回 200，重启后任务消失。
      try {
        state = loadState()
      } catch {
        /* 回滚失败也仍然要抛 */
      }
      const err = new Error('save-failed: ' + String((e && e.message) || e))
      err.code = 'SAVE_FAILED'
      throw err
    }
  }

  const canonMachine = (name) => {
    const raw = clip(name, 60)
    if (!raw) return raw
    for (const k of Object.keys(state.machines)) {
      if (k.toLowerCase() === raw.toLowerCase()) return k
    }
    for (const t of Object.values(state.tasks)) {
      const m = str(t && t.machine)
      if (m && m.toLowerCase() === raw.toLowerCase()) return m
    }
    return raw
  }

  const touchMachine = (name, current = '') => {
    const key = canonMachine(name)
    if (!key) return
    const m = state.machines[key] || {}
    if (current) m.current = current
    m.last_seen = now()
    state.machines[key] = m
  }

  const addEvent = (kind, machine, taskId, text) => {
    state.events.push({ at: now(), kind, machine: str(machine), task_id: str(taskId), text: clip(text, 300) })
    if (state.events.length > 200) state.events = state.events.slice(-200)
  }

  const effectiveTask = (t) => {
    const out = { ...t }
    if (out.status === 'claimed' || out.status === 'running') {
      if (now() > Number(out.lease_until || 0) + STALE_GRACE) out.status = 'stale'
    }
    return out
  }

  const snapshot = () => {
    const tasks = {}
    for (const [k, v] of Object.entries(state.tasks)) tasks[k] = effectiveTask(v)
    const machines = {}
    for (const [name, m] of Object.entries(state.machines)) {
      machines[name] = {
        online: now() - Number(m.last_seen || 0) <= ONLINE_WINDOW,
        current: str(m.current),
        note: str(m.note),
        last_seen: Number(m.last_seen || 0),
        caps: m.caps == null ? null : m.caps,
        caps_at: Number(m.caps_at || 0),
        live: m.live == null ? null : m.live,
        live_at: Number(m.live_at || 0),
      }
    }
    const counts = {}
    for (const s of ['queued', 'claimed', 'running', 'done', 'blocked', 'failed', 'stale', 'superseded']) {
      counts[s] = Object.values(tasks).filter((t) => t.status === s).length
    }
    return {
      now: now(),
      updated: state.updated,
      machines,
      tasks,
      events: state.events.slice(-30),
      counts,
    }
  }

  const json = (res, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const tokenOk = (req) => {
    const got = Buffer.from(str(req.headers['x-board-token']), 'utf8')
    return got.length === expected.length && timingSafeEqual(got, expected)
  }

  const originOk = (req) => {
    const origin = str(req.headers.origin)
    if (!origin) return true
    try {
      const u = new URL(origin)
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
    } catch {
      return false
    }
  }

  const readJson = (req) =>
    new Promise((resolve) => {
      const n = Number(req.headers['content-length'] || 0)
      if (n > MAX_BODY_BYTES) {
        req.resume()
        resolve({})
        return
      }
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size <= MAX_BODY_BYTES) chunks.push(c)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(j && typeof j === 'object' ? j : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  // ── 动作（与 board_server.py 的返回形状保持一致）────────────────────────
  const actions = {
    create(body) {
      const taskId = clip(body.task_id, 120)
      const goal = clip(body.goal, 300)
      const machine = clip(body.machine, 60)
      if (!taskId) return [400, { error: 'task_id 必填' }]
      if (!goal) return [400, { error: 'goal 必填' }]
      if (!TASK_ID_RE.test(taskId)) return [400, { error: 'task_id 只能包含字母数字 . _ : @ -，长度 1-128' }]
      if (hasOwn(state.tasks, taskId)) return [409, { error: 'task_id 已存在', task_id: taskId }]
      // v2.0.3（复核 D）：上限只算活跃任务；终态记录不占额度（加载时按 30 天剪枝）。
      if (activeCount(state) >= MAX_ACTIVE_TASKS) {
        return [429, { error: '活跃任务太多', limit: MAX_ACTIVE_TASKS }]
      }
      state.tasks[taskId] = {
        status: 'queued',
        machine,
        owner: machine,
        agent: 'board_dispatch',
        title: clip(body.title, 120) || goal.slice(0, 60),
        goal,
        note: clip(body.note, 500),
        dispatch: clip(body.dispatch, 20),
        mode: clip(body.mode, 10),
        workspace: clip(body.workspace, 300),
        claimed_at: 0,
        lease_until: 0,
        updated_at: now(),
        progress: '',
        artifact: '',
        remote_id: '',
      }
      addEvent('create', machine || 'host', taskId, clip(body.title, 120) || goal.slice(0, 120))
      save()
      return [200, { ok: true, task_id: taskId, status: 'queued' }]
    },

    claim(body) {
      const taskId = clip(body.task_id, 120)
      const machine = clip(body.machine, 60)
      if (!taskId || !machine) return [400, { error: 'task_id 和 machine 必填' }]
      if (!TASK_ID_RE.test(taskId)) return [400, { error: 'task_id 只能包含字母数字 . _ : @ -，长度 1-128' }]
      // v2.0.3（复核 C）：恢复 Python 板子的语义 —— do_claim 对未知 id **自动建单**
      // （tools/board_server.py:281/299，为 Host 统一派工先 claim 占位）。
      // v2.0.2 误改成 404 并在 CHANGELOG 声称「对齐」，是错的。
      let t = getTask(state, taskId)
      if (!t) {
        if (activeCount(state) >= MAX_ACTIVE_TASKS) {
          return [429, { error: '活跃任务太多', limit: MAX_ACTIVE_TASKS }]
        }
        t = { status: 'queued', note: '', created_at: now() }
        state.tasks[taskId] = t
      }
      const eff = effectiveTask(t)
      const holder = str(t.machine)
      if ((eff.status === 'claimed' || eff.status === 'running') && holder && holder.toLowerCase() !== machine.toLowerCase()) {
        return [409, { error: '已被占用', task_id: taskId, holder, lease_until: Number(t.lease_until || 0) }]
      }
      if (eff.status === 'done' || eff.status === 'superseded') {
        return [409, { error: eff.status === 'done' ? '已完成' : '已作废', task_id: taskId }]
      }
      const took = eff.status === 'stale'
      const cur = (state.tasks[taskId] = { ...t, status: 'claimed', machine, owner: machine })
      if (body.agent) cur.agent = clip(body.agent, 60)
      if (body.note) cur.note = clip(body.note, 300)
      cur.claimed_at = now()
      cur.lease_until = now() + minutes(body) * 60
      cur.updated_at = now()
      delete cur.taker
      touchMachine(machine, taskId)
      addEvent('claim', machine, taskId, took ? '接管过期任务' : '')
      save()
      return [200, { ok: true, task_id: taskId, lease_until: cur.lease_until }]
    },

    take(body) {
      const taskId = clip(body.task_id, 120)
      const machine = clip(body.machine, 60)
      const holder = clip(body.holder, 120)
      if (!taskId || !machine) return [400, { error: 'task_id 和 machine 必填' }]
      const t = getTask(state, taskId)
      if (!t) return [404, { error: '没有这道任务', task_id: taskId }]
      const st = effectiveTask(t).status
      if (st === 'done' || st === 'superseded' || st === 'failed' || st === 'blocked') {
        return [409, { error: '任务已结束', status: st }]
      }
      if (str(t.dispatch) !== 'auto') return [409, { error: '不是自动派发任务', dispatch: str(t.dispatch) }]
      const taker = str(t.taker)
      if (st === 'claimed') {
        if (taker.toLowerCase() === machine.toLowerCase()) {
          const curHolder = str(t.holder)
          if (curHolder && holder && curHolder !== holder) {
            return [409, { error: '已被同机的另一个实例占住', taker, holder: curHolder }]
          }
          if (holder) t.holder = holder
          t.lease_until = now() + minutes(body) * 60
          t.updated_at = now()
          save()
          return [200, { ok: true, task_id: taskId, taken: true, reentrant: true, task: { ...t } }]
        }
        if (taker) return [409, { error: '已被别的调度器占住', taker }]
        if (str(t.remote_id)) return [409, { error: '已派出，避免重复派' }]
        if (now() <= Number(t.lease_until || 0) + STALE_GRACE) {
          return [409, { error: '占位未过期', machine: str(t.machine) }]
        }
      } else if (st !== 'queued' && st !== 'stale') {
        return [409, { error: '状态不可派发', status: st }]
      }
      t.status = 'claimed'
      t.taker = machine
      if (holder) t.holder = holder
      t.claimed_at = now()
      t.lease_until = now() + minutes(body) * 60
      t.updated_at = now()
      addEvent('take', machine, taskId, '调度器占位')
      save()
      return [200, { ok: true, task_id: taskId, taken: true, task: { ...t } }]
    },

    untake(body) {
      const taskId = clip(body.task_id, 120)
      const machine = clip(body.machine, 60)
      if (!taskId || !machine) return [400, { error: 'task_id 和 machine 必填' }]
      const t = getTask(state, taskId)
      if (!t) return [404, { error: '没有这道任务', task_id: taskId }]
      if (str(t.taker).toLowerCase() !== machine.toLowerCase()) {
        return [409, { error: '不是你占的', taker: str(t.taker) }]
      }
      delete t.taker
      delete t.holder
      delete t.remote_id
      t.status = 'queued'
      t.dispatch = 'auto'
      t.claimed_at = 0
      t.lease_until = 0
      t.updated_at = now()
      addEvent('untake', machine, taskId, clip(body.note, 200) || '派发失败，退回队列')
      save()
      return [200, { ok: true, task_id: taskId, status: 'queued' }]
    },

    attach(body) {
      const taskId = clip(body.task_id, 120)
      const remoteId = clip(body.remote_id, 120)
      const machine = clip(body.machine, 60)
      if (!taskId) return [400, { error: 'task_id 必填' }]
      const t = getTask(state, taskId)
      if (!t) return [404, { error: '没有这道任务', task_id: taskId }]
      if (machine) {
        t.machine = machine
        t.owner = machine
      }
      if (remoteId) t.remote_id = remoteId
      delete t.dispatch
      delete t.taker
      delete t.holder
      t.status = 'running'
      t.claimed_at = now()
      t.lease_until = now() + minutes(body, 240) * 60
      t.updated_at = now()
      touchMachine(machine || str(t.machine) || 'host', taskId)
      addEvent('attach', machine || str(t.machine) || 'host', taskId, remoteId)
      save()
      return [200, { ok: true, task_id: taskId, remote_id: remoteId, status: 'running' }]
    },

    mark(body) {
      const taskId = clip(body.task_id, 120)
      const status = clip(body.status, 20)
      const machine = clip(body.machine, 60)
      const holder = clip(body.holder, 120)
      if (status && !STATUS_WHITELIST.has(status)) {
        return [400, { error: 'status 不在白名单', status }]
      }
      const t = getTask(state, taskId)
      if (!t) return [404, { error: '没有这道任务', task_id: taskId }]
      if (t.machine && !machine && !holder) {
        return [400, { error: 'identity-required', hint: 'mark 必须带 machine（执行机）或 holder' }]
      }
      if (machine && t.machine && canonMachine(machine).toLowerCase() !== canonMachine(t.machine).toLowerCase()) {
        return [409, { error: '不是你占的', holder: str(t.machine) }]
      }
      const curHolder = str(t.holder)
      if (curHolder && holder && curHolder !== holder) {
        return [409, { error: '已被同机的另一个实例占住', holder: curHolder }]
      }
      if (clip(body.dispatch, 20)) t.dispatch = clip(body.dispatch, 20)
      else delete t.dispatch
      if (status) t.status = status
      if (Object.prototype.hasOwnProperty.call(body, 'remote_id')) {
        const rid = clip(body.remote_id, 120)
        if (rid) t.remote_id = rid
        else delete t.remote_id
      }
      if (Object.prototype.hasOwnProperty.call(body, 'note')) t.note = clip(body.note, 500)
      if (status === 'queued') {
        delete t.taker
        delete t.holder
        delete t.remote_id
        t.dispatch = 'auto'
        t.claimed_at = 0
        t.lease_until = 0
      }
      t.updated_at = now()
      save()
      return [200, { ok: true, task_id: taskId, dispatch: str(t.dispatch), status: t.status }]
    },

    beat(body) {
      const taskId = clip(body.task_id, 120)
      const machine = clip(body.machine, 60)
      const t = getTask(state, taskId)
      if (!t) return [404, { error: '没有这道任务', task_id: taskId }]
      if (canonMachine(str(t.machine)).toLowerCase() !== canonMachine(machine).toLowerCase()) {
        return [409, { error: '不是你占的', holder: str(t.machine) }]
      }
      t.lease_until = now() + minutes(body) * 60
      t.updated_at = now()
      if (t.status === 'claimed') t.status = 'running'
      if (body.progress) t.progress = clip(body.progress, 200)
      touchMachine(machine, taskId)
      save()
      return [200, { ok: true, lease_until: t.lease_until }]
    },

    release(body) {
      const taskId = clip(body.task_id, 120)
      const machine = clip(body.machine, 60)
      const status = clip(body.status, 20) || 'done'
      const holder = clip(body.holder, 120)
      if (!RELEASE_STATUS.has(status)) {
        return [400, { error: 'status 只能 done/blocked/failed/queued/superseded' }]
      }
      if (status === 'superseded' && !clip(body.note, 300)) {
        return [400, { error: '作废必须写原因（note）' }]
      }
      const t = getTask(state, taskId)
      if (!t) return [404, { error: '没有这道任务', task_id: taskId }]
      if (t.machine) {
        if (machine) {
          if (canonMachine(str(t.machine)).toLowerCase() !== canonMachine(machine).toLowerCase()) {
            return [409, { error: '不是你占的', holder: str(t.machine) }]
          }
        } else if (!holder) {
          return [400, { error: 'identity-required', hint: 'release 必须带 machine（执行机）或 holder' }]
        }
      }
      const curHolder = str(t.holder)
      if (curHolder && holder && curHolder !== holder) {
        return [409, { error: '已被同机的另一个实例占住', holder: curHolder }]
      }
      t.status = status
      t.updated_at = now()
      t.lease_until = 0
      if (status === 'queued') {
        delete t.remote_id
        delete t.taker
        delete t.holder
        delete t.machine
        t.dispatch = 'auto'
        t.claimed_at = 0
      }
      t.note = clip(body.note, 500)
      if (body.artifact) t.artifact = clip(body.artifact, 300)
      touchMachine(machine)
      if (machine) {
        const key = canonMachine(machine)
        state.machines[key] = { ...(state.machines[key] || {}), current: '' }
      }
      addEvent(status, machine, taskId, t.note)
      save()
      return [200, { ok: true, task_id: taskId, status }]
    },

    caps(body) {
      const machine = clip(body.machine, 60)
      const caps = body.caps
      if (!machine || !caps || typeof caps !== 'object') {
        return [400, { error: '需要 machine 与 caps（对象）' }]
      }
      if (Buffer.byteLength(JSON.stringify(caps)) > 8192) return [413, { error: 'caps 太大', limit: 8192 }]
      const key = canonMachine(machine)
      const m = state.machines[key] || {}
      const merged = { ...(m.caps || {}), ...caps }
      m.caps = Buffer.byteLength(JSON.stringify(merged)) > 16384 ? { ...caps } : merged
      m.caps_at = now()
      m.last_seen = now()
      state.machines[key] = m
      save()
      return [200, { ok: true, machine: key, caps: m.caps, caps_at: m.caps_at }]
    },

    metrics(body) {
      const machine = clip(body.machine, 60)
      const live = body.live
      if (!machine || !live || typeof live !== 'object') {
        return [400, { error: '需要 machine 与 live（对象）' }]
      }
      if (Buffer.byteLength(JSON.stringify(live)) > 4096) return [413, { error: 'live 太大', limit: 4096 }]
      const key = canonMachine(machine)
      const m = state.machines[key] || {}
      m.live = live
      m.live_at = now()
      m.last_seen = now()
      state.machines[key] = m
      save()
      return [200, { ok: true, machine: key }]
    },

    say(body) {
      const machine = clip(body.machine, 60) || '?'
      addEvent('say', machine, '', clip(body.text, 300))
      touchMachine(machine)
      save()
      return [200, { ok: true }]
    },

    seen(body) {
      const machine = clip(body.machine, 60)
      if (!machine) return [400, { error: 'machine 必填' }]
      touchMachine(machine)
      save()
      return [200, { ok: true }]
    },
  }

  function minutes(body, fallback = DEFAULT_MINUTES) {
    const n = Number(body && body.minutes)
    if (!Number.isFinite(n)) return fallback
    return Math.min(1440, Math.max(1, Math.floor(n)))
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname === '/api/health') {
        if (!tokenOk(req)) return json(res, 200, { ok: true })
        return json(res, 200, {
          ok: true,
          solo: true,
          version: 4,
          tasks: Object.keys(state.tasks).length,
          authTokens: 1,
          authReads: true,
          singleInstance: true,
          build: 'solo',
          routes: ['take', 'untake', 'attach', 'mark', 'release'],
        })
      }
      if (url.pathname === '/api/board') {
        if (!originOk(req)) return json(res, 403, { error: 'origin not allowed' })
        if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized' })
        return json(res, 200, snapshot())
      }
      return json(res, 404, { error: 'not found' })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (!originOk(req)) return json(res, 403, { error: 'origin not allowed' })
    if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized' })
    const ctype = str(req.headers['content-type']).split(';')[0].trim().toLowerCase()
    if (ctype && ctype !== 'application/json') return json(res, 415, { error: '需要 application/json' })
    const body = await readJson(req)
    const name = url.pathname.replace(/^\/api\//, '')
    const fn = actions[name]
    if (!fn) return json(res, 404, { error: 'not found' })
    try {
      const [code, payload] = fn(body)
      json(res, code, payload)
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) })
    }
  })

  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* ignore */
    }
  })

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://${host}:${actualPort}`,
        port: actualPort,
        token: authToken,
        server,
        close: () =>
          new Promise((done) => {
            try {
              server.close(() => done())
            } catch {
              done()
            }
          }),
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
