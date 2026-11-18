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
const CLIENT = path.join(root, 'lib', 'client.js')
const RAW = fs.readFileSync(CLIENT, 'utf8')

const results = []
function check(name, cond, detail) {
  results.push({ name, cond: Boolean(cond), detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 最小 React 假实现（client.js 只用 createElement / useState / useEffect）。 */
function makeReact(states) {
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(4).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
      }
    },
    useState(init) {
      const v = typeof init === 'function' ? init() : init
      states.push(v)
      return [v, () => {}]
    },
    useEffect() {},
  }
  return React
}

/** 宿主全局最小桩：DOM 只做到「不抛错」，Pet 挂载失败会被 bundle 自己 try/catch 掉。 */
function makeSandbox(React) {
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
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => {
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
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }),
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
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
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
 * @param {string} src  bundle 源码（默认原样；第二轮会把 doctor 的初始 state 换掉）
 */
function renderOnce(src) {
  const states = []
  const sandbox = makeSandbox(makeReact(states))
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
  return { tree, states }
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
check('窄屏折叠样式存在（@media ≤980px + dsb-sub 让位）', RAW.includes('@media (max-width:980px)') && RAW.includes('.dsb-head .dsb-sub{display:none}') && RAW.includes('@media (max-width:1240px)'), 'media queries')

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

const failed = results.filter((r) => !r.cond)
console.log(
  failed.length
    ? `FAIL  client-render-smoke：${failed.length}/${results.length} 项不通过`
    : `PASS  client-render-smoke：${results.length}/${results.length} 项（插件 v${pkg.version} 常显于面板标题区）`,
)
if (failed.length) process.exitCode = 1
