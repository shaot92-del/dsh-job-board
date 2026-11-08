/**
 * _acceptance.mjs —— 10 条用例的验收矩阵，跑在临时板子上（不碰真实板子）。
 *
 * 做三件事：
 *   ① 起一个临时作业板（独立端口 + 独立 state 文件），灌 10 条合成任务
 *   ② 用插件自己的 board_* 工具走完整生命周期：认领 → 心跳 → 干活 → 交付/打回
 *   ③ 每条用例记录 用时 / 产物 sha256 / 结果，最后出一张 CSV + 控制台表
 *
 * 用法：node _acceptance.mjs [--port 8977]
 * 目前 machine 列固定 host；等 dsh-board 装到 GT14/PC2，把 --machine 换成对应机器就能出对照。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { apply } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const argPort = (() => {
  const i = process.argv.indexOf('--port')
  return i > 0 ? Number(process.argv[i + 1]) : 8977
})()
const argMachine = (() => {
  const i = process.argv.indexOf('--machine')
  return i > 0 ? process.argv[i + 1] : 'host'
})()

const PY = process.env.GP_PY || (process.platform === 'win32' ? 'python.exe' : 'python3')
const BOARD_PY = process.env.GP_BOARD_PY || ''
const WORK = process.env.GP_ACCEPT_WORK || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-')), 'accept')
const TMP_STATE = path.join(WORK, 'board-state.json')

// v1.3.3（复核 🟡7/13）：验收会把插件真正挂起来，如果它连着真实板子、又开着自动派工，
// 就会对真实任务 take/untake。所以：① 默认拒绝真板子（除非显式 --allow-live-board）；
// ② 状态目录用临时目录，绝不写 ~/.dsh/dsh-team；③ apply 时关掉自动派工。
const ALLOW_LIVE = process.argv.includes('--allow-live-board')
const STATE_DIR = path.join(WORK, 'plugin-state')
fs.mkdirSync(STATE_DIR, { recursive: true })
process.env.DSH_TEAM_STATE_DIR = STATE_DIR

// 强制走「本机没有素材」的分支（CI 用）：素材现造或跳过，不依赖跑测试的机器装了什么。
const FORCE_FIXTURES = process.env.GP_ACCEPT_FIXTURES === '1'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })

/* ───────── 10 条用例 ───────── */

const CASES = [
  {
    id: 'acc-01',
    title: 'echo 写文件并回产物',
    async run() {
      const f = path.join(WORK, 'out', 'echo.txt')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      const body = 'acceptance-echo-' + new Date().toISOString()
      fs.writeFileSync(f, body, 'utf8')
      return { ok: true, artifact: f, note: `${body.length} 字节`, sha: sha256(fs.readFileSync(f)) }
    },
  },
  {
    id: 'acc-02',
    title: '读文件取前 64 字节',
    async run() {
      // 本机有真实文件就读它；CI 上没有这个路径，临时造一个（仍是"读文件"这条链路）。
      let src = 'D:\\gp_video\\dsh-board\\package.json'
      if (FORCE_FIXTURES || !fs.existsSync(src)) {
        src = path.join(WORK, 'out', 'pkg-64.json')
        fs.mkdirSync(path.dirname(src), { recursive: true })
        fs.writeFileSync(src, JSON.stringify({ name: 'acceptance-fixture', version: '1.0.0', pad: 'x'.repeat(200) }), 'utf8')
      }
      const buf = fs.readFileSync(src).subarray(0, 64)
      return { ok: true, artifact: src + '#head64', note: buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 40), sha: sha256(buf) }
    },
  },
  {
    id: 'acc-03',
    title: '写 10 KB 文本',
    async run() {
      const f = path.join(WORK, 'out', 'ten-kb.txt')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, 'dsh-board-acceptance\n'.repeat(500), 'utf8')
      const st = fs.statSync(f)
      return { ok: true, artifact: f, note: `${st.size} 字节`, sha: sha256(fs.readFileSync(f)) }
    },
  },
  {
    id: 'acc-04',
    title: 'ffprobe 探测真实视频',
    async run() {
      let src = 'D:\\gp_video\\publish\\E04-待审-v7.mp4'
      let generated = false
      if (FORCE_FIXTURES || !fs.existsSync(src)) {
        // CI 上没有素材：用 ffmpeg 现造一个 1 秒小视频，仍然走 ffprobe 这条链路。
        src = path.join(WORK, 'out', 'probe-fixture.mp4')
        fs.mkdirSync(path.dirname(src), { recursive: true })
        const gen = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-pix_fmt', 'yuv420p', src])
        if (gen.code !== 0 || !fs.existsSync(src)) {
          return { ok: true, artifact: 'ffprobe:skip', note: '跳过：本机既没有测试视频也没有 ffmpeg', sha: sha256('skip-ffprobe') }
        }
        generated = true
      }
      const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', src])
      if (r.code !== 0) return { ok: false, note: 'ffprobe 不可用：' + r.stderr.slice(0, 80) }
      const line = r.stdout.trim()
      const [w, h, fps] = line.split(',')
      return { ok: true, artifact: src + (generated ? '#生成' : ''), note: `${w}×${h} @ ${fps}`, sha: sha256(line) }
    },
  },
  {
    id: 'acc-05',
    title: '跑 python 打印版本',
    async run() {
      const r = await run(PY, ['-c', 'import sys;print(sys.version.split()[0])'])
      if (r.code !== 0) return { ok: false, note: 'python 失败：' + r.stderr.slice(0, 80) }
      const v = r.stdout.trim()
      return { ok: true, artifact: `python:${v}`, note: v, sha: sha256(v) }
    },
  },
  {
    id: 'acc-06',
    title: '中文路径读写',
    async run() {
      const f = path.join(WORK, '中文目录', '测试文件.txt')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, '中文路径 ok\n', 'utf8')
      const back = fs.readFileSync(f, 'utf8').trim()
      return { ok: back === '中文路径 ok', artifact: f, note: back, sha: sha256(fs.readFileSync(f)) }
    },
  },
  {
    id: 'acc-07',
    title: '20 MB 大文件 sha256',
    async run() {
      const f = path.join(WORK, 'out', 'big-20mb.bin')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      const buf = crypto.randomBytes(20 * 1024 * 1024)
      fs.writeFileSync(f, buf)
      return { ok: true, artifact: f, note: `${(buf.length / 1048576).toFixed(0)} MB`, sha: sha256(buf) }
    },
  },
  {
    id: 'acc-08',
    title: '失败注入（期望被正确打回）',
    expectFail: true,
    async run() {
      const r = await run(process.execPath, ['-e', 'process.exit(3)'])
      if (r.code === 3) return { ok: false, note: `按预期失败，退出码 ${r.code}`, injected: true }
      return { ok: false, note: `退出码异常：${r.code}` }
    },
  },
  {
    id: 'acc-09',
    title: '3 秒慢任务（验证心跳续租）',
    async run() {
      await sleep(3000)
      return { ok: true, artifact: 'sleep:3000ms', note: '3 秒后交付', sha: sha256('sleep-3000') }
    },
  },
  {
    id: 'acc-10',
    title: '列目录前 20 项',
    async run() {
      // 本机有素材目录就列它，否则列本次验收的工作目录（CI 上也总有内容）。
      let dir = 'D:\\gp_video\\publish'
      if (FORCE_FIXTURES || !fs.existsSync(dir)) dir = WORK
      const list = fs.readdirSync(dir).slice(0, 20)
      return { ok: list.length > 0, artifact: dir, note: `${list.length} 项`, sha: sha256(list.join('|')) }
    },
  },
]

/* ───────── 临时板子 ───────── */

function seedState() {
  fs.mkdirSync(WORK, { recursive: true })
  const now = Date.now() / 1000
  const tasks = {}
  for (const c of CASES) {
    tasks[c.id] = {
      id: c.id,
      title: c.title,
      status: 'queued',
      machine: '',
      agent: '',
      priority: 5,
      note: '',
      created_at: now,
      updated_at: now,
      claimed_at: null,
      lease_until: null,
      progress: '',
      artifact: '',
    }
  }
  const state = { updated: Math.floor(now), tasks, machines: {}, events: [] }
  fs.writeFileSync(TMP_STATE, JSON.stringify(state, null, 2), 'utf8')
}

async function waitBoard(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url + '/api/board')
      if (res.ok) return true
    } catch {}
    await sleep(200)
  }
  return false
}

/* ───────── 主流程 ───────── */

const boardUrl = `http://127.0.0.1:${argPort}`
seedState()

// 板子实现优先用 GP_BOARD_PY 指向的真实实现；没有就用仓库自带的假板子 ——
// 这样验收在 CI（和工作区以外的新机器）上也能跑，而不是整段跳过（#10 建议 5）。
const useRealBoard = !FORCE_FIXTURES && Boolean(BOARD_PY) && fs.existsSync(BOARD_PY)
if (useRealBoard && !ALLOW_LIVE) {
  console.error('拒绝：GP_BOARD_PY 指向真实板子，验收会对真实任务认领/交付。')
  console.error('     确认是无干扰的板子后，再加 --allow-live-board；默认请用假板子（不设 GP_BOARD_PY）。')
  process.exit(2)
}
const boardCmd = useRealBoard
  ? { file: PY, args: [BOARD_PY, '--port', String(argPort), '--bind', '127.0.0.1', '--state', TMP_STATE] }
  : {
      file: process.execPath,
      args: [path.join(HERE, 'fake-board.mjs'), '--port', String(argPort), '--bind', '127.0.0.1', '--state', TMP_STATE],
    }
console.log(`临时板子：${useRealBoard ? 'board_server.py（GP_BOARD_PY）' : '仓库自带 fake-board.mjs'}  ${boardUrl}`)
const server = spawn(boardCmd.file, boardCmd.args, {
  stdio: 'ignore',
  windowsHide: true,
  // v1.3.5（复核 F11/F12）：假板子同时当 hub，nodeId 用本机 machine 名，插件才选得中。
  env: { ...process.env, GP_FAKE_NODE: argMachine },
})

if (!(await waitBoard(boardUrl))) {
  console.error('临时板子起不来，退出')
  server.kill()
  process.exit(1)
}

const tools = new Map()
const ctx = {
  tools: { register: (t) => (tools.set(t.name, t), () => {}) },
  webServer: { register: () => () => {} },
  get: () => null,
  effect: () => {},
  logger: { info() {}, warn() {}, error() {} },
}
// v1.3.3（复核 🟡7/13）：autoDispatch:false —— 验收只测工具链路，不许后台派工碰真实任务。
apply(ctx, { boardUrl, machine: argMachine, timeoutMs: 8000, autoDispatch: false })

const results = []
for (const c of CASES) {
  const t0 = Date.now()
  let row = { 用例: c.id, 标题: c.title, 机器: argMachine, 结果: '', 用时秒: 0, 产物: '', sha256: '', 说明: '' }
  try {
    const claimed = await tools.get('board_claim').execute({ task_id: c.id, minutes: 2, note: '验收矩阵' })
    if (!claimed || claimed.ok !== true) throw new Error('认领失败：' + JSON.stringify(claimed).slice(0, 80))
    await tools.get('board_beat').execute({ task_id: c.id, minutes: 5, note: '执行中' })

    const out = await c.run()
    const secs = ((Date.now() - t0) / 1000).toFixed(2)

    if (out.ok) {
      await tools.get('board_done').execute({ task_id: c.id, artifact: out.artifact || '', note: out.note || '' })
      row.结果 = '通过'
    } else {
      await tools.get('board_fail').execute({ task_id: c.id, status: 'failed', note: out.note || '用例失败' })
      row.结果 = c.expectFail && out.injected ? '按预期失败' : '失败'
    }
    row.用时秒 = secs
    row.产物 = out.artifact || ''
    row.sha256 = (out.sha || '').slice(0, 16)
    row.说明 = out.note || ''
  } catch (err) {
    row.结果 = '异常'
    row.说明 = (err && err.message) || String(err)
    row.用时秒 = ((Date.now() - t0) / 1000).toFixed(2)
  }
  results.push(row)
  const mark = row.结果 === '通过' ? '✅' : row.结果 === '按预期失败' ? '🟡' : '❌'
  console.log(`${mark} ${row.用例} ${row.标题}  ${row.用时秒}s  ${row.说明}`)
}

/* ───────── 阶段二：派工链路（v1.3.5，复核 F11/F12） ─────────
 * 前 10 条只测工具链路，派工一段「零覆盖」。这一段把自动派工真跑一遍：
 *   board_dispatch 建单（dispatch=auto） → 插件 take → hub dispatch → attach
 *   → 模拟副机完成 → syncRemote 回写 → 板上 done
 * autoDispatch 只在这次 apply 里打开，并用独立状态目录，避免与前 10 条互相干扰。
 */
{
  const t0 = Date.now()
  const prevDir = process.env.DSH_TEAM_STATE_DIR
  process.env.DSH_TEAM_STATE_DIR = path.join(WORK, 'plugin-state-dispatch')
  fs.mkdirSync(process.env.DSH_TEAM_STATE_DIR, { recursive: true })
  const tools2 = new Map()
  const ctx2 = {
    tools: { register: (t) => (tools2.set(t.name, t), () => {}) },
    webServer: { register: () => () => {}, getOrigin: () => boardUrl },
    get: () => null,
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const cleanup2 = apply(ctx2, {
    boardUrl,
    machine: argMachine,
    timeoutMs: 5000,
    writeTimeoutMs: 5000,
    autoDispatch: true,
    dispatchTickMs: 300,
    // 复核 B1：两个周期完全相同会让两个定时器落在同一 timers phase，历史上曾因共用
    // busy 闸门互相饿死；拆闸门之后仍保留一点点错峰，避免把这类 bug 藏回测试里。
    remoteSyncMs: 350,
    unknownGraceMs: 60000,
  })
  const readTask = async (id) => {
    const j = await (await fetch(boardUrl + '/api/board')).json()
    return (j.tasks || {})[id]
  }
  const row = { 用例: 'acc-11', 标题: '派工链路（take→dispatch→attach→sync→done）', 机器: argMachine, 结果: '', 用时秒: 0, 产物: '', sha256: '', 说明: '' }
  // 复核 B2：真板子模式下这条会建一条 dispatch=auto 的任务并让它跑在真机上，
  // 默认跳过；要真跑必须显式 GP_ACCEPT_ALLOW_DISPATCH=1，并自己收尾那条任务。
  const SKIP_LIVE_DISPATCH = Symbol('skip-live-dispatch')
  try {
    if (useRealBoard && process.env.GP_ACCEPT_ALLOW_DISPATCH !== '1') {
      row.结果 = '跳过'
      row.说明 = '真板子模式默认不跑派工链路（避免留下 dispatch=auto 的残留任务）；需要时设 GP_ACCEPT_ALLOW_DISPATCH=1'
      throw SKIP_LIVE_DISPATCH
    }
    // 板子只有收到 /api/caps 后才知道这台机器，而 reportCaps 是 ready 之后异步发的 ——
    // 直接建单会命中「板子上没有这台机器」。这里先等它上线。
    let machineOnline = false
    for (let i = 0; i < 40 && !machineOnline; i++) {
      const j = await (await fetch(boardUrl + '/api/board')).json()
      const m = (j.machines || {})[argMachine]
      machineOnline = Boolean(m && m.online)
      if (!machineOnline) await sleep(250)
    }
    if (!machineOnline) throw new Error('本机迟迟没在板子上线（caps 没上报）')
    const created = await tools2.get('board_dispatch').execute({ title: 'acc-11 派工链路', goal: 'acceptance: 说一句 ok', machine: argMachine, mode: 'exec' })
    if (!created || created.ok !== true) throw new Error('建单失败：' + JSON.stringify(created).slice(0, 120))
    const id = created.taskId || created.id || (created.task && created.task.id)
    if (!id) throw new Error('建单没返回任务号：' + JSON.stringify(created).slice(0, 120))
    let remoteId = ''
    for (let i = 0; i < 60 && !remoteId; i++) {
      await sleep(250)
      const t = await readTask(id)
      remoteId = String((t && t.remote_id) || '')
    }
    if (!remoteId) throw new Error('15 秒内没派出去（板上 remote_id 仍空）')
    const done = await (await fetch(boardUrl + '/api/_test/remote-complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: remoteId, status: 'completed', result: 'acceptance ok' }),
    })).json()
    if (!done || done.ok !== true) throw new Error('模拟远端完成失败：' + JSON.stringify(done).slice(0, 120))
    let status = ''
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const t = await readTask(id)
      status = String((t && t.status) || '')
      if (status === 'done') break
    }
    if (status !== 'done') throw new Error('同步回写没发生（板子 status=' + status + '）')
    // 复核 B3：done 只证明「有一条绑定上了」，证明不了「只派了一次」——
    // 重复派工会把最后一条的 remote_id 留下，前面那条成孤儿。
    const stats = await (await fetch(boardUrl + '/api/_test/stats')).json()
    if (!stats || stats.ok !== true) throw new Error('拿不到假 hub 统计：' + JSON.stringify(stats).slice(0, 120))
    if (Number(stats.dispatchCount) !== 1) throw new Error('派了 ' + stats.dispatchCount + ' 次（期望 1 次）')
    if (Number(stats.remoteCount) !== 1) throw new Error('远端留下 ' + stats.remoteCount + ' 条任务（期望 1 条）：' + String(stats.remoteIds || []).slice(0, 120))
    row.结果 = '通过'
    row.说明 = 'remote=' + remoteId + ' dispatch=1'
  } catch (err) {
    if (err === SKIP_LIVE_DISPATCH) {
      /* 跳过：row.结果 与说明已在 try 里写好 */
    } else {
      row.结果 = '失败'
      row.说明 = (err && err.message) || String(err)
    }
  } finally {
    try {
      cleanup2()
    } catch {
      /* ignore */
    }
    if (prevDir === undefined) delete process.env.DSH_TEAM_STATE_DIR
    else process.env.DSH_TEAM_STATE_DIR = prevDir
  }
  row.用时秒 = ((Date.now() - t0) / 1000).toFixed(2)
  results.push(row)
  console.log(`${row.结果 === '通过' ? '✅' : '❌'} ${row.用例} ${row.标题}  ${row.用时秒}s  ${row.说明}`)
}

/* ───────── 核验板子最终状态 ───────── */

const board = await (await fetch(boardUrl + '/api/board')).json()
const boardTasks = Array.isArray(board.tasks) ? board.tasks : Object.entries(board.tasks || {}).map(([id, v]) => ({ id, ...v }))
// acc-11 的任务号是插件生成的 bd-…，不是用例号，单独按 results 判定（它自己已经断言过板上 done）。
const terminal = results.filter((r) => r.用例 !== 'acc-11')
const finalOk = terminal.every((r) => {
  const t = boardTasks.find((x) => x.id === r.用例)
  if (!t) return false
  return r.结果 === '按预期失败' ? t.status === 'failed' : t.status === 'done'
}) && results.filter((r) => r.用例 === 'acc-11').every((r) => r.结果 === '通过' || r.结果 === '跳过')
console.log(`\n板子终态核验：${finalOk ? `✅ ${terminal.length}/${terminal.length} 状态与预期一致` : '❌ 状态不一致'}`)
console.log(`计数：${JSON.stringify(board.counts)}`)

/* ───────── 出表 ───────── */

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const csv = path.join(WORK, `验收矩阵-${argMachine}-${stamp}.csv`)
const header = '用例,标题,机器,结果,用时秒,产物,sha256前16位,说明\n'
const lines = results.map((r) => [r.用例, r.标题, r.机器, r.结果, r.用时秒, r.产物, r.sha256, String(r.说明).replace(/,/g, '，')].join(','))
fs.writeFileSync(csv, '\ufeff' + header + lines.join('\n'), 'utf8')
console.log(`报表：${csv}`)

server.kill()
const failed = results.filter((r) => r.结果 !== '通过' && r.结果 !== '按预期失败').length
process.exit(failed === 0 && finalOk ? 0 : 1)



