/**
 * lib/state-file.mjs 的隔离用例（v1.3.1）。
 *
 * 为什么要单独测：dispatch-journal 与 pending-attach 都是"读回磁盘 → 合并 → 原子写"，
 * 同一台机器上出现第二个 Host 时，两台会同时读到同一份旧盘再各写各的 —— 后写的把
 * 前一个的新增条目抹掉。跨进程锁是修这个的，但它本身也很容易写错（锁没删、僵尸锁
 * 永久卡死、拿不到锁还照写）。这里用真子进程把三种情况都跑一遍。
 *
 * 用法：node scripts/state-file-smoke.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'state-file.mjs')).href
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-statefile-'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const WORKER = `
import fs from 'node:fs'
const { withFileLock, sleepSync } = await import(process.env.MODULE_URL)
const file = process.env.STATE_FILE
const rounds = Number(process.env.ROUNDS)
for (let i = 0; i < rounds; i += 1) {
  const got = withFileLock(file, () => {
    let n = 0
    try { n = Number(JSON.parse(fs.readFileSync(file, 'utf8')).n) || 0 } catch { n = 0 }
    sleepSync(3)
    fs.writeFileSync(file, JSON.stringify({ n: n + 1 }))
    return true
  }, { waitMs: 5000, staleMs: 30000 })
  if (!got.ok) { console.error('lock busy'); process.exit(2) }
}
`

// 必须真并发：spawnSync 是串行的，测不出"两台 Host 同时读改写"这个失效面
// （变异验证时踩过一次：把锁去掉，串行跑的用例照样全绿）。
function runWorker(file, rounds) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER], {
      env: { ...process.env, MODULE_URL, STATE_FILE: file, ROUNDS: String(rounds) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (status) => resolve({ status, err }))
  })
}

async function main() {
  const { withFileLock, writeStateJson } = await import(MODULE_URL)

  // ── 1. 四个进程并发自增：一次更新都不许丢 ──
  {
    const file = path.join(TMP, 'counter.json')
    fs.writeFileSync(file, JSON.stringify({ n: 0 }))
    const procs = await Promise.all([0, 1, 2, 3].map(() => runWorker(file, 10)))
    const bad = procs.filter((p) => p.status !== 0)
    const n = JSON.parse(fs.readFileSync(file, 'utf8')).n
    check('4 进程 × 10 次并发读改写，无丢失', bad.length === 0 && n === 40, `n=${n} 失败进程=${bad.length}`)
    check('锁文件用完后被清掉', !fs.existsSync(file + '.lock'))
  }

  // ── 2. 僵尸锁（进程崩了留下的）必须能被抢占 ──
  {
    const file = path.join(TMP, 'stale.json')
    fs.writeFileSync(file, JSON.stringify([]))
    const lock = file + '.lock'
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - 600000 }))
    const old = Date.now() - 600000
    fs.utimesSync(lock, old / 1000, old / 1000)
    const t0 = Date.now()
    const got = withFileLock(file, () => { writeStateJson(file, [{ ok: 1 }]); return true }, { waitMs: 300, staleMs: 1000 })
    const cost = Date.now() - t0
    check('僵尸锁被抢占并完成写入', got.ok && JSON.parse(fs.readFileSync(file, 'utf8')).length === 1,
      `ok=${got.ok} 耗时=${cost}ms`)
    check('抢占后锁文件已清理', !fs.existsSync(lock))
  }

  // ── 3. 活锁：等不到就返回 busy，且绝不写入 ──
  {
    const file = path.join(TMP, 'busy.json')
    fs.writeFileSync(file, JSON.stringify([{ keep: 'old' }]))
    const lock = file + '.lock'
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const got = withFileLock(file, () => { writeStateJson(file, []); return true }, { waitMs: 150, staleMs: 60000 })
    const stillOld = JSON.parse(fs.readFileSync(file, 'utf8'))[0].keep === 'old'
    check('活锁等不到 → busy，不写', got.ok === false && got.busy === true, `ok=${got.ok}`)
    check('活锁期间原文件没被动过', stillOld)
    fs.rmSync(lock, { force: true })
    const after = withFileLock(file, () => { writeStateJson(file, [{ keep: 'new' }]); return true }, { waitMs: 200 })
    check('锁释放后立刻能写', after.ok && JSON.parse(fs.readFileSync(file, 'utf8'))[0].keep === 'new')
  }

  // ── 4. 原子写：临时文件不会留在目录里 ──
  {
    const file = path.join(TMP, 'atomic.json')
    writeStateJson(file, [{ a: 1 }])
    const leftovers = fs.readdirSync(TMP).filter((f) => f.includes('.tmp'))
    check('原子写没有残留 .tmp', leftovers.length === 0, leftovers.join(',') || '无')
  }

  // ── 5. 锁路径是个目录（Windows 上 rmSync 报 EISDIR、openSync 仍 EEXIST）──
  // v1.3.3（复核 🔴1）：这种形态在老实现里会让 withFileLock 无限同步自旋。
  {
    const file = path.join(TMP, 'lockisdir.json')
    fs.writeFileSync(file, JSON.stringify([{ keep: 'old' }]))
    const lock = file + '.lock'
    fs.mkdirSync(lock, { recursive: true })
    const t0 = Date.now()
    const got = withFileLock(file, () => { writeStateJson(file, [{ keep: 'new' }]); return true },
      { waitMs: 200, staleMs: 50 })
    const cost = Date.now() - t0
    check('锁是目录时也必须按时返回（不许自旋）', cost < 1500, `耗时=${cost}ms ok=${got.ok} error=${got.error || ''}`)
    check('锁是目录时不当成写入成功', got.ok !== true || JSON.parse(fs.readFileSync(file, 'utf8'))[0].keep === 'new',
      `ok=${got.ok}`)
    fs.rmSync(lock, { recursive: true, force: true })
  }

  // ── 6. 状态目录的父路径是个文件（mkdir 会 ENOTDIR/EEXIST）──
  {
    const blocker = path.join(TMP, 'blocker.txt')
    fs.writeFileSync(blocker, 'not a directory')
    const file = path.join(blocker, 'state.json')
    const t0 = Date.now()
    let threw = null
    let got = null
    try {
      got = withFileLock(file, () => true, { waitMs: 100, staleMs: 1000 })
    } catch (e) {
      threw = e
    }
    const cost = Date.now() - t0
    check('父路径是文件时不抛异常（返回错误）', threw === null, threw ? String(threw.message) : 'ok')
    check('父路径是文件时在预算内返回', cost < 1200 && got !== null, `耗时=${cost}ms ok=${got && got.ok}`)
  }

  const okCount = results.filter((r) => r.ok).length
  console.log(`\nstate-file-smoke: ${okCount}/${results.length} passed`)
  fs.rmSync(TMP, { recursive: true, force: true })
  return okCount === results.length
}

const ok = await main()
process.exit(ok ? 0 : 1)
