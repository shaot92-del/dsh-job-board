#!/usr/bin/env node
/**
 * 隔离重载冒烟（不连真实 DSH、不碰真实板子）
 *
 * 目的：验证 dsh-team 在「卸载 → 重新装载」时的资源回收是否符合 webserver 的真实语义。
 * 假 webserver 复刻 dsh-host-webserver 的 register()：同路径再注册即抛
 *   `webserver: duplicate <kind> route "<path>"`
 * 成功则返回一个按路径删除的 disposer —— 与 app.asar 里 dsh-host-webserver/lib/index.js:377-384 一致。
 *
 * 场景 A：正常重载（旧实例先 cleanup，再 apply 新实例）→ 必须干净、不撞名
 * 场景 B：旧实例没被 dispose（DSH 面板「禁用→启用」时的真实形态）→ 记录失败形态
 *
 * 退出码 0 表示 A 全过；B 只记录现象，不计入失败。
 */
import { apply } from '../lib/index.js'

class FakeWebServer {
  constructor() {
    this.exact = new Map()
    this.prefixes = new Map()
  }

  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => {
      // 只删自己那一条：旧实例的 disposer 不该把新实例的同名路由带走
      if (table.get(route.path) === route) table.delete(route.path)
    }
  }
}

function makeCtx(ws) {
  const tools = new Map()
  const subs = []
  const base = {
    tools: {
      register: (t) => {
        tools.set(t.name, t)
        return () => {
          // 真服务的 disposer 也只摘自己那一条；按名字无脑删会误伤新实例的同名工具
          if (tools.get(t.name) === t) tools.delete(t.name)
        }
      },
    },
    webServer: ws,
    get: () => undefined,
    on: (event, fn) => {
      subs.push({ event, fn })
      return () => {
        const i = subs.findIndex((s) => s.event === event && s.fn === fn)
        if (i >= 0) subs.splice(i, 1)
      }
    },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  // 复刻 cordis ctx 的一个关键约束：服务属性不能在派生上下文里再赋值，
  // 否则真宿主会抛 `cannot set property "tools" in multiple fibers`（v1.1.11 首版就栽在这）。
  const ctx = new Proxy(base, {
    set(target, prop, value) {
      if (prop === 'tools' || prop === 'webServer') {
        throw new Error(`cannot set property "${String(prop)}" in multiple fibers`)
      }
      target[prop] = value
      return true
    },
  })
  return { ctx, tools, subs }
}

const cfg = {
  boardUrl: 'http://127.0.0.1:9', // 关闭的端口：任何网络调用都快速失败，不碰真实板子
  machine: 'harness',
  autoDispatch: false,
  timeoutMs: 300,
  allowedRoots: [],
}

let failed = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) failed += 1
}

/* 场景 A：正常重载 */
console.log('— 场景 A：apply → cleanup → apply（正常重载）')
{
  const ws = new FakeWebServer()
  const a = makeCtx(ws)
  const clean1 = apply(a.ctx, cfg)
  check(typeof clean1 === 'function', 'A1 apply 返回 cleanup 函数')
  check(ws.exact.size === 12, `A2 首次注册 12 条路由（实际 ${ws.exact.size}）`)
  const toolCount = a.tools.size
  check(toolCount > 0, `A3 工具已注册（${toolCount} 个）`)

  clean1()
  check(ws.exact.size === 0, `A4 cleanup 后路由清空（实际 ${ws.exact.size}）`)
  check(a.tools.size === 0, `A5 cleanup 后工具清空（原 ${toolCount}，剩 ${a.tools.size}）`)
  check(a.subs.length === 0, `A6 cleanup 后事件订阅退订（剩 ${a.subs.length}）`)

  const b = makeCtx(ws)
  let err = null
  let clean2 = null
  try {
    clean2 = apply(b.ctx, cfg)
  } catch (e) {
    err = e
  }
  check(!err, `A7 重载到同一 webserver 不撞名${err ? '：' + err.message : ''}`)
  check(ws.exact.size === 12, `A8 新实例注册 12 条路由（实际 ${ws.exact.size}）`)
  if (typeof clean2 === 'function') clean2()
}

/* 场景 B：旧实例没被 dispose —— 面板「禁用→启用」的真实形态 */
console.log('\n— 场景 B：旧实例未 cleanup 就再 apply（DSH 重载实测形态）')
{
  const ws = new FakeWebServer()
  const a = makeCtx(ws)
  apply(a.ctx, cfg) // 故意不调用 cleanup，模拟宿主没卸载旧实例
  const b = makeCtx(ws)
  let err = null
  try {
    apply(b.ctx, cfg)
  } catch (e) {
    err = e
  }
  console.log(
    err
      ? `ℹ️ 第二次 apply 抛出：${err.message}`
      : 'ℹ️ 第二次 apply 没抛错（说明已做自愈）',
  )
  console.log(`ℹ️ 路由表里现在 ${ws.exact.size} 条（12 = 旧实例仍在提供服务）`)
}

/* 场景 C：注册到一半失败 —— 必须整体回滚，不能留半套工具/路由在宿主上 */
console.log('\n— 场景 C：注册第 5 条路由时抛错（半装载回滚）')
{
  class FlakyWebServer extends FakeWebServer {
    constructor(failAt) {
      super()
      this.failAt = failAt
      this.calls = 0
    }
    register(route) {
      this.calls += 1
      if (this.calls === this.failAt) throw new Error(`webserver: boom on ${route.path}`)
      return super.register(route)
    }
  }
  const ws = new FlakyWebServer(5)
  const a = makeCtx(ws)
  let err = null
  try {
    apply(a.ctx, cfg)
  } catch (e) {
    err = e
  }
  check(err !== null, `C1 半装载如实抛错（${err ? err.message : '没抛'}）`)
  check(ws.exact.size === 0, `C2 失败后已注册的 4 条路由被回滚（剩 ${ws.exact.size}）`)
  check(a.tools.size === 0, `C3 失败后工具被回滚（剩 ${a.tools.size}）`)
  check(a.subs.length === 0, `C4 失败后事件订阅被退订（剩 ${a.subs.length}）`)
}

console.log(failed ? `\n${failed} 项未通过` : '\n场景 A/C 全部通过')
process.exit(failed ? 1 : 0)
