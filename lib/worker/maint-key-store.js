// 主控签名密钥的读取 / 生成策略（v2.7.20）。
//
// 背景（2026-11-24 事故）：历史上存在两套互不兼容的 key 文件格式——
//   · scripts/maint-ticket.mjs keygen 写 { version, privateKeyB64, publicKeyB64 }
//   · 宿主运行时 ensureMaintKeyPair() 写 { v, alg, publicKey, privateKey, createdAt }
// 旧实现只认后者：遇到前者时 `raw.publicKey` 为空，于是把「读不懂」当成「没有钥匙」，
// 静默生成新的一对并覆盖整个文件 —— 主机私钥被销毁，副机 maintAuthPublicKeys 全部失效
// （GT14 的 maint-ticket-badsig 就是这么来的）。
//
// 本模块的契约：
//   1. 两种历史格式都认（publicKey/privateKey 与 publicKeyB64/privateKeyB64），能读就用、绝不写盘；
//   2. 文件存在但不可用（JSON 坏 / 字段缺 / 材质非法）⇒ 返回 { ok:false, error:'maint-key-unusable' }，
//      **不覆盖、不备份、不轮换**，把问题暴露给调用方（面板 / doctor / 日志）；
//   3. 只有文件确实不存在时才生成新钥匙（首次初始化），并以宿主格式落盘（0600）。
import fsDefault from 'node:fs'
import cryptoDefault from 'node:crypto'

export const MAINT_KEY_UNUSABLE = 'maint-key-unusable'

/**
 * 把两种历史格式归一成统一记录。
 * 返回 null 表示「认不出」（字段缺失 / 不是对象）；返回对象里的 publicKeyB64 以**私钥派生的公钥**为准，
 * 这样即使文件里存的公钥字段被改坏，也不会签出别人验不过的票据。
 */
export function normalizeKeyRecord(raw, cryptoImpl = cryptoDefault) {
  if (!raw || typeof raw !== 'object') return null
  const host = typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string'
  const cli = typeof raw.publicKeyB64 === 'string' && typeof raw.privateKeyB64 === 'string'
  const privateKeyB64 = host && raw.privateKey ? raw.privateKey : (cli && raw.privateKeyB64 ? raw.privateKeyB64 : '')
  if (!privateKeyB64) return null
  let privateKey
  try {
    privateKey = cryptoImpl.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    return null
  }
  let derivedPublicB64 = ''
  try {
    derivedPublicB64 = cryptoImpl.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
  } catch {
    return null
  }
  return {
    schema: host ? 'host' : 'cli',
    publicKeyB64: derivedPublicB64,
    privateKeyB64,
    declaredPublicB64: host ? String(raw.publicKey || '') : String(raw.publicKeyB64 || ''),
  }
}

/**
 * 确保密钥可用。
 * @param {{ file: string, fsImpl?: object, cryptoImpl?: object }} opts
 * @returns {{ ok: true, file: string, publicKey: string, fingerprint: string, created: boolean, schema: string }
 *          | { ok: false, file: string, error: string, reason?: string }}
 */
export function ensureMaintKeyPair(opts = {}) {
  const file = String(opts.file || '').trim()
  const fsImpl = opts.fsImpl || fsDefault
  const cryptoImpl = opts.cryptoImpl || cryptoDefault
  if (!file) return { ok: false, file, error: 'maint-key-path-missing' }
  let exists = false
  try {
    exists = fsImpl.existsSync(file)
  } catch (e) {
    return { ok: false, file, error: 'maint-key-stat-failed', reason: String((e && e.message) || e) }
  }
  if (exists) {
    // 老版本/外部脚本可能以 0644 写过私钥：显式纠正权限，但任何失败都不影响「复用」这条主路径。
    try {
      const mode = fsImpl.statSync(file).mode & 0o777
      if (mode !== 0o600 && typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(file, 0o600)
    } catch { /* 权限纠正失败不影响读取 */ }
    let raw = null
    try {
      raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
    } catch (e) {
      return { ok: false, file, error: MAINT_KEY_UNUSABLE, reason: 'invalid-json: ' + String((e && e.message) || e) }
    }
    const rec = normalizeKeyRecord(raw, cryptoImpl)
    if (!rec) return { ok: false, file, error: MAINT_KEY_UNUSABLE, reason: 'unsupported-schema-or-key-material' }
    return { ok: true, file, publicKey: rec.publicKeyB64, fingerprint: rec.publicKeyB64.slice(-12), created: false, schema: rec.schema }
  }
  // 只有「确实不存在」才生成 —— 这是首次初始化，不是修复。
  try {
    const { publicKey, privateKey } = cryptoImpl.generateKeyPairSync('ed25519')
    const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const privateKeyB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    fsImpl.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    const body = { v: 1, alg: 'ed25519', publicKey: publicKeyB64, privateKey: privateKeyB64, createdAt: new Date().toISOString() }
    fsImpl.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
    return { ok: true, file, publicKey: publicKeyB64, fingerprint: publicKeyB64.slice(-12), created: true, schema: 'host' }
  } catch (e) {
    return { ok: false, file, error: 'maint-key-create-failed', reason: String((e && e.message) || e) }
  }
}

/** 读取私钥（两种历史格式都支持）；不可用时抛错，绝不写盘。 */
export function loadPrivateKey(file, opts = {}) {
  const fsImpl = opts.fsImpl || fsDefault
  const cryptoImpl = opts.cryptoImpl || cryptoDefault
  let raw = null
  try {
    raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(MAINT_KEY_UNUSABLE + ': invalid-json: ' + String((e && e.message) || e))
  }
  const rec = normalizeKeyRecord(raw, cryptoImpl)
  if (!rec) throw new Error(MAINT_KEY_UNUSABLE + ': unsupported-schema-or-key-material')
  return cryptoImpl.createPrivateKey({ key: Buffer.from(rec.privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
}
