#!/usr/bin/env node
/**
 * client-render-smoke.mjs —— 面板「渲染一次」的结构化回归（v2.6.13）。
 *
 * 背景：lib/client.js 是浏览器静态 bundle，仓库里没有 react / 没有浏览器测试环境，
 * 于是「面板到底能不能渲染出某段文案」长期只能靠人肉刷新页面确认。v2.6.13 的面板
 * 版本号被问过 4 次没做，一半原因就是没有可断言的点（版本号当时只藏在自检横幅里，
 * doctor 全绿时横幅根本不渲染）。
 *
 * 做法：用 vm 跑真实 bundle，把 React 换成只实现 createElement/useState/useEffect
 * 的假实现（client.js 只用这三个 API，见 grep `React\.\w+`），DOM/宿主全局给最小
 * 桩。bundle 走 window.__ModuleLoader__.load 注册，apply(ctx) 会通过 ctx.slots.inject
 * 把 Panel 注册到 'main' 槽位 —— 抓到组件直接调用即可拿到完整元素树。
 *
 * 断言（两轮）：
 *   1) 原样渲染：标题「多机调度台」旁边出现「插件 v<package.version>」pill，
 *      且 pill 排在「待办」计数之前（标题区，不是掉到页面末尾）。
 *   2) 把 doctor 的初始 state 换成「运行旧 / 磁盘新 / 远端更新」三态，断言
 *      「→ 磁盘 vX」「↑ vX」出现，title 里有「重启 DSH 后生效」。
 *
 * 这是**结构**测试，不是视觉测试：不校验颜色/间距，只保证渲染不抛错、
 * 关键文案在正确的容器里。运行：node scripts/client-render-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
// v2.7.1：支持 SMOKE_BUNDLE=<path> 指向任意 client bundle，用来做「历史崩溃版必须 FAIL」的对照。
// 例：SMOKE_BUNDLE=case/lib-client-2.7.0-crash.bak node scripts/client-render-smoke.mjs  → 期望 exit 1 + #130
const CLIENT = process.env.SMOKE_BUNDLE ? path.resolve(process.env.SMOKE_BUNDLE) : path.join(root, 'lib', 'client.js')
const RAW = fs.readFileSync(CLIENT, 'utf8')

const results = []
function check(name, cond, detail) {
  results.push({ name, cond: Boolean(cond), detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 严格模式：仿 React 的合法性校验，把「对象当节点类型(#130)」「对象当 child(#31)」变成可断言的异常。 */
let strictValidate = true
const ELEMENT_TAG = Symbol.for('react.element')

/**
 * 最小 React 假实现（client.js 只用 createElement / useState / useEffect）。
 * v2.7.1 起默认**严格**：type 只接受 string / function / symbol，child 不接受普通对象 ——
 * 这正是 2.7.0 白屏（`h(h('div'),… )` 把元素对象当 type）在线上炸掉的同一条规则。
 */
function makeReact(states) {
  let hookIdx = 0
  let refIdx = 0
  const refs = []
  const React = {
    createElement(type, props, ...children) {
      if (strictValidate) {
        const t = typeof type
        if (type !== null && type !== undefined && t !== 'string' && t !== 'function' && t !== 'symbol') {
          throw new Error(
            'Minified React error #130: expected a string (for built-in components) or a class/function ' +
              '(for composite components) but got: ' + t + '（client bundle 把对象当成了节点类型）',
          )
        }
        for (const c of children.flat(8)) {
          if (c && typeof c === 'object' && !Array.isArray(c) && c.$$typeof === undefined) {
            let keys = []
            try {
              keys = Object.keys(c).slice(0, 8)
            } catch {
              keys = []
            }
            throw new Error('Minified React error #31: Objects are not valid as a React child（keys=' + keys.join(',') + '）')
          }
        }
      }
      return {
        $$typeof: ELEMENT_TAG,
        type,
        props: props || {},
        children: children.flat(4).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    // v2.7.4：setter 真实生效（写入 states 槽位），配合 __resetHooks 可重渲染组件 ——
    // 评估卡超时链路必须「点击 → loading → 超时 → error 卡」全程驱动，布尔桩（()=>{}）做不到。
    useState(init) {
      const i = hookIdx++
      if (i >= states.length) states.push(typeof init === 'function' ? init() : init)
      return [
        states[i],
        (nv) => {
          states[i] = typeof nv === 'function' ? nv(states[i]) : nv
        },
      ]
    },
    useEffect() {},
    // v2.7.19：client 里用 useRef 做「同步锁」（防连点重复派工）。
    // 假实现按引用持久化一份，语义与真 React 对齐：同一组件实例跨渲染拿同一个 current 对象。
    useRef(init) {
      const i = refIdx++
      if (i >= refs.length) refs.push({ current: init })
      return refs[i]
    },
    __resetHooks() {
      hookIdx = 0
      refIdx = 0
      hookIdx = 0
    },
  }
  return React
}

/** 宿主全局最小桩：DOM 只做到「不抛错」，Pet 挂载失败会被 bundle 自己 try/catch 掉。
 * v2.7.4：opts 可控 —— fetch（评估链路桩）、deferTimeouts（超时定时器手动 flush）、
 * localStorage（needsAssessment 兜底记录种子）、AbortController（vm context 不自带，必须注入）。 */
function makeSandbox(React, opts = {}) {
  const el = () => ({
    id: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    remove() {},
    focus() {},
  })
  const els = []
  const timers = []
  const lsStore = Object.assign({}, opts.localStorage || {})
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React,
    AbortController,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => {
      if (opts.deferTimeouts) {
        timers.push(fn)
        return timers.length
      }
      try {
        fn()
      } catch {
        /* 忽略 */
      }
      return 0
    },
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: opts.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(type) {
        this.type = type
      }
    },
    document: {
      body: el(),
      head: el(),
      documentElement: el(),
      getElementById: (id) => els.find((e) => e.id === id) || null,
      createElement: () => {
        const node = el()
        els.push(node)
        return node
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: 'client-render-smoke' },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null),
      setItem: (k, v) => {
        lsStore[k] = String(v)
      },
      removeItem: (k) => {
        delete lsStore[k]
      },
    },
  }
  sandbox.__timers = timers
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.addEventListener = () => {}
  sandbox.window.removeEventListener = () => {}
  sandbox.window.dispatchEvent = () => true
  sandbox.__module = null
  sandbox.window.__ModuleLoader__ = {
    load({ factory }) {
      sandbox.__module = factory((name) => {
        if (name === 'react') return sandbox.React
        throw new Error('client bundle require 了不允许的模块：' + name)
      })
    },
  }
  return sandbox
}

/**
 * 渲染一轮，返回 Panel 的元素树。
 * v2.7.4：opts 透传给 makeSandbox（fetch 桩 / deferTimeouts / localStorage 种子）；
 * 返回值带 rerender()/flushTimers()，供评估卡交互链路用例驱动状态机。
 * @param {string} src  bundle 源码（默认原样；第二轮会把 doctor 的初始 state 换掉）
 * @param {object} opts makeSandbox 选项
 */
function renderOnce(src, opts = {}) {
  const states = []
  const React = makeReact(states)
  const sandbox = makeSandbox(React, opts)
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })

  const mod = sandbox.__module
  if (!mod || typeof mod.apply !== 'function') throw new Error('client bundle 没有导出 apply（window.__ModuleLoader__.load 没被调用？）')

  const injected = []
  const registered = []
  const ctx = {
    tools: { register: () => () => {} },
    slots: {
      inject(name, fn) {
        injected.push([name, fn])
        return () => {}
      },
      register(spec, comp) {
        registered.push({ spec, comp })
        return () => {}
      },
    },
    get: () => null,
    effect: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const dispose = mod.apply(ctx)
  for (const [, fn] of injected) fn()

  const main = registered.find((r) => r.spec && r.spec.name === 'main')
  if (!main || typeof main.comp !== 'function') {
    throw new Error('没拿到 main 面板组件（slots.register 注册表：' + JSON.stringify(registered.map((r) => r.spec)) + '）')
  }
  const tree = main.comp()
  try {
    if (typeof dispose === 'function') dispose()
  } catch {
    /* 卸载失败不影响断言 */
  }
  return {
    tree,
    states,
    sandbox,
    // 重渲染：hook 按调用序复用 states 槽位（setter 已写入的值生效）
    rerender() {
      React.__resetHooks()
      return main.comp()
    },
    // 手动触发 deferTimeouts 模式下排队的定时器（评估 15s 超时就用这条路径）
    flushTimers() {
      const queued = sandbox.__timers.splice(0)
      for (const fn of queued) {
        try {
          fn()
        } catch {
          /* 定时器回调异常不算渲染失败 */
        }
      }
      return queued.length
    },
  }
}

function flattenText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) flattenText(n, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const n of node.children) flattenText(n, out)
  }
  return out
}

function findByClass(node, cls) {
  if (!node || typeof node !== 'object') return null
  if (node.props && node.props.className === cls) return node
  const kids = Array.isArray(node) ? node : node.children || []
  for (const k of kids) {
    const got = findByClass(k, cls)
    if (got) return got
  }
  return null
}

// ── 第 1 轮：原样渲染 ────────────────────────────────────────────────────────
const plain = renderOnce(RAW)
const plainTexts = flattenText(plain.tree)
const head = findByClass(plain.tree, 'dsb-head')
const headTexts = head ? flattenText(head) : []

check('渲染不抛错，拿到 dsb-head', Boolean(head))
check(`标题旁出现「插件 v${pkg.version}」`, plainTexts.includes(`插件 v${pkg.version}`), JSON.stringify(plainTexts.filter((t) => /插件 v/.test(t))))
check(
  '版本 pill 在标题区（排在「待办」之前）',
  headTexts.findIndex((t) => /^插件 v/.test(t)) >= 0 && headTexts.findIndex((t) => /^插件 v/.test(t)) < headTexts.findIndex((t) => /待办/.test(t)),
  'header 文本序：' + JSON.stringify(headTexts.slice(0, 8)),
)
const pill = head ? flattenText(findByClass(head, 'dsb-pill dsb-v')).join('') : ''
check('版本 pill 有 dsb-pill dsb-v 样式钩子', pill.includes(`插件 v${pkg.version}`), JSON.stringify(pill))

// ── 第 1.5 轮：头部三组收容（14 寸屏折叠的 DOM 前提）───────────────────────
function countByClass(node, cls) {
  if (!node || typeof node !== 'object') return 0
  const kids = Array.isArray(node) ? node : node.children || []
  let n = node.props && node.props.className === cls ? 1 : 0
  for (const k of kids) n += countByClass(k, cls)
  return n
}

const brand = head ? findByClass(head, 'dsb-brand') : null
const meta = head ? findByClass(head, 'dsb-meta') : null
const acts = head ? findByClass(head, 'dsb-acts') : null
check('标题+版本在同一个 dsb-brand 组里', Boolean(brand) && flattenText(brand).some((t) => /^插件 v/.test(t)) && flattenText(brand).includes('多机调度台'), brand ? JSON.stringify(flattenText(brand)) : 'null')
check('四个计数 pill 在 dsb-meta 组里', Boolean(meta) && flattenText(meta).filter((t) => /^(待办|进行|完成|打回) /.test(t)).length === 4, meta ? JSON.stringify(flattenText(meta)) : 'null')
check('按钮在 header 内的 dsb-acts 组里（没有丢按钮）', Boolean(acts) && countByClass(acts, 'dsb-btn') === 9, 'dsb-btn 数量=' + countByClass(acts, 'dsb-btn'))
// v2.6.27（盘古审计 P0）：维护写通道必须在面板上可达 ——
// mode 选择器、票据输入框、以及 create 请求体里的 maint_ticket 三者缺一不可。
check('派工弹窗有类型选择器（agent/exec/maint）', RAW.includes("'类型'") && RAW.includes("'maint · 只读诊断 / 签名写动作'") && RAW.includes("h('option', { value: 'maint' }"), 'taskMode select')
check('maint 模式有票据输入框', RAW.includes("placeholder: 'ticket= 后面那串") && RAW.includes('setTicket(e.target.value)'), 'ticket textarea')
check('建单请求会带 maint_ticket', RAW.includes("maint_ticket: taskMode === 'maint'"), 'doDispatch maint_ticket')
check('写动词缺票时前端拦下并提示', RAW.includes('写动词需要票据'), 'guard')
// v2.6.29（U-4）：worker 状态小卡 + drain/resume —— 三条结构断言。
check('worker 卡存在（数据源 /worker-status）', RAW.includes('dsb-worker-card') && RAW.includes("API + '/worker-status'"), 'worker card')
check(
  'worker 卡有 drain / resume 两个按钮',
  RAW.includes('dsb-worker-drain') && RAW.includes('dsb-worker-resume') && RAW.includes("workerControl('drain')") && RAW.includes("workerControl('resume')"),
  'drain/resume buttons',
)
check(
  'enabled=false 时整卡不渲染（workerOn 守卫）',
  RAW.includes('const workerOn = !!(workerStat && workerStat.ok !== false && workerStat.enabled)') && /workerOn\s*\?\s*h\(/.test(RAW),
  'workerOn guard',
)

check('窄屏折叠样式存在（@media ≤980px + dsb-sub 让位）', RAW.includes('@media (max-width:980px)') && RAW.includes('.dsb-head .dsb-sub{display:none}') && RAW.includes('@media (max-width:1240px)'), 'media queries')

// v2.7.0（W4）：窄屏收敛两条 —— 只断言媒体查询结构，不做视觉校验。
// 包体里 CSS 是一个字符串数组，每条规则一行，所以按行取出对应媒体查询再查关键字。
const mq1100 = (RAW.match(/@media \(max-width:1100px\)\{[^\n]*/) || [''])[0]
const mq900 = (RAW.match(/@media \(max-width:900px\)\{[^\n]*/) || [''])[0]
check(
  '窄屏 ≤1100px：机器卡改单列纵向堆叠（flex-direction:column + 容器 100%）',
  mq1100.includes('flex-direction:column') && mq1100.includes('width:100%') && RAW.includes("className: 'dsb-mach-grid'"),
  mq1100.slice(0, 160),
)
check(
  '窄屏 ≤900px：隐藏次要列（dsb-col-id 走 display:none，不压字号）',
  mq900.includes('.dsb-col-id{display:none}') && RAW.includes("className: 'dsb-id dsb-col-id'") && !/font-size/.test(mq900),
  mq900.slice(0, 160),
)

// ── 第 2 轮：doctor 三态（运行旧 / 磁盘新 / 远端更新）─────────────────────
const DOCTOR_ANCHOR = 'const [doctor, setDoctor] = React.useState(null)'
const fakeDoctor = { version: '2.6.12', installedVersion: '2.6.13', latestVersion: '2.6.14', updateAvailable: true, role: 'owner', ok: true, checks: [] }
const patched = RAW.replace(DOCTOR_ANCHOR, 'const [doctor, setDoctor] = React.useState(' + JSON.stringify(fakeDoctor) + ')')
check('doctor 初始 state 可被注入（锚点存在）', patched !== RAW, DOCTOR_ANCHOR)

if (patched !== RAW) {
  const skew = renderOnce(patched)
  const skewTexts = flattenText(skew.tree)
  const skewHead = findByClass(skew.tree, 'dsb-head')
  const skewPillNode = skewHead ? findByClass(skewHead, 'dsb-pill dsb-v') : null
  const pillText = skewPillNode ? flattenText(skewPillNode).join('') : ''
  check('运行版本用 doctor.version', pillText.includes('插件 v2.6.12'), JSON.stringify(pillText))
  check('磁盘版本不同 ⇒ 显示「→ 磁盘 v2.6.13」', pillText.includes('→ 磁盘 v2.6.13'), JSON.stringify(pillText))
  check('有新版 ⇒ 显示「↑ v2.6.14」', pillText.includes('↑ v2.6.14'), JSON.stringify(pillText))
  check('提示「重启 DSH 后生效」', String((skewPillNode && skewPillNode.props && skewPillNode.props.title) || '').includes('重启 DSH 后生效'), String((skewPillNode && skewPillNode.props && skewPillNode.props.title) || ''))
  check('doctor 三态下不再重复渲染版本横幅（自检全绿）', !skewTexts.some((t) => t.startsWith('自检：')))
}

// ── 第 3 轮：派工弹窗（v2.7.1 回归 —— 2.7.0 在这里 #130 白屏）────────────────
// 场景：ask=true + summary.nodeModels 非空（GT14/PC2 真实形态）+ defaultModel 非空。
// 2.7.0 的 `return h( h('div',…), …, 'div', {…} )` 会在这里被严格假 React 判 #130。
const ASK_ANCHOR = 'const [ask, setAsk] = React.useState(false)'
const DATA_ANCHOR = 'const [data, setData] = React.useState(null)'
const fakeSummary = {
  ok: true,
  counts: { queued: 1, running: 0, done: 3, bad: 0, stale: 0 },
  machines: [
    { id: 'host', name: 'host', online: true, caps: { models: [] } },
    { id: 'GT14', name: 'GT14', online: true, caps: { models: [] } },
    { id: 'PC2', name: 'PC2', online: true, caps: { models: [] } },
  ],
  nodeModels: {
    gt14: {
      models: [
        { provider: 'deepseek-account', model: 'deepseek-flash', name: 'DeepSeek Flash', location: 'cloud' },
        { provider: 'local-llama', model: 'qwen35-9b', name: 'Qwen3.5 9B', location: 'local' },
      ],
      defaultModel: null,
    },
    pc2: {
      models: [{ provider: 'deepseek-account', model: 'deepseek-flash', name: 'DeepSeek Flash', location: 'cloud' }],
      defaultModel: null,
    },
  },
  defaultModel: 'deepseek-account/deepseek-flash',
  tasks: [],
  nodeMap: {},
}
let askPatched = RAW.replace(ASK_ANCHOR, 'const [ask, setAsk] = React.useState(true)')
askPatched = askPatched.replace(DATA_ANCHOR, 'const [data, setData] = React.useState(' + JSON.stringify(fakeSummary) + ')')
check('派工弹窗测试锚点存在（ask/data 初始 state 可注入）', askPatched !== RAW, ASK_ANCHOR + ' / ' + DATA_ANCHOR)

if (askPatched !== RAW) {
  let dlg = null
  let dlgErr = ''
  try {
    dlg = renderOnce(askPatched)
  } catch (e) {
    dlgErr = String((e && e.message) || e)
  }
  check('派工弹窗渲染不抛错（2.7.0 此处 #130）', dlg !== null && dlgErr === '', dlgErr.slice(0, 200))
  if (dlg) {
    const dlgTexts = flattenText(dlg.tree)
    check('派工弹窗含「类型」「模型」两行', dlgTexts.includes('类型') && dlgTexts.includes('模型'), JSON.stringify(dlgTexts.filter((t) => t === '类型' || t === '模型')))
    check('模型下拉渲出清单里的模型（本地/云都有）', dlgTexts.some((t) => /Qwen3\.5 9B/.test(t)) && dlgTexts.some((t) => /DeepSeek Flash/.test(t)), JSON.stringify(dlgTexts.filter((t) => /Qwen|DeepSeek/.test(t)).slice(0, 6)))
    check('有团队默认模型时提示可见', dlgTexts.some((t) => /跟随副机默认（团队默认 deepseek-account\/deepseek-flash）/.test(t)), JSON.stringify(dlgTexts.filter((t) => /跟随副机默认/.test(t))))
  }
}

// 负向用例：把历史缺陷形态（h(h('div',null), 'x')）喂给同一个严格假 React，必须报 #130。
// 这条保证「门禁真的能抓到 2.7.0 那类错误」，而不是只保证当前代码碰巧不崩。
{
  let caught = ''
  const states = []
  const bad = makeSandbox(makeReact(states))
  bad.__bad = null
  vm.createContext(bad)
  try {
    vm.runInContext("const h = (t, ...a) => React.createElement(t, ...a); __bad = h(h('div', null), 'x')", bad, { filename: 'bad-nested-h.js' })
  } catch (e) {
    caught = String((e && e.message) || e)
  }
  check('严格假 React 能抓到「元素对象当 type」（#130 同型）', /#130/.test(caught), caught.slice(0, 160))
}

// ── 第 4 轮：评估卡四态 + 15s 超时重试 + needsAssessment 本机兜底（v2.7.4 UI-1/UI-2 + MC-1..4）───
// 故障 A：2.7.3 runAssess 裸 fetch 无超时（client.js:839 基线），服务端 assess 卡住 ⇒ 永久转圈。
// 故障 B：服务端 saveIdentity 写盘失败只 trace（index.js:817-827 基线）⇒ needsAssessment 恒 true，
//         面板重挂（切「对话」再回来）被重新拉回引导卡。
// 负向门禁：下面 6 条静态断言对旧 bundle（case/lib-client-2.7.0-crash.bak）必须 FAIL。
check('评估请求有 15s 客户端超时（ASSESS_TIMEOUT_MS=15000）', RAW.includes('const ASSESS_TIMEOUT_MS = 15000'), 'ASSESS_TIMEOUT_MS')
check('评估 fetch 带 AbortController（signal 传入，超时可中止）', RAW.includes('new AbortController()') && RAW.includes('signal: assessAbortCtl'), 'AbortController')
check('超时/失败有专属错误卡且给「重试」出口', RAW.includes('dsb-assess-retry') && RAW.includes('评估超时'), 'dsb-assess-retry')
check('评估成功写本机兜底记录（dsh-assess-done-v1）', RAW.includes("ASSESS_DONE_KEY = 'dsh-assess-done-v1'"), 'dsh-assess-done-v1')
check('写盘失败降级只提示一次（dsh-assess-degrade-notified-v1 + 「不再重复弹出」）', RAW.includes("ASSESS_DEGRADE_NOTIFIED_KEY = 'dsh-assess-degrade-notified-v1'") && RAW.includes('不再重复弹出'), 'degrade-notified')
check('评估卡按 phase 四态渲染（idle/loading/success/error）', ["'loading'", "'error'", "'success'", "'idle'"].every((p) => RAW.includes('assessPhase === ' + p)), 'assessPhase 四分支')
// v2.7.4 主控修订 MC-1/MC-3 的静态锚点（复核反证 1/P1、反证 3/P1）
check('本机兜底记录有 TTL（ASSESS_DONE_TTL_MS），不再永久压制服务端 needsAssessment', RAW.includes('const ASSESS_DONE_TTL_MS = ') && RAW.includes('Date.now() - rec.assessedAt > ASSESS_DONE_TTL_MS'), 'ASSESS_DONE_TTL_MS')
check('兜底记录带 caps 摘要（capsDigest），硬件变了即失效', RAW.includes('function capsDigest(caps)') && RAW.includes('rec.capsDigest !== digest'), 'capsDigest')
check('评估成功后的二段 /identity 刷新失败不翻成 error 卡（解耦）', RAW.includes('.then((r) => r.json())') && RAW.includes('.catch(() => null)'), 'identity-decoupled')

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && flattenText(node).indexOf(label) >= 0) return node
  const kids = Array.isArray(node) ? node : node.children || []
  for (const k of kids) {
    const got = findButton(k, label)
    if (got) return got
  }
  return null
}

const IDENT_ANCHOR = 'const [ident, setIdent] = React.useState(null)'
const PHASE_ANCHOR = "const [assessPhase, setAssessPhase] = React.useState('idle')"
const ERR_ANCHOR = "const [assessErr, setAssessErr] = React.useState('')"
const fakeIdent = { ok: true, machine: 'GT14', needsAssessment: true, assessed: false, assessedAt: 0, caps: null }
const identPatched = RAW.replace(IDENT_ANCHOR, 'const [ident, setIdent] = React.useState(' + JSON.stringify(fakeIdent) + ')')
check('评估卡测试锚点存在（ident 初始 state 可注入）', identPatched !== RAW, IDENT_ANCHOR)

// 4-1 引导态：needsAssessment=true 且无本机兜底 ⇒ 引导卡 + 「开始评估」
if (identPatched !== RAW) {
  const t1 = flattenText(renderOnce(identPatched).tree)
  check('4-1 引导态：needsAssessment=true 且无兜底 ⇒ 「开始评估」引导卡', t1.indexOf('开始评估') >= 0 && t1.some((x) => String(x).includes('还没做过工作能力评估')), '')

  // 4-6 数据翻转（故障 B 主场景）：needsAssessment=true 但本机有兜底记录 ⇒ 按已评估渲染（能力条），不再弹引导卡
  const marker = JSON.stringify({ machine: 'GT14', assessedAt: Date.now() })  // MC-1：TTL 内才有效，故用当前时间
  const t6 = flattenText(renderOnce(identPatched, { localStorage: { 'dsh-assess-done-v1': marker } }).tree)
  check(
    '4-6 本机兜底：服务端 needsAssessment=true 但有兜底 ⇒ 显示「工作能力」条而非引导卡（重挂不再要求重评）',
    !t6.some((x) => String(x).includes('还没做过工作能力评估')) && t6.some((x) => String(x).includes('· 工作能力')),
    '',
  )

  // 4-7 MC-4 补强（复核三阶段 P0）：ident=null + phase=success 时能力条必须出「占位」而不是崩进 PanelSafe。
  // 这里不注入 ident（保持默认 null），只把 phase 顶成 success —— 正是反证 f 的可达场景。
  const nullIdentSuccess = RAW.replace(PHASE_ANCHOR, PHASE_ANCHOR.replace("'idle'", "'success'"))
  const t7 = flattenText(renderOnce(nullIdentSuccess).tree)
  check(
    '4-7 ident=null + 评估成功 ⇒ 能力条显示「清单待 /identity 刷新」占位（不 crash、不降级）',
    t7.some((x) => String(x).includes('· 工作能力')) && t7.some((x) => String(x).includes('能力清单待 /identity 刷新')),
    '',
  )

  const phasePatched = identPatched.replace(PHASE_ANCHOR, PHASE_ANCHOR.replace("'idle'", "'loading'"))
  check('评估 phase 锚点存在（v2.7.4 才有；旧 bundle 此处必 FAIL）', phasePatched !== identPatched, PHASE_ANCHOR)

  if (phasePatched !== identPatched) {
    // 4-2 loading 态：明示 8 秒上限 + 可取消 —— 不给「永久转圈」留门
    const t2 = flattenText(renderOnce(phasePatched, { deferTimeouts: true }).tree)
    check('4-2 loading 态：明示「最长 15 秒」+ 有「取消」按钮', t2.some((x) => /最长 15 秒/.test(String(x))) && t2.indexOf('取消') >= 0, '')

    // 4-3 error 态：专属错误卡，含原因与「重试」
    const errPatched = identPatched
      .replace(PHASE_ANCHOR, PHASE_ANCHOR.replace("'idle'", "'error'"))
      .replace(ERR_ANCHOR, ERR_ANCHOR.replace("''", "'评估超时（8 秒），可重试'"))
    const t3 = flattenText(renderOnce(errPatched).tree)
    check('4-3 error 态：「评估没有完成」卡 + 「重试」按钮', t3.indexOf('评估没有完成') >= 0 && t3.indexOf('重试') >= 0, '')

    // 4-4 交互超时链（故障 A 主场景）：点「开始评估」→ loading；flush 15s 定时器（fetch 永不落定）
    // → 必须进入 error 卡并给「重试」，绝不永久转圈。旧版这条链永远停在 loading。
    const timeoutRun = renderOnce(identPatched, {
      deferTimeouts: true,
      // 桩必须模拟真 fetch 对 AbortSignal 的行为：abort ⇒ reject(AbortError)。否则这条链测不出超时。
      fetch: (url, init) => {
        if (String(url).indexOf('/assess') >= 0) {
          return new Promise((resolve, reject) => {
            const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
            const sig = init && init.signal
            if (sig) {
              if (sig.aborted) reject(abortErr())
              else sig.addEventListener('abort', () => reject(abortErr()))
            }
            // 不 resolve：模拟服务端 assess 永不返回（故障 A 场景）
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, machine: 'GT14', needsAssessment: false, assessed: true, assessedAt: 1, caps: null }),
          text: async () => '{}',
        })
      },
    })
    const btnT = findButton(timeoutRun.tree, '开始评估')
    check('4-4a 交互链起点：能找到「开始评估」按钮', Boolean(btnT), '')
    if (btnT) {
      btnT.props.onClick()
      const loadingTexts = flattenText(timeoutRun.rerender())
      check('4-4b 点击后进入 loading 态（明示不会一直转圈）', loadingTexts.some((x) => /不会一直转圈/.test(String(x))), '')
      const flushed = timeoutRun.flushTimers()
      await new Promise((r) => setTimeout(r, 30)) // 让 abort 的 rejection 走完微任务链
      const errTexts = flattenText(timeoutRun.rerender())
      check(
        '4-4c 8s 定时器触发 ⇒ error 卡 + 「重试」出口（旧版此处永久转圈）',
        flushed >= 1 && errTexts.indexOf('重试') >= 0 && errTexts.some((x) => /评估超时/.test(String(x))),
        'flushed=' + flushed,
      )
    }

    // 4-5 成功链：assess 返回 ok ⇒ notice 摘要 + 本机兜底记录写入（旧版没有兜底）
    const okRun = renderOnce(identPatched, {
      fetch: async (url) => {
        if (String(url).indexOf('/assess') >= 0) {
          return { ok: true, status: 200, json: async () => ({ ok: true, machine: 'GT14', summary: '首次评估完成 GT14', caps: {} }), text: async () => '{}' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, machine: 'GT14', needsAssessment: false, assessed: true, assessedAt: 1763712000000, caps: {} }),
          text: async () => '{}',
        }
      },
    })
    const btnO = findButton(okRun.tree, '开始评估')
    check('4-5a 成功链起点：能找到「开始评估」按钮', Boolean(btnO), '')
    if (btnO) {
      btnO.props.onClick()
      await new Promise((r) => setTimeout(r, 30))
      const doneTexts = flattenText(okRun.rerender())
      check('4-5b 评估成功：notice 出现服务端摘要、引导卡消失', doneTexts.some((x) => String(x).indexOf('首次评估完成 GT14') >= 0) && doneTexts.indexOf('开始评估') < 0, '')
      check(
        '4-5c 评估成功：本机兜底记录已写入（dsh-assess-done-v1，故障 B 的客户端侧补丁）',
        String(okRun.sandbox.localStorage.getItem('dsh-assess-done-v1') || '').indexOf('"machine":"GT14"') >= 0,
        '',
      )
    }
  }
}

// ── 第 5 轮：自检报警横幅收缩开关（v2.7.5 U1，用户反馈：笔记本上报警条挡任务列表）────────────
// 负向门禁：旧 bundle 无 dsh-doctor-collapsed-v1 / doctorOpen，以下静态断言必须 FAIL。
check('U1 收缩开关存在（localStorage 键 dsh-doctor-collapsed-v1）', RAW.includes("dsh-doctor-collapsed-v1"), 'doctor-collapsed key')
check('U1 状态与切换函数存在（doctorOpen / toggleDoctor）', RAW.includes('const [doctorOpen, setDoctorOpen]') && RAW.includes('toggleDoctor'), 'doctorOpen/toggleDoctor')
check('U1 收缩条有样式钩子（dsb-doctor-collapsed）', RAW.includes('dsb-doctor-collapsed'), 'dsb-doctor-collapsed')
check('U1 自检不可用不可折叠（ok===false 强制展开）', /ok === false\)\) && doctorIssues\.length/.test(RAW) || RAW.includes("!(doctor && doctor.ok === false) && doctorIssues.length"), 'ok=false 强制展开')

function findByClassOnClick(node, cls) {
  if (!node || typeof node !== 'object') return null
  if (node.props && node.props.className === cls && typeof node.props.onClick === 'function') return node
  for (const k of (Array.isArray(node) ? node : node.children || [])) {
    const g = findByClassOnClick(k, cls)
    if (g) return g
  }
  return null
}

// U1 断言统一用子串匹配（数组 indexOf 是精确元素匹配，'自检：有警告'/'! w1' 这类合并节点会误判）
const hasText = (arr, s) => arr.some((x) => String(x).indexOf(s) >= 0)

const U1_DOCTOR = { ok: true, version: '2.7.4', installedVersion: '2.7.4', role: 'owner', checks: [{ id: 'a', level: 'warn', message: 'w1' }, { id: 'b', level: 'warn', message: 'w2' }] }
const U1_ANCHOR = 'const [doctor, setDoctor] = React.useState(null)'

// U1-a 默认展开：无折叠记忆 ⇒ 完整横幅（标题 + 每条 message + 收起按钮）
{
  const src = RAW.replace(U1_ANCHOR, 'const [doctor, setDoctor] = React.useState(' + JSON.stringify(U1_DOCTOR) + ')')
  const t = flattenText(renderOnce(src).tree)
  check('U1-a 默认展开：标题 + 明细 w1/w2 + 「收起 ▴」按钮', hasText(t, '有警告') && hasText(t, 'w1') && hasText(t, 'w2') && hasText(t, '收起 ▴'), '')

  // U1-b 收缩态：localStorage 记忆 '1' ⇒ 单行摘要，不含明细，可点
  const collapsed = renderOnce(src, { localStorage: { 'dsh-doctor-collapsed-v1': '1' } })
  const tc = flattenText(collapsed.tree)
  const collapsedNode = findByClassOnClick(collapsed.tree, 'dsb-doctor-collapsed')
  check(
    'U1-b 收缩态：单行摘要「2 项待处理…2 警告」且不含明细 w1/w2',
    hasText(tc, '2 项待处理') && !hasText(tc, 'w1') && !hasText(tc, 'w2') && hasText(tc, '2 警告'),
    '',
  )
  check('U1-b2 收缩条可点（onClick + role=button + aria-expanded=false）', Boolean(collapsedNode) && collapsedNode.props.role === 'button' && collapsedNode.props['aria-expanded'] === 'false', '')

  // U1-c 互切：点收缩条 → 展开；点「收起 ▴」 → 收缩 + 记忆落盘
  if (collapsedNode) {
    collapsedNode.props.onClick()
    const tOpen = flattenText(collapsed.rerender())
    check('U1-c1 点收缩条 ⇒ 展开（w1/w2 可见）', hasText(tOpen, 'w1') && hasText(tOpen, 'w2'), '')
  }
  {
    const collapsed2 = renderOnce(src, { localStorage: { 'dsh-doctor-collapsed-v1': '1' } })
    const node2 = findByClassOnClick(collapsed2.tree, 'dsb-doctor-collapsed')
    if (node2) {
      node2.props.onClick()
      const tree2 = collapsed2.rerender()
      const openBtn = findButton(tree2, '收起 ▴')
      check('U1-c2 展开态有「收起 ▴」按钮', Boolean(openBtn), '')
      if (openBtn) {
        openBtn.props.onClick()
        const tC = flattenText(collapsed2.rerender())
        // 收起 ⇒ doctorOpen=false ⇒ toggleDoctor 写入 '1'（'1'=收缩）
        check('U1-c3 点「收起 ▴」 ⇒ 收缩（明细不可见）+ 记忆写入 localStorage（=1）', !hasText(tC, 'w1') && String(collapsed2.sandbox.localStorage.getItem('dsh-doctor-collapsed-v1')) === '1', '')
      }
    }
  }

  // U1-d ok=false 强制展开：即使记忆为收缩，也渲染「自检不可用」且无收起按钮
  const badSrc = RAW.replace(U1_ANCHOR, 'const [doctor, setDoctor] = React.useState(' + JSON.stringify({ ok: false, error: 'boom' }) + ')')
  const tb = flattenText(renderOnce(badSrc, { localStorage: { 'dsh-doctor-collapsed-v1': '1' } }).tree)
  check('U1-d 自检不可用强制展开（collapsed=1 仍可见）且无「收起 ▴」', hasText(tb, '自检不可用') && !hasText(tb, '收起 ▴'), '')

  // U1-e 混合 error+warn 收缩：计数正确 + 错误数红字（不靠颜色单独传达，文案本身含「错误」）
  const mixSrc = RAW.replace(U1_ANCHOR, 'const [doctor, setDoctor] = React.useState(' + JSON.stringify({ ok: true, version: '2.7.4', checks: [{ id: 'e', level: 'error', message: 'e1' }, { id: 'w', level: 'warn', message: 'w9' }] }) + ')')
  const mixRun = renderOnce(mixSrc, { localStorage: { 'dsh-doctor-collapsed-v1': '1' } })
  const tm = flattenText(mixRun.tree)
  check('U1-e 收缩计数「2 项待处理（1 错误 / 1 警告）」', tm.some((x) => String(x).indexOf('2 项待处理') >= 0) && tm.some((x) => String(x).indexOf('1 错误') >= 0) && tm.some((x) => String(x).indexOf('1 警告') >= 0), '')
  const mixNode = findByClassOnClick(mixRun.tree, 'dsb-doctor-collapsed')
  const errSpan = mixNode && (mixNode.children || []).find((c) => c && c.props && String(flattenText(c).join('')) === '1 错误')
  check('U1-e2 错误数红色加粗（color=--dsb-bad, fontWeight 700）', Boolean(errSpan) && errSpan.props.style.color === 'var(--dsb-bad)' && errSpan.props.style.fontWeight === 700, '')

  // U1-f 畸形：checks 非数组 / doctor=null → 不渲染横幅且不崩
  const tBad = flattenText(renderOnce(RAW.replace(U1_ANCHOR, 'const [doctor, setDoctor] = React.useState(' + JSON.stringify({ ok: true, checks: 'corrupted' }) + ')')).tree)
  check('U1-f checks 非数组 ⇒ 横幅不渲染、不崩（:1547 Array.isArray 守卫）', !hasText(tBad, '自检：') && !hasText(tBad, '调度台渲染出错'), '')
}

// v2.7.19：面板「安装更新 / 重启 DSH」的 POST 必须带 UI 守卫要求的 header。
// 漏了会被服务端 403（lib/index.js:5666），而且失败信息此前没有渲染点 ⇒ 点了像没反应。
{
  const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  const i = src.indexOf("const nodeOp = async (kind, id)")
  const seg = i >= 0 ? src.slice(i, i + 900) : ''
  check('N1 nodeOp 的 fetch 带 UI_HEADERS（x-dsh-team-ui）', /Object\.assign\(\{\},\s*UI_HEADERS/.test(seg), '')
  check('N2 nodeOp 的 fetch 带 credentials same-origin', /credentials:\s*'same-origin'/.test(seg), '')
  check('N3 机器卡渲染 nodeMsg 提示行', /nodeMsg\[String\(m\.id\)\]\s*\n\s*\?\s*h\('div'/.test(src), '')
}
const failed = results.filter((r) => !r.cond)
console.log(
  failed.length
    ? `FAIL  client-render-smoke：${failed.length}/${results.length} 项不通过`
    : `PASS  client-render-smoke：${results.length}/${results.length} 项（插件 v${pkg.version} 常显于面板标题区）`,
)
if (failed.length) process.exitCode = 1
