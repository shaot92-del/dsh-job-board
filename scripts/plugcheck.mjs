/**
 * dsh-team 离线自检（不需要 DSH 宿主，也不需要真板子）。
 *
 * 断言六件事：
 *   1. apply() 不抛异常，且注册的工具恰好 16 个（12 个 board_* + 4 个 sh_*）；
 *   2. 每个工具的 output.render 返回 [{ type:'text', text }] —— 裸字符串会毒化会话历史；
 *   3. 每个工具 name/description/parameters/output 齐备；
 *   4. GUI 路由被注册（含面板派工用的 /api/board/ui/create，复核 #4）；
 *   5. 任务标题取 t.title（复核 #14），goal 不被裁剪（复核 #5）；
 *   6. agent/created 派生的 sh_* 工具读到同一份 allowedRoots（复核 #1/#2），
 *      且板子不可达时 board_caps 返回 ok:false 而不是假成功（复核 #16）。
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
  },
  on(event, fn) {
    if (event === 'agent/created') createdHandler = fn
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} },
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-root-'))

// 板子在 apply 阶段就会被探测（reportCaps），所以先把 fetch 换成假的，避免真的连网。
stubFetch(async (url) => {
  const u = String(url)
  const body = u.includes('/api/board') ? BOARD : { ok: true }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
})

apply(ctx, {
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

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log(`PASS  name=${name}  tools=${tools.size}  routes=${routes.length}`)
console.log('  tools: ' + [...tools.keys()].join(', '))
