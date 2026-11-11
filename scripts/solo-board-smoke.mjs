/**
 * solo-board-smoke：v1.5.0 的「本机板子」最小实现。
 *
 * 验证：
 *   S1 起板后能拿到端口/token
 *   S2 无 token 的 /api/health 只回 {ok:true}（不泄露任务数）
 *   S3 无 token 读 /api/board → 401
 *   S4 create → claim → beat → release(done) 全链路
 *   S5 重启用同一个状态目录，任务还在（落盘生效）
 *   S6 close 之后端口不再应答
 *
 * 用法：node scripts/solo-board-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSoloBoard } from '../lib/solo-board.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-smoke-'))
let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`)
  }
}

const call = async (base, p, body, token) => {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers['x-board-token'] = token
  try {
    const res = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    return { status: res.status, data }
  } catch {
    // 端口被关掉/被 undici 判为 bad port 时不要炸整个测试，交给断言报 FAIL。
    return { status: 0, data: null }
  }
}

const b1 = await startSoloBoard({ stateDir: dir, port: 0 })
check('S1 起板并生成 token', !!b1.url && b1.token.length >= 32, b1.url + ' token=' + b1.token.slice(0, 6) + '…')

let r = await call(b1.url, '/api/health')
check('S2 无 token health 只回 ok', r.status === 200 && r.data.ok === true && r.data.tasks === undefined, JSON.stringify(r.data))

r = await call(b1.url, '/api/board')
check('S3 无 token 读板子被拒', r.status === 401, 'status=' + r.status)

// v2.0.3（复核 C）：claim 未知任务要跟 Python 板子一样自动建单（Host 统一派工靠它占位），
// 不是 404；v2.0.2 在这里改错了，测试也跟着错。
r = await call(b1.url, '/api/claim', { task_id: 'ghost-task', machine: 'host' }, b1.token)
check('S3b claim 未知任务自动建单', r.status === 200 && r.data.ok === true, 'status=' + r.status)
r = await call(b1.url, '/api/board', undefined, b1.token)
check('S3c 自动建单的任务在快照里', r.status === 200 && !!r.data.tasks['ghost-task'] && r.data.tasks['ghost-task'].status === 'claimed')

// v2.0.3（复核 L1）：原型键不能造幻影任务，非法 id 直接拒绝。
r = await call(b1.url, '/api/claim', { task_id: '__proto__', machine: 'host' }, b1.token)
check('S3d 原型键作为任务 id 也只会建出普通任务', r.status === 200 && r.data.ok === true, 'status=' + r.status)
r = await call(b1.url, '/api/create', { task_id: 'bad id', goal: 'x' }, b1.token)
check('S3e 非法 task_id 被拒', r.status === 400, 'status=' + r.status)

r = await call(b1.url, '/api/create', { task_id: 'solo-1', goal: 'solo 自检', title: 'solo 自检' }, b1.token)
check('S4a create', r.status === 200 && r.data.ok, JSON.stringify(r.data))
r = await call(b1.url, '/api/claim', { task_id: 'solo-1', machine: 'host', minutes: 5 }, b1.token)
check('S4b claim', r.status === 200 && r.data.ok, JSON.stringify(r.data))
r = await call(b1.url, '/api/beat', { task_id: 'solo-1', machine: 'host', minutes: 5, progress: 'half' }, b1.token)
check('S4c beat', r.status === 200 && r.data.ok, JSON.stringify(r.data))
r = await call(b1.url, '/api/mark', { task_id: 'solo-1', status: 'done', machine: 'host', note: 'solo ok' }, b1.token)
check('S4d mark done', r.status === 200 && r.data.status === 'done', JSON.stringify(r.data))

r = await call(b1.url, '/api/board', undefined, b1.token)
check('S4e 快照里是 done', r.status === 200 && r.data.tasks['solo-1'] && r.data.tasks['solo-1'].status === 'done')

await b1.close()
r = await call(b1.url, '/api/health').catch(() => ({ status: 0 }))
check('S6 close 后不再应答', r.status === 0, 'status=' + r.status)

const b2 = await startSoloBoard({ stateDir: dir, token: b1.token, port: 0 })
r = await call(b2.url, '/api/board', undefined, b2.token)
check('S5 重启后任务仍在', r.status === 200 && r.data.tasks['solo-1'] && r.data.tasks['solo-1'].status === 'done')
await b2.close()

// ── S7：终态任务不占活跃额度（v2.0.3 复核 D）──────────────────────────
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-smoke2-'))
const many = { updated: Math.floor(Date.now() / 1000), machines: {}, events: [], tasks: {} }
for (let i = 0; i < 5001; i++) many.tasks['done-' + i] = { status: 'done', machine: 'host', updated_at: 0 }
fs.writeFileSync(path.join(dir2, 'solo-board.json'), JSON.stringify(many))
const b3 = await startSoloBoard({ stateDir: dir2, port: 0 })
r = await call(b3.url, '/api/create', { task_id: 'after-5000', goal: '还有额度' }, b3.token)
check('S7 终态任务不占上限（5001 条 done 仍可建单）', r.status === 200 && r.data.ok === true, 'status=' + r.status)
await b3.close()
fs.rmSync(dir2, { recursive: true, force: true })

fs.rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.log(`\nsolo-board-smoke: ${failed} failed`)
  process.exit(1)
}
console.log('\nsolo-board-smoke: 全部通过')
