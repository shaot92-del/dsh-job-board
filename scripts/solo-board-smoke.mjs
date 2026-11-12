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

// ── S8：写盘失败必须返回错误，不能 200 后丢任务（v2.0.6 复核 P1-6）────
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-smoke3-'))
fs.mkdirSync(path.join(dir3, 'solo-board.json')) // 让 rename 的目标是目录 → 必失败
const b4 = await startSoloBoard({ stateDir: dir3, port: 0 })
r = await call(b4.url, '/api/create', { task_id: 'ghost', goal: '不该被接受' }, b4.token)
check('S8 写盘失败返回 500', r.status === 500, 'status=' + r.status + ' body=' + JSON.stringify(r.data))
r = await call(b4.url, '/api/board', undefined, b4.token)
check('S8 写盘失败不在内存里留下任务', r.status === 200 && !r.data.tasks.ghost)
await b4.close()
fs.rmSync(dir3, { recursive: true, force: true })

// ── S9：同机另一个实例不能替对方 untake（v2.0.6 复核 P2-8）────────────
const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-smoke4-'))
const b5 = await startSoloBoard({ stateDir: dir4, port: 0 })
r = await call(b5.url, '/api/create', { task_id: 'u1', goal: '占位', dispatch: 'auto' }, b5.token)
r = await call(b5.url, '/api/take', { task_id: 'u1', machine: 'm1', holder: 'holder-A' }, b5.token)
check('S9 take 占位', r.status === 200 && r.data.taken === true, 'status=' + r.status)
r = await call(b5.url, '/api/untake', { task_id: 'u1', machine: 'm1', holder: 'holder-B' }, b5.token)
check('S9 别的 holder 撤不掉', r.status === 409, 'status=' + r.status + ' body=' + JSON.stringify(r.data))
r = await call(b5.url, '/api/untake', { task_id: 'u1', machine: 'm1', holder: 'holder-A' }, b5.token)
check('S9 自己的 holder 可以撤', r.status === 200 && r.data.status === 'queued', 'status=' + r.status)
await b5.close()
fs.rmSync(dir4, { recursive: true, force: true })

// S9b（v2.0.6 复审）：不带 holder 的旧客户端也应能 untake（否则面板撤不掉占位）
const dir4b = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-smoke4b-'))
const b5b = await startSoloBoard({ stateDir: dir4b, port: 0 })
await call(b5b.url, '/api/create', { task_id: 's9b', goal: '占位', dispatch: 'auto' }, b5b.token)
let rb = await call(b5b.url, '/api/take', { task_id: 's9b', machine: 'm-s9' }, b5b.token)
check('S9b 准备 take 无 holder', rb.status === 200 && rb.data.taken === true, 'status=' + rb.status)
rb = await call(b5b.url, '/api/untake', { task_id: 's9b', machine: 'm-s9' }, b5b.token)
check('S9b 不带 holder 也能 untake', rb.status === 200, 'status=' + rb.status + ' ' + JSON.stringify(rb.data).slice(0, 120))
await b5b.close()
fs.rmSync(dir4b, { recursive: true, force: true })

// ── S10：机器键 '__proto__' 不能写进 Object.prototype（P2-7）──────────
const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-solo-smoke5-'))
const b6 = await startSoloBoard({ stateDir: dir5, port: 0 })
r = await call(b6.url, '/api/caps', { machine: '__proto__', caps: { polluted: 1 } }, b6.token)
check('S10 原型键机器可写入', r.status === 200, 'status=' + r.status)
check('S10 没有污染 Object.prototype', ({}).caps === undefined && ({}).polluted === undefined)
r = await call(b6.url, '/api/create', { task_id: '__proto__', goal: '原型任务' }, b6.token)
r = await call(b6.url, '/api/board', undefined, b6.token)
check('S10 __proto__ 任务在快照里可见', r.status === 200 && Object.prototype.hasOwnProperty.call(r.data.tasks, '__proto__'))
await b6.close()
fs.rmSync(dir5, { recursive: true, force: true })

fs.rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.log(`\nsolo-board-smoke: ${failed} failed`)
  process.exit(1)
}
console.log('\nsolo-board-smoke: 全部通过')
