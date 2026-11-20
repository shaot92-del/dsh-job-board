import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildManifest, parseManifest, verifyInstall, MANIFEST_NAME, CRITICAL_FILES } from '../../lib/install-manifest.js'

/** 建一个最小假安装目录：package.json + 若干文件 + 可选清单。 */
function makeInstall({ version = '9.9.9', files = {}, manifest = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-manifest-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }, null, 2), 'utf8')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  if (manifest) fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

function manifestFor(dir, version, rels) {
  const files = rels.map((rel) => ({ path: rel, bytes: fs.statSync(path.join(dir, rel)).size, sha256: 'x'.repeat(64) }))
  return buildManifest({ version, files, now: () => '2026-11-21T00:00:00.000Z' })
}

test('buildManifest：路径归一成 /、按 path 排序、sha 小写', () => {
  const m = buildManifest({
    version: '2.7.3',
    files: [
      { path: 'lib\\b.js', bytes: '12', sha256: 'ABCDEF' },
      { path: 'lib/a.js', bytes: 3, sha256: 'ff' },
      { path: '' },
    ],
    now: () => 'T',
  })
  assert.equal(m.version, '2.7.3')
  assert.equal(m.generatedAt, 'T')
  assert.deepEqual(m.files.map((f) => f.path), ['lib/a.js', 'lib/b.js'])
  assert.equal(m.files[1].sha256, 'abcdef')
  assert.equal(m.files[1].bytes, 12)
})

test('parseManifest：坏 JSON / 缺 files 都判不可用', () => {
  assert.equal(parseManifest('not json').ok, false)
  assert.equal(parseManifest('{"version":"1"}').reason, 'manifest-shape')
  assert.equal(parseManifest('{"version":"1","files":[]}').ok, true)
})

test('verifyInstall：没有清单 → ok，但提示旧版安装', () => {
  const dir = makeInstall({ files: { 'lib/index.js': 'x' } })
  const r = verifyInstall({ dir, fsImpl: fs })
  assert.equal(r.ok, true)
  assert.match(r.problems.join(), /install-manifest\.json/)
})

test('verifyInstall：清单与文件一致 → ok', () => {
  const files = { 'lib/index.js': 'aaa', 'lib/client.js': 'ccc' }
  const dir = makeInstall({ files })
  const m = manifestFor(dir, '9.9.9', Object.keys(files))
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(m), 'utf8')
  const r = verifyInstall({ dir, fsImpl: fs })
  assert.equal(r.ok, true, r.problems.join())
  assert.equal(r.checked, CRITICAL_FILES.filter((p) => files[p]).length)
})

test('verifyInstall：版本不一致（半覆盖）→ 报清单版本不符', () => {
  const files = { 'lib/index.js': 'aaa' }
  const dir = makeInstall({ files })
  const m = manifestFor(dir, '1.0.0', Object.keys(files))
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(m), 'utf8')
  const r = verifyInstall({ dir, fsImpl: fs })
  assert.equal(r.ok, false)
  assert.match(r.problems.join(), /清单版本 1\.0\.0 与 package\.json 9\.9\.9 不一致/)
})

test('verifyInstall：关键文件被换掉（大小不符）→ 报混合树', () => {
  const files = { 'lib/index.js': 'aaa', 'lib/dispatch-filter.js': 'bbb' }
  const dir = makeInstall({ files })
  const m = manifestFor(dir, '9.9.9', Object.keys(files))
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(m), 'utf8')
  fs.writeFileSync(path.join(dir, 'lib/dispatch-filter.js'), 'bbbbbbbbbb', 'utf8') // 旧版残留
  const r = verifyInstall({ dir, fsImpl: fs })
  assert.equal(r.ok, false)
  assert.match(r.problems.join(), /关键文件大小不符：lib\/dispatch-filter\.js/)
})

test('verifyInstall：关键文件缺失 → 报缺失', () => {
  const dir = makeInstall({ files: { 'lib/index.js': 'aaa' } })
  const m = manifestFor(dir, '9.9.9', ['lib/index.js'])
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(m), 'utf8')
  fs.rmSync(path.join(dir, 'lib/index.js'))
  const r = verifyInstall({ dir, fsImpl: fs })
  assert.equal(r.ok, false)
  assert.match(r.problems.join(), /关键文件缺失：lib\/index\.js/)
})

test('verifyInstall：package.json 坏掉不算崩溃，返回 problems', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-manifest-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{oops', 'utf8')
  const r = verifyInstall({ dir, fsImpl: fs })
  assert.equal(r.ok, false)
  assert.match(r.problems.join(), /package\.json 读不到/)
})
