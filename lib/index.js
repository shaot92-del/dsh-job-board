/**
 * dsh-team —— 作业板 + 命令工具插件的 Host 半边（原 dsh-board + dsh-shell 合并）。
 *
 * 两件事：
 *   ① 给 agent 一组 board_* 工具（查板子 / 认领 / 心跳 / 交付 / 打回 / 播报）
 *   ② 给 GUI 面板一组 /api/board/ui/* 路由（面板跑在浏览器里，够不着 127.0.0.1 之外的板子）
 *
 * 板子的 HTTP 契约见 `_tools/board_server.py`：
 *   GET  /api/board    → { now, updated, machines, tasks, events, counts }
 *   POST /api/claim    { task_id, machine, agent?, note?, minutes? }
 *   POST /api/beat     { task_id, machine, minutes?, note? }
 *   POST /api/release  { task_id, machine, status, note?, artifact? }
 *   POST /api/say      { machine, text }
 */

import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerShellTools } from './shell.js'

/** 包根目录：用来定位随包发布的资源（assets/pet.png），不依赖用户机器上的绝对路径。 */
const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 装载自检日志：没有日志口子的环境里，用它确认「到底加载没加载」。 */
function defaultPetImage() {
    const bundled = path.join(PKG_DIR, 'assets', 'pet.png')
    if (fs.existsSync(bundled)) return bundled
    // 不写任何本机绝对路径：缺立绘就返回空，由路由给出可读的 404。
    return ''
  }
  
  function trace(line) {
  try {
    fs.appendFileSync(path.join(PKG_DIR, '_runtime.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

trace('module imported')

export const name = 'dsh-team'

// 不导出 Config：dsh-ffmpeg 等原生插件同样不导出，loader 直接把 patch 行里的
// config 原样传给 apply()，我们按需读取并兜默认值，避免 schema 校验这层额外风险。
// （原实现 import @deepseek-ai/schemastery 在 profile 之外的安装布局下解析不到，
//   会让整个 Host 半边 import 失败、插件静默不装载。）

const TERMINAL = new Set(['done', 'blocked', 'failed', 'superseded', 'cancelled'])

// 展示顺序：进行中 → 待办 → 卡住 → 完成/被取代
const STATUS_RANK = { running: 0, claimed: 1, queued: 2, blocked: 3, failed: 4, done: 8, superseded: 9, cancelled: 9 }
const rank = (status) => (STATUS_RANK[status] ?? 7)

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function humanAge(epochSec) {
  if (!epochSec) return '—'
  const d = Math.max(0, nowSec() - epochSec)
  if (d < 60) return `${d} 秒前`
  if (d < 3600) return `${Math.round(d / 60)} 分钟前`
  if (d < 86400) return `${(d / 3600).toFixed(1)} 小时前`
  return `${Math.round(d / 86400)} 天前`
}

function clip(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * 机器名：优先用宿主 hostname 映射，避免每台机器手填 config.machine。
 * 板子上的规范名是 host / GT14 / MB14 / PC2。
 */
const MACHINE_BY_HOSTNAME = {
  'DESKTOP-NJ6NG3V': 'host',
  'DESKTOP-2GH05S7': 'MB14',
  'DESKTOP-J1IP3OF': 'PC2',
}

function detectMachine() {
  const host = String(os.hostname() || '').trim()
  if (MACHINE_BY_HOSTNAME[host]) return MACHINE_BY_HOSTNAME[host]
  if (/GT14/i.test(host)) return 'GT14'
  return host ? host.toLowerCase() : 'host'
}

/** 日志里的配置：密钥类字段打码，别把 token 落进 _runtime.log。 */
function redactConfig(config) {
  try {
    const out = {}
    for (const k of Object.keys(config || {})) {
      out[k] = /token|secret|passw|apikey|api_key/i.test(k) ? '***' : config[k]
    }
    return JSON.stringify(out)
  } catch {
    return '(config 不可序列化)'
  }
}

export function apply(ctx, config = {}) {
  trace(`apply start pid=${process.pid} config=${redactConfig(config)}`)
  const cfg = {
    // 留空 = 自动探测（见 baseUrl）。写死 127.0.0.1 在副机上必然指错机器，
    // 而 profile 的 cordis.patch.yml 会被宿主改写、手写的 config 行会丢，所以默认值必须能自愈。
    boardUrl: config.boardUrl || '',
    machine: (config.machine || detectMachine()).toLowerCase(),
    // 桌宠立绘：面板顶部那张状态卡用它。换图只改这一项，不用动客户端。
    petImage: config.petImage || defaultPetImage(),
    token: config.token || '',
    timeoutMs: Number(config.timeoutMs) || 8000,
    // sh_* 的根目录白名单：本体工具和 agent 层工具必须读同一份，否则 agent 层拿到
    // 空数组就等于“不限制目录”（2026-10-30 复核发现的老 bug，见 #1）。
    allowedRoots: Array.isArray(config.allowedRoots) ? config.allowedRoots.filter(Boolean) : [],
    shellTimeoutMs: Number(config.shellTimeoutMs) || 120000,
    maxOutputBytes: Number(config.maxOutputBytes) || 200000,
    // Host 侧调度器：默认开。关掉就退回"只有人工认领"的旧行为。
    autoDispatch: config.autoDispatch !== false,
    // 派发时的审批策略（v1.1.2）：remote-agent 的 exec 任务默认 manual（挂起等批准），
    // 自动调度场景必须显式 auto，否则任务永远卡在 pending_approval。
    dispatchApproval: config.dispatchApproval === 'manual' ? 'manual' : 'auto',
  }
  // ── 板子地址：自动探测，不依赖配置文件（配置行会被宿主改写）─────────────
  const BOARD_CANDIDATES = [
    process.env.DSH_BOARD_URL,
    'http://DESKTOP-NJ6NG3V:8965',
    'http://192.168.3.40:8965',
    'http://127.0.0.1:8965',
  ].filter(Boolean)
  let boardBase = cfg.boardUrl ? cfg.boardUrl.replace(/\/+$/, '') : ''
  async function baseUrl() {
    if (boardBase) return boardBase
    for (const raw of BOARD_CANDIDATES) {
      const c = raw.replace(/\/+$/, '')
      try {
        const r = await fetch(`${c}/api/health`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) {
          boardBase = c
          trace(`board auto-detected ${c}`)
          return c
        }
      } catch {
        /* 试下一个候选 */
      }
    }
    boardBase = 'http://127.0.0.1:8965'
    trace(`board auto-detect failed, fallback ${boardBase}`)
    return boardBase
  }
  const endpoint = (path) => `${boardBase.replace(/\/+$/, '')}${path}`

  // ── sh_* 命令与文件工具（原 dsh-shell，合并进本包）────────────────────────
  // 副机 worker 会话默认没有 pwsh / read / write，靠这四个工具把能力补上。
  try {
    registerShellTools(ctx, {
      allowedRoots: cfg.allowedRoots,
      timeoutMs: cfg.shellTimeoutMs,
      maxOutputBytes: cfg.maxOutputBytes,
    })
    trace('shell tools registered (4)')
  } catch (err) {
    trace('shell tools register failed ' + String(err && err.message ? err.message : err))
  }

  const call = async (method, path, body) => {
    await baseUrl()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs)
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cfg.token) headers['x-board-token'] = cfg.token
    try {
      const res = await fetch(endpoint(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { raw: text.slice(0, 400) }
      }
      if (!res.ok) {
        // body 里还有板子给的细节（例如 untake 409 的 { error:'不是你占的', taker }）。
        // 以前只留 error 字符串，需要判分支的调用方就拿不到 taker/holder 了。
        return {
          ok: false,
          status: res.status,
          error: (data && (data.error || data.message)) || text.slice(0, 300) || `HTTP ${res.status}`,
          body: data && typeof data === 'object' ? data : null,
        }
      }
      return { ok: true, status: res.status, data }
    } catch (err) {
      const aborted = err && err.name === 'AbortError'
      return {
        ok: false,
        status: 0,
        error: aborted ? `板子无响应（${cfg.timeoutMs} 毫秒超时）` : String((err && err.message) || err),
        hint: '确认 board_server.py 在跑：http://127.0.0.1:8965/api/health',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ───────────── R4：身份与工作能力评估 ───────────── */

  const IDENTITY_DIR = path.join(os.homedir(), '.dsh-board')
  const IDENTITY_FILE = path.join(IDENTITY_DIR, 'identity.json')

  function readIdentity() {
    try {
      const raw = fs.readFileSync(IDENTITY_FILE, 'utf8')
      const o = JSON.parse(raw)
      if (o && typeof o === 'object' && o.machine) return o
      return null
    } catch {
      return null
    }
  }

  function saveIdentity(caps) {
    try {
      fs.mkdirSync(IDENTITY_DIR, { recursive: true })
      const rec = { machine: cfg.machine, assessedAt: Date.now(), caps: caps || null }
      fs.writeFileSync(IDENTITY_FILE, JSON.stringify(rec, null, 2), 'utf8')
      return rec
    } catch (err) {
      trace('identity save failed ' + String(err && err.message))
      return null
    }
  }

  // 初次加载后是否需要先问用户“要不要做一次环境评估”
  function identityState() {
    const rec = readIdentity()
    const same = !!(rec && String(rec.machine) === String(cfg.machine))
    return {
      machine: cfg.machine,
      assessed: same && !!rec.assessedAt,
      assessedAt: same ? rec.assessedAt : 0,
      needsAssessment: !same,
    }
  }

  /* ───────────── R4：节点配置清单 ───────────── */

  // 旧实现用 spawnSync 串行探 5 个命令，最坏阻塞 15 秒（复核报告 #17）。
  // 现在：异步 execFile + 5 路并发 + 10 分钟 TTL 缓存。
  const execFileP = promisify(execFile)
  const CAPS_PROBE_TTL = 10 * 60 * 1000
  let capsProbeCache = null

  async function probe(cmd, args) {
    try {
      const r = await execFileP(cmd, args, { timeout: 3000, windowsHide: true, encoding: 'utf8' })
      const out = String((r && r.stdout) || '')
      return out.trim().split(/\r?\n/)[0].trim()
    } catch {
      return ''
    }
  }

  async function probeVersions() {
    const t = Date.now()
    if (capsProbeCache && t - capsProbeCache.at < CAPS_PROBE_TTL) return capsProbeCache.value
    const [pwsh, ps5, ff, py, gpuLine] = await Promise.all([
      probe('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']),
      probe('powershell', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']),
      probe('ffmpeg', ['-version']),
      probe('python', ['--version']),
      probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']),
    ])
    const value = { pwsh, ps5, ff, py, gpuLine }
    capsProbeCache = { at: t, value }
    return value
  }

  async function collectCaps() {
    const cpus = os.cpus() || []
    const totalGB = +(os.totalmem() / 1073741824).toFixed(1)
    let freeGB = 0
    try {
      const st = fs.statfsSync('D:/')
      freeGB = +((st.bavail * st.bsize) / 1073741824).toFixed(1)
    } catch {
      try {
        const st = fs.statfsSync('C:/')
        freeGB = +((st.bavail * st.bsize) / 1073741824).toFixed(1)
      } catch {
        freeGB = 0
      }
    }
    const rel = String(os.release() || '')
    const build = Number(rel.split('.')[2] || '0')
    const osName = /^10\./.test(rel)
      ? 'Windows ' + (build >= 22000 ? '11' : '10') + ' (' + rel + ')'
      : os.type() + ' ' + rel
    const v = await probeVersions()
    const pwsh = v.pwsh
    const ps5 = v.ps5
    const ff = v.ff
    const py = v.py
    const gpuLine = v.gpuLine
    return {
      machine: cfg.machine,
      os: osName,
      arch: process.arch,
      cpu: (cpus[0] && cpus[0].model ? cpus[0].model : '').replace(/\s+/g, ' ').trim(),
      cores: cpus.length,
      memGB: totalGB,
      freeDiskGB: freeGB,
      node: process.version,
      features: {
        shell: !!pwsh || !!ps5,
        pwsh: pwsh,
        powershell: ps5,
        ffmpeg: (ff.match(/ffmpeg version (\S+)/) || [])[1] || '',
        python: (py.match(/Python ([\d.]+)/) || [])[1] || '',
        gpu: gpuLine,
        board: true,
      },
      at: Date.now(),
    }
  }

  let capsCache = null
  async function reportCaps(opts) {
    try {
      const force = !!(opts && opts.force)
      if (!force && !identityState().assessed) {
        trace('caps skip: 本机尚未确认身份/评估')
        return { ok: false, skipped: true, reason: 'needs-assessment' }
      }
      const caps = await collectCaps()
      capsCache = caps
      const res = await call('POST', '/api/caps', { machine: cfg.machine, caps: caps })
      if (force) saveIdentity(caps)
      trace('caps reported ok=' + res.ok + ' machine=' + cfg.machine + ' shell=' + caps.features.shell + (force ? ' (assessed)' : ''))
      return Object.assign({ caps: caps }, res)
    } catch (err) {
      trace('caps report failed ' + String(err && err.message))
      return { ok: false, error: String(err && err.message) }
    }
  }

  /* ───────────── 实时指标（内存/CPU/磁盘/运行时长） ───────────── */

  let livePrev = null

  function collectLive() {
    const total = os.totalmem()
    const free = os.freemem()
    const cpus = os.cpus() || []
    let idle = 0
    let busy = 0
    for (const c of cpus) {
      if (!c || !c.times) continue
      idle += c.times.idle || 0
      busy += (c.times.user || 0) + (c.times.nice || 0) + (c.times.sys || 0)
    }
    let cpuPct = -1
    if (livePrev) {
      const dIdle = idle - livePrev.idle
      const dBusy = busy - livePrev.busy
      const dTot = dIdle + dBusy
      if (dTot > 0) cpuPct = Math.max(0, Math.min(100, Math.round((dBusy / dTot) * 100)))
    }
    livePrev = { idle: idle, busy: busy }
    let freeDiskGB = 0
    let diskTotalGB = 0
    for (const root of ['D:/', 'C:/']) {
      try {
        const st = fs.statfsSync(root)
        freeDiskGB = +((st.bavail * st.bsize) / 1073741824).toFixed(1)
        diskTotalGB = +((st.blocks * st.bsize) / 1073741824).toFixed(1)
        break
      } catch {
        continue
      }
    }
    return {
      memUsedGB: +((total - free) / 1073741824).toFixed(1),
      memTotalGB: +(total / 1073741824).toFixed(1),
      memPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
      cpuPct: cpuPct,
      cores: cpus.length,
      freeDiskGB: freeDiskGB,
      diskTotalGB: diskTotalGB,
      diskPct: diskTotalGB > 0 ? Math.round(((diskTotalGB - freeDiskGB) / diskTotalGB) * 100) : 0,
      uptimeH: +(os.uptime() / 3600).toFixed(1),
      load1: +(os.loadavg()[0] || 0).toFixed(2),
      at: Date.now(),
    }
  }

  async function reportLive() {
    try {
      if (!identityState().assessed) return { ok: false, skipped: true }
      const live = collectLive()
      const res = await call('POST', '/api/metrics', { machine: cfg.machine, live: live })
      return Object.assign({ live: live }, res)
    } catch (err) {
      trace('metrics failed ' + String(err && err.message))
      return { ok: false, error: String(err && err.message) }
    }
  }

  async function assess(force) {
    const rec = readIdentity()
    const before = rec && rec.caps ? rec.caps : null
    const out = await reportCaps({ force: true })
    const after = out && out.caps ? out.caps : null
    const diff = []
    if (before && after) {
      const bf = before.features || {}
      const af = after.features || {}
      for (const k of Object.keys(af)) {
        if (String(bf[k] || '') !== String(af[k] || '')) diff.push(k + ': ' + (String(bf[k] || '无')).slice(0, 24) + ' → ' + String(af[k] || '无').slice(0, 24))
      }
      for (const k of ['cores', 'memGB', 'cpu', 'os', 'arch']) {
        if (String(before[k] || '') !== String(after[k] || '')) diff.push(k + ': ' + before[k] + ' → ' + after[k])
      }
    }
    return {
      ok: !!out.ok,
      machine: cfg.machine,
      firstTime: !before,
      changed: diff,
      caps: after,
      summary: (before ? '已重新评估 ' : '首次评估完成 ') + cfg.machine + '；' + (diff.length ? '变化 ' + diff.length + ' 项：' + diff.join('；') : '与上次一致') + (out.ok ? '' : '（上报失败：' + (out.error || 'unknown') + '）'),
    }
  }

  /* ───────────── 快照：给工具和面板共用 ───────────── */

  async function snapshot(limit = 40) {
    const res = await call('GET', '/api/board')
    if (!res.ok) return { ok: false, error: res.error, hint: res.hint }
    const d = res.data || {}
    const counts = d.counts || {}
    // 板子的 machines / tasks 都是「字典」（id → 对象），不是数组
    const machinesObj = d.machines && typeof d.machines === 'object' ? d.machines : {}
    const machines = Object.keys(machinesObj).map((id) => Object.assign({ id }, machinesObj[id]))
    const tasksObj = d.tasks && typeof d.tasks === 'object' ? d.tasks : {}
    const tasks = Object.keys(tasksObj).map((id) => Object.assign({ id }, tasksObj[id]))
    const age = d.updated ? Math.max(0, nowSec() - d.updated) : null
    return {
      ok: true,
      board: boardBase || '(auto)',
      updatedAgeSec: age,
      updatedText: humanAge(d.updated),
      counts: {
        queued: counts.queued || 0,
        running: (counts.claimed || 0) + (counts.running || 0),
        done: counts.done || 0,
        bad: (counts.blocked || 0) + (counts.failed || 0),
        stale: counts.stale || 0,
      },
      machines: machines.map((m) => ({
        id: m.id,
        online: !!m.online,
        status: m.status || '',
        current: m.current || '',
        lastSeen: humanAge(m.last_seen),
        caps: m.caps && typeof m.caps === 'object' ? m.caps : null,
        capsAt: m.caps_at || 0,
        live: m.live && typeof m.live === 'object' ? m.live : null,
        liveAt: m.live_at || 0,
      })),
      tasks: tasks
        .slice()
        .sort((a, b) => rank(a.status) - rank(b.status) || (b.updated_at || 0) - (a.updated_at || 0))
        .slice(0, limit > 0 ? limit : Number.MAX_SAFE_INTEGER)
        .map((t) => ({
          id: t.id,
          // 板子上确实存了 title（board_server.py: "title": title or goal[:60]）。
          // 之前这里用 note 顶替 title，导致没备注的任务恒显示"(无标题)"、备注被当标题重复显示。
          title: clip(t.title || t.note || t.artifact || '', 80),
          status: t.status || 'queued',
          machine: t.machine || '',
          agent: t.agent || '',
          priority: t.priority ?? 5,
          progress: t.progress || 0,
          note: clip(t.note || '', 120),
          artifact: clip(t.artifact || '', 120),
          // 派工要用原文（板子允许 300 字）；只裁给工具看的那份会污染真正发给副机的 goal。
          goal: String(t.goal || ''),
          dispatch: t.dispatch || '',
          mode: t.mode || '',
          workspace: String(t.workspace || ''),
          taker: String(t.taker || ''),
          remote: t.remote_id || '',
          updated: humanAge(t.updated_at),
          // 只读补充：「已完成」视图要按完成时间倒序排，而 updated 给人看的
          // "3 分钟前"没法排序。这里带上原始 epoch，不影响任何写路径。
          updatedAt: t.updated_at || 0,
          claimable: (t.status || 'queued') === 'queued' && !t.machine,
        })),
      events: (Array.isArray(d.events) ? d.events : [])
        .slice(-8)
        .reverse()
        .map((e) => `${humanAge(e.t)} · ${e.machine || '—'} · ${e.kind || ''}${e.task ? ` · ${e.task}` : ''}${e.text ? ` · ${clip(e.text, 80)}` : ''}`),
    }
  }

  /* ───────────── Host 侧统一派工（复核报告 #6） ───────────── */
  // 原先派发和终态回写都在浏览器里：关掉页面就停、开两个页面就重复派、
  // mark 的读改写也不原子。现在 Host 自己当调度器，浏览器只负责建单和展示。

  const DISPATCH_TICK_MS = 4000
  const REMOTE_SYNC_MS = 6000
  const dispatchState = { busy: false, lastError: '', dispatched: 0, synced: 0, pausedUntil: 0 }
  // 复核 #7：热重载/卸载后旧实例的异步循环还会接着跑，dispose 里只清定时器不够。
  let disposed = false
  // 复核 #4：/dispatch 已经成功、/api/attach 失败时先把绑定记在这张表里，
  // 下一轮 tick 重试同一次 attach（不能重新 dispatch，否则远程任务会重复执行）。
  const pendingAttach = new Map()

  function remoteUiBase() {
    try {
      const ws = ctx.webServer
      const origin = typeof ws?.getOrigin === 'function' ? ws.getOrigin() : ''
      if (typeof origin === 'string' && origin) return origin.replace(/\/+$/, '')
    } catch {
      /* listen 完成前 getOrigin() 会抛 */
    }
    return ''
  }

  // 宿主的 Web 接口在浏览器鉴权围栏后面：remote-agent 的 UI 路由每请求都问
  // connection.requestRejection()，后台进程直接 fetch 一定 401（v1.1.0 就卡在这）。
  // connection.authenticatedUrl() 能把本进程的 launch token 拼进 URL，访问一次就会
  // 种下会话 cookie —— 之后照常带 cookie 请求即可，不需要伪造任何凭据。
  let sessionCookie = ''
  let sessionCookieAt = 0
  // 兜底：面板请求进来时顺手记下浏览器带的 cookie，换不到会话时就用它。
  let browserCookie = ''
  const SESSION_COOKIE_TTL = 10 * 60 * 1000

  async function ensureSessionCookie(force) {
    if (!force && sessionCookie && Date.now() - sessionCookieAt < SESSION_COOKIE_TTL) return sessionCookie
    const base = remoteUiBase()
    if (!base) return ''
    let connection
    try {
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      connection = undefined
    }
    if (typeof connection?.authenticatedUrl !== 'function') {
      trace('web session: connection.authenticatedUrl 不可用，无法换 cookie')
      return sessionCookie
    }
    try {
      const url = connection.authenticatedUrl(base + '/')
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) })
      const hdrs = res && res.headers
      const raw = hdrs && typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : []
      const single = hdrs && typeof hdrs.get === 'function' ? hdrs.get('set-cookie') : ''
      const list = raw.length ? raw : [single || '']
      const cookie = list.map((c) => String(c || '').split(';')[0].trim()).filter(Boolean).join('; ')
      if (cookie) {
        sessionCookie = cookie
        sessionCookieAt = Date.now()
        trace('web session: cookie acquired (status ' + res.status + ')')
      } else {
        trace('web session: no set-cookie (status ' + res.status + ')')
      }
    } catch (err) {
      trace('web session: mint failed ' + String((err && err.message) || err))
    }
    if (!sessionCookie && browserCookie) {
      sessionCookie = browserCookie
      sessionCookieAt = Date.now()
      trace('web session: 用面板请求带来的 cookie 兜底')
    }
    return sessionCookie
  }

  async function remoteUi(pathname, payload, retried) {
    const base = remoteUiBase()
    if (!base) return { ok: false, error: 'webServer.getOrigin() 不可用（Host 还没 listen）' }
    const cookie = await ensureSessionCookie()
    const headers = payload
      ? { 'content-type': 'application/json', accept: 'application/json' }
      : { accept: 'application/json' }
    if (cookie) headers.cookie = cookie
    try {
      const res = await fetch(base + '/api/remote-agent/ui' + pathname, {
        method: payload ? 'POST' : 'GET',
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
      if (res.status === 401 && !retried) {
        await ensureSessionCookie(true)
        return remoteUi(pathname, payload, true)
      }
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        return { ok: false, status: res.status, error: (data && (data.error || data.message)) || 'HTTP ' + res.status, data }
      }
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  /**
   * 把 remote-agent 的 nodeId 折成板子上的机器名：nodeId 通常是 Windows 计算机名
   * （desktop2gh05s7），板子用别名（MB14），两边靠 MACHINE_BY_HOSTNAME 对齐。
   */
  function nodeMachine(node) {
    const id = String((node && node.nodeId) || '')
    if (!id) return ''
    const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '')
    for (const host of Object.keys(MACHINE_BY_HOSTNAME)) {
      if (host.toUpperCase().replace(/[^A-Z0-9]/g, '') === key) return String(MACHINE_BY_HOSTNAME[host]).toLowerCase()
    }
    return id.toLowerCase()
  }

  /** 板子上的机器名大小写固定（host / GT14 / MB14 / PC2），回执时折回规范写法。 */
  function boardMachineName(name) {
    const key = String(name || '').toLowerCase()
    if (key === 'gt14') return 'GT14'
    if (key === 'mb14') return 'MB14'
    if (key === 'pc2') return 'PC2'
    if (key === 'host') return 'host'
    return name
  }

  let nodesToldOnce = false
  let lastNoNodeTrace = 0

  /** 把一个可能是 nodeId、也可能是板子别名的字符串，折成板子机器名（小写）。 */
  function machineAlias(name) {
    const raw = String(name || '').trim()
    return raw ? nodeMachine({ nodeId: raw }) : ''
  }

  /**
   * 按机器名找副机。machine 既可能是 nodeId（desktop-2gh05s7）也可能是板子别名
   * （MB14），两边都归一后再比（复核 #3：以前只归一 node 一侧，任务里写原始
   * nodeId 或写别名都可能选不中）。
   * 任务没指定机器时，在多台在线副机里挑"在跑任务最少"的那台（复核 #2：以前
   * 只在恰好一台在线时兜底，两台在线时自动派工永远留在 queued）。
   */
  function pickNode(online, machine, load) {
    if (!nodesToldOnce && online.length) {
      nodesToldOnce = true
      trace('remote nodes: ' + online.map((n) => String(n.nodeId) + '→' + nodeMachine(n)).join(', '))
    }
    const want = machineAlias(machine)
    if (want) {
      for (const n of online) {
        if (nodeMachine(n) === want) return n
      }
      return null
    }
    const others = online.filter((n) => nodeMachine(n) !== String(cfg.machine || '').toLowerCase())
    if (!others.length) return null
    const loadOf = (n) => {
      const k = nodeMachine(n)
      const v = load && typeof load.get === 'function' ? load.get(k) : 0
      return Number.isFinite(v) ? v : 0
    }
    return others
      .slice()
      .sort((a, b) => loadOf(a) - loadOf(b) || String(a.nodeId).localeCompare(String(b.nodeId)))[0]
  }

  // 复核 #4（v1.1.8）：待回绑记录不能只活在内存里 —— 热重载/dispose 之后新实例就拿不到
  // "板子任务号 → 远程任务号"的映射，板上那条会永远卡在 claimed、远程任务也再没人跟踪。
  // 落到用户级状态文件，apply 时读回，由 retryPendingAttach() 补绑（只补绑，绝不重派）。
  const PENDING_ATTACH_FILE = path.join(os.homedir(), '.dsh', 'dsh-team', 'pending-attach.json')
  const PENDING_ATTACH_TTL_MS = 6 * 60 * 60 * 1000

  function loadPendingAttach() {
    try {
      const raw = fs.readFileSync(PENDING_ATTACH_FILE, 'utf8')
      const rows = JSON.parse(raw)
      const now = Date.now()
      let n = 0
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || !r.taskId || !r.remoteId) continue
        // 超过 TTL 的记录不再补绑：远程任务早结束了，再 attach 只会写脏数据。
        if (now - Number(r.at || 0) > PENDING_ATTACH_TTL_MS) continue
        pendingAttach.set(String(r.taskId), {
          remoteId: String(r.remoteId),
          machine: String(r.machine || ''),
          tries: Number(r.tries || 0),
          at: Number(r.at || now),
        })
        n += 1
      }
      if (n) trace('pending attach restored: ' + n + ' 条待补绑')
    } catch {
      // 文件不存在 / 内容坏掉都不影响主流程：当作没有待补绑记录
    }
  }

  function savePendingAttach() {
    try {
      const rows = Array.from(pendingAttach.entries()).map(([taskId, v]) => ({
        taskId,
        remoteId: v.remoteId,
        machine: v.machine,
        tries: v.tries || 0,
        at: v.at || Date.now(),
      }))
      fs.mkdirSync(path.dirname(PENDING_ATTACH_FILE), { recursive: true })
      fs.writeFileSync(PENDING_ATTACH_FILE, JSON.stringify(rows, null, 2), 'utf8')
    } catch (err) {
      trace('pending attach save failed: ' + String((err && err.message) || err))
    }
  }

  loadPendingAttach()

  /** 回绑板子；失败就把"板子任务号 → 远程任务号"记下来，下一轮重试（复核 #4）。 */
  async function attachTask(taskId, remoteId, machineName) {
    const out = await call('POST', '/api/attach', { task_id: taskId, remote_id: remoteId, machine: machineName })
    if (out.ok) {
      pendingAttach.delete(taskId)
      savePendingAttach()
      return out
    }
    const prev = pendingAttach.get(taskId)
    pendingAttach.set(taskId, {
      remoteId,
      machine: machineName,
      tries: ((prev && prev.tries) || 0) + 1,
      // at 只记第一次失败的时间：TTL 从"开始等补绑"算，不在重试时刷新
      at: (prev && prev.at) || Date.now(),
    })
    savePendingAttach()
    return out
  }

  /** 重试上一轮没绑上的 attach —— 只重试 attach，绝不重新 dispatch（否则远程会跑两遍）。 */
  async function retryPendingAttach() {
    if (!pendingAttach.size) return
    for (const [taskId, info] of Array.from(pendingAttach.entries())) {
      if (disposed) return
      const out = await attachTask(taskId, info.remoteId, info.machine)
      if (out.ok) {
        dispatchState.dispatched += 1
        trace('attach retried ok ' + taskId + ' remote=' + info.remoteId)
      } else {
        const n = (pendingAttach.get(taskId) || {}).tries || 1
        if (n % 5 === 1) trace('attach retry ' + taskId + ' #' + n + ' 仍未成功: ' + (out.error || out.status))
      }
    }
  }

  async function dispatchOnce() {
    if (disposed || dispatchState.busy) return 0
    // 面板清理期间暂停认领：清理是"读快照 → 逐条归档"，这几秒里若调度器把某条
    // queued 任务 take 走并派到副机，随后的 release 会把正在跑的任务作废。
    // pausedUntil 由 /api/board/ui/dispatch-pause 设置，且有上限、会自然过期。
    if (Date.now() < dispatchState.pausedUntil) return 0
    dispatchState.busy = true
    let launched = 0
    try {
      await retryPendingAttach()
      if (disposed) return launched
      const snap = await snapshot(0)
      if (!snap.ok) return 0
      if (disposed) return launched
      const queue = snap.tasks.filter((t) => t.dispatch === 'auto' && (t.status === 'queued' || t.status === 'stale'))
      if (!queue.length) return 0
      // 板子上 running 的任务数就是"这台机器在跑几条"，自动派工按它挑最闲的。
      const load = new Map()
      for (const t of snap.tasks) {
        if (t.status !== 'running' || !t.machine) continue
        const k = machineAlias(t.machine)
        if (k) load.set(k, (load.get(k) || 0) + 1)
      }
      const nodesRes = await remoteUi('/nodes')
      if (disposed) return launched
      const nodes = nodesRes.ok && nodesRes.data && Array.isArray(nodesRes.data.nodes) ? nodesRes.data.nodes : []
      if (!nodes.length) return 0
      const online = nodes.filter((n) => n && n.online !== false)
      for (const t of queue) {
        if (disposed) break
        const node = pickNode(online, t.machine, load)
        if (!node) {
          if (Date.now() - lastNoNodeTrace > 60000) {
            lastNoNodeTrace = Date.now()
            trace('dispatch skip ' + t.id + ': 没有匹配的在线节点（要 ' + (t.machine || '任意') + '）')
          }
          continue
        }
        const target = String(node.nodeId || '')
        // 认领/回执写板子时要用**机器名**（mb14），不是 nodeId（desktop-2gh05s7）——
        // 否则看板的 machine 列会被 nodeId 覆盖，和 /api/boot 上报的 MB14 对不上。
        const machineName = boardMachineName(nodeMachine(node) || target)
        const take = await call('POST', '/api/take', { task_id: t.id, machine: cfg.machine, minutes: 10 })
        if (!take.ok) {
          trace('take skip ' + t.id + ': ' + (take.error || take.status))
          continue
        }
        if (disposed) {
          // 已经认领但插件被卸载：把板子上的占位放掉，别留一条永远 running 的任务。
          await call('POST', '/api/untake', { task_id: t.id, machine: cfg.machine, note: '插件已卸载，未派发' }).catch(() => {})
          break
        }
        const sent = await remoteUi('/dispatch', {
          goal: t.goal || t.title || '',
          node: target,
          mode: t.mode === 'exec' ? 'exec' : 'agent',
          // 复核 #21（v1.1.2）：remote-agent 对 exec 任务的默认审批是 manual ——
          // 不显式传 auto 的话，命令任务会静默挂在 pending_approval 等 30 分钟，
          // 板上却显示 running（syncRemote 只认终态）。默认 auto，可用
          // config.dispatchApproval: 'manual' 改回人工审批。
          approval: cfg.dispatchApproval,
          workspace: t.workspace || undefined,
        })
        if (!sent.ok) {
          dispatchState.lastError = String(sent.error || 'dispatch failed')
          await call('POST', '/api/untake', { task_id: t.id, machine: cfg.machine, note: '派发失败：' + dispatchState.lastError })
          trace('dispatch failed ' + t.id + ': ' + dispatchState.lastError)
          continue
        }
        const taskId = String((sent.data && sent.data.taskId) || '')
        if (!taskId) {
          // 远程说成功但没给 taskId，等于没派出：放掉占位，下一轮重来。
          dispatchState.lastError = 'dispatch 没有返回 taskId'
          await call('POST', '/api/untake', { task_id: t.id, machine: cfg.machine, note: '派发失败：远程没有返回 taskId' })
          trace('dispatch failed ' + t.id + ': 远程没有返回 taskId')
          continue
        }
        // 复核 #2（v1.1.8）：本轮派出成功后立刻把负载记到这台上。load 只按轮询开始时的
        // 快照算过一次，不在这里回加的话，同一轮的多条自动任务会全压到第一台机器。
        const loadKey = machineAlias(machineName) || machineAlias(target)
        if (loadKey) load.set(loadKey, (load.get(loadKey) || 0) + 1)
        const attached = await attachTask(t.id, taskId, machineName)
        if (attached.ok) {
          dispatchState.dispatched += 1
          launched += 1
          trace('dispatched ' + t.id + ' → ' + target + ' remote=' + taskId)
        } else {
          // 复核 #4：远程已经在跑了，只是回绑失败 —— 记下来下轮只重试 attach。
          dispatchState.lastError = 'attach 失败：' + String(attached.error || attached.status)
          trace('attach failed ' + t.id + ' remote=' + taskId + '（下一轮重试回绑）: ' + String(attached.error || attached.status))
        }
      }
    } catch (err) {
      dispatchState.lastError = String((err && err.message) || err)
      trace('dispatch loop error ' + dispatchState.lastError)
    } finally {
      dispatchState.busy = false
    }
    return launched
  }

  // 终态不止 completed/failed：aborted/interrupted/rejected 也是结束，
  // 旧前端只认前两个，这些任务永远停在 running（复核报告漏掉的一半）。
  const REMOTE_FINAL = { completed: 'done', failed: 'failed', aborted: 'failed', interrupted: 'failed', rejected: 'failed' }
  // 已在板上标注过"等待审批"的任务（避免每 6 秒重复写一次 note）。
  const pendingNoted = new Set()

  async function syncRemote() {
    if (disposed || dispatchState.busy) return 0
    dispatchState.busy = true
    let changed = 0
    try {
      const snap = await snapshot(0)
      // 复核 #7（v1.1.8）：dispose 之后旧实例的 await 还会回来 —— 每次等待回来都要
      // 重新确认自己还活着，否则卸载瞬间挂起的请求返回后照样往板子上写。
      if (disposed) return 0
      if (!snap.ok) return 0
      const watched = snap.tasks.filter((t) => t.remote && (t.status === 'running' || t.status === 'claimed' || t.status === 'stale'))
      if (!watched.length) return 0
      const res = await remoteUi('/tasks')
      if (disposed) return 0
      const list = res.ok && res.data && Array.isArray(res.data.tasks) ? res.data.tasks : []
      if (!list.length) return 0
      const byId = new Map(list.map((x) => [String(x.taskId || ''), x]))
      for (const t of watched) {
        if (disposed) break
        const r = byId.get(String(t.remote))
        if (!r) continue
        const st = String(r.status || '')
        // 副机在等审批（remote-agent 对 exec 默认 manual）：板上标一次，别让
        // 用户看着 running 猜为什么没动静。
        if (st === 'pending_approval') {
          if (!pendingNoted.has(t.id)) {
            // 复核 #6：只有写成功才记"已标注"，否则一次网络抖动就会让这条任务
            // 永远不再尝试写 note（板上永远看不出它在等审批）。
            const noted = await call('POST', '/api/mark', {
              task_id: t.id,
              note: '等待副机审批（remote-agent 的 exec 任务默认 manual；给 Host 调度器配 dispatchApproval=auto 可跳过）',
            })
            if (noted.ok) {
              pendingNoted.add(t.id)
              trace('remote task pending approval ' + t.id + ' remote=' + t.remote)
            } else {
              trace('pending approval note failed ' + t.id + ': ' + (noted.error || noted.status))
            }
          }
          continue
        }
        const final = REMOTE_FINAL[st]
        if (!final) continue
        // v1.1.3：把副机最后一条 stdout 带进 note —— 板上直接能看到命令输出，
        // 不用再去共享盘翻任务 JSON。没有 stdout 就退回错误/摘要。
        const logs = Array.isArray(r.logs) ? r.logs : []
        let lastOut = ''
        for (let i = logs.length - 1; i >= 0; i -= 1) {
          const line = String((logs[i] && logs[i].line) || '')
          if (line.startsWith('[stdout] ')) { lastOut = line.slice(9).trim(); break }
        }
        const errText = typeof r.error === 'string'
          ? r.error
          : (r.error && (r.error.message || r.error.code)) || ''
        const detail = String(errText || lastOut || r.summaryText || r.summary || r.message || '').slice(0, 200)
        const note = '远程 ' + st + (detail ? '：' + detail : '')
        const marked = await call('POST', '/api/mark', { task_id: t.id, status: final, note: note, remote_id: t.remote })
        if (marked.ok) {
          changed += 1
          dispatchState.synced += 1
        }
      }
    } catch (err) {
      trace('remote sync error ' + String((err && err.message) || err))
    } finally {
      dispatchState.busy = false
    }
    return changed
  }

  /* ───────────── 工具 ───────────── */

  const tools = [
    {
      name: 'board_metrics',
      description: '看各机器的实时指标：内存占用、CPU、磁盘余量、运行时长。不传 machine 就全部。',
      parameters: {
        type: 'object',
        properties: { machine: { type: 'string', description: '机器名，如 GT14；不传返回全部' } },
      },
      output: { schema: { type: 'object' }, render: null },
      execute: async (args) => {
        const s2 = await snapshot()
        if (!s2.ok) return { ok: false, error: s2.error || '板子不可达', hint: s2.hint }
        const want = args && args.machine ? String(args.machine).toLowerCase() : ''
        const rows = (s2.machines || [])
          .filter((m) => !want || String(m.id).toLowerCase() === want)
          .map((m) => ({ machine: m.id, online: !!m.online, live: m.live || null, liveAt: m.liveAt || 0 }))
        return {
          ok: true,
          machines: rows,
          summary: rows.length
            ? rows.map((r) => '· ' + r.machine + (r.live ? ' 内存 ' + r.live.memUsedGB + '/' + r.live.memTotalGB + 'G (' + r.live.memPct + '%) CPU ' + (r.live.cpuPct >= 0 ? r.live.cpuPct + '%' : '测量中') + ' 磁盘余 ' + r.live.freeDiskGB + 'G 开机 ' + r.live.uptimeH + 'h' : ' 无实时数据')).join('\n')
            : '没有匹配的机器',
        }
      },
    },
    {
      name: 'board_assess',
      description: '本机工作能力评估（R4）：测 CPU/内存/磁盘/系统/pwsh/powershell/ffmpeg/python/GPU，写身份文件并上报作业板。force=true 时无论是否评估过都重测（配置变了用它）。',
      parameters: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: '强制重新评估（默认 false：只返回当前评估状态）' },
        },
      },
      output: { schema: { type: 'object' }, render: null },
      execute: async (args) => {
        if (!args || args.force) return await assess(true)
        const st = identityState()
        const rec = readIdentity()
        return {
          ok: true,
          machine: st.machine,
          assessed: st.assessed,
          assessedAt: st.assessedAt,
          needsAssessment: st.needsAssessment,
          caps: rec && rec.caps ? rec.caps : null,
          summary: st.assessed ? st.machine + ' 已于 ' + new Date(st.assessedAt).toLocaleString() + ' 评估过；要重测请传 force=true' : st.machine + ' 还没做过工作能力评估',
        }
      },
    },
    {
      name: 'board_caps',
      description: '看某台电脑上报的工作能力清单（配置清单）。不传 machine 就返回全部机器。',
      parameters: {
        type: 'object',
        properties: { machine: { type: 'string', description: '机器名，如 GT14；不传返回全部' } },
      },
      output: { schema: { type: 'object' }, render: null },
      execute: async (args) => {
        const s2 = await snapshot()
        if (!s2.ok) return { ok: false, error: s2.error || '板子不可达', hint: s2.hint }
        const want = args && args.machine ? String(args.machine).toLowerCase() : ''
        const rows = (s2.machines || [])
          .filter((m) => !want || String(m.id).toLowerCase() === want)
          .map((m) => ({
            machine: m.id,
            online: !!m.online,
            reported: !!m.caps,
            capsAt: m.capsAt || 0,
            os: m.caps ? m.caps.os : '',
            cores: m.caps ? m.caps.cores : 0,
            memGB: m.caps ? m.caps.memGB : 0,
            freeDiskGB: m.caps ? m.caps.freeDiskGB : 0,
            features: m.caps ? m.caps.features : null,
          }))
        return {
          ok: true,
          machines: rows,
          summary: rows.length
            ? rows.map((r) => '· ' + r.machine + ' ' + (r.reported ? (r.online ? '在线' : '离线') + ' ' + r.os + ' ' + r.cores + 'C/' + r.memGB + 'G' : '未上报配置')).join('\n')
            : '没有匹配的机器',
        }
      },
    },
  {
    name: 'board_dispatch',
    description:
      '主控对话自动派工：按板子数据选一台在线副机、建一条板子任务，并给出给 remote_task 的派发参数。'
      + '选机规则：显式 machine 优先；否则在「在线且不是 host」的机器里挑在跑任务最少的那台。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '任务目标（给副机 agent 的任务书，或 exec 模式下的命令）' },
        machine: { type: 'string', description: '指定机器（GT14 / MB14 / PC2）；省略则自动选最闲的' },
        title: { type: 'string', description: '板子上显示的短标题，省略取 goal 前 60 字' },
        mode: { type: 'string', enum: ['agent', 'exec'], description: 'agent=副机起独立会话（默认）；exec=直接跑命令' },
        workspace: { type: 'string', description: '副机上的工作区绝对路径（可选）' },
        note: { type: 'string', description: '板子备注（可选）' },
        requires: {
          type: 'array',
          items: { type: 'string' },
          description: '能力要求（R4）：如 shell / ffmpeg / python / gpu / pwsh。只有上报了这些能力的机器才会被选中',
        },
        dryRun: { type: 'boolean', description: '只预览选机与派发参数，不建单' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const goal = String(args.goal || '').trim()
      if (!goal) return { ok: false, error: 'goal 必填' }
      // v1.1.3：板子那边是 goal[:300] 截断（board_server.py），exec 命令被截成半句
      // 会直接跑挂、报一串看不懂的 ParserError。宁可在这里拦下，把字数与出路讲清楚。
      if (goal.length > 300) {
        return {
          ok: false,
          error: `goal 有 ${goal.length} 字，超过板子的 300 字上限；超出的部分会被截掉，命令会变成半句`,
          hint: '把长逻辑写成共享盘上的脚本（如 Z:\\_tools\\xxx.ps1），这里只传一句调用；或者把 goal 压到 300 字以内',
        }
      }
      const s = await snapshot(200)
      if (!s.ok) return { ok: false, error: '板子不可读：' + (s.error || '未知') }

      const busy = {}
      for (const t of s.tasks) {
        if (t.status === 'running' || t.status === 'claimed') {
          const m = String(t.machine || '').toLowerCase()
          if (m) busy[m] = (busy[m] || 0) + 1
        }
      }
      const online = s.machines.filter((m) => m.online && String(m.id).toLowerCase() !== 'host')

      // ── R4 能力协商：按配置清单过滤，并给出一张“能力匹配/不匹配”的方案表 ──
      const req = (Array.isArray(args.requires) ? args.requires : []).map((x) => String(x).toLowerCase()).filter(Boolean)
      const capsOf = (id) => {
        const m = s.machines.find((x) => String(x.id).toLowerCase() === String(id).toLowerCase())
        return m && m.caps && typeof m.caps === 'object' ? m.caps : null
      }
      const judge = (id) => {
        const caps = capsOf(id)
        if (!caps) return { reported: false, ok: req.length === 0, matched: [], missing: req }
        const f = caps.features && typeof caps.features === 'object' ? caps.features : {}
        const matched = []
        const missing = []
        for (const r of req) {
          if (r === 'shell') {
            if (f.shell) matched.push('shell:' + (f.pwsh || f.powershell || 'yes'))
            else missing.push('shell')
          } else if (r === 'gpu') {
            if (f.gpu) matched.push('gpu:' + String(f.gpu).slice(0, 40))
            else missing.push('gpu')
          } else if (r === 'ffmpeg') {
            if (f.ffmpeg) matched.push('ffmpeg:' + f.ffmpeg)
            else missing.push('ffmpeg')
          } else if (r === 'python') {
            if (f.python) matched.push('python:' + f.python)
            else missing.push('python')
          } else if (r === 'pwsh') {
            if (f.pwsh) matched.push('pwsh:' + f.pwsh)
            else missing.push('pwsh')
          } else {
            const v = f[r]
            if (v) matched.push(r + ':' + String(v).slice(0, 30))
            else missing.push(r)
          }
        }
        return { reported: true, ok: missing.length === 0, matched: matched, missing: missing }
      }
      const planRows = online.map((m) => {
        const j = judge(m.id)
        const caps = capsOf(m.id) || {}
        return {
          machine: m.id,
          caps: caps.os ? (caps.os + ' · ' + (caps.cores || '?') + 'C · ' + (caps.memGB || '?') + 'G') : '未上报',
          match: j.reported ? (j.ok ? '匹配' : '不匹配') : '未上报',
          matched: j.matched,
          missing: j.missing,
        }
      })
      const eligible = online.filter((m) => judge(m.id).ok)
      let target = ''
      let reason = ''
      if (args.machine) {
        const want = String(args.machine).trim().toLowerCase()
        const j = judge(want)
        if (req.length && !j.ok) {
          return {
            ok: false,
            error: String(args.machine) + ' 不满足能力要求：' + (j.missing.join(',') || '未上报配置清单'),
            hint: '换一台，或先让该节点重启 DSH 让它上报配置清单（/api/caps）',
            plan: planRows,
          }
        }
        const hit = s.machines.find((m) => String(m.id).toLowerCase() === want)
        if (!hit) return { ok: false, error: '板子上没有这台机器：' + args.machine, machines: s.machines.map((m) => m.id) }
        if (!hit.online) return { ok: false, error: hit.id + ' 当前不在线', hint: '先确认它的 DSH 在跑、remote-agent 已连上主机' }
        target = hit.id
        reason = '显式指定'
      } else {
        if (!online.length) return { ok: false, error: '没有在线且可派工的副机', machines: s.machines }
        if (!eligible.length) {
          return {
            ok: false,
            error: '没有满足能力要求的副机：' + req.join(', '),
            hint: '让缺能力的节点先装好工具并重启 DSH，或在面板里改派别台',
            plan: planRows,
          }
        }
        const sorted = eligible.slice().sort((a, b) => (busy[String(a.id).toLowerCase()] || 0) - (busy[String(b.id).toLowerCase()] || 0) || String(a.id).localeCompare(String(b.id)))
        target = sorted[0].id
        reason = '自动选最闲（在跑 ' + (busy[String(target).toLowerCase()] || 0) + ' 条）'
      }

      // 只用毫秒时间戳后 6 位，同一毫秒派两条就撞 ID（板子对重复 id 回 409）。
      // 加 4 位随机后缀：可读性不变，碰撞概率降到可忽略。
      const taskId = 'bd-' + Date.now().toString(36).slice(-6) + '-' + randomUUID().slice(0, 4)
      if (args.dryRun) {
        return {
          ok: true,
          dryRun: true,
          taskId: taskId,
          machine: target,
          reason: reason,
          requires: req,
          candidates: planRows,
          summary: '[预览] 会建单 ' + taskId + ' → ' + target + '（' + reason + '），并交给 Host 调度器派发；不写板子',
        }
      }
      // dispatch=auto：建单即入队，由 Host 侧调度器统一认领与派发（复核报告 #6）。
      // 旧的"下一步用 remote_task 真派"已废弃 —— 浏览器/对话不再持有派发权。
      const res = await call('POST', '/api/create', {
        task_id: taskId,
        goal: goal,
        machine: target,
        title: args.title || goal.slice(0, 60),
        note: args.note || '',
        dispatch: 'auto',
        mode: args.mode === 'exec' ? 'exec' : 'agent',
        workspace: args.workspace ? String(args.workspace) : '',
      })
      if (!res.ok) return { ok: false, error: '建单失败：' + (res.error || '未知') }
      return {
        ok: true,
        taskId: taskId,
        machine: target,
        reason: reason,
        requires: req,
        candidates: planRows,
        summary: '已排入 Host 调度队列 ' + taskId + ' → ' + target + '（' + reason + '）；Host 会在几秒内自己派给 remote-agent',
        hint: 'dispatch=auto：Host 每 4 秒扫一次队列，派完自动把 remote_id attach 回板子；终态也由 Host 回写，不用再调 remote_task。',
      }
    },
  },
  {
    name: 'board_attach',
    description: '把 remote_task 返回的远程任务号绑到板子任务上：状态转 running，租约默认 240 分钟。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '板子任务号（board_dispatch 返回的 taskId）' },
        remote_id: { type: 'string', description: 'remote_task 返回的 taskId' },
        machine: { type: 'string', description: '机器名（可选，默认沿用建单时那台）' },
        minutes: { type: 'number', description: '租约分钟数，默认 240' },
      },
      required: ['task_id', 'remote_id'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const res = await call('POST', '/api/attach', {
        task_id: args.task_id,
        remote_id: args.remote_id,
        machine: args.machine || '',
        minutes: Number(args.minutes) || 240,
      })
      if (!res.ok) return res
      return { ok: true, summary: args.task_id + ' 已绑定 ' + args.remote_id + '（running）', task_id: args.task_id, remote_id: args.remote_id }
    },
  },
    {
      name: 'board_status',
      description:
        '查看作业板总览：队列/进行/完成/打回计数、四台机器在线状态、最近事件、以及最新更新的时间。排查“任务有没有人接”时先调这个。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute() {
        const s = await snapshot(12)
        if (!s.ok) return s
        return {
          ok: true,
          summary: `待办 ${s.counts.queued} · 进行 ${s.counts.running} · 完成 ${s.counts.done} · 打回 ${s.counts.bad} · 状态更新于 ${s.updatedText}`,
          counts: s.counts,
          machines: s.machines,
          activeTasks: s.tasks.filter((t) => !TERMINAL.has(t.status)).slice(0, 10),
          recentTasks: s.tasks.slice(0, 6),
          events: s.events,
          hint: s.updatedAgeSec != null && s.updatedAgeSec > 1800 ? '板子状态文件超过 30 分钟没写，可能没人动过板，也可能是守护进程没在跑' : undefined,
        }
      },
    },
    {
      name: 'board_list',
      description: '列作业板任务，可按状态或机器过滤。返回紧凑列表（id/标题/状态/机器/进度/备注）。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'queued / claimed / running / done / blocked / failed / superseded；留空为全部' },
          machine: { type: 'string', description: 'host / gt14 / pc2 / mb14；留空不过滤' },
          limit: { type: 'number', description: '最多返回几条，默认 30' },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(args = {}) {
        // limit=0 = 取全量：先过滤再切，否则 >200 条时 done/superseded 会被切掉、total 也封顶（复核报告 #12）
        const s = await snapshot(0)
        if (!s.ok) return s
        let list = s.tasks
        if (args.status) list = list.filter((t) => t.status === args.status)
        if (args.machine) list = list.filter((t) => (t.machine || '').toLowerCase() === String(args.machine).toLowerCase())
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 30))
        return { ok: true, total: list.length, tasks: list.slice(0, limit) }
      },
    },
    {
      name: 'board_claim',
      description: '认领一个待办任务（把任务挂到本机名下）。认领成功后要定期 board_beat 续租，否则租约会过期。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 id' },
          note: { type: 'string', description: '认领备注（可选）' },
          minutes: { type: 'number', description: '租约分钟数，默认沿用板子默认值' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const body = { task_id: args.task_id, machine: cfg.machine, agent: 'dsh-board' }
        if (args.note) body.note = args.note
        if (args.minutes) body.minutes = Number(args.minutes)
        const res = await call('POST', '/api/claim', body)
        return res.ok ? { ok: true, task_id: args.task_id, machine: cfg.machine, note: clip(args.note || '', 120) } : res
      },
    },
    {
      name: 'board_beat',
      description: '给认领中的任务续租（心跳），顺带更新进度备注。长任务每隔几分钟调一次。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 id' },
          minutes: { type: 'number', description: '再续几分钟' },
          note: { type: 'string', description: '进度备注' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const body = { task_id: args.task_id, machine: cfg.machine }
        if (args.minutes) body.minutes = Number(args.minutes)
        if (args.note) body.note = args.note
        const res = await call('POST', '/api/beat', body)
        return res.ok ? { ok: true, task_id: args.task_id, note: clip(args.note || '', 120) } : res
      },
    },
    {
      name: 'board_done',
      description: '交付任务：把任务标记完成，可附产物路径（artifact）与备注。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 id' },
          artifact: { type: 'string', description: '产物路径或标识（可选）' },
          note: { type: 'string', description: '交付说明（可选）' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const body = { task_id: args.task_id, machine: cfg.machine, status: 'done' }
        if (args.artifact) body.artifact = args.artifact
        if (args.note) body.note = args.note
        const res = await call('POST', '/api/release', body)
        return res.ok ? { ok: true, task_id: args.task_id, status: 'done', artifact: clip(args.artifact || '', 120) } : res
      },
    },
    {
      name: 'board_fail',
      description: '打回或标记失败：任务交不出去时用（status=blocked 表示卡住待处理，failed 表示失败），务必写清原因。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 id' },
          note: { type: 'string', description: '为什么交不出去（必填）' },
          status: { type: 'string', description: 'blocked（默认）或 failed' },
        },
        required: ['task_id', 'note'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const status = args.status === 'failed' ? 'failed' : 'blocked'
        const body = { task_id: args.task_id, machine: cfg.machine, status, note: args.note }
        const res = await call('POST', '/api/release', body)
        return res.ok ? { ok: true, task_id: args.task_id, status } : res
      },
    },
    {
      name: 'board_say',
      description: '往作业板事件流里发一条播报（给人看的短消息）。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要播报的内容' } },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        const res = await call('POST', '/api/say', { machine: cfg.machine, text: args.text })
        return res.ok ? { ok: true, text: clip(args.text, 200) } : res
      },
    },
  ]

  const disposers = []
  let toolCount = 0

  // 工具结果渲染契约：DSH 只接受「内容块数组」（[{ type: 'text', text }]）。
  // 直接返回裸字符串数组时，DeepSeek Messages 适配器取到的块类型是 undefined，
  // 会抛 UNSUPPORTED_CONTENT（"cannot represent user/tool-result content undefined"），
  // 而该工具结果已经写进会话历史，于是此后每一轮请求都失败（会话被毒化）。
  const toTextBlocks = (lines) =>
    (Array.isArray(lines) ? lines : [lines]).map((text) => ({ type: 'text', text: String(text ?? '') }))

  const renderLines = (name, value) => {
    try {
      if (value === undefined || value === null) return ['（无返回）']
      if (typeof value === 'string') return [value]
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.ok === false) return [`${name} 失败：${value.error || value.message || '未知错误'}`]
        if (typeof value.summary === 'string') return [value.summary]
        if (Array.isArray(value.tasks)) {
          return value.tasks.slice(0, 12).map((x) => `· ${x.id || '?'} ${x.status || '?'} ${x.machine || ''}`.trim())
        }
      }
      return [JSON.stringify(value).slice(0, 400)]
    } catch (err) {
      return [`${name} 返回渲染失败：${(err && err.message) || err}`]
    }
  }
  // 逐个注册、逐个兜底：一个工具的参数格式不被接受，不该连累其它工具和面板路由。
  for (const t of tools) {
    try {
      disposers.push(
        ctx.tools.register({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          // DSH 要求 output 必须带 { schema, render }：render 决定工具结果在对话里
          // 怎么显示。返回值必须是内容块数组（[{ type: 'text', text }]），
          // 裸字符串数组会被适配器判成非法内容块（见上方 toTextBlocks 的说明）。
          output: {
            schema: { type: 'object', properties: {}, additionalProperties: true },
            render: (_args, value) => toTextBlocks(renderLines(t.name, value)),
          },
          // DSH 会校验返回值必须是无损 JSON（undefined / NaN / 类实例都会被判非法）。
          // 这里统一过一次 JSON 往返：undefined 键被丢掉，其余都是纯数据。
          execute: async (args) => {
            const out = await t.execute(args)
            if (out === undefined) return null
            try {
              return JSON.parse(JSON.stringify(out))
            } catch {
              return { ok: false, error: '工具返回值不是合法 JSON' }
            }
          },
        }),
      )
      toolCount++
    } catch (err) {
      trace(`tool FAILED ${t.name}: ${(err && err.message) || err}`)
    }
  }
  trace(`tools registered ${toolCount}`)

  // ── 关键：把同一批工具注册进「每个 agent 自己的层」─────────────────────────
  // 实测现象：只注册到全局层时，会话/子代理里调用 sh_run、board_status 一律报
  // `unknown tool`（工具名单里根本没有它们），而 dsh-ffmpeg 等同样用
  // ctx.tools.register 的插件却是可见的。DSH 的模型可见工具面按 agent 的 layer
  // 解析（own layer 覆盖同名全局项），所以这里在每个 agent 创建时再注册一遍。
  const registerBoardToolsOn = (targetCtx, label) => {
    if (!targetCtx || !targetCtx.tools || typeof targetCtx.tools.register !== 'function') return 0
    let n = 0
    for (const t of tools) {
      try {
        const dispose = targetCtx.tools.register({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          output: {
            schema: { type: 'object', properties: {}, additionalProperties: true },
            render: (_args, value) => toTextBlocks(renderLines(t.name, value)),
          },
          execute: async (args) => {
            const out = await t.execute(args)
            if (out === undefined) return null
            try {
              return JSON.parse(JSON.stringify(out))
            } catch {
              return { ok: false, error: '工具返回值不是合法 JSON' }
            }
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
        n++
      } catch (err) {
        trace(`tool FAILED ${label}/${t.name}: ${(err && err.message) || err}`)
      }
    }
    trace(`tools registered ${n} (${label})`)
    return n
  }

  const portedAgents = new Set()
  // #13：ctx.on 的返回值要留着，否则插件重载时订阅会叠加、成对泄漏。
  let agentUnsub = null
  try {
    agentUnsub = ctx.on(
      'agent/created',
      (event) => {
        try {
          const id = event && event.agent && event.agent.id
          if (!id || portedAgents.has(id)) return
          const actx = event.agent && event.agent.ctx
          if (!actx || !actx.tools) return
          portedAgents.add(id)
          registerBoardToolsOn(actx, 'agent:' + id)
          try {
            // 之前这里读的是 cfg 上不存在的键，赋值成 undefined，registerShellTools
            // 再去兜默认值 —— 正好兜成「不限根目录」。现在 cfg 里有这三个键。
            registerShellTools(actx, {
              allowedRoots: cfg.allowedRoots,
              timeoutMs: cfg.shellTimeoutMs,
              maxOutputBytes: cfg.maxOutputBytes,
            })
            trace('agent shell tools registered (4) for ' + id)
          } catch (err) {
            trace('agent shell tools FAILED for ' + id + ': ' + ((err && err.message) || err))
          }
        } catch (err) {
          trace('agent/created hook FAILED: ' + ((err && err.message) || err))
        }
      },
    )
    trace('agent/created 订阅完成')
  } catch (err) {
    trace('agent/created 订阅失败: ' + ((err && err.message) || err))
  }

  /* ───────────── GUI 路由（面板跑在浏览器里） ───────────── */

  const readJson = (req) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > 64 * 1024) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })

  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const routes = [
    {
      path: '/api/board/ui/summary',
      handler: async (req, res) => {
        try {
          // 以前只取 60 条：板子上 112 条时，74 条已完成里有一大半根本到不了面板，
          // 「已完成」视图就永远是残缺的。面板要能翻全部历史，这里取全量。
          const snap = await snapshot(0)
          // 面板要按"hub 节点号 → 板子机器名"归一，否则 desktop-2gh05s7 和 MB14
          // 会显示成两台机器（复核 #3 的界面侧）。
          if (snap && snap.ok) {
            try {
              const nr = await remoteUi('/nodes')
              const list = nr.ok && nr.data && Array.isArray(nr.data.nodes) ? nr.data.nodes : []
              const map = {}
              for (const n of list) {
                const id = String((n && n.nodeId) || '')
                if (id) map[id] = boardMachineName(nodeMachine(n) || id)
              }
              snap.nodeMap = map
            } catch {
              snap.nodeMap = {}
            }
          }
          send(res, 200, snap)
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/board/ui/claim',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (!body || !body.task_id) return send(res, 400, { ok: false, error: '需要 task_id' })
        const out = await call('POST', '/api/claim', { task_id: String(body.task_id), machine: cfg.machine, agent: 'dsh-board-ui' })
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      // 面板「清理」前先让 Host 调度器停手几秒：清理是"读快照 → 逐条归档"，
      // 这段时间里若调度器把某条 queued 任务 take 走并派到副机，随后 release 成
      // superseded 就会把正在跑的任务作废（幽灵任务）。任务的 untake 只在它已带
      // taker 时才有用，挡不住"快照还是 queued、下一秒被 take"的窗口。
      // ms 上限 10 分钟且自然过期：面板崩了也不会把派工永久停掉。
      path: '/api/board/ui/dispatch-pause',
      handler: async (req, res) => {
        const body = await readJson(req)
        const raw = Number(body && body.ms)
        const ms = Number.isFinite(raw) ? Math.max(0, Math.min(Math.round(raw), 10 * 60 * 1000)) : 0
        dispatchState.pausedUntil = ms > 0 ? Date.now() + ms : 0
        trace('dispatch paused for ' + ms + 'ms')
        send(res, 200, { ok: true, ms, pausedUntil: dispatchState.pausedUntil, paused: ms > 0 })
      },
    },
    {
      path: '/api/board/ui/release',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (!body || !body.task_id) return send(res, 400, { ok: false, error: '需要 task_id' })
        // 面板「清理」是把历史任务归档成 superseded。以前白名单只有 done/blocked/failed，
        // 任何别的值都会被静默改写成 done —— 那会把失败任务伪造成"完成"，所以放开 superseded。
        const RELEASE_STATUS = ['done', 'blocked', 'failed', 'superseded']
        const status = RELEASE_STATUS.includes(body.status) ? body.status : 'done'
        // 板子对 superseded 强制要求 note，缺了就 400；这里给个默认值兜底。
        const note = body.note ? String(body.note) : status === 'superseded' ? 'GUI 清理' : undefined
        const out = await call('POST', '/api/release', {
          task_id: String(body.task_id),
          // 终态要记到真实执行机头上：以前这里写死 cfg.machine（本机），
          // 面板替别台机器交付时归属就错了。
          machine: body.machine ? String(body.machine) : cfg.machine,
          status,
          note,
          artifact: body.artifact ? String(body.artifact) : undefined,
        })
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      // 面板清理时的「先退占位、再归档」：queued 任务可能在用户点清理之后被 Host 调度器
      // 认领（taker 有值）并派到副机；这时直接 release 成 superseded，会在副机还在跑的情况下
      // 把任务作废（幽灵任务）。所以先把板子的 /api/untake 原样转出去。
      // 注意板子比的是 taker 字段（不是 machine），所以 machine 必须是任务自己的 taker 值。
      // 板子非 200 时把状态码与 body 透传：前端要靠 409 的 { error:'不是你占的', taker } 判分支，
      // 吞成 502 无信息就没法区分"被别人抢走了"和真正的故障。
      path: '/api/board/ui/untake',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (!body || !body.task_id) return send(res, 400, { ok: false, error: '需要 task_id' })
        const machine = body.machine ? String(body.machine) : ''
        if (!machine) {
          return send(res, 400, {
            ok: false,
            error: '需要 machine：板子要求 task_id 与 machine 都必填，且这里要传任务自身的 taker 值',
          })
        }
        const out = await call('POST', '/api/untake', { task_id: String(body.task_id), machine })
        if (out.ok) return send(res, 200, { ok: true, data: out.data })
        const status = Number(out.status) || 502
        const raw = out.body && typeof out.body === 'object' ? out.body : null
        send(res, status, {
          ok: false,
          status,
          error: out.error || '板子拒绝了退占位',
          // 透传板子给的 taker / holder，前端用它说明"被谁认领了"
          taker: (raw && (raw.taker || raw.holder)) || undefined,
          holder: (raw && (raw.holder || raw.taker)) || undefined,
          body: raw,
        })
      },
    },
    {
      // 面板派工的第一步：先在板子上建单。
      // 之前客户端直接 POST 这个不存在的路由，结果远程真派了、板子却没记录，
      // 面板还显示"已派工"（复核 #4）。
      path: '/api/board/ui/create',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (!body || !body.task_id) return send(res, 400, { ok: false, error: '需要 task_id' })
        const goal = String(body.goal || '').trim()
        if (!goal) return send(res, 400, { ok: false, error: '需要 goal' })
        if (goal.length > 300) {
          return send(res, 400, {
            ok: false,
            error: `goal 有 ${goal.length} 字，超过板子的 300 字上限；超出的部分会被截掉，命令会变成半句`,
            hint: '把长逻辑写成共享盘上的脚本（如 Z:\\_tools\\xxx.ps1），这里只传一句调用；或者把 goal 压到 300 字以内',
          })
        }
        const out = await call('POST', '/api/create', {
          task_id: String(body.task_id),
          goal,
          machine: body.machine ? String(body.machine) : '',
          title: body.title ? String(body.title) : goal.slice(0, 60),
          note: body.note ? String(body.note) : '',
          // 面板派工也走 Host 调度器：建单即入队，浏览器不再自己 fetch remote-agent。
          dispatch: body.dispatch === undefined ? 'auto' : String(body.dispatch),
          mode: body.mode ? String(body.mode) : 'agent',
          workspace: body.workspace ? String(body.workspace) : '',
        })
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      // 客户端派工后回绑：板子任务号 + 远程任务号
      path: '/api/board/ui/attach',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (!body || !body.task_id || !body.remote_id) return send(res, 400, { ok: false, error: '需要 task_id 与 remote_id' })
        const out = await call('POST', '/api/attach', {
          task_id: String(body.task_id),
          remote_id: String(body.remote_id),
          machine: body.machine ? String(body.machine) : undefined,
          minutes: typeof body.minutes === 'number' ? body.minutes : undefined,
        })
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      // 清/设派发标记：派出去后必须立刻清 pending，否则后台循环会重复派
      path: '/api/board/ui/mark',
      handler: async (req, res) => {
        const body = await readJson(req)
        if (!body || !body.task_id) return send(res, 400, { ok: false, error: '需要 task_id' })
        const out = await call('POST', '/api/mark', {
          task_id: String(body.task_id),
          dispatch: body.dispatch === undefined ? undefined : String(body.dispatch),
          status: body.status ? String(body.status) : undefined,
          remote_id: body.remote_id === undefined ? undefined : String(body.remote_id),
        })
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      // 留言：写一条板子事件（调试用）
      path: '/api/board/ui/say',
      handler: async (req, res) => {
        const body = await readJson(req)
        const out = await call('POST', '/api/say', {
          machine: cfg.machine,
          text: String((body && body.text) || '').slice(0, 300),
        })
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      // 本机身份与评估状态：面板用它决定是否弹“要不要先做一次评估”
      path: '/api/board/ui/identity',
      handler: async (req, res) => {
        const st = identityState()
        const rec = readIdentity()
        send(res, 200, {
          ok: true,
          machine: st.machine,
          assessed: st.assessed,
          assessedAt: st.assessedAt,
          needsAssessment: st.needsAssessment,
          caps: rec && rec.caps ? rec.caps : null,
        })
      },
    },
    {
      // 重新评估工作能力（配置变了自己点）
      path: '/api/board/ui/assess',
      handler: async (req, res) => {
        const out = await assess(true)
        send(res, out.ok ? 200 : 502, out)
      },
    },
    {
      path: '/api/board/ui/pet.png',
      handler: async (req, res) => {
        if (!cfg.petImage) {
          send(res, 404, {
            ok: false,
            error: '没有桌宠立绘：包内 assets/pet.png 缺失，也没有配置 petImage',
          })
          return
        }
        try {
          const buf = await fs.promises.readFile(cfg.petImage)
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'no-cache',
            'content-length': buf.length,
          })
          res.end(buf)
        } catch {
          send(res, 404, { ok: false, error: '找不到桌宠立绘：' + cfg.petImage })
        }
      },
    },
  ]

  try {
    for (const r of routes) {
      const handler = (req, res) => {
        try {
          const c = req && req.headers && req.headers.cookie
          if (c && !browserCookie) browserCookie = String(c)
        } catch {
          /* 记 cookie 只是兜底，失败不影响请求 */
        }
        return r.handler(req, res)
      }
      disposers.push(ctx.webServer.register({ kind: 'exact', path: r.path, handler }))
      trace(`route registered ${r.path}`)
    }
  } catch (err) {
    trace(`route register FAILED: ${(err && err.message) || err}`)
    throw err
  }

  trace('ready')
  // R4：开机先上报一次配置清单，之后每 10 分钟刷新一次
  reportCaps()
  const capsTimer = setInterval(reportCaps, 10 * 60 * 1000)
  if (capsTimer && typeof capsTimer.unref === 'function') capsTimer.unref()

  // 实时指标：评估过才上报，15 秒一次（内存占用/CPU/磁盘余量）
  reportLive()
  const liveTimer = setInterval(reportLive, 15 * 1000)
  if (liveTimer && typeof liveTimer.unref === 'function') liveTimer.unref()

  // Host 调度器：认领 dispatch=auto 的队列并派发（#6）；另一个循环回写终态。
  // 都 unref：DSH 退出时不挡进程。
  let dispatchTimer = null
  let syncTimer = null
  if (cfg.autoDispatch) {
    dispatchTimer = setInterval(() => {
      dispatchOnce().catch(() => {})
    }, DISPATCH_TICK_MS)
    if (dispatchTimer && typeof dispatchTimer.unref === 'function') dispatchTimer.unref()
    syncTimer = setInterval(() => {
      syncRemote().catch(() => {})
    }, REMOTE_SYNC_MS)
    if (syncTimer && typeof syncTimer.unref === 'function') syncTimer.unref()
    trace('host dispatcher started tick=' + DISPATCH_TICK_MS + 'ms sync=' + REMOTE_SYNC_MS + 'ms')
  }

  ctx.logger?.info?.('dsh-board ready', { board: boardBase || '(auto)', machine: cfg.machine, tools: tools.length, autoDispatch: cfg.autoDispatch })

  return () => {
    // 复核 #7：先立 disposed 标志 —— 只清定时器的话，已经在飞的那一轮 dispatch/sync
    // 还会继续跑，把任务派出去或者回写板子。
    disposed = true
    // 复核 #4：待回绑记录必须留在磁盘上 —— 新实例 apply 时 loadPendingAttach() 读回来接着补绑。
    savePendingAttach()
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 已释放 */
      }
    }
    // #13：定时器和 agent 订阅原先都没人收，重载一次就多一套
    for (const t of [capsTimer, liveTimer, dispatchTimer, syncTimer]) {
      try {
        if (t) clearInterval(t)
      } catch {
        /* 已释放 */
      }
    }
    try {
      if (typeof agentUnsub === 'function') agentUnsub()
    } catch {
      /* 已释放 */
    }
    agentUnsub = null
    portedAgents.clear()
  }
}

export const shortHelp = () => `${os.hostname()} → board`




