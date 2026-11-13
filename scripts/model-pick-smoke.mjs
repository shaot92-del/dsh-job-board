#!/usr/bin/env node
/**
 * v2.1.0 模型选择冒烟：
 *   M1 board_options 汇总在线机器与模型清单
 *   M2 board_dispatch 未选机器时返回 needSelection（不建单）
 *   M3 选了机器但该机上报模型、未选模型时仍 needSelection
 *   M4 机器 + 模型都给时建单，model 原样进 /api/create
 *   M5 exec 模式忽略 model
 *   M10 传显示名派工时，落到板子的 machine 必须是身份名（v2.1.0 阻断回归）
 *   M11 board_attach 传显示名时，/api/attach 的 machine 也必须是身份名
 *   R1-R3 v2.3.0 重派：复制原参数、拒绝执行中、拒绝不存在
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-modelpick-'))
process.env.DSH_TEAM_STATE_DIR = root
const stateDir = path.join(root, 'state')
fs.mkdirSync(stateDir, { recursive: true })
process.env.DSH_TEAM_STATE_DIR = stateDir

const realFetch = globalThis.fetch
let created = null
let attached = null
function reply(obj) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj), json: async () => obj }
}
const BOARD = {
  ok: true, updatedAt: Math.floor(Date.now() / 1000), updatedAgeSec: 1,
  counts: { queued: 0, running: 0, done: 0, bad: 0 },
  machines: [
    { id: 'GT14', online: true, caps: { os: 'Windows', cores: 8, alias: 'GT14 工作机' }, current: '' },
    { id: 'MB14', online: false, caps: {}, current: '' },
    { id: 'PC2', online: true, caps: { os: 'Windows' }, current: '' },
    { id: 'host', online: true, caps: {}, current: '' },
  ],
  tasks: [], events: [],
}
const NODES = { ok: true, nodes: [
  { nodeId: 'GT14', hostname: 'GT14', online: true, models: [
    { provider: 'deepseek-account', id: 'deepseek-flash', name: 'Flash' },
    { provider: 'local', id: 'qwen3:8b', name: 'Qwen3 8B' },
  ], defaultModel: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  { nodeId: 'PC2', hostname: 'PC2', online: true, models: [], defaultModel: null },
] }
function stub(fn) { globalThis.fetch = fn }
stub(async (url, init) => {
  const u = String(url)
  if (process.env.MP_DEBUG) console.error('FETCH', u)
  if (u.includes('/api/remote-agent/ui/nodes')) return reply(NODES)
  if (u.includes('/api/create')) { created = JSON.parse(String(init.body)); return reply({ ok: true }) }
  if (u.includes('/api/attach')) { attached = JSON.parse(String(init.body)); return reply({ ok: true }) }
  if (u.includes('/api/board')) return reply(BOARD)
  return reply({ ok: true })
})

const tools = new Map()
const routes = []
const ctx = {
  tools: { register(spec) { tools.set(spec.name, spec) } },
  webServer: { register(spec) { routes.push(spec.path); return () => {} }, getOrigin() { return 'http://host.test' } },
  on() { return () => {} },
  effect() { return () => {} },
  logger: { info() {}, warn() {}, error() {} },
  get() { return null },
}
const mod = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href)
const apply = mod.apply || (mod.default && mod.default.apply)
assert.equal(typeof apply, 'function', 'lib/index.js 必须导出 apply')
const dispose = apply(ctx, { boardUrl: 'http://127.0.0.1:1', machine: 'host', dispatchAsk: true, autoDispatch: false })

const options = await tools.get('board_options').execute({})
assert.equal(options.ok, true, 'board_options 应成功')
const gt14 = options.machines.find((m) => m.machine === 'GT14')
assert.ok(gt14 && gt14.models.length === 2, 'GT14 应带 2 个模型：' + JSON.stringify(options.machines))
const vals = gt14.models.map((m) => (m.provider ? m.provider + '/' : '') + m.model)
assert.ok(vals.includes('deepseek-account/deepseek-flash'), '模型要带 provider：' + JSON.stringify(vals))
assert.ok(vals.includes('local/qwen3:8b'))

const noMachine = await tools.get('board_dispatch').execute({ goal: 'test' })
assert.equal(noMachine.ok, true, 'needSelection 不是失败')
assert.equal(noMachine.needSelection, true, '未选机器应被拦')
assert.equal(noMachine.needSelection, true, '应返回 needSelection')
assert.ok(Array.isArray(noMachine.options) && noMachine.options.length > 0, '应给出候选机器')

const onlyModel = await tools.get('board_dispatch').execute({ goal: 'test', model: 'local/qwen3:8b' })
assert.equal(onlyModel.ok, true)
assert.equal(onlyModel.needSelection, true, '给了模型但没给机器，仍要先选机器')
assert.ok(/机器/.test(String(onlyModel.error)), '错误应说清缺机器')

const noModel = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'GT14' })
assert.equal(noModel.ok, true, 'needSelection 不是失败')
assert.equal(noModel.needSelection, true, '该机上报了模型却没选，应被拦')

created = null
const noList = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'PC2' })
assert.equal(noList.ok, true, '机器没上报模型时不应要求选模型：' + JSON.stringify(noList))
assert.equal(created && created.model, '', '没有模型清单时建单 model 为空（跟随机默认）')

created = null
const badModel = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'GT14', model: 'local/nope' })
assert.equal(badModel.ok, false, '目标机没有的模型要在建单前拒绝')
assert.ok(Array.isArray(badModel.available) && badModel.available.length === 2, '应给出可选模型')

const autoPick = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'GT14', model: 'auto' })
assert.equal(autoPick.ok, true, 'model:auto 应放行并跟随副机默认')
assert.equal(created && created.model, '', 'auto 不写 model')

const dry = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'GT14', model: 'local/qwen3:8b', dryRun: true })
assert.equal(dry.ok, true, '策略允许 dryRun 先预览')

const ok = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'GT14', model: 'local/qwen3:8b' })
assert.equal(ok.ok, true, '机器 + 模型齐了应建单：' + JSON.stringify(ok))
assert.ok(created, '应调用 /api/create')
assert.equal(created.model, 'local/qwen3:8b', 'model 必须原样进建单体')
assert.equal(created.machine, 'GT14')

created = null
// v2.1.0 复审（阻断）：传显示名只能用于查找，落到板子的必须是身份 id。
const byAlias = await tools.get('board_dispatch').execute({ goal: 'test', machine: 'GT14 工作机', model: 'local/qwen3:8b' })
assert.equal(byAlias.ok, true, '显示名应能派工：' + JSON.stringify(byAlias))
assert.equal(created && created.machine, 'GT14', 'task.machine 必须是身份名，不能是显示名')

const attachedAlias = await tools.get('board_attach').execute({ task_id: 'bd-b1', remote_id: 'ui-b1', machine: 'GT14 工作机' })
assert.equal(attachedAlias.ok, true, 'attach 应接受显示名并折回身份：' + JSON.stringify(attachedAlias))
assert.equal(attached && attached.machine, 'GT14', 'attach 落库的 machine 必须是身份名')

created = null
const ex = await tools.get('board_dispatch').execute({ goal: 'echo hi', machine: 'GT14', mode: 'exec' })
assert.equal(ex.ok, true, 'exec 模式应建单（不需要模型）')
assert.equal(created.model, '', 'exec 模式不写 model')

// v2.3.0：重派。只复制失败/打回/取消任务的原参数，执行中的一律拒绝。
BOARD.tasks = [
  { id: 'failed-1', status: 'failed', goal: 'echo fail', title: '失败任务', machine: 'GT14', mode: 'agent', model: 'local/qwen3:8b', workspace: 'C:/w', note: 'boom', artifact: '' },
  { id: 'running-1', status: 'running', goal: 'long', machine: 'GT14' },
]
created = null
const rt = await tools.get('board_retry').execute({ task_id: 'failed-1' })
assert.equal(rt.ok, true, '失败任务应能重派：' + JSON.stringify(rt))
assert.equal(created.goal, 'echo fail', '重派要复制原 goal')
assert.equal(created.model, 'local/qwen3:8b', '重派要复制原 model')
assert.equal(created.machine, 'GT14', '重派要复制原机器')
assert.equal(created.mode, 'agent')
assert.ok(String(created.note).includes('重派自 failed-1'))

created = null
const rtRunning = await tools.get('board_retry').execute({ task_id: 'running-1' })
assert.equal(rtRunning.ok, false, '执行中的任务不能重派')
assert.equal(created, null, '拒绝时不应建单')

const rtMissing = await tools.get('board_retry').execute({ task_id: 'nope' })
assert.equal(rtMissing.ok, false, '不存在的任务应报错')

dispose()
globalThis.fetch = realFetch
dispose()
globalThis.fetch = realFetch
fs.rmSync(root, { recursive: true, force: true })
console.log('PASS model-pick smoke (M1-M11, R1-R3)')
