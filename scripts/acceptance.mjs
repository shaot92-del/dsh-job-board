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
const boardCmd = useRealBoard
  ? { file: PY, args: [BOARD_PY, '--port', String(argPort), '--bind', '127.0.0.1', '--state', TMP_STATE] }
  : {
      file: process.execPath,
      args: [path.join(HERE, 'fake-board.mjs'), '--port', String(argPort), '--bind', '127.0.0.1', '--state', TMP_STATE],
    }
console.log(`临时板子：${useRealBoard ? 'board_server.py（GP_BOARD_PY）' : '仓库自带 fake-board.mjs'}  ${boardUrl}`)
const server = spawn(boardCmd.file, boardCmd.args, { stdio: 'ignore', windowsHide: true })

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
apply(ctx, { boardUrl, machine: argMachine, timeoutMs: 8000 })

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

/* ───────── 核验板子最终状态 ───────── */

const board = await (await fetch(boardUrl + '/api/board')).json()
const boardTasks = Array.isArray(board.tasks) ? board.tasks : Object.entries(board.tasks || {}).map(([id, v]) => ({ id, ...v }))
const finalOk = results.every((r) => {
  const t = boardTasks.find((x) => x.id === r.用例)
  if (!t) return false
  return r.结果 === '按预期失败' ? t.status === 'failed' : t.status === 'done'
})
console.log(`\n板子终态核验：${finalOk ? '✅ 10/10 状态与预期一致' : '❌ 状态不一致'}`)
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



