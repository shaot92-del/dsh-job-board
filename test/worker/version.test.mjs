// 版本一致性：worker_status 报的是 lib/worker/index.js 的 VERSION，
// 而发版核对照的是包根 package.json —— 两处不一致会让人以为跑的是旧版。
// v2.6.0 并入后 worker 不再有独立 package.json，统一对齐 job-board 的版本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../../lib/worker/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('version：VERSION 与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('version：worker 模块文件齐全', () => {
  const expected = [
    'agent-approval.js',
    'agent-budget.js',
    'agent-gate.js',
    'agent-runner.js',
    'board-client.js',
    'config.js',
    'exec-runner.js',
    'executor.js',
    'index.js',
    'log.js',
    'result.js',
    'task-spec.js',
    'version.js',
    'worker.js',
  ];
  for (const name of expected) {
    const p = path.join(root, 'lib', 'worker', name);
    assert.ok(fs.existsSync(p), `缺少 lib/worker/${name}`);
  }
});
