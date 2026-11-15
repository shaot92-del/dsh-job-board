#!/usr/bin/env node
/**
 * Self-test for scripts/check-text.mjs.
 *
 * The checker is a release gate; a silent regex/word-list regression would keep
 * reporting PASSED forever. This smoke builds a throwaway git repo with one
 * fixture per rule and asserts the checker actually fails, then cleans them and
 * asserts it passes.
 *
 * Run: node scripts/check-text-smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECKER = path.join(HERE, 'check-text.mjs')

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, '--root', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-check-text-'))
const checks = []
function ok(name, condition, detail = '') {
  checks.push({ name, pass: !!condition, detail })
  if (!condition) console.error(`FAIL ${name} ${detail}`)
}

try {
  execFileSync('git', ['init', '-q'], { cwd: dir })

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '## v1.0.0\n')
  fs.writeFileSync(path.join(dir, 'clean.md'), '# clean\n\nhello world  \nnext line\n')

  const clean = run(dir)
  ok('clean repo exits 0', clean.status === 0, JSON.stringify(clean))

  fs.writeFileSync(path.join(dir, 'bad-bom.txt'), '\uFEFFhello\n')
  fs.writeFileSync(path.join(dir, 'bad-utf16.txt'), Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))
  fs.writeFileSync(path.join(dir, 'bad-crlf.txt'), 'a\r\nb\r\n')
  fs.writeFileSync(path.join(dir, 'bad-dup.md'), '插件市场升级或插件市场升级\n')
  fs.writeFileSync(path.join(dir, 'bad-spell.md'), 'we recieve it\n')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.1' }))

  const bad = run(dir)
  const text = `${bad.stdout}\n${bad.stderr ?? ''}`
  ok('bad repo exits 1', bad.status === 1, `status=${bad.status}`)
  for (const kind of ['bom', 'crlf', 'dup-cjk', 'spelling', 'version']) {
    ok(`reports ${kind}`, text.includes(`[${kind}]`), text.slice(0, 400))
  }
  ok('reports UTF-16 BOM', text.includes('UTF-16 BOM'), text.slice(0, 400))

  for (const f of ['bad-bom.txt', 'bad-utf16.txt', 'bad-crlf.txt', 'bad-dup.md', 'bad-spell.md']) {
    fs.rmSync(path.join(dir, f), { force: true })
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))

  const fixed = run(dir)
  ok('fixed repo exits 0', fixed.status === 0, JSON.stringify(fixed))
} finally {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

const failed = checks.filter((c) => !c.pass)
if (failed.length) {
  console.error(`\ncheck-text-smoke FAILED: ${failed.length}/${checks.length}`)
  process.exitCode = 1
} else {
  console.log(`PASS check-text-smoke (${checks.length} checks)`)
}
