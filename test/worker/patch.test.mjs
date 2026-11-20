// 组合包补丁的结构断言（v2.6.14）。
//
// 为什么需要它：cordis 的防护是「没在行上声明 inject 就不能访问该服务」，
// 而 agent 派工要读 ctx.agentLoop / ctx.sessions（lib/worker/agent-runner.js 的
// createDshAgentHost）。v2.6.13 及以前 inject 只有 ['webServer','tools']，
// 结果副机即使把 agentEnabled / agentPreset / agentCwdRoot / agentAllowlist 全配齐，
// 任务仍以 reason=agent-unavailable 被拦，note 是「agentLoop.createAgent 不可用」——
// 看起来像配置问题，其实是补丁少声明了两个服务。这类漏声明的代价是「另一端排查半天」，
// 所以在这里把它钉成断言：改动 inject 必须显式过这条测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const patchPath = path.join(root, 'cordis.patch.yml');
const raw = fs.readFileSync(patchPath, 'utf8');

function injectList() {
  const m = raw.match(/inject:\s*\[([^\]]*)\]/);
  assert.ok(m, 'cordis.patch.yml 里找不到 inject: [...]');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

test('patch：inject 覆盖 agent 派工所需的服务', () => {
  const list = injectList();
  for (const svc of ['webServer', 'tools', 'agentLoop', 'sessions']) {
    assert.ok(list.includes(svc), `inject 缺少 ${svc}（agent 派工会以 agent-unavailable 被拦）`);
  }
});

test('patch：插入行指向本包且带 id', () => {
  assert.match(raw, /- insert:/, ' 必须用 insert 插入（只写 profile patch 不会插入）');
  assert.match(raw, /id:\s*team/, ' 插入行的 id 应为 team（profile 按此 id 覆盖 config）');
  assert.match(raw, /name:\s*['"]?@wfcj\/dsh-job-board['"]?/, ' 插入行的 name 应为本包名');
});

test('patch：默认是「只看板、不执行」的安全组合', () => {
  // 默认值决定「刚装好、还没配置」的机器行为：不能自己认领任务、不能跑 agent。
  assert.match(raw, /workerMode:\s*['"]?off['"]?/, ' 默认 workerMode 应为 off');
  assert.match(raw, /agentEnabled:\s*false/, ' 默认 agentEnabled 应为 false');
  assert.match(raw, /approvalMode:\s*['"]?manual['"]?/, ' 默认 approvalMode 应为 manual');
});
// v2.6.28（U-1）：包内 worker: 子块必须含 maintenanceEnabled / maintenanceOutDir。
// README 把这两键写成可用键，包内模板缺任一个 ⇒ 用户照包内写会丢键（维护通道行为漂移）。
test('patch：worker 子块含 maintenanceEnabled / maintenanceOutDir', () => {
  assert.ok(/^\s*maintenanceEnabled:\s*true$/m.test(raw), 'worker 子块应有 maintenanceEnabled: true');
  assert.ok(/^\s*maintenanceOutDir:\s*''$/m.test(raw), "worker 子块应有 maintenanceOutDir: ''");
});
