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

fs.rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.log(`\nshell-guard-smoke: ${failed} failed`)
  process.exit(1)
}
console.log('\nshell-guard-smoke: 全部通过')
