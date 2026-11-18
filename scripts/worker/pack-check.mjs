#!/usr/bin/env node
// 发布门的一部分：跑 `npm pack --dry-run --json`，断言包名 / 版本 / 文件数与关键文件齐全。
// v2.6.0：worker 并入后按单包布局检查；scripts/ 允许进包（用户要能复现 smoke）。
// 用法：node scripts/worker/pack-check.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

let raw = '';
try {
  raw = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error(`pack-check: npm pack 失败：${(err && err.message) || err}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`pack-check: pack --json 输出不是 JSON：${(err && err.message) || err}`);
  process.exit(1);
}

const info = Array.isArray(parsed) ? parsed[0] : parsed;
if (!info) {
  console.error('pack-check: pack --json 返回空');
  process.exit(1);
}

const problems = [];
if (info.name !== pkg.name) problems.push(`name=${info.name} != ${pkg.name}`);
if (info.version !== pkg.version) problems.push(`version=${info.version} != ${pkg.version}`);

const files = (info.files || []).map((f) => f.path);
const required = [
  'lib/index.js',
  'lib/worker/index.js',
  'lib/worker/version.js',
  'lib/worker/agent-gate.js',
  'lib/worker/agent-approval.js',
  'lib/worker/agent-budget.js',
  'lib/worker/agent-runner.js',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.worker',
  'docs/review-response.md',
  'scripts/worker/selftest.mjs',
  'scripts/worker/fake-board.mjs',
  'scripts/worker-merge-smoke.mjs',
  'scripts/client-render-smoke.mjs',
  'test/worker/version.test.mjs',
  'test/worker/patch.test.mjs',
  'test/worker/agent-budget.test.mjs',
];
for (const r of required) {
  if (!files.includes(r)) problems.push(`缺文件：${r}`);
}

// 绝不允许进包的路径（state/日志/token/临时产物）。
const forbidden = files.filter((p) =>
  /(^|\/)(_runtime\.log|state\.json|secrets?\.(json|txt)|tokens?\.(json|txt)|\.env)/i.test(p) ||
  /\.(tgz|tmp)$/i.test(p),
);
if (forbidden.length) problems.push(`不应进包：${forbidden.join(', ')}`);

if (problems.length) {
  console.error(`pack-check: FAIL — ${problems.join('；')}`);
  process.exit(1);
}

console.log(
  `pack-check: PASS — ${info.name}@${info.version}，${files.length} 文件 / ${info.size} B（unpacked ${info.unpackedSize} B）`,
);
