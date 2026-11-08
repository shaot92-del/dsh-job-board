#!/usr/bin/env node
/**
 * dispatch-recovery-smoke.mjs —— v1.2.0（#10-1）派工恢复状态机的隔离验证。
 *
 * 背景：take → POST /dispatch → attach 三步，每一步都可能"发出去但没收到回执"。
 * v1.1.x 的做法是任何一步失败都 untake 后重来 —— 对 /dispatch 是错的：超时那一刻
 * 副机上可能已经开跑，重派就是同一条任务跑两遍。
 *
 * 这个 harness 用一个假板子 + 假 hub（同一个 HTTP server 的两个面）验证三个场景：
 *   R1 结果未知 → 远端确有该任务 → 只补绑、不重派
 *   R2 结果未知 → 远端确实没有 → 放回队列、重派一次
 *   R3 已认领未发出（崩溃后恢复）→ 不重新 take，直接补发
 *
 * 与 reload-smoke 一样：不起 DSH，不连真板子，跑完自己退出。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { apply } from '../lib/index.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail || '') })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STATE_DIR = path.join(os.homedir(), '.dsh', 'dsh-team')
const journalFile = (machine, boardUrl) =>
  path.join(
    STATE_DIR,
    `dispatch-journal-${machine}-${crypto.createHash('sha1').update(String(boardUrl || 'auto')).digest('hex').slice(0, 8)}.json`,
  )
const pendingFile = (machine, boardUrl) =>
  path.join(
    STATE_DIR,
    `pending-attach-${machine}-${crypto.createHash('sha1').update(String(boardUrl || 'auto')).digest('hex').slice(0, 8)}.json`,
  )
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function makeCtx(origin) {
  const tools = new Map()
  const routes = new Map()
  return {
    tools: {
      register(spec) {
        tools.set(spec.name, spec)
        return () => tools.delete(spec.name)
      },
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec)
        return () => routes.delete(spec.path)
      },
      getOrigin() {
        return origin
      },
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'connection') return undefined
      return { authenticatedUrl: (u) => (u.includes('?') ? u + '&token=smoke' : u + '?token=smoke') }
    },
    effect() {
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
    _tools: tools,
    _routes: routes,
  }
}

/**
 * 假板子 + 假 hub。
 * `hub` 决定 /api/remote-agent/ui/dispatch 的行为：
 *   { mode: 'ok' }             立刻建任务并回执
 *   { mode: 'unknown-create' } 先建任务、再拖到超时（客户端 abort）
 *   { mode: 'unknown-drop' }   不建任务、拖到超时（客户端 abort）
 *   { mode: 'fail', times }    前 N 次 500
 */
function startServer({ tasks, hub }) {
  const stats = { take: 0, untake: 0, attach: 0, dispatch: 0, mark: 0 }
  const remoteTasks = []
  const dispatchCalls = []

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    const send = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    const readBody = () =>
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
      })

    if (p === '/api/health') return send(200, { ok: true })

    if (p === '/api/board') {
      return send(200, {
        updated: Math.floor(Date.now() / 1000),
        counts: { queued: Object.values(tasks).filter((t) => t.status === 'queued').length },
        machines: { host: { online: true, status: 'idle', last_seen: Math.floor(Date.now() / 1000) } },
        tasks: Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, { ...t, updated_at: Math.floor(Date.now() / 1000) }])),
        events: [],
      })
    }

    if (p === '/api/take') {
      stats.take += 1
      return readBody().then((b) => {
        const t = tasks[b.task_id]
        if (!t) return send(404, { error: 'no-such-task' })
        t.status = 'claimed'
        t.taker = 'host'
        return send(200, { ok: true })
      })
    }

    if (p === '/api/untake') {
      stats.untake += 1
      return readBody().then((b) => {
        const t = tasks[b.task_id]
        if (t) {
          t.status = 'queued'
          t.taker = ''
        }
        return send(200, { ok: true })
      })
    }

    if (p === '/api/attach') {
      stats.attach += 1
      return readBody().then((b) => {
        const t = tasks[b.task_id]
        if (!t) return send(404, { error: 'no-such-task' })
        t.remote_id = String(b.remote_id || '')
        t.status = 'running'
        return send(200, { ok: true })
      })
    }

    if (p === '/api/caps' || p === '/api/metrics' || p === '/api/say') {
      return readBody().then(() => send(200, { ok: true }))
    }

    if (p === '/api/mark') {
      stats.mark += 1
      return readBody().then(() => send(200, { ok: true }))
    }

    if (p === '/api/remote-agent/ui/nodes') {
      return send(200, { nodes: [{ nodeId: 'smoke-node', online: true }] })
    }

    if (p === '/api/remote-agent/ui/tasks') {
      return send(200, { tasks: remoteTasks })
    }

    if (p === '/api/remote-agent/ui/dispatch') {
      stats.dispatch += 1
      return readBody().then(async (b) => {
        dispatchCalls.push({ goal: b.goal, node: b.node, mode: b.mode })
        const create = () => {
          const taskId = 'ui-' + Math.random().toString(36).slice(2, 8)
          remoteTasks.push({ taskId, goal: String(b.goal || ''), mode: b.mode, createdAt: Date.now(), status: 'running' })
          return taskId
        }
        if (hub.mode === 'ok') return send(200, { ok: true, taskId: create(), nodeId: b.node })
        if (hub.mode === 'unknown-create') {
          create()
          await sleep(1200)
          return send(200, { ok: true, taskId: 'late' })
        }
        if (hub.mode === 'unknown-drop') {
          await sleep(1200)
          return send(200, { ok: true, taskId: 'late' })
        }
        if (hub.mode === 'unknown-drop-once') {
          // 只有第一次"发出去但没回执"，之后正常 —— 用来验证澄清后只重派一次
          if (stats.dispatch === 1) {
            await sleep(1200)
            return send(200, { ok: true, taskId: 'late' })
          }
          return send(200, { ok: true, taskId: create(), nodeId: b.node })
        }
        if (hub.mode === 'fail') {
          if (stats.dispatch <= Number(hub.times || 0)) return send(500, { error: 'boom' })
          return send(200, { ok: true, taskId: create(), nodeId: b.node })
        }
        return send(500, { error: 'unknown-mode' })
      })
    }

    send(404, { error: 'not-found', path: p })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}`,
        stats,
        remoteTasks,
        dispatchCalls,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

async function scenario(name, { hub, tasks, machine, seedJournal, waitMs = 2600, settle }) {
  const boardUrl = null
  let srv = null
  let cleanup = null
  try {
    srv = await startServer({ tasks, hub })
    const jf = journalFile(machine, srv.url)
    const pf = pendingFile(machine, srv.url)
    for (const f of [jf, pf]) fs.rmSync(f, { force: true })
    if (seedJournal) {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(jf, JSON.stringify(seedJournal(Date.now())), 'utf8')
    }
    const ctx = makeCtx(srv.url)
    cleanup = apply(ctx, {
      boardUrl: srv.url,
      machine,
      timeoutMs: 400,
      dispatchTickMs: 250,
      unknownGraceMs: 400,
      writeTimeoutMs: 400,
      dispatchApproval: 'auto',
      allowedRoots: [],
    })
    await sleep(waitMs)
    const journal = readJson(jf)
    const info = { journal, stats: srv.stats, tasks, remoteTasks: srv.remoteTasks, dispatchCalls: srv.dispatchCalls }
    if (settle) await settle(info)
    return info
  } finally {
    try {
      if (cleanup) cleanup()
    } catch {
      /* ignore */
    }
    if (srv) await srv.close()
    void boardUrl
  }
}

function summary() {
  const ok = results.filter((r) => r.ok).length
  console.log('')
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
  console.log('')
  console.log(`dispatch-recovery-smoke: ${ok}/${results.length} passed`)
  return ok === results.length
}

async function main() {
  // ── R1：结果未知，但远端其实已经建了任务 → 只补绑，不许重派 ──────────
  {
    const tasks = { 'bd-r1': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R1 goal', machine: '' } }
    const info = await scenario('R1', {
      hub: { mode: 'unknown-create' },
      tasks,
      machine: 'smoke-r1',
      waitMs: 3000,
    })
    check('R1 只发了一次 /dispatch（未重派）', info.stats.dispatch === 1, `dispatch=${info.stats.dispatch}`)
    check('R1 远端任务被认领回来并 attach', info.stats.attach === 1, `attach=${info.stats.attach}`)
    check('R1 板上已写入 remote_id', String(info.tasks['bd-r1'].remote_id || '').startsWith('ui-'), info.tasks['bd-r1'].remote_id || '(空)')
    check('R1 恢复日志已清空', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
    check('R1 没有被 untake 后重来', info.stats.untake === 0, `untake=${info.stats.untake}`)
  }

  // ── R2：结果未知，远端确实没建 → 放回队列，只重派一次 ────────────────
  {
    const tasks = { 'bd-r2': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R2 goal', machine: '' } }
    let remoteAt = 0
    const info = await scenario('R2', {
      hub: { mode: 'unknown-drop-once' },
      tasks,
      machine: 'smoke-r2',
      waitMs: 3200,
      settle: async (i) => {
        remoteAt = i.remoteTasks.length
      },
    })
    check('R2 第一次结果未知后又重派了一次', info.stats.dispatch === 2, `dispatch=${info.stats.dispatch}`)
    check('R2 澄清时把板子占位放回队列', info.stats.untake >= 1, `untake=${info.stats.untake}`)
    check('R2 最终只成功建了一条远端任务', remoteAt === 1, `remote=${remoteAt}`)
    check('R2 仍然完成了 attach', info.stats.attach === 1, `attach=${info.stats.attach}`)
    check('R2 恢复日志已清空', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
  }

  // ── R3：已认领未发出（崩溃恢复）→ 不重新 take，直接补发 ───────────────
  {
    const tasks = { 'bd-r3': { status: 'claimed', taker: 'smoke-r3', dispatch: 'auto', mode: 'agent', goal: 'R3 goal', machine: '' } }
    const info = await scenario('R3', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r3',
      waitMs: 1600,
      seedJournal: (now) => [
        { taskId: 'bd-r3', nodeId: 'smoke-node', machine: 'smoke-r3', goal: 'R3 goal', mode: 'agent', workspace: '', phase: 'claimed', at: now, lastError: '' },
      ],
    })
    check('R3 恢复时不重新 take', info.stats.take === 0, `take=${info.stats.take}`)
    check('R3 直接补发了 dispatch', info.stats.dispatch === 1, `dispatch=${info.stats.dispatch}`)
    check('R3 完成 attach', info.stats.attach === 1, `attach=${info.stats.attach}`)
    check('R3 恢复日志已清空', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
  }

  return summary()
}

const ok = await main()
process.exit(ok ? 0 : 1)
