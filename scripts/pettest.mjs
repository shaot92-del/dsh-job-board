
import { readFileSync } from 'node:fs'

const listeners = { win: {}, el: new WeakMap() }
const store = new Map()
let moduleDef = null

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

class El {
  constructor(tag) {
    this.tagName = tag
    this.style = {}
    this.children = []
    this.className = ''
    this.id = ''
    this.textContent = ''
    this.parentNode = null
    this._ls = {}
    this.classList = { add() {}, remove() {}, contains() { return false } }
    this.draggable = false
    this.title = ''
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f) }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f) }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { width: 134, height: 180, left: 0, top: 0 } }
  closest() { return null }
  get offsetWidth() { return 134 }
  get offsetHeight() { return 180 }
  fire(t, ev) { (this._ls[t] || []).forEach((f) => f(ev)) }
}

const body = new El('body')
const head = new El('head')

globalThis.document = {
  body,
  head,
  createElement: (t) => new El(t),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}

globalThis.window = globalThis
globalThis.innerWidth = 1600
globalThis.innerHeight = 900
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const winListeners = {}
globalThis.addEventListener = (t, f) => { (winListeners[t] = winListeners[t] || []).push(f) }
globalThis.removeEventListener = (t, f) => { winListeners[t] = (winListeners[t] || []).filter((x) => x !== f) }
globalThis.dispatchEvent = (ev) => { (winListeners[ev.type] || []).forEach((f) => f(ev)) }
globalThis.requestAnimationFrame = (cb) => cb()
globalThis.CustomEvent = class { constructor(t) { this.type = t } }
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

const SUMMARY = {
  ok: true,
  updatedAgeSec: 42,
  counts: { queued: 2, running: 1, done: 49, bad: 1, stale: 0 },
  machines: [
    { id: 'host', online: true, current: '' },
    { id: 'GT14', online: false, current: '' },
  ],
  tasks: [],
}
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(SUMMARY) })

globalThis.__ModuleLoader__ = { load: (def) => { moduleDef = def } }

const src = readFileSync('D:/gp_video/dsh-board/lib/client.js', 'utf8')
// eslint-disable-next-line no-new-func
new Function(src)()

const React = { createElement: (t, p, ...c) => ({ t, p, c }), useState: (v) => [v, () => {}], useEffect: () => {}, useRef: () => ({}) }
const mod = moduleDef.factory((id) => (id === 'react' ? React : {}))
const ctx = {
  get: (k) => (k === 'styles' ? { insert: () => () => {} } : null),
  slots: { inject() {}, register() {} },
}
mod.apply(ctx)
await new Promise((r) => setTimeout(r, 30))

const pet = body.children.find((c) => c.id === 'dsb-pet-root')
if (!pet) { console.log('FAIL: no pet element'); process.exit(1) }
console.log('pet size:', pet.style.width, pet.style.height, '| left/top:', pet.style.left, pet.style.top)

const strip = pet.children.find((c) => c.className === 'dsbp-strip')
if (!strip) { console.log('FAIL: no strip'); process.exit(1) }
console.log('strip display:', strip.style.display, '| items:', strip.children.length, '| texts:', strip.children.map((c) => c.textContent).join(' / '))

// 模拟拖拽：pointerdown -> pointermove -> pointerup
const before = pet.style.left
pet.fire('pointerdown', { button: 0, clientX: 1200, clientY: 700, pointerId: 1, preventDefault() {} })
;(winListeners['pointermove'] || []).forEach((f) => f({ clientX: 1100, clientY: 640, pointerId: 1 }))
;(winListeners['pointerup'] || []).forEach((f) => f({ clientX: 1100, clientY: 640, pointerId: 1 }))
console.log('drag:', before, '->', pet.style.left, pet.style.top, '| saved:', store.get('dsh-board-pet-pos'))

// 右键收起
pet.fire('contextmenu', { preventDefault() {} })
const collapsedSize = pet.style.width
pet.fire('pointerdown', { button: 0, clientX: 1100, clientY: 640, pointerId: 2, preventDefault() {} })
;(winListeners['pointerup'] || []).forEach((f) => f({ clientX: 1100, clientY: 640, pointerId: 2 }))
console.log('collapse->', collapsedSize, '| expand->', pet.style.width)

console.log('dblclick size ->', (() => { pet.fire('dblclick', {}); return pet.style.width })())

const ok = pet.style.left !== before && strip.children.length >= 3
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(ok ? 0 : 1)
