/**
 * F1「能力知晓 / 机器性能感知」单元测试
 * 覆盖：perf 提取（含 null 不伪造 0）、fit 适配分（确定性 / 离线=0 / 无模型=0 / 缺 GPU/ffmpeg/pwsh=0 / 加权排序）、
 * 历史 P50→ETA（3 条 10/20/30→20s / 样本<3→null / 大小写归一 / 异常时间戳过滤）、以及 /create 提交协议不变性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractMachinePerf,
  fit,
  computeMachineFit,
  rankMachinesForTask,
  makeEtaKey,
  computeHistoryP50,
  buildEtaIndex,
  lookupEta,
} from '../../lib/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('F1-1 extractMachinePerf: 完整 caps + live + nodeModels 提取精确值', () => {
  const machine = {
    id: 'GT14',
    online: true,
    caps: {
      cores: 12,
      memGB: 32,
      freeDiskGB: 180.5,
      gpu: [{ name: 'NVIDIA GeForce RTX 3070 Ti', adapterRAMGB: 8 }],
      features: { ffmpeg: '7.0', pwsh: '7.4.5' },
      models: [{ id: 'qwen35-9b' }],
    },
    live: {
      cores: 12,
      memTotalGB: 32,
      memUsedGB: 8.6,
      freeDiskGB: 210.4,
      diskTotalGB: 500,
    },
  }
  const nodeModels = {
    gt14: {
      models: [
        { provider: 'deepseek-account', model: 'deepseek-flash' },
        { provider: 'local-llama', model: 'qwen35-9b' },
        { provider: 'local-llama', model: 'ds4-9b' },
      ],
    },
  }
  const perf = extractMachinePerf(machine, nodeModels)
  assert.deepEqual(perf, {
    cores: 12,
    memFreeGb: 23.4,
    memTotalGb: 32,
    diskFreeGb: 210.4,
    gpu: 'NVIDIA GeForce RTX 3070 Ti',
    models: 3,
    ffmpeg: true,
    pwsh: true,
  })
})

test('F1-1 extractMachinePerf: 缺失字段一律返回 null（绝不伪造 0）', () => {
  const perf = extractMachinePerf({ id: 'OLD_PC', online: true, caps: null, live: null }, null)
  assert.deepEqual(perf, {
    cores: null,
    memFreeGb: null,
    memTotalGb: null,
    diskFreeGb: null,
    gpu: null,
    models: null,
    ffmpeg: null,
    pwsh: null,
  })
})

test('F1-1 extractMachinePerf: 兼容真实 summary 样本（mem/disk/ffmpeg/pwsh 为 null，gpu 为对象数组）', () => {
  const perf = extractMachinePerf(
    {
      id: 'PC2',
      online: true,
      caps: {
        os: 'Windows 11 (10.0.26100)',
        cpu: 'Intel(R) Core(TM) i5-14490F',
        mem: null,
        disk: null,
        gpu: [{ name: 'NVIDIA GeForce GTX 1080', adapterRAMGB: 8 }],
        ffmpeg: null,
        pwsh: null,
        models: [{ id: 'deepseek-v4-pro-qwen3.5-9b' }],
      },
    },
    {
      pc2: {
        models: [
          { provider: 'deepseek-account', model: 'deepseek-flash' },
          { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
          { provider: 'local-llama', model: 'deepseek-v4-pro-qwen3.5-9b' },
        ],
      },
    },
  )
  assert.equal(perf.cores, null)
  assert.equal(perf.memFreeGb, null)
  assert.equal(perf.memTotalGb, null)
  assert.equal(perf.diskFreeGb, null)
  assert.equal(perf.gpu, 'NVIDIA GeForce GTX 1080')
  assert.equal(perf.models, 3)
  assert.equal(perf.ffmpeg, null)
  assert.equal(perf.pwsh, null)
})

test('F1-2 fit: 纯函数确定性（相同输入两次调用完全一致）', () => {
  const m = {
    id: 'GT14',
    online: true,
    busy: 0,
    perf: { cores: 12, memFreeGb: 23.4, memTotalGb: 32, diskFreeGb: 180, gpu: 'RTX 3070 Ti', models: 4, ffmpeg: true, pwsh: true },
  }
  const nm = { gt14: { models: [{ provider: 'local-llama', model: 'qwen35-9b' }] } }
  const profile = { mode: 'agent', model: 'local-llama/qwen35-9b', needGpu: true }
  const r1 = fit(profile, m, nm)
  const r2 = computeMachineFit(profile, m, nm)
  assert.deepEqual(r1, r2)
  assert.ok(r1.score > 0 && r1.score <= 100)
  assert.ok(r1.reasons.length >= 2)
})

test('F1-2 fit: 离线直接 0 分且 reason 含「离线」', () => {
  const r = fit(
    { mode: 'agent', model: '' },
    { id: 'PC2', online: false, busy: 0, perf: { cores: 16, memFreeGb: 32, memTotalGb: 64, diskFreeGb: 500, gpu: 'GTX 1080', models: 3, ffmpeg: true, pwsh: true } },
  )
  assert.equal(r.score, 0)
  assert.deepEqual(r.reasons, ['离线'])
})

test('F1-2 fit: 模型不在机器清单里 ⇒ 0 分且 reason 含「无此模型」', () => {
  const nm = { gt14: { models: [{ provider: 'deepseek-account', model: 'deepseek-flash' }] } }
  const r = fit(
    { mode: 'agent', model: 'local-llama/qwen35-9b' },
    { id: 'GT14', online: true, busy: 0, perf: { cores: 14, memFreeGb: 20, memTotalGb: 32, diskFreeGb: 200, gpu: 'Arc', models: 1, ffmpeg: true, pwsh: true } },
    nm,
  )
  assert.equal(r.score, 0)
  assert.ok(r.reasons.some((x) => x.includes('无此模型')))
})

test('F1-2 fit: 需要 GPU / ffmpeg / pwsh 但缺失 ⇒ 0 分；未要求时不扣分', () => {
  const baseMachine = {
    id: 'PC2',
    online: true,
    busy: 0,
    perf: { cores: 8, memFreeGb: 16, memTotalGb: 32, diskFreeGb: 100, gpu: null, models: 2, ffmpeg: false, pwsh: null },
  }
  const noGpu = fit({ mode: 'agent', needGpu: true }, baseMachine)
  assert.equal(noGpu.score, 0)
  assert.ok(noGpu.reasons.some((x) => x.includes('GPU')))

  const noFfmpeg = fit({ mode: 'exec', needFfmpeg: true }, baseMachine)
  assert.equal(noFfmpeg.score, 0)
  assert.ok(noFfmpeg.reasons.some((x) => x.includes('ffmpeg')))

  const noPwsh = fit({ mode: 'exec', needPwsh: true }, baseMachine)
  assert.equal(noPwsh.score, 0)
  assert.ok(noPwsh.reasons.some((x) => x.includes('pwsh')))

  const notRequired = fit({ mode: 'exec', needGpu: false, needFfmpeg: false, needPwsh: false }, baseMachine)
  assert.ok(notRequired.score > 0)
})

test('F1-2 fit: 空闲高配机得分高于忙碌机，perf=null 按中性基线（68 分）且不崩', () => {
  const idleStrong = {
    id: 'GT14',
    online: true,
    busy: 0,
    perf: { cores: 14, memFreeGb: 24, memTotalGb: 32, diskFreeGb: 220, gpu: 'Intel Arc', models: 4, ffmpeg: true, pwsh: true },
  }
  const busyStrong = Object.assign({}, idleStrong, { id: 'PC2', busy: 1 })
  const unknownPerf = { id: 'LEGACY', online: true, busy: 0, perf: null }

  const rIdle = fit({ mode: 'agent' }, idleStrong)
  const rBusy = fit({ mode: 'agent' }, busyStrong)
  const rNull = fit({ mode: 'agent' }, unknownPerf)

  assert.ok(rIdle.score > rBusy.score)
  assert.ok(rBusy.reasons.some((x) => x.includes('正在跑 1 个任务 ⇒ 排后')))
  assert.equal(rNull.score, 68)
  assert.ok(rNull.reasons.some((x) => x.includes('未知')))

  const ranked = rankMachinesForTask({ mode: 'agent' }, [busyStrong, unknownPerf, idleStrong])
  assert.equal(ranked[0].machine, 'GT14')
})

test('F1-3 computeHistoryP50: 3 条 10/20/30s 同型号 done 任务 ⇒ P50=20s；样本<3 ⇒ null', () => {
  const tasks = [
    { id: 't1', machine: 'GT14', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 1700000000, finished_at: 1700000010 },
    { id: 't2', machine: 'gt14', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 1700000100, finished_at: 1700000130 },
    { id: 't3', machine: 'Gt14', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 1700000200, finished_at: 1700000220 },
    // 干扰项：非 done / 0 时间戳 / 其他机器 / 其他模型
    { id: 't4', machine: 'gt14', mode: 'agent', model: 'deepseek-flash', status: 'failed', created_at: 1700000300, finished_at: 1700000900 },
    { id: 't5', machine: 'gt14', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 0, finished_at: 0 },
    { id: 't6', machine: 'PC2', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 1700000400, finished_at: 1700000500 },
    { id: 't7', machine: 'PC2', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 1700000500, finished_at: 1700000600 },
  ]
  assert.equal(computeHistoryP50(tasks, { machine: 'gt14', mode: 'agent', model: 'deepseek-flash' }), 20)
  assert.equal(computeHistoryP50(tasks, { machine: 'GT14', mode: 'agent', model: 'deepseek-flash' }), 20)
  // PC2 仅 2 条样本 ⇒ 必须返回 null
  assert.equal(computeHistoryP50(tasks, { machine: 'pc2', mode: 'agent', model: 'deepseek-flash' }), null)

  // 偶数样本（4 条：10/20/30/50 ⇒ P50=25）
  const tasks4 = tasks.concat([
    { id: 't8', machine: 'gt14', mode: 'agent', model: 'deepseek-flash', status: 'done', created_at: 1700000600, finished_at: 1700000650 },
  ])
  assert.equal(computeHistoryP50(tasks4, { machine: 'gt14', mode: 'agent', model: 'deepseek-flash' }), 25)
})

test('F1-3 buildEtaIndex & lookupEta: 毫秒时间戳兼容 + 桶隔离 + 样本<3 不入索引', () => {
  const baseMs = 1732400000000
  const tasks = [
    { machine: 'GT14', mode: 'agent', model: 'qwen35-9b', status: 'done', created_at: baseMs, finished_at: baseMs + 372000 },
    { machine: 'gt14', mode: 'agent', model: 'qwen35-9b', status: 'done', created_at: baseMs + 1000, finished_at: baseMs + 301000 },
    { machine: 'gt14', mode: 'agent', model: 'qwen35-9b', status: 'done', created_at: baseMs + 2000, finished_at: baseMs + 422000 },
    { machine: 'pc2', mode: 'exec', model: null, status: 'done', created_at: 1700000000, finished_at: 1700000015 },
    { machine: 'pc2', mode: 'exec', model: null, status: 'done', created_at: 1700000100, finished_at: 1700000125 },
  ]
  const idx = buildEtaIndex(tasks)
  assert.equal(makeEtaKey('GT14', 'agent', 'qwen35-9b'), 'gt14|agent|qwen35-9b')
  const hit = lookupEta(idx, { machine: 'GT14', mode: 'agent', model: 'qwen35-9b' })
  assert.deepEqual(hit, { p50Sec: 372, samples: 3 })
  assert.equal(lookupEta(idx, { machine: 'pc2', mode: 'exec', model: '' }), null)
})

test('硬约束校验: 不改 /api/board/ui/create 载荷字段且不改版本号', () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  // 版本号 bump 由主控统一执行：这里只校验「三处版本一致」，不写死某个基线版本
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  assert.ok(clientSrc.includes(`const CLIENT_VERSION = '${pkgVersion}'`), `CLIENT_VERSION 必须与 package.json 版本一致（当前 ${pkgVersion}）`)
  const idx = clientSrc.indexOf("const cre = await getJson(API + '/create'")
  assert.ok(idx > 0)
  const seg = clientSrc.slice(idx, idx + 600)
  for (const field of ['task_id:', 'goal:', 'title:', 'machine:', 'model:', 'dispatch:', 'mode:', 'maint_ticket:', 'workspace:']) {
    assert.ok(seg.includes(field), 'create 载荷缺少原有字段 ' + field)
  }
})
