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

// v1.4.1：插件新增了 <stateDir>/config.json 兜底，会写进状态目录。测试若共用真实的
// ~/.dsh/dsh-team，场景之间会互相继承 token/machine/dispatchRole（实测把 76 项打成 43 项），
// 也会污染真实环境。这里改成独立临时目录。
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-dispatch-smoke-'))
process.env.DSH_TEAM_STATE_DIR = STATE_DIR
const journalFile = (machine, boardUrl) =>
  path.join(
    STATE_DIR,
    `dispatch-journal-${machine}-${crypto.createHash('sha1').update(String(boardUrl || 'auto')).digest('hex').slice(0, 8)}.json`,
  )
const ownersFile = (machine) => path.join(STATE_DIR, `remote-owners-${machine}.json`)
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
function startServer({ tasks, hub, seedRemoteTasks, markStatus }) {
  const stats = { take: 0, untake: 0, attach: 0, dispatch: 0, mark: 0, holderConflict: 0 }
  const remoteTasks = Array.isArray(seedRemoteTasks) ? seedRemoteTasks.slice() : []
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
        const machine = String(b.machine || '')
        const holder = String(b.holder || '')
        // v1.3.3：与 board_server.py do_take 同构 —— 同机不同实例不再算重入。
        if (t.status === 'claimed' && t.taker && t.taker !== machine) {
          return send(409, { error: 'taken-by-other', taker: t.taker })
        }
        if (t.status === 'claimed' && t.taker === machine && t.holder && holder && t.holder !== holder) {
          stats.holderConflict += 1
          return send(409, { error: 'held-by-other-instance', taker: t.taker, holder: t.holder })
        }
        t.status = 'claimed'
        t.taker = machine || t.taker || 'host'
        if (holder) t.holder = holder
        t.lease_until = Date.now() + 10 * 60 * 1000
        return send(200, { ok: true, taken: true })
      })
    }

    if (p === '/api/untake') {
      stats.untake += 1
      return readBody().then((b) => {
        const t = tasks[b.task_id]
        if (t) {
          t.status = 'queued'
          t.taker = ''
          delete t.holder
          delete t.remote_id
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
        t.taker = ''
        delete t.holder
        return send(200, { ok: true })
      })
    }

    if (p === '/api/caps' || p === '/api/metrics' || p === '/api/say') {
      return readBody().then(() => send(200, { ok: true }))
    }

    if (p === '/api/mark') {
      stats.mark += 1
      return readBody().then((b) => {
        // R10：模拟"标 blocked 恒失败" —— 这时绝对不能丢 journal 凭据。
        if (Number(markStatus || 200) >= 400) return send(Number(markStatus), { error: 'mark-boom' })
        const t = tasks[b.task_id]
        if (t && b.status) {
          t.status = String(b.status)
          if (b.note) t.note = String(b.note)
        }
        return send(200, { ok: true })
      })
    }

    if (p === '/api/remote-agent/ui/nodes') {
      return send(200, { nodes: [{ nodeId: 'smoke-node', online: true }] })
    }

    if (p === '/api/remote-agent/ui/tasks') {
      // R23（v1.3.4 复核 N1）：反查接口本身失败时，插件不许断言"远端没有"。
      if (hub && hub.tasksStatus) return send(hub.tasksStatus, { error: 'hub tasks boom' })
      // R16：模拟 hub 的 200 条上限 —— 节点上任务攒满了，我们那条老任务被切到窗口外。
      //   flood: 'newer'     → 200 条全都比发出时刻新（无法判断远端有没有）
      //   flood: 'crossing'  → 200 条里最老的跨过了发出时刻（窗口覆盖到，能判定"没有"）
      if (hub && hub.flood) {
        const now = Date.now()
        const rows = []
        for (let i = 0; i < 200; i += 1) {
          const ts = hub.flood === 'crossing' && i === 199 ? now - 60000 : now - i * 10
          rows.push({
            taskId: 'ui-flood-' + i, nodeId: 'smoke-node', goal: 'flood goal ' + i,
            mode: 'agent', createdAt: ts, updatedAt: ts, status: 'done',
          })
        }
        return send(200, { tasks: rows })
      }
      return send(200, { tasks: remoteTasks })
    }

    if (p === '/api/remote-agent/ui/task') {
      // v1.3.0：attach 之前插件会核实远端任务是否还在（/api/remote-agent/ui/task?taskId=）。
      // hub.probeMissing 用来构造"dispatch 回了 taskId，但 hub 上查不到"（远端已被回收）。
      const taskId = url.searchParams.get('taskId') || ''
      if (hub && hub.probeMissing) return send(404, { error: 'TASK_UNKNOWN', taskId })
      const t = remoteTasks.find((x) => String(x.taskId) === taskId)
      if (!t) return send(404, { error: 'TASK_UNKNOWN', taskId })
      return send(200, { task: Object.assign({ logs: [] }, t), handoff: null })
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
        // R14：永久 4xx —— 明确的失败，必须退避，不能每 tick 重来。
        if (hub.mode === 'always-400') return send(400, { error: 'bad-goal' })
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

async function scenario(name, { hub, tasks, machine, seedJournal, seedRemoteOwners, seedPendingAttach, seedRemoteTasks, during, markStatus, extraCfg, waitMs = 2600, settle }) {
  const boardUrl = null
  let srv = null
  let cleanup = null
  try {
    srv = await startServer({ tasks, hub, seedRemoteTasks, markStatus })
    const jf = journalFile(machine, srv.url)
    const pf = pendingFile(machine, srv.url)
    for (const f of [jf, pf]) fs.rmSync(f, { force: true })
    if (seedJournal) {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(jf, JSON.stringify(seedJournal(Date.now())), 'utf8')
    }
    if (seedRemoteOwners) {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(ownersFile(machine), JSON.stringify(seedRemoteOwners(Date.now())), 'utf8')
    } else {
      fs.rmSync(ownersFile(machine), { force: true })
    }
    if (seedPendingAttach) {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(pf, JSON.stringify(seedPendingAttach(Date.now())), 'utf8')
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
      // v1.4.1：配置兜底会把上一场景显式写过的 dispatchRole 留在 config.json 里；
      // 这里默认 owner，避免 R21/R20 这类没写 role 的场景继承成 observer 后不派工。
      dispatchRole: 'owner',
      allowedRoots: [],
      ...(extraCfg || {}),
    })
    // `during`：在 apply 之后、断言之前插一段外部动作（模拟另一个 Host 实例写同一个
    // 状态文件）。先睡 150ms 保证本实例已经读过（当时是空的）盘上内容。
    await sleep(150)
    if (during) await during({ journalFile: jf, pendingFile: pf })
    await sleep(waitMs)
    const journal = readJson(jf)
    const info = { journal, stats: srv.stats, tasks, remoteTasks: srv.remoteTasks, dispatchCalls: srv.dispatchCalls, pendingAttach: readJson(pf) || [], remoteOwners: readJson(ownersFile(machine)) || [] }
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

  // ── R24（v1.3.10 D2）：待补绑的任务归执行机所有，mark 必须按执行机名发 ──────
  // 以前 attachTask / retryPendingAttach 传 cfg.machine（调度器名），多机部署下板子
  // 回 409「不是你占的」，任务永远卡 claimed、待补绑记录 6 小时才过期。
  {
    const info = await scenario('R24', {
      machine: 'host',                 // 调度器名
      tasks: { 'bd-r24': { status: 'claimed', machine: 'MB14', goal: 'R24 goal', remote_id: '' } },
      seedPendingAttach: (now) => [
        // 远端任务已经不存在（hub 查不到）→ 走 mark 标 failed 的那条分支
        { taskId: 'bd-r24', remoteId: 'ui-gone-r24', machine: 'MB14', tries: 1, at: now - 1000 },
      ],
    })
    check('R24 远端缺失时把任务标成 failed', info.tasks['bd-r24'].status === 'failed', info.tasks['bd-r24'].status)
    check('R24 不是 409 卡在 claimed', info.tasks['bd-r24'].status !== 'claimed', info.tasks['bd-r24'].status)
    check('R24 待补绑记录已清空', Array.isArray(info.pendingAttach) && info.pendingAttach.length === 0, JSON.stringify(info.pendingAttach))
  }

  // ── R25（v1.4.0 D6 尾巴）：板上已终态的任务，账本条目要被清掉 ─────────────
  // 板子自己的 reconcile_once 常常先一步把任务标 done，插件 syncRemote 的终态分支
  // 不会再执行；以前账本条目要等下一次写入的 12h TTL 才过期。
  {
    const info = await scenario('R25', {
      machine: 'smoke-r25',
      extraCfg: { remoteSyncMs: 300 },
      tasks: { 'bd-r25': { status: 'done', machine: 'GT14', remote_id: 'ui-r25', goal: 'R25 goal' } },
      seedRemoteOwners: (now) => [
        { taskId: 'bd-r25', remoteId: 'ui-r25', machine: 'GT14', at: now },
        { taskId: 'bd-r25-other', remoteId: 'ui-r25b', machine: 'MB14', at: now },
      ],
      waitMs: 2200,
    })
    const left = (info.remoteOwners || []).map((r) => String(r.taskId))
    check('R25 已终态任务的账本条目被清理', !left.includes('bd-r25'), JSON.stringify(left))
    check('R25 其它任务条目不受影响', left.includes('bd-r25-other'), JSON.stringify(left))
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
        { taskId: 'bd-r3', nodeId: 'smoke-node', machine: 'smoke-r3', goal: 'R3 goal', mode: 'agent', workspace: '', phase: 'claimed', attempts: 1, at: now, lastError: '' },
      ],
    })
    check('R3 恢复时不重新 take', info.stats.take === 0, `take=${info.stats.take}`)
    check('R3 直接补发了 dispatch', info.stats.dispatch === 1, `dispatch=${info.stats.dispatch}`)
    check('R3 完成 attach', info.stats.attach === 1, `attach=${info.stats.attach}`)
    check('R3 恢复日志已清空', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
  }

  // ── R4（复核 B2）：反查窗口必须按「发出时刻」sentAt 算，而不是「放弃时刻」at ──
  // 场景：POST 发出（sentAt=now-15s）→ 远端立刻建了任务（createdAt=now-15s）→
  // 请求一直拖到 now 才失败（at=now）。旧代码用 at-5s 作下界，恒查不到 → 重复派工。
  {
    const tasks = { 'bd-r4': { status: 'claimed', taker: 'smoke-r4', dispatch: 'auto', mode: 'agent', goal: 'R4 goal', machine: '' } }
    const info = await scenario('R4', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r4',
      waitMs: 1600,
      seedRemoteTasks: [
        { taskId: 'ui-seed4', goal: 'R4 goal', mode: 'agent', createdAt: Date.now() - 15000, status: 'running' },
      ],
      seedJournal: (now) => [
        {
          taskId: 'bd-r4', nodeId: 'smoke-node', machine: 'smoke-r4', goal: 'R4 goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 15000, at: now, lastError: '',
        },
      ],
    })
    check('R4 慢请求窗口内仍认得远端那条任务（不重派）', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R4 补绑的是远端那条老任务', info.stats.attach === 1 && String(info.tasks['bd-r4'].remote_id) === 'ui-seed4', `${info.stats.attach} / ${info.tasks['bd-r4'].remote_id}`)
    check('R4 没有把占位放回队列', info.stats.untake === 0, `untake=${info.stats.untake}`)
    check('R4 恢复日志已清空', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
  }

  // ── R5（复核 B3）：板上已回绑 remote 时 drop 分支必须生效（字段名 remote 非 remote_id）──
  {
    const tasks = {
      'bd-r5': { status: 'running', taker: 'smoke-r5', remote_id: 'ui-old5', dispatch: 'auto', mode: 'agent', goal: 'R5 goal', machine: '' },
    }
    const info = await scenario('R5', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r5',
      waitMs: 1200,
      seedJournal: (now) => [
        {
          taskId: 'bd-r5', nodeId: 'smoke-node', machine: 'smoke-r5', goal: 'R5 goal', mode: 'agent',
          workspace: '', phase: 'claimed', attempts: 1, at: now, lastError: '',
        },
      ],
    })
    check('R5 已回绑的任务不被补发', info.stats.dispatch === 0 && info.stats.take === 0, `dispatch=${info.stats.dispatch} take=${info.stats.take}`)
    check('R5 remote_id 未被覆盖', String(info.tasks['bd-r5'].remote_id) === 'ui-old5', info.tasks['bd-r5'].remote_id)
    check('R5 残留日志被清掉', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
  }

  // ── R6（复核 中）：板上被别的机器占着 → 不当成「本机已认领未发出」补发 ──
  {
    const tasks = {
      'bd-r6': { status: 'claimed', taker: 'mb-other', dispatch: 'auto', mode: 'agent', goal: 'R6 goal', machine: '' },
    }
    const info = await scenario('R6', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r6',
      waitMs: 1200,
      seedJournal: (now) => [
        {
          taskId: 'bd-r6', nodeId: 'smoke-node', machine: 'smoke-r6', goal: 'R6 goal', mode: 'agent',
          workspace: '', phase: 'claimed', attempts: 1, at: now, lastError: '',
        },
      ],
    })
    check('R6 不抢别人的单', info.stats.take === 0 && info.stats.dispatch === 0, `take=${info.stats.take} dispatch=${info.stats.dispatch}`)
  }

  // ── R7（复核 H4/H5）：尝试次数到上限 → 标 blocked，不再无限重派 ──────────
  {
    const tasks = { 'bd-r7': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R7 goal', machine: '' } }
    const info = await scenario('R7', {
      hub: { mode: 'unknown-drop' },
      tasks,
      machine: 'smoke-r7',
      waitMs: 1800,
      seedJournal: (now) => [
        {
          taskId: 'bd-r7', nodeId: 'smoke-node', machine: 'smoke-r7', goal: 'R7 goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 3, sentAt: now - 40000, at: now - 30000, lastError: 'timeout',
        },
      ],
    })
    check('R7 达上限后不再派工', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R7 升级成 blocked（写了 /api/mark）', info.stats.mark >= 1, `mark=${info.stats.mark}`)
    check('R7 恢复日志已清空', Array.isArray(info.journal) && info.journal.length === 0, JSON.stringify(info.journal))
  }

  // ── R8（复核 H6）：两个 Host 实例共用同一台机器的状态文件 → 写回必须先读再合并 ──
  // 另一个实例在本实例启动后才写入一条在途记录；本实例随后因派工落盘时不能把它抹掉。
  {
    const tasks = {
      'bd-r8': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R8 goal', machine: '' },
    }
    const info = await scenario('R8', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r8',
      waitMs: 1500,
      during: async ({ journalFile }) => {
        let rows = []
        try {
          rows = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
        } catch {
          rows = []
        }
        rows.push({
          taskId: 'bd-ghost-8', nodeId: 'smoke-node', machine: 'smoke-r8', goal: '另一个实例的任务',
          mode: 'agent', workspace: '', phase: 'unknown', at: Date.now(), sentAt: Date.now(), attempts: 1, lastError: 'x',
        })
        fs.writeFileSync(journalFile, JSON.stringify(rows, null, 2), 'utf8')
      },
    })
    const kept = (Array.isArray(info.journal) ? info.journal : []).some((r) => r && r.taskId === 'bd-ghost-8')
    check('R8 写回时保住了另一个实例的在途记录', kept, JSON.stringify(info.journal))
    check('R8 本实例自己的条目照样收尾', info.stats.attach === 1, `attach=${info.stats.attach}`)
  }

  // ── R9（复核 D2）：goal 首尾空白/连续空白不同，仍要认得出是同一条任务 ──────
  // 板子存原文、remote-agent 落库前会 trim()；旧代码全等比较 → 判"远端没有" → 重派。
  {
    const tasks = {
      'bd-r9': { status: 'claimed', taker: 'host', dispatch: 'auto', mode: 'agent', goal: 'R9  goal', machine: 'smoke-node' },
    }
    const info = await scenario('R9', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r9',
      waitMs: 1200,
      seedRemoteTasks: [
        { taskId: 'ui-space9', goal: '  R9   goal\n', mode: 'agent', createdAt: Date.now() - 2000, status: 'running' },
      ],
      seedJournal: (now) => [
        {
          taskId: 'bd-r9', nodeId: 'smoke-node', machine: 'smoke-r9', goal: 'R9  goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
    })
    check('R9 空白差异不影响反查（不重派）', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R9 把远端那条任务补绑回来', String(info.tasks['bd-r9'].remote_id) === 'ui-space9', info.tasks['bd-r9'].remote_id)
    check('R9 没有把占位放回队列', info.stats.untake === 0, `untake=${info.stats.untake}`)
  }

  // ── R10（复核 D6）：标 blocked 恒失败时不能丢凭据，也不能再派 ────────────
  {
    const tasks = { 'bd-r10': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R10 goal', machine: '' } }
    const info = await scenario('R10', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r10',
      waitMs: 1800,
      markStatus: 500,
      seedJournal: (now) => [
        {
          taskId: 'bd-r10', nodeId: 'smoke-node', machine: 'smoke-r10', goal: 'R10 goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 3, sentAt: now - 40000, at: now - 30000, lastError: 'timeout',
        },
      ],
    })
    const still = (Array.isArray(info.journal) ? info.journal : []).find((r) => r && r.taskId === 'bd-r10')
    check('R10 mark 失败后凭据仍在（没有被静默丢掉）', Boolean(still), JSON.stringify(info.journal))
    check('R10 mark 失败后不再派工', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R10 至少尝试过标 blocked', info.stats.mark >= 1, `mark=${info.stats.mark}`)
  }

  // ── R11（复核 D3）：板上已经回绑 remote、任务在跑 → 绝不 untake ────────────
  {
    const tasks = {
      'bd-r11': { status: 'running', taker: 'host', remote_id: 'ui-run11', dispatch: 'auto', mode: 'agent', goal: 'R11 goal', machine: 'smoke-node' },
    }
    const info = await scenario('R11', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r11',
      waitMs: 1200,
      seedJournal: (now) => [
        {
          taskId: 'bd-r11', nodeId: 'smoke-node', machine: 'smoke-r11', goal: 'R11 goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
    })
    check('R11 正在跑的任务没被 untake', info.stats.untake === 0, `untake=${info.stats.untake}`)
    check('R11 也没被重派', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R11 remote_id 保持不变', String(info.tasks['bd-r11'].remote_id) === 'ui-run11', info.tasks['bd-r11'].remote_id)
  }

  // ── R12（复核 D4）：两条板子任务同 goal，不能认领同一条远端任务 ───────────
  {
    const tasks = {
      'bd-r12a': { status: 'claimed', taker: 'host', dispatch: 'auto', mode: 'agent', goal: 'R12 同名任务', machine: 'smoke-node' },
      'bd-r12b': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R12 同名任务', machine: 'smoke-node' },
    }
    const info = await scenario('R12', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r12',
      waitMs: 1800,
      seedRemoteTasks: [
        { taskId: 'ui-shared12', goal: 'R12 同名任务', mode: 'agent', createdAt: Date.now() - 2000, status: 'running' },
      ],
      seedJournal: (now) => [
        {
          taskId: 'bd-r12a', nodeId: 'smoke-node', machine: 'smoke-r12', goal: 'R12 同名任务', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
    })
    const ra = String(info.tasks['bd-r12a'].remote_id || '')
    const rb = String(info.tasks['bd-r12b'].remote_id || '')
    check('R12 补绑的那条认领了既有远端任务', ra === 'ui-shared12', ra)
    check('R12 另一条没有绑到同一条远端任务', rb !== '' && rb !== ra, `a=${ra} b=${rb}`)
    check('R12 远端任务没有被两条板子任务共享', info.remoteTasks.filter((t) => t.taskId === 'ui-shared12').length === 1, info.remoteTasks.length)
  }

  // ── R13（复核 D5）：写盘失败后墓碑不能提前清 —— 被删的条目不许复活 ────────
  // 做法：把 journal 文件设成只读，让一次删除的落盘失败；随后恢复可写并触发下一次保存，
  // 断言被删的条目没有从磁盘"读回-合并"里复活。
  {
    const tasks = {
      'bd-r13': { status: 'running', taker: 'host', remote_id: 'ui-old13', dispatch: 'auto', mode: 'agent', goal: 'R13 goal', machine: 'smoke-node' },
      'bd-r13b': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R13 second', machine: '' },
    }
    const info = await scenario('R13', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r13',
      waitMs: 2200,
      seedJournal: (now) => [
        {
          taskId: 'bd-r13', nodeId: 'smoke-node', machine: 'smoke-r13', goal: 'R13 goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
      during: async ({ journalFile }) => {
        try {
          fs.chmodSync(journalFile, 0o444)
        } catch {
          /* ignore */
        }
        // 让第一次删除在这里撞上只读文件（rename 失败）
        await sleep(1200)
        try {
          fs.chmodSync(journalFile, 0o666)
        } catch {
          /* ignore */
        }
      },
    })
    const rows = Array.isArray(info.journal) ? info.journal : []
    check('R13 已删条目没有复活', !rows.some((r) => r && r.taskId === 'bd-r13'), JSON.stringify(rows.map((r) => r.taskId)))
    check('R13 同一文件里别的实例条目仍在（写盘恢复可用）', info.stats.attach >= 1, `attach=${info.stats.attach}`)
  }

  // ── R14（复核 S2）：永久 4xx 必须退避，不能每 4 秒重打 ────────────────────
  {
    const tasks = { 'bd-r14': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R14 goal', machine: '' } }
    const info = await scenario('R14', {
      hub: { mode: 'always-400' },
      tasks,
      machine: 'smoke-r14',
      waitMs: 6000,
    })
    check('R14 永久失败有退避（6 秒内不反复重打）', info.dispatchCalls.length <= 2, `dispatch=${info.dispatchCalls.length}`)
    check('R14 失败后仍会把占位放回队列', info.stats.untake >= 1, `untake=${info.stats.untake}`)
  }

  // ── R12b（复核 D4）：远端任务已经被**别的**板子任务占用 → 不许再认领 ─────
  {
    const tasks = {
      'bd-r12c': { status: 'running', taker: 'host', remote_id: 'ui-taken12', dispatch: 'auto', mode: 'agent', goal: 'R12b 同名', machine: 'smoke-node' },
      'bd-r12d': { status: 'claimed', taker: 'host', dispatch: 'auto', mode: 'agent', goal: 'R12b 同名', machine: 'smoke-node' },
    }
    const info = await scenario('R12b', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r12b',
      waitMs: 1800,
      seedRemoteTasks: [
        { taskId: 'ui-taken12', goal: 'R12b 同名', mode: 'agent', createdAt: Date.now() - 2000, status: 'running' },
      ],
      seedJournal: (now) => [
        {
          taskId: 'bd-r12d', nodeId: 'smoke-node', machine: 'smoke-r12b', goal: 'R12b 同名', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
    })
    // 允许它被放回队列后自己派一条新的，但绝不能绑到别人正在用的那条远端任务上。
    check('R12b 不认领已被别的任务占用的远端任务', String(info.tasks['bd-r12d'].remote_id || '') !== 'ui-taken12', String(info.tasks['bd-r12d'].remote_id || ''))
    check('R12b 原占用者保持不变', String(info.tasks['bd-r12c'].remote_id) === 'ui-taken12', info.tasks['bd-r12c'].remote_id)
  }

  // ── R15（复核 D1+S2）：结果永远未知时 attempts 必须累计、最终有界停下 ──────
  {
    const tasks = { 'bd-r15': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R15 goal', machine: '' } }
    const info = await scenario('R15', {
      hub: { mode: 'unknown-drop' },
      tasks,
      machine: 'smoke-r15',
      waitMs: 8000,
    })
    check('R15 重派次数有上界（attempts 上限生效）', info.dispatchCalls.length <= 3, `dispatch=${info.dispatchCalls.length}`)
    check('R15 最终升级成 blocked', info.stats.mark >= 1, `mark=${info.stats.mark}`)
    check('R15 到达终态后不再继续 untake', info.stats.untake <= 3, `untake=${info.stats.untake}`)
  }

  // ── R16（复核 · 反查上限）：/tasks 被 200 条上限截断时，不许判定"远端没有" ──
  // hub 是 tasks.slice(0, 200) 按 updatedAt 倒序；节点任务攒满后我们那条在途任务会在
  // 窗口外。这时说"没有"就会 untake 重派 —— 又是一次重复执行。
  {
    const tasks = {
      'bd-r16': { status: 'claimed', taker: 'host', dispatch: 'auto', mode: 'agent', goal: 'R16 goal', machine: 'smoke-node' },
    }
    const info = await scenario('R16', {
      hub: { mode: 'ok', flood: 'newer' },
      tasks,
      machine: 'smoke-r16',
      waitMs: 2400,
      seedJournal: (now) => [
        {
          taskId: 'bd-r16', nodeId: 'smoke-node', machine: 'smoke-r16', goal: 'R16 goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
    })
    check('R16 列表被截断时不敢放回队列', info.stats.untake === 0, `untake=${info.stats.untake}`)
    check('R16 也不重派', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    const kept = (Array.isArray(info.journal) ? info.journal : []).find((r) => r && r.taskId === 'bd-r16')
    const tracked = Boolean(kept) && Number(kept.unresolved || 0) >= 1
    // 跑得久一点时它会被有界地升级成 blocked（而不是一直挂着）—— 两种收尾都算"没有偷偷重派"。
    check('R16 条目被追踪（记 unresolved）或有界升级 blocked', tracked || info.stats.mark >= 1,
      `kept=${JSON.stringify(kept)} mark=${info.stats.mark}`)
  }

  // ── R16b（同一处的反面）：窗口确实覆盖到发出时刻 → "没有"是可判定的，照常放回队列 ──
  {
    const tasks = {
      'bd-r16b': { status: 'claimed', taker: 'host', dispatch: 'auto', mode: 'agent', goal: 'R16b goal', machine: 'smoke-node' },
    }
    const info = await scenario('R16b', {
      hub: { mode: 'ok', flood: 'crossing' },
      tasks,
      machine: 'smoke-r16b',
      waitMs: 2400,
      seedJournal: (now) => [
        {
          taskId: 'bd-r16b', nodeId: 'smoke-node', machine: 'smoke-r16b', goal: 'R16b goal', mode: 'agent',
          workspace: '', phase: 'unknown', attempts: 1, sentAt: now - 3000, at: now - 2000, lastError: 'timeout',
        },
      ],
    })
    check('R16b 窗口覆盖到发出时刻时照常澄清', info.stats.untake >= 1, `untake=${info.stats.untake}`)
  }

  // ── R17（#10-2 · 调度所有权）：dispatchRole=observer 只建单，不派工 ──
  {
    const tasks = {
      'bd-r17': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R17 goal', machine: 'smoke-node', priority: 5 },
    }
    const info = await scenario('R17', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r17',
      extraCfg: { dispatchRole: 'observer' },
      waitMs: 1600,
    })
    check('R17 observer 不派工', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R17 observer 不认领', info.stats.take === 0, `take=${info.stats.take}`)
  }

  // ── R18（#10-2 · attach 校验）：hub 回了 taskId 但远端查不到（已被回收）→ 不写 remote_id ──
  {
    const tasks = {
      'bd-r18': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R18 goal', machine: 'smoke-node', priority: 5 },
    }
    const info = await scenario('R18', {
      hub: { mode: 'ok', probeMissing: true },
      tasks,
      machine: 'smoke-r18',
      waitMs: 2400,
    })
    check('R18 远端查不到时不 attach', info.stats.attach === 0, `attach=${info.stats.attach}`)
    check('R18 没有写入 remote_id', !info.tasks['bd-r18'] || !info.tasks['bd-r18'].remote_id,
      `remote_id=${JSON.stringify(info.tasks['bd-r18'] && info.tasks['bd-r18'].remote_id)}`)
    check('R18 板子任务被标 failed', info.tasks['bd-r18'] && info.tasks['bd-r18'].status === 'failed',
      `status=${info.tasks['bd-r18'] && info.tasks['bd-r18'].status}`)
  }

  // ── R19（#10-2 · 跨 Host 收敛 / v1.3.11 D6）：板上的 remote_id 已被别的 Host 改写
  //    —— 本机 journal 记的还是当初那条 ui-r19-old，此时绝不回写终态。──
  {
    const tasks = {
      'bd-r19': {
        status: 'running', taker: 'mb-other', dispatch: 'auto', mode: 'agent', goal: 'R19 goal',
        machine: 'smoke-node', remote_id: 'ui-r19', priority: 5,
      },
    }
    const info = await scenario('R19', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r19',
      extraCfg: { remoteSyncMs: 300 },
      seedRemoteTasks: [{ taskId: 'ui-r19', nodeId: 'smoke-node', goal: 'R19 goal', status: 'completed', createdAt: Date.now() - 5000, updatedAt: Date.now() }],
      seedRemoteOwners: (now) => [{
        taskId: 'bd-r19', remoteId: 'ui-r19-old', machine: 'smoke-r19', at: now,
      }],
      waitMs: 2600,
    })
    check('R19 板上 remote_id 变过就不回写', info.stats.mark === 0, `mark=${info.stats.mark}`)
    check('R19 板上状态没被覆盖', info.tasks['bd-r19'].status === 'running', `status=${info.tasks['bd-r19'].status}`)
  }

  // ── R20（v1.3.1 · 多实例并发写）：上一个实例崩溃留下的僵尸锁不许把状态写入卡死 ──
  {
    const tasks = {
      'bd-r20': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R20 goal', machine: 'smoke-node', priority: 5 },
    }
    const info = await scenario('R20', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r20',
      waitMs: 2400,
      during: async ({ journalFile }) => {
        const lock = journalFile + '.lock'
        fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }))
        const old = Date.now() - 600000
        fs.utimesSync(lock, old / 1000, old / 1000)
      },
    })
    check('R20 僵尸锁不影响派工', info.stats.dispatch === 1 && info.stats.attach === 1,
      `dispatch=${info.stats.dispatch} attach=${info.stats.attach}`)
    check('R20 派工成功后 journal 已清空', (Array.isArray(info.journal) ? info.journal.length : 0) === 0,
      JSON.stringify(info.journal))
  }

  // ── R22（v1.3.4 · 复核 🔴‑1/F4）：同机两个实例共用一个 journal 文件。
  // A 写了 taking/unknown 还没发出，B 读到这条记录时不能替 A 补发（resume 不过 /api/take，
  // 没有板子那层 holder 护栏），也不能把 A 的记录删掉。 ──
  {
    const tasks = {
      'bd-r22': { status: 'claimed', taker: 'smoke-r22', dispatch: 'auto', mode: 'agent', goal: 'R22 goal', machine: '' },
    }
    const info = await scenario('R22', {
      hub: { mode: 'ok' },
      tasks,
      machine: 'smoke-r22',
      waitMs: 2600,
      seedJournal: (now) => [{
        taskId: 'bd-r22', nodeId: 'smoke-node', machine: 'smoke-r22', goal: 'R22 goal',
        mode: 'agent', workspace: '', phase: 'taking', attempts: 1, at: now,
        holder: 'smoke-r22#9999-deadbeef', lastError: '',
      }],
    })
    check('R22 别人实例的在途记录不补发', info.stats.dispatch === 0, `dispatch=${info.stats.dispatch}`)
    check('R22 别人实例的记录没被删', Array.isArray(info.journal) && info.journal.length === 1,
      JSON.stringify(info.journal))
    check('R22 记录仍归原实例', String((info.journal[0] || {}).holder || '') === 'smoke-r22#9999-deadbeef',
      String((info.journal[0] || {}).holder || '(空)'))
  }

  // ── R23（v1.3.4 · 复核 N1）：升级 blocked 之前必须先查远端；反查接口本身报错时
  // 不许把任务判死 —— 以前 res 失败也往下走 mark blocked。 ──
  {
    const tasks = {
      'bd-r23': { status: 'claimed', taker: 'smoke-r23', dispatch: 'manual', mode: 'agent', goal: 'R23 goal', machine: '' },
    }
    const info = await scenario('R23', {
      hub: { mode: 'ok', tasksStatus: 500 },
      tasks,
      machine: 'smoke-r23',
      waitMs: 2600,
      seedJournal: (now) => [{
        taskId: 'bd-r23', nodeId: 'smoke-node', machine: 'smoke-r23', goal: 'R23 goal',
        mode: 'agent', workspace: '', phase: 'unknown', attempts: 1,
        firstAt: now - 3 * 60 * 60 * 1000, at: now - 3 * 60 * 60 * 1000, sentAt: now - 3 * 60 * 60 * 1000,
        lastError: '',
      }],
    })
    check('R23 反查失败时不标 blocked', info.stats.mark === 0, `mark=${info.stats.mark}`)
    check('R23 凭据仍保留', Array.isArray(info.journal) && info.journal.length === 1, JSON.stringify(info.journal))
    check('R23 板上状态没被改写', String(info.tasks['bd-r23'].status) === 'claimed', info.tasks['bd-r23'].status)
  }


  // ── R21（v1.3.3 · 复核 F1）：同一台机器上两个 DSH 进程（同 machine 名）——
  // 板子旧语义对同 machine 是幂等续租，两边都会往下派；新语义看 holder，第二个实例
  // 必须拿到 409 并停手，整条任务只允许派一次。 ──
  {
    const tasks = {
      'bd-r21': { status: 'queued', dispatch: 'auto', mode: 'agent', goal: 'R21 goal', machine: '' },
    }
    let srv = null
    let cleanupA = null
    let cleanupB = null
    try {
      srv = await startServer({ tasks, hub: { mode: 'ok' } })
      const machine = 'smoke-r21'
      const jf = journalFile(machine, srv.url)
      const pf = pendingFile(machine, srv.url)
      for (const f of [jf, pf]) fs.rmSync(f, { force: true })
      const base = {
        boardUrl: srv.url,
        machine,
        timeoutMs: 400,
        dispatchTickMs: 250,
        unknownGraceMs: 400,
        writeTimeoutMs: 400,
        dispatchApproval: 'auto',
        allowedRoots: [],
      }
      cleanupA = apply(makeCtx(srv.url), base)
      cleanupB = apply(makeCtx(srv.url), base)
      await sleep(2600)
      const journal = readJson(jf)
      check('R21 同机两实例只派一次', srv.stats.dispatch === 1, `dispatch=${srv.stats.dispatch}`)
      // 第二个实例是否撞上 holder 取决于两次 tick 的先后：A 先完成 take 后任务就是 claimed，
      // B 的候选过滤（只取 queued/stale）会直接跳过，不产生 409。真正要保证的是「只认领一次、
      // 只派一次」，holder 冲突只是其中一种时序；板子侧的 409 语义由 board-server-smoke 覆盖。
      check('R21 第二个实例没有派出去', srv.stats.dispatch === 1 && srv.remoteTasks.length === 1,
        `dispatch=${srv.stats.dispatch} take=${srv.stats.take} holderConflict=${srv.stats.holderConflict} remote=${srv.remoteTasks.length}`)
      check('R21 远端只有一条任务', srv.remoteTasks.length === 1, JSON.stringify(srv.remoteTasks.map((t) => t.taskId)))
      check('R21 journal 最终清空', (Array.isArray(journal) ? journal.length : 0) === 0, JSON.stringify(journal))
    } finally {
      try { if (cleanupB) cleanupB() } catch { /* ignore */ }
      try { if (cleanupA) cleanupA() } catch { /* ignore */ }
      if (srv) await srv.close()
    }
  }

  return summary()
}

const ok = await main()
process.exit(ok ? 0 : 1)
