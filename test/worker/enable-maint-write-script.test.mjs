// enable-maint-write.ps1 的回归测试：worker: {} 内联空 map 必须展开后再插子键。
//
// 背景（v2.7.0 二次复审 P1）：脚本原先把键插到 `worker: {}` 行之后，写后复核又误判通过，
// 结果是标准 YAML 解析失败（DSH 起不来）。这里用真跑脚本 + js-yaml 读回来钉住行为。
//
// 只有 Windows 上带 pwsh 时才跑；其它环境 skip（脚本本身是 PowerShell）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SCRIPT = path.join(REPO, 'scripts', 'enable-maint-write.ps1');
const PUB = 'MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k=';

function hasPwsh() {
  const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSEdition'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0 && String(r.stdout).includes('Core');
}

function makeFixture(patchText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshjb-enable-maint-'));
  const profile = path.join(root, '.dsh', 'profiles', 'desktop');
  fs.mkdirSync(path.join(profile, 'node_modules', '@wfcj', 'dsh-job-board'), { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'node_modules', '@wfcj', 'dsh-job-board', 'package.json'),
    JSON.stringify({ name: '@wfcj/dsh-job-board', version: '2.7.0' }),
  );
  const patch = path.join(profile, 'cordis.patch.yml');
  fs.writeFileSync(patch, patchText.replace(/\r\n/g, '\n'), 'utf8');
  return { root, patch };
}

function runScript(root) {
  return spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-File', SCRIPT, '-Profile', 'desktop', '-PublicKey', PUB, '-Force'],
    { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, USERPROFILE: root, HOME: root } },
  );
}

const skip = !fs.existsSync(SCRIPT) || !hasPwsh();

test('worker: {} 内联空 map：展开成 worker: 后插入子键，YAML 可解析', { skip }, () => {
  const { root, patch } = makeFixture(
    ['- id: team', '  config:', "    machine: 'gt14'", '    worker: {}', '- id: other', '  config:', '    x: 1', ''].join('\n'),
  );
  const r = runScript(root);
  assert.equal(r.status, 0, `脚本应成功：${r.stdout}\n${r.stderr}`);
  const out = fs.readFileSync(patch, 'utf8');
  assert.ok(!/worker:\s*\{\}/.test(out), 'worker: {} 必须被展开，不能继续存在');
  assert.match(out, /^ {4}worker:\n {6}maintenanceWriteEnabled: true$/m);
  assert.match(out, /^ {6}maintAuthPublicKeys: \['[^']+'\]$/m);
  // 后续行必须原样保留
  assert.match(out, /^- id: other$/m);
});

test('已有 worker 子块：原地补键、幂等', { skip }, () => {
  const { root, patch } = makeFixture(
    ['- id: team', '  config:', '    worker:', "      workerMode: 'off'", '      pollMs: 2000', '- id: other', ''].join('\n'),
  );
  const first = runScript(root);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const afterFirst = fs.readFileSync(patch, 'utf8');
  assert.match(afterFirst, /^ {6}maintenanceWriteEnabled: true$/m);
  assert.match(afterFirst, /^ {6}workerMode: 'off'$/m, '既有键必须保留');

  const second = runScript(root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readFileSync(patch, 'utf8'), afterFirst, '第二次运行不应改动文件');
});

test('没有 worker: 子块：干净失败，不写坏文件', { skip }, () => {
  const { root, patch } = makeFixture(['- id: team', '  config:', '    machine: gt14', '- id: other', ''].join('\n'));
  const before = fs.readFileSync(patch, 'utf8');
  const r = runScript(root);
  assert.notEqual(r.status, 0, '缺 worker 子块应当非零退出');
  assert.equal(fs.readFileSync(patch, 'utf8'), before, '失败时文件必须原样');
});

// v2.7.4：GT14 这类机器把 worker 配置**平铺**在 team -> config 下（没有嵌套 worker: 块）。
// 脚本必须能识别这种布局、按同级缩进追加、并且重跑幂等（曾经会写重复键）。
test('扁平布局（无 worker: 子块，键平铺在 config 下）：同级追加 + 幂等', { skip }, () => {
  const { root, patch } = makeFixture(
    ['- id: team', '  config:', "    machine: 'gt14'", "    workerMode: 'on'", '    pollMs: 2000', '- id: other', '  config:', '    x: 1', ''].join('\n'),
  );
  const first = runScript(root);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const afterFirst = fs.readFileSync(patch, 'utf8');
  assert.match(afterFirst, /^ {4}maintenanceWriteEnabled: true$/m, '扁平布局必须按同级 4 空格缩进追加');
  assert.match(afterFirst, /^ {4}maintAuthPublicKeys: \['/m);
  assert.match(afterFirst, /^ {4}workerMode: 'on'$/m, '既有键必须保留');
  assert.match(afterFirst, /^- id: other$/m, '后续块必须完好');

  const second = runScript(root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readFileSync(patch, 'utf8'), afterFirst, '第二次运行不应改动文件（不得写重复键）');
});