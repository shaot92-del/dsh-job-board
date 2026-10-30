/**
 * dsh-team 离线自检（不需要 DSH 宿主，也不需要真板子）。
 *
 * 断言这些事：
 *   1. apply() 不抛异常，且注册的工具恰好 16 个（12 个 board_* + 4 个 sh_*）；
 *   2. 每个工具的 output.render 返回 [{ type:'text', text }] —— 裸字符串会毒化会话历史；
 *   3. 每个工具 name/description/parameters/output 齐备；
 *   4. GUI 路由被注册（含面板派工用的 /api/board/ui/create）；
 *   5. 任务标题取 t.title、goal 不被裁剪；
 *   6. agent 层工具读到同一份 allowedRoots，板子不可达时 board_caps 返回 ok:false；
 *   7. v1.1：board_dispatch 建单带 dispatch=auto（派发权归 Host）；
 *   8. v1.1：Host 调度器会 /api/take → remote-agent /dispatch → /api/attach；
 *   9. v1.1：终态 aborted/interrupted/rejected 也回写成 failed；
 *  10. v1.1：board_list 取全量（>200 条不被截断）；
 *  11. v1.1：dispose 真的清掉 caps/live/dispatch/sync 四个定时器。
 *
 * 跑法：node scripts/plugcheck.mjs
 * 退出码：0 全过 / 1 有失败
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name } from '../lib/index.js'

const LONG_GOAL = 'x'.repeat(300) // 板子允许 300 字；snapshot 不能把它裁成 160
const BOARD = {
  now: 0,
  updated: 0,
  counts: { queued: 1, claimed: 0, running: 0, done: 0, blocked: 0, failed: 0, superseded: 0 },
  machines: { host: { online: true, last_seen: 0, caps: { os: 'test', cores: 4, memGB: 8 } } },
  tasks: {
    't-1': { title: '真实标题', note: '备注文本', status: 'queued', goal: LONG_GOAL, updated_at: 0, priority: 5 },
  },
  events: [],
}

const realFetch = globalThis.fetch
function stubFetch(impl) {
  globalThis.fetch = impl
}

// 假 fetch 的返回：call() 用 res.text()，Host 调度器用 res.json()
function reply(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
}

function pick(map, url, fallback) {
  const key = String(url).replace(/^https?:\/\/[^/]+/, '')
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
  return fallback
}

/** 记录所有请求的路由 stub。 */
function router(map, fallback) {
  const calls = []
  stubFetch(async (url, init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : null
    calls.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ''), method: (init && init.method) || 'GET', body })
    return reply(pick(map, url, fallback || { ok: true }))
  })
  return calls
}

const tools = new Map()
const agentTools = new Map()
const routes = []
let createdHandler = null

const ctx = {
  tools: {
    register(spec) {
      tools.set(spec.name, spec)
    },
  },
  webServer: {
    register(spec) {
      routes.push(spec.path)
      return () => {}
    },
    // Host 调度器靠它拿 remote-agent 的 UI 根地址
    getOrigin() {
      return 'http://127.0.0.1:1'
    },
  },
  on(event, fn) {
    if (event === 'agent/created') createdHandler = fn
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} },
}

// #13：把定时器截下来（不真跑），既不挂住进程，也能在 dispose 时断言被清掉。
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const fakeIntervals = new Map()
const clearedIds = []
let intervalSeq = 0
globalThis.setInterval = (fn, ms) => {
  const id = { fake: ++intervalSeq }
  fakeIntervals.set(id.fake, { fn, ms })
  return id
}
globalThis.clearInterval = (id) => {
  if (id && id.fake) {
    clearedIds.push(id.fake)
    fakeIntervals.delete(id.fake)
    return
  }
  realClearInterval(id)
}

function findInterval(ms) {
  for (const v of fakeIntervals.values()) {
    if (v.ms === ms) return v
  }
  return null
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-root-'))

// 板子在 apply 阶段就会被探测（reportCaps），所以先把 fetch 换成假的，避免真的连网。
stubFetch(async (url) => {
  const u = String(url)
  const body = u.includes('/api/board') ? BOARD : { ok: true }
  return reply(body)
})

const dispose = apply(ctx, {
  boardUrl: 'http://127.0.0.1:1',
  machine: 'host',
  allowedRoots: [root],
  shellTimeoutMs: 5000,
  maxOutputBytes: 1000,
})

const EXPECTED_BOARD = ['board_status', 'board_list', 'board_claim', 'board_beat', 'board_done', 'board_fail', 'board_say', 'board_attach', 'board_dispatch', 'board_caps', 'board_assess', 'board_metrics']
const EXPECTED_SHELL = ['sh_run', 'sh_read', 'sh_write', 'sh_list']
const EXPECTED = [...EXPECTED_BOARD, ...EXPECTED_SHELL]
let nonEmpty = 0

const missing = EXPECTED.filter((n) => !tools.has(n))
assert.deepEqual(missing, [], `缺少工具: ${missing.join(', ')}`)
assert.equal(tools.size, EXPECTED.length, `工具数量应为 ${EXPECTED.length}，实际 ${tools.size}: ${[...tools.keys()].join(', ')}`)

for (const [toolName, spec] of tools) {
  assert.equal(typeof spec.description, 'string', `${toolName}.description 必须是字符串`)
  assert.ok(spec.description.length > 5, `${toolName}.description 太短`)
  assert.equal(typeof spec.parameters, 'object', `${toolName}.parameters 必须是对象`)
  assert.equal(spec.parameters.type, 'object', `${toolName}.parameters.type 应为 object`)
  assert.equal(typeof spec.output?.schema, 'object', `${toolName}.output.schema 必须存在`)
  assert.equal(typeof spec.output?.render, 'function', `${toolName}.output.render 必须是函数`)

  const sample =
    toolName === 'board_list' ? { ok: true, total: 1, tasks: [{ id: 'x1', title: '示例任务', status: 'queued', machine: 'host', progress: '', note: '' }], counts: { queued: 1 } }
      : toolName === 'board_status' ? { ok: true, counts: { queued: 1, running: 0, done: 2, blocked: 0 }, staleSec: 12, machines: [{ name: 'host', online: true, lastSeenSec: 3 }] }
        : toolName === 'sh_run' ? { ok: true, code: 0, stdout: 'x', stderr: '' }
          : toolName === 'sh_list' ? { ok: true, path: 'C:/', total: 0, items: [] }
            : { ok: true }
  const blocks = spec.output.render({}, sample)
  assert.ok(Array.isArray(blocks), `${toolName}.render 必须返回数组`)
  for (const b of blocks) {
    assert.equal(b?.type, 'text', `${toolName}.render 的块类型必须是 text`)
    assert.equal(typeof b.text, 'string', `${toolName}.render 的 text 必须是字符串`)
  }
  if (blocks.length > 0) nonEmpty += 1
}

assert.ok(nonEmpty >= 14, `至少 14 个工具的 render 要产出文本块，实际 ${nonEmpty}`)

const needRoutes = [
  '/api/board/ui/summary',
  '/api/board/ui/claim',
  '/api/board/ui/release',
  '/api/board/ui/create', // 复核 #4：面板派工第一步，之前这个路由根本不存在
]
const missRoutes = needRoutes.filter((r) => !routes.includes(r))
assert.deepEqual(missRoutes, [], `缺少路由: ${missRoutes.join(', ')}`)

// ── #14 / #5：标题取 t.title，goal 不裁剪 ──────────────────────────────
const listOut = await tools.get('board_list').execute({})
assert.equal(listOut.ok, true, 'board_list 应成功')
const first = (listOut.tasks || [])[0] || {}
assert.equal(first.title, '真实标题', `标题应取 t.title，实际: ${JSON.stringify(first.title)}`)
assert.equal(first.goal, LONG_GOAL, `goal 不应被裁剪，实际长度 ${String(first.goal).length}`)
assert.equal(first.note, '备注文本', '备注应单独返回')

// ── v1.1：#17 本机能力探测不再阻塞（5 路并发 + TTL），至少不能抛 ────────
stubFetch(async () => reply({ ok: true }))
const assessOut = await tools.get('board_assess').execute({})
assert.equal(typeof assessOut, 'object', 'board_assess 必须返回对象')
assert.ok(assessOut.caps || assessOut.error, 'board_assess 要么给出 caps，要么给出 error')

// ── v1.1：board_dispatch 建单必须带 dispatch=auto（派发权归 Host）──────
const dispatchBoard = {
  now: 0,
  updated: 0,
  counts: {},
  machines: {
    host: { online: true, last_seen: 0, caps: { os: 'test' } },
    GT14: { online: true, last_seen: 0, caps: { os: 'test', features: { shell: '/x/pwsh', pwsh: '7.6.9' } } },
  },
  tasks: {},
  events: [],
}
{
  const calls = router({ '/api/board': dispatchBoard })
  const out = await tools.get('board_dispatch').execute({ goal: '把活干了', mode: 'exec', workspace: 'D:/w' })
  assert.equal(out.ok, true, 'board_dispatch 应成功: ' + JSON.stringify(out))
  const created = calls.find((c) => c.path === '/api/create')
  assert.ok(created, 'board_dispatch 必须调用 /api/create')
  assert.equal(created.body.dispatch, 'auto', '建单必须带 dispatch=auto，否则 Host 调度器不会接手')
  assert.equal(created.body.mode, 'exec', 'mode 要跟着建单一起写进板子')
  assert.equal(created.body.workspace, 'D:/w', 'workspace 要跟着建单一起写进板子')
  assert.match(String(out.summary || ''), /Host/, '返回值应说明由 Host 派发: ' + out.summary)
}

// ── v1.1：#6 Host 调度器 take → dispatch → attach ──────────────────────
{
  const board = {
    now: 0,
    updated: 0,
    counts: {},
    machines: { host: { online: true, last_seen: 0 }, GT14: { online: true, last_seen: 0 } },
    tasks: {
      'q-1': { status: 'queued', dispatch: 'auto', machine: 'GT14', goal: '跑个活', mode: 'agent', workspace: 'D:/w', title: 'q1', updated_at: 0 },
    },
    events: [],
  }
  const calls = router({
    '/api/board': board,
    '/api/take': { ok: true },
    '/api/remote-agent/ui/nodes': { nodes: [{ nodeId: 'GT14', online: true }] },
    '/api/remote-agent/ui/dispatch': { ok: true, taskId: 'ui-9' },
    '/api/attach': { ok: true },
  })
  const tick = findInterval(4000)
  assert.ok(tick, 'Host 调度器应注册 4 秒定时器（#6）')
  tick.fn()
  await new Promise((r) => setTimeout(r, 80))
  const take = calls.find((c) => c.path === '/api/take')
  const sent = calls.find((c) => c.path === '/api/remote-agent/ui/dispatch')
  const att = calls.find((c) => c.path === '/api/attach')
  assert.ok(take, '应先 /api/take 占位')
  assert.equal(take.body.task_id, 'q-1')
  assert.equal(take.body.machine, 'host', '占位机器应是调度器自己')
  assert.ok(sent, '应调用 remote-agent /dispatch')
  assert.equal(sent.body.node, 'GT14', 'nodeId 必须用副机上报的 nodeId')
  assert.equal(sent.body.goal, '跑个活', 'goal 用原文')
  assert.equal(sent.body.workspace, 'D:/w', 'workspace 要透传')
  assert.ok(att, '派出后应 /api/attach 回绑')
  assert.equal(att.body.remote_id, 'ui-9')
  assert.equal(att.body.machine, 'GT14')
}

// ── v1.1：aborted/interrupted/rejected 也要回写成 failed ───────────────
{
  const board = {
    now: 0,
    updated: 0,
    counts: {},
    machines: { host: { online: true, last_seen: 0 }, GT14: { online: true, last_seen: 0 } },
    tasks: {
      'r-1': { status: 'running', machine: 'GT14', remote_id: 'ui-9', goal: '跑个活', updated_at: 0 },
    },
    events: [],
  }
  const calls = router({
    '/api/board': board,
    '/api/remote-agent/ui/tasks': { tasks: [{ taskId: 'ui-9', status: 'aborted', error: 'boom' }] },
    '/api/mark': { ok: true },
  })
  const tick = findInterval(6000)
  assert.ok(tick, '终态回写应注册 6 秒定时器（#6）')
  tick.fn()
  await new Promise((r) => setTimeout(r, 80))
  const marked = calls.find((c) => c.path === '/api/mark')
  assert.ok(marked, '终态要回写板子')
  assert.equal(marked.body.task_id, 'r-1')
  assert.equal(marked.body.status, 'failed', 'aborted 应折成 failed')
  assert.match(String(marked.body.note || ''), /aborted/, '备注要说明远程终态')
}

// ── v1.1：#12 >200 条任务时 board_list 不再截断 ────────────────────────
{
  const big = {}
  for (let i = 0; i < 230; i++) {
    big['b-' + i] = { status: 'done', title: 't' + i, updated_at: i }
  }
  const board = { now: 0, updated: 0, counts: {}, machines: { host: { online: true, last_seen: 0 } }, tasks: big, events: [] }
  router({ '/api/board': board })
  const out = await tools.get('board_list').execute({ limit: 500 })
  assert.equal(out.total, 230, `board_list 的 total 应能看到全部 230 条，实际 ${out.total}`)
}

// ── #16：板子不可达时不能假成功 ───────────────────────────────────────
stubFetch(async () => {
  throw new Error('ECONNREFUSED')
})
const capsOut = await tools.get('board_caps').execute({})
assert.equal(capsOut.ok, false, '板子不可达时 board_caps 必须返回 ok:false')
assert.ok(String(capsOut.error || '').length > 0, 'board_caps 失败时要带 error')

// ── #1 / #2：agent 层工具共享同一份 allowedRoots ──────────────────────
stubFetch(realFetch)
assert.equal(typeof createdHandler, 'function', 'agent/created 应被订阅（假 ctx 必须有 on）')
createdHandler({ agent: { id: 'probe', ctx: { tools: { register: (spec) => agentTools.set(spec.name, spec) } } } })
assert.ok(agentTools.has('sh_run'), 'agent 层应注册 sh_run')

const outsideCwd = path.join(root, '..')
const denied = await agentTools.get('sh_run').execute({ command: 'echo hi', cwd: outsideCwd })
assert.equal(denied.ok, false, 'allowedRoots 之外的 cwd 必须被拒')
assert.match(String(denied.message || ''), /allowedRoots/, `拒绝信息应说明根目录，实际: ${denied.message}`)

fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
const insideList = await agentTools.get('sh_list').execute({ path: path.join(root, 'sub') })
assert.equal(insideList.ok, true, 'allowedRoots 之内的目录应可读')

// ── #13：dispose 要清掉四个定时器（重载不再叠定时器）───────────────────
assert.deepEqual([...fakeIntervals.values()].map((v) => v.ms).sort((a, b) => a - b), [4000, 6000, 15000, 600000], '应注册 4 个定时器')
assert.equal(typeof dispose, 'function', 'apply 必须返回 disposer')
dispose()
assert.equal(fakeIntervals.size, 0, 'dispose 之后不应残留定时器: ' + JSON.stringify([...fakeIntervals.values()].map((v) => v.ms)))
assert.ok(clearedIds.length >= 4, 'dispose 应 clearInterval 至少 4 次，实际 ' + clearedIds.length)

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log(`PASS  name=${name}  tools=${tools.size}  routes=${routes.length}`)
console.log('  tools: ' + [...tools.keys()].join(', '))
