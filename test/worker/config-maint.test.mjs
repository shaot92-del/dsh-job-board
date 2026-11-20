import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, detectMachine } from '../../lib/worker/config.js';

// v2.6.26 回归：写通道四个键必须能从 worker 子块读出。
// 2.6.20–2.6.25 归一化层漏了这些键，导致真机上永远 maint-write-disabled（本地单测直接构造
// config 对象，所以一直没暴露）。
test('normalizeConfig: 维护写通道的键从 worker 子块读出', () => {
  const { config } = normalizeConfig({
    machine: 'gt14',
    worker: {
      maintenanceWriteEnabled: true,
      maintenanceAllowRestart: true,
      maintenancePkgDir: 'C:/Users/x/.dsh/maint-pkgs',
      maintAuthPublicKeys: ['MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k='],
      dshExePath: 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe',
    },
  });
  assert.equal(config.maintenanceWriteEnabled, true);
  assert.equal(config.maintenanceAllowRestart, true);
  assert.equal(config.maintenancePkgDir, 'C:/Users/x/.dsh/maint-pkgs');
  assert.equal(config.maintAuthPublicKeys.length, 1);
  assert.match(config.maintAuthPublicKeys[0], /^MCowBQYDK2Vw/);
  assert.equal(config.dshExePath, 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe');
});

test('normalizeConfig: 维护写通道默认关闭（缺省即 fail closed）', () => {
  const { config } = normalizeConfig({ machine: 'gt14' });
  assert.equal(config.maintenanceWriteEnabled, false);
  assert.equal(config.maintenanceAllowRestart, false);
  assert.deepEqual(config.maintAuthPublicKeys, []);
});

test('normalizeConfig: 公钥也接受扁平单字符串，脏值被丢弃', () => {
  const one = normalizeConfig({ machine: 'gt14', maintAuthPublicKeys: ' MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k= ' }).config;
  assert.equal(one.maintAuthPublicKeys.length, 1);
  const bad = normalizeConfig({ machine: 'gt14', maintAuthPublicKeys: ['不是base64!!', 'ok+base64='] }).config;
  assert.deepEqual(bad.maintAuthPublicKeys, ['ok+base64=']);
});
// v2.6.28（复核 C-12）：maintAuthKeyFile **不是死键**——lib/index.js 的 ensureMaintKeyPair()
// 读 cfg.maintAuthKeyFile 决定密钥落盘位置；删掉会让配置覆盖静默失效。这里钉住该键存在。
test('normalizeConfig: maintAuthKeyFile 保留（ensureMaintKeyPair 依赖它）', () => {
  const { config } = normalizeConfig({ machine: 'gt14', maintAuthKeyFile: 'C:\\path\\to\\key.json' });
  assert.equal(config.maintAuthKeyFile, 'C:\\path\\to\\key.json', 'maintAuthKeyFile 必须保留');
});

// v2.6.28（安全审计 C-13）：passEnv 未进 normalizeConfig，buildChildEnv 恒收 []。
// 补归一化——passEnv 应从 worker 子块或扁平键读出。
test('normalizeConfig: passEnv 从 worker 子块读出', () => {
  const { config } = normalizeConfig({
    machine: 'gt14',
    worker: { passEnv: ['HTTP_PROXY', 'MY_VAR'] },
  });
  assert.deepEqual(config.passEnv, ['HTTP_PROXY', 'MY_VAR']);
});

test('normalizeConfig: passEnv 从扁平键读出', () => {
  const { config } = normalizeConfig({
    machine: 'gt14',
    passEnv: ['CUSTOM_TOKEN', 'ANOTHER_VAR'],
  });
  assert.deepEqual(config.passEnv, ['CUSTOM_TOKEN', 'ANOTHER_VAR']);
});

test('normalizeConfig: passEnv 缺省为空数组', () => {
  const { config } = normalizeConfig({ machine: 'gt14' });
  assert.deepEqual(config.passEnv, []);
});
// v2.6.28（U-2）：detectMachine 前缀表太窄——只认 GT14/MB14/PC2/DESKTOP-，其它主机名
// 原样返回 ⇒ 副机 machine 与板上不一致（板上按小写归一），永远 idle。
// 补 DESKTOP2 前缀 + 不在表里时统一小写。
test('detectMachine：DESKTOP- 前缀命中 host', () => {
  assert.equal(detectMachine({ hostname: 'DESKTOP-ABC' }), 'host');
});

test('detectMachine：DESKTOP2 前缀命中 host', () => {
  assert.equal(detectMachine({ hostname: 'DESKTOP2-X' }), 'host');
});

test('detectMachine：不在前缀表的主机名原样小写', () => {
  assert.equal(detectMachine({ hostname: 'SOMEPC' }), 'somepc');
  assert.equal(detectMachine({ hostname: 'MyCustomHost' }), 'mycustomhost');
});

test('detectMachine：DSH_BOARD_MACHINE env 强制覆盖', () => {
  assert.equal(
    detectMachine({ hostname: 'DESKTOP-ABC', env: { DSH_BOARD_MACHINE: 'gt14' } }),
    'gt14',
  );
});