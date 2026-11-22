#!/usr/bin/env node
// 发版审查证据采集器 —— 一次命令产出 docs/audit-<version>/ 下的证据骨架。
// 依据：docs/release-review-procedure.md §2（反证清单）/§6（负向门禁）/§8（模板）。
// 只采集证据，不判定 PASS/FAIL：路径是否 EXECUTED 必须由审查者按日志与 diff 逐条填。
//
// 用法：
//   node scripts/audit-collect.mjs --version 2.7.1 --base v2.7.0
//   node scripts/audit-collect.mjs --version 2.7.1 --base v2.7.0 --coverage   # 额外产出 V8 coverage
//   node scripts/audit-collect.mjs --version 2.7.1 --base v2.7.0 --crash-bundle <path>
//
// 退出码：0 = 采集完成且门禁命令全绿；1 = 有命令失败（证据仍然写入，供审查使用）。

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const out = { version: '', base: 'HEAD~1', coverage: false, crashBundle: '', quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') out.version = argv[++i] || ''
    else if (a === '--base') out.base = argv[++i] || ''
    else if (a === '--coverage') out.coverage = true
    else if (a === '--crash-bundle') out.crashBundle = argv[++i] || ''
    else if (a === '--quiet') out.quiet = true
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/audit-collect.mjs --version <ver> [--base <ref>] [--coverage] [--crash-bundle <path>]')
      process.exit(0)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.version) {
  console.error('缺少 --version（例：--version 2.7.1）')
  process.exit(2)
}

const AUDIT = join(ROOT, 'docs', `audit-${args.version}`)
const dirs = ['scope', 'coverage/raw', 'counterproof', 'commands', 'negative']
for (const d of dirs) mkdirSync(join(AUDIT, d), { recursive: true })

function unitTestFiles() {
  const dir = join(ROOT, 'test', 'worker')
  return readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('test', 'worker', f))
}
const log = (...m) => { if (!args.quiet) console.log(...m) }
const results = []

function gitGit(cmdArgs) {
  try {
    return execFileSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (e) {
    return ''
  }
}

function write(rel, text) {
  const p = join(AUDIT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf8')
  return p
}

function run(name, command, cmdArgs, opts = {}) {
  const started = Date.now()
  const r = spawnSync(command, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  })
  const dur = Date.now() - started
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const exit = typeof r.status === 'number' ? r.status : 1
  const logRel = join('coverage', `${name}.log`)
  write(logRel, out)
  const rec = {
    name,
    command: [command, ...cmdArgs].join(' '),
    exitCode: exit,
    expectedFail: opts.expectFail === true,
    durationMs: dur,
    log: logRel,
  }
  results.push(rec)
  const ok = opts.expectFail === true ? exit !== 0 : exit === 0
  log(`[${ok ? 'ok' : 'FAIL'}] ${name} exit=${exit} ${dur}ms`)
  return rec
}

// ---- 1. 范围底账 -----------------------------------------------------------
const baseRef = args.base || 'HEAD~1'
// 注解标签(annotated tag)的 rev-parse 返回 tag 对象 SHA，直接拿去 diff 会得到空变更集。
// 统一解到 commit：v2.7.5^{commit} → db94810。
const baseSha = gitGit(['rev-parse', '--verify', `${baseRef}^{commit}`]) || gitGit(['rev-parse', baseRef])
const headSha = gitGit(['rev-parse', 'HEAD'])
if (!headSha) {
  console.error('无法读取 HEAD（是否在 git 仓库内？）')
  process.exit(2)
}
write('scope/base-head.txt', `base=${baseRef}\nbase_sha=${baseSha}\nhead=${headSha}\nversion=${args.version}\ncollected_at=${new Date().toISOString()}\n`)
const changed = gitGit(['diff', '--name-only', `${baseRef}...HEAD`, '--', 'lib', 'scripts', 'test'])
write('scope/changed-files.txt', changed ? `${changed}\n` : '')
const diff0 = gitGit(['diff', '--unified=0', `${baseRef}...HEAD`, '--', 'lib', 'scripts', 'test'])
write('scope/changed-paths.diff', diff0 ? `${diff0}\n` : '')
log(`范围：${baseRef}(${baseSha.slice(0, 8)}) .. ${headSha.slice(0, 8)}，变更文件 ${changed ? changed.split('\n').length : 0} 个`)

// ---- 2. 门禁命令（逐条留痕） ----------------------------------------------
run('check-text', process.execPath, ['scripts/check-text.mjs'])
run('plugcheck', process.execPath, ['scripts/plugcheck.mjs'])
run('smoke-client', process.execPath, ['scripts/client-render-smoke.mjs'])
run('unit-test', process.execPath, ['--test', ...unitTestFiles()])
run('pack-check', process.execPath, ['scripts/worker/pack-check.mjs'])

// ---- 3. 可选：V8 coverage --------------------------------------------------
if (args.coverage) {
  run('coverage-node-test', process.execPath, ['--test', '--experimental-test-coverage', 'test/worker/*.test.mjs'], {
    env: { NODE_V8_COVERAGE: join(AUDIT, 'coverage', 'raw') },
  })
}

// ---- 4. 负向门禁：崩溃版必须 FAIL -----------------------------------------
if (args.crashBundle) {
  const crash = resolve(ROOT, args.crashBundle)
  if (!existsSync(crash)) {
    write('negative/README.md', `崩溃版 bundle 不存在：${crash}\n本节判 BLOCKED。\n`)
    log(`[warn] 找不到崩溃版 bundle：${crash}`)
  } else {
    const rec = run('smoke-client-crash-bundle', process.execPath, ['scripts/client-render-smoke.mjs'], {
      env: { SMOKE_BUNDLE: crash },
      expectFail: true,
    })
    const expectFail = rec.exitCode !== 0
    write('negative/README.md', [
      '# 负向门禁（旧版必须 FAIL）',
      '',
      `- bundle: \`${crash}\``,
      `- 命令: \`$env:SMOKE_BUNDLE='${crash}'; node scripts/client-render-smoke.mjs\``,
      `- 实际 exitCode: ${rec.exitCode}（期望非 0）`,
      `- 判定: ${expectFail ? 'PASS（旧版确实失败）' : 'FAIL（旧版竟然通过 ⇒ 门禁抓不住该缺陷）'}`,
      `- 日志: \`${rec.log}\``,
      '',
    ].join('\n'))
    log(`[negative] 崩溃版 exit=${rec.exitCode} → ${expectFail ? '符合预期' : '不符合预期'}`)
  }
}

// ---- 5. 命令清单与结果 -----------------------------------------------------
const cmds = { version: args.version, base: baseRef, baseSha, headSha, collectedAt: new Date().toISOString(), commands: results }
write('commands/commands.json', `${JSON.stringify(cmds, null, 2)}\n`)
write('commands/results.jsonl', `${results.map((r) => JSON.stringify(r)).join('\n')}\n`)

// ---- 6. 反证清单骨架（待人工填 EXECUTED/UNEXECUTED） -----------------------
const changedList = changed ? changed.split('\n').filter(Boolean) : []
write('counterproof/paths.json', `${JSON.stringify({
  version: args.version,
  base: baseRef,
  note: '由 audit-collect 生成的骨架：必须按 changed-paths.diff + coverage 逐条填 status，未填不得判 PASS。',
  files: changedList.map((f) => ({ file: f, paths: [{ id: '', description: '', status: 'UNKNOWN', evidence: '' }] })),
}, null, 2)}\n`)
write('counterproof/summary.json', `${JSON.stringify({
  version: args.version,
  executed: 0, unexecuted: 0, unknown: changedList.length, notApplicable: 0,
  unexecutedIds: [], verdict: 'BLOCKED',
  reason: '骨架：请填完 paths.json 后重新计算（unknown>0 或证据缺失一律 BLOCKED）',
}, null, 2)}\n`)

const failed = results.filter((r) => (r.expectedFail ? r.exitCode === 0 : r.exitCode !== 0))
log('')
log(`证据目录：${AUDIT}`)
log(`命令：${results.length} 条，失败 ${failed.length} 条`)
if (failed.length) log(`失败：${failed.map((f) => f.name).join(', ')}`)
process.exit(failed.length ? 1 : 0)
