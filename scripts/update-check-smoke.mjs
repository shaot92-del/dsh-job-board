#!/usr/bin/env node
/**
 * update-check 冒烟：假 registry 返回 9.9.9，验证
 *   1) /api/board/ui/update-check 返回 updateAvailable=true；
 *   2) doctor 的 update 检查存在、level=info、latestVersion 正确；
 *   3) 面板用的 doctor.updateAvailable 为 true。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updatecheck-'))
process.env.DSH_TEAM_STATE_DIR = root

function reply(o) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => o, text: async () => JSON.stringify(o) }
}
const realFetch = globalThis.fetch
globalThis.fetch = async (u) => {
  const s = String(u)
  if (s.includes('registry.npmjs.org')) return reply({ version: '9.9.9' })
  if (s.includes('/api/board')) return reply({ ok: true, updated: Math.floor(Date.now() / 1000), machines: [], tasks: [], events: [], counts: { queued: 0, running: 0, done: 0, bad: 0 } })
  if (s.includes('/api/remote-agent/ui/nodes')) return reply({ ok: true, nodes: [] })
  return reply({ ok: true })
}

const routes = new Map()
const ctx = {
  tools: { register() {} },
  webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} }, getOrigin() { return 'http://host.test' } },
  on() { return () => {} },
  effect() { return () => {} },
  logger: { info() {}, warn() {}, error() {} },
  get() { return null },
}
const mod = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href)
const apply = mod.apply || (mod.default && mod.default.apply)
const dispose = apply(ctx, { boardUrl: 'http://127.0.0.1:1', machine: 'host', autoDispatch: false })

function callRoute(p) {
  return new Promise((resolve) => {
    const out = { status: 0, body: null }
    const res = { writeHead(s) { out.status = s }, setHeader() {}, end(t) { out.body = t ? JSON.parse(t) : null; resolve(out) } }
    routes.get(p)({ method: 'GET', headers: { host: '127.0.0.1' }, on() {}, resume() {} }, res)
  })
}

const uc = await callRoute('/api/board/ui/update-check')
assert.equal(uc.status, 200)
assert.equal(uc.body.latest, '9.9.9')
assert.equal(uc.body.updateAvailable, true)

const doc = await callRoute('/api/board/ui/doctor')
assert.equal(doc.body.latestVersion, '9.9.9')
assert.equal(doc.body.updateAvailable, true)
const upd = (doc.body.checks || []).find((c) => c.id === 'update')
assert.ok(upd, 'doctor 应有 update 检查')
assert.equal(upd.level, 'info')

dispose()
globalThis.fetch = realFetch
fs.rmSync(root, { recursive: true, force: true })
console.log('PASS update-check smoke')
