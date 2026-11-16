#!/usr/bin/env node
/**
 * v2.6.0 并入冒烟：单包双角色。
 *   W1 workerMode 缺省/off：18 个 host 工具，两个 worker 工具都不注册
 *   W2 workerMode=on：恰 20 个工具 + 24 条路由
 *   W3 worker_status 报包版本（读 package.json）、machine，且 boardUrl 用的是宿主传入的地址
 *   W4 cleanup：工具摘除、不抛
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-wmerge-'))
process.env.DSH_TEAM_STATE_DIR = path.join(root, 'state')
fs.mkdirSync(process.env.DSH_TEAM_STATE_DIR, { recursive: true })

const plugin = await import(pathToFileURL(path.resolve('lib/index.js')).href)

const BOARD_URL = 'http://127.0.0.1:65534'
const PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version

function makeCtx() {
  const tools = new Map()
  const effects = []
  const ctx = {
    routes: 0,
    tools: {
      register(t) {
        assert.ok(t && t.name, 'tool 必须有 name')
        tools.set(t.name, t)
        return () => tools.delete(t.name)
      },
      list: () => [...tools.keys()],
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    on() {
      return () => {}
    },
    webServer: {
      register() {
        ctx.routes += 1
        return () => {}
      },
      getOrigin() {
        return 'http://host.test'
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    _tools: tools,
    _runEffects() {
      for (const fn of effects.splice(0)) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    },
  }
  return ctx
}

// W1 — off
const off = makeCtx()
const offCleanup = await plugin.apply(off, { workerMode: 'off', machine: 'host', token: '' })
assert.ok(!off._tools.has('worker_status'), 'W1 workerMode=off 不应注册 worker_status')
assert.ok(!off._tools.has('worker_control'), 'W1 workerMode=off 不应注册 worker_control')
assert.ok(off._tools.has('board_status'), 'W1 job-board 工具必须仍在')
assert.equal(off._tools.size, 18, `W1 off 工具数应为 18，实际 ${off._tools.size}`)
console.log('W1 off: 18 tools, no worker tools')
if (typeof offCleanup === 'function') offCleanup()

// W2 — on
const on = makeCtx()
const cleanup = await plugin.apply(on, {
  workerMode: 'on',
  boardUrl: BOARD_URL,
  machine: 'PC2',
  token: '',
  worker: { pollMs: 60000, beatMs: 60000, maxConcurrent: 1 },
})
for (const name of ['worker_status', 'worker_control']) {
  assert.ok(on._tools.has(name), `W2 workerMode=on 应注册 ${name}`)
}
assert.equal(on._tools.size, 20, `W2 on 工具数应为 20，实际 ${on._tools.size}`)
assert.equal(on.routes, 24, `W2 on 路由数应为 24，实际 ${on.routes}`)
console.log(`W2 on: tools=${on._tools.size}, routes=${on.routes}`)

// W3 — status 版本 / 机器 / boardUrl
const status = await on._tools.get('worker_status').execute({})
const text = JSON.stringify(status)
assert.ok(text.includes(PKG_VERSION), `W3 worker_status 应报 ${PKG_VERSION}，实际 ${text}`)
assert.ok(/pc2/i.test(text), 'W3 worker_status 应报 machine')
assert.ok(text.includes(BOARD_URL), `W3 worker_status 必须回显宿主解析的 boardUrl（${BOARD_URL}），实际 ${text}`)
console.log('W3 version/machine/boardUrl ok')

// W4 — cleanup
on._runEffects()
try {
  cleanup && (await cleanup())
} catch (err) {
  assert.fail(`W4 cleanup 抛了：${err}`)
}
assert.equal(on._tools.size, 0, `W4 cleanup 后工具应摘净，实际还剩 ${on._tools.size}`)
console.log('W4 cleanup ok')

// W5 — 自动探测：不给 boardUrl，靠 DSH_BOARD_URL 找到假板子；status 必须回显它。
// 这一条盯的是 B1 回归（worker 拿到未解析地址/回落内网）。
const http = await import('node:http')
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: 4 }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, tasks: {}, machines: {} }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const probeUrl = `http://127.0.0.1:${port}`
try { fs.rmSync(path.join(root, 'state', 'config.json'), { force: true }) } catch {}
const prev = process.env.DSH_BOARD_URL
process.env.DSH_BOARD_URL = probeUrl
const auto = makeCtx()
const autoCleanup = await plugin.apply(auto, { workerMode: 'on', solo: false, machine: 'PC2', token: '', worker: { pollMs: 60000, beatMs: 60000 } })
let autoStatus = null
for (let i = 0; i < 40 && !autoStatus; i += 1) {
  if (auto._tools.has('worker_status')) autoStatus = await auto._tools.get('worker_status').execute({})
  else await new Promise((r) => setTimeout(r, 50))
}
assert.ok(autoStatus, 'W5 自动探测后应注册 worker_status')
console.log('W5 probe=', probeUrl, 'status=', autoStatus.boardUrl, 'env=', process.env.DSH_BOARD_URL)
assert.equal(autoStatus.boardUrl, probeUrl, `W5 boardUrl 必须回显自动探测结果，实际 ${autoStatus.boardUrl}`)
if (typeof autoCleanup === 'function') await autoCleanup()
if (prev === undefined) delete process.env.DSH_BOARD_URL
else process.env.DSH_BOARD_URL = prev
await new Promise((resolve) => server.close(resolve))
console.log(`W5 auto-detect: ${autoStatus.boardUrl} ok`)
console.log('PASS worker-merge W1-W5')
