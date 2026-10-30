/**
 * dsh-team 离线自检（不需要 DSH 宿主）。
 *
 * 断言四件事：
 *   1. apply() 不抛异常，且注册的工具恰好 16 个（12 个 board_* + 4 个 sh_*）；
 *   2. 每个工具的 output.render 返回 [{ type:'text', text }] —— 裸字符串会毒化会话历史；
 *   3. 每个工具 name/description/parameters/output 齐备；
 *   4. 三条 GUI 路由被注册。
 *
 * 跑法：node scripts/plugcheck.mjs
 * 退出码：0 全过 / 1 有失败
 */
import assert from 'node:assert/strict'
import { apply, name } from '../lib/index.js'

const tools = new Map()
const routes = []

const ctx = {
  tools: {
    register(spec) {
      tools.set(spec.name, spec)
    },
  },
  webServer: {
    register(spec) {
      routes.push(spec.path)
    },
  },
  logger: { info() {}, warn() {}, error() {} },
}

apply(ctx, { boardUrl: 'http://127.0.0.1:1', machine: 'host' })

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

const needRoutes = ['/api/board/ui/summary', '/api/board/ui/claim', '/api/board/ui/release']
const missRoutes = needRoutes.filter((r) => !routes.includes(r))
assert.deepEqual(missRoutes, [], `缺少路由: ${missRoutes.join(', ')}`)

console.log(`PASS  name=${name}  tools=${tools.size}  routes=${routes.length}`)
console.log('  tools: ' + [...tools.keys()].join(', '))
