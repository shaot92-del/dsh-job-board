/**
 * shell-guard-smoke：v2.0.2 的两条安全收紧。
 *
 *   G1 空白名单 + 未 allowAll ⇒ sh_read / sh_list / sh_write 一律拒绝（fail-closed）
 *   G2 显式 allowAllRoots:true ⇒ 放行
 *   G3 子进程拿不到插件进程的私密环境变量（DSH_TEAM_*、API key 之类）
 *   G4 envPassthrough 里显式列出的变量仍然透传
 *
 * 用法：node scripts/shell-guard-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerShellTools } from '../lib/shell.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-shell-smoke-'))
const file = path.join(dir, 'note.txt')
fs.writeFileSync(file, 'hello', 'utf8')

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`)
  }
}

function makeTools(config) {
  const map = new Map()
  registerShellTools({ tools: { register: (def) => map.set(def.name, def) } }, config)
  return (name, args) => map.get(name).execute(args)
}

// ── G1：空 allowedRoots 必须拒绝 ─────────────────────────────────────────
let call = makeTools({ allowedRoots: [] })
let r = await call('sh_read', { path: file })
check('G1a 空白名单 sh_read 被拒', r.ok === false && /allowedRoots/.test(r.message || ''), r.message || '')
r = await call('sh_list', { path: dir })
check('G1b 空白名单 sh_list 被拒', r.ok === false && /allowedRoots/.test(r.message || ''), r.message || '')
r = await call('sh_write', { path: path.join(dir, 'new.txt'), text: 'x' })
check('G1c 空白名单 sh_write 被拒', r.ok === false && /allowedRoots/.test(r.message || ''), r.message || '')
check('G1d 被拒后没有写文件', !fs.existsSync(path.join(dir, 'new.txt')))

// ── G2：显式 allowAllRoots 才放行 ───────────────────────────────────────
call = makeTools({ allowedRoots: [], allowAllRoots: true })
r = await call('sh_read', { path: file })
check('G2 显式 allowAllRoots 放行', r.ok === true && r.text === 'hello', r.text || r.message || '')

// ── G3：环境变量收敛 ───────────────────────────────────────────────────
process.env.DSH_TEST_SECRET = 'TOP-SECRET-123'
process.env.DSH_TEAM_TOKEN = 'board-token-should-not-leak'
const probe = 'node -p "JSON.stringify({secret:process.env.DSH_TEST_SECRET||null,board:process.env.DSH_TEAM_TOKEN||null,path:!!process.env.PATH})"'
r = await call('sh_run', { command: probe, timeoutMs: 20000 })
let probeJson = null
try {
  probeJson = JSON.parse(String(r.stdout || '').trim())
} catch {
  probeJson = null
}
check('G3 子进程看不到私密环境变量', !!probeJson && probeJson.secret === null && probeJson.board === null, String(r.stdout || r.message || '').trim())
check('G3b 基础变量 PATH 仍然透传', !!probeJson && probeJson.path === true)

// ── G4：envPassthrough 显式放行 ─────────────────────────────────────────
call = makeTools({ allowedRoots: [], allowAllRoots: true, envPassthrough: ['DSH_TEST_SECRET'] })
r = await call('sh_run', { command: probe, timeoutMs: 20000 })
try {
  probeJson = JSON.parse(String(r.stdout || '').trim())
} catch {
  probeJson = null
}
check('G4 envPassthrough 放行指定变量', !!probeJson && probeJson.secret === 'TOP-SECRET-123' && probeJson.board === null, String(r.stdout || r.message || '').trim())

// ── G5：从 apply 到工具的整条线（复核 H3：只测 registerShellTools 会漏掉接线）──
// 空白名单 + config.allowAllRoots=true 必须真的放行；不传时仍然拒绝。
const { apply } = await import('../lib/index.js')
class FakeWebServer {
  constructor() { this.exact = new Map() }
  register(route) {
    if (this.exact.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
    this.exact.set(route.path, route)
    return () => { if (this.exact.get(route.path) === route) this.exact.delete(route.path) }
  }
}
function applyWith(extra) {
  const tools = new Map()
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-shell-apply-'))
  process.env.DSH_TEAM_STATE_DIR = dir2
  const base = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    webServer: new FakeWebServer(),
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const ctx = new Proxy(base, {
    set(target, prop, value) {
      if (prop === 'tools' || prop === 'webServer') throw new Error('cannot set property in multiple fibers')
      target[prop] = value
      return true
    },
  })
  const cleanup = apply(ctx, {
    token: 'x', boardUrl: 'http://127.0.0.1:9', machine: 'shell-smoke',
    dispatchRole: 'observer', autoDispatch: false, timeoutMs: 300, ...extra,
  })
  return { tools, cleanup, dir: dir2 }
}
let app = applyWith({ allowedRoots: [], allowAllRoots: true })
r = await app.tools.get('sh_read').execute({ path: file })
check('G5 apply 传入 allowAllRoots 后 sh_read 放行', r.ok === true && r.text === 'hello', r.text || r.message || '')
app.cleanup()
fs.rmSync(app.dir, { recursive: true, force: true })

app = applyWith({ allowedRoots: [] })
r = await app.tools.get('sh_read').execute({ path: file })
check('G5b apply 未传 allowAllRoots 时仍拒绝', r.ok === false && /allowedRoots/.test(r.message || ''), r.message || '')
app.cleanup()
fs.rmSync(app.dir, { recursive: true, force: true })

// ── G6：显式 cwd 不存在时不能静默回退（P2-12）──────────────────────────
call = makeTools({ allowedRoots: [dir] })
const missing = path.join(dir, 'not-created')
r = await call('sh_run', { command: 'node -p "process.cwd()"', cwd: missing, timeoutMs: 20000 })
check('G6 不存在的 cwd 直接报错', r.ok === false && /cwd 不存在/.test(r.message || ''), r.message || '')

// ── G7：盘符根（C:\）白名单也能匹配子路径（P2-13）────────────────────
call = makeTools({ allowedRoots: [path.parse(dir).root] })
r = await call('sh_read', { path: file })
check('G7 整盘根白名单可用', r.ok === true && r.text === 'hello', r.text || r.message || '')

fs.rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.log(`\nshell-guard-smoke: ${failed} failed`)
  process.exit(1)
}
console.log('\nshell-guard-smoke: 全部通过')
