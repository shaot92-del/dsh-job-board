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
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerShellTools } from './shell.js'
import { startSoloBoard } from './solo-board.mjs'
import { sleepSync, writeStateJson, withFileLock } from './state-file.mjs'

/** 包根目录：用来定位随包发布的资源（assets/pet.png），不依赖用户机器上的绝对路径。 */
const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 插件版本：doctor 与日志用；读不到就空串，不影响功能。 */
function readPluginVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}
const PLUGIN_VERSION = readPluginVersion()

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

export const name = 'dsh-job-board'

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
    // v2.0.3（复核 H3）：这两个开关以前只在 shell.js 里读，插件两处注册都没传，
    // 写进 cordis.patch.yml 也不生效。现在作为正式配置项，并进第二层存档。
    allowAllRoots: config.allowAllRoots === true,
    envPassthrough: Array.isArray(config.envPassthrough) ? config.envPassthrough.map(String) : [],
    shellTimeoutMs: Number(config.shellTimeoutMs) || 120000,
    maxOutputBytes: Number(config.maxOutputBytes) || 200000,
    // Host 侧调度器：默认开。关掉就退回"只有人工认领"的旧行为。
    autoDispatch: config.autoDispatch !== false,
    // v1.3.0（#10-2 · 调度所有权）：同一块板子上可能有好几台 Host 都在跑调度器，
    // 谁都可能去 take / untake 同一条任务。约定：只有 owner 派工；observer 只建单、
    // 只读，不 take、不 untake、不代别人改写板子（它自己历史上派出去的任务仍会收尾）。
    // v1.3.3（复核 🟡8）：以前只认严格的 'observer'，写成 Observer / observer 带空格 /
    // readonly 一律静默变 owner —— 一台本想"只建单"的机器会悄悄开始派工。这里做归一化，
    // 拼错的值按 owner 处理但在 ready 前打一行可见的日志（见下方 dispatchRoleNote）。
    dispatchRole: (() => {
      const raw = String(config.dispatchRole == null ? '' : config.dispatchRole).trim().toLowerCase()
      if (!raw || raw === 'owner') return 'owner'
      if (raw === 'observer') return 'observer'
      return 'owner'
    })(),
    // 拼错时的原值，仅供下面那行日志用。
    dispatchRoleRaw: config.dispatchRole == null ? '' : String(config.dispatchRole),
    // 派发时的审批策略（v1.1.2）：remote-agent 的 exec 任务默认 manual（挂起等批准），
    // 自动调度场景必须显式 auto，否则任务永远卡在 pending_approval。
    dispatchApproval: config.dispatchApproval === 'manual' ? 'manual' : 'auto',
    // v1.2.0：调度节拍与"结果未知"的观察窗口。写成配置项是为了让恢复流程能在
    // 隔离 harness 里跑（真实部署用默认值：4s / 30s）。
    // v1.3.3（复核 💭）：?? 而不是 ||，否则显式传 0 会被换成默认值。
    dispatchTickMs: (() => {
      const n = Number(config.dispatchTickMs)
      return Number.isFinite(n) ? Math.max(200, n) : 4000
    })(),
    // 注意用 ?? 而不是 ||：0 是合法值（"立即可判"），v1.2.1 复核发现 || 会把 0 吃掉。
    unknownGraceMs: config.unknownGraceMs === undefined
      ? 30000
      : Math.max(0, Number(config.unknownGraceMs) || 0),
    // 写路径超时：默认 max(timeoutMs, 20s)，仅测试需要压小。
    writeTimeoutMs: Number(config.writeTimeoutMs) || 0,
  }
  // ── 第二层配置（v1.4.1）：profile 的 cordis.patch.yml 会被宿主/设置页整份重写，
  // 2026-11-09 一天之内丢了两次 `- id: team` 与 `- id: remote-agent` 整块，结果
  // token 全空、hub 退回只听 127.0.0.1。这里把关键字段另存到状态目录：
  //   · loader 给了值 → 以 loader 为准，并回写存档（用户改配置仍然生效）
  //   · loader 没给   → 用存档兜底（patch 被重写后仍能工作）
  // remote-agent 有同构机制（instance.json），这里补齐 team 这一半。
  const TEAM_STATE_DIR = (() => {
    const override = String(process.env.DSH_TEAM_STATE_DIR || '').trim()
    return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'dsh-team')
  })()
  const TEAM_CONFIG_FILE = path.join(TEAM_STATE_DIR, 'config.json')
  const TEAM_CONFIG_KEYS = [
    'token', 'boardUrl', 'machine', 'dispatchRole', 'allowedRoots',
    'allowAllRoots', 'envPassthrough',
    'dispatchApproval', 'timeoutMs', 'shellTimeoutMs', 'maxOutputBytes',
  ]
  const savedTeamConfig = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(TEAM_CONFIG_FILE, 'utf8'))
      return j && typeof j === 'object' ? j : {}
    } catch {
      return {}
    }
  })()
  const cfgFromSaved = new Set()
  const cfgExplicit = (k) => Object.prototype.hasOwnProperty.call(config, k) && config[k] !== '' && config[k] != null
  for (const k of TEAM_CONFIG_KEYS) {
    if (cfgExplicit(k)) continue
    const v = savedTeamConfig[k]
    if (v === undefined || v === '') continue
    if (k === 'allowedRoots') {
      if (Array.isArray(v) && v.length) { cfg.allowedRoots = v.filter(Boolean); cfgFromSaved.add(k) }
    } else if (k === 'allowAllRoots') {
      if (v === true) { cfg.allowAllRoots = true; cfgFromSaved.add(k) }
    } else if (k === 'envPassthrough') {
      if (Array.isArray(v) && v.length) { cfg.envPassthrough = v.map(String); cfgFromSaved.add(k) }
    } else if (k === 'machine') {
      cfg.machine = String(v).toLowerCase(); cfgFromSaved.add(k)
    } else if (k === 'dispatchRole') {
      cfg.dispatchRole = String(v).toLowerCase() === 'observer' ? 'observer' : 'owner'; cfgFromSaved.add(k)
    } else if (k === 'dispatchApproval') {
      cfg.dispatchApproval = v === 'manual' ? 'manual' : 'auto'; cfgFromSaved.add(k)
    } else if (k === 'timeoutMs' || k === 'shellTimeoutMs' || k === 'maxOutputBytes') {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) { cfg[k] = n; cfgFromSaved.add(k) }
    } else if (typeof v === 'string') {
      cfg[k] = v; cfgFromSaved.add(k)
    }
  }
  // v2.0.3（复核 H1/H2）：solo 的「意图」必须先于第一次 persist 算出来。
  // v2.0.2 把 persistTeamConfig() 放在 solo 启动之前，而 snap.solo = !!soloBoard
  // 此刻恒为 false —— 只要这次启动没等到 listen（失败、DSH_TEAM_SOLO=0、进程被杀），
  // 存档就被改成 solo:false + 上一进程的死地址，此后永远不再自举。
  const savedSoloFlag = savedTeamConfig.solo
  const savedBoardUrl = String(savedTeamConfig.boardUrl || '')
  const savedLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(savedBoardUrl)
  // 2.0.1 的存档只有 token + 回环 boardUrl、没有 solo 键（那时还不写这个键）。
  // 这类老存档同样视为自举用户，否则升级后就带着死端口启动、且永不自愈。
  const legacySolo = savedSoloFlag === undefined && !!savedTeamConfig.token && savedLoopback
  const soloIntent = savedSoloFlag === true || legacySolo
  const soloExplicit = cfgExplicit('token') || cfgExplicit('boardUrl')
  const soloDisabledByConfig = process.env.DSH_TEAM_SOLO === '0' || config.solo === false
  const soloRequested =
    !soloExplicit && (soloIntent || (!cfg.token && !cfg.boardUrl)) && !soloDisabledByConfig
  let soloBoard = null
  const persistTeamConfig = () => {
    try {
      const snap = {}
      for (const k of TEAM_CONFIG_KEYS) snap[k] = cfg[k]
      // 只有「用户显式改成真实板子」才清掉自举标记；临时关闭 / 启动失败都要保留，
      // 否则下次启动不会再试（这正是 v2.0.2 的失联路径）。
      snap.solo = soloExplicit ? false : (!!soloBoard || soloIntent || soloRequested)
      fs.mkdirSync(TEAM_STATE_DIR, { recursive: true })
      const tmp = `${TEAM_CONFIG_FILE}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, TEAM_CONFIG_FILE)
    } catch (e) {
      trace(`team config 持久化失败：${e && e.message ? e.message : e}`)
    }
  }
  persistTeamConfig()
  if (cfgFromSaved.size) trace(`config 兜底来自 ${TEAM_CONFIG_FILE}：${[...cfgFromSaved].join(',')}`)
  // ── 板子地址：显式配置优先；没有配置才探测（宿主改写配置文件时也不至于失联）──
  // 探测名单不做硬编码：默认只试本机，内网/远程地址用 DSH_TEAM_BOARD_CANDIDATES
  // （逗号分隔）或 DSH_BOARD_URL 指定，避免把作者的局域网地址带进公开包。
  const BOARD_CANDIDATES = [
    process.env.DSH_BOARD_URL,
    ...String(process.env.DSH_TEAM_BOARD_CANDIDATES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    'http://127.0.0.1:8965',
  ].filter(Boolean)
  let boardBase = cfg.boardUrl ? cfg.boardUrl.replace(/\/+$/, '') : ''
  // ── Solo 自举（v1.5.0，v2.0.2 修重启）──────────────────────────────────
  // 第一次启用的用户没有板子进程、也没有 token（市场安装不带配置），过去只能看到
  // 401 空面板。这里在 127.0.0.1 上起一个随包的最小板子，token 随机生成，写进
  // 第二层配置；用户什么都不用填。显式配了 token/boardUrl 的用户完全不受影响。
  //
  // v2.0.2：solo 的端口是 port:0 随机分配的，存档里的 boardUrl 重启后就是死地址。
  // 存档带 solo:true（或 2.0.1 的回环老存档）时视为「自举用户」，即使读回了
  // token/boardUrl 也要重新起板子，并把新地址写回去（token 沿用存档，任务记录在
  // solo-board.json 里不会丢）。意图变量已在上面算好（v2.0.3，先于第一次写盘）。
  let soloReady = null
  if (soloRequested) {
    try {
      soloReady = startSoloBoard({
        stateDir: TEAM_STATE_DIR,
        host: '127.0.0.1',
        port: 0,
        token: soloIntent ? savedTeamConfig.token : undefined,
      })
        .then((b) => {
          soloBoard = b
          cfg.token = b.token
          cfg.boardUrl = b.url
          boardBase = b.url
          persistTeamConfig()
          trace(`solo 板子已启动 ${b.url}（仅 127.0.0.1，token ${soloIntent ? '沿用存档' : '自动生成'}）`)
          return b
        })
        .catch((e) => {
          // 启动失败不改写 solo 标记：下次启动还会再试（v2.0.3）。
          trace(`solo 板子启动失败：${e && e.message ? e.message : e}`)
          return null
        })
    } catch (e) {
      // startSoloBoard 的 mkdirSync 等在返回 Promise 之前执行，同步抛错不能掀掉 apply()。
      trace(`solo 板子启动失败（同步）：${e && e.message ? e.message : e}`)
      soloReady = null
    }
  }
  async function probeBoard(c) {
    try {
      const r = await fetch(`${c}/api/health`, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch {
      return false
    }
  }
  async function baseUrl() {
    // solo 自举是异步 listen：第一次访问板子前先等它就绪（之后置空，不再重复 await）。
    if (soloReady) {
      try {
        await soloReady
      } catch {
        /* 启动失败已 trace，回落到自动探测 */
      }
      soloReady = null
    }
    if (boardBase) return boardBase
    // v1.3.11（复核 M4）：自动探测只在第一次做，成功后 pin 到状态目录。以前每次启动都
    // 按候选名单广播式发问，同网段任何人都能抢先应答 —— 拿到的就是我们的 board token。
    const pinned = readBoardPin()
    if (pinned && process.env.DSH_TEAM_BOARD_REPIN !== '1') {
      if (await probeBoard(pinned)) {
        boardBase = pinned
        trace(`board pinned ${pinned}`)
        return pinned
      }
      trace(`board pin ${pinned} 不可达，重新探测`)
    }
    for (const raw of BOARD_CANDIDATES) {
      const c = raw.replace(/\/+$/, '')
      if (await probeBoard(c)) {
        boardBase = c
        if (c !== pinned) writeBoardPin(c)
        trace(`board auto-detected ${c}${c !== pinned ? '（已 pin）' : ''}`)
        return c
      }
    }
    boardBase = 'http://127.0.0.1:8965'
    trace(`board auto-detect failed, fallback ${boardBase}`)
    return boardBase
  }
  const endpoint = (path) => `${boardBase.replace(/\/+$/, '')}${path}`

  // 资源回收清单：apply 里注册的每一样东西（工具、路由、事件订阅）都要能摘掉。
  // 声明放在 apply 顶部，是因为最早的注册点（sh_* 工具）在第 160 行就要往里塞。
  const disposers = []

  // ── sh_* 命令与文件工具（原 dsh-shell，合并进本包）────────────────────────
  // 副机 worker 会话默认没有 pwsh / read / write，靠这四个工具把能力补上。
  // 用转发对象收 disposer：registerShellTools 内部只认 ctx.tools.register，
  // 不收返回值的话这 4 个工具在 cleanup 之后还留在工具表里（reload-smoke A5 用例暴露）。
  // 注意不能写成 Object.create(ctx) —— cordis 的 ctx 是带服务 setter 的代理，
  // 在派生对象上赋值 `tools` 会触发 "cannot set property in multiple fibers" 并让整个 apply 失败
  // （v1.1.11 首版就这么翻的，重启后 entry 直接 failed）。这里只传它真正需要的那一个能力。
  const shellCtx = {
    tools: {
      register(tool) {
        const dispose = ctx.tools.register(tool)
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    },
  }
  try {
    registerShellTools(shellCtx, {
      allowedRoots: cfg.allowedRoots,
      allowAllRoots: cfg.allowAllRoots,
      envPassthrough: cfg.envPassthrough,
      timeoutMs: cfg.shellTimeoutMs,
      maxOutputBytes: cfg.maxOutputBytes,
    })
    trace('shell tools registered (4)')
  } catch (err) {
    trace('shell tools register failed ' + String(err && err.message ? err.message : err))
  }

  // v1.2.0：派工写路径的独立超时（#10-1 / v1.1.13 遗留）。板子写路径实测 6.1s
  // （/api/caps）、/api/board 6–7s，与 cfg.timeoutMs=8s 贴边。抬到 20s 只是"多等一会"，
  // 不改变"结果是否已知"——超时后到底发没发出去，由 dispatchJournal 的状态机裁决。
  // writeTimeoutMs 可配：隔离 harness 需要把 20s 压到几百毫秒才能验证"结果未知"分支。
  const WRITE_TIMEOUT_MS = Number(cfg.writeTimeoutMs) > 0
    ? Number(cfg.writeTimeoutMs)
    : Math.max(Number(cfg.timeoutMs) || 8000, 20000)

  const call = async (method, path, body, opts) => {
    await baseUrl()
    // 单次调用可覆盖超时：板子写路径（/api/caps、release…）比读路径慢得多，
    // 共用 cfg.timeoutMs=8s 时会在启动瞬间贴边超时（2026-11-08 实测 /api/caps 6111ms）。
    // v1.2.0：写路径默认走 WRITE_TIMEOUT_MS，不再逐点传 opts —— 漏传一处就等于
    // 那处又回到 8s 贴边。读路径（/api/board 快照）保持 cfg.timeoutMs，调度 tick 不能被拖长。
    const timeoutMs = (opts && opts.timeoutMs) || (method === 'POST' ? WRITE_TIMEOUT_MS : cfg.timeoutMs)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
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
        error: aborted ? `板子无响应（${timeoutMs} 毫秒超时）` : String((err && err.message) || err),
        hint: '确认 board_server.py 在跑：http://127.0.0.1:8965/api/health',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * v1.2.0（#10-1）：这次调用的**结果是否已知**。
   *
   * - 拿到 2xx/4xx：结果已知（4xx 明确"没做成"，可以重派）。
   * - 超时 / 连接被断 / 5xx：远端可能已经执行了 —— 结果未知，绝不能直接重派，
   *   否则副机上会跑两遍同一条任务。
   */
  function isUnknownOutcome(res) {
    if (!res) return true
    if (res.ok) return false
    const status = Number(res.status || 0)
    if (!status) return true          // 超时 / fetch 直接失败
    return status >= 500              // 5xx：网关/上游可能已受理
  }

  /* ───────────── R4：身份与工作能力评估 ───────────── */

  // v1.3.8：身份文件允许用环境变量改位置 —— 验收必须能在干净的"未评估"状态下跑，
  // 否则本机有 identity.json 就会掩盖 CI 里 caps 根本不上报这件事（v1.3.6 CI 红）。
  const IDENTITY_DIR = process.env.DSH_TEAM_IDENTITY_DIR
    ? path.resolve(process.env.DSH_TEAM_IDENTITY_DIR)
    : path.join(os.homedir(), '.dsh-board')
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
      // caps 是"整机配置清单"写入，payload 由板子落盘，比读路径慢得多
      // （2026-11-08 实测 /api/caps 用 6111 ms）。给它独立的宽松超时，别和读共用 8s。
      const capsTimeoutMs = Math.max(cfg.timeoutMs, 20000)
      const started = Date.now()
      const res = await call('POST', '/api/caps', { machine: cfg.machine, caps: caps }, { timeoutMs: capsTimeoutMs })
      const tookMs = Date.now() - started
      if (force) saveIdentity(caps)
      // 失败时把 status / error 一起打出来：否则只看到 ok=false，
      // 分不清是超时（status=0）、板子 4xx 还是 5xx，只能回头手工复现。
      const why = res.ok ? '' : ' status=' + (res.status || 0) + ' error=' + String(res.error || '').slice(0, 160)
      trace('caps reported ok=' + res.ok + ' machine=' + cfg.machine + ' shell=' + caps.features.shell + ' took=' + tookMs + 'ms' + (force ? ' (assessed)' : '') + why)
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
          // v1.3.4（复核 🟡 snapshot 不映射 holder/lease）：同机双实例判定、租约剩余时间
          // 都要看这两个字段，以前面板/工具一律看不到。
          holder: String(t.holder || ''),
          leaseUntil: Number(t.lease_until || 0),
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

  const DISPATCH_TICK_MS = cfg.dispatchTickMs
  // v1.3.0：回写节拍也做成配置项 —— 隔离 harness 要能在几百毫秒内跑到一轮，
  // 否则 R19（跨 Host 收敛）得等 6 秒才有机会观察到是否误写。
  // v1.3.3（复核 💭）：Number(0) || 6000 会把显式的 0 换成 6 秒，改用有限性判断。
  const REMOTE_SYNC_MS = (() => {
    const n = Number(config.remoteSyncMs)
    return Number.isFinite(n) ? Math.max(200, n) : 6000
  })()
  // inFlight：当前这一轮里"已经认领、还没回绑完"的条数。暂停接口要等它归零才敢回
  // ok，否则调用方以为停了，实际还有一条在 take→dispatch 的路上（复核 #8）。
  // v1.3.6（复核 B1）：派工与同步各用一个闸门。以前共用一个 busy，语义还是「忙就丢弃」——
  // dispatchTickMs === remoteSyncMs 时两个定时器落在同一 timers phase，dispatch 在第一个 await
  // 让出时 busy 仍为 true，sync 回调直接 return，远端终态永远不回写。
  const dispatchState = { dispatching: false, syncing: false, lastError: '', dispatched: 0, synced: 0, pausedUntil: 0, inFlight: 0, lastTickAt: 0, lastSyncAt: 0 }
  // v1.3.3（复核 🟡4）：observer 每轮都 return，别每 4 秒打一行同样的日志。
  let observerRoleTraced = false
  // 复核 #7：热重载/卸载后旧实例的异步循环还会接着跑，dispose 里只清定时器不够。
  let disposed = false
  // 复核 #4：/dispatch 已经成功、/api/attach 失败时先把绑定记在这张表里，
  // 下一轮 tick 重试同一次 attach（不能重新 dispatch，否则远程任务会重复执行）。
  const pendingAttach = new Map()
  // v1.3.3（复核 🟡3）：补绑到 20 次以后若 mark blocked 一直失败，以前每 4 秒打一次
  // /api/mark + 一行 trace（tries 不再增长，tries % 20 === 0 恒真）。这里给每条记一个
  // 下次可试时间，跟 journal 的 blockRetryAt 同一套纪律。
  const pendingAttachRetryAt = new Map()
  // v1.3.7（复核 F9）：retryPendingAttach 成功后会把条目从 pendingAttach 移走，
  // escalateExpiredJournal 里那条「补绑正在进行」的护栏随即失效 —— 同一 tick 里
  // 刚补绑成功的任务会被判成"未澄清"并标 blocked。这里记下这一轮补绑成功的任务号。
  const attachedThisRound = new Set()

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

  async function remoteUi(pathname, payload, retried, opts) {
    const base = remoteUiBase()
    if (!base) return { ok: false, error: 'webServer.getOrigin() 不可用（Host 还没 listen）' }
    // v1.2.0：写类请求（POST /dispatch）与板子写路径同一条 20s 线；读类保持 cfg.timeoutMs。
    const timeoutMs = (opts && opts.timeoutMs) || (payload ? WRITE_TIMEOUT_MS : cfg.timeoutMs)
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
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 401 && !retried) {
        await ensureSessionCookie(true)
        return remoteUi(pathname, payload, true, opts)
      }
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        return { ok: false, status: res.status, error: (data && (data.error || data.message)) || 'HTTP ' + res.status, data }
      }
      return { ok: true, data }
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError')
      return {
        ok: false,
        status: 0,
        error: aborted ? `remote-agent 无响应（${timeoutMs} 毫秒超时）` : String((err && err.message) || err),
      }
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
  // 暂停打断本轮的日志节流（复核 #8）
  let lastPausedTrace = 0
  // v1.3.4（复核 🟡）：板子鉴权失败（401/403）本来完全静默 —— take 被归为"已知失败"、
  // 只退避不记日志，板上零痕迹。这条时间戳给告警做 60 秒节流。
  let lastAuthWarnAt = 0
  // v1.1.12：dispatchOnce 里两条「静默 return」的节流时间戳。
  // 它们原先一句话都不记，于是 hub 掉线 / 板子读不到时，板上只表现为
  // 任务永远 queued —— 2026-11-07 那次卡了两条任务整整 8 小时才被发现。
  let lastHubEmptyTrace = 0
  let lastSnapFailTrace = 0

  /** 把一个可能是 nodeId、也可能是板子别名的字符串，折成板子机器名（小写）。 */
  function machineAlias(name) {
    const raw = String(name || '').trim()
    return raw ? nodeMachine({ nodeId: raw }) : ''
  }

  /**
   * v1.2.3（复核 D2）：派工反查靠 goal 做键，但两边的 goal 来历不同 ——
   * 板子上存的是建单时写的原文，remote-agent 那边（hub/ui-routes.js）会先
   * `body.goal.trim()` 再落库，中间还可能经过一次 JSON 往返。只要首尾有空白、
   * 或换行/制表符写法不同，全等比较就会判"远端没有这条任务"，把已经在跑的任务
   * untake 后重派一份（探针里 4 秒造出 7 条同名任务）。
   * 所以反查一律用归一化后的 goal：合并所有空白、去首尾。空 goal 返回空串。
   */
  function normGoal(goal) {
    return String(goal == null ? '' : goal).replace(/\s+/g, ' ').trim()
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
  // 复核 #9（v1.1.10）：文件按「本机身份 + 板子地址」隔离。同一系统用户下可能同时跑
  // 多个 Host/profile，共用一个文件时谁也看不见谁的记录，而且各自用内存快照整文件覆盖，
  // 另一个实例补绑成功就会把本实例尚未恢复的记录抹掉。
  const PENDING_ATTACH_TTL_MS = 6 * 60 * 60 * 1000
  // v1.3.3（复核 🟡7）：状态目录以前写死 ~/.dsh/dsh-team，验收脚本在本机跑"假板子"时
  // 仍会读写真实状态（甚至对真实任务 take/untake）。允许用环境变量指到临时目录，
  // CI 与隔离 harness 都靠它。
  const pendingAttachDir = (() => {
    const override = String(process.env.DSH_TEAM_STATE_DIR || '').trim()
    return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'dsh-team')
  })()
  const pendingAttachKey = String(cfg.machine || os.hostname() || 'host')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 40)
  // v1.3.3（复核 F1 · 同机双派）：板子 do_take 对「同一个 machine」是幂等续租
  // （200 + reentrant），于是同一台机器上的第二个 DSH 进程会把第一个的占位当成
  // 自己的重入，两边都往下 /dispatch —— 同一条板上任务在副机上跑两遍。
  // 这里给每个进程一个身份，take 时一起上报；板子发现同名机器但 holder 不同就回 409。
  const INSTANCE_HOLDER = `${pendingAttachKey || 'host'}#${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  // v1.3.4（复核 🔴-1/F4）：journal 文件是同机多实例共用的（按 machine + boardUrl 命名）。
  // 条目带 holder 之后，别人实例的记录默认不动；只有它超过这个时长没更新（多半已经崩了）
  // 才允许接管 —— 否则两个进程会各自把同一条任务派一遍。
  const INSTANCE_TAKEOVER_MS = 90000
  // 板子地址只取配置值（自动探测会变，写成随机 tag 会让同一台机器读不到自己上次的记录）。
  const pendingAttachBoardTag = createHash('sha1')
    .update(String(cfg.boardUrl || 'auto'))
    .digest('hex')
    .slice(0, 8)
  const pendingAttachRemoved = new Set()

  // v1.3.11（复核 M4）：自动探测出来的板子地址要 pin 住（文件在状态目录，不写进 profile
  // 配置 —— 那份文件会被 profile 管理插件整份重写）。要重新探测就设
  // DSH_TEAM_BOARD_REPIN=1 启动一次。
  function boardPinFile() {
    return path.join(pendingAttachDir, 'board-url.json')
  }
  function readBoardPin() {
    try {
      const j = JSON.parse(fs.readFileSync(boardPinFile(), 'utf8'))
      return j && typeof j.url === 'string' ? j.url.replace(/\/+$/, '') : ''
    } catch {
      return ''
    }
  }
  function writeBoardPin(url) {
    try {
      fs.mkdirSync(pendingAttachDir, { recursive: true })
      fs.writeFileSync(boardPinFile(), JSON.stringify({ url, pinnedAt: new Date().toISOString() }, null, 2))
    } catch (err) {
      trace('board pin 写入失败 ' + String((err && err.message) || err))
    }
  }

  // v1.3.11（复核 D6）：journal 在 attach 成功后就 drop 了，里面存的 remoteId 活不到
  // syncRemote。所以要一份独立的"本机绑过哪条远端任务"账本，活到任务写回终态为止
  // （12 小时 TTL 兜底，防止长期堆积）。板上的 remote_id 变了 = 别的 Host 重派过，
  // 本机不再回写。
  const remoteOwners = new Map()
  function remoteOwnersFile() {
    return path.join(pendingAttachDir, `remote-owners-${pendingAttachKey}.json`)
  }
  function loadRemoteOwners() {
    try {
      const rows = JSON.parse(fs.readFileSync(remoteOwnersFile(), 'utf8'))
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r && r.taskId && r.remoteId) remoteOwners.set(String(r.taskId), {
          taskId: String(r.taskId), remoteId: String(r.remoteId),
          machine: String(r.machine || ''), at: Number(r.at || 0),
        })
      }
    } catch {
      /* 不存在是正常情况 */
    }
  }
  function saveRemoteOwners() {
    try {
      const cutoff = Date.now() - 12 * 3600 * 1000
      const rows = Array.from(remoteOwners.values()).filter((r) => Number(r.at || 0) >= cutoff)
      fs.mkdirSync(pendingAttachDir, { recursive: true })
      const file = remoteOwnersFile()
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2))
      fs.renameSync(tmp, file)
    } catch (err) {
      trace('remote owners 写入失败 ' + String((err && err.message) || err))
    }
  }
  function rememberRemoteOwner(taskId, remoteId, machineName) {
    if (!taskId || !remoteId) return
    remoteOwners.set(String(taskId), {
      taskId: String(taskId), remoteId: String(remoteId),
      machine: String(machineName || ''), at: Date.now(),
    })
    saveRemoteOwners()
  }
  function forgetRemoteOwner(taskId) {
    if (remoteOwners.delete(String(taskId))) saveRemoteOwners()
  }

  function pendingAttachFile() {
    return path.join(pendingAttachDir, `pending-attach-${pendingAttachKey}-${pendingAttachBoardTag}.json`)
  }

  /** 读一条记录数组；文件不存在是正常情况（从没失败过）。 */
  function readPendingAttachRows(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      // 兼容两种落盘形态：savePendingAttach() 写的是数组，但手工编辑/旧格式可能是单个对象，
      // 静默忽略会让"记录明明在、却一条也没补绑"，所以统一归一成数组。
      const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])
      return rows.filter((r) => r && r.taskId && r.remoteId)
    } catch (err) {
      const code = String((err && err.code) || '')
      if (code !== 'ENOENT') trace('pending attach load failed: ' + file + ' ' + String((err && err.message) || err))
      return []
    }
  }


  function loadPendingAttach() {
    try {
      // 复核 #9：新文件按身份隔离；首次升级时回退读旧的全用户共享文件，别把 v1.1.9 的记录丢掉。
      const file = pendingAttachFile()
      let rows = readPendingAttachRows(file)
      if (!rows.length) {
        const legacy = path.join(pendingAttachDir, 'pending-attach.json')
        if (legacy !== file) {
          rows = readPendingAttachRows(legacy)
          if (rows.length) trace('pending attach migrated from legacy file: ' + legacy)
        }
      } else {
        trace('pending attach file: ' + path.basename(file))
      }
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
    } catch (err) {
      // 文件不存在是正常情况（从没失败过就没有记录）；其它错误要留痕，
      // 否则"记录明明在、却一条都没补绑"会变成一个查不出来的静默 bug。
      const code = String((err && err.code) || '')
      if (code !== 'ENOENT') trace('pending attach load failed: ' + String((err && err.message) || err))
    }
  }

  /**
   * 落盘状态文件：临时文件名带进程号 + 覆盖失败重试。
   * v1.2.2（复核 H6/H7）：以前所有实例共用 `<file>.tmp`，两个 Host 同时写会互相
   * 覆盖临时文件，Windows 上还会因为目标句柄没放而 `EPERM`（实测过一次）——而那个
   * 失败只留下一行 trace，在途派工状态就这么丢了。
   */
  // v1.3.1：sleepSync / writeStateJson 移到 lib/state-file.mjs —— 那边还有跨进程锁，
  // 一起被 scripts/state-file-smoke.mjs 用例覆盖。

  function savePendingAttach() {
    const file = pendingAttachFile()
    // v1.3.1（复核「多实例并发写」）：读-合并-写整段加跨进程锁，否则两台 Host
    // 同时读、各自合并、后写的那个会把别人的记录整文件覆盖掉。
    const lock = withFileLock(file, () => {
      try {
        const now = Date.now()
        // 复核 #9：先读回磁盘再合并（同一 taskId 以本实例内存为准），过期的丢掉，
        // 再原子写入。这样另一个实例刚写进去、本实例内存里没有的记录不会被整文件覆盖掉。
        const merged = new Map()
        for (const r of readPendingAttachRows(file)) {
          if (now - Number(r.at || 0) > PENDING_ATTACH_TTL_MS) continue
          merged.set(String(r.taskId), r)
        }
        for (const [taskId, v] of pendingAttach.entries()) {
          merged.set(String(taskId), {
            taskId,
            remoteId: v.remoteId,
            machine: v.machine,
            boardUrl: String(boardBase || cfg.boardUrl || ''),
            tries: v.tries || 0,
            at: v.at || now,
          })
        }
        // 本实例刚补绑成功的条目必须真的从盘上消失，否则下次合并会把它"复活"。
        for (const taskId of pendingAttachRemoved) merged.delete(String(taskId))
        const rows = Array.from(merged.values())
        writeStateJson(file, rows)
        // v1.2.3（复核 D5）：墓碑在**写盘成功之后**才清 —— 先清再写，失败一次就会让
        // 已经补绑成功的记录在下次合并时复活，然后一直被重试。
        pendingAttachRemoved.clear()
      } catch (err) {
        // v1.2.2（复核 H7）：写盘失败以前只有一行 "save failed"，读的人没法判断
        // 是该重试还是该担心状态丢了。这里带上文件与错误码，并说明后果。
        trace('pending attach save failed: ' + file + ' '
          + String((err && err.code) || '') + ' ' + String((err && err.message) || err)
          + '（内存里仍有 ' + pendingAttach.size + ' 条待补绑，下一次状态变化会再试）')
      }
    })
    if (!lock.ok) {
      // v1.3.3（复核 🟡2）：withFileLock 现在不抛异常，失败原因从 lock 里带回来 ——
      // 区分「被别人占着」和「真的拿不到（建目录失败/锁是目录）」两种，否则排障时只知道"推迟"。
      trace('pending attach save 推迟：'
        + (lock.busy ? '状态文件被另一个实例锁着（' + file + '.lock）' : '拿不到互斥锁（' + (lock.error || 'unknown') + '）')
        + '，内存里仍有 ' + pendingAttach.size + ' 条待补绑，下一个状态变化再试')
    }
  }

  loadPendingAttach()

  /* ── v1.2.0（#10-1）：派工恢复日志 ────────────────────────────────
   *
   * 板子上一条任务的派工要跨三步：take（认领）→ POST /dispatch（真正派出）→
   * attach（回绑）。每一步都可能"已经发出去、但没收到回执"。以前任何一步失败都
   * untake 后下一轮重来 —— 对 /dispatch 是错的：超时那一刻副机上可能已经开跑，
   * 重派就是同一条任务跑两遍。
   *
   * 所以把在途状态持久化下来，只留三个相位：
   *   claimed —— 板子已认领，**dispatch 一次都没发出过**（崩在这里：下轮直接补发，不重新 take）
   *   unknown —— dispatch 可能已经发出（可能正在飞、可能已建任务、可能根本没送达）。
   *              sentAt 记的是"发出那一刻"，不是"放弃那一刻"：v1.2.1 复核发现用放弃
   *              时刻减去固定 5s 当反查下界，在 20s 写超时下必然查不到 → 重复派工。
   *              下轮**先查询**：远端有同 goal 且创建时间落在 [sentAt-skew, at+skew]
   *              的任务就认领它、只补绑定；确认没有才放回队列，且 attempts 有上限。
   *   （attach 失败的那一支不在这里，交给 pendingAttach，只重试 attach）
   */
  const DISPATCH_JOURNAL_TTL_MS = 2 * 60 * 60 * 1000
  const UNKNOWN_GRACE_MS = Number(cfg.unknownGraceMs) >= 0 ? Number(cfg.unknownGraceMs) : 30 * 1000
  // 反查窗口：远端建任务的时刻必然在 [sentAt, at] 之间，两边各留一点时钟/取整余量。
  const SEND_SKEW_MS = 5000
  // hub 的 /tasks 只回最近 200 条（updatedAt 倒序）。返回条数打满 200 时，"查不到"不能
  // 当成"远端没有"—— 只有窗口确实覆盖到发出时刻才算证据。v1.3.9（复核 D1/D5）：这个常量
  // 以前只定义在 reconcile 的 IIFE 里，escalateExpiredJournal 引用它直接 ReferenceError，
  // 每个 tick 一句 dispatch loop error、整轮派工中止；两处判据也因此各写一份、行为不一致。
  const HUB_TASKS_LIMIT = 200
  function hubWindowCoversTime(rows, since) {
    if (!Array.isArray(rows)) return false
    if (rows.length < HUB_TASKS_LIMIT) return true
    let oldest = Infinity
    for (const x of rows) {
      const ts = Number((x && (x.updatedAt || x.createdAt)) || 0)
      if (ts > 0 && ts < oldest) oldest = ts
    }
    if (!Number.isFinite(oldest)) return false
    return oldest <= since
  }
  // 同一条任务最多重派几次。到顶不再 untake（否则"建单成功但回执丢失"会无限循环），
  // 改成把板子任务标 blocked 让人看见 —— 对应验收标准 E1-3（有界）与 E1-7（未决要升级）。
  const MAX_DISPATCH_ATTEMPTS = 3
  const dispatchJournal = new Map()
  // v1.2.3（复核 D3 的连带）：reconcile 现在跑在快照之后，而它会改板子（attach / untake /
  // mark blocked）。改完必须重取一次快照，否则后面的 queue 还是按旧状态挑任务 —— 探针里
  // 被标成 blocked 的任务仍在队列里，又被派了一遍。
  let reconcileTouchedBoard = false
  // 只在本次进程内给"被别的机器占着"的条目各留一行日志，避免每 4 秒刷一次。
  const heldTraced = new Set()
  // v1.3.0（#10-2 · 跨 Host 收敛）：任务被别的机器重新认领后，本机不再回写 ——
  // 同样每台各留一行日志。
  const revokedTraced = new Set()
  // v1.2.3（复核 S2）：明确的失败（4xx / 没节点 / 认领被拒）要退避，不能每 4 秒重来。
  // 探针实测永久 4xx 时 6 秒内 take/untake/dispatch 各打了 29 次。
  // key = 板子任务 id，value = { until, fails, why }。
  const dispatchBackoff = new Map()
  /**
   * 明确的失败要退避（复核 S2）：永久 4xx / 没节点时，4 秒一轮会把板子和副机刷爆
   * （探针实测 6 秒打了 29 次）。退避按失败次数翻倍，封顶 5 分钟。
   */
  function bumpBackoff(taskId, why) {
    const key = String(taskId)
    const prev = dispatchBackoff.get(key) || {}
    const fails = Number(prev.fails || 0) + 1
    // v1.3.3（复核 💭）：指数上限原来是 4 → 最长 240 秒，和注释写的"封顶 5 分钟"对不上。
    const wait = Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.min(5, fails - 1)))
    dispatchBackoff.set(key, { fails, until: Date.now() + wait, why: String(why || '') })
    return wait
  }
  /**
   * v1.3.3（复核 💭）：这些"只记一行日志"的集合以前只增不减 —— 一天几百条任务，
   * 长期运行的 Host 会一直长。封顶后按插入顺序淘汰最老的。
   */
  function rememberOnce(set, key, cap = 2000) {
    const k = String(key)
    if (set.has(k)) return false
    set.add(k)
    if (set.size > cap) {
      let excess = set.size - cap
      for (const old of set) {
        set.delete(old)
        excess -= 1
        if (excess <= 0) break
      }
    }
    return true
  }
  // 超过 TTL 还没澄清的条目：不能静默丢（E1-7），要升级成板子上的 blocked 再清。
  const expiredJournal = new Map()
  // v1.2.2（复核 H6）：本实例删掉的条目要留墓碑，否则"读回磁盘再合并"会把它复活
  // —— 与 savePendingAttach 的 pendingAttachRemoved 同一套纪律。
  const journalRemoved = new Set()
  let lastReconcileTrace = 0

  function dispatchJournalFile() {
    return path.join(pendingAttachDir, `dispatch-journal-${pendingAttachKey}-${pendingAttachBoardTag}.json`)
  }

  function loadDispatchJournal() {
    try {
      const parsed = JSON.parse(fs.readFileSync(dispatchJournalFile(), 'utf8'))
      const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : []
      const now = Date.now()
      let n = 0
      for (const r of rows) {
        const phaseOk = r && (r.phase === 'claimed' || r.phase === 'taking' || r.phase === 'unknown' || r.phase === 'released')
        if (!r || !r.taskId || !phaseOk) continue
        // v1.2.3（复核 D1）：TTL 从**第一次尝试**算起（firstAt），不能从最近一次状态刷新算 ——
        // released 相位每次放回都会刷新 at，用 at 的话 2 小时 TTL 永远不会到期。
        const ageFrom = Number(r.firstAt || 0) || Number(r.at || 0)
        if (now - ageFrom > DISPATCH_JOURNAL_TTL_MS) {
          expiredJournal.set(String(r.taskId), r)
          continue
        }
        // v1.2.0 的旧条目：claimed 且没有 attempts —— 那个版本是"先写 claimed 再发
        // dispatch"，崩在 POST 中间时盘上就是这个样子。保守起见升级成 unknown，
        // 让下一轮先查远端，而不是直接补发（复核 B1）。
        if (r.phase === 'claimed' && !Number(r.attempts || 0)) {
          r.phase = 'unknown'
          r.sentAt = Math.max(0, Number(r.at || 0) - 20000)
          trace('dispatch journal migrate ' + r.taskId + '：旧版 claimed 无发出时间，按结果未知处理')
        }
        dispatchJournal.set(String(r.taskId), r)
        n += 1
      }
      if (n) trace('dispatch journal restored: ' + n + ' 条在途（' + Array.from(dispatchJournal.values()).map((r) => r.phase).join('/') + '）')
    } catch (err) {
      const code = String((err && err.code) || '')
      if (code !== 'ENOENT') trace('dispatch journal load failed: ' + String((err && err.message) || err))
    }
  }

  function saveDispatchJournal() {
    const file = dispatchJournalFile()
    // v1.3.1（复核「多实例并发写」）：读-合并-写整段加跨进程锁。没有锁的时候两台
    // Host 会各自读到同一份旧盘、各自合并、后写的把前一个的新增条目抹掉。
    const lock = withFileLock(file, () => {
    const now = Date.now()
    // v1.2.2（复核 H6）：先读回磁盘再合并 —— 同一台机器上可能有第二个 Host 实例
    // 也在写这个文件（同 machine、同 boardTag），整文件覆盖会把对方的在途条目抹掉。
    const merged = new Map()
    let diskRows = []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      diskRows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : []
    } catch (err) {
      const code = String((err && err.code) || '')
      if (code !== 'ENOENT') {
        trace('dispatch journal read-merge failed: ' + String((err && err.message) || err)
          + '（本轮按内存写，可能漏掉别的实例的条目）')
      }
    }
    for (const r of diskRows) {
      if (!r || !r.taskId) continue
      if (journalRemoved.has(String(r.taskId))) continue
      const ageFrom = Number(r.firstAt || 0) || Number(r.at || 0)
      if (now - ageFrom > DISPATCH_JOURNAL_TTL_MS) {
        // v1.3.3（复核 🟡6）：过期条目**先留在盘上**（打 expired 标记），等 escalate 真的
        // 把它标成 blocked（或反查命中、补绑成功）之后再删。以前在这里直接 continue 剔掉，
        // 万一随后崩溃，板上停在 claimed 而本地一条凭据都不剩。
        expiredJournal.set(String(r.taskId), r)
        merged.set(String(r.taskId), { ...r, expired: true })
        continue
      }
      // 盘上条目为底，内存覆盖：本实例看得更新。
      merged.set(String(r.taskId), r)
    }
    for (const [taskId, v] of dispatchJournal.entries()) {
      if (journalRemoved.has(String(taskId))) continue
      const ageFrom = Number(v.firstAt || 0) || Number(v.at || 0)
      if (now - ageFrom > DISPATCH_JOURNAL_TTL_MS) {
        // v1.3.3（复核 🟡6）：同盘上分支 —— 过期条目留在盘上打标记，升级成功后再删。
        expiredJournal.set(taskId, v)
        dispatchJournal.delete(taskId)
        merged.set(String(taskId), { ...v, expired: true })
        continue
      }
      merged.set(String(taskId), {
        taskId,
        nodeId: String(v.nodeId || ''),
        machine: String(v.machine || ''),
        goal: String(v.goal || '').slice(0, 500),
        mode: String(v.mode || ''),
        workspace: String(v.workspace || ''),
        phase: String(v.phase || ''),
        at: Number(v.at || now),
        firstAt: Number(v.firstAt || 0) || Number(v.at || now),
        sentAt: Number(v.sentAt || 0),
        attempts: Number(v.attempts || 0),
        holder: String(v.holder || ''),
        releasedAt: Number(v.releasedAt || 0),
        blockRetryAt: Number(v.blockRetryAt || 0),
        lastError: String(v.lastError || '').slice(0, 200),
      })
    }
    // v1.2.3（复核 D5）：墓碑必须在**写盘成功之后**才能清。以前先 clear 再写，
    // 一旦写失败，磁盘上那几条已删记录会在下次"读回-合并"时复活，重启后又被反查/untake。
    try {
      writeStateJson(file, Array.from(merged.values()))
      journalRemoved.clear()
      return true
    } catch (err) {
      // v1.2.2（复核 H7）：这里失败意味着"在途派工状态没落盘"，重启后会当没发生过
      // 而重派。必须打全：文件、错误码、内存里还有几条。
      trace('dispatch journal save failed: ' + file + ' ' + String((err && err.code) || '') + ' '
        + String((err && err.message) || err) + '（内存里仍有 ' + dispatchJournal.size + ' 条在途，墓碑保留，下一次状态变化会再试）')
      return false
    }
    })
    if (!lock.ok) {
      trace('dispatch journal save 推迟：'
        + (lock.busy ? '状态文件被另一个实例锁着（' + file + '.lock）' : '拿不到互斥锁（' + (lock.error || 'unknown') + '）')
        + '，内存里仍有 ' + dispatchJournal.size + ' 条在途，墓碑保留，下一次状态变化再试')
      return false
    }
    return lock.value === true
  }

  /** 删除一条在途记录，并留下墓碑（避免读-合并把它从盘上复活）。 */
  function journalDrop(taskId) {
    const key = String(taskId)
    const rec = dispatchJournal.get(key)
    const holder = String((rec && rec.holder) || '')
    // v1.3.4（复核 🔴-1/F4）：不能删别的实例写的记录 —— 它还要靠这条记录做恢复。
    // 以前 take 409 之后照删不误，把 A 实例的 unknown 凭据一并抹掉。
    // v1.3.6（复核 F2）：**接管**之后必须能删。以前这里死认 rec.holder，接管者
    // 依 holderUsable 拿到的处理权在这里被否掉 —— 记录一直留到 TTL，之后每一轮
    // 都命中远端并重新 attach，板上 done 被翻回 running、lease 无限续期。
    if (holder && holder !== INSTANCE_HOLDER) {
      const ageMs = Date.now() - Number(rec.at || 0)
      if (ageMs < INSTANCE_TAKEOVER_MS) {
        trace('dispatch journal drop 跳过 ' + key + '：在途记录属于另一个实例（' + holder + '），不动它')
        return false
      }
      trace('dispatch journal drop 接管 ' + key + '：原实例 ' + holder + ' 已 '
        + Math.round(ageMs / 1000) + ' 秒没更新，按崩溃处理、删除这条记录')
    }
    dispatchJournal.delete(key)
    journalRemoved.add(key)
    return saveDispatchJournal()
  }

  /**
   * 写一条在途记录。返回 false 表示**落盘失败** —— 调用方在"发出请求之前"必须检查，
   * 否则会出现"远端建了任务、本地没有记录"的孤儿（复核 S3）。
   */
  function journalSet(taskId, fields) {
    const key = String(taskId)
    const prev = dispatchJournal.get(key) || {}
    // firstAt 是 TTL 的基准，只在第一次写入时定，后续状态变化不再刷新它。
    const firstAt = Number(prev.firstAt || 0) || Date.now()
    // v1.3.4（复核 🔴-1/F4）：同机两个 Host 共用一份 journal 文件。条目必须记住是谁写的，
    // 否则 B 实例会把 A 的 unknown 覆盖成自己的 taking，take 409 之后再 journalDrop 掉
    // **A 的记录** —— A 崩在 dispatch/attach 之间时，板上 claimed、本地无凭据。
    const holder = String(fields.holder || prev.holder || INSTANCE_HOLDER)
    dispatchJournal.set(key, { ...prev, ...fields, holder, firstAt, at: Date.now() })
    return saveDispatchJournal()
  }

  loadDispatchJournal()
  loadRemoteOwners()

  /**
   * 这条在途记录能不能由本实例处理（v1.3.4 复核 🔴-1/F4）。
   * 空 holder = 旧版记录，按「无人持有」放行；别人持有且新鲜的记录不许动（resume 直接补发、
   * 不经过 /api/take，没有板子那层护栏）；超过 INSTANCE_TAKEOVER_MS 没更新才视为原实例已崩。
   */
  function holderUsable(rec, boardId) {
    const holder = String((rec && rec.holder) || '')
    if (!holder || holder === INSTANCE_HOLDER) return true
    const ageMs = Date.now() - Number((rec && rec.at) || 0)
    if (ageMs < INSTANCE_TAKEOVER_MS) {
      if (rememberOnce(heldTraced, 'holder:' + boardId)) {
        trace('dispatch journal hold ' + boardId + '：在途记录属于另一个实例（' + holder + '），不补发')
      }
      return false
    }
    trace('dispatch journal takeover ' + boardId + '：原实例 ' + holder + ' 已 '
      + Math.round(ageMs / 1000) + ' 秒没更新，按崩溃处理、接管这条记录')
    return true
  }

  /**
   * 超过 TTL 仍未澄清的条目：不能像 v1.2.0 那样静默删除（板上会永远停在 claimed，
   * 且没有任何人知道）。这里按 E1-7 升级成板子上的 blocked，再清掉本地记录。
   */
  async function escalateExpiredJournal() {
    if (!expiredJournal.size) return
    for (const [taskId, rec] of Array.from(expiredJournal.entries())) {
      if (disposed) return
      // v1.3.7（复核 F9）：这一轮刚补绑成功 → 已经有 remote_id 了，不能再判"未澄清"。
      if (attachedThisRound.has(String(taskId))) {
        expiredJournal.delete(taskId)
        continue
      }
      if (Number(rec.blockRetryAt || 0) > Date.now()) continue
      // v1.3.4（复核 🔴‑2）：补绑正在进行的不许抢先标 blocked —— 否则上一轮刚 attach 成功，
      // 同一 tick 里被这里标成 blocked，出现"板上 blocked、远端任务还在跑"。
      if (pendingAttach.has(taskId)) continue
      // v1.3.4（复核 🟡 released 2h 后被无条件标 blocked）：released 已放回队列、由队列正常重派，
      // 这里的条目只是为了记住 attempts。到 TTL 直接清账，不升级 blocked。
      if (rec.phase === 'released') {
        expiredJournal.delete(taskId)
        journalDrop(taskId)
        trace('dispatch journal expired ' + taskId + '：released 条目超过 TTL，清账（attempts=' + Number(rec.attempts || 0) + '）')
        continue
      }
      // v1.2.3（复核 S5）：标 blocked 之前先查一次远端 —— "回执丢了、任务其实建好了"
      // 在 TTL 边缘是真实存在的。直接标 blocked 会把一条正在跑的任务从 syncRemote 的
      // watched 里摘掉（blocked 不在 watched），结果没人再回写它的终态。
      if (rec.nodeId) {
        const res = await remoteUi('/tasks?node=' + encodeURIComponent(String(rec.nodeId)))
        if (res.ok) {
          const rows = res.data && Array.isArray(res.data.tasks) ? res.data.tasks : []
          const goal = normGoal(rec.goal)
          const sentAtMs = Number(rec.sentAt || 0) || Number(rec.at || 0)
          // v1.3.7（复核 F3）：这里以前没有 v1.2.4 的截断保护 —— hub 的 /tasks 只回最近
          // 200 条并按 updatedAt 倒序，任务一多，我们那条早被挤出窗口，"查不到"变成了
          // "远端没有"的伪证据，于是把还在跑的任务标成 blocked（blocked 不在 syncRemote
          // 的 watched 里，等于永远不回写）。与 reconcile 用同一套判据。
          const absenceProvable = hubWindowCoversTime(rows, sentAtMs - SEND_SKEW_MS)
          const hit = rows.find((x) => x && normGoal(x.goal) === goal
            && Number(x.createdAt || 0) >= sentAtMs - SEND_SKEW_MS)
          if (!hit && !absenceProvable) {
            rec.blockRetryAt = Date.now() + 60000
            trace('dispatch journal expired ' + taskId + '：反查列表被截断（' + rows.length
              + ' 条），不能判定"远端没有"，推迟 60 秒再判')
            continue
          }
          if (hit) {
            const machine = rec.machine || boardMachineName(nodeMachine({ nodeId: rec.nodeId }) || rec.nodeId)
            const out = await attachTask(taskId, String(hit.taskId), machine)
            reconcileTouchedBoard = true
            expiredJournal.delete(taskId)
            journalDrop(taskId)
            trace('dispatch journal expired ' + taskId + '：远端其实有这条任务（' + hit.taskId
              + '），只补绑不标 blocked' + (out.ok ? '' : '，但 attach 失败已转 pendingAttach'))
            continue
          }
        } else {
          // v1.3.4（复核 N1）：查不到远端就**不能**断言"没有" —— 以前 res 失败也往下走
          // 标 blocked，hub 一抖就把可能在跑的任务判死（blocked 不在 syncRemote 的 watched 里）。
          rec.blockRetryAt = Date.now() + 60000
          trace('dispatch journal expired ' + taskId + '：hub 查询失败（'
            + (res.error || res.status || 'unknown') + '），不能断言远端没有，推迟 60 秒再判')
          continue
        }
      }
      const marked = await call('POST', '/api/mark', {
        task_id: taskId,
        status: 'blocked',
        note: '派工结果未知超过 ' + Math.round(DISPATCH_JOURNAL_TTL_MS / 60000) + ' 分钟仍未澄清（已尝试 '
          + Number(rec.attempts || 0) + ' 次），已停止自动重派；请人工确认副机上是否已有这条任务',
      })
      reconcileTouchedBoard = true
      if (marked.ok) {
        expiredJournal.delete(taskId)
        // v1.3.3（复核 💭）：以前只从内存表里删，盘上那条（v1.3.3 起会带 expired 标记留着）
        // 会在下一轮读回合并时重新回到 expiredJournal，然后被反复标 blocked。
        journalDrop(taskId)
        trace('dispatch journal expired ' + taskId + '：超过 TTL 未澄清，已标 blocked')
      } else {
        // v1.2.3（复核 D6）：mark 失败时**不能**丢掉这条凭据 —— 丢了以后板上永远停在
        // claimed，既没人重派也没人升级。保留条目，60 秒后再试。
        rec.blockRetryAt = Date.now() + 60000
        trace('dispatch journal expired ' + taskId + '：标 blocked 失败（'
          + (marked.error || marked.status) + '），保留条目 60 秒后重试')
      }
    }
  }

  /**
   * 把"结果未知"的派工查清楚（#10-1 的核心）：远端任务列表里若存在同 goal、
   * 且创建时间晚于本次派发尝试的任务，就是它 —— 直接 attach，绝不重派。
   * 只有确认远端**没有**这条任务（超过 UNKNOWN_GRACE_MS 仍查不到）才放回队列。
   */
  /**
   * 把「结果不确定」的任务有界地升级成板子上的 blocked —— 有界（不再自动重派），
   * 且必须让人看见（E1-3 / E1-7）。标成功才删 journal；失败保留并 60 s 后重试
   * （复核 D6：删了凭据会让板上永远停在 claimed，没人再碰）。
   */
  async function escalateUnknownToBlocked(taskId, attempts, why) {
    const marked = await call('POST', '/api/mark', {
      task_id: taskId,
      status: 'blocked',
      note: '派工结果不确定：' + why + '已尝试 ' + attempts + ' 次，已停止自动重派；'
        + '请人工确认副机上是否有同名任务，确认后手动放回队列',
    })
    reconcileTouchedBoard = true
    if (marked.ok) {
      journalDrop(taskId)
      trace('dispatch unknown 达上限 ' + taskId + '（attempts=' + attempts + '）已标 blocked：' + why)
      return 'dropped'
    }
    journalSet(taskId, { blockRetryAt: Date.now() + 60000 })
    trace('dispatch unknown 达上限 ' + taskId + '（attempts=' + attempts + '）标 blocked 失败，保留条目稍后重试: '
      + (marked.error || marked.status))
    return 'retry'
  }

  async function reconcileUnknownDispatches(snap) {
    let adopted = 0
    // 本轮已经认领回来的远端任务：两条板子任务同 goal 时，避免都绑到同一条远端任务
    // （那样第二条会"假完成"）。
    const matched = new Set()
    // v1.2.3（复核 D3/D4）：板子上**已经被别的任务引用**的 remote_id 不能再被认领，
    // 否则两条板子任务会指向同一条远端任务，其中一条从未执行却被标成完成。
    const occupied = new Set()
    const snapById = new Map()
    for (const t of Array.isArray(snap && snap.tasks) ? snap.tasks : []) {
      snapById.set(String(t.id), t)
      if (t.remote) occupied.add(String(t.remote))
    }
    // v1.2.2（复核 中）：同一个节点的多条 unknown 只查一次 /tasks，失败结果也缓存
    // —— 以前每个条目各打一次请求（写超时 20 s 时可能把整轮 busy 拖满）。
    const tasksCache = new Map()
    for (const [taskId, rec] of Array.from(dispatchJournal.entries())) {
      if (disposed) return adopted
      if (rec.phase !== 'unknown') continue
      // v1.3.6（复核 F1）：同机双实例共用一份 journal —— 别人新鲜持有的条目不许动。
      // 这里的 untake 以前不带 holder，板子那层的 holder 校验因缺省放行，会把 A 实例
      // 正在飞的任务放回队列、再派一条。归属判断要放在所有写操作之前。
      if (!holderUsable(rec, taskId)) continue
      // mark 失败过的条目退避 60 s 再试，别每个 tick 都打一次板子。
      if (Number(rec.blockRetryAt || 0) > Date.now()) continue
      // 暂停期间不碰远端状态：查询之后的 untake 与面板的"读快照 → 归档"是同一类竞态。
      if (Date.now() < dispatchState.pausedUntil) {
        if (Date.now() - lastPausedTrace > 30000) {
          lastPausedTrace = Date.now()
          trace('dispatch reconcile paused，停在 ' + taskId)
        }
        break
      }
      const boardTask = snapById.get(String(taskId))
      // v1.2.3（复核 D3）：板上已经回绑 remote 却还留着 journal（崩在 attach 与删除之间），
      // 说明这条任务正在副机上跑。**绝不能 untake** —— 那会把一条 running 任务放回队列
      // 再派一条，而且 untake 后 syncRemote 不再看它，旧任务的结果永远回不来。
      if (boardTask && boardTask.remote) {
        journalDrop(taskId)
        trace('dispatch journal drop ' + taskId + '：板上已有 remote=' + boardTask.remote + '（只清账，不动板子）')
        continue
      }
      const ageMs = Date.now() - Number(rec.at || 0)
      const cacheKey = String(rec.nodeId || '')
      let res = tasksCache.get(cacheKey)
      if (!res) {
        const q = '/tasks' + (rec.nodeId ? '?node=' + encodeURIComponent(String(rec.nodeId)) : '')
        res = await remoteUi(q)
        tasksCache.set(cacheKey, res)
      }
      if (!res.ok) {
        if (Date.now() - lastReconcileTrace > 60000) {
          lastReconcileTrace = Date.now()
          trace('dispatch reconcile: 查不了远端任务列表（' + (res.error || res.status) + '），' + taskId + ' 保持结果未知，先不重派')
        }
        continue
      }
      const rows = res.data && Array.isArray(res.data.tasks) ? res.data.tasks : []
      const goal = normGoal(rec.goal)
      // v1.2.1（复核 B2）：下界用**发出时刻** sentAt，不是"放弃时刻" at —— at 已经
      // 包含整段请求耗时（写超时可达 20s），用 at-5s 当窗口在慢网下必然查不到，
      // 会把"副机已在跑"误判成"没发出去"从而重复派工。
      const sentAtMs = Number(rec.sentAt || 0) || Number(rec.at || 0)
      const since = sentAtMs - SEND_SKEW_MS
      const until = Number(rec.at || 0) + SEND_SKEW_MS
      // v1.2.4（复核 · 反查上限）：hub 的 /tasks 是 `tasks.slice(0, 200)`、按 updatedAt
      // 倒序 —— 节点上任务攒到 200+ 之后，我们这条在途任务会被切到窗口外。这时
      // "查不到"**不等于**"没建"，一律判定成没有就会 untake 再派一条（与 D2 同一
      // 失效面：重复执行）。只有当返列表的窗口确实覆盖到发出时刻，才有资格说"没有"。
      const absenceProvable = hubWindowCoversTime(rows, since)
      // v1.2.3（复核 D2）：goal 两侧来源不同（板子原文 vs remote-agent 那边 body.goal.trim()），
      // 直接全等比较会被一个尾随空格打穿；统一归一化后再比。
      const candidates = rows.filter((x) => {
        if (!x) return false
        if (normGoal(x.goal) !== goal) return false
        const createdAt = Number(x.createdAt || 0)
        if (createdAt < since || createdAt > until) return false
        const rid = String(x.taskId || '')
        return !matched.has(rid) && !occupied.has(rid)
      })
      // 多个候选说明这个窗口里同 goal 的任务不止一条，无法确定哪条是本任务的 ——
      // 宁可继续等（或最终升级 blocked），也不能随便认领一条造成"假完成"。
      const hit = candidates.length === 1 ? candidates[0] : null
      if (candidates.length > 1 && Date.now() - lastReconcileTrace > 60000) {
        lastReconcileTrace = Date.now()
        trace('dispatch reconcile: ' + taskId + ' 有 ' + candidates.length + ' 个候选，无法唯一确定，先不认领')
      }
      if (hit) {
        matched.add(String(hit.taskId || ''))
        const machine = rec.machine || boardMachineName(nodeMachine({ nodeId: rec.nodeId }) || rec.nodeId)
        const out = await attachTask(taskId, String(hit.taskId), machine)
        reconcileTouchedBoard = true
        // attach 成功或失败都把 journal 清掉：失败那一路已经由 attachTask 写进
        // pendingAttach，继续留着只会每轮重复 attach。
        journalDrop(taskId)
        if (out.ok) {
          occupied.add(String(hit.taskId))
          dispatchState.dispatched += 1
          adopted += 1
          trace('dispatch recovered ' + taskId + ' remote=' + hit.taskId + '（结果未知 → 远端确有此任务，只补绑不重派）')
        } else {
          trace('dispatch recovered ' + taskId + ' remote=' + hit.taskId + ' 但 attach 失败，转 pendingAttach: ' + String(out.error || out.status))
        }
        continue
      }
      // v1.2.3（复核 D3）：板上 running 说明副机上确实在跑（多半是 remote 字段还没回写）。
      // 此时 untake 会把正在执行的任务作废，一律不动，等它自己结束。
      if (boardTask && boardTask.status === 'running') {
        if (Date.now() - lastReconcileTrace > 60000) {
          lastReconcileTrace = Date.now()
          trace('dispatch reconcile: ' + taskId + ' 板上 running，不 untake（等它结束）')
        }
        continue
      }
      if (ageMs > UNKNOWN_GRACE_MS) {
        const attempts = Number(rec.attempts || 0)
        // v1.2.4：反查窗口被截断时，"查不到"不能当成"远端没有"。宁可停在结果未知，
        // 也不能 untake 重派 —— 重派的代价是副机上多跑一条，而多等一会儿只是慢。
        // 反复确认不了（默认 3 轮）就升级 blocked，把这件事交给人看。
        if (!absenceProvable) {
          const unresolved = Number(rec.unresolved || 0) + 1
          if (unresolved >= MAX_DISPATCH_ATTEMPTS) {
            await escalateUnknownToBlocked(taskId, Math.max(attempts, unresolved),
              '远端任务列表被截断（/tasks 只回 ' + rows.length + ' 条，hub 上限），无法确认那条任务是否存在；')
            continue
          }
          journalSet(taskId, {
            unresolved,
            lastError: '反查列表被截断（' + rows.length + ' 条），无法确认远端有没有这条任务',
          })
          if (Date.now() - lastReconcileTrace > 60000) {
            lastReconcileTrace = Date.now()
            trace('dispatch unknown ' + taskId + '：/tasks 只回了 ' + rows.length + ' 条（hub 上限）且都比发出时刻新，'
              + '不能判定"远端没有"，先保持结果未知（第 ' + unresolved + '/' + MAX_DISPATCH_ATTEMPTS + ' 次）')
          }
          continue
        }
        if (attempts >= MAX_DISPATCH_ATTEMPTS) {
          // 有界：不能再 untake 了，否则"远端建单成功但回执总丢"会无限重派。
          // 升级成 blocked 让人看见（E1-3 有界 + E1-7 未决要升级）。
          await escalateUnknownToBlocked(taskId, attempts, '已尝试 ' + attempts + ' 次仍未在远端找到这条任务，')
          continue
        }
        // 远端确实没有 → 这次派发没落地。把板子上的占位放掉，下一轮正常重派。
        const released = await call('POST', '/api/untake', {
          task_id: taskId,
          machine: cfg.machine,
          holder: INSTANCE_HOLDER,
          note: '派工结果未知已澄清：远端没有这条任务，放回队列',
        })
        reconcileTouchedBoard = true
        // 放回成功、或板子明确说"不是你占的"（409）才可以清条目；超时/5xx 属于
        // 结果未知 —— 条目保留，否则板上永远停在 claimed 且没人再碰它。
        if (released.ok || Number(released.status) === 409) {
          // v1.2.3（复核 D1）：这里不能删条目 —— 删了 attempts 就归零，上限与 TTL
          // 永远不会到达，结果就是"永远重派"。改成 released 相位：保留 attempts，
          // 下一轮重新 take 时继续累加。
          journalSet(taskId, { phase: 'released', releasedAt: Date.now(), lastError: '' })
          trace('dispatch unknown 已澄清 ' + taskId + '（远端无此任务，' + ageMs + 'ms，attempts='
            + (attempts + 1) + '）' + (released.ok ? '，已放回队列' : '，放回时板子说已不归本机（409）'))
        } else {
          trace('dispatch unknown 澄清后放回失败 ' + taskId + '，保留日志下一轮重试: ' + (released.error || released.status))
        }
      }
    }
    return adopted
  }

  /**
   * v1.3.0（#10-2 · 复核「attach 不校验远端仍在」）：attach 之前先问 hub 这条远程任务
   * 是否还在。远端任务可能已被回收（/purge、hub 重启），也可能压根没建出来 —— 两种
   * 情况下把 remote_id 写进板子都是错的：板上显示"正在跑"，syncRemote 却永远等不到
   * 终态，最后变成一条谁也不敢动的 stale。
   * 返回 { known: true|false|null }：null = 查不清（超时/5xx），不阻拦，保持旧容错行为。
   */
  async function probeRemoteTask(remoteId) {
    if (!remoteId) return { known: false }
    const res = await remoteUi('/task?taskId=' + encodeURIComponent(String(remoteId)))
    if (res.ok && res.data && res.data.task) return { known: true, task: res.data.task }
    // v1.3.3（复核 🟡4 / F4）：以前任何 404 都当「任务不存在」，随后把板子任务标 failed。
    // 但 404 也可能来自旧版 hub、反代或路由前缀变化 —— 那种情况下任务其实在跑，标 failed
    // 等于把一条正常任务判死。只有 hub 明确回答 error=task-unknown 才认定不存在。
    if (res.status === 404) {
      const code = String((res.data && (res.data.error || res.data.code || res.data.message)) || '')
      if (/task[-_]?unknown/i.test(code)) return { known: false }
      return { known: null, error: code || '404' }
    }
    return { known: null, error: res.error || res.status }
  }

  /** 回绑板子；失败就把"板子任务号 → 远程任务号"记下来，下一轮重试（复核 #4）。 */
  async function attachTask(taskId, remoteId, machineName) {
    // v1.3.0：绑一条不存在的远端任务 = 让板子永远停在"进行中"，所以先核实。
    const probe = await probeRemoteTask(remoteId)
    if (probe.known === false) {
      const marked = await call('POST', '/api/mark', {
        task_id: taskId,
        // v1.3.9（复核 D2）：板子 do_mark 比的是**执行机**（do_attach 写入的 t.machine），
        // 这里以前传调度器名 cfg.machine，多机部署下必 409「不是你占的」。
        machine: machineName,
        holder: INSTANCE_HOLDER,
        status: 'failed',
        note: '远端任务不存在（hub 上查不到 ' + remoteId + '），没有写入 remote_id；'
          + '副机上这条任务可能已被回收或从未建出来，请重新建单派发',
      })
      trace('attach skipped ' + taskId + ': 远端任务 ' + remoteId + ' 不存在'
        + (marked.ok ? '，已把板子任务标 failed' : '，标 failed 失败: ' + (marked.error || marked.status)))
      return { ok: false, status: 404, error: 'remote-missing' }
    }
    const out = await call('POST', '/api/attach', { task_id: taskId, remote_id: remoteId, machine: machineName })
    if (out.ok) {
      // v1.3.11（复核 D6）：记进本机账本 —— syncRemote 用它判断板上的 remote_id
      // 是否还是本机当初绑的那条（被别人重派过就不再回写）。
      rememberRemoteOwner(taskId, remoteId, machineName)
      // 记进 removed：save 时把这条从磁盘合并结果里剔掉，避免"补绑成功又被盘上旧记录复活"。
      pendingAttachRemoved.add(String(taskId))
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
      // v1.3.3（复核 🟡3）：上一轮标 blocked 失败过 → 60 秒内不再碰它。
      const retryAt = Number(pendingAttachRetryAt.get(String(taskId)) || 0)
      if (retryAt > Date.now()) continue
      const tries = Number(info.tries || 0)
      // v1.2.3（复核 S4）：以前无限重试（4 秒一次、约 5400 次），失败得再多也不告警。
      // 超过上限就升级成 blocked 让人看见；只有标记成功才丢弃待补绑记录。
      if (tries >= 20) {
        const marked = await call('POST', '/api/mark', {
          task_id: taskId,
          // v1.3.9（复核 D2）：同上 —— 归属校验按执行机，不按调度器。
          machine: info.machine || cfg.machine,
          holder: INSTANCE_HOLDER,
          status: 'blocked',
          note: '派工已发出（remote=' + info.remoteId + '）但回绑失败超过 ' + tries + ' 次，已停止自动重试；'
            + '副机上这条任务可能已经跑完，请人工核对后归档',
        })
        if (marked.ok) {
          pendingAttach.delete(String(taskId))
          pendingAttachRetryAt.delete(String(taskId))
          pendingAttachRemoved.add(String(taskId))
          savePendingAttach()
          trace('attach retry 放弃 ' + taskId + ' remote=' + info.remoteId + '：回绑失败 ' + tries + ' 次，已标 blocked')
        } else {
          // 失败也要退避：tries 已经停在 20，不分次数的话下一 tick 又会打一次。
          pendingAttachRetryAt.set(String(taskId), Date.now() + 60000)
          trace('attach retry 已达上限但标 blocked 失败 ' + taskId + ': ' + (marked.error || marked.status) + '（60 秒后再试）')
        }
        continue
      }
      const out = await attachTask(taskId, info.remoteId, info.machine)
      if (out.ok) {
        dispatchState.dispatched += 1
        // v1.3.7（复核 F9）：记下这一轮补绑成功的任务 —— escalate 跳过它，别把刚绑好的
        // 任务再判成"未澄清"并标 blocked。
        attachedThisRound.add(String(taskId))
        pendingAttachRetryAt.delete(String(taskId))
        trace('attach retried ok ' + taskId + ' remote=' + info.remoteId)
      } else if (out.error === 'remote-missing') {
        // v1.3.0：远端任务已经不存在了，再重试也没有意义 —— 板子那侧已经标了 failed，
        // 这里把待补绑记录清掉，别让它每小时再报一次错。
        pendingAttach.delete(String(taskId))
        pendingAttachRetryAt.delete(String(taskId))
        pendingAttachRemoved.add(String(taskId))
        savePendingAttach()
        trace('attach retry 停止 ' + taskId + ' remote=' + info.remoteId + '：远端任务不存在，已清理待补绑记录')
      } else {
        const n = (pendingAttach.get(taskId) || {}).tries || 1
        if (n % 5 === 1) trace('attach retry ' + taskId + ' #' + n + ' 仍未成功: ' + (out.error || out.status))
      }
    }
  }

  async function dispatchOnce() {
    if (disposed || dispatchState.dispatching) return 0
    dispatchState.dispatching = true
    dispatchState.lastTickAt = Date.now()
    let launched = 0
    try {
      // v1.3.7（复核 F9）：每一轮重新记账 —— 上一轮补绑成功的任务不该影响这一轮的判定。
      attachedThisRound.clear()
      // v1.3.3（复核 🟡4 / F7）：在途收尾（补绑、TTL 升级）对**所有角色**都要跑。
      // 以前 observer 闸门在第一行，连这两步都跳过 —— 一台从 owner 切成 observer 的
      // Host 手里可能还有已认领/待补绑的任务，切完就永远没人收尾，而且一行日志都没有。
      await retryPendingAttach()
      if (disposed) return launched
      await escalateExpiredJournal()
      if (disposed) return launched
      // v1.3.0（#10-2 · 调度所有权）：observer 只建单、不派工 —— 也不做 reconcile/untake，
      // 否则两台 Host 会互相把对方在跑的任务放回队列。
      if (cfg.dispatchRole === 'observer') {
        if (!observerRoleTraced) {
          observerRoleTraced = true
          trace('dispatch role=observer：本轮只做在途收尾（补绑 / 超期升级），不认领新任务')
        }
        return launched
      }
      // 面板清理期间暂停认领：清理是"读快照 → 逐条归档"，这几秒里若调度器把某条
      // queued 任务 take 走并派到副机，随后的 release 会把正在跑的任务作废。
      // pausedUntil 由 /api/board/ui/dispatch-pause 设置，且有上限、会自然过期。
      // 注意它只挡"认领新任务"：上面的在途收尾照跑，否则暂停 2 分钟里补绑也停了。
      if (Date.now() < dispatchState.pausedUntil) return launched
      // v1.2.3（复核 D3）：快照必须提到 reconcile **之前** —— 反查要拿到两样板上事实：
      // 这条任务是否已经回绑了 remote（说明副机上正跑着，绝不能 untake），
      // 以及哪些 remote 已被别的任务占用（避免两条板子任务绑同一条远端任务）。
      // 以前快照在后面，rc 完全看不见板上状态，崩在 attach 与删 journal 之间就会
      // 把正在跑的任务放回队列再派一条。
      let snap = await snapshot(0)
      if (!snap.ok) {
        // 板子读不到 = 这一轮什么都干不了，以前是静默 return 0（板上看不出任何异常）。
        if (Date.now() - lastSnapFailTrace > 60000) {
          lastSnapFailTrace = Date.now()
          trace('dispatch idle: 读板子失败 ' + (snap.error || snap.status || '') + (snap.hint ? '（' + snap.hint + '）' : ''))
        }
        return 0
      }
      if (disposed) return launched
      // v1.2.0（#10-1）：先把"结果未知"的在途派工查清楚 —— 它们可能已经在副机上跑了。
      // 这一步必须在挑新任务之前，也不能因为 queue 为空就跳过（否则未知记录永远悬着）。
      // v1.2.2（复核 中）：reconcile 里也有远端写（untake / mark），必须计入 inFlight，
      // 否则 dispatch-pause 会在它还没结束时声称"已经停手"。
      dispatchState.inFlight += 1
      reconcileTouchedBoard = false
      try {
        launched += await reconcileUnknownDispatches(snap)
      } finally {
        dispatchState.inFlight -= 1
      }
      if (disposed) return launched
      // reconcile 改过板子（补绑 / 放回 / 标 blocked）→ 快照已过期，重取一次再挑任务。
      if (reconcileTouchedBoard) {
        reconcileTouchedBoard = false
        const fresh = await snapshot(0)
        if (fresh.ok) snap = fresh
        if (disposed) return launched
      }
      // 复核存疑（v1.2.3）：stale 也可能是"别的机器认领后失联、但 remote 已经绑上"的任务，
      // 那种再派一遍就是双跑 —— 已绑 remote 的一律不进队列。
      const queue = snap.tasks.filter((t) => t.dispatch === 'auto'
        && (t.status === 'queued' || t.status === 'stale') && !t.remote)
      // v1.2.0（#10-1）：上一轮"已认领但没发出"的任务在板上是 claimed/running，不在 queue 里。
      // 单独捞出来补发；板上已经没有这条、或已经绑过 remote_id 的，就把日志条目丢掉。
      const byIdAll = new Map(snap.tasks.map((t) => [String(t.id), t]))
      const resume = []
      for (const [boardId, rec] of Array.from(dispatchJournal.entries())) {
        // v1.2.3（复核 D1）：released = "结果未知已澄清、已放回队列"。它留在 journal 里的
        // 唯一目的是**记住 attempts**（否则上限与 TTL 永远到不了）；任务本身会从 queue 正常进入
        // worklist，这里不补发，只做清理。
        if (rec.phase === 'released') {
          const rt = byIdAll.get(String(boardId))
          if (!rt || rt.remote) {
            journalDrop(boardId)
            trace('dispatch journal drop ' + boardId + '：' + (rt ? '板上已回绑' : '板上已无此任务') + '（released 清账）')
          }
          continue
        }
        // taking = take 已经发出但还没确认，语义与 claimed 相同（都表示"dispatch 一次没发过"）。
        if (rec.phase !== 'claimed' && rec.phase !== 'taking') continue
        // v1.3.4（复核 🔴-1/F4）：别人实例的在途记录不补发 —— resume 不过 /api/take，
        // 没有 holder 护栏的话 B 读到 A 的 taking 就直接 /dispatch，同一条任务跑两遍。
        if (!holderUsable(rec, boardId)) continue
        const t = byIdAll.get(String(boardId))
        // 复核 B3（v1.2.1）：snapshot() 映射后的字段叫 remote，不是 remote_id；
        // 写错字段名会让这条 drop 分支永远不成立，残留 claimed 会被直接补发 → 双跑。
        if (!t || t.remote) {
          journalDrop(boardId)
          trace('dispatch journal drop ' + boardId + '：' + (t ? '板上已回绑' : '板上已无此任务'))
          continue
        }
        // v1.2.1 复核（中）：板上由**别的机器**占着时，这不是"本机已认领未发出"，
        // 而是别人正在跑 —— 既不补发也不 take，留着条目等板子自己收敛（或 TTL 升级）。
        const holderIsUs = !t.taker || machineAlias(t.taker) === machineAlias(cfg.machine)
        if (!holderIsUs) {
          if (rememberOnce(heldTraced, boardId)) {
            trace('dispatch journal hold ' + boardId + '：板上由 ' + t.taker + ' 占着（不是本机），不补发')
          }
          continue
        }
        if (!queue.some((q) => String(q.id) === String(boardId))) resume.push(t)
      }
      const worklist = resume.concat(queue)
      if (!worklist.length) return 0
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
      if (!nodes.length) {
        // v1.1.12 观测补齐：remote-agent hub 没加载 / worker 全掉线时，这里曾一句话不留地
        // return 0。板上只能看到"任务一直 queued"，没有任何线索指向 hub —— 2026-11-07 的
        // 事故就是这样（profile 重建把 remote-agent 行丢了，19387 根本没有监听）。
        if (Date.now() - lastHubEmptyTrace > 60000) {
          lastHubEmptyTrace = Date.now()
          const why = !nodesRes.ok
            ? 'nodes 请求失败: ' + (nodesRes.error || nodesRes.status || 'unknown')
            : 'nodes=0'
          trace('dispatch idle: remote-agent 没有在线节点（' + why + '），检查 hub 是否加载、19387 是否在听、worker 是否连上')
        }
        return 0
      }
      const online = nodes.filter((n) => n && n.online !== false)
      for (const t of worklist) {
        if (disposed) break
        // 复核 #8：暂停可能在本轮 tick 中途才设置 —— 每条开始前重新确认，否则调用方
        // 收到 paused=true 之后，这一轮还会继续 take/dispatch（清理的竞态窗口没关上）。
        if (Date.now() < dispatchState.pausedUntil) {
          if (Date.now() - lastPausedTrace > 30000) {
            lastPausedTrace = Date.now()
            trace('dispatch paused mid-round, stop before ' + t.id)
          }
          break
        }
        const boardId = String(t.id)
        const journalRec = dispatchJournal.get(boardId)
        // v1.3.4（复核 🔴-1/F4）：这条任务如果在另一个实例手里还新鲜，本实例不认领。
        if (journalRec && !holderUsable(journalRec, boardId)) continue
        // v1.2.3（复核 D6）：升级 blocked 失败过的条目先歇 60 秒，别每个 tick 打一次板子。
        if (journalRec && Number(journalRec.blockRetryAt || 0) > Date.now()) continue
        // v1.2.3（复核 S2）：明确的失败先退避，别 4 秒一次地重试。
        const backoff = dispatchBackoff.get(boardId)
        if (backoff && Number(backoff.until || 0) > Date.now()) continue
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
        const goal = String(t.goal || t.title || '')
        const mode = t.mode === 'exec' ? 'exec' : 'agent'
        const workspace = String(t.workspace || '')
        // v1.2.0（#10-1）：上一轮已经认领、且板子上确实还由本机占着 —— 直接补发，不再 take。
        // 判据用板上现状（status/taker）而不是日志条目本身：journal 里写着 claimed、板上却
        // 还是 queued，说明那次 take 根本没落地（例如超时但没送达），必须重新认领。
        // v1.2.1 复核（中）：不校验认领归属会抢别人的单 —— 板上 taker 是另一台机器时
        // 只是"别人占着"，不是"本机已认领未发出"。
        const takerIsUs = !t.taker || machineAlias(t.taker) === machineAlias(cfg.machine)
        const resumeClaimed =
          Boolean(journalRec && (journalRec.phase === 'claimed' || journalRec.phase === 'taking')) &&
          takerIsUs &&
          (t.status === 'claimed' || t.status === 'running' || Boolean(t.taker))
        // v1.2.3（复核 D1）：attempts 有上限。到顶不再派，升级 blocked 让人看见；标记失败
        // 就留着条目退避重试 —— 绝不能既标不上又不留凭据。
        if (!resumeClaimed && Number((journalRec || {}).attempts || 0) >= MAX_DISPATCH_ATTEMPTS) {
          const marked = await call('POST', '/api/mark', {
            task_id: boardId,
            status: 'blocked',
            note: '派工结果不确定：已尝试 ' + Number(journalRec.attempts || 0) + ' 次仍未落地，已停止自动重派；'
              + '请人工确认副机上是否有同名任务，确认后手动放回队列',
          })
          if (marked.ok) {
            journalDrop(boardId)
            trace('dispatch unknown 达上限 ' + boardId + '（attempts=' + Number(journalRec.attempts || 0) + '），已标 blocked')
          } else {
            journalSet(boardId, { blockRetryAt: Date.now() + 60000 })
            trace('dispatch unknown 达上限 ' + boardId + '，标 blocked 失败（' + (marked.error || marked.status) + '），保留条目 60 秒后重试')
          }
          continue
        }
        // inFlight 包住 take→dispatch→attach：暂停接口要等它归零才能确认"已经停手"。
        dispatchState.inFlight += 1
        try {
        if (resumeClaimed) {
          trace('dispatch resume ' + boardId + ': 上一轮已认领未发出，直接补发（不重新 take）')
        } else {
          // v1.2.3（复核 S7）：take 之前先落一条 taking。崩在"take 成功、claimed 还没写"
          // 之间时，板上是本机 claimed、journal 里却什么都没有 —— queue 只收 queued/stale、
          // resume 只遍历 journal，这条任务就成孤儿，谁也管不到它。
          if (!journalSet(boardId, { nodeId: target, machine: machineName, goal, mode, workspace, phase: 'taking' })) {
            trace('dispatch hold ' + boardId + ': 状态落盘失败，本轮不认领（否则崩溃后会在副机上重复执行）')
            continue
          }
          const take = await call('POST', '/api/take', {
            task_id: boardId,
            machine: cfg.machine,
            minutes: 10,
            // v1.3.3（复核 F1）：同机可能有两个 DSH 进程，板子只看 machine 会把别人的
            // 占位当成自己的重入 —— 带上实例身份，第二个进程会收到 409 而不是继续派工。
            holder: INSTANCE_HOLDER,
          })
          if (!take.ok) {
            // v1.3.4（复核 🟡）：token 配错时 take 恒 401/403，被 isUnknownOutcome 归为
            // 「已知失败」后只退避，板子上一点痕迹都没有，看起来就是"永远不派工"。
            if ((take.status === 401 || take.status === 403) && Date.now() - lastAuthWarnAt > 60000) {
              lastAuthWarnAt = Date.now()
              trace('dispatch 认领被拒（HTTP ' + take.status + '）：板子鉴权不通过，检查本机 token 与板子 authTokens'
                + '（' + boardBase + '）')
            }
            if (isUnknownOutcome(take)) {
              // 认领结果未知：不能当成功往下派（可能没占上），也不能当失败重来 ——
              // 记 claimed，下一轮按板上 taker/status 判定到底占没占上。
              journalSet(boardId, {
                nodeId: target, machine: machineName, goal, mode, workspace,
                phase: 'claimed', lastError: 'take 结果未知：' + String(take.error || take.status),
              })
              trace('take unknown ' + boardId + ': ' + String(take.error || take.status) + '（下一轮按板上 taker 判定，不盲目重来）')
            } else {
              // 明确的拒绝（4xx / 已被人抢走）：退避后再试，别每 4 秒打一次。
              const wait = bumpBackoff(boardId, take.error || take.status)
              journalDrop(boardId)
              trace('take skip ' + boardId + ': ' + (take.error || take.status) + '（' + Math.round(wait / 1000) + ' 秒后再试）')
            }
            continue
          }
        }
        if (disposed) {
          // 已经认领但插件被卸载：把板子上的占位放掉，别留一条永远 running 的任务。
          await call('POST', '/api/untake', { task_id: boardId, machine: cfg.machine, note: '插件已卸载，未派发' }).catch(() => {})
          break
        }
        // 认领已确认，先把"已认领"落盘 —— 从这里到 dispatch 返回之间崩溃，下一轮还能补发。
        journalSet(boardId, { nodeId: target, machine: machineName, goal, mode, workspace, phase: 'claimed' })
        // v1.2.1（复核 B1）：真正发出之前就把相位改成 unknown 并记下 sentAt。
        // claimed 只允许表示"一次都没发出"；否则 POST 在飞时崩溃，下一轮会把
        // "可能已在副机上跑"的任务又补发一遍。
        const prevAttempts = Number((dispatchJournal.get(boardId) || {}).attempts || 0)
        // v1.2.3（复核 S3）：这条"结果未知"必须先落盘成功才允许发请求。写盘失败还发的话，
        // 崩在请求之后就是"副机上建了任务、本地一点记录都没有"，永远查不回来。
        const wroteUnknown = journalSet(boardId, {
          nodeId: target, machine: machineName, goal, mode, workspace,
          phase: 'unknown', sentAt: Date.now(), attempts: prevAttempts + 1, lastError: '',
        })
        if (!wroteUnknown) {
          await call('POST', '/api/untake', {
            task_id: boardId, machine: cfg.machine, note: '状态落盘失败，本轮不派发',
          }).catch(() => {})
          journalDrop(boardId)
          trace('dispatch hold ' + boardId + ': 结果未知相位写盘失败，本轮不派发（避免远端建单而本地无记录）')
          continue
        }
        const sent = await remoteUi('/dispatch', {
          goal,
          node: target,
          mode,
          // 复核 #21（v1.1.2）：remote-agent 对 exec 任务的默认审批是 manual ——
          // 不显式传 auto 的话，命令任务会静默挂在 pending_approval 等 30 分钟，
          // 板上却显示 running（syncRemote 只认终态）。默认 auto，可用
          // config.dispatchApproval: 'manual' 改回人工审批。
          approval: cfg.dispatchApproval,
          workspace: workspace || undefined,
        })
        if (!sent.ok) {
          if (isUnknownOutcome(sent)) {
            // v1.2.0（#10-1）核心：结果未知时**不 untake、不重派**。
            // 副机上这一刻可能已经在跑了，重派就是同一条任务跑两遍；下一轮由
            // reconcileUnknownDispatches() 拿 goal+创建时间反查，确认存在就只补绑。
            const why = String(sent.error || sent.status || 'unknown')
            journalSet(boardId, { nodeId: target, machine: machineName, goal, mode, workspace, phase: 'unknown', lastError: why })
            dispatchState.lastError = 'dispatch 结果未知：' + why
            trace('dispatch unknown ' + boardId + ' → ' + target + ': ' + why + '（先查远端再决定，不重派）')
            continue
          }
          dispatchState.lastError = String(sent.error || 'dispatch failed')
          // 明确的失败（hub 4xx 之类）：放回板子并退避，别每 4 秒重来一遍。
          const wait = bumpBackoff(boardId, dispatchState.lastError)
          journalDrop(boardId)
          await call('POST', '/api/untake', { task_id: boardId, machine: cfg.machine, note: '派发失败：' + dispatchState.lastError })
          trace('dispatch failed ' + boardId + ': ' + dispatchState.lastError + '（' + Math.round(wait / 1000) + ' 秒后再试）')
          continue
        }
        const taskId = String((sent.data && sent.data.taskId) || '')
        if (!taskId) {
          // 远程回 2xx 却没给 taskId：任务可能已经建了，同样属于"结果未知"，
          // 以前这里直接 untake 重来 = 可能派两遍。改成走查询。
          journalSet(boardId, { nodeId: target, machine: machineName, goal, mode, workspace, phase: 'unknown', lastError: 'dispatch 没有返回 taskId' })
          dispatchState.lastError = 'dispatch 没有返回 taskId'
          trace('dispatch unknown ' + boardId + ' → ' + target + ': 远程没有返回 taskId（先查远端再决定，不重派）')
          continue
        }
        // 复核 H3（v1.2.1）：journal 条目要活到 attach 有结论为止。以前先删条目再
        // attach，崩在中间的话板上任务 claimed、无 remote_id、无 pendingAttach、无
        // journal —— 没人再碰它，租约过期后被重派 → 双跑。
        const loadKey = machineAlias(machineName) || machineAlias(target)
        if (loadKey) load.set(loadKey, (load.get(loadKey) || 0) + 1)
        const attached = await attachTask(boardId, taskId, machineName)
        // attach 成功 → 绑定完成；失败 → attachTask 已写进 pendingAttach（只重试回绑）。
        // 两条路都不需要 journal 了。
        journalDrop(boardId)
        if (attached.ok) {
          dispatchState.dispatched += 1
          launched += 1
          dispatchBackoff.delete(boardId)
          trace('dispatched ' + boardId + ' → ' + target + ' remote=' + taskId)
        } else {
          // 复核 #4：远程已经在跑了，只是回绑失败 —— 记下来下轮只重试 attach。
          dispatchState.lastError = 'attach 失败：' + String(attached.error || attached.status)
          trace('attach failed ' + boardId + ' remote=' + taskId + '（下一轮重试回绑）: ' + String(attached.error || attached.status))
        }
        } finally {
          dispatchState.inFlight -= 1
        }
      }
    } catch (err) {
      dispatchState.lastError = String((err && err.message) || err)
      trace('dispatch loop error ' + dispatchState.lastError)
    } finally {
      dispatchState.dispatching = false
    }
    return launched
  }

  // 终态不止 completed/failed：aborted/interrupted/rejected 也是结束，
  // 旧前端只认前两个，这些任务永远停在 running（复核报告漏掉的一半）。
  const REMOTE_FINAL = { completed: 'done', failed: 'failed', aborted: 'failed', interrupted: 'failed', rejected: 'failed' }
  // 已在板上标注过"等待审批"的任务（避免每 6 秒重复写一次 note）。
  const pendingNoted = new Set()

  async function syncRemote() {
    if (disposed || dispatchState.syncing) return 0
    dispatchState.syncing = true
    dispatchState.lastSyncAt = Date.now()
    let changed = 0
    try {
      const snap = await snapshot(0)
      // 复核 #7（v1.1.8）：dispose 之后旧实例的 await 还会回来 —— 每次等待回来都要
      // 重新确认自己还活着，否则卸载瞬间挂起的请求返回后照样往板子上写。
      if (disposed) return 0
      if (!snap.ok) return 0
      // v1.4.0（D6 尾巴）：板上已经终态的任务不会再进 watched，插件也不会再回写它 ——
      // 账本条目这时已经没用了（板子自己的 reconcile 常常先一步标 done）。顺手清掉，
      // 否则要等下一次写入的 12h TTL 才过期。
      for (const t of snap.tasks) {
        if (!t.remote) continue
        if (t.status === 'done' || t.status === 'failed' || t.status === 'blocked' || t.status === 'superseded') {
          if (remoteOwners.has(String(t.id))) forgetRemoteOwner(t.id)
        }
      }
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
        // v1.3.11（复核 D6）：这里原来读 t.taker —— 但板子 do_attach 会把 taker/holder
        // pop 掉，watched 又只收有 remote 的任务，所以那个护栏在真板上从来没生效过（死代码）。
        // 改成用 journal 里我们当初绑定的 remote_id 对账：板上 remote_id 变了，说明这条
        // 已经被别的 Host 重新派过，本机不再回写（宁可少写一次，也不能覆盖别人的进度）。
        const own = remoteOwners.get(String(t.id))
        const mine = own && own.remoteId ? String(own.remoteId) : ''
        if (mine && t.remote && mine !== String(t.remote)) {
          if (rememberOnce(revokedTraced, t.id)) {
            trace('remote sync skip ' + t.id + ': 板上 remote_id 已变成 ' + t.remote
              + '（本机记的是 ' + mine + '），不再回写')
          }
          continue
        }
        const st = String(r.status || '')
        // 副机在等审批（remote-agent 对 exec 默认 manual）：板上标一次，别让
        // 用户看着 running 猜为什么没动静。
        if (st === 'pending_approval') {
          // 复核 #6：只有写成功才记"已标注"，否则一次网络抖动就会让这条任务
          // 永远不再尝试写 note（板上永远看不出它在等审批）。
          if (!pendingNoted.has(String(t.id))) {
            const noted = await call('POST', '/api/mark', {
              task_id: t.id,
              note: '等待副机审批（remote-agent 的 exec 任务默认 manual；给 Host 调度器配 dispatchApproval=auto 可跳过）',
            })
            if (noted.ok) {
              rememberOnce(pendingNoted, t.id)
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
          forgetRemoteOwner(t.id)
        }
      }
    } catch (err) {
      trace('remote sync error ' + String((err && err.message) || err))
    } finally {
      dispatchState.syncing = false
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
              allowAllRoots: cfg.allowAllRoots,
              envPassthrough: cfg.envPassthrough,
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

  // v1.4.0：热重载时旧实例的路由可能还没回收。以前第一条撞名就把整个插件 rollback，
  // 结果是「工具没了、面板没了、调度器半死」，只能整机重启。现在逐条降级：
  // 撞 duplicate 的只跳过并记下来（doctor 红条会指出来），其余照常装载。
  const degradedRoutes = []
  const routes = [
    {
      // v1.4.0：把"跑起来之后没人看着"变成面板上的一条红条。
      // 只读，不修任何东西；error 会挡住"一切正常"的错觉，warn 只提示。
      path: '/api/board/ui/doctor',
      handler: async (req, res) => {
        if (soloReady) {
          try {
            await soloReady
          } catch {
            /* 启动失败已 trace；下面按无 token 报错 */
          }
        }
        const checks = []
        const add = (id, level, message, hint) => checks.push({ id, level, message, hint: hint || '' })
        if (!cfg.token && !soloBoard) {
          add('config-token', 'error', '没有配置板子 token',
            '在 profile 的 team 块补 token；若刚被别的插件重写，从 cordis-patch-good-*.yml 取回那两块')
        }
        if (soloBoard) {
          add('solo', 'info', '本机板子已启动：' + soloBoard.url + '（仅本机可访问）',
            '要接入团队：在配置里填主机的 boardUrl 和 token 后重启；solo 状态在 ' + TEAM_STATE_DIR)
        }
        if (!cfg.machine) add('config-machine', 'warn', 'machine 为空，按主机名自动映射', '')
        if (cfgFromSaved.size) {
          add('config-saved', 'warn',
            '配置兜底自本地存档：' + [...cfgFromSaved].join(','),
            'profile 的 team 块又缺了这几项；存档在 ' + TEAM_CONFIG_FILE)
        }
        let snap = null
        try {
          snap = await snapshot(0)
        } catch (e) {
          add('board', 'error', '读板子异常：' + String((e && e.message) || e), '检查板子进程和防火墙')
        }
        if (snap && !snap.ok) {
          add('board', 'error', '板子连不上：' + String(snap.error || ''),
            String(snap.hint || '启动板子：pwsh scripts/install-board.ps1'))
        }
        if (snap && snap.ok) {
          const machines = Array.isArray(snap.machines) ? snap.machines : []
          const online = machines.filter((m) => m && m.online)
          if (!online.length) add('workers', 'error', '板子上没有任何机器在线', '三台机都要跑 DSH，并确认 remoteSyncMs 与网络')
          else if (online.length < machines.length) add('workers', 'warn', online.length + '/' + machines.length + ' 台在线', '')
          if (snap.updatedAgeSec != null && snap.updatedAgeSec > 120) {
            add('board-stale', 'warn', '板子 ' + snap.updatedAgeSec + 's 没有更新', '检查板子进程是否卡住')
          }
        }
        // hub：一个 worker 都没连上时，队列会永远排着；这类事故日志里只有一行 queued。
        try {
          const nr = await remoteUi('/nodes')
          const list = nr && nr.ok && nr.data && Array.isArray(nr.data.nodes) ? nr.data.nodes : []
          if (!nr || !nr.ok) {
            add('hub', 'error', 'hub /nodes 不可用：' + String((nr && (nr.error || nr.status)) || ''),
              '确认 19387 在监听、remote-agent 行没被 patch 重写吃掉')
          } else if (!list.length) {
            add('hub', 'error', 'hub 上一个 worker 都没连上', '副机 DSH 重启后才会重连；先看 19387 的 Established')
          }
        } catch (e) {
          add('hub', 'error', 'hub 查询异常：' + String((e && e.message) || e), '')
        }
        if (degradedRoutes.length) {
          add('routes', 'error', degradedRoutes.length + ' 条 UI 路由被上一个实例占着（本次降级加载）',
            '面板可能仍由旧实例应答；重启 DSH 才能彻底恢复：' + degradedRoutes.slice(0, 3).join(', '))
        }
        if (cfg.dispatchRole === 'owner') {
          const age = dispatchState.lastTickAt ? Date.now() - dispatchState.lastTickAt : -1
          if (age < 0) add('dispatch', 'warn', '调度器还没跑过第一轮', '刚启动可忽略')
          else if (age > Math.max(30000, cfg.dispatchTickMs * 5)) {
            add('dispatch', 'error', '调度器 ' + Math.round(age / 1000) + 's 没跑过（可能半死）',
              '热重载不安全；重启 DSH 后确认日志出现 host dispatcher started')
          }
          if (dispatchState.pausedUntil > Date.now()) {
            add('dispatch-paused', 'warn', '调度器被面板暂停到 ' + new Date(dispatchState.pausedUntil).toLocaleTimeString(), '')
          }
          if (dispatchState.lastError) add('dispatch-error', 'warn', '上一轮调度报错：' + clip(dispatchState.lastError, 160), '')
        }
        const bad = checks.filter((c) => c.level === 'error').length
        send(res, 200, {
          ok: bad === 0,
          version: PLUGIN_VERSION,
          role: cfg.dispatchRole,
          machine: cfg.machine,
          board: snap && snap.ok ? snap.board : (cfg.boardUrl || ''),
          configSource: cfgFromSaved.size ? 'saved' : 'patch',
          solo: !!soloBoard,
          checks,
          checkedAt: Date.now(),
        })
      },
    },
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
        // 复核 #8：只设 pausedUntil 不等于"已经停手"——本轮 tick 可能正卡在 take/dispatch
        // 之间。这里等 inFlight 归零（最多 3 秒）再回 ok，调用方拿到 paused=true 就能
        // 安全读快照并归档；新一轮 tick 入口与本轮每条任务前也都会重新检查暂停。
        let waitedMs = 0
        if (ms > 0) {
          const deadline = Date.now() + 3000
          while (dispatchState.inFlight > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            waitedMs += 50
          }
        }
        if (waitedMs > 0) trace('dispatch paused after waiting ' + waitedMs + 'ms for in-flight take')
        // v1.2.3（复核 S1）：`paused` 以前只要 ms>0 就是 true，可 inFlight 里可能正卡着
        // 一个 20 秒的写请求 —— 面板据此把 queued 条目 release 成 superseded，会把在途任务
        // 直接作废。现在 `paused` 只表示"此刻确实停手了"（inFlight 归零）。
        const stopped = dispatchState.inFlight === 0
        send(res, 200, {
          ok: true,
          ms,
          pausedUntil: dispatchState.pausedUntil,
          paused: ms > 0 && stopped,
          stopped,
          inFlight: dispatchState.inFlight,
          waitedMs,
        })
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

  // v1.3.7（三方复审 安全 F1）：这 12 条路由挂在 DSH 的 webserver 上，宿主只做了登录态，
  // 而它们是**同一台机器上的执行入口**：POST /create 可以带 mode=exec + dispatch=auto，
  // 调度器随后就会让 worker 跑任意 PowerShell。以前既不看 Origin 也不看 Host、更不要求
  // JSON，任意网页一个 simple POST 就能借道 —— 未鉴权 CSRF → RCE。
  //
  // 三道闸门（都不需要新密码，也不会把浏览器里的正常操作挡掉）：
  //   1) Host 必须是回环（可用 uiAllowedHosts 白名单放开内网访问），挡 DNS rebinding；
  //   2) 带 Origin 的请求必须与 Host 同源（跨站请求一律拒绝）；
  //   3) 写操作必须带自定义头 x-dsh-team-ui: 1 —— 浏览器对跨站请求不能加自定义头，
  //      没有预检就发不出去；同时要求 content-type: application/json。
  const uiAllowedHosts = new Set(
    (Array.isArray(cfg.uiAllowedHosts) ? cfg.uiAllowedHosts : [])
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean),
  )
  let lastUiDenyTrace = 0
  function uiGuard(req) {
    const headers = (req && req.headers) || {}
    const host = String(headers.host || '').toLowerCase()
    const hostName = host.replace(/:\d+$/, '')
    const loopback = hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '[::1]' || hostName === '::1'
    if (!loopback && !uiAllowedHosts.has(host) && !uiAllowedHosts.has(hostName)) return 'host'
    const origin = String(headers.origin || '')
    if (origin) {
      let oHost = ''
      try {
        oHost = new URL(origin).host.toLowerCase()
      } catch {
        return 'origin'
      }
      if (oHost !== host) return 'origin'
    }
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      if (String(headers['x-dsh-team-ui'] || '') !== '1') return 'token'
      const ct = String(headers['content-type'] || '').toLowerCase()
      if (!ct.includes('application/json')) return 'content-type'
    }
    return ''
  }

  try {
    for (const r of routes) {
      const handler = (req, res) => {
        const deny = uiGuard(req)
        if (deny) {
          if (Date.now() - lastUiDenyTrace > 60000) {
            lastUiDenyTrace = Date.now()
            trace('ui guard 拒绝 ' + String((req && req.method) || '') + ' ' + String((req && req.url) || '')
              + '：' + deny + '（Host=' + String((req && req.headers && req.headers.host) || '')
              + ' Origin=' + String((req && req.headers && req.headers.origin) || '') + '）')
          }
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'forbidden', why: deny }))
          return
        }
        try {
          const c = req && req.headers && req.headers.cookie
          if (c && !browserCookie) browserCookie = String(c)
        } catch {
          /* 记 cookie 只是兜底，失败不影响请求 */
        }
        return r.handler(req, res)
      }
      try {
        disposers.push(ctx.webServer.register({ kind: 'exact', path: r.path, handler }))
        trace(`route registered ${r.path}`)
      } catch (err) {
        const msg = String((err && err.message) || err)
        if (!/duplicate .* route/i.test(msg)) throw err
        degradedRoutes.push(r.path)
        trace(`route SKIPPED ${r.path}：${msg}（旧实例没回收，本实例降级加载）`)
        // 占位：回滚时不需要释放（这条本来就没注册成功）
        disposers.push(() => {})
      }
    }
  } catch (err) {
    // 半装载必须整体回滚：否则这次 apply 虽然失败了，已经注册的工具/路由还挂在宿主上，
    // 下一次装载会撞上自己上次留下的东西（2026-11-07 面板重载实测：上一实例的路由没回收，
    // 新实例第一条路由就 throw，插件面板直接 failed，只能重启 DSH）。
    trace(`route register FAILED: ${(err && err.message) || err}`)
    trace(`apply aborted before ready, rolling back ${disposers.length} resource(s)`)
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 已释放 */
      }
    }
    disposers.length = 0
    // 事件订阅同样要退订：它比路由注册得早，回滚范围必须覆盖到
    try {
      if (typeof agentUnsub === 'function') agentUnsub()
    } catch {
      /* 已释放 */
    }
    agentUnsub = null
    portedAgents.clear()
    if (err && /duplicate .* route/.test(String(err.message || ''))) {
      trace('提示：/api/board/ui/* 上还有上一个实例没回收的路由 —— 宿主这次卸载没有调用本插件的 cleanup，'
        + '热重载不安全，需要重启 DSH 才能装回 dsh-team。')
    }
    throw err
  }

  if (degradedRoutes.length) {
    trace(`degraded: ${degradedRoutes.length}/${routes.length} 条路由被旧实例占用 —— 工具与调度器已按新代码运行，`
      + '面板可能仍由旧实例应答；重启 DSH 可彻底恢复')
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
    // v1.3.3（复核 🟡8）：配置拼错时以前静默变 owner —— 一台本想"只建单"的机器会
    // 悄悄开始派工。这里把原值与归一化结果一起打出来，至少在日志里看得见。
    const rawRole = String(cfg.dispatchRoleRaw || '').trim().toLowerCase()
    if (rawRole && rawRole !== 'owner' && rawRole !== 'observer') {
      trace('dispatch role 配置值无法识别: "' + cfg.dispatchRoleRaw + '"，按 owner 运行（可选值只有 owner / observer）')
    }
    if (cfg.dispatchRole === 'observer') {
      // v1.3.0（#10-2）：observer 照旧回写自己派出去过的任务终态，但不派新工。
      trace('dispatch role=observer（这台 Host 只建单、不派工；派工交给 owner 那台）')
    }
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
    // 卸载路径必须有日志：2026-11-07 面板"禁用→启用"后的排障里，日志只有 apply 没有 dispose，
    // 看不出到底有没有人调过 cleanup（实际上是宿主没调），只能靠猜。
    trace(`dispose start resources=${disposers.length}`)
    // 复核 #7：先立 disposed 标志 —— 只清定时器的话，已经在飞的那一轮 dispatch/sync
    // 还会继续跑，把任务派出去或者回写板子。
    disposed = true
    // v1.3.3（复核 🟡2）：卸载路径上每一步都必须自己兜住异常 —— 以前只要保存状态那一步
    // 抛出来，后面的 disposers、定时器、agent 订阅就全跳过（禁用后旧定时器继续跑）。
    // 现在按"每一段一个 try"，并把失败写进日志（trace 本身也包一层，别让日志再中断清理）。
    const safeStep = (name, fn) => {
      try {
        fn()
      } catch (err) {
        try {
          trace('dispose step failed: ' + name + ' ' + String((err && err.code) || '') + ' ' + String((err && err.message) || err))
        } catch {
          /* 日志都写不了就别再往下拖 */
        }
      }
    }
    // 复核 #4：待回绑记录必须留在磁盘上 —— 新实例 apply 时 loadPendingAttach() 读回来接着补绑。
    safeStep('savePendingAttach', () => savePendingAttach())
    // v1.2.0（#10-1）：在途派工同理 —— 已认领/结果未知的条目留下，新实例接着收尾。
    safeStep('saveDispatchJournal', () => saveDispatchJournal())
    // v1.5.0：solo 板子随插件启停；关掉监听，状态文件留在磁盘上下次接着用。
    safeStep('soloBoard', () => {
      if (soloBoard) {
        soloBoard.close()
        soloBoard = null
      }
    })
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 已释放 */
      }
    }
    trace(`dispose released resources=${disposers.length}`)
    // #13：定时器和 agent 订阅原先都没人收，重载一次就多一套
    for (const t of [capsTimer, liveTimer, dispatchTimer, syncTimer]) {
      try {
        if (t) clearInterval(t)
      } catch {
        /* 已释放 */
      }
    }
    safeStep('agentUnsub', () => {
      if (typeof agentUnsub === 'function') agentUnsub()
    })
    agentUnsub = null
    portedAgents.clear()
    trace('dispose done')
  }
}

export const shortHelp = () => `${os.hostname()} → board`




