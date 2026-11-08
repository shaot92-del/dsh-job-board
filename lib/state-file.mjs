/**
 * 状态文件的小工具（v1.3.1，复核「多实例并发写」）：
 *
 * 派工日志（dispatch-journal-*.json）和待补绑表（pending-attach-*.json）都是
 * "读回磁盘 → 合并 → 原子写"。原来的原子写只保证**单次写入**不出现半个文件，
 * 挡不住两台 Host 同时"读 → 合并 → 写"：A 读到 [x]，B 读到 [x]，A 写 [x,a]，
 * B 写 [x,b] —— a 就没了。反过来，两边各自删条目也可能把对方刚清的记录写回来。
 *
 * 这里给"读-合并-写"整段加一个跨进程的文件锁（`<file>.lock`，O_EXCL 创建）：
 * - 正常情况：拿到锁 → 合并写盘 → 删锁，别人排队几十毫秒即可。
 * - 持锁进程崩了：锁文件留着，超过 staleMs 视为僵尸锁，直接抢占。
 * - 等不到锁：返回 { ok:false, busy:true }，调用方保留内存里的墓碑，下一轮再来
 *   （绝不能"没拿到锁也照写"——那正是丢更新的老路）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 同步短睡眠（只用于锁/写盘重试之间的退避，几十毫秒）。 */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 兜底自旋 */ }
  }
}

/** 原子写：同目录临时文件（带 pid，避免多实例互相踩）→ rename 覆盖。 */
export function writeStateJson(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  let lastErr = null
  // 重命名失败（Windows 上目标被短暂占用时是 EPERM）要退避重试，
  // 不退避等于"一次瞬时冲突就丢状态"。200ms 总预算，够躲开杀软/句柄释放的抖动。
  const waits = [20, 50, 100]
  for (let i = 0; i <= waits.length; i += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      lastErr = err
      if (i < waits.length) sleepSync(waits[i])
    }
  }
  try {
    fs.rmSync(tmp, { force: true })
  } catch {
    /* 临时文件清不掉不影响主流程 */
  }
  throw lastErr || new Error('rename failed')
}

/**
 * 拿跨进程锁执行 fn。
 * @returns {{ ok: true, value: any } | { ok: false, busy: true }}
 */
export function withFileLock(file, fn, opts = {}) {
  const lockFile = `${file}.lock`
  const waitMs = opts.waitMs === undefined ? 400 : Math.max(0, Number(opts.waitMs) || 0)
  const staleMs = opts.staleMs === undefined ? 30000 : Math.max(1000, Number(opts.staleMs) || 30000)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const start = Date.now()
  let handle = null
  for (;;) {
    try {
      handle = fs.openSync(lockFile, 'wx')
      try {
        fs.writeSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } catch {
        /* 锁内容只是排障线索，写不进去不影响互斥 */
      }
      break
    } catch (err) {
      if (String((err && err.code) || '') !== 'EEXIST') throw err
      // 僵尸锁：持锁进程崩了 / 机器休眠 —— 超过 staleMs 直接抢。
      let stale = false
      try {
        const st = fs.statSync(lockFile)
        if (Date.now() - st.mtimeMs > staleMs) stale = true
      } catch {
        continue // 刚好被别人删掉了，立刻重试
      }
      if (stale) {
        try {
          fs.rmSync(lockFile, { force: true })
        } catch {
          /* 抢不掉就按忙处理 */
        }
        continue
      }
      if (Date.now() - start >= waitMs) return { ok: false, busy: true }
      sleepSync(10 + Math.floor(Math.random() * 20))
    }
  }
  try {
    return { ok: true, value: fn() }
  } finally {
    try {
      fs.closeSync(handle)
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(lockFile, { force: true })
    } catch {
      /* ignore */
    }
  }
}
