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
 * - 持锁进程崩了：锁文件留着，超过 staleMs 视为僵尸锁，用 rename 原子抢占。
 * - 等不到锁：返回 { ok:false, busy:true }，调用方保留内存里的墓碑，下一轮再来
 *   （绝不能"没拿到锁也照写"——那正是丢更新的老路）。
 *
 * v1.3.3（复核「withFileLock 死循环」）：这个函数是**同步**的，一旦不返回，整个
 * Host 主线程就永久卡住（派工停摆、工具挂起、连 dispose 都进不去），而且不会有
 * 任何日志。因此这里有三条硬约束：
 * 1. 任何分支都过 waitMs 预算检查 —— 包括"刚抢过僵尸锁"的 continue；
 * 2. 抢锁失败要计数，连续多次抢不掉就以 busy 返回，把决定权交回调用方；
 * 3. 函数自身**绝不抛异常**：建目录、open、fn、清理失败一律转成 { ok:false, error }。
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

const codeOf = (err) => String((err && err.code) || '')

/**
 * 抢僵尸锁：**先 rename 再删**。
 *
 * 直接 `rmSync(lockFile)` 有两个问题（v1.3.3 复核）：两个进程可能同时 rm 成功、
 * 随后都 `openSync(..., 'wx')` 成功，于是同一把锁被两个进程同时持有 —— 丢更新回来了；
 * 而且目标若是目录或被句柄占着，rm 会失败，早先的实现会在 stale 分支里无限重试。
 * rename 是原子的：只有一个进程能把它挪走，另一个会拿到 ENOENT/EPERM，自然重试。
 */
function takeOverStaleLock(lockFile) {
  const takeover = `${lockFile}.stale-${process.pid}`
  try {
    fs.renameSync(lockFile, takeover)
  } catch {
    return false
  }
  try {
    fs.rmSync(takeover, { force: true, recursive: true })
  } catch {
    /* 改回名字的文件删不掉不影响互斥：真正的位置已经空出来了 */
  }
  return true
}

/**
 * 拿跨进程锁执行 fn。**不抛异常**。
 * @returns {{ ok: true, value: any } | { ok: false, busy?: true, error?: string, why?: string }}
 */
export function withFileLock(file, fn, opts = {}) {
  const lockFile = `${file}.lock`
  const waitMs = opts.waitMs === undefined ? 400 : Math.max(0, Number(opts.waitMs) || 0)
  const staleMs = opts.staleMs === undefined ? 30000 : Math.max(1000, Number(opts.staleMs) || 30000)
  const start = Date.now()
  const outOfBudget = () => Date.now() - start >= waitMs
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch (err) {
    // v1.3.3（复核）：以前这里在 try 之外，会一路抛到 dispatchOnce 的 catch 甚至
    // dispose 里（旧定时器因此清不掉）。现在只回错误，让调用方走"本轮跳过"。
    return { ok: false, error: codeOf(err) || String(err), why: 'mkdir failed' }
  }
  let handle = null
  let stuck = 0
  let takeovers = 0
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
      const code = codeOf(err)
      // 目录占位在 Windows 上回 EEXIST、在 POSIX 上回 EISDIR；两种都按"有人占着"处理，
      // 交给下面的僵尸判定 + rename 抢占，绝不在这里抛出去。
      if (code !== 'EEXIST' && code !== 'EISDIR') {
        return { ok: false, error: code || String(err), why: 'open failed' }
      }
      // 僵尸锁：持锁进程崩了 / 机器休眠 —— 超过 staleMs 直接抢。
      let stale = false
      try {
        const st = fs.statSync(lockFile)
        if (Date.now() - st.mtimeMs > staleMs) stale = true
      } catch {
        // 刚好被别人删掉了：立刻重试，但仍要过预算（否则删-建循环里会一直转）。
        if (outOfBudget()) return { ok: false, busy: true, error: 'wait-timeout' }
        continue
      }
      if (stale) {
        if (takeOverStaleLock(lockFile)) {
          takeovers += 1
          // 抢到之后允许立刻再试一次 open（waitMs=0 时也能救回一把僵尸锁），
          // 但总次数有硬上限：两个进程反复"重建-抢占"时不能无限打转。
          if (takeovers >= 5) return { ok: false, busy: true, error: 'stale-lock-churn' }
          continue
        }
        stuck += 1
      } else {
        stuck = 0
      }
      // v1.3.3（复核 🔴1）：预算检查必须在 continue 之前 —— 以前 stale 分支绕过它，
      // 抢不掉就与 openSync 互相打转，函数永不返回。
      if (outOfBudget()) return { ok: false, busy: true, error: 'wait-timeout' }
      if (stuck >= 40) {
        // 抢不掉也不能卡死：交回 busy，调用方保留行程碑下一轮再来（并留下可查的原因）。
        return { ok: false, busy: true, error: 'stale-lock-stuck' }
      }
      sleepSync(10 + Math.floor(Math.random() * 20))
    }
  }
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    return { ok: false, error: codeOf(err) || String((err && err.message) || err), why: 'fn threw' }
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
