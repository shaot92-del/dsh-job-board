/**
 * dsh-team 离线自检（不需要 DSH 宿主，也不需要真板子）。
 *
 * 断言这些事：
 *   1. apply() 不抛异常，且注册的工具恰好 17 个（13 个 board_* + 4 个 sh_*）；
 *   2. 每个工具的 output.render 返回 [{ type:'text', text }] —— 裸字符串会毒化会话历史；
 *   3. 每个工具 name/description/parameters/output 齐备；
 *   4. GUI 路由被注册（含面板派工用的 /api/board/ui/create）；
 *   5. 任务标题取 t.title、goal 不被裁剪；
 *   6. agent 层工具读到同一份 allowedRoots，板子不可达时 board_caps 返回 ok:false；
 *   7. v1.1：board_dispatch 建单带 dispatch=auto（派发权归 Host）；
 *   8. v1.1：Host 调度器会 /api/take → remote-agent /dispatch → /api/attach；
 *   9. v1.1：终态 aborted/interrupted/rejected 也回写成 failed；
 *  10. v1.1：board_list 取全量（>200 条不被截断）；
 *  11. v1.1：dispose 真的清掉 caps/live/dispatch/sync 四个定时器；
 *  12. v1.1.1：调度器先换会话 cookie（launch token），401 后重试，nodeId 别名能对上机器名；
 *  13. v1.1.2：派发显式带 approval=auto（exec 任务默认 manual 会静默卡住）；
 *  14. v1.1.3：goal 超 300 字当场拒绝（板子会截断成半句命令），终态 note 带副机 stdout。
 *
 * 跑法：node scripts/plugcheck.mjs
 * 退出码：0 全过 / 1 有失败
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name } from '../lib/index.js'

// v2.0.4：plugcheck 也会 apply 插件，必须隔离状态目录 —— 以前它把 boardUrl=http://127.0.0.1:1 和测试 token 写进真实 ~/.dsh/dsh-team/config.json，重启后插件就永远连不上板子。
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-plugcheck-'))
process.env.DSH_TEAM_STATE_DIR = STATE_DIR

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
function reply(payload, opts) {
  const status = (opts && opts.status) || 200
  const setCookie = (opts && opts.setCookie) || []
  const headers = new Headers()
  for (const c of setCookie) headers.append('set-cookie', c)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
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
  // 宿主 connection 服务：真实 DSH 用它把本进程 launch token 拼进 URL 换会话 cookie
  get(name) {
    if (name !== 'connection') return undefined
    return {
      authenticatedUrl(baseUrl) {
        const u = new URL(baseUrl)
        u.searchParams.set('token', 'test-launch-token')
        return u.href
      },
    }
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
  // v2.1.0：派工前的"机器 + 模型"确认会拦下未选全的调用，测试里关掉。
  dispatchAsk: false,
  shellTimeoutMs: 5000,
  maxOutputBytes: 1000,
})

const EXPECTED_BOARD = ['board_status', 'board_list', 'board_claim', 'board_beat', 'board_done', 'board_fail', 'board_retry', 'board_say', 'board_attach', 'board_dispatch', 'board_options', 'board_caps', 'board_assess', 'board_metrics']
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
  '/api/board/ui/doctor', // v1.4.0：配置/板子/hub/worker/调度器自检
  '/api/board/ui/caps-probe', // v2.4.0：本机能力只读探测
  '/api/board/ui/caps-apply', // v2.4.0：确认后写能力卡
  '/api/board/ui/workload-catalog', // v2.5.0：工作大类目录
  '/api/board/ui/workload-probe', // v2.5.0：单项能力探测
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

// ── v1.1：#17 本机能力探测改并发 + TTL —— 这里只断言「能跑完、结构合法」─────
// 注意：board_assess 依赖 ~/.dsh-board/identity.json（本机评估过才有 caps），CI 上没有这份文件，
// 所以不能断言一定有 caps/error，只断言返回了带 boolean ok 的对象。
stubFetch(async () => reply({ ok: true }))
const assessOut = await tools.get('board_assess').execute({})
assert.equal(typeof assessOut, 'object', 'board_assess 必须返回对象')
assert.equal(typeof assessOut.ok, 'boolean', 'board_assess 的返回值必须带 boolean ok')

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

// ── v1.1.3：goal 超过板子 300 字上限要当场拒绝 ─────────────────────────
// board_server.py 的 do_create 是 goal[:300]，exec 命令被截成半句会在副机上炸成
// 一串看不懂的 ParserError（现场踩过两次）。宁可在建单前拦住。
{
  const calls = router({ '/api/board': dispatchBoard })
  const out = await tools.get('board_dispatch').execute({ goal: 'x'.repeat(330), mode: 'exec' })
  assert.equal(out.ok, false, 'goal 超 300 字必须被拒: ' + JSON.stringify(out))
  assert.match(String(out.error || ''), /300/, '拒绝信息要说明 300 字上限: ' + out.error)
  assert.equal(calls.filter((c) => c.path === '/api/create').length, 0, '被拒时不应建单')
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
  // v1.1.2：exec 任务在 remote-agent 侧默认 manual 审批 —— 调度器必须显式 auto
  assert.equal(sent.body.approval, 'auto', '派发必须带 approval=auto，否则 exec 任务永远卡在 pending_approval')
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

// ── v1.1.3：终态 note 优先带副机最后一条 stdout ────────────────────────
// 现场教训：任务 done 了但板上只有「远程 completed」，还得去共享盘翻任务 JSON 才能
// 看到命令输出。syncRemote 现在把最后一条 [stdout] 直接写进 note。
{
  const board = {
    now: 0,
    updated: 0,
    counts: {},
    machines: { host: { online: true, last_seen: 0 }, GT14: { online: true, last_seen: 0 } },
    tasks: {
      'r-2': { status: 'running', machine: 'GT14', remote_id: 'ui-10', goal: '跑个活', updated_at: 0 },
    },
    events: [],
  }
  const calls = router({
    '/api/board': board,
    '/api/remote-agent/ui/tasks': {
      tasks: [
        {
          taskId: 'ui-10',
          status: 'completed',
          logs: [{ line: '[stderr] warning' }, { line: '[stdout] GT14 team=1.1.3' }],
        },
      ],
    },
    '/api/mark': { ok: true },
  })
  const tick = findInterval(6000)
  assert.ok(tick, '终态回写应注册 6 秒定时器（#6）')
  tick.fn()
  await new Promise((r) => setTimeout(r, 80))
  const marked = calls.find((c) => c.path === '/api/mark')
  assert.ok(marked, 'completed 要回写板子')
  assert.equal(marked.body.status, 'done', 'completed 应折成 done')
  assert.match(String(marked.body.note || ''), /GT14 team=1\.1\.3/, 'note 应带副机最后一条 stdout: ' + marked.body.note)
}

// ── v1.1.1：Host 调度器要穿过 DSH 的浏览器鉴权围栏换会话 cookie ─────────
// v1.1.0 就是死在这里：remote-agent 的 UI 路由每请求都问 connection.requestRejection，
// 后台 fetch 不带 cookie 一律 401，dispatch 永远到不了副机。
{
  const board = {
    now: 0,
    updated: 0,
    counts: {},
    machines: { host: { online: true, last_seen: 0 }, MB14: { online: true, last_seen: 0 } },
    tasks: { 'c-1': { status: 'queued', dispatch: 'auto', machine: 'MB14', goal: '别名机器', mode: 'agent', updated_at: 0 } },
    events: [],
  }
  const calls = []
  let nodesHits = 0
  globalThis.fetch = async (url, init) => {
    const pathname = String(url).replace(/^https?:\/\/[^/]+/, '')
    const headers = (init && init.headers) || {}
    calls.push({ path: pathname, headers, body: init && init.body ? JSON.parse(String(init.body)) : null })
    if (pathname === '/api/board') return reply(board)
    if (pathname.startsWith('/?')) return reply({}, { status: 302, setCookie: ['dsh_session=signed; Path=/; HttpOnly'] })
    if (pathname === '/api/remote-agent/ui/nodes') {
      nodesHits += 1
      if (nodesHits === 1) return reply({ error: 'unauthorized' }, { status: 401 })
      return reply({ nodes: [{ nodeId: 'desktop2gh05s7', online: true }] })
    }
    if (pathname === '/api/take') return reply({ ok: true })
    if (pathname === '/api/remote-agent/ui/dispatch') return reply({ ok: true, taskId: 'ui-c' })
    if (pathname === '/api/attach') return reply({ ok: true })
    return reply({ ok: true })
  }
  const tick = findInterval(4000)
  tick.fn()
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(
    calls.find((c) => c.path.includes('token=test-launch-token')),
    '调度器应先用 connection.authenticatedUrl() 换会话 cookie',
  )
  const nodesCalls = calls.filter((c) => c.path === '/api/remote-agent/ui/nodes')
  assert.equal(nodesCalls.length, 2, `401 后应重试一次 nodes，实际 ${nodesCalls.length} 次`)
  assert.match(String(nodesCalls[1].headers.cookie || ''), /dsh_session=/, '重试必须带上会话 cookie')
  const sent = calls.find((c) => c.path === '/api/remote-agent/ui/dispatch')
  assert.ok(sent, '换到 cookie 后应真的派出去')
  assert.equal(sent.body.node, 'desktop2gh05s7', 'nodeId 用副机上报值')
  assert.equal(sent.body.goal, '别名机器', 'goal 用原文')
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
  fs.rmSync(STATE_DIR, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log(`PASS  name=${name}  tools=${tools.size}  routes=${routes.length}`)
console.log('  tools: ' + [...tools.keys()].join(', '))
