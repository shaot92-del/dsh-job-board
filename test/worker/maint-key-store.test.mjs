import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureMaintKeyPair, loadPrivateKey, normalizeKeyRecord, MAINT_KEY_UNUSABLE } from '../../lib/worker/maint-key-store.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-maint-key-'))
}

function makePair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

function snapshot(file) {
  const st = fs.statSync(file)
  return { mtimeMs: st.mtimeMs, sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
}

test('ensureMaintKeyPair：CLI 格式（publicKeyB64/privateKeyB64）原样复用，不写盘', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'maint-key.json')
  const pair = makePair()
  fs.writeFileSync(file, JSON.stringify({ version: 1, privateKeyB64: pair.privateKeyB64, publicKeyB64: pair.publicKeyB64 }, null, 2) + '\n')
  const before = snapshot(file)
  const r = ensureMaintKeyPair({ file })
  assert.equal(r.ok, true)
  assert.equal(r.created, false)
  assert.equal(r.schema, 'cli')
  assert.equal(r.publicKey, pair.publicKeyB64)
  assert.deepEqual(snapshot(file), before, '复用路径绝不能改动文件')
})

test('ensureMaintKeyPair：宿主格式（publicKey/privateKey）原样复用，不写盘', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'maint-key.json')
  const pair = makePair()
  fs.writeFileSync(file, JSON.stringify({ v: 1, alg: 'ed25519', publicKey: pair.publicKeyB64, privateKey: pair.privateKeyB64, createdAt: new Date().toISOString() }, null, 2) + '\n')
  const before = snapshot(file)
  const r = ensureMaintKeyPair({ file })
  assert.equal(r.ok, true)
  assert.equal(r.created, false)
  assert.equal(r.schema, 'host')
  assert.deepEqual(snapshot(file), before)
})

test('ensureMaintKeyPair：文件存在但 JSON 坏了 ⇒ maint-key-unusable 且文件不变（绝不轮换）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'maint-key.json')
  fs.writeFileSync(file, '{ this is not json')
  const before = snapshot(file)
  const r = ensureMaintKeyPair({ file })
  assert.equal(r.ok, false)
  assert.equal(r.error, MAINT_KEY_UNUSABLE)
  assert.deepEqual(snapshot(file), before, '不可用也不能覆盖')
})

test('ensureMaintKeyPair：JSON 合法但缺 key 字段 ⇒ maint-key-unusable 且文件不变', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'maint-key.json')
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }) + '\n')
  const before = snapshot(file)
  const r = ensureMaintKeyPair({ file })
  assert.equal(r.ok, false)
  assert.equal(r.error, MAINT_KEY_UNUSABLE)
  assert.deepEqual(snapshot(file), before)
})

test('ensureMaintKeyPair：文件不存在 ⇒ 生成一次；再次调用复用同一把', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'nested', 'maint-key.json')
  const first = ensureMaintKeyPair({ file })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  assert.equal(fs.existsSync(file), true)
  const mode = fs.statSync(file).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600, '首次生成的私钥必须 0600')
  else assert.ok(mode > 0, 'Windows 上 Node 的 mode 是仿真值，只校验文件存在')
  const before = snapshot(file)
  const second = ensureMaintKeyPair({ file })
  assert.equal(second.ok, true)
  assert.equal(second.created, false)
  assert.equal(second.publicKey, first.publicKey)
  assert.deepEqual(snapshot(file), before)
})

test('loadPrivateKey：两种格式都能签出可验证的票据', () => {
  const dir = tmpDir()
  const pair = makePair()
  const cliFile = path.join(dir, 'cli.json')
  fs.writeFileSync(cliFile, JSON.stringify({ version: 1, privateKeyB64: pair.privateKeyB64, publicKeyB64: pair.publicKeyB64 }))
  const hostFile = path.join(dir, 'host.json')
  fs.writeFileSync(hostFile, JSON.stringify({ v: 1, alg: 'ed25519', publicKey: pair.publicKeyB64, privateKey: pair.privateKeyB64 }))
  const pub = crypto.createPublicKey({ key: Buffer.from(pair.publicKeyB64, 'base64'), format: 'der', type: 'spki' })
  for (const file of [cliFile, hostFile]) {
    const priv = loadPrivateKey(file)
    const msg = Buffer.from('ticket-payload')
    const sig = crypto.sign(null, msg, priv)
    assert.equal(crypto.verify(null, msg, pub, sig), true)
  }
})

test('normalizeKeyRecord：公钥字段被改坏时以私钥派生的公钥为准', () => {
  const pair = makePair()
  const rec = normalizeKeyRecord({ v: 1, publicKey: 'AAAA', privateKey: pair.privateKeyB64 })
  assert.equal(rec.publicKeyB64, pair.publicKeyB64)
  assert.equal(rec.declaredPublicB64, 'AAAA')
})
