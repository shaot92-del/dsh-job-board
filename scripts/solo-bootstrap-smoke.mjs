/**
 * solo-bootstrap-smoke：v1.5.0 的「零配置首次启用」。
 *
 * 场景：用户从插件市场装完、直接启用，profile 里没有 team 配置（没有 token、
 * 没有 boardUrl）。插件应该自己起一个本机板子，并把 token/boardUrl 写进
 * <stateDir>/config.json，面板马上就有数据，而不是 401 空面板。
 *
 * 验证：
 *   B1 apply 不抛错，solo 板子在 127.0.0.1 上应答
 *   B2 config.json 里出现了随机 token 与 boardUrl
 *   B3 带 token 读 /api/board 成功；不带 token → 401
 *   B4 cleanup 之后端口关闭（不留下孤儿监听）
 *   B5 显式配了 token/boardUrl 时不启动 solo（用不到本机板子）
 *
 * 用法：node scripts/solo-bootstrap-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-boot-'))
process.env.DSH_TEAM_STATE_DIR = dir
const cfgFile = path.join(dir, 'config.json')

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`)
  }
}

class FakeWebServer {
  constructor() {
    this.exact = new Map()
  }
  register(route) {
    if (this.exact.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
    this.exact.set(route.path, route)
    return () => {
      if (this.exact.get(route.path) === route) this.exact.delete(route.path)
    }
  }
}

function makeCtx() {
  const ws = new FakeWebServer()
  const base = {
    tools: { register: () => () => {} },
    webServer: ws,
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return new Proxy(base, {
    set(target, prop, value) {
      if (prop === 'tools' || prop === 'webServer') {
        throw new Error(`cannot set property "${String(prop)}" in multiple fibers`)
      }
      target[prop] = value
      return true
    },
  })
}

const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

// ── B1/B2/B3/B4：零配置 ────────────────────────────────────────────────
const cleanup = apply(makeCtx(), { machine: 'solo-smoke', dispatchRole: 'observer', autoDispatch: false, timeoutMs: 800 })

const saved = await waitFor(() => {
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    return j.token && j.boardUrl ? j : null
  } catch {
    return null
  }
})
check('B2 config.json 写入 token 与 boardUrl', !!saved, saved ? saved.boardUrl + ' token=' + String(saved.token).slice(0, 6) + '…' : 'no config')

let boardOk = false
let noToken = 0
if (saved && saved.boardUrl) {
  try {
    const h = await fetch(saved.boardUrl + '/api/health', { headers: { 'x-board-token': saved.token } })
    const hj = await h.json()
    boardOk = h.ok && hj.ok === true && hj.solo === true
    const r = await fetch(saved.boardUrl + '/api/board')
    noToken = r.status
  } catch (e) {
    console.log('  info  fetch failed: ' + e.message)
  }
}
check('B1 solo 板子在 127.0.0.1 应答', boardOk, saved ? saved.boardUrl : '')
check('B3 无 token 读板子被拒', noToken === 401, 'status=' + noToken)

const port = saved && saved.boardUrl ? Number(new URL(saved.boardUrl).port) : 0
cleanup()
await new Promise((r) => setTimeout(r, 300))
let closed = false
if (port) {
  try {
    await fetch('http://127.0.0.1:' + port + '/api/health')
  } catch {
    closed = true
  }
}
check('B4 cleanup 关闭 solo 监听', closed, 'port=' + port)

// ── B5：显式配置不触发 solo ───────────────────────────────────────────
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-boot2-'))
process.env.DSH_TEAM_STATE_DIR = dir2
const cleanup2 = apply(makeCtx(), {
  boardUrl: 'http://127.0.0.1:9',
  token: 'explicit-token',
  machine: 'solo-smoke-2',
  dispatchRole: 'observer',
  autoDispatch: false,
  timeoutMs: 300,
})
await new Promise((r) => setTimeout(r, 500))
let saved2 = {}
try {
  saved2 = JSON.parse(fs.readFileSync(path.join(dir2, 'config.json'), 'utf8'))
} catch {
  /* ignore */
}
check('B5 显式 token 时不启 solo', saved2.token === 'explicit-token' && saved2.boardUrl === 'http://127.0.0.1:9', JSON.stringify(saved2))
cleanup2()
await new Promise((r) => setTimeout(r, 100))

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(dir2, { recursive: true, force: true })
if (failed) {
  console.log(`\nsolo-bootstrap-smoke: ${failed} failed`)
  process.exit(1)
}
console.log('\nsolo-bootstrap-smoke: 全部通过')
