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
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-modelpick-'))
process.env.DSH_TEAM_STATE_DIR = root
const stateDir = path.join(root, 'state')
fs.mkdirSync(stateDir, { recursive: true })
process.env.DSH_TEAM_STATE_DIR = stateDir

const realFetch = globalThis.fetch
let created = null
let attached = null
let capped = null
function reply(obj) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj), json: async () => obj }
}
const BOARD = {
  ok: true, updatedAt: Math.floor(Date.now() / 1000), updatedAgeSec: 1,
  counts: { queued: 0, running: 0, done: 0, bad: 0 },
  machines: [
    { id: 'GT14', online: true, caps: { os: 'Windows', cores: 8, alias: 'GT14 工作机', models: [{ id: 'deepseek-flash', provider: 'deepseek-account', location: 'cloud', tags: ['代码审查', '通用对话'], source: 'bench' }], workloads: [{ id: 'video.interp', unit: 'fps', value: 20, samples: 1, confidence: 'measured', workload: { width: 1920 } }, { id: 'video.transcode', unit: 'fps', value: 300, samples: 1, confidence: 'measured' }] }, current: '' },
    { id: 'MB14', online: false, caps: {}, current: '' },
    { id: 'PC2', online: true, caps: { os: 'Windows', workloads: [{ id: 'video.interp', unit: 'fps', value: 50, samples: 1, confidence: 'measured' }] }, current: '' },
    { id: 'host', online: true, caps: {}, current: '' },
  ],
  tasks: [], events: [],
}
let BOARD_FAIL = false
const NODES = { ok: true, nodes: [
  { nodeId: 'GT14', hostname: 'GT14', online: true, models: [
    { provider: 'deepseek-account', id: 'deepseek-flash', name: 'Flash' },
    { provider: 'local', id: 'qwen3:8b', name: 'Qwen3 8B' },
  ], defaultModel: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  { nodeId: 'PC2', hostname: 'PC2', online: true, models: [], defaultModel: null },
  // 原型键节点：summary 必须在 null-proto 表里安全落地，不能碰 Object.prototype。
  { nodeId: '__proto__', hostname: '__proto__', online: true, models: [{ provider: 'local', id: 'evil' }], defaultModel: { provider: 'local', model: 'evil' } },
] }
function stub(fn) { globalThis.fetch = fn }
stub(async (url, init) => {
  const u = String(url)
  if (process.env.MP_DEBUG) console.error('FETCH', u)
  if (u.includes('/api/remote-agent/ui/nodes')) return reply(NODES)
  if (u.includes('/api/caps')) {
    capped = JSON.parse(String(init.body))
    const mm = BOARD.machines.find((m) => m.id === capped.machine)
    if (mm) mm.caps = Object.assign({}, mm.caps || {}, capped.caps)
    return reply({ ok: true })
  }
  if (u.includes('/api/create')) { created = JSON.parse(String(init.body)); return reply({ ok: true }) }
  if (u.includes('/api/attach')) { attached = JSON.parse(String(init.body)); return reply({ ok: true }) }
  if (u.includes('/api/board')) { if (BOARD_FAIL) throw new Error('timeout'); return reply(BOARD) }
  return reply({ ok: true })
})

const tools = new Map()
const routes = []
const ctx = {
  tools: { register(spec) { tools.set(spec.name, spec) } },
  webServer: { register(spec) { routes.push(spec); return () => {} }, getOrigin() { return 'http://host.test' } },
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
assert.equal(created.dispatch, 'auto', '重派必须带 dispatch=auto，否则永远排队（v2.3.0 B1 回归）')
assert.equal(created.mode, 'agent')
assert.ok(String(created.note).includes('重派自 failed-1'))

created = null
const rtRunning = await tools.get('board_retry').execute({ task_id: 'running-1' })
assert.equal(rtRunning.ok, false, '执行中的任务不能重派')
assert.equal(created, null, '拒绝时不应建单')

const rtMissing = await tools.get('board_retry').execute({ task_id: 'nope' })
assert.equal(rtMissing.ok, false, '不存在的任务应报错')

// 活跃副本去重：同一失败任务已经有 queued/claimed/running 的重派副本时拒绝。
BOARD.tasks.push({ id: 'rt-dup-1', status: 'queued', goal: 'echo fail', machine: 'GT14', note: '重派自 failed-1' })
created = null
const rtDup = await tools.get('board_retry').execute({ task_id: 'failed-1' })
assert.equal(rtDup.ok, false, '已有活跃重派副本时应拒绝重复重派')
assert.ok(/已经重派过/.test(String(rtDup.error)), '错误应说明已有副本')
assert.equal(created, null, '重复重派不应建单')

// v2.4.0 能力卡：A1 应用探测结果（身份、角色、模型清洗）；A2 本机只读探测。
function callRoute(routePath, payload, method = 'POST') {
  const spec = routes.find((r) => r.path === routePath)
  assert.ok(spec, '缺少路由 ' + routePath)
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))])
    req.method = method
    req.url = routePath
    req.headers = {
      host: '127.0.0.1:4112',
      origin: 'http://127.0.0.1:4112',
      'x-dsh-team-ui': '1',
      'content-type': 'application/json',
    }
    const out = { status: 0, body: '' }
    const res = {
      writeHead(status) { out.status = status },
      end(text) { out.body = String(text || ''); resolve(out) },
    }
    try {
      const ret = spec.handler(req, res)
      if (ret && typeof ret.then === 'function') ret.catch((e) => resolve({ status: 500, body: String((e && e.message) || e) }))
    } catch (e) {
      resolve({ status: 500, body: String((e && e.message) || e) })
    }
  })
}

capped = null
const a0 = await callRoute('/api/board/ui/caps-apply', {})
assert.equal(a0.status, 400, '缺 caps 必须 400：' + a0.body)
const a0b = await callRoute('/api/board/ui/caps-apply', { caps: {}, role: 'boss' })
assert.equal(a0b.status, 400, '非法角色必须 400：' + a0b.body)
const a0c = await callRoute('/api/board/ui/caps-probe', {}, 'GET')
assert.equal(a0c.status, 405, 'caps-probe 必须拒绝 GET：' + a0c.body)

capped = null
const many = Array.from({ length: 200 }, (_, i) => ({ id: 'm' + i, endpoint: 'http://127.0.0.1:1/v1', location: 'local' }))
const a1c = await callRoute('/api/board/ui/caps-apply', { caps: { identity: {} }, role: 'none', models: many })
assert.equal(a1c.status, 200, '超量模型应截断而不是报错：' + a1c.body)
assert.ok(capped && capped.caps.models.length > 0 && capped.caps.models.length <= 80, '模型应在 80 条与 8KB 预算内，实际 ' + (capped && capped.caps.models.length))
const a1cj = JSON.parse(a1c.body)
assert.ok(a1cj.modelsDropped > 0, '超预算时应丢弃尾部模型并回报 modelsDropped')

capped = null
const a1 = await callRoute('/api/board/ui/caps-apply', {
  caps: { identity: { cpu: 'test-cpu', ramGB: 16 }, gpu: [], tools: {}, models: [], gaps: [] },
  role: 'primary',
  machine: 'evil-machine',
  models: [{ id: 'qwen3:8b', endpoint: 'http://127.0.0.1:8080/v1', location: 'local', ctx: 32768, source: 'guessed' }],
  allowUnverifiedHighRisk: true,
})
const a1j = JSON.parse(a1.body)
assert.equal(a1.status, 200, 'caps-apply 应 200：' + a1.body)
assert.equal(a1j.ok, true)
assert.ok(capped && capped.machine === 'host', '能力卡必须用本机身份写到板子，忽略 body.machine')
assert.equal(capped.caps.identity.machine, 'host', 'caps.identity.machine 也要覆盖成本机身份')
assert.equal(capped.caps.schema, 2.1)
assert.equal(capped.caps.roles[0].id, 'primary')
assert.equal(capped.caps.allowUnverifiedHighRisk, true)
assert.equal(capped.caps.models.length, 1, '模型应清洗后透传')

capped = null
const aw = await callRoute('/api/board/ui/caps-apply', {
  caps: { identity: {}, workloads: [{ id: 'video.interp', unit: 'fps', value: 4.8, samples: 1, confidence: 'measured', workload: { width: 1920, streams: 6 }, aggregate: 12.1, perStream: 2.0, maxStreams: 6, measuredAt: new Date().toISOString() }] },
  role: 'primary',
})
const awj = JSON.parse(aw.body)
assert.equal(aw.status, 200, '带 workloads 的 caps-apply 应 200：' + aw.body)
assert.equal(awj.workloads, 1, 'workloads 数量应回传')
assert.equal(capped && capped.caps.schema, 2.1, 'schema 应为 2.1')
assert.equal(capped && capped.caps.workloads && capped.caps.workloads[0] && capped.caps.workloads[0].id, 'video.interp')
assert.equal(capped.caps.workloads[0].aggregate, 12.1, '并发合计吞吐应保留')
assert.equal(capped.caps.workloads[0].perStream, 2, '每流吞吐应保留')
assert.equal(capped.caps.workloads[0].maxStreams, 6, '最大并发应保留')

// A6：板子读失败时，面板保存不得发出 models/workloads 键（否则空数组会整体覆盖该机实测）。
BOARD_FAIL = true
capped = null
const a6 = await callRoute('/api/board/ui/caps-apply', { caps: { identity: {} }, role: 'secondary' })
BOARD_FAIL = false
const a6j = JSON.parse(a6.body)
assert.equal(a6.status, 200, '读卡失败时面板保存应仍可写（只带用户本次改的字段）：' + a6.body)
assert.ok(capped && capped.caps, '应写回一次 caps')
assert.equal(Object.prototype.hasOwnProperty.call(capped.caps, 'models'), false, '读卡失败时不得携带 models 键（空数组会清空旧卡）')
assert.equal(Object.prototype.hasOwnProperty.call(capped.caps, 'workloads'), false, '读卡失败时不得携带 workloads 键（空数组会清空实测）')
for (const k of ['gpu', 'tools', 'limits', 'gaps', 'detectedAt', 'identity']) {
  assert.equal(Object.prototype.hasOwnProperty.call(capped.caps, k), false, '读卡失败时不得携带空 ' + k + ' 键（浅合并会清空旧卡）')
}

const cat = await callRoute('/api/board/ui/workload-catalog', {}, 'GET')
const catj = JSON.parse(cat.body)
assert.equal(cat.status, 200, 'workload-catalog 应 200：' + cat.body)
assert.ok(Array.isArray(catj.catalog) && catj.catalog.some((w) => w.id === 'video.interp' && w.enabled), '目录应含已开放的 video.interp')

const eta = await tools.get('board_dispatch').execute({ goal: 'eta test', taskKind: 'interp', size: 480, dryRun: true })
assert.equal(eta.ok, true, 'ETA dryRun 应 ok：' + JSON.stringify(eta).slice(0, 300))
assert.equal(eta.machine, 'PC2', 'ETA 应选更快的 PC2（480/50+8≈17.6s vs GT14 32s），实际 ' + eta.machine + ' / ' + eta.reason)
assert.equal(eta.workload, 'video.interp')
assert.ok(eta.etaSeconds > 15 && eta.etaSeconds < 20, 'ETA 应在 17.6s 左右，实际 ' + eta.etaSeconds)

if (process.platform === 'win32') {
  capped = null
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  const wp = await callRoute('/api/board/ui/workload-probe', { workload: 'video.transcode' })
  const wpj = JSON.parse(wp.body)
  if (!hasFfmpeg) {
    // CI runner（windows-latest）没有 ffmpeg：探测必须给出明确的缺失错误，而不是静默成功/覆盖旧卡。
    assert.equal(wp.status, 500, '无 ffmpeg 时 workload-probe 应 500：' + wp.body)
    assert.match(String(wpj.error || ''), /ffmpeg/i, '错误应点明缺 ffmpeg：' + wp.body)
    console.log(' · A5 跳过实测（本机没有 ffmpeg）：已确认返回明确的缺失错误')
  } else {
    assert.equal(wp.status, 200, 'workload-probe(video.transcode) 应 200：' + wp.body)
    assert.equal(wpj.ok, true)
    assert.ok(wpj.workload && wpj.workload.value > 0, '探测应返回正数吞吐')
    assert.equal(wpj.workload.confidence, 'measured')
    assert.ok(capped && capped.caps.workloads && capped.caps.workloads.some((w) => w.id === 'video.transcode'), '探测结果应写进能力卡')
    assert.ok(capped.caps.workloads.some((w) => w.id === 'video.interp'), '重测/新增不能丢掉已有的 video.interp')
  }
}

if (process.platform === 'win32' && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
  // A7：补帧并发采样（v2.5.2）。单流快不代表 6 路合计也快，ETA 要按合计估批处理。
  capped = null
  const wi = await callRoute('/api/board/ui/workload-probe', { workload: 'video.interp' })
  const wij = JSON.parse(wi.body)
  assert.equal(wi.status, 200, 'interp 探测应 200：' + wi.body)
  assert.ok(wij.workload.aggregate > wij.workload.value, '6 路合计吞吐应大于单流：' + wi.body)
  assert.equal(wij.workload.maxStreams, 6, 'maxStreams 应为 6')
  console.log(' · A7 并发采样：单流 ' + wij.workload.value + ' fps，6 路合计 ' + wij.workload.aggregate + ' fps')
}

if (process.platform === 'win32') {
  const a2 = await callRoute('/api/board/ui/caps-probe', {})
  const a2j = JSON.parse(a2.body)
  assert.equal(a2.status, 200, 'caps-probe 应 200：' + a2.body)
  assert.equal(a2j.ok, true)
  assert.ok(a2j.caps && a2j.caps.identity && a2j.caps.identity.cpu, '探测结果应含 cpu')
}
// A3：summary 必须把 caps 的 location/tags 并进 nodeModels（先于 restore，仍走 stub）
const sum = await callRoute('/api/board/ui/summary', {}, 'GET')
assert.equal(sum.status, 200, 'summary 必须 200：' + sum.body)
const sumj = JSON.parse(sum.body)
assert.equal(sumj.ok, true, 'summary 应 ok：' + JSON.stringify(sumj).slice(0, 300))
const gtNM = (sumj.nodeModels && sumj.nodeModels['gt14']) || {}
const ds = (gtNM.models || []).find((m) => m.model === 'deepseek-flash') || {}
assert.equal(ds.location, 'cloud', 'nodeModels 应合并 caps.location：' + JSON.stringify(ds) + ' nm=' + JSON.stringify(gtNM))
assert.ok(Array.isArray(ds.tags) && ds.tags.indexOf('代码审查') >= 0, 'nodeModels 应合并 caps.tags：' + JSON.stringify(ds))
assert.equal(Object.prototype.defaultModel, undefined, 'nodeModels 不得被 __proto__ 节点污染')
assert.ok(Object.keys(sumj.nodeModels || {}).indexOf('__proto__') >= 0, '原型键应作为普通 own 键存在')
dispose()
globalThis.fetch = realFetch
fs.rmSync(root, { recursive: true, force: true })
console.log('PASS model-pick smoke (M1-M11, R1-R4, A1-A7)')
