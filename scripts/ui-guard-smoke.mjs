#!/usr/bin/env node
/**
 * ui-guard-smoke.mjs —— 验证 v1.3.7 的 /api/board/ui/* 闸门（复核 安全 F1）。
 *
 * 这些路由挂在 DSH 的 webserver 上，宿主只认登录态；而 POST /create 能带 mode=exec +
 * dispatch=auto 让 worker 跑任意命令。所以闸门必须在**进 handler 之前**就挡住：
 *   - 非回环 Host（DNS rebinding）
 *   - 跨站 Origin（CSRF）
 *   - 写请求缺 x-dsh-team-ui: 1 或不是 JSON
 *
 * 这里用假 ctx 捕获注册进来的 handler，再用构造好的 req/res 打它。
 */
import http from 'node:http'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

// v1.4.2：同 reload-smoke —— apply 会写 state dir，必须隔离到临时目录。
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-ui-guard-smoke-'))
process.env.DSH_TEAM_STATE_DIR = STATE_DIR
const IDENTITY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-ui-guard-identity-'))
process.env.DSH_TEAM_IDENTITY_DIR = IDENTITY_DIR

const results = []
function check(name, cond, detail) {
  results.push({ name, cond: Boolean(cond), detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const routes = new Map()
const tools = new Map()
const ctx = {
  tools: { register: (t) => (tools.set(t.name, t), () => {}) },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    getOrigin: () => 'http://127.0.0.1:9999',
  },
  get: () => null,
  effect: () => {},
  logger: { info() {}, warn() {}, error() {} },
}

const cleanup = apply(ctx, {
  boardUrl: 'http://127.0.0.1:1', // 故意不可达：通过闸门后 handler 会自己失败，但不返回 403
  machine: 'ui-guard-smoke',
  token: 'x',
  timeoutMs: 300,
  writeTimeoutMs: 300,
  autoDispatch: false,
  petImage: '',
})
await new Promise((r) => setTimeout(r, 250))

function call(path, { method = 'GET', headers = {}, body = '' } = {}) {
  const handler = routes.get(path)
  if (!handler) throw new Error('没有注册 ' + path)
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(body)] : [])
    req.method = method
    req.url = path
    req.headers = headers
    const out = { status: 0, body: '' }
    const res = {
      writeHead(code) { out.status = code; return this },
      setHeader() { return this },
      end(buf) { out.body = String(buf || ''); resolve(out) },
      writableEnded: false,
    }
    handler(req, res)
  })
}

const base = { host: '127.0.0.1:2980' }

// 1) 回环 GET 放行（会走到 handler，板子不可达 → 非 403）
let r = await call('/api/board/ui/summary', { headers: base })
check('回环 GET 放行', r.status !== 403, 'status=' + r.status)

// 2) 外部 Host（DNS rebinding）拒绝
r = await call('/api/board/ui/summary', { headers: { host: 'evil.example' } })
check('外部 Host 拒绝', r.status === 403 && r.body.includes('host'), 'status=' + r.status + ' body=' + r.body.slice(0, 60))

// 3) 跨站 Origin 拒绝
r = await call('/api/board/ui/summary', { headers: { ...base, origin: 'https://evil.example' } })
check('跨站 Origin 拒绝', r.status === 403 && r.body.includes('origin'), 'status=' + r.status)

// 4) 同源 Origin 放行
r = await call('/api/board/ui/summary', { headers: { ...base, origin: 'http://127.0.0.1:2980' } })
check('同源 Origin 放行', r.status !== 403, 'status=' + r.status)

// 5) 写请求缺自定义头 → 拒绝
const createPath = '/api/board/ui/create'
const payload = JSON.stringify({ task_id: 'bd-ui-smoke', goal: 'x', mode: 'exec', dispatch: 'auto' })
r = await call(createPath, {
  method: 'POST',
  headers: { ...base, 'content-type': 'application/json' },
  body: payload,
})
check('写请求缺 x-dsh-team-ui 拒绝', r.status === 403 && r.body.includes('token'), 'status=' + r.status)

// 6) 写请求带自定义头但不是 JSON → 拒绝
r = await call(createPath, {
  method: 'POST',
  headers: { ...base, 'x-dsh-team-ui': '1', 'content-type': 'text/plain' },
  body: payload,
})
check('非 JSON 写请求拒绝', r.status === 403 && r.body.includes('content-type'), 'status=' + r.status)

// 7) 写请求齐全 → 放行（板子不可达，handler 自己会失败，但不是 403）
r = await call(createPath, {
  method: 'POST',
  headers: { ...base, 'x-dsh-team-ui': '1', 'content-type': 'application/json' },
  body: payload,
})
check('合规写请求放行', r.status !== 403, 'status=' + r.status + ' body=' + r.body.slice(0, 80))

// 8) v1.4.0：doctor 也是 /api/board/ui/* 路由，同样要过闸门
r = await call('/api/board/ui/doctor', { headers: { host: 'evil.example' } })
check('doctor 外部 Host 拒绝', r.status === 403 && r.body.includes('host'), 'status=' + r.status)
r = await call('/api/board/ui/doctor', { headers: base })
check('doctor 回环放行', r.status === 200 && r.body.includes('checks'), 'status=' + r.status + ' body=' + r.body.slice(0, 80))
// v1.4.2：doctor 的 config-token 检查以前读的是不存在的 cfg.boardToken，配了 token 也永远报错。
// 这里 apply 时明确传了 token: 'x'，检查里就不该再出现 config-token。
{
  let doc = null
  try { doc = JSON.parse(r.body) } catch { /* ignore */ }
  const ids = doc && Array.isArray(doc.checks) ? doc.checks.map((c) => c.id) : []
  check('doctor 配了 token 不再报 config-token', !ids.includes('config-token'), 'ids=' + ids.join(','))
}

// 10) v2.2.0：改名路由同样过闸门；回环写入后返回新别名。
r = await call('/api/board/ui/alias', { method: 'POST', headers: { host: 'evil.example', 'x-dsh-team-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'x' }) })
check('alias 外部 Host 拒绝', r.status === 403 && r.body.includes('host'), 'status=' + r.status)
r = await call('/api/board/ui/alias', { method: 'POST', headers: { ...base, 'x-dsh-team-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify({ alias: '改名测试机' }) })
check('alias 回环放行', r.status === 200 && r.body.includes('改名测试机'), 'status=' + r.status + ' body=' + r.body.slice(0, 120))
r = await call('/api/board/ui/alias', { method: 'POST', headers: { ...base, 'x-dsh-team-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify({ alias: 'x'.repeat(33) }) })
check('alias 超长拒绝', r.status === 400, 'status=' + r.status)

cleanup()
await new Promise((r) => setTimeout(r, 100))

// 9) v2.0.6（P2-11）：uiAllowedHosts 必须真的接线 —— 名单内非回环 Host 放行，名单外仍 403。
{
  const routes2 = new Map()
  const ctx2 = {
    tools: { register: () => () => {} },
    webServer: {
      register: (route) => {
        routes2.set(route.path, route.handler)
        return () => routes2.delete(route.path)
      },
      getOrigin: () => 'http://127.0.0.1:9999',
    },
    get: () => null,
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const cleanup2 = apply(ctx2, {
    boardUrl: 'http://127.0.0.1:1',
    machine: 'ui-guard-smoke-2',
    token: 'x',
    timeoutMs: 300,
    writeTimeoutMs: 300,
    autoDispatch: false,
    petImage: '',
    uiAllowedHosts: ['allowed.example'],
  })
  await new Promise((r) => setTimeout(r, 250))
  const call2 = (p, headers) => {
    const handler = routes2.get(p)
    if (!handler) throw new Error('没有注册 ' + p)
    return new Promise((resolve) => {
      const req = Readable.from([])
      req.method = 'GET'
      req.url = p
      req.headers = headers
      const out = { status: 0, body: '' }
      const res = {
        writeHead(code) { out.status = code; return this },
        setHeader() { return this },
        end(buf) { out.body = String(buf || ''); resolve(out) },
        writableEnded: false,
      }
      handler(req, res)
    })
  }
  let rr = await call2('/api/board/ui/summary', { host: 'allowed.example' })
  check('uiAllowedHosts 名单内 Host 放行', rr.status === 200, 'status=' + rr.status)
  rr = await call2('/api/board/ui/summary', { host: 'other.example' })
  check('uiAllowedHosts 名单外仍拒绝', rr.status === 403 && rr.body.includes('host'), 'status=' + rr.status + ' body=' + rr.body.slice(0, 60))
  cleanup2()
  await new Promise((r) => setTimeout(r, 100))
}

fs.rmSync(STATE_DIR, { recursive: true, force: true })
fs.rmSync(IDENTITY_DIR, { recursive: true, force: true })
const failed = results.filter((x) => !x.cond)
console.log(`\nui-guard-smoke: ${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log('  FAILED ' + f.name + (f.detail ? ' — ' + f.detail : ''))
  process.exit(1)
}
