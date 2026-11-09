/**
 * config-persist-smoke：v1.4.1 的第二层配置兜底。
 *
 * 背景：profile 的 cordis.patch.yml 会被宿主/设置页整份重写，2026-11-09 一天丢了两次
 * `- id: team`，导致 token 空、板子 401、hub 退回 127.0.0.1。插件现在把关键字段
 * 存在 <stateDir>/config.json：loader 给了值以 loader 为准并回写，缺省用存档兜底。
 *
 * 这里验证三件事：
 *   C1 只有存档、loader 给空 → 存档的值被采纳（写回文件时仍是存档值）
 *   C2 loader 显式给值 → 覆盖存档并写回
 *   C3 部分显式、部分缺省 → 显式的覆盖、缺省的仍走存档
 *
 * 用法：node scripts/config-persist-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-cfg-smoke-'))
process.env.DSH_TEAM_STATE_DIR = dir
const file = path.join(dir, 'config.json')

function writeSaved(obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
}

function readSaved() {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

class FakeWebServer {
  constructor() { this.exact = new Map() }
  register(route) {
    if (this.exact.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
    this.exact.set(route.path, route)
    return () => { if (this.exact.get(route.path) === route) this.exact.delete(route.path) }
  }
}

function makeCtx() {
  const ws = new FakeWebServer()
  const tools = new Map()
  const base = {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    webServer: ws,
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const ctx = new Proxy(base, {
    set(target, prop, value) {
      if (prop === 'tools' || prop === 'webServer') throw new Error(`cannot set property "${String(prop)}" in multiple fibers`)
      target[prop] = value
      return true
    },
  })
  return ctx
}

async function run(config) {
  const cleanup = await apply(makeCtx(), { autoDispatch: false, timeoutMs: 200, allowedRoots: [], ...config })
  const out = readSaved()
  if (typeof cleanup === 'function') await cleanup()
  return out
}

let pass = 0
let fail = 0
function check(ok, name, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

try {
  writeSaved({ token: 'saved-token-123', machine: 'saved-machine', dispatchRole: 'observer' })
  let c1 = await run({})
  check(c1.token === 'saved-token-123', 'C1 存档 token 被采纳', JSON.stringify(c1.token))
  check(c1.machine === 'saved-machine', 'C1 存档 machine 被采纳', JSON.stringify(c1.machine))
  check(c1.dispatchRole === 'observer', 'C1 存档 dispatchRole 被采纳', JSON.stringify(c1.dispatchRole))

  let c2 = await run({ token: 'explicit-token-456', machine: 'explicit-machine' })
  check(c2.token === 'explicit-token-456', 'C2 显式 token 覆盖存档', JSON.stringify(c2.token))
  check(c2.machine === 'explicit-machine', 'C2 显式 machine 覆盖存档', JSON.stringify(c2.machine))
  check(c2.dispatchRole === 'observer', 'C2 缺省的 role 仍走存档', JSON.stringify(c2.dispatchRole))

  let c3 = await run({ dispatchRole: 'owner', allowedRoots: ['D:\\gp_video'] })
  check(c3.token === 'explicit-token-456', 'C3 token 延续上一轮写回值', JSON.stringify(c3.token))
  check(c3.dispatchRole === 'owner', 'C3 显式 role 覆盖存档', JSON.stringify(c3.dispatchRole))
  check(Array.isArray(c3.allowedRoots) && c3.allowedRoots[0] === 'D:\\gp_video', 'C3 显式 allowedRoots 生效', JSON.stringify(c3.allowedRoots))
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\nconfig-persist-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
